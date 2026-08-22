// Consensus v2 node runtime (spec §7.2): verifies incoming ConsensusMsg (sync, via
// the consensus PK registry), drives the pure ConsensusDriver, and executes its
// Effects (async sign / broadcast / persist / finalize). Gated by QNET_CONSENSUS_V2;
// when off, the old macroblock path runs unchanged.

use crate::consensus_v2_driver::{ConsensusDriver, ConsensusMsg, Effect, timeout_bytes};
use crate::unified_p2p::{NetworkMessage, SimplifiedP2P};
use crate::storage::Storage;
use qnet_consensus::checkpoint_bft::{Hash, QuorumCertificate, TimeoutMsg, Vote};
use once_cell::sync::OnceCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::mpsc;

/// Checkpoint-BFT (v2) is the ONLY macroblock consensus since the legacy commit/reveal
/// path was removed (plan step E). Always on; kept as a predicate for the few v2-specific
/// call sites (e.g. the RPC FullyFinalized confirmation level) that still branch on it.
pub fn v2_enabled() -> bool {
    true
}

// Checkpoint-content verification (state_root, mb_hashes, beacon, epoch_commitment) is
// ALWAYS enforced (fail-stop): a node never signs or finalizes a checkpoint whose content it
// does not independently reproduce. With consensus state fully integer (no f64), divergence is
// a bug to halt on, not to absorb. No env flag.

/// Highest microblock height made irreversible by a 2-chain checkpoint QC.
/// Single source of truth = the canonical finality marker (node::LAST_FINALIZED_HEIGHT),
/// advanced by the v2 Finalize effect; drives the FullyFinalized confirmation level.
pub fn bft2_finalized_height() -> u64 {
    crate::node::LAST_FINALIZED_HEIGHT.load(Ordering::Acquire)
}

/// Domain-separated string a consensus payload signs over.
fn sign_str(domain: &str, body: &[u8]) -> String {
    format!("QNET_BFT2_{}:{}", domain, hex::encode(body))
}

/// Bounded concurrency for the OFF-LOOP checkpoint-cert (Qc/Tc) verify. The O(committee) ML-DSA verify
/// must NOT run on the consensus select-loop task — that task also drives the view-change timer branch, so
/// a 1000-committee verify inline there starves timeouts + all other events (finality stall at scale). We
/// dispatch it to a blocking worker; this semaphore caps concurrent verifies, so a peer replaying/crafting
/// certs (a Qc/Tc has no single sender ⇒ in_committee cannot gate it) can force at most this many at once —
/// bounded CPU, the loop untouched. 2 concurrent is generous vs the legit rate (~1 cert per checkpoint, ≪1/s).
static CERT_VERIFY_SEM: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// OFF-LOOP verify of a checkpoint cert (Qc/Tc). Stale (below our monotonic frontier) ⇒ drop; else take a
/// concurrency permit (over-limit ⇒ drop, re-gossiped) and verify on a blocking worker. On success, re-inject
/// V2Event::CertVerified(bytes) — the INTERNAL trusted variant — so the loop applies it WITHOUT the expensive
/// re-verify. The committee is captured at dispatch (deterministic per window index), so the verify is correct
/// even if the driver advances before the result returns; a then-stale cert is a monotonic no-op in the driver.
fn dispatch_cert_verify(data: Vec<u8>, p2p: &Arc<SimplifiedP2P>, committee: &[String], current: u64) {
    let msg = match bincode::deserialize::<ConsensusMsg>(&data) { Ok(m) => m, Err(_) => return };
    if msg_index(&msg) < current { return; }            // stale ⇒ can't advance a monotonic driver
    if committee.is_empty() { return; }                 // no committee to verify against yet
    // Shedding here is the DoS bound and stays, but a dropped certificate is the one object that
    // unwedges a stuck driver, and re-gossip is its only retry. Count the sheds so a node that is
    // dropping them is visible rather than merely silent.
    let permit = match CERT_VERIFY_SEM.try_acquire() {
        Ok(p) => p,
        Err(_) => { CERT_SHED.fetch_add(1, Ordering::Relaxed); return; }
    };
    let p2p = p2p.clone();
    let committee = committee.to_vec();
    tokio::task::spawn_blocking(move || {
        let _permit = permit; // held for the verify's duration
        if verify_msg(&p2p, &committee, &msg) {
            if let Some(tx) = V2_TX.get() { let _ = tx.send(V2Event::CertVerified(data)); }
        }
    });
}

/// Shared post-authentication processing for a message whose signature already passed — verify_msg (a cheap
/// single-sig Proposal/Vote/Timeout, inline) OR an OFF-LOOP cert verify (Qc/Tc, re-injected as CertVerified).
/// Runs the accountable-safety observers + the independent content re-derivation gate (check_content) + the
/// driver transition, then proposes/drains. NEVER re-verifies (driver.handle trusts the passed signature).
fn process_authenticated(
    msg: &ConsensusMsg,
    driver: &mut ConsensusDriver,
    storage: &Arc<Storage>,
    window_buf: &std::collections::HashMap<u64, WindowContent>,
    p2p: &Arc<SimplifiedP2P>,
    committee: &mut Vec<String>,
    pending: &mut Vec<Vec<u8>>,
    max_pending: usize,
    heard: &mut std::collections::HashMap<String, std::time::Instant>,
) -> Vec<Effect> {
    // ACCOUNTABLE SAFETY (pure side effect): cache authentic checkpoints + detect a committee member
    // signing two DIFFERENT checkpoints at the SAME round → sound on-chain vote-equivocation evidence.
    observe_accountability(msg);
    // Independent content re-derivation before we sign — single source of truth (check_content),
    // shared with drain_pending so buffered replay applies the same gate.
    match check_content(storage, window_buf, msg) {
        ContentCheck::Ok => {
            let mut effs = driver.handle(msg);
            effs.extend(try_propose(driver, window_buf, storage, committee));
            effs.extend(drain_pending(driver, window_buf, storage, p2p, committee, pending, max_pending, heard));
            effs
        }
        ContentCheck::TailDiverged(heights) => {
            // PROPOSE-AND-ADOPT (boundary tail-fork root fix; spec = the driver wedge harness): state
            // agreed EXACTLY, only failover-round-bound tail hashes differ. Pull each 2f+1-certified-
            // canonical block so fork-choice supersedes our losing variant, AND buffer the proposal —
            // drain_pending re-runs the full gate once the canonical bodies land, so our vote flows
            // WITHOUT depending on a proposal re-gossip that never comes. (The SelfDerive wedge: with
            // ≤ n-f-1 byte-identical tail holders the dropped proposal ⇒ <2f+1 votes ⇒ QC never forms.)
            // NEVER vote blind: adoption completes only at the re-gate, where hashes + beacon are
            // reproduced from REAL stored bodies — a Byzantine leader cannot get phantom tail hashes or
            // a forged beacon 2f+1-signed, and a fork-choice-losing tail is never adopted (its blocks
            // never supersede ours ⇒ the buffered proposal never re-gates Ok ⇒ TC rotates the leader).
            if crate::node::is_info() {
                println!("[INFO][BFT2] tail_reconcile idx={} diverged_heights={}", msg_index(msg), heights.len());
            }
            if let ConsensusMsg::Proposal(cp) = msg {
                evict_superseded_proposal(pending, cp.index, &cp.proposer);
            }
            if let Ok(bytes) = bincode::serialize(msg) { buffer_pending(pending, max_pending, bytes, true); }
            for h in heights {
                let p = p2p.clone();
                tokio::spawn(async move { let _ = p.request_block_repair_priority(h).await; });
            }
            Vec::new()
        }
        ContentCheck::Defer => {
            // Not caught up to this checkpoint's window yet — buffer for replay (drain_pending re-runs the
            // gate once our window is derived) instead of permanently rejecting. Bounded ⇒ no unbounded growth.
            if let ConsensusMsg::Proposal(cp) = msg {
                evict_superseded_proposal(pending, cp.index, &cp.proposer);
            }
            if let Ok(bytes) = bincode::serialize(msg) { buffer_pending(pending, max_pending, bytes, true); }
            Vec::new()
        }
        ContentCheck::Reject(reason) => {
            let first = CONTENT_REJECTS.fetch_add(1, Ordering::Relaxed) == 0;
            // fail-stop: a checkpoint whose STATE/epoch content we don't independently reproduce is never
            // voted — a forged state_root cannot get our signature.
            if first && crate::node::is_warn() {
                match msg {
                    ConsensusMsg::Proposal(cp) => match window_buf.get(&(cp.window_head_height / qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL)) {
                        Some(c) => println!(
                            "[WARN][BFT2] proposal_content_rejected idx={} reason={} eq state_root={} epoch_commit={} reward_root={} registry_root={} total_supply={}",
                            msg_index(msg), reason,
                            cp.state_root == c.state_root,
                            qnet_consensus::checkpoint_bft::epoch_commitment(&c.eligible, &c.committee, &c.banned) == cp.epoch_commitment,
                            cp.reward_root == c.reward_root,
                            cp.registry_root == c.registry_root,
                            cp.total_supply == c.total_supply,
                        ),
                        None => println!(
                            "[WARN][BFT2] proposal_content_rejected idx={} reason={} window_buf_MISS win={}",
                            msg_index(msg), reason, cp.window_head_height / qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL,
                        ),
                    },
                    _ => println!("[WARN][BFT2] proposal_content_rejected idx={} reason={}", msg_index(msg), reason),
                }
            }
            Vec::new()
        }
    }
}

/// Accountable-safety observers (pure side effect): cache authentic checkpoints + votes so a
/// committee member signing two DIFFERENT checkpoints at the SAME round yields sound on-chain
/// vote-equivocation evidence. MUST run on EVERY message handed to the driver — the live path
/// (process_authenticated) AND drain_pending's buffered replay — or equivocations that only ever
/// surface via the replay buffer would produce zero evidence (audit F2).
fn observe_accountability(msg: &ConsensusMsg) {
    match msg {
        ConsensusMsg::Proposal(cp) => crate::node::observe_checkpoint_proposal(
            cp.index, cp.hash(), bincode::serialize(cp).unwrap_or_default()),
        ConsensusMsg::Vote(v) => crate::node::observe_checkpoint_vote(
            v.index, &v.voter, v.checkpoint_hash, v.signature.clone()),
        _ => {}
    }
}

/// Verify a wire message's signatures against the committee. Sync, registry-backed;
/// the node calls this BEFORE handing the message to the (trusting) driver.
pub fn verify_msg(p2p: &SimplifiedP2P, committee: &[String], msg: &ConsensusMsg) -> bool {
    // H3: committee-MEMBERSHIP gate for Vote/Timeout. A valid signature from a REGISTERED
    // validator is NOT sufficient — at scale the epoch committee is a ≤100 VRF sample of up
    // to MAX_VALIDATORS registered keys, so a non-committee key's vote must not count toward
    // quorum (else a set of non-committee validators forms a LOCAL QC that the rest of the
    // network rejects via QuorumCertificate::verify's `qc_non_member` → that node commits a
    // checkpoint nobody else accepts → local fork). Gated only when the committee is known
    // (non-empty); empty = a pre-window/bootstrap state where no quorum can form anyway. At
    // n=5 every genesis node IS the committee ⇒ no behaviour change.
    let in_committee = |id: &str| committee.is_empty() || committee.iter().any(|c| c == id);
    match msg {
        // H3 (scale): apply the SAME committee-membership gate as Vote/Timeout. A checkpoint proposer is
        // the view leader, VRF-sampled from the ≤MAX committee, so a proposal from a non-committee key must
        // not reach the (trusting) driver + check_content — otherwise any of tens-of-thousands of registered
        // super-nodes could force the O(win) tail recompute + repair fan-out (a DoS at scale). The proposer
        // is cp.proposer (the creator, not the relay), so honest relayed proposals still pass; at n=5 every
        // genesis node IS the committee ⇒ no behaviour change. Empty committee (bootstrap) ⇒ ungated.
        ConsensusMsg::Proposal(cp) => in_committee(&cp.proposer)
            && sig_ok(p2p, &cp.proposer, &sign_str("CKPT", &cp.hash()), &cp.proposer_sig),
        // C-2: a vote is folded into the QC and later re-checked by the compact QC verifier against the
        // signer's on-chain vrf_pk. Gate it here with the IDENTICAL check (strip → verify_compact vs
        // vrf_pk) so any admitted vote is guaranteed compact-verifiable network-wide — NOT the RAM-registry
        // sig_ok, whose TOFV/idle-eviction lets an off-chain-key vote pass ingest yet fail the QC verifier
        // ⇒ an unverifiable leaf locks the QC ⇒ finality stall.
        ConsensusMsg::Vote(v) => in_committee(&v.voter)
            && vote_sig_compact_ok(&v.voter, &v.checkpoint_hash, &v.signature),
        ConsensusMsg::Timeout(tm) => in_committee(&tm.voter)
            && timeout_sig_ingest_ok(&tm.voter, tm.index, tm.high_qc_index, &tm.signature),
        ConsensusMsg::Qc(qc) => verify_qc(p2p, committee, qc),
        // H4: a TC must carry ≥2f+1 DISTINCT committee timeouts (each signed) for its own
        // view — not merely an optional high_qc. The old `unwrap_or(true)` accepted an
        // EMPTY-timeouts TC and let on_timeout_cert advance the view (`current_index = tc.index+1`),
        // which adopt_qc never rewinds ⇒ an unauthenticated, permanent view-desync DoS.
        // The TC threshold is NEVER relaxed: a TC advances current_index without certifying a window,
        // which would break the index<->window lockstep the recovery pin depends on. During a halt it
        // therefore simply cannot form — that IS the lockstep, and leader failure inside a span is
        // handled by membership-proposing instead.
        ConsensusMsg::Tc(tc) => tc.verify(
            committee,
            qnet_consensus::checkpoint_bft::quorum_size(committee.len()),
            |t| timeout_sig_compact_ok(&t.voter, t.index, t.high_qc_index, &t.signature),
            |qc| verify_qc(p2p, committee, qc),
        ).is_ok(),
    }
}

fn sig_ok(p2p: &SimplifiedP2P, signer: &str, msg: &str, sig: &[u8]) -> bool {
    match std::str::from_utf8(sig) {
        Ok(s) => p2p.verify_consensus_signature(signer, msg, s),
        Err(_) => false,
    }
}

/// C-2: verify a VOTE signature EXACTLY as the compact QC verifier will — strip the embedded pk and open
/// against the signer's ON-CHAIN vrf_pk (load_vrf_public_key, else the binary-pinned genesis anchor; NEVER
/// the RAM registry). The registry is TOFV-capable + idle-evicted, so gating a vote with the registry
/// (sig_ok) would let a signer pass ingest under an OFF-CHAIN key yet fail the vrf_pk QC verifier at scale —
/// an unverifiable leaf locks the QC ⇒ finality stall. Same key + math as verify_qc/verify_v2_macroblock ⇒
/// any gated vote is guaranteed compact-verifiable network-wide. Sync + deterministic; pk/storage absent ⇒
/// reject. Honest votes carry embedded==vrf_pk ⇒ pass (no liveness cost).
fn vote_sig_compact_ok(voter: &str, checkpoint_hash: &[u8], sig: &[u8]) -> bool {
    let storage = match crate::node::try_get_storage() { Some(s) => s, None => return false };
    let pk = match storage.load_vrf_public_key(voter) {
        Ok(Some(p)) => p,
        _ => match crate::genesis_constants::get_genesis_anchor_pk(voter) { Some(p) => p, None => return false },
    };
    let sig_str = match std::str::from_utf8(sig) { Ok(s) => s, Err(_) => return false };
    let compact = match qnet_consensus::consensus_crypto::strip_embedded_pk(sig_str) { Some(c) => c, None => return false };
    qnet_consensus::consensus_crypto::verify_consensus_signature_compact(
        voter, &sign_str("VOTE", checkpoint_hash), &compact, &pk)
}

/// Signer's consensus pk from COMMITTED state — the on-chain vrf_pk row, else the binary-pinned genesis
/// anchor. Never the RAM registry: it is TOFV-capable and idle-evicted, so gating ingest on it would
/// admit messages the certificate verifier can never reproduce.
fn committed_pk(id: &str) -> Option<Vec<u8>> {
    let storage = crate::node::try_get_storage()?;
    // The vrf_pk_ row is not covered by registry_root, so bind it to the row that IS —
    // node_<id>.vrf_pk_sha3 — before letting it authenticate a consensus message. Same cross-check the
    // equivocation and heartbeat paths already apply. No commitment ⇒ genesis anchor or nothing.
    if let Ok(Some(p)) = storage.load_vrf_public_key(id) {
        if let Ok(Some(tag)) = storage.node_signer_key_commitment(id) {
            use sha3::{Digest, Sha3_256};
            if hex::encode(Sha3_256::digest(&p)) == tag { return Some(p); }
        }
    }
    crate::genesis_constants::get_genesis_anchor_pk(id)
}

/// INGEST gate for a standalone timeout: the wire signature still carries the embedded pk, so strip it
/// first and verify exactly what a TC will later hold. Same rule as votes.
fn timeout_sig_ingest_ok(voter: &str, index: u64, high_qc_index: u64, sig: &[u8]) -> bool {
    let pk = match committed_pk(voter) { Some(p) => p, None => return false };
    let sig_str = match std::str::from_utf8(sig) { Ok(s) => s, Err(_) => return false };
    let compact = match qnet_consensus::consensus_crypto::strip_embedded_pk(sig_str) { Some(c) => c, None => return false };
    qnet_consensus::consensus_crypto::verify_consensus_signature_compact(
        voter, &sign_str("TMO", &timeout_bytes(index, high_qc_index)), &compact, &pk)
}

/// CERTIFICATE gate: timeouts inside a TC are already pk-stripped, so verify them as-is. Stripping
/// again would return None and reject every TC, wedging the view change.
fn timeout_sig_compact_ok(voter: &str, index: u64, high_qc_index: u64, sig: &[u8]) -> bool {
    let pk = match committed_pk(voter) { Some(p) => p, None => return false };
    let sig_str = match std::str::from_utf8(sig) { Ok(s) => s, Err(_) => return false };
    qnet_consensus::consensus_crypto::verify_consensus_signature_compact(
        voter, &sign_str("TMO", &timeout_bytes(index, high_qc_index)), sig_str, &pk)
}

/// Live-gossip QC admission. The threshold follows the PIN THE CERTIFIED CHECKPOINT CARRIES, which is
/// advisory:
/// an unarmed node simply does not adopt a relaxed QC live and instead accepts the macroblock through
/// verify_v2_macroblock, the sole authority, which re-derives the pin from the certificate's bytes.
/// So a disagreement here is liveness-only and can never fork.
fn verify_qc(_p2p: &SimplifiedP2P, committee: &[String], qc: &QuorumCertificate) -> bool {
    // C-2: qc.sigs are pk-stripped — resolve each signer's pk from on-chain committee state (deterministic
    // + process-uniform: vrf_pk row, else the binary-pinned genesis anchor; NEVER the RAM registry) and
    // verify compact. Pre-resolve a Sync map (the per-sig check runs in QuorumCertificate::verify's rayon
    // par_iter). Storage not yet initialized ⇒ reject (cannot authenticate). MUST stay byte-identical to
    // the apply-time verifier (verify_v2_macroblock) or live-gossip and stored QC verify would diverge.
    let storage = match crate::node::try_get_storage() { Some(s) => s, None => return false };
    let pk_map: std::collections::HashMap<String, Vec<u8>> = qc.signers.iter().filter_map(|id| {
        match storage.load_vrf_public_key(id) {
            Ok(Some(p)) => Some((id.clone(), p)),
            _ => crate::genesis_constants::get_genesis_anchor_pk(id).map(|p| (id.clone(), p)),
        }
    }).collect();
    qc.verify(committee, crate::node::rc_effective_quorum(qc.index, &qc.checkpoint_hash, committee.len()), |voter, body, sig| {
        let pk = match pk_map.get(voter) { Some(p) => p, None => return false };
        match std::str::from_utf8(sig) {
            Ok(s) => qnet_consensus::consensus_crypto::verify_consensus_signature_compact(
                voter, &sign_str("VOTE", body), s, pk),
            Err(_) => false,
        }
    }).is_ok()
}

/// The member a single-signature consensus message came from, or None for certificates (which carry
/// many signers and are verified off-loop). Feeds the recovery arm's liveness view.
fn msg_sender(m: &ConsensusMsg) -> Option<&str> {
    match m {
        ConsensusMsg::Proposal(cp) => Some(&cp.proposer),
        ConsensusMsg::Vote(v) => Some(&v.voter),
        ConsensusMsg::Timeout(tm) => Some(&tm.voter),
        ConsensusMsg::Qc(_) | ConsensusMsg::Tc(_) => None,
    }
}

/// Checkpoint index a wire message pertains to — used to gate handling until this
/// node has adopted that index's committee (avoids a vote-less race at the boundary).
fn msg_index(m: &ConsensusMsg) -> u64 {
    match m {
        ConsensusMsg::Proposal(cp) => cp.index,
        ConsensusMsg::Vote(v) => v.index,
        ConsensusMsg::Qc(qc) => qc.index,
        ConsensusMsg::Timeout(tm) => tm.index,
        ConsensusMsg::Tc(tc) => tc.index,
    }
}

/// Sign a payload with this node's consensus key; returns the hex sig as bytes.
async fn sign_payload(node_id: &str, domain: &str, body: &[u8]) -> Option<Vec<u8>> {
    let crypto = crate::node::try_get_quantum_crypto()?;
    match crypto.create_consensus_signature(node_id, &sign_str(domain, body)).await {
        Ok(sig) => Some(sig.signature.into_bytes()),
        Err(_) => None,
    }
}

/// Peers a certificate is relayed to. NOT every peer: every committee member builds the same
/// certificate from the votes it already received, so a relay only has to reach the few that missed
/// votes — and one copy is enough, since a duplicate is dropped by the staleness check in
/// dispatch_cert_verify before it costs an O(committee) verify.
///
/// Relaying to all peers made this O(n^2) in a multi-megabyte object: at a 1000-member committee the
/// certificate is ~3.1 MB and every member relayed it to every peer, which is 819 Mbit/s per node
/// sustained. A bounded fanout is 6.6 Mbit/s for the same coverage. At the genesis size the fanout
/// exceeds the peer count, so every peer still receives it and the behaviour is unchanged.
const RELAY_FANOUT: usize = 8;

/// Relay an already-complete certificate. Self-routed like every other consensus send: the node
/// that formed it is part of its own quorum, and the inbound path is where certificate adoption
/// updates the state the microblock rotation reads.
fn relay_certificate(p2p: &Arc<SimplifiedP2P>, msg: &ConsensusMsg) {
    if let Ok(data) = bincode::serialize(msg) {
        route_inbound(data.clone());
        p2p.gossip_to_random_peers(NetworkMessage::ConsensusV2 { data }, RELAY_FANOUT);
    }
}

async fn broadcast(p2p: &Arc<SimplifiedP2P>, msg: &ConsensusMsg) {
    if let Ok(data) = bincode::serialize(msg) {
        // Self-route: a node is part of its own quorum (counts its own vote/timeout,
        // and the proposer votes on its own proposal). Without this, quorum n−f cannot
        // be met when one peer is down (the node's own vote would never be counted).
        route_inbound(data.clone());
        let _ = p2p.broadcast_quic(&NetworkMessage::ConsensusV2 { data }).await;
    }
}

/// Failover exclusions for the next epoch (≥2 failovers in this epoch ⇒ skip).
/// Deterministic from on-chain failover history, so every node reads the same
/// set from macroblock N-2; bincode of Vec<ExcludedProducerEntry>.
fn excluded_producers(storage: &Storage, mb_index: u64) -> Option<Vec<u8>> {
    const FAILOVER_THRESHOLD: u32 = 2;
    let epoch_start = mb_index.saturating_sub(1) * 90;
    let epoch_end = mb_index * 90;
    let events = storage.get_failover_history(epoch_start, 100).ok()?;
    let mut counts: std::collections::HashMap<String, (u32, Vec<u64>)> = std::collections::HashMap::new();
    for e in events.iter().filter(|e| e.height >= epoch_start && e.height <= epoch_end) {
        let c = counts.entry(e.failed_producer.clone()).or_insert((0, Vec::new()));
        c.0 += 1; c.1.push(e.height);
    }
    let mut excluded: Vec<qnet_state::ExcludedProducerEntry> = counts.into_iter()
        .filter(|(_, (n, _))| *n >= FAILOVER_THRESHOLD)
        .map(|(node_id, (n, heights))| qnet_state::ExcludedProducerEntry {
            node_id, failover_count: n, failover_heights: heights,
            exclusion_blocks: 90, reason: format!("failover_{}_epoch_{}", n, mb_index),
        }).collect();
    // HashMap drains in arbitrary order; sort so the serialized body is byte-identical
    // on every node that seals this window (required once all committee members seal).
    excluded.sort_by(|a, b| a.node_id.cmp(&b.node_id));
    if excluded.is_empty() { None } else { bincode::serialize(&excluded).ok() }
}

/// Pure finalize predicate: a checkpoint is finalizable iff our local chain reached its head AND our
/// locally-applied state at that head matches the checkpoint's QC'd state_root. NO macroblock body
/// required — an intra-window checkpoint (head not on a /macro_interval boundary) finalizes identically,
/// which the old macroblock-coupled check could NOT do (it deferred forever → froze the finality marker
/// → wedged the chain). Fail-stop on a state mismatch (never finalize a root we didn't reproduce); a
/// head==0 placeholder (a committed index whose checkpoint we don't hold) ⇒ never.
pub(crate) fn checkpoint_finalizable(chain_h: u64, head_height: u64, local_state_root: Option<Hash>, checkpoint_state_root: Hash) -> bool {
    head_height > 0 && chain_h >= head_height && local_state_root == Some(checkpoint_state_root)
}

/// Seal-path threshold self-check. All-seal writes the macroblock LOCALLY, never through
/// `verify_v2_macroblock`, so without re-applying that authority's clauses here a node seals exactly
/// what its peers reject — a permanent partition with zero Byzantine nodes. Runs for PINNED AND
/// UNPINNED certificates alike: relaxing is the pin's business, but re-proving the threshold is every
/// certificate's. FAIL-CLOSED: a DEFER (anchor not held yet) refuses too, because not sealing costs
/// one window and sealing an unresolvable pin costs the chain.
fn rc_seal_ok(
    storage: &Storage,
    checkpoint: &qnet_consensus::checkpoint_bft::Checkpoint,
    qc: &QuorumCertificate,
    committee: &[String],
) -> Result<(), (&'static str, String)> {
    let mb = checkpoint.window_head_height / qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
    if qc.checkpoint_hash != checkpoint.hash() {
        return Err(("rc_qc_unbound", format!("mb={}", mb)));
    }
    // The pin lowers the THRESHOLD only; the signing set is the committee this window was driven
    // with, exactly as verify_v2_macroblock derives it. Signatures were verified when this QC was
    // adopted; re-opening <=1000 ML-DSA sigs on the seal path would only re-prove that, so only the
    // set, the distinctness and the count are re-checked.
    let q = match checkpoint.recovery_anchor {
        None => qnet_consensus::checkpoint_bft::quorum_size(committee.len()),
        Some((a, ah)) => {
            if !crate::node::RC_ENABLED { return Err(("rc_disabled", format!("mb={}", mb))); }
            crate::node::BlockchainNode::resolve_recovery_pin(storage, mb, checkpoint, a, ah, committee.len())
                .map_err(|e| ("rc_unresolved", e))?
        }
    };
    qc.verify(committee, q, |_, _, _| true).map_err(|e| ("rc_qc_rejected", format!("mb={} err={}", mb, e)))?;
    Ok(())
}

/// Execute driver Effects: sign+broadcast outbound, persist QCs, record finality.
/// Returns the windows this call durably sealed, for the caller to confirm to the driver.
pub async fn execute(effects: Vec<Effect>, node_id: &str, p2p: &Arc<SimplifiedP2P>, storage: &Arc<Storage>) -> Vec<u64> {
    let mut sealed_now: Vec<u64> = Vec::new();
    for e in effects {
        match e {
            Effect::Propose(mut cp) => {
                if let Some(s) = sign_payload(node_id, "CKPT", &cp.hash()).await {
                    cp.proposer_sig = s;
                    if crate::node::is_info() { println!("[INFO][BFT2] propose index={} head_h={}", cp.index, cp.window_head_height); }
                    broadcast(p2p, &ConsensusMsg::Proposal(cp)).await;
                }
            }
            Effect::Vote { index, checkpoint_hash, commit } => {
                // The commitment reaches DISK before the vote reaches the wire. The engine refuses a
                // second vote at one index/head and peers CONVICT that pair, so a commitment lost
                // across a restart is a permanent ban on an honest node. Fail-closed: no record, no
                // vote — withholding costs one round.
                if let Err(e) = storage.record_checkpoint_vote(
                    commit.index, commit.window_head, &commit.content_digest,
                    commit.pinned, commit.parent_index, &commit.parent_hash) {
                    if crate::node::is_warn() {
                        println!("[WARN][BFT2] vote_withheld reason=commitment_not_durable index={} err={}", index, e);
                    }
                    continue;
                }
                if let Some(s) = sign_payload(node_id, "VOTE", &checkpoint_hash).await {
                    broadcast(p2p, &ConsensusMsg::Vote(Vote { checkpoint_hash, index, voter: node_id.to_string(), signature: s })).await;
                }
            }
            Effect::Timeout { index, high_qc_index } => {
                if let Some(s) = sign_payload(node_id, "TMO", &timeout_bytes(index, high_qc_index)).await {
                    broadcast(p2p, &ConsensusMsg::Timeout(TimeoutMsg { index, voter: node_id.to_string(), high_qc_index, signature: s })).await;
                }
            }
            Effect::Relay(m) => relay_certificate(p2p, &m),
            Effect::Persist { checkpoint, qc, eligible_producers, committee } => {
                // Fail-closed pin self-check before anything is written. `continue`, never `return` —
                // a return would also drop the Finalize queued behind this effect.
                if let Err((reason, detail)) = rc_seal_ok(storage, &checkpoint, &qc, &committee) {
                    if crate::node::is_warn() {
                        println!("[WARN][BFT2] persist_refused reason={} head={} detail={}",
                                 reason, checkpoint.window_head_height, detail);
                    }
                    continue;
                }
                // Every committee member seals locally: the body is a pure function of the
                // committed window (deterministic), so all produce a byte-identical block —
                // no single-producer SPOF, no seal race. Macroblock HEIGHT = window (head/90),
                // decoupled from the consensus round (checkpoint.index, may skip on timeout)
                // so a skipped round leaves NO gap. Broadcast is leader-only (peers hold it
                // locally / serve on sync) to avoid N× traffic.
                let window = checkpoint.window_head_height / 90;
                // Idempotent: already sealed locally or received via broadcast/sync.
                if storage.get_macroblock_by_height(window).ok().flatten().is_some() { sealed_now.push(window); continue; }
                // Chain link: seal only when the parent macroblock is present, and take previous_hash
                // FROM THAT PARENT, by index.
                //
                // previous_hash is inside MacroBlock::hash(), and that hash is compared for equality
                // ACROSS nodes (the two window-pin block rejects and the vote/TC anchor checks), so it
                // must derive from committed data. `latest_macroblock_hash` is a single metadata key
                // that save_macroblock overwrites on EVERY save at ANY index in ANY order — one
                // out-of-order sync ingest points it at the wrong macroblock, the seal chains to the
                // wrong parent, and since nothing verifies the link on receive the divergence is
                // written into the next macroblock and becomes permanent.
                // Read through macroblock_plaintext, not bare bincode: the stored form is uncompressed
                // today but the sniffing helper is what every other macroblock reader on a consensus
                // path uses, and a bare deserialize on a zstd body would return None here — i.e. defer
                // the seal forever, which is a halt, not a degraded read.
                let previous_hash = if window > 1 {
                    match storage.get_macroblock_by_height(window - 1).ok().flatten()
                        .and_then(crate::node::BlockchainNode::macroblock_plaintext)
                        .and_then(|raw| bincode::deserialize::<qnet_state::MacroBlock>(&raw).ok())
                    {
                        Some(parent) => parent.hash(),
                        None => {
                            if crate::node::is_warn() { println!("[WARN][BFT2] seal_deferred window={} reason=parent_absent", window); }
                            continue;
                        }
                    }
                } else {
                    [0u8; 32]
                };
                // Store (checkpoint, QC) so receivers reconstruct checkpoint.hash(), confirm
                // it == qc.checkpoint_hash (binds this exact block), and full-verify the QC.
                let qc_bytes = bincode::serialize(&(checkpoint.clone(), qc.clone())).unwrap_or_default();
                let excluded = excluded_producers(storage, window);
                // Reward recipients are NOT sealed in the macroblock — apply recomputes both Super
                // (registry + per-epoch heartbeat tally) and Light (on-chain eligibility bitmaps +
                // deterministic roster), giving an O(1) macroblock with an identical reward root on
                // every node. pool2/pool3 stay None.
                let _ = &p2p; // sealing removed; p2p no longer read here
                // v2 SCALE ANCHOR: cumulative equivocation ban-set as of this window (prev
                // macroblock's set ∪ this window's verified proofs), sorted for byte-stable
                // bincode. Lets the next epoch's reputation fold derive bans in O(window)
                // instead of re-scanning from genesis (pruning-safe, scales to 100k). Pure
                // function of the committed chain ⇒ every sealer produces the same bytes.
                let banned_validators = {
                    // Underivable ⇒ abort the persist. Every sealer assembles this macroblock body
                    // locally, so a guessed set here means two nodes store DIFFERENT bytes under the
                    // same macroblock key — and that object is the roster/beacon source for the next
                    // epochs. Not sealing leaves the window to the quorum that can derive it; this node
                    // adopts the sealed object through sync.
                    let set = match crate::node::BlockchainNode::compute_cumulative_ban_set(&storage, window).await {
                        Some(b) => b,
                        None => {
                            // Same shape as parent_absent above: defer this window, do not seal a
                            // body whose bytes would differ from every other sealer's.
                            if crate::node::is_warn() { println!("[WARN][BFT2] seal_deferred window={} reason=ban_set_underivable", window); }
                            continue;
                        }
                    };
                    let mut v: Vec<String> = set.into_iter().collect();
                    v.sort();
                    Some(bincode::serialize(&v).unwrap_or_default())
                };
                let mb = qnet_state::MacroBlock {
                    height: window,
                    timestamp: checkpoint.timestamp,
                    micro_blocks: checkpoint.window_mb_hashes.clone(),
                    state_root: checkpoint.state_root,
                    consensus_data: qnet_state::ConsensusData {
                        checkpoint_qc: Some(qc_bytes),
                        eligible_producers: if eligible_producers.is_empty() { None } else { Some(eligible_producers) },
                        randomness_beacon: Some(checkpoint.beacon),
                        excluded_producers_for_next_epoch: excluded,
                        consensus_committee: Some(committee),
                        banned_validators,

                        reward_light_nodes: None,
                        ..Default::default()
                    },
                    previous_hash,
                };
                match storage.save_macroblock(window, &mb).await {
                    Ok(_) => {
                        sealed_now.push(window);
                        if checkpoint.proposer == node_id {
                            if let Ok(ser) = bincode::serialize(&mb) {
                                let compressed = zstd::encode_all(&ser[..], 3).unwrap_or(ser);
                                let _ = p2p.broadcast_macroblock(window, compressed, window).await;
                            }
                        }
                        if crate::node::is_info() {
                            println!("[INFO][BFT2] macroblock_sealed window={} round={} head_h={} signers={} role={}",
                                     window, checkpoint.index, checkpoint.window_head_height, qc.signers.len(),
                                     if checkpoint.proposer == node_id { "leader" } else { "replica" });
                        }
                    }
                    Err(e) => if crate::node::is_warn() {
                        println!("[WARN][BFT2] macroblock_save_failed window={} err={}", window, e);
                    },
                }
            }
            Effect::Finalize { index, head_height, state_root, mb_hashes } => {
                // Finalize a checkpoint on ITS OWN QC'd head + state_root + per-height body hashes — NOT via
                // a macroblock body (intra-window checkpoints on the /cp_interval cadence have none). Advance
                // the monotonic marker ONLY if: tip reached the head AND local head state == QC'd state_root
                // AND every local body in the window matches the QC'd mb_hashes. The last gate is the safety
                // fix: a same-state-different-body failover fork tail passes state_root but NOT the body-hash
                // check, so finality can never pin a fork. Sub-anchor history (snapshot-carried) is trusted.
                let chain_h = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(Ordering::Relaxed);
                let local_root = storage.load_microblock_auto_format(head_height).ok().flatten()
                    .map(|m| m.state_root);
                let anchor_ok = crate::node::SNAPSHOT_ANCHOR_MB.load(Ordering::SeqCst).saturating_mul(90) >= head_height;
                let win = mb_hashes.len() as u64;
                // ONE window scan, shared by the gate below and the repair loop (two hand-rolled passes each
                // re-loaded every body). Same comparator as every other finality-advance path.
                let verdict = if !anchor_ok && win > 0 && win <= head_height {
                    let start = head_height - (win - 1);
                    Some(crate::node::BlockchainNode::window_content_verdict(
                        &storage, &mb_hashes, start, head_height))
                } else { None };
                let content_ok = anchor_ok
                    || verdict.as_ref().map_or(false, |(miss, mism)| miss.is_empty() && mism.is_empty());
                if content_ok && checkpoint_finalizable(chain_h, head_height, local_root, state_root) {
                    if head_height > crate::node::LAST_FINALIZED_HEIGHT.load(Ordering::Acquire) {
                        crate::node::try_advance_finality(head_height, "BFT2");
                        if crate::node::is_info() {
                            println!("[INFO][BFT2] checkpoint_final round={} finalized_h={}", index, head_height);
                        }
                    }
                } else {
                    // Transient (tip below head) OR fail-stop (state/body divergence). The run-loop timer
                    // re-emits via committed_finalize() until caught up. On a body divergence, solicit repair
                    // for the window so fork-choice supersedes the local losing tail; self-throttled.
                    // Reuse the single scan above; capped like every other repair kick (self-throttled anyway).
                    // Detached: awaiting 32 repairs in turn here blocks the same task the view
                    // timer runs on, and each is fire-and-forget anyway - completeness is judged
                    // by re-reading storage on the next tick.
                    if let Some((missing, mismatched)) = verdict.as_ref() {
                        let heights: Vec<u64> = missing.iter().chain(mismatched.iter())
                            .copied().take(32).collect();
                        if !heights.is_empty() {
                            let p = p2p.clone();
                            tokio::spawn(async move {
                                for h in heights { let _ = p.request_block_repair_priority(h).await; }
                            });
                        }
                    }
                    if crate::node::is_warn() {
                        println!("[WARN][BFT2] finalize_deferred round={} head_h={} chain_h={} state_match={} content_ok={}",
                                 index, head_height, chain_h, local_root == Some(state_root), content_ok);
                    }
                }
            }
        }
    }
    sealed_now
}

/// Events fed to the v2 runtime task.
pub enum V2Event {
    Inbound(Vec<u8>),  // raw ConsensusMsg bytes from P2P
    // A checkpoint cert (Qc/Tc) whose O(committee) ML-DSA signature was verified OFF the select-loop
    // task (dispatch_cert_verify). INTERNAL + trusted: only that worker emits it (external peers can
    // only reach the loop via route_inbound → Inbound), so the loop processes it WITHOUT re-verifying.
    CertVerified(Vec<u8>),
    WindowEnd {
        index: u64, head_height: u64, mb_hashes: Vec<Hash>, state_root: Hash, beacon: Hash,
        committee: Vec<String>,        // epoch committee (N-2 VRF sample) for this window
        eligible_producers: Vec<u8>,   // bincode Vec<EligibleProducer> for the macroblock body
        banned: Vec<String>,           // QC-bound cumulative ban set (binds stored banned_validators)
        reward_root: Hash,             // per-epoch reward merkle root ([0;32] off emission boundary)
        registry_root: Hash,           // deterministic Super/genesis registry digest (snapshot-forge defence)
        dilithium_pk_root: Hash,       // FIX-5: (address->pk) LtHash digest (elided-pk snapshot-forge defence)
        reward_epoch_root: Hash,       // LtHash over held (epoch, reward root) pairs — lets a cold-join carry them
        logs_root: Hash,               // consensus event logs root (native QRC-20/721 + WASM), ACTIVE from genesis (gate=0)
        total_supply: u64,             // QC-bound total minted supply (cold-joiner reads this, not balance sum)
    },
    // A macroblock whose checkpoint QC the apply path already verified against the correct epoch
    // committee — fed here so a driver too far behind for gossip fast-forwards from committed
    // state (§4.5 catch-up). bincode of (Checkpoint, QuorumCertificate).
    Synced(Vec<u8>),
}

/// Buffered per-window proposal/seal inputs from the production window signal, so a leader
/// can propose the contiguous next window at ANY round — including after a skip, when the
/// round has advanced past the window number.
#[derive(Clone)]
struct WindowContent {
    mb_hashes: Vec<Hash>,
    state_root: Hash,
    beacon: Hash,
    head_ts: u64,
    committee: Vec<String>,
    eligible: Vec<u8>,
    banned: Vec<String>,   // QC-bound cumulative ban set (folded into epoch_commitment)
    reward_root: Hash,     // per-epoch reward merkle root, QC-certified via Checkpoint.reward_root
    registry_root: Hash,   // Super/genesis registry digest, QC-certified via Checkpoint.registry_root
    dilithium_pk_root: Hash, // FIX-5: (address->pk) digest, QC-certified via Checkpoint.dilithium_pk_root
    reward_epoch_root: Hash, // held (epoch, reward root) digest, QC-certified via Checkpoint.reward_epoch_root
    logs_root: Hash,       // consensus event logs root (native QRC-20/721 + WASM), ACTIVE from genesis (gate=0)
    total_supply: u64,     // total minted supply, QC-certified via Checkpoint.total_supply
}

/// Recompute a window's tail (mb hashes + beacon) FRESH from canonical storage bodies — the same
/// derivation check_content votes against. None if any body is absent (mid-rollback/resync:
/// transient, the caller retries on its next trigger). O(win) reads, leader-proposal-path only.
fn derive_window_tail(storage: &Storage, head: u64, win: usize) -> Option<(Vec<Hash>, Hash)> {
    if win == 0 || win as u64 > head { return None; }
    let start = head - (win as u64 - 1);
    let mut hashes = Vec::with_capacity(win);
    for h in start..=head {
        let mb = storage.load_microblock_auto_format(h).ok().flatten()?;
        hashes.push(mb.hash());
    }
    let beacon = qnet_consensus::checkpoint_bft::accumulate_beacon(&hashes);
    Some((hashes, beacon))
}

/// Adopt the in-flight window's committee and, if we lead the current round, propose the
/// contiguous next window. No-op until that window's content has been buffered locally.
/// PROPOSE-FROM-STORAGE (audit F3): the LEADER's proposed tail is re-derived from canonical
/// storage at propose time, NOT the WindowEnd snapshot — after a fork-choice supersede the
/// snapshot's tail is dead (its losing bodies can never supersede the stored certified winner,
/// so nobody — including this node — could ever vote it, and the macro-boundary snapshot is
/// never re-signalled). Deriving from storage makes the proposer symmetric with the voter gate:
/// both sides read the same canonical bodies, so a reorged leader proposes the ADOPTABLE tail.
/// State/epoch fields stay snapshot-sourced — a round-rebind supersede never changes applied
/// state (the TailDiverged safety premise), and a state-CHANGING divergence must keep failing
/// the voters' state gate rather than be papered over here. Mid-rollback (body missing) ⇒ fall
/// back to the snapshot tail: build_proposal must still run on EVERY member (all-seal buffers
/// seal_data unconditionally), and a dead-tail proposal is no worse than the pre-fix status quo.
fn try_propose(
    driver: &mut ConsensusDriver,
    buf: &std::collections::HashMap<u64, WindowContent>,
    storage: &Storage,
    committee: &mut Vec<String>,
) -> Vec<Effect> {
    let w = driver.next_window();
    match buf.get(&w) {
        Some(c) => {
            *committee = c.committee.clone(); // committee is per-window (epoch); QC/TC verify against it
            // O(win) storage reads gated on ACTUALLY leading (once per round), never the hot vote path.
            let (mb_hashes, beacon) = if driver.is_leader_now() {
                derive_window_tail(storage, w.saturating_mul(qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL), c.mb_hashes.len())
                    .unwrap_or_else(|| (c.mb_hashes.clone(), c.beacon))
            } else {
                (c.mb_hashes.clone(), c.beacon)
            };
            driver.build_proposal(w, mb_hashes, c.state_root, beacon, c.head_ts, c.committee.clone(), c.eligible.clone(), c.banned.clone(), c.reward_root, c.registry_root, c.dilithium_pk_root, c.reward_epoch_root, c.logs_root, c.total_supply)
        }
        None => Vec::new(),
    }
}

/// Outcome of the pre-vote content gate.
enum ContentCheck {
    Ok,                     // content independently reproduced ⇒ safe to hand to the driver (vote)
    TailDiverged(Vec<u64>), // pure hash-level tail split (state agrees) at these heights ⇒ reconcile, don't vote yet
    Defer,                  // our own window snapshot not derived yet (apply-lag/eviction) ⇒ buffer + retry, NEVER Reject
    Reject(&'static str),   // genuine divergence ⇒ fail-stop (never vote); which check failed
}

/// Re-handle buffered inbound now the round / in-flight committee may have advanced. One
/// pass: messages still ahead of our round stay buffered (bounded), the rest verify+apply.
/// No-op until we hold the in-flight window's committee.
/// A Proposal's content must be INDEPENDENTLY reproducible before we vote — anti-forge of
/// state_root / window_mb_hashes / beacon / epoch_commitment / reward_root / (gated)
/// registry_root+total_supply, all folded into Checkpoint::hash. The STATE/epoch fields compare
/// against our own derived window (window_buf) EXACTLY — a mismatch there is genuine divergence
/// (Reject, never voted). The TAIL (window_mb_hashes + beacon) is recomputed FRESH from canonical
/// storage bodies, NOT the WindowEnd snapshot: under a macroblock-boundary failover the snapshot
/// goes stale the instant fork-choice reorgs our tail to the higher-certified-round winner. When
/// the state agrees but a tail height still holds our losing-round block, that height is returned
/// for reconcile (pull the certified-canonical block ⇒ supersede) rather than fail-stop — THE fix
/// for the boundary-failover finality freeze; the adopt is completed by the buffered proposal
/// re-gating Ok in drain_pending once the canonical bodies land (propose-and-adopt, never a blind
/// vote). No local window ⇒ Defer (apply-lag is not divergence: buffer + retry). Non-Proposal ⇒ Ok.
/// Single source of truth for the live inbound path AND drain_pending (replay = the same gate).
fn check_content(storage: &Storage, buf: &std::collections::HashMap<u64, WindowContent>, msg: &ConsensusMsg) -> ContentCheck {
    let cp = match msg { ConsensusMsg::Proposal(cp) => cp, _ => return ContentCheck::Ok };
    // The pin is attacker-chosen wire data that selects a lower threshold. While the feature is off
    // no node may sign one, or an unarmed committee certifies a checkpoint every peer then rejects.
    if !crate::node::RC_ENABLED && cp.recovery_anchor.is_some() { return ContentCheck::Reject("pin"); }
    let k = qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL;
    // Absent window snapshot = this node hasn't derived its own view of this checkpoint yet (apply-lag /
    // eviction), NOT a divergence. Defer (buffer + retry) so a lagging voter never silently fail-stops on a
    // proposal it simply hasn't caught up to — the silent-abstain trap behind the boundary finality freeze.
    let c = match buf.get(&(cp.window_head_height / k)) { Some(c) => c, None => return ContentCheck::Defer };
    // State + epoch fields must match EXACTLY — never reconcile a genuine state/epoch divergence.
    // state_root agreeing is the safety gate that makes a tail-hash split safe to reconcile below
    // (same applied state, only the failover-round-bound block hashes differ).
    if cp.state_root != c.state_root
        || qnet_consensus::checkpoint_bft::epoch_commitment(&c.eligible, &c.committee, &c.banned) != cp.epoch_commitment
        || cp.reward_root != c.reward_root
        || (qnet_state::feature_gates::is_active("registry_root_required", cp.window_head_height) && cp.registry_root != c.registry_root)
        || (qnet_state::feature_gates::is_active("registry_root_required", cp.window_head_height) && cp.dilithium_pk_root != c.dilithium_pk_root)
        || (qnet_state::feature_gates::is_active("logs_root_required", cp.window_head_height) && cp.logs_root != c.logs_root)
        || (qnet_state::feature_gates::is_active("registry_root_required", cp.window_head_height) && cp.total_supply != c.total_supply)
        || (qnet_state::feature_gates::is_active("reward_epoch_root_required", cp.window_head_height) && cp.reward_epoch_root != c.reward_epoch_root)
    { return ContentCheck::Reject("state"); }
    // Window SPAN comes from OUR OWN snapshot, not `k`: an intra checkpoint covers CHECKPOINT_INTERVAL
    // blocks, but the macroblock-boundary checkpoint (head = 90·mb_idx) covers the FULL macroblock
    // window. `c.mb_hashes.len()` is the honest span for this checkpoint index (30 or 90) and is NOT
    // proposer-controlled, so the recompute range and the `!=` guard below are DoS-safe. A proposer
    // whose window size disagrees with ours is a genuine divergence ⇒ Reject.
    let win = c.mb_hashes.len();
    if cp.window_mb_hashes.len() != win || win == 0 || win as u64 > cp.window_head_height {
        return ContentCheck::Reject("span");
    }
    // Tail: recompute mb_hashes + beacon FRESH from canonical bodies. A divergent/absent tail height
    // ⇒ reconcile (the caller pulls the certified-canonical block; fork-choice supersedes ours).
    let start = cp.window_head_height - (win as u64 - 1);
    let mut diverged = Vec::new();
    for (i, h) in (start..=cp.window_head_height).enumerate() {
        match storage.load_microblock_auto_format(h).ok().flatten() {
            Some(mb) if mb.hash() == cp.window_mb_hashes[i] => {}
            _ => diverged.push(h), // divergent hash, or body absent ⇒ pull the certified-canonical block
        }
    }
    if !diverged.is_empty() { return ContentCheck::TailDiverged(diverged); }
    // All bodies matched ⇒ beacon derived from their VRF outputs must equal the proposer's; verify.
    // The beacon is the fold over the tail hashes we just matched against the QC-signed list.
    if qnet_consensus::checkpoint_bft::accumulate_beacon(&cp.window_mb_hashes) != cp.beacon {
        return ContentCheck::Reject("beacon");
    }
    ContentCheck::Ok
}

fn drain_pending(
    driver: &mut ConsensusDriver, buf: &std::collections::HashMap<u64, WindowContent>,
    storage: &Storage, p2p: &Arc<SimplifiedP2P>, committee: &[String], pending: &mut Vec<Vec<u8>>, max: usize, heard: &mut std::collections::HashMap<String, std::time::Instant>,
) -> Vec<Effect> {
    if pending.is_empty() || committee.is_empty() { return Vec::new(); }
    let cur = driver.current_index();
    let committed = driver.committed_index();
    let mut effs = Vec::new();
    let mut still = Vec::new();
    // Per-drain weight bound on RETAINED content-gated Proposals: each costs an O(window) storage
    // recompute per drain, and drain fires per authenticated inbound message. Honest steady state is
    // exactly ONE such entry (the current leader's adopt-candidate); this cap makes the worst case
    // (non-leader committee members mass-signing state-copied proposals — verify_msg checks only
    // MEMBERSHIP, the engine's is_leader runs later) a constant, not O(committee) (audit F2).
    let mut retained_gated = 0usize;
    for data in std::mem::take(pending) {
        match bincode::deserialize::<ConsensusMsg>(&data) {
            // At/below the committed frontier ⇒ can never matter again; prune. (This is what expires an
            // adopt-buffered proposal whose window already finalized via the other voters.)
            Ok(m) if msg_index(&m) <= committed => {}
            // DEAD ROUND (audit F5/F6): the engine votes only proposals with index == current view
            // (on_proposal strict equality) — once the view rotated past it, a buffered Proposal can
            // never produce a vote; the post-TC re-proposal arrives with a NEW index via the live path.
            // Pruning here is what bounds retained adopt-candidates to the CURRENT round only.
            Ok(ConsensusMsg::Proposal(p)) if p.index < cur => {}
            Ok(m) if msg_index(&m) <= cur => {
                // Certs carry O(committee) ML-DSA sigs — NEVER verify inline on this loop (same rule
                // as the live path, audit F7): dispatch to the bounded off-loop worker; on success it
                // re-enters as CertVerified and applies without re-verify.
                if matches!(&m, ConsensusMsg::Qc(_) | ConsensusMsg::Tc(_)) {
                    dispatch_cert_verify(data, p2p, committee, cur);
                    continue;
                }
                // Buffered replay applies the SAME sig + content gate as the live path — a Proposal whose
                // window content we cannot independently reproduce is never handed to the driver.
                if verify_msg(p2p, committee, &m) {
                    // Same census the live path keeps: a member whose message only ever reaches us
                    // through replay is demonstrably alive, and omitting it under-counts liveness.
                    if let Some(sender) = msg_sender(&m) {
                        heard.insert(sender.to_string(), std::time::Instant::now());
                    }
                    match check_content(storage, buf, &m) {
                        ContentCheck::Ok => { observe_accountability(&m); effs.extend(driver.handle(&m)); }
                        // Adopt still in flight — canonical bodies not yet pulled/superseded (TailDiverged)
                        // or our window not yet derived (Defer) ⇒ keep buffered; the next drain re-gates.
                        // Repair is NOT re-fired here (the live path re-fires it at round cadence via the
                        // re-proposal after TC) so a drain-per-inbound-message can never flood repair.
                        ContentCheck::TailDiverged(_) | ContentCheck::Defer => {
                            if retained_gated < MAX_RETAINED_GATED && still.len() < max {
                                retained_gated += 1;
                                still.push(data);
                            }
                        }
                        // Genuine state/epoch divergence ⇒ fail-stop, never retried.
                        ContentCheck::Reject(_) => {}
                    }
                }
            }
            // Future band, HORIZON-bounded (audit F1): an index beyond cur+HORIZON cannot become
            // verifiable soon, and — being buffered pre-authentication — would otherwise let junk
            // squat its slot forever (msg_index is attacker-chosen). Within the horizon an entry is
            // flushed at the first drain after the view reaches it (sig-fail ⇒ dropped).
            Ok(m) if msg_index(&m) <= cur.saturating_add(V2_PENDING_VIEW_HORIZON) && still.len() < max => still.push(data),
            _ => {}
        }
    }
    *pending = still;
    effs
}

static V2_TX: OnceCell<mpsc::UnboundedSender<V2Event>> = OnceCell::new();

/// Backpressure bound (BYTES) on UNPROCESSED inbound PEER consensus messages. A flooding
/// peer cannot grow the queue past this ⇒ RAM is capped, closing the unbounded-channel OOM.
/// Bounded by bytes, not count, because messages vary widely (a vote ≈ a few KB; a proposal
/// carrying a QC can be hundreds of KB). Local control events (WindowEnd/Synced) are NOT
/// counted here ⇒ never throttled. Consensus tolerates inbound loss (the pacemaker re-proposes,
/// peers re-gossip); the driver's `verify_msg` remains the committee/validity gate. Generous
/// vs legitimate in-flight volume (committee ≤100 × O(1) msgs/round ≪ 1 MiB), so honest traffic
/// is never dropped outside an active flood. A MEMORY bound, not a rate — cannot throttle
/// legitimate throughput (unlike the v17.x per-minute limit that stalled the net).
static V2_INBOUND_BYTES: AtomicUsize = AtomicUsize::new(0);
const V2_INBOUND_BYTE_CAP: usize = 64 * 1024 * 1024; // 64 MiB of queued inbound consensus bytes
/// Companion BYTE bound on the driver's `pending` replay buffer. The 256-ENTRY
/// count cap alone still allows 256 × msg_size (a large-proposal flood ⇒ hundreds of MiB),
/// so pending is independently byte-capped. Total inbound consensus memory ≤ this + the
/// channel cap. `drain_pending` only REMOVES or RE-KEEPS entries (never adds), so it can
/// never exceed this bound — every push site goes through `buffer_pending`.
const V2_PENDING_BYTE_CAP: usize = 32 * 1024 * 1024; // 32 MiB of buffered replay bytes
/// How far above the current view a buffered message's index may sit. The future-round push site
/// buffers PRE-authentication (a Qc/Tc sig can't be checked inline), so msg_index is attacker-
/// chosen — without a horizon, junk at index u64::MAX squats its buffer slot forever and starves
/// the adopt path (audit F1). Views advance every view-timeout even during a wedge (TC), so 64
/// views of legit skew is generous; anything farther is re-gossiped when relevant.
const V2_PENDING_VIEW_HORIZON: u64 = 64;
/// Max content-gated Proposals (TailDiverged/Defer) RETAINED per drain — each costs an O(window)
/// storage recompute per drain pass. Honest steady state = 1 (the current leader's adopt candidate).
const MAX_RETAINED_GATED: usize = 4;

/// Content rejects and signature failures are both peer-driven: every committee member may sign
/// a proposal, so one action can produce a line per member per round on the task that drives
/// finality. Counted here, reported once per view tick with one detailed line for diagnosis.
/// Head height the driver will accept next (next_window * CHECKPOINT_INTERVAL). The finality
/// marker cannot stand in for it: several writers advance that marker in whole macroblocks, so a
/// marker-derived target overshoots by one checkpoint whenever the macro path wrote it last.
static V2_NEXT_WINDOW_HEAD: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 0 until the runtime has driven at least one tick.
pub fn v2_next_window_head() -> u64 { V2_NEXT_WINDOW_HEAD.load(Ordering::Relaxed) }

static CONTENT_REJECTS: AtomicUsize = AtomicUsize::new(0);
static CERT_SHED: AtomicUsize = AtomicUsize::new(0);
static VERIFY_FAILS: AtomicUsize = AtomicUsize::new(0);

/// Windows the in-set quorum must be ahead before "no data for next_window" means behind rather than
/// idle: 2-chain finality already runs the tip ~2 windows past the window being committed.
const CATCHUP_LAG_WINDOWS: u64 = 3;
/// Sustained view ticks before pulling - one slow window must not generate network traffic.
const CATCHUP_TICKS: u32 = 3;

/// Network head in checkpoint windows, as a SYNC HINT only. Uses the tree's Byzantine-safe order
/// statistic - (f+1)-th highest over fresh in-set attested heights, floor 4 - because a signed
/// HealthPing binds authorship, not truth: any registered key can sign any height. Each height is
/// first clamped to the roster horizon, beyond which nothing is derivable anyway. 0 below the floor.
///
/// This value gates only what this node ASKS FOR. It must never gate what it signs: an oracle a few
/// signed integers can move would otherwise buy a network-wide view-change storm.
fn peer_window(p2p: &SimplifiedP2P, local_tip: u64) -> u64 {
    peer_window_from(p2p.fresh_in_set_peer_heights(), local_tip)
}

/// The pure half of peer_window, so the Byzantine properties are testable without a network.
pub(crate) fn peer_window_from(heights: Vec<u64>, local_tip: u64) -> u64 {
    let mi = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
    let ceiling = local_tip.saturating_add(
        (crate::node::BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64).saturating_mul(mi));
    let hs: Vec<u64> = heights.into_iter().map(|h| h.min(ceiling)).collect();
    crate::unified_p2p::frontier_order_statistic(hs)
        / qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL
}

/// (Checkpoint, QC) of stored macroblock `idx`, read through the same zstd-sniffing reader every
/// other consensus path uses. A bare bincode returns None on a compressed body, which silently
/// disables the recovery it is called for.
fn stored_checkpoint_qc(storage: &Storage, idx: u64)
    -> Option<(qnet_consensus::checkpoint_bft::Checkpoint, QuorumCertificate)>
{
    let raw = storage.get_macroblock_by_height(idx).ok().flatten()?;
    let plain = crate::node::BlockchainNode::macroblock_plaintext(raw)?;
    let mb = bincode::deserialize::<qnet_state::MacroBlock>(&plain).ok()?;
    bincode::deserialize(mb.consensus_data.checkpoint_qc.as_ref()?).ok()
}

/// Behind the quorum, as against idle between windows. Locally the two are identical - "we hold no
/// data for next_window" - and only the peer term separates them. Without it a node that lost its
/// window bodies waits forever on a condition its own fault holds false.
pub(crate) fn is_behind_quorum(next_window: u64, last_signaled: u64, peer_window: u64, lag: u64) -> bool {
    next_window > last_signaled && peer_window > next_window.saturating_add(lag)
}

/// Epoch committee for checkpoint window `w`, from COMMITTED state - knowable whether or not this
/// node could derive that window's content. None = the N-2 anchor is not held; fail closed and let
/// the caller buffer rather than guess a set.
fn committee_for_window(storage: &Storage, w: u64) -> Option<Vec<String>> {
    let k = qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL;
    let mi = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
    let h = w.saturating_mul(k);
    // Genesis era: epochs 1-2 have no N-2 snapshot, same convention failover_committee_for_window uses.
    if h <= 2 * mi {
        return Some(crate::genesis_constants::GENESIS_CONSENSUS_PKS
            .iter().map(|(id, _)| id.to_string()).collect());
    }
    crate::node::BlockchainNode::committee_for_height(storage, h)
}

/// Hold `committee` on the driver's next window, resolving once per window rather than per message,
/// and push it into the driver BEFORE it tallies anything: the engine's set was previously updated
/// only as a side effect of build_proposal, which runs AFTER handle(), so the first message of a
/// rotated epoch was counted against the previous epoch's committee.
fn refresh_committee(committee: &mut Vec<String>, cached_for: &mut u64,
                     driver: &mut ConsensusDriver, storage: &Storage,
                     buf: &std::collections::HashMap<u64, WindowContent>) {
    let w = driver.next_window();
    if *cached_for == w { return; }
    let resolved = buf.get(&w).map(|c| c.committee.clone())
        .or_else(|| committee_for_window(storage, w));
    match resolved {
        Some(c) => {
            *cached_for = w;
            if *committee != c {
                *committee = c.clone();
                driver.set_committee(c);
                if crate::node::is_debug() {
                    println!("[INFO][BFT2] committee_adopted win={} n={}", w, committee.len());
                }
            }
        }
        // Unresolved membership must not fall back on the previous epoch's set: the caller's
        // gate only tests emptiness, so a stale committee would authenticate this window's
        // gossip against the wrong roster. Clear and buffer until the N-2 anchor is held.
        None => {
            if !committee.is_empty() {
                committee.clear();
                if crate::node::is_warn() {
                    println!("[WARN][BFT2] committee_unresolved win={} action=buffer", w);
                }
            }
        }
    }
}

/// Ask peers for what no local retry can produce: the bodies missing in `w`'s span. Their arrival
/// re-opens the whole local chain - apply advances, WindowEnd fires, window_buf fills, drain_pending
/// re-gates the buffered proposals and votes flow again.
///
/// Driven only from the view timer, never from inbound: a proposal's window_head_height is
/// attacker-chosen before content verification and range sync is globally single-flight, so pulling
/// on inbound would let one forged proposal steer this node's only sync slot onto junk.
fn request_window_recovery(storage: &Storage, w: u64) {
    let k = qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL;
    let head = w.saturating_mul(k);
    let start = head.saturating_sub(k.saturating_sub(1));
    if let Some(first) = (start..=head)
        .find(|h| storage.load_microblock_auto_format(*h).ok().flatten().is_none())
    {
        crate::block_pipeline::request_missing_range(first, head);
    }
}

/// SOLE push site into the replay buffer: count cap + byte cap + re-gossip dedup. Keeping every
/// producer (future-round buffering, Defer, TailDiverged adopt) on one gate is what makes
/// V2_PENDING_BYTE_CAP a real invariant rather than a per-site convention. Dedup is a fast-fail
/// memcmp over ≤256 entries and only runs on buffered paths (never the hot Ok path).
/// CLASS SPLIT (audit F1): the future-round site buffers PRE-authentication, so unauthenticated
/// pushes may fill only HALF of each cap — the reserved half is writable solely by the
/// authenticated paths (TailDiverged/Defer, post-verify_msg). A junk flood can therefore never
/// starve the adopt-candidate slot that unwedges finality.
fn buffer_pending(pending: &mut Vec<Vec<u8>>, max: usize, bytes: Vec<u8>, authenticated: bool) {
    let (cap_n, cap_b) = if authenticated { (max, V2_PENDING_BYTE_CAP) } else { (max / 2, V2_PENDING_BYTE_CAP / 2) };
    if pending.len() >= cap_n { return; }
    let used: usize = pending.iter().map(|d| d.len()).sum();
    if used + bytes.len() > cap_b { return; }
    if pending.iter().any(|d| *d == bytes) { return; } // re-gossiped duplicate
    pending.push(bytes);
}

/// ONE adopt-candidate slot per (ROUND, proposer): before buffering a gated Proposal, evict any
/// older buffered Proposal from the SAME proposer for the SAME round (cp.index IS the view/round —
/// a post-TC re-proposal carries a NEW index and is a NEW slot; its stale-round predecessor is
/// pruned by drain_pending's dead-round arm instead). What this slot stops: an equivocating
/// signer re-flooding same-round variants to stuff the buffer — it holds exactly ONE entry per
/// (round, identity), every extra variant it signs is vote-equivocation evidence (recorded by
/// observe_accountability on both the live and replay paths), and MAX_RETAINED_GATED bounds the
/// total re-gate weight regardless. O(pending) deserialize, divergence paths only — never the hot
/// Ok path.
fn evict_superseded_proposal(pending: &mut Vec<Vec<u8>>, index: u64, proposer: &str) {
    pending.retain(|d| match bincode::deserialize::<ConsensusMsg>(d) {
        Ok(ConsensusMsg::Proposal(old)) => !(old.index == index && old.proposer == proposer),
        _ => true,
    });
}

/// P2P dispatch calls this for NetworkMessage::ConsensusV2 (no-op until run() starts).
pub fn route_inbound(data: Vec<u8>) {
    if let Some(tx) = V2_TX.get() {
        // Reserve the message's bytes; drop under flood so a peer cannot OOM the node. The
        // reservation is released when run() dequeues the message (or here if the send fails).
        let n = data.len();
        if V2_INBOUND_BYTES.fetch_add(n, Ordering::AcqRel) + n > V2_INBOUND_BYTE_CAP {
            V2_INBOUND_BYTES.fetch_sub(n, Ordering::AcqRel);
            return; // dropped under flood — consensus re-gossips / the pacemaker re-proposes
        }
        if tx.send(V2Event::Inbound(data)).is_err() {
            V2_INBOUND_BYTES.fetch_sub(n, Ordering::AcqRel); // channel gone (shutdown)
        }
    }
}

/// Production loop calls this at each checkpoint-window boundary.
/// Named fields, not positional args: five of these are `Hash`, so a positional call silently
/// swaps roots between checkpoint fields and the types cannot catch it.
pub struct WindowEndArgs {
    pub index: u64,
    pub head_height: u64,
    pub mb_hashes: Vec<Hash>,
    pub state_root: Hash,
    pub beacon: Hash,
    pub committee: Vec<String>,
    pub eligible_producers: Vec<u8>,
    pub banned: Vec<String>,
    pub reward_root: Hash,
    pub registry_root: Hash,
    pub dilithium_pk_root: Hash,
    pub reward_epoch_root: Hash,
    pub logs_root: Hash,
    pub total_supply: u64,
}

pub fn signal_window_end(a: WindowEndArgs) {
    let WindowEndArgs { index, head_height, mb_hashes, state_root, beacon, committee,
                        eligible_producers, banned, reward_root, registry_root,
                        dilithium_pk_root, reward_epoch_root, logs_root, total_supply } = a;
    if let Some(tx) = V2_TX.get() {
        let _ = tx.send(V2Event::WindowEnd { index, head_height, mb_hashes, state_root, beacon, committee, eligible_producers, banned, reward_root, registry_root, dilithium_pk_root, reward_epoch_root, logs_root, total_supply });
    }
}

/// The macroblock-apply path calls this AFTER it has verified the checkpoint QC against the
/// correct epoch committee — handing the committed (Checkpoint, QC) bytes to the driver so a
/// node whose consensus round fell behind the live quorum fast-forwards from committed state
/// (§4.5 catch-up). Monotonic ⇒ a no-op for a node already at/ahead of this checkpoint.
pub fn signal_synced_checkpoint(cp_qc: Vec<u8>) {
    if let Some(tx) = V2_TX.get() { let _ = tx.send(V2Event::Synced(cp_qc)); }
}

/// Register the inbound channel SYNCHRONOUSLY (before run() is spawned) so the
/// first signal/route is buffered, never dropped by a spawn race. Returns the
/// receiver for run(); None if already initialised.
pub fn init_runtime() -> Option<mpsc::UnboundedReceiver<V2Event>> {
    let (tx, rx) = mpsc::unbounded_channel::<V2Event>();
    if V2_TX.set(tx).is_err() { return None; }
    Some(rx)
}

/// The single v2 consensus task. Owns the driver; verifies inbound, drives the
/// engine, executes effects, and runs a progress-gated view timer.
pub async fn run(
    node_id: String, mut committee: Vec<String>, genesis_hash: Hash,
    p2p: Arc<SimplifiedP2P>, storage: Arc<Storage>,
    mut rx: mpsc::UnboundedReceiver<V2Event>,
) {
    // committee rotates each epoch (N-2 VRF sample); kept here for verify_msg and
    // mirrored into the driver/engine via build_proposal.
    let mut driver = ConsensusDriver::new(node_id.clone(), committee.clone(), genesis_hash);
    // Reload what this node already voted for. Unreadable ⇒ do not run consensus: a replica that
    // cannot know its own commitments re-votes at a head it already voted at and is convicted for it.
    match storage.load_checkpoint_votes() {
        Ok(recs) => {
            let commits: Vec<crate::consensus_v2_driver::VoteCommitment> = recs.into_iter()
                .map(|r: (u64, u64, [u8; 32], bool, u64, [u8; 32])|
                    crate::consensus_v2_driver::VoteCommitment {
                        index: r.0, window_head: r.1, content_digest: r.2,
                        pinned: r.3, parent_index: r.4, parent_hash: r.5 })
                .collect();
            if !commits.is_empty() && crate::node::is_info() {
                println!("[INFO][BFT2] vote_commitments_restored count={}", commits.len());
            }
            driver.restore_vote_commitments(&commits);
        }
        Err(e) => {
            println!("[ERROR][BFT2] consensus_not_started reason=vote_commitments_unreadable err={}", e);
            return;
        }
    }
    // Consensus pacing — network-uniform const, NOT an operator env (per-node tuning desyncs
    // view-change timing and churns liveness). Change = rebuild the whole network.
    let timeout_ms: u64 = qnet_consensus::checkpoint_bft::VIEW_TIMEOUT_MS;
    let mut timer = tokio::time::interval(std::time::Duration::from_millis(timeout_ms));
    // Delay, not Skip: a pacemaker that DROPS beats lost while the loop was busy stops pacing
    // exactly when the loop is most loaded. Delay re-fires once, then re-phases.
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_index = driver.current_index();
    let mut last_committed = driver.committed_index(); // progress signal resetting the adaptive backoff
    let mut consec_timeouts: u32 = 0; // views timed out without a commit → grows the effective view timeout
    let mut ticks_stuck: u32 = 0;     // base ticks accumulated toward the next backed-off on_timeout
    let mut last_signaled: u64 = 0; // highest window index we hold data for (gates idle timeouts)
    let mut pending: Vec<Vec<u8>> = Vec::new(); // inbound ahead of our round; replayed as we advance
    const MAX_PENDING: usize = 256; // DoS bound on the replay buffer
    // Per-window proposal/seal inputs (bounded). The leader proposes the contiguous next
    // window from here at the current round — decoupling the window from a skippable round.
    let mut window_buf: std::collections::HashMap<u64, WindowContent> = std::collections::HashMap::new();
    const MAX_WINDOW_BUF: usize = 256;
    // R15 interlock: the buffer must span the frozen horizon in CHECKPOINT windows (macro window =
    // MACROBLOCK_INTERVAL/CHECKPOINT_INTERVAL = 3), with ≥2× headroom. A future horizon bump that
    // outgrows this fails the build here instead of silently dropping in-flight windows during a freeze.
    const _: () = assert!(
        MAX_WINDOW_BUF as u64 >= 2 * (crate::node::BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64)
            * (qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL / qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL),
        "MAX_WINDOW_BUF must cover 2x the frozen horizon in checkpoint windows");
    // LIVENESS WATCHDOG state: the consensus dropout that motivated this was SILENT (Docker
    // reported "healthy" while the driver was frozen). Track sustained lag of the driver behind
    // the applied chain tip and alarm LOUDLY once per episode — re-armed on recovery.
    // RECOVERY ARM state. `heard` is the signature-verified liveness view used by the halt test;
    // `last_certified_at` is the stall clock. Both are local and advisory — they gate only what this
    // node proposes/votes, never what is valid.
    let mut heard: std::collections::HashMap<String, std::time::Instant> = std::collections::HashMap::new();
    let mut last_certified_at = std::time::Instant::now();
    let mut rc_ticks: u32 = 0;
    let mut rc_last_index: u64 = 0;   // stagger resets when the pinned index moves
    let mut stuck_ticks: u32 = 0;
    let mut catchup_ticks: u32 = 0; // sustained ticks behind the quorum, gates the pull
    let mut committee_window: u64 = u64::MAX; // window `committee` was resolved for
    let mut stuck_alarmed = false;
    if crate::node::is_info() {
        println!("[INFO][BFT2] runtime_started committee={} view_timeout_ms={}", committee.len(), timeout_ms);
    }
    // Eager startup catch-up: if the chain already holds committed macroblocks (restart, or the chain
    // synced before this task spawned), adopt the latest checkpoint QC from storage NOW so the driver
    // starts at the live window instead of index=1 — closing the cold-start lag at its source rather
    // than waiting for the watchdog below to detect it reactively. driver.sync is monotonic +
    // content-checked, and the stored QC was verified at apply time, so a fresh first boot (no
    // macroblock yet) is a harmless no-op. The watchdog remains as the mid-run backstop.
    if let Ok(idx) = storage.get_latest_macroblock_index() {
        if idx > 0 {
            match stored_checkpoint_qc(&storage, idx) {
                Some((cp, qc)) => {
                    let effs = driver.sync(&cp, &qc);
                    if !effs.is_empty() {
                        if crate::node::is_info() {
                            println!("[INFO][BFT2] eager_startup_sync window={} next_window={}", idx, driver.next_window());
                        }
                        for w in execute(effs, &node_id, &p2p, &storage).await { driver.mark_sealed(w); }
                    }
                    last_index = driver.current_index();
                }
                None => {
                    if crate::node::is_warn() {
                        println!("[WARN][BFT2] startup_sync_skipped idx={} reason=checkpoint_qc_unreadable", idx);
                    }
                }
            }
        }
    }
    loop {
        tokio::select! {
            // Timer first and biased: under random selection a saturated inbound queue competes
            // with the view timer on this one task, which is the starvation the cert-verify
            // offload already exists to avoid. The pacemaker must never lose that race.
            biased;
            _ = timer.tick() => {
                // Adaptive view timeout (exponential backoff, reset on commit). A fixed view can't
                // gather 2f+1 when the real round-trip exceeds it (slow node) → perpetual view-changes,
                // no finality regardless of committee size. Grow the effective timeout 4→8→16→32→60s
                // until a view lasts long enough to reach quorum; reset on any commit. Safety is
                // timeout-independent (commit needs a same-round 2f+1 QC). Time out only a window we hold
                // data for and are committing; between windows the view idles - never time out then, and
                // never on a peer-reported height, which is a sync hint and not a chain fact. A node that
                // lost its window content is restored by the pull below: the bodies land, WindowEnd fires,
                // last_signaled rises and this guard opens on its own.
                let committed = driver.committed_index();
                if committed > last_committed {
                    last_committed = committed; consec_timeouts = 0; ticks_stuck = 0;
                    last_certified_at = std::time::Instant::now();
                }
                // ── RECOVERY ARM ────────────────────────────────────────────────────────────────
                {
                    let now = std::time::Instant::now();
                    let stall = std::time::Duration::from_secs(crate::node::RC_STALL_SECS);
                    heard.retain(|_, t| now.duration_since(*t) < stall);
                    let live: std::collections::HashSet<String> = heard.keys().cloned().collect();
                    crate::node::rc_publish_heard(live.clone());
                    // The committee `heard` is filtered to by verify_msg IS the arm's denominator and
                    // the set a relaxed certificate is checked over. Publish one view so the halt test
                    // and the operator RPC can never measure liveness over a different population.
                    crate::node::rc_publish_committee(committee.clone());
                    let operator_disarm = crate::node::rc_take_disarm_request();
                    match crate::node::rc_armed() {
                        Some((a, _, _)) => {
                            // The span ends by itself, on either edge: the first seal above A+2 means the
                            // strict threshold is reachable again, and the driver drops its own pin the
                            // moment the window it is about to propose leaves the span. Mirror that here
                            // or the global arm would keep relaxing the threshold for a span the driver
                            // has already left. An operator disarm lands on the same edge, so global and
                            // driver can never end up disagreeing.
                            let (_, span_hi) = qnet_consensus::checkpoint_bft::recovery_failover_windows(a);
                            if operator_disarm
                                || storage.last_sealed_mb_index() > span_hi
                                || !driver.rc_armed() {
                                crate::node::rc_disarm();
                                let _ = driver.set_recovery_span(None);
                                rc_ticks = 0;
                            } else {
                                // Stagger: rank 0 speaks on the first tick, rank r on tick r+1 (~4 s
                                // apart), so in practice the lowest-rank live member proposes alone.
                                //
                                // rc_ticks MUST reset when the pinned index moves. It used to reset only
                                // on arm/disarm, so after one slow index every armed member had
                                // rc_ticks > its own rank and they all self-granted on the SAME tick,
                                // splitting the vote across proposals that are individually short of
                                // the relaxed quorum — a wasted round on every index.
                                let idx_now = driver.current_index();
                                if idx_now != rc_last_index { rc_last_index = idx_now; rc_ticks = 0; }
                                rc_ticks = rc_ticks.saturating_add(1);
                                // And do not speak at all if this index already has something to vote
                                // on: a second proposal there can only split the very quorum we are
                                // trying to reach.
                                let quiet = !driver.has_proposal_at(idx_now);
                                let rank = driver.rc_propose_rank();
                                if quiet && rank != usize::MAX && rc_ticks as usize > rank {
                                    driver.rc_grant_propose();
                                }
                            }
                        }
                        None => {
                            // Global unarmed but the driver still pinned: an arm that the global side
                            // dropped (operator disarm, or a re-arm that now refuses) would otherwise
                            // leave the driver emitting pinned checkpoints nobody accepts for the rest
                            // of the span. Unconditional, so the two can never disagree.
                            if driver.rc_armed() {
                                let _ = driver.set_recovery_span(None);
                                rc_ticks = 0;
                                if crate::node::is_warn() {
                                    println!("[WARN][RC] driver_disarmed reason=global_unarmed");
                                }
                            }
                            // An operator disarm also suppresses the automatic re-arm for this tick;
                            // otherwise the halt conditions are unchanged and the disarm is a no-op the
                            // operator cannot see.
                            let operator_asked = crate::node::rc_take_arm_request();
                            if !operator_disarm
                                && (operator_asked || now.duration_since(last_certified_at) >= stall) {
                                if let Ok(rc) = crate::node::rc_try_arm(&storage, &live, true) {
                                    // The driver may refuse: the pinned position can be unreachable
                                    // from this node's view (it voted there already). Arming anyway
                                    // would emit checkpoints the pin rejects forever, which is worse
                                    // than staying halted — so undo the arm and report it.
                                    if !driver.set_recovery_span(Some(rc)) {
                                        crate::node::rc_disarm();
                                        if crate::node::is_warn() {
                                            println!("[WARN][RC] arm_rejected reason=pin_unreachable view={} anchor_mb={}",
                                                     driver.current_index(), rc.0);
                                        }
                                        // Do NOT skip the tick: the view timer, the catch-up pull, the
                                        // self-heal watchdog and the deferred-finalize re-emit all run
                                        // below, and this is precisely the tick that needs them.
                                    } else {
                                        rc_ticks = 0;
                                    }
                                    // Nothing to re-map: buffered span windows already hold the derived
                                    // committee, which is the set the pin is certified over.
                                }
                            }
                        }
                    }
                }
                // CATCH-UP PULL. Local retries cannot produce bytes this node never received, so a
                // missing window is repaired by asking, not by waiting. Both inputs are unforgeable
                // by <=f: own storage and the in-set median.
                let chain_now = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(Ordering::Relaxed);
                let pw = peer_window(&p2p, chain_now);
                let behind = is_behind_quorum(driver.next_window(), last_signaled, pw, CATCHUP_LAG_WINDOWS);
                if behind {
                    catchup_ticks = catchup_ticks.saturating_add(1);
                    if catchup_ticks >= CATCHUP_TICKS {
                        catchup_ticks = 0;
                        request_window_recovery(&storage, driver.next_window());
                        if crate::node::is_warn() {
                            println!("[WARN][BFT2] catchup_pull next_window={} last_signaled={} peer_window={} action=fetch",
                                     driver.next_window(), last_signaled, pw);
                        }
                    }
                } else {
                    catchup_ticks = 0;
                }
                V2_NEXT_WINDOW_HEAD.store(
                    driver.next_window()
                        .saturating_mul(qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL),
                    Ordering::Relaxed);
                let rejects = CONTENT_REJECTS.swap(0, Ordering::Relaxed);
                let vfails = VERIFY_FAILS.swap(0, Ordering::Relaxed);
                let shed = CERT_SHED.swap(0, Ordering::Relaxed);
                if (rejects > 1 || vfails > 0 || shed > 0) && crate::node::is_warn() {
                    println!("[WARN][BFT2] inbound_refused rejects={} verify_failed={} cert_shed={}",
                             rejects, vfails, shed);
                }
                // A window the driver could not assemble seal inputs for is skipped, not sealed.
                // Silent, it looks identical to a window nobody certified.
                if let Some(w) = driver.take_seal_skipped() {
                    if crate::node::is_warn() {
                        println!("[WARN][BFT2] seal_skipped window={} reason=seal_inputs_absent", w);
                    }
                }
                if driver.current_index() == last_index && driver.next_window() <= last_signaled {
                    ticks_stuck = ticks_stuck.saturating_add(1);
                    let need = (1u32 << consec_timeouts.min(4)).min(15); // base ticks: 4,8,16,32,60s
                    if ticks_stuck >= need {
                        let effects = driver.on_timeout();
                        for w in execute(effects, &node_id, &p2p, &storage).await { driver.mark_sealed(w); }
                        consec_timeouts = consec_timeouts.saturating_add(1);
                        ticks_stuck = 0;
                    }
                } else {
                    ticks_stuck = 0;
                }
                last_index = driver.current_index();
                // LIVENESS WATCHDOG + SELF-HEAL: the applied chain tip advances via macroblock sync even
                // when the driver is frozen — so a large, sustained gap between the chain's window and the
                // window the driver still wants to commit means the driver fell behind the live quorum.
                // Live §4.5 catch-up only fires on a freshly RECEIVED macroblock, so a node that caught its
                // chain up by other means (or lagged at cold start) can stay stuck. Instead of only logging,
                // re-feed the latest stored (already-verified) macroblock QC to the driver: driver.sync is
                // monotonic + content-checked ⇒ a safe no-op once caught up, and it jumps the driver to the
                // committed window deterministically. Recovery is logged once the gap closes.
                const STUCK_WINDOWS: u64 = 3;   // beyond normal 2-chain finality lag
                const STUCK_TICKS: u32 = 5;     // sustained (~20s at the 4s view timer) before acting
                // CP units (head/CHECKPOINT_INTERVAL), matching driver.next_window() — a /90 MACRO
                // count here vs a /K window index never tripped the guard (it was dead).
                let chain_window = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(Ordering::Relaxed)
                    / qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL;
                // A node whose chain is stuck too never opens a local gap, so the local term alone is
                // blind to the very case this watchdog exists for. Same in-set median as the pull.
                let observed_window = chain_window.max(pw);
                if observed_window > driver.next_window().saturating_add(STUCK_WINDOWS) {
                    stuck_ticks = stuck_ticks.saturating_add(1);
                    if stuck_ticks >= STUCK_TICKS {
                        // Self-heal from local committed state: adopt the latest stored macroblock's QC.
                        if let Ok(idx) = storage.get_latest_macroblock_index() {
                            match stored_checkpoint_qc(&storage, idx) {
                                Some((cp, qc)) => {
                                    let effs = driver.sync(&cp, &qc);
                                    if !effs.is_empty() { for w in execute(effs, &node_id, &p2p, &storage).await { driver.mark_sealed(w); } }
                                }
                                None => {
                                    if crate::node::is_warn() {
                                        println!("[WARN][BFT2] selfheal_no_stored_qc idx={}", idx);
                                    }
                                }
                            }
                        }
                        stuck_ticks = 0; // re-accumulate before another attempt
                        if !stuck_alarmed {
                            stuck_alarmed = true;
                            println!("[WARN][BFT2] consensus_driver_behind round={} next_window={} chain_window={} peer_window={} — self-healing from latest stored macroblock QC",
                                     driver.current_index(), driver.next_window(), chain_window, pw);
                        }
                    }
                } else {
                    if stuck_alarmed {
                        println!("[INFO][BFT2] consensus_driver_recovered next_window={} chain_window={} peer_window={}",
                                 driver.next_window(), chain_window, pw);
                    }
                    stuck_ticks = 0;
                    stuck_alarmed = false;
                }
                // v34 (P1-E): re-emit a deferred finalize. The engine's Action::Commit is ONE-SHOT
                // and Effect::Finalize defers when the local microblock tip was below the window head
                // at commit time — so finality could stick behind the committed window until the NEXT
                // window commits (slow / never if production then gates on the lagging finality). Re-
                // attempt every tick while the committed head is ahead of finality. try_advance_finality
                // is monotonic + guarded (chain_h ≥ head, state match) ⇒ a no-op once caught up and it
                // NEVER advances finality past the applied tip.
                if let Some((head, sr, mbh)) = driver.committed_finalize() {
                    if head > crate::node::LAST_FINALIZED_HEIGHT.load(Ordering::Acquire) {
                        let idx = driver.committed_index();
                        for w in execute(vec![Effect::Finalize { index: idx, head_height: head, state_root: sr, mb_hashes: mbh }], &node_id, &p2p, &storage).await { driver.mark_sealed(w); }
                    }
                }
            }
            Some(ev) = rx.recv() => {
                // Release the inbound-backpressure reservation (taken in route_inbound) as soon
                // as a PEER message leaves the queue. Control events are not counted → never gated.
                if let V2Event::Inbound(ref d) = ev {
                    V2_INBOUND_BYTES.fetch_sub(d.len(), Ordering::AcqRel);
                }
                let effects = match ev {
                    V2Event::Inbound(data) => match bincode::deserialize::<ConsensusMsg>(&data) {
                        Ok(msg) => {
                            // Adopt the in-flight window's committee (QC/TC verify + leader/quorum).
                            refresh_committee(&mut committee, &mut committee_window, &mut driver, &storage, &window_buf);
                            // Buffer until we hold that committee, or for a round ahead of us (rounds
                            // skip on timeout) — replayed as we advance. Bounded against DoS.
                            // Gate on MEMBERSHIP: unknown committee means we cannot authenticate anything.
                            // Holding the window's bodies is a separate question, decided by check_content.
                            if committee.is_empty() || msg_index(&msg) > driver.current_index() {
                                // Future-round / pre-committee inbound: buffer for replay — PRE-authentication
                                // (a cert sig can't be checked inline), so this is the UNAUTHENTICATED class:
                                // half-caps in buffer_pending + the view horizon here (an attacker-chosen far-
                                // future index would otherwise squat its slot forever — audit F1). Over any
                                // bound ⇒ drop (re-gossiped later; the buffer is best-effort).
                                if msg_index(&msg) <= driver.current_index().saturating_add(V2_PENDING_VIEW_HORIZON) {
                                    buffer_pending(&mut pending, MAX_PENDING, data, false);
                                }
                                Vec::new()
                            } else if matches!(&msg, ConsensusMsg::Qc(_) | ConsensusMsg::Tc(_)) {
                                // Certs carry O(committee) ML-DSA signatures. NEVER verify them inline: this
                                // select shares the view-change timer branch, so a 1000-committee verify here
                                // would starve timeouts + every other event (finality stall at scale). Dispatch
                                // the verify to a bounded blocking worker; on success it re-injects
                                // V2Event::CertVerified so the loop applies it without the expensive re-verify.
                                dispatch_cert_verify(data, &p2p, &committee, driver.current_index());
                                Vec::new()
                            } else if verify_msg(&p2p, &committee, &msg) {
                                // Signature-verified ⇒ this member is demonstrably alive. Recording it
                                // only AFTER the verify is what makes the halt test unspoofable.
                                if let Some(sender) = msg_sender(&msg) {
                                    heard.insert(sender.to_string(), std::time::Instant::now());
                                }
                                // Single-sig (Proposal/Vote/Timeout): the verify is cheap ⇒ inline is fine.
                                process_authenticated(&msg, &mut driver, &storage, &window_buf, &p2p, &mut committee, &mut pending, MAX_PENDING, &mut heard)
                            } else {
                                VERIFY_FAILS.fetch_add(1, Ordering::Relaxed);
                                Vec::new()
                            }
                        }
                        Err(_) => Vec::new(),
                    },
                    V2Event::CertVerified(data) => {
                        // A checkpoint cert (Qc/Tc) whose O(committee) signature dispatch_cert_verify already
                        // verified OFF this loop. Trusted (only that worker emits this variant; external peers
                        // reach us only via route_inbound → Inbound). Apply as authenticated — NO re-verify.
                        // Adopt the in-flight committee (as the Inbound path does) before processing.
                        match bincode::deserialize::<ConsensusMsg>(&data) {
                            Ok(msg) => {
                                refresh_committee(&mut committee, &mut committee_window, &mut driver, &storage, &window_buf);
                                process_authenticated(&msg, &mut driver, &storage, &window_buf, &p2p, &mut committee, &mut pending, MAX_PENDING, &mut heard)
                            }
                            Err(_) => Vec::new(),
                        }
                    }
                    V2Event::WindowEnd { index, head_height, mb_hashes, state_root, beacon, committee: cmt, eligible_producers, banned, reward_root, registry_root, dilithium_pk_root, reward_epoch_root, logs_root, total_supply } => {
                        // Buffer this window's content (head microblock's real timestamp rides in
                        // the QC-agreed checkpoint). Then propose the contiguous next window if we
                        // lead, and replay buffered inbound.
                        let mut return_empty = false;
                        // The head body carries the timestamp the checkpoint is signed over. Unreadable
                        // means we do NOT hold this window: a zero timestamp would publish a checkpoint no
                        // peer reproduces, and claiming the window in last_signaled would tell the view
                        // timer we hold content we cannot read. Defer - a later event retries the boundary.
                        let head_ts = match storage.load_microblock_auto_format(head_height).ok().flatten() {
                            Some(m) => m.timestamp,
                            None => {
                                if crate::node::is_warn() {
                                    println!("[WARN][BFT2] window_end_deferred win={} head={} reason=head_body_unreadable",
                                             index, head_height);
                                }
                                return_empty = true;
                                0
                            }
                        };
                        if return_empty { Vec::new() } else {
                        last_signaled = last_signaled.max(index);
                        // No span override: a pinned window is proposed, content-checked and certified
                        // over the SAME derived committee as a strict one — the pin moves the threshold,
                        // never the signing set, so all three views agree by construction.
                        committee_window = u64::MAX; // re-resolve from the freshly derived window
                        window_buf.insert(index, WindowContent {
                            mb_hashes, state_root, beacon, head_ts, committee: cmt, eligible: eligible_producers, banned, reward_root, registry_root, dilithium_pk_root, reward_epoch_root, logs_root, total_supply,
                        });
                        if window_buf.len() > MAX_WINDOW_BUF {
                            // NEVER evict the IN-FLIGHT window (audit F4): during a finality wedge
                            // production keeps signalling new windows; evicting by min-key alone put a
                            // ~256-window (~2h) TTL on the contested window's snapshot, after which
                            // drain/try_propose/check_content all dead-end (Defer) forever. Stale
                            // (< next_window) evicts first; else shed the FARTHEST future snapshot.
                            let nw = driver.next_window();
                            let victim = window_buf.keys().copied().filter(|k| *k < nw).min()
                                .or_else(|| window_buf.keys().copied().filter(|k| *k != nw).max());
                            if let Some(v) = victim { window_buf.remove(&v); }
                        }
                        let mut effs = try_propose(&mut driver, &window_buf, &storage, &mut committee);
                        effs.extend(drain_pending(&mut driver, &window_buf, &storage, &p2p, &committee, &mut pending, MAX_PENDING, &mut heard));
                        effs
                        }
                    }
                    V2Event::Synced(cp_qc) => {
                        // Safety-net catch-up (§4.5): the apply path verified this checkpoint QC against
                        // the correct epoch committee, so fast-forward the driver from committed state —
                        // for a node so far behind that live gossip for its stale round never arrives
                        // (e.g. it was offline). Monotonic (adopt_qc) ⇒ a no-op once caught up. On a real
                        // advance, re-adopt committee, propose if we now lead, and replay buffered inbound.
                        match bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint, QuorumCertificate)>(&cp_qc) {
                            Ok((cp, qc)) => {
                                let mut effs = driver.sync(&cp, &qc);
                                if !effs.is_empty() {
                                    refresh_committee(&mut committee, &mut committee_window, &mut driver, &storage, &window_buf);
                                    effs.extend(try_propose(&mut driver, &window_buf, &storage, &mut committee));
                                    effs.extend(drain_pending(&mut driver, &window_buf, &storage, &p2p, &committee, &mut pending, MAX_PENDING, &mut heard));
                                }
                                effs
                            }
                            Err(_) => Vec::new(),
                        }
                    }
                };
                for w in execute(effects, &node_id, &p2p, &storage).await { driver.mark_sealed(w); }
                last_index = driver.current_index();
            }
        }
    }
}

#[cfg(test)]
mod finality_tests {
    use super::*;
    fn h(n: u8) -> Hash { [n; 32] }

    // Regression: an intra-window checkpoint (head not on a /macro_interval boundary) MUST finalize on
    // head+state_root ALONE. The old macroblock-coupled check (window=head/90 + macroblock body) deferred
    // every intra-checkpoint forever, froze the finality marker, and wedged the chain (the h~2221 freeze).
    #[test]
    fn checkpoint_finalizable_intra_window_needs_no_macroblock() {
        // intra-window head 120 (120 % 90 != 0): finalize when our tip reached the head + state matches
        assert!(checkpoint_finalizable(120, 120, Some(h(7)), h(7)));
        assert!(checkpoint_finalizable(250, 120, Some(h(7)), h(7))); // tip well ahead — fine
        // a macroblock-boundary head (180) finalizes the SAME way — no special-case, no macroblock needed
        assert!(checkpoint_finalizable(180, 180, Some(h(9)), h(9)));
        // tip not yet at the head ⇒ defer (transient, the timer re-emits; NOT a permanent wedge)
        assert!(!checkpoint_finalizable(119, 120, Some(h(7)), h(7)));
        // fail-stop: our locally-applied state diverges from the QC'd root ⇒ NEVER finalize
        assert!(!checkpoint_finalizable(120, 120, Some(h(8)), h(7)));
        // local head microblock missing ⇒ can't confirm ⇒ defer
        assert!(!checkpoint_finalizable(120, 120, None, h(7)));
        // head==0 placeholder (a committed index whose checkpoint we don't hold) ⇒ NEVER finalize
        assert!(!checkpoint_finalizable(10_000, 0, Some(h(0)), h(0)));
    }
}

#[cfg(test)]
mod content_gate_tests {
    use super::*;
    use qnet_consensus::checkpoint_bft::Checkpoint;

    fn mk_block(h: u64, producer: &str, tr: u64, sr: [u8; 32], vrf: [u8; 32]) -> qnet_state::MicroBlock {
        let mut mb = qnet_state::MicroBlock::new(h, 1000 + h, [0u8; 32], vec![], producer.to_string());
        mb.timeout_round = tr; mb.state_root = sr; mb.vrf_output = Some(vrf);
        mb
    }

    // Persist one window's canonical bodies over `win` blocks; return (hashes, beacon) as THIS node
    // holds them. win = CHECKPOINT_INTERVAL for an intra checkpoint, the full macroblock for a boundary.
    fn seed_window(storage: &Storage, head: u64, win: u64, producer: &str, tr: u64, sr: [u8; 32]) -> (Vec<[u8; 32]>, [u8; 32]) {
        let mut hashes: Vec<[u8; 32]> = Vec::new();
        // Chain the bodies: storage enforces parent linkage, so a window of unlinked blocks is not
        // a state the node can ever hold.
        let mut parent = storage.load_microblock_auto_format(head - win).ok().flatten().map(|p| p.hash())
            .unwrap_or([0u8; 32]);
        for h in (head - (win - 1))..=head {
            let mut v = [0u8; 32]; v[0] = (h & 0xff) as u8; v[1] = ((h >> 8) & 0xff) as u8;
            let mut mb = mk_block(h, producer, tr, sr, v);
            mb.previous_hash = parent;
            parent = mb.hash();
            hashes.push(mb.hash());
            storage.save_microblock(h, &bincode::serialize(&mb).unwrap()).unwrap();
        }
        // The beacon folds the window's BLOCK HASHES, mirroring accumulate_beacon's live callers.
        let beacon = qnet_consensus::checkpoint_bft::accumulate_beacon(&hashes);
        (hashes, beacon)
    }

    fn wc(hashes: Vec<[u8; 32]>, sr: [u8; 32], beacon: [u8; 32]) -> WindowContent {
        WindowContent { mb_hashes: hashes, state_root: sr, beacon, head_ts: 0, committee: vec![],
            eligible: vec![], banned: vec![], reward_root: [0u8; 32], registry_root: [0u8; 32], dilithium_pk_root: [0u8; 32],
            reward_epoch_root: [0u8; 32], logs_root: [0u8; 32], total_supply: 0 }
    }

    fn cp(head: u64, hashes: Vec<[u8; 32]>, sr: [u8; 32], beacon: [u8; 32]) -> Checkpoint {
        Checkpoint { index: head / qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL, parent_qc: None,
            window_head_height: head, window_mb_hashes: hashes, state_root: sr, beacon,
            epoch_commitment: qnet_consensus::checkpoint_bft::epoch_commitment(&[], &[], &[]),
            reward_root: [0u8; 32], registry_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32], logs_root: [0u8; 32], total_supply: 0,
            timestamp: 0, proposer: "p".to_string(), proposer_sig: vec![], recovery_anchor: None }
    }

    // The boundary-failover unfreeze: state agrees ⇒ a divergent tail hash reconciles (not fail-stop);
    // a real state divergence still fail-stops; the happy path votes; no local window ⇒ can't reproduce.
    #[test]
    fn tail_reconcile_classifies_ok_diverged_reject() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();
        let k = qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL;
        let head = k; // window index 1, heights 1..=k
        let start = head - (k - 1);
        let sr = [9u8; 32];
        let (local, beacon) = seed_window(&storage, head, k, "loser", 1, sr);

        let mut buf = std::collections::HashMap::new();
        buf.insert(head / k, wc(local.clone(), sr, beacon));

        // Ok: proposer's tail reproduces our canonical bodies exactly ⇒ vote.
        let ok = ConsensusMsg::Proposal(cp(head, local.clone(), sr, beacon));
        assert!(matches!(check_content(&storage, &buf, &ok), ContentCheck::Ok));

        // TailDiverged: state_root agrees, one tail hash differs (we still hold the loser at that
        // height) ⇒ that height is returned for reconcile, NOT fail-stop.
        let mut div = local.clone(); div[2] = [0xEEu8; 32];
        match check_content(&storage, &buf, &ConsensusMsg::Proposal(cp(head, div, sr, beacon))) {
            ContentCheck::TailDiverged(hs) => assert!(hs.contains(&(start + 2))),
            _ => panic!("expected TailDiverged"),
        }

        // Reject: state_root diverges ⇒ genuine divergence, never reconcile.
        assert!(matches!(
            check_content(&storage, &buf, &ConsensusMsg::Proposal(cp(head, local.clone(), [7u8; 32], beacon))),
            ContentCheck::Reject(_)));

        // Defer (NOT Reject): no local window snapshot ⇒ not caught up yet ⇒ buffer + retry, never fail-stop.
        let empty: std::collections::HashMap<u64, WindowContent> = std::collections::HashMap::new();
        assert!(matches!(check_content(&storage, &empty, &ok), ContentCheck::Defer));
    }

    // PROPOSE-AND-ADOPT at the real gate (node-layer half of the driver wedge harness): a proposal
    // whose tail diverges at one height (leader's failover-round winner vs our losing variant, state
    // identical) classifies TailDiverged; once the certified-canonical body lands (repair ⇒ fork-choice
    // supersede), the SAME proposal re-gates Ok — hashes AND beacon reproduced from real bodies — so the
    // buffered replay votes. A forged tail whose body never materializes can never re-gate Ok (no blind
    // adopt), and a forged beacon over real bodies still Rejects.
    #[test]
    fn tail_diverged_regates_ok_after_canonical_body_lands() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();
        let k = qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL;
        let head = k;
        let start = head - (k - 1);
        let sr = [9u8; 32];
        let (local, _) = seed_window(&storage, head, k, "loser", 1, sr);
        let mut buf = std::collections::HashMap::new();
        buf.insert(head / k, wc(local.clone(), sr, [0u8; 32]));

        // The leader's canonical tail: identical except height start+2 = the failover winner
        // (higher timeout_round + its own VRF ⇒ different hash, SAME state_root).
        let mut winner_vrf = [0u8; 32]; winner_vrf[0] = 0xAB;
        let mut winner = mk_block(start + 2, "winner", 2, sr, winner_vrf);
        // The winner replaces the loser at the SAME position, so it links to the same parent —
        // storage rejects any other linkage.
        winner.previous_hash = storage.load_microblock_auto_format(start + 1).unwrap().unwrap().hash();
        let mut canon = local.clone();
        canon[2] = winner.hash();
        // The beacon folds the CANONICAL tail hashes — the winner's hash replaces the loser's.
        let canon_beacon = qnet_consensus::checkpoint_bft::accumulate_beacon(&canon);
        let proposal = ConsensusMsg::Proposal(cp(head, canon.clone(), sr, canon_beacon));

        // Before the canonical body lands: TailDiverged at exactly the contested height — never a vote.
        match check_content(&storage, &buf, &proposal) {
            ContentCheck::TailDiverged(hs) => assert_eq!(hs, vec![start + 2]),
            _ => panic!("expected TailDiverged before the canonical body lands"),
        }

        // Repair lands ⇒ fork-choice supersede (round_supersede → v33 rollback deletes the losing
        // variant, the certified winner re-syncs in). Direct save would trip the equivocation guard —
        // exactly the invariant that makes blind adopt impossible; simulate the reorg's delete+save.
        storage.delete_microblock(start + 2).unwrap();
        storage.save_microblock(start + 2, &bincode::serialize(&winner).unwrap()).unwrap();

        // The SAME proposal now re-gates Ok (tail + beacon reproduced from real bodies) ⇒ replay votes.
        assert!(matches!(check_content(&storage, &buf, &proposal), ContentCheck::Ok));

        // Forged beacon over the same real bodies must still fail-stop, not adopt.
        let forged = ConsensusMsg::Proposal(cp(head, canon, sr, [0xEEu8; 32]));
        assert!(matches!(check_content(&storage, &buf, &forged), ContentCheck::Reject(_)));
    }

    // Adopt-buffer invariants: ONE candidate slot per (ROUND, proposer) — cp.index IS the view, so
    // this slot stops a signer re-flooding same-round variants (each replaced, not accumulated);
    // post-TC re-proposals are a NEW round/slot and the stale round is pruned by drain's dead-round
    // arm instead. Distinct proposers keep distinct slots; exact re-gossip duplicates are dropped;
    // the unauthenticated class (pre-sig future-round pushes) may fill only HALF the count cap, so
    // junk can never starve the authenticated adopt-candidate slots (audit F1).
    #[test]
    fn adopt_buffer_one_slot_per_proposer() {
        let mk = |round: u64, proposer: &str, ts: u64| {
            let mut c = cp(qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL,
                           vec![[1u8; 32]], [9u8; 32], [0u8; 32]);
            c.index = round;
            c.proposer = proposer.to_string();
            c.timestamp = ts;
            ConsensusMsg::Proposal(c)
        };
        let ser = |m: &ConsensusMsg| bincode::serialize(m).unwrap();
        let mut pending: Vec<Vec<u8>> = Vec::new();

        // First candidate from p1 buffers (authenticated class = full caps).
        buffer_pending(&mut pending, 256, ser(&mk(1, "p1", 0)), true);
        assert_eq!(pending.len(), 1);

        // p1's SAME-ROUND variant (equivocation: different bytes, same round+signer) REPLACES the
        // previous candidate — an equivocator holds exactly one slot, never accumulates.
        let v2 = mk(1, "p1", 1);
        evict_superseded_proposal(&mut pending, 1, "p1");
        buffer_pending(&mut pending, 256, ser(&v2), true);
        assert_eq!(pending.len(), 1, "same (round, proposer) must hold exactly one slot");
        assert_eq!(pending[0], ser(&v2), "the LATEST variant must win the slot");

        // A different proposer for the same round gets its own slot.
        evict_superseded_proposal(&mut pending, 1, "p2");
        buffer_pending(&mut pending, 256, ser(&mk(1, "p2", 0)), true);
        assert_eq!(pending.len(), 2);

        // Exact re-gossip duplicate is dropped by buffer_pending itself.
        buffer_pending(&mut pending, 256, ser(&v2), true);
        assert_eq!(pending.len(), 2);

        // Authenticated count cap enforced at the sole push site.
        buffer_pending(&mut pending, 2, ser(&mk(2, "p3", 0)), true);
        assert_eq!(pending.len(), 2, "count cap must reject the push");

        // Unauthenticated class is capped at HALF: with 2 entries and max=4 (4/2=2), junk is refused
        // while an authenticated push still lands — the adopt path can never be starved by a flood.
        buffer_pending(&mut pending, 4, ser(&mk(3, "junk", 0)), false);
        assert_eq!(pending.len(), 2, "unauthenticated class must be refused past max/2");
        buffer_pending(&mut pending, 4, ser(&mk(3, "p4", 0)), true);
        assert_eq!(pending.len(), 3, "authenticated push must still land in the reserved half");
    }

    // REGRESSION (workflow SURV-1): the macroblock-boundary checkpoint covers the FULL macroblock
    // window (head = MACROBLOCK_INTERVAL·mb_idx, > CHECKPOINT_INTERVAL hashes), NOT a 30-block
    // sub-window. A fixed-k window model would Reject it outright and wedge finality at height 90.
    // check_content must take the span from OUR snapshot (c.mb_hashes.len()), so both sizes pass.
    #[test]
    fn boundary_full_macroblock_window_passes() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();
        let k = qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL;
        let win = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL; // full 90-block boundary window
        let head = win; // first macroblock boundary, heights 1..=90, checkpoint index 90/30 = 3
        let sr = [5u8; 32];
        let (local, beacon) = seed_window(&storage, head, win, "p", 0, sr);
        assert_eq!(local.len() as u64, win); // proves the window is wider than CHECKPOINT_INTERVAL
        let mut buf = std::collections::HashMap::new();
        buf.insert(head / k, wc(local.clone(), sr, beacon));
        // A 90-hash boundary checkpoint must pass the content gate (would Reject under a fixed-30 model).
        assert!(matches!(
            check_content(&storage, &buf, &ConsensusMsg::Proposal(cp(head, local.clone(), sr, beacon))),
            ContentCheck::Ok));
        // Wrong window size (proposer sends 30 where our honest snapshot is 90) ⇒ genuine divergence.
        let short: Vec<[u8; 32]> = local[..k as usize].to_vec();
        assert!(matches!(
            check_content(&storage, &buf, &ConsensusMsg::Proposal(cp(head, short, sr, beacon))),
            ContentCheck::Reject(_)));
    }

    // ── SEAL-PATH PIN SELF-CHECK ─────────────────────────────────────────────────────────────────

    /// Store anchor macroblock `a` at a boundary head with an `n`-member committee; return its hash.
    async fn seal_anchor(storage: &Storage, a: u64, n: usize) -> ([u8; 32], Checkpoint) {
        use qnet_consensus::checkpoint_bft::sig_merkle_root;
        let committee: Vec<String> = (0..n).map(|i| format!("cs_{:04}", i)).collect();
        let mut cp_a = cp(a * qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL, vec![], [1u8; 32], [2u8; 32]);
        cp_a.index = 17;
        let sigs: Vec<Vec<u8>> = committee.iter().map(|s| s.as_bytes().to_vec()).collect();
        let qc = QuorumCertificate {
            checkpoint_hash: cp_a.hash(), index: cp_a.index,
            sig_merkle_root: sig_merkle_root(&sigs), signers: committee.clone(), sigs,
        };
        let mut cd = qnet_state::ConsensusData::default();
        cd.checkpoint_qc = Some(bincode::serialize(&(cp_a.clone(), qc)).unwrap());
        cd.consensus_committee = Some(committee);
        let mb = qnet_state::MacroBlock::new(a, 0, [0u8; 32], vec![], [1u8; 32], cd);
        storage.save_macroblock(a, &mb).await.expect("save anchor");
        // The pin names its anchor by the anchor CHECKPOINT's content digest, not by the block hash.
        (qnet_consensus::checkpoint_bft::checkpoint_content_digest(&cp_a), cp_a)
    }

    fn qc_over(cp: &Checkpoint, signers: &[String]) -> QuorumCertificate {
        let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
        QuorumCertificate {
            checkpoint_hash: cp.hash(), index: cp.index,
            sig_merkle_root: qnet_consensus::checkpoint_bft::sig_merkle_root(&sigs),
            signers: signers.to_vec(), sigs,
        }
    }

    // THE SHIPPED STATE. Behaviour, not text: the content gate must accept a pinned proposal exactly
    // as it accepts an unpinned one (the pin changes the threshold, not the content), and the seal
    // gate must re-prove the threshold for BOTH — relaxed only for a certificate whose pin RESOLVES
    // against committed data, strict for everything else, including an unresolvable pin.
    #[tokio::test]
    async fn every_seal_re_proves_its_own_threshold() {
        use qnet_consensus::checkpoint_bft::{quorum_size, relaxed_quorum};
        // Shipped OFF: a pin resolves to no relaxation, so every seal proves the strict threshold.
        assert!(!crate::node::RC_ENABLED);

        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();
        let (a, n) = (4u64, 12usize);
        let (ah, cp_a) = seal_anchor(&storage, a, n).await;
        let cs: Vec<String> = (0..n).map(|i| format!("cs_{:04}", i)).collect();

        // VOTE PATH: the pin is not a content change, so a pinned proposal content-checks like any
        // other. Whether this node will SIGN it is the engine's business — it signs only the pin it
        // armed — never the content gate's.
        let k = qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL;
        let head = 2 * k;
        let sr = [5u8; 32];
        let (local, beacon) = seed_window(&storage, head, k, "p", 0, sr);
        let mut buf = std::collections::HashMap::new();
        buf.insert(head / k, wc(local.clone(), sr, beacon));
        let plain_cp = cp(head, local.clone(), sr, beacon);
        assert!(matches!(check_content(&storage, &buf, &ConsensusMsg::Proposal(plain_cp.clone())),
                         ContentCheck::Ok));
        // A pinned proposal is refused outright while the relaxation is off, so no node signs a
        // checkpoint the acceptance path would then reject for everyone.
        let mut pinned_cp = plain_cp.clone();
        pinned_cp.recovery_anchor = Some((a, ah));
        assert!(matches!(check_content(&storage, &buf, &ConsensusMsg::Proposal(pinned_cp)),
                         ContentCheck::Reject(_)), "a pin is refused while the relaxation is off");
        let mut forged = plain_cp.clone();
        forged.state_root = [0xAB; 32];
        assert!(matches!(check_content(&storage, &buf, &ConsensusMsg::Proposal(forged)),
                         ContentCheck::Reject(_)));

        // SEAL PATH, pinned: refused before the resolver is consulted, at any signer count.
        let mut span = cp(qnet_consensus::checkpoint_bft::recovery_window_head(cp_a.window_head_height, 3),
                          vec![], [4u8; 32], [5u8; 32]);
        span.index = cp_a.index + 3;
        span.parent_qc = Some(qnet_consensus::checkpoint_bft::QcRef {
            index: span.index - 1, checkpoint_hash: [0xEE; 32] });
        span.recovery_anchor = Some((a, ah));
        assert!(relaxed_quorum(n) < quorum_size(n), "the relaxed bar would be lower if it were live");
        assert_eq!(rc_seal_ok(&storage, &span, &qc_over(&span, &cs[..relaxed_quorum(n)]), &cs)
                       .unwrap_err().0, "rc_disabled");
        assert_eq!(rc_seal_ok(&storage, &span, &qc_over(&span, &cs), &cs).unwrap_err().0, "rc_disabled");

        // ...and an UNPINNED certificate is not waved through: the seal gate re-proves the STRICT
        // threshold, which is what stops a gossiped sub-quorum QC from being written locally.
        let full = qc_over(&plain_cp, &cs);
        assert!(rc_seal_ok(&storage, &plain_cp, &full, &cs).is_ok());
        let thin = qc_over(&plain_cp, &cs[..quorum_size(n) - 1]);
        assert_eq!(rc_seal_ok(&storage, &plain_cp, &thin, &cs).unwrap_err().0, "rc_qc_rejected");
        let relaxed_unpinned = qc_over(&plain_cp, &cs[..relaxed_quorum(n)]);
        assert_eq!(rc_seal_ok(&storage, &plain_cp, &relaxed_unpinned, &cs).unwrap_err().0, "rc_qc_rejected");
        let mut outsider: Vec<String> = cs[..quorum_size(n) - 1].to_vec();
        outsider.push("not_a_member".into());
        assert_eq!(rc_seal_ok(&storage, &plain_cp, &qc_over(&plain_cp, &outsider), &cs).unwrap_err().0,
                   "rc_qc_rejected");
        // The certificate must bind THIS checkpoint, pinned or not.
        let mut unbound = full.clone();
        unbound.checkpoint_hash = [0x77; 32];
        assert_eq!(rc_seal_ok(&storage, &plain_cp, &unbound, &cs).unwrap_err().0, "rc_qc_unbound");
    }
}

#[cfg(test)]
mod catchup_tests {
    use super::is_behind_quorum;

    use super::peer_window_from;

    const K: u64 = 30;
    const HORIZON: u64 = 32 * 90;

    // Below the corroboration floor the hint says nothing. A node that cannot see the quorum must
    // never conclude anything about where the quorum is.
    #[test]
    fn the_height_hint_needs_four_witnesses() {
        assert_eq!(peer_window_from(vec![900, 900, 900], 900), 0, "three witnesses is below the floor");
        assert!(peer_window_from(vec![900, 900, 900, 900], 900) > 0, "four witnesses is enough");
    }

    // f liars claiming the maximum cannot move the (f+1)-th highest off the honest value. This is
    // the property a fixed small-k statistic does NOT have.
    #[test]
    fn liars_cannot_move_the_height_hint() {
        let honest = vec![9_000u64; 9];
        let mut poisoned = honest.clone();
        poisoned.extend([u64::MAX, u64::MAX, u64::MAX]); // f = (12-1)/3 = 3
        assert_eq!(peer_window_from(poisoned, 9_000), 9_000 / K,
                   "three liars among twelve must not move the hint");
        assert_eq!(peer_window_from(honest, 9_000), 9_000 / K);
    }

    // Nothing is derivable past the roster horizon, so an inflated claim must not become an inflated
    // conclusion even when every witness repeats it.
    #[test]
    fn a_wild_claim_is_clamped_to_the_horizon() {
        let tip = 9_000u64;
        assert_eq!(peer_window_from(vec![u64::MAX; 8], tip), (tip + HORIZON) / K);
    }

    // Idle between windows and stuck are locally identical, and timing out while idle burns views
    // for nothing. The quorum being past the finality band is what makes it a fault.
    #[test]
    fn idle_between_windows_is_not_behind() {
        assert!(!is_behind_quorum(10, 9, 11, 3), "tip one window ahead is normal production");
        assert!(!is_behind_quorum(10, 9, 13, 3), "2-chain finality lag must stay inside the band");
        assert!(!is_behind_quorum(10, 10, 99, 3), "holding the window is never behind, however far the quorum ran");
    }

    #[test]
    fn missing_window_with_the_quorum_ahead_is_behind() {
        assert!(is_behind_quorum(10, 9, 14, 3), "quorum past the band while we hold no data");
    }

    // No fresh in-set peer => peer_window 0. A node that cannot see the quorum must not conclude it
    // is behind, or an isolated node would pull and rotate views forever.
    #[test]
    fn no_peer_evidence_is_never_behind() {
        assert!(!is_behind_quorum(10, 9, 0, 3));
    }
}

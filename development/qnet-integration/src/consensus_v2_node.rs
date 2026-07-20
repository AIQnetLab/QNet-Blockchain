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
    let permit = match CERT_VERIFY_SEM.try_acquire() { Ok(p) => p, Err(_) => return }; // over-concurrency ⇒ drop
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
) -> Vec<Effect> {
    // ACCOUNTABLE SAFETY (pure side effect): cache authentic checkpoints + detect a committee member
    // signing two DIFFERENT checkpoints at the SAME round → sound on-chain vote-equivocation evidence.
    match msg {
        ConsensusMsg::Proposal(cp) => crate::node::observe_checkpoint_proposal(
            cp.index, cp.hash(), bincode::serialize(cp).unwrap_or_default()),
        ConsensusMsg::Vote(v) => crate::node::observe_checkpoint_vote(
            v.index, &v.voter, v.checkpoint_hash, v.signature.clone()),
        _ => {}
    }
    // Independent content re-derivation before we sign — single source of truth (check_content),
    // shared with drain_pending so buffered replay applies the same gate.
    match check_content(storage, window_buf, msg) {
        ContentCheck::Ok => {
            let mut effs = driver.handle(msg);
            effs.extend(try_propose(driver, window_buf, committee));
            effs.extend(drain_pending(driver, window_buf, storage, p2p, committee, pending, max_pending));
            effs
        }
        ContentCheck::TailDiverged(heights) => {
            // Boundary-failover tail split: state agreed but our applied chain still holds losing-round
            // blocks. Pull each peer's 2f+1-certified-canonical block so fork-choice supersedes ours.
            if crate::node::is_info() {
                println!("[INFO][BFT2] tail_reconcile idx={} diverged_heights={}", msg_index(msg), heights.len());
            }
            for h in heights {
                let p = p2p.clone();
                tokio::spawn(async move { let _ = p.request_block_repair(h).await; });
            }
            Vec::new()
        }
        ContentCheck::Reject => {
            // fail-stop: a checkpoint whose STATE/epoch content we don't independently reproduce is never
            // voted — a forged state_root cannot get our signature.
            if crate::node::is_warn() {
                match msg {
                    ConsensusMsg::Proposal(cp) => match window_buf.get(&(cp.window_head_height / qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL)) {
                        Some(c) => println!(
                            "[WARN][BFT2] proposal_content_rejected idx={} eq state_root={} epoch_commit={} reward_root={} registry_root={} total_supply={}",
                            msg_index(msg),
                            cp.state_root == c.state_root,
                            qnet_consensus::checkpoint_bft::epoch_commitment(&c.eligible, &c.committee, &c.banned) == cp.epoch_commitment,
                            cp.reward_root == c.reward_root,
                            cp.registry_root == c.registry_root,
                            cp.total_supply == c.total_supply,
                        ),
                        None => println!(
                            "[WARN][BFT2] proposal_content_rejected idx={} window_buf_MISS win={}",
                            msg_index(msg), cp.window_head_height / qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL,
                        ),
                    },
                    _ => println!("[WARN][BFT2] proposal_content_rejected idx={}", msg_index(msg)),
                }
            }
            Vec::new()
        }
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
            && sig_ok(p2p, &tm.voter, &sign_str("TMO", &timeout_bytes(tm.index, tm.high_qc_index)), &tm.signature),
        ConsensusMsg::Qc(qc) => verify_qc(p2p, committee, qc),
        // H4: a TC must carry ≥2f+1 DISTINCT committee timeouts (each signed) for its own
        // view — not merely an optional high_qc. The old `unwrap_or(true)` accepted an
        // EMPTY-timeouts TC and let on_timeout_cert advance the view (`current_index = tc.index+1`),
        // which adopt_qc never rewinds ⇒ an unauthenticated, permanent view-desync DoS.
        ConsensusMsg::Tc(tc) => tc.verify(
            committee,
            |t| sig_ok(p2p, &t.voter, &sign_str("TMO", &timeout_bytes(t.index, t.high_qc_index)), &t.signature),
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
    qc.verify(committee, |voter, body, sig| {
        let pk = match pk_map.get(voter) { Some(p) => p, None => return false };
        match std::str::from_utf8(sig) {
            Ok(s) => qnet_consensus::consensus_crypto::verify_consensus_signature_compact(
                voter, &sign_str("VOTE", body), s, pk),
            Err(_) => false,
        }
    }).is_ok()
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

/// Execute driver Effects: sign+broadcast outbound, persist QCs, record finality.
pub async fn execute(effects: Vec<Effect>, node_id: &str, p2p: &Arc<SimplifiedP2P>, storage: &Arc<Storage>) {
    for e in effects {
        match e {
            Effect::Propose(mut cp) => {
                if let Some(s) = sign_payload(node_id, "CKPT", &cp.hash()).await {
                    cp.proposer_sig = s;
                    if crate::node::is_info() { println!("[INFO][BFT2] propose index={} head_h={}", cp.index, cp.window_head_height); }
                    broadcast(p2p, &ConsensusMsg::Proposal(cp)).await;
                }
            }
            Effect::Vote { index, checkpoint_hash } => {
                if let Some(s) = sign_payload(node_id, "VOTE", &checkpoint_hash).await {
                    broadcast(p2p, &ConsensusMsg::Vote(Vote { checkpoint_hash, index, voter: node_id.to_string(), signature: s })).await;
                }
            }
            Effect::Timeout { index, high_qc_index } => {
                if let Some(s) = sign_payload(node_id, "TMO", &timeout_bytes(index, high_qc_index)).await {
                    broadcast(p2p, &ConsensusMsg::Timeout(TimeoutMsg { index, voter: node_id.to_string(), high_qc_index, signature: s })).await;
                }
            }
            Effect::Relay(m) => broadcast(p2p, &m).await,
            Effect::Persist { checkpoint, qc, eligible_producers, committee } => {
                // Every committee member seals locally: the body is a pure function of the
                // committed window (deterministic), so all produce a byte-identical block —
                // no single-producer SPOF, no seal race. Macroblock HEIGHT = window (head/90),
                // decoupled from the consensus round (checkpoint.index, may skip on timeout)
                // so a skipped round leaves NO gap. Broadcast is leader-only (peers hold it
                // locally / serve on sync) to avoid N× traffic.
                let window = checkpoint.window_head_height / 90;
                // Idempotent: already sealed locally or received via broadcast/sync.
                if storage.get_macroblock_by_height(window).ok().flatten().is_some() { continue; }
                // Chain link: seal only when the parent macroblock is present, so previous_hash
                // (= latest) chains it. Absent ⇒ defer; the leader's broadcast / sync provides it.
                if window > 1 && storage.get_macroblock_by_height(window - 1).ok().flatten().is_none() {
                    if crate::node::is_warn() { println!("[WARN][BFT2] seal_deferred window={} reason=parent_absent", window); }
                    continue;
                }
                let previous_hash = storage.get_latest_macroblock_hash().unwrap_or([0u8; 32]);
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
                    let mut v: Vec<String> =
                        crate::node::BlockchainNode::compute_cumulative_ban_set(&storage, window)
                            .await
                            .into_iter().collect();
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
                        reward_heartbeats: None,
                        reward_light_nodes: None,
                        ..Default::default()
                    },
                    previous_hash,
                    poh_hash: Vec::new(),
                    poh_count: 0,
                };
                match storage.save_macroblock(window, &mb).await {
                    Ok(_) => {
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
            Effect::Finalize { index, head_height, state_root } => {
                // Finalize a checkpoint on ITS OWN QC'd head + state_root — NOT via a macroblock body.
                // Macroblocks seal only on /macro_interval boundaries; intra-window checkpoints on the
                // faster /cp_interval cadence have none, so the old macroblock-coupled check deferred
                // them forever, froze the finality marker, and wedged the chain. Fail-stop: advance the
                // monotonic marker (LAST_FINALIZED_HEIGHT, read by the production_gate / sync / RPC) ONLY
                // if our local microblock tip reached the head AND our locally-applied state at the head
                // matches the QC'd state_root (never finalize a root we didn't reproduce). Monotonic ⇒
                // a stale/replayed Finalize never regresses it, and finality never outruns the applied tip.
                let chain_h = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(Ordering::Relaxed);
                let local_root = storage.load_microblock_auto_format(head_height).ok().flatten()
                    .map(|m| m.state_root);
                if checkpoint_finalizable(chain_h, head_height, local_root, state_root) {
                    if head_height > crate::node::LAST_FINALIZED_HEIGHT.load(Ordering::Acquire) {
                        crate::node::try_advance_finality(head_height, "BFT2");
                        if crate::node::is_info() {
                            println!("[INFO][BFT2] checkpoint_final round={} finalized_h={}", index, head_height);
                        }
                    }
                } else if crate::node::is_warn() {
                    // Transient: chain tip not yet at the head, or (fail-stop) our state diverges. The
                    // run-loop timer re-emits via committed_finalize() until caught up; §4.5 sync repairs a
                    // genuine state divergence. NOT the old permanent defer (no macroblock dependency now).
                    println!("[WARN][BFT2] finalize_deferred round={} head_h={} chain_h={} state_match={}",
                             index, head_height, chain_h, local_root == Some(state_root));
                }
            }
        }
    }
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
    logs_root: Hash,       // consensus event logs root (native QRC-20/721 + WASM), ACTIVE from genesis (gate=0)
    total_supply: u64,     // total minted supply, QC-certified via Checkpoint.total_supply
}

/// Adopt the in-flight window's committee and, if we lead the current round, propose the
/// contiguous next window. No-op until that window's content has been buffered locally.
fn try_propose(
    driver: &mut ConsensusDriver,
    buf: &std::collections::HashMap<u64, WindowContent>,
    committee: &mut Vec<String>,
) -> Vec<Effect> {
    let w = driver.next_window();
    match buf.get(&w) {
        Some(c) => {
            *committee = c.committee.clone(); // committee is per-window (epoch); QC/TC verify against it
            driver.build_proposal(w, c.mb_hashes.clone(), c.state_root, c.beacon, c.head_ts, c.committee.clone(), c.eligible.clone(), c.banned.clone(), c.reward_root, c.registry_root, c.logs_root, c.total_supply)
        }
        None => Vec::new(),
    }
}

/// Outcome of the pre-vote content gate.
enum ContentCheck {
    Ok,                     // content independently reproduced ⇒ safe to hand to the driver (vote)
    TailDiverged(Vec<u64>), // pure hash-level tail split (state agrees) at these heights ⇒ reconcile, don't vote yet
    Reject,                 // genuine state/epoch divergence or absent window ⇒ fail-stop (never vote)
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
/// for the boundary-failover finality freeze. No local window ⇒ Reject. Non-Proposal ⇒ Ok. Single
/// source of truth for the live inbound path AND drain_pending (buffered replay applies the same gate).
fn check_content(storage: &Storage, buf: &std::collections::HashMap<u64, WindowContent>, msg: &ConsensusMsg) -> ContentCheck {
    let cp = match msg { ConsensusMsg::Proposal(cp) => cp, _ => return ContentCheck::Ok };
    let k = qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL;
    let c = match buf.get(&(cp.window_head_height / k)) { Some(c) => c, None => return ContentCheck::Reject };
    // State + epoch fields must match EXACTLY — never reconcile a genuine state/epoch divergence.
    // state_root agreeing is the safety gate that makes a tail-hash split safe to reconcile below
    // (same applied state, only the failover-round-bound block hashes differ).
    if cp.state_root != c.state_root
        || qnet_consensus::checkpoint_bft::epoch_commitment(&c.eligible, &c.committee, &c.banned) != cp.epoch_commitment
        || cp.reward_root != c.reward_root
        || (qnet_state::feature_gates::is_active("registry_root_required", cp.window_head_height) && cp.registry_root != c.registry_root)
        || (qnet_state::feature_gates::is_active("logs_root_required", cp.window_head_height) && cp.logs_root != c.logs_root)
        || (qnet_state::feature_gates::is_active("registry_root_required", cp.window_head_height) && cp.total_supply != c.total_supply)
    { return ContentCheck::Reject; }
    // Window SPAN comes from OUR OWN snapshot, not `k`: an intra checkpoint covers CHECKPOINT_INTERVAL
    // blocks, but the macroblock-boundary checkpoint (head = 90·mb_idx) covers the FULL macroblock
    // window. `c.mb_hashes.len()` is the honest span for this checkpoint index (30 or 90) and is NOT
    // proposer-controlled, so the recompute range and the `!=` guard below are DoS-safe. A proposer
    // whose window size disagrees with ours is a genuine divergence ⇒ Reject.
    let win = c.mb_hashes.len();
    if cp.window_mb_hashes.len() != win || win == 0 || win as u64 > cp.window_head_height {
        return ContentCheck::Reject;
    }
    // Tail: recompute mb_hashes + beacon FRESH from canonical bodies. A divergent/absent tail height
    // ⇒ reconcile (the caller pulls the certified-canonical block; fork-choice supersedes ours).
    let start = cp.window_head_height - (win as u64 - 1);
    let mut diverged = Vec::new();
    let mut vrf: Vec<[u8; 32]> = Vec::with_capacity(win);
    for (i, h) in (start..=cp.window_head_height).enumerate() {
        match storage.load_microblock_auto_format(h).ok().flatten() {
            Some(mb) if mb.hash() == cp.window_mb_hashes[i] => match mb.vrf_output {
                Some(v) => vrf.push(v),
                None => diverged.push(h), // hash matched but vrf absent ⇒ not-ready, can't form beacon
            },
            _ => diverged.push(h), // divergent hash, or body absent ⇒ pull the certified-canonical block
        }
    }
    if !diverged.is_empty() { return ContentCheck::TailDiverged(diverged); }
    // All bodies matched ⇒ beacon derived from their VRF outputs must equal the proposer's; verify.
    if qnet_consensus::checkpoint_bft::accumulate_beacon(&vrf) != cp.beacon { return ContentCheck::Reject; }
    ContentCheck::Ok
}

fn drain_pending(
    driver: &mut ConsensusDriver, buf: &std::collections::HashMap<u64, WindowContent>,
    storage: &Storage, p2p: &SimplifiedP2P, committee: &[String], pending: &mut Vec<Vec<u8>>, max: usize,
) -> Vec<Effect> {
    if pending.is_empty() || !buf.contains_key(&driver.next_window()) { return Vec::new(); }
    let cur = driver.current_index();
    let mut effs = Vec::new();
    let mut still = Vec::new();
    for data in std::mem::take(pending) {
        match bincode::deserialize::<ConsensusMsg>(&data) {
            // Buffered replay applies the SAME sig + content gate as the live path — a Proposal whose window
            // content we cannot independently reproduce is never handed to the driver (no forged head/state).
            // TailDiverged/Reject ⇒ not applied here; the live path drives reconcile, replay retries on re-gossip.
            Ok(m) if msg_index(&m) <= cur => { if verify_msg(p2p, committee, &m) && matches!(check_content(storage, buf, &m), ContentCheck::Ok) { effs.extend(driver.handle(&m)); } }
            Ok(_) if still.len() < max => still.push(data),
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
/// Companion BYTE bound on the driver's future-round `pending` replay buffer. The 256-ENTRY
/// count cap alone still allows 256 × msg_size (a large-proposal flood ⇒ hundreds of MiB),
/// so pending is independently byte-capped. Total inbound consensus memory ≤ this + the
/// channel cap. `drain_pending` only REMOVES entries, so it can never exceed this bound —
/// the gate lives solely at the single push site below.
const V2_PENDING_BYTE_CAP: usize = 32 * 1024 * 1024; // 32 MiB of buffered future-round bytes

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
pub fn signal_window_end(
    index: u64, head_height: u64, mb_hashes: Vec<Hash>, state_root: Hash, beacon: Hash,
    committee: Vec<String>, eligible_producers: Vec<u8>, banned: Vec<String>, reward_root: Hash,
    registry_root: Hash, logs_root: Hash, total_supply: u64,
) {
    if let Some(tx) = V2_TX.get() {
        let _ = tx.send(V2Event::WindowEnd { index, head_height, mb_hashes, state_root, beacon, committee, eligible_producers, banned, reward_root, registry_root, logs_root, total_supply });
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
    // Consensus pacing — network-uniform const, NOT an operator env (per-node tuning desyncs
    // view-change timing and churns liveness). Change = rebuild the whole network.
    let timeout_ms: u64 = qnet_consensus::checkpoint_bft::VIEW_TIMEOUT_MS;
    let mut timer = tokio::time::interval(std::time::Duration::from_millis(timeout_ms));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
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
    // LIVENESS WATCHDOG state: the consensus dropout that motivated this was SILENT (Docker
    // reported "healthy" while the driver was frozen). Track sustained lag of the driver behind
    // the applied chain tip and alarm LOUDLY once per episode — re-armed on recovery.
    let mut stuck_ticks: u32 = 0;
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
            if let Ok(Some(raw)) = storage.get_macroblock_by_height(idx) {
                if let Ok(mb) = bincode::deserialize::<qnet_state::MacroBlock>(&raw) {
                    if let Some(cp_qc) = mb.consensus_data.checkpoint_qc.as_ref() {
                        if let Ok((cp, qc)) = bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint, QuorumCertificate)>(cp_qc) {
                            let effs = driver.sync(&cp, &qc);
                            if !effs.is_empty() {
                                if crate::node::is_info() {
                                    println!("[INFO][BFT2] eager_startup_sync window={} next_window={}", idx, driver.next_window());
                                }
                                execute(effs, &node_id, &p2p, &storage).await;
                            }
                            last_index = driver.current_index();
                        }
                    }
                }
            }
        }
    }
    loop {
        tokio::select! {
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
                            if let Some(c) = window_buf.get(&driver.next_window()) { committee = c.committee.clone(); }
                            // Buffer until we hold that committee, or for a round ahead of us (rounds
                            // skip on timeout) — replayed as we advance. Bounded against DoS.
                            if !window_buf.contains_key(&driver.next_window()) || msg_index(&msg) > driver.current_index() {
                                // Bound the replay buffer by BYTES as well as its 256-entry count,
                                // so a large-proposal future-round flood cannot grow it unbounded.
                                // O(pending) sum; pushes are rare (future-round only). Over either
                                // bound ⇒ drop (re-gossiped later; the buffer is best-effort).
                                let cur: usize = pending.iter().map(|d| d.len()).sum();
                                if pending.len() < MAX_PENDING && cur + data.len() <= V2_PENDING_BYTE_CAP {
                                    pending.push(data);
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
                                // Single-sig (Proposal/Vote/Timeout): the verify is cheap ⇒ inline is fine.
                                process_authenticated(&msg, &mut driver, &storage, &window_buf, &p2p, &mut committee, &mut pending, MAX_PENDING)
                            } else {
                                if crate::node::is_warn() { println!("[WARN][BFT2] msg_verify_failed idx={}", msg_index(&msg)); }
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
                                if let Some(c) = window_buf.get(&driver.next_window()) { committee = c.committee.clone(); }
                                process_authenticated(&msg, &mut driver, &storage, &window_buf, &p2p, &mut committee, &mut pending, MAX_PENDING)
                            }
                            Err(_) => Vec::new(),
                        }
                    }
                    V2Event::WindowEnd { index, head_height, mb_hashes, state_root, beacon, committee: cmt, eligible_producers, banned, reward_root, registry_root, logs_root, total_supply } => {
                        // Buffer this window's content (head microblock's real timestamp rides in
                        // the QC-agreed checkpoint). Then propose the contiguous next window if we
                        // lead, and replay buffered inbound.
                        last_signaled = last_signaled.max(index);
                        let head_ts = storage.load_microblock_auto_format(head_height)
                            .ok().flatten().map(|m| m.timestamp).unwrap_or(0);
                        window_buf.insert(index, WindowContent {
                            mb_hashes, state_root, beacon, head_ts, committee: cmt, eligible: eligible_producers, banned, reward_root, registry_root, logs_root, total_supply,
                        });
                        if window_buf.len() > MAX_WINDOW_BUF {
                            if let Some(&lo) = window_buf.keys().min() { window_buf.remove(&lo); }
                        }
                        let mut effs = try_propose(&mut driver, &window_buf, &mut committee);
                        effs.extend(drain_pending(&mut driver, &window_buf, &storage, &p2p, &committee, &mut pending, MAX_PENDING));
                        effs
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
                                    if let Some(c) = window_buf.get(&driver.next_window()) { committee = c.committee.clone(); }
                                    effs.extend(try_propose(&mut driver, &window_buf, &mut committee));
                                    effs.extend(drain_pending(&mut driver, &window_buf, &storage, &p2p, &committee, &mut pending, MAX_PENDING));
                                }
                                effs
                            }
                            Err(_) => Vec::new(),
                        }
                    }
                };
                execute(effects, &node_id, &p2p, &storage).await;
                last_index = driver.current_index();
            }
            _ = timer.tick() => {
                // Adaptive view timeout (exponential backoff, reset on commit). A fixed view can't
                // gather 2f+1 when the real round-trip exceeds it (slow node) → perpetual view-changes,
                // no finality regardless of committee size. Grow the effective timeout 4→8→16→32→60s
                // until a view lasts long enough to reach quorum; reset on any commit. Safety is
                // timeout-independent (commit needs a same-round 2f+1 QC). Time out only a window we
                // hold data for and are committing; between windows the view idles — never time out then.
                let committed = driver.committed_index();
                if committed > last_committed { last_committed = committed; consec_timeouts = 0; ticks_stuck = 0; }
                if driver.current_index() == last_index && driver.next_window() <= last_signaled {
                    ticks_stuck = ticks_stuck.saturating_add(1);
                    let need = (1u32 << consec_timeouts.min(4)).min(15); // base ticks: 4,8,16,32,60s
                    if ticks_stuck >= need {
                        let effects = driver.on_timeout();
                        execute(effects, &node_id, &p2p, &storage).await;
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
                if chain_window > driver.next_window().saturating_add(STUCK_WINDOWS) {
                    stuck_ticks = stuck_ticks.saturating_add(1);
                    if stuck_ticks >= STUCK_TICKS {
                        // Self-heal from local committed state: adopt the latest stored macroblock's QC.
                        if let Ok(idx) = storage.get_latest_macroblock_index() {
                            if let Ok(Some(raw)) = storage.get_macroblock_by_height(idx) {
                                if let Ok(mb) = bincode::deserialize::<qnet_state::MacroBlock>(&raw) {
                                    if let Some(cp_qc) = mb.consensus_data.checkpoint_qc.as_ref() {
                                        if let Ok((cp, qc)) = bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint, QuorumCertificate)>(cp_qc) {
                                            let effs = driver.sync(&cp, &qc);
                                            if !effs.is_empty() { execute(effs, &node_id, &p2p, &storage).await; }
                                        }
                                    }
                                }
                            }
                        }
                        if !stuck_alarmed {
                            stuck_alarmed = true;
                            println!("[WARN][BFT2] consensus_driver_behind round={} next_window={} chain_window={} — self-healing from latest stored macroblock QC",
                                     driver.current_index(), driver.next_window(), chain_window);
                        }
                    }
                } else {
                    if stuck_alarmed {
                        println!("[INFO][BFT2] consensus_driver_recovered next_window={} chain_window={}",
                                 driver.next_window(), chain_window);
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
                if let Some((head, sr)) = driver.committed_finalize() {
                    if head > crate::node::LAST_FINALIZED_HEIGHT.load(Ordering::Acquire) {
                        let idx = driver.committed_index();
                        execute(vec![Effect::Finalize { index: idx, head_height: head, state_root: sr }], &node_id, &p2p, &storage).await;
                    }
                }
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
        let (mut hashes, mut vrfs) = (Vec::new(), Vec::new());
        for h in (head - (win - 1))..=head {
            let mut v = [0u8; 32]; v[0] = (h & 0xff) as u8; v[1] = ((h >> 8) & 0xff) as u8;
            let mb = mk_block(h, producer, tr, sr, v);
            hashes.push(mb.hash()); vrfs.push(v);
            storage.save_microblock(h, &bincode::serialize(&mb).unwrap()).unwrap();
        }
        (hashes, qnet_consensus::checkpoint_bft::accumulate_beacon(&vrfs))
    }

    fn wc(hashes: Vec<[u8; 32]>, sr: [u8; 32], beacon: [u8; 32]) -> WindowContent {
        WindowContent { mb_hashes: hashes, state_root: sr, beacon, head_ts: 0, committee: vec![],
            eligible: vec![], banned: vec![], reward_root: [0u8; 32], registry_root: [0u8; 32],
            logs_root: [0u8; 32], total_supply: 0 }
    }

    fn cp(head: u64, hashes: Vec<[u8; 32]>, sr: [u8; 32], beacon: [u8; 32]) -> Checkpoint {
        Checkpoint { index: head / qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL, parent_qc: None,
            window_head_height: head, window_mb_hashes: hashes, state_root: sr, beacon,
            epoch_commitment: qnet_consensus::checkpoint_bft::epoch_commitment(&[], &[], &[]),
            reward_root: [0u8; 32], registry_root: [0u8; 32], logs_root: [0u8; 32], total_supply: 0,
            timestamp: 0, proposer: "p".to_string(), proposer_sig: vec![] }
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
            ContentCheck::Reject));

        // Reject: no local window snapshot ⇒ content not independently reproducible.
        let empty: std::collections::HashMap<u64, WindowContent> = std::collections::HashMap::new();
        assert!(matches!(check_content(&storage, &empty, &ok), ContentCheck::Reject));
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
            ContentCheck::Reject));
    }
}

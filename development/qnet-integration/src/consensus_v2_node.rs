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
use std::sync::atomic::Ordering;
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

/// Verify a wire message's signatures against the committee. Sync, registry-backed;
/// the node calls this BEFORE handing the message to the (trusting) driver.
pub fn verify_msg(p2p: &SimplifiedP2P, committee: &[String], msg: &ConsensusMsg) -> bool {
    match msg {
        ConsensusMsg::Proposal(cp) => sig_ok(p2p, &cp.proposer, &sign_str("CKPT", &cp.hash()), &cp.proposer_sig),
        ConsensusMsg::Vote(v) => sig_ok(p2p, &v.voter, &sign_str("VOTE", &v.checkpoint_hash), &v.signature),
        ConsensusMsg::Timeout(tm) => sig_ok(p2p, &tm.voter, &sign_str("TMO", &timeout_bytes(tm.index, tm.high_qc_index)), &tm.signature),
        ConsensusMsg::Qc(qc) => verify_qc(p2p, committee, qc),
        ConsensusMsg::Tc(tc) => tc.high_qc.as_ref().map(|q| verify_qc(p2p, committee, q)).unwrap_or(true),
    }
}

fn sig_ok(p2p: &SimplifiedP2P, signer: &str, msg: &str, sig: &[u8]) -> bool {
    match std::str::from_utf8(sig) {
        Ok(s) => p2p.verify_consensus_signature(signer, msg, s),
        Err(_) => false,
    }
}

fn verify_qc(p2p: &SimplifiedP2P, committee: &[String], qc: &QuorumCertificate) -> bool {
    qc.verify(committee, |voter, body, sig| sig_ok(p2p, voter, &sign_str("VOTE", body), sig)).is_ok()
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
                // Emission macroblock (every 160 windows ≈ 4h): record the PREVIOUS epoch's
                // reward recipients on-chain (Super HBC + Light pings) so the emission TX and
                // the deterministic crediting (both read these fields) work under v2. Determ-
                // inistic ⇒ every sealer records the same set. pool2 (fees→producer since
                // v3.18) / pool3 (Phase 2) stay None. Heavy epoch scan, but 1 window in 160.
                let (reward_heartbeats, reward_light_nodes) = if window > 0 && window % 160 == 0 {
                    let ws = (window / 160 - 1) * 14400;
                    let we = ws + 14400;
                    let hb = crate::node::BlockchainNode::collect_heartbeat_commitments_from_blocks(storage, p2p, ws, we, true)
                        .await.ok().map(|(s, _)| s).filter(|s| !s.is_empty())
                        .and_then(|s| bincode::serialize(&s).ok());
                    let lt = crate::node::BlockchainNode::collect_ping_commitments_from_blocks(storage, p2p, ws, we)
                        .await.ok().filter(|m| !m.is_empty())
                        .and_then(|m| bincode::serialize(&m).ok());
                    (hb, lt)
                } else { (None, None) };
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
                        reward_heartbeats,
                        reward_light_nodes,
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
            Effect::Finalize { index, head_height } => {
                // Finalize only what we locally HOLD and AGREE with, so finality never outruns our own
                // microblock tip (an ahead-of-chain marker wedges rollback recovery) and a forged root
                // that slipped a QC can't be finalized by an honest node that applied real state.
                let window = head_height / 90;
                let macro_bytes = storage.get_macroblock_by_height(window).ok().flatten();
                let chain_h = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(Ordering::Relaxed);
                // (1) macroblock body present AND (2) our microblock tip reached the window head
                // (⇒ every microblock ≤ head_height is applied) — keeps finality ≤ local chain tip.
                let have_window = macro_bytes.is_some() && chain_h >= head_height;
                // (3) state agreement: the macroblock's state_root must equal our locally-applied
                // window-head root, else defer (fail-stop) — never finalize state we didn't reproduce.
                let state_ok = match (
                    macro_bytes.as_ref().and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(b).ok()),
                    storage.load_microblock_auto_format(head_height).ok().flatten(),
                ) {
                    (Some(mb), Some(head_mb)) if mb.state_root != head_mb.state_root => {
                        if crate::node::is_warn() {
                            println!("[WARN][BFT2] finalize_state_mismatch round={} window={} — defer", index, window);
                        }
                        false // fail-stop: never finalize a window whose state we don't locally reproduce
                    }
                    _ => true,
                };
                if !have_window || !state_ok {
                    if crate::node::is_warn() {
                        println!("[WARN][BFT2] finalize_deferred round={} window={} body={} chain_h={} state_ok={}",
                                 index, window, macro_bytes.is_some(), chain_h, state_ok);
                    }
                } else {
                    // v2 is the single finality authority: advance the canonical monotonic marker
                    // (LAST_FINALIZED_HEIGHT / LAST_FINALIZED_CONSENSUS_ROUND) read by the production_gate,
                    // sync, recovery and RPC. Monotonic ⇒ a stale/replayed Finalize never regresses it.
                    let prev = crate::node::LAST_FINALIZED_HEIGHT.load(Ordering::Acquire);
                    if head_height > prev {
                        crate::node::try_advance_finality(head_height, "BFT2");
                        if crate::node::is_info() {
                            println!("[INFO][BFT2] checkpoint_final round={} window={} finalized_h={}", index, window, head_height);
                        }
                    }
                }
            }
        }
    }
}

/// Events fed to the v2 runtime task.
pub enum V2Event {
    Inbound(Vec<u8>),  // raw ConsensusMsg bytes from P2P
    WindowEnd {
        index: u64, head_height: u64, mb_hashes: Vec<Hash>, state_root: Hash, beacon: Hash,
        committee: Vec<String>,        // epoch committee (N-2 VRF sample) for this window
        eligible_producers: Vec<u8>,   // bincode Vec<EligibleProducer> for the macroblock body
    },
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
            driver.build_proposal(w, c.mb_hashes.clone(), c.state_root, c.beacon, c.head_ts, c.committee.clone(), c.eligible.clone())
        }
        None => Vec::new(),
    }
}

/// Re-handle buffered inbound now the round / in-flight committee may have advanced. One
/// pass: messages still ahead of our round stay buffered (bounded), the rest verify+apply.
/// No-op until we hold the in-flight window's committee.
fn drain_pending(
    driver: &mut ConsensusDriver, buf: &std::collections::HashMap<u64, WindowContent>,
    p2p: &SimplifiedP2P, committee: &[String], pending: &mut Vec<Vec<u8>>, max: usize,
) -> Vec<Effect> {
    if pending.is_empty() || !buf.contains_key(&driver.next_window()) { return Vec::new(); }
    let cur = driver.current_index();
    let mut effs = Vec::new();
    let mut still = Vec::new();
    for data in std::mem::take(pending) {
        match bincode::deserialize::<ConsensusMsg>(&data) {
            Ok(m) if msg_index(&m) <= cur => { if verify_msg(p2p, committee, &m) { effs.extend(driver.handle(&m)); } }
            Ok(_) if still.len() < max => still.push(data),
            _ => {}
        }
    }
    *pending = still;
    effs
}

static V2_TX: OnceCell<mpsc::UnboundedSender<V2Event>> = OnceCell::new();

/// P2P dispatch calls this for NetworkMessage::ConsensusV2 (no-op until run() starts).
pub fn route_inbound(data: Vec<u8>) {
    if let Some(tx) = V2_TX.get() { let _ = tx.send(V2Event::Inbound(data)); }
}

/// Production loop calls this at each checkpoint-window boundary.
pub fn signal_window_end(
    index: u64, head_height: u64, mb_hashes: Vec<Hash>, state_root: Hash, beacon: Hash,
    committee: Vec<String>, eligible_producers: Vec<u8>,
) {
    if let Some(tx) = V2_TX.get() {
        let _ = tx.send(V2Event::WindowEnd { index, head_height, mb_hashes, state_root, beacon, committee, eligible_producers });
    }
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
    let timeout_ms: u64 = std::env::var("QNET_BFT2_VIEW_TIMEOUT_MS").ok()
        .and_then(|s| s.parse().ok()).unwrap_or(4000);
    let mut timer = tokio::time::interval(std::time::Duration::from_millis(timeout_ms));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_index = driver.current_index();
    let mut last_signaled: u64 = 0; // highest window index we hold data for (gates idle timeouts)
    let mut pending: Vec<Vec<u8>> = Vec::new(); // inbound ahead of our round; replayed as we advance
    const MAX_PENDING: usize = 256; // DoS bound on the replay buffer
    // Per-window proposal/seal inputs (bounded). The leader proposes the contiguous next
    // window from here at the current round — decoupling the window from a skippable round.
    let mut window_buf: std::collections::HashMap<u64, WindowContent> = std::collections::HashMap::new();
    const MAX_WINDOW_BUF: usize = 256;
    if crate::node::is_info() {
        println!("[INFO][BFT2] runtime_started committee={} view_timeout_ms={}", committee.len(), timeout_ms);
    }
    loop {
        tokio::select! {
            Some(ev) = rx.recv() => {
                let effects = match ev {
                    V2Event::Inbound(data) => match bincode::deserialize::<ConsensusMsg>(&data) {
                        Ok(msg) => {
                            // Adopt the in-flight window's committee (QC/TC verify + leader/quorum).
                            if let Some(c) = window_buf.get(&driver.next_window()) { committee = c.committee.clone(); }
                            // Buffer until we hold that committee, or for a round ahead of us (rounds
                            // skip on timeout) — replayed as we advance. Bounded against DoS.
                            if !window_buf.contains_key(&driver.next_window()) || msg_index(&msg) > driver.current_index() {
                                if pending.len() < MAX_PENDING { pending.push(data); }
                                Vec::new()
                            } else if verify_msg(&p2p, &committee, &msg) {
                                // C: a proposal's epoch_commitment must match our OWN independently
                                // derived epoch data (eligible+committee) — anti-forge of the
                                // published validator set. No local data ⇒ can't check here (the
                                // QC-bound commitment is re-checked on macroblock sync regardless).
                                // A proposal must match our OWN independently-derived window content
                                // before we vote: real account state_root, window_mb_hashes, beacon and
                                // epoch_commitment (eligible+committee). Honest 2f+1 reject any forged
                                // checkpoint ⇒ a malicious leader cannot finalize fake state. No local
                                // content ⇒ can't check here (re-verified on macroblock sync).
                                // ACCOUNTABLE SAFETY (pure side effect — never alters handling below):
                                // cache authentic checkpoints + detect a committee member signing two
                                // DIFFERENT checkpoints at the SAME round → records sound on-chain
                                // vote-equivocation evidence (drained into a VoteEquivocationProof TX,
                                // verified + banned in the deterministic reputation fold).
                                match &msg {
                                    ConsensusMsg::Proposal(cp) => crate::node::observe_checkpoint_proposal(
                                        cp.index, cp.hash(), bincode::serialize(cp).unwrap_or_default()),
                                    ConsensusMsg::Vote(v) => crate::node::observe_checkpoint_vote(
                                        v.index, &v.voter, v.checkpoint_hash, v.signature.clone()),
                                    _ => {}
                                }
                                let content_ok = match &msg {
                                    ConsensusMsg::Proposal(cp) => window_buf.get(&(cp.window_head_height / 90))
                                        .map(|c| cp.state_root == c.state_root
                                            && cp.window_mb_hashes == c.mb_hashes
                                            && cp.beacon == c.beacon
                                            && qnet_consensus::checkpoint_bft::epoch_commitment(&c.eligible, &c.committee) == cp.epoch_commitment)
                                        // No locally-derived content for the proposer's claimed window ⇒
                                        // we cannot verify it, so we never sign it (fail-stop).
                                        .unwrap_or(false),
                                    _ => true,
                                };
                                if !content_ok {
                                    // fail-stop: a checkpoint whose content we don't independently reproduce
                                    // is never voted — a forged state_root cannot get our signature.
                                    if crate::node::is_warn() {
                                        println!("[WARN][BFT2] proposal_content_rejected idx={}", msg_index(&msg));
                                    }
                                    Vec::new()
                                } else {
                                    let mut effs = driver.handle(&msg);
                                    // Handling may advance the round/high_qc ⇒ propose the next window,
                                    // then replay buffered inbound now in range.
                                    effs.extend(try_propose(&mut driver, &window_buf, &mut committee));
                                    effs.extend(drain_pending(&mut driver, &window_buf, &p2p, &committee, &mut pending, MAX_PENDING));
                                    effs
                                }
                            } else {
                                if crate::node::is_warn() { println!("[WARN][BFT2] msg_verify_failed idx={}", msg_index(&msg)); }
                                Vec::new()
                            }
                        }
                        Err(_) => Vec::new(),
                    },
                    V2Event::WindowEnd { index, head_height, mb_hashes, state_root, beacon, committee: cmt, eligible_producers } => {
                        // Buffer this window's content (head microblock's real timestamp rides in
                        // the QC-agreed checkpoint). Then propose the contiguous next window if we
                        // lead, and replay buffered inbound.
                        last_signaled = last_signaled.max(index);
                        let head_ts = storage.load_microblock_auto_format(head_height)
                            .ok().flatten().map(|m| m.timestamp).unwrap_or(0);
                        window_buf.insert(index, WindowContent {
                            mb_hashes, state_root, beacon, head_ts, committee: cmt, eligible: eligible_producers,
                        });
                        if window_buf.len() > MAX_WINDOW_BUF {
                            if let Some(&lo) = window_buf.keys().min() { window_buf.remove(&lo); }
                        }
                        let mut effs = try_propose(&mut driver, &window_buf, &mut committee);
                        effs.extend(drain_pending(&mut driver, &window_buf, &p2p, &committee, &mut pending, MAX_PENDING));
                        effs
                    }
                };
                execute(effects, &node_id, &p2p, &storage).await;
                last_index = driver.current_index();
            }
            _ = timer.tick() => {
                // Time out only a window we have data for and are actively committing. Between
                // windows the view idles ~90s — never time out then (would skip the next window).
                if driver.current_index() == last_index && driver.next_window() <= last_signaled {
                    let effects = driver.on_timeout();
                    execute(effects, &node_id, &p2p, &storage).await;
                }
                last_index = driver.current_index();
            }
        }
    }
}

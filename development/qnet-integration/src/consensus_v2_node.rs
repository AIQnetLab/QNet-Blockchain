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
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::mpsc;

/// QNET_CONSENSUS_V2=1 ⇒ new Checkpoint-BFT path (fresh genesis required).
pub fn v2_enabled() -> bool {
    std::env::var("QNET_CONSENSUS_V2")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Highest microblock height made irreversible by a 2-chain checkpoint QC.
/// Monotonic; drives the FullyFinalized confirmation level for clients/exchanges.
static BFT2_FINALIZED_HEIGHT: AtomicU64 = AtomicU64::new(0);
pub fn bft2_finalized_height() -> u64 { BFT2_FINALIZED_HEIGHT.load(Ordering::Acquire) }

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
    let excluded: Vec<qnet_state::ExcludedProducerEntry> = counts.into_iter()
        .filter(|(_, (n, _))| *n >= FAILOVER_THRESHOLD)
        .map(|(node_id, (n, heights))| qnet_state::ExcludedProducerEntry {
            node_id, failover_count: n, failover_heights: heights,
            exclusion_blocks: 90, reason: format!("failover_{}_epoch_{}", n, mb_index),
        }).collect();
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
                // v2: only the PROPOSER seals the macroblock (its canonical QC) so the block
                // is byte-identical network-wide; followers receive + validate it. The
                // macroblock IS the epoch-transition object — it carries the QC (finality)
                // AND the next-epoch eligible-producer snapshot + VRF beacon + failover
                // exclusions that N-2 producer/committee selection reads. Deterministic:
                // timestamp/mb_hashes/state_root/beacon ride in the QC-agreed checkpoint.
                if checkpoint.proposer != node_id { continue; }
                let previous_hash = storage.get_latest_macroblock_hash().unwrap_or([0u8; 32]);
                // Store (checkpoint, QC) so receivers reconstruct checkpoint.hash(), confirm
                // it == qc.checkpoint_hash (binds this exact block), and full-verify the QC.
                let qc_bytes = bincode::serialize(&(checkpoint.clone(), qc.clone())).unwrap_or_default();
                let excluded = excluded_producers(storage, checkpoint.index);
                let mb = qnet_state::MacroBlock {
                    height: checkpoint.index,
                    timestamp: checkpoint.timestamp,
                    micro_blocks: checkpoint.window_mb_hashes.clone(),
                    state_root: checkpoint.state_root,
                    consensus_data: qnet_state::ConsensusData {
                        checkpoint_qc: Some(qc_bytes),
                        eligible_producers: if eligible_producers.is_empty() { None } else { Some(eligible_producers) },
                        randomness_beacon: Some(checkpoint.beacon),
                        excluded_producers_for_next_epoch: excluded,
                        consensus_committee: Some(committee),
                        ..Default::default()
                    },
                    previous_hash,
                    poh_hash: Vec::new(),
                    poh_count: 0,
                };
                match storage.save_macroblock(checkpoint.index, &mb).await {
                    Ok(_) => {
                        if let Ok(ser) = bincode::serialize(&mb) {
                            let compressed = zstd::encode_all(&ser[..], 3).unwrap_or(ser);
                            let _ = p2p.broadcast_macroblock(checkpoint.index, compressed, checkpoint.index).await;
                        }
                        if crate::node::is_info() {
                            println!("[INFO][BFT2] macroblock_sealed idx={} head_h={} signers={}",
                                     checkpoint.index, checkpoint.window_head_height, qc.signers.len());
                        }
                    }
                    Err(e) => if crate::node::is_warn() {
                        println!("[WARN][BFT2] macroblock_save_failed idx={} err={}", checkpoint.index, e);
                    },
                }
            }
            Effect::Finalize { index, head_height } => {
                // Microblocks ≤ head_height are now irreversible (2-chain QC). Advance the
                // monotonic finalized marker — this is the FullyFinalized point for clients.
                let prev = BFT2_FINALIZED_HEIGHT.load(Ordering::Acquire);
                if head_height > prev {
                    BFT2_FINALIZED_HEIGHT.store(head_height, Ordering::Release);
                }
                if crate::node::is_info() {
                    println!("[INFO][BFT2] checkpoint_final index={} finalized_h={}", index, head_height);
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
        committee: Vec<String>,        // epoch committee (N-2 VRF sample) for this index
        eligible_producers: Vec<u8>,   // bincode Vec<EligibleProducer> for the macroblock body
    },
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
    let mut pending: Vec<Vec<u8>> = Vec::new(); // inbound ahead of our committee; replayed at its window
    const MAX_PENDING: usize = 256; // DoS bound on the replay buffer
    if crate::node::is_info() {
        println!("[INFO][BFT2] runtime_started committee={} view_timeout_ms={}", committee.len(), timeout_ms);
    }
    loop {
        tokio::select! {
            Some(ev) = rx.recv() => {
                let effects = match ev {
                    V2Event::Inbound(data) => match bincode::deserialize::<ConsensusMsg>(&data) {
                        Ok(msg) => {
                            if msg_index(&msg) > last_signaled {
                                // Committee for this index not adopted yet ⇒ buffer (bounded),
                                // replayed when its window signal arrives. Prevents a vote-less
                                // race when a proposal beats our boundary.
                                if pending.len() < MAX_PENDING { pending.push(data); }
                                Vec::new()
                            } else if verify_msg(&p2p, &committee, &msg) {
                                driver.handle(&msg)
                            } else {
                                if crate::node::is_warn() { println!("[WARN][BFT2] msg_verify_failed idx={}", msg_index(&msg)); }
                                Vec::new()
                            }
                        }
                        Err(_) => Vec::new(),
                    },
                    V2Event::WindowEnd { index, head_height, mb_hashes, state_root, beacon, committee: cmt, eligible_producers } => {
                        // Adopt this epoch's committee (verify + leader election), then
                        // propose if we lead. head_ts = head microblock's real timestamp
                        // (we have it at the boundary); rides in the QC-agreed checkpoint.
                        last_signaled = last_signaled.max(index);
                        committee = cmt.clone();
                        let head_ts = storage.load_microblock_auto_format(head_height)
                            .ok().flatten().map(|m| m.timestamp).unwrap_or(0);
                        let mut effs = driver.build_proposal(index, head_height, mb_hashes, state_root, beacon, head_ts, cmt, eligible_producers);
                        // Replay buffered inbound now covered by the adopted committee.
                        for data in std::mem::take(&mut pending) {
                            match bincode::deserialize::<ConsensusMsg>(&data) {
                                Ok(m) if msg_index(&m) <= last_signaled => {
                                    if verify_msg(&p2p, &committee, &m) { effs.extend(driver.handle(&m)); }
                                }
                                Ok(_) if pending.len() < MAX_PENDING => pending.push(data), // still ahead
                                _ => {}
                            }
                        }
                        effs
                    }
                };
                execute(effects, &node_id, &p2p, &storage).await;
                last_index = driver.current_index();
            }
            _ = timer.tick() => {
                // Time out only a checkpoint we are actively committing (window data in
                // hand). Between windows the view idles ~90s — never time out then, else
                // the idle gap would be misread as a stall and skip the next window.
                if driver.current_index() == last_index && driver.current_index() <= last_signaled {
                    let effects = driver.on_timeout();
                    execute(effects, &node_id, &p2p, &storage).await;
                }
                last_index = driver.current_index();
            }
        }
    }
}

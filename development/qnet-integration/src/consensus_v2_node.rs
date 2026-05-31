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
use tokio::sync::mpsc;

/// QNET_CONSENSUS_V2=1 ⇒ new Checkpoint-BFT path (fresh genesis required).
pub fn v2_enabled() -> bool {
    std::env::var("QNET_CONSENSUS_V2")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
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
        let _ = p2p.broadcast_quic(&NetworkMessage::ConsensusV2 { data }).await;
    }
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
            Effect::Persist { checkpoint, qc } => {
                if let Ok(blob) = bincode::serialize(&(checkpoint.clone(), qc)) {
                    let _ = storage.save_consensus_state(checkpoint.index, &blob);
                }
            }
            Effect::Finalize(idx) => {
                // Microblocks are already applied by the streaming pipeline; record
                // checkpoint finality. Apply-ratification hook wired in the node loop.
                if crate::node::is_info() { println!("[INFO][BFT2] checkpoint_final index={}", idx); }
            }
        }
    }
}

/// Events fed to the v2 runtime task.
pub enum V2Event {
    Inbound(Vec<u8>),  // raw ConsensusMsg bytes from P2P
    WindowEnd { index: u64, head_height: u64, mb_hashes: Vec<Hash>, state_root: Hash, beacon: Hash },
}

static V2_TX: OnceCell<mpsc::UnboundedSender<V2Event>> = OnceCell::new();

/// P2P dispatch calls this for NetworkMessage::ConsensusV2 (no-op until run() starts).
pub fn route_inbound(data: Vec<u8>) {
    if let Some(tx) = V2_TX.get() { let _ = tx.send(V2Event::Inbound(data)); }
}

/// Production loop calls this at each checkpoint-window boundary.
pub fn signal_window_end(index: u64, head_height: u64, mb_hashes: Vec<Hash>, state_root: Hash, beacon: Hash) {
    if let Some(tx) = V2_TX.get() {
        let _ = tx.send(V2Event::WindowEnd { index, head_height, mb_hashes, state_root, beacon });
    }
}

/// The single v2 consensus task. Owns the driver; verifies inbound, drives the
/// engine, executes effects, and runs a progress-gated view timer.
pub async fn run(
    node_id: String, committee: Vec<String>, genesis_hash: Hash,
    p2p: Arc<SimplifiedP2P>, storage: Arc<Storage>,
) {
    let (tx, mut rx) = mpsc::unbounded_channel::<V2Event>();
    if V2_TX.set(tx).is_err() {
        if crate::node::is_warn() { println!("[WARN][BFT2] runtime already started"); }
        return;
    }
    let mut driver = ConsensusDriver::new(node_id.clone(), committee.clone(), genesis_hash);
    let timeout_ms: u64 = std::env::var("QNET_BFT2_VIEW_TIMEOUT_MS").ok()
        .and_then(|s| s.parse().ok()).unwrap_or(4000);
    let mut timer = tokio::time::interval(std::time::Duration::from_millis(timeout_ms));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_index = driver.current_index();
    if crate::node::is_info() {
        println!("[INFO][BFT2] runtime_started committee={} view_timeout_ms={}", committee.len(), timeout_ms);
    }
    loop {
        tokio::select! {
            Some(ev) = rx.recv() => {
                let effects = match ev {
                    V2Event::Inbound(data) => match bincode::deserialize::<ConsensusMsg>(&data) {
                        Ok(msg) if verify_msg(&p2p, &committee, &msg) => driver.handle(&msg),
                        Ok(_) => { if crate::node::is_warn() { println!("[WARN][BFT2] msg_verify_failed"); } Vec::new() }
                        Err(_) => Vec::new(),
                    },
                    V2Event::WindowEnd { index, head_height, mb_hashes, state_root, beacon } =>
                        driver.build_proposal(index, head_height, mb_hashes, state_root, beacon),
                };
                execute(effects, &node_id, &p2p, &storage).await;
                last_index = driver.current_index();
            }
            _ = timer.tick() => {
                // Progress-gated: time out only if the view did not advance this interval.
                if driver.current_index() == last_index {
                    let effects = driver.on_timeout();
                    execute(effects, &node_id, &p2p, &storage).await;
                }
                last_index = driver.current_index();
            }
        }
    }
}

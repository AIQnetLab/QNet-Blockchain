// Checkpoint-BFT driver (spec §4, §7.2). PURE & SYNC: translates engine Actions
// into node Effects. No crypto/net/disk/async here — the node verifies incoming
// messages (sync, via the PK registry) BEFORE calling handle(), and executes the
// returned Effects (async sign/broadcast, persist, finalize). Fully testable.

use qnet_consensus::checkpoint_bft::*;
use qnet_consensus::checkpoint_consensus::{Action, CheckpointConsensus};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Wire envelope for consensus v2 (carried inside the node's NetworkMessage).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum ConsensusMsg {
    Proposal(Checkpoint),
    Vote(Vote),
    Qc(QuorumCertificate),
    Timeout(TimeoutMsg),
    Tc(TimeoutCertificate),
}

/// What the node must DO. The driver is pure; the node owns crypto/net/disk.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Propose(Checkpoint),                        // sign cp.hash() → set proposer_sig → broadcast Proposal
    Vote { index: u64, checkpoint_hash: Hash }, // sign hash → Vote → broadcast
    Timeout { index: u64, high_qc_index: u64 }, // sign timeout_bytes → Timeout → broadcast
    Relay(ConsensusMsg),                        // Qc / Tc: already complete, just broadcast
    Persist { checkpoint: Checkpoint, qc: QuorumCertificate },
    Finalize { index: u64, head_height: u64 },  // checkpoint final ⇒ microblocks ≤ head_height irreversible
}

/// Canonical bytes a TimeoutMsg signs over (node and driver MUST agree).
pub fn timeout_bytes(index: u64, high_qc_index: u64) -> Vec<u8> {
    let mut b = b"qnet-timeout-v2".to_vec();
    b.extend_from_slice(&index.to_le_bytes());
    b.extend_from_slice(&high_qc_index.to_le_bytes());
    b
}

pub struct ConsensusDriver {
    eng: CheckpointConsensus,
    committee: Vec<NodeId>,
    genesis_hash: Hash,
    node_id: NodeId,
    proposals: HashMap<(u64, Hash), Checkpoint>,
    heads: HashMap<u64, u64>, // checkpoint index → window_head_height (for Finalize)
}

impl ConsensusDriver {
    pub fn new(node_id: NodeId, committee: Vec<NodeId>, genesis_hash: Hash) -> Self {
        Self {
            eng: CheckpointConsensus::new(node_id.clone(), committee.clone()),
            committee, genesis_hash, node_id,
            proposals: HashMap::new(), heads: HashMap::new(),
        }
    }

    pub fn committed_index(&self) -> u64 { self.eng.committed_index }
    pub fn current_index(&self) -> u64 { self.eng.current_index }
    pub fn committee(&self) -> &[NodeId] { &self.committee }

    fn parent_hash(&self) -> Hash {
        self.eng.high_qc.as_ref().map(|q| q.checkpoint_hash).unwrap_or(self.genesis_hash)
    }

    /// True if WE are the elected leader for checkpoint `index` right now.
    pub fn is_my_window(&self, index: u64) -> bool {
        if self.committee.is_empty() || index != self.eng.current_index { return false; }
        let li = leader_index(index, &self.parent_hash(), self.committee.len());
        self.committee[li] == self.node_id
    }

    /// Window of K microblocks ended and we lead ⇒ emit an (unsigned) proposal.
    pub fn build_proposal(
        &mut self, index: u64, head_height: u64, mb_hashes: Vec<Hash>,
        state_root: Hash, beacon: Hash, head_ts: u64,
    ) -> Vec<Effect> {
        if !self.is_my_window(index) { return Vec::new(); }
        let cp = Checkpoint {
            index, parent_qc: self.eng.high_qc.clone(), window_head_height: head_height,
            window_mb_hashes: mb_hashes, state_root, beacon, timestamp: head_ts,
            proposer: self.node_id.clone(), proposer_sig: Vec::new(),
        };
        self.heads.insert(index, head_height);
        self.proposals.insert((cp.index, cp.hash()), cp.clone());
        vec![Effect::Propose(cp)]
    }

    /// Local view timer fired.
    pub fn on_timeout(&mut self) -> Vec<Effect> {
        let acts = self.eng.on_local_timeout();
        self.translate(acts)
    }

    /// Catch-up: ingest a VERIFIED committed checkpoint + QC.
    pub fn sync(&mut self, cp: &Checkpoint, qc: &QuorumCertificate) -> Vec<Effect> {
        if cp.index != qc.index || cp.hash() != qc.checkpoint_hash { return Vec::new(); }
        self.heads.insert(cp.index, cp.window_head_height);
        self.proposals.insert((cp.index, cp.hash()), cp.clone());
        let acts = self.eng.sync_checkpoint(cp, qc);
        self.translate(acts)
    }

    /// Handle an ALREADY-VERIFIED wire message (node checked sigs first).
    pub fn handle(&mut self, msg: &ConsensusMsg) -> Vec<Effect> {
        let acts = match msg {
            ConsensusMsg::Proposal(cp) => {
                let ph = cp.parent_qc.as_ref().map(|q| q.checkpoint_hash).unwrap_or(self.genesis_hash);
                self.heads.insert(cp.index, cp.window_head_height);
                self.proposals.insert((cp.index, cp.hash()), cp.clone());
                self.eng.on_proposal(cp, &ph)
            }
            ConsensusMsg::Vote(v) => self.eng.on_vote(v),
            ConsensusMsg::Qc(qc) => self.eng.adopt_qc(qc),
            ConsensusMsg::Timeout(tm) => self.eng.on_timeout_msg(tm),
            ConsensusMsg::Tc(tc) => self.eng.on_timeout_cert(tc),
        };
        self.translate(acts)
    }

    fn translate(&self, actions: Vec<Action>) -> Vec<Effect> {
        let mut out = Vec::new();
        for a in actions {
            match a {
                Action::Vote(v) => out.push(Effect::Vote { index: v.index, checkpoint_hash: v.checkpoint_hash }),
                Action::FormedQc(qc) => {
                    if let Some(cp) = self.proposals.get(&(qc.index, qc.checkpoint_hash)) {
                        out.push(Effect::Persist { checkpoint: cp.clone(), qc: qc.clone() });
                    }
                    out.push(Effect::Relay(ConsensusMsg::Qc(qc)));
                }
                Action::Commit(idx) => out.push(Effect::Finalize {
                    index: idx, head_height: self.heads.get(&idx).copied().unwrap_or(0),
                }),
                Action::EnterView(_) => {}
                Action::BroadcastTimeout(tm) => out.push(Effect::Timeout { index: tm.index, high_qc_index: tm.high_qc_index }),
                Action::FormedTc(tc) => out.push(Effect::Relay(ConsensusMsg::Tc(tc))),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // mock sign/verify: sig = id || msg  (deterministic, unforgeable for the test)
    fn sign(id: &str, msg: &[u8]) -> Vec<u8> { let mut s = id.as_bytes().to_vec(); s.extend_from_slice(msg); s }
    fn verify(voter: &str, msg: &[u8], sig: &[u8]) -> bool {
        let mut e = voter.as_bytes().to_vec(); e.extend_from_slice(msg); e == sig
    }

    struct Node { d: ConsensusDriver, id: NodeId, committed: u64 }

    // Node executes one Effect ⇒ produces outbound wire messages (mock-signed).
    fn exec(n: &mut Node, e: Effect) -> Vec<ConsensusMsg> {
        match e {
            Effect::Propose(mut cp) => { cp.proposer_sig = sign(&n.id, &cp.hash()); vec![ConsensusMsg::Proposal(cp)] }
            Effect::Vote { index, checkpoint_hash } => vec![ConsensusMsg::Vote(Vote {
                checkpoint_hash, index, voter: n.id.clone(), signature: sign(&n.id, &checkpoint_hash),
            })],
            Effect::Timeout { index, high_qc_index } => vec![ConsensusMsg::Timeout(TimeoutMsg {
                index, voter: n.id.clone(), high_qc_index,
                signature: sign(&n.id, &timeout_bytes(index, high_qc_index)),
            })],
            Effect::Relay(m) => vec![m],
            Effect::Persist { .. } => vec![],
            Effect::Finalize { index, .. } => { if index > n.committed { n.committed = index; } vec![] }
        }
    }

    // Node verifies a wire message exactly as production would, BEFORE the driver.
    fn verify_msg(committee: &[NodeId], m: &ConsensusMsg) -> bool {
        match m {
            ConsensusMsg::Proposal(cp) => verify(&cp.proposer, &cp.hash(), &cp.proposer_sig),
            ConsensusMsg::Vote(v) => verify(&v.voter, &v.checkpoint_hash, &v.signature),
            ConsensusMsg::Timeout(tm) => verify(&tm.voter, &timeout_bytes(tm.index, tm.high_qc_index), &tm.signature),
            ConsensusMsg::Qc(qc) => qc.verify(committee, |a, b, c| verify(a, b, c)).is_ok(),
            ConsensusMsg::Tc(tc) => tc.high_qc.as_ref().map(|q| q.verify(committee, |a, b, c| verify(a, b, c)).is_ok()).unwrap_or(true),
        }
    }

    fn deliver(nodes: &mut Vec<Node>, committee: &[NodeId], seed: Vec<ConsensusMsg>) {
        let mut queue = seed;
        let mut rounds = 0;
        while !queue.is_empty() && rounds < 2000 {
            rounds += 1;
            let mut next = Vec::new();
            for m in queue.drain(..) {
                for k in 0..nodes.len() {
                    if !verify_msg(committee, &m) { continue; }
                    let effects = nodes[k].d.handle(&m);
                    for e in effects { next.extend(exec(&mut nodes[k], e)); }
                }
            }
            queue = next;
        }
    }

    #[test]
    fn driver_sim_4nodes_finalize_same_chain() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let genesis = [7u8; 32];
        let mut nodes: Vec<Node> = c.iter().map(|id| Node {
            d: ConsensusDriver::new(id.clone(), c.clone(), genesis), id: id.clone(), committed: 0,
        }).collect();
        for index in 1..=8u64 {
            let mut seed = Vec::new();
            for k in 0..nodes.len() {
                let effs = nodes[k].d.build_proposal(index, index * 10, vec![[index as u8; 32]], [index as u8; 32], [0u8; 32], index * 1000);
                for e in effs { seed.extend(exec(&mut nodes[k], e)); }
            }
            deliver(&mut nodes, &c, seed);
        }
        let c0 = nodes[0].committed;
        assert!(c0 >= 6, "drivers must finalize a chain, got {}", c0);
        for k in 1..nodes.len() {
            assert_eq!(nodes[k].committed, c0, "node {} finalized a different height", k);
        }
    }

    #[test]
    fn forged_proposal_rejected_at_node_verify() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let cp = Checkpoint {
            index: 1, parent_qc: None, window_head_height: 10, window_mb_hashes: vec![[1u8; 32]],
            state_root: [1u8; 32], beacon: [0u8; 32], timestamp: 0, proposer: "n1".into(), proposer_sig: vec![9, 9],
        };
        // forged proposer_sig fails node verify ⇒ never reaches the driver
        assert!(!verify_msg(&c, &ConsensusMsg::Proposal(cp)));
    }
}

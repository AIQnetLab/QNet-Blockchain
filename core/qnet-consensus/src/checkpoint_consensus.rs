// Checkpoint-BFT state machine (spec §4.3-4.4). Pure & deterministic: the node
// feeds ALREADY-AUTHENTICATED messages and applies the returned actions. No I/O,
// no crypto here (caller verifies sigs) → exhaustively unit-testable.
// Safety = lock rule (vote only extends highest QC); liveness = TC view-change.

use crate::checkpoint_bft::*;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Vote(Vote),                  // my vote on a valid proposal (node signs before send)
    FormedQc(QuorumCertificate), // a QC just reached quorum
    Commit(u64),                 // checkpoint index now FINAL (2-chain)
    EnterView(u64),              // advanced to a new checkpoint view
    BroadcastTimeout(TimeoutMsg),
    FormedTc(TimeoutCertificate),
}

pub struct CheckpointConsensus {
    node_id: NodeId,
    committee: Vec<NodeId>,      // sorted epoch committee
    pub current_index: u64,      // view we are driving
    last_voted_index: u64,
    pub high_qc: Option<QuorumCertificate>,
    locked_index: u64,           // safety lock = highest certified index
    pub committed_index: u64,
    proposals: HashMap<(u64, Hash), Checkpoint>,
    votes: HashMap<(u64, Hash), HashMap<NodeId, Vote>>,
    timeouts: HashMap<u64, HashMap<NodeId, TimeoutMsg>>,
    qcs: HashMap<u64, QuorumCertificate>,
}

impl CheckpointConsensus {
    pub fn new(node_id: NodeId, mut committee: Vec<NodeId>) -> Self {
        committee.sort();
        Self {
            node_id, committee, current_index: 1, last_voted_index: 0,
            high_qc: None, locked_index: 0, committed_index: 0,
            proposals: HashMap::new(), votes: HashMap::new(),
            timeouts: HashMap::new(), qcs: HashMap::new(),
        }
    }

    fn quorum(&self) -> usize { quorum_size(self.committee.len()) }
    fn f(&self) -> usize { self.committee.len().saturating_sub(1) / 3 }

    fn is_leader(&self, index: u64, proposer: &str, parent_hash: &Hash) -> bool {
        if self.committee.is_empty() { return false; }
        let li = leader_index(index, parent_hash, self.committee.len());
        self.committee.get(li).map(|n| n == proposer).unwrap_or(false)
    }

    /// Replace the committee for the upcoming epoch (deterministic N-2 set).
    /// Set before driving the matching checkpoint index; scales to rotating
    /// committees sampled from up to MAX_VALIDATORS eligible producers.
    pub fn set_committee(&mut self, mut committee: Vec<NodeId>) {
        committee.sort();
        self.committee = committee;
    }

    /// Proposed checkpoint (authenticated). Emits a Vote iff leader-correct and
    /// it extends our lock (safety). `parent_hash` = hash(C_{index-1}).
    pub fn on_proposal(&mut self, cp: &Checkpoint, parent_hash: &Hash) -> Vec<Action> {
        if cp.index != self.current_index { return Vec::new(); }
        if !self.is_leader(cp.index, &cp.proposer, parent_hash) { return Vec::new(); }
        let pq_index = cp.parent_qc.as_ref().map(|q| q.index).unwrap_or(0);
        if cp.index > self.last_voted_index && pq_index >= self.locked_index {
            self.proposals.insert((cp.index, cp.hash()), cp.clone());
            self.last_voted_index = cp.index;
            return vec![Action::Vote(Vote {
                checkpoint_hash: cp.hash(), index: cp.index,
                voter: self.node_id.clone(), signature: Vec::new(),
            })];
        }
        Vec::new()
    }

    /// Vote (authenticated). Forms a QC at quorum, then adopts it.
    pub fn on_vote(&mut self, v: &Vote) -> Vec<Action> {
        if self.qcs.contains_key(&v.index) { return Vec::new(); }
        let qc_opt = {
            let entry = self.votes.entry((v.index, v.checkpoint_hash)).or_default();
            entry.insert(v.voter.clone(), v.clone());
            if entry.len() >= quorum_size(self.committee.len()) {
                let mut signers: Vec<NodeId> = entry.keys().cloned().collect();
                signers.sort();
                let sigs: Vec<Vec<u8>> = signers.iter().map(|s| entry[s].signature.clone()).collect();
                Some(QuorumCertificate {
                    checkpoint_hash: v.checkpoint_hash, index: v.index,
                    sig_merkle_root: sig_merkle_root(&sigs), signers, sigs,
                })
            } else { None }
        };
        match qc_opt {
            Some(qc) => {
                let mut out = vec![Action::FormedQc(qc.clone())];
                out.extend(self.adopt_qc(&qc));
                out
            }
            None => Vec::new(),
        }
    }

    /// Adopt a QC (formed locally or received). Updates lock/high_qc, 2-chain
    /// commits the parent, advances the view.
    pub fn adopt_qc(&mut self, qc: &QuorumCertificate) -> Vec<Action> {
        if self.qcs.contains_key(&qc.index) && qc.index < self.current_index {
            // already known and not advancing — idempotent
            if self.high_qc.as_ref().map(|q| q.index).unwrap_or(0) >= qc.index { return Vec::new(); }
        }
        self.qcs.entry(qc.index).or_insert_with(|| qc.clone());
        let mut out = Vec::new();
        if qc.index > self.high_qc.as_ref().map(|q| q.index).unwrap_or(0) {
            self.high_qc = Some(qc.clone());
        }
        if qc.index > self.locked_index { self.locked_index = qc.index; }
        // 2-chain: QC(i) on C_i whose parent_qc.index == i-1 ⇒ C_{i-1} is final.
        if let Some(cp) = self.proposals.get(&(qc.index, qc.checkpoint_hash)) {
            if let Some(p) = commits_parent(cp, qc) {
                if p > self.committed_index { self.committed_index = p; out.push(Action::Commit(p)); }
            }
        }
        if qc.index >= self.current_index {
            self.current_index = qc.index + 1;
            out.push(Action::EnterView(self.current_index));
        }
        out
    }

    /// Local view timer fired ⇒ broadcast our timeout (carries high_qc index).
    pub fn on_local_timeout(&mut self) -> Vec<Action> {
        vec![Action::BroadcastTimeout(TimeoutMsg {
            index: self.current_index, voter: self.node_id.clone(),
            high_qc_index: self.high_qc.as_ref().map(|q| q.index).unwrap_or(0),
            signature: Vec::new(),
        })]
    }

    /// Timeout from a peer (authenticated). Quorum ⇒ TC ⇒ advance; f+1 ahead ⇒ jump.
    pub fn on_timeout_msg(&mut self, tm: &TimeoutMsg) -> Vec<Action> {
        let q = self.quorum();
        let f = self.f();
        let (count, snapshot) = {
            let entry = self.timeouts.entry(tm.index).or_default();
            entry.insert(tm.voter.clone(), tm.clone());
            let c = entry.len();
            let snap = if c >= q { Some(entry.values().cloned().collect::<Vec<_>>()) } else { None };
            (c, snap)
        };
        let mut out = Vec::new();
        if let Some(timeouts) = snapshot {
            out.push(Action::FormedTc(TimeoutCertificate {
                index: tm.index, timeouts, high_qc: self.high_qc.clone(),
            }));
            if tm.index >= self.current_index {
                self.current_index = tm.index + 1;
                out.push(Action::EnterView(self.current_index));
            }
        } else if count >= f + 1 && tm.index > self.current_index {
            self.current_index = tm.index; // Bracha: ≥1 honest is here
            out.push(Action::EnterView(self.current_index));
        }
        out
    }

    /// TC from a peer: adopt its high_qc, advance past its view.
    pub fn on_timeout_cert(&mut self, tc: &TimeoutCertificate) -> Vec<Action> {
        let mut out = Vec::new();
        if let Some(hq) = &tc.high_qc { out.extend(self.adopt_qc(hq)); }
        if tc.index >= self.current_index {
            self.current_index = tc.index + 1;
            out.push(Action::EnterView(self.current_index));
        }
        out
    }

    /// Catch-up (§4.5): ingest a VERIFIED committed checkpoint + its QC and
    /// fast-forward (store + adopt ⇒ commit + advance). Caller MUST have verified
    /// `qc` sigs against the committee first — fail-closed, never applies unverified.
    pub fn sync_checkpoint(&mut self, cp: &Checkpoint, qc: &QuorumCertificate) -> Vec<Action> {
        if cp.index != qc.index || cp.hash() != qc.checkpoint_hash { return Vec::new(); }
        self.proposals.insert((cp.index, cp.hash()), cp.clone());
        self.adopt_qc(qc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn committee(n: usize) -> Vec<NodeId> { (0..n).map(|i| format!("n{}", i)).collect() }
    fn hh(n: u8) -> Hash { [n; 32] }

    // Build the proposal that `leader(index)` would make, extending `parent_qc`.
    fn propose(c: &[NodeId], index: u64, parent_qc: Option<QuorumCertificate>, parent_hash: Hash) -> Checkpoint {
        let li = leader_index(index, &parent_hash, c.len());
        Checkpoint {
            index, parent_qc, window_head_height: index * 10,
            window_mb_hashes: vec![hh(index as u8)], state_root: hh(index as u8),
            beacon: hh(0), timestamp: 0, proposer: c[li].clone(), proposer_sig: Vec::new(),
        }
    }

    fn vote_all(eng: &mut CheckpointConsensus, c: &[NodeId], cp: &Checkpoint) -> Vec<Action> {
        let mut all = Vec::new();
        for voter in c {
            let v = Vote { checkpoint_hash: cp.hash(), index: cp.index, voter: voter.clone(), signature: Vec::new() };
            all.extend(eng.on_vote(&v));
        }
        all
    }

    #[test]
    fn happy_path_commits_2chain() {
        let c = committee(4); // f=1, q=3
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        // C1 (genesis parent)
        let c1 = propose(&c, 1, None, hh(0));
        assert!(matches!(eng.on_proposal(&c1, &hh(0)).as_slice(), [Action::Vote(_)]));
        let _ = vote_all(&mut eng, &c, &c1);
        let qc1 = eng.high_qc.clone().unwrap();
        assert_eq!(qc1.index, 1);
        assert_eq!(eng.current_index, 2);
        // C2 extends QC(1)
        let c2 = propose(&c, 2, Some(qc1.clone()), c1.hash());
        eng.on_proposal(&c2, &c1.hash());
        let acts = vote_all(&mut eng, &c, &c2);
        // forming QC(2) commits C1
        assert!(acts.iter().any(|a| *a == Action::Commit(1)));
        assert_eq!(eng.committed_index, 1);
        // C3 extends QC(2) ⇒ commits C2
        let qc2 = eng.high_qc.clone().unwrap();
        let c3 = propose(&c, 3, Some(qc2.clone()), c2.hash());
        eng.on_proposal(&c3, &c2.hash());
        let acts3 = vote_all(&mut eng, &c, &c3);
        assert!(acts3.iter().any(|a| *a == Action::Commit(2)));
        assert_eq!(eng.committed_index, 2);
    }

    #[test]
    fn lock_prevents_fork_vote() {
        let c = committee(4);
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        let c1 = propose(&c, 1, None, hh(0));
        eng.on_proposal(&c1, &hh(0));
        vote_all(&mut eng, &c, &c1);          // QC(1), locked=1, view=2
        let qc1 = eng.high_qc.clone().unwrap();
        let c2 = propose(&c, 2, Some(qc1), c1.hash());
        eng.on_proposal(&c2, &c1.hash());
        vote_all(&mut eng, &c, &c2);          // QC(2), locked=2, view=3
        // fork proposal at view 3 that only justifies index 1 (< lock 2) ⇒ NO vote
        let stale_qc = eng.qcs.get(&1).cloned();
        let fork = propose(&c, 3, stale_qc, c2.hash());
        assert!(eng.on_proposal(&fork, &c2.hash()).is_empty());
    }

    #[test]
    fn no_double_qc_same_index() {
        let c = committee(4);
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        let c1 = propose(&c, 1, None, hh(0));
        eng.on_proposal(&c1, &hh(0));
        vote_all(&mut eng, &c, &c1);
        let formed = vote_all(&mut eng, &c, &c1); // extra votes ⇒ no second QC
        assert!(!formed.iter().any(|a| matches!(a, Action::FormedQc(_))));
    }

    #[test]
    fn timeout_quorum_advances_view() {
        let c = committee(4);
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        assert_eq!(eng.current_index, 1);
        // 3 peers time out on view 1 ⇒ TC ⇒ view 2
        let mut last = Vec::new();
        for v in &c[..3] {
            let tm = TimeoutMsg { index: 1, voter: v.clone(), high_qc_index: 0, signature: Vec::new() };
            last = eng.on_timeout_msg(&tm);
        }
        assert!(last.iter().any(|a| matches!(a, Action::FormedTc(_))));
        assert_eq!(eng.current_index, 2);
    }

    #[test]
    fn fplus1_future_jump() {
        let c = committee(4); // f=1 ⇒ f+1=2
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        // 2 timeouts for a far view 5 ⇒ jump to 5 (Bracha)
        eng.on_timeout_msg(&TimeoutMsg { index: 5, voter: "n1".into(), high_qc_index: 0, signature: Vec::new() });
        let acts = eng.on_timeout_msg(&TimeoutMsg { index: 5, voter: "n2".into(), high_qc_index: 0, signature: Vec::new() });
        assert!(acts.iter().any(|a| *a == Action::EnterView(5)));
        assert_eq!(eng.current_index, 5);
    }

    #[test]
    fn catchup_by_qc_commits_chain() {
        let c = committee(4);
        let mut eng = CheckpointConsensus::new("n9".into(), c.clone()); // a far-behind node
        let mut parent_hash = hh(0);
        let mut prev_qc: Option<QuorumCertificate> = None;
        for i in 1..=5u64 {
            let cp = propose(&c, i, prev_qc.clone(), parent_hash);
            let signers: Vec<NodeId> = c.iter().take(3).cloned().collect();
            let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
            let qc = QuorumCertificate {
                checkpoint_hash: cp.hash(), index: i,
                sig_merkle_root: sig_merkle_root(&sigs), signers, sigs,
            };
            eng.sync_checkpoint(&cp, &qc);
            parent_hash = cp.hash();
            prev_qc = Some(qc);
        }
        assert_eq!(eng.committed_index, 4); // C1..C4 final; C5 awaits its child
        assert_eq!(eng.current_index, 6);
    }

    // Multi-node simulation: 4 engines exchange real proposals/votes; assert every
    // honest node commits the SAME chain (S1) and the chain advances (B1).
    #[test]
    fn sim_4nodes_agree_on_committed_chain() {
        let c = committee(4);
        let n = c.len();
        let mut eng: Vec<CheckpointConsensus> =
            c.iter().map(|id| CheckpointConsensus::new(id.clone(), c.clone())).collect();
        let mut parent_hash = hh(0);
        for index in 1..=8u64 {
            let li = leader_index(index, &parent_hash, n);
            let pq = eng[li].high_qc.clone();
            let cp = propose(&c, index, pq, parent_hash);
            let mut votes = Vec::new();
            for k in 0..n {
                for a in eng[k].on_proposal(&cp, &parent_hash) {
                    if let Action::Vote(mut v) = a { v.signature = c[k].as_bytes().to_vec(); votes.push(v); }
                }
            }
            assert_eq!(votes.len(), n, "all honest nodes vote at index {}", index);
            for k in 0..n { for v in &votes { eng[k].on_vote(v); } }
            parent_hash = cp.hash();
        }
        let ci = eng[0].committed_index;
        assert!(ci >= 6, "committed chain must advance, got {}", ci);
        for k in 1..n {
            assert_eq!(eng[k].committed_index, ci, "node {} diverged on committed chain", k);
        }
    }
}

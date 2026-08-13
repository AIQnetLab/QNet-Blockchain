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
    /// Armed for recovery? PARTICIPATION only — it gates what this node proposes/votes/counts, never
    /// what is VALID. `on_vote` recomputes the threshold from the live committee, so nothing is
    /// captured here that `set_committee` could make stale.
    relaxed: bool,
}

impl CheckpointConsensus {
    pub fn new(node_id: NodeId, mut committee: Vec<NodeId>) -> Self {
        committee.sort();
        Self {
            node_id, committee, current_index: 1, last_voted_index: 0,
            high_qc: None, locked_index: 0, committed_index: 0,
            proposals: HashMap::new(), votes: HashMap::new(),
            timeouts: HashMap::new(), qcs: HashMap::new(),
            relaxed: false,
        }
    }

    /// Arm/disarm the recovery span. `anchor_cp_index` is the anchor macroblock's checkpoint index;
    /// the span is the RC_SPAN_INDICES indices strictly above it. Below RELAXED_MIN_COMMITTEE the
    /// threshold is unchanged, so arming is a no-op there by construction.
    pub fn set_recovery_span(&mut self, anchor_cp_index: Option<u64>) {
        self.relaxed = anchor_cp_index.is_some();
    }

    /// Armed? Index-independent: the span is a range of windows, and a TimeoutCertificate breaks any
    /// index/window lockstep. The window bound belongs to `verify_v2_macroblock`; this copy gates
    /// participation only, so a loose answer costs liveness and can never fork.
    pub fn relaxed_at(&self, _index: u64) -> bool { self.relaxed }

    /// Highest index this replica has voted at. The recovery pin needs it: rewinding the view to a
    /// position we already voted at would make our own second vote same-index equivocation evidence.
    pub fn last_voted_index(&self) -> u64 { self.last_voted_index }

    /// Move the view DOWN to `index`. Refused unless provably harmless: strictly above the safety lock
    /// and above anything we have voted at (no same-index second vote). Unused by the recovery pin
    /// since it stopped constraining the index; kept as a sound primitive.
    pub fn rewind_view_to(&mut self, index: u64) -> bool {
        if index >= self.current_index { return index == self.current_index; }
        if index <= self.locked_index || index <= self.last_voted_index { return false; }
        self.current_index = index;
        true
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
        // Membership replaces leadership for pinned proposals: no TC can form while armed (it is never
        // relaxed), so a dead leader cannot be rotated around. Safety cost none — two proposals at one
        // index cannot both be certified without an attributable same-index double-vote. Liveness cost
        // is NOT one view: with no TC the index cannot advance, so a split wedges it. That is why the
        // caller's stagger is load-bearing, not an optimisation.
        // Never vote for a pin we have not armed. The vote signs cp.hash(), which folds the pin, so an
        // unarmed signature launders an honest quorum into a certificate the receiver evaluates under a
        // committee and threshold the proposer chose.
        if cp.recovery_anchor.is_some() && !self.relaxed_at(cp.index) { return Vec::new(); }
        let pinned = cp.recovery_anchor.is_some();
        let proposer_ok = if pinned {
            self.committee.iter().any(|c| c == &cp.proposer)
        } else {
            self.is_leader(cp.index, &cp.proposer, parent_hash)
        };
        if !proposer_ok { return Vec::new(); }
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
        // Resolved BEFORE the votes borrow. The relaxed threshold applies only when the checkpoint
        // being voted on ACTUALLY carries the pin — a strict checkpoint at a span index still needs
        // the strict quorum.
        let pinned = self.proposals.get(&(v.index, v.checkpoint_hash))
            .map(|cp| cp.recovery_anchor.is_some()).unwrap_or(false);
        let q_eff = effective_quorum(self.committee.len(), pinned && self.relaxed_at(v.index));
        let qc_opt = {
            let entry = self.votes.entry((v.index, v.checkpoint_hash)).or_default();
            entry.insert(v.voter.clone(), v.clone());
            // quorum_size(0) == 0: an unset committee would make ONE vote a QC. The other two quorum
            // sites already guard this; this was the only one that did not.
            let q = q_eff;
            if q > 0 && entry.len() >= q {
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
            // Form the TC EXACTLY once — on the quorum-CROSSING insert (c == q), never on every subsequent
            // timeout. At committee 1000 a view change gathers up to ~1000 timeouts; forming/relaying a
            // fresh multi-MB TC on each (the old c >= q) is an O(committee) re-verify + egress storm on
            // every node during the very view change that must restore finality. c == q yields the MINIMAL
            // valid TC (exactly quorum) once; later duplicates add nothing (quorum met; high_qc is ours).
            let snap = if c == q { Some(entry.values().cloned().collect::<Vec<_>>()) } else { None };
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

    /// Evict per-index state (proposals/votes/timeouts/qcs) strictly below `floor`. These maps are
    /// otherwise insert-only, so without this the always-on engine grows one committee-sized entry
    /// (votes/qcs carry a quorum of ML-DSA sigs) per checkpoint forever → OOM. Safe: everything below
    /// the committed frontier is final; the driver calls this with committed_index−CONSENSUS_STATE_RETAIN,
    /// keeping a generous reorg/late-message window, and lock/high_qc/committed_index are scalar fields
    /// untouched by pruning (never regress). No-op when `floor == 0`.
    pub fn prune_below(&mut self, floor: u64) {
        if floor == 0 { return; }
        self.proposals.retain(|(idx, _), _| *idx >= floor);
        self.votes.retain(|(idx, _), _| *idx >= floor);
        self.timeouts.retain(|idx, _| *idx >= floor);
        self.qcs.retain(|idx, _| *idx >= floor);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn committee(n: usize) -> Vec<NodeId> { (0..n).map(|i| format!("n{}", i)).collect() }
    fn hh(n: u8) -> Hash { [n; 32] }

    // H4 regression: TimeoutCertificate::verify must REJECT a forged/empty/under-quorum/
    // non-member/duplicate/wrong-view/bad-sig TC and ACCEPT a genuine 2f+1 one. Without this
    // gate an empty TC advanced a node's view (unauthenticated permanent desync DoS).
    #[test]
    fn tc_verify_rejects_forged_accepts_valid() {
        let c = committee(4); // quorum_size(4) = 3
        let sig_of = |voter: &str| { let mut s = voter.as_bytes().to_vec(); s.extend_from_slice(b"tmo"); s };
        let tmo = |voter: &str, index: u64| TimeoutMsg { index, voter: voter.into(), high_qc_index: 0, signature: sig_of(voter) };
        let vsig = |t: &TimeoutMsg| t.signature == sig_of(&t.voter);
        let vqc = |_: &QuorumCertificate| true;
        let tc = |idx: u64, ts: Vec<TimeoutMsg>| TimeoutCertificate { index: idx, timeouts: ts, high_qc: None };
        // valid: 3 distinct committee timeouts at view 5
        assert!(tc(5, vec![tmo("n0", 5), tmo("n1", 5), tmo("n2", 5)]).verify(&c, quorum_size(c.len()), vsig, vqc).is_ok());
        // empty timeouts (the attack) → reject
        assert!(tc(5, vec![]).verify(&c, quorum_size(c.len()), vsig, vqc).is_err());
        // below quorum (2 < 3) → reject
        assert!(tc(5, vec![tmo("n0", 5), tmo("n1", 5)]).verify(&c, quorum_size(c.len()), vsig, vqc).is_err());
        // non-committee voter → reject
        assert!(tc(5, vec![tmo("n0", 5), tmo("n1", 5), tmo("n9", 5)]).verify(&c, quorum_size(c.len()), vsig, vqc).is_err());
        // duplicate voter → reject
        assert!(tc(5, vec![tmo("n0", 5), tmo("n0", 5), tmo("n1", 5)]).verify(&c, quorum_size(c.len()), vsig, vqc).is_err());
        // a timeout for a different view than the TC → reject
        assert!(tc(5, vec![tmo("n0", 5), tmo("n1", 5), tmo("n2", 4)]).verify(&c, quorum_size(c.len()), vsig, vqc).is_err());
        // bad signature → reject
        let mut bad = tmo("n2", 5); bad.signature = vec![0];
        assert!(tc(5, vec![tmo("n0", 5), tmo("n1", 5), bad]).verify(&c, quorum_size(c.len()), vsig, vqc).is_err());
        // carried high_qc that fails verification → reject
        let mut tc_hq = tc(5, vec![tmo("n0", 5), tmo("n1", 5), tmo("n2", 5)]);
        tc_hq.high_qc = Some(QuorumCertificate { checkpoint_hash: hh(1), index: 4, signers: vec![], sig_merkle_root: hh(0), sigs: vec![] });
        assert!(tc_hq.verify(&c, quorum_size(c.len()), vsig, |_| false).is_err());
    }

    // Build the proposal that `leader(index)` would make, extending `parent_qc`.
    fn propose(c: &[NodeId], index: u64, parent_qc: Option<QuorumCertificate>, parent_hash: Hash) -> Checkpoint {
        let parent_qc = parent_qc.as_ref().map(QcRef::from);
        let li = leader_index(index, &parent_hash, c.len());
        Checkpoint {
            index, parent_qc, window_head_height: index * 10,
            window_mb_hashes: vec![hh(index as u8)], state_root: hh(index as u8),
            beacon: hh(0), epoch_commitment: hh(0), reward_root: hh(0), registry_root: hh(0), logs_root: hh(0), dilithium_pk_root: hh(0), reward_epoch_root: hh(0), total_supply: 0, timestamp: 0, proposer: c[li].clone(), proposer_sig: Vec::new(), recovery_anchor: None,
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

    // Pruning bounds the otherwise-insert-only per-index maps: state strictly below the floor is
    // evicted; the retention window is kept; scalar progress (committed_index) never regresses.
    #[test]
    fn prune_below_evicts_buried_index_state() {
        let c = committee(4);
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        for i in 1..=10u64 {
            let cp = propose(&c, i, None, hh(0));
            eng.proposals.insert((i, cp.hash()), cp.clone());
            eng.votes.entry((i, cp.hash())).or_default()
                .insert("n0".into(), Vote { checkpoint_hash: cp.hash(), index: i, voter: "n0".into(), signature: vec![1] });
            eng.timeouts.entry(i).or_default()
                .insert("n0".into(), TimeoutMsg { index: i, voter: "n0".into(), high_qc_index: 0, signature: vec![1] });
            eng.qcs.insert(i, QuorumCertificate { checkpoint_hash: cp.hash(), index: i, sig_merkle_root: hh(0), signers: vec![], sigs: vec![] });
        }
        eng.committed_index = 10;
        eng.prune_below(6);
        assert!(eng.proposals.keys().all(|(idx, _)| *idx >= 6), "proposals below floor evicted");
        assert!(eng.votes.keys().all(|(idx, _)| *idx >= 6), "votes below floor evicted");
        assert!(eng.timeouts.keys().all(|idx| *idx >= 6), "timeouts below floor evicted");
        assert!(eng.qcs.keys().all(|idx| *idx >= 6), "qcs below floor evicted");
        assert_eq!(eng.qcs.len(), 5, "indices 6..=10 retained");
        assert_eq!(eng.committed_index, 10, "prune never regresses committed_index");
        eng.prune_below(0); // floor 0 is a no-op
        assert_eq!(eng.qcs.len(), 5);
    }

    // ── RECOVERY RELAXATION (engine) ───────────────────────────────────────────────────────────

    // Build the checkpoint a MEMBER would propose under a pin, at the position the pin fixes.
    fn propose_pinned(_c: &[NodeId], anchor_cp_index: u64, anchor_cp_head: u64, k: u64,
                      parent_qc: Option<QuorumCertificate>, proposer: &str) -> Checkpoint {
        let (index, head) = (anchor_cp_index + k, recovery_window_head(anchor_cp_head, k));
        Checkpoint {
            index, parent_qc: parent_qc.as_ref().map(QcRef::from), window_head_height: head,
            window_mb_hashes: vec![hh(k as u8)], state_root: hh(k as u8),
            beacon: hh(0), epoch_commitment: hh(0), reward_root: hh(0), registry_root: hh(0),
            logs_root: hh(0), dilithium_pk_root: hh(0), reward_epoch_root: hh(0), total_supply: 0,
            timestamp: 0, proposer: proposer.into(), proposer_sig: Vec::new(),
            recovery_anchor: Some((3, hh(7))),
        }
    }

    // 10 members, 4 permanently silent. Under the strict quorum (7) the remaining 6 can never form a
    // QC — the halt this exists to end. Under the pin the same 6 clear the relaxed quorum (6).
    #[test]
    fn engine_relaxed_span_progresses_where_strict_wedges() {
        let c = committee(10);
        let live: Vec<NodeId> = c.iter().take(6).cloned().collect();
        let (anchor_idx, anchor_head) = (3u64, 30u64);

        // STRICT: six votes are one short of quorum_size(10)==7 ⇒ no QC, view never advances.
        let mut strict = CheckpointConsensus::new("n0".into(), c.clone());
        strict.current_index = anchor_idx + 1;
        let cp = propose_pinned(&c, anchor_idx, anchor_head, 1, None, &c[leader_index(anchor_idx + 1, &hh(0), c.len())]);
        strict.on_proposal(&cp, &hh(0));
        let mut formed = false;
        for v in &live {
            for a in strict.on_vote(&Vote { checkpoint_hash: cp.hash(), index: cp.index, voter: v.clone(), signature: vec![1] }) {
                if matches!(a, Action::FormedQc(_)) { formed = true; }
            }
        }
        assert!(!formed, "six of ten must NOT reach the strict quorum");
        assert_eq!(strict.current_index, anchor_idx + 1, "view must not advance");

        // RELAXED: same six votes, same content, pin armed ⇒ QC forms and the view advances.
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        eng.current_index = anchor_idx + 1;
        eng.set_recovery_span(Some(anchor_idx));
        // relaxed_at is ARMED-ONLY and index-independent by design. The span is a range of WINDOWS,
        // and a TimeoutCertificate breaks any index/window lockstep, so an index range here would make
        // the relaxation unusable after one dead leader. The window bound is enforced where it is
        // authoritative — verify_v2_macroblock, from the certificate's own bytes — and this copy only
        // gates participation, so a loose answer costs liveness at worst and can never fork.
        assert!(eng.relaxed_at(anchor_idx + 1));
        assert!(eng.relaxed_at(anchor_idx + RC_SPAN_INDICES));
        assert!(eng.relaxed_at(anchor_idx + RC_SPAN_INDICES + 1),
                "participation must not depend on the index — the window bound is the authority's job");
        // Under a pin ANY member may propose — no TC can rotate a dead leader while the index is fixed.
        let non_leader = c.iter().find(|x| *x != &cp.proposer).unwrap().clone();
        let cp2 = propose_pinned(&c, anchor_idx, anchor_head, 1, None, &non_leader);
        let acts = eng.on_proposal(&cp2, &hh(0));
        assert!(matches!(acts.as_slice(), [Action::Vote(_)]), "a member proposal must be votable under a pin");
        let mut got_qc = false;
        for v in &live {
            for a in eng.on_vote(&Vote { checkpoint_hash: cp2.hash(), index: cp2.index, voter: v.clone(), signature: vec![1] }) {
                if matches!(a, Action::FormedQc(_)) { got_qc = true; }
            }
        }
        assert!(got_qc, "the relaxed quorum must certify");
        assert_eq!(eng.current_index, anchor_idx + 2, "the view advances into the span");

        // Disarming restores the strict rule immediately — nothing about the span is sticky.
        eng.set_recovery_span(None);
        assert!(!eng.relaxed_at(anchor_idx + 1));
    }

    // A view change and a window advance are DIFFERENT events. A dead leader at the stuck index yields
    // a TimeoutCertificate — assembled from TIMEOUTS, not votes — so current_index climbs while
    // next_window() stays put. The pin ties index to window, so its only legal position then sits
    // BELOW the view and no member can ever propose it. Since no vote was cast at that index (there
    // was no proposal to vote on — that is why the leader timed out), rewinding onto it is harmless.
    #[test]
    fn view_rewinds_onto_the_pin_but_never_over_a_vote_or_a_lock() {
        let c = committee(10);

        // Dead leader at index 4: two view changes, zero votes ⇒ the rewind is allowed.
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        eng.current_index = 6;
        assert_eq!(eng.last_voted_index(), 0);
        assert!(eng.rewind_view_to(4));
        assert_eq!(eng.current_index, 4);
        // Idempotent when already aligned; never used to jump the view FORWARD.
        assert!(eng.rewind_view_to(4));
        assert!(!eng.rewind_view_to(9));
        assert_eq!(eng.current_index, 4, "rewind must not advance the view");

        // We DID vote at 4 (a proposal existed, quorum just never formed): rewinding back onto 4 would
        // make our second vote same-index equivocation evidence against us. Refused.
        let mut voted = CheckpointConsensus::new("n0".into(), c.clone());
        voted.current_index = 4;
        let cp = propose(&c, 4, None, hh(0));
        assert!(matches!(voted.on_proposal(&cp, &hh(0)).as_slice(), [Action::Vote(_)]));
        assert_eq!(voted.last_voted_index(), 4);
        voted.current_index = 6;
        assert!(!voted.rewind_view_to(4), "must not re-open an index we voted at");
        assert_eq!(voted.current_index, 6);

        // And never below the safety lock: a certified index is final, whatever the pin wants.
        let mut locked = CheckpointConsensus::new("n0".into(), c.clone());
        locked.current_index = 9;
        locked.adopt_qc(&QuorumCertificate {
            checkpoint_hash: hh(1), index: 5, sig_merkle_root: hh(0), signers: vec![], sigs: vec![],
        });
        assert!(!locked.rewind_view_to(4), "must not rewind below the lock");
        assert!(!locked.rewind_view_to(5), "must not rewind onto the lock either");
    }

    // A checkpoint WITHOUT the pin, at a span index, still needs the strict quorum: arming must not
    // relax ordinary traffic that merely happens to fall inside the span.
    #[test]
    fn unpinned_checkpoint_in_span_keeps_the_strict_quorum() {
        let c = committee(10);
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        eng.current_index = 4;
        eng.set_recovery_span(Some(3));
        let cp = propose(&c, 4, None, hh(0));           // recovery_anchor: None
        assert!(cp.recovery_anchor.is_none());
        eng.on_proposal(&cp, &hh(0));
        let mut formed = false;
        for v in c.iter().take(6) {
            for a in eng.on_vote(&Vote { checkpoint_hash: cp.hash(), index: cp.index, voter: v.clone(), signature: vec![1] }) {
                if matches!(a, Action::FormedQc(_)) { formed = true; }
            }
        }
        assert!(!formed, "an unpinned checkpoint must not borrow the relaxed threshold");
    }

    // Below the committee floor arming is inert: the threshold is unchanged, so a 5-node genesis
    // cannot relax anything even with the span set.
    #[test]
    fn arming_below_the_floor_changes_nothing() {
        let c = committee(5);
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        eng.current_index = 2;
        eng.set_recovery_span(Some(1));
        let cp = propose_pinned(&c, 1, 10, 1, None, &c[0]);
        eng.on_proposal(&cp, &hh(0));
        let mut formed = false;
        for v in c.iter().take(3) {                       // 3 of 5: below quorum_size(5)==4
            for a in eng.on_vote(&Vote { checkpoint_hash: cp.hash(), index: cp.index, voter: v.clone(), signature: vec![1] }) {
                if matches!(a, Action::FormedQc(_)) { formed = true; }
            }
        }
        assert!(!formed, "the relaxation must be inert at genesis scale");
        assert_eq!(relaxed_quorum(5), quorum_size(5));
    }
}

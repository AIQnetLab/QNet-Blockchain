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
    /// Newest timeout index seen per member — the view-sync input for the f+1 jump across
    /// DISTINCT indices (views scattered by restarts never meet on one index otherwise).
    peer_views: HashMap<NodeId, u64>,
    qcs: HashMap<u64, QuorumCertificate>,
    /// The recovery anchor this node armed for, or None. PARTICIPATION only — it gates what this node
    /// proposes/votes/counts, never what is VALID. `on_vote` recomputes the threshold from the live
    /// committee, so nothing is captured here that `set_committee` could make stale.
    relaxed: Option<RecoveryAnchor>,
    /// One committed CONTENT per WINDOW HEAD, recorded ACROSS indices and across anchors:
    /// `head -> (content digest, any_pinned, index)`. A pinned checkpoint's index is free, so
    /// per-index uniqueness alone would let one replica sign two conflicting checkpoints at one head
    /// — the pair two intersecting quorums need to fork. Keyed on the content digest, never `hash()`,
    /// so a legal re-proposal at a new index is unaffected. Enforced only when at least one side is
    /// PINNED: an unpinned pair must stay free, because a rollback may legally re-vote an uncertified
    /// window. Kept across disarm; pruned by the stored index.
    head_votes: HashMap<u64, (Hash, bool, u64)>,
    /// One committed POSITION per checkpoint index: `index -> (window head, content digest, parent
    /// index, parent hash)`. A pinned proposal is votable at an index this replica already voted at
    /// — that is what lets the span start at a stuck round — so the index bar that used to give
    /// "one position per index" for free is gone, and this restores it. Only the pin and the
    /// proposer may differ between two votes at one index; everything a certificate commits to, and
    /// the parent link the 2-chain rule reads, must be identical.
    index_votes: HashMap<u64, VotePosition>,
}

/// What a vote at one index commits to: window head, committed content, and the parent link
/// (`(0, [0;32])` for none). Two votes at one index must agree on all of it.
type VotePosition = (u64, Hash, u64, Hash);

fn vote_position(cp: &Checkpoint) -> VotePosition {
    let (pi, ph) = cp.parent_qc.as_ref().map(|q| (q.index, q.checkpoint_hash)).unwrap_or((0, [0u8; 32]));
    (cp.window_head_height, checkpoint_content_digest(cp), pi, ph)
}

impl CheckpointConsensus {
    pub fn new(node_id: NodeId, mut committee: Vec<NodeId>) -> Self {
        committee.sort();
        Self {
            node_id, committee, current_index: 1, last_voted_index: 0,
            high_qc: None, locked_index: 0, committed_index: 0,
            proposals: HashMap::new(), votes: HashMap::new(),
            timeouts: HashMap::new(), peer_views: HashMap::new(), qcs: HashMap::new(),
            relaxed: None, head_votes: HashMap::new(), index_votes: HashMap::new(),
        }
    }

    /// Reload a vote commitment the node persisted BEFORE releasing that vote. A vote is a
    /// commitment, not a cache: a replica that forgot one across a restart re-votes at a head it
    /// already voted at, and peers that remember convict the pair.
    ///
    /// The merge must MIRROR the live one exactly: a replica may legally record two contents at one
    /// head (a rollback re-votes an uncertified window), so the latest content wins and `pinned` is
    /// sticky across every record. Keeping the earliest instead would authorise a vote the live path
    /// refuses and would drop the flag the conviction rule reads.
    pub fn restore_vote(&mut self, index: u64, head: u64, digest: Hash, pinned: bool,
                        parent_index: u64, parent_hash: Hash) {
        self.index_votes.insert(index, (head, digest, parent_index, parent_hash));
        match self.head_votes.get_mut(&head) {
            Some(e) if e.0 == digest => { e.1 |= pinned; e.2 = e.2.max(index); }
            Some(e) if index >= e.2 => { *e = (digest, e.1 | pinned, index); }
            Some(e) => { e.1 |= pinned; }
            None => { self.head_votes.insert(head, (digest, pinned, index)); }
        }
        self.last_voted_index = self.last_voted_index.max(index);
    }

    /// Arm/disarm the recovery span for one specific anchor. Storing the anchor rather than a bare
    /// flag is what stops an armed node from signing a pin it did not arm: an attacker-chosen anchor
    /// selects the span and the threshold, so an honest signature on one is a wasted round at best.
    /// Below RELAXED_MIN_COMMITTEE the threshold is unchanged, so arming is inert there.
    pub fn set_recovery_span(&mut self, anchor: Option<RecoveryAnchor>) {
        self.relaxed = anchor;
    }

    /// Armed? Index-independent: the span is a range of windows, not of indices. The window bound
    /// belongs to `verify_v2_macroblock` (and to `build_proposal` on the emit side); this copy gates
    /// participation only, so a loose answer costs liveness and can never fork.
    pub fn is_relaxed(&self) -> bool { self.relaxed.is_some() }

    /// The content digest we already voted for at this window head, if any. The observable of the
    /// one-content-per-head rule, so a test can assert the rule rather than infer it.
    pub fn voted_content_at(&self, window_head: u64) -> Option<Hash> {
        self.head_votes.get(&window_head).map(|(h, _, _)| *h)
    }

    /// Highest index this replica has voted at. Bars a second UNPINNED vote at a round already voted;
    /// a pinned one is admitted at the identical position instead (`index_votes`).
    pub fn last_voted_index(&self) -> u64 { self.last_voted_index }

    /// Highest certified index (the safety lock).
    pub fn locked_index(&self) -> u64 { self.locked_index }

    /// The member the leader rule elects for `index` under `parent_hash`, if the committee is set.
    pub fn leader_for(&self, index: u64, parent_hash: &Hash) -> Option<&NodeId> {
        if self.committee.is_empty() { return None; }
        self.committee.get(leader_index(index, parent_hash, self.committee.len()))
    }

    /// Enter the first votable view. Views at or below the vote ceiling can never be voted
    /// (anti-equivocation), so a restart that re-enters them idles through a timeout crawl the
    /// height of its own vote history. Forward view skips are always safe.
    pub fn enter_first_votable_view(&mut self) {
        self.current_index = self.current_index.max(self.last_voted_index.saturating_add(1));
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
        self.peer_views.retain(|id, _| committee.binary_search(id).is_ok());
        self.committee = committee;
    }

    /// Proposed checkpoint (authenticated). Emits a Vote iff leader-correct and
    /// it extends our lock (safety). `parent_hash` = hash(C_{index-1}).
    pub fn on_proposal(&mut self, cp: &Checkpoint, parent_hash: &Hash) -> Vec<Action> {
        if cp.index != self.current_index { return Vec::new(); }
        // Membership replaces leadership for pinned proposals: a TC cannot form during a halt (its
        // threshold is never relaxed), so a dead leader cannot be rotated around. Two members may
        // therefore propose the same window at one index; both are votable (same position), so a
        // vote split costs a round, not the span.
        //
        // Never vote for a pin we did not arm, and never for a DIFFERENT one. The vote signs cp.hash(),
        // which folds the pin, and the pin selects the span and the threshold — so an off-anchor
        // signature launders an honest quorum into a certificate evaluated at a bar the proposer chose.
        if cp.recovery_anchor.is_some() && cp.recovery_anchor != self.relaxed { return Vec::new(); }
        let pinned = cp.recovery_anchor.is_some();
        let digest = checkpoint_content_digest(cp);
        // ONE COMMITTED CONTENT PER WINDOW HEAD, across indices AND across anchors, whenever either
        // side is pinned. The pin frees the index, and any two quorums over one head share a signer
        // (both are taken over the same derived committee) — so without this a shared signer could
        // certify two conflicting checkpoints at that head while never double-voting at one index,
        // and same-round equivocation would see nothing. Keyed on the CONTENT digest, not hash():
        // re-proposing one window at a new index after a view change is protocol-mandated and seals a
        // byte-identical macroblock, so it must stay votable. Refusing here is what makes
        // `pinned_double_vote` a sound ban proof: an honest replica never emits the pair.
        if let Some((prev, prev_pinned, _)) = self.head_votes.get(&cp.window_head_height) {
            if *prev != digest && (pinned || *prev_pinned) { return Vec::new(); }
        }
        let proposer_ok = if pinned {
            self.committee.iter().any(|c| c == &cp.proposer)
        } else {
            self.is_leader(cp.index, &cp.proposer, parent_hash)
        };
        if !proposer_ok { return Vec::new(); }
        let pq_index = cp.parent_qc.as_ref().map(|q| q.index).unwrap_or(0);
        if pq_index < self.locked_index { return Vec::new(); }
        // THE PIN FREES THE INDEX. At a live-leader halt every live member has already voted at the
        // stuck round, and no TC can advance the view (its threshold is never relaxed), so barring a
        // second vote there would make the pinned re-proposal unvotable and the span could never
        // start. A repeat vote is admitted only at the IDENTICAL position, so the pin and the
        // proposer are the only things that may differ between two votes at one index — the pair
        // `same_round_double_vote` deliberately does not convict. Unpinned traffic keeps the strict
        // one-vote-per-index bar.
        let position = vote_position(cp);
        if pinned {
            if self.index_votes.get(&cp.index).map(|p| *p != position).unwrap_or(false) {
                return Vec::new();
            }
        } else if cp.index <= self.last_voted_index {
            return Vec::new();
        }
        self.proposals.insert((cp.index, cp.hash()), cp.clone());
        self.last_voted_index = self.last_voted_index.max(cp.index);
        self.index_votes.insert(cp.index, position);
        match self.head_votes.get_mut(&cp.window_head_height) {
            Some(e) if e.0 == digest => { e.1 |= pinned; e.2 = e.2.max(cp.index); }
            _ => { self.head_votes.insert(cp.window_head_height, (digest, pinned, cp.index)); }
        }
        vec![Action::Vote(Vote {
            checkpoint_hash: cp.hash(), index: cp.index,
            voter: self.node_id.clone(), signature: Vec::new(),
        })]
    }

    /// The position this replica committed to at `index`, if any. The observable of the
    /// one-position-per-index rule, and the record the node persists before releasing the vote.
    pub fn voted_position_at(&self, index: u64) -> Option<(u64, Hash, u64, Hash)> {
        self.index_votes.get(&index).copied()
    }

    /// Vote (authenticated). Forms a QC at quorum, then adopts it.
    pub fn on_vote(&mut self, v: &Vote) -> Vec<Action> {
        if self.qcs.contains_key(&v.index) { return Vec::new(); }
        // Resolved BEFORE the votes borrow. The relaxed threshold applies only when the checkpoint
        // being voted on carries THE PIN THIS NODE ARMED — a strict checkpoint, an unknown subject
        // or a foreign anchor all keep the strict quorum.
        let relaxed = self.relaxed.is_some()
            && self.proposals.get(&(v.index, v.checkpoint_hash))
                   .map(|cp| cp.recovery_anchor == self.relaxed).unwrap_or(false);
        let q_eff = effective_quorum(self.committee.len(), relaxed);
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
        // The certificate now HOLDS this index's votes, and `on_vote` refuses any further vote at a
        // certified index — so the tally is dead weight from here. At a 1000 committee that is a
        // quorum of ML-DSA signatures per index reclaimed the moment the index certifies.
        self.votes.retain(|(idx, _), _| *idx != qc.index);
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
    ///
    /// Stays live while armed, deliberately. A TC cannot form during a halt (its threshold is never
    /// relaxed), but the f+1 jump is the ONLY thing that re-converges views that drifted apart before
    /// the arm — and the span needs its members on one index to reach even the relaxed quorum.
    /// Advancing costs nothing now that the vote rule keys on committed CONTENT, not on the index.
    pub fn on_timeout_msg(&mut self, tm: &TimeoutMsg) -> Vec<Action> {
        let q = self.quorum();
        let f = self.f();
        // Tally only near the current view: one member spraying far-future indices must not grow
        // the per-index map unboundedly. peer_views (one slot per member) still records it, so the
        // f+1-distinct jump below works at ANY distance and the tally resumes once we arrive.
        if tm.index > self.current_index.saturating_add(crate::checkpoint_bft::CONSENSUS_STATE_RETAIN) {
            self.peer_views.insert(tm.voter.clone(), tm.index);
            let mut ahead: Vec<u64> = self.peer_views.values().copied()
                .filter(|i| *i > self.current_index).collect();
            if ahead.len() >= f + 1 {
                ahead.sort_unstable_by(|a, b| b.cmp(a));
                let target = ahead[f];
                if target > self.current_index {
                    self.current_index = target;
                    return vec![Action::EnterView(self.current_index)];
                }
            }
            return Vec::new();
        }
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
        // View sync across DISTINCT indices: restarts scatter views (each reboots at its own vote
        // ceiling), and same-index counts then never reach f+1. f+1 members announcing views ahead
        // of ours ⇒ jump to the (f+1)-th highest announced — ≥1 honest is at or above it.
        self.peer_views.insert(tm.voter.clone(), tm.index);
        let mut ahead: Vec<u64> = self.peer_views.values().copied()
            .filter(|i| *i > self.current_index).collect();
        if ahead.len() >= f + 1 {
            ahead.sort_unstable_by(|a, b| b.cmp(a));
            let target = ahead[f];
            if target > self.current_index {
                self.current_index = target;
                out.push(Action::EnterView(self.current_index));
            }
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

    /// Evict per-index state. TWO floors, because a content-divergence halt freezes `committed_index`
    /// while `current_index` keeps advancing on TimeoutCertificates — one commit-derived floor would
    /// stop moving for the whole outage and the bulky maps would grow until OOM.
    ///
    /// `view_floor` (= current_index − RETAIN) bounds `proposals`/`votes`/`timeouts`/`qcs`/
    /// `index_votes`: every live reader of those touches the round being driven or its parent, and
    /// `on_proposal` consults `index_votes` only at `current_index`, which never regresses — so an
    /// entry below the view floor can no longer be read. Restart safety lives in the durable vote
    /// store (`restore_vote`), not in this map.
    ///
    /// `commit_floor` (= committed_index − RETAIN) bounds `head_votes` alone. It is keyed by WINDOW
    /// HEAD, and a head only advances when a window commits, so it holds O(1) entries for the whole
    /// halt; flooring it at the view would instead drop the one-content-per-head refusal for a head
    /// still being proposed. lock/high_qc/committed_index are scalars and never regress.
    pub fn prune_below(&mut self, view_floor: u64, commit_floor: u64) {
        if view_floor > 0 {
            self.proposals.retain(|(idx, _), _| *idx >= view_floor);
            self.votes.retain(|(idx, _), _| *idx >= view_floor);
            self.qcs.retain(|idx, _| *idx >= view_floor);
            self.index_votes.retain(|idx, _| *idx >= view_floor);
        }
        // Timeouts get their own, much tighter floor: they are dead as soon as the view leaves their
        // index, and they are what a divergence halt refills every view.
        let timeout_floor = self.current_index.saturating_sub(TIMEOUT_STATE_RETAIN);
        if timeout_floor > 0 {
            self.timeouts.retain(|idx, _| *idx >= timeout_floor);
        }
        if commit_floor > 0 {
            self.head_votes.retain(|_, (_, _, idx)| *idx >= commit_floor);
        }
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
        eng.current_index = 11;
        eng.prune_below(6, 6);
        assert!(eng.proposals.keys().all(|(idx, _)| *idx >= 6), "proposals below floor evicted");
        assert!(eng.votes.keys().all(|(idx, _)| *idx >= 6), "votes below floor evicted");
        assert!(eng.qcs.keys().all(|idx| *idx >= 6), "qcs below floor evicted");
        // Timeouts use their own tighter floor, current_index − TIMEOUT_STATE_RETAIN.
        assert!(eng.timeouts.keys().all(|idx| *idx >= 11 - TIMEOUT_STATE_RETAIN),
                "timeouts below their own floor evicted");
        assert_eq!(eng.qcs.len(), 5, "indices 6..=10 retained");
        assert_eq!(eng.committed_index, 10, "prune never regresses committed_index");
        eng.prune_below(0, 0); // floor 0 is a no-op
        assert_eq!(eng.qcs.len(), 5);
    }

    // A content-divergence halt keeps forming TimeoutCertificates, so the VIEW advances every timeout
    // while `committed_index` stays frozen. The per-index maps must follow the view, or the engine
    // grows one committee-sized entry of ML-DSA signatures per view for the whole outage.
    #[test]
    fn halt_retention_follows_the_view_not_the_commit() {
        let c = committee(4);
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        // 2000 views, no commit — 15x the retention window.
        for i in 1..=2000u64 {
            for v in &c {
                let _ = eng.on_timeout_msg(&TimeoutMsg {
                    index: i, voter: v.clone(), high_qc_index: 0, signature: vec![7u8; 3309],
                });
            }
            // Exactly what the driver does after every engine step.
            let view_floor = eng.current_index.saturating_sub(CONSENSUS_STATE_RETAIN);
            let commit_floor = eng.committed_index.saturating_sub(CONSENSUS_STATE_RETAIN);
            eng.prune_below(view_floor, commit_floor);
        }
        assert_eq!(eng.committed_index, 0, "nothing committed during the halt");
        assert!(eng.current_index > 2000, "the view advanced on TimeoutCertificates");
        assert!(
            eng.timeouts.len() as u64 <= TIMEOUT_STATE_RETAIN + 2,
            "timeouts must stay bounded by their own tight window, got {}", eng.timeouts.len()
        );
        assert!(eng.index_votes.len() as u64 <= CONSENSUS_STATE_RETAIN + 2);
    }

    // A certified index's vote tally is redundant — the QC holds those signatures and `on_vote`
    // refuses any further vote there — so it must be released at certification, not carried for the
    // whole retention window.
    #[test]
    fn certifying_an_index_releases_its_vote_tally() {
        let c = committee(4);
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        let cp = propose(&c, 1, None, hh(0));
        let h = cp.hash();
        eng.proposals.insert((1, h), cp);
        for v in c.iter().take(quorum_size(c.len()) - 1) {
            let acts = eng.on_vote(&Vote { checkpoint_hash: h, index: 1, voter: v.clone(), signature: vec![1u8; 3309] });
            assert!(acts.is_empty(), "no QC below quorum");
        }
        assert_eq!(eng.votes.len(), 1, "the tally is held while the index is uncertified");
        let acts = eng.on_vote(&Vote {
            checkpoint_hash: h, index: 1, voter: c[quorum_size(c.len()) - 1].clone(), signature: vec![1u8; 3309],
        });
        assert!(matches!(acts.first(), Some(Action::FormedQc(_))), "quorum forms the QC");
        assert!(eng.votes.is_empty(), "the tally is released once the index certifies");
        assert!(eng.qcs.contains_key(&1), "the certificate itself is kept");
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
        eng.set_recovery_span(Some((3, hh(7))));
        // is_relaxed is ARMED-ONLY and index-independent by design. The span is a range of WINDOWS,
        // and a TimeoutCertificate breaks any index/window lockstep, so an index range here would make
        // the relaxation unusable after one dead leader. The window bound is enforced where it is
        // authoritative — verify_v2_macroblock, from the certificate's own bytes — and this copy only
        // gates participation, so a loose answer costs liveness at worst and can never fork.
        assert!(eng.is_relaxed());
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
        assert!(!eng.is_relaxed());
    }

    // A checkpoint WITHOUT the pin, at a span index, still needs the strict quorum: arming must not
    // relax ordinary traffic that merely happens to fall inside the span.
    #[test]
    fn unpinned_checkpoint_in_span_keeps_the_strict_quorum() {
        let c = committee(10);
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        eng.current_index = 4;
        eng.set_recovery_span(Some((3, hh(7))));
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
        eng.set_recovery_span(Some((3, hh(7))));
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

    // THE LIVE-LEADER HALT. The leader was alive and did propose, so every live member has already
    // voted at the stuck round; no TC can advance the view (its threshold is never relaxed). If the
    // index barred a second vote there, the pinned re-proposal would be unvotable on every member and
    // the span could never start — the relaxation would only ever work for a DEAD leader.
    #[test]
    fn the_pin_frees_the_index_at_the_stuck_round() {
        let c = committee(10);
        let (anchor_idx, anchor_head) = (3u64, 90u64);
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        let idx = anchor_idx + 1;
        eng.current_index = idx;

        // Before the arm: an ordinary vote at this round.
        let mut plain = propose_pinned(&c, anchor_idx, anchor_head, 1, None, &c[0]);
        plain.recovery_anchor = None;
        plain.proposer = c[leader_index(idx, &hh(0), c.len())].clone();
        assert!(matches!(eng.on_proposal(&plain, &hh(0)).as_slice(), [Action::Vote(_)]));
        assert_eq!(eng.last_voted_index(), idx);
        // A second UNPINNED proposal at that round stays barred — the strict rule is untouched.
        let mut other = plain.clone();
        other.state_root = hh(0xAA);
        assert!(eng.on_proposal(&other, &hh(0)).is_empty());

        // The pinned re-proposal of the SAME window at the SAME round is votable.
        eng.set_recovery_span(Some((3, hh(7))));
        let pinned = propose_pinned(&c, anchor_idx, anchor_head, 1, None, &c[2]);
        assert_eq!(pinned.index, idx);
        assert!(matches!(eng.on_proposal(&pinned, &hh(0)).as_slice(), [Action::Vote(_)]),
                "the pinned re-proposal must be votable at the round the halt is stuck on");
        // The pair this just created carries two different hashes and is convictable under NEITHER
        // shape — that is what makes the freed index safe to give an honest replica.
        assert_ne!(plain.hash(), pinned.hash());
        assert!(!same_round_double_vote(&plain, &pinned));
        assert!(!pinned_double_vote(&plain, &pinned));

        // ONE POSITION PER INDEX still holds: a second WINDOW at that round is refused, and only the
        // index rule can refuse it (that head carries no vote yet).
        let mut other_head = propose_pinned(&c, anchor_idx, anchor_head, 2, None, &c[2]);
        other_head.index = idx;
        assert!(eng.voted_content_at(other_head.window_head_height).is_none());
        assert!(eng.on_proposal(&other_head, &hh(0)).is_empty(),
                "two window heads at one round is the same-round offence");
        assert!(same_round_double_vote(&pinned, &other_head));
    }

    // Pinning a window is a THRESHOLD change, not a content change. Folding the pin into the digest
    // the one-content-per-head rule keys on made the pinned re-proposal of the stuck window unvotable
    // for everyone who had already voted there — and, on the other edge, stranded exactly the nodes
    // that carried the recovery when the span ended.
    #[test]
    fn pinning_a_window_is_not_a_content_change() {
        let c = committee(10);
        let (anchor_idx, anchor_head) = (3u64, 90u64);
        let pinned = propose_pinned(&c, anchor_idx, anchor_head, 1, None, &c[1]);
        let mut plain = pinned.clone();
        plain.recovery_anchor = None;
        assert_eq!(checkpoint_content_digest(&pinned), checkpoint_content_digest(&plain));
        assert!(!pinned_double_vote(&pinned, &plain));

        // (a) Arming AFTER an ordinary vote at that head.
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        eng.current_index = plain.index;
        let mut lead = plain.clone();
        lead.proposer = c[leader_index(plain.index, &hh(0), c.len())].clone();
        assert!(matches!(eng.on_proposal(&lead, &hh(0)).as_slice(), [Action::Vote(_)]));
        eng.set_recovery_span(Some((3, hh(7))));
        let mut later = pinned.clone();
        later.index = plain.index + 3;
        eng.current_index = later.index;
        assert!(matches!(eng.on_proposal(&later, &hh(0)).as_slice(), [Action::Vote(_)]),
                "a head already voted UNPINNED must still accept the pin");

        // (b) Disarming after a pinned vote: the strict re-proposal of that same window.
        eng.set_recovery_span(None);
        let mut strict_again = plain.clone();
        strict_again.index = later.index + 1;
        strict_again.proposer = c[leader_index(strict_again.index, &hh(0), c.len())].clone();
        eng.current_index = strict_again.index;
        assert!(matches!(eng.on_proposal(&strict_again, &hh(0)).as_slice(), [Action::Vote(_)]),
                "ending the span must not strand the nodes that carried the recovery");
    }

    // A vote is a COMMITMENT, not a cache. Operators restart nodes during a halt, so the refusal that
    // makes `pinned_double_vote` sound has to outlive the process — otherwise the honest replica emits
    // exactly the pair its peers already hold and is banned for following the protocol.
    #[test]
    fn a_reloaded_vote_commitment_refuses_what_conviction_punishes() {
        let c = committee(10);
        let (anchor_idx, anchor_head) = (3u64, 90u64);
        let pin = (3u64, hh(7));
        let first = propose_pinned(&c, anchor_idx, anchor_head, 1, None, &c[1]);
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        eng.current_index = first.index;
        eng.set_recovery_span(Some(pin));
        assert!(matches!(eng.on_proposal(&first, &hh(0)).as_slice(), [Action::Vote(_)]));
        let pos = eng.voted_position_at(first.index).expect("the position is recorded");

        // The window's content changes under it (a tail rollback) and the span re-proposes.
        let mut rival = first.clone();
        rival.state_root = hh(0xEE);
        rival.index = first.index + 1;

        // A process that FORGOT emits the convictable pair.
        let mut forgot = CheckpointConsensus::new("n0".into(), c.clone());
        forgot.current_index = rival.index;
        forgot.set_recovery_span(Some(pin));
        assert!(matches!(forgot.on_proposal(&rival, &hh(0)).as_slice(), [Action::Vote(_)]));
        assert!(pinned_double_vote(&first, &rival), "that pair is exactly what peers convict");

        // A process that RELOADED refuses it, and still knows what it committed to.
        let mut restored = CheckpointConsensus::new("n0".into(), c.clone());
        restored.restore_vote(first.index, pos.0, pos.1, true, pos.2, pos.3);
        restored.current_index = rival.index;
        restored.set_recovery_span(Some(pin));
        assert!(restored.on_proposal(&rival, &hh(0)).is_empty());
        assert_eq!(restored.voted_content_at(first.window_head_height), Some(pos.1));
        assert_eq!(restored.last_voted_index(), first.index);
    }

    // Views scattered by restarts (each node reboots at its own vote ceiling) never meet on one
    // index, so the same-index f+1 rule alone deadlocks. f+1 DISTINCT members announcing views
    // ahead must pull us to the (f+1)-th highest announced — ≥1 honest is at or above it.
    #[test]
    fn f_plus_one_distinct_higher_views_pull_us_up() {
        let c = committee(5); // f=1, so 2 distinct higher views suffice
        let mut eng = CheckpointConsensus::new(c[0].clone(), c.clone());
        eng.current_index = 690;
        let acts = eng.on_timeout_msg(&TimeoutMsg { index: 705, voter: c[1].clone(), high_qc_index: 0, signature: Vec::new() });
        assert!(acts.is_empty(), "one voter ahead is not evidence");
        let acts = eng.on_timeout_msg(&TimeoutMsg { index: 710, voter: c[2].clone(), high_qc_index: 0, signature: Vec::new() });
        assert!(acts.iter().any(|a| matches!(a, Action::EnterView(705))),
                "jumps to the 2nd-highest announced view, where >=1 honest sits");
        assert_eq!(eng.current_index, 705);
        // Far beyond the tally horizon (a node hundreds of views behind after a stall): the
        // per-member view record still drives the jump, without growing the per-index map.
        let mut far = CheckpointConsensus::new(c[0].clone(), c.clone());
        far.current_index = 100;
        let _ = far.on_timeout_msg(&TimeoutMsg { index: 700, voter: c[1].clone(), high_qc_index: 0, signature: Vec::new() });
        assert_eq!(far.current_index, 100, "one far announcement is not evidence");
        assert!(far.timeouts.get(&700).is_none(), "far-future indices never enter the tally");
        let acts = far.on_timeout_msg(&TimeoutMsg { index: 705, voter: c[2].clone(), high_qc_index: 0, signature: Vec::new() });
        assert!(acts.iter().any(|a| matches!(a, Action::EnterView(700))));
        assert_eq!(far.current_index, 700);
        // A member leaving the committee no longer counts toward the evidence (f stays 1).
        let mut eng2 = CheckpointConsensus::new(c[0].clone(), c.clone());
        eng2.current_index = 690;
        let _ = eng2.on_timeout_msg(&TimeoutMsg { index: 705, voter: c[1].clone(), high_qc_index: 0, signature: Vec::new() });
        let mut without_c1 = c.clone();
        without_c1.remove(1);
        eng2.set_committee(without_c1);
        let acts = eng2.on_timeout_msg(&TimeoutMsg { index: 710, voter: c[2].clone(), high_qc_index: 0, signature: Vec::new() });
        assert!(!acts.iter().any(|a| matches!(a, Action::EnterView(_))),
                "the departed member's announcement was pruned");
    }

    // A restart must not re-enter voted territory: those views are unvotable, so idling there
    // costs a timeout crawl the height of the vote history (observed live: hours after a stall).
    #[test]
    fn restore_then_first_votable_view_skips_the_voted_ceiling() {
        let c = committee(4);
        let mut eng = CheckpointConsensus::new("n0".into(), c);
        eng.restore_vote(600, 15420, hh(1), false, 568, hh(2));
        eng.restore_vote(597, 15420, hh(1), false, 568, hh(2));
        eng.enter_first_votable_view();
        assert_eq!(eng.current_index, 601, "boots at ceiling+1, not below it");
        eng.enter_first_votable_view();
        assert_eq!(eng.current_index, 601, "idempotent; never moves backward");
    }

    // THE accountability arm for the freed index. Any two quorums over one window head share a
    // signer (both are taken over the same derived committee), so the shared signer's two votes are
    // the conflict — but they sit at DIFFERENT indices, which same-round equivocation cannot see.
    // The engine refuses to create that pair, and the pair it refuses is exactly the pair
    // `pinned_double_vote` convicts.
    #[test]
    fn one_committed_content_per_pinned_head_refused_and_attributable() {
        let c = committee(10);
        let (anchor_idx, anchor_head) = (3u64, 90u64);
        let pin = (3u64, hh(7));
        let mut eng = CheckpointConsensus::new("n0".into(), c.clone());
        eng.current_index = anchor_idx + 1;
        eng.set_recovery_span(Some(pin));

        let first = propose_pinned(&c, anchor_idx, anchor_head, 1, None, &c[1]);
        assert!(matches!(eng.on_proposal(&first, &hh(0)).as_slice(), [Action::Vote(_)]));
        assert_eq!(eng.voted_content_at(first.window_head_height),
                   Some(checkpoint_content_digest(&first)));

        // CONFLICT: same (anchor, head), DIFFERENT committed state, a later round. Refused.
        let mut rival = propose_pinned(&c, anchor_idx, anchor_head, 1, None, &c[2]);
        rival.state_root = hh(0xBB);
        rival.index = first.index + 1;
        eng.current_index = rival.index;
        assert!(eng.on_proposal(&rival, &hh(0)).is_empty(),
                "one committed content per (anchor, head) — across indices, not merely within one");
        assert!(pinned_double_vote(&first, &rival));

        // CONFORMANT: the SAME window re-proposed at a new index by another member after a view
        // change. Different hash, identical content ⇒ still votable, and never convictable. This is
        // the case that makes a hash-keyed rule unusable.
        let mut reproposal = propose_pinned(&c, anchor_idx, anchor_head, 1, None, &c[3]);
        reproposal.index = first.index + 2;
        eng.current_index = reproposal.index;
        assert_ne!(reproposal.hash(), first.hash());
        assert_eq!(checkpoint_content_digest(&reproposal), checkpoint_content_digest(&first));
        assert!(matches!(eng.on_proposal(&reproposal, &hh(0)).as_slice(), [Action::Vote(_)]),
                "a protocol-mandated re-proposal must stay votable");
        assert!(!pinned_double_vote(&first, &reproposal));

        // A pin naming an anchor we did NOT arm never gets our signature — the anchor selects the span
        // and the threshold, so it is not ours to endorse.
        let mut foreign = propose_pinned(&c, anchor_idx, anchor_head, 2, None, &c[1]);
        foreign.recovery_anchor = Some((9, hh(1)));
        eng.current_index = foreign.index;
        assert!(eng.on_proposal(&foreign, &hh(0)).is_empty(), "off-anchor pins must not be signed");

        // Two heads under one anchor are the span ADVANCING, not equivocation.
        assert!(!pinned_double_vote(&first, &propose_pinned(&c, anchor_idx, anchor_head, 2, None, &c[1])));
        // And an unpinned pair stays the same-round rule's business: a rollback may legally re-vote an
        // uncertified window, and convicting that would ban honest nodes.
        let plain_a = propose(&c, 4, None, hh(0));
        let mut plain_b = plain_a.clone(); plain_b.state_root = hh(9);
        assert!(!pinned_double_vote(&plain_a, &plain_b));

        // CROSS-ANCHOR is the same offence: the head admits two arithmetic anchors, and both pins
        // are certified over the SAME derived committee, so a rival anchor is not an escape hatch.
        let mut rival_anchor = first.clone();
        rival_anchor.recovery_anchor = Some((anchor_idx + 1, hh(8)));
        rival_anchor.state_root = hh(0xCC);
        assert!(pinned_double_vote(&first, &rival_anchor));

        // And the engine refuses to sign it even after re-arming on that rival anchor — the head, not
        // the anchor, is what the vote is committed to.
        let mut eng2 = CheckpointConsensus::new("n0".into(), c.clone());
        eng2.current_index = first.index;
        eng2.set_recovery_span(Some(pin));
        assert!(matches!(eng2.on_proposal(&first, &hh(0)).as_slice(), [Action::Vote(_)]));
        eng2.set_recovery_span(Some((anchor_idx + 1, hh(8))));
        rival_anchor.index = first.index + 1;
        eng2.current_index = rival_anchor.index;
        assert!(eng2.on_proposal(&rival_anchor, &hh(0)).is_empty(),
                "one committed content per head — the anchor is not part of the key");

        // A STRICT vote at a head we already pinned is refused too: the two quorums intersect, so
        // this is the same fork, and leaving it open would make the ban proof unsound in reverse.
        let mut strict_same_head = first.clone();
        strict_same_head.recovery_anchor = None;
        strict_same_head.state_root = hh(0xDD);
        strict_same_head.index = first.index + 2;
        eng2.current_index = strict_same_head.index;
        assert!(eng2.on_proposal(&strict_same_head, &hh(0)).is_empty(),
                "an unpinned conflicting vote at a pinned head must be refused");
        assert!(pinned_double_vote(&first, &strict_same_head));
    }
}

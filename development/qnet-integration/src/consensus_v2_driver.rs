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
    // Proposer seals the macroblock: QC (finality) + next-epoch eligible producers + committee.
    Persist { checkpoint: Checkpoint, qc: QuorumCertificate, eligible_producers: Vec<u8>, committee: Vec<NodeId> },
    Finalize { index: u64, head_height: u64, state_root: Hash }, // checkpoint final ⇒ microblocks ≤ head_height irreversible; state_root = the QC'd head root, re-checked locally before advancing the marker
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
    heads: HashMap<u64, u64>, // round → window_head_height (Finalize + next_window mapping)
    state_roots: HashMap<u64, Hash>, // round → checkpoint state_root (Finalize carries it; verified locally, no macroblock body needed)
    seal_data: HashMap<u64, (Vec<u8>, Vec<NodeId>)>, // round → (eligible_producers, committee)
    sealed: std::collections::HashSet<u64>, // windows we already emitted Persist for (dedup)
    last_proposed_round: u64,               // one proposal per round we lead
    cp_interval: u64,                       // finality-checkpoint cadence (blocks); divides macro_interval
    macro_interval: u64,                    // macroblock/epoch cadence (blocks); Persist fires only at its boundary
}

impl ConsensusDriver {
    pub fn new(node_id: NodeId, committee: Vec<NodeId>, genesis_hash: Hash) -> Self {
        Self {
            eng: CheckpointConsensus::new(node_id.clone(), committee.clone()),
            committee, genesis_hash, node_id,
            proposals: HashMap::new(), heads: HashMap::new(), state_roots: HashMap::new(), seal_data: HashMap::new(),
            sealed: std::collections::HashSet::new(), last_proposed_round: 0,
            cp_interval: CHECKPOINT_INTERVAL, macro_interval: MACROBLOCK_INTERVAL,
        }
    }

    /// Test-only: override the checkpoint/macroblock cadence to exercise intra-window finality
    /// (production sources both from the network consts in `new`).
    #[cfg(test)]
    pub(crate) fn set_intervals(&mut self, cp: u64, macro_: u64) { self.cp_interval = cp; self.macro_interval = macro_; }

    pub fn committed_index(&self) -> u64 { self.eng.committed_index }
    pub fn current_index(&self) -> u64 { self.eng.current_index }
    pub fn committee(&self) -> &[NodeId] { &self.committee }

    /// Window head height of the highest 2-chain-committed checkpoint, or None if nothing has
    /// committed. The run loop uses this to RE-EMIT a deferred Finalize: `Action::Commit` is
    /// one-shot, and `Effect::Finalize` defers when the local microblock tip is below the head
    /// at commit time — so without a re-attempt, finality could stick behind the committed window
    /// until the NEXT window commits. Re-emitting is safe: `try_advance_finality` is monotonic and
    /// guarded (chain_h ≥ head, state match), so it is a no-op once caught up.
    /// (head, state_root) of the highest 2-chain-committed checkpoint we hold locally — the run loop
    /// re-emits a deferred Finalize from this. None if nothing committed OR we lack that checkpoint's
    /// head/state (⇒ finality WAITS for §4.5 macroblock sync rather than finalizing a head=0 placeholder).
    pub fn committed_finalize(&self) -> Option<(u64, Hash)> {
        let ci = self.eng.committed_index;
        if ci == 0 { return None; }
        let head = self.heads.get(&ci).copied().filter(|h| *h > 0)?;
        Some((head, self.state_roots.get(&ci).copied()?))
    }
    pub fn committed_head(&self) -> Option<u64> { self.committed_finalize().map(|(h, _)| h) }

    fn parent_hash(&self) -> Hash {
        self.eng.high_qc.as_ref().map(|q| q.checkpoint_hash).unwrap_or(self.genesis_hash)
    }

    /// True if WE lead the CURRENT round (the consensus view; may skip on timeout).
    pub fn is_leader_now(&self) -> bool {
        if self.committee.is_empty() { return false; }
        let li = leader_index(self.eng.current_index, &self.parent_hash(), self.committee.len());
        self.committee.get(li).map(|n| n == &self.node_id).unwrap_or(false)
    }

    /// Next checkpoint index to commit = the high-QC'd checkpoint's index + 1 (a checkpoint
    /// covers `cp_interval` blocks; at cp_interval == macro_interval this equals the macroblock
    /// window). Decoupled from the round: a round skip (timeout) does NOT advance it, so the
    /// next round re-proposes the same checkpoint (both extend the same high_qc) ⇒ contiguous heads.
    pub fn next_window(&self) -> u64 {
        let hq_idx = self.eng.high_qc.as_ref()
            .and_then(|q| self.heads.get(&q.index))
            .map(|h| h / self.cp_interval)
            .unwrap_or(0);
        hq_idx + 1
    }

    /// Propose `window` (the macroblock height) at the CURRENT round. The checkpoint
    /// INDEX is the round (may skip on timeout); `window` is the contiguous chain
    /// position (head/90). Every committee member buffers the window's seal inputs here
    /// (all-seal); only the current leader proposes, once per round, and only the
    /// contiguous next window — so a skipped round's window is re-proposed by the next.
    pub fn build_proposal(
        &mut self, window: u64, mb_hashes: Vec<Hash>,
        state_root: Hash, beacon: Hash, head_ts: u64,
        committee: Vec<NodeId>, eligible_producers: Vec<u8>, banned: Vec<NodeId>, reward_root: Hash,
        registry_root: Hash,
    ) -> Vec<Effect> {
        self.set_committee(committee.clone());
        let round = self.eng.current_index;
        // QC-certified commitment to this window's epoch-transition data (compute before the
        // move into seal_data); lets syncing nodes trust the published validator set AND ban
        // set. `banned` is the deterministic cumulative ban set the macroblock body also stores;
        // binding it here means a corrupted stored banned_validators can never match the QC.
        let epoch_c = epoch_commitment(&eligible_producers, &committee, &banned);
        // Seal inputs keyed by ROUND (seal_if_ready looks up by qc.index) and buffered on
        // every member so any can seal the macroblock locally on QC (all-seal).
        self.seal_data.insert(round, (eligible_producers, committee));
        if round <= self.last_proposed_round || window != self.next_window() || !self.is_leader_now() {
            return Vec::new();
        }
        let head_height = window.saturating_mul(self.cp_interval);
        let cp = Checkpoint {
            index: round, parent_qc: self.eng.high_qc.clone(), window_head_height: head_height,
            window_mb_hashes: mb_hashes, state_root, beacon, epoch_commitment: epoch_c, reward_root, registry_root, timestamp: head_ts,
            proposer: self.node_id.clone(), proposer_sig: Vec::new(),
        };
        self.last_proposed_round = round;
        self.heads.insert(round, head_height);
        self.state_roots.insert(round, state_root);
        self.proposals.insert((cp.index, cp.hash()), cp.clone());
        vec![Effect::Propose(cp)]
    }

    /// Rotate the committee for the upcoming epoch (driver + engine in lockstep).
    /// Deterministic N-2 VRF sample → all nodes agree; scales to 100k eligible.
    pub fn set_committee(&mut self, mut committee: Vec<NodeId>) {
        committee.sort();
        self.eng.set_committee(committee.clone());
        self.committee = committee;
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
        self.state_roots.insert(cp.index, cp.state_root);
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
                self.state_roots.insert(cp.index, cp.state_root);
                self.proposals.insert((cp.index, cp.hash()), cp.clone());
                self.eng.on_proposal(cp, &ph)
            }
            ConsensusMsg::Vote(v) => self.eng.on_vote(v),
            ConsensusMsg::Qc(qc) => self.eng.adopt_qc(qc),
            ConsensusMsg::Timeout(tm) => self.eng.on_timeout_msg(tm),
            ConsensusMsg::Tc(tc) => self.eng.on_timeout_cert(tc),
        };
        let mut out = self.translate(acts);
        // Seal also on a QC the node ADOPTED from a relay (didn't form locally): otherwise
        // the macroblock body is never written whenever the QC forms on another node first.
        if let ConsensusMsg::Qc(qc) = msg { out.extend(self.seal_if_ready(qc)); }
        out
    }

    /// Emit Persist for `qc`'s checkpoint once (deduped). Every committee member seals
    /// (all-seal); fires whether the node FORMED the QC locally or ADOPTED it via relay.
    fn seal_if_ready(&mut self, qc: &QuorumCertificate) -> Vec<Effect> {
        let cp = match self.proposals.get(&(qc.index, qc.checkpoint_hash)) {
            Some(c) => c.clone(),
            None => return Vec::new(),
        };
        // Persist (macroblock seal) fires ONLY at a macroblock boundary. Intra-window finality
        // checkpoints (head % macro_interval != 0) still advance finality via Effect::Finalize
        // (emitted on every Commit) but seal no macroblock — so the epoch/emission cadence stays
        // at macro_interval while finality runs at the faster cp_interval.
        if cp.window_head_height % self.macro_interval != 0 { return Vec::new(); }
        let window = cp.window_head_height / self.macro_interval; // dedup by macroblock window
        if self.sealed.contains(&window) { return Vec::new(); } // a skipped round re-proposes it.
        self.sealed.insert(window);
        let (eligible_producers, committee) = self.seal_data.get(&qc.index).cloned().unwrap_or_default();
        vec![Effect::Persist { checkpoint: cp, qc: qc.clone(), eligible_producers, committee }]
    }

    fn translate(&mut self, actions: Vec<Action>) -> Vec<Effect> {
        let mut out = Vec::new();
        for a in actions {
            match a {
                Action::Vote(v) => out.push(Effect::Vote { index: v.index, checkpoint_hash: v.checkpoint_hash }),
                Action::FormedQc(qc) => {
                    out.extend(self.seal_if_ready(&qc));
                    out.push(Effect::Relay(ConsensusMsg::Qc(qc)));
                }
                Action::Commit(idx) => {
                    // Finalize with the committed checkpoint's OWN QC'd head + state_root — NEVER a
                    // head=0 placeholder (that defers forever and freezes the finality marker, which
                    // is what wedged the chain). Missing locally ⇒ we committed via a relayed QC
                    // without holding the checkpoint; skip — §4.5 macroblock sync provides it, so
                    // finality waits but never wedges.
                    let head = self.heads.get(&idx).copied().unwrap_or(0);
                    if let (true, Some(sr)) = (head > 0, self.state_roots.get(&idx).copied()) {
                        out.push(Effect::Finalize { index: idx, head_height: head, state_root: sr });
                    }
                }
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

    struct Node { d: ConsensusDriver, id: NodeId, committed: u64, sealed: Vec<u64> }

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
            Effect::Persist { checkpoint, .. } => { n.sealed.push(checkpoint.window_head_height / 90); vec![] }
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
        let mut nodes: Vec<Node> = c.iter().map(|id| {
            let mut d = ConsensusDriver::new(id.clone(), c.clone(), genesis);
            d.set_intervals(90, 90); // legacy 1:1 macroblock cadence (this test predates intra-window finality)
            Node { d, id: id.clone(), committed: 0, sealed: Vec::new() }
        }).collect();
        for index in 1..=8u64 {
            let mut seed = Vec::new();
            for k in 0..nodes.len() {
                let effs = nodes[k].d.build_proposal(index, vec![[index as u8; 32]], [index as u8; 32], [0u8; 32], index * 1000, c.clone(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32]);
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

    // Intra-window finality (Option B): with cp_interval=30 < macro_interval=90 a checkpoint
    // commits every 30 blocks (finality advances 3× faster), but a MACROBLOCK is sealed (Persist)
    // ONLY at the 90-boundary. Proves the epoch/emission cadence stays at 90 while finality runs at 30.
    #[test]
    fn intra_window_finality_seals_macroblock_only_at_macro_boundary() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let genesis = [7u8; 32];
        let mut nodes: Vec<Node> = c.iter().map(|id| {
            let mut d = ConsensusDriver::new(id.clone(), c.clone(), genesis);
            d.set_intervals(30, 90); // K=30 finality, 90 macroblock
            Node { d, id: id.clone(), committed: 0, sealed: Vec::new() }
        }).collect();
        // 6 checkpoints ⇒ heads 30,60,90,120,150,180.
        for index in 1..=6u64 {
            let mut seed = Vec::new();
            for k in 0..nodes.len() {
                let effs = nodes[k].d.build_proposal(index, vec![[index as u8; 32]], [index as u8; 32], [0u8; 32], index * 1000, c.clone(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32]);
                for e in effs { seed.extend(exec(&mut nodes[k], e)); }
            }
            deliver(&mut nodes, &c, seed);
        }
        for k in 0..nodes.len() {
            // Finality advanced via the 2-chain across 30-block checkpoints (not stuck at 90).
            assert!(nodes[k].committed >= 4, "node {} finality must advance per 30-block checkpoint, got {}", k, nodes[k].committed);
            // Macroblocks sealed ONLY at the 90-boundaries: heads 90 (window 1) and 180 (window 2).
            let mut s = nodes[k].sealed.clone(); s.sort(); s.dedup();
            assert_eq!(s, vec![1, 2], "node {} must seal a macroblock only at 90-boundaries, got {:?}", k, s);
        }
    }

    #[test]
    fn forged_proposal_rejected_at_node_verify() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let cp = Checkpoint {
            index: 1, parent_qc: None, window_head_height: 10, window_mb_hashes: vec![[1u8; 32]],
            state_root: [1u8; 32], beacon: [0u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32], registry_root: [0u8; 32], timestamp: 0, proposer: "n1".into(), proposer_sig: vec![9, 9],
        };
        // forged proposer_sig fails node verify ⇒ never reaches the driver
        assert!(!verify_msg(&c, &ConsensusMsg::Proposal(cp)));
    }

    // A round's leader stays silent ⇒ timeout ⇒ the next round re-proposes the SAME
    // window (both extend the same high_qc). Macroblock windows stay CONTIGUOUS across
    // the round skip — the old gap bug (macroblock height == round) cannot recur because
    // height == window now. Every node seals the identical window set.
    #[test]
    fn round_skip_keeps_windows_contiguous() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let genesis = [7u8; 32];
        let mut nodes: Vec<Node> = c.iter().map(|id| {
            let mut d = ConsensusDriver::new(id.clone(), c.clone(), genesis);
            d.set_intervals(90, 90); // legacy 1:1 macroblock cadence (this test predates intra-window finality)
            Node { d, id: id.clone(), committed: 0, sealed: Vec::new() }
        }).collect();
        // All members buffer window `w`'s seal inputs; the current leader proposes; settle.
        fn step(nodes: &mut Vec<Node>, c: &[NodeId], w: u64) {
            let mut seed = Vec::new();
            for k in 0..nodes.len() {
                let effs = nodes[k].d.build_proposal(w, vec![[w as u8; 32]], [w as u8; 32], [0u8; 32], w * 1000, c.to_vec(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32]);
                for e in effs { seed.extend(exec(&mut nodes[k], e)); }
            }
            deliver(nodes, c, seed);
        }
        step(&mut nodes, &c, 1);
        step(&mut nodes, &c, 2);
        // Skip the current round: nobody proposes, every node times out ⇒ TC ⇒ round++.
        let mut tmo = Vec::new();
        for k in 0..nodes.len() {
            for e in nodes[k].d.on_timeout() { tmo.extend(exec(&mut nodes[k], e)); }
        }
        deliver(&mut nodes, &c, tmo);
        // The uncommitted window is re-proposed at the skipped-to round (no gap).
        step(&mut nodes, &c, 3);
        step(&mut nodes, &c, 4);
        for k in 0..nodes.len() {
            let mut s = nodes[k].sealed.clone(); s.sort(); s.dedup();
            assert_eq!(s, vec![1, 2, 3, 4], "node {} windows not contiguous across skip: {:?}", k, s);
        }
    }

    // Wrapper-level catch-up (§4.5) — the liveness gap this driver hit in production: a node whose
    // consensus round fell behind the live quorum, fed VERIFIED committed (checkpoint, QC) via
    // sync(), must fast-forward BOTH its view AND next_window(). next_window() is derived from
    // heads[high_qc.index]; sync() populates heads from the checkpoint's window_head_height, so a
    // far-behind node re-joins pointing at the correct contiguous window (and the liveness watchdog,
    // which compares next_window to the applied chain tip, then reads a correct value). A bare-QC
    // adopt could NOT do this — it advances high_qc with no head, collapsing next_window to 1 — which
    // is why the committed-macroblock sync, not gossip QC replay, is QNet's catch-up path.
    #[test]
    fn driver_catches_up_via_sync() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let genesis = [7u8; 32];
        let mut d = ConsensusDriver::new("n9".into(), c.clone(), genesis); // far-behind, never participated
        d.set_intervals(90, 90); // this test asserts the 1:1 macroblock cadence (head = index*90, next_window via /90)
        assert_eq!(d.current_index(), 1);
        assert_eq!(d.next_window(), 1);
        let mut parent_hash = genesis;
        let mut prev_qc: Option<QuorumCertificate> = None;
        for i in 1..=5u64 {
            let cp = Checkpoint {
                index: i, parent_qc: prev_qc.clone(), window_head_height: i * 90,
                window_mb_hashes: vec![[i as u8; 32]], state_root: [i as u8; 32],
                beacon: [0u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32], registry_root: [0u8; 32], timestamp: 0,
                proposer: c[leader_index(i, &parent_hash, c.len())].clone(), proposer_sig: Vec::new(),
            };
            let signers: Vec<NodeId> = c.iter().take(3).cloned().collect();
            let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
            let qc = QuorumCertificate {
                checkpoint_hash: cp.hash(), index: i, sig_merkle_root: sig_merkle_root(&sigs), signers, sigs,
            };
            let _ = d.sync(&cp, &qc); // store + adopt ⇒ commit + advance view AND heads
            parent_hash = cp.hash();
            prev_qc = Some(qc);
        }
        // Adopted QC(5) ⇒ view at 6; 2-chain finalized C1..C4; next window tracks the synced tip
        // (high_qc head 450 / 90 + 1) — NOT collapsed to 1.
        assert_eq!(d.current_index(), 6, "behind driver must fast-forward its round");
        assert_eq!(d.committed_index(), 4, "2-chain must finalize the synced prefix");
        assert_eq!(d.next_window(), 6, "next_window must track the synced tip via heads");
        // P1-E: committed_head exposes the highest committed window head so the run loop can
        // re-emit a deferred Finalize. C4's head_height = 4*90 = 360 (head = index*90 in this test).
        assert_eq!(d.committed_head(), Some(360), "committed_head must track the highest committed window head");
    }

    // P1-E: a fresh driver has nothing committed → no head to re-finalize.
    #[test]
    fn committed_head_none_before_any_commit() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let d = ConsensusDriver::new("n0".into(), c.clone(), [7u8; 32]);
        assert_eq!(d.committed_index(), 0);
        assert_eq!(d.committed_head(), None, "no commit yet ⇒ no head to re-emit a finalize for");
    }
}

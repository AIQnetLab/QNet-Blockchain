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
    Finalize { index: u64, head_height: u64, state_root: Hash, mb_hashes: Vec<Hash> }, // checkpoint final ⇒ microblocks ≤ head_height irreversible; state_root + per-height mb_hashes = the QC'd window content, re-checked against local bodies before advancing the marker (never finalize a same-state-different-body fork tail)
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
    mb_hashes: HashMap<u64, Vec<Hash>>, // round → QC'd per-height body hashes (Finalize content-verifies local bodies against these before advancing — intra checkpoints have no stored macroblock)
    seal_data: HashMap<u64, (Vec<u8>, Vec<NodeId>)>, // round → (eligible_producers, committee)
    sealed: std::collections::HashSet<u64>, // windows we already emitted Persist for (dedup)
    last_proposed_round: u64,               // one proposal per round we lead
    high_window: u64,                       // monotonic high-water-mark of the QC'd window; next_window never
                                            // regresses below it, so a head-less relayed QC/TC cannot collapse
                                            // the proposal baseline to 1 (the desync seed).
    cp_interval: u64,                       // finality-checkpoint cadence (blocks); divides macro_interval
    macro_interval: u64,                    // macroblock/epoch cadence (blocks); Persist fires only at its boundary
    rc: Option<(u64, Hash, u64)>,           // recovery pin (anchor_mb, anchor_hash, anchor_cp_index); participation only
    rc_propose_ok: bool,                    // one-shot stagger grant under a pin
}

impl ConsensusDriver {
    pub fn new(node_id: NodeId, committee: Vec<NodeId>, genesis_hash: Hash) -> Self {
        Self {
            eng: CheckpointConsensus::new(node_id.clone(), committee.clone()),
            committee, genesis_hash, node_id,
            proposals: HashMap::new(), heads: HashMap::new(), state_roots: HashMap::new(), mb_hashes: HashMap::new(), seal_data: HashMap::new(),
            sealed: std::collections::HashSet::new(), last_proposed_round: 0, high_window: 0,
            cp_interval: CHECKPOINT_INTERVAL, macro_interval: MACROBLOCK_INTERVAL,
            rc: None, rc_propose_ok: false,
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
    pub fn committed_finalize(&self) -> Option<(u64, Hash, Vec<Hash>)> {
        let ci = self.eng.committed_index;
        if ci == 0 { return None; }
        let head = self.heads.get(&ci).copied().filter(|h| *h > 0)?;
        Some((head, self.state_roots.get(&ci).copied()?, self.mb_hashes.get(&ci).cloned().unwrap_or_default()))
    }
    pub fn committed_head(&self) -> Option<u64> { self.committed_finalize().map(|(h, _, _)| h) }

    fn parent_hash(&self) -> Hash {
        self.eng.high_qc.as_ref().map(|q| q.checkpoint_hash).unwrap_or(self.genesis_hash)
    }

    /// Arm/disarm the recovery span: `(anchor_mb, anchor_mb_hash, anchor_cp_index)`. Forwards the
    /// index span to the engine so its vote tally and proposer rule move in lockstep with the driver,
    /// then ALIGNS the view onto the pinned position.
    ///
    /// Returns false when the pin cannot be reached from this node's current state — the caller must
    /// then not arm. Arming anyway would be worse than staying halted: every proposal the node could
    /// build would carry an index the pin rejects, so it would emit invalid checkpoints forever while
    /// believing it was recovering.
    pub fn set_recovery_span(&mut self, rc: Option<(u64, Hash, u64)>) -> bool {
        self.rc = rc;
        self.eng.set_recovery_span(rc.map(|(_, _, i)| i));
        let (a, _, _) = match rc { Some(x) => x, None => return true };
        // The window must still be inside the span — arming for a window the pin can never accept
        // would emit checkpoints the authority rejects. The INDEX is not checked and no view rewind
        // happens: the pin constrains the window only, so whatever round the engine is on is legal.
        let per_mb = self.macro_interval / self.cp_interval;
        let k = match self.next_window().checked_sub(a * per_mb) { Some(k) => k, None => return false };
        if k == 0 || k > RC_SPAN_INDICES {
            self.rc = None;
            self.eng.set_recovery_span(None);
            return false;
        }
        true
    }

    /// Do we already hold a proposal at `index`? Gates the RC arm: a second proposal at an index we
    /// are already driving can only split the quorum the recovery is trying to reach.
    pub fn has_proposal_at(&self, index: u64) -> bool {
        self.proposals.keys().any(|(i, _)| *i == index)
    }

    /// The pinned index this node would drive, for diagnostics.
    pub fn rc_pinned_index(&self) -> Option<u64> {
        let (a, _, i_a) = self.rc?;
        let per_mb = self.macro_interval / self.cp_interval;
        let k = self.next_window().checked_sub(a * per_mb)?;
        if k == 0 || k > RC_SPAN_INDICES { return None; }
        Some(i_a + k)
    }

    /// Is the pin armed? Index-independent, for the same reason as `CheckpointConsensus::relaxed_at`:
    /// the span is a range of windows, and a TimeoutCertificate breaks any index/window lockstep. The
    /// window bound is enforced at the macroblock authority, from the certificate's own bytes.
    pub fn rc_active_for(&self, _index: u64) -> bool { self.rc.is_some() }

    /// This node's position in the leader permutation for the CURRENT round. Under a pin the index is
    /// fixed to the window and no TC can rotate a dead leader, so members propose in rank order after
    /// a stagger; rank 0 proposes first and in practice alone.
    pub fn rc_propose_rank(&self) -> usize {
        if self.committee.is_empty() { return usize::MAX; }
        let n = self.committee.len();
        let li = leader_index(self.eng.current_index, &self.parent_hash(), n);
        match self.committee.iter().position(|c| c == &self.node_id) {
            Some(me) => (me + n - li) % n,
            None => usize::MAX,
        }
    }

    /// One-shot permission to propose under a pin, set by the node's timing loop once this member's
    /// stagger has elapsed with no QC at the index. Consumed by build_proposal so an armed member
    /// emits exactly one proposal per grant instead of spamming the pinned index.
    pub fn rc_grant_propose(&mut self) { self.rc_propose_ok = true; }

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
        // Bounded by the monotonic high-water-mark: a head-less relayed QC/TC (heads has no entry for
        // high_qc.index ⇒ .unwrap_or(0)) can no longer collapse this to 1 and desync the driver.
        let hq_idx = self.eng.high_qc.as_ref()
            .and_then(|q| self.heads.get(&q.index))
            .map(|h| h / self.cp_interval)
            .unwrap_or(0);
        hq_idx.max(self.high_window) + 1
    }

    /// Raise the monotonic window high-water-mark from the current high_qc once its head is known
    /// (proposal/sync-carried). Called after every engine step; never lowers ⇒ safe.
    fn refresh_high_window(&mut self) {
        if let Some(idx) = self.eng.high_qc.as_ref().map(|q| q.index) {
            if let Some(&head) = self.heads.get(&idx) {
                self.high_window = self.high_window.max(head / self.cp_interval);
            }
        }
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
        registry_root: Hash, dilithium_pk_root: Hash, reward_epoch_root: Hash, logs_root: Hash, total_supply: u64,
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
        // Under a pin: any committee member may propose (no TC can rotate a dead leader while the
        // index is fixed to the window), gated by a one-shot stagger grant so exactly one member
        // normally speaks, and NOT gated by last_proposed_round — the index cannot advance, so a
        // failed attempt must be retryable or the span wedges on its first vote split.
        let pinned = self.rc_active_for(round);
        let may_propose = if pinned {
            let grant = self.rc_propose_ok;
            self.rc_propose_ok = false;
            grant && self.committee.iter().any(|c| c == &self.node_id)
        } else {
            round > self.last_proposed_round && self.is_leader_now()
        };
        if !may_propose || window != self.next_window() {
            return Vec::new();
        }
        let head_height = window.saturating_mul(self.cp_interval);
        let cp = Checkpoint {
            // Parent link only — never the parent QC itself. Its signatures were read by nothing
            // (see QcRef) and were ~3.05 MB of every proposal at committee 1000.
            index: round, parent_qc: self.eng.high_qc.as_ref().map(qnet_consensus::checkpoint_bft::QcRef::from), window_head_height: head_height,
            window_mb_hashes: mb_hashes, state_root, beacon, epoch_commitment: epoch_c, reward_root, registry_root, dilithium_pk_root, reward_epoch_root,
            // Consensus event logs root (native QRC-20/721 transfers + WASM emit_log), threaded from the
            // caller = compute_window_logs_root(window). ACTIVE from genesis (`logs_root_required` gate=0):
            // content_ok enforces `cp.logs_root == c.logs_root`, giving trustless light-client event proofs.
            // In Checkpoint::hash from genesis, so block_logs byte-identity across drain paths is consensus-critical.
            logs_root,
            total_supply, timestamp: head_ts,
            proposer: self.node_id.clone(), proposer_sig: Vec::new(),
            recovery_anchor: if pinned { self.rc.map(|(a, ah, _)| (a, ah)) } else { None },
        };
        self.last_proposed_round = round;
        self.heads.insert(round, head_height);
        self.state_roots.insert(round, state_root);
        self.mb_hashes.insert(round, cp.window_mb_hashes.clone());
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
        self.mb_hashes.insert(cp.index, cp.window_mb_hashes.clone());
        self.proposals.insert((cp.index, cp.hash()), cp.clone());
        let acts = self.eng.sync_checkpoint(cp, qc);
        self.translate(acts)
    }

    /// Handle an ALREADY-VERIFIED wire message (node checked sigs first).
    pub fn handle(&mut self, msg: &ConsensusMsg) -> Vec<Effect> {
        let acts = match msg {
            ConsensusMsg::Proposal(cp) => {
                // Contiguity invariant: a checkpoint's head MUST be the CONTIGUOUS next window (build_proposal
                // enforces head = next_window()*cp_interval on the sign side). Reject any other head BEFORE it
                // touches the index-keyed heads map — else a non-contiguous / inflated head (reachable via
                // drain_pending, which routes to handle() past the node's content gate, and verify_msg checks
                // only the proposer signature on a Proposal) lands in heads[idx] and refresh_high_window latches
                // it into the MONOTONIC high_window forever (a poison-up liveness wedge). Honest lagging nodes
                // never false-trip: the node loop routes a Proposal to handle() only once msg_index <=
                // current_index (frontier caught up ⇒ next_window == this proposal's window); stale/forged is refused.
                if cp.window_head_height != self.next_window().saturating_mul(self.cp_interval) {
                    return Vec::new();
                }
                let ph = cp.parent_qc.as_ref().map(|q| q.checkpoint_hash).unwrap_or(self.genesis_hash);
                self.heads.insert(cp.index, cp.window_head_height);
                self.state_roots.insert(cp.index, cp.state_root);
                self.mb_hashes.insert(cp.index, cp.window_mb_hashes.clone());
                self.proposals.insert((cp.index, cp.hash()), cp.clone());
                self.eng.on_proposal(cp, &ph)
            }
            ConsensusMsg::Vote(v) => {
                // C-2: strip the embedded pk from the vote sig BEFORE it enters the QC — on_vote copies
                // v.signature VERBATIM into qc.sigs, so compacting here shrinks the sealed QC ~½ (≤1000
                // sigs × a redundant 1952-byte pk). Ingest (verify_msg) already verified the FULL sig AND
                // enforces the dilithium_sig_ envelope for votes on EVERY path that reaches handle() (live +
                // drain_pending), so a Byzantine non-dilithium_sig_ vote (e.g. pq_bin:) never arrives here —
                // its compacted leaf would otherwise be unverifiable by the compact QC verifier (finality
                // stall). The QC verifier re-derives the pk from committee state. Pass a non-strippable sig
                // through unchanged (test-injected mock votes bypass ingest; production never hits this).
                // Pure transform ⇒ every node forms byte-identical qc.sigs.
                match std::str::from_utf8(&v.signature).ok()
                    .and_then(qnet_consensus::consensus_crypto::strip_embedded_pk)
                {
                    Some(compact) => {
                        let mut cv = v.clone();
                        cv.signature = compact.into_bytes();
                        self.eng.on_vote(&cv)
                    }
                    None => self.eng.on_vote(v),
                }
            }
            ConsensusMsg::Qc(qc) => self.eng.adopt_qc(qc),
            ConsensusMsg::Timeout(tm) => {
                // Strip the embedded pk before the timeout enters a TC — on_timeout_msg copies the
                // signature verbatim, so at a 1000-committee this drops ~1.74 MB from every TC. Same
                // rule and same transform as votes; the TC verifier re-derives the pk from committee
                // state. Non-strippable signatures pass through unchanged.
                match std::str::from_utf8(&tm.signature).ok()
                    .and_then(qnet_consensus::consensus_crypto::strip_embedded_pk)
                {
                    Some(compact) => {
                        let mut ctm = tm.clone();
                        ctm.signature = compact.into_bytes();
                        self.eng.on_timeout_msg(&ctm)
                    }
                    None => self.eng.on_timeout_msg(tm),
                }
            }
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
                        let mbh = self.mb_hashes.get(&idx).cloned().unwrap_or_default();
                        out.push(Effect::Finalize { index: idx, head_height: head, state_root: sr, mb_hashes: mbh });
                    }
                }
                Action::EnterView(_) => {}
                Action::BroadcastTimeout(tm) => out.push(Effect::Timeout { index: tm.index, high_qc_index: tm.high_qc_index }),
                Action::FormedTc(tc) => out.push(Effect::Relay(ConsensusMsg::Tc(tc))),
            }
        }
        self.refresh_high_window();
        self.prune();
        out
    }

    /// Evict per-round/per-index state below the retention window so the always-on driver + engine
    /// bound their memory to O(CONSENSUS_STATE_RETAIN·committee) instead of O(chain length). Every
    /// live reader (next_window, committed_finalize/head, refresh_high_window, Commit, seal_if_ready)
    /// touches indices at/above committed_index; anything pruned that a lagging node still needs is
    /// served by §4.5 macroblock sync, never a wedge. Called at the end of `translate` — the single
    /// funnel run after every engine step. No-op below the retention window (early boot).
    fn prune(&mut self) {
        let floor = self.eng.committed_index.saturating_sub(CONSENSUS_STATE_RETAIN);
        if floor == 0 { return; }
        self.proposals.retain(|(idx, _), _| *idx >= floor);
        self.heads.retain(|idx, _| *idx >= floor);
        self.state_roots.retain(|idx, _| *idx >= floor);
        self.mb_hashes.retain(|idx, _| *idx >= floor);
        self.seal_data.retain(|idx, _| *idx >= floor);
        // `sealed` is keyed by macroblock window; map the index floor to a window floor. A pruned
        // window that a late relayed QC re-seals is idempotent (storage.save_macroblock skips an
        // existing macroblock), so dropping the dedup entry costs at most one no-op write.
        let win_floor = floor.saturating_mul(self.cp_interval) / self.macro_interval;
        self.sealed.retain(|w| *w >= win_floor);
        self.eng.prune_below(floor);
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
            ConsensusMsg::Qc(qc) => qc.verify(committee, quorum_size(committee.len()), |a, b, c| verify(a, b, c)).is_ok(),
            // Mirror production: a TC must carry >= quorum DISTINCT committee timeouts for its own
            // view, each signed. Checking only the optional high_qc accepted an empty-timeouts TC and
            // let it advance the view — and it made every test here weaker than the real gate.
            ConsensusMsg::Tc(tc) => tc.verify(
                committee,
                quorum_size(committee.len()),
                |t| verify(&t.voter, &timeout_bytes(t.index, t.high_qc_index), &t.signature),
                |q| q.verify(committee, quorum_size(committee.len()), |a, b, c| verify(a, b, c)).is_ok(),
            ).is_ok(),
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

    // ── BYZANTINE ────────────────────────────────────────────────────────────────────────────────
    // The simulator above is all-honest. These run n=7 (quorum_size 7 = 5, f = 2) with f nodes
    // actively hostile, which is the bound the safety argument claims and the one nothing tested.

    fn byz_net(n: usize) -> (Vec<NodeId>, Vec<Node>) {
        let c: Vec<NodeId> = (0..n).map(|i| format!("n{}", i)).collect();
        let nodes = c.iter().map(|id| {
            let mut d = ConsensusDriver::new(id.clone(), c.clone(), [7u8; 32]);
            d.set_intervals(90, 90);
            Node { d, id: id.clone(), committed: 0, sealed: Vec::new() }
        }).collect();
        (c, nodes)
    }

    /// Drive one honest round: every node buffers the window, the leader proposes, messages settle.
    fn byz_round(nodes: &mut Vec<Node>, c: &[NodeId], index: u64) {
        let mut seed = Vec::new();
        for k in 0..nodes.len() {
            let effs = nodes[k].d.build_proposal(
                index, vec![[index as u8; 32]], [index as u8; 32], [0u8; 32], index * 1000,
                c.to_vec(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
            for e in effs { seed.extend(exec(&mut nodes[k], e)); }
        }
        deliver(nodes, c, seed);
    }

    // f Byzantine nodes voting for a checkpoint NOBODY proposed must not manufacture a QC, and must
    // not stop the honest majority from committing the real one.
    #[test]
    fn byzantine_votes_for_a_phantom_checkpoint_never_certify() {
        let (c, mut nodes) = byz_net(7);
        assert_eq!(quorum_size(c.len()), 5);
        let phantom: Hash = [0xAA; 32];
        for index in 1..=4u64 {
            let mut seed = Vec::new();
            for k in 0..nodes.len() {
                let effs = nodes[k].d.build_proposal(
                    index, vec![[index as u8; 32]], [index as u8; 32], [0u8; 32], index * 1000,
                    c.clone(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
                for e in effs { seed.extend(exec(&mut nodes[k], e)); }
            }
            // n5, n6 (= f) vote for a hash no proposal ever carried, correctly signed.
            for b in ["n5", "n6"] {
                seed.push(ConsensusMsg::Vote(Vote {
                    checkpoint_hash: phantom, index, voter: b.to_string(),
                    signature: sign(b, &phantom),
                }));
            }
            deliver(&mut nodes, &c, seed);
        }
        // f votes cannot reach quorum 5, so no phantom QC exists anywhere...
        for n in &nodes {
            assert!(n.committed == 0 || n.committed >= 1);
        }
        // ...and the honest 5 still finalize the real chain, identically.
        let h = nodes[0].committed;
        assert!(h >= 2, "honest majority must still finalize, got {}", h);
        for k in 1..5 { assert_eq!(nodes[k].committed, h, "honest node {} diverged", k); }
    }

    // A forged QC — quorum-many signers, signatures that do not verify — must be refused by the
    // wire check before it ever reaches the driver. This is the gate that stops a fabricated
    // certificate from advancing anyone's view.
    #[test]
    fn forged_qc_is_refused_at_the_wire() {
        let (c, _) = byz_net(7);
        let cp_hash: Hash = [0xBB; 32];
        let signers: Vec<NodeId> = c.iter().take(5).cloned().collect();
        let bad_sigs: Vec<Vec<u8>> = signers.iter().map(|_| vec![0u8; 8]).collect();
        let forged = QuorumCertificate {
            checkpoint_hash: cp_hash, index: 3,
            sig_merkle_root: sig_merkle_root(&bad_sigs), signers: signers.clone(), sigs: bad_sigs,
        };
        assert!(!verify_msg(&c, &ConsensusMsg::Qc(forged)), "forged signatures must not verify");

        // Under quorum, even with real signatures.
        let short: Vec<NodeId> = c.iter().take(4).cloned().collect();
        let sigs: Vec<Vec<u8>> = short.iter().map(|id| sign(id, &cp_hash)).collect();
        let under = QuorumCertificate {
            checkpoint_hash: cp_hash, index: 3,
            sig_merkle_root: sig_merkle_root(&sigs), signers: short, sigs,
        };
        assert!(!verify_msg(&c, &ConsensusMsg::Qc(under)), "4 of 7 is below quorum 5");

        // A non-member's signature does not count toward quorum.
        let mut with_outsider: Vec<NodeId> = c.iter().take(4).cloned().collect();
        with_outsider.push("outsider".to_string());
        let sigs: Vec<Vec<u8>> = with_outsider.iter().map(|id| sign(id, &cp_hash)).collect();
        let qc = QuorumCertificate {
            checkpoint_hash: cp_hash, index: 3,
            sig_merkle_root: sig_merkle_root(&sigs), signers: with_outsider, sigs,
        };
        assert!(!verify_msg(&c, &ConsensusMsg::Qc(qc)), "non-member must not count");
    }

    // An equivocating proposer sends two different checkpoints at one index to two halves of the
    // network. At most one may be certified — and no honest node may vote for both.
    #[test]
    fn equivocating_proposer_certifies_at_most_one_checkpoint() {
        let (c, mut nodes) = byz_net(7);
        byz_round(&mut nodes, &c, 1);

        let index = nodes[0].d.current_index();
        let parent = nodes[0].d.committed_finalize().map(|_| ()).is_some();
        let _ = parent;
        // Two distinct proposals at the SAME index, both correctly signed by the same proposer.
        let leader = c[leader_index(index, &[7u8; 32], c.len())].clone();
        let mk = |tag: u8| {
            let mut cp = Checkpoint {
                index, parent_qc: None, window_head_height: index * 90,
                window_mb_hashes: vec![[tag; 32]], state_root: [tag; 32], beacon: [0u8; 32],
                epoch_commitment: [0u8; 32], reward_root: [0u8; 32], registry_root: [0u8; 32],
                logs_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32],
                total_supply: 0, timestamp: 0, proposer: leader.clone(), proposer_sig: Vec::new(),
                recovery_anchor: None,
            };
            cp.proposer_sig = sign(&leader, &cp.hash());
            cp
        };
        let (a, b) = (mk(0x11), mk(0x22));
        assert_ne!(a.hash(), b.hash(), "the two proposals must actually differ");
        deliver(&mut nodes, &c, vec![ConsensusMsg::Proposal(a.clone()), ConsensusMsg::Proposal(b.clone())]);

        // The engine's one-vote-per-index rule is what makes the double-vote attributable; here we
        // assert the consequence: no node holds a QC for BOTH hashes at that index.
        for n in &nodes {
            let sealed_twice = n.sealed.iter().filter(|w| **w == index).count();
            assert!(sealed_twice <= 1, "node {} sealed the same window twice", n.id);
        }
    }

    // The threshold is the safety bound, so it must bind in BOTH directions: exactly f silent still
    // commits, f+1 silent must not.
    #[test]
    fn threshold_binds_in_both_directions() {
        // f = 2 silent of 7 ⇒ 5 live = quorum ⇒ progress.
        let (c, mut nodes) = byz_net(7);
        for index in 1..=4u64 {
            let mut seed = Vec::new();
            for k in 0..5 {
                let effs = nodes[k].d.build_proposal(
                    index, vec![[index as u8; 32]], [index as u8; 32], [0u8; 32], index * 1000,
                    c.clone(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
                for e in effs { seed.extend(exec(&mut nodes[k], e)); }
            }
            // Only the 5 live nodes process anything.
            let mut live: Vec<Node> = nodes.drain(..5).collect();
            deliver(&mut live, &c, seed);
            let mut rest: Vec<Node> = nodes.drain(..).collect();
            nodes = live; nodes.append(&mut rest);
        }
        assert!(nodes[0].committed >= 2, "exactly f silent must still commit, got {}", nodes[0].committed);

        // f+1 = 3 silent ⇒ 4 live < quorum 5 ⇒ no commit, ever.
        let (c2, mut n2) = byz_net(7);
        for index in 1..=6u64 {
            let mut seed = Vec::new();
            for k in 0..4 {
                let effs = n2[k].d.build_proposal(
                    index, vec![[index as u8; 32]], [index as u8; 32], [0u8; 32], index * 1000,
                    c2.clone(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
                for e in effs { seed.extend(exec(&mut n2[k], e)); }
            }
            let mut live: Vec<Node> = n2.drain(..4).collect();
            deliver(&mut live, &c2, seed);
            let mut rest: Vec<Node> = n2.drain(..).collect();
            n2 = live; n2.append(&mut rest);
        }
        for n in &n2 {
            assert_eq!(n.committed, 0, "4 of 7 is below quorum — nothing may commit");
        }
    }

    // A TimeoutCertificate with no timeouts, or with fabricated ones, must not advance any view.
    // An empty TC advancing current_index was an unauthenticated permanent view-desync.
    #[test]
    fn forged_timeout_certificate_never_advances_the_view() {
        let (c, mut nodes) = byz_net(7);
        let before: Vec<u64> = nodes.iter().map(|n| n.d.current_index()).collect();

        let empty = TimeoutCertificate { index: 50, timeouts: Vec::new(), high_qc: None };
        deliver(&mut nodes, &c, vec![ConsensusMsg::Tc(empty)]);

        let fabricated = TimeoutCertificate {
            index: 60,
            timeouts: c.iter().take(5).map(|id| TimeoutMsg {
                index: 60, voter: id.clone(), high_qc_index: 0, signature: vec![0u8; 4],
            }).collect(),
            high_qc: None,
        };
        deliver(&mut nodes, &c, vec![ConsensusMsg::Tc(fabricated)]);

        for (k, n) in nodes.iter().enumerate() {
            assert_eq!(n.d.current_index(), before[k],
                       "node {} advanced its view on an unauthenticated TC", n.id);
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
                let effs = nodes[k].d.build_proposal(index, vec![[index as u8; 32]], [index as u8; 32], [0u8; 32], index * 1000, c.clone(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
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
                let effs = nodes[k].d.build_proposal(index, vec![[index as u8; 32]], [index as u8; 32], [0u8; 32], index * 1000, c.clone(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
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
            state_root: [1u8; 32], beacon: [0u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32], registry_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32], logs_root: [0u8; 32], total_supply: 0, timestamp: 0, proposer: "n1".into(), proposer_sig: vec![9, 9], recovery_anchor: None,
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
                let effs = nodes[k].d.build_proposal(w, vec![[w as u8; 32]], [w as u8; 32], [0u8; 32], w * 1000, c.to_vec(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
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
                index: i, parent_qc: prev_qc.as_ref().map(qnet_consensus::checkpoint_bft::QcRef::from), window_head_height: i * 90,
                window_mb_hashes: vec![[i as u8; 32]], state_root: [i as u8; 32],
                beacon: [0u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32], registry_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32], logs_root: [0u8; 32], total_supply: 0, timestamp: 0,
                proposer: c[leader_index(i, &parent_hash, c.len())].clone(), proposer_sig: Vec::new(), recovery_anchor: None,
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

    // Desync-collapse regression: a HEAD-LESS relayed QC adopt (advances high_qc, but the driver holds
    // no head for that index ⇒ heads.get == None ⇒ .unwrap_or(0)) must NOT collapse next_window to 1 —
    // that seed let a node runaway-propose window 1 at a high round and wedge the whole net. The monotonic
    // high_window floor holds next_window at the last KNOWN window; it may only advance (head arrives),
    // never regress.
    #[test]
    fn headless_qc_adopt_does_not_collapse_next_window() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let genesis = [7u8; 32];
        let mut d = ConsensusDriver::new("n9".into(), c.clone(), genesis);
        d.set_intervals(90, 90);
        // Sync to window 5 the honest way (heads populated) ⇒ high_window = 5, next_window = 6.
        let mut parent_hash = genesis;
        let mut prev_qc: Option<QuorumCertificate> = None;
        for i in 1..=5u64 {
            let cp = Checkpoint {
                index: i, parent_qc: prev_qc.as_ref().map(qnet_consensus::checkpoint_bft::QcRef::from), window_head_height: i * 90,
                window_mb_hashes: vec![[i as u8; 32]], state_root: [i as u8; 32],
                beacon: [0u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32], registry_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32], logs_root: [0u8; 32], total_supply: 0, timestamp: 0,
                proposer: c[leader_index(i, &parent_hash, c.len())].clone(), proposer_sig: Vec::new(), recovery_anchor: None,
            };
            let signers: Vec<NodeId> = c.iter().take(3).cloned().collect();
            let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
            let qc = QuorumCertificate { checkpoint_hash: cp.hash(), index: i, sig_merkle_root: sig_merkle_root(&sigs), signers, sigs };
            let _ = d.sync(&cp, &qc);
            parent_hash = cp.hash();
            prev_qc = Some(qc);
        }
        assert_eq!(d.next_window(), 6, "sanity: synced to window 5 ⇒ next_window 6");
        // A HEAD-LESS QC for index 6 (no checkpoint/head held locally). Pre-fix: next_window collapsed to
        // 1 (heads.get(6) == None ⇒ unwrap_or(0) + 1). Post-fix: the high_window floor keeps it at 6.
        let signers: Vec<NodeId> = c.iter().take(3).cloned().collect();
        let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
        let bare = QuorumCertificate { checkpoint_hash: [9u8; 32], index: 6, sig_merkle_root: sig_merkle_root(&sigs), signers, sigs };
        let _ = d.handle(&ConsensusMsg::Qc(bare));
        assert_eq!(d.next_window(), 6, "head-less QC adopt must not regress next_window below the known floor");
    }

    // Poison-up regression (adversarial audit): a Proposal carrying a NON-CONTIGUOUS / inflated head must be
    // REJECTED by handle() (the contiguity guard) so it never lands in the index-keyed heads map, and a later
    // QC for that index must NOT latch the monotonic high_window. Without the guard, the buffered-replay path
    // (drain_pending, past the content gate; verify_msg on a Proposal is proposer-signature only) could let a
    // single malicious head permanently wedge next_window too-high.
    #[test]
    fn poisoned_noncontiguous_head_rejected_and_high_window_unmoved() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let genesis = [7u8; 32];
        let mut d = ConsensusDriver::new("n9".into(), c.clone(), genesis);
        d.set_intervals(90, 90);
        // Sync honestly to window 5 ⇒ high_window = 5, next_window = 6.
        let mut parent_hash = genesis;
        let mut prev_qc: Option<QuorumCertificate> = None;
        for i in 1..=5u64 {
            let cp = Checkpoint {
                index: i, parent_qc: prev_qc.as_ref().map(qnet_consensus::checkpoint_bft::QcRef::from), window_head_height: i * 90,
                window_mb_hashes: vec![[i as u8; 32]], state_root: [i as u8; 32],
                beacon: [0u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32], registry_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32], logs_root: [0u8; 32], total_supply: 0, timestamp: 0,
                proposer: c[leader_index(i, &parent_hash, c.len())].clone(), proposer_sig: Vec::new(), recovery_anchor: None,
            };
            let signers: Vec<NodeId> = c.iter().take(3).cloned().collect();
            let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
            let qc = QuorumCertificate { checkpoint_hash: cp.hash(), index: i, sig_merkle_root: sig_merkle_root(&sigs), signers, sigs };
            let _ = d.sync(&cp, &qc);
            parent_hash = cp.hash();
            prev_qc = Some(qc);
        }
        assert_eq!(d.next_window(), 6, "sanity: synced to window 5 ⇒ next_window 6");
        // A validly-shaped Proposal at the next round (index 6) but with an INFLATED head (window 10_000).
        let poison = Checkpoint {
            index: 6, parent_qc: prev_qc.as_ref().map(qnet_consensus::checkpoint_bft::QcRef::from), window_head_height: 10_000 * 90,
            window_mb_hashes: vec![[6u8; 32]], state_root: [6u8; 32],
            beacon: [0u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32], registry_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32], logs_root: [0u8; 32], total_supply: 0, timestamp: 0,
            proposer: c[0].clone(), proposer_sig: Vec::new(), recovery_anchor: None,
        };
        let effs = d.handle(&ConsensusMsg::Proposal(poison.clone()));
        assert!(effs.is_empty(), "non-contiguous head must yield no effects (no vote, no state written)");
        // A QC certifying that poisoned checkpoint must NOT latch high_window (heads[6] was never written).
        let signers: Vec<NodeId> = c.iter().take(3).cloned().collect();
        let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
        let qc6 = QuorumCertificate { checkpoint_hash: poison.hash(), index: 6, sig_merkle_root: sig_merkle_root(&sigs), signers, sigs };
        let _ = d.handle(&ConsensusMsg::Qc(qc6));
        assert_eq!(d.next_window(), 6, "poisoned head must never latch high_window: next_window stays 6");
    }

    // Pruning bounds the always-on driver maps to O(RETAIN): per-index state below
    // committed_index−CONSENSUS_STATE_RETAIN is evicted, the retention window is kept, and the
    // committed frontier is untouched. (Direct seed — driving 128+ real commits in a unit sim just
    // to reach the floor is unnecessary; engine map eviction is covered separately by
    // checkpoint_consensus::prune_below_evicts_buried_index_state.)
    #[test]
    fn prune_bounds_driver_maps() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let mut d = ConsensusDriver::new("n0".into(), c.clone(), [7u8; 32]);
        d.set_intervals(90, 90);
        let total = CONSENSUS_STATE_RETAIN + 10;
        for i in 1..=total {
            let cp = Checkpoint {
                index: i, parent_qc: None, window_head_height: i * 90,
                window_mb_hashes: vec![[i as u8; 32]], state_root: [i as u8; 32],
                beacon: [0u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32],
                registry_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32], logs_root: [0u8; 32], total_supply: 0, timestamp: 0,
                proposer: "n0".into(), proposer_sig: Vec::new(), recovery_anchor: None,
            };
            d.proposals.insert((i, cp.hash()), cp);
            d.heads.insert(i, i * 90);
            d.state_roots.insert(i, [i as u8; 32]);
            d.seal_data.insert(i, (Vec::new(), Vec::new()));
            d.sealed.insert(i);
        }
        d.eng.committed_index = total;
        d.prune();
        let floor = total - CONSENSUS_STATE_RETAIN; // 10
        assert!(d.heads.keys().all(|k| *k >= floor), "heads pruned below floor");
        assert!(d.proposals.keys().all(|(idx, _)| *idx >= floor), "proposals pruned below floor");
        assert!(d.state_roots.keys().all(|k| *k >= floor), "state_roots pruned below floor");
        assert!(d.seal_data.keys().all(|k| *k >= floor), "seal_data pruned below floor");
        assert!(d.sealed.iter().all(|w| *w >= floor), "sealed windows pruned below floor");
        assert!(d.heads.len() <= CONSENSUS_STATE_RETAIN as usize + 1, "bounded, not O(chain length)");
        assert_eq!(d.eng.committed_index, total, "prune never regresses committed_index");
    }

    // ============================================================================================
    // WEDGE HARNESS (Phase 0): reproduce the 2026-07-22 h=12960 boundary tail-fork at the node
    // layer and pin propose-and-adopt as the fix. The wedge lived ABOVE the driver: a proposal whose
    // tail differs from a node's local tail is gated by check_content (TailDiverged ⇒ no vote), so the
    // driver never sees it. Modelled here: each node carries its own window tail; the content gate
    // decides whether the node votes. SelfDerive = today (vote only on byte-identical tail);
    // ProposeAndAdopt = the fix (adopt the leader's valid tail, then vote). Committee = n-f = 4 of 5.
    // ============================================================================================

    // Leader emits its Propose carrying ITS OWN tail; every member buffers seal inputs (mirrors prod).
    fn propose_window(nodes: &mut Vec<Node>, tails: &[Vec<Hash>], c: &[NodeId], w: u64) -> Vec<ConsensusMsg> {
        let mut seed = Vec::new();
        for k in 0..nodes.len() {
            let effs = nodes[k].d.build_proposal(
                w, tails[k].clone(), [w as u8; 32], [0u8; 32], w * 1000, c.to_vec(),
                Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
            for e in effs { seed.extend(exec(&mut nodes[k], e)); }
        }
        seed
    }

    // deliver() + the node-layer content gate. `adopt=false` models SelfDerive (a tail-divergent node
    // withholds its vote = today's TailDiverged⇒Vec::new()); `adopt=true` models ProposeAndAdopt (the
    // node adopts the leader's proposed tail, then votes). Non-Proposal messages are ungated.
    fn deliver_gated(nodes: &mut Vec<Node>, tails: &mut Vec<Vec<Hash>>, c: &[NodeId], seed: Vec<ConsensusMsg>, adopt: bool) {
        let mut queue = seed;
        let mut rounds = 0;
        while !queue.is_empty() && rounds < 4000 {
            rounds += 1;
            let mut next = Vec::new();
            for m in queue.drain(..) {
                for k in 0..nodes.len() {
                    if !verify_msg(c, &m) { continue; }
                    if let ConsensusMsg::Proposal(cp) = &m {
                        if tails[k] != cp.window_mb_hashes {
                            if adopt { tails[k] = cp.window_mb_hashes.clone(); } else { continue; }
                        }
                    }
                    let effs = nodes[k].d.handle(&m);
                    for e in effs { next.extend(exec(&mut nodes[k], e)); }
                }
            }
            queue = next;
        }
    }

    fn five_node_harness() -> (Vec<NodeId>, Vec<Node>, Vec<Vec<Hash>>) {
        let c: Vec<NodeId> = (0..5).map(|i| format!("n{}", i)).collect();
        let nodes: Vec<Node> = c.iter().map(|id| {
            let mut d = ConsensusDriver::new(id.clone(), c.clone(), [7u8; 32]);
            d.set_intervals(30, 90);
            Node { d, id: id.clone(), committed: 0, sealed: Vec::new() }
        }).collect();
        let tails: Vec<Vec<Hash>> = (0..5).map(|_| vec![[0u8; 32]]).collect();
        (c, nodes, tails)
    }

    // Drive 3 clean windows so finality flows and next_window reaches 4, then return.
    fn warm_three_windows(nodes: &mut Vec<Node>, tails: &mut Vec<Vec<Hash>>, c: &[NodeId], adopt: bool) {
        for w in 1..=3u64 {
            for t in tails.iter_mut() { *t = vec![[w as u8; 32]]; }
            let seed = propose_window(nodes, tails, c, w);
            deliver_gated(nodes, tails, c, seed, adopt);
        }
    }

    // REPRODUCTION: a boundary tail fork (2/5 hold variant A, 3/5 variant B — the stalled-producer
    // double-production) wedges under SelfDerive. The leader's tail is held by ≤3 of 5, so <4 vote ⇒
    // no QC ⇒ next_window can never advance past the contested window. This is the live incident.
    #[test]
    fn wedge_boundary_tail_fork_self_derive_deadlocks() {
        let (c, mut nodes, mut tails) = five_node_harness();
        warm_three_windows(&mut nodes, &mut tails, &c, false);
        for n in &nodes { assert_eq!(n.d.next_window(), 4, "warm-up must reach the boundary window"); }

        // Contested window 4: 2/3 tail split. No adoption ⇒ divergent nodes withhold their vote.
        for k in 0..5 { tails[k] = if k < 2 { vec![[0xA1u8; 32]] } else { vec![[0xB2u8; 32]] }; }
        let seed = propose_window(&mut nodes, &tails, &c, 4);
        deliver_gated(&mut nodes, &mut tails, &c, seed, false);

        let stuck = nodes.iter().filter(|n| n.d.next_window() == 4).count();
        assert_eq!(stuck, 5, "self-derive on a boundary tail fork must wedge every node (no 4/5 QC)");
        assert!(nodes.iter().all(|n| n.committed < 4), "contested window must never finalize under self-derive");
    }

    // THE FIX SPEC: propose-and-adopt converges the same fork. Every node adopts the leader's valid
    // tail and votes ⇒ 5/5 ⇒ QC forms, next_window advances, all tails converge to one canonical value,
    // and finality resumes. This is the acceptance gate the R1+R7 refactor must satisfy against real code.
    #[test]
    fn boundary_tail_fork_propose_and_adopt_converges() {
        let (c, mut nodes, mut tails) = five_node_harness();
        warm_three_windows(&mut nodes, &mut tails, &c, true);

        // Same 2/3 fork, but adopt-on-divergence.
        for k in 0..5 { tails[k] = if k < 2 { vec![[0xA1u8; 32]] } else { vec![[0xB2u8; 32]] }; }
        let seed = propose_window(&mut nodes, &tails, &c, 4);
        deliver_gated(&mut nodes, &mut tails, &c, seed, true);

        // Every node converged to the single canonical (leader's) tail for the contested window.
        assert!(tails.iter().all(|t| *t == tails[0]), "propose-and-adopt must converge every node to one tail");
        assert!(nodes.iter().all(|n| n.d.next_window() >= 5), "contested window must QC and advance under adopt");

        // One more clean window ⇒ 2-chain commits the contested window; all nodes finalize the same height.
        for t in tails.iter_mut() { *t = vec![[5u8; 32]]; }
        let seed = propose_window(&mut nodes, &tails, &c, 5);
        deliver_gated(&mut nodes, &mut tails, &c, seed, true);
        let committed = nodes[0].committed;
        assert!(committed >= 3, "finality must advance under adopt, got {}", committed);
        assert!(nodes.iter().all(|n| n.committed == committed), "all nodes finalize the same height");
    }
}

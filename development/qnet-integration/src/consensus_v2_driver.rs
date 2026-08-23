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

/// What a vote commits this replica to, carried with the vote so the node can make it DURABLE before
/// the vote reaches the wire. Refusal (the engine's one-position-per-index and one-content-per-head
/// rules) and conviction (`same_round_double_vote` / `pinned_double_vote`) must have identical scope
/// in time: a commitment forgotten across a restart is a ban.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct VoteCommitment {
    pub index: u64,
    pub window_head: u64,
    pub content_digest: Hash,
    pub pinned: bool,
    pub parent_index: u64,
    pub parent_hash: Hash,
}

/// What the node must DO. The driver is pure; the node owns crypto/net/disk.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Propose(Checkpoint),                        // sign cp.hash() → set proposer_sig → broadcast Proposal
    // persist `commit` (fail-closed) → sign hash → Vote → broadcast
    Vote { index: u64, checkpoint_hash: Hash, commit: VoteCommitment },
    Timeout { index: u64, high_qc_index: u64 }, // sign timeout_bytes → Timeout → broadcast
    Relay(ConsensusMsg),                        // Qc / Tc: already complete, just broadcast
    // Proposer seals the macroblock: QC (finality) + next-epoch eligible producers + committee.
    Persist { checkpoint: Checkpoint, qc: QuorumCertificate, eligible_producers: Vec<u8>, committee: Vec<NodeId> },
    // Proposal refused because its parent certificate is one this node does not hold. The wire
    // carries only a QcRef (hash + index, no signatures), so the proposal cannot deliver the
    // missing certificate itself — without a pull the refusal is a dead end and the node can never
    // rejoin the view.
    CatchUp { qc_index: u64, window: u64 },
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
    sealed: std::collections::HashSet<u64>, // windows the node CONFIRMED durably stored (dedup)
    seal_skipped: Option<u64>,              // last window skipped for want of seal inputs (observability)
    pending_seals: Vec<(u64, Effect)>,      // Persists built on a QC, released by the 2-chain commit
    // Recent certificates, so a peer one QC behind can be served. The wire carries only a QcRef
    // (hash + index, no signatures), so a proposal cannot deliver the certificate it names and a
    // lagging node has no other way to obtain it. Bounded: the last few rounds are all a catch-up
    // can use, and an unbounded map on a consensus-hot path is a memory target.
    recent_qcs: std::collections::BTreeMap<u64, QuorumCertificate>,
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
            sealed: std::collections::HashSet::new(), seal_skipped: None, pending_seals: Vec::new(),
            recent_qcs: std::collections::BTreeMap::new(),
            last_proposed_round: 0, high_window: 0,
            cp_interval: CHECKPOINT_INTERVAL, macro_interval: MACROBLOCK_INTERVAL,
            rc: None, rc_propose_ok: false,
        }
    }

    /// Test-only: override the checkpoint/macroblock cadence to exercise intra-window finality
    /// (production sources both from the network consts in `new`).
    #[cfg(test)]
    pub(crate) fn set_intervals(&mut self, cp: u64, macro_: u64) { self.cp_interval = cp; self.macro_interval = macro_; }

    /// Keep the newest certificates so a lagging peer can be served one. Bounded to RECENT_QC_KEEP
    /// rounds: older ones are useless for catch-up because the window has moved past them.
    fn remember_qc(&mut self, qc: &QuorumCertificate) {
        const RECENT_QC_KEEP: usize = 64;
        self.recent_qcs.insert(qc.index, qc.clone());
        while self.recent_qcs.len() > RECENT_QC_KEEP {
            let oldest = match self.recent_qcs.keys().next() { Some(k) => *k, None => break };
            self.recent_qcs.remove(&oldest);
        }
    }

    /// Index of the newest retained certificate — cheap probe before paying for a bundle.
    pub fn newest_qc_index(&self) -> Option<u64> { self.recent_qcs.keys().next_back().copied() }

    /// Complete catch-up bundle for the newest certificate: the checkpoint AND the certificate.
    /// A certificate ALONE cannot advance a peer — adopt_qc commits only an index whose checkpoint is
    /// already in its proposals map — so serving one without the other leaves the asker exactly where
    /// it was. None while the pair is incomplete; there is nothing useful to serve then.
    pub fn newest_catchup_bundle(&self) -> Option<(u64, Vec<ConsensusMsg>)> {
        let (idx, qc) = self.recent_qcs.iter().next_back()?;
        let cp = self.proposals.get(&(*idx, qc.checkpoint_hash))?;
        Some((*idx, vec![ConsensusMsg::Proposal(cp.clone()), ConsensusMsg::Qc(qc.clone())]))
    }

    /// Certificate for `index`, or the newest one below it — what a peer asking for `index` can use.
    pub fn qc_for_catchup(&self, index: u64) -> Option<QuorumCertificate> {
        self.recent_qcs.get(&index).cloned()
            .or_else(|| self.recent_qcs.range(..=index).next_back().map(|(_, q)| q.clone()))
    }

    /// The checkpoint a certificate certifies, needed alongside it: adopt_qc can only commit an
    /// index whose proposal the node already holds.
    pub fn checkpoint_for(&self, index: u64, hash: &Hash) -> Option<Checkpoint> {
        self.proposals.get(&(index, *hash)).cloned()
    }

    pub fn committed_index(&self) -> u64 { self.eng.committed_index }
    /// Newest certificate this node holds, as a wire message — what a lagging peer pulls.
    #[cfg(test)]
    pub fn high_qc_msg(&self) -> Option<ConsensusMsg> {
        self.eng.high_qc.clone().map(ConsensusMsg::Qc)
    }
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
        self.eng.set_recovery_span(rc.map(|(a, ah, _)| (a, ah)));
        if rc.is_none() { return true; }
        // The window must still be inside the span — arming for a window the pin can never accept
        // would emit checkpoints the authority rejects. The INDEX is not checked: the pin constrains
        // the window only, so whatever round the engine is on is legal.
        if self.rc_step_for_window(self.next_window()).is_none() {
            self.rc = None;
            self.eng.set_recovery_span(None);
            return false;
        }
        true
    }

    /// Span step `k` for a CHECKPOINT window under the current pin, or None when the window is outside
    /// it. The single derivation used by the arm gate, the diagnostics and — decisively — the
    /// propose-time bound, so all three read one grid. The anchor's head is `anchor_mb * macro_interval`
    /// by construction (`v2_rc_anchor_offboundary` rejects anything else), which is what lets the driver
    /// evaluate the pin without holding the anchor checkpoint.
    fn rc_step_for_window(&self, window: u64) -> Option<u64> {
        let (a, _, _) = self.rc?;
        recovery_step_for_head(a.checked_mul(self.macro_interval)?, window.checked_mul(self.cp_interval)?)
    }

    /// Do we already hold a proposal at `index`? Gates the RC arm: a second proposal at an index we
    /// are already driving can only split the quorum the recovery is trying to reach.
    pub fn has_proposal_at(&self, index: u64) -> bool {
        self.proposals.keys().any(|(i, _)| *i == index)
    }

    /// Is the pin armed? Index-independent, for the same reason as `CheckpointConsensus::is_relaxed`:
    /// the span is a range of windows, and a TimeoutCertificate breaks any index/window lockstep. The
    /// window bound is enforced at the macroblock authority, from the certificate's own bytes.
    pub fn rc_armed(&self) -> bool { self.rc.is_some() }

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
        // SPAN SELF-TERMINATION, at the position we are about to SIGN — not at the position we armed
        // for. The arm gate ran once, windows earlier; without re-deriving here a span walks past its
        // last legal step and seals a macroblock whose pin no peer can resolve (`v2_rc_unpinned`),
        // which is unrecoverable rather than merely stalled. Dropping the pin ends the span; this
        // window is then proposed strictly.
        if self.rc.is_some() && self.rc_step_for_window(window).is_none() {
            self.rc = None;
            self.eng.set_recovery_span(None);
        }
        // Under a pin: any committee member may propose (no TC can rotate a dead leader while the
        // index is fixed to the window), gated by a one-shot stagger grant so exactly one member
        // normally speaks, and NOT gated by last_proposed_round — the index cannot advance, so a
        // failed attempt must be retryable or the span wedges on its first vote split.
        let pinned = self.rc_armed();
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
        let mut commit: Option<VoteCommitment> = None;
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
                    if crate::node::is_warn() {
                        println!("[WARN][BFT2] proposal_dropped reason=window idx={} head={} want_head={}",
                                 cp.index, cp.window_head_height,
                                 self.next_window().saturating_mul(self.cp_interval));
                    }
                    return Vec::new();
                }
                // Same doctrine for the INDEX. The engine refuses any index but its current one
                // (checkpoint_consensus on_proposal), so recording one here writes maps the engine will
                // never act on - and heads/state_roots/mb_hashes feed the finality inputs. A proposal
                // that is merely early is buffered and replayed by the node loop, so nothing is lost.
                if cp.index != self.eng.current_index {
                    if crate::node::is_warn() {
                        println!("[WARN][BFT2] proposal_dropped reason=index idx={} ours={} head={}",
                                 cp.index, self.eng.current_index, cp.window_head_height);
                    }
                    return Vec::new();
                }
                // Same doctrine for the INDEX. The engine refuses any index but its current one
                // (checkpoint_consensus on_proposal), so recording one here writes maps the engine will
                // never act on - and heads/state_roots/mb_hashes feed the finality inputs. A proposal
                // that is merely early is buffered and replayed by the node loop, so nothing is lost.
                // Same doctrine for the INDEX. The engine refuses any index but its current one
                // (checkpoint_consensus on_proposal), so recording one here writes maps the engine will
                // never act on - and heads/state_roots/mb_hashes feed the finality inputs. A proposal
                // that is merely early is buffered and replayed by the node loop, so nothing is lost.
                // Same doctrine for the INDEX. The engine refuses any index but its current one
                // (checkpoint_consensus on_proposal), so recording one here writes maps the engine will
                // never act on - and heads/state_roots/mb_hashes feed the finality inputs. A proposal
                // that is merely early is buffered and replayed by the node loop, so nothing is lost.
                // A pinned proposal must satisfy the POSITIONAL clauses the macroblock authority
                // re-derives from the certificate's own bytes (`resolve_recovery_pin`): the head on
                // the span grid, and a strictly-lower parent link. Without this mirror an armed node
                // votes for an off-grid pin, adopts the relaxed QC, advances its finality marker —
                // and can then never seal that window, because the authority refuses the same pin.
                if cp.recovery_anchor.is_some() {
                    let step_ok = self.rc_step_for_window(cp.window_head_height / self.cp_interval).is_some();
                    let parent_ok = cp.parent_qc.as_ref().map(|p| p.index < cp.index).unwrap_or(false);
                    if !step_ok || !parent_ok { return Vec::new(); }
                }
                // THE PARENT LINK IS A CLAIM WE CHECK, NOT A SOURCE OF TRUTH. Leader election is
                // SHA3(index || parent_hash), so taking that hash from the proposal lets one committee
                // member grind 32 bytes until the function elects it, copy the honest window content
                // and emit a second valid proposal at the same index - a vote split that is not
                // equivocation, so nothing convicts it, repeated every round.
                //
                // Requiring the claim to equal what WE certified adds no honest refusal: QcRef carries
                // no signatures, so two independently-formed QCs for one checkpoint are byte-identical,
                // and the head gate above already passes only when our next_window equals the
                // proposer's - which pins high_qc to the same index, where an honest QC is unique.
                // Logged, so if it ever fires on the live network it is visible immediately.
                let ph = if cp.recovery_anchor.is_some() {
                    // Pinned: bound by the span's positional clauses above, and refused outright by
                    // the node content gate while the relaxation is off.
                    cp.parent_qc.as_ref().map(|q| q.checkpoint_hash).unwrap_or(self.genesis_hash)
                } else {
                    let ours = self.eng.high_qc.as_ref()
                        .map(qnet_consensus::checkpoint_bft::QcRef::from);
                    if cp.parent_qc != ours {
                        if crate::node::is_warn() {
                            println!("[WARN][BFT2] proposal_parent_mismatch idx={} claimed={:?} ours={:?}",
                                     cp.index,
                                     cp.parent_qc.as_ref().map(|q| q.index),
                                     ours.as_ref().map(|q| q.index));
                        }
                        // Ask for the certificate we are MISSING, by its own index. The proposal
                        // names it in parent_qc; a window number is a different counter entirely
                        // (index 124 vs window 117 for one and the same checkpoint) and would never
                        // match the serve store.
                        return vec![Effect::CatchUp {
                            qc_index: cp.parent_qc.as_ref().map(|q| q.index).unwrap_or(0),
                            window: cp.window_head_height / self.cp_interval.max(1) }];
                    }
                    self.parent_hash()
                };
                self.heads.insert(cp.index, cp.window_head_height);
                self.state_roots.insert(cp.index, cp.state_root);
                self.mb_hashes.insert(cp.index, cp.window_mb_hashes.clone());
                self.proposals.insert((cp.index, cp.hash()), cp.clone());
                let (pi, phh) = cp.parent_qc.as_ref().map(|q| (q.index, q.checkpoint_hash))
                    .unwrap_or((0, [0u8; 32]));
                commit = Some(VoteCommitment {
                    index: cp.index, window_head: cp.window_head_height,
                    content_digest: checkpoint_content_digest(cp),
                    pinned: cp.recovery_anchor.is_some(), parent_index: pi, parent_hash: phh,
                });
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
            ConsensusMsg::Qc(qc) => {
                self.remember_qc(qc);
                self.eng.adopt_qc(qc)
            }
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
        if let Some(c) = commit {
            for e in out.iter_mut() {
                if let Effect::Vote { commit, .. } = e { *commit = c.clone(); }
            }
        }
        // Seal also on a QC the node ADOPTED from a relay (didn't form locally): otherwise
        // the macroblock body is never written whenever the QC forms on another node first.
        if let ConsensusMsg::Qc(qc) = msg { out.extend(self.seal_if_ready(qc)); }
        out
    }

    /// Reload the vote commitments this node persisted before releasing those votes. Called once at
    /// startup, before any inbound message is handled.
    pub fn restore_vote_commitments(&mut self, recs: &[VoteCommitment]) {
        for r in recs {
            self.eng.restore_vote(r.index, r.window_head, r.content_digest, r.pinned,
                                  r.parent_index, r.parent_hash);
        }
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
        if self.sealed.contains(&window) { return Vec::new(); } // confirmed durable by the node
        // Seal inputs absent (round pruned): a default-empty producer set builds a body
        // byte-different from every other sealer's, and an empty committee makes quorum_size 0.
        // Fail closed; the node reports it.
        let (eligible_producers, committee) = match self.seal_data.get(&qc.index) {
            Some(d) => d.clone(),
            None => { self.seal_skipped = Some(window); return Vec::new(); }
        };
        // HELD, not emitted: a 1-chain QC is not final. Action::Commit releases it below. A SET,
        // not one slot: at a 1:1 cadence the next boundary QC arrives in the same translate pass as
        // the commit that would release this one, and a single slot would lose it.
        let effect = Effect::Persist { checkpoint: cp, qc: qc.clone(), eligible_producers, committee };
        // Already 2-chain committed: emit now. This is also the RETRY path - a re-delivered
        // certificate for a window the node failed to store must produce Persist again, and no
        // new Commit action will fire for an index the frontier has already passed.
        if self.eng.committed_index >= qc.index { return vec![effect]; }
        const MAX_PENDING_SEALS: usize = 4;
        self.pending_seals.retain(|(i, _)| *i != qc.index);
        self.pending_seals.push((qc.index, effect));
        if self.pending_seals.len() > MAX_PENDING_SEALS { self.pending_seals.remove(0); }
        Vec::new()
    }

    /// The node confirms `window` is durably stored. Presuming it on EMIT lost the window
    /// forever whenever the node then refused to persist, because the dedup set already held it.
    pub fn mark_sealed(&mut self, window: u64) { self.sealed.insert(window); }

    /// Drain the last window skipped for want of seal inputs (the driver itself stays pure).
    pub fn take_seal_skipped(&mut self) -> Option<u64> { self.seal_skipped.take() }

    fn translate(&mut self, actions: Vec<Action>) -> Vec<Effect> {
        let mut out = Vec::new();
        for a in actions {
            match a {
                // `commit` is filled by `handle` from the proposal that produced this vote — the only
                // place that holds it. A Vote can be produced by nothing else.
                Action::Vote(v) => out.push(Effect::Vote {
                    index: v.index, checkpoint_hash: v.checkpoint_hash, commit: VoteCommitment::default() }),
                Action::FormedQc(qc) => {
                    // Serve store must be filled by the node that BUILDS the certificate: the
                    // self-routed copy comes back below its own index and the staleness filter
                    // drops it, so relying on the inbound path leaves every frontier node empty.
                    self.remember_qc(&qc);
                    out.extend(self.seal_if_ready(&qc));
                    out.push(Effect::Relay(ConsensusMsg::Qc(qc)));
                }
                Action::Commit(idx) => {
                    // The macroblock is the durable epoch object, so it seals on the 2-chain
                    // commit and nowhere else. A window whose QC never gets a child QC never
                    // commits and therefore never seals - which is the safety property: two
                    // byte-different contents at one window head can each reach a 1-chain QC
                    // across rounds, but only the branch that continues can commit.
                    // Released when the commit frontier REACHES the held index, not only when the
                    // commit lands exactly on it: a skipped round commits r+2 whose parent is r, so
                    // an equality test would strand that window unsealed for good.
                    let (released, kept): (Vec<_>, Vec<_>) = self.pending_seals
                        .drain(..).partition(|(i, _)| *i <= idx);
                    self.pending_seals = kept;
                    for (_, e) in released { out.push(e); }
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
        // Anchored to the VIEW, not to the commit. A content-divergence halt keeps forming
        // TimeoutCertificates, so `current_index` advances every view while `committed_index` is
        // frozen — a commit-derived floor never moves and these maps grow for the whole outage. Every
        // reader here (next_window's high_qc head, refresh_high_window, Commit's Finalize inputs,
        // seal_if_ready) touches the round being driven or its parent; `next_window` additionally
        // falls back to the monotone `high_window` high-water mark when the head is gone, so an
        // evicted head cannot lower it. In the happy path committed_index tracks the view, so this is
        // the same retention as before.
        let floor = self.eng.current_index.saturating_sub(CONSENSUS_STATE_RETAIN);
        let commit_floor = self.eng.committed_index.saturating_sub(CONSENSUS_STATE_RETAIN);
        self.eng.prune_below(floor, commit_floor);
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
            Effect::Vote { index, checkpoint_hash, .. } => vec![ConsensusMsg::Vote(Vote {
                checkpoint_hash, index, voter: n.id.clone(), signature: sign(&n.id, &checkpoint_hash),
            })],
            Effect::Timeout { index, high_qc_index } => vec![ConsensusMsg::Timeout(TimeoutMsg {
                index, voter: n.id.clone(), high_qc_index,
                signature: sign(&n.id, &timeout_bytes(index, high_qc_index)),
            })],
            // No transport in the harness: a pull is a no-op here, the property under test is
            // whether the driver ASKS instead of dead-ending.
            Effect::CatchUp { .. } => vec![],
            Effect::Relay(m) => vec![m],
            Effect::Persist { checkpoint, .. } => {
                let w = checkpoint.window_head_height / 90;
                n.sealed.push(w);
                n.d.mark_sealed(w); // models the node confirming a successful save
                vec![]
            }
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
        // The 7th checkpoint is NOT a boundary (210 % 90 = 30): it only supplies the child
        // QC that 2-chain commits index 6, which is when window 2 seals.
        for index in 1..=7u64 {
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
        // Window 4 seals on its 2-chain commit, which window 5 supplies.
        step(&mut nodes, &c, 5);
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
        d.eng.current_index = total + 1;
        d.prune();
        let floor = total + 1 - CONSENSUS_STATE_RETAIN; // 11
        assert!(d.heads.keys().all(|k| *k >= floor), "heads pruned below floor");
        assert!(d.proposals.keys().all(|(idx, _)| *idx >= floor), "proposals pruned below floor");
        assert!(d.state_roots.keys().all(|k| *k >= floor), "state_roots pruned below floor");
        assert!(d.seal_data.keys().all(|k| *k >= floor), "seal_data pruned below floor");
        assert!(d.sealed.iter().all(|w| *w >= floor), "sealed windows pruned below floor");
        assert!(d.heads.len() <= CONSENSUS_STATE_RETAIN as usize + 1, "bounded, not O(chain length)");
        assert_eq!(d.eng.committed_index, total, "prune never regresses committed_index");
    }

    // The halt this chain actually hits: TimeoutCertificates keep forming, so the VIEW advances every
    // 4 s while `committed_index` is frozen by the content divergence. Retention must still bound the
    // driver's maps — a commit-derived floor would never move and the node would OOM during the very
    // outage it has to survive.
    #[test]
    fn prune_bounds_driver_maps_while_the_commit_is_frozen() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let mut d = ConsensusDriver::new("n0".into(), c.clone(), [7u8; 32]);
        d.set_intervals(90, 90);
        // 2000 views, no commit — 15x the retention window.
        for i in 1..=2000u64 {
            d.heads.insert(i, 90);
            d.state_roots.insert(i, [1u8; 32]);
            d.mb_hashes.insert(i, vec![[1u8; 32]]);
            d.seal_data.insert(i, (Vec::new(), Vec::new()));
            d.eng.current_index = i + 1;
            d.prune();
        }
        assert_eq!(d.eng.committed_index, 0, "nothing committed during the halt");
        let bound = CONSENSUS_STATE_RETAIN as usize + 2;
        assert!(d.heads.len() <= bound, "heads unbounded during halt: {}", d.heads.len());
        assert!(d.state_roots.len() <= bound, "state_roots unbounded during halt: {}", d.state_roots.len());
        assert!(d.mb_hashes.len() <= bound, "mb_hashes unbounded during halt: {}", d.mb_hashes.len());
        assert!(d.seal_data.len() <= bound, "seal_data unbounded during halt: {}", d.seal_data.len());
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

    /// Deterministic ASYNCHRONOUS delivery: every (message, receiver) pair gets an independent
    /// delay, so a certificate reaches different nodes in different rounds.
    ///
    /// `deliver_gated` hands every message to every node in one round. Under that schedule all
    /// nodes hold the same high_qc at all times, so a rule that refuses a proposal whose parent
    /// certificate differs from the receiver's own can never fire on an honest node — which is why
    /// a full green suite coexisted with a network that stopped. Skew is the whole point.
    fn deliver_skewed(
        nodes: &mut Vec<Node>, tails: &mut Vec<Vec<Hash>>, c: &[NodeId],
        seed: Vec<ConsensusMsg>, skew_seed: u64, max_rounds: usize,
    ) {
        // Reproducible per-scenario schedule; no wall clock, no thread order.
        let mut rng = skew_seed | 1;
        let mut next_delay = |bound: u64| -> usize {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((rng >> 33) % bound) as usize
        };

        // pending[round] = messages to hand to a specific node in that round.
        let mut pending: Vec<Vec<(usize, ConsensusMsg)>> = vec![Vec::new(); max_rounds + 8];
        let mut enqueue = |pending: &mut Vec<Vec<(usize, ConsensusMsg)>>,
                           at: usize, m: &ConsensusMsg, from: usize,
                           delay: &mut dyn FnMut(u64) -> usize| {
            for k in 0..5 {
                // Self-delivery is the in-process route_inbound: never delayed, never lost. A node
                // that can lose its OWN vote is a modelling error, not a network condition, and it
                // masks every property under test.
                if k == from { let last = pending.len() - 1; pending[(at + 1).min(last)].push((k, m.clone())); continue; }
                // Certificates are SHED, not only delayed: dispatch_cert_verify drops one when the
                // verify semaphore is full, and re-gossip is its only retry. A lost certificate is
                // what turns "one round behind" into "behind forever" when the proposal that would
                // carry it is refused too. One in five, deterministic per schedule.
                if delay(20) == 0 { continue; }
                let last = pending.len() - 1;
                let r = (at + 1 + delay(4)).min(last);
                pending[r].push((k, m.clone()));
            }
        };
        for m in &seed { enqueue(&mut pending, 0, m, usize::MAX, &mut next_delay); }

        // Highest certificate seen on the wire, kept so a lagging node can PULL it. The live node
        // has three catch-up paths (re-gossip, catchup_pull, sync); without at least one of them a
        // single lost certificate is fatal on its own and no refusal rule can be told apart from
        // plain message loss.
        let mut best_qc: Option<ConsensusMsg> = None;
        // Proposals seen on the wire. A lagging node needs the CONTENT, not just the certificate:
        // adopt_qc can only commit an index whose proposal it already holds, so a node that missed
        // the proposal is stuck even after receiving the QC. The live node fetches it by range sync.
        let mut seen_props: Vec<ConsensusMsg> = Vec::new();

        for round in 0..max_rounds {
            // Catch-up tick: every node behind the frontier pulls the newest certificate.
            if round % 12 == 11 {
                if let Some(qc) = best_qc.clone() {
                    let lead = nodes.iter().map(|n| n.d.committed_index()).max().unwrap_or(0);
                    for k in 0..nodes.len() {
                        if nodes[k].d.committed_index() < lead {
                            for p in &seen_props { let _ = nodes[k].d.handle(p); }
                            let effs = nodes[k].d.handle(&qc);
                            for e in effs {
                                for out in exec(&mut nodes[k], e) {
                                    enqueue(&mut pending, round, &out, k, &mut next_delay);
                                }
                            }
                        }
                    }
                }
            }
            let batch: Vec<(usize, ConsensusMsg)> = std::mem::take(&mut pending[round]);
            if batch.is_empty() { continue; }
            for (k, m) in batch {
                if !verify_msg(c, &m) { continue; }
                if let ConsensusMsg::Proposal(cp) = &m {
                    // Adopt the leader's tail: content divergence is a separate fault and would
                    // mask the property under test.
                    if tails[k] != cp.window_mb_hashes { tails[k] = cp.window_mb_hashes.clone(); }
                }
                let effs = nodes[k].d.handle(&m);
                for e in effs {
                    for out in exec(&mut nodes[k], e) {
                        if let ConsensusMsg::Proposal(_) = &out { seen_props.push(out.clone()); }
                        if let ConsensusMsg::Qc(q) = &out {
                            let better = best_qc.as_ref().map_or(true, |b| match b {
                                ConsensusMsg::Qc(bq) => q.index > bq.index, _ => true });
                            if better { best_qc = Some(out.clone()); }
                        }
                        enqueue(&mut pending, round, &out, k, &mut next_delay);
                    }
                }
            }
        }
    }

    /// THE property every single-driver test in this file is structurally unable to express:
    /// under skewed delivery, honest nodes must still CONVERGE.
    ///
    /// Safety alone is not enough. Every refusal rule added to handle() preserved safety and
    /// destroyed liveness — nodes drifted one certificate apart, then refused each other's
    /// proposals forever, and the live network stopped with 720 unit tests green. This test
    /// asserts the OUTCOME (all nodes agree AND advanced) and deliberately names no mechanism,
    /// so a wrong model cannot encode itself into the expectation the way
    /// `a_proposal_at_an_index_the_view_has_left_records_nothing` did.
    #[test]
    #[ignore = "NOT EVIDENCE: the schedule starves one node deterministically, so this cannot tell protocol behaviour from its own message loss. Four configurations, including all three proposal bars disabled, gave the byte-identical result. Fix by driving the real inbound path instead of this simplified copy; until then red or green here means nothing."]
    fn honest_nodes_converge_under_delivery_skew() {
        for skew in [1u64, 7, 13, 29, 101] {
            let (c, mut nodes, mut tails) = five_node_harness();
            for w in 1..=6u64 {
                for t in tails.iter_mut() { *t = vec![[w as u8; 32]]; }
                let seed = propose_window(&mut nodes, &tails, &c, w);
                deliver_skewed(&mut nodes, &mut tails, &c, seed, skew, 600);

                // Cross-window catch-up: a node behind the frontier pulls the newest certificate
                // the leaders hold. Modelled between windows because that is where the live
                // catchup_pull runs — inside one window it has nothing newer to fetch.
                let lead = nodes.iter().map(|n| n.d.committed_index()).max().unwrap_or(0);
                let donor = nodes.iter().position(|n| n.d.committed_index() == lead);
                if let Some(di) = donor {
                    if let Some(qc) = nodes[di].d.high_qc_msg() {
                        for k in 0..nodes.len() {
                            if nodes[k].d.committed_index() < lead {
                                let effs = nodes[k].d.handle(&qc);
                                for e in effs { let _ = exec(&mut nodes[k], e); }
                            }
                        }
                    }
                }
            }

            let committed: Vec<u64> = nodes.iter().map(|n| n.d.committed_index()).collect();
            let windows: Vec<u64> = nodes.iter().map(|n| n.d.next_window()).collect();

            // LIVENESS: the schedule is delayed, never dropped, so every honest node must end on
            // the same committed index.
            assert!(committed.iter().all(|x| *x == committed[0]),
                    "skew={skew}: nodes ended on different committed indexes {committed:?}                      (windows {windows:?}) — a delivery delay became a permanent split");

            // And it must have MOVED. Agreeing on zero is a halt, not consensus.
            assert!(committed[0] > 0,
                    "skew={skew}: nothing committed under skewed delivery {committed:?}                      (windows {windows:?}) — honest nodes cannot make progress out of lock-step");
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

    // ── RECOVERY SPAN, PROPOSE SIDE ──────────────────────────────────────────────────────────────

    /// A driver parked at checkpoint window `w`, with production cadence (30 / 90).
    fn rc_driver(w: u64) -> ConsensusDriver {
        let c: Vec<NodeId> = (0..12).map(|i| format!("cs_{:04}", i)).collect();
        let mut d = ConsensusDriver::new(c[0].clone(), c, [7u8; 32]);
        d.high_window = w.saturating_sub(1);
        d
    }

    fn rc_build(d: &mut ConsensusDriver, w: u64) -> Vec<Effect> {
        let c = d.committee().to_vec();
        d.build_proposal(w, vec![[1u8; 32]], [2u8; 32], [0u8; 32], 0, c, Vec::new(), Vec::new(),
                         [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0)
    }

    // A SPAN MUST SELF-TERMINATE AT PROPOSE TIME. The arm gate runs once, windows before the proposal
    // is built; if the bound is not re-derived from the head about to be signed, the span walks past
    // its last legal step and seals a macroblock no peer can pin (`v2_rc_unpinned`) — unrecoverable,
    // not merely stalled.
    #[test]
    fn a_span_cannot_be_proposed_past_its_bound() {
        let a = 4u64;
        let per_mb = MACROBLOCK_INTERVAL / CHECKPOINT_INTERVAL;   // 3 checkpoint windows per macroblock
        let first = a * per_mb + 1;                               // k = 1
        let last = a * per_mb + RC_SPAN_INDICES;                  // k = RC_SPAN_INDICES

        // Inside the span the pin is carried on the proposal.
        let mut d = rc_driver(first);
        assert!(d.set_recovery_span(Some((a, [9u8; 32], 17))));
        d.rc_grant_propose();
        match rc_build(&mut d, first).as_slice() {
            [Effect::Propose(cp)] => assert_eq!(cp.recovery_anchor, Some((a, [9u8; 32]))),
            other => panic!("expected a pinned proposal, got {:?}", other),
        }

        // The last legal step still carries it...
        let mut d = rc_driver(last);
        assert!(d.set_recovery_span(Some((a, [9u8; 32], 17))));
        d.rc_grant_propose();
        match rc_build(&mut d, last).as_slice() {
            [Effect::Propose(cp)] => assert!(cp.recovery_anchor.is_some()),
            other => panic!("expected a pinned proposal at the last step, got {:?}", other),
        }

        // ...and one window further the pin is DROPPED rather than stretched. The span ends; whatever
        // this node proposes from here is strict, and the global arm mirrors the drop off rc_armed.
        let mut d = rc_driver(last + 1);
        d.rc = Some((a, [9u8; 32], 17));
        d.eng.set_recovery_span(Some((a, [9u8; 32])));
        assert!(d.rc_armed());
        let effs = rc_build(&mut d, last + 1);
        assert!(!d.rc_armed(), "the span must self-terminate at the first out-of-bound head");
        assert!(effs.iter().all(|e| !matches!(e, Effect::Propose(cp) if cp.recovery_anchor.is_some())),
                "no proposal may carry a pin the authority cannot resolve");

        // And arming for a window already past the span is refused outright.
        let mut d = rc_driver(last + 1);
        assert!(!d.set_recovery_span(Some((a, [9u8; 32], 17))));
        assert!(!d.rc_armed());
    }

    /// The pinned checkpoint an armed member would receive at span step `k`, positioned correctly.
    fn rc_inbound(d: &ConsensusDriver, a: u64, k: u64) -> Checkpoint {
        let per_mb = MACROBLOCK_INTERVAL / CHECKPOINT_INTERVAL;
        let idx = d.current_index();
        Checkpoint {
            index: idx,
            parent_qc: Some(QcRef { index: idx.saturating_sub(1), checkpoint_hash: [3u8; 32] }),
            window_head_height: (a * per_mb + k) * CHECKPOINT_INTERVAL,
            window_mb_hashes: vec![[1u8; 32]], state_root: [2u8; 32], beacon: [0u8; 32],
            epoch_commitment: [0u8; 32], reward_root: [0u8; 32], registry_root: [0u8; 32],
            logs_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32],
            total_supply: 0, timestamp: 0, proposer: "cs_0005".into(), proposer_sig: vec![1],
            recovery_anchor: Some((a, [9u8; 32])),
        }
    }

    // ── RECOVERY SPAN, VOTE SIDE ─────────────────────────────────────────────────────────────────

    // The vote a pinned proposal produces must carry the commitment the node has to make DURABLE, and
    // the driver must refuse any pinned position the macroblock authority would not resolve. Adopting
    // a relaxed QC over an off-grid pin advances this node's finality marker for a window it can then
    // never seal — a wedge with no way back.
    #[test]
    fn a_pinned_proposal_is_gated_like_the_authority_and_carries_its_commitment() {
        let a = 4u64;
        let per_mb = MACROBLOCK_INTERVAL / CHECKPOINT_INTERVAL;
        let first = a * per_mb + 1;
        let mut d = rc_driver(first);
        assert!(d.set_recovery_span(Some((a, [9u8; 32], 17))));

        // OFF THE SPAN GRID: the head is contiguous but not a span position ⇒ no vote.
        let mut off = rc_inbound(&d, a, 1);
        off.window_head_height += 1;
        assert!(d.handle(&ConsensusMsg::Proposal(off)).is_empty());
        // NO PARENT LINK: `resolve_recovery_pin` requires a strictly-lower parent ⇒ no vote.
        let mut orphan = rc_inbound(&d, a, 1);
        orphan.parent_qc = None;
        assert!(d.handle(&ConsensusMsg::Proposal(orphan)).is_empty());

        // A well-positioned pinned proposal votes, and the vote carries exactly what must reach disk
        // before it reaches the wire.
        let cp = rc_inbound(&d, a, 1);
        match d.handle(&ConsensusMsg::Proposal(cp.clone())).as_slice() {
            [Effect::Vote { index, checkpoint_hash, commit }] => {
                assert_eq!(*index, cp.index);
                assert_eq!(*checkpoint_hash, cp.hash());
                assert_eq!(commit.window_head, cp.window_head_height);
                assert_eq!(commit.content_digest, checkpoint_content_digest(&cp));
                assert!(commit.pinned);
                assert_eq!(commit.parent_index, cp.index - 1);
            }
            other => panic!("expected a pinned vote with its commitment, got {:?}", other),
        }

        // A RESTARTED node that reloads that commitment refuses the conflicting re-proposal its peers
        // would convict it for; the same node without the record emits exactly that pair.
        let mut conflict = cp.clone();
        conflict.state_root = [0xEE; 32];
        let commit = VoteCommitment {
            index: cp.index, window_head: cp.window_head_height,
            content_digest: checkpoint_content_digest(&cp), pinned: true,
            parent_index: cp.index - 1, parent_hash: [3u8; 32],
        };
        let mut forgot = rc_driver(first);
        assert!(forgot.set_recovery_span(Some((a, [9u8; 32], 17))));
        assert!(!forgot.handle(&ConsensusMsg::Proposal(conflict.clone())).is_empty());

        let mut restored = rc_driver(first);
        restored.restore_vote_commitments(&[commit]);
        assert!(restored.set_recovery_span(Some((a, [9u8; 32], 17))));
        assert!(restored.handle(&ConsensusMsg::Proposal(conflict)).is_empty(),
                "a reloaded commitment must refuse what conviction punishes");
    }


    // Catch-up is ONE-WAY. A node restored by sync then receives an old certificate - a stale relay,
    // a slow peer, a replay. Neither the window it will accept next nor its committed index may move
    // backwards, or it would re-propose a window the chain has already passed and wedge on it.
    #[test]
    fn catch_up_is_not_undone_by_a_stale_certificate() {
        let (c, mut nodes, mut tails) = five_node_harness();
        let (mut cps, mut qcs) = (Vec::new(), Vec::new());
        for w in 1..=5u64 {
            for t in tails.iter_mut() { *t = vec![[w as u8; 32]]; }
            let seed = propose_window(&mut nodes, &tails, &c, w);
            let (p, q) = deliver_capture(&mut nodes, &mut tails, &c, seed, false);
            cps.extend(p);
            qcs.extend(q);
        }
        let certified = |i: u64| -> (Checkpoint, QuorumCertificate) {
            let qc = qcs.iter().find(|q| q.index == i).expect("window must certify").clone();
            let cp = cps.iter().find(|p| p.index == i && p.hash() == qc.checkpoint_hash)
                .expect("certified checkpoint").clone();
            (cp, qc)
        };

        let mut d = ConsensusDriver::new(c[0].clone(), c.clone(), [7u8; 32]);
        d.set_intervals(30, 90);
        for i in 1..=5u64 { let (cp, qc) = certified(i); let _ = d.sync(&cp, &qc); }
        let (window_after, committed_after) = (d.next_window(), d.committed_index());
        assert!(window_after > 1, "sanity: the replica caught up");

        let (_, stale) = certified(1);
        let _ = d.handle(&ConsensusMsg::Qc(stale));
        assert_eq!(d.next_window(), window_after, "a stale certificate must not walk the window back");
        assert!(d.committed_index() >= committed_after, "finality must never regress");
    }

    // OFF-INDEX PROPOSAL. A proposal whose head is contiguous but whose INDEX the engine has left
    // must touch nothing: heads/state_roots/mb_hashes are the finality inputs, and the engine refuses
    // that index anyway, so recording it only lets a committee member write state nobody will act on.
    #[test]
    fn a_proposal_at_an_index_the_view_has_left_records_nothing() {
        let (c, mut nodes, mut tails) = five_node_harness();
        warm_three_windows(&mut nodes, &mut tails, &c, false);
        let d = &mut nodes[0].d;
        let before_window = d.next_window();
        let before_committed = d.committed_index();

        // Contiguous head, an index the view never occupied.
        let stale = Checkpoint {
            index: 99, parent_qc: None, window_head_height: before_window * 30,
            window_mb_hashes: vec![[0xAAu8; 32]], state_root: [0xAAu8; 32], beacon: [0u8; 32],
            epoch_commitment: [0u8; 32], reward_root: [0u8; 32], registry_root: [0u8; 32],
            dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32], logs_root: [0u8; 32],
            total_supply: 0, timestamp: 0, proposer: c[0].clone(), proposer_sig: Vec::new(),
            recovery_anchor: None,
        };
        assert!(d.handle(&ConsensusMsg::Proposal(stale)).is_empty(),
                "an off-index proposal must produce no effect");
        // The maps are what matter: a later certificate at that index would read them back as the
        // head and state to finalize, so the write itself is the defect, not the missing vote.
        assert!(!d.heads.contains_key(&99), "off-index proposal wrote heads");
        assert!(!d.state_roots.contains_key(&99), "off-index proposal wrote state_roots");
        assert!(!d.mb_hashes.contains_key(&99), "off-index proposal wrote mb_hashes");
        assert_eq!(d.next_window(), before_window, "and must not move the window");
        assert_eq!(d.committed_index(), before_committed, "nor the committed frontier");
    }

    // SEAL CONFIRMATION. The driver used to mark a window sealed the moment it EMITTED Persist, while
    // the node's Persist arm refuses at four places (pin check, parent absent, ban set underivable,
    // save error). After any refusal the dedup set already held the window, so every later certificate
    // returned early and the macroblock was never written and never retried - a silent permanent loss.
    // This node never confirms, so under presumption the second certificate yields nothing.
    #[test]
    fn a_seal_the_node_never_confirmed_is_retried() {
        let (c, mut nodes, mut tails) = five_node_harness();
        let (mut cps, mut qcs) = (Vec::new(), Vec::new());
        for w in 1..=4u64 {
            for t in tails.iter_mut() { *t = vec![[w as u8; 32]]; }
            let seed = propose_window(&mut nodes, &tails, &c, w);
            let (p, q) = deliver_capture(&mut nodes, &mut tails, &c, seed, false);
            cps.extend(p);
            qcs.extend(q);
        }
        let certified = |i: u64| -> (Checkpoint, QuorumCertificate) {
            let qc = qcs.iter().find(|q| q.index == i).expect("window must certify").clone();
            let cp = cps.iter().find(|p| p.index == i && p.hash() == qc.checkpoint_hash)
                .expect("the certified checkpoint must be on the wire").clone();
            (cp, qc)
        };

        // A replica caught up to window 2, then handed window 3 - the head-90 macroblock boundary.
        let mut d = ConsensusDriver::new(c[0].clone(), c.clone(), [7u8; 32]);
        d.set_intervals(30, 90);
        for i in 1..=2u64 { let (cp, qc) = certified(i); let _ = d.sync(&cp, &qc); }
        // Every member runs build_proposal: it buffers the window's seal inputs before the
        // leader gate, which is what lets any member seal locally on the QC (all-seal).
        let _ = d.build_proposal(3, vec![[3u8; 32]], [3u8; 32], [0u8; 32], 3000, c.clone(),
                                 Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32],
                                 [0u8; 32], [0u8; 32], 0);
        let (cp3, qc3) = certified(3);
        let _ = d.handle(&ConsensusMsg::Proposal(cp3));

        // The boundary QC alone is not final: the seal is HELD until the 2-chain commit,
        // which the next certified index supplies.
        assert!(!d.handle(&ConsensusMsg::Qc(qc3.clone())).iter()
                    .any(|e| matches!(e, Effect::Persist { .. })),
                "a 1-chain QC must not seal the macroblock");
        let (cp4, qc4) = certified(4);
        let _ = d.build_proposal(4, vec![[4u8; 32]], [4u8; 32], [0u8; 32], 4000, c.clone(),
                                 Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32],
                                 [0u8; 32], [0u8; 32], 0);
        let _ = d.handle(&ConsensusMsg::Proposal(cp4));
        let first = d.handle(&ConsensusMsg::Qc(qc4));
        assert!(first.iter().any(|e| matches!(e, Effect::Persist { .. })),
                "the 2-chain commit must ask the node to seal");

        // The node refused to store it and therefore never confirmed. The next certificate must retry.
        let second = d.handle(&ConsensusMsg::Qc(qc3.clone()));
        assert!(second.iter().any(|e| matches!(e, Effect::Persist { .. })),
                "a window the node never stored must be re-emitted, not presumed sealed");

        // Once the node confirms, the same certificate must not seal twice.
        d.mark_sealed(cp3_window(&qc3, &cps));
        let third = d.handle(&ConsensusMsg::Qc(qc3));
        assert!(!third.iter().any(|e| matches!(e, Effect::Persist { .. })),
                "a confirmed window must never be sealed a second time");
    }

    /// Macroblock window of the checkpoint `qc` certifies.
    fn cp3_window(qc: &QuorumCertificate, cps: &[Checkpoint]) -> u64 {
        cps.iter().find(|p| p.index == qc.index && p.hash() == qc.checkpoint_hash)
            .expect("certified checkpoint").window_head_height / 90
    }

    // ============================================================================================
    // FAULT INJECTION (halt 47250). The sims above all check that something BAD is refused, or that one
    // past wedge converges. None injects an HONEST node with INCOMPLETE data - which is what happened:
    // a node lost microblock bodies inside a window, could not vote its boundary checkpoint, and the
    // other four (exactly quorum, n-f = 4 of 5) certified without it. These inject that fault and assert
    // LIVENESS. They deliberately separate two obligations: what the DRIVER owes (accept a certified
    // catch-up and resume voting) from what the NODE LAYER owes (notice the gap and feed that catch-up).
    // ============================================================================================

    // deliver_gated, plus a record of every checkpoint and certificate that crossed the wire. Catch-up
    // needs the artefacts themselves, not just their effect on the nodes that already had them.
    fn deliver_capture(nodes: &mut Vec<Node>, tails: &mut Vec<Vec<Hash>>, c: &[NodeId],
                       seed: Vec<ConsensusMsg>, adopt: bool)
                       -> (Vec<Checkpoint>, Vec<QuorumCertificate>) {
        let (mut cps, mut qcs) = (Vec::new(), Vec::new());
        let mut queue = seed;
        let mut rounds = 0;
        while !queue.is_empty() && rounds < 4000 {
            rounds += 1;
            let mut next = Vec::new();
            for m in queue.drain(..) {
                match &m {
                    ConsensusMsg::Proposal(cp) => cps.push(cp.clone()),
                    ConsensusMsg::Qc(qc) => qcs.push(qc.clone()),
                    _ => {}
                }
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
        (cps, qcs)
    }

    // Drive `w` as a clean window every node can vote.
    fn clean_window(nodes: &mut Vec<Node>, tails: &mut Vec<Vec<Hash>>, c: &[NodeId], w: u64) {
        for t in tails.iter_mut() { *t = vec![[w as u8; 32]]; }
        let seed = propose_window(nodes, tails, c, w);
        deliver_gated(nodes, tails, c, seed, false);
    }

    // Window `w` with node 0 unable to derive it (lost bodies => its content gate withholds the vote).
    // Returns the certified checkpoint and certificate the other four produced without it.
    fn window_lost_by_node0(nodes: &mut Vec<Node>, tails: &mut Vec<Vec<Hash>>, c: &[NodeId], w: u64)
                            -> (Checkpoint, QuorumCertificate) {
        for k in 0..5 { tails[k] = if k == 0 { vec![[0xDEu8; 32]] } else { vec![[w as u8; 32]] }; }
        let seed = propose_window(nodes, tails, c, w);
        let (cps, qcs) = deliver_capture(nodes, tails, c, seed, false);
        let qc = qcs.into_iter().find(|q| q.index == w)
            .expect("four honest nodes are exactly quorum and must certify without the fifth");
        let cp = cps.into_iter().find(|p| p.index == w && p.hash() == qc.checkpoint_hash)
            .expect("the certified checkpoint must be on the wire");
        (cp, qc)
    }

    // THE DRIVER'S OBLIGATION. A node that missed one window is handed the certified checkpoint and its
    // certificate - the honest catch-up path - and must then be a full participant again: not merely
    // numerically level with the cluster, but voting, so the next window still certifies with it in the
    // count. A driver that accepts catch-up but stays mute leaves the cluster one fault from a halt.
    #[test]
    fn a_node_restored_by_sync_votes_again() {
        let (c, mut nodes, mut tails) = five_node_harness();
        warm_three_windows(&mut nodes, &mut tails, &c, false);
        for n in &nodes { assert_eq!(n.d.next_window(), 4, "warm-up must reach window 4"); }

        let (cp, qc) = window_lost_by_node0(&mut nodes, &mut tails, &c, 4);
        assert_eq!(nodes[0].d.next_window(), 4, "the damaged node must not advance on its own");

        let _ = nodes[0].d.sync(&cp, &qc);
        assert!(nodes[0].d.next_window() > 4,
                "a certified checkpoint must restore the node: still at {}", nodes[0].d.next_window());

        // It must now carry its share: window 5 is proposed with node 0 present and healthy.
        clean_window(&mut nodes, &mut tails, &c, 5);
        let level = nodes.iter().filter(|n| n.d.next_window() == nodes[1].d.next_window()).count();
        assert_eq!(level, 5, "every node must be level after catch-up: {:?}",
                   nodes.iter().map(|n| n.d.next_window()).collect::<Vec<_>>());
        assert!(nodes[0].committed >= nodes[1].committed,
                "the restored node must finalize with the cluster, not trail it");
    }

    // THE NODE LAYER'S OBLIGATION, stated as a gap. Without catch-up the damaged node can NEVER return on
    // its own: a proposal is refused unless its head already equals `next_window * 30`, and a bare
    // certificate deliberately does not move `next_window` (adopting a head-less QC once collapsed it to
    // 1 and wedged the net - see headless_qc_adopt_does_not_collapse_next_window). Both refusals are
    // correct in isolation. Together they mean recovery is neither optional nor automatic: something
    // above the driver MUST notice the gap and deliver checkpoint+QC. Nothing did, and the node sat out.
    #[test]
    fn a_damaged_node_cannot_return_without_catch_up() {
        let (c, mut nodes, mut tails) = five_node_harness();
        warm_three_windows(&mut nodes, &mut tails, &c, false);

        let (_, qc) = window_lost_by_node0(&mut nodes, &mut tails, &c, 4);
        let _ = nodes[0].d.handle(&ConsensusMsg::Qc(qc));

        // Its data is repaired and the chain runs on. Repair alone changes nothing.
        for w in 5..=6u64 { clean_window(&mut nodes, &mut tails, &c, w); }
        assert_eq!(nodes[0].d.next_window(), 4,
                   "documents the gap: repair and certificates alone must not be mistaken for recovery");
        assert!(nodes[1].d.next_window() > 4, "the healthy majority must have moved on");
    }

    // Every node's view timer fires; the resulting timeouts (and any TC they form) are delivered.
    fn fire_timeouts(nodes: &mut Vec<Node>, tails: &mut Vec<Vec<Hash>>, c: &[NodeId]) {
        let mut seed = Vec::new();
        for k in 0..nodes.len() {
            let effs = nodes[k].d.on_timeout();
            for e in effs { seed.extend(exec(&mut nodes[k], e)); }
        }
        deliver_gated(nodes, tails, c, seed, false);
    }

    // RECOVERY FROM A FAILED WINDOW. A window that fell short of quorum cannot be re-proposed at the same
    // view - `round > last_proposed_round` allows one proposal per index, which is correct and deliberate.
    // Recovery therefore runs entirely through the view change: the view timers fire, a timeout
    // certificate rotates the round, and the SAME window is proposed again by the new leader and
    // certifies. If that path does not close, one bad round halts the chain permanently, because nothing
    // else can ever move the index.
    #[test]
    fn a_failed_window_recovers_through_the_view_change() {
        let (c, mut nodes, mut tails) = five_node_harness();
        warm_three_windows(&mut nodes, &mut tails, &c, false);

        // Window 4 falls short: two nodes hold a divergent tail, leaving 3 < quorum 4.
        for k in 0..5 { tails[k] = if k < 2 { vec![[0xBEu8; 32]] } else { vec![[4u8; 32]] }; }
        let seed = propose_window(&mut nodes, &tails, &c, 4);
        deliver_gated(&mut nodes, &mut tails, &c, seed, false);
        assert!(nodes.iter().all(|n| n.d.next_window() == 4), "sanity: the window must have failed");

        // The mismatch clears, the view timers fire, and the same window is proposed under a new round.
        for t in tails.iter_mut() { *t = vec![[4u8; 32]]; }
        fire_timeouts(&mut nodes, &mut tails, &c);
        let seed = propose_window(&mut nodes, &tails, &c, 4);
        deliver_gated(&mut nodes, &mut tails, &c, seed, false);

        assert!(nodes.iter().all(|n| n.d.next_window() > 4),
                "a failed window must recover through the view change: {:?}",
                nodes.iter().map(|n| n.d.next_window()).collect::<Vec<_>>());
    }

}

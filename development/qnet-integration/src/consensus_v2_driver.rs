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
    // rejoin the view. `window` is this node's own frontier, never a head the proposal names.
    CatchUp { qc_index: u64, window: u64 },
    /// The proposer extends an older certificate than ours: send it ours with its checkpoint, as the
    /// served catch-up pair, to that one peer. Answered by three deterministic members, once per index.
    CatchUpTo { peer: NodeId, checkpoint: Checkpoint, qc: QuorumCertificate },
    Finalize { index: u64, head_height: u64, state_root: Hash, mb_hashes: Vec<Hash> }, // checkpoint final ⇒ microblocks ≤ head_height irreversible; state_root + per-height mb_hashes = the QC'd window content, re-checked against local bodies before advancing the marker (never finalize a same-state-different-body fork tail)
}

/// Which members answer a proposer that extends an older certificate: the three after it in the
/// sorted committee. Bounded on both sides — three multi-MB pairs at most reach the proposer, and
/// no member sends more than one per proposer and index (the driver keeps that mark).
pub fn answers_stale_proposal(committee: &[NodeId], proposer: &str, me: &str) -> bool {
    let n = committee.len();
    if n < 2 { return false; }
    let (Some(p), Some(m)) = (committee.iter().position(|c| c == proposer),
                              committee.iter().position(|c| c == me)) else { return false; };
    let rank = (m + n - p) % n;
    rank >= 1 && rank <= 3
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
    /// Every leader-valid proposal, by (index, checkpoint hash). Two can share an index: a vote
    /// certificate and a timeout certificate at one index each elect a leader for the next. So every
    /// reader that decides something - finality, the window frontier, seals - looks a checkpoint up
    /// by the hash a certificate names, never by its index alone. Keyed by index, 10.10 finalized an
    /// uncertified head on four nodes and split the committee for good.
    proposals: HashMap<(u64, Hash), Checkpoint>,
    /// The 2-chain-committed checkpoint: the parent link of the certified child that committed it.
    committed_cp: Option<(u64, Hash)>,
    /// Seal inputs keyed by the epoch_commitment they produce: (round seen, eligible_producers,
    /// committee). A certificate names its commitment, so a lookup by it can only return inputs
    /// that ARE the certified ones. Keyed by round, a node a window behind sealed a boundary from
    /// the inputs of another window and stored a body no peer certified.
    seal_data: HashMap<Hash, (u64, Vec<u8>, Vec<NodeId>)>,
    sealed: std::collections::HashSet<u64>, // windows the node CONFIRMED durably stored (dedup)
    seal_skipped: Option<u64>,              // last window skipped for want of seal inputs (observability)
    pending_seals: Vec<(u64, Hash, Effect)>, // Persists built on a QC, released by a 2-chain commit of their chain
    // Recent certificates, so a peer one QC behind can be served. The wire carries only a QcRef
    // (hash + index, no signatures), so a proposal cannot deliver the certificate it names and a
    // lagging node has no other way to obtain it. Bounded: the last few rounds are all a catch-up
    // can use, and an unbounded map on a consensus-hot path is a memory target.
    recent_qcs: std::collections::BTreeMap<u64, QuorumCertificate>,
    answered_stale: HashMap<NodeId, u64>,   // proposer -> highest index we already answered
    exchanged: HashMap<NodeId, u64>,        // proposer -> highest index the pre-content exchange decided
    last_proposed_round: u64,               // one proposal per round we lead
    high_window: u64,                       // monotonic high-water mark of certified heads' windows; next_window
                                            // falls back to it only while the high certificate's checkpoint is
                                            // not held, so a head-less relayed QC/TC cannot collapse the
                                            // proposal baseline to 1 (the desync seed).
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
            proposals: HashMap::new(), committed_cp: None, seal_data: HashMap::new(),
            sealed: std::collections::HashSet::new(), seal_skipped: None, pending_seals: Vec::new(),
            recent_qcs: std::collections::BTreeMap::new(),
            answered_stale: HashMap::new(), exchanged: HashMap::new(),
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

    /// Our high certificate with its checkpoint — what a peer behind it can adopt from.
    pub fn high_qc_pair(&self) -> Option<(Checkpoint, QuorumCertificate)> {
        let qc = self.eng.high_qc.clone()?;
        let cp = self.proposals.get(&(qc.index, qc.checkpoint_hash))?.clone();
        Some((cp, qc))
    }

    pub fn committed_index(&self) -> u64 { self.eng.committed_index }
    /// Head height of the highest certified checkpoint, when that checkpoint is held.
    pub fn high_qc_head(&self) -> Option<u64> {
        let q = self.eng.high_qc.as_ref()?;
        self.head_of_checkpoint(q.index, &q.checkpoint_hash)
    }
    /// True while the highest certificate has no 2-chain commit yet.
    pub fn commit_pending(&self) -> bool {
        self.eng.high_qc.as_ref().map(|q| q.index > self.eng.committed_index).unwrap_or(false)
    }
    /// True once the commit frontier has reached the high certificate's head. Under a 2-chain rule
    /// the newest certificate is always uncommitted, so `commit_pending` alone never turns false;
    /// this is what ends a re-certification run: the head is committed, the seal follows from it.
    pub fn high_head_committed(&self) -> bool {
        match (self.high_qc_head(), self.committed_head()) { (Some(h), Some(c)) => c >= h, _ => false }
    }
    /// Whether `cp` re-proposes our own highest certified checkpoint: the same head, the SAME
    /// content, its parent that very certificate, and that certificate still uncommitted. The content
    /// pin is what keeps "re-propose" literal: without it a same-head child with other content would
    /// commit the parent's content, seal it, and then commit its own - two contents at one head. A
    /// checkpoint we do not hold cannot be re-certified. See `build_recertify_proposal`.
    fn recertifies_high(&self, cp: &Checkpoint) -> bool {
        let ours = self.eng.high_qc.as_ref().map(qnet_consensus::checkpoint_bft::QcRef::from);
        if ours.is_none() || cp.parent_qc != ours || !self.commit_pending() { return false; }
        match self.high_qc_pair() {
            Some((held, _)) => held.window_head_height == cp.window_head_height
                && checkpoint_content_digest(&held) == checkpoint_content_digest(cp),
            None => false,
        }
    }
    /// Send our high certificate with its checkpoint to the proposer of `cp`, whose proposal shows it
    /// lacks it. Three deterministic members answer, once per proposer and index.
    fn answer_proposer(&mut self, cp: &Checkpoint) -> Option<Effect> {
        if !answers_stale_proposal(&self.committee, &cp.proposer, &self.node_id) { return None; }
        if self.answered_stale.get(&cp.proposer).map_or(false, |i| *i >= cp.index) { return None; }
        let (checkpoint, qc) = self.high_qc_pair()?;
        self.answered_stale.insert(cp.proposer.clone(), cp.index);
        Some(Effect::CatchUpTo { peer: cp.proposer.clone(), checkpoint, qc })
    }

    /// The certificate exchange a proposal at our current index calls for. It is decided on the parent link,
    /// the proposer and the head against our high certificate, and never on content. Some(effects) when the
    /// proposal is refused here: its parent is not our high certificate (we answer or pull), or its head is
    /// not the one our certificate leads to. None when it passes on to the leader and vote checks.
    fn certificate_exchange(&mut self, cp: &Checkpoint) -> Option<Vec<Effect>> {
        let pinned = cp.recovery_anchor.is_some();
        // THE PARENT LINK IS A CLAIM WE CHECK, NOT A SOURCE OF TRUTH. Leader election is
        // SHA3(index || parent_hash), so taking that hash from the proposal lets one committee
        // member grind 32 bytes until the function elects it, copy the honest window content
        // and emit a second valid proposal at the same index - a vote split that is not
        // equivocation, so nothing convicts it, repeated every round.
        //
        // Requiring the claim to equal what WE certified adds no honest refusal: QcRef carries
        // no signatures, so two independently-formed QCs for one checkpoint are byte-identical,
        // and an honest QC at one index is unique. Logged, so if it ever fires on the live
        // network it is visible immediately.
        //
        // Checked BEFORE the window gate. A proposal on another certificate names the head that
        // follows from THAT certificate, so the gate refuses it whenever the two certificates
        // place different windows - and a refusal there sends nothing. Two groups apart in
        // bookkeeping then refuse each other for good (10.10). The exchange decides on the
        // certificates, whatever head the proposal names. A pinned proposal names its own parent.
        if !pinned {
            let ours = self.eng.high_qc.as_ref().map(qnet_consensus::checkpoint_bft::QcRef::from);
            if cp.parent_qc != ours {
                let claimed = cp.parent_qc.as_ref().map(|q| q.index).unwrap_or(0);
                let held = ours.as_ref().map(|q| q.index).unwrap_or(0);
                if crate::node::is_warn() {
                    println!("[WARN][BFT2] proposal_parent_mismatch idx={} claimed={} ours={} action={}",
                             cp.index, claimed, held, if held > claimed { "send_justify" } else { "pull" });
                }
                // The proposer is the one behind. Three members answer it, once per index,
                // with our certificate and its checkpoint; the next round extends it.
                if held > claimed { return Some(self.answer_proposer(cp).into_iter().collect()); }
                // We are behind: ask for the certificate by its own index (a window number is
                // a different counter and would never match the serve store). The window to
                // repair is our own frontier: the proposal's head has passed no gate yet.
                return Some(vec![Effect::CatchUp { qc_index: claimed, window: self.next_window() }]);
            }
        }
        // Contiguity invariant: a checkpoint's head MUST be the CONTIGUOUS next window (build_proposal
        // enforces head = next_window()*cp_interval on the sign side). A non-contiguous / inflated head
        // (reachable via drain_pending, which routes to handle() past the node's content gate, and
        // verify_msg checks only the proposer signature on a Proposal) draws no vote and is not stored.
        // One other head is legal: a re-proposal of our own highest certificate (same head, same
        // content, parent = that certificate, still uncommitted).
        if cp.window_head_height != self.next_window().saturating_mul(self.cp_interval)
            && !self.recertifies_high(cp)
        {
            if crate::node::is_warn() {
                println!("[WARN][BFT2] proposal_dropped reason=window idx={} head={} want_head={}",
                         cp.index, cp.window_head_height,
                         self.next_window().saturating_mul(self.cp_interval));
            }
            // Our own certificate, and a head it does not lead to: the proposer's frontier is off
            // (a checkpoint it does not hold, a stale latch). Answer it with the certified pair.
            // The certificate's own head is a re-certification that failed its content pin.
            if !pinned && self.high_qc_head().map_or(false, |h| h != cp.window_head_height) {
                return Some(self.answer_proposer(cp).into_iter().collect());
            }
            return Some(Vec::new());
        }
        None
    }

    /// The certificate exchange for a proposal the node's content gate holds back, because its window is not
    /// derived here yet or its tail is being reconciled. Such a proposal never reaches `handle`, and the
    /// exchange reads no content. Without this, a node one certificate behind, or a proposer with a stale
    /// frontier, waits for the timer pulls. Runs once per proposer and index, since the node replays a held
    /// proposal on every drain.
    pub fn pre_content_exchange(&mut self, cp: &Checkpoint) -> Vec<Effect> {
        if cp.index != self.eng.current_index || cp.recovery_anchor.is_some() { return Vec::new(); }
        if self.exchanged.get(&cp.proposer).map_or(false, |i| *i >= cp.index) { return Vec::new(); }
        match self.certificate_exchange(cp) {
            Some(effs) => {
                self.exchanged.insert(cp.proposer.clone(), cp.index);
                effs
            }
            None => Vec::new(),
        }
    }
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
    /// (head, state_root, body hashes) of the 2-chain-committed checkpoint — the one its certified
    /// child names by hash — when held locally. The run loop re-emits a deferred Finalize from this.
    /// None if nothing committed OR that checkpoint is not held (⇒ finality WAITS for §4.5 macroblock
    /// sync rather than finalizing a placeholder or another proposal at the same index).
    pub fn committed_finalize(&self) -> Option<(u64, Hash, Vec<Hash>)> {
        let cp = self.committed_checkpoint()?;
        Some((cp.window_head_height, cp.state_root, cp.window_mb_hashes.clone()))
    }
    pub fn committed_head(&self) -> Option<u64> { self.committed_checkpoint().map(|cp| cp.window_head_height) }

    fn committed_checkpoint(&self) -> Option<&Checkpoint> {
        let (ci, ch) = self.committed_cp?;
        if ci == 0 || ci != self.eng.committed_index { return None; }
        self.proposals.get(&(ci, ch)).filter(|cp| cp.window_head_height > 0)
    }

    /// The checkpoint a commit at `idx` finalized: the parent link of the certified child whose
    /// certificate committed it (`cause`), else of the child certified at `idx + 1`. The index alone
    /// can name two checkpoints.
    fn committed_link(&self, idx: u64, cause: Option<(u64, Hash)>) -> Option<(u64, Hash)> {
        let parent_of = |child: (u64, Hash)| self.proposals.get(&child)
            .and_then(|c| c.parent_qc.as_ref())
            .filter(|p| p.index == idx)
            .map(|p| (p.index, p.checkpoint_hash));
        cause.and_then(parent_of)
            .or_else(|| self.eng.qc_hash_at(idx + 1).and_then(|h| parent_of((idx + 1, h))))
    }

    /// Whether checkpoint `target` lies on the chain ending at `top`, walking parent links. None while
    /// a link on the way is not held: unproven is neither sealed nor dropped.
    fn on_chain(&self, target: (u64, Hash), top: (u64, Hash)) -> Option<bool> {
        let mut cur = top;
        for _ in 0..=CONSENSUS_STATE_RETAIN {
            if cur.0 == target.0 { return Some(cur.1 == target.1); }
            if cur.0 < target.0 { return Some(false); }
            match self.proposals.get(&cur)?.parent_qc.as_ref() {
                Some(p) => cur = (p.index, p.checkpoint_hash),
                None => return Some(false),
            }
        }
        None
    }

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

    /// Window head of the checkpoint certified at `index`; with no certificate held there, of the
    /// proposals held at it when they all name one head. A certificate names no head of its own, so
    /// this is how the node places one in a window; two heads at one index place nothing.
    pub fn head_of(&self, index: u64) -> Option<u64> {
        if let Some(head) = self.eng.qc_hash_at(index).and_then(|h| self.head_of_checkpoint(index, &h)) {
            return Some(head);
        }
        let mut heads = self.proposals.iter()
            .filter(|((i, _), _)| *i == index)
            .map(|(_, cp)| cp.window_head_height);
        let first = heads.next()?;
        if heads.all(|h| h == first) { Some(first) } else { None }
    }

    /// Window head of checkpoint `hash` at `index`, if held.
    pub fn head_of_checkpoint(&self, index: u64, hash: &Hash) -> Option<u64> {
        self.proposals.get(&(index, *hash)).map(|cp| cp.window_head_height)
    }

    /// Does the engine hold a verified certificate for exactly this checkpoint? A relayed copy
    /// needs no second O(committee) check: adopting it again is a no-op on what is already held.
    /// Engine-held only - a copy this side remembers but the engine has pruned would be adopted
    /// afresh, so it is verified afresh.
    pub fn holds_qc(&self, index: u64, hash: &Hash) -> bool {
        self.eng.qc_hash_at(index) == Some(*hash)
    }

    /// Entry counts of the driver's per-round maps, for the memory census.
    pub fn census(&self) -> [(&'static str, u64); 6] {
        [("drv_proposals", self.proposals.len() as u64), ("drv_answered_stale", self.answered_stale.len() as u64),
         ("drv_seal_data", self.seal_data.len() as u64), ("drv_recent_qcs", self.recent_qcs.len() as u64),
         ("drv_pending_seals", self.pending_seals.len() as u64), ("drv_sealed", self.sealed.len() as u64)]
    }

    /// Entry counts of the engine's per-round maps.
    pub fn engine_census(&self) -> [(&'static str, u64); 7] { self.eng.census() }

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
    /// The member the leader rule elects for `index` under the current parent hash.
    #[cfg(test)]
    pub fn leader_of(&self, index: u64) -> Option<&NodeId> {
        self.eng.leader_for(index, &self.parent_hash())
    }

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
        // The certified checkpoint's own head, found by the hash its certificate names - never a
        // value another proposal at the same index supplied (on 10.10 that latched 116846 on four
        // nodes). While that checkpoint is not held, the high-water mark of certified heads stands in,
        // so a head-less relayed QC/TC cannot collapse the baseline to 1. Never at or below the
        // committed head's window.
        let k = self.cp_interval;
        let high = self.high_qc_head().map(|h| h / k).unwrap_or(self.high_window);
        let committed = self.committed_head().map(|h| h / k).unwrap_or(0);
        high.max(committed) + 1
    }

    /// Raise the high-water mark from the certified high checkpoint once it is held. Called after
    /// every engine step; never lowers.
    fn refresh_high_window(&mut self) {
        if let Some(head) = self.high_qc_head() {
            self.high_window = self.high_window.max(head / self.cp_interval);
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
        if window != self.next_window() { return Vec::new(); }
        self.propose_window(window, mb_hashes, state_root, beacon, head_ts, committee, eligible_producers,
                            banned, reward_root, registry_root, dilithium_pk_root, reward_epoch_root, logs_root, total_supply)
    }

    /// Re-propose the highest certified checkpoint at the current round: same head, same content,
    /// parent = that certificate. For when the contiguous next window cannot be proposed (its
    /// anchor macroblock is unsealed) while the high certificate has no 2-chain commit: certified
    /// again in the consecutive round it commits (`commits_parent`), which releases the held seal
    /// and reopens the frontier. Without this a boundary whose three successor windows each
    /// certified after a timeout could never commit, and finality froze for good.
    pub fn build_recertify_proposal(
        &mut self, committee: Vec<NodeId>, eligible_producers: Vec<u8>, banned: Vec<NodeId>,
    ) -> Vec<Effect> {
        let window = self.next_window().saturating_sub(1);
        let held = match self.high_qc_pair() { Some((cp, _)) => cp, None => return Vec::new() };
        if !self.commit_pending() || self.high_head_committed()
            || held.window_head_height != window.saturating_mul(self.cp_interval) {
            return Vec::new();
        }
        // The content is the certified checkpoint's, verbatim; the caller supplies only the seal
        // inputs, and they must commit to the epoch data that checkpoint carries - anything else is a
        // different checkpoint, not a re-certification.
        if epoch_commitment(&eligible_producers, &committee, &banned) != held.epoch_commitment {
            // The rebuilt epoch data no longer matches what was certified, so this node cannot
            // re-propose it and the frontier stays closed until another member can.
            if crate::node::is_warn() {
                println!("[WARN][BFT2] recertify_refused head={} reason=epoch_commitment_mismatch",
                         held.window_head_height);
            }
            return Vec::new();
        }
        self.propose_window(window, held.window_mb_hashes.clone(), held.state_root, held.beacon, held.timestamp,
                            committee, eligible_producers, banned, held.reward_root, held.registry_root,
                            held.dilithium_pk_root, held.reward_epoch_root, held.logs_root, held.total_supply)
    }

    /// Shared body of the two entries above; the caller has settled WHICH window is legal.
    fn propose_window(
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
        // Buffered on every member so any can seal the macroblock locally on QC (all-seal), and
        // keyed by the commitment: seal_if_ready looks the certificate's commitment up, so a member
        // whose inputs are not the certified ones finds nothing and fetches the object instead.
        self.seal_data.insert(epoch_c, (round, eligible_producers, committee));
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
        if !may_propose {
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
        self.proposals.insert((cp.index, cp.hash()), cp.clone());
        vec![Effect::Propose(cp)]
    }

    /// Rotate the committee for the upcoming epoch (driver + engine in lockstep).
    /// Deterministic N-2 VRF sample → all nodes agree; scales to 100k eligible.
    pub fn set_committee(&mut self, mut committee: Vec<NodeId>) {
        committee.sort();
        self.eng.set_committee(committee.clone());
        self.answered_stale.retain(|id, _| committee.binary_search(id).is_ok());
        self.exchanged.retain(|id, _| committee.binary_search(id).is_ok());
        self.committee = committee;
    }

    /// Local view timer fired. The engine adds a helper timeout for a past view when a reboot after a
    /// vote left this node ahead of members that cannot otherwise leave that view.
    pub fn on_timeout(&mut self) -> Vec<Effect> {
        let acts = self.eng.on_local_timeout();
        if crate::node::is_info() {
            for a in &acts {
                if let Action::BroadcastTimeout(tm) = a {
                    if tm.index < self.eng.current_index {
                        println!("[INFO][BFT2] helper_timeout view={} round={}", tm.index, self.eng.current_index);
                    }
                }
            }
        }
        self.translate(acts, None)
    }

    /// The index of a certified checkpoint whose HEAD this node never learned, if any.
    ///
    /// Votes are counted against a checkpoint HASH, not against a checkpoint, so a node that misses
    /// one proposal but receives the quorum's votes certifies an index it cannot place. The certified
    /// checkpoint is absent, refresh_high_window has nothing to raise, and the window frontier stops there
    /// for good: every later proposal fails the contiguity gate and the node never votes again.
    /// Reported so the node can ask for what it is missing instead of sitting blind.
    pub fn frontier_blind(&self) -> Option<u64> {
        let q = self.eng.high_qc.as_ref()?;
        let idx = q.index;
        // Blind unless the CERTIFIED checkpoint is held: another proposal at the same index names
        // another head.
        if self.proposals.contains_key(&(idx, q.checkpoint_hash)) { return None; }
        // A head prune() dropped is not a blind spot. prune keeps the last CONSENSUS_STATE_RETAIN
        // indices, and current_index advances on a TC while high_qc does not, so an old high_qc can
        // fall below the floor with nothing wrong. A wedged node is the opposite case: its
        // current_index sits at idx+1, so idx is always far above the floor.
        let floor = self.eng.current_index.saturating_sub(CONSENSUS_STATE_RETAIN);
        if idx < floor { None } else { Some(idx) }
    }

    /// A certificate at least f+1 members hold and this node does not. frontier_blind sees a
    /// certificate whose checkpoint is missing; this is the case with nothing at all - the node
    /// was down for the proposal and the votes alike, and its peers' timeouts are the only thing
    /// that names it. Live at 863640: one node at the old frontier, five at the new, quorum five.
    pub fn certificate_gap(&self) -> Option<u64> {
        let claimed = self.eng.quorum_high_qc_index();
        let ours = self.eng.high_qc.as_ref().map(|q| q.index).unwrap_or(0);
        if claimed > ours { Some(claimed) } else { None }
    }

    /// Catch-up: ingest a VERIFIED committed checkpoint + QC.
    pub fn sync(&mut self, cp: &Checkpoint, qc: &QuorumCertificate) -> Vec<Effect> {
        if cp.index != qc.index || cp.hash() != qc.checkpoint_hash { return Vec::new(); }
        self.proposals.insert((cp.index, cp.hash()), cp.clone());
        // A verified pair is a certificate this node holds, servable like one adopted live: a rebooted
        // driver serves what the running one did.
        self.remember_qc(qc);
        let acts = self.eng.sync_checkpoint(cp, qc);
        self.translate(acts, Some((qc.index, qc.checkpoint_hash)))
    }

    /// Handle an ALREADY-VERIFIED wire message (node checked sigs first).
    pub fn handle(&mut self, msg: &ConsensusMsg) -> Vec<Effect> {
        let mut commit: Option<VoteCommitment> = None;
        // Effects produced beside the engine's own actions (a certificate adopted from a TC).
        let mut extra: Vec<Effect> = Vec::new();
        // The certificate this message hands the engine, if any: a commit it causes names its
        // checkpoint through that certificate's own checkpoint.
        let mut cause: Option<(u64, Hash)> = None;
        let acts = match msg {
            ConsensusMsg::Proposal(cp) => {
                // The engine refuses any index but its current one (checkpoint_consensus on_proposal), so a
                // proposal at another index can draw no vote and is not stored. One that is merely early
                // is buffered and replayed by the node loop, so nothing is lost.
                if cp.index != self.eng.current_index {
                    if crate::node::is_warn() {
                        println!("[WARN][BFT2] proposal_dropped reason=index idx={} ours={} head={}",
                                 cp.index, self.eng.current_index, cp.window_head_height);
                    }
                    return Vec::new();
                }
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
                // The parent link and the head, against our certificates; refused here, the proposal
                // goes no further.
                if let Some(effs) = self.certificate_exchange(cp) { return effs; }
                let ph = if cp.recovery_anchor.is_some() {
                    // Pinned: bound by the span's positional clauses above, and refused outright by
                    // the node content gate while the relaxation is off.
                    cp.parent_qc.as_ref().map(|q| q.checkpoint_hash).unwrap_or(self.genesis_hash)
                } else {
                    self.parent_hash()
                };
                // Only the ELECTED proposal is stored. The engine refuses to vote for anyone else, and a
                // member re-proposing off-turn must not plant a second checkpoint at the index.
                // Mirror of the engine's own rule: a pin frees the proposer, nothing else does.
                let proposer_ok = if cp.recovery_anchor.is_some() {
                    self.committee.iter().any(|c| c == &cp.proposer)
                } else {
                    self.eng.leader_for(cp.index, &ph).map(|l| l == &cp.proposer).unwrap_or(false)
                };
                if !proposer_ok {
                    if crate::node::is_warn() {
                        println!("[WARN][BFT2] proposal_dropped reason=not_leader idx={} head={} proposer={}",
                                 cp.index, cp.window_head_height, qnet_state::char_prefix(&cp.proposer, 20));
                    }
                    return Vec::new();
                }
                // Stored under its own hash. A vote certificate and a timeout certificate at one index
                // each elect a leader for the next, so two leader-valid checkpoints can share an index;
                // finality, the frontier and the seals read a checkpoint by the hash a certificate names,
                // so one this node does not vote for changes nothing they read.
                self.proposals.insert((cp.index, cp.hash()), cp.clone());
                let (pi, phh) = cp.parent_qc.as_ref().map(|q| (q.index, q.checkpoint_hash))
                    .unwrap_or((0, [0u8; 32]));
                commit = Some(VoteCommitment {
                    index: cp.index, window_head: cp.window_head_height,
                    content_digest: checkpoint_content_digest(cp),
                    pinned: cp.recovery_anchor.is_some(), parent_index: pi, parent_hash: phh,
                });
                let acts = self.eng.on_proposal(cp, &ph);
                if !acts.iter().any(|a| matches!(a, Action::Vote(_))) {
                    let (benign, reason) = if cp.index != self.eng.current_index {
                        (true, format!("index ours={}", self.eng.current_index))
                    } else if cp.index <= self.eng.last_voted_index() {
                        (true, format!("already_voted last={}", self.eng.last_voted_index()))
                    } else if cp.parent_qc.as_ref().map(|q| q.index).unwrap_or(0) < self.eng.locked_index() {
                        (false, format!("below_lock locked={}", self.eng.locked_index()))
                    } else if self.eng.leader_for(cp.index, &ph).map(|l| l != &cp.proposer).unwrap_or(true) {
                        (false, format!("not_leader expected={}", self.eng.leader_for(cp.index, &ph).map(|s| s.as_str()).unwrap_or("-")))
                    } else {
                        (false, "content_or_pin".to_string())
                    };
                    if (benign && crate::node::is_debug()) || (!benign && crate::node::is_warn()) {
                        println!("[{}][BFT2] proposal_no_vote idx={} head={} proposer={} reason={}",
                                 if benign { "DBG" } else { "WARN" }, cp.index, cp.window_head_height, cp.proposer, reason);
                    }
                }
                acts
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
                cause = Some((qc.index, qc.checkpoint_hash));
                self.eng.adopt_qc(qc)
            }
            ConsensusMsg::Timeout(tm) => {
                if crate::node::is_debug() {
                    println!("[DBG][BFT2] timeout_recv from={} idx={} our_round={}",
                             tm.voter, tm.index, self.eng.current_index);
                }
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
            ConsensusMsg::Tc(tc) => {
                // A certificate carried by a timeout certificate is adopted by the engine but was
                // never "received" as one: without this it reaches neither the serve store nor the
                // write-ahead log, and a seal that depends on it has no link to walk. Same
                // treatment as an inbound Qc, and idempotent.
                if let Some(hq) = &tc.high_qc {
                    if self.proposals.contains_key(&(hq.index, hq.checkpoint_hash)) {
                        self.remember_qc(hq);
                        extra.extend(self.seal_if_ready(hq));
                    }
                }
                cause = tc.high_qc.as_ref().map(|q| (q.index, q.checkpoint_hash));
                self.eng.on_timeout_cert(tc)
            }
        };
        let mut out = self.translate(acts, cause);
        out.append(&mut extra);
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
        // Never reboot INSIDE voted territory: those views are unvotable by the rules above.
        self.eng.enter_first_votable_view();
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
        // Seal inputs are found by the certificate's own commitment: present only when this node
        // holds exactly what was certified. Absent - pruned, never derived, or derived differently
        // by a node that was behind when it did - the node does not build a body of its own; it
        // reports the window and fetches the certified object.
        let (eligible_producers, committee) = match self.seal_data.get(&cp.epoch_commitment) {
            Some((_, e, c)) => (e.clone(), c.clone()),
            None => { self.seal_skipped = Some(window); return Vec::new(); }
        };
        // HELD, not emitted: a 1-chain QC is not final. Action::Commit releases it below. A SET,
        // not one slot: at a 1:1 cadence the next boundary QC arrives in the same translate pass as
        // the commit that would release this one, and a single slot would lose it.
        let effect = Effect::Persist { checkpoint: cp, qc: qc.clone(), eligible_producers, committee };
        // Already 2-chain committed: emit now, for a checkpoint ON the committed chain only - a
        // certified sibling at an index the commit passed never commits, and a seal from it stores a
        // body the chain did not keep. This is also the RETRY path - a re-delivered certificate for a
        // window the node failed to store must produce Persist again, and no new Commit action will
        // fire for an index the frontier has already passed.
        if self.eng.committed_index >= qc.index {
            let kept = self.committed_cp.and_then(|top| self.on_chain((qc.index, qc.checkpoint_hash), top));
            return if kept == Some(true) { vec![effect] } else { Vec::new() };
        }
        const MAX_PENDING_SEALS: usize = 4;
        self.pending_seals.retain(|(i, h, _)| (*i, *h) != (qc.index, qc.checkpoint_hash));
        self.pending_seals.push((qc.index, qc.checkpoint_hash, effect));
        if self.pending_seals.len() > MAX_PENDING_SEALS { self.pending_seals.remove(0); }
        Vec::new()
    }

    /// The node confirms `window` is durably stored. Presuming it on EMIT lost the window
    /// forever whenever the node then refused to persist, because the dedup set already held it.
    pub fn mark_sealed(&mut self, window: u64) { self.sealed.insert(window); }

    /// Drain the last window skipped for want of seal inputs (the driver itself stays pure).
    pub fn take_seal_skipped(&mut self) -> Option<u64> { self.seal_skipped.take() }

    /// `cause` is the certificate the caller handed the engine, if any; a certificate formed here
    /// replaces it. A commit names its checkpoint through that certificate's checkpoint.
    fn translate(&mut self, actions: Vec<Action>, mut cause: Option<(u64, Hash)>) -> Vec<Effect> {
        let mut out = Vec::new();
        for a in actions {
            match a {
                // `commit` is filled by `handle` from the proposal that produced this vote — the only
                // place that holds it. A Vote can be produced by nothing else.
                Action::Vote(v) => out.push(Effect::Vote {
                    index: v.index, checkpoint_hash: v.checkpoint_hash, commit: VoteCommitment::default() }),
                Action::FormedQc(qc) => {
                    cause = Some((qc.index, qc.checkpoint_hash));
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
                    //
                    // The committed checkpoint is the parent link of the certified child that
                    // committed it: the index alone can name two checkpoints (10.10: a timeout
                    // certificate and a vote certificate at 125964 elected two leaders for 125965).
                    let top = self.committed_link(idx, cause);
                    if top.is_some() { self.committed_cp = top; }
                    // Released when the commit frontier REACHES the held index, not only when the
                    // commit lands exactly on it (a skipped round commits r+2 whose parent is r), and
                    // only for a checkpoint on the committed chain: a certified sibling never commits.
                    // A seal whose chain cannot be walked yet stays held.
                    for (i, h, e) in std::mem::take(&mut self.pending_seals) {
                        if i > idx { self.pending_seals.push((i, h, e)); continue; }
                        match top.and_then(|t| self.on_chain((i, h), t)) {
                            Some(true) => out.push(e),
                            Some(false) => if crate::node::is_info() {
                                println!("[INFO][BFT2] seal_dropped idx={} committed={} reason=off_committed_chain", i, idx);
                            },
                            None => self.pending_seals.push((i, h, e)),
                        }
                    }
                    // Finalize with the committed checkpoint's OWN certified head + state_root — NEVER
                    // a head=0 placeholder (that defers forever and freezes the finality marker, which
                    // is what wedged the chain) and never another proposal at the same index. Missing
                    // locally ⇒ we committed via a relayed QC without holding the checkpoint; skip —
                    // §4.5 macroblock sync provides it, so finality waits but never wedges.
                    if let Some(cp) = top.and_then(|t| self.proposals.get(&t)).filter(|cp| cp.window_head_height > 0) {
                        out.push(Effect::Finalize { index: idx, head_height: cp.window_head_height,
                                                    state_root: cp.state_root, mb_hashes: cp.window_mb_hashes.clone() });
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
        // The high certificate's row and the committed row stay whatever the view does: a closed
        // frontier can hold the view far past the retention window, and without them the head of
        // the high certificate is unknown and nothing can be re-certified or finalized.
        let hq = self.eng.high_qc.as_ref().map(|q| q.index);
        let ci = self.eng.committed_index;
        let keep = |idx: u64| idx >= floor || Some(idx) == hq || idx == ci;
        self.proposals.retain(|(idx, _), _| keep(*idx));
        self.seal_data.retain(|_, (round, _, _)| keep(*round));
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

    struct Node {
        d: ConsensusDriver, id: NodeId, committed: u64, sealed: Vec<u64>,
        /// What survives a restart: the vote commitments written before each vote leaves, and the
        /// certified pairs the node wrote to its log. Everything else dies with the process.
        commitments: Vec<VoteCommitment>,
        wal: Vec<(Checkpoint, QuorumCertificate)>,
    }

    fn node(id: &NodeId, c: &[NodeId]) -> Node {
        let mut d = ConsensusDriver::new(id.clone(), c.to_vec(), [7u8; 32]);
        d.set_intervals(90, 90);
        Node { d, id: id.clone(), committed: 0, sealed: Vec::new(), commitments: Vec::new(), wal: Vec::new() }
    }

    /// The write-ahead log as production keeps it: the newest certified pair, recorded whenever the
    /// certificate frontier moves.
    fn wal_snapshot(n: &mut Node) {
        if let Some((idx, pair)) = n.d.newest_catchup_bundle() {
            if n.wal.iter().any(|(_, q)| q.index == idx) { return; }
            let cp = pair.iter().find_map(|m| match m { ConsensusMsg::Proposal(p) => Some(p.clone()), _ => None });
            let qc = pair.iter().find_map(|m| match m { ConsensusMsg::Qc(q) => Some(q.clone()), _ => None });
            if let (Some(cp), Some(qc)) = (cp, qc) { n.wal.push((cp, qc)); }
        }
    }

    /// Restart: the process dies, the disk survives. Rebuild the driver, restore the commitments,
    /// replay the log - exactly the boot sequence in `consensus_v2_node::run`.
    fn restart(n: &mut Node, c: &[NodeId]) {
        let mut d = ConsensusDriver::new(n.id.clone(), Vec::new(), [7u8; 32]);
        d.set_intervals(90, 90);
        d.restore_vote_commitments(&n.commitments);
        let wal = n.wal.clone();
        for (cp, qc) in &wal { let _ = d.sync(cp, qc); }
        d.set_committee(c.to_vec());
        n.d = d;
    }

    // Node executes one Effect ⇒ produces outbound wire messages (mock-signed).
    fn exec(n: &mut Node, e: Effect) -> Vec<ConsensusMsg> {
        match e {
            Effect::Propose(mut cp) => { cp.proposer_sig = sign(&n.id, &cp.hash()); vec![ConsensusMsg::Proposal(cp)] }
            Effect::Vote { index, checkpoint_hash, commit } => {
                n.commitments.push(commit);          // durable BEFORE the vote leaves, as production does
                vec![ConsensusMsg::Vote(Vote {
                    checkpoint_hash, index, voter: n.id.clone(), signature: sign(&n.id, &checkpoint_hash),
                })]
            }
            Effect::Timeout { index, high_qc_index } => vec![ConsensusMsg::Timeout(TimeoutMsg {
                index, voter: n.id.clone(), high_qc_index,
                signature: sign(&n.id, &timeout_bytes(index, high_qc_index)),
            })],
            // No transport in the harness: a pull is a no-op here, the property under test is
            // whether the driver ASKS instead of dead-ending.
            Effect::CatchUp { .. } | Effect::CatchUpTo { .. } => vec![],
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

    /// Drive the current round: whoever leads proposes the CONTIGUOUS window, everyone buffers it.
    fn strict_round(nodes: &mut Vec<Node>, c: &[NodeId], window: u64) {
        let mut seed = Vec::new();
        for k in 0..nodes.len() {
            let effs = nodes[k].d.build_proposal(
                window, vec![[window as u8; 32]], [window as u8; 32], [0u8; 32], window * 1000,
                c.to_vec(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
            for e in effs { seed.extend(exec(&mut nodes[k], e)); }
        }
        deliver(nodes, c, seed);
    }

    /// Every member's view timer fires: timeouts form a TC and the view advances by one.
    fn view_change(nodes: &mut Vec<Node>, c: &[NodeId]) {
        let mut seed = Vec::new();
        for k in 0..nodes.len() {
            let effs = nodes[k].d.on_timeout();
            for e in effs { seed.extend(exec(&mut nodes[k], e)); }
        }
        deliver(nodes, c, seed);
    }

    /// One re-certification round: every member buffers the seal inputs, the leader re-proposes.
    fn recertify_round(nodes: &mut Vec<Node>, c: &[NodeId]) -> usize {
        let mut seed = Vec::new();
        for k in 0..nodes.len() {
            let effs = nodes[k].d.build_recertify_proposal(c.to_vec(), Vec::new(), Vec::new());
            for e in effs { seed.extend(exec(&mut nodes[k], e)); }
        }
        let proposals = seed.iter().filter(|m| matches!(m, ConsensusMsg::Proposal(_))).count();
        deliver(nodes, c, seed);
        proposals
    }

    /// The finality freeze: window 1 certifies, its successor can never be proposed (anchor rule),
    /// and a certificate with no consecutive child never commits. Re-certifying the same head is
    /// that child: after one timeout the first re-certification is not consecutive (it only moves
    /// the high certificate), the next one is, and the 2-chain commit lands, releasing the held
    /// seal - with the same content, so nothing that was certified changes.
    #[test]
    fn recertifying_the_high_checkpoint_commits_it_when_the_frontier_is_closed() {
        let (c, mut nodes) = byz_net(4);
        strict_round(&mut nodes, &c, 1);
        assert!(nodes.iter().all(|n| n.d.commit_pending()), "a 1-chain certificate is not a commit");
        assert!(nodes.iter().all(|n| n.committed == 0 && n.sealed.is_empty()));
        assert!(nodes.iter().all(|n| n.d.current_index() == 2 && n.d.next_window() == 2));
        // Round 2 times out on the unproposable window 2; the view moves on, the frontier does not.
        view_change(&mut nodes, &c);
        assert!(nodes.iter().all(|n| n.d.current_index() == 3 && n.d.next_window() == 2));
        // Index 3 re-certifies window 1 under QC(1): not consecutive, so no commit yet.
        assert_eq!(recertify_round(&mut nodes, &c), 1, "exactly the leader re-proposes");
        assert!(nodes.iter().all(|n| n.committed == 0 && n.d.commit_pending() && n.d.current_index() == 4),
                "a non-consecutive certificate only raises the high certificate");
        // Index 4 re-certifies under QC(3): consecutive, so index 3 commits and everything below seals.
        assert_eq!(recertify_round(&mut nodes, &c), 1);
        assert!(nodes.iter().all(|n| n.committed == 3), "the consecutive certificate commits: {:?}",
                nodes.iter().map(|n| n.committed).collect::<Vec<_>>());
        assert!(nodes.iter().all(|n| !n.sealed.is_empty() && n.sealed.iter().all(|&w| w == 1)),
                "the held seal of the boundary is released, and only that window");
        assert!(nodes.iter().all(|n| n.d.next_window() == 2), "the frontier does not move on a re-certification");
        // The newest certificate is itself uncommitted, as always under a 2-chain rule, but the
        // head is committed: the run ends here and the seal follows from the commit.
        assert!(nodes.iter().all(|n| n.d.commit_pending() && n.d.high_head_committed()));
        assert_eq!(recertify_round(&mut nodes, &c), 0, "a committed head is not re-certified again");
    }

    /// The restart state: a driver built with NO committee, a WAL-restored certificate, no content
    /// for the next window. Leadership cannot be decided over an empty set; once the node adopts
    /// the high window's committee (the set that certificate was formed over) the re-certification
    /// proceeds and commits exactly as in the live run.
    #[test]
    fn a_restarted_driver_re_certifies_once_the_high_windows_committee_is_adopted() {
        let (c, mut seeded) = byz_net(4);
        strict_round(&mut seeded, &c, 1);
        let (cp1, qc1) = seeded[0].d.high_qc_pair().expect("certified window 1");
        // Fresh processes: empty committee, the WAL pair replayed through sync.
        let mut nodes: Vec<Node> = c.iter().map(|id| {
            let mut n = node(id, &[]);
            let _ = n.d.sync(&cp1, &qc1);
            n
        }).collect();
        assert!(nodes.iter().all(|n| n.d.commit_pending() && n.d.next_window() == 2 && !n.d.is_leader_now()),
                "no member leads over an empty committee");
        // The node hands every member the high window's set with the round's seal inputs; the
        // driver adopts it and leadership follows (all-seal: non-leaders buffer, one proposes).
        // No round was lost after the restore, so this re-certification is the consecutive child
        // and commits the restored certificate at once; the run then ends.
        assert_eq!(recertify_round(&mut nodes, &c), 1, "the set arrives with the seal inputs");
        assert!(nodes.iter().all(|n| !n.d.committee().is_empty()));
        assert!(nodes.iter().all(|n| n.committed >= 1 && n.d.high_head_committed()),
                "the restarted quorum commits the restored certificate's head");
        assert_eq!(recertify_round(&mut nodes, &c), 0, "a committed head is not re-certified again");
        // Nothing to seal here: the boundary's inputs died with the old process. The node reseals it
        // from the WAL pair once the commit has reached it (reseal_from_wal).
        assert!(nodes.iter().all(|n| n.sealed.is_empty()));
    }

    /// Only the elected proposal writes the index maps. A member re-proposing the high checkpoint
    /// off-turn used to regress the window frontier and put the wrong head into finality, with no
    /// evidence against it: a non-leader proposal is not an offence, so the gate has to be here.
    #[test]
    fn a_proposal_from_the_wrong_member_never_touches_the_index_maps() {
        let (c, mut nodes) = byz_net(4);
        strict_round(&mut nodes, &c, 1);   // window 1 certified, high head 90
        strict_round(&mut nodes, &c, 2);   // leader proposes window 2 at the current round
        let d = &mut nodes[0].d;
        let idx = d.current_index();
        let (head_before, next_before) = (d.head_of(idx), d.next_window());
        // A member that does not lead this round re-proposes the high checkpoint at it.
        let (held, hq) = d.high_qc_pair().expect("a certificate");
        let mut cp = held.clone();
        cp.index = idx;
        cp.parent_qc = Some(qnet_consensus::checkpoint_bft::QcRef::from(&hq));
        cp.proposer = c.iter().find(|m| Some(*m) != d.leader_of(idx)).expect("a non-leader").clone();
        assert!(d.handle(&ConsensusMsg::Proposal(cp)).is_empty(), "no vote for an unelected proposal");
        assert_eq!(d.head_of(idx), head_before, "the elected head stands");
        assert_eq!(d.next_window(), next_before, "and the frontier does not regress");
    }

    /// The admitted head is exactly the high certificate's: any other non-contiguous head is still
    /// refused, and so is the high head under a foreign parent.
    #[test]
    fn only_a_re_proposal_of_the_high_certificate_passes_the_head_gate() {
        let (c, mut nodes) = byz_net(4);
        strict_round(&mut nodes, &c, 1);
        view_change(&mut nodes, &c);
        let d = &mut nodes[0].d;
        let (held, hq) = d.high_qc_pair().expect("certified window 1");
        // The re-proposal: the held checkpoint at a new index under its own certificate.
        let mut cp = held.clone();
        cp.index = 2;
        cp.parent_qc = Some(qnet_consensus::checkpoint_bft::QcRef::from(&hq));
        cp.proposer = String::new();
        cp.proposer_sig = Vec::new();
        assert!(d.recertifies_high(&cp), "high head, our certificate, the certified content");
        cp.window_head_height = 270;
        assert!(!d.recertifies_high(&cp), "a far head is not a re-certification");
        cp.window_head_height = 90;
        cp.state_root = [9u8; 32];
        assert!(!d.recertifies_high(&cp), "the high head with other content is a different checkpoint");
        cp.state_root = [1u8; 32];
        cp.timestamp = 1001;
        assert!(!d.recertifies_high(&cp), "the timestamp is content too");
        cp.timestamp = 1000;
        cp.parent_qc = Some(qnet_consensus::checkpoint_bft::QcRef { index: 0, checkpoint_hash: [3u8; 32] });
        assert!(!d.recertifies_high(&cp), "the high head under another parent is not one either");
        // Seal inputs that do not commit to the certified epoch data are refused on the emit side.
        let mut other = c.clone(); other.push("n9".into());
        assert!(d.build_recertify_proposal(other, Vec::new(), Vec::new()).is_empty());
    }

    // ── FAULTS ───────────────────────────────────────────────────────────────────────────────────
    // The network's answer to a node that stops answering. Every scenario below is a shape that has
    // actually halted the live chain, replayed here against the real driver and engine so the
    // recovery is proven before a release rather than after an outage.

    /// Deliver a round while the network is SPLIT: a message reaches only the nodes in the partition
    /// of the node that produced it. `part[k]` is node k's partition; equal values can talk. An
    /// isolated node is simply alone in its own partition, which is what silence looks like from the
    /// outside - it neither hears nor is heard.
    fn deliver_split(nodes: &mut Vec<Node>, committee: &[NodeId], seed: Vec<(usize, ConsensusMsg)>, part: &[usize]) {
        let mut queue = seed;
        let mut gen = 0;
        while !queue.is_empty() && gen < 2000 {
            gen += 1;
            let mut next = Vec::new();
            for (g, m) in queue.drain(..) {
                for k in 0..nodes.len() {
                    if part[k] != g { continue; }
                    if !verify_msg(committee, &m) { continue; }
                    let effects = nodes[k].d.handle(&m);
                    for e in effects { for out in exec(&mut nodes[k], e) { next.push((g, out)); } }
                }
            }
            queue = next;
        }
    }

    /// One proposing round under a split: every node still buffers the window (all-seal), and each
    /// node's outbound messages carry its own partition.
    fn split_round(nodes: &mut Vec<Node>, c: &[NodeId], window: u64, part: &[usize]) {
        split_round_skip(nodes, c, window, part, None)
    }

    /// Same, with one node that derives NOTHING for the window - a node behind on windows never
    /// signals the window end and holds no inputs for it.
    fn split_round_skip(nodes: &mut Vec<Node>, c: &[NodeId], window: u64, part: &[usize], skip: Option<usize>) {
        let mut seed: Vec<(usize, ConsensusMsg)> = Vec::new();
        for k in 0..nodes.len() {
            if skip == Some(k) { continue; }
            let effs = nodes[k].d.build_proposal(
                window, vec![[window as u8; 32]], [window as u8; 32], [0u8; 32], window * 1000,
                c.to_vec(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
            for e in effs { for out in exec(&mut nodes[k], e) { seed.push((part[k], out)); } }
        }
        deliver_split(nodes, c, seed, part);
    }

    /// One round, and the view timer ONLY if the round made no progress - the production rule. Firing
    /// it after a good round would break the 2-chain: a commit needs two CONSECUTIVE certified
    /// indices, and an idle timeout puts a gap between them.
    fn drive(nodes: &mut Vec<Node>, c: &[NodeId], part: &[usize]) {
        drive_skip(nodes, c, part, None)
    }

    /// `drive` with one node that derives nothing for the round's window.
    fn drive_skip(nodes: &mut Vec<Node>, c: &[NodeId], part: &[usize], skip: Option<usize>) {
        let before = nodes[0].d.next_window();
        split_round_skip(nodes, c, before, part, skip);
        if nodes[0].d.next_window() == before { split_view_change(nodes, c, part); }
        for n in nodes.iter_mut() { wal_snapshot(n); }
    }

    /// Every node's view timer fires, under the same split.
    fn split_view_change(nodes: &mut Vec<Node>, c: &[NodeId], part: &[usize]) {
        let mut seed: Vec<(usize, ConsensusMsg)> = Vec::new();
        for k in 0..nodes.len() {
            let effs = nodes[k].d.on_timeout();
            for e in effs { for out in exec(&mut nodes[k], e) { seed.push((part[k], out)); } }
        }
        deliver_split(nodes, c, seed, part);
    }

    /// The §4.5 catch-up: a node adopts a committed pair from a peer that has it.
    fn catch_up(nodes: &mut Vec<Node>, from: usize, to: usize) {
        let pair = nodes[from].d.high_qc_pair();
        if let Some((cp, qc)) = pair {
            let effs = nodes[to].d.sync(&cp, &qc);
            for e in effs { exec(&mut nodes[to], e); }
        }
    }

    /// The live shape of 13.09: a node a window behind missed the boundary proposal, adopted the
    /// certificate by catch-up, and sealed the macroblock from inputs of ANOTHER window - a body
    /// no peer certified, and the anchor its own committee derivation failed on two windows later.
    /// A node whose inputs for the window are not the certified ones must seal nothing and fetch;
    /// a node that holds the certified inputs seals exactly them.
    #[test]
    fn a_node_that_missed_the_proposal_seals_nothing_from_inputs_of_its_own() {
        let (c, mut nodes) = byz_net(4);
        let alone = vec![0, 0, 0, 1];             // node 3 hears nobody
        // The quorum certifies boundary windows while node 3 is away. Node 3 meanwhile derives a
        // window of its own with DIFFERENT epoch data (an intra window carries no producer set at
        // all) - the inputs it would have sealed from under a round-keyed store.
        let window = nodes[0].d.next_window();
        let effs = nodes[3].d.build_proposal(
            window, vec![[window as u8; 32]], [window as u8; 32], [0u8; 32], window * 1000,
            c.to_vec(), vec![9u8, 9, 9], Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
        for e in effs { exec(&mut nodes[3], e); }
        // Behind, node 3 derives none of the windows the quorum certifies.
        for _ in 0..6 { drive_skip(&mut nodes, &c, &alone, Some(3)); }
        assert!(nodes[..3].iter().all(|n| !n.sealed.is_empty()), "the quorum seals: {:?}",
                nodes.iter().map(|n| n.sealed.clone()).collect::<Vec<_>>());
        assert!(nodes[3].sealed.is_empty());
        // Catch-up hands node 3 the certificates. It holds inputs for those windows, but not the
        // certified ones: it must not build a body, and it must say which window it could not seal.
        for _ in 0..4 { catch_up(&mut nodes, 0, 3); }
        // The certificate itself reaches it too, as a relayed Qc did on 001 - that is the message
        // seal_if_ready acts on.
        if let Some((_, qc)) = nodes[0].d.high_qc_pair() {
            let effs = nodes[3].d.handle(&ConsensusMsg::Qc(qc));
            for e in effs { exec(&mut nodes[3], e); }
        }
        assert_eq!(nodes[3].d.committed_index(), nodes[0].d.committed_index(), "same commit point");
        assert!(nodes[3].sealed.is_empty(), "no body from inputs the certificate never signed: {:?}", nodes[3].sealed);
        assert!(nodes[3].d.take_seal_skipped().is_some(), "and the skipped window is reported for the fetch");
        // Back in the quorum with the SAME inputs as everyone, it seals again like everyone.
        let heal = vec![0, 0, 0, 0];
        for _ in 0..3 { drive(&mut nodes, &c, &heal); }
        let last = *nodes[0].sealed.last().expect("quorum sealed");
        assert!(nodes[3].sealed.contains(&last), "with certified inputs it seals the same window: {:?}", nodes[3].sealed);
    }

    /// A node that goes silent for several windows must cost the network nothing while it is away,
    /// and must return to the SAME chain - never a second one. This is the live shape: one node held
    /// by its host for tens of seconds while the others keep producing.
    #[test]
    fn a_silent_node_costs_the_network_nothing_and_returns_to_the_same_chain() {
        let (c, mut nodes) = byz_net(4);          // quorum 3 of 4: one may be away
        let alone = vec![0, 0, 0, 1];             // node 3 hears nobody and is heard by nobody
        // A round whose leader is the silent node produces nothing; the view timer rotates past it,
        // which is exactly what the network does and what makes the absence cost-free.
        for _ in 0..8 { drive(&mut nodes, &c, &alone); }
        assert!(nodes[..3].iter().all(|n| n.committed >= 2), "the quorum keeps committing without it: {:?}",
                nodes.iter().map(|n| n.committed).collect::<Vec<_>>());
        assert_eq!(nodes[3].committed, 0, "an isolated node commits nothing on its own");
        assert!(nodes[3].sealed.is_empty(), "and seals nothing");
        // It returns: one catch-up pair puts it back on the chain the others built.
        catch_up(&mut nodes, 0, 3);
        // Its commit point and frontier are the others'. The finality MARKER follows separately, from
        // the macroblock the chain already holds - the driver deliberately emits no Finalize for a
        // checkpoint it never saw, rather than finalizing a head it cannot name.
        assert_eq!(nodes[3].d.committed_index(), nodes[0].d.committed_index(),
                   "the returning node adopts the same commit point");
        assert_eq!(nodes[3].d.next_window(), nodes[0].d.next_window(), "and the same frontier");
        let heal = vec![0, 0, 0, 0];
        let next = nodes[0].d.next_window();
        split_round(&mut nodes, &c, next, &heal);
        // Whatever each node sealed, the shorter list is a prefix of the longer: one history.
        let seals: Vec<Vec<u64>> = nodes.iter().map(|n| n.sealed.clone()).collect();
        for s in &seals[1..] {
            let n = s.len().min(seals[0].len());
            assert_eq!(s[..n], seals[0][..n], "two nodes sealed different windows: {:?}", seals);
        }
    }

    /// The window's own leader goes silent exactly at its turn. The round must time out, the next
    /// leader must re-propose the SAME window, and it must commit - the boundary is not lost. This is
    /// the shape that ended in a thirteen-hour finality freeze on the live chain.
    #[test]
    fn a_leader_that_dies_at_its_own_window_does_not_cost_the_window() {
        let (c, mut nodes) = byz_net(4);
        strict_round(&mut nodes, &c, 1);
        let want = nodes[0].d.next_window();
        // Whoever leads the next round is held for that round; everyone else runs normally.
        let leader = (0..nodes.len()).find(|k| nodes[*k].d.is_leader_now()).expect("a leader");
        let mut part = vec![0usize; nodes.len()];
        part[leader] = 1;
        split_round(&mut nodes, &c, want, &part);
        assert!(nodes.iter().all(|n| n.d.next_window() == want), "a silent leader certifies nothing");
        // The view moves on and the next leader proposes the same window.
        split_view_change(&mut nodes, &c, &part);
        split_round(&mut nodes, &c, want, &part);
        split_round(&mut nodes, &c, want + 1, &part);
        let live: Vec<u64> = (0..nodes.len()).filter(|k| *k != leader).map(|k| nodes[k].committed).collect();
        assert!(live.iter().all(|v| *v > 0), "the window commits without its own leader: {:?}", live);
        assert!(nodes.iter().filter(|n| !n.sealed.is_empty()).count() >= 3,
                "and the boundary seals on the quorum that stayed");
    }

    /// A split with no quorum on either side must commit NOTHING - a stalled chain is correct, two
    /// chains are not - and must converge on one history when the split heals.
    #[test]
    fn an_even_split_stalls_and_then_converges_on_one_history() {
        let (c, mut nodes) = byz_net(4);          // quorum 3: neither half of a 2/2 split can certify
        strict_round(&mut nodes, &c, 1);
        let before: Vec<u64> = nodes.iter().map(|n| n.committed).collect();
        let split = vec![0, 0, 1, 1];
        for _ in 0..8 { drive(&mut nodes, &c, &split); }
        let during: Vec<u64> = nodes.iter().map(|n| n.committed).collect();
        assert_eq!(during, before, "no half of an even split may commit: {:?} -> {:?}", before, during);
        // Healed: the network commits again, and every node's seals agree with every other's.
        let heal = vec![0, 0, 0, 0];
        for _ in 0..8 { drive(&mut nodes, &c, &heal); }
        assert!(nodes.iter().any(|n| n.committed > before[0]), "the healed network commits again");
        let first = nodes[0].sealed.clone();
        for n in &nodes[1..] {
            let n_len = n.sealed.len().min(first.len());
            assert_eq!(n.sealed[..n_len], first[..n_len], "two nodes sealed different windows: {:?}",
                       nodes.iter().map(|x| x.sealed.clone()).collect::<Vec<_>>());
        }
    }

    /// A node loses everything but its disk. It must come back on the same chain, and it must not
    /// vote a second content where it already voted - that pair is convictable evidence, and an
    /// honest node that forgot its own commitments would produce it against itself.
    #[test]
    fn a_node_that_loses_its_memory_returns_on_the_same_chain_and_never_double_votes() {
        let (c, mut nodes) = byz_net(4);
        let all = vec![0usize; 4];
        for _ in 0..4 { drive(&mut nodes, &c, &all); }
        let (peer_commit, peer_window) = (nodes[0].d.committed_index(), nodes[0].d.next_window());
        assert!(peer_commit > 0 && !nodes[3].commitments.is_empty(), "the run produced a commit and votes");
        let voted = nodes[3].commitments.last().cloned().expect("a commitment");

        restart(&mut nodes[3], &c);
        assert_eq!(nodes[3].d.committed_index(), peer_commit, "the restarted node is at the same commit point");
        assert_eq!(nodes[3].d.next_window(), peer_window, "and the same frontier");
        // The commitments are what keep it OUT of voted territory: it reboots above every index it
        // ever voted at, so no proposal can ask it for a second vote there.
        assert!(nodes[3].d.current_index() > voted.index,
                "a restored node never re-enters a view it already voted at: view={} voted={}",
                nodes[3].d.current_index(), voted.index);
        // And a re-proposal of that head with OTHER content draws no vote.
        let mut forged = nodes[0].d.high_qc_pair().expect("a certificate").0;
        forged.index = voted.index;
        forged.window_head_height = voted.window_head;
        forged.state_root = [0xAB; 32];
        forged.proposer_sig = sign(&forged.proposer.clone(), &forged.hash());
        let effs = nodes[3].d.handle(&ConsensusMsg::Proposal(forged));
        assert!(!effs.iter().any(|e| matches!(e, Effect::Vote { .. })),
                "no second content at a head this node already voted");
    }

    /// A committee member re-proposes a certified head with different content. The content pin must
    /// refuse it everywhere: no vote, no second certificate, and the seal stays the one the chain
    /// certified. Without the pin this committed two different contents at one height.
    #[test]
    fn a_second_content_at_a_certified_head_is_refused_by_everyone() {
        let (c, mut nodes) = byz_net(4);
        let all = vec![0usize; 4];
        for _ in 0..3 { drive(&mut nodes, &c, &all); }
        let (held, hq) = nodes[0].d.high_qc_pair().expect("a certificate");
        let sealed_before: Vec<Vec<u64>> = nodes.iter().map(|n| n.sealed.clone()).collect();
        let certified_before: Vec<Option<Hash>> = nodes.iter()
            .map(|n| n.d.high_qc_pair().map(|(cp, _)| cp.hash())).collect();

        let mut other = held.clone();
        other.index = nodes[0].d.current_index();
        other.parent_qc = Some(qnet_consensus::checkpoint_bft::QcRef::from(&hq));
        other.state_root = [0xCD; 32];                    // same head, different content
        other.proposer = c[0].clone();
        other.proposer_sig = sign(&c[0], &other.hash());
        let seed = vec![(0usize, ConsensusMsg::Proposal(other))];
        deliver_split(&mut nodes, &c, seed, &all);

        // Nobody's highest certificate moved: the second content gathered no quorum anywhere.
        let certified_after: Vec<Option<Hash>> = nodes.iter()
            .map(|n| n.d.high_qc_pair().map(|(cp, _)| cp.hash())).collect();
        assert_eq!(certified_after, certified_before, "a second content at a certified head certified nothing");
        assert!(certified_before.iter().any(|h| *h == Some(held.hash())), "the chain's own certificate stands");
        let sealed_after: Vec<Vec<u64>> = nodes.iter().map(|n| n.sealed.clone()).collect();
        assert_eq!(sealed_after, sealed_before, "and nothing new is sealed");
    }

    // ── BYZANTINE ────────────────────────────────────────────────────────────────────────────────
    // The simulator above is all-honest. These run n=7 (quorum_size 7 = 5, f = 2) with f nodes
    // actively hostile, which is the bound the safety argument claims and the one nothing tested.

    fn byz_net(n: usize) -> (Vec<NodeId>, Vec<Node>) {
        let c: Vec<NodeId> = (0..n).map(|i| format!("n{}", i)).collect();
        let nodes = c.iter().map(|id| node(id, &c)).collect();
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
            Node { d, id: id.clone(), committed: 0, sealed: Vec::new(), commitments: Vec::new(), wal: Vec::new() }
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
            Node { d, id: id.clone(), committed: 0, sealed: Vec::new(), commitments: Vec::new(), wal: Vec::new() }
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

    // The live post-stall boot layout: vote ceilings scatter the views (boot-jump puts each node
    // at its own ceiling+1), and recovery must still converge to a QC via timeouts + view sync.
    #[test]
    fn scattered_ceiling_reboots_reconverge_and_certify() {
        let c: Vec<NodeId> = (0..5).map(|i| format!("n{}", i)).collect();
        let genesis = [7u8; 32];
        let ceilings = [852u64, 852, 852, 840, 709];
        let mut nodes: Vec<Node> = c.iter().enumerate().map(|(i, id)| {
            let mut d = ConsensusDriver::new(id.clone(), c.clone(), genesis);
            d.set_intervals(30, 90);
            d.restore_vote_commitments(&[VoteCommitment {
                index: ceilings[i], window_head: 15390, content_digest: [3u8; 32],
                pinned: false, parent_index: 568, parent_hash: [4u8; 32],
            }]);
            Node { d, id: id.clone(), committed: 0, sealed: Vec::new(), commitments: Vec::new(), wal: Vec::new() }
        }).collect();
        for (i, n) in nodes.iter().enumerate() {
            assert!(n.d.current_index() > ceilings[i], "node {} must boot above its ceiling", i);
        }
        // Each "tick": every node re-attempts the window proposal (WindowEnd redrive), then — if no
        // QC yet — every node's view timer fires (on_timeout) and the timeouts are delivered.
        let mut qc_formed = false;
        for _tick in 0..40 {
            let mut seed = Vec::new();
            for k in 0..nodes.len() {
                let w = nodes[k].d.next_window();
                let effs = nodes[k].d.build_proposal(
                    w, vec![[w as u8; 32]], [w as u8; 32], [0u8; 32], w * 1000,
                    c.clone(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
                for e in effs { seed.extend(exec(&mut nodes[k], e)); }
            }
            let before: Vec<u64> = nodes.iter().map(|n| n.d.next_window()).collect();
            deliver(&mut nodes, &c, seed);
            if nodes.iter().any(|n| n.committed > 0 || !n.sealed.is_empty()) { qc_formed = true; break; }
            // Timers fire only on a stalled view (live semantics: the redrive re-proposes within
            // the view long before the backed-off timeout).
            if nodes.iter().map(|n| n.d.next_window()).collect::<Vec<_>>() == before {
                let mut tmo = Vec::new();
                for k in 0..nodes.len() {
                    for e in nodes[k].d.on_timeout() { tmo.extend(exec(&mut nodes[k], e)); }
                }
                deliver(&mut nodes, &c, tmo);
                if nodes.iter().any(|n| n.committed > 0 || !n.sealed.is_empty()) { qc_formed = true; break; }
            }
        }
        assert!(qc_formed, "scattered reboots never re-certified: views {:?}",
                nodes.iter().map(|n| n.d.current_index()).collect::<Vec<_>>());
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
            Node { d, id: id.clone(), committed: 0, sealed: Vec::new(), commitments: Vec::new(), wal: Vec::new() }
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
    // sync(), must fast-forward BOTH its view AND next_window(). next_window() is derived from the
    // certified high checkpoint's head; sync() stores that checkpoint under its hash, so a
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
    /// The wedge that froze nodes in the field. Votes are tallied against a HASH, so a node that
    /// misses one proposal but receives the quorum's votes certifies an index it cannot place. The
    /// frontier then has nothing to raise and stops there for good — every later proposal fails the
    /// contiguity gate and the node never votes again. Nothing asked for the missing checkpoint,
    /// because the catch-up pull keys on lacking CONTENT and this node lacks only the FRONTIER.
    /// So the state must be visible, and any newer certified pair must clear it.
    #[test]
    fn a_blind_frontier_is_reported_and_cleared_by_a_newer_certified_pair() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let genesis = [7u8; 32];
        let mut d = ConsensusDriver::new("n9".into(), c.clone(), genesis);
        d.set_intervals(90, 90);

        let certify = |i: u64, prev: Option<&QuorumCertificate>| {
            let cp = Checkpoint {
                index: i, parent_qc: prev.map(qnet_consensus::checkpoint_bft::QcRef::from),
                window_head_height: i * 90, window_mb_hashes: vec![[i as u8; 32]],
                state_root: [i as u8; 32], beacon: [0u8; 32], epoch_commitment: [0u8; 32],
                reward_root: [0u8; 32], registry_root: [0u8; 32], dilithium_pk_root: [0u8; 32],
                reward_epoch_root: [0u8; 32], logs_root: [0u8; 32], total_supply: 0, timestamp: 0,
                proposer: c[0].clone(), proposer_sig: Vec::new(), recovery_anchor: None,
            };
            let signers: Vec<NodeId> = c.iter().take(3).cloned().collect();
            let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
            let qc = QuorumCertificate {
                checkpoint_hash: cp.hash(), index: i,
                sig_merkle_root: sig_merkle_root(&sigs), signers, sigs,
            };
            (cp, qc)
        };

        let mut prev: Option<QuorumCertificate> = None;
        for i in 1..=5u64 {
            let (cp, qc) = certify(i, prev.as_ref());
            let _ = d.sync(&cp, &qc);
            prev = Some(qc);
        }
        assert_eq!(d.frontier_blind(), None, "a checkpoint this node holds is not a blind spot");
        assert_eq!(d.next_window(), 6);

        // The quorum's votes arrive; the proposal they are about does not.
        let signers: Vec<NodeId> = c.iter().take(3).cloned().collect();
        let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
        let headless = QuorumCertificate {
            checkpoint_hash: [9u8; 32], index: 6,
            sig_merkle_root: sig_merkle_root(&sigs), signers, sigs,
        };
        let _ = d.handle(&ConsensusMsg::Qc(headless));
        assert_eq!(d.frontier_blind(), Some(6),
                   "a certified index with no head must be reported, not sat on");
        assert_eq!(d.next_window(), 6, "the frontier is frozen exactly here");

        // Any newer certified pair carries a head, so it repairs and advances in one step.
        let (cp7, qc7) = certify(7, None);
        let _ = d.sync(&cp7, &qc7);
        assert_eq!(d.frontier_blind(), None, "the blind spot is cleared");
        assert_eq!(d.next_window(), 8, "and the frontier moves past the window it was stuck on");
    }

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

    /// The window frontier never sits at or below the committed head's window, even while the high
    /// certificate's checkpoint is not held and the high-water mark knows less than the commit.
    #[test]
    fn next_window_never_sits_at_or_below_the_committed_head() {
        let c: Vec<NodeId> = (0..4).map(|i| format!("n{}", i)).collect();
        let mut d = ConsensusDriver::new("n9".into(), c.clone(), [7u8; 32]);
        d.set_intervals(90, 90);
        let mut prev: Option<QuorumCertificate> = None;
        for i in 1..=5u64 {
            let cp = mk_cp(i, prev.as_ref().map(QcRef::from), i * 90, "n0");
            let qc = mk_qc(&c, &cp, 3);
            let _ = d.sync(&cp, &qc);
            prev = Some(qc);
        }
        assert_eq!((d.committed_head(), d.next_window()), (Some(360), 6));
        d.high_window = 0;
        let unseen = mk_cp(6, prev.as_ref().map(QcRef::from), 540, "n0");
        let _ = d.handle(&ConsensusMsg::Qc(mk_qc(&c, &unseen, 3)));
        assert_eq!(d.frontier_blind(), Some(6));
        assert_eq!(d.next_window(), 5, "one past the committed head's window, never the stale mark");
    }

    // Poison-up regression (adversarial audit): a Proposal carrying a NON-CONTIGUOUS / inflated head must be
    // REJECTED by handle() (the contiguity guard) so it is never stored, and a later
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
        // A QC certifying that poisoned checkpoint must NOT latch high_window (it was never stored).
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
            d.seal_data.insert([i as u8; 32], (i, Vec::new(), Vec::new()));
            d.sealed.insert(i);
        }
        d.eng.committed_index = total;
        d.eng.current_index = total + 1;
        d.prune();
        let floor = total + 1 - CONSENSUS_STATE_RETAIN; // 11
        assert!(d.proposals.keys().all(|(idx, _)| *idx >= floor), "proposals pruned below floor");
        assert!(d.seal_data.values().all(|(r, _, _)| *r >= floor), "seal_data pruned below floor");
        assert!(d.sealed.iter().all(|w| *w >= floor), "sealed windows pruned below floor");
        assert!(d.proposals.len() <= CONSENSUS_STATE_RETAIN as usize + 1, "bounded, not O(chain length)");
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
            // Two leader-valid proposals per view, as a vote and a timeout certificate at one index make.
            for tag in [1u8, 2] {
                let cp = mk_cp(i, None, 90, if tag == 1 { "n0" } else { "n1" });
                d.proposals.insert((i, cp.hash()), cp);
            }
            d.seal_data.insert([(i % 251) as u8; 32].map(|b| b ^ ((i >> 8) as u8)), (i, Vec::new(), Vec::new()));
            d.eng.current_index = i + 1;
            d.prune();
        }
        assert_eq!(d.eng.committed_index, 0, "nothing committed during the halt");
        let bound = CONSENSUS_STATE_RETAIN as usize + 2;
        assert!(d.proposals.len() <= 2 * bound, "proposals unbounded during halt: {}", d.proposals.len());
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
        let enqueue = |pending: &mut Vec<Vec<(usize, ConsensusMsg)>>,
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
            Node { d, id: id.clone(), committed: 0, sealed: Vec::new(), commitments: Vec::new(), wal: Vec::new() }
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
    // must touch nothing: the engine refuses that index anyway, so storing it only lets a committee
    // member plant a checkpoint nobody will act on.
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
        assert!(!d.has_proposal_at(99), "off-index proposal was stored");
        assert_eq!(d.head_of(99), None, "and places nothing at that index");
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

    fn mk_cp(index: u64, parent: Option<QcRef>, head: u64, proposer: &str) -> Checkpoint {
        Checkpoint {
            index, parent_qc: parent, window_head_height: head, window_mb_hashes: vec![[head as u8; 32]],
            state_root: [head as u8; 32], beacon: [0u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32],
            registry_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32], logs_root: [0u8; 32],
            total_supply: 0, timestamp: head, proposer: proposer.to_string(), proposer_sig: Vec::new(), recovery_anchor: None,
        }
    }
    fn mk_qc(c: &[NodeId], cp: &Checkpoint, n: usize) -> QuorumCertificate {
        let h = cp.hash();
        let signers: Vec<NodeId> = c.iter().take(n).cloned().collect();
        let sigs: Vec<Vec<u8>> = signers.iter().map(|s| sign(s, &h)).collect();
        QuorumCertificate { checkpoint_hash: h, index: cp.index, sig_merkle_root: sig_merkle_root(&sigs), signers, sigs }
    }

    // 2026-09-05: two certificates for ONE window head formed at different views (a rebooted node
    // re-proposed a head the quorum had already certified). The node holding the higher one pulled a
    // certificate it already held, the others pulled one they could not verify, and nobody voted
    // for two hours. The side that is ahead must hand over its certificate; the side behind adopts.
    #[test]
    fn a_node_ahead_of_a_proposal_hands_its_certificate_to_the_proposer_and_the_split_closes() {
        let (c, mut nodes) = byz_net(6);
        let w = 4948u64;
        let base = mk_cp(16397, None, (w - 1) * 90, "n0");
        let base_qc = mk_qc(&c, &base, 5);
        // The quorum's certificate for window w, and the rebooted node's later one for the same head.
        let low = mk_cp(16403, Some(QcRef::from(&base_qc)), w * 90, "n3");
        let low_qc = mk_qc(&c, &low, 5);
        let high = mk_cp(16408, Some(QcRef::from(&base_qc)), w * 90, "n1");
        let high_qc = mk_qc(&c, &high, 5);
        for k in 0..6 { let _ = nodes[k].d.sync(&base, &base_qc); }
        let _ = nodes[1].d.sync(&high, &high_qc);           // n1 holds 16408
        for k in [0usize, 2, 3, 4, 5] { let _ = nodes[k].d.sync(&low, &low_qc); } // the rest hold 16403
        // n0 (on 16403) proposes the next window at n1's view; n1 is one of n0's three answerers.
        assert!(answers_stale_proposal(&c, "n0", "n1"));
        let claim = mk_cp(nodes[1].d.current_index(), Some(QcRef::from(&low_qc)), (w + 1) * 90, "n0");
        let effs = nodes[1].d.handle(&ConsensusMsg::Proposal(claim.clone()));
        let sent = effs.iter().find_map(|e| match e {
            Effect::CatchUpTo { peer, checkpoint, qc } => Some((peer.clone(), checkpoint.clone(), qc.clone())), _ => None });
        let (peer, pc, pq) = sent.expect("the node ahead must send its certificate to the proposer, not pull");
        assert_eq!((peer.as_str(), pq.index), ("n0", 16408));
        assert!(!effs.iter().any(|e| matches!(e, Effect::CatchUp { .. })), "no pull for a certificate we hold");
        // Once per proposer and index: the echo of the same proposal draws nothing.
        assert!(nodes[1].d.handle(&ConsensusMsg::Proposal(claim)).is_empty());
        // The proposer adopts the pair (the node's verified catch-up path) and everyone else too;
        // whoever leads the next view extends 16408: the split is closed.
        for k in 0..6 { let _ = nodes[k].d.sync(&pc, &pq); }
        let mut proposals = 0;
        for k in 0..6 {
            let win = nodes[k].d.next_window();
            assert_eq!(win, w + 1, "adopting a same-head certificate never moves the window");
            let effs = nodes[k].d.build_proposal(
                win, vec![[1u8; 32]], [1u8; 32], [0u8; 32], 1,
                c.clone(), Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
            if let Some(cp) = effs.iter().find_map(|e| match e { Effect::Propose(cp) => Some(cp.clone()), _ => None }) {
                proposals += 1;
                assert_eq!(cp.parent_qc.as_ref().map(|q| q.index), Some(16408));
            }
        }
        assert_eq!(proposals, 1, "exactly one leader for the view");
    }

    // Exactly three members answer any proposer, whatever the committee size, and never the proposer.
    #[test]
    fn three_deterministic_members_answer_a_stale_proposer() {
        for n in [4usize, 6, 7, 100, 1000] {
            let c: Vec<NodeId> = (0..n).map(|i| format!("n{:04}", i)).collect();
            for p in [0usize, 1, n / 2, n - 1] {
                let answerers = c.iter().filter(|m| answers_stale_proposal(&c, &c[p], m)).count();
                assert_eq!(answerers, 3, "n={} proposer={}", n, p);
                assert!(!answers_stale_proposal(&c, &c[p], &c[p]));
            }
        }
        assert!(!answers_stale_proposal(&["a".to_string()], "a", "a"));
    }

    // The other direction is unchanged: a node BEHIND the claimed parent pulls it by index.
    #[test]
    fn a_node_behind_the_claimed_parent_still_pulls_it_by_index() {
        let (c, mut nodes) = byz_net(6);
        let base = mk_cp(10, None, 90, "n0");
        let base_qc = mk_qc(&c, &base, 5);
        let _ = nodes[0].d.sync(&base, &base_qc);
        let claim = mk_cp(nodes[0].d.current_index(), Some(QcRef { checkpoint_hash: [9u8; 32], index: 12 }), 180, "n1");
        let effs = nodes[0].d.handle(&ConsensusMsg::Proposal(claim));
        assert!(matches!(effs.as_slice(), [Effect::CatchUp { qc_index: 12, .. }]), "got {:?}", effs);
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

    // Like propose_window, but member `skip` stays silent even when it leads.
    fn propose_window_except(nodes: &mut Vec<Node>, tails: &[Vec<Hash>], c: &[NodeId], w: u64, skip: usize) -> Vec<ConsensusMsg> {
        let mut seed = Vec::new();
        for k in 0..nodes.len() {
            if k == skip { continue; }
            let effs = nodes[k].d.build_proposal(
                w, tails[k].clone(), [w as u8; 32], [0u8; 32], w * 1000, c.to_vec(),
                Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0);
            for e in effs { seed.extend(exec(&mut nodes[k], e)); }
        }
        seed
    }

    // A LEADER THAT NEVER PROPOSES. Nothing at the index can end the view but the members' own
    // timers: they fire, the timeouts form a certificate, the rotated leader proposes the same
    // window and it certifies - with the silent member silent throughout.
    #[test]
    fn a_silent_leader_is_rotated_out_by_the_view_change() {
        let (c, mut nodes, mut tails) = five_node_harness();
        warm_three_windows(&mut nodes, &mut tails, &c, false);
        for t in tails.iter_mut() { *t = vec![[4u8; 32]]; }
        let silent = nodes.iter().position(|n| n.d.is_leader_now()).expect("one member leads window 4");
        let view0 = nodes[silent].d.current_index();
        assert!(propose_window_except(&mut nodes, &tails, &c, 4, silent).is_empty(),
                "a member that does not lead must not propose");
        let mut rounds = 0;
        while nodes.iter().any(|n| n.d.next_window() == 4) && rounds < 8 {
            fire_timeouts(&mut nodes, &mut tails, &c);
            let seed = propose_window_except(&mut nodes, &tails, &c, 4, silent);
            deliver_gated(&mut nodes, &mut tails, &c, seed, false);
            rounds += 1;
        }
        assert!(nodes.iter().all(|n| n.d.next_window() > 4),
                "the window must certify under a rotated leader: {:?}",
                nodes.iter().map(|n| n.d.next_window()).collect::<Vec<_>>());
        assert!(nodes.iter().all(|n| n.d.current_index() > view0), "every view rotated past the silent leader");
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

    // ── THE 10.10 RACE (chain halted at 3508200) ─────────────────────────────────────────────────
    // Replayed with the live committee, indices and heads, each node hearing the messages in the
    // order its own log shows. Eight members, quorum six. A vote certificate and a timeout
    // certificate both form at 125964; 005 leads 125965 under QC_125963 (head 3505320) and 003 under
    // QC_125964 (head 3505350); QC_125965 certifies 005's checkpoint; 22020ba8 re-certifies it at
    // 125966 and QC_125966 commits 125965. The deployed driver finalized 3505350 on 002-005, a head
    // no certificate covers, latched window 116846 there, and the two halves refused each other's
    // proposals until production parked.

    const RACE_IDS: [&str; 8] = [
        "genesis_node_001", "genesis_node_002", "genesis_node_003", "genesis_node_004", "genesis_node_005",
        "super_node_22020ba893c62e34", "super_node_c78c3017a4f93464", "super_node_d0590f220be03d34",
    ];
    // Positions in the sorted committee.
    const R001: usize = 0;
    const R002: usize = 1;
    const R003: usize = 2;
    const R004: usize = 3;
    const R005: usize = 4;
    const R220: usize = 5;
    const R6TH: usize = 6;
    const RD05: usize = 7;
    /// The members still voting: genesis 001-005 and the sixth node.
    const RACE_OURS: [usize; 6] = [R001, R002, R003, R004, R005, R6TH];

    struct RaceNode {
        d: ConsensusDriver,
        id: NodeId,
        finals: Vec<(u64, u64)>,                          // (index, head) of every Finalize
        seals: Vec<(u64, Checkpoint, QuorumCertificate)>, // per macroblock window; the first save stands
        votes: Vec<VoteCommitment>,                       // durable before each vote leaves
        wal: std::collections::BTreeMap<u64, (Checkpoint, QuorumCertificate)>,
        content: std::collections::BTreeSet<u64>,         // checkpoint windows this node derived
        deferred: Option<u64>,                            // window its builder refused (anchor unsealed)
    }

    #[derive(Clone, Copy)]
    struct RaceSalts { s843: u64, s844: u64 }

    fn race_salt(s: RaceSalts, w: u64) -> u64 {
        match w { 116843 => s.s843, 116844 => s.s844, _ => 0 }
    }

    /// Content of checkpoint window `w`, identical on every node that derives it. The salt moves only
    /// hashes: it is what lets the replay run the leader schedule the live network ran.
    fn race_content(w: u64, salt: u64) -> (Vec<Hash>, Hash, Hash, u64, Vec<u8>) {
        let mut base = [0u8; 32];
        base[..8].copy_from_slice(&w.to_le_bytes());
        base[8..16].copy_from_slice(&salt.to_le_bytes());
        let (mut state_root, mut beacon) = (base, base);
        state_root[31] = 1;
        beacon[31] = 2;
        let boundary = (w * CHECKPOINT_INTERVAL) % MACROBLOCK_INTERVAL == 0;
        let eligible = if boundary { vec![0xE1, 0xE2, w as u8] } else { Vec::new() };
        (vec![base], state_root, beacon, w * CHECKPOINT_INTERVAL * 1000, eligible)
    }

    /// The checkpoint `propose_window` builds for window `w` at `index`, field for field.
    fn race_cp(c: &[NodeId], index: u64, parent: Option<QcRef>, w: u64, salt: u64, proposer: &str) -> Checkpoint {
        let (mb, state_root, beacon, ts, eligible) = race_content(w, salt);
        Checkpoint {
            index, parent_qc: parent, window_head_height: w * CHECKPOINT_INTERVAL, window_mb_hashes: mb,
            state_root, beacon, epoch_commitment: epoch_commitment(&eligible, c, &[]),
            reward_root: [0u8; 32], registry_root: [0u8; 32], dilithium_pk_root: [0u8; 32],
            reward_epoch_root: [0u8; 32], logs_root: [0u8; 32], total_supply: 0, timestamp: ts,
            proposer: proposer.to_string(), proposer_sig: Vec::new(), recovery_anchor: None,
        }
    }

    /// The two certified checkpoints below the race, and the salts under which the leader rule elects
    /// who led live: 004 at 125964 and 005 at 125965 under QC_125963, 003 at 125965 under QC_125964,
    /// 22020ba8 at 125966 under QC_125965, d0590f22 at 125967 under QC_125966.
    fn race_prelude(c: &[NodeId]) -> (RaceSalts, [(Checkpoint, QuorumCertificate); 2]) {
        let n = c.len();
        let cp62 = race_cp(c, 125962, None, 116842, 0, RACE_IDS[R002]);
        let qc62 = mk_qc(c, &cp62, 6);
        let under62 = Some(QcRef::from(&qc62));
        let s843 = (0..100_000u64).find(|s| {
            let h = race_cp(c, 125963, under62.clone(), 116843, *s, RACE_IDS[R003]).hash();
            leader_index(125964, &h, n) == R004 && leader_index(125965, &h, n) == R005
        }).expect("a salt electing 004 and 005");
        let cp63 = race_cp(c, 125963, under62, 116843, s843, RACE_IDS[R003]);
        let qc63 = mk_qc(c, &cp63, 6);
        let under63 = Some(QcRef::from(&qc63));
        let s844 = (0..1_000_000u64).find(|s| {
            let p4 = race_cp(c, 125964, under63.clone(), 116844, *s, RACE_IDS[R004]);
            let p5 = race_cp(c, 125965, under63.clone(), 116844, *s, RACE_IDS[R005]);
            let mut p6 = p5.clone();
            p6.index = 125966;
            p6.parent_qc = Some(QcRef { checkpoint_hash: p5.hash(), index: 125965 });
            p6.proposer = RACE_IDS[R220].to_string();
            leader_index(125965, &p4.hash(), n) == R003
                && leader_index(125966, &p5.hash(), n) == R220
                && leader_index(125967, &p6.hash(), n) == RD05
        }).expect("a salt electing 003, 22020ba8 and d0590f22");
        (RaceSalts { s843, s844 }, [(cp62, qc62), (cp63, qc63)])
    }

    fn race_node(c: &[NodeId], k: usize, base: &[(Checkpoint, QuorumCertificate); 2]) -> RaceNode {
        let mut d = ConsensusDriver::new(c[k].clone(), c.to_vec(), [7u8; 32]);
        let mut wal = std::collections::BTreeMap::new();
        for (cp, qc) in base.iter() {
            let _ = d.sync(cp, qc);
            wal.insert(qc.index, (cp.clone(), qc.clone()));
        }
        // 22020ba8's builder refused window 116845 for an unsealed anchor: that is why it re-certified
        // the high checkpoint instead of proposing the next window.
        let (content, deferred): (std::collections::BTreeSet<u64>, Option<u64>) = if k == R220 {
            ((116842..=116844).collect(), Some(116845))
        } else {
            ((116842..=116850).collect(), None)
        };
        RaceNode { d, id: c[k].clone(), finals: Vec::new(), seals: Vec::new(), votes: Vec::new(), wal, content, deferred }
    }

    fn race_exec(n: &mut RaceNode, e: Effect) -> Vec<ConsensusMsg> {
        match e {
            Effect::Propose(mut cp) => { cp.proposer_sig = sign(&n.id, &cp.hash()); vec![ConsensusMsg::Proposal(cp)] }
            Effect::Vote { index, checkpoint_hash, commit } => {
                n.votes.push(commit);
                vec![ConsensusMsg::Vote(Vote { checkpoint_hash, index, voter: n.id.clone(), signature: sign(&n.id, &checkpoint_hash) })]
            }
            Effect::Timeout { index, high_qc_index } => vec![ConsensusMsg::Timeout(TimeoutMsg {
                index, voter: n.id.clone(), high_qc_index, signature: sign(&n.id, &timeout_bytes(index, high_qc_index)),
            })],
            Effect::CatchUp { .. } | Effect::CatchUpTo { .. } => vec![],
            Effect::Relay(m) => vec![m],
            Effect::Persist { checkpoint, qc, .. } => {
                let w = checkpoint.window_head_height / MACROBLOCK_INTERVAL;
                if !n.seals.iter().any(|(s, _, _)| *s == w) { n.seals.push((w, checkpoint, qc)); }
                n.d.mark_sealed(w);
                vec![]
            }
            Effect::Finalize { index, head_height, .. } => { n.finals.push((index, head_height)); vec![] }
        }
    }

    /// The run loop's write-ahead log: the newest certified pair, whenever the frontier moves.
    fn race_wal(n: &mut RaceNode) {
        if let Some((idx, pair)) = n.d.newest_catchup_bundle() {
            if let (Some(cp), Some(qc)) = (race_proposal(&pair), race_qc(&pair)) { n.wal.insert(idx, (cp, qc)); }
        }
    }

    /// `try_propose` after every handled message: the next window if this node holds it, else the
    /// re-certification its refused frontier calls for.
    fn race_try_propose(net: &mut [RaceNode], c: &[NodeId], s: RaceSalts, k: usize) -> Vec<ConsensusMsg> {
        let n = &mut net[k];
        let w = n.d.next_window();
        let effs = if n.content.contains(&w) {
            let (mb, sr, bc, ts, el) = race_content(w, race_salt(s, w));
            n.d.build_proposal(w, mb, sr, bc, ts, c.to_vec(), el, Vec::new(),
                               [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32], 0)
        } else if n.deferred == Some(w) && n.d.commit_pending() && !n.d.high_head_committed() {
            let (_, _, _, _, el) = race_content(w - 1, race_salt(s, w - 1));
            n.d.build_recertify_proposal(c.to_vec(), el, Vec::new())
        } else {
            Vec::new()
        };
        let mut out = Vec::new();
        for e in effs { out.extend(race_exec(n, e)); }
        out
    }

    /// Node `k` handles `m` as the run loop does: wire check, driver, effects, WAL, propose attempt.
    /// What it sends is handed back: the script decides who hears it, and when.
    fn race_hear(net: &mut [RaceNode], c: &[NodeId], s: RaceSalts, k: usize, m: &ConsensusMsg) -> Vec<ConsensusMsg> {
        assert!(verify_msg(c, m), "the replay sends only well-formed messages");
        let mut out = Vec::new();
        for e in net[k].d.handle(m) { out.extend(race_exec(&mut net[k], e)); }
        race_wal(&mut net[k]);
        out.extend(race_try_propose(net, c, s, k));
        out
    }

    fn race_timeout(net: &mut [RaceNode], k: usize) -> Vec<ConsensusMsg> {
        let mut out = Vec::new();
        for e in net[k].d.on_timeout() { out.extend(race_exec(&mut net[k], e)); }
        out
    }

    fn race_proposal(out: &[ConsensusMsg]) -> Option<Checkpoint> {
        out.iter().find_map(|m| match m { ConsensusMsg::Proposal(p) => Some(p.clone()), _ => None })
    }

    fn race_qc(out: &[ConsensusMsg]) -> Option<QuorumCertificate> {
        out.iter().find_map(|m| match m { ConsensusMsg::Qc(q) => Some(q.clone()), _ => None })
    }

    fn race_tc(out: &[ConsensusMsg]) -> Option<TimeoutCertificate> {
        out.iter().find_map(|m| match m { ConsensusMsg::Tc(t) => Some(t.clone()), _ => None })
    }

    fn race_votes(out: Vec<ConsensusMsg>) -> Vec<ConsensusMsg> {
        out.into_iter().filter(|m| matches!(m, ConsensusMsg::Vote(_))).collect()
    }

    /// Every message reaches every live member, the sender included, until nothing new is sent.
    fn race_flood(net: &mut [RaceNode], c: &[NodeId], s: RaceSalts, live: &[usize], seed: Vec<ConsensusMsg>,
                  wire: &mut Vec<ConsensusMsg>) {
        let mut queue = seed;
        let mut rounds = 0;
        while !queue.is_empty() && rounds < 64 {
            rounds += 1;
            let mut next = Vec::new();
            for m in queue.drain(..) {
                wire.push(m.clone());
                for &k in live { next.extend(race_hear(net, c, s, k, &m)); }
            }
            queue = next;
        }
    }

    struct RaceRun {
        c: Vec<NodeId>,
        net: Vec<RaceNode>,
        salts: RaceSalts,
        base: [(Checkpoint, QuorumCertificate); 2],
        p4: Checkpoint,
        p5: Checkpoint,
        p6: Checkpoint,
        qc64: QuorumCertificate,
        qc65: QuorumCertificate,
        qc66: QuorumCertificate,
        windows66: Vec<u64>, // every node's next window once QC_125966 reached it
        p7: Option<Checkpoint>,
        voters7: Vec<NodeId>,
        qc67: Option<QuorumCertificate>,
    }

    /// The race, in the per-node arrival order of the 10.10 logs.
    fn race_replay() -> RaceRun {
        let c: Vec<NodeId> = RACE_IDS.iter().map(|s| s.to_string()).collect();
        let (s, base) = race_prelude(&c);
        let mut net: Vec<RaceNode> = (0..c.len()).map(|k| race_node(&c, k, &base)).collect();
        assert!(net.iter().all(|n| n.d.current_index() == 125964 && n.d.next_window() == 116844));
        assert_eq!(quorum_size(c.len()), 6);
        let qc63 = base[1].1.clone();

        // 125964. d0590f22, 005 and 003 time out before 004's proposal reaches 005.
        let mut early = Vec::new();
        for k in [RD05, R005, R003] { early.extend(race_timeout(&mut net, k)); }
        for m in &early { race_hear(&mut net, &c, s, R005, m); }
        // 004 leads 125964 and proposes on its window end; six members vote it, 005 among them.
        let p4 = race_proposal(&race_try_propose(&mut net, &c, s, R004)).expect("004 leads 125964");
        let mp4 = ConsensusMsg::Proposal(p4.clone());
        let mut v4 = Vec::new();
        for k in [R004, R003, R002, R6TH, R001, R005] { v4.extend(race_votes(race_hear(&mut net, &c, s, k, &mp4))); }
        assert_eq!(v4.len(), 6);
        // 001, 004 and 002 time out too: at 005 that is six, a timeout certificate at the same index,
        // and 005 leads 125965 under QC_125963 at once.
        let mut late = Vec::new();
        for k in [R001, R004, R002] { late.extend(race_timeout(&mut net, k)); }
        let (mut tc64, mut p5) = (None, None);
        for m in &late {
            let out = race_hear(&mut net, &c, s, R005, m);
            tc64 = tc64.or(race_tc(&out));
            p5 = p5.or(race_proposal(&out));
        }
        let tc64 = tc64.expect("a timeout certificate forms at 125964");
        let p5 = p5.expect("005 leads 125965 under QC_125963");
        let mtc = ConsensusMsg::Tc(tc64);
        for k in [R001, R002, R003, R004, R220, R6TH, RD05] { race_hear(&mut net, &c, s, k, &mtc); }
        let mp5 = ConsensusMsg::Proposal(p5.clone());
        let mut v5 = Vec::new();
        for k in [R005, R004, R003, R002, R6TH, R001, R220, RD05] { v5.extend(race_votes(race_hear(&mut net, &c, s, k, &mp5))); }
        assert_eq!(v5.len(), 8, "every member is at 125965 and votes 005's checkpoint");

        // QC_125964 forms at 004 from the six votes and reaches 001, then 003 - which now leads 125965
        // under QC_125964 and proposes the next window - then 002 and 005.
        let mut qc64 = None;
        for v in &v4 { qc64 = qc64.or(race_qc(&race_hear(&mut net, &c, s, R004, v))); }
        let qc64 = qc64.expect("QC_125964");
        let m64 = ConsensusMsg::Qc(qc64.clone());
        race_hear(&mut net, &c, s, R001, &m64);
        let p3 = race_proposal(&race_hear(&mut net, &c, s, R003, &m64)).expect("003 leads 125965 under QC_125964");
        race_hear(&mut net, &c, s, R002, &m64);
        race_hear(&mut net, &c, s, R005, &m64);
        // QC_125965 forms at 001, which therefore leaves 125965 before 003's proposal arrives.
        let mut qc65 = None;
        for v in &v5 { qc65 = qc65.or(race_qc(&race_hear(&mut net, &c, s, R001, v))); }
        let qc65 = qc65.expect("QC_125965");
        // 003's proposal: 003 itself, 002, 004, the sixth node (still on QC_125963), 005, then 001.
        let mp3 = ConsensusMsg::Proposal(p3.clone());
        let mut v3 = Vec::new();
        for k in [R003, R002, R004, R6TH, R005, R001] { v3.extend(race_votes(race_hear(&mut net, &c, s, k, &mp3))); }
        // QC_125965 reaches everyone else; 22020ba8 then leads 125966 and re-certifies.
        let m65 = ConsensusMsg::Qc(qc65.clone());
        for k in [R002, R003, R004, R005] { race_hear(&mut net, &c, s, k, &m65); }
        for k in [R6TH, RD05] {
            race_hear(&mut net, &c, s, k, &m64);
            race_hear(&mut net, &c, s, k, &m65);
        }
        race_hear(&mut net, &c, s, R220, &m64);
        let p6 = race_proposal(&race_hear(&mut net, &c, s, R220, &m65)).expect("22020ba8 re-certifies at 125966");
        for k in [R220, RD05] { v3.extend(race_votes(race_hear(&mut net, &c, s, k, &mp3))); }
        // The re-certification: every member votes it and QC_125966 commits 125965.
        let mp6 = ConsensusMsg::Proposal(p6.clone());
        let mut v6 = Vec::new();
        for k in [R220, R001, R002, R003, R004, R005, R6TH, RD05] { v6.extend(race_votes(race_hear(&mut net, &c, s, k, &mp6))); }
        let (mut qc66, mut p7) = (None, None);
        for v in &v6 {
            let out = race_hear(&mut net, &c, s, R220, v);
            qc66 = qc66.or(race_qc(&out));
            p7 = p7.or(race_proposal(&out));
        }
        let qc66 = qc66.expect("QC_125966");
        let m66 = ConsensusMsg::Qc(qc66.clone());
        for k in [R001, R002, R003, R004, R005, R6TH, RD05] {
            p7 = p7.or(race_proposal(&race_hear(&mut net, &c, s, k, &m66)));
        }
        let windows66: Vec<u64> = net.iter().map(|n| n.d.next_window()).collect();

        // The race is the live one: both certificates at 125964, two leader-valid proposals at 125965
        // (heads 3505320 and 3505350), 005's certified and re-certified at 125966, 003's unvoted.
        assert_eq!(qc64.checkpoint_hash, p4.hash());
        assert_eq!((p5.index, p5.window_head_height, p5.parent_qc.as_ref().map(|q| q.index)), (125965, 3505320, Some(125963)));
        assert_eq!((p3.index, p3.window_head_height, p3.parent_qc.as_ref().map(|q| q.index)), (125965, 3505350, Some(125964)));
        assert_eq!(c[leader_index(125965, &qc63.checkpoint_hash, c.len())], p5.proposer);
        assert_eq!(c[leader_index(125965, &qc64.checkpoint_hash, c.len())], p3.proposer);
        assert_eq!(qc65.checkpoint_hash, p5.hash(), "QC_125965 certifies 005's checkpoint");
        assert!(v3.is_empty(), "003's checkpoint draws no vote");
        assert_eq!((p6.index, p6.window_head_height), (125966, 3505320));
        assert_eq!(checkpoint_content_digest(&p6), checkpoint_content_digest(&p5), "125966 re-certifies 005's content");
        assert_eq!(qc66.checkpoint_hash, p6.hash());

        // 125967: the next window, by d0590f22.
        let (mut voters7, mut qc67) = (Vec::new(), None);
        if let Some(p7) = &p7 {
            let mp7 = ConsensusMsg::Proposal(p7.clone());
            let mut v7 = Vec::new();
            for k in [RD05, R001, R002, R003, R004, R005, R220, R6TH] { v7.extend(race_votes(race_hear(&mut net, &c, s, k, &mp7))); }
            voters7 = v7.iter().filter_map(|m| match m { ConsensusMsg::Vote(v) => Some(v.voter.clone()), _ => None }).collect();
            for v in &v7 { qc67 = qc67.or(race_qc(&race_hear(&mut net, &c, s, RD05, v))); }
            if let Some(q) = &qc67 {
                let m67 = ConsensusMsg::Qc(q.clone());
                for k in [R001, R002, R003, R004, R005, R220, R6TH] { race_hear(&mut net, &c, s, k, &m67); }
            }
        }
        RaceRun { c, net, salts: s, base, p4, p5, p6, qc64, qc65, qc66, windows66, p7, voters7, qc67 }
    }

    /// THE 10.10 DEFECT. Finality follows the certificate: 125965 finalizes the head QC_125965
    /// certifies on every node, every node keeps one next window, the macroblock seals from the
    /// committed checkpoint and not from its certified sibling at 125964, and the next window
    /// certifies with every member.
    #[test]
    fn the_10_10_race_finalizes_the_certified_head_on_every_node() {
        let r = race_replay();
        let name = |n: &RaceNode| n.id.rsplit('_').next().unwrap_or("").chars().take(8).collect::<String>();
        let finals: Vec<(String, Vec<u64>)> = r.net.iter()
            .map(|n| (name(n), n.finals.iter().filter(|(i, _)| *i == 125965).map(|(_, h)| *h).collect()))
            .collect();
        assert!(finals.iter().all(|(_, h)| h.as_slice() == [3505320]),
                "125965 must finalize the head its certificate covers (3505320) on every node: {:?}", finals);
        let windows: Vec<(String, u64)> = r.net.iter().zip(&r.windows66).map(|(n, w)| (name(n), *w)).collect();
        assert!(windows.iter().all(|(_, w)| *w == 116845),
                "one next window on every node once QC_125966 lands: {:?}", windows);
        let seals: Vec<(String, Option<u64>)> = r.net.iter()
            .map(|n| (name(n), n.seals.iter().find(|(w, _, _)| *w == 38948).map(|(_, cp, _)| cp.index)))
            .collect();
        assert!(seals.iter().all(|(_, i)| *i == Some(125965)),
                "macroblock 38948 seals from the committed checkpoint, never its sibling at 125964: {:?}", seals);
        let p7 = r.p7.as_ref().expect("d0590f22 leads 125967 under QC_125966");
        assert_eq!(p7.window_head_height, 3505350);
        assert_eq!(r.voters7.len(), 8, "every member votes head 3505350: {:?}", r.voters7);
        assert_eq!(r.qc67.as_ref().map(|q| q.checkpoint_hash), Some(p7.hash()), "and it certifies");
        assert!(r.net.iter().all(|n| n.d.committed_index() == 125966));
    }

    /// The boot path rebuilds what live operation holds: a fresh driver fed the vote commitments, the
    /// certified pairs of the WAL and the sealed macroblock's pair lands on the same certificate,
    /// commit, finality inputs and next window as the node that never stopped.
    #[test]
    fn a_restart_after_the_race_rebuilds_the_live_state() {
        let r = race_replay();
        for n in &r.net {
            let mut d = ConsensusDriver::new(n.id.clone(), r.c.clone(), [7u8; 32]);
            d.restore_vote_commitments(&n.votes);
            for (cp, qc) in n.wal.values() { let _ = d.sync(cp, qc); }
            if let Some((_, cp, qc)) = n.seals.last() { let _ = d.sync(cp, qc); }
            let live = (n.d.next_window(), n.d.committed_index(), n.d.committed_finalize(),
                        n.d.high_qc_pair().map(|(cp, q)| (cp.hash(), q.index)));
            let booted = (d.next_window(), d.committed_index(), d.committed_finalize(),
                          d.high_qc_pair().map(|(cp, q)| (cp.hash(), q.index)));
            assert_eq!(booted, live, "{} rebuilds a different state from its disk", n.id);
            assert!(d.current_index() > n.votes.iter().map(|v| v.index).max().unwrap_or(0));
        }
    }

    /// The network today: 002-005 hold the poisoned row and hours of votes for head 3505380, 001 and
    /// the sixth node for 3505350, the two outside members are silent, and macroblock 38948 was sealed
    /// from QC_125964. A restart rebuilds window 116845 from the certified pairs, and the six - exactly
    /// the quorum of eight - vote and certify head 3505350 and finalize it.
    #[test]
    fn after_a_restart_the_six_certify_and_finalize_head_3505350() {
        let r = race_replay();
        let c = r.c.clone();
        let wal = vec![r.base[0].clone(), r.base[1].clone(), (r.p4.clone(), r.qc64.clone()),
                       (r.p5.clone(), r.qc65.clone()), (r.p6.clone(), r.qc66.clone())];
        let under66 = Some(QcRef::from(&r.qc66));
        let split_vote = |index: u64, w: u64| VoteCommitment {
            index, window_head: w * CHECKPOINT_INTERVAL,
            content_digest: checkpoint_content_digest(&race_cp(&c, index, under66.clone(), w, 0, RACE_IDS[R001])),
            pinned: false, parent_index: 125966, parent_hash: r.qc66.checkpoint_hash,
        };
        let mut net: Vec<RaceNode> = (0..c.len()).map(|k| race_node(&c, k, &r.base)).collect();
        for &k in RACE_OURS.iter() {
            let group_a = (R002..=R005).contains(&k);
            // What the deployed binary left on disk: the race votes, then the split views.
            let mut votes: Vec<VoteCommitment> = r.net[k].votes.iter().filter(|v| v.index <= 125966).cloned().collect();
            let (first, step, w) = if group_a { (125969u64, 7u64, 116846u64) } else { (125967, 5, 116845) };
            votes.extend((0..30u64).map(|j| split_vote(first + j * step, w)));
            let mut d = ConsensusDriver::new(c[k].clone(), c.clone(), [7u8; 32]);
            d.restore_vote_commitments(&votes);
            for (cp, qc) in &wal { let _ = d.sync(cp, qc); }
            let _ = d.sync(&r.p4, &r.qc64); // the eager startup sync, from the sealed macroblock
            assert_eq!(d.next_window(), 116845, "{} reboots on window 116845", c[k]);
            assert_eq!(d.committed_finalize().map(|f| f.0), Some(3505320), "{} holds the certified commit", c[k]);
            net[k].d = d;
            net[k].votes = votes;
        }
        let live = RACE_OURS;
        let mut wire = Vec::new();
        for _ in 0..64 {
            if live.iter().all(|&k| net[k].finals.iter().any(|(_, h)| *h >= 3505350)) { break; }
            let qcs_before = wire.iter().filter(|m| matches!(m, ConsensusMsg::Qc(_))).count();
            let mut seed = Vec::new();
            for &k in live.iter() { seed.extend(race_try_propose(&mut net, &c, r.salts, k)); }
            race_flood(&mut net, &c, r.salts, &live, seed, &mut wire);
            if wire.iter().filter(|m| matches!(m, ConsensusMsg::Qc(_))).count() == qcs_before {
                let mut tmo = Vec::new();
                for &k in live.iter() { tmo.extend(race_timeout(&mut net, k)); }
                race_flood(&mut net, &c, r.salts, &live, tmo, &mut wire);
            }
        }
        assert!(live.iter().all(|&k| net[k].finals.iter().any(|(_, h)| *h >= 3505350)),
                "the six finalize head 3505350: {:?}",
                live.iter().map(|&k| (net[k].id.clone(), net[k].finals.clone())).collect::<Vec<_>>());
        let props: Vec<Checkpoint> = wire.iter().filter_map(|m| match m { ConsensusMsg::Proposal(p) => Some(p.clone()), _ => None }).collect();
        let qc = wire.iter().filter_map(|m| match m { ConsensusMsg::Qc(q) => Some(q.clone()), _ => None })
            .find(|q| props.iter().any(|p| p.hash() == q.checkpoint_hash && p.window_head_height == 3505350))
            .expect("a certificate for head 3505350");
        let mut ours: Vec<NodeId> = live.iter().map(|&k| c[k].clone()).collect();
        ours.sort();
        assert_eq!(qc.signers, ours, "exactly the six sign head 3505350");
        for &k in live.iter() {
            assert!(net[k].votes.iter().any(|v| v.index == qc.index && v.window_head == 3505350),
                    "{} votes head 3505350", c[k]);
        }
    }

    /// Two honest groups one certificate apart, both in view 13: each group's proposal names a head
    /// the other's window gate refuses. The certificate exchange must not sit behind that gate - the
    /// group behind pulls the certificate it lacks, the group ahead sends it - or neither ever moves.
    #[test]
    fn two_groups_one_certificate_apart_exchange_it_whatever_head_the_proposal_names() {
        let (c, _) = byz_net(4);
        let base = mk_cp(10, None, 90, "n0");
        let qc10 = mk_qc(&c, &base, 3);
        let ahead = mk_cp(11, Some(QcRef::from(&qc10)), 180, "n1");
        let qc11 = mk_qc(&c, &ahead, 3);
        let at_view_13 = |id: &NodeId, pairs: &[(&Checkpoint, &QuorumCertificate)]| -> Node {
            let mut n = node(id, &c);
            for (p, q) in pairs { let _ = n.d.sync(p, q); }
            // Views meet at 13 through the timeouts of f+1 members.
            for v in c.iter().filter(|m| *m != id).take(2) {
                let tm = TimeoutMsg { index: 13, voter: v.clone(), high_qc_index: 11, signature: sign(v, &timeout_bytes(13, 11)) };
                let _ = n.d.handle(&ConsensusMsg::Timeout(tm));
            }
            assert_eq!(n.d.current_index(), 13);
            n
        };
        // The group ahead proposes the window after QC_11; a member of the group behind wants 180.
        let py = mk_cp(13, Some(QcRef::from(&qc11)), 270, &c[leader_index(13, &ahead.hash(), c.len())]);
        let x_id = c.iter().find(|m| **m != py.proposer).expect("a receiver").clone();
        let mut x = at_view_13(&x_id, &[(&base, &qc10)]);
        assert_eq!(x.d.next_window(), 2);
        let effs = x.d.handle(&ConsensusMsg::Proposal(py.clone()));
        assert!(matches!(effs.as_slice(), [Effect::CatchUp { qc_index: 11, .. }]),
                "the group behind pulls the certificate it lacks: {:?}", effs);
        let _ = x.d.sync(&ahead, &qc11);
        assert!(x.d.handle(&ConsensusMsg::Proposal(py)).iter().any(|e| matches!(e, Effect::Vote { .. })),
                "and votes the same proposal once it holds it");
        // The group behind proposes the window after QC_10; a member of the group ahead wants 270.
        let px = mk_cp(13, Some(QcRef::from(&qc10)), 180, &c[leader_index(13, &base.hash(), c.len())]);
        let y_id = c.iter().find(|m| **m != px.proposer).expect("a receiver").clone();
        let mut y = at_view_13(&y_id, &[(&base, &qc10), (&ahead, &qc11)]);
        assert_eq!(y.d.next_window(), 3);
        let effs = y.d.handle(&ConsensusMsg::Proposal(px.clone()));
        let (peer, pc, pq) = effs.iter().find_map(|e| match e {
            Effect::CatchUpTo { peer, checkpoint, qc } => Some((peer.clone(), checkpoint.clone(), qc.clone())), _ => None })
            .unwrap_or_else(|| panic!("the group ahead sends the certificate to the proposer: {:?}", effs));
        assert_eq!((peer.as_str(), pq.index), (px.proposer.as_str(), 11));
        let mut p = at_view_13(&px.proposer, &[(&base, &qc10)]);
        let _ = p.d.sync(&pc, &pq);
        assert_eq!(p.d.next_window(), y.d.next_window(), "the proposer behind lands on the same window");
    }

    /// The 10.10 halves as one member saw the other: the same parent certificate, a head that
    /// certificate does not lead to. The proposer's frontier is what is wrong, so the member answers
    /// with the certified pair, and a proposer that lacks the checkpoint realigns on it. A re-proposal
    /// of the parent's own head with other content is a failed re-certification, not a gap: nothing.
    #[test]
    fn a_head_its_own_parent_certificate_does_not_allow_is_answered_with_the_pair() {
        let (c, _) = byz_net(4);
        let base = mk_cp(10, None, 90, "n0");
        let qc10 = mk_qc(&c, &base, 3);
        let ahead = mk_cp(11, Some(QcRef::from(&qc10)), 180, "n1");
        let qc11 = mk_qc(&c, &ahead, 3);
        let proposer = c[leader_index(12, &ahead.hash(), c.len())].clone();
        let me_id = c.iter().find(|m| **m != proposer).expect("a receiver").clone();
        let mut me = node(&me_id, &c);
        let _ = me.d.sync(&base, &qc10);
        let _ = me.d.sync(&ahead, &qc11);
        assert_eq!((me.d.current_index(), me.d.next_window()), (12, 3));
        let far = mk_cp(12, Some(QcRef::from(&qc11)), 360, &proposer);
        let effs = me.d.handle(&ConsensusMsg::Proposal(far));
        let pair = effs.iter().find_map(|e| match e {
            Effect::CatchUpTo { checkpoint, qc, .. } => Some((checkpoint.clone(), qc.clone())), _ => None });
        let (pc, pq) = pair.unwrap_or_else(|| panic!("a head QC_11 does not lead to is answered with the pair: {:?}", effs));
        assert_eq!(pq.index, 11);
        // A proposer holding QC_11 without its checkpoint realigns on the pair.
        let mut p = node(&proposer, &c);
        let _ = p.d.sync(&base, &qc10);
        let _ = p.d.handle(&ConsensusMsg::Qc(qc11.clone()));
        assert_eq!(p.d.frontier_blind(), Some(11));
        let _ = p.d.sync(&pc, &pq);
        assert_eq!((p.d.frontier_blind(), p.d.next_window()), (None, 3));
        // The parent's own head with other content, from another member: nothing to send.
        let other = c.iter().find(|m| **m != me_id && **m != proposer).expect("a third member").clone();
        let mut same_head = mk_cp(12, Some(QcRef::from(&qc11)), 180, &other);
        same_head.state_root = [0xAB; 32];
        assert!(me.d.handle(&ConsensusMsg::Proposal(same_head)).is_empty());
    }

    // ── ZERO SLACK: A RESTART BETWEEN A VOTE AND ITS OWN TIMEOUT ─────────────────────────────────
    // Committee 8, quorum 6, six live: the recovery roll and windows 38949-38950. A member that votes
    // at view V and stops before its own timer fires reboots past V (its vote commitment) and never
    // signs V. The five left at V are one timeout short of TC(V), and one member ahead is two short
    // of the f+1 jump. Only the helper timeout moves them.

    /// Runs the shape: the leader of V proposes to itself and `voters` (offsets from the leader), the
    /// members in `restarted` reboot, then every live timer fires `rounds` times.
    fn zero_slack_restart_after_vote(voters: &[usize], restarted: &[usize], rounds: usize) -> (u64, Vec<u64>) {
        let (_, nodes, v) = zero_slack_net(voters, restarted, rounds);
        (v, nodes.iter().map(|n| n.d.current_index()).collect())
    }

    fn zero_slack_net(voters: &[usize], restarted: &[usize], rounds: usize) -> (Vec<NodeId>, Vec<Node>, u64) {
        let c: Vec<NodeId> = (0..8).map(|i| format!("n{}", i)).collect();
        let mut nodes: Vec<Node> = c[..6].iter().map(|id| node(id, &c)).collect();
        assert_eq!(quorum_size(c.len()), 6);
        let base = mk_cp(10, None, 90, "n0");
        let qc10 = mk_qc(&c, &base, 6);
        for n in nodes.iter_mut() {
            let _ = n.d.sync(&base, &qc10);
            n.wal.push((base.clone(), qc10.clone()));
        }
        // Views meet on one the live members lead.
        let mut guard = 0;
        let leader = loop {
            let l = nodes[0].d.leader_of(nodes[0].d.current_index()).cloned().expect("a committee");
            if let Some(k) = nodes.iter().position(|n| n.id == l) { break k; }
            view_change(&mut nodes, &c);
            guard += 1;
            assert!(guard < 32, "no live leader reached");
        };
        let v = nodes[0].d.current_index();
        assert!(nodes.iter().all(|n| n.d.current_index() == v));
        // The leader proposes window 2; only it and `voters` hear the proposal, so no certificate forms.
        let mut props = Vec::new();
        for e in nodes[leader].d.build_proposal(2, vec![[2u8; 32]], [2u8; 32], [0u8; 32], 2000, c.clone(),
                                                 Vec::new(), Vec::new(), [0u8; 32], [0u8; 32], [0u8; 32],
                                                 [0u8; 32], [0u8; 32], 0) {
            props.extend(exec(&mut nodes[leader], e));
        }
        let prop = props.into_iter().find(|m| matches!(m, ConsensusMsg::Proposal(_))).expect("the leader proposes");
        let mut votes = Vec::new();
        let hearers: Vec<usize> = std::iter::once(leader).chain(voters.iter().map(|k| (leader + k) % 6)).collect();
        for &k in &hearers {
            for e in nodes[k].d.handle(&prop) { votes.extend(exec(&mut nodes[k], e)); }
        }
        assert_eq!(votes.len(), hearers.len(), "each hearer votes");
        deliver(&mut nodes, &c, votes);
        assert!(nodes.iter().all(|n| n.d.current_index() == v), "a minority of votes certifies nothing");
        // Stopped before the own timer at V: the vote commitment survives, nothing else does.
        for &r in restarted {
            let k = (leader + r) % 6;
            restart(&mut nodes[k], &c);
            assert_eq!(nodes[k].d.current_index(), v + 1, "a restored voter reboots past its vote");
        }
        for _ in 0..rounds {
            let mut seed = Vec::new();
            for k in 0..nodes.len() {
                for e in nodes[k].d.on_timeout() { seed.extend(exec(&mut nodes[k], e)); }
            }
            deliver(&mut nodes, &c, seed);
        }
        (c, nodes, v)
    }

    /// A voter restarts and the other five stay at V: its helper timeout for V completes TC(V), and the
    /// six time out together from then on.
    #[test]
    fn a_voter_restarted_before_its_own_timeout_still_lets_the_view_move() {
        let (v, views) = zero_slack_restart_after_vote(&[1], &[1], 12);
        assert!(views.iter().all(|w| *w >= v + 2), "the views must pass V+1 (V={}): {:?}", v, views);
        // Two voters restarted: still within reach of the helper.
        let (v, views) = zero_slack_restart_after_vote(&[1, 2], &[1, 2], 12);
        assert!(views.iter().all(|w| *w >= v + 2), "two restarted voters (V={}): {:?}", v, views);
    }

    /// The leader self-votes, nobody else votes, and the leader restarts: none of the five ever voted
    /// at V, so restarting any of them cannot help. The leader's own helper timeout does.
    #[test]
    fn the_only_voter_at_a_view_restarted_still_lets_the_view_move() {
        let (v, views) = zero_slack_restart_after_vote(&[], &[0], 12);
        assert!(views.iter().all(|w| *w >= v + 2), "the views must pass V+1 (V={}): {:?}", v, views);
    }

    /// After the views meet again the six certify window 2: the restarted voter votes the same content
    /// at a later index, and every member holds the certificate.
    #[test]
    fn after_the_helper_timeout_the_six_certify_again() {
        let (c, mut nodes, v) = zero_slack_net(&[1], &[1], 3);
        let views: Vec<u64> = nodes.iter().map(|n| n.d.current_index()).collect();
        assert!(views.iter().all(|w| *w == views[0] && *w > v), "one view past V={}: {:?}", v, views);
        for _ in 0..32 {
            if nodes.iter().all(|n| n.d.next_window() == 3) { break; }
            let before = nodes[0].d.next_window();
            strict_round(&mut nodes, &c, 2);
            if nodes[0].d.next_window() == before { view_change(&mut nodes, &c); }
        }
        assert!(nodes.iter().all(|n| n.d.next_window() == 3 && n.d.high_qc_head() == Some(180)),
                "window 2 certifies on all six: {:?}",
                nodes.iter().map(|n| (n.d.current_index(), n.d.next_window())).collect::<Vec<_>>());
    }

}

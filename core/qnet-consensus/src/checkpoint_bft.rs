// Checkpoint-BFT types (spec: docs/CONSENSUS_V2_SPEC.md).
// One consensus object — the Checkpoint — commits a window of K leader-streamed
// microblocks via an n−f-signer QC. Dilithium sigs are non-aggregatable, so a QC keeps
// a signer set + Merkle root for compact light-client verification.

use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};
use std::collections::HashSet;

pub type NodeId = String;
pub type Hash = [u8; 32];

/// BFT quorum = n−f, f = floor((n-1)/3). 0 for empty set. n−f (not 2f+1) is the
/// safe threshold when n>3f+1: any two quorums then share ≥f+1 nodes ⇒ ≥1 honest ⇒
/// no two conflicting QCs. (n−f == 2f+1 exactly when n=3f+1.) E.g. n=5⇒4, n=100⇒67.
pub fn quorum_size(committee_len: usize) -> usize {
    if committee_len == 0 { return 0; }
    let f = (committee_len - 1) / 3;
    committee_len - f
}

/// Smallest committee for which the relaxation exists. Below it `relaxed_quorum` returns
/// `quorum_size` unchanged, so it is inert at the 5-node genesis by construction: 3-of-5 would buy
/// one node of liveness and let a single Byzantine member break safety.
pub const RELAXED_MIN_COMMITTEE: usize = 10;

/// Span length in windows = 2 macroblocks. `committee_for_height` reads macroblock w-2, so A+1/A+2
/// resolve off sealed A-1/A, while A+3 resolves off A+1 whose eligible set the inactivity shrink has
/// already cut to the live nodes — strict quorum is reachable again from there.
pub const RC_SPAN_INDICES: u64 = 6;

/// Compile-time guard: the span must be a whole number of macroblocks, or its last step would land
/// mid-window and the span could never hand the chain back on a sealed boundary.
const _: () = assert!((RC_SPAN_INDICES * CHECKPOINT_INTERVAL) % MACROBLOCK_INTERVAL == 0,
                      "the recovery span must cover whole macroblocks");

/// Recovery pin: `(anchor_macroblock_index, anchor_checkpoint_content_digest)`.
///
/// The second element is `checkpoint_content_digest(cp_anchor)`, NOT `MacroBlock::hash()`: the block
/// hash omits `consensus_data`, so the window head and epoch data the resolver reads out of the
/// anchor would be un-covered wire-chosen data. The content digest covers exactly those, is identical
/// across a legal re-proposal, and — because it excludes the anchor's OWN pin — is also identical
/// across a pinned and an unpinned certificate for one window. Only fields inside it may decide
/// validity; anything else a certificate carries differs between conformant variants of one
/// macroblock and would make one verdict a function of which variant a node happens to store.
pub type RecoveryAnchor = (u64, Hash);

/// Threshold under an ACTIVE recovery pin, over the SAME committee a strict certificate for that head
/// would use — the pin lowers the bar, never the signing set, so the two quorums provably intersect.
/// Floored to `quorum_size` below RELAXED_MIN_COMMITTEE. `n/2+1` keeps `2*relaxed_quorum(n) > n`, so
/// two relaxed quorums intersect too — the property that makes a conflicting pair attributable.
pub fn relaxed_quorum(committee_len: usize) -> usize {
    if committee_len < RELAXED_MIN_COMMITTEE { return quorum_size(committee_len); }
    committee_len / 2 + 1
}

/// THE single effective-threshold fn. Every consensus quorum decision routes through this, so no
/// subsystem can silently keep the old threshold while another relaxes — which would be strictly
/// worse than the halt it is trying to end.
pub fn effective_quorum(committee_len: usize, relaxed: bool) -> usize {
    if relaxed { relaxed_quorum(committee_len) } else { quorum_size(committee_len) }
}

/// The ONLY `window_head_height` a relaxed checkpoint may occupy at step `k` in `1..=RC_SPAN_INDICES`.
///
/// Pins the WINDOW, never the index: a view change advances the round without certifying a window, so
/// index/window lockstep is unsatisfiable after one dead leader. Attributability comes from the proof
/// instead — same window head + DIFFERENT committed content, at least one pinned = a double vote at
/// any index (`pinned_double_vote`).
pub fn recovery_window_head(anchor_cp_head: u64, k: u64) -> u64 {
    anchor_cp_head + k * CHECKPOINT_INTERVAL
}

/// Step `k` implied by a relaxed checkpoint's window head, or None if it is not on the span's grid.
pub fn recovery_step_for_head(anchor_cp_head: u64, head: u64) -> Option<u64> {
    let delta = head.checked_sub(anchor_cp_head)?;
    if delta == 0 || delta % CHECKPOINT_INTERVAL != 0 { return None; }
    let k = delta / CHECKPOINT_INTERVAL;
    if k > RC_SPAN_INDICES { return None; }
    Some(k)
}

/// The span's windows in the FAILOVER key space. That key is `(h-1)/MACROBLOCK_INTERVAL + 1`, so
/// window `w` covers heights `(w-1)*90+1 ..= w*90` and the span's heights `(A*90, A*90+180]` are
/// exactly windows `A+1` and `A+2` — the anchor's own window `A` is already sealed and must stay on
/// the strict threshold.
pub fn recovery_failover_windows(anchor_mb: u64) -> (u64, u64) {
    (anchor_mb + 1,
     anchor_mb + RC_SPAN_INDICES * CHECKPOINT_INTERVAL / MACROBLOCK_INTERVAL)
}

/// Digest of everything a checkpoint COMMITS — the window content and the epoch data — with the
/// consensus-position fields (index, parent link, proposer) AND the recovery pin deliberately
/// excluded.
///
/// Two checkpoints agreeing here seal a byte-identical macroblock (`MacroBlock::hash` omits
/// consensus_data), so signing both is CONFORMANT: a view change legally re-proposes one window at a
/// new index, and the recovery pin re-proposes one window with the threshold changed. A rule keyed on
/// `hash()` — which folds both — would convict every replica that follows the protocol, and would
/// make the pinned re-proposal of a stuck window unvotable for everyone who already voted there.
/// Two checkpoints that DISAGREE here are the real conflict — two different macroblocks at one
/// position.
pub fn checkpoint_content_digest(cp: &Checkpoint) -> Hash {
    let mut h = Sha3_256::new();
    h.update(b"qnet-checkpoint-content-v2");
    h.update(cp.window_head_height.to_le_bytes());
    h.update((cp.window_mb_hashes.len() as u64).to_le_bytes());
    for mh in &cp.window_mb_hashes { h.update(mh); }
    h.update(cp.state_root);
    h.update(cp.beacon);
    h.update(cp.epoch_commitment);
    h.update(cp.reward_root);
    h.update(cp.registry_root);
    h.update(cp.logs_root);
    h.update(cp.dilithium_pk_root);
    h.update(cp.reward_epoch_root);
    h.update(cp.total_supply.to_le_bytes());
    h.update(cp.timestamp.to_le_bytes());
    h.finalize().into()
}

/// Attributable SAME-ROUND double vote: two checkpoints at one index committing DIFFERENT content.
///
/// Keyed on the content digest, never `hash()`. A pin frees the index (`CheckpointConsensus`
/// deliberately lets one replica vote twice at the stuck round — once unpinned, once pinned — over
/// the identical position), and those two votes carry different hashes, so a hash-keyed same-round
/// rule would convict every replica that follows the protocol.
pub fn same_round_double_vote(a: &Checkpoint, b: &Checkpoint) -> bool {
    a.index == b.index && checkpoint_content_digest(a) != checkpoint_content_digest(b)
}

/// Attributable PINNED double vote: same window head, DIFFERENT committed content, at least one of
/// the two carrying a pin. This is the accountability arm the freed index needs — any two quorums
/// over one head intersect (both are taken over the same derived committee), and the shared signer is
/// convictable here even though its votes sit at different rounds, which same-round equivocation
/// cannot see. Exactly the pair `CheckpointConsensus::on_proposal` refuses to create, so an honest
/// replica never emits it; a re-proposal at a new index is not one (same content), and an
/// unpinned/unpinned pair stays the same-round rule's business (a rollback may legally re-vote an
/// uncertified window).
pub fn pinned_double_vote(a: &Checkpoint, b: &Checkpoint) -> bool {
    (a.recovery_anchor.is_some() || b.recovery_anchor.is_some())
        && a.window_head_height == b.window_head_height
        && checkpoint_content_digest(a) != checkpoint_content_digest(b)
}

/// Fold the recovery pin into a checkpoint hash. Tagged present/absent so `None` and
/// `Some((0,[0;32]))` can never collide. Mirrored byte-for-byte in the mobile light client.
fn fold_recovery_anchor(h: &mut Sha3_256, ra: &Option<RecoveryAnchor>) {
    match ra {
        None => { h.update([0u8]); }
        Some((mb, hash)) => { h.update([1u8]); h.update(mb.to_le_bytes()); h.update(hash); }
    }
}

/// Deterministic leader for checkpoint `index`, seeded ONLY by the committed
/// parent hash — one agreed input ⇒ identical leader on every honest node.
pub fn leader_index(index: u64, parent_checkpoint_hash: &Hash, committee_len: usize) -> usize {
    if committee_len == 0 { return 0; }
    let mut h = Sha3_256::new();
    h.update(b"qnet-leader-v2");
    h.update(index.to_le_bytes());
    h.update(parent_checkpoint_hash);
    let d = h.finalize();
    let mut x = [0u8; 8];
    x.copy_from_slice(&d[..8]);
    (u64::from_le_bytes(x) % committee_len as u64) as usize
}

/// Canonical committee parameters: the round committee is the VRF-capped eligible set (≤ this size =
/// the round cap MAX_VALIDATORS). Both macro-finality and micro-failover vote over the SAME set. Size
/// sets safety — equivocation needs ≥f+1≈C/3 sampled Byzantine, bounded P ≤ exp(−C·D(1/3‖β)); at β=0.20
/// a 1e-9 bound needs C≈426, so C=1000 ⇒ ≈7e-22/epoch. THRESHOLD==SIZE ⇒ subsample only above the cap.
pub const COMMITTEE_THRESHOLD: usize = 1000;
pub const COMMITTEE_SIZE: usize = 1000;

/// Macroblock / epoch cadence: one macroblock (epoch transition, emission, committee
/// rotation, N-2 snapshot) every MACROBLOCK_INTERVAL microblocks. A true network constant.
pub const MACROBLOCK_INTERVAL: u64 = 90;

/// Finality-checkpoint cadence: an n−f-signer QC finalizes microblocks every CHECKPOINT_INTERVAL
/// blocks. MUST divide MACROBLOCK_INTERVAL (every macroblock boundary is also a checkpoint).
/// CONSENSUS PARAMETER — every node MUST use the same value, or the checkpoint chains diverge
/// (fork). Changing it = rebuild + relaunch the whole network from genesis. 30 (default) =
/// intra-window finality (~30-60s to irreversibility); 90 = legacy one-checkpoint-per-macroblock
/// (~90-180s). Valid values divide 90: {10,15,18,30,45,90}.
pub const CHECKPOINT_INTERVAL: u64 = 30;

/// Compile-time guard: CHECKPOINT_INTERVAL must divide MACROBLOCK_INTERVAL, else a macroblock
/// boundary would not coincide with a checkpoint and the seal cadence would be undefined.
const _: () = assert!(MACROBLOCK_INTERVAL % CHECKPOINT_INTERVAL == 0, "CHECKPOINT_INTERVAL must divide MACROBLOCK_INTERVAL");

/// How many checkpoint indices BELOW THE VIEW BEING DRIVEN the driver + engine retain before evicting
/// per-index consensus state (proposals/votes/qcs/heads/seal_data). Bounds the always-on consensus
/// task's memory to O(RETAIN·committee) instead of O(chain length) — and anchoring it to the view
/// rather than to the commit is what keeps that true during a content-divergence halt, where the
/// commit is frozen while the view keeps advancing. The 2-chain commit rule looks back ≤2 indices, and
/// anything pruned that a lagging node still needs is reconstructed from §4.5 macroblock sync — never
/// a wedge. 128 ≈ ~1 h of checkpoints at the 30-block cadence, ample slack for reordering/partitions.
pub const CONSENSUS_STATE_RETAIN: u64 = 128;

/// Views of TIMEOUT messages retained, far shorter than the state window above. A TimeoutCertificate
/// forms on the quorum-crossing insert and only ever moves the view FORWARD, and the f+1 jump reads
/// indices ABOVE the current view — so a timeout at an index the view has already left can neither
/// form a useful certificate nor advance anything. This is the one map a divergence halt refills with
/// a full committee of ML-DSA signatures every single view, so it is the one that must stay small.
pub const TIMEOUT_STATE_RETAIN: u64 = 8;

/// Checkpoint-BFT view (round) timeout in ms: how long a replica waits for the leader's proposal
/// before broadcasting a TimeoutVote toward a view change. CONSENSUS PACING — must be network-uniform;
/// per-node values desync view-change timing and churn liveness (it is NOT a per-operator knob).
pub const VIEW_TIMEOUT_MS: u64 = 4000;

/// The next INTRA-window checkpoint boundary strictly after `from`, at or below `tip`, with the
/// cursor stepped OVER any macroblock boundaries crossed. A multiple of `macro_i` is emitted by the
/// macroblock-boundary path, NOT the intra path — but the cursor MUST step past it, or it stalls on
/// the first one and no later intra checkpoint is ever signalled ⇒ the next window never reaches the
/// driver ⇒ chain freeze. Returns `(next_intra, cursor)`: `next_intra` is the boundary to signal once
/// its sub-window content is ready (None if none ≤ tip); `cursor` is the new value recording the
/// boundaries stepped over (store unconditionally). At `k == macro_i` every boundary is a macroblock
/// boundary ⇒ always None (intra path dormant). Pure & deterministic; terminates (`b` strictly rises).
pub fn next_intra_checkpoint_boundary(from: u64, tip: u64, k: u64, macro_i: u64) -> (Option<u64>, u64) {
    if k == 0 || macro_i == 0 { return (None, from); }
    let mut cursor = from;
    loop {
        let b = (cursor / k + 1) * k;                 // next K-boundary strictly above the cursor
        if b == 0 || b > tip { return (None, cursor); }
        if b % macro_i == 0 { cursor = b; continue; } // boundary path emits it; step over, don't stall
        return (Some(b), cursor);
    }
}

/// Deterministic VRF committee subsample. `sorted_candidates` MUST be sorted by node_id by the
/// caller, so the index→candidate mapping is identical on every node; `window` is the macroblock
/// index the committee serves; `seed` is that window's N-2 randomness beacon. ≤ `threshold` ⇒ the
/// whole set is the committee (no subsample). Pure & deterministic.
///
/// THE single committee-selection function: BOTH the macroblock checkpoint sealer AND the
/// microblock-failover voting set call this with the same inputs, so the two consensus layers
/// can NEVER disagree on committee membership (a divergent re-implementation would fork the
/// chain — which is exactly why this is one shared function, not two copies).
pub fn sample_committee(
    sorted_candidates: &[NodeId],
    window: u64,
    seed: &Hash,
    threshold: usize,
    size: usize,
) -> Vec<NodeId> {
    if sorted_candidates.len() <= threshold {
        return sorted_candidates.to_vec();
    }
    let mut scored: Vec<(usize, Hash)> = sorted_candidates
        .iter()
        .enumerate()
        .map(|(i, _)| {
            let mut h = Sha3_256::new();
            h.update(b"COMMITTEE_VRF_v3.36");
            h.update(&seed[..]);
            h.update(window.to_le_bytes());
            h.update((i as u64).to_le_bytes());
            let hash: Hash = h.finalize().into();
            (i, hash)
        })
        .collect();
    scored.sort_by(|a, b| a.1.cmp(&b.1));
    scored.truncate(size);
    scored.sort_by_key(|&(idx, _)| idx);
    scored.iter().map(|(idx, _)| sorted_candidates[*idx].clone()).collect()
}

/// Window randomness: XOR-fold of the window's committed block hashes, then domain-hash.
/// Order-independent ⇒ identical on every node regardless of collection order.
///
/// It folded per-block `vrf_output` — sk-bound, so no verifier could recompute it and a producer
/// chose it freely and UNDETECTABLY. Block hashes are QC-signed inside `Checkpoint.window_mb_hashes`,
/// so the beacon is now a pure function of already-certified data (I6) and any bias is verifiable.
///
/// NOT unbiasable: the window's last producer sees the other contributions first and can grind its
/// own block hash cheaply (permuting its transaction order changes merkle_root at no cost, and fees
/// it pays itself round-trip). Bias is bounded by hashes-per-slot and is a strict improvement on the
/// previous free-and-invisible grinding, but nothing downstream may assume this beacon is expensive
/// to bias — that needs commit-reveal or a VDF, not a fold.
pub fn accumulate_beacon(block_hashes: &[Hash]) -> Hash {
    let mut acc = [0u8; 32];
    for o in block_hashes {
        for i in 0..32 { acc[i] ^= o[i]; }
    }
    let mut h = Sha3_256::new();
    h.update(b"qnet-beacon-v2");
    h.update(acc);
    h.finalize().into()
}

/// Commitment over a checkpoint's epoch-transition data: the next-epoch eligible-producer
/// snapshot (opaque bytes), the committee (order-independent), and the cumulative ban set
/// (order-independent). Bound into the checkpoint hash ⇒ the QC certifies the validator set
/// AND the bans; syncing nodes verify the macroblock's published set/banned_validators against
/// it instead of re-running the full epoch scan, so a relayer cannot corrupt the stored ban
/// set without breaking the QC. A domain tag + length prefix separate committee from bans, so
/// no element can migrate across the boundary and preserve the byte stream (canonical).
pub fn epoch_commitment(eligible_producers: &[u8], committee: &[NodeId], banned: &[NodeId]) -> Hash {
    let mut cs: Vec<&NodeId> = committee.iter().collect();
    cs.sort();
    let mut bs: Vec<&NodeId> = banned.iter().collect();
    bs.sort();
    let mut h = Sha3_256::new();
    h.update(b"qnet-epoch-v2");
    h.update((eligible_producers.len() as u64).to_le_bytes());
    h.update(eligible_producers);
    for c in cs { h.update(c.as_bytes()); h.update([0u8]); }
    h.update(b"banned");
    h.update((bs.len() as u64).to_le_bytes());
    for b in bs { h.update(b.as_bytes()); h.update([0u8]); }
    h.finalize().into()
}

/// A committee member's vote on a checkpoint hash (Dilithium sig over the hash).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Vote {
    pub checkpoint_hash: Hash,
    pub index: u64,
    pub voter: NodeId,
    pub signature: Vec<u8>,
}

/// A quorum (n−f) of distinct committee votes over one checkpoint.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QuorumCertificate {
    pub checkpoint_hash: Hash,
    pub index: u64,
    pub signers: Vec<NodeId>,
    pub sig_merkle_root: Hash,
    pub sigs: Vec<Vec<u8>>, // aligned with `signers`
}

/// The parent link a checkpoint carries: the identity of the QC it extends, and nothing else.
///
/// A checkpoint used to embed the whole parent `QuorumCertificate`, but nothing ever read its
/// signatures — every consumer takes only `checkpoint_hash` (the parent link) or `index` (the lock and
/// 2-chain rules), and a parent QC arriving inside a proposal was never verified, because QCs are
/// adopted from their own `ConsensusMsg::Qc`. At COMMITTEE_SIZE=1000 those unread signatures were
/// ~3.05 MB of the ~3.08 MB proposal, re-sent to every peer every round, and the same bytes were
/// duplicated twice more inside every `VoteEquivocationProof` preimage. A distinct type — rather than
/// stripping the fields at send time — makes shipping them again impossible rather than merely unwise.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QcRef {
    pub checkpoint_hash: Hash,
    pub index: u64,
}

impl From<&QuorumCertificate> for QcRef {
    fn from(qc: &QuorumCertificate) -> Self {
        Self { checkpoint_hash: qc.checkpoint_hash, index: qc.index }
    }
}

/// One replica's timeout for view `index`, carrying its highest-QC index.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TimeoutMsg {
    pub index: u64,
    pub voter: NodeId,
    pub high_qc_index: u64, // 0 = none
    pub signature: Vec<u8>,
}

/// n−f timeouts ⇒ advance the checkpoint view; carries the highest QC seen.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TimeoutCertificate {
    pub index: u64,
    pub timeouts: Vec<TimeoutMsg>,
    pub high_qc: Option<QuorumCertificate>,
}

/// The consensus object: commits `window_mb_hashes` (K microblocks) at finality.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Checkpoint {
    pub index: u64,
    /// Identity of the QC this checkpoint extends. See `QcRef` for why it is not the QC itself.
    pub parent_qc: Option<QcRef>,
    pub window_head_height: u64,
    pub window_mb_hashes: Vec<Hash>,
    pub state_root: Hash,
    pub beacon: Hash,
    /// Commitment to the epoch-transition data this checkpoint publishes (next-epoch
    /// eligible producers + committee). In the QC-signed hash ⇒ the quorum certifies the
    /// validator set, so syncing (non-committee) nodes trust it without re-deriving.
    pub epoch_commitment: Hash,
    /// Per-epoch reward merkle root for the emission-boundary window ([0;32] otherwise);
    /// QC-signed ⇒ the quorum certifies it ⇒ nodes adopt this root for claims, never a single
    /// producer's unverified value (no Byzantine/lag reward divergence).
    pub reward_root: Hash,
    /// Deterministic digest of the chain-confirmed Super/genesis registry identity
    /// (node_id, wallet, reg_height, burn, sha3(vrf_pk)) as of the window head. QC-signed ⇒ the quorum
    /// certifies the registry, so a node joining via an UNTRUSTED snapshot verifies the restored
    /// node_registry — the source of cbw and attestor VRF keys — against this committed root,
    /// closing the forgeable-snapshot Sybil/fork vector.
    pub registry_root: Hash,
    /// QC-signed merkle root over this window's committed event logs — native QRC-20/721 transfers +
    /// WASM emit_log. ACTIVE from genesis (`logs_root_required` gate=0): the producer feeds
    /// logs_merkle_root(window logs), content_ok's WindowContent recomputes it BYTE-IDENTICALLY, and
    /// the quorum certifies it exactly like reward_root — giving trustless light-client event proofs. CONSENSUS-
    /// CRITICAL: block_logs must be byte-identical across the validator + producer drain paths, else
    /// this root diverges and the macroblock QC never reaches quorum. [0;32] only for a log-less window.
    pub logs_root: Hash,
    /// FIX-5: QC-signed LtHash digest over all committed (address -> ML-DSA-65 pk) bindings.
    /// The quorum certifies it ⇒ a node joining via an UNTRUSTED snapshot verifies its restored per-account
    /// pubkeys match the committed set — a malicious snapshot that omits/alters an account's pk fails
    /// this root (→ snapshot rejected) instead of stalling that account's pk-elided TXs at 100k cold-
    /// join. [0;32] until the first pk is bound (all accounts still ship pk).
    pub dilithium_pk_root: Hash,
    /// LtHash over every (epoch, certified reward root) this node holds. Lets a snapshot-joined node
    /// carry the roots it can never re-derive (their macroblocks sit below its weak-subjectivity
    /// floor) and prove them against the n−f quorum instead of trusting the snapshot server.
    pub reward_epoch_root: Hash,
    /// QC-signed total minted supply as of window_head_height. The apply-accumulated
    /// emission total (genesis=0, monotonic +emit_rewards). QC-signed ⇒ the quorum certifies it ⇒
    /// a cold-joiner reads this QC-bound value instead of summing restored balances (which
    /// diverges at epoch≥2 once rewards are minted-then-claimed-later). total_supply is
    /// consensus-critical (emission cap) but not in state_root (account-only), so it is
    /// bound separately here.
    pub total_supply: u64,
    /// Proposer's wall-clock for this window (the head microblock's timestamp).
    /// In the QC-signed hash ⇒ agreed by the committee ⇒ every node seals an
    /// identical MacroBlock from the checkpoint (no producer dependency, no fork).
    pub timestamp: u64,
    pub proposer: NodeId,
    pub proposer_sig: Vec<u8>,
    /// `None` = ordinary full-quorum checkpoint (the only shape at genesis and in steady state).
    /// `Some((anchor_mb, anchor_hash))` = this checkpoint is certified under the RELAXED quorum,
    /// pinned to full-quorum-sealed macroblock `anchor_mb`. Bound into `hash()` ⇒ every QC signature
    /// covers it ⇒ the ≥T signatures on this checkpoint ARE the recovery certificate. There is no
    /// separate certificate object and no chain-inclusion test: "is this QC relaxed" is a pure
    /// function of its own bytes plus one final macroblock, so it cannot depend on the reorg-able
    /// tail and cannot become unverifiable after body pruning. `signers` is NEVER hashed.
    pub recovery_anchor: Option<RecoveryAnchor>,
}

impl Checkpoint {
    /// Canonical hash over consensus-critical fields (excludes proposer_sig).
    pub fn hash(&self) -> Hash {
        let mut h = Sha3_256::new();
        h.update(b"qnet-checkpoint-v2");
        h.update(self.index.to_le_bytes());
        if let Some(qc) = &self.parent_qc {
            h.update(qc.checkpoint_hash);
            h.update(qc.index.to_le_bytes());
        }
        h.update(self.window_head_height.to_le_bytes());
        for mh in &self.window_mb_hashes { h.update(mh); }
        h.update(self.state_root);
        h.update(self.beacon);
        h.update(self.epoch_commitment);
        h.update(self.reward_root);
        h.update(self.registry_root);
        h.update(self.logs_root);
        h.update(self.dilithium_pk_root);
        h.update(self.reward_epoch_root);
        h.update(self.total_supply.to_le_bytes());
        h.update(self.timestamp.to_le_bytes());
        h.update(self.proposer.as_bytes());
        fold_recovery_anchor(&mut h, &self.recovery_anchor);   // last hashed field
        h.finalize().into()
    }
}

/// Merkle root over an ordered event-log list (native QRC-20/721 transfers + WASM emit_log),
/// domain-separated from `sig_merkle_root`. `[0;32]` only for a log-less window; deterministic on
/// every node. The QC binds it into `Checkpoint.logs_root`; a light client verifies one log via
/// logs_merkle_proof against the root.
pub fn logs_merkle_root(logs: &[Vec<u8>]) -> Hash {
    if logs.is_empty() { return [0u8; 32]; }
    let mut layer: Vec<Hash> = logs.iter().map(|l| {
        let mut h = Sha3_256::new(); h.update(b"log-leaf"); h.update(l); h.finalize().into()
    }).collect();
    while layer.len() > 1 {
        let mut next = Vec::with_capacity((layer.len() + 1) / 2);
        for pair in layer.chunks(2) {
            let mut h = Sha3_256::new();
            h.update(b"log-node");
            h.update(pair[0]);
            h.update(if pair.len() == 2 { pair[1] } else { pair[0] });
            next.push(h.finalize().into());
        }
        layer = next;
    }
    layer[0]
}

/// Merkle inclusion proof for leaf `index` in the ordered log list — mirrors `logs_merkle_root`'s tree
/// (leaf = sha3("log-leaf"||l), node = sha3("log-node"||L||R), odd tail duplicated). Returns the sibling
/// hash + side (`true` = sibling on the RIGHT) at each level, leaf→root. Empty if `index` out of range.
pub fn logs_merkle_proof(logs: &[Vec<u8>], index: usize) -> Vec<(Hash, bool)> {
    logs_merkle_proof_with_root(logs, index).0
}

/// Single tree build returning both the proof and the root — the proof RPC needs both without
/// rebuilding the tree twice. Byte-identical proof to `logs_merkle_proof` (empty if out of range).
pub fn logs_merkle_proof_with_root(logs: &[Vec<u8>], index: usize) -> (Vec<(Hash, bool)>, Hash) {
    if logs.is_empty() { return (Vec::new(), [0u8; 32]); }
    let mut layer: Vec<Hash> = logs.iter().map(|l| {
        let mut h = Sha3_256::new(); h.update(b"log-leaf"); h.update(l); h.finalize().into()
    }).collect();
    let want_proof = index < logs.len();
    let mut idx = index;
    let mut proof = Vec::new();
    while layer.len() > 1 {
        if want_proof {
            let sib = if idx % 2 == 0 {
                (if idx + 1 < layer.len() { layer[idx + 1] } else { layer[idx] }, true) // right sibling (or self on odd tail)
            } else {
                (layer[idx - 1], false) // left sibling
            };
            proof.push(sib);
        }
        let mut next = Vec::with_capacity((layer.len() + 1) / 2);
        for pair in layer.chunks(2) {
            let mut h = Sha3_256::new();
            h.update(b"log-node");
            h.update(pair[0]);
            h.update(if pair.len() == 2 { pair[1] } else { pair[0] });
            next.push(h.finalize().into());
        }
        layer = next;
        idx /= 2;
    }
    (proof, layer[0])
}

/// Verify a logs inclusion proof: recompute the root from the RAW leaf + sibling path, compare to `root`.
/// A light client uses this to prove one transfer against a QC-anchored `Checkpoint.logs_root`.
pub fn verify_logs_merkle_proof(raw_leaf: &[u8], proof: &[(Hash, bool)], root: &Hash) -> bool {
    let mut cur: Hash = { let mut h = Sha3_256::new(); h.update(b"log-leaf"); h.update(raw_leaf); h.finalize().into() };
    for (sib, sib_is_right) in proof {
        let mut h = Sha3_256::new();
        h.update(b"log-node");
        if *sib_is_right { h.update(cur); h.update(sib); } else { h.update(sib); h.update(cur); }
        cur = h.finalize().into();
    }
    &cur == root
}

// ── Sharded (per-block) logs commitment ─────────────────────────────────────────────────────────────
// LEVEL 2. `Checkpoint.logs_root` is a Merkle root over the ORDERED per-block sub-roots of a macroblock
// window — each sub-root = `logs_merkle_root(block_logs)` (level 1; `[0;32]` for a log-less block). This
// is what makes proofs SCALE: sub-roots are computed once as each block applies and stored, so the seal
// is a tiny root over ~90 sub-roots (not a re-hash of the whole window), and a light-client proof =
// level-1 (leaf→block_root) + level-2 (block_root→window_root), each touching ONE block — serving and
// verifying are O(one block), never O(window). Domain `logw-*` is separate from the leaf level `log-*`
// so a block sub-root can never be reinterpreted as a leaf.

/// Merkle root over the ordered per-block sub-roots → the window's committed `logs_root`. `[0;32]` only
/// for an empty block set. Deterministic on every node (same sub-roots, same order).
pub fn logs_window_root(block_roots: &[Hash]) -> Hash {
    if block_roots.is_empty() { return [0u8; 32]; }
    let mut layer: Vec<Hash> = block_roots.iter().map(|r| {
        let mut h = Sha3_256::new(); h.update(b"logw-leaf"); h.update(r); h.finalize().into()
    }).collect();
    while layer.len() > 1 {
        let mut next = Vec::with_capacity((layer.len() + 1) / 2);
        for pair in layer.chunks(2) {
            let mut h = Sha3_256::new();
            h.update(b"logw-node");
            h.update(pair[0]);
            h.update(if pair.len() == 2 { pair[1] } else { pair[0] });
            next.push(h.finalize().into());
        }
        layer = next;
    }
    layer[0]
}

/// Level-2 inclusion proof: sibling path from block `index`'s sub-root up to `logs_window_root`. Returns
/// (path, window_root); mirrors `logs_merkle_proof_with_root` with the `logw-*` domain.
pub fn logs_window_proof_with_root(block_roots: &[Hash], index: usize) -> (Vec<(Hash, bool)>, Hash) {
    if block_roots.is_empty() { return (Vec::new(), [0u8; 32]); }
    let mut layer: Vec<Hash> = block_roots.iter().map(|r| {
        let mut h = Sha3_256::new(); h.update(b"logw-leaf"); h.update(r); h.finalize().into()
    }).collect();
    let want_proof = index < block_roots.len();
    let mut idx = index;
    let mut proof = Vec::new();
    while layer.len() > 1 {
        if want_proof {
            let sib = if idx % 2 == 0 {
                (if idx + 1 < layer.len() { layer[idx + 1] } else { layer[idx] }, true) // right sibling (or self on odd tail)
            } else {
                (layer[idx - 1], false) // left sibling
            };
            proof.push(sib);
        }
        let mut next = Vec::with_capacity((layer.len() + 1) / 2);
        for pair in layer.chunks(2) {
            let mut h = Sha3_256::new();
            h.update(b"logw-node");
            h.update(pair[0]);
            h.update(if pair.len() == 2 { pair[1] } else { pair[0] });
            next.push(h.finalize().into());
        }
        layer = next;
        idx /= 2;
    }
    (proof, layer[0])
}

/// Verify a level-2 proof: fold block `sub_root` up the sibling path, compare to `window_root`. Pair with
/// `verify_logs_merkle_proof` (level 1) to prove one log against a QC-anchored `Checkpoint.logs_root`.
pub fn verify_logs_window_proof(sub_root: &Hash, proof: &[(Hash, bool)], window_root: &Hash) -> bool {
    let mut cur: Hash = { let mut h = Sha3_256::new(); h.update(b"logw-leaf"); h.update(sub_root); h.finalize().into() };
    for (sib, sib_is_right) in proof {
        let mut h = Sha3_256::new();
        h.update(b"logw-node");
        if *sib_is_right { h.update(cur); h.update(sib); } else { h.update(sib); h.update(cur); }
        cur = h.finalize().into();
    }
    &cur == window_root
}

/// Merkle root over an ordered signature list (light clients verify root + sample).
pub fn sig_merkle_root(sigs: &[Vec<u8>]) -> Hash {
    if sigs.is_empty() { return [0u8; 32]; }
    let mut layer: Vec<Hash> = sigs.iter().map(|s| {
        let mut h = Sha3_256::new(); h.update(b"leaf"); h.update(s); h.finalize().into()
    }).collect();
    while layer.len() > 1 {
        let mut next = Vec::with_capacity((layer.len() + 1) / 2);
        for pair in layer.chunks(2) {
            let mut h = Sha3_256::new();
            h.update(b"node");
            h.update(pair[0]);
            h.update(if pair.len() == 2 { pair[1] } else { pair[0] });
            next.push(h.finalize().into());
        }
        layer = next;
    }
    layer[0]
}

impl QuorumCertificate {
    /// Structural + cryptographic validity. `verify_sig(voter, msg, sig)` is
    /// injected so this crate stays crypto-agnostic. `committee` = sorted epoch set.
    ///
    /// `quorum` is supplied by the CALLER, never derived here. A certificate must not be able to
    /// choose its own threshold, and the caller is the only place that can decide whether the
    /// recovery pin verified — pass `quorum_size(committee.len())` unless it did.
    pub fn verify<F: Fn(&str, &[u8], &[u8]) -> bool + Sync>(
        &self,
        committee: &[NodeId],
        quorum: usize,
        verify_sig: F,
    ) -> Result<(), &'static str> {
        let q = quorum;
        if q == 0 || self.signers.len() < q { return Err("qc_below_quorum"); }
        if self.signers.len() != self.sigs.len() { return Err("qc_len_mismatch"); }
        let mut seen = HashSet::new();
        for s in &self.signers {
            if !seen.insert(s.as_str()) { return Err("qc_duplicate_signer"); }
            if !committee.iter().any(|c| c == s) { return Err("qc_non_member"); }
        }
        if sig_merkle_root(&self.sigs) != self.sig_merkle_root { return Err("qc_merkle_mismatch"); }
        // Verify signatures in parallel: a committee is ≤1000 post-quantum sigs and ML-DSA has no
        // BLS-style aggregation, so par_iter spreads the per-sig Dilithium open across cores.
        // all() ≡ the serial AND (short-circuits on the first invalid); order is irrelevant.
        use rayon::prelude::*;
        let all_ok = self.signers.par_iter().zip(self.sigs.par_iter())
            .all(|(voter, sig)| verify_sig(voter, &self.checkpoint_hash, sig));
        if !all_ok { return Err("qc_bad_sig"); }
        Ok(())
    }
}

impl TimeoutCertificate {
    /// Structural + cryptographic validity (mirror of `QuorumCertificate::verify`).
    /// A TC is valid iff it carries ≥ `quorum_size` DISTINCT committee members' timeouts,
    /// ALL for this TC's view (`index`), each signature valid, and — if it carries a
    /// `high_qc` — that QC verifies too. Crypto-agnostic: the caller injects the per-timeout
    /// signature check and the high_qc check. This is the gate that stops a forged/empty TC
    /// from advancing a node's view: without it, `Tc { timeouts: [], high_qc: None }` was
    /// accepted and bumped `current_index` monotonically — an unauthenticated, non-self-healing
    /// view-desync DoS (adopt_qc never rewinds the view).
    ///
    /// `quorum` is caller-supplied for symmetry with `QuorumCertificate::verify`, but every caller
    /// passes `quorum_size`: a TC advances `current_index` WITHOUT certifying a window, which would
    /// break the index↔window lockstep the recovery pin depends on. Leaving it strict means it simply
    /// cannot form during a halt — which is the lockstep we want.
    pub fn verify<F, Q>(
        &self,
        committee: &[NodeId],
        quorum: usize,
        verify_timeout_sig: F,
        verify_qc: Q,
    ) -> Result<(), &'static str>
    where
        F: Fn(&TimeoutMsg) -> bool + Sync,
        Q: Fn(&QuorumCertificate) -> bool,
    {
        let q = quorum;
        if q == 0 || self.timeouts.len() < q { return Err("tc_below_quorum"); }
        // Cheap structural checks first (serial): a garbage TC is rejected here before the expensive sigs.
        let mut seen = HashSet::new();
        for t in &self.timeouts {
            if t.index != self.index { return Err("tc_index_mismatch"); }
            if !seen.insert(t.voter.as_str()) { return Err("tc_duplicate_voter"); }
            if !committee.iter().any(|c| c == &t.voter) { return Err("tc_non_member"); }
        }
        // Verify the (up to ≈quorum, ≤1000) ML-DSA timeout signatures IN PARALLEL — mirror
        // QuorumCertificate::verify. A serial loop made a 1000-committee TC a ~3.3s single-threaded block
        // on the consensus select-loop task (timer/finality starvation at scale); par_iter spreads the
        // per-sig Dilithium open across cores. all() ≡ serial AND (short-circuits); order is irrelevant.
        use rayon::prelude::*;
        if !self.timeouts.par_iter().all(|t| verify_timeout_sig(t)) { return Err("tc_bad_sig"); }
        if let Some(hq) = &self.high_qc {
            if !verify_qc(hq) { return Err("tc_bad_high_qc"); }
        }
        Ok(())
    }
}

/// 2-chain commit: given a child checkpoint and its QC, returns the PARENT index
/// that becomes final (child justifies parent and is itself QC'd at index+1).
pub fn commits_parent(child: &Checkpoint, child_qc: &QuorumCertificate) -> Option<u64> {
    let pq = child.parent_qc.as_ref()?;
    if child_qc.index == child.index && child.index == pq.index + 1 {
        Some(pq.index)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(n: u8) -> Hash { [n; 32] }

    // Regression: the intra-window cursor MUST step over macroblock boundaries instead of stalling
    // on the first one. The stall (cursor never advances past 90) starved every checkpoint of the
    // second window ⇒ the chain froze right after the first macroblock. Encodes that exact walk.
    #[test]
    fn intra_checkpoint_boundary_steps_over_macroblock_boundaries() {
        let (k, m) = (30u64, 90u64);
        assert_eq!(next_intra_checkpoint_boundary(0, 30, k, m), (Some(30), 0));
        assert_eq!(next_intra_checkpoint_boundary(30, 60, k, m), (Some(60), 30));
        // THE BUG: from 60 with the tip on/after the macroblock boundary 90 must NOT stall — 90 is
        // stepped over (cursor→90) and nothing intra is due until the tip reaches 120.
        assert_eq!(next_intra_checkpoint_boundary(60, 90, k, m), (None, 90));
        assert_eq!(next_intra_checkpoint_boundary(60, 119, k, m), (None, 90));
        assert_eq!(next_intra_checkpoint_boundary(60, 120, k, m), (Some(120), 90));
        assert_eq!(next_intra_checkpoint_boundary(120, 150, k, m), (Some(150), 120));
        // second macroblock boundary (180) also stepped, not stalled
        assert_eq!(next_intra_checkpoint_boundary(150, 180, k, m), (None, 180));
        assert_eq!(next_intra_checkpoint_boundary(150, 210, k, m), (Some(210), 180));
        // other valid divisors of 90
        assert_eq!(next_intra_checkpoint_boundary(0, 45, 15, 90), (Some(15), 0));
        assert_eq!(next_intra_checkpoint_boundary(75, 105, 15, 90), (Some(105), 90)); // 90 stepped
        // K == macro ⇒ EVERY boundary is a macroblock boundary ⇒ intra path dormant, never stalls
        assert_eq!(next_intra_checkpoint_boundary(0, 10_000, 90, 90), (None, 9_990));
        // degenerate guards
        assert_eq!(next_intra_checkpoint_boundary(50, 1000, 0, 90), (None, 50));
    }

    #[test]
    fn quorum_math() {
        assert_eq!(quorum_size(0), 0);
        assert_eq!(quorum_size(1), 1);
        assert_eq!(quorum_size(4), 3);   // f=1, n=3f+1 ⇒ n−f=2f+1
        assert_eq!(quorum_size(5), 4);   // f=1, n>3f+1 ⇒ n−f=4 (2f+1=3 would be unsafe)
        assert_eq!(quorum_size(7), 5);   // f=2
        assert_eq!(quorum_size(100), 67);// f=33
        assert_eq!(quorum_size(1000), 667);
    }

    #[test]
    fn beacon_order_independent_and_sensitive() {
        let a = vec![h(1), h(2), h(3)];
        let b = vec![h(3), h(1), h(2)];          // same set, different order
        assert_eq!(accumulate_beacon(&a), accumulate_beacon(&b));
        assert_ne!(accumulate_beacon(&a), accumulate_beacon(&[h(1), h(2)]));
        assert_eq!(accumulate_beacon(&[]), accumulate_beacon(&[]));
    }

    #[test]
    fn leader_is_pure_and_in_range() {
        let p = h(9);
        let a = leader_index(5, &p, 100);
        let b = leader_index(5, &p, 100);
        assert_eq!(a, b);                 // pure function
        assert!(a < 100);                 // in range
        // different input ⇒ may differ, but always deterministic
        assert_eq!(leader_index(6, &p, 100), leader_index(6, &p, 100));
        assert_eq!(leader_index(5, &h(1), 5), leader_index(5, &h(1), 5));
    }

    #[test]
    fn checkpoint_hash_excludes_sig() {
        let mut c = Checkpoint {
            index: 1, parent_qc: None, window_head_height: 90,
            window_mb_hashes: vec![h(1), h(2)], state_root: h(3),
            beacon: h(4), epoch_commitment: h(0), reward_root: h(0), registry_root: h(0), logs_root: h(0), dilithium_pk_root: h(0), reward_epoch_root: h(0),total_supply: 0, timestamp: 0, proposer: "n1".into(), proposer_sig: vec![1,2,3], recovery_anchor: None,
        };
        let x = c.hash();
        c.proposer_sig = vec![9, 9, 9];   // sig change must NOT change hash
        assert_eq!(c.hash(), x);
        c.state_root = h(7);              // field change MUST change hash
        assert_ne!(c.hash(), x);
        // reward_root MUST be bound into the hash: the QC signs cp.hash(), so a checkpoint
        // differing only in reward_root must produce a different hash (else the quorum could not
        // certify the reward distribution and a proposer-chosen root would ride uncertified).
        let mut a = c.clone();
        a.reward_root = h(0);
        let mut b = a.clone();
        b.reward_root = h(5);
        assert_ne!(a.hash(), b.hash());
        // logs_root MUST be bound too: at VM activation the QC certifies the window's WASM-log
        // root, so a checkpoint differing only in logs_root must hash differently (else a
        // proposer-chosen log root would ride uncertified). Active from genesis (gate=0).
        let mut la = c.clone();
        la.logs_root = h(0);
        let mut lb = la.clone();
        lb.logs_root = h(7);
        assert_ne!(la.hash(), lb.hash());
    }

    #[test]
    fn logs_merkle_root_empty_is_zero_and_deterministic() {
        // Gated-OFF invariant: an empty window ⇒ [0;32] on every node.
        assert_eq!(logs_merkle_root(&[]), [0u8; 32]);
        // Non-empty is order-sensitive + deterministic + domain-separated from sig_merkle_root.
        let logs = vec![b"a".to_vec(), b"bb".to_vec(), b"ccc".to_vec()];
        assert_eq!(logs_merkle_root(&logs), logs_merkle_root(&logs));
        assert_ne!(logs_merkle_root(&logs), [0u8; 32]);
        assert_ne!(logs_merkle_root(&logs), sig_merkle_root(&logs));
        let reordered = vec![b"bb".to_vec(), b"a".to_vec(), b"ccc".to_vec()];
        assert_ne!(logs_merkle_root(&logs), logs_merkle_root(&reordered));
    }

    #[test]
    fn logs_merkle_proof_verifies_for_every_index_and_size() {
        // Every leaf's proof must recompute the exact logs_merkle_root — across sizes that hit the
        // odd-tail duplicate path (1,2,3,5,8). A tampered leaf/root must fail.
        for n in [1usize, 2, 3, 5, 8] {
            let logs: Vec<Vec<u8>> = (0..n).map(|i| format!("leaf-{}", i).into_bytes()).collect();
            let root = logs_merkle_root(&logs);
            for i in 0..n {
                let proof = logs_merkle_proof(&logs, i);
                assert!(verify_logs_merkle_proof(&logs[i], &proof, &root), "size={} idx={}", n, i);
                assert!(!verify_logs_merkle_proof(b"forged", &proof, &root), "forged leaf must fail size={} idx={}", n, i);
            }
        }
        assert!(logs_merkle_proof(&[b"x".to_vec()], 5).is_empty()); // out-of-range
    }

    #[test]
    fn sharded_logs_two_level_proof_round_trips() {
        // 5 blocks, varying leaf counts incl. empty (→ [0;32] sub-root). Prove one leaf via level-1
        // (leaf→block_root) THEN level-2 (block_root→window_root); confirm it folds to logs_window_root.
        // A forged leaf breaks L1; a tampered sub-root breaks L2. This is the SCALE property: each proof
        // rebuilds only ONE block (level 1) + folds ~90 sub-roots (level 2), never the whole window.
        let blocks: Vec<Vec<Vec<u8>>> = vec![
            vec![b"a0".to_vec(), b"a1".to_vec(), b"a2".to_vec()],
            vec![],
            vec![b"c0".to_vec()],
            vec![b"d0".to_vec(), b"d1".to_vec()],
            vec![],
        ];
        let sub_roots: Vec<Hash> = blocks.iter().map(|b| logs_merkle_root(b)).collect();
        let window_root = logs_window_root(&sub_roots);
        assert_eq!(window_root, logs_window_root(&sub_roots), "window root must be deterministic");
        assert_ne!(window_root, [0u8; 32], "non-empty block set ⇒ non-zero window root");
        for (bi, block) in blocks.iter().enumerate() {
            let (l2, wr) = logs_window_proof_with_root(&sub_roots, bi);
            assert_eq!(wr, window_root, "level-2 build must match window root, block {}", bi);
            assert!(verify_logs_window_proof(&sub_roots[bi], &l2, &window_root), "L2 verify block {}", bi);
            assert!(!verify_logs_window_proof(&[9u8; 32], &l2, &window_root), "tampered sub-root must fail, block {}", bi);
            for li in 0..block.len() {
                let (l1, block_root) = logs_merkle_proof_with_root(block, li);
                assert_eq!(block_root, sub_roots[bi], "level-1 root == stored sub-root");
                assert!(verify_logs_merkle_proof(&block[li], &l1, &block_root), "L1 verify b{} l{}", bi, li);
                assert!(!verify_logs_merkle_proof(b"forged", &l1, &block_root), "forged leaf must fail b{} l{}", bi, li);
            }
        }
    }

    /// The parent link MUST be inside the QC-signed hash. It is what chains one checkpoint to the
    /// next, so if it were dropped from the preimage a proposal could be re-parented onto a different
    /// history and still carry a valid n−f-signer certificate. The other parent-link tests deliberately do
    /// not call hash(), so without this one the fold could be deleted and the suite would stay green.
    #[test]
    fn checkpoint_hash_binds_parent_link() {
        let base = Checkpoint {
            index: 1, parent_qc: None, window_head_height: 90,
            window_mb_hashes: vec![h(1), h(2)], state_root: h(3), beacon: h(4),
            epoch_commitment: h(0), reward_root: h(0), registry_root: h(0), logs_root: h(0),
            dilithium_pk_root: h(0), reward_epoch_root: h(0), total_supply: 1, timestamp: 0,
            proposer: "n1".into(), proposer_sig: vec![1, 2, 3], recovery_anchor: None,
        };
        let mut linked = base.clone();
        linked.parent_qc = Some(QcRef { checkpoint_hash: h(9), index: 0 });
        assert_ne!(base.hash(), linked.hash(), "absent vs present parent must differ");

        let mut other_parent = linked.clone();
        other_parent.parent_qc = Some(QcRef { checkpoint_hash: h(8), index: 0 });
        assert_ne!(linked.hash(), other_parent.hash(), "parent hash must be bound");

        let mut other_index = linked.clone();
        other_index.parent_qc = Some(QcRef { checkpoint_hash: h(9), index: 1 });
        assert_ne!(linked.hash(), other_index.hash(), "parent index must be bound");
    }

    #[test]
    fn checkpoint_hash_binds_total_supply() {
        // total_supply MUST be bound into the QC-signed hash: a cold-joiner trusts this value
        // (the quorum certifies it) instead of summing balances, so a checkpoint differing only in
        // total_supply must produce a different hash. Otherwise stable + deterministic.
        let c = Checkpoint {
            index: 1, parent_qc: None, window_head_height: 90,
            window_mb_hashes: vec![h(1), h(2)], state_root: h(3),
            beacon: h(4), epoch_commitment: h(0), reward_root: h(0), registry_root: h(0), logs_root: h(0), dilithium_pk_root: h(0), reward_epoch_root: h(0),total_supply: 1_000_000, timestamp: 0, proposer: "n1".into(), proposer_sig: vec![1,2,3], recovery_anchor: None,
        };
        let base = c.hash();
        assert_eq!(c.hash(), base, "hash must be deterministic for fixed fields");
        let mut d = c.clone();
        d.total_supply = 2_000_000;        // value change MUST change hash
        assert_ne!(d.hash(), base, "total_supply must be in the QC-signed hash");
    }

    #[test]
    fn checkpoint_hash_binds_dilithium_pk_root() {
        // dilithium_pk_root MUST be bound into the QC-signed hash: an untrusted-snapshot joiner verifies its
        // restored per-account ML-DSA-65 pubkeys against this quorum-certified digest. If the field were
        // dropped from the preimage, a node could publish any value without breaking the QC — the elided-pk
        // snapshot attack this field exists to close. Mirrors checkpoint_hash_binds_total_supply.
        let c = Checkpoint {
            index: 1, parent_qc: None, window_head_height: 90,
            window_mb_hashes: vec![h(1), h(2)], state_root: h(3),
            beacon: h(4), epoch_commitment: h(0), reward_root: h(0), registry_root: h(0), logs_root: h(0),
            dilithium_pk_root: h(7), reward_epoch_root: h(0), total_supply: 0, timestamp: 0, proposer: "n1".into(), proposer_sig: vec![1,2,3], recovery_anchor: None,
        };
        let base = c.hash();
        assert_eq!(c.hash(), base, "hash must be deterministic for fixed fields");
        let mut d = c.clone();
        d.dilithium_pk_root = h(8);        // value change MUST change hash
        assert_ne!(d.hash(), base, "dilithium_pk_root must be in the QC-signed hash");
        let mut e = c.clone();
        e.reward_epoch_root = h(9);
        assert_ne!(e.hash(), base, "reward_epoch_root must be in the QC-signed hash");
    }

    #[test]
    fn merkle_root_deterministic_and_sensitive() {
        let a = vec![vec![1u8,2], vec![3,4], vec![5,6]];
        assert_eq!(sig_merkle_root(&a), sig_merkle_root(&a));
        let b = vec![vec![1u8,2], vec![3,4], vec![5,7]];
        assert_ne!(sig_merkle_root(&a), sig_merkle_root(&b));
        assert_eq!(sig_merkle_root(&[]), [0u8; 32]);
    }

    /// Measured, not estimated: what the parent link actually saves at COMMITTEE_SIZE=1000.
    #[test]
    fn measure_proposal_size_at_committee_1000() {
        let a: Vec<NodeId> = (0..1000).map(|i| format!("node_{:04}", i)).collect();
        // A real QC: 667 signers, each sig the compacted on-chain form (~4566 B).
        let signers: Vec<NodeId> = a.iter().take(667).cloned().collect();
        let sigs: Vec<Vec<u8>> = signers.iter().map(|_| vec![7u8; 4566]).collect();
        let fat = QuorumCertificate {
            checkpoint_hash: h(3), index: 11, sig_merkle_root: sig_merkle_root(&sigs), signers, sigs,
        };
        let cp = Checkpoint {
            index: 12, parent_qc: Some(QcRef::from(&fat)), window_head_height: 1080,
            window_mb_hashes: (0..30).map(|i| h(i as u8)).collect(),
            state_root: h(1), beacon: h(2), epoch_commitment: h(3), reward_root: h(4),
            registry_root: h(5), logs_root: h(6), dilithium_pk_root: h(7), reward_epoch_root: h(8),
            total_supply: 1, timestamp: 1, proposer: "node_0001".into(), proposer_sig: vec![0u8; 7174], recovery_anchor: None,
        };
        let with_link = bincode::serialize(&cp).unwrap().len();
        let embedded = with_link + bincode::serialize(&fat).unwrap().len();
        println!("[MEASURE] proposal_with_link={} proposal_with_embedded_qc={} ratio={:.0}x",
                 with_link, embedded, embedded as f64 / with_link as f64);
        assert!(embedded / with_link > 100, "expected a >100x reduction, got {}x", embedded / with_link);
    }

    /// A checkpoint's parent link is the QC's IDENTITY, never its signatures. Two QCs certifying the
    /// same parent with different signer sets must give the same checkpoint hash — the signer set is
    /// the first-quorum-to-arrive at each node, so if it reached the hash the network would fork.
    #[test]
    fn parent_link_ignores_the_signer_set() {
        let a: Vec<NodeId> = (0..10).map(|i| format!("node_{:02}", i)).collect();
        let qc_few = mk_qc(&a, h(7), 4, 4);
        let qc_many = mk_qc(&a, h(7), 4, 9);
        assert_ne!(qc_few.signers, qc_many.signers, "the two QCs must differ in signers");
        assert_eq!(QcRef::from(&qc_few), QcRef::from(&qc_many));
    }

    /// Regression guard on proposal size. The parent QC used to be embedded whole: at
    /// COMMITTEE_SIZE=1000 that is ~3.05 MB of unread signatures in EVERY proposal, re-sent to every
    /// peer every round, and duplicated twice more inside every VoteEquivocationProof. If someone
    /// re-embeds a certificate in the checkpoint, this test is what catches it.
    #[test]
    fn checkpoint_stays_small_with_a_parent_link() {
        let a: Vec<NodeId> = (0..1000).map(|i| format!("node_{:04}", i)).collect();
        let fat = mk_qc(&a, h(3), 11, 667);
        let cp = Checkpoint {
            index: 12,
            parent_qc: Some(QcRef::from(&fat)),
            window_head_height: 1080,
            window_mb_hashes: (0..30).map(|i| h(i as u8)).collect(),
            state_root: h(1), beacon: h(2), epoch_commitment: h(3), reward_root: h(4),
            registry_root: h(5), logs_root: h(6), dilithium_pk_root: h(7), reward_epoch_root: h(8),
            total_supply: 1, timestamp: 1, proposer: "node_0001".into(), proposer_sig: vec![0u8; 64], recovery_anchor: None,
        };
        let n = bincode::serialize(&cp).unwrap().len();
        assert!(n < 2048, "checkpoint grew to {} bytes — is a certificate embedded again?", n);
        // And the certificate it links to really is the large object we refused to carry.
        assert!(bincode::serialize(&fat).unwrap().len() > 20_000);
    }

    /// TimeoutCertificate size at the 1000-committee cap, with and without pk-elision on the timeout
    /// signatures. The full envelope carries a redundant 1952-byte public key the verifier re-derives
    /// from committee state anyway.
    #[test]
    fn measure_timeout_certificate_size() {
        let q = quorum_size(1000);
        let mk = |sig_len: usize| TimeoutCertificate {
            index: 12,
            timeouts: (0..q).map(|i| TimeoutMsg {
                index: 12, voter: format!("node_{:04}", i), high_qc_index: 11,
                signature: vec![7u8; sig_len],
            }).collect(),
            high_qc: Some(QuorumCertificate {
                checkpoint_hash: h(3), index: 11,
                signers: (0..q).map(|i| format!("node_{:04}", i)).collect(),
                sig_merkle_root: h(4),
                sigs: (0..q).map(|_| vec![7u8; 4555]).collect(),
            }),
        };
        let full = bincode::serialize(&mk(7167)).unwrap().len();
        let compact = bincode::serialize(&mk(4555)).unwrap().len();
        println!("[MEASURE] tc_full={} tc_compact={} saved={} quorum={}",
                 full, compact, full - compact, q);
        assert!(compact < full);
        // Must stay clear of the 10 MiB message ceiling with headroom at the shipped committee cap.
        assert!(compact < 8 * 1024 * 1024, "compact TC {} exceeds headroom", compact);
    }

    fn mk_qc(committee: &[NodeId], hash: Hash, index: u64, n: usize) -> QuorumCertificate {
        let signers: Vec<NodeId> = committee.iter().take(n).cloned().collect();
        let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
        QuorumCertificate { checkpoint_hash: hash, index, sig_merkle_root: sig_merkle_root(&sigs), signers, sigs }
    }

    #[test]
    fn qc_verify_paths() {
        let committee: Vec<NodeId> = (0..5).map(|i| format!("n{}", i)).collect();
        let ok = |_v: &str, _m: &[u8], _s: &[u8]| true;
        // valid: 4 of 5 (quorum = n−f = 4)
        let qc = mk_qc(&committee, h(1), 7, 4);
        assert!(qc.verify(&committee, quorum_size(committee.len()), ok).is_ok());
        // below quorum
        let qc2 = mk_qc(&committee, h(1), 7, 3);
        assert_eq!(qc2.verify(&committee, quorum_size(committee.len()), ok), Err("qc_below_quorum"));
        // non-member
        let mut qc3 = mk_qc(&committee, h(1), 7, 4);
        qc3.signers[0] = "evil".into();
        qc3.sig_merkle_root = sig_merkle_root(&qc3.sigs);
        assert_eq!(qc3.verify(&committee, quorum_size(committee.len()), ok), Err("qc_non_member"));
        // duplicate signer
        let mut qc4 = mk_qc(&committee, h(1), 7, 4);
        qc4.signers[1] = qc4.signers[0].clone();
        assert_eq!(qc4.verify(&committee, quorum_size(committee.len()), ok), Err("qc_duplicate_signer"));
        // merkle mismatch
        let mut qc5 = mk_qc(&committee, h(1), 7, 4);
        qc5.sig_merkle_root = h(99);
        assert_eq!(qc5.verify(&committee, quorum_size(committee.len()), ok), Err("qc_merkle_mismatch"));
        // bad sig
        let qc6 = mk_qc(&committee, h(1), 7, 4);
        let bad = |_v: &str, _m: &[u8], _s: &[u8]| false;
        assert_eq!(qc6.verify(&committee, quorum_size(committee.len()), bad), Err("qc_bad_sig"));
    }

    fn mk_tmo(voter: &str, index: u64) -> TimeoutMsg {
        TimeoutMsg { index, voter: voter.into(), high_qc_index: 0, signature: voter.as_bytes().to_vec() }
    }

    #[test]
    fn tc_verify_paths() {
        let committee: Vec<NodeId> = (0..5).map(|i| format!("n{}", i)).collect();
        let vsig = |t: &TimeoutMsg| t.signature == t.voter.as_bytes().to_vec();
        let vqc = |_q: &QuorumCertificate| true;
        // valid: 4 distinct committee timeouts at view 7 (quorum = n−f = 4)
        let good = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7), mk_tmo("n3",7)], high_qc: None };
        assert!(good.verify(&committee, quorum_size(committee.len()), vsig, vqc).is_ok());
        // EMPTY timeouts — the H4 attack (was accepted, advanced the view) → reject
        let empty = TimeoutCertificate { index: 7, timeouts: vec![], high_qc: None };
        assert_eq!(empty.verify(&committee, quorum_size(committee.len()), vsig, vqc), Err("tc_below_quorum"));
        // below quorum (3 < 4) → reject
        let short = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7)], high_qc: None };
        assert_eq!(short.verify(&committee, quorum_size(committee.len()), vsig, vqc), Err("tc_below_quorum"));
        // a timeout for a DIFFERENT view → reject
        let wrongidx = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7), mk_tmo("n3",6)], high_qc: None };
        assert_eq!(wrongidx.verify(&committee, quorum_size(committee.len()), vsig, vqc), Err("tc_index_mismatch"));
        // duplicate voter → reject
        let dup = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7)], high_qc: None };
        assert_eq!(dup.verify(&committee, quorum_size(committee.len()), vsig, vqc), Err("tc_duplicate_voter"));
        // non-committee voter → reject
        let outsider = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7), mk_tmo("evil",7)], high_qc: None };
        assert_eq!(outsider.verify(&committee, quorum_size(committee.len()), vsig, vqc), Err("tc_non_member"));
        // bad timeout signature → reject
        let mut bad_t = mk_tmo("n3",7); bad_t.signature = vec![0];
        let badsig = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7), bad_t], high_qc: None };
        assert_eq!(badsig.verify(&committee, quorum_size(committee.len()), vsig, vqc), Err("tc_bad_sig"));
        // carries an invalid high_qc → reject
        let with_bad_qc = TimeoutCertificate { index: 7, timeouts: vec![mk_tmo("n0",7), mk_tmo("n1",7), mk_tmo("n2",7), mk_tmo("n3",7)], high_qc: Some(mk_qc(&committee, h(1), 6, 4)) };
        assert_eq!(with_bad_qc.verify(&committee, quorum_size(committee.len()), vsig, |_q| false), Err("tc_bad_high_qc"));
    }

    #[test]
    fn committee_sample_deterministic_bounded_and_order_preserving() {
        let seed = h(9);
        // ≤ threshold → the WHOLE set is the committee (no subsample). This is why the genesis
        // 5-node net is a no-op: committee == eligible == 5, failover quorum unchanged.
        let small: Vec<NodeId> = (0..5).map(|i| format!("n{}", i)).collect();
        assert_eq!(sample_committee(&small, 7, &seed, COMMITTEE_THRESHOLD, COMMITTEE_SIZE), small);

        // > threshold → subsample to exactly COMMITTEE_SIZE, deterministic, a subset, order-preserving.
        let big: Vec<NodeId> = (0..1500).map(|i| format!("n{:04}", i)).collect();
        let c1 = sample_committee(&big, 7, &seed, COMMITTEE_THRESHOLD, COMMITTEE_SIZE);
        assert_eq!(c1, sample_committee(&big, 7, &seed, COMMITTEE_THRESHOLD, COMMITTEE_SIZE), "deterministic");
        assert_eq!(c1.len(), COMMITTEE_SIZE);
        assert!(c1.iter().all(|x| big.contains(x)), "committee ⊆ candidates");
        let uniq: std::collections::HashSet<&String> = c1.iter().collect();
        assert_eq!(uniq.len(), COMMITTEE_SIZE, "distinct members");
        let mut sorted = c1.clone(); sorted.sort();
        assert_eq!(c1, sorted, "preserves sorted-candidate order ⇒ failover & checkpoint match");

        // Same (candidates, window, seed) on both layers ⇒ identical committee; a different window
        // or seed legitimately rotates it.
        assert_ne!(c1, sample_committee(&big, 7, &h(1), COMMITTEE_THRESHOLD, COMMITTEE_SIZE), "seed-sensitive");
        assert_ne!(c1, sample_committee(&big, 8, &seed, COMMITTEE_THRESHOLD, COMMITTEE_SIZE), "window-sensitive");
    }

    #[test]
    fn epoch_commitment_binds_banned() {
        let elig = b"elig-snapshot-bytes";
        let committee: Vec<NodeId> = vec!["c1".into(), "c2".into()];
        let base = epoch_commitment(elig, &committee, &[]);
        let banned_a: Vec<NodeId> = vec!["bad1".into()];
        let banned_b: Vec<NodeId> = vec!["bad1".into(), "bad2".into()];
        let ca = epoch_commitment(elig, &committee, &banned_a);
        let cb = epoch_commitment(elig, &committee, &banned_b);
        // The ban set is bound: any change to it changes the commitment ⇒ a corrupted stored
        // banned_validators can never match the QC-certified checkpoint.
        assert_ne!(base, ca, "adding a ban changes the commitment");
        assert_ne!(base, cb);
        assert_ne!(ca, cb, "ban-set contents are bound, not just length");
        // Order-independent (sorted internally) ⇒ every sealer/verifier agrees regardless of
        // the order the ban set was assembled in.
        let banned_b_rev: Vec<NodeId> = vec!["bad2".into(), "bad1".into()];
        assert_eq!(cb, epoch_commitment(elig, &committee, &banned_b_rev), "ban order does not matter");
        // Domain separation: a member must not be reinterpretable across the committee/ban
        // boundary — committee=[X],banned=[] differs from committee=[],banned=[X].
        let only_committee = epoch_commitment(elig, &vec!["X".into()], &[]);
        let only_banned = epoch_commitment(elig, &[], &vec!["X".into()]);
        assert_ne!(only_committee, only_banned, "committee vs ban are domain-separated");
    }

    #[test]
    fn two_chain_commit() {
        let committee: Vec<NodeId> = (0..5).map(|i| format!("n{}", i)).collect();
        let parent_qc = mk_qc(&committee, h(1), 4, 3);
        let child = Checkpoint {
            index: 5, parent_qc: Some(QcRef::from(&parent_qc)), window_head_height: 450,
            window_mb_hashes: vec![h(1)], state_root: h(2), beacon: h(3),
            epoch_commitment: h(0), reward_root: h(0), registry_root: h(0), logs_root: h(0), dilithium_pk_root: h(0), reward_epoch_root: h(0),total_supply: 0, timestamp: 0, proposer: "n0".into(), proposer_sig: vec![], recovery_anchor: None,
        };
        let child_qc = mk_qc(&committee, child.hash(), 5, 3);
        assert_eq!(commits_parent(&child, &child_qc), Some(4)); // C4 final
        // wrong child_qc index ⇒ no commit
        let bad_qc = mk_qc(&committee, child.hash(), 6, 3);
        assert_eq!(commits_parent(&child, &bad_qc), None);
    }

    #[test]
    fn wire_roundtrip() {
        let committee: Vec<NodeId> = (0..5).map(|i| format!("n{}", i)).collect();
        let qc = mk_qc(&committee, h(1), 7, 3);
        let c = Checkpoint {
            index: 7, parent_qc: Some(QcRef::from(&qc)), window_head_height: 630,
            window_mb_hashes: vec![h(1), h(2)], state_root: h(3), beacon: h(4),
            epoch_commitment: h(0), reward_root: h(0), registry_root: h(0), logs_root: h(0), dilithium_pk_root: h(0), reward_epoch_root: h(0),total_supply: 0, timestamp: 0, proposer: "n1".into(), proposer_sig: vec![1,2,3], recovery_anchor: None,
        };
        let bytes = bincode::serialize(&c).unwrap();
        let back: Checkpoint = bincode::deserialize(&bytes).unwrap();
        assert_eq!(c, back);
        let tc = TimeoutCertificate { index: 7, timeouts: vec![
            TimeoutMsg { index: 7, voter: "n0".into(), high_qc_index: 6, signature: vec![1] },
        ], high_qc: Some(qc) };
        let tb = bincode::serialize(&tc).unwrap();
        assert_eq!(tc, bincode::deserialize::<TimeoutCertificate>(&tb).unwrap());
    }

    // ── RECOVERY RELAXATION ────────────────────────────────────────────────────────────────────

    #[test]
    fn recovery_anchor_is_bound_into_the_checkpoint_hash() {
        let base = Checkpoint {
            index: 1, parent_qc: None, window_head_height: 90,
            window_mb_hashes: vec![h(1)], state_root: h(3), beacon: h(4),
            epoch_commitment: h(0), reward_root: h(0), registry_root: h(0), logs_root: h(0),
            dilithium_pk_root: h(0), reward_epoch_root: h(0), total_supply: 0, timestamp: 0,
            proposer: "n1".into(), proposer_sig: vec![1, 2, 3], recovery_anchor: None,
        };
        let mut zero = base.clone(); zero.recovery_anchor = Some((0, [0u8; 32]));
        let mut one  = base.clone(); one.recovery_anchor  = Some((1, [0u8; 32]));
        let mut oneh = base.clone(); oneh.recovery_anchor = Some((1, h(9)));
        // Present/absent is TAGGED, so None can never collide with Some((0, zeros)).
        assert_ne!(base.hash(), zero.hash());
        assert_ne!(zero.hash(), one.hash());
        assert_ne!(one.hash(), oneh.hash());
        // The pin rides inside what the QC signs => the >=T signatures ARE the certificate.
        assert_eq!(one.hash(), one.clone().hash());
    }

    #[test]
    fn relaxed_quorum_floor_and_intersection() {
        // Inert below the floor: the relaxation must not exist at genesis scale.
        for n in 0..RELAXED_MIN_COMMITTEE {
            assert_eq!(relaxed_quorum(n), quorum_size(n), "n={} must be floored", n);
        }
        assert_eq!(relaxed_quorum(5), 4);
        assert_eq!(relaxed_quorum(10), 6);
        assert_eq!(relaxed_quorum(100), 51);
        assert_eq!(relaxed_quorum(1000), 501);
        for n in 1..=1000usize {
            // Two RELAXED quorums intersect (the same-index double-signer the proof type needs)...
            assert!(2 * relaxed_quorum(n) > n, "relaxed pair must intersect at n={}", n);
            // ...and so do a relaxed one and a strict one, so mixing thresholds stays safe.
            assert!(relaxed_quorum(n) + quorum_size(n) > n, "mixed pair must intersect at n={}", n);
            assert!(relaxed_quorum(n) <= quorum_size(n), "relaxation must never RAISE the bar at n={}", n);
        }
    }

    #[test]
    fn effective_quorum_routes_both_ways() {
        assert_eq!(effective_quorum(1000, false), quorum_size(1000));
        assert_eq!(effective_quorum(1000, true), relaxed_quorum(1000));
        // Below the floor the flag is inert — arming a small committee changes nothing.
        assert_eq!(effective_quorum(5, true), effective_quorum(5, false));
    }

    #[test]
    fn recovery_pin_is_injective_over_the_span() {
        let (a0, h0) = (7u64, 630u64);
        let mut idx = std::collections::HashSet::new();
        let mut head = std::collections::HashSet::new();
        for k in 1..=RC_SPAN_INDICES {
            let hh = recovery_window_head(h0, k);
            assert_eq!(hh, h0 + k * CHECKPOINT_INTERVAL);
            assert_eq!(recovery_step_for_head(h0, hh), Some(k), "the step must be readable back");
            assert!(idx.insert(k), "step repeats at k={}", k);
            assert!(head.insert(hh), "window head repeats at k={}", k);
        }
        // Exactly two macroblocks of span: 6 * 30 == 180 == 2 * MACROBLOCK_INTERVAL.
        assert_eq!(RC_SPAN_INDICES * CHECKPOINT_INTERVAL, 2 * MACROBLOCK_INTERVAL);
        // Off-grid and out-of-span heads have no step at all.
        assert_eq!(recovery_step_for_head(h0, h0), None, "k=0 is not a span position");
        assert_eq!(recovery_step_for_head(h0, h0 + 1), None, "off the CHECKPOINT_INTERVAL grid");
        assert_eq!(recovery_step_for_head(h0, h0 + (RC_SPAN_INDICES + 1) * CHECKPOINT_INTERVAL), None);
        assert_eq!(recovery_step_for_head(h0, h0 - CHECKPOINT_INTERVAL), None, "below the anchor");

        // FAILOVER key space: window w covers heights (w-1)*90+1 ..= w*90, so the span's heights
        // (A*90, A*90+180] are windows A+1 and A+2. The anchor's own window A is already sealed and
        // must stay strict — including it would relax a window nobody is stuck on.
        assert_eq!(h0 / MACROBLOCK_INTERVAL, a0, "h0 is the anchor's macroblock boundary");
        assert_eq!(recovery_failover_windows(a0), (a0 + 1, a0 + 2));
        for k in 1..=RC_SPAN_INDICES {
            let head = recovery_window_head(h0, k);
            let w = (head - 1) / MACROBLOCK_INTERVAL + 1;
            let (lo, hi) = recovery_failover_windows(a0);
            assert!(w >= lo && w <= hi, "k={} lands on failover window {}", k, w);
        }
    }

    #[test]
    fn qc_verify_takes_the_threshold_from_the_caller() {
        // A certificate must never choose its own bar. Ten members, six signers: below the strict
        // quorum, at the relaxed one.
        let committee: Vec<NodeId> = (0..10).map(|i| format!("n{}", i)).collect();
        let signers: Vec<NodeId> = committee.iter().take(6).cloned().collect();
        let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
        let qc = QuorumCertificate {
            checkpoint_hash: h(1), index: 3,
            sig_merkle_root: sig_merkle_root(&sigs), signers, sigs,
        };
        let ok = |_v: &str, _b: &[u8], _s: &[u8]| true;
        assert_eq!(qc.verify(&committee, quorum_size(committee.len()), ok), Err("qc_below_quorum"));
        assert!(qc.verify(&committee, relaxed_quorum(committee.len()), ok).is_ok());
        // A zero threshold is still refused — an unset committee must never make one vote a QC.
        assert_eq!(qc.verify(&committee, 0, ok), Err("qc_below_quorum"));
    }

    #[test]
    fn same_index_conflict_forces_a_double_signer() {
        // Quorum-intersection lemma: any two relaxed quorums over one committee share a member. This
        // is what makes a SAME-INDEX conflict attributable; the pin no longer forces same-index, so
        // per-window attribution needs a per-window vote rule in the engine before it can be claimed.
        // Two relaxed quorums over a fixed committee then share >=1 member, who signed two different
        // messages at the same index — exactly the shape VoteEquivocationProof attributes.
        for n in RELAXED_MIN_COMMITTEE..=200usize {
            let t = relaxed_quorum(n);
            let a: std::collections::HashSet<usize> = (0..t).collect();
            let b: std::collections::HashSet<usize> = (n - t..n).collect();
            let shared = a.intersection(&b).count();
            assert!(shared >= 2 * t - n, "n={} t={}", n, t);
            assert!(shared >= 1, "two relaxed quorums must share a signer at n={}", n);
        }
    }

    // CROSS-LANGUAGE PARITY VECTOR. These hex strings were produced by the shipped React Native light
    // client (applications/qnet-mobile/src/crypto/QcLightClient.js, checkpointHash) over the identical
    // checkpoint. The device recomputes this hash and verifies the QC against it, so ANY drift between
    // the two implementations — field order, the recovery_anchor tag byte, u64 endianness — stops every
    // wallet confirming while the chain runs happily. The tag byte is written UNCONDITIONALLY, so an
    // ordinary unpinned checkpoint is covered by the `none` vector too, not just the pinned ones.
    #[test]
    fn checkpoint_hash_matches_the_mobile_client_byte_for_byte() {
        let base = Checkpoint {
            index: 4, parent_qc: Some(QcRef { index: 3, checkpoint_hash: h(2) }),
            window_head_height: 120, window_mb_hashes: vec![h(1)], state_root: h(3), beacon: h(4),
            epoch_commitment: h(5), reward_root: h(0), registry_root: h(0), logs_root: h(0),
            dilithium_pk_root: h(0), reward_epoch_root: h(0), total_supply: 7, timestamp: 11,
            proposer: "n1".into(), proposer_sig: vec![1], recovery_anchor: None,
        };
        let mut pinned = base.clone(); pinned.recovery_anchor = Some((2, h(8)));
        let mut zero_pin = base.clone(); zero_pin.recovery_anchor = Some((0, h(0)));

        assert_eq!(hex::encode(base.hash()),
                   "13fe6687b356572863ca25a3d0c225a30b904a03f5fed4a8574b22a80bf29be7");
        assert_eq!(hex::encode(pinned.hash()),
                   "acc2f0a5102a91fc013b9e6f023ba77aa4843a2f056a2d97aa57ea1302993474");
        assert_eq!(hex::encode(zero_pin.hash()),
                   "8a463e680bb577b1ffb0569f2f4576bae6d23d7a1b2a92fa7e5e6c9428bf14f7");

        // The device mirrors quorum_size and judges EVERY checkpoint at it; the relaxed threshold
        // exists only here, and a checkpoint carrying an anchor is refused on both sides.
        assert_eq!(quorum_size(1000), 667);
        assert_eq!(relaxed_quorum(1000), 501);
        assert_eq!(relaxed_quorum(5), 4);
        assert_eq!(recovery_window_head(630, 3), 720);

        // Same checkpoint under checkpoint_content_digest — mirrored in
        // applications/qnet-mobile/__tests__/QcLightClient.test.js. Unlike hash() it length-prefixes
        // window_mb_hashes, so it needs its own vector.
        assert_eq!(hex::encode(checkpoint_content_digest(&base)),
                   "5b9d0304967b92246400630f54df59d6ee2ae7388aa8cf0b7c25dd8d7360eba1");
        // Position fields AND the pin are excluded: a legal re-proposal of one window at a new
        // index/proposer, and the pinned re-proposal of that same window, must digest identically —
        // that is what makes the one-content-per-head rule votable and the pin resolvable from
        // whichever certificate for the anchor window a node happens to hold.
        let mut moved = base.clone();
        moved.index = 9; moved.proposer = "n2".into();
        moved.parent_qc = Some(QcRef { index: 8, checkpoint_hash: h(9) });
        assert_eq!(checkpoint_content_digest(&moved), checkpoint_content_digest(&base));
        assert_eq!(checkpoint_content_digest(&pinned), checkpoint_content_digest(&base));
        assert_eq!(checkpoint_content_digest(&zero_pin), checkpoint_content_digest(&base));
        // ...while hash() still folds the pin, so the QC signatures cover it and a pin cannot be
        // pasted onto a certificate that was gathered without one.
        assert_ne!(pinned.hash(), base.hash());
    }

    #[test]
    fn no_signer_set_enters_the_checkpoint_preimage() {
        // The whole design rests on this: two DIFFERENT valid signer subsets sign the IDENTICAL
        // message and produce the IDENTICAL checkpoint hash, so byte-divergent QC blobs across
        // sealers stay tolerated exactly as before.
        let cp = Checkpoint {
            index: 4, parent_qc: Some(QcRef { index: 3, checkpoint_hash: h(2) }),
            window_head_height: 120, window_mb_hashes: vec![h(1)], state_root: h(3), beacon: h(4),
            epoch_commitment: h(5), reward_root: h(0), registry_root: h(0), logs_root: h(0),
            dilithium_pk_root: h(0), reward_epoch_root: h(0), total_supply: 7, timestamp: 11,
            proposer: "n1".into(), proposer_sig: vec![1], recovery_anchor: Some((2, h(8))),
        };
        let want = cp.hash();
        let mk = |ids: &[&str]| {
            let signers: Vec<NodeId> = ids.iter().map(|s| s.to_string()).collect();
            let sigs: Vec<Vec<u8>> = signers.iter().map(|s| s.as_bytes().to_vec()).collect();
            QuorumCertificate { checkpoint_hash: cp.hash(), index: cp.index,
                                sig_merkle_root: sig_merkle_root(&sigs), signers, sigs }
        };
        let q1 = mk(&["n0", "n1", "n2", "n3", "n4", "n5"]);
        let q2 = mk(&["n4", "n5", "n6", "n7", "n8", "n9"]);
        assert_ne!(q1.sig_merkle_root, q2.sig_merkle_root, "the subsets really are different");
        assert_eq!(q1.checkpoint_hash, want);
        assert_eq!(q2.checkpoint_hash, want);
        assert_eq!(cp.hash(), want, "hashing is not affected by who signed");
    }
}

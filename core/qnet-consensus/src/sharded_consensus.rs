//! v15.10 STAGE-2B — Per-shard consensus committees
//! ════════════════════════════════════════════════════════════════════════════
//!
//! ⚠ DEACTIVATED — DORMANT SCAFFOLDING (NOT FOR PRODUCTION USE) ⚠
//! ────────────────────────────────────────────────────────────────────────────
//! QNet's current architectural decision is to stay SINGLE-SHARD: with the
//! 1 000-validator-per-round VRF cap, splitting into many shards would
//! produce per-shard committees of 4-8 validators, which is too thin for
//! safe BFT (one Byzantine actor per shard wins). At expected user-base
//! scale (≤ 100 M active wallets) the single-shard 50 K TPS ceiling is
//! sufficient — the right scaling lever is "bigger microblocks +
//! parallel intra-block execution", not consensus partitioning.
//!
//! This module REMAINS in the codebase as ready-to-revisit scaffolding:
//!   * `account_shard_index` and the assignment helpers are deterministic
//!     and tested,
//!   * `ShardCommitteeCache::global()` exists but is never `install`-ed
//!     in production paths,
//!   * `compute_shard_aware_leader_for_round` falls back to the global
//!     round-robin when the cache is empty (the production path).
//!
//! To re-activate: install a `ShardCommitteeAssignment` with `num_shards
//! > 1` into the global cache at every epoch boundary, restructure
//! `MacroBlock` to carry per-shard sub-blocks, and re-introduce the
//! `CrossShard*` transaction variants that were removed in v15.10.
//! None of that is wired today.
//! ════════════════════════════════════════════════════════════════════════════
//!
//! Stage 2B is the foundation that turns Stage 2A's deterministic shard
//! assignment into a real throughput multiplier: instead of a single global
//! 2f+1 quorum signing every macroblock, the active validator set is
//! stratified into N independent sub-committees, one per shard, each
//! running its own Checkpoint-BFT flow in parallel.
//!
//! WHAT THIS MODULE DELIVERS (Stage-2B foundation)
//! ────────────────────────────────────────────────────────────────────────────
//!   * `ShardCommittee` — the canonical per-shard validator set for a given
//!     epoch. Deterministic + every honest node computes the same value
//!     from the same `(epoch_seed, validators, num_shards)` input.
//!   * `assign_committees` — VRF-stratified assignment that distributes a
//!     sorted validator list across N shards uniformly. Idempotent,
//!     stateless, ordered.
//!   * `compute_shard_leader` — per-shard, per-round leader rotation that
//!     mirrors the global `compute_leader_for_round` semantics but
//!     operates on a single shard's committee.
//!   * `MIN_VALIDATORS_PER_SHARD` — safety floor: when the active
//!     validator count cannot support `num_shards × MIN_VALIDATORS_PER_SHARD`
//!     committees, the assignment helper falls back to a single shard
//!     (degraded mode) so liveness is preserved on small networks.
//!
//! WHAT IT DOES *NOT* YET DELIVER
//! ────────────────────────────────────────────────────────────────────────────
//! Wiring this scaffold into the live Checkpoint-BFT path is the second
//! half of Stage 2B and lives outside this module — it touches:
//!   * the per-microblock producer-rotation tick (currently global,
//!     becomes per-shard parallel),
//!   * the macroblock structure (today a single 2f+1 attestation set,
//!     post-2B it carries a vector of per-shard sub-blocks plus a
//!     global "stitching" macroblock signed by the union of shard
//!     committees),
//!   * the timeout-certificate aggregator (today a single global
//!     `AggregatedTimeoutCertificate`, post-2B one per shard).
//!
//! The consensus engine itself does NOT change — every shard runs
//! Checkpoint-BFT against its own committee. That keeps the guarantees
//! of the canonical path (ML-DSA-65 + n−f QC + view-change) intact at
//! the per-shard level.
//!
//! SCALABILITY (1 000+ super-node committees, target 100M+ users)
//! ────────────────────────────────────────────────────────────────────────────
//! The 1 000-validator cap is a global-committee constraint. Once the
//! validator set is partitioned across N shards, each sub-committee
//! is bounded by `1 000 / N`, which keeps:
//!   * per-shard signature aggregation linear in committee size
//!     (≤ 1 000 / N ML-DSA-65 sigs per shard sub-block);
//!   * per-shard produce/verify cost bounded by the same factor;
//!   * gossip/sync bandwidth per shard scaled by the same factor.
//! Total network capacity scales with N (modulo cross-shard 2PC
//! overhead — that lives in Stage 2C).
//!
//! DETERMINISM IS THE INVARIANT
//! ────────────────────────────────────────────────────────────────────────────
//! Every consumer of this module — block validator, fork resolver,
//! reputation engine, leader-schedule cache — must compute identical
//! committee assignments from identical inputs. That is enforced by:
//!   * `validators` input must be deterministically sorted by the caller
//!     (we re-sort defensively but the canonical input is sorted),
//!   * `epoch_seed` is a 32-byte hash of the epoch's anchor data
//!     (caller's responsibility — typically `Sha3_256(beacon || epoch)`),
//!   * the assignment algorithm uses Blake3 keyed by `(validator_id, epoch_seed)`
//!     so a single bit flip in either input rotates the entire mapping
//!     deterministically.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use parking_lot::RwLock;

/// Minimum validators per shard committee — the BFT floor. With fewer
/// than this many validators, 2f+1 cannot tolerate any byzantine node;
/// we fall back to a single shard (degraded mode) instead of producing
/// committees that cannot reach safety.
///
/// Value 4 = canonical "3f+1 with f=1" minimum. Operators on testnets
/// running 5-validator genesis sets stay in single-shard mode until the
/// active super-node count grows enough to support multi-shard.
pub const MIN_VALIDATORS_PER_SHARD: usize = 4;

/// Per-shard committee at a fixed epoch — the deterministic mapping
/// from a validator's node_id to the shard whose consensus it
/// participates in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShardCommittee {
    pub shard_id: u32,
    pub epoch: u64,
    /// Validator node_ids in this committee, sorted ascending for
    /// canonical iteration. Size: `total_validators / num_shards`
    /// ± 1 (load is balanced to within one validator).
    pub validators: Vec<String>,
}

impl ShardCommittee {
    /// 2f+1 BFT threshold for this committee. Matches the canonical
    /// formula used elsewhere in the codebase.
    pub fn two_f_plus_one(&self) -> usize {
        let n = self.validators.len();
        ((n.saturating_mul(2)).saturating_add(2)) / 3
    }

    /// True iff `validator_id` is a member of this committee.
    /// Linear scan — committees are small (≤ 1 000 / N).
    pub fn contains(&self, validator_id: &str) -> bool {
        self.validators.iter().any(|v| v == validator_id)
    }
}

/// Full committee assignment for an epoch: one `ShardCommittee` per
/// shard, ordered by `shard_id` ascending. This is the consensus-
/// canonical artefact every node must agree on for Stage-2B liveness
/// and safety to hold.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShardCommitteeAssignment {
    pub epoch: u64,
    pub num_shards: u32,
    pub committees: Vec<ShardCommittee>,
}

impl ShardCommitteeAssignment {
    /// Look up the committee whose `shard_id` matches. O(N) scan over
    /// at most `MAX_SHARDS = 256` entries — fast, branch-free.
    pub fn committee_for(&self, shard_id: u32) -> Option<&ShardCommittee> {
        self.committees.iter().find(|c| c.shard_id == shard_id)
    }

    /// Look up the shard a given validator is assigned to in this
    /// epoch. Returns `None` if the validator is not in any committee
    /// (degraded mode, eviction since assignment, etc.).
    pub fn shard_for_validator(&self, validator_id: &str) -> Option<u32> {
        for c in &self.committees {
            if c.contains(validator_id) {
                return Some(c.shard_id);
            }
        }
        None
    }

    /// Total number of validators across all committees. Useful for
    /// invariant checks and metrics.
    pub fn total_validators(&self) -> usize {
        self.committees.iter().map(|c| c.validators.len()).sum()
    }
}

/// Assign a sorted set of validator node_ids to N shards using a
/// VRF-stratified, deterministic algorithm.
///
/// Algorithm
/// ────────────────────────────────────────────────────────────────────
///   1. Defensive sort: produce a stable canonical ordering of the
///      input list so the assignment is robust against caller bugs.
///   2. Compute per-validator priority key: `Blake3(validator_id || epoch_seed)`.
///      The leading 8 bytes of the digest are interpreted as a `u64`,
///      giving each validator a pseudo-random rank.
///   3. Sort validators by their priority key, breaking ties on
///      validator_id to keep ordering deterministic.
///   4. Distribute by index modulo `num_shards`: the first ranked
///      validator goes to shard 0, the second to shard 1, …,
///      validator at rank `i` goes to shard `i % num_shards`.
///      This guarantees committee sizes balance to within ±1.
///   5. Within each committee, sort validators ascending by
///      validator_id for canonical iteration.
///
/// Determinism
/// ────────────────────────────────────────────────────────────────────
/// Same `(validators, num_shards, epoch_seed)` tuple → identical
/// `ShardCommitteeAssignment` on every honest node. The Blake3 keying
/// makes the assignment non-game-able by validators who cannot
/// influence `epoch_seed` (it is committed earlier in the chain).
///
/// Degraded mode
/// ────────────────────────────────────────────────────────────────────
/// If `validators.len() < num_shards × MIN_VALIDATORS_PER_SHARD`, the
/// helper returns a SINGLE-SHARD assignment (`num_shards = 1`) with
/// every validator in committee 0. This preserves liveness on small
/// networks; operators see this in logs and can defer raising the
/// shard count until the validator set grows.
pub fn assign_committees(
    validators: &[String],
    num_shards: u32,
    epoch: u64,
    epoch_seed: &[u8; 32],
) -> ShardCommitteeAssignment {
    // Step 0: clamp num_shards to at least 1.
    let num_shards = num_shards.max(1);

    // Step 1: defensive canonical sort of the validator list.
    let mut sorted: Vec<String> = validators.iter().cloned().collect();
    sorted.sort();
    sorted.dedup();

    let total = sorted.len();
    let min_required = (num_shards as usize).saturating_mul(MIN_VALIDATORS_PER_SHARD);

    // Step 2: degraded-mode fallback if the validator count can't
    // sustain the requested shard count under the BFT floor.
    if num_shards == 1 || total < min_required {
        return ShardCommitteeAssignment {
            epoch,
            num_shards: 1,
            committees: vec![ShardCommittee {
                shard_id: 0,
                epoch,
                validators: sorted,
            }],
        };
    }

    // Step 3: per-validator priority key derived from epoch_seed +
    // validator_id. Blake3 is keyless here (we mix the seed into the
    // input) — same hash family used elsewhere in the codebase.
    let mut keyed: Vec<(u64, String)> = sorted
        .into_iter()
        .map(|vid| {
            let mut buf = Vec::with_capacity(vid.len() + 32);
            buf.extend_from_slice(vid.as_bytes());
            buf.extend_from_slice(epoch_seed);
            let h = blake3::hash(&buf);
            let bytes = h.as_bytes();
            let priority = u64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3],
                bytes[4], bytes[5], bytes[6], bytes[7],
            ]);
            (priority, vid)
        })
        .collect();

    // Step 4: sort by priority (asc); ties broken on validator_id (asc)
    // so the result is fully deterministic when two validators happen
    // to share the same Blake3 leading-u64 (probability ~ 2^-64).
    keyed.sort_by(|a, b| {
        a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1))
    });

    // Step 5: distribute by index modulo num_shards, then sort each
    // committee's validators alphabetically for canonical iteration.
    let mut buckets: Vec<Vec<String>> = (0..num_shards).map(|_| Vec::new()).collect();
    for (i, (_, vid)) in keyed.into_iter().enumerate() {
        let target = (i as u32) % num_shards;
        buckets[target as usize].push(vid);
    }

    let committees: Vec<ShardCommittee> = buckets
        .into_iter()
        .enumerate()
        .map(|(i, mut vs)| {
            vs.sort();
            ShardCommittee {
                shard_id: i as u32,
                epoch,
                validators: vs,
            }
        })
        .collect();

    ShardCommitteeAssignment {
        epoch,
        num_shards,
        committees,
    }
}

/// Per-shard, per-round leader rotation. Within `committee`, the leader
/// for `round` is the validator at position `(base_idx + round) % size`,
/// where `base_idx` is a deterministic seed-and-shard-mixed offset.
///
/// This mirrors the global producer rotation but operates on the
/// shard's committee. Same epoch_seed is mixed in so
/// rotations across shards are independent (a validator that's leader of
/// shard 5 round 0 is generally NOT leader of shard 7 round 0).
pub fn compute_shard_leader<'a>(
    committee: &'a ShardCommittee,
    round: u64,
    epoch_seed: &[u8; 32],
) -> Option<&'a str> {
    if committee.validators.is_empty() {
        return None;
    }
    let mut buf = Vec::with_capacity(8 + 32 + 4);
    buf.extend_from_slice(&committee.epoch.to_le_bytes());
    buf.extend_from_slice(epoch_seed);
    buf.extend_from_slice(&committee.shard_id.to_le_bytes());
    let h = blake3::hash(&buf);
    let base_idx = u64::from_le_bytes([
        h.as_bytes()[0], h.as_bytes()[1], h.as_bytes()[2], h.as_bytes()[3],
        h.as_bytes()[4], h.as_bytes()[5], h.as_bytes()[6], h.as_bytes()[7],
    ]);
    let n = committee.validators.len() as u64;
    let idx = ((base_idx.wrapping_add(round)) % n) as usize;
    Some(committee.validators[idx].as_str())
}

/// In-memory cache for the current epoch's committee assignment so that
/// per-microblock producer queries don't re-run the assignment algorithm
/// 90 times per macroblock. Mounted as a process-wide singleton in
/// production; tests construct fresh instances.
///
/// SCALABILITY
/// ────────────────────────────────────────────────────────────────────
/// At 1 000+ super-node committees, the full assignment runs once per
/// epoch (typically ~ macroblock cycle = 4 hours). Cached assignment is
/// read-only by every consensus path until the epoch boundary advances
/// it. Read uses an `RwLock` (parking_lot, fast path is uncontended).
pub struct ShardCommitteeCache {
    current: RwLock<Option<Arc<ShardCommitteeAssignment>>>,
}

impl ShardCommitteeCache {
    pub fn new() -> Self {
        Self {
            current: RwLock::new(None),
        }
    }

    /// Replace the cached assignment. Called once per epoch when the
    /// chain advances past an epoch boundary.
    pub fn install(&self, assignment: Arc<ShardCommitteeAssignment>) {
        *self.current.write() = Some(assignment);
    }

    /// Cheap read of the current assignment. None until the first
    /// `install` call.
    pub fn current(&self) -> Option<Arc<ShardCommitteeAssignment>> {
        self.current.read().clone()
    }

    /// Convenience: shard for `validator_id` under the current
    /// assignment, or None if no assignment is installed or the
    /// validator is not in any committee.
    pub fn shard_for_validator(&self, validator_id: &str) -> Option<u32> {
        let guard = self.current.read();
        guard.as_ref().and_then(|a| a.shard_for_validator(validator_id))
    }
}

impl Default for ShardCommitteeCache {
    fn default() -> Self {
        Self::new()
    }
}

// ════════════════════════════════════════════════════════════════════════════
// v15.10 STAGE-2B: PROCESS-WIDE SHARD COMMITTEE CACHE
// ────────────────────────────────────────────────────────────────────────────
// One cache instance per process — populated by the macroblock-finalisation
// path at every epoch boundary, queried by `compute_shard_aware_leader_for_round`
// and the cross-shard 2PC coordinator. Lazily constructed on first access
// to avoid pulling in `once_cell` initialisation cost on the legacy path.
//
// The cache is `Send + Sync` because every field is wrapped in
// parking_lot's `RwLock`; reads are uncontended at steady state.
// ════════════════════════════════════════════════════════════════════════════

static GLOBAL_SHARD_CACHE: std::sync::OnceLock<ShardCommitteeCache> = std::sync::OnceLock::new();

impl ShardCommitteeCache {
    /// Process-wide singleton accessor. Every call returns the same
    /// cache instance; install / current operate on shared state.
    pub fn global() -> &'static ShardCommitteeCache {
        GLOBAL_SHARD_CACHE.get_or_init(ShardCommitteeCache::new)
    }
}

// ════════════════════════════════════════════════════════════════════════════
// v15.10 STAGE-2B: COMMITTEE ASSIGNMENT TESTS
// ────────────────────────────────────────────────────────────────────────────
// Pin the deterministic-assignment invariants the consensus path will
// rely on once Stage-2B activates per-shard producer rotation:
//   * deterministic — same input always produces the same assignment,
//   * partition — every validator lands in exactly one committee,
//   * balance — committee sizes differ by at most 1,
//   * size floor — degraded-mode fallback when the input is too small
//     to support N shards × MIN_VALIDATORS_PER_SHARD.
// ════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests {
    use super::*;

    fn validators(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("v{:04}", i)).collect()
    }

    fn seed() -> [u8; 32] {
        let mut s = [0u8; 32];
        for i in 0..32 { s[i] = i as u8; }
        s
    }

    #[test]
    fn test_assignment_deterministic() {
        let vs = validators(120);
        let s = seed();
        let a = assign_committees(&vs, 8, 42, &s);
        let b = assign_committees(&vs, 8, 42, &s);
        assert_eq!(a, b, "same input must produce identical assignment");
    }

    #[test]
    fn test_assignment_partitions_all_validators() {
        let vs = validators(200);
        let s = seed();
        let a = assign_committees(&vs, 16, 7, &s);
        // Every validator appears in exactly one committee.
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for c in &a.committees {
            for v in &c.validators {
                assert!(seen.insert(v.clone()), "validator {} appears twice", v);
            }
        }
        assert_eq!(seen.len(), vs.len(), "every validator placed");
        assert_eq!(a.total_validators(), vs.len());
    }

    #[test]
    fn test_assignment_balanced_within_one() {
        let vs = validators(200);
        let s = seed();
        let a = assign_committees(&vs, 16, 7, &s);
        let sizes: Vec<usize> = a.committees.iter().map(|c| c.validators.len()).collect();
        let max = *sizes.iter().max().unwrap();
        let min = *sizes.iter().min().unwrap();
        assert!(max - min <= 1, "committee sizes diverge: min={} max={} sizes={:?}", min, max, sizes);
    }

    #[test]
    fn test_assignment_falls_back_to_single_shard_when_too_small() {
        // 10 validators / 8 shards × 4 min = 32 required → fall back.
        let vs = validators(10);
        let s = seed();
        let a = assign_committees(&vs, 8, 1, &s);
        assert_eq!(a.num_shards, 1);
        assert_eq!(a.committees.len(), 1);
        assert_eq!(a.committees[0].validators.len(), 10);
    }

    #[test]
    fn test_assignment_seed_change_rotates_mapping() {
        let vs = validators(64);
        let mut s1 = seed();
        let mut s2 = seed();
        s2[0] = s2[0].wrapping_add(1);
        let a = assign_committees(&vs, 4, 1, &s1);
        let b = assign_committees(&vs, 4, 1, &s2);
        // Shard for at least one validator must differ — Blake3 is
        // avalanche, single bit flip in seed reshuffles ranks.
        let differ = vs.iter().any(|v| {
            a.shard_for_validator(v) != b.shard_for_validator(v)
        });
        assert!(differ, "seed change must rotate at least one validator's shard");
        // suppress unused-mut warnings on s1
        let _ = &mut s1;
    }

    #[test]
    fn test_assignment_dedups_repeated_input() {
        let mut vs = validators(50);
        // Insert duplicates — assignment must dedup defensively.
        vs.push("v0000".to_string());
        vs.push("v0001".to_string());
        let s = seed();
        let a = assign_committees(&vs, 4, 1, &s);
        assert_eq!(a.total_validators(), 50, "duplicates dedup'd");
    }

    #[test]
    fn test_assignment_min_validators_floor() {
        // Exactly at the floor: 32 validators, 8 shards × 4 min = 32 → OK.
        let vs = validators(32);
        let s = seed();
        let a = assign_committees(&vs, 8, 1, &s);
        assert_eq!(a.num_shards, 8);
        for c in &a.committees {
            assert_eq!(c.validators.len(), 4, "exact floor should yield 4 per committee");
        }
    }

    #[test]
    fn test_committee_two_f_plus_one() {
        // Per-shard 2f+1 calculation matches the global formula.
        for (n, expected) in [(4usize, 3usize), (10, 7), (100, 67), (333, 222)] {
            let c = ShardCommittee {
                shard_id: 0,
                epoch: 0,
                validators: validators(n),
            };
            assert_eq!(c.two_f_plus_one(), expected, "N={}", n);
        }
    }

    #[test]
    fn test_compute_shard_leader_deterministic() {
        let c = ShardCommittee {
            shard_id: 3,
            epoch: 7,
            validators: validators(10),
        };
        let s = seed();
        let l1 = compute_shard_leader(&c, 5, &s).unwrap().to_string();
        let l2 = compute_shard_leader(&c, 5, &s).unwrap().to_string();
        assert_eq!(l1, l2);
    }

    #[test]
    fn test_compute_shard_leader_rotates_per_round() {
        let c = ShardCommittee {
            shard_id: 0,
            epoch: 1,
            validators: validators(8),
        };
        let s = seed();
        // Across N rounds (where N == committee size) every validator
        // must be leader exactly once — round-robin invariant.
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for r in 0..(c.validators.len() as u64) {
            let leader = compute_shard_leader(&c, r, &s).unwrap().to_string();
            seen.insert(leader);
        }
        assert_eq!(seen.len(), c.validators.len(), "every validator becomes leader exactly once");
    }

    #[test]
    fn test_compute_shard_leader_independent_across_shards() {
        // Two committees with the same validator set but different
        // shard_ids must produce different leader rotations (because
        // shard_id is mixed into the Blake3 input).
        let vs = validators(16);
        let s = seed();
        let c0 = ShardCommittee { shard_id: 0, epoch: 1, validators: vs.clone() };
        let c1 = ShardCommittee { shard_id: 1, epoch: 1, validators: vs };
        let l0 = compute_shard_leader(&c0, 0, &s).unwrap().to_string();
        let l1 = compute_shard_leader(&c1, 0, &s).unwrap().to_string();
        assert_ne!(l0, l1, "different shards must rotate independently");
    }

    #[test]
    fn test_committee_cache_install_and_read() {
        let cache = ShardCommitteeCache::new();
        assert!(cache.current().is_none());
        let a = assign_committees(&validators(64), 4, 1, &seed());
        cache.install(Arc::new(a.clone()));
        let got = cache.current().unwrap();
        assert_eq!(got.epoch, a.epoch);
        assert_eq!(got.num_shards, a.num_shards);
    }

    #[test]
    fn test_committee_cache_shard_for_validator() {
        let cache = ShardCommitteeCache::new();
        let vs = validators(64);
        let a = assign_committees(&vs, 4, 1, &seed());
        cache.install(Arc::new(a.clone()));
        // Pick a known validator and verify the cache's lookup matches
        // the assignment's lookup.
        let target = &vs[7];
        assert_eq!(
            cache.shard_for_validator(target),
            a.shard_for_validator(target),
        );
    }
}

//! Weighted Fork Choice — Cumulative Attestation Chain Weight
//!
//! ═══════════════════════════════════════════════════════════════════════════════
//! ARCHITECTURE — LATEST-MESSAGE-DRIVEN GREEDY HEAVIEST OBSERVED SUBTREE
//! ═══════════════════════════════════════════════════════════════════════════════
//!
//! This module implements the per-block fork choice rule used between macroblock
//! finality boundaries. Macroblock finality is anchored every 90 blocks via 2f+1
//! commit-reveal supermajority. Between those anchors, microblock production is
//! single-leader and forks are possible during partition / propagation gap.
//!
//! The fork choice rule selects the canonical chain head as the descendant of
//! the latest finalized macroblock with the maximum cumulative attestation
//! weight along its history. Properties:
//!
//!   * SAFETY — A minority partition's chain accumulates fewer attestations
//!     because the attestation committee membership is deterministic and
//!     attestation gossip reaches a supermajority over time. When partitions
//!     heal, the minority chain has strictly less weight and is abandoned
//!     by every honest node.
//!
//!   * LIVENESS — Fork choice runs every microblock, not on a periodic check.
//!     Detection of a heavier chain is immediate, bounded only by attestation
//!     propagation latency (~1 RTT). No reactive 5-block witness threshold,
//!     no rollback storms.
//!
//!   * MONOTONICITY — Once a block has accumulated 2f+1 distinct attestations,
//!     no honest fork can outweigh it without controlling 2f+1 keys, which
//!     exceeds the Byzantine bound by definition.
//!
//! ═══════════════════════════════════════════════════════════════════════════════
//! WEIGHT CALCULATION
//! ═══════════════════════════════════════════════════════════════════════════════
//!
//! Given a chain head H at height h_H and a finalized ancestor F at height h_F:
//!
//!   weight(H) = Σ |attestations(block_at_height_i)|   for h_F < i ≤ h_H
//!
//! where |attestations(B)| is the number of distinct, signature-verified
//! attestations for block B specifically (matched on (height, hash) pair).
//!
//! ═══════════════════════════════════════════════════════════════════════════════
//! SCALE & PERFORMANCE
//! ═══════════════════════════════════════════════════════════════════════════════
//!
//! At committee_size=128 (cap), weight per block is bounded at 128. Walking
//! 90 blocks (one macroblock window) is at most 90 hash lookups — sub-millisecond.
//! At committee_size=32 (medium networks), even less.
//!
//! Recomputation triggered by:
//!   * New attestation received → weight may have changed for that block.
//!   * New block at tip → potential new head candidate.
//!   * Reorg signal → forced reevaluation.

use std::collections::HashMap;

/// Result of a chain weight evaluation for fork choice decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainWeight {
    /// Tip block hash this weight applies to.
    pub head_hash: [u8; 32],
    /// Tip height.
    pub head_height: u64,
    /// Cumulative attestation count along the chain from finalized ancestor to tip.
    pub total_weight: u64,
    /// Number of microblocks contributing to the weight (i.e. distance from finalized).
    pub depth: u64,
}

impl ChainWeight {
    /// Average attestations per block — useful for diagnostics.
    pub fn avg_per_block(&self) -> f64 {
        if self.depth == 0 {
            return 0.0;
        }
        self.total_weight as f64 / self.depth as f64
    }
}

/// A candidate chain head with its block-by-block hash chain.
///
/// `hashes_by_height` MUST contain every block hash from `(finalized_height + 1)`
/// up to and including `head_height`. Missing entries cause the candidate to
/// be excluded from fork choice (treated as unknown chain).
#[derive(Debug, Clone)]
pub struct ChainCandidate {
    pub head_hash: [u8; 32],
    pub head_height: u64,
    pub hashes_by_height: HashMap<u64, [u8; 32]>,
}

/// Compute the cumulative attestation weight for one chain candidate.
///
/// `attestations_for` is a closure: given (height, hash) returns the
/// number of distinct, signature-verified attestations for that block.
/// This is typically a wrapper around the global `BLOCK_ATTESTATIONS` store.
///
/// Returns None if the chain is incomplete (any height in range is missing).
pub fn compute_chain_weight<F>(
    candidate: &ChainCandidate,
    finalized_height: u64,
    attestations_for: F,
) -> Option<ChainWeight>
where
    F: Fn(u64, &[u8; 32]) -> u64,
{
    if candidate.head_height <= finalized_height {
        // Chain head is at or below finalized — degenerate, weight is zero.
        return Some(ChainWeight {
            head_hash: candidate.head_hash,
            head_height: candidate.head_height,
            total_weight: 0,
            depth: 0,
        });
    }

    let mut total: u64 = 0;
    let mut depth: u64 = 0;
    for h in (finalized_height + 1)..=candidate.head_height {
        let hash = candidate.hashes_by_height.get(&h)?;
        total = total.saturating_add(attestations_for(h, hash));
        depth = depth.saturating_add(1);
    }

    Some(ChainWeight {
        head_hash: candidate.head_hash,
        head_height: candidate.head_height,
        total_weight: total,
        depth,
    })
}

/// Pick the canonical head among multiple candidate chains.
///
/// Selection rule (in priority order):
///   1. Maximum cumulative attestation weight.
///   2. Tie-breaker: greater head height (longer chain).
///   3. Tie-breaker: lexicographically smallest head hash (deterministic
///      across nodes — same rule used elsewhere for fork tie-breaking).
///
/// Returns None if `candidates` is empty.
pub fn pick_canonical_head<F>(
    candidates: &[ChainCandidate],
    finalized_height: u64,
    attestations_for: F,
) -> Option<ChainWeight>
where
    F: Fn(u64, &[u8; 32]) -> u64 + Copy,
{
    candidates
        .iter()
        .filter_map(|c| compute_chain_weight(c, finalized_height, attestations_for))
        .max_by(|a, b| {
            a.total_weight
                .cmp(&b.total_weight)
                .then_with(|| a.head_height.cmp(&b.head_height))
                .then_with(|| b.head_hash.cmp(&a.head_hash))
            // Note: head_hash comparison is REVERSED so that the lexicographically
            // SMALLEST hash wins (max_by selects the maximum, so we invert).
        })
}

/// Determine whether to switch from current head to a competing candidate.
///
/// Conservative switch policy: only switch if the candidate has strictly
/// greater weight AND the weight difference exceeds a safety margin.
/// This prevents flapping on transient attestation gossip races.
///
/// Margin policy:
///   * If candidate.depth ≤ 10 (within finality window): require margin ≥ 1
///     (any concrete weight advantage is enough at low depth)
///   * Otherwise: require margin ≥ committee_size / 4 (one round-trip's
///     worth of attestations advantage to avoid flapping)
pub fn should_switch_head(
    current: &ChainWeight,
    candidate: &ChainWeight,
    committee_size: usize,
) -> bool {
    // Same head → no switch.
    if current.head_hash == candidate.head_hash && current.head_height == candidate.head_height {
        return false;
    }

    // Candidate must have strictly greater weight.
    if candidate.total_weight <= current.total_weight {
        return false;
    }

    let margin = candidate.total_weight - current.total_weight;
    let required_margin: u64 = if candidate.depth <= 10 {
        1
    } else {
        std::cmp::max(1, (committee_size / 4) as u64)
    };

    margin >= required_margin
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_hash(seed: u8) -> [u8; 32] {
        let mut h = [0u8; 32];
        h[0] = seed;
        h
    }

    #[test]
    fn weight_computes_correctly() {
        let mut hashes = HashMap::new();
        hashes.insert(101, mk_hash(1));
        hashes.insert(102, mk_hash(2));
        hashes.insert(103, mk_hash(3));

        let candidate = ChainCandidate {
            head_hash: mk_hash(3),
            head_height: 103,
            hashes_by_height: hashes,
        };

        let attest_for = |_height: u64, _hash: &[u8; 32]| 32u64;
        let w = compute_chain_weight(&candidate, 100, attest_for).unwrap();
        assert_eq!(w.total_weight, 96); // 3 blocks × 32 attestations
        assert_eq!(w.depth, 3);
    }

    #[test]
    fn missing_block_returns_none() {
        let mut hashes = HashMap::new();
        hashes.insert(101, mk_hash(1));
        // Missing 102!
        hashes.insert(103, mk_hash(3));

        let candidate = ChainCandidate {
            head_hash: mk_hash(3),
            head_height: 103,
            hashes_by_height: hashes,
        };

        let w = compute_chain_weight(&candidate, 100, |_, _| 32);
        assert!(w.is_none());
    }

    #[test]
    fn pick_canonical_picks_heaviest() {
        let mut hashes_a = HashMap::new();
        hashes_a.insert(101, mk_hash(0xAA));
        hashes_a.insert(102, mk_hash(0xAB));

        let mut hashes_b = HashMap::new();
        hashes_b.insert(101, mk_hash(0xBA));
        hashes_b.insert(102, mk_hash(0xBB));

        let cands = vec![
            ChainCandidate {
                head_hash: mk_hash(0xAB),
                head_height: 102,
                hashes_by_height: hashes_a,
            },
            ChainCandidate {
                head_hash: mk_hash(0xBB),
                head_height: 102,
                hashes_by_height: hashes_b,
            },
        ];

        // Chain B has heavier attestations
        let attest_for = |_h: u64, hash: &[u8; 32]| -> u64 {
            if hash[0] >= 0xBA { 50 } else { 30 }
        };

        let head = pick_canonical_head(&cands, 100, attest_for).unwrap();
        assert_eq!(head.head_hash, mk_hash(0xBB));
    }

    #[test]
    fn should_switch_requires_margin_at_depth() {
        let current = ChainWeight {
            head_hash: mk_hash(1),
            head_height: 200,
            total_weight: 1000,
            depth: 100,
        };
        let candidate_close = ChainWeight {
            head_hash: mk_hash(2),
            head_height: 200,
            total_weight: 1005,
            depth: 100,
        };
        // Margin of 5, but committee=32 means required margin = 8 → no switch
        assert!(!should_switch_head(&current, &candidate_close, 32));

        let candidate_strong = ChainWeight {
            head_hash: mk_hash(2),
            head_height: 200,
            total_weight: 1100,
            depth: 100,
        };
        // Margin of 100 ≥ 8 → switch
        assert!(should_switch_head(&current, &candidate_strong, 32));
    }

    #[test]
    fn should_switch_low_depth_any_margin() {
        let current = ChainWeight {
            head_hash: mk_hash(1),
            head_height: 105,
            total_weight: 100,
            depth: 5,
        };
        let candidate = ChainWeight {
            head_hash: mk_hash(2),
            head_height: 105,
            total_weight: 101,
            depth: 5,
        };
        // At depth ≤ 10, any margin > 0 is enough
        assert!(should_switch_head(&current, &candidate, 32));
    }
}

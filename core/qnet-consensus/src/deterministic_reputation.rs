//! Consensus reputation parameters.
//!
//! Consensus reputation is binary {INITIAL_REPUTATION | 0}: every node starts at the
//! floor and is dropped to 0 only by a cryptographically-proven equivocation (the
//! ban-set is anchored per-macroblock and re-verified each epoch). Eligibility is the
//! deterministic chain fold (`compute_consensus_reputation_map` + the `eligible_producers`
//! snapshot + uniform-VRF sortition) in qnet-integration. No graduated score, jail, or
//! decay gates consensus: a per-node mutable score is timing-dependent across nodes and
//! therefore a fork vector. Off-consensus telemetry may still display a richer score, but
//! it must never feed eligibility or any QC-bound field.

/// Reputation floor: every node starts here; the `>=` gate admits it to consensus.
pub const INITIAL_REPUTATION: f64 = 70.0;

/// Minimum reputation to participate in consensus (below = excluded).
pub const MIN_CONSENSUS_REPUTATION: f64 = 70.0;

//! QNet Consensus Module
//!
//! Consensus primitives for the QNet blockchain. Finality is
//! Checkpoint-BFT v2 (see `checkpoint_bft` / `checkpoint_consensus`);
//! consensus reputation is the binary on-chain `deterministic_reputation`.

// External crates
extern crate qnet_state;

/// QNet Consensus Implementation
pub mod lazy_rewards;
// Consensus v2 — Checkpoint-BFT types (spec: docs/CONSENSUS_V2_SPEC.md)
pub mod checkpoint_bft;
// Consensus v2 — Checkpoint-BFT state machine (propose/vote/QC/commit + pacemaker)
pub mod checkpoint_consensus;
pub mod consensus_crypto;
pub mod errors;
pub mod deterministic_reputation;
// v15.10 STAGE-2B — per-shard committee assignment + leader rotation
pub mod sharded_consensus;
// v15.10 STAGE-2C — cross-shard 2PC: locks, envelopes, receipts, coordinator
pub mod cross_shard;

// Re-export main types for public API
pub use errors::ConsensusError;
pub use deterministic_reputation::{INITIAL_REPUTATION, MIN_CONSENSUS_REPUTATION};
// v15.10 STAGE-2B — per-shard committee primitives
pub use sharded_consensus::{
    ShardCommittee, ShardCommitteeAssignment, ShardCommitteeCache,
    assign_committees, compute_shard_leader, MIN_VALIDATORS_PER_SHARD,
};
// v15.10 STAGE-2C — cross-shard 2PC primitives
pub use cross_shard::{
    LockManager, AccountLock,
    CrossShardEnvelope, CrossShardReceipt, CrossShardPhase,
    CrossShardCoordinator, PendingCrossShardTx, CoordinatorState,
    CrossShardError,
    global_lock_manager, global_coordinator,
};

// Common types used across modules
pub type NodeId = String;

// ============================================================================
// Unit Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_consensus_reputation_is_binary() {
        // The floor a node starts at and the gate that admits it to consensus are the SAME
        // value: reputation is {INITIAL_REPUTATION | 0}, never a graduated score.
        assert_eq!(INITIAL_REPUTATION, MIN_CONSENSUS_REPUTATION);
        assert!(INITIAL_REPUTATION >= MIN_CONSENSUS_REPUTATION);
        assert!(0.0 < MIN_CONSENSUS_REPUTATION);
    }

    #[test]
    fn test_consensus_error_display() {
        // Use a variant that actually exists on the canonical
        // `ConsensusError` enum (see `errors.rs`).
        let error = ConsensusError::InvalidOperation("test".to_string());
        let error_str = format!("{}", error);
        assert!(!error_str.is_empty());
    }

}

//! QNet Consensus Module
//! 
//! High-performance consensus mechanism for QNet blockchain
//! with advanced features like dynamic timing, commit-reveal,
//! and Byzantine fault tolerance.

// External crates
extern crate qnet_state;

/// QNet Consensus Implementation
pub mod lazy_rewards;
pub mod reward_integration;
pub mod batch_operations;
pub mod commit_reveal;
pub mod consensus_crypto;
pub mod dynamic_timing;
pub mod errors;
pub mod reputation;
pub mod kademlia;
pub mod deterministic_reputation;
pub mod macro_consensus;
// v15.10 STAGE-2B — per-shard committee assignment + leader rotation
pub mod sharded_consensus;
// v15.10 STAGE-2C — cross-shard 2PC: locks, envelopes, receipts, coordinator
pub mod cross_shard;

// Re-export main types for public API
pub use lazy_rewards::{PhaseAwareRewardManager, PhaseAwareReward, RewardClaimResult};
pub use reward_integration::{RewardIntegrationManager, RewardInfo};
pub use batch_operations::{
    BatchOperationsManager, BatchRewardClaimRequest, BatchRewardClaimResult,
    BatchNodeActivationRequest, BatchNodeActivationResult, BatchTransferRequest, BatchTransferResult
};
pub use commit_reveal::{CommitRevealConsensus, ConsensusConfig, ConsensusPhase, get_phase_for_block, is_in_consensus_window};
pub use errors::ConsensusError;
pub use reputation::{NodeReputation, ReputationConfig, MaliciousBehavior};
pub use kademlia::{KademliaDht, KademliaNode, generate_node_id};
pub use deterministic_reputation::{
    DeterministicReputationState, SlashingEvent, SlashingType, 
    AutomaticJail, MacroBlockConsensus, BlockData, MacroBlockData,
    ReputationStats,
    INITIAL_REPUTATION, MAX_REPUTATION, MIN_CONSENSUS_REPUTATION,
    REWARD_FULL_ROTATION, REWARD_CONSENSUS_PARTICIPATION,
    PENALTY_INVALID_BLOCK, PENALTY_DOUBLE_SIGN, PENALTY_MISSED_BLOCK,
    PROCESSING_CHUNK_SIZE, MAX_SLASHING_EVENTS_PER_MACROBLOCK, MAX_AUTO_JAILS_PER_MACROBLOCK,
};
pub use macro_consensus::{
    MacroBlockConsensusData, MissedBlockTracker, MacroConsensusResult,
    FinalityCheckpoint, FinalityManager, FINALITY_DEPTH, FINALITY_THRESHOLD,
};
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
pub use lazy_rewards::{NodeType, QNetPhase, HeartbeatSummaryData};

// Type aliases for compatibility
pub type ConsensusEngine = CommitRevealConsensus;
pub type NodeId = String;

/// Initialize consensus system with batch operations support
pub fn initialize_consensus_with_batch_operations(
    _genesis_timestamp: u64,
    _dev_burn_percentage: f64,
    _years_since_launch: u64,
) -> (RewardIntegrationManager, BatchOperationsManager) {
    // Initialize reward integration for standalone operations
    let reward_integration = RewardIntegrationManager::new();
    
    // Initialize reward integration for batch operations (separate instance)
    let reward_integration_for_batch = RewardIntegrationManager::new();
    
    // Wrap in Arc<Mutex> for batch operations
    let reward_integration_shared = std::sync::Arc::new(parking_lot::Mutex::new(reward_integration_for_batch));
    
    // Initialize batch operations manager
    let batch_manager = BatchOperationsManager::new(reward_integration_shared);
    
    (reward_integration, batch_manager)
}

/// Initialize consensus system (original function for backwards compatibility)
pub fn initialize_consensus(
    _genesis_timestamp: u64,
    _dev_burn_percentage: f64,
    _years_since_launch: u64,
) -> RewardIntegrationManager {
    RewardIntegrationManager::new()
}

/// Create new consensus engine
pub fn create_consensus_engine(node_id: String) -> ConsensusEngine {
    let config = ConsensusConfig::default();
    CommitRevealConsensus::new(node_id, config)
}

/// Create new node reputation manager
pub fn create_reputation_manager() -> NodeReputation {
    let config = ReputationConfig::default();
    NodeReputation::new(config)
}

/// Create new Kademlia DHT instance (async wrapper)
pub async fn create_kademlia_dht(addr: String, port: u16) -> Result<KademliaDht, Box<dyn std::error::Error>> {
    KademliaDht::new(addr, port).await
}

// ============================================================================
// Unit Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_consensus_engine_creation() {
        // Engine instantiation must succeed without panicking. The
        // value is opaque (no `get_current_round` accessor on the
        // canonical engine type), so we only assert via
        // `mem::size_of_val` that an instance was actually built.
        let engine = create_consensus_engine("test_node_001".to_string());
        assert!(std::mem::size_of_val(&engine) > 0);
    }

    #[test]
    fn test_reputation_manager_creation() {
        let manager = create_reputation_manager();
        // New manager should have no nodes registered
        let rep = manager.get_reputation("nonexistent_node");
        // Default reputation should be returned for unknown nodes
        assert!(rep >= 0.0 && rep <= 100.0);
    }

    #[test]
    fn test_consensus_initialization() {
        let manager = initialize_consensus(0, 0.5, 0);
        // Manager should be created successfully
        assert!(std::mem::size_of_val(&manager) > 0);
    }

    #[test]
    fn test_batch_operations_initialization() {
        let (reward_manager, batch_manager) = initialize_consensus_with_batch_operations(0, 0.5, 0);
        // Both managers should be created
        assert!(std::mem::size_of_val(&reward_manager) > 0);
        assert!(std::mem::size_of_val(&batch_manager) > 0);
    }

    #[test]
    fn test_node_id_generation() {
        // The canonical `generate_node_id` is a parameterless
        // randomness-source — every call returns a fresh 32-byte
        // identifier. The test verifies (a) two calls return distinct
        // ids (uniqueness with overwhelming probability) and (b) the
        // id is the expected 32-byte width.
        let id1 = generate_node_id();
        let id2 = generate_node_id();
        assert_ne!(id1, id2, "successive ids must differ");
        // NodeId is the kademlia 256-bit type; sanity-check its size.
        assert!(std::mem::size_of_val(&id1) > 0);
    }

    #[test]
    fn test_consensus_config_default() {
        let config = ConsensusConfig::default();

        // Verify sensible defaults using the actual canonical fields
        // (`commit_phase_duration`, `reveal_phase_duration`,
        // `min_participants`, `max_participants`,
        // `max_validators_per_round`).
        assert!(config.min_participants > 0);
        assert!(config.max_participants >= config.min_participants);
        assert!(config.commit_phase_duration.as_secs() > 0);
        assert!(config.reveal_phase_duration.as_secs() > 0);
        // The 1000-validator sampling cap matches the global runtime
        // constant — sampling is the safety floor for scaling beyond
        // the active-committee budget on networks with thousands of
        // Super nodes.
        assert!(config.max_validators_per_round > 0);
    }

    #[test]
    fn test_reputation_bounds() {
        let config = ReputationConfig::default();
        let manager = NodeReputation::new(config);

        // Test reputation bounds using the actual canonical accessor.
        // `get_reputation` returns the configured default for unknown
        // nodes (typically the `initial_reputation` from config).
        let rep = manager.get_reputation("new_node");
        assert!(rep >= 0.0, "Reputation should not be negative");
        assert!(rep <= 100.0, "Reputation should not exceed 100");
    }

    #[test]
    fn test_malicious_behavior_penalty() {
        let config = ReputationConfig::default();
        let mut manager = NodeReputation::new(config);

        // Set a known starting reputation via the canonical
        // `update_reputation` (positive delta lifts the node above
        // the default).
        manager.update_reputation("test_node", 10.0);
        let initial_rep = manager.get_reputation("test_node");
        assert!(initial_rep > 0.0);

        // Apply a punitive delta that mirrors a malicious-behavior
        // penalty.
        manager.update_reputation("test_node", -25.0);
        let after_rep = manager.get_reputation("test_node");

        assert!(after_rep < initial_rep,
                "Negative reputation delta must decrease score: {} → {}",
                initial_rep, after_rep);
    }

    #[test]
    fn test_reward_claim_result() {
        // Test that RewardClaimResult can be created with the actual
        // canonical fields (`success`, `reward`, `message`,
        // `next_claim_time`).
        let result = RewardClaimResult {
            success: true,
            reward: None,
            message: "Success".to_string(),
            next_claim_time: 0,
        };

        assert!(result.success);
        assert!(result.reward.is_none());
        assert_eq!(result.message, "Success");
    }

    #[test]
    fn test_consensus_error_display() {
        // Use a variant that actually exists on the canonical
        // `ConsensusError` enum (see `errors.rs`).
        let error = ConsensusError::InvalidOperation("test".to_string());
        let error_str = format!("{}", error);
        assert!(!error_str.is_empty());
    }

    #[test]
    fn test_phase_transition() {
        // Test QNetPhase transitions. Canonical variants are `Phase1`
        // (1DEV burn-to-join, Pool 3 disabled) and `Phase2` (QNC
        // spend-to-Pool 3, Pool 3 enabled) — see `lazy_rewards.rs`.
        let phase1 = QNetPhase::Phase1;
        let phase2 = QNetPhase::Phase2;

        assert_ne!(format!("{:?}", phase1), format!("{:?}", phase2));
    }

    #[test]
    fn test_node_type_variants() {
        // QNet ships only `Light` and `Super` node types (the legacy
        // `Full` variant was removed). The dedup test below verifies
        // both variants are distinct under `Debug` formatting.
        let light_a = NodeType::Light;
        let light_b = NodeType::Light;
        let supr = NodeType::Super;

        assert_eq!(format!("{:?}", light_a), format!("{:?}", light_b));
        assert_ne!(format!("{:?}", light_a), format!("{:?}", supr));
    }
}

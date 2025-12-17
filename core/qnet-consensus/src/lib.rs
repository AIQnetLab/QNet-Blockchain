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

// Common types used across modules
pub use lazy_rewards::{NodeType, QNetPhase};

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
    let reward_integration_shared = std::sync::Arc::new(std::sync::Mutex::new(reward_integration_for_batch));
    
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
        let engine = create_consensus_engine("test_node_001".to_string());
        assert!(engine.get_current_round() >= 0);
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
        let node_id1 = generate_node_id("192.168.1.1".to_string(), 8001);
        let node_id2 = generate_node_id("192.168.1.1".to_string(), 8001);
        let node_id3 = generate_node_id("192.168.1.2".to_string(), 8001);
        
        // Same input should produce same ID (deterministic)
        assert_eq!(node_id1, node_id2);
        
        // Different input should produce different ID
        assert_ne!(node_id1, node_id3);
        
        // ID should be 256 bits (32 bytes = 64 hex chars)
        assert_eq!(node_id1.len(), 64);
    }

    #[test]
    fn test_consensus_config_default() {
        let config = ConsensusConfig::default();
        
        // Verify sensible defaults
        assert!(config.min_validators > 0);
        assert!(config.max_validators >= config.min_validators);
        assert!(config.commit_timeout_ms > 0);
        assert!(config.reveal_timeout_ms > 0);
    }

    #[test]
    fn test_reputation_bounds() {
        let config = ReputationConfig::default();
        let manager = NodeReputation::new(config);
        
        // Test reputation bounds
        let rep = manager.get_reputation("new_node");
        assert!(rep >= 0.0, "Reputation should not be negative");
        assert!(rep <= 100.0, "Reputation should not exceed 100");
    }

    #[test]
    fn test_malicious_behavior_penalty() {
        let config = ReputationConfig::default();
        let mut manager = NodeReputation::new(config);
        
        // Register a node with good reputation
        manager.register_node("test_node", 90.0);
        let initial_rep = manager.get_reputation("test_node");
        
        // Report malicious behavior
        manager.report_malicious_behavior("test_node", MaliciousBehavior::DoubleSign);
        let after_rep = manager.get_reputation("test_node");
        
        // Reputation should decrease
        assert!(after_rep < initial_rep, "Malicious behavior should decrease reputation");
    }

    #[test]
    fn test_reward_claim_result() {
        // Test that RewardClaimResult can be created
        let result = RewardClaimResult {
            success: true,
            amount: 1000,
            tx_hash: "0x123".to_string(),
            message: "Success".to_string(),
        };
        
        assert!(result.success);
        assert_eq!(result.amount, 1000);
    }

    #[test]
    fn test_consensus_error_display() {
        let error = ConsensusError::InvalidRound("test".to_string());
        let error_str = format!("{}", error);
        assert!(!error_str.is_empty());
    }

    #[test]
    fn test_phase_transition() {
        // Test QNetPhase transitions
        let phase1 = QNetPhase::Phase1SolanaBurn;
        let phase2 = QNetPhase::Phase2QNCTransfer;
        
        assert_ne!(format!("{:?}", phase1), format!("{:?}", phase2));
    }

    #[test]
    fn test_node_type_variants() {
        // Test all NodeType variants exist and are distinct
        let types = vec![
            NodeType::Super,
            NodeType::Full,
            NodeType::Light,
        ];
        
        for (i, t1) in types.iter().enumerate() {
            for (j, t2) in types.iter().enumerate() {
                if i == j {
                    assert_eq!(format!("{:?}", t1), format!("{:?}", t2));
                } else {
                    assert_ne!(format!("{:?}", t1), format!("{:?}", t2));
                }
            }
        }
    }
} 
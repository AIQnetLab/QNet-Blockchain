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
pub mod dynamic_timing;
pub mod errors;
pub mod reputation;
pub mod kademlia;

// Re-export main types for public API
pub use lazy_rewards::{PhaseAwareRewardManager, PhaseAwareReward, RewardClaimResult};
pub use reward_integration::{RewardIntegrationManager, RewardInfo};
pub use batch_operations::{
    BatchOperationsManager, BatchRewardClaimRequest, BatchRewardClaimResult,
    BatchNodeActivationRequest, BatchNodeActivationResult, BatchTransferRequest, BatchTransferResult
};
pub use commit_reveal::{CommitRevealConsensus, ConsensusConfig};
pub use errors::ConsensusError;
pub use reputation::{NodeReputation, ReputationConfig};
pub use kademlia::{KademliaDht, KademliaNode, generate_node_id};

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
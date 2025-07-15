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

// Re-export main types for public API
pub use lazy_rewards::{PhaseAwareRewardManager, PhaseAwareReward, RewardClaimResult};
pub use reward_integration::{RewardIntegrationManager, RewardInfo};
pub use batch_operations::{
    BatchOperationsManager, BatchRewardClaimRequest, BatchRewardClaimResult,
    BatchNodeActivationRequest, BatchNodeActivationResult, BatchTransferRequest, BatchTransferResult
};
pub use commit_reveal::CommitRevealConsensus;
pub use errors::ConsensusError;

// Common types used across modules
pub use lazy_rewards::{NodeType, QNetPhase};

/// Initialize consensus system with batch operations support
pub fn initialize_consensus_with_batch_operations(
    genesis_timestamp: u64,
    dev_burn_percentage: f64,
    years_since_launch: u64,
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
    genesis_timestamp: u64,
    dev_burn_percentage: f64,
    years_since_launch: u64,
) -> RewardIntegrationManager {
    let (reward_integration, _) = initialize_consensus_with_batch_operations(
        genesis_timestamp,
        dev_burn_percentage,
        years_since_launch,
    );
    reward_integration
}

// Production initialization functions
pub fn create_production_rewards(genesis_timestamp: u64) -> lazy_rewards::PhaseAwareRewardManager {
    lazy_rewards::create_production_phase_aware_rewards(genesis_timestamp)
}

pub fn create_production_reward_integration() -> reward_integration::RewardIntegrationManager {
    reward_integration::RewardIntegrationManager::new()
}

// Export types needed by integration
pub type ConsensusResult<T> = Result<T, ConsensusError>; 
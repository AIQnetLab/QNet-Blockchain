//! Batch Operations Module for QNet
//! 
//! Provides efficient batch processing for:
//! - Reward claims (avoiding individual network calls)
//! - Node activations (bulk activation for enterprises)
//! - Multiple transfers (payment processing)

use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use crate::lazy_rewards::{PhaseAwareReward};
use crate::reward_integration::RewardIntegrationManager;
use crate::errors::ConsensusError;
use crate::NodeType;

/// Batch size limits for performance
pub const MAX_BATCH_SIZE: usize = 100;
pub const MAX_REWARD_CLAIMS_PER_BATCH: usize = 50;
pub const MAX_NODE_ACTIVATIONS_PER_BATCH: usize = 20;
pub const MAX_TRANSFERS_PER_BATCH: usize = 100;

/// Batch operation types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BatchOperationType {
    RewardClaims,
    NodeActivations, 
    Transfers,
}

/// Batch reward claim request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchRewardClaimRequest {
    pub node_ids: Vec<String>,
    pub batch_id: String,
    pub timestamp: u64,
}

/// Batch reward claim result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchRewardClaimResult {
    pub batch_id: String,
    pub total_claimed: u64,
    pub successful_claims: HashMap<String, PhaseAwareReward>,
    pub failed_claims: HashMap<String, String>,
    pub processing_time_ms: u64,
}

/// Batch node activation request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchNodeActivationRequest {
    pub activations: Vec<NodeActivationData>,
    pub batch_id: String,
    pub timestamp: u64,
}

/// Individual node activation data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeActivationData {
    pub node_id: String,
    pub owner_address: String,
    pub node_type: NodeType,
    pub activation_amount: u64,
    pub tx_hash: String,
}

/// Batch node activation result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchNodeActivationResult {
    pub batch_id: String,
    pub successful_activations: Vec<String>,
    pub failed_activations: HashMap<String, String>,
    pub total_pool3_contributions: u64,
    pub processing_time_ms: u64,
}

/// Batch transfer request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchTransferRequest {
    pub transfers: Vec<TransferData>,
    pub batch_id: String,
    pub sender_address: String,
    pub timestamp: u64,
}

/// Individual transfer data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferData {
    pub to_address: String,
    pub amount: u64,
    pub memo: Option<String>,
}

/// Batch transfer result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchTransferResult {
    pub batch_id: String,
    pub successful_transfers: Vec<String>,
    pub failed_transfers: HashMap<String, String>,
    pub total_amount_transferred: u64,
    pub total_fees_paid: u64,
    pub processing_time_ms: u64,
}

/// Batch operations manager
pub struct BatchOperationsManager {
    /// Reward integration for processing rewards
    reward_integration: std::sync::Arc<std::sync::Mutex<RewardIntegrationManager>>,
    
    /// Performance metrics
    batch_metrics: std::sync::Arc<std::sync::RwLock<BatchMetrics>>,
    
    /// Current batch processing
    active_batches: std::sync::Arc<std::sync::RwLock<HashMap<String, BatchStatus>>>,
}

/// Batch processing status
#[derive(Debug, Clone)]
pub enum BatchStatus {
    Pending,
    Processing,
    Completed,
    Failed(String),
}

/// Batch performance metrics
#[derive(Debug, Clone, Default)]
pub struct BatchMetrics {
    pub total_batches_processed: u64,
    pub total_reward_claims_processed: u64,
    pub total_node_activations_processed: u64,
    pub total_transfers_processed: u64,
    pub avg_processing_time_ms: f64,
    pub success_rate: f64,
}

impl BatchOperationsManager {
    /// Create new batch operations manager
    pub fn new(reward_integration: std::sync::Arc<std::sync::Mutex<RewardIntegrationManager>>) -> Self {
        Self {
            reward_integration,
            batch_metrics: std::sync::Arc::new(std::sync::RwLock::new(BatchMetrics::default())),
            active_batches: std::sync::Arc::new(std::sync::RwLock::new(HashMap::new())),
        }
    }

    /// Process batch reward claims
    pub fn process_batch_reward_claims(&self, request: BatchRewardClaimRequest) -> Result<BatchRewardClaimResult, ConsensusError> {
        let start_time = std::time::Instant::now();
        
        // Validate batch size
        if request.node_ids.len() > MAX_REWARD_CLAIMS_PER_BATCH {
            return Err(ConsensusError::InvalidOperation(
                format!("Batch size {} exceeds maximum {}", request.node_ids.len(), MAX_REWARD_CLAIMS_PER_BATCH)
            ));
        }
        
        // Mark batch as processing
        {
            let mut batches = self.active_batches.write().unwrap();
            batches.insert(request.batch_id.clone(), BatchStatus::Processing);
        }
        
        let mut successful_claims = HashMap::new();
        let mut failed_claims = HashMap::new();
        let mut total_claimed = 0u64;
        
        // Process each reward claim
        {
            let mut reward_integration = self.reward_integration.lock().unwrap();
            
            for node_id in &request.node_ids {
                match reward_integration.claim_node_rewards(node_id) {
                    Ok(claim_result) => {
                        if claim_result.success {
                            if let Some(reward) = claim_result.reward {
                                total_claimed += reward.total_reward;
                                successful_claims.insert(node_id.clone(), reward);
                            }
                        } else {
                            failed_claims.insert(node_id.clone(), claim_result.message);
                        }
                    },
                    Err(e) => {
                        failed_claims.insert(node_id.clone(), e.to_string());
                    }
                }
            }
        }
        
        let processing_time_ms = start_time.elapsed().as_millis() as u64;
        
        // Update batch status
        {
            let mut batches = self.active_batches.write().unwrap();
            batches.insert(request.batch_id.clone(), BatchStatus::Completed);
        }
        
        // Update metrics
        self.update_batch_metrics(BatchOperationType::RewardClaims, processing_time_ms, request.node_ids.len());
        
        println!("✅ Batch reward claims processed: {} successful, {} failed, {} QNC total", 
                successful_claims.len(), failed_claims.len(), total_claimed);
        
        Ok(BatchRewardClaimResult {
            batch_id: request.batch_id,
            total_claimed,
            successful_claims,
            failed_claims,
            processing_time_ms,
        })
    }

    /// Process batch node activations
    pub fn process_batch_node_activations(&self, request: BatchNodeActivationRequest) -> Result<BatchNodeActivationResult, ConsensusError> {
        let start_time = std::time::Instant::now();
        
        // Validate batch size
        if request.activations.len() > MAX_NODE_ACTIVATIONS_PER_BATCH {
            return Err(ConsensusError::InvalidOperation(
                format!("Batch size {} exceeds maximum {}", request.activations.len(), MAX_NODE_ACTIVATIONS_PER_BATCH)
            ));
        }
        
        // Mark batch as processing
        {
            let mut batches = self.active_batches.write().unwrap();
            batches.insert(request.batch_id.clone(), BatchStatus::Processing);
        }
        
        let mut successful_activations = Vec::new();
        let mut failed_activations = HashMap::new();
        let mut total_pool3_contributions = 0u64;
        
        // Process each node activation
        {
            let mut reward_integration = self.reward_integration.lock().unwrap();
            
            for activation in &request.activations {
                match reward_integration.process_node_activation(
                    activation.node_id.clone(),
                    activation.node_type.clone(), // Already NodeType enum, no conversion needed
                    "unknown_wallet".to_string(), // placeholder wallet
                    activation.activation_amount,
                    activation.tx_hash.clone(),
                ) {
                    Ok(()) => {
                        successful_activations.push(activation.node_id.clone());
                        total_pool3_contributions += activation.activation_amount;
                    },
                    Err(e) => {
                        failed_activations.insert(activation.node_id.clone(), e.to_string());
                    }
                }
            }
        }
        
        let processing_time_ms = start_time.elapsed().as_millis() as u64;
        
        // Update batch status
        {
            let mut batches = self.active_batches.write().unwrap();
            batches.insert(request.batch_id.clone(), BatchStatus::Completed);
        }
        
        // Update metrics
        self.update_batch_metrics(BatchOperationType::NodeActivations, processing_time_ms, request.activations.len());
        
        println!("✅ Batch node activations processed: {} successful, {} failed, {} QNC to Pool 3", 
                successful_activations.len(), failed_activations.len(), total_pool3_contributions);
        
        Ok(BatchNodeActivationResult {
            batch_id: request.batch_id,
            successful_activations,
            failed_activations,
            total_pool3_contributions,
            processing_time_ms,
        })
    }

    /// Process batch transfers
    pub fn process_batch_transfers(&self, request: BatchTransferRequest) -> Result<BatchTransferResult, ConsensusError> {
        let start_time = std::time::Instant::now();
        
        // Validate batch size
        if request.transfers.len() > MAX_TRANSFERS_PER_BATCH {
            return Err(ConsensusError::InvalidOperation(
                format!("Batch size {} exceeds maximum {}", request.transfers.len(), MAX_TRANSFERS_PER_BATCH)
            ));
        }
        
        // Mark batch as processing
        {
            let mut batches = self.active_batches.write().unwrap();
            batches.insert(request.batch_id.clone(), BatchStatus::Processing);
        }
        
        let mut successful_transfers = Vec::new();
        let mut failed_transfers = HashMap::new();
        let mut total_amount_transferred = 0u64;
        let mut total_fees_paid = 0u64;
        
        // Calculate total amount needed
        let _total_amount_needed: u64 = request.transfers.iter().map(|t| t.amount).sum();
        let _estimated_fees = request.transfers.len() as u64 * 1000; // Rough estimate
        
        // Process each transfer (in production, this would integrate with transaction system)
        for (index, transfer) in request.transfers.iter().enumerate() {
            let transfer_id = format!("{}_{}", request.batch_id, index);
            
            // Validate transfer
            if transfer.amount == 0 {
                failed_transfers.insert(transfer_id, "Zero amount transfer".to_string());
                continue;
            }
            
            if transfer.to_address.is_empty() {
                failed_transfers.insert(transfer_id, "Empty recipient address".to_string());
                continue;
            }
            
            // In production, this would create actual transactions
            // For now, we simulate success
            successful_transfers.push(transfer_id);
            total_amount_transferred += transfer.amount;
            total_fees_paid += 1000; // Simulated fee
        }
        
        let processing_time_ms = start_time.elapsed().as_millis() as u64;
        
        // Update batch status
        {
            let mut batches = self.active_batches.write().unwrap();
            batches.insert(request.batch_id.clone(), BatchStatus::Completed);
        }
        
        // Update metrics
        self.update_batch_metrics(BatchOperationType::Transfers, processing_time_ms, request.transfers.len());
        
        println!("✅ Batch transfers processed: {} successful, {} failed, {} QNC transferred", 
                successful_transfers.len(), failed_transfers.len(), total_amount_transferred);
        
        Ok(BatchTransferResult {
            batch_id: request.batch_id,
            successful_transfers,
            failed_transfers,
            total_amount_transferred,
            total_fees_paid,
            processing_time_ms,
        })
    }

    /// Update batch metrics
    fn update_batch_metrics(&self, operation_type: BatchOperationType, processing_time_ms: u64, operation_count: usize) {
        if let Ok(mut metrics) = self.batch_metrics.write() {
            metrics.total_batches_processed += 1;
            
            match operation_type {
                BatchOperationType::RewardClaims => {
                    metrics.total_reward_claims_processed += operation_count as u64;
                },
                BatchOperationType::NodeActivations => {
                    metrics.total_node_activations_processed += operation_count as u64;
                },
                BatchOperationType::Transfers => {
                    metrics.total_transfers_processed += operation_count as u64;
                },
            }
            
            // Update average processing time
            metrics.avg_processing_time_ms = (metrics.avg_processing_time_ms * (metrics.total_batches_processed - 1) as f64 + processing_time_ms as f64) / metrics.total_batches_processed as f64;
        }
    }

    /// Get batch status
    pub fn get_batch_status(&self, batch_id: &str) -> Option<BatchStatus> {
        let batches = self.active_batches.read().unwrap();
        batches.get(batch_id).cloned()
    }

    /// Get batch metrics
    pub fn get_batch_metrics(&self) -> BatchMetrics {
        self.batch_metrics.read().unwrap().clone()
    }

    /// Clear completed batches (cleanup)
    pub fn cleanup_completed_batches(&self) {
        let mut batches = self.active_batches.write().unwrap();
        batches.retain(|_, status| !matches!(status, BatchStatus::Completed));
    }
}

/// Utility functions for batch operations
impl BatchOperationsManager {
    /// Generate unique batch ID
    pub fn generate_batch_id(operation_type: BatchOperationType) -> String {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        let random_suffix = rand::random::<u32>();
        
        match operation_type {
            BatchOperationType::RewardClaims => format!("batch_rewards_{}_{}", timestamp, random_suffix),
            BatchOperationType::NodeActivations => format!("batch_nodes_{}_{}", timestamp, random_suffix),
            BatchOperationType::Transfers => format!("batch_transfers_{}_{}", timestamp, random_suffix),
        }
    }

    /// Validate batch request timing
    pub fn validate_batch_timing(&self, batch_id: &str, timestamp: u64) -> Result<(), ConsensusError> {
        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        // Allow 5 minute window for batch requests
        if current_time > timestamp + 300 {
            return Err(ConsensusError::InvalidOperation(
                format!("Batch request {} is too old", batch_id)
            ));
        }
        
        if timestamp > current_time + 60 {
            return Err(ConsensusError::InvalidOperation(
                format!("Batch request {} is from the future", batch_id)
            ));
        }
        
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    
    #[test]
    fn test_batch_id_generation() {
        let batch_id = BatchOperationsManager::generate_batch_id(BatchOperationType::RewardClaims);
        assert!(batch_id.starts_with("batch_rewards_"));
        assert!(batch_id.len() > 15);
    }

    #[test]
    fn test_batch_size_limits() {
        // Test that our limits are reasonable
        assert!(MAX_REWARD_CLAIMS_PER_BATCH <= 100);
        assert!(MAX_NODE_ACTIVATIONS_PER_BATCH <= 50);
        assert!(MAX_TRANSFERS_PER_BATCH <= 200);
    }
} 
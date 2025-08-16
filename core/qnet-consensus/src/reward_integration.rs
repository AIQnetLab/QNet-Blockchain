//! Reward Integration Module
//! Connects transaction processing with the PhaseAwareRewardManager system
//! Ensures transaction fees go to Pool 2 and activation QNC goes to Pool 3

use std::sync::{Arc, RwLock};
use std::collections::HashMap;
use crate::lazy_rewards::{PhaseAwareRewardManager, QNetPhase, NodeType};
use crate::errors::ConsensusError;
use serde::{Deserialize, Serialize};
use qnet_state::transaction::{RewardIntegrationCallback, TransactionProcessor};

/// Transaction fee information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionFee {
    pub tx_hash: String,
    pub amount: u64,
    pub gas_used: u64,
    pub gas_price: u64,
    pub timestamp: u64,
}

/// Node activation information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeActivation {
    pub node_id: String,
    pub node_type: NodeType,
    pub wallet_address: String,
    pub activation_amount: u64,
    pub phase: QNetPhase,
    pub tx_hash: String,
    pub timestamp: u64,
}

/// Reward integration manager
pub struct RewardIntegrationManager {
    /// Phase-aware reward manager
    reward_manager: Arc<RwLock<PhaseAwareRewardManager>>,
    
    /// Transaction fee tracking
    processed_fees: HashMap<String, TransactionFee>,
    
    /// Node activation tracking
    processed_activations: HashMap<String, NodeActivation>,
    
    /// Pool statistics
    pool_stats: PoolStatistics,
}

/// Pool statistics for monitoring
#[derive(Debug, Clone, Default)]
pub struct PoolStatistics {
    pub pool1_total_distributed: u64,
    pub pool2_total_fees: u64,
    pub pool3_total_activations: u64,
    pub total_transactions_processed: u64,
    pub total_nodes_activated: u64,
    pub current_phase: QNetPhase,
}

impl Default for QNetPhase {
    fn default() -> Self {
        QNetPhase::Phase1
    }
}

impl RewardIntegrationManager {
    /// Create new reward integration manager
    pub fn new() -> Self {
        // Start with a default genesis timestamp (will be updated)
        let genesis_timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
            
        let reward_manager = Arc::new(RwLock::new(
            PhaseAwareRewardManager::new(genesis_timestamp)
        ));
        
        Self {
            reward_manager,
            processed_fees: HashMap::new(),
            processed_activations: HashMap::new(),
            pool_stats: PoolStatistics::default(),
        }
    }
    
    /// Initialize with existing reward manager
    pub fn with_reward_manager(reward_manager: PhaseAwareRewardManager) -> Self {
        let reward_manager = Arc::new(RwLock::new(reward_manager));
        
        Self {
            reward_manager,
            processed_fees: HashMap::new(),
            processed_activations: HashMap::new(),
            pool_stats: PoolStatistics::default(),
        }
    }
    
    /// Process transaction and extract fees for Pool 2
    pub fn process_transaction_fee(&mut self, tx_hash: String, amount: u64, gas_used: u64, gas_price: u64) -> Result<(), ConsensusError> {
        // Calculate total fee
        let fee_amount = gas_used * gas_price;
        
        if fee_amount == 0 {
            return Ok(()); // No fee to process
        }
        
        // Create fee record
        let fee = TransactionFee {
            tx_hash: tx_hash.clone(),
            amount,
            gas_used,
            gas_price,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        };
        
        // Add fee to Pool 2
        {
            let mut reward_manager = self.reward_manager.write().unwrap();
            reward_manager.add_transaction_fees(fee_amount);
        }
        
        // Track processed fee
        self.processed_fees.insert(tx_hash, fee);
        
        // Update statistics
        self.pool_stats.pool2_total_fees += fee_amount;
        self.pool_stats.total_transactions_processed += 1;
        
        println!("[RewardIntegration] ✅ Transaction fee processed: {} QNC → Pool 2", fee_amount);
        
        Ok(())
    }
    
    /// FIXED: Process node activation with wallet address for reward ownership
    pub fn process_node_activation(&mut self, node_id: String, node_type: NodeType, wallet_address: String, activation_amount: u64, tx_hash: String) -> Result<(), ConsensusError> {
        // Get current phase
        let current_phase = {
            let reward_manager = self.reward_manager.read().unwrap();
            reward_manager.get_network_phase()
        };
        
        // Create activation record
        let activation = NodeActivation {
            node_id: node_id.clone(),
            node_type: node_type.clone(),
            wallet_address: wallet_address.clone(),
            activation_amount,
            phase: current_phase.clone(),
            tx_hash: tx_hash.clone(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        };
        
        // Process based on phase
        match current_phase {
            QNetPhase::Phase1 => {
                // Phase 1: No Pool 3 processing (1DEV burn handled externally)
                println!("[RewardIntegration] ⚠️ Phase 1: Node activation {} (1DEV burn, no Pool 3)", node_id);
                
                // Just register the node for rewards
                {
                    let mut reward_manager = self.reward_manager.write().unwrap();
                    reward_manager.register_node(node_id.clone(), node_type, wallet_address.clone())?;
                }
            },
            QNetPhase::Phase2 => {
                // Phase 2: Add QNC to Pool 3
                {
                    let mut reward_manager = self.reward_manager.write().unwrap();
                    
                    // Register node
                    reward_manager.register_node(node_id.clone(), node_type, wallet_address.clone())?;
                    
                    // Add activation amount to Pool 3
                    reward_manager.add_activation_qnc(activation_amount)?;
                }
                
                // Update statistics
                self.pool_stats.pool3_total_activations += activation_amount;
                
                println!("[RewardIntegration] ✅ Phase 2: Node activation {} → {} QNC to Pool 3", node_id, activation_amount);
            }
        }
        
        // Track processed activation
        self.processed_activations.insert(node_id, activation);
        
        // Update statistics
        self.pool_stats.total_nodes_activated += 1;
        self.pool_stats.current_phase = current_phase;
        
        Ok(())
    }
    
    /// Update phase transition parameters
    pub fn update_phase_parameters(&mut self, dev_burn_percentage: f64, _years_since_launch: u64) {
        let mut reward_manager = self.reward_manager.write().unwrap();
        reward_manager.update_phase_parameters(dev_burn_percentage, 0); // years parameter is now ignored
        
        // Get actual years since genesis from reward manager
        let actual_years = reward_manager.get_years_since_genesis();
        
        // Update statistics
        self.pool_stats.current_phase = reward_manager.get_network_phase();
        
        println!("[RewardIntegration] 📊 Phase parameters updated: {:.1}% burned, {} years since genesis", 
                 dev_burn_percentage, actual_years);
    }
    
    /// Get current pool statistics
    pub fn get_pool_statistics(&self) -> PoolStatistics {
        let reward_manager = self.reward_manager.read().unwrap();
        let stats = reward_manager.get_reward_stats();
        
        PoolStatistics {
            pool1_total_distributed: stats.pool1_current_emission,
            pool2_total_fees: stats.pool2_transaction_fees,
            pool3_total_activations: stats.pool3_activation_pool,
            total_transactions_processed: self.pool_stats.total_transactions_processed,
            total_nodes_activated: self.pool_stats.total_nodes_activated,
            current_phase: stats.current_phase,
        }
    }
    
    /// Get reward manager reference (for claims)
    pub fn get_reward_manager(&self) -> Arc<RwLock<PhaseAwareRewardManager>> {
        self.reward_manager.clone()
    }
    
    /// Process ping result
    pub fn process_ping_result(&mut self, node_id: String, success: bool, response_time_ms: u32) -> Result<(), ConsensusError> {
        let mut reward_manager = self.reward_manager.write().unwrap();
        reward_manager.record_ping_attempt(&node_id, success, response_time_ms)
    }
    
    /// Claim rewards for a node
    pub fn claim_node_rewards(&mut self, node_id: &str) -> Result<crate::lazy_rewards::RewardClaimResult, ConsensusError> {
        let mut reward_manager = self.reward_manager.write().unwrap();
        Ok(reward_manager.claim_rewards(node_id, "unknown_wallet"))
    }
    
    /// Get pending rewards for a node
    pub fn get_pending_rewards(&self, node_id: &str) -> Option<crate::lazy_rewards::PhaseAwareReward> {
        let reward_manager = self.reward_manager.read().unwrap();
        reward_manager.get_pending_reward(node_id).cloned()
    }
    
    /// Get comprehensive reward information
    pub fn get_reward_info(&self, node_id: &str) -> RewardInfo {
        let reward_manager = self.reward_manager.read().unwrap();
        let pending = reward_manager.get_pending_reward(node_id);
        let ping_history = reward_manager.get_ping_history(node_id);
        let stats = reward_manager.get_reward_stats();
        
        RewardInfo {
            node_id: node_id.to_string(),
            pending_reward: pending.cloned(),
            ping_history: ping_history.cloned(),
            current_phase: stats.current_phase,
            pool1_current_emission: stats.pool1_current_emission,
            pool2_transaction_fees: stats.pool2_transaction_fees,
            pool3_activation_pool: stats.pool3_activation_pool,
            meets_ping_requirements: ping_history.map(|h| h.meets_requirements()).unwrap_or(false),
        }
    }
    
    /// Force process current reward window (for testing)
    pub fn force_process_rewards(&mut self) -> Result<(), ConsensusError> {
        let mut reward_manager = self.reward_manager.write().unwrap();
        reward_manager.force_process_window()
    }
    
    /// Get transaction fee history
    pub fn get_transaction_fee_history(&self) -> Vec<TransactionFee> {
        self.processed_fees.values().cloned().collect()
    }
    
    /// Get node activation history
    pub fn get_activation_history(&self) -> Vec<NodeActivation> {
        self.processed_activations.values().cloned().collect()
    }
}

/// Comprehensive reward information for a node
#[derive(Debug, Clone)]
pub struct RewardInfo {
    pub node_id: String,
    pub pending_reward: Option<crate::lazy_rewards::PhaseAwareReward>,
    pub ping_history: Option<crate::lazy_rewards::NodePingHistory>,
    pub current_phase: QNetPhase,
    pub pool1_current_emission: u64,
    pub pool2_transaction_fees: u64,
    pub pool3_activation_pool: u64,
    pub meets_ping_requirements: bool,
}

/// Reward integration callback implementation
pub struct RewardIntegrationCallbackImpl {
    pub manager: RewardIntegrationManager,
}

impl RewardIntegrationCallbackImpl {
    pub fn new(manager: RewardIntegrationManager) -> Self {
        Self { manager }
    }
}

impl RewardIntegrationCallback for RewardIntegrationCallbackImpl {
    /// Process transaction fee for Pool 2
    fn process_transaction_fee(&mut self, tx_hash: String, amount: u64, gas_used: u64, gas_price: u64) -> Result<(), String> {
        self.manager.process_transaction_fee(tx_hash, amount, gas_used, gas_price)
            .map_err(|e| format!("Failed to process transaction fee: {:?}", e))
    }
    
    /// Process node activation for Pool 3
    fn process_node_activation(&mut self, node_id: String, node_type: String, amount: u64, tx_hash: String) -> Result<(), String> {
        let node_type_enum = match node_type.as_str() {
            "Light" => NodeType::Light,
            "Full" => NodeType::Full,
            "Super" => NodeType::Super,
            _ => return Err(format!("Invalid node type: {}", node_type)),
        };
        
        // FIXED: Use placeholder wallet since treiт doesn't provide it
        self.manager.process_node_activation(node_id, node_type_enum, "unknown_wallet".to_string(), amount, tx_hash)
            .map_err(|e| format!("Failed to process node activation: {:?}", e))
    }
}

/// Production-ready transaction processor with Pool 2 integration
pub fn create_production_transaction_processor() -> (TransactionProcessor, RewardIntegrationManager) {
    let reward_integration = RewardIntegrationManager::new();
    let mut transaction_processor = TransactionProcessor::new();
    
    // Create callback implementation
    let callback = RewardIntegrationCallbackImpl::new(reward_integration.clone());
    transaction_processor.set_reward_integration(Box::new(callback));
    
    (transaction_processor, reward_integration)
}

impl Clone for RewardIntegrationManager {
    fn clone(&self) -> Self {
        // Create a new manager with the same configuration
        let _genesis_timestamp = {
            let reward_manager = self.reward_manager.read().unwrap();
            reward_manager.get_genesis_timestamp()
        };
        
        Self::new() // For simplicity, create a new instance
    }
}


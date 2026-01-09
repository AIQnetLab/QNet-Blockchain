//! QNet Phase-Aware Three-Pool Reward System
//! Phase 1: 1DEV burn-to-join, Pool 3 DISABLED
//! Phase 2: QNC spend-to-Pool3, Pool 3 ENABLED
//! Pool 1: Dynamic base emission with sharp drop halving
//! Pool 2: Transaction fees (70% Super, 30% Full, 0% Light)
//! Pool 3: Activation pool (ONLY in Phase 2)

use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use crate::errors::ConsensusError;

/// Minimum claim amount (1 QNC in nanoQNC) to prevent spam
const MIN_CLAIM_AMOUNT: u64 = 1_000_000_000; // 1 QNC = 10^9 nanoQNC

/// QNet economic phases
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum QNetPhase {
    Phase1, // 1DEV burn-to-join (Pool 3 disabled)
    Phase2, // QNC spend-to-Pool3 (Pool 3 enabled)
}

/// Node type for reward calculation
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum NodeType {
    Light,
    Full,
    Super,
}

/// Ping success requirements for different node types
#[derive(Debug, Clone)]
pub struct PingRequirements {
    pub pings_per_4h_window: u32,
    pub success_rate_threshold: f64,
    pub timeout_seconds: u32,
}

impl PingRequirements {
    pub fn for_node_type(node_type: &NodeType) -> Self {
        match node_type {
            NodeType::Light => Self {
                pings_per_4h_window: 1,      // 1 ping per 4 hours
                success_rate_threshold: 1.0, // 100% (binary: respond or not)
                timeout_seconds: 60,         // 60 seconds to respond
            },
            NodeType::Full => Self {
                pings_per_4h_window: 10,     // 10 pings per 4 hours (every 24 minutes) - REDUCED for scalability
                success_rate_threshold: 0.8, // 80% (8+ out of 10) - ADJUSTED for new ping count
                timeout_seconds: 30,         // 30 seconds to respond
            },
            NodeType::Super => Self {
                pings_per_4h_window: 10,     // 10 pings per 4 hours (every 24 minutes) - REDUCED for scalability
                success_rate_threshold: 0.9, // 90% (9+ out of 10) - ADJUSTED for new ping count  
                timeout_seconds: 30,         // 30 seconds to respond
            },
        }
    }
}

/// Ping attempt record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingAttempt {
    pub timestamp: u64,
    pub success: bool,
    pub response_time_ms: u32,
}

/// Node's ping history for current reward window
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodePingHistory {
    pub node_id: String,
    pub node_type: NodeType,
    pub window_start: u64,
    pub attempts: Vec<PingAttempt>,
}

impl NodePingHistory {
    pub fn new(node_id: String, node_type: NodeType, window_start: u64) -> Self {
        Self {
            node_id,
            node_type,
            window_start,
            attempts: Vec::new(),
        }
    }
    
    pub fn add_ping_attempt(&mut self, success: bool, response_time_ms: u32) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
            
        self.attempts.push(PingAttempt {
            timestamp,
            success,
            response_time_ms,
        });
    }
    
    pub fn meets_requirements(&self) -> bool {
        let requirements = PingRequirements::for_node_type(&self.node_type);
        
        let successful_pings = self.attempts.iter().filter(|a| a.success).count();
        let total_pings = self.attempts.len();
        
        if total_pings == 0 {
            return false;
        }
        
        let success_rate = successful_pings as f64 / total_pings as f64;
        
        match self.node_type {
            NodeType::Light => {
                // Light nodes: at least 1 successful ping required
                // Note: dedupe is enforced at attestation storage level (key = node_id:slot)
                // Multiple attestations shouldn't occur in normal operation, but if they do,
                // node should still be eligible as long as at least one succeeded
                successful_pings >= 1
            },
            NodeType::Full | NodeType::Super => {
                // Full/Super nodes: percentage success rate
                success_rate >= requirements.success_rate_threshold
            }
        }
    }
    
    pub fn get_success_rate(&self) -> f64 {
        if self.attempts.is_empty() {
            return 0.0;
        }
        
        let successful_pings = self.attempts.iter().filter(|a| a.success).count();
        successful_pings as f64 / self.attempts.len() as f64
    }
}

/// Phase-aware three-pool reward calculation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseAwareReward {
    pub current_phase: QNetPhase,
    pub pool1_base_emission: u64,    // Dynamic base emission with halving
    pub pool2_transaction_fees: u64, // Share from transaction fees
    pub pool3_activation_bonus: u64, // Share from activation pool (0 in Phase 1)
    pub total_reward: u64,
}

/// Reward claim result
#[derive(Debug, Clone)]
pub struct RewardClaimResult {
    pub success: bool,
    pub reward: Option<PhaseAwareReward>,
    pub message: String,
    pub next_claim_time: u64,
}

/// Phase-aware three-pool reward manager
pub struct PhaseAwareRewardManager {
    /// Genesis timestamp (when blockchain started)
    genesis_timestamp: u64,
    
    /// Current reward window (4 hours)
    current_window_start: u64,
    
    /// Node ping histories by node_id
    ping_histories: HashMap<String, NodePingHistory>,
    
    /// FIXED: Node ownership mapping - node_id -> wallet_address
    node_ownership: HashMap<String, String>,
    
    /// PRODUCTION v2.43.1: Inverted index wallet_address -> Vec<node_id>
    /// O(1) lookup for get_nodes_by_owner instead of O(n) scan
    wallet_nodes_index: HashMap<String, Vec<String>>,
    
    /// Pending rewards by node_id (in-memory cache, synced with RocksDB when available)
    pending_rewards: HashMap<String, PhaseAwareReward>,
    
    /// Last claim time by node_id
    last_claim_time: HashMap<String, u64>,
    
    /// Storage handler path for RocksDB persistence
    storage_path: Option<String>,
    
    /// Pool 2: Transaction fees
    pool2_transaction_fees: u64,
    
    /// Pool 3: Activation pool (only works in Phase 2)
    pool3_activation_pool: u64,
    
    /// Phase transition parameters
    dev_burn_percentage: f64,  // Current 1DEV burn percentage
    
    /// Minimum claim interval (prevent spam)
    min_claim_interval: Duration,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v2.51.1: REMAINDER ACCUMULATION - No funds lost from integer division!
    // Remainders from division are accumulated and added to next emission period
    // Example: 1000/7 = 142×7 = 994, remainder 6 → added to next period
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Pool 1 remainder from previous distribution (base emission)
    pool1_remainder: u64,
    
    /// Pool 2 remainder from Full nodes distribution
    pool2_full_remainder: u64,
    
    /// Pool 2 remainder from Super nodes distribution  
    pool2_super_remainder: u64,
    
    /// Pool 3 remainder from previous distribution (Phase 2 only)
    pool3_remainder: u64,
    
    /// v2.84: Track emission for CURRENT EPOCH ONLY (for RewardDistribution TX)
    /// This is separate from pending_rewards which accumulates for claiming
    /// Reset at each emission, used for blockchain emission TX
    last_epoch_emission: u64,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v2.90: PREVENT DOUBLE-PROCESSING OF EMISSION MACROBLOCKS
    // CRITICAL BUG FIX: Without this, node restarts cause duplicate rewards!
    // Each emission MacroBlock (160, 320, 480...) must be processed EXACTLY ONCE
    // This set tracks which MacroBlocks have been processed to prevent accumulation bugs
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Set of processed emission MacroBlock indices (160, 320, 480, 640...)
    /// Prevents double-processing on node restart or MacroBlock re-sync
    processed_emission_macroblocks: HashSet<u64>,
}

impl PhaseAwareRewardManager {
    /// Create new phase-aware reward manager
    pub fn new(genesis_timestamp: u64) -> Self {
        let current_window_start = Self::get_current_window_start();
        
        Self {
            genesis_timestamp,
            current_window_start,
            ping_histories: HashMap::new(),
            node_ownership: HashMap::new(),
            wallet_nodes_index: HashMap::new(), // v2.43.1: Inverted index
            pending_rewards: HashMap::new(),
            last_claim_time: HashMap::new(),
            storage_path: None,
            pool2_transaction_fees: 0,
            pool3_activation_pool: 0,
            dev_burn_percentage: 0.0,
            min_claim_interval: Duration::from_secs(3600), // 1 hour minimum
            // v2.51.1: Remainder accumulators (start at 0)
            pool1_remainder: 0,
            pool2_full_remainder: 0,
            pool2_super_remainder: 0,
            pool3_remainder: 0,
            // v2.84: Track current epoch emission separately
            last_epoch_emission: 0,
            // v2.90: Track processed emission MacroBlocks to prevent duplicates
            processed_emission_macroblocks: HashSet::new(),
        }
    }
    
    /// Get current 4-hour window start time
    fn get_current_window_start() -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
            
        // Round down to nearest 4-hour boundary
        now - (now % (4 * 60 * 60))
    }
    
    /// Calculate years since genesis timestamp
    fn calculate_years_since_genesis(&self) -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
            
        if now > self.genesis_timestamp {
            (now - self.genesis_timestamp) / (365 * 24 * 60 * 60)
        } else {
            0
        }
    }
    
    /// Calculate dynamic Pool 1 base emission with sharp drop halving
    fn calculate_pool1_base_emission(&self) -> u64 {
        let years_since_genesis = self.calculate_years_since_genesis();
        
        let halving_cycles = years_since_genesis / 4;
        
        // Sharp drop halving model
        let base_rate = if halving_cycles == 5 {
            // 5th halving (year 20-24): Sharp drop by 10x instead of 2x
            251_432.34 / (2.0_f64.powi(4) * 10.0) // Previous 4 halvings (÷2) then sharp drop (÷10)
        } else if halving_cycles > 5 {
            // After sharp drop: Resume normal halving from new low base
            let normal_halvings = halving_cycles - 5;
            251_432.34 / (2.0_f64.powi(4) * 10.0 * 2.0_f64.powi(normal_halvings as i32))
        } else {
            // Normal halving for first 5 cycles (20 years) - CORRECTED to match whitepaper
            251_432.34 / (2.0_f64.powi(halving_cycles as i32))
        };
        
        // Convert to nanoQNC (10^9 precision)
        (base_rate * 1_000_000_000.0) as u64
    }
    
    /// Determine current QNet phase
    fn get_current_phase(&self) -> QNetPhase {
        let years_since_genesis = self.calculate_years_since_genesis();
        
        // Phase 2 activates when EITHER condition is met:
        // 1. 90% of 1DEV supply burned
        // 2. 5 years since genesis (using actual genesis_timestamp)
        if self.dev_burn_percentage >= 90.0 || years_since_genesis >= 5 {
            QNetPhase::Phase2
        } else {
            QNetPhase::Phase1
        }
    }
    
    /// Update phase transition parameters
    /// Note: years_since_launch is now calculated automatically from genesis_timestamp
    pub fn update_phase_parameters(&mut self, dev_burn_percentage: f64, _years_since_launch: u64) {
        self.dev_burn_percentage = dev_burn_percentage;
        // years_since_launch is now calculated automatically from genesis_timestamp
        // in get_current_phase() and get_reward_stats(), so this parameter is ignored
    }
    
    /// FIXED: Register node with wallet address for reward ownership
    /// Set storage path for RocksDB persistence (for scalability)
    pub fn set_storage_path(&mut self, path: String) {
        self.storage_path = Some(path);
    }
    
    /// Register a node for rewards
    pub fn register_node(&mut self, node_id: String, node_type: NodeType, wallet_address: String) -> Result<(), ConsensusError> {
        let window_start = Self::get_current_window_start();
        
        // Check if we need to start a new reward window
        if window_start > self.current_window_start {
            self.process_reward_window()?;
            self.current_window_start = window_start;
        }
        
        // FIXED: Store wallet ownership for reward claims
        self.node_ownership.insert(node_id.clone(), wallet_address.clone());
        
        // PRODUCTION v2.43.1: Update inverted index for O(1) wallet->nodes lookup
        self.wallet_nodes_index
            .entry(wallet_address.clone())
            .or_insert_with(Vec::new)
            .push(node_id.clone());
        
        // Create ping history for this node
        let ping_history = NodePingHistory::new(node_id.clone(), node_type, window_start);
        self.ping_histories.insert(node_id.clone(), ping_history);
        
        println!("✅ Node registered for rewards: {} owned by wallet: {}...", 
                 node_id, &wallet_address[..8.min(wallet_address.len())]);
        
        Ok(())
    }
    
    /// Record ping attempt for a node
    pub fn record_ping_attempt(
        &mut self,
        node_id: &str,
        success: bool,
        response_time_ms: u32,
    ) -> Result<(), ConsensusError> {
        let ping_history = self.ping_histories.get_mut(node_id)
            .ok_or_else(|| ConsensusError::InvalidNodeType(node_id.to_string()))?;
            
        ping_history.add_ping_attempt(success, response_time_ms);
        
        Ok(())
    }
    
    /// Process current reward window and calculate rewards
    /// v2.51.1: Updated to use unified remainder-aware distribution
    fn process_reward_window(&mut self) -> Result<(), ConsensusError> {
        // Convert ping histories to HeartbeatSummaryData format
        let heartbeat_summaries: Vec<HeartbeatSummaryData> = self.ping_histories
            .iter()
            .map(|(node_id, history)| {
                let node_type_u8 = match history.node_type {
                    NodeType::Light => 0,
                    NodeType::Full => 1,
                    NodeType::Super => 2,
                };
                
                HeartbeatSummaryData {
                    node_id: node_id.clone(),
                    node_type: node_type_u8,
                    heartbeat_count: history.attempts.len() as u8,
                    first_heartbeat: history.attempts.first().map(|a| a.timestamp).unwrap_or(0),
                    last_heartbeat: history.attempts.last().map(|a| a.timestamp).unwrap_or(0),
                    is_eligible: history.meets_requirements(),
                }
            })
            .collect();
        
        // Clear ping histories before processing (we've converted them)
        self.ping_histories.clear();
        
        // Use unified deterministic processing with remainder accumulation
        // v2.90: macroblock_index=0 means legacy path (not from MacroBlock)
        self.process_macroblock_heartbeats_deterministic(
            0,  // Legacy: not from MacroBlock, use 0 as sentinel
            &heartbeat_summaries,
            Some(self.pool2_transaction_fees),
            Some(self.pool3_activation_pool),
        )
    }
    
    /// Calculate reward for a single node
    /// 
    /// CRITICAL FIX v2.51: Proper redistribution when one node type has 0 eligible nodes
    /// NOTE: Now primarily used for documentation - main logic in process_macroblock_heartbeats_deterministic
    #[allow(dead_code)]
    fn calculate_node_reward(
        &self,
        node_type: &NodeType,
        current_phase: &QNetPhase,
        total_eligible_nodes: u32,
        eligible_full_nodes: u32,
        eligible_super_nodes: u32,
    ) -> PhaseAwareReward {
        // Delegate to pool-based calculation with local pool values
        self.calculate_node_reward_with_pools(
            node_type,
            current_phase,
            total_eligible_nodes,
            eligible_full_nodes,
            eligible_super_nodes,
            self.pool2_transaction_fees,
            self.pool3_activation_pool,
        )
    }
    
    /// Add transaction fees to Pool 2
    pub fn add_transaction_fees(&mut self, amount: u64) {
        self.pool2_transaction_fees += amount;
    }
    
    /// Add activation QNC to Pool 3 (ONLY works in Phase 2)
    pub fn add_activation_qnc(&mut self, amount: u64) -> Result<(), ConsensusError> {
        match self.get_current_phase() {
            QNetPhase::Phase1 => {
                // Pool 3 disabled in Phase 1
                Err(ConsensusError::InvalidOperation("Pool 3 disabled in Phase 1. Use 1DEV burn instead.".to_string()))
            },
            QNetPhase::Phase2 => {
                // Pool 3 enabled in Phase 2
                self.pool3_activation_pool += amount;
                Ok(())
            }
        }
    }
    
    /// FIXED: Claim rewards for a node - ONLY the owning wallet can claim
    pub fn claim_rewards(&mut self, node_id: &str, claimant_wallet: &str) -> RewardClaimResult {
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // CRITICAL: Verify wallet ownership FIRST
        match self.node_ownership.get(node_id) {
            Some(owner_wallet) => {
                if owner_wallet != claimant_wallet {
                    return RewardClaimResult {
                        success: false,
                        reward: None,
                        message: format!("SECURITY VIOLATION: Node {} belongs to wallet {}..., not {}...", 
                                       node_id, 
                                       &owner_wallet[..8.min(owner_wallet.len())],
                                       &claimant_wallet[..8.min(claimant_wallet.len())]),
                        next_claim_time: current_time + self.min_claim_interval.as_secs(),
                    };
                }
            }
            None => {
                return RewardClaimResult {
                    success: false,
                    reward: None,
                    message: format!("Node {} not registered for rewards", node_id),
                    next_claim_time: current_time + self.min_claim_interval.as_secs(),
                };
            }
        }
        
        // Check minimum claim interval
        if let Some(last_claim) = self.last_claim_time.get(node_id) {
            if current_time - last_claim < self.min_claim_interval.as_secs() {
                return RewardClaimResult {
                    success: false,
                    reward: None,
                    message: format!("Must wait {} seconds between claims", 
                                   self.min_claim_interval.as_secs()),
                    next_claim_time: last_claim + self.min_claim_interval.as_secs(),
                };
            }
        }
        
        // Get pending reward
        let reward = match self.pending_rewards.get(node_id) {
            Some(reward) => {
                // Check minimum claim amount to prevent spam
                if reward.total_reward < MIN_CLAIM_AMOUNT {
                    return RewardClaimResult {
                        success: false,
                        reward: None,
                        message: format!("Amount too small: {:.9} QNC (minimum: 1 QNC)",
                                       reward.total_reward as f64 / 1_000_000_000.0),
                        next_claim_time: current_time + self.min_claim_interval.as_secs(),
                    };
                }
                // Remove only after validation passed
                self.pending_rewards.remove(node_id).expect("Reward exists from match above")
            },
            None => {
                return RewardClaimResult {
                    success: false,
                    reward: None,
                    message: "No pending rewards".to_string(),
                    next_claim_time: current_time + self.min_claim_interval.as_secs(),
                };
            }
        };
        
        // Update last claim time
        self.last_claim_time.insert(node_id.to_string(), current_time);
        
        RewardClaimResult {
            success: true,
            reward: Some(reward),
            message: "Rewards claimed successfully".to_string(),
            next_claim_time: current_time + self.min_claim_interval.as_secs(),
        }
    }
    
    /// Get pending reward for a node
    pub fn get_pending_reward(&self, node_id: &str) -> Option<&PhaseAwareReward> {
        self.pending_rewards.get(node_id)
    }
    
    /// v2.75: Clear pending reward for a node (used when syncing claims from other nodes)
    pub fn clear_pending_reward(&mut self, node_id: &str) -> Option<PhaseAwareReward> {
        self.pending_rewards.remove(node_id)
    }
    
    /// Get the wallet address that owns a node (for claim verification)
    pub fn get_node_owner(&self, node_id: &str) -> Option<String> {
        self.node_ownership.get(node_id).cloned()
    }
    
    /// PRODUCTION v2.43.1: Get all nodes owned by a wallet address
    /// Uses inverted index for O(1) lookup instead of O(n) scan
    /// Used for /api/v1/rewards/by-wallet/{wallet} endpoint
    pub fn get_nodes_by_owner(&self, wallet_address: &str) -> Vec<String> {
        self.wallet_nodes_index
            .get(wallet_address)
            .cloned()
            .unwrap_or_default()
    }
    
    /// Get node's ping history for current window
    pub fn get_ping_history(&self, node_id: &str) -> Option<&NodePingHistory> {
        self.ping_histories.get(node_id)
    }
    
    /// Get network phase
    pub fn get_network_phase(&self) -> QNetPhase {
        self.get_current_phase()
    }
    
    /// Get genesis timestamp
    pub fn get_genesis_timestamp(&self) -> u64 {
        self.genesis_timestamp
    }
    
    /// Get Pool #2 transaction fees accumulated
    pub fn get_pool2_fees(&self) -> u64 {
        self.pool2_transaction_fees
    }
    
    /// Get current Pool 1 base emission (PUBLIC for validation)
    /// Returns total Pool 1 emission for current window in nanoQNC
    /// Used by validators to independently verify emission amounts
    pub fn get_pool1_base_emission(&self) -> u64 {
        self.calculate_pool1_base_emission()
    }
    
    /// Reset Pool #2 fees after distribution
    pub fn reset_pool2_fees(&mut self) {
        self.pool2_transaction_fees = 0;
    }
    
    /// Get years since genesis timestamp
    pub fn get_years_since_genesis(&self) -> u64 {
        self.calculate_years_since_genesis()
    }
    
    /// Get reward statistics
    pub fn get_reward_stats(&self) -> PhaseAwareRewardStats {
        let total_pending = self.pending_rewards.values()
            .map(|r| r.total_reward)
            .sum::<u64>();
        
        let current_phase = self.get_current_phase();
        let pool1_current_emission = self.calculate_pool1_base_emission();
        let _years_since_genesis = self.calculate_years_since_genesis();
            
        PhaseAwareRewardStats {
            current_phase,
            current_window_start: self.current_window_start,
            pool1_current_emission,
            pool2_transaction_fees: self.pool2_transaction_fees,
            pool3_activation_pool: self.pool3_activation_pool,
            total_pending_rewards: total_pending,
            nodes_with_pending_rewards: self.pending_rewards.len(),
            active_ping_histories: self.ping_histories.len(),
            dev_burn_percentage: self.dev_burn_percentage,
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v2.51.1: REMAINDER MONITORING METHODS
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Get total accumulated remainders (for monitoring)
    /// Returns (pool1_remainder, pool2_full_remainder, pool2_super_remainder, pool3_remainder)
    pub fn get_remainders(&self) -> (u64, u64, u64, u64) {
        (
            self.pool1_remainder,
            self.pool2_full_remainder,
            self.pool2_super_remainder,
            self.pool3_remainder,
        )
    }
    
    /// Get total remainder amount across all pools (for monitoring)
    pub fn get_total_remainder(&self) -> u64 {
        self.pool1_remainder + self.pool2_full_remainder + self.pool2_super_remainder + self.pool3_remainder
    }
    
    /// Reset all remainders (for testing only - production should never reset!)
    #[cfg(test)]
    pub fn reset_remainders(&mut self) {
        self.pool1_remainder = 0;
        self.pool2_full_remainder = 0;
        self.pool2_super_remainder = 0;
        self.pool3_remainder = 0;
    }
    
    /// Force process current reward window (for testing)
    pub fn force_process_window(&mut self) -> Result<(), ConsensusError> {
        self.process_reward_window()
    }
    
    /// Get all pending rewards for automatic distribution
    pub fn get_all_pending_rewards(&self) -> Vec<(String, u64)> {
        self.pending_rewards.iter()
            .filter(|(_, reward)| reward.total_reward > 0)
            .map(|(node_id, reward)| (node_id.clone(), reward.total_reward))
            .collect()
    }
    
    /// v2.84: Get emission for CURRENT EPOCH ONLY (for RewardDistribution TX)
    /// This returns the amount emitted in the last process_macroblock_heartbeats call
    /// NOT the accumulated pending rewards (which may span multiple epochs)
    pub fn get_last_epoch_emission(&self) -> u64 {
        self.last_epoch_emission
    }
    
    /// v2.84: Reset epoch emission counter (called after TX is created)
    pub fn reset_epoch_emission(&mut self) {
        self.last_epoch_emission = 0;
    }
    
    /// v2.90: Get processed emission MacroBlocks (for persistence to RocksDB)
    pub fn get_processed_emission_macroblocks(&self) -> &HashSet<u64> {
        &self.processed_emission_macroblocks
    }
    
    /// v2.90: Set processed emission MacroBlocks (load from RocksDB on startup)
    /// This prevents double-processing of MacroBlocks after node restart
    pub fn set_processed_emission_macroblocks(&mut self, processed: HashSet<u64>) {
        self.processed_emission_macroblocks = processed;
        println!("[INFO][REWARDS] loaded_processed_macroblocks count={}", self.processed_emission_macroblocks.len());
    }
    
    /// Get wallet address for a node
    pub fn get_node_wallet_address(&self, node_id: &str) -> Option<String> {
        self.node_ownership.get(node_id).cloned()
    }
    
    /// Get all registered nodes with their types
    pub fn get_all_registered_nodes(&self) -> Vec<(String, NodeType)> {
        self.ping_histories.iter()
            .map(|(node_id, history)| (node_id.clone(), history.node_type.clone()))
            .collect()
    }
    
    /// Get all nodes owned by a specific wallet address
    /// Returns Vec of (node_id, node_type, pending_reward)
    /// Used by mobile apps to find user's nodes by wallet
    pub fn get_nodes_by_wallet(&self, wallet_address: &str) -> Vec<(String, NodeType, u64)> {
        self.node_ownership.iter()
            .filter(|(_, wallet)| *wallet == wallet_address)
            .filter_map(|(node_id, _)| {
                self.ping_histories.get(node_id).map(|history| {
                    let pending = self.pending_rewards.get(node_id)
                        .map(|r| r.total_reward)
                        .unwrap_or(0);
                    (node_id.clone(), history.node_type.clone(), pending)
                })
            })
            .collect()
    }
    
    /// Restore pending reward from storage (for node restart recovery)
    pub fn restore_pending_reward(&mut self, node_id: String, reward: PhaseAwareReward) {
        self.pending_rewards.insert(node_id, reward);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // v2.41.0: BLOCKCHAIN-BASED HEARTBEATS
    // Load heartbeat data from MacroBlock for deterministic reward calculation
    // Replaces gossip-based ping_histories which were non-deterministic
    // ═══════════════════════════════════════════════════════════════════════════════
    
    /// Process heartbeats from MacroBlock for reward calculation
    /// This is the NEW deterministic method - all nodes get identical data from blockchain
    /// Called when MacroBlock is received/created
    /// 
    /// DEPRECATED: Use process_macroblock_heartbeats_deterministic() instead
    /// This method uses LOCAL pool2/pool3 values which are non-deterministic
    pub fn process_macroblock_heartbeats(&mut self, heartbeat_summaries: &[HeartbeatSummaryData]) -> Result<(), ConsensusError> {
        // Use local values (legacy behavior - non-deterministic!)
        // v2.90: macroblock_index=0 means legacy path (not from MacroBlock)
        self.process_macroblock_heartbeats_deterministic(
            0,  // Legacy: not from MacroBlock, use 0 as sentinel
            heartbeat_summaries,
            Some(self.pool2_transaction_fees),
            Some(self.pool3_activation_pool),
        )
    }
    
    /// v2.50.0: Process heartbeats with DETERMINISTIC pool values from MacroBlock
    /// 
    /// CRITICAL: pool2_total and pool3_total come from MacroBlock.consensus_data
    /// All nodes read SAME values from blockchain → deterministic rewards!
    /// 
    /// v2.51.1: REMAINDER ACCUMULATION - No funds lost from integer division!
    /// Remainders are accumulated and added to next emission period
    /// 
    /// Arguments:
    /// - heartbeat_summaries: Eligible nodes from MacroBlock
    /// - pool2_total: Total transaction fees from MacroBlock (None = use local)
    /// - pool3_total: Total activation QNC from MacroBlock (None = use local, Phase 2 only)
    pub fn process_macroblock_heartbeats_deterministic(
        &mut self,
        macroblock_index: u64,
        heartbeat_summaries: &[HeartbeatSummaryData],
        pool2_total: Option<u64>,
        pool3_total: Option<u64>,
    ) -> Result<(), ConsensusError> {
        // v2.90: CRITICAL - Prevent double-processing of emission MacroBlocks!
        // Without this check, node restarts cause duplicate rewards
        // macroblock_index=0 is sentinel for legacy path (skip duplicate check)
        if macroblock_index > 0 && self.processed_emission_macroblocks.contains(&macroblock_index) {
            println!("[WARN][REWARDS] mb={} ALREADY_PROCESSED skipping (prevents duplicate rewards)", macroblock_index);
            return Ok(());
        }
        
        let current_phase = self.get_current_phase();
        
        // Use MacroBlock values if provided, otherwise fall back to local (legacy)
        // v2.51.1: Add accumulated remainders from previous period
        let pool2_fees = pool2_total.unwrap_or(self.pool2_transaction_fees) 
            + self.pool2_full_remainder + self.pool2_super_remainder;
        let pool3_activations = pool3_total.unwrap_or(self.pool3_activation_pool)
            + self.pool3_remainder;
        
        // Count eligible nodes from MacroBlock data
        let mut eligible_light_nodes = 0u32;
        let mut eligible_full_nodes = 0u32;
        let mut eligible_super_nodes = 0u32;
        
        for summary in heartbeat_summaries {
            if summary.is_eligible {
                match summary.node_type {
                    0 => eligible_light_nodes += 1,  // Light
                    1 => eligible_full_nodes += 1,   // Full
                    2 => eligible_super_nodes += 1,  // Super
                    _ => {}
                }
            }
        }
        
        let total_eligible_nodes = eligible_light_nodes + eligible_full_nodes + eligible_super_nodes;
        
        if total_eligible_nodes == 0 {
            println!("[INFO][REWARDS] macroblock_heartbeats no_eligible_nodes pool2_carried={} pool3_carried={}",
                     pool2_fees, pool3_activations);
            // Keep remainders for next period (no nodes to distribute to)
            self.pool2_full_remainder = pool2_fees * 30 / 100;
            self.pool2_super_remainder = pool2_fees * 70 / 100;
            self.pool3_remainder = pool3_activations;
            return Ok(());
        }
        
        // ═══════════════════════════════════════════════════════════════════════════
        // v2.51.1: REMAINDER-AWARE DISTRIBUTION
        // Calculate total distribution and remainders for each pool
        // ═══════════════════════════════════════════════════════════════════════════
        
        let full_count = eligible_full_nodes as u64;
        let super_count = eligible_super_nodes as u64;
        let total_count = total_eligible_nodes as u64;
        
        // Pool 1: Base emission with remainder
        let pool1_total = self.calculate_pool1_base_emission() + self.pool1_remainder;
        let pool1_per_node = if total_count > 0 { pool1_total / total_count } else { 0 };
        let pool1_new_remainder = if total_count > 0 { pool1_total % total_count } else { pool1_total };
        
        // Pool 2: Calculate shares based on node availability
        let (pool2_full_share, pool2_super_share) = match (full_count > 0, super_count > 0) {
            (true, true) => (pool2_fees * 30 / 100, pool2_fees * 70 / 100),
            (false, true) => (0, pool2_fees), // All to Super
            (true, false) => (pool2_fees, 0), // All to Full
            (false, false) => (0, 0),         // No validators (shouldn't happen)
        };
        
        let pool2_per_full = if full_count > 0 { pool2_full_share / full_count } else { 0 };
        let pool2_per_super = if super_count > 0 { pool2_super_share / super_count } else { 0 };
        
        // Calculate remainders
        let pool2_full_new_remainder = if full_count > 0 { pool2_full_share % full_count } else { pool2_full_share };
        let pool2_super_new_remainder = if super_count > 0 { pool2_super_share % super_count } else { pool2_super_share };
        
        // Pool 3: Equal distribution to all nodes (Phase 2 only)
        let pool3_per_node = match current_phase {
            QNetPhase::Phase1 => 0,
            QNetPhase::Phase2 => if total_count > 0 { pool3_activations / total_count } else { 0 },
        };
        let pool3_new_remainder = match current_phase {
            QNetPhase::Phase1 => 0,
            QNetPhase::Phase2 => if total_count > 0 { pool3_activations % total_count } else { pool3_activations },
        };
        
        println!("[INFO][REWARDS] distribution pool1_per={} pool2_full={} pool2_super={} pool3_per={}", 
                 pool1_per_node, pool2_per_full, pool2_per_super, pool3_per_node);
        println!("[INFO][REWARDS] remainders pool1={} pool2_full={} pool2_super={} pool3={} (carried to next)",
                 pool1_new_remainder, pool2_full_new_remainder, pool2_super_new_remainder, pool3_new_remainder);
        
        // v2.84: Track emission for THIS EPOCH ONLY (for RewardDistribution TX)
        let mut epoch_emission: u64 = 0;
        
        // Calculate rewards for each eligible node
        for summary in heartbeat_summaries {
            if summary.is_eligible {
                let node_type = match summary.node_type {
                    0 => NodeType::Light,
                    1 => NodeType::Full,
                    2 => NodeType::Super,
                    _ => NodeType::Full,
                };
                
                // Pool 2 reward based on node type
                let pool2_reward = match node_type {
                    NodeType::Light => 0,
                    NodeType::Full => pool2_per_full,
                    NodeType::Super => pool2_per_super,
                };
                
                // Pool 3 reward (equal for all in Phase 2)
                let pool3_reward = match current_phase {
                    QNetPhase::Phase1 => 0,
                    QNetPhase::Phase2 => pool3_per_node,
                };
                
                let total_reward = pool1_per_node + pool2_reward + pool3_reward;
                
                let reward = PhaseAwareReward {
                    current_phase: current_phase.clone(),
                    pool1_base_emission: pool1_per_node,
                    pool2_transaction_fees: pool2_reward,
                    pool3_activation_bonus: pool3_reward,
                    total_reward,
                };
                
                // v2.84: Track emission for THIS EPOCH (before accumulation)
                epoch_emission += total_reward;
                
                // v2.67: CRITICAL FIX - Accumulate rewards instead of overwriting!
                // This ensures unclaimed rewards from previous epochs are preserved
                self.pending_rewards
                    .entry(summary.node_id.clone())
                    .and_modify(|existing| {
                        // Accumulate all pools
                        existing.pool1_base_emission += reward.pool1_base_emission;
                        existing.pool2_transaction_fees += reward.pool2_transaction_fees;
                        existing.pool3_activation_bonus += reward.pool3_activation_bonus;
                        existing.total_reward += reward.total_reward;
                        // Update phase to current (rewards span multiple phases)
                        existing.current_phase = reward.current_phase.clone();
                        
                        println!("[INFO][REWARDS] accumulated node={} new={} total={}", 
                                &summary.node_id[..16.min(summary.node_id.len())],
                                total_reward / 1_000_000_000,
                                existing.total_reward / 1_000_000_000);
                    })
                    .or_insert(reward);
            }
        }
        
        // v2.84: Store epoch emission for RewardDistribution TX
        self.last_epoch_emission = epoch_emission;
        println!("[INFO][REWARDS] epoch_emission={} QNC (this epoch only)", 
                 epoch_emission / 1_000_000_000);
        
        // v2.51.1: Store remainders for next emission period
        self.pool1_remainder = pool1_new_remainder;
        self.pool2_full_remainder = pool2_full_new_remainder;
        self.pool2_super_remainder = pool2_super_new_remainder;
        self.pool3_remainder = pool3_new_remainder;
        
        let total_remainder = pool1_new_remainder + pool2_full_new_remainder + pool2_super_new_remainder + pool3_new_remainder;
        
        println!("[INFO][REWARDS] macroblock_rewards_calculated nodes={} total_remainder={} nanoQNC (carried forward)", 
                 self.pending_rewards.len(), total_remainder);
        
        // Reset LOCAL transaction fees (they're distributed via MacroBlock now)
        self.pool2_transaction_fees = 0;
        
        // Reset LOCAL Pool 3 if Phase 2 (distributed via MacroBlock)
        if current_phase == QNetPhase::Phase2 {
            self.pool3_activation_pool = 0;
        }
        
        // v2.90: Mark MacroBlock as processed to prevent double-processing
        // Only for real MacroBlocks (index > 0), not legacy path
        if macroblock_index > 0 {
            self.processed_emission_macroblocks.insert(macroblock_index);
            println!("[INFO][REWARDS] mb={} MARKED_AS_PROCESSED (total_processed={})", 
                     macroblock_index, self.processed_emission_macroblocks.len());
        }
        
        Ok(())
    }
    
    /// v2.50.0: Calculate node reward with explicit pool values (deterministic)
    /// 
    /// CRITICAL FIX v2.51: Proper redistribution when one node type has 0 eligible nodes
    /// - If 0 Full nodes: their 30% goes to Super nodes
    /// - If 0 Super nodes: their 70% goes to Full nodes  
    /// - If 0 both: Pool 2 goes to next emission period (not implemented yet, funds lost)
    /// NOTE: Kept for reference/documentation - main logic in process_macroblock_heartbeats_deterministic
    #[allow(dead_code)]
    fn calculate_node_reward_with_pools(
        &self,
        node_type: &NodeType,
        current_phase: &QNetPhase,
        total_eligible_nodes: u32,
        eligible_full_nodes: u32,
        eligible_super_nodes: u32,
        pool2_fees: u64,
        pool3_activations: u64,
    ) -> PhaseAwareReward {
        // Pool 1: Dynamic base emission (equal share for all eligible nodes)
        let pool1_base_emission = if total_eligible_nodes > 0 {
            self.calculate_pool1_base_emission() / total_eligible_nodes as u64
        } else {
            0
        };
        
        // ═══════════════════════════════════════════════════════════════════
        // Pool 2: Transaction fees with REDISTRIBUTION
        // Normal: 30% Full nodes, 70% Super nodes
        // If 0 Full nodes: 100% to Super nodes
        // If 0 Super nodes: 100% to Full nodes
        // If 0 both: remainder accumulation handles this (see process_macroblock_heartbeats_deterministic)
        // ═══════════════════════════════════════════════════════════════════
        let pool2_transaction_fees = {
            let full_count = eligible_full_nodes as u64;
            let super_count = eligible_super_nodes as u64;
            
            match (full_count > 0, super_count > 0) {
                // Normal case: both types have eligible nodes
                (true, true) => {
                    match node_type {
                        NodeType::Light => 0, // 0% for Light nodes
                        NodeType::Full => {
                            // 30% to Full nodes, divided equally
                            (pool2_fees * 30 / 100) / full_count
                        },
                        NodeType::Super => {
                            // 70% to Super nodes, divided equally
                            (pool2_fees * 70 / 100) / super_count
                        },
                    }
                },
                // No Full nodes: Super nodes get 100%
                (false, true) => {
                    match node_type {
                        NodeType::Light => 0,
                        NodeType::Full => 0, // No Full nodes eligible
                        NodeType::Super => {
                            // 100% to Super nodes (30% + 70%)
                            pool2_fees / super_count
                        },
                    }
                },
                // No Super nodes: Full nodes get 100%
                (true, false) => {
                    match node_type {
                        NodeType::Light => 0,
                        NodeType::Full => {
                            // 100% to Full nodes (30% + 70%)
                            pool2_fees / full_count
                        },
                        NodeType::Super => 0, // No Super nodes eligible
                    }
                },
                // No validators at all: handled by remainder accumulation in main logic
                (false, false) => {
                    // NOTE: This branch is only reached in legacy code path
                    // Main logic (process_macroblock_heartbeats_deterministic) handles this
                    // by accumulating remainders for next emission period
                    0
                },
            }
        };
        
        // Pool 3: Activation pool (ONLY in Phase 2, equal share for all eligible nodes)
        // Uses DETERMINISTIC value from MacroBlock
        let pool3_activation_bonus = match current_phase {
            QNetPhase::Phase1 => 0, // Pool 3 DISABLED in Phase 1
            QNetPhase::Phase2 => {
                if total_eligible_nodes > 0 {
                    pool3_activations / total_eligible_nodes as u64
                } else {
                    0
                }
            }
        };
        
        let total_reward = pool1_base_emission + pool2_transaction_fees + pool3_activation_bonus;
        
        PhaseAwareReward {
            current_phase: current_phase.clone(),
            pool1_base_emission,
            pool2_transaction_fees,
            pool3_activation_bonus,
            total_reward,
        }
    }
}

/// Heartbeat summary data for cross-crate compatibility
/// Mirrors qnet_state::HeartbeatSummary but without dependency
#[derive(Debug, Clone)]
pub struct HeartbeatSummaryData {
    pub node_id: String,
    pub node_type: u8,
    pub heartbeat_count: u8,
    pub first_heartbeat: u64,
    pub last_heartbeat: u64,
    pub is_eligible: bool,
}

/// Phase-aware reward statistics
#[derive(Debug, Clone)]
pub struct PhaseAwareRewardStats {
    pub current_phase: QNetPhase,
    pub current_window_start: u64,
    pub pool1_current_emission: u64,
    pub pool2_transaction_fees: u64,
    pub pool3_activation_pool: u64,
    pub total_pending_rewards: u64,
    pub nodes_with_pending_rewards: usize,
    pub active_ping_histories: usize,
    pub dev_burn_percentage: f64,
}

/// Production initialization
pub fn create_production_phase_aware_rewards(genesis_timestamp: u64) -> PhaseAwareRewardManager {
    PhaseAwareRewardManager::new(genesis_timestamp)
}
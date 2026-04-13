//! QNet Phase-Aware Three-Pool Reward System
//! Phase 1: 1DEV burn-to-join, Pool 3 DISABLED
//! Phase 2: QNC spend-to-Pool3, Pool 3 ENABLED
//! Pool 1: Dynamic base emission with sharp drop halving
//! Pool 2: REMOVED in v3.18 - transaction fees go directly to block producer
//! Pool 3: Activation pool (ONLY in Phase 2)

use std::collections::{BTreeMap, HashMap, HashSet};
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
/// v3.18: Full node type REMOVED - only Light and Super remain
pub enum NodeType {
    Light,
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
            NodeType::Super => Self {
                pings_per_4h_window: 10,     // 10 pings per 4 hours (every 24 minutes) - REDUCED for scalability
                success_rate_threshold: 0.9, // 90% (9+ out of 10) - Super nodes require higher reliability
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
            NodeType::Super => {
                // Super nodes: percentage success rate
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
    /// PRODUCTION: BTreeMap for deterministic iteration order across all nodes
    pending_rewards: BTreeMap<String, PhaseAwareReward>,
    
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
    
    /// v7.0: Per-node DELTA accruals for the last emission epoch.
    /// Keyed by node_id, value is the nanoQNC added in THIS epoch only.
    /// Used to populate the emission TX data field so all nodes apply
    /// identical reward accruals through deterministic block execution.
    /// PRODUCTION: BTreeMap for deterministic iteration order in emission TX
    last_epoch_accruals: BTreeMap<String, u64>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v2.90: PREVENT DOUBLE-PROCESSING OF EMISSION MACROBLOCKS
    // CRITICAL BUG FIX: Without this, node restarts cause duplicate rewards!
    // Each emission MacroBlock (160, 320, 480...) must be processed EXACTLY ONCE
    // This set tracks which MacroBlocks have been processed to prevent accumulation bugs
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Set of processed emission MacroBlock indices (160, 320, 480, 640...)
    /// Prevents double-processing on node restart or MacroBlock re-sync
    processed_emission_macroblocks: HashSet<u64>,

    /// Last cleanup timestamp for stale node entries
    last_stale_cleanup: u64,
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
            pending_rewards: BTreeMap::new(),
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
            // v7.0: Per-node delta accruals for emission TX
            last_epoch_accruals: BTreeMap::new(),
            // v2.90: Track processed emission MacroBlocks to prevent duplicates
            processed_emission_macroblocks: HashSet::new(),
            last_stale_cleanup: 0,
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

        // CRITICAL: genesis_timestamp=0 means genesis block not yet received (sentinel).
        // In that case return 0 (year 0 = no halving = full emission).
        // Without this guard, unix_epoch(0) as genesis gives ~56 years → 14 halvings → 3 QNC instead of 251k QNC.
        if self.genesis_timestamp == 0 {
            return 0;
        }

        if now > self.genesis_timestamp {
            (now - self.genesis_timestamp) / (365 * 24 * 60 * 60)
        } else {
            0
        }
    }

    /// Calculate dynamic Pool 1 base emission with sharp drop halving
    /// PRODUCTION: Pure integer arithmetic for cross-platform determinism.
    /// 251,432.34 QNC = 251_432_340_000_000 nanoQNC (10^9 precision)
    fn calculate_pool1_base_emission(&self) -> u64 {
        let years_since_genesis = self.calculate_years_since_genesis();
        let halving_cycles = years_since_genesis / 4;

        // Base emission in nanoQNC: 251,432.34 QNC × 10^9
        const BASE_EMISSION_NANO: u128 = 251_432_340_000_000;

        // FIX R20-L1: Correct branch ordering — >= 50 check BEFORE > 5
        // to ensure zero-emission safety net is reachable after ~200 years
        let emission_nano: u128 = if halving_cycles >= 50 {
            // Emission effectively zero after ~200+ years (integer division
            // already yields 0 well before this, but explicit guard is cleaner)
            0
        } else if halving_cycles == 5 {
            // 5th halving (year 20-24): Sharp drop — ÷16 (4 halvings) then ÷10
            // Divisor = 2^4 × 10 = 160
            BASE_EMISSION_NANO / 160
        } else if halving_cycles > 5 {
            // After sharp drop: Resume normal halving from low base
            // Divisor = 160 × 2^(cycles-5)
            let normal_halvings = (halving_cycles - 5).min(63);
            let divisor = 160u128.saturating_mul(1u128 << normal_halvings);
            BASE_EMISSION_NANO / divisor.max(1)
        } else {
            // Normal halving for first 5 cycles (0-20 years)
            // Divisor = 2^halving_cycles
            let divisor = 1u128 << halving_cycles.min(63);
            BASE_EMISSION_NANO / divisor
        };

        // Safe downcast: max value 251T nanoQNC << u64::MAX (18.4E)
        emission_nano as u64
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
        
        // v7.0: BUGFIX — Removed legacy process_reward_window() call.
        // It called process_macroblock_heartbeats_deterministic(0, ...) which bypassed
        // dedup (macroblock_index=0 skips the >0 check), causing duplicate reward
        // accumulation for light nodes only (genesis nodes never re-register here).
        // Rewards are now processed exclusively through MacroBlock consensus path.
        if window_start > self.current_window_start {
            self.ping_histories.clear();
            self.current_window_start = window_start;
        }
        
        // FIXED: Store wallet ownership for reward claims
        self.node_ownership.insert(node_id.clone(), wallet_address.clone());
        
        // PRODUCTION v2.43.1: Update inverted index for O(1) wallet->nodes lookup
        // FIX R23-R3: Dedup — prevent duplicate node_id entries on re-registration
        let nodes = self.wallet_nodes_index
            .entry(wallet_address.clone())
            .or_insert_with(Vec::new);
        if !nodes.contains(&node_id) {
            nodes.push(node_id.clone());
        }
        
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
    
    /// DEPRECATED v7.0: Legacy reward window processing removed.
    /// Rewards are now processed exclusively via MacroBlock consensus path
    /// (process_macroblock_heartbeats_deterministic with real macroblock_index > 0).
    /// This function used macroblock_index=0 which bypassed dedup, causing 13x reward
    /// inflation for light nodes. Kept as no-op for force_process_window() compat.
    fn process_reward_window(&mut self) -> Result<(), ConsensusError> {
        self.ping_histories.clear();
        Ok(())
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
        self.pool2_transaction_fees = self.pool2_transaction_fees.saturating_add(amount);
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
                self.pool3_activation_pool = self.pool3_activation_pool.saturating_add(amount);
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
                // FIX R14-L2: defensive — should exist from match above
                match self.pending_rewards.remove(node_id) {
                    Some(reward) => reward,
                    None => return RewardClaimResult {
                        success: false,
                        reward: None,
                        message: "[ERR][REWARDS] pending_reward_disappeared".to_string(),
                        next_claim_time: current_time + self.min_claim_interval.as_secs(),
                    },
                }
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

    /// Update genesis timestamp (called when genesis block is received from network)
    /// CRITICAL: Must be called whenever GLOBAL_GENESIS_TIMESTAMP is set to non-zero value,
    /// otherwise calculate_pool1_base_emission() uses unix_epoch as genesis → years=56 → wrong halving
    pub fn update_genesis_timestamp(&mut self, ts: u64) {
        if ts > 0 && ts != self.genesis_timestamp {
            println!("[INFO][REWARDS] genesis_ts_updated old={} new={}", self.genesis_timestamp, ts);
            self.genesis_timestamp = ts;
        }
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
            .fold(0u64, |acc, r| acc.saturating_add(r));
        
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
    
    /// FIX R20-H2: Add external remainder from shard processing
    /// Called by reward_sharding to carry forward truncation remainders
    pub fn add_pool1_remainder(&mut self, amount: u64) {
        self.pool1_remainder = self.pool1_remainder.saturating_add(amount);
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
    
    /// v7.0: Get per-node delta accruals for the last processed emission epoch.
    /// Returns node_id → delta_nanoQNC. Used by block producer to include in
    /// emission TX data for deterministic block-level application.
    pub fn get_last_epoch_accruals(&self) -> &BTreeMap<String, u64> {
        &self.last_epoch_accruals
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
    
    /// Cleanup stale entries from unbounded HashMaps.
    /// Removes nodes that have no pending rewards AND no recent ping history.
    /// Called periodically (every 24h) to prevent memory growth over months/years.
    /// PRODUCTION: Safe for thousands of nodes — only removes truly inactive entries.
    pub fn cleanup_stale_entries(&mut self) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Run at most once per 24 hours
        const CLEANUP_INTERVAL_SECS: u64 = 86_400;
        if now.saturating_sub(self.last_stale_cleanup) < CLEANUP_INTERVAL_SECS {
            return;
        }
        self.last_stale_cleanup = now;

        // Stale threshold: nodes not seen for 7 days with zero pending rewards
        const STALE_THRESHOLD_SECS: u64 = 7 * 86_400;

        // Collect stale node IDs: no pending reward AND no recent ping
        let stale_nodes: Vec<String> = self.node_ownership.keys()
            .filter(|node_id| {
                // Keep if has pending rewards
                if self.pending_rewards.get(*node_id)
                    .map(|r| r.total_reward > 0)
                    .unwrap_or(false)
                {
                    return false;
                }
                // Keep if has recent ping history (window_start within threshold)
                if let Some(history) = self.ping_histories.get(*node_id) {
                    if now.saturating_sub(history.window_start) < STALE_THRESHOLD_SECS {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect();

        if stale_nodes.is_empty() {
            return;
        }

        let count = stale_nodes.len();
        for node_id in &stale_nodes {
            // Remove from all maps
            self.node_ownership.remove(node_id);
            self.ping_histories.remove(node_id);
            self.pending_rewards.remove(node_id);
            self.last_claim_time.remove(node_id);

            // Remove from wallet_nodes_index
            // Find wallet first, then remove from its node list
            // (we iterate wallet_nodes_index to find entries containing this node_id)
        }

        // Cleanup wallet_nodes_index: remove stale node_ids from vectors
        let stale_set: HashSet<&String> = stale_nodes.iter().collect();
        self.wallet_nodes_index.retain(|_wallet, nodes| {
            nodes.retain(|nid| !stale_set.contains(nid));
            !nodes.is_empty()
        });

        // Bound processed_emission_macroblocks: keep only last 1000
        if self.processed_emission_macroblocks.len() > 1000 {
            let mut sorted: Vec<u64> = self.processed_emission_macroblocks.iter().copied().collect();
            sorted.sort_unstable();
            let keep_from = sorted[sorted.len() - 1000];
            self.processed_emission_macroblocks.retain(|&idx| idx >= keep_from);
        }

        println!("[INFO][REWARDS] stale_cleanup removed={} remaining_ownership={} remaining_pending={}",
                 count, self.node_ownership.len(), self.pending_rewards.len());
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
    /// Uses wallet_nodes_index for O(1) lookup instead of O(n) scan
    pub fn get_nodes_by_wallet(&self, wallet_address: &str) -> Vec<(String, NodeType, u64)> {
        let node_ids = match self.wallet_nodes_index.get(wallet_address) {
            Some(ids) => ids.clone(),
            None => return Vec::new(),
        };
        
        node_ids.iter()
            .filter_map(|node_id| {
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
        // v2.96: Returns bool (was_processed), but legacy path always processes
        self.process_macroblock_heartbeats_deterministic(
            0,  // Legacy: not from MacroBlock, use 0 as sentinel
            heartbeat_summaries,
            Some(self.pool2_transaction_fees),
            Some(self.pool3_activation_pool),
        ).map(|_| ()) // Convert Result<bool, _> to Result<(), _> for compatibility
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
    /// Note: pool2_total kept for backward compatibility but always ignored (Pool 2 removed in v3.18)
    pub fn process_macroblock_heartbeats_deterministic(
        &mut self,
        macroblock_index: u64,
        heartbeat_summaries: &[HeartbeatSummaryData],
        _pool2_total: Option<u64>, // v3.18: Pool 2 removed - ignored
        pool3_total: Option<u64>,
    ) -> Result<bool, ConsensusError> {
        // v2.90: CRITICAL - Prevent double-processing of emission MacroBlocks!
        // Without this check, node restarts cause duplicate rewards
        // macroblock_index=0 is sentinel for legacy path (skip duplicate check)
        // v2.96: Return false to signal "already processed" vs true for "processed now"
        if macroblock_index > 0 && self.processed_emission_macroblocks.contains(&macroblock_index) {
            println!("[WARN][REWARDS] mb={} ALREADY_PROCESSED skipping (prevents duplicate rewards)", macroblock_index);
            return Ok(false); // Return false = already processed, don't update supply/storage again
        }
        
        // v3.0: CRITICAL - DELAYED REWARDS ARCHITECTURE
        // Rewards are delayed by 1 epoch (4 hours / 14400 blocks / 160 MacroBlocks)
        // 
        // Timeline:
        //   MB 160 (epoch=1): NO rewards - first emission MB but no completed epoch to reward
        //   MB 320 (epoch=2): First rewards for epoch 0
        //   MB 480 (epoch=3): Rewards for epoch 1
        //
        // epoch = macroblock_index / 160
        // We need epoch >= 2 to have a completed epoch (epoch - 2) to reward
        const MACROBLOCKS_PER_EPOCH: u64 = 160;
        let current_epoch = macroblock_index / MACROBLOCKS_PER_EPOCH;
        
        if macroblock_index > 0 && current_epoch < 2 {
            println!("[INFO][REWARDS] mb={} epoch={} SKIP_REWARD_ACCUMULATION (delayed rewards: need epoch>=2)", 
                     macroblock_index, current_epoch);
            // Mark as processed to prevent re-processing, but don't accumulate rewards
            self.processed_emission_macroblocks.insert(macroblock_index);
            return Ok(false);
        }
        
        let current_phase = self.get_current_phase();
        
        // v3.18: Pool 2 removed - fees go directly to block producer
        let _pool2_fees = 0; // Kept for backward compatibility
        // Use MacroBlock values if provided, otherwise fall back to local (legacy)
        // v2.51.1: Add accumulated remainders from previous period
        let pool3_activations = pool3_total.unwrap_or(self.pool3_activation_pool)
            .saturating_add(self.pool3_remainder);
        
        // Count eligible nodes from MacroBlock data
        let mut eligible_light_nodes = 0u32;
        let mut eligible_super_nodes = 0u32;
        
        // v3.18: Full nodes removed - node_type 1 is ignored
        for summary in heartbeat_summaries {
            if summary.is_eligible {
                match summary.node_type {
                    0 => eligible_light_nodes += 1,  // Light
                    2 => eligible_super_nodes += 1,  // Super
                    _ => {} // Ignore node_type 1 (Full) and unknown types
                }
            }
        }
        
        let total_eligible_nodes = eligible_light_nodes + eligible_super_nodes;
        
        if total_eligible_nodes == 0 {
            // FIX R20-M3: Carry forward ALL pool remainders when no eligible nodes
            // Previously Pool 1 emission was lost (remainder zeroed). Now carry forward
            // so emission is deferred, not discarded.
            let pool1_emission = self.calculate_pool1_base_emission();
            let pool1_carry = pool1_emission.saturating_add(self.pool1_remainder);
            self.pool1_remainder = pool1_carry;
            // v3.18: Pool 2 removed — fees go to block producer, no remainder needed
            self.pool2_full_remainder = 0;
            self.pool2_super_remainder = 0;
            self.pool3_remainder = pool3_activations;
            println!("[WARN][REWARDS] no_eligible_nodes pool1_carried={} pool3_carried={}",
                     pool1_carry, pool3_activations);
            // v2.96: Return true = processed (emission deferred, not lost)
            return Ok(true);
        }
        
        // ═══════════════════════════════════════════════════════════════════════════
        // v2.51.1: REMAINDER-AWARE DISTRIBUTION
        // Calculate total distribution and remainders for each pool
        // ═══════════════════════════════════════════════════════════════════════════
        
        // v3.18: Full nodes removed - super_count kept for future use
        let _super_count = eligible_super_nodes as u64;
        let total_count = total_eligible_nodes as u64;
        
        // Pool 1: Base emission with remainder
        let pool1_total = self.calculate_pool1_base_emission().saturating_add(self.pool1_remainder);
        let pool1_per_node = if total_count > 0 { pool1_total / total_count } else { 0 };
        let pool1_new_remainder = if total_count > 0 { pool1_total % total_count } else { pool1_total };
        
        // v3.18: Pool 2 REMOVED - fees go directly to block producer
        // All Pool 2 values are always 0 (kept for backward compatibility)
        let pool2_per_full = 0;
        let pool2_per_super = 0;
        let pool2_full_new_remainder = 0;
        let pool2_super_new_remainder = 0;
        
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
        
        // v7.0: Clear previous epoch accruals — will be populated below
        self.last_epoch_accruals.clear();
        
        // Calculate rewards for each eligible node
        for summary in heartbeat_summaries {
            if summary.is_eligible {
                // v3.18: node_type no longer used for Pool 2 distribution (removed)
                let _node_type = match summary.node_type {
                    0 => NodeType::Light,
                    1 => NodeType::Super,
                    _ => NodeType::Super,
                };
                
                // v3.18: Pool 2 removed - fees go directly to block producer
                let pool2_reward: u64 = 0;
                
                // Pool 3 reward (equal for all in Phase 2)
                let pool3_reward = match current_phase {
                    QNetPhase::Phase1 => 0,
                    QNetPhase::Phase2 => pool3_per_node,
                };
                
                let total_reward = pool1_per_node.saturating_add(pool2_reward).saturating_add(pool3_reward);
                
                let reward = PhaseAwareReward {
                    current_phase: current_phase.clone(),
                    pool1_base_emission: pool1_per_node,
                    pool2_transaction_fees: pool2_reward,
                    pool3_activation_bonus: pool3_reward,
                    total_reward,
                };
                
                // v2.84: Track emission for THIS EPOCH (before accumulation)
                epoch_emission = epoch_emission.saturating_add(total_reward);
                
                // v7.0: Track per-node DELTA for emission TX
                self.last_epoch_accruals.insert(summary.node_id.clone(), total_reward);
                
                // v2.67: CRITICAL FIX - Accumulate rewards instead of overwriting!
                // This ensures unclaimed rewards from previous epochs are preserved
                self.pending_rewards
                    .entry(summary.node_id.clone())
                    .and_modify(|existing| {
                        existing.pool1_base_emission = existing.pool1_base_emission.saturating_add(reward.pool1_base_emission);
                        existing.pool2_transaction_fees = existing.pool2_transaction_fees.saturating_add(reward.pool2_transaction_fees);
                        existing.pool3_activation_bonus = existing.pool3_activation_bonus.saturating_add(reward.pool3_activation_bonus);
                        existing.total_reward = existing.total_reward.saturating_add(reward.total_reward);
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
        
        // Periodic cleanup of stale node entries (runs at most once per 24h)
        self.cleanup_stale_entries();

        // v2.96: Return true = processed successfully (caller should update supply/storage)
        Ok(true)
    }
    
    /// v2.50.0: Calculate node reward with explicit pool values (deterministic)
    /// 
    /// CRITICAL FIX v2.51: Proper redistribution when one node type has 0 eligible nodes
    /// - If 0 Full nodes: their 30% goes to Super nodes
    /// NOTE: Kept for reference/documentation - main logic in process_macroblock_heartbeats_deterministic
    /// v3.18: Pool 2 removed - this function is deprecated but kept for backward compatibility
    #[allow(dead_code)]
    fn calculate_node_reward_with_pools(
        &self,
        _node_type: &NodeType,           // v3.18: Not used after Pool 2 removal
        current_phase: &QNetPhase,
        total_eligible_nodes: u32,
        _eligible_full_nodes: u32,       // v3.18: Full nodes removed
        _eligible_super_nodes: u32,      // v3.18: Not used after Pool 2 removal
        _pool2_fees: u64,                // v3.18: Pool 2 removed
        pool3_activations: u64,
    ) -> PhaseAwareReward {
        // Pool 1: Dynamic base emission (equal share for all eligible nodes)
        let pool1_base_emission = if total_eligible_nodes > 0 {
            self.calculate_pool1_base_emission() / total_eligible_nodes as u64
        } else {
            0
        };
        
        // v3.18: Pool 2 REMOVED - fees go directly to block producer
        // This function now always returns 0 for backward compatibility
        let pool2_transaction_fees = 0;
        
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
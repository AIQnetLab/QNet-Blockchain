//! QNet Phase-Aware Three-Pool Reward System
//! Phase 1: 1DEV burn-to-join, Pool 3 DISABLED
//! Phase 2: QNC spend-to-Pool3, Pool 3 ENABLED
//! Pool 1: Dynamic base emission with sharp drop halving
//! Pool 2: Transaction fees (70% Super, 30% Full, 0% Light)
//! Pool 3: Activation pool (ONLY in Phase 2)

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use crate::errors::ConsensusError;

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
                pings_per_4h_window: 60,     // 60 pings per 4 hours (every 4 minutes)
                success_rate_threshold: 0.95, // 95% (57+ out of 60)
                timeout_seconds: 30,         // 30 seconds to respond
            },
            NodeType::Super => Self {
                pings_per_4h_window: 60,     // 60 pings per 4 hours (every 4 minutes)
                success_rate_threshold: 0.98, // 98% (59+ out of 60)
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
            .unwrap()
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
                // Light nodes: binary success (1 ping, must succeed)
                total_pings == 1 && successful_pings == 1
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
    
    /// Pending rewards by node_id
    pending_rewards: HashMap<String, PhaseAwareReward>,
    
    /// Last claim time by node_id
    last_claim_time: HashMap<String, u64>,
    
    /// Pool 2: Transaction fees
    pool2_transaction_fees: u64,
    
    /// Pool 3: Activation pool (only works in Phase 2)
    pool3_activation_pool: u64,
    
    /// Phase transition parameters
    dev_burn_percentage: f64,  // Current 1DEV burn percentage
    years_since_launch: u64,   // Years since QNet launch
    
    /// Minimum claim interval (prevent spam)
    min_claim_interval: Duration,
}

impl PhaseAwareRewardManager {
    /// Create new phase-aware reward manager
    pub fn new(genesis_timestamp: u64) -> Self {
        let current_window_start = Self::get_current_window_start();
        
        Self {
            genesis_timestamp,
            current_window_start,
            ping_histories: HashMap::new(),
            pending_rewards: HashMap::new(),
            last_claim_time: HashMap::new(),
            pool2_transaction_fees: 0,
            pool3_activation_pool: 0,
            dev_burn_percentage: 0.0,
            years_since_launch: 0,
            min_claim_interval: Duration::from_secs(3600), // 1 hour minimum
        }
    }
    
    /// Get current 4-hour window start time
    fn get_current_window_start() -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
            
        // Round down to nearest 4-hour boundary
        now - (now % (4 * 60 * 60))
    }
    
    /// Calculate years since genesis timestamp
    fn calculate_years_since_genesis(&self) -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
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
            245_100.67 / (2.0_f64.powi(4) * 10.0) // Previous 4 halvings (÷2) then sharp drop (÷10)
        } else if halving_cycles > 5 {
            // After sharp drop: Resume normal halving from new low base
            let normal_halvings = halving_cycles - 5;
            245_100.67 / (2.0_f64.powi(4) * 10.0 * 2.0_f64.powi(normal_halvings as i32))
        } else {
            // Normal halving for first 5 cycles (20 years)
            245_100.67 / (2.0_f64.powi(halving_cycles as i32))
        };
        
        // Convert to microQNC (10^6 precision)
        (base_rate * 1_000_000.0) as u64
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
    
    /// Register node for current reward window
    pub fn register_node(&mut self, node_id: String, node_type: NodeType) -> Result<(), ConsensusError> {
        let window_start = Self::get_current_window_start();
        
        // Check if we need to start a new reward window
        if window_start > self.current_window_start {
            self.process_reward_window()?;
            self.current_window_start = window_start;
        }
        
        // Create ping history for this node
        let ping_history = NodePingHistory::new(node_id.clone(), node_type, window_start);
        self.ping_histories.insert(node_id, ping_history);
        
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
    fn process_reward_window(&mut self) -> Result<(), ConsensusError> {
        let current_phase = self.get_current_phase();
        
        // Count eligible nodes (those who met ping requirements)
        let mut eligible_light_nodes = 0u32;
        let mut eligible_full_nodes = 0u32;
        let mut eligible_super_nodes = 0u32;
        
        for ping_history in self.ping_histories.values() {
            if ping_history.meets_requirements() {
                match ping_history.node_type {
                    NodeType::Light => eligible_light_nodes += 1,
                    NodeType::Full => eligible_full_nodes += 1,
                    NodeType::Super => eligible_super_nodes += 1,
                }
            }
        }
        
        let total_eligible_nodes = eligible_light_nodes + eligible_full_nodes + eligible_super_nodes;
        
        if total_eligible_nodes == 0 {
            // No eligible nodes, skip reward distribution
            self.ping_histories.clear();
            return Ok(());
        }
        
        // Calculate rewards for each eligible node
        for (node_id, ping_history) in &self.ping_histories {
            if ping_history.meets_requirements() {
                let reward = self.calculate_node_reward(
                    &ping_history.node_type,
                    &current_phase,
                    total_eligible_nodes,
                    eligible_full_nodes,
                    eligible_super_nodes,
                );
                
                self.pending_rewards.insert(node_id.clone(), reward);
            }
        }
        
        // Clear ping histories for next window
        self.ping_histories.clear();
        
        // Reset transaction fees (they're distributed)
        self.pool2_transaction_fees = 0;
        
        // Reset Pool 3 if Phase 2 (it's distributed)
        if current_phase == QNetPhase::Phase2 {
            self.pool3_activation_pool = 0;
        }
        
        Ok(())
    }
    
    /// Calculate reward for a single node
    fn calculate_node_reward(
        &self,
        node_type: &NodeType,
        current_phase: &QNetPhase,
        total_eligible_nodes: u32,
        eligible_full_nodes: u32,
        eligible_super_nodes: u32,
    ) -> PhaseAwareReward {
        // Pool 1: Dynamic base emission (equal share for all eligible nodes)
        let pool1_base_emission = if total_eligible_nodes > 0 {
            self.calculate_pool1_base_emission() / total_eligible_nodes as u64
        } else {
            0
        };
        
        // Pool 2: Transaction fees (only Full and Super nodes)
        let pool2_transaction_fees = match node_type {
            NodeType::Light => 0,
            NodeType::Full => {
                if eligible_full_nodes > 0 {
                    (self.pool2_transaction_fees * 30 / 100) / eligible_full_nodes as u64
                } else {
                    0
                }
            },
            NodeType::Super => {
                if eligible_super_nodes > 0 {
                    (self.pool2_transaction_fees * 70 / 100) / eligible_super_nodes as u64
                } else {
                    0
                }
            },
        };
        
        // Pool 3: Activation pool (ONLY in Phase 2, equal share for all eligible nodes)
        let pool3_activation_bonus = match current_phase {
            QNetPhase::Phase1 => 0, // Pool 3 DISABLED in Phase 1
            QNetPhase::Phase2 => {
                if total_eligible_nodes > 0 {
                    self.pool3_activation_pool / total_eligible_nodes as u64
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
    
    /// Claim rewards for a node
    pub fn claim_rewards(&mut self, node_id: &str) -> RewardClaimResult {
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
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
        let reward = match self.pending_rewards.remove(node_id) {
            Some(reward) => reward,
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
        let years_since_genesis = self.calculate_years_since_genesis();
            
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
            years_since_launch: years_since_genesis,
        }
    }
    
    /// Force process current reward window (for testing)
    pub fn force_process_window(&mut self) -> Result<(), ConsensusError> {
        self.process_reward_window()
    }
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
    pub years_since_launch: u64,
}

/// Production initialization
pub fn create_production_phase_aware_rewards(genesis_timestamp: u64) -> PhaseAwareRewardManager {
    PhaseAwareRewardManager::new(genesis_timestamp)
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_phase_aware_rewards() {
        // Test Phase 1 (Pool 3 disabled)
        let mut manager = PhaseAwareRewardManager::new(1640995200); // 2022-01-01
        manager.update_phase_parameters(15.0, 0); // 15% burned, 0 years
        
        // Register nodes
        manager.register_node("light1".to_string(), NodeType::Light).unwrap();
        manager.register_node("full1".to_string(), NodeType::Full).unwrap();
        manager.register_node("super1".to_string(), NodeType::Super).unwrap();
        
        // Add transaction fees
        manager.add_transaction_fees(10000);
        
        // Try to add to Pool 3 (should fail in Phase 1)
        assert!(manager.add_activation_qnc(5000).is_err());
        
        // Record successful pings
        manager.record_ping_attempt("light1", true, 100).unwrap();
        for _ in 0..60 {
            manager.record_ping_attempt("full1", true, 50).unwrap();
            manager.record_ping_attempt("super1", true, 25).unwrap();
        }
        
        // Process rewards
        manager.force_process_window().unwrap();
        
        // Check rewards
        let light_reward = manager.get_pending_reward("light1").unwrap();
        let full_reward = manager.get_pending_reward("full1").unwrap();
        let super_reward = manager.get_pending_reward("super1").unwrap();
        
        // Pool 3 should be 0 in Phase 1
        assert_eq!(light_reward.pool3_activation_bonus, 0);
        assert_eq!(full_reward.pool3_activation_bonus, 0);
        assert_eq!(super_reward.pool3_activation_bonus, 0);
        
        // Pool 1 should be dynamic (not static 245,100.67)
        assert!(light_reward.pool1_base_emission > 0);
        assert_eq!(light_reward.pool1_base_emission, full_reward.pool1_base_emission);
        assert_eq!(light_reward.pool1_base_emission, super_reward.pool1_base_emission);
        
        println!("✅ Phase 1 rewards working correctly!");
        println!("Current phase: {:?}", light_reward.current_phase);
        println!("Pool 1 (dynamic): {} QNC", light_reward.pool1_base_emission);
        println!("Pool 3 (disabled): {} QNC", light_reward.pool3_activation_bonus);
    }
    
    #[test]
    fn test_phase_transition() {
        let mut manager = PhaseAwareRewardManager::new(1640995200);
        
        // Initially Phase 1
        manager.update_phase_parameters(15.0, 0);
        assert_eq!(manager.get_network_phase(), QNetPhase::Phase1);
        
        // Trigger Phase 2 by burn percentage
        manager.update_phase_parameters(90.0, 0);
        assert_eq!(manager.get_network_phase(), QNetPhase::Phase2);
        
        // Trigger Phase 2 by time
        manager.update_phase_parameters(50.0, 5);
        assert_eq!(manager.get_network_phase(), QNetPhase::Phase2);
        
        // Now Pool 3 should work
        assert!(manager.add_activation_qnc(5000).is_ok());
        
        println!("✅ Phase transition working correctly!");
    }
    
    #[test]
    fn test_dynamic_pool1_emission() {
        let genesis_2022 = 1640995200; // 2022-01-01
        let manager = PhaseAwareRewardManager::new(genesis_2022);
        
        let pool1_emission = manager.calculate_pool1_base_emission();
        
        // Should be close to 245,100.67 * 1,000,000 microQNC (first 4 years)
        assert!(pool1_emission > 240_000_000_000);
        assert!(pool1_emission < 250_000_000_000);
        
        println!("✅ Dynamic Pool 1 emission working correctly!");
        println!("Pool 1 current emission: {} microQNC", pool1_emission);
    }
} 
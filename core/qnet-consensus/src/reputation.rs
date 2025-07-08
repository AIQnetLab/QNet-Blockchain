//! Reputation management for consensus nodes

use crate::{
    types::{NodeInfo, ValidatorInfo, DoubleSignEvidence, Evidence, SlashingResult},
};
use std::collections::HashMap;
use std::sync::Arc;
use dashmap::DashMap;
use tracing::{debug, info, warn};

/// Manages node reputation scores
pub struct NodeReputation {
    /// Node reputation scores
    reputations: Arc<DashMap<String, NodeInfo>>,
    
    /// Configuration
    config: ReputationConfig,
}

/// Configuration for reputation system
#[derive(Debug, Clone)]
pub struct ReputationConfig {
    /// Initial reputation score
    pub initial_reputation: f64,
    
    /// Maximum reputation score
    pub max_reputation: f64,
    
    /// Minimum reputation score
    pub min_reputation: f64,
    
    /// Reputation increase for successful participation
    pub success_increment: f64,
    
    /// Reputation decrease for failed participation
    pub failure_decrement: f64,
    
    /// Reputation decay rate per round
    pub decay_rate: f64,
}

impl Default for ReputationConfig {
    fn default() -> Self {
        Self {
            initial_reputation: 50.0,
            max_reputation: 100.0,
            min_reputation: 0.0,
            success_increment: 1.0,
            failure_decrement: 2.0,
            decay_rate: 0.01,
        }
    }
}

impl NodeReputation {
    /// Create new reputation manager
    pub fn new(config: ReputationConfig) -> Self {
        Self {
            reputations: Arc::new(DashMap::new()),
            config,
        }
    }
    
    /// Get or create node info
    pub fn get_or_create_node(&self, address: &str) -> NodeInfo {
        self.reputations
            .entry(address.to_string())
            .or_insert_with(|| NodeInfo {
                address: address.to_string(),
                reputation: self.config.initial_reputation,
                last_seen: current_timestamp(),
                successful_rounds: 0,
                failed_rounds: 0,
            })
            .clone()
    }
    
    /// Update node reputation for successful participation
    pub fn record_success(&self, address: &str) {
        if let Some(mut node) = self.reputations.get_mut(address) {
            node.reputation = (node.reputation + self.config.success_increment)
                .min(self.config.max_reputation);
            node.successful_rounds += 1;
            node.last_seen = current_timestamp();
            info!("Node {} reputation increased to {}", address, node.reputation);
        }
    }
    
    /// Update node reputation for failed participation
    pub fn record_failure(&self, address: &str) {
        if let Some(mut node) = self.reputations.get_mut(address) {
            node.reputation = (node.reputation - self.config.failure_decrement)
                .max(self.config.min_reputation);
            node.failed_rounds += 1;
            node.last_seen = current_timestamp();
            warn!("Node {} reputation decreased to {}", address, node.reputation);
        }
    }
    
    /// Apply decay to all reputations
    pub fn apply_decay(&self) {
        for mut entry in self.reputations.iter_mut() {
            let decay = entry.reputation * self.config.decay_rate;
            entry.reputation = (entry.reputation - decay).max(self.config.min_reputation);
        }
        debug!("Applied reputation decay");
    }
    
    /// Get reputation score for a node
    pub fn get_reputation(&self, address: &str) -> f64 {
        self.reputations
            .get(address)
            .map(|node| node.reputation)
            .unwrap_or(self.config.initial_reputation)
    }
    
    /// Get all nodes with reputation above threshold
    pub fn get_eligible_nodes(&self, threshold: f64) -> Vec<String> {
        self.reputations
            .iter()
            .filter(|entry| entry.reputation >= threshold)
            .map(|entry| entry.key().clone())
            .collect()
    }
    
    /// Calculate reputation-weighted random selection
    pub fn weighted_selection(&self, nodes: &[String], random_seed: &str) -> Option<String> {
        if nodes.is_empty() {
            return None;
        }
        
        // Calculate total reputation
        let total_reputation: f64 = nodes
            .iter()
            .map(|addr| self.get_reputation(addr))
            .sum();
        
        if total_reputation <= 0.0 {
            return None;
        }
        
        // Generate random value based on seed
        let hash = blake3::hash(random_seed.as_bytes());
        let random_value = u64::from_le_bytes(hash.as_bytes()[0..8].try_into().unwrap()) as f64 
            / u64::MAX as f64 * total_reputation;
        
        // Select node based on weighted probability
        let mut cumulative = 0.0;
        for node in nodes {
            cumulative += self.get_reputation(node);
            if cumulative >= random_value {
                return Some(node.clone());
            }
        }
        
        nodes.last().cloned()
    }
    
    /// Get top N nodes by reputation
    pub fn get_top_nodes(&self, n: usize) -> Vec<NodeInfo> {
        let mut nodes: Vec<NodeInfo> = self.reputations
            .iter()
            .map(|entry| entry.value().clone())
            .collect();
        
        nodes.sort_by(|a, b| b.reputation.partial_cmp(&a.reputation).unwrap());
        nodes.truncate(n);
        nodes
    }
    
    /// Remove inactive nodes
    pub fn prune_inactive_nodes(&self, inactive_threshold_ms: u64) {
        let current_time = current_timestamp();
        let threshold = current_time.saturating_sub(inactive_threshold_ms);
        
        self.reputations.retain(|_, node| node.last_seen > threshold);
    }
    
    /// Penalize node for consensus violations (slashing)
    pub fn penalize(&self, address: &str, penalty: f64, reason: &str) -> SlashingResult {
        let current_time = current_timestamp();
        let mut reputation_penalty = penalty;
        let mut score_penalty = (penalty * 10.0) as u8; // Convert to score penalty
        let mut banned = false;
        
        if let Some(mut node) = self.reputations.get_mut(address) {
            // Apply reputation penalty
            node.reputation = (node.reputation - penalty).max(self.config.min_reputation);
            node.failed_rounds += 1;
            node.last_seen = current_time;
            
            // If reputation drops too low, ban the node
            if node.reputation < 10.0 {
                banned = true;
                info!("Node {} banned due to low reputation: {}", address, node.reputation);
            }
            
            warn!("Node {} penalized: -{} reputation for {}", address, penalty, reason);
        } else {
            // Create new node with penalty applied
            let initial_rep = self.config.initial_reputation - penalty;
            let node = NodeInfo {
                address: address.to_string(),
                reputation: initial_rep.max(self.config.min_reputation),
                last_seen: current_time,
                successful_rounds: 0,
                failed_rounds: 1,
            };
            self.reputations.insert(address.to_string(), node);
        }
        
        SlashingResult {
            validator: address.to_string(),
            reputation_penalty,
            score_penalty,
            banned,
            slashed_at: current_time,
        }
    }
    
    /// Reward node for good behavior
    pub fn reward(&self, address: &str, reward: f64, reason: &str) {
        if let Some(mut node) = self.reputations.get_mut(address) {
            node.reputation = (node.reputation + reward).min(self.config.max_reputation);
            node.successful_rounds += 1;
            node.last_seen = current_timestamp();
            info!("Node {} rewarded: +{} reputation for {}", address, reward, reason);
        }
    }
    
    /// Check if node is valid for consensus participation
    pub fn is_valid(&self, address: &str, min_score: u8) -> bool {
        if let Some(node) = self.reputations.get(address) {
            // Check reputation threshold
            if node.reputation < 70.0 {
                return false;
            }
            
            // Check if not banned
            if node.reputation < 10.0 {
                return false;
            }
            
            // Check recent activity
            let current_time = current_timestamp();
            let inactive_threshold = 24 * 60 * 60 * 1000; // 24 hours
            if current_time.saturating_sub(node.last_seen) > inactive_threshold {
                return false;
            }
            
            true
        } else {
            false
        }
    }
    
    /// Process double signing evidence and apply penalties
    pub fn process_double_sign_evidence(&self, evidence: &DoubleSignEvidence) -> SlashingResult {
        let penalty = 30.0; // Heavy penalty for double signing
        let reason = format!("Double signing in round {}", evidence.round);
        
        self.penalize(&evidence.offender, penalty, &reason)
    }
}

/// Get current timestamp in milliseconds
fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_reputation_management() {
        let reputation = NodeReputation::new(ReputationConfig::default());
        
        // Test initial reputation
        assert_eq!(reputation.get_reputation("node1"), 50.0);
        
        // Test success
        reputation.get_or_create_node("node1");
        reputation.record_success("node1");
        assert_eq!(reputation.get_reputation("node1"), 51.0);
        
        // Test failure
        reputation.record_failure("node1");
        assert_eq!(reputation.get_reputation("node1"), 49.0);
        
        // Test decay
        reputation.apply_decay();
        assert!(reputation.get_reputation("node1") < 49.0);
    }
    
    #[test]
    fn test_weighted_selection() {
        let reputation = NodeReputation::new(ReputationConfig::default());
        
        // Create nodes with different reputations
        reputation.get_or_create_node("node1");
        reputation.get_or_create_node("node2");
        reputation.get_or_create_node("node3");
        
        for _ in 0..10 {
            reputation.record_success("node1");
        }
        for _ in 0..5 {
            reputation.record_success("node2");
        }
        
        let nodes = vec!["node1".to_string(), "node2".to_string(), "node3".to_string()];
        
        // Test selection
        let selected = reputation.weighted_selection(&nodes, "test_seed");
        assert!(selected.is_some());
        
        // Node1 should have highest chance of being selected
        let mut selections = HashMap::new();
        for i in 0..1000 {
            if let Some(node) = reputation.weighted_selection(&nodes, &format!("seed_{}", i)) {
                *selections.entry(node).or_insert(0) += 1;
            }
        }
        
        // node1 should be selected most often
        let node1_count = selections.get("node1").unwrap_or(&0);
        let node2_count = selections.get("node2").unwrap_or(&0);
        let node3_count = selections.get("node3").unwrap_or(&0);
        
        assert!(node1_count > node2_count);
        assert!(node2_count > node3_count);
    }
}

/// Simple reputation system wrapper
pub struct ReputationSystem {
    inner: Arc<NodeReputation>,
}

impl ReputationSystem {
    /// Create new reputation system
    pub fn new() -> Self {
        Self {
            inner: Arc::new(NodeReputation::new(ReputationConfig::default())),
        }
    }
} 
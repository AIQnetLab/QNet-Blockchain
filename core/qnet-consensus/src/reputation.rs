//! Node reputation system for consensus
//! Tracks node behavior and calculates weighted selection

use std::collections::HashMap;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};

/// Evidence of double signing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoubleSignEvidence {
    pub round: u64,
    pub hash_a: [u8; 32],
    pub hash_b: [u8; 32],
    pub offender: String,
    pub detected_at: u64,
    pub signature_a: Vec<u8>,
    pub signature_b: Vec<u8>,
}

/// Node information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInfo {
    pub node_id: String,
    pub public_key: Vec<u8>,
    pub reputation: f64,
    pub last_seen: u64,
    pub node_type: String,
}

/// Validator information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorInfo {
    pub node_id: String,

    pub reputation: f64,
    pub is_active: bool,
}

/// Evidence of misbehavior
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evidence {
    pub evidence_type: String,
    pub node_id: String,
    pub evidence_data: Vec<u8>,
    pub timestamp: u64,
}

/// Result of slashing operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashingResult {
    pub node_id: String,
    pub slashed_amount: u64,
    pub new_reputation: f64,
    pub is_banned: bool,
}

/// Reputation configuration
#[derive(Debug, Clone)]
pub struct ReputationConfig {
    /// Initial reputation for new nodes
    pub initial_reputation: f64,
    /// Maximum reputation
    pub max_reputation: f64,
    /// Minimum reputation before banning
    pub min_reputation: f64,
    /// Reputation decay rate
    pub decay_rate: f64,
    /// Decay interval
    pub decay_interval: Duration,
}

impl Default for ReputationConfig {
    fn default() -> Self {
        Self {
            initial_reputation: 70.0,   // PRODUCTION: Minimum consensus participation threshold
            max_reputation: 100.0,
            min_reputation: 10.0,       // Ban threshold
            decay_rate: 0.01,
            decay_interval: Duration::from_secs(3600), // 1 hour
        }
    }
}

/// Node reputation manager
pub struct NodeReputation {
    config: ReputationConfig,
    reputations: HashMap<String, f64>,
    last_update: HashMap<String, Instant>,
    banned_nodes: HashMap<String, Instant>,
}

impl NodeReputation {
    /// Create new reputation manager
    pub fn new(config: ReputationConfig) -> Self {
        Self {
            config,
            reputations: HashMap::new(),
            last_update: HashMap::new(),
            banned_nodes: HashMap::new(),
        }
    }
    
    /// Get reputation for a node
    pub fn get_reputation(&self, node_id: &str) -> f64 {
        // Check if node is banned
        if self.banned_nodes.contains_key(node_id) {
            return 0.0;
        }
        
        self.reputations.get(node_id)
            .copied()
            .unwrap_or(self.config.initial_reputation)
    }
    
    /// Update reputation for a node (delta-based)
    pub fn update_reputation(&mut self, node_id: &str, delta: f64) {
        let current = self.get_reputation(node_id);
        let new_reputation = (current + delta)
            .max(0.0)
            .min(self.config.max_reputation);
        
        self.reputations.insert(node_id.to_string(), new_reputation);
        self.last_update.insert(node_id.to_string(), Instant::now());
        
        // Ban if reputation too low
        if new_reputation < self.config.min_reputation {
            self.ban_node(node_id);
        }
    }
    
    /// Set absolute reputation for a node (PRODUCTION: Genesis initialization)
    pub fn set_reputation(&mut self, node_id: &str, reputation: f64) {
        let new_reputation = reputation
            .max(0.0)
            .min(self.config.max_reputation);
        
        self.reputations.insert(node_id.to_string(), new_reputation);
        self.last_update.insert(node_id.to_string(), Instant::now());
        
        // Ban if reputation too low
        if new_reputation < self.config.min_reputation {
            self.ban_node(node_id);
        }
    }
    
    /// Ban a node
    pub fn ban_node(&mut self, node_id: &str) {
        self.banned_nodes.insert(node_id.to_string(), Instant::now());
        self.reputations.insert(node_id.to_string(), 0.0);
    }
    
    /// Check if a node is banned
    pub fn is_banned(&self, node_id: &str) -> bool {
        self.banned_nodes.contains_key(node_id)
    }
    
    /// Record successful behavior
    pub fn record_success(&mut self, node_id: &str) {
        self.update_reputation(node_id, 1.0);
    }
    
    /// Record failed behavior
    pub fn record_failure(&mut self, node_id: &str) {
        self.update_reputation(node_id, -2.0);
    }
    
    /// Apply reputation decay
    pub fn apply_decay(&mut self) {
        let now = Instant::now();
        
        // Collect nodes that need decay first
        let nodes_to_decay: Vec<String> = self.last_update
            .iter()
            .filter(|(_, last_update)| now.duration_since(**last_update) > self.config.decay_interval)
            .map(|(node_id, _)| node_id.clone())
            .collect();
        
        // Apply decay to collected nodes
        for node_id in nodes_to_decay {
            let current = self.get_reputation(&node_id);
            let decay_amount = current * self.config.decay_rate;
            self.update_reputation(&node_id, -decay_amount);
        }
    }
    
    /// Weighted selection based on reputation
    pub fn weighted_selection(&self, candidates: &[String], randomness: &str) -> Option<String> {
        if candidates.is_empty() {
            return None;
        }
        
        // Calculate total weight
        let total_weight: f64 = candidates.iter()
            .map(|id| self.get_reputation(id))
            .sum();
        
        if total_weight == 0.0 {
            return None;
        }
        
        // Use randomness to select
        let hash = blake3::hash(randomness.as_bytes());
        let seed = u64::from_le_bytes([
            hash.as_bytes()[0], hash.as_bytes()[1], hash.as_bytes()[2], hash.as_bytes()[3],
            hash.as_bytes()[4], hash.as_bytes()[5], hash.as_bytes()[6], hash.as_bytes()[7],
        ]);
        
        let target = (seed as f64 / u64::MAX as f64) * total_weight;
        let mut accumulated = 0.0;
        
        for candidate in candidates {
            accumulated += self.get_reputation(candidate);
            if accumulated >= target {
                return Some(candidate.clone());
            }
        }
        
        // Fallback to last candidate
        candidates.last().cloned()
    }
    
    /// Process double signing evidence
    pub fn process_double_sign_evidence(&mut self, evidence: &DoubleSignEvidence) -> SlashingResult {
        let node_id = &evidence.offender;
        let current_rep = self.get_reputation(node_id);
        
        // Major penalty for double signing
        let penalty = 50.0;
        let new_rep = (current_rep - penalty).max(0.0);
        
        self.reputations.insert(node_id.clone(), new_rep);
        
        // Ban if reputation too low
        let is_banned = new_rep < self.config.min_reputation;
        if is_banned {
            self.ban_node(node_id);
        }
        
        SlashingResult {
            node_id: node_id.clone(),
            slashed_amount: penalty as u64,
            new_reputation: new_rep,
            is_banned,
        }
    }
    
    /// Get all reputations
    pub fn get_all_reputations(&self) -> HashMap<String, f64> {
        self.reputations.clone()
    }
    
    /// Get banned nodes
    pub fn get_banned_nodes(&self) -> Vec<String> {
        self.banned_nodes.keys().cloned().collect()
    }
} 
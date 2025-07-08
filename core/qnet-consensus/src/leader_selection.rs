//! Leader selection mechanism

use crate::reputation::NodeReputation;
use std::sync::Arc;

/// Leader selection mechanism
pub struct LeaderSelector {
    /// Node reputation manager
    reputation: Arc<NodeReputation>,
}

impl LeaderSelector {
    /// Create new leader selector
    pub fn new(reputation: Arc<NodeReputation>) -> Self {
        Self { reputation }
    }
    
    /// Select leader based on reputation and randomness
    pub fn select_leader(&self, eligible_nodes: &[String], random_beacon: &str) -> Option<String> {
        if eligible_nodes.is_empty() {
            return None;
        }
        
        // Use reputation-weighted selection
        self.reputation.weighted_selection(eligible_nodes, random_beacon)
    }
    
    /// Get nodes sorted by reputation
    pub fn get_ranked_nodes(&self, nodes: &[String]) -> Vec<(String, f64)> {
        let mut ranked: Vec<(String, f64)> = nodes
            .iter()
            .map(|node| (node.clone(), self.reputation.get_reputation(node)))
            .collect();
        
        // Sort by reputation (descending)
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        ranked
    }
} 
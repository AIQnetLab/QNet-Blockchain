//! Security mechanisms for burn-to-join consensus model

use std::collections::{HashMap, HashSet};

/// Security validator for burn-to-join model
pub struct BurnSecurityValidator {
    /// Active nodes (those who burned QNA)
    active_nodes: HashMap<[u8; 32], NodeBurnInfo>,
    
    /// Banned nodes (caught misbehaving)
    banned_nodes: HashSet<[u8; 32]>,
    
    /// Checkpoints
    checkpoints: HashMap<u64, [u8; 32]>,
    
    /// Security parameters
    params: BurnSecurityParams,
}

#[derive(Clone, Debug)]
pub struct NodeBurnInfo {
    /// Node ID
    pub node_id: [u8; 32],
    
    /// Amount of QNA burned
    pub burned_amount: u64,
    
    /// When they joined (burn timestamp)
    pub joined_at: u64,
    
    /// Node type (Light/Full/Super)
    pub node_type: NodeType,
    
    /// Current reputation
    pub reputation: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum NodeType {
    Light,
    Full,
    Super,
}

impl BurnSecurityValidator {
    /// Create new validator
    pub fn new() -> Self {
        Self {
            active_nodes: HashMap::new(),
            banned_nodes: HashSet::new(),
            checkpoints: HashMap::new(),
            params: BurnSecurityParams::default(),
        }
    }
    
    /// Validate chain in burn-to-join model
    pub fn validate_chain(&self, chain: &[BlockInfo]) -> Result<(), SecurityError> {
        // 1. Check all block producers have burned QNA
        for block in chain {
            if !self.active_nodes.contains_key(&block.proposer) {
                return Err(SecurityError::UnauthorizedProducer(block.proposer));
            }
            
            // Check if banned
            if self.banned_nodes.contains(&block.proposer) {
                return Err(SecurityError::BannedNode(block.proposer));
            }
        }
        
        // 2. Verify minimum active nodes threshold
        let unique_producers: HashSet<_> = chain.iter()
            .map(|b| b.proposer)
            .collect();
        
        if unique_producers.len() < self.params.min_active_nodes {
            return Err(SecurityError::InsufficientActiveNodes {
                found: unique_producers.len(),
                required: self.params.min_active_nodes,
            });
        }
        
        // 3. Check node diversity (prevent single entity control)
        let diversity_score = self.calculate_diversity_score(&unique_producers);
        if diversity_score < self.params.min_diversity_score {
            return Err(SecurityError::InsufficientDiversity(diversity_score));
        }
        
        // 4. Verify checkpoints
        for block in chain {
            if let Some(checkpoint) = self.checkpoints.get(&block.height) {
                if &block.hash != checkpoint {
                    return Err(SecurityError::CheckpointMismatch);
                }
            }
        }
        
        // 5. Check reorganization depth
        if chain.len() > self.params.max_reorg_depth {
            return Err(SecurityError::DeepReorganization(chain.len()));
        }
        
        Ok(())
    }
    
    /// Calculate diversity score based on burn amounts and join times
    fn calculate_diversity_score(&self, producers: &HashSet<[u8; 32]>) -> f64 {
        if producers.is_empty() {
            return 0.0;
        }
        
        let mut burn_amounts = Vec::new();
        let mut join_times = Vec::new();
        
        for &producer in producers {
            if let Some(info) = self.active_nodes.get(&producer) {
                burn_amounts.push(info.burned_amount as f64);
                join_times.push(info.joined_at as f64);
            }
        }
        
        // Calculate variance in burn amounts (higher = more diverse)
        let burn_variance = calculate_variance(&burn_amounts);
        
        // Calculate spread in join times (higher = more diverse)
        let time_spread = if join_times.is_empty() {
            0.0
        } else {
            let max_time = join_times.iter().fold(f64::NEG_INFINITY, |a, &b| a.max(b));
            let min_time = join_times.iter().fold(f64::INFINITY, |a, &b| a.min(b));
            max_time - min_time
        };
        
        // Combined diversity score
        (burn_variance.sqrt() / 1000.0).min(1.0) * 0.5 + 
        (time_spread / (365.0 * 24.0 * 3600.0)).min(1.0) * 0.5
    }
    
    /// Check if node can produce blocks
    pub fn can_produce_blocks(&self, node_id: &[u8; 32]) -> bool {
        if let Some(info) = self.active_nodes.get(node_id) {
            // Must be Full or Super node
            info.node_type != NodeType::Light &&
            // Must have good reputation
            info.reputation > self.params.min_reputation &&
            // Must not be banned
            !self.banned_nodes.contains(node_id)
        } else {
            false
        }
    }
    
    /// Ban node for misbehavior
    pub fn ban_node(&mut self, node_id: [u8; 32], reason: BanReason) {
        tracing::warn!("Banning node {:?} for {:?}", node_id, reason);
        
        self.banned_nodes.insert(node_id);
        
        // Set reputation to 0
        if let Some(info) = self.active_nodes.get_mut(&node_id) {
            info.reputation = 0.0;
        }
    }
}

/// Fork resolution for burn-to-join model
pub struct BurnForkResolution {
    /// Security validator
    security: BurnSecurityValidator,
    
    /// Fork choice (reusing existing)
    fork_choice: crate::fork_choice::ForkChoice,
}

impl BurnForkResolution {
    /// Resolve forks using burn-based security
    pub fn resolve_fork(
        &mut self,
        chain_a: &[BlockInfo],
        chain_b: &[BlockInfo],
    ) -> Result<ForkDecision, SecurityError> {
        // Validate both chains
        self.security.validate_chain(chain_a)?;
        self.security.validate_chain(chain_b)?;
        
        // Calculate chain scores based on burn model
        let score_a = self.calculate_burn_chain_score(chain_a)?;
        let score_b = self.calculate_burn_chain_score(chain_b)?;
        
        tracing::info!("Fork resolution: Chain A score={}, Chain B score={}", score_a, score_b);
        
        if score_a > score_b {
            Ok(ForkDecision::ChooseA)
        } else if score_b > score_a {
            Ok(ForkDecision::ChooseB)
        } else {
            // Tie breaker: choose chain with more unique producers
            let producers_a: HashSet<_> = chain_a.iter().map(|b| b.proposer).collect();
            let producers_b: HashSet<_> = chain_b.iter().map(|b| b.proposer).collect();
            
            if producers_a.len() >= producers_b.len() {
                Ok(ForkDecision::ChooseA)
            } else {
                Ok(ForkDecision::ChooseB)
            }
        }
    }
    
    /// Calculate chain score in burn model
    fn calculate_burn_chain_score(&self, chain: &[BlockInfo]) -> Result<f64, SecurityError> {
        let mut score = 0.0;
        let mut seen_producers = HashSet::new();
        
        for block in chain {
            if let Some(node_info) = self.security.active_nodes.get(&block.proposer) {
                // Base score from burn amount (logarithmic to prevent whale dominance)
                let burn_score = (node_info.burned_amount as f64).ln();
                
                // Reputation multiplier
                let reputation_mult = node_info.reputation;
                
                // Node type bonus
                let type_bonus = match node_info.node_type {
                    NodeType::Super => 1.5,
                    NodeType::Full => 1.0,
                    NodeType::Light => 0.5,
                };
                
                // Diversity bonus (first time seeing this producer)
                let diversity_bonus = if seen_producers.insert(block.proposer) {
                    1.2
                } else {
                    1.0
                };
                
                score += burn_score * reputation_mult * type_bonus * diversity_bonus;
            }
        }
        
        // Length bonus (longer chains are preferred)
        score += (chain.len() as f64).sqrt() * 10.0;
        
        Ok(score)
    }
}

#[derive(Debug)]
pub enum ForkDecision {
    ChooseA,
    ChooseB,
}

#[derive(Debug)]
pub enum BanReason {
    DoubleSign,
    InvalidBlock,
    Censorship,
    Downtime,
}

/// Security parameters for burn model
pub struct BurnSecurityParams {
    /// Minimum active nodes required
    pub min_active_nodes: usize,
    
    /// Minimum diversity score (0-1)
    pub min_diversity_score: f64,
    
    /// Maximum reorg depth
    pub max_reorg_depth: usize,
    
    /// Minimum reputation to produce blocks
    pub min_reputation: f64,
}

impl Default for BurnSecurityParams {
    fn default() -> Self {
        Self {
            min_active_nodes: 10,
            min_diversity_score: 0.3,
            max_reorg_depth: 100,
            min_reputation: 50.0,  // FIXED: 0-100 scale
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SecurityError {
    #[error("Unauthorized block producer: {:?}", .0)]
    UnauthorizedProducer([u8; 32]),
    
    #[error("Block from banned node: {:?}", .0)]
    BannedNode([u8; 32]),
    
    #[error("Insufficient active nodes: found {found}, required {required}")]
    InsufficientActiveNodes { found: usize, required: usize },
    
    #[error("Insufficient network diversity: {0}")]
    InsufficientDiversity(f64),
    
    #[error("Checkpoint mismatch")]
    CheckpointMismatch,
    
    #[error("Deep reorganization: {0} blocks")]
    DeepReorganization(usize),
}

// Re-use BlockInfo from fork_choice
use crate::fork_choice::BlockInfo;

fn calculate_variance(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance = values.iter()
        .map(|v| (v - mean).powi(2))
        .sum::<f64>() / values.len() as f64;
    
    variance
} 
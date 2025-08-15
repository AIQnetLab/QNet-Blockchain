//! Security mechanisms for QNet burn-to-join consensus model
//! Based on real QNet economic model with 1DEV/QNC phases

use std::collections::{HashMap, HashSet};

/// Block information for security validation
#[derive(Clone, Debug)]
pub struct BlockInfo {
    /// Block height
    pub height: u64,
    /// Block hash
    pub hash: [u8; 32],
    /// Previous block hash
    pub prev_hash: [u8; 32],
    /// Block proposer (node ID)
    pub proposer: [u8; 32],
    /// Timestamp
    pub timestamp: u64,
    /// Phase 1: 1DEV burned amount, Phase 2: QNC transferred to Pool 3 (not burned)
    pub activation_cost: u64,
}

/// Security error types
#[derive(Debug, Clone)]
pub enum SecurityError {
    /// Node not authorized (hasn't burned 1DEV or transferred QNC)
    NodeNotAuthorized([u8; 32]),
    /// Insufficient burn/transfer amount
    InsufficientActivationCost { required: u64, actual: u64 },
    /// Node is banned
    NodeBanned([u8; 32]),
    /// Invalid block
    InvalidBlock(String),
    /// Fork detected
    ForkDetected,
    /// Other security violation
    SecurityViolation(String),
}

impl std::fmt::Display for SecurityError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            SecurityError::NodeNotAuthorized(node) => write!(f, "Node not authorized: {:?}", node),
            SecurityError::InsufficientActivationCost { required, actual } => {
                write!(f, "Insufficient activation cost: required {}, actual {}", required, actual)
            }
            SecurityError::NodeBanned(node) => write!(f, "Node banned: {:?}", node),
            SecurityError::InvalidBlock(msg) => write!(f, "Invalid block: {}", msg),
            SecurityError::ForkDetected => write!(f, "Fork detected"),
            SecurityError::SecurityViolation(msg) => write!(f, "Security violation: {}", msg),
        }
    }
}

impl std::error::Error for SecurityError {}

/// Security validator for QNet burn-to-join model
pub struct BurnSecurityValidator {
    /// Active nodes (those who burned 1DEV or transferred QNC)
    active_nodes: HashMap<[u8; 32], NodeActivationInfo>,
    
    /// Banned nodes (caught misbehaving)
    banned_nodes: HashSet<[u8; 32]>,
    
    /// Checkpoints
    checkpoints: HashMap<u64, [u8; 32]>,
    
    /// Security parameters
    params: QNetSecurityParams,
}

#[derive(Clone, Debug)]
pub struct NodeActivationInfo {
    /// Node ID
    pub node_id: [u8; 32],
    
    /// Amount used for activation (1DEV burned or QNC transferred)
    pub activation_amount: u64,
    
    /// When they activated
    pub activated_at: u64,
    
    /// Node type (Light/Full/Super)
    pub node_type: NodeType,
    
    /// Current reputation
    pub reputation: f64,
    
    /// Which phase they activated in (1 = 1DEV burn, 2 = QNC Pool 3)
    pub activation_phase: u8,
}

#[derive(Clone, Debug, PartialEq)]
pub enum NodeType {
    Light,
    Full,
    Super,
}

impl NodeType {
    /// Get Phase 1 activation cost (1DEV burn) - REAL QNet model
    pub fn get_phase1_cost(&self, burn_percentage: f64) -> u64 {
        // REAL QNet economic model: Universal pricing for ALL node types
        let base_cost = 1500u64; // 1500 1DEV for all node types
        let min_cost = 150u64;   // 150 1DEV minimum at 90% burned
        
        // Every 10% burned = -150 1DEV reduction
        let reduction_per_10_percent = 150u64;
        let reduction_tiers = (burn_percentage / 10.0).floor() as u64;
        let total_reduction = reduction_tiers * reduction_per_10_percent;
        
        // Calculate final cost
        let final_cost = base_cost.saturating_sub(total_reduction);
        final_cost.max(min_cost)
    }
    
    /// Get Phase 2 activation cost (QNC Pool 3 transfer) - REAL QNet model
    pub fn get_phase2_cost(&self, network_size: u64) -> u64 {
        // REAL QNet economic model: Different base costs per node type
        let base_cost = match self {
            NodeType::Light => 5000u64,  // 5,000 QNC
            NodeType::Full => 7500u64,   // 7,500 QNC
            NodeType::Super => 10000u64, // 10,000 QNC
        };
        
        // Network size multipliers - REAL QNet model
        let multiplier = match network_size {
            0..=100_000 => 0.5,      // Early discount
            100_001..=1_000_000 => 1.0, // Standard rate
            1_000_001..=10_000_000 => 2.0, // High demand
            _ => 3.0,                // Mature network (10M+)
        };
        
        (base_cost as f64 * multiplier) as u64
    }
}

#[derive(Clone, Debug)]
pub struct QNetSecurityParams {
    /// Phase 1: Total 1DEV supply (1 billion tokens)
    pub onedev_total_supply: u64,
    /// Phase 1: Transition threshold (90% burned)
    pub phase1_transition_threshold: f64,
    /// Phase 2: Reputation threshold for banning (unified: 10.0)
    pub ban_threshold: f64,
    /// Time window for reputation calculation
    pub reputation_window: u64,
}

impl Default for QNetSecurityParams {
    fn default() -> Self {
        Self {
            onedev_total_supply: 1_000_000_000, // 1 billion 1DEV (real QNet supply)
            phase1_transition_threshold: 0.9,    // 90% burned triggers Phase 2
            ban_threshold: 10.0,                 // 0-100 scale ban threshold
            reputation_window: 86400,            // 24 hours
        }
    }
}

impl BurnSecurityValidator {
    /// Create new validator
    pub fn new() -> Self {
        Self {
            active_nodes: HashMap::new(),
            banned_nodes: HashSet::new(),
            checkpoints: HashMap::new(),
            params: QNetSecurityParams::default(),
        }
    }
    
    /// Validate chain in QNet burn-to-join model
    pub fn validate_chain(&self, chain: &[BlockInfo]) -> Result<(), SecurityError> {
        // 1. Check all block producers are properly activated
        for block in chain {
            if !self.active_nodes.contains_key(&block.proposer) {
                return Err(SecurityError::NodeNotAuthorized(block.proposer));
            }
            
            // 2. Check if node is banned
            if self.banned_nodes.contains(&block.proposer) {
                return Err(SecurityError::NodeBanned(block.proposer));
            }
            
            // 3. Check activation cost requirements
            if let Some(node_info) = self.active_nodes.get(&block.proposer) {
                if node_info.activation_amount < block.activation_cost {
                    return Err(SecurityError::InsufficientActivationCost {
                        required: block.activation_cost,
                        actual: node_info.activation_amount,
                    });
                }
            }
        }
        
        Ok(())
    }
    
    /// Add node after successful Phase 1 activation (1DEV burn)
    pub fn add_phase1_node(&mut self, node_id: [u8; 32], burned_amount: u64, node_type: NodeType, burn_percentage: f64) -> Result<(), SecurityError> {
        let required_cost = node_type.get_phase1_cost(burn_percentage);
        
        if burned_amount < required_cost {
            return Err(SecurityError::InsufficientActivationCost {
                required: required_cost,
                actual: burned_amount,
            });
        }
        
        let node_info = NodeActivationInfo {
            node_id,
            activation_amount: burned_amount,
            activated_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            node_type,
            reputation: 100.0, // Start with max reputation
            activation_phase: 1, // Phase 1 activation
        };
        
        self.active_nodes.insert(node_id, node_info);
        Ok(())
    }
    
    /// Add node after successful Phase 2 activation (QNC Pool 3 transfer)
    pub fn add_phase2_node(&mut self, node_id: [u8; 32], transferred_amount: u64, node_type: NodeType, network_size: u64) -> Result<(), SecurityError> {
        let required_cost = node_type.get_phase2_cost(network_size);
        
        if transferred_amount < required_cost {
            return Err(SecurityError::InsufficientActivationCost {
                required: required_cost,
                actual: transferred_amount,
            });
        }
        
        let node_info = NodeActivationInfo {
            node_id,
            activation_amount: transferred_amount,
            activated_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            node_type,
            reputation: 100.0, // Start with max reputation
            activation_phase: 2, // Phase 2 activation
        };
        
        self.active_nodes.insert(node_id, node_info);
        Ok(())
    }
    
    /// Ban a node for misbehavior
    pub fn ban_node(&mut self, node_id: [u8; 32]) {
        self.banned_nodes.insert(node_id);
        self.active_nodes.remove(&node_id);
    }
    
    /// Check if node is authorized
    pub fn is_authorized(&self, node_id: &[u8; 32]) -> bool {
        self.active_nodes.contains_key(node_id) && !self.banned_nodes.contains(node_id)
    }
    
    /// Update node reputation
    pub fn update_reputation(&mut self, node_id: &[u8; 32], reputation: f64) {
        if let Some(node_info) = self.active_nodes.get_mut(node_id) {
            node_info.reputation = reputation;
            
            // Ban if reputation too low (unified threshold: 10.0)
            if reputation < self.params.ban_threshold {
                self.ban_node(*node_id);
            }
        }
    }
    
    /// Get node info
    pub fn get_node_info(&self, node_id: &[u8; 32]) -> Option<&NodeActivationInfo> {
        self.active_nodes.get(node_id)
    }
    
    /// Get all active nodes
    pub fn get_active_nodes(&self) -> Vec<&NodeActivationInfo> {
        self.active_nodes.values().collect()
    }
    
    /// Check if we should transition to Phase 2
    pub fn should_transition_to_phase2(&self, total_burned: u64, years_since_launch: f64) -> bool {
        let burn_percentage = (total_burned as f64) / (self.params.onedev_total_supply as f64);
        burn_percentage >= self.params.phase1_transition_threshold || years_since_launch >= 5.0
    }
}

/// Fork resolution for QNet burn-to-join model
pub struct BurnForkResolution {
    /// Security validator
    security: BurnSecurityValidator,
}

impl BurnForkResolution {
    /// Create new fork resolution system
    pub fn new() -> Self {
        Self {
            security: BurnSecurityValidator::new(),
        }
    }
    
    /// Resolve fork between two chains
    pub fn resolve_fork(
        &self,
        chain_a: &[BlockInfo],
        chain_b: &[BlockInfo],
    ) -> Result<Vec<BlockInfo>, SecurityError> {
        // 1. Validate both chains
        self.security.validate_chain(chain_a)?;
        self.security.validate_chain(chain_b)?;
        
        // 2. Calculate chain scores based on QNet economic model
        let score_a = self.calculate_qnet_chain_score(chain_a)?;
        let score_b = self.calculate_qnet_chain_score(chain_b)?;
        
        // 3. Choose chain with higher score
        if score_a >= score_b {
            Ok(chain_a.to_vec())
        } else {
            Ok(chain_b.to_vec())
        }
    }
    
    /// Calculate chain score based on QNet economic model
    fn calculate_qnet_chain_score(&self, chain: &[BlockInfo]) -> Result<f64, SecurityError> {
        let mut total_score = 0.0;
        
        for block in chain {
            if let Some(node_info) = self.security.get_node_info(&block.proposer) {
                // Score based on activation amount and reputation
                let activation_score = node_info.activation_amount as f64;
                let reputation_score = node_info.reputation;
                
                // Phase 2 nodes get bonus (they contributed to Pool 3)
                let phase_bonus = if node_info.activation_phase == 2 { 1.2 } else { 1.0 };
                
                total_score += activation_score * (reputation_score / 100.0) * phase_bonus;
            }
        }
        
        Ok(total_score)
    }
}

fn calculate_variance(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance = values.iter()
        .map(|x| (x - mean).powi(2))
        .sum::<f64>() / values.len() as f64;
        
    variance
} 
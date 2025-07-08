//! Fork resolution and security mechanisms

use crate::fork_choice::{BlockInfo, ForkChoice};
use std::collections::{HashMap, HashSet};

/// Fork resolution manager - handles network reunification
pub struct ForkResolution {
    /// Fork choice rule
    fork_choice: ForkChoice,
    
    /// Security validator
    security: SecurityValidator,
    
    /// Network partition detector
    partition_detector: PartitionDetector,
}

impl ForkResolution {
    /// Create new fork resolution
    pub fn new() -> Self {
        Self {
            fork_choice: ForkChoice::new([0; 32]), // Genesis
            security: SecurityValidator::new(),
            partition_detector: PartitionDetector::new(),
        }
    }
}

/// Security validator - prevents accepting malicious chains
pub struct SecurityValidator {
    /// Known good checkpoints
    checkpoints: HashMap<u64, [u8; 32]>,
    
    /// Banned validators (caught double-signing)
    banned_validators: HashSet<[u8; 32]>,
    
    /// Maximum allowed reorganization depth
    max_reorg_depth: u64,
    
    /// Minimum stake required for validation
    min_stake_threshold: u64,
}

impl SecurityValidator {
    /// Create new security validator
    pub fn new() -> Self {
        Self {
            checkpoints: HashMap::new(),
            banned_validators: HashSet::new(),
            max_reorg_depth: 100,
            min_stake_threshold: 1000,
        }
    }
    
    /// Validate incoming chain
    pub fn validate_chain(&self, chain: &[BlockInfo]) -> Result<(), SecurityError> {
        // 1. Check reorganization depth
        if let Some(common_ancestor) = self.find_common_ancestor(chain) {
            let reorg_depth = chain.len() - common_ancestor;
            if reorg_depth > self.max_reorg_depth as usize {
                return Err(SecurityError::DeepReorganization(reorg_depth));
            }
        }
        
        // 2. Verify checkpoints
        for block in chain {
            if let Some(checkpoint_hash) = self.checkpoints.get(&block.height) {
                if &block.hash != checkpoint_hash {
                    return Err(SecurityError::CheckpointMismatch);
                }
            }
        }
        
        // 3. Check for banned validators
        for block in chain {
            if self.banned_validators.contains(&block.proposer) {
                return Err(SecurityError::BannedValidator);
            }
        }
        
        // 4. Verify economic security (stake threshold)
        let total_stake = self.calculate_chain_stake(chain)?;
        if total_stake < self.min_stake_threshold {
            return Err(SecurityError::InsufficientStake(total_stake));
        }
        
        Ok(())
    }
    
    /// Calculate total stake backing a chain
    fn calculate_chain_stake(&self, chain: &[BlockInfo]) -> Result<u64, SecurityError> {
        let mut unique_validators = HashSet::new();
        let mut total_stake = 0u64;
        
        for block in chain {
            if unique_validators.insert(block.proposer) {
                // In real implementation, would look up actual stake
                total_stake += 1000; // Placeholder
            }
        }
        
        Ok(total_stake)
    }
    
    fn find_common_ancestor(&self, _chain: &[BlockInfo]) -> Option<usize> {
        // Simplified - would compare with current chain
        Some(0)
    }
}

/// Network partition detector
pub struct PartitionDetector {
    /// Last seen blocks from peers
    peer_heads: HashMap<[u8; 32], BlockInfo>,
    
    /// Partition events
    partitions: Vec<PartitionEvent>,
}

impl PartitionDetector {
    /// Create new partition detector
    pub fn new() -> Self {
        Self {
            peer_heads: HashMap::new(),
            partitions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PartitionEvent {
    /// When partition was detected
    pub detected_at: u64,
    
    /// Estimated partition duration
    pub duration: u64,
    
    /// Number of nodes on each side
    pub group_sizes: Vec<usize>,
}

impl ForkResolution {
    /// Handle network reunification
    pub async fn handle_reunification(
        &mut self,
        local_chain: Vec<BlockInfo>,
        remote_chains: Vec<Vec<BlockInfo>>,
    ) -> Result<ResolutionResult, SecurityError> {
        tracing::info!("Handling network reunification with {} remote chains", remote_chains.len());
        
        // 1. Validate all chains
        for (i, chain) in remote_chains.iter().enumerate() {
            tracing::debug!("Validating remote chain {}", i);
            self.security.validate_chain(chain)?;
        }
        
        // 2. Add all valid blocks to fork choice
        let mut all_blocks = HashSet::new();
        
        // Add local blocks
        for block in &local_chain {
            all_blocks.insert(block.clone());
            self.fork_choice.add_block(block.clone())?;
        }
        
        // Add remote blocks
        for chain in &remote_chains {
            for block in chain {
                if all_blocks.insert(block.clone()) {
                    self.fork_choice.add_block(block.clone())?;
                }
            }
        }
        
        // 3. Let fork choice determine canonical chain
        let canonical = self.fork_choice.get_canonical_chain()?;
        
        // 4. Check if we need to switch chains
        let local_head = local_chain.last().map(|b| b.hash).unwrap_or([0; 32]);
        let new_head = canonical.last().copied().unwrap_or([0; 32]);
        
        if local_head != new_head {
            tracing::warn!("Chain reorganization required!");
            
            // Find common ancestor
            let common_height = self.find_common_height(&local_chain, &canonical)?;
            
            return Ok(ResolutionResult::Reorganization {
                from_block: local_head,
                to_block: new_head,
                common_height,
                blocks_to_revert: local_chain.len() - common_height,
            });
        }
        
        Ok(ResolutionResult::NoChange)
    }
    
    /// Detect potential network partition
    pub fn detect_partition(&mut self, peer_heads: HashMap<[u8; 32], BlockInfo>) -> Option<PartitionEvent> {
        // Group peers by their chain tips
        let mut chain_groups: HashMap<[u8; 32], Vec<[u8; 32]>> = HashMap::new();
        
        for (peer_id, head) in &peer_heads {
            chain_groups.entry(head.hash)
                .or_insert_with(Vec::new)
                .push(*peer_id);
        }
        
        // If we see multiple groups at same height, likely partition
        if chain_groups.len() > 1 {
            let group_sizes: Vec<usize> = chain_groups.values()
                .map(|g| g.len())
                .collect();
            
            let total_peers: usize = group_sizes.iter().sum();
            let largest_group = group_sizes.iter().max().copied().unwrap_or(0);
            
            // If largest group has < 67% of peers, we have a significant partition
            if largest_group < (total_peers * 2 / 3) {
                return Some(PartitionEvent {
                    detected_at: current_timestamp(),
                    duration: 0, // Unknown yet
                    group_sizes,
                });
            }
        }
        
        None
    }
    
    fn find_common_height(&self, chain1: &[BlockInfo], chain2: &[[u8; 32]]) -> Result<usize, SecurityError> {
        // Find where chains diverge
        for (i, block) in chain1.iter().enumerate() {
            if i < chain2.len() && block.hash == chain2[i] {
                continue;
            } else {
                return Ok(i.saturating_sub(1));
            }
        }
        Ok(chain1.len().min(chain2.len()))
    }
}

/// Result of fork resolution
#[derive(Debug)]
pub enum ResolutionResult {
    /// No change needed - we're on the canonical chain
    NoChange,
    
    /// Need to reorganize to different chain
    Reorganization {
        from_block: [u8; 32],
        to_block: [u8; 32],
        common_height: usize,
        blocks_to_revert: usize,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum SecurityError {
    #[error("Deep reorganization attempted: {0} blocks")]
    DeepReorganization(usize),
    
    #[error("Checkpoint mismatch - possible long range attack")]
    CheckpointMismatch,
    
    #[error("Block from banned validator")]
    BannedValidator,
    
    #[error("Insufficient stake backing chain: {0}")]
    InsufficientStake(u64),
    
    #[error("Fork choice error: {0}")]
    ForkChoice(#[from] crate::fork_choice::ForkError),
}

fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Security parameters for QNet
pub struct SecurityParams {
    /// Maximum blocks that can be reverted (default: 100)
    pub max_reorg_depth: u64,
    
    /// Minimum economic stake to accept chain (default: 67% of total)
    pub min_stake_ratio: f64,
    
    /// Checkpoint interval (default: every 1000 blocks)
    pub checkpoint_interval: u64,
    
    /// Partition detection threshold (default: 33% nodes on minority chain)
    pub partition_threshold: f64,
}

impl Default for SecurityParams {
    fn default() -> Self {
        Self {
            max_reorg_depth: 100,
            min_stake_ratio: 0.67,
            checkpoint_interval: 1000,
            partition_threshold: 0.33,
        }
    }
} 
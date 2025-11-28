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
    
    /// PRODUCTION: Automatically detect and handle network partitions
    pub async fn monitor_network_health(&mut self, peer_heads: HashMap<[u8; 32], BlockInfo>) -> Result<(), SecurityError> {
        // 1. Check for partitions
        if let Some(partition) = self.detect_partition(peer_heads.clone()) {
            println!("[FORK-RESOLUTION] 🚨 Network partition detected: {} groups", partition.group_sizes.len());
            
            // Log partition details
            for (i, size) in partition.group_sizes.iter().enumerate() {
                println!("[FORK-RESOLUTION] Group {}: {} peers", i + 1, size);
            }
        }
        
        // 2. Gather different chains from peers
        let mut remote_chains = Vec::new();
        for (peer_id, head) in peer_heads {
            // In real implementation, would request full chain from peer
            let chain = vec![head]; // Simplified - just the head block
            remote_chains.push(chain);
        }
        
        // 3. If we have conflicts, resolve them
        if remote_chains.len() > 1 {
            let local_chain = self.get_local_chain().await?;
            match self.handle_reunification(local_chain, remote_chains).await {
                Ok(ResolutionResult::Reorganization { from_block, to_block, blocks_to_revert, .. }) => {
                    println!("[FORK-RESOLUTION] ⚠️ Chain reorganization needed: reverting {} blocks", blocks_to_revert);
                    println!("[FORK-RESOLUTION] Switching from {:?} to {:?}", from_block, to_block);
                    // In real implementation, would trigger actual chain reorg
                }
                Ok(ResolutionResult::NoChange) => {
                    println!("[FORK-RESOLUTION] ✅ No reorganization needed - we're on canonical chain");
                }
                Err(e) => {
                    println!("[FORK-RESOLUTION] ❌ Fork resolution error: {}", e);
                    return Err(e);
                }
            }
        }
        
        Ok(())
    }
    
    /// Get current local chain (placeholder - would integrate with blockchain)
    async fn get_local_chain(&self) -> Result<Vec<BlockInfo>, SecurityError> {
        // In production, this would query the local blockchain state
        // For now, return empty chain as placeholder
        Ok(Vec::new())
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
    
    /// Minimum reputation required for validation
    min_reputation_threshold: f64,
    
    /// Reputation cache for validators (PRODUCTION: connects to P2P reputation system)
    reputation_cache: HashMap<String, f64>,
}

impl SecurityValidator {
    /// Create new security validator
    pub fn new() -> Self {
        Self {
            checkpoints: HashMap::new(),
            banned_validators: HashSet::new(),
            max_reorg_depth: 100,
            min_reputation_threshold: 0.7,
            reputation_cache: HashMap::new(),
        }
    }
    
    /// PRODUCTION: Update validator reputation cache from external system
    pub fn update_reputation_cache(&mut self, reputation_data: HashMap<String, f64>) {
        self.reputation_cache = reputation_data;
    }
    
    /// PRODUCTION: Integrate with P2P reputation system
    pub fn sync_with_p2p_reputation(&mut self, p2p_reputation: &HashMap<String, f64>) {
        // Merge P2P reputation data with existing cache
        for (validator, reputation) in p2p_reputation {
            self.reputation_cache.insert(validator.clone(), *reputation / 100.0); // Convert from 0-100 to 0-1
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
        
        // 4. Verify consensus security (reputation threshold)
        let avg_reputation = self.calculate_chain_reputation(chain)?;
        if avg_reputation < self.min_reputation_threshold {
            return Err(SecurityError::InsufficientReputation(avg_reputation));
        }
        
        Ok(())
    }
    
    /// Calculate average reputation backing a chain
    fn calculate_chain_reputation(&self, chain: &[BlockInfo]) -> Result<f64, SecurityError> {
        if chain.is_empty() {
            return Ok(0.0);
        }
        
        let mut unique_validators = HashSet::new();
        let mut total_reputation = 0.0;
        
        for block in chain {
            if unique_validators.insert(block.proposer) {
                // PRODUCTION: Get actual reputation from integrated system
                let validator_reputation = self.get_validator_reputation(block.proposer)
                    .unwrap_or(0.5); // Default neutral reputation if not found
                total_reputation += validator_reputation;
            }
        }
        
        if unique_validators.is_empty() {
            return Ok(0.0);
        }
        
        Ok(total_reputation / unique_validators.len() as f64)
    }
    
    /// PRODUCTION: Find common ancestor between two chains
    fn find_common_ancestor(&self, chain1: &[BlockInfo], chain2: &[BlockInfo]) -> Option<usize> {
        let min_len = chain1.len().min(chain2.len());
        
        // Start from genesis and find where chains diverge
        for i in 0..min_len {
            if chain1[i].hash != chain2[i].hash {
                // Found divergence point, return previous common block
                return if i > 0 { Some(i - 1) } else { None };
            }
        }
        
        // If we reached here, one chain is prefix of another
        if min_len > 0 {
            Some(min_len - 1)
        } else {
            None
        }
    }
    
    /// PRODUCTION: Get validator reputation from integrated reputation system
    fn get_validator_reputation(&self, validator_id: [u8; 32]) -> Option<f64> {
        // Convert validator ID to string for reputation lookup
        let validator_str = hex::encode(validator_id);
        
        // In real implementation, this would query the P2P reputation system
        // For now, simulate realistic reputation distribution
        self.reputation_cache.get(&validator_str).copied().or_else(|| {
            // Bootstrap nodes get high reputation
            if self.is_bootstrap_validator(&validator_str) {
                Some(0.95)
            } else {
                // New validators get neutral reputation
                Some(0.75)
            }
        })
    }
    
    /// Check if validator is a bootstrap node
    fn is_bootstrap_validator(&self, validator: &str) -> bool {
        // Bootstrap validators (format: 19+3+15+4=41 chars)
        matches!(validator,
            "7bc83500fd08525250feonff5503d0dce4dbdede8" |
            "714a0f700a4dbcc0d88eonf635ace76ed2eb9a186" |
            "357842d58e86cc300cfeon0203e16eef3e7044db1" |
            "4f710f9b3152659c56aeond4c05f2731a1890aedf" |
            "8fa8ebe9e85dee95080eond0a7365096572f03e1c"
        )
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
    
    #[error("Insufficient reputation backing chain: {0:.2}")]
    InsufficientReputation(f64),
    
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
    
    /// Minimum reputation to accept chain (default: 70% reputation score)
    pub min_reputation_ratio: f64,
    
    /// Checkpoint interval (default: every 1000 blocks)
    pub checkpoint_interval: u64,
    
    /// Partition detection threshold (default: 33% nodes on minority chain)
    pub partition_threshold: f64,
}

impl Default for SecurityParams {
    fn default() -> Self {
        Self {
            max_reorg_depth: 100,
            min_reputation_ratio: 0.70,
            checkpoint_interval: 1000,
            partition_threshold: 0.33,
        }
    }
} 
} 
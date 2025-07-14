//! Fork choice rule implementation for QNet

use std::collections::{HashMap, HashSet};

/// Fork choice rule - determines the canonical chain
pub struct ForkChoice {
    /// Block tree
    blocks: HashMap<BlockHash, BlockInfo>,
    
    /// Children mapping
    children: HashMap<BlockHash, Vec<BlockHash>>,
    
    /// Current head
    head: BlockHash,
    
    /// Finalized block
    finalized: BlockHash,
}

/// Block information for fork choice
#[derive(Clone, Debug)]
pub struct BlockInfo {
    /// Block hash
    pub hash: [u8; 32],
    
    /// Parent hash
    pub parent: [u8; 32],
    
    /// Block height
    pub height: u64,
    
    /// Block timestamp
    pub timestamp: u64,
    
    /// Block proposer
    pub proposer: [u8; 32],
    
    /// Proposer reputation at time of block (not included in hash/eq)
    pub proposer_reputation: f64,
    
    /// Consensus round
    pub round: u64,
    
    /// Number of transactions
    pub tx_count: usize,
}

// Custom PartialEq implementation to exclude proposer_reputation
impl PartialEq for BlockInfo {
    fn eq(&self, other: &Self) -> bool {
        self.hash == other.hash &&
        self.parent == other.parent &&
        self.height == other.height &&
        self.timestamp == other.timestamp &&
        self.proposer == other.proposer &&
        self.round == other.round &&
        self.tx_count == other.tx_count
    }
}

impl Eq for BlockInfo {}

// Custom Hash implementation to exclude proposer_reputation
impl std::hash::Hash for BlockInfo {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.hash.hash(state);
        self.parent.hash(state);
        self.height.hash(state);
        self.timestamp.hash(state);
        self.proposer.hash(state);
        self.round.hash(state);
        self.tx_count.hash(state);
    }
}

pub type BlockHash = [u8; 32];

impl ForkChoice {
    /// Create new fork choice
    pub fn new(genesis: BlockHash) -> Self {
        let mut blocks = HashMap::new();
        blocks.insert(genesis, BlockInfo {
            hash: genesis,
            parent: [0; 32],
            height: 0,
            proposer: [0; 32],
            proposer_reputation: 100.0,  // FIXED: 0-100 scale
            timestamp: 0,
            round: 0,
            tx_count: 0,
        });
        
        Self {
            blocks,
            children: HashMap::new(),
            head: genesis,
            finalized: genesis,
        }
    }
    
    /// Add new block
    pub fn add_block(&mut self, block: BlockInfo) -> Result<(), ForkError> {
        // Check parent exists
        if !self.blocks.contains_key(&block.parent) {
            return Err(ForkError::UnknownParent);
        }
        
        // Add to tree
        self.blocks.insert(block.hash, block.clone());
        self.children.entry(block.parent)
            .or_insert_with(Vec::new)
            .push(block.hash);
        
        // Update head if needed
        self.update_head()?;
        
        Ok(())
    }
    
    /// Update head using fork choice rule
    fn update_head(&mut self) -> Result<(), ForkError> {
        // QNet uses modified GHOST with reputation weighting
        let new_head = self.find_best_chain(self.finalized)?;
        
        if new_head != self.head {
            tracing::info!("Fork choice: switching head from {:?} to {:?}", 
                          self.head, new_head);
            self.head = new_head;
        }
        
        Ok(())
    }
    
    /// Find best chain using GHOST + reputation
    fn find_best_chain(&self, start: BlockHash) -> Result<BlockHash, ForkError> {
        let mut current = start;
        
        loop {
            let children = match self.children.get(&current) {
                Some(c) => c,
                None => return Ok(current), // Leaf node
            };
            
            if children.is_empty() {
                return Ok(current);
            }
            
            // Calculate weight for each child
            let mut best_child = None;
            let mut best_score = f64::NEG_INFINITY;
            
            for &child in children {
                let score = self.calculate_chain_score(child)?;
                if score > best_score {
                    best_score = score;
                    best_child = Some(child);
                }
            }
            
            current = best_child.ok_or(ForkError::InvalidState)?;
        }
    }
    
    /// Calculate chain score (weight + reputation)
    fn calculate_chain_score(&self, block_hash: BlockHash) -> Result<f64, ForkError> {
        let block = self.blocks.get(&block_hash)
            .ok_or(ForkError::UnknownBlock)?;
        
        // Base score from subtree weight
        let weight = self.calculate_subtree_weight(block_hash)?;
        
        // Reputation bonus (already in 0-100 scale)
        let reputation_bonus = block.proposer_reputation;
        
        // Time penalty for old blocks (reduced impact for tests)
        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let age_penalty = if block.timestamp > 0 && current_time > block.timestamp {
            ((current_time - block.timestamp) as f64 / 3600.0).min(1.0) // Max 1.0 penalty, 1 hour scale
        } else {
            0.0
        };
        
        Ok(weight as f64 + reputation_bonus - age_penalty)
    }
    
    /// Calculate total weight of subtree
    fn calculate_subtree_weight(&self, root: BlockHash) -> Result<u64, ForkError> {
        let mut weight = 1; // Self weight
        
        if let Some(children) = self.children.get(&root) {
            for &child in children {
                weight += self.calculate_subtree_weight(child)?;
            }
        }
        
        Ok(weight)
    }
    
    /// Get current canonical chain
    pub fn get_canonical_chain(&self) -> Result<Vec<[u8; 32]>, ForkError> {
        let mut chain = Vec::new();
        let mut current = self.head;
        
        while current != [0; 32] {
            chain.push(current);
            if let Some(block) = self.blocks.get(&current) {
                current = block.parent;
            } else {
                break;
            }
        }
        
        chain.reverse();
        Ok(chain)
    }
    
    /// Finalize block (cannot be reverted)
    pub fn finalize_block(&mut self, block_hash: BlockHash) -> Result<(), ForkError> {
        if !self.is_ancestor(self.finalized, block_hash)? {
            return Err(ForkError::InvalidFinalization);
        }
        
        self.finalized = block_hash;
        self.prune_old_forks()?;
        
        Ok(())
    }
    
    /// Check if ancestor is ancestor of descendant
    fn is_ancestor(&self, ancestor: BlockHash, descendant: BlockHash) -> Result<bool, ForkError> {
        let mut current = descendant;
        
        while current != [0; 32] {
            if current == ancestor {
                return Ok(true);
            }
            
            let block = self.blocks.get(&current)
                .ok_or(ForkError::UnknownBlock)?;
            current = block.parent;
        }
        
        Ok(false)
    }
    
    /// Remove forks that can never be canonical
    fn prune_old_forks(&mut self) -> Result<(), ForkError> {
        let finalized_height = self.blocks.get(&self.finalized)
            .ok_or(ForkError::UnknownBlock)?
            .height;
        
        // Find all blocks at or below finalized height that aren't ancestors
        let mut to_remove = Vec::new();
        
        for (&hash, block) in &self.blocks {
            if block.height <= finalized_height && 
               !self.is_ancestor(hash, self.finalized)? &&
               hash != self.finalized {
                to_remove.push(hash);
            }
        }
        
        // Remove pruned blocks
        for hash in to_remove {
            self.blocks.remove(&hash);
            self.children.remove(&hash);
        }
        
        Ok(())
    }
    
    /// Get fork statistics
    pub fn get_fork_stats(&self) -> ForkStats {
        let total_blocks = self.blocks.len();
        let canonical_length = self.get_canonical_chain()
            .map(|c| c.len())
            .unwrap_or(0);
        
        let mut fork_count = 0;
        for children in self.children.values() {
            if children.len() > 1 {
                fork_count += children.len() - 1;
            }
        }
        
        ForkStats {
            total_blocks,
            canonical_length,
            fork_count,
            finalized_height: self.blocks.get(&self.finalized)
                .map(|b| b.height)
                .unwrap_or(0),
        }
    }
    
    /// Get current head
    pub fn head(&self) -> BlockHash {
        self.head
    }
    
    /// Check if a block has children
    pub fn has_children(&self, block_hash: &[u8; 32]) -> bool {
        self.children.get(block_hash).map(|c| !c.is_empty()).unwrap_or(false)
    }
    
    /// Get block by hash
    pub fn get_block(&self, hash: &[u8; 32]) -> Option<BlockInfo> {
        self.blocks.get(hash).cloned()
    }
    
    /// Get all forks
    pub fn get_all_forks(&self) -> Result<Vec<Fork>, ForkError> {
        let mut forks = Vec::new();
        let mut visited = HashSet::new();
        
        // Find all fork points
        for (hash, children) in &self.children {
            if children.len() > 1 && !visited.contains(hash) {
                visited.insert(*hash);
                
                // Create fork info
                let fork = Fork {
                    fork_point: *hash,
                    branches: children.clone(),
                    fork_height: self.blocks.get(hash).map(|b| b.height).unwrap_or(0),
                };
                forks.push(fork);
            }
        }
        
        Ok(forks)
    }
    
    /// Check if block would create fork
    pub fn would_create_fork(&self, block: &BlockInfo) -> bool {
        self.blocks.contains_key(&block.parent) && 
        self.children.get(&block.parent).map(|c| !c.is_empty()).unwrap_or(false)
    }
    
    /// Get head height
    pub fn get_head_height(&self) -> Result<u64, ForkError> {
        self.blocks.get(&self.head)
            .map(|b| b.height)
            .ok_or(ForkError::UnknownBlock)
    }
    
    /// Get blocks at height
    pub fn get_blocks_at_height(&self, height: u64) -> Result<Vec<[u8; 32]>, ForkError> {
        Ok(self.blocks.iter()
            .filter(|(_, b)| b.height == height)
            .map(|(h, _)| *h)
            .collect())
    }
    
    /// Get block height
    pub fn get_block_height(&self, hash: [u8; 32]) -> Result<u64, ForkError> {
        self.blocks.get(&hash)
            .map(|b| b.height)
            .ok_or(ForkError::UnknownBlock)
    }
    
    /// Find common ancestor
    pub fn find_common_ancestor(&self, a: [u8; 32], b: [u8; 32]) -> Result<[u8; 32], ForkError> {
        // Traverse up from both until we find common
        let mut ancestors_a = HashSet::new();
        let mut current = a;
        
        while current != [0; 32] {
            ancestors_a.insert(current);
            current = self.blocks.get(&current)
                .ok_or(ForkError::UnknownBlock)?
                .parent;
        }
        
        current = b;
        while current != [0; 32] {
            if ancestors_a.contains(&current) {
                return Ok(current);
            }
            current = self.blocks.get(&current)
                .ok_or(ForkError::UnknownBlock)?
                .parent;
        }
        
        Ok([0; 32]) // Genesis
    }
}

#[derive(Debug)]
pub struct ForkStats {
    pub total_blocks: usize,
    pub canonical_length: usize,
    pub fork_count: usize,
    pub finalized_height: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum ForkError {
    #[error("Unknown parent block")]
    UnknownParent,
    
    #[error("Unknown block")]
    UnknownBlock,
    
    #[error("Invalid finalization")]
    InvalidFinalization,
    
    #[error("Invalid state")]
    InvalidState,
}

/// Fork information
#[derive(Debug, Clone)]
pub struct Fork {
    /// Block where fork occurred
    pub fork_point: [u8; 32],
    
    /// Branch heads
    pub branches: Vec<[u8; 32]>,
    
    /// Height of fork point
    pub fork_height: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_simple_fork() {
        let genesis = [0u8; 32];
        let mut fc = ForkChoice::new(genesis);
        
        // Add two competing blocks
        let block_a = BlockInfo {
            hash: [1; 32],
            parent: genesis,
            height: 1,
            proposer: [0; 32],
            proposer_reputation: 80.0,  // FIXED: 0-100 scale
            timestamp: 1000,
            round: 0,
            tx_count: 0,
        };
        
        let block_b = BlockInfo {
            hash: [2; 32],
            parent: genesis,
            height: 1,
            proposer: [0; 32],
            proposer_reputation: 90.0,  // FIXED: 0-100 scale
            timestamp: 1001,
            round: 0,
            tx_count: 0,
        };
        
        fc.add_block(block_a).unwrap();
        fc.add_block(block_b).unwrap();
        
        // Should choose block_b due to higher reputation
        assert_eq!(fc.head, [2; 32]);
    }
} 
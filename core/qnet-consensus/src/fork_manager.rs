//! Complete fork management system for QNet

use crate::{
    burn_security::{BurnSecurityValidator, NodeBurnInfo},
    fork_choice::{BlockInfo, ForkChoice, Fork},
    fork_resolution::{ForkResolution, ResolutionResult, SecurityError},
    ConsensusError,
};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing;

/// Complete fork management system
pub struct ForkManager {
    /// Fork choice algorithm
    fork_choice: Arc<RwLock<ForkChoice>>,
    
    /// Security validator
    security: Arc<RwLock<BurnSecurityValidator>>,
    
    /// Fork resolution
    resolver: Arc<RwLock<ForkResolution>>,
    
    /// Fork metrics
    metrics: ForkMetrics,
    
    /// Fork event history
    history: VecDeque<ForkEvent>,
}

/// Fork metrics for monitoring
#[derive(Default, Debug)]
pub struct ForkMetrics {
    /// Total forks detected
    pub total_forks: u64,
    
    /// Successful resolutions
    pub resolutions: u64,
    
    /// Failed resolutions
    pub failures: u64,
    
    /// Average resolution time
    pub avg_resolution_time_ms: f64,
    
    /// Deepest reorg
    pub max_reorg_depth: u64,
    
    /// Current fork count
    pub active_forks: u64,
}

/// Fork event for history
#[derive(Debug, Clone)]
pub struct ForkEvent {
    /// Event timestamp
    pub timestamp: u64,
    
    /// Event type
    pub event_type: ForkEventType,
    
    /// Blocks involved
    pub blocks: Vec<[u8; 32]>,
    
    /// Resolution time
    pub resolution_time_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub enum ForkEventType {
    /// Fork detected
    ForkDetected { height: u64, branches: usize },
    
    /// Fork resolved
    ForkResolved { winning_branch: [u8; 32] },
    
    /// Reorganization
    Reorganization { depth: u64, from: [u8; 32], to: [u8; 32] },
    
    /// Resolution failed
    ResolutionFailed { reason: String },
}

impl ForkManager {
    /// Create new fork manager
    pub fn new(genesis: [u8; 32]) -> Self {
        Self {
            fork_choice: Arc::new(RwLock::new(ForkChoice::new(genesis))),
            security: Arc::new(RwLock::new(BurnSecurityValidator::new())),
            resolver: Arc::new(RwLock::new(ForkResolution::new())),
            metrics: ForkMetrics::default(),
            history: VecDeque::with_capacity(1000),
        }
    }
    
    /// Process new block with complete fork handling
    pub async fn process_block(&mut self, block: BlockInfo) -> Result<ProcessResult, ForkError> {
        let start_time = std::time::Instant::now();
        
        // 1. Validate block producer
        {
            let security = self.security.read().await;
            if !security.can_produce_blocks(&block.proposer) {
                return Err(ForkError::InvalidProducer(block.proposer));
            }
        }
        
        // 2. Check if this creates a fork
        let creates_fork = {
            let fc = self.fork_choice.read().await;
            fc.would_create_fork(&block)
        };
        
        if creates_fork {
            self.metrics.total_forks += 1;
            self.metrics.active_forks += 1;
            
            self.record_event(ForkEvent {
                timestamp: current_timestamp(),
                event_type: ForkEventType::ForkDetected {
                    height: block.height,
                    branches: 2, // Simplified
                },
                blocks: vec![block.hash],
                resolution_time_ms: None,
            });
        }
        
        // 3. Add block to fork choice
        let old_head = {
            let fc = self.fork_choice.read().await;
            fc.head()
        };
        
        {
            let mut fc = self.fork_choice.write().await;
            fc.add_block(block.clone())?;
        }
        
        // 4. Check if head changed (reorganization)
        let new_head = {
            let fc = self.fork_choice.read().await;
            fc.head()
        };
        
        let result = if old_head != new_head {
            // Reorganization occurred
            let reorg_depth = self.calculate_reorg_depth(old_head, new_head).await?;
            
            self.metrics.max_reorg_depth = self.metrics.max_reorg_depth.max(reorg_depth);
            
            self.record_event(ForkEvent {
                timestamp: current_timestamp(),
                event_type: ForkEventType::Reorganization {
                    depth: reorg_depth,
                    from: old_head,
                    to: new_head,
                },
                blocks: vec![old_head, new_head],
                resolution_time_ms: Some(start_time.elapsed().as_millis() as u64),
            });
            
            ProcessResult::Reorganization {
                old_head,
                new_head,
                depth: reorg_depth,
            }
        } else if block.hash == new_head {
            // Block became new head
            ProcessResult::NewHead(block.hash)
        } else {
            // Block added to fork
            ProcessResult::AddedToFork(block.hash)
        };
        
        // 5. Update metrics
        if creates_fork && matches!(result, ProcessResult::Reorganization { .. }) {
            self.metrics.resolutions += 1;
            self.metrics.active_forks = self.metrics.active_forks.saturating_sub(1);
            
            let resolution_time = start_time.elapsed().as_millis() as f64;
            self.metrics.avg_resolution_time_ms = 
                (self.metrics.avg_resolution_time_ms * (self.metrics.resolutions - 1) as f64 + resolution_time) 
                / self.metrics.resolutions as f64;
        }
        
        Ok(result)
    }
    
    /// Handle network partition reunification
    pub async fn handle_partition_reunification(
        &mut self,
        local_chain: Vec<BlockInfo>,
        remote_chains: Vec<Vec<BlockInfo>>,
    ) -> Result<PartitionResult, ForkError> {
        tracing::info!("Handling partition reunification with {} remote chains", remote_chains.len());
        
        // Use fork resolution to determine best chain
        let mut resolver = self.resolver.write().await;
        let resolution = resolver.handle_reunification(local_chain.clone(), remote_chains).await?;
        
        match resolution {
            ResolutionResult::NoChange => {
                Ok(PartitionResult::LocalChainWins)
            }
            ResolutionResult::Reorganization { from_block, to_block, common_height, blocks_to_revert } => {
                // Apply reorganization
                self.metrics.max_reorg_depth = self.metrics.max_reorg_depth.max(blocks_to_revert as u64);
                
                Ok(PartitionResult::RemoteChainWins {
                    new_head: to_block,
                    blocks_to_revert,
                })
            }
        }
    }
    
    /// Finalize blocks older than threshold
    pub async fn finalize_blocks(&mut self, threshold: u64) -> Result<Vec<[u8; 32]>, ForkError> {
        let mut fc = self.fork_choice.write().await;
        let current_height = fc.get_head_height()?;
        
        if current_height < threshold {
            return Ok(vec![]);
        }
        
        let finalize_height = current_height - threshold;
        let blocks_to_finalize = fc.get_blocks_at_height(finalize_height)?;
        
        // Only finalize if there's consensus (single block at height)
        if blocks_to_finalize.len() == 1 {
            fc.finalize_block(blocks_to_finalize[0])?;
            Ok(vec![blocks_to_finalize[0]])
        } else {
            // Multiple blocks at finalization height - wait for resolution
            Ok(vec![])
        }
    }
    
    /// Get fork statistics
    pub fn get_stats(&self) -> &ForkMetrics {
        &self.metrics
    }
    
    /// Get fork visualization data
    pub async fn get_fork_visualization(&self) -> ForkVisualization {
        let fc = self.fork_choice.read().await;
        let stats = fc.get_fork_stats();
        
        ForkVisualization {
            total_blocks: stats.total_blocks,
            canonical_length: stats.canonical_length,
            fork_count: stats.fork_count,
            finalized_height: stats.finalized_height,
            active_forks: self.metrics.active_forks,
            max_fork_length: self.calculate_max_fork_length(&fc).await,
        }
    }
    
    /// Calculate reorganization depth
    async fn calculate_reorg_depth(&self, old_head: [u8; 32], new_head: [u8; 32]) -> Result<u64, ForkError> {
        let fc = self.fork_choice.read().await;
        let common_ancestor = fc.find_common_ancestor(old_head, new_head)?;
        let old_height = fc.get_block_height(old_head)?;
        let ancestor_height = fc.get_block_height(common_ancestor)?;
        Ok(old_height - ancestor_height)
    }
    
    /// Calculate maximum fork length
    async fn calculate_max_fork_length(&self, fc: &ForkChoice) -> u64 {
        // Simplified - would traverse all forks
        0
    }
    
    /// Record fork event
    fn record_event(&mut self, event: ForkEvent) {
        if self.history.len() >= 1000 {
            self.history.pop_front();
        }
        self.history.push_back(event);
    }
}

/// Result of block processing
#[derive(Debug)]
pub enum ProcessResult {
    /// Block became new head
    NewHead([u8; 32]),
    
    /// Block added to existing fork
    AddedToFork([u8; 32]),
    
    /// Reorganization occurred
    Reorganization {
        old_head: [u8; 32],
        new_head: [u8; 32],
        depth: u64,
    },
}

/// Result of partition resolution
#[derive(Debug)]
pub enum PartitionResult {
    /// Local chain wins
    LocalChainWins,
    
    /// Remote chain wins
    RemoteChainWins {
        new_head: [u8; 32],
        blocks_to_revert: usize,
    },
}

/// Fork visualization data
#[derive(Debug)]
pub struct ForkVisualization {
    pub total_blocks: usize,
    pub canonical_length: usize,
    pub fork_count: usize,
    pub finalized_height: u64,
    pub active_forks: u64,
    pub max_fork_length: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum ForkError {
    #[error("Invalid block producer: {:?}", .0)]
    InvalidProducer([u8; 32]),
    
    #[error("Fork choice error: {0}")]
    ForkChoice(#[from] crate::fork_choice::ForkError),
    
    #[error("Security error: {0}")]
    Security(#[from] crate::burn_security::SecurityError),
    
    #[error("Resolution error: {0}")]
    Resolution(String),
    
    #[error("Other error: {0}")]
    Other(String),
}

fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

impl From<SecurityError> for ForkError {
    fn from(e: SecurityError) -> Self {
        ForkError::Other(e.to_string())
    }
} 
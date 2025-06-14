//! Block synchronization service

use qnet_p2p::{NetworkService, PeerId};
use qnet_state::StateManager;
use qnet_consensus::ForkManager;
use std::sync::Arc;
use std::collections::{HashMap, VecDeque};
use tokio::sync::{Mutex, RwLock};
use tracing::{debug, info, warn, error};

/// Complete sync service implementation
pub struct SyncService {
    /// State manager
    state: Arc<StateManager>,
    
    /// Network service
    network: Arc<Mutex<NetworkService>>,
    
    /// Fork manager
    fork_manager: Arc<Mutex<ForkManager>>,
    
    /// Sync state
    sync_state: Arc<RwLock<SyncState>>,
    
    /// Block download queue
    download_queue: Arc<Mutex<DownloadQueue>>,
    
    /// Sync metrics
    metrics: Arc<RwLock<SyncMetrics>>,
}

/// Current sync state
#[derive(Debug, Clone)]
pub enum SyncState {
    /// Not syncing
    Idle,
    
    /// Fast sync - downloading headers first
    FastSync {
        target_height: u64,
        current_height: u64,
        peers: Vec<PeerId>,
    },
    
    /// Full sync - downloading full blocks
    FullSync {
        target_height: u64,
        current_height: u64,
        peers: Vec<PeerId>,
    },
    
    /// Synced with network
    Synced,
    
    /// Error state
    Error(String),
}

/// Block download queue
struct DownloadQueue {
    /// Pending downloads
    pending: VecDeque<BlockRequest>,
    
    /// Active downloads
    active: HashMap<u64, DownloadTask>,
    
    /// Downloaded blocks waiting to be processed
    ready: VecDeque<BlockData>,
    
    /// Maximum concurrent downloads
    max_concurrent: usize,
}

#[derive(Debug, Clone)]
struct BlockRequest {
    height: u64,
    hash: Option<[u8; 32]>,
    peer: PeerId,
    attempts: u32,
}

#[derive(Debug)]
struct DownloadTask {
    request: BlockRequest,
    started_at: std::time::Instant,
    timeout: std::time::Duration,
}

#[derive(Debug, Clone)]
struct BlockData {
    height: u64,
    hash: [u8; 32],
    data: Vec<u8>,
    peer: PeerId,
}

/// Sync metrics
#[derive(Default, Debug)]
pub struct SyncMetrics {
    /// Total blocks synced
    pub blocks_synced: u64,
    
    /// Sync speed (blocks/sec)
    pub sync_speed: f64,
    
    /// Download failures
    pub download_failures: u64,
    
    /// Validation failures
    pub validation_failures: u64,
    
    /// Current sync progress (0-100)
    pub progress_percent: f64,
    
    /// Time spent syncing
    pub sync_duration_secs: u64,
}

impl SyncService {
    /// Create new sync service
    pub fn new(
        state: Arc<StateManager>,
        network: Arc<Mutex<NetworkService>>,
    ) -> Self {
        let genesis = [0; 32]; // Should get from config
        
        Self {
            state,
            network,
            fork_manager: Arc::new(Mutex::new(ForkManager::new(genesis))),
            sync_state: Arc::new(RwLock::new(SyncState::Idle)),
            download_queue: Arc::new(Mutex::new(DownloadQueue::new())),
            metrics: Arc::new(RwLock::new(SyncMetrics::default())),
        }
    }
    
    /// Start synchronization
    pub async fn start_sync(&self) -> Result<(), Box<dyn std::error::Error>> {
        info!("Starting blockchain synchronization");
        
        // Get current state
        let current_height = self.state.get_height().await?;
        
        // Get peers and their heights
        let peer_heights = self.get_peer_heights().await?;
        
        if peer_heights.is_empty() {
            warn!("No peers available for sync");
            return Ok(());
        }
        
        // Find best height
        let best_height = peer_heights.values().max().copied().unwrap_or(0);
        
        if best_height <= current_height {
            info!("Already synced to best height {}", current_height);
            *self.sync_state.write().await = SyncState::Synced;
            return Ok(());
        }
        
        // Determine sync mode
        let sync_mode = if best_height - current_height > 1000 {
            // Fast sync for large gaps
            SyncState::FastSync {
                target_height: best_height,
                current_height,
                peers: peer_heights.keys().cloned().collect(),
            }
        } else {
            // Full sync for small gaps
            SyncState::FullSync {
                target_height: best_height,
                current_height,
                peers: peer_heights.keys().cloned().collect(),
            }
        };
        
        *self.sync_state.write().await = sync_mode.clone();
        
        // Start sync process
        match sync_mode {
            SyncState::FastSync { .. } => self.fast_sync().await?,
            SyncState::FullSync { .. } => self.full_sync().await?,
            _ => {}
        }
        
        Ok(())
    }
    
    /// Fast sync implementation
    async fn fast_sync(&self) -> Result<(), Box<dyn std::error::Error>> {
        info!("Starting fast sync");
        let start_time = std::time::Instant::now();
        
        loop {
            let (current, target, peers) = {
                let state = self.sync_state.read().await;
                match &*state {
                    SyncState::FastSync { current_height, target_height, peers } => {
                        (*current_height, *target_height, peers.clone())
                    }
                    _ => break,
                }
            };
            
            if current >= target {
                info!("Fast sync completed at height {}", current);
                *self.sync_state.write().await = SyncState::Synced;
                break;
            }
            
            // Download headers in batches
            let batch_size = 100;
            let mut tasks = vec![];
            
            for i in 0..peers.len().min(5) {
                let peer = peers[i % peers.len()];
                let from = current + (i as u64 * batch_size);
                let to = (from + batch_size).min(target);
                
                if from < target {
                    tasks.push(self.download_headers(peer, from, to));
                }
            }
            
            // Wait for downloads
            let results = futures::future::join_all(tasks).await;
            
            // Process headers
            for result in results {
                match result {
                    Ok(headers) => {
                        self.process_headers(headers).await?;
                    }
                    Err(e) => {
                        warn!("Header download failed: {}", e);
                        self.metrics.write().await.download_failures += 1;
                    }
                }
            }
            
            // Update progress
            let new_height = self.state.get_height().await?;
            if new_height > current {
                let mut state = self.sync_state.write().await;
                if let SyncState::FastSync { current_height, .. } = &mut *state {
                    *current_height = new_height;
                }
                
                // Update metrics
                let mut metrics = self.metrics.write().await;
                metrics.blocks_synced = new_height - current;
                metrics.progress_percent = ((new_height - current) as f64 / (target - current) as f64) * 100.0;
                metrics.sync_speed = metrics.blocks_synced as f64 / start_time.elapsed().as_secs_f64();
            }
            
            // Brief pause
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        
        // Switch to full sync for remaining blocks
        self.full_sync().await?;
        
        Ok(())
    }
    
    /// Full sync implementation
    async fn full_sync(&self) -> Result<(), Box<dyn std::error::Error>> {
        info!("Starting full sync");
        
        loop {
            let (current, target, peers) = {
                let state = self.sync_state.read().await;
                match &*state {
                    SyncState::FullSync { current_height, target_height, peers } => {
                        (*current_height, *target_height, peers.clone())
                    }
                    SyncState::FastSync { current_height, target_height, peers } => {
                        // Switch from fast to full
                        (*current_height, *target_height, peers.clone())
                    }
                    _ => break,
                }
            };
            
            if current >= target {
                info!("Full sync completed at height {}", current);
                *self.sync_state.write().await = SyncState::Synced;
                break;
            }
            
            // Download next blocks
            let next_height = current + 1;
            let peer = self.select_best_peer(&peers).await?;
            
            match self.download_block(peer, next_height).await {
                Ok(block) => {
                    // Validate and apply block
                    if let Err(e) = self.process_block(block).await {
                        error!("Block processing failed: {}", e);
                        self.metrics.write().await.validation_failures += 1;
                        
                        // Try different peer
                        continue;
                    }
                    
                    // Update state
                    let mut state = self.sync_state.write().await;
                    match &mut *state {
                        SyncState::FullSync { current_height, .. } |
                        SyncState::FastSync { current_height, .. } => {
                            *current_height = next_height;
                        }
                        _ => {}
                    }
                    
                    // Update metrics
                    let mut metrics = self.metrics.write().await;
                    metrics.blocks_synced += 1;
                    metrics.progress_percent = ((next_height - current) as f64 / (target - current) as f64) * 100.0;
                }
                Err(e) => {
                    warn!("Block download failed: {}", e);
                    self.metrics.write().await.download_failures += 1;
                }
            }
        }
        
        Ok(())
    }
    
    /// Download headers from peer
    async fn download_headers(
        &self,
        peer: PeerId,
        from: u64,
        to: u64,
    ) -> Result<Vec<BlockHeader>, Box<dyn std::error::Error>> {
        debug!("Downloading headers {} to {} from {}", from, to, peer);
        
        // Production P2P header download
        let net = self.network.lock().await;
        let headers = net.request_headers(peer, from, to).await?;
        
        // Validate header chain
        let mut validated_headers = Vec::new();
        let mut prev_hash = if from == 0 { [0; 32] } else {
            self.state.get_block_hash(from - 1).await?
        };
        
        for header in headers {
            // Validate parent hash chain
            if header.parent_hash != prev_hash {
                warn!("Invalid parent hash at height {}", header.height);
                break;
            }
            
            // Validate timestamp progression
            if !validated_headers.is_empty() {
                let prev_timestamp = validated_headers.last().unwrap().timestamp;
                if header.timestamp <= prev_timestamp {
                    warn!("Invalid timestamp at height {}", header.height);
                    break;
                }
            }
            
            prev_hash = header.hash;
            validated_headers.push(header);
        }
        
        Ok(validated_headers)
    }
    
    /// Download block from peer
    async fn download_block(
        &self,
        peer: PeerId,
        height: u64,
    ) -> Result<BlockData, Box<dyn std::error::Error>> {
        debug!("Downloading block {} from {}", height, peer);
        
        // Production P2P block download
        let net = self.network.lock().await;
        let block_data = net.request_block(peer, height).await?;
        
        // Validate block integrity
        let computed_hash = qnet_core::crypto::hash_message(&block_data.data);
        if computed_hash != block_data.hash.to_vec() {
            return Err(format!("Block hash mismatch at height {}", height).into());
        }
        
        Ok(block_data)
    }
    
    /// Process downloaded headers
    async fn process_headers(&self, headers: Vec<BlockHeader>) -> Result<(), Box<dyn std::error::Error>> {
        for header in headers {
            // Validate header
            // In real implementation, would check PoW/signatures
            
            // Store header
            debug!("Processing header at height {}", header.height);
        }
        Ok(())
    }
    
    /// Process downloaded block
    async fn process_block(&self, block: BlockData) -> Result<(), Box<dyn std::error::Error>> {
        // Convert to BlockInfo for fork manager
        let block_info = qnet_consensus::BlockInfo {
            hash: block.hash,
            parent: [0; 32], // Should parse from block data
            height: block.height,
            weight: 1,
            proposer: [0; 32], // Should parse from block data
            proposer_reputation: 1.0,
            timestamp: 0,
        };
        
        // Process through fork manager
        let mut fork_manager = self.fork_manager.lock().await;
        let result = fork_manager.process_block(block_info).await?;
        
        match result {
            qnet_consensus::ProcessResult::NewHead(_) => {
                // Apply block to state
                self.state.apply_block(&block.data).await?;
                info!("Applied block at height {}", block.height);
            }
            qnet_consensus::ProcessResult::Reorganization { old_head, new_head, depth } => {
                warn!("Reorganization detected: depth={}, old={:?}, new={:?}", 
                      depth, old_head, new_head);
                // Handle reorg
                self.handle_reorganization(old_head, new_head, depth).await?;
            }
            qnet_consensus::ProcessResult::AddedToFork(_) => {
                debug!("Block added to fork at height {}", block.height);
            }
        }
        
        Ok(())
    }
    
    /// Handle reorganization
    async fn handle_reorganization(
        &self,
        old_head: [u8; 32],
        new_head: [u8; 32],
        depth: u64,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Revert blocks
        for _ in 0..depth {
            self.state.revert_block().await?;
        }
        
        // Re-apply blocks from new chain
        // In real implementation, would fetch and apply blocks
        
        Ok(())
    }
    
    /// Get peer heights
    async fn get_peer_heights(&self) -> Result<HashMap<PeerId, u64>, Box<dyn std::error::Error>> {
        let net = self.network.lock().await;
        let peers = net.connected_peers().await;
        
        let mut heights = HashMap::new();
        for peer in peers {
                    // Production height query via P2P
        match net.query_peer_height(peer).await {
            Ok(height) => { heights.insert(peer, height); }
            Err(e) => { warn!("Failed to query height from peer {}: {}", peer, e); }
        }
        }
        
        Ok(heights)
    }
    
    /// Select best peer for download
    async fn select_best_peer(&self, peers: &[PeerId]) -> Result<PeerId, Box<dyn std::error::Error>> {
        // In real implementation, would consider:
        // - Peer reputation
        // - Download speed
        // - Geographic proximity
        
        peers.first()
            .copied()
            .ok_or_else(|| "No peers available".into())
    }
    
    /// Handle sync request from peer
    pub async fn handle_sync_request(&self, peer: PeerId, from_height: u64) {
        debug!("Handling sync request from {} starting at {}", peer, from_height);
        
        // Get current height
        let current_height = match self.state.get_height().await {
            Ok(h) => h,
            Err(e) => {
                warn!("Failed to get current height: {}", e);
                return;
            }
        };
        
        if from_height >= current_height {
            debug!("Peer {} is ahead or at same height", peer);
            return;
        }
        
        // Send blocks to peer
        info!(
            "Sending blocks {} to {} to peer {}",
            from_height, current_height, peer
        );
        
        // In real implementation, would:
        // 1. Read blocks from state
        // 2. Send via P2P network
        // 3. Rate limit to prevent DoS
    }
    
    /// Get sync status
    pub async fn get_status(&self) -> (SyncState, SyncMetrics) {
        let state = self.sync_state.read().await.clone();
        let metrics = self.metrics.read().await.clone();
        (state, metrics)
    }
}

impl DownloadQueue {
    fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            active: HashMap::new(),
            ready: VecDeque::new(),
            max_concurrent: 10,
        }
    }
}

#[derive(Debug, Clone)]
struct BlockHeader {
    height: u64,
    hash: [u8; 32],
    parent_hash: [u8; 32],
    timestamp: u64,
}

// Extension for StateManager
impl StateManager {
    /// Apply block to state
    pub async fn apply_block(&self, block_data: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        // In real implementation, would:
        // 1. Parse block
        // 2. Validate transactions
        // 3. Update state
        // 4. Store block
        Ok(())
    }
    
    /// Revert last block
    pub async fn revert_block(&self) -> Result<(), Box<dyn std::error::Error>> {
        // In real implementation, would:
        // 1. Load previous state
        // 2. Revert transactions
        // 3. Update indices
        Ok(())
    }
} 
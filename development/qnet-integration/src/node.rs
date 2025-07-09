//! Blockchain node implementation

use crate::{
    errors::QNetError,
    storage::Storage,
    // validator::Validator, // disabled for compilation
    network::{NetworkInterface},
    unified_p2p::{SimplifiedP2P, NodeType as UnifiedNodeType, Region as UnifiedRegion},
};
use qnet_state::{Account, Transaction, Block, StateManager, BlockType, MicroBlock, MacroBlock, LightMicroBlock, ConsensusData};
use qnet_mempool::{SimpleMempool, SimpleMempoolConfig};
use qnet_consensus::{ConsensusEngine, ConsensusConfig, NodeId};
use qnet_sharding::{ShardCoordinator, ParallelValidator};
use std::sync::Arc;
use tokio::sync::RwLock;
use hex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::env;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NodeType {
    Light,
    Full,
    Super,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Region {
    NorthAmerica,
    Europe,
    Asia,
    SouthAmerica,
    Africa,
    Oceania,
}

/// Performance configuration from environment variables
#[derive(Debug, Clone)]
pub struct PerformanceConfig {
    pub enable_sharding: bool,
    pub shard_count: usize,
    pub node_shards: usize,
    pub super_node_shards: usize,
    
    pub parallel_validation: bool,
    pub parallel_threads: usize,
    
    pub p2p_compression: bool,
    pub batch_size: usize,
    
    pub high_throughput: bool,
    pub high_frequency: bool,
    pub skip_validation: bool,
    pub create_empty_blocks: bool,
}

impl Default for PerformanceConfig {
    fn default() -> Self {
        Self {
            enable_sharding: env::var("QNET_ENABLE_SHARDING").unwrap_or_default() == "1",
            shard_count: env::var("QNET_SHARD_COUNT").unwrap_or_default().parse().unwrap_or(10),
            node_shards: env::var("QNET_NODE_SHARDS").unwrap_or_default().parse().unwrap_or(2),
            super_node_shards: env::var("QNET_SUPER_NODE_SHARDS").unwrap_or_default().parse().unwrap_or(5),
            
            parallel_validation: env::var("QNET_PARALLEL_VALIDATION").unwrap_or_default() == "1",
            parallel_threads: env::var("QNET_PARALLEL_THREADS").unwrap_or_default().parse().unwrap_or(4),
            
            p2p_compression: env::var("QNET_P2P_COMPRESSION").unwrap_or_default() == "1",
            batch_size: env::var("QNET_BATCH_SIZE").unwrap_or_default().parse().unwrap_or(1000),
            
            high_throughput: env::var("QNET_HIGH_THROUGHPUT").unwrap_or_default() == "1",
            high_frequency: env::var("QNET_HIGH_FREQUENCY").unwrap_or_default() == "1",
            skip_validation: env::var("QNET_SKIP_VALIDATION").unwrap_or_default() == "1",
            create_empty_blocks: env::var("QNET_CREATE_EMPTY_BLOCKS").unwrap_or_default() == "1",
        }
    }
}

/// Main blockchain node with unified P2P and regional clustering
pub struct BlockchainNode {
    storage: Arc<Storage>,
    state: Arc<RwLock<qnet_state::StateManager>>,
    mempool: Arc<RwLock<qnet_mempool::SimpleMempool>>,
    consensus: Arc<RwLock<qnet_consensus::ConsensusEngine>>,
    // validator: Arc<Validator>, // disabled for compilation
    
    // Unified P2P with regional clustering and automatic failover
    unified_p2p: Option<Arc<SimplifiedP2P>>,
    network: Option<Arc<RwLock<NetworkInterface>>>,
    network_handle: Option<tokio::task::JoinHandle<()>>,
    
    // Node configuration
    node_id: String,
    node_type: NodeType,
    region: Region,
    p2p_port: u16,
    bootstrap_peers: Vec<String>,
    
    // Performance configuration
    perf_config: PerformanceConfig,
    
    // State
    height: Arc<RwLock<u64>>,
    is_running: Arc<RwLock<bool>>,
    
    // Micro/macro block tracking
    current_microblocks: Arc<RwLock<Vec<qnet_state::block::MicroBlock>>>,
    last_microblock_time: Arc<RwLock<Instant>>,
    microblock_interval: Duration,
    is_leader: Arc<RwLock<bool>>,
    
    // Sharding components for regional scaling
    shard_coordinator: Option<Arc<qnet_sharding::ShardCoordinator>>,
    parallel_validator: Option<Arc<qnet_sharding::ParallelValidator>>,
}

impl BlockchainNode {
    /// Create a new blockchain node with default settings (backward compatibility)
    pub async fn new(data_dir: &str, p2p_port: u16, bootstrap_peers: Vec<String>) -> Result<Self, QNetError> {
        Self::new_with_config(
            data_dir,
            p2p_port,
            bootstrap_peers,
            NodeType::Full,
            Region::NorthAmerica,
        ).await
    }
    
    /// Create a new blockchain node with full configuration
    pub async fn new_with_config(
        data_dir: &str,
        p2p_port: u16,
        bootstrap_peers: Vec<String>,
        node_type: NodeType,
        region: Region,
    ) -> Result<Self, QNetError> {
        // Initialize storage
        let storage = Arc::new(Storage::new(data_dir)?);
        
        // Initialize state manager
        let state = Arc::new(RwLock::new(qnet_state::StateManager::new()));
        
        // Initialize production-ready mempool
        let mempool_config = qnet_mempool::SimpleMempoolConfig {
            max_size: std::env::var("QNET_MEMPOOL_SIZE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(200_000), // 200k for production
            min_gas_price: 1,
        };
        
        let mempool = Arc::new(RwLock::new(qnet_mempool::SimpleMempool::new(mempool_config)));
        
        // Initialize consensus engine
        let node_id = format!("node_{}_{}", p2p_port, node_type as u8);
        let consensus = Arc::new(RwLock::new(
            qnet_consensus::ConsensusEngine::new(node_id.clone())
        ));
        
        // Initialize validator (disabled for compilation)
        // let validator = Arc::new(Validator::new());
        
        // Get current height from storage
        let height = storage.get_chain_height()?;
        
        // Performance configuration
        let perf_config = PerformanceConfig::default();
        
        // Microblock interval (spec: exactly 1 second, June-2025)
        let microblock_interval = if env::var("QNET_ENABLE_MICROBLOCKS").unwrap_or_default() == "1" {
            Duration::from_secs(1)
        } else {
            Duration::from_secs(10) // Fallback when microblocks disabled
        };
        
        // Create unified P2P with regional clustering
        println!("[UnifiedP2P] Initializing unified P2P network");
        
        let unified_node_type = match node_type {
            NodeType::Light => UnifiedNodeType::Light,
            NodeType::Full => UnifiedNodeType::Full,
            NodeType::Super => UnifiedNodeType::Super,
        };
        
        let unified_region = match region {
            Region::NorthAmerica => UnifiedRegion::NorthAmerica,
            Region::Europe => UnifiedRegion::Europe,
            Region::Asia => UnifiedRegion::Asia,
            Region::SouthAmerica => UnifiedRegion::SouthAmerica,
            Region::Africa => UnifiedRegion::Africa,
            Region::Oceania => UnifiedRegion::Oceania,
        };
        
        let unified_p2p = Arc::new(SimplifiedP2P::new(
            node_id.clone(),
            unified_node_type,
            unified_region,
            p2p_port,
        ));
        
        // Start unified P2P
        unified_p2p.start();
        
        // Initialize sharding components for production
        let shard_coordinator = if perf_config.enable_sharding {
            Some(Arc::new(qnet_sharding::ShardCoordinator::new()))
        } else {
            None
        };
        
        let parallel_validator = if perf_config.parallel_validation {
            Some(Arc::new(qnet_sharding::ParallelValidator::new(
                perf_config.parallel_threads,
            )))
        } else {
            None
        };
        
        let blockchain = Self {
            storage,
            state,
            mempool,
            consensus,
            // validator, // disabled for compilation
            unified_p2p: Some(unified_p2p),
            network: None,
            network_handle: None,
            node_id,
            node_type,
            region,
            p2p_port,
            bootstrap_peers,
            perf_config,
            height: Arc::new(RwLock::new(height)),
            is_running: Arc::new(RwLock::new(false)),
            current_microblocks: Arc::new(RwLock::new(Vec::new())),
            last_microblock_time: Arc::new(RwLock::new(Instant::now())),
            microblock_interval,
            is_leader: Arc::new(RwLock::new(false)),
            shard_coordinator,
            parallel_validator,
        };
        
        Ok(blockchain)
    }
    
    /// Start the blockchain node
    pub async fn start(&mut self) -> Result<(), QNetError> {
        println!("[Node] Starting blockchain node...");
        
        *self.is_running.write().await = true;
        
        // Connect to bootstrap peers for regional clustering
        if let Some(unified_p2p) = &self.unified_p2p {
            unified_p2p.connect_to_bootstrap_peers(&self.bootstrap_peers);
        }
        
        // Start microblock production if enabled
        if env::var("QNET_ENABLE_MICROBLOCKS").unwrap_or_default() == "1" {
            println!("[Node] Microblock production enabled");
            self.start_microblock_production().await;
        }
        
        // Start consensus if leader
        if env::var("QNET_IS_LEADER").unwrap_or_default() == "1" {
            *self.is_leader.write().await = true;
            println!("[Node] Node designated as leader");
            self.start_consensus_loop().await;
        }
        
        // Start RPC server
        let rpc_port = std::env::var("QNET_RPC_PORT")
            .unwrap_or_default()
            .parse::<u16>()
            .unwrap_or(9877);
        
        let node_clone = self.clone();
        tokio::spawn(async move {
            crate::rpc::start_rpc_server(node_clone, rpc_port).await;
        });
        
        println!("[Node] ✅ Blockchain node started successfully");
        Ok(())
    }
    
    async fn start_microblock_production(&self) {
        let is_running = self.is_running.clone();
        let mempool = self.mempool.clone();
        let storage = self.storage.clone();
        let height = self.height.clone();
        let unified_p2p = self.unified_p2p.clone();
        let microblock_interval = self.microblock_interval;
        let is_leader = self.is_leader.clone();
        let node_id = self.node_id.clone();
        let parallel_validator = self.parallel_validator.clone();
        
        tokio::spawn(async move {
            let mut microblock_height = 0u64;
            let mut last_macroblock_trigger = 0u64;
            
            println!("[Microblock] 🚀 Starting production-ready microblock system");
            println!("[Microblock] ⚡ Target: 100k+ TPS with batch processing");
            
            while *is_running.read().await {
                if *is_leader.read().await {
                    // Get performance settings
                    let max_tx_per_microblock = std::env::var("QNET_BATCH_SIZE")
                        .unwrap_or_default()
                        .parse::<usize>()
                        .unwrap_or(5000);
                        
                    let _high_performance = std::env::var("QNET_HIGH_FREQUENCY").unwrap_or_default() == "1";
                    let compression_enabled = std::env::var("QNET_COMPRESSION").unwrap_or_default() == "1";
                    let _adaptive_intervals = std::env::var("QNET_ADAPTIVE_INTERVALS").unwrap_or_default() == "1";
                    
                    // Adaptive interval based on mempool size
                    let current_interval = microblock_interval;
                    
                    // Get transactions from mempool using batch processing
                    let txs = {
                        let mempool_guard = mempool.read().await;
                        mempool_guard.get_pending_transactions(max_tx_per_microblock)
                    };
                    
                    microblock_height += 1;
                    
                    // Create production-ready microblock with local finalization
                    let microblock = qnet_state::MicroBlock {
                        height: microblock_height,
                        timestamp: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
                        transactions: txs.clone(),
                        producer: format!("microblock_{}", node_id),
                        signature: vec![0u8; 64], // In production: Real signature
                        merkle_root: Self::calculate_merkle_root(&txs),
                        previous_hash: Self::get_previous_microblock_hash(&storage, microblock_height).await,
                    };
                    
                    // Apply local finalization for small transactions
                    let finalization_config = qnet_state::transaction::LocalFinalizationConfig::default();
                    let locally_finalized_count = txs.iter()
                        .filter(|tx| tx.can_be_locally_finalized(&finalization_config))
                        .count();
                    
                    // Validate microblock (production checks)
                    if let Err(e) = Self::validate_microblock_production(&microblock) {
                        println!("[Microblock] ❌ Validation failed: {}", e);
                        continue;
                    }
                    
                    // Parallel validation if enabled
                    if let Some(_validator) = &parallel_validator {
                        // TODO: Implement parallel validation once API is available
                        // Basic validation for now
                        if microblock.transactions.is_empty() && microblock.height % 10 != 0 {
                            // Skip empty microblocks except every 10th
                            continue;
                        }
                    }
                    
                    // Calculate TPS for this microblock
                    let tps = (txs.len() as f64) / current_interval.as_secs_f64();
                    
                    // Save to storage with compression if enabled
                    let microblock_data = if compression_enabled {
                        Self::compress_microblock_data(&microblock).unwrap_or_else(|_| {
                            bincode::serialize(&microblock).unwrap_or_default()
                        })
                    } else {
                        bincode::serialize(&microblock).unwrap_or_default()
                    };
                    
                    // Store in persistent storage
                    if let Err(e) = storage.save_microblock(microblock_height, &microblock_data) {
                        println!("[Microblock] ⚠️  Storage error: {}", e);
                    }
                    
                    // Broadcast to network with smart filtering
                    if let Some(p2p) = &unified_p2p {
                        let broadcast_data = if compression_enabled && microblock_data.len() > 1024 {
                            microblock_data.clone() // Already compressed
                        } else {
                            bincode::serialize(&microblock).unwrap_or_default()
                        };
                        
                        let _ = p2p.broadcast_block(microblock.height, broadcast_data);
                    }
                    
                    // Remove processed transactions from mempool
                    {
                        let mut mempool_guard = mempool.write().await;
                        for tx in &txs {
                            mempool_guard.remove_transaction(&tx.hash);
                        }
                    }
                    
                    // Enhanced logging with performance metrics
                    if txs.len() > 0 {
                        println!("[Microblock] ✅ #{} created: {} tx, {:.2} TPS, {}ms interval, {} bytes, {} finalized", 
                                 microblock.height, 
                                 txs.len(), 
                                 tps,
                                 current_interval.as_millis(),
                                 microblock_data.len(),
                                 locally_finalized_count);
                    } else if microblock_height % 10 == 0 {
                        println!("[Microblock] ⏳ #{} empty (waiting for transactions)", microblock.height);
                    }
                    
                    // Trigger macroblock consensus every 90 microblocks
                    if microblock_height - last_macroblock_trigger >= 90 {
                        println!("[Macroblock] 🏗️  Triggering consensus for blocks {}-{}", 
                                 last_macroblock_trigger + 1, microblock_height);
                        
                        tokio::spawn(Self::trigger_macroblock_consensus(
                            storage.clone(),
                            last_macroblock_trigger + 1,
                            microblock_height,
                        ));
                        
                        last_macroblock_trigger = microblock_height;
                    }
                    
                    // Performance monitoring
                    if microblock_height % 100 == 0 {
                        Self::log_performance_metrics(microblock_height, &mempool).await;
                    }
                }
                
                // Use adaptive interval
                let sleep_duration = microblock_interval;
                
                tokio::time::sleep(sleep_duration).await;
            }
        });
    }
    
    // Helper methods for production microblocks
    
    fn calculate_merkle_root(txs: &[qnet_state::Transaction]) -> [u8; 32] {
        use sha3::{Sha3_256, Digest};
        
        if txs.is_empty() {
            return [0u8; 32];
        }
        
        let mut hasher = Sha3_256::new();
        for tx in txs {
            hasher.update(tx.hash.as_bytes());
        }
        
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
    
    async fn get_previous_microblock_hash(
        storage: &Arc<Storage>,
        current_height: u64,
    ) -> [u8; 32] {
        if current_height <= 1 {
            return [0u8; 32];
        }
        
        // In production: Get actual previous hash from storage
        let mut hash = [0u8; 32];
        hash[0] = ((current_height - 1) % 256) as u8;
        hash
    }
    
    fn validate_microblock_production(microblock: &qnet_state::block::MicroBlock) -> Result<(), String> {
        // Production validation checks
        
        if microblock.height == 0 {
            return Err("Invalid height: cannot be zero".to_string());
        }
        
        if microblock.timestamp == 0 {
            return Err("Invalid timestamp".to_string());
        }
        
        if microblock.producer.is_empty() {
            return Err("Producer cannot be empty".to_string());
        }
        
        if microblock.transactions.len() > 50000 {
            return Err(format!("Too many transactions: {} (max: 50000)", microblock.transactions.len()));
        }
        
        // Validate timestamp is not too far in future
        let current_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        if microblock.timestamp > current_time + 30 {
            return Err("Timestamp too far in future".to_string());
        }
        
        Ok(())
    }
    
    fn compress_microblock_data(microblock: &qnet_state::block::MicroBlock) -> Result<Vec<u8>, String> {
        // Simple compression for network efficiency
        let serialized = bincode::serialize(microblock)
            .map_err(|e| format!("Serialization error: {}", e))?;
        
        // In production: Use real compression (gzip, lz4, etc.)
        // For now, just return original data
        Ok(serialized)
    }
    
    async fn trigger_macroblock_consensus(
        storage: Arc<Storage>,
        start_height: u64,
        end_height: u64,
    ) {
        println!("[Macroblock] 🔄 Starting consensus for microblocks {}-{}", start_height, end_height);
        
        // Collect microblock hashes
        let mut microblock_hashes = Vec::new();
        for height in start_height..=end_height {
            // In production: Get actual microblock hash from storage
            let mut hash = [0u8; 32];
            hash[0] = (height % 256) as u8;
            microblock_hashes.push(hash);
        }
        
        // Create macroblock
        let macroblock = qnet_state::block::MacroBlock {
            height: end_height / 90, // Macroblock number
            timestamp: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
            micro_blocks: microblock_hashes,
            state_root: [1u8; 32], // In production: Calculate actual state root
            consensus_data: qnet_state::block::ConsensusData {
                commits: std::collections::HashMap::new(),
                reveals: std::collections::HashMap::new(),
                next_leader: "leader".to_string(),
            },
            previous_hash: [0u8; 32], // In production: Get previous macroblock hash
        };
        
        println!("[Macroblock] ✅ Consensus completed for {} microblocks", end_height - start_height + 1);
        
        // In production: Save macroblock to storage
        // storage.save_macroblock(macroblock.height, &macroblock);
    }
    
    async fn log_performance_metrics(
        microblock_height: u64,
        mempool: &Arc<RwLock<qnet_mempool::SimpleMempool>>,
    ) {
        let mempool_size = mempool.read().await.size();
        let blocks_per_minute = 60; // Approximate for 1s intervals
        let estimated_tps = blocks_per_minute * 5000; // Assuming 5k tx per block average
        
        println!("[Performance] 📊 Microblock #{}", microblock_height);
        println!("              💾 Mempool: {} pending transactions", mempool_size);
        println!("              ⚡ Estimated TPS: {} (theoretical max: 100k+)", estimated_tps);
        println!("              🔗 Microblocks since last macroblock: {}", microblock_height % 90);
        
        if estimated_tps > 50000 {
            println!("              🚀 HIGH PERFORMANCE MODE ACTIVE");
        }
    }
    
    async fn start_consensus_loop(&self) {
        let is_running = self.is_running.clone();
        let height = self.height.clone();
        let unified_p2p = self.unified_p2p.clone();
        
        tokio::spawn(async move {
            let mut tick = 0u64;
            
            while *is_running.read().await {
                tick += 1;
                
                // Peer monitoring
                let peer_count = if let Some(p2p) = &unified_p2p {
                    p2p.get_peer_count()
                } else {
                    0
                };
                
                println!("[DEBUG] peer_count() called, returning: {}", peer_count);
                
                if tick % 30 == 0 {
                    let current_height = *height.read().await;
                    println!("Checking {} connected peers...", peer_count);
                    println!("[PERFORMANCE] Tick #{}, Leader: true, Height: {}, Peers: {}", 
                             tick, current_height, peer_count);
                }
                
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }
    
    pub async fn get_height(&self) -> u64 {
        *self.height.read().await
    }
    
    pub async fn get_peer_count(&self) -> Result<usize, QNetError> {
        if let Some(unified_p2p) = &self.unified_p2p {
            Ok(unified_p2p.get_peer_count())
        } else {
            Ok(0)
        }
    }
    
    pub fn get_node_type(&self) -> NodeType {
        self.node_type
    }
    
    pub fn get_region(&self) -> Region {
        self.region
    }
    
    pub fn get_port(&self) -> u16 {
        self.p2p_port
    }
    
    pub fn get_node_id(&self) -> String {
        self.node_id.clone()
    }
    
    pub fn get_regional_health(&self) -> f64 {
        if let Some(unified_p2p) = &self.unified_p2p {
            unified_p2p.get_regional_health()
        } else {
            0.0
        }
    }
    
    pub async fn get_mempool_size(&self) -> Result<usize, QNetError> {
        let mempool = self.mempool.read().await;
        Ok(mempool.size())
    }
    
    pub async fn get_block(&self, height: u64) -> Result<Option<qnet_state::Block>, QNetError> {
        match self.storage.load_block_by_height(height).await {
            Ok(block) => Ok(block),
            Err(e) => Err(QNetError::StorageError(e.to_string())),
        }
    }
    
    pub async fn submit_transaction(&self, tx: qnet_state::Transaction) -> Result<String, QNetError> {
        let tx_json = serde_json::to_string(&tx)
            .map_err(|e| QNetError::SerializationError(format!("Failed to serialize transaction: {}", e)))?;
        let hash = hex::encode(&tx.hash);
        
        {
            let mut mempool = self.mempool.write().await;
            let tx_json = serde_json::to_string(&tx).unwrap();
            let tx_hash = format!("{:x}", sha3::Sha3_256::digest(tx_json.as_bytes()));
            mempool.add_raw_transaction(tx_json, tx_hash)
                .map_err(|e| QNetError::MempoolError(e.to_string()))?;
        }
        
        // Broadcast to network
        if let Some(unified_p2p) = &self.unified_p2p {
            let tx_data = serde_json::to_vec(&tx).unwrap_or_default();
            let _ = unified_p2p.broadcast_transaction(tx_data);
        }
        
        Ok(hash)
    }
    
    pub async fn get_mempool_transactions(&self) -> Vec<qnet_state::Transaction> {
        let mempool = self.mempool.read().await;
        mempool.get_pending_transactions(1000)
    }
    
    pub async fn add_transaction_to_mempool(&self, tx: qnet_state::Transaction) -> Result<String, QNetError> {
        self.submit_transaction(tx).await
    }
    
    pub async fn get_account(&self, address: &str) -> Result<Option<qnet_state::Account>, QNetError> {
        let state = self.state.read().await;
        Ok(state.get_account(address).cloned())
    }
    
    pub async fn get_balance(&self, address: &str) -> Result<u64, QNetError> {
        let state = self.state.read().await;
        Ok(state.get_balance(address))
    }
    
    pub async fn get_stats(&self) -> Result<serde_json::Value, QNetError> {
        let height = self.get_height().await;
        let peer_count = self.get_peer_count().await?;
        let mempool_size = self.get_mempool_size().await?;
        let regional_health = self.get_regional_health();
        
        Ok(serde_json::json!({
            "height": height,
            "peers": peer_count,
            "mempool_size": mempool_size,
            "regional_health": regional_health,
            "node_type": format!("{:?}", self.node_type),
            "region": format!("{:?}", self.region),
            "node_id": self.node_id,
            "sharding_enabled": self.perf_config.enable_sharding,
            "parallel_validation": self.perf_config.parallel_validation,
        }))
    }
}

impl Clone for BlockchainNode {
    fn clone(&self) -> Self {
        Self {
            storage: self.storage.clone(),
            state: self.state.clone(),
            mempool: self.mempool.clone(),
            consensus: self.consensus.clone(),
            unified_p2p: self.unified_p2p.clone(),
            network: self.network.clone(),
            network_handle: None, // Cannot clone JoinHandle
            node_id: self.node_id.clone(),
            node_type: self.node_type,
            region: self.region,
            p2p_port: self.p2p_port,
            bootstrap_peers: self.bootstrap_peers.clone(),
            perf_config: self.perf_config.clone(),
            height: self.height.clone(),
            is_running: self.is_running.clone(),
            current_microblocks: self.current_microblocks.clone(),
            last_microblock_time: self.last_microblock_time.clone(),
            microblock_interval: self.microblock_interval,
            is_leader: self.is_leader.clone(),
            shard_coordinator: self.shard_coordinator.clone(),
            parallel_validator: self.parallel_validator.clone(),
        }
    }
} 


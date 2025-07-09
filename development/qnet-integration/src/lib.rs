//! QNet Integration Module
//! 
//! This module integrates all QNet components into a cohesive blockchain system.

pub mod errors;
pub mod storage;
pub mod validator;
pub mod network;
pub mod unified_p2p;
pub mod node;
pub mod rpc;
pub mod genesis;
pub mod blockchain;

pub use errors::QNetError;
pub use self::storage::Storage;
// pub use self::validator::Validator; // disabled for compilation
pub use network::{NetworkInterface, NetworkEvent, NetworkMessage};
pub use node::{BlockchainNode, NodeType, Region};

// Re-export main types
pub use qnet_state::{Account, Transaction, Block};
pub use qnet_mempool::{Mempool, MempoolConfig};
pub use qnet_consensus::ConsensusConfig;

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, error};
use hex;

use errors::{IntegrationError, IntegrationResult};

// Import the correct type
use qnet_consensus::CommitRevealEngine;

use std::sync::atomic::{AtomicBool, Ordering};

/// Main blockchain coordinator
pub struct QNetBlockchain {
    /// Persistent storage
    storage: Arc<storage::PersistentStorage>,
    
    /// State manager
    state: Arc<RwLock<qnet_state::StateManager>>,
    
    /// Transaction mempool
    mempool: Arc<qnet_mempool::Mempool>,
    
    /// Consensus mechanism
    consensus: Arc<CommitRevealEngine>,
    
    /// Block validator
    validator: Arc<validator::BlockValidator>,
    
    /// Current blockchain height
    height: Arc<RwLock<u64>>,
    
    /// Is blockchain running
    is_running: Arc<RwLock<bool>>,
    
    /// Network interface
    network: Option<Arc<RwLock<NetworkInterface>>>,
    
    /// Network handle
    network_handle: Option<tokio::task::JoinHandle<()>>,
}

impl QNetBlockchain {
    /// Create new blockchain instance
    pub async fn new(data_dir: &str) -> IntegrationResult<Self> {
        info!("Initializing QNet blockchain at {}", data_dir);
        
        // Initialize persistent storage
        let storage = Arc::new(storage::PersistentStorage::new(data_dir)?);
        
        // Initialize state manager
        let state = Arc::new(RwLock::new(qnet_state::StateManager::new()));
        
        // Initialize mempool
        let mempool_config = qnet_mempool::MempoolConfig {
            max_size: 10000,
            max_per_account: 100,
            min_gas_price: 1,
            tx_expiry: std::time::Duration::from_secs(3600),
            eviction_interval: std::time::Duration::from_secs(300),
            enable_priority_senders: true,
        };
        let mempool = Arc::new(qnet_mempool::Mempool::new(
            mempool_config,
        ));
        
        // Initialize consensus
        let consensus = Arc::new(CommitRevealEngine::new(
            "node1".to_string(),
        ));
        
        // Initialize validator
        let validator = Arc::new(validator::BlockValidator::new());
        
        // Get current height from storage
        let height = storage.get_chain_height()?;
        
        // Start P2P network
        let bootstrap_peers = vec!["node1".to_string()]; // TODO: Get from config
        let (network, network_handle) = network::start_p2p_network(
            12345,
            bootstrap_peers,
        ).await
        .map_err(|e| IntegrationError::NetworkError(e.to_string()))?;
        
        let blockchain = Self {
            storage,
            state,
            mempool,
            consensus,
            validator,
            height: Arc::new(RwLock::new(height)),
            is_running: Arc::new(RwLock::new(false)),
            network: Some(Arc::new(RwLock::new(network))),
            network_handle: Some(network_handle),
        };
        
        // Initialize genesis block if needed
        if height == 0 {
            blockchain.initialize_genesis().await?;
        }
        
        Ok(blockchain)
    }
    
    /// Initialize genesis block
    async fn initialize_genesis(&self) -> IntegrationResult<()> {
        info!("Initializing genesis block...");
        
        let genesis_config = genesis::GenesisConfig::default();
        let genesis_block = genesis::create_genesis_block(genesis_config)?;
        
        // Process genesis block
        self.process_block(genesis_block).await?;
        
        info!("Genesis block created successfully");
        Ok(())
    }
    
    /// Start the blockchain
    pub async fn start(self: Arc<Self>) -> IntegrationResult<()> {
        // Check if already running
        {
            let is_running = self.is_running.read().await;
            if *is_running {
                return Err(IntegrationError::AlreadyRunning);
            }
        }
        
        // Set running flag
        {
            let mut is_running = self.is_running.write().await;
            *is_running = true;
        }
        
        info!("Starting QNet blockchain...");
        
        // Start consensus loop
        self.start_consensus_loop().await;
        
        Ok(())
    }
    
    /// Stop the blockchain
    pub async fn stop(&self) -> IntegrationResult<()> {
        let mut is_running = self.is_running.write().await;
        *is_running = false;
        
        info!("QNet blockchain stopped");
        Ok(())
    }
    
    /// Submit transaction
    pub async fn submit_transaction(&self, tx: qnet_state::Transaction) -> IntegrationResult<String> {
        // TODO: Validate transaction
        // self.validator.validate_transaction(&tx)?;
        
        // Add to mempool
        self.mempool.add_transaction(tx.clone()).await
            .map_err(|e| IntegrationError::MempoolError(e.to_string()))?;
        
        Ok(tx.hash)
    }
    
    /// Get account balance
    pub async fn get_balance(&self, address: &str) -> IntegrationResult<u64> {
        let state = self.state.read().await;
        Ok(state.get_balance(address))
    }
    
    /// Get blockchain height
    pub async fn get_height(&self) -> u64 {
        *self.height.read().await
    }
    
    /// Get block by height
    pub async fn get_block(&self, height: u64) -> IntegrationResult<Option<qnet_state::Block>> {
        self.storage.load_block_by_height(height).await
    }
    
    /// Get mempool transactions
    pub async fn get_mempool_transactions(&self) -> Vec<qnet_state::Transaction> {
        // TODO: Implement proper mempool transaction retrieval
        vec![]
    }
    
    /// Get account information
    pub async fn get_account(&self, address: &str) -> IntegrationResult<qnet_state::Account> {
        let state = self.state.read().await;
        match state.get_account(address) {
            Some(account) => Ok(account.clone()),
            None => Err(IntegrationError::AccountNotFound(address.to_string())),
        }
    }
    
    /// Get blockchain statistics
    pub async fn get_stats(&self) -> serde_json::Value {
        let storage_stats = self.storage.get_stats().unwrap_or_default();
        let mempool_size = self.mempool.size();
        
        serde_json::json!({
            "total_blocks": storage_stats.total_blocks,
            "total_transactions": storage_stats.total_transactions,
            "total_accounts": storage_stats.total_accounts,
            "latest_height": storage_stats.latest_height,
            "mempool_size": mempool_size,
            "tps": 0, // TODO: Calculate actual TPS
            "network_hashrate": 0
        })
    }
    
    /// Start consensus loop
    async fn start_consensus_loop(self: Arc<Self>) {
        let blockchain = self.clone();
        
        tokio::spawn(async move {
            let mut round = 0u64;
            
            while *blockchain.is_running.read().await {
                round += 1;
                
                if let Err(e) = blockchain.run_consensus_round(round).await {
                    error!("Consensus round {} failed: {}", round, e);
                }
                
                tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
            }
        });
    }
    
    /// Run single consensus round
    async fn run_consensus_round(&self, round: u64) -> IntegrationResult<()> {
        info!("Starting consensus round {}", round);
        
        // TODO: Implement consensus round with CommitRevealEngine
        
        // Create block if we are leader
        self.create_and_process_block(round).await?;
        
        Ok(())
    }
    
    /// Create and process new block
    async fn create_and_process_block(&self, round: u64) -> IntegrationResult<()> {
        // Get transactions from mempool
        let transactions = vec![]; // TODO: Get from mempool
        
        // Get current height
        let height = *self.height.read().await + 1;
        
        // Get previous block hash
        let prev_hash = self.storage.get_block_hash(height - 1)?
            .unwrap_or_else(|| "genesis".to_string());
        
        // Create block
        let previous_hash = [0u8; 32]; // TODO: Get actual previous hash
        let block = qnet_state::Block::new(
            height,
            chrono::Utc::now().timestamp() as u64,
            previous_hash,
            transactions,
            "node1".to_string(), // TODO: Use actual node ID
        );
        
        // TODO: Validate block  
        // self.validator.validate_block(&block)?;
        
        // Process block
        self.process_block(block).await?;
        
        Ok(())
    }
    
    /// Process validated block
    async fn process_block(&self, block: qnet_state::Block) -> IntegrationResult<()> {
        info!("Processing block at height {}", block.height);
        
        // Save block to storage
        self.storage.save_block(&block).await?;
        
        // Update state
        {
            let mut state = self.state.write().await;
            for tx in &block.transactions {
                // Apply transaction to state
                state.apply_transaction(tx)
                    .map_err(|e| IntegrationError::StateError(e.to_string()))?;
            }
        }
        
        // Update height
        {
            let mut height = self.height.write().await;
            *height = block.height;
        }
        
        info!("Produced block {} at height {}", 
            hex::encode(&block.hash()), 
            block.height);
        
        Ok(())
    }
    
    /// Start P2P network
    pub async fn start_network(&mut self, _port: u16, _bootstrap_peers: Vec<String>) -> IntegrationResult<()> {
        // TODO: Implement network start for QNetBlockchain
        Ok(())
    }
    
    /// Process network events
    pub async fn process_network_events(&self) -> IntegrationResult<()> {
        if let Some(network) = &self.network {
            let mut net = network.write().await;
            
            while let Some(event) = net.process_events().await
                .map_err(|e| IntegrationError::NetworkError(e.to_string()))? {
                
                match event {
                    NetworkEvent::MessageReceived { peer_id, message } => {
                        self.handle_network_message(peer_id, message).await?;
                    }
                    NetworkEvent::PeerConnected(peer_id) => {
                        log::info!("Peer connected: {}", peer_id);
                    }
                    NetworkEvent::PeerDisconnected(peer_id) => {
                        log::info!("Peer disconnected: {}", peer_id);
                    }
                    NetworkEvent::Error(err) => {
                        log::error!("Network error: {}", err);
                    }
                }
            }
        }
        
        Ok(())
    }
    
    /// Handle incoming network message
    async fn handle_network_message(&self, peer_id: String, message: NetworkMessage) -> IntegrationResult<()> {
        match message {
            NetworkMessage::NewBlock(block_data) => {
                // Deserialize and process block
                let block: qnet_state::Block = bincode::deserialize(&block_data)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                
                // Validate and process block
                self.validator.validate_block(&block)?;
                self.process_block(block).await?;
            }
            NetworkMessage::NewTransaction(tx_data) => {
                // Deserialize and add to mempool
                let tx: qnet_state::Transaction = bincode::deserialize(&tx_data)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                
                self.mempool.add_transaction(tx).await
                    .map_err(|e| IntegrationError::MempoolError(e.to_string()))?;
            }
            _ => {
                info!("Received message from {}: {:?}", peer_id, message);
            }
        }
        
        Ok(())
    }
    
    /// Broadcast a new block to the network
    async fn broadcast_block(&self, block: &qnet_state::Block) -> IntegrationResult<()> {
        if let Some(network) = &self.network {
            let block_data = bincode::serialize(block)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            
            let net = network.read().await;
            net.broadcast(NetworkMessage::NewBlock(block_data))
                .await
                .map_err(|e| IntegrationError::NetworkError(e.to_string()))?;
        }
        
        Ok(())
    }
}

/// Configuration for blockchain
pub struct BlockchainConfig {
    pub db_path: String,
    pub enable_mining: bool,
    pub mining_interval_ms: u64,
}

/// Blockchain coordinator - simplified interface
pub struct BlockchainCoordinator {
    blockchain: Arc<QNetBlockchain>,
    config: BlockchainConfig,
}

impl BlockchainCoordinator {
    pub async fn new(config: BlockchainConfig) -> IntegrationResult<Self> {
        let blockchain = Arc::new(QNetBlockchain::new(&config.db_path).await?);
        Ok(Self { blockchain, config })
    }
    
    pub async fn start(&self) -> IntegrationResult<()> {
        self.blockchain.clone().start().await
    }
    
    pub async fn stop(&self) -> IntegrationResult<()> {
        self.blockchain.stop().await
    }
    
    pub async fn start_network(&mut self, port: u16, bootstrap_peers: Vec<String>) -> IntegrationResult<()> {
        // TODO: Implement network start for QNetBlockchain
        Ok(())
    }
    
    pub async fn process_network_events(&self) -> IntegrationResult<()> {
        self.blockchain.process_network_events().await
    }
    
    pub fn get_blockchain(&self) -> Arc<QNetBlockchain> {
        self.blockchain.clone()
    }
}

/// Sharding integration for regional scaling to 100k+ TPS
pub mod sharding_integration {
    use crate::node::{NodeType, Region};
    use std::collections::HashMap;
    
    /// Regional sharding configuration for 100k+ TPS scaling
    pub struct RegionalShardingConfig {
        pub total_shards: u32,
        pub shards_per_region: u32,
        pub target_tps: usize,
        pub node_distribution: HashMap<Region, usize>,
    }
    
    impl Default for RegionalShardingConfig {
        fn default() -> Self {
            Self {
                total_shards: 64, // 64 shards for regional distribution
                shards_per_region: 8, // 8 shards per region (6 regions)
                target_tps: 100_000, // Target 100k TPS
                node_distribution: [
                    (Region::NorthAmerica, 20),
                    (Region::Europe, 18),
                    (Region::Asia, 22),
                    (Region::SouthAmerica, 8),
                    (Region::Africa, 6),
                    (Region::Oceania, 6),
                ].iter().cloned().collect(),
            }
        }
    }
    
    /// Calculate shard for address using regional optimization
    pub fn get_regional_shard(address: &str, region: Region) -> u32 {
        use std::hash::{Hash, Hasher};
        use std::collections::hash_map::DefaultHasher;
        
        let mut hasher = DefaultHasher::new();
        address.hash(&mut hasher);
        let hash = hasher.finish();
        
        // Get base shard for region
        let base_shard = match region {
            Region::NorthAmerica => 0,
            Region::Europe => 8,
            Region::Asia => 16,
            Region::SouthAmerica => 24,
            Region::Africa => 32,
            Region::Oceania => 40,
        };
        
        // Distribute within region's 8 shards
        base_shard + (hash % 8) as u32
    }
    
    /// Get sharding statistics for monitoring
    pub fn get_sharding_stats(config: &RegionalShardingConfig) -> ShardingStats {
        let total_nodes: usize = config.node_distribution.values().sum();
        let theoretical_max_tps = config.total_shards as usize * 1_563; // ~1.5k TPS per shard
        
        ShardingStats {
            total_shards: config.total_shards,
            total_nodes,
            shards_per_region: config.shards_per_region,
            theoretical_max_tps,
            efficiency_ratio: config.target_tps as f64 / theoretical_max_tps as f64,
        }
    }
    
    #[derive(Debug, Clone)]
    pub struct ShardingStats {
        pub total_shards: u32,
        pub total_nodes: usize,
        pub shards_per_region: u32,
        pub theoretical_max_tps: usize,
        pub efficiency_ratio: f64,
    }
}

/// Re-export sharding types for convenience
pub use sharding_integration::*; 

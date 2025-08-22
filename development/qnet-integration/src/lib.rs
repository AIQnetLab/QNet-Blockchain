#![allow(unused_imports)]
#![allow(unused_variables)]
#![allow(dead_code)]
#![allow(unused_mut)]
#![recursion_limit = "256"]

//! QNet Integration - Full blockchain system
//! This module integrates all QNet components into a cohesive blockchain system.

pub mod errors;
pub mod storage;
pub mod validator;
pub mod unified_p2p;
pub mod node;
pub mod rpc;
pub mod genesis;
pub mod blockchain;
pub mod activation_validation;
pub mod quantum_crypto;
pub mod network_config;
pub mod archive_manager;
pub mod genesis_constants;

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, error};
use sha3::{Sha3_256, Digest};

// Core imports with correct paths  
pub use qnet_state::{StateManager, Account, Transaction, Block, StateDB, StateError, StateResult};
pub use qnet_mempool::{SimpleMempool, SimpleMempoolConfig};
pub use qnet_consensus::{ConsensusEngine, ConsensusConfig, NodeId};
pub use qnet_sharding::{ShardCoordinator, ParallelValidator};

// Import NetworkMessage for compilation
pub use unified_p2p::NetworkMessage;

// Re-export for external use
pub use errors::{IntegrationError, IntegrationResult};
pub use storage::PersistentStorage;
pub use validator::BlockValidator;
pub use node::{BlockchainNode, NodeType, Region};
pub use unified_p2p::SimplifiedP2P;

use std::sync::atomic::{AtomicBool, Ordering};

/// Main QNet blockchain instance
pub struct QNetBlockchain {
    /// Storage layer
    storage: Arc<storage::PersistentStorage>,
    
    /// State manager
    state_manager: Arc<RwLock<StateManager>>,
    
    /// Transaction mempool
    mempool: Arc<qnet_mempool::SimpleMempool>,
    
    /// Consensus mechanism
    consensus: Arc<qnet_consensus::ConsensusEngine>,
    
    /// Validator
    validator: Arc<validator::BlockValidator>,
    
    /// Node running flag
    running: Arc<AtomicBool>,
    
    /// Shard coordinator
    shard_coordinator: Option<Arc<ShardCoordinator>>,
    
    /// Parallel validator
    parallel_validator: Option<Arc<ParallelValidator>>,
}

impl QNetBlockchain {
    /// Create new QNet blockchain instance
    pub async fn new(data_dir: &str) -> IntegrationResult<Self> {
        info!("Initializing QNet blockchain at {}", data_dir);
        
        // Initialize storage
        let storage = Arc::new(storage::PersistentStorage::new(data_dir)?);
        
        // Initialize state manager
        let state_manager = Arc::new(RwLock::new(StateManager::new()));
        
        // Initialize mempool with production settings
        let mempool_config = qnet_mempool::SimpleMempoolConfig {
            max_size: std::env::var("QNET_MEMPOOL_SIZE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(500_000), // Production default: 500k
            min_gas_price: 1,
        };
        
        let mempool = Arc::new(qnet_mempool::SimpleMempool::new(mempool_config));
        
        // Initialize consensus with proper config
        let consensus_config = qnet_consensus::ConsensusConfig::default();
        let consensus = Arc::new(qnet_consensus::ConsensusEngine::new("node1".to_string(), consensus_config));
        
        // Initialize validator
        let validator = Arc::new(validator::BlockValidator::new());
        
        // Initialize sharding
        let shard_coordinator = Some(Arc::new(ShardCoordinator::new()));
        let parallel_validator = Some(Arc::new(ParallelValidator::new(4)));
        
        Ok(QNetBlockchain {
            storage,
            state_manager,
            mempool,
            consensus,
            validator,
            running: Arc::new(AtomicBool::new(false)),
            shard_coordinator,
            parallel_validator,
        })
    }
    
    /// Initialize genesis block
    pub async fn initialize_genesis(&self) -> IntegrationResult<()> {
        info!("Initializing genesis block...");
        
        let genesis_config = genesis::GenesisConfig::default();
        let genesis_block = genesis::create_genesis_block(genesis_config)?;
        
        self.storage.save_block(&genesis_block).await?;
        
        info!("Genesis block created successfully");
        Ok(())
    }
    
    /// Start the blockchain
    pub async fn start(&self) -> IntegrationResult<()> {
        self.running.store(true, Ordering::SeqCst);
        
        info!("Starting QNet blockchain...");
        
        // CRITICAL: Consensus rounds DISABLED - QNet uses microblock/macroblock architecture
        // Consensus is handled by macroblock triggers every 90 blocks, NOT continuous rounds
        // self.start_consensus_rounds().await?;
        
        // Start network message handling
        self.start_network_handler().await?;
        
        Ok(())
    }
    
    /// Stop the blockchain
    pub async fn stop(&self) -> IntegrationResult<()> {
        self.running.store(false, Ordering::SeqCst);
        
        info!("QNet blockchain stopped");
        Ok(())
    }
    
    /// Add transaction to mempool
    pub async fn add_transaction(&self, tx: Transaction) -> IntegrationResult<()> {
        // Convert transaction to JSON string for SimpleMempool
        let tx_json = serde_json::to_string(&tx).map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        let tx_hash = format!("{:x}", sha3::Sha3_256::digest(tx_json.as_bytes()));
        
        self.mempool.add_raw_transaction(tx_json, tx_hash);
        Ok(())
    }
    
    /// Get pending transactions
    pub async fn get_pending_transactions(&self) -> IntegrationResult<Vec<Transaction>> {
        // SimpleMempool returns raw JSON, we need to convert back
        // For now, return empty vec - this would be implemented properly
        Ok(vec![])
    }
    
    /// Start consensus rounds
    async fn start_consensus_rounds(&self) -> IntegrationResult<()> {
        let consensus = self.consensus.clone();
        let mempool = self.mempool.clone();
        let running = self.running.clone();
        
        tokio::spawn(async move {
            let mut round = 0;
            
            while running.load(Ordering::SeqCst) {
                round += 1;
                
                // Run consensus round
                if let Err(e) = Self::run_consensus_round(&*consensus, &*mempool, round).await {
                    error!("Consensus round {} failed: {}", round, e);
                }
                
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        });
        
        Ok(())
    }
    
    /// Run single consensus round
    async fn run_consensus_round(
        consensus: &ConsensusEngine,
        mempool: &SimpleMempool,
        round: u64
    ) -> IntegrationResult<()> {
        info!("Starting consensus round {}", round);
        
        // For now, just simulate consensus
        // In production, this would run full consensus protocol
        
        Ok(())
    }
    
    /// Process new block
    pub async fn process_block(&self, block: Block) -> IntegrationResult<()> {
        // Validate block
        self.validator.validate_block(&block)?;
        
        // Store block
        self.storage.save_block(&block).await?;
        
        // Update state
        let mut state = self.state_manager.write().await;
        for tx in &block.transactions {
            state.apply_transaction(tx)?;
        }
        
        info!("Processing block at height {}", block.height);
        
        Ok(())
    }
    
    /// Produce new block
    pub async fn produce_block(&self) -> IntegrationResult<Block> {
        // Get transactions from mempool
        // For now, create empty block
        let block = Block {
            height: 1,
            previous_hash: [0u8; 32],
            transactions: vec![],
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            merkle_root: [0u8; 32],
            producer: "node1".to_string(),
            signature: vec![],
        };
        
        info!("Produced block {} at height {}",
            hex::encode(block.hash()), block.height);
        
        Ok(block)
    }
    
    /// Start network event handler
    async fn start_network_handler(&self) -> IntegrationResult<()> {
        let running = self.running.clone();
        
        tokio::spawn(async move {
            while running.load(Ordering::SeqCst) {
                // Simulate network events
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        });
        
        Ok(())
    }
    
    /// Handle network message
    async fn handle_network_message(&self, peer_id: String, message: NetworkMessage) -> IntegrationResult<()> {
        info!("Received message from {}: {:?}", peer_id, message);
        
        match message {
            NetworkMessage::Block { height, data, block_type } => {
                // Process new block
                info!("Received block at height {}: {:?}", height, block_type);
                // For now, just log
            }
            NetworkMessage::Transaction { data, .. } => {
                // Add transaction to mempool
                info!("Received transaction: {:?}", data);
                // For now, just log
            }
            _ => {
                // Handle other message types
            }
        }
        
        Ok(())
    }
    
    /// Broadcast message to network
    pub async fn broadcast_message(&self, message: NetworkMessage) -> IntegrationResult<()> {
        // For now, just log
        info!("Broadcasting message: {:?}", message);
        Ok(())
    }
}

/// Feature flags for testing
pub mod feature_flags {
    use crate::node::{NodeType, Region};
    
    /// Performance configuration
    pub struct PerformanceConfig {
        pub enable_sharding: bool,
        pub enable_parallel_validation: bool,
        pub shard_count: u32,
        pub batch_size: usize,
        pub microblock_interval: std::time::Duration,
    }
    
    impl Default for PerformanceConfig {
        fn default() -> Self {
            Self {
                enable_sharding: true,
                enable_parallel_validation: true,
                shard_count: 100,
                batch_size: 1000,
                microblock_interval: std::time::Duration::from_secs(1),
            }
        }
    }
}

// Add serde_json dependency for serialization
use serde_json;
use hex;

// Re-export commonly used types
pub type BlockHash = [u8; 32];
pub type TransactionHash = [u8; 32];
pub type AccountAddress = String; 

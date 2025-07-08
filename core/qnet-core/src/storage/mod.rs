//! Storage module for QNet blockchain
//! 
//! Provides optimized storage solutions for production deployment

pub mod optimized_storage;

use std::sync::Arc;
use tokio::sync::RwLock;
use serde::{Serialize, Deserialize};

pub use optimized_storage::{
    OptimizedStorage, StorageConfig, StorageStats, StorageError,
    LSMConfig, CompressionConfig, CompressionType, ShardFunction
};

/// Main storage interface for QNet blockchain
pub struct QNetStorage {
    /// Optimized storage backend
    backend: Arc<OptimizedStorage>,
    
    /// Block storage
    blocks: Arc<RwLock<BlockStorage>>,
    
    /// State storage
    state: Arc<RwLock<StateStorage>>,
    
    /// Transaction storage
    transactions: Arc<RwLock<TransactionStorage>>,
    
    /// Node storage
    nodes: Arc<RwLock<NodeStorage>>,
}

/// Block storage interface
pub struct BlockStorage {
    storage: Arc<OptimizedStorage>,
}

/// State storage interface  
pub struct StateStorage {
    storage: Arc<OptimizedStorage>,
}

/// Transaction storage interface
pub struct TransactionStorage {
    storage: Arc<OptimizedStorage>,
}

/// Node storage interface
pub struct NodeStorage {
    storage: Arc<OptimizedStorage>,
}

/// Block data structure
#[derive(Serialize, Deserialize, Clone)]
pub struct BlockData {
    pub height: u64,
    pub hash: [u8; 32],
    pub parent_hash: [u8; 32],
    pub timestamp: u64,
    pub transactions: Vec<TransactionData>,
    pub proposer: [u8; 32],
    pub signature: Vec<u8>,
}

/// Transaction data structure
#[derive(Serialize, Deserialize, Clone)]
pub struct TransactionData {
    pub hash: [u8; 32],
    pub sender: [u8; 32],
    pub receiver: [u8; 32],
    pub amount: u64,
    pub nonce: u64,
    pub signature: Vec<u8>,
    pub transaction_type: TransactionType,
}

/// Transaction types
#[derive(Serialize, Deserialize, Clone)]
pub enum TransactionType {
    Transfer,
    NodeActivation,
    Reward,
    Burn,
}

/// Node data structure
#[derive(Serialize, Deserialize, Clone)]
pub struct NodeData {
    pub node_id: [u8; 32],
    pub public_key: Vec<u8>,
    pub node_type: NodeType,
    pub stake_amount: u64,
    pub reputation: f64,
    pub last_ping: u64,
    pub activation_height: u64,
}

/// Node types
#[derive(Serialize, Deserialize, Clone)]
pub enum NodeType {
    Light,
    Full,
    Super,
}

/// Account state
#[derive(Serialize, Deserialize, Clone)]
pub struct AccountState {
    pub address: [u8; 32],
    pub balance: u64,
    pub nonce: u64,
    pub last_activity: u64,
}

impl QNetStorage {
    /// Create new QNet storage with production optimizations
    pub async fn new(config: StorageConfig) -> Result<Self, StorageError> {
        let backend = Arc::new(OptimizedStorage::new(config).await?);
        
        Ok(Self {
            backend: backend.clone(),
            blocks: Arc::new(RwLock::new(BlockStorage::new(backend.clone()))),
            state: Arc::new(RwLock::new(StateStorage::new(backend.clone()))),
            transactions: Arc::new(RwLock::new(TransactionStorage::new(backend.clone()))),
            nodes: Arc::new(RwLock::new(NodeStorage::new(backend.clone()))),
        })
    }
    
    /// Store block with all related data
    pub async fn store_block(&self, block: &BlockData) -> Result<(), StorageError> {
        // Store block data
        let block_key = self.block_key(block.height);
        let block_bytes = bincode::serialize(block)
            .map_err(|e| StorageError::Serialization(e.to_string()))?;
        self.backend.put(&block_key, &block_bytes).await?;
        
        // Store block hash mapping
        let hash_key = self.block_hash_key(&block.hash);
        let height_bytes = block.height.to_le_bytes();
        self.backend.put(&hash_key, &height_bytes).await?;
        
        // Store transactions
        for tx in &block.transactions {
            self.store_transaction(tx, block.height).await?;
        }
        
        // Update latest height
        let latest_key = b"latest_height";
        self.backend.put(latest_key, &height_bytes).await?;
        
        Ok(())
    }
    
    /// Get block by height
    pub async fn get_block(&self, height: u64) -> Result<Option<BlockData>, StorageError> {
        let key = self.block_key(height);
        match self.backend.get(&key).await? {
            Some(bytes) => {
                let block: BlockData = bincode::deserialize(&bytes)
                    .map_err(|e| StorageError::Serialization(e.to_string()))?;
                Ok(Some(block))
            }
            None => Ok(None),
        }
    }
    
    /// Get block by hash
    pub async fn get_block_by_hash(&self, hash: &[u8; 32]) -> Result<Option<BlockData>, StorageError> {
        let hash_key = self.block_hash_key(hash);
        match self.backend.get(&hash_key).await? {
            Some(height_bytes) => {
                if height_bytes.len() == 8 {
                    let height = u64::from_le_bytes([
                        height_bytes[0], height_bytes[1], height_bytes[2], height_bytes[3],
                        height_bytes[4], height_bytes[5], height_bytes[6], height_bytes[7],
                    ]);
                    self.get_block(height).await
                } else {
                    Ok(None)
                }
            }
            None => Ok(None),
        }
    }
    
    /// Store transaction
    pub async fn store_transaction(&self, tx: &TransactionData, block_height: u64) -> Result<(), StorageError> {
        let tx_key = self.transaction_key(&tx.hash);
        let tx_bytes = bincode::serialize(tx)
            .map_err(|e| StorageError::Serialization(e.to_string()))?;
        self.backend.put(&tx_key, &tx_bytes).await?;
        
        // Store transaction-to-block mapping
        let tx_block_key = self.transaction_block_key(&tx.hash);
        let block_bytes = block_height.to_le_bytes();
        self.backend.put(&tx_block_key, &block_bytes).await?;
        
        Ok(())
    }
    
    /// Get transaction by hash
    pub async fn get_transaction(&self, hash: &[u8; 32]) -> Result<Option<TransactionData>, StorageError> {
        let key = self.transaction_key(hash);
        match self.backend.get(&key).await? {
            Some(bytes) => {
                let tx: TransactionData = bincode::deserialize(&bytes)
                    .map_err(|e| StorageError::Serialization(e.to_string()))?;
                Ok(Some(tx))
            }
            None => Ok(None),
        }
    }
    
    /// Store node data
    pub async fn store_node(&self, node: &NodeData) -> Result<(), StorageError> {
        let node_key = self.node_key(&node.node_id);
        let node_bytes = bincode::serialize(node)
            .map_err(|e| StorageError::Serialization(e.to_string()))?;
        self.backend.put(&node_key, &node_bytes).await?;
        Ok(())
    }
    
    /// Get node by ID
    pub async fn get_node(&self, node_id: &[u8; 32]) -> Result<Option<NodeData>, StorageError> {
        let key = self.node_key(node_id);
        match self.backend.get(&key).await? {
            Some(bytes) => {
                let node: NodeData = bincode::deserialize(&bytes)
                    .map_err(|e| StorageError::Serialization(e.to_string()))?;
                Ok(Some(node))
            }
            None => Ok(None),
        }
    }
    
    /// Store account state
    pub async fn store_account(&self, account: &AccountState) -> Result<(), StorageError> {
        let account_key = self.account_key(&account.address);
        let account_bytes = bincode::serialize(account)
            .map_err(|e| StorageError::Serialization(e.to_string()))?;
        self.backend.put(&account_key, &account_bytes).await?;
        Ok(())
    }
    
    /// Get account state
    pub async fn get_account(&self, address: &[u8; 32]) -> Result<Option<AccountState>, StorageError> {
        let key = self.account_key(address);
        match self.backend.get(&key).await? {
            Some(bytes) => {
                let account: AccountState = bincode::deserialize(&bytes)
                    .map_err(|e| StorageError::Serialization(e.to_string()))?;
                Ok(Some(account))
            }
            None => Ok(None),
        }
    }
    
    /// Get latest block height
    pub async fn get_latest_height(&self) -> Result<u64, StorageError> {
        let key = b"latest_height";
        match self.backend.get(key).await? {
            Some(bytes) if bytes.len() == 8 => {
                Ok(u64::from_le_bytes([
                    bytes[0], bytes[1], bytes[2], bytes[3],
                    bytes[4], bytes[5], bytes[6], bytes[7],
                ]))
            }
            _ => Ok(0),
        }
    }
    
    /// Batch operations for efficiency
    pub async fn batch_store_blocks(&self, blocks: Vec<BlockData>) -> Result<(), StorageError> {
        let mut operations = Vec::new();
        
        for block in blocks {
            let block_key = self.block_key(block.height);
            let block_bytes = bincode::serialize(&block)
                .map_err(|e| StorageError::Serialization(e.to_string()))?;
            operations.push((block_key, block_bytes));
            
            // Add hash mapping
            let hash_key = self.block_hash_key(&block.hash);
            let height_bytes = block.height.to_le_bytes().to_vec();
            operations.push((hash_key, height_bytes));
        }
        
        self.backend.batch_put(operations).await?;
        Ok(())
    }
    
    /// Get storage statistics
    pub async fn get_stats(&self) -> StorageStats {
        self.backend.get_stats().await
    }
    
    /// Optimize storage (trigger compaction)
    pub async fn optimize(&self) -> Result<(), StorageError> {
        self.backend.optimize().await
    }
    
    // Key generation helpers
    fn block_key(&self, height: u64) -> Vec<u8> {
        let mut key = b"block_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        key
    }
    
    fn block_hash_key(&self, hash: &[u8; 32]) -> Vec<u8> {
        let mut key = b"block_hash_".to_vec();
        key.extend_from_slice(hash);
        key
    }
    
    fn transaction_key(&self, hash: &[u8; 32]) -> Vec<u8> {
        let mut key = b"tx_".to_vec();
        key.extend_from_slice(hash);
        key
    }
    
    fn transaction_block_key(&self, hash: &[u8; 32]) -> Vec<u8> {
        let mut key = b"tx_block_".to_vec();
        key.extend_from_slice(hash);
        key
    }
    
    fn node_key(&self, node_id: &[u8; 32]) -> Vec<u8> {
        let mut key = b"node_".to_vec();
        key.extend_from_slice(node_id);
        key
    }
    
    fn account_key(&self, address: &[u8; 32]) -> Vec<u8> {
        let mut key = b"account_".to_vec();
        key.extend_from_slice(address);
        key
    }
}

// Implementation stubs for storage components
impl BlockStorage {
    fn new(storage: Arc<OptimizedStorage>) -> Self {
        Self { storage }
    }
}

impl StateStorage {
    fn new(storage: Arc<OptimizedStorage>) -> Self {
        Self { storage }
    }
}

impl TransactionStorage {
    fn new(storage: Arc<OptimizedStorage>) -> Self {
        Self { storage }
    }
}

impl NodeStorage {
    fn new(storage: Arc<OptimizedStorage>) -> Self {
        Self { storage }
    }
}

/// Production storage configuration for QNet
impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            shard_count: 64,                    // 64 shards for massive scale
            bloom_filter_size: 10_000_000,     // 10M expected elements
            false_positive_rate: 0.01,         // 1% false positive rate
            cache_size: 1_073_741_824,         // 1GB cache
            lsm_config: LSMConfig {
                memtable_size: 64 * 1024 * 1024,    // 64MB memtable
                max_level_size: 256 * 1024 * 1024,  // 256MB max level
                compaction_strategy: optimized_storage::CompactionStrategy::Leveled,
            },
            compression: CompressionConfig {
                algorithm: CompressionType::Zstd,
                level: 3,
                min_size: 1024,                     // Compress files > 1KB
            },
        }
    }
} 
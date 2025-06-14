//! High-performance persistent storage using RocksDB

use rocksdb::{DB, Options, WriteBatch, IteratorMode};
use serde::{Serialize, Deserialize};
use std::path::Path;
use std::sync::Arc;
use crate::errors::{IntegrationError, IntegrationResult};
use crate::errors::QNetError;
use qnet_state::Block;

/// Column families for different data types
const CF_BLOCKS: &str = "blocks";
const CF_TRANSACTIONS: &str = "transactions";
const CF_ACCOUNTS: &str = "accounts";
const CF_METADATA: &str = "metadata";

/// High-performance persistent storage using RocksDB
pub struct PersistentStorage {
    db: Arc<DB>,
}

impl PersistentStorage {
    /// Create new storage instance with optimized settings
    pub fn new(path: &str) -> IntegrationResult<Self> {
        let storage_path = Path::new(path).join("blockchain");
        std::fs::create_dir_all(&storage_path)
            .map_err(|e| IntegrationError::StorageError(format!("Failed to create directory: {}", e)))?;
        
        // Configure RocksDB for high performance
        let mut opts = Options::default();
        opts.create_if_missing(true);
        opts.create_missing_column_families(true);
        opts.set_max_open_files(10000);
        opts.set_use_fsync(false);
        opts.set_bytes_per_sync(8388608);
        opts.optimize_for_point_lookup(1024);
        opts.set_table_cache_num_shard_bits(6);
        opts.set_max_write_buffer_number(3);
        opts.set_write_buffer_size(64 * 1024 * 1024); // 64MB
        opts.set_target_file_size_base(64 * 1024 * 1024); // 64MB
        opts.set_min_write_buffer_number_to_merge(1);
        opts.set_level_zero_stop_writes_trigger(24);
        opts.set_level_zero_slowdown_writes_trigger(17);
        opts.set_max_background_jobs(4);
        opts.set_max_background_compactions(4);
        opts.set_disable_auto_compactions(false);
        opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
        
        // Open database with column families
        let cfs = vec![CF_BLOCKS, CF_TRANSACTIONS, CF_ACCOUNTS, CF_METADATA];
        let db = DB::open_cf(&opts, storage_path, cfs)
            .map_err(|e| IntegrationError::StorageError(format!("Failed to open RocksDB: {}", e)))?;
        
        Ok(Self {
            db: Arc::new(db),
        })
    }
    
    /// Save block to storage
    pub async fn save_block(&self, block: &qnet_state::Block) -> IntegrationResult<()> {
        let cf = self.db.cf_handle(CF_BLOCKS)
            .ok_or_else(|| IntegrationError::StorageError("Blocks CF not found".to_string()))?;
        
        // Serialize block
        let block_data = bincode::serialize(block)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        // Create batch for atomic writes
        let mut batch = WriteBatch::default();
        
        // Save block by height
        let height_key = height_key(block.height);
        batch.put_cf(&cf, &height_key, &block_data);
        
        // Save block by hash
        let hash = block.hash();
        let hash_key = hash_key(&hex::encode(&hash));
        batch.put_cf(&cf, &hash_key, &block_data);
        
        // Update metadata
        let meta_cf = self.db.cf_handle(CF_METADATA)
            .ok_or_else(|| IntegrationError::StorageError("Metadata CF not found".to_string()))?;
        batch.put_cf(&meta_cf, b"latest_height", &block.height.to_le_bytes());
        
        batch.put_cf(&meta_cf, b"latest_hash", &hash);
        
        // Save transactions
        let tx_cf = self.db.cf_handle(CF_TRANSACTIONS)
            .ok_or_else(|| IntegrationError::StorageError("Transactions CF not found".to_string()))?;
        
        for tx in &block.transactions {
            let tx_data = bincode::serialize(tx)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            batch.put_cf(&tx_cf, tx.hash.as_bytes(), &tx_data);
        }
        
        // Write batch
        self.db.write(batch)
            .map_err(|e| IntegrationError::StorageError(format!("Failed to save block: {}", e)))?;
        
        Ok(())
    }
    
    /// Get chain height
    pub fn get_chain_height(&self) -> IntegrationResult<u64> {
        let cf = self.db.cf_handle(CF_METADATA)
            .ok_or_else(|| IntegrationError::StorageError("Metadata CF not found".to_string()))?;
        
        match self.db.get_cf(&cf, b"latest_height") {
            Ok(Some(data)) => {
                if data.len() == 8 {
                    Ok(u64::from_le_bytes(data.try_into().unwrap()))
                } else {
                    Ok(0)
                }
            }
            Ok(None) => Ok(0),
            Err(e) => Err(IntegrationError::StorageError(format!("Failed to get height: {}", e))),
        }
    }
    
    /// Get block hash by height
    pub fn get_block_hash(&self, height: u64) -> IntegrationResult<Option<String>> {
        let cf = self.db.cf_handle(CF_BLOCKS)
            .ok_or_else(|| IntegrationError::StorageError("Blocks CF not found".to_string()))?;
        
        let key = height_key(height);
        match self.db.get_cf(&cf, &key) {
            Ok(Some(data)) => {
                let block: qnet_state::Block = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                
                let hash = block.hash();
                Ok(Some(hex::encode(hash)))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(IntegrationError::StorageError(format!("Failed to get block: {}", e))),
        }
    }
    
    /// Check if block exists by hash
    pub async fn block_exists(&self, hash: &str) -> IntegrationResult<bool> {
        let cf = self.db.cf_handle(CF_BLOCKS)
            .ok_or_else(|| IntegrationError::StorageError("Blocks CF not found".to_string()))?;
        
        let key = hash_key(hash);
        match self.db.get_cf(&cf, &key) {
            Ok(Some(_)) => Ok(true),
            Ok(None) => Ok(false),
            Err(e) => Err(IntegrationError::StorageError(format!("Failed to check block: {}", e))),
        }
    }
    
    /// Load block by height
    pub async fn load_block_by_height(&self, height: u64) -> IntegrationResult<Option<qnet_state::Block>> {
        let cf = self.db.cf_handle(CF_BLOCKS)
            .ok_or_else(|| IntegrationError::StorageError("Blocks CF not found".to_string()))?;
        
        let key = height_key(height);
        match self.db.get_cf(&cf, &key) {
            Ok(Some(data)) => {
                let block = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(Some(block))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(IntegrationError::StorageError(format!("Failed to load block: {}", e))),
        }
    }
    
    /// Save account state
    pub async fn save_account(&self, account: &qnet_state::Account) -> IntegrationResult<()> {
        let cf = self.db.cf_handle(CF_ACCOUNTS)
            .ok_or_else(|| IntegrationError::StorageError("Accounts CF not found".to_string()))?;
        
        let account_data = bincode::serialize(account)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        self.db.put_cf(&cf, account.address.as_bytes(), &account_data)
            .map_err(|e| IntegrationError::StorageError(format!("Failed to save account: {}", e)))?;
        
        Ok(())
    }
    
    /// Get storage statistics
    pub fn get_stats(&self) -> IntegrationResult<StorageStats> {
        let mut stats = StorageStats::default();
        
        // Count blocks
        if let Some(cf) = self.db.cf_handle(CF_BLOCKS) {
            let iter = self.db.iterator_cf(&cf, IteratorMode::Start);
            stats.total_blocks = iter.filter(|r| r.is_ok()).count();
        }
        
        // Count accounts
        if let Some(cf) = self.db.cf_handle(CF_ACCOUNTS) {
            let iter = self.db.iterator_cf(&cf, IteratorMode::Start);
            stats.total_accounts = iter.filter(|r| r.is_ok()).count();
        }
        
        // Count transactions
        if let Some(cf) = self.db.cf_handle(CF_TRANSACTIONS) {
            let iter = self.db.iterator_cf(&cf, IteratorMode::Start);
            stats.total_transactions = iter.filter(|r| r.is_ok()).count();
        }
        
        // Get latest height
        stats.latest_height = self.get_chain_height().unwrap_or(0);
        
        Ok(stats)
    }
}

/// Storage statistics
#[derive(Debug, Default)]
pub struct StorageStats {
    pub total_blocks: usize,
    pub total_accounts: usize,
    pub total_transactions: usize,
    pub latest_height: u64,
}

// Helper functions for key generation
fn height_key(height: u64) -> Vec<u8> {
    let mut key = b"height:".to_vec();
    key.extend_from_slice(&height.to_be_bytes());
    key
}

fn hash_key(hash: &str) -> Vec<u8> {
    let mut key = b"hash:".to_vec();
    key.extend_from_slice(hash.as_bytes());
    key
}

/// Storage interface for blockchain data
pub struct Storage {
    db: DB,
}

impl Storage {
    /// Create new storage instance
    pub fn new(path: &str) -> Result<Self, QNetError> {
        let mut opts = Options::default();
        opts.create_if_missing(true);
        opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
        
        let db = DB::open(&opts, path)
            .map_err(|e| QNetError::StorageError(e.to_string()))?;
        
        Ok(Self { db })
    }
    
    /// Get current chain height
    pub fn get_chain_height(&self) -> Result<u64, QNetError> {
        match self.db.get(b"chain_height") {
            Ok(Some(data)) => {
                let height = u64::from_le_bytes(data.as_slice().try_into()
                    .map_err(|_| QNetError::StorageError("Invalid height data".into()))?);
                Ok(height)
            }
            Ok(None) => Ok(0),
            Err(e) => Err(QNetError::StorageError(e.to_string())),
        }
    }
    
    /// Save chain height
    pub fn save_chain_height(&self, height: u64) -> Result<(), QNetError> {
        self.db.put(b"chain_height", height.to_le_bytes())
            .map_err(|e| QNetError::StorageError(e.to_string()))
    }
    
    /// Get block by height
    pub fn get_block(&self, height: u64) -> Result<Option<Block>, QNetError> {
        let key = format!("block:{}", height);
        match self.db.get(key.as_bytes()) {
            Ok(Some(data)) => {
                let block: Block = serde_json::from_slice(&data)
                    .map_err(|e| QNetError::SerializationError(e.to_string()))?;
                Ok(Some(block))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(QNetError::StorageError(e.to_string())),
        }
    }
    
    /// Save block
    pub fn save_block(&self, block: &Block) -> Result<(), QNetError> {
        let key = format!("block:{}", block.height);
        let data = serde_json::to_vec(block)
            .map_err(|e| QNetError::SerializationError(e.to_string()))?;
        
        self.db.put(key.as_bytes(), data)
            .map_err(|e| QNetError::StorageError(e.to_string()))?;
        
        // Update height if this is a new block
        let current_height = self.get_chain_height()?;
        if block.height > current_height {
            self.save_chain_height(block.height)?;
        }
        
        Ok(())
    }
    
    /// Save microblock
    pub fn save_microblock(&self, height: u64, data: &[u8]) -> Result<(), QNetError> {
        let key = format!("microblock:{}", height);
        self.db.put(key.as_bytes(), data)
            .map_err(|e| QNetError::StorageError(e.to_string()))
    }
} 
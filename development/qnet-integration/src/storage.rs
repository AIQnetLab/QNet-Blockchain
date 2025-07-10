//! Persistent storage implementation for QNet blockchain

use rocksdb::{DB, Options, ColumnFamily, ColumnFamilyDescriptor, WriteBatch};
use qnet_state::{Block, Account};
use crate::errors::{IntegrationError, IntegrationResult};
use std::path::Path;
use std::collections::HashMap;
use hex;

pub struct PersistentStorage {
    db: DB,
}

#[derive(Debug, Clone, Default)]
pub struct StorageStats {
    pub total_blocks: u64,
    pub total_transactions: u64,
    pub total_accounts: u64,
    pub latest_height: u64,
}

impl PersistentStorage {
    pub fn new(data_dir: &str) -> IntegrationResult<Self> {
        let path = Path::new(data_dir);
        std::fs::create_dir_all(path)?;
        
        // Simple, reliable RocksDB configuration
        let mut opts = Options::default();
        opts.create_if_missing(true);
        opts.create_missing_column_families(true);
        
        // Basic settings that work reliably
        opts.set_max_open_files(1000);
        opts.set_use_fsync(false);
        opts.set_bytes_per_sync(1048576);
        opts.set_max_write_buffer_number(4);
        opts.set_write_buffer_size(67108864); // 64MB
        opts.set_target_file_size_base(67108864); // 64MB
        opts.set_min_write_buffer_number_to_merge(2);
        opts.set_level_zero_stop_writes_trigger(12);
        opts.set_level_zero_slowdown_writes_trigger(8);
        opts.set_compaction_style(rocksdb::DBCompactionStyle::Level);
        opts.set_max_background_jobs(4);
        opts.set_disable_auto_compactions(false);
        
        let cfs = vec![
            ColumnFamilyDescriptor::new("blocks", Options::default()),
            ColumnFamilyDescriptor::new("transactions", Options::default()),
            ColumnFamilyDescriptor::new("accounts", Options::default()),
            ColumnFamilyDescriptor::new("metadata", Options::default()),
            ColumnFamilyDescriptor::new("microblocks", Options::default()),
        ];
        
        let db = match DB::open_cf_descriptors(&opts, path, cfs) {
            Ok(db) => db,
            Err(e) => {
                eprintln!("❌ RocksDB Error: {}", e);
                return Err(IntegrationError::StorageError(format!("RocksDB initialization failed: {}", e)));
            }
        };
        
        Ok(Self { db })
    }
    
    pub async fn save_block(&self, block: &qnet_state::Block) -> IntegrationResult<()> {
        let block_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        let tx_cf = self.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        
        let block_key = format!("block_{}", block.height);
        let block_data = bincode::serialize(block)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        let mut batch = WriteBatch::default();
        batch.put_cf(&block_cf, block_key.as_bytes(), &block_data);
        
        // Store block hash mapping
        let hash_key = format!("hash_{}", block.height);
        let hash_data = bincode::serialize(&block.hash())
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        batch.put_cf(&block_cf, hash_key.as_bytes(), &hash_data);
        
        // Store transactions
        for tx in &block.transactions {
            let tx_key = format!("tx_{}", tx.hash);
            let tx_data = bincode::serialize(tx)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            
            batch.put_cf(&tx_cf, tx_key.as_bytes(), &tx_data);
        }
        
        // Update chain height
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        batch.put_cf(&metadata_cf, b"chain_height", &block.height.to_be_bytes());
        
        self.db.write(batch)?;
        Ok(())
    }
    
    pub fn get_chain_height(&self) -> IntegrationResult<u64> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        match self.db.get_cf(&metadata_cf, b"chain_height")? {
            Some(data) => {
                if data.len() >= 8 {
                    let height_bytes: [u8; 8] = data[0..8].try_into()
                        .map_err(|_| IntegrationError::StorageError("Invalid height data".to_string()))?;
                    Ok(u64::from_be_bytes(height_bytes))
                } else {
                    Ok(0)
                }
            }
            None => Ok(0),
        }
    }
    
    pub fn get_block_hash(&self, height: u64) -> IntegrationResult<Option<String>> {
        let block_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        
        let hash_key = format!("hash_{}", height);
        match self.db.get_cf(&block_cf, hash_key.as_bytes())? {
            Some(data) => {
                let hash: [u8; 32] = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                Ok(Some(hex::encode(hash)))
            }
            None => Ok(None),
        }
    }
    
    pub async fn load_block_by_height(&self, height: u64) -> IntegrationResult<Option<qnet_state::Block>> {
        let block_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        
        let block_key = format!("block_{}", height);
        match self.db.get_cf(&block_cf, block_key.as_bytes())? {
            Some(data) => {
                let block: qnet_state::Block = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                Ok(Some(block))
            }
            None => Ok(None),
        }
    }
    
    pub async fn save_account(&self, account: &qnet_state::Account) -> IntegrationResult<()> {
        let accounts_cf = self.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        
        let account_data = bincode::serialize(account)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        self.db.put_cf(&accounts_cf, account.address.as_bytes(), &account_data)?;
        Ok(())
    }
    
    pub fn save_microblock(&self, height: u64, data: &[u8]) -> IntegrationResult<()> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let key = format!("microblock_{}", height);
        self.db.put_cf(&microblocks_cf, key.as_bytes(), data)?;
        Ok(())
    }
    
    pub fn load_microblock(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let key = format!("microblock_{}", height);
        match self.db.get_cf(&microblocks_cf, key.as_bytes())? {
            Some(data) => Ok(Some(data)),
            None => Ok(None),
        }
    }
    
    pub fn get_latest_macroblock_hash(&self) -> Result<[u8; 32], IntegrationError> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        match self.db.get_cf(&metadata_cf, b"latest_macroblock_hash")? {
            Some(data) if data.len() >= 32 => {
                let mut hash = [0u8; 32];
                hash.copy_from_slice(&data[..32]);
                Ok(hash)
            },
            _ => Ok([0u8; 32]), // Default genesis hash
        }
    }
    
    pub async fn save_macroblock(&self, height: u64, macroblock: &qnet_state::MacroBlock) -> IntegrationResult<()> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        let key = format!("macroblock_{}", height);
        let data = bincode::serialize(macroblock)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        let mut batch = WriteBatch::default();
        batch.put_cf(&microblocks_cf, key.as_bytes(), &data);
        
        // Update latest macroblock hash
        let hash = macroblock.hash();
        batch.put_cf(&metadata_cf, b"latest_macroblock_hash", &hash);
        
        self.db.write(batch)?;
        Ok(())
    }
    
    pub fn get_stats(&self) -> IntegrationResult<StorageStats> {
        let mut stats = StorageStats::default();
        
        // Get chain height
        stats.latest_height = self.get_chain_height()?;
        
        // Count blocks
        let block_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        let mut block_count = 0u64;
        let iter = self.db.iterator_cf(&block_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, _) = item?;
            if std::str::from_utf8(&key).unwrap_or("").starts_with("block_") {
                block_count += 1;
            }
        }
        stats.total_blocks = block_count;
        
        // Count transactions  
        let tx_cf = self.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        let mut tx_count = 0u64;
        let iter = self.db.iterator_cf(&tx_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, _) = item?;
            if std::str::from_utf8(&key).unwrap_or("").starts_with("tx_") {
                tx_count += 1;
            }
        }
        stats.total_transactions = tx_count;
        
        // Count accounts
        let accounts_cf = self.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut account_count = 0u64;
        let iter = self.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start);
        for _item in iter {
            account_count += 1;
        }
        stats.total_accounts = account_count;
        
        Ok(stats)
    }
}

pub struct Storage {
    persistent: PersistentStorage,
}

impl Storage {
    pub fn new(data_dir: &str) -> IntegrationResult<Self> {
        let persistent = PersistentStorage::new(data_dir)?;
        Ok(Self { persistent })
    }
    
    pub fn get_chain_height(&self) -> IntegrationResult<u64> {
        self.persistent.get_chain_height()
    }
    
    pub fn get_block_hash(&self, height: u64) -> IntegrationResult<Option<String>> {
        self.persistent.get_block_hash(height)
    }
    
    pub async fn save_block(&self, block: &qnet_state::Block) -> IntegrationResult<()> {
        self.persistent.save_block(block).await
    }
    
    pub async fn load_block_by_height(&self, height: u64) -> IntegrationResult<Option<qnet_state::Block>> {
        self.persistent.load_block_by_height(height).await
    }
    
    pub fn save_microblock(&self, height: u64, data: &[u8]) -> IntegrationResult<()> {
        self.persistent.save_microblock(height, data)
    }
    
    pub fn load_microblock(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        self.persistent.load_microblock(height)
    }
    
    pub fn get_latest_macroblock_hash(&self) -> Result<[u8; 32], IntegrationError> {
        self.persistent.get_latest_macroblock_hash()
    }
    
    pub async fn save_macroblock(&self, height: u64, macroblock: &qnet_state::MacroBlock) -> IntegrationResult<()> {
        self.persistent.save_macroblock(height, macroblock).await
    }
    
    pub fn get_stats(&self) -> IntegrationResult<StorageStats> {
        self.persistent.get_stats()
    }
} 
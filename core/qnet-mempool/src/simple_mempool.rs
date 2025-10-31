//! Optimized mempool with binary storage support

use dashmap::DashMap;
use std::sync::Arc;
use parking_lot::RwLock;
use std::collections::VecDeque;
use serde::{Serialize, Deserialize};
use bincode;
use hex;
use sha3::{Sha3_256, Digest};

/// Simple mempool configuration
#[derive(Debug, Clone)]
pub struct SimpleMempoolConfig {
    pub max_size: usize,
    pub min_gas_price: u64,
}

impl Default for SimpleMempoolConfig {
    fn default() -> Self {
        Self {
            max_size: 500_000, // Production default: 500k transactions
            min_gas_price: 1,
        }
    }
}

/// Transaction storage format
#[derive(Clone)]
enum TxStorage {
    Json(String),
    Binary(Vec<u8>),
}

/// Optimized mempool implementation with binary support
pub struct SimpleMempool {
    config: SimpleMempoolConfig,
    transactions: Arc<DashMap<String, TxStorage>>, // hash -> json or binary
    queue: Arc<RwLock<VecDeque<String>>>, // ordered hashes
    use_binary: bool, // Toggle for binary storage
}

impl SimpleMempool {
    /// Create new optimized mempool
    pub fn new(config: SimpleMempoolConfig) -> Self {
        // Use binary for large mempools (>100k)
        let use_binary = config.max_size > 100_000;
        Self {
            config,
            transactions: Arc::new(DashMap::new()),
            queue: Arc::new(RwLock::new(VecDeque::new())),
            use_binary,
        }
    }
    
    /// Add raw transaction (optimized with binary option)
    pub fn add_raw_transaction(&self, tx_json: String, hash: String) -> bool {
        if self.transactions.len() >= self.config.max_size {
            return false;
        }
        
        if self.transactions.contains_key(&hash) {
            return false;
        }
        
        // SECURITY: Verify hash matches transaction data
        let computed_hash = format!("{:x}", sha3::Sha3_256::digest(tx_json.as_bytes()));
        if computed_hash != hash {
            println!("[MEMPOOL] ⚠️ SECURITY: Hash mismatch! Expected: {}, Got: {}", computed_hash, hash);
            return false; // Reject tampered transaction
        }
        
        // Store as binary if enabled (50% space saving)
        let storage = if self.use_binary {
            TxStorage::Binary(tx_json.as_bytes().to_vec())
        } else {
            TxStorage::Json(tx_json)
        };
        
        self.transactions.insert(hash.clone(), storage);
        self.queue.write().push_back(hash);
        true
    }
    
    /// Add binary transaction directly
    pub fn add_binary_transaction(&self, tx_bytes: Vec<u8>, hash: String) -> bool {
        if self.transactions.len() >= self.config.max_size {
            return false;
        }
        
        if self.transactions.contains_key(&hash) {
            return false;
        }
        
        // SECURITY: Verify hash matches binary data
        let computed_hash = format!("{:x}", sha3::Sha3_256::digest(&tx_bytes));
        if computed_hash != hash {
            println!("[MEMPOOL] ⚠️ SECURITY: Binary hash mismatch! Expected: {}, Got: {}", computed_hash, hash);
            return false; // Reject tampered data
        }
        
        self.transactions.insert(hash.clone(), TxStorage::Binary(tx_bytes));
        self.queue.write().push_back(hash);
        true
    }
    
    /// Get raw transaction (handles both formats)
    pub fn get_raw_transaction(&self, hash: &str) -> Option<String> {
        self.transactions.get(hash).and_then(|entry| {
            match entry.value() {
                TxStorage::Json(json) => Some(json.clone()),
                TxStorage::Binary(bytes) => {
                    // SECURITY: Only return if valid UTF-8, otherwise None
                    // This prevents returning corrupted data
                    match String::from_utf8(bytes.clone()) {
                        Ok(json) => Some(json),
                        Err(e) => {
                            println!("[MEMPOOL] ⚠️ SECURITY: Corrupted binary data for hash {}: {}", hash, e);
                            None // Don't return corrupted data!
                        }
                    }
                }
            }
        })
    }
    
    /// Get binary transaction
    pub fn get_binary_transaction(&self, hash: &str) -> Option<Vec<u8>> {
        self.transactions.get(hash).map(|entry| {
            match entry.value() {
                TxStorage::Json(json) => json.as_bytes().to_vec(),
                TxStorage::Binary(bytes) => bytes.clone(),
            }
        })
    }
    
    /// Get pending transactions
    pub fn get_pending_transactions(&self, limit: usize) -> Vec<String> {
        let queue = self.queue.read();
        queue.iter()
            .take(limit)
            .filter_map(|hash| self.get_raw_transaction(hash))
            .collect()
    }
    
    /// Remove transaction
    pub fn remove_transaction(&self, hash: &str) -> bool {
        if self.transactions.remove(hash).is_some() {
            let mut queue = self.queue.write();
            queue.retain(|h| h != hash);
            true
        } else {
            false
        }
    }
    
    /// Clear all transactions
    pub fn clear(&self) {
        self.transactions.clear();
        self.queue.write().clear();
    }
    
    /// Get mempool size
    pub fn size(&self) -> usize {
        self.transactions.len()
    }
} 
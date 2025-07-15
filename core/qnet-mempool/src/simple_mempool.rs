//! Simplified mempool for Python bindings

use dashmap::DashMap;
use std::sync::Arc;
use parking_lot::RwLock;
use std::collections::VecDeque;

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

/// Simple mempool implementation
pub struct SimpleMempool {
    config: SimpleMempoolConfig,
    transactions: Arc<DashMap<String, String>>, // hash -> json
    queue: Arc<RwLock<VecDeque<String>>>, // ordered hashes
}

impl SimpleMempool {
    /// Create new simple mempool
    pub fn new(config: SimpleMempoolConfig) -> Self {
        Self {
            config,
            transactions: Arc::new(DashMap::new()),
            queue: Arc::new(RwLock::new(VecDeque::new())),
        }
    }
    
    /// Add raw transaction
    pub fn add_raw_transaction(&self, tx_json: String, hash: String) -> bool {
        if self.transactions.len() >= self.config.max_size {
            return false;
        }
        
        if self.transactions.contains_key(&hash) {
            return false;
        }
        
        self.transactions.insert(hash.clone(), tx_json);
        self.queue.write().push_back(hash);
        true
    }
    
    /// Get raw transaction
    pub fn get_raw_transaction(&self, hash: &str) -> Option<String> {
        self.transactions.get(hash).map(|entry| entry.value().clone())
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
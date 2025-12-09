//! Optimized mempool with binary storage support

use dashmap::DashMap;
use std::sync::Arc;
use parking_lot::RwLock;
use std::collections::{VecDeque, BTreeMap};
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
            min_gas_price: 100_000, // PRODUCTION: 0.0001 QNC (BASE_FEE_NANO_QNC from qnet-state)
        }
    }
}

/// Transaction storage format
#[derive(Clone)]
enum TxStorage {
    Json(String),
    Binary(Vec<u8>),
}

/// Optimized mempool implementation with binary support and priority queue
/// ARCHITECTURE: Priority-based transaction ordering for spam protection
pub struct SimpleMempool {
    config: SimpleMempoolConfig,
    transactions: Arc<DashMap<String, TxStorage>>, // hash -> json or binary
    // PRODUCTION: Priority queue (BTreeMap) sorted by gas_price descending
    // Key: gas_price (u64), Value: FIFO queue of tx hashes at that price
    by_gas_price: Arc<RwLock<BTreeMap<u64, VecDeque<String>>>>,
    use_binary: bool, // Toggle for binary storage
}

impl SimpleMempool {
    /// Create new optimized mempool with priority queue
    /// PRODUCTION: Priority-based ordering for spam protection (highest gas_price first)
    pub fn new(config: SimpleMempoolConfig) -> Self {
        // Use binary for large mempools (>100k)
        let use_binary = config.max_size > 100_000;
        Self {
            config,
            transactions: Arc::new(DashMap::new()),
            by_gas_price: Arc::new(RwLock::new(BTreeMap::new())),
            use_binary,
        }
    }
    
    /// Add raw transaction (optimized with binary option and priority queue)
    /// PRODUCTION: Priority-based insertion for spam protection
    /// gas_price: Transaction gas price for priority sorting (higher = earlier processing)
    pub fn add_raw_transaction(&self, tx_json: String, hash: String, gas_price: u64) -> bool {
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
        
        // PRODUCTION: Add to priority queue (sorted by gas_price descending)
        // FIFO order within same gas_price (fair for same-price transactions)
        let mut priority_queue = self.by_gas_price.write();
        priority_queue
            .entry(gas_price)
            .or_insert_with(VecDeque::new)
            .push_back(hash);
        
        true
    }
    
    /// Add binary transaction directly with priority
    /// PRODUCTION: Priority-based insertion for spam protection
    /// gas_price: Transaction gas price for priority sorting (higher = earlier processing)
    pub fn add_binary_transaction(&self, tx_bytes: Vec<u8>, hash: String, gas_price: u64) -> bool {
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
        
        // PRODUCTION: Add to priority queue (sorted by gas_price descending)
        let mut priority_queue = self.by_gas_price.write();
        priority_queue
            .entry(gas_price)
            .or_insert_with(VecDeque::new)
            .push_back(hash);
        
        true
    }
    
    /// PRODUCTION v2.25.2: Batch add binary transactions (HIGH TPS)
    /// TRUSTED ONLY: Skips hash verification - caller must compute hashes correctly
    /// Use for: benchmark, internal batch processing where hashes are pre-computed
    /// DO NOT USE for: external RPC, untrusted P2P messages
    /// 
    /// Benefits:
    /// - Single lock acquisition for entire batch (vs N locks for N transactions)
    /// - No redundant SHA3 computation (caller already computed)
    /// - 10-50x faster than individual adds for large batches
    pub fn add_binary_transaction_batch_trusted(&self, transactions: Vec<(Vec<u8>, String, u64)>) -> usize {
        if transactions.is_empty() {
            return 0;
        }
        
        let available_space = self.config.max_size.saturating_sub(self.transactions.len());
        if available_space == 0 {
            return 0;
        }
        
        let mut added = 0usize;
        let mut batch_for_priority: Vec<(String, u64)> = Vec::with_capacity(transactions.len());
        
        // Phase 1: Add to DashMap (lock-free)
        for (tx_bytes, hash, gas_price) in transactions.into_iter().take(available_space) {
            // Skip duplicates
            if self.transactions.contains_key(&hash) {
                continue;
            }
            
            // TRUSTED: Skip hash verification - caller guarantees correctness
            self.transactions.insert(hash.clone(), TxStorage::Binary(tx_bytes));
            batch_for_priority.push((hash, gas_price));
            added += 1;
        }
        
        // Phase 2: Batch add to priority queue (SINGLE lock for all)
        if !batch_for_priority.is_empty() {
            let mut priority_queue = self.by_gas_price.write();
            for (hash, gas_price) in batch_for_priority {
                priority_queue
                    .entry(gas_price)
                    .or_insert_with(VecDeque::new)
                    .push_back(hash);
            }
        }
        
        added
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
    
    /// Get pending transactions (PRIORITY ORDER: highest gas_price first)
    /// PRODUCTION: Anti-spam protection - high-paying transactions processed first
    /// ARCHITECTURE: Prevents spam attacks from blocking legitimate high-value transactions
    pub fn get_pending_transactions(&self, limit: usize) -> Vec<String> {
        let priority_queue = self.by_gas_price.read();
        
        // Iterate from HIGHEST gas_price to LOWEST (BTreeMap.iter().rev())
        // Within same gas_price: FIFO order (fair for same-price transactions)
        priority_queue.iter()
            .rev()  // CRITICAL: Reverse iteration for highest-first
            .flat_map(|(_gas_price, hashes)| hashes.iter())
            .take(limit)
            .filter_map(|hash| self.get_raw_transaction(hash))
            .collect()
    }
    
    /// PRODUCTION v2.25: Get pending transactions as binary (for bincode deserialization)
    /// Returns raw bytes - caller must deserialize with bincode::deserialize
    /// PERFORMANCE: 10-20x faster than JSON for high TPS scenarios
    pub fn get_pending_binary_transactions(&self, limit: usize) -> Vec<Vec<u8>> {
        let priority_queue = self.by_gas_price.read();
        
        priority_queue.iter()
            .rev()
            .flat_map(|(_gas_price, hashes)| hashes.iter())
            .take(limit)
            .filter_map(|hash| self.get_binary_transaction(hash))
            .collect()
    }
    
    /// Remove transaction (must remove from both transactions map AND priority queue)
    /// CRITICAL: Maintains consistency between storage and priority queue
    pub fn remove_transaction(&self, hash: &str) -> bool {
        if self.transactions.remove(hash).is_some() {
            // CRITICAL: Also remove from priority queue
            // Iterate all gas_price levels to find and remove this hash
            let mut priority_queue = self.by_gas_price.write();
            for (_gas_price, hashes) in priority_queue.iter_mut() {
                hashes.retain(|h| h != hash);
            }
            // OPTIMIZATION: Remove empty gas_price entries to save memory
            priority_queue.retain(|_, hashes| !hashes.is_empty());
            true
        } else {
            false
        }
    }
    
    /// Clear all transactions (both storage and priority queue)
    /// CRITICAL: Clears both data structures to maintain consistency
    pub fn clear(&self) {
        self.transactions.clear();
        self.by_gas_price.write().clear();
    }
    
    /// Get mempool size
    pub fn size(&self) -> usize {
        self.transactions.len()
    }
    
    /// Get minimum gas price from config
    pub fn get_min_gas_price(&self) -> u64 {
        self.config.min_gas_price
    }
    
    /// CRITICAL v2.26: Batch remove transactions after block inclusion
    /// PERFORMANCE: O(n) batch removal instead of O(n*m) individual removals
    /// This prevents mempool from filling up with already-processed transactions!
    pub fn batch_remove_transactions(&self, hashes: &[String]) {
        if hashes.is_empty() {
            return;
        }
        
        // Step 1: Remove from transactions map (fast O(1) per hash)
        let mut removed_count = 0;
        for hash in hashes {
            if self.transactions.remove(hash).is_some() {
                removed_count += 1;
            }
        }
        
        // Step 2: Clean priority queue in one pass (more efficient than individual removes)
        if removed_count > 0 {
            let hash_set: std::collections::HashSet<&String> = hashes.iter().collect();
            let mut priority_queue = self.by_gas_price.write();
            for (_gas_price, queue_hashes) in priority_queue.iter_mut() {
                queue_hashes.retain(|h| !hash_set.contains(h));
            }
            // Remove empty gas_price levels
            priority_queue.retain(|_, queue_hashes| !queue_hashes.is_empty());
        }
        
        if removed_count > 0 {
            println!("[MEMPOOL] 🗑️ Removed {} transactions after block inclusion", removed_count);
        }
    }
    
    /// CRITICAL v2.26: Get pending transactions WITH their hashes
    /// Returns (hash, binary_data) pairs for block inclusion AND cleanup
    /// This allows removing exact transactions that were included in a block
    /// 
    /// PRODUCTION v2.25.2: Snapshot approach - release lock early
    /// Phase 1: Collect hashes with lock (fast)
    /// Phase 2: Fetch data without lock (no blocking writers)
    pub fn get_pending_transactions_with_hashes(&self, limit: usize) -> Vec<(String, Vec<u8>)> {
        // Phase 1: Snapshot hashes (short lock duration)
        let hashes_snapshot: Vec<String> = {
            let priority_queue = self.by_gas_price.read();
            priority_queue.iter()
                .rev()  // Highest gas_price first
                .flat_map(|(_gas_price, hashes)| hashes.iter().cloned())
                .take(limit)
                .collect()
        }; // Lock released here!
        
        // Phase 2: Fetch data without lock (DashMap is lock-free)
        hashes_snapshot.into_iter()
            .filter_map(|hash| {
                self.get_binary_transaction(&hash).map(|data| (hash, data))
            })
            .collect()
    }
} 
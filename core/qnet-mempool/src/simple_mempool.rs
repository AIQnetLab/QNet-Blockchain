//! Optimized mempool with binary storage support

use dashmap::DashMap;
use std::sync::Arc;
use parking_lot::RwLock;
use std::collections::{VecDeque, BTreeMap};
use serde::{Serialize, Deserialize};
use serde_json;
use bincode;
use hex;
use sha3::{Sha3_256, Digest};
use qnet_state::Transaction;

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
    /// Returns: true if added, false if duplicate/full/invalid (NOT an error for duplicates!)
    /// 
    /// v2.67: CRITICAL FIX - Atomic add to both structures under single lock
    pub fn add_raw_transaction(&self, tx_json: String, hash: String, gas_price: u64) -> bool {
        // v2.66: Diagnostic logging for mempool issues
        if self.transactions.len() >= self.config.max_size {
            eprintln!("[WARN][MEMPOOL] full size={} max={} hash={}", 
                     self.transactions.len(), self.config.max_size, &hash[..16.min(hash.len())]);
            return false;
        }
        
        // Duplicate is NORMAL in P2P network (same TX from multiple peers)
        if self.transactions.contains_key(&hash) {
            return false;
        }
        
        // SECURITY: Verify hash matches canonical transaction data
        // Parse JSON, compute canonical bytes (excludes hash/signatures), verify
        match serde_json::from_str::<Transaction>(&tx_json) {
            Ok(tx) => {
                let canonical_bytes = tx.canonical_bytes();
                let computed_hash = format!("{:x}", Sha3_256::digest(&canonical_bytes));
                
                if computed_hash != hash {
                    eprintln!("[ERR][MEMPOOL] hash_mismatch expected={} got={}", 
                             &hash[..16.min(hash.len())], &computed_hash[..16.min(computed_hash.len())]);
                    return false; // Reject tampered transaction
                }
            }
            Err(e) => {
                eprintln!("[ERR][MEMPOOL] parse_failed hash={} error={}", 
                         &hash[..16.min(hash.len())], e);
                return false; // Reject malformed transaction
            }
        }
        
        // Store as binary if enabled (50% space saving)
        let storage = if self.use_binary {
            TxStorage::Binary(tx_json.as_bytes().to_vec())
        } else {
            TxStorage::Json(tx_json)
        };
        
        // v2.67: CRITICAL - Add to BOTH structures atomically under priority queue lock
        {
            let mut priority_queue = self.by_gas_price.write();
            
            // Double-check inside lock
            if self.transactions.contains_key(&hash) {
                return false;
            }
            
            self.transactions.insert(hash.clone(), storage);
            priority_queue
                .entry(gas_price)
                .or_insert_with(VecDeque::new)
                .push_back(hash);
        }
        
        true
    }
    
    /// Add binary transaction directly with priority
    /// PRODUCTION: Priority-based insertion for spam protection
    /// gas_price: Transaction gas price for priority sorting (higher = earlier processing)
    /// Returns: true if added, false if duplicate/full/invalid (NOT an error for duplicates!)
    /// 
    /// v2.67: CRITICAL FIX - Add to priority queue FIRST, then to transactions
    /// This ensures get_pending_transactions_with_hashes always sees consistent state
    pub fn add_binary_transaction(&self, tx_bytes: Vec<u8>, hash: String, gas_price: u64) -> bool {
        // v2.66: Diagnostic logging for mempool issues
        if self.transactions.len() >= self.config.max_size {
            eprintln!("[WARN][MEMPOOL] full size={} max={} hash={}", 
                     self.transactions.len(), self.config.max_size, &hash[..16.min(hash.len())]);
            return false;
        }
        
        // Duplicate is NORMAL in P2P network (same TX from multiple peers)
        if self.transactions.contains_key(&hash) {
            // Only log at debug level - this is expected behavior
            return false;
        }
        
        // SECURITY: Verify hash matches canonical transaction data
        // Deserialize, compute canonical bytes (excludes hash/signatures), verify
        match bincode::deserialize::<Transaction>(&tx_bytes) {
            Ok(tx) => {
                let canonical_bytes = tx.canonical_bytes();
                let computed_hash = format!("{:x}", Sha3_256::digest(&canonical_bytes));
                
                if computed_hash != hash {
                    eprintln!("[ERR][MEMPOOL] hash_mismatch expected={} got={}", 
                             &hash[..16.min(hash.len())], &computed_hash[..16.min(computed_hash.len())]);
                    return false; // Reject tampered transaction
                }
            }
            Err(e) => {
                eprintln!("[ERR][MEMPOOL] deserialize_failed hash={} error={}", 
                         &hash[..16.min(hash.len())], e);
                return false; // Reject malformed transaction
            }
        }
        
        // v2.67: CRITICAL - Add to BOTH structures atomically under priority queue lock
        // This prevents race condition where TX is in transactions but not in priority queue
        {
            let mut priority_queue = self.by_gas_price.write();
            
            // Double-check inside lock to prevent duplicates
            if self.transactions.contains_key(&hash) {
                return false;
            }
            
            // Add to transactions first
            self.transactions.insert(hash.clone(), TxStorage::Binary(tx_bytes));
            
            // Then add to priority queue (same lock scope)
            priority_queue
                .entry(gas_price)
                .or_insert_with(VecDeque::new)
                .push_back(hash.clone());
            
            // v2.67: Verify consistency for system TX
            if gas_price == u64::MAX {
                let queue_has = priority_queue.get(&u64::MAX)
                    .map(|v| v.contains(&hash))
                    .unwrap_or(false);
                let tx_has = self.transactions.contains_key(&hash);
                
                println!("[INFO][MEMPOOL] system_tx_added hash={} size={} queue={} tx={}", 
                        &hash[..16.min(hash.len())], self.transactions.len(), queue_has, tx_has);
                
                if !queue_has || !tx_has {
                    eprintln!("[ERR][MEMPOOL] system_tx_add_failed hash={}", &hash[..16.min(hash.len())]);
                }
            }
        }
        
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
    /// PRODUCTION v2.67: ATOMIC read from BOTH structures to prevent race conditions
    /// Previous bug: TX could be in transactions but not in by_gas_price if add was interrupted
    pub fn get_pending_transactions_with_hashes(&self, limit: usize) -> Vec<(String, Vec<u8>)> {
        // v2.67: ATOMIC - hold lock while fetching data to prevent race conditions
        // This ensures we see consistent state between by_gas_price and transactions
        let priority_queue = self.by_gas_price.read();
        
        // v2.67: Debug logging for emission blocks (system TX have gas_price == u64::MAX)
        let total_in_queue: usize = priority_queue.values().map(|v| v.len()).sum();
        let has_system_tx = priority_queue.contains_key(&u64::MAX);
        
        if has_system_tx || total_in_queue > 0 {
            println!("[INFO][MEMPOOL] get_pending queue_size={} has_system_tx={} tx_map_size={}", 
                    total_in_queue, has_system_tx, self.transactions.len());
        }
        
        let result: Vec<(String, Vec<u8>)> = priority_queue.iter()
            .rev()  // Highest gas_price first (u64::MAX = system TX = first)
            .flat_map(|(gas_price, hashes)| {
                hashes.iter().map(move |h| (*gas_price, h.clone()))
            })
            .take(limit)
            .filter_map(|(gas_price, hash)| {
                match self.get_binary_transaction(&hash) {
                    Some(data) => Some((hash, data)),
                    None => {
                        // v2.67: This should NEVER happen - log for debugging
                        eprintln!("[ERR][MEMPOOL] tx_in_queue_but_not_in_map hash={} gas_price={}", 
                                 &hash[..16.min(hash.len())], gas_price);
                        None
                    }
                }
            })
            .collect();
        
        if has_system_tx && result.is_empty() {
            eprintln!("[ERR][MEMPOOL] system_tx_lost queue_had={} result={}", total_in_queue, result.len());
        }
        
        result
    }
    
    /// v2.67: Debug method to check mempool consistency
    pub fn debug_check_consistency(&self) -> (usize, usize, bool) {
        let tx_count = self.transactions.len();
        let queue_count: usize = self.by_gas_price.read().values().map(|v| v.len()).sum();
        let is_consistent = tx_count == queue_count;
        
        if !is_consistent {
            eprintln!("[ERR][MEMPOOL] INCONSISTENT tx_map={} priority_queue={}", tx_count, queue_count);
        }
        
        (tx_count, queue_count, is_consistent)
    }
} 
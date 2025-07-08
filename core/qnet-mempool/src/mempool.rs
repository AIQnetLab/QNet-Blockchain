//! High-performance concurrent mempool implementation

use crate::{
    errors::{MempoolError, MempoolResult},
    priority::{TxPriority, PriorityCalculator, DefaultPriorityCalculator},
    validation::{TxValidator, DefaultValidator, SimpleValidator},
    eviction::EvictionPolicy,
};
use qnet_state::{StateDB, transaction::{Transaction, TxHash}};
use dashmap::DashMap;
use parking_lot::RwLock;
use priority_queue::PriorityQueue;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::env;
use tracing::{debug, info, warn};
use rayon::prelude::*;

/// Format hash for logging safely
fn format_hash_for_log(hash: &str) -> String {
    if hash.is_empty() {
        "empty_hash".to_string()
    } else if hash.len() >= 8 {
        format!("{}", &hash[..8])
    } else {
        hash.to_string()
    }
}

/// Mempool configuration
#[derive(Debug, Clone)]
pub struct MempoolConfig {
    /// Maximum number of transactions
    pub max_size: usize,
    
    /// Maximum transactions per account
    pub max_per_account: usize,
    
    /// Minimum gas price
    pub min_gas_price: u64,
    
    /// Transaction expiry time
    pub tx_expiry: Duration,
    
    /// How often to run eviction
    pub eviction_interval: Duration,
    
    /// Enable priority senders
    pub enable_priority_senders: bool,
}

impl Default for MempoolConfig {
    fn default() -> Self {
        // Production-ready configuration for 100k+ TPS
        let max_size = std::env::var("QNET_MEMPOOL_SIZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(500_000); // 500k for high throughput
            
        let max_per_account = std::env::var("QNET_MAX_PER_ACCOUNT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(10_000); // Allow burst sending
            
        Self {
            max_size,
            max_per_account,
            min_gas_price: 1,
            tx_expiry: Duration::from_secs(1800), // 30 minutes for faster turnover
            eviction_interval: Duration::from_secs(30), // More frequent cleanup
            enable_priority_senders: true,
        }
    }
}

/// Transaction entry in mempool
#[derive(Clone)]
struct TxEntry {
    /// Transaction
    tx: Transaction,
    
    /// Priority info
    priority: TxPriority,
    
    /// Time added
    added_at: Instant,
}

/// High-performance mempool
pub struct Mempool {
    /// Configuration
    config: MempoolConfig,
    
    /// All transactions by hash
    transactions: Arc<DashMap<TxHash, TxEntry>>,
    
    /// Transactions by sender
    by_sender: Arc<DashMap<String, BTreeMap<u64, TxHash>>>,
    
    /// Priority queue (hash -> priority)
    priority_queue: Arc<RwLock<PriorityQueue<TxHash, TxPriority>>>,
    
    /// Transaction validator
    validator: Arc<dyn TxValidator>,
    
    /// Priority calculator
    priority_calc: Arc<dyn PriorityCalculator>,
    
    /// Last eviction time
    last_eviction: Arc<RwLock<Instant>>,
}

impl Mempool {
    /// Create new mempool
    pub fn new(
        config: MempoolConfig,
        state_db: Arc<StateDB>,
    ) -> Self {
        let validator = Arc::new(DefaultValidator::new(
            Arc::clone(&state_db),
            config.min_gas_price,
        ));
        
        let priority_calc = Arc::new(DefaultPriorityCalculator::new(
            config.min_gas_price,
        ));
        
        Self {
            config,
            transactions: Arc::new(DashMap::new()),
            by_sender: Arc::new(DashMap::new()),
            priority_queue: Arc::new(RwLock::new(PriorityQueue::new())),
            validator,
            priority_calc,
            last_eviction: Arc::new(RwLock::new(Instant::now())),
        }
    }
    
    /// Create simple mempool without StateDB (for Python bindings)
    pub fn new_simple(config: MempoolConfig) -> Self {
        let validator = Arc::new(SimpleValidator::new(config.min_gas_price));
        let priority_calc = Arc::new(DefaultPriorityCalculator::new(config.min_gas_price));
        
        Self {
            config,
            transactions: Arc::new(DashMap::new()),
            by_sender: Arc::new(DashMap::new()),
            priority_queue: Arc::new(RwLock::new(PriorityQueue::new())),
            validator,
            priority_calc,
            last_eviction: Arc::new(RwLock::new(Instant::now())),
        }
    }
    
    /// Add transaction to mempool
    pub async fn add_transaction(&self, tx: Transaction) -> MempoolResult<()> {
        // Check if already exists
        if self.transactions.contains_key(&tx.hash) {
            return Err(MempoolError::DuplicateTransaction(tx.hash.clone()));
        }
        
        // Fast path for testing
        if std::env::var("QNET_SKIP_VALIDATION").is_ok() {
            return self.add_transaction_fast_path(tx).await;
        }
        
        // Validate transaction
        let validation = self.validator.validate(&tx).await?;
        if !validation.is_valid {
            return Err(MempoolError::ValidationFailed(
                validation.errors.join("; ")
            ));
        }
        
        // Check mempool capacity
        if self.transactions.len() >= self.config.max_size {
            // Try eviction
            self.evict_transactions(1);
            
            // Still full?
            if self.transactions.len() >= self.config.max_size {
                return Err(MempoolError::MempoolFull {
                    capacity: self.config.max_size,
                });
            }
        }
        
        // Check per-account limit
        let sender_txs = self.by_sender.get(&tx.from);
        if let Some(sender_txs) = sender_txs {
            if sender_txs.len() >= self.config.max_per_account {
                return Err(MempoolError::AccountLimitExceeded {
                    limit: self.config.max_per_account,
                });
            }
            
            // Check for nonce gaps
            if let Some(expected_nonce) = validation.expected_nonce {
                if tx.nonce > expected_nonce && !sender_txs.contains_key(&expected_nonce) {
                    return Err(MempoolError::NonceGap {
                        expected: expected_nonce,
                        got: tx.nonce,
                    });
                }
            }
        }
        
        // Calculate priority
        let priority = self.priority_calc.calculate_priority(&tx);
        
        // Create entry
        let entry = TxEntry {
            tx: tx.clone(),
            priority: priority.clone(),
            added_at: Instant::now(),
        };
        
        // Add to collections
        self.transactions.insert(tx.hash.clone(), entry);
        
        self.by_sender
            .entry(tx.from.clone())
            .or_insert_with(BTreeMap::new)
            .insert(tx.nonce, tx.hash.clone());
        
        self.priority_queue.write().push(tx.hash.clone(), priority);
        
        // Safe logging with empty hash check
        let hash_str = if tx.hash.is_empty() {
            "empty_hash".to_string()
        } else if tx.hash.len() >= 8 {
            format!("{}", &tx.hash[..8])
        } else {
            tx.hash.clone()
        };
        info!("Added transaction {} to mempool", hash_str);
        
        // Check if eviction needed
        if self.last_eviction.read().elapsed() > self.config.eviction_interval {
            self.run_eviction();
        }
        
        Ok(())
    }
    
    /// Fast path for adding transactions without validation
    async fn add_transaction_fast_path(&self, tx: Transaction) -> MempoolResult<()> {
        // Check mempool capacity
        if self.transactions.len() >= self.config.max_size {
            self.evict_transactions(1);
        }
        
        // Calculate priority
        let priority = self.priority_calc.calculate_priority(&tx);
        
        // Create entry
        let entry = TxEntry {
            tx: tx.clone(),
            priority: priority.clone(),
            added_at: Instant::now(),
        };
        
        // Add to collections
        self.transactions.insert(tx.hash.clone(), entry);
        
        self.by_sender
            .entry(tx.from.clone())
            .or_insert_with(BTreeMap::new)
            .insert(tx.nonce, tx.hash.clone());
        
        self.priority_queue.write().push(tx.hash.clone(), priority);
        
        Ok(())
    }
    
    /// Add batch of transactions for high performance
    pub async fn add_transaction_batch(&self, txs: Vec<Transaction>) -> MempoolResult<Vec<String>> {
        let parallel_validation = env::var("QNET_PARALLEL_VALIDATION").unwrap_or_default() == "1";
        let fast_path = env::var("QNET_SKIP_VALIDATION").is_ok();
        
        if parallel_validation && txs.len() > 10 {
            self.add_transaction_batch_parallel(txs).await
        } else {
            // Sequential processing
            let mut successful_hashes = Vec::with_capacity(txs.len());
            
            if fast_path {
                // Fast batch processing without validation
                for tx in txs {
                    if self.transactions.len() < self.config.max_size {
                        if let Ok(()) = self.add_transaction_fast_path(tx.clone()).await {
                            successful_hashes.push(tx.hash);
                        }
                    }
                }
            } else {
                // Normal batch processing with validation
                for tx in txs {
                    if let Ok(()) = self.add_transaction(tx.clone()).await {
                        successful_hashes.push(tx.hash);
                    }
                }
            }
            
            info!("Added batch of {} transactions to mempool", successful_hashes.len());
            Ok(successful_hashes)
        }
    }
    
    /// Add batch of transactions using parallel validation
    pub async fn add_transaction_batch_parallel(&self, txs: Vec<Transaction>) -> MempoolResult<Vec<String>> {
        let start_time = Instant::now();
        let tx_count = txs.len();
        
        info!("Starting parallel batch processing for {} transactions", tx_count);
        
        // Phase 1: Parallel validation and priority calculation
        let validation_results: Vec<_> = txs.into_par_iter()
            .map(|tx| {
                let is_valid = if env::var("QNET_SKIP_VALIDATION").is_ok() {
                    true
                } else {
                    // Basic validation that can be done in parallel
                    !tx.hash.is_empty() && !tx.from.is_empty() && 
                    tx.to.as_ref().map_or(false, |to| !to.is_empty()) && tx.amount > 0
                };
                
                let priority = self.priority_calc.calculate_priority(&tx);
                
                (tx, is_valid, priority)
            })
            .collect();
            
        // Phase 2: Sequential addition to avoid race conditions
        let mut successful_hashes = Vec::with_capacity(validation_results.len());
        let mut added_count = 0;
        
        for (tx, is_valid, priority) in validation_results {
            if !is_valid {
                continue;
            }
            
            // Check if already exists
            if self.transactions.contains_key(&tx.hash) {
                continue;
            }
            
            // Check capacity
            if self.transactions.len() >= self.config.max_size {
                self.evict_transactions(1);
                if self.transactions.len() >= self.config.max_size {
                    continue;
                }
            }
            
            // Add transaction
            let entry = TxEntry {
                tx: tx.clone(),
                priority: priority.clone(),
                added_at: Instant::now(),
            };
            
            // Update data structures
            self.transactions.insert(tx.hash.clone(), entry);
            
            // Update by_sender index
            self.by_sender
                .entry(tx.from.clone())
                .or_insert_with(BTreeMap::new)
                .insert(tx.nonce, tx.hash.clone());
                
            // Update priority queue
            self.priority_queue.write().push(tx.hash.clone(), priority);
            
            successful_hashes.push(tx.hash);
            added_count += 1;
        }
        
        let duration = start_time.elapsed();
        info!("Parallel batch processed: {}/{} transactions in {:?} ({:.2} tx/ms)", 
              added_count, tx_count, duration, 
              if duration.as_millis() > 0 { tx_count as f64 / duration.as_millis() as f64 } else { 0.0 });
              
        Ok(successful_hashes)
    }
    
    /// Get transaction by hash
    pub fn get_transaction(&self, hash: &TxHash) -> Option<Transaction> {
        self.transactions.get(hash).map(|entry| entry.tx.clone())
    }
    
    /// Get all transactions for a sender
    pub fn get_sender_transactions(&self, sender: &str) -> Vec<Transaction> {
        if let Some(sender_txs) = self.by_sender.get(sender) {
            sender_txs
                .values()
                .filter_map(|hash| self.get_transaction(hash))
                .collect()
        } else {
            vec![]
        }
    }
    
    /// Get next nonce for sender
    pub fn get_next_nonce(&self, sender: &str) -> u64 {
        if let Some(sender_txs) = self.by_sender.get(sender) {
            sender_txs.keys().max().map(|n| n + 1).unwrap_or(0)
        } else {
            0
        }
    }
    
    /// Get top transactions by priority
    pub fn get_top_transactions(&self, limit: usize) -> Vec<Transaction> {
        let queue = self.priority_queue.read();
        let mut txs = Vec::with_capacity(limit.min(queue.len()));
        
        for (hash, _priority) in queue.iter().take(limit) {
            if let Some(tx) = self.get_transaction(hash) {
                txs.push(tx);
            }
        }
        
        txs
    }
    
    /// Remove transaction
    pub fn remove_transaction(&self, hash: &TxHash) -> Option<Transaction> {
        if let Some((_, entry)) = self.transactions.remove(hash) {
            // Remove from sender map
            if let Some(mut sender_txs) = self.by_sender.get_mut(&entry.tx.from) {
                sender_txs.remove(&entry.tx.nonce);
                if sender_txs.is_empty() {
                    drop(sender_txs);
                    self.by_sender.remove(&entry.tx.from);
                }
            }
            
            // Remove from priority queue
            self.priority_queue.write().remove(hash);
            
            debug!("Removed transaction {} from mempool", if hash.len() >= 8 { &hash[..8] } else { hash });
            
            Some(entry.tx)
        } else {
            None
        }
    }
    
    /// Remove transactions by sender
    pub fn remove_sender_transactions(&self, sender: &str, up_to_nonce: Option<u64>) -> Vec<Transaction> {
        let mut removed = Vec::new();
        
        if let Some((_, sender_txs)) = self.by_sender.remove(sender) {
            for (nonce, hash) in sender_txs {
                if let Some(max_nonce) = up_to_nonce {
                    if nonce > max_nonce {
                        // Re-add this transaction
                        self.by_sender
                            .entry(sender.to_string())
                            .or_insert_with(BTreeMap::new)
                            .insert(nonce, hash);
                        continue;
                    }
                }
                
                if let Some(tx) = self.remove_transaction(&hash) {
                    removed.push(tx);
                }
            }
        }
        
        removed
    }
    
    /// Evict transactions
    fn evict_transactions(&self, count: usize) {
        let now = Instant::now();
        let mut to_remove = Vec::new();
        
        // First, remove expired transactions
        for entry in self.transactions.iter() {
            if now.duration_since(entry.added_at) > self.config.tx_expiry {
                to_remove.push(entry.key().clone());
                if to_remove.len() >= count {
                    break;
                }
            }
        }
        
        // If not enough, remove lowest priority
        if to_remove.len() < count {
            let queue = self.priority_queue.read();
            let mut priorities: Vec<_> = queue.iter()
                .map(|(hash, priority)| (hash.clone(), priority.score))
                .collect();
            priorities.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
            
            for (hash, _) in priorities.into_iter().take(count - to_remove.len()) {
                to_remove.push(hash);
            }
        }
        
        // Remove transactions
        for hash in to_remove {
            self.remove_transaction(&hash);
        }
    }
    
    /// Run periodic eviction
    fn run_eviction(&self) {
        let now = Instant::now();
        *self.last_eviction.write() = now;
        
        // Remove expired transactions
        let mut expired = Vec::new();
        for entry in self.transactions.iter() {
            if now.duration_since(entry.added_at) > self.config.tx_expiry {
                expired.push(entry.key().clone());
            }
        }
        
        for hash in expired {
            self.remove_transaction(&hash);
        }
        
        // Update priorities for aging
        let mut queue = self.priority_queue.write();
        let mut updated = Vec::new();
        
        // Collect all items
        while let Some((hash, mut priority)) = queue.pop() {
            priority.update_score();
            updated.push((hash, priority));
        }
        
        // Re-insert with updated priorities
        for (hash, priority) in updated {
            queue.push(hash, priority);
        }
    }
    
    /// Get mempool statistics
    pub fn get_stats(&self) -> MempoolStats {
        let queue = self.priority_queue.read();
        let avg_gas_price = if queue.is_empty() {
            0
        } else {
            queue.iter()
                .map(|(_, p)| p.gas_price)
                .sum::<u64>() / queue.len() as u64
        };
        
        MempoolStats {
            total_transactions: self.transactions.len(),
            unique_senders: self.by_sender.len(),
            avg_gas_price,
            oldest_tx_age: self.transactions.iter()
                .map(|e| e.added_at.elapsed())
                .max()
                .unwrap_or_default(),
        }
    }
    
    /// Add raw transaction (for Python bindings)
    pub fn add_raw_transaction(&self, tx_json: String, hash: String) {
        
        // Create a simple transaction entry
        let tx = Transaction {
            hash: hash.clone(),
            from: "unknown".to_string(),
            to: Some("unknown".to_string()),
            amount: 0,
            nonce: 0,
            gas_price: self.config.min_gas_price,
            gas_limit: 21000,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            signature: None,
            tx_type: qnet_state::transaction::TransactionType::Transfer {
                from: "unknown".to_string(),
                to: "unknown".to_string(),
                amount: 0,
            },
            data: None,
        };
        
        let priority = self.priority_calc.calculate_priority(&tx);
        let entry = TxEntry {
            tx,
            priority: priority.clone(),
            added_at: Instant::now(),
        };
        
        self.transactions.insert(hash.clone(), entry);
        self.priority_queue.write().push(hash, priority);
    }
    
    /// Get raw transaction (for Python bindings)
    pub fn get_raw_transaction(&self, hash: &str) -> Option<String> {
        // For now, just return the hash as we don't store the original JSON
        self.transactions.get(hash).map(|_| format!("{{\"hash\": \"{}\"}}", hash))
    }
    
    /// Get pending transactions (for Python bindings)
    pub fn get_pending_transactions(&self, limit: usize) -> Vec<String> {
        let queue = self.priority_queue.read();
        queue.iter()
            .take(limit)
            .map(|(hash, _)| hash.clone())
            .collect()
    }
    
    /// Clear all transactions
    pub fn clear(&self) {
        self.transactions.clear();
        self.by_sender.clear();
        self.priority_queue.write().clear();
    }
    
    /// Get mempool size
    pub fn size(&self) -> usize {
        self.transactions.len()
    }
    
    /// High-performance batch processing for 100k+ TPS mode
    pub async fn get_high_performance_batch(&self, max_count: usize) -> Vec<Transaction> {
        let start_time = std::time::Instant::now();
        
        // Use parallel processing for large batches
        let queue = self.priority_queue.read();
        let tx_hashes: Vec<_> = queue.iter()
            .take(max_count)
            .map(|(hash, _)| hash.clone())
            .collect();
        drop(queue);
        
        // Parallel transaction retrieval
        let transactions: Vec<Transaction> = tx_hashes
            .par_iter()
            .filter_map(|hash| {
                self.transactions.get(hash).map(|entry| entry.tx.clone())
            })
            .collect();
        
        let duration = start_time.elapsed();
        if duration.as_millis() > 10 {
            warn!("Slow batch processing: {} tx in {:?}", transactions.len(), duration);
        }
        
        transactions
    }
    
    /// Ultra-fast transaction selection for microblocks
    pub fn get_microblock_transactions(&self, target_size: usize) -> Vec<Transaction> {
        // Fast path: get highest priority transactions without heavy validation
        let queue = self.priority_queue.read();
        
        queue.iter()
            .take(target_size)
            .filter_map(|(hash, _)| {
                self.transactions.get(hash).map(|entry| entry.tx.clone())
            })
            .collect()
    }
    
    /// Batch remove transactions after microblock creation
    pub fn batch_remove_transactions(&self, tx_hashes: &[TxHash]) {
        let start_time = std::time::Instant::now();
        
        // Parallel removal for performance
        tx_hashes.par_iter().for_each(|hash| {
            if let Some((_, entry)) = self.transactions.remove(hash) {
                // Remove from sender index
                if let Some(mut sender_txs) = self.by_sender.get_mut(&entry.tx.from) {
                    sender_txs.remove(&entry.tx.nonce);
                    if sender_txs.is_empty() {
                        drop(sender_txs);
                        self.by_sender.remove(&entry.tx.from);
                    }
                }
            }
        });
        
        // Batch remove from priority queue
        {
            let mut queue = self.priority_queue.write();
            for hash in tx_hashes {
                queue.remove(hash);
            }
        }
        
        let duration = start_time.elapsed();
        info!("Batch removed {} transactions in {:?}", tx_hashes.len(), duration);
    }
    
    /// Pre-validate transactions for high-frequency submission
    pub async fn pre_validate_batch(&self, transactions: &[Transaction]) -> Vec<bool> {
        // Use parallel validation for better performance
        transactions
            .par_iter()
            .map(|tx| {
                // Fast validation without state checks
                tx.validate().is_ok() &&
                tx.gas_price >= self.config.min_gas_price &&
                !self.transactions.contains_key(&tx.hash)
            })
            .collect()
    }
    
    /// Get mempool statistics for performance monitoring
    pub fn get_performance_stats(&self) -> MempoolPerformanceStats {
        let total_txs = self.transactions.len();
        let unique_senders = self.by_sender.len();
        let queue_size = self.priority_queue.read().len();
        
        // Calculate average gas price
        let total_gas_price: u64 = self.transactions
            .iter()
            .map(|entry| entry.tx.gas_price)
            .sum();
        let avg_gas_price = if total_txs > 0 {
            total_gas_price / total_txs as u64
        } else {
            0
        };
        
        MempoolPerformanceStats {
            total_transactions: total_txs,
            unique_senders,
            queue_size,
            avg_gas_price,
            capacity_utilization: (total_txs as f64 / self.config.max_size as f64) * 100.0,
            last_updated: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        }
    }
    
    /// Optimize mempool for high-frequency operations
    pub fn optimize_for_high_frequency(&self) {
        // Run background optimization
        tokio::spawn({
            let transactions = self.transactions.clone();
            let priority_queue = self.priority_queue.clone();
            let by_sender = self.by_sender.clone();
            
            async move {
                // Cleanup expired transactions
                let now = std::time::Instant::now();
                let mut to_remove = Vec::new();
                
                for entry in transactions.iter() {
                    if now.duration_since(entry.added_at) > Duration::from_secs(3600) {
                        to_remove.push(entry.key().clone());
                    }
                }
                
                // Batch remove expired
                for hash in to_remove {
                    transactions.remove(&hash);
                    priority_queue.write().remove(&hash);
                }
                
                // Rebalance priority queue if needed
                let queue_len = priority_queue.read().len();
                if queue_len > 100_000 {
                    // Force cleanup of lowest priority transactions
                    let mut queue = priority_queue.write();
                    while queue.len() > 50_000 {
                        if let Some((hash, _)) = queue.pop() {
                            transactions.remove(&hash);
                        } else {
                            break;
                        }
                    }
                }
            }
        });
    }
}

/// Mempool statistics
#[derive(Debug, Clone)]
pub struct MempoolStats {
    /// Total transactions
    pub total_transactions: usize,
    
    /// Unique senders
    pub unique_senders: usize,
    
    /// Average gas price
    pub avg_gas_price: u64,
    
    /// Age of oldest transaction
    pub oldest_tx_age: Duration,
}

/// Performance statistics for high-throughput monitoring
#[derive(Debug, Clone)]
pub struct MempoolPerformanceStats {
    pub total_transactions: usize,
    pub unique_senders: usize,
    pub queue_size: usize,
    pub avg_gas_price: u64,
    pub capacity_utilization: f64,
    pub last_updated: u64,
}

/// High-frequency mempool operations trait
pub trait HighFrequencyMempool {
    /// Submit batch of transactions with minimal validation
    fn submit_batch_fast(&self, transactions: Vec<Transaction>) -> Vec<bool>;
    
    /// Get transactions optimized for microblock creation
    fn get_microblock_batch(&self, max_size: usize) -> Vec<Transaction>;
    
    /// Remove transactions after successful block creation
    fn confirm_transactions(&self, tx_hashes: &[TxHash]);
}

impl HighFrequencyMempool for Mempool {
    fn submit_batch_fast(&self, transactions: Vec<Transaction>) -> Vec<bool> {
        // Fast submission without heavy validation
        transactions
            .into_iter()
            .map(|tx| {
                if self.transactions.len() >= self.config.max_size {
                    return false;
                }
                
                let priority = self.priority_calc.calculate_priority(&tx);
                let entry = TxEntry {
                    tx: tx.clone(),
                    priority: priority.clone(),
                    added_at: std::time::Instant::now(),
                };
                
                self.transactions.insert(tx.hash.clone(), entry);
                self.priority_queue.write().push(tx.hash.clone(), priority);
                
                true
            })
            .collect()
    }
    
    fn get_microblock_batch(&self, max_size: usize) -> Vec<Transaction> {
        self.get_microblock_transactions(max_size)
    }
    
    fn confirm_transactions(&self, tx_hashes: &[TxHash]) {
        self.batch_remove_transactions(tx_hashes);
    }
} 

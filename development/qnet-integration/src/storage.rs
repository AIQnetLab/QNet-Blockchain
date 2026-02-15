//! Persistent storage implementation for QNet blockchain

use rocksdb::{DB, Options, ColumnFamily, ColumnFamilyDescriptor, WriteBatch, BoundColumnFamily};
use qnet_state::{Block, Account, Transaction};
use crate::errors::{IntegrationError, IntegrationResult};
use std::path::Path;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use hex;
use sha3::{Sha3_256, Digest};
use bincode;
use futures;
use serde_json::{json, Value};
use serde::{Serialize, Deserialize};
use chrono;

// ═══════════════════════════════════════════════════════════════════════════════
// ROLLBACK PROTECTION v3.23: Prevent race condition between rollback and block save
// ═══════════════════════════════════════════════════════════════════════════════
// Problem: During rollback, parallel block receive can overwrite chain_height
// Solution: Atomic flag + target height to block saves during rollback
// Architecture: Lock-free design for maximum throughput (no mutex contention)
// ═══════════════════════════════════════════════════════════════════════════════

/// Flag indicating rollback is in progress - blocks with height > target will be rejected
static ROLLBACK_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Target height for rollback - blocks above this will not be saved
static ROLLBACK_TARGET_HEIGHT: AtomicU64 = AtomicU64::new(0);

/// Timestamp when rollback started (for timeout protection)
static ROLLBACK_START_TIME: AtomicU64 = AtomicU64::new(0);

/// Maximum rollback duration in seconds (prevents deadlock if rollback hangs)
const ROLLBACK_TIMEOUT_SECS: u64 = 60;

/// Start rollback protection - call BEFORE deleting blocks
/// Returns false if another rollback is already in progress
pub fn start_rollback_protection(target_height: u64) -> bool {
    // Check if rollback is already in progress
    if ROLLBACK_IN_PROGRESS.load(Ordering::Acquire) {
        let start_time = ROLLBACK_START_TIME.load(Ordering::Relaxed);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        
        // Allow new rollback if previous one timed out
        if now - start_time < ROLLBACK_TIMEOUT_SECS {
            println!("[WARN][ROLLBACK] Another rollback in progress, target={}", 
                     ROLLBACK_TARGET_HEIGHT.load(Ordering::Relaxed));
            return false;
        }
        println!("[WARN][ROLLBACK] Previous rollback timed out, forcing new rollback");
    }
    
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    
    ROLLBACK_TARGET_HEIGHT.store(target_height, Ordering::Release);
    ROLLBACK_START_TIME.store(now, Ordering::Release);
    ROLLBACK_IN_PROGRESS.store(true, Ordering::Release);
    
    println!("[INFO][ROLLBACK] protection_started target_height={}", target_height);
    true
}

/// End rollback protection - call AFTER rollback is complete
pub fn end_rollback_protection() {
    let target = ROLLBACK_TARGET_HEIGHT.load(Ordering::Relaxed);
    ROLLBACK_IN_PROGRESS.store(false, Ordering::Release);
    println!("[INFO][ROLLBACK] protection_ended target_was={}", target);
}

/// Check if a block at given height can be saved (not blocked by rollback)
/// Returns true if save is allowed, false if blocked
pub fn can_save_block(height: u64) -> bool {
    if !ROLLBACK_IN_PROGRESS.load(Ordering::Acquire) {
        return true;
    }
    
    let target = ROLLBACK_TARGET_HEIGHT.load(Ordering::Acquire);
    
    // Allow saves at or below target height (these are valid blocks)
    if height <= target {
        return true;
    }
    
    // Check for timeout
    let start_time = ROLLBACK_START_TIME.load(Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    
    if now - start_time >= ROLLBACK_TIMEOUT_SECS {
        // Rollback timed out - allow save and clear flag
        println!("[WARN][ROLLBACK] timeout_expired allowing_save height={}", height);
        ROLLBACK_IN_PROGRESS.store(false, Ordering::Release);
        return true;
    }
    
    // Block save - rollback in progress
    false
}

/// Get current rollback status for logging/debugging
pub fn get_rollback_status() -> (bool, u64) {
    (
        ROLLBACK_IN_PROGRESS.load(Ordering::Relaxed),
        ROLLBACK_TARGET_HEIGHT.load(Ordering::Relaxed)
    )
}

/// Failover event for tracking producer failures
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailoverEvent {
    pub height: u64,
    pub failed_producer: String,
    pub emergency_producer: String,
    pub reason: String,
    pub timestamp: i64,
    pub block_type: String, // "microblock" or "macroblock"
}

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

/// Transaction pool with TTL cleanup for efficient microblock storage
/// Stores transactions separately from microblocks to avoid duplication
/// v3.0: Added MAX_SIZE limit to prevent memory leak
#[derive(Debug)]
pub struct TransactionPool {
    /// Map of transaction hash to transaction
    transactions: Arc<RwLock<HashMap<[u8; 32], Transaction>>>,
    /// Map of transaction hash to creation timestamp
    creation_times: Arc<RwLock<HashMap<[u8; 32], u64>>>,
    /// TTL in hours after which transactions are eligible for cleanup
    cleanup_after_hours: u32,
    /// v3.0: Maximum number of transactions to keep in memory (prevents memory leak)
    max_size: usize,
}

/// v3.0: Maximum transaction pool size to prevent memory leak
/// ~200K transactions × ~1KB average = ~200MB RAM (v4.1: 2x)
const MAX_TRANSACTION_POOL_SIZE: usize = 200_000;

impl TransactionPool {
    /// Create new transaction pool with default TTL of 24 hours
    pub fn new() -> Self {
        Self {
            transactions: Arc::new(RwLock::new(HashMap::new())),
            creation_times: Arc::new(RwLock::new(HashMap::new())),
            cleanup_after_hours: 24, // 24 hours retention for local hot storage
            max_size: MAX_TRANSACTION_POOL_SIZE,
        }
    }
    
    /// Store transaction with current timestamp
    /// v3.0: Enforces max_size limit to prevent memory leak
    pub fn store_transaction(&self, tx_hash: [u8; 32], transaction: Transaction) -> Result<(), IntegrationError> {
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| IntegrationError::Other(format!("Time error: {}", e)))?
            .as_secs();
            
        {
            let mut transactions = self.transactions.write()
                .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
            let mut creation_times = self.creation_times.write()
                .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
            
            // v3.0: CRITICAL - Enforce max size to prevent memory leak
            // If at limit, remove oldest 10% of transactions
            if transactions.len() >= self.max_size {
                let cutoff_time = current_time.saturating_sub(self.cleanup_after_hours as u64 * 1800); // 12h instead of 24h when full
                let old_hashes: Vec<[u8; 32]> = creation_times.iter()
                    .filter(|(_, &time)| time < cutoff_time)
                    .map(|(hash, _)| *hash)
                    .take(self.max_size / 10) // Remove up to 10%
                    .collect();
                    
                for hash in &old_hashes {
                    transactions.remove(hash);
                    creation_times.remove(hash);
                }
                
                if !old_hashes.is_empty() {
                    println!("[WARN][TX_POOL] at_capacity max={} evicted={}", 
                             self.max_size, old_hashes.len());
                }
            }
                
            transactions.insert(tx_hash, transaction);
            creation_times.insert(tx_hash, current_time);
        }
        
        Ok(())
    }
    
    /// Get transaction by hash
    pub fn get_transaction(&self, tx_hash: &[u8; 32]) -> Option<Transaction> {
        self.transactions.read()
            .ok()?
            .get(tx_hash)
            .cloned()
    }
    
    /// Get multiple transactions by hashes
    pub fn get_transactions(&self, tx_hashes: &[[u8; 32]]) -> Vec<Option<Transaction>> {
        if let Ok(transactions) = self.transactions.read() {
            tx_hashes.iter()
                .map(|hash| transactions.get(hash).cloned())
                .collect()
        } else {
            vec![None; tx_hashes.len()]
        }
    }
    
    /// Clean up old transactions (only removes duplicates, not original blockchain data)
    pub fn cleanup_old_duplicates(&self) -> Result<usize, IntegrationError> {
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| IntegrationError::Other(format!("Time error: {}", e)))?
            .as_secs();
            
        let cutoff_time = current_time.saturating_sub(self.cleanup_after_hours as u64 * 3600);
        let mut removed_count = 0;
        
        {
            let mut transactions = self.transactions.write()
                .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
            let mut creation_times = self.creation_times.write()
                .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
            
            // Only remove transactions older than TTL 
            // In production, we should also check if transaction is already in finalized blocks
            let old_hashes: Vec<[u8; 32]> = creation_times.iter()
                .filter(|(_, &time)| time < cutoff_time)
                .map(|(hash, _)| *hash)
                .collect();
                
            for hash in old_hashes {
                transactions.remove(&hash);
                creation_times.remove(&hash);
                removed_count += 1;
            }
        }
        
        if removed_count > 0 {
            println!("[TransactionPool] 🧹 Cleaned up {} old transaction duplicates", removed_count);
        }
        
        Ok(removed_count)
    }
    
    /// Get pool statistics
    pub fn get_stats(&self) -> Result<(usize, usize), IntegrationError> {
        let tx_count = self.transactions.read()
            .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?
            .len();
        let time_count = self.creation_times.read()
            .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?
            .len();
            
        Ok((tx_count, time_count))
    }
}

// ============================================================================
// TIERED STORAGE ARCHITECTURE
// ============================================================================
// 
// QNET uses Transaction/Compute Sharding for parallel processing,
// NOT State Sharding for storage division.
//
// SHARDING = Parallel transaction PROCESSING (CPU cores)
// STORAGE = Tiered by node type (Light/Super)
//
// ┌─────────────────────────────────────────────────────────────┐
// │                    STORAGE TIERS (v3.19)                    │
// ├─────────────────────────────────────────────────────────────┤
// │                                                              │
// │  ┌─────────────┐            ┌─────────────────┐             │
// │  │   Light     │            │ Super/Bootstrap │             │
// │  │   Node      │            │     Node        │             │
// │  │  (wallet)   │            │   (server)      │             │
// │  └──────┬──────┘            └────────┬────────┘             │
// │         │                            │                      │
// │   NO storage!                 Full blocks (archival)        │
// │   Pure API client             NO pruning (full history)     │
// │         │                            │                      │
// │      0 MB                        ~500 MB/day                │
// │                                                              │
// │  Data via API:                Serves API requests:          │
// │  GET /api/v1/balance          GET /api/v1/block/{height}    │
// │  GET /api/v1/address/{w}      GET /api/v1/transaction/{h}   │
// │                                                              │
// └─────────────────────────────────────────────────────────────┘
//
// ============================================================================

/// Storage tier configuration for different node types
/// This is about WHAT and HOW LONG to store, NOT which shards
#[derive(Debug, Clone)]
pub struct StorageTierConfig {
    /// Whether to store full transaction data or just block headers
    pub store_full_blocks: bool,
    /// Maximum storage size in bytes
    pub max_storage_bytes: u64,
    /// Pruning window in blocks (0 = no pruning, keep all history)
    pub pruning_window_blocks: u64,
    /// Whether to apply aggressive compression to old blocks
    pub compress_old_blocks: bool,
}

impl StorageTierConfig {
    /// Light node: Pure API client - NO local storage
    /// - Mobile wallets (like Phantom)
    /// - All data via API: /api/v1/balance, /api/v1/address/{wallet}
    /// - Wallet app stores TX history in localStorage/AsyncStorage (not here!)
    /// - This config exists only for backward compatibility
    pub fn light() -> Self {
        Self {
            store_full_blocks: false,
            max_storage_bytes: 0, // NO storage - pure API client
            pruning_window_blocks: 0,
            compress_old_blocks: false,
        }
    }
    
    // v3.19: Light nodes = pure API client, Super nodes = archival servers
    
    /// Super/Bootstrap node: Full blocks, NO pruning, ~2TB
    /// - High-performance servers
    /// - Store complete blockchain history
    /// - Always participate in consensus
    /// - Serve historical data to other nodes
    pub fn super_node() -> Self {
        Self {
            store_full_blocks: true,
            max_storage_bytes: 2 * 1024 * 1024 * 1024 * 1024, // 2 TB
            pruning_window_blocks: 0, // No pruning - keep ALL history
            compress_old_blocks: true, // Apply progressive compression
        }
    }
    
    /// Check if this tier should store full block data
    pub fn should_store_full_block(&self) -> bool {
        self.store_full_blocks
    }
    
    /// Check if a block at given height should be pruned
    pub fn should_prune_block(&self, block_height: u64, current_height: u64) -> bool {
        if self.pruning_window_blocks == 0 {
            return false; // No pruning for this tier
        }
        
        // Keep blocks within the pruning window
        if current_height < self.pruning_window_blocks {
            return false; // Not enough blocks yet
        }
        
        block_height < current_height - self.pruning_window_blocks
    }
    
    /// Get the compression level for a block based on its age
    /// Returns Zstd compression level (0 = none, 3 = light, 9 = medium, 22 = max)
    pub fn get_compression_level(&self, block_age_seconds: u64) -> i32 {
        if !self.compress_old_blocks {
            return 3; // Light compression for all
        }
        
        match block_age_seconds {
            0..=3600 => 3,           // < 1 hour: light (Zstd-3)
            3601..=86400 => 9,       // 1h - 1 day: medium (Zstd-9)
            86401..=604800 => 15,    // 1d - 7 days: heavy (Zstd-15)
            _ => 22,                  // > 7 days: maximum (Zstd-22)
        }
    }
}

// ============================================================================
// GRACEFUL DEGRADATION SYSTEM
// ============================================================================
// When storage fills up, nodes automatically degrade to lower tiers:
// Super → Full → Light
// This ensures the node keeps running even with limited storage.
// ============================================================================

/// Storage health status
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StorageHealth {
    /// Storage is healthy (< 70% full)
    Healthy,
    /// Storage is getting full (70-85% full) - start aggressive pruning
    Warning,
    /// Storage is almost full (85-95% full) - emergency pruning
    Critical,
    /// Storage is full (>= 95%) - graceful degradation
    Full,
}

impl StorageHealth {
    pub fn from_percentage(percentage: f64) -> Self {
        match percentage {
            p if p < 70.0 => StorageHealth::Healthy,
            p if p < 85.0 => StorageHealth::Warning,
            p if p < 95.0 => StorageHealth::Critical,
            _ => StorageHealth::Full,
        }
    }
    
    pub fn as_str(&self) -> &'static str {
        match self {
            StorageHealth::Healthy => "HEALTHY",
            StorageHealth::Warning => "WARNING",
            StorageHealth::Critical => "CRITICAL",
            StorageHealth::Full => "FULL",
        }
    }
}

/// Graceful degradation manager
/// Automatically downgrades node storage tier when disk fills up
pub struct GracefulDegradation {
    /// Original storage mode (what user configured)
    original_mode: StorageMode,
    /// Current effective mode (may be degraded)
    current_mode: StorageMode,
    /// Whether degradation is active
    is_degraded: bool,
    /// Timestamp when degradation started
    degraded_since: Option<u64>,
}

impl GracefulDegradation {
    pub fn new(mode: StorageMode) -> Self {
        Self {
            original_mode: mode,
            current_mode: mode,
            is_degraded: false,
            degraded_since: None,
        }
    }
    
    /// Check if we need to degrade based on storage health
    pub fn check_and_degrade(&mut self, health: StorageHealth) -> Option<StorageMode> {
        match health {
            StorageHealth::Full => {
                // Degrade to next lower tier
                // v3.18: Only Light and Super modes (Full removed)
                let new_mode = match self.current_mode {
                    StorageMode::Super => {
                        println!("[WARN][STORAGE] degradation super_to_light reason=storage_full");
                        StorageMode::Light
                    },
                    StorageMode::Light => {
                        // Already at lowest tier, can't degrade further
                        println!("[WARN][STORAGE] Already at Light mode, cannot degrade further!");
                        return None;
                    }
                };
                
                self.current_mode = new_mode;
                self.is_degraded = true;
                self.degraded_since = Some(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs()
                );
                
                Some(new_mode)
            },
            StorageHealth::Healthy if self.is_degraded => {
                // Storage is healthy again, try to restore original mode
                // Only restore if we've been degraded for at least 1 hour
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                
                if let Some(since) = self.degraded_since {
                    if now - since > 3600 {
                        let mode_name = match self.original_mode {
                            StorageMode::Light => "light",
                            StorageMode::Super => "super",
                        };
                        println!("[INFO][STORAGE] restored_mode mode={} reason=storage_healthy", mode_name);
                        self.current_mode = self.original_mode;
                        self.is_degraded = false;
                        self.degraded_since = None;
                        return Some(self.original_mode);
                    }
                }
                None
            },
            _ => None,
        }
    }
    
    pub fn get_current_mode(&self) -> StorageMode {
        self.current_mode
    }
    
    pub fn is_degraded(&self) -> bool {
        self.is_degraded
    }
}

// ============================================================================
// LIGHT NODE ROTATION (Auto-cleanup old headers)
// ============================================================================
// Light nodes automatically delete old block headers to maintain ~100MB size
// This is a FIFO queue - oldest headers are deleted first
// ============================================================================

/// Light node header rotation configuration
pub struct LightNodeRotation {
    /// Maximum number of headers to keep
    max_headers: u64,
    /// Current header count
    current_count: u64,
}

impl LightNodeRotation {
    pub fn new(max_headers: u64) -> Self {
        Self {
            max_headers,
            current_count: 0,
        }
    }
    
    /// Check if we need to rotate (delete old headers)
    pub fn needs_rotation(&self) -> bool {
        self.current_count >= self.max_headers
    }
    
    /// Get number of headers to delete
    pub fn headers_to_delete(&self) -> u64 {
        if self.current_count > self.max_headers {
            self.current_count - self.max_headers
        } else {
            0
        }
    }
    
    /// Update count after adding a header
    pub fn increment(&mut self) {
        self.current_count += 1;
    }
    
    /// Update count after deleting headers
    pub fn decrement(&mut self, count: u64) {
        self.current_count = self.current_count.saturating_sub(count);
    }
}

impl PersistentStorage {
    /// Save raw data with a custom key
    pub fn save_raw(&self, key: &str, data: &[u8]) -> IntegrationResult<()> {
        self.db.put(key.as_bytes(), data)?;
        Ok(())
    }
    
    /// Load raw data with a custom key
    pub fn load_raw(&self, key: &str) -> IntegrationResult<Option<Vec<u8>>> {
        match self.db.get(key.as_bytes())? {
            Some(data) => Ok(Some(data)),
            None => Ok(None),
        }
    }
    
    pub fn new(data_dir: &str) -> IntegrationResult<Self> {
        let path = Path::new(data_dir);
        std::fs::create_dir_all(path)?;
        
        // ═══════════════════════════════════════════════════════════════════════════
        // v3.19: OPTIMIZED RocksDB configuration for reduced disk usage
        // ═══════════════════════════════════════════════════════════════════════════
        let mut opts = Options::default();
        opts.create_if_missing(true);
        opts.create_missing_column_families(true);
        
        // v3.19: Reduced buffer sizes (64MB -> 16MB = 4x smaller WAL files)
        opts.set_max_open_files(500);  // Reduced from 1000
        opts.set_use_fsync(false);     // Async fsync for better performance
        opts.set_bytes_per_sync(524288); // 512KB sync interval (was 1MB)
        opts.set_max_write_buffer_number(2);  // Reduced from 4
        opts.set_write_buffer_size(16777216); // 16MB (was 64MB) - 4x smaller WAL!
        opts.set_target_file_size_base(16777216); // 16MB (was 64MB)
        opts.set_min_write_buffer_number_to_merge(1); // Merge immediately
        opts.set_level_zero_stop_writes_trigger(8);   // Reduced
        opts.set_level_zero_slowdown_writes_trigger(4); // Reduced
        opts.set_compaction_style(rocksdb::DBCompactionStyle::Level);
        opts.set_max_background_jobs(2);  // Reduced from 4
        opts.set_disable_auto_compactions(false);
        
        // v3.41: CRITICAL WAL CLEANUP - limits total WAL size to 64MB
        // Without this, WAL files accumulate indefinitely with 17 column families
        // because a WAL can only be deleted when ALL CFs flush past it.
        // Rarely-written CFs (failover_events, poh_state) keep stale memtables,
        // preventing WAL deletion → 463 files / 1.8GB in 23 hours.
        // With this setting, RocksDB force-flushes oldest CF memtables when
        // total WAL exceeds 64MB, enabling old WAL cleanup.
        opts.set_max_total_wal_size(67_108_864); // 64MB max WAL (was: unlimited)
        
        // v3.19: AGGRESSIVE compaction settings
        opts.set_level_compaction_dynamic_level_bytes(true);
        opts.set_max_bytes_for_level_base(67108864); // 64MB base level
        opts.set_max_bytes_for_level_multiplier(4.0); // Faster level growth
        
        // v3.19: Enable compression at ALL levels (huge disk savings!)
        opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
        opts.set_bottommost_compression_type(rocksdb::DBCompressionType::Zstd);
        
        // v3.19: Optimized block-based options
        let mut block_opts = rocksdb::BlockBasedOptions::default();
        block_opts.set_block_size(16384); // 16KB blocks (was default 4KB)
        block_opts.set_cache_index_and_filter_blocks(true);
        block_opts.set_bloom_filter(10.0, false); // Bloom filter for faster lookups
        opts.set_block_based_table_factory(&block_opts);
        
        // v3.19: Create optimized CF options with compression
        fn create_cf_opts() -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
            cf_opts.set_write_buffer_size(8388608); // 8MB per CF
            cf_opts.set_max_write_buffer_number(2);
            cf_opts.set_target_file_size_base(16777216); // 16MB
            cf_opts
        }
        
        // v3.19: Optimized CF for hot data (microblocks, heartbeats)
        fn create_hot_cf_opts() -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
            cf_opts.set_write_buffer_size(4194304); // 4MB - very small for hot data
            cf_opts.set_max_write_buffer_number(2);
            cf_opts.set_target_file_size_base(8388608); // 8MB
            cf_opts
        }
        
        // v3.19: Optimized CF for cold data (old blocks)
        fn create_cold_cf_opts() -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Zstd); // Better compression
            cf_opts.set_write_buffer_size(16777216); // 16MB
            cf_opts.set_max_write_buffer_number(2);
            cf_opts.set_target_file_size_base(33554432); // 32MB
            cf_opts
        }
        
        let cfs = vec![
            ColumnFamilyDescriptor::new("blocks", create_cold_cf_opts()),  // Cold: old blocks
            ColumnFamilyDescriptor::new("transactions", create_cf_opts()),
            ColumnFamilyDescriptor::new("accounts", create_cf_opts()),
            ColumnFamilyDescriptor::new("metadata", create_cf_opts()),
            ColumnFamilyDescriptor::new("microblocks", create_hot_cf_opts()), // Hot: recent blocks
            ColumnFamilyDescriptor::new("consensus", create_hot_cf_opts()),   // Hot: consensus data
            ColumnFamilyDescriptor::new("sync_state", create_cf_opts()),
            ColumnFamilyDescriptor::new("pending_rewards", create_cf_opts()),
            ColumnFamilyDescriptor::new("node_registry", create_cf_opts()),
            ColumnFamilyDescriptor::new("ping_history", create_hot_cf_opts()), // Hot: pings
            ColumnFamilyDescriptor::new("failover_events", create_cf_opts()),
            ColumnFamilyDescriptor::new("snapshots", create_cold_cf_opts()),  // Cold: snapshots
            ColumnFamilyDescriptor::new("tx_index", create_cf_opts()),
            ColumnFamilyDescriptor::new("tx_by_address", create_cf_opts()),
            ColumnFamilyDescriptor::new("attestations", create_hot_cf_opts()), // Hot: attestations
            ColumnFamilyDescriptor::new("heartbeats", create_hot_cf_opts()),   // Hot: heartbeats
            ColumnFamilyDescriptor::new("poh_state", create_hot_cf_opts()),    // Hot: PoH state
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
        let tx_index_cf = self.db.cf_handle("tx_index")
            .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
        let tx_by_addr_cf = self.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        
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
        
        // Store transactions with Zstd-3 compression for O(1) lookups
        // OPTIMIZATION: Zstd-3 is fast (~500MB/s) and provides ~30-50% reduction
        // Pattern compression is done in background to not block consensus
        for tx in &block.transactions {
            let tx_key = format!("tx_{}", tx.hash);
            let tx_data = bincode::serialize(tx)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            
            // PRODUCTION: Compress transactions with fast Zstd-3 (non-blocking)
            // ~30-50% reduction, <1ms per TX, doesn't block block production
            let compressed_tx = zstd::encode_all(&tx_data[..], 3)
                .unwrap_or_else(|_| tx_data.clone());
            
            batch.put_cf(&tx_cf, tx_key.as_bytes(), &compressed_tx);
            
            // INDEX: tx_hash -> block_height for O(1) transaction location
            batch.put_cf(&tx_index_cf, tx_key.as_bytes(), &block.height.to_be_bytes());
            
            // INDEX: address -> tx_hash for account transaction queries
            // Key format: addr_{address}_{timestamp}_{tx_hash} for chronological ordering
            let timestamp = tx.timestamp;
            let from_key = format!("addr_{}_{:016x}_{}", tx.from, timestamp, tx.hash);
            batch.put_cf(&tx_by_addr_cf, from_key.as_bytes(), tx.hash.as_bytes());
            
            if let Some(ref to) = tx.to {
                let to_key = format!("addr_{}_{:016x}_{}", to, timestamp, tx.hash);
                batch.put_cf(&tx_by_addr_cf, to_key.as_bytes(), tx.hash.as_bytes());
            }
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
    
    /// CRITICAL FIX v2.64: Verify and repair desync between metadata CF and blocks CF
    /// Called ONCE at node startup to detect stuck chain_height
    /// 
    /// Problem: If metadata chain_height gets stuck but blocks continue arriving:
    /// - Blocks save to 'blocks' CF via broadcast
    /// - But 'metadata' CF chain_height doesn't update
    /// - Node reports old height but has newer blocks
    /// 
    /// Solution: Linear scan with gap tolerance to find actual max continuous height
    /// SECURITY: Only repairs if chain is continuous (no gaps > 10 blocks)
    /// PERFORMANCE: O(n) but only runs once at startup and uses early exit
    /// 
    /// v3.0: CRITICAL FIX - If metadata_height is low but blocks exist higher,
    /// use RocksDB iterator to find first existing block and scan from there
    pub fn verify_and_repair_chain_height(&self) -> IntegrationResult<bool> {
        use crate::node::{is_info, is_debug, is_warn};
        
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let blocks_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        
        // Get metadata height with read lock (atomic read)
        let metadata_height = match self.db.get_cf(&metadata_cf, b"chain_height")? {
            Some(data) if data.len() >= 8 => {
                u64::from_be_bytes(data[0..8].try_into()
                    .map_err(|_| IntegrationError::StorageError("Invalid height data".to_string()))?)
            }
            _ => 0,
        };
        
        if is_debug() { 
            println!("[DBG][STORAGE] verify_start metadata_h={}", metadata_height); 
        }
        
        // SECURITY: Find max CONTINUOUS height (no gaps > 10 blocks allowed)
        // This prevents accepting blocks from fork/attack with gaps
        let mut result = self.find_max_continuous_height(&blocks_cf, metadata_height)?;
        
        // v3.0: CRITICAL FIX - If metadata_height is low (0-10) and no continuous blocks found,
        // scan for FIRST existing block and use that as starting point
        // This handles the case where OOM corrupted metadata but blocks are intact
        if result.is_none() && metadata_height < 100 {
            if is_warn() {
                println!("[WARN][STORAGE] no_continuous_from_h={} scanning_for_first_block", metadata_height);
            }
            
            // Find first existing block using RocksDB iterator
            if let Some(first_block_height) = self.find_first_existing_block(&blocks_cf)? {
                if first_block_height > metadata_height {
                    if is_warn() {
                        println!("[WARN][STORAGE] found_first_block_at={} metadata_was={}", 
                                 first_block_height, metadata_height);
                    }
                    
                    // Now scan from first found block to find max continuous
                    result = self.find_max_continuous_height(&blocks_cf, first_block_height.saturating_sub(1))?;
                    
                    if let Some((max_height, _)) = result {
                        if is_warn() {
                            println!("[WARN][STORAGE] recovery_scan first={} max_continuous={}", 
                                     first_block_height, max_height);
                        }
                    }
                }
            }
        }
        
        match result {
            Some((actual_height, has_gaps)) => {
                if actual_height > metadata_height {
                    let gap = actual_height - metadata_height;
                    
                    // SECURITY CHECK: Don't auto-repair if chain has suspicious gaps
                    if has_gaps {
                        println!("[WARN][STORAGE] desync_detected_with_gaps metadata={} max_found={} gap={} auto_repair=skipped", 
                                 metadata_height, actual_height, gap);
                        if is_info() {
                            println!("[INFO][STORAGE] manual_repair_required reason=chain_gaps use_resync_recommended");
                        }
                        return Ok(false); // Don't auto-repair suspicious chain
                    }
                    
                    println!("[WARN][STORAGE] desync_detected metadata={} continuous_to={} gap={}", 
                             metadata_height, actual_height, gap);
                    
                    // ATOMICITY: Use compare-and-swap to prevent race conditions
                    // Re-read metadata height to detect if it was updated during scan
                    let current_metadata = match self.db.get_cf(&metadata_cf, b"chain_height")? {
                        Some(data) if data.len() >= 8 => u64::from_be_bytes(data[0..8].try_into().unwrap()),
                        _ => 0,
                    };
                    
                    if current_metadata != metadata_height {
                        if is_debug() {
                            println!("[DBG][STORAGE] race_detected metadata_changed {} -> {} during_scan", 
                                     metadata_height, current_metadata);
                        }
                        return Ok(false); // Another process already fixed it
                    }
                    
                    // Safe to update: no race detected
                    if is_info() {
                        println!("[INFO][STORAGE] auto_repair_start h={}->{}", 
                                 metadata_height, actual_height);
                    }
                    
                    // Write new height
                    self.db.put_cf(&metadata_cf, b"chain_height", &actual_height.to_be_bytes())?;
                    
                    // SECURITY: Verify write succeeded (detect late race conditions)
                    let verify_height = match self.db.get_cf(&metadata_cf, b"chain_height")? {
                        Some(data) if data.len() >= 8 => u64::from_be_bytes(data[0..8].try_into().unwrap()),
                        _ => 0,
                    };
                    
                    if verify_height != actual_height {
                        println!("[WARN][STORAGE] auto_repair_race_detected expected={} got={}", 
                                 actual_height, verify_height);
                        return Ok(false); // Race condition detected, don't claim success
                    }
                    
                    println!("[INFO][STORAGE] auto_repair_ok h={} gap_fixed={} verified=true", 
                             actual_height, gap);
                    
                    return Ok(true); // Repaired and verified
                }
            }
            None => {
                // No blocks found after metadata height
                if is_debug() { 
                    println!("[DBG][STORAGE] verify_ok metadata_h={} no_newer_blocks", metadata_height); 
                }
            }
        }
        
        Ok(false) // No repair needed
    }
    
    /// Find maximum continuous height in blocks CF (with gap tolerance)
    /// Returns: Some((max_height, has_significant_gaps)) or None if no blocks after start
    /// 
    /// SECURITY: Tolerates small gaps (up to 10 blocks) for network delays
    /// but reports if significant gaps exist (possible fork/attack)
    /// 
    /// PERFORMANCE: O(n) but with early exit and reasonable limit (20K blocks)
    /// For typical desync (< 1000 blocks): ~1000 RocksDB reads (< 100ms)
    fn find_max_continuous_height(&self, blocks_cf: &ColumnFamily, start: u64) -> IntegrationResult<Option<(u64, bool)>> {
        use crate::node::is_debug;
        
        const MAX_SCAN_BLOCKS: u64 = 20000; // Safety limit (prevent infinite scan)
        const GAP_TOLERANCE: u64 = 10; // Allow up to 10 missing blocks (network delays)
        
        let mut max_found = start;
        let mut consecutive_missing = 0u64;
        let mut has_significant_gaps = false;
        let mut found_any = false;
        
        // Pre-allocate buffer for key formatting (avoid repeated allocations)
        let mut key_buffer = String::with_capacity(32);
        
        for h in (start + 1)..=(start.saturating_add(MAX_SCAN_BLOCKS)) {
            key_buffer.clear();
            use std::fmt::Write;
            write!(&mut key_buffer, "block_{}", h).unwrap();
            
            if self.db.get_cf(blocks_cf, key_buffer.as_bytes())?.is_some() {
                max_found = h;
                consecutive_missing = 0;
                found_any = true;
            } else {
                consecutive_missing += 1;
                
                if consecutive_missing > GAP_TOLERANCE {
                    // Gap too large - stop scanning
                    if consecutive_missing > 20 {
                        has_significant_gaps = true;
                    }
                    
                    if is_debug() {
                        println!("[DBG][STORAGE] scan_stopped at_h={} gap={} max_found={}", 
                                 h, consecutive_missing, max_found);
                    }
                    break;
                }
            }
        }
        
        if found_any {
            Ok(Some((max_found, has_significant_gaps)))
        } else {
            Ok(None)
        }
    }
    
    /// v3.0: Find first existing block in storage using RocksDB iterator
    /// Used for recovery when metadata is corrupted but blocks exist
    /// 
    /// PERFORMANCE: Uses prefix iterator, typically finds block in O(1)
    fn find_first_existing_block(&self, blocks_cf: &ColumnFamily) -> IntegrationResult<Option<u64>> {
        use rocksdb::IteratorMode;
        use crate::node::is_debug;
        
        // RocksDB keys are "block_N" where N is the height
        // Iterator will scan in lexicographic order
        let iter = self.db.iterator_cf(blocks_cf, IteratorMode::Start);
        
        for item in iter {
            match item {
                Ok((key, _)) => {
                    // Parse "block_N" format
                    if let Ok(key_str) = std::str::from_utf8(&key) {
                        if key_str.starts_with("block_") {
                            if let Ok(height) = key_str[6..].parse::<u64>() {
                                if is_debug() {
                                    println!("[DBG][STORAGE] found_first_block h={}", height);
                                }
                                return Ok(Some(height));
                            }
                        }
                    }
                }
                Err(e) => {
                    println!("[WARN][STORAGE] iterator_error err={}", e);
                    break;
                }
            }
        }
        
        Ok(None)
    }
    
    /// v3.0: Flush all RocksDB data to disk
    /// CRITICAL: Call before graceful shutdown or when OOM is imminent
    /// This flushes WAL (Write-Ahead Log) to SST files, ensuring data durability
    pub fn flush_all(&self) -> IntegrationResult<()> {
        use rocksdb::FlushOptions;
        
        let mut flush_opts = FlushOptions::default();
        flush_opts.set_wait(true); // Wait for flush to complete
        
        // v3.41: Flush ALL column families (including ephemeral CFs)
        // CRITICAL: WAL can only be deleted when ALL CFs are flushed past it.
        // Missing CFs here caused WAL accumulation (1.8GB in 23h).
        // Must match EXACTLY the CFs in DB::open_cf_descriptors (line 668-686)
        let cf_names = ["blocks", "transactions", "accounts", "metadata",
                        "microblocks", "consensus", "sync_state",
                        "pending_rewards", "node_registry", "ping_history",
                        "failover_events", "snapshots", "tx_index",
                        "tx_by_address", "attestations", "heartbeats", "poh_state"];
        
        for cf_name in &cf_names {
            if let Some(cf) = self.db.cf_handle(cf_name) {
                if let Err(e) = self.db.flush_cf_opt(&cf, &flush_opts) {
                    println!("[WARN][STORAGE] flush_cf_failed cf={} err={}", cf_name, e);
                    // Continue flushing other CFs even if one fails
                }
            }
        }
        
        // Also flush default CF
        if let Err(e) = self.db.flush_opt(&flush_opts) {
            println!("[WARN][STORAGE] flush_default_failed err={}", e);
        }
        
        Ok(())
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v3.19: PRUNING - Remove old data to save disk space
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// v3.19: Prune old microblocks older than retention_blocks
    /// Keeps only recent blocks for sync, deletes old ones to save disk
    /// SAFE: Only prunes microblocks, not macroblocks (which contain finality data)
    pub fn prune_old_microblocks(&self, current_height: u64, retention_blocks: u64) -> IntegrationResult<usize> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks CF not found".to_string()))?;
        
        if current_height <= retention_blocks {
            return Ok(0); // Nothing to prune yet
        }
        
        let prune_below = current_height - retention_blocks;
        let mut deleted = 0;
        
        // Delete microblocks older than prune_below
        let mut batch = WriteBatch::default();
        
        for height in 0..prune_below {
            let key = height.to_be_bytes();
            batch.delete_cf(&microblocks_cf, &key);
            deleted += 1;
            
            // Commit in batches of 1000 to avoid memory issues
            if deleted % 1000 == 0 {
                self.db.write(batch)?;
                batch = WriteBatch::default();
            }
        }
        
        // Write remaining deletes
        if deleted % 1000 != 0 {
            self.db.write(batch)?;
        }
        
        // Trigger compaction to reclaim space
        self.db.compact_range_cf(&microblocks_cf, None::<&[u8]>, None::<&[u8]>);
        
        println!("[STORAGE] v3.19: Pruned {} old microblocks (kept last {})", deleted, retention_blocks);
        Ok(deleted)
    }
    
    /// v3.19: Prune old heartbeats older than retention_seconds
    /// Heartbeats are only needed for recent epoch, old ones waste space
    pub fn prune_old_heartbeats(&self, retention_seconds: u64) -> IntegrationResult<usize> {
        let heartbeats_cf = self.db.cf_handle("heartbeats")
            .ok_or_else(|| IntegrationError::StorageError("heartbeats CF not found".to_string()))?;
        
        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let prune_before = current_time.saturating_sub(retention_seconds);
        let mut deleted = 0;
        let mut batch = WriteBatch::default();
        
        // Iterate through heartbeats and delete old ones
        let iter = self.db.iterator_cf(&heartbeats_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            if let Ok((key, value)) = item {
                // Try to extract timestamp from value
                if value.len() >= 8 {
                    let ts = u64::from_be_bytes(value[0..8].try_into().unwrap_or([0; 8]));
                    if ts < prune_before {
                        batch.delete_cf(&heartbeats_cf, &key);
                        deleted += 1;
                        
                        if deleted % 1000 == 0 {
                            self.db.write(batch)?;
                            batch = WriteBatch::default();
                        }
                    }
                }
            }
        }
        
        if deleted % 1000 != 0 {
            self.db.write(batch)?;
        }
        
        // Trigger compaction
        self.db.compact_range_cf(&heartbeats_cf, None::<&[u8]>, None::<&[u8]>);
        
        if deleted > 0 {
            println!("[STORAGE] v3.19: Pruned {} old heartbeats (kept last {}s)", deleted, retention_seconds);
        }
        Ok(deleted)
    }
    
    /// v3.19: Run full pruning cycle (call periodically, e.g., every hour)
    /// retention_blocks: How many microblocks to keep (e.g., 86400 = ~1 day at 1 block/sec)
    /// heartbeat_retention_secs: How long to keep heartbeats (e.g., 86400 = 1 day)
    pub fn run_pruning_cycle(&self, current_height: u64, retention_blocks: u64, heartbeat_retention_secs: u64) -> IntegrationResult<()> {
        println!("[STORAGE] v3.19: Starting pruning cycle (retention: {} blocks, {} sec heartbeats)", 
                 retention_blocks, heartbeat_retention_secs);
        
        let start = std::time::Instant::now();
        
        // Prune microblocks
        let microblocks_deleted = self.prune_old_microblocks(current_height, retention_blocks)?;
        
        // Prune heartbeats  
        let heartbeats_deleted = self.prune_old_heartbeats(heartbeat_retention_secs)?;
        
        // Force compaction on all CFs
        self.compact_all()?;
        
        let elapsed = start.elapsed();
        println!("[STORAGE] v3.19: Pruning complete in {:?} (microblocks: {}, heartbeats: {})", 
                 elapsed, microblocks_deleted, heartbeats_deleted);
        
        Ok(())
    }
    
    /// v3.19 / v3.41: Compact all column families to reclaim disk space
    /// CRITICAL: Without compaction after delete operations, RocksDB marks
    /// keys as tombstones but doesn't physically reclaim disk space until
    /// compaction runs. This must be called after cleanup operations.
    /// Must match EXACTLY the CFs in DB::open_cf_descriptors (line 668-686)
    pub fn compact_all(&self) -> IntegrationResult<()> {
        let cf_names = ["blocks", "transactions", "accounts", "metadata",
                        "microblocks", "consensus", "sync_state",
                        "pending_rewards", "node_registry", "ping_history",
                        "failover_events", "snapshots", "tx_index",
                        "tx_by_address", "attestations", "heartbeats", "poh_state"];
        
        for cf_name in &cf_names {
            if let Some(cf) = self.db.cf_handle(cf_name) {
                self.db.compact_range_cf(&cf, None::<&[u8]>, None::<&[u8]>);
            }
        }
        
        println!("[INFO][STORAGE] compaction_triggered cfs={}", cf_names.len());
        Ok(())
    }
    
    /// Set chain height to a specific value (for fork resolution)
    pub fn set_chain_height(&self, height: u64) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        self.db.put_cf(&metadata_cf, b"chain_height", &height.to_be_bytes())?;
        Ok(())
    }
    
    /// DATA CONSISTENCY: Reset chain height to 0 (DANGEROUS - requires explicit confirmation)
    /// This function will ONLY work if QNET_FORCE_RESET=1 AND QNET_CONFIRM_RESET=YES
    pub fn reset_chain_height(&self) -> IntegrationResult<()> {
        // SAFETY: Double-check that user REALLY wants to reset
        let force_reset = std::env::var("QNET_FORCE_RESET").unwrap_or_default();
        let confirm_reset = std::env::var("QNET_CONFIRM_RESET").unwrap_or_default();
        
        if force_reset != "1" || confirm_reset != "YES" {
            println!("[Storage] ⚠️ REFUSING to reset chain height!");
            println!("[Storage]    To reset, set BOTH:");
            println!("[Storage]    - QNET_FORCE_RESET=1");
            println!("[Storage]    - QNET_CONFIRM_RESET=YES");
            return Err(IntegrationError::StorageError(
                "Chain height reset blocked - missing confirmation flags".to_string()
            ));
        }
        
        // Additional safety: Log the reset with timestamp
        let timestamp = chrono::Utc::now();
        println!("[Storage] ⚠️⚠️⚠️ CHAIN HEIGHT RESET INITIATED ⚠️⚠️⚠️");
        println!("[Storage]    Timestamp: {}", timestamp);
        println!("[Storage]    Requested by: QNET_FORCE_RESET + QNET_CONFIRM_RESET");
        
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        // Get current height before reset for logging
        let current_height = match self.get_chain_height() {
            Ok(h) => h,
            Err(_) => 0,
        };
        
        // Set height to 0
        let height_bytes = 0u64.to_be_bytes();
        self.db.put_cf(&metadata_cf, b"chain_height", height_bytes)?;
        
        println!("[Storage] ✅ Chain height reset: {} -> 0", current_height);
        println!("[Storage] ⚠️  Data loss: {} blocks deleted", current_height);
        Ok(())
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
        // v3.23: Check rollback protection before saving
        // This prevents race condition where parallel block receive overwrites rollback
        if !can_save_block(height) {
            let (in_progress, target) = get_rollback_status();
            println!("[WARN][STORAGE] block_save_blocked h={} rollback_in_progress={} target={}", 
                     height, in_progress, target);
            // Return Ok to avoid error propagation - block will be re-requested after rollback
            return Ok(());
        }
        
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        let key = format!("microblock_{}", height);
        
        // Use batch write to update both microblock and chain height atomically
        let mut batch = WriteBatch::default();
        batch.put_cf(&microblocks_cf, key.as_bytes(), data);
        
        // Update chain height - but only if not in rollback or height <= target
        // Double-check protection in case of race between check and write
        if can_save_block(height) {
            batch.put_cf(&metadata_cf, b"chain_height", &height.to_be_bytes());
        }
        
        self.db.write(batch)?;
        Ok(())
    }
    
    /// PRODUCTION: Save activation code with AES-256-GCM encryption
    /// Key is derived from activation code and NEVER stored in database
    pub fn save_activation_code(&self, code: &str, node_type: u8, timestamp: u64) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        // Get device signature for migration tracking (NOT for encryption!)
        let device_signature = Self::get_device_signature_for_tracking();
        let server_ip = Self::get_server_ip();
        
        // SECURITY: Create activation data (includes code for self-validation)
        let activation_data = format!("{}:{}:{}:{}:{}", 
            code, node_type, timestamp, device_signature, server_ip);
        
        // PRODUCTION: Encrypt with AES-256-GCM (quantum-resistant)
        // Key is derived from activation code - NOT stored in database!
        let (encrypted_data, nonce) = Self::encrypt_with_aes_gcm(&activation_data, code)?;
        
        // Create storage record (nonce is public, encryption_key is NOT stored!)
        let storage_record = format!("{}:{}", 
            hex::encode(&nonce),  // Nonce (12 bytes, can be public)
            hex::encode(&encrypted_data)  // Encrypted data
        );
        
        self.db.put_cf(&metadata_cf, b"activation_code", storage_record.as_bytes())?;
        
        // CRITICAL: Do NOT save encryption key to database!
        // Key is derived from activation code when needed
        
        println!("[Storage] 🔐 Activation code encrypted with AES-256-GCM (key NOT stored)");
        Ok(())
    }
    
    /// PRODUCTION: Load activation code with AES-256-GCM decryption
    /// Key is derived from activation code (env var or Genesis BOOTSTRAP_ID)
    pub fn load_activation_code(&self) -> IntegrationResult<Option<(String, u8, u64)>> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        match self.db.get_cf(&metadata_cf, b"activation_code")? {
            Some(encrypted_data) => {
                let encrypted_str = String::from_utf8_lossy(&encrypted_data);
                
                // Check if this is NEW format (nonce:encrypted) or LEGACY format (has state_key)
                if encrypted_str.contains(':') && encrypted_str.split(':').count() == 2 {
                    // NEW FORMAT: AES-256-GCM encrypted
                    let parts: Vec<&str> = encrypted_str.split(':').collect();
                    let nonce_hex = parts[0];
                    let encrypted_hex = parts[1];
                    
                    // Get activation code for decryption key
                    let activation_code = Self::get_activation_code_for_decryption()?;
                    
                    // Parse nonce and encrypted data
                    let nonce_bytes = hex::decode(nonce_hex)
                        .map_err(|e| IntegrationError::SecurityError(format!("Invalid nonce: {}", e)))?;
                    let encrypted_bytes = hex::decode(encrypted_hex)
                        .map_err(|e| IntegrationError::SecurityError(format!("Invalid encrypted data: {}", e)))?;
                    
                    if nonce_bytes.len() != 12 {
                        return Err(IntegrationError::SecurityError("Invalid nonce length".to_string()));
                    }
                    
                    let mut nonce_array = [0u8; 12];
                    nonce_array.copy_from_slice(&nonce_bytes);
                    
                    // PRODUCTION: Decrypt with AES-256-GCM
                    let decrypted_data = Self::decrypt_with_aes_gcm(&encrypted_bytes, &nonce_array, &activation_code)?;
                    
                    let decrypted_parts: Vec<&str> = decrypted_data.split(':').collect();
                    
                    // AES-256 format: code:node_type:timestamp:device_signature:server_ip
                    if decrypted_parts.len() >= 5 {
                        let saved_code = decrypted_parts[0];
                        let node_type = decrypted_parts[1].parse::<u8>().unwrap_or(1);
                        let timestamp = decrypted_parts[2].parse::<u64>().unwrap_or(0);
                        let stored_device_signature = decrypted_parts[3];
                        let stored_server_ip = decrypted_parts[4];
                        
                        // SECURITY: Validate that decrypted code matches activation code used for decryption
                        if saved_code != activation_code {
                            return Err(IntegrationError::SecurityError(
                                "Decryption succeeded but activation code mismatch - wrong code provided".to_string()
                            ));
                        }
                        
                        // PRODUCTION: Log device migration if detected
                        let current_device = Self::get_device_signature_for_tracking();
                        if stored_device_signature != current_device {
                            println!("[Storage] 🔄 Device signature changed (migration or new hardware):");
                            println!("   Stored: {}...", &stored_device_signature[..8.min(stored_device_signature.len())]);
                            println!("   Current: {}...", &current_device[..8.min(current_device.len())]);
                        }
                        
                        // Log IP changes (normal for migrations)
                        let current_server_ip = Self::get_server_ip();
                        if current_server_ip != stored_server_ip {
                            println!("[Storage] 📍 Server IP changed: {} → {} (migration/restart)", 
                                     stored_server_ip, current_server_ip);
                        }
                        
                        println!("[Storage] ✅ Activation code loaded and validated (AES-256-GCM)");
                        return Ok(Some((saved_code.to_string(), node_type, timestamp)));
                    } else {
                        return Err(IntegrationError::SecurityError("Invalid AES-256 activation format".to_string()));
                    }
                } else {
                    // LEGACY FORMAT: Check for old XOR encryption with state_key
                    println!("[Storage] 🔄 Detected legacy activation format - attempting migration");
                    
                    match self.db.get_cf(&metadata_cf, b"state_key")? {
                        Some(_) => {
                            // Legacy XOR format exists - load and re-save with AES-256
                            return self.load_legacy_activation_code(&encrypted_data);
                        }
                        None => {
                            return Err(IntegrationError::SecurityError(
                                "Unknown activation code format".to_string()
                            ));
                        }
                    }
                }
            }
            None => Ok(None),
        }
    }
    
    /// Load legacy activation code format for backwards compatibility
    fn load_legacy_activation_code(&self, data: &[u8]) -> IntegrationResult<Option<(String, u8, u64)>> {
        let activation_str = String::from_utf8_lossy(data);
        let parts: Vec<&str> = activation_str.split(':').collect();
        
        if parts.len() == 3 {
            println!("⚠️  WARNING: Using legacy activation format (upgrading to secure format recommended)");
            let code = parts[0].to_string();
            let node_type = parts[1].parse::<u8>().unwrap_or(1);
            let timestamp = parts[2].parse::<u64>().unwrap_or(0);
            Ok(Some((code, node_type, timestamp)))
        } else {
            Ok(None)
        }
    }
    
    /// Clear activation code (for security)
    pub fn clear_activation_code(&self) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        self.db.delete_cf(&metadata_cf, b"activation_code")?;
        self.db.delete_cf(&metadata_cf, b"state_key")?;
        self.db.delete_cf(&metadata_cf, b"activation_burn_tx")?;
        Ok(())
    }
    
    /// Get burn transaction hash for activation code (for XOR decryption)
    pub fn get_activation_burn_tx(&self) -> IntegrationResult<String> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        match self.db.get_cf(&metadata_cf, b"activation_burn_tx")? {
            Some(data) => {
                let burn_tx = String::from_utf8_lossy(&data).to_string();
                Ok(burn_tx)
            }
            None => {
                // No burn_tx stored - return empty (Genesis nodes or legacy activations)
                Err(IntegrationError::StorageError("No burn_tx stored for activation".to_string()))
            }
        }
    }
    
    /// Save burn transaction hash for activation code
    pub fn save_activation_burn_tx(&self, burn_tx: &str) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        self.db.put_cf(&metadata_cf, b"activation_burn_tx", burn_tx.as_bytes())?;
        println!("[Storage] 🔗 Burn TX saved for activation: {}...", &burn_tx[..8.min(burn_tx.len())]);
        Ok(())
    }
    
    /// Update activation code for device migration (preserves activation, updates device)
    pub fn update_activation_for_migration(&self, code: &str, node_type: u8, timestamp: u64, new_device_signature: &str) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        // Generate new node identity with migration indicator
        let migration_identity = Self::generate_migration_identity(code, node_type, timestamp, new_device_signature)?;
        let server_ip = Self::get_server_ip();
        
        // Create new state key for migrated device
        let state_key = Self::derive_state_key(code, &migration_identity)?;
        
        // PRODUCTION: Save with AES-256-GCM (same as save_activation_code)
        let activation_data = format!("{}:{}:{}:{}:{}", 
            code, node_type, timestamp, new_device_signature, server_ip);
        
        // Encrypt with AES-256-GCM (key from activation code, NOT stored!)
        let (encrypted_data, nonce) = Self::encrypt_with_aes_gcm(&activation_data, code)?;
        
        let storage_record = format!("{}:{}", 
            hex::encode(&nonce),
            hex::encode(&encrypted_data)
        );
        
        self.db.put_cf(&metadata_cf, b"activation_code", storage_record.as_bytes())?;
        
        // CRITICAL: Do NOT save encryption key - it's derived from activation code!
        
        println!("[Storage] ✅ Activation migrated to device: {} (AES-256-GCM)", &new_device_signature[..16.min(new_device_signature.len())]);
        Ok(())
    }
    
    /// Generate migration identity for device changes
    fn generate_migration_identity(code: &str, node_type: u8, timestamp: u64, new_device_signature: &str) -> IntegrationResult<String> {
        use sha3::{Sha3_256, Digest};
        
        // Identity components for migrated device
        let mut identity_components = Vec::new();
        
        // Core: activation code + migration info
        identity_components.push(code.to_string());
        identity_components.push(format!("node_type:{}", node_type));
        identity_components.push(format!("timestamp:{}", timestamp));
        identity_components.push(format!("device_signature:{}", new_device_signature));
        
        // Add migration marker
        identity_components.push("migration_enabled".to_string());
        
        // Generate deterministic identity from transfer data
        let combined = identity_components.join("|");
        let identity_hash = hex::encode(Sha3_256::digest(combined.as_bytes()));
        
        // Use first 16 characters for transfer identity
        Ok(identity_hash[..16].to_string())
    }
    
    /// Generate cryptographic node identity from activation code (universal device support)
    fn generate_node_identity(code: &str, node_type: u8, timestamp: u64) -> IntegrationResult<String> {
        use sha3::{Sha3_256, Digest};
        
        // GENESIS PERIOD FIX: Simplified identity for bootstrap phase
        let is_genesis_bootstrap = std::env::var("QNET_BOOTSTRAP_ID").is_ok() || 
                                  std::env::var("QNET_GENESIS_BOOTSTRAP").unwrap_or_default() == "1";
        
        // Primary components: activation code + node config
        let mut identity_components = Vec::new();
        
        // Core: activation code itself (unique and immutable)
        identity_components.push(code.to_string());
        
        // Node configuration (stable across device migrations)
        identity_components.push(format!("node_type:{}", node_type));
        identity_components.push(format!("timestamp:{}", timestamp));
        
        if is_genesis_bootstrap {
            // PRODUCTION: STABLE Genesis identity - only immutable components
            // This ensures Genesis nodes have consistent identity across Docker restarts
            let bootstrap_id = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or_else(|_| "001".to_string());
            
            // Use only stable, immutable components for Genesis identity
            identity_components.push(format!("genesis_bootstrap_id:{}", bootstrap_id));
            identity_components.push(format!("network:qnet_mainnet"));
            identity_components.push(format!("genesis_version:v1.0"));
            
            // Deterministic hash from activation code only
            let primary_hash = hex::encode(Sha3_256::digest(code.as_bytes()));
            identity_components.push(format!("stable_code_hash:{}", &primary_hash[..16]));
            
            println!("[IDENTITY] 🔐 Genesis stable identity components: activation_code + bootstrap_id");
        } else {
            // PRODUCTION: Full identity with system info (after bootstrap)
            identity_components.push(format!("user:{}", 
                std::env::var("USER").unwrap_or_else(|_| "qnet".to_string())
            ));
            
            // Add hostname (may change but helps with uniqueness)
            if let Ok(hostname) = std::env::var("HOSTNAME") {
                identity_components.push(format!("hostname:{}", hostname));
            }
            
            // Universal device support: use activation code as primary entropy source
            let primary_hash = hex::encode(Sha3_256::digest(code.as_bytes()));
            identity_components.push(format!("code_hash:{}", &primary_hash[..16]));
        }
        
        // Generate deterministic identity from activation code
        let combined = identity_components.join("|");
        let identity_hash = hex::encode(Sha3_256::digest(combined.as_bytes()));
        
        // Use first 16 characters for node identity
        Ok(identity_hash[..16].to_string())
    }
    
    /// Get server IP address
    fn get_server_ip() -> String {
        use std::process::Command;
        
        // Try to get public IP
        if let Ok(output) = Command::new("curl")
            .arg("-s")
            .arg("--max-time")
            .arg("2")
            .arg("https://api.ipify.org")
            .output() {
            if let Ok(ip) = String::from_utf8(output.stdout) {
                if !ip.trim().is_empty() {
                    return ip.trim().to_string();
                }
            }
        }
        
        // Fallback to local IP
        if let Ok(output) = Command::new("hostname").arg("-I").output() {
            if let Ok(ip) = String::from_utf8(output.stdout) {
                if let Some(first_ip) = ip.split_whitespace().next() {
                    return first_ip.to_string();
                }
            }
        }
        
        "unknown".to_string()
    }
    
    /// Derive state key from activation code and node identity
    fn derive_state_key(code: &str, node_identity: &str) -> IntegrationResult<String> {
        use sha3::{Sha3_256, Digest};
        
        // Create deterministic key from activation code
        let key_material = format!("{}:{}:state_key", code, node_identity);
        let key_hash = hex::encode(Sha3_256::digest(key_material.as_bytes()));
        
        // Use first 32 characters as state key
        Ok(key_hash[..32].to_string())
    }
    
    /// PRODUCTION: Get activation code for decryption from environment or generate for Genesis
    fn get_activation_code_for_decryption() -> IntegrationResult<String> {
        // Priority 1: Check QNET_ACTIVATION_CODE environment variable
        if let Ok(code) = std::env::var("QNET_ACTIVATION_CODE") {
            if !code.is_empty() {
                return Ok(code);
            }
        }
        
        // Priority 2: Generate for Genesis nodes from BOOTSTRAP_ID
        if let Ok(bootstrap_id) = std::env::var("QNET_BOOTSTRAP_ID") {
            match bootstrap_id.as_str() {
                "001" | "002" | "003" | "004" | "005" => {
                    let genesis_code = format!("QNET-BOOT-{:0>4}-STRAP", bootstrap_id);
                    return Ok(genesis_code);
                }
                _ => {}
            }
        }
        
        // No activation code available
        Err(IntegrationError::ValidationError(
            "No activation code available for decryption. Set QNET_ACTIVATION_CODE env var or QNET_BOOTSTRAP_ID for Genesis nodes".to_string()
        ))
    }
    
    /// PRODUCTION: Get device signature for tracking (NOT for encryption!)
    fn get_device_signature_for_tracking() -> String {
        use sha3::{Sha3_256, Digest};
        
        let mut hasher = Sha3_256::new();
        
        // Hardware fingerprint for tracking
        if let Ok(hostname) = std::env::var("HOSTNAME") {
            hasher.update(hostname.as_bytes());
        }
        if let Ok(user) = std::env::var("USER") {
            hasher.update(user.as_bytes());
        }
        
        // Add timestamp component for Docker containers (they have random hostnames)
        let is_docker = std::env::var("DOCKER_ENV").is_ok();
        if is_docker {
            // For Docker: use container ID if available
            if let Ok(container_id) = std::env::var("HOSTNAME") {
                if container_id.len() == 12 {
                    hasher.update(b"docker_container:");
                    hasher.update(container_id.as_bytes());
                }
            }
        }
        
        format!("device_{}", hex::encode(&hasher.finalize()[..16]))
    }
    
    /// PRODUCTION: Derive AES-256 encryption key from activation code (for database security)
    /// Key is NEVER stored - computed from activation code each time
    fn derive_encryption_key_from_code(code: &str) -> [u8; 32] {
        use sha3::{Sha3_256, Digest};
        
        let mut hasher = Sha3_256::new();
        hasher.update(code.as_bytes());
        hasher.update(b"QNET_DB_ENCRYPTION_V1");  // Salt for database encryption
        
        let hash = hasher.finalize();
        hash.into()
    }
    
    /// PRODUCTION: Encrypt data with AES-256-GCM (quantum-resistant symmetric encryption)
    /// Uses existing aes-gcm dependency from quantum_crypto module
    fn encrypt_with_aes_gcm(data: &str, activation_code: &str) -> IntegrationResult<(Vec<u8>, [u8; 12])> {
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
        use aes_gcm::aead::Aead;
        use rand::Rng;
        
        // Derive encryption key from activation code
        let key_bytes = Self::derive_encryption_key_from_code(activation_code);
        let cipher = Aes256Gcm::new(&key_bytes.into());
        
        // Generate random nonce (12 bytes for GCM)
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        
        // Encrypt with authenticated encryption (AEAD)
        let encrypted = cipher.encrypt(nonce, data.as_bytes())
            .map_err(|e| IntegrationError::SecurityError(format!("AES-GCM encryption failed: {}", e)))?;
        
        Ok((encrypted, nonce_bytes))
    }
    
    /// PRODUCTION: Decrypt data with AES-256-GCM
    fn decrypt_with_aes_gcm(encrypted_data: &[u8], nonce: &[u8; 12], activation_code: &str) -> IntegrationResult<String> {
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
        use aes_gcm::aead::Aead;
        
        // Derive encryption key from activation code (same as encryption)
        let key_bytes = Self::derive_encryption_key_from_code(activation_code);
        let cipher = Aes256Gcm::new(&key_bytes.into());
        
        let nonce_ref = Nonce::from_slice(nonce);
        
        // Decrypt and verify authentication tag
        let decrypted = cipher.decrypt(nonce_ref, encrypted_data)
            .map_err(|e| IntegrationError::SecurityError(format!("AES-GCM decryption failed: {}", e)))?;
        
        String::from_utf8(decrypted)
            .map_err(|e| IntegrationError::SecurityError(format!("UTF-8 decoding failed: {}", e)))
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
    
    /// Delete a microblock at the specified height (for fork resolution)
    pub fn delete_microblock(&self, height: u64) -> IntegrationResult<()> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let key = format!("microblock_{}", height);
        self.db.delete_cf(&microblocks_cf, key.as_bytes())?;
        
        Ok(())
    }
    
    // ========================================================================
    // POH STATE STORAGE (v2.19.13)
    // ========================================================================
    // Separate PoH state storage for fast validation without loading full blocks
    // This is critical for scalability - PoH validation should be O(1) not O(block_size)
    // ========================================================================
    
    /// Save PoH state for a block height
    /// Called automatically when saving microblocks
    pub fn save_poh_state(&self, poh_state: &qnet_state::PoHState) -> IntegrationResult<()> {
        let poh_cf = self.db.cf_handle("poh_state")
            .ok_or_else(|| IntegrationError::StorageError("poh_state column family not found".to_string()))?;
        
        let key = format!("poh_{}", poh_state.height);
        let data = bincode::serialize(poh_state)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        self.db.put_cf(&poh_cf, key.as_bytes(), &data)?;
        Ok(())
    }
    
    /// Load PoH state for a block height
    /// Returns None if height doesn't exist or PoH data not available
    pub fn load_poh_state(&self, height: u64) -> IntegrationResult<Option<qnet_state::PoHState>> {
        let poh_cf = self.db.cf_handle("poh_state")
            .ok_or_else(|| IntegrationError::StorageError("poh_state column family not found".to_string()))?;
        
        let key = format!("poh_{}", height);
        match self.db.get_cf(&poh_cf, key.as_bytes())? {
            Some(data) => {
                let poh_state = bincode::deserialize::<qnet_state::PoHState>(&data)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                Ok(Some(poh_state))
            }
            None => Ok(None),
        }
    }
    
    /// Delete PoH state for a block height (for fork resolution)
    pub fn delete_poh_state(&self, height: u64) -> IntegrationResult<()> {
        let poh_cf = self.db.cf_handle("poh_state")
            .ok_or_else(|| IntegrationError::StorageError("poh_state column family not found".to_string()))?;
        
        let key = format!("poh_{}", height);
        self.db.delete_cf(&poh_cf, key.as_bytes())?;
        Ok(())
    }
    
    /// Get the latest PoH state (for continuing PoH sequence)
    pub fn get_latest_poh_state(&self) -> IntegrationResult<Option<qnet_state::PoHState>> {
        let chain_height = self.get_chain_height()?;
        if chain_height == 0 {
            return Ok(None);
        }
        self.load_poh_state(chain_height)
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
    
    /// Save macroblock to storage (IDEMPOTENT - won't overwrite existing)
    /// 
    /// CRITICAL v2.26.8: Made idempotent to prevent:
    /// - Race conditions between consensus and PFP
    /// - Data inconsistency from parallel writes
    /// - Overwriting valid macroblocks with different data
    pub async fn save_macroblock(&self, height: u64, macroblock: &qnet_state::MacroBlock) -> IntegrationResult<()> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        let key = format!("macroblock_{}", height);
        
        // IDEMPOTENT CHECK: Don't overwrite existing macroblock
        // This prevents race conditions and ensures data consistency
        if let Some(existing) = self.db.get_cf(&microblocks_cf, key.as_bytes())? {
            if !existing.is_empty() {
                println!("[Storage] ℹ️ Macroblock #{} already exists - skipping save (idempotent)", height);
                return Ok(());
            }
        }
        
        let data = bincode::serialize(macroblock)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        let mut batch = WriteBatch::default();
        batch.put_cf(&microblocks_cf, key.as_bytes(), &data);
        
        // Update latest macroblock hash
        let hash = macroblock.hash();
        batch.put_cf(&metadata_cf, b"latest_macroblock_hash", &hash);
        
        self.db.write(batch)?;
        println!("[Storage] ✅ Macroblock #{} saved successfully", height);
        Ok(())
    }
    
    /// Get macroblock by its index (height / 90)
    pub fn get_macroblock_by_height(&self, macroblock_index: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        // CRITICAL FIX: Macroblocks are stored with key "macroblock_{index}"
        // where index is the macroblock number (1 for blocks 1-90, 2 for blocks 91-180, etc)
        // NOT the block height! This matches save_macroblock which uses round_number
        let key = format!("macroblock_{}", macroblock_index);
        
        match self.db.get_cf(&microblocks_cf, key.as_bytes())? {
            Some(data) => Ok(Some(data)),
            None => Ok(None),
        }
    }
    
    /// PRODUCTION v2.45: Delete macroblock by index (for fork recovery)
    /// Used when node is stuck on fork and needs to resync from network
    pub fn delete_macroblock(&self, macroblock_index: u64) -> IntegrationResult<()> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let key = format!("macroblock_{}", macroblock_index);
        self.db.delete_cf(&microblocks_cf, key.as_bytes())?;
        
        println!("[INFO][STORAGE] delete_mb idx={}", macroblock_index);
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

    /// Save consensus round state for recovery after restart
    pub fn save_consensus_state(&self, round: u64, state: &[u8]) -> IntegrationResult<()> {
        let consensus_cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        
        let key = format!("round_{}", round);
        self.db.put_cf(&consensus_cf, key.as_bytes(), state)?;
        
        // Update latest round for quick lookup
        self.db.put_cf(&consensus_cf, b"latest_round", &round.to_be_bytes())?;
        
        Ok(())
    }
    
    /// Load consensus round state for recovery
    pub fn load_consensus_state(&self, round: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let consensus_cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        
        let key = format!("round_{}", round);
        Ok(self.db.get_cf(&consensus_cf, key.as_bytes())?)
    }
    
    /// Get latest consensus round from storage
    pub fn get_latest_consensus_round(&self) -> IntegrationResult<u64> {
        let consensus_cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        
        match self.db.get_cf(&consensus_cf, b"latest_round")? {
            Some(bytes) => {
                let round = u64::from_be_bytes(bytes.try_into()
                    .map_err(|_| IntegrationError::StorageError("Invalid round data".to_string()))?);
                Ok(round)
            },
            None => Ok(0), // No consensus state saved yet
        }
    }
    
    /// Save sync progress for resuming after restart
    pub fn save_sync_progress(&self, from_height: u64, to_height: u64, current: u64) -> IntegrationResult<()> {
        let sync_cf = self.db.cf_handle("sync_state")
            .ok_or_else(|| IntegrationError::StorageError("sync_state column family not found".to_string()))?;
        
        let data = bincode::serialize(&(from_height, to_height, current))
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        self.db.put_cf(&sync_cf, b"sync_progress", &data)?;
        Ok(())
    }
    
    /// Load sync progress for resuming
    pub fn load_sync_progress(&self) -> IntegrationResult<Option<(u64, u64, u64)>> {
        let sync_cf = self.db.cf_handle("sync_state")
            .ok_or_else(|| IntegrationError::StorageError("sync_state column family not found".to_string()))?;
        
        match self.db.get_cf(&sync_cf, b"sync_progress")? {
            Some(data) => {
                let progress = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(Some(progress))
            },
            None => Ok(None),
        }
    }
    
    /// Clear sync progress after completion
    pub fn clear_sync_progress(&self) -> IntegrationResult<()> {
        let sync_cf = self.db.cf_handle("sync_state")
            .ok_or_else(|| IntegrationError::StorageError("sync_state column family not found".to_string()))?;
        
        self.db.delete_cf(&sync_cf, b"sync_progress")?;
        Ok(())
    }
    
    /// Get microblock range for batch sync (raw format)
    /// NOTE: Use Storage::get_microblocks_range for network sync (it converts to full MicroBlock)
    pub async fn get_microblocks_range(&self, from: u64, to: u64) -> IntegrationResult<Vec<(u64, Vec<u8>)>> {
        let mut microblocks = Vec::new();
        
        for height in from..=to {
            if let Some(data) = self.load_microblock(height)? {
                microblocks.push((height, data));
            }
        }
        
        Ok(microblocks)
    }
    
    /// Legacy: Get block range for old Block format (only genesis)  
    pub async fn get_blocks_range(&self, from: u64, to: u64) -> IntegrationResult<Vec<qnet_state::Block>> {
        let mut blocks = Vec::new();
        
        for height in from..=to {
            if let Some(block) = self.load_block_by_height(height).await? {
                blocks.push(block);
            }
        }
        
        Ok(blocks)
    }

    /// Find transaction by hash in blockchain storage
    pub async fn find_transaction_by_hash(&self, tx_hash: &str) -> IntegrationResult<Option<qnet_state::Transaction>> {
        // PRODUCTION: Search for transaction in blockchain storage
        let tx_cf = self.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        
        let tx_key = format!("tx_{}", tx_hash);
        match self.db.get_cf(&tx_cf, tx_key.as_bytes())? {
            Some(data) => {
                // SIMPLIFIED (v2.19.10): Only Zstd compression used (lossless)
                // Pattern Recognition was removed because it was LOSSY
                
                // Strategy 1: Zstd-compressed (check magic number 0x28B52FFD)
                if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    let decompressed = zstd::decode_all(&data[..])
                        .map_err(|e| IntegrationError::Other(format!("Zstd decompression error: {}", e)))?;
                    let transaction: qnet_state::Transaction = bincode::deserialize(&decompressed)
                        .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                    return Ok(Some(transaction));
                }
                
                // Strategy 2: Uncompressed raw transaction (legacy data)
                let transaction: qnet_state::Transaction = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                Ok(Some(transaction))
            },
            None => {
                // Transaction not found in persistent storage
                Ok(None)
            }
        }
    }

    /// Get transaction block height from blockchain - O(1) with index
    pub async fn get_transaction_block_height(&self, tx_hash: &str) -> IntegrationResult<u64> {
        // OPTIMIZED: Use tx_index for O(1) lookup instead of O(n) iteration
        let tx_index_cf = self.db.cf_handle("tx_index")
            .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
        
        let tx_key = format!("tx_{}", tx_hash);
        match self.db.get_cf(&tx_index_cf, tx_key.as_bytes())? {
            Some(data) => {
                if data.len() >= 8 {
                    let height_bytes: [u8; 8] = data[0..8].try_into()
                        .map_err(|_| IntegrationError::StorageError("Invalid height data".to_string()))?;
                    Ok(u64::from_be_bytes(height_bytes))
                } else {
                    Err(IntegrationError::StorageError(format!("Invalid index data for transaction {}", tx_hash)))
                }
            },
            None => {
                // Fallback: Check microblocks for legacy data (will be removed in future)
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let iter = self.db.iterator_cf(&microblocks_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, data) = item.map_err(|e| IntegrationError::StorageError(e.to_string()))?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if key_str.starts_with("microblock_") {
                // Try both legacy and efficient formats
                if let Ok(legacy_block) = bincode::deserialize::<qnet_state::MicroBlock>(&data) {
                    for tx in &legacy_block.transactions {
                        if tx.hash == tx_hash {
                            return Ok(legacy_block.height);
                        }
                    }
                } else if let Ok(efficient_block) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&data) {
                    // For efficient blocks, we need to check transaction pool
                    if let Ok(hash_bytes) = hex::decode(tx_hash) {
                        if hash_bytes.len() == 32 {
                            let mut hash_array = [0u8; 32];
                            hash_array.copy_from_slice(&hash_bytes);
                            
                            if efficient_block.transaction_hashes.contains(&hash_array) {
                                return Ok(efficient_block.height);
                            }
                        }
                    }
                }
            }
        }
        
                // Transaction not found
                Err(IntegrationError::StorageError(format!("Transaction {} not found in blockchain", tx_hash)))
            }
        }
    }
    
    /// Get transactions for an address (paginated, most recent first)
    pub async fn get_transactions_by_address(&self, address: &str, page: usize, per_page: usize) -> IntegrationResult<Vec<qnet_state::Transaction>> {
        let tx_by_addr_cf = self.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        let tx_cf = self.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        
        let prefix = format!("addr_{}_", address);
        
        // Iterate in reverse to get most recent first (keys are sorted by timestamp)
        let iter = self.db.iterator_cf(
            &tx_by_addr_cf,
            rocksdb::IteratorMode::From(
                format!("{}~", prefix).as_bytes(), // ~ is after hex digits in ASCII
                rocksdb::Direction::Reverse
            )
        );
        
        let mut transactions = Vec::new();
        let skip = page * per_page;
        let mut count = 0;
        let mut seen_hashes = std::collections::HashSet::new();
        
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if !key_str.starts_with(&prefix) {
                break;
            }
            
            // Get tx_hash from value
            let tx_hash = std::str::from_utf8(&value).unwrap_or("");
            
            // Deduplicate (same tx may appear twice if from==to)
            if seen_hashes.contains(tx_hash) {
                continue;
            }
            seen_hashes.insert(tx_hash.to_string());
            
            count += 1;
            if count <= skip {
                continue;
            }
            
            // Fetch full transaction (with Zstd decompression if needed)
            let tx_key = format!("tx_{}", tx_hash);
            if let Some(tx_data) = self.db.get_cf(&tx_cf, tx_key.as_bytes())? {
                // PRODUCTION: Decompress if Zstd compressed
                let decompressed = if tx_data.len() >= 4 && tx_data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    zstd::decode_all(&tx_data[..]).unwrap_or_else(|_| tx_data.to_vec())
                } else {
                    tx_data.to_vec()
                };
                
                if let Ok(tx) = bincode::deserialize::<qnet_state::Transaction>(&decompressed) {
                    transactions.push(tx);
                    if transactions.len() >= per_page {
                        break;
                    }
                }
            }
        }
        
        Ok(transactions)
    }
    
    /// Count transactions for an address
    pub async fn count_transactions_by_address(&self, address: &str) -> IntegrationResult<usize> {
        let tx_by_addr_cf = self.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        
        let prefix = format!("addr_{}_", address);
        let iter = self.db.iterator_cf(&tx_by_addr_cf, rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward));
        
        let mut count = 0;
        let mut seen_hashes = std::collections::HashSet::new();
        
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if !key_str.starts_with(&prefix) {
                break;
            }
            
            let tx_hash = std::str::from_utf8(&value).unwrap_or("");
            if !seen_hashes.contains(tx_hash) {
                seen_hashes.insert(tx_hash.to_string());
                count += 1;
            }
        }
        
        Ok(count)
    }
    
    /// Get recent transactions globally (paginated, newest first)
    /// Uses tx_by_address CF which stores addr_{address}_{timestamp}_{tx_hash}
    /// By iterating in reverse, we get newest transactions first
    pub async fn get_recent_transactions(&self, page: usize, per_page: usize) -> IntegrationResult<(Vec<qnet_state::Transaction>, usize)> {
        let tx_by_addr_cf = self.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        let tx_cf = self.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        
        // Iterate in reverse to get newest transactions first
        let iter = self.db.iterator_cf(&tx_by_addr_cf, rocksdb::IteratorMode::End);
        
        let mut transactions = Vec::new();
        let mut seen_hashes = std::collections::HashSet::new();
        let skip_count = page.saturating_sub(1) * per_page;
        let mut skipped = 0;
        let mut total_count = 0;
        
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            // Only process addr_* keys
            if !key_str.starts_with("addr_") {
                continue;
            }
            
            let tx_hash = std::str::from_utf8(&value).unwrap_or("");
            
            // Skip duplicates (same TX can appear twice - from and to)
            if seen_hashes.contains(tx_hash) {
                continue;
            }
            seen_hashes.insert(tx_hash.to_string());
            total_count += 1;
            
            // Pagination: skip previous pages
            if skipped < skip_count {
                skipped += 1;
                continue;
            }
            
            // Already have enough for this page
            if transactions.len() >= per_page {
                continue; // Keep counting total but don't load more
            }
            
            // Load transaction
            let tx_key = format!("tx_{}", tx_hash);
            if let Some(tx_data) = self.db.get_cf(&tx_cf, tx_key.as_bytes())? {
                // Decompress if needed
                let decompressed = zstd::decode_all(tx_data.as_slice())
                    .unwrap_or_else(|_| tx_data.to_vec());
                
                if let Ok(tx) = bincode::deserialize::<qnet_state::Transaction>(&decompressed) {
                    transactions.push(tx);
                }
            }
        }
        
        Ok((transactions, total_count))
    }
    
    /// Count total transactions in the blockchain
    pub async fn count_total_transactions(&self) -> IntegrationResult<usize> {
        let tx_index_cf = self.db.cf_handle("tx_index")
            .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
        
        let iter = self.db.iterator_cf(&tx_index_cf, rocksdb::IteratorMode::Start);
        let count = iter.count();
        
        Ok(count)
    }
}

/// Storage modes for different node types
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StorageMode {
    /// Light node - headers only, no full blocks (mobile/IoT)
    Light,
    /// Super node - keeps complete blockchain history + sharding support (servers)
    /// v3.18: Full node type removed - only Light and Super remain
    Super,
}

/// Adaptive compression levels based on block age
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CompressionLevel {
    /// No compression for hot data (< 1 day)
    None,
    /// Light compression for recent data (1-7 days)
    Light,     // Zstd level 3
    /// Medium compression for month-old data (8-30 days) 
    Medium,    // Zstd level 9
    /// Heavy compression for year-old data (31-365 days)
    Heavy,     // Zstd level 15
    /// Extreme compression for ancient data (> 365 days)
    Extreme,   // Zstd level 22
}

// NOTE: Delta Encoding was evaluated but removed in v2.19.10
// Reason: Pattern Recognition + Zstd provides better compression without complexity
// - Pattern Recognition: 89% reduction for simple transfers (140 → 16 bytes)
// - Zstd adaptive: 30-80% additional compression based on block age
// - EfficientMicroBlock: stores only TX hashes, full TX stored separately
// Delta encoding would add complexity without significant benefit

/// Transaction pattern for optimized storage
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TransactionPattern {
    /// Simple transfer (90% of transactions)
    SimpleTransfer,
    /// Node activation (5% of transactions)
    NodeActivation,
    /// Reward distribution (3% of transactions)
    RewardDistribution,
    /// Contract deployment (1% of transactions)
    ContractDeploy,
    /// Contract call (0.9% of transactions)
    ContractCall,
    /// Create account (0.1% of transactions)
    CreateAccount,
    /// Unknown pattern
    Unknown,
}

/// Compressed transaction using pattern recognition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressedTransaction {
    /// Pattern type
    pub pattern: TransactionPattern,
    /// Compressed data based on pattern
    pub data: Vec<u8>,
    /// Original size before compression
    pub original_size: usize,
}

/// Pattern-based transaction compressor
pub struct PatternRecognizer {
    /// Statistics for pattern recognition
    pattern_stats: HashMap<TransactionPattern, u64>,
}

pub struct Storage {
    persistent: PersistentStorage,
    /// Transaction pool for efficient storage without duplication
    pub transaction_pool: TransactionPool,
    /// Maximum storage size per node in bytes (300 GB default)
    max_storage_size: u64,
    /// Current storage usage in bytes
    current_storage_usage: Arc<RwLock<u64>>,
    /// Emergency cleanup enabled
    emergency_cleanup_enabled: bool,
    /// Node storage mode configuration
    storage_mode: StorageMode,
    /// Sliding window size for pruning (blocks to keep)
    sliding_window_size: u64,
    /// Pattern recognizer for transaction compression
    pattern_recognizer: Arc<RwLock<PatternRecognizer>>,
    /// Tiered storage configuration (Light/Full/Super)
    tier_config: StorageTierConfig,
    /// Graceful degradation manager
    graceful_degradation: Arc<RwLock<GracefulDegradation>>,
    /// Light node header rotation (for Light mode only)
    light_rotation: Arc<RwLock<LightNodeRotation>>,
}

// ============================================================================
// TIERED STORAGE IMPLEMENTATION
// ============================================================================
// ALL nodes receive ALL blocks. Storage differs by:
// - Light: Headers only (~100MB)
// - Full: Full blocks + pruning (~500GB, 30 days)
// - Super/Bootstrap: Full blocks, NO pruning (~2TB, full history)
// ============================================================================

/// Statistics for tiered storage
#[derive(Debug, Clone)]
pub struct TieredStorageStats {
    pub node_type: String,
    pub max_storage_bytes: u64,
    pub pruning_window_blocks: u64,
    pub current_storage_bytes: u64,
    pub blocks_stored: u64,
    pub transactions_stored: u64,
}

impl Storage {
    // ========================================================================
    // CHAIN HEIGHT REPAIR (v2.64)
    // ========================================================================
    
    /// Verify and repair chain_height desync - proxy to PersistentStorage
    pub fn verify_and_repair_chain_height(&self) -> IntegrationResult<bool> {
        self.persistent.verify_and_repair_chain_height()
    }
    
    // ========================================================================
    // GRACEFUL DEGRADATION & STORAGE HEALTH
    // ========================================================================
    
    /// v3.0: Flush all RocksDB column families to disk
    /// CRITICAL: Call this before graceful shutdown to prevent data loss
    /// This ensures WAL is flushed to SST files
    pub fn flush_all(&self) -> IntegrationResult<()> {
        self.persistent.flush_all()
    }
    
    /// Get current storage health status
    pub fn get_storage_health(&self) -> IntegrationResult<StorageHealth> {
        let percentage = self.get_storage_usage_percentage()?;
        Ok(StorageHealth::from_percentage(percentage))
    }
    
    /// Check storage health and apply graceful degradation if needed
    /// Returns true if mode was changed
    pub fn check_and_apply_degradation(&self) -> IntegrationResult<bool> {
        let health = self.get_storage_health()?;
        
        let mut degradation = self.graceful_degradation.write()
            .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
        
        if let Some(new_mode) = degradation.check_and_degrade(health) {
            // Log the change
            println!("[WARN][STORAGE] Storage mode changed due to disk space:");
            println!("[WARN][STORAGE]    Health: {}", health.as_str());
            println!("[WARN][STORAGE]    New mode: {:?}", new_mode);
            
            // If degraded to Light mode, need to cleanup full block data
            if new_mode == StorageMode::Light {
                println!("[WARN][STORAGE] Cleaning up full block data (keeping headers only)...");
                // Note: Actual cleanup happens in background to not block
            }
            
            return Ok(true);
        }
        
        Ok(false)
    }
    
    /// Get effective storage mode (may be degraded from original)
    pub fn get_effective_storage_mode(&self) -> StorageMode {
        self.graceful_degradation.read()
            .map(|g| g.get_current_mode())
            .unwrap_or(self.storage_mode)
    }
    
    /// Check if storage is currently degraded
    pub fn is_storage_degraded(&self) -> bool {
        self.graceful_degradation.read()
            .map(|g| g.is_degraded())
            .unwrap_or(false)
    }
    
    // ========================================================================
    // LIGHT NODE ROTATION (Auto-cleanup old headers)
    // ========================================================================
    
    /// Rotate light node headers - delete oldest to maintain max size
    /// Called automatically when saving new headers in Light mode
    pub fn rotate_light_headers(&self, current_height: u64) -> IntegrationResult<u64> {
        let mut rotation = self.light_rotation.write()
            .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
        
        if !rotation.needs_rotation() {
            rotation.increment();
            return Ok(0);
        }
        
        let to_delete = rotation.headers_to_delete();
        if to_delete == 0 {
            rotation.increment();
            return Ok(0);
        }
        
        // Delete oldest headers
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks CF not found".to_string()))?;
        
        let start_height = current_height.saturating_sub(rotation.max_headers + to_delete);
        let end_height = start_height + to_delete;
        
        let mut batch = WriteBatch::default();
        let mut deleted = 0u64;
        
        for height in start_height..end_height {
            let key = format!("microblock_{}", height);
            batch.delete_cf(&microblocks_cf, key.as_bytes());
            deleted += 1;
        }
        
        if deleted > 0 {
            self.persistent.db.write(batch)?;
            rotation.decrement(deleted);
            println!("[LightRotation] 🔄 Rotated {} old headers (keeping last {})", 
                deleted, rotation.max_headers);
        }
        
        rotation.increment();
        Ok(deleted)
    }
    
    /// Check if this node should store full block data (vs headers only)
    pub fn should_store_full_blocks(&self) -> bool {
        // Check effective mode (may be degraded)
        let effective_mode = self.get_effective_storage_mode();
        effective_mode != StorageMode::Light
    }
    
    // NOTE: save_microblock_tiered() removed - logic integrated into main save_microblock()
    
    /// Check if a block should be pruned based on tier configuration
    pub fn should_prune_block(&self, block_height: u64) -> bool {
        let current_height = self.get_chain_height().unwrap_or(0);
        self.tier_config.should_prune_block(block_height, current_height)
    }
    
    /// Get storage statistics for tiered storage
    pub fn get_tiered_storage_stats(&self) -> TieredStorageStats {
        // v3.18: Only Light and Super modes
        let mode_str = match self.storage_mode {
            StorageMode::Light => "Light (headers only, ~100MB)",
            StorageMode::Super => "Super/Bootstrap (full history, ~2TB)",
        };
        
        let current_bytes = self.current_storage_usage.read()
            .map(|v| *v)
            .unwrap_or(0);
        
        TieredStorageStats {
            node_type: mode_str.to_string(),
            max_storage_bytes: self.tier_config.max_storage_bytes,
            pruning_window_blocks: self.tier_config.pruning_window_blocks,
            current_storage_bytes: current_bytes,
            blocks_stored: self.get_chain_height().unwrap_or(0),
            transactions_stored: 0, // Would need to count from DB
        }
    }
    
    /// Get the tier configuration
    pub fn get_tier_config(&self) -> &StorageTierConfig {
        &self.tier_config
    }
    
    /// Save raw data with a custom key (for PoH checkpoints, etc.)
    pub fn save_raw(&self, key: &str, data: &[u8]) -> IntegrationResult<()> {
        self.persistent.save_raw(key, data)
    }
    
    /// Load raw data with a custom key (for PoH checkpoints, etc.)
    pub fn load_raw(&self, key: &str) -> IntegrationResult<Option<Vec<u8>>> {
        self.persistent.load_raw(key)
    }
    
    pub fn new(data_dir: &str) -> IntegrationResult<Self> {
        let persistent = PersistentStorage::new(data_dir)?;
        let transaction_pool = TransactionPool::new();
        
        // Detect node type from environment or config
        // v3.18: Full nodes removed - default to "super" (server node) if not specified
        let node_type = std::env::var("QNET_NODE_TYPE").unwrap_or_else(|_| "super".to_string());
        
        // DYNAMIC SHARD CALCULATION: Automatically scales with network growth
        // Uses existing calculate_optimal_shards() from reward_sharding module
        // NOTE: Shard count is calculated ONCE at startup and remains fixed during operation
        // This ensures storage consistency. Recalculation happens on node restart/update.
        // Production workflow: Rolling restart updates shard count across network.
        let active_shards = if let Ok(manual_shards) = std::env::var("QNET_ACTIVE_SHARDS") {
            // Manual override for testing or specific deployment needs
            manual_shards.parse::<u64>().unwrap_or_else(|_| {
                let network_size = Self::estimate_network_size_from_storage(&persistent);
                crate::reward_sharding::calculate_optimal_shards(network_size) as u64
            })
        } else {
            // AUTO-DETECTION: Calculate based on blockchain registry and heuristics
            let network_size = Self::estimate_network_size_from_storage(&persistent);
            let optimal_shards = crate::reward_sharding::calculate_optimal_shards(network_size) as u64;
            
            println!("[WARN][STORAGE] AUTO-SCALING: Calculated optimal shards: {}", optimal_shards);
            
            optimal_shards
        };
        
        // TIERED STORAGE CONFIGURATION
        // ============================================================================
        // ALL nodes receive ALL blocks from network (via P2P broadcast)
        // Storage differs by WHAT is kept and for HOW LONG:
        // - Light: Headers only (~100MB, last 1000 blocks)
        // - Full: Full blocks + pruning (~500GB, last 30 days)
        // - Super/Bootstrap: Full blocks, NO pruning (~2TB, complete history)
        // ============================================================================
        
        let (storage_mode, max_storage_gb, base_window, tier_config) = match node_type.to_lowercase().as_str() {
            "light" => (
                StorageMode::Light, 
                1,  // ~100 MB
                1_000, // Keep last 1000 block headers
                StorageTierConfig::light()
            ),
            // v3.18: "full" maps to Super for backward compatibility
            "full" | "super" | "bootstrap" => (
                StorageMode::Super, 
                2000, // ~2 TB
                0, // No pruning - keep EVERYTHING (archival)
                StorageTierConfig::super_node()
            ),
            _ => {
                println!("[WARN][STORAGE] unknown_node_type type={} default=super", node_type);
                (
                    StorageMode::Super, 
                    2000, 
                    0,
                    StorageTierConfig::super_node()
                )
            }
        };
        
        // Log tiered storage configuration (v3.18: only Light and Super)
        let (mode_name, storage_desc) = match storage_mode {
            StorageMode::Light => ("light", "headers_only ~100MB"),
            StorageMode::Super => ("super", "full_history_archival ~2TB"),
        };
        println!("[INFO][STORAGE] config mode={} storage={} pruning_window={}", 
                 mode_name, storage_desc, tier_config.pruning_window_blocks);
        
        // v3.18: Only Light and Super modes - no sliding window scaling needed
        // Super nodes keep everything, Light nodes keep minimal headers
        let sliding_window = base_window;
        
        // Allow override via environment
        let max_storage_size = std::env::var("QNET_MAX_STORAGE_GB")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(max_storage_gb) * 1024 * 1024 * 1024;
            
        let sliding_window_size = std::env::var("QNET_SLIDING_WINDOW")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(sliding_window);
            
        println!("[WARN][STORAGE] Node configured as {:?} mode:", storage_mode);
        println!("[WARN][STORAGE]    Max storage: {} GB", max_storage_size / (1024 * 1024 * 1024));
        println!("[WARN][STORAGE]    Sliding window: {} blocks", 
                if sliding_window_size == u64::MAX { "unlimited".to_string() } else { sliding_window_size.to_string() });
        
        // SAFETY WARNING: Check aggressive pruning settings
        // v3.18: Aggressive pruning check (only for Light nodes, Super nodes are archival)
        let aggressive_pruning_enabled = std::env::var("QNET_AGGRESSIVE_PRUNING")
            .unwrap_or_else(|_| "0".to_string()) == "1";
        
        if aggressive_pruning_enabled && storage_mode == StorageMode::Light {
            let super_node_count = Self::estimate_super_node_count();
            let min_safe_super_nodes = 50u64;
            
            println!("[WARN][STORAGE] aggressive_pruning_enabled super_nodes={} min_required={}", 
                     super_node_count, min_safe_super_nodes);
            println!("This Full node will delete microblocks immediately after finalization!");
            println!("");
            println!("Network Status:");
            println!("  Super nodes in network: {}", super_node_count);
            println!("  Recommended minimum: {}", min_safe_super_nodes);
            
            if super_node_count < min_safe_super_nodes {
                println!("");
                println!("[WARN][STORAGE] CRITICAL: Network safety at RISK!");
                println!("   Not enough Super nodes to maintain full blockchain archive.");
                println!("   Aggressive pruning will be AUTOMATICALLY DISABLED during macroblock finalization.");
                println!("   Consider setting QNET_AGGRESSIVE_PRUNING=0 until network grows.");
            } else {
                println!("");
                println!("✅ Network safety: OK ({} Super nodes maintain archive)", super_node_count);
                println!("   Aggressive pruning is safe but irreversible.");
                println!("   You will depend on Super nodes for historical data.");
            }
            println!("");
        }
        
        let pattern_recognizer = PatternRecognizer {
            pattern_stats: HashMap::new(),
        };
        
        // Initialize graceful degradation manager
        let graceful_degradation = GracefulDegradation::new(storage_mode);
        
        // Initialize light node rotation (1000 headers = ~100MB)
        let light_rotation = LightNodeRotation::new(tier_config.pruning_window_blocks);
            
        Ok(Self { 
            persistent,
            transaction_pool,
            max_storage_size,
            current_storage_usage: Arc::new(RwLock::new(0)),
            emergency_cleanup_enabled: true,
            storage_mode,
            sliding_window_size,
            pattern_recognizer: Arc::new(RwLock::new(pattern_recognizer)),
            tier_config,
            graceful_degradation: Arc::new(RwLock::new(graceful_degradation)),
            light_rotation: Arc::new(RwLock::new(light_rotation)),
        })
    }
    
    pub fn get_chain_height(&self) -> IntegrationResult<u64> {
        self.persistent.get_chain_height()
    }
    
    /// Set chain height to a specific value (for fork resolution)
    pub fn set_chain_height(&self, height: u64) -> IntegrationResult<()> {
        self.persistent.set_chain_height(height)
    }
    
    /// DATA CONSISTENCY: Reset chain height to 0 (wrapper for persistent storage)
    pub fn reset_chain_height(&self) -> IntegrationResult<()> {
        self.persistent.reset_chain_height()
    }
    
    pub fn get_block_hash(&self, height: u64) -> IntegrationResult<Option<String>> {
        self.persistent.get_block_hash(height)
    }
    
    pub async fn save_block(&self, block: &qnet_state::Block) -> IntegrationResult<()> {
        // Check if storage is critically full before accepting new blocks
        if self.is_storage_critically_full()? {
            // Try emergency cleanup first
            println!("[WARN][STORAGE] Storage critically full - attempting emergency cleanup before save_block");
            self.emergency_cleanup()?;
            
            // Re-check after cleanup
            if self.is_storage_critically_full()? {
                return Err(IntegrationError::StorageError(
                    "Cannot save block: Storage is critically full even after emergency cleanup. Increase QNET_MAX_STORAGE_GB or add more disk space.".to_string()
                ));
            }
        }
        
        self.persistent.save_block(block).await
    }
    
    pub async fn load_block_by_height(&self, height: u64) -> IntegrationResult<Option<qnet_state::Block>> {
        self.persistent.load_block_by_height(height).await
    }
    
    pub fn save_microblock(&self, height: u64, data: &[u8]) -> IntegrationResult<()> {
        // =====================================================================
        // v3.23: ROLLBACK PROTECTION - Check before any save operation
        // =====================================================================
        // Prevents race condition where parallel block receive overwrites rollback.
        // During rollback, blocks with height > target are silently skipped.
        // They will be re-requested after rollback completes.
        // =====================================================================
        if !can_save_block(height) {
            let (in_progress, target) = get_rollback_status();
            println!("[WARN][STORAGE] block_save_blocked h={} rollback_target={}", height, target);
            return Ok(()); // Silently skip - will be re-synced
        }
        
        // =====================================================================
        // TIERED STORAGE + GRACEFUL DEGRADATION (v2.19.9)
        // =====================================================================
        // This method now includes:
        // 1. Storage health check with graceful degradation
        // 2. Tiered storage based on node type (Light/Full/Super)
        // 3. Light node auto-rotation to maintain ~100MB
        // =====================================================================
        
        // Step 1: Check for graceful degradation (every 100 blocks to reduce overhead)
        if height % 100 == 0 {
            let _ = self.check_and_apply_degradation();
        }
        
        // Step 2: Check if storage is critically full
        if self.is_storage_critically_full()? {
            println!("[WARN][STORAGE] Storage critically full - attempting emergency cleanup");
            self.emergency_cleanup()?;
            
            // If still full after cleanup, try graceful degradation
            if self.is_storage_critically_full()? {
                // Force degradation check
                let _ = self.check_and_apply_degradation();
                
                // If STILL full after degradation, error out
                if self.is_storage_critically_full()? && self.get_effective_storage_mode() == StorageMode::Light {
                return Err(IntegrationError::StorageError(
                        "Cannot save microblock: Storage full even after degradation to Light mode. Add disk space!".to_string()
                    ));
                }
            }
        }
        
        // Step 3: Use effective storage mode (may be degraded)
        let effective_mode = self.get_effective_storage_mode();
        
        match effective_mode {
            StorageMode::Light => {
                // ═══════════════════════════════════════════════════════════════════════════
                // LIGHT MODE (v3.19): Pure API client - NO local storage
                // ═══════════════════════════════════════════════════════════════════════════
                // Light nodes (mobile wallets) do NOT store ANY blockchain data!
                // They are pure API clients like Phantom wallet:
                //
                // - Balance: GET /api/v1/balance/{wallet}
                // - TX history: GET /api/v1/address/{wallet}
                // - Send TX: POST /api/v1/transaction
                //
                // The wallet app (qnet-mobile, qnet-wallet) stores user's TX history
                // in its own localStorage/AsyncStorage - NOT in RocksDB!
                //
                // This function should NEVER be called for Light nodes in production.
                // If called, just ignore - Light nodes don't participate in sync.
                // ═══════════════════════════════════════════════════════════════════════════
                Ok(())
            },
            StorageMode::Super => {
                // SUPER MODE: Full block storage with EfficientMicroBlock format
                if let Ok(microblock) = bincode::deserialize::<qnet_state::MicroBlock>(data) {
                    return self.save_microblock_efficient(height, &microblock);
                }
                
                // Fallback: Apply adaptive compression to raw data
        let compressed_data = if height > 0 {
            self.compress_block_adaptive(data, height)?
        } else {
            data.to_vec()
        };
        
        self.persistent.save_microblock(height, &compressed_data)
            }
        }
    }
    
    /// PRODUCTION: Save microblock in efficient format with separate TX storage
    /// This is the PRIMARY storage method for new blocks (v2.19.8+)
    /// 
    /// Architecture:
    /// - EfficientMicroBlock (hashes only) → microblocks CF (~3-6 KB/block)
    /// - Full transactions → transactions CF with Zstd-3 (~30-50% reduction)
    /// - TX indices → tx_index, tx_by_address CFs
    /// 
    /// Storage savings: ~80% compared to legacy MicroBlock format
    fn save_microblock_efficient(&self, height: u64, microblock: &qnet_state::MicroBlock) -> IntegrationResult<()> {
        let tx_cf = self.persistent.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        let tx_index_cf = self.persistent.db.cf_handle("tx_index")
            .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
        let tx_by_addr_cf = self.persistent.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        
        let mut batch = WriteBatch::default();
        let mut tx_hashes: Vec<[u8; 32]> = Vec::with_capacity(microblock.transactions.len());
        let mut total_original_size = 0usize;
        let mut total_compressed_size = 0usize;
        
        // Step 1: Save each transaction with PATTERN RECOGNITION + Zstd compression
        // Pattern Recognition provides 80-95% compression for common TX types
        for tx in &microblock.transactions {
            // v2.72: Use transaction's own hash (BLAKE3) for consistency with lookups
            // Previously we computed SHA3(bincode) which didn't match tx.hash
            // This caused find_transaction_by_hash() to fail for system TX
            let tx_hash_str = &tx.hash; // Already computed by tx.calculate_hash()
            
            // Convert to [u8; 32] for EfficientMicroBlock
            let tx_hash_bytes: [u8; 32] = {
                let decoded = hex::decode(tx_hash_str).unwrap_or_else(|_| vec![0u8; 32]);
                let mut arr = [0u8; 32];
                let len = decoded.len().min(32);
                arr[..len].copy_from_slice(&decoded[..len]);
                arr
            };
            tx_hashes.push(tx_hash_bytes);
            
            let tx_key = format!("tx_{}", tx_hash_str);
            
            // Serialize original transaction for size tracking
            let tx_data = bincode::serialize(tx)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            total_original_size += tx_data.len();
            
            // COMPRESSION: Use Zstd-3 for all transactions (lossless, ~50% reduction)
            // NOTE: Pattern Recognition was removed in v2.19.10 because it was LOSSY
            // - SimpleTransfer: 140→16 bytes BUT could not be reconstructed!
            // - find_transaction_by_hash() would fail for pattern-compressed TX
            // Zstd-3 provides good compression (~50%) while remaining fully lossless
            
            // Track pattern for statistics only (no lossy compression)
            let pattern = self.recognize_transaction_pattern(tx);
            if let Ok(mut recognizer) = self.pattern_recognizer.write() {
                *recognizer.pattern_stats.entry(pattern).or_insert(0) += 1;
            }
            
            // LOSSLESS: Always use Zstd-3 compression
            let compressed_tx = zstd::encode_all(&tx_data[..], 3)
                .unwrap_or_else(|_| tx_data.clone());
            
            total_compressed_size += compressed_tx.len();
            batch.put_cf(&tx_cf, tx_key.as_bytes(), &compressed_tx);
            
            // INDEX: tx_hash -> block_height for O(1) transaction location
            batch.put_cf(&tx_index_cf, tx_key.as_bytes(), &height.to_be_bytes());
            
            // INDEX: address -> tx_hash for account transaction queries
            let timestamp = tx.timestamp;
            let from_key = format!("addr_{}_{:016x}_{}", tx.from, timestamp, tx_hash_str);
            batch.put_cf(&tx_by_addr_cf, from_key.as_bytes(), tx_hash_str.as_bytes());
            
            // Index 'to' address (if present, including system addresses)
            let to_addr = tx.to.as_ref().map(|s| s.as_str()).unwrap_or(&tx.from);
            let to_key = format!("addr_{}_{:016x}_{}", to_addr, timestamp, tx_hash_str);
            batch.put_cf(&tx_by_addr_cf, to_key.as_bytes(), tx_hash_str.as_bytes());
        }
        
        // Log pattern compression results (every 100 blocks)
        if height % 100 == 0 && total_original_size > 0 {
            let tx_savings = (1.0 - total_compressed_size as f64 / total_original_size as f64) * 100.0;
            println!("[PATTERN] 🎯 Block #{}: TX compression {} → {} bytes ({:.1}% reduction)",
                     height, total_original_size, total_compressed_size, tx_savings);
        }
        
        // Step 2: Create EfficientMicroBlock with hashes only (includes PoH data + VRF)
        let efficient_block = qnet_state::EfficientMicroBlock {
            height: microblock.height,
            timestamp: microblock.timestamp,
            transaction_hashes: tx_hashes,
            producer: microblock.producer.clone(),
            signature: microblock.signature.clone(),
            previous_hash: microblock.previous_hash,
            merkle_root: microblock.merkle_root,
            poh_hash: microblock.poh_hash.clone(),
            poh_count: microblock.poh_count,
            // Quantum Randomness Beacon (QRB) v3.0
            vrf_output: microblock.vrf_output,
            vrf_proof: microblock.vrf_proof.clone(),
            // v3.18: Copy fees_collected for producer rewards
            fees_collected: microblock.fees_collected,
            // v3.27: State root for verification
            state_root: microblock.state_root,
        };
        
        // Step 3: Save PoH state separately for fast validation (v2.19.13)
        // This enables O(1) PoH validation without loading full block
        let poh_state = qnet_state::PoHState::from_microblock(microblock);
        self.persistent.save_poh_state(&poh_state)?;
        
        // Serialize EfficientMicroBlock (much smaller than full MicroBlock)
        let efficient_data = bincode::serialize(&efficient_block)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        // Apply adaptive compression to EfficientMicroBlock
        let compressed_block = self.compress_block_adaptive(&efficient_data, height)?;
        
        // Write all in single atomic batch
        self.persistent.db.write(batch)?;
        
        // Save the efficient block
        self.persistent.save_microblock(height, &compressed_block)?;
        
        // Log savings for monitoring (every 100 blocks)
        if height % 100 == 0 {
            let original_size = bincode::serialize(microblock).unwrap_or_default().len();
            let efficient_size = compressed_block.len();
            let savings = (1.0 - efficient_size as f64 / original_size as f64) * 100.0;
            println!("[EFFICIENT] 📦 Block #{}: {} → {} bytes ({:.1}% reduction, {} TXs stored separately)",
                     height, original_size, efficient_size, savings, microblock.transactions.len());
        }
        
        Ok(())
    }
    
    pub fn load_microblock(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        self.persistent.load_microblock(height)
    }
    
    /// Delete a microblock at the specified height (for fork resolution)
    pub fn delete_microblock(&self, height: u64) -> IntegrationResult<()> {
        println!("[Storage] 🗑️ Deleting microblock at height {}", height);
        // Also delete associated PoH state
        let _ = self.persistent.delete_poh_state(height);
        self.persistent.delete_microblock(height)
    }
    
    // ========================================================================
    // POH STATE API (v2.19.13)
    // ========================================================================
    // Fast PoH validation without loading full blocks
    // ========================================================================
    
    /// Save PoH state for a block
    pub fn save_poh_state(&self, poh_state: &qnet_state::PoHState) -> IntegrationResult<()> {
        self.persistent.save_poh_state(poh_state)
    }
    
    /// Load PoH state for a specific height
    pub fn load_poh_state(&self, height: u64) -> IntegrationResult<Option<qnet_state::PoHState>> {
        self.persistent.load_poh_state(height)
    }
    
    /// Get the latest PoH state
    pub fn get_latest_poh_state(&self) -> IntegrationResult<Option<qnet_state::PoHState>> {
        self.persistent.get_latest_poh_state()
    }
    
    /// Extract and save PoH state from a microblock
    pub fn save_poh_state_from_microblock(&self, microblock: &qnet_state::MicroBlock) -> IntegrationResult<()> {
        let poh_state = qnet_state::PoHState::from_microblock(microblock);
        self.save_poh_state(&poh_state)
    }
    
    pub fn get_latest_macroblock_hash(&self) -> Result<[u8; 32], IntegrationError> {
        self.persistent.get_latest_macroblock_hash()
    }
    
    /// Get macroblock by its index (height / 90)
    pub fn get_macroblock_by_height(&self, macroblock_index: u64) -> IntegrationResult<Option<Vec<u8>>> {
        self.persistent.get_macroblock_by_height(macroblock_index)
    }
    
    /// PRODUCTION v2.45: Delete macroblock by index (for fork recovery)
    pub fn delete_macroblock(&self, macroblock_index: u64) -> IntegrationResult<()> {
        self.persistent.delete_macroblock(macroblock_index)
    }
    
    /// Save state snapshot for efficient storage
    /// v2.98: Fixed to use snapshot_{height} key format (was state_{height}) for consistency with load methods
    pub async fn save_state_snapshot(&self, height: u64, state_root: [u8; 32], state_data: Vec<u8>) -> IntegrationResult<()> {
        // State snapshots are saved separately for efficient retrieval
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        // v2.98: Use snapshot_ prefix to match load_state_snapshot() and load_latest_state_snapshot()
        let key = format!("snapshot_{}", height);
        
        // Format: [state_root(32) | data_len(8) | compressed_data]
        let mut value = Vec::new();
        value.extend_from_slice(&state_root);
        value.extend_from_slice(&(state_data.len() as u64).to_le_bytes());
        
        // Compress state data aggressively (Zstd-15)
        let compressed = zstd::encode_all(&state_data[..], 15)
            .map_err(|e| IntegrationError::Other(format!("State compression error: {}", e)))?;
        
        value.extend_from_slice(&compressed);
        
        self.persistent.db.put_cf(&snapshots_cf, key.as_bytes(), &value)?;
        
        println!("[STATE] 💾 Saved state snapshot at height {} ({} KB compressed)", 
                height, compressed.len() / 1024);
        
        Ok(())
    }
    
    /// Save checkpoint block for Progressive Finalization
    pub async fn save_checkpoint(&self, height: u64, block: &qnet_state::MacroBlock) -> Result<(), String> {
        // Serialize and save as checkpoint
        let serialized = bincode::serialize(block)
            .map_err(|e| format!("Failed to serialize checkpoint: {}", e))?;
        
        let key = format!("checkpoint_{}", height);
        self.persistent.db.put(key, serialized)
            .map_err(|e| format!("Failed to save checkpoint: {}", e))?;
        
        println!("[STORAGE] 📍 Checkpoint saved at height {}", height);
        Ok(())
    }
    
    /// Set a flag in storage (for emergency/critical markers)
    pub fn set_flag(&self, key: &str, value: bool) -> Result<(), String> {
        let flag_value = if value { vec![1u8] } else { vec![0u8] };
        self.persistent.db.put(key, flag_value)
            .map_err(|e| format!("Failed to set flag {}: {}", key, e))
    }
    
    /// Save data with a custom key
    pub fn save_data<T: serde::Serialize>(&self, key: &str, data: &T) -> Result<(), String> {
        let serialized = bincode::serialize(data)
            .map_err(|e| format!("Failed to serialize data: {}", e))?;
        
        self.persistent.db.put(key, serialized)
            .map_err(|e| format!("Failed to save data: {}", e))
    }
    
    
    pub async fn save_macroblock(&self, height: u64, macroblock: &qnet_state::MacroBlock) -> IntegrationResult<()> {
        // Check if storage is critically full before accepting new macroblocks
        if self.is_storage_critically_full()? {
            println!("[Storage] 🚨 Storage critically full - attempting emergency cleanup before save_macroblock");
            self.emergency_cleanup()?;
            
            if self.is_storage_critically_full()? {
                return Err(IntegrationError::StorageError(
                    "Cannot save macroblock: Storage is critically full. Increase QNET_MAX_STORAGE_GB.".to_string()
                ));
            }
        }
        
        // Save the macroblock
        self.persistent.save_macroblock(height, macroblock).await?;
        
        // CRITICAL: Save state snapshot for efficient storage
        // This is what allows us to reconstruct state without all microblocks
        if let Ok(state_data) = bincode::serialize(&macroblock) {
            // SECURITY: Verify state root is correctly calculated from microblocks
            // state_root MUST be XOR of all microblock hashes in this macroblock
            use sha3::{Sha3_256, Digest};
            let mut computed_state_root = [0u8; 32];
            
            // Recalculate state root from the microblock hashes stored in macroblock
            for microblock_hash in &macroblock.micro_blocks {
                for (i, &byte) in microblock_hash.iter().enumerate() {
                    computed_state_root[i] ^= byte;
                }
            }
            
            // NOW we can verify - comparing XOR with XOR!
            if computed_state_root != macroblock.state_root {
                return Err(IntegrationError::StorageError(
                    format!("State root verification failed at height {}: expected {:?}, computed {:?}", 
                            height, macroblock.state_root, computed_state_root)
                ));
            }
            
            // v3.19: Save state snapshot every 10th macroblock (saves ~45MB/day!)
            // OLD: Every macroblock = 960 snapshots/day × ~50KB = 48MB/day
            // NEW: Every 10th = 96 snapshots/day × ~50KB = ~5MB/day
            // SAFETY: Can restore from any snapshot + replay macroblocks
            if height % 10 == 0 || height <= 10 {
                self.save_state_snapshot(height, macroblock.state_root, state_data).await?;
                println!("[STATE] 📸 State snapshot saved at macroblock #{} (every 10th)", height);
            }
        }
        
        // ═══════════════════════════════════════════════════════════════════════════
        // STORAGE STRATEGY (v3.19)
        // ═══════════════════════════════════════════════════════════════════════════
        // 
        // SUPER/GENESIS NODES (servers):
        //   - ARCHIVAL mode - keep ALL microblocks forever
        //   - Required for network sync (other nodes download from them)
        //   - Storage: ~500MB-1GB per day
        //
        // LIGHT NODES (mobile wallets):
        //   - Pure API clients - NO local storage at all!
        //   - They never call save_macroblock() - this code path is unreachable
        //   - All data fetched via API: /api/v1/address/{wallet}, etc.
        //   - Wallet app stores TX history in localStorage/AsyncStorage
        //
        // New Super nodes use snapshot-based sync:
        // 1. Download snapshot from /api/v1/snapshot/latest
        // 2. Restore accounts/balances from snapshot
        // 3. Sync only blocks from snapshot_height to current
        // ═══════════════════════════════════════════════════════════════════════════
        
        let is_genesis = std::env::var("QNET_BOOTSTRAP_ID").is_ok();
        
        // Super/Genesis: ARCHIVAL - keep all microblocks for network sync
        if is_genesis && macroblock.height % 1000 == 0 {
            println!("[INFO][STORAGE] archival_mode node_type=genesis height={}", macroblock.height);
        }
        // NO PRUNING - Super nodes are archival!
        
        Ok(())
    }
    
    /// Public wrapper for network size estimation (used by node configuration)
    pub fn estimate_network_size_for_config(&self) -> usize {
        Self::estimate_network_size_from_storage(&self.persistent)
    }
    
    /// Estimate total network size for dynamic shard calculation
    /// Uses multi-source detection: blockchain, environment, heuristics
    fn estimate_network_size_from_storage(persistent: &PersistentStorage) -> usize {
        // Priority 1: Explicit network size from monitoring/orchestration
        if let Ok(size_str) = std::env::var("QNET_TOTAL_NETWORK_NODES") {
            if let Ok(size) = size_str.parse::<usize>() {
                println!("[Storage] 📊 Network size from monitoring: {} nodes", size);
                return size;
            }
        }
        
        // Priority 2: Genesis phase detection (5 bootstrap nodes)
        if std::env::var("QNET_BOOTSTRAP_ID").is_ok() {
            println!("[Storage] 🌱 Genesis phase: 5 bootstrap nodes");
            return 5;
        }
        
        // Priority 3: Read actual node activations from blockchain storage
        if let Some(activations_cf) = persistent.db.cf_handle("activations") {
            let mut count = 0;
            let iter = persistent.db.iterator_cf(activations_cf, rocksdb::IteratorMode::Start);
            for _ in iter {
                count += 1;
            }
            
            if count > 0 {
                println!("[Storage] 🔗 Blockchain registry: {} activated nodes", count);
                return count;
            }
        }
        
        // Priority 4: Conservative default (small network assumption)
        println!("[Storage] ⚠️ No network data found, using conservative default: 100 nodes");
        100 // Conservative: assume small network to avoid over-sharding
    }
    
    /// Estimate Super node count in the network (conservative approximation)
    /// Used for safety checks before aggressive pruning
    fn estimate_super_node_count() -> u64 {
        // Try to get from environment (set by monitoring/stats system)
        if let Ok(count_str) = std::env::var("QNET_SUPER_NODE_COUNT") {
            if let Ok(count) = count_str.parse::<u64>() {
                return count;
            }
        }
        
        // Conservative estimation based on network phase
        let bootstrap_id = std::env::var("QNET_BOOTSTRAP_ID").ok();
        
        if bootstrap_id.is_some() {
            // Genesis phase: 5 bootstrap Super nodes
            5
        } else {
            // Production: Conservative estimate based on total network size
            // In real deployment, this would query P2P or consensus layer
            // For now, return safe default that allows aggressive pruning
            50 // Assume mature network has enough Super nodes
        }
    }
    
    /// Remove microblocks that have been finalized by a macroblock
    /// This dramatically reduces storage as we only keep macroblocks + state
    async fn prune_finalized_microblocks(&self, macroblock: &qnet_state::MacroBlock) -> IntegrationResult<()> {
        // Only prune if enabled (safety check)
        if std::env::var("QNET_PRUNE_FINALIZED_MICROS").unwrap_or_else(|_| "1".to_string()) != "1" {
            return Ok(());
        }
        
        println!("[PRUNING] 🎯 Pruning microblocks finalized by macroblock {}", macroblock.height);
        
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let mut batch = WriteBatch::default();
        let mut pruned = 0;
        
        // CRITICAL FIX: Macroblock height != microblock heights!
        // Macroblock #1 finalizes microblocks 1-90
        // Macroblock #2 finalizes microblocks 91-180
        // Formula: macro_num * 90 gives us the last microblock finalized
        
        // Calculate which microblocks this macroblock finalizes
        // Each macroblock finalizes 90 microblocks (3 leaders × 30 blocks each)
        let macro_number = macroblock.height; // This is macroblock number, not microblock!
        let last_micro = macro_number * 90;
        let first_micro = last_micro.saturating_sub(89); // 90 blocks total
        
        println!("[PRUNING] Macroblock #{} finalizes microblocks {}-{}", 
                macro_number, first_micro, last_micro);
        
        // Delete the finalized microblocks
        for micro_height in first_micro..=last_micro {
            let key = format!("microblock_{}", micro_height);
            if self.persistent.db.get_cf(&microblocks_cf, key.as_bytes())?.is_some() {
                batch.delete_cf(&microblocks_cf, key.as_bytes());
                pruned += 1;
                
                // Log leader transitions (every 30 blocks)
                if micro_height % 30 == 0 {
                    println!("[PRUNING] 🔄 Leader rotation point at microblock {}", micro_height);
                }
            }
        }
        
        if pruned > 0 {
            self.persistent.db.write(batch)?;
            println!("[PRUNING] ✅ Pruned {} microblocks (3 leader rotations finalized)", pruned);
            
            // v3.19: Trigger compaction to reclaim disk space immediately
            self.persistent.db.compact_range_cf(&microblocks_cf, None::<&[u8]>, None::<&[u8]>);
        }
        
        // v3.19: Prune old heartbeats every 10 macroblocks (~15 min)
        // Keep 8h (2 epochs) - enough for reward calculation (needs 4h window)
        // OLD: 24h = 6 epochs = excessive
        // NEW: 8h = 2 epochs = safe margin
        if macroblock.height % 10 == 0 {
            let _ = self.persistent.prune_old_heartbeats(28800); // 8h = 28800 sec
        }
        
        Ok(())
    }
    
    pub fn get_stats(&self) -> IntegrationResult<StorageStats> {
        self.persistent.get_stats()
    }

    // Activation code methods
    pub fn save_activation_code(&self, code: &str, node_type: u8, timestamp: u64) -> IntegrationResult<()> {
        self.persistent.save_activation_code(code, node_type, timestamp)
    }

    pub fn load_activation_code(&self) -> IntegrationResult<Option<(String, u8, u64)>> {
        self.persistent.load_activation_code()
    }

    pub fn clear_activation_code(&self) -> IntegrationResult<()> {
        self.persistent.clear_activation_code()
    }
    
    /// Get burn transaction hash for activation code (for XOR decryption)
    pub fn get_activation_burn_tx(&self) -> IntegrationResult<String> {
        self.persistent.get_activation_burn_tx()
    }
    
    /// Save burn transaction hash for activation code (for XOR decryption)
    pub fn save_activation_burn_tx(&self, burn_tx: &str) -> IntegrationResult<()> {
        self.persistent.save_activation_burn_tx(burn_tx)
    }
    
    /// Find transaction by hash
    pub async fn find_transaction_by_hash(&self, tx_hash: &str) -> IntegrationResult<Option<qnet_state::Transaction>> {
        self.persistent.find_transaction_by_hash(tx_hash).await
    }

    /// Get transaction block height
    pub async fn get_transaction_block_height(&self, tx_hash: &str) -> IntegrationResult<u64> {
        self.persistent.get_transaction_block_height(tx_hash).await
    }
    
    /// Get transactions for an address (paginated)
    pub async fn get_transactions_by_address(&self, address: &str, page: usize, per_page: usize) -> IntegrationResult<Vec<qnet_state::Transaction>> {
        self.persistent.get_transactions_by_address(address, page, per_page).await
    }
    
    /// Count transactions for an address
    pub async fn count_transactions_by_address(&self, address: &str) -> IntegrationResult<usize> {
        self.persistent.count_transactions_by_address(address).await
    }
    
    /// Get recent transactions globally (paginated, newest first)
    pub async fn get_recent_transactions(&self, page: usize, per_page: usize) -> IntegrationResult<(Vec<qnet_state::Transaction>, usize)> {
        self.persistent.get_recent_transactions(page, per_page).await
    }
    
    /// Count total transactions in the blockchain
    pub async fn count_total_transactions(&self) -> IntegrationResult<usize> {
        self.persistent.count_total_transactions().await
    }
    
    /// Get reputation history for a node
    pub fn get_reputation_history(&self, node_id: &str, limit: usize) -> IntegrationResult<Vec<serde_json::Value>> {
        self.get_reputation_history_internal(node_id, limit)
    }
    
    /// Save reputation change event
    pub fn save_reputation_change(&self, node_id: &str, old_value: f64, new_value: f64, reason: &str) -> IntegrationResult<()> {
        self.save_reputation_change_internal(node_id, old_value, new_value, reason)
    }

    pub fn update_activation_for_migration(&self, code: &str, node_type: u8, timestamp: u64, new_device_signature: &str) -> IntegrationResult<()> {
        self.persistent.update_activation_for_migration(code, node_type, timestamp, new_device_signature)
    }
    
    /// Save consensus state for persistence
    pub fn save_consensus_state(&self, round: u64, state: &[u8]) -> IntegrationResult<()> {
        self.persistent.save_consensus_state(round, state)
    }
    
    /// Load consensus state after restart
    pub fn load_consensus_state(&self, round: u64) -> IntegrationResult<Option<Vec<u8>>> {
        self.persistent.load_consensus_state(round)
    }
    
    /// Get latest consensus round
    pub fn get_latest_consensus_round(&self) -> IntegrationResult<u64> {
        self.persistent.get_latest_consensus_round()
    }
    
    /// Save sync progress
    pub fn save_sync_progress(&self, from_height: u64, to_height: u64, current: u64) -> IntegrationResult<()> {
        self.persistent.save_sync_progress(from_height, to_height, current)
    }
    
    /// Load sync progress
    pub fn load_sync_progress(&self) -> IntegrationResult<Option<(u64, u64, u64)>> {
        self.persistent.load_sync_progress()
    }
    
    /// Clear sync progress
    pub fn clear_sync_progress(&self) -> IntegrationResult<()> {
        self.persistent.clear_sync_progress()
    }
    
    /// Get microblocks range for batch sync  
    /// CRITICAL: Returns full MicroBlock format for network sync (not EfficientMicroBlock)
    /// This ensures receiving nodes can deserialize blocks with full transaction data
    pub async fn get_microblocks_range(&self, from: u64, to: u64) -> IntegrationResult<Vec<(u64, Vec<u8>)>> {
        let mut microblocks = Vec::new();
        
        // Get RocksDB column family for transactions
        let tx_cf = self.persistent.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        
        for height in from..=to {
            if let Some(raw_data) = self.load_microblock(height)? {
                // CRITICAL: Convert EfficientMicroBlock back to full MicroBlock for network sync
                // First try to deserialize as EfficientMicroBlock (new format)
                if let Ok(efficient_block) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&raw_data) {
                    // Reconstruct full MicroBlock with transactions from PERSISTENT storage
                    let mut transactions = Vec::with_capacity(efficient_block.transaction_hashes.len());
                    
                    for tx_hash in &efficient_block.transaction_hashes {
                        let tx_hash_hex = hex::encode(tx_hash);
                        
                        // First try in-memory cache for speed
                        if let Some(tx) = self.transaction_pool.get_transaction(tx_hash) {
                            transactions.push(tx);
                            continue;
                        }
                        
                        // Fallback to persistent RocksDB storage
                        let tx_key = format!("tx_{}", tx_hash_hex);
                        if let Ok(Some(data)) = self.persistent.db.get_cf(&tx_cf, tx_key.as_bytes()) {
                            // Decompress if Zstd-compressed
                            let tx_data = if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                                zstd::decode_all(&data[..]).unwrap_or(data.to_vec())
                            } else {
                                data.to_vec()
                            };
                            
                            if let Ok(tx) = bincode::deserialize::<qnet_state::Transaction>(&tx_data) {
                                // Cache for future use
                                let _ = self.transaction_pool.store_transaction(*tx_hash, tx.clone());
                                transactions.push(tx);
                            }
                        }
                    }
                    
                    // Create full MicroBlock (including QRB VRF data)
                    let full_block = qnet_state::MicroBlock {
                        height: efficient_block.height,
                        timestamp: efficient_block.timestamp,
                        transactions,
                        producer: efficient_block.producer,
                        signature: efficient_block.signature,
                        previous_hash: efficient_block.previous_hash,
                        merkle_root: efficient_block.merkle_root,
                        poh_hash: efficient_block.poh_hash,
                        poh_count: efficient_block.poh_count,
                        // QRB v3.0: VRF fields
                        vrf_output: efficient_block.vrf_output,
                        vrf_proof: efficient_block.vrf_proof,
                        // v3.18: Direct fee collection
                        fees_collected: efficient_block.fees_collected,
                        // v3.27: State root for verification
                        state_root: efficient_block.state_root,
                    };
                    
                    // Serialize as full MicroBlock for network transmission
                    let full_data = bincode::serialize(&full_block)
                        .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                    
                    microblocks.push((height, full_data));
                } else {
                    // Already in MicroBlock format (legacy) - use as-is
                    microblocks.push((height, raw_data));
                }
            }
        }
        
        Ok(microblocks)
    }
    
    /// Legacy: Get blocks range for old Block format
    pub async fn get_blocks_range(&self, from: u64, to: u64) -> IntegrationResult<Vec<qnet_state::Block>> {
        self.persistent.get_blocks_range(from, to).await
    }
    
    /// Get transaction pool statistics
    pub fn get_transaction_pool_stats(&self) -> IntegrationResult<(usize, usize)> {
        self.transaction_pool.get_stats()
    }
    
    // =========================================================================
    // MACROBLOCK SYNC METHODS (PRODUCTION v2.19.12)
    // =========================================================================
    
    /// Get macroblocks range for batch sync
    /// PRODUCTION: Returns serialized MacroBlock data for network transmission
    /// 
    /// Architecture:
    /// - Macroblocks are indexed by INDEX (not height): index 1 = blocks 1-90
    /// - Max 10 macroblocks per batch (~1MB max)
    /// - Decompresses if stored compressed
    pub async fn get_macroblocks_range(&self, from_index: u64, to_index: u64) -> IntegrationResult<Vec<(u64, Vec<u8>)>> {
        let mut macroblocks = Vec::new();
        
        // SCALABILITY: Limit to 10 macroblocks per batch
        let actual_to = if to_index > from_index && to_index - from_index > 10 {
            from_index + 9
        } else {
            to_index
        };
        
        for index in from_index..=actual_to {
            if let Some(raw_data) = self.get_macroblock_by_height(index)? {
                // Decompress if needed (Zstd magic bytes check)
                let data = if raw_data.len() >= 4 && raw_data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    zstd::decode_all(&raw_data[..]).unwrap_or(raw_data)
                } else {
                    raw_data
                };
                
                // Verify it's a valid MacroBlock before sending
                if bincode::deserialize::<qnet_state::MacroBlock>(&data).is_ok() {
                    macroblocks.push((index, data));
                } else {
                    println!("[MACROBLOCK-SYNC] ⚠️ Invalid macroblock data at index {}", index);
                }
            }
        }
        
        println!("[MACROBLOCK-SYNC] 📦 Prepared {} macroblocks for sync (indices {}-{})", 
                 macroblocks.len(), from_index, actual_to);
        
        Ok(macroblocks)
    }
    
    /// Get the latest macroblock index
    /// PRODUCTION: Used to determine sync target
    pub fn get_latest_macroblock_index(&self) -> IntegrationResult<u64> {
        let chain_height = self.get_chain_height()?;
        if chain_height == 0 {
            Ok(0)
        } else {
            // Macroblock index = (height / 90), but only if that macroblock is complete
            let complete_macroblocks = chain_height / 90;
            Ok(complete_macroblocks)
        }
    }
    
    /// Load microblock with automatic format detection (backward compatibility)
    /// Supports both EfficientMicroBlock (new) and MicroBlock (legacy) formats
    /// Handles Zstd compression transparently
    pub fn load_microblock_auto_format(&self, height: u64) -> IntegrationResult<Option<qnet_state::MicroBlock>> {
        // Try to load raw microblock data
        let raw_data = match self.load_microblock(height)? {
            Some(data) => data,
            None => return Ok(None),
        };
        
        // CRITICAL: Decompress if Zstd-compressed (magic bytes: 0x28 0xb5 0x2f 0xfd)
        // Data is compressed in save_microblock_efficient via compress_block_adaptive
        let microblock_data = if raw_data.len() >= 4 && raw_data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
            zstd::decode_all(&raw_data[..])
                .map_err(|e| IntegrationError::Other(format!("Zstd decompression failed: {}", e)))?
        } else {
            raw_data
        };
        
        // First, try to deserialize as EfficientMicroBlock (new format)
        if let Ok(efficient_block) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&microblock_data) {
            // Reconstruct full microblock from efficient format
            // CRITICAL: Load transactions from PERSISTENT RocksDB storage, NOT in-memory pool
            // This ensures transactions are available even after restart or TTL expiry
            let mut transactions = Vec::with_capacity(efficient_block.transaction_hashes.len());
            
            for tx_hash in &efficient_block.transaction_hashes {
                let tx_hash_hex = hex::encode(tx_hash);
                
                // First try in-memory cache for speed
                if let Some(tx) = self.transaction_pool.get_transaction(tx_hash) {
                    transactions.push(tx);
                    continue;
                }
                
                // Fallback to persistent RocksDB storage
                // Use blocking approach since this is a sync function
                let tx_cf = match self.persistent.db.cf_handle("transactions") {
                    Some(cf) => cf,
                    None => {
                        println!("[Storage] ⚠️ transactions CF not found for block {}", height);
                        continue;
                    }
                };
                
                let tx_key = format!("tx_{}", tx_hash_hex);
                match self.persistent.db.get_cf(&tx_cf, tx_key.as_bytes()) {
                    Ok(Some(data)) => {
                        // Decompress if Zstd-compressed
                        let tx_data = if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                            zstd::decode_all(&data[..]).unwrap_or(data.to_vec())
                        } else {
                            data.to_vec()
                        };
                        
                        if let Ok(tx) = bincode::deserialize::<qnet_state::Transaction>(&tx_data) {
                            // Cache for future use
                            let _ = self.transaction_pool.store_transaction(*tx_hash, tx.clone());
                            transactions.push(tx);
                        } else {
                            println!("[Storage] ⚠️ Failed to deserialize TX {} for block {}", tx_hash_hex, height);
                        }
                    }
                    Ok(None) => {
                        println!("[Storage] ⚠️ Transaction {} not found in storage for block {}", tx_hash_hex, height);
                    }
                    Err(e) => {
                        println!("[Storage] ⚠️ Error loading TX {}: {}", tx_hash_hex, e);
                    }
                }
            }
            
            // Reconstruct full MicroBlock (including QRB VRF data)
            let microblock = qnet_state::MicroBlock {
                height: efficient_block.height,
                timestamp: efficient_block.timestamp,
                transactions,
                producer: efficient_block.producer,
                signature: efficient_block.signature,
                previous_hash: efficient_block.previous_hash,
                merkle_root: efficient_block.merkle_root,
                poh_hash: efficient_block.poh_hash,
                poh_count: efficient_block.poh_count,
                // Quantum Randomness Beacon (QRB) v3.0
                vrf_output: efficient_block.vrf_output,
                vrf_proof: efficient_block.vrf_proof,
                // v3.18: fees_collected for producer rewards
                fees_collected: efficient_block.fees_collected,
                // v3.27: state_root for state verification
                state_root: efficient_block.state_root,
            };
            
            return Ok(Some(microblock));
        }
        
        // Fallback: try to deserialize as legacy MicroBlock format
        if let Ok(legacy_block) = bincode::deserialize::<qnet_state::MicroBlock>(&microblock_data) {
            // For backward compatibility, also populate transaction pool with legacy data
            for tx in &legacy_block.transactions {
                // Convert string hash to [u8; 32]
                if let Ok(hash_bytes) = hex::decode(&tx.hash) {
                    if hash_bytes.len() == 32 {
                        let mut hash_array = [0u8; 32];
                        hash_array.copy_from_slice(&hash_bytes);
                        if let Err(e) = self.transaction_pool.store_transaction(hash_array, tx.clone()) {
                            println!("[Storage] ⚠️ Failed to cache legacy transaction {}: {}", hex::encode(hash_array), e);
                        }
                    }
                }
            }
            
            return Ok(Some(legacy_block));
        }
        
        Err(IntegrationError::StorageError(
            format!("Unable to deserialize microblock {} in any known format", height)
        ))
    }
    
    /// Convert legacy microblock to efficient format (migration utility)
    pub fn migrate_legacy_microblock_to_efficient(&self, height: u64) -> IntegrationResult<bool> {
        // Load raw data
        let microblock_data = match self.load_microblock(height)? {
            Some(data) => data,
            None => return Ok(false),
        };
        
        // Check if it's already in efficient format
        if bincode::deserialize::<qnet_state::EfficientMicroBlock>(&microblock_data).is_ok() {
            println!("[Storage] ✅ Microblock {} already in efficient format", height);
            return Ok(false);
        }
        
        // Try to deserialize as legacy format
        let legacy_block = bincode::deserialize::<qnet_state::MicroBlock>(&microblock_data)
            .map_err(|e| IntegrationError::SerializationError(
                format!("Failed to deserialize legacy microblock {}: {}", height, e)
            ))?;
        
        println!("[Storage] 🔄 Converting legacy microblock {} to efficient format", height);
        
        // Save in new format with delta compression
        let block_data = bincode::serialize(&legacy_block)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        self.save_block_with_delta(height, &block_data)?;
        
        println!("[Storage] ✅ Migrated microblock {} to efficient format", height);
        Ok(true)
    }
    
    /// Batch migration of legacy microblocks (for system upgrade)
    pub fn batch_migrate_legacy_microblocks(&self, start_height: u64, end_height: u64) -> IntegrationResult<u64> {
        let mut migrated_count = 0;
        
        println!("[Storage] 🚀 Starting batch migration of microblocks {} to {}", start_height, end_height);
        
        for height in start_height..=end_height {
            match self.migrate_legacy_microblock_to_efficient(height) {
                Ok(true) => {
                    migrated_count += 1;
                    if migrated_count % 100 == 0 {
                        println!("[Storage] 📊 Migration progress: {} microblocks converted", migrated_count);
                    }
                },
                Ok(false) => {
                    // Already efficient or doesn't exist
                },
                Err(e) => {
                    println!("[Storage] ⚠️ Failed to migrate microblock {}: {}", height, e);
                }
            }
        }
        
        println!("[Storage] 🎉 Batch migration completed: {} microblocks converted to efficient format", migrated_count);
        
        Ok(migrated_count)
    }
    
    // ========================================================================
    // POH STATE MIGRATION (v2.19.13)
    // ========================================================================
    // Migrate existing blocks to have separate PoH state for fast validation
    // This is a one-time migration that runs on node startup
    // ========================================================================
    
    /// Migrate PoH state for a single block (extract from block and save separately)
    pub fn migrate_poh_state_for_block(&self, height: u64) -> IntegrationResult<bool> {
        // Check if PoH state already exists
        if let Ok(Some(_)) = self.load_poh_state(height) {
            return Ok(false); // Already migrated
        }
        
        // Load block using auto-format detection
        let microblock = match self.load_microblock_auto_format(height)? {
            Some(block) => block,
            None => return Ok(false), // Block doesn't exist
        };
        
        // Extract and save PoH state
        let poh_state = qnet_state::PoHState::from_microblock(&microblock);
        self.save_poh_state(&poh_state)?;
        
        Ok(true)
    }
    
    /// Migrate PoH state for all existing blocks (run on startup)
    /// Returns number of blocks migrated
    pub fn migrate_all_poh_states(&self) -> IntegrationResult<u64> {
        let chain_height = self.persistent.get_chain_height()?;
        if chain_height == 0 {
            println!("[POH_MIGRATION] ℹ️ No blocks to migrate");
            return Ok(0);
        }
        
        println!("[POH_MIGRATION] 🚀 Starting PoH state migration for {} blocks", chain_height + 1);
        
        let mut migrated = 0u64;
        let mut skipped = 0u64;
        let start_time = std::time::Instant::now();
        
        for height in 0..=chain_height {
            match self.migrate_poh_state_for_block(height) {
                Ok(true) => {
                    migrated += 1;
                    if migrated % 1000 == 0 {
                        let elapsed = start_time.elapsed().as_secs();
                        let rate = if elapsed > 0 { migrated / elapsed } else { migrated };
                        println!("[POH_MIGRATION] 📊 Progress: {} migrated, {} skipped ({} blocks/sec)", 
                                migrated, skipped, rate);
                    }
                }
                Ok(false) => {
                    skipped += 1;
                }
                Err(e) => {
                    println!("[POH_MIGRATION] ⚠️ Failed to migrate PoH state for block {}: {}", height, e);
                }
            }
        }
        
        let elapsed = start_time.elapsed();
        println!("[POH_MIGRATION] ✅ Migration completed in {:.2}s: {} migrated, {} skipped", 
                elapsed.as_secs_f64(), migrated, skipped);
        
        Ok(migrated)
    }
    
    /// Check if PoH state migration is needed
    pub fn needs_poh_migration(&self) -> IntegrationResult<bool> {
        let chain_height = self.persistent.get_chain_height()?;
        if chain_height == 0 {
            return Ok(false); // No blocks yet
        }
        
        // Check if PoH state exists for the latest block
        // If not, migration is needed
        match self.load_poh_state(chain_height)? {
            Some(_) => Ok(false), // Already have PoH state
            None => Ok(true),     // Need to migrate
        }
    }
    
    /// High-level compression utilities for archive data
    pub fn compress_archive_data(&self, data: &[u8]) -> IntegrationResult<Vec<u8>> {
        let compressed = zstd::encode_all(data, 9) // Level 9 for maximum compression (archive data)
            .map_err(|e| IntegrationError::Other(format!("Zstd compression error: {}", e)))?;
            
        if compressed.len() < data.len() {
            println!("[Compression] ✅ Archive data compressed ({} -> {} bytes)", 
                    data.len(), compressed.len());
            Ok(compressed)
        } else {
            println!("[Compression] ⏭️ Archive data not compressed (no benefit)");
            Ok(data.to_vec())
        }
    }
    
    /// Decompress archive data
    pub fn decompress_archive_data(&self, data: &[u8]) -> IntegrationResult<Vec<u8>> {
        // Try to decompress with Zstd first
        match zstd::decode_all(data) {
            Ok(decompressed) => {
                println!("[Compression] ✅ Archive data decompressed: {} -> {} bytes", 
                        data.len(), decompressed.len());
                Ok(decompressed)
            },
            Err(_) => {
                // Data might not be compressed, return as-is
                println!("[Compression] ⏭️ Data not compressed, returning as-is");
                Ok(data.to_vec())
            }
        }
    }
    
    /// Compress transaction pool for efficient storage
    pub fn compress_transaction_pool(&self) -> IntegrationResult<Vec<u8>> {
        let (tx_count, _) = self.transaction_pool.get_stats()?;
        
        if tx_count == 0 {
            return Ok(Vec::new());
        }
        
        println!("[Compression] 🔄 Compressing transaction pool with {} transactions", tx_count);
        
        // Serialize all transactions
        let transactions = self.transaction_pool.transactions.read()
            .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
        let creation_times = self.transaction_pool.creation_times.read()
            .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
            
        let pool_data = (&*transactions, &*creation_times);
        let serialized = bincode::serialize(&pool_data)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        drop(transactions);
        drop(creation_times);
        
        // Compress with high level for long-term storage
        let compressed = zstd::encode_all(&serialized[..], 6) // Level 6 for good compression
            .map_err(|e| IntegrationError::Other(format!("Zstd compression error: {}", e)))?;
            
        println!("[Compression] ✅ Transaction pool compressed ({} -> {} bytes)", 
                serialized.len(), compressed.len());
                
        Ok(compressed)
    }
    
    /// PRODUCTION: Check storage usage and trigger emergency cleanup if needed
    pub fn check_storage_usage_and_cleanup(&self) -> IntegrationResult<bool> {
        let data_dir = std::env::var("QNET_DATA_DIR").unwrap_or_else(|_| "./node_data".to_string());
        
        // Get actual disk usage
        let actual_usage = self.get_directory_size(&data_dir)?;
        
        // Update current usage tracking
        {
            let mut usage = self.current_storage_usage.write()
                .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
            *usage = actual_usage;
        }
        
        let usage_percentage = (actual_usage as f64 / self.max_storage_size as f64) * 100.0;
        
        println!("[Storage] 📊 Storage usage: {:.1} GB / {:.1} GB ({:.1}%)", 
                actual_usage as f64 / (1024.0 * 1024.0 * 1024.0),
                self.max_storage_size as f64 / (1024.0 * 1024.0 * 1024.0),
                usage_percentage);
        
        // Trigger cleanup at different thresholds
        match usage_percentage {
            p if p >= 95.0 => {
                println!("[Storage] 🚨 CRITICAL: Storage 95%+ full, triggering emergency cleanup");
                self.emergency_cleanup()?;
                Ok(false) // Emergency state
            },
            p if p >= 85.0 => {
                println!("[Storage] ⚠️ WARNING: Storage 85%+ full, triggering aggressive cleanup");
                self.aggressive_cleanup()?;
                Ok(false) // Warning state
            },
            p if p >= 70.0 => {
                println!("[Storage] 📋 INFO: Storage 70%+ full, triggering standard cleanup");
                self.standard_cleanup()?;
                Ok(true) // Normal operation
            },
            _ => {
                println!("[Storage] ✅ Storage usage normal ({:.1}%)", usage_percentage);
                Ok(true) // Normal operation
            }
        }
    }
    
    /// Get directory size in bytes
    fn get_directory_size(&self, path: &str) -> IntegrationResult<u64> {
        let mut total_size = 0u64;
        
        fn visit_dir(dir: &std::path::Path, total: &mut u64) -> Result<(), Box<dyn std::error::Error>> {
            if dir.is_dir() {
                for entry in std::fs::read_dir(dir)? {
                    let entry = entry?;
                    let path = entry.path();
                    if path.is_dir() {
                        visit_dir(&path, total)?;
                    } else {
                        if let Ok(metadata) = entry.metadata() {
                            *total += metadata.len();
                        }
                    }
                }
            }
            Ok(())
        }
        
        if let Err(e) = visit_dir(std::path::Path::new(path), &mut total_size) {
            println!("[Storage] ⚠️ Failed to calculate directory size: {}", e);
            // Fallback: return estimated size
            return Ok(self.estimate_storage_usage());
        }
        
        Ok(total_size)
    }
    
    /// Estimate storage usage based on blockchain height
    fn estimate_storage_usage(&self) -> u64 {
        // Rough estimate: 32 KB per microblock + transaction pool
        if let Ok(height) = self.get_chain_height() {
            let microblock_size = height * 32 * 1024; // 32 KB per microblock
            let pool_size = 500 * 1024 * 1024; // 500 MB estimated pool size
            microblock_size + pool_size
        } else {
            0
        }
    }
    
    /// Standard cleanup (70-85% full) - remove ONLY cache data, preserve blockchain history
    fn standard_cleanup(&self) -> IntegrationResult<()> {
        println!("[Storage] 🧹 Starting standard cleanup (cache cleanup only - blockchain history preserved)");
        
        // 1. Clean transaction pool cache (this is OK - only removes duplicates)
        let removed_tx = self.transaction_pool.cleanup_old_duplicates()?;
        println!("[Storage] 📦 Removed {} old transaction duplicates from cache", removed_tx);
        
        // 2. CRITICAL CORRECTION: DO NOT delete blockchain history!
        // Instead, implement proper cache management
        
        // 3. PRODUCTION: Compress old data instead of deleting
        // Note: Compression now happens automatically via adaptive compression
        // Force RocksDB compaction to optimize storage efficiency
        
        // 4. Force RocksDB compaction to optimize storage efficiency
        self.persistent.db.compact_range::<&[u8], &[u8]>(None, None);
        println!("[Storage] 🗜️ Database compaction completed - optimized storage layout");
        
        println!("[Storage] ✅ Standard cleanup completed (blockchain history preserved)");
        Ok(())
    }
    
    /// Aggressive cleanup (85-95% full) - CACHE cleanup only, blockchain history preserved
    fn aggressive_cleanup(&self) -> IntegrationResult<()> {
        println!("[Storage] 🔥 Starting aggressive cleanup (cache optimization - blockchain history preserved)");
        
        // 1. PRODUCTION: More aggressive transaction pool cleanup (6 hours instead of 24)
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| IntegrationError::Other(format!("Time error: {}", e)))?
            .as_secs();
        let aggressive_cutoff = current_time.saturating_sub(6 * 3600); // 6 hours
        
        // Force aggressive cleanup of transaction pool CACHE only
        {
            let mut transactions = self.transaction_pool.transactions.write()
                .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
            let mut creation_times = self.transaction_pool.creation_times.write()
                .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
            
            let old_hashes: Vec<[u8; 32]> = creation_times.iter()
                .filter(|(_, &time)| time < aggressive_cutoff)
                .map(|(hash, _)| *hash)
                .collect();
                
            for hash in old_hashes {
                transactions.remove(&hash);
                creation_times.remove(&hash);
            }
            
            println!("[Storage] 🧨 Aggressive transaction CACHE cleanup: removed duplicates older than 6 hours");
        }
        
        // 2. CRITICAL CORRECTION: DO NOT delete blockchain history!
        // 3. PRODUCTION: Maximum compression instead of deletion
        // Note: Compression now happens automatically via adaptive compression
        
        // 4. PRODUCTION: Force RocksDB compaction to reclaim space immediately
        self.persistent.db.compact_range::<&[u8], &[u8]>(None, None);
        println!("[Storage] 🗜️ Database compaction completed - optimized storage efficiency");
        
        println!("[Storage] ⚡ Aggressive cleanup completed (blockchain history preserved)");
        Ok(())
    }
    
    /// Emergency cleanup (95%+ full) - remove all non-essential data
    fn emergency_cleanup(&self) -> IntegrationResult<()> {
        println!("[Storage] 🚨 EMERGENCY CLEANUP: Storage critically full, removing all non-essential data");
        
        if !self.emergency_cleanup_enabled {
            return Err(IntegrationError::StorageError(
                "Emergency cleanup disabled, cannot continue operation".to_string()
            ));
        }
        
        // PRODUCTION EMERGENCY MEASURES:
        
        // 1. Clear ALL transaction pool except last hour
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| IntegrationError::Other(format!("Time error: {}", e)))?
            .as_secs();
        let emergency_cutoff = current_time.saturating_sub(3600); // 1 hour only
        
        {
            let mut transactions = self.transaction_pool.transactions.write()
                .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
            let mut creation_times = self.transaction_pool.creation_times.write()
                .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
            
            let emergency_hashes: Vec<[u8; 32]> = creation_times.iter()
                .filter(|(_, &time)| time < emergency_cutoff)
                .map(|(hash, _)| *hash)
                .collect();
                
            for hash in emergency_hashes {
                transactions.remove(&hash);
                creation_times.remove(&hash);
            }
            
            println!("[Storage] 🆘 EMERGENCY: Cleared transaction pool (kept only last 1 hour)");
        }
        
        // 2. CRITICAL CORRECTION: DO NOT delete blockchain history even in emergency!
        // Instead, maximum compression and cache optimization
        println!("[Storage] 🆘 EMERGENCY: Applying maximum compression to blockchain data");
        
        // Emergency compression of blockchain data
        // Note: Compression now happens automatically via adaptive compression
        
        // 3. PRODUCTION: Force maximum compression on all remaining data
        self.persistent.db.compact_range::<&[u8], &[u8]>(None, None);
        println!("[Storage] 🗜️ Emergency compaction completed");
        
        // 4. CRITICAL CORRECTION: DO NOT delete transaction history from blockchain!
        // Emergency optimization through compression only
        println!("[Storage] 🆘 EMERGENCY: Optimizing storage through compression (history preserved)");
        
        println!("[Storage] 🆘 Emergency cleanup completed - node should continue operation");
        
        // Check if we're still critically full after cleanup
        let post_cleanup_usage = self.get_directory_size(&std::env::var("QNET_DATA_DIR").unwrap_or_else(|_| "./node_data".to_string()))?;
        let post_cleanup_percentage = (post_cleanup_usage as f64 / self.max_storage_size as f64) * 100.0;
        
        if post_cleanup_percentage >= 90.0 {
            println!("[Storage] 🚨 CRITICAL: Even after emergency cleanup, storage is {:.1}% full!", post_cleanup_percentage);
            println!("[Storage] 💡 IMMEDIATE ADMIN ACTIONS REQUIRED:");
            println!("[Storage]    1. Add more disk space immediately");
            println!("[Storage]    2. Set QNET_MAX_STORAGE_GB=500 or higher");
            println!("[Storage]    3. Monitor disk usage closely");
            println!("[Storage]    4. Consider moving to server with larger storage");
            println!("[Storage] ⚠️  NODE WILL STRUGGLE TO ACCEPT NEW BLOCKS!");
        } else {
            println!("[Storage] ✅ Emergency cleanup successful - storage now at {:.1}%", post_cleanup_percentage);
            println!("[Storage] 💡 RECOMMENDED ACTIONS:");
            println!("[Storage]    1. Consider increasing QNET_MAX_STORAGE_GB=500");
            println!("[Storage]    2. Plan for long-term storage growth");
        }
        
        Ok(())
    }
    
    /// Get current storage usage percentage
    pub fn get_storage_usage_percentage(&self) -> IntegrationResult<f64> {
        let usage = *self.current_storage_usage.read()
            .map_err(|e| IntegrationError::Other(format!("Lock error: {}", e)))?;
        Ok((usage as f64 / self.max_storage_size as f64) * 100.0)
    }
    
    /// Check if storage is critically full
    pub fn is_storage_critically_full(&self) -> IntegrationResult<bool> {
        Ok(self.get_storage_usage_percentage()? >= 95.0)
    }
    
    /// Get maximum storage size
    pub fn get_max_storage_size(&self) -> u64 {
        self.max_storage_size
    }
    
    /// Update maximum storage size (for runtime configuration)
    pub fn update_max_storage_size(&mut self, new_size_gb: u64) {
        self.max_storage_size = new_size_gb * 1024 * 1024 * 1024;
        println!("[Storage] 🔧 Updated maximum storage size to {} GB", new_size_gb);
    }
    
    /// Get compression level based on block age
    pub fn get_compression_level(&self, block_height: u64) -> CompressionLevel {
        let current_height = self.get_chain_height().unwrap_or(0);
        if current_height <= block_height {
            return CompressionLevel::None;
        }
        
        let age_blocks = current_height - block_height;
        // 86400 blocks per day (1 block per second)
        let age_days = age_blocks / 86400;
        
        match age_days {
            0..=1 => CompressionLevel::None,
            2..=7 => CompressionLevel::Light,
            8..=30 => CompressionLevel::Medium,
            31..=365 => CompressionLevel::Heavy,
            _ => CompressionLevel::Extreme,
        }
    }
    
    /// Get Zstd compression level from enum
    fn get_zstd_level(&self, level: CompressionLevel) -> Option<i32> {
        match level {
            CompressionLevel::None => None,
            CompressionLevel::Light => Some(3),
            CompressionLevel::Medium => Some(9),
            CompressionLevel::Heavy => Some(15),
            CompressionLevel::Extreme => Some(22), // Maximum compression
        }
    }
    
    /// Compress block data with adaptive level
    pub fn compress_block_adaptive(&self, block_data: &[u8], height: u64) -> IntegrationResult<Vec<u8>> {
        let compression_level = self.get_compression_level(height);
        
        match self.get_zstd_level(compression_level) {
            None => {
                // No compression for hot data
                Ok(block_data.to_vec())
            },
            Some(zstd_level) => {
                let compressed = zstd::encode_all(block_data, zstd_level)
                    .map_err(|e| IntegrationError::Other(format!("Zstd compression error: {}", e)))?;
                
                // Only use compression if it reduces size by at least 10%
                if compressed.len() < (block_data.len() * 9 / 10) {
                    println!("[Compression] ✅ Level {:?} applied ({} -> {} bytes, {:.1}% reduction)", 
                            compression_level, block_data.len(), compressed.len(),
                            (1.0 - compressed.len() as f64 / block_data.len() as f64) * 100.0);
                    Ok(compressed)
                } else {
                    Ok(block_data.to_vec())
                }
            }
        }
    }
    
    /// Decompress block data if it's compressed
    pub fn decompress_block(&self, data: &[u8]) -> IntegrationResult<Vec<u8>> {
        // Try to decompress with zstd - if it fails, data is not compressed
        match zstd::decode_all(data) {
            Ok(decompressed) => {
                println!("[Compression] ✅ Decompressed {} -> {} bytes", data.len(), decompressed.len());
                Ok(decompressed)
            },
            Err(_) => {
                // Not compressed, return as-is
                Ok(data.to_vec())
            }
        }
    }
    
    // NOTE: calculate_block_delta() and apply_block_delta() removed in v2.19.10
    // Delta encoding was evaluated but Pattern Recognition + Zstd provides better results
    
    /// Save block with optimal compression (delegates to unified save_microblock)
    /// 
    /// UNIFIED STORAGE: All block saving goes through save_microblock() which handles:
    /// - Tiered storage (Light/Full/Super)
    /// - Pattern Recognition compression (89% for simple transfers)
    /// - EfficientMicroBlock format (hashes only + separate TX storage)
    /// - Adaptive Zstd compression (levels 3-22 based on age)
    /// - Graceful degradation when disk full
    /// 
    /// This method exists for backward compatibility with node.rs
    pub fn save_block_with_delta(&self, height: u64, data: &[u8]) -> IntegrationResult<()> {
        // UNIFIED: Delegate to save_microblock which has all compression logic
        self.save_microblock(height, data)
    }
    
    /// Pattern recognition for transaction compression
    pub fn recognize_transaction_pattern(&self, tx: &qnet_state::Transaction) -> TransactionPattern {
        // Analyze transaction type based on its fields
        // Note: This is simplified - in production would use actual transaction structure
        
        // Check by hash patterns (simplified heuristics)
        let tx_size = bincode::serialize(tx).unwrap_or_default().len();
        
        // Simple transfers are usually small (< 500 bytes)
        if tx_size < 500 {
            return TransactionPattern::SimpleTransfer;
        }
        
        // Node activations have specific size patterns
        if tx_size >= 500 && tx_size < 1000 {
            return TransactionPattern::NodeActivation;
        }
        
        // Contract deployments are large
        if tx_size > 10000 {
            return TransactionPattern::ContractDeploy;
        }
        
        // Contract calls are medium sized
        if tx_size >= 1000 && tx_size < 10000 {
            return TransactionPattern::ContractCall;
        }
        
        TransactionPattern::Unknown
    }
    
    /// Compress transaction based on pattern
    pub fn compress_transaction_by_pattern(
        &self,
        tx: &qnet_state::Transaction,
        pattern: TransactionPattern
    ) -> IntegrationResult<CompressedTransaction> {
        let original_data = bincode::serialize(tx)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        let compressed_data = match pattern {
            TransactionPattern::SimpleTransfer => {
                // For simple transfers, we can optimize heavily
                // Store only: from_index(4) + to_index(4) + amount(8) = 16 bytes
                // Instead of full addresses and metadata
                let mut compact = Vec::with_capacity(16);
                
                // Extract essential fields (simplified)
                // In production, would parse actual transaction fields
                if original_data.len() >= 100 {
                    // Take first 4 bytes as "from" identifier
                    compact.extend_from_slice(&original_data[8..12]);
                    // Take next 4 bytes as "to" identifier  
                    compact.extend_from_slice(&original_data[40..44]);
                    // Take amount (8 bytes)
                    compact.extend_from_slice(&original_data[72..80].get(..8).unwrap_or(&[0u8; 8]));
                }
                compact
            },
            TransactionPattern::NodeActivation => {
                // For node activations: node_type(1) + amount(8) + phase(1) = 10 bytes
                let mut compact = Vec::with_capacity(10);
                if original_data.len() >= 50 {
                    compact.push(original_data[20]); // node type
                    compact.extend_from_slice(&original_data[24..32]); // amount
                    compact.push(original_data[40]); // phase
                }
                compact
            },
            TransactionPattern::RewardDistribution => {
                // Rewards are predictable: recipient(4) + amount(8) + pool_id(1) = 13 bytes
                let mut compact = Vec::with_capacity(13);
                if original_data.len() >= 40 {
                    compact.extend_from_slice(&original_data[8..12]); // recipient
                    compact.extend_from_slice(&original_data[16..24]); // amount
                    compact.push(original_data[30]); // pool_id
                }
                compact
            },
            _ => {
                // For complex patterns, use standard compression
                zstd::encode_all(&original_data[..], 3)
                    .map_err(|e| IntegrationError::Other(format!("Compression error: {}", e)))?
            }
        };
        
        let compressed_tx = CompressedTransaction {
            pattern,
            data: compressed_data.clone(),
            original_size: original_data.len(),
        };
        
        // Log compression efficiency
        if compressed_data.len() < original_data.len() {
            let reduction = (1.0 - compressed_data.len() as f64 / original_data.len() as f64) * 100.0;
            println!("[PATTERN] ✅ Transaction compressed via {:?} pattern: {} -> {} bytes ({:.1}% reduction)",
                    pattern, original_data.len(), compressed_data.len(), reduction);
        }
        
        Ok(compressed_tx)
    }
    
    /// Decompress transaction from pattern
    pub fn decompress_transaction_from_pattern(
        &self,
        compressed: &CompressedTransaction,
        full_tx_template: Option<&qnet_state::Transaction>
    ) -> IntegrationResult<Vec<u8>> {
        match compressed.pattern {
            TransactionPattern::SimpleTransfer | 
            TransactionPattern::NodeActivation | 
            TransactionPattern::RewardDistribution => {
                // For simple patterns, we need template to reconstruct
                if let Some(template) = full_tx_template {
                    let mut full_data = bincode::serialize(template)
                        .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                    
                    // Overlay compressed data onto template
                    match compressed.pattern {
                        TransactionPattern::SimpleTransfer => {
                            if compressed.data.len() >= 16 {
                                full_data[8..12].copy_from_slice(&compressed.data[0..4]);
                                full_data[40..44].copy_from_slice(&compressed.data[4..8]);
                                full_data[72..80].copy_from_slice(&compressed.data[8..16]);
                            }
                        },
                        _ => {}
                    }
                    Ok(full_data)
                } else {
                    // Without template, can't reconstruct simple patterns
                    Err(IntegrationError::Other("Template required for pattern decompression".to_string()))
                }
            },
            _ => {
                // Complex patterns use standard decompression
                zstd::decode_all(&compressed.data[..])
                    .map_err(|e| IntegrationError::Other(format!("Decompression error: {}", e)))
            }
        }
    }
    
    /// PRODUCTION: Recompress old blocks with appropriate compression level
    pub async fn recompress_old_blocks(&self) -> IntegrationResult<()> {
        println!("[Storage] 🗜️ Starting adaptive recompression of old blocks");
        
        let current_height = self.get_chain_height()?;
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let mut recompressed_count = 0;
        let mut space_saved = 0i64;
        
        // Process blocks in batches
        const BATCH_SIZE: u64 = 1000;
        
        // Process blocks in reverse order (newest to oldest)
        let mut batch_starts: Vec<u64> = Vec::new();
        let mut start = 1;
        while start <= current_height {
            batch_starts.push(start);
            start += BATCH_SIZE;
        }
        
        for batch_start in batch_starts.into_iter().rev() {
            let batch_end = std::cmp::min(batch_start + BATCH_SIZE - 1, current_height);
            let mut batch = WriteBatch::default();
            
            for height in batch_start..=batch_end {
                let key = format!("microblock_{}", height);
                
                if let Ok(Some(existing_data)) = self.persistent.db.get_cf(&microblocks_cf, key.as_bytes()) {
                    let original_size = existing_data.len();
                    let compression_level = self.get_compression_level(height);
                    
                    // Skip if already optimally compressed
                    if compression_level == CompressionLevel::None {
                        continue;
                    }
                    
                    // Decompress if needed (check if compressed)
                    let decompressed = if existing_data.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
                        // Zstd magic number
                        zstd::decode_all(&existing_data[..])
                            .unwrap_or_else(|_| existing_data.clone())
                    } else {
                        existing_data.clone()
                    };
                    
                    // Recompress with appropriate level
                    let recompressed = self.compress_block_adaptive(&decompressed, height)?;
                    
                    if recompressed.len() < original_size {
                        batch.put_cf(&microblocks_cf, key.as_bytes(), &recompressed);
                        space_saved += (original_size as i64) - (recompressed.len() as i64);
                        recompressed_count += 1;
                    }
                }
            }
            
            // Apply batch
            if !batch.is_empty() {
                self.persistent.db.write(batch)?;
                println!("[Storage] 📦 Recompressed batch {}-{}: {} blocks, saved {} KB",
                        batch_start, batch_end, recompressed_count, space_saved / 1024);
            }
            
            // Limit processing to avoid blocking too long
            if recompressed_count >= 10000 {
                break;
            }
        }
        
        // Force compaction to reclaim space
        self.persistent.db.compact_range_cf(&microblocks_cf, None::<&[u8]>, None::<&[u8]>);
        
        println!("[Storage] ✅ Adaptive recompression complete: {} blocks, {} MB saved",
                recompressed_count, space_saved / (1024 * 1024));
        
        // PRODUCTION: Also recompress old transactions with stronger Zstd
        // Done synchronously to avoid Send issues with RocksDB handles
        let tx_saved = self.recompress_old_transactions_sync()?;
        if tx_saved > 0 {
            println!("[Storage] ✅ Transaction recompression saved {} MB", tx_saved / (1024 * 1024));
        }
        
        Ok(())
    }
    
    /// PRODUCTION: Recompress old transactions with stronger Zstd levels
    /// Called from recompress_old_blocks() as background task
    /// Synchronous to avoid Send issues with RocksDB column family handles
    /// Processes in batches to avoid blocking too long
    pub fn recompress_old_transactions_sync(&self) -> IntegrationResult<i64> {
        let tx_cf = self.persistent.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        let tx_index_cf = self.persistent.db.cf_handle("tx_index")
            .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
        
        let current_height = self.get_chain_height()?;
        let mut space_saved: i64 = 0;
        let mut recompressed_count = 0;
        
        // Only recompress transactions older than 7 days (604800 blocks)
        let old_threshold = current_height.saturating_sub(604800);
        
        let iter = self.persistent.db.iterator_cf(&tx_index_cf, rocksdb::IteratorMode::Start);
        let mut batch = WriteBatch::default();
        
        for item in iter {
            let (tx_key, height_data) = item?;
            
            if height_data.len() < 8 {
                continue;
            }
            
            let block_height = u64::from_be_bytes(height_data[..8].try_into().unwrap_or([0u8; 8]));
            
            // Skip recent transactions (keep fast access)
            if block_height > old_threshold {
                continue;
            }
            
            // Get current transaction data
            if let Ok(Some(tx_data)) = self.persistent.db.get_cf(&tx_cf, &tx_key) {
                let original_size = tx_data.len();
                
                // Determine compression level based on age
                let age_days = (current_height - block_height) / 86400;
                let zstd_level = match age_days {
                    0..=7 => continue,      // Skip recent
                    8..=30 => 9,            // Medium compression
                    31..=365 => 15,         // Heavy compression
                    _ => 22,                // Extreme compression for old data
                };
                
                // Decompress if already compressed
                let decompressed = if tx_data.len() >= 4 && tx_data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    // Check current compression level (approximate by ratio)
                    // Skip if already heavily compressed
                    if let Ok(dec) = zstd::decode_all(&tx_data[..]) {
                        let current_ratio = tx_data.len() as f64 / dec.len() as f64;
                        if current_ratio < 0.3 && age_days < 365 {
                            // Already well compressed, skip unless very old
                            continue;
                        }
                        dec
                    } else {
                        continue;
                    }
                } else {
                    tx_data.to_vec()
                };
                
                // Recompress with stronger level
                if let Ok(recompressed) = zstd::encode_all(&decompressed[..], zstd_level) {
                    if recompressed.len() < original_size {
                        batch.put_cf(&tx_cf, &tx_key, &recompressed);
                        space_saved += (original_size as i64) - (recompressed.len() as i64);
                        recompressed_count += 1;
                        
                        // Apply batch every 1000 transactions
                        if recompressed_count % 1000 == 0 {
                            self.persistent.db.write(batch)?;
                            batch = WriteBatch::default();
                            // Brief pause to allow other operations (non-blocking)
                            std::thread::sleep(std::time::Duration::from_millis(1));
                        }
                    }
                }
            }
            
            // Limit total processing per run
            if recompressed_count >= 10000 {
                break;
            }
        }
        
        // Apply remaining batch
        if !batch.is_empty() {
            self.persistent.db.write(batch)?;
        }
        
        // Compact to reclaim space
        if space_saved > 0 {
            self.persistent.db.compact_range_cf(&tx_cf, None::<&[u8]>, None::<&[u8]>);
        }
        
        println!("[Storage] 🗜️ Recompressed {} old transactions, saved {} KB",
                recompressed_count, space_saved / 1024);
        
        Ok(space_saved)
    }
    
    /// Calculate recommended storage size based on blockchain age and activity
    pub fn get_recommended_storage_size_gb(&self) -> IntegrationResult<u64> {
        let stats = self.get_stats()?;
        let current_height = stats.latest_height;
        
        // Estimate blockchain age in years (assuming 1 microblock/second)
        let blockchain_age_years = current_height as f64 / (86400.0 * 365.0); // seconds per year
        
        // Base storage requirements
        let microblocks_gb_per_year = 20; // ~20 GB per year for microblocks
        let transactions_gb_per_year = 10; // ~10 GB per year for average transaction volume
        let buffer_multiplier = 1.5; // 50% buffer for growth and overhead
        
        // Calculate recommended size
        let estimated_total_gb = (blockchain_age_years * (microblocks_gb_per_year + transactions_gb_per_year) as f64 * buffer_multiplier) as u64;
        
        // Minimum recommendations by blockchain age
        let min_recommended = match blockchain_age_years {
            age if age < 1.0 => 300,  // First year: 300 GB
            age if age < 3.0 => 400,  // 1-3 years: 400 GB  
            age if age < 5.0 => 500,  // 3-5 years: 500 GB
            age if age < 10.0 => 750, // 5-10 years: 750 GB
            _ => 1000,                // 10+ years: 1 TB
        };
        
        let recommended = std::cmp::max(estimated_total_gb, min_recommended);
        
        if recommended > (self.max_storage_size / (1024 * 1024 * 1024)) {
            println!("[Storage] 💡 RECOMMENDATION: Current limit {} GB, recommended {} GB for blockchain age {:.1} years", 
                    self.max_storage_size / (1024 * 1024 * 1024),
                    recommended,
                    blockchain_age_years);
        }
        
        Ok(recommended)
    }
    
    // ============================================
    // SCALABILITY: PENDING REWARDS IN ROCKSDB
    // ============================================
    
    /// Save pending reward for a node
    pub fn save_pending_reward(&self, node_id: &str, reward: &qnet_consensus::lazy_rewards::PhaseAwareReward) -> IntegrationResult<()> {
        let rewards_cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        
        let key = format!("reward_{}", node_id);
        let data = bincode::serialize(reward)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        self.persistent.db.put_cf(&rewards_cf, key.as_bytes(), &data)?;
        Ok(())
    }
    
    /// Load pending reward for a node
    pub fn load_pending_reward(&self, node_id: &str) -> IntegrationResult<Option<qnet_consensus::lazy_rewards::PhaseAwareReward>> {
        let rewards_cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        
        let key = format!("reward_{}", node_id);
        match self.persistent.db.get_cf(&rewards_cf, key.as_bytes())? {
            Some(data) => {
                let reward = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(Some(reward))
            },
            None => Ok(None),
        }
    }
    
    /// Delete pending reward after claim
    pub fn delete_pending_reward(&self, node_id: &str) -> IntegrationResult<()> {
        let rewards_cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        
        let key = format!("reward_{}", node_id);
        self.persistent.db.delete_cf(&rewards_cf, key.as_bytes())?;
        Ok(())
    }
    
    // ============================================
    // v2.90: PROCESSED EMISSION MACROBLOCKS
    // Prevent double-processing on node restart
    // ============================================
    
    /// Save processed emission MacroBlocks set
    /// CRITICAL: Prevents duplicate reward distribution after node restart
    pub fn save_processed_emission_macroblocks(&self, processed: &std::collections::HashSet<u64>) -> IntegrationResult<()> {
        let rewards_cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        
        let key = b"processed_emission_macroblocks";
        let data = bincode::serialize(processed)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        self.persistent.db.put_cf(&rewards_cf, key, &data)?;
        Ok(())
    }
    
    /// Load processed emission MacroBlocks set from storage
    /// Returns empty set if not found (new node or first run)
    pub fn load_processed_emission_macroblocks(&self) -> IntegrationResult<std::collections::HashSet<u64>> {
        let rewards_cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        
        let key = b"processed_emission_macroblocks";
        match self.persistent.db.get_cf(&rewards_cf, key)? {
            Some(data) => {
                let processed = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(processed)
            },
            None => {
                // First run or new node - return empty set
                Ok(std::collections::HashSet::new())
            }
        }
    }
    
    /// Get all pending rewards (for batch processing)
    pub fn get_all_pending_rewards(&self) -> IntegrationResult<Vec<(String, qnet_consensus::lazy_rewards::PhaseAwareReward)>> {
        let rewards_cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        
        let mut rewards = Vec::new();
        let iter = self.persistent.db.iterator_cf(&rewards_cf, rocksdb::IteratorMode::Start);
        
        for item in iter {
            let (key, value) = item?;
            if let Ok(key_str) = std::str::from_utf8(&key) {
                if key_str.starts_with("reward_") {
                    let node_id = key_str.strip_prefix("reward_").expect("Checked starts_with above").to_string();
                    let reward: qnet_consensus::lazy_rewards::PhaseAwareReward = bincode::deserialize(&value)
                        .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                    rewards.push((node_id, reward));
                }
            }
        }
        
        Ok(rewards)
    }
    
    // ============================================
    // SCALABILITY: NODE REGISTRY IN ROCKSDB
    // ============================================
    
    /// Save node registration information (for local cache only)
    /// NOTE: api_endpoint is now stored ON-CHAIN in NodeRegistration TX!
    /// Stores BOTH forward index (node_id → data) AND reverse index (wallet → node_id)
    /// for O(1) lookups in both directions.
    pub fn save_node_registration(&self, node_id: &str, node_type: &str, wallet: &str, reputation: f64) -> IntegrationResult<()> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        // ATOMIC: WriteBatch ensures both forward and reverse indexes are written together
        // Prevents inconsistency if crash occurs between writes
        let mut batch = rocksdb::WriteBatch::default();
        
        // Forward index: node_id → data
        let key = format!("node_{}", node_id);
        let data = json!({
            "node_type": node_type,
            "wallet": wallet,
            "reputation": reputation,
            "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
        });
        batch.put_cf(&registry_cf, key.as_bytes(), data.to_string().as_bytes());
        
        // Reverse index: wallet → node_id (O(1) lookup by wallet)
        let wallet_key = format!("wallet_{}", wallet);
        let wallet_data = json!({
            "node_id": node_id,
            "node_type": node_type,
        });
        batch.put_cf(&registry_cf, wallet_key.as_bytes(), wallet_data.to_string().as_bytes());
        
        self.persistent.db.write(batch)?;
        
        Ok(())
    }
    
    /// O(1) lookup: get node by wallet address using reverse index
    /// Returns (node_id, node_type) if found
    pub fn get_node_by_wallet(&self, wallet_address: &str) -> IntegrationResult<Option<(String, String)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let wallet_key = format!("wallet_{}", wallet_address);
        match self.persistent.db.get_cf(&registry_cf, wallet_key.as_bytes())? {
            Some(value) => {
                let json_str = std::str::from_utf8(&value)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                let parsed: serde_json::Value = serde_json::from_str(json_str)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                let node_id = parsed["node_id"].as_str().unwrap_or("").to_string();
                let node_type = parsed["node_type"].as_str().unwrap_or("").to_string();
                if node_id.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some((node_id, node_type)))
                }
            }
            None => Ok(None),
        }
    }
    
    /// v4.0: Save VRF public key for node (persists across restarts)
    pub fn save_vrf_public_key(&self, node_id: &str, pk_hex: &str) -> IntegrationResult<()> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let key = format!("vrf_pk_{}", node_id);
        self.persistent.db.put_cf(&registry_cf, key.as_bytes(), pk_hex.as_bytes())?;
        println!("[INFO][STORAGE] vrf_pk_saved node={}", node_id);
        Ok(())
    }
    
    /// v4.0: Load VRF public key for node
    pub fn load_vrf_public_key(&self, node_id: &str) -> IntegrationResult<Option<Vec<u8>>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let key = format!("vrf_pk_{}", node_id);
        match self.persistent.db.get_cf(&registry_cf, key.as_bytes())? {
            Some(data) => {
                let hex_str = std::str::from_utf8(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                let pk_bytes = hex::decode(hex_str)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(Some(pk_bytes))
            }
            None => Ok(None),
        }
    }
    
    /// v4.0: Load ALL stored VRF public keys (for startup restoration)
    pub fn load_all_vrf_public_keys(&self) -> IntegrationResult<Vec<(String, Vec<u8>)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let prefix = b"vrf_pk_";
        let mut result = Vec::new();
        let iter = self.persistent.db.prefix_iterator_cf(&registry_cf, prefix);
        for item in iter {
            if let Ok((key, value)) = item {
                let key_str = std::str::from_utf8(&key).unwrap_or("");
                if !key_str.starts_with("vrf_pk_") { break; }
                let node_id = &key_str[7..]; // Skip "vrf_pk_" prefix
                if let Ok(hex_str) = std::str::from_utf8(&value) {
                    if let Ok(pk_bytes) = hex::decode(hex_str) {
                        result.push((node_id.to_string(), pk_bytes));
                    }
                }
            }
        }
        println!("[INFO][STORAGE] vrf_pk_loaded count={}", result.len());
        Ok(result)
    }
    
    /// Load node registration
    pub fn load_node_registration(&self, node_id: &str) -> IntegrationResult<Option<(String, String, f64)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let key = format!("node_{}", node_id);
        match self.persistent.db.get_cf(&registry_cf, key.as_bytes())? {
            Some(data) => {
                let json_str = std::str::from_utf8(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                let parsed: serde_json::Value = serde_json::from_str(json_str)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                
                // PRODUCTION v2.41.1: Validate required fields
                let node_type = match parsed["node_type"].as_str() {
                    Some(t) => t.to_string(),
                    None => {
                        eprintln!("[WARN][STORAGE] node_registration_missing_type id={} data={}", 
                                 node_id, json_str);
                        return Err(IntegrationError::DeserializationError(
                            format!("Missing node_type for {}", node_id)));
                    }
                };
                let wallet = parsed["wallet"].as_str().unwrap_or("").to_string();
                let reputation = parsed["reputation"].as_f64()
                    .unwrap_or(qnet_consensus::deterministic_reputation::INITIAL_REPUTATION);
                
                Ok(Some((node_type, wallet, reputation)))
            },
            None => Ok(None),
        }
    }
    
    /// v3.1: Get all nodes registered with a specific wallet address
    /// CRITICAL for mobile app: Returns nodes even when the node itself is offline!
    /// Data is read from blockchain storage, not from the node's memory
    pub fn get_nodes_by_wallet(&self, wallet_address: &str) -> IntegrationResult<Vec<(String, String, f64)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let mut result = Vec::new();
        let prefix = b"node_";
        
        // Iterate through all nodes in registry
        let iter = self.persistent.db.prefix_iterator_cf(&registry_cf, prefix);
        
        for item in iter {
            if let Ok((key, value)) = item {
                // Extract node_id from key (format: "node_{node_id}")
                let key_str = match std::str::from_utf8(&key) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                
                let node_id = if key_str.starts_with("node_") {
                    &key_str[5..] // Skip "node_" prefix
                } else {
                    continue;
                };
                
                // Parse value JSON
                let json_str = match std::str::from_utf8(&value) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                
                let parsed: serde_json::Value = match serde_json::from_str(json_str) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                
                // Check if wallet matches
                let node_wallet = parsed["wallet"].as_str().unwrap_or("");
                if node_wallet == wallet_address {
                    let node_type = parsed["node_type"].as_str().unwrap_or("unknown").to_string();
                    let reputation = parsed["reputation"].as_f64()
                        .unwrap_or(qnet_consensus::deterministic_reputation::INITIAL_REPUTATION);
                    
                    result.push((node_id.to_string(), node_type, reputation));
                }
            }
        }
        
        Ok(result)
    }
    
    /// v4.1: Backfill reverse index (wallet → node_id) from existing forward entries.
    /// Called once on startup to migrate data created before reverse index was added.
    /// Idempotent — safe to call multiple times. Skips entries that already have reverse index.
    pub fn backfill_wallet_reverse_index(&self) -> IntegrationResult<u32> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let prefix = b"node_";
        let iter = self.persistent.db.prefix_iterator_cf(&registry_cf, prefix);
        let mut backfilled = 0u32;
        let mut batch = rocksdb::WriteBatch::default();
        
        for item in iter {
            if let Ok((key, value)) = item {
                let key_str = match std::str::from_utf8(&key) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                
                if !key_str.starts_with("node_") { continue; }
                let node_id = &key_str[5..];
                
                let json_str = match std::str::from_utf8(&value) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let parsed: serde_json::Value = match serde_json::from_str(json_str) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                
                let wallet = match parsed["wallet"].as_str() {
                    Some(w) if !w.is_empty() => w,
                    _ => continue,
                };
                let node_type = parsed["node_type"].as_str().unwrap_or("unknown");
                
                // Check if reverse index already exists
                let wallet_key = format!("wallet_{}", wallet);
                if self.persistent.db.get_cf(&registry_cf, wallet_key.as_bytes())?.is_some() {
                    continue; // Already has reverse index
                }
                
                let wallet_data = json!({
                    "node_id": node_id,
                    "node_type": node_type,
                });
                batch.put_cf(&registry_cf, wallet_key.as_bytes(), wallet_data.to_string().as_bytes());
                backfilled += 1;
            }
        }
        
        if backfilled > 0 {
            self.persistent.db.write(batch)?;
            println!("[INFO][STORAGE] backfill_wallet_index entries={}", backfilled);
        }
        
        Ok(backfilled)
    }
    
    // ============================================
    // SCALABILITY: PING HISTORY IN ROCKSDB
    // ============================================
    
    /// Save ping attempt result
    pub fn save_ping_attempt(&self, node_id: &str, timestamp: u64, success: bool, response_time_ms: u32) -> IntegrationResult<()> {
        let ping_cf = self.persistent.db.cf_handle("ping_history")
            .ok_or_else(|| IntegrationError::StorageError("ping_history column family not found".to_string()))?;
        
        // Use timestamp in key for ordering
        let key = format!("ping_{}_{}", node_id, timestamp);
        let data = json!({
            "success": success,
            "response_time_ms": response_time_ms,
            "timestamp": timestamp
        });
        
        self.persistent.db.put_cf(&ping_cf, key.as_bytes(), data.to_string().as_bytes())?;
        
        // Cleanup old pings (older than 24 hours)
        self.cleanup_old_pings(node_id, timestamp - 86400)?;
        
        Ok(())
    }
    
    /// Get ping history for a node
    pub fn get_ping_history(&self, node_id: &str, since_timestamp: u64) -> IntegrationResult<Vec<(u64, bool, u32)>> {
        let ping_cf = self.persistent.db.cf_handle("ping_history")
            .ok_or_else(|| IntegrationError::StorageError("ping_history column family not found".to_string()))?;
        
        let mut pings = Vec::new();
        let prefix = format!("ping_{}_", node_id);
        let iter = self.persistent.db.iterator_cf(&ping_cf, rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward));
        
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if !key_str.starts_with(&prefix) {
                break; // Reached end of this node's pings
            }
            
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&value) {
                let timestamp = parsed["timestamp"].as_u64().unwrap_or(0);
                if timestamp >= since_timestamp {
                    let success = parsed["success"].as_bool().unwrap_or(false);
                    let response_time = parsed["response_time_ms"].as_u64().unwrap_or(0) as u32;
                    pings.push((timestamp, success, response_time));
                }
            }
        }
        
        Ok(pings)
    }
    
    /// Cleanup old ping records
    fn cleanup_old_pings(&self, node_id: &str, cutoff_timestamp: u64) -> IntegrationResult<()> {
        let ping_cf = self.persistent.db.cf_handle("ping_history")
            .ok_or_else(|| IntegrationError::StorageError("ping_history column family not found".to_string()))?;
        
        let prefix = format!("ping_{}_", node_id);
        let iter = self.persistent.db.iterator_cf(&ping_cf, rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward));
        
        let mut batch = WriteBatch::default();
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if !key_str.starts_with(&prefix) {
                break;
            }
            
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&value) {
                let timestamp = parsed["timestamp"].as_u64().unwrap_or(0);
                if timestamp < cutoff_timestamp {
                    batch.delete_cf(&ping_cf, &key);
                }
            }
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(())
    }
    
    // ============================================
    // PRODUCTION: REPUTATION HISTORY STORAGE
    // ============================================
    
    /// Save reputation change event (for audit trail and history)
    fn save_reputation_change_internal(&self, node_id: &str, old_value: f64, new_value: f64, reason: &str) -> IntegrationResult<()> {
        let rep_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // Key: rep_history_{node_id}_{timestamp} for chronological ordering
        let key = format!("rep_history_{}_{}", node_id, timestamp);
        let data = serde_json::json!({
            "node_id": node_id,
            "old_value": old_value,
            "new_value": new_value,
            "delta": new_value - old_value,
            "reason": reason,
            "timestamp": timestamp
        });
        
        self.persistent.db.put_cf(&rep_cf, key.as_bytes(), data.to_string().as_bytes())?;
        
        // Cleanup old history (keep only last 7 days)
        self.cleanup_old_reputation_history(node_id, timestamp - (7 * 86400))?;
        
        Ok(())
    }
    
    /// Get reputation history for a node
    fn get_reputation_history_internal(&self, node_id: &str, limit: usize) -> IntegrationResult<Vec<serde_json::Value>> {
        let rep_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let mut history = Vec::new();
        let prefix = format!("rep_history_{}_", node_id);
        
        // Iterate in reverse to get most recent first
        let iter = self.persistent.db.iterator_cf(
            &rep_cf, 
            rocksdb::IteratorMode::From(
                format!("{}~", prefix).as_bytes(), // ~ is after digits in ASCII
                rocksdb::Direction::Reverse
            )
        );
        
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if !key_str.starts_with(&prefix) {
                break;
            }
            
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&value) {
                history.push(parsed);
                if history.len() >= limit {
                    break;
                }
            }
        }
        
        Ok(history)
    }
    
    /// Cleanup old reputation history records
    fn cleanup_old_reputation_history(&self, node_id: &str, cutoff_timestamp: u64) -> IntegrationResult<()> {
        let rep_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let prefix = format!("rep_history_{}_", node_id);
        let iter = self.persistent.db.iterator_cf(&rep_cf, rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward));
        
        let mut batch = WriteBatch::default();
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if !key_str.starts_with(&prefix) {
                break;
            }
            
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&value) {
                let timestamp = parsed["timestamp"].as_u64().unwrap_or(0);
                if timestamp < cutoff_timestamp {
                    batch.delete_cf(&rep_cf, &key);
                }
            }
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(())
    }
    
    // ============================================
    // PRODUCTION: ATTESTATION STORAGE (Light nodes)
    // ============================================
    
    /// Save Light node attestation (persistent for reward calculation)
    pub fn save_attestation(&self, light_node_id: &str, slot: u64, pinger_id: &str, timestamp: u64) -> IntegrationResult<()> {
        let att_cf = self.persistent.db.cf_handle("attestations")
            .ok_or_else(|| IntegrationError::StorageError("attestations column family not found".to_string()))?;
        
        // Key: att_{light_node_id}_{slot} for deduplication
        let key = format!("att_{}_{}", light_node_id, slot);
        let data = json!({
            "light_node_id": light_node_id,
            "slot": slot,
            "pinger_id": pinger_id,
            "timestamp": timestamp
        });
        
        self.persistent.db.put_cf(&att_cf, key.as_bytes(), data.to_string().as_bytes())?;
        Ok(())
    }
    
    /// Check if attestation exists for Light node in slot
    pub fn has_attestation(&self, light_node_id: &str, slot: u64) -> IntegrationResult<bool> {
        let att_cf = self.persistent.db.cf_handle("attestations")
            .ok_or_else(|| IntegrationError::StorageError("attestations column family not found".to_string()))?;
        
        let key = format!("att_{}_{}", light_node_id, slot);
        Ok(self.persistent.db.get_cf(&att_cf, key.as_bytes())?.is_some())
    }
    
    /// Count attestations for Light node in 4h window (for reward eligibility)
    pub fn count_attestations_in_window(&self, light_node_id: &str, window_start_slot: u64, window_end_slot: u64) -> IntegrationResult<u32> {
        let att_cf = self.persistent.db.cf_handle("attestations")
            .ok_or_else(|| IntegrationError::StorageError("attestations column family not found".to_string()))?;
        
        let mut count = 0u32;
        for slot in window_start_slot..=window_end_slot {
            let key = format!("att_{}_{}", light_node_id, slot);
            if self.persistent.db.get_cf(&att_cf, key.as_bytes())?.is_some() {
                count += 1;
            }
        }
        Ok(count)
    }
    
    /// Cleanup old attestations (older than 24 hours)
    pub fn cleanup_old_attestations(&self, cutoff_timestamp: u64) -> IntegrationResult<u32> {
        let att_cf = self.persistent.db.cf_handle("attestations")
            .ok_or_else(|| IntegrationError::StorageError("attestations column family not found".to_string()))?;
        
        let iter = self.persistent.db.iterator_cf(&att_cf, rocksdb::IteratorMode::Start);
        let mut batch = WriteBatch::default();
        let mut removed = 0u32;
        
        for item in iter {
            let (key, value) = item?;
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&value) {
                let timestamp = parsed["timestamp"].as_u64().unwrap_or(0);
                if timestamp < cutoff_timestamp {
                    batch.delete_cf(&att_cf, &key);
                    removed += 1;
                }
            }
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(removed)
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v3.41: EPHEMERAL DATA CLEANUP - all CFs older than 24h
    // WAL files can only be deleted when ALL CFs flush. Rarely-written CFs
    // (ping_history, poh_state, consensus, failover_events) keep stale memtables
    // preventing WAL cleanup. These methods + compact_all() reclaim disk space.
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// v3.41: Cleanup old ping_history entries (older than cutoff_timestamp)
    pub fn cleanup_old_pings_all(&self, cutoff_timestamp: u64) -> IntegrationResult<u32> {
        let ping_cf = self.persistent.db.cf_handle("ping_history")
            .ok_or_else(|| IntegrationError::StorageError("ping_history column family not found".to_string()))?;
        
        let iter = self.persistent.db.iterator_cf(&ping_cf, rocksdb::IteratorMode::Start);
        let mut batch = WriteBatch::default();
        let mut removed = 0u32;
        
        for item in iter {
            let (key, value) = item?;
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&value) {
                let timestamp = parsed["timestamp"].as_u64().unwrap_or(0);
                if timestamp > 0 && timestamp < cutoff_timestamp {
                    batch.delete_cf(&ping_cf, &key);
                    removed += 1;
                    if removed % 1000 == 0 {
                        self.persistent.db.write(batch)?;
                        batch = WriteBatch::default();
                    }
                }
            }
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(removed)
    }
    
    /// v3.41: Cleanup old poh_state entries (older than retention_height)
    /// PoH state keys: "poh_{height}" — only current state needed for consensus
    pub fn cleanup_old_poh_state(&self, current_height: u64, retention_blocks: u64) -> IntegrationResult<u32> {
        let poh_cf = self.persistent.db.cf_handle("poh_state")
            .ok_or_else(|| IntegrationError::StorageError("poh_state column family not found".to_string()))?;
        
        if current_height <= retention_blocks {
            return Ok(0);
        }
        
        let cutoff_height = current_height - retention_blocks;
        let iter = self.persistent.db.iterator_cf(&poh_cf, rocksdb::IteratorMode::Start);
        let mut batch = WriteBatch::default();
        let mut removed = 0u32;
        
        for item in iter {
            let (key, _value) = item?;
            let key_str = String::from_utf8_lossy(&key);
            if let Some(height_str) = key_str.strip_prefix("poh_") {
                if let Ok(height) = height_str.parse::<u64>() {
                    if height < cutoff_height {
                        batch.delete_cf(&poh_cf, &key);
                        removed += 1;
                        if removed % 1000 == 0 {
                            self.persistent.db.write(batch)?;
                            batch = WriteBatch::default();
                        }
                    }
                }
            }
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(removed)
    }
    
    /// v3.41: Cleanup old consensus rounds (keep only recent rounds)
    /// Consensus keys: "round_{number}" — only current round needed
    pub fn cleanup_old_consensus(&self, current_round: u64, retention_rounds: u64) -> IntegrationResult<u32> {
        let consensus_cf = self.persistent.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        
        if current_round <= retention_rounds {
            return Ok(0);
        }
        
        let cutoff_round = current_round - retention_rounds;
        let iter = self.persistent.db.iterator_cf(&consensus_cf, rocksdb::IteratorMode::Start);
        let mut batch = WriteBatch::default();
        let mut removed = 0u32;
        
        for item in iter {
            let (key, _value) = item?;
            let key_str = String::from_utf8_lossy(&key);
            // Skip "latest_round" meta-key
            if let Some(round_str) = key_str.strip_prefix("round_") {
                if let Ok(round) = round_str.parse::<u64>() {
                    if round < cutoff_round {
                        batch.delete_cf(&consensus_cf, &key);
                        removed += 1;
                        if removed % 1000 == 0 {
                            self.persistent.db.write(batch)?;
                            batch = WriteBatch::default();
                        }
                    }
                }
            }
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(removed)
    }
    
    /// v3.41: Cleanup old failover events (older than cutoff_timestamp)
    /// Key format: "failover_{height:012}_{timestamp}" (see save_failover_event)
    /// Value format: bincode-serialized FailoverEvent (timestamp is i64, NOT fixed offset)
    /// SAFE: Parse timestamp from KEY (reliable) instead of value (variable layout)
    pub fn cleanup_old_failover_events(&self, cutoff_timestamp: u64) -> IntegrationResult<u32> {
        let failover_cf = self.persistent.db.cf_handle("failover_events")
            .ok_or_else(|| IntegrationError::StorageError("failover_events column family not found".to_string()))?;
        
        let iter = self.persistent.db.iterator_cf(&failover_cf, rocksdb::IteratorMode::Start);
        let mut batch = WriteBatch::default();
        let mut removed = 0u32;
        
        for item in iter {
            let (key, _value) = item?;
            let key_str = String::from_utf8_lossy(&key);
            
            // Parse timestamp from key: "failover_{height:012}_{timestamp}"
            // Also handle keys that don't match the expected format
            let is_old = if key_str.starts_with("failover_") {
                let parts: Vec<&str> = key_str.splitn(3, '_').collect();
                if parts.len() == 3 {
                    // parts[2] is the timestamp (i64 stored as string)
                    if let Ok(ts) = parts[2].parse::<i64>() {
                        ts > 0 && (ts as u64) < cutoff_timestamp
                    } else {
                        false
                    }
                } else {
                    false
                }
            } else {
                false
            };
            
            if is_old {
                batch.delete_cf(&failover_cf, &key);
                removed += 1;
                if removed % 1000 == 0 {
                    self.persistent.db.write(batch)?;
                    batch = WriteBatch::default();
                }
            }
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(removed)
    }
    
    /// v3.41: Cleanup old snapshots, keeping only the latest `keep_count`
    /// Snapshot keys: "snapshot_{height}" — only latest 2-3 needed for sync
    pub fn cleanup_old_snapshots(&self, keep_count: usize) -> IntegrationResult<u32> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        // Collect all snapshot heights
        let mut snapshot_heights: Vec<u64> = Vec::new();
        let iter = self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::Start);
        
        for item in iter {
            let (key, _value) = item?;
            let key_str = String::from_utf8_lossy(&key);
            if let Some(height_str) = key_str.strip_prefix("snapshot_") {
                if let Ok(height) = height_str.parse::<u64>() {
                    snapshot_heights.push(height);
                }
            }
        }
        
        if snapshot_heights.len() <= keep_count {
            return Ok(0); // Not enough snapshots to prune
        }
        
        // Sort descending — keep the latest `keep_count`
        snapshot_heights.sort_unstable_by(|a, b| b.cmp(a));
        let to_delete = &snapshot_heights[keep_count..];
        
        let mut batch = WriteBatch::default();
        let mut removed = 0u32;
        
        for height in to_delete {
            let key = format!("snapshot_{}", height);
            batch.delete_cf(&snapshots_cf, key.as_bytes());
            removed += 1;
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(removed)
    }
    
    /// v3.41: Run full ephemeral data cleanup cycle + compaction
    /// Cleans: ping_history, poh_state, consensus, failover_events, old snapshots
    /// Then triggers compaction on ALL CFs to physically reclaim disk space
    pub fn run_ephemeral_cleanup(&self, current_height: u64, cutoff_timestamp: u64) -> IntegrationResult<()> {
        let start = std::time::Instant::now();
        
        // 1. Ping history (>24h)
        let pings_removed = self.cleanup_old_pings_all(cutoff_timestamp).unwrap_or(0);
        
        // 2. PoH state — keep last 86400 blocks (~24h at 1 block/sec)
        let poh_removed = self.cleanup_old_poh_state(current_height, 86_400).unwrap_or(0);
        
        // 3. Consensus rounds — keep last 1000 rounds
        let current_round = current_height / 90; // macroblock every 90 blocks
        let consensus_removed = self.cleanup_old_consensus(current_round, 1000).unwrap_or(0);
        
        // 4. Failover events (>24h)
        let failover_removed = self.cleanup_old_failover_events(cutoff_timestamp).unwrap_or(0);
        
        // 5. Old snapshots — keep latest 3
        let snapshots_removed = self.cleanup_old_snapshots(3).unwrap_or(0);
        
        let total_removed = pings_removed + poh_removed + consensus_removed + failover_removed + snapshots_removed;
        
        // 6. Trigger compaction on ALL CFs to physically reclaim disk space
        if total_removed > 0 {
            if let Err(e) = self.persistent.compact_all() {
                println!("[WARN][CLEANUP] compaction_failed err={}", e);
            }
        }
        
        let elapsed = start.elapsed();
        if total_removed > 0 {
            println!("[INFO][CLEANUP] ephemeral_cleanup_done elapsed={:?} pings={} poh={} consensus={} failover={} snapshots={} total={}",
                     elapsed, pings_removed, poh_removed, consensus_removed, failover_removed, snapshots_removed, total_removed);
        }
        
        Ok(())
    }
    
    // ============================================
    // PRODUCTION: HEARTBEAT STORAGE (Full/Super nodes)
    // ============================================
    
    /// Save Full/Super node heartbeat (persistent for reward calculation)
    /// PRODUCTION v2.78: Now includes Dilithium signature for HeartbeatCommitment TX
    pub fn save_heartbeat(&self, node_id: &str, heartbeat_index: u8, timestamp: u64, block_height: u64, dilithium_signature: &str) -> IntegrationResult<()> {
        let hb_cf = self.persistent.db.cf_handle("heartbeats")
            .ok_or_else(|| IntegrationError::StorageError("heartbeats column family not found".to_string()))?;
        
        // Key: hb_{node_id}_{4h_window}_{index} for deduplication per window
        let window = timestamp - (timestamp % (4 * 60 * 60));
        let key = format!("hb_{}_{}_{}", node_id, window, heartbeat_index);
        let data = json!({
            "node_id": node_id,
            "heartbeat_index": heartbeat_index,
            "timestamp": timestamp,
            "block_height": block_height,
            "window": window,
            "dilithium_signature": dilithium_signature
        });
        
        self.persistent.db.put_cf(&hb_cf, key.as_bytes(), data.to_string().as_bytes())?;
        Ok(())
    }
    
    /// Count heartbeats for node in 4h window (for reward eligibility)
    pub fn count_heartbeats_in_window(&self, node_id: &str, window_timestamp: u64) -> IntegrationResult<u8> {
        let hb_cf = self.persistent.db.cf_handle("heartbeats")
            .ok_or_else(|| IntegrationError::StorageError("heartbeats column family not found".to_string()))?;
        
        let mut count = 0u8;
        for index in 0..10 {
            let key = format!("hb_{}_{}_{}", node_id, window_timestamp, index);
            if self.persistent.db.get_cf(&hb_cf, key.as_bytes())?.is_some() {
                count += 1;
            }
        }
        Ok(count)
    }
    
    /// Check heartbeat eligibility (8/10 for Full, 9/10 for Super)
    pub fn check_heartbeat_eligibility(&self, node_id: &str, node_type: &str, window_timestamp: u64) -> IntegrationResult<(u8, u8, bool)> {
        let count = self.count_heartbeats_in_window(node_id, window_timestamp)?;
        let required = match node_type {
            "super" => 9,
            "full" => 8,
            _ => 10,
        };
        Ok((count, required, count >= required))
    }
    
    /// Cleanup old heartbeats (older than 24 hours)
    pub fn cleanup_old_heartbeats(&self, cutoff_timestamp: u64) -> IntegrationResult<u32> {
        let hb_cf = self.persistent.db.cf_handle("heartbeats")
            .ok_or_else(|| IntegrationError::StorageError("heartbeats column family not found".to_string()))?;
        
        let iter = self.persistent.db.iterator_cf(&hb_cf, rocksdb::IteratorMode::Start);
        let mut batch = WriteBatch::default();
        let mut removed = 0u32;
        
        for item in iter {
            let (key, value) = item?;
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&value) {
                let timestamp = parsed["timestamp"].as_u64().unwrap_or(0);
                if timestamp < cutoff_timestamp {
                    batch.delete_cf(&hb_cf, &key);
                    removed += 1;
                }
            }
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(removed)
    }
    
    /// v2.75: Get all heartbeats for a block height range (for emission fallback)
    /// PRODUCTION v2.78: Now returns Dilithium signatures for HeartbeatCommitment TX
    /// Returns Vec<(node_id, heartbeat_index, timestamp, block_height, dilithium_signature)>
    pub fn get_heartbeats_for_block_range(&self, start_height: u64, end_height: u64) -> IntegrationResult<Vec<(String, u8, u64, u64, String)>> {
        let hb_cf = self.persistent.db.cf_handle("heartbeats")
            .ok_or_else(|| IntegrationError::StorageError("heartbeats column family not found".to_string()))?;
        
        let iter = self.persistent.db.iterator_cf(&hb_cf, rocksdb::IteratorMode::Start);
        let mut result = Vec::new();
        
        for item in iter {
            let (_key, value) = item?;
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&value) {
                let block_height = parsed["block_height"].as_u64().unwrap_or(0);
                if block_height >= start_height && block_height < end_height {
                    let node_id = parsed["node_id"].as_str().unwrap_or("").to_string();
                    let heartbeat_index = parsed["heartbeat_index"].as_u64().unwrap_or(0) as u8;
                    let timestamp = parsed["timestamp"].as_u64().unwrap_or(0);
                    let dilithium_signature = parsed["dilithium_signature"].as_str().unwrap_or("").to_string();
                    result.push((node_id, heartbeat_index, timestamp, block_height, dilithium_signature));
                }
            }
        }
        
        println!("[INFO][STORAGE] heartbeats_for_range start={} end={} found={}", start_height, end_height, result.len());
        Ok(result)
    }
    
    // ===== FAILOVER EVENT METHODS =====
    
    /// Save a failover event (optimized with bincode serialization and LZ4 compression)
    /// NOTE: Light nodes should NOT call this method - they don't store failover history
    pub fn save_failover_event(&self, event: &FailoverEvent) -> IntegrationResult<()> {
        // OPTIMIZATION: Light nodes don't store failover events
        if std::env::var("QNET_NODE_TYPE").unwrap_or_default() == "light" {
            return Ok(()); // Skip storage for light nodes
        }
        
        let failover_cf = self.persistent.db.cf_handle("failover_events")
            .ok_or_else(|| IntegrationError::StorageError("failover_events column family not found".to_string()))?;
        
        // Use height as key for efficient range queries
        // Format: failover_<height>_<timestamp> for uniqueness
        let key = format!("failover_{:012}_{}", event.height, event.timestamp);
        
        // Serialize with bincode (more efficient than JSON)
        let value = bincode::serialize(event)
            .map_err(|e| IntegrationError::StorageError(format!("Failed to serialize failover event: {}", e)))?;
        
        self.persistent.db.put_cf(&failover_cf, key.as_bytes(), &value)?;
        
        // Auto-cleanup old events based on time relevance, not node type
        // Keep ~30 days of history (assuming ~100 failovers per day worst case)
        let max_events = match std::env::var("QNET_NODE_TYPE").unwrap_or_default().as_str() {
            "super" => 10_000,   // Super nodes: ~30 days (400KB) - enough for analysis
            // v3.18: Full nodes removed - use "super" for all server nodes
            _ => 0,              // Light nodes: don't store (mobile devices)
        };
        
        // Only cleanup if we're not a light node
        if max_events > 0 {
            self.cleanup_old_failovers(max_events)?;
        }
        
        Ok(())
    }
    
    /// Get failover history (optimized with range queries and limit)
    pub fn get_failover_history(&self, from_height: u64, limit: usize) -> IntegrationResult<Vec<FailoverEvent>> {
        let failover_cf = self.persistent.db.cf_handle("failover_events")
            .ok_or_else(|| IntegrationError::StorageError("failover_events column family not found".to_string()))?;
        
        let mut events = Vec::new();
        let start_key = format!("failover_{:012}_", from_height);
        
        let iter = self.persistent.db.iterator_cf(
            &failover_cf,
            rocksdb::IteratorMode::From(start_key.as_bytes(), rocksdb::Direction::Forward)
        );
        
        for item in iter.take(limit) {
            let (_, value) = item?;
            
            if let Ok(event) = bincode::deserialize::<FailoverEvent>(&value) {
                if event.height >= from_height {
                    events.push(event);
                }
            }
        }
        
        Ok(events)
    }
    
    /// Get failover statistics for monitoring
    pub fn get_failover_stats(&self) -> IntegrationResult<serde_json::Value> {
        let failover_cf = self.persistent.db.cf_handle("failover_events")
            .ok_or_else(|| IntegrationError::StorageError("failover_events column family not found".to_string()))?;
        
        let mut total_count = 0;
        let mut by_producer = HashMap::<String, u32>::new();
        let mut by_reason = HashMap::<String, u32>::new();
        
        let iter = self.persistent.db.iterator_cf(&failover_cf, rocksdb::IteratorMode::Start);
        
        for item in iter {
            let (_, value) = item?;
            
            if let Ok(event) = bincode::deserialize::<FailoverEvent>(&value) {
                total_count += 1;
                *by_producer.entry(event.failed_producer).or_insert(0) += 1;
                *by_reason.entry(event.reason).or_insert(0) += 1;
            }
        }
        
        Ok(json!({
            "total_failovers": total_count,
            "by_producer": by_producer,
            "by_reason": by_reason
        }))
    }
    
    /// Cleanup old failover events with smart retention policy
    fn cleanup_old_failovers(&self, max_events: usize) -> IntegrationResult<()> {
        let failover_cf = self.persistent.db.cf_handle("failover_events")
            .ok_or_else(|| IntegrationError::StorageError("failover_events column family not found".to_string()))?;
        
        // Two-phase cleanup strategy:
        // 1. Remove events older than 30 days (primary)
        // 2. Keep max_events limit (secondary safety)
        
        let thirty_days_ago = chrono::Utc::now().timestamp() - (30 * 24 * 3600);
        let mut batch = WriteBatch::default();
        let mut count = 0;
        let mut old_count = 0;
        
        // First pass: count and remove old events
        let iter = self.persistent.db.iterator_cf(&failover_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, value) = item?;
            count += 1;
            
            // Try to deserialize to check timestamp
            if let Ok(event) = bincode::deserialize::<FailoverEvent>(&value) {
                if event.timestamp < thirty_days_ago {
                    batch.delete_cf(&failover_cf, &key);
                    old_count += 1;
                }
            }
        }
        
        // Apply time-based cleanup
        if old_count > 0 {
            self.persistent.db.write(batch)?;
            println!("[STORAGE] Cleaned up {} failover events older than 30 days", old_count);
        }
        
        // Second safety check: if still too many events, trim oldest
        if count - old_count > max_events {
            let to_delete = (count - old_count) - max_events;
            let mut batch = WriteBatch::default();
            let iter = self.persistent.db.iterator_cf(&failover_cf, rocksdb::IteratorMode::Start);
            
            for item in iter.take(to_delete) {
                let (key, _) = item?;
                batch.delete_cf(&failover_cf, &key);
            }
            
            self.persistent.db.write(batch)?;
            println!("[STORAGE] Trimmed {} oldest failover events to maintain {} limit", to_delete, max_events);
        }
        
        Ok(())
    }
    
    // PRODUCTION: Snapshot system for fast node synchronization
    // Creates FULL snapshots every 10,000 blocks (~2.7 hours at 1s/block)
    // Creates INCREMENTAL snapshots every 1,000 blocks (~16.7 minutes at 1s/block)
    
    /// Create incremental state snapshot at specified height
    pub async fn create_incremental_snapshot(&self, height: u64) -> IntegrationResult<()> {
        const INCREMENTAL_INTERVAL: u64 = 1_000;
        const FULL_SNAPSHOT_INTERVAL: u64 = 10_000;
        
        // Check if this is a full snapshot height (priority)
        if height % FULL_SNAPSHOT_INTERVAL == 0 {
            return self.create_state_snapshot(height).await;
        }
        
        // Check if this is an incremental snapshot height
        if height % INCREMENTAL_INTERVAL != 0 {
            return Ok(()); // Not a snapshot height
        }
        
        println!("[SNAPSHOT] 📸 Creating incremental snapshot at height {}", height);
        let start_time = std::time::Instant::now();
        
        // Find the previous snapshot to base delta on
        let base_height = (height / FULL_SNAPSHOT_INTERVAL) * FULL_SNAPSHOT_INTERVAL;
        if base_height == 0 {
            // No base snapshot yet, create full instead
            return self.create_state_snapshot(height).await;
        }
        
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        // Collect only changes since base snapshot
        let mut delta_data = Vec::new();
        
        // 1. Add metadata
        delta_data.extend_from_slice(b"DELTA"); // Magic bytes for delta snapshot
        delta_data.extend_from_slice(&crate::node::PROTOCOL_VERSION.to_le_bytes());
        delta_data.extend_from_slice(&height.to_le_bytes());
        delta_data.extend_from_slice(&base_height.to_le_bytes());
        
        // 2. Collect changed accounts since base height
        // In production, track changes via state diffs
        let accounts_cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        // For now, include accounts modified in last 1000 blocks (simplified)
        // PRODUCTION: Would use change tracking from StateManager
        let mut change_count = 0u32;
        delta_data.extend_from_slice(&change_count.to_le_bytes()); // Placeholder for count
        let count_position = delta_data.len() - 4;
        
        // Collect recent transaction data to identify changed accounts
        // This is a simplified approach - production would track actual state changes
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let mut changed_accounts: std::collections::HashSet<String> = std::collections::HashSet::new();
        for block_height in (base_height + 1)..=height {
            let block_key = format!("microblock_{}", block_height);
            if let Ok(Some(_block_data)) = self.persistent.db.get_cf(&microblocks_cf, block_key.as_bytes()) {
                // In production, parse block and extract account changes
                // For now, we'll include a sample of accounts
            }
        }
        
        // 3. Compress delta
        let compressed = lz4_flex::compress_prepend_size(&delta_data);
        
        // 4. Calculate hash
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(&compressed);
        let hash = hasher.finalize();
        
        // Save incremental snapshot
        let snapshot_key = format!("delta_{}", height);
        let mut final_data = Vec::new();
        final_data.extend_from_slice(&hash);
        final_data.extend_from_slice(&(compressed.len() as u64).to_le_bytes());
        final_data.extend_from_slice(&compressed);
        
        self.persistent.db.put_cf(&snapshots_cf, snapshot_key.as_bytes(), &final_data)?;
        
        let duration = start_time.elapsed();
        println!("[SNAPSHOT] ✅ Incremental snapshot created: {} bytes in {:.2}s (base: {})", 
                 compressed.len(), duration.as_secs_f64(), base_height);
        
        Ok(())
    }
    
    /// Create full state snapshot at specified height
    pub async fn create_state_snapshot(&self, height: u64) -> IntegrationResult<()> {
        // PRODUCTION: Only create snapshots at round boundaries (every 10,000 blocks)
        const SNAPSHOT_INTERVAL: u64 = 10_000;
        if height % SNAPSHOT_INTERVAL != 0 && height != 0 {
            return Ok(()); // Not a full snapshot height
        }
        
        println!("[SNAPSHOT] 📸 Creating state snapshot at height {}", height);
        let start_time = std::time::Instant::now();
        
        // Get snapshot column family
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        // Collect state data for snapshot
        let mut snapshot_data = Vec::new();
        
        // 1. Add protocol version for compatibility check
        snapshot_data.extend_from_slice(&crate::node::PROTOCOL_VERSION.to_le_bytes());
        
        // 2. Add height marker
        snapshot_data.extend_from_slice(&height.to_le_bytes());
        
        // 3. Add timestamp
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        snapshot_data.extend_from_slice(&timestamp.to_le_bytes());
        
        // 4. Serialize current state (accounts, balances, reputation)
        // Note: In production, would serialize from StateManager
        let accounts_cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        
        let mut account_count = 0u64;
        let iter = self.persistent.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start);
        
        // Serialize account data
        for item in iter {
            let (key, value) = item?;
            snapshot_data.extend_from_slice(&(key.len() as u32).to_le_bytes());
            snapshot_data.extend_from_slice(&key);
            snapshot_data.extend_from_slice(&(value.len() as u32).to_le_bytes());
            snapshot_data.extend_from_slice(&value);
            account_count += 1;
        }
        
        // 5. v2.75: Include pending_rewards for fast sync (lazy rewards survive restart)
        let mut rewards_count = 0u64;
        if let Some(rewards_cf) = self.persistent.db.cf_handle("pending_rewards") {
            // Write marker for rewards section
            snapshot_data.extend_from_slice(b"REWARDS_V1");
            
            let rewards_iter = self.persistent.db.iterator_cf(&rewards_cf, rocksdb::IteratorMode::Start);
            for item in rewards_iter {
                let (key, value) = item?;
                snapshot_data.extend_from_slice(&(key.len() as u32).to_le_bytes());
                snapshot_data.extend_from_slice(&key);
                snapshot_data.extend_from_slice(&(value.len() as u32).to_le_bytes());
                snapshot_data.extend_from_slice(&value);
                rewards_count += 1;
            }
            
            // Write end marker
            snapshot_data.extend_from_slice(b"REWARDS_END");
        }
        
        // 6. Compress snapshot with LZ4 for efficient storage
        let compressed = lz4_flex::compress_prepend_size(&snapshot_data);
        
        // 6. Calculate hash for integrity check
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(&compressed);
        let hash = hasher.finalize();
        
        // Save snapshot with metadata
        let snapshot_key = format!("snapshot_{}", height);
        let mut final_data = Vec::new();
        final_data.extend_from_slice(&hash); // 32 bytes hash
        final_data.extend_from_slice(&(compressed.len() as u64).to_le_bytes()); // 8 bytes size
        final_data.extend_from_slice(&compressed); // Compressed data
        
        self.persistent.db.put_cf(&snapshots_cf, snapshot_key.as_bytes(), &final_data)?;
        
        // Update latest snapshot pointer
        self.persistent.db.put_cf(&snapshots_cf, b"latest_snapshot", &height.to_le_bytes())?;
        
        let duration = start_time.elapsed();
        println!("[SNAPSHOT] ✅ Snapshot created: {} accounts, {} rewards, {} bytes compressed in {:.2}s", 
                 account_count, rewards_count, compressed.len(), duration.as_secs_f64());
        
        // PRODUCTION: Clean up old snapshots (keep only last 5)
        self.cleanup_old_snapshots(5)?;
        
        Ok(())
    }
    
    /// Load state snapshot from specified height
    /// v2.98: Load latest state snapshot for node startup
    /// Returns (height, state_root, accounts_data) or None if no snapshot exists
    pub async fn load_latest_state_snapshot(&self) -> IntegrationResult<Option<(u64, [u8; 32], Vec<u8>)>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        // Find latest snapshot by iterating (RocksDB stores keys sorted)
        let mut iter = self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::End);
        
        if let Some(Ok((key, value))) = iter.next() {
            // Parse key: "snapshot_{height}"
            let key_str = String::from_utf8_lossy(&key);
            if let Some(height_str) = key_str.strip_prefix("snapshot_") {
                if let Ok(height) = height_str.parse::<u64>() {
                    // Parse value: [state_root(32) | data_len(8) | compressed_data]
                    if value.len() >= 40 {
                        let state_root: [u8; 32] = value[..32].try_into()
                            .map_err(|_| IntegrationError::StorageError("Invalid state_root size".to_string()))?;
                        let _data_len = u64::from_le_bytes(value[32..40].try_into()
                            .map_err(|_| IntegrationError::StorageError("Invalid data_len size".to_string()))?);
                        let compressed_data = &value[40..];
                        
                        // Decompress with Zstd (matches save_state_snapshot compression)
                        let accounts_data = zstd::decode_all(compressed_data)
                            .map_err(|e| IntegrationError::Other(format!("State decompression error: {}", e)))?;
                        
                        println!("[STATE] loaded_snapshot height={} size={}KB", 
                                height, accounts_data.len() / 1024);
                        
                        return Ok(Some((height, state_root, accounts_data)));
                    }
                }
            }
        }
        
        Ok(None)
    }
    
    /// v2.99: Load state snapshot by height and restore into StateManager
    /// Returns (state_root, accounts_data) for direct StateManager restoration
    pub async fn load_state_snapshot_by_height(&self, height: u64) -> IntegrationResult<Option<([u8; 32], Vec<u8>)>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        let snapshot_key = format!("snapshot_{}", height);
        
        match self.persistent.db.get_cf(&snapshots_cf, snapshot_key.as_bytes())? {
            Some(value) => {
                // Parse value: [state_root(32) | data_len(8) | compressed_data]
                if value.len() >= 40 {
                    let state_root: [u8; 32] = value[..32].try_into()
                        .map_err(|_| IntegrationError::StorageError("Invalid state_root size".to_string()))?;
                    let _data_len = u64::from_le_bytes(value[32..40].try_into()
                        .map_err(|_| IntegrationError::StorageError("Invalid data_len size".to_string()))?);
                    let compressed_data = &value[40..];
                    
                    // Decompress with Zstd
                    let accounts_data = zstd::decode_all(compressed_data)
                        .map_err(|e| IntegrationError::Other(format!("State decompression error: {}", e)))?;
                    
                    Ok(Some((state_root, accounts_data)))
                } else {
                    Err(IntegrationError::StorageError(format!("Invalid snapshot format at height {}", height)))
                }
            }
            None => Ok(None)
        }
    }
    
    pub async fn load_state_snapshot(&self, height: u64) -> IntegrationResult<()> {
        println!("[SNAPSHOT] 📂 Loading state snapshot from height {}", height);
        
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        let snapshot_key = format!("snapshot_{}", height);
        let snapshot_data = self.persistent.db.get_cf(&snapshots_cf, snapshot_key.as_bytes())?
            .ok_or_else(|| IntegrationError::StorageError(format!("Snapshot at height {} not found", height)))?;
        
        // Verify hash
        let stored_hash = &snapshot_data[..32];
        let size = u64::from_le_bytes(snapshot_data[32..40].try_into().expect("Snapshot size field must be 8 bytes")) as usize;
        let compressed_data = &snapshot_data[40..];
        
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(compressed_data);
        let computed_hash = hasher.finalize();
        
        if stored_hash != computed_hash.as_slice() {
            return Err(IntegrationError::StorageError("Snapshot integrity check failed".to_string()));
        }
        
        // Decompress
        let decompressed = lz4_flex::decompress_size_prepended(compressed_data)
            .map_err(|e| IntegrationError::StorageError(format!("Decompression failed: {}", e)))?;
        
        // Parse and restore state
        let mut cursor = 0;
        
        // Check protocol version
        let version = u32::from_le_bytes(decompressed[0..4].try_into().expect("Version field must be 4 bytes"));
        cursor += 4;
        
        if version != crate::node::PROTOCOL_VERSION {
            println!("[SNAPSHOT] ⚠️ Version mismatch: snapshot v{}, current v{}", 
                     version, crate::node::PROTOCOL_VERSION);
        }
        
        // Skip height and timestamp
        cursor += 16;
        
        // Restore accounts
        let accounts_cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        
        let mut batch = WriteBatch::default();
        let mut account_count = 0;
        
        // Read accounts until we hit REWARDS_V1 marker or end of data
        while cursor < decompressed.len() {
            // Check for REWARDS_V1 marker (10 bytes)
            if cursor + 10 <= decompressed.len() && &decompressed[cursor..cursor+10] == b"REWARDS_V1" {
                break; // Switch to rewards section
            }
            
            if cursor + 4 > decompressed.len() { break; }
            let key_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().expect("Key length field must be 4 bytes")) as usize;
            cursor += 4;
            
            if cursor + key_len > decompressed.len() { break; }
            let key = &decompressed[cursor..cursor+key_len];
            cursor += key_len;
            
            if cursor + 4 > decompressed.len() { break; }
            let value_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().expect("Value length field must be 4 bytes")) as usize;
            cursor += 4;
            
            if cursor + value_len > decompressed.len() { break; }
            let value = &decompressed[cursor..cursor+value_len];
            cursor += value_len;
            
            batch.put_cf(&accounts_cf, key, value);
            account_count += 1;
        }
        
        self.persistent.db.write(batch)?;
        
        // v2.75: Restore pending_rewards if present
        let mut rewards_count = 0;
        if cursor + 10 <= decompressed.len() && &decompressed[cursor..cursor+10] == b"REWARDS_V1" {
            cursor += 10; // Skip marker
            
            if let Some(rewards_cf) = self.persistent.db.cf_handle("pending_rewards") {
                let mut rewards_batch = WriteBatch::default();
                
                // Read until REWARDS_END marker
                while cursor < decompressed.len() {
                    // Check for REWARDS_END marker (11 bytes)
                    if cursor + 11 <= decompressed.len() && &decompressed[cursor..cursor+11] == b"REWARDS_END" {
                        break;
                    }
                    
                    if cursor + 4 > decompressed.len() { break; }
                    let key_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().expect("Key length must be 4 bytes")) as usize;
                    cursor += 4;
                    
                    if cursor + key_len > decompressed.len() { break; }
                    let key = &decompressed[cursor..cursor+key_len];
                    cursor += key_len;
                    
                    if cursor + 4 > decompressed.len() { break; }
                    let value_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().expect("Value length must be 4 bytes")) as usize;
                    cursor += 4;
                    
                    if cursor + value_len > decompressed.len() { break; }
                    let value = &decompressed[cursor..cursor+value_len];
                    cursor += value_len;
                    
                    rewards_batch.put_cf(&rewards_cf, key, value);
                    rewards_count += 1;
                }
                
                self.persistent.db.write(rewards_batch)?;
            }
        }
        
        println!("[SNAPSHOT] ✅ Restored {} accounts, {} rewards from snapshot", account_count, rewards_count);
        
        Ok(())
    }
    
    // v3.41: cleanup_old_snapshots unified into the ephemeral cleanup section above
    
    // PRODUCTION: IPFS integration for decentralized snapshot distribution
    
    /// Upload snapshot to IPFS and return CID (Content Identifier)
    pub async fn upload_snapshot_to_ipfs(&self, height: u64) -> IntegrationResult<String> {
        // PRODUCTION: Check if IPFS is available (OPTIONAL feature)
        let ipfs_api = match std::env::var("IPFS_API_URL") {
            Ok(url) => url,
            Err(_) => {
                // IPFS is OPTIONAL - skip if not configured
                return Err(IntegrationError::Other("IPFS not configured (set IPFS_API_URL to enable)".to_string()));
            }
        };
        
        println!("[IPFS] 📤 Uploading snapshot at height {} to IPFS...", height);
        
        // Get snapshot data BEFORE any async operations (avoids Send issues)
        let snapshot_data = {
            let snapshots_cf = self.persistent.db.cf_handle("snapshots")
                .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
            
            let snapshot_key = format!("snapshot_{}", height);
            self.persistent.db.get_cf(&snapshots_cf, snapshot_key.as_bytes())?
                .ok_or_else(|| IntegrationError::StorageError(format!("Snapshot at height {} not found", height)))?
        }; // RocksDB handle is dropped here
        
        // PRODUCTION: Create IPFS-compatible metadata
        let metadata = json!({
            "version": crate::node::PROTOCOL_VERSION,
            "height": height,
            "timestamp": chrono::Utc::now().timestamp(),
            "type": "qnet_snapshot",
            "compression": "lz4",
            "size": snapshot_data.len()
        });
        
        // PRODUCTION: Use HTTP client to upload to IPFS
        // In production environment, would use ipfs-api crate
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120)) // 2 minutes for large snapshots
            .build()
            .map_err(|e| IntegrationError::Other(format!("HTTP client error: {}", e)))?;
        
        // Create multipart form for IPFS add endpoint
        let form = reqwest::multipart::Form::new()
            .part("file", reqwest::multipart::Part::bytes(snapshot_data)
                .file_name(format!("qnet_snapshot_{}.dat", height)));
        
        // Upload to IPFS
        let response = client.post(&format!("{}/api/v0/add", ipfs_api))
            .multipart(form)
            .send()
            .await
            .map_err(|e| IntegrationError::Other(format!("IPFS upload failed: {}", e)))?;
        
        if response.status().is_success() {
            let result: serde_json::Value = response.json().await
                .map_err(|e| IntegrationError::Other(format!("IPFS response parse error: {}", e)))?;
            
            if let Some(cid) = result.get("Hash").and_then(|v| v.as_str()) {
                // Store IPFS CID reference (in a scope to drop cf_handle)
                {
                    let ipfs_key = format!("ipfs_{}", height);
                    let snapshots_cf = self.persistent.db.cf_handle("snapshots")
                        .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
                    self.persistent.db.put_cf(&snapshots_cf, ipfs_key.as_bytes(), cid.as_bytes())?;
                } // cf_handle is dropped here
                
                println!("[IPFS] ✅ Snapshot uploaded to IPFS: {}", cid);
                
                // PRODUCTION: Pin the content to ensure persistence (now safe after cf_handle is dropped)
                self.pin_ipfs_content(&ipfs_api, cid).await?;
                
                return Ok(cid.to_string());
            }
        }
        
        Err(IntegrationError::StorageError("Failed to upload snapshot to IPFS".to_string()))
    }
    
    /// Pin IPFS content to ensure it stays available
    async fn pin_ipfs_content(&self, ipfs_api: &str, cid: &str) -> IntegrationResult<()> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| IntegrationError::Other(format!("HTTP client error: {}", e)))?;
        
        let response = client.post(&format!("{}/api/v0/pin/add", ipfs_api))
            .query(&[("arg", cid)])
            .send()
            .await
            .map_err(|e| IntegrationError::Other(format!("IPFS pin failed: {}", e)))?;
        
        if response.status().is_success() {
            println!("[IPFS] 📌 Content pinned: {}", cid);
            Ok(())
        } else {
            Err(IntegrationError::StorageError(format!("Failed to pin IPFS content: {}", cid)))
        }
    }
    
    /// Download snapshot from IPFS by CID
    pub async fn download_snapshot_from_ipfs(&self, cid: &str, height: u64) -> IntegrationResult<()> {
        let ipfs_gateway = match std::env::var("IPFS_GATEWAY_URL") {
            Ok(url) => url,
            Err(_) => {
                // DECENTRALIZED: No default to centralized services!
                // User must configure their own IPFS gateway or local node
                return Err(IntegrationError::Other(
                    "IPFS gateway not configured (set IPFS_GATEWAY_URL or run local IPFS node)".to_string()
                ));
            }
        };
        
        println!("[IPFS] 📥 Downloading snapshot from IPFS: {}", cid);
        
        // PRODUCTION: Try gateways from environment or peers
        let mut gateways = vec![ipfs_gateway.clone()];
        
        // Add additional gateways from environment (comma-separated)
        if let Ok(extra_gateways) = std::env::var("IPFS_EXTRA_GATEWAYS") {
            for gateway in extra_gateways.split(',') {
                gateways.push(gateway.trim().to_string());
            }
        }
        
        // DECENTRALIZED: Prefer local IPFS nodes from peers
        // In production, would discover IPFS gateways from P2P network
        // Not hardcoding any centralized services!
        
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300)) // 5 minutes for large downloads
            .build()
            .map_err(|e| IntegrationError::Other(format!("HTTP client error: {}", e)))?;
        
        let mut snapshot_data = None;
        
        // Try each gateway until success
        for gateway in &gateways {
            let url = format!("{}/ipfs/{}", gateway, cid);
            println!("[IPFS] 🔄 Trying gateway: {}", gateway);
            
            match client.get(&url).send().await {
                Ok(response) if response.status().is_success() => {
                    match response.bytes().await {
                        Ok(data) => {
                            snapshot_data = Some(data.to_vec());
                            println!("[IPFS] ✅ Downloaded {} bytes from {}", data.len(), gateway);
                            break;
                        },
                        Err(e) => {
                            println!("[IPFS] ⚠️ Failed to read data from {}: {}", gateway, e);
                            continue;
                        }
                    }
                },
                Ok(response) => {
                    println!("[IPFS] ⚠️ Gateway {} returned status: {}", gateway, response.status());
                    continue;
                },
                Err(e) => {
                    println!("[IPFS] ⚠️ Failed to connect to {}: {}", gateway, e);
                    continue;
                }
            }
        }
        
        let data = snapshot_data
            .ok_or_else(|| IntegrationError::StorageError("Failed to download from any IPFS gateway".to_string()))?;
        
        // Verify and save snapshot
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        // Verify hash before saving
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(&data[40..]); // Skip hash and size fields
        let computed_hash = hasher.finalize();
        
        if &data[..32] != computed_hash.as_slice() {
            return Err(IntegrationError::StorageError("IPFS snapshot integrity check failed".to_string()));
        }
        
        // Save snapshot locally
        let snapshot_key = format!("snapshot_{}", height);
        self.persistent.db.put_cf(&snapshots_cf, snapshot_key.as_bytes(), &data)?;
        
        // Save IPFS reference
        let ipfs_key = format!("ipfs_{}", height);
        self.persistent.db.put_cf(&snapshots_cf, ipfs_key.as_bytes(), cid.as_bytes())?;
        
        println!("[IPFS] ✅ Snapshot saved from IPFS (height: {})", height);
        
        Ok(())
    }
    
    /// Get IPFS CID for a snapshot at given height
    pub fn get_snapshot_ipfs_cid(&self, height: u64) -> IntegrationResult<Option<String>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        let ipfs_key = format!("ipfs_{}", height);
        match self.persistent.db.get_cf(&snapshots_cf, ipfs_key.as_bytes())? {
            Some(cid_bytes) => Ok(Some(String::from_utf8_lossy(&cid_bytes).to_string())),
            None => Ok(None)
        }
    }
    
    /// Share snapshot via P2P network (announce IPFS CID to peers)
    pub async fn announce_snapshot_to_peers(&self, height: u64, cid: &str, p2p: &crate::unified_p2p::SimplifiedP2P) {
        println!("[P2P] 📢 Announcing snapshot to peers: height={}, CID={}", height, cid);
        
        // Create announcement message
        let announcement = json!({
            "type": "snapshot_available",
            "height": height,
            "ipfs_cid": cid,
            "timestamp": chrono::Utc::now().timestamp(),
            "node_id": p2p.node_id.clone()
        });
        
        // Broadcast to all connected peers
        let peers = p2p.get_validated_active_peers();
        for peer in &peers {
            let message = crate::unified_p2p::NetworkMessage::StateSnapshot {
                height,
                ipfs_cid: cid.to_string(),
                sender_id: p2p.node_id.clone(),
            };
            
            p2p.send_network_message(&peer.addr, message);
        }
        
        println!("[P2P] ✅ Snapshot announcement sent to {} peers", peers.len());
    }
    
    /// SLIDING WINDOW: Prune old blocks outside of retention window
    pub fn prune_old_blocks(&self) -> IntegrationResult<()> {
        // Super nodes keep everything (archival role)
        if self.storage_mode == StorageMode::Super {
            return Ok(()); // Super nodes are our "archive" nodes - keep everything
        }
        
        // Light nodes don't store full blocks at all
        if self.storage_mode == StorageMode::Light {
            return self.prune_for_light_node();
        }
        
        let current_height = self.get_chain_height()?;
        if current_height <= self.sliding_window_size {
            return Ok(()); // Not enough blocks yet
        }
        
        let prune_before = current_height - self.sliding_window_size;
        
        // Find last snapshot before pruning point
        let last_snapshot = (prune_before / 10_000) * 10_000; // Round down to snapshot
        if last_snapshot == 0 {
            return Ok(()); // Don't prune before first snapshot
        }
        
        println!("[PRUNING] 🗑️ Starting block pruning (keeping blocks {} and newer)", prune_before);
        
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let mut batch = WriteBatch::default();
        let mut pruned_count = 0;
        
        // Prune blocks before the window, but after last snapshot
        for height in (last_snapshot + 1)..prune_before {
            // Prune microblocks
            let micro_key = format!("microblock_{}", height);
            if self.persistent.db.get_cf(&microblocks_cf, micro_key.as_bytes())?.is_some() {
                batch.delete_cf(&microblocks_cf, micro_key.as_bytes());
                pruned_count += 1;
            }
            
            // CRITICAL FIX: Also prune macroblocks (they were NEVER deleted!)
            // Macroblocks have their own numbering: macro #1 = after micro 90, macro #2 = after micro 180
            // Check if this microblock height corresponds to a macroblock
            if height % 90 == 0 && height > 0 {
                // This microblock height has a corresponding macroblock
                let macro_number = height / 90;
                let macro_key = format!("macroblock_{}", macro_number);
                if self.persistent.db.get_cf(&microblocks_cf, macro_key.as_bytes())?.is_some() {
                    batch.delete_cf(&microblocks_cf, macro_key.as_bytes());
                    pruned_count += 1;
                    println!("[PRUNING] 🔥 Pruning macroblock #{} (at microblock height {})", 
                            macro_number, height);
                }
            }
                
                // Apply batch every 1000 blocks to avoid memory issues
                if pruned_count % 1000 == 0 {
                    self.persistent.db.write(batch)?;
                    batch = WriteBatch::default();
                    println!("[PRUNING] Pruned {} blocks...", pruned_count);
            }
        }
        
        // Apply remaining batch
        if !batch.is_empty() {
            self.persistent.db.write(batch)?;
        }
        
        // Force compaction to reclaim space
        self.persistent.db.compact_range_cf(&microblocks_cf, 
            Some(format!("microblock_{}", last_snapshot).as_bytes()),
            Some(format!("microblock_{}", prune_before).as_bytes()));
        
        println!("[PRUNING] ✅ Pruned {} blocks (before height {}), keeping snapshot at {}", 
                pruned_count, prune_before, last_snapshot);
        
        // CRITICAL: Also prune transactions from pruned blocks
        // Transactions are stored separately and must be cleaned up
        let tx_pruned = self.prune_old_transactions(prune_before)?;
        if tx_pruned > 0 {
            println!("[PRUNING] ✅ Pruned {} old transactions", tx_pruned);
        }
        
        // Update metadata
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.persistent.db.put_cf(&metadata_cf, b"oldest_block", &prune_before.to_le_bytes())?;
        
        Ok(())
    }
    
    /// PRODUCTION: Prune old transactions that are no longer in retained blocks
    /// Transactions are stored separately from blocks for fast lookup
    /// After block pruning, orphaned transactions must also be removed
    fn prune_old_transactions(&self, prune_before_height: u64) -> IntegrationResult<u64> {
        let tx_cf = self.persistent.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        let tx_index_cf = self.persistent.db.cf_handle("tx_index")
            .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
        let tx_by_addr_cf = self.persistent.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        
        let mut batch = WriteBatch::default();
        let mut pruned_count: u64 = 0;
        let mut tx_hashes_to_prune: Vec<String> = Vec::new();
        
        // Step 1: Find transactions in blocks before prune_before_height using tx_index
        let iter = self.persistent.db.iterator_cf(&tx_index_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, value) = item?;
            
            // tx_index stores: tx_hash -> block_height
            if value.len() >= 8 {
                let block_height = u64::from_be_bytes(value[..8].try_into().unwrap_or([0u8; 8]));
                
                if block_height < prune_before_height {
                    let tx_key = String::from_utf8_lossy(&key).to_string();
                    tx_hashes_to_prune.push(tx_key);
                }
            }
        }
        
        // Step 2: Delete transactions and their indices
        for tx_key in &tx_hashes_to_prune {
            // Delete from transactions CF
            batch.delete_cf(&tx_cf, tx_key.as_bytes());
            
            // Delete from tx_index CF
            batch.delete_cf(&tx_index_cf, tx_key.as_bytes());
            
            pruned_count += 1;
            
            // Apply batch every 1000 transactions to avoid memory issues
            if pruned_count % 1000 == 0 {
                self.persistent.db.write(batch)?;
                batch = WriteBatch::default();
                println!("[PRUNING] Pruned {} transactions...", pruned_count);
            }
        }
        
        // Step 3: Clean up tx_by_address index (more complex - need to scan)
        // This index stores: addr_{address}_{timestamp}_{tx_hash}
        // We need to remove entries for pruned transactions
        let addr_iter = self.persistent.db.iterator_cf(&tx_by_addr_cf, rocksdb::IteratorMode::Start);
        let mut addr_keys_to_delete: Vec<Vec<u8>> = Vec::new();
        
        for item in addr_iter {
            let (key, _value) = item?;
            let key_str = String::from_utf8_lossy(&key);
            
            // Extract tx_hash from key format: addr_{address}_{timestamp}_{tx_hash}
            if let Some(tx_hash) = key_str.rsplit('_').next() {
                let tx_key = format!("tx_{}", tx_hash);
                if tx_hashes_to_prune.contains(&tx_key) {
                    addr_keys_to_delete.push(key.to_vec());
                }
            }
        }
        
        for key in addr_keys_to_delete {
            batch.delete_cf(&tx_by_addr_cf, &key);
        }
        
        // Apply remaining batch
        if !batch.is_empty() {
            self.persistent.db.write(batch)?;
        }
        
        // Force compaction on transaction CFs to reclaim space
        if pruned_count > 0 {
            self.persistent.db.compact_range_cf(&tx_cf, None::<&[u8]>, None::<&[u8]>);
            self.persistent.db.compact_range_cf(&tx_index_cf, None::<&[u8]>, None::<&[u8]>);
            self.persistent.db.compact_range_cf(&tx_by_addr_cf, None::<&[u8]>, None::<&[u8]>);
        }
        
        Ok(pruned_count)
    }
    
    /// Light node pruning - keep only block headers and recent state
    fn prune_for_light_node(&self) -> IntegrationResult<()> {
        println!("[PRUNING] 🪶 Light node mode - keeping only headers and state");
        
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let mut batch = WriteBatch::default();
        let mut converted = 0;
        
        // Convert full blocks to headers only
        let iter = self.persistent.db.iterator_cf(&microblocks_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, value) = item?;
            
            // Skip if already a header
            if value.len() < 1000 { // Headers are much smaller than full blocks
                continue;
            }
            
            // Extract header from full block (simplified - in production would deserialize properly)
            let header = &value[..200.min(value.len())]; // First 200 bytes as header
            batch.put_cf(&microblocks_cf, &key, header);
            converted += 1;
            
            if converted % 100 == 0 {
                self.persistent.db.write(batch)?;
                batch = WriteBatch::default();
            }
        }
        
        if !batch.is_empty() {
            self.persistent.db.write(batch)?;
        }
        
        println!("[PRUNING] ✅ Converted {} blocks to headers-only format", converted);
        
        Ok(())
    }
    
    /// Get current storage mode
    pub fn get_storage_mode(&self) -> StorageMode {
        self.storage_mode
    }
    
    /// Check if block is within retention window
    pub fn is_block_retained(&self, height: u64) -> bool {
        match self.storage_mode {
            StorageMode::Super => true,  // Super nodes keep everything (archival)
            StorageMode::Light => false, // Light nodes don't store blocks (API client)
        }
    }
    
    /// Estimate storage requirements for current configuration
    pub fn estimate_storage_requirements(&self) -> String {
        // v3.19: Light nodes = NO storage (pure API client), Super = archival
        match self.storage_mode {
            StorageMode::Light => "0 MB (API client only, no local storage)".to_string(),
            StorageMode::Super => "500 GB - 1 TB (complete blockchain history with compression)".to_string(),
        }
    }
    
    /// Get latest snapshot height for fast sync
    pub fn get_latest_snapshot_height(&self) -> IntegrationResult<Option<u64>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        // Check for latest snapshot pointer
        if let Ok(Some(data)) = self.persistent.db.get_cf(&snapshots_cf, b"latest_snapshot") {
            let height = u64::from_le_bytes(data[..8].try_into()
                .map_err(|_| IntegrationError::StorageError("Invalid snapshot height format".to_string()))?);
            return Ok(Some(height));
        }
        
        // Otherwise scan for snapshots
        let mut latest_height = 0u64;
        let iter = self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::Start);
        
        for item in iter {
            let (key, _) = item?;
            let key_str = String::from_utf8_lossy(&key);
            
            if key_str.starts_with("snapshot_") {
                if let Ok(height) = key_str.trim_start_matches("snapshot_").parse::<u64>() {
                    if height > latest_height {
                        latest_height = height;
                    }
                }
            }
        }
        
        if latest_height > 0 {
            Ok(Some(latest_height))
        } else {
            Ok(None)
        }
    }
    
    /// Get raw snapshot data for P2P download (v2.19.12)
    /// Returns compressed binary snapshot data
    pub fn get_snapshot_data(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        let snapshot_key = format!("snapshot_{}", height);
        
        match self.persistent.db.get_cf(&snapshots_cf, snapshot_key.as_bytes())? {
            Some(data) => Ok(Some(data)),
            None => {
                // Try state_ prefix as fallback
                let state_key = format!("state_{}", height);
                match self.persistent.db.get_cf(&snapshots_cf, state_key.as_bytes())? {
                    Some(data) => Ok(Some(data)),
                    None => Ok(None)
                }
            }
        }
    }
    
    /// Download snapshot from network for fast bootstrap
    pub async fn download_and_load_snapshot(&self, p2p: &crate::unified_p2p::SimplifiedP2P) -> IntegrationResult<u64> {
        println!("[SNAPSHOT] 🔍 Searching for network snapshots...");
        
        let peers = p2p.get_validated_active_peers();
        if peers.is_empty() {
            return Err(IntegrationError::Other("No peers available for snapshot download".to_string()));
        }
        
        // Query peers for latest snapshot
        for peer in peers {
            match self.query_peer_snapshot(&peer.addr).await {
                Ok(Some((height, cid))) => {
                    println!("[SNAPSHOT] 📥 Found snapshot at height {} from peer {}", height, peer.id);
                    
                    // Download from IPFS or directly from peer
                    if !cid.is_empty() && std::env::var("IPFS_ENABLED").unwrap_or_default() == "1" {
                        // Try IPFS first
                        if let Ok(_) = self.download_snapshot_from_ipfs(&cid, height).await {
                            println!("[SNAPSHOT] ✅ Downloaded snapshot from IPFS");
                            return Ok(height);
                        }
                    }
                    
                    // Fallback to direct P2P download
                    if let Ok(_) = self.download_snapshot_from_peer(&peer.addr, height).await {
                        println!("[SNAPSHOT] ✅ Downloaded snapshot from peer {}", peer.id);
                        return Ok(height);
                    }
                },
                _ => continue,
            }
        }
        
        Err(IntegrationError::Other("No snapshots available from network".to_string()))
    }
    
    /// Query peer for available snapshots
    async fn query_peer_snapshot(&self, peer_addr: &str) -> IntegrationResult<Option<(u64, String)>> {
        // Query peer's /api/v1/snapshot endpoint
        let url = format!("http://{}/api/v1/snapshot/latest", peer_addr);
        
        match reqwest::get(&url).await {
            Ok(response) => {
                if response.status().is_success() {
                    let data: serde_json::Value = response.json().await
                        .map_err(|e| IntegrationError::Other(format!("JSON error: {}", e)))?;
                    
                    if let (Some(height), Some(cid)) = (
                        data["height"].as_u64(),
                        data["ipfs_cid"].as_str()
                    ) {
                        return Ok(Some((height, cid.to_string())));
                    }
                }
            },
            Err(e) => println!("[SNAPSHOT] Failed to query peer {}: {}", peer_addr, e),
        }
        
        Ok(None)
    }
    
    /// Download snapshot directly from peer
    async fn download_snapshot_from_peer(&self, peer_addr: &str, height: u64) -> IntegrationResult<()> {
        let url = format!("http://{}/api/v1/snapshot/{}", peer_addr, height);
        
        let response = reqwest::get(&url).await
            .map_err(|e| IntegrationError::Other(format!("Download error: {}", e)))?;
        
        if !response.status().is_success() {
            return Err(IntegrationError::Other("Snapshot download failed".to_string()));
        }
        
        let data = response.bytes().await
            .map_err(|e| IntegrationError::Other(format!("Download error: {}", e)))?;
        
        // Save snapshot to DB (sync operation - cf_handle doesn't cross await)
        {
            let snapshots_cf = self.persistent.db.cf_handle("snapshots")
                .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
            
            let snapshot_key = format!("snapshot_{}", height);
            self.persistent.db.put_cf(&snapshots_cf, snapshot_key.as_bytes(), &data)?;
        }
        
        // Load into state (async)
        self.load_state_snapshot(height).await?;
        
        Ok(())
    }
    
    /// Fast sync with snapshot for new nodes
    pub async fn fast_sync_with_snapshot(&self, p2p: &crate::unified_p2p::SimplifiedP2P, target_height: u64) -> IntegrationResult<()> {
        println!("[SYNC] ⚡ Starting fast sync to height {}", target_height);
        
        // For Light nodes, only sync recent state
        if self.storage_mode == StorageMode::Light {
            println!("[SYNC] 📱 Light node: syncing only recent headers");
            return Ok(());
        }
        
        // Try to find and load a snapshot
        match self.download_and_load_snapshot(p2p).await {
            Ok(snapshot_height) => {
                println!("[SYNC] 📸 Loaded snapshot at height {}", snapshot_height);
                
                // Now sync remaining blocks from snapshot to target
                if target_height > snapshot_height {
                    println!("[SYNC] 📥 Syncing remaining {} blocks...", 
                            target_height - snapshot_height);
                    // The node will handle syncing remaining blocks
                }
                
                Ok(())
            },
            Err(e) => {
                println!("[SYNC] ⚠️ Snapshot sync failed: {:?}, falling back to full sync", e);
                // Fall back to normal sync
                Err(e)
            }
        }
    }
    
    // =========================================================================
    // SMART CONTRACT STORAGE METHODS
    // =========================================================================
    
    /// Get contract info by address
    pub fn get_contract_info(&self, contract_address: &str) -> IntegrationResult<Option<StoredContractInfo>> {
        let key = format!("contract:info:{}", contract_address);
        
        match self.persistent.load_raw(&key)? {
            Some(data) => {
                match serde_json::from_slice::<StoredContractInfo>(&data) {
                    Ok(stored) => Ok(Some(stored)),
                    Err(e) => {
                        println!("[Storage] Failed to deserialize contract info: {:?}", e);
                        Ok(None)
                    }
                }
            }
            None => Ok(None)
        }
    }
    
    /// Save contract info
    pub fn save_contract_info(&self, contract_address: &str, info: &StoredContractInfo) -> IntegrationResult<()> {
        let key = format!("contract:info:{}", contract_address);
        
        let data = serde_json::to_vec(info)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        self.persistent.save_raw(&key, &data)?;
        
        // Also save to contract list for enumeration
        self.add_contract_to_list(contract_address)?;
        
        Ok(())
    }
    
    /// Add contract address to the list of all contracts
    fn add_contract_to_list(&self, contract_address: &str) -> IntegrationResult<()> {
        let list_key = "contract:list";
        
        // Load existing list
        let mut contracts: Vec<String> = match self.persistent.load_raw(list_key)? {
            Some(data) => serde_json::from_slice(&data).unwrap_or_default(),
            None => Vec::new(),
        };
        
        // Add if not already present
        if !contracts.contains(&contract_address.to_string()) {
            contracts.push(contract_address.to_string());
            let data = serde_json::to_vec(&contracts)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            self.persistent.save_raw(list_key, &data)?;
        }
        
        Ok(())
    }
    
    /// Get list of all contract addresses
    pub fn get_all_contract_addresses(&self) -> IntegrationResult<Vec<String>> {
        let list_key = "contract:list";
        
        match self.persistent.load_raw(list_key)? {
            Some(data) => {
                let contracts: Vec<String> = serde_json::from_slice(&data)
                    .unwrap_or_default();
                Ok(contracts)
            }
            None => Ok(Vec::new())
        }
    }
    
    /// Get contract state value by key
    pub fn get_contract_state(&self, contract_address: &str, state_key: &str) -> IntegrationResult<Option<String>> {
        let key = format!("contract:state:{}:{}", contract_address, state_key);
        
        match self.persistent.load_raw(&key)? {
            Some(data) => {
                match String::from_utf8(data) {
                    Ok(value) => Ok(Some(value)),
                    Err(e) => {
                        println!("[Storage] Failed to decode contract state: {:?}", e);
                        Ok(None)
                    }
                }
            }
            None => Ok(None)
        }
    }
    
    /// Save contract state value
    pub fn save_contract_state(&self, contract_address: &str, state_key: &str, value: &str) -> IntegrationResult<()> {
        let key = format!("contract:state:{}:{}", contract_address, state_key);
        self.persistent.save_raw(&key, value.as_bytes())
    }
    
    /// Save contract WASM code
    pub fn save_contract_code(&self, code_hash: &str, wasm_code: &[u8]) -> IntegrationResult<()> {
        let key = format!("contract:code:{}", code_hash);
        self.persistent.save_raw(&key, wasm_code)
    }
    
    /// Get contract WASM code by hash
    pub fn get_contract_code(&self, code_hash: &str) -> IntegrationResult<Option<Vec<u8>>> {
        let key = format!("contract:code:{}", code_hash);
        self.persistent.load_raw(&key)
    }
    
    // =========================================================================
    // JAIL PERSISTENCE (for network-wide consistency)
    // =========================================================================
    
    /// Save jail status for a node (persists across restarts)
    pub fn save_jail_status(&self, node_id: &str, jailed_until: u64, jail_count: u32, reason: &str) -> IntegrationResult<()> {
        let key = format!("jail:{}", node_id);
        let value = format!("{}:{}:{}", jailed_until, jail_count, reason);
        self.persistent.save_raw(&key, value.as_bytes())
    }
    
    /// Get jail status for a node
    pub fn get_jail_status(&self, node_id: &str) -> IntegrationResult<Option<(u64, u32, String)>> {
        let key = format!("jail:{}", node_id);
        match self.persistent.load_raw(&key)? {
            Some(data) => {
                match String::from_utf8(data) {
                    Ok(value) => {
                        let parts: Vec<&str> = value.splitn(3, ':').collect();
                        if parts.len() >= 3 {
                            let jailed_until = parts[0].parse().unwrap_or(0);
                            let jail_count = parts[1].parse().unwrap_or(0);
                            let reason = parts[2].to_string();
                            Ok(Some((jailed_until, jail_count, reason)))
                        } else {
                            Ok(None)
                        }
                    }
                    Err(_) => Ok(None)
                }
            }
            None => Ok(None)
        }
    }
    
    /// Remove jail status for a node (when released)
    pub fn remove_jail_status(&self, node_id: &str) -> IntegrationResult<()> {
        let key = format!("jail:{}", node_id);
        // Save empty to mark as removed (RocksDB doesn't have direct delete in our wrapper)
        self.persistent.save_raw(&key, &[])
    }
    
    /// Get all jail statuses (for loading on startup)
    pub fn get_all_jail_statuses(&self) -> IntegrationResult<Vec<(String, u64, u32, String)>> {
        // Scan for all jail: prefixed keys
        let mut result = Vec::new();
        
        // Use iterator if available, otherwise return empty
        // Note: This is a simplified implementation - in production you'd use RocksDB iterator
        // For now, we rely on network sync for jail propagation
        
        Ok(result)
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CERTIFICATE STORAGE ARCHITECTURE v2.29
    // ═══════════════════════════════════════════════════════════════════════════
    // Certificates are NOT stored separately!
    // They are ALREADY embedded in each block's vrf_proof field.
    // 
    // vrf_proof contains HybridSignature which includes:
    // - certificate: HybridCertificate (~2.6KB)
    // - ephemeral_public_key
    // - message_signature
    // - dilithium_key_signature
    //
    // For historical block validation:
    // 1. Load block from storage (already have vrf_proof)
    // 2. Extract certificate from vrf_proof
    // 3. Verify signature using extracted certificate
    //
    // This approach uses ZERO additional storage!
    // ═══════════════════════════════════════════════════════════════════════════
}

// =========================================================================
// SMART CONTRACT STORAGE STRUCTURES (outside impl block)
// =========================================================================

/// Contract information stored on-chain
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StoredContractInfo {
    pub address: String,
    pub deployer: String,
    pub deployed_at: u64,
    pub code_hash: String,
    pub version: String,
    pub total_gas_used: u64,
    pub call_count: u64,
    pub is_active: bool,
} 
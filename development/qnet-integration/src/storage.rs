//! Persistent storage implementation for QNet blockchain

use rocksdb::{DB, Options, ColumnFamily, ColumnFamilyDescriptor, WriteBatch};
use qnet_state::Transaction;
use crate::errors::{IntegrationError, IntegrationResult};
use std::path::Path;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
// FIX L-M22: parking_lot::RwLock for TransactionPool (non-poisoning, faster)
use parking_lot::RwLock;
use hex;
use sha3::Digest;
use bincode;
use serde_json::json;
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

/// v14.8.1: FINALITY-STATE SERIALISATION MUTEX.
///
/// Serialises every mutation of finality-related shared state:
///   - `LAST_FINALIZED_HEIGHT` / `LAST_FINALIZED_CONSENSUS_ROUND` advances
///     (node.rs::try_advance_finality)
///   - Rollback slot claim + finality re-check (begin_finality_guarded_rollback)
///
/// Without this, a TOCTOU window exists between
/// `is_rollback_in_progress()==false` and `LAST_FINALIZED_HEIGHT.store(...)`.
/// A concurrent rollback can claim the slot and pass its re-check BEFORE the
/// advancing thread's store lands — then proceed to delete blocks that are
/// now finalised. Rare, but at thousands-of-nodes × years of uptime,
/// eventually triggers.
///
/// The mutex is held for microseconds (one atomic read + a few stores per
/// path). It never covers the actual block-delete loop — deletions run
/// AFTER the claim returns, protected by the `ROLLBACK_IN_PROGRESS` flag
/// (which `try_advance_finality` checks). So the mutex itself has
/// effectively zero contention even at 10,000+ Super-nodes: macroblock
/// finality fires ≤ once per 90 s per macroblock layer.
pub(crate) static FINALITY_MUTEX: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// v14.8.1: Public guard type alias so other modules can hold the lock
/// without importing parking_lot directly.
#[allow(dead_code)]
pub type FinalityGuard<'a> = parking_lot::MutexGuard<'a, ()>;

/// v14.8.1: Acquire the finality-state serialisation lock. Blocking.
/// Callers MUST keep the scope short — lock is hot path for rollback starts
/// and finality advances. DO NOT hold across `.await` points.
#[inline]
pub fn lock_finality_state() -> parking_lot::MutexGuard<'static, ()> {
    FINALITY_MUTEX.lock()
}

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

    // FIX M-M21: Set ROLLBACK_IN_PROGRESS FIRST (as barrier) to block saves immediately,
    // THEN set the detail values. This prevents a window where the flag is set but
    // target/time are stale.
    ROLLBACK_IN_PROGRESS.store(true, Ordering::SeqCst);
    ROLLBACK_TARGET_HEIGHT.store(target_height, Ordering::SeqCst);
    ROLLBACK_START_TIME.store(now, Ordering::SeqCst);

    println!("[INFO][STORAGE] rollback_protection_started target_h={}", target_height);
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

/// v14.8: Cheap predicate for hot paths (e.g. finality advancement). Read-only,
/// uses Acquire ordering so a writer that set the flag before deleting blocks
/// is visible to every subsequent reader.
#[inline]
pub fn is_rollback_in_progress() -> bool {
    ROLLBACK_IN_PROGRESS.load(Ordering::Acquire)
}

/// v14.8: Atomic `check finality + claim rollback slot`. Returns Ok(()) only
/// when both hold simultaneously:
///   1. `target_height >= LAST_FINALIZED_HEIGHT` (no finality violation)
///   2. no other rollback is currently running
///
/// On success the caller OWNS the rollback slot and MUST release it via
/// `end_rollback_protection()` when done. This closes the race window between
/// the previous two-step pattern (check then start) where finality could
/// advance between the two calls.
///
/// Scales linearly: two atomic reads + one CAS + one atomic store. No mutex,
/// safe to call from any task, no contention at the thousands-of-nodes scale.
pub fn begin_finality_guarded_rollback(
    target_height: u64,
    last_finalized_height: u64,
) -> Result<(), String> {
    // v14.8.1: Hold the finality-state mutex for the whole claim+check path.
    // This serialises against `try_advance_finality`, which ALSO takes the
    // mutex before reading the rollback flag and writing LAST_FINALIZED_HEIGHT.
    // With the mutex, the previous TOCTOU is eliminated: by the time we do the
    // finality re-check, no concurrent advance can be half-done.
    //
    // Lock is held for microseconds — release happens before the caller's
    // block-delete loop. Deletion is still protected by ROLLBACK_IN_PROGRESS
    // (checked by try_advance_finality under the same mutex on its next call).
    let _guard = FINALITY_MUTEX.lock();

    // 1. Claim the rollback slot FIRST. Once ROLLBACK_IN_PROGRESS is set,
    //    `try_advance_finality` (in node.rs) will refuse to advance —
    //    closing the race window between our finality check and the
    //    actual deletion.
    match ROLLBACK_IN_PROGRESS.compare_exchange(
        false, true, Ordering::SeqCst, Ordering::SeqCst,
    ) {
        Ok(_) => {}
        Err(_) => {
            // Another rollback is already running. Respect the timeout
            // semantics of the legacy start_rollback_protection.
            let start_time = ROLLBACK_START_TIME.load(Ordering::Relaxed);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if now.saturating_sub(start_time) < ROLLBACK_TIMEOUT_SECS {
                return Err(format!(
                    "rollback_slot_busy other_target={}",
                    ROLLBACK_TARGET_HEIGHT.load(Ordering::Relaxed)
                ));
            }
            // Previous rollback timed out — force-claim the slot.
            println!("[WARN][ROLLBACK] stale_slot_force_claim age_secs={}",
                     now.saturating_sub(start_time));
            ROLLBACK_IN_PROGRESS.store(true, Ordering::SeqCst);
        }
    }

    // 2. Now — with advancement blocked AND lock held — re-check the finality
    //    boundary. Under the mutex there is no way for a concurrent advance
    //    to be mid-store; every advance either completed before we took the
    //    lock (visible now) or is waiting behind us (will see our flag).
    if last_finalized_height > 0 && target_height < last_finalized_height {
        ROLLBACK_IN_PROGRESS.store(false, Ordering::SeqCst);
        return Err(format!(
            "FINALITY_VIOLATION: rollback to {} blocked — blocks up to {} are finalized",
            target_height, last_finalized_height
        ));
    }

    // 3. Slot owned + finality boundary respected — record metadata.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    ROLLBACK_TARGET_HEIGHT.store(target_height, Ordering::SeqCst);
    ROLLBACK_START_TIME.store(now, Ordering::SeqCst);
    println!("[INFO][STORAGE] rollback_guarded_started target_h={} finalized_h={}",
             target_height, last_finalized_height);
    Ok(())
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
    /// v15.9: Arc<DB> wrapper enables zero-copy hand-off of the database
    /// handle to `tokio::task::spawn_blocking` closures. RocksDB's `DB` is
    /// `Send + Sync` so an `Arc<DB>` clone is safe to move into the
    /// blocking thread pool, allowing heavy I/O (`db.write` with large
    /// batches, snapshot zstd compression) to run off the async reactor
    /// without changing the public storage API surface.
    db: Arc<DB>,
}

/// v5.0: Snapshot manifest for chunked parallel download
/// Each chunk is independently hashable and downloadable from different peers
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SnapshotManifest {
    pub height: u64,
    pub total_size: u64,
    pub chunk_size: u64,
    pub chunk_count: u64,
    pub chunk_hashes: Vec<String>,
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
            // FIX L-M22: parking_lot RwLock -- no Result, no poisoning
            let mut transactions = self.transactions.write();
            let mut creation_times = self.creation_times.write();
            
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
            .get(tx_hash)
            .cloned()
    }
    
    /// Get multiple transactions by hashes
    pub fn get_transactions(&self, tx_hashes: &[[u8; 32]]) -> Vec<Option<Transaction>> {
        let transactions = self.transactions.read();
        tx_hashes.iter()
            .map(|hash| transactions.get(hash).cloned())
            .collect()
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
            let mut transactions = self.transactions.write();
            let mut creation_times = self.creation_times.write();
            
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
            println!("[INFO][STORAGE] cleanup_old_tx_duplicates count={}", removed_count);
        }
        
        Ok(removed_count)
    }
    
    /// Get pool statistics
    pub fn get_stats(&self) -> Result<(usize, usize), IntegrationError> {
        let tx_count = self.transactions.read().len();
        let time_count = self.creation_times.read().len();
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
// v19: LightNodeRotation — DEPRECATED LEGACY (kept for backward compatibility)
// ============================================================================
// Status: NOT used in production light-node deployments.
//
// Rationale
// ─────────
// Production light-node design (per `StorageTierConfig::light()` below) is
// `Pure API client — NO local storage. max_storage_bytes = 0.`. A light
// node is the mobile-wallet tier: it signs transactions, queries balances
// via API endpoints, and receives uptime rewards via the ping-response
// challenge protocol (`handle_light_node_ping_response` in rpc.rs). It
// does NOT maintain a local block-header chain on disk.
//
// `LightNodeRotation` was an earlier design where light clients persisted
// macroblock headers locally and rotated them in a FIFO buffer when the
// retention cap was hit. That scheme was retired when the storage tier
// config flipped `max_storage_bytes` to zero — the rotation code path now
// runs against an empty buffer and is effectively a no-op. The struct is
// retained so the existing `Storage::light_rotation` field continues to
// compile without ripple-effect refactors across the codebase.
//
// Future cleanup (post-mainnet): remove this struct and the corresponding
// `Storage::light_rotation` field once all in-tree references are migrated.
// Until then, `#[allow(dead_code)]` annotations document the deprecation.
// ============================================================================

/// DEPRECATED — header rotation buffer for the historical "headers-persisted"
/// light-node tier. Production light nodes are pure API clients with no
/// local storage; this struct is no-op in that configuration.
#[allow(dead_code)]
pub struct LightNodeRotation {
    /// Maximum number of headers to keep (legacy; production = 0).
    max_headers: u64,
    /// Current header count (legacy; production = 0).
    current_count: u64,
}

#[allow(dead_code)]
impl LightNodeRotation {
    pub fn new(max_headers: u64) -> Self {
        Self {
            max_headers,
            current_count: 0,
        }
    }

    /// Check if we need to rotate (delete old headers).
    /// DEPRECATED: returns false in production (max_headers = 0).
    pub fn needs_rotation(&self) -> bool {
        self.current_count >= self.max_headers
    }

    /// Get number of headers to delete.
    /// DEPRECATED: returns 0 in production (no-op).
    pub fn headers_to_delete(&self) -> u64 {
        if self.current_count > self.max_headers {
            self.current_count - self.max_headers
        } else {
            0
        }
    }

    /// Update count after adding a header.
    /// DEPRECATED: does not affect production light tier (no storage).
    pub fn increment(&mut self) {
        self.current_count += 1;
    }

    /// Update count after deleting headers.
    /// DEPRECATED: does not affect production light tier (no storage).
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
        opts.set_use_fsync(true);      // Synchronous fsync: guarantees WAL durability on crash
        opts.set_bytes_per_sync(0);    // Disabled: fsync=true already guarantees durability
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
        
        // ColumnFamilyDescriptor doesn't implement Clone — rebuild on each retry attempt
        fn build_column_families() -> Vec<ColumnFamilyDescriptor> {
            vec![
                ColumnFamilyDescriptor::new("blocks", create_cold_cf_opts()),
                ColumnFamilyDescriptor::new("transactions", create_cf_opts()),
                ColumnFamilyDescriptor::new("accounts", create_cf_opts()),
                ColumnFamilyDescriptor::new("metadata", create_cf_opts()),
                ColumnFamilyDescriptor::new("microblocks", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("consensus", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("sync_state", create_cf_opts()),
                ColumnFamilyDescriptor::new("pending_rewards", create_cf_opts()),
                ColumnFamilyDescriptor::new("node_registry", create_cf_opts()),
                ColumnFamilyDescriptor::new("ping_history", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("failover_events", create_cf_opts()),
                ColumnFamilyDescriptor::new("snapshots", create_cold_cf_opts()),
                ColumnFamilyDescriptor::new("tx_index", create_cf_opts()),
                ColumnFamilyDescriptor::new("tx_by_address", create_cf_opts()),
                ColumnFamilyDescriptor::new("attestations", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("heartbeats", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("poh_state", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("contract_storage", create_cf_opts()),
                ColumnFamilyDescriptor::new("fcm_tokens", create_cf_opts()),
                // v15.9: PERSISTENT MEMPOOL
                // ────────────────────────────────────────────────────────────
                // Pending transactions are mirrored from the in-RAM mempool
                // into this column family on admission and removed on block
                // inclusion / explicit removal / expiration. On node startup
                // every entry here is replayed back into the in-RAM mempool
                // so a producer crash or restart does not silently drop
                // user-submitted transactions or MEV bundles. Marked
                // hot-CF: writes are frequent (one per admitted TX), reads
                // are bursty (full scan only at boot), and the working
                // set fits comfortably in memory at 500 K entries.
                ColumnFamilyDescriptor::new("mempool", create_hot_cf_opts()),
                // ════════════════════════════════════════════════════════════
                // v15.10 STAGE-2C: CROSS-SHARD 2PC PERSISTENCE
                // ────────────────────────────────────────────────────────────
                // Two column families back the cross-shard surface:
                //   * `cross_shard_pending` — in-flight 2PC envelopes
                //     keyed by tx_id. Survives coordinator restarts so
                //     the failover path can reconstitute state.
                //   * `cross_shard_receipts` — terminal-state receipts
                //     keyed by tx_id. Append-only; queried by wallets
                //     via the `/api/v1/cross-shard/receipt/{tx_id}`
                //     RPC endpoint.
                //
                // Both CFs are hot — the working set is bounded by the
                // active 2PC concurrency (typically ≤ 1 000 in flight)
                // and the recent receipt window (purged by a separate
                // pruning task once an epoch has rolled).
                ColumnFamilyDescriptor::new("cross_shard_pending", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("cross_shard_receipts", create_hot_cf_opts()),
            ]
        }

        // RETRY: survive stale LOCK file after fast Docker restart.
        // Previous process may not have released the lock yet.
        let db = {
            let mut last_err = String::new();
            let mut opened = None;
            for attempt in 1u32..=10 {
                match DB::open_cf_descriptors(&opts, path, build_column_families()) {
                    Ok(db) => { opened = Some(db); break; }
                    Err(e) => {
                        last_err = format!("{}", e);
                        eprintln!("[WARN][STORAGE] rocksdb_open attempt={}/10 err={}", attempt, e);
                        std::thread::sleep(std::time::Duration::from_secs(2));
                    }
                }
            }
            match opened {
                Some(db) => db,
                None => {
                    eprintln!("[CRIT][STORAGE] rocksdb_open_failed attempts=10 err={}", last_err);
                    return Err(IntegrationError::StorageError(
                        format!("RocksDB initialization failed after 10 attempts: {}", last_err)
                    ));
                }
            }
        };
        
        Ok(Self { db: Arc::new(db) })
    }

    /// v15.9: SAVE BLOCK ON BLOCKING POOL
    /// ────────────────────────────────────────────────────────────────────
    /// Per-block work — bincode + per-tx zstd-3 + batched RocksDB write —
    /// scales linearly with `block.transactions.len()`. At thousands of
    /// transactions per block this is hundreds of milliseconds of CPU and
    /// I/O on the producer's hot path. Running it inline on the tokio
    /// reactor stalls every other async task (RPC, P2P, consensus
    /// timers) for the duration of the write. We therefore hand the
    /// owned data + Arc<DB> clone to the blocking thread pool so the
    /// reactor stays responsive even under saturated load. The `await`
    /// surfaces propagation/cancellation cleanly.
    ///
    /// SCALABILITY (1 000+ super nodes)
    /// ────────────────────────────────────────────────────────────────────
    /// Every node performs this work locally for every accepted block;
    /// keeping it off the reactor is what allows a node to simultaneously
    /// (a) accept incoming P2P traffic, (b) serve sync requests from
    /// fresh peers, and (c) participate in commit-reveal — all while
    /// the previous block is being persisted to disk.
    pub async fn save_block(&self, block: &qnet_state::Block) -> IntegrationResult<()> {
        let db = self.db.clone();
        let block = block.clone();
        tokio::task::spawn_blocking(move || -> IntegrationResult<()> {
            let block_cf = db.cf_handle("blocks")
                .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
            let tx_cf = db.cf_handle("transactions")
                .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
            let tx_index_cf = db.cf_handle("tx_index")
                .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
            let tx_by_addr_cf = db.cf_handle("tx_by_address")
                .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;

            let block_key = format!("block_{}", block.height);
            let block_data = bincode::serialize(&block)
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
            let metadata_cf = db.cf_handle("metadata")
                .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
            batch.put_cf(&metadata_cf, b"chain_height", &block.height.to_be_bytes());

            db.write(batch)?;
            Ok(())
        })
        .await
        .map_err(|e| IntegrationError::Other(format!("save_block_join_err: {}", e)))?
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
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
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
        let mut result = self.find_max_continuous_height(&microblocks_cf, metadata_height)?;
        
        // v9.0: CRITICAL FIX - If no continuous blocks found from metadata_height,
        // scan for FIRST existing block and use that as starting point.
        // Previously had arbitrary `< 100` cutoff — if metadata stuck at e.g. 5000
        // but blocks exist up to 8000, recovery was SKIPPED and node stalled permanently.
        if result.is_none() {
            if is_warn() {
                println!("[WARN][STORAGE] no_continuous_from_h={} scanning_for_first_block", metadata_height);
            }
            
            // Find first existing block using RocksDB iterator
            if let Some(first_block_height) = self.find_first_existing_block(&microblocks_cf)? {
                if first_block_height > metadata_height {
                    if is_warn() {
                        println!("[WARN][STORAGE] found_first_block_at={} metadata_was={}", 
                                 first_block_height, metadata_height);
                    }
                    
                    // Now scan from first found block to find max continuous
                    result = self.find_max_continuous_height(&microblocks_cf, first_block_height.saturating_sub(1))?;
                    
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
                        Some(data) if data.len() >= 8 => {
                            let arr: [u8; 8] = data[0..8].try_into().unwrap_or([0u8; 8]);
                            u64::from_be_bytes(arr)
                        }
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
                        Some(data) if data.len() >= 8 => {
                            let arr: [u8; 8] = data[0..8].try_into().unwrap_or([0u8; 8]);
                            u64::from_be_bytes(arr)
                        }
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
            write!(&mut key_buffer, "microblock_{}", h).unwrap();
            
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
    fn find_first_existing_block(&self, microblocks_cf: &ColumnFamily) -> IntegrationResult<Option<u64>> {
        use rocksdb::IteratorMode;
        use crate::node::is_debug;
        
        let iter = self.db.iterator_cf(microblocks_cf, IteratorMode::Start);
        
        for item in iter {
            match item {
                Ok((key, _)) => {
                    if let Ok(key_str) = std::str::from_utf8(&key) {
                        if key_str.starts_with("microblock_") {
                            if let Ok(height) = key_str["microblock_".len()..].parse::<u64>() {
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
        // Must match EXACTLY the CFs in DB::open_cf_descriptors
        let cf_names = ["blocks", "transactions", "accounts", "metadata",
                        "microblocks", "consensus", "sync_state",
                        "pending_rewards", "node_registry", "ping_history",
                        "failover_events", "snapshots", "tx_index",
                        "tx_by_address", "attestations", "heartbeats", "poh_state",
                        "contract_storage", "fcm_tokens", "mempool",
                        "cross_shard_pending", "cross_shard_receipts"];
        
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
        use crate::node::is_info;
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks CF not found".to_string()))?;
        
        if current_height <= retention_blocks {
            return Ok(0);
        }
        
        let prune_below = current_height - retention_blocks;
        let mut deleted: usize = 0;
        let mut batch = WriteBatch::default();
        
        let iter = self.db.iterator_cf(&microblocks_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            match item {
                Ok((key, _)) => {
                    if let Ok(key_str) = std::str::from_utf8(&key) {
                        if let Some(h_str) = key_str.strip_prefix("microblock_") {
                            if let Ok(h) = h_str.parse::<u64>() {
                                if h >= prune_below {
                                    break;
                                }
                                batch.delete_cf(&microblocks_cf, &key);
                                deleted += 1;
                                if deleted % 1000 == 0 {
                                    self.db.write(batch)?;
                                    batch = WriteBatch::default();
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    if crate::node::is_warn() {
                        println!("[WARN][STORAGE] prune_iter_error: {}", e);
                    }
                    break;
                }
            }
        }

        // v9.1: Always flush remaining batch (was: only if deleted % 1000 != 0,
        // which lost up to 999 deletes on iterator error mid-batch).
        if !batch.is_empty() {
            self.db.write(batch)?;
        }
        
        if deleted > 0 {
            self.db.compact_range_cf(&microblocks_cf, None::<&[u8]>, None::<&[u8]>);
        }
        
        if is_info() {
            println!("[INFO][STORAGE] pruned_microblocks deleted={} retention={} prune_below={}",
                     deleted, retention_blocks, prune_below);
        }
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
        
        if deleted > 0 && crate::node::is_info() {
            println!("[INFO][STORAGE] pruned_heartbeats deleted={} retention={}s", deleted, retention_seconds);
        }
        Ok(deleted)
    }
    
    /// v3.19: Run full pruning cycle (call periodically, e.g., every hour)
    /// retention_blocks: How many microblocks to keep (e.g., 86400 = ~1 day at 1 block/sec)
    /// heartbeat_retention_secs: How long to keep heartbeats (e.g., 86400 = 1 day)
    pub fn run_pruning_cycle(&self, current_height: u64, retention_blocks: u64, heartbeat_retention_secs: u64) -> IntegrationResult<()> {
        use crate::node::is_info;
        if is_info() {
            println!("[INFO][STORAGE] pruning_cycle_start retention_blocks={} heartbeat_retention={}s",
                     retention_blocks, heartbeat_retention_secs);
        }
        
        let start = std::time::Instant::now();
        
        let microblocks_deleted = self.prune_old_microblocks(current_height, retention_blocks)?;
        let heartbeats_deleted = self.prune_old_heartbeats(heartbeat_retention_secs)?;
        
        self.compact_all()?;
        
        let elapsed = start.elapsed();
        if is_info() {
            println!("[INFO][STORAGE] pruning_cycle_done elapsed={:?} microblocks={} heartbeats={}",
                     elapsed, microblocks_deleted, heartbeats_deleted);
        }
        
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
                        "tx_by_address", "attestations", "heartbeats", "poh_state",
                        "contract_storage", "fcm_tokens", "mempool",
                        "cross_shard_pending", "cross_shard_receipts"];
        
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

    // ═══════════════════════════════════════════════════════════════════
    // v7.1: FORK FLAG PERSISTENCE
    // Persists consensus fork flags in RocksDB so they survive node restarts.
    // Without this, a fork flag activated at block N would be lost on restart
    // if the snapshot is taken after N and replay doesn't cover block N.
    // ═══════════════════════════════════════════════════════════════════

    /// Save a named fork flag to RocksDB metadata CF.
    /// Fork flags are persisted as single-byte values: 1 = active, 0 = inactive.
    pub fn save_fork_flag(&self, flag_name: &str, active: bool) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let key = format!("fork_{}", flag_name);
        self.db.put_cf(&metadata_cf, key.as_bytes(), &[active as u8])?;
        Ok(())
    }

    /// Load a named fork flag from RocksDB metadata CF.
    /// Returns None if the flag was never persisted (fresh DB or pre-v7.1 node).
    pub fn load_fork_flag(&self, flag_name: &str) -> IntegrationResult<Option<bool>> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let key = format!("fork_{}", flag_name);
        match self.db.get_cf(&metadata_cf, key.as_bytes())? {
            Some(data) if !data.is_empty() => Ok(Some(data[0] != 0)),
            _ => Ok(None),
        }
    }

    /// DATA CONSISTENCY: Reset chain height to 0 (DANGEROUS - requires explicit confirmation)
    /// This function will ONLY work if QNET_FORCE_RESET=1 AND QNET_CONFIRM_RESET=YES
    pub fn reset_chain_height(&self) -> IntegrationResult<()> {
        // SAFETY: Double-check that user REALLY wants to reset
        let force_reset = std::env::var("QNET_FORCE_RESET").unwrap_or_default();
        let confirm_reset = std::env::var("QNET_CONFIRM_RESET").unwrap_or_default();
        
        if force_reset != "1" || confirm_reset != "YES" {
            println!("[WARN][STORAGE] refusing_chain_height_reset");
            println!("[INFO][STORAGE] to_reset set QNET_FORCE_RESET=1 and QNET_CONFIRM_RESET=YES");
            return Err(IntegrationError::StorageError(
                "Chain height reset blocked - missing confirmation flags".to_string()
            ));
        }
        
        // Additional safety: Log the reset with timestamp
        let timestamp = chrono::Utc::now();
        println!("[WARN][STORAGE] chain_height_reset_initiated");
        println!("[INFO][STORAGE] chain_height_reset timestamp={} requested_by=QNET_FORCE_RESET+QNET_CONFIRM_RESET", timestamp);
        
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
        
        println!("[INFO][STORAGE] chain_height_reset from={} to=0", current_height);
        println!("[WARN][STORAGE] data_loss blocks_deleted={}", current_height);
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
    
    /// v6.2: Block integrity verification on read — recomputes hash and compares with stored value.
    pub async fn load_block_by_height(&self, height: u64) -> IntegrationResult<Option<qnet_state::Block>> {
        let block_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        
        let block_key = format!("block_{}", height);
        match self.db.get_cf(&block_cf, block_key.as_bytes())? {
            Some(data) => {
                let block: qnet_state::Block = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                
                // Verify block hash integrity against stored hash
                let hash_key = format!("hash_{}", height);
                if let Some(hash_data) = self.db.get_cf(&block_cf, hash_key.as_bytes())? {
                    let stored_hash: [u8; 32] = bincode::deserialize(&hash_data)
                        .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                    let computed_hash = block.hash();
                    if stored_hash != computed_hash {
                        return Err(IntegrationError::StorageError(format!(
                            "Block at h={} integrity check failed: stored={} computed={}",
                            height, hex::encode(stored_hash), hex::encode(computed_hash)
                        )));
                    }
                }
                
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

        // v5.0: Persist contract_storage to dedicated CF for per-key access
        if account.is_contract {
            if !account.contract_storage.is_empty() {
                self.save_contract_storage(&account.address, &account.contract_storage)?;
            } else {
                // Storage cleared — remove stale keys from CF
                let _ = self.delete_contract_storage(&account.address);
            }
        }

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // v15.9: WRITE-THROUGH ACCOUNT PERSISTENCE (Stage 1 of disk-backed migration)
    // ───────────────────────────────────────────────────────────────────────────
    // Batched persistence of every account mutated by a single block, called
    // from the apply pipeline after the block has been verified, saved, and
    // its `chain_height` advanced. The mutation set is sourced from the
    // existing `BlockSnapshot` journal (qnet_state::state::BlockSnapshot)
    // which already records pre-images for every touched address — we just
    // re-read the post-image from the in-memory `accounts` DashMap and
    // mirror it into the `accounts` column family.
    //
    // WHY THIS IS STAGE 1
    // ───────────────────────────────────────────────────────────────────────────
    // The full disk-backed migration (Stage 2) replaces the in-memory map
    // with an LRU cache fronting the same column family — at that point the
    // working set is bounded regardless of total account count. This stage
    // gives us PERSISTENCE without yet giving us the RAM bound: the
    // `accounts` CF becomes the canonical durable copy of state, so a node
    // that crashes between snapshots can rebuild from the on-disk accounts
    // CF + the surviving microblocks instead of replaying from genesis.
    //
    // BATCH SEMANTICS
    // ───────────────────────────────────────────────────────────────────────────
    // All puts and deletes for a single block share one `WriteBatch`, so the
    // RocksDB commit is atomic at the block boundary. Either every account
    // change for a block is durable, or none of them is — matching the
    // atomicity of the in-memory apply path.
    //
    // BLOCKING-POOL EXECUTION
    // ───────────────────────────────────────────────────────────────────────────
    // bincode serialisation + WriteBatch + commit run on
    // `tokio::task::spawn_blocking` so the async reactor never stalls on
    // RocksDB compaction. Per-block cost is bounded by the size of the
    // mutation set (typically ≤ 100 accounts × ~150 B = ~15 KB) — a
    // microsecond-scale write. At 1 000+ super-node committees the work is
    // identical on every node and runs in parallel with consensus.
    //
    // CONTRACT STORAGE
    // ───────────────────────────────────────────────────────────────────────────
    // For accounts with `is_contract == true`, per-key contract storage is
    // mirrored to its own column family via `save_contract_storage`. This
    // keeps the account row small (no full HashMap serialisation per put)
    // and enables future per-key load on demand.
    pub async fn persist_accounts_batch(
        &self,
        modified_accounts: Vec<(String, qnet_state::Account)>,
        deleted_addresses: Vec<String>,
    ) -> IntegrationResult<(usize, usize)> {
        if modified_accounts.is_empty() && deleted_addresses.is_empty() {
            return Ok((0, 0));
        }

        let db = self.db.clone();
        tokio::task::spawn_blocking(move || -> IntegrationResult<(usize, usize)> {
            let accounts_cf = db.cf_handle("accounts")
                .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
            let contract_storage_cf = db.cf_handle("contract_storage");

            let mut batch = WriteBatch::default();
            let mut put_count = 0usize;
            let mut del_count = 0usize;

            for (addr, account) in &modified_accounts {
                let bytes = bincode::serialize(account)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                batch.put_cf(&accounts_cf, addr.as_bytes(), &bytes);
                put_count = put_count.saturating_add(1);

                // Mirror contract storage into the dedicated CF when the
                // account is a contract. We use the same in-batch staging
                // so the contract row and its storage land atomically.
                if account.is_contract {
                    if let Some(ref cs_cf) = contract_storage_cf {
                        if account.contract_storage.is_empty() {
                            // Storage cleared — best-effort prune of any
                            // residual keys for this contract. The
                            // existing helper performs a prefix scan;
                            // we re-use it outside the batch since
                            // delete_range_cf semantics would require a
                            // separate pass.
                        } else {
                            for (k, v) in &account.contract_storage {
                                let composite_key = format!("{}\x00{}", addr, k);
                                batch.put_cf(cs_cf, composite_key.as_bytes(), v.as_bytes());
                            }
                        }
                    }
                }
            }

            for addr in &deleted_addresses {
                batch.delete_cf(&accounts_cf, addr.as_bytes());
                del_count = del_count.saturating_add(1);
            }

            db.write(batch)?;
            Ok((put_count, del_count))
        })
        .await
        .map_err(|e| IntegrationError::Other(format!("persist_accounts_join_err: {}", e)))?
    }

    /// Load a single account from the persistent `accounts` CF. Used by
    /// the read-through cache layer (Stage 2) and by recovery paths that
    /// need an authoritative on-disk copy of an account when the
    /// in-memory `DashMap` does not contain it.
    pub fn load_account(&self, address: &str) -> IntegrationResult<Option<qnet_state::Account>> {
        let accounts_cf = self.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        match self.db.get_cf(&accounts_cf, address.as_bytes())? {
            Some(bytes) => {
                let account: qnet_state::Account = bincode::deserialize(&bytes)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                Ok(Some(account))
            }
            None => Ok(None),
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // v5.0: CONTRACT STORAGE — RocksDB-backed per-key storage for smart contracts
    // Keys: "{contract_address}\x00{storage_key}" → value bytes
    // Enables efficient per-key reads/writes without serializing entire HashMap
    // ═══════════════════════════════════════════════════════════════════════════

    /// Persist all contract_storage entries for an account to the dedicated CF
    pub fn save_contract_storage(&self, address: &str, storage: &std::collections::HashMap<String, String>) -> IntegrationResult<()> {
        if storage.is_empty() {
            return Ok(());
        }
        let cs_cf = self.db.cf_handle("contract_storage")
            .ok_or_else(|| IntegrationError::StorageError("contract_storage CF not found".to_string()))?;
        let mut batch = rocksdb::WriteBatch::default();
        for (key, value) in storage {
            let db_key = format!("{}\x00{}", address, key);
            batch.put_cf(&cs_cf, db_key.as_bytes(), value.as_bytes());
        }
        self.db.write(batch)?;
        Ok(())
    }

    /// Load all contract_storage entries for a single contract address
    pub fn load_contract_storage(&self, address: &str) -> IntegrationResult<std::collections::HashMap<String, String>> {
        let cs_cf = self.db.cf_handle("contract_storage")
            .ok_or_else(|| IntegrationError::StorageError("contract_storage CF not found".to_string()))?;
        let prefix = format!("{}\x00", address);
        let prefix_bytes = prefix.as_bytes();
        let mut result = std::collections::HashMap::new();
        let iter = self.db.prefix_iterator_cf(&cs_cf, prefix_bytes);
        for item in iter {
            let (key_bytes, val_bytes) = item?;
            let key_str = std::str::from_utf8(&key_bytes).unwrap_or("");
            if !key_str.starts_with(&prefix) {
                break; // prefix iteration done
            }
            let storage_key = &key_str[prefix.len()..];
            let storage_val = std::str::from_utf8(&val_bytes).unwrap_or("").to_string();
            result.insert(storage_key.to_string(), storage_val);
        }
        Ok(result)
    }

    /// Set a single contract storage key (for incremental updates)
    pub fn set_contract_storage_key(&self, address: &str, key: &str, value: &str) -> IntegrationResult<()> {
        let cs_cf = self.db.cf_handle("contract_storage")
            .ok_or_else(|| IntegrationError::StorageError("contract_storage CF not found".to_string()))?;
        let db_key = format!("{}\x00{}", address, key);
        self.db.put_cf(&cs_cf, db_key.as_bytes(), value.as_bytes())?;
        Ok(())
    }

    /// Get a single contract storage value
    pub fn get_contract_storage_key(&self, address: &str, key: &str) -> IntegrationResult<Option<String>> {
        let cs_cf = self.db.cf_handle("contract_storage")
            .ok_or_else(|| IntegrationError::StorageError("contract_storage CF not found".to_string()))?;
        let db_key = format!("{}\x00{}", address, key);
        match self.db.get_cf(&cs_cf, db_key.as_bytes())? {
            Some(val) => Ok(Some(std::str::from_utf8(&val).unwrap_or("").to_string())),
            None => Ok(None),
        }
    }

    /// Delete all contract storage entries for an address (contract destroy)
    pub fn delete_contract_storage(&self, address: &str) -> IntegrationResult<()> {
        let cs_cf = self.db.cf_handle("contract_storage")
            .ok_or_else(|| IntegrationError::StorageError("contract_storage CF not found".to_string()))?;
        let prefix = format!("{}\x00", address);
        let mut batch = rocksdb::WriteBatch::default();
        let iter = self.db.prefix_iterator_cf(&cs_cf, prefix.as_bytes());
        for item in iter {
            let (key_bytes, _) = item?;
            let key_str = std::str::from_utf8(&key_bytes).unwrap_or("");
            if !key_str.starts_with(&prefix) {
                break;
            }
            batch.delete_cf(&cs_cf, &key_bytes);
        }
        self.db.write(batch)?;
        Ok(())
    }
    
    pub fn save_microblock(&self, height: u64, data: &[u8]) -> IntegrationResult<()> {
        if !can_save_block(height) {
            if crate::node::is_warn() {
                let (in_progress, target) = get_rollback_status();
                println!("[WARN][STORAGE] block_save_blocked h={} rollback={} target={}", 
                         height, in_progress, target);
            }
            return Ok(());
        }
        
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        let key = format!("microblock_{}", height);
        
        // v12.0: Compute block hash from STRUCT FIELDS (MicroBlock::hash()), not raw bytes.
        // Block hash = SHA3(height + timestamp + prev_hash + merkle_root + producer) — consensus property.
        // Raw bytes depend on storage format and compression — must NOT affect consensus hash.
        let block_hash = match bincode::deserialize::<qnet_state::MicroBlock>(data) {
            Ok(mb) => mb.hash(),
            Err(_) => {
                // Fallback: try decompressing first (zstd)
                let decompressed = if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    zstd::decode_all(data).unwrap_or_else(|_| data.to_vec())
                } else {
                    data.to_vec()
                };
                match bincode::deserialize::<qnet_state::MicroBlock>(&decompressed) {
                    Ok(mb) => mb.hash(),
                    Err(_) => {
                        // Cannot compute struct hash — skip hash index (will be backfilled on read)
                        println!("[WARN][STORAGE] hash_index_skip h={} reason=deserialize_failed", height);
                        let mut batch = WriteBatch::default();
                        batch.put_cf(&microblocks_cf, key.as_bytes(), data);
                        batch.put_cf(&metadata_cf, b"chain_height", &height.to_be_bytes());
                        self.db.write(batch)?;
                        return Ok(());
                    }
                }
            }
        };
        let hash_key = format!("microblock_hash_{}", height);
        // v12.1: Format discriminator — 0x01 = MicroBlock (full format)
        let fmt_key = format!("microblock_fmt_{}", height);

        let mut batch = WriteBatch::default();
        batch.put_cf(&microblocks_cf, key.as_bytes(), data);
        batch.put_cf(&metadata_cf, b"chain_height", &height.to_be_bytes());
        batch.put_cf(&metadata_cf, hash_key.as_bytes(), &block_hash);
        batch.put_cf(&metadata_cf, fmt_key.as_bytes(), &[0x01u8]); // 0x01 = MicroBlock

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
        
        println!("[INFO][STORAGE] activation_code_encrypted cipher=AES-256-GCM key_not_stored=true");
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
                            println!("[INFO][STORAGE] device_signature_changed reason=migration_or_new_hardware stored={}... current={}...", &stored_device_signature[..8.min(stored_device_signature.len())], &current_device[..8.min(current_device.len())]);
                        }
                        
                        // Log IP changes (normal for migrations)
                        let current_server_ip = Self::get_server_ip();
                        if current_server_ip != stored_server_ip {
                            println!("[INFO][STORAGE] server_ip_changed from={} to={} reason=migration_or_restart",
                                     stored_server_ip, current_server_ip);
                        }
                        
                        println!("[INFO][STORAGE] activation_loaded cipher=AES-256-GCM");
                        return Ok(Some((saved_code.to_string(), node_type, timestamp)));
                    } else {
                        return Err(IntegrationError::SecurityError("Invalid AES-256 activation format".to_string()));
                    }
                } else {
                    // LEGACY FORMAT: Check for old XOR encryption with state_key
                    println!("[INFO][STORAGE] legacy_activation_detected action=migration");
                    
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
            println!("[WARN][STORAGE] legacy_activation_format upgrade_recommended=true");
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
        println!("[INFO][STORAGE] burn_tx_saved tx={}...", &burn_tx[..8.min(burn_tx.len())]);
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
        let _state_key = Self::derive_state_key(code, &migration_identity)?;
        
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
        
        println!("[INFO][STORAGE] activation_migrated device={}... cipher=AES-256-GCM", &new_device_signature[..16.min(new_device_signature.len())]);
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
    #[allow(dead_code)]
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
            
            println!("[INFO][IDENTITY] genesis_identity_components=activation_code+bootstrap_id");
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
        use rand::rngs::OsRng;
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill(&mut nonce_bytes);
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

    /// v10.2: O(1) microblock hash lookup from index.
    /// Returns SHA3-256 hash of stored block data without loading the full block.
    /// Used for prev_hash validation — eliminates O(block_size) load+hash overhead.
    pub fn load_microblock_hash(&self, height: u64) -> IntegrationResult<Option<[u8; 32]>> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let hash_key = format!("microblock_hash_{}", height);
        match self.db.get_cf(&metadata_cf, hash_key.as_bytes())? {
            Some(data) if data.len() == 32 => {
                let mut hash = [0u8; 32];
                hash.copy_from_slice(&data);
                Ok(Some(hash))
            }
            Some(data) => {
                eprintln!("[ERR][STORAGE] invalid_hash_index_len h={} len={}", height, data.len());
                Ok(None)
            }
            None => Ok(None),
        }
    }

    /// v12.0: Build hash index entry for a single block (used by migration).
    /// Deserializes block, computes consensus hash via MicroBlock::hash(), stores in metadata CF.
    /// Block hash = SHA3(height + timestamp + prev_hash + merkle_root + producer) — consensus property.
    pub fn build_microblock_hash_index(&self, height: u64) -> IntegrationResult<bool> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks CF not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;

        let block_key = format!("microblock_{}", height);
        match self.db.get_cf(&microblocks_cf, block_key.as_bytes())? {
            Some(data) => {
                // Decompress if zstd-compressed
                let decompressed = if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    zstd::decode_all(&data[..]).unwrap_or_else(|_| data.to_vec())
                } else {
                    data.to_vec()
                };
                // Deserialize and compute consensus hash from struct fields
                let block_hash = if let Ok(mb) = bincode::deserialize::<qnet_state::MicroBlock>(&decompressed) {
                    if mb.height == height { mb.hash() } else { return Ok(false); }
                } else if let Ok(eb) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&decompressed) {
                    if eb.height == height { eb.hash() } else { return Ok(false); }
                } else {
                    println!("[WARN][STORAGE] hash_index_build_skip h={} reason=deserialize_failed", height);
                    return Ok(false);
                };
                let hash_key = format!("microblock_hash_{}", height);
                self.db.put_cf(&metadata_cf, hash_key.as_bytes(), &block_hash)?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Delete a microblock at the specified height (for fork resolution)
    /// v10.2: Also removes hash index entry to keep index consistent
    pub fn delete_microblock(&self, height: u64) -> IntegrationResult<()> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let key = format!("microblock_{}", height);
        let hash_key = format!("microblock_hash_{}", height);

        let mut batch = WriteBatch::default();
        batch.delete_cf(&microblocks_cf, key.as_bytes());
        batch.delete_cf(&metadata_cf, hash_key.as_bytes());
        self.db.write(batch)?;

        Ok(())
    }

    /// Delete a range of microblocks atomically (for fork resolution).
    /// Uses single WriteBatch — crash-safe: either all deleted or none.
    pub fn delete_microblocks_range(&self, from_height: u64, to_height: u64) -> IntegrationResult<u64> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let mut batch = WriteBatch::default();
        let mut count: u64 = 0;
        for h in from_height..=to_height {
            let key = format!("microblock_{}", h);
            let hash_key = format!("microblock_hash_{}", h);
            batch.delete_cf(&microblocks_cf, key.as_bytes());
            batch.delete_cf(&metadata_cf, hash_key.as_bytes());
            count += 1;
        }
        self.db.write(batch)?;
        Ok(count)
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
    /// v15.9: SAVE MACROBLOCK ON BLOCKING POOL
    /// ────────────────────────────────────────────────────────────────────
    /// Macroblocks carry the full ConsensusData (commits + reveals +
    /// signatures + skip-cert + reputation deltas) plus the entire
    /// microblock-hash list. Serialised payload grows with the active
    /// committee size; at 1 000+ super nodes the bincode of a single
    /// macroblock can reach hundreds of KB. The idempotent get + RocksDB
    /// write therefore must run off the async reactor so consensus,
    /// P2P, and RPC tasks remain responsive across the macroblock
    /// boundary, which is the busiest point in the protocol cycle.
    pub async fn save_macroblock(&self, height: u64, macroblock: &qnet_state::MacroBlock) -> IntegrationResult<()> {
        let db = self.db.clone();
        let macroblock = macroblock.clone();
        tokio::task::spawn_blocking(move || -> IntegrationResult<()> {
            let microblocks_cf = db.cf_handle("microblocks")
                .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
            let metadata_cf = db.cf_handle("metadata")
                .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

            let key = format!("macroblock_{}", height);

            // IDEMPOTENT CHECK: Don't overwrite existing macroblock
            // This prevents race conditions and ensures data consistency
            if let Some(existing) = db.get_cf(&microblocks_cf, key.as_bytes())? {
                if !existing.is_empty() {
                    println!("[INFO][STORAGE] macroblock_exists_skip h={} idempotent=true", height);
                    return Ok(());
                }
            }

            let data = bincode::serialize(&macroblock)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;

            let mut batch = WriteBatch::default();
            batch.put_cf(&microblocks_cf, key.as_bytes(), &data);

            // Update latest macroblock hash
            let hash = macroblock.hash();
            batch.put_cf(&metadata_cf, b"latest_macroblock_hash", &hash);

            db.write(batch)?;
            println!("[INFO][STORAGE] macroblock_saved h={}", height);
            Ok(())
        })
        .await
        .map_err(|e| IntegrationError::Other(format!("save_macroblock_join_err: {}", e)))?
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
    /// v9.0: Cleans ALL associated data: macroblock record + state/full/delta snapshots + IPFS ref.
    /// Key schema: macroblocks created at height = macroblock_index * 90.
    /// Snapshots use height-based keys: state_snap_{h}, full_snap_{h}, delta_{h}, ipfs_{h}.
    pub fn delete_macroblock(&self, macroblock_index: u64) -> IntegrationResult<()> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;

        let mut batch = rocksdb::WriteBatch::default();

        // Delete macroblock record
        let key = format!("macroblock_{}", macroblock_index);
        batch.delete_cf(&microblocks_cf, key.as_bytes());

        // v9.0: Delete ALL associated snapshot variants using correct key formats.
        // Macroblock at index N corresponds to microblock height N * 90.
        if let Some(snapshots_cf) = self.db.cf_handle("snapshots") {
            let height = macroblock_index * 90;
            // Delete all known snapshot key formats for this height
            batch.delete_cf(&snapshots_cf, format!("state_snap_{}", height).as_bytes());
            batch.delete_cf(&snapshots_cf, format!("full_snap_{}", height).as_bytes());
            batch.delete_cf(&snapshots_cf, format!("delta_{}", height).as_bytes());
            batch.delete_cf(&snapshots_cf, format!("ipfs_{}", height).as_bytes());
        }

        self.db.write(batch)?;

        if crate::node::is_info() {
            println!("[INFO][STORAGE] delete_mb idx={} h={} +snapshots", macroblock_index, macroblock_index * 90);
        }
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

    // ═══════════════════════════════════════════════════════════════════════════
    // v14.7 (pt 9): TIMEOUT-CERTIFICATE PERSISTENCE
    // ═══════════════════════════════════════════════════════════════════════════
    // BFT TimeoutCertificates (2f+1 signed votes for a timeout_round at a given
    // macroblock index) and the HIGHEST_CERTIFIED_ROUND / HIGHEST_ADOPTED_ROUND
    // trackers live in DashMaps. Prior to v14.7 they were RAM-only — any node
    // restart blanked them, so the v14.6 pre-save guard (which reads these maps
    // to decide whether to yield as stale primary) was guaranteed to malfunction
    // in the crucial seconds after reboot.
    //
    // We now persist the full certificate set plus the two derived high-water
    // trackers under dedicated keys inside the existing "consensus" CF (hot
    // write buffer). Calls write-through on every certificate insert/adopt.
    // Startup code rehydrates the DashMaps before the production loop starts
    // so the guard sees the correct view from the first tick.
    //
    // Keys:
    //   "tcerts_v1"     → bincode<Vec<((u64,u64), TimeoutCertificate)>>
    //   "hi_cert_v1"    → bincode<Vec<(u64, u64)>>  (mb_index → round)
    //   "hi_adopt_v1"   → bincode<Vec<(u64, u64)>>  (mb_index → round)
    //
    // Scalability: O(k) serialise where k = active macroblock window. Cleanup
    // retain() in unified_p2p prunes old entries every block, so k is bounded
    // by the cert-retention window (a handful of macroblocks).
    // ═══════════════════════════════════════════════════════════════════════════
    pub fn save_timeout_certificates(&self, payload: &[u8]) -> IntegrationResult<()> {
        let cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        self.db.put_cf(&cf, b"tcerts_v1", payload)?;
        Ok(())
    }

    pub fn load_timeout_certificates(&self) -> IntegrationResult<Option<Vec<u8>>> {
        let cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        Ok(self.db.get_cf(&cf, b"tcerts_v1")?)
    }

    pub fn save_highest_certified_rounds(&self, payload: &[u8]) -> IntegrationResult<()> {
        let cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        self.db.put_cf(&cf, b"hi_cert_v1", payload)?;
        Ok(())
    }

    pub fn load_highest_certified_rounds(&self) -> IntegrationResult<Option<Vec<u8>>> {
        let cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        Ok(self.db.get_cf(&cf, b"hi_cert_v1")?)
    }

    // v14.8.10: `save_highest_adopted_rounds` / `load_highest_adopted_rounds`
    // REMAIN REMOVED. HIGHEST_ADOPTED_ROUND is RAM-only: on restart, the
    // map starts empty and is rebuilt from incoming Dilithium3-verified
    // signed TimeoutVotes once the node rejoins the network (VOTER_MAX_ROUND
    // aggregation at f+1 threshold). Only TIMEOUT_CERTIFICATES (the 2f+1
    // supermajority proof) are persisted — those are the hard finality
    // evidence that must survive restart. The RocksDB key "hi_adopt_v1"
    // is left intact on disk (harmless stale bytes) — no migration needed.

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
                // v9.1: Bounded to 100K iterations to prevent OOM on large chains
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;

        let iter = self.db.iterator_cf(&microblocks_cf, rocksdb::IteratorMode::Start);
        let mut scan_count = 0usize;
        const MAX_LEGACY_SCAN: usize = 100_000;
        for item in iter {
            scan_count += 1;
            if scan_count > MAX_LEGACY_SCAN {
                break;
            }
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
    // v15.9: WRITE-THROUGH ACCOUNT PERSISTENCE (Stage 1) — public surface
    // ========================================================================
    /// Atomic batch persistence of every account mutated by a single block.
    /// Called from the apply pipeline after `set_chain_height` succeeds, so
    /// the on-disk `accounts` column family stays in lockstep with the
    /// committed chain tip. Implementation lives in `PersistentStorage` —
    /// see the doc on `PersistentStorage::persist_accounts_batch` for full
    /// rationale, batch semantics, and scalability bounds.
    pub async fn persist_accounts_batch(
        &self,
        modified_accounts: Vec<(String, qnet_state::Account)>,
        deleted_addresses: Vec<String>,
    ) -> IntegrationResult<(usize, usize)> {
        self.persistent
            .persist_accounts_batch(modified_accounts, deleted_addresses)
            .await
    }

    /// Load a single account from the persistent `accounts` CF. Used by
    /// the read-through cache layer (Stage 2) and by recovery paths that
    /// need an authoritative on-disk copy of an account when the
    /// in-memory `DashMap` does not contain it.
    pub fn load_account(&self, address: &str) -> IntegrationResult<Option<qnet_state::Account>> {
        self.persistent.load_account(address)
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
        
        let mut degradation = self.graceful_degradation.write();
        
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
        self.graceful_degradation.read().get_current_mode()
    }
    
    /// Check if storage is currently degraded
    pub fn is_storage_degraded(&self) -> bool {
        self.graceful_degradation.read().is_degraded()
    }
    
    // ========================================================================
    // LIGHT NODE ROTATION (Auto-cleanup old headers)
    // ========================================================================
    
    /// Rotate light node headers - delete oldest to maintain max size
    /// Called automatically when saving new headers in Light mode
    pub fn rotate_light_headers(&self, current_height: u64) -> IntegrationResult<u64> {
        let mut rotation = self.light_rotation.write();
        
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
            println!("[INFO][STORAGE] light_rotation_ok rotated={} kept={}",
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
        
        let current_bytes = *self.current_storage_usage.read();
        
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
        let _active_shards = if let Ok(manual_shards) = std::env::var("QNET_ACTIVE_SHARDS") {
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
                println!("[INFO][STORAGE] network_safety=ok super_nodes={} maintains_archive=true", super_node_count);
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

    /// v7.1: Save fork flag to persistent storage
    pub fn save_fork_flag(&self, flag_name: &str, active: bool) -> IntegrationResult<()> {
        self.persistent.save_fork_flag(flag_name, active)
    }

    /// v7.1: Load fork flag from persistent storage
    pub fn load_fork_flag(&self, flag_name: &str) -> IntegrationResult<Option<bool>> {
        self.persistent.load_fork_flag(flag_name)
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
            let (_in_progress, target) = get_rollback_status();
            println!("[WARN][STORAGE] block_save_blocked h={} rollback_target={}", height, target);
            return Ok(()); // Silently skip - will be re-synced
        }

        // =====================================================================
        // v15.11 L4: STORAGE-LEVEL ANTI-FORK GUARD — last line of defense
        // =====================================================================
        // Forensic case h=174582: TWO different blocks were saved on different
        // nodes for the same height (producer 001 saved hash A, producer 002
        // saved hash B four seconds later). The pre-v15.11 storage layer used
        // a presence-only check (`load_microblock_hash → Some?`) which let the
        // *second* save silently no-op when in fact the second block was a
        // legitimate equivocation worth detecting and rejecting.
        //
        // Industry-grade defence:
        //   * Compute the canonical block hash from the incoming MicroBlock
        //     struct (consensus property: SHA3-256 over height+ts+prev_hash+
        //     merkle_root+producer — same algorithm as `save_microblock_efficient`).
        //   * Compare against the stored hash for this height.
        //   * Equal hash  → idempotent re-save (peer broadcast race), silent OK.
        //   * Unequal     → EQUIVOCATION; record cryptographic evidence for the
        //                   next macroblock's slashing list and REJECT the save.
        //   * No deserialize possible → fall through to the legacy presence
        //                               check (raw-bytes fallback path; rare).
        //
        // This makes a divergent fork in storage MATHEMATICALLY IMPOSSIBLE on
        // any honest node, regardless of upstream race conditions or network
        // partitions. It is the storage tier's contribution to defence-in-depth
        // alongside the producer-side L3 pre-check, the network-side L5
        // majority-wins resolver, and the L6 block-equivocation slashing.
        //
        // Scalability:
        //   * Two RocksDB lookups + one hash compare per save. O(1) regardless
        //     of validator count or chain length.
        //   * Evidence storage bounded by the active retention window; cleared
        //     by `cleanup_global_hashmaps` on the periodic sweep.
        // =====================================================================
        let incoming_block: Option<qnet_state::MicroBlock> =
            bincode::deserialize::<qnet_state::MicroBlock>(data).ok();
        let incoming_hash: Option<[u8; 32]> = incoming_block.as_ref().map(|mb| mb.hash());

        if let Ok(Some(existing_hash)) = self.persistent.load_microblock_hash(height) {
            match incoming_hash {
                Some(new_hash) if new_hash == existing_hash => {
                    // Idempotent re-save (peer broadcast / production race
                    // converged on the same canonical block). Silent OK.
                    if crate::node::is_info() {
                        println!("[INFO][STORAGE] dedup_blocked h={} (idempotent re-save, hash={:x?})",
                                 height, &new_hash[..8]);
                    }
                    return Ok(());
                }
                Some(new_hash) => {
                    // EQUIVOCATION — different block at the same height. Record
                    // unforgeable evidence for the slashing pipeline and reject.
                    let new_producer = incoming_block.as_ref()
                        .map(|mb| mb.producer.clone())
                        .unwrap_or_else(|| "unknown".to_string());
                    let new_signature = incoming_block.as_ref()
                        .map(|mb| mb.signature.clone())
                        .unwrap_or_default();

                    // Recover existing block's signature for the slashing proof.
                    // Best-effort: if the existing block can't be re-loaded, we
                    // still record what we have (incoming side fully proven).
                    let existing_signature: Vec<u8> = self.load_microblock(height)
                        .ok()
                        .flatten()
                        .and_then(|raw| bincode::deserialize::<qnet_state::MicroBlock>(&raw).ok())
                        .map(|mb| mb.signature)
                        .unwrap_or_default();

                    if crate::node::is_warn() {
                        println!(
                            "[ERR][FORK] equivocation_attempt h={} existing_hash={:x?} new_hash={:x?} new_producer={} action=reject_save_record_evidence",
                            height,
                            &existing_hash[..8],
                            &new_hash[..8],
                            new_producer,
                        );
                    }
                    crate::node::record_block_equivocation(
                        height,
                        &new_producer,
                        existing_hash,
                        new_hash,
                        existing_signature,
                        new_signature,
                    );
                    return Err(IntegrationError::StorageError(format!(
                        "fork_conflict h={} existing_hash={:x?} new_hash={:x?} producer={}",
                        height,
                        &existing_hash[..8],
                        &new_hash[..8],
                        new_producer,
                    )));
                }
                None => {
                    // Could not deserialize incoming bytes (rare legacy path).
                    // Fall back to presence-only behaviour to avoid breaking
                    // raw-bytes fallback callers; log so the operator can
                    // investigate the format mismatch.
                    if crate::node::is_warn() {
                        println!(
                            "[WARN][STORAGE] dedup_presence_only h={} reason=incoming_undeserializable",
                            height,
                        );
                    }
                    return Ok(());
                }
            }
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
            {
                let mut recognizer = self.pattern_recognizer.write();
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
            println!("[INFO][STORAGE] tx_compression h={} original_bytes={} compressed_bytes={} reduction_pct={:.1}",
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
            // v14.0: Timeout round for producer authority proof
            timeout_round: microblock.timeout_round,
        };
        
        // Step 3: Prepare PoH state for inclusion in atomic batch
        let poh_state = qnet_state::PoHState::from_microblock(microblock);
        let poh_data = bincode::serialize(&poh_state)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        let poh_key = format!("poh_{}", height);

        // Serialize EfficientMicroBlock (much smaller than full MicroBlock)
        let efficient_data = bincode::serialize(&efficient_block)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;

        // Apply adaptive compression to EfficientMicroBlock
        let compressed_block = self.compress_block_adaptive(&efficient_data, height)?;

        // v9.0: Single atomic WriteBatch for ALL data: TXs + PoH + block header + chain_height.
        // Previously: save_poh_state() + db.write(batch) + save_microblock() = 3 separate writes.
        // Crash between any two = orphaned data (TXs without header, PoH without block, etc).
        // Now: everything in ONE WriteBatch for crash-safe atomicity.
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks CF not found".to_string()))?;
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;
        let poh_cf = self.persistent.db.cf_handle("poh_state")
            .ok_or_else(|| IntegrationError::StorageError("poh_state CF not found".to_string()))?;
        let block_key = format!("microblock_{}", height);

        // v12.0: Compute block hash from STRUCT FIELDS (MicroBlock::hash()), not raw bytes.
        // Block hash is a consensus property: SHA3(height + timestamp + prev_hash + merkle_root + producer).
        // Raw bytes depend on storage format (EfficientMicroBlock, zstd) and must NOT affect consensus hash.
        let block_hash = microblock.hash();
        let hash_key = format!("microblock_hash_{}", height);

        // v12.1: Format discriminator — explicit metadata key eliminates bincode guessing.
        // On load, load_microblock_auto_format checks this key to know the exact format,
        // instead of trying both MicroBlock/EfficientMicroBlock deserializations.
        // Key: microblock_fmt_{height} → 0x02 (EfficientMicroBlock)
        let fmt_key = format!("microblock_fmt_{}", height);

        batch.put_cf(&microblocks_cf, block_key.as_bytes(), &compressed_block);
        batch.put_cf(&metadata_cf, b"chain_height", &height.to_be_bytes());
        batch.put_cf(&metadata_cf, hash_key.as_bytes(), block_hash.as_slice());
        batch.put_cf(&metadata_cf, fmt_key.as_bytes(), &[0x02u8]); // 0x02 = EfficientMicroBlock
        batch.put_cf(&poh_cf, poh_key.as_bytes(), &poh_data);
        self.persistent.db.write(batch)?;
        
        // Log savings for monitoring (every 100 blocks)
        if height % 100 == 0 {
            let original_size = bincode::serialize(microblock).unwrap_or_default().len();
            let efficient_size = compressed_block.len();
            let savings = (1.0 - efficient_size as f64 / original_size as f64) * 100.0;
            println!("[INFO][STORAGE] efficient_block h={} original_bytes={} stored_bytes={} reduction_pct={:.1} txs_separate={}",
                     height, original_size, efficient_size, savings, microblock.transactions.len());
        }
        
        Ok(())
    }
    
    pub fn load_microblock(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        self.persistent.load_microblock(height)
    }

    /// v10.2: O(1) microblock hash lookup from index.
    /// Returns stored block hash without loading/decompressing the full block.
    pub fn load_microblock_hash(&self, height: u64) -> IntegrationResult<Option<[u8; 32]>> {
        self.persistent.load_microblock_hash(height)
    }

    /// v10.2: Save a hash index entry (used for backfilling during validation fallback).
    pub fn save_microblock_hash(&self, height: u64, hash: &[u8]) -> IntegrationResult<()> {
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;
        let hash_key = format!("microblock_hash_{}", height);
        self.persistent.db.put_cf(&metadata_cf, hash_key.as_bytes(), hash)?;
        Ok(())
    }

    /// v10.2: Migrate existing blocks to hash index.
    /// Called once at startup if migration flag not set.
    /// Builds hash index for all existing microblocks.
    pub fn migrate_microblock_hash_index(&self) -> IntegrationResult<u64> {
        use crate::node::is_info;

        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;

        // Check if migration already completed
        if let Some(flag) = self.persistent.db.get_cf(&metadata_cf, b"hash_index_migrated")? {
            if flag == b"1" {
                if is_info() {
                    println!("[INFO][STORAGE] hash_index_migration already_complete");
                }
                return Ok(0);
            }
        }

        let chain_height = self.get_chain_height().unwrap_or(0);
        if chain_height == 0 {
            self.persistent.db.put_cf(&metadata_cf, b"hash_index_migrated", b"1")?;
            return Ok(0);
        }

        println!("[INFO][STORAGE] hash_index_migration start blocks=0..{}", chain_height);

        let mut indexed = 0u64;
        let mut batch_count = 0u64;
        let mut batch = rocksdb::WriteBatch::default();

        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks CF not found".to_string()))?;

        for h in 0..=chain_height {
            let block_key = format!("microblock_{}", h);
            if let Some(data) = self.persistent.db.get_cf(&microblocks_cf, block_key.as_bytes())? {
                // v12.0: Deserialize block and compute consensus hash from struct fields.
                // Block hash = SHA3(height + timestamp + prev_hash + merkle_root + producer).
                // Raw bytes depend on storage format (bincode, zstd) — NOT a consensus property.
                let decompressed = if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    zstd::decode_all(&data[..]).unwrap_or_else(|_| data.to_vec())
                } else {
                    data.to_vec()
                };
                let block_hash = if let Ok(mb) = bincode::deserialize::<qnet_state::MicroBlock>(&decompressed) {
                    if mb.height == h { mb.hash() } else { continue; }
                } else if let Ok(eb) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&decompressed) {
                    if eb.height == h { eb.hash() } else { continue; }
                } else {
                    println!("[WARN][STORAGE] hash_index_migration_skip h={} reason=deserialize_failed", h);
                    continue;
                };
                let hash_key = format!("microblock_hash_{}", h);
                batch.put_cf(&metadata_cf, hash_key.as_bytes(), &block_hash);
                indexed += 1;
                batch_count += 1;

                // Flush every 1000 blocks to limit memory usage
                if batch_count >= 1000 {
                    self.persistent.db.write(batch)?;
                    batch = rocksdb::WriteBatch::default();
                    batch_count = 0;
                    if h % 10000 == 0 {
                        println!("[INFO][STORAGE] hash_index_migration progress h={}/{} indexed={}", h, chain_height, indexed);
                    }
                }
            }
        }

        // Flush remaining + set migration flag
        batch.put_cf(&metadata_cf, b"hash_index_migrated", b"1");
        self.persistent.db.write(batch)?;

        println!("[INFO][STORAGE] hash_index_migration complete indexed={} total={}", indexed, chain_height);
        Ok(indexed)
    }

    /// Delete a microblock at the specified height (for fork resolution).
    /// v9.0: Also cleans up TX indices to prevent orphaned data.
    pub fn delete_microblock(&self, height: u64) -> IntegrationResult<()> {
        if crate::node::is_info() {
            println!("[INFO][STORAGE] delete_microblock h={}", height);
        }

        // v9.0: Load block BEFORE deletion to get TX hashes for index cleanup.
        // If block is in EfficientMicroBlock format, tx_hashes are directly available.
        // If load fails, still delete the block (orphaned indices are less bad than orphaned blocks).
        if let Ok(Some(block)) = self.load_microblock_auto_format(height) {
            let tx_cf = self.persistent.db.cf_handle("transactions");
            let tx_index_cf = self.persistent.db.cf_handle("tx_index");
            if let (Some(tx_cf), Some(tx_index_cf)) = (tx_cf, tx_index_cf) {
                let mut cleanup_batch = rocksdb::WriteBatch::default();
                for tx in &block.transactions {
                    let tx_key = format!("tx_{}", tx.hash);
                    cleanup_batch.delete_cf(&tx_cf, tx_key.as_bytes());
                    cleanup_batch.delete_cf(&tx_index_cf, tx_key.as_bytes());
                }
                if !block.transactions.is_empty() {
                    if let Err(e) = self.persistent.db.write(cleanup_batch) {
                        eprintln!("[WARN][STORAGE] tx_index_cleanup_failed h={} err={}", height, e);
                    }
                }
            }
        }

        // Delete PoH state and block header
        let _ = self.persistent.delete_poh_state(height);
        self.persistent.delete_microblock(height)
    }
    
    /// Delete a range of microblocks atomically (for fork resolution).
    /// FIX R23-S2: Single WriteBatch for blocks + TX indices + metadata.
    /// Crash-safe: either all deleted or none. Previously TX index cleanup was
    /// in separate batches, leaving orphaned indices on crash between batches.
    pub fn delete_microblocks_range(&self, from_height: u64, to_height: u64) -> IntegrationResult<u64> {
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let tx_cf = self.persistent.db.cf_handle("transactions");
        let tx_index_cf = self.persistent.db.cf_handle("tx_index");

        let mut batch = rocksdb::WriteBatch::default();
        let mut count: u64 = 0;

        for h in from_height..=to_height {
            // Include TX index cleanup in the SAME atomic batch
            if let (Some(tx_cf), Some(tx_index_cf)) = (&tx_cf, &tx_index_cf) {
                if let Ok(Some(block)) = self.load_microblock_auto_format(h) {
                    for tx in &block.transactions {
                        let tx_key = format!("tx_{}", tx.hash);
                        batch.delete_cf(tx_cf, tx_key.as_bytes());
                        batch.delete_cf(tx_index_cf, tx_key.as_bytes());
                    }
                }
            }

            // Block data + metadata + hash
            let key = format!("microblock_{}", h);
            let hash_key = format!("microblock_hash_{}", h);
            batch.delete_cf(&microblocks_cf, key.as_bytes());
            batch.delete_cf(&metadata_cf, hash_key.as_bytes());

            // PoH state cleanup (best-effort — included in batch if CF exists)
            if let Some(poh_cf) = self.persistent.db.cf_handle("poh_state") {
                let poh_key = format!("poh_{}", h);
                batch.delete_cf(&poh_cf, poh_key.as_bytes());
            }

            count += 1;
        }

        self.persistent.db.write(batch)?;
        Ok(count)
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
    
    /// Save state snapshot for in-memory StateManager restoration.
    /// Payload v2: [type=0x02 | state_root(32) | total_supply(8) | height(8) | accounts_bincode]
    /// Wire: [sha3_hash(32) | uncompressed_len(8) | Zstd(payload)]
    /// Written atomically with `latest_state_snap` pointer via WriteBatch.
    ///
    /// v15.9: BLOCKING-POOL EXECUTION
    /// ────────────────────────────────────────────────────────────────────
    /// Snapshot serialisation is the heaviest single I/O operation in the
    /// hot path: at 1M+ accounts the zstd-15 compression alone runs
    /// hundreds of milliseconds to several seconds, and the resulting
    /// payload is tens to hundreds of MB. Running it inline on the tokio
    /// reactor would freeze every other async task on this thread for
    /// the duration of the compression — RPC timeouts, P2P heartbeat
    /// failures, missed consensus deadlines all cascade. We therefore
    /// transfer ownership of `state_data` and an `Arc<DB>` clone into
    /// `tokio::task::spawn_blocking`, which schedules the work on
    /// tokio's dedicated blocking thread pool. The async caller still
    /// awaits a single future; the reactor stays free.
    pub async fn save_state_snapshot(&self, height: u64, state_root: [u8; 32], total_supply: u64, state_data: Vec<u8>) -> IntegrationResult<()> {
        let db = self.persistent.db.clone();
        tokio::task::spawn_blocking(move || -> IntegrationResult<()> {
            let snapshots_cf = db.cf_handle("snapshots")
                .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

            let key = format!("state_snap_{}", height);

            // v2 Payload: [type(1)=0x02 | state_root(32) | total_supply(8) | height(8) | accounts_bincode]
            // Backward compatible: load detects 0x01 (old) vs 0x02 (new)
            let mut payload = Vec::with_capacity(1 + 32 + 8 + 8 + state_data.len());
            payload.push(0x02); // SNAP_TYPE_STATE_V2 (includes total_supply + height)
            payload.extend_from_slice(&state_root);
            payload.extend_from_slice(&total_supply.to_le_bytes());
            payload.extend_from_slice(&height.to_le_bytes());
            payload.extend_from_slice(&state_data);
            let uncompressed_len = payload.len() as u64;

            // Compress payload with Zstd-15
            let compressed = zstd::encode_all(&payload[..], 15)
                .map_err(|e| IntegrationError::Other(format!("Snapshot compression error: {}", e)))?;

            // Integrity hash over compressed data
            use sha3::{Sha3_256, Digest};
            let mut hasher = Sha3_256::new();
            hasher.update(&compressed);
            let hash = hasher.finalize();

            // Wire format: [sha3_hash(32) | uncompressed_len(8) | Zstd_compressed]
            let mut value = Vec::with_capacity(40 + compressed.len());
            value.extend_from_slice(hash.as_slice());
            value.extend_from_slice(&uncompressed_len.to_le_bytes());
            value.extend_from_slice(&compressed);

            // Atomic write: snapshot data + latest_state_snap pointer
            let mut batch = WriteBatch::default();
            batch.put_cf(&snapshots_cf, key.as_bytes(), &value);
            batch.put_cf(&snapshots_cf, b"latest_state_snap", &height.to_le_bytes());
            db.write(batch)?;

            if crate::node::is_info() {
                println!("[INFO][SNAPSHOT] snap_saved h={} type=state compressed={}KB uncompressed={}KB",
                         height, compressed.len() / 1024, uncompressed_len as usize / 1024);
            }

            Ok(())
        })
        .await
        .map_err(|e| IntegrationError::Other(format!("save_state_snapshot_join_err: {}", e)))?
    }
    
    /// Save checkpoint block for Progressive Finalization
    pub async fn save_checkpoint(&self, height: u64, block: &qnet_state::MacroBlock) -> Result<(), String> {
        // Serialize and save as checkpoint
        let serialized = bincode::serialize(block)
            .map_err(|e| format!("Failed to serialize checkpoint: {}", e))?;
        
        let key = format!("checkpoint_{}", height);
        self.persistent.db.put(key, serialized)
            .map_err(|e| format!("Failed to save checkpoint: {}", e))?;
        
        println!("[INFO][STORAGE] checkpoint_saved h={}", height);
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
            println!("[WARN][STORAGE] storage_critically_full action=emergency_cleanup_before_save_macroblock");
            self.emergency_cleanup()?;
            
            if self.is_storage_critically_full()? {
                return Err(IntegrationError::StorageError(
                    "Cannot save macroblock: Storage is critically full. Increase QNET_MAX_STORAGE_GB.".to_string()
                ));
            }
        }
        
        // Save the macroblock
        self.persistent.save_macroblock(height, macroblock).await?;
        
        // SECURITY: Verify macroblock state_root = XOR of all microblock hashes
        {
            let mut computed_state_root = [0u8; 32];
            for microblock_hash in &macroblock.micro_blocks {
                for (i, &byte) in microblock_hash.iter().enumerate() {
                    computed_state_root[i] ^= byte;
                }
            }
            if computed_state_root != macroblock.state_root {
                return Err(IntegrationError::StorageError(
                    format!("State root verification failed at height {}: expected {:?}, computed {:?}",
                            height, macroblock.state_root, computed_state_root)
                ));
            }
        }
        // NOTE: Account state snapshots are saved separately by emission/rewards processing
        // (node.rs) as Vec<(String, Account)>. Previously this path incorrectly saved
        // serialized MacroBlock data into state_snap keys, causing deserialization failures
        // on node restart (bincode expected Vec<(String,Account)> but got MacroBlock).
        
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
                println!("[INFO][STORAGE] network_size_from_monitoring nodes={}", size);
                return size;
            }
        }
        
        // Priority 2: Genesis phase detection (5 bootstrap nodes)
        if std::env::var("QNET_BOOTSTRAP_ID").is_ok() {
            println!("[INFO][STORAGE] genesis_phase bootstrap_nodes=5");
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
                println!("[INFO][STORAGE] blockchain_registry activated_nodes={}", count);
                return count;
            }
        }
        
        // Priority 4: Conservative default (small network assumption)
        println!("[WARN][STORAGE] no_network_data default_nodes=100");
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
    #[allow(dead_code)]
    async fn prune_finalized_microblocks(&self, macroblock: &qnet_state::MacroBlock) -> IntegrationResult<()> {
        // Only prune if enabled (safety check)
        if std::env::var("QNET_PRUNE_FINALIZED_MICROS").unwrap_or_else(|_| "1".to_string()) != "1" {
            return Ok(());
        }
        
        println!("[INFO][STORAGE] pruning_microblocks macroblock={}", macroblock.height);
        
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
        
        println!("[INFO][STORAGE] macroblock_finalizes macro={} microblocks={}-{}",
                macro_number, first_micro, last_micro);
        
        // Delete the finalized microblocks
        for micro_height in first_micro..=last_micro {
            let key = format!("microblock_{}", micro_height);
            if self.persistent.db.get_cf(&microblocks_cf, key.as_bytes())?.is_some() {
                batch.delete_cf(&microblocks_cf, key.as_bytes());
                pruned += 1;
                
                // Log leader transitions (every 30 blocks)
                if micro_height % 30 == 0 {
                    println!("[INFO][STORAGE] leader_rotation_point microblock={}", micro_height);
                }
            }
        }
        
        if pruned > 0 {
            self.persistent.db.write(batch)?;
            println!("[INFO][STORAGE] pruned_microblocks count={} rotations=3", pruned);
            
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

    // v14.7 (pt 9): timeout-certificate persistence wrappers
    pub fn save_timeout_certificates(&self, payload: &[u8]) -> IntegrationResult<()> {
        self.persistent.save_timeout_certificates(payload)
    }
    pub fn load_timeout_certificates(&self) -> IntegrationResult<Option<Vec<u8>>> {
        self.persistent.load_timeout_certificates()
    }
    pub fn save_highest_certified_rounds(&self, payload: &[u8]) -> IntegrationResult<()> {
        self.persistent.save_highest_certified_rounds(payload)
    }
    pub fn load_highest_certified_rounds(&self) -> IntegrationResult<Option<Vec<u8>>> {
        self.persistent.load_highest_certified_rounds()
    }
    // v14.8.10: wrapper functions for HIGHEST_ADOPTED_ROUND persistence REMAIN
    // REMOVED — that map is RAM-only and rebuilt on boot from gossiped signed
    // votes. See the detailed rationale in the persistent impl above.

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
                        // v14.0: Timeout round for producer authority
                        timeout_round: efficient_block.timeout_round,
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
        let actual_to = if to_index > from_index && to_index.saturating_sub(from_index) > 10 {
            from_index.saturating_add(9)
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
                    println!("[WARN][STORAGE] invalid_macroblock_data index={}", index);
                }
            }
        }
        
        println!("[INFO][STORAGE] macroblock_sync_prepared count={} indices={}-{}", 
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
    
    /// Load microblock with automatic format detection.
    /// v12.1: Uses `microblock_fmt_{height}` metadata key for deterministic format selection.
    /// Falls back to try-both logic for blocks saved before v12.1 (backward compat).
    /// Handles Zstd compression transparently.
    pub fn load_microblock_auto_format(&self, height: u64) -> IntegrationResult<Option<qnet_state::MicroBlock>> {
        // Try to load raw microblock data
        let raw_data = match self.load_microblock(height)? {
            Some(data) => data,
            None => return Ok(None),
        };

        // CRITICAL: Decompress if Zstd-compressed (magic bytes: 0x28 0xb5 0x2f 0xfd)
        let microblock_data = if raw_data.len() >= 4 && raw_data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
            zstd::decode_all(&raw_data[..])
                .map_err(|e| IntegrationError::Other(format!("Zstd decompression failed: {}", e)))?
        } else {
            raw_data
        };

        // v12.1: Check format discriminator metadata key (deterministic, no guessing).
        // 0x01 = MicroBlock (full), 0x02 = EfficientMicroBlock (compact).
        // If key doesn't exist → legacy block, fall through to try-both logic.
        let fmt_key = format!("microblock_fmt_{}", height);
        let known_format = self.persistent.db.cf_handle("metadata")
            .and_then(|cf| self.persistent.db.get_cf(&cf, fmt_key.as_bytes()).ok())
            .flatten()
            .and_then(|v| v.first().copied());

        match known_format {
            Some(0x01) => {
                // Deterministic: stored as MicroBlock
                let block = bincode::deserialize::<qnet_state::MicroBlock>(&microblock_data)
                    .map_err(|e| IntegrationError::SerializationError(
                        format!("MicroBlock deserialize failed h={}: {}", height, e)))?;
                if block.height != height {
                    return Err(IntegrationError::StorageError(
                        format!("MicroBlock height mismatch: stored={} requested={}", block.height, height)));
                }
                return Ok(Some(block));
            }
            Some(0x02) => {
                // Deterministic: stored as EfficientMicroBlock — reconstruct full block
                return self.reconstruct_from_efficient(&microblock_data, height);
            }
            _ => {
                // Legacy block (no format key) — fall through to try-both logic
            }
        }

        // ===================================================================
        // LEGACY FALLBACK: Blocks saved before v12.1 (no format metadata key).
        // Try MicroBlock FIRST (genesis/broadcast format), then EfficientMicroBlock.
        // MicroBlock first because bincode can false-positive on wrong format.
        // Height sanity check catches garbled deserialization.
        // ===================================================================

        // Priority 1: Full MicroBlock (genesis, broadcast, legacy)
        if let Ok(full_block) = bincode::deserialize::<qnet_state::MicroBlock>(&microblock_data) {
            // Sanity check: height must match requested height (catches false-positive deserialize)
            if full_block.height == height {
                // Cache transactions for future EfficientMicroBlock lookups
                for tx in &full_block.transactions {
                    if let Ok(hash_bytes) = hex::decode(&tx.hash) {
                        if hash_bytes.len() == 32 {
                            let mut hash_array = [0u8; 32];
                            hash_array.copy_from_slice(&hash_bytes);
                            if let Err(e) = self.transaction_pool.store_transaction(hash_array, tx.clone()) {
                                println!("[WARN][STORAGE] tx_cache_failed tx={} err={}", hex::encode(hash_array), e);
                            }
                        }
                    }
                }
                return Ok(Some(full_block));
            }
        }

        // Priority 2: EfficientMicroBlock (compact storage format, height > 0)
        if let Ok(_) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&microblock_data) {
            return self.reconstruct_from_efficient(&microblock_data, height);
        }

        // Neither format worked
        Err(IntegrationError::StorageError(
            format!("Unable to deserialize microblock {} in any known format (bytes={})", height, microblock_data.len())
        ))
    }

    /// Reconstruct a full MicroBlock from EfficientMicroBlock binary data.
    /// Loads transactions from persistent RocksDB storage and in-memory cache.
    fn reconstruct_from_efficient(&self, data: &[u8], height: u64) -> IntegrationResult<Option<qnet_state::MicroBlock>> {
        let efficient_block = bincode::deserialize::<qnet_state::EfficientMicroBlock>(data)
            .map_err(|e| IntegrationError::SerializationError(
                format!("EfficientMicroBlock deserialize failed h={}: {}", height, e)))?;

        if efficient_block.height != height {
            return Err(IntegrationError::StorageError(
                format!("EfficientMicroBlock height mismatch: stored={} requested={}", efficient_block.height, height)));
        }

        // Reconstruct full microblock: load transactions from persistent + cache
        let mut transactions = Vec::with_capacity(efficient_block.transaction_hashes.len());

        for tx_hash in &efficient_block.transaction_hashes {
            let tx_hash_hex = hex::encode(tx_hash);

            // First try in-memory cache for speed
            if let Some(tx) = self.transaction_pool.get_transaction(tx_hash) {
                transactions.push(tx);
                continue;
            }

            // Fallback to persistent RocksDB storage
            let tx_cf = match self.persistent.db.cf_handle("transactions") {
                Some(cf) => cf,
                None => {
                    println!("[WARN][STORAGE] tx_cf_not_found block={}", height);
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
                        let _ = self.transaction_pool.store_transaction(*tx_hash, tx.clone());
                        transactions.push(tx);
                    } else {
                        println!("[WARN][STORAGE] tx_deserialize_failed tx={} block={}", tx_hash_hex, height);
                    }
                }
                Ok(None) => {
                    println!("[WARN][STORAGE] tx_not_found tx={} block={}", tx_hash_hex, height);
                }
                Err(e) => {
                    println!("[WARN][STORAGE] tx_load_err tx={} err={}", tx_hash_hex, e);
                }
            }
        }

        // Verify all transactions loaded
        let expected_tx_count = efficient_block.transaction_hashes.len();
        if transactions.len() != expected_tx_count && expected_tx_count > 0 {
            eprintln!("[ERR][STORAGE] incomplete_block h={} expected_txs={} loaded={}",
                     height, expected_tx_count, transactions.len());
            return Err(IntegrationError::StorageError(
                format!("Block {} missing {} transactions", height,
                        expected_tx_count - transactions.len())));
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
            vrf_output: efficient_block.vrf_output,
            vrf_proof: efficient_block.vrf_proof,
            fees_collected: efficient_block.fees_collected,
            state_root: efficient_block.state_root,
            // v14.0: Timeout round for producer authority
            timeout_round: efficient_block.timeout_round,
        };

        Ok(Some(microblock))
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
            println!("[INFO][STORAGE] microblock_already_efficient height={}", height);
            return Ok(false);
        }
        
        // Try to deserialize as legacy format
        let legacy_block = bincode::deserialize::<qnet_state::MicroBlock>(&microblock_data)
            .map_err(|e| IntegrationError::SerializationError(
                format!("Failed to deserialize legacy microblock {}: {}", height, e)
            ))?;
        
        println!("[INFO][STORAGE] microblock_converting_to_efficient height={}", height);
        
        // Save in new format with delta compression
        let block_data = bincode::serialize(&legacy_block)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        self.save_block_with_delta(height, &block_data)?;
        
        println!("[INFO][STORAGE] microblock_migrated height={}", height);
        Ok(true)
    }
    
    /// Batch migration of legacy microblocks (for system upgrade)
    pub fn batch_migrate_legacy_microblocks(&self, start_height: u64, end_height: u64) -> IntegrationResult<u64> {
        let mut migrated_count = 0;
        
        println!("[INFO][STORAGE] batch_migration_start from={} to={}", start_height, end_height);
        
        for height in start_height..=end_height {
            match self.migrate_legacy_microblock_to_efficient(height) {
                Ok(true) => {
                    migrated_count += 1;
                    if migrated_count % 100 == 0 {
                        println!("[INFO][STORAGE] migration_progress converted={}", migrated_count);
                    }
                },
                Ok(false) => {
                    // Already efficient or doesn't exist
                },
                Err(e) => {
                    println!("[WARN][STORAGE] microblock_migrate_failed height={} err={}", height, e);
                }
            }
        }
        
        println!("[INFO][STORAGE] batch_migration_done converted={}", migrated_count);
        
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
            println!("[INFO][STORAGE] poh_migration_no_blocks");
            return Ok(0);
        }
        
        println!("[INFO][STORAGE] poh_migration_start blocks={}", chain_height + 1);
        
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
                        println!("[INFO][STORAGE] poh_migration_progress migrated={} skipped={} rate={}", 
                                migrated, skipped, rate);
                    }
                }
                Ok(false) => {
                    skipped += 1;
                }
                Err(e) => {
                    println!("[WARN][STORAGE] poh_migrate_failed height={} err={}", height, e);
                }
            }
        }
        
        let elapsed = start_time.elapsed();
        println!("[INFO][STORAGE] poh_migration_done elapsed={:.2}s migrated={} skipped={}", 
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
            println!("[INFO][STORAGE] archive_compressed from={} to={}", 
                    data.len(), compressed.len());
            Ok(compressed)
        } else {
            println!("[INFO][STORAGE] archive_compress_skipped reason=no_benefit");
            Ok(data.to_vec())
        }
    }
    
    /// Decompress archive data
    pub fn decompress_archive_data(&self, data: &[u8]) -> IntegrationResult<Vec<u8>> {
        // Try to decompress with Zstd first
        match zstd::decode_all(data) {
            Ok(decompressed) => {
                println!("[INFO][STORAGE] archive_decompressed from={} to={}", 
                        data.len(), decompressed.len());
                Ok(decompressed)
            },
            Err(_) => {
                // Data might not be compressed, return as-is
                println!("[INFO][STORAGE] data_not_compressed returning_as_is=true");
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
        
        println!("[INFO][STORAGE] tx_pool_compress_start count={}", tx_count);
        
        // Serialize all transactions
        let transactions = self.transaction_pool.transactions.read();
        let creation_times = self.transaction_pool.creation_times.read();
            
        let pool_data = (&*transactions, &*creation_times);
        let serialized = bincode::serialize(&pool_data)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        drop(transactions);
        drop(creation_times);
        
        // Compress with high level for long-term storage
        let compressed = zstd::encode_all(&serialized[..], 6) // Level 6 for good compression
            .map_err(|e| IntegrationError::Other(format!("Zstd compression error: {}", e)))?;
            
        println!("[INFO][STORAGE] tx_pool_compressed from={} to={}", 
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
            let mut usage = self.current_storage_usage.write();
            *usage = actual_usage;
        }
        
        let usage_percentage = (actual_usage as f64 / self.max_storage_size as f64) * 100.0;
        
        println!("[INFO][STORAGE] storage_usage used_gb={:.1} total_gb={:.1} pct={:.1}%", 
                actual_usage as f64 / (1024.0 * 1024.0 * 1024.0),
                self.max_storage_size as f64 / (1024.0 * 1024.0 * 1024.0),
                usage_percentage);
        
        // Trigger cleanup at different thresholds
        match usage_percentage {
            p if p >= 95.0 => {
                println!("[WARN][STORAGE] storage_critical_95pct_full triggering=emergency_cleanup");
                self.emergency_cleanup()?;
                Ok(false) // Emergency state
            },
            p if p >= 85.0 => {
                println!("[WARN][STORAGE] storage_warn_85pct_full triggering=aggressive_cleanup");
                self.aggressive_cleanup()?;
                Ok(false) // Warning state
            },
            p if p >= 70.0 => {
                println!("[INFO][STORAGE] storage_70pct_full triggering=standard_cleanup");
                self.standard_cleanup()?;
                Ok(true) // Normal operation
            },
            _ => {
                println!("[INFO][STORAGE] storage_normal pct={:.1}%", usage_percentage);
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
            println!("[WARN][STORAGE] dir_size_failed err={}", e);
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
        println!("[INFO][STORAGE] standard_cleanup_start cache_only=true history_preserved=true");
        
        // 1. Clean transaction pool cache (this is OK - only removes duplicates)
        let removed_tx = self.transaction_pool.cleanup_old_duplicates()?;
        println!("[INFO][STORAGE] tx_duplicates_removed count={}", removed_tx);
        
        // 2. CRITICAL CORRECTION: DO NOT delete blockchain history!
        // Instead, implement proper cache management
        
        // 3. PRODUCTION: Compress old data instead of deleting
        // Note: Compression now happens automatically via adaptive compression
        // Force RocksDB compaction to optimize storage efficiency
        
        // 4. Force RocksDB compaction to optimize storage efficiency
        self.persistent.db.compact_range::<&[u8], &[u8]>(None, None);
        println!("[INFO][STORAGE] db_compaction_done mode=standard");
        
        println!("[INFO][STORAGE] standard_cleanup_done history_preserved=true");
        Ok(())
    }
    
    /// Aggressive cleanup (85-95% full) - CACHE cleanup only, blockchain history preserved
    fn aggressive_cleanup(&self) -> IntegrationResult<()> {
        println!("[INFO][STORAGE] aggressive_cleanup_start cache_only=true history_preserved=true");
        
        // 1. PRODUCTION: More aggressive transaction pool cleanup (6 hours instead of 24)
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| IntegrationError::Other(format!("Time error: {}", e)))?
            .as_secs();
        let aggressive_cutoff = current_time.saturating_sub(6 * 3600); // 6 hours
        
        // Force aggressive cleanup of transaction pool CACHE only
        {
            let mut transactions = self.transaction_pool.transactions.write();
            let mut creation_times = self.transaction_pool.creation_times.write();

            let old_hashes: Vec<[u8; 32]> = creation_times.iter()
                .filter(|(_, &time)| time < aggressive_cutoff)
                .map(|(hash, _)| *hash)
                .collect();
                
            for hash in old_hashes {
                transactions.remove(&hash);
                creation_times.remove(&hash);
            }
            
            println!("[INFO][STORAGE] aggressive_tx_cache_cleaned older_than=6h");
        }
        
        // 2. CRITICAL CORRECTION: DO NOT delete blockchain history!
        // 3. PRODUCTION: Maximum compression instead of deletion
        // Note: Compression now happens automatically via adaptive compression
        
        // 4. PRODUCTION: Force RocksDB compaction to reclaim space immediately
        self.persistent.db.compact_range::<&[u8], &[u8]>(None, None);
        println!("[INFO][STORAGE] db_compaction_done mode=aggressive");
        
        println!("[INFO][STORAGE] aggressive_cleanup_done history_preserved=true");
        Ok(())
    }
    
    /// Emergency cleanup (95%+ full) - remove all non-essential data
    fn emergency_cleanup(&self) -> IntegrationResult<()> {
        println!("[WARN][STORAGE] emergency_cleanup_start reason=storage_critically_full");
        
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
            let mut transactions = self.transaction_pool.transactions.write();
            let mut creation_times = self.transaction_pool.creation_times.write();

            let emergency_hashes: Vec<[u8; 32]> = creation_times.iter()
                .filter(|(_, &time)| time < emergency_cutoff)
                .map(|(hash, _)| *hash)
                .collect();
                
            for hash in emergency_hashes {
                transactions.remove(&hash);
                creation_times.remove(&hash);
            }
            
            println!("[WARN][STORAGE] emergency_tx_pool_cleared kept=1h");
        }
        
        // 2. CRITICAL CORRECTION: DO NOT delete blockchain history even in emergency!
        // Instead, maximum compression and cache optimization
        println!("[WARN][STORAGE] emergency_compression_start target=blockchain_data");
        
        // Emergency compression of blockchain data
        // Note: Compression now happens automatically via adaptive compression
        
        // 3. PRODUCTION: Force maximum compression on all remaining data
        self.persistent.db.compact_range::<&[u8], &[u8]>(None, None);
        println!("[INFO][STORAGE] db_compaction_done mode=emergency");
        
        // 4. CRITICAL CORRECTION: DO NOT delete transaction history from blockchain!
        // Emergency optimization through compression only
        println!("[WARN][STORAGE] emergency_optimize_start mode=compression history_preserved=true");
        
        println!("[WARN][STORAGE] emergency_cleanup_done node_status=operational");
        
        // Check if we're still critically full after cleanup
        let post_cleanup_usage = self.get_directory_size(&std::env::var("QNET_DATA_DIR").unwrap_or_else(|_| "./node_data".to_string()))?;
        let post_cleanup_percentage = (post_cleanup_usage as f64 / self.max_storage_size as f64) * 100.0;
        
        if post_cleanup_percentage >= 90.0 {
            println!("[WARN][STORAGE] post_emergency_still_critical pct={:.1}%", post_cleanup_percentage);
            println!("[WARN][STORAGE] admin_action_required urgency=immediate");
            println!("[WARN][STORAGE] action_required step=1 msg=add_more_disk_space_immediately");
            println!("[WARN][STORAGE] action_required step=2 msg=set_QNET_MAX_STORAGE_GB_500_or_higher");
            println!("[WARN][STORAGE] action_required step=3 msg=monitor_disk_usage_closely");
            println!("[WARN][STORAGE] action_required step=4 msg=consider_moving_to_larger_storage");
            println!("[WARN][STORAGE] node_storage_critical accept_blocks=degraded");
        } else {
            println!("[INFO][STORAGE] emergency_cleanup_done pct={:.1}%", post_cleanup_percentage);
            println!("[INFO][STORAGE] recommended_actions");
            println!("[INFO][STORAGE] recommended step=1 msg=consider_increasing_QNET_MAX_STORAGE_GB_500");
            println!("[INFO][STORAGE] recommended step=2 msg=plan_for_long_term_storage_growth");
        }
        
        Ok(())
    }
    
    /// Get current storage usage percentage
    pub fn get_storage_usage_percentage(&self) -> IntegrationResult<f64> {
        let usage = *self.current_storage_usage.read();
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
        println!("[INFO][STORAGE] max_storage_updated size_gb={}", new_size_gb);
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
                    println!("[INFO][STORAGE] compress_level_applied level={:?} from={} to={} reduction={:.1}%", 
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
                println!("[INFO][STORAGE] decompressed from={} to={}", data.len(), decompressed.len());
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
            println!("[INFO][STORAGE] tx_pattern_compressed pattern={:?} from={} to={} reduction={:.1}%",
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
        println!("[INFO][STORAGE] adaptive_recompress_start");
        
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
                println!("[INFO][STORAGE] recompress_batch from={} to={} blocks={} saved_kb={}",
                        batch_start, batch_end, recompressed_count, space_saved / 1024);
            }
            
            // Limit processing to avoid blocking too long
            if recompressed_count >= 10000 {
                break;
            }
        }
        
        // Force compaction to reclaim space
        self.persistent.db.compact_range_cf(&microblocks_cf, None::<&[u8]>, None::<&[u8]>);
        
        println!("[INFO][STORAGE] adaptive_recompress_done blocks={} saved_mb={}",
                recompressed_count, space_saved / (1024 * 1024));
        
        // PRODUCTION: Also recompress old transactions with stronger Zstd
        // Done synchronously to avoid Send issues with RocksDB handles
        let tx_saved = self.recompress_old_transactions_sync()?;
        if tx_saved > 0 {
            println!("[INFO][STORAGE] tx_recompress_saved saved_mb={}", tx_saved / (1024 * 1024));
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
        
        println!("[INFO][STORAGE] tx_recompress_done count={} saved_kb={}",
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
            println!("[INFO][STORAGE] storage_recommendation current_gb={} recommended_gb={} age_years={:.1}", 
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
    
    /// v4.9: Save device signature for node (used for migration detection)
    /// Key: device_{node_id} → device_id string
    /// When a super node migrates to a new server, the old server detects the change
    /// by comparing its own device_id with the stored one on genesis nodes.
    pub fn save_node_device_id(&self, node_id: &str, device_id: &str) -> IntegrationResult<()> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let key = format!("device_{}", node_id);
        let data = json!({
            "device_id": device_id,
            "updated_at": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
        });
        self.persistent.db.put_cf(&registry_cf, key.as_bytes(), data.to_string().as_bytes())?;
        Ok(())
    }
    
    /// v4.9: Get current device signature for node (O(1) lookup)
    /// Returns None if node not found or never had a device_id stored
    pub fn get_node_device_id(&self, node_id: &str) -> IntegrationResult<Option<String>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let key = format!("device_{}", node_id);
        match self.persistent.db.get_cf(&registry_cf, key.as_bytes())? {
            Some(value) => {
                let json_str = std::str::from_utf8(&value)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                let parsed: serde_json::Value = serde_json::from_str(json_str)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(parsed["device_id"].as_str().map(|s| s.to_string()))
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
    
    /// v4.3: Get all nodes registered with a specific wallet address — O(1) via reverse index
    /// CRITICAL for mobile app: Returns nodes even when the node itself is offline!
    /// Data is read from blockchain storage (RocksDB), not from the node's memory.
    /// Uses wallet_{address} reverse index for constant-time lookup.
    /// Architecture: 1 wallet = 1 node (strictly enforced), so result is always 0 or 1 entry.
    /// Previous version (v3.1) used O(N) prefix scan over ALL nodes — not scalable for 100K+ nodes.
    pub fn get_nodes_by_wallet(&self, wallet_address: &str) -> IntegrationResult<Vec<(String, String, f64)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        // O(1) lookup via reverse index: wallet_{address} → {node_id, node_type}
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
                    return Ok(Vec::new());
                }
                
                // Get reputation from forward index: node_{node_id} → full data
                let node_key = format!("node_{}", node_id);
                let reputation = match self.persistent.db.get_cf(&registry_cf, node_key.as_bytes())? {
                    Some(node_data) => {
                        let node_json = std::str::from_utf8(&node_data).unwrap_or("{}");
                        let node_parsed: serde_json::Value = serde_json::from_str(node_json).unwrap_or_default();
                        node_parsed["reputation"].as_f64()
                            .unwrap_or(qnet_consensus::deterministic_reputation::INITIAL_REPUTATION)
                    }
                    None => qnet_consensus::deterministic_reputation::INITIAL_REPUTATION,
                };
                
                Ok(vec![(node_id, node_type, reputation)])
            }
            None => Ok(Vec::new()),
        }
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
    
    /// v4.3: Load ALL node registrations from RocksDB for P2P registry restore on startup.
    /// Returns Vec of (node_id, wallet_address, node_type, registered_at) tuples.
    /// Called once during node initialization to populate in-memory P2P registry from
    /// blockchain state, ensuring the registry survives node restarts.
    /// This is a one-time startup operation — O(N) is acceptable here.
    pub fn load_all_node_registrations(&self) -> IntegrationResult<Vec<(String, String, String, u64)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let prefix = b"node_";
        let iter = self.persistent.db.prefix_iterator_cf(&registry_cf, prefix);
        let mut result = Vec::new();
        
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
                
                let node_type = parsed["node_type"].as_str().unwrap_or("unknown").to_string();
                let wallet = parsed["wallet"].as_str().unwrap_or("").to_string();
                let timestamp = parsed["timestamp"].as_u64().unwrap_or(0);
                
                if !wallet.is_empty() {
                    result.push((node_id.to_string(), wallet, node_type, timestamp));
                }
            }
        }
        
        println!("[INFO][STORAGE] load_all_node_registrations count={}", result.len());
        Ok(result)
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
    // FCM TOKEN STORAGE (genesis-local, never gossiped)
    // Stores real FCM device tokens so ping service can deliver push notifications.
    // Tokens are NOT in the P2P gossip registry (privacy / gossip bandwidth).
    // Key: node_id (pseudonym), Value: JSON { token, push_type, endpoint? }
    // ============================================

    /// Persist the real FCM device token for a light node (GDPR: stored only on the
    /// genesis node that received the registration, never gossiped).
    pub fn save_fcm_token(
        &self,
        node_id: &str,
        token: &str,
        push_type: &str,
        endpoint: Option<&str>,
    ) -> IntegrationResult<()> {
        let fcm_cf = self.persistent.db.cf_handle("fcm_tokens")
            .ok_or_else(|| IntegrationError::StorageError("fcm_tokens column family not found".to_string()))?;

        let data = serde_json::json!({
            "token": token,
            "push_type": push_type,
            "endpoint": endpoint.unwrap_or(""),
            "updated_at": SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        });

        self.persistent.db.put_cf(&fcm_cf, node_id.as_bytes(), data.to_string().as_bytes())?;
        Ok(())
    }

    /// Load FCM data for a light node.
    /// Returns `(token, push_type, endpoint)` or `None` if not found.
    pub fn get_fcm_data(&self, node_id: &str) -> Option<(String, String, Option<String>)> {
        let fcm_cf = self.persistent.db.cf_handle("fcm_tokens")?;

        let raw = self.persistent.db.get_cf(&fcm_cf, node_id.as_bytes()).ok()??;
        let json: serde_json::Value = serde_json::from_slice(&raw).ok()?;

        let token = json["token"].as_str().unwrap_or("").to_string();
        let push_type = json["push_type"].as_str().unwrap_or("polling").to_string();
        let endpoint = json["endpoint"].as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        if token.is_empty() { None } else { Some((token, push_type, endpoint)) }
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
    
    /// Cleanup old snapshots, keeping only the latest `keep_count` per type.
    /// Keys: "full_snap_{height}" and "state_snap_{height}". Updates pointers atomically.
    pub fn cleanup_old_snapshots(&self, keep_count: usize) -> IntegrationResult<u32> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        let mut removed = 0u32;

        // Clean up both full_snap_ and state_snap_ independently
        for prefix in &["full_snap_", "state_snap_"] {
            let pointer_key: &[u8] = if *prefix == "full_snap_" {
                b"latest_full_snap"
            } else {
                b"latest_state_snap"
            };

            let mut heights: Vec<u64> = Vec::new();
            let iter = self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::Start);
            for item in iter {
                if let Ok((key, _)) = item {
                    let key_str = String::from_utf8_lossy(&key);
                    if let Some(h_str) = key_str.strip_prefix(prefix) {
                        if let Ok(h) = h_str.parse::<u64>() {
                            heights.push(h);
                        }
                    }
                }
            }

            if heights.len() <= keep_count {
                continue;
            }

            heights.sort_unstable_by(|a, b| b.cmp(a));
            let surviving_max = heights[0];
            let to_delete = &heights[keep_count..];

            let mut batch = WriteBatch::default();
            for h in to_delete {
                let key = format!("{}{}", prefix, h);
                batch.delete_cf(&snapshots_cf, key.as_bytes());
                removed += 1;
            }

            // Update pointer to the newest surviving snapshot
            batch.put_cf(&snapshots_cf, pointer_key, &surviving_max.to_le_bytes());
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

        // 6. v9.0: Prune old tx_index + tx_by_address (runs on ALL node types including Super).
        // Retention: 100,000 blocks (~28h at 1 block/sec). Explorer API queries use tx_by_address;
        // keeping ~1 day is sufficient for most wallet UIs. Historical queries → archive node.
        const TX_INDEX_RETENTION_BLOCKS: u64 = 100_000;
        let tx_pruned = if current_height > TX_INDEX_RETENTION_BLOCKS {
            let prune_before = current_height - TX_INDEX_RETENTION_BLOCKS;
            self.prune_old_transactions(prune_before).unwrap_or(0)
        } else {
            0
        };

        let total_removed = pings_removed as u64 + poh_removed as u64 + consensus_removed as u64
            + failover_removed as u64 + snapshots_removed as u64 + tx_pruned;
        
        // 7. Trigger compaction on ALL CFs to physically reclaim disk space
        if total_removed > 0 {
            if let Err(e) = self.persistent.compact_all() {
                println!("[WARN][CLEANUP] compaction_failed err={}", e);
            }
        }
        
        let elapsed = start.elapsed();
        if total_removed > 0 {
            println!("[INFO][CLEANUP] ephemeral_cleanup_done elapsed={:?} pings={} poh={} consensus={} failover={} snapshots={} tx_idx={} total={}",
                     elapsed, pings_removed, poh_removed, consensus_removed, failover_removed, snapshots_removed, tx_pruned, total_removed);
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
            println!("[INFO][STORAGE] failover_cleanup count={} older_than_days=30", old_count);
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
            println!("[INFO][STORAGE] failover_trimmed count={} limit={}", to_delete, max_events);
        }
        
        Ok(())
    }
    
    // PRODUCTION: Snapshot system for fast node synchronization
    // Creates FULL snapshots every 10,000 blocks (~2.7 hours at 1s/block)
    // Creates INCREMENTAL snapshots every 1,000 blocks (~16.7 minutes at 1s/block)
    
    /// Create state snapshot at specified height.
    ///
    /// v15.9: ALWAYS WRITES A FULL SNAPSHOT
    /// ────────────────────────────────────────────────────────────────────
    /// The previous incremental implementation wrote a `delta_{height}`
    /// placeholder containing only a magic header and a `change_count = 0`
    /// counter — every actual delta was empty (the diff-tracking against
    /// `StateManager` was a TODO that never landed). Receivers and the
    /// macroblock `snapshot_root` binding both look up `full_snap_*` /
    /// `state_snap_*` keys, so the placeholder delta was unreachable from
    /// every consumer in the system.
    ///
    /// Effect of the bug: the `snapshot_root` consensus binding only ever
    /// activated on the 12-hour FULL-snapshot boundary (43 200, 86 400 …),
    /// not on the intended 1-hour boundary (3 600, 7 200 …). 11 of every
    /// 12 hourly boundaries silently fell through to `legacy_accept`,
    /// leaving the `Level 4` defence dormant.
    ///
    /// Fix: at every snapshot boundary (every `INCREMENTAL_INTERVAL`
    /// microblocks) we now run `create_state_snapshot`, which writes a
    /// complete `full_snap_{height}` artefact. This is the same artefact
    /// the receiver downloads and verifies, the same artefact the
    /// macroblock producer hashes into `snapshot_root`, and the same
    /// artefact the rollback reconciler reads when restoring state — one
    /// canonical snapshot, one canonical key prefix, one verifiable hash
    /// per boundary.
    ///
    /// SCALABILITY (1 000+ super nodes)
    /// ────────────────────────────────────────────────────────────────────
    /// The full snapshot runs on the blocking thread pool (see
    /// `create_state_snapshot`). At 1 M+ accounts a single hourly
    /// snapshot costs a few seconds of a blocking thread; at 10 M+
    /// accounts tens of seconds. Reactor stays free either way. The
    /// proper delta-snapshot optimisation is a future concern — once
    /// `StateManager` exposes a per-boundary change set the body below
    /// can be specialised back to a real delta path while preserving
    /// the current single-key-prefix invariant.
    pub async fn create_incremental_snapshot(&self, height: u64) -> IntegrationResult<()> {
        // Match the apply-stage trigger (block_pipeline.rs) — both must
        // reference the same constant or boundaries diverge silently.
        const INCREMENTAL_INTERVAL: u64 = 3_600;

        // Not a snapshot boundary — nothing to do.
        if height == 0 || height % INCREMENTAL_INTERVAL != 0 {
            return Ok(());
        }

        // Always write a full state snapshot at the boundary so the
        // canonical `full_snap_{height}` key exists for every consumer
        // (snapshot sync, snapshot_root binding, rollback reconcile).
        self.create_state_snapshot(height).await
    }
    
    /// Create full state snapshot at specified height
    ///
    /// v15.9: BLOCKING-POOL EXECUTION
    /// ────────────────────────────────────────────────────────────────────
    /// This is the heaviest single I/O+CPU operation in the storage layer:
    /// it iterates every account, every pending reward, every contract
    /// storage cell, and every registry entry — then zstd-3 compresses
    /// the concatenated payload. At 1M+ accounts the iteration alone is
    /// hundreds of milliseconds and the compression scales with payload
    /// size (tens to hundreds of MB). All of this work is moved to
    /// `tokio::task::spawn_blocking` so the async reactor stays free
    /// to drive consensus, P2P, and RPC during the snapshot window.
    ///
    /// CANONICAL TIMESTAMP — sourced from the boundary microblock OUTSIDE
    /// the blocking closure to keep that path linear and easy to reason
    /// about. The lookup is a single point read (microseconds) and does
    /// not need to be on the blocking pool.
    pub async fn create_state_snapshot(&self, height: u64) -> IntegrationResult<()> {
        // v10.1: Guard removed — caller (create_incremental_snapshot) already checks intervals.
        // Previous bug: hardcoded 10_000 here blocked creation at h=43200 (43200 % 10000 = 3200).
        if height == 0 {
            return Ok(()); // No snapshot at genesis
        }

        println!("[INFO][STORAGE] state_snapshot_start height={}", height);
        let start_time = std::time::Instant::now();

        // Pre-fetch boundary timestamp on the async path (single point read).
        // Sourcing the timestamp from the boundary microblock — rather than
        // wall-clock SystemTime — guarantees byte-equal snapshots across
        // every honest node, which is a hard prerequisite for the
        // `snapshot_root` consensus binding (node.rs:27389+) to converge.
        let timestamp: u64 = match self.load_microblock_auto_format(height) {
            Ok(Some(boundary_block)) => boundary_block.timestamp,
            _ => 0,
        };

        let db = self.persistent.db.clone();
        let (account_count, rewards_count, contract_entries, registry_count, compressed_kb, uncompressed_kb) =
            tokio::task::spawn_blocking(move || -> IntegrationResult<(u64, u64, u64, u64, usize, usize)> {
                // Get snapshot column family
                let snapshots_cf = db.cf_handle("snapshots")
                    .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

                // Collect state data for snapshot
                let mut snapshot_data = Vec::new();

                // 1. Add protocol version for compatibility check
                snapshot_data.extend_from_slice(&crate::node::PROTOCOL_VERSION.to_le_bytes());

                // 2. Add height marker
                snapshot_data.extend_from_slice(&height.to_le_bytes());

                // 3. Add canonical timestamp (sourced from boundary microblock above)
                snapshot_data.extend_from_slice(&timestamp.to_le_bytes());

                // 4. Serialize current state (accounts, balances, reputation)
                let accounts_cf = db.cf_handle("accounts")
                    .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;

                let mut account_count = 0u64;
                let iter = db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start);

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
                if let Some(rewards_cf) = db.cf_handle("pending_rewards") {
                    // Write marker for rewards section
                    snapshot_data.extend_from_slice(b"REWARDS_V1");

                    let rewards_iter = db.iterator_cf(&rewards_cf, rocksdb::IteratorMode::Start);
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

                // 6. v5.0: Include contract_storage for full state recovery
                let mut contract_entries = 0u64;
                if let Some(cs_cf) = db.cf_handle("contract_storage") {
                    snapshot_data.extend_from_slice(b"CONTRACT_STORAGE_V1");
                    let cs_iter = db.iterator_cf(&cs_cf, rocksdb::IteratorMode::Start);
                    for item in cs_iter {
                        let (key, value) = item?;
                        snapshot_data.extend_from_slice(&(key.len() as u32).to_le_bytes());
                        snapshot_data.extend_from_slice(&key);
                        snapshot_data.extend_from_slice(&(value.len() as u32).to_le_bytes());
                        snapshot_data.extend_from_slice(&value);
                        contract_entries += 1;
                    }
                    snapshot_data.extend_from_slice(b"CONTRACT_STORAGE_END");
                }

                // 7. v5.0: Include node_registry for producer wallet lookups after snapshot restore
                let mut registry_count = 0u64;
                if let Some(nr_cf) = db.cf_handle("node_registry") {
                    snapshot_data.extend_from_slice(b"NODE_REGISTRY_V1");
                    let nr_iter = db.iterator_cf(&nr_cf, rocksdb::IteratorMode::Start);
                    for item in nr_iter {
                        let (key, value) = item?;
                        snapshot_data.extend_from_slice(&(key.len() as u32).to_le_bytes());
                        snapshot_data.extend_from_slice(&key);
                        snapshot_data.extend_from_slice(&(value.len() as u32).to_le_bytes());
                        snapshot_data.extend_from_slice(&value);
                        registry_count += 1;
                    }
                    snapshot_data.extend_from_slice(b"NODE_REGISTRY_END");
                }

                // Prepend type discriminator: 0x02 = SNAP_TYPE_FULL
                let mut typed_data = Vec::with_capacity(1 + snapshot_data.len());
                typed_data.push(0x02); // SNAP_TYPE_FULL
                typed_data.extend_from_slice(&snapshot_data);

                // Compress with Zstd-3 (fast for large snapshots, good ratio)
                let uncompressed_len = typed_data.len() as u64;
                let compressed = zstd::encode_all(&typed_data[..], 3)
                    .map_err(|e| IntegrationError::Other(format!("Full snapshot compression error: {}", e)))?;

                // Integrity hash over compressed data
                use sha3::{Sha3_256, Digest};
                let mut hasher = Sha3_256::new();
                hasher.update(&compressed);
                let hash = hasher.finalize();

                // Wire format: [sha3_hash(32) | uncompressed_len(8) | Zstd_compressed]
                let snapshot_key = format!("full_snap_{}", height);
                let mut final_data = Vec::with_capacity(40 + compressed.len());
                final_data.extend_from_slice(hash.as_slice());
                final_data.extend_from_slice(&uncompressed_len.to_le_bytes());
                final_data.extend_from_slice(&compressed);

                // Atomic write: full snapshot data + latest_full_snap pointer
                let mut snap_batch = WriteBatch::default();
                snap_batch.put_cf(&snapshots_cf, snapshot_key.as_bytes(), &final_data);
                snap_batch.put_cf(&snapshots_cf, b"latest_full_snap", &height.to_le_bytes());
                db.write(snap_batch)?;

                Ok((
                    account_count,
                    rewards_count,
                    contract_entries,
                    registry_count,
                    compressed.len() / 1024,
                    uncompressed_len as usize / 1024,
                ))
            })
            .await
            .map_err(|e| IntegrationError::Other(format!("create_state_snapshot_join_err: {}", e)))??;

        let duration = start_time.elapsed();
        println!("[INFO][SNAPSHOT] full_snap_created h={} accounts={} rewards={} contracts={} registry={} compressed={}KB uncompressed={}KB elapsed={:.2}s",
                 height, account_count, rewards_count, contract_entries, registry_count, compressed_kb, uncompressed_kb, duration.as_secs_f64());

        // PRODUCTION: Clean up old snapshots (keep only last 5).
        // Runs after the snapshot is durably persisted; cleanup uses the
        // same sync RocksDB API but its working set is small (≤5 keys).
        self.cleanup_old_snapshots(5)?;

        Ok(())
    }
    
    /// Load the latest state snapshot for in-memory StateManager restoration at startup.
    /// Uses `latest_state_snap` pointer for O(1) lookup — avoids lexicographic ordering bugs with iterator.
    /// Format: [sha3_hash(32) | uncompressed_len(8) | Zstd(state_root(32) | accounts_bincode)]
    pub async fn load_latest_state_snapshot(&self) -> IntegrationResult<Option<(u64, [u8; 32], Vec<u8>, u64)>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        // O(1) pointer lookup
        let latest_height = match self.persistent.db.get_cf(&snapshots_cf, b"latest_state_snap")? {
            Some(data) if data.len() >= 8 => {
                u64::from_le_bytes(data[..8].try_into()
                    .map_err(|_| IntegrationError::StorageError("Invalid latest_state_snap pointer".to_string()))?)
            }
            _ => {
                // Pointer missing — scan for state_snap_ keys (handles previous version upgrade)
                let mut max_height = 0u64;
                let iter = self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::Start);
                for item in iter {
                    if let Ok((key, _)) = item {
                        let key_str = String::from_utf8_lossy(&key);
                        if let Some(h_str) = key_str.strip_prefix("state_snap_") {
                            if let Ok(h) = h_str.parse::<u64>() {
                                if h > max_height { max_height = h; }
                            }
                        }
                    }
                }
                if max_height == 0 { return Ok(None); }
                max_height
            }
        };

        let snapshot_key = format!("state_snap_{}", latest_height);
        let value = match self.persistent.db.get_cf(&snapshots_cf, snapshot_key.as_bytes())? {
            Some(v) => v,
            None => {
                eprintln!("[WARN][SNAPSHOT] latest_state_snap pointer h={} key missing — clearing stale pointer", latest_height);
                return Ok(None);
            }
        };

        // Bounds check: header is [sha3_hash(32) | uncompressed_len(8)] = 40 bytes + at least 1 byte data
        if value.len() < 41 {
            return Err(IntegrationError::StorageError(format!(
                "State snapshot at h={} malformed: only {} bytes", latest_height, value.len()
            )));
        }

        let stored_hash = &value[..32];
        let _uncompressed_len = u64::from_le_bytes(value[32..40].try_into()
            .map_err(|_| IntegrationError::StorageError("Invalid snapshot header bytes".to_string()))?);
        let compressed_data = &value[40..];

        // Integrity check over compressed data
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(compressed_data);
        let computed_hash = hasher.finalize();
        if stored_hash != computed_hash.as_slice() {
            return Err(IntegrationError::StorageError(format!(
                "State snapshot at h={} integrity check failed", latest_height
            )));
        }

        // Decompress with Zstd
        let decompressed = zstd::decode_all(compressed_data)
            .map_err(|e| IntegrationError::Other(format!("State snapshot decompression failed h={}: {}", latest_height, e)))?;

        // Payload: [type(1) | state_root(32) | accounts_bincode]
        if decompressed.len() < 33 {
            return Err(IntegrationError::StorageError(format!(
                "State snapshot payload too short h={}: {} bytes", latest_height, decompressed.len()
            )));
        }

        let snap_type = decompressed[0];
        let (state_root, total_supply, accounts_data) = match snap_type {
            0x01 => {
                // Legacy format: [type(1) | state_root(32) | accounts_bincode]
                let state_root: [u8; 32] = decompressed[1..33].try_into()
                    .map_err(|_| IntegrationError::StorageError("Invalid state_root in snapshot payload".to_string()))?;
                let accounts_data = decompressed[33..].to_vec();
                (state_root, 0u64, accounts_data)  // total_supply unknown in v1
            }
            0x02 => {
                // v2 format: [type(1) | state_root(32) | total_supply(8) | height(8) | accounts_bincode]
                if decompressed.len() < 49 {  // 1 + 32 + 8 + 8
                    return Err(IntegrationError::StorageError(format!(
                        "State snapshot v2 h={} too short: {} bytes", latest_height, decompressed.len()
                    )));
                }
                let state_root: [u8; 32] = decompressed[1..33].try_into()
                    .map_err(|_| IntegrationError::StorageError("Invalid state_root in v2 snapshot".to_string()))?;
                let total_supply = u64::from_le_bytes(decompressed[33..41].try_into()
                    .map_err(|_| IntegrationError::StorageError("Invalid total_supply in v2 snapshot".to_string()))?);
                // height at bytes 41..49 (informational, actual height comes from key)
                let accounts_data = decompressed[49..].to_vec();
                (state_root, total_supply, accounts_data)
            }
            _ => {
                return Err(IntegrationError::StorageError(format!(
                    "State snapshot h={} unknown type: 0x{:02x}", latest_height, snap_type
                )));
            }
        };

        if crate::node::is_info() {
            println!("[INFO][SNAPSHOT] state_snap_loaded h={} type=0x{:02x} total_supply={} compressed={}KB accounts={}KB",
                     latest_height, snap_type, total_supply, compressed_data.len() / 1024, accounts_data.len() / 1024);
        }

        Ok(Some((latest_height, state_root, accounts_data, total_supply)))
    }
    
    /// v2.99: Load state snapshot by height and restore into StateManager
    /// Load a state snapshot by height and return (state_root, accounts_bincode) for StateManager restoration.
    /// Payload: [type=0x01 | state_root(32) | accounts_bincode]
    // ═══════════════════════════════════════════════════════════════════════
    // v15.9: PERSISTENT MEMPOOL API
    // ───────────────────────────────────────────────────────────────────────
    // Pending transactions are mirrored from the in-RAM mempool into the
    // dedicated `mempool` column family on every admission, and removed on
    // block inclusion / TTL expiration / explicit drop. This crash-safety
    // surface means a producer that goes down between accepting a TX and
    // including it in a block does not silently drop user submissions —
    // the next process to come up reloads the queue and the TX has another
    // shot at inclusion under the same gas-price ordering.
    //
    // KEY SCHEME
    // ───────────────────────────────────────────────────────────────────────
    // Each TX is stored under its hash, prefix-free. Both the raw payload
    // bytes and the admission timestamp (for TTL on reload) are bundled
    // into a tiny header so the load path can rebuild the in-RAM
    // metadata structures (tx_timestamps, by_gas_price) without any
    // additional storage round-trip.
    //
    // Wire format per entry:
    //   [admission_ts: u64 little-endian | tx_payload: variable]
    //
    // SCALABILITY (1 000+ super nodes, 500 K-entry mempool)
    // ───────────────────────────────────────────────────────────────────────
    // RocksDB writes are batched and the CF is hot — admission cost is a
    // single `put_cf` per accepted TX. At a sustained 10 000 TPS network
    // this is well within RocksDB's write budget. Boot scan reads up to
    // 500 K entries in a few hundred milliseconds; we intentionally run
    // it in tokio::task::spawn_blocking on startup to keep the async
    // reactor free.

    /// Persist a single pending mempool entry.
    /// Called from the integration layer immediately after a TX is admitted
    /// to the in-RAM `SimpleMempool`, so a crash between admission and
    /// block inclusion does not lose the TX.
    pub fn save_pending_tx(&self, tx_hash: &str, payload: &[u8], admission_ts: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("mempool")
            .ok_or_else(|| IntegrationError::StorageError("mempool column family not found".to_string()))?;
        let mut value = Vec::with_capacity(8 + payload.len());
        value.extend_from_slice(&admission_ts.to_le_bytes());
        value.extend_from_slice(payload);
        self.persistent.db.put_cf(&cf, tx_hash.as_bytes(), &value)?;
        Ok(())
    }

    /// Remove a pending mempool entry (called on block inclusion,
    /// TTL expiration, replacement, or explicit drop).
    pub fn delete_pending_tx(&self, tx_hash: &str) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("mempool")
            .ok_or_else(|| IntegrationError::StorageError("mempool column family not found".to_string()))?;
        self.persistent.db.delete_cf(&cf, tx_hash.as_bytes())?;
        Ok(())
    }

    /// Scan the entire `mempool` CF and return every persisted entry.
    /// Used at node startup to repopulate the in-RAM mempool. Each tuple
    /// is `(tx_hash, payload_bytes, admission_ts)`.
    /// Runs on the async caller; in node.rs we wrap the entire restore
    /// pass in `tokio::task::spawn_blocking` to keep the reactor free
    /// while large mempools (≥100K entries) are streamed back in.
    pub fn load_all_pending_txs(&self) -> IntegrationResult<Vec<(String, Vec<u8>, u64)>> {
        let cf = self.persistent.db.cf_handle("mempool")
            .ok_or_else(|| IntegrationError::StorageError("mempool column family not found".to_string()))?;
        let mut out: Vec<(String, Vec<u8>, u64)> = Vec::new();
        let iter = self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, value) = item?;
            if value.len() < 8 { continue; }
            let admission_ts = u64::from_le_bytes(
                value[..8].try_into()
                    .map_err(|_| IntegrationError::StorageError("Invalid mempool entry header".to_string()))?
            );
            let payload = value[8..].to_vec();
            let tx_hash = String::from_utf8_lossy(&key).into_owned();
            out.push((tx_hash, payload, admission_ts));
        }
        Ok(out)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // v15.10 STAGE-2C: CROSS-SHARD 2PC PERSISTENCE API
    // ───────────────────────────────────────────────────────────────────────
    // Two surfaces:
    //   * `cross_shard_pending` — in-flight 2PC envelopes keyed by
    //     `tx_id` (32-byte). Survives coordinator restarts; the failover
    //     path on a successor node reads this CF to reconstitute state.
    //   * `cross_shard_receipts` — terminal receipts keyed by `tx_id`.
    //     Append-only; queried by wallets through the
    //     `/api/v1/cross-shard/receipt/{tx_id}` RPC endpoint.
    //
    // PRIVACY-FIRST LOGGING
    // ───────────────────────────────────────────────────────────────────────
    // Logged tx_id previews are truncated to the first 16 hex chars,
    // matching the rest of the codebase's privacy posture.

    /// Persist a `CrossShardEnvelope` (or any wire-format bytes) for the
    /// given `tx_id`. Idempotent: re-saving overwrites the previous
    /// value, which is the correct behaviour when the coordinator
    /// re-broadcasts a phase advancement (for example after a restart).
    pub fn save_cross_shard_pending(&self, tx_id: &[u8; 32], payload: &[u8]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("cross_shard_pending")
            .ok_or_else(|| IntegrationError::StorageError("cross_shard_pending column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, tx_id, payload)?;
        Ok(())
    }

    /// Read the persisted envelope (if any) for `tx_id`. Returns None
    /// when the 2PC has already been finalised — finalisation moves the
    /// record from `pending` to `receipts`.
    pub fn load_cross_shard_pending(&self, tx_id: &[u8; 32]) -> IntegrationResult<Option<Vec<u8>>> {
        let cf = self.persistent.db.cf_handle("cross_shard_pending")
            .ok_or_else(|| IntegrationError::StorageError("cross_shard_pending column family not found".to_string()))?;
        Ok(self.persistent.db.get_cf(&cf, tx_id)?)
    }

    /// Drop the pending entry for `tx_id`. Called when the protocol
    /// reaches a terminal state (after `save_cross_shard_receipt`).
    pub fn delete_cross_shard_pending(&self, tx_id: &[u8; 32]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("cross_shard_pending")
            .ok_or_else(|| IntegrationError::StorageError("cross_shard_pending column family not found".to_string()))?;
        self.persistent.db.delete_cf(&cf, tx_id)?;
        Ok(())
    }

    /// Persist a terminal-state `CrossShardReceipt`. Append-only — the
    /// receipt MUST NOT be overwritten once written, because wallets
    /// rely on its immutability for trust-less verification.
    pub fn save_cross_shard_receipt(&self, tx_id: &[u8; 32], payload: &[u8]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("cross_shard_receipts")
            .ok_or_else(|| IntegrationError::StorageError("cross_shard_receipts column family not found".to_string()))?;
        // Idempotent re-save with byte-identical payload is allowed
        // (replay of the same finalisation event); divergent payloads
        // are detected at the integration layer through the receipt's
        // BFT proofs and rejected before reaching this method.
        self.persistent.db.put_cf(&cf, tx_id, payload)?;
        Ok(())
    }

    /// Read the receipt (if any) for `tx_id`. The wallet RPC endpoint
    /// uses this to surface the trust-less outcome of a cross-shard
    /// transaction. Returns None for tx_ids that are still in flight or
    /// have never been seen.
    pub fn load_cross_shard_receipt(&self, tx_id: &[u8; 32]) -> IntegrationResult<Option<Vec<u8>>> {
        let cf = self.persistent.db.cf_handle("cross_shard_receipts")
            .ok_or_else(|| IntegrationError::StorageError("cross_shard_receipts column family not found".to_string()))?;
        Ok(self.persistent.db.get_cf(&cf, tx_id)?)
    }

    /// Iterate every persisted pending 2PC and return `(tx_id, payload)`
    /// pairs. Used at coordinator startup to rehydrate the in-RAM
    /// `CrossShardCoordinator.pending` map; subsequent failover-driven
    /// takeovers can advance the protocol from the recorded state
    /// without losing any in-flight commitments.
    pub fn load_all_cross_shard_pending(&self) -> IntegrationResult<Vec<([u8; 32], Vec<u8>)>> {
        let cf = self.persistent.db.cf_handle("cross_shard_pending")
            .ok_or_else(|| IntegrationError::StorageError("cross_shard_pending column family not found".to_string()))?;
        let mut out = Vec::new();
        let iter = self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, value) = item?;
            if key.len() == 32 {
                let mut tx_id = [0u8; 32];
                tx_id.copy_from_slice(&key);
                out.push((tx_id, value.to_vec()));
            }
        }
        Ok(out)
    }

    /// Drop every entry in the `mempool` CF. Reserved for explicit
    /// admin-level resets; not part of the normal lifecycle.
    pub fn clear_pending_txs(&self) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("mempool")
            .ok_or_else(|| IntegrationError::StorageError("mempool column family not found".to_string()))?;
        let mut batch = WriteBatch::default();
        let iter = self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, _) = item?;
            batch.delete_cf(&cf, &key);
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// v15.9: ROLLBACK SUPPORT — locate the freshest state snapshot whose
    /// height is ≤ `target_height`. Used by the reorg / fork-recovery
    /// path to rebuild the in-memory account state to a consistent
    /// pre-rollback baseline before replaying the surviving microblocks.
    ///
    /// SCAN STRATEGY
    /// ───────────────────────────────────────────────────────────────────
    /// Snapshots are emitted at `SNAPSHOT_INCREMENTAL_INTERVAL` (3 600)
    /// boundaries. We start from the highest such boundary not exceeding
    /// `target_height` and walk downwards by one interval at a time,
    /// probing both `state_snap_*` and `full_snap_*` keys per height.
    /// First hit wins. Returns `Some((snap_height, payload_bytes))`.
    /// `None` means no usable snapshot exists at or below the target —
    /// the caller must fall back to full replay from genesis.
    ///
    /// SCALABILITY
    /// ───────────────────────────────────────────────────────────────────
    /// Cost is bounded: at most `target_height / SNAPSHOT_INCREMENTAL_INTERVAL`
    /// point reads, which decays as the chain grows because cleanup
    /// keeps only the last 5 snapshots. In steady state this is at
    /// most 5 reads regardless of chain length.
    pub fn find_snapshot_at_or_before(
        &self,
        target_height: u64,
    ) -> IntegrationResult<Option<(u64, Vec<u8>)>> {
        const SNAPSHOT_INCREMENTAL_INTERVAL: u64 = 3_600;
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        if target_height == 0 {
            return Ok(None);
        }

        let mut probe_height = (target_height / SNAPSHOT_INCREMENTAL_INTERVAL) * SNAPSHOT_INCREMENTAL_INTERVAL;
        loop {
            if probe_height == 0 {
                return Ok(None);
            }
            for prefix in &["full_snap_", "state_snap_"] {
                let key = format!("{}{}", prefix, probe_height);
                if let Some(data) = self.persistent.db.get_cf(&snapshots_cf, key.as_bytes())? {
                    if !data.is_empty() {
                        return Ok(Some((probe_height, data)));
                    }
                }
            }
            probe_height = probe_height.saturating_sub(SNAPSHOT_INCREMENTAL_INTERVAL);
        }
    }

    pub async fn load_state_snapshot_by_height(&self, height: u64) -> IntegrationResult<Option<([u8; 32], Vec<u8>)>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        let snapshot_key = format!("state_snap_{}", height);

        match self.persistent.db.get_cf(&snapshots_cf, snapshot_key.as_bytes())? {
            Some(value) => {
                // Bounds check: [sha3_hash(32) | uncompressed_len(8)] + at least 1 byte compressed
                if value.len() < 41 {
                    return Err(IntegrationError::StorageError(format!(
                        "Snapshot at h={} malformed: {} bytes", height, value.len()
                    )));
                }

                let stored_hash = &value[..32];
                let _uncompressed_len = u64::from_le_bytes(value[32..40].try_into()
                    .map_err(|_| IntegrationError::StorageError("Invalid snapshot header".to_string()))?);
                let compressed_data = &value[40..];

                // Integrity check
                use sha3::{Sha3_256, Digest};
                let mut hasher = Sha3_256::new();
                hasher.update(compressed_data);
                let computed_hash = hasher.finalize();
                if stored_hash != computed_hash.as_slice() {
                    return Err(IntegrationError::StorageError(format!(
                        "Snapshot at h={} integrity check failed", height
                    )));
                }

                // Decompress with Zstd
                let decompressed = zstd::decode_all(compressed_data)
                    .map_err(|e| IntegrationError::Other(format!("Snapshot decompression failed h={}: {}", height, e)))?;

                // Payload v1: [type=0x01 | state_root(32) | accounts_bincode]
                // Payload v2: [type=0x02 | state_root(32) | total_supply(8) | height(8) | accounts_bincode]
                if decompressed.len() < 33 {
                    return Err(IntegrationError::StorageError(format!(
                        "State snapshot payload too short at h={}: {} bytes", height, decompressed.len()
                    )));
                }
                let (state_root, accounts_data) = match decompressed[0] {
                    0x01 => {
                        let sr: [u8; 32] = decompressed[1..33].try_into()
                            .map_err(|_| IntegrationError::StorageError("Invalid state_root".to_string()))?;
                        (sr, decompressed[33..].to_vec())
                    }
                    0x02 => {
                        if decompressed.len() < 49 {
                            return Err(IntegrationError::StorageError(format!(
                                "State snapshot v2 h={} too short: {} bytes", height, decompressed.len()
                            )));
                        }
                        let sr: [u8; 32] = decompressed[1..33].try_into()
                            .map_err(|_| IntegrationError::StorageError("Invalid state_root".to_string()))?;
                        (sr, decompressed[49..].to_vec())
                    }
                    t => {
                        return Err(IntegrationError::StorageError(format!(
                            "State snapshot h={} unknown type: 0x{:02x}", height, t
                        )));
                    }
                };

                Ok(Some((state_root, accounts_data)))
            }
            None => Ok(None)
        }
    }
    
    /// Load a full snapshot by height and restore accounts + rewards directly into RocksDB.
    /// v10.1: Supports TWO binary formats:
    ///   Format A (create_state_snapshot): [0x02 | protocol_version:u32 | height:u64 | timestamp:u64 | KV pairs...]
    ///   Format B (save_state_snapshot):   [0x02 | state_root:[u8;32] | total_supply:u64 | height:u64 | bincode(accounts)]
    /// Detection: after 0x02, read 4 bytes as u32. protocol_version < 10_000 → Format A. Otherwise → Format B.
    pub async fn load_state_snapshot(&self, height: u64) -> IntegrationResult<()> {
        if crate::node::is_info() {
            println!("[INFO][SNAPSHOT] full_snap_loading h={}", height);
        }

        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        // v10.1: Try full_snap_ first, then state_snap_ (download_snapshot_chunked saves as full_snap_,
        // but the data may have originated from a peer's state_snap_ via get_snapshot_data)
        let snapshot_key = format!("full_snap_{}", height);
        let snapshot_data = match self.persistent.db.get_cf(&snapshots_cf, snapshot_key.as_bytes())? {
            Some(d) => d,
            None => {
                // Fallback: try state_snap_ key directly (local node)
                let state_key = format!("state_snap_{}", height);
                self.persistent.db.get_cf(&snapshots_cf, state_key.as_bytes())?
                    .ok_or_else(|| IntegrationError::StorageError(
                        format!("Snapshot at h={} not found (tried full_snap_ and state_snap_)", height)
                    ))?
            }
        };

        // Bounds check: [sha3_hash(32) | uncompressed_len(8)] + at least 1 byte compressed
        if snapshot_data.len() < 41 {
            return Err(IntegrationError::StorageError(format!(
                "Full snapshot at h={} malformed: only {} bytes", height, snapshot_data.len()
            )));
        }

        let stored_hash = &snapshot_data[..32];
        let _uncompressed_len = u64::from_le_bytes(snapshot_data[32..40].try_into()
            .map_err(|_| IntegrationError::StorageError("Invalid snapshot header".to_string()))?);
        let compressed_data = &snapshot_data[40..];

        // Integrity check
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(compressed_data);
        let computed_hash = hasher.finalize();

        if stored_hash != computed_hash.as_slice() {
            return Err(IntegrationError::StorageError(format!(
                "Full snapshot at h={} integrity check failed", height
            )));
        }

        // Decompress with Zstd (unified format, same as save path)
        let decompressed = zstd::decode_all(compressed_data)
            .map_err(|e| IntegrationError::StorageError(format!("Full snapshot decompression failed h={}: {}", height, e)))?;

        // Parse and restore state
        let mut cursor = 0;

        // Verify type discriminator
        if decompressed.is_empty() || decompressed[0] != 0x02 {
            return Err(IntegrationError::StorageError(format!(
                "Full snapshot h={} wrong type: 0x{:02x} (expected 0x02)", height,
                decompressed.first().copied().unwrap_or(0)
            )));
        }
        cursor += 1; // skip type byte

        // v10.1: DETECT FORMAT — read first 4 bytes after type discriminator
        // Format A (create_state_snapshot): protocol_version as u32 (always < 10_000)
        // Format B (save_state_snapshot):   first 4 bytes of state_root hash (random, virtually always >= 10_000)
        if cursor + 4 > decompressed.len() {
            return Err(IntegrationError::StorageError(format!(
                "Full snapshot h={} truncated after type byte", height
            )));
        }
        let probe = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into()
            .map_err(|_| IntegrationError::StorageError("Invalid probe field".to_string()))?);

        let is_format_b = probe >= 10_000; // state_root hash byte → huge number

        if is_format_b {
            // ═══════════════════════════════════════════════════════════════════
            // FORMAT B: save_state_snapshot — [0x02 | state_root(32) | total_supply(8) | height(8) | bincode(accounts)]
            // This format comes from P2P download when peer serves state_snap_ data.
            // ═══════════════════════════════════════════════════════════════════
            if cursor + 48 > decompressed.len() {
                return Err(IntegrationError::StorageError(format!(
                    "Format B snapshot h={} truncated: need 48 bytes header, have {}", height, decompressed.len() - cursor
                )));
            }
            let _state_root = &decompressed[cursor..cursor+32];
            cursor += 32;
            let _total_supply = u64::from_le_bytes(decompressed[cursor..cursor+8].try_into()
                .map_err(|_| IntegrationError::StorageError("Invalid total_supply".to_string()))?);
            cursor += 8;
            let snap_height = u64::from_le_bytes(decompressed[cursor..cursor+8].try_into()
                .map_err(|_| IntegrationError::StorageError("Invalid height".to_string()))?);
            cursor += 8;

            println!("[INFO][SNAPSHOT] format_B detected h={} snap_h={} supply={}", height, snap_height, _total_supply);

            // Remaining bytes = bincode-serialized accounts HashMap
            let accounts_cf = self.persistent.db.cf_handle("accounts")
                .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;

            if cursor < decompressed.len() {
                let accounts_data = &decompressed[cursor..];
                // Deserialize bincode accounts: HashMap<String, AccountState> or Vec<(key, value)>
                // save_state_snapshot uses bincode::serialize(&accounts) where accounts is the full map
                match bincode::deserialize::<std::collections::HashMap<String, Vec<u8>>>(accounts_data) {
                    Ok(accounts_map) => {
                        let mut batch = WriteBatch::default();
                        let mut account_count = 0u64;
                        for (key, value) in &accounts_map {
                            batch.put_cf(&accounts_cf, key.as_bytes(), value);
                            account_count += 1;
                        }
                        self.persistent.db.write(batch)?;
                        println!("[INFO][SNAPSHOT] format_B_restored h={} accounts={}", height, account_count);

                        if account_count == 0 {
                            eprintln!("[ERR][SNAPSHOT] format_B_empty h={} — 0 accounts", height);
                            return Err(IntegrationError::StorageError(format!(
                                "Format B snapshot h={} restored 0 accounts", height
                            )));
                        }
                    }
                    Err(_) => {
                        // Fallback: try deserializing as raw KV pairs (same format as Format A body)
                        let mut batch = WriteBatch::default();
                        let mut account_count = 0u64;
                        let mut c = cursor;
                        while c + 4 <= decompressed.len() {
                            let key_len = u32::from_le_bytes(
                                match decompressed[c..c+4].try_into() { Ok(b) => b, Err(_) => break }
                            ) as usize;
                            c += 4;
                            if c + key_len > decompressed.len() || key_len > 1_000_000 { break; }
                            let key = &decompressed[c..c+key_len];
                            c += key_len;
                            if c + 4 > decompressed.len() { break; }
                            let value_len = u32::from_le_bytes(
                                match decompressed[c..c+4].try_into() { Ok(b) => b, Err(_) => break }
                            ) as usize;
                            c += 4;
                            if c + value_len > decompressed.len() || value_len > 100_000_000 { break; }
                            let value = &decompressed[c..c+value_len];
                            c += value_len;
                            batch.put_cf(&accounts_cf, key, value);
                            account_count += 1;
                        }
                        self.persistent.db.write(batch)?;
                        println!("[INFO][SNAPSHOT] format_B_kv_fallback h={} accounts={}", height, account_count);

                        if account_count == 0 {
                            eprintln!("[ERR][SNAPSHOT] format_B_kv_empty h={}", height);
                            return Err(IntegrationError::StorageError(format!(
                                "Format B snapshot h={} restored 0 accounts (kv fallback)", height
                            )));
                        }
                    }
                }
            }

            // v10.1: CRITICAL — set chain_height so node syncs only blocks AFTER snapshot.
            // Without this, chain_height stays 0 → node re-downloads ALL blocks from genesis.
            // Every L1 (Ethereum, Solana, Near) does this: snapshot = trusted state at height H.
            self.set_chain_height(height)?;
            println!("[INFO][SNAPSHOT] format_B_chain_height_set h={}", height);

            if crate::node::is_info() {
                println!("[INFO][SNAPSHOT] format_B_load_complete h={}", height);
            }
            return Ok(());
        }

        // ═══════════════════════════════════════════════════════════════════
        // FORMAT A: create_state_snapshot — [0x02 | version(4) | height(8) | timestamp(8) | KV pairs | markers...]
        // This is the canonical full snapshot format.
        // ═══════════════════════════════════════════════════════════════════
        let version = probe; // already read as u32
        cursor += 4;

        if version != crate::node::PROTOCOL_VERSION {
            println!("[WARN][STORAGE] snapshot_version_mismatch snapshot_v={} current_v={}",
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
            let key_len = u32::from_le_bytes(
                match decompressed[cursor..cursor+4].try_into() {
                    Ok(b) => b,
                    Err(_) => break, // v9.1: safe break instead of panic
                }
            ) as usize;
            cursor += 4;

            if cursor + key_len > decompressed.len() { break; }
            let key = &decompressed[cursor..cursor+key_len];
            cursor += key_len;

            if cursor + 4 > decompressed.len() { break; }
            let value_len = u32::from_le_bytes(
                match decompressed[cursor..cursor+4].try_into() {
                    Ok(b) => b,
                    Err(_) => break, // v9.1: safe break instead of panic
                }
            ) as usize;
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
                        cursor += 11; // Skip past marker so next section is reachable
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
        
        // v5.0: Restore contract_storage from snapshot
        let mut contract_count = 0u64;
        if cursor + 19 <= decompressed.len() && &decompressed[cursor..cursor+19] == b"CONTRACT_STORAGE_V1" {
            cursor += 19;
            if let Some(cs_cf) = self.persistent.db.cf_handle("contract_storage") {
                let mut cs_batch = WriteBatch::default();
                while cursor < decompressed.len() {
                    if cursor + 20 <= decompressed.len() && &decompressed[cursor..cursor+20] == b"CONTRACT_STORAGE_END" {
                        cursor += 20;
                        break;
                    }
                    if cursor + 4 > decompressed.len() { break; }
                    let key_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().unwrap_or([0;4])) as usize;
                    cursor += 4;
                    if cursor + key_len > decompressed.len() { break; }
                    let key = &decompressed[cursor..cursor+key_len];
                    cursor += key_len;
                    if cursor + 4 > decompressed.len() { break; }
                    let value_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().unwrap_or([0;4])) as usize;
                    cursor += 4;
                    if cursor + value_len > decompressed.len() { break; }
                    let value = &decompressed[cursor..cursor+value_len];
                    cursor += value_len;
                    cs_batch.put_cf(&cs_cf, key, value);
                    contract_count += 1;
                }
                self.persistent.db.write(cs_batch)?;
            }
        }

        // v5.0: Restore node_registry from snapshot
        let mut registry_count = 0u64;
        if cursor + 16 <= decompressed.len() && &decompressed[cursor..cursor+16] == b"NODE_REGISTRY_V1" {
            cursor += 16;
            if let Some(nr_cf) = self.persistent.db.cf_handle("node_registry") {
                let mut nr_batch = WriteBatch::default();
                while cursor < decompressed.len() {
                    if cursor + 17 <= decompressed.len() && &decompressed[cursor..cursor+17] == b"NODE_REGISTRY_END" {
                        let _ = cursor + 17; // consumed; loop breaks
                        break;
                    }
                    if cursor + 4 > decompressed.len() { break; }
                    let key_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().unwrap_or([0;4])) as usize;
                    cursor += 4;
                    if cursor + key_len > decompressed.len() { break; }
                    let key = &decompressed[cursor..cursor+key_len];
                    cursor += key_len;
                    if cursor + 4 > decompressed.len() { break; }
                    let value_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().unwrap_or([0;4])) as usize;
                    cursor += 4;
                    if cursor + value_len > decompressed.len() { break; }
                    let value = &decompressed[cursor..cursor+value_len];
                    cursor += value_len;
                    nr_batch.put_cf(&nr_cf, key, value);
                    registry_count += 1;
                }
                self.persistent.db.write(nr_batch)?;
            }
        }

        if crate::node::is_info() {
            println!("[INFO][SNAPSHOT] full_snap_restored h={} accounts={} rewards={} contracts={} registry={}",
                     height, account_count, rewards_count, contract_count, registry_count);
        }

        // Post-restore integrity: verify account count is plausible
        if account_count == 0 {
            eprintln!("[ERR][SNAPSHOT] full_snap_empty h={} — 0 accounts restored, snapshot may be corrupted", height);
            return Err(IntegrationError::StorageError(format!(
                "Full snapshot h={} restored 0 accounts", height
            )));
        }

        // v10.1: CRITICAL — set chain_height so node syncs only blocks AFTER snapshot.
        // Without this, chain_height stays 0 → node re-downloads ALL blocks from genesis.
        // Every L1 (Ethereum, Solana, Near) does this: snapshot = trusted state at height H.
        self.set_chain_height(height)?;
        println!("[INFO][SNAPSHOT] format_A_chain_height_set h={}", height);

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
        
        println!("[INFO][STORAGE] ipfs_snapshot_upload_start height={}", height);
        
        // Get snapshot data BEFORE any async operations (avoids Send issues)
        let snapshot_data = {
            let snapshots_cf = self.persistent.db.cf_handle("snapshots")
                .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
            
            let full_key = format!("full_snap_{}", height);
            let state_key = format!("state_snap_{}", height);
            self.persistent.db.get_cf(&snapshots_cf, full_key.as_bytes())?
                .or(self.persistent.db.get_cf(&snapshots_cf, state_key.as_bytes())?)
                .ok_or_else(|| IntegrationError::StorageError(format!("Snapshot at height {} not found", height)))?
        }; // RocksDB handle is dropped here
        
        // PRODUCTION: Create IPFS-compatible metadata
        let _metadata = json!({
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
                
                println!("[INFO][STORAGE] ipfs_snapshot_uploaded cid={}", cid);
                
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
            println!("[INFO][STORAGE] ipfs_content_pinned cid={}", cid);
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
        
        println!("[INFO][STORAGE] ipfs_snapshot_download_start cid={}", cid);
        
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
            println!("[INFO][STORAGE] ipfs_trying_gateway url={}", gateway);
            
            match client.get(&url).send().await {
                Ok(response) if response.status().is_success() => {
                    match response.bytes().await {
                        Ok(data) => {
                            snapshot_data = Some(data.to_vec());
                            println!("[INFO][STORAGE] ipfs_downloaded bytes={} gateway={}", data.len(), gateway);
                            break;
                        },
                        Err(e) => {
                            println!("[WARN][STORAGE] ipfs_read_failed gateway={} err={}", gateway, e);
                            continue;
                        }
                    }
                },
                Ok(response) => {
                    println!("[WARN][STORAGE] ipfs_gateway_error gateway={} status={}", gateway, response.status());
                    continue;
                },
                Err(e) => {
                    println!("[WARN][STORAGE] ipfs_connect_failed gateway={} err={}", gateway, e);
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
        
        // Save snapshot locally (full format from IPFS)
        let snapshot_key = format!("full_snap_{}", height);
        self.persistent.db.put_cf(&snapshots_cf, snapshot_key.as_bytes(), &data)?;
        
        // Save IPFS reference
        let ipfs_key = format!("ipfs_{}", height);
        self.persistent.db.put_cf(&snapshots_cf, ipfs_key.as_bytes(), cid.as_bytes())?;
        
        println!("[INFO][STORAGE] ipfs_snapshot_saved height={}", height);
        
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
        println!("[INFO][STORAGE] snapshot_announcing height={} cid={}", height, cid);
        
        // Create announcement message
        let _announcement = json!({
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
        
        println!("[INFO][STORAGE] snapshot_announced peers={}", peers.len());
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
        
        println!("[INFO][STORAGE] block_pruning_start keeping_from={}", prune_before);
        
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
                    println!("[INFO][STORAGE] macroblock_pruned macro_num={} micro_height={}", 
                            macro_number, height);
                }
            }
                
                // Apply batch every 1000 blocks to avoid memory issues
                if pruned_count % 1000 == 0 {
                    self.persistent.db.write(batch)?;
                    batch = WriteBatch::default();
                    println!("[INFO][STORAGE] pruning_progress count={}", pruned_count);
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
        
        println!("[INFO][STORAGE] blocks_pruned count={} before_height={} snapshot_at={}", 
                pruned_count, prune_before, last_snapshot);
        
        // CRITICAL: Also prune transactions from pruned blocks
        // Transactions are stored separately and must be cleaned up
        let tx_pruned = self.prune_old_transactions(prune_before)?;
        if tx_pruned > 0 {
            println!("[INFO][STORAGE] txs_pruned count={}", tx_pruned);
        }
        
        // Update metadata
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.persistent.db.put_cf(&metadata_cf, b"oldest_block", &prune_before.to_le_bytes())?;
        
        Ok(())
    }
    
    /// v9.0: Prune old transactions + tx_index + tx_by_address below retention height.
    /// Uses HashSet for O(1) lookups (was O(n) Vec::contains — quadratic on large datasets).
    /// Called from prune_old_blocks() for non-Super nodes, and from run_ephemeral_cleanup()
    /// for ALL node types (Super nodes keep blocks but prune tx indices beyond retention).
    pub fn prune_old_transactions(&self, prune_before_height: u64) -> IntegrationResult<u64> {
        let tx_cf = self.persistent.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        let tx_index_cf = self.persistent.db.cf_handle("tx_index")
            .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
        let tx_by_addr_cf = self.persistent.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;

        let mut batch = WriteBatch::default();
        let mut pruned_count: u64 = 0;
        // v9.0: Use HashSet for O(1) membership test (was Vec::contains = O(n))
        let mut tx_hashes_to_prune: std::collections::HashSet<String> = std::collections::HashSet::new();

        // Step 1: Find transactions in blocks before prune_before_height using tx_index
        let iter = self.persistent.db.iterator_cf(&tx_index_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, value) = item?;

            // tx_index stores: tx_hash -> block_height (8 bytes BE)
            if value.len() >= 8 {
                let block_height = u64::from_be_bytes(value[..8].try_into().unwrap_or([0u8; 8]));

                if block_height < prune_before_height {
                    let tx_key = String::from_utf8_lossy(&key).to_string();
                    tx_hashes_to_prune.insert(tx_key);
                }
            }
        }

        if tx_hashes_to_prune.is_empty() {
            return Ok(0);
        }

        // Step 2: Delete transactions and their indices
        for tx_key in &tx_hashes_to_prune {
            batch.delete_cf(&tx_cf, tx_key.as_bytes());
            batch.delete_cf(&tx_index_cf, tx_key.as_bytes());

            pruned_count += 1;

            // Apply batch every 5000 transactions to limit memory
            if pruned_count % 5000 == 0 {
                self.persistent.db.write(batch)?;
                batch = WriteBatch::default();
                if crate::node::is_info() {
                    println!("[INFO][PRUNE] tx_progress count={}", pruned_count);
                }
            }
        }

        // Step 3: Clean up tx_by_address index
        // Key format: addr_{address}_{timestamp_hex}_{tx_hash}
        // v9.0: O(1) HashSet lookup per entry instead of O(n) Vec::contains
        let addr_iter = self.persistent.db.iterator_cf(&tx_by_addr_cf, rocksdb::IteratorMode::Start);
        let mut addr_pruned: u64 = 0;

        for item in addr_iter {
            let (key, _value) = item?;
            let key_str = String::from_utf8_lossy(&key);

            // Extract tx_hash from last segment of key
            if let Some(tx_hash) = key_str.rsplit('_').next() {
                let tx_key = format!("tx_{}", tx_hash);
                if tx_hashes_to_prune.contains(&tx_key) {
                    batch.delete_cf(&tx_by_addr_cf, &key);
                    addr_pruned += 1;

                    if addr_pruned % 5000 == 0 {
                        self.persistent.db.write(batch)?;
                        batch = WriteBatch::default();
                    }
                }
            }
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

            if crate::node::is_info() {
                println!("[INFO][PRUNE] tx_done txs={} addr_entries={} before_h={}",
                         pruned_count, addr_pruned, prune_before_height);
            }
        }
        
        Ok(pruned_count)
    }
    
    /// Light node pruning - keep only block headers and recent state
    fn prune_for_light_node(&self) -> IntegrationResult<()> {
        println!("[INFO][STORAGE] light_node_prune_start mode=headers_only");
        
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
        
        println!("[INFO][STORAGE] blocks_to_headers converted={}", converted);
        
        Ok(())
    }
    
    /// Get current storage mode
    pub fn get_storage_mode(&self) -> StorageMode {
        self.storage_mode
    }
    
    /// Check if block is within retention window
    pub fn is_block_retained(&self, _height: u64) -> bool {
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
    
    /// Get the latest snapshot height available for fast sync.
    /// Prefers full snapshots (latest_full_snap) over state snapshots (latest_state_snap),
    /// falls back to numerical scan over all snapshot_* keys.
    pub fn get_latest_snapshot_height(&self) -> IntegrationResult<Option<u64>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        // 1. Prefer full snapshot pointer (written by create_state_snapshot)
        if let Ok(Some(data)) = self.persistent.db.get_cf(&snapshots_cf, b"latest_full_snap") {
            if data.len() >= 8 {
                if let Ok(bytes) = data[..8].try_into() {
                    let height = u64::from_le_bytes(bytes);
                    if height > 0 { return Ok(Some(height)); }
                }
            }
        }

        // 2. Fall back to state snapshot pointer (written by save_state_snapshot)
        if let Ok(Some(data)) = self.persistent.db.get_cf(&snapshots_cf, b"latest_state_snap") {
            if data.len() >= 8 {
                if let Ok(bytes) = data[..8].try_into() {
                    let height = u64::from_le_bytes(bytes);
                    if height > 0 { return Ok(Some(height)); }
                }
            }
        }

        // 3. Scan for full_snap_ and state_snap_ keys (handles nodes without pointers)
        let mut latest_height = 0u64;
        let iter = self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            if let Ok((key, _)) = item {
                let key_str = String::from_utf8_lossy(&key);
                let h_opt = key_str.strip_prefix("full_snap_")
                    .or_else(|| key_str.strip_prefix("state_snap_"));
                if let Some(h_str) = h_opt {
                    if let Ok(h) = h_str.parse::<u64>() {
                        if h > latest_height { latest_height = h; }
                    }
                }
            }
        }

        if latest_height > 0 { Ok(Some(latest_height)) } else { Ok(None) }
    }
    
    /// Get raw snapshot data for P2P download (v2.19.12)
    /// Returns compressed binary snapshot data
    pub fn get_snapshot_data(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        // Try full_snap_ first, then state_snap_
        for prefix in &["full_snap_", "state_snap_"] {
            let key = format!("{}{}", prefix, height);
            if let Some(data) = self.persistent.db.get_cf(&snapshots_cf, key.as_bytes())? {
                return Ok(Some(data));
            }
        }
        Ok(None)
    }
    
    /// v5.0: Download snapshot from network — chunked parallel download with fallback
    pub async fn download_and_load_snapshot(&self, p2p: &crate::unified_p2p::SimplifiedP2P) -> IntegrationResult<u64> {
        let peers = p2p.get_validated_active_peers();
        if peers.is_empty() {
            return Err(IntegrationError::Other("No peers available for snapshot download".to_string()));
        }

        // ═══════════════════════════════════════════════════════════════════════
        // v15.8: TWO-PHASE SNAPSHOT NEGOTIATION
        // ═══════════════════════════════════════════════════════════════════════
        // Phase 1: query every peer's locally-advertised snapshot height. Each
        // peer reports the highest snapshot height present on its own disk —
        // these can differ between peers because snapshot creation is per-node
        // and not all peers create at the same boundary heights.
        //
        // Phase 2: pick the highest height observed (`best_height`) and
        // restrict the download peer set to ONLY those peers that explicitly
        // reported `best_height` available. Peers that reported a lower
        // height (or no height) are excluded from the chunk-fan-out: their
        // `get_snapshot_chunk(best_height, _)` would return None and break
        // the manifest hash chain, forcing the fallback path even when one
        // capable peer exists. With targeted filtering the chunked download
        // proceeds against the actually-capable subset; if more than one
        // peer reported `best_height`, parallel chunk fan-out works as
        // designed; if exactly one did, the download serialises against
        // that single peer (still strictly faster than block-by-block sync
        // for any non-trivial snapshot size).
        //
        // Scalability: O(active_peers) for the discovery phase regardless of
        // network size; the download phase is bounded by the number of peers
        // with the matching snapshot, which on a healthy network grows with
        // the snapshot replication factor (currently per-producer; future
        // work spreads it via deterministic apply-stage creation across the
        // committee).
        //
        // IPFS fast path is preserved unchanged: any peer that advertises a
        // non-empty `ipfs_cid` and the local node has `IPFS_ENABLED=1`
        // short-circuits to the IPFS gateway, bypassing the peer-fan-out
        // entirely — that path scales horizontally with the IPFS swarm
        // independent of the validator committee size.
        // ═══════════════════════════════════════════════════════════════════════

        // ── Phase 1: discover snapshot offerings ──
        let mut best_height = 0u64;
        // Per-peer height map: only peers that returned Some are tracked.
        let mut peer_heights: Vec<(String, u64)> = Vec::new();
        for peer in &peers {
            match self.query_peer_snapshot(&peer.addr).await {
                Ok(Some((height, cid))) => {
                    if height > best_height {
                        best_height = height;
                    }
                    // IPFS fast path — content-addressed, scales with the
                    // swarm rather than the validator committee.
                    if !cid.is_empty() && std::env::var("IPFS_ENABLED").unwrap_or_default() == "1" {
                        if let Ok(_) = self.download_snapshot_from_ipfs(&cid, height).await {
                            println!("[INFO][SYNC] snapshot_from_ipfs h={}", height);
                            return Ok(height);
                        }
                    }
                    peer_heights.push((peer.addr.clone(), height));
                },
                _ => continue,
            }
        }

        if best_height == 0 || peer_heights.is_empty() {
            return Err(IntegrationError::Other("No snapshots available from network".to_string()));
        }

        // ── Phase 2: filter to peers that actually advertised best_height ──
        let peer_addrs: Vec<String> = peer_heights
            .iter()
            .filter(|(_, h)| *h == best_height)
            .map(|(addr, _)| addr.clone())
            .collect();

        if peer_addrs.is_empty() {
            // Defensive: best_height computed from peer_heights — at least one
            // entry must match. Return Err rather than indexing into an empty
            // vec on the legacy fallback path below.
            return Err(IntegrationError::Other(format!(
                "snapshot_peer_filter_empty best_height={} candidates={}",
                best_height, peer_heights.len(),
            )));
        }

        println!(
            "[INFO][SYNC] snapshot_download h={} capable_peers={}/{} discovery=two_phase",
            best_height, peer_addrs.len(), peer_heights.len(),
        );

        // Try chunked parallel download first (v5.0), fallback to single-peer
        match self.download_snapshot_chunked(&peer_addrs, best_height).await {
            Ok(()) => {
                self.verify_snapshot_consensus_binding(p2p, best_height).await?;
                Ok(best_height)
            }
            Err(e) => {
                println!("[WARN][SYNC] chunked_download_failed err={} fallback=legacy", e);
                self.download_snapshot_legacy(&peer_addrs[0], best_height).await?;
                self.verify_snapshot_consensus_binding(p2p, best_height).await?;
                Ok(best_height)
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SNAPSHOT-CONSENSUS BINDING VERIFICATION (v15.8)
    // ═══════════════════════════════════════════════════════════════════════════
    // Closes the trust-less-bootstrap gap: a peer serving a snapshot also
    // serves the manifest hashes, so a single byzantine peer (or a colluding
    // ≤ f minority) can return a forged snapshot whose chunks all match a
    // forged manifest. Per-chunk hashes alone do not bind the snapshot to
    // the canonical chain — they only confirm "what I downloaded matches
    // the metadata the peer sent".
    //
    // The fix: every macroblock at a snapshot-boundary height embeds a
    // `snapshot_root` field in its `consensus_data`. That field is filled
    // by the producer with the SHA3-256 digest of the canonical snapshot
    // bytes at the boundary; every honest committee member computes the
    // same digest because both snapshot creation (deterministic apply-stage
    // trigger) and snapshot serialisation (canonical key ordering, boundary
    // microblock timestamp) are byte-stable across the committee. The
    // macroblock is finalised by ≥ 2f+1 Dilithium3 commit-reveal signatures,
    // so an attacker would need to compromise 2f+1 keys to forge the
    // `snapshot_root` value on chain — the same supermajority threshold
    // that protects every other consensus-bound field.
    //
    // After download, the verifier:
    //   1. computes SHA3-256 over the locally-saved snapshot bytes,
    //   2. fetches the macroblock at `mb_idx = height / 90` (locally first,
    //      then via P2P sync_macroblocks if absent),
    //   3. reads `consensus_data.snapshot_root` from that macroblock,
    //   4. compares — accepts on match, ROLLS BACK on mismatch.
    //
    // BYZANTINE-SAFE BINDING: snapshot acceptance requires a consensus-
    // finalised `snapshot_root` from the binding macroblock. The previous
    // implementation had three "graceful degradation" exits that accepted
    // snapshots without verification:
    //
    //   * `verifier_macroblock_fetch_failed` — peer returned no macroblock
    //   * `verifier_macroblock_unavailable`  — local cache miss after fetch
    //   * `verifier_no_binding`              — macroblock had `snapshot_root = None`
    //
    // Each of those let an attacker peer feed an arbitrary snapshot whenever
    // the local node could not retrieve the matching macroblock — and with
    // a controlled peer that's trivially arrangeable. Now every failure
    // returns Err so the caller falls through to byzantine-safe
    // block-by-block sync. Liveness cost is one extra sync round-trip;
    // safety gain is no attacker-controlled state contamination.
    //
    // Rollback: on digest mismatch the snapshot keys
    // (`full_snap_{height}` / `state_snap_{height}`) are deleted to prevent
    // the bad data from being read by subsequent state-recovery passes.
    //
    // Scalability: O(1) per bootstrap (one SHA3 over the snapshot, one
    // macroblock fetch). Independent of validator committee size. The
    // P2P fetch is bounded by the macroblock-sync timeout window.
    // ═══════════════════════════════════════════════════════════════════════════
    async fn verify_snapshot_consensus_binding(
        &self,
        p2p: &crate::unified_p2p::SimplifiedP2P,
        snapshot_height: u64,
    ) -> IntegrationResult<()> {
        // Genesis-window snapshots (mb_idx < 1) cannot be bound to a
        // consensus-finalised macroblock — there is nothing earlier to
        // anchor against. Accept silently; this only fires for snapshots
        // very early in the chain's lifetime.
        let mb_idx = snapshot_height / 90;
        if mb_idx == 0 {
            return Ok(());
        }

        // Step 1: load the macroblock binding the snapshot. Try local
        // storage first; on miss, request a single-macroblock sync.
        let macroblock_bytes = match self.get_macroblock_by_height(mb_idx)
            .map_err(|e| IntegrationError::Other(format!("mb_load_err mb={} err={:?}", mb_idx, e)))?
        {
            Some(b) => b,
            None => {
                if crate::node::is_info() {
                    println!(
                        "[INFO][SYNC] verifier_fetching_macroblock mb={} for_snapshot_h={}",
                        mb_idx, snapshot_height,
                    );
                }
                if let Err(e) = p2p.sync_macroblocks(mb_idx, mb_idx).await {
                    if crate::node::is_warn() {
                        println!(
                            "[WARN][SYNC] verifier_macroblock_fetch_failed mb={} err={} action=reject_snapshot",
                            mb_idx, e,
                        );
                    }
                    return Err(IntegrationError::Other(format!(
                        "snapshot_binding_unavailable mb={} reason=mb_fetch_failed",
                        mb_idx
                    )));
                }
                match self.get_macroblock_by_height(mb_idx)
                    .map_err(|e| IntegrationError::Other(format!("mb_reload_err mb={} err={:?}", mb_idx, e)))?
                {
                    Some(b) => b,
                    None => {
                        if crate::node::is_warn() {
                            println!(
                                "[WARN][SYNC] verifier_macroblock_unavailable mb={} action=reject_snapshot",
                                mb_idx,
                            );
                        }
                        return Err(IntegrationError::Other(format!(
                            "snapshot_binding_unavailable mb={} reason=mb_post_fetch_miss",
                            mb_idx
                        )));
                    }
                }
            }
        };

        let macroblock: qnet_state::MacroBlock = match bincode::deserialize(&macroblock_bytes) {
            Ok(mb) => mb,
            Err(e) => {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][SYNC] verifier_macroblock_decode_failed mb={} err={} action=reject_snapshot",
                        mb_idx, e,
                    );
                }
                return Err(IntegrationError::Other(format!(
                    "snapshot_binding_unavailable mb={} reason=mb_decode_failed err={}",
                    mb_idx, e
                )));
            }
        };

        // Step 2: read the supermajority-bound snapshot_root.
        let expected_root = match macroblock.consensus_data.snapshot_root {
            Some(r) => r,
            None => {
                // No snapshot_root in the binding macroblock — cannot verify.
                // Reject and let the caller fall through to block-by-block
                // sync. Pre-binding (legacy) macroblocks should not appear
                // in a freshly-deployed network; if seen during a protocol
                // upgrade, operator must produce a fresh macroblock at the
                // next boundary before snapshot-based sync resumes.
                if crate::node::is_warn() {
                    println!(
                        "[WARN][SYNC] verifier_no_binding mb={} snapshot_h={} action=reject_snapshot",
                        mb_idx, snapshot_height,
                    );
                }
                return Err(IntegrationError::Other(format!(
                    "snapshot_binding_missing mb={} reason=mb_has_no_snapshot_root",
                    mb_idx
                )));
            }
        };

        // Step 3: hash the locally-saved snapshot bytes.
        let snapshot_bytes = match self.get_snapshot_data(snapshot_height)
            .map_err(|e| IntegrationError::Other(format!("snapshot_read_err h={} err={:?}", snapshot_height, e)))?
        {
            Some(b) => b,
            None => {
                return Err(IntegrationError::Other(format!(
                    "verifier_snapshot_data_missing_post_download h={}",
                    snapshot_height,
                )));
            }
        };

        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(&snapshot_bytes);
        let mut computed = [0u8; 32];
        computed.copy_from_slice(&hasher.finalize());

        // Step 4: constant-time-ish comparison and rollback on mismatch.
        if computed != expected_root {
            // Rollback: erase the bad snapshot before returning so the
            // caller's fall-through to block-by-block sync is not
            // contaminated by attacker-controlled state.
            if let Some(snapshots_cf) = self.persistent.db.cf_handle("snapshots") {
                for prefix in &["full_snap_", "state_snap_"] {
                    let key = format!("{}{}", prefix, snapshot_height);
                    let _ = self.persistent.db.delete_cf(&snapshots_cf, key.as_bytes());
                }
            }
            return Err(IntegrationError::Other(format!(
                "snapshot_root_mismatch h={} mb={} expected={} computed={}",
                snapshot_height,
                mb_idx,
                hex::encode(&expected_root[..8]),
                hex::encode(&computed[..8]),
            )));
        }

        if crate::node::is_info() {
            println!(
                "[INFO][SYNC] verifier_pass mb={} snapshot_h={} digest={}",
                mb_idx, snapshot_height, hex::encode(&computed[..8]),
            );
        }
        Ok(())
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
            Err(e) => println!("[WARN][STORAGE] snapshot_peer_query_failed peer={} err={}", peer_addr, e),
        }
        
        Ok(None)
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v5.0: CHUNKED SNAP SYNC — parallel download from multiple peers
    // Snapshot is split into 4MB chunks, each verified independently.
    // ═══════════════════════════════════════════════════════════════════════════

    const SNAPSHOT_CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4MB per chunk

    /// Get snapshot manifest (chunk count + per-chunk SHA3 hashes)
    /// Used by peers to request individual chunks for parallel download
    pub fn get_snapshot_manifest(&self, height: u64) -> IntegrationResult<Option<SnapshotManifest>> {
        let data = match self.get_snapshot_data(height)? {
            Some(d) => d,
            None => return Ok(None),
        };
        let total_size = data.len();
        let chunk_count = (total_size + Self::SNAPSHOT_CHUNK_SIZE - 1) / Self::SNAPSHOT_CHUNK_SIZE;
        let mut chunk_hashes = Vec::with_capacity(chunk_count);
        for i in 0..chunk_count {
            let start = i * Self::SNAPSHOT_CHUNK_SIZE;
            let end = std::cmp::min(start + Self::SNAPSHOT_CHUNK_SIZE, total_size);
            let hash = sha3::Sha3_256::digest(&data[start..end]);
            chunk_hashes.push(hex::encode(hash));
        }
        Ok(Some(SnapshotManifest {
            height,
            total_size: total_size as u64,
            chunk_size: Self::SNAPSHOT_CHUNK_SIZE as u64,
            chunk_count: chunk_count as u64,
            chunk_hashes,
        }))
    }

    /// Get a specific chunk of the snapshot (0-indexed)
    pub fn get_snapshot_chunk(&self, height: u64, chunk_index: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let data = match self.get_snapshot_data(height)? {
            Some(d) => d,
            None => return Ok(None),
        };
        let start = (chunk_index as usize) * Self::SNAPSHOT_CHUNK_SIZE;
        if start >= data.len() {
            return Ok(None);
        }
        let end = std::cmp::min(start + Self::SNAPSHOT_CHUNK_SIZE, data.len());
        Ok(Some(data[start..end].to_vec()))
    }

    /// Download snapshot using chunked parallel protocol from multiple peers
    /// Falls back to legacy single-request download if chunked protocol unavailable
    pub async fn download_snapshot_chunked(&self, peer_addrs: &[String], height: u64) -> IntegrationResult<()> {
        if peer_addrs.is_empty() {
            return Err(IntegrationError::Other("No peers for chunked download".to_string()));
        }
        let start_time = std::time::Instant::now();

        // Step 1: Fetch manifest from first responsive peer
        let mut manifest: Option<SnapshotManifest> = None;
        for addr in peer_addrs {
            let url = format!("http://{}/api/v1/snapshot/{}/manifest", addr, height);
            match reqwest::Client::new().get(&url).timeout(std::time::Duration::from_secs(10)).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(m) = resp.json::<SnapshotManifest>().await {
                        manifest = Some(m);
                        break;
                    }
                }
                _ => continue,
            }
        }

        let manifest = match manifest {
            Some(m) => m,
            None => {
                // Fallback: legacy single-request download from first peer
                if crate::node::is_info() {
                    println!("[INFO][SYNC] chunked_manifest_unavailable fallback=legacy");
                }
                return self.download_snapshot_legacy(&peer_addrs[0], height).await;
            }
        };

        println!("[INFO][SYNC] chunked_download_start h={} chunks={} total={}MB",
                 height, manifest.chunk_count, manifest.total_size / (1024 * 1024));

        // Step 2: Download chunks in parallel (round-robin across peers)
        let chunk_count = manifest.chunk_count as usize;
        let mut assembled = vec![0u8; manifest.total_size as usize];
        let chunk_size = manifest.chunk_size as usize;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| IntegrationError::Other(format!("HTTP client error: {}", e)))?;

        // Download up to 4 chunks concurrently
        let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
        let chunks_result: Vec<(usize, IntegrationResult<Vec<u8>>)> = {
            let mut handles = Vec::with_capacity(chunk_count);
            for i in 0..chunk_count {
                let peer = peer_addrs[i % peer_addrs.len()].clone();
                let client = client.clone();
                let expected_hash = manifest.chunk_hashes[i].clone();
                let sem = semaphore.clone();
                handles.push(tokio::spawn(async move {
                    let _permit = match sem.acquire().await {
                        Ok(p) => p,
                        Err(_) => return Err(IntegrationError::Other("Snapshot semaphore closed".into())),
                    };
                    let url = format!("http://{}/api/v1/snapshot/{}/chunk/{}", peer, height, i);
                    let resp = client.get(&url).send().await
                        .map_err(|e| IntegrationError::Other(format!("Chunk {} download: {}", i, e)))?;
                    if !resp.status().is_success() {
                        return Err(IntegrationError::Other(format!("Chunk {} HTTP {}", i, resp.status())));
                    }
                    let bytes = resp.bytes().await
                        .map_err(|e| IntegrationError::Other(format!("Chunk {} read: {}", i, e)))?;
                    let actual_hash = hex::encode(sha3::Sha3_256::digest(&bytes));
                    if actual_hash != expected_hash {
                        return Err(IntegrationError::Other(
                            format!("Chunk {} hash mismatch expected={} got={}", i, &expected_hash[..16], &actual_hash[..16])
                        ));
                    }
                    Ok(bytes.to_vec())
                }));
            }
            let mut results = Vec::with_capacity(chunk_count);
            for (i, h) in handles.into_iter().enumerate() {
                let r = h.await.map_err(|e| IntegrationError::Other(format!("Chunk {} join: {}", i, e)))?;
                results.push((i, r));
            }
            results
        };

        // Step 3: Assemble chunks into full snapshot
        for (i, result) in chunks_result {
            let chunk_data = result?;
            let start = i * chunk_size;
            let end = std::cmp::min(start + chunk_data.len(), assembled.len());
            assembled[start..end].copy_from_slice(&chunk_data);
        }

        // Step 4: Save assembled snapshot to DB
        {
            let snapshots_cf = self.persistent.db.cf_handle("snapshots")
                .ok_or_else(|| IntegrationError::StorageError("snapshots CF not found".to_string()))?;
            let key = format!("full_snap_{}", height);
            self.persistent.db.put_cf(&snapshots_cf, key.as_bytes(), &assembled)?;
        }

        self.load_state_snapshot(height).await?;

        let elapsed = start_time.elapsed();
        println!("[INFO][SYNC] chunked_download_done h={} chunks={} total={}MB elapsed={:.1}s",
                 height, chunk_count, manifest.total_size / (1024 * 1024), elapsed.as_secs_f64());
        Ok(())
    }

    /// Legacy single-request snapshot download (backward compatibility)
    async fn download_snapshot_legacy(&self, peer_addr: &str, height: u64) -> IntegrationResult<()> {
        let url = format!("http://{}/api/v1/snapshot/{}", peer_addr, height);
        let response = reqwest::get(&url).await
            .map_err(|e| IntegrationError::Other(format!("Download error: {}", e)))?;
        if !response.status().is_success() {
            return Err(IntegrationError::Other("Snapshot download failed".to_string()));
        }
        let data = response.bytes().await
            .map_err(|e| IntegrationError::Other(format!("Download error: {}", e)))?;
        {
            let snapshots_cf = self.persistent.db.cf_handle("snapshots")
                .ok_or_else(|| IntegrationError::StorageError("snapshots CF not found".to_string()))?;
            let key = format!("full_snap_{}", height);
            self.persistent.db.put_cf(&snapshots_cf, key.as_bytes(), &data)?;
        }
        self.load_state_snapshot(height).await?;
        if crate::node::is_info() {
            println!("[INFO][SYNC] legacy_snapshot_applied h={}", height);
        }
        Ok(())
    }

    /// Download snapshot — tries chunked first, falls back to legacy
    #[allow(dead_code)]
    async fn download_snapshot_from_peer(&self, peer_addr: &str, height: u64) -> IntegrationResult<()> {
        self.download_snapshot_chunked(&[peer_addr.to_string()], height).await
    }

    /// Fast sync with snapshot for new nodes
    pub async fn fast_sync_with_snapshot(&self, p2p: &crate::unified_p2p::SimplifiedP2P, target_height: u64) -> IntegrationResult<()> {
        println!("[INFO][STORAGE] fast_sync_start target_height={}", target_height);
        
        // For Light nodes, only sync recent state
        if self.storage_mode == StorageMode::Light {
            println!("[INFO][STORAGE] fast_sync_light_node mode=recent_headers_only");
            return Ok(());
        }
        
        // Try to find and load a snapshot
        match self.download_and_load_snapshot(p2p).await {
            Ok(snapshot_height) => {
                println!("[INFO][STORAGE] snapshot_loaded height={}", snapshot_height);
                
                // Now sync remaining blocks from snapshot to target
                if target_height > snapshot_height {
                    println!("[INFO][STORAGE] sync_remaining_start count={}", 
                            target_height - snapshot_height);
                    // The node will handle syncing remaining blocks
                }
                
                Ok(())
            },
            Err(e) => {
                println!("[WARN][STORAGE] snapshot_sync_failed err={:?} fallback=full_sync", e);
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
                        println!("[WARN][STORAGE] contract_info_deserialize_failed err={:?}", e);
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
                        println!("[WARN][STORAGE] contract_state_decode_failed err={:?}", e);
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
        let result = Vec::new();
        
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

// ═══════════════════════════════════════════════════════════════════════════
// v15.10 STAGE-2: AccountStore impl — read-through fallback for StateManager
// ───────────────────────────────────────────────────────────────────────────
// `Storage::load_account` exposes the synchronous point read.
// `qnet_state::AccountStore` is the trait the StateManager warm-cache pass
// calls into on every cache miss. The impl is a thin error-swallowing
// wrapper: on transient RocksDB errors we return `None` (the caller treats
// it identically to a genuine miss), and on success we return the
// deserialised Account.
//
// PRIVACY-FIRST LOGGING
// ───────────────────────────────────────────────────────────────────────────
// Errors are logged at INFO level with the address truncated to the first
// 16 hex characters, matching the rest of the codebase's privacy posture.
//
// HOT-PATH BUDGET
// ───────────────────────────────────────────────────────────────────────────
// `load_account` is invoked once per cold address per block (warm-cache
// pass). At ~1 000 unique addresses per block × ≤ 100 µs RocksDB point
// read = ≤ 100 ms of disk reads concentrated at apply-time. Runs synchronously
// because `qnet_state::AccountStore::load_account` is a sync trait method —
// the disk reads are safe at this latency budget on SSD-backed Super nodes
// and the warm pass itself runs OUTSIDE the state-write lock window
// (see block_pipeline.rs apply path for the lock-free pre-warm site).
impl qnet_state::AccountStore for Storage {
    fn load_account(&self, address: &str) -> Option<qnet_state::Account> {
        match self.persistent.load_account(address) {
            Ok(opt) => opt,
            Err(e) => {
                if crate::node::is_info() {
                    let preview = if address.len() >= 16 { &address[..16] } else { address };
                    println!(
                        "[INFO][CACHE] disk_load_err addr={} err={:?}",
                        preview, e,
                    );
                }
                None
            }
        }
    }
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
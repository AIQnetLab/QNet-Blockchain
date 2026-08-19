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

/// Block-body deletions, split by whether they happened above the 2f+1 finality floor.
/// The end-state invariant of the non-destructive store is `above_finality == 0`: only finality
/// pruning may remove a body. Counted here — the single choke point — so the acceptance test
/// measures the real store rather than a code path someone remembered to instrument.
pub static BODY_DELETES_TOTAL: AtomicU64 = AtomicU64::new(0);
pub static BODY_DELETES_ABOVE_FINALITY: AtomicU64 = AtomicU64::new(0);

/// Record one body deletion at `height` and classify it against the current finality floor.
#[inline]
fn note_body_delete(height: u64) {
    BODY_DELETES_TOTAL.fetch_add(1, Ordering::Relaxed);
    let finalized = crate::node::LAST_FINALIZED_HEIGHT.load(Ordering::SeqCst);
    if height > finalized {
        BODY_DELETES_ABOVE_FINALITY.fetch_add(1, Ordering::Relaxed);
    }
}

/// What occupies a chain slot. Distinguishing "burned" from "unknown" is the difference between
/// a slot the network agreed nobody filled and a block this node simply lacks — treating the
/// first as the second is how a skipped slot becomes an endless repair loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotStatus {
    Block([u8; 32]),
    Burned,
    Unknown,
}

/// Compact block header, addressed by block hash. Lets ancestry questions (parent lookup, reorg
/// walks, sibling enumeration) be answered without decompressing a body, and — unlike a
/// height-keyed index — the key IS the answer, so the lookup cannot go stale after a rollback.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockHeaderIdx {
    pub height: u64,
    pub previous_hash: [u8; 32],
    pub producer: String,
    pub state_root: [u8; 32],
    pub timestamp: u64,
    pub tx_count: u32,
}

/// Checkpoint vote-commitment key: `cpv_` ++ index BIG-endian, so a prefix scan is index-ordered.
#[inline]
pub(crate) fn checkpoint_vote_key(index: u64) -> Vec<u8> {
    let mut k = Vec::with_capacity(4 + 8);
    k.extend_from_slice(b"cpv_");
    k.extend_from_slice(&index.to_be_bytes());
    k
}

/// Header index key: `hdr_` ++ hash. Hash-keyed, so no ordering requirement.
#[inline]
pub(crate) fn block_header_key(hash: &[u8; 32]) -> Vec<u8> {
    let mut k = Vec::with_capacity(4 + 32);
    k.extend_from_slice(b"hdr_");
    k.extend_from_slice(hash);
    k
}

/// Body key: `bdy_` ++ hash. A body is immutable and self-identifying, so its key never has to be
/// rewritten — competing blocks coexist instead of one displacing the other.
#[inline]
pub(crate) fn block_body_key(hash: &[u8; 32]) -> Vec<u8> {
    let mut k = Vec::with_capacity(4 + 32);
    k.extend_from_slice(b"bdy_");
    k.extend_from_slice(hash);
    k
}

/// Branch index: `brn_` ++ height (zero-padded, so the range scan is numeric) ++ `_` ++ hash.
/// Lists ONLY blocks retained as non-canonical branches, which is a tiny set next to the chain
/// itself. Pruning scans this range instead of every block header — the difference between
/// O(retained branches) and O(chain length) on every finality advance.
#[inline]
pub(crate) fn branch_index_key(height: u64, hash: &[u8; 32]) -> Vec<u8> {
    let mut k = Vec::with_capacity(4 + 20 + 1 + 32);
    k.extend_from_slice(format!("brn_{:020}_", height).as_bytes());
    k.extend_from_slice(hash);
    k
}

/// Child index: `chd_` ++ parent_hash ++ child_hash. Enumerates the branches leaving a block
/// without scanning, which is what lets fork-choice compare siblings instead of deleting one.
#[inline]
pub(crate) fn block_child_key(parent: &[u8; 32], child: &[u8; 32]) -> Vec<u8> {
    let mut k = Vec::with_capacity(4 + 64);
    k.extend_from_slice(b"chd_");
    k.extend_from_slice(parent);
    k.extend_from_slice(child);
    k
}

/// Height-keyed block keys are ZERO-PADDED so byte order equals numeric order. RocksDB range
// operations (compact_range, iterators, prefix scans) compare bytes: with unpadded decimals
// "microblock_9" sorts AFTER "microblock_100", which silently inverted both prune-time
// compact_range calls — they compacted the wrong span. Width 20 covers all of u64.
#[inline]
pub(crate) fn mb_body_key(height: u64) -> String { format!("microblock_{:020}", height) }
#[inline]
pub(crate) fn mb_hash_key(height: u64) -> String { format!("microblock_hash_{:020}", height) }
#[inline]
pub(crate) fn mb_fmt_key(height: u64) -> String { format!("microblock_fmt_{:020}", height) }

// ═══════════════════════════════════════════════════════════════════════════════
// ROLLBACK PROTECTION v3.23: Prevent race condition between rollback and block save
// ═══════════════════════════════════════════════════════════════════════════════
// Problem: During rollback, parallel block receive can overwrite chain_height
// Solution: Atomic flag + target height to block saves during rollback
// Architecture: Lock-free design for maximum throughput (no mutex contention)
// ═══════════════════════════════════════════════════════════════════════════════

/// Every column family `open_cf_descriptors` creates. THE single source of truth for the flush and
/// compaction sweeps: RocksDB can only release a WAL segment once EVERY CF has flushed past it, so one
/// CF missing from the sweep pins the log indefinitely. Three hand-maintained copies of this list had
/// each drifted from the descriptors; `all_cf_names_covers_every_descriptor` now fails the build's
/// tests instead of leaking disk. Order is irrelevant.
/// Retention for the transaction indexes, in blocks (one block per second, so ~27.8 h). BOTH index
/// families are cut on this one height rule — `tx_by_address` keys carry the inclusion HEIGHT, not a
/// transaction timestamp, so nothing an author controls can move a row out of reach of the prune.
pub const TX_INDEX_RETENTION_BLOCKS: u64 = 100_000;

/// How often the maintenance pass runs. The scan budgets below are derived from it, so a change
/// here cannot silently stop retention from holding.
pub const PRUNE_RUNS_PER_HOUR: u64 = 1;

pub(crate) const ALL_CF_NAMES: [&str; 30] = [
    "blocks", "transactions", "accounts", "metadata",
    "microblocks", "consensus", "sync_state",
    "pending_rewards", "node_registry", "ping_history",
    "failover_events", "snapshots", "tx_index",
    "tx_by_address", "attestations", "heartbeats",
    "contract_storage", "fcm_tokens", "light_ping_keys",
    "accounts_stage", "node_registry_stage", "pending_rewards_stage", "contract_storage_stage",
    "mempool", "cross_shard_pending", "cross_shard_receipts",
    "merkle_leaves", "merkle_nodes", "wallet_token", "reward_agg",
];

/// Flag indicating rollback is in progress - blocks with height > target will be rejected
static ROLLBACK_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Target height for rollback - blocks above this will not be saved
static ROLLBACK_TARGET_HEIGHT: AtomicU64 = AtomicU64::new(0);

/// Set for the duration of rehydrate_inmem_state_from_promoted_cf: the in-mem StateManager is being
/// repopulated from the promoted snapshot CF and is NOT yet the bound state. The apply pipeline must
/// not write a tail block over this un-rehydrated state (wrong state_root → rollback → apply-breaker
/// churn). Mirrors ROLLBACK_IN_PROGRESS; cleared via RAII on every rehydrate exit.
pub static SNAPSHOT_REHYDRATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Set true once `backfill_owns_indices` has fully rebuilt the wallet_token index from the accounts
/// CF, making it authoritative: from then on an EMPTY per-wallet result means "holds no tokens" and
/// the reader skips the O(N) scan fallback. Until then a wallet with no index hits still falls back.
pub static OWNS_INDEX_READY: AtomicBool = AtomicBool::new(false);

/// Bumped on every macroblock body that BECOMES present (any index, contiguous or not). The pipeline's
/// committee-deferred redrive keys on this: a committee defer clears exactly when its N-2 macroblock
/// lands, so this is the precise trigger — unlike the contiguous `last_sealed_mb_index`, which an
/// out-of-order sync ingest leaves pinned behind a hole. Process-local (the deferred map is too), so no
/// persistence is needed; only CHANGE is observed.
static MACROBLOCK_SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Monotonic count of macroblock bodies that became present in this process. See `MACROBLOCK_SAVE_SEQ`.
pub fn macroblock_save_seq() -> u64 { MACROBLOCK_SAVE_SEQ.load(Ordering::Relaxed) }

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

/// Number of apply threads currently inside the durable-materialisation section (registry rows, cbw,
/// dpk binds, seals — all OUTSIDE the accounts map and all height-stamped).
static MATERIALISE_INFLIGHT: AtomicU64 = AtomicU64::new(0);

/// Held for the whole durable-materialisation + save section. See `try_claim_materialise`.
pub struct MaterialiseGuard;

impl Drop for MaterialiseGuard {
    fn drop(&mut self) { MATERIALISE_INFLIGHT.fetch_sub(1, Ordering::SeqCst); }
}

/// Claim the right to materialise height `h`. None ⇒ a rollback below `h` owns the chain; decline.
///
/// The claim is registered BEFORE the rollback re-check, which is what makes the pair race-free:
/// a claim taken after the rollback flag is set fails the re-check and writes nothing, and a claim
/// taken before it is drained by `drain_materialise_inflight` so its rows land ahead of the
/// rollback's prune scans (`rebuild_registry_lthash` / `rebuild_committed_burn_wallet` /
/// `rollback_dpk_binds_above`) and get pruned as the orphans they are. A bare `can_save_block`
/// check leaves the third case — write lands after the prune — and those rows are permanent.
pub fn try_claim_materialise(height: u64) -> Option<MaterialiseGuard> {
    MATERIALISE_INFLIGHT.fetch_add(1, Ordering::SeqCst);
    let guard = MaterialiseGuard;
    if rollback_bars_height(height) { return None; } // guard drops ⇒ decrements
    Some(guard)
}

/// Wait for every in-flight materialisation to finish. Called with the rollback flag ALREADY set, so
/// no new claim can succeed and the count is monotonically decreasing. Returns false on timeout.
///
/// Called from an async task, so the worker is released for the duration: the apply task we are
/// waiting on is a tokio task too, and on a low-core node blocking here would starve the very work
/// the drain exists to let finish — burning the whole timeout and defeating the barrier.
pub fn drain_materialise_inflight(timeout_ms: u64) -> bool {
    match tokio::runtime::Handle::try_current() {
        Ok(h) if h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(|| drain_materialise_spin(timeout_ms))
        }
        _ => drain_materialise_spin(timeout_ms),
    }
}

fn drain_materialise_spin(timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    while MATERIALISE_INFLIGHT.load(Ordering::SeqCst) > 0 {
        if std::time::Instant::now() >= deadline {
            println!("[WARN][ROLLBACK] materialise_drain_timeout inflight={}",
                     MATERIALISE_INFLIGHT.load(Ordering::Relaxed));
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    true
}

/// End rollback protection - call AFTER rollback is complete
pub fn end_rollback_protection() {
    let target = ROLLBACK_TARGET_HEIGHT.load(Ordering::Relaxed);
    ROLLBACK_IN_PROGRESS.store(false, Ordering::Release);
    // Reset the clock too: a stale timestamp left behind here makes the next rollback's watchdog read
    // an age measured from the PREVIOUS one and reap it before it has done anything.
    ROLLBACK_START_TIME.store(0, Ordering::Release);
    println!("[INFO][ROLLBACK] protection_ended target_was={}", target);
}

/// Re-stamp the rollback clock. The rollback body calls this between phases so the watchdog measures
/// time since the last PROGRESS, not since the start.
///
/// Without it the watchdog is a wall-clock deadline on total work, and the body's work is O(registry)
/// + O(retained bodies): at the 10M-light target `rebuild_registry_lthash` alone (full srtr_+lrtr_
/// scan, one point-read and one JSON parse per row, then a heartbeat-index canonicalisation over
/// thousands of block bodies) runs long past 60s. Reaping a rollback that is still making progress is
/// strictly worse than waiting: it unbars saves and materialisation for heights ABOVE the target while
/// the prune scans are mid-flight, so orphan rows land behind the scan that exists to remove them.
pub fn note_rollback_progress() {
    if !ROLLBACK_IN_PROGRESS.load(Ordering::Acquire) { return; }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    ROLLBACK_START_TIME.store(now, Ordering::Release);
}

/// Does an active rollback bar `height`? PURE — no side effects, no self-expiry.
///
/// This is the predicate for anything that must be ordered against the rollback's own repair scans.
/// `can_save_block` is NOT that predicate: its watchdog CLEARS the flag as a side effect, so a caller
/// gating on it can hand itself permission mid-rollback and take the flag down for every other reader
/// at the same time.
#[inline]
fn rollback_bars_height(height: u64) -> bool {
    ROLLBACK_IN_PROGRESS.load(Ordering::Acquire)
        && height > ROLLBACK_TARGET_HEIGHT.load(Ordering::Acquire)
}

/// Check if a block at given height can be saved (not blocked by rollback)
/// Returns true if save is allowed, false if blocked
pub fn can_save_block(height: u64) -> bool {
    if !rollback_bars_height(height) { return true; }

    // Watchdog: a rollback that has made NO progress for ROLLBACK_TIMEOUT_SECS is presumed dead
    // (its thread panicked or is wedged) and must not bar the chain forever. saturating_sub, not `-`:
    // release builds have no overflow checks, so a backwards clock step would wrap and reap instantly.
    let start_time = ROLLBACK_START_TIME.load(Ordering::Acquire);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    if start_time > 0 && now.saturating_sub(start_time) >= ROLLBACK_TIMEOUT_SECS {
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
        Ok(_) => {
            // Stamp immediately: between the CAS and the store below, can_save_block would otherwise
            // read the PREVIOUS rollback's timestamp (or 0) and reap the slot we just took.
            ROLLBACK_START_TIME.store(
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs()).unwrap_or(0),
                Ordering::SeqCst);
        }
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
            // Previous rollback timed out — force-claim the slot. Stamp the clock in the SAME step:
            // the watchdog would otherwise read the stale timestamp and strip our fresh barrier.
            println!("[WARN][ROLLBACK] stale_slot_force_claim age_secs={}",
                     now.saturating_sub(start_time));
            ROLLBACK_IN_PROGRESS.store(true, Ordering::SeqCst);
            ROLLBACK_START_TIME.store(now, Ordering::SeqCst);
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

    // 4. Quiesce the durable-materialisation section before returning. The caller's prune scans run
    //    from-scratch over the registry, so an apply thread that claimed just before our flag must
    //    finish writing FIRST or its orphan rows survive the prune. Barred from re-claiming by the
    //    flag we just set, so this drains. Drop the finality lock first — the wait is unbounded by
    //    anything this lock protects. Timeout is advisory: the caller proceeds either way, and a
    //    timed-out drain is a stuck apply thread, which the rollback's own timeout already covers.
    drop(_guard);
    drain_materialise_inflight(2_000);

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

/// Owned, thread-movable RocksDB consistent snapshot. The held `Arc<DB>` keeps
/// the database alive for the whole life of `snap`, which is what makes the
/// 'static borrow sound. Lets a slow off-reactor snapshot serializer iterate a
/// frozen point-in-time view, immune to concurrent block application — so the
/// dump reproduces exactly the boundary state_root even as later blocks mutate
/// the live DB.
pub struct PinnedDbSnapshot {
    // SAFETY: field order is load-bearing — `snap` MUST precede `db`. Rust drops fields in declaration
    // order, so snap's Drop (release_snapshot, which derefs its lifetime-extended DB borrow) runs FIRST,
    // while this struct's own Arc<DB> clone still pins the DB alive — making the unsafe 'static extension
    // locally sound regardless of any external Arc. Do NOT reorder.
    snap: rocksdb::SnapshotWithThreadMode<'static, DB>,
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
/// Durable anti-double-sign watermark (metadata CF).
const HIGHEST_SIGNED_HEIGHT_KEY: &[u8] = b"highest_signed_microblock_height";

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

// Tiered storage architecture. QNet uses transaction/compute sharding for
// parallel processing (CPU), NOT state sharding for storage division.
// Storage is tiered by node type: Light = pure API client, no local
// storage (0 MB); Super/Bootstrap = full archival blocks, no pruning
// (~500 MB/day), serves the block/tx/balance API.

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

// LightNodeRotation — DEPRECATED, no-op. Light nodes are pure API clients
// (max_storage_bytes = 0, no local header chain); this earlier
// header-rotation buffer now runs against an empty buffer. Struct retained
// only so the Storage::light_rotation field compiles; remove both later.

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
        // -1 = keep every table reader open. A capped count evicts readers, which unpins the L0
        // filter/index blocks the block cache just paid for; reader memory is now bounded by the
        // shared cache instead of by this number.
        opts.set_max_open_files(-1);
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
        // Rarely-written CFs (failover_events, snapshots) keep stale memtables,
        // preventing WAL deletion → 463 files / 1.8GB in 23 hours.
        // With this setting, RocksDB force-flushes oldest CF memtables when
        // total WAL exceeds 64MB, enabling old WAL cleanup.
        opts.set_max_total_wal_size(67_108_864); // 64MB max WAL (was: unlimited)

        // v25.3: BOUND RocksDB's internal diagnostic LOG file.
        // Default RocksDB behaviour is a SINGLE `LOG` file that grows
        // without bound until the DB is reopened (only a node restart
        // archives it to LOG.old.<ts>). In production this was observed
        // at ~454 MB after 27 h continuous uptime (~17 MB/h ≈ 150 GB/yr
        // unbounded) on every node. This is RocksDB's own operational
        // log (compaction/flush/stats) — NOT chain data, NOT the WAL,
        // NOT consensus state — so bounding it is purely hygienic and
        // cannot affect blockchain integrity, recovery, or determinism.
        //
        // size + count bounding only: rotate the LOG at 64 MB and keep
        // at most 10 rotations → hard cap ≈ 640 MB rolling window
        // instead of one ever-growing file. Verbosity (INFO) is
        // deliberately UNCHANGED so RocksDB-internal forensics
        // (compaction stalls, write-stalls, corruption events) remain
        // fully available — we only stop the unbounded growth, we do
        // not trade away diagnostic detail.
        opts.set_max_log_file_size(67_108_864);  // 64 MB → then rotate
        opts.set_keep_log_file_num(10);          // keep ≤10 rotations (~640 MB cap)

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
        
        // ONE cache shared by every CF. Without an explicit cache each block-based factory
        // gets its own ~8MiB default LRU, and caching index+filter blocks there would thrash:
        // at 10M accounts the accounts-CF filter alone is ~12.5MB. A shared budget also means
        // hot CFs can use the space cold ones do not. It is a cap, not an allocation.
        const BLOCK_CACHE_BYTES: usize = 512 * 1024 * 1024;
        let block_cache = rocksdb::Cache::new_lru_cache(BLOCK_CACHE_BYTES);

        // Per-CF block table. Options::default() carries a DEFAULT block-based factory
        // (4KB blocks, NO bloom filter) — the DB-level block_opts above do NOT reach a CF
        // that declares its own Options, so every CF must set this explicitly or every
        // point read binary-searches each SST index at each level.
        //
        // `partitioned` splits the filter and index into cache-sized pieces plus a small top
        // level. Use it for CFs whose key count grows with the network (accounts, merkle):
        // a monolithic 30MB filter block would otherwise be evicted and re-read whole.
        let cf_block_opts = |partitioned: bool| -> rocksdb::BlockBasedOptions {
            let mut b = rocksdb::BlockBasedOptions::default();
            b.set_block_cache(&block_cache);
            b.set_block_size(16384);
            b.set_format_version(5);
            b.set_bloom_filter(10.0, false);
            b.set_cache_index_and_filter_blocks(true);
            b.set_pin_l0_filter_and_index_blocks_in_cache(true);
            if partitioned {
                b.set_index_type(rocksdb::BlockBasedIndexType::TwoLevelIndexSearch);
                b.set_partition_filters(true);
            }
            b
        };

        // v3.19: Create optimized CF options with compression
        let create_cf_opts = || -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
            cf_opts.set_write_buffer_size(8388608); // 8MB per CF
            cf_opts.set_max_write_buffer_number(2);
            cf_opts.set_target_file_size_base(16777216); // 16MB
            cf_opts.set_block_based_table_factory(&cf_block_opts(false));
            cf_opts
        };

        // v3.19: Optimized CF for hot data (microblocks, heartbeats)
        let create_hot_cf_opts = || -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
            cf_opts.set_write_buffer_size(4194304); // 4MB - very small for hot data
            cf_opts.set_max_write_buffer_number(2);
            cf_opts.set_target_file_size_base(8388608); // 8MB
            cf_opts.set_block_based_table_factory(&cf_block_opts(false));
            cf_opts
        };

        // v3.19: Optimized CF for cold data (old blocks)
        let create_cold_cf_opts = || -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Zstd); // Better compression
            cf_opts.set_write_buffer_size(16777216); // 16MB
            cf_opts.set_max_write_buffer_number(2);
            cf_opts.set_target_file_size_base(33554432); // 32MB
            cf_opts.set_block_based_table_factory(&cf_block_opts(false));
            cf_opts
        };

        // CFs whose key count grows with the network. A monolithic filter for 10M keys is ~14MB
        // and would be evicted and re-read whole; partitioning loads it in cache-sized pieces.
        let create_indexed_cf_opts = || -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
            cf_opts.set_write_buffer_size(8388608);
            cf_opts.set_max_write_buffer_number(2);
            cf_opts.set_target_file_size_base(16777216);
            cf_opts.set_block_based_table_factory(&cf_block_opts(true));
            cf_opts
        };

        // Merkle store: reads are dominated by lookups for nodes that do NOT exist
        // (empty subtrees on the descent), which is exactly what a whole-key bloom
        // filter answers without touching an SST. Fixed-width keys, no prefix domain.
        let create_merkle_cf_opts = || -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
            cf_opts.set_write_buffer_size(16777216);
            cf_opts.set_max_write_buffer_number(3);
            cf_opts.set_target_file_size_base(33554432);
            // Point reads only (fixed-width keys, no prefix domain); leaves_under range-scans
            // but a range scan never consults the filter, so whole-key filtering is the right mode.
            let mut b = cf_block_opts(true);
            b.set_whole_key_filtering(true);
            cf_opts.set_block_based_table_factory(&b);
            cf_opts
        };
        
        // ColumnFamilyDescriptor doesn't implement Clone — rebuild on each retry attempt
        let build_column_families = || -> Vec<ColumnFamilyDescriptor> {
            vec![
                ColumnFamilyDescriptor::new("blocks", create_cold_cf_opts()),
                ColumnFamilyDescriptor::new("transactions", create_indexed_cf_opts()),
                ColumnFamilyDescriptor::new("accounts", create_indexed_cf_opts()),
                ColumnFamilyDescriptor::new("metadata", create_cf_opts()),
                ColumnFamilyDescriptor::new("microblocks", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("consensus", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("sync_state", create_cf_opts()),
                // Despite the name (kept so a fresh genesis is not the only way to read old data),
                // this holds the CERTIFIED per-epoch reward roots and the sharded leaf sets — the
                // pull-claim's whole durable state. It is live; do not read the name as dead.
                ColumnFamilyDescriptor::new("pending_rewards", create_cf_opts()),
                ColumnFamilyDescriptor::new("node_registry", create_indexed_cf_opts()),
                ColumnFamilyDescriptor::new("ping_history", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("failover_events", create_cf_opts()),
                ColumnFamilyDescriptor::new("snapshots", create_cold_cf_opts()),
                ColumnFamilyDescriptor::new("tx_index", create_indexed_cf_opts()),
                ColumnFamilyDescriptor::new("tx_by_address", create_indexed_cf_opts()),
                ColumnFamilyDescriptor::new("attestations", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("heartbeats", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("contract_storage", create_indexed_cf_opts()),
                ColumnFamilyDescriptor::new("fcm_tokens", create_cf_opts()),
                // Light-node ping delegation keys (operational, non-consensus): key=node_id, value JSON
                // {ping_pubkey, ping_delegation_cert}. Read per-ping so the hot crypto stays off the RAM registry.
                ColumnFamilyDescriptor::new("light_ping_keys", create_cf_opts()),
                // Cold-join staging: a downloaded snapshot is restored HERE, verified, then
                // promoted into the live state CFs. Live state is never mutated before the
                // consensus binding passes, so a rejected snapshot leaves no orphaned state.
                ColumnFamilyDescriptor::new("accounts_stage", create_cf_opts()),
                ColumnFamilyDescriptor::new("node_registry_stage", create_cf_opts()),
                ColumnFamilyDescriptor::new("pending_rewards_stage", create_cf_opts()),
                ColumnFamilyDescriptor::new("contract_storage_stage", create_cf_opts()),
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
                // Persistent Merkle store (always on): the committed node/leaf set lives
                // in RocksDB, the in-RAM maps are bounded read-through caches.
                // Leaf key = raw 32-byte addr_hash; node key = 4-byte BE depth ++ 32-byte key.
                ColumnFamilyDescriptor::new("merkle_leaves", create_merkle_cf_opts()),
                ColumnFamilyDescriptor::new("merkle_nodes", create_merkle_cf_opts()),
                // Wallet→token reverse index (NON-consensus): key `owns_{wallet}_{contract}` marks a
                // live QRC-20 holding, maintained at apply from 0↔nonzero balance transitions. Turns the
                // per-wallet token list from an O(N)-accounts scan into an O(held) prefix seek at scale.
                ColumnFamilyDescriptor::new("wallet_token", create_indexed_cf_opts()),
                // Per-epoch reward aggregation scratch: written once per eligible node, scanned
                // once in wallet order, then range-deleted. Keeps the 10M-recipient root build
                // O(shard) in RAM instead of materialising the whole leaf set.
                ColumnFamilyDescriptor::new("reward_agg", create_cf_opts()),
            ]
        };

        // Downgrade-safe open: rocksdb requires EVERY existing CF to be declared, so an older binary
        // opening a DB a newer binary extended would otherwise fail to start. Union our known CFs
        // with any extra ones already on disk (opened with generic opts). Forward (missing CF) is
        // covered by create_missing_column_families; this covers the reverse. Keep list in sync with
        // build_column_families() above.
        const KNOWN_CF_NAMES: &[&str] = &[
            "blocks", "transactions", "accounts", "metadata", "microblocks", "consensus",
            "sync_state", "pending_rewards", "node_registry", "ping_history", "failover_events",
            "snapshots", "tx_index", "tx_by_address", "attestations", "heartbeats",
            "contract_storage", "fcm_tokens", "light_ping_keys", "mempool", "cross_shard_pending", "cross_shard_receipts",
            "accounts_stage", "node_registry_stage", "pending_rewards_stage", "contract_storage_stage",
            "merkle_leaves", "merkle_nodes", "wallet_token", "reward_agg",
        ];
        let open_descriptors = || -> Vec<ColumnFamilyDescriptor> {
            let mut cfs = build_column_families();
            if let Ok(existing) = DB::list_cf(&Options::default(), path) {
                for name in existing {
                    if name != "default" && !KNOWN_CF_NAMES.contains(&name.as_str()) {
                        eprintln!("[WARN][STORAGE] opening unknown CF '{}' (newer-binary DB → downgrade-safe)", name);
                        cfs.push(ColumnFamilyDescriptor::new(&name, create_cf_opts()));
                    }
                }
            }
            cfs
        };

        // RETRY: survive stale LOCK file after fast Docker restart.
        // Previous process may not have released the lock yet.
        let db = {
            let mut last_err = String::new();
            let mut opened = None;
            for attempt in 1u32..=10 {
                match DB::open_cf_descriptors(&opts, path, open_descriptors()) {
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
        
        let store = Self { db: Arc::new(db) };
        store.enforce_storage_format()?;
        Ok(store)
    }

    /// Refuse to open a database written by an incompatible layout. The key format, the block
    /// structs and the macroblock preimage all changed; there is no backfill for the hash-addressed
    /// index, so opening old data would not fail — it would silently mis-read the chain. Failing
    /// loudly at startup turns "remember to wipe" from a convention into a checked precondition.
    fn enforce_storage_format(&self) -> IntegrationResult<()> {
        const FORMAT_KEY: &[u8] = b"storage_format_version";
        const FORMAT_VERSION: u64 = 2; // 2 = zero-padded keys + hash-addressed index, PoH removed

        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let stored = self.db.get_cf(&metadata_cf, FORMAT_KEY)?
            .filter(|v| v.len() == 8)
            .map(|v| { let mut b = [0u8; 8]; b.copy_from_slice(&v[..8]); u64::from_be_bytes(b) });

        match stored {
            Some(v) if v == FORMAT_VERSION => Ok(()),
            Some(v) => {
                eprintln!("[CRIT][STORAGE] incompatible_format stored={} expected={} action=wipe_data_dir_required",
                          v, FORMAT_VERSION);
                Err(IntegrationError::StorageError(format!(
                    "storage format {} cannot be read by this build (expects {}) — wipe the data directory",
                    v, FORMAT_VERSION
                )))
            }
            None => {
                // No marker: either a fresh directory, or one written before versioning existed.
                // A populated unversioned store is pre-format data and must not be opened.
                let has_blocks = self.db.get_cf(&metadata_cf, b"chain_height")?.is_some();
                if has_blocks {
                    eprintln!("[CRIT][STORAGE] unversioned_populated_store action=wipe_data_dir_required");
                    return Err(IntegrationError::StorageError(
                        "existing chain data predates the current storage format — wipe the data directory".to_string()
                    ));
                }
                self.db.put_cf(&metadata_cf, FORMAT_KEY, &FORMAT_VERSION.to_be_bytes())?;
                Ok(())
            }
        }
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
    /// fresh peers, and (c) participate in Checkpoint-BFT consensus — all while
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

                // INDEX: address -> tx_hash for account transaction queries.
                // Key format: addr_{address}_{height:016x}_{tx_hash}. HEIGHT, not tx.timestamp: the
                // sender picks the timestamp, and the retention scan cuts on this field — a row
                // stamped in the future was unprunable forever. Height is also the true inclusion
                // order, so the prefix scan stays chronological.
                let stamp = block.height;
                let from_key = format!("addr_{}_{:016x}_{}", tx.from, stamp, tx.hash);
                batch.put_cf(&tx_by_addr_cf, from_key.as_bytes(), tx.hash.as_bytes());

                if let Some(ref to) = tx.to {
                    let to_key = format!("addr_{}_{:016x}_{}", to, stamp, tx.hash);
                    batch.put_cf(&tx_by_addr_cf, to_key.as_bytes(), tx.hash.as_bytes());
                }
                // QRC-20/721 counterparties are indexed from the success-gated transfer EVENTS
                // (build_token_transfer_rows), not from calldata intent — see the token_transfers index.
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
            if is_debug() {
                println!("[DBG][STORAGE] no_continuous_from_h={} scanning_for_first_block", metadata_height);
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
            // Must match the writer's key format exactly — an unpadded probe finds nothing and the
            // continuous-height scan silently reports zero blocks (chain-height auto-repair dead).
            key_buffer.push_str(&mb_body_key(h));

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
        
        // Every CF, including the ephemeral and staging ones: WAL is reclaimable only once ALL of
        // them have flushed past it.
        let cf_names = ALL_CF_NAMES;
        
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

    /// WAL-maintenance flush for the periodic task: set_wait(false) skips the trailing
    /// wait-for-flush-complete so the common case returns immediately after scheduling each CF's
    /// memtable flush (WAL reclamation is preserved). NOTE: this is NOT a hard non-blocking
    /// guarantee — RocksDB still applies WaitUntilFlushWouldNotStallWrites before the flush, so
    /// under an L0/immutable-memtable backlog the call CAN briefly block. It is therefore safe ONLY
    /// off the consensus runtime (the periodic caller dispatches it via spawn_blocking); NEVER call
    /// it on a runtime worker. flush_all (set_wait(true)) stays for shutdown/OOM, where durability
    /// must complete before exit.
    pub fn flush_all_background(&self) -> IntegrationResult<()> {
        use rocksdb::FlushOptions;

        let mut flush_opts = FlushOptions::default();
        flush_opts.set_wait(false); // skip wait-for-complete (may still briefly stall under L0 backlog)

        let cf_names = ALL_CF_NAMES;

        for cf_name in &cf_names {
            if let Some(cf) = self.db.cf_handle(cf_name) {
                if let Err(e) = self.db.flush_cf_opt(&cf, &flush_opts) {
                    if crate::node::is_warn() {
                        println!("[WARN][STORAGE] flush_cf_bg_failed cf={} err={}", cf_name, e);
                    }
                }
            }
        }
        if let Err(e) = self.db.flush_opt(&flush_opts) {
            if crate::node::is_warn() {
                println!("[WARN][STORAGE] flush_default_bg_failed err={}", e);
            }
        }
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // v3.19: PRUNING - Remove old data to save disk space
    // ═══════════════════════════════════════════════════════════════════════════
    
    
    /// v3.19 / v3.41: Compact all column families to reclaim disk space
    /// CRITICAL: Without compaction after delete operations, RocksDB marks
    /// keys as tombstones but doesn't physically reclaim disk space until
    /// compaction runs. This must be called after cleanup operations.
    pub fn compact_cfs(&self, cf_names: &[&str]) -> IntegrationResult<()> {
        for cf_name in cf_names {
            if let Some(cf) = self.db.cf_handle(cf_name) {
                self.db.compact_range_cf(&cf, None::<&[u8]>, None::<&[u8]>);
            }
        }
        if crate::node::is_info() {
            println!("[INFO][STORAGE] compaction_triggered cfs={} names={}",
                     cf_names.len(), cf_names.join(","));
        }
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

    // v15.9 Stage-1: write-through account persistence. After a block is
    // verified/saved/height-advanced, mirror every account it mutated (set
    // from the BlockSnapshot journal; post-image re-read from the in-memory
    // accounts DashMap) into the accounts CF. Stage 1 = durability without a
    // RAM bound (Stage 2 = LRU+CF): the CF becomes the canonical durable
    // state so a crash rebuilds from CF + surviving microblocks, not a
    // genesis replay. One WriteBatch/block → block-atomic (all-or-none).
    // Runs on spawn_blocking so the reactor never stalls on compaction
    // (~15 KB/block). Contract storage → its own CF (small account rows).
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

    // Sync best-effort batch write to the accounts CF. Called by the cache
    // eviction sweep (persist-before-evict) so an unpersisted cold mutation
    // is never lost. Same key/value layout as persist_accounts_batch; one
    // atomic WriteBatch.
    pub fn persist_accounts_sync(&self, accounts: &[(String, qnet_state::Account)]) -> IntegrationResult<usize> {
        if accounts.is_empty() { return Ok(0); }
        let accounts_cf = self.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut batch = WriteBatch::default();
        for (addr, account) in accounts {
            let bytes = bincode::serialize(account)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            batch.put_cf(&accounts_cf, addr.as_bytes(), &bytes);
        }
        self.db.write(batch)?;
        Ok(accounts.len())
    }

    // ── Wallet→token reverse index (wallet_token CF, NON-consensus) ──
    // Key `owns|{wallet}|{contract}` (the `|` separator never occurs in an address, so a shorter
    // wallet can't prefix-alias a longer one). Value is a single marker byte. Maintained at apply
    // from QRC-20 0↔nonzero transitions; a stale/missing entry self-heals via backfill_owns_indices.
    fn owns_key(wallet: &str, contract: &str) -> Vec<u8> {
        format!("owns|{}|{}", wallet, contract).into_bytes()
    }
    fn owns_prefix(wallet: &str) -> Vec<u8> {
        format!("owns|{}|", wallet).into_bytes()
    }

    /// A holder is indexable only if its address cannot alias another wallet's key prefix — i.e. it
    /// contains no `|` separator. `to`/holder is attacker-controlled (never format-validated at the
    /// QRC-20 credit arms), so this makes the owns key collision-free BY CONSTRUCTION rather than by
    /// the (false) assumption that `|` never appears in an address. Belt to the reader's live-balance
    /// recheck; a junk holder is simply never indexed under a real wallet's prefix.
    #[inline]
    pub(crate) fn owns_indexable(holder: &str) -> bool { !holder.contains('|') }

    /// The wallet_token keys for every LIVE (nonzero-balance) indexable holder of `contract` in
    /// `storage`. Single source of truth for "which holders does this contract's storage imply",
    /// shared by the boot/snapshot backfill and the reorg resync so the two index populations can
    /// never diverge on the type gate, the zero-detection, or the holder filter. Empty for non-QRC-20.
    pub(crate) fn owns_keys_for_contract(contract: &str, storage: &std::collections::HashMap<String, String>) -> Vec<Vec<u8>> {
        if storage.get("type").map(|t| t != "qrc20").unwrap_or(true) { return Vec::new(); }
        let mut out = Vec::new();
        for (skey, sval) in storage {
            if let Some(holder) = skey.strip_prefix("balance:") {
                if sval.trim() != "0" && !sval.trim().is_empty() && Self::owns_indexable(holder) {
                    out.push(Self::owns_key(holder, contract));
                }
            }
        }
        out
    }

    /// Write pre-derived owns keys in bounded chunks (one WriteBatch per 10k puts) so a full-index
    /// rebuild never materialises one giant batch. Returns keys written.
    pub(crate) fn write_owns_keys_batched(&self, keys: &[Vec<u8>]) -> IntegrationResult<usize> {
        if keys.is_empty() { return Ok(0); }
        let cf = self.db.cf_handle("wallet_token")
            .ok_or_else(|| IntegrationError::StorageError("wallet_token column family not found".to_string()))?;
        for chunk in keys.chunks(10_000) {
            let mut batch = WriteBatch::default();
            for key in chunk { batch.put_cf(&cf, key, &[1u8]); }
            self.db.write(batch)?;
        }
        Ok(keys.len())
    }

    /// Apply this block's Set/Clear owns-deltas AND advance the durable owns-watermark in ONE atomic
    /// cross-CF batch. The watermark = highest height whose owns-deltas are durable; boot compares it to
    /// the tip to skip the full rebuild when the index is already current (deltas empty → watermark-only).
    pub fn persist_owns_deltas(&self, deltas: &[qnet_state::OwnsDelta], height: u64) -> IntegrationResult<()> {
        let cf = self.db.cf_handle("wallet_token")
            .ok_or_else(|| IntegrationError::StorageError("wallet_token column family not found".to_string()))?;
        let meta = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut batch = WriteBatch::default();
        for d in deltas {
            match d {
                // Skip a holder whose address could alias another wallet's key prefix (contains `|`).
                // Same collision-safe filter as the backfill/resync helper — an unvalidated `to` can
                // never plant a junk key under a real wallet's prefix. Clear of such a key is a no-op.
                qnet_state::OwnsDelta::Set { wallet, contract } => {
                    if Self::owns_indexable(wallet) {
                        batch.put_cf(&cf, Self::owns_key(wallet, contract), &[1u8]);
                    }
                }
                qnet_state::OwnsDelta::Clear { wallet, contract } => {
                    if Self::owns_indexable(wallet) {
                        batch.delete_cf(&cf, Self::owns_key(wallet, contract));
                    }
                }
            }
        }
        batch.put_cf(&meta, b"meta_owns_watermark", &height.to_le_bytes());
        self.db.write(batch)?;
        Ok(())
    }

    /// Contracts for which `wallet` holds a live (nonzero) QRC-20 balance. O(held) prefix seek.
    pub fn get_tokens_for_wallet(&self, wallet: &str) -> IntegrationResult<Vec<String>> {
        let cf = self.db.cf_handle("wallet_token")
            .ok_or_else(|| IntegrationError::StorageError("wallet_token column family not found".to_string()))?;
        let prefix = Self::owns_prefix(wallet);
        let mut out = Vec::new();
        let iter = self.db.iterator_cf(&cf, rocksdb::IteratorMode::From(&prefix, rocksdb::Direction::Forward));
        for item in iter {
            let (key, _) = item.map_err(|e| IntegrationError::StorageError(e.to_string()))?;
            if !key.starts_with(&prefix) { break; }
            if let Ok(contract) = std::str::from_utf8(&key[prefix.len()..]) {
                out.push(contract.to_string());
            }
        }
        Ok(out)
    }

    /// One-time reconciliation: rebuild the wallet_token index from the authoritative accounts CF
    /// (every contract's `balance:{holder}` entry with a nonzero value). Idempotent; run at boot and
    /// after a snapshot apply so the O(1) reader is complete even for pre-index or externally-written
    /// (e.g. WASM) balances. O(contract storage entries) — bounded by live holders, run off the hot path.
    pub fn backfill_owns_indices(&self) -> IntegrationResult<usize> {
        let accounts_cf = self.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let wt_cf = self.db.cf_handle("wallet_token")
            .ok_or_else(|| IntegrationError::StorageError("wallet_token column family not found".to_string()))?;
        let mut batch = WriteBatch::default();
        let mut in_batch = 0usize;
        let mut written = 0usize;
        let iter = self.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, val) = item.map_err(|e| IntegrationError::StorageError(e.to_string()))?;
            let contract = match std::str::from_utf8(&key) { Ok(s) => s.to_string(), Err(_) => continue };
            let account: qnet_state::Account = match bincode::deserialize(&val) { Ok(a) => a, Err(_) => continue };
            if account.contract_storage.is_empty() { continue; }
            // Single source of truth for the type gate + live-holder + collision-safe filter (shared with
            // resync_owns_for_contract), so a WASM contract's `balance:{}` key is never a phantom token
            // and the boot/reorg index populations cannot drift apart.
            for key in Self::owns_keys_for_contract(&contract, &account.contract_storage) {
                batch.put_cf(&wt_cf, key, &[1u8]);
                in_batch += 1;
                written += 1;
                // Bounded chunks: a millions-of-holders rebuild never holds one giant batch in RAM.
                if in_batch >= 10_000 {
                    self.db.write(std::mem::take(&mut batch))?;
                    in_batch = 0;
                }
            }
        }
        if in_batch > 0 { self.db.write(batch)?; }
        // Index is now complete → readers may treat an empty per-wallet result as authoritative.
        OWNS_INDEX_READY.store(true, Ordering::Relaxed);
        Ok(written)
    }

    /// Re-derive the wallet_token entries for ONE contract from an authoritative `contract_storage`
    /// (the reorg-restored pre-image). Used on rollback: the owns-delta persist is a non-consensus
    /// background write that is NOT rolled back, so a `Clear` flushed for a balance the reorg then
    /// restores would leave the pair missing → the reader under-reports it. Re-adding every present
    /// holder heals that; stale entries left behind are balance-rechecked away by the reader. Bounded
    /// by this contract's holders. No-op for non-QRC-20 (same type gate as emission/backfill/reader).
    pub fn resync_owns_for_contract(&self, contract: &str, contract_storage: &std::collections::HashMap<String, String>) -> IntegrationResult<()> {
        let keys = Self::owns_keys_for_contract(contract, contract_storage);
        if keys.is_empty() { return Ok(()); }
        let cf = self.db.cf_handle("wallet_token")
            .ok_or_else(|| IntegrationError::StorageError("wallet_token column family not found".to_string()))?;
        let mut batch = WriteBatch::default();
        for key in keys { batch.put_cf(&cf, key, &[1u8]); }
        self.db.write(batch)?;
        Ok(())
    }

    // GALC held-capsule persistence (metadata CF). Tiny self-authenticating object; re-verified against
    // the embedded genesis keys on reload, so a tampered/stale on-disk value cannot poison the root.
    pub fn put_galc_held(&self, bytes: &[u8]) -> IntegrationResult<()> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.db.put_cf(&cf, b"galc_held", bytes)?;
        Ok(())
    }
    pub fn get_galc_held(&self) -> IntegrationResult<Option<Vec<u8>>> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        Ok(self.db.get_cf(&cf, b"galc_held")?)
    }
    // Adopted cold-join snapshot anchor (anchor_mb u64 LE ++ anchor hash [u8;32]) — persisted so a
    // warm-restarted joiner reloads its trusted floor (the SNAPSHOT_ANCHOR_MB static resets on restart).
    pub fn put_snapshot_anchor(&self, bytes: &[u8]) -> IntegrationResult<()> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.db.put_cf(&cf, b"snapshot_anchor", bytes)?;
        Ok(())
    }
    pub fn get_snapshot_anchor(&self) -> IntegrationResult<Option<Vec<u8>>> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        Ok(self.db.get_cf(&cf, b"snapshot_anchor")?)
    }

    // Checkpoint-BFT vote commitments (metadata CF, key `cpv_<index BE>`). A vote is a commitment,
    // not a cache: the engine refuses a second vote at one index/head, and peers CONVICT that pair,
    // so a commitment lost across a restart is a ban. Written with sync=true BEFORE the vote is
    // signed and broadcast, and pruned below the retention window — a head under the committed
    // frontier can never be proposed again, so forgetting it refuses nothing that could recur.
    // One record per checkpoint index (~one per CHECKPOINT_INTERVAL blocks), so the sync write is
    // per-minute, not per-block.
    pub fn record_checkpoint_vote(&self, index: u64, window_head: u64, content_digest: &[u8; 32],
                                  pinned: bool, parent_index: u64, parent_hash: &[u8; 32])
        -> IntegrationResult<()> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut val = Vec::with_capacity(81);
        val.extend_from_slice(&window_head.to_be_bytes());
        val.extend_from_slice(content_digest);
        val.push(pinned as u8);
        val.extend_from_slice(&parent_index.to_be_bytes());
        val.extend_from_slice(parent_hash);
        let mut wopts = rocksdb::WriteOptions::default();
        wopts.set_sync(true);
        self.db.put_cf_opt(&cf, checkpoint_vote_key(index), &val, &wopts)?;
        let floor = index.saturating_sub(qnet_consensus::checkpoint_bft::CONSENSUS_STATE_RETAIN);
        if floor > 0 {
            let mut batch = WriteBatch::default();
            for (k, _) in self.iter_checkpoint_votes(&cf)?.into_iter().filter(|(i, _)| *i < floor) {
                batch.delete_cf(&cf, checkpoint_vote_key(k));
            }
            self.db.write(batch)?;
        }
        Ok(())
    }

    /// Every stored vote commitment: `(index, window_head, content_digest, pinned, parent_index,
    /// parent_hash)`. An Err here means the node cannot know what it already voted for — the caller
    /// must refuse to run consensus rather than vote blind.
    pub fn load_checkpoint_votes(&self)
        -> IntegrationResult<Vec<(u64, u64, [u8; 32], bool, u64, [u8; 32])>> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        Ok(self.iter_checkpoint_votes(&cf)?.into_iter().map(|(i, v)| (i, v.0, v.1, v.2, v.3, v.4)).collect())
    }

    fn iter_checkpoint_votes(&self, cf: &impl rocksdb::AsColumnFamilyRef)
        -> IntegrationResult<Vec<(u64, (u64, [u8; 32], bool, u64, [u8; 32]))>> {
        const P: &[u8] = b"cpv_";
        let mut out = Vec::new();
        let iter = self.db.iterator_cf(cf, rocksdb::IteratorMode::From(P, rocksdb::Direction::Forward));
        for item in iter {
            let (k, v) = item?;
            if !k.starts_with(P) { break; }
            if k.len() != P.len() + 8 || v.len() != 81 { continue; }
            let mut idx = [0u8; 8]; idx.copy_from_slice(&k[P.len()..]);
            let mut head = [0u8; 8]; head.copy_from_slice(&v[0..8]);
            let mut digest = [0u8; 32]; digest.copy_from_slice(&v[8..40]);
            let mut pi = [0u8; 8]; pi.copy_from_slice(&v[41..49]);
            let mut ph = [0u8; 32]; ph.copy_from_slice(&v[49..81]);
            out.push((u64::from_be_bytes(idx),
                      (u64::from_be_bytes(head), digest, v[40] != 0, u64::from_be_bytes(pi), ph)));
        }
        Ok(out)
    }

    // (sync, called at a macroblock boundary under the apply context) Flush the
    // hot in-memory account set to the accounts CF, then pin a consistent
    // point-in-time DB view. With persist-before-evict keeping cold accounts in
    // the CF, the pinned view holds the COMPLETE committed tree leaf set at this
    // height; freezing it lets the off-reactor serializer reproduce state_root@H
    // even as H+1.. mutate the live DB.
    pub fn prepare_snapshot_view(
        &self,
        hot_accounts: &[(String, qnet_state::Account)],
    ) -> IntegrationResult<PinnedDbSnapshot> {
        self.persist_accounts_sync(hot_accounts)?;
        let snap = self.db.snapshot();
        // SAFETY: lifetime-extend the snapshot borrow to 'static. PinnedDbSnapshot
        // stores the same Arc<DB>, which outlives `snap`, so the underlying handle
        // is always valid; only the (runtime-erased) lifetime changes — layout-identical.
        let snap: rocksdb::SnapshotWithThreadMode<'static, DB> =
            unsafe { std::mem::transmute(snap) };
        Ok(PinnedDbSnapshot { db: self.db.clone(), snap })
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
        
        let key = mb_body_key(height);
        
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
        let hash_key = mb_hash_key(height);
        // v12.1: Format discriminator — 0x01 = MicroBlock (full format)
        let fmt_key = mb_fmt_key(height);

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
                            println!("[INFO][STORAGE] device_signature_changed reason=migration_or_new_hardware stored={}... current={}...", qnet_state::char_prefix(&stored_device_signature, 8), qnet_state::char_prefix(&current_device, 8));
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
        println!("[INFO][STORAGE] burn_tx_saved tx={}...", qnet_state::char_prefix(&burn_tx, 8));
        Ok(())
    }

    // ========================================================================
    // PERMANENT ATTACKER PK BLACKLIST (durable mirror)
    // ========================================================================
    // Canonical in-memory state lives in `qnet_consensus::consensus_crypto`.
    // The methods below mirror that state into the `metadata` column family
    // so a known attacker keypair cannot regain a transient verification
    // budget by racing the boot window after a restart.
    //
    // Layout (one key per attacker PK fingerprint):
    //   key = b"attacker_pk_bl/" || sha3_256(attacker_pk)        (47 bytes)
    //   val = first_seen_unix_s(8 LE) || last_seen_unix_s(8 LE)
    //       || offense_count(4 LE) || last_node_id_len(2 LE)
    //       || last_node_id(utf8)                                (≤ 122 bytes)
    //
    // Fixed-prefix scan recovers the full set with one iterator pass at
    // boot. No external schema dependency — values are self-describing
    // length-prefixed records.

    const ATTACKER_PK_KEY_PREFIX: &'static [u8] = b"attacker_pk_bl/";

    fn encode_attacker_pk_value(rec: &qnet_consensus::consensus_crypto::AttackerRecord) -> Vec<u8> {
        let node_id_bytes = rec.last_claimed_node_id.as_bytes();
        let node_id_len = node_id_bytes.len().min(u16::MAX as usize) as u16;
        let mut buf = Vec::with_capacity(8 + 8 + 4 + 2 + node_id_len as usize);
        buf.extend_from_slice(&rec.first_seen_unix_s.to_le_bytes());
        buf.extend_from_slice(&rec.last_seen_unix_s.to_le_bytes());
        buf.extend_from_slice(&rec.offense_count.to_le_bytes());
        buf.extend_from_slice(&node_id_len.to_le_bytes());
        buf.extend_from_slice(&node_id_bytes[..node_id_len as usize]);
        buf
    }

    fn decode_attacker_pk_value(
        data: &[u8],
    ) -> Option<qnet_consensus::consensus_crypto::AttackerRecord> {
        if data.len() < 8 + 8 + 4 + 2 {
            return None;
        }
        let mut o = 0;
        let mut u8x8 = [0u8; 8];
        u8x8.copy_from_slice(&data[o..o + 8]);
        let first_seen_unix_s = u64::from_le_bytes(u8x8);
        o += 8;
        u8x8.copy_from_slice(&data[o..o + 8]);
        let last_seen_unix_s = u64::from_le_bytes(u8x8);
        o += 8;
        let mut u8x4 = [0u8; 4];
        u8x4.copy_from_slice(&data[o..o + 4]);
        let offense_count = u32::from_le_bytes(u8x4);
        o += 4;
        let mut u8x2 = [0u8; 2];
        u8x2.copy_from_slice(&data[o..o + 2]);
        let node_id_len = u16::from_le_bytes(u8x2) as usize;
        o += 2;
        if data.len() < o + node_id_len {
            return None;
        }
        let last_claimed_node_id = String::from_utf8_lossy(&data[o..o + node_id_len]).to_string();
        Some(qnet_consensus::consensus_crypto::AttackerRecord {
            first_seen_unix_s,
            last_seen_unix_s,
            offense_count,
            last_claimed_node_id,
        })
    }

    /// Persist one attacker-PK blacklist entry. Idempotent overwrite —
    /// the canonical layer guarantees that on re-insert the record is
    /// the post-update state, so writing it unconditionally keeps the
    /// durable row in sync with the in-memory truth.
    pub fn save_attacker_pk_entry(
        &self,
        fingerprint: &[u8; 32],
        record: &qnet_consensus::consensus_crypto::AttackerRecord,
    ) -> IntegrationResult<()> {
        let metadata_cf = self
            .db
            .cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut key = Vec::with_capacity(Self::ATTACKER_PK_KEY_PREFIX.len() + 32);
        key.extend_from_slice(Self::ATTACKER_PK_KEY_PREFIX);
        key.extend_from_slice(fingerprint);
        let value = Self::encode_attacker_pk_value(record);
        self.db.put_cf(&metadata_cf, &key, &value)?;
        Ok(())
    }

    /// Load every persisted attacker-PK blacklist entry. One iterator
    /// pass over the fixed-prefix range — called exactly once at boot.
    /// Malformed rows (e.g. legacy schema, truncated value) are skipped
    /// with a `[WARN][SECURITY]` log so they don't break the seed
    /// replay; the in-memory layer simply forgets them, which is safe
    /// because the Tier-2 verifier will re-record any still-active
    /// attacker on its next connection attempt.
    pub fn load_all_attacker_pk_entries(
        &self,
    ) -> IntegrationResult<Vec<([u8; 32], qnet_consensus::consensus_crypto::AttackerRecord)>>
    {
        use rocksdb::{IteratorMode, Direction};
        let metadata_cf = self
            .db
            .cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut out: Vec<([u8; 32], qnet_consensus::consensus_crypto::AttackerRecord)> = Vec::new();
        let prefix = Self::ATTACKER_PK_KEY_PREFIX;
        let iter = self
            .db
            .iterator_cf(&metadata_cf, IteratorMode::From(prefix, Direction::Forward));
        let mut malformed: u64 = 0;
        for item in iter {
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(_) => continue,
            };
            if !k.starts_with(prefix) {
                break; // left the prefix range
            }
            if k.len() != prefix.len() + 32 {
                malformed += 1;
                continue;
            }
            let mut fp = [0u8; 32];
            fp.copy_from_slice(&k[prefix.len()..]);
            match Self::decode_attacker_pk_value(&v) {
                Some(rec) => out.push((fp, rec)),
                None => malformed += 1,
            }
        }
        if malformed > 0 {
            println!(
                "[WARN][SECURITY] attacker_pk_blacklist_load malformed={} loaded={} action=skip_malformed",
                malformed,
                out.len(),
            );
        }
        Ok(out)
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
        
        println!("[INFO][STORAGE] activation_migrated device={}... cipher=AES-256-GCM", qnet_state::char_prefix(&new_device_signature, 16));
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
    
    /// Get server IP (informational tracking field only, not node identity).
    /// Trust only the operator-supplied endpoint; never ingest an unvalidated
    /// external string (removed the curl-to-third-party shell-out: no timeout,
    /// no format check, hangs boot, lets a network attacker inject any string).
    fn get_server_ip() -> String {
        for var in ["QNET_EXTERNAL_IP", "QNET_PUBLIC_IP"] {
            if let Ok(raw) = std::env::var(var) {
                let candidate = raw.trim();
                // Strict IP-format validation before accepting into the record.
                if candidate.parse::<std::net::IpAddr>().is_ok() {
                    return candidate.to_string();
                }
                if !candidate.is_empty() {
                    println!("[WARN][STORAGE] server_ip_invalid var={} value_len={}", var, candidate.len());
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

        let key = mb_body_key(height);
        match self.db.get_cf(&microblocks_cf, key.as_bytes())? {
            Some(data) => Ok(Some(data)),
            None => Ok(None),
        }
    }

    /// Highest microblock height this node has ever SIGNED as producer. Monotone and durable: it is
    /// the only thing standing between a rollback-then-re-produce and a permanent, chain-committed
    /// equivocation ban, which neither fork-choice nor certification can undo. Written with fsync
    /// BEFORE the signature is produced, so a crash in between costs one skipped slot rather than a
    /// second signature at a height.
    pub fn save_highest_signed_height(&self, height: u64) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut opts = rocksdb::WriteOptions::default();
        opts.set_sync(true);
        self.db.put_cf_opt(&metadata_cf, HIGHEST_SIGNED_HEIGHT_KEY, &height.to_be_bytes(), &opts)?;
        Ok(())
    }

    /// Reads the durable anti-double-sign watermark. None means this node has never produced.
    pub fn load_highest_signed_height(&self) -> IntegrationResult<Option<u64>> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        match self.db.get_cf(&metadata_cf, HIGHEST_SIGNED_HEIGHT_KEY)? {
            Some(data) if data.len() == 8 => {
                let mut b = [0u8; 8];
                b.copy_from_slice(&data);
                Ok(Some(u64::from_be_bytes(b)))
            }
            _ => Ok(None),
        }
    }

    /// v10.2: O(1) microblock hash lookup from index.
    /// Returns SHA3-256 hash of stored block data without loading the full block.
    /// Used for prev_hash validation — eliminates O(block_size) load+hash overhead.
    pub fn load_microblock_hash(&self, height: u64) -> IntegrationResult<Option<[u8; 32]>> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let hash_key = mb_hash_key(height);
        match self.db.get_cf(&metadata_cf, hash_key.as_bytes())? {
            Some(data) if data.len() == 32 => {
                let mut hash = [0u8; 32];
                hash.copy_from_slice(&data);
                return Ok(Some(hash));
            }
            Some(data) => {
                eprintln!("[ERR][STORAGE] invalid_hash_index_len h={} len={} — rebuilding", height, data.len());
                // fall through to backfill (corrupt index → rebuild from the stored block)
            }
            None => { /* fall through to backfill */ }
        }

        // BACKFILL ON READ — the promise save_microblock makes ("will be backfilled
        // on read") but never kept until now. The hash index can be absent for a block
        // that IS fully stored: a save path whose wire format the save-time
        // MicroBlock-only hash extractor couldn't decode (→ hash_index_skip), a
        // delete+re-sync, or a DA-repaired microblock. Without backfill, load returns
        // None for a present block, and the macroblock window-content check counts it
        // "missing" → the proposer refuses to sign the checkpoint → 2f+1 unreachable →
        // finality freezes the ENTIRE chain (observed: mb16 stuck, all nodes at
        // finalized=mb15 while the blocks were on disk the whole time).
        // build_microblock_hash_index decodes BOTH MicroBlock and EfficientMicroBlock
        // and writes the index. A genuinely-absent block → false → None → DA-repair.
        if self.build_microblock_hash_index(height).unwrap_or(false) {
            if let Some(data) = self.db.get_cf(&metadata_cf, hash_key.as_bytes())? {
                if data.len() == 32 {
                    let mut hash = [0u8; 32];
                    hash.copy_from_slice(&data);
                    return Ok(Some(hash));
                }
            }
        }
        Ok(None)
    }

    /// v12.0: Build hash index entry for a single block (used by migration).
    /// Deserializes block, computes consensus hash via MicroBlock::hash(), stores in metadata CF.
    /// Block hash = SHA3(height + timestamp + prev_hash + merkle_root + producer) — consensus property.
    pub fn build_microblock_hash_index(&self, height: u64) -> IntegrationResult<bool> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks CF not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;

        let block_key = mb_body_key(height);
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
                let hash_key = mb_hash_key(height);
                self.db.put_cf(&metadata_cf, hash_key.as_bytes(), &block_hash)?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Delete a microblock at the specified height (for fork resolution)
    /// v10.2: Also removes hash index entry to keep index consistent
    pub fn delete_microblock(&self, height: u64) -> IntegrationResult<()> {
        note_body_delete(height);
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let key = mb_body_key(height);
        let hash_key = mb_hash_key(height);

        let mut batch = WriteBatch::default();
        // Every index entry describing this block goes with it. The header, or a child link still
        // naming it as a parent, would otherwise keep answering for a block that no longer exists:
        // the header makes an orphan resolvable again, and a stale child link makes the branch walk
        // see a phantom successor it can never load.
        if let Ok(Some(existing)) = self.load_microblock_hash(height) {
            if let Some(prev) = self.header_index(&existing).map(|h| h.previous_hash) {
                batch.delete_cf(&metadata_cf, &block_child_key(&prev, &existing));
            }
            batch.delete_cf(&metadata_cf, &block_header_key(&existing));
        }
        batch.delete_cf(&microblocks_cf, key.as_bytes());
        batch.delete_cf(&metadata_cf, hash_key.as_bytes());
        self.db.write(batch)?;

        Ok(())
    }

    /// Header index lookup at the persistent layer (the tiered wrapper exposes `header_by_hash`).
    pub(crate) fn header_index(&self, hash: &[u8; 32]) -> Option<BlockHeaderIdx> {
        let metadata_cf = self.db.cf_handle("metadata")?;
        let raw = self.db.get_cf(&metadata_cf, &block_header_key(hash)).ok()??;
        bincode::deserialize::<BlockHeaderIdx>(&raw).ok()
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
            note_body_delete(h);
            let key = mb_body_key(h);
            let hash_key = mb_hash_key(h);
            // Header and child link must go with the body — see delete_microblock.
            if let Ok(Some(existing)) = self.load_microblock_hash(h) {
                if let Some(prev) = self.header_index(&existing).map(|hd| hd.previous_hash) {
                    batch.delete_cf(&metadata_cf, &block_child_key(&prev, &existing));
                }
                batch.delete_cf(&metadata_cf, &block_header_key(&existing));
            }
            batch.delete_cf(&microblocks_cf, key.as_bytes());
            batch.delete_cf(&metadata_cf, hash_key.as_bytes());
            count += 1;
        }
        self.db.write(batch)?;
        Ok(count)
    }
    
    /// Hash of the most recently sealed macroblock.
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
    /// Macroblocks carry the full ConsensusData (checkpoint QC + eligible-
    /// producer snapshot + ban set) plus the entire
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

            // THE reward-root writer. An epoch's root is the certified checkpoint field of the
            // macroblock that closes it, written atomically with that macroblock — so a root cannot
            // exist without its macroblock, and an epoch cannot be listed without a root.
            if let Some(epoch) = crate::reward_epoch::epoch_of_emission_mb(height) {
                let rewards_cf = db.cf_handle("pending_rewards")
                    .ok_or_else(|| IntegrationError::StorageError("pending_rewards CF not found".to_string()))?;
                let root = macroblock.consensus_data.checkpoint_qc.as_ref()
                    .and_then(|b| bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint,
                                                          qnet_consensus::checkpoint_bft::QuorumCertificate)>(b).ok())
                    .map(|(cp, _)| cp.reward_root);
                match root {
                    Some(r) => {
                        let k = Storage::epoch_root_key(epoch);
                        // Immutable: a differing value at the same index means two certified
                        // macroblocks exist there, which is equivocation, not a retry.
                        if let Some(prev) = db.get_cf(&rewards_cf, k.as_bytes())? {
                            if prev.as_slice() != r.as_slice() {
                                return Err(IntegrationError::StorageError(format!(
                                    "epoch_root_equivocation epoch={} mb={}", epoch, height)));
                            }
                        }
                        batch.put_cf(&rewards_cf, k.as_bytes(), &r);
                    }
                    None => {
                        // Unreachable for a verified macroblock (verify_v2_macroblock rejects a
                        // missing QC); refuse rather than store an epoch-closing macroblock with no root.
                        return Err(IntegrationError::StorageError(format!(
                            "macroblock_without_qc mb={} epoch={}", height, epoch)));
                    }
                }
            }

            // The contiguous seal watermark (last_sealed_mb) is derived on read by
            // last_sealed_mb_index(), never written here: two writers (BFT seal +
            // P2P sync ingest) save macroblocks concurrently and un-serialized, so
            // a writer-side read-modify-write would lose updates and freeze the
            // frontier. Body writes stay independent per-index; the reader folds them.
            db.write(batch)?;
            // This index BECAME present (the idempotent-skip above returned early otherwise) — signal the
            // pipeline's committee-deferred redrive, whose clear condition is exactly "macroblock n2 exists".
            MACROBLOCK_SAVE_SEQ.fetch_add(1, Ordering::Relaxed);
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

    /// Contiguous last-sealed-macroblock index (0 if none) — the TRUE seal frontier the production
    /// backpressure reads (never chain_height/90, the microblock tip, which can't bound a seal-stalled
    /// producer). Defined as the largest F with macroblock_1..F all present, derived here by scanning
    /// forward from the persisted hint (always <= F) and read-repairing the hint when it advances.
    /// Race-immune: a pure function of committed macroblocks with a single writer (this reader), so
    /// concurrent save_macroblock ordering cannot freeze it. Amortised O(1); one O(F) scan on cold cache.
    pub fn last_sealed_mb_index(&self) -> u64 {
        let metadata_cf = match self.db.cf_handle("metadata") { Some(cf) => cf, None => return 0 };
        let micro_cf = match self.db.cf_handle("microblocks") { Some(cf) => cf, None => return 0 };
        let hint = self.db.get_cf(&metadata_cf, b"last_sealed_mb").ok().flatten()
            .filter(|v| v.len() == 8)
            .map(|v| { let mut b = [0u8; 8]; b.copy_from_slice(&v[..8]); u64::from_le_bytes(b) })
            .unwrap_or(0);
        // Floor at the cold-join snapshot anchor: a snapshot-joined node holds NO sub-anchor macroblock
        // bodies (the anchor's 2f+1 QC finalized them in bulk), so contiguity is measured FROM the anchor,
        // not from 1 — otherwise the forward-scan finds macroblock_1 absent, reports 0, and disables seal
        // backpressure on every joined node. (metadata key snapshot_anchor = anchor_mb LE ++ hash.)
        let anchor = self.db.get_cf(&metadata_cf, b"snapshot_anchor").ok().flatten()
            .filter(|v| v.len() >= 8)
            .map(|v| { let mut b = [0u8; 8]; b.copy_from_slice(&v[..8]); u64::from_le_bytes(b) })
            .unwrap_or(0);
        let mut wm = hint.max(anchor);
        while self.db.get_cf(&micro_cf, format!("macroblock_{}", wm + 1).as_bytes())
            .ok().flatten().map_or(false, |v| !v.is_empty()) { wm += 1; }
        if wm > hint {
            let _ = self.db.put_cf(&metadata_cf, b"last_sealed_mb", &wm.to_le_bytes());
        }
        wm
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

    // Timeout-certificate persistence. 2f+1 TimeoutCertificates and the
    // HIGHEST_CERTIFIED_ROUND tracker were RAM-only, so a restart
    // blanked them and the pre-save stale-primary guard malfunctioned for
    // the first seconds after reboot. Now write-through into the "consensus"
    // CF on every insert and rehydrated at startup before the
    // production loop. Keys: tcerts_v1 / hi_cert_v1 / hi_adopt_v1 (bincode
    // Vec). O(k) serialise, k = retention window (pruned per block).
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

    // `save_highest_adopted_rounds` / `load_highest_adopted_rounds` REMOVED with
    // the adopted-round tracker. Only TIMEOUT_CERTIFICATES (the 2f+1 supermajority
    // proof) and HIGHEST_CERTIFIED_ROUND are persisted — the hard finality evidence
    // that must survive restart. Any legacy "hi_adopt_v1" key on disk is harmless
    // stale bytes, ignored on boot — no migration needed.

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
                // tx_index is the O(1) authority; a miss is an authoritative not-found.
                // No full-chain microblock scan (unbounded DoS amplifier on unknown hashes).
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

    /// Index a block's success-gated token-transfer events (P1). Canonical row stored once under
    /// `xfer_{height}_{log_index}`; from/to/contract pointer keys give O(hits) reverse prefix seeks.
    /// Reuses the tx_by_address CF (prefix-isolated), off-consensus. Idempotent per (height,log_index):
    /// a reorg re-apply overwrites the same keys.
    pub fn index_token_transfers(&self, rows: &[TokenTransferRow]) -> IntegrationResult<()> {
        if rows.is_empty() { return Ok(()); }
        let cf = self.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        let mut batch = WriteBatch::default();
        for r in rows {
            let canon = format!("xfer_{:016x}_{:08x}", r.height, r.log_index);
            let val = serde_json::to_vec(r)
                .map_err(|e| IntegrationError::StorageError(format!("xfer serialize: {}", e)))?;
            batch.put_cf(&cf, canon.as_bytes(), &val);
            if !r.from.is_empty() {
                batch.put_cf(&cf, format!("xfeadr_{}_{:016x}_{:08x}", xfer_seg(&r.from), r.height, r.log_index).as_bytes(), canon.as_bytes());
            }
            if !r.to.is_empty() {
                batch.put_cf(&cf, format!("xfeadr_{}_{:016x}_{:08x}", xfer_seg(&r.to), r.height, r.log_index).as_bytes(), canon.as_bytes());
            }
            batch.put_cf(&cf, format!("xfectr_{}_{:016x}_{:08x}", xfer_seg(&r.contract), r.height, r.log_index).as_bytes(), canon.as_bytes());
        }
        self.db.write(batch)?;
        Ok(())
    }

    /// Reverse (newest-first) prefix read of decoded transfer rows. `before` = the
    /// `{height:016x}_{log_index:08x}` cursor of the last row already seen (None ⇒ newest). Bounded by
    /// `limit` — a fixed O(limit) seek regardless of an address's lifetime volume.
    fn read_token_transfers(&self, prefix: &str, limit: usize, before: Option<&str>) -> Vec<TokenTransferRow> {
        let cf = match self.db.cf_handle("tx_by_address") { Some(c) => c, None => return Vec::new() };
        let seek = match before {
            Some(c) => format!("{}{}", prefix, c),
            None => format!("{}~", prefix),
        };
        let iter = self.db.iterator_cf(&cf, rocksdb::IteratorMode::From(seek.as_bytes(), rocksdb::Direction::Reverse));
        let mut out = Vec::new();
        for item in iter {
            let (key, value) = match item { Ok(kv) => kv, Err(_) => break };
            let ks = match std::str::from_utf8(&key) { Ok(s) => s, Err(_) => break };
            if !ks.starts_with(prefix) { break; }
            // reverse-From starts AT an existing key — skip the cursor row itself.
            if let Some(c) = before { if &ks[prefix.len()..] == c { continue; } }
            if let Ok(Some(v)) = self.db.get_cf(&cf, &value) {
                if let Ok(row) = serde_json::from_slice::<TokenTransferRow>(&v) { out.push(row); }
            }
            if out.len() >= limit { break; }
        }
        out
    }

    /// Decoded token transfers where `address` is the sender OR recipient (newest first).
    pub fn get_token_transfers_by_address(&self, address: &str, limit: usize, before: Option<&str>) -> Vec<TokenTransferRow> {
        self.read_token_transfers(&format!("xfeadr_{}_", xfer_seg(address)), limit, before)
    }
    /// Decoded token transfers for one contract (newest first).
    pub fn get_token_transfers_by_contract(&self, contract: &str, limit: usize, before: Option<&str>) -> Vec<TokenTransferRow> {
        self.read_token_transfers(&format!("xfectr_{}_", xfer_seg(contract)), limit, before)
    }

    /// Decoded token transfers in the height range [from,to] (block order) — for explorer ingestion.
    /// Forward-scans only the canonical `xfer_` rows (pointer prefixes xfeadr_/xfectr_ sort before it).
    /// `after` = the `{height:016x}_{log_index:08x}` cursor of the last row already returned (None ⇒
    /// start of range); the scan resumes strictly AFTER it, so a single height holding more than `limit`
    /// events pages cleanly instead of silently dropping the tail. Returns (rows, truncated); truncated
    /// ⇒ another in-range row exists past this page (caller re-requests with `after` = last row's cursor).
    pub fn get_token_transfers_in_range(&self, from: u64, to: u64, limit: usize, after: Option<&str>) -> (Vec<TokenTransferRow>, bool) {
        let cf = match self.db.cf_handle("tx_by_address") { Some(c) => c, None => return (Vec::new(), false) };
        // Seek at max(from, cursor): keys are zero-padded hex so lexical order == height order. Clamping
        // to `from` stops a client-supplied cursor below `from` from forcing an unbounded pre-`from` scan.
        let from_start = format!("xfer_{:016x}_", from);
        let start = match after {
            Some(c) => { let ac = format!("xfer_{}", c); if ac > from_start { ac } else { from_start } }
            None => from_start,
        };
        let iter = self.db.iterator_cf(&cf, rocksdb::IteratorMode::From(start.as_bytes(), rocksdb::Direction::Forward));
        let mut out = Vec::new();
        let mut truncated = false;
        for item in iter {
            let (key, value) = match item { Ok(kv) => kv, Err(_) => break };
            let ks = match std::str::from_utf8(&key) { Ok(s) => s, Err(_) => break };
            if !ks.starts_with("xfer_") { break; }
            let row = match serde_json::from_slice::<TokenTransferRow>(&value) { Ok(r) => r, Err(_) => continue };
            if row.height > to { break; }
            if row.height < from { continue; }
            if let Some(c) = after { if &ks["xfer_".len()..] == c { continue; } } // skip the cursor row itself
            if out.len() >= limit { truncated = true; break; } // an in-range row remains past the page
            out.push(row);
        }
        (out, truncated)
    }

    /// Stage (into `batch`) deletes for every token-transfer index row (canonical + from/to/contract
    /// pointers) at one height. Caller commits — so the guard delete rides the SAME atomic batch.
    fn stage_clear_token_transfers_at_height(&self, height: u64, batch: &mut WriteBatch) {
        let cf = match self.db.cf_handle("tx_by_address") { Some(c) => c, None => return };
        let prefix = format!("xfer_{:016x}_", height);
        let iter = self.db.iterator_cf(&cf, rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward));
        for item in iter {
            let (key, value) = match item { Ok(kv) => kv, Err(_) => break };
            if !std::str::from_utf8(&key).map(|s| s.starts_with(&prefix)).unwrap_or(false) { break; }
            if let Ok(r) = serde_json::from_slice::<TokenTransferRow>(&value) {
                let suffix = format!("{:016x}_{:08x}", r.height, r.log_index);
                if !r.from.is_empty() { batch.delete_cf(&cf, format!("xfeadr_{}_{}", xfer_seg(&r.from), suffix).as_bytes()); }
                if !r.to.is_empty() { batch.delete_cf(&cf, format!("xfeadr_{}_{}", xfer_seg(&r.to), suffix).as_bytes()); }
                batch.delete_cf(&cf, format!("xfectr_{}_{}", xfer_seg(&r.contract), suffix).as_bytes());
            }
            batch.delete_cf(&cf, &key);
        }
    }

    /// Reorg-consistency: if height `h` was applied before (blocklogs_h present), wipe its block_logs +
    /// token index so a re-applied replacement block fully overwrites BOTH — critical because gate-0
    /// logs_root is consensus-committed and pointer rows are address-keyed (never height-overwritten).
    /// The index clear AND the guard delete ride ONE atomic WriteBatch (RocksDB batches span CFs), so no
    /// crash window can disarm the guard while stale pointer rows survive. Fresh forward height = cheap miss.
    pub fn reset_block_token_data(&self, height: u64) {
        let key = format!("blocklogs_{:010}", height);
        let root_key = format!("blocklogsroot_{:010}", height);
        // Fire if EITHER the logs blob OR the sub-root is present. A partial persist (one written, the
        // other's save failed) must still be fully cleared before a re-applied block — else a stale
        // sub-root survives a log-reducing reorg and the seal folds a WRONG window root vs peers.
        let present = matches!(self.db.get(key.as_bytes()), Ok(Some(_)))
            || matches!(self.db.get(root_key.as_bytes()), Ok(Some(_)));
        if present {
            let mut batch = WriteBatch::default();
            self.stage_clear_token_transfers_at_height(height, &mut batch);
            batch.delete(key.as_bytes()); // default-CF guard key, atomic with the index deletes above
            batch.delete(root_key.as_bytes()); // drop the stale sub-root too
            if let Err(e) = self.db.write(batch) {
                if crate::node::is_warn() {
                    println!("[WARN][LOGS] reset_block_token_data h={} err={} (reorg re-index may leave stale pointers until next reset)", height, e);
                }
            }
        }
    }

    /// Retention: delete token-transfer index rows below `prune_before` (mirrors the tx_by_address /
    /// blocklogs prune). Canonical rows are height-prefixed so the scan is bounded to the aged range;
    /// capped per call so a backlog drains across cycles. Returns rows removed.
    pub fn prune_token_transfers_below(&self, prune_before: u64) -> usize {
        let cf = match self.db.cf_handle("tx_by_address") { Some(c) => c, None => return 0 };
        let end = format!("xfer_{:016x}_", prune_before);
        // Resume from the last-pruned height (watermark) rather than genesis, so a cycle doesn't re-skip
        // rows it already deleted (RocksDB tombstones linger until compaction). Everything below the
        // watermark is finalized+pruned, so no live row is skipped.
        let wm = self.db.get(b"token_prune_wm").ok().flatten()
            .and_then(|v| std::str::from_utf8(&v).ok().and_then(|s| s.parse::<u64>().ok())).unwrap_or(0);
        let start = format!("xfer_{:016x}_", wm);
        let iter = self.db.iterator_cf(&cf, rocksdb::IteratorMode::From(start.as_bytes(), rocksdb::Direction::Forward));
        let mut batch = WriteBatch::default();
        let mut n = 0usize;
        let mut last_h = wm;
        for item in iter {
            let (key, value) = match item { Ok(kv) => kv, Err(_) => break };
            let ks = match std::str::from_utf8(&key) { Ok(s) => s, Err(_) => break };
            if !ks.starts_with("xfer_") || ks.as_bytes() >= end.as_bytes() { break; }
            if let Ok(r) = serde_json::from_slice::<TokenTransferRow>(&value) {
                last_h = r.height;
                let suffix = format!("{:016x}_{:08x}", r.height, r.log_index);
                if !r.from.is_empty() { batch.delete_cf(&cf, format!("xfeadr_{}_{}", xfer_seg(&r.from), suffix).as_bytes()); }
                if !r.to.is_empty() { batch.delete_cf(&cf, format!("xfeadr_{}_{}", xfer_seg(&r.to), suffix).as_bytes()); }
                batch.delete_cf(&cf, format!("xfectr_{}_{}", xfer_seg(&r.contract), suffix).as_bytes());
            }
            batch.delete_cf(&cf, &key);
            n += 1;
            if n >= 50_000 { break; }
        }
        if n > 0 {
            // Fully drained the range ⇒ advance to prune_before; capped mid-range ⇒ resume at last height.
            let new_wm = if n >= 50_000 { last_h } else { prune_before };
            batch.put(b"token_prune_wm", new_wm.to_string().as_bytes());
            let _ = self.db.write(batch);
        }
        n
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
    /// Light node — mobile-only pure API client. Stores ZERO blockchain
    /// data on-device (no blocks, no headers, no certificates). All
    /// chain reads route through the Super-node REST API; the wallet
    /// app keeps the user's own TX history in AsyncStorage /
    /// localStorage, not in this RocksDB. The on-disk footprint for a
    /// Light role is limited to CF metadata (a few MB at most).
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

/// Hex-encode an address/contract segment of a token-index pointer key. Hex has no `_`, so an
/// attacker-chosen recipient string can never be a `_`-boundary prefix of a distinct address in the
/// reverse-prefix scan (prevents injecting a phantom row into a victim's token history).
#[inline]
fn xfer_seg(a: &str) -> String { hex::encode(a.as_bytes()) }

/// One success-gated token-transfer event (P1 off-consensus index). `from`==""⇒mint, `to`==""⇒burn;
/// `amount` is a decimal u128 string (qrc20) / "1" per NFT move. Not consensus state — mirrors the
/// tx_by_address index and is rebuilt from block_logs on a fresh-genesis relaunch.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct TokenTransferRow {
    pub contract: String,
    pub from: String,
    pub to: String,
    pub amount: String,
    pub kind: String,
    pub std: String,
    pub token_id: String,
    pub tx_hash: String,
    pub log_index: u32,
    pub height: u64,
    pub timestamp: u64,
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

/// Phase C (default-OFF): RocksDB-backed persistent Merkle store.
///
/// Moves the committed leaf/node set off-heap into two dedicated column
/// families so the ~2.5GB resident tree at 10M accounts lives on disk with
/// only a bounded cache in RAM. Point reads are single `get_cf` lookups; a
/// finalize's delta is one atomic `WriteBatch`. Cloning the `Arc<DB>` is
/// zero-copy and the CF names are resolved per-call via `cf_handle`, so the
/// store carries no borrowed CF lifetime.
struct RocksMerkleNodeStore {
    db: Arc<DB>,
    leaf_cf: &'static str,
    node_cf: &'static str,
}

impl RocksMerkleNodeStore {
    /// 36-byte node key = 4-byte big-endian depth ++ 32-byte node key. Big-endian
    /// keeps depth-major ordering in the CF; the fixed 36-byte width keeps every
    /// node key strictly below the 37-byte all-0xFF upper bound used by the wipe.
    #[inline]
    fn node_db_key(depth: u32, key: &[u8; 32]) -> [u8; 36] {
        let mut k = [0u8; 36];
        k[..4].copy_from_slice(&depth.to_be_bytes());
        k[4..].copy_from_slice(key);
        k
    }
}

impl qnet_state::MerkleNodeStore for RocksMerkleNodeStore {
    fn get_leaf(&self, key: &[u8; 32]) -> Option<[u8; 32]> {
        let cf = self.db.cf_handle(self.leaf_cf)?;
        let v = self.db.get_cf(&cf, &key[..]).ok().flatten()?;
        if v.len() == 32 {
            let mut out = [0u8; 32];
            out.copy_from_slice(&v);
            Some(out)
        } else {
            None
        }
    }

    fn get_node(&self, depth: u32, key: &[u8; 32]) -> Option<[u8; 32]> {
        let cf = self.db.cf_handle(self.node_cf)?;
        let dbk = Self::node_db_key(depth, key);
        let v = self.db.get_cf(&cf, &dbk[..]).ok().flatten()?;
        if v.len() == 32 {
            let mut out = [0u8; 32];
            out.copy_from_slice(&v);
            Some(out)
        } else {
            None
        }
    }

    /// Leaf keys sort bytewise and a subtree is a contiguous key range, so the probe
    /// is one seek plus at most `limit` steps — no full scan at any tree size.
    fn leaves_under(&self, lo: &[u8; 32], hi: &[u8; 32], limit: usize) -> Vec<([u8; 32], [u8; 32])> {
        let cf = match self.db.cf_handle(self.leaf_cf) {
            Some(cf) => cf,
            None => return Vec::new(),
        };
        let mut out = Vec::new();
        if limit == 0 {
            return out;
        }
        // Upper bound lets RocksDB skip files that cannot hold the range; fill_cache off keeps a
        // probe from evicting hot data out of the shared block cache.
        let mut ro = rocksdb::ReadOptions::default();
        ro.set_iterate_upper_bound({
            let mut end = hi.to_vec();
            end.push(0u8); // inclusive `hi` -> exclusive bound
            end
        });
        ro.fill_cache(false);
        let mode = rocksdb::IteratorMode::From(&lo[..], rocksdb::Direction::Forward);
        for item in self.db.iterator_cf_opt(&cf, ro, mode) {
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(_) => break,
            };
            if k.len() != 32 || k.as_ref() > &hi[..] {
                break;
            }
            if v.len() != 32 {
                continue;
            }
            let mut key = [0u8; 32];
            let mut val = [0u8; 32];
            key.copy_from_slice(&k);
            val.copy_from_slice(&v);
            out.push((key, val));
            if out.len() >= limit {
                break;
            }
        }
        out
    }

    fn all_leaves(&self) -> Vec<([u8; 32], [u8; 32])> {
        let cf = match self.db.cf_handle(self.leaf_cf) {
            Some(cf) => cf,
            None => return Vec::new(),
        };
        let mut out = Vec::new();
        for item in self.db.iterator_cf(&cf, rocksdb::IteratorMode::Start) {
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(_) => continue, // skip malformed rows defensively
            };
            if k.len() != 32 || v.len() != 32 {
                continue;
            }
            let mut key = [0u8; 32];
            let mut val = [0u8; 32];
            key.copy_from_slice(&k);
            val.copy_from_slice(&v);
            out.push((key, val));
        }
        out
    }

    fn wipe_leaves(&self) -> Result<(), String> {
        let leaf_cf = self.db.cf_handle(self.leaf_cf)
            .ok_or_else(|| format!("merkle leaf CF '{}' not found", self.leaf_cf))?;
        // Leaf keys are exactly 32 bytes, so a 33-byte upper bound covers every one of them.
        let lo = [0u8; 1];
        let hi = [0xFFu8; 33];
        self.db.delete_range_cf(&leaf_cf, &lo[..], &hi[..]).map_err(|e| e.to_string())
    }

    fn put_batch(
        &self,
        leaf_puts: &[([u8; 32], [u8; 32])],
        leaf_dels: &[[u8; 32]],
        node_puts: &[((u32, [u8; 32]), [u8; 32])],
        node_dels: &[(u32, [u8; 32])],
        wipe_all_nodes: bool,
    ) -> Result<(), String> {
        let leaf_cf = self.db.cf_handle(self.leaf_cf)
            .ok_or_else(|| format!("merkle leaf CF '{}' not found", self.leaf_cf))?;
        let node_cf = self.db.cf_handle(self.node_cf)
            .ok_or_else(|| format!("merkle node CF '{}' not found", self.node_cf))?;

        // Full rebuild: wipe the ENTIRE node set as its OWN committed write BEFORE
        // the puts batch. A single 36-byte-wide range [0x00 .. 0xFF×37) covers every
        // node key (all are 36 bytes < the 37-byte upper bound), so no stale node can
        // survive to silently fork the chain. Committing separately avoids same-batch
        // DeleteRange+Put ordering ambiguity — the subsequent puts carry the complete
        // non-default node set. LEAVES are never wiped.
        if wipe_all_nodes {
            let lo = [0u8; 1];
            let hi = [0xFFu8; 37];
            self.db.delete_range_cf(&node_cf, &lo[..], &hi[..])
                .map_err(|e| e.to_string())?;
        }

        let mut batch = WriteBatch::default();

        // Leaves: leaf_puts/leaf_dels are disjoint by contract ⇒ order-independent.
        for key in leaf_dels {
            batch.delete_cf(&leaf_cf, &key[..]);
        }
        for (key, val) in leaf_puts {
            batch.put_cf(&leaf_cf, &key[..], &val[..]);
        }

        // Nodes: on the merge path (no wipe) apply node_dels BEFORE node_puts so a
        // re-put of the same key wins. After a wipe there is nothing left to delete,
        // so node_dels are a no-op — node_puts alone repopulate the full set.
        if !wipe_all_nodes {
            for (depth, key) in node_dels {
                let dbk = Self::node_db_key(*depth, key);
                batch.delete_cf(&node_cf, &dbk[..]);
            }
        }
        for ((depth, key), val) in node_puts {
            let dbk = Self::node_db_key(*depth, key);
            batch.put_cf(&node_cf, &dbk[..], &val[..]);
        }

        self.db.write(batch).map_err(|e| e.to_string())
    }
}
/// What a save actually did. A plain bool conflated two very different non-writes: a rollback
/// declining a height above its target (transient, self-correcting) and a node whose storage mode
/// keeps no blocks at all (persistent, and NOT something a fork recovery can fix). The caller must
/// be able to tell them apart, because one of them must escalate and the other must not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveOutcome {
    /// The height durably holds this block (freshly written, or an identical block was already there).
    Stored,
    /// Declined because a rollback is driving the chain to a lower target; re-requested afterwards.
    DeclinedRollback,
    /// This node's effective storage mode keeps no blocks. Never true for a healthy Super node —
    /// a Super reaches it only through disk-pressure degradation.
    NotStoredMode,
}


/// Heartbeat-index subwindows kept below the newest applied one: the roster-derivation horizon (in
/// subwindows) plus the reader's own current+previous span, plus one for the boundary. Retention MUST
/// cover the horizon — the deep roster readers ask about windows that far below the tip, and a pruned
/// answer would be a per-node liveness set feeding epoch_commitment.
pub(crate) const LHB_RETAINED_SUBWINDOWS: u64 =
    (crate::node::BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64) * 90 / 1440 + 3;

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
    /// Tiered storage configuration (v3.18+ has only two roles: Light
    /// and Super).
    tier_config: StorageTierConfig,
    /// Graceful degradation manager
    graceful_degradation: Arc<RwLock<GracefulDegradation>>,
    /// DEPRECATED — legacy header-rotation buffer from the historical
    /// "headers-persisted" Light tier. Current Light nodes are pure
    /// mobile API clients with zero on-device chain storage, so this
    /// buffer is a no-op in production. Field retained so the struct
    /// shape stays stable until all in-tree references migrate.
    light_rotation: Arc<RwLock<LightNodeRotation>>,
    /// v27 HOLE3: bounded read-through cache (height→block), warmed by
    /// apply, read before cold RocksDB → kills 30s verify_stuck.
    /// Rollback-aware. O(1), scale-independent.
    recent_microblocks: Arc<dashmap::DashMap<u64, Arc<qnet_state::MicroBlock>>>,
}

/// v27 HOLE3: recent-block cache cap (macroblock window + slack).
const RECENT_MB_CACHE_CAP: u64 = 256;

// ============================================================================
// TIERED STORAGE IMPLEMENTATION
// ============================================================================
// Storage tier by node role (v3.18+ — only two roles exist: Light and Super).
// - Light: ZERO on-device chain storage. Pure mobile API client (phones,
//   tablets, F-Droid). Reads balance / TX history through REST API on
//   Super nodes. Wallet app keeps user's own TX list in its native
//   storage (AsyncStorage / localStorage), NOT in RocksDB.
// - Super/Bootstrap: Full blocks, NO pruning (~2TB, full history). Only
//   role that participates in consensus, serves sync requests, and
//   stores on-chain state.
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

    /// Anti-double-sign watermark — proxy to PersistentStorage.
    pub fn save_highest_signed_height(&self, height: u64) -> IntegrationResult<()> {
        self.persistent.save_highest_signed_height(height)
    }

    pub fn load_highest_signed_height(&self) -> IntegrationResult<Option<u64>> {
        self.persistent.load_highest_signed_height()
    }

    /// Phase C: RocksDB-backed persistent Merkle store over the two dedicated
    /// column families ("merkle_leaves", "merkle_nodes"). Both CFs are created at
    /// open (build_column_families), so on a fresh genesis DB they always exist.
    /// Handed to `StateManager::set_merkle_node_store` when the persistent-tree
    /// feature is enabled, moving the committed tree off-heap. The `Arc<DB>` clone
    /// is zero-copy; CF handles are resolved lazily on each store operation.
    pub fn merkle_node_store(&self) -> std::sync::Arc<dyn qnet_state::MerkleNodeStore> {
        std::sync::Arc::new(RocksMerkleNodeStore {
            db: self.persistent.db.clone(),
            leaf_cf: "merkle_leaves",
            node_cf: "merkle_nodes",
        })
    }

    // Smart-contract VM: WASM code blobs are stored via the existing
    // `save_contract_code` / `get_contract_code` (content-addressed by code_hash,
    // `contract:code:{hash}` in the raw store). No new CF needed.

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

    /// Wallet→token reverse-index maintenance (NON-consensus). One atomic batch: this block's owns-deltas
    /// + the durable watermark at `height`; see `PersistentStorage::persist_owns_deltas`.
    pub fn persist_owns_deltas(&self, deltas: &[qnet_state::OwnsDelta], height: u64) -> IntegrationResult<()> {
        self.persistent.persist_owns_deltas(deltas, height)
    }

    /// Contracts a wallet holds a live QRC-20 balance in (O(held) prefix seek).
    pub fn get_tokens_for_wallet(&self, wallet: &str) -> IntegrationResult<Vec<String>> {
        self.persistent.get_tokens_for_wallet(wallet)
    }

    /// One-time reconciliation of the wallet_token index from the accounts CF (boot / post-snapshot).
    pub fn backfill_owns_indices(&self) -> IntegrationResult<usize> {
        self.persistent.backfill_owns_indices()
    }

    /// Heal the wallet_token index for one contract from a reorg-restored `contract_storage`
    /// (rollback path); see `PersistentStorage::resync_owns_for_contract`.
    pub fn resync_owns_for_contract(&self, contract: &str, contract_storage: &std::collections::HashMap<String, String>) -> IntegrationResult<()> {
        self.persistent.resync_owns_for_contract(contract, contract_storage)
    }

    /// Load a single account from the persistent `accounts` CF. Used by
    /// the read-through cache layer (Stage 2) and by recovery paths that
    /// need an authoritative on-disk copy of an account when the
    /// in-memory `DashMap` does not contain it.
    pub fn load_account(&self, address: &str) -> IntegrationResult<Option<qnet_state::Account>> {
        self.persistent.load_account(address)
    }

    /// Load every account from the `accounts` CF as (address, Account) pairs. Used by the cold-join
    /// in-mem state rehydrate to seed the merkle + accounts DashMap from the promoted CF. One-time
    /// full materialization — fine for a cold-join; a streaming variant is the scale follow-up.
    pub fn load_all_accounts(&self) -> IntegrationResult<Vec<(String, qnet_state::Account)>> {
        let cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut out: Vec<(String, qnet_state::Account)> = Vec::new();
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start) {
            let (k, v) = item.map_err(|e| IntegrationError::StorageError(format!("accounts_iter_err: {}", e)))?;
            let addr = String::from_utf8(k.to_vec())
                .map_err(|e| IntegrationError::StorageError(format!("accounts_addr_utf8_err: {}", e)))?;
            let account: qnet_state::Account = bincode::deserialize(&v)
                .map_err(|e| IntegrationError::SerializationError(format!("accounts_decode_err: {}", e)))?;
            out.push((addr, account));
        }
        if crate::node::is_info() {
            println!("[INFO][STATE] load_all_accounts count={}", out.len());
        }
        Ok(out)
    }

    /// Stream-sum all account balances from the accounts CF (O(1) RAM, no Vec). Used only by the
    /// legacy pre-emission cold-join fallback where the anchor lacks a checkpoint_qc; post-emission
    /// anchors bind total_supply via the QC checkpoint instead of a balance sum.
    pub fn sum_all_account_balances(&self) -> IntegrationResult<u64> {
        let cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut sum: u64 = 0;
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start) {
            let (_k, v) = item.map_err(|e| IntegrationError::StorageError(format!("accounts_iter_err: {}", e)))?;
            let account: qnet_state::Account = bincode::deserialize(&v)
                .map_err(|e| IntegrationError::SerializationError(format!("accounts_decode_err: {}", e)))?;
            sum = sum.saturating_add(account.balance);
        }
        Ok(sum)
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

    /// WAL-maintenance flush for the periodic task (set_wait(false)); see
    /// PersistentStorage::flush_all_background — MAY briefly block under an L0 backlog, so call it
    /// ONLY off the consensus runtime. flush_all (synchronous) remains for shutdown/OOM durability.
    pub fn flush_all_background(&self) -> IntegrationResult<()> {
        self.persistent.flush_all_background()
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
            let key = mb_body_key(height);
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
            StorageMode::Light => "Light (mobile API client, no on-device chain storage)",
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
    
    /// Save raw data with a custom key
    pub fn save_raw(&self, key: &str, data: &[u8]) -> IntegrationResult<()> {
        self.persistent.save_raw(key, data)
    }
    
    /// Load raw data with a custom key
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
            
            if crate::node::is_debug() {
                println!("[DBG][STORAGE] auto_scaling optimal_shards={}", optimal_shards);
            }
            
            optimal_shards
        };
        
        // TIERED STORAGE CONFIGURATION (v3.18+ — only two roles).
        // ============================================================================
        // - Light: ZERO on-device chain storage. Mobile-only pure API client.
        //          No blocks, no headers, no certs in RocksDB. All chain data
        //          accessed via REST API on Super nodes; wallet app stores
        //          user TX history in AsyncStorage / localStorage. The
        //          `max_storage_gb` and `base_window` values below are
        //          legacy parameters retained for the tuple shape and a
        //          minimal RocksDB footprint (CF metadata, no chain data);
        //          actual chain-data writes are no-ops — see
        //          `StorageTierConfig::light()` and the `StorageMode::Light`
        //          branch in `save_microblock` further down this file.
        // - Super/Bootstrap: Full blocks, NO pruning (~2TB, complete history).
        // ============================================================================

        let (storage_mode, max_storage_gb, base_window, tier_config) = match node_type.to_lowercase().as_str() {
            "light" => (
                StorageMode::Light,
                1,      // legacy field — chain storage is disabled; this only sizes
                        // the RocksDB CF metadata footprint on mobile (≈ few MB).
                1_000,  // legacy field — Light never persists chain blocks; this
                        // value is unused at runtime (StorageMode::Light branch
                        // in save_microblock is a no-op).
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
            StorageMode::Light => ("light", "mobile_api_client_no_chain_storage"),
            StorageMode::Super => ("super", "full_history_archival ~2TB"),
        };
        println!("[INFO][STORAGE] config mode={} storage={} pruning_window={}",
                 mode_name, storage_desc, tier_config.pruning_window_blocks);

        // v3.18: Only Light and Super modes — no sliding-window scaling needed.
        // Super nodes keep everything; Light nodes store no chain data at all,
        // so the `sliding_window` value below is unused on Light at runtime.
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
        
        // Initialize the deprecated light-node header-rotation buffer.
        // Light tier is now a pure-API-client role (zero on-device chain
        // storage), so this buffer is a no-op in production — kept only
        // for backward-compat field presence. See `LightNodeRotation`
        // docstring above for the deprecation note.
        let light_rotation = LightNodeRotation::new(tier_config.pruning_window_blocks);
            
        // Wipe the reward-aggregation scratch: pure per-process working space, so anything present is
        // debris from a build that crashed. Cleared at open, before any build can read it.
        if let Some(cf) = persistent.db.cf_handle("reward_agg") {
            let mut b = WriteBatch::default();
            b.delete_range_cf(&cf, b"rag_".as_ref(), b"rah_".as_ref());
            let _ = persistent.db.write(b);
        }

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
            recent_microblocks: Arc::new(dashmap::DashMap::new()),
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
    
    /// See `SaveOutcome`. The apply-success branch feeds consensus accumulators (window content,
    /// finalized round) and the serve horizon, none of which may advance for a block that is not on
    /// disk, so anything other than `Stored` must not be treated as a commit.
    pub fn save_microblock(&self, height: u64, data: &[u8]) -> IntegrationResult<SaveOutcome> {
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
            return Ok(SaveOutcome::DeclinedRollback);
        }

        // L4 storage-level anti-fork guard (last line of defence). Forensic
        // h=174582: two different blocks saved at the same height on
        // different nodes; the pre-v15.11 presence-only check let the second
        // save silently no-op instead of detecting the equivocation. Now:
        // compute the canonical hash of the incoming MicroBlock (SHA3-256
        // over height+ts+prev_hash+merkle_root+producer) and compare to the
        // stored one — equal → idempotent silent OK; unequal → EQUIVOCATION,
        // record slashing evidence + REJECT; undeserialisable → legacy
        // presence fallback. Makes a divergent storage fork impossible on an
        // honest node. Pairs with producer L3, network L5 majority-wins, L6
        // slashing. O(1)/save; evidence bounded by the retention sweep.
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
                    return Ok(SaveOutcome::Stored); // already durable at this height
                }
                Some(new_hash) => {
                    // EQUIVOCATION — different block at the same height. Capture unforgeable
                    // proof headers from BOTH blocks (the incoming one is rejected here and
                    // never reaches storage) for the on-chain slashing TX, then reject.
                    let new_producer = incoming_block.as_ref()
                        .map(|mb| mb.producer.clone())
                        .unwrap_or_else(|| "unknown".to_string());

                    if crate::node::is_warn() {
                        println!(
                            "[ERR][FORK] equivocation_attempt h={} existing_hash={:x?} new_hash={:x?} new_producer={} action=reject_save_record_evidence",
                            height,
                            &existing_hash[..8],
                            &new_hash[..8],
                            new_producer,
                        );
                    }

                    // Record only when BOTH full blocks are in hand (they are at L4 — incoming
                    // in hand, existing re-loaded). The proof is self-validating (offender's sigs).
                    //
                    // MUST go through the format-aware loader. `load_microblock` returns the raw CF
                    // bytes, which a Super node writes as a possibly-compressed EfficientMicroBlock
                    // (format byte 0x02) — decoding those as a MicroBlock fails on EVERY block, so
                    // this was always None and the whole block-equivocation slashing path was dead:
                    // the guard rejected the variant and then silently dropped the evidence.
                    let existing_mb = self.load_microblock_auto_format(height).ok().flatten();
                    if let (Some(inc), Some(exist)) = (incoming_block.as_ref(), existing_mb.as_ref()) {
                        // Slashable equivocation requires the SAME producer to have signed BOTH
                        // blocks. Two DIFFERENT producers at one height is a failover/rotation
                        // race (honest liveness, resolved by round-based fork-choice) — rejected
                        // here but NEVER slashed.
                        if inc.producer == exist.producer {
                            let to_header = |mb: &qnet_state::MicroBlock| qnet_state::EquivocationHeader {
                                timestamp: mb.timestamp,
                                merkle_root: mb.merkle_root,
                                previous_hash: mb.previous_hash,
                                state_root: mb.state_root,
                                vrf_output: mb.vrf_output,
                                timeout_round: mb.timeout_round,
                                carried_baseline: mb.carried_baseline,
                                // Blocker-3: capture the signed pk_digest so the on-chain proof re-verify
                                // reconstructs the SAME Block_Sig_v23.1 digest as the producer.
                                pk_digest: crate::node::microblock_pk_digest(&mb.transactions),
                                signature: mb.signature.clone(),
                            };
                            crate::node::record_block_equivocation(height, &new_producer, to_header(exist), to_header(inc));
                        } else if crate::node::is_warn() {
                            println!(
                                "[WARN][FORK] same_height_distinct_producers h={} existing={} incoming={} action=reject_no_slash(failover_race)",
                                height, exist.producer, inc.producer,
                            );
                        }
                    }

                    // NON-DESTRUCTIVE: retain the competing block as a branch before refusing it the
                    // canonical slot. Its bytes are keyed by hash, so it displaces nothing and stays
                    // available to fork-choice. Previously they were dropped here, which is why a
                    // reorg had to re-download the winner it had just been handed.
                    if let Some(ref inc) = incoming_block {
                        self.retain_branch_block(inc, data);
                    }
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
                    return Ok(SaveOutcome::Stored); // a block is present at this height
                }
            }
        }

        // Parent linkage is an invariant of the STORE, not of the pipeline. Every writer (gossip
        // apply, sync batch, solicited repair, producer self-save) passes here, so enforcing it at
        // this boundary makes a parentless block unpersistable regardless of which upstream cache
        // or check went stale. Runs AFTER the dedup/equivocation block so an idempotent re-save
        // still short-circuits and same-height equivocation evidence is still recorded. A
        // present-but-mismatched parent is the orphan case; an ABSENT parent is left to the caller
        // (pruned history, snapshot cold-join, backfill).
        if let Some(ref mb) = incoming_block {
            // The anchor exemption exists for the ONE block that follows a promoted snapshot, whose
            // parent this node never held. Scope it to the cold-join window (chain still at/below the
            // anchor); once the chain has moved past it, that height is ordinary and must be checked.
            let anchor_h = crate::node::SNAPSHOT_ANCHOR_MB
                .load(std::sync::atomic::Ordering::Acquire).saturating_mul(90);
            let anchor_successor = anchor_h > 0
                && height == anchor_h + 1
                && self.persistent.get_chain_height().unwrap_or(0) <= anchor_h;
            if height > 0 && !anchor_successor {
                // The named parent must be the block CANONICALLY occupying the preceding slot.
                // Asking merely "do we hold this hash?" is a tautology — the claimed hash answers
                // for itself — and would admit a child of any retained branch. Absent canonical
                // parent stays permitted (pruned history / cold-join / backfill); a canonical
                // parent that does NOT match is the orphan case and is rejected.
                let canonical_parent = self.persistent.load_microblock_hash(height - 1).ok().flatten();
                if canonical_parent.map(|p| p != mb.previous_hash).unwrap_or(false) {
                    println!(
                        "[ERR][STORAGE] unlinked_block_rejected h={} producer={} parent_claimed={:x?}",
                        height, mb.producer, &mb.previous_hash[..8]
                    );
                    return Err(IntegrationError::StorageError(format!(
                        "unlinked_block h={} parent_mismatch", height
                    )));
                }
            }
        }

        // =====================================================================
        // TIERED STORAGE + GRACEFUL DEGRADATION (v2.19.9)
        // =====================================================================
        // This method now includes:
        // 1. Storage health check with graceful degradation
        // 2. Tiered storage based on node type (Light / Super)
        // 3. Light-node short-circuit: writes are no-ops (pure API client,
        //    no on-device chain storage). All chain-data persistence below
        //    runs only on Super nodes.
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
                Ok(SaveOutcome::NotStoredMode) // a light node holds no blocks
            },
            StorageMode::Super => {
                // SUPER MODE: Full block storage with EfficientMicroBlock format
                if let Ok(microblock) = bincode::deserialize::<qnet_state::MicroBlock>(data) {
                    return self.save_microblock_efficient(height, &microblock).map(|_| SaveOutcome::Stored);
                }
                
                // Fallback: Apply adaptive compression to raw data
        let compressed_data = if height > 0 {
            self.compress_block_adaptive(data, height)?
        } else {
            data.to_vec()
        };
        
        self.persistent.save_microblock(height, &compressed_data).map(|_| SaveOutcome::Stored)
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
            
            // INDEX: address -> tx_hash. HEIGHT-stamped for the same reason as the sibling writer:
            // the retention scan cuts on this field and tx.timestamp is author-supplied.
            let stamp = height;
            let from_key = format!("addr_{}_{:016x}_{}", tx.from, stamp, tx_hash_str);
            batch.put_cf(&tx_by_addr_cf, from_key.as_bytes(), tx_hash_str.as_bytes());
            
            // Index 'to' address (if present, including system addresses)
            let to_addr = tx.to.as_ref().map(|s| s.as_str()).unwrap_or(&tx.from);
            let to_key = format!("addr_{}_{:016x}_{}", to_addr, stamp, tx_hash_str);
            batch.put_cf(&tx_by_addr_cf, to_key.as_bytes(), tx_hash_str.as_bytes());

            // QRC-20/721 counterparties are indexed from the success-gated transfer EVENTS
            // (build_token_transfer_rows), not from calldata intent — see the token_transfers index.
        }
        
        // Log pattern compression results (every 100 blocks)
        if height % 100 == 0 && total_original_size > 0 {
            let tx_savings = (1.0 - total_compressed_size as f64 / total_original_size as f64) * 100.0;
            println!("[INFO][STORAGE] tx_compression h={} original_bytes={} compressed_bytes={} reduction_pct={:.1}",
                     height, total_original_size, total_compressed_size, tx_savings);
        }
        
        // Step 2: Create EfficientMicroBlock with hashes only (+ VRF)
        let efficient_block = qnet_state::EfficientMicroBlock {
            height: microblock.height,
            timestamp: microblock.timestamp,
            transaction_hashes: tx_hashes,
            producer: microblock.producer.clone(),
            signature: microblock.signature.clone(),
            previous_hash: microblock.previous_hash,
            merkle_root: microblock.merkle_root,
            // Quantum Randomness Beacon (QRB) v3.0
            vrf_output: microblock.vrf_output,
            vrf_proof: microblock.vrf_proof.clone(),
            // v3.18: Copy fees_collected for producer rewards
            fees_collected: microblock.fees_collected,
            // v3.27: State root for verification
            state_root: microblock.state_root,
            // v14.0: Timeout round for producer authority proof
            timeout_round: microblock.timeout_round,
            carried_baseline: microblock.carried_baseline,
        };
        
        // Serialize EfficientMicroBlock (much smaller than full MicroBlock)
        let efficient_data = bincode::serialize(&efficient_block)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;

        // Apply adaptive compression to EfficientMicroBlock
        let compressed_block = self.compress_block_adaptive(&efficient_data, height)?;

        // v9.0: Single atomic WriteBatch for ALL data: TXs + block header + chain_height.
        // Previously these were separate writes; a crash between any two left orphaned data
        // (TXs without a header, a header without its block).
        // Now: everything in ONE WriteBatch for crash-safe atomicity.
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks CF not found".to_string()))?;
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;
        let block_key = mb_body_key(height);

        // v12.0: Compute block hash from STRUCT FIELDS (MicroBlock::hash()), not raw bytes.
        // Block hash is a consensus property: SHA3(height + timestamp + prev_hash + merkle_root + producer).
        // Raw bytes depend on storage format (EfficientMicroBlock, zstd) and must NOT affect consensus hash.
        let block_hash = microblock.hash();
        let hash_key = mb_hash_key(height);

        // v12.1: Format discriminator — explicit metadata key eliminates bincode guessing.
        // On load, load_microblock_auto_format checks this key to know the exact format,
        // instead of trying both MicroBlock/EfficientMicroBlock deserializations.
        // Key: microblock_fmt_{height} → 0x02 (EfficientMicroBlock)
        let fmt_key = mb_fmt_key(height);

        batch.put_cf(&microblocks_cf, block_key.as_bytes(), &compressed_block);
        batch.put_cf(&metadata_cf, b"chain_height", &height.to_be_bytes());
        batch.put_cf(&metadata_cf, hash_key.as_bytes(), block_hash.as_slice());
        batch.put_cf(&metadata_cf, fmt_key.as_bytes(), &[0x02u8]); // 0x02 = EfficientMicroBlock
        // Header + child link written in the SAME batch as the body, so the hash-addressed view can
        // never disagree with the height view. The BODY is deliberately NOT duplicated under its
        // hash: a canonical block is reachable as alias → height → body, and duplicating ~10 KB per
        // block would double on-disk growth (0.6 → 1.2 GB/day/node). Only a block refused the
        // canonical slot gets a hash-keyed body copy (retain_branch_block) — that set is tiny and
        // is pruned at finality.
        let hdr = BlockHeaderIdx {
            height,
            previous_hash: microblock.previous_hash,
            producer: microblock.producer.clone(),
            state_root: microblock.state_root,
            timestamp: microblock.timestamp,
            tx_count: microblock.transactions.len() as u32,
        };
        if let Ok(hdr_bytes) = bincode::serialize(&hdr) {
            batch.put_cf(&metadata_cf, &block_header_key(&block_hash), &hdr_bytes);
        }
        batch.put_cf(&metadata_cf, &block_child_key(&microblock.previous_hash, &block_hash), &[]);
        // v32.7: WAL-disabled during catch-up for ~10× apply throughput.
        // Periodic flush every 500 blocks bounds at-risk window on crash.
        if crate::node::FAST_SYNC_IN_PROGRESS.load(std::sync::atomic::Ordering::Relaxed) {
            let mut wopts = rocksdb::WriteOptions::default();
            wopts.disable_wal(true);
            self.persistent.db.write_opt(batch, &wopts)?;
            if height % 500 == 0 {
                let _ = self.persistent.db.flush();
            }
        } else {
            self.persistent.db.write(batch)?;
        }

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

    /// v32.7: durable flush — used by fast-sync exit path to persist
    /// WAL-disabled writes accumulated during catch-up.
    pub fn flush_db(&self) {
        let _ = self.persistent.db.flush();
    }

    /// v10.2: O(1) microblock hash lookup from index.
    /// Returns stored block hash without loading/decompressing the full block.
    pub fn load_microblock_hash(&self, height: u64) -> IntegrationResult<Option<[u8; 32]>> {
        self.persistent.load_microblock_hash(height)
    }

    /// Canonical anchor-hash accessor for Heartbeat TXs: hex of the microblock CONSENSUS hash at
    /// `height`, via the backfilling microblock-hash index — NOT get_block_hash, which reads the
    /// full-block "blocks" CF that microblocks never populate (it returns None for EVERY microblock
    /// anchor, silently breaking Heartbeat emission AND verification). Single source of truth so the
    /// emitter, every anchor consumer agrees on the format by construction.
    pub fn get_microblock_hash_hex(&self, height: u64) -> IntegrationResult<Option<String>> {
        Ok(self.load_microblock_hash(height)?.map(hex::encode))
    }

    /// v10.2: Save a hash index entry (used for backfilling during validation fallback).
    pub fn save_microblock_hash(&self, height: u64, hash: &[u8]) -> IntegrationResult<()> {
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;
        let hash_key = mb_hash_key(height);
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
            let block_key = mb_body_key(h);
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
                let hash_key = mb_hash_key(h);
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

        // Delete the block header
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

            // Block data + metadata + hash + the hash-addressed index rows. Dropping the body while
            // keeping its header would leave a stale oracle that re-admits an orphan — the exact
            // shape of the h=54059 incident, with the header index standing in for the RAM cache.
            let key = mb_body_key(h);
            let hash_key = mb_hash_key(h);
            note_body_delete(h);
            if let Ok(Some(existing)) = self.persistent.load_microblock_hash(h) {
                if let Some(prev) = self.persistent.header_index(&existing).map(|hd| hd.previous_hash) {
                    batch.delete_cf(&metadata_cf, &block_child_key(&prev, &existing));
                }
                batch.delete_cf(&metadata_cf, &block_header_key(&existing));
            }
            batch.delete_cf(&microblocks_cf, key.as_bytes());
            batch.delete_cf(&metadata_cf, hash_key.as_bytes());

            count += 1;
        }

        self.persistent.db.write(batch)?;
        Ok(count)
    }

    /// Hash of the most recently stored macroblock.
        
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
        
        // SECURITY: macroblock state_root = real account-state Merkle root at the window
        // head (head microblock's state_root). Cross-checks the 2f+1-signed checkpoint root
        // against this node's own computed state. Skip if the head microblock isn't local yet
        // (out-of-order sync) — microblock apply verifies its own state_root independently.
        {
            let head_h = height * 90;
            if let Ok(Some(head_mb)) = self.load_microblock_auto_format(head_h) {
                if head_mb.state_root != macroblock.state_root {
                    return Err(IntegrationError::StorageError(
                        format!("macroblock state_root mismatch at window {}: macroblock {:?} vs window-head h={} {:?}",
                                height, macroblock.state_root, head_h, head_mb.state_root)
                    ));
                }
            }
        }
        // NOTE: Account state snapshots are saved separately by emission/rewards processing
        // (node.rs) as Vec<(String, Account)>. Previously this path incorrectly saved
        // serialized MacroBlock data into state_snap keys, causing deserialization failures
        // on node restart (bincode expected Vec<(String,Account)> but got MacroBlock).
        
        // Storage strategy: Super/Genesis = archival (keep all microblocks
        // forever, serve sync, ~500MB-1GB/day); Light = pure API client, no
        // local storage (never reaches save_macroblock). New Super nodes
        // bootstrap via snapshot (download latest → restore accounts → sync
        // only snapshot_height..current).
        
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
            let key = mb_body_key(micro_height);
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

    /// SECURITY: Persist one attacker-PK blacklist entry (delegates to
    /// the inner `PersistentStorage`). Used by the persistence callback
    /// installed in `node.rs` boot path.
    pub fn save_attacker_pk_entry(
        &self,
        fingerprint: &[u8; 32],
        record: &qnet_consensus::consensus_crypto::AttackerRecord,
    ) -> IntegrationResult<()> {
        self.persistent.save_attacker_pk_entry(fingerprint, record)
    }

    /// SECURITY: Replay every persisted attacker-PK blacklist entry at
    /// boot. Delegates to the inner `PersistentStorage`. Empty result
    /// is normal on a fresh data directory.
    pub fn load_all_attacker_pk_entries(
        &self,
    ) -> IntegrationResult<Vec<([u8; 32], qnet_consensus::consensus_crypto::AttackerRecord)>>
    {
        self.persistent.load_all_attacker_pk_entries()
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

    /// P1 token-transfer index (forwarders to PersistentStorage).
    pub fn index_token_transfers(&self, rows: &[TokenTransferRow]) -> IntegrationResult<()> {
        self.persistent.index_token_transfers(rows)
    }
    pub fn get_token_transfers_by_address(&self, address: &str, limit: usize, before: Option<&str>) -> Vec<TokenTransferRow> {
        self.persistent.get_token_transfers_by_address(address, limit, before)
    }
    pub fn get_token_transfers_by_contract(&self, contract: &str, limit: usize, before: Option<&str>) -> Vec<TokenTransferRow> {
        self.persistent.get_token_transfers_by_contract(contract, limit, before)
    }
    pub fn get_token_transfers_in_range(&self, from: u64, to: u64, limit: usize, after: Option<&str>) -> (Vec<TokenTransferRow>, bool) {
        self.persistent.get_token_transfers_in_range(from, to, limit, after)
    }
    pub fn reset_block_token_data(&self, height: u64) {
        self.persistent.reset_block_token_data(height)
    }
    pub fn prune_token_transfers_below(&self, prune_before: u64) -> usize {
        self.persistent.prune_token_transfers_below(prune_before)
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
    // Wrapper functions for adopted-round persistence REMOVED with the tracker.
    // See the rationale in the persistent impl above.

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
                        // QRB v3.0: VRF fields
                        vrf_output: efficient_block.vrf_output,
                        vrf_proof: efficient_block.vrf_proof,
                        // v3.18: Direct fee collection
                        fees_collected: efficient_block.fees_collected,
                        // v3.27: State root for verification
                        state_root: efficient_block.state_root,
                        // v14.0: Timeout round for producer authority
                        timeout_round: efficient_block.timeout_round,
                        carried_baseline: efficient_block.carried_baseline,
                        // #80: proof lives on the wire (gossip ingest); local read never re-adopts.
                        timeout_proof: None,
                    };
                    
                    // Serialize as full MicroBlock for network transmission
                    let full_data = bincode::serialize(&full_block)
                        .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                    
                    microblocks.push((height, full_data));
                } else {
                    // Already in MicroBlock format (legacy) - use as-is
                    microblocks.push((height, raw_data));
                }
            } else {
                // Stop at the first gap: serve only the contiguous prefix so a requester never gets a
                // sparse batch that hides a missing height (it applies the prefix, repairs the gap elsewhere).
                break;
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
                
                // Verify it's a valid MacroBlock before sending, and that it still carries the
                // signatures the requester's verify needs — past the retention horizon it does not,
                // and serving it would look like a forged QC rather than an absent one.
                match bincode::deserialize::<qnet_state::MacroBlock>(&data) {
                    Ok(mb) if Self::macroblock_carries_qc_sigs(&mb) => macroblocks.push((index, data)),
                    Ok(_) => println!("[INFO][STORAGE] macroblock_qc_pruned index={} action=serve_absent", index),
                    Err(_) => println!("[WARN][STORAGE] invalid_macroblock_data index={}", index),
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

    /// Contiguous last-sealed-macroblock index — the seal frontier for production backpressure.
    pub fn last_sealed_mb_index(&self) -> u64 {
        self.persistent.last_sealed_mb_index()
    }
    
    /// Load microblock with automatic format detection.
    /// v12.1: Uses `microblock_fmt_{height}` metadata key for deterministic format selection.
    /// Falls back to try-both logic for blocks saved before v12.1 (backward compat).
    /// Handles Zstd compression transparently.
    /// v27 HOLE3: warm cache post-apply. No-op during rollback; prunes
    /// above rollback target + beyond window (never serves stale height).
    pub fn cache_recent_microblock(&self, height: u64, mb: &qnet_state::MicroBlock) {
        let (rb_in_progress, rb_target) = get_rollback_status();
        if rb_in_progress {
            self.recent_microblocks.retain(|&h, _| h <= rb_target);
            return;
        }
        self.recent_microblocks.insert(height, Arc::new(mb.clone()));
        let floor = height.saturating_sub(RECENT_MB_CACHE_CAP);
        if floor > 0 {
            self.recent_microblocks.retain(|&h, _| h >= floor);
        }
    }

    /// Canonical hash occupying a slot, if any.
    pub fn canonical_hash_at(&self, height: u64) -> Option<[u8; 32]> {
        self.persistent.load_microblock_hash(height).ok().flatten()
    }

    /// What occupies a slot. `Burned` is a legal, permanent answer once slots are exclusive: a
    /// silent leader's slot is never filled by anyone. Callers must treat it as "move on", not as
    /// a gap to repair — conflating the two is what turns a skipped slot into a stall.
    pub fn slot_status(&self, height: u64) -> SlotStatus {
        match self.canonical_hash_at(height) {
            Some(h) => SlotStatus::Block(h),
            None => SlotStatus::Unknown,
        }
    }

    /// Load a body by its hash, directly from the hash-keyed store. No height is involved, so a
    /// non-canonical sibling is just as loadable as the canonical block — which is what fork-choice
    /// needs in order to compare branches rather than delete one of them.
    pub fn load_body_by_hash(&self, hash: &[u8; 32]) -> Option<qnet_state::MicroBlock> {
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")?;
        match self.persistent.db.get_cf(&microblocks_cf, &block_body_key(hash)).ok()? {
            // Content addressing is only a guarantee if it is checked: a hash-keyed read must
            // return a body that actually hashes to the key, otherwise a corrupted or mis-keyed
            // row silently becomes "the block with that hash".
            Some(raw) => self.decode_stored_body(&raw).filter(|b| b.hash() == *hash),
            // Pre-hash-store blocks (written before this layout) still resolve through the height view.
            None => {
                let hdr = self.header_by_hash(hash)?;
                let body = self.load_microblock_auto_format(hdr.height).ok()??;
                if body.hash() == *hash { Some(body) } else { None }
            }
        }
    }

    /// Drop retained branches at or below `finalized_height`. Finality is 2f+1-irreversible, so a
    /// non-canonical block at a finalized height can never be adopted and only costs space. The
    /// canonical block is identified by the alias and is always kept — this is the ONLY place
    /// allowed to remove a body, which is what bounds the tree without weakening the store.
    pub fn prune_branches_below_finality(&self, finalized_height: u64) -> u64 {
        let (microblocks_cf, metadata_cf) = match (
            self.persistent.db.cf_handle("microblocks"),
            self.persistent.db.cf_handle("metadata"),
        ) {
            (Some(a), Some(b)) => (a, b),
            _ => return 0,
        };
        let mut batch = WriteBatch::default();
        let mut pruned = 0u64;
        // Markers retired without a body delete (the branch became canonical). Counted separately
        // so the batch is still written when every entry below finality is a winner — otherwise
        // those markers accumulate forever and, since the scan always restarts at brn_0, every
        // later finality advance re-walks them, turning this back into an O(chain) scan.
        let mut retired = 0u64;
        // Range-scan the BRANCH index only: its size is the number of retained forks, not the
        // length of the chain. Scanning every block header instead would make each finality
        // advance O(chain length) — unusable once the chain is millions of blocks long.
        let start = format!("brn_{:020}_", 0);
        let end_excl = format!("brn_{:020}_", finalized_height.saturating_add(1));
        let iter = self.persistent.db.iterator_cf(
            &metadata_cf,
            rocksdb::IteratorMode::From(start.as_bytes(), rocksdb::Direction::Forward),
        );
        for item in iter.flatten() {
            let (k, _) = item;
            if !k.starts_with(b"brn_") { break; }
            if k.as_ref() >= end_excl.as_bytes() { break; } // past the finality floor — still live
            if k.len() != 4 + 20 + 1 + 32 { continue; }
            let height: u64 = match std::str::from_utf8(&k[4..24]).ok().and_then(|s| s.parse().ok()) {
                Some(h) => h, None => continue,
            };
            let mut hash = [0u8; 32];
            hash.copy_from_slice(&k[25..]);
            // Keep whatever the canonical alias points at; drop only the losing siblings.
            if self.canonical_hash_at(height) == Some(hash) {
                batch.delete_cf(&metadata_cf, &k[..]); // it won — retire its branch marker
                // Winner is reachable by height from here on; the marker was the only pointer to its
                // hash-keyed copy, so dropping one without the other leaked ~10 KB per adopted block.
                batch.delete_cf(&microblocks_cf, &block_body_key(&hash));
                retired += 1;
                continue;
            }
            let prev = self.header_by_hash(&hash).map(|h| h.previous_hash);
            batch.delete_cf(&metadata_cf, &block_header_key(&hash));
            batch.delete_cf(&microblocks_cf, &block_body_key(&hash));
            if let Some(p) = prev {
                batch.delete_cf(&metadata_cf, &block_child_key(&p, &hash));
            }
            batch.delete_cf(&metadata_cf, &k[..]);
            pruned += 1;
        }
        if pruned > 0 || retired > 0 {
            if self.persistent.db.write(batch).is_ok() {
                if crate::node::is_info() {
                    println!("[INFO][STORAGE] branches_pruned count={} retired={} finalized_h={}",
                             pruned, retired, finalized_height);
                }
            } else { return 0; }
        }
        pruned
    }

    /// Store a block that lost (or has not yet won) the canonical slot. Body, header and child link
    /// only — no canonical alias, no chain height. Keeps a branch inspectable and re-adoptable
    /// without a network round-trip, and cannot affect the canonical chain by construction.
    pub fn retain_branch_block(&self, mb: &qnet_state::MicroBlock, raw: &[u8]) {
        let (microblocks_cf, metadata_cf) = match (
            self.persistent.db.cf_handle("microblocks"),
            self.persistent.db.cf_handle("metadata"),
        ) {
            (Some(a), Some(b)) => (a, b),
            _ => return,
        };
        let hash = mb.hash();
        let hdr = BlockHeaderIdx {
            height: mb.height,
            previous_hash: mb.previous_hash,
            producer: mb.producer.clone(),
            state_root: mb.state_root,
            timestamp: mb.timestamp,
            tx_count: mb.transactions.len() as u32,
        };
        let mut batch = WriteBatch::default();
        batch.put_cf(&microblocks_cf, &block_body_key(&hash), raw);
        if let Ok(b) = bincode::serialize(&hdr) {
            batch.put_cf(&metadata_cf, &block_header_key(&hash), &b);
        }
        batch.put_cf(&metadata_cf, &block_child_key(&mb.previous_hash, &hash), &[]);
        // Register in the branch index so pruning can find it without walking the whole chain.
        batch.put_cf(&metadata_cf, &branch_index_key(mb.height, &hash), &[]);
        if self.persistent.db.write(batch).is_ok() && crate::node::is_info() {
            println!("[INFO][STORAGE] branch_retained h={} hash={:x?} producer={}",
                     mb.height, &hash[..8], mb.producer);
        }
    }

    /// Hashes of every stored block that names `parent` as its predecessor — the branches leaving
    /// that point. Empty for a tip; more than one means a live fork this node can see in full.
    pub fn children_of(&self, parent: &[u8; 32]) -> Vec<[u8; 32]> {
        let metadata_cf = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return Vec::new() };
        let prefix = {
            let mut p = Vec::with_capacity(36);
            p.extend_from_slice(b"chd_");
            p.extend_from_slice(parent);
            p
        };
        let mut out = Vec::new();
        let iter = self.persistent.db.iterator_cf(
            &metadata_cf,
            rocksdb::IteratorMode::From(&prefix, rocksdb::Direction::Forward),
        );
        for item in iter.flatten() {
            let (k, _) = item;
            if !k.starts_with(&prefix) { break; }
            if k.len() == prefix.len() + 32 {
                let mut h = [0u8; 32];
                h.copy_from_slice(&k[prefix.len()..]);
                out.push(h);
            }
        }
        out
    }

    /// Decompress + reconstruct a stored body. Transactions are rehydrated through the existing
    /// height-based reconstruction so the hash-keyed read returns exactly the same block the
    /// canonical read does — the two views must never differ.
    fn decode_stored_body(&self, raw: &[u8]) -> Option<qnet_state::MicroBlock> {
        let bytes = if raw.len() >= 4 && raw[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
            zstd::decode_all(raw).ok()?
        } else {
            raw.to_vec()
        };
        let height = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&bytes).ok()
            .map(|e| e.height)
            .or_else(|| bincode::deserialize::<qnet_state::MicroBlock>(&bytes).ok().map(|m| m.height))?;
        self.reconstruct_from_efficient(&bytes, height).ok().flatten()
            .or_else(|| bincode::deserialize::<qnet_state::MicroBlock>(&bytes).ok())
    }

    /// Load the body canonically occupying a slot.
    pub fn load_canonical_body(&self, height: u64) -> Option<qnet_state::MicroBlock> {
        match self.slot_status(height) {
            SlotStatus::Block(h) => self.load_body_by_hash(&h),
            _ => None,
        }
    }

    /// Next slot at or after `from` that holds a block. Iteration must go through this rather than
    /// `h + 1`, so a burned slot is skipped instead of being mistaken for a missing block.
    pub fn next_present_height(&self, from: u64, ceiling: u64) -> Option<u64> {
        let mut h = from;
        while h <= ceiling {
            if matches!(self.slot_status(h), SlotStatus::Block(_)) { return Some(h); }
            h = h.saturating_add(1);
            if h == 0 { break; }
        }
        None
    }

    /// Resolve a block header by its hash. Content-addressed: the answer cannot be stale, because
    /// the key is derived from the very bytes it describes. This is what replaces height-keyed
    /// parent resolution — a rollback can invalidate a height, never a hash.
    pub fn header_by_hash(&self, hash: &[u8; 32]) -> Option<BlockHeaderIdx> {
        let metadata_cf = self.persistent.db.cf_handle("metadata")?;
        let raw = self.persistent.db.get_cf(&metadata_cf, &block_header_key(hash)).ok()??;
        bincode::deserialize::<BlockHeaderIdx>(&raw).ok()
    }

    /// Drop cached bodies above `target_height`. The retain inside the cache/load paths only runs
    /// if one of them is called while the rollback flag is set; an explicit sink guarantees the
    /// read-through cache can never serve a deleted height after the flag clears.
    pub fn invalidate_recent_microblocks_above(&self, target_height: u64) {
        self.recent_microblocks.retain(|&h, _| h <= target_height);
    }

    pub fn load_microblock_auto_format(&self, height: u64) -> IntegrationResult<Option<qnet_state::MicroBlock>> {
        // v27 HOLE3: read-through fast path. Skipped + pruned during
        // rollback (RocksDB authoritative; never serve rolled-back height).
        let (rb_in_progress, rb_target) = get_rollback_status();
        if rb_in_progress {
            self.recent_microblocks.retain(|&h, _| h <= rb_target);
        } else if let Some(cached) = self.recent_microblocks.get(&height) {
            return Ok(Some(cached.value().as_ref().clone()));
        }

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
        let fmt_key = mb_fmt_key(height);
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
            vrf_output: efficient_block.vrf_output,
            vrf_proof: efficient_block.vrf_proof,
            fees_collected: efficient_block.fees_collected,
            state_root: efficient_block.state_root,
            // v14.0: Timeout round for producer authority
            timeout_round: efficient_block.timeout_round,
            carried_baseline: efficient_block.carried_baseline,
            // #80: proof lives on the wire (gossip ingest); local read never re-adopts.
            timeout_proof: None,
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
    
    /// Compress archived data before long-term storage.
        
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
    /// - Tiered storage (v3.18+ — Light and Super only)
    /// - Pattern Recognition compression (89% for simple transfers)
    /// - EfficientMicroBlock format (hashes only + separate TX storage)
    /// - Adaptive Zstd compression (levels 3-22 based on age)
    /// - Graceful degradation when disk full
    /// 
    /// This method exists for backward compatibility with node.rs
    ///
    /// See `SaveOutcome` — anything but `Stored` means the block is NOT durable at this height.
    pub fn save_block_with_delta(&self, height: u64, data: &[u8]) -> IntegrationResult<SaveOutcome> {
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
    
    // recompress_old_blocks/_transactions_sync removed: the minimum recompression age
    // (2 days) exceeded MICROBLOCK_BODY_RETENTION_BLOCKS (1 day), so every candidate was
    // already pruned. It could never save a byte, yet each call did a full O(height) scan
    // plus an unconditional whole-CF compaction.

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
    
    // --- Sharded reward leaf-set (10M-scale claim serving) ---------------------------------------
    // The per-epoch reward set is partitioned into fixed-size shards of the SORTED (wallet, amount)
    // leaves. A claim loads exactly ONE shard + the shard-meta (K roots + K first-wallet bounds),
    // never the whole set, so proof generation is O(shard) memory/CPU regardless of recipient count.
    // The wire proof it produces is byte-identical to the monolithic single-tree proof, so
    // reward_root, the on-chain verify, and the mobile app are all unchanged. Keys are zero-padded
    // for O(1) range-delete pruning.

    /// Persist one reward shard's sorted (wallet, amount) leaf slice.
    pub fn save_epoch_reward_shard(&self, epoch: u64, shard: usize, wallets: &[(String, u64)]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("epoch_wshard_{:010}_{:06}", epoch, shard);
        let data = bincode::serialize(wallets)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        self.persistent.db.put_cf(&cf, key.as_bytes(), &data)?;
        Ok(())
    }

    /// Load one reward shard's sorted (wallet, amount) leaf slice.
    pub fn load_epoch_reward_shard(&self, epoch: u64, shard: usize) -> IntegrationResult<Option<Vec<(String, u64)>>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("epoch_wshard_{:010}_{:06}", epoch, shard);
        match self.persistent.db.get_cf(&cf, key.as_bytes())? {
            Some(data) => Ok(Some(bincode::deserialize(&data)
                .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?)),
            None => Ok(None),
        }
    }

    /// Persist per-epoch shard metadata: the K shard subtree-roots and the first wallet of each
    /// shard (ascending). The bounds enable an O(log K) binary-search to locate a claimant's shard.
    pub fn save_epoch_shard_meta(&self, epoch: u64, roots: &[[u8; 32]], bounds: &[String]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("epoch_shardmeta_{:010}", epoch);
        let roots_vec: Vec<[u8; 32]> = roots.to_vec();
        let bounds_vec: Vec<String> = bounds.to_vec();
        let data = bincode::serialize(&(roots_vec, bounds_vec))
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        self.persistent.db.put_cf(&cf, key.as_bytes(), &data)?;
        Ok(())
    }

    /// Load per-epoch shard metadata (K roots, K first-wallet bounds).
    pub fn load_epoch_shard_meta(&self, epoch: u64) -> IntegrationResult<Option<(Vec<[u8; 32]>, Vec<String>)>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("epoch_shardmeta_{:010}", epoch);
        match self.persistent.db.get_cf(&cf, key.as_bytes())? {
            Some(data) => Ok(Some(bincode::deserialize(&data)
                .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?)),
            None => Ok(None),
        }
    }

    /// Drop a single epoch's sharded reward set + meta (range-delete all its shards). Used by the
    /// finalization path when a locally-frozen set no longer matches the 2f+1-certified root.
    pub fn delete_epoch_reward_shards(&self, epoch: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let start = format!("epoch_wshard_{:010}_{:06}", epoch, 0usize);
        let end = format!("epoch_wshard_{:010}_{:06}", epoch + 1, 0usize);
        self.persistent.db.delete_range_cf(&cf, start.as_bytes(), end.as_bytes())?;
        let meta = format!("epoch_shardmeta_{:010}", epoch);
        self.persistent.db.delete_cf(&cf, meta.as_bytes())?;
        Ok(())
    }

    /// O(1) range-delete of the sharded leaf-set CACHE (epoch_wshard_/epoch_shardmeta_) for epochs <
    /// before_epoch. Leaves epoch_root_/super_elig_/light_bm_ intact, so any pruned epoch's claim
    /// self-heals by re-deriving + verifying against the committed root. Wired from persist_local_reward_root.
    pub fn prune_epoch_reward_shards(&self, before_epoch: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let wend = format!("epoch_wshard_{:010}_", before_epoch);
        self.persistent.db.delete_range_cf(&cf, &b"epoch_wshard_0000000000_"[..], wend.as_bytes())?;
        let mend = format!("epoch_shardmeta_{:010}", before_epoch);
        self.persistent.db.delete_range_cf(&cf, &b"epoch_shardmeta_0000000000"[..], mend.as_bytes())?;
        Ok(())
    }

    /// Persist a Light-node eligibility bitmap (decompressed) keyed by (epoch, genesis_idx),
    /// indexed at apply so the emission recompute reads ≤5 keys, not a 14400-block scan. Last
    /// write per (epoch,gidx) wins — identical to the in-order block scan it replaces, and it
    /// survives heartbeat-body pruning so an old epoch stays recomputable.
    /// LOWEST INCLUSION HEIGHT WINS. The stored value must not depend on whether a node's in-memory dedup map
    /// happened to accept the TX — that map is not durable, so a restarted node would otherwise
    /// resolve a different bitmap for the epoch and fork reward_root.
    pub fn save_light_bitmap(&self, epoch: u64, gidx: usize, incl_height: u64, bitmap: &[u8]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("light_bm_{}_{}", epoch, gidx);
        // Lowest inclusion height wins. Arrival order is node-local; the height is canonical, so
        // every node holding both inclusions of a duplicated bitmap converges on the same row.
        if let Some(prev) = self.persistent.db.get_cf(&cf, key.as_bytes())? {
            if prev.len() >= 8 {
                let mut hb = [0u8; 8];
                hb.copy_from_slice(&prev[..8]);
                if u64::from_be_bytes(hb) <= incl_height { return Ok(()); }
            }
        }
        // Value = inclusion height (8 B BE) || bitmap. The stamp lets a rollback delete exactly the
        // rows an orphaned block wrote; first-write-wins alone would strand them.
        let mut v = Vec::with_capacity(8 + bitmap.len());
        v.extend_from_slice(&incl_height.to_be_bytes());
        v.extend_from_slice(bitmap);
        self.persistent.db.put_cf(&cf, key.as_bytes(), &v)?;
        Ok(())
    }

    /// Persist a light node's per-epoch attestation (genesis restart resilience): the boundary bitmap TX
    /// is built from RAM only, so a mid-epoch restart would otherwise drop this shard's attestations.
    /// Zero-padded epoch key ⇒ O(1) range-delete prune. Idempotent.
    pub fn save_light_epoch_eligible(&self, epoch: u64, node_id: &str) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("lelig_{:010}_{}", epoch, node_id);
        self.persistent.db.put_cf(&cf, key.as_bytes(), &[1u8])?;
        Ok(())
    }

    /// Reload persisted light attestations for epochs >= from_epoch (boot rebuild of the RAM map).
    pub fn load_light_epoch_eligible(&self, from_epoch: u64) -> IntegrationResult<Vec<(u64, String)>> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let mut out = Vec::new();
        let start = format!("lelig_{:010}_", from_epoch);
        for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(start.as_bytes(), Direction::Forward)) {
            let (k, _) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("light_epoch_eligible iterator failed: {}", e))),
            };
            if !k.starts_with(b"lelig_") { break; }
            let s = match std::str::from_utf8(&k[6..]) { Ok(s) => s, Err(_) => continue };
            if s.len() < 12 { continue; }
            if let Ok(epoch) = s[..10].parse::<u64>() { out.push((epoch, s[11..].to_string())); }
        }
        Ok(out)
    }

    /// O(1) range-delete of persisted attestations for epochs < before_epoch (mirror the RAM 3-epoch prune).
    pub fn prune_light_epoch_eligible(&self, before_epoch: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let end = format!("lelig_{:010}_", before_epoch);
        self.persistent.db.delete_range_cf(&cf, &b"lelig_0000000000_"[..], end.as_bytes())?;
        Ok(())
    }

    /// Load the ≤5 Light eligibility bitmaps for an epoch as (genesis_idx → bitmap), sorted.
    pub fn load_light_bitmaps(&self, epoch: u64) -> IntegrationResult<std::collections::BTreeMap<usize, Vec<u8>>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let mut out = std::collections::BTreeMap::new();
        for gidx in 0..5usize {
            let key = format!("light_bm_{}_{}", epoch, gidx);
            if let Some(d) = self.persistent.db.get_cf(&cf, key.as_bytes())? {
                if d.len() > 8 { out.insert(gidx, d[8..].to_vec()); } // strip the height stamp
            }
        }
        Ok(out)
    }

    /// REORG ONLY: clear the CONSENSUS reward side-indices that an orphaned-fork block could have written
    /// above `up_to_height`, so the reorged node's emission `eligible` set cannot diverge from a from-genesis
    /// node (→ reward_root fork). Both are non-height-keyed, so orphans can only be pruned by epoch, and the
    /// two need DIFFERENT bounds because they update differently:
    ///   • super_elig_{E}_{node_id} is ADD-ONLY (save_super_eligible_batch never clears the epoch) and is
    ///     stamped at height (E+1)*14400. Any entry with E >= from_epoch was written STRICTLY above rollback_to
    ///     (a canonical node at rollback_to has not crossed that boundary) => pure orphan => clear. The live
    ///     forward pipeline re-derives super_elig_{from_epoch} from canonical account state when it re-crosses
    ///     the boundary. super_elig_{from_epoch-1} (stamped at from_epoch*14400 <= rollback_to) is legitimate
    ///     and preserved.
    ///   • light_bm_{E}_{gidx} is OVERWRITE-PER-KEY, so any epoch a genesis is online-on-canonical for self-
    ///     heals when it re-commits its bitmap. Clear only STRICTLY-FUTURE epochs (E > from_epoch): a canonical
    ///     node at rollback_to holds no legitimate bitmap for a future epoch, so those are pure orphans (covers
    ///     the rare genesis-offline-on-canonical case where no overwrite arrives). light_bm_{from_epoch} is
    ///     LEFT intact — it may be a legitimate current-epoch bitmap committed in the last-50-block window
    ///     at/below rollback_to, and clearing it risks a reward the reconcile-replay floor (snapshot <=
    ///     rollback_to) would not re-derive; an orphan copy self-heals via the canonical re-commit before that
    ///     epoch's emission.
    /// light_elig_ is deliberately NOT touched: it is a NON-consensus recency index (read only by /node/status
    /// for epochs {e-1,e-2} < from_epoch, never a cleared epoch), self-heals each boundary + range-prunes to
    /// ~3 epochs, and a full scan of its up-to-~40M rows under the rollback barrier would stall consensus for
    /// zero reward_root benefit. Call ONLY on the reorg-rollback path (forward re-apply follows); boot/snapshot
    /// inherit an already-reconciled index with no re-apply. Finalized past epochs are immutable + untouched.
    pub fn reconcile_reward_indices_above_epoch(&self, up_to_height: u64) -> IntegrationResult<u32> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        // Settle-aligned: super_elig_{E} is stamped at (E+1)*14400 + HB_ANCHOR_MAX_LAG, so a rollback
        // into that window must still clear epoch E. Dividing the bare height would keep it.
        let from_epoch = up_to_height.saturating_sub(crate::node::HB_ANCHOR_MAX_LAG) / 14400;
        let mut batch = rocksdb::WriteBatch::default();
        let mut cleared = 0u32;
        // (prefix, min_epoch_inclusive): super_elig_ clears the current epoch (its from_epoch entry is always
        // an orphan); light_bm_ only strictly-future (current-epoch bitmap may be legitimate + self-healing).
        // super_elig_ is epoch-keyed with no stamp: clear from the current epoch up.
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::From(b"super_elig_", rocksdb::Direction::Forward)) {
            let (k, _) = item.map_err(|e| IntegrationError::StorageError(
                format!("reconcile_reward_indices iterator error (reconcile incomplete): {}", e)))?;
            if !k.starts_with(b"super_elig_") { break; }
            let rest = &k[b"super_elig_".len()..];
            let end = rest.iter().position(|&b| b == b'_').unwrap_or(rest.len());
            if let Some(e) = std::str::from_utf8(&rest[..end]).ok().and_then(|s| s.parse::<u64>().ok()) {
                if e >= from_epoch { batch.delete_cf(&cf, &k); cleared += 1; }
            }
        }
        // light_bm_ carries its inclusion height, so delete EXACTLY the rows written above the
        // rollback target. Precise, and required now that the write is first-write-wins: a stranded
        // orphan bitmap would no longer be overwritten by the canonical re-commit.
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::From(b"light_bm_", rocksdb::Direction::Forward)) {
            let (k, v) = item.map_err(|e| IntegrationError::StorageError(
                format!("reconcile_reward_indices iterator error (reconcile incomplete): {}", e)))?;
            if !k.starts_with(b"light_bm_") { break; }
            if v.len() >= 8 {
                let h = u64::from_be_bytes(v[..8].try_into().unwrap_or([0u8; 8]));
                if h > up_to_height { batch.delete_cf(&cf, &k); cleared += 1; }
            }
        }
        if cleared > 0 { self.persistent.db.write(batch)?; }
        Ok(cleared)
    }

    /// Mark a super-node eligible for an epoch's reward (heartbeat popcount ≥ threshold), keyed
    /// per (epoch, node_id). Written at apply when the tally crosses the threshold — idempotent
    /// O(1) put. Lets the emission recompute read O(eligible) instead of an O(registered) per-super
    /// account scan. Deterministic: apply order = block order, and the tally is monotonic in-epoch.
    pub fn save_super_eligible(&self, epoch: u64, node_id: &str) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("super_elig_{}_{}", epoch, node_id);
        self.persistent.db.put_cf(&cf, key.as_bytes(), &[])?;
        Ok(())
    }

    /// Batch-load accounts from the persistent `accounts` CF in ONE RocksDB multi_get (vs N single
    /// reads). Lets the epoch-boundary super-eligibility pass resolve a large EVICTED-super set with a
    /// single batched I/O instead of sequential cold reads that would stall the boundary block at scale.
    /// Order matches `addresses`; missing/undecodable → None.
    pub fn load_accounts_batch(&self, addresses: &[String]) -> Vec<Option<qnet_state::Account>> {
        let cf = match self.persistent.db.cf_handle("accounts") {
            Some(c) => c,
            None => return vec![None; addresses.len()],
        };
        self.persistent.db
            .multi_get_cf(addresses.iter().map(|a| (&cf, a.as_bytes())))
            .into_iter()
            .map(|r| match r { Ok(Some(b)) => bincode::deserialize(&b).ok(), _ => None })
            .collect()
    }

    /// Genesis-local PERSISTENT burn-attestation dedup (one burn_tx → one wallet). Survives process
    /// restart — the prior in-memory map was wiped on restart, letting one burn back >1 node across
    /// restarts. Genesis-node-local memory (NOT consensus state); under honest 2f+1 genesis a reused
    /// burn can never reach the on-chain quorum because honest attestors refuse to re-sign it.
    /// Keyed on the NODE, not the wallet. One wallet has two distinct pseudonyms (super and light), so a
    /// wallet-keyed dedup let a single 1DEV burn back BOTH — the cost is tier-independent and node_type is
    /// inside the signed message, so the second registration was fully valid. One burn, one node.
    pub fn attested_burn_put(&self, burn_tx: &str, node_id: &str) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, format!("attburn_{}", burn_tx).as_bytes(), node_id.as_bytes())?;
        Ok(())
    }

    /// The node_id this genesis already attested for `burn_tx`, or None.
    pub fn attested_burn_get(&self, burn_tx: &str) -> IntegrationResult<Option<String>> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        match self.persistent.db.get_cf(&cf, format!("attburn_{}", burn_tx).as_bytes())? {
            Some(v) => Ok(Some(String::from_utf8_lossy(&v).to_string())),
            None => Ok(None),
        }
    }

    /// Attestor-local cache of a Solana-verified burn: burn_tx → actual burned amount. Written on the
    /// first successful live getTransaction verify so throttle re-polls never re-hit Solana for the
    /// same burn. Admission-side only, never consensus.
    pub fn attest_burn_verified_put(&self, burn_tx: &str, burner: &str, actual_burned: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, format!("attburnv_{}_{}", burn_tx, burner).as_bytes(), actual_burned.to_le_bytes())?;
        Ok(())
    }

    /// Cached Solana-verified burned amount for (burn_tx, burner), or None if never verified.
    /// Keyed by BOTH: the attestor now signs the burner address, so a cache hit must not let a second
    /// caller claim the same burn under a different sender and skip the fee-payer check.
    pub fn attest_burn_verified_get(&self, burn_tx: &str, burner: &str) -> IntegrationResult<Option<u64>> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        match self.persistent.db.get_cf(&cf, format!("attburnv_{}_{}", burn_tx, burner).as_bytes())? {
            Some(v) if v.len() == 8 => Ok(Some(u64::from_le_bytes(v[..8].try_into().unwrap_or([0u8; 8])))),
            _ => Ok(None),
        }
    }

    /// COMMITTED burn→wallet binding (on-chain uniqueness, NOT the genesis-local attested_burn).
    /// Written FIRST-WINS when a burn-backed NodeRegistration is applied; read at block-validation
    /// (verify_burn_attestation_quorum) to reject a second registration reusing the same burn for a
    /// different wallet. With a ROTATING committee the genesis-local dedup is insufficient (disjoint
    /// honest sub-committees could each attest the same burn); this committed binding is the
    /// deterministic global stop. Idempotent (only sets if unset → binding immutable).
    /// Bound to the NODE, not the wallet — see attested_burn_put. First-wins and immutable.
    pub fn committed_burn_wallet_put(&self, burn_tx: &str, node_id: &str) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let key = format!("cbw_{}", burn_tx);
        if self.persistent.db.get_cf(&cf, key.as_bytes())?.is_none() {
            self.persistent.db.put_cf(&cf, key.as_bytes(), node_id.as_bytes())?;
        }
        Ok(())
    }

    /// The node_id a `burn_tx` is committed-bound to on-chain, or None.
    pub fn committed_burn_wallet_get(&self, burn_tx: &str) -> IntegrationResult<Option<String>> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        match self.persistent.db.get_cf(&cf, format!("cbw_{}", burn_tx).as_bytes())? {
            Some(v) => Ok(Some(String::from_utf8_lossy(&v).to_string())),
            None => Ok(None),
        }
    }

    /// True iff `wallet` has a chain-confirmed burn-attested NodeRegistration — a node_ entry with a
    /// non-empty backing burn. Gates NodeActivation (which carries no burn of its own) at verify: an
    /// activation is valid only for a wallet that already proved a burn at registration, so a raw
    /// activation cannot mint a node identity (super pseudonym / reward-eligible row) for free.
    /// Derives the node_id (resolve_node_id) then one O(1) point-read of the node_ entry. Genesis
    /// registrations carry an empty burn (and never activate), so this correctly returns false for them.
    pub fn wallet_is_burn_registered(&self, wallet: &str) -> bool {
        let cf = match self.persistent.db.cf_handle("node_registry") { Some(c) => c, None => return false };
        let nid = match self.resolve_node_id(wallet) { Some(n) => n, None => return false };
        match self.persistent.db.get_cf(&cf, format!("node_{}", nid).as_bytes()) {
            Ok(Some(v)) => serde_json::from_slice::<serde_json::Value>(&v).ok()
                .and_then(|j| j["burn"].as_str().map(|b| !b.is_empty())).unwrap_or(false),
            _ => false,
        }
    }

    /// True iff `wallet` belongs to a GENESIS bootstrap node — constant-table membership. Genesis nodes
    /// are protocol-minted and activate WITHOUT a 1DEV burn (they ARE the bootstrap), so the
    /// NodeActivation burn-gate must exempt them — mirroring exactly the registration burn-attestation
    /// gate's genesis exemption. Without this, a genesis self-activation (empty burn) is wrongly dropped.
    pub fn wallet_is_genesis_node(&self, wallet: &str) -> bool {
        // Genesis membership is the constant table — no row lookup needed.
        crate::genesis_constants::GENESIS_WALLETS.iter().any(|(_, w)| *w == wallet)
    }

    /// Rebuild the committed burn→wallet index (cbw_) DETERMINISTICALLY from the chain-confirmed
    /// node_ registry entries, considering ONLY registrations with reg_height <= up_to_height.
    /// cbw is a pure DERIVED index, never deleted per-block — so a snapshot/fast-sync join (restores
    /// node_registry but not the 'metadata' CF where cbw lives) and any node after a reorg reconstruct
    /// a cbw IDENTICAL to a from-genesis node. The reg_height<=up_to bound excludes orphaned
    /// registrations on reorg (no per-block delete, no absence window). First-wins by (reg_height,
    /// node_id): the earliest canonical registration of a burn owns it. Atomic: the old cbw_ region is
    /// cleared and the rebuilt set written in ONE WriteBatch (no reader observes an empty intermediate).
    /// Scans BOTH roster indices — `srtr_` (super/genesis) and `lrtr_` (light, also burn-attested
    /// on-chain) — so cbw covers every burn-backed registration (see the in-loop note). Rebuild is
    /// O(registrations) but rare (boot/snapshot/reorg); the per-block path is incremental O(1).
    pub fn rebuild_committed_burn_wallet(&self, up_to_height: u64) -> IntegrationResult<u32> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut cands: Vec<(u64, String, String, String)> = Vec::new();
        // Scan BOTH roster indices: srtr_ (super/genesis) AND lrtr_ (light). Light nodes are also
        // burn-attested on-chain (Option A), so their burn→wallet binding must enter cbw and be
        // reconstructed here EXACTLY like the incremental (all-types) writers — else live-vs-rebuild
        // cbw diverges → fork. burn lives only in the node_ JSON (point-read), not in the index value.
        for prefix in [b"srtr_".as_ref(), b"lrtr_".as_ref()] {
            for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward)) {
                let (k, _) = match item {
                    Ok(kv) => kv,
                    Err(e) => return Err(IntegrationError::StorageError(
                        format!("cbw_rebuild_super iterator failed: {}", e))),
                };
                if !k.starts_with(prefix) { break; }
                let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s, Err(_) => continue };
                // Point-read the node_ entry for the co-resident (reg_height, burn, wallet).
                let nk = format!("node_{}", node_id);
                let val = match self.persistent.db.get_cf(&registry_cf, nk.as_bytes()) { Ok(Some(v)) => v, _ => continue };
                let parsed: serde_json::Value = match serde_json::from_slice(&val) { Ok(p) => p, Err(_) => continue };
                let h = match parsed["reg_height"].as_u64() { Some(h) => h, None => continue }; // chain-confirmed only
                if h > up_to_height { continue; } // orphan/above-bound exclusion
                let burn = parsed["burn"].as_str().unwrap_or("");
                let wallet = parsed["wallet"].as_str().unwrap_or("");
                if burn.is_empty() || wallet.is_empty() { continue; }
                cands.push((h, node_id.to_string(), burn.to_string(), wallet.to_string()));
            }
        }
        cands.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        // Bind the NODE, byte-identical to the live writer (write_registration_row). A wallet-keyed bind
        // let one burn back both of a wallet's pseudonyms; the rebuild must key the same way or a
        // reorg/boot recompute would disagree with the incremental writer.
        let mut bound: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for (_, node_id, burn, _wallet) in cands { bound.entry(burn).or_insert(node_id); }
        let mut batch = rocksdb::WriteBatch::default();
        for item in self.persistent.db.iterator_cf(&metadata_cf, IteratorMode::From(b"cbw_".as_ref(), Direction::Forward)) {
            let (k, _) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("cbw_rebuild_light iterator failed: {}", e))),
            };
            if !k.starts_with(b"cbw_") { break; }
            batch.delete_cf(&metadata_cf, &k);
        }
        let count = bound.len() as u32;
        for (burn, node_id) in bound {
            batch.put_cf(&metadata_cf, format!("cbw_{}", burn).as_bytes(), node_id.as_bytes());
        }
        self.persistent.db.write(batch)?;
        Ok(count)
    }

    /// Key of the running registry_root LtHash accumulator (metadata CF). One 2048-byte blob updated
    /// incrementally by save_node_registration_inner; recomputed from scratch on reorg/boot/snapshot.
    /// Monotone sources of `reg_index`, one per index space. In the metadata CF, not RAM: they feed
    /// a hashed field. Value = INDEX_SPACES x u32 BE.
    const REGISTRY_NEXT_INDEX_KEY: &'static [u8] = b"registry_next_index";

    /// Index spaces: 0 = super/genesis, 1..=5 = light shard 0..4.
    ///
    /// A single global counter made every light shard's bitmap span the WHOLE registry, because the
    /// shard is `blake3(node_id) % 5` and is independent of the index — so each shard's highest
    /// member sat at the top of the space. At 10M lights that is a 1.26 MB raw bitmap per shard,
    /// ~840 KB compressed, against a 500,000-byte per-transaction cap: the light reward path stops
    /// emitting at ~60% of target. Ranking inside the node's own space keeps the ordinal just as
    /// permanent (the shard is a pure function of an immutable id) and drops the span to the shard's
    /// own size.
    pub(crate) const INDEX_SPACES: usize = 6;

    fn index_space_of(node_id: &str, node_type: &str) -> Option<usize> {
        if node_id.starts_with("super_") || node_id.starts_with("genesis_node_") {
            Some(0)
        } else if node_type == "light" {
            Some(1 + crate::node::light_shard_of(node_id))
        } else {
            None
        }
    }

    fn load_next_indices(&self, meta_cf: &rocksdb::ColumnFamily) -> [u32; Self::INDEX_SPACES] {
        let mut out = [0u32; Self::INDEX_SPACES];
        if let Ok(Some(v)) = self.persistent.db.get_cf(meta_cf, Self::REGISTRY_NEXT_INDEX_KEY) {
            if v.len() == Self::INDEX_SPACES * 4 {
                for i in 0..Self::INDEX_SPACES {
                    out[i] = u32::from_be_bytes([v[4 * i], v[4 * i + 1], v[4 * i + 2], v[4 * i + 3]]);
                }
            }
        }
        out
    }

    /// Chain-confirmed registered-node count: the sum of the per-index-space monotone counters,
    /// each advanced only by a registration that reached chain-apply. O(1) point read. Feeds the
    /// Phase-2 price multiplier, which needs a COMMITTED network size rather than a peer count.
    pub fn registered_node_count(&self) -> u64 {
        let meta_cf = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return 0 };
        self.load_next_indices(&meta_cf).iter().map(|n| *n as u64).sum()
    }

    fn next_indices_bytes(v: &[u32; Self::INDEX_SPACES]) -> Vec<u8> {
        let mut out = Vec::with_capacity(Self::INDEX_SPACES * 4);
        for n in v.iter() {
            out.extend_from_slice(&n.to_be_bytes());
        }
        out
    }
    const REGISTRY_LT_STATE_KEY: &'static [u8] = b"registry_lt_state";
    /// How far back per-checkpoint-head seals are retained (~1 epoch of 30-block heads). A read that
    /// misses a pruned seal falls back to the O(N) from-scratch recompute — correctness, not just perf.
    const REGISTRY_SEAL_RETENTION: u64 = 14400;

    /// Load the running registry_root LtHash accumulator (empty if absent / not yet built).
    fn registry_lt_load(&self) -> crate::registry_lthash::LtHash {
        let cf = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return crate::registry_lthash::LtHash::new() };
        match self.persistent.db.get_cf(&cf, Self::REGISTRY_LT_STATE_KEY) {
            Ok(Some(v)) => crate::registry_lthash::LtHash::from_bytes(&v),
            _ => crate::registry_lthash::LtHash::new(),
        }
    }

    // ── FIX-5: dilithium_pk_root — QC-signed LtHash over committed (address -> ML-DSA-65 pk) bindings ──
    const DPK_LT_STATE_KEY: &'static [u8] = b"dpk_lt_state";

    fn dpk_lt_load(&self) -> crate::registry_lthash::LtHash {
        let cf = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return crate::registry_lthash::LtHash::new() };
        match self.persistent.db.get_cf(&cf, Self::DPK_LT_STATE_KEY) {
            Ok(Some(v)) => crate::registry_lthash::LtHash::from_bytes(&v),
            _ => crate::registry_lthash::LtHash::new(),
        }
    }

    fn dpk_root_seal_get(&self, height: u64) -> Option<[u8; 32]> {
        let cf = self.persistent.db.cf_handle("metadata")?;
        let mut key = b"dpkr_seal_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        match self.persistent.db.get_cf(&cf, &key) {
            Ok(Some(v)) if v.len() == 32 => { let mut out = [0u8; 32]; out.copy_from_slice(&v); Some(out) }
            _ => None,
        }
    }

    /// From-scratch: fold every account holding a bound 1952-byte ML-DSA-65 pk. O(accounts-with-pk).
    /// Fallback for `compute_dilithium_pk_root` + source for `rebuild_dilithium_pk_lthash`.
    fn dpk_lt_from_accounts(&self) -> Option<crate::registry_lthash::LtHash> {
        self.dpk_lt_from_accounts_cf("accounts")
    }

    /// From-scratch dpk accumulator over an explicit accounts CF: "accounts" (live recompute /
    /// boot / reorg) or "accounts_stage" (cold-join snapshot-verify, before promotion). Order-
    /// independent, so iteration order is irrelevant — identical root on every node.
    /// None = FAIL CLOSED: dilithium_pk_root is a hashed checkpoint field, so a partial scan is a
    /// different commitment on this node, not a smaller key set.
    fn dpk_lt_from_accounts_cf(&self, cf_name: &str) -> Option<crate::registry_lthash::LtHash> {
        let mut lt = crate::registry_lthash::LtHash::new();
        let cf = self.persistent.db.cf_handle(cf_name)?;
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start) {
            let (_, v) = match item {
                Ok(kv) => kv,
                Err(e) => {
                    println!("[CRIT][DPK] accounts_scan_failed cf={} err={}", cf_name, e);
                    return None;
                }
            };
            let acct: qnet_state::Account = match bincode::deserialize(&v) { Ok(a) => a, Err(_) => continue };
            if let Some(ref pk) = acct.dilithium_public_key {
                if pk.len() == 1952 { lt.add(&crate::registry_lthash::pk_row_lanes(&acct.address, pk)); }
            }
        }
        Some(lt)
    }

    /// Recompute `dilithium_pk_root` from the STAGED accounts (`accounts_stage`) for the untrusted-
    /// snapshot verify — mirror of `compute_registry_root_staged`. No seal exists during staging, so
    /// this is always the from-scratch scan over the restored per-account pubkeys.
    pub fn compute_dilithium_pk_root_staged(&self) -> Option<[u8; 32]> {
        Some(self.dpk_lt_from_accounts_cf("accounts_stage")?.root())
    }

    /// QC-signed digest of ALL committed (address -> ML-DSA-65 pk) bindings. FAST PATH = the per-
    /// checkpoint seal; FALLBACK = one from-scratch O(active-senders) accounts scan (only on a snapshot
    /// cold-join before the anchor seal exists). Bound into the macroblock Checkpoint as
    /// `dilithium_pk_root` so a node joining via an UNTRUSTED snapshot verifies its restored per-account
    /// pubkeys match the 2f+1-committed set — closing the elided-pk snapshot DoS at 100k cold-join.
    /// The pk is write-once + immutable, so the accumulator == its value as-of any height >= last bind;
    /// the seal pins the checkpoint head for the light client + snapshot verify.
    pub fn compute_dilithium_pk_root(&self, height: u64) -> Option<[u8; 32]> {
        if let Some(seal) = self.dpk_root_seal_get(height) { return Some(seal); }
        Some(self.dpk_lt_from_accounts()?.root())
    }

    /// Seal-STRICT variant for CONSENSUS compute sites (checkpoint fields). Fast path = the per-head seal;
    /// on a MISS it HEALS from the live accumulator when the pk-bind watermark proves it still equals the
    /// as-of-`height` value (recovery for a dropped seal-write — see body), else `None` ⇒ the caller DEFERS.
    /// It never falls back to the lossy tip-scoped accounts scan: that set is as-of this node's TIP, not
    /// `height`, and pk carries no height, so publishing it would diverge from peers whenever a first-use
    /// bind lands in (height, tip]. Snapshot cold-join keeps the scan.
    pub fn compute_dilithium_pk_root_sealed(&self, height: u64) -> Option<[u8; 32]> {
        if let Some(seal) = self.dpk_root_seal_get(height) { return Some(seal); }
        // Recovery for a dropped seal-write: a transient RocksDB error at apply must NOT permanently mute
        // this node's checkpoint votes at `height` (the finality-lag redrive re-signals the same head and
        // would hit the same miss). pk is write-once, so the live accumulator == its as-of-`height` value
        // IFF no bind landed after `height` — the watermark proves that. Re-seal from the live accumulator
        // and return it. If a later bind diverged the accumulator, the as-of-`height` value is truly
        // unrecoverable ⇒ still defer (None): quorum tolerates one node's rare residual defer.
        if height >= self.dpk_last_bind_height() && self.seal_dilithium_pk_root(height).is_ok() {
            return self.dpk_root_seal_get(height);
        }
        None
    }

    /// Bind an account's pk into the incremental LtHash exactly ONCE (marker `dpkctd_{addr}`). Called
    /// from the DETERMINISTIC apply-commit (producer-inline AND validator) for each value-TX sender
    /// whose account now carries a pk — NEVER the detached accounts persist (flush-timing non-det).
    /// pk write-once ⇒ marker makes re-calls idempotent. One WriteBatch (accumulator + marker + journal
    /// atomic). The journal row `dpkj_{height}{addr}` = 32-byte row seed gives the bind a HEIGHT, so a
    /// reorg can subtract exactly the orphaned binds (rollback_dpk_binds_above) — the same height-bound
    /// discipline cbw/registry_lthash already have. Pruned once the height is finality-covered.
    pub fn dpk_lt_bind(&self, address: &str, pk: &[u8], height: u64) -> IntegrationResult<()> {
        if pk.len() != 1952 { return Ok(()); }
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata cf missing".to_string()))?;
        let mut marker = b"dpkctd_".to_vec();
        marker.extend_from_slice(address.as_bytes());
        if matches!(self.persistent.db.get_cf(&cf, &marker), Ok(Some(_))) { return Ok(()); }
        let seed = crate::registry_lthash::pk_row_seed(address, pk);
        let mut lt = self.dpk_lt_load();
        lt.add(&crate::registry_lthash::lanes_from_seed(&seed));
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(&cf, Self::DPK_LT_STATE_KEY, lt.to_bytes().as_ref());
        batch.put_cf(&cf, &marker, &[1u8]);
        let mut jk = b"dpkj_".to_vec();
        jk.extend_from_slice(&height.to_be_bytes());
        jk.extend_from_slice(address.as_bytes());
        batch.put_cf(&cf, &jk, &seed);
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// Reorg heal: subtract every journaled bind with height > `target` — the exact inverse of
    /// dpk_lt_bind per orphaned entry, so the accumulator matches a from-genesis node at `target`.
    /// Also drops the orphaned markers (unblocks the canonical re-bind) and stale seals above `target`.
    /// O(rolled-back binds); one atomic batch, accumulator co-written. Call INSIDE the rollback barrier
    /// only (applies quiesced ⇒ no concurrent bind). The bind watermark may now over-report — safe:
    /// heal-on-read only gets stricter.
    pub fn rollback_dpk_binds_above(&self, target: u64) -> IntegrationResult<u32> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata cf missing".to_string()))?;
        let mut lt = self.dpk_lt_load();
        let mut batch = rocksdb::WriteBatch::default();
        let mut n = 0u32;
        let mut from = b"dpkj_".to_vec();
        from.extend_from_slice(&(target.saturating_add(1)).to_be_bytes());
        for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(&from, Direction::Forward)) {
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("dpk_journal_rollback iterator failed: {}", e))),
            };
            if !k.starts_with(b"dpkj_") { break; }
            if v.len() == 32 && k.len() > 13 {
                let mut seed = [0u8; 32];
                seed.copy_from_slice(&v);
                lt.remove(&crate::registry_lthash::lanes_from_seed(&seed));
                let mut m = b"dpkctd_".to_vec();
                m.extend_from_slice(&k[13..]);
                batch.delete_cf(&cf, &m);
                n += 1;
            }
            batch.delete_cf(&cf, &k);
        }
        // Seals above target are orphan-branch values; canonical re-apply re-seals each head.
        let mut sfrom = b"dpkr_seal_".to_vec();
        sfrom.extend_from_slice(&(target.saturating_add(1)).to_be_bytes());
        for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(&sfrom, Direction::Forward)) {
            let (k, _) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("dpk_journal_rollback_prune iterator failed: {}", e))),
            };
            if !k.starts_with(b"dpkr_seal_") { break; }
            batch.delete_cf(&cf, &k);
        }
        if n > 0 {
            batch.put_cf(&cf, Self::DPK_LT_STATE_KEY, lt.to_bytes().as_ref());
        }
        self.persistent.db.write(batch)?;
        Ok(n)
    }

    /// Highest block height at which a pk bind mutated the accumulator. `compute_dilithium_pk_root_sealed`
    /// heals a lost seal only for heights >= this: pk is write-once, so the live accumulator still equals
    /// the as-of-height value there, whereas a later bind makes an earlier head's value unrecoverable.
    pub fn dpk_last_bind_height(&self) -> u64 {
        let cf = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return 0 };
        match self.persistent.db.get_cf(&cf, b"dpk_last_bind_h") {
            Ok(Some(v)) if v.len() == 8 => u64::from_be_bytes(v[..8].try_into().unwrap_or_default()),
            _ => 0,
        }
    }

    /// Advance the pk-bind watermark to `max(current, height)` — monotonic, since a reorg re-applying a
    /// lower head re-adds nothing under the write-once markers, so the watermark must never regress.
    /// Called once per block whose apply drained >=1 pk bind, on both apply paths.
    pub fn note_dpk_bind_height(&self, height: u64) -> IntegrationResult<()> {
        if height <= self.dpk_last_bind_height() { return Ok(()); }
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata cf missing".to_string()))?;
        self.persistent.db.put_cf(&cf, b"dpk_last_bind_h", &height.to_be_bytes())?;
        Ok(())
    }

    /// Seal `dpkr_seal_{H}` = sha3(dpk_lt) at a checkpoint head (mirror seal_registry_root); prune one
    /// retention window down. Called on BOTH apply paths beside seal_registry_root, after the binds.
    pub fn seal_dilithium_pk_root(&self, height: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata cf missing".to_string()))?;
        let root = self.dpk_lt_load().root();
        let mut batch = rocksdb::WriteBatch::default();
        let mut key = b"dpkr_seal_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        batch.put_cf(&cf, &key, &root);
        if height >= Self::REGISTRY_SEAL_RETENTION {
            let mut old = b"dpkr_seal_".to_vec();
            old.extend_from_slice(&(height - Self::REGISTRY_SEAL_RETENTION).to_be_bytes());
            batch.delete_cf(&cf, &old);
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// Prune bind-journal entries at/below `finalized_height` — the caller passes the SAME value that
    /// guards `begin_finality_guarded_rollback`, so no still-rollback-eligible bind is ever dropped (the
    /// local macroblock-body frontier runs AHEAD of finality during catch-up and MUST NOT be the floor).
    /// INVARIANT: call ONLY from the LIVE post-boot apply path — LAST_FINALIZED_HEIGHT is then settled and
    /// only advances (fetch_max), so prune-floor <= any future rollback floor. The two boot content-gate
    /// stores (which may LOWER finality to enable fork-healing rollback) run before the first live prune.
    /// Cap bounds one call; the FIFO-oldest remainder drains at the next checkpoint head (self-draining,
    /// no starvation) — a mass first-use burst is a bounded transient, never unbounded growth.
    pub fn prune_dpk_journal(&self, finalized_height: u64) -> IntegrationResult<()> {
        use rocksdb::{IteratorMode, Direction};
        if finalized_height == 0 { return Ok(()); }
        let cf = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return Ok(()) };
        let mut batch = rocksdb::WriteBatch::default();
        let mut pruned = 0u32;
        for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(b"dpkj_", Direction::Forward)) {
            let (k, _) = match item { Ok(kv) => kv, Err(_) => break };
            if !k.starts_with(b"dpkj_") || k.len() < 13 { break; }
            let h = u64::from_be_bytes(k[5..13].try_into().unwrap_or_default());
            if h > finalized_height || pruned >= 100_000 { break; }
            batch.delete_cf(&cf, &k);
            pruned += 1;
        }
        if pruned > 0 { self.persistent.db.write(batch)?; }
        Ok(())
    }

    /// Rebuild dpk_lt + the `dpkctd_` markers from the accounts CF (boot + post-snapshot-apply +
    /// post-reorg self-heal). Mirror rebuild_registry_lthash. Setting markers here is load-bearing: a
    /// later re-assertion of an existing account's pk must NOT double-add after a rebuild. CRITICAL for
    /// reorg: FIRST wipe every stale `dpkctd_` marker (the accounts CF is height-versioned, so a
    /// rollback can strip an account's pk — but the marker lives in the un-rolled-back metadata CF; a
    /// surviving marker would make the canonical re-bind a silent no-op ⇒ the accumulator drifts from a
    /// from-genesis node ⇒ dilithium_pk_root fork). One atomic batch: clear markers → re-add present.
    /// Shared core: clear every count-marker, then fold each authoritative (address, pk) bind into a
    /// fresh LtHash, writing the accumulator LAST. Chunked so neither the marker sweep nor the fold
    /// spikes memory at target scale (millions of value-sending accounts). Crash-safety: the accumulator
    /// key is written last, and a crash mid-rebuild leaves stale markers the next rebuild clears first.
    fn rebuild_dpk_lthash_core<I: Iterator<Item = (String, Vec<u8>)>>(&self, binds: I) -> IntegrationResult<u32> {
        use rocksdb::{IteratorMode, Direction};
        const DPK_REBUILD_CHUNK: usize = 20_000;
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata cf missing".to_string()))?;
        let mut lt = crate::registry_lthash::LtHash::new();
        let mut batch = rocksdb::WriteBatch::default();
        let mut pending = 0usize;
        // Clear every existing count-marker so a rollback-orphaned account cannot block its re-bind.
        let mprefix = b"dpkctd_".as_ref();
        for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(mprefix, Direction::Forward)) {
            let (k, _) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("dpk_lthash_marker iterator failed: {}", e))),
            };
            if !k.starts_with(mprefix) { break; }
            batch.delete_cf(&cf, &k);
            pending += 1;
            if pending >= DPK_REBUILD_CHUNK {
                self.persistent.db.write(std::mem::take(&mut batch))?;
                pending = 0;
            }
        }
        let mut n = 0u32;
        for (address, pk) in binds {
            if pk.len() != 1952 { continue; }
            lt.add(&crate::registry_lthash::pk_row_lanes(&address, &pk));
            let mut m = b"dpkctd_".to_vec();
            m.extend_from_slice(address.as_bytes());
            batch.put_cf(&cf, &m, &[1u8]);
            n += 1;
            pending += 1;
            if pending >= DPK_REBUILD_CHUNK {
                self.persistent.db.write(std::mem::take(&mut batch))?;
                pending = 0;
            }
        }
        // Accumulator LAST: it is the value every reader trusts, so it must not become visible before the
        // markers that justify it.
        batch.put_cf(&cf, Self::DPK_LT_STATE_KEY, lt.to_bytes().as_ref());
        self.persistent.db.write(batch)?;
        // A rebuild sets the accumulator to as-of-tip WITHOUT per-bind heights, so the heal-on-read guard
        // in compute_dilithium_pk_root_sealed must not keep trusting a watermark that predates it: raise
        // the watermark to the tip. Monotonic max ⇒ this only ever makes the guard STRICTER (defer instead
        // of heal), never looser, so it cannot introduce a wrong-heal on any path.
        let _ = self.note_dpk_bind_height(self.get_chain_height().unwrap_or(0));
        // Journal consistency after a full refold: an entry whose marker was NOT re-created belongs to
        // a bind absent from the rebuilt set — drop it so a later reorg cannot subtract a row the
        // accumulator no longer holds. O(journal) = unfinalized window only.
        {
            use rocksdb::{IteratorMode, Direction};
            let mut jbatch = rocksdb::WriteBatch::default();
            for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(b"dpkj_", Direction::Forward)) {
                let (k, _) = match item {
                    Ok(kv) => kv,
                    Err(e) => return Err(IntegrationError::StorageError(
                        format!("dpk_lthash_bind iterator failed: {}", e))),
                };
                if !k.starts_with(b"dpkj_") || k.len() < 13 { break; }
                let mut m = b"dpkctd_".to_vec();
                m.extend_from_slice(&k[13..]);
                if !matches!(self.persistent.db.get_cf(&cf, &m), Ok(Some(_))) {
                    jbatch.delete_cf(&cf, &k);
                }
            }
            self.persistent.db.write(jbatch)?;
        }
        Ok(n)
    }

    /// Recompute the dpk accumulator by SCANNING the accounts CF. Correct ONLY on the snapshot paths
    /// (apply + promote), where that CF *is* the verified restored state. NOT for boot (best-effort CF
    /// tail can be lost — boot feeds the in-memory tip via `rebuild_dilithium_pk_lthash_from`) and NOT
    /// for reorg (the rollback subtracts journaled binds via `rollback_dpk_binds_above`).
    pub fn rebuild_dilithium_pk_lthash(&self) -> IntegrationResult<u32> {
        let acf = match self.persistent.db.cf_handle("accounts") { Some(c) => c, None => return Ok(0) };
        let src = self.persistent.db.iterator_cf(&acf, rocksdb::IteratorMode::Start)
            .filter_map(|item| {
                let (_, v) = item.ok()?;
                let acct: qnet_state::Account = bincode::deserialize(&v).ok()?;
                let pk = acct.dilithium_public_key?;
                if pk.len() == 1952 { Some((acct.address, pk)) } else { None }
            });
        self.rebuild_dpk_lthash_core(src)
    }

    /// Recompute the dpk accumulator from an EXPLICIT authoritative (address, pk) set. The boot path feeds
    /// the in-memory StateManager tip here: the applied microblock log is authoritative, while the accounts
    /// CF is a best-effort background mirror whose tail an unclean restart can drop — scanning it at boot
    /// would omit rows AND clear their markers, forking that node's dilithium_pk_root permanently.
    pub fn rebuild_dilithium_pk_lthash_from(&self, binds: &[(String, Vec<u8>)]) -> IntegrationResult<u32> {
        self.rebuild_dpk_lthash_core(binds.iter().map(|(a, p)| (a.clone(), p.clone())))
    }

    /// Read a per-checkpoint-head seal `rr_seal_{H}` = sha3(lt_state as-of reg_height<=H), if present.
    fn registry_root_seal_get(&self, height: u64) -> Option<[u8; 32]> {
        let cf = self.persistent.db.cf_handle("metadata")?;
        let mut key = b"rr_seal_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        match self.persistent.db.get_cf(&cf, &key) {
            Ok(Some(v)) if v.len() == 32 => { let mut out = [0u8; 32]; out.copy_from_slice(&v); Some(out) }
            _ => None,
        }
    }

    /// FROM-SCRATCH recompute of the registry_root LtHash accumulator over the chain-confirmed roster
    /// {node_id, wallet, reg_height, burn} (SUPER+genesis AND LIGHT) with reg_height <= up_to_height.
    /// Scans BOTH roster indices (srtr_+lrtr_) and DEDUPES by node_id (a node that — only via a crafted
    /// node_id — lands in both indices is counted ONCE, matching the single incremental delta per
    /// registration; without dedup the from-scratch path would double-count and diverge from the live
    /// accumulator → fork). Includes EVERY reg_height-stamped row, INCLUDING empty-burn genesis/not-yet-
    /// attested rows (unlike rebuild_committed_burn_wallet, which skips empty-burn) — the live delta adds
    /// them, so the recompute must too. LtHash is order-independent, so the scan order is irrelevant and
    /// the result is byte-identical to the incrementally-maintained accumulator at the same bound.
    fn compute_lt_state(&self, up_to_height: u64) -> Option<crate::registry_lthash::LtHash> {
        self.compute_lt_state_cf("node_registry", up_to_height)
    }

    /// registry_root over an explicit registry CF: full from-scratch scan, NO seal — for cold-join
    /// staging verify ("node_registry_stage"), where no per-head seal exists.
    pub fn compute_registry_root_staged(&self, registry_cf_name: &str, up_to_height: u64) -> Option<[u8; 32]> {
        Some(self.compute_lt_state_cf(registry_cf_name, up_to_height)?.root())
    }

    /// None = FAIL CLOSED. A missing CF or a mid-scan iterator error would otherwise yield a root over
    /// a partial roster; registry_root is a hashed checkpoint field, so a short scan is not "a smaller
    /// registry", it is a different commitment on this node alone. Callers defer instead of publishing.
    fn compute_lt_state_cf(&self, registry_cf_name: &str, up_to_height: u64) -> Option<crate::registry_lthash::LtHash> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle(registry_cf_name)?;
        let mut lt = crate::registry_lthash::LtHash::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for prefix in [b"srtr_".as_ref(), b"lrtr_".as_ref()] {
            for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward)) {
                let (k, _) = match item {
                    Ok(kv) => kv,
                    Err(e) => {
                        println!("[CRIT][REGISTRY] lt_state_scan_failed cf={} up_to={} err={}", registry_cf_name, up_to_height, e);
                        return None;
                    }
                };
                if !k.starts_with(prefix) { break; }
                let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s.to_string(), Err(_) => continue };
                if !seen.insert(node_id.clone()) { continue; } // counted under the other prefix already
                let nk = format!("node_{}", node_id);
                let val = match self.persistent.db.get_cf(&registry_cf, nk.as_bytes()) { Ok(Some(v)) => v, _ => continue };
                let parsed: serde_json::Value = match serde_json::from_slice(&val) { Ok(p) => p, Err(_) => continue };
                let h = match parsed["reg_height"].as_u64() { Some(h) => h, None => continue }; // chain-confirmed only
                if h > up_to_height { continue; } // orphan/above-bound exclusion
                let wallet = parsed["wallet"].as_str().unwrap_or("");
                let burn = parsed["burn"].as_str().unwrap_or("");
                let reg_index = parsed["reg_index"].as_u64().unwrap_or(0) as u32;
                let ntype = parsed["node_type"].as_str().unwrap_or("");
                let vrf = parsed["vrf_pk_sha3"].as_str().and_then(|s| hex::decode(s).ok()).unwrap_or_default();
                lt.add(&crate::registry_lthash::row_lanes(&node_id, wallet, h, reg_index, ntype, burn, &vrf));
            }
        }
        Some(lt)
    }

    /// Light-client registry dump as of `up_to_height`: the chain-confirmed roster
    /// (node_id, wallet, reg_height, burn, vrf_pk_sha3) with reg_height <= up_to_height, plus the
    /// LtHash root over them — byte-identical to the QC-signed registry_root sealed at that height.
    /// The light client recomputes the root and binds each committee pubkey to it. Read-only, cacheable.
    pub fn registry_entries_as_of(&self, up_to_height: u64) -> (Vec<serde_json::Value>, String) {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = match self.persistent.db.cf_handle("node_registry") { Some(cf) => cf, None => return (Vec::new(), String::new()) };
        let mut lt = crate::registry_lthash::LtHash::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut out: Vec<serde_json::Value> = Vec::new();
        for prefix in [b"srtr_".as_ref(), b"lrtr_".as_ref()] {
            for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward)) {
                // A partial dump would carry a root that no light client can match; serve nothing.
                let (k, _) = match item { Ok(kv) => kv, Err(_) => return (Vec::new(), String::new()) };
                if !k.starts_with(prefix) { break; }
                let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s.to_string(), Err(_) => continue };
                if !seen.insert(node_id.clone()) { continue; }
                let nk = format!("node_{}", node_id);
                let val = match self.persistent.db.get_cf(&registry_cf, nk.as_bytes()) { Ok(Some(v)) => v, _ => continue };
                let parsed: serde_json::Value = match serde_json::from_slice(&val) { Ok(p) => p, Err(_) => continue };
                let h = match parsed["reg_height"].as_u64() { Some(h) => h, None => continue };
                if h > up_to_height { continue; }
                let wallet = parsed["wallet"].as_str().unwrap_or("").to_string();
                let burn = parsed["burn"].as_str().unwrap_or("").to_string();
                let vrf = parsed["vrf_pk_sha3"].as_str().unwrap_or("").to_string();
                let vrf_bytes = hex::decode(&vrf).unwrap_or_default();
                let reg_index = parsed["reg_index"].as_u64().unwrap_or(0) as u32;
                let ntype = parsed["node_type"].as_str().unwrap_or("").to_string();
                lt.add(&crate::registry_lthash::row_lanes(&node_id, &wallet, h, reg_index, &ntype, &burn, &vrf_bytes));
                out.push(serde_json::json!({"node_id": node_id, "wallet": wallet, "reg_height": h,
                                            "reg_index": reg_index, "node_type": ntype,
                                            "burn": burn, "vrf_pk_sha3": vrf}));
            }
        }
        (out, hex::encode(lt.root()))
    }

    /// QC-certified digest of the chain-confirmed registry BURN-IDENTITY (SUPER+genesis AND LIGHT),
    /// considering ONLY registrations with reg_height <= up_to_height. Implemented as a SOUND INCREMENTAL
    /// multiset hash (LtHash, registry_lthash::LtHash) — O(1) per registration to maintain and O(1) to
    /// read via a per-checkpoint-head seal — so it scales to millions of on-chain light nodes (a flat
    /// per-checkpoint recompute is O(N); a plain additive-mod-2^N set hash is O(1) but FORGEABLE on an
    /// adversary-chosen snapshot roster via generalized-birthday — LtHash is the lattice-based primitive
    /// that is both incremental AND collision-resistant). Bound into the macroblock checkpoint as
    /// `registry_root` so a node joining via an UNTRUSTED snapshot can verify the restored node_registry
    /// (the SOURCE OF cbw for BOTH super and light) matches the 2f+1-committed registry, closing the
    /// forgeable-snapshot Sybil/fork vector. FAST PATH: the seal sha3(lt_state<=H) written at apply
    /// (read only at checkpoint heads, all multiples of CHECKPOINT_INTERVAL). FALLBACK (snapshot cold-
    /// join before the anchor is sealed / a pruned seal): one from-scratch O(N) recompute — correct at
    /// any height. Scope MUST equal cbw (rebuild_committed_burn_wallet scans the SAME srtr_+lrtr_).
    /// None ⇒ the from-scratch scan could not complete ⇒ the caller MUST defer, never publish.
    pub fn compute_registry_root(&self, up_to_height: u64) -> Option<[u8; 32]> {
        if let Some(seal) = self.registry_root_seal_get(up_to_height) { return Some(seal); }
        Some(self.compute_lt_state(up_to_height)?.root())
    }

    /// Seal `rr_seal_{height}` = sha3(current lt_state) — the O(1) read value for that checkpoint head.
    /// Called from the block-scoped end-of-apply hook (on BOTH producer-inline and validator-deferred
    /// paths, BEFORE save_microblock) once per applied block at height % CHECKPOINT_INTERVAL == 0, after
    /// all of that block's registrations have updated lt_state. Prunes the seal one retention-window
    /// below to bound growth (heights are checkpoint-aligned ⇒ exact key).
    pub fn seal_registry_root(&self, height: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let root = self.registry_lt_load().root();
        let mut batch = rocksdb::WriteBatch::default();
        let mut key = b"rr_seal_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        batch.put_cf(&cf, &key, &root);
        if height >= Self::REGISTRY_SEAL_RETENTION {
            let mut old = b"rr_seal_".to_vec();
            old.extend_from_slice(&(height - Self::REGISTRY_SEAL_RETENTION).to_be_bytes());
            batch.delete_cf(&cf, &old);
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// Seal `ts_seal_{height}` = total minted supply as of this checkpoint head — the O(1) deterministic
    /// value the WindowEnd checkpoint reads instead of the live counter (which races the in-block mint).
    /// Sealed at the SAME head as seal_registry_root on BOTH apply paths, after Phase-1 emit_rewards.
    pub fn seal_total_supply(&self, height: u64, total: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut batch = rocksdb::WriteBatch::default();
        let mut key = b"ts_seal_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        batch.put_cf(&cf, &key, &total.to_be_bytes());
        if height >= Self::REGISTRY_SEAL_RETENTION {
            let mut old = b"ts_seal_".to_vec();
            old.extend_from_slice(&(height - Self::REGISTRY_SEAL_RETENTION).to_be_bytes());
            batch.delete_cf(&cf, &old);
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// Read the sealed total_supply for a checkpoint head; None until that head is applied+sealed,
    /// so the WindowEnd reader defers exactly like the [0;32] state_root defer.
    pub fn get_total_supply_at(&self, height: u64) -> Option<u64> {
        let cf = self.persistent.db.cf_handle("metadata")?;
        let mut key = b"ts_seal_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        match self.persistent.db.get_cf(&cf, &key) {
            Ok(Some(v)) if v.len() == 8 => { let mut b = [0u8; 8]; b.copy_from_slice(&v); Some(u64::from_be_bytes(b)) }
            _ => None,
        }
    }

    /// Recompute the registry_root LtHash accumulator FROM SCRATCH at `up_to_height` and replace the
    /// running blob, then delete every seal strictly above the new tip (orphaned on reorg) and seal the
    /// new tip (so the immediate snapshot-verify / content_ok read is O(1), not an O(N) fallback). Call
    /// at EVERY height-reset site that calls rebuild_committed_burn_wallet — boot, snapshot-apply, and
    /// both reorg paths — so the live accumulator on a reorged/snapshot-joined node is byte-identical to
    /// a from-genesis node's at the same height. Atomic (one WriteBatch).
    /// ONE scan does BOTH: (a) recompute the registry_root LtHash accumulator from reg_height ≤
    /// up_to_height, and (b) PRUNE orphan roster entries (reg_height > up_to_height) left by now-
    /// discarded blocks — deleting node_/srtr_/lrtr_/wallet_. Then delete every seal strictly above the
    /// tip and seal the tip (so the immediate snapshot-verify read is O(1)). Folding the prune into this
    /// scan (was a separate full srtr_+lrtr_ pass) keeps a deep reorg at millions to TWO index scans
    /// (cbw + this), not three, under the rollback barrier. Why prune is needed: cbw + lt_state are
    /// reg_height-bounded so they already exclude orphans, but the reward-roster readers
    /// (super_registrations_sorted, light_roster_sorted) scan srtr_/lrtr_ KEYS directly, so an orphan-
    /// ONLY registration (never re-registered canonically) would keep its key and shift the hash-shard
    /// per-shard counter (local index) of every later same-shard member → reward_root divergence; deleting
    /// node_ also stops backfill_roster_indices from
    /// resurrecting it. Canonical target+1.. is re-added by the live apply pipeline on re-sync. Call at
    /// EVERY height-reset site (boot, snapshot-apply, both reorg paths) so a reorged/snapshot-joined/
    /// crash-recovered node is byte-identical to a from-genesis node. Returns the orphan count. Atomic.
    pub fn rebuild_registry_lthash(&self, up_to_height: u64) -> IntegrationResult<u32> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let meta_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut lt = crate::registry_lthash::LtHash::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut batch = rocksdb::WriteBatch::default(); // spans node_registry (prune) + metadata (lt/seals), atomic
        let mut pruned = 0u32;
        // reg_index is the row's RANK in canonical (reg_height, node_id) order — a pure function of
        // the surviving chain, not of the order this node happened to apply things. The live counter
        // equals that rank because blocks apply in height order, reg_height is immutable once stamped,
        // and a block's rows are stamped in node_id order (sort_registrations_canonically, called by
        // the validator drain, the producer's inline stamp and the genesis apply alike). So on a chain
        // this node never reorged, renumbering here is a verified no-op.
        //
        // It is NOT a no-op after a reorg, which is the whole reason it exists: pruning an orphan
        // registered between two survivors leaves a gap a from-genesis node does not have. Ranking the
        // survivors closes the gap and puts this node back on the network's numbering.
        let mut survivors: Vec<(u64, String, serde_json::Value)> = Vec::new();
        let mut next_index = [0u32; Self::INDEX_SPACES];
        for prefix in [b"srtr_".as_ref(), b"lrtr_".as_ref()] {
            for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward)) {
                let (k, _) = match item {
                    Ok(kv) => kv,
                    Err(e) => return Err(IntegrationError::StorageError(
                        format!("registry_lthash_rebuild iterator failed: {}", e))),
                };
                if !k.starts_with(prefix) { break; }
                let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s.to_string(), Err(_) => continue };
                if !seen.insert(node_id.clone()) { continue; } // counted/handled under the other prefix already
                let nk = format!("node_{}", node_id);
                let val = match self.persistent.db.get_cf(&registry_cf, nk.as_bytes()) { Ok(Some(v)) => v, _ => continue };
                let parsed: serde_json::Value = match serde_json::from_slice(&val) { Ok(p) => p, Err(_) => continue };
                let h = match parsed["reg_height"].as_u64() { Some(h) => h, None => continue };
                if h <= up_to_height {
                    // Ranks are assigned in the second pass, once every survivor is known.
                    survivors.push((h, node_id.clone(), parsed.clone()));
                } else {
                    // orphan of a discarded block — prune node_ + both roster indices. No wallet_ reverse
                    // index exists (resolution derives the id), so nothing else to drop.
                    batch.delete_cf(&registry_cf, nk.as_bytes());
                    batch.delete_cf(&registry_cf, format!("srtr_{}", node_id).as_bytes());
                    batch.delete_cf(&registry_cf, format!("lrtr_{}", node_id).as_bytes());
                    // The dedup-origin marker goes with the row: leaving it would reject the
                    // registration when the canonical chain re-applies it.
                    batch.delete_cf(&registry_cf, format!("nreg_{}", node_id).as_bytes());
                    pruned += 1;
                }
            }
        }
        // Canonical order, then contiguous ranks from 0. Rewriting the row is required: reg_index is
        // hashed, so a stale value on disk would fold into a root nobody else computes.
        survivors.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        for (h, node_id, mut parsed) in survivors.into_iter() {
            let ntype_for_space = parsed["node_type"].as_str().unwrap_or("").to_string();
            let sp = match Self::index_space_of(&node_id, &ntype_for_space) { Some(v) => v, None => continue };
            let rank = next_index[sp];
            next_index[sp] = rank.saturating_add(1);
            if parsed["reg_index"].as_u64().map(|v| v as u32) != Some(rank) {
                parsed["reg_index"] = serde_json::json!(rank);
                batch.put_cf(
                    &registry_cf,
                    format!("node_{}", node_id).as_bytes(),
                    parsed.to_string().as_bytes(),
                );
            }
            let wallet = parsed["wallet"].as_str().unwrap_or("");
            let burn = parsed["burn"].as_str().unwrap_or("");
            let ntype = parsed["node_type"].as_str().unwrap_or("");
            let vrf = parsed["vrf_pk_sha3"].as_str()
                .and_then(|s| hex::decode(s).ok()).unwrap_or_default();
            lt.add(&crate::registry_lthash::row_lanes(&node_id, wallet, h, rank, ntype, burn, &vrf));
        }

        let root = lt.root();
        batch.put_cf(&meta_cf, Self::REGISTRY_LT_STATE_KEY, lt.to_bytes().as_ref());
        batch.put_cf(&meta_cf, Self::REGISTRY_NEXT_INDEX_KEY, &Self::next_indices_bytes(&next_index));
        for item in self.persistent.db.iterator_cf(&meta_cf, IteratorMode::From(b"rr_seal_", Direction::Forward)) {
            let (k, _) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("registry_lthash_seal iterator failed: {}", e))),
            };
            if !k.starts_with(b"rr_seal_") { break; }
            if k.len() == 8 + 8 {
                let h = u64::from_be_bytes(k[8..16].try_into().unwrap_or([0u8; 8]));
                if h > up_to_height { batch.delete_cf(&meta_cf, &k); }
            }
        }
        let mut key = b"rr_seal_".to_vec();
        key.extend_from_slice(&up_to_height.to_be_bytes());
        batch.put_cf(&meta_cf, &key, &root);
        self.persistent.db.write(batch)?;
        // Same reset sites (boot/snapshot/reorg) must also canonicalize the heartbeat liveness index.
        let _ = self.canonicalize_heartbeat_index(up_to_height);
        Ok(pruned)
    }

    /// Batch-write the eligible super set for an epoch in one WriteBatch (epoch-boundary snapshot).
    pub fn save_super_eligible_batch(&self, epoch: u64, node_ids: &[String]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let mut batch = rocksdb::WriteBatch::default();
        for node_id in node_ids {
            batch.put_cf(&cf, format!("super_elig_{}_{}", epoch, node_id).as_bytes(), &[]);
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// Load the eligible super node_ids for an epoch (prefix scan, ascending by node_id).
    pub fn load_super_eligible(&self, epoch: u64) -> IntegrationResult<Vec<String>> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let prefix = format!("super_elig_{}_", epoch);
        let pb = prefix.as_bytes();
        let mut out: Vec<String> = Vec::new();
        let iter = self.persistent.db.iterator_cf(&cf, IteratorMode::From(pb, Direction::Forward));
        for item in iter {
            let (k, _) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("super_eligible iterator failed: {}", e))),
            };
            if !k.starts_with(pb) { break; }
            if let Ok(s) = std::str::from_utf8(&k[pb.len()..]) { out.push(s.to_string()); }
        }
        Ok(out)
    }

    /// B (liveness-from-chain): snapshot the finalized epoch's committed light-eligibility into a per-node
    /// recency index `light_elig_{epoch:010}_{node_id}`. Decodes the committed light bitmaps through the
    /// deterministic pre-epoch roster (SAME sharding the emission path uses), streamed (no O(roster) Vec)
    /// and chunked (bounded WriteBatch) for tens of millions of nodes. Read-only w.r.t. reward_root — the
    /// reward path recomputes from light_bm_ directly; this index only serves O(1) status recency.
    pub fn snapshot_light_eligible(&self, epoch: u64, cutoff: u64) -> IntegrationResult<usize> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let bitmaps = self.load_light_bitmaps(epoch).unwrap_or_default();
        let mut batch = rocksdb::WriteBatch::default();
        let (mut n, mut inbatch) = (0usize, 0usize);
        // Stable hash-shard (SAME as the bitmap builder + emission reader): bit i in shard g = the i-th
        // sorted roster node with light_shard_of()==g. Streamed (no O(roster) Vec), one walk.
        if !bitmaps.is_empty() {
            // Bit position is the node's PERMANENT reg_index, not a position in this scan. A
            // scan-relative ordinal shifted every later node whenever the roster changed, so the
            // bitmap was read at the wrong offsets — reporting the WRONG nodes, not fewer of them.
            let scan = self.light_roster_for_each(cutoff, |node_id, _w, reg_index| {
                let gidx = crate::node::light_shard_of(node_id);
                let bit = reg_index as usize;
                if let Some(bm) = bitmaps.get(&gidx) {
                    if bm.get(bit / 8).map(|b| b & (1 << (bit % 8)) != 0).unwrap_or(false) {
                        batch.put_cf(&cf, format!("light_elig_{:010}_{}", epoch, node_id).as_bytes(), &[]);
                        n += 1; inbatch += 1;
                        if inbatch >= 100_000 { let _ = self.persistent.db.write(std::mem::take(&mut batch)); inbatch = 0; }
                    }
                }
            });
            scan?;
        }
        // Recency needs ~2 epochs; range-delete anything older than a small window so the index stays
        // bounded (one range-delete, zero-padded key ⇒ lexical order == numeric order).
        if epoch >= 4 {
            batch.delete_range_cf(&cf, b"light_elig_0000000000_".as_ref(),
                format!("light_elig_{:010}_", epoch - 3).as_bytes());
        }
        self.persistent.db.write(batch)?;
        Ok(n)
    }

    /// B: did node_id attest in either of the last two COMMITTED epochs? Node-independent, two O(1)
    /// point-reads. The in-progress epoch (cur_height/14400) is not committed yet, so check e-1 and e-2.
    pub fn light_attested_recent_onchain(&self, node_id: &str, cur_height: u64) -> bool {
        let cf = match self.persistent.db.cf_handle("pending_rewards") { Some(c) => c, None => return false };
        let e = cur_height / 14400;
        for ep in [e.saturating_sub(1), e.saturating_sub(2)] {
            if self.persistent.db.get_cf(&cf, format!("light_elig_{:010}_{}", ep, node_id).as_bytes())
                .ok().flatten().is_some() { return true; }
        }
        false
    }

    /// Append an emission epoch to the sorted, append-only reward-epochs index (deduped).
    /// Lets the claim RPC enumerate exactly the epochs that carry a reward root in O(epochs)
    /// instead of scanning macroblock indices — so a wallet far behind on claims is found
    /// without any scan cap, and a batch claim can cover ALL unclaimed epochs at once.
    pub fn append_reward_epoch(&self, epoch: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = b"reward_epochs_index";
        let mut list: Vec<u64> = match self.persistent.db.get_cf(&cf, key)? {
            Some(d) => bincode::deserialize(&d).unwrap_or_default(),
            None => Vec::new(),
        };
        if let Err(pos) = list.binary_search(&epoch) {
            list.insert(pos, epoch); // keep sorted + deduped
            let data = bincode::serialize(&list)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            self.persistent.db.put_cf(&cf, key, &data)?;
        }
        Ok(())
    }

    /// Load the sorted reward-epochs index (every emission epoch with a committed root).
    pub fn load_reward_epochs(&self) -> IntegrationResult<Vec<u64>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        match self.persistent.db.get_cf(&cf, b"reward_epochs_index")? {
            Some(d) => Ok(bincode::deserialize(&d).unwrap_or_default()),
            None => Ok(Vec::new()),
        }
    }


    
    // ============================================
    // SCALABILITY: NODE REGISTRY IN ROCKSDB
    // ============================================
    
    /// Save node registration information (for local cache only)
    /// NOTE: api_endpoint is now stored ON-CHAIN in NodeRegistration TX!
    /// Stores BOTH forward index (node_id → data) AND reverse index (wallet → node_id)
    /// for O(1) lookups in both directions.
    pub fn save_node_registration(&self, node_id: &str, node_type: &str, wallet: &str, reputation: f64) -> IntegrationResult<()> {
        self.save_node_registration_inner(node_id, node_type, wallet, reputation, None, None, None)
    }

    /// Block-apply registration: stamps the deterministic `reg_height` so the entry is recognised as
    /// chain-confirmed. Only such entries enter the reward roster (RPC-cache writes have no height).
    pub fn save_node_registration_at_height(&self, node_id: &str, node_type: &str, wallet: &str, reputation: f64, reg_height: u64) -> IntegrationResult<()> {
        self.save_node_registration_inner(node_id, node_type, wallet, reputation, Some(reg_height), None, None)
    }

    /// Chain-apply registration that also persists the backing `burn_tx` co-resident with `reg_height`
    /// in ONE node_ entry. This is the single authoritative writer of the burn binding: the committed
    /// burn→wallet index (cbw) is REBUILT deterministically from these entries on snapshot/reorg/boot
    /// (rebuild_committed_burn_wallet), and the registry digest (registry_root) hashes them. Genesis /
    /// non-burn callers use save_node_registration_at_height (burn empty). burn empty ⇒ binding skipped.
    pub fn save_node_registration_at_height_burn(&self, node_id: &str, node_type: &str, wallet: &str, reputation: f64, reg_height: u64, burn_tx: &str) -> IntegrationResult<()> {
        self.save_node_registration_inner(node_id, node_type, wallet, reputation, Some(reg_height), Some(burn_tx), None)
    }

    /// As above, but also binds the node's consensus pubkey (vrf_pk) into registry_root via the
    /// co-resident row. Used by the block-apply path (the on-chain NodeRegistration TX carries the key).
    /// Keyless callers (genesis/tests) use the plain variant (vrf None).
    pub fn save_node_registration_at_height_burn_vrf(&self, node_id: &str, node_type: &str, wallet: &str, reputation: f64, reg_height: u64, burn_tx: &str, vrf_pk: Option<&[u8]>) -> IntegrationResult<()> {
        self.save_node_registration_inner(node_id, node_type, wallet, reputation, Some(reg_height), Some(burn_tx), vrf_pk)
    }

    /// Roster-index value: `reg_height (8B BE) ++ reg_index (4B BE) ++ wallet`.
    ///
    /// reg_index rides here so a roster scan yields each node's permanent bitmap ordinal without a
    /// per-entry JSON parse of `node_<id>` — which is the entire reason these indices exist.
    fn roster_index_value(reg_height: u64, reg_index: u32, wallet: &str) -> Vec<u8> {
        let mut val = Vec::with_capacity(12 + wallet.len());
        val.extend_from_slice(&reg_height.to_be_bytes());
        val.extend_from_slice(&reg_index.to_be_bytes());
        val.extend_from_slice(wallet.as_bytes());
        val
    }

    /// Inverse of `roster_index_value`. A short or non-UTF8 row is skipped, never defaulted.
    fn decode_roster_index_value(v: &[u8]) -> Option<(u64, u32, &str)> {
        if v.len() < 12 { return None; }
        let h = u64::from_be_bytes(v[..8].try_into().ok()?);
        let idx = u32::from_be_bytes(v[8..12].try_into().ok()?);
        let wallet = std::str::from_utf8(&v[12..]).ok()?;
        Some((h, idx, wallet))
    }

    fn save_node_registration_inner(&self, node_id: &str, node_type: &str, wallet: &str, reputation: f64, reg_height: Option<u64>, burn_tx: Option<&str>, vrf_pk: Option<&[u8]>) -> IntegrationResult<()> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        // ATOMIC: WriteBatch ensures both forward and reverse indexes are written together
        // Prevents inconsistency if crash occurs between writes
        let mut batch = rocksdb::WriteBatch::default();

        // Forward index: node_id → data
        let key = format!("node_{}", node_id);
        // ALWAYS read the prior entry: needed both to preserve chain-confirmed fields against an
        // RPC-cache clobber AND to compute the registry_root LtHash delta (subtract the old row).
        let prior = self.persistent.db.get_cf(&registry_cf, key.as_bytes()).ok().flatten()
            .and_then(|old| serde_json::from_slice::<serde_json::Value>(&old).ok());
        let prior_height = prior.as_ref().and_then(|p| p["reg_height"].as_u64());

        // The chain-confirmed identity {wallet, reg_height, burn} is IMMUTABLE once stamped: those are
        // exactly the fields registry_root commits, so a non-deterministic RPC/discovery-cache write
        // (reg_height None) must NEVER rebind them — else node_ would diverge from lt_state → fork.
        // A chain-apply (reg_height Some) sets wallet; an RPC-cache write keeps the prior chain wallet.
        let final_wallet = if reg_height.is_some() {
            wallet.to_string()
        } else if prior_height.is_some() {
            prior.as_ref().and_then(|p| p["wallet"].as_str()).unwrap_or(wallet).to_string()
        } else {
            wallet.to_string()
        };
        // node_type is IMMUTABLE once chain-stamped, same rule as wallet. It is now folded into
        // row_lanes, and it decides light-roster membership at backfill — an RPC-cache write with a
        // peer-supplied type must never rebind it.
        let final_node_type = if reg_height.is_some() {
            node_type.to_string()
        } else if prior_height.is_some() {
            prior.as_ref().and_then(|p| p["node_type"].as_str()).unwrap_or(node_type).to_string()
        } else {
            node_type.to_string()
        };
        let mut data = json!({
            "node_type": final_node_type,
            "wallet": final_wallet,
            "reputation": reputation,
            "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
        });
        // reg_height is IMMUTABLE once chain-stamped (same invariant as wallet/burn): keep the FIRST
        // stamped height. A re-presented NodeActivation applies as an Ok no-op (single-use guard) yet
        // still re-pushes the super pseudonym row; without this it would re-stamp H1->H2 and, on a reorg
        // into [H1,H2), make the from-scratch recompute drop a row a never-reorged node still holds →
        // registry_root divergence. First chain-apply (prior None) uses the incoming height.
        if let Some(ph) = prior_height {
            data["reg_height"] = json!(ph);
        } else if let Some(h) = reg_height {
            data["reg_height"] = json!(h);
        }
        // burn binding: set when provided non-empty, else preserve a prior chain-confirmed burn.
        match burn_tx {
            Some(b) if !b.is_empty() => { data["burn"] = json!(b); }
            _ => {
                if let Some(b) = prior.as_ref().and_then(|p| p["burn"].as_str()) {
                    if !b.is_empty() { data["burn"] = json!(b); }
                }
            }
        }
        // vrf_pk_sha3: consensus-signer-key commitment, IMMUTABLE once stamped (same invariant as
        // wallet/burn/reg_height). sha3-256 of the node's consensus pubkey carried by the chain-apply
        // (NodeRegistration TX); co-resident here so the registry_root row field is byte-identical on
        // every node. A later RPC-cache write (vrf_pk None) preserves the stamped key. Light rows: "".
        let vrf_sha3_hex: String = match prior.as_ref().and_then(|p| p["vrf_pk_sha3"].as_str()) {
            Some(pv) if !pv.is_empty() => pv.to_string(),
            _ => match vrf_pk {
                Some(pk) if !pk.is_empty() => {
                    use sha3::{Digest, Sha3_256};
                    let mut h = Sha3_256::new();
                    Digest::update(&mut h, pk);
                    hex::encode(h.finalize())
                }
                _ => String::new(),
            },
        };
        if !vrf_sha3_hex.is_empty() { data["vrf_pk_sha3"] = json!(vrf_sha3_hex); }

        // reg_index: the node's permanent ordinal, assigned once from a monotone counter in THIS
        // batch. Bitmaps are indexed by it instead of by a position in a roster scan, where inserting
        // one registration shifted every later ordinal. Gate is byte-identical to the LtHash gate
        // below, so exactly the rows the root covers get an index. Immutable once stamped.
        //
        // The counter lives in the metadata CF, not in RAM: block apply is strictly serialized per
        // node, so read-modify-write inside the batch is race-free, and a process-local counter would
        // be RAM deciding a hashed field (I1).
        let space = Self::index_space_of(node_id, &final_node_type);
        let in_scope_for_index = space.is_some();
        let prior_index = prior.as_ref().and_then(|p| p["reg_index"].as_u64()).map(|v| v as u32);
        let final_index: u32 = match (prior_index, space) {
            (Some(existing), _) => existing,
            (None, Some(sp)) if reg_height.is_some() => {
                let mut counters = self.load_next_indices(&metadata_cf);
                let next = counters[sp];
                counters[sp] = next.saturating_add(1);
                batch.put_cf(&metadata_cf, Self::REGISTRY_NEXT_INDEX_KEY,
                             &Self::next_indices_bytes(&counters));
                next
            }
            _ => 0,
        };
        if reg_height.is_some() && in_scope_for_index {
            data["reg_index"] = json!(final_index);
        } else if let Some(existing) = prior_index {
            data["reg_index"] = json!(existing);
        }
        batch.put_cf(&registry_cf, key.as_bytes(), data.to_string().as_bytes());

        // No wallet→node reverse index: wallet→node is resolved by DERIVING the id (resolve_node_id) and
        // point-reading node_<id> — no mutable per-node slot exists to diverge across apply/gossip order.

        // Reward-roster indices (chain-confirmed only). Written in THIS batch so they are atomic
        // with the node_ entry and ride the node_registry snapshot (whole-CF copy). Keyed node_id-
        // first so a prefix scan yields the SAME node_id-ascending order the reward roster needs —
        // no JSON parse, no sort on the emission hot path. Gate = reg_height Some (first chain-apply):
        // RPC/discovery-cache writes (None) never index, mirroring the readers that skip un-stamped
        // entries; a later None re-cache preserves the prior height above and the index key already
        // exists, so we never write/delete on None. The super/light predicates are INDEPENDENT
        // (matching the two independent readers) — super keys on node_id prefix, light on node_type.
        if let Some(h) = reg_height {
            if node_id.starts_with("super_") || node_id.starts_with("genesis_node_") {
                let ik = format!("srtr_{}", node_id);
                // Value = reg_height (8B BE) ++ wallet, mirroring lrtr_. Carrying the height in the index
                // lets the producer/reward rosters apply their cutoff during the prefix scan, so the
                // height-bounded set costs one scan instead of a point-read + JSON parse per super.
                // Height IMMUTABLE once chain-stamped (same rule as the node_ row and lrtr_): keep the
                // FIRST stamped height, so an apply-history node and a snapshot-rebuilt node derive
                // byte-identical rosters for every cutoff.
                let eff_h = prior_height.unwrap_or(h);
                batch.put_cf(&registry_cf, ik.as_bytes(),
                             &Self::roster_index_value(eff_h, final_index, &final_wallet));
            }
            if final_node_type == "light" {
                let ik = format!("lrtr_{}", node_id);
                // Height IMMUTABLE once chain-stamped (mirror the node_ row above): keep the FIRST stamped
                // height, not a re-presented one, so the cutoff-filtered roster is byte-identical between an
                // apply-history node (this live write) and a snapshot/backfill-rebuilt node (which derives
                // lrtr_ from node_'s first-stamped reg_height). Using the raw incoming h would re-stamp
                // H1→H2 and, for any epoch cutoff in (H1,H2], shift the per-shard counter → reward_root fork.
                let eff_h = prior_height.unwrap_or(h);
                batch.put_cf(&registry_cf, ik.as_bytes(),
                             &Self::roster_index_value(eff_h, final_index, &final_wallet));
            }
        }

        // ── registry_root LtHash maintenance (incremental, O(1)) ──
        // Update the running multiset accumulator IN THE SAME BATCH as the node_ put, so node_ and
        // lt_state can never disagree across a crash. Gated on the CALL being a chain-apply
        // (reg_height param Some): block-apply is strictly serialized per node, so the load→delta→store
        // is race-free, and RPC-cache/discovery writes (None) are skipped entirely (they preserve the
        // chain-confirmed identity above, so they would be net-zero anyway — skipping avoids a
        // redundant lt_state write that could lost-update a concurrent chain-apply). Scope = exactly
        // the set compute_registry_root scans (super by node_id prefix OR node_type==light); node type
        // and id-prefix are immutable post-registration, so prior membership == current membership.
        // The delta = add(final row) - remove(prior row): a first registration adds once; a
        // re-registration subtracts the old identity and adds the new; an idempotent re-apply of the
        // same block reads back its own row (old==new) → net zero.
        if reg_height.is_some() {
            let in_scope = in_scope_for_index;
            if in_scope {
                let mut lt = self.registry_lt_load();
                // vrf_pk_sha3 is immutable, so old-row == new-row key bytes; decode both from their
                // own JSON for symmetry with the from-scratch rebuild.
                let final_vrf = hex::decode(&vrf_sha3_hex).unwrap_or_default();
                if let (Some(ph), Some(p)) = (prior_height, prior.as_ref()) {
                    let pw = p["wallet"].as_str().unwrap_or("");
                    let pb = p["burn"].as_str().unwrap_or("");
                    let pi = p["reg_index"].as_u64().unwrap_or(0) as u32;
                    let pt = p["node_type"].as_str().unwrap_or("");
                    let prior_vrf = p["vrf_pk_sha3"].as_str()
                        .and_then(|s| hex::decode(s).ok()).unwrap_or_default();
                    lt.remove(&crate::registry_lthash::row_lanes(node_id, pw, ph, pi, pt, pb, &prior_vrf));
                }
                let nh = data["reg_height"].as_u64().unwrap_or(0);
                let nb = data["burn"].as_str().unwrap_or("");
                let ni = data["reg_index"].as_u64().unwrap_or(0) as u32;
                lt.add(&crate::registry_lthash::row_lanes(
                    node_id, &final_wallet, nh, ni, &final_node_type, nb, &final_vrf));
                batch.put_cf(&metadata_cf, Self::REGISTRY_LT_STATE_KEY, lt.to_bytes().as_ref());
            }
        }

        self.persistent.db.write(batch)?;

        Ok(())
    }

    /// Deterministic epoch roster of chain-confirmed Light nodes registered below `before_height`,
    /// sorted by node_id — the bit→node_id mapping for eligibility bitmaps, recomputable identically
    /// on every node. Reads the apply-time `lrtr_` index (prefix scan, node_id-ascending, no JSON,
    /// no sort) instead of a full-CF scan; byte-identical to `light_roster_sorted_scan` (asserted by
    /// a determinism test) but O(roster) without a per-entry JSON parse — scalable to millions.
    pub fn light_roster_sorted(&self, before_height: u64) -> IntegrationResult<Vec<(String, String)>> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let prefix = b"lrtr_";
        let mut out: Vec<(String, String)> = Vec::new();
        let iter = self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward));
        for item in iter {
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("light_roster_sorted iterator failed: {}", e))),
            };
            if !k.starts_with(prefix) { break; }
            let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s, Err(_) => continue };
            let (h, _idx, wallet) = match Self::decode_roster_index_value(&v) { Some(t) => t, None => continue };
            if h >= before_height { continue; }
            if !wallet.is_empty() { out.push((node_id.to_string(), wallet.to_string())); }
        }
        Ok(out)
    }

    // ── Native-QNC rich-list index (display) ─────────────────────────────────────────────────────
    // Top-K holders by balance, served O(K) without ever scanning all accounts. Keyed
    // `rlst_{(u64::MAX-balance) BE}_{addr}` so a forward prefix scan yields balance-descending,
    // address-ascending order. Companion `rlpos_{addr}` holds the indexed balance so an update knows
    // which sort key to delete; `rlcnt` is the holder count. Maintained incrementally at apply from a
    // block's touched addresses, rebuilt from live state at boot/snapshot/reorg. Display-only (in no
    // root/checkpoint), so a divergence or drift is cosmetic and self-heals on the next rebuild.

    fn rlst_sort_key(addr: &str, balance: u64) -> Vec<u8> {
        let inv = (u64::MAX - balance).to_be_bytes();
        let mut k = Vec::with_capacity(5 + 8 + addr.len());
        k.extend_from_slice(b"rlst_");
        k.extend_from_slice(&inv);
        k.extend_from_slice(addr.as_bytes());
        k
    }

    /// Apply-time reconcile: `updates[i] = (addr, Some(balance))` when the address is a rich-list holder
    /// (non-contract, non-system, non-burn, balance>0), else `None` to remove it. One atomic batch;
    /// apply is serialized per node so the read-old → write-new is race-free. Maintains `rlcnt`.
    pub fn richlist_reconcile(&self, updates: &[(String, Option<u64>)]) -> IntegrationResult<()> {
        if updates.is_empty() { return Ok(()); }
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut batch = rocksdb::WriteBatch::default();
        let mut delta: i64 = 0;
        for (addr, new_bal) in updates {
            let pos_key = format!("rlpos_{}", addr);
            let old = self.persistent.db.get_cf(&cf, pos_key.as_bytes())?
                .and_then(|v| v.get(..8).and_then(|b| b.try_into().ok()).map(u64::from_be_bytes));
            if let Some(ob) = old {
                batch.delete_cf(&cf, Self::rlst_sort_key(addr, ob));
            }
            match new_bal {
                Some(nb) => {
                    batch.put_cf(&cf, Self::rlst_sort_key(addr, *nb), &nb.to_be_bytes());
                    batch.put_cf(&cf, pos_key.as_bytes(), &nb.to_be_bytes());
                    if old.is_none() { delta += 1; }
                }
                None => {
                    batch.delete_cf(&cf, pos_key.as_bytes());
                    if old.is_some() { delta -= 1; }
                }
            }
        }
        if delta != 0 {
            let cur = self.persistent.db.get_cf(&cf, b"rlcnt")?
                .and_then(|v| v.get(..8).and_then(|b| b.try_into().ok()).map(u64::from_be_bytes)).unwrap_or(0);
            let next = (cur as i64 + delta).max(0) as u64;
            batch.put_cf(&cf, b"rlcnt", &next.to_be_bytes());
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// Top-K holders (balance desc, address asc) — one bounded forward prefix scan, O(K).
    pub fn richlist_top_k(&self, k: usize) -> IntegrationResult<Vec<(String, u64)>> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let prefix = b"rlst_";
        let mut out: Vec<(String, u64)> = Vec::with_capacity(k.min(1024));
        let iter = self.persistent.db.iterator_cf(&cf, IteratorMode::From(prefix, Direction::Forward));
        for item in iter {
            if out.len() >= k { break; }
            let (key, val) = match item { Ok(kv) => kv, Err(_) => break };
            if !key.starts_with(prefix) { break; }
            if key.len() <= prefix.len() + 8 { continue; }
            let addr = match std::str::from_utf8(&key[prefix.len() + 8..]) { Ok(s) => s, Err(_) => continue };
            let bal = val.get(..8).and_then(|b| b.try_into().ok()).map(u64::from_be_bytes).unwrap_or(0);
            out.push((addr.to_string(), bal));
        }
        Ok(out)
    }

    /// Total rich-list holders (non-contract, non-system, non-burn, balance>0), O(1).
    pub fn richlist_holder_count(&self) -> u64 {
        match self.persistent.db.cf_handle("node_registry") {
            Some(cf) => self.persistent.db.get_cf(&cf, b"rlcnt").ok().flatten()
                .and_then(|v| v.get(..8).and_then(|b| b.try_into().ok()).map(u64::from_be_bytes)).unwrap_or(0),
            None => 0,
        }
    }

    /// Wipe the rich-list index (prefix range-deletes + reset count) — called before a full rebuild.
    pub fn richlist_clear(&self) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut batch = rocksdb::WriteBatch::default();
        // '`' (0x60) = '_'(0x5f)+1, so [start_prefix, prefix+'`') is exactly the prefix's key range.
        batch.delete_range_cf(&cf, b"rlst_".as_ref(), b"rlst`".as_ref());
        batch.delete_range_cf(&cf, b"rlpos_".as_ref(), b"rlpos`".as_ref());
        batch.delete_cf(&cf, b"rlcnt");
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// One-time marker so the O(N) rich-list rebuild scan runs once at boot, not on every restart.
    pub fn richlist_index_built(&self) -> bool {
        match self.persistent.db.cf_handle("node_registry") {
            Some(cf) => self.persistent.db.get_cf(&cf, b"meta_richlist_index_v1").map(|o| o.is_some()).unwrap_or(false),
            None => false,
        }
    }
    pub fn set_richlist_index_built(&self) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, b"meta_richlist_index_v1", b"1")?;
        Ok(())
    }

    /// Full rebuild by streaming the AUTHORITATIVE `accounts` CF (the complete hot∪cold mirror — persist-
    /// before-evict keeps it complete), not the bounded in-memory cache, so the index + holder_count are
    /// complete at any holder count. Runs entirely off the state lock; clears then repopulates in bounded
    /// batches. Returns Err on a storage failure so the caller can leave the one-time marker unset for retry.
    /// Returns the number of account rows SCANNED — not holders. The caller uses it to decide
    /// whether the one-time marker may be set: a rebuild that saw an empty accounts CF (a node that
    /// has not restored state yet) did no work, and marking it done leaves the index permanently
    /// dependent on the incremental path alone.
    pub fn richlist_rebuild_from_accounts(&self) -> IntegrationResult<u64> {
        use qnet_state::transaction::CANONICAL_BURN_ADDR;
        self.richlist_clear()?;
        let accounts_cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut batch: Vec<(String, Option<u64>)> = Vec::with_capacity(10_000);
        let mut scanned: u64 = 0;
        let mut total: u64 = 0;
        for item in self.persistent.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start) {
            let (k, v) = item.map_err(|e| IntegrationError::StorageError(format!("richlist_iter_err: {}", e)))?;
            scanned = scanned.saturating_add(1);
            let addr = match String::from_utf8(k.to_vec()) { Ok(s) => s, Err(_) => continue };
            if addr.as_str() == CANONICAL_BURN_ADDR || addr.starts_with("system_") { continue; }
            let acct: qnet_state::Account = match bincode::deserialize(&v) { Ok(a) => a, Err(_) => continue };
            if acct.is_contract || acct.balance == 0 { continue; }
            batch.push((addr, Some(acct.balance)));
            if batch.len() >= 10_000 {
                self.richlist_reconcile(&batch)?;
                total = total.saturating_add(batch.len() as u64);
                batch.clear();
            }
        }
        if !batch.is_empty() {
            total = total.saturating_add(batch.len() as u64);
            self.richlist_reconcile(&batch)?;
        }
        if crate::node::is_info() {
            println!("[INFO][RICHLIST] index_rebuilt holders={} scanned={}", total, scanned);
        }
        Ok(scanned)
    }

    /// Heartbeat liveness index write (apply path). Key `lhb_{anchor_subwindow:010}_{node_id}` →
    /// first inclusion height (8B BE). First-write-wins keeps the MIN inclusion height, so a reader
    /// bounded by scan_end reproduces the canonical body scan exactly (any inclusion of a cur/prev-
    /// subwindow anchor is ≥ subwindow start, so `min ≤ scan_end` ⟺ `∃ inclusion ≤ scan_end`).
    /// Lives in node_registry CF (rides the CF snapshot; NOT in registry_root — that scans only
    /// srtr_/lrtr_/node_ rows). Prunes subwindows < sw-2 via one range-delete (bounded: ~3 subwindows
    /// × supers). Apply is serialized per node ⇒ the get-then-put is race-free.
    pub fn index_heartbeat_inclusion(&self, node_id: &str, anchor_height: u64, included_height: u64) -> IntegrationResult<()> {
        // Same freshness rule the REWARD bit enforces in the apply arm: an anchor must be strictly past
        // and within HB_ANCHOR_MAX_LAG. Without it a stale heartbeat granted producer eligibility while
        // granting no reward — two liveness accounts drawn from different accept-sets. Enforced at the
        // single writer so the producer-inline and peer-apply callers cannot drift apart.
        if anchor_height >= included_height
            || included_height - anchor_height > crate::node::HB_ANCHOR_MAX_LAG {
            return Ok(());
        }
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let sw = anchor_height / 1440;
        let key = format!("lhb_{:010}_{}", sw, node_id);
        if self.persistent.db.get_cf(&registry_cf, key.as_bytes())?.is_none() {
            self.persistent.db.put_cf(&registry_cf, key.as_bytes(), &included_height.to_be_bytes())?;
        }
        // Prune once per subwindow advance (metadata watermark), not per heartbeat.
        //
        // RETENTION MUST COVER THE ROSTER-DERIVATION HORIZON. The reader needs the current and previous
        // subwindow AT THE WINDOW BEING DERIVED, and since production may run MAX_DERIVED_ROSTER_WINDOWS
        // past the last seal, a snapshot can be recomputed that far below the live tip. Keeping only
        // sw-2 would make the answer depend on how deep THIS node's seal is — i.e. on local index
        // availability — and that answer lands in eligible_producers → epoch_commitment, which is
        // byte-compared. Retaining the horizon plus the reader's own 2-subwindow span makes it a
        // function of the height alone.
        if sw >= LHB_RETAINED_SUBWINDOWS {
            let meta_cf = self.persistent.db.cf_handle("metadata")
                .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
            let want = sw - LHB_RETAINED_SUBWINDOWS;
            let have = self.persistent.db.get_cf(&meta_cf, b"lhb_pb")?
                .and_then(|v| v[..8.min(v.len())].try_into().ok().map(u64::from_be_bytes)).unwrap_or(0);
            if want > have {
                let mut batch = rocksdb::WriteBatch::default();
                batch.delete_range_cf(&registry_cf, b"lhb_0000000000_".as_ref(), format!("lhb_{:010}_", want).as_bytes());
                batch.put_cf(&meta_cf, b"lhb_pb", &want.to_be_bytes());
                self.persistent.db.write(batch)?;
            }
        }
        Ok(())
    }

    /// Indexed replacement for the recent-Heartbeat body scan: node_ids with a Heartbeat anchored in
    /// subwindow cur/prev and included at ≤ scan_end. Two bounded prefix scans, O(recent supers) —
    /// no block-body deserialization. Byte-identical to the body scan (determinism test).
    pub fn recent_heartbeat_senders_indexed(&self, cur_idx: u64, prev_idx: u64, scan_end: u64) -> IntegrationResult<std::collections::HashSet<String>> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        // FAIL-CLOSED. If either subwindow sits at or below the prune watermark the index no longer holds
        // the full answer, and a partial liveness set silently changes roster membership on THIS node
        // only. Refuse instead: the caller abstains and syncs. This is what keeps a future change to the
        // derivation horizon a stall rather than a fork.
        if let Some(meta_cf) = self.persistent.db.cf_handle("metadata") {
            if let Ok(Some(v)) = self.persistent.db.get_cf(&meta_cf, b"lhb_pb") {
                let pruned_below = v[..8.min(v.len())].try_into().ok().map(u64::from_be_bytes).unwrap_or(0);
                if pruned_below > 0 && prev_idx.min(cur_idx) < pruned_below {
                    return Err(IntegrationError::StorageError(format!(
                        "lhb_index_pruned needed_sw={} pruned_below={}", prev_idx.min(cur_idx), pruned_below)));
                }
            }
        }
        let mut out: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut idxs = [cur_idx, prev_idx];
        idxs.sort_unstable();
        let scan = |idx: u64, out: &mut std::collections::HashSet<String>| -> IntegrationResult<()> {
            let prefix = format!("lhb_{:010}_", idx);
            for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix.as_bytes(), Direction::Forward)) {
                let (k, v) = match item {
                    Ok(kv) => kv,
                    Err(e) => return Err(IntegrationError::StorageError(
                        format!("heartbeat_senders iterator failed: {}", e))),
                };
                if !k.starts_with(prefix.as_bytes()) { break; }
                if v.len() < 8 { continue; }
                let inc = u64::from_be_bytes(v[..8].try_into().unwrap_or([0u8; 8]));
                if inc <= scan_end {
                    if let Ok(id) = std::str::from_utf8(&k[prefix.len()..]) { out.insert(id.to_string()); }
                }
            }
            Ok(())
        };
        scan(idxs[0], &mut out)?;
        if idxs[1] != idxs[0] { scan(idxs[1], &mut out)?; }
        Ok(out)
    }

    /// True if `node_id` has an on-chain Heartbeat in the current or previous 1440-block
    /// subwindow at `cur_height` — the deterministic liveness answer identical on every node
    /// (two lhb_ point-reads). The RAM peer view can lag a healthy node after reconnects.
    pub fn heartbeat_recent_onchain(&self, node_id: &str, cur_height: u64) -> bool {
        let registry_cf = match self.persistent.db.cf_handle("node_registry") {
            Some(cf) => cf,
            None => return false,
        };
        let cur = cur_height / 1440;
        for sw in [cur, cur.saturating_sub(1)] {
            let key = format!("lhb_{:010}_{}", sw, node_id);
            if let Ok(Some(v)) = self.persistent.db.get_cf(&registry_cf, key.as_bytes()) {
                if v.len() >= 8
                    && u64::from_be_bytes(v[..8].try_into().unwrap_or([0u8; 8])) <= cur_height {
                    return true;
                }
            }
        }
        false
    }

    /// Streaming lrtr_ walk (reg_height < before_height), node_id-ascending — same rows and order as
    /// `light_roster_sorted` but O(1) memory: the reward reader at millions of light nodes must not
    /// collect the roster into a Vec on the emission path.
    pub fn light_roster_for_each<F: FnMut(&str, &str, u32)>(&self, before_height: u64, mut f: F) -> IntegrationResult<()> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let prefix = b"lrtr_";
        for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward)) {
            // Truncating here silently shrinks the light reward roster on one node; fail closed.
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("light_roster_for_each iterator failed: {}", e))),
            };
            if !k.starts_with(prefix) { break; }
            let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s, Err(_) => continue };
            let (h, idx, wallet) = match Self::decode_roster_index_value(&v) { Some(t) => t, None => continue };
            if h >= before_height { continue; }
            if !wallet.is_empty() { f(node_id, wallet, idx); }
        }
        Ok(())
    }

    /// Canonicalize the lhb_ index at a height reset (boot / snapshot-apply / reorg): drop entries
    /// included above the new tip, then re-index from the retained bodies of the last 3 subwindows
    /// (first-write-wins ⇒ idempotent; missing bodies skip — the CF-snapshot-carried index covers them).
    /// Keeps index == canonical chain on every path an old-binary or fork could have diverged.
    pub fn canonicalize_heartbeat_index(&self, up_to_height: u64) -> IntegrationResult<()> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut batch = rocksdb::WriteBatch::default();
        for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(b"lhb_", Direction::Forward)) {
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("heartbeat_canonicalize iterator failed: {}", e))),
            };
            if !k.starts_with(b"lhb_") { break; }
            let inc = if v.len() >= 8 { u64::from_be_bytes(v[..8].try_into().unwrap_or([0u8; 8])) } else { u64::MAX };
            if inc > up_to_height { batch.delete_cf(&registry_cf, &k); }
        }
        self.persistent.db.write(batch)?;
        // Same span as the prune floor, or a boot/reorg re-canonicalise would re-narrow the index the
        // deep readers depend on.
        let start_sw = (up_to_height / 1440).saturating_sub(LHB_RETAINED_SUBWINDOWS);
        for h in start_sw.saturating_mul(1440)..=up_to_height {
            if let Ok(Some(block)) = self.load_microblock_auto_format(h) {
                for tx in &block.transactions {
                    if let qnet_state::TransactionType::Heartbeat { node_id, anchor_height, .. } = &tx.tx_type {
                        let _ = self.index_heartbeat_inclusion(node_id, *anchor_height, h);
                    }
                }
            }
        }
        Ok(())
    }

    /// Sorted (node_id, wallet) of all chain-registered Super/genesis nodes — the deterministic
    /// candidate set for heartbeat-eligibility reward enumeration (popcount filter applied by caller).
    /// Reads the apply-time `srtr_` index (prefix scan, node_id-ascending, no JSON, no sort);
    /// byte-identical to `super_registrations_sorted_scan` but O(supers) without a per-entry parse.
    pub fn super_registrations_sorted(&self) -> IntegrationResult<Vec<(String, String)>> {
        let mut out: Vec<(String, String)> = Vec::new();
        self.super_roster_for_each(|node_id, wallet, _h, _idx| out.push((node_id.to_string(), wallet.to_string())))?;
        Ok(out)
    }

    /// The SUPER roster as of `up_to_height`: (node_id, wallet) for every chain-confirmed super whose
    /// `reg_height <= up_to_height`, ascending by node_id.
    ///
    /// This is the height-bounded twin of `super_registrations_sorted`, which has no height dimension at
    /// all and therefore returns whatever this node has applied RIGHT NOW. That set is a property of the
    /// applied branch, not of a height — and it is the input to the eligible-producer snapshot, whose
    /// output goes into `epoch_commitment` and thence into a QC. Today the divergence is masked because
    /// a per-candidate reg-height filter runs downstream; deriving the pool at the height in the first
    /// place removes the superset-then-filter pattern, so there is no window in which the two can differ.
    ///
    /// Both keys are pruned together on reorg/boot/snapshot canonicalisation, so `srtr_` is a sound
    /// membership index; the `node_` row supplies the height and the wallet.
    pub fn super_registrations_as_of(&self, up_to_height: u64) -> IntegrationResult<Vec<(String, String)>> {
        let mut out: Vec<(String, String)> = Vec::new();
        self.super_roster_for_each(|node_id, wallet, h, _idx| {
            if h <= up_to_height { out.push((node_id.to_string(), wallet.to_string())); }
        })?;
        Ok(out)
    }

    /// One ascending pass over the `srtr_` index, yielding (node_id, wallet, reg_height) straight from
    /// the index value. The single decoder for that value — every roster reader goes through it, so the
    /// encoding can never be read two different ways.
    fn super_roster_for_each<F: FnMut(&str, &str, u64, u32)>(&self, mut f: F) -> IntegrationResult<()> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let prefix = b"srtr_";
        for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward)) {
            // A mid-iteration RocksDB error must NOT return a truncated roster as Ok: this set feeds
            // eligible_producers -> epoch_commitment, so a short read is a divergent commitment on one
            // node, not a smaller roster.
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("super_roster_for_each iterator failed: {}", e))),
            };
            if !k.starts_with(prefix) { break; }
            let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(x) => x, Err(_) => continue };
            let (h, idx, wallet) = match Self::decode_roster_index_value(&v) { Some(t) => t, None => continue };
            if wallet.is_empty() { continue; }
            f(node_id, wallet, h, idx);
        }
        Ok(())
    }

    /// Durable NodeRegistration-origin marker. Written ONLY by write_registration_row, so the set
    /// is exactly what the in-memory dedup map holds — activations write registry rows too, and
    /// reseeding from those would reject honest re-registrations.
    pub fn mark_node_registration_origin(&self, node_id: &str, wallet: &str) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        self.persistent.db.put_cf(&cf, format!("nreg_{}", node_id).as_bytes(), wallet.as_bytes())?;
        Ok(())
    }

    /// The registration-origin set: node_id -> wallet for every applied NodeRegistration.
    pub fn load_registration_origins(&self) -> IntegrationResult<Vec<(String, String)>> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let mut out = Vec::new();
        for item in self.persistent.db.prefix_iterator_cf(&cf, b"nreg_") {
            let (k, v) = match item { Ok(kv) => kv, Err(_) => continue };
            if !k.starts_with(b"nreg_") { break; }
            let id = match std::str::from_utf8(&k[5..]) { Ok(s) => s.to_string(), Err(_) => continue };
            let w = match std::str::from_utf8(&v) { Ok(s) => s.to_string(), Err(_) => continue };
            out.push((id, w));
        }
        Ok(out)
    }

    /// Every CHAIN-CONFIRMED node_id->wallet binding in the node_registry CF (super/genesis AND light,
    /// all types). Used to rebuild the in-mem `registered_nodes` NodeRegistration-dedup map on cold-join:
    /// the CF is snapshot-bound (registry_root in the QC Checkpoint), so deriving the dedup set from it is
    /// sound. Mirrors the `node_` decode used by backfill_roster_indices / rebuild_committed_burn_wallet
    /// (key `node_<id>`, JSON value, `wallet` field). Skips entries WITHOUT `reg_height` (non-deterministic
    /// RPC/discovery cache writes) so the set is identical to a from-genesis node — distinct from
    /// load_all_node_registrations, which is the startup P2P-registry restore and includes unconfirmed rows.
    /// Reset the derived commitment-dedup maps and reseed `registered_nodes` from the durable
    /// node_registry CF (bound by registry_root in the QC Checkpoint). THE single entry point for
    /// every path that rebuilds the chain view from a snapshot — cold-join rehydrate, boot restore
    /// and post-rollback reconcile — so the three cannot drift apart. Must run AFTER
    /// `rebuild_registry_lthash`, which prunes rows above the tip; reseeding first would re-import
    /// the very orphans that prune exists to drop.
    pub fn reseed_commitment_dedup(&self, sg: &qnet_state::State) -> IntegrationResult<usize> {
        sg.reset_commitment_dedup();
        let regs = self.registry_root_covered_origins()?;
        let n = regs.len();
        for (node_id, wallet) in regs {
            sg.seed_registered_node(&node_id, &wallet);
        }
        println!("[INFO][STATE] commitment_dedup_reseeded registered={}", n);
        Ok(n)
    }

    /// Is this node_registry key one that `registry_root` covers? Only these may be imported from a
    /// snapshot; every other prefix (`vrf_pk_`, `nreg_`, `lhb_`, endpoints, caches) is unbound peer
    /// data and is re-derived locally from the covered rows after promote.
    pub(crate) fn registry_key_is_root_covered(k: &[u8]) -> bool {
        // `node_<id>` ONLY. compute_lt_state_cf enumerates srtr_/lrtr_ by KEY and folds the payload out
        // of node_<id>, so the index VALUES (reg_height ++ payout wallet) are outside the root — and
        // super_roster_for_each reads both straight out of them. Importing them would let a snapshot
        // server dictate a joiner's payout wallets and effective reg_heights. They are a pure function
        // of the covered rows, so backfill_roster_indices rebuilds them byte-identically.
        k.starts_with(b"node_")
    }

    /// Does a staged `vrf_pk_<id>` value hash to the commitment in the staged, root-covered
    /// `node_<id>.vrf_pk_sha3`? Only then may it become the key the QC verifier resolves against.
    fn staged_vrf_pk_matches_commitment(
        db: &rocksdb::DB, stage: &impl rocksdb::AsColumnFamilyRef, node_id: &str, pk: &[u8],
    ) -> bool {
        let raw = match db.get_cf(stage, format!("node_{}", node_id).as_bytes()) {
            Ok(Some(v)) => v, _ => return false,
        };
        let parsed: serde_json::Value = match serde_json::from_slice(&raw) { Ok(p) => p, Err(_) => return false };
        // reg_height present == chain-confirmed, the same filter the root's fold applies.
        if parsed["reg_height"].as_u64().is_none() { return false; }
        match parsed["vrf_pk_sha3"].as_str() {
            Some(tag) if !tag.is_empty() => {
                use sha3::{Digest, Sha3_256};
                hex::encode(Sha3_256::digest(pk)) == tag
            }
            _ => false,
        }
    }

    /// Every `(node_id, wallet)` binding `registry_root` actually covers: the same `srtr_`/`lrtr_` ->
    /// `node_<id>` traversal `compute_lt_state_cf` folds, chain-confirmed only.
    ///
    /// The dedup seed used to read the `nreg_` prefix, which the root does NOT cover, while a snapshot
    /// is imported unfiltered — so one injected `nreg_<victim>` row made a joiner skip that node's real
    /// registration as a duplicate and left its `registry_root` permanently one row short.
    pub fn registry_root_covered_origins(&self) -> IntegrationResult<Vec<(String, String)>> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let mut out = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for prefix in [b"srtr_".as_ref(), b"lrtr_".as_ref()] {
            for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(prefix, Direction::Forward)) {
                let (k, _) = match item {
                    Ok(kv) => kv,
                    Err(e) => return Err(IntegrationError::StorageError(
                        format!("registry_root_covered_origins iterator failed: {}", e))),
                };
                if !k.starts_with(prefix) { break; }
                let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s.to_string(), Err(_) => continue };
                if !seen.insert(node_id.clone()) { continue; } // already counted under the other prefix
                let nk = format!("node_{}", node_id);
                let val = match self.persistent.db.get_cf(&cf, nk.as_bytes()) { Ok(Some(v)) => v, _ => continue };
                let parsed: serde_json::Value = match serde_json::from_slice(&val) { Ok(p) => p, Err(_) => continue };
                // reg_height present == chain-confirmed. Its ABSENCE is what excludes the
                // non-deterministic RPC/discovery cache writes, exactly as the root's fold does.
                if parsed["reg_height"].as_u64().is_none() { continue; }
                // `registered_nodes` is written ONLY by NodeRegistration, but an activation also writes
                // a roster row. Seeding from every roster row makes a restarted node reject a genuine
                // later registration that every running node accepts — and a registration has no
                // account effect, so state_root still agrees while registry_root goes one row short.
                // Every gated registration carries a burn; activations do not. Genesis is exempt.
                let has_burn = parsed["burn"].as_str().map_or(false, |b| !b.is_empty());
                if !has_burn && !node_id.starts_with("genesis_node_") { continue; }
                let wallet = parsed["wallet"].as_str().unwrap_or("").to_string();
                if wallet.is_empty() { continue; }
                out.push((node_id, wallet));
            }
        }
        Ok(out)
    }

    pub(crate) fn epoch_root_key(epoch: u64) -> String { format!("epoch_root_{:010}", epoch) }

    /// Write a raw node_registry row. Test-only: the point of these tests is what happens when rows
    /// arrive from OUTSIDE the apply path — i.e. from an imported snapshot — so they must be placed
    /// without going through the writers that would sanitise them.
    #[cfg(test)]
    pub fn put_registry_row_for_test(&self, cf: &str, key: &[u8], val: &[u8]) {
        let h = self.persistent.db.cf_handle(cf).expect("registry CF");
        self.persistent.db.put_cf(&h, key, val).expect("put registry row");
    }

    #[cfg(test)]
    pub fn registry_cf_for_test(&self) -> String { "node_registry".to_string() }

    #[cfg(test)]
    pub fn wipe_epoch_root_cache_for_test(&self) {
        let _ = self.clear_cf("pending_rewards");
    }

    #[cfg(test)]
    pub fn seed_epoch_root_for_test(&self, epoch: u64, root: [u8; 32]) {
        let cf = self.persistent.db.cf_handle("pending_rewards").expect("pending_rewards CF");
        self.persistent.db.put_cf(&cf, Self::epoch_root_key(epoch).as_bytes(), &root).expect("seed root");
    }

    /// Verify the staged epoch roots against the anchor's certified commitment and ONLY THEN write
    /// them live. Nothing is mutated on the reject path, so a forged snapshot leaves no trace and the
    /// retry starts clean. Bounded by the same N-2 rule the commitment uses: rows above it are not
    /// covered by the proof, so they are dropped rather than trusted.
    fn carry_and_verify_epoch_roots(&self, anchor_height: u64) -> IntegrationResult<usize> {
        let mb_index = anchor_height / qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
        // The proof target is Checkpoint.reward_epoch_root; it only authenticates a snapshot once the
        // committee compares it (feature_gates: reward_epoch_root_required), so the carry follows the
        // same gate. Active from genesis — this branch exists for a staged rollout, not for normal use.
        if !qnet_state::feature_gates::is_active("reward_epoch_root_required", anchor_height) {
            // Unreachable while the gate is active. Leave the live CF ALONE: carrying nothing is one
            // thing, wiping the rows a from-genesis node already holds is another.
            println!("[WARN][SNAPSHOT] epoch_roots_carry_skipped anchor_h={} reason=authenticator_gated_off", anchor_height);
            return Ok(0);
        }
        let certified = self.get_macroblock_by_height(mb_index)?
            .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok())
            .and_then(|mb| mb.consensus_data.checkpoint_qc)
            .and_then(|q| bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint,
                                                  qnet_consensus::checkpoint_bft::QuorumCertificate)>(&q).ok())
            .map(|(cp, _)| cp.reward_epoch_root)
            .ok_or_else(|| IntegrationError::StorageError(format!(
                "epoch_roots_unprovable anchor_mb={} (no certified commitment to prove against)", mb_index)))?;

        // ONLY the proven band is carried. The staged CF is NOT bound by anything (the binder covers
        // accounts/state_root, node_registry/registry_root and dpk_root — not this), so an unproven
        // row is attacker-chosen, and root_for_apply reads the cache before the macroblock, making it
        // sticky and authoritative. The (N-2, anchor] band is exactly {mb_idx-1, mb_idx}, whose
        // macroblocks the lineage walk guarantees present, so derive_epoch_root_from_macroblock
        // rebuilds them — dropping them costs nothing.
        let n2 = mb_index.saturating_sub(2);
        let mut carried: Vec<(u64, [u8; 32])> = Vec::new();
        if let Some(st) = self.persistent.db.cf_handle("pending_rewards_stage") {
            for item in self.persistent.db.iterator_cf(&st, rocksdb::IteratorMode::Start).flatten() {
                let (k, v) = item;
                if !k.starts_with(b"epoch_root_") || v.len() != 32 { continue; }
                let digits = match std::str::from_utf8(&k[11..]) { Ok(d) => d, Err(_) => continue };
                let epoch = match digits.parse::<u64>() { Ok(e) => e, Err(_) => continue };
                // Canonical key only: a non-padded or off-grid key is not something the canonical
                // writer produces, and admitting one lets a staged row be folded that the
                // commitment's grid walk can never reach.
                if digits.len() != 10 || Self::epoch_root_key(epoch).as_bytes() != k.as_ref() { continue; }
                if !crate::reward_epoch::is_reward_epoch(epoch) { continue; }
                // Band test WITHOUT arithmetic on the untrusted epoch: n2 - MB_PER_EPOCH is the
                // largest epoch the certificate covers.
                // Same predicate as the commitment, expressed without adding to the untrusted epoch:
                // saturating_sub collapses to 0 when n2 < MB_PER_EPOCH and would admit epoch 0 that
                // the commitment excludes, so a cold join at anchor macroblock 160 would mismatch.
                if n2 < crate::reward_epoch::MB_PER_EPOCH
                    || epoch > n2 - crate::reward_epoch::MB_PER_EPOCH { continue; }
                let mut r = [0u8; 32];
                r.copy_from_slice(&v);
                carried.push((epoch, r));
            }
        }
        carried.sort_by_key(|(e, _)| *e);

        let mut lt = crate::registry_lthash::LtHash::new();
        for (e, r) in &carried { lt.add(&crate::reward_epoch::epoch_root_lanes(*e, r)); }
        if lt.root() != certified {
            return Err(IntegrationError::StorageError(format!(
                "epoch_roots_mismatch anchor_h={} carried={} local={} certified={}",
                anchor_height, carried.len(),
                hex::encode(&lt.root()[..8]), hex::encode(&certified[..8]))));
        }

        // Proven — now, and only now, replace the live set.
        let live = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards CF not found".to_string()))?;
        // Replace ONLY the epoch-root rows. This CF also holds super_elig_/light_bm_/lelig_ and the
        // reward shards; wiping those costs a from-genesis node data it cannot re-derive.
        let mut batch = WriteBatch::default();
        for item in self.persistent.db
            .iterator_cf(&live, rocksdb::IteratorMode::From(b"epoch_root_", rocksdb::Direction::Forward))
            .flatten()
        {
            let (k, _) = item;
            if !k.starts_with(b"epoch_root_") { break; }
            batch.delete_cf(&live, &k);
        }
        for (e, r) in &carried {
            batch.put_cf(&live, Self::epoch_root_key(*e).as_bytes(), r);
        }
        self.persistent.db.write(batch)?;
        self.clear_epoch_fold_head(); // the root set was replaced wholesale
        println!("[INFO][SNAPSHOT] epoch_roots_verified anchor_h={} count={}", anchor_height, carried.len());
        Ok(carried.len())
    }

    /// Memo for the epoch-root commitment: folded lanes covering every epoch <= `last_epoch`. A pure
    /// cache — dropping it costs one re-walk, never correctness.
    pub fn load_epoch_fold_head(&self) -> Option<(u64, [u16; crate::registry_lthash::LANES])> {
        let cf = self.persistent.db.cf_handle("pending_rewards")?;
        let v = self.persistent.db.get_cf(&cf, b"epoch_fold_head").ok()??;
        if v.len() != 8 + crate::registry_lthash::LANES * 2 { return None; }
        let mut eb = [0u8; 8];
        eb.copy_from_slice(&v[..8]);
        let mut lanes = [0u16; crate::registry_lthash::LANES];
        for (i, l) in lanes.iter_mut().enumerate() {
            *l = u16::from_le_bytes([v[8 + i * 2], v[9 + i * 2]]);
        }
        Some((u64::from_le_bytes(eb), lanes))
    }

    pub fn save_epoch_fold_head(&self, last_epoch: u64, lanes: &[u16; crate::registry_lthash::LANES]) {
        if let Some(cf) = self.persistent.db.cf_handle("pending_rewards") {
            let mut v = Vec::with_capacity(8 + lanes.len() * 2);
            v.extend_from_slice(&last_epoch.to_le_bytes());
            for l in lanes.iter() { v.extend_from_slice(&l.to_le_bytes()); }
            let _ = self.persistent.db.put_cf(&cf, b"epoch_fold_head", &v);
        }
    }

    /// Drop the memo whenever the underlying root set is replaced wholesale (snapshot carry).
    pub fn clear_epoch_fold_head(&self) {
        if let Some(cf) = self.persistent.db.cf_handle("pending_rewards") {
            let _ = self.persistent.db.delete_cf(&cf, b"epoch_fold_head");
        }
    }

    /// Derive an epoch's root from the macroblock this node already holds, and cache it.
    /// Makes `epoch_root_` a true cache: wiping it (snapshot promote) costs a re-derivation, never
    /// correctness, and a macroblock stored before the row existed still resolves.
    pub fn derive_epoch_root_from_macroblock(&self, epoch: u64) -> IntegrationResult<Option<[u8; 32]>> {
        let mb_index = match crate::reward_epoch::certifying_mb_index(epoch) {
            Some(m) => m,
            None => return Ok(None), // overflowed ⇒ not a real epoch, never write a row for it
        };
        let bytes = match self.get_macroblock_by_height(mb_index)? { Some(b) => b, None => return Ok(None) };
        let mb: qnet_state::MacroBlock = match bincode::deserialize(&bytes) { Ok(m) => m, Err(_) => return Ok(None) };
        let root = match mb.consensus_data.checkpoint_qc.as_ref()
            .and_then(|b| bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint,
                                                  qnet_consensus::checkpoint_bft::QuorumCertificate)>(b).ok())
            .map(|(cp, _)| cp.reward_root) {
            Some(r) => r,
            None => return Ok(None),
        };
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards CF not found".to_string()))?;
        self.persistent.db.put_cf(&cf, Self::epoch_root_key(epoch).as_bytes(), &root)?;
        Ok(Some(root))
    }

    /// The certified root for `epoch`, or None if this node has not stored its macroblock yet.
    /// All-zero is a real value (nothing was distributed), distinct from absent.
    pub fn load_epoch_root(&self, epoch: u64) -> IntegrationResult<Option<[u8; 32]>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards CF not found".to_string()))?;
        match self.persistent.db.get_cf(&cf, Self::epoch_root_key(epoch).as_bytes())? {
            Some(v) if v.len() == 32 => {
                let mut r = [0u8; 32];
                r.copy_from_slice(&v);
                Ok(Some(r))
            }
            _ => Ok(None),
        }
    }

    /// Every epoch whose root this node holds, ascending. Range scan, no separate index to drift.
    pub fn reward_epochs_from(&self, start: u64) -> IntegrationResult<Vec<u64>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards CF not found".to_string()))?;
        let from = Self::epoch_root_key(start);
        let mut out = Vec::new();
        let iter = self.persistent.db.iterator_cf(
            &cf, rocksdb::IteratorMode::From(from.as_bytes(), rocksdb::Direction::Forward));
        for item in iter.flatten() {
            let (k, _) = item;
            if !k.starts_with(b"epoch_root_") { break; }
            if let Some(e) = std::str::from_utf8(&k[11..]).ok().and_then(|d| d.parse::<u64>().ok()) {
                out.push(e);
            }
        }
        Ok(out)
    }

    pub fn load_confirmed_node_registrations(&self) -> IntegrationResult<Vec<(String, String)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut out: Vec<(String, String)> = Vec::new();
        for item in self.persistent.db.prefix_iterator_cf(&registry_cf, b"node_") {
            let (k, v) = match item { Ok(kv) => kv, Err(_) => continue };
            let key = match std::str::from_utf8(&k) { Ok(s) => s, Err(_) => continue };
            let node_id = match key.strip_prefix("node_") { Some(id) => id, None => continue };
            let parsed: serde_json::Value = match serde_json::from_slice(&v) { Ok(p) => p, Err(_) => continue };
            if parsed["reg_height"].as_u64().is_none() { continue; } // chain-confirmed only
            let wallet = parsed["wallet"].as_str().unwrap_or("");
            if !wallet.is_empty() { out.push((node_id.to_string(), wallet.to_string())); }
        }
        Ok(out)
    }

    /// Legacy full-CF scan source of truth for the Light roster. Kept as the backfill builder and
    /// the determinism-test oracle for `light_roster_sorted` (index reader); NOT on any hot path.
    #[cfg_attr(not(test), allow(dead_code))]
    fn light_roster_sorted_scan(&self, before_height: u64) -> IntegrationResult<Vec<(String, String)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut out: Vec<(String, String)> = Vec::new();
        for item in self.persistent.db.iterator_cf(&registry_cf, rocksdb::IteratorMode::Start) {
            let (k, v) = item?;
            let key = match std::str::from_utf8(&k) { Ok(s) => s, Err(_) => continue };
            let node_id = match key.strip_prefix("node_") { Some(id) => id, None => continue };
            let parsed = match serde_json::from_slice::<serde_json::Value>(&v) { Ok(p) => p, Err(_) => continue };
            if parsed["node_type"].as_str() != Some("light") { continue; }
            match parsed["reg_height"].as_u64() {
                Some(h) if h < before_height => {}
                _ => continue,
            }
            let wallet = parsed["wallet"].as_str().unwrap_or("");
            if !wallet.is_empty() { out.push((node_id.to_string(), wallet.to_string())); }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// Legacy full-CF scan source of truth for the Super roster — backfill builder + determinism-test
    /// oracle for `super_registrations_sorted` (index reader); NOT on any hot path.
    #[cfg_attr(not(test), allow(dead_code))]
    fn super_registrations_sorted_scan(&self) -> IntegrationResult<Vec<(String, String)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut out: Vec<(String, String)> = Vec::new();
        for item in self.persistent.db.iterator_cf(&registry_cf, rocksdb::IteratorMode::Start) {
            let (k, v) = item?;
            let key = match std::str::from_utf8(&k) { Ok(s) => s, Err(_) => continue };
            let node_id = match key.strip_prefix("node_") { Some(id) => id, None => continue };
            if !(node_id.starts_with("super_") || node_id.starts_with("genesis_node_")) { continue; }
            let parsed = match serde_json::from_slice::<serde_json::Value>(&v) { Ok(p) => p, Err(_) => continue };
            // Only chain-confirmed registrations (reg_height stamped at block-apply / genesis boot) —
            // excludes non-deterministic RPC/discovery cache writes so the set is identical per node.
            if parsed["reg_height"].as_u64().is_none() { continue; }
            let wallet = parsed["wallet"].as_str().unwrap_or("");
            if !wallet.is_empty() { out.push((node_id.to_string(), wallet.to_string())); }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// Reconcile the reward-roster indices (`srtr_`/`lrtr_`) from the chain-confirmed `node_` entries.
    /// Needed once when upgrading a pre-index DB and after a snapshot jump (state fast-sync writes
    /// node_ entries directly, not via the apply funnel). Pure function of the stamped node_ set ⇒
    /// deterministic; skip-if-present ⇒ safe to re-run. Cold path only (one full-CF scan).
    pub fn backfill_roster_indices(&self) -> IntegrationResult<u32> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let iter = self.persistent.db.prefix_iterator_cf(&registry_cf, b"node_");
        let mut batch = rocksdb::WriteBatch::default();
        let mut added = 0u32;
        for item in iter {
            // Sole reconstructor of srtr_/lrtr_ on the promote path (the whitelist drops imported
            // rows), and registry_root enumerates those keys — a truncated scan is a divergent root.
            let (key, value) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("backfill_roster_indices iterator failed: {}", e))),
            };
            let key_str = match std::str::from_utf8(&key) { Ok(s) => s, Err(_) => continue };
            if !key_str.starts_with("node_") { continue; }
            let node_id = &key_str[5..];
            let parsed: serde_json::Value = match serde_json::from_slice(&value) { Ok(v) => v, Err(_) => continue };
            let h = match parsed["reg_height"].as_u64() { Some(h) => h, None => continue }; // chain-confirmed only
            let wallet = parsed["wallet"].as_str().unwrap_or("");
            let node_type = parsed["node_type"].as_str().unwrap_or("");
            let reg_index = parsed["reg_index"].as_u64().unwrap_or(0) as u32;
            if node_id.starts_with("super_") || node_id.starts_with("genesis_node_") {
                let ik = format!("srtr_{}", node_id);
                // AUTHORITATIVE, not skip-if-present: the index value is not covered by
                // registry_root, so a row that arrived any other way must be overwritten from the
                // covered node_<id>.
                batch.put_cf(&registry_cf, ik.as_bytes(), &Self::roster_index_value(h, reg_index, wallet));
                added += 1;
            }
            if node_type == "light" {
                let ik = format!("lrtr_{}", node_id);
                // Was skip-if-present while srtr_ was authoritative — the asymmetry meant a stale
                // light row survived a rebuild that healed the super rows beside it.
                batch.put_cf(&registry_cf, ik.as_bytes(), &Self::roster_index_value(h, reg_index, wallet));
                added += 1;
            }
        }
        if added > 0 {
            self.persistent.db.write(batch)?;
            println!("[INFO][STORAGE] backfill_roster_indices added={}", added);
        }
        Ok(added)
    }

    // ── reward aggregation scratch (10M-recipient root build) ────────────────────────────────────
    // Key: rag_{epoch:010}_{wallet}\0{node_id}. One PUT per eligible node — no read-modify-write.
    // RocksDB orders bytewise, which for these keys is exactly `BTreeMap<String, _>` order over the
    // wallet, so an ordered scan reproduces the in-memory aggregation byte-for-byte while holding
    // only one shard in RAM.
    fn reward_agg_prefix(build: u64) -> Vec<u8> {
        format!("rag_{:020}_", build).into_bytes()
    }

    /// A private key range for one build. Two reward builds can legitimately run at once (the WindowEnd
    /// checkpoint/verify path and the producer's emission path are independent tasks), and they would
    /// otherwise share one epoch-keyed range — one clearing while the other writes, i.e. a wrong root on
    /// a consensus path. Per-build isolation removes the interaction entirely, with no lock on a path
    /// that does RocksDB I/O.
    pub fn reward_agg_new_build(&self) -> u64 {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    /// Wipe the entire scratch CF. Pure per-process working space with no cross-run meaning, so a crash
    /// mid-build can only leave rows that this clears at open — before any build can read them.
    pub fn reward_agg_clear_all(&self) -> IntegrationResult<()> {
        if let Some(cf) = self.persistent.db.cf_handle("reward_agg") {
            let mut batch = rocksdb::WriteBatch::default();
            batch.delete_range_cf(&cf, b"rag_".as_ref(), b"rah_".as_ref());
            self.persistent.db.write(batch)?;
        }
        Ok(())
    }

    /// Drop one build's scratch. Called before a build and on every exit path after it.
    pub fn reward_agg_clear(&self, build: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("reward_agg")
            .ok_or_else(|| IntegrationError::StorageError("reward_agg column family not found".to_string()))?;
        let from = Self::reward_agg_prefix(build);
        let mut to = from.clone();
        to.push(0xff);
        let mut b = rocksdb::WriteBatch::default();
        b.delete_range_cf(&cf, &from, &to);
        self.persistent.db.write(b)?;
        Ok(())
    }

    /// Append one (wallet, node_id) → amount row. Batched by the caller.
    pub fn reward_agg_put_batch(&self, build: u64, rows: &[(String, String, u64)]) -> IntegrationResult<()> {
        if rows.is_empty() { return Ok(()); }
        let cf = self.persistent.db.cf_handle("reward_agg")
            .ok_or_else(|| IntegrationError::StorageError("reward_agg column family not found".to_string()))?;
        let mut b = rocksdb::WriteBatch::default();
        for (wallet, node_id, amt) in rows {
            let mut k = Self::reward_agg_prefix(build);
            k.extend_from_slice(wallet.as_bytes());
            k.push(0u8); // separator below every printable byte ⇒ wallet order is never split by node_id
            k.extend_from_slice(node_id.as_bytes());
            b.put_cf(&cf, &k, &amt.to_be_bytes());
        }
        self.persistent.db.write(b)?;
        Ok(())
    }

    /// Stream the epoch's rows in WALLET order, summing the runs that share a wallet. `f` sees each
    /// distinct wallet exactly once, ascending — the same sequence `BTreeMap::into_iter` produces.
    /// Fails closed on a mid-scan iterator error (this feeds reward_root, a hashed checkpoint field).
    pub fn reward_agg_for_each_wallet<F: FnMut(&str, u64)>(&self, build: u64, mut f: F) -> IntegrationResult<()> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("reward_agg")
            .ok_or_else(|| IntegrationError::StorageError("reward_agg column family not found".to_string()))?;
        let prefix = Self::reward_agg_prefix(build);
        let mut cur: Option<(String, u64)> = None;
        for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(&prefix, Direction::Forward)) {
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("reward_agg iterator failed: {}", e))),
            };
            if !k.starts_with(&prefix) { break; }
            let tail = &k[prefix.len()..];
            let wallet = match tail.iter().position(|b| *b == 0u8) {
                Some(p) => match std::str::from_utf8(&tail[..p]) { Ok(w) => w, Err(_) => continue },
                None => continue,
            };
            if v.len() != 8 { continue; }
            let amt = u64::from_be_bytes(v[..8].try_into().unwrap_or([0u8; 8]));
            match cur.as_mut() {
                Some((w, sum)) if w == wallet => { *sum = sum.saturating_add(amt); }
                _ => {
                    if let Some((w, sum)) = cur.take() { f(&w, sum); }
                    cur = Some((wallet.to_string(), amt));
                }
            }
        }
        if let Some((w, sum)) = cur { f(&w, sum); }
        Ok(())
    }

    /// One-time marker so the O(N) roster-index migration scan runs once, not on every restart.
    pub fn roster_index_built(&self) -> bool {
        match self.persistent.db.cf_handle("node_registry") {
            Some(cf) => self.persistent.db.get_cf(&cf, b"meta_roster_index_v1").map(|o| o.is_some()).unwrap_or(false),
            None => false,
        }
    }

    /// Set the roster-index migration marker after a successful backfill.
    pub fn set_roster_index_built(&self) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, b"meta_roster_index_v1", b"1")?;
        Ok(())
    }

    /// wallet_token index is built AND clean (skip boot backfill, trust empty results): build marker
    /// present AND dirty-sentinel absent. The sentinel — not marker-absence — is the "must rebuild"
    /// authority: marking dirty WRITES a key, so a failed op leaves it dirty (safe over-rebuild).
    pub fn owns_index_built(&self) -> bool {
        match self.persistent.db.cf_handle("metadata") {
            Some(cf) => {
                let built = self.persistent.db.get_cf(&cf, b"meta_owns_index_v1").map(|o| o.is_some()).unwrap_or(false);
                let dirty = self.persistent.db.get_cf(&cf, b"meta_owns_dirty").map(|o| o.is_some()).unwrap_or(true);
                built && !dirty
            }
            None => false,
        }
    }

    /// Mark built+clean after a full backfill at `height`: set marker, stamp the watermark to `height`
    /// (index now current up to there), THEN clear the dirty-sentinel (a crash between leaves it dirty →
    /// next boot rebuilds).
    pub fn set_owns_index_built(&self, height: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, b"meta_owns_index_v1", b"1")?;
        self.persistent.db.put_cf(&cf, b"meta_owns_watermark", &height.to_le_bytes())?;
        self.persistent.db.delete_cf(&cf, b"meta_owns_dirty")?;
        Ok(())
    }

    /// Durable owns-watermark: highest height whose owns-deltas are known persisted (0 if never set).
    /// Boot rebuilds the index only when this lags the tip (unclean shutdown lost the last deltas).
    pub fn owns_watermark(&self) -> u64 {
        self.persistent.db.cf_handle("metadata")
            .and_then(|cf| self.persistent.db.get_cf(&cf, b"meta_owns_watermark").ok().flatten())
            .and_then(|v| <[u8; 8]>::try_from(v.as_slice()).ok())
            .map(u64::from_le_bytes)
            .unwrap_or(0)
    }

    /// Advance the owns-watermark alone (empty-delta block: index already consistent at `height`).
    pub fn set_owns_watermark(&self, height: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, b"meta_owns_watermark", &height.to_le_bytes())?;
        Ok(())
    }

    /// Owns keys implied by one contract's storage — pure derivation for callers that hold the
    /// in-memory state (boot rebuild extracts keys under the read guard, no map clones).
    pub fn owns_index_keys(contract: &str, contract_storage: &std::collections::HashMap<String, String>) -> Vec<Vec<u8>> {
        PersistentStorage::owns_keys_for_contract(contract, contract_storage)
    }

    /// Rebuild wallet_token from pre-derived owns keys: one range-delete tombstone (every key sits
    /// under the `owns|` prefix), chunked re-index, mark built+clean+READY with the watermark stamped
    /// to `at_height`. NON-consensus. Returns keys written.
    pub fn rebuild_owns_from_keys(&self, keys: &[Vec<u8>], at_height: u64) -> IntegrationResult<usize> {
        if let Some(cf) = self.persistent.db.cf_handle("wallet_token") {
            let mut batch = WriteBatch::default();
            batch.delete_range_cf(&cf, b"owns|".as_ref(), b"owns}".as_ref());
            self.persistent.db.write(batch)?;
        }
        let n = self.persistent.write_owns_keys_batched(keys)?;
        self.set_owns_index_built(at_height)?;
        OWNS_INDEX_READY.store(true, Ordering::Relaxed);
        Ok(n)
    }

    /// Flag wallet_token possibly-incomplete (dropped delta write, promote/reorg rebuild, or unclean-
    /// shutdown replay which re-applies blocks without owns deltas): write a durable dirty-sentinel (the
    /// crash-safe rebuild trigger) and drop READY so the live reader falls back to scan until the next
    /// boot rebuilds. NON-consensus.
    pub fn mark_owns_index_dirty(&self) {
        OWNS_INDEX_READY.store(false, Ordering::Relaxed);
        if let Some(cf) = self.persistent.db.cf_handle("metadata") {
            // If the sentinel write fails, zero the watermark instead: a watermark regression (< tip) is
            // an equally-durable boot-rebuild trigger, so a failed dirty-mark is never silently lost.
            if self.persistent.db.put_cf(&cf, b"meta_owns_dirty", b"1").is_err() {
                let _ = self.persistent.db.put_cf(&cf, b"meta_owns_watermark", &0u64.to_le_bytes());
            }
        }
    }

    /// True iff this node's NodeRegistration is chain-confirmed (reg_height stamped at
    /// block-apply / genesis boot) in the local node_registry. The on-chain binding is the
    /// source of truth — a locally-persisted activation code does NOT prove the registration
    /// TX landed. Used at boot to decide whether to (re)send the binding TX.
    pub fn is_node_registration_onchain(&self, node_id: &str) -> bool {
        let registry_cf = match self.persistent.db.cf_handle("node_registry") {
            Some(cf) => cf,
            None => return false,
        };
        let key = format!("node_{}", node_id);
        match self.persistent.db.get_cf(&registry_cf, key.as_bytes()) {
            Ok(Some(v)) => serde_json::from_slice::<serde_json::Value>(&v)
                .map(|p| p["reg_height"].as_u64().is_some())
                .unwrap_or(false),
            _ => false,
        }
    }

    /// O(1) lookup: get node by wallet — derives the canonical id + point-reads node_<id> (no reverse index).
    pub fn get_node_by_wallet(&self, wallet_address: &str) -> IntegrationResult<Option<(String, String)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let id = match self.resolve_node_id(wallet_address) { Some(i) => i, None => return Ok(None) };
        let node_type = match self.persistent.db.get_cf(&registry_cf, format!("node_{}", id).as_bytes())? {
            Some(v) => serde_json::from_slice::<serde_json::Value>(&v).ok()
                .and_then(|j| j["node_type"].as_str().map(|s| s.to_string())).unwrap_or_default(),
            None => return Ok(None),
        };
        Ok(Some((id, node_type)))
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
    
    /// Chain-announced RPC endpoint for a node, persisted in the registry CF (so it survives restarts
    /// and rides the state snapshot a cold joiner restores). NOT part of registry_root — it is reachability
    /// metadata, not consensus state. Sole writer is the block-apply registration scan; without it the
    /// endpoint lived only in a process-local map, so a fresh joiner could reach nothing but the pinned
    /// genesis IPs and burn-attestation quorum became unreachable once the committee outgrew them.
    pub fn save_node_endpoint(&self, node_id: &str, endpoint: &str) -> IntegrationResult<()> {
        if endpoint.is_empty() { return Ok(()); }
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        self.persistent.db.put_cf(&cf, format!("nep_{}", node_id).as_bytes(), endpoint.as_bytes())?;
        Ok(())
    }

    /// Committed RPC endpoint for `node_id`, or None if the node publishes no endpoint.
    pub fn load_node_endpoint(&self, node_id: &str) -> IntegrationResult<Option<String>> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        match self.persistent.db.get_cf(&cf, format!("nep_{}", node_id).as_bytes())? {
            Some(v) => Ok(String::from_utf8(v).ok().filter(|s| !s.is_empty())),
            None => Ok(None),
        }
    }

    /// Every persisted Super/genesis endpoint as (node_id, endpoint), for the boot rehydrate of the
    /// in-RAM endpoint registry. node_ids are type-prefixed, so the two seeks below cover exactly the
    /// same set `srtr_` indexes and never enter the `nep_light_*` key range (10M-scale, always empty
    /// because a light registration carries no endpoint) — bounded by the Super count, not the roster.
    pub fn load_all_node_endpoints(&self) -> IntegrationResult<Vec<(String, String)>> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let mut out: Vec<(String, String)> = Vec::new();
        for prefix in [b"nep_genesis_node_".as_ref(), b"nep_super_".as_ref()] {
            for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(prefix, Direction::Forward)) {
                let (k, v) = match item {
                    Ok(kv) => kv,
                    Err(e) => return Err(IntegrationError::StorageError(
                        format!("load_all_node_endpoints iterator failed: {}", e))),
                };
                if !k.starts_with(prefix) { break; }
                let node_id = match std::str::from_utf8(&k[4..]) { Ok(s) => s, Err(_) => continue };
                let endpoint = match std::str::from_utf8(&v) { Ok(s) => s, Err(_) => continue };
                if node_id.is_empty() || endpoint.is_empty() { continue; }
                out.push((node_id.to_string(), endpoint.to_string()));
            }
        }
        Ok(out)
    }

    /// v4.0: Save VRF public key for node (persists across restarts)
    pub fn save_vrf_public_key(&self, node_id: &str, pk_hex: &str) -> IntegrationResult<()> {
        // Same rule as the RAM registry: a genesis identity's key is pinned in the binary and nothing
        // off the wire may restate it. This leg is the dangerous one — the row survives restarts, the
        // boot reload re-imports it without re-authentication, and the consensus vote/QC verifiers read
        // the row BEFORE falling back to the anchor, so a poisoned row outranks the pinned truth.
        let anchor = qnet_consensus::consensus_crypto::get_consensus_pk_anchor(node_id);
        let incoming = hex::decode(pk_hex).unwrap_or_default();
        if crate::genesis_constants::genesis_pk_overwrite_refused(anchor.as_deref(), &incoming) {
            println!("[ERR][STORAGE] genesis_vrf_pk_overwrite_refused node={}", node_id);
            return Ok(());
        }
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let key = format!("vrf_pk_{}", node_id);
        // IMMUTABLE ONCE STAMPED, for every identity — not only anchored genesis ones. This row is the
        // consensus trust root (vote/QC verify, producer-signature verify, burn-attestor PK), and a
        // later write for the same node_id was an identity takeover: a second registration naming an
        // existing node_id is a state no-op, so the rewrite was silent. Mirrors vrf_pk_sha3 in the
        // node_ row. Re-writing the SAME key stays idempotent.
        if let Some(existing) = self.persistent.db.get_cf(&registry_cf, key.as_bytes())? {
            if existing.as_slice() != pk_hex.as_bytes() {
                println!("[ERR][STORAGE] vrf_pk_rebind_refused node={}", node_id);
            }
            return Ok(());
        }
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

    /// Chain-confirmed registration height of a node (None if unregistered or reg_height unstamped).
    /// Used to bound the eligible-producer candidate set to registrations confirmed AS OF a macroblock
    /// end_height: committee members at divergent live applied tips (production never waits for
    /// consensus) must compute the SAME set, so an ahead-of-end_height registration must be excluded
    /// identically on every node. Genesis nodes carry reg_height=0.
    /// The CANONICAL consensus-key commitment for `node_id`: sha3-256 of its consensus public key as
    /// recorded in the `node_` registry row. Unlike the standalone `vrf_pk_` row, this one is written
    /// only by chain apply, is reg_height-bounded, is covered by registry_root, and IS pruned when a
    /// branch is reorged out — so a verdict derived from it cannot depend on which branches this node
    /// happened to see.
    pub fn node_signer_key_commitment(&self, node_id: &str) -> IntegrationResult<Option<String>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        match self.persistent.db.get_cf(&registry_cf, format!("node_{}", node_id).as_bytes())? {
            Some(data) => {
                let parsed: serde_json::Value = serde_json::from_slice(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(parsed["vrf_pk_sha3"].as_str().filter(|v| !v.is_empty()).map(|v| v.to_string()))
            }
            None => Ok(None),
        }
    }

    pub fn node_reg_height(&self, node_id: &str) -> IntegrationResult<Option<u64>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let key = format!("node_{}", node_id);
        match self.persistent.db.get_cf(&registry_cf, key.as_bytes())? {
            Some(data) => {
                let parsed: serde_json::Value = serde_json::from_slice(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(parsed["reg_height"].as_u64())
            }
            None => Ok(None),
        }
    }

    /// Get the node registered to a wallet (mobile app reads it even when the node is offline — data comes
    /// from chain storage, not node memory). Deterministic wallet→node resolution: derive the wallet's
    /// canonical id (pure fn of the wallet) and point-read node_<id>. No stored reverse index ⇒ every
    /// honest node returns the identical answer, no per-node flip. O(1) (≤3 point-reads). One wallet backs
    /// at most one node (each id costs a burn). Vec-typed for the existing callers; ≤1 element.
    pub fn get_nodes_by_wallet(&self, wallet_address: &str) -> IntegrationResult<Vec<(String, String, f64)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let id = match self.resolve_node_id(wallet_address) { Some(i) => i, None => return Ok(Vec::new()) };
        let (node_type, reputation) = match self.persistent.db.get_cf(&registry_cf, format!("node_{}", id).as_bytes())? {
            Some(v) => {
                let np: serde_json::Value = serde_json::from_slice(&v).unwrap_or_default();
                (np["node_type"].as_str().unwrap_or("").to_string(),
                 np["reputation"].as_f64().unwrap_or(qnet_consensus::deterministic_reputation::INITIAL_REPUTATION))
            }
            None => return Ok(Vec::new()),
        };
        Ok(vec![(id, node_type, reputation)])
    }

    /// Derive the wallet's candidate node ids (pure functions of the wallet: genesis constant map, else
    /// super_node_<h> / light_mobile_<h>) and return the first whose node_<id> row exists. Recomputed
    /// identically on every node — resolution never reads a mutable, race-able reverse slot.
    fn resolve_node_id(&self, wallet: &str) -> Option<String> {
        let cf = self.persistent.db.cf_handle("node_registry")?;
        let mut cands: Vec<String> = Vec::with_capacity(3);
        for (id, w) in crate::genesis_constants::GENESIS_WALLETS {
            if *w == wallet { cands.push(format!("genesis_node_{}", id)); break; }
        }
        cands.push(crate::rpc::generate_super_node_pseudonym(wallet));
        cands.push(crate::rpc::generate_light_node_pseudonym(wallet));
        cands.into_iter().find(|id|
            matches!(self.persistent.db.get_cf(&cf, format!("node_{}", id).as_bytes()), Ok(Some(_))))
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

    /// C: light ping delegation keys — operational CF read per-ping so the crypto stays off the RAM
    /// registry. Written at register / gossip-receive AFTER the identity guard passes; No-op on empty.
    pub fn save_light_ping_keys(&self, node_id: &str, ping_pubkey: &str, ping_delegation_cert: &str) -> IntegrationResult<()> {
        if ping_pubkey.is_empty() { return Ok(()); }
        let cf = self.persistent.db.cf_handle("light_ping_keys")
            .ok_or_else(|| IntegrationError::StorageError("light_ping_keys column family not found".to_string()))?;
        let v = json!({ "ping_pubkey": ping_pubkey, "ping_delegation_cert": ping_delegation_cert });
        self.persistent.db.put_cf(&cf, node_id.as_bytes(), v.to_string().as_bytes())?;
        Ok(())
    }
    pub fn get_light_ping_keys(&self, node_id: &str) -> Option<(String, String)> {
        let cf = self.persistent.db.cf_handle("light_ping_keys")?;
        let raw = self.persistent.db.get_cf(&cf, node_id.as_bytes()).ok()??;
        let j: serde_json::Value = serde_json::from_slice(&raw).ok()?;
        let pk = j["ping_pubkey"].as_str().unwrap_or("").to_string();
        if pk.is_empty() { return None; }
        Some((pk, j["ping_delegation_cert"].as_str().unwrap_or("").to_string()))
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
    /// Bounded, resumable sweep over a column family: examine at most `SWEEP_SCAN_CAP` rows
    /// starting from a persisted cursor, delete the ones `is_stale` rejects, and store where to
    /// resume. An unbounded pass over a CF that grows with the network is a multi-second stall on
    /// whatever thread called it, and it accumulates one WriteBatch for the whole result.
    fn bounded_sweep<F>(&self, cf_name: &str, cursor_key: &[u8], is_stale: F) -> IntegrationResult<u32>
    where
        F: Fn(&[u8], &[u8]) -> bool,
    {
        /// Rows examined per call. The hourly cadence catches up on the rest.
        const SWEEP_SCAN_CAP: usize = 100_000;

        let cf = self.persistent.db.cf_handle(cf_name)
            .ok_or_else(|| IntegrationError::StorageError(format!("{} column family not found", cf_name)))?;
        let meta_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let cursor = self.persistent.db.get_cf(&meta_cf, cursor_key).ok().flatten().unwrap_or_default();
        let mode = if cursor.is_empty() {
            rocksdb::IteratorMode::Start
        } else {
            rocksdb::IteratorMode::From(&cursor, rocksdb::Direction::Forward)
        };

        let mut batch = WriteBatch::default();
        let mut removed = 0u32;
        let mut examined = 0usize;
        let mut last_key: Option<Vec<u8>> = None;

        for item in self.persistent.db.iterator_cf(&cf, mode) {
            let (key, value) = item?;
            examined += 1;
            last_key = Some(key.to_vec());
            if is_stale(&key, &value) {
                batch.delete_cf(&cf, &key);
                removed += 1;
                if removed % 5000 == 0 {
                    self.persistent.db.write(batch)?;
                    batch = WriteBatch::default();
                }
            }
            if examined >= SWEEP_SCAN_CAP {
                break;
            }
        }

        // Cap reached -> resume here next call; scan finished -> wrap to the start.
        let next: Vec<u8> = if examined >= SWEEP_SCAN_CAP { last_key.unwrap_or_default() } else { Vec::new() };
        batch.put_cf(&meta_cf, cursor_key, &next);
        self.persistent.db.write(batch)?;
        Ok(removed)
    }

    pub fn cleanup_old_attestations(&self, cutoff_timestamp: u64) -> IntegrationResult<u32> {
        self.bounded_sweep("attestations", b"sweep_attestations_cursor", |_k, v| {
            serde_json::from_slice::<serde_json::Value>(v)
                .ok()
                .and_then(|p| p["timestamp"].as_u64())
                .map_or(false, |ts| ts < cutoff_timestamp)
        })
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // v3.41: EPHEMERAL DATA CLEANUP - all CFs older than 24h
    // WAL files can only be deleted when ALL CFs flush. Rarely-written CFs
    // (ping_history, consensus, failover_events) keep stale memtables
    // preventing WAL cleanup. These methods + compact_all() reclaim disk space.
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// v3.41: Cleanup old ping_history entries (older than cutoff_timestamp)
    pub fn cleanup_old_pings_all(&self, cutoff_timestamp: u64) -> IntegrationResult<u32> {
        self.bounded_sweep("ping_history", b"sweep_ping_cursor", |_k, v| {
            serde_json::from_slice::<serde_json::Value>(v)
                .ok()
                .and_then(|p| p["timestamp"].as_u64())
                .map_or(false, |ts| ts > 0 && ts < cutoff_timestamp)
        })
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
                // Keep the genesis early anchor (h=90) as a universal cold-join floor: it is always
                // committee-verifiable (genesis committee), so a capsule-less joiner can always fast-sync to it.
                if *h == crate::node::SNAPSHOT_EARLY_ANCHOR_HEIGHT { continue; }
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
    /// Cleans: ping_history, consensus, failover_events, old snapshots
    /// Then triggers compaction on ALL CFs to physically reclaim disk space
    pub fn run_ephemeral_cleanup(&self, current_height: u64, cutoff_timestamp: u64) -> IntegrationResult<()> {
        let start = std::time::Instant::now();
        
        // 1. Ping history + attestations (>24h). Both live here so the compaction decision
        //    below sees every deletion this pass made.
        let pings_removed = self.cleanup_old_pings_all(cutoff_timestamp).unwrap_or(0);
        let att_removed = match self.cleanup_old_attestations(cutoff_timestamp) {
            Ok(n) => n,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][CLEANUP] attestations_cleanup_failed err={}", e);
                }
                0
            }
        };
        
        
        // 3. Consensus rounds — keep last 1000 rounds
        let current_round = current_height / 90; // macroblock every 90 blocks
        let consensus_removed = self.cleanup_old_consensus(current_round, 1000).unwrap_or(0);
        
        // 4. Failover events (>24h)
        let failover_removed = self.cleanup_old_failover_events(cutoff_timestamp).unwrap_or(0);
        
        // 5. Old snapshots — keep latest SNAPSHOT_KEEP_COUNT (bound by the sync-safety const-assert
        //    in node.rs: keep_count × snapshot interval must stay inside the body-retention window).
        let snapshots_removed = self.cleanup_old_snapshots(crate::node::SNAPSHOT_KEEP_COUNT).unwrap_or(0);

        // 6. v9.0: Prune old tx_index + tx_by_address (runs on ALL node types including Super).
        // Retention: 100,000 blocks (~28h at 1 block/sec). Explorer API queries use tx_by_address;
        // keeping ~1 day is sufficient for most wallet UIs. Historical queries → archive node.
        let tx_pruned = if current_height > TX_INDEX_RETENTION_BLOCKS {
            let prune_before = current_height - TX_INDEX_RETENTION_BLOCKS;
            self.prune_old_transactions(prune_before).unwrap_or(0)
        } else {
            0
        };

        let total_removed = pings_removed as u64 + att_removed as u64 + consensus_removed as u64
            + failover_removed as u64 + snapshots_removed as u64 + tx_pruned;

        // 7. Compact ONLY the CFs that were deleted from, and only once enough rows
        //    went to justify it. Compacting every CF rewrote microblocks + merkle_nodes
        //    (which hold no tombstones) hourly, and `cleanup_old_snapshots` always
        //    removes at least one row so the old `total_removed > 0` guard never closed.
        const COMPACT_MIN_ROWS: u64 = 1_000;
        let mut dirty_cfs: Vec<&str> = Vec::new();
        if att_removed as u64 >= COMPACT_MIN_ROWS { dirty_cfs.push("attestations"); }
        if pings_removed as u64 >= COMPACT_MIN_ROWS { dirty_cfs.push("ping_history"); }
        if consensus_removed as u64 >= COMPACT_MIN_ROWS { dirty_cfs.push("consensus"); }
        if failover_removed as u64 >= COMPACT_MIN_ROWS { dirty_cfs.push("failover_events"); }
        if tx_pruned >= COMPACT_MIN_ROWS {
            dirty_cfs.extend_from_slice(&["transactions", "tx_index", "tx_by_address"]);
        }
        if !dirty_cfs.is_empty() {
            if let Err(e) = self.persistent.compact_cfs(&dirty_cfs) {
                println!("[WARN][CLEANUP] compaction_failed err={}", e);
            }
        }

        let elapsed = start.elapsed();
        if total_removed > 0 {
            println!("[INFO][CLEANUP] ephemeral_cleanup_done elapsed={:?} pings={} attestations={} consensus={} failover={} snapshots={} tx_idx={} total={}",
                     elapsed, pings_removed, att_removed, consensus_removed, failover_removed, snapshots_removed, tx_pruned, total_removed);
        }
        
        Ok(())
    }
    
    // ===== FAILOVER EVENT METHODS =====
    
    /// Save a failover event (optimized with bincode serialization and LZ4 compression)
    /// NOTE: Light nodes should NOT call this method - they don't store failover history
    pub fn save_failover_event(&self, event: &FailoverEvent) -> IntegrationResult<()> {
        // Gate on the authoritative configured role, not an env string a
        // caller could flip: a safety record must not be env-bypassable.
        // Light nodes are pure API clients with no chain storage.
        if self.storage_mode != StorageMode::Super {
            return Ok(());
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

        // Bounded retention: ~30 days (≈100 failovers/day worst case).
        self.cleanup_old_failovers(10_000)?;

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
    
    /// Create state snapshot at the given height (snapshot system for fast
    /// node sync; runs at every INCREMENTAL_INTERVAL boundary).
    ///
    /// Always writes a FULL snapshot. The old incremental path wrote an
    /// empty `delta_{height}` placeholder no consumer read, so the
    /// `snapshot_root` consensus binding only activated on the 12h FULL
    /// boundary — 11/12 hourly boundaries fell through to legacy_accept and
    /// the L4 defence stayed dormant. Now one canonical full_snap_{height}
    /// per boundary feeds the receiver, snapshot_root, and the rollback
    /// reconciler alike. Runs on the blocking pool (seconds at 1M+
    /// accounts); a real delta path is future work.
    // (sync, at a macroblock boundary) Flush the hot account set + pin a frozen
    // DB view at this height. The caller invokes this synchronously in the apply
    // path (before H+1 mutates the CF), then hands the view to the async
    // create_*_snapshot serializer. Proxy to PersistentStorage.
    pub fn prepare_snapshot_view(
        &self,
        hot_accounts: &[(String, qnet_state::Account)],
    ) -> IntegrationResult<PinnedDbSnapshot> {
        self.persistent.prepare_snapshot_view(hot_accounts)
    }

    /// O(1) RocksDB estimate of total persisted accounts — the TOTAL on-disk
    /// account count (every hot ∪ cold row in the "accounts" CF), NOT the bounded
    /// LRU cache size. Best-effort: unwraps to 0 on missing CF / None / Err so it
    /// never panics. node.rs uses it for the merkle-store auto-heuristic.
    pub fn estimate_account_count(&self) -> u64 {
        self.persistent.db.cf_handle("accounts")
            .and_then(|cf| self.persistent.db
                .property_int_value_cf(&cf, "rocksdb.estimate-num-keys")
                .ok()
                .flatten())
            .unwrap_or(0)
    }

    pub fn record_checkpoint_vote(&self, index: u64, window_head: u64, content_digest: &[u8; 32],
                                  pinned: bool, parent_index: u64, parent_hash: &[u8; 32])
        -> IntegrationResult<()> {
        self.persistent.record_checkpoint_vote(index, window_head, content_digest, pinned,
                                               parent_index, parent_hash)
    }
    pub fn load_checkpoint_votes(&self)
        -> IntegrationResult<Vec<(u64, u64, [u8; 32], bool, u64, [u8; 32])>> {
        self.persistent.load_checkpoint_votes()
    }
    pub fn put_galc_held(&self, bytes: &[u8]) -> IntegrationResult<()> { self.persistent.put_galc_held(bytes) }
    pub fn get_galc_held(&self) -> IntegrationResult<Option<Vec<u8>>> { self.persistent.get_galc_held() }
    /// The macroblock index this node cold-joined at, or 0 for a from-genesis node.
    ///
    /// This is the ONE honest test for "the data is missing because *I* joined late" versus "the data is
    /// missing on every node". Absence below the anchor is local blindness and the node must abstain;
    /// absence at or above it is a fact the whole network shares, and abstaining on a shared fact is how
    /// a recoverable state becomes a permanent halt — nobody signals, ever.
    pub fn snapshot_join_anchor_mb(&self) -> u64 {
        self.persistent.get_snapshot_anchor().ok().flatten()
            .filter(|v| v.len() >= 8)
            .map(|v| { let mut b = [0u8; 8]; b.copy_from_slice(&v[..8]); u64::from_le_bytes(b) })
            .unwrap_or(0)
    }

    pub fn put_snapshot_anchor(&self, bytes: &[u8]) -> IntegrationResult<()> { self.persistent.put_snapshot_anchor(bytes) }
    pub fn get_snapshot_anchor(&self) -> IntegrationResult<Option<Vec<u8>>> { self.persistent.get_snapshot_anchor() }

    pub async fn create_incremental_snapshot(
        &self,
        height: u64,
        view: PinnedDbSnapshot,
    ) -> IntegrationResult<()> {
        // v32.6: caller (node.rs) controls trigger heights — early anchor
        // at h=90 + baseline every 3600. This function only enforces
        // height>0; it always writes a full state snapshot when called.
        if height == 0 {
            return Ok(());
        }
        self.create_state_snapshot(height, view).await
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
    pub async fn create_state_snapshot(
        &self,
        height: u64,
        view: PinnedDbSnapshot,
    ) -> IntegrationResult<()> {
        // Caller (create_incremental_snapshot) already enforces trigger heights.
        if height == 0 {
            return Ok(()); // No snapshot at genesis
        }

        println!("[INFO][STORAGE] state_snapshot_start height={}", height);
        let start_time = std::time::Instant::now();

        // Canonical timestamp from the boundary microblock (not wall-clock) ⇒
        // byte-equal snapshots across honest nodes. Single point read, off-closure.
        let timestamp: u64 = match self.load_microblock_auto_format(height) {
            Ok(Some(boundary_block)) => boundary_block.timestamp,
            _ => 0,
        };

        // All CF reads go through the pinned snapshot (view.snap): a frozen
        // point-in-time view captured synchronously at this height, so the dump
        // reproduces exactly state_root@H even while H+1.. mutate the live DB.
        let (account_count, rewards_count, contract_entries, registry_count, compressed_kb, uncompressed_kb) =
            tokio::task::spawn_blocking(move || -> IntegrationResult<(u64, u64, u64, u64, usize, usize)> {
                use std::io::Write;
                let db = &view.db;
                let snap = &view.snap;
                let snapshots_cf = db.cf_handle("snapshots")
                    .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

                // Stream the logical payload straight into a zstd encoder so the full
                // uncompressed blob (multi-GB at 10M accounts) is NEVER materialized.
                // `uncompressed_len` tracks the running byte count fed to the encoder,
                // reproducing the exact wire header without holding the blob. Content and
                // order are byte-identical to the prior in-RAM [0x02 | body] layout, so
                // every node still streams the same bytes ⇒ the frame stays deterministic.
                let mut encoder = zstd::Encoder::new(Vec::new(), 3)
                    .map_err(|e| IntegrationError::Other(format!("Full snapshot encoder init error: {}", e)))?;
                let mut uncompressed_len: u64 = 0;
                // Feed a chunk into the encoder while accumulating its length into
                // `uncompressed_len` (checked-add: a >u64 payload is unrepresentable,
                // never a silent wrap on the consensus-critical header).
                macro_rules! feed {
                    ($enc:expr, $len:expr, $chunk:expr) => {{
                        let c = $chunk;
                        $enc.write_all(c)
                            .map_err(|e| IntegrationError::Other(format!("Full snapshot write error: {}", e)))?;
                        $len = $len.checked_add(c.len() as u64)
                            .ok_or_else(|| IntegrationError::Other("snapshot length overflow".to_string()))?;
                    }};
                }

                // Type discriminator first (0x02 = SNAP_TYPE_FULL), then the header fields.
                feed!(encoder, uncompressed_len, &[0x02u8]); // SNAP_TYPE_FULL
                feed!(encoder, uncompressed_len, &crate::node::PROTOCOL_VERSION.to_le_bytes());
                feed!(encoder, uncompressed_len, &height.to_le_bytes());
                feed!(encoder, uncompressed_len, &timestamp.to_le_bytes());

                // 4. Account state — the COMPLETE committed tree leaf set. The pinned view's accounts
                //    CF holds every hot account (flushed at prepare) ∪ every cold account (persist-
                //    before-evict), so recompute reproduces the QC-bound state_root even past the LRU
                //    cap. Key-ordered iteration ⇒ byte-identical snapshots across nodes.
                let accounts_cf = db.cf_handle("accounts")
                    .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
                let mut account_count = 0u64;
                for item in snap.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start) {
                    let (key, value) = item?;
                    feed!(encoder, uncompressed_len, &(key.len() as u32).to_le_bytes());
                    feed!(encoder, uncompressed_len, &key);
                    feed!(encoder, uncompressed_len, &(value.len() as u32).to_le_bytes());
                    feed!(encoder, uncompressed_len, &value);
                    account_count += 1;
                }

                // 5. v2.75: Include pending_rewards for fast sync (lazy rewards survive restart)
                let mut rewards_count = 0u64;
                if let Some(rewards_cf) = db.cf_handle("pending_rewards") {
                    // Write marker for rewards section
                    feed!(encoder, uncompressed_len, b"REWARDS_V1");

                    let rewards_iter = snap.iterator_cf(&rewards_cf, rocksdb::IteratorMode::Start);
                    for item in rewards_iter {
                        let (key, value) = item?;
                        // Skip the derived light_elig_ recency index (whole-network × 4 epochs = up to ~40M
                        // keys at 10M light nodes): promote_snapshot_staging clears pending_rewards anyway and
                        // the joiner re-derives light_elig_ at boot, so shipping it only bloats the snapshot.
                        if key.starts_with(b"light_elig_") { continue; }
                        feed!(encoder, uncompressed_len, &(key.len() as u32).to_le_bytes());
                        feed!(encoder, uncompressed_len, &key);
                        feed!(encoder, uncompressed_len, &(value.len() as u32).to_le_bytes());
                        feed!(encoder, uncompressed_len, &value);
                        rewards_count += 1;
                    }

                    // Write end marker
                    feed!(encoder, uncompressed_len, b"REWARDS_END");
                }

                // 6. v5.0: Include contract_storage for full state recovery
                let mut contract_entries = 0u64;
                if let Some(cs_cf) = db.cf_handle("contract_storage") {
                    feed!(encoder, uncompressed_len, b"CONTRACT_STORAGE_V1");
                    let cs_iter = snap.iterator_cf(&cs_cf, rocksdb::IteratorMode::Start);
                    for item in cs_iter {
                        let (key, value) = item?;
                        feed!(encoder, uncompressed_len, &(key.len() as u32).to_le_bytes());
                        feed!(encoder, uncompressed_len, &key);
                        feed!(encoder, uncompressed_len, &(value.len() as u32).to_le_bytes());
                        feed!(encoder, uncompressed_len, &value);
                        contract_entries += 1;
                    }
                    feed!(encoder, uncompressed_len, b"CONTRACT_STORAGE_END");
                }

                // 7. v5.0: Include node_registry for producer wallet lookups after snapshot restore
                let mut registry_count = 0u64;
                if let Some(nr_cf) = db.cf_handle("node_registry") {
                    feed!(encoder, uncompressed_len, b"NODE_REGISTRY_V1");
                    let nr_iter = snap.iterator_cf(&nr_cf, rocksdb::IteratorMode::Start);
                    for item in nr_iter {
                        let (key, value) = item?;
                        // Exclude the display-only rich-list index (rlst_/rlpos_/rlcnt/meta_richlist_
                        // index_v1): it is NOT covered by registry_root/state_root, so serving it in the
                        // consensus-bootstrap artifact would (a) let a byzantine server inject a forged
                        // rich list and (b) diverge snapshot BYTES between honest nodes on a swallowed
                        // reconcile error. The joiner rebuilds it locally from accounts after promote.
                        if key.starts_with(b"rlst_") || key.starts_with(b"rlpos_")
                            || key.starts_with(b"rlcnt") || key.starts_with(b"meta_richlist_index_v1")
                        { continue; }
                        feed!(encoder, uncompressed_len, &(key.len() as u32).to_le_bytes());
                        feed!(encoder, uncompressed_len, &key);
                        feed!(encoder, uncompressed_len, &(value.len() as u32).to_le_bytes());
                        feed!(encoder, uncompressed_len, &value);
                        registry_count += 1;
                    }
                    feed!(encoder, uncompressed_len, b"NODE_REGISTRY_END");
                }

                // finish() flushes the final zstd frame and returns the wrapped Vec — a
                // complete single stream, decoded identically by the untouched loader.
                let compressed = encoder.finish()
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
    
    /// Apply-bound state_root + QC-certified total_supply at macroblock `mb_idx`, read from the
    /// macroblock's embedded (Checkpoint, QC). total_supply is in Checkpoint::hash ⇒ 2f+1-certified — the
    /// SAME source cold-join rehydrate uses, never a drifting live read. A pre-emission anchor (epoch<2)
    /// may carry no checkpoint_qc ⇒ total_supply falls back to the balance sum (exact while minted==sum).
    /// None ⇒ macroblock absent / corrupt QC (caller fails closed to full replay — never a wrong supply).
    pub fn anchor_root_and_supply(&self, mb_idx: u64, accounts: &[(String, qnet_state::Account)]) -> Option<([u8; 32], u64)> {
        let bytes = self.get_macroblock_by_height(mb_idx).ok()??;
        let mb: qnet_state::MacroBlock = bincode::deserialize(&bytes).ok()?;
        let ts = match &mb.consensus_data.checkpoint_qc {
            // Present-but-corrupt QC ⇒ fail closed to full replay (NEVER fall through to the balance sum,
            // which is wrong post-emission); log distinctly since a locally-sealed QC should never corrupt.
            Some(b) => match bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint, qnet_consensus::checkpoint_bft::QuorumCertificate)>(b) {
                Ok((cp, _)) => cp.total_supply,
                Err(e) => {
                    if crate::node::is_warn() { println!("[WARN][SNAPSHOT] anchor_qc_corrupt mb={} err={} action=full_replay", mb_idx, e); }
                    return None;
                }
            },
            None => accounts.iter().map(|(_, a)| a.balance).fold(0u64, |acc, b| acc.saturating_add(b)),
        };
        Some((mb.state_root, ts))
    }

    pub async fn load_latest_state_snapshot(&self) -> IntegrationResult<Option<(u64, [u8; 32], Vec<u8>, u64)>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        // Local restart restores from the apply-bound full_snap_ (the SAME complete snapshot P2P serves),
        // NOT the retired live-captured state_snap_ (whose content drifted past its label height). accounts
        // come from the snapshot; state_root + total_supply come from the anchor macroblock's QC-bound
        // checkpoint (the cold-join source), never a drifting live read.
        let latest_height = match self.persistent.db.get_cf(&snapshots_cf, b"latest_full_snap")? {
            Some(data) if data.len() >= 8 => u64::from_le_bytes(data[..8].try_into()
                .map_err(|_| IntegrationError::StorageError("Invalid latest_full_snap pointer".to_string()))?),
            _ => {
                let mut max_h = 0u64;
                for item in self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::Start) {
                    if let Ok((key, _)) = item {
                        if let Some(h_str) = String::from_utf8_lossy(&key).strip_prefix("full_snap_") {
                            if let Ok(h) = h_str.parse::<u64>() { if h > max_h { max_h = h; } }
                        }
                    }
                }
                if max_h == 0 { return Ok(None); }
                max_h
            }
        };

        let key = format!("full_snap_{}", latest_height);
        let value = match self.persistent.db.get_cf(&snapshots_cf, key.as_bytes())? {
            Some(v) => v,
            None => {
                eprintln!("[WARN][SNAPSHOT] latest_full_snap pointer h={} key missing", latest_height);
                return Ok(None);
            }
        };

        // decode_snapshot_accounts verifies integrity + decompresses + parses the full_snap_ payload
        // (Format A: accounts then the rewards/contracts/registry sections). Re-serialize as the bincode
        // Vec the TIER-1 consumer expects, so the restore path below is unchanged.
        let accounts = self.decode_snapshot_accounts(&value)?;
        let accounts_data = bincode::serialize(&accounts)
            .map_err(|e| IntegrationError::SerializationError(format!("reserialize_full_snap_accounts: {}", e)))?;

        // full_snap_ heights are macroblock boundaries (h=90 + multiples of SNAPSHOT_INCREMENTAL_INTERVAL),
        // so the anchor macroblock at latest_height/90 carries the apply-bound state_root + QC total_supply.
        let mb_idx = latest_height / 90;
        let (state_root, total_supply) = match self.anchor_root_and_supply(mb_idx, &accounts) {
            Some(rs) => rs,
            None => {
                eprintln!("[WARN][SNAPSHOT] full_snap_ h={} anchor mb={} unavailable — full replay", latest_height, mb_idx);
                return Ok(None);
            }
        };

        if crate::node::is_info() {
            println!("[INFO][SNAPSHOT] full_snap_loaded h={} total_supply={} accounts={}",
                     latest_height, total_supply, accounts.len());
        }

        Ok(Some((latest_height, state_root, accounts_data, total_supply)))
    }
    
    /// v2.99: Load state snapshot by height and restore into StateManager
    /// Load a state snapshot by height and return (state_root, accounts_bincode) for StateManager restoration.
    /// Payload: [type=0x01 | state_root(32) | accounts_bincode]
    // Persistent mempool API: pending TXs are mirrored to the `mempool` CF
    // on admission and removed on inclusion / TTL / drop, so a producer that
    // dies between accepting and including a TX doesn't silently drop it —
    // the next process reloads the queue under the same gas-price ordering.
    // Per entry, keyed by tx hash: [admission_ts u64 LE | tx_payload] (ts
    // rebuilds TTL/by_gas_price on reload with no extra round-trip). One
    // put_cf per TX; boot scan runs in spawn_blocking to free the reactor.

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
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        if target_height == 0 {
            return Ok(None);
        }

        // v32.15: scan actual stored snapshot keys for the freshest height ≤ target.
        // Prior fixed-3600-stride probing missed snapshots stored at macroblock
        // boundaries (multiples of 90, not 3600) and any non-stride heights left
        // after pruning → forced the fragile full-replay-from-0 recovery path.
        // Retained-snapshot count is bounded by the pruning policy, so this full
        // scan is O(retained) — tens of entries even at production scale.
        use rocksdb::IteratorMode;
        let mut best_height: Option<u64> = None;
        let iter = self.persistent.db.iterator_cf(&snapshots_cf, IteratorMode::Start);
        for item in iter {
            let (key, value) = match item {
                Ok(kv) => kv,
                Err(_) => continue,
            };
            if value.is_empty() {
                continue;
            }
            let key_str = match std::str::from_utf8(&key) {
                Ok(s) => s,
                Err(_) => continue,
            };
            // full_snap_ only — state_snap_ retired; scan + fetch (below) must agree on the same prefix.
            if let Some(hs) = key_str.strip_prefix("full_snap_") {
                if let Ok(h) = hs.parse::<u64>() {
                    if h <= target_height && best_height.map_or(true, |b| h > b) {
                        best_height = Some(h);
                    }
                }
            }
        }

        match best_height {
            Some(h) => {
                // full_snap_ is the single snapshot artifact (state_snap_ retired); reconcile reads its
                // accounts + takes total_supply from the anchor macroblock's QC checkpoint.
                let key = format!("full_snap_{}", h);
                match self.persistent.db.get_cf(&snapshots_cf, key.as_bytes())? {
                    Some(data) if !data.is_empty() => Ok(Some((h, data))),
                    _ => Ok(None),
                }
            }
            None => Ok(None),
        }
    }

    /// Decode a snapshot blob into its account list for in-memory state rebuild during
    /// fork-recovery. Reads BOTH the canonical full_snap_ (Format A: raw accounts-CF dump)
    /// and the legacy state_snap_ (Format B: bincode Vec). Accounts only — other CF sections
    /// ignored. Pure (no DB). Inverse of create_state_snapshot/save_state_snapshot writers.
    pub fn decode_snapshot_accounts(&self, snap_data: &[u8]) -> IntegrationResult<Vec<(String, qnet_state::Account)>> {
        if snap_data.len() < 41 {
            return Err(IntegrationError::StorageError(format!("snapshot too short: {} bytes", snap_data.len())));
        }
        let stored_hash = &snap_data[..32];
        let compressed = &snap_data[40..];
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(compressed);
        if stored_hash != hasher.finalize().as_slice() {
            return Err(IntegrationError::StorageError("snapshot integrity check failed".to_string()));
        }
        let buf = zstd::decode_all(compressed)
            .map_err(|e| IntegrationError::StorageError(format!("snapshot decompress failed: {}", e)))?;
        if buf.first().copied() != Some(0x02) || buf.len() < 5 {
            return Err(IntegrationError::StorageError("snapshot wrong/short type".to_string()));
        }
        // probe u32 after type byte: >=10_000 ⇒ Format B (state_root bytes); else Format A version
        let probe = u32::from_le_bytes(buf[1..5].try_into().unwrap());
        let mut out: Vec<(String, qnet_state::Account)> = Vec::new();
        if probe >= 10_000 {
            // Format B: [0x02 | state_root(32) | total_supply(8) | height(8) | bincode(Vec<(addr,Account)>)]
            let body = 1 + 32 + 8 + 8;
            if buf.len() < body { return Err(IntegrationError::StorageError("format_b truncated".to_string())); }
            out = bincode::deserialize(&buf[body..])
                .map_err(|e| IntegrationError::SerializationError(format!("format_b decode: {}", e)))?;
        } else {
            // Format A: [0x02 | version(4) | height(8) | ts(8) | (klen|k|vlen|v)* | REWARDS_V1 ...]
            let mut cursor = 1 + 4 + 8 + 8;
            while cursor < buf.len() {
                if cursor + 10 <= buf.len() && &buf[cursor..cursor + 10] == b"REWARDS_V1" { break; }
                if cursor + 4 > buf.len() { break; }
                let klen = u32::from_le_bytes(buf[cursor..cursor + 4].try_into().unwrap()) as usize;
                cursor += 4;
                if cursor + klen > buf.len() { break; }
                let key = &buf[cursor..cursor + klen]; cursor += klen;
                if cursor + 4 > buf.len() { break; }
                let vlen = u32::from_le_bytes(buf[cursor..cursor + 4].try_into().unwrap()) as usize;
                cursor += 4;
                if cursor + vlen > buf.len() { break; }
                let val = &buf[cursor..cursor + vlen]; cursor += vlen;
                let addr = String::from_utf8(key.to_vec())
                    .map_err(|e| IntegrationError::StorageError(format!("addr utf8: {}", e)))?;
                let account = bincode::deserialize::<qnet_state::Account>(val)
                    .map_err(|e| IntegrationError::SerializationError(format!("account decode: {}", e)))?;
                out.push((addr, account));
            }
        }
        Ok(out)
    }


    /// Load a full snapshot by height and restore accounts + rewards directly into RocksDB.
    /// v10.1: Supports TWO binary formats:
    ///   Format A (create_state_snapshot): [0x02 | protocol_version:u32 | height:u64 | timestamp:u64 | KV pairs...]
    ///   Format B (save_state_snapshot):   [0x02 | state_root:[u8;32] | total_supply:u64 | height:u64 | bincode(accounts)]
    /// Detection: after 0x02, read 4 bytes as u32. protocol_version < 10_000 → Format A. Otherwise → Format B.
    /// stage=true restores into the *_stage CFs (verify-then-promote cold-join: live state stays
    /// untouched until the binding passes); stage=false restores directly into live CFs.
    pub async fn load_state_snapshot(&self, height: u64, stage: bool) -> IntegrationResult<()> {
        if crate::node::is_info() {
            println!("[INFO][SNAPSHOT] full_snap_loading h={} stage={}", height, stage);
        }
        let accounts_cf_name = if stage { "accounts_stage" } else { "accounts" };
        let rewards_cf_name = if stage { "pending_rewards_stage" } else { "pending_rewards" };
        let contract_cf_name = if stage { "contract_storage_stage" } else { "contract_storage" };
        let registry_cf_name = if stage { "node_registry_stage" } else { "node_registry" };

        // Clear the staging CFs BEFORE a fresh staged load. A crash in a prior attempt's narrow
        // promote window (marker deleted but stage-clear not yet finished) can leave stale rows;
        // loading a new snapshot on top would then let those poison this snapshot's Pattern-C
        // merkle recompute → a fail-closed reject of an otherwise-honest snapshot (a liveness
        // hole, forcing a needless full replay). The *_stage CFs are throwaway verify-space, so
        // truncating them here is always safe and makes each staged load self-contained.
        if stage {
            for cf in &[accounts_cf_name, rewards_cf_name, contract_cf_name, registry_cf_name] {
                let _ = self.clear_cf(cf);
            }
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
            // FORMAT B (legacy P2P state_snap_ download): [0x02 | state_root(32) | total_supply(8) |
            //   height(8) | bincode(accounts)] — carries ONLY the accounts CF.
            // ═══════════════════════════════════════════════════════════════════
            // This snapshot-restore path is Super consensus machinery. Light nodes are pure mobile API
            // clients — they store NO chain data and never cold-join, so they never reach here. A
            // Format-B blob lacks node_registry (vrf_pk / srtr_ / lrtr_ / cbw), so it is incomplete for
            // the consensus roster a Super must derive: reject closed and let the caller re-target a
            // complete (Format A) source or fall back to verified block-sync.
            return Err(IntegrationError::StorageError(format!(
                "format_B_incomplete_for_consensus h={} reason=no_node_registry", height
            )));
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
        let accounts_cf = self.persistent.db.cf_handle(accounts_cf_name)
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
            
            if let Some(rewards_cf) = self.persistent.db.cf_handle(rewards_cf_name) {
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
            if let Some(cs_cf) = self.persistent.db.cf_handle(contract_cf_name) {
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
            if let Some(nr_cf) = self.persistent.db.cf_handle(registry_cf_name) {
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
                // Derived indices (roster srtr_/lrtr_, cbw burn→wallet, registry_lthash) live in
                // metadata, NOT in the snapshot blob. Rebuild them deterministically from the restored
                // node_registry, bounded by the snapshot height. In stage mode this runs at promote
                // (against live), never on the staging copy.
                if !stage {
                    let _ = self.backfill_roster_indices();
                    match self.rebuild_committed_burn_wallet(height) {
                        Ok(n) if crate::node::is_info() => println!("[INFO][SNAPSHOT] cbw_rebuilt bindings={}", n),
                        Err(e) => println!("[WARN][SNAPSHOT] cbw_rebuild_failed err={}", e),
                        _ => {}
                    }
                    if let Err(e) = self.rebuild_registry_lthash(height) {
                        println!("[WARN][SNAPSHOT] registry_lthash_rebuild_failed err={}", e);
                    }
                    // FIX-5: derive dilithium_pk_root LtHash from the restored accounts (metadata CF is
                    // not snapshot-carried) so elided-pk verify + the next checkpoint match the network.
                    if let Err(e) = self.rebuild_dilithium_pk_lthash() {
                        println!("[WARN][SNAPSHOT] dilithium_pk_lthash_rebuild_failed err={}", e);
                    }
                    // Never inherit peer-supplied rich-list rows (display-only, snapshot-unverified) —
                    // the boot rebuild re-derives from the restored accounts.
                    let _ = self.richlist_clear();
                }
            }
        }

        if crate::node::is_info() {
            println!("[INFO][SNAPSHOT] full_snap_restored h={} accounts={} rewards={} contracts={} registry={}",
                     height, account_count, rewards_count, contract_count, registry_count);
        }

        // v32.10: trust Pattern C. SHA3 byte integrity + Zstd parse + format
        // probe already reject malformed bytes upstream. Cryptographic
        // snapshot_root verification (verify_snapshot_consensus_binding)
        // matches macroblock 2f+1 commitment — that is the security gate,
        // not entry counts. Empty-state anchors (h=90 fresh net: registry>0,
        // accounts=0) are legitimate.
        if account_count == 0 && crate::node::is_info() {
            println!(
                "[INFO][SNAPSHOT] empty_state_anchor h={} registry={} mode=pre_first_transfer",
                height, registry_count,
            );
        }

        // Live restore advances chain_height to the snapshot height so catch-up fetches only
        // blocks AFTER it. Stage mode leaves chain_height untouched — it is advanced by promote
        // once the binding passes.
        if !stage {
            self.set_chain_height(height)?;
            println!("[INFO][SNAPSHOT] format_A_chain_height_set h={}", height);
        }

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
            
            // IPFS upload feeds P2P cold-join ⇒ full_snap_ ONLY (complete); never the incomplete state_snap_.
            let full_key = format!("full_snap_{}", height);
            self.persistent.db.get_cf(&snapshots_cf, full_key.as_bytes())?
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
    
    // NOTE: a former `announce_snapshot_to_peers` broadcast a StateSnapshot IPFS-CID hint to
    // every peer, but the receiver only logged it (never fetched) — dead traffic. State sync
    // is fully handled by GALC + the QC-anchored snapshot/full-sync path, so the announcement
    // was removed.

    /// EIP-4444-style body expiry for the archival (Super) tier. Microblock BODIES
    /// (the bulk: heartbeats + TXs) older than `retention_blocks` are dropped, while
    /// the hash index (metadata), macroblocks, snapshots and account state are kept —
    /// so chain-continuity (previous_hash) stays an O(1) hash-index lookup and reward
    /// eligibility (read from state + macroblock summaries) is unaffected. Block 0
    /// (genesis) is never pruned. A watermark in `metadata` bounds each run to the
    /// newly-aged-out range (O(retention/run), not O(height)). Safe by construction:
    /// every body reader uses `if let Ok(Some(..))`, so a pruned body is skipped, and
    /// cold-start replays from a <=1h snapshot, never across the retention window.
    /// Returns the number of bodies pruned this run.
    /// Height below which per-block bodies AND blocklogs have been pruned on this node (0 if never
    /// pruned) — the `body_prune_watermark` written by prune_old_microblock_bodies. getLogs reads
    /// this to report `pruned_below`, so an empty result for an aged-out height is distinguishable
    /// from a block that genuinely emitted no events (both otherwise return count:0).
    pub fn log_prune_floor(&self) -> u64 {
        self.persistent.db.cf_handle("metadata")
            .and_then(|cf| self.persistent.db.get_cf(&cf, b"body_prune_watermark").ok().flatten())
            .filter(|v| v.len() == 8)
            .map(|v| { let mut b = [0u8; 8]; b.copy_from_slice(&v[..8]); u64::from_le_bytes(b) })
            .unwrap_or(0)
    }

    pub fn prune_old_microblock_bodies(&self, current_height: u64, retention_blocks: u64) -> IntegrationResult<u64> {
        // Super (incl. genesis) is the only tier that stores block data: Light nodes
        // are stateless mobile clients and Full nodes are removed. Off-tier or before
        // the first full retention window → nothing to prune.
        if self.storage_mode != StorageMode::Super || current_height <= retention_blocks {
            return Ok(0);
        }
        // Body-only prune: deletes ONLY microblock_{h} bodies, KEEPING macroblock objects +
        // microblock_hash_{h} (the cold-join lineage walk reads macroblock OBJECTS, never bodies), so it
        // can never cross anything that walk needs — no WS-floor clamp required. (An earlier clamp tied to
        // the FROZEN snapshot join-anchor wrongly froze pruning forever above the anchor → unbounded
        // growth on snapshot-joined nodes; removed.)
        let prune_before = current_height - retention_blocks;

        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        const WATERMARK_KEY: &[u8] = b"body_prune_watermark";
        let watermark = self.persistent.db.get_cf(&metadata_cf, WATERMARK_KEY)?
            .filter(|v| v.len() == 8)
            .map(|v| {
                let mut b = [0u8; 8];
                b.copy_from_slice(&v[..8]);
                u64::from_le_bytes(b)
            })
            .unwrap_or(0);

        // Never touch genesis (h=0); resume from the watermark.
        let from = watermark.max(1);
        if prune_before <= from {
            return Ok(0);
        }

        let mut batch = WriteBatch::default();
        for h in from..prune_before {
            // Body only — KEEP metadata/microblock_hash_{h} (continuity) + macroblocks.
            batch.delete_cf(&microblocks_cf, mb_body_key(h).as_bytes());
            // The ancestry rows describe a body that is going away and nothing will ever walk
            // ancestry through an expired range. Left in place they grow ~220 B/block forever
            // (~7 GB/year/node) on the very tier whose purpose is bounding disk. The height→hash
            // alias is deliberately kept: continuity checks still need it.
            if let Ok(Some(existing)) = self.persistent.load_microblock_hash(h) {
                if let Some(prev) = self.persistent.header_index(&existing).map(|hd| hd.previous_hash) {
                    batch.delete_cf(&metadata_cf, &block_child_key(&prev, &existing));
                }
                batch.delete_cf(&metadata_cf, &block_header_key(&existing));
            }
            // Co-prune the OFF-consensus WASM log receipts on the same window: getLogs serves only a
            // bounded recent range (<< retention_blocks), so aged-out blocklogs are unreachable and
            // safe to drop. Default CF (save_raw); zero-padded key ⇒ lexicographically contiguous.
            batch.delete(format!("blocklogs_{:010}", h).as_bytes());
            batch.delete(format!("blocklogsroot_{:010}", h).as_bytes()); // co-prune the per-block sub-root
        }
        batch.put_cf(&metadata_cf, WATERMARK_KEY, &prune_before.to_le_bytes());
        self.persistent.db.write(batch)?;
        // Physically reclaim the aged-out body range (tombstones otherwise persist until natural
        // compaction). Range-scoped ⇒ cost proportional to the pruned span, not the whole CF.
        self.persistent.db.compact_range_cf(
            &microblocks_cf,
            Some(mb_body_key(from).as_bytes()),
            Some(mb_body_key(prune_before).as_bytes()),
        );
        // Same reclaim for the co-pruned blocklogs range (default CF).
        self.persistent.db.compact_range(
            Some(format!("blocklogs_{:010}", from).as_bytes()),
            Some(format!("blocklogs_{:010}", prune_before).as_bytes()),
        );
        // Co-prune the token-transfer index below the same floor (bounded per run; drains a backlog
        // over cycles). Mirrors the tx_by_address retention so this index cannot grow unbounded.
        let pruned_xfers = self.prune_token_transfers_below(prune_before);
        if crate::node::is_info() {
            println!("[INFO][STORAGE] body_prune_compacted from={} to={} xfer_index_pruned={}", from, prune_before, pruned_xfers);
        }

        Ok(prune_before - from)
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
            let micro_key = mb_body_key(height);
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
            Some(mb_body_key(last_snapshot).as_bytes()),
            Some(mb_body_key(prune_before).as_bytes()));
        
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
    /// Bounded per-call prune of `transactions` / `tx_index` / `tx_by_address`.
    ///
    /// The two index families are pruned on INDEPENDENT criteria: `tx_index` by the block height
    /// it stores, `tx_by_address` by the timestamp embedded in its own key
    /// (`addr_{address}_{ts:016x}_{tx_hash}`). Deriving the address rows from the set of hashes
    /// collected in this call would orphan every matching row outside the window — the two column
    /// families sort on unrelated orders, and once the `tx_index` row is gone the hash can never
    /// be rediscovered.
    ///
    /// Both scans resume from a persisted cursor and stop at a row cap, so one call costs O(cap)
    /// regardless of index size. Returns the number of transactions pruned; the hourly cadence
    /// catches up.
    pub fn prune_old_transactions(&self, prune_before_height: u64) -> IntegrationResult<u64> {
        // A fixed row cap is a throughput bet: set it below the production rate and retention stops
        // holding, silently, exactly when the chain gets busy. Budget instead from the work that must
        // be done — one full sweep of each index inside the retention window — measured from RocksDB's
        // own key estimate, with a floor so a young chain still makes progress and a ceiling so one
        // call cannot stall the maintenance thread.
        let runs_in_window = (TX_INDEX_RETENTION_BLOCKS / 3_600).max(1) * PRUNE_RUNS_PER_HOUR;
        let tx_scan_cap = self.sweep_budget("tx_index", runs_in_window);
        let addr_scan_cap = self.sweep_budget("tx_by_address", runs_in_window);

        let tx_cf = self.persistent.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        let tx_index_cf = self.persistent.db.cf_handle("tx_index")
            .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
        let tx_by_addr_cf = self.persistent.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        let meta_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let read_cursor = |k: &[u8]| -> Vec<u8> {
            self.persistent.db.get_cf(&meta_cf, k).ok().flatten().unwrap_or_default()
        };

        let mut batch = WriteBatch::default();
        let mut pruned_count: u64 = 0;

        // ── transactions + tx_index, by stored block height ──
        let tx_cursor = read_cursor(b"prune_tx_index_cursor");
        let tx_mode = if tx_cursor.is_empty() {
            rocksdb::IteratorMode::Start
        } else {
            rocksdb::IteratorMode::From(&tx_cursor, rocksdb::Direction::Forward)
        };
        let mut examined = 0usize;
        let mut last_tx_key: Option<Vec<u8>> = None;
        for item in self.persistent.db.iterator_cf(&tx_index_cf, tx_mode) {
            let (key, value) = item?;
            examined += 1;
            last_tx_key = Some(key.to_vec());
            if value.len() >= 8 {
                let block_height = u64::from_be_bytes(value[..8].try_into().unwrap_or([0u8; 8]));
                if block_height < prune_before_height {
                    batch.delete_cf(&tx_cf, &key);
                    batch.delete_cf(&tx_index_cf, &key);
                    pruned_count += 1;
                    if pruned_count % 5000 == 0 {
                        self.persistent.db.write(batch)?;
                        batch = WriteBatch::default();
                    }
                }
            }
            if examined >= tx_scan_cap {
                break;
            }
        }
        // Cap reached → resume here next call; scan finished → wrap to the start.
        let next_tx_cursor: Vec<u8> = if examined >= tx_scan_cap {
            last_tx_key.unwrap_or_default()
        } else {
            Vec::new()
        };
        batch.put_cf(&meta_cf, b"prune_tx_index_cursor", &next_tx_cursor);

        // ── tx_by_address, by the inclusion HEIGHT in its own key ──
        // Scanned independently of tx_index (the two families sort on unrelated orders, so deriving
        // one from the other orphans rows), but cut on the SAME height rule. The key used to carry
        // `tx.timestamp`, which the sender picks: one row stamped in the future was unreachable by
        // any prune, forever.

        let addr_cursor = read_cursor(b"prune_addr_cursor");
        let addr_mode = if addr_cursor.is_empty() {
            rocksdb::IteratorMode::Start
        } else {
            rocksdb::IteratorMode::From(&addr_cursor, rocksdb::Direction::Forward)
        };
        let mut addr_examined = 0usize;
        let mut addr_pruned: u64 = 0;
        let mut addr_unparsed: u64 = 0;
        let mut last_addr_key: Option<Vec<u8>> = None;
        for item in self.persistent.db.iterator_cf(&tx_by_addr_cf, addr_mode) {
            let (key, _value) = item?;
            addr_examined += 1;
            last_addr_key = Some(key.to_vec());
            match Self::addr_index_height(&key) {
                Some(h) if h < prune_before_height => {
                    batch.delete_cf(&tx_by_addr_cf, &key);
                    addr_pruned += 1;
                    if addr_pruned % 5000 == 0 {
                        self.persistent.db.write(batch)?;
                        batch = WriteBatch::default();
                    }
                }
                Some(_) => {}
                // Not a key this writer produces. Never deleted on a guess (a parse miss is not
                // evidence of age), but counted so corruption is visible instead of silent.
                None => addr_unparsed += 1,
            }
            if addr_examined >= addr_scan_cap {
                break;
            }
        }
        let next_addr_cursor: Vec<u8> = if addr_examined >= addr_scan_cap {
            last_addr_key.unwrap_or_default()
        } else {
            Vec::new()
        };
        batch.put_cf(&meta_cf, b"prune_addr_cursor", &next_addr_cursor);

        if !batch.is_empty() {
            self.persistent.db.write(batch)?;
        }

        if addr_unparsed > 0 {
            println!("[WARN][PRUNE] addr_index_unparsed rows={} action=retained", addr_unparsed);
        }
        if (pruned_count > 0 || addr_pruned > 0) && crate::node::is_info() {
            println!("[INFO][PRUNE] tx_done txs={} addr_entries={} before_h={} tx_scanned={}/{} addr_scanned={}/{}",
                     pruned_count, addr_pruned, prune_before_height,
                     examined, tx_scan_cap, addr_examined, addr_scan_cap);
        }

        Ok(pruned_count)
    }

    /// Inclusion height embedded in a `tx_by_address` key: `addr_{address}_{height:016x}_{tx_hash}`.
    /// The address itself may contain `_`, so the field is located from the RIGHT.
    fn addr_index_height(key: &[u8]) -> Option<u64> {
        let s = std::str::from_utf8(key).ok()?;
        let mut parts = s.rsplitn(3, '_');
        let _tx_hash = parts.next()?;
        let h_hex = parts.next()?;
        u64::from_str_radix(h_hex, 16).ok()
    }

    /// Rows one maintenance pass may examine in a column family so that `runs_in_window` passes
    /// sweep all of it. Uses RocksDB's own key estimate, so the budget tracks real load instead of
    /// a number someone picked once. Floor: a young index still drains. Ceiling: one pass stays short
    /// enough that the hourly maintenance thread never becomes the bottleneck.
    fn sweep_budget(&self, cf_name: &str, runs_in_window: u64) -> usize {
        const MIN_SWEEP: usize = 50_000;
        const MAX_SWEEP: usize = 5_000_000;
        let est = self.persistent.db.cf_handle(cf_name)
            .and_then(|cf| self.persistent.db.property_int_value_cf(&cf, "rocksdb.estimate-num-keys").ok().flatten())
            .unwrap_or(0);
        let needed = (est / runs_in_window.max(1)) as usize;
        needed.clamp(MIN_SWEEP, MAX_SWEEP)
    }

    /// DEPRECATED — legacy "headers-only" Light pruning pass.
    ///
    /// Current Light tier (v3.18+) is a pure mobile API client with
    /// zero on-device chain storage; the `save_microblock` path is a
    /// no-op for `StorageMode::Light`, so this pruning function should
    /// never observe any rows to convert. Retained for backward
    /// compatibility with the historical header-rotation tier and to
    /// keep call sites compiling. Will be removed in a future cleanup.
    fn prune_for_light_node(&self) -> IntegrationResult<()> {
        println!("[INFO][STORAGE] light_node_prune_start mode=legacy_no_op");
        
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
            let header = &value[..200.min(value.len())]; // bytes, not str
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
    /// Highest RETAINED snapshot height ≤ ceiling — cold-join verifiable-anchor negotiation. A joiner
    /// clamps to its exogenously-verifiable anchor (GALC pin / h=90); a peer whose latest snapshot is
    /// ABOVE that pin must still offer the highest one ≤ it. None ⇒ peer retains no snapshot ≤ ceiling.
    pub fn get_highest_snapshot_height_le(&self, ceiling: u64) -> IntegrationResult<Option<u64>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        let mut best = 0u64;
        let iter = self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            if let Ok((key, _)) = item {
                let key_str = String::from_utf8_lossy(&key);
                // full_snap_ ONLY — we advertise to P2P joiners, who must receive a COMPLETE snapshot.
                let h_opt = key_str.strip_prefix("full_snap_");
                if let Some(h_str) = h_opt {
                    if let Ok(h) = h_str.parse::<u64>() {
                        if h <= ceiling && h > best { best = h; }
                    }
                }
            }
        }
        Ok(if best > 0 { Some(best) } else { None })
    }

    pub fn get_latest_snapshot_height(&self) -> IntegrationResult<Option<u64>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        // Advertised to P2P joiners ⇒ full_snap_ ONLY (complete snapshots); state_snap_ is local-only.
        // 1. Prefer the full-snapshot pointer.
        if let Ok(Some(data)) = self.persistent.db.get_cf(&snapshots_cf, b"latest_full_snap") {
            if data.len() >= 8 {
                if let Ok(bytes) = data[..8].try_into() {
                    let height = u64::from_le_bytes(bytes);
                    if height > 0 { return Ok(Some(height)); }
                }
            }
        }

        // 2. Fall back to a scan over full_snap_ keys (nodes without the pointer).
        let mut latest_height = 0u64;
        let iter = self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            if let Ok((key, _)) = item {
                let key_str = String::from_utf8_lossy(&key);
                if let Some(h_str) = key_str.strip_prefix("full_snap_") {
                    if let Ok(h) = h_str.parse::<u64>() {
                        if h > latest_height { latest_height = h; }
                    }
                }
            }
        }

        if latest_height > 0 { Ok(Some(latest_height)) } else { Ok(None) }
    }
    
    /// v32.9: Canonical state root computed from accounts CF in RocksDB.
    /// Deterministic across nodes — every honest node hashes the same
    /// sorted (key, value) list domain-separated by height. Used for
    /// snapshot consensus binding via Pattern C (state_root commitment
    /// instead of opaque SHA3-of-bytes). Independent of in-memory
    /// StateManager so verifier can compute after applying a downloaded
    /// snapshot without re-initialising state.
    pub fn compute_canonical_state_root(&self, height: u64) -> IntegrationResult<[u8; 32]> {
        let accounts_cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;

        let mut entries: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        let iter = self.persistent.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            match item {
                Ok((k, v)) => entries.push((k.to_vec(), v.to_vec())),
                Err(e) => return Err(IntegrationError::StorageError(format!("canonical_root_iter_err: {}", e))),
            }
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(b"QNET_CANONICAL_STATE_ROOT_V1:");
        hasher.update(&height.to_le_bytes());
        hasher.update(&(entries.len() as u64).to_le_bytes());
        for (k, v) in &entries {
            hasher.update(&(k.len() as u32).to_le_bytes());
            hasher.update(k);
            hasher.update(&(v.len() as u32).to_le_bytes());
            hasher.update(v);
        }
        let mut root = [0u8; 32];
        root.copy_from_slice(&hasher.finalize());
        Ok(root)
    }

    /// Rebuild the canonical account-state merkle root (the consensus
    /// finalize_merkle output) from the accounts CF. Binds a restored snapshot
    /// to the QC-certified mb.state_root: a forged snapshot yields a different
    /// root. Deterministic — a fresh StateMerkleTree full-recomputes (no
    /// incremental cache), matching every node's finalize().
    pub fn recompute_account_merkle_root(&self) -> IntegrationResult<[u8; 32]> {
        self.recompute_account_merkle_root_cf("accounts")
    }

    /// Account merkle over an explicit CF: "accounts" (live) or "accounts_stage" (cold-join verify).
    /// Streams the CF row-by-row into a throwaway tree (no full Vec) — the finalized root is identical
    /// (the tree is leaf-set-keyed, so insertion streaming vs batch yields the same root).
    pub fn recompute_account_merkle_root_cf(&self, cf_name: &str) -> IntegrationResult<[u8; 32]> {
        let accounts_cf = self.persistent.db.cf_handle(cf_name)
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut tree = qnet_state::StateMerkleTree::new();
        for item in self.persistent.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start) {
            let (k, v) = item.map_err(|e| IntegrationError::StorageError(format!("merkle_iter_err: {}", e)))?;
            let addr = String::from_utf8(k.to_vec())
                .map_err(|e| IntegrationError::StorageError(format!("merkle_addr_utf8_err: {}", e)))?;
            let account: qnet_state::Account = bincode::deserialize(&v)
                .map_err(|e| IntegrationError::SerializationError(format!("merkle_account_decode_err: {}", e)))?;
            // V2 SNAPSHOT BINDING: under the SROOT schema the contract account leaf commits only
            // storage_root, NOT the raw contract_storage map (the old full-map fold is gone). So a
            // restored/untrusted contract_storage that does NOT hash to the committed storage_root would
            // still reproduce state_root and pass the Pattern-C bind — yet serve forged balances and fork
            // on the next write. Re-derive and reject the mismatch here (O(entries)) to restore the
            // transitive binding the fold gave for free, so a tampered snapshot fails the bind check.
            if !qnet_state::StateMerkleTree::contract_storage_root_matches(&account) {
                return Err(IntegrationError::StorageError(format!(
                    "[REJECT][SNAPSHOT] storage_root_mismatch addr={} cf={}", addr, cf_name)));
            }
            tree.insert_lazy(&addr, &account);
        }
        Ok(tree.finalize())
    }

    /// Get raw snapshot data for P2P download (v2.19.12)
    /// Returns compressed binary snapshot data
    pub fn get_snapshot_data(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        // P2P cold-join serve: full_snap_ ONLY. state_snap_ is an accounts+supply local-restart artifact
        // (incomplete — no rewards/contracts/registry CFs) and must NEVER be served to a joiner, who would
        // recompute a wrong bound root. The local/P2P role is now EXPLICIT, not an accidental key-unit gap.
        let key = format!("full_snap_{}", height);
        if let Some(data) = self.persistent.db.get_cf(&snapshots_cf, key.as_bytes())? {
            return Ok(Some(data));
        }
        Ok(None)
    }
    
    /// Binder lineage-walk budget (macroblocks): the max genesis/pin-rooted N-2 QC walk a cold joiner will
    /// re-verify. SINGLE SOURCE for both the snapshot SELECTION ceiling (download_and_load_snapshot) and the
    /// binder (verify_snapshot_consensus_binding) so the two can never drift. ~2 weeks at 1 blk/s ⇒ realistic
    /// binary-WS-pin rotation cadence; a fresh GALC capsule normally keeps the real walk ≈ 0.
    const SNAPSHOT_MAX_WS_WALK_MB: u64 = 13_440;

    /// Committee signatures are the bulk of a macroblock — 2f+1 ML-DSA-65 envelopes, ~3 MB at the
    /// 1000-member target committee, against a few KB for everything else. They are read ONLY by
    /// `verify_v2_macroblock`, which runs at INGEST; every reader of a STORED macroblock takes the
    /// checkpoint half (reward roots, total_supply, registry_root, recovery anchor). So the sigs are
    /// needed exactly as long as a cold joiner may still walk to this index — the binder budget below
    /// — plus margin for tip skew between joiner and server and the walk's one-below descent.
    ///
    /// Without this, macroblock storage on a Super (which prunes nothing) grows ~1 TB/year at target
    /// scale and has no horizon at all. Stripping is fork-free by construction: `MacroBlock::hash()`
    /// excludes consensus_data, and `sig_merkle_root` stays, so the removed set is still committed.
    const QC_SIG_RETENTION_MB: u64 = Self::SNAPSHOT_MAX_WS_WALK_MB + 1_440;

    /// Strip committee signatures from macroblocks whose index is below the retention horizon, keeping
    /// the checkpoint, the signer list and `sig_merkle_root`. Bounded and resumable: the cursor is the
    /// highest index already swept, so runs form one monotone forward sweep and never re-read the tail.
    /// Absent indices (a snapshot-joined node holds none below its anchor) advance the cursor for free.
    /// Returns how many macroblocks were rewritten.
    pub fn strip_macroblock_qc_sigs(&self) -> IntegrationResult<u64> {
        /// Indices looked at per call. A miss is one bloom-filter probe, so this may be large — it is
        /// what lets a snapshot-joined node sweep past its empty pre-anchor range in a few runs.
        const EXAMINE_CAP: u64 = 50_000;
        /// Macroblocks rewritten per call: the real work bound (decode + re-serialize + write).
        const REWRITE_CAP: u64 = 512;

        let tip_mb = self.get_chain_height()?.saturating_div(90);
        let floor = match tip_mb.checked_sub(Self::QC_SIG_RETENTION_MB) {
            Some(f) if f > 0 => f,
            _ => return Ok(0), // young chain: nothing is outside the walk budget yet
        };

        let micro_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let meta_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let mut swept = self.persistent.db.get_cf(&meta_cf, b"qc_sig_strip_cursor")?
            .filter(|v| v.len() == 8)
            .map(|v| u64::from_be_bytes(v[..8].try_into().unwrap_or([0u8; 8])))
            .unwrap_or(0);

        let mut batch = WriteBatch::default();
        let mut rewritten: u64 = 0;
        let mut examined: u64 = 0;
        while swept < floor && examined < EXAMINE_CAP && rewritten < REWRITE_CAP {
            let index = swept + 1;
            examined += 1;
            swept = index;
            let key = format!("macroblock_{}", index);
            let raw = match self.persistent.db.get_cf(&micro_cf, key.as_bytes())? {
                Some(r) if !r.is_empty() => r,
                _ => continue,
            };
            // Stored macroblocks may be zstd-framed; re-store in the SAME framing so no reader has to
            // learn a new one.
            let compressed = raw.len() >= 4 && raw[0..4] == [0x28, 0xb5, 0x2f, 0xfd];
            let plain = if compressed {
                match zstd::decode_all(&raw[..]) { Ok(d) => d, Err(_) => continue }
            } else {
                raw
            };
            let mut mb: qnet_state::MacroBlock = match bincode::deserialize(&plain) {
                Ok(m) => m,
                Err(_) => continue, // unreadable row: leave it exactly as found, never destroy
            };
            let qc_bytes = match mb.consensus_data.checkpoint_qc.as_ref() { Some(b) => b, None => continue };
            let (cp, mut qc): (qnet_consensus::checkpoint_bft::Checkpoint,
                               qnet_consensus::checkpoint_bft::QuorumCertificate) =
                match bincode::deserialize(qc_bytes) { Ok(v) => v, Err(_) => continue };
            if qc.sigs.is_empty() { continue; }
            qc.sigs = Vec::new();
            let restripped = match bincode::serialize(&(cp, qc)) { Ok(b) => b, Err(_) => continue };
            mb.consensus_data.checkpoint_qc = Some(restripped);
            let reserialized = match bincode::serialize(&mb) { Ok(b) => b, Err(_) => continue };
            let out = if compressed {
                match zstd::encode_all(&reserialized[..], 3) { Ok(c) => c, Err(_) => continue }
            } else {
                reserialized
            };
            batch.put_cf(&micro_cf, key.as_bytes(), &out);
            rewritten += 1;
        }

        batch.put_cf(&meta_cf, b"qc_sig_strip_cursor", &swept.to_be_bytes());
        self.persistent.db.write(batch)?;
        if rewritten > 0 && crate::node::is_info() {
            println!("[INFO][STORAGE] qc_sigs_stripped count={} up_to={} floor={}", rewritten, swept, floor);
        }
        Ok(rewritten)
    }

    /// True iff this stored macroblock still carries its committee signatures. A stripped one is
    /// useless to a syncing peer: `verify_v2_macroblock` would read the empty set as an invalid QC and
    /// score the honest server as byzantine, so the sync path serves it as ABSENT instead.
    pub fn macroblock_carries_qc_sigs(mb: &qnet_state::MacroBlock) -> bool {
        mb.consensus_data.checkpoint_qc.as_ref().map_or(false, |b| {
            bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint,
                                    qnet_consensus::checkpoint_bft::QuorumCertificate)>(b)
                .map_or(false, |(_, qc)| !qc.sigs.is_empty())
        })
    }

    /// Highest macroblock index contiguously present at/above the apply frontier (chain_height/90). Present
    /// ⟹ inductively QC-verified (stored only after verify_v2). SINGLE SOURCE for the selection ceiling AND
    /// the binder walk budget so the two extents can never drift. Bounded: chain_height/90 is a tight lower
    /// bound and any fill-ahead is capped at SNAPSHOT_MAX_WS_WALK_MB, so this never scans O(chain).
    fn own_contiguous_frontier_mb(&self) -> u64 {
        let mut f = self.get_chain_height().unwrap_or(0) / 90;
        while self.get_macroblock_by_height(f.saturating_add(1)).ok().flatten().is_some() {
            f = f.saturating_add(1);
        }
        f
    }

    /// v5.0: Download snapshot from network — chunked parallel download with fallback
    pub async fn download_and_load_snapshot(&self, p2p: &crate::unified_p2p::SimplifiedP2P) -> IntegrationResult<u64> {
        let peers = p2p.get_validated_active_peers();
        if peers.is_empty() {
            return Err(IntegrationError::Other("No peers available for snapshot download".to_string()));
        }

        // Two-phase snapshot negotiation. Phase 1: query each peer's
        // advertised snapshot height (differ per-node — creation is per-node).
        // Phase 2: pick best_height and download ONLY from peers that
        // reported exactly it — including lower/no-height peers would return
        // None on get_snapshot_chunk and break the manifest chain, forcing
        // fallback even when a capable peer exists. >1 such peer → parallel
        // fan-out; exactly 1 → serial (still faster than block-by-block).
        // IPFS fast path preserved: ipfs_cid + IPFS_ENABLED short-circuits
        // to the gateway, bypassing peer fan-out. O(active_peers) discovery.

        // v31.5: Phase 1 discovery — parallel fan-out via join_all.
        // Cost = max(rtt) regardless of peer count.
        let mut best_height = 0u64;
        let mut peer_heights: Vec<(String, u64)> = Vec::new();

        // A1: settle the genesis-rooted GALC pin BEFORE reading the ceiling — the capsule arrives +
        // Dilithium-verifies asynchronously, so a joiner without a near-tip pin acquires it first to keep the
        // binder walk ≈ 0. Re-sample the (f+1)-corroborated tip EACH pass: at t=0 the cache can read 0 (peers
        // up, head not yet reported), so should_have_capsule latches ONLY once a mature tip (mb >=
        // GALC_MINT_INTERVAL) is corroborated. A corroborated young chain fail-opens; an unproven tip keeps
        // polling. On mature-tip-but-pin-absent it returns retryable AnchorPending (bounded eclipse floor).
        static COLDJOIN_ANCHOR_PENDING_ROUNDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        const COLDJOIN_ANCHOR_PENDING_MAX: u64 = 10; // ~2 min of retries, then fail-open (eclipse liveness floor)
        // Engage the pin-wait keyed on pin-staleness vs the (f+1)-corroborated mature tip — NOT own_frontier
        // (concurrent linear sync advancing it, or a prior low-anchor adoption, must never disarm the wait).
        // Skip it when a near-tip pin is already held OR our own contiguous verified frontier can already bind
        // a snapshot within the walk budget (no capsule needed). All callers gate this on far-behind.
        let corr_tip_mb = p2p.corroborated_head_ceiling() / 90;
        // FRESH (near-tip) pin. Keyed on STALENESS, not mere existence — a stale nonzero pin (old capsule
        // from a lagging peer) must NOT count as reached. Takes the tip explicitly so the loop re-checks
        // against the LIVE corroborated tip each pass. Margin = 2 mint intervals, not 1: the capsule roots at
        // the latest FINALIZED 40-boundary K while corr_tip_mb is the (unfinalized) microblock tip that leads
        // it by up to ~1 interval (boundary floor + finality lag), so a 1-interval margin would misflag the
        // freshest mintable capsule as stale for part of each cycle → spurious AnchorPending. 2 intervals
        // absorbs the gap; a genuinely old capsule (≥2 intervals below tip) is still stale and the resulting
        // binder walk stays ≤2 intervals (cheap).
        let pin_fresh = |mb: u64, tip_mb: u64| mb > 0 && tip_mb > 0
            && mb.saturating_add(2 * crate::galc::GALC_MINT_INTERVAL) > tip_mb;
        // A node whose own contiguous frontier is within the walk budget of the tip binds cheaply from its
        // own lineage and needs no capsule — do not stall it in the wait (it would AnchorPending pointlessly).
        let frontier_can_bind = corr_tip_mb > 0
            && corr_tip_mb.saturating_sub(self.own_contiguous_frontier_mb()) <= Self::SNAPSHOT_MAX_WS_WALK_MB;
        if !pin_fresh(crate::galc::effective_pin_checkpoint().0, corr_tip_mb) && !frontier_can_bind {
            const GALC_PIN_WAIT_ATTEMPTS: u32 = 20;       // ≤ ~10s per cold-join call
            const GALC_PIN_WAIT_INTERVAL_MS: u64 = 500;
            let mut should_have_capsule = false;          // set true ONLY on a (f+1)-corroborated mature tip
            let mut tip_live = corr_tip_mb;
            for i in 0..GALC_PIN_WAIT_ATTEMPTS {
                // Re-read the LIVE (f+1)-corroborated tip each pass: corroborated_head_ceiling() is the
                // (f+1)-th highest fresh in-set peer height, or 0 when < f+1 corroborators — a lone lying peer
                // cannot raise it. 0 = uncorroborated → keep polling.
                tip_live = p2p.corroborated_head_ceiling() / 90;
                // Break on a FRESH pin (near the live tip), not mere existence: a stale nonzero pin keeps
                // polling for the near-tip capsule via the re-request below, else the ceiling would collapse.
                if pin_fresh(crate::galc::effective_pin_checkpoint().0, tip_live) { break; }
                if tip_live >= crate::galc::GALC_MINT_INTERVAL { should_have_capsule = true; }
                else if tip_live > 0 { break; }            // CORROBORATED young chain (< first capsule) → fail-open to h=90
                // tip_live == 0: no f+1 corroboration yet → keep polling (never latch from an unproven tip)
                if i % 4 == 0 {                            // re-request every ~2s (a reply may be lost)
                    let _ = p2p.broadcast_quic(&crate::unified_p2p::NetworkMessage::RequestGenesisCheckpoint {
                        requester_id: "snapshot_ceiling".to_string(),
                    }).await;
                }
                tokio::time::sleep(std::time::Duration::from_millis(GALC_PIN_WAIT_INTERVAL_MS)).await;
            }
            // Mature tip but still no FRESH pin (stale-nonzero OR absent): return retryable AnchorPending so
            // the caller bails to the desync tick rather than rooting the ceiling at a stale/genesis extent.
            // Bounded escape after COLDJOIN_ANCHOR_PENDING_MAX rounds → fail-open to block-replay (eclipse floor).
            // The counter is process-global (shared across cold-join drivers); in a true eclipse every driver
            // takes the increment (none the reset), so it climbs monotonically to MAX — no livelock.
            if should_have_capsule && !pin_fresh(crate::galc::effective_pin_checkpoint().0, tip_live) {
                let rounds = COLDJOIN_ANCHOR_PENDING_ROUNDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                if rounds <= COLDJOIN_ANCHOR_PENDING_MAX {
                    if crate::node::is_info() {
                        println!("[INFO][SYNC] coldjoin_anchor_pending round={}/{} — retry next tick", rounds, COLDJOIN_ANCHOR_PENDING_MAX);
                    }
                    return Err(IntegrationError::AnchorPending);
                }
                if crate::node::is_warn() {
                    println!("[WARN][SYNC] coldjoin_anchor_pending_exhausted rounds={} — fail-open to block-replay (degraded/eclipse)", rounds);
                }
            }
            COLDJOIN_ANCHOR_PENDING_ROUNDS.store(0, std::sync::atomic::Ordering::Relaxed);
        }

        // Exogenously-verifiable negotiation ceiling — genesis/pin/frontier-rooted, NEVER a raw peer tip. A
        // cold joiner may adopt any snapshot whose anchor the binder re-verifies from a trusted root within its
        // REAL walk budget (SNAPSHOT_MAX_WS_WALK_MB, the same CONSTANT verify_snapshot_consensus_binding
        // enforces). Roots: the GALC pin, the rotated WS floor, or its OWN highest contiguous-present macro-
        // block (present ⟹ inductively QC-verified from genesis). Prior code capped this at base+15mb, below
        // the latest snapshot whenever the verified extent lags it by ≥1 interval (40mb) → the joiner was
        // forced onto a stale anchor + O(chain) tail. NOTE: the binder credits the pin as a walk root ONLY
        // when usable (ws_floor < pin ≤ anchor); a capsule minted one interval ABOVE the negotiated anchor
        // roots the binder at ws_floor instead, so at a boundary crossing an admitted snapshot may be re-
        // verified from ws_floor/frontier (transiently rejected + retried next tick, never mis-bound). Bytes
        // stay bound to the anchor's 2f+1 snapshot_root on promote and a forged anchor fails the QC walk →
        // block replay, so the wide ceiling never weakens weak-subjectivity. base==0 + no mature tip ⇒ h=90.
        let verifiable_ceiling = {
            let pin_mb = crate::galc::effective_pin_checkpoint().0;
            let ws_floor_mb = crate::node::effective_ws_checkpoint().0;
            let base_mb = pin_mb.max(ws_floor_mb).max(self.own_contiguous_frontier_mb());
            if base_mb == 0 && corr_tip_mb < crate::galc::GALC_MINT_INTERVAL {
                crate::node::SNAPSHOT_EARLY_ANCHOR_HEIGHT
            } else {
                base_mb.saturating_add(Self::SNAPSHOT_MAX_WS_WALK_MB).saturating_mul(90)
            }
        };

        let queries: Vec<_> = peers.iter().map(|peer| {
            let addr = peer.addr.clone();
            let storage_ref = self;
            async move {
                let result = storage_ref.query_peer_snapshot(&addr, verifiable_ceiling).await;
                (addr, result)
            }
        }).collect();

        let results = futures::future::join_all(queries).await;

        for (addr, result) in results {
            if let Ok(Some((height, cid))) = result {
                if height > verifiable_ceiling { continue; } // defense: peer ignored the ceiling param
                if height > best_height {
                    best_height = height;
                }
                // IPFS fast path — content-addressed, scales with the swarm
                // rather than the validator committee.
                if !cid.is_empty() && std::env::var("IPFS_ENABLED").unwrap_or_default() == "1" {
                    if let Ok(_) = self.download_snapshot_from_ipfs(&cid, height).await {
                        // An IPFS CID is content-addressed but NOT consensus-bound — route it through the
                        // SAME staged 2f+1-QC anchor binding + promote as the chunked/legacy paths.
                        if let Ok(h) = self.verify_and_promote_staged(p2p, height).await {
                            println!("[INFO][SYNC] snapshot_from_ipfs h={} bound=ok", h);
                            return Ok(h);
                        }
                    }
                }
                peer_heights.push((addr, height));
            }
        }

        if best_height == 0 || peer_heights.is_empty() {
            return Err(IntegrationError::Other("No snapshots available from network".to_string()));
        }

        // ── Phase 2: pick the HIGHEST height advertised by a quorum (>=2) of peers so the
        // download has redundant sources for parallel fan-out + retry. The single max is
        // often one peer mid-boundary → serial download. Fall back to max if none shared.
        let target_height = {
            let mut counts: std::collections::BTreeMap<u64, usize> = std::collections::BTreeMap::new();
            for (_, h) in &peer_heights { *counts.entry(*h).or_insert(0) += 1; }
            let quorum = 2usize.min(peer_heights.len());
            counts.iter().rev().find(|(_, c)| **c >= quorum).map(|(h, _)| *h).unwrap_or(best_height)
        };
        let peer_addrs: Vec<String> = peer_heights
            .iter()
            .filter(|(_, h)| *h == target_height)
            .map(|(addr, _)| addr.clone())
            .collect();

        if peer_addrs.is_empty() {
            return Err(IntegrationError::Other(format!(
                "snapshot_peer_filter_empty target_height={} candidates={}",
                target_height, peer_heights.len(),
            )));
        }

        // Forward-only: never adopt a snapshot at/below our own chain height (promote sets chain_height,
        // so a ≤-local snapshot would REGRESS the node). The verifiable-ceiling clamp can yield a
        // below-local anchor for a node already past it (e.g. capsule-less + advanced via replay) — fall
        // to block replay instead, which continues forward.
        let local_h = self.get_chain_height().unwrap_or(0);
        if target_height <= local_h {
            return Err(IntegrationError::Other(format!(
                "snapshot_not_forward target={} local={} action=block_replay", target_height, local_h
            )));
        }

        // Snapshot is the preferred cold-join path: a transient binding/download failure is retried each
        // desync tick (~15s backoff), never permanently latched. Forward-only guard above is the only
        // suppression; convergence relies on the frontier-reserved dispatcher, not on disabling the jump.
        println!(
            "[INFO][SYNC] snapshot_download h={} capable_peers={}/{} discovery=two_phase",
            target_height, peer_addrs.len(), peer_heights.len(),
        );

        // Chunked parallel download first (restores into staging), fallback to single-peer. Then
        // verify-then-promote: the staged snapshot is bound to the 2f+1 macroblock root and only on
        // success copied into live state; ANY failure drops staging and falls to block replay.
        match self.download_snapshot_chunked(p2p, &peer_addrs, target_height).await {
            Ok(()) => self.verify_and_promote_staged(p2p, target_height).await,
            Err(e) => {
                println!("[WARN][SYNC] chunked_download_failed err={} fallback=legacy", e);
                self.download_snapshot_legacy(p2p, &peer_addrs[0], target_height).await?;
                self.verify_and_promote_staged(p2p, target_height).await
            }
        }
    }

    /// Verify a STAGED snapshot against its 2f+1 anchor and, on success, promote it into live state.
    /// On any failure drop staging and return Err so the caller falls to block replay. Pre-anchor
    /// (mb_idx==0) cold-join is handled by replay, never a snapshot.
    async fn verify_and_promote_staged(
        &self,
        p2p: &crate::unified_p2p::SimplifiedP2P,
        height: u64,
    ) -> IntegrationResult<u64> {
        if height / 90 == 0 {
            let _ = self.discard_snapshot_state(height);
            return Err(IntegrationError::Other(format!(
                "snapshot_below_anchor h={} action=block_replay", height
            )));
        }
        match self.verify_snapshot_consensus_binding(p2p, height).await {
            Ok(anchor) => {
                // A failure here may have already replaced live accounts, so the marker and staging
                // MUST survive for boot recovery. Pre-destructive failures clean up inside promote.
                self.promote_snapshot_staging(height, anchor).await?;
                Ok(height)
            }
            Err(e) => {
                // Drop staging; snapshot path stays available for retry (no permanent latch).
                let _ = self.discard_snapshot_state(height);
                Err(e)
            }
        }
    }

    // Trustless-bootstrap binding. A byzantine peer can serve a self-
    // consistent forged snapshot (per-chunk hashes only prove "download
    // matches the peer's metadata", not chain-canonicity). Binding: the
    // snapshot-boundary macroblock embeds consensus_data.snapshot_root =
    // SHA3-256 of the canonical snapshot bytes (byte-stable across the
    // committee, finalised by a 2f+1 Checkpoint-BFT QC → forging needs 2f+1 keys).
    // Verifier: SHA3 the saved snapshot → fetch macroblock at height/90
    // (local then P2P) → compare → accept or ROLL BACK (delete
    // full_snap_/state_snap_ keys). Every fetch/binding failure returns Err
    // (no graceful-degradation accept) so the caller falls to byzantine-safe
    // block-by-block sync — costs 1 RTT, no attacker state contamination.
    // O(1)/bootstrap.
    /// Verifies a STAGED snapshot (in the *_stage CFs) against the 2f+1-bound macroblock lineage.
    /// Returns the anchor macroblock hash on success (caller promotes); on ANY failure drops the
    /// staging CFs and returns Err so live state is never touched and the caller falls to block-sync.
    async fn verify_snapshot_consensus_binding(
        &self,
        p2p: &crate::unified_p2p::SimplifiedP2P,
        snapshot_height: u64,
    ) -> IntegrationResult<[u8; 32]> {
        // Genesis-window snapshots (mb_idx < 1) cannot be bound to a consensus-finalised macroblock —
        // nothing earlier to anchor against. The caller routes pre-anchor cold-join to block replay.
        let mb_idx = snapshot_height / 90;
        if mb_idx == 0 {
            return Ok([0u8; 32]);
        }

        // ── Genesis/pin-rooted inductive lineage walk (weak-subjectivity trust root) ───────────────
        // A snapshot peer controls the bytes it serves, so the anchor's 2f+1 QC must NOT be trusted
        // against a committee derived from peer-served data alone (that is circular — a byzantine server
        // forges a self-consistent anchor + predecessors + QC). Instead we re-verify the macroblock
        // lineage from an EXOGENOUS root up to the anchor: verify_v2_macroblock checks each macroblock's
        // QC against the committee sampled from its already-verified N-2 predecessor, and a macroblock
        // only stores after that verify passes (process_received_macroblock), so "contiguously present
        // in storage" ⟺ "inductively verified". Roots: fresh/young chain ⇒ genesis (the first two
        // macroblocks use the embedded genesis committee); mature chain ⇒ the binary WS pin (its
        // macroblock by hash + predecessor by the previous_hash chain, handled in verify_v2_macroblock).
        struct AnchorReset(u64);
        impl Drop for AnchorReset {
            fn drop(&mut self) {
                // Restore the prior runtime floor on ANY early return; only a fully-verified anchor
                // commits a new floor (adopt_snapshot_finality + mem::forget at the end). No provisional
                // floor is set during the walk (the old mb_idx-3 shortcut was the circularity hole).
                // CAP by the live chain_height: discard_snapshot_state zeroes chain_height on a full
                // state wipe (a snapshot rejected after a prior one was adopted), so a blind restore of
                // the higher prior anchor would strand the dedup floor above an empty chain (the cross-
                // attempt invariant break). A non-wiping early return leaves chain_height == prior, so the
                // prior anchor is restored unchanged.
                let chain_mb = crate::node::try_get_storage()
                    .and_then(|s| s.get_chain_height().ok())
                    .map(|h| h / 90)
                    .unwrap_or(self.0);
                crate::node::SNAPSHOT_ANCHOR_MB.store(self.0.min(chain_mb), std::sync::atomic::Ordering::SeqCst);
            }
        }
        let anchor_guard = AnchorReset(crate::node::SNAPSHOT_ANCHOR_MB.load(std::sync::atomic::Ordering::SeqCst));

        // Security floor = ws_floor ONLY (binary pin / adopted snapshot anchor): a snapshot below the
        // exogenous finality floor has no trusted root beneath it to re-verify from — reject. The GALC
        // capsule is a walk SHORTENER, never a floor: a capsule ABOVE the anchor can't root the forward
        // N-2 lineage walk DOWN to it, so it roots the walk ONLY when at-or-below the anchor; else ws_floor.
        let ws_floor = crate::node::effective_ws_checkpoint();
        if mb_idx < ws_floor.0 {
            let _ = self.discard_snapshot_state(snapshot_height);
            return Err(IntegrationError::Other(format!(
                "snapshot_below_ws mb={} ws={} action=reject_snapshot", mb_idx, ws_floor.0
            )));
        }
        // Root the walk at the genesis-signed GALC capsule when one is co-located at/below the
        // snapshot anchor (walk ≈ 0). The capsule arrives + Dilithium-verifies asynchronously, so a
        // binding that ran right after the cold-join orchestrator's best-effort request would race it
        // and fall back to ws_floor → a full genesis-to-anchor re-verify (the slow-rejoin bug).
        // Deterministically request + bounded-wait for a usable capsule before rooting; on timeout
        // fall through to ws_floor (correct, only slower — never worse, no new launch requirement).
        let usable = |k: u64| k > ws_floor.0 && k <= mb_idx;
        let mut pin = crate::galc::effective_pin_checkpoint();
        // Skip the wait on a young network: the first capsule only mints at mb == GALC_MINT_INTERVAL,
        // so a snapshot anchored below it can never have a usable capsule — waiting is pure dead-time.
        // Tip proxy = the anchor itself (mb_idx). Fall straight through to ws_floor (fail-open path
        // below is unchanged); behaves exactly as before once mb_idx>=GALC_MINT_INTERVAL.
        if !usable(pin.0) && mb_idx >= crate::galc::GALC_MINT_INTERVAL {
            const GALC_WAIT_ATTEMPTS: u32 = 20;        // ≤ ~10s total
            const GALC_WAIT_INTERVAL_MS: u64 = 500;
            for i in 0..GALC_WAIT_ATTEMPTS {
                // A capsule already adopted ABOVE the anchor (cadence put the freshest mint a step ahead
                // of the negotiated snapshot) can never become usable by waiting — adoption is monotonic-up
                // — so root at ws_floor now instead of burning the timeout; the next snapshot boundary
                // re-aligns capsule and anchor.
                if pin.0 > mb_idx { break; }
                if i % 4 == 0 {                        // re-request every ~2s (a reply may be lost)
                    let _ = p2p.broadcast_quic(&crate::unified_p2p::NetworkMessage::RequestGenesisCheckpoint {
                        requester_id: "snapshot_binder".to_string(),
                    }).await;
                }
                tokio::time::sleep(std::time::Duration::from_millis(GALC_WAIT_INTERVAL_MS)).await;
                pin = crate::galc::effective_pin_checkpoint();
                if usable(pin.0) { break; }
            }
            if crate::node::is_info() {
                println!("[INFO][SYNC] galc_anchor_wait mb={} pin={} rooted={}",
                         mb_idx, pin.0, if usable(pin.0) { "capsule" } else { "ws_floor" });
            }
        }
        let walk_root: (u64, [u8; 32]) =
            if usable(pin.0) { (pin.0, pin.1) } else { ws_floor };
        // Bound the walk so a stale root can't degrade into an unbounded genesis-to-tip re-verify
        // (DoS-on-self CPU + a wider trust window). The GALC capsule normally keeps the root within a few
        // macroblocks of the anchor (walk ≈ 0); this is the FALLBACK ceiling when no capsule is held, sized
        // to ~2 weeks so the binary-pin rotation cadence is realistic. Measured from the EFFECTIVE walk start
        // = max(walk_root, own contiguous-present frontier): the fill loop below slides past present ⟹
        // inductively-verified macroblocks, so the real fetch/verify work is mb_idx - frontier, not
        // mb_idx - walk_root. Trust still roots at walk_root (pin/ws_floor); the frontier is self-verified,
        // never peer-claimed, so crediting it adds no attack surface and keeps this budget consistent with
        // the selection ceiling (which also folds in frontier). INERT for a young chain (span small).
        const MAX_WS_WALK_MB: u64 = Storage::SNAPSHOT_MAX_WS_WALK_MB; // single-sourced with the selection ceiling
        let walk_span_root = walk_root.0.max(self.own_contiguous_frontier_mb());
        if mb_idx.saturating_sub(walk_span_root) > MAX_WS_WALK_MB {
            let _ = self.discard_snapshot_state(snapshot_height);
            return Err(IntegrationError::Other(format!(
                "snapshot_ws_walk_too_long mb={} start={} root={} max={} action=upgrade_binary_pin",
                mb_idx, walk_span_root, walk_root.0, MAX_WS_WALK_MB
            )));
        }
        // Where to begin filling: from genesis (1) on a fresh chain; just above the walk_root when its
        // macroblock is already present (a prior adoption — fill only the new gap); else from the pinned
        // pair (walk_root.0-1) so the root macroblock + its predecessor bootstrap forward verification.
        let walk_from = if walk_root.0 == 0 {
            1
        } else if walk_root.0 == mb_idx && walk_root.0 > ws_floor.0 {
            // Capsule/pin co-located AT the snapshot anchor (strictly above the WS floor — so anchor-1
            // is at/above the floor and re-verifiable, never below it). The forward committee derivation
            // for the
            // first two tail macroblocks (anchor+1, anchor+2) reads N-2 = {anchor-1, anchor}. The capsule
            // binds BOTH digests (pin.2 anchor, pin.3 predecessor) and verify_v2_macroblock trusts the
            // predecessor by the anchor's previous_hash chain (pin.0-1 branch), so descend to anchor-1 to
            // fetch+verify it EVEN IF the anchor macroblock is already stored. Without this the predecessor
            // is skipped (walk_root+1 ⇒ empty range) → anchor+1 hits v2_qc_no_committee, anchor+3 then
            // defers on the resulting hole → post-snapshot finality wedges 2 mb past the anchor on a mature
            // chain. The cursor skips already-present macroblocks, so this is a no-op extra storage read
            // when the predecessor is already held; it costs one fetch only in the wedge case.
            walk_root.0.saturating_sub(1).max(1)
        } else if self.get_macroblock_by_height(walk_root.0).ok().flatten().is_some() {
            walk_root.0.saturating_add(1)
        } else {
            walk_root.0.saturating_sub(1).max(1)
        };

        // Fill the contiguous lineage [walk_from ..= mb_idx] bottom-up. The cursor slides past
        // already-stored (⇒ verified) macroblocks; each attempt re-requests from the lowest-missing so
        // the repair window slides forward. Back off only when an attempt made NO progress.
        const MB_FETCH_MAX_ATTEMPTS: u32 = 1500; // server caps ~10 macroblocks/response ⇒ ≥ MAX_WS_WALK_MB/10 (+margin)
        const MB_FETCH_BASE_DELAY_MS: u64 = 1_000;
        // Wall-clock budget: a mature-chain walk with no usable GALC capsule can run ~30min and starve
        // block replay (same task). Cap it; on timeout the incomplete-lineage path below drops staging,
        // latches the boundary (no re-arm), and the caller falls through to block replay. Kept under
        // STALL_ABORT(120s); a young chain (capsule co-located) finishes in ~0 well before it.
        const WALK_BUDGET_SECS: u64 = 90;
        let walk_deadline = std::time::Instant::now() + std::time::Duration::from_secs(WALK_BUDGET_SECS);
        let mut lineage_from = walk_from;
        let mut attempt = 0u32;
        loop {
            while lineage_from <= mb_idx
                && self.get_macroblock_by_height(lineage_from).ok().flatten().is_some()
            {
                lineage_from = lineage_from.saturating_add(1);
            }
            if lineage_from > mb_idx { break; } // full contiguous lineage present ⇒ inductively verified
            attempt += 1;
            if attempt > MB_FETCH_MAX_ATTEMPTS { break; }
            if std::time::Instant::now() >= walk_deadline {
                if crate::node::is_warn() {
                    println!("[WARN][SYNC] verifier_walk_budget_exceeded reached={} mb={} action=block_replay",
                        lineage_from.saturating_sub(1), mb_idx);
                }
                break;
            }
            let before = lineage_from;
            if crate::node::is_info() {
                println!(
                    "[INFO][SYNC] verifier_lineage_walk from={} to={} attempt={}/{} for_snapshot_h={}",
                    lineage_from, mb_idx, attempt, MB_FETCH_MAX_ATTEMPTS, snapshot_height,
                );
            }
            if let Err(e) = p2p.sync_macroblocks_repair(lineage_from, mb_idx).await {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][SYNC] verifier_lineage_fetch_retry from={} to={} attempt={}/{} err={}",
                        lineage_from, mb_idx, attempt, MB_FETCH_MAX_ATTEMPTS, e,
                    );
                }
            }
            // Re-slide to measure progress before deciding to back off.
            while lineage_from <= mb_idx
                && self.get_macroblock_by_height(lineage_from).ok().flatten().is_some()
            {
                lineage_from = lineage_from.saturating_add(1);
            }
            if lineage_from == before {
                let backoff_ms = MB_FETCH_BASE_DELAY_MS.saturating_mul(1u64 << (attempt - 1).min(3));
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            }
        }

        let macroblock_bytes = match self.get_macroblock_by_height(mb_idx)
            .map_err(|e| IntegrationError::Other(format!("mb_reload_err mb={} err={:?}", mb_idx, e)))?
        {
            Some(b) if lineage_from > mb_idx => b, // anchor present AND lineage [walk_from..=mb_idx] contiguous
            _ => {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][SYNC] verifier_lineage_incomplete mb={} reached={} attempts={} action=reject_snapshot",
                        mb_idx, lineage_from.saturating_sub(1), MB_FETCH_MAX_ATTEMPTS,
                    );
                }
                let _ = self.discard_snapshot_state(snapshot_height);
                return Err(IntegrationError::Other(format!(
                    "snapshot_binding_unavailable mb={} reason=lineage_incomplete reached={}",
                    mb_idx, lineage_from.saturating_sub(1)
                )));
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
                let _ = self.discard_snapshot_state(snapshot_height);
                return Err(IntegrationError::Other(format!(
                    "snapshot_binding_unavailable mb={} reason=mb_decode_failed err={}",
                    mb_idx, e
                )));
            }
        };

        // Anchor-QC gate (P2/P1): trust the macroblock's state_root ONLY after its own 2f+1
        // checkpoint QC verifies against the committee anchored to the embedded genesis keys.
        // Without this a Byzantine peer forges a self-consistent (macroblock, snapshot) pair the
        // merkle recompute below would accept (a None-QC macroblock passes verify_v2_macroblock's
        // early return). On ANY failure, discard the applied state → fall back to verified block-sync.
        if let Err(e) = crate::node::verify_snapshot_anchor_qc(&macroblock, mb_idx, self).await {
            if crate::node::is_warn() {
                println!(
                    "[WARN][SYNC] verifier_anchor_qc_failed mb={} snapshot_h={} err={} action=reject_snapshot",
                    mb_idx, snapshot_height, e,
                );
            }
            let _ = self.discard_snapshot_state(snapshot_height);
            return Err(IntegrationError::Other(format!(
                "snapshot_binding_unverified mb={} reason=anchor_qc_invalid err={}", mb_idx, e
            )));
        }

        // Step 2: the 2f+1-bound account-state root. The macroblock's top-level
        // state_root IS checkpoint.state_root (finalize_merkle), certified by the
        // checkpoint QC — the trustless anchor. (consensus_data.snapshot_root is unused.)
        let expected_root = macroblock.state_root;
        if expected_root == [0u8; 32] {
            if crate::node::is_warn() {
                println!(
                    "[WARN][SYNC] verifier_no_binding mb={} snapshot_h={} action=reject_snapshot",
                    mb_idx, snapshot_height,
                );
            }
            let _ = self.discard_snapshot_state(snapshot_height);
            return Err(IntegrationError::Other(format!(
                "snapshot_binding_missing mb={} reason=zero_state_root", mb_idx
            )));
        }

        // Pattern C: snapshot bytes are staged in accounts_stage. Recompute the SAME account merkle the
        // consensus committed (finalize_merkle) from the STAGED accounts and compare to the QC-bound
        // mb.state_root; a forged snapshot yields a different root.
        let computed = self.recompute_account_merkle_root_cf("accounts_stage")
            .map_err(|e| IntegrationError::Other(format!("merkle_recompute_err h={} err={:?}", snapshot_height, e)))?;

        if computed != expected_root {
            // Real rollback: a peer served state that doesn't match the 2f+1-bound root.
            // Wipe it entirely (not just the key) so it can't pollute the fallback block-sync.
            self.discard_snapshot_state(snapshot_height)?;
            return Err(IntegrationError::Other(format!(
                "snapshot_root_mismatch h={} mb={} expected={} computed={}",
                snapshot_height, mb_idx,
                hex::encode(&expected_root[..8]),
                hex::encode(&computed[..8]),
            )));
        }

        // #8 registry binding: the account-merkle check above covers ONLY the accounts CF, NOT the
        // node_registry CF — from which cbw AND the attestor VRF keys are derived. Without this an
        // untrusted snapshot server could serve correct accounts but a FORGED node_registry (rebinding
        // a burn to its own wallet, or swapping a VRF key) → the joiner accepts reused-burn blocks
        // honest nodes reject, or verifies attestations against forged keys. Recompute the deterministic
        // registry digest from the restored registry and compare to the anchor checkpoint's QC-certified
        // registry_root (bounded by the checkpoint's window head). Gated: until the rule activates the
        // root is computed+committed but not enforced here (staging window to prove live agreement).
        if qnet_state::feature_gates::is_active("registry_root_required", snapshot_height) {
            let cp_opt = macroblock.consensus_data.checkpoint_qc.as_ref().and_then(|b| {
                bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint, qnet_consensus::checkpoint_bft::QuorumCertificate)>(b).ok()
            }).map(|(cp, _)| cp);
            match cp_opt {
                Some(cp) => {
                    let computed_rr = match self.compute_registry_root_staged("node_registry_stage", cp.window_head_height) {
                        Some(r) => r,
                        // Unreadable staged registry: treat as a failed verify, not as a pass.
                        None => {
                            self.discard_snapshot_state(snapshot_height)?;
                            return Err(IntegrationError::Other(format!(
                                "snapshot_registry_root_unreadable h={} mb={}", snapshot_height, mb_idx)));
                        }
                    };
                    if computed_rr != cp.registry_root {
                        self.discard_snapshot_state(snapshot_height)?;
                        return Err(IntegrationError::Other(format!(
                            "snapshot_registry_root_mismatch h={} mb={} committed={} computed={}",
                            snapshot_height, mb_idx,
                            hex::encode(&cp.registry_root[..8]), hex::encode(&computed_rr[..8]),
                        )));
                    }
                    // FIX-5: same anti-forge boundary for the per-account ML-DSA-65 pk set. The account
                    // merkle (state_root) does NOT cover pk (excluded from hash_account by design), so an
                    // untrusted snapshot server could serve correct balances but omit/alter an account's
                    // pk → a joiner would stall that account's ELIDED TXs forever (unresolvable signer)
                    // or admit a rebound key. Recompute dilithium_pk_root over the STAGED accounts and
                    // compare to the QC-certified cp.dilithium_pk_root. Same gate as registry_root.
                    let computed_dpk = match self.compute_dilithium_pk_root_staged() {
                        Some(r) => r,
                        // Unreadable staged accounts: a failed verify, never a pass.
                        None => {
                            self.discard_snapshot_state(snapshot_height)?;
                            return Err(IntegrationError::Other(format!(
                                "snapshot_dilithium_pk_root_unreadable h={} mb={}", snapshot_height, mb_idx)));
                        }
                    };
                    if computed_dpk != cp.dilithium_pk_root {
                        self.discard_snapshot_state(snapshot_height)?;
                        return Err(IntegrationError::Other(format!(
                            "snapshot_dilithium_pk_root_mismatch h={} mb={} committed={} computed={}",
                            snapshot_height, mb_idx,
                            hex::encode(&cp.dilithium_pk_root[..8]), hex::encode(&computed_dpk[..8]),
                        )));
                    }
                }
                None => {
                    self.discard_snapshot_state(snapshot_height)?;
                    return Err(IntegrationError::Other(format!(
                        "snapshot_registry_root_unavailable mb={} reason=no_checkpoint_qc", mb_idx
                    )));
                }
            }
        }

        // No vrf_pk completeness gate: registry authenticity is bound by registry_root above; vrf_pk is in
        // no consensus root and self-heals via on-chain apply + VrfKeyAnnounce gossip. A super missing its
        // key is excluded only from QC verification (n−f quorum unaffected), never from the committee
        // sample — so a missing key must NOT reject otherwise-authentic state (would brick every joiner).

        // Staging verified (2f+1 QC + Pattern-C state + registry binding). Return the anchor hash;
        // promote commits the floors and copies staging→live atomically.
        std::mem::forget(anchor_guard);
        if crate::node::is_info() {
            println!(
                "[INFO][SYNC] verifier_pass mb={} snapshot_h={} root={} pattern=C",
                mb_idx, snapshot_height, hex::encode(&computed[..8]),
            );
        }
        Ok(macroblock.hash())
    }

    /// Wipe every key of a CF (cold-start rollback helper).
    fn clear_cf(&self, cf_name: &str) -> IntegrationResult<()> {
        if let Some(cf) = self.persistent.db.cf_handle(cf_name) {
            let mut batch = WriteBatch::default();
            for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start) {
                let (k, _) = item?;
                batch.delete_cf(&cf, k);
            }
            self.persistent.db.write(batch)?;
        }
        Ok(())
    }

    /// Rebuild the per-key contract_storage CF from the (verified) accounts CF. contract_storage
    /// mirrors Account.contract_storage, which is bound by state_root, so deriving it here binds it
    /// transitively — the untrusted staged contract_storage is never promoted.
    fn rebuild_contract_storage_from_accounts(&self) -> IntegrationResult<()> {
        let accounts_cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut n = 0u64;
        for item in self.persistent.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start) {
            let (_k, v) = item?;
            let acct: qnet_state::Account = match bincode::deserialize(&v) { Ok(a) => a, Err(_) => continue };
            if acct.is_contract && !acct.contract_storage.is_empty() {
                self.persistent.save_contract_storage(&acct.address, &acct.contract_storage)?;
                n += 1;
            }
        }
        if n > 0 && crate::node::is_info() {
            println!("[INFO][SNAPSHOT] contract_storage_rebuilt contracts={}", n);
        }
        Ok(())
    }

    /// Drop a rejected staged snapshot: truncate the *_stage CFs + the staged blob ONLY. Live state,
    /// chain_height and the finality floors are NEVER touched, so a reject degrades cleanly to block
    /// replay from the current committed height (no orphaned state, no wipe of replay progress).
    fn discard_snapshot_state(&self, height: u64) -> IntegrationResult<()> {
        for cf in &["accounts_stage", "node_registry_stage", "pending_rewards_stage", "contract_storage_stage"] {
            let _ = self.clear_cf(cf);
        }
        if let Some(snapshots_cf) = self.persistent.db.cf_handle("snapshots") {
            for prefix in &["full_snap_", "state_snap_"] {
                let _ = self.persistent.db.delete_cf(&snapshots_cf, format!("{}{}", prefix, height).as_bytes());
            }
        }
        println!("[WARN][SYNC] snapshot_staging_dropped h={} action=degrade_to_replay", height);
        Ok(())
    }

    /// Promote a VERIFIED staged snapshot into live state, crash-atomically. Marker
    /// `promote_pending = [height(8)|anchor(32)]` is written first and cleared only after the copy +
    /// floor commit complete; a crash mid-copy re-runs idempotently from the intact staging on boot
    /// (recover_pending_snapshot_promote). The ONLY place a snapshot mutates live state.
    pub async fn promote_snapshot_staging(&self, height: u64, anchor_hash: [u8; 32]) -> IntegrationResult<()> {
        let meta = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;
        // A retried promote (boot recovery) must not overwrite live state on a node that has since
        // replayed past the snapshot height — set_chain_height below is not forward-only.
        let live_h = self.get_chain_height().map_err(|e| IntegrationError::StorageError(
            format!("promote_height_read_failed h={} err={:?}", height, e)))?;
        if live_h > height {
            let _ = self.persistent.db.delete_cf(&meta, b"promote_pending");
            let _ = self.discard_snapshot_state(height);
            return Err(IntegrationError::StorageError(format!(
                "promote_refused_regress snapshot_h={} live_h={}", height, live_h)));
        }
        let mut marker = height.to_le_bytes().to_vec();
        marker.extend_from_slice(&anchor_hash);
        self.persistent.db.put_cf(&meta, b"promote_pending", &marker)?;

        // Epoch reward roots: PROVE before anything destructive runs. Their macroblocks sit below
        // this node's weak-subjectivity floor and can never be re-fetched, so they must be carried —
        // but a forged set must fail while live state is still intact and the retry can start clean.
        if let Err(e) = self.carry_and_verify_epoch_roots(height) {
            // Nothing destructive has run yet, so drop the retry token and let the snapshot path
            // start clean. Every failure AFTER this point keeps the marker on purpose.
            let _ = self.persistent.db.delete_cf(&meta, b"promote_pending");
            let _ = self.discard_snapshot_state(height);
            return Err(e);
        }

        // Swap staging→live for the CONSENSUS-BOUND CFs only: accounts (state_root) + node_registry
        // (registry_root). The binder verified exactly these against the 2f+1 anchor.
        for (stage, live) in [("accounts_stage", "accounts"), ("node_registry_stage", "node_registry")] {
            self.clear_cf(live)?;
            let (s, l) = match (self.persistent.db.cf_handle(stage), self.persistent.db.cf_handle(live)) {
                (Some(s), Some(l)) => (s, l),
                _ => continue,
            };
            let mut batch = WriteBatch::default();
            let mut n = 0u64;
            let mut dropped = 0u64;
            for item in self.persistent.db.iterator_cf(&s, rocksdb::IteratorMode::Start) {
                let (k, v) = item?;
                // WHITELIST. registry_root folds only srtr_/lrtr_ -> node_<id>, so every OTHER prefix in
                // this section is unbound peer data. `vrf_pk_` is the worst: it is the key verify_qc and
                // vote_sig_compact_ok resolve against, and the immutable-once-stamped rule makes a
                // poisoned row permanent.
                //
                // vrf_pk_ is admitted only when it matches the COVERED commitment node_<id>.vrf_pk_sha3
                // — the hash cannot yield the key, so the key must be carried, but it can be bound.
                // Everything else is dropped and re-derived locally after promote.
                if live == "node_registry" && !Self::registry_key_is_root_covered(&k) {
                    let bound = k.strip_prefix(b"vrf_pk_".as_ref())
                        .and_then(|id| std::str::from_utf8(id).ok())
                        .map(|id| Self::staged_vrf_pk_matches_commitment(&self.persistent.db, &s, id, &v))
                        .unwrap_or(false);
                    if !bound { dropped += 1; continue; }
                }
                batch.put_cf(&l, &k, &v);
                n += 1;
                if n % 10_000 == 0 { self.persistent.db.write(std::mem::take(&mut batch))?; }
            }
            self.persistent.db.write(batch)?;
            if dropped > 0 {
                println!("[WARN][SNAPSHOT] registry_rows_dropped={} reason=not_covered_by_registry_root", dropped);
            }
        }
        self.clear_cf("contract_storage")?;
        self.rebuild_contract_storage_from_accounts()?;
        // Derived indices over the now-live registry (byte-identical to a from-genesis node at this
        // height). Propagate errors BEFORE committing height/floors/marker-delete: a failed rebuild must
        // NOT finalize the anchor with a stale cbw/registry_lthash (silent fork). On Err the marker +
        // staging survive, so recover_pending_snapshot_promote retries on next boot.
        self.backfill_roster_indices()?;
        self.rebuild_committed_burn_wallet(height)?;
        self.rebuild_registry_lthash(height)?;
        // FIX-5: dilithium_pk_root LtHash from the promoted live accounts — same fail-closed discipline
        // as cbw/registry (Err leaves staging + marker so the promote retries, never finalizes stale).
        self.rebuild_dilithium_pk_lthash()?;
        // Prove the carried epoch roots against the anchor's 2f+1-certified commitment. Fail-closed
        // like the rebuilds above: on mismatch the marker + staging survive and the promote retries,
        // so a snapshot server cannot hand this node roots the committee never signed.
        // Rich-list index is display-only and NOT snapshot-verified: clear any promoted/inherited rows
        // + the build marker so the joiner never serves a peer-supplied (possibly forged) rich list.
        // The boot rebuild then re-derives it locally from the verified accounts.
        let _ = self.richlist_clear();
        // Wallet→token reverse index (NON-consensus): rebuild from the freshly promoted accounts so a
        // cold-joined node serves per-wallet token lists in O(held). Best-effort — a failure must never
        // wedge the consensus-critical promote. Mark dirty FIRST (drops OWNS_INDEX_READY + clears the
        // build marker) so that if the rebuild Errs — or we crash mid-rebuild — the emptied CF is NEVER
        // left authoritative: the reader falls back to the O(N) scan and the NEXT boot re-runs the
        // backfill. backfill_owns_indices re-asserts READY on success; the marker is set ONLY then.
        self.mark_owns_index_dirty();
        let _ = self.clear_cf("wallet_token");
        if self.backfill_owns_indices().is_ok() { let _ = self.set_owns_index_built(height); }
        // Commit height + finality/WS floors + durable anchor (adopt_snapshot_finality persists it).
        self.set_chain_height(height)?;
        crate::node::adopt_snapshot_finality(height, anchor_hash);
        // Advertise the verified blob so this node can serve the snapshot it joined from.
        if let Some(snaps) = self.persistent.db.cf_handle("snapshots") {
            let _ = self.persistent.db.put_cf(&snaps, b"latest_full_snap", &height.to_le_bytes());
        }
        self.persistent.db.delete_cf(&meta, b"promote_pending")?;
        // Clear staging CFs ONLY (keep the blob for serving).
        for cf in &["accounts_stage", "node_registry_stage", "pending_rewards_stage", "contract_storage_stage"] {
            let _ = self.clear_cf(cf);
        }
        println!("[INFO][SYNC] snapshot_promoted h={} anchor_mb={}", height, height / 90);
        Ok(())
    }

    /// Boot recovery: if a promote was interrupted, the marker is still present and staging is intact —
    /// re-run the promote idempotently. On failure clear staging + marker and fall to block replay.
    /// `state`: when present (main boot path) the in-mem StateManager is rehydrated from the promoted
    /// CFs after a successful promote — same fail-closed semantics as the live cold-join. The boot
    /// TIER-1 restore runs BEFORE this recovery (no promoted state yet), so it would NOT rehydrate the
    /// recovered snapshot; doing it here closes that gap.
    pub async fn recover_pending_snapshot_promote(
        &self,
        state: Option<&std::sync::Arc<tokio::sync::RwLock<crate::StateManager>>>,
    ) {
        let meta = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return };
        let bytes = match self.persistent.db.get_cf(&meta, b"promote_pending") {
            Ok(Some(b)) if b.len() == 40 => b,
            _ => return,
        };
        let height = u64::from_le_bytes(bytes[..8].try_into().unwrap_or([0u8; 8]));
        let mut anchor = [0u8; 32];
        anchor.copy_from_slice(&bytes[8..40]);
        println!("[WARN][SYNC] promote_recovery h={} replay=staged", height);
        if let Err(e) = self.promote_snapshot_staging(height, anchor).await {
            // Keep the marker AND staging: this failure may have landed after live accounts were
            // already replaced, and they are the only state that can finish the job. A
            // pre-destructive failure has already cleared both inside promote, so nothing latches
            // that should not.
            println!("[ERR][SYNC] promote_recovery_failed h={} err={} action=retry_next_boot", height, e);
            return;
        }
        // Rehydrate the in-mem state from the recovered CFs (fail-closed). On mismatch the helper
        // clears the in-mem state; block replay from the promoted chain_height then rebuilds it.
        if let Some(state) = state {
            if let Err(e) = self.rehydrate_inmem_state_from_promoted_cf(state, height).await {
                println!("[WARN][SYNC] promote_recovery_rehydrate_failed h={} err={} action=block_replay", height, e);
            }
        }
    }

    /// Query peer for available snapshots
    async fn query_peer_snapshot(&self, peer_addr: &str, max_height: u64) -> IntegrationResult<Option<(u64, String)>> {
        // Ask for the highest snapshot ≤ our exogenously-verifiable ceiling (not just the peer's latest,
        // which may be above our pin and therefore unverifiable cold).
        let url = format!("http://{}/api/v1/snapshot/latest?max_height={}", peer_addr, max_height);
        
        match reqwest::get(&url).await {
            Ok(response) => {
                if response.status().is_success() {
                    let data: serde_json::Value = response.json().await
                        .map_err(|e| IntegrationError::Other(format!("JSON error: {}", e)))?;
                    
                    if let (Some(height), Some(cid)) = (
                        data["height"].as_u64(),
                        data["ipfs_cid"].as_str()
                    ) {
                        // A peer with no snapshot answers height=0/available:false — it is NOT a target.
                        // Treating it as Some((0,…)) let the quorum picker resolve target=0 → a phantom
                        // h=0 download. Exclude it from negotiation entirely.
                        if height == 0 { return Ok(None); }
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
    // v32.10: hard bounds on untrusted manifest fields. Prevents OOM DoS via
    // forged total_size / chunk_count from byzantine peer.
    const MAX_SNAPSHOT_SIZE: u64 = 100 * 1024 * 1024 * 1024; // 100 GB
    const MAX_CHUNK_COUNT: u64 = 100_000; // 100k × 4MB = 400GB max

    /// v32.10: deterministic SHA3-256 over canonical manifest bytes.
    /// Used by producer to commit into MacroBlock.snapshot_manifest_hash, and
    /// by joiner to verify fetched manifest matches the 2f+1-bound value.
    pub fn compute_manifest_hash(manifest: &SnapshotManifest) -> [u8; 32] {
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(b"QNET_SNAPSHOT_MANIFEST_V1:");
        hasher.update(&manifest.height.to_le_bytes());
        hasher.update(&manifest.total_size.to_le_bytes());
        hasher.update(&manifest.chunk_size.to_le_bytes());
        hasher.update(&manifest.chunk_count.to_le_bytes());
        hasher.update(&(manifest.chunk_hashes.len() as u64).to_le_bytes());
        for h in &manifest.chunk_hashes {
            hasher.update(&(h.len() as u32).to_le_bytes());
            hasher.update(h.as_bytes());
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&hasher.finalize());
        out
    }

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
    pub async fn download_snapshot_chunked(
        &self,
        p2p: &crate::unified_p2p::SimplifiedP2P,
        peer_addrs: &[String],
        height: u64,
    ) -> IntegrationResult<()> {
        if peer_addrs.is_empty() {
            return Err(IntegrationError::Other("No peers for chunked download".to_string()));
        }
        let start_time = std::time::Instant::now();

        // The manifest is NOT consensus-bound and cannot be: whether a node holds a snapshot at a
        // boundary is node-local, so committing its digest would split the macroblock body. The binder
        // is Pattern C — the staged accounts merkle recomputed against the QC-certified mb.state_root,
        // plus the registry-CF check — which runs after assembly. Everything read from the manifest
        // before that point is therefore treated as hostile and bounds-checked below.

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
                return self.download_snapshot_legacy(p2p, &peer_addrs[0], height).await;
            }
        };

        // v32.10: untrusted-input bounds. Reject before allocation.
        if manifest.total_size > Self::MAX_SNAPSHOT_SIZE {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] manifest_rejected reason=total_size_overflow h={} got={} max={}",
                         height, manifest.total_size, Self::MAX_SNAPSHOT_SIZE);
            }
            return Err(IntegrationError::Other(format!(
                "manifest_total_size_exceeds_max h={} got={} max={}",
                height, manifest.total_size, Self::MAX_SNAPSHOT_SIZE
            )));
        }
        if manifest.chunk_count == 0 || manifest.chunk_count > Self::MAX_CHUNK_COUNT {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] manifest_rejected reason=chunk_count_invalid h={} got={} max={}",
                         height, manifest.chunk_count, Self::MAX_CHUNK_COUNT);
            }
            return Err(IntegrationError::Other(format!(
                "manifest_chunk_count_invalid h={} got={}", height, manifest.chunk_count
            )));
        }
        if manifest.chunk_size != Self::SNAPSHOT_CHUNK_SIZE as u64 {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] manifest_rejected reason=chunk_size_mismatch h={} got={} expected={}",
                         height, manifest.chunk_size, Self::SNAPSHOT_CHUNK_SIZE);
            }
            return Err(IntegrationError::Other(format!(
                "manifest_chunk_size_mismatch h={} got={} expected={}",
                height, manifest.chunk_size, Self::SNAPSHOT_CHUNK_SIZE
            )));
        }
        // Shape, not just count: these strings are peer-supplied and are byte-sliced when a chunk
        // mismatches, so a short one would panic the process (`panic = "abort"`).
        if let Some(bad) = manifest.chunk_hashes.iter()
            .position(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit())) {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] manifest_rejected reason=chunk_hash_malformed h={} idx={}", height, bad);
            }
            return Err(IntegrationError::Other(format!(
                "manifest_chunk_hash_malformed h={} idx={}", height, bad
            )));
        }
        if manifest.chunk_hashes.len() as u64 != manifest.chunk_count {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] manifest_rejected reason=hashes_len_mismatch h={} hashes={} count={}",
                         height, manifest.chunk_hashes.len(), manifest.chunk_count);
            }
            return Err(IntegrationError::Other(format!(
                "manifest_hashes_count_mismatch h={} hashes={} count={}",
                height, manifest.chunk_hashes.len(), manifest.chunk_count
            )));
        }
        // Consistency: total_size must fit exactly in chunk_count × chunk_size.
        let expected_chunks = (manifest.total_size + manifest.chunk_size - 1) / manifest.chunk_size;
        if expected_chunks != manifest.chunk_count {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] manifest_rejected reason=size_count_inconsistent h={} expected_chunks={} got={}",
                         height, expected_chunks, manifest.chunk_count);
            }
            return Err(IntegrationError::Other(format!(
                "manifest_size_count_inconsistent h={} expected_chunks={} got={}",
                height, expected_chunks, manifest.chunk_count
            )));
        }

        println!("[INFO][SYNC] chunked_download_start h={} chunks={} total={}MB",
                 height, manifest.chunk_count, manifest.total_size / (1024 * 1024));

        // Step 2: Download chunks in parallel (round-robin across peers)
        let chunk_count = manifest.chunk_count as usize;
        // Fallible: total_size is peer-supplied and the infallible `vec![0u8; n]` aborts the process on
        // an allocation the host cannot satisfy. On refusal fall through to block replay.
        let mut assembled: Vec<u8> = Vec::new();
        assembled.try_reserve_exact(manifest.total_size as usize).map_err(|_| {
            IntegrationError::Other(format!(
                "manifest_alloc_refused h={} total_size={}", height, manifest.total_size))
        })?;
        assembled.resize(manifest.total_size as usize, 0u8);
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
            // The manifest fixes every chunk's length. A peer-supplied blob of any other size slices
            // out of bounds or mismatches copy_from_slice, and `panic = abort` turns that into a
            // remote node kill — so reject it as data instead of trusting the length.
            let expected_len = assembled.len().saturating_sub(start).min(chunk_size);
            if start >= assembled.len() || chunk_data.len() != expected_len {
                return Err(IntegrationError::Other(format!(
                    "snapshot_chunk_bad_len h={} idx={} got={} want={}",
                    height, i, chunk_data.len(), expected_len
                )));
            }
            assembled[start..start + expected_len].copy_from_slice(&chunk_data);
        }

        // Step 4: Save assembled snapshot to DB
        {
            let snapshots_cf = self.persistent.db.cf_handle("snapshots")
                .ok_or_else(|| IntegrationError::StorageError("snapshots CF not found".to_string()))?;
            let key = format!("full_snap_{}", height);
            self.persistent.db.put_cf(&snapshots_cf, key.as_bytes(), &assembled)?;
        }

        self.load_state_snapshot(height, true).await?;

        let elapsed = start_time.elapsed();
        println!("[INFO][SYNC] chunked_download_done h={} chunks={} total={}MB elapsed={:.1}s",
                 height, chunk_count, manifest.total_size / (1024 * 1024), elapsed.as_secs_f64());
        Ok(())
    }

    /// Legacy single-request snapshot download (backward compatibility)
    async fn download_snapshot_legacy(
        &self,
        _p2p: &crate::unified_p2p::SimplifiedP2P,
        peer_addr: &str,
        height: u64,
    ) -> IntegrationResult<()> {
        // v32.10: legacy path serves single blob (no manifest). Total_size DoS
        // not applicable — reqwest body has its own decode limits. Pattern C
        // verification at caller catches forged state regardless.
        let url = format!("http://{}/api/v1/snapshot/{}", peer_addr, height);
        let response = reqwest::get(&url).await
            .map_err(|e| IntegrationError::Other(format!("Download error: {}", e)))?;
        if !response.status().is_success() {
            return Err(IntegrationError::Other("Snapshot download failed".to_string()));
        }
        let data = response.bytes().await
            .map_err(|e| IntegrationError::Other(format!("Download error: {}", e)))?;
        // Defense: a peer with no snapshot may answer 200 with a JSON error body. The real frame is
        // [sha3(32)|len(8)|zstd]; reject anything shorter than the 41-byte header or that looks like
        // JSON, so an error body is never stored as full_snap_ and then fails the integrity check.
        if data.len() < 41 || data.first() == Some(&b'{') {
            return Err(IntegrationError::Other(format!(
                "legacy_snapshot_not_binary h={} len={}", height, data.len()
            )));
        }
        // Defense: cap legacy blob size at MAX_SNAPSHOT_SIZE.
        if data.len() as u64 > Self::MAX_SNAPSHOT_SIZE {
            return Err(IntegrationError::Other(format!(
                "legacy_snapshot_oversize h={} got={} max={}",
                height, data.len(), Self::MAX_SNAPSHOT_SIZE
            )));
        }
        {
            let snapshots_cf = self.persistent.db.cf_handle("snapshots")
                .ok_or_else(|| IntegrationError::StorageError("snapshots CF not found".to_string()))?;
            let key = format!("full_snap_{}", height);
            self.persistent.db.put_cf(&snapshots_cf, key.as_bytes(), &data)?;
        }
        self.load_state_snapshot(height, true).await?;
        if crate::node::is_info() {
            println!("[INFO][SYNC] legacy_snapshot_applied h={}", height);
        }
        Ok(())
    }

    /// Download snapshot — tries chunked first, falls back to legacy
    #[allow(dead_code)]
    async fn download_snapshot_from_peer(
        &self,
        p2p: &crate::unified_p2p::SimplifiedP2P,
        peer_addr: &str,
        height: u64,
    ) -> IntegrationResult<()> {
        self.download_snapshot_chunked(p2p, &[peer_addr.to_string()], height).await
    }

    /// Fast sync with snapshot for new nodes
    pub async fn fast_sync_with_snapshot(
        &self,
        p2p: &crate::unified_p2p::SimplifiedP2P,
        target_height: u64,
        state: &std::sync::Arc<tokio::sync::RwLock<crate::StateManager>>,
    ) -> IntegrationResult<()> {
        println!("[INFO][STORAGE] fast_sync_start target_height={}", target_height);

        // Light nodes do not perform fast-sync at all — they are pure
        // mobile API clients with zero on-device chain storage. All
        // chain reads happen via the Super-node REST API at request
        // time, so there is nothing to download here.
        if self.storage_mode == StorageMode::Light {
            println!("[INFO][STORAGE] fast_sync_skipped role=light_api_client");
            return Ok(());
        }

        // Try to find and load a snapshot
        match self.download_and_load_snapshot(p2p).await {
            Ok(snapshot_height) => {
                println!("[INFO][STORAGE] snapshot_loaded height={}", snapshot_height);

                // Derived consensus/reward indices (registry_root LtHash, cbw, roster) and the vrf_pk
                // completeness contract were materialized + checked inside verify_snapshot_consensus_binding
                // BEFORE the WS floor was adopted (fail-closed there, atomic with floor adoption), so by
                // here the snapshot is fully consistent and forward-ready.
                println!("[INFO][STORAGE] snapshot_indices_rebuilt h={}", snapshot_height);

                // CRITICAL: promote only swapped the on-disk CFs. The in-mem StateManager (merkle +
                // accounts DashMap) the apply pipeline reads is still empty — without rehydrating it the
                // first tail block (anchor+1) computes a near-empty state_root → state_root_mismatch →
                // rollback → apply circuit-breaker wedge. Fail-closed: on any rehydrate failure return
                // Err so the caller falls back to block-sync from a clean base.
                if let Err(e) = self.rehydrate_inmem_state_from_promoted_cf(state, snapshot_height).await {
                    // Rehydrate rejected the promoted snapshot (state_root mismatch) and cleared in-mem
                    // state. promote already advanced on-disk chain_height to the snapshot; reset it so
                    // the fallback block-sync restarts from genesis, not an orphaned mid-chain height.
                    let _ = self.reset_chain_height();
                    return Err(e);
                }

                if target_height > snapshot_height {
                    println!("[INFO][STORAGE] sync_remaining_start count={}",
                            target_height - snapshot_height);
                }
                Ok(())
            },
            Err(e) => {
                // AnchorPending is retryable (caller bails to the desync tick until the GALC pin arrives) —
                // not a failure, so don't emit the fallback warning for it.
                if !matches!(e, IntegrationError::AnchorPending) && crate::node::is_warn() {
                    println!("[WARN][STORAGE] snapshot_sync_failed err={:?} fallback=full_sync", e);
                }
                Err(e)
            }
        }
    }

    /// Cold-join: rehydrate the IN-MEM StateManager (merkle + accounts DashMap) from the just-promoted
    /// `accounts` CF, mirroring the boot TIER-1 restore (node.rs). promote_snapshot_staging only swaps
    /// the on-disk CFs; the apply pipeline reads this in-mem state, so without this the first tail block
    /// computes a near-empty state_root → mismatch → wedge. FAIL-CLOSED: if the rehydrated merkle does
    /// not match the anchor's 2f+1-bound state_root we clear the in-mem state and return Err so the
    /// caller falls back to block-replay from a clean base — never proceed with a mismatched state.
    pub async fn rehydrate_inmem_state_from_promoted_cf(
        &self,
        state: &std::sync::Arc<tokio::sync::RwLock<crate::StateManager>>,
        anchor_height: u64,
    ) -> IntegrationResult<()> {
        // OB1: block the apply pipeline from writing a tail block over the un-rehydrated (empty) in-mem
        // state for the whole rehydrate — including the synchronous macroblock read below, which can
        // stall under a compaction/flush storm and widen the adopt→rehydrate race. RAII clears on exit.
        struct RehydrateGuard;
        impl Drop for RehydrateGuard {
            fn drop(&mut self) { SNAPSHOT_REHYDRATE_IN_PROGRESS.store(false, Ordering::SeqCst); }
        }
        SNAPSHOT_REHYDRATE_IN_PROGRESS.store(true, Ordering::SeqCst);
        let _rehydrate_guard = RehydrateGuard;
        // Accounts are streamed row-by-row from the promoted CF into the merkle+DashMap below (no full
        // Vec materialization) — see the streaming restore after the anchor root/total_supply are read.
        // Emission watermark: highest emission macroblock already minted at/below the anchor. Derived
        // with the SAME formula the apply path uses (node.rs apply_block_to_state) so the rehydrated
        // node never re-mints an epoch the bound state already includes (>=2 epochs ⇒ double-mint).
        const EMISSION_BLOCK_INTERVAL: u64 = 14400;
        const MICROBLOCKS_PER_MB: u64 = 90;
        let current_epoch = anchor_height / EMISSION_BLOCK_INTERVAL;
        let last_minted_emission_mb = if current_epoch >= 2 {
            let rewarding_epoch = current_epoch.saturating_sub(2);
            rewarding_epoch.saturating_add(1).saturating_mul(EMISSION_BLOCK_INTERVAL) / MICROBLOCKS_PER_MB
        } else {
            0
        };

        // Anchor's committed state_root + QC-bound total_supply: the macroblock at anchor_height/90
        // carries BOTH — state_root directly (the SAME value verify_snapshot_consensus_binding checked
        // the staged accounts against) and total_supply via the embedded (Checkpoint, QC) in
        // consensus_data.checkpoint_qc. total_supply is in Checkpoint::hash() ⇒ qc.checkpoint_hash binds
        // it ⇒ 2f+1 certify it. We read this QC-bound value instead of summing balances: a balance sum
        // is correct ONLY pre-emission (epoch<2); at epoch>=2 emission mints supply credited later via
        // claim TXs, so minted>sum. total_supply is consensus-critical (emission cap) but NOT in
        // state_root (account-only), so it is bound separately here through the checkpoint.
        let mb_idx = anchor_height / MICROBLOCKS_PER_MB;
        let (anchor_state_root, total_supply): ([u8; 32], u64) = match self.get_macroblock_by_height(mb_idx)? {
            Some(bytes) => {
                let mb: qnet_state::MacroBlock = bincode::deserialize(&bytes)
                    .map_err(|e| IntegrationError::StorageError(format!("rehydrate_anchor_decode_fail {}", e)))?;
                // Extract the QC-bound total_supply from the embedded checkpoint. Pre-emission anchors
                // (epoch<2) MAY lack a checkpoint_qc (legacy/genesis) — fall back to the balance sum,
                // which is exact while minted==sum-of-balances.
                let ts = match &mb.consensus_data.checkpoint_qc {
                    // A PRESENT checkpoint_qc MUST decode — a corrupt QC is fail-closed (Err →
                    // block-replay), never a silent fall-back to a balance sum that is wrong post-emission.
                    Some(b) => {
                        let (cp, _) = bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint, qnet_consensus::checkpoint_bft::QuorumCertificate)>(b)
                            .map_err(|e| IntegrationError::StorageError(format!("rehydrate_checkpoint_decode_fail mb={} {}", mb_idx, e)))?;
                        cp.total_supply
                    }
                    // No checkpoint_qc ⇒ only legacy/genesis pre-emission anchors (epoch<2), where the
                    // balance sum is exact (minted==sum-of-balances). Streamed (O(1) RAM), not a Vec fold.
                    None => self.sum_all_account_balances()?,
                };
                (mb.state_root, ts)
            }
            None => {
                return Err(IntegrationError::StorageError(format!(
                    "rehydrate_anchor_missing mb={} h={}", mb_idx, anchor_height
                )));
            }
        };

        let sg = state.write().await;
        // STREAMING restore: feed the accounts CF row-by-row into the merkle + DashMap (no full Vec,
        // no double-hold — peak RAM drops from ~2x accounts to ~1x). A row that fails to decode is
        // skipped+logged; the resulting incompleteness trips the fail-closed merkle assert below
        // (clear + block-replay), so a corrupt row can never admit partial state.
        let cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let acct_iter = self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start).filter_map(|item| {
            let (k, v) = item.ok()?;
            let addr = String::from_utf8(k.to_vec()).ok()?;
            match bincode::deserialize::<qnet_state::Account>(&v) {
                Ok(a) => Some((addr, a)),
                Err(e) => { println!("[WARN][STATE] rehydrate_skip_corrupt_account err={}", e); None }
            }
        });
        // FAIL-CLOSED merkle assert BEFORE seeding chain_state — a mismatch then leaves no partial
        // chain_state to roll back (clear() resets accounts+merkle; chain_state was never mutated).
        // A mid-iteration failure leaves an arbitrary PREFIX of the snapshot in the accounts map, so
        // the Err path must wipe before returning — exactly as the mismatch branch below does.
        // Without it the caller falls back to a block replay on top of that prefix and applies every
        // credit in it a second time.
        let computed = match sg.restore_accounts_streamed(acct_iter) {
            Ok(root) => root,
            Err(e) => {
                sg.clear();
                return Err(IntegrationError::StorageError(format!("rehydrate_restore_fail {}", e)));
            }
        };
        if computed != anchor_state_root {
            println!("[ERR][STATE] rehydrate_merkle_mismatch expected={} computed={} action=clear_block_replay",
                     hex::encode(&anchor_state_root[..8]), hex::encode(&computed[..8]));
            sg.clear();
            return Err(IntegrationError::StorageError(format!(
                "rehydrate_merkle_mismatch h={} expected={} computed={}",
                anchor_height, hex::encode(&anchor_state_root[..8]), hex::encode(&computed[..8])
            )));
        }
        // Verified — seed chain_state now that the bound merkle is confirmed.
        {
            let mut cs = sg.chain_state.write();
            cs.height = anchor_height;
            cs.total_supply = total_supply;
            cs.last_minted_emission_mb = last_minted_emission_mb;
        }
        // Seal the anchor's total_supply so a cold-joiner can serve/verify the checkpoint at its anchor
        // head via get_total_supply_at (mirror of the registry_root seal carried through the binding).
        let _ = self.seal_total_supply(anchor_height, total_supply);
        // Rebuild the in-mem NodeRegistration-dedup map from the snapshot-bound node_registry CF (the CF
        // is bound by registry_root in the QC Checkpoint). restore_accounts seeds account leaves but NOT
        // this off-merkle map; without it a cold-joiner has an EMPTY registered_nodes for all reg_height<=
        // anchor entries, so a tail block with a duplicate NodeRegistration is admitted here (empty map ⇒
        // not "already registered") while from-genesis nodes reject it → registry_root divergence. Done
        // AFTER the fail-closed merkle assert so a rejected snapshot never seeds the map. Byte-identical
        // to a from-genesis node for all reg_height<=anchor bindings.
        self.reseed_commitment_dedup(&*sg)?;
        println!("[INFO][STATE] rehydrate_ok h={} root={} total_supply={} watermark_mb={}",
                 anchor_height, hex::encode(&anchor_state_root[..8]), total_supply, last_minted_emission_mb);
        Ok(())
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

    /// Receipt store: persist a block's captured WASM event logs for RPC `getLogs`.
    /// Keyed by height; value = bincode of `Vec<(tx_hash, contract_hex, data)>` in emit order.
    /// Not part of state_root, but the leaves feed the gate-0 `logs_root` consensus commitment
    /// (block_logs_root_of → collect_window_block_roots), so a persist/decode failure diverges this node's window logs_root.
    pub fn save_block_logs(&self, height: u64, logs: &[(String, String, Vec<u8>)]) -> IntegrationResult<()> {
        if logs.is_empty() { return Ok(()); }
        let key = format!("blocklogs_{:010}", height);
        let bytes = bincode::serialize(logs)
            .map_err(|e| IntegrationError::StorageError(format!("blocklogs serialize: {}", e)))?;
        self.persistent.save_raw(&key, &bytes)
    }

    /// Read one block's captured WASM logs (emit order), or empty if none. A decode failure is fail-safe
    /// (empty) but warns — it desyncs this node's consensus-committed logs_root.
    pub fn get_block_logs(&self, height: u64) -> Vec<(String, String, Vec<u8>)> {
        let key = format!("blocklogs_{:010}", height);
        match self.persistent.load_raw(&key) {
            Ok(Some(bytes)) => match bincode::deserialize(&bytes) {
                Ok(v) => v,
                Err(e) => {
                    if crate::node::is_warn() {
                        println!("[WARN][LOGS] block_logs_decode_failed h={} err={} (logs_root may diverge)", height, e);
                    }
                    Vec::new()
                }
            },
            _ => Vec::new(),
        }
    }

    /// Per-block logs SUB-ROOT (level 1 of the sharded logs commitment = `logs_merkle_root` over the
    /// block's log leaves). Written at apply so the macroblock seal folds ~90 sub-roots via
    /// `logs_window_root` (never a re-hash of the whole window), and a light-client `/logs/proof` reads
    /// ONE block's leaves + the sub-roots — both O(one block), not O(window). Absent ⇒ log-less block ([0;32]).
    pub fn save_block_logs_root(&self, height: u64, root: &[u8; 32]) -> IntegrationResult<()> {
        let key = format!("blocklogsroot_{:010}", height);
        self.persistent.save_raw(&key, root)
    }
    pub fn get_block_logs_root(&self, height: u64) -> Option<[u8; 32]> {
        let key = format!("blocklogsroot_{:010}", height);
        match self.persistent.load_raw(&key) {
            Ok(Some(bytes)) if bytes.len() == 32 => { let mut r = [0u8; 32]; r.copy_from_slice(&bytes); Some(r) }
            _ => None,
        }
    }

    // NOTE: contract WASM code + storage are NOT kept in a separate RocksDB namespace.
    // They live inside `Account.contract_storage` (the "code" key + hex data entries), so
    // they are part of the state-root-hashed account leaf and survive snapshot/restore for
    // free. The former `save_contract_code`/`get_contract_code` raw-KV helpers were dead
    // (never the real path) and have been removed.

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
    // vrf_proof contains PqSignature which includes:
    // - certificate: PqCertificate (~2.6KB)
    // - dilithium_key_signature (pure ML-DSA-65 after P8)
    //
    // For historical block validation:
    // 1. Load block from storage (already have vrf_proof)
    // 2. Extract certificate from vrf_proof
    // 3. Verify signature using extracted certificate
    //
    // This approach uses ZERO additional storage!
    // ═══════════════════════════════════════════════════════════════════════════
}

// AccountStore impl: read-through fallback the StateManager warm-cache pass
// calls on every cache miss. Thin error-swallowing wrapper — transient
// RocksDB error → None (caller treats as a miss), success → Account.
// Errors logged at INFO with the address truncated to 16 hex (privacy).
// One sync point read per cold address per block; the warm pass runs
// OUTSIDE the state-write lock (see block_pipeline.rs pre-warm site).
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

    fn persist_accounts(&self, accounts: &[(String, qnet_state::Account)]) -> bool {
        match self.persistent.persist_accounts_sync(accounts) {
            Ok(_) => true,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][CACHE] evict_persist_failed count={} err={:?}", accounts.len(), e);
                }
                false
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

// =========================================================================
// v32.9 Pattern C tests — canonical state root determinism and binding
// =========================================================================
#[cfg(test)]
mod v32_9_pattern_c_tests {
    use super::*;
    use tempfile::TempDir;

    fn open_test_storage() -> (Storage, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let storage = Storage::new(dir.path().to_str().unwrap())
            .expect("storage init");
        (storage, dir)
    }

    fn put_account(storage: &Storage, key: &[u8], value: &[u8]) {
        let cf = storage.persistent.db.cf_handle("accounts").expect("accounts CF");
        storage.persistent.db.put_cf(&cf, key, value).expect("put");
    }

    /// A macroblock carrying a QC, stored at `index`, so the strip sweep has something to find.
    fn put_macroblock_with_qc(storage: &Storage, index: u64, sigs: usize) {
        use qnet_consensus::checkpoint_bft::{Checkpoint, QuorumCertificate};
        let cp = Checkpoint {
            index,
            parent_qc: None,
            window_head_height: index * 90,
            window_mb_hashes: vec![[7u8; 32]],
            state_root: [0xab; 32],
            beacon: [0u8; 32],
            epoch_commitment: [0u8; 32],
            reward_root: [0u8; 32],
            registry_root: [0u8; 32],
            logs_root: [0u8; 32],
            dilithium_pk_root: [0u8; 32],
            reward_epoch_root: [0u8; 32],
            total_supply: 0,
            timestamp: 0,
            proposer: "super_0000".to_string(),
            proposer_sig: Vec::new(),
            recovery_anchor: None,
        };
        let qc = QuorumCertificate {
            checkpoint_hash: cp.hash(),
            index,
            signers: (0..sigs).map(|i| format!("super_{:04}", i)).collect(),
            sig_merkle_root: [0xcd; 32],
            sigs: (0..sigs).map(|i| vec![i as u8; 3309]).collect(),
        };
        let mut cd = qnet_state::ConsensusData::default();
        cd.checkpoint_qc = Some(bincode::serialize(&(cp, qc)).unwrap());
        let mb = qnet_state::MacroBlock::new(index * 90, 0, [0u8; 32], vec![[7u8; 32]], [1u8; 32], cd);
        let cf = storage.persistent.db.cf_handle("microblocks").expect("microblocks CF");
        storage.persistent.db
            .put_cf(&cf, format!("macroblock_{}", index).as_bytes(), bincode::serialize(&mb).unwrap())
            .expect("put");
    }

    fn load_mb(storage: &Storage, index: u64) -> qnet_state::MacroBlock {
        let cf = storage.persistent.db.cf_handle("microblocks").expect("microblocks CF");
        let raw = storage.persistent.db
            .get_cf(&cf, format!("macroblock_{}", index).as_bytes()).unwrap().expect("row");
        bincode::deserialize(&raw).expect("decode")
    }

    /// Signatures below the horizon go; the checkpoint half, the signer list and sig_merkle_root stay —
    /// they are what every stored reader and the RPC proof endpoint need. Above the horizon nothing is
    /// touched, or a cold joiner inside the walk budget could not verify.
    #[test]
    fn qc_sig_strip_drops_only_signatures_below_the_horizon() {
        let (storage, _dir) = open_test_storage();
        let retention = Storage::QC_SIG_RETENTION_MB;
        let tip_mb = retention + 100;
        storage.set_chain_height(tip_mb * 90).expect("height");
        put_macroblock_with_qc(&storage, 1, 4);          // far below the floor
        put_macroblock_with_qc(&storage, tip_mb - 1, 4); // inside the walk budget

        let before = load_mb(&storage, 1);
        let mut swept = 0u64;
        for _ in 0..8 { swept += storage.strip_macroblock_qc_sigs().expect("strip"); }
        assert_eq!(swept, 1, "exactly the one macroblock below the floor is rewritten");

        let after = load_mb(&storage, 1);
        assert!(!Storage::macroblock_carries_qc_sigs(&after), "signatures gone below the floor");
        assert_eq!(after.hash(), before.hash(),
                   "MacroBlock::hash() excludes consensus_data, so stripping must move no hash");
        let (cp, qc): (qnet_consensus::checkpoint_bft::Checkpoint,
                       qnet_consensus::checkpoint_bft::QuorumCertificate) =
            bincode::deserialize(after.consensus_data.checkpoint_qc.as_ref().unwrap()).expect("decode");
        assert_eq!(cp.state_root, [0xab; 32], "the checkpoint half every stored reader uses survives");
        assert_eq!(cp.hash(), qc.checkpoint_hash, "the QC still binds its checkpoint");
        assert_eq!(qc.signers.len(), 4, "signers stay: the proof endpoint resolves keys from them");
        assert_eq!(qc.sig_merkle_root, [0xcd; 32], "the removed set is still committed");

        assert!(Storage::macroblock_carries_qc_sigs(&load_mb(&storage, tip_mb - 1)),
                "a macroblock inside the walk budget keeps its signatures");
    }

    /// The sweep is monotone: re-running it costs nothing and rewrites nothing, so the hourly cadence
    /// cannot re-serialize the whole archive every pass.
    #[test]
    fn qc_sig_strip_is_monotone_and_idempotent() {
        let (storage, _dir) = open_test_storage();
        let tip_mb = Storage::QC_SIG_RETENTION_MB + 10;
        storage.set_chain_height(tip_mb * 90).expect("height");
        put_macroblock_with_qc(&storage, 2, 3);
        let mut first = 0u64;
        for _ in 0..8 { first += storage.strip_macroblock_qc_sigs().expect("strip"); }
        assert_eq!(first, 1);
        for _ in 0..8 {
            assert_eq!(storage.strip_macroblock_qc_sigs().expect("strip"), 0,
                       "a swept range is never revisited");
        }
    }

    /// A young chain has nothing outside the walk budget — the sweep must be a no-op, not a wipe.
    #[test]
    fn qc_sig_strip_is_inert_before_the_horizon() {
        let (storage, _dir) = open_test_storage();
        storage.set_chain_height(90 * 100).expect("height");
        put_macroblock_with_qc(&storage, 1, 3);
        assert_eq!(storage.strip_macroblock_qc_sigs().expect("strip"), 0);
        assert!(Storage::macroblock_carries_qc_sigs(&load_mb(&storage, 1)));
    }

    #[test]
    fn canonical_root_is_deterministic() {
        let (storage, _dir) = open_test_storage();
        put_account(&storage, b"acct_aaa", b"v1");
        put_account(&storage, b"acct_bbb", b"v2");
        put_account(&storage, b"acct_ccc", b"v3");
        let r1 = storage.compute_canonical_state_root(90).expect("r1");
        let r2 = storage.compute_canonical_state_root(90).expect("r2");
        assert_eq!(r1, r2, "compute_canonical_state_root must be deterministic");
    }

    #[test]
    fn canonical_root_changes_on_state_mutation() {
        let (storage, _dir) = open_test_storage();
        put_account(&storage, b"acct_aaa", b"v1");
        let before = storage.compute_canonical_state_root(90).expect("before");
        put_account(&storage, b"acct_bbb", b"v2");
        let after = storage.compute_canonical_state_root(90).expect("after");
        assert_ne!(before, after, "root must change when accounts CF mutates");
    }

    #[test]
    fn richlist_index_matches_sorted_holders() {
        let (storage, _dir) = open_test_storage();
        // Small holder set; a tie (alice/bob both 500) exercises the address-ascending tiebreak.
        let set: Vec<(String, u64)> = vec![
            ("addr_charlie".to_string(), 300),
            ("addr_alice".to_string(),   500),
            ("addr_bob".to_string(),     500),
            ("addr_dave".to_string(),    100),
        ];
        let updates: Vec<(String, Option<u64>)> =
            set.iter().map(|(a, b)| (a.clone(), Some(*b))).collect();
        storage.richlist_reconcile(&updates).expect("reconcile");

        // Expected order: balance desc, then address asc on ties.
        let mut expected = set.clone();
        expected.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

        assert_eq!(storage.richlist_top_k(10).expect("top_k"), expected,
            "top_k must be balance-desc, address-asc");
        assert_eq!(storage.richlist_holder_count(), expected.len() as u64,
            "holder_count must equal the holder total");

        // Removal (None) drops a holder and decrements the count.
        storage.richlist_reconcile(&[("addr_bob".to_string(), None)]).expect("remove");
        let after_rm = storage.richlist_top_k(10).expect("top_k after remove");
        assert!(!after_rm.iter().any(|(a, _)| a == "addr_bob"), "removed holder must be gone");
        assert_eq!(storage.richlist_holder_count(), (expected.len() - 1) as u64);

        // Balance update re-sorts: dave 100 -> 1000 becomes the top holder.
        storage.richlist_reconcile(&[("addr_dave".to_string(), Some(1000))]).expect("update");
        assert_eq!(storage.richlist_top_k(1).expect("top_k updated"),
            vec![("addr_dave".to_string(), 1000)], "updated top holder must lead");
    }

    #[test]
    fn rocks_merkle_store_honors_contract() {
        // Phase C fork-guard: the RocksDB MerkleNodeStore must honor put_batch
        // semantics on a REAL DB — leaf_dels remove exactly one leaf, and a
        // wipe_all_nodes rebuild drops the ENTIRE old node set (no orphan survives).
        let (storage, _dir) = open_test_storage();
        let store = storage.merkle_node_store();

        let k1 = [1u8; 32];
        let k2 = [2u8; 32];
        let k3 = [3u8; 32];
        let v = |b: u8| [b; 32];

        // Seed three leaves.
        store.put_batch(
            &[(k1, v(11)), (k2, v(22)), (k3, v(33))],
            &[], &[], &[], false,
        ).expect("seed leaves");
        assert_eq!(store.get_leaf(&k2), Some(v(22)));
        assert_eq!(store.all_leaves().len(), 3);

        // Delete one leaf via leaf_dels.
        store.put_batch(&[], &[k2], &[], &[], false).expect("del leaf");
        assert_eq!(store.get_leaf(&k2), None, "deleted leaf must be absent");
        assert!(!store.all_leaves().iter().any(|(k, _)| *k == k2),
            "all_leaves must not contain the deleted leaf");
        assert_eq!(store.all_leaves().len(), 2);

        // Seed an OLD node set at two depths.
        let na = [0xAAu8; 32];
        let nb = [0xBBu8; 32];
        store.put_batch(
            &[], &[],
            &[((0, na), v(1)), ((5, nb), v(2))],
            &[], false,
        ).expect("seed nodes");
        assert_eq!(store.get_node(0, &na), Some(v(1)));
        assert_eq!(store.get_node(5, &nb), Some(v(2)));

        // Full rebuild carrying a DIFFERENT node set — old nodes must vanish.
        let nc = [0xCCu8; 32];
        store.put_batch(
            &[], &[],
            &[((7, nc), v(9))],
            &[], true, // wipe_all_nodes
        ).expect("rebuild nodes");
        assert_eq!(store.get_node(0, &na), None, "old node must be wiped on rebuild");
        assert_eq!(store.get_node(5, &nb), None, "old node must be wiped on rebuild");
        assert_eq!(store.get_node(7, &nc), Some(v(9)), "only the new node set survives");

        // Leaves are never wiped by a node rebuild.
        assert_eq!(store.get_leaf(&k1), Some(v(11)));
        assert_eq!(store.get_leaf(&k3), Some(v(33)));
    }

    #[test]
    fn super_eligible_index_roundtrips_sorted_and_epoch_isolated() {
        // R6: the apply-time super-eligibility index must return EXACTLY the saved node set, sorted
        // by node_id, deduped, epoch-isolated — so every node recomputes the same reward_root
        // (the split sorts internally ⇒ set-equality is what matters).
        let (storage, _dir) = open_test_storage();
        storage.save_super_eligible(160, "node_c").unwrap();
        storage.save_super_eligible(160, "node_a").unwrap();
        storage.save_super_eligible(160, "node_b").unwrap();
        storage.save_super_eligible(160, "node_a").unwrap(); // idempotent re-save
        storage.save_super_eligible(1600, "node_z").unwrap(); // different epoch (prefix-collision check)
        let e160 = storage.load_super_eligible(160).unwrap();
        assert_eq!(e160.iter().map(|s| s.as_str()).collect::<Vec<_>>(), vec!["node_a", "node_b", "node_c"]);
        assert!(!e160.iter().any(|n| n == "node_z"), "epoch 160 must not pick up epoch 1600 keys");
        assert_eq!(storage.load_super_eligible(1600).unwrap().iter().map(|s| s.as_str()).collect::<Vec<_>>(), vec!["node_z"]);
        assert!(storage.load_super_eligible(161).unwrap().is_empty(), "empty epoch → empty set");
    }

    #[test]
    fn light_bitmap_index_first_write_wins_and_epoch_isolated() {
        // FIRST-write-wins (was last): the stored value must not depend on the apply verdict, which
        // a non-durable dedup map decides — a restarted node would otherwise resolve a different
        // bitmap for the epoch and fork reward_root.
        let (storage, _dir) = open_test_storage();
        storage.save_light_bitmap(160, 0, 10, &[0b0001]).unwrap();
        storage.save_light_bitmap(160, 0, 11, &[0b1010]).unwrap(); // ignored
        storage.save_light_bitmap(160, 2, 12, &[0b1111]).unwrap();
        storage.save_light_bitmap(1600, 0, 13, &[0b0101]).unwrap();
        let bm = storage.load_light_bitmaps(160).unwrap();
        assert_eq!(bm.get(&0).map(|v| v.as_slice()), Some(&[0b0001u8][..]), "first write wins");
        assert_eq!(bm.get(&2).map(|v| v.as_slice()), Some(&[0b1111u8][..]));
        assert!(!bm.contains_key(&1), "only written genesis indices present");
        assert!(storage.load_light_bitmaps(1600).unwrap().contains_key(&0));
        assert!(storage.load_light_bitmaps(161).unwrap().is_empty());
    }

    #[test]
    fn reorg_reconcile_clears_orphan_indices_by_stamped_height() {
        // light_bm_ carries its inclusion height, so the reconcile deletes EXACTLY the rows written
        // above the rollback target — required now that the write is first-write-wins, since a
        // stranded orphan would never be overwritten by the canonical re-commit.
        // super_elig_ has no stamp and stays epoch-bounded (its from_epoch entry is always an orphan).
        let (storage, _dir) = open_test_storage();
        let rollback_to = 5 * 14400 + 100;
        for e in [4u64, 5, 6] {
            storage.save_super_eligible(e, "super_a").unwrap();
            let cf = storage.persistent.db.cf_handle("pending_rewards").unwrap();
            storage.persistent.db.put_cf(&cf, format!("light_elig_{:010}_lx", e).as_bytes(), &[]).unwrap();
        }
        storage.save_light_bitmap(4, 0, 4 * 14400 + 10, &[0b1]).unwrap();      // below target: keep
        storage.save_light_bitmap(5, 0, rollback_to - 50, &[0b1]).unwrap();    // below target: keep
        storage.save_light_bitmap(6, 0, rollback_to + 500, &[0b1]).unwrap();   // above target: orphan
        let cleared = storage.reconcile_reward_indices_above_epoch(rollback_to).unwrap();
        assert_eq!(cleared, 3, "super_elig_ epochs 5+6 plus the one orphan bitmap");
        assert!(storage.load_light_bitmaps(4).unwrap().contains_key(&0), "epoch 4 bitmap preserved");
        assert!(storage.load_light_bitmaps(5).unwrap().contains_key(&0), "below-target bitmap preserved");
        assert!(storage.load_light_bitmaps(6).unwrap().is_empty(), "above-target bitmap cleared");
        assert_eq!(storage.load_super_eligible(4).unwrap(), vec!["super_a".to_string()], "epoch 4 super_elig_ preserved");
        assert!(storage.load_super_eligible(5).unwrap().is_empty(), "epoch 5 super_elig_ cleared");
        assert!(storage.load_light_bitmaps(5).unwrap().contains_key(&0), "epoch 5 light_bm_ preserved (current epoch)");
        // Epoch 6 = strictly future: both cleared.
        assert!(storage.load_super_eligible(6).unwrap().is_empty(), "epoch 6 super_elig_ cleared");
        assert!(storage.load_light_bitmaps(6).unwrap().is_empty(), "epoch 6 light_bm_ cleared");
        // light_elig_ untouched for every epoch (recency index is out of reconcile scope).
        let cf = storage.persistent.db.cf_handle("pending_rewards").unwrap();
        for e in [4u64, 5, 6] {
            assert!(storage.persistent.db.get_cf(&cf, format!("light_elig_{:010}_lx", e).as_bytes()).unwrap().is_some(),
                    "epoch {} light_elig_ must be untouched", e);
        }
    }

    #[test]
    fn seal_watermark_is_reader_derived_and_race_immune() {
        // The contiguous seal watermark drives production backpressure; it must equal the largest F
        // with macroblock_1..F all present, be derived by the READER (not a racy writer RMW), skip
        // holes, heal when a hole fills, and recover from a frozen hint — the exact lost-update state
        // two concurrent save_macroblock writers (BFT seal + P2P sync ingest) could otherwise leave.
        let (storage, _dir) = open_test_storage();
        let db = storage.persistent.db.clone();
        let micro = db.cf_handle("microblocks").expect("microblocks CF");
        let meta = db.cf_handle("metadata").expect("metadata CF");
        let put_body = |n: u64| db.put_cf(&micro, format!("macroblock_{}", n).as_bytes(), b"b").unwrap();
        let hint = || db.get_cf(&meta, b"last_sealed_mb").unwrap()
            .map(|v| { let mut b = [0u8; 8]; b.copy_from_slice(&v[..8]); u64::from_le_bytes(b) });

        assert_eq!(storage.last_sealed_mb_index(), 0, "no macroblocks → 0");

        // Contiguous 1..3 → frontier 3, hint read-repaired.
        for n in 1..=3 { put_body(n); }
        assert_eq!(storage.last_sealed_mb_index(), 3);
        assert_eq!(hint(), Some(3), "reader read-repairs the persisted hint");

        // Hole at 4 (body 5 present) → conservative stop at 3, hint unchanged.
        put_body(5);
        assert_eq!(storage.last_sealed_mb_index(), 3, "a hole below the tip never advances the watermark");
        assert_eq!(hint(), Some(3));

        // Fill the hole → heal forward over 4 AND the already-present 5.
        put_body(4);
        assert_eq!(storage.last_sealed_mb_index(), 5, "filling the gap heals forward over stored successors");
        assert_eq!(hint(), Some(5));

        // Race reproduction: freeze the hint below a fully-contiguous body set (what a lost writer
        // update leaves) and require the reader to recover the true frontier + read-repair it.
        for n in 6..=8 { put_body(n); }
        db.put_cf(&meta, b"last_sealed_mb", &3u64.to_le_bytes()).unwrap();
        assert_eq!(storage.last_sealed_mb_index(), 8, "reader recovers from a frozen watermark hint");
        assert_eq!(hint(), Some(8), "and read-repairs it forward");
    }

    #[test]
    fn wallet_node_resolution_is_derived_and_phantom_free() {
        // Variant A: wallet→node resolves by DERIVING the id (pure fn of the wallet) + point-read node_<id>.
        // A non-derivable id (an activation_ phantom) can never be resolved, and resolution is independent
        // of insertion/gossip order (no reverse slot to race).
        let (storage, _dir) = open_test_storage();

        // Super: register under its canonical derived id; a phantom row for the SAME wallet, written before
        // AND re-cached after (None path), must not change the resolved id.
        let ws = "walletS";
        let super_id = crate::rpc::generate_super_node_pseudonym(ws);
        storage.save_node_registration_at_height("activation_deadbeef01", "super", ws, 70.0, 100).unwrap();
        storage.save_node_registration_at_height(&super_id, "super", ws, 70.0, 101).unwrap();
        storage.save_node_registration("activation_deadbeef01", "super", ws, 70.0).unwrap();
        let got = storage.get_nodes_by_wallet(ws).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, super_id, "resolves to the derived super id, never the phantom");

        // Light: derived light id resolves.
        let wl = "walletL";
        let light_id = crate::rpc::generate_light_node_pseudonym(wl);
        storage.save_node_registration_at_height(&light_id, "light", wl, 70.0, 200).unwrap();
        assert_eq!(storage.get_nodes_by_wallet(wl).unwrap()[0].0, light_id);

        // Genesis: constant-map wallet resolves to its genesis_node_<id>.
        let (gid, gw) = crate::genesis_constants::GENESIS_WALLETS[0];
        let genesis_id = format!("genesis_node_{}", gid);
        storage.save_node_registration_at_height(&genesis_id, "super", gw, 70.0, 0).unwrap();
        assert_eq!(storage.get_nodes_by_wallet(gw).unwrap()[0].0, genesis_id);

        // A wallet with ONLY a phantom row resolves to nothing.
        let wp = "walletPhantomOnly";
        storage.save_node_registration_at_height("activation_ffff", "super", wp, 70.0, 300).unwrap();
        assert!(storage.get_nodes_by_wallet(wp).unwrap().is_empty(), "a non-derivable id is never resolvable");
    }

    #[test]
    fn canonical_root_independent_of_insert_order() {
        let (storage_a, _da) = open_test_storage();
        put_account(&storage_a, b"acct_zzz", b"vZ");
        put_account(&storage_a, b"acct_aaa", b"vA");
        put_account(&storage_a, b"acct_mmm", b"vM");
        let ra = storage_a.compute_canonical_state_root(90).expect("ra");

        let (storage_b, _db) = open_test_storage();
        put_account(&storage_b, b"acct_aaa", b"vA");
        put_account(&storage_b, b"acct_mmm", b"vM");
        put_account(&storage_b, b"acct_zzz", b"vZ");
        let rb = storage_b.compute_canonical_state_root(90).expect("rb");

        assert_eq!(ra, rb, "root must be insertion-order-independent");
    }

    #[test]
    fn canonical_root_differs_by_height() {
        let (storage, _dir) = open_test_storage();
        put_account(&storage, b"acct_aaa", b"v1");
        let r90 = storage.compute_canonical_state_root(90).expect("r90");
        let r91 = storage.compute_canonical_state_root(91).expect("r91");
        assert_ne!(r90, r91, "height is part of domain separation");
    }

    #[test]
    fn canonical_root_empty_state_is_stable() {
        let (storage_a, _da) = open_test_storage();
        let (storage_b, _db) = open_test_storage();
        let ra = storage_a.compute_canonical_state_root(90).expect("ra");
        let rb = storage_b.compute_canonical_state_root(90).expect("rb");
        assert_eq!(ra, rb, "empty CF root must match across instances");
    }

    #[test]
    fn cbw_rebuild_from_registry_height_bounded_and_deterministic() {
        // The committed burn→NODE index is a DERIVED, reg_height-bounded rebuild of node_registry:
        // a snapshot/reorg/boot reconstruct an identical cbw, and an orphaned (above-bound) reg drops.
        // Bound to node_id, not the wallet — one wallet owns both a super and a light pseudonym, and a
        // wallet-keyed bind let a single burn activate both.
        let (storage, _dir) = open_test_storage();
        storage.save_node_registration_at_height_burn("super_a", "super", "walletA", 1.0, 50, "burnA").unwrap();
        storage.save_node_registration_at_height_burn("super_b", "super", "walletB", 1.0, 200, "burnB").unwrap();
        storage.save_node_registration_at_height_burn("genesis_node_001", "super", "walletG", 1.0, 0, "").unwrap();

        // Bounded BELOW super_b's reg_height: only burnA binds; burnB excluded; empty-burn genesis never binds.
        let n1 = storage.rebuild_committed_burn_wallet(100).unwrap();
        assert_eq!(n1, 1, "only burnA (reg_height 50 <= 100) binds");
        assert_eq!(storage.committed_burn_wallet_get("burnA").unwrap().as_deref(), Some("super_a"));
        assert_eq!(storage.committed_burn_wallet_get("burnB").unwrap(), None, "burnB reg_height 200 > 100 excluded");

        // Raise the bound: both burns bind (atomic clear+repopulate); genesis empty burn still excluded.
        let n2 = storage.rebuild_committed_burn_wallet(300).unwrap();
        assert_eq!(n2, 2, "burnA + burnB bind; empty-burn genesis excluded");
        assert_eq!(storage.committed_burn_wallet_get("burnA").unwrap().as_deref(), Some("super_a"));
        assert_eq!(storage.committed_burn_wallet_get("burnB").unwrap().as_deref(), Some("super_b"));

        // Idempotent: a second rebuild yields the identical set.
        assert_eq!(storage.rebuild_committed_burn_wallet(300).unwrap(), 2);
    }

    #[test]
    fn registry_root_deterministic_bound_sensitive_and_cross_instance() {
        // registry_root is the QC-bound digest a snapshot joiner checks: deterministic, bound-sensitive,
        // and identical across nodes that applied the same registrations (so content_ok cannot fork).
        let (storage, _dir) = open_test_storage();
        storage.save_node_registration_at_height_burn("super_a", "super", "walletA", 1.0, 50, "burnA").unwrap();
        let r_a = storage.compute_registry_root(100).unwrap();
        assert_eq!(r_a, storage.compute_registry_root(100).unwrap(), "registry_root must be deterministic");
        assert_ne!(r_a, [0u8; 32], "non-empty registry → non-zero root");

        // A registration ABOVE the bound must NOT change the bounded root; raising the bound DOES.
        storage.save_node_registration_at_height_burn("super_b", "super", "walletB", 1.0, 200, "burnB").unwrap();
        assert_eq!(storage.compute_registry_root(100).unwrap(), r_a, "reg above the bound must not change the bounded root");
        assert_ne!(storage.compute_registry_root(300).unwrap(), r_a, "including a new reg changes the root");

        // Cross-node determinism: a second instance built identically yields the identical root.
        let (storage_b, _db) = open_test_storage();
        storage_b.save_node_registration_at_height_burn("super_a", "super", "walletA", 1.0, 50, "burnA").unwrap();
        assert_eq!(storage_b.compute_registry_root(100).unwrap(), r_a, "same registry → identical root across instances");

        // LIGHT coverage (closes the light snapshot-forge gap): a light registration (lrtr_) MUST be
        // included in registry_root, so adding one changes the bounded root and snapshot-verify binds it.
        let before_light = storage_b.compute_registry_root(100).unwrap();
        storage_b.save_node_registration_at_height_burn("light_x", "light", "walletL", 1.0, 60, "burnL").unwrap();
        assert_ne!(storage_b.compute_registry_root(100).unwrap(), before_light, "a light reg must be in registry_root (light in scope)");
    }

    #[test]
    fn lthash_incremental_equals_from_scratch_with_rereg() {
        // THE core LtHash invariant: the live INCREMENTAL accumulator (maintained per-write in
        // save_node_registration_inner) must equal the FROM-SCRATCH recompute (used on reorg/boot/
        // snapshot/fallback) at the same bound — else a reorged/snapshot-joined node forks. Exercises
        // first-registration, re-registration (wallet+height change ⇒ subtract old, add new), and
        // super+light scope. HUGE bound so the unbounded live accumulator == bounded recompute.
        let (storage, _dir) = open_test_storage();
        storage.save_node_registration_at_height_burn("super_a", "super", "walletA", 1.0, 50, "burnA").unwrap();
        storage.save_node_registration_at_height_burn("light_x", "light", "walletL", 1.0, 60, "burnL").unwrap();
        storage.save_node_registration_at_height_burn("genesis_node_001", "super", "walletG", 1.0, 0, "").unwrap();
        // re-registration of super_a at a new height with a new wallet+burn (old row must be removed).
        storage.save_node_registration_at_height_burn("super_a", "super", "walletA2", 1.0, 80, "burnA2").unwrap();
        let live = storage.registry_lt_load().root();
        let scratch = storage.compute_lt_state(u64::MAX).unwrap().root();
        assert_eq!(live, scratch, "incremental accumulator must equal from-scratch recompute");
        // The from-scratch must reflect ONLY the new super_a identity (old walletA/burnA fully removed).
        assert_eq!(storage.compute_registry_root(u64::MAX).unwrap(), live, "fallback root == live root (no seal)");
    }

    #[test]
    fn lthash_seal_equals_fallback_at_checkpoint_head() {
        // The O(1) seal read MUST equal the O(N) from-scratch fallback at the same height. Live, the
        // seal is taken at block-H apply when lt_state holds exactly reg_height<=H (in-order apply);
        // here we mimic that by registering only at heights <= H before sealing.
        let (storage, _dir) = open_test_storage();
        storage.save_node_registration_at_height_burn("super_a", "super", "walletA", 1.0, 30, "burnA").unwrap();
        storage.save_node_registration_at_height_burn("light_x", "light", "walletL", 1.0, 60, "burnL").unwrap();
        let head = 90u64; // a checkpoint head (multiple of 30)
        storage.seal_registry_root(head).unwrap();
        let via_seal = storage.compute_registry_root(head).unwrap(); // O(1) seal hit
        let via_scratch = storage.compute_lt_state(head).unwrap().root();
        assert_eq!(via_seal, via_scratch, "seal value must equal the from-scratch recompute");
        // A registration ABOVE the head, added AFTER the seal, must NOT change the sealed read.
        storage.save_node_registration_at_height_burn("super_b", "super", "walletB", 1.0, 120, "burnB").unwrap();
        assert_eq!(storage.compute_registry_root(head).unwrap(), via_seal, "post-seal above-bound reg must not change the sealed root");
    }

    #[test]
    fn lthash_dual_index_node_counted_once() {
        // A crafted node that is BOTH super_-prefixed AND node_type==light lands in srtr_ AND lrtr_.
        // The incremental delta runs ONCE per registration; the from-scratch scan iterates both indices
        // and MUST dedup by node_id to count it once — else live != from-scratch → fork. This asserts
        // the dedup: live (one add) == from-scratch (deduped).
        let (storage, _dir) = open_test_storage();
        storage.save_node_registration_at_height_burn("super_dual", "light", "walletD", 1.0, 40, "burnD").unwrap();
        storage.save_node_registration_at_height_burn("light_y", "light", "walletY", 1.0, 50, "burnY").unwrap();
        let live = storage.registry_lt_load().root();
        let scratch = storage.compute_lt_state(u64::MAX).unwrap().root();
        assert_eq!(live, scratch, "a dual-index node must be counted exactly once on both paths");
    }

    #[test]
    fn lthash_rpc_cache_write_is_net_zero() {
        // An RPC/discovery-cache write (reg_height None) MUST NOT touch lt_state and MUST NOT rebind the
        // chain-confirmed identity — even with a different wallet — else each node's accumulator drifts
        // at non-deterministic wall-clock times → content_ok fork.
        let (storage, _dir) = open_test_storage();
        storage.save_node_registration_at_height_burn("super_a", "super", "walletA", 1.0, 50, "burnA").unwrap();
        let before = storage.registry_lt_load().root();
        let before_scratch = storage.compute_lt_state(u64::MAX).unwrap().root();
        // RPC-cache re-write with a DIFFERENT wallet (and no height) — must be ignored for identity.
        storage.save_node_registration("super_a", "super", "ATTACKER_WALLET", 99.0).unwrap();
        assert_eq!(storage.registry_lt_load().root(), before, "RPC-cache write must not change lt_state");
        assert_eq!(storage.compute_lt_state(u64::MAX).unwrap().root(), before_scratch, "RPC-cache must not rebind the chain identity");
        // The chain-confirmed wallet is preserved in the srtr_ index too.
        assert_eq!(storage.super_registrations_sorted().unwrap(),
                   vec![("super_a".to_string(), "walletA".to_string())], "chain wallet preserved against RPC clobber");
    }

    #[test]
    fn lthash_reapply_is_idempotent() {
        // Re-applying the SAME registration (crash-replay / repair) must be a no-op on lt_state
        // (old row == new row ⇒ net-zero), so the accumulator never drifts on replay.
        let (storage, _dir) = open_test_storage();
        storage.save_node_registration_at_height_burn("super_a", "super", "walletA", 1.0, 50, "burnA").unwrap();
        let once = storage.registry_lt_load().root();
        storage.save_node_registration_at_height_burn("super_a", "super", "walletA", 1.0, 50, "burnA").unwrap();
        assert_eq!(storage.registry_lt_load().root(), once, "identical re-apply must not change lt_state");
    }

    #[test]
    fn lthash_rebuild_matches_live_after_reset() {
        // rebuild_registry_lthash (reorg/boot/snapshot) must reconstruct an accumulator byte-identical
        // to the live incremental one at the same bound, and seal the tip so the verify read is O(1).
        let (storage, _dir) = open_test_storage();
        storage.save_node_registration_at_height_burn("super_a", "super", "walletA", 1.0, 50, "burnA").unwrap();
        storage.save_node_registration_at_height_burn("light_x", "light", "walletL", 1.0, 60, "burnL").unwrap();
        let live = storage.registry_lt_load().root();
        let head = 90u64;
        storage.rebuild_registry_lthash(head).unwrap();
        assert_eq!(storage.registry_lt_load().root(), live, "rebuilt accumulator == live (all regs <= head)");
        assert_eq!(storage.compute_registry_root(head).unwrap(), live, "rebuild seals the tip ⇒ O(1) read == live");
    }

    #[test]
    fn dpk_lthash_incremental_matches_rebuild() {
        // FIX-5: the incremental per-block bind (dpk_lt_bind, marker-guarded) MUST yield a
        // dilithium_pk_root byte-identical to the from-scratch rebuild over the accounts CF
        // (boot/snapshot/reorg) — else a producer that bound pks incrementally forks from a
        // snapshot-joined node that rebuilt them. Also: order-independent, duplicate-immune,
        // pkless accounts contribute nothing.
        let (storage, _dir) = open_test_storage();
        let pk_a = vec![0xA1u8; 1952];
        let pk_b = vec![0xB2u8; 1952];
        let mut acct_a = qnet_state::Account::new("addrA".to_string());
        acct_a.dilithium_public_key = Some(pk_a.clone());
        let mut acct_b = qnet_state::Account::new("addrB".to_string());
        acct_b.dilithium_public_key = Some(pk_b.clone());
        let acct_c = qnet_state::Account::new("addrC".to_string()); // no pk (elided / not-yet-bound)
        storage.persistent.persist_accounts_sync(&[
            ("addrA".to_string(), acct_a),
            ("addrB".to_string(), acct_b),
            ("addrC".to_string(), acct_c),
        ]).unwrap();
        // Incremental binds in an ARBITRARY order + a duplicate (the marker must absorb it).
        storage.dpk_lt_bind("addrB", &pk_b, 10).unwrap();
        storage.dpk_lt_bind("addrA", &pk_a, 11).unwrap();
        storage.dpk_lt_bind("addrB", &pk_b, 12).unwrap(); // duplicate ⇒ marker no-op (no double-add)
        let incremental = storage.dpk_lt_load().root();
        // From-scratch rebuild over the accounts CF (the boot / snapshot-promote / reorg path).
        storage.rebuild_dilithium_pk_lthash().unwrap();
        let rebuilt = storage.dpk_lt_load().root();
        assert_eq!(incremental, rebuilt, "incremental bind == from-scratch rebuild (order-independent, no double-add)");
        // Root == LtHash over EXACTLY the pk-bearing accounts (addrC pkless ⇒ excluded).
        let mut scratch = crate::registry_lthash::LtHash::new();
        scratch.add(&crate::registry_lthash::pk_row_lanes("addrA", &pk_a));
        scratch.add(&crate::registry_lthash::pk_row_lanes("addrB", &pk_b));
        assert_eq!(rebuilt, scratch.root(), "root == LtHash over exactly the pk-bearing accounts");
        // Seal ⇒ O(1) checkpoint read equals the live accumulator.
        storage.seal_dilithium_pk_root(90).unwrap();
        assert_eq!(storage.compute_dilithium_pk_root(90).unwrap(), incremental, "seal ⇒ O(1) checkpoint read == live root");
    }

    #[test]
    fn dpk_rollback_subtracts_orphan_binds() {
        // Reorg: journaled binds above target are subtracted exactly, markers cleared (re-bind
        // unblocked), and the result is byte-identical to a node that never saw the orphan branch.
        let (storage, _dir) = open_test_storage();
        let pk_a = vec![0xA1u8; 1952];
        let pk_b = vec![0xB2u8; 1952];
        let pk_c = vec![0xC3u8; 1952];
        storage.dpk_lt_bind("addrA", &pk_a, 40).unwrap();  // canonical (<= target)
        let canonical = storage.dpk_lt_load().root();
        storage.dpk_lt_bind("addrB", &pk_b, 55).unwrap();  // orphan branch
        storage.dpk_lt_bind("addrC", &pk_c, 61).unwrap();  // orphan branch
        storage.seal_dilithium_pk_root(60).unwrap();       // orphan-branch seal
        let n = storage.rollback_dpk_binds_above(50).unwrap();
        assert_eq!(n, 2, "exactly the two orphan binds subtracted");
        assert_eq!(storage.dpk_lt_load().root(), canonical, "accumulator == pre-orphan canonical");
        assert!(storage.dpk_root_seal_get(60).is_none(), "orphan seal dropped");
        // Marker cleared ⇒ the canonical re-bind of the same account lands (not a marker no-op).
        storage.dpk_lt_bind("addrB", &pk_b, 51).unwrap();
        let mut expect = crate::registry_lthash::LtHash::new();
        expect.add(&crate::registry_lthash::pk_row_lanes("addrA", &pk_a));
        expect.add(&crate::registry_lthash::pk_row_lanes("addrB", &pk_b));
        assert_eq!(storage.dpk_lt_load().root(), expect.root(), "canonical re-bind == from-scratch");
        // Idempotent on an empty range.
        assert_eq!(storage.rollback_dpk_binds_above(50).unwrap(), 1, "re-bind at 51 subtracted again");
        assert_eq!(storage.dpk_lt_load().root(), canonical, "back to canonical");
    }

    #[test]
    fn dpk_journal_prune_respects_finality_floor() {
        // prune_dpk_journal must drop ONLY finality-covered entries (height <= floor); rollback-eligible
        // entries above the floor MUST survive so a later reorg can still subtract them.
        let (storage, _dir) = open_test_storage();
        let pk = vec![0xD4u8; 1952];
        storage.dpk_lt_bind("a1", &pk, 100).unwrap();
        storage.dpk_lt_bind("a2", &pk, 200).unwrap();
        storage.dpk_lt_bind("a3", &pk, 300).unwrap();
        storage.prune_dpk_journal(0).unwrap();   // finalized=0 ⇒ no-op
        assert_eq!(storage.rollback_dpk_binds_above(50).unwrap(), 3, "floor 0 pruned nothing");
        storage.dpk_lt_bind("a1", &pk, 100).unwrap();
        storage.dpk_lt_bind("a2", &pk, 200).unwrap();
        storage.dpk_lt_bind("a3", &pk, 300).unwrap();
        storage.prune_dpk_journal(200).unwrap();  // finalized=200 ⇒ drops 100,200; keeps 300
        assert_eq!(storage.rollback_dpk_binds_above(50).unwrap(), 1, "only the above-floor bind (300) survives");
    }

    #[test]
    fn lthash_restamp_keeps_first_height_netzero() {
        // A re-presented NodeActivation (Ok no-op via the single-use guard) would re-stamp the super
        // pseudonym at a NEW height. reg_height is immutable once chain-stamped, so the row stays at H1:
        // the lt_state delta is net-zero AND a reorg into [H1,H2) cannot make from-scratch drop a row a
        // never-reorged node still holds. Without immutability this would move the row H1->H2 and fork.
        let (storage, _dir) = open_test_storage();
        storage.save_node_registration_at_height_burn("super_node_x", "super", "walletX", 1.0, 30, "").unwrap();
        let after_first = storage.registry_lt_load().root();
        storage.save_node_registration_at_height_burn("super_node_x", "super", "walletX", 1.0, 90, "").unwrap(); // re-stamp
        assert_eq!(storage.registry_lt_load().root(), after_first, "re-stamp must be net-zero (reg_height immutable)");
        assert_eq!(storage.compute_lt_state(u64::MAX).unwrap().root(), after_first, "from-scratch == live (row kept at H1)");
        // The decisive anti-fork check: a node at a bound in [H1,H2) agrees with a node that re-stamped.
        let (storage2, _d2) = open_test_storage();
        storage2.save_node_registration_at_height_burn("super_node_x", "super", "walletX", 1.0, 30, "").unwrap();
        assert_eq!(storage.compute_lt_state(60).unwrap().root(), storage2.compute_lt_state(60).unwrap().root(),
                   "re-stamped node and never-reorged node compute the identical root at a bound in [30,90)");
    }

    #[test]
    fn wallet_burn_registration_gate() {
        // C: NodeActivation is gated on the wallet holding a burn-attested registration. Nodes register
        // under their wallet-derived id, which the gate re-derives to resolve.
        let (storage, _dir) = open_test_storage();
        let sa = crate::rpc::generate_super_node_pseudonym("walletA");
        storage.save_node_registration_at_height_burn(&sa, "super", "walletA", 1.0, 50, "burnA").unwrap();
        assert!(storage.wallet_is_burn_registered("walletA"), "burn-attested registration ⇒ activation allowed");
        // Genesis-style empty-burn registration is NOT a burn proof (genesis never activates).
        let (gid, gw) = crate::genesis_constants::GENESIS_WALLETS[0];
        storage.save_node_registration_at_height_burn(&format!("genesis_node_{}", gid), "super", gw, 1.0, 0, "").unwrap();
        assert!(!storage.wallet_is_burn_registered(gw), "empty-burn registration ⇒ not a burn proof");
        // A raw activation from an unregistered wallet is rejected.
        assert!(!storage.wallet_is_burn_registered("walletX"), "no registration ⇒ activation rejected");
        // Genesis exemption: constant-table membership (mirrors the registration burn-gate's genesis exemption).
        assert!(storage.wallet_is_genesis_node(gw), "genesis wallet ⇒ activation exempt");
        assert!(!storage.wallet_is_genesis_node("walletA"), "non-genesis super ⇒ NOT genesis-exempt");
        assert!(!storage.wallet_is_genesis_node("walletX"), "unregistered ⇒ NOT genesis-exempt");
    }

    #[test]
    fn prune_orphan_registrations_drops_above_target() {
        // B: on reorg, orphan roster index KEYS (reg_height > target) are pruned so the reward-roster
        // readers (super/light, which scan srtr_/lrtr_ directly) match a from-genesis node. Nodes are
        // keyed by their wallet-derived pseudonym (same as production) so wallet→node resolution works.
        let (storage, _dir) = open_test_storage();
        let sa = crate::rpc::generate_super_node_pseudonym("walletA");
        let so = crate::rpc::generate_super_node_pseudonym("walletO");
        let la = crate::rpc::generate_light_node_pseudonym("walletL");
        let lo = crate::rpc::generate_light_node_pseudonym("walletLO");
        storage.save_node_registration_at_height_burn(&sa, "super", "walletA", 1.0, 50, "burnA").unwrap();
        storage.save_node_registration_at_height_burn(&so, "super", "walletO", 1.0, 200, "burnO").unwrap();
        storage.save_node_registration_at_height_burn(&la, "light", "walletL", 1.0, 60, "burnL").unwrap();
        storage.save_node_registration_at_height_burn(&lo, "light", "walletLO", 1.0, 250, "burnLO").unwrap();
        assert_eq!(storage.super_registrations_sorted().unwrap().len(), 2, "both supers in the unbounded roster pre-prune");
        // rebuild_registry_lthash folds the orphan prune into its single scan; it returns the orphan count.
        let pruned = storage.rebuild_registry_lthash(100).unwrap();
        assert_eq!(pruned, 2, "both orphans (reg_height 200, 250) pruned");
        assert_eq!(storage.super_registrations_sorted().unwrap(),
                   vec![(sa.clone(), "walletA".to_string())], "orphan super gone from the roster");
        assert_eq!(storage.light_roster_sorted(1000).unwrap(),
                   vec![(la.clone(), "walletL".to_string())], "orphan light gone from the roster");
        assert!(storage.wallet_is_burn_registered("walletA"), "canonical entry survives");
        assert!(!storage.wallet_is_burn_registered("walletO"), "orphan node_ entry also pruned");
        // The reg_height-bounded views (cbw / lt_state) already excluded the orphans by bound.
        assert_eq!(storage.compute_lt_state(u64::MAX).unwrap().root(), {
            let (s2, _d) = open_test_storage();
            s2.save_node_registration_at_height_burn(&sa, "super", "walletA", 1.0, 50, "burnA").unwrap();
            s2.save_node_registration_at_height_burn(&la, "light", "walletL", 1.0, 60, "burnL").unwrap();
            s2.compute_lt_state(u64::MAX).unwrap().root()
        }, "post-prune roster == a from-genesis node with only the canonical registrations");
    }

    /// THE point of reg_index. Under the old rule bit `i` was the `i`-th node in a roster SCAN, so
    /// removing one row shifted every later node's bit — the bitmap was then read at the wrong
    /// offsets and paid a DIFFERENT set, not a smaller one. Indexed by reg_index nothing moves.
    #[test]
    fn removing_a_roster_row_shifts_no_other_bit() {
        let (st, _d) = open_test_storage();
        let mut ids: Vec<String> = Vec::new();
        for i in 0..10u64 {
            let w = format!("wl{}", i);
            let id = crate::rpc::generate_light_node_pseudonym(&w);
            st.save_node_registration_at_height_burn(&id, "light", &w, 1.0, 10 + i, "b").unwrap();
            ids.push(id);
        }

        let snapshot = |st: &Storage| -> std::collections::BTreeMap<String, u32> {
            let mut m = std::collections::BTreeMap::new();
            st.light_roster_for_each(u64::MAX, |id, _w, idx| { m.insert(id.to_string(), idx); }).unwrap();
            m
        };

        let before = snapshot(&st);
        assert_eq!(before.len(), 10, "all ten in the roster");

        // Drop the third registration exactly as a reorg prune does.
        let victim = ids[2].clone();
        let cf = st.persistent.db.cf_handle("node_registry").unwrap();
        st.persistent.db.delete_cf(&cf, format!("lrtr_{}", victim).as_bytes()).unwrap();
        st.persistent.db.delete_cf(&cf, format!("node_{}", victim).as_bytes()).unwrap();

        let after = snapshot(&st);
        assert_eq!(after.len(), 9, "only the removed node is gone");
        assert!(!after.contains_key(&victim));
        for (id, idx) in before.iter() {
            if id == &victim { continue; }
            assert_eq!(after.get(id), Some(idx),
                       "bit position of {} moved after an unrelated removal", id);
        }
    }

    /// reg_index is the row's RANK in canonical (reg_height, node_id) order. Pinning it here means a
    /// future change that reintroduces an arrival counter fails loudly instead of forking the root
    /// only on nodes that happened to apply out of order.
    #[test]
    fn reg_index_is_canonical_rank_regardless_of_apply_order() {
        let ids: Vec<(String, u64)> = vec![
            (crate::rpc::generate_super_node_pseudonym("w1"), 10),
            (crate::rpc::generate_super_node_pseudonym("w2"), 20),
            (crate::rpc::generate_super_node_pseudonym("w3"), 30),
        ];
        let root_of = |order: &[usize]| -> [u8; 32] {
            let (st, _d) = open_test_storage();
            for &i in order {
                let (id, h) = &ids[i];
                st.save_node_registration_at_height_burn(id, "super", &format!("w{}", i + 1), 1.0, *h, "b").unwrap();
            }
            // Rebuild is the canonicalising pass; a node that applied in order must match one that did not.
            st.rebuild_registry_lthash(u64::MAX).unwrap();
            st.compute_lt_state(u64::MAX).unwrap().root()
        };
        assert_eq!(root_of(&[0, 1, 2]), root_of(&[2, 0, 1]),
                   "registry_root must not depend on the order registrations were applied");
        assert_eq!(root_of(&[0, 1, 2]), root_of(&[2, 1, 0]));
    }

    /// The live stamp and the rebuild must agree WITHOUT a rebuild having run — that is the whole
    /// point of reg_index. The prior test compared rebuild against rebuild, so it could not see this:
    /// two registrations in ONE block are ranked by node_id, while transaction order is arbitrary, so
    /// stamping in arrival order made every restart renumber and move registry_root.
    #[test]
    fn live_reg_index_equals_the_rebuild_rank_within_one_block() {
        // One block ⇒ one reg_height for every row; the rank is then node_id alone.
        const H: u64 = 77;
        let mut rows: Vec<(String, String, String, String, String)> = (1..=4)
            .map(|i| {
                let w = format!("w{}", i);
                (crate::rpc::generate_super_node_pseudonym(&w), "super".to_string(), w,
                 format!("burn{}", i), String::new())
            })
            .collect();

        let write_in = |order: &[(String, String, String, String, String)]| -> Storage {
            let (st, dir) = open_test_storage();
            std::mem::forget(dir); // the temp dir must outlive the returned handle
            for (id, ty, w, b, _) in order {
                st.save_node_registration_at_height_burn(id, ty, w, 1.0, H, b).unwrap();
            }
            st
        };

        // Deliberately NOT node_id order — this is what a block's transaction order looks like.
        let mut arrival = rows.clone();
        arrival.reverse();
        let st_arrival = write_in(&arrival);
        let live_arrival = st_arrival.compute_lt_state(u64::MAX).unwrap().root();

        // The rule the producer, the validator drain and the genesis apply all go through.
        crate::node::BlockchainNode::sort_registrations_canonically(&mut rows);
        let st_canon = write_in(&rows);
        let live_canon = st_canon.compute_lt_state(u64::MAX).unwrap().root();

        // What a restarted / reorged node computes from the same surviving set.
        st_canon.rebuild_registry_lthash(u64::MAX).unwrap();
        let rebuilt = st_canon.compute_lt_state(u64::MAX).unwrap().root();

        assert_eq!(live_canon, rebuilt,
                   "a canonically stamped block must survive a restart with the same registry_root");
        assert_ne!(live_arrival, rebuilt,
                   "arrival order really does diverge — without the sort this test is vacuous");

        // And the repair still works: the arrival-ordered node rejoins the network's numbering.
        st_arrival.rebuild_registry_lthash(u64::MAX).unwrap();
        assert_eq!(st_arrival.compute_lt_state(u64::MAX).unwrap().root(), rebuilt,
                   "the rebuild must put a divergent node back on the canonical numbering");
    }

    /// node_type is hashed AND frozen. It decides light-roster membership at backfill, and it was the
    /// one identity field an RPC-cache write could rebind with a peer-supplied value.
    #[test]
    fn node_type_is_frozen_after_chain_stamp() {
        let (st, _d) = open_test_storage();
        let id = crate::rpc::generate_super_node_pseudonym("wS");
        st.save_node_registration_at_height_burn(&id, "super", "wS", 1.0, 50, "bS").unwrap();
        let before = st.compute_lt_state(u64::MAX).unwrap().root();
        // An un-stamped (RPC-cache) write claiming a different type must not rebind it.
        st.save_node_registration(&id, "light", "wS", 1.0).unwrap();
        assert_eq!(st.compute_lt_state(u64::MAX).unwrap().root(), before,
                   "an RPC-cache write must not move registry_root");
        assert!(st.light_roster_sorted(1000).unwrap().is_empty(),
                "a super must not appear in the light roster after a type-flip attempt");
    }

    #[test]
    fn reward_shard_backfill_heals_absent_certified_epoch() {
        // A node holding the 2f+1 reward_root but an Absent local shard (freeze-race / snapshot join)
        // re-derives from super_elig_ + registrations, verifies == certified, freezes → serves the
        // certified amount; an unreconstructible epoch is memoised instead of re-walked.
        let (storage, _dir) = open_test_storage();
        let wa = "wa".to_string();
        let wb = "wb".to_string();
        let sa = crate::rpc::generate_super_node_pseudonym(&wa);
        let sb = crate::rpc::generate_super_node_pseudonym(&wb);
        storage.save_node_registration_at_height_burn(&sa, "super", &wa, 1.0, 50, "burnA").unwrap();
        storage.save_node_registration_at_height_burn(&sb, "super", &wb, 1.0, 50, "burnB").unwrap();
        storage.save_super_eligible_batch(1, &vec![sa.clone(), sb.clone()]).unwrap(); // eligible for epoch_num=1
        let mbi = 320u64; // macroblock_index → epoch_num = 320/160-1 = 1
        let total = crate::reward_epoch::canonical_total(mbi);
        let (w, root) = crate::node::BlockchainNode::compute_epoch_reward_distribution(&storage, mbi, total)
            .expect("test fixture has a reproducible leaf set");
        assert!(!w.is_empty() && !root.is_empty(), "canonical set non-empty");
        // Certified root present, but NO shard (root-only state after a cold join).
        let mut rb = [0u8; 32];
        rb.copy_from_slice(&hex::decode(&root).unwrap());
        storage.seed_epoch_root_for_test(mbi, rb);
        assert!(storage.load_epoch_shard_meta(mbi).unwrap().is_none(), "no shard pre-heal");
        assert!(matches!(crate::node::BlockchainNode::reward_proof_from_shard(&storage, mbi, &root, &wa, false),
                         crate::node::ShardClaim::Absent), "pending serves Absent pre-heal");
        // Unreconstructible epoch: certified root but no super_elig for its epoch_num ⇒ memoised, not healed.
        let bad = 480u64;
        storage.seed_epoch_root_for_test(bad, [0xdd; 32]);

        let healed = crate::node::BlockchainNode::backfill_reward_shards(&storage);
        assert_eq!(healed, 1, "exactly the reconstructible epoch heals");
        assert!(storage.load_epoch_shard_meta(mbi).unwrap().is_some(), "shard frozen post-heal");
        match crate::node::BlockchainNode::reward_proof_from_shard(&storage, mbi, &root, &wa, false) {
            crate::node::ShardClaim::Proof(amount, _) => assert_eq!(amount, total / 2, "wallet A gets its half"),
            _ => panic!("expected Proof post-heal"),
        }
    }

    #[test]
    fn prune_reward_shards_keeps_epoch_claimable_via_reheal() {
        // Pruning the shard CACHE (epoch_wshard_/epoch_shardmeta_) leaves root/super_elig_ intact, so a
        // pruned epoch re-freezes from those indices (verified vs certified root) — nothing unclaimable.
        let (storage, _dir) = open_test_storage();
        let wa = "wa".to_string();
        let wb = "wb".to_string();
        let sa = crate::rpc::generate_super_node_pseudonym(&wa);
        let sb = crate::rpc::generate_super_node_pseudonym(&wb);
        storage.save_node_registration_at_height_burn(&sa, "super", &wa, 1.0, 50, "burnA").unwrap();
        storage.save_node_registration_at_height_burn(&sb, "super", &wb, 1.0, 50, "burnB").unwrap();
        storage.save_super_eligible_batch(1, &vec![sa.clone(), sb.clone()]).unwrap();
        let mbi = 320u64;
        let total = crate::reward_epoch::canonical_total(mbi);
        let (w, root) = crate::node::BlockchainNode::compute_epoch_reward_distribution(&storage, mbi, total)
            .expect("test fixture has a reproducible leaf set");
        let mut rb = [0u8; 32];
        rb.copy_from_slice(&hex::decode(&root).unwrap());
        storage.seed_epoch_root_for_test(mbi, rb);
        crate::node::BlockchainNode::save_epoch_reward_sharded(&storage, mbi, &w);
        assert!(storage.load_epoch_shard_meta(mbi).unwrap().is_some(), "frozen pre-prune");
        // Prune the shard cache for this epoch (keep everything >= mbi+1).
        storage.prune_epoch_reward_shards(mbi + 1).unwrap();
        assert!(storage.load_epoch_shard_meta(mbi).unwrap().is_none(), "shard cache pruned");
        assert!(storage.load_epoch_root(mbi).unwrap().is_some(), "certified root retained");
        // Re-heal from the retained root + super_elig_ ⇒ epoch stays claimable.
        assert_eq!(crate::node::BlockchainNode::backfill_reward_shards(&storage), 1, "pruned epoch re-freezes");
        match crate::node::BlockchainNode::reward_proof_from_shard(&storage, mbi, &root, &wa, false) {
            crate::node::ShardClaim::Proof(amount, _) => assert_eq!(amount, total / 2, "wallet A recovers its half"),
            _ => panic!("expected Proof after re-heal"),
        }
    }

    // Stable hash 5-genesis sharding (mirrors node.rs/storage.rs readers): shard g = the ordered set of
    // sorted-roster nodes with light_shard_of()==g; bit i within shard g's bitmap ⇒ the i-th such member.
    fn shard_eligible(roster: &[(String, String)], bitmaps: &[(usize, Vec<u8>)]) -> Vec<(String, String)> {
        let bm: std::collections::HashMap<usize, &Vec<u8>> = bitmaps.iter().map(|(g, b)| (*g, b)).collect();
        let mut counters = [0usize; 5];
        let mut out = Vec::new();
        for entry in roster {
            let g = crate::node::light_shard_of(&entry.0);
            let local_i = counters[g];
            counters[g] += 1;
            if let Some(b) = bm.get(&g) {
                if b.get(local_i / 8).map(|x| x & (1 << (local_i % 8)) != 0).unwrap_or(false) {
                    out.push(entry.clone());
                }
            }
        }
        out
    }

    #[test]
    fn roster_index_equals_full_scan_bit_identical() {
        // P6/P7: the apply-time srtr_/lrtr_ index readers MUST be byte-identical to the legacy
        // full-CF JSON scans — a divergence reorders the positional shard ⇒ different reward_root ⇒
        // fork. Exercises: node_id ordering, RPC-cache (None) exclusion, before_height cutoff,
        // positional-shard equivalence, and backfill reconstruction from node_ entries.
        let (storage, _dir) = open_test_storage();
        // Chain-confirmed (reg_height stamped) — inserted out of order to prove ordering is by node_id.
        storage.save_node_registration_at_height("super_c", "super", "wc", 70.0, 5).unwrap();
        storage.save_node_registration_at_height("super_a", "super", "wa", 70.0, 10).unwrap();
        storage.save_node_registration_at_height("super_b", "super", "wb", 70.0, 3).unwrap();
        storage.save_node_registration_at_height("genesis_node_001", "genesis", "wg", 100.0, 0).unwrap();
        storage.save_node_registration_at_height("light_z", "light", "lz", 70.0, 100).unwrap();
        storage.save_node_registration_at_height("light_a", "light", "la", 70.0, 100).unwrap();
        storage.save_node_registration_at_height("light_m", "light", "lm", 70.0, 100).unwrap();
        storage.save_node_registration_at_height("light_late", "light", "ll", 70.0, 200).unwrap(); // > cutoff
        // RPC/discovery cache write (no reg_height) — must NOT enter either index.
        storage.save_node_registration("light_rpc", "light", "lr", 70.0).unwrap();

        let before = 150u64;
        // (1) Index reader == full-CF scan, byte-identical Vec.
        assert_eq!(storage.super_registrations_sorted().unwrap(),
                   storage.super_registrations_sorted_scan().unwrap(), "super index != scan");
        assert_eq!(storage.light_roster_sorted(before).unwrap(),
                   storage.light_roster_sorted_scan(before).unwrap(), "light index != scan");

        // (2) Exact expected sets (ascending node_id; RPC-cache + too-new excluded).
        assert_eq!(storage.super_registrations_sorted().unwrap(),
                   vec![("genesis_node_001".to_string(), "wg".to_string()),
                        ("super_a".to_string(), "wa".to_string()),
                        ("super_b".to_string(), "wb".to_string()),
                        ("super_c".to_string(), "wc".to_string())]);
        let lr = storage.light_roster_sorted(before).unwrap();
        assert_eq!(lr, vec![("light_a".to_string(), "la".to_string()),
                            ("light_m".to_string(), "lm".to_string()),
                            ("light_z".to_string(), "lz".to_string())]);
        assert!(!lr.iter().any(|(id, _)| id == "light_rpc"), "RPC-cache (None) must be excluded");
        assert!(!lr.iter().any(|(id, _)| id == "light_late"), "before_height cutoff must exclude too-new");

        // (3) Positional-shard equivalence: same eligible set whether derived from index or scan.
        let bitmaps = vec![(0usize, vec![0b1u8]), (1usize, vec![0b1u8]), (2usize, vec![0b1u8])];
        assert_eq!(shard_eligible(&storage.light_roster_sorted(before).unwrap(), &bitmaps),
                   shard_eligible(&storage.light_roster_sorted_scan(before).unwrap(), &bitmaps),
                   "positional shard must be identical across readers");

        // (4) Backfill reconstruction: drop the index, confirm reader empties, rebuild from node_.
        let cf = storage.persistent.db.cf_handle("node_registry").unwrap();
        let mut del = rocksdb::WriteBatch::default();
        for item in storage.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start) {
            let (k, _) = item.unwrap();
            if k.starts_with(b"srtr_") || k.starts_with(b"lrtr_") { del.delete_cf(&cf, &k); }
        }
        storage.persistent.db.write(del).unwrap();
        assert!(storage.super_registrations_sorted().unwrap().is_empty(), "index should be empty after drop");
        assert!(storage.light_roster_sorted(before).unwrap().is_empty(), "index should be empty after drop");
        assert!(storage.backfill_roster_indices().unwrap() > 0, "backfill must add entries");
        assert_eq!(storage.super_registrations_sorted().unwrap(),
                   storage.super_registrations_sorted_scan().unwrap(), "post-backfill super mismatch");
        assert_eq!(storage.light_roster_sorted(before).unwrap(),
                   storage.light_roster_sorted_scan(before).unwrap(), "post-backfill light mismatch");
    }

    #[test]
    fn light_reregister_keeps_first_height_index_matches_scan() {
        // A light node re-registered at a LATER chain height must keep its FIRST stamped height in BOTH the
        // node_ row (source of truth / backfill) and the lrtr_ index value (live-apply write). Otherwise an
        // apply-history node (lrtr_=H2) and a snapshot/backfill-rebuilt node (lrtr_=H1, derived from node_)
        // disagree on the cutoff for any epoch whose before_height lands in (H1,H2] → different reward roster
        // → per-shard counter shift → reward_root fork between apply-history and snapshot-joined nodes.
        let (storage, _dir) = open_test_storage();
        let (h1, h2) = (10u64, 100u64);
        storage.save_node_registration_at_height("light_x", "light", "wx", 70.0, h1).unwrap();
        storage.save_node_registration_at_height("light_x", "light", "wx", 70.0, h2).unwrap(); // re-stamp higher
        // Index reader == node_ scan for every cutoff spanning the re-stamp gap.
        for before in [h1 + 1, (h1 + h2) / 2, h2, h2 + 1] {
            assert_eq!(storage.light_roster_sorted(before).unwrap(),
                       storage.light_roster_sorted_scan(before).unwrap(),
                       "lrtr_ index != node_ scan at cutoff {}", before);
        }
        // Effective height is the FIRST (H1): included once the cutoff passes H1, not H2.
        assert!(storage.light_roster_sorted(h1 + 1).unwrap().iter().any(|(id, _)| id == "light_x"),
                "re-registered node must use its FIRST height (H1) for the cutoff");
        // Backfill (rebuilds lrtr_ from node_) reproduces the identical index.
        let cf = storage.persistent.db.cf_handle("node_registry").unwrap();
        let mut del = rocksdb::WriteBatch::default();
        for item in storage.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start) {
            let (k, _) = item.unwrap();
            if k.starts_with(b"lrtr_") { del.delete_cf(&cf, &k); }
        }
        storage.persistent.db.write(del).unwrap();
        storage.backfill_roster_indices().unwrap();
        assert_eq!(storage.light_roster_sorted(h1 + 1).unwrap(),
                   storage.light_roster_sorted_scan(h1 + 1).unwrap(),
                   "post-backfill lrtr_ index != node_ scan (re-register)");
    }

    // Read every (key, value) row of a CF into a sorted map for set-equality checks.
    fn dump_cf(storage: &Storage, cf_name: &str) -> std::collections::BTreeMap<Vec<u8>, Vec<u8>> {
        let cf = storage.persistent.db.cf_handle(cf_name).expect("cf handle");
        let mut out = std::collections::BTreeMap::new();
        for item in storage.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start) {
            let (k, v) = item.expect("iter row");
            out.insert(k.to_vec(), v.to_vec());
        }
        out
    }

    #[test]
    fn streamed_snapshot_dump_roundtrips_through_untouched_loader() {
        // A2/A3: the streaming DUMP (no full uncompressed blob materialized) must produce a frame the
        // UNTOUCHED loader decodes to a byte-identical account set — proving the streamed content is
        // ordering- and byte-equivalent to the prior in-RAM assembly through the same wire format.
        let rt = tokio::runtime::Runtime::new().expect("rt");
        let (src, _sd) = open_test_storage();

        // Seed a handful of accounts (arbitrary bytes — the loader restores raw CF rows) plus one
        // reward / contract-storage / registry row to exercise every snapshot section.
        put_account(&src, b"acct_aaa", b"balance-1");
        put_account(&src, b"acct_bbb", b"balance-2");
        put_account(&src, b"acct_ccc", b"balance-3");
        {
            let cf = src.persistent.db.cf_handle("pending_rewards").expect("rewards cf");
            src.persistent.db.put_cf(&cf, b"rew_key", b"rew_val").expect("put reward");
        }
        {
            let cf = src.persistent.db.cf_handle("contract_storage").expect("cs cf");
            src.persistent.db.put_cf(&cf, b"contract\x00slot", b"cs_val").expect("put contract");
        }
        {
            let cf = src.persistent.db.cf_handle("node_registry").expect("nr cf");
            src.persistent.db.put_cf(&cf, b"node_super_x", b"nr_val").expect("put registry");
        }

        // Stream the dump: prepare a pinned view (accounts already flushed to the CF, so pass none)
        // and materialize the compressed frame under full_snap_<h>.
        let height = 90u64;
        let view = src.prepare_snapshot_view(&[]).expect("view");
        rt.block_on(src.create_state_snapshot(height, view)).expect("create snapshot");

        // The frame must be a valid single zstd stream with the unchanged [hash(32)|len(8)|zstd] header.
        let src_snaps = src.persistent.db.cf_handle("snapshots").expect("snapshots cf");
        let frame = src.persistent.db
            .get_cf(&src_snaps, format!("full_snap_{}", height).as_bytes())
            .expect("get frame").expect("frame present");
        assert!(frame.len() > 40, "frame carries the 40-byte header + compressed body");
        let stored_hash = &frame[..32];
        let claimed_len = u64::from_le_bytes(frame[32..40].try_into().unwrap());
        let compressed = &frame[40..];
        use sha3::{Sha3_256, Digest};
        let mut h = Sha3_256::new();
        h.update(compressed);
        assert_eq!(stored_hash, h.finalize().as_slice(), "hash is over the compressed buffer");
        let decoded = zstd::decode_all(compressed).expect("single valid zstd frame");
        assert_eq!(decoded.len() as u64, claimed_len, "uncompressed_len header matches streamed byte count");
        assert_eq!(decoded.first().copied(), Some(0x02u8), "SNAP_TYPE_FULL discriminator preserved");

        // Load the frame into a FRESH storage via the untouched loader and compare the account set.
        let (dst, _dd) = open_test_storage();
        let dst_snaps = dst.persistent.db.cf_handle("snapshots").expect("snapshots cf");
        dst.persistent.db
            .put_cf(&dst_snaps, format!("full_snap_{}", height).as_bytes(), &frame)
            .expect("stage frame");
        rt.block_on(dst.load_state_snapshot(height, false)).expect("load snapshot");

        assert_eq!(dump_cf(&src, "accounts"), dump_cf(&dst, "accounts"),
                   "streamed dump round-trips to a byte-identical account set");
        // The recomputed account-state root must match — the consensus-critical invariant.
        assert_eq!(src.compute_canonical_state_root(height).expect("src root"),
                   dst.compute_canonical_state_root(height).expect("dst root"),
                   "recomputed account-state root identical after round-trip");
        // Other streamed sections also survive the round-trip.
        assert_eq!(dump_cf(&src, "pending_rewards"), dump_cf(&dst, "pending_rewards"));
        assert_eq!(dump_cf(&src, "contract_storage"), dump_cf(&dst, "contract_storage"));
        assert_eq!(dump_cf(&src, "node_registry"), dump_cf(&dst, "node_registry"));
    }
}
#[cfg(test)]
mod tests_parent_linkage_invariant {
    use super::*;

    fn mb(height: u64, parent: [u8; 32], tag: u8) -> qnet_state::MicroBlock {
        let mut b = qnet_state::MicroBlock::new(height, 1000 + height, parent, vec![], "genesis_node_001".to_string());
        b.merkle_root = [tag; 32];
        b
    }

    /// Incident replay (h=54059/54060). The losing variant at h is deleted by a reorg and the
    /// canonical one takes its place; the orphan child, still linked to the deleted variant, must
    /// be unpersistable. Before this invariant the orphan was accepted via a stale hash cache and
    /// 30 further blocks were built on it, leaving the chain permanently unlinkable.
    #[test]
    fn orphan_child_of_superseded_parent_is_rejected() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();

        let base = mb(1, [0u8; 32], 1);
        storage.save_microblock(1, &bincode::serialize(&base).unwrap()).unwrap();

        // Losing variant at h=2, and a child built on it.
        let loser = mb(2, base.hash(), 0xAA);
        storage.save_microblock(2, &bincode::serialize(&loser).unwrap()).unwrap();
        let orphan = mb(3, loser.hash(), 0xCC);

        // Reorg: the losing variant is deleted and the canonical one is stored at the same height.
        storage.delete_microblock(2).unwrap();
        let winner = mb(2, base.hash(), 0xBB);
        storage.save_microblock(2, &bincode::serialize(&winner).unwrap()).unwrap();

        // The orphan still points at the deleted variant — storage must refuse it.
        let res = storage.save_microblock(3, &bincode::serialize(&orphan).unwrap());
        assert!(res.is_err(), "child of a superseded parent must never persist");
        assert!(storage.load_microblock(3).unwrap().is_none(), "orphan must be absent from storage");

        // A child correctly linked to the winner is accepted, so the chain can move on.
        let good = mb(3, winner.hash(), 0xDD);
        storage.save_microblock(3, &bincode::serialize(&good).unwrap()).unwrap();
        assert!(storage.load_microblock(3).unwrap().is_some(), "correctly linked child must persist");
    }

    /// An ABSENT parent is not a linkage violation: pruned history, snapshot cold-join and
    /// out-of-order backfill all legitimately write a block whose parent is not held locally.
    #[test]
    fn absent_parent_is_not_a_violation() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();
        let far = mb(5000, [0x77u8; 32], 9);
        storage.save_microblock(5000, &bincode::serialize(&far).unwrap())
            .expect("absent parent must not block the write");
    }
}

#[cfg(test)]
mod tests_block_key_ordering {
    use super::*;

    /// RocksDB range ops compare BYTES. Unpadded decimal keys made "microblock_9" sort after
    /// "microblock_100", which inverted both prune-time compact_range spans and made an
    /// IteratorMode::Start scan report the wrong oldest block. Keys must sort numerically.
    #[test]
    fn height_keys_sort_numerically() {
        let heights = [0u64, 1, 9, 10, 99, 100, 1_000, 54_059, 54_060, u64::MAX];
        for w in heights.windows(2) {
            let (lo, hi) = (w[0], w[1]);
            assert!(mb_body_key(lo).as_bytes() < mb_body_key(hi).as_bytes(),
                    "body key order broken: {} vs {}", lo, hi);
            assert!(mb_hash_key(lo).as_bytes() < mb_hash_key(hi).as_bytes(),
                    "hash key order broken: {} vs {}", lo, hi);
            assert!(mb_fmt_key(lo).as_bytes() < mb_fmt_key(hi).as_bytes(),
                    "fmt key order broken: {} vs {}", lo, hi);
        }
    }

    /// The oldest-block scan parses the height back out of the key; zero padding must round-trip.
    #[test]
    fn height_key_round_trips() {
        for h in [0u64, 7, 42, 54_060, u64::MAX] {
            let k = mb_body_key(h);
            let parsed: u64 = k["microblock_".len()..].parse().expect("parse height");
            assert_eq!(parsed, h);
        }
    }
}

#[cfg(test)]
mod tests_body_delete_accounting {
    use super::*;

    static ACCT_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
        once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));

    fn mb(height: u64, parent: [u8; 32]) -> qnet_state::MicroBlock {
        qnet_state::MicroBlock::new(height, 1000 + height, parent, vec![], "genesis_node_001".to_string())
    }

    /// Baseline for the non-destructive store: this counter is what the end state must drive to
    /// zero. Today a fork rollback deletes bodies ABOVE finality, so the counter rises — asserting
    /// that here makes the future "must be 0" test falsifiable instead of decorative.
    #[test]
    fn destructive_rollback_is_counted_above_finality() {
        let _g = ACCT_LOCK.lock().unwrap();
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();

        crate::node::LAST_FINALIZED_HEIGHT.store(1, Ordering::SeqCst);
        BODY_DELETES_ABOVE_FINALITY.store(0, Ordering::Relaxed);
        BODY_DELETES_TOTAL.store(0, Ordering::Relaxed);

        let b1 = mb(1, [0u8; 32]);
        storage.save_microblock(1, &bincode::serialize(&b1).unwrap()).unwrap();
        let b2 = mb(2, b1.hash());
        storage.save_microblock(2, &bincode::serialize(&b2).unwrap()).unwrap();

        // Height 2 sits above the finality floor — deleting it is exactly what the tree must end.
        storage.delete_microblock(2).unwrap();

        assert_eq!(BODY_DELETES_TOTAL.load(Ordering::Relaxed), 1);
        assert_eq!(BODY_DELETES_ABOVE_FINALITY.load(Ordering::Relaxed), 1,
                   "a body deleted above finality must be counted — this is the invariant to eliminate");

        // A delete at or below the floor is legitimate finality pruning and must NOT be flagged.
        storage.delete_microblock(1).unwrap();
        assert_eq!(BODY_DELETES_TOTAL.load(Ordering::Relaxed), 2);
        assert_eq!(BODY_DELETES_ABOVE_FINALITY.load(Ordering::Relaxed), 1,
                   "pruning at/below finality must not count as a destructive delete");

        crate::node::LAST_FINALIZED_HEIGHT.store(0, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests_header_index {
    use super::*;

    fn mb(height: u64, parent: [u8; 32], producer: &str) -> qnet_state::MicroBlock {
        let mut b = qnet_state::MicroBlock::new(height, 1000 + height, parent, vec![], producer.to_string());
        b.state_root = [height as u8; 32];
        b
    }

    /// The header index is the content-addressed replacement for height-keyed parent resolution.
    /// It must round-trip every field the reorg walk needs, and answer only for hashes actually stored.
    #[test]
    fn header_round_trips_and_is_content_addressed() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();

        let b1 = mb(1, [0u8; 32], "genesis_node_001");
        storage.save_microblock(1, &bincode::serialize(&b1).unwrap()).unwrap();
        let b2 = mb(2, b1.hash(), "genesis_node_002");
        storage.save_microblock(2, &bincode::serialize(&b2).unwrap()).unwrap();

        let h2 = storage.header_by_hash(&b2.hash()).expect("header present");
        assert_eq!(h2.height, 2);
        assert_eq!(h2.previous_hash, b1.hash(), "parent is resolvable by content, not by height");
        assert_eq!(h2.producer, "genesis_node_002");
        assert_eq!(h2.state_root, [2u8; 32]);

        // Walking ancestry uses only hashes — no height arithmetic anywhere.
        let h1 = storage.header_by_hash(&h2.previous_hash).expect("parent header present");
        assert_eq!(h1.height, 1);
        assert_eq!(h1.previous_hash, [0u8; 32]);

        // An unknown hash must answer None, never a neighbouring block.
        assert!(storage.header_by_hash(&[0xEEu8; 32]).is_none());
    }

    /// A height-keyed lookup goes stale when its height is rolled back; a hash-keyed one cannot,
    /// because a different block has a different key. This is the property the redesign buys.
    #[test]
    fn header_survives_rollback_of_a_different_block() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();

        let b1 = mb(1, [0u8; 32], "genesis_node_001");
        storage.save_microblock(1, &bincode::serialize(&b1).unwrap()).unwrap();
        let loser = mb(2, b1.hash(), "loser");
        storage.save_microblock(2, &bincode::serialize(&loser).unwrap()).unwrap();

        storage.delete_microblock(2).unwrap();
        let winner = mb(2, b1.hash(), "winner");
        storage.save_microblock(2, &bincode::serialize(&winner).unwrap()).unwrap();

        // Both hashes remain distinct keys; the winner resolves, and the height they share is
        // irrelevant to the lookup.
        assert_eq!(storage.header_by_hash(&winner.hash()).map(|h| h.producer), Some("winner".to_string()));
        assert_eq!(storage.header_by_hash(&b1.hash()).map(|h| h.height), Some(1));
    }
}

#[cfg(test)]
mod tests_slot_api {
    use super::*;

    fn chain(storage: &Storage, n: u64) -> Vec<qnet_state::MicroBlock> {
        let mut out = Vec::new();
        let mut parent = [0u8; 32];
        for h in 1..=n {
            let b = qnet_state::MicroBlock::new(h, 1000 + h, parent, vec![], "genesis_node_001".to_string());
            parent = b.hash();
            storage.save_microblock(h, &bincode::serialize(&b).unwrap()).unwrap();
            out.push(b);
        }
        out
    }

    /// The slot API must be equivalent to the height-keyed reads it will replace, block for block.
    /// Proving equivalence BEFORE the storage layout changes is what makes the later cut-over safe.
    #[test]
    fn slot_api_matches_height_reads() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();
        let blocks = chain(&storage, 200);

        for b in &blocks {
            let h = b.height;
            assert_eq!(storage.canonical_hash_at(h), Some(b.hash()));
            assert_eq!(storage.slot_status(h), SlotStatus::Block(b.hash()));
            assert_eq!(storage.load_canonical_body(h).map(|x| x.hash()), Some(b.hash()));
            assert_eq!(storage.load_body_by_hash(&b.hash()).map(|x| x.height), Some(h));
        }

        // A slot nobody filled answers Unknown, and lookups return nothing rather than a neighbour.
        assert_eq!(storage.slot_status(201), SlotStatus::Unknown);
        assert!(storage.load_canonical_body(201).is_none());
        assert!(storage.load_body_by_hash(&[0x5Au8; 32]).is_none());
    }

    /// Iteration must step over gaps rather than treat them as missing blocks.
    #[test]
    fn next_present_height_skips_gaps() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();
        let blocks = chain(&storage, 5);

        // Remove the middle slot to simulate a gap (a burned slot once slots are exclusive).
        storage.delete_microblock(3).unwrap();

        assert_eq!(storage.next_present_height(1, 5), Some(1));
        assert_eq!(storage.next_present_height(3, 5), Some(4), "iteration must skip the gap");
        assert_eq!(storage.next_present_height(6, 10), None);
        assert_eq!(storage.slot_status(3), SlotStatus::Unknown);
        assert_eq!(blocks.len(), 5);
    }
}

#[cfg(test)]
mod tests_branch_retention {
    use super::*;

    fn blk(height: u64, parent: [u8; 32], producer: &str) -> qnet_state::MicroBlock {
        qnet_state::MicroBlock::new(height, 1000 + height, parent, vec![], producer.to_string())
    }

    /// The core of the non-destructive store: a competing block at an occupied slot is REFUSED the
    /// canonical alias but its bytes are kept, addressed by hash. Before this, the loser's bytes
    /// were dropped on the floor — which is why resolving a fork required re-downloading a block
    /// the node had just been handed.
    #[test]
    fn competing_block_is_retained_not_discarded() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();

        let base = blk(1, [0u8; 32], "genesis_node_001");
        storage.save_microblock(1, &bincode::serialize(&base).unwrap()).unwrap();

        let a = blk(2, base.hash(), "producer_a");
        storage.save_microblock(2, &bincode::serialize(&a).unwrap()).unwrap();

        // A different block for the same slot: refused the canonical alias...
        let b = blk(2, base.hash(), "producer_b");
        let res = storage.save_microblock(2, &bincode::serialize(&b).unwrap());
        assert!(res.is_err(), "the canonical slot stays with the incumbent");

        // ...but retained as a branch and fully loadable by hash.
        let loaded = storage.load_body_by_hash(&b.hash()).expect("loser body retained");
        assert_eq!(loaded.producer, "producer_b");
        assert_eq!(loaded.height, 2);
        assert_eq!(storage.canonical_hash_at(2), Some(a.hash()), "canonical slot unchanged");

        // Both branches leaving the shared parent are enumerable — fork-choice can compare them.
        let mut kids = storage.children_of(&base.hash());
        kids.sort();
        let mut want = vec![a.hash(), b.hash()];
        want.sort();
        assert_eq!(kids, want, "both branches must be visible from their common parent");
    }

    /// A retained branch must never masquerade as canonical: it has no alias and does not move the
    /// chain height, so nothing downstream can mistake it for the chain.
    #[test]
    fn retained_branch_is_not_canonical() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();

        let base = blk(1, [0u8; 32], "genesis_node_001");
        storage.save_microblock(1, &bincode::serialize(&base).unwrap()).unwrap();
        let height_before = storage.get_chain_height().unwrap_or(0);

        let orphan_branch = blk(2, base.hash(), "producer_b");
        storage.retain_branch_block(&orphan_branch, &bincode::serialize(&orphan_branch).unwrap());

        assert_eq!(storage.get_chain_height().unwrap_or(0), height_before, "branch must not move the tip");
        assert_eq!(storage.canonical_hash_at(2), None, "branch must not claim the slot");
        assert!(storage.load_body_by_hash(&orphan_branch.hash()).is_some(), "branch stays loadable");
        assert_eq!(storage.slot_status(2), SlotStatus::Unknown);
    }
}

#[cfg(test)]
mod tests_branch_pruning {
    use super::*;

    fn blk(height: u64, parent: [u8; 32], producer: &str) -> qnet_state::MicroBlock {
        qnet_state::MicroBlock::new(height, 1000 + height, parent, vec![], producer.to_string())
    }

    /// Retained branches must not accumulate forever. Finality is irreversible, so a losing sibling
    /// at or below it can never be adopted — pruning exactly those bounds the tree, while the
    /// canonical block at the same height is always kept.
    #[test]
    fn pruning_drops_losers_and_keeps_the_canonical_block() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();

        let base = blk(1, [0u8; 32], "genesis_node_001");
        storage.save_microblock(1, &bincode::serialize(&base).unwrap()).unwrap();
        let winner = blk(2, base.hash(), "winner");
        storage.save_microblock(2, &bincode::serialize(&winner).unwrap()).unwrap();
        let loser = blk(2, base.hash(), "loser");
        let _ = storage.save_microblock(2, &bincode::serialize(&loser).unwrap());

        assert!(storage.load_body_by_hash(&loser.hash()).is_some(), "loser retained before pruning");

        let pruned = storage.prune_branches_below_finality(2);
        assert!(pruned >= 1, "the losing sibling must be pruned once its height is final");

        assert!(storage.load_body_by_hash(&loser.hash()).is_none(), "loser gone after finality");
        assert!(storage.load_body_by_hash(&winner.hash()).is_some(), "canonical block must survive");
        assert_eq!(storage.canonical_hash_at(2), Some(winner.hash()));
    }

    /// Branches above the finality floor are still live candidates and must be left alone.
    #[test]
    fn pruning_leaves_unfinalized_branches_intact() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();

        let base = blk(1, [0u8; 32], "genesis_node_001");
        storage.save_microblock(1, &bincode::serialize(&base).unwrap()).unwrap();
        let winner = blk(2, base.hash(), "winner");
        storage.save_microblock(2, &bincode::serialize(&winner).unwrap()).unwrap();
        let loser = blk(2, base.hash(), "loser");
        let _ = storage.save_microblock(2, &bincode::serialize(&loser).unwrap());

        // Finality still at height 1 — height 2 is contested and must stay fully inspectable.
        storage.prune_branches_below_finality(1);
        assert!(storage.load_body_by_hash(&loser.hash()).is_some(), "an unfinalized branch must survive");
        assert_eq!(storage.children_of(&base.hash()).len(), 2, "fork-choice still sees both branches");
    }
}

#[cfg(test)]
mod tests_branch_walk_after_rollback {
    use super::*;

    fn blk(height: u64, parent: [u8; 32], producer: &str) -> qnet_state::MicroBlock {
        qnet_state::MicroBlock::new(height, 1000 + height, parent, vec![], producer.to_string())
    }

    /// The branch walk must see exactly ONE successor after a rollback, or adoption gives up and
    /// the node re-downloads a block it already holds. That requires deleting a block to also drop
    /// the child link naming it — otherwise the removed canonical block lingers as a phantom
    /// sibling and every walk hits a fork it cannot resolve.
    #[test]
    fn deleted_block_leaves_no_phantom_child_link() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();

        let base = blk(1, [0u8; 32], "genesis_node_001");
        storage.save_microblock(1, &bincode::serialize(&base).unwrap()).unwrap();

        // Canonical child, plus a competing branch retained at the same height.
        let canonical = blk(2, base.hash(), "canonical");
        storage.save_microblock(2, &bincode::serialize(&canonical).unwrap()).unwrap();
        let branch = blk(2, base.hash(), "branch");
        let _ = storage.save_microblock(2, &bincode::serialize(&branch).unwrap());
        assert_eq!(storage.children_of(&base.hash()).len(), 2, "both are visible while both exist");

        // Rollback removes the canonical child; its ancestry rows must go with it.
        storage.delete_microblock(2).unwrap();

        let kids = storage.children_of(&base.hash());
        assert_eq!(kids, vec![branch.hash()],
                   "only the retained branch may remain — a phantom link would stall the walk");
        assert!(storage.header_by_hash(&canonical.hash()).is_none(),
                "the deleted block must not stay resolvable by hash");
        assert!(storage.load_body_by_hash(&branch.hash()).is_some(),
                "the surviving branch must be loadable so the walk can continue locally");
    }

    /// Pruning an expired body must take its ancestry rows too, or the metadata CF grows forever
    /// on the tier whose whole purpose is bounding disk.
    #[test]
    fn body_pruning_reclaims_ancestry_rows() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();

        let mut parent = [0u8; 32];
        let mut hashes = Vec::new();
        for h in 1..=5u64 {
            let b = blk(h, parent, "genesis_node_001");
            parent = b.hash();
            hashes.push(b.hash());
            storage.save_microblock(h, &bincode::serialize(&b).unwrap()).unwrap();
        }
        assert!(storage.header_by_hash(&hashes[0]).is_some());

        // Retain nothing; prune bodies older than the last 2 blocks.
        let pruned = storage.prune_old_microblock_bodies(5, 2).unwrap_or(0);
        assert!(pruned > 0, "expected some bodies to be pruned");

        assert!(storage.header_by_hash(&hashes[0]).is_none(),
                "ancestry rows must be reclaimed with the body they describe");
        assert!(storage.canonical_hash_at(1).is_some(),
                "the height→hash alias is kept: continuity checks still need it");
    }
}

#[cfg(test)]
mod tests_canonical_parent_gate {
    use super::*;

    fn blk(height: u64, parent: [u8; 32], producer: &str) -> qnet_state::MicroBlock {
        qnet_state::MicroBlock::new(height, 1000 + height, parent, vec![], producer.to_string())
    }

    /// THE test the previous 250 did not cover, and the one that catches the regression the audit
    /// found: a child naming a parent we HOLD (as a retained branch) but which is NOT the canonical
    /// occupant of the preceding slot must be REJECTED. Asking only "do we hold this hash?" is a
    /// tautology — the claimed hash answers for itself — and would admit exactly the orphan class
    /// the whole redesign exists to eliminate, with the header index as the stale oracle.
    #[test]
    fn child_of_a_non_canonical_parent_is_rejected() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = Storage::new(dir.path().to_str().unwrap()).unwrap();

        let base = blk(1, [0u8; 32], "genesis_node_001");
        storage.save_microblock(1, &bincode::serialize(&base).unwrap()).unwrap();

        // Canonical block at slot 2, plus a competing branch retained at the same slot.
        let canonical = blk(2, base.hash(), "canonical");
        storage.save_microblock(2, &bincode::serialize(&canonical).unwrap()).unwrap();
        let branch = blk(2, base.hash(), "branch");
        let _ = storage.save_microblock(2, &bincode::serialize(&branch).unwrap());
        assert!(storage.load_body_by_hash(&branch.hash()).is_some(), "branch is held");

        // A child of the RETAINED (non-canonical) block must not be persisted: its parent is held,
        // but it is not the canonical parent for slot 2.
        let child_of_branch = blk(3, branch.hash(), "child");
        let res = storage.save_microblock(3, &bincode::serialize(&child_of_branch).unwrap());
        assert!(res.is_err(), "a child of a non-canonical parent must be refused the chain");
        assert!(storage.load_microblock(3).unwrap().is_none(), "and must not reach storage");

        // The child of the CANONICAL parent is accepted, so the chain still moves.
        let child_of_canonical = blk(3, canonical.hash(), "child_ok");
        storage.save_microblock(3, &bincode::serialize(&child_of_canonical).unwrap()).unwrap();
        assert_eq!(storage.canonical_hash_at(3), Some(child_of_canonical.hash()));
    }
}

#[cfg(test)]
mod tests_cf_coverage {
    use super::*;

    /// A CF that `open_cf_descriptors` creates but the flush/compaction sweeps skip pins the WAL
    /// forever — RocksDB releases a log segment only once EVERY CF has flushed past it. That is how
    /// the previous hand-maintained copies leaked 1.8 GB in 23 h. Scanning the source is the only
    /// check that cannot itself drift.
    #[test]
    fn all_cf_names_covers_every_descriptor() {
        let src = include_str!("storage.rs");
        let mut declared: Vec<&str> = Vec::new();
        for (i, _) in src.match_indices("ColumnFamilyDescriptor::new(\"") {
            let rest = &src[i + "ColumnFamilyDescriptor::new(\"".len()..];
            let end = rest.find('"').expect("unterminated CF name");
            declared.push(&rest[..end]);
        }
        assert!(declared.len() >= 20, "descriptor scan found only {} CFs — parser drifted", declared.len());
        for cf in &declared {
            assert!(ALL_CF_NAMES.contains(cf),
                    "CF {:?} is created but missing from ALL_CF_NAMES — its memtable is never flushed                      and it will pin the WAL", cf);
        }
        for cf in ALL_CF_NAMES.iter() {
            assert!(declared.contains(cf),
                    "ALL_CF_NAMES lists {:?} but no descriptor creates it — the sweeps silently skip it", cf);
        }
    }
}

#[cfg(test)]
mod tests_storage_format_gate {
    use super::*;

    /// The wipe requirement must be enforced by the code, not by remembering it. Old data has no
    /// hash-addressed index and different struct layouts, so opening it would mis-read the chain
    /// rather than error — failing at startup is the only safe outcome.
    #[test]
    fn populated_store_from_an_older_format_refuses_to_open() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().to_str().unwrap().to_string();

        // Fresh directory opens and gets stamped with the current format.
        {
            let storage = Storage::new(&path).expect("fresh store opens");
            let b = qnet_state::MicroBlock::new(1, 1001, [0u8; 32], vec![], "genesis_node_001".to_string());
            storage.save_microblock(1, &bincode::serialize(&b).unwrap()).unwrap();
        }
        // Re-opening the same, correctly-versioned store must work.
        {
            let _storage = Storage::new(&path).expect("same-format store re-opens");
        }

        // Simulate data written by an older build: chain data present, version marker absent.
        {
            let storage = Storage::new(&path).unwrap();
            let cf = storage.persistent.db.cf_handle("metadata").unwrap();
            storage.persistent.db.delete_cf(&cf, b"storage_format_version").unwrap();
        }
        let err = Storage::new(&path);
        assert!(err.is_err(), "a populated store with no format marker must refuse to open");
    }
}

#[cfg(test)]
mod tests_prune_addr_index {
    use super::*;

    /// `tx_by_address` keys are `addr_{address}_{ts:016x}_{tx_hash}`, and a QNet address itself
    /// contains no delimiter guarantee — the timestamp must be located from the RIGHT or the
    /// prune reads garbage and either spares everything or deletes live rows.
    #[test]
    fn addr_index_height_is_parsed_from_the_right() {
        let key = format!("addr_{}_{:016x}_{}", "abc123def", 1_786_600u64, "f00dbabe");
        assert_eq!(Storage::addr_index_height(key.as_bytes()), Some(1_786_600));

        // An address carrying underscores must not shift the field.
        let odd = format!("addr_{}_{:016x}_{}", "node_registry_alias", 42u64, "deadbeef");
        assert_eq!(Storage::addr_index_height(odd.as_bytes()), Some(42));

        // Malformed rows are skipped, never treated as height 0 (which would delete them).
        assert_eq!(Storage::addr_index_height(b"addr_only"), None);
        assert_eq!(Storage::addr_index_height(b"addr_x_zzzz_hash"), None);
    }
}

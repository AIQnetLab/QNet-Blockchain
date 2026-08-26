//! Persistent storage implementation for QNet blockchain
mod blocks;
mod contracts;
mod reward_store;
mod chain_reads;
mod compression;
mod roster;
mod registry;
mod node_records;
mod snapshots;
mod persistent;

pub(crate) use rocksdb::{DB, Options, ColumnFamily, ColumnFamilyDescriptor, WriteBatch};
pub(crate) use qnet_state::Transaction;
pub(crate) use crate::errors::{IntegrationError, IntegrationResult};
pub(crate) use std::path::Path;
pub(crate) use std::collections::HashMap;
pub(crate) use std::time::{SystemTime, UNIX_EPOCH};
pub(crate) use std::sync::Arc;
pub(crate) use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
// FIX L-M22: parking_lot::RwLock for TransactionPool (non-poisoning, faster)
pub(crate) use parking_lot::RwLock;
pub(crate) use hex;
pub(crate) use sha3::Digest;
pub(crate) use bincode;
pub(crate) use serde_json::json;
pub(crate) use serde::{Serialize, Deserialize};
pub(crate) use chrono;

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
    pub fn save_highest_signed_mark(&self, height: u64, round: u64) -> IntegrationResult<()> {
        self.persistent.save_highest_signed_mark(height, round)
    }

    pub fn load_highest_signed_mark(&self) -> IntegrationResult<Option<(u64, u64)>> {
        self.persistent.load_highest_signed_mark()
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
        let src = include_str!("persistent.rs");
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

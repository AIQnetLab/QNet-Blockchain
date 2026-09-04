//! Simplified Regional P2P Network
//! 
//! Simple and efficient P2P with basic regional clustering.
//! No complex intelligent switching - just regional awareness with failover.
mod transport;
mod peer_table;
mod background_tasks;
mod shred;
mod queries;
mod certificates;
mod kademlia;
mod peers;
mod propagation;
mod dispatch;
mod sync_serve;
mod consensus_msgs;

pub(crate) use std::collections::{HashMap, HashSet};
pub(crate) use std::sync::Arc;
pub(crate) use parking_lot::{Mutex, RwLock};
pub(crate) use std::sync::atomic::{AtomicU64, AtomicBool, AtomicUsize, Ordering};
pub(crate) use tokio::sync::Semaphore;
pub(crate) use dashmap::{DashMap, DashSet};
pub(crate) use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
pub(crate) use once_cell::sync::Lazy;
pub(crate) use std::thread;
pub(crate) use serde::{Serialize, Deserialize};
pub(crate) use rand;
pub(crate) use serde_json;
pub(crate) use base64::Engine;
pub(crate) use sha3::{Sha3_256, Digest};
pub(crate) use reed_solomon_erasure::galois_8::ReedSolomon;
pub(crate) use futures::future;

// Import QNet consensus components for proper peer validation

// ============================================================================
// PRODUCTION CONSTANTS: Capacity limits for scalability
// ============================================================================

/// Max Light nodes in RAM registry (LRU eviction when exceeded). Role-dependent: genesis nodes
/// ping + shard the FULL sorted registry so they must hold it all (10M × ~200B ≈ 2GB, genesis-class
/// servers); non-genesis supers only relay registrations to genesis — a bounded cache suffices.
const MAX_LIGHT_NODE_REGISTRY_SIZE: usize = 100_000;
const MAX_LIGHT_NODE_REGISTRY_SIZE_GENESIS: usize = 10_000_000;

/// Registry capacity for THIS node's role.
fn light_registry_cap() -> usize {
    let is_genesis = std::env::var("QNET_BOOTSTRAP_ID")
        .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
        .unwrap_or(false);
    if is_genesis { MAX_LIGHT_NODE_REGISTRY_SIZE_GENESIS } else { MAX_LIGHT_NODE_REGISTRY_SIZE }
}

/// Max attestations in RAM (24h window, auto-cleanup).
/// An entry holds TWO enveloped ML-DSA-65 signatures plus the challenge — see the field annotations
/// on LightNodeAttestation — so it is kilobytes, not the ~300 bytes an earlier note assumed. Budget
/// hundreds of MB at this count, and size it against the real struct rather than a per-entry guess.
const MAX_ATTESTATIONS_SIZE: usize = 100_000;

/// Max heartbeat records in RAM (24h window, auto-cleanup)
/// 100K records × ~200 bytes = ~20MB RAM
#[allow(dead_code)]
const MAX_HEARTBEATS_SIZE: usize = 100_000;

/// Max active Super nodes tracked
/// 10K nodes × ~150 bytes = ~1.5MB RAM
#[allow(dead_code)]
const MAX_ACTIVE_NODES_SIZE: usize = 10_000;

/// Max connected peers (Super nodes) to prevent phantom peer accumulation
/// SCALABILITY: 1000 peers × ~200 bytes = ~200KB RAM
/// LRU eviction when limit reached
const MAX_CONNECTED_PEERS: usize = 1000;

/// Max peers admitted from ONE PeerListResponse. A responder may return its whole table,
/// so admitting a full response hands one gossiper the shape of our peer set; discovery
/// converges over repeated exchange cycles instead.
const MAX_GOSSIP_ADMITS_PER_RESPONSE: usize = 16;

/// Max entries EXAMINED from one PeerListResponse. The admit cap alone bounds insertions, not the
/// per-message work: a response can carry thousands of unbindable entries, and walking them all
/// costs a scan plus a log line each. Work per message stays constant at any network size.
const MAX_GOSSIP_PEERS_SCANNED: usize = 64;

/// Max dial candidates held per region. The establishment sweep walks each Vec in full, so an
/// unbounded list is both a heap sink and a CPU sink; oldest non-genesis candidate is evicted.
const MAX_REGIONAL_PEERS_PER_REGION: usize = 256;

/// FIX R23-P1: Minimum reserved outbound slots — prevents eclipse attacks.
/// Inbound connections cannot fill more than (MAX_CONNECTED_PEERS - MIN_OUTBOUND_SLOTS) slots,
/// ensuring we always maintain at least this many self-initiated connections.
const MIN_OUTBOUND_SLOTS: usize = 8;

/// FIX R23-P2: Minimum reputation to accept a new inbound peer.
/// Prevents Sybil nodes (default reputation) from connecting before proving on-chain activity.
/// Genesis nodes and bootstrap peers bypass this check.
const MIN_INBOUND_PEER_REPUTATION: f64 = 50.0;

// Network-layer eclipse defence (IP subnet diversity). One provider can spin up many cheap nodes
// from a single /24 or /16 and flood the peer table → eclipse (2f+1 protects safety only when
// attacker KEYS are bounded, not when the PEER LIST is biased). At the target of hundreds of
// thousands of Supers a healthy inbound set is spread over thousands of netblocks, so ≥124 distinct
// /16s are needed to fill the 992 inbound slots and no single hoster can own more than ~0.8% of
// them. Security parameters, never operator-tunable: a per-node override is an eclipse opt-out an
// attacker can talk a victim into. Genesis IPs and outbound peers are exempt (we chose those).
const MAX_PEERS_PER_SUBNET_24: usize = 2;
const MAX_PEERS_PER_SUBNET_16: usize = 8;

/// Stale node timeout (15 minutes without heartbeat/announcement)
#[allow(dead_code)]
const STALE_NODE_TIMEOUT_SECS: u64 = 15 * 60;

/// Attestation/Heartbeat retention (24 hours)
const RETENTION_PERIOD_SECS: u64 = 24 * 60 * 60;

// DYNAMIC NETWORK DETECTION - No timestamp dependency for robust deployment

// ═══════════════════════════════════════════════════════════════════════════
// BLOCK EXISTENCE CHECK RESULT - Emergency Production Logic
// ═══════════════════════════════════════════════════════════════════════════
/// Result of checking if block exists on network
#[derive(Debug, Clone)]
pub enum BlockExistenceResult {
    /// 2/3+ peers have block per cache → TRUST (majority consensus)
    MajorityHas { peers_with: usize, total_peers: usize },
    /// HTTP verified that block exists on network
    VerifiedExists { peer_addr: String },
    /// Cache uncertain AND HTTP verify failed/timeout
    Uncertain { cache_peers_with: usize, cache_total: usize },
    /// No peers available to check
    NoPeers,
}

impl BlockExistenceResult {
    /// Block definitely exists on network (no emergency needed)
    pub fn exists(&self) -> bool {
        matches!(self, Self::MajorityHas { .. } | Self::VerifiedExists { .. })
    }
    
    /// Should proceed with emergency production
    pub fn should_produce_emergency(&self) -> bool {
        !self.exists()
    }
}

// IMPROVED CACHING SYSTEM - Actor-based with versioning
#[derive(Debug, Clone)]
struct CachedData<T: Clone> {
    data: T,
    epoch: u64,
    timestamp: Instant,
    topology_hash: u64,
}

// Actor-based cache manager for better concurrency
struct CacheActor {
    peers_cache: Arc<RwLock<Option<CachedData<Vec<PeerInfo>>>>>,
    epoch_counter: Arc<RwLock<u64>>,
}

impl CacheActor {
    fn new() -> Self {
        Self {
            peers_cache: Arc::new(RwLock::new(None)),
            epoch_counter: Arc::new(RwLock::new(0)),
        }
    }
    
    fn increment_epoch(&self) -> u64 {
        let mut epoch = self.epoch_counter.write();
        *epoch += 1;
        *epoch
    }
    
    fn get_topology_hash(peers: &[String]) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        for peer in peers {
            peer.hash(&mut hasher);
        }
        hasher.finish()
    }
}

// Actor-based cache (single source of truth for peer cache)
static CACHE_ACTOR: Lazy<CacheActor> = Lazy::new(|| CacheActor::new());

// SYNC FIX: Track blocks currently being downloaded to prevent race conditions
#[allow(dead_code)]
static DOWNLOADING_BLOCKS: Lazy<Arc<RwLock<HashSet<u64>>>> = 
    Lazy::new(|| Arc::new(RwLock::new(HashSet::new())));

// RACE CONDITION FIX: Cache blockchain height to prevent excessive queries
static CACHED_BLOCKCHAIN_HEIGHT: Lazy<Arc<Mutex<(u64, Instant)>>> =
    Lazy::new(|| Arc::new(Mutex::new((0,
        Instant::now().checked_sub(Duration::from_secs(3600)).unwrap_or_else(Instant::now)))));

// v14.8.5: Lock-free mirror of the cached network height. Written alongside
// every update of CACHED_BLOCKCHAIN_HEIGHT; read by the stuck-chain watchdog
// and any hot-path code that needs an indicator of "where the network is"
// without taking a mutex. Not authoritative (the mutex-backed cache plus
// peer-height fallback is the source of truth for production decisions) —
// this is strictly a monitoring/liveness aid.
pub static CACHED_NETWORK_HEIGHT: AtomicU64 = AtomicU64::new(0);

// CRITICAL FIX: Local blockchain height for P2P message filtering
// This prevents processing failover messages for blocks we don't have yet
pub static LOCAL_BLOCKCHAIN_HEIGHT: Lazy<Arc<AtomicU64>> =
    Lazy::new(|| Arc::new(AtomicU64::new(0)));

/// Highest height durably stored, which can lead the applied height. Serve decisions use this:
/// refusing to serve a block we already hold removes our whole relay subtree from repair
/// service and turns local lag into network-wide propagation loss.
pub static HIGHEST_STORED_HEIGHT: Lazy<Arc<AtomicU64>> =
    Lazy::new(|| Arc::new(AtomicU64::new(0)));

/// Monotonic bump of the stored-height watermark.
pub fn note_block_stored(height: u64) {
    HIGHEST_STORED_HEIGHT.fetch_max(height, std::sync::atomic::Ordering::Relaxed);
}

/// Lower the watermark after a rollback deleted blocks above `target`. Without this the node keeps
/// advertising a serve horizon over a range it no longer holds and answers those requests with empty
/// batches forever.
pub fn truncate_stored_height(target: u64) {
    HIGHEST_STORED_HEIGHT.fetch_min(target, std::sync::atomic::Ordering::Relaxed);
}

/// Serve horizon: the highest height this node can answer for.
pub fn servable_height() -> u64 {
    LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed)
        .max(HIGHEST_STORED_HEIGHT.load(std::sync::atomic::Ordering::Relaxed))
}

// v34: last KNOWN-CANONICAL validator count — from the consensus PK registry (genesis) or
// the deterministic N-2 eligible set (normal epoch). When a node temporarily loses its
// canonical source (N-2 macroblock not yet synced), get_active_validator_count() returns
// THIS instead of a runtime live-peer count. Rationale: the live-peer count drifts ±1 as
// peers connect/disconnect within the liveness window and counts self inconsistently across
// nodes, so two nodes in the same fallback window computed DIFFERENT 2f+1 thresholds and a
// timeout cert valid to one was rejected by another → view-change split. The last canonical
// count changes only at epoch boundaries, so recently-synced nodes agree on it. 0 = never had
// a canonical count (genuine cold boot) → fall through to the live-peer estimate.
static LAST_CANONICAL_VALIDATOR_COUNT: Lazy<Arc<AtomicU64>> =
    Lazy::new(|| Arc::new(AtomicU64::new(0)));

// v9.5: Best known peer height — O(1) read for sync-gate checks.
// Updated atomically when peer heartbeats arrive (update_peer_last_seen).
// Replaces O(N) scan of active_full_super_nodes on every consensus tick.
pub static BEST_PEER_HEIGHT: AtomicU64 = AtomicU64::new(0);
/// Network-tip oracle: highest height from an authenticated (Dilithium-signed) HealthPing head,
/// direct or relayed. NEVER fed by served-block heights, so a follower's own sync progress cannot
/// poison it; the genesis (always present) keep it at the true tip. Floors get_best_peer_height.
pub static SIGNED_HEAD_MAX: AtomicU64 = AtomicU64::new(0);
/// Per-origin high-water (ts, height) of accepted signed heads: dedup + anti-replay + relay-once. Keyed on
/// BOTH so a strictly-higher height always passes even if the origin's wall-clock ts regresses (cold
/// restart / NTP step), keeping the dedup as monotonic as the height-keyed oracle it guards.
static LAST_HEAD_TS: Lazy<DashMap<String, (u64, u64)>> = Lazy::new(DashMap::new);
/// One-shot guard for the required-task bring-up: every P2P entry path may call it.
static REQUIRED_TASKS_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Latest locally-signed head, cached by the 15s emit tick. Co-sent on the serve channel and, by the
/// transport, over the live inbound connection in reply to a behind peer's HealthPing — the durable,
/// NAT-proof tip feed to a client-dialed follower the emit fan-out misses. (from, ts, height, sig).
pub(crate) static LATEST_SIGNED_HEAD: Lazy<RwLock<Option<(String, u64, u64, String)>>> = Lazy::new(|| RwLock::new(None));
/// Min height lead before we reply our signed head to a pinging peer — suppresses chatter between
/// at-tip peers; only genuine followers (behind by more than one rotation) get the reply.
pub(crate) const HEAD_REPLY_MIN_GAP: u64 = 8;
/// Re-sign LATEST_SIGNED_HEAD at most every N blocks on finality advance — per-block signing is wasted
/// at scale; the 15s emit tick is the backstop.
pub(crate) const HEAD_RESIGN_INTERVAL: u64 = 30;
/// Cached round-committee membership for the anti-forgery head clamp. members = committee node_ids for
/// the CURRENT epoch (empty in the genesis era); genesis_ids = the 5 genesis, ALWAYS unioned so the
/// corroboration anchor never lapses to empty at 100k scale (a genesis-disconnected follower still
/// corroborates via committee links). Whole-set swap, recomputed once/epoch on finality advance.
pub(crate) struct CommitteeSnapshot {
    pub epoch: u64,
    pub members: std::collections::HashSet<String>,
    pub genesis_ids: std::collections::HashSet<String>,
}
pub(crate) static CURRENT_COMMITTEE: Lazy<RwLock<std::sync::Arc<CommitteeSnapshot>>> = Lazy::new(|| {
    let genesis_ids: std::collections::HashSet<String> = (1..=crate::genesis_constants::genesis_node_count())
        .map(|i| format!("genesis_node_{:03}", i)).collect();
    RwLock::new(std::sync::Arc::new(CommitteeSnapshot { epoch: 0, members: std::collections::HashSet::new(), genesis_ids }))
});

// CRITICAL FIX: Deduplicate failover messages to prevent spam
// Store processed failover events: (block_height, failed_producer, new_producer)
// SCALABILITY: Use DashSet for lock-free concurrent access with millions of nodes
static PROCESSED_FAILOVERS: Lazy<Arc<DashSet<(u64, String, String)>>> = 
    Lazy::new(|| Arc::new(DashSet::new()));

// CRITICAL: Emergency stop flag for failed producers
// When set, prevents the node from producing blocks after emergency failover
pub static EMERGENCY_STOP_PRODUCTION: Lazy<Arc<AtomicBool>> = 
    Lazy::new(|| Arc::new(AtomicBool::new(false)));

// CRITICAL: Track when emergency stop was activated for auto-recovery
// After 10 blocks, the node can resume production
pub static EMERGENCY_STOP_HEIGHT: Lazy<Arc<AtomicU64>> = 
    Lazy::new(|| Arc::new(AtomicU64::new(0)));

// CRITICAL FIX: Track TIME of emergency stop to prevent deadlock
// Recovery after 10 seconds (not blocks) to avoid infinite wait
pub static EMERGENCY_STOP_TIME: Lazy<Arc<AtomicU64>> = 
    Lazy::new(|| Arc::new(AtomicU64::new(0)));

// v3.4 CRITICAL: Track when block broadcast is in progress
// Emergency messages MUST be ignored while broadcasting to prevent partial block transmission
// Race condition: emergency arrives mid-broadcast → only certificate sent, data lost → all nodes stuck
pub static BLOCK_BROADCAST_IN_PROGRESS: Lazy<Arc<AtomicBool>> = 
    Lazy::new(|| Arc::new(AtomicBool::new(false)));

// CRITICAL: Track emergency failovers in progress to prevent race conditions
// Format: "emergency_failover_{height}" -> prevents multiple nodes from initiating same failover
// SCALABILITY: DashSet for lock-free concurrent access with millions of nodes
static EMERGENCY_FAILOVERS_IN_PROGRESS: Lazy<Arc<DashSet<String>>> = 
    Lazy::new(|| Arc::new(DashSet::new()));

// v3.0: CRITICAL FIX - Track blocks pending in sync queue to prevent duplicates
// When sync_blocks requests from 3 peers, each peer sends same blocks
// Without tracking: 2000 blocks × 3 peers = 6000 queue entries = OOM
// DashMap for lock-free concurrent access with timestamp for TTL
// Key: block height, Value: timestamp when added (for TTL cleanup)
static PENDING_SYNC_BLOCKS: Lazy<DashMap<u64, u64>> = 
    Lazy::new(|| DashMap::new());

// v11.0: Maximum blocks in sync queue before backpressure
// Increased from 1000 to 2000 — completion-based cleanup prevents TTL cycling
const MAX_PENDING_SYNC_BLOCKS: usize = 2000;

// v11.0: REMOVED TTL-based cleanup — replaced with completion-based cleanup
// Old TTL (60s) caused infinite remove/re-add cycles: blocks removed by timer,
// re-added by retry → sync never progresses. Now blocks stay in pending until
// explicitly completed (stored) or failed (max retries exhausted).
// Kept as fallback safety net: 5 minutes (was 60s)
const PENDING_SYNC_BLOCK_TTL_SECS: u64 = 300;

// v11.0: Soft limit before cleanup triggers (80% of max)
const SOFT_LIMIT_PENDING_SYNC_BLOCKS: usize = 1600;

// v30.A3: freshness window for peer height attestation. A peer's
// last_block_height is consulted for `network_height` ONLY if its
// last_height_attested_at falls within this window. Attestation is set ONLY by
// the authenticated signed-head (signed HealthPing / verified handshake) — never
// by served-block heights (an availability fact, not a tip) or empty-batch echo.
// 120 s ≈ 1 macroblock (90 microblocks × 1 s slot + jitter): a peer that
// hasn't emitted a signed height in 2 minutes is treated as height-unknown,
// preventing stale or poisoned values from steering sync indefinitely.
const PEER_HEIGHT_ATTEST_TTL_SECS: u64 = 120;
/// Signed-head emit cadence. The boot delay is short because the attestation it produces is the
/// ONLY renewable peer-height writer: both handshake writers are guarded on block_height > 0 and
/// every node handshakes at 0 on a fresh genesis.
pub const HEALTH_PING_BOOT_DELAY_SECS: u64 = 5;
pub const HEALTH_PING_INTERVAL_SECS: u64 = 15;
// Max a real head may sit above the genesis-attested median (1 macroblock): covers attest-staleness +
// genesis spread; a head beyond it is a forged over-claim and is overruled by the median.
const HEAD_OVERCLAIM_MARGIN: u64 = 90;

/// Widened-oracle head ceiling, TYPE-quarantined: only the registration arm-liveness ladder consumes
/// it; every sync/failover/clamp consumer takes u64 and cannot accept this by accident. Never unwrap
/// .0 into a sync target or consensus input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WidenedCeiling(pub u64);

/// Max deficit an armable joiner may show against the WIDENED ceiling / capsule floor:
/// strict-tier deficit bound + one GALC mint interval (capsule cadence lag) + finality window
/// (K finalizing → its capsule minting). Linked to the canonical constants so a retune of either
/// cannot silently desync the widened envelope from the strict bound / real mint cadence.
pub const DEFICIT_BOUND_WIDE: u64 =
    crate::node::DEFICIT_BOUND
    + crate::galc::GALC_MINT_INTERVAL * qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL
    + 180;

/// v3.0: Check if block is already pending in sync queue
pub fn is_block_pending_sync(height: u64) -> bool {
    PENDING_SYNC_BLOCKS.contains_key(&height)
}

/// v2.104: Cleanup stale and outdated entries from pending sync queue
/// ═══════════════════════════════════════════════════════════════════════════
/// PROBLEM: When sync queue fills up (1000 entries), new blocks are dropped.
/// If dropped blocks include critical heights, sync deadlocks.
///
/// SOLUTION: Proactive cleanup of stale/outdated entries:
/// 1. Stale: Entries older than TTL (60s) - likely failed to process
/// 2. Outdated: Heights below local_height-10 - already processed or irrelevant
///
/// Returns number of entries removed
/// ═══════════════════════════════════════════════════════════════════════════
pub fn cleanup_pending_sync_blocks() -> usize {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    
    let local_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
    let mut removed = 0usize;
    
    PENDING_SYNC_BLOCKS.retain(|height, timestamp| {
        let is_stale = now.saturating_sub(*timestamp) > PENDING_SYNC_BLOCK_TTL_SECS;
        let is_outdated = local_height > 10 && *height < local_height.saturating_sub(10);
        
        if is_stale || is_outdated {
            removed += 1;
            false
        } else {
            true
        }
    });
    
    if removed > 0 && crate::node::is_info() {
        println!("[INFO][SYNC] queue_cleanup removed={} remaining={}", removed, PENDING_SYNC_BLOCKS.len());
    }
    
    removed
}

/// v11.0: Mark block as pending in sync queue — COMPLETION-BASED cleanup
/// ═══════════════════════════════════════════════════════════════════════════
/// ARCHITECTURE (v11.0):
/// Blocks stay pending until EXPLICITLY completed via clear_block_pending_sync()
/// or clear_blocks_below_height(). No TTL cycling.
///
/// Cleanup strategy:
/// 1. Already-pending fresh blocks are skipped (dedup)
/// 2. Soft limit: evict blocks below local_height (already stored)
/// 3. Hard limit: evict farthest-from-local blocks (re-requestable)
/// 4. Stale safety net: 5 min TTL (was 60s) — only for truly stuck entries
///
/// Returns false if already pending or queue full after cleanup
/// ═══════════════════════════════════════════════════════════════════════════
pub fn mark_block_pending_sync(height: u64) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Dedup: if already pending and not ancient, skip
    if let Some(entry) = PENDING_SYNC_BLOCKS.get(&height) {
        let timestamp = *entry;
        if now.saturating_sub(timestamp) < PENDING_SYNC_BLOCK_TTL_SECS {
            return false;
        }
        // Safety net: entry stuck for >5 min — allow re-queue
        drop(entry);
        PENDING_SYNC_BLOCKS.remove(&height);
        if crate::node::is_debug() {
            println!("[DBG][SYNC] stale_safety_net h={} age={}s", height, now.saturating_sub(timestamp));
        }
    }

    // Soft limit: evict already-processed blocks (below local_height)
    if PENDING_SYNC_BLOCKS.len() >= SOFT_LIMIT_PENDING_SYNC_BLOCKS {
        let local_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        let before = PENDING_SYNC_BLOCKS.len();
        PENDING_SYNC_BLOCKS.retain(|h, _| *h >= local_height.saturating_sub(5));
        let removed = before.saturating_sub(PENDING_SYNC_BLOCKS.len());
        if removed > 0 && crate::node::is_info() {
            println!("[INFO][SYNC] pending_evict_below local_h={} removed={} remaining={}",
                     local_height, removed, PENDING_SYNC_BLOCKS.len());
        }
    }

    // Hard limit: evict farthest blocks from local_height
    if PENDING_SYNC_BLOCKS.len() >= MAX_PENDING_SYNC_BLOCKS {
        let local_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        let mut all_heights: Vec<u64> = PENDING_SYNC_BLOCKS.iter()
            .map(|entry| *entry.key())
            .collect();
        all_heights.sort_by_key(|h| std::cmp::Reverse(h.abs_diff(local_height)));
        // Evict top 25% farthest (was 50% — less aggressive now with larger buffer)
        let evict_count = all_heights.len() / 4;
        for h in all_heights.iter().take(evict_count) {
            PENDING_SYNC_BLOCKS.remove(h);
        }
        if crate::node::is_info() {
            println!("[INFO][SYNC] pending_evict_far local_h={} evicted={} remaining={}",
                     local_height, evict_count, PENDING_SYNC_BLOCKS.len());
        }

        if PENDING_SYNC_BLOCKS.len() >= MAX_PENDING_SYNC_BLOCKS {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] pending_full size={} rejecting={}", PENDING_SYNC_BLOCKS.len(), height);
            }
            return false;
        }
    }

    PENDING_SYNC_BLOCKS.insert(height, now).is_none()
}

/// v11.0: Bulk-clear all pending entries at or below given height
/// Called when local_height advances — these blocks are already stored
pub fn clear_blocks_below_height(height: u64) {
    let before = PENDING_SYNC_BLOCKS.len();
    PENDING_SYNC_BLOCKS.retain(|h, _| *h > height);
    let removed = before.saturating_sub(PENDING_SYNC_BLOCKS.len());
    if removed > 0 && crate::node::is_debug() {
        println!("[DBG][SYNC] pending_clear_below h={} removed={} remaining={}",
                 height, removed, PENDING_SYNC_BLOCKS.len());
    }
}

/// v3.0: Remove block from pending set after processing
pub fn clear_block_pending_sync(height: u64) {
    PENDING_SYNC_BLOCKS.remove(&height);
}

/// v3.0: Clear all pending sync blocks (emergency cleanup)
pub fn clear_all_pending_sync() {
    PENDING_SYNC_BLOCKS.clear();
}

/// v3.0: Get current pending sync queue size
pub fn get_pending_sync_count() -> usize {
    PENDING_SYNC_BLOCKS.len()
}

// ═══════════════════════════════════════════════════════════════════════════════
// v14.2: SYNC PEER COOL-DOWN TRACKER
// ═══════════════════════════════════════════════════════════════════════════════
// When a peer fails to respond to a sync request, record the failure. Subsequent
// wave attempts de-prioritise (or skip) peers whose last failure was within the
// cool-down window. This guarantees retry peer rotation: a stalled peer does not
// block sync forever by being at the top of the sort order.
//
// Entry: peer_id → (last_failure_ts, consecutive_failures)
// Cool-down scales with consecutive failures (exponential back-off, capped).
// Entry expires after a successful response or full cool-down.
// ═══════════════════════════════════════════════════════════════════════════════
pub static SYNC_PEER_COOLDOWN: Lazy<DashMap<String, (u64, u32)>> =
    Lazy::new(|| DashMap::new());


/// Cool-down window for a peer based on consecutive failure count (seconds).
/// Failure 1 → 5s, 2 → 15s, 3+ → 45s (capped).
pub fn sync_peer_cooldown_secs(failures: u32) -> u64 {
    match failures {
        0 => 0,
        1 => 5,
        2 => 15,
        _ => 45,
    }
}

/// Returns true if peer is in active cool-down window (should be skipped for sync).
pub fn is_sync_peer_cooling_down(peer_id: &str) -> bool {
    if let Some(entry) = SYNC_PEER_COOLDOWN.get(peer_id) {
        let (last_ts, failures) = *entry.value();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let cooldown = sync_peer_cooldown_secs(failures);
        return now.saturating_sub(last_ts) < cooldown;
    }
    false
}

/// Record a sync failure for `peer_id` (increments consecutive counter).
pub fn record_sync_peer_failure(peer_id: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    SYNC_PEER_COOLDOWN.entry(peer_id.to_string())
        .and_modify(|e| { e.0 = now; e.1 = e.1.saturating_add(1); })
        .or_insert((now, 1));
}

/// Clear cool-down on successful response (resets consecutive counter).
pub fn record_sync_peer_success(peer_id: &str) {
    SYNC_PEER_COOLDOWN.remove(peer_id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// v14.8: Per-peer local apply-quarantine (defensive isolation for bad peers).
// Orthogonal to on-chain slashing. Purely a local circuit breaker to keep
// a misbehaving peer from wasting our apply pipeline. DashMap → lock-free,
// scales cleanly to tens of thousands of peers.
// ═══════════════════════════════════════════════════════════════════════════════
/// peer_id -> (strike_count, first_strike_unix_secs)
static PEER_APPLY_STRIKES: Lazy<DashMap<String, (u32, u64)>> =
    Lazy::new(|| DashMap::new());
/// peer_id -> quarantine_expiry_unix_secs
static PEER_APPLY_QUARANTINE: Lazy<DashMap<String, u64>> =
    Lazy::new(|| DashMap::new());
/// Strikes within this rolling window count toward quarantine
const APPLY_STRIKE_WINDOW_SECS: u64 = 90;
/// Strike count at which quarantine fires
const APPLY_STRIKE_THRESHOLD: u32 = 5;
/// How long a quarantined peer stays ignored
const APPLY_QUARANTINE_TTL_SECS: u64 = 300; // 5 minutes

// ═══════════════════════════════════════════════════════════════════════════════
// v3.1: MACROBLOCK DEDUPLICATION (same pattern as microblocks)
// Macroblocks are less frequent but still need protection
// ═══════════════════════════════════════════════════════════════════════════════
static PENDING_SYNC_MACROBLOCKS: Lazy<DashMap<u64, u64>> =
    Lazy::new(|| DashMap::new());

// Macroblocks are rarer, so smaller limits
const MAX_PENDING_SYNC_MACROBLOCKS: usize = 100;
const PENDING_SYNC_MACROBLOCK_TTL_SECS: u64 = 120; // 2 minutes (longer than microblocks)

/// v3.1: Check if macroblock is already pending in sync queue
pub fn is_macroblock_pending_sync(index: u64) -> bool {
    PENDING_SYNC_MACROBLOCKS.contains_key(&index)
}

/// v3.1: Mark macroblock as pending in sync queue
/// Returns false if already pending or queue is full
/// v3.2: CRITICAL FIX - Proactive cleanup before rejecting to prevent systematic skips
pub fn mark_macroblock_pending_sync(index: u64) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // v3.36: Check if macroblock is already pending but STALE (same pattern as microblocks)
    // Without this, stale entries from failed requests permanently block re-processing:
    // response arrives → insert returns Some(old) → .is_none() = false → data discarded
    if let Some(entry) = PENDING_SYNC_MACROBLOCKS.get(&index) {
        let timestamp = *entry;
        if now.saturating_sub(timestamp) < PENDING_SYNC_MACROBLOCK_TTL_SECS {
            return false;
        }
        drop(entry);
        PENDING_SYNC_MACROBLOCKS.remove(&index);
        if crate::node::is_debug() {
            println!("[DBG][MB-SYNC] stale_pending_cleared idx={} age={}s", index, now.saturating_sub(timestamp));
        }
    }

    // v3.2: If queue is near full, do proactive cleanup FIRST
    if PENDING_SYNC_MACROBLOCKS.len() >= MAX_PENDING_SYNC_MACROBLOCKS - 10 {
        // Emergency cleanup: remove stale entries (TTL expired)
        let cutoff = now.saturating_sub(PENDING_SYNC_MACROBLOCK_TTL_SECS);
        PENDING_SYNC_MACROBLOCKS.retain(|_, &mut timestamp| timestamp > cutoff);
        
        // Also remove very old indices (far below current network height)
        // Macroblocks older than current - 50 are unlikely to be needed
        if let Some(max_idx) = PENDING_SYNC_MACROBLOCKS.iter().map(|e| *e.key()).max() {
            if max_idx > 50 {
                let min_valid = max_idx.saturating_sub(50);
                PENDING_SYNC_MACROBLOCKS.retain(|&idx, _| idx >= min_valid);
            }
        }
        
        if crate::node::is_warn() {
            println!("[WARN][MB-PENDING] queue_cleanup size={}", PENDING_SYNC_MACROBLOCKS.len());
        }
    }
    
    // Final check after cleanup
    if PENDING_SYNC_MACROBLOCKS.len() >= MAX_PENDING_SYNC_MACROBLOCKS {
        if crate::node::is_warn() {
            println!("[WARN][MB-PENDING] queue_full idx={} size={}", index, PENDING_SYNC_MACROBLOCKS.len());
        }
        return false;
    }
    
    PENDING_SYNC_MACROBLOCKS.insert(index, now).is_none()
}

/// v3.1: Remove macroblock from pending set after processing
pub fn clear_macroblock_pending_sync(index: u64) {
    PENDING_SYNC_MACROBLOCKS.remove(&index);
}

/// v3.1: Get current pending macroblock queue size
pub fn get_pending_macroblock_count() -> usize {
    PENDING_SYNC_MACROBLOCKS.len()
}

/// v3.1: Clear all pending macroblock sync entries (emergency cleanup)
pub fn clear_all_pending_sync_macroblocks() {
    PENDING_SYNC_MACROBLOCKS.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// v3.34: SYNC DEDUP — prevents thundering herd when MISSING_PREVIOUS spawns
// dozens of tokio tasks for the same height range. Only one sync_blocks request
// per height is allowed at a time; subsequent spawns for the same from_height
// are skipped until the in-flight request completes (clears the flag).
// ═══════════════════════════════════════════════════════════════════════════════

static SYNC_INFLIGHT_FROM: AtomicU64 = AtomicU64::new(0);
static SYNC_INFLIGHT_TS: AtomicU64 = AtomicU64::new(0);

/// Try to acquire sync slot for a given from_height.
/// Returns true if this caller won the slot (should proceed with sync).
/// Returns false if another sync for this height is already in-flight.
/// Auto-expires after 30 seconds to prevent stuck slots.
pub fn try_acquire_sync_slot(from_height: u64) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let prev_from = SYNC_INFLIGHT_FROM.load(Ordering::SeqCst);
    let prev_ts = SYNC_INFLIGHT_TS.load(Ordering::SeqCst);
    
    // Same height already in-flight and not expired (30s TTL)
    if prev_from == from_height && now.saturating_sub(prev_ts) < 30 {
        return false;
    }
    
    // Try to claim the slot (CAS to prevent races between tokio tasks)
    if SYNC_INFLIGHT_FROM.compare_exchange(prev_from, from_height, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        SYNC_INFLIGHT_TS.store(now, Ordering::SeqCst);
        true
    } else {
        false
    }
}

/// Release sync slot after sync completes or fails.
pub fn release_sync_slot(from_height: u64) {
    let _ = SYNC_INFLIGHT_FROM.compare_exchange(from_height, 0, Ordering::SeqCst, Ordering::SeqCst);
}


// ═══════════════════════════════════════════════════════════════════════════════
// Block-validity attestation. Fork choice stays round-based — a same-round 2f+1 TimeoutCertificate
// rotates the producer, certified-round supersede resolves a same-height dispute, and the 2f+1
// macroblock Checkpoint is finality. Attestations add none of that: they are evidence that a branch
// is being followed, so a diverged node learns it is alone within a block or two instead of at the
// next checkpoint. The earlier version admitted any registered identity and was an ungated memory
// DoS; entry now requires the height's deterministic committee slice. EmptySlotAttestation below is
// a SEPARATE producer-failover mechanism.
// ═══════════════════════════════════════════════════════════════════════════════

pub(crate) use dashmap::DashMap as AttestDashMap;

// ═══════════════════════════════════════════════════════════════════════════════





// ═══════════════════════════════════════════════════════════════════════════════
// EMPTY-SLOT ATTESTATION — DETERMINISTIC PRODUCER FAILOVER FOR MICROBLOCKS
// ═══════════════════════════════════════════════════════════════════════════════
//
// Purpose:
//   When a microblock producer fails to broadcast within the slot grace period,
//   the attestation committee signs an empty-slot attestation. Once 2f+1 distinct
//   empty-slot attestations are observed for the same (slot_height, expected_producer)
//   pair, the network deterministically advances to the next producer in rotation.
//
// Why this replaces reactive timeout_round for microblocks:
//   * Reactive timeout_round depends on local wall-clock & gossip race ordering.
//     Different nodes converge at slightly different rounds, producing
//     timeout_divergence (different `our_round` vs `block_round`) under normal
//     propagation gap.
//   * Empty-slot attestations are signed locally but aggregated supermajority-style.
//     Once 2f+1 honest validators agree the slot is empty, the failover is
//     cryptographically certified — a 2f+1 supermajority is by definition outside
//     the Byzantine bound.
//   * Convergence is bounded by attestation gossip latency (~1 RTT), not by
//     timeout grace period escalation (which scales with 1-second voting rounds).
//
// Signature format:
//   message = "QNET_EMPTY_SLOT:{slot_height}:{expected_producer}"
//   signed with the attester's ML-DSA-65 (ML-DSA-65) secret key
//
// ═══════════════════════════════════════════════════════════════════════════════

/// Single empty-slot attestation from a committee member.
///
/// Attestation declares: "I, attester, was waiting for `expected_producer` to
/// produce block at `slot_height`, but the slot grace period elapsed without
/// receiving a valid block from that producer. The slot should be treated as
/// empty and the network should advance to the next producer."
#[derive(Debug, Clone)]
pub struct EmptySlotAttestation {
    pub slot_height: u64,
    pub expected_producer: String,
    pub attester_id: String,
    pub signature: Vec<u8>,
    pub timestamp: u64,
}

/// Empty-slot attestation store: keyed by (slot_height) → Vec<EmptySlotAttestation>.
/// Multiple expected_producer values may coexist at the same slot if rotation
/// state is itself contested; threshold checks always filter on a specific
/// expected_producer to maintain BFT-safe quorum semantics.
static EMPTY_SLOT_ATTESTATIONS: once_cell::sync::Lazy<AttestDashMap<u64, Vec<EmptySlotAttestation>>> =
    once_cell::sync::Lazy::new(|| AttestDashMap::new());

/// Submit an empty-slot attestation.
/// Deduplication: one entry per (slot_height, attester_id, expected_producer).
pub fn submit_empty_slot_attestation(attestation: EmptySlotAttestation) {
    let h = attestation.slot_height;
    let mut entry = EMPTY_SLOT_ATTESTATIONS
        .entry(h)
        .or_insert_with(Vec::new);
    let already = entry.iter().any(|a|
        a.attester_id == attestation.attester_id
            && a.expected_producer == attestation.expected_producer
    );
    if !already {
        entry.push(attestation);
    }
}

/// Count empty-slot attestations for a given (slot_height, expected_producer).
pub fn get_empty_slot_attestation_count(slot_height: u64, expected_producer: &str) -> usize {
    EMPTY_SLOT_ATTESTATIONS
        .get(&slot_height)
        .map(|v| v.iter().filter(|a| a.expected_producer == expected_producer).count())
        .unwrap_or(0)
}

/// All empty-slot attestations for a given slot height (any producer).
pub fn get_empty_slot_attestations(slot_height: u64) -> Vec<EmptySlotAttestation> {
    EMPTY_SLOT_ATTESTATIONS
        .get(&slot_height)
        .map(|v| v.clone())
        .unwrap_or_default()
}

/// Cleanup empty-slot attestations older than 100 blocks behind current tip.
/// Called from the same cleanup path as block attestations.
pub fn cleanup_old_empty_slot_attestations(current_height: u64) {
    if current_height <= 100 { return; }
    let cutoff = current_height - 100;
    EMPTY_SLOT_ATTESTATIONS.retain(|h, _| *h > cutoff);
}

/// v3.1: Cleanup stale entries from PENDING_SYNC_MACROBLOCKS
pub fn cleanup_pending_sync_macroblocks() -> usize {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let cutoff = now.saturating_sub(PENDING_SYNC_MACROBLOCK_TTL_SECS);
    let before = PENDING_SYNC_MACROBLOCKS.len();
    PENDING_SYNC_MACROBLOCKS.retain(|_, &mut timestamp| timestamp > cutoff);
    before.saturating_sub(PENDING_SYNC_MACROBLOCKS.len())
}

// PRODUCTION: Peer cleanup interval
// NOTE: cleanup_pending_sync_blocks() is defined once at line ~220 (v2.105 - removed duplicate)
// Clean up inactive peers after 30 minutes (reasonable timeout for network health)
// NOTE: Independent from certificate lifetime (270s) - peers can be temporarily inactive
const PEER_INACTIVE_TIMEOUT_SECS: u64 = 1800; // 30 minutes - balanced cleanup interval

// PRODUCTION: Unified HTTP client settings for consistency and scalability
const HTTP_CONNECT_TIMEOUT_SECS: u64 = 3;  // Quick connect for P2P
const HTTP_TCP_KEEPALIVE_SECS: u64 = 30;   // Keep connections alive
const HTTP_POOL_IDLE_TIMEOUT_SECS: u64 = 90; // Reuse connections
const HTTP_POOL_MAX_IDLE_PER_HOST: usize = 10; // Max connections per host

// PRODUCTION v2.19.21: Global async HTTP client with connection pooling
// Used for REST API and HTTP fallback (when QUIC_ONLY=false)
static HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(HTTP_CONNECT_TIMEOUT_SECS))
        .tcp_keepalive(Duration::from_secs(HTTP_TCP_KEEPALIVE_SECS))
        .pool_idle_timeout(Duration::from_secs(HTTP_POOL_IDLE_TIMEOUT_SECS))
        .pool_max_idle_per_host(HTTP_POOL_MAX_IDLE_PER_HOST)
        .tcp_nodelay(true)  // Disable Nagle's algorithm for faster P2P
        .build()
        .expect("Failed to create global HTTP client")
});

// ═══════════════════════════════════════════════════════════════════════════════════
// PRODUCTION v2.57: DEDICATED BROADCAST RUNTIME
// ═══════════════════════════════════════════════════════════════════════════════════
// WHY: Main Tokio runtime handles heartbeats, peer discovery, API requests, consensus.
//      During high load, broadcast tasks get starved → chunks not sent → emergency failover.
// SOLUTION: Dedicated runtime ONLY for Shred Protocol broadcast.
// GUARANTEE: Broadcast always has dedicated threads, never competes with main loop.
// ADAPTIVE: 2 cores→1t, 4 cores→2t, 8+ cores→50% (scales with CPU)
// ENV: QNET_BROADCAST_THREADS - override thread count
// ═══════════════════════════════════════════════════════════════════════════════════
static BROADCAST_RUNTIME: Lazy<tokio::runtime::Runtime> = Lazy::new(|| {
    let cpu_count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    
    // ADAPTIVE for small configs: 2 cores→1t, 4 cores→2t, 8+ cores→50%
    let default_threads = if cpu_count <= 2 { 
        1 
    } else if cpu_count <= 4 { 
        2 
    } else { 
        (cpu_count / 2).max(2) 
    };
    
    let broadcast_threads = std::env::var("QNET_BROADCAST_THREADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .map(|env_val| env_val.max(1).min(cpu_count))
        .unwrap_or(default_threads);
    
    if crate::node::is_info() { println!("[INFO][BROADCAST] runtime_init cpus={} threads={}", cpu_count, broadcast_threads); }
    
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(broadcast_threads)
        .thread_name("qnet-broadcast")
        .enable_all()
        .build()
        .expect("Failed to create dedicated broadcast runtime")
});

// ═══════════════════════════════════════════════════════════════════════════════════
// PRODUCTION v2.57: DEDICATED SIGVERIFY RUNTIME
// ═══════════════════════════════════════════════════════════════════════════════════
// WHY: Signature verification is CPU-intensive (Ed25519 ~10k/sec, Dilithium ~1k/sec)
//      Running in main runtime blocks event loop → degraded TPS
// SOLUTION: Dedicated runtime for ALL cryptographic verification
// ADAPTIVE: 2 cores→1t, 4 cores→1t, 8+ cores→2t (scales with CPU)
// ENV: QNET_SIGVERIFY_THREADS - override thread count
// ═══════════════════════════════════════════════════════════════════════════════════
static SIGVERIFY_RUNTIME: Lazy<tokio::runtime::Runtime> = Lazy::new(|| {
    let cpu_count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    
    // ADAPTIVE: For small configs (2-4 cores), use minimal threads
    // 2 cores: 1 thread, 4 cores: 1 thread, 8+ cores: 2+ threads
    let default_threads = if cpu_count <= 4 { 1 } else { (cpu_count / 4).max(2) };
    
    let sigverify_threads = std::env::var("QNET_SIGVERIFY_THREADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .map(|v| v.max(1).min(cpu_count))
        .unwrap_or(default_threads);
    
    if crate::node::is_info() { println!("[INFO][SIGVERIFY] runtime_init cpus={} threads={}", cpu_count, sigverify_threads); }
    
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(sigverify_threads)
        .thread_name("qnet-sigverify")
        .enable_all()
        .build()
        .expect("Failed to create dedicated sigverify runtime")
});

// ═══════════════════════════════════════════════════════════════════════════════════
// Runtime split actually in force:
//   Main:              consensus, failover, heartbeats, peer discovery, API
//   BROADCAST_RUNTIME: shred fan-out, chunk forwarding, background repair
//   SIGVERIFY_RUNTIME: ML-DSA-65 verification
// Value-TX verify is additionally kept off consensus by a semaphore-bounded spawn_blocking pool,
// so tx intake needs no runtime of its own.

/// Spawn task on SIGVERIFY_RUNTIME for crypto verification
pub fn spawn_sigverify<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    SIGVERIFY_RUNTIME.spawn(future)
}

/// Runtime statistics
#[derive(Debug, Clone)]
pub struct RuntimeStats {
    pub cpu_count: usize,
    pub broadcast_threads: usize,
    pub sigverify_threads: usize,
    pub banking_threads: usize,
    pub replay_threads: usize,
}

impl RuntimeStats {
    pub fn total(&self) -> usize {
        self.broadcast_threads + self.sigverify_threads + self.banking_threads + self.replay_threads
    }
}

/// Get runtime statistics with adaptive thread counts
pub fn get_runtime_stats() -> RuntimeStats {
    let cpu_count = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    
    // ADAPTIVE defaults matching runtime initialization
    let broadcast_default = if cpu_count <= 2 { 1 } else if cpu_count <= 4 { 2 } else { (cpu_count / 2).max(2) };
    let sigverify_default = if cpu_count <= 4 { 1 } else { (cpu_count / 4).max(2) };
    let banking_default = if cpu_count <= 4 { 1 } else { (cpu_count / 4).max(2) };
    let replay_default = if cpu_count <= 4 { 1 } else { (cpu_count / 4).max(2) };
    
    RuntimeStats {
        cpu_count,
        broadcast_threads: std::env::var("QNET_BROADCAST_THREADS")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(broadcast_default),
        sigverify_threads: std::env::var("QNET_SIGVERIFY_THREADS")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(sigverify_default),
        banking_threads: std::env::var("QNET_BANKING_THREADS")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(banking_default),
        replay_threads: std::env::var("QNET_REPLAY_THREADS")
            .ok().and_then(|s| s.parse().ok()).unwrap_or(replay_default),
    }
}

// PRODUCTION v2.19.21: QUIC-only mode
// HTTP fallback has been removed for maximum performance
// All nodes MUST support QUIC (port 10876 = P2P port + 1000)

// v2.24.3: Global QUIC transport for static sync methods
// Set during SimplifiedP2P initialization, used by static sync/repair helpers
// ARCHITECTURE: Enables QUIC-based sync without passing &self to static methods
// SCALABILITY: Single shared transport handles 100K+ nodes efficiently
pub static GLOBAL_QUIC_TRANSPORT: Lazy<parking_lot::RwLock<Option<Arc<tokio::sync::RwLock<crate::quic_transport::QuicTransport>>>>> =
    Lazy::new(|| parking_lot::RwLock::new(None));

// v2.24.3: Global node ID for static sync methods
// Set during SimplifiedP2P initialization
pub static GLOBAL_NODE_ID: Lazy<parking_lot::RwLock<String>> =
    Lazy::new(|| parking_lot::RwLock::new("unknown".to_string()));

// SECURITY: Track invalid blocks from each node for malicious behavior detection
// Format: node_id -> (invalid_count, first_invalid_time)
// SCALABILITY: DashMap for lock-free concurrent access with millions of nodes
static INVALID_BLOCKS_TRACKER: Lazy<Arc<DashMap<String, (AtomicU64, Instant)>>> = 
    Lazy::new(|| Arc::new(DashMap::new()));

// SECURITY: Track false emergency senders for penalty application
// Format: sender_addr -> (false_count, last_false_time)
// Used to apply -5 reputation penalty for false emergency messages
static FALSE_EMERGENCY_TRACKER: Lazy<Arc<DashMap<String, (AtomicU64, Instant)>>> = 
    Lazy::new(|| Arc::new(DashMap::new()));

// CONSENSUS: Track emergency confirmations from multiple nodes
// Key: (block_height, failed_producer) → Value: (confirmation_count, first_seen_time)
// This enables lightweight consensus: if 3+ nodes report same emergency, it's likely valid
static EMERGENCY_CONFIRMATIONS: Lazy<Arc<DashMap<(u64, String), (AtomicU64, Instant)>>> = 
    Lazy::new(|| Arc::new(DashMap::new()));

// SYNC OPTIMIZATION: Peer blacklist for failed sync attempts
// Key: peer_addr → Value: BlacklistEntry
// SCALABILITY: DashMap for lock-free concurrent access with millions of nodes
// ARCHITECTURE: Soft blacklist (network issues) vs Hard blacklist (Byzantine attacks)
static PEER_BLACKLIST: Lazy<Arc<DashMap<String, BlacklistEntry>>> = 
    Lazy::new(|| Arc::new(DashMap::new()));

// BROADCAST OPTIMIZATION: Short-term cooldown for unresponsive peers
// Key: peer_addr → Value: (retry_count, cooldown_until)
// SCALABILITY: Prevents retry storms to "not ready" peers
// Cooldown: 2s base, exponential backoff up to 30s max
static PEER_RETRY_COOLDOWN: Lazy<Arc<DashMap<String, (u32, std::time::Instant)>>> = 
    Lazy::new(|| Arc::new(DashMap::new()));

// ═══════════════════════════════════════════════════════════════════════════════════════
// PRODUCTION v2.84: QUIC Fallback Rate Limiter and Metrics
// SECURITY: Prevents DoS via excessive QUIC fallback requests (max 10/min per node)
// MONITORING: Tracks success rate for production alerts
// ═══════════════════════════════════════════════════════════════════════════════════════

/// QUIC Fallback Rate Limiter (per-node): max 10 requests per minute
/// Key: node_id, Value: (request_count, window_start_timestamp_secs)
static QUIC_FALLBACK_RATE_LIMITER: Lazy<Arc<DashMap<String, (u32, u64)>>> = 
    Lazy::new(|| Arc::new(DashMap::new()));

/// Rate limit constants
const QUIC_FALLBACK_MAX_PER_MIN: u32 = 10;  // Max 10 QUIC fallback requests per minute
const QUIC_FALLBACK_WINDOW_SECS: u64 = 60;  // Rolling window: 60 seconds

/// QoS bulk lane drop counter (lane full → request shed). Log-governed by
/// the bulk worker; shedding here is the hard DoS bound that protects the
/// consensus lane — a flooding cold-sync peer's excess is dropped, never queued.
pub static BULK_LANE_DROPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// QoS finality lane drop counter (lane full → non-redundant 2f+1 checkpoint/failover
/// frame shed). A NON-ZERO value is unrepairable consensus loss (SEV-1), unlike the
/// benign bulk shedding above. Log-governed by the finality drain task.
pub static FINALITY_LANE_DROPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Gossip messages shed because every pool worker was busy past the wait bound —
/// nonzero sustained = wedged handlers eating workers.
pub static GOSSIP_POOL_SHED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// QUIC Fallback Metrics (global counters for monitoring)
pub static QUIC_FALLBACK_SUCCESS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static QUIC_FALLBACK_TOTAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static QUIC_FALLBACK_RATE_LIMITED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// Global peer-liveness registry (keyed by IP). Root-cause fix for a
// false-offline cascade: the static TCP-probe path disagreed with reality
// (001 was receiving shreds from 002 when a 2s probe to a busy 002 timed
// out → 002 marked offline). Two liveness subsystems contradicted: per-
// instance PeerInfo.last_seen (ground truth, unreachable from the static
// helper) vs a 2s no-retry TCP SYN probe that over-ruled it. This mirrors
// last_seen by IP so the static filter checks recent traffic BEFORE
// probing (recent traffic = alive, skip probe); the TCP probe stays only
// as a cold-start / silent-peer fallback. Single source of truth; bounded
// and swept by PEER_ALIVE_FRESHNESS_SECS.

/// IP → last_seen (unix seconds). Mirror of `PeerInfo.last_seen` exposed
/// to the static-context `filter_working_genesis_nodes_static` helper.
pub(crate) static GLOBAL_PEER_LAST_SEEN_BY_IP: Lazy<Arc<DashMap<String, u64>>> =
    Lazy::new(|| Arc::new(DashMap::new()));

/// Peers with `last_seen` within this window are considered alive without
/// an additional TCP probe. Chosen ~2× macroblock-round timeout so a peer
/// that temporarily stopped gossiping during a single heavy BFT phase
/// still counts as live if it resumed recently.
pub(crate) const PEER_ALIVE_FRESHNESS_SECS: u64 = 60;

/// Update the global peer-liveness registry. Called from every site that
/// already updates per-instance `PeerInfo.last_seen`. Idempotent and
/// monotonic — only advances the timestamp upward.
pub(crate) fn touch_peer_liveness_by_ip(peer_ip: &str, now_secs: u64) {
    // Strip any accidental :port suffix to key consistently by IP.
    let ip = peer_ip.split(':').next().unwrap_or(peer_ip).to_string();
    if ip.is_empty() {
        return;
    }
    GLOBAL_PEER_LAST_SEEN_BY_IP
        .entry(ip)
        .and_modify(|cur| { if now_secs > *cur { *cur = now_secs; } })
        .or_insert(now_secs);
}

/// Returns `true` if the given IP is within the freshness window (we
/// received a message from it recently). Constant-time lookup.
pub(crate) fn peer_alive_by_ip(peer_ip: &str, now_secs: u64) -> bool {
    let ip = peer_ip.split(':').next().unwrap_or(peer_ip);
    match GLOBAL_PEER_LAST_SEEN_BY_IP.get(ip) {
        Some(entry) => now_secs.saturating_sub(*entry.value()) <= PEER_ALIVE_FRESHNESS_SECS,
        None => false,
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// MEMORY LEAK FIX v3.20: Global trackers moved from function-local static
// PROBLEM: Static inside functions had no cleanup mechanism
// SOLUTION: Global statics with periodic cleanup in start_static_cache_cleanup_task
// ═══════════════════════════════════════════════════════════════════════════════════════

/// Track nodes returning empty responses (security monitoring)
/// Key: node_id, Value: (count, first_seen_timestamp_secs)
static EMPTY_RESPONSE_TRACKER: Lazy<Arc<DashMap<String, (u32, u64)>>> = 
    Lazy::new(|| Arc::new(DashMap::new()));

/// Track invalid certificate attempts (security monitoring)
/// Key: node_id, Value: (count, first_seen_instant)
static INVALID_CERT_TRACKER: Lazy<Arc<DashMap<String, (std::sync::atomic::AtomicU64, std::time::Instant)>>> = 
    Lazy::new(|| Arc::new(DashMap::new()));

// ═══════════════════════════════════════════════════════════════════════════════════════
// BFT TIMEOUT CONSENSUS v4.0: Deterministic failover without system clock dependency
// ARCHITECTURE: Replaces NTP-based timeout with Byzantine consensus voting
// Key: (height, timeout_round) -> collected votes
// When 2/3+ votes collected, TimeoutCertificate is generated
// ═══════════════════════════════════════════════════════════════════════════════════════

/// One stored timeout vote: the voter's signature over its OWN canonical payload (see
/// `timeout_vote_message`). Votes with divergent finality/tip aggregate into one TC because each
/// entry is verified against its own fields — the aggregation key is only (window, round, anchor).
#[derive(Clone)]
pub struct StoredTimeoutVote {
    pub signature: Vec<u8>,
    pub anchor: [u8; 32],
    pub high_qc_idx: u64,
    pub high_qc_hash: [u8; 32],
    pub tip_height: u64,
    pub tip_hash: [u8; 32],
    /// Local wall (secs) of last accepted update — rate-bounds update-not-slash re-gossip.
    pub updated_at: u64,
}

/// Collected timeout votes per (window = target_height/90, round).
static TIMEOUT_VOTES: Lazy<Arc<DashMap<(u64, u64), HashMap<String, StoredTimeoutVote>>>> =
    Lazy::new(|| Arc::new(DashMap::new()));

/// Committee members seen voting on a DIFFERENT sealed w-2 anchor, keyed (window, their_anchor).
/// A local mismatch alone cannot tell "they forked" from "we forked", so dropping the vote leaves a
/// minority node deaf forever. n−f distinct SIGNED foreign anchors can tell, and is the only sound
/// trigger for it to reconcile. Bounded: entries evicted once the window falls behind.
static FOREIGN_ANCHOR_WITNESSES: Lazy<Arc<DashMap<(u64, [u8; 32]), std::collections::HashSet<String>>>> =
    Lazy::new(|| Arc::new(DashMap::new()));

/// Attesters seen for each (height, block_hash). EVIDENCE ONLY — never a production gate and never a
/// fork-choice input: gossip is partial, so counts differ per node, and a node-dependent count cannot
/// pick a branch. Its one use is noticing early that our held block is unattested while a competitor
/// is, then pulling the canonical anchor. Bounded by eviction below the applied tip.
static BLOCK_ATTESTATIONS: Lazy<Arc<DashMap<(u64, [u8; 32]), std::collections::HashSet<String>>>> =
    Lazy::new(|| Arc::new(DashMap::new()));

/// Sorted window roster, memoized on the SAME (window, seal) key the committee cache uses so it can
/// never go stale against it. Without this both the emitter (every applied block) and the receiver
/// (every attestation) would clone and sort up to COMMITTEE_SIZE ids per message.
static SORTED_COMMITTEE_CACHE: Lazy<Arc<DashMap<(u64, u64), Arc<Vec<String>>>>> =
    Lazy::new(|| Arc::new(DashMap::new()));

pub fn sorted_committee_for_window(w: u64) -> Option<Arc<Vec<String>>> {
    let seal = crate::node::try_get_storage().map(|s| s.last_sealed_mb_index()).unwrap_or(0);
    if let Some(c) = SORTED_COMMITTEE_CACHE.get(&(w, seal)) { return Some(c.value().clone()); }
    let mut v: Vec<String> = failover_committee_for_window(w)?.iter().cloned().collect();
    v.sort();
    let arc = Arc::new(v);
    SORTED_COMMITTEE_CACHE.insert((w, seal), arc.clone());
    SORTED_COMMITTEE_CACHE.retain(|k, _| k.0 + 4 >= w);
    Some(arc)
}

/// Distinct block hashes tracked per height. Honest divergence yields one or two; the cap stops an
/// attacker minting unbounded map keys by varying the hash, which is free for the sender.
const MAX_ATTESTED_HASHES_PER_HEIGHT: usize = 4;

/// True when this attester is already recorded for (height, hash) — checked BEFORE the ~5ms
/// signature verify so a replay cannot buy CPU, and false when the per-height hash cap is full.
pub fn attestation_admissible(height: u64, block_hash: &[u8; 32], attester: &str) -> bool {
    if BLOCK_ATTESTATIONS.get(&(height, *block_hash)).is_some_and(|s| s.contains(attester)) {
        return false;
    }
    if !BLOCK_ATTESTATIONS.contains_key(&(height, *block_hash))
        && BLOCK_ATTESTATIONS.iter().filter(|e| e.key().0 == height).count()
            >= MAX_ATTESTED_HASHES_PER_HEIGHT {
        return false;
    }
    true
}

/// Last rotation window each attestation half logged its INFO heartbeat in. Keying the line on a
/// fixed height would always land on one slot, so a single committee member printed it and the rest
/// looked silent; keying on the window gives every node one line per window whatever its slot.
static ATTEST_LOG_WINDOW_EMIT: AtomicU64 = AtomicU64::new(u64::MAX);
static ATTEST_LOG_WINDOW_RECV: AtomicU64 = AtomicU64::new(u64::MAX);

/// True once per rotation window, for the caller's half of the loop.
pub fn attest_heartbeat_due(height: u64, emitting: bool) -> bool {
    let win = height.saturating_sub(1) / crate::node::ROTATION_INTERVAL_BLOCKS;
    let slot = if emitting { &ATTEST_LOG_WINDOW_EMIT } else { &ATTEST_LOG_WINDOW_RECV };
    slot.swap(win, std::sync::atomic::Ordering::Relaxed) != win
}

/// Records one verified attestation; returns how many distinct attesters now back this (height, hash).
pub fn record_block_attestation(height: u64, block_hash: [u8; 32], attester: String) -> usize {
    let n = {
        let mut e = BLOCK_ATTESTATIONS.entry((height, block_hash))
            .or_insert_with(std::collections::HashSet::new);
        e.insert(attester);
        e.len()
    };
    // One checkpoint window of history is all the evidence is ever read for.
    let floor = height.saturating_sub(qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL);
    BLOCK_ATTESTATIONS.retain(|k, _| k.0 >= floor);
    n
}

/// Distinct attesters backing a given (height, hash).
pub fn block_attestation_count(height: u64, block_hash: &[u8; 32]) -> usize {
    BLOCK_ATTESTATIONS.get(&(height, *block_hash)).map(|s| s.len()).unwrap_or(0)
}

/// Generated timeout certificates (cached for block validation)
/// Key: (macroblock_index, timeout_round), Value: TimeoutCertificate
static TIMEOUT_CERTIFICATES: Lazy<Arc<DashMap<(u64, u64), TimeoutCertificate>>> = 
    Lazy::new(|| Arc::new(DashMap::new()));

/// O(1) tracker: highest certified round per macroblock index.
/// Updated on every certificate insert — avoids linear scan of TIMEOUT_CERTIFICATES.
static HIGHEST_CERTIFIED_ROUND: Lazy<Arc<DashMap<u64, u64>>> =
    Lazy::new(|| Arc::new(DashMap::new()));

/// Window-monotonic floor: highest window with a locally-VERIFIED TC. A voter never emits below it
/// — once a window certified, resuming a lower key would let ≤f cross-window Byzantine votes push
/// two adjacent windows to quorum simultaneously (double-TC at a boundary straddle).

/// Failover committee cache, keyed by (window, anchor_hash). Anchor-keying (R17.1) makes an L-advance
/// invalidate automatically: the sealed and frozen arms name different anchors, so a now-sealed window
/// computes a fresh key and a stale frozen entry can never be served.
/// Keyed by (window, seal frontier), NOT by anchor hash: the anchor hash is the PRODUCT of the work
/// this cache exists to skip, so an anchor-keyed lookup can only run after paying for it. The seal
/// frontier is two point reads and moves exactly when the answer can, and macroblock saves are
/// first-write-wins, so a body cannot change under a fixed frontier.
static FAILOVER_COMMITTEE_CACHE: Lazy<Arc<DashMap<(u64, u64), Arc<std::collections::HashSet<String>>>>> =
    Lazy::new(|| Arc::new(DashMap::new()));

/// Cooldown per macroblock index for the missing-anchor pull (secs).
static ANCHOR_PULL_LAST: Lazy<Arc<DashMap<u64, u64>>> = Lazy::new(|| Arc::new(DashMap::new()));

/// Per-requester cooldown for the timeout-proof serve path: one answer per address per
/// PROOF_REQUEST_COOLDOWN_SECS, so a single peer cannot drive repeated multi-signature responses.
pub(crate) static PROOF_SERVE_LAST: Lazy<Arc<DashMap<String, u64>>> = Lazy::new(|| Arc::new(DashMap::new()));

/// Cooldown per window for the SyncInfo-driven TC pull (secs).
static TC_PULL_LAST: Lazy<Arc<DashMap<u64, u64>>> = Lazy::new(|| Arc::new(DashMap::new()));

/// Global token bucket (wall_second, pulls_this_second) for SyncInfo-driven TC pulls — bounds the
/// pull fan-out regardless of how many distinct cert_mb an unauthenticated peer cycles.
static TC_CLAIM_PULL_BUDGET: Lazy<Arc<parking_lot::Mutex<(u64, u32)>>> =
    Lazy::new(|| Arc::new(parking_lot::Mutex::new((0, 0))));

/// Same, for anchor-macroblock pulls (request_window_anchor) — an attacker-chosen height in a
/// TC/vote reaches this sink pre-auth, so the fan-out is globally capped, not just per-window.
static ANCHOR_PULL_BUDGET: Lazy<Arc<parking_lot::Mutex<(u64, u32)>>> =
    Lazy::new(|| Arc::new(parking_lot::Mutex::new((0, 0))));

/// Same, for block-repair requests (request_block_repair) — check_content's TailDiverged branch can
/// spawn one repair per diverged tail height (up to a full window) from a single proposal, and a
/// re-sendable attacker proposal cycles fresh garbage tails, so the ~3x-peer fan-out is globally
/// capped + per-height cooldowned regardless of how many heights an unauthenticated proposal forces.
/// (second_start, shared_count, priority_count): the PRIORITY lane is a RESERVED extra budget for
/// finality-critical repairs (tail-reconcile / deferred-finalize) — bulk callers (hole repair,
/// parent pulls, sync) draw only from shared, so they can never starve the repair that unwedges
/// 2f+1 finality. Priority callers draw shared first, then the reserve.
static REPAIR_REQUEST_BUDGET: Lazy<Arc<parking_lot::Mutex<(u64, u32, u32)>>> =
    Lazy::new(|| Arc::new(parking_lot::Mutex::new((0, 0, 0))));
/// Cooldown per height for the block-repair request (secs).
static REPAIR_REQUEST_TIMES: Lazy<Arc<DashMap<u64, u64>>> = Lazy::new(|| Arc::new(DashMap::new()));

/// Canonical signed payload of a failover vote — domain-tagged + versioned; the ONE builder shared
/// by signer and verifier. anchor = hash(macroblock w-2) (zeros for w<3): fork-binds the vote to
/// QC-sealed state every honest voter shares; high_qc/tip are the voter's own (sync hints +
/// accountability), NOT quorum-checked fields.
pub fn timeout_vote_message(
    w: u64, round: u64, anchor: &[u8; 32],
    high_qc_idx: u64, high_qc_hash: &[u8; 32],
    tip_height: u64, tip_hash: &[u8; 32],
) -> String {
    format!("QNET_TIMEOUT_V2:{}:{}:{}:{}:{}:{}:{}",
            w, round, hex::encode(anchor),
            high_qc_idx, hex::encode(high_qc_hash),
            tip_height, hex::encode(tip_hash))
}

/// Per-window, per-voter SIGNED `high_qc_idx` — the voter's own last sealed macroblock. Recorded for
/// every AUTHENTICATED vote, including one whose anchor this node cannot resolve: that is precisely
/// the case that matters, since a node behind on macroblocks resolves none of the majority's anchors,
/// so nothing ever reaches its tally and it could never learn from the tally that it is the one behind.
static VOTER_SEALED_CLAIM: Lazy<DashMap<(u64, String), u64>> = Lazy::new(DashMap::new);

/// Record an authenticated committee voter's own sealed index for window `w`. Monotone per voter.
/// Bounded by committee size x the retained window span; both callers sit behind the committee filter
/// and a verified signature, so this is not remotely inflatable.
pub fn note_sealed_claim(w: u64, voter_id: &str, high_qc_idx: u64) {
    {
        let mut e = VOTER_SEALED_CLAIM.entry((w, voter_id.to_string())).or_insert(0);
        if high_qc_idx > *e { *e = high_qc_idx; }
    }
    if VOTER_SEALED_CLAIM.len() > 8192 { VOTER_SEALED_CLAIM.retain(|k, _| k.0.saturating_add(8) >= w); }
}

/// Highest sealed-macroblock index that >= `support` DISTINCT committee voters have SIGNED. At
/// support = f+1 at least one signer is honest, so the macroblock it names really is sealed somewhere —
/// which is what separates "the network's finality is stalled" from "mine is behind it".
///
/// Folded per VOTER across every retained window, not per window: a sealed index is a property of the
/// signer, and the node this answer protects is by definition voting on an OLDER window than the peers
/// whose seals it needs to hear about, so a per-window lookup would go silent in its own case. A stale
/// claim stays sound — a sealed macroblock is final, and high_qc_idx only climbs.
pub fn sealed_frontier_with_support(support: usize) -> u64 {
    if support == 0 { return 0; }
    let mut per_voter: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for e in VOTER_SEALED_CLAIM.iter() {
        let slot = per_voter.entry(e.key().1.clone()).or_insert(0);
        if *e.value() > *slot { *slot = *e.value(); }
    }
    if per_voter.len() < support { return 0; }
    let mut vals: Vec<u64> = per_voter.into_values().collect();
    vals.sort_unstable_by(|a, b| b.cmp(a));
    vals[support - 1]
}

/// This node's OWN anchor per (window, seal frontier). `sealed_anchor_for_window` reads a macroblock
/// and dispatches on the roster mode, and it sits pre-signature on every inbound vote; the committee
/// on the same path is already memoized on the same key.
static LOCAL_ANCHOR_CACHE: Lazy<DashMap<(u64, u64), Option<[u8; 32]>>> = Lazy::new(DashMap::new);

/// This node's own anchor for the window, memoized. The name deliberately does NOT share a prefix
/// with `sealed_anchor_for_window`: a source-scanning invariant test locates that function by prefix.
/// The key carries the seal frontier the answer derives from,
/// so the entry self-invalidates the moment that frontier moves.
pub fn local_anchor_for_window_cached(w: u64) -> Option<[u8; 32]> {
    let seal = crate::node::try_get_storage().map(|s| s.last_sealed_mb_index()).unwrap_or(0);
    if let Some(v) = LOCAL_ANCHOR_CACHE.get(&(w, seal)) { return *v; }
    let v = sealed_anchor_for_window(w);
    if LOCAL_ANCHOR_CACHE.len() > 512 { LOCAL_ANCHOR_CACHE.clear(); }
    LOCAL_ANCHOR_CACHE.insert((w, seal), v);
    v
}

/// Anchors this node has already resolved for a window, so the descent below runs once per
/// (window, anchor) rather than per vote.
static RESOLVED_ANCHORS: Lazy<DashMap<(u64, [u8; 32]), (bool, u64)>> = Lazy::new(DashMap::new);
/// How long a NEGATIVE resolution is trusted. A positive is chain data and never changes; a
/// negative only means "not held yet", and both callers answer it by pulling the macroblock and
/// waiting for a retransmission — which a permanent memo would answer with the same stale no.
const ANCHOR_MISS_TTL_SECS: u64 = 30;
/// A positive is chain data, but a macroblock can be rolled back, so it expires too — slowly.
const ANCHOR_HIT_TTL_SECS: u64 = 3600;

/// Does `anchor` name a macroblock this node HOLDS at or below window `w`'s roster base?
///
/// This is the acceptance predicate for failover evidence, and it deliberately does NOT re-derive
/// the anchor the way the signer picks one. `sealed_anchor_for_window` dispatches on `roster_mode`,
/// which reads this node's own seal frontier and QC-frontier cache — node-local, mutable, and 0 at
/// every boot. Two honest nodes holding byte-identical macroblocks therefore derived different
/// anchors after a staggered restart and hard-rejected each other's votes and certificates
/// (`anchor_mismatch mb=1887`), partitioning the failover layer with no adversary present.
///
/// Resolution keeps every guarantee the equality check provided: macroblock storage is index-keyed
/// and first-write-wins, so an anchor minted on another branch resolves to nothing here, and the
/// descent is bounded by the same horizon the frozen roster uses. What it drops is the requirement
/// that the sender's seal frontier equal the receiver's.
pub fn anchor_resolves_for_window(w: u64, anchor: &[u8; 32]) -> bool {
    if w < 3 { return anchor == &[0u8; 32]; }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    if let Some(v) = RESOLVED_ANCHORS.get(&(w, *anchor)) {
        let (found, expiry) = *v;
        if expiry > now { return found; }
    }
    let storage = match crate::node::try_get_storage() { Some(s) => s, None => return false };
    let start = w.saturating_sub(2);
    // A frozen anchor is derived by descending up to MAX_DERIVED_ROSTER_WINDOWS from the SIGNER's own
    // seal frontier, which can sit below w-2 — so the floor has to cover that range from wherever our
    // own frontier is, not just from w-2, or an honest frozen vote resolves for nobody.
    let horizon = crate::node::BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64;
    let own_seal = crate::node::try_get_storage().map(|s| s.last_sealed_mb_index()).unwrap_or(0);
    let floor = start.min(own_seal.max(1)).saturating_sub(horizon);
    let mut idx = start;
    let mut found = false;
    while idx >= 1 && idx >= floor.max(1) {
        if let Some(mb) = storage.get_macroblock_by_height(idx).ok().flatten()
            .and_then(crate::node::BlockchainNode::macroblock_plaintext)
            .and_then(|raw| bincode::deserialize::<qnet_state::MacroBlock>(&raw).ok())
        {
            if mb.hash() == *anchor { found = true; break; }
        }
        idx -= 1;
    }
    if RESOLVED_ANCHORS.len() > 4096 {
        RESOLVED_ANCHORS.retain(|_, v| v.1 > now);
        if RESOLVED_ANCHORS.len() > 4096 { RESOLVED_ANCHORS.clear(); }
    }
    let ttl = if found { ANCHOR_HIT_TTL_SECS } else { ANCHOR_MISS_TTL_SECS };
    RESOLVED_ANCHORS.insert((w, *anchor), (found, now.saturating_add(ttl)));
    found
}

/// Deterministic failover committee for vote window `w` (A1 R11.0). Resolution order: genesis (w<3)
/// → sealed `committee_for_height(w*90)` when w-2 ≤ L → FrozenCommittee(w) off the sealed anchor M_A
/// when finality is stalled → None (Defer: a certified anchor exists but is unheld, caller pulls).
/// Removing the seal+2 wall is what keeps failover alive across the 32-window horizon.
///
/// An armed recovery span does NOT substitute the anchor macroblock's C_S here. C_S and the derived
/// set are independent VRF samples of one roster, so at scale they are near-disjoint and two
/// certificates over one span window would not have to intersect.
pub fn failover_committee_for_window(w: u64) -> Option<Arc<std::collections::HashSet<String>>> {
    if w < 3 {
        let key = (w, 0u64);
        if let Some(c) = FAILOVER_COMMITTEE_CACHE.get(&key) { return Some(c.value().clone()); }
        let set: std::collections::HashSet<String> = crate::genesis_constants::GENESIS_CONSENSUS_PKS
            .iter().map(|(id, _)| id.to_string()).collect();
        let arc = Arc::new(set);
        FAILOVER_COMMITTEE_CACHE.insert(key, arc.clone());
        return Some(arc);
    }
    let storage = crate::node::try_get_storage()?;
    // Fast path FIRST: this runs per inbound failover vote and certificate.
    let seal = storage.last_sealed_mb_index();
    if let Some(c) = FAILOVER_COMMITTEE_CACHE.get(&(w, seal)) { return Some(c.value().clone()); }
    let (_anchor_hash, ids) = match crate::node::BlockchainNode::roster_mode(&storage, w) {
        crate::node::RosterMode::Sealed => {
            let ah = storage.get_macroblock_by_height(w.saturating_sub(2)).ok().flatten()
                .and_then(crate::node::BlockchainNode::macroblock_plaintext)
                .and_then(|raw| bincode::deserialize::<qnet_state::MacroBlock>(&raw).ok())
                .map(|mb| mb.hash())?;
            (ah, crate::node::BlockchainNode::committee_for_height(&storage, w.saturating_mul(90))?)
        }
        crate::node::RosterMode::Frozen => {
            let l = storage.last_sealed_mb_index();
            let (_a, anchor) = crate::node::BlockchainNode::frozen_anchor(&storage, l)?;
            (anchor.hash(), crate::node::BlockchainNode::frozen_committee(&anchor, w))
        }
        crate::node::RosterMode::Defer => return None,
    };
    if ids.is_empty() { return None; }
    let arc = Arc::new(ids.into_iter().collect::<std::collections::HashSet<String>>());
    FAILOVER_COMMITTEE_CACHE.insert((w, seal), arc.clone());
    FAILOVER_COMMITTEE_CACHE.retain(|(k, _), _| k.saturating_add(8) >= w);
    Some(arc)
}

/// Deterministic sealed anchor for window `w`: hash(macroblock w-2), zeros for w<3 (genesis
/// convention). None = anchor macroblock absent locally (refuse-and-fetch).
/// A recovery span changes nothing here: the failover layer stays on the strict threshold and its
/// vote preimage carries no pin, so armed and unarmed nodes derive the same anchor for one window
/// and can verify each other's votes during the halt the span exists to end.
pub fn sealed_anchor_for_window(w: u64) -> Option<[u8; 32]> {
    if w < 3 { return Some([0u8; 32]); }
    let storage = crate::node::try_get_storage()?;
    // Sealed: hash(macroblock w-2). Frozen: hash(M_A) (R12) — the SAME anchor whose committee
    // failover_committee_for_window resolves, so the TC anchor check and the committee source name one
    // macroblock. Defer: None (caller pulls). The vote's anchor field advertises the sender's frontier.
    match crate::node::BlockchainNode::roster_mode(&storage, w) {
        crate::node::RosterMode::Sealed => {
            let raw = storage.get_macroblock_by_height(w - 2).ok().flatten()?;
            let plain = crate::node::BlockchainNode::macroblock_plaintext(raw)?;
            let mb = bincode::deserialize::<qnet_state::MacroBlock>(&plain).ok()?;
            Some(mb.hash())
        }
        crate::node::RosterMode::Frozen => {
            let l = storage.last_sealed_mb_index();
            crate::node::BlockchainNode::frozen_anchor(&storage, l).map(|(_a, mb)| mb.hash())
        }
        crate::node::RosterMode::Defer => None,
    }
}

/// Amplification sanity ceiling, in windows: max(local seal, QC-verified frontier) + the SAME allowance
/// the production throttle enforces — a window above it is not producible anywhere, so f+1 votes for it
/// are fabricated. It MUST track the production horizon: while it sat at 2 windows and production ran to
/// 32, every rotation vote for a window past +180 was discarded as fabricated, which silently disabled
/// view change exactly where A1 was supposed to keep the chain moving. u64::MAX pre-first-seal.
pub fn certified_view_bound_windows() -> u64 {
    let sealed_w = crate::node::try_get_storage().map(|s| s.last_sealed_mb_index()).unwrap_or(0);
    let qc_w = crate::node::qc_verified_frontier_cached() / 90;
    let base = sealed_w.max(qc_w);
    if base == 0 { return u64::MAX; }
    base + crate::node::BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64
}

/// Lowest window ABOVE `above_w` supported by ≥ f+1 DISTINCT committee voters (any round) —
/// min-target amplification: f+1 guarantees ≥1 honest witness whose verified chain reached that
/// window, and MIN (not max) is the provably-convergent choice when two windows transiently carry
/// support. Votes are committee-filtered at insert, so counting distinct voters is sound.
pub fn lowest_window_with_support(above_w: u64) -> Option<u64> {
    let mut by_w: std::collections::BTreeMap<u64, std::collections::HashSet<String>> =
        std::collections::BTreeMap::new();
    for e in TIMEOUT_VOTES.iter() {
        let (w, _r) = *e.key();
        if w > above_w {
            by_w.entry(w).or_default().extend(e.value().keys().cloned());
        }
    }
    for (w, voters) in by_w {
        if let Some(c) = failover_committee_for_window(w) {
            let f = c.len().saturating_sub(1) / 3;
            if voters.len() >= f + 1 { return Some(w); }
        }
    }
    None
}

/// A4 self-yield gate: true if some LIVE failover round (> certified) for window `w` already holds
/// ≥ (quorum − 1) DISTINCT committee votes NOT including `voter` — so THIS node's own vote is the
/// single decisive one that forms the same-round n−f TimeoutCertificate rotating the network off
/// itself. Reads the SAME voter-deduped, committee-filtered TIMEOUT_VOTES the TC tally uses at the
/// identical (window, ABSOLUTE round) key — NEVER an f+1 threshold, NEVER a cross-round aggregate,
/// NEVER the wall clock — so it cannot resurrect the h=556 f+1-minority-drives-rotation split. It
/// only lifts this node's self-vote suppression; the emitted vote stays committee/anchor/sig-gated
/// and the node ceases to lead once the TC forms (exactly one leader per certified round). O(votes).
pub fn round_one_short_of_quorum(w: u64, voter: &str) -> bool {
    let committee = match failover_committee_for_window(w) { Some(c) => c, None => return false };
    // Must mirror the TC threshold exactly, or the self-yield that rotates the network off a stuck
    // leader fires at a bar no certificate is formed at.
    let quorum = qnet_consensus::checkpoint_bft::quorum_size(committee.len());
    if quorum == 0 { return false; }
    let certified = highest_certified_round_for(w);
    for e in TIMEOUT_VOTES.iter() {
        let (kw, kr) = *e.key();
        if kw != w || kr <= certified { continue; } // live rounds only — a consumed round is no rotation demand
        let voters = e.value();
        if voters.contains_key(voter) { continue; }  // we already voted this round ⇒ not withholding
        // Per ANCHOR group, mirroring the certificate tally: a bucket can now hold two honest
        // anchors, and a certificate is only ever minted from one of them.
        let anchors: std::collections::HashSet<[u8; 32]> = voters.values().map(|v| v.anchor).collect();
        let best = anchors.iter()
            .map(|a| voters.iter().filter(|(v, sv)| v.as_str() != voter && sv.anchor == *a).count())
            .max().unwrap_or(0);
        if best >= quorum.saturating_sub(1) {
            return true;
        }
    }
    false
}

/// True if `voter` holds a stored (sig-verified, committee-filtered, deduped) timeout vote for
/// window `w` at a round ABOVE the highest certified one — a LIVE yield. A consumed vote
/// (round == certified, retained after its TC formed) must NOT keep the fast path firing
/// against a leader that already rotated and recovered within the same window. O(windows).
pub fn window_has_vote_from(w: u64, voter: &str) -> bool {
    let certified = highest_certified_round_for(w);
    TIMEOUT_VOTES
        .iter()
        .any(|e| e.key().0 == w && e.key().1 > certified && e.value().contains_key(voter))
}

/// Failover VIEW floor = the highest FINALIZED window. No honest node forms, accepts, or tallies a
/// vote/TC for a window below it (anti-double-TC: a finalized window is sealed). DERIVED from finality,
/// which is a ratchet and always ≤ this node's applied tip — so the floor can NEVER sit above the
/// window the node is failing over at, the wedge that deafened a rolled-back node in its own window.
pub fn observed_tc_window_floor() -> u64 {
    crate::node::LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::Relaxed)
        / qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL
}

/// On a new 2f+1 TC for window `w`: evict banked votes below `w` so stale keys cannot later be
/// topped-up to quorum (the banked-vote double-TC vector). The floor is finality-derived, not stored.
fn evict_votes_below_certified(w: u64) {
    TIMEOUT_VOTES.retain(|(h, _), _| *h >= w);
}

/// This node's highest-TC hint (window, round) for outbound SyncInfo claims - the window it is
/// actually driving, NOT the finality floor. A floor-derived hint sits by construction below the
/// window a live view change is stuck on, so it could never shorten the stall it exists for.
pub fn current_tc_hint() -> (u64, u64) {
    let mi = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
    let w = observed_tc_window_floor()
        .max(LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed)
             .saturating_add(1) / mi);
    (w, highest_certified_round_for(w))
}

#[cfg(test)]
pub(crate) fn test_insert_timeout_vote(w: u64, round: u64, voter: &str) {
    TIMEOUT_VOTES.entry((w, round)).or_insert_with(HashMap::new).insert(
        voter.to_string(),
        StoredTimeoutVote {
            signature: Vec::new(), anchor: [0u8; 32],
            high_qc_idx: 0, high_qc_hash: [0u8; 32],
            tip_height: 0, tip_hash: [0u8; 32], updated_at: 0,
        },
    );
}

#[cfg(test)]
mod tests_sealed_claim {
    use super::*;

    const W: u64 = 700_000;

    // The evidence that separates a stalled network from a lagging node must be unmovable by <= f
    // liars, and must never drift downward for one voter.
    #[test]
    fn a_seal_claim_is_f_plus_one_evidence_and_never_walks_back() {
        let _g = TEST_FAILOVER_STATE_LOCK.lock();
        VOTER_SEALED_CLAIM.clear();

        note_sealed_claim(W, "a", 900);
        assert_eq!(sealed_frontier_with_support(2), 0, "one signer is not f+1 evidence");

        // A later vote from the same signer carrying a LOWER seal must not lower its claim: high_qc_idx
        // is monotone for an honest node, and a walk-back would let a re-vote erase the evidence.
        note_sealed_claim(W, "a", 40);
        note_sealed_claim(W, "b", 40);
        note_sealed_claim(W, "liar", 9_000);
        assert_eq!(sealed_frontier_with_support(2), 900, "monotone per voter");
        // Two honest signers at 40 outrank the liar: the answer is the highest index `support` signers
        // stand behind, so f Byzantine claims can never push this node into deferring.
        assert_eq!(sealed_frontier_with_support(3), 40, "f liars cannot move the honest floor");

        // A claim carried by a NEWER window still counts: the node this evidence protects is the one
        // voting on the older window, so folding per voter across windows is the whole point.
        note_sealed_claim(W + 1, "c", 40);
        assert_eq!(sealed_frontier_with_support(4), 40, "evidence follows the signer, not the window");
        VOTER_SEALED_CLAIM.clear();
    }
}

/// Shared by every test that reads or writes the process-global failover maps — the harness runs
/// tests in parallel threads, and a sibling's `test_clear_timeout_state()` would otherwise wipe
/// state mid-assertion.
#[cfg(test)]
pub(crate) static TEST_FAILOVER_STATE_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

#[cfg(test)]
pub(crate) fn test_clear_timeout_state() {
    VOTER_SEALED_CLAIM.clear();
    TIMEOUT_VOTES.clear();
    TIMEOUT_CERTIFICATES.clear();
    HIGHEST_CERTIFIED_ROUND.clear();
    FAILOVER_COMMITTEE_CACHE.clear();
}

/// Track which macroblock indices we've already voted for timeout (prevent double-voting)
/// Key: macroblock_index, Value: timeout_round we voted for
static TIMEOUT_VOTED_HEIGHTS: Lazy<Arc<DashMap<u64, u64>>> =
    Lazy::new(|| Arc::new(DashMap::new()));

// v14.8.10: `TIMEOUT_JUMP_TARGET` + `jump_to_highest` REMAIN REMOVED — they
// were the v13.0 Byzantine-inflation attack vector (one signed vote pinning
// the whole network at u64::MAX). Good removal, kept.
// Microblock rotation round is driven ONLY by BFT-consensus state (signed
// same-round 2f+1 TimeoutCertificate `certified`), NEVER by local wall-clock.
// Wall-clock decides WHEN to vote (stall detection), not WHAT round applies for
// producer selection — so a catch-up node and a live producer always select the
// same leader for a height once they share the 2f+1-certified round.

// Per-macroblock baseline finalized round. HIGHEST_CERTIFIED_ROUND
// is keyed per-mb and persists across all 90 heights, so after a stall at
// height K reaching round R every later height in the mb starts with
// rotation_round=R while its own snapshot is 0 → the pre-save guard yields
// every block to the mb boundary, muting the elected producer ~30+ blocks
// (forensic h=15886→15899: producer 005 yielded 14 in a row, round stuck
// at 27 for mb=176). Fix: track the round at which the LAST microblock of
// the mb finalized; effective round = live_round − last_finalized_round
// (resets to 0 each new height after finalization, still detects in-flight
// advances). Monotonic; synced via block application; O(1), ~15KB.

/// Per-macroblock baseline: the rotation round at which the last block of
/// this macroblock was finalized. Used to compute effective rotation round
/// for new heights within the same macroblock.
static LAST_FINALIZED_ROUND_PER_MB: Lazy<Arc<DashMap<u64, u64>>> =
    Lazy::new(|| Arc::new(DashMap::new()));

/// Epoch-keyed committee cache. deterministic_eligible_ids resolves the N-2 VRF committee via a
/// macroblock deserialize+sort+sample (O(E log E)); without caching a timeout-vote/TC flood pays
/// that per message. Cached only for the canonical N-2 source; pruned to a few recent epochs.
static EPOCH_COMMITTEE_CACHE: Lazy<Arc<DashMap<u64, Arc<std::collections::HashSet<String>>>>> =
    Lazy::new(|| Arc::new(DashMap::new()));

/// Records that a microblock for `mb_index` has been finalized at `round`.
/// Monotonic — only advances upward.
///
/// Called from two places:
///   1. Producer side: after `save_block_with_delta` succeeds.
///   2. Validator side: after a peer's block is applied via the pipeline.
///
/// Both paths embed the same `microblock.timeout_round`, so all honest nodes
/// converge on the same baseline.
pub fn record_finalized_round(mb_index: u64, round: u64) {
    LAST_FINALIZED_ROUND_PER_MB
        .entry(mb_index)
        .and_modify(|v| { if round > *v { *v = round; } })
        .or_insert(round);
}

/// Returns the baseline finalized round for `mb_index`. Returns 0 if no block
/// in this macroblock has been applied yet (fresh macroblock).
pub fn get_baseline_round(mb_index: u64) -> u64 {
    LAST_FINALIZED_ROUND_PER_MB
        .get(&mb_index)
        .map(|v| *v)
        .unwrap_or(0)
}

/// Returns the BFT-CERTIFIED rotation round for `mb_index`, relative to the
/// last finalized baseline in this macroblock.
///
/// Strict same-round 2f+1 certified-only — the SOLE rotation input. The round is
/// ML-DSA-65-unforgeable, monotonic per mb, and identical on every honest node
/// within a gossip RTT, so all nodes elect the same producer for a height.
/// Returns 0 if no advance is certified, else N where 2f+1 certified baseline+N.
/// This is the SOLE rotation input to select_microblock_producer_with_round
/// and the value embedded in microblock.timeout_round (Category-B check).
///
/// Scalability: O(1) DashMap reads. Identical cost from 5 to 10 000 super-
/// nodes.
/// ═══════════════════════════════════════════════════════════════════════════
/// The certified rotation round that governs SLOT `h`.
///
/// The failover round is keyed by macroblock window (`h/90`) while a leader tenure is 30 blocks,
/// and 90 = 3 x 30 — so every window rollover lands on the LAST slot of a tenure. Keying that slot
/// on the new (empty) window discards the certificate the network just used to rotate off a dead
/// leader and re-elects it for exactly one slot, once every 90 blocks. Forensic h=169830: the
/// network had produced 29 consecutive slots past a wedged leader on a certified round, then the
/// key rolled to window 1887, the round read 0, and the wedged leader was re-elected — one
/// un-skippable slot, and the chain stopped there.
///
/// A tenure spans at most two windows, so the round governing a slot is the higher of its own
/// window and the window its tenure began in. Both operands are certificate-driven, so this stays
/// a pure function of n-f-certified state — no clock, no node-local frontier.
pub fn certified_round_for_slot(h: u64) -> u64 {
    // The two intervals must keep a tenure inside at most two windows, or reading two is not enough.
    const _: () = assert!(crate::node::ROTATION_INTERVAL_BLOCKS <= qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL);
    let w = h / qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
    let read = |k: u64| HIGHEST_CERTIFIED_ROUND.get(&k).map(|v| *v).unwrap_or(0);
    let tenure_start = (h.saturating_sub(1) / crate::node::ROTATION_INTERVAL_BLOCKS)
        .saturating_mul(crate::node::ROTATION_INTERVAL_BLOCKS)
        .saturating_add(1);
    let w0 = tenure_start / qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
    // Certified entries ONLY. The apply baseline is RAM-resident, never persisted and never
    // repopulated by the boot replay, so folding it in here would make the ceiling — which drives
    // both the election and the ingest gate — differ between a restarted node and its peers. It is
    // also the wrong unit: a rotation round belongs to the tenure that certified it, not to every
    // later tenure that happens to share a window.
    if w0 == w { read(w) } else { read(w).max(read(w0)) }
}

/// Slot-keyed (relative round, baseline) for the producer, mirroring `rotation_round_and_baseline`
/// but with the tenure-carried round above. Both fields come from the same baseline, so the
/// verifier's `block_round + carried_baseline` reconstructs exactly this absolute round.
pub fn rotation_round_and_baseline_for_slot(h: u64) -> (u64, u64) {
    let certified = certified_round_for_slot(h);
    // Clamp the baseline to the slot's ceiling. Applying a carried-round block records that round
    // as the NEXT window's baseline while its certified entry is still 0; an unclamped baseline
    // would then be stamped whole, putting the block's absolute round above the ceiling every
    // honest node checks it against — the boundary repair would just move the halt one slot on.
    let baseline = get_baseline_round(h / qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL).min(certified);
    (certified.saturating_sub(baseline), baseline)
}

pub fn get_certified_rotation_round(mb_index: u64) -> u64 {
    let baseline = get_baseline_round(mb_index);
    let certified = HIGHEST_CERTIFIED_ROUND.get(&mb_index).map(|v| *v).unwrap_or(0);
    certified.saturating_sub(baseline)
}

/// Live-frontier producer helper: returns (relative_round, baseline) from ONE baseline snapshot so
/// the stamped block satisfies `timeout_round + carried_baseline == HIGHEST_CERTIFIED_ROUND[mb]` by
/// construction. Because both fields come from the SAME `baseline`, any pollution in the local
/// baseline CANCELS in the reconstructed absolute round (= certified_abs regardless of baseline) —
/// this is what makes carrying the baseline in-block node-independent AND producer-pollution-immune.
pub fn rotation_round_and_baseline(mb_index: u64) -> (u64, u64) {
    let baseline = get_baseline_round(mb_index);
    let certified = HIGHEST_CERTIFIED_ROUND.get(&mb_index).map(|v| *v).unwrap_or(0);
    (certified.saturating_sub(baseline), baseline)
}

/// #80: serialized 2f+1 TimeoutProof certifying the current failover round for `mb_index`. The
/// producer attaches it to a round>0 microblock so a lagging receiver adopts the round in-band
/// instead of wedging. None on the happy path (no failover round certified). O(1) DashMap read.
pub fn certified_timeout_proof_bytes(mb_index: u64) -> Option<Vec<u8>> {
    let abs = HIGHEST_CERTIFIED_ROUND.get(&mb_index).map(|v| *v).unwrap_or(0);
    if abs == 0 { return None; }
    let proof = TIMEOUT_CERTIFICATES.get(&(mb_index, abs))?;
    bincode::serialize(&*proof).ok()
}

/// The proof for the round SLOT `h` is elected under. A tenure that straddles a window boundary
/// runs on a round certified in the previous window, so the boundary block's proof lives under that
/// window's key — looking only under the block's own window found nothing exactly there, and the
/// receiver then had to pull a certificate the sender was holding all along.
pub fn certified_timeout_proof_for_slot(h: u64) -> Option<Vec<u8>> {
    let abs = certified_round_for_slot(h);
    if abs == 0 { return None; }
    let w = h / qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
    let tenure_start = (h.saturating_sub(1) / crate::node::ROTATION_INTERVAL_BLOCKS)
        .saturating_mul(crate::node::ROTATION_INTERVAL_BLOCKS)
        .saturating_add(1);
    let w0 = tenure_start / qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
    let proof = TIMEOUT_CERTIFICATES.get(&(w, abs))
        .or_else(|| TIMEOUT_CERTIFICATES.get(&(w0, abs)))?;
    bincode::serialize(&*proof).ok()
}

/// Highest failover round for `mb_index` co-signed by ≥ `support` DISTINCT committee voters
/// (TIMEOUT_VOTES is committee-filtered and voter-deduped at insert). With support = f+1 this
/// proves ≥1 honest validator already reached that round, so a node lagging by the certified-round
/// offset may raise its vote TARGET to it and reconverge — instead of voting certified+1 forever
/// while the split never closes. NEVER feeds leader election: the certified/rotation round still
/// advances only on a same-round n-f TC, so this cannot cause dual production. O(active rounds).
pub fn highest_failover_round_with_support(mb_index: u64, support: usize) -> u64 {
    let mut best = 0u64;
    for e in TIMEOUT_VOTES.iter() {
        let (h, r) = *e.key();
        if h == mb_index && r > best && e.value().len() >= support {
            best = r;
        }
    }
    best
}

/// v34: ingest authority for a failover microblock — true iff a relative rotation round
/// `block_round` (the block's `mb.timeout_round`, 0 on the happy path) is BFT-certified:
/// 2f+1 of the committee certified a round ≥ its ABSOLUTE round (`block_round + baseline`).
///
/// This is the EXACT predicate the producer used to pick the round — both read the same
/// `HIGHEST_CERTIFIED_ROUND[mb_idx]` (see `get_certified_rotation_round`) — so the ingest gate
/// and the producer can never disagree on whether a round is authorised.
///
/// Both the producer and this gate read the same `HIGHEST_CERTIFIED_ROUND[mb_idx]`, advanced
/// only by a same-round 2f+1 `TimeoutProof`, so they can never disagree on whether a round is
/// authorised. A round>0 block is admitted iff its absolute round is 2f+1-certified. O(1).
pub fn failover_round_authorized_for_slot(h: u64, block_round: u64, carried_baseline: u64) -> bool {
    // Same slot rule the producer elected under: a tenure that straddles a window boundary keeps
    // its certified round, so the last slot of that tenure is authorised by it.
    certified_round_for_slot(h) >= block_round.saturating_add(carried_baseline)
}

pub fn failover_round_authorized(mb_index: u64, block_round: u64, carried_baseline: u64) -> bool {
    // ABSOLUTE round = block_round + the baseline the block CARRIES (node-independent), NOT the local
    // get_baseline_round (which a same-height loser-apply pollutes). Compare to the window-keyed 2f+1 ceiling.
    // NO block_round==0 short-circuit: carried_baseline is signed but producer-supplied, so a Byzantine
    // round-0 leader could stamp carried_baseline=huge; the abs<=certified check must run for EVERY block
    // (a genuine happy path has abs=baseline<=certified, so certified>=0+cb still holds; only a forged
    // inflated baseline — abs>certified — is rejected, blocking the record_finalized_round poison).
    highest_certified_round_for(mb_index) >= block_round.saturating_add(carried_baseline)
}

/// (f+1)-th highest of a fresh-height multiset (≥1 honest ≥ it). SYNC-HINT REGISTER ONLY — feeds
/// the height oracle (clamp_overclaim / sync targeting), NEVER any consensus derivation: the
/// failover vote key is a pure function of the voter's own verified chain + committee-signed
/// evidence. Floor of 4 fresh corroborators so a lone liar can't steer the hint; below ⇒ 0.
pub fn frontier_order_statistic(mut hs: Vec<u64>) -> u64 {
    if hs.len() < 4 { return 0; }
    let f = hs.len().saturating_sub(1) / 3;
    hs.sort_unstable_by(|a, b| b.cmp(a)); // descending
    hs[f]
}



// Remote-producer heartbeat tracking (two wait-free DashMaps).
// REMOTE_PRODUCER_HEARTBEAT_MS = producer-stamped ts (monotonic, anti-
// replay). REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS = local wall-clock at
// receive — the source of truth for the silence check, NOT the producer's
// clock (which can be NTP-skewed). Bounded by MAX_REMOTE_PRODUCER_TRACKED
// (oldest evicted at cap). O(1)/op.

const MAX_REMOTE_PRODUCER_TRACKED: usize = 10_000;

pub static REMOTE_PRODUCER_HEARTBEAT_MS: Lazy<DashMap<String, u64>> =
    Lazy::new(DashMap::new);

pub static REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS: Lazy<DashMap<String, u64>> =
    Lazy::new(DashMap::new);

// Producer-advertised targeted slot_height (from the signed heartbeat). Lets a validator
// distinguish an alive-and-targeting-our-slot producer (suppress fail-over) from an
// alive-but-stuck-below producer (fail over fast). Bounded with the maps above.
pub static REMOTE_PRODUCER_HEARTBEAT_HEIGHT: Lazy<DashMap<String, u64>> =
    Lazy::new(DashMap::new);

// Observer-based block-rejection aggregator: (height, source_peer_id) →
// set of distinct observer_ids that signed+verified a BlockRejection;
// ≥2f+1 → fork recovery. Keyed on (height,source) so two simultaneous
// Byzantine producers at one height are tracked independently. Bounded by
// committee size; swept by cleanup_block_rejections.
pub static BLOCK_REJECTION_OBSERVERS: Lazy<DashMap<(u64, String), DashSet<String>>> =
    Lazy::new(DashMap::new);

/// Count distinct observer signatures currently observed for the given
/// (height, source_peer_id) tuple. Constant-time DashMap shard lookup.
pub fn count_block_rejection_observers(height: u64, source_peer_id: &str) -> usize {
    BLOCK_REJECTION_OBSERVERS
        .get(&(height, source_peer_id.to_string()))
        .map(|e| e.value().len())
        .unwrap_or(0)
}

/// Periodic eviction of stale rejection tuples below the chain tip.
/// Called by the existing timeout-state cleanup task.
pub fn cleanup_block_rejections(min_height: u64) {
    BLOCK_REJECTION_OBSERVERS.retain(|(h, _), _| *h >= min_height);
}

// ═══════════════════════════════════════════════════════════════════════════
// v16.2: ROUND-CHANGE READY HANDSHAKE — ack accumulator
// ═══════════════════════════════════════════════════════════════════════════
// Maps (mb_idx, round, height, producer_id) → set of distinct ack_ids that
// have signed and verified. Producer reads this to determine when 2f+1
// supermajority is met and it is safe to construct the block at round R.
//
// Capacity: bounded per-tuple by committee size (≤ MAX_VALIDATORS); the
// outer DashMap is bounded by the active-rotation window via the existing
// timeout-state cleanup sweep that prunes by mb_idx.
// ═══════════════════════════════════════════════════════════════════════════
pub static READY_ACKS: Lazy<DashMap<(u64, u64, u64, String), DashSet<String>>> =
    Lazy::new(DashMap::new);

/// Count distinct ack signers currently observed for the given handshake
/// tuple. Constant-time DashMap shard lookup. Caller compares against
/// the 2f+1 threshold computed locally from the active validator count.
pub fn count_ready_acks(mb_idx: u64, round: u64, height: u64, producer_id: &str) -> usize {
    READY_ACKS
        .get(&(mb_idx, round, height, producer_id.to_string()))
        .map(|e| e.value().len())
        .unwrap_or(0)
}

/// Periodic eviction of stale ack tuples. Called by the existing timeout-
/// state cleanup task that prunes other VOTER_* / TIMEOUT_* maps.
pub fn cleanup_ready_acks(min_mb_idx: u64) {
    READY_ACKS.retain(|(mb_idx, _, _, _), _| *mb_idx >= min_mb_idx);
}

/// Wall-clock-ms since this node last received a heartbeat from `producer_id`.
/// Returns `None` when no heartbeat has ever been observed (cold start or
/// peer not yet reachable). Caller compares this against the silent
/// threshold (3s default in the watchdog) to decide whether to broadcast an
/// empty-slot attestation.
pub fn last_remote_producer_heartbeat_age_ms(producer_id: &str) -> Option<u64> {
    let observed = *REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS.get(producer_id)?.value();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Some(now_ms.saturating_sub(observed))
}

/// Record producer liveness from a VERIFIED block. A signed block at height h is strictly
/// stronger evidence than a heartbeat: it proves the producer was alive AND targeting that
/// slot. Costs no extra traffic, so it scales to any committee size — unlike broadcasting a
/// heartbeat from every member. Only advances the observed clock (never rewinds it).
pub fn record_producer_liveness_from_block(producer_id: &str, height: u64) {
    // Only a block ABOVE our applied tip proves CURRENT liveness. Re-delivered or replayed old
    // blocks must not refresh the clock — otherwise a stalled producer reads as fresh while peers
    // replay its history, and the maps grow with producers that are no longer at the frontier.
    if height <= LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) { return; }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS.insert(producer_id.to_string(), now_ms);
    let bump = REMOTE_PRODUCER_HEARTBEAT_HEIGHT.get(producer_id).map(|v| *v.value() < height).unwrap_or(true);
    if bump {
        REMOTE_PRODUCER_HEARTBEAT_HEIGHT.insert(producer_id.to_string(), height);
    }
}

/// Producer-advertised targeted slot_height from the last signed heartbeat, if any.
/// Fail-over is suppressed only when this proves the producer is targeting the stalled
/// slot (>= next_height); an alive-but-stuck-below producer fails over fast.
pub fn last_remote_producer_heartbeat_height(producer_id: &str) -> Option<u64> {
    REMOTE_PRODUCER_HEARTBEAT_HEIGHT.get(producer_id).map(|v| *v.value())
}

/// A verified heartbeat's anchor checked against our own chain. Match/Unknown both keep the leader
/// alive; only Match may set the HEIGHT map that can suppress a view-change — an Unknown claim about a
/// slot we cannot check must never silence the vote that would rotate it.
#[derive(PartialEq, Eq, Debug)]
pub(crate) enum HeartbeatAnchor { Match, Contradicts, Unknown }

pub(crate) fn heartbeat_anchor_verdict(local: Option<&str>, wire: &str) -> HeartbeatAnchor {
    match local {
        Some(h) if h != wire => HeartbeatAnchor::Contradicts,
        Some(_) => HeartbeatAnchor::Match,
        None => HeartbeatAnchor::Unknown,
    }
}

/// The heartbeat anchor rides the wire and is signed, so a behind receiver that does not hold slot-1
/// still verifies the producer alive (Unknown) instead of failing signature reconstruction — the
/// sig_reject storm's root. A wrong anchor for a slot we DO hold is a lie about the frontier (drop);
/// a slot we cannot check must not gain the height that could suppress a rotation vote.
#[cfg(test)]
mod tests_heartbeat_anchor {
    use super::{heartbeat_anchor_verdict, HeartbeatAnchor};

    #[test]
    fn behind_node_does_not_reject_an_honest_leader() {
        // Receiver holds nothing at the leader's tip-1 ⇒ Unknown, not a rejection.
        assert_eq!(heartbeat_anchor_verdict(None, "abc"), HeartbeatAnchor::Unknown);
    }

    #[test]
    fn matching_anchor_is_full_trust() {
        assert_eq!(heartbeat_anchor_verdict(Some("abc"), "abc"), HeartbeatAnchor::Match);
    }

    #[test]
    fn a_lie_about_a_slot_we_hold_is_dropped() {
        assert_eq!(heartbeat_anchor_verdict(Some("abc"), "def"), HeartbeatAnchor::Contradicts);
    }
}

/// Regression guard: producer-silence age is measured against the OBSERVED (local-receive) map only,
/// never the producer-STAMPED map — so a far-future stamp cannot suppress fail-over (anti-gaming),
/// and a fresh receive stays under the silent threshold.
#[cfg(test)]
mod tests_heartbeat_silence {
    fn now_ms() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
    }

    #[test]
    fn observed_fresh_age_under_threshold() {
        let p = "hb_guard_fresh";
        super::REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS.insert(p.to_string(), now_ms());
        let age = super::last_remote_producer_heartbeat_age_ms(p).expect("observed present");
        assert!(age <= 3000, "fresh observed heartbeat age {}ms must be <= 3000ms silent threshold", age);
    }

    #[test]
    fn future_stamp_does_not_reduce_observed_age() {
        let p = "hb_guard_stamp";
        // Stale OBSERVED receive (10s ago) → silent by the observed clock.
        super::REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS.insert(p.to_string(), now_ms().saturating_sub(10_000));
        // Byzantine producer stamps a far-future ts — must NOT reduce the observed-based age.
        super::REMOTE_PRODUCER_HEARTBEAT_MS.insert(p.to_string(), now_ms() + 1_000_000);
        let age = super::last_remote_producer_heartbeat_age_ms(p).expect("observed present");
        assert!(age >= 9_000, "future stamp must not shrink observed age (got {}ms)", age);
    }
}

// v25: validator liveness — miss tracking + reputation penalty (H9+H16).
// A permanently-offline validator left in rotation hurts liveness
// (>=STALL_GRACE_SECS + a timeout-vote round per elected-offline slot) and
// economics (unearned rewards). From REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS:
//   H9 EJECTION: N CONSECUTIVE missed expected slots + no fresh heartbeat
//     -> ejected_until_recovery; macroblock VRF candidate selection skips
//     ejected; auto re-entry on heartbeat resume. GATED behind
//     QNET_LIVENESS_EJECTION (default OFF -> observe-only WARN, no state).
//   H16 REPUTATION: each miss drops deterministic-reputation by
//     OFFLINE_MISS_PENALTY -> lowers VRF selection. Always on; self-correcting.
// Miss key (node_id, slot_height) counted once; consecutive not cumulative
// (a blip won't eject an honest node). O(1), bounded.

/// Per-validator consecutive-miss counter. Resets to 0 on observed
/// heartbeat. Key: validator node_id. Value: (consecutive_miss_count,
/// last_miss_height_observed).
pub static VALIDATOR_CONSECUTIVE_MISSES: Lazy<DashMap<String, (u32, u64)>> =
    Lazy::new(DashMap::new);

/// Set of node_ids currently marked ejected. The VRF candidate-selection
/// path checks membership before adding a node to the candidate list.
/// Membership is removed on heartbeat recovery.
pub static EJECTED_VALIDATORS: Lazy<DashSet<String>> = Lazy::new(DashSet::new);

/// v25 H12: PER-CHUNK FORWARD-ONCE DEDUP SET.
///
/// Tracks `(block_height, chunk_index)` tuples that this local node has
/// already forwarded at least once via `forward_shred_protocol_chunk`.
/// Duplicate arrivals (same chunk from different parents in the cascade
/// tree) are dropped at the forward gate so the relay does not amplify
/// chunks that already reached this node by another path.
///
/// Bounds: ≤ (max_chunks_per_block × concurrent_in-flight_blocks).
/// Typical: ≤ 1000 chunks/block × 30 in-flight = 30 000 entries (each
/// ~32 bytes) → < 1 MB resident. Pruned by the existing post-apply
/// sweep (`prune_forwarded_shred_chunks_below`).
pub static FORWARDED_SHRED_CHUNKS: Lazy<DashSet<(u64, u32)>> =
    Lazy::new(DashSet::new);

/// EMA (1/8 weight) of received block sizes in bytes. Sizes the byte-aware sync
/// shard: under load a "block" spans 20 KB empty to multi-MB full, and a
/// count-only request window ranged 2 MB to 200+ MB — the congestion collapse.
pub static SYNC_BLOCK_SIZE_EMA: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

pub(crate) fn note_sync_block_size(len: usize) {
    let l = len as u64;
    let old = SYNC_BLOCK_SIZE_EMA.load(std::sync::atomic::Ordering::Relaxed);
    let new = if old == 0 { l } else { old - old / 8 + l / 8 };
    SYNC_BLOCK_SIZE_EMA.store(new, std::sync::atomic::Ordering::Relaxed);
}

/// Drop `FORWARDED_SHRED_CHUNKS` entries for blocks that are now part of
/// finalised history (≤ `keep_above`). Called from the existing periodic
/// cleanup that prunes timeout state and gap-sync entries.
pub fn prune_forwarded_shred_chunks_below(keep_above: u64) {
    FORWARDED_SHRED_CHUNKS.retain(|(h, _)| *h > keep_above);
}

/// Consecutive-miss threshold before triggering ejection enforcement. Set
/// generously to avoid false-positive ejection of honest validators
/// experiencing transient gossip jitter or restart-window churn. Reading
/// this through a const so production deploys can tune via rebuild rather
/// than a env-var read on the hot path.
pub const VALIDATOR_MISS_EJECT_THRESHOLD: u32 = 30;

/// Heartbeat-staleness threshold (ms) used by `record_validator_miss` to
/// decide whether a missed-production observation should count against
/// the validator. If the validator's heartbeat is fresh (≤ this age) the
/// miss is attributed to gossip/timing noise rather than the validator
/// itself and no penalty is applied. Aligned with the v23.2 heartbeat
/// gate constant in node.rs:17878 for consistency.
pub const VALIDATOR_HEARTBEAT_STALE_MS: u64 = 3_000;

/// Per-miss reputation decrement. Applied to the deterministic-reputation
/// score on every detected miss while the validator has no fresh
/// heartbeat. Small enough that single transient misses don't crater an
/// honest validator's score; large enough that sustained outages
/// noticeably reduce selection probability.
pub const VALIDATOR_OFFLINE_MISS_PENALTY: f64 = 0.5;

/// Returns true when the operator has opted into automatic ejection.
/// Default OFF — observability runs unconditionally, enforcement only
/// when explicitly enabled.
fn liveness_ejection_enabled() -> bool {
    std::env::var("QNET_LIVENESS_EJECTION").as_deref() == Ok("1")
}

/// Record an observed production miss for `validator_id` at
/// `expected_height`. Idempotent per (id, height) — duplicate calls for
/// the same (id, height) pair after the first do nothing. Should be
/// called from the rotation-decision path (e.g. the producer-loop tick
/// that observed primary timeout). Returns true if the miss was
/// recorded (first observation at this height), false if it was a
/// duplicate suppressed by the dedup gate.
pub fn record_validator_miss(validator_id: &str, expected_height: u64) -> bool {
    // Heartbeat-fresh validators are not penalised: the miss is then
    // attributable to gossip jitter or the v23.2 stall-emit suppression
    // path, not to validator liveness failure.
    if let Some(age_ms) = last_remote_producer_heartbeat_age_ms(validator_id) {
        if age_ms <= VALIDATOR_HEARTBEAT_STALE_MS {
            return false;
        }
    }

    // Dedup: each (id, height) counts at most once. The `last_miss_height`
    // monotonic guard catches duplicate calls from concurrent producer-
    // loop ticks observing the same stalled slot.
    let mut recorded = false;
    let mut consecutive_now: u32 = 0;
    VALIDATOR_CONSECUTIVE_MISSES
        .entry(validator_id.to_string())
        .and_modify(|(count, last_h)| {
            if expected_height > *last_h {
                *count = count.saturating_add(1);
                *last_h = expected_height;
                consecutive_now = *count;
                recorded = true;
            }
        })
        .or_insert_with(|| {
            recorded = true;
            consecutive_now = 1;
            (1, expected_height)
        });

    if recorded && crate::node::is_warn() {
        println!(
            "[WARN][LIVENESS] miss validator={} h={} consecutive={} threshold={}",
            validator_id, expected_height, consecutive_now,
            VALIDATOR_MISS_EJECT_THRESHOLD,
        );
    }

    // H9: ejection (gated). Crossing the threshold triggers an ejection
    // entry — but only if the operator has explicitly opted in. When
    // disabled the threshold crossing is still LOGGED so operators can
    // calibrate before enabling enforcement.
    if recorded && consecutive_now >= VALIDATOR_MISS_EJECT_THRESHOLD {
        if liveness_ejection_enabled() {
            if EJECTED_VALIDATORS.insert(validator_id.to_string()) {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][LIVENESS] eject validator={} consecutive_misses={} action=remove_from_candidates",
                        validator_id, consecutive_now,
                    );
                }
            }
        } else if consecutive_now == VALIDATOR_MISS_EJECT_THRESHOLD {
            // Emit once at threshold-crossing in observability mode so the
            // operator dashboard can correlate ejection-candidate signals
            // without log spam every subsequent miss.
            if crate::node::is_warn() {
                println!(
                    "[WARN][LIVENESS] eject_candidate validator={} consecutive_misses={} action=log_only \
                     hint=set_QNET_LIVENESS_EJECTION_1_to_enforce",
                    validator_id, consecutive_now,
                );
            }
        }
    }

    recorded
}

/// Record an observed successful production by `validator_id`. Resets the
/// consecutive-miss counter and removes any ejection entry. Should be
/// called from the apply-success path (block_pipeline apply_stage) once
/// a block from this validator has been successfully applied.
pub fn record_validator_success(validator_id: &str) {
    let prev = VALIDATOR_CONSECUTIVE_MISSES
        .remove(validator_id)
        .map(|(_, v)| v.0)
        .unwrap_or(0);
    let was_ejected = EJECTED_VALIDATORS.remove(validator_id).is_some();
    if (prev > 0 || was_ejected) && crate::node::is_info() {
        println!(
            "[INFO][LIVENESS] recovered validator={} prior_consecutive_misses={} was_ejected={}",
            validator_id, prev, was_ejected,
        );
    }
}

/// True if `validator_id` is currently marked ejected by the liveness
/// tracker. The VRF candidate-selection path checks this before admitting
/// a validator into the candidate list. When ejection enforcement is
/// disabled (`QNET_LIVENESS_EJECTION` not set to "1") this always returns
/// false — the observability counters still tick, but no candidate is
/// excluded.
pub fn is_validator_ejected(validator_id: &str) -> bool {
    if !liveness_ejection_enabled() {
        return false;
    }
    EJECTED_VALIDATORS.contains(validator_id)
}

/// Best-effort eviction sweep so the heartbeat maps stay bounded for the
/// life of the process. Called from the existing periodic cleanup task.
pub fn evict_stale_producer_heartbeats(max_age_ms: u64) {
    if REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS.len() <= MAX_REMOTE_PRODUCER_TRACKED / 2 {
        return;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS.retain(|_, observed| {
        now_ms.saturating_sub(*observed) <= max_age_ms
    });
    // Mirror eviction so the two maps stay in sync; an unevicted timestamp
    // entry without a corresponding observed entry is harmless but wastes
    // memory at the 100k-validator scale.
    REMOTE_PRODUCER_HEARTBEAT_MS.retain(|producer_id, _| {
        REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS.contains_key(producer_id)
    });
    REMOTE_PRODUCER_HEARTBEAT_HEIGHT.retain(|producer_id, _| {
        REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS.contains_key(producer_id)
    });
}

// v14.7.2: per-microblock BlockCommit aggregation, FAST_FINALIZED_HEIGHT,
// leader-lock statics and helpers REMOVED. Microblock BFT safety is delivered
// by the canonical macroblock commit/reveal path; per-block QC duplicated
// that layer and introduced a rate-limit collision that starved real
// consensus. Self-equivocation for block signing is prevented by ML-DSA-65
// signature uniqueness plus the on-chain DoubleSign slashing detector.

// ═══════════════════════════════════════════════════════════════════
// v4.0: VRF LEADER CLAIMS — slot proofs for the PUBLIC deterministic leader schedule
// Key: leadership_round → Vec<VerifiedLeaderClaim>
// Collected from P2P gossip, verified before storage
// ═══════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VerifiedLeaderClaim {
    pub node_id: String,
    pub round: u64,
    pub vrf_output: [u8; 32],
    pub vrf_proof: Vec<u8>,
    pub reputation: f64,
    pub verified_at: u64,
}

/// Global registry of verified VRF leader claims per round
/// Cleaned up at rotation boundaries (keep last 3 rounds)
pub static LEADER_CLAIMS: Lazy<DashMap<u64, Vec<VerifiedLeaderClaim>>> =
    Lazy::new(|| DashMap::new());

/// Track which rounds we've already broadcast our own claim
static OWN_CLAIM_BROADCAST: Lazy<DashMap<u64, bool>> =
    Lazy::new(|| DashMap::new());

/// Check if QUIC fallback is allowed for given node (rate limiting)
/// Returns true if request is allowed, false if rate limited
pub fn quic_fallback_rate_check(node_id: &str) -> bool {
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    
    let mut entry = QUIC_FALLBACK_RATE_LIMITER
        .entry(node_id.to_string())
        .or_insert((0, now_secs));
    
    let (count, window_start) = entry.value_mut();
    
    // Reset window if expired
    if now_secs - *window_start >= QUIC_FALLBACK_WINDOW_SECS {
        *count = 0;
        *window_start = now_secs;
    }
    
    // Check limit
    if *count >= QUIC_FALLBACK_MAX_PER_MIN {
        QUIC_FALLBACK_RATE_LIMITED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        return false;
    }
    
    // Increment counter and allow
    *count += 1;
    true
}

/// Get QUIC fallback success rate (percentage × 1000 for precision)
/// Returns: (success_count, total_count, success_rate_permille)
pub fn get_quic_fallback_metrics() -> (u64, u64, u64) {
    let success = QUIC_FALLBACK_SUCCESS.load(std::sync::atomic::Ordering::Relaxed);
    let total = QUIC_FALLBACK_TOTAL.load(std::sync::atomic::Ordering::Relaxed);
    let rate_permille = if total > 0 {
        (success * 1000) / total
    } else {
        0
    };
    (success, total, rate_permille)
}

// Cooldown constants
const PEER_COOLDOWN_BASE_SECS: u64 = 2;    // Base cooldown: 2 seconds
const PEER_COOLDOWN_MAX_SECS: u64 = 30;    // Max cooldown: 30 seconds
#[allow(dead_code)]
const PEER_COOLDOWN_RESET_SECS: u64 = 60;  // Reset retry count after 60s of success

/// SYNC: Blacklist reason categories (Soft vs Hard vs Identity-Hard)
/// Soft: Temporary network issues (timeouts, latency) - affects network_score only
/// Hard: Byzantine attacks (invalid blocks, malicious behavior) - permanent until reputation recovered
/// Identity-Hard: Cryptographic impersonation (PK mismatch under bound identity) -
///   permanent for the LIFETIME of the attacker keypair; not subject to
///   reputation recovery because the underlying evidence is mathematical
///   (registered ML-DSA-65 PK does not match presented signature key).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BlacklistReason {
    // SOFT BLACKLIST (Network performance issues - temporary)
    SyncTimeout,        // Failed to respond to sync request (30s soft ban)
    ConnectionFailure,  // Connection refused/reset (60s soft ban)
    SlowResponse,       // Response took too long (15s soft ban)

    // HARD BLACKLIST (Byzantine attacks - permanent until reputation recovered)
    InvalidBlocks,      // Sent invalid/corrupted blocks (permanent until consensus_score >= 70%)
    MaliciousBehavior,  // Detected Byzantine attack (permanent until consensus_score >= 70%)

    // IDENTITY-HARD BLACKLIST (Cryptographic impersonation - permanent by PK)
    // Tracked at the PK-fingerprint layer in `qnet_consensus::consensus_crypto`
    // (canonical source of truth). The peer_addr entry here is a secondary
    // hint used by sync-peer selection — the authoritative gate runs at the
    // QUIC handshake on the presented ML-DSA-65 PK, so even an attacker
    // who rotates source IPs is still rejected.
    PkImpersonation,    // Presented PK ≠ registered PK for a bound identity (permanent)
}

/// SYNC: Blacklist entry with expiration and reason tracking
#[derive(Debug, Clone)]
pub struct BlacklistEntry {
    pub reason: BlacklistReason,
    pub timestamp: Instant,
    pub duration_secs: u64,  // 0 = permanent (hard blacklist)
    pub attempts: u32,       // Number of blacklist violations (escalation)
}

impl BlacklistEntry {
    /// Check if blacklist entry is still active
    pub fn is_active(&self) -> bool {
        if self.duration_secs == 0 {
            // Permanent blacklist (hard) - check reputation instead
            true
        } else {
            // Temporary blacklist (soft) - check expiration
            self.timestamp.elapsed().as_secs() < self.duration_secs
        }
    }
    
    /// Get remaining time in seconds (0 = expired or permanent)
    pub fn remaining_secs(&self) -> u64 {
        if self.duration_secs == 0 {
            // Permanent blacklist
            u64::MAX
        } else {
            let elapsed = self.timestamp.elapsed().as_secs();
            self.duration_secs.saturating_sub(elapsed)
        }
    }
}

/// SECURITY: Rate limiting structure for DDoS protection
#[derive(Debug, Clone)]
pub struct RateLimit {
    pub requests: Vec<u64>,      // Request timestamps
    pub max_requests: usize,     // Maximum requests per window
    pub window_seconds: u64,     // Time window in seconds
    pub blocked_until: u64,      // Blocked until timestamp (0 = not blocked)
}

/// SECURITY: Nonce record for replay attack prevention
#[derive(Debug, Clone)]
pub struct NonceRecord {
    pub nonce: String,
    pub timestamp: u64,
    pub used: bool,
}

/// Peer metrics structure for real network monitoring
#[derive(Debug, Clone)]
pub struct PeerMetrics {
    pub latency_ms: u32,
    pub block_height: u64,
}

/// Simple node types for P2P
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
/// v3.18: Full node type REMOVED - only Light and Super remain
pub enum NodeType {
    Light,   // Mobile-only pure API client (phone/tablet, Android/iOS, F-Droid).
             // Stores ZERO blockchain data on-device (max_storage_bytes=0).
             // Queries balance/TX history via REST API on Super nodes.
             // Responds to Genesis-driven pings → earns PoP rewards.
             // Disqualified from consensus (`is_consensus_qualified() = false`).
    Super,   // Server nodes - validates and produces blocks
}

/// Geographic regions for basic clustering
#[derive(Debug, Clone, PartialEq, Hash, Eq, Serialize, Deserialize)]
pub enum Region {
    NorthAmerica,
    Europe,
    Asia,
    SouthAmerica,
    Africa,
    Oceania,
}

/// Peer information with load metrics and Kademlia DHT support
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub id: String,
    pub addr: String,
    pub node_type: NodeType,
    pub region: Region,
    pub last_seen: u64,
    pub is_stable: bool,
    pub latency_ms: u32,        // Network latency in milliseconds
    pub connection_count: u32,   // Number of active connections
    pub bandwidth_usage: u64,    // Bytes per second
    // Kademlia DHT fields
    #[serde(default)]
    pub node_id_hash: Vec<u8>,  // SHA3-256 hash for XOR distance
    #[serde(default)]
    pub bucket_index: usize,    // K-bucket this peer belongs to
    
    // ═══════════════════════════════════════════════════════════════════════════
    // REPUTATION v2.45.1: Cached from DeterministicReputationState
    // ═══════════════════════════════════════════════════════════════════════════
    // Source of truth: DeterministicReputationState (in blockchain)
    // This cached value is populated via get_node_reputation_from_blockchain()
    // when PeerInfo is created. Used for P2P peer selection and consensus checks.
    // ═══════════════════════════════════════════════════════════════════════════
    #[serde(default = "default_reputation_70")]
    pub reputation: f64,   // Cached blockchain reputation (70-100 scale)
    
    // LEGACY FIELDS - kept for serde backward compatibility only
    #[serde(default = "default_reputation_70")]
    #[doc(hidden)]
    pub consensus_score: f64,   // LEGACY: Use `reputation` field instead
    
    #[serde(default = "default_reputation_100")]
    #[doc(hidden)]
    pub network_score: f64,     // LEGACY: Not used anymore
    
    #[serde(default)]
    #[doc(hidden)]
    pub reputation_score: Option<f64>,  // LEGACY: Not used anymore
    
    #[serde(default)]
    pub successful_pings: u32,  // Successful interactions
    #[serde(default)]
    pub failed_pings: u32,      // Failed interactions
    
    // v2.24.3: Track peer's blockchain height (from blocks/heartbeats)
    // Enables QUIC-only sync without HTTP height queries
    #[serde(default)]
    pub last_block_height: u64,

    // v30.A3: wall-clock secs of the last height-attesting event for this peer
    // (signed HealthPing / verified handshake ONLY — served-block heights no
    // longer attest a tip). Unauthenticated paths leave this at 0.
    // `get_max_peer_height` filters on freshness against this — stale or
    // unattested entries are excluded from `network_height` consensus, which
    // collapses the empty-batch → cache-poisoning → permanent sync-mode loop.
    #[serde(default)]
    pub last_height_attested_at: u64,

    // FIX R23-P1: Track connection direction for eclipse protection.
    // true = we initiated the connection (outbound), false = they connected to us (inbound).
    // Outbound slots are reserved to prevent eclipse attacks where an attacker
    // fills all our peer slots via inbound connections.
    #[serde(default)]
    pub is_outbound: bool,
}

fn default_reputation_70() -> f64 {
    // v2.45.1: Use INITIAL_REPUTATION from consensus module
    // Real reputation loaded from DeterministicReputationState
    qnet_consensus::deterministic_reputation::INITIAL_REPUTATION
}

fn default_reputation_100() -> f64 {
    // v2.45.1: Legacy field default
    100.0
}

/// Network event types for P2P routing optimization
/// ═══════════════════════════════════════════════════════════════════════════
/// ARCHITECTURE v2.21: CONSENSUS REPUTATION MOVED TO BLOCKCHAIN
/// 
/// OLD (REMOVED):
/// - FullRotationComplete, InvalidBlock, ConsensusParticipation, MaliciousBehavior
/// - These affected consensus_score via P2P - NOT DETERMINISTIC!
/// 
/// NEW (deterministic_reputation.rs):
/// - Reputation computed ONLY from blockchain data
/// - All nodes compute same result from same blocks
/// - Slashing requires cryptographic proof in MacroBlock
/// 
/// REMAINING (network_score only - for P2P routing, NOT consensus):
/// - TimeoutFailure: -2.0 network_score (WAN latency)
/// - ConnectionFailure: -5.0 network_score (offline)
/// ═══════════════════════════════════════════════════════════════════════════
#[derive(Debug, Clone, Copy)]
pub enum ReputationEvent {
    // ═══════════════════════════════════════════════════════════════════════
    // DEPRECATED CONSENSUS EVENTS - DO NOT USE!
    // Reputation now computed from blockchain via DeterministicReputationState
    // ═══════════════════════════════════════════════════════════════════════
    #[deprecated(note = "RAM telemetry only; consensus reputation is the on-chain equivocation ban-set")]
    FullRotationComplete,
    #[deprecated(note = "RAM telemetry only; slashing is the on-chain equivocation ban-set (cryptographic proof)")]
    InvalidBlock,
    #[deprecated(note = "RAM telemetry only; participation/liveness is the on-chain heartbeat gate")]
    ConsensusParticipation,
    #[deprecated(note = "RAM telemetry only; slashing is the on-chain equivocation ban-set (cryptographic proof)")]
    MaliciousBehavior,
    
    // ═══════════════════════════════════════════════════════════════════════
    // ACTIVE NETWORK EVENTS - For P2P routing optimization ONLY
    // These affect network_score (local, not synced) - used for peer prioritization
    // ═══════════════════════════════════════════════════════════════════════
    TimeoutFailure,         // -2.0 network_score: P2P timeout (WAN latency)
    ConnectionFailure,      // -5.0 network_score: Connection failed (offline)
}

impl PeerInfo {
    /// Get cached reputation score (from blockchain)
    /// ═══════════════════════════════════════════════════════════════════════════
    /// ARCHITECTURE v2.45.1: Returns cached blockchain reputation
    /// 
    /// Get peer's cached blockchain reputation
    /// ═══════════════════════════════════════════════════════════════════════════
    /// This is cached from DeterministicReputationState when PeerInfo was created.
    /// For authoritative value, use SimplifiedP2P::get_node_reputation_from_blockchain()
    /// ═══════════════════════════════════════════════════════════════════════════
    pub fn reputation(&self) -> f64 {
        self.reputation
    }
    
    /// Backward compatibility alias
    #[inline]
    pub fn combined_reputation(&self) -> f64 {
        self.reputation
    }
    
    /// Check if peer is qualified for consensus (cached check)
    /// ═══════════════════════════════════════════════════════════════════════════
    /// WARNING: For authoritative consensus check, use:
    /// SimplifiedP2P::can_node_participate_in_consensus(&node_id)
    /// ═══════════════════════════════════════════════════════════════════════════
    pub fn is_consensus_qualified(&self) -> bool {
        // Light nodes are EXCLUDED from consensus (only Super and Full nodes)
        if self.node_type == NodeType::Light {
            return false;
        }
        // Super and Full nodes must meet Byzantine threshold (70%)
        // This is CACHED - for authoritative check use can_node_participate_in_consensus()
        self.consensus_score >= qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION
    }
    
    /// Migrate legacy reputation_score to cached reputation
    pub fn migrate_legacy_reputation(&mut self) {
        if let Some(legacy_score) = self.reputation_score {
            // Migrate legacy score to cached blockchain reputation
            self.consensus_score = legacy_score;
            self.network_score = legacy_score;
            self.reputation_score = None; // Clear legacy field
        }
    }
}

/// Regional load balancing metrics
#[derive(Debug, Clone)]
pub struct RegionalMetrics {
    pub region: Region,
    pub average_latency: u32,
    pub total_peers: u32,
    pub available_capacity: f32,  // 0.0-1.0 (1.0 = fully available)
    pub last_updated: Instant,
}

/// Load balancing configuration
#[derive(Debug, Clone)]
pub struct LoadBalancingConfig {
    pub max_latency_threshold: u32,   // 150ms max latency
    pub rebalance_interval_secs: u64, // 60 seconds between rebalancing
    pub min_peers_per_region: u32,   // 2 minimum peers per region
    pub max_peers_per_region: u32,   // 8 maximum peers per region
}

impl Default for LoadBalancingConfig {
    fn default() -> Self {
        // Use EXISTING network size detection from auto_p2p_selector
        let network_size = LoadBalancingConfig::detect_network_size();
        let adaptive_peer_limit = LoadBalancingConfig::calculate_adaptive_peer_limit(network_size);
        
        Self {
            max_latency_threshold: 150,   // 150ms latency threshold
            rebalance_interval_secs: 1,   // QUANTUM: Real-time rebalancing
            min_peers_per_region: 2,      // Minimum 2 peers per region
            max_peers_per_region: adaptive_peer_limit, // ADAPTIVE: Based on network size detection
        }
    }
}

impl LoadBalancingConfig {
    /// EXISTING: Detect current network size using auto_p2p_selector logic
    fn detect_network_size() -> u32 {
        // Use EXISTING environment variable check for network sizing
        if let Ok(bootstrap_id) = std::env::var("QNET_BOOTSTRAP_ID") {
            if ["001", "002", "003", "004", "005"].contains(&bootstrap_id.as_str()) {
                // Genesis phase: small network (< 100 nodes from auto_p2p_selector)
                return 50; // EXISTING config.ini max_peers value
            }
        }
        
        // Normal phase: use EXISTING thresholds from auto_p2p_selector.rs
        // Default assumption: medium network (100-1000 range)
        500 // EXISTING estimated network size from bridge-server.py
    }
    
    /// PRODUCTION: Calculate adaptive peer limit based on network size
    fn calculate_adaptive_peer_limit(network_size: u32) -> u32 {
        // PRODUCTION: Increased limits for million-node scalability
        // Based on testing: 2000 peers = ~400KB memory, negligible for modern servers
        match network_size {
            0..=100 => 8,      // Genesis phase: minimal connections
            101..=1000 => 50,  // Small network: moderate connections
            1001..=100000 => 500, // Medium network: increased from 100 for better connectivity
            _ => 2000,          // Large network: increased from 500 for 1M+ nodes scalability
        }
    }
}

/// QUANTUM SCALABILITY: Advanced P2P structure for millions of nodes
/// Combines lock-free DashMap, dual indexing, and existing sharding
pub struct SimplifiedP2P {
    /// Node identification
    pub node_id: String,
    node_type: NodeType,
    region: Region,
    port: u16,
    /// Our external IP address (to prevent self-connection)
    external_ip: Arc<RwLock<Option<String>>>,

    /// Weak handle to ourselves, published by `start`. Background discovery tasks are `'static`
    /// and used to hold only a clone of the peer map, which let them write it without admission;
    /// upgrading this keeps `add_peer_lockfree` the single writer.
    self_ref: Arc<RwLock<std::sync::Weak<Self>>>,

    /// Regional peer management with load balancing
    regional_peers: Arc<Mutex<HashMap<Region, Vec<PeerInfo>>>>,
    
    // QUANTUM OPTIMIZATION: Lock-free DashMap for millions of concurrent operations
    // Primary index: address -> PeerInfo (O(1) all operations)
    connected_peers_lockfree: Arc<DashMap<String, PeerInfo>>,
    
    // DUAL INDEXING: Secondary index for O(1) ID lookups
    peer_id_to_addr: Arc<DashMap<String, String>>,  // node_id -> address
    
    // SHARDING: Use existing qnet_sharding for distribution
    shard_id: u8,  // This node's shard (0-255)
    peer_shards: Arc<DashMap<u8, Vec<String>>>,  // shard -> peer addresses
    
    // v5.1: Full Kademlia DHT routing table (256 k-buckets × K=20 peers)
    kademlia_table: Arc<KademliaRoutingTable>,
    
    regional_metrics: Arc<Mutex<HashMap<Region, RegionalMetrics>>>,
    
    /// Load balancing configuration
    lb_config: LoadBalancingConfig,
    
    /// SECURITY: Rate limiting for DDoS protection  
    /// PRODUCTION: DashMap for lock-free access at scale
    rate_limiter: Arc<DashMap<String, RateLimit>>,
    
    /// SECURITY: Request nonces for replay attack prevention
    /// PRODUCTION: DashMap for lock-free access at scale
    nonce_validator: Arc<DashMap<String, NonceRecord>>,
    
    /// Simple failover
    primary_region: Region,
    backup_regions: Vec<Region>,
    
    /// Enhanced metrics for load balancing
    last_health_check: Arc<Mutex<Instant>>,
    last_rebalance: Arc<Mutex<Instant>>,
    connection_count: Arc<Mutex<usize>>,
    total_bytes_sent: Arc<Mutex<u64>>,
    total_bytes_received: Arc<Mutex<u64>>,
    
    /// Network status
    is_running: Arc<Mutex<bool>>,
    
    /// Leadership tracking for failover detection
    #[allow(dead_code)]
    previous_leader: Arc<Mutex<Option<String>>>,
    
    // DEPRECATED v2.38: slashing_collector removed
    // Slashing now determined on-chain via analyze_chain_for_slashing()
    
    /// Block processing channel - CRITICAL: Must be Arc for sharing between clones!
    block_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<ReceivedBlock>>>>,
    
    /// Sync request channel for requesting blocks from storage
    /// v5.6: Extended with from_peer address so responses can reach unregistered peers
    sync_request_tx: Option<tokio::sync::mpsc::Sender<(u64, u64, String, String)>>,
    
    /// ShredProtocol block assembly states
    shred_protocol_assemblies: Arc<DashMap<u64, ShredProtocolBlockAssembly>>,
    
    /// CRITICAL: Track already processed blocks to prevent infinite loop
    /// When a block is reconstructed, its height is added here to skip duplicate chunks
    processed_shred_blocks: Arc<DashSet<u64>>,
    
    /// PRODUCTION v2.21.3: Cache chunks for retransmit responses
    /// Key: block_height, Value: (chunks, parity_chunks, original_size, is_macroblock, timestamp)
    /// Cached for SHRED_CHUNK_CACHE_SIZE most recent blocks
    shred_chunk_cache: Arc<DashMap<u64, ShredChunkCacheEntry>>,
    
    /// PRODUCTION: Certificate management for compact signatures
    pub certificate_manager: Arc<RwLock<CertificateManager>>,
    
    /// PRODUCTION: Light Node registry synchronized via gossip
    /// All Super nodes maintain identical registry for deterministic ping assignment
    light_node_registry: Arc<RwLock<HashMap<String, LightNodeRegistrationData>>>,
    /// Per-window ping-slot buckets for THIS genesis's shard: (window, registry_len, [slot 0..239]→node_ids).
    /// Rebuilt only on window/size change ⇒ ping selection is O(bucket)/tick, not O(N log N) clone+sort of
    /// the whole registry every tick — scales the 5-genesis pinger to millions of light nodes.
    light_ping_slot_cache: Arc<RwLock<(u64, usize, Vec<Vec<String>>)>>,


    /// PRODUCTION: Storage reference for persistent heartbeat storage
    /// SCALABILITY: Each node stores ONLY its own heartbeats in RocksDB (10 records per 4h)
    /// Supports millions of nodes without RAM limitations
    storage: Option<Arc<crate::storage::Storage>>,
    
    /// PRODUCTION: Last heartbeat cleanup timestamp (remove entries >24h)
    
    /// PRODUCTION: Light Node attestations for reward eligibility
    /// Key: "{light_node_id}:{slot}", Value: LightNodeAttestation
    /// Dedupe ensures only one attestation per Light node per slot
    light_node_attestations: Arc<RwLock<HashMap<String, LightNodeAttestation>>>,
    /// Per-epoch attested light node_ids (uncapped, compact), populated at every attestation insert
    /// so the shard bitmap reflects ALL responders — not just the 100k-capped attestation map.
    /// Pruned to the few most recent epochs.
    epoch_light_eligible: Arc<RwLock<HashMap<u64, std::collections::HashSet<String>>>>,
    
    /// PRODUCTION: Active Super nodes for pinger selection
    /// Updated via gossip, used for deterministic pinger assignment
    /// Key: node_id, Value: ActiveNodeInfo
    /// PRODUCTION v2.51: Lock-free DashMap for 10x faster producer selection
    active_full_super_nodes: Arc<DashMap<String, ActiveNodeInfo>>,
    
    /// PRODUCTION: Macroblock sync request channel
    /// Used for requesting macroblocks from storage (similar to sync_request_tx)
    macroblock_sync_request_tx: Option<tokio::sync::mpsc::Sender<(u64, u64, String, String)>>,
    
    /// PRODUCTION: Macroblock processing channel
    /// Received macroblocks are sent here for validation and storage
    macroblock_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<ReceivedBlock>>>>,
    
    /// PRODUCTION v2.19.21: QUIC transport for high-performance P2P
    /// High-performance transport with persistent connections
    /// Uses binary protocol (bincode) instead of JSON for efficiency
    quic_transport: Option<Arc<tokio::sync::RwLock<crate::quic_transport::QuicTransport>>>,
    
    /// PRODUCTION: QUIC enabled flag (pure QUIC mode - no HTTP fallback)
    quic_enabled: Arc<std::sync::atomic::AtomicBool>,
    
    /// PRODUCTION v2.19.22: QUIC message channel for full message processing
    /// All QUIC messages are sent here and processed via handle_message()
    /// This ensures QUIC messages use same logic as HTTP (no duplication)
    quic_message_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<(String, NetworkMessage)>>>>,
    /// QoS bulk lane: floodable sync-serving msgs (RequestBlocks/RequestMacroblocks/
    /// Blocks|MacroblocksBatch/StateSnapshot) routed here, drained by a dedicated
    /// worker so a cold-sync flood can never delay the consensus lane.
    quic_bulk_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<(String, NetworkMessage)>>>>,
    /// QoS finality lane: non-redundant 2f+1 checkpoint-BFT + round-change msgs routed
    /// here, drained by a dedicated worker so a gossip/shred flood can never drop the
    /// votes that assemble the finality QC.
    quic_finality_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<(String, NetworkMessage)>>>>,

    /// PRODUCTION v2.19.25: Transaction processing channel
    /// Received transactions from P2P are sent here for validation and mempool
    /// This enables full transaction propagation across the network
    transaction_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<ReceivedTransaction>>>>,
    
    /// GULF STREAM v2.25: Current block producer for TX forwarding
    /// TX is sent directly to producer (0 hops) + backup gossip (reliability)
    /// Updated by node.rs after each block via set_current_producer()
    /// Format: (producer_node_id, producer_address)
    current_producer_info: Arc<RwLock<Option<(String, String)>>>,
    
    /// ANTI-STORM v2.25: Seen transaction hashes to prevent gossip amplification
    /// TX is only forwarded ONCE - prevents exponential message growth
    /// Auto-cleaned every 60 seconds (TX older than 2 minutes removed)
    /// Capacity: 1M TX hashes (~64MB memory)
    seen_tx_hashes: Arc<DashSet<String>>,

    /// v9.1: Dedup for ActiveNodeAnnouncement gossip (prevents 27× Dilithium re-verification).
    /// Key: "node_id:timestamp" — cleared every 60s alongside seen_tx_hashes.
    seen_announcements: Arc<DashSet<String>>,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v2.50.0: POOL 2 & POOL 3 ACCUMULATORS
    // Accumulated fees/activations for deterministic reward distribution
    // Reset to 0 after each EMISSION MacroBlock (every 160 = 4 hours)
    // Values are stored in MacroBlock for all nodes to use identical amounts
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Pool 2: Accumulated transaction fees (nanoQNC) - v3.18: DEPRECATED
    /// v3.18: Pool 2 removed - fees go directly to block producer
    /// This field kept for backward compatibility (always 0)
    /// Reset after each EMISSION MacroBlock (every 4 hours)
    pool2_accumulated_fees: Arc<AtomicU64>,
    
    /// Pool 3: Accumulated node activation payments (nanoQNC)
    /// Phase 1: Always 0 (1DEV burn, Pool 3 disabled)
    /// Phase 2: Sum of all activation payments (equal share to ALL nodes)
    /// Reset after each EMISSION MacroBlock (every 4 hours)
    pool3_accumulated_activations: Arc<AtomicU64>,

    /// v5.0: Wallet identity for ML-DSA-65 message signing (HealthPing, etc.)
    /// Set via set_wallet_identity() after BlockchainNode initialization
    wallet_identity: Arc<parking_lot::RwLock<Option<Arc<crate::crypto::vrf::WalletIdentity>>>>,
}

/// PQ: Simplified certificate manager for microblocks only
/// Macroblocks use full signatures with embedded certificates
#[derive(Debug, Clone)]
pub struct CertificateManager {
    /// Local certificates (our own)
    local_certificate: Option<(String, Vec<u8>)>,  // (cert_serial, serialized certificate)
    
    /// Remote certificates for active microblock producers (small cache)
    /// Only ~30 producers per rotation, no need for complex LRU
    remote_certificates: HashMap<String, (Vec<u8>, u64)>,  // cert_serial -> (certificate, timestamp)
    
    /// OPTIMISTIC: Pending certificates awaiting verification (prevents race conditions)
    /// These can be used for block verification but are marked as "conditional"
    pending_certificates: HashMap<String, (Vec<u8>, u64, String)>,  // cert_serial -> (cert, timestamp, node_id)
    
    /// Certificate TTL (4 hours - enough for multiple rotations)
    certificate_ttl: Duration,
    
    /// Maximum cache size for scalability (limit to active producers only)
    max_cache_size: usize,
    
    /// SECURITY: Track which certificates were recently used for block verification
    /// This helps prioritize active producers during cache eviction (anti-pollution)
    recently_used: HashSet<String>,  // cert_serial set of recently used certificates
    
    /// SECURITY: Track usage count for prioritization during eviction
    usage_count: HashMap<String, u32>,  // cert_serial -> usage count
    
    // v3.50: certificate_history removed — Dilithium-only verification
    // Ed25519 rotation chain provided zero additional security over Dilithium
}


// Kademlia DHT constants
const KADEMLIA_K: usize = 20;        // K-bucket size
const KADEMLIA_ALPHA: usize = 3;     // Concurrent queries
const KADEMLIA_BITS: usize = 256;    // Hash size in bits
const KADEMLIA_REFRESH_INTERVAL_SECS: u64 = 600; // Refresh stale buckets every 10 min
#[allow(dead_code)]
const KADEMLIA_LOOKUP_TIMEOUT_MS: u64 = 5000;    // Single lookup round timeout
#[allow(dead_code)]
const KADEMLIA_MAX_HOPS: u8 = 5;                 // Max iterative lookup rounds

/// Production Kademlia DHT routing table with 256 k-buckets.
/// Each bucket holds up to K=20 peers sorted by last_seen (LRU tail = eviction candidate).
/// Thread-safe via DashMap for lock-free concurrent access at scale.
pub struct KademliaRoutingTable {
    local_id_hash: [u8; 32],
    buckets: Arc<DashMap<usize, Vec<KademliaPeer>>>,
    bucket_last_refresh: Arc<DashMap<usize, u64>>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct KademliaPeer {
    pub node_id: String,
    pub addr: String,
    pub id_hash: [u8; 32],
    pub last_seen: u64,
    pub reputation: f64,
}


// ShredProtocol block propagation constants
// v2.43.7: CRITICAL FIX - Increased chunk size to avoid Reed-Solomon TooManyShards error
// GF(2^8) Reed-Solomon supports max 255 shards (data + parity combined)
// At 1KB chunks: 14MB block = 14000 chunks → TooManyShards FAILURE
// At 512KB chunks: 80MB block = 156 chunks × 1.5 = 234 shards → OK! (v4.1)
// v4.1: Increased to 512KB (2x) for 200K TX/block support (170 × 512KB = 87MB max)
const SHRED_PROTOCOL_CHUNK_SIZE: usize = 512 * 1024;  // 512KB chunks (v4.1: was 256KB - 2x for 200K TX/block)
const SHRED_PROTOCOL_REDUNDANCY_FACTOR: f32 = 1.5;    // 50% redundancy for Reed-Solomon  
const SHRED_PROTOCOL_MAX_CHUNKS: usize = 170;         // Max data chunks (170 + 85 parity = 255 ≤ GF(2^8) limit)
                                                      // v4.1: 170 × 512KB = 87MB max block size
                                                      // Supports 200K TX/block with proper Reed-Solomon encoding
const SHRED_CHUNK_TIMEOUT_SECS: u64 = 5;            // Timeout before requesting missing chunks (v2.31: increased from 3s for reliability)
// v24: Cache last 5000 blocks' chunks for retransmit (was 100 in v2.21.3).
//
// At 1 block/sec a 100-entry cache only covers 100 seconds of history — far
// shorter than the worst-case sync lag observed on a 5-node testnet (267
// blocks missing on the slowest peer after 24 minutes). When a peer requests
// chunks for a block already evicted from the producer's cache, repair
// fails and the block becomes permanently unrecoverable from gossip;
// the peer is then forced into full-range SyncManager catch-up which is
// orders of magnitude more expensive than a single-chunk retransmit.
//
// 5000 blocks at SHRED_PROTOCOL_MAX_CHUNKS × SHRED_PROTOCOL_CHUNK_SIZE upper
// bound = 5000 × 255 × 512 KB = 652 GB worst case if every block hits the
// 200K-TX ceiling. In practice average block sizes are <100 KB, giving a
// realistic working-set of 5000 × 100 KB × 1.5 redundancy = ~750 MB cache,
// comfortably inside the 2 GB storage budget on a Super-node.
//
// Scalability: cache is per-node-local (no replication overhead). Identical
// memory cost from 5 to 100 000 super-nodes. The benefit grows with chain
// length — longer-running networks have more frequent repair requests, and
// a 5000-block window covers ~83 minutes of history at 1 block/sec, ample
// for any honest peer to detect and repair its gaps before eviction.
const SHRED_CHUNK_CACHE_SIZE: usize = 5_000;
const SHRED_CHUNK_MAX_RETRIES: u8 = 4;              // Max retransmit attempts per block (v2.31: increased from 2 for reliability)
#[allow(dead_code)]
const MAX_CONCURRENT_CHUNK_SENDS: usize = 20;       // Max concurrent QUIC streams for chunk sends (v2.21.4)
                                                     // Prevents receiver overload from burst of 72+ streams

// ============================================================================
// PRODUCTION v2.45: ADAPTIVE PACING CONSTANTS
// ============================================================================
// Prevents UDP burst and packet loss under high load by:
// 1. Batching chunk sends with delays
// 2. Dynamically adjusting delay based on failure rate
//
// CRITICAL CALCULATION for 100K TPS:
// - 20MB block = 156 data + 78 parity = 234 chunks
// - With fanout 6: 234 × 6 = 1404 sends
// - Must complete in <500ms to leave time for propagation
// - At batch=100 and delay=2ms: 14 batches × 2ms = 28ms overhead 
const PACING_BATCH_SIZE_DEFAULT: usize = 100;    // Chunks per batch (optimized for 100K TPS)
const PACING_BATCH_SIZE_MIN: usize = 50;         // Minimum batch size (high failure rate)
const PACING_DELAY_MS_DEFAULT: u64 = 2;          // Base delay between batches (reduced from 10ms!)
const PACING_DELAY_MS_MAX: u64 = 20;             // Maximum delay between batches (reduced from 100ms)
const PACING_FAILURE_THRESHOLD: f32 = 0.15;      // 15% failure rate triggers backpressure
const PACING_FAILURE_CRITICAL: f32 = 0.35;       // 35% failure rate triggers aggressive backpressure

/// PRODUCTION v2.45: Global failure rate tracking for adaptive pacing
static SHRED_SEND_SUCCESS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static SHRED_SEND_FAILURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static SHRED_LAST_FAILURE_RATE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0); // ×1000 for precision

/// ShredProtocol chunk for block propagation
/// v2.26: Added certificate field to eliminate certificate race condition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShredProtocolChunk {
    pub block_height: u64,
    pub chunk_index: usize,
    pub total_chunks: usize,
    pub data: Vec<u8>,
    pub is_parity: bool,  // Reed-Solomon parity chunk
    pub original_block_size: usize,  // CRITICAL: Original block size for correct reconstruction
    pub is_macroblock: bool,  // PRODUCTION: Distinguish macro/micro for correct deserialization
    /// v2.26: Producer certificate included in chunk #0 (data chunks only)
    /// This eliminates race condition where block arrives before certificate
    /// ~3KB overhead only in first chunk, but guarantees atomic block+cert delivery
    #[serde(default)]
    pub certificate: Option<ProducerCertificate>,
    /// FIX R23-P3: SHA3-256 hash of the original block data, set by the producer.
    /// After reconstruction, the receiver verifies H(reconstructed_block) == block_hash
    /// to detect chunk corruption/tampering before expensive full-block validation.
    #[serde(default)]
    pub block_hash: Option<[u8; 32]>,
    /// TPS/self-describing FEC: the number of Reed-Solomon CODING (parity) shreds the PRODUCER actually
    /// generated for this block. The decoder MUST reconstruct with `ReedSolomon::new(total_chunks,
    /// num_coding_shreds)` — the SAME dimensions the encoder used. Guessing it (the legacy `total*0.5`
    /// estimate) mismatches an adaptive-redundancy encoder (2.0–2.5×) and makes `rs.reconstruct()` return
    /// Ok-but-WRONG bytes (caught downstream by block_hash ⇒ discard ⇒ repair storm under load). Carried
    /// on EVERY chunk so any first-seen chunk sizes the parity vector correctly. serde(default)=0 means
    /// "producer didn't populate it" ⇒ decoder falls back to the legacy estimate (never hit at fresh
    /// genesis, where every chunk carries the true count).
    #[serde(default)]
    pub num_coding_shreds: usize,
}

/// v2.26: Producer certificate for block signature verification
/// Included in SHRED_PROTOCOL chunks to eliminate race condition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProducerCertificate {
    pub serial_number: String,
    pub node_id: String,
    pub certificate_bytes: Vec<u8>,  // Serialized PqCertificate
}

/// ShredProtocol block assembly state
#[derive(Debug)]
#[allow(dead_code)]
struct ShredProtocolBlockAssembly {
    height: u64,
    chunks_received: Vec<Option<Vec<u8>>>,
    parity_chunks: Vec<Option<Vec<u8>>>,
    total_chunks: usize,
    parity_count: usize,
    original_block_size: usize,  // CRITICAL: Store original size for reconstruction
    is_macroblock: bool,  // PRODUCTION: Track block type for correct deserialization
    started_at: Instant,
    retransmit_attempts: u8,  // PRODUCTION v2.21.3: Track retransmit attempts
    retransmit_requested_at: Option<Instant>,  // When last retransmit was requested
    /// v2.26: Certificate received from chunk #0 (eliminates race condition)
    certificate: Option<ProducerCertificate>,
    /// FIX R23-P3: Expected block hash from producer for post-reconstruction verification
    expected_block_hash: Option<[u8; 32]>,
}

/// PRODUCTION v2.21.3: Cache entry for chunk retransmit
/// Stores chunks from successfully received blocks for responding to RequestMissingChunks
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct ShredChunkCacheEntry {
    chunks: Vec<Option<Vec<u8>>>,       // Data chunks
    parity_chunks: Vec<Option<Vec<u8>>>, // Parity chunks
    original_block_size: usize,
    is_macroblock: bool,
    cached_at: Instant,
    // Block identity + parity code of the cached set. Failover legitimately produces two
    // blocks at one height; an identity-less cache mixed their chunks and repair then
    // spread the mix — every rebuild of it hashed wrong and was discarded, forever.
    block_hash: Option<[u8; 32]>,
    num_coding: usize,
}

#[allow(dead_code)]
impl SimplifiedP2P {
    /// Create new simplified P2P network with load balancing and Kademlia DHT
    pub fn new(
        node_id: String,
        node_type: NodeType,
        region: Region,
        port: u16,
    ) -> Self {
        Self::new_with_storage(node_id, node_type, region, port, None)
    }
    
    /// Create P2P with storage reference for scalable heartbeat persistence
    pub fn new_with_storage(
        node_id: String,
        node_type: NodeType,
        region: Region,
        port: u16,
        storage: Option<Arc<crate::storage::Storage>>,
    ) -> Self {
        let backup_regions = Self::get_backup_regions(&region);
        
        // SHARDING: Calculate shard ID from node_id hash
        let mut hasher = Sha3_256::new();
        hasher.update(node_id.as_bytes());
        let hash = hasher.finalize();
        let shard_id = hash[0]; // First byte = shard (0-255)
        
        // CRITICAL: Determine our external IP immediately for Genesis nodes
        let external_ip = if node_id.starts_with("genesis_node_") {
            // Genesis nodes have known IPs
            let genesis_id = node_id.strip_prefix("genesis_node_").unwrap_or("");
            crate::genesis_constants::get_genesis_ip_by_id(genesis_id)
                .map(|ip| Some(ip.to_string()))
                .unwrap_or(None)
        } else {
            None // Will be detected later for non-Genesis nodes
        };
        
        Self {
            node_id: node_id.clone(),
            node_type: node_type.clone(),
            region: region.clone(),
            port,
            external_ip: Arc::new(RwLock::new(external_ip)),
            self_ref: Arc::new(RwLock::new(std::sync::Weak::new())),
            regional_peers: Arc::new(Mutex::new(HashMap::new())),
            
            // QUANTUM OPTIMIZATION: Initialize lock-free structures
            connected_peers_lockfree: Arc::new(DashMap::new()),
            peer_id_to_addr: Arc::new(DashMap::new()),
            peer_shards: Arc::new(DashMap::new()),
            shard_id,
            regional_metrics: Arc::new(Mutex::new(HashMap::new())),
            lb_config: LoadBalancingConfig::default(),
            
            // SECURITY: Initialize rate limiting and nonce validation
            // PRODUCTION: DashMap for lock-free access at scale
            rate_limiter: Arc::new(DashMap::new()),
            nonce_validator: Arc::new(DashMap::new()),
            
            primary_region: region,
            backup_regions,
            last_health_check: Arc::new(Mutex::new(Instant::now())),
            last_rebalance: Arc::new(Mutex::new(Instant::now())),
            connection_count: Arc::new(Mutex::new(0)),
            total_bytes_sent: Arc::new(Mutex::new(0)),
            total_bytes_received: Arc::new(Mutex::new(0)),
            is_running: Arc::new(Mutex::new(false)),
            previous_leader: Arc::new(Mutex::new(None)),
            block_tx: Arc::new(Mutex::new(None)),
            sync_request_tx: None,
            shred_protocol_assemblies: Arc::new(DashMap::new()),
            processed_shred_blocks: Arc::new(DashSet::new()),
            shred_chunk_cache: Arc::new(DashMap::new()),
            certificate_manager: Arc::new(RwLock::new(CertificateManager::with_node_type(node_type.clone()))),
            
            // PRODUCTION: Light Node registry for gossip sync
            light_node_registry: Arc::new(RwLock::new(HashMap::new())),
            light_ping_slot_cache: Arc::new(RwLock::new((u64::MAX, 0, Vec::new()))),

            // PRODUCTION: Heartbeat history for reward eligibility
            storage: storage, // v2.76: Storage for persistent heartbeat storage
            
            // PRODUCTION: Light Node attestations for sharded ping system
            light_node_attestations: Arc::new(RwLock::new(HashMap::new())),
            epoch_light_eligible: Arc::new(RwLock::new(HashMap::new())),
            
            // PRODUCTION v2.51: Lock-free active nodes map for pinger selection
            active_full_super_nodes: Arc::new(DashMap::new()),
            
            // PRODUCTION: Macroblock sync channels (v2.19.12)
            macroblock_sync_request_tx: None,
            macroblock_tx: Arc::new(Mutex::new(None)),
            
            // PRODUCTION v2.19.21: QUIC transport (initialized later via init_quic)
            quic_transport: None,
            quic_enabled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            
            // PRODUCTION v2.19.22: QUIC message channel (set via set_quic_message_channel)
            quic_message_tx: Arc::new(Mutex::new(None)),
            quic_bulk_tx: Arc::new(Mutex::new(None)),
            quic_finality_tx: Arc::new(Mutex::new(None)),

            // PRODUCTION v2.19.25: Transaction channel (set via set_transaction_channel)
            transaction_tx: Arc::new(Mutex::new(None)),
            
            // GULF STREAM v2.25: Current producer for TX forwarding
            current_producer_info: Arc::new(RwLock::new(None)),
            
            // ANTI-STORM v2.25: Prevent gossip amplification
            seen_tx_hashes: Arc::new(DashSet::new()),
            seen_announcements: Arc::new(DashSet::new()),
            
            // v2.50.0: Pool 2 & Pool 3 accumulators for deterministic rewards
            pool2_accumulated_fees: Arc::new(AtomicU64::new(0)),
            pool3_accumulated_activations: Arc::new(AtomicU64::new(0)),

            // v5.0: Wallet identity for ML-DSA-65 HealthPing signing
            wallet_identity: Arc::new(parking_lot::RwLock::new(None)),
            
            // v5.1: Full Kademlia DHT routing table
            kademlia_table: Arc::new(KademliaRoutingTable::new(&node_id)),
        }
    }

    /// PRODUCTION: Set block processing channel for storage integration
    pub fn set_block_channel(&mut self, block_tx: tokio::sync::mpsc::Sender<ReceivedBlock>) {
        let mut guard = self.block_tx.lock();
        *guard = Some(block_tx);
        if crate::node::is_info() { println!("[INFO][P2P] Block processing channel established"); }
    }
    
    /// PRODUCTION: Set macroblock processing channel for storage integration (v2.19.12)
    pub fn set_macroblock_channel(&mut self, macroblock_tx: tokio::sync::mpsc::Sender<ReceivedBlock>) {
        let mut guard = self.macroblock_tx.lock();
        *guard = Some(macroblock_tx);
        if crate::node::is_info() { println!("[INFO][P2P] Macroblock processing channel established"); }
    }
    
    /// PRODUCTION v2.19.25: Set transaction processing channel for mempool integration
    /// Enables full transaction propagation across the network
    pub fn set_transaction_channel(&mut self, tx_channel: tokio::sync::mpsc::Sender<ReceivedTransaction>) {
        let mut guard = self.transaction_tx.lock();
        *guard = Some(tx_channel);
        if crate::node::is_info() { println!("[INFO][P2P] Transaction processing channel established"); }
    }
    
    /// GULF STREAM v2.25: Set current block producer for TX forwarding
    /// Called by node.rs after each block to update producer info
    /// TX will be forwarded directly to producer for minimal latency
    pub fn set_current_producer(&self, producer_id: &str, producer_addr: &str) {
        *self.current_producer_info.write() = Some((producer_id.to_string(), producer_addr.to_string()));
    }
    
    /// GULF STREAM v2.25: Get current producer info for TX forwarding
    pub fn get_current_producer(&self) -> Option<(String, String)> {
        self.current_producer_info.read().clone()
    }
    
    /// GULF STREAM v2.25: Get producer address by node_id from connected peers
    /// Used to resolve producer address when only node_id is known
    pub fn get_peer_addr_by_id(&self, node_id: &str) -> Option<String> {
        // First check dual index (O(1))
        if let Some(addr) = self.peer_id_to_addr.get(node_id) {
            return Some(addr.value().clone());
        }
        
        // v2.51: Fallback to linear search in lock-free map
        for entry in self.connected_peers_lockfree.iter() {
            if entry.value().id == node_id {
                return Some(entry.key().clone());
            }
        }
        
        None
    }
    
    /// PRODUCTION: Set macroblock sync request channel (v2.19.12)
    pub fn set_macroblock_sync_channel(&mut self, sync_tx: tokio::sync::mpsc::Sender<(u64, u64, String, String)>) {
        self.macroblock_sync_request_tx = Some(sync_tx);
        if crate::node::is_info() { println!("[INFO][P2P] Macroblock sync request channel established"); }
    }
    
    /// Set sync request channel for handling block requests
    /// v5.6: Extended with from_peer address for routing responses to unregistered peers
    pub fn set_sync_request_channel(&mut self, sync_request_tx: tokio::sync::mpsc::Sender<(u64, u64, String, String)>) {
        self.sync_request_tx = Some(sync_request_tx);
    }
    
    /// PRODUCTION v2.19.22: Set QUIC message channel for full message processing
    /// All QUIC messages are routed through this channel to handle_message()
    /// True if the peer registry holds a PROMOTED peer at this `ip:port` address.
    /// Used by the QUIC transport to recycle connections that never promoted.
    pub fn has_connected_peer_addr(&self, addr: &str) -> bool {
        self.connected_peers_lockfree.contains_key(addr)
    }

    pub fn set_quic_message_channel(&mut self, quic_message_tx: tokio::sync::mpsc::Sender<(String, NetworkMessage)>) {
        let mut guard = self.quic_message_tx.lock();
        *guard = Some(quic_message_tx);
        if crate::node::is_info() { println!("[INFO][QUIC] Message processing channel established"); }
    }

    /// QoS bulk lane sender (sync-serving / bulk transfer). Separate from the
    /// consensus lane so a cold-sync request flood cannot delay consensus.
    pub fn set_quic_bulk_channel(&mut self, quic_bulk_tx: tokio::sync::mpsc::Sender<(String, NetworkMessage)>) {
        let mut guard = self.quic_bulk_tx.lock();
        *guard = Some(quic_bulk_tx);
        if crate::node::is_info() { println!("[INFO][QUIC] Bulk lane channel established"); }
    }

    /// QoS finality lane sender: reserved for non-redundant 2f+1 msgs so a gossip flood
    /// cannot drop them (root-cause fix for the checkpoint-QC wedge).
    pub fn set_quic_finality_channel(&mut self, quic_finality_tx: tokio::sync::mpsc::Sender<(String, NetworkMessage)>) {
        let mut guard = self.quic_finality_tx.lock();
        *guard = Some(quic_finality_tx);
        if crate::node::is_info() { println!("[INFO][QUIC] Finality lane channel established"); }
    }

    /// True for floodable bulk-serving / bulk-transfer messages that must NOT
    /// share the consensus FIFO. Shred chunks and chunk repair are here too:
    /// their handlers move megabytes, and inline on the priority drain they
    /// queued consensus frames behind block-data floods. Everything else
    /// (consensus, tx forward, discovery) stays on the high-priority lane.
    #[inline]
    fn is_bulk_lane_message(msg: &NetworkMessage) -> bool {
        matches!(msg,
            NetworkMessage::RequestBlocks { .. }
            | NetworkMessage::RequestMacroblocks { .. }
            | NetworkMessage::BlocksBatch { .. }
            | NetworkMessage::MacroblocksBatch { .. }
            | NetworkMessage::StateSnapshot { .. }
            | NetworkMessage::ShredProtocolChunk { .. }
            | NetworkMessage::RequestMissingChunks { .. }
            | NetworkMessage::MissingChunksResponse { .. }
        )
    }

    /// Reserved lane for non-redundant 2f+1 msgs with no repair path: checkpoint-BFT
    /// (ConsensusV2 = Proposal/Vote/Qc/Timeout/Tc), failover pacemaker (TimeoutVote/
    /// TimeoutCertificateBroadcast), round-change handshake (ProducerReady/ReadyAck),
    /// and the checkpoint catch-up pair (RequestConsensusState/ConsensusState) — it is
    /// bounded (server rate-limit 5/min/peer, responses solicited-only) and it is the
    /// repair that must land exactly when a finality stall saturates the gossip FIFO.
    /// MUST NOT share the gossip FIFO; excludes high-volume gossip and bulk pull-repair.
    #[inline]
    fn is_finality_lane_message(msg: &NetworkMessage) -> bool {
        matches!(msg,
            NetworkMessage::ConsensusV2 { .. }
            | NetworkMessage::TimeoutVote { .. }
            | NetworkMessage::TimeoutCertificateBroadcast { .. }
            | NetworkMessage::ProducerReady { .. }
            | NetworkMessage::ReadyAck { .. }
            | NetworkMessage::RequestConsensusState { .. }
            | NetworkMessage::ConsensusState { .. }
        )
    }


    /// Start simplified P2P network with load balancing
    pub fn start(self: &Arc<Self>) {
        if crate::node::is_info() { println!("[INFO][P2P] Starting P2P network with intelligent load balancing"); }

        // Publish the self-handle FIRST: every background task spawned below admits peers through it.
        *self.self_ref.write() = Arc::downgrade(self);

        // CRITICAL: Load jail statuses from persistent storage FIRST
        // This ensures banned nodes stay banned across restarts
        self.load_jail_statuses_on_startup();

        // Rehydrate node_id -> endpoint IP before any peer is admitted: the IP-identity gates
        // consult it, and an empty map means "unbound, allow" for every claimed Super identity.
        self.restore_node_endpoints();

        // PRIVACY: Use pseudonym even in startup logs
        let display_id = if self.node_id.starts_with("genesis_node_") || self.node_id.starts_with("node_") || self.node_id.starts_with("super_") {
            self.node_id.clone()
        } else {
            get_privacy_id_for_addr(&self.node_id)
        };
        
        if crate::node::is_info() { println!("[INFO][P2P] Node: {} | Type: {:?} | Region: {:?}",
                 display_id, self.node_type, self.region); }
        
        let block_tx_guard = self.block_tx.lock();
        match &*block_tx_guard {
            Some(_) => println!("[INFO][P2P] Block channel: AVAILABLE"),
            None => println!("[ERR][P2P] Block channel: MISSING - blocks will be discarded!"),
        }
        
        // SECURITY: Safe mutex locking
        *self.is_running.lock() = true;
        
        // Start load balancing health monitor
        self.start_load_balancing_monitor();
        
        // Start regional rebalancing
        self.start_regional_rebalancer();
        
        // P2P FIX: Start peer exchange protocol for network discovery
        // SCALABILITY: Light nodes should have less aggressive exchange to save bandwidth (v2.51: lock-free)
        let initial_peers: Vec<PeerInfo> = self.connected_peers_lockfree.iter()
            .map(|entry| entry.value().clone())
            .collect();
        
        if !initial_peers.is_empty() {
            // SCALABILITY: Only start exchange for nodes that need it
            match self.node_type {
                NodeType::Light => {
                    // Light nodes don't need aggressive peer exchange
                    if crate::node::is_info() { println!("[INFO][P2P] Light node: Minimal peer exchange (bandwidth optimization)"); }
                }
                _ => {
                    self.start_peer_exchange_protocol(initial_peers);
                    // v3.18: Full nodes removed
                    if crate::node::is_info() { println!("[INFO][P2P] Started peer exchange protocol for Super node"); }
                }
            }
        }
        
        // IMPROVED: Try to setup UPnP port forwarding for NAT traversal
        // SKIP in Docker - ports are already forwarded via -p flag
        let is_docker = std::env::var("DOCKER_ENV").is_ok() 
            || std::path::Path::new("/.dockerenv").exists();
        
        if is_docker {
            if crate::node::is_info() { println!("[INFO][P2P] Docker detected - skipping UPnP (ports forwarded via -p)"); }
        } else if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let port = self.port;
            let _node_id = self.node_id.clone();
            handle.spawn(async move {
                if let Err(e) = Self::setup_upnp_port_forwarding(port).await {
                    if crate::node::is_warn() { println!("[WARN][P2P] UPnP setup failed: {}", e); }
                }
            });
        }
        
        // QUANTUM OPTIMIZATION: Start performance monitor
        self.start_performance_optimizer();
        
        if crate::node::is_info() { println!("[INFO][P2P] P2P network with load balancing started"); }
    }
    
    /// QUANTUM OPTIMIZATION: Monitor and adapt to network growth
    /// v2.51: Simplified performance optimizer (fully lock-free)
    fn start_performance_optimizer(&self) {
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };

        let peers_clone = self.connected_peers_lockfree.clone();

        handle.spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(300)).await;

                let peer_count = peers_clone.len();
                let shard_status = if peer_count >= 10000 { "ACTIVE" }
                    else if peer_count >= 5000 { "READY" }
                    else { "STANDBY" };

                if crate::node::is_info() {
                    println!("[INFO][P2P] stats peers={} mode=lock-free sharding={}",
                            peer_count, shard_status);
                }
            }
        });
    }
    
    /// Try to setup UPnP port forwarding for NAT traversal
    async fn setup_upnp_port_forwarding(port: u16) -> Result<(), String> {
        use std::process::Command;
        
        if crate::node::is_info() { println!("[INFO][P2P] Attempting UPnP port forwarding for port {}", port); }
        
        // Check if upnpc is available (miniupnpc package)
        if let Ok(output) = Command::new("which").arg("upnpc").output() {
            if output.status.success() {
                // Try to add port mapping
                let result = Command::new("upnpc")
                    .args(&[
                        "-e", "QNet P2P Node",
                        "-r", &format!("{} TCP", port),
                    ])
                    .output();
                    
                if let Ok(output) = result {
                    if output.status.success() {
                        if crate::node::is_info() { println!("[INFO][P2P] UPnP port forwarding successful for port {}", port); }
                        return Ok(());
                    }
                }
            }
        }
        
        // Try Windows UPnP if available
        #[cfg(target_os = "windows")]
        {
            if let Ok(output) = Command::new("netsh")
                .args(&["interface", "portproxy", "add", "v4tov4",
                       &format!("listenport={}", port),
                       &format!("connectport={}", port),
                       "connectaddress=127.0.0.1"])
                .output() {
                if output.status.success() {
                    if crate::node::is_info() { println!("[INFO][P2P] Windows port forwarding configured"); }
                    return Ok(());
                }
            }
        }
        
        if crate::node::is_warn() { println!("[WARN][P2P] UPnP not available, manual port forwarding may be required"); }
        if crate::node::is_info() { println!("[INFO][P2P] For Docker: Use -p {}:{} or DOCKER_HOST_IP env var", port, port); }
        Err("UPnP not available".to_string())
    }
    
}

// NOTE: base64_bytes modules REMOVED in v2.26
// bincode natively handles Vec<u8> as [u64_len][raw_bytes] - no base64 overhead needed!
// This improves performance by ~33% for block/transaction serialization

/// Push notification type for Light nodes
/// Supports multiple providers for F-Droid compatibility
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PushType {
    FCM,           // Firebase Cloud Messaging (Google Play)
    UnifiedPush,   // Open standard (F-Droid, ntfy, Gotify)
    Polling,       // Fallback - device polls for challenges
}

impl Default for PushType {
    fn default() -> Self {
        PushType::FCM
    }
}

/// PRODUCTION: Light Node registration data for gossip sync
/// Compact struct for efficient batch transfers between Super nodes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LightNodeRegistrationData {
    pub node_id: String,              // Privacy-preserving pseudonym
    pub wallet_address: String,       // Owner wallet for rewards
    pub device_token_hash: String,    // Hashed FCM token (for FCM) or empty
    pub quantum_pubkey: String,       // ML-DSA-65 (ML-DSA-65) public key
    pub registered_at: u64,           // Registration timestamp
    pub signature: String,            // ML-DSA-65 quantum signature over wallet_address
    #[serde(default)]
    pub push_type: PushType,          // FCM | UnifiedPush | Polling
    #[serde(default)]
    pub unified_push_endpoint: Option<String>,  // UnifiedPush URL (e.g., https://ntfy.sh/xxx)
    #[serde(default)]
    pub last_seen: u64,               // Last successful ping response timestamp
    #[serde(default)]
    pub consecutive_failures: u8,     // Failed pings in a row (max 255)
    #[serde(default = "default_true")]
    pub is_active: bool,              // Node is active and should be pinged
    // PING DELEGATION v7.1: Dedicated ML-DSA-65 ping key for background pings.
    // Allows device to sign ping responses without unlocking the wallet.
    // ping_pubkey is authorized by wallet Dilithium at registration via delegation_cert.
    // Full quantum safety: both delegation cert AND ping signature use ML-DSA-65.
    #[serde(default)]
    pub ping_pubkey: String,          // ML-DSA-65 pubkey (3904 hex) or legacy Ed25519 (64 hex)
    #[serde(default)]
    pub ping_delegation_cert: String, // Dilithium sign of "delegate_ping:{ping_pubkey}:{node_id}"
}

fn default_true() -> bool { true }

/// PRODUCTION: Light Node Attestation - proof that Light node responded to ping
/// Created by pinger after receiving signed response from Light node
/// ARCHITECTURE v2.78: Both signatures use PQ compact_bin format
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LightNodeAttestation {
    pub light_node_id: String,        // Light node that was pinged
    pub pinger_id: String,            // Super node that pinged
    pub slot: u64,                    // Time slot (4h window / 240 = 1 min slots)
    pub timestamp: u64,               // When attestation was created
    pub light_node_signature: String, // PQ compact_bin (ML-DSA-65, ~2.6KB)
    pub pinger_signature: String,     // PQ compact_bin (ML-DSA-65, ~2.6KB)
    pub challenge: String,            // Original challenge (for verification)
    pub block_height: u64,            // v2.59: Block height for epoch-based filtering
}

/// Pinger role for Light node ping responsibility
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PingerRole {
    Primary,   // Ping immediately
    Backup1,   // Wait 30 seconds, then ping if no attestation
    Backup2,   // Wait 60 seconds, then ping if no attestation
    None,      // Not responsible for this Light node
}

/// Message types for simplified network
/// ARCHITECTURE v2.26: Pure bincode serialization for maximum performance
/// bincode natively handles Vec<u8> as [u64_len][raw_bytes] - no base64 needed!
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetworkMessage {
    /// Block data (microblock or macroblock)
    /// OPTIMIZED: Direct binary serialization via bincode (no base64 overhead)
    Block {
        height: u64,
        data: Vec<u8>,  // bincode handles Vec<u8> natively
        block_type: String,  // "micro" or "macro"
    },

    /// Consensus v2 (Checkpoint-BFT): bincode of consensus_v2_driver::ConsensusMsg.
    /// Gated by QNET_CONSENSUS_V2; routed to the v2 runtime, ignored when off.
    ConsensusV2 {
        data: Vec<u8>,
    },

    /// Transaction data
    /// OPTIMIZED: Direct binary serialization via bincode
    Transaction {
        data: Vec<u8>,  // bincode handles Vec<u8> natively
    },
    
    /// PRODUCTION v2.25: Transaction batch for high-throughput TX propagation
    /// Sends multiple TXs in single message - reduces QUIC stream overhead
    /// Each TX in batch is still individually validated and added to mempool
    TransactionBatch {
        /// Batch of serialized transactions - bincode handles Vec<Vec<u8>> natively
        transactions: Vec<Vec<u8>>,
        /// Batch timestamp for ordering
        timestamp: u64,
    },
    
    /// Peer discovery
    PeerDiscovery {
        requesting_node: PeerInfo,
    },
    
    /// v5.0: ML-DSA-65-signed health ping with block height
    /// Signature covers "QNET_HEALTH_PING_V1:{from}:{timestamp}:{height}"
    /// Receivers verify signature before trusting height — prevents spoofing
    HealthPing {
        from: String,
        timestamp: u64,
        #[serde(default)]
        height: u64,
        /// UNSIGNED SyncInfo claim: sender's highest-TC window + round. Ambient TC-repair channel
        /// outside stall periods (the one-shot TC broadcast can be missed). Receiver: monotonic
        /// compare → cooldown-gated pull of the self-authenticating TC — claims never mutate state,
        /// so signing them would add nothing.
        #[serde(default)]
        cert_mb: u64,
        #[serde(default)]
        cert_round: u64,
        /// ML-DSA-65 detached signature (hex), empty = unsigned. The verifying key is NEVER carried
        /// here — it is resolved from CONSENSUS_PK_REGISTRY by `from`, so a wire key would be both
        /// 3904 hex chars of dead weight per ping and an identity-squat invitation.
        #[serde(default)]
        signature: String,
    },

    /// v16.2: OBSERVER-BASED BLOCK REJECTION — supermajority fork detection.
    ///
    /// The legacy v16.1 fork detector counted DISTINCT PEER SOURCES that sent
    /// a forked block at a given height. With ≤f Byzantine producers
    /// (typically 1 in a 5-node committee) the source count tops out at 1,
    /// so the 2f+1 supermajority threshold for destructive rollback was
    /// mathematically unreachable — dead code that never fired in postmortem.
    ///
    /// The correct BFT model counts DISTINCT OBSERVERS (each honest node
    /// that locally rejected the same forked block). When 2f+1 observers
    /// independently reject the same `(height, source_peer_id)` tuple,
    /// destructive rollback is justified by the supermajority — exactly
    /// the property the BFT invariant promises.
    ///
    /// Protocol:
    ///   1. On `verify_failed` for a block from peer S at height H, the
    ///      detecting node broadcasts `BlockRejection{height=H, source=S,
    ///      rejected_hash, observer=self, expected_prev_hash, signature}`.
    ///   2. Receivers verify the observer's ML-DSA-65 signature against
    ///      the consensus PK registry and aggregate distinct observers
    ///      per `(height, source)` tuple.
    ///   3. When 2f+1 distinct observers report the same `(height, source)`,
    ///      the receiver raises `FORK_RECOVERY_HEIGHT = height - 1`. The
    ///      same destructive-rollback path used by macroblock fork recovery
    ///      then deletes the forked tip and resyncs from canonical peers.
    ///
    /// Safety: rollback fires only on cryptographic supermajority. A
    /// Byzantine source that splits the network cannot trigger rollback
    /// against an honest chain — the honest 2f+1 supermajority is on
    /// the canonical chain and reports rejections against the BYZANTINE
    /// source, not the canonical one.
    ///
    /// Scalability: bounded by committee size. At committee=1000, a fork
    /// event produces O(committee) rejection broadcasts and O(committee)
    /// signature verifications — same magnitude as a TimeoutVote round
    /// and well within existing bandwidth budgets. Triggered only on
    /// fork events (rare under healthy network conditions).
    BlockRejection {
        height: u64,
        source_peer_id: String,
        rejected_hash: [u8; 32],
        observer_id: String,
        expected_prev_hash: [u8; 32],
        /// ML-DSA-65 detached signature over
        /// "QNET_BLOCK_REJECTION_V1:{observer_id}:{height}:{source_peer_id}:{hex(rejected_hash)}:{hex(expected_prev_hash)}"
        signature: Vec<u8>,
    },

    /// v16.2: ROUND-CHANGE READY HANDSHAKE — eliminates rotation race window.
    ///
    /// The v15.x cold-boot postmortem at h=154 traced a fork to two
    /// producers concurrently emitting blocks at different rotation_rounds.
    /// Each had advanced its own `HIGHEST_CERTIFIED_ROUND` independently as
    /// peer gossip propagated at different rates — so each saw "I am the
    /// elected producer for this slot" simultaneously based on its OWN
    /// view of the round. Without an explicit per-round acknowledgement
    /// step, the only safety net was post-hoc hash-chain detection, which
    /// is too late to prevent the fork.
    ///
    /// The handshake closes that race:
    ///   1. After local certified_round advances to R > 0, the elected
    ///      producer broadcasts `ProducerReady{mb_idx, round=R, height}`
    ///      signed with ML-DSA-65.
    ///   2. Each committee member that ALSO has local certified_round ≥ R
    ///      replies with `ReadyAck{mb_idx, round=R, height}` signed.
    ///   3. The producer waits for 2f+1 distinct signed acks before
    ///      constructing the block at round R. This proves at least one
    ///      honest peer has already converged on the same round.
    ///
    /// Crucially this only fires when `round > 0` — the steady-state happy
    /// path (round = 0 producer wins immediately) has zero handshake
    /// overhead. At cold-boot rotation events the +1 round trip is the
    /// price of determinism. Industry parallel: HotStuff "new-view" message
    /// chain.
    ///
    /// Liveness: if 2f+1 acks do not arrive within the ack-wait timeout
    /// (configurable, default 800 ms), the producer simply yields the
    /// slot and the round advances to R+1 via the next same-round 2f+1
    /// timeout — same progress path as a missing block.
    ///
    /// Scalability: only the elected producer broadcasts at round-change
    /// events (rare). Per round-change network cost is O(committee) for
    /// the ready broadcast and O(committee) for acks — well within
    /// existing TimeoutVote bandwidth at any committee size up to 1000.
    ProducerReady {
        mb_idx: u64,
        round: u64,
        height: u64,
        producer_id: String,
        /// ML-DSA-65 detached signature over
        /// "QNET_PRODUCER_READY_V1:{producer_id}:{mb_idx}:{round}:{height}"
        signature: Vec<u8>,
    },

    /// v16.2: Acknowledgement of `ProducerReady`. Each honest committee
    /// member emits exactly one `ReadyAck` per (mb_idx, round, height,
    /// producer_id) tuple, signed with its own ML-DSA-65 key. The
    /// signature payload is the canonical ack string so receivers can
    /// verify without holding the original ProducerReady message.
    ReadyAck {
        mb_idx: u64,
        round: u64,
        height: u64,
        producer_id: String,
        ack_id: String,
        /// ML-DSA-65 detached signature over
        /// "QNET_READY_ACK_V1:{ack_id}:{producer_id}:{mb_idx}:{round}:{height}"
        signature: Vec<u8>,
    },

    /// v16.1: Network-broadcast producer heartbeat for remote silence detection.
    ///
    /// Forensic motivation: the legacy `PRODUCER_HEARTBEAT_MS` watchdog tracked
    /// the LOCAL producer task's loop iteration on this node — useless when
    /// the question is "is the remote round-0 producer (chosen by VRF) alive?"
    /// At v15.x h=781, node_001 was VRF-elected producer but dead from boot;
    /// other nodes' watchdogs only saw their own loop running fine and emitted
    /// `producer_silent` against THEMSELVES, never raising any actionable
    /// signal about node_001.
    ///
    /// Protocol:
    ///   * Whenever a node observes itself as the expected producer for the
    ///     next slot (via `select_microblock_producer_with_round`), it
    ///     broadcasts `ProducerHeartbeat` once per second to all validator
    ///     peers — independent of whether it is currently constructing a
    ///     block.
    ///   * Receivers store the latest `(producer_id, timestamp)` in
    ///     `REMOTE_PRODUCER_HEARTBEAT_MS`.
    ///   * Watchdog reads remote map: if the expected producer's last
    ///     heartbeat is older than the silent-threshold AND this node is in
    ///     the empty-slot attestation committee, broadcast an empty-slot
    ///     attestation immediately (don't wait for the producer-loop tick to
    ///     discover the silence).
    ///
    /// Safety:
    ///   * Heartbeat MUST be ML-DSA-65-signed by the producer; receivers
    ///     verify signature before updating the remote map.
    ///   * Timestamp covered by signature with monotonic per-producer
    ///     guard (later timestamp wins) — prevents replay of old heartbeats.
    ///   * Heartbeat does NOT advance any consensus state directly; it only
    ///     accelerates the entry condition for empty-slot attestation, which
    ///     remains guarded by 2f+1 supermajority.
    ///
    /// Scalability: at 1000 producers, only the elected one broadcasts per
    /// slot — that's 1 msg/sec network-wide. Receivers update an O(1)
    /// DashMap entry. Bandwidth is negligible (≈4 KB per heartbeat:
    /// 32-byte fields + ML-DSA-65 detached signature).
    ProducerHeartbeat {
        producer_id: String,
        timestamp: u64,
        /// Height the producer is targeting; receivers can correlate with
        /// their own tip to detect a stuck producer that broadcasts but
        /// hasn't caught up.
        slot_height: u64,
        /// Canonical hash at slot_height-1, ON THE WIRE and inside the signed preimage. A behind
        /// receiver verifies the signature over these exact bytes instead of reconstructing the
        /// anchor from its own chain (which failed for every honest node not yet holding the tip).
        anchor_hash: String,
        /// ML-DSA-65 detached signature over
        /// "QNET_PRODUCER_HEARTBEAT_V3:{producer_id}:{timestamp}:{slot_height}:{anchor_hash}".
        signature: Vec<u8>,
    },
    
    /// State snapshot announcement
    StateSnapshot {
        height: u64,
        ipfs_cid: String,
        sender_id: String,
    },
    
    /// BFT Timeout Vote v2 — certificate-anchored failover. Signed payload = timeout_vote_message
    /// (domain "QNET_TIMEOUT_V2"): (window, round, sealed anchor) + the voter's OWN high_qc/tip.
    /// cert_mb/cert_round are UNSIGNED SyncInfo claims (sender's highest certified round) — a behind
    /// receiver pulls the TC before tallying; claims never mutate state directly.
    TimeoutVote {
        height: u64,              // vote window (target_height / 90)
        timeout_round: u64,       // failover round within the window
        voter_id: String,
        anchor: Vec<u8>,          // 32B hash(macroblock window-2), zeros for window<3
        high_qc_idx: u64,         // voter's last sealed macroblock index
        high_qc_hash: Vec<u8>,    // 32B its hash (zeros if none)
        tip_height: u64,          // voter's verified tip (sync hint)
        tip_hash: Vec<u8>,        // 32B its hash (fetch-by-hash hint)
        signature: Vec<u8>,       // Dilithium over timeout_vote_message(...)
        cert_mb: u64,             // SyncInfo claim: window of sender's highest TC (0 = none)
        cert_round: u64,          // SyncInfo claim: its round
    },

    /// BFT Timeout Certificate — per-voter payloads (each signature verifies over ITS OWN fields),
    /// so mixed-finality votes aggregate into one TC that verifies on every node.
    TimeoutCertificateBroadcast {
        height: u64,
        timeout_round: u64,
        anchor: Vec<u8>,          // 32B deterministic sealed anchor (verifier re-derives + compares)
        votes: Vec<SignedTimeoutVote>,
    },

    // `TimeoutAggregateCertificate` (cross-round pacemaker cert) REMOVED: it
    // advanced the leader round from votes SPREAD across rounds, not a same-round
    // 2f+1, making rotation path-dependent → different leaders per node → dual
    // production + fork (h=154). Leader round now advances ONLY on a same-round
    // 2f+1 `TimeoutCertificateBroadcast`.

    /// Request timeout certificates for sync (new/reconnecting nodes)
    RequestTimeoutCertificates {
        from_height: u64,
        to_height: u64,
        requester_id: String,
    },

    /// Response with timeout certificates (full per-voter-payload proofs).
    TimeoutCertificatesResponse {
        certificates: Vec<TimeoutProof>,
        sender_id: String,
    },

    // v14.7.2: per-microblock BlockCommitVote / BlockCommitCertificate
    // message variants REMOVED. Microblock BFT safety is delivered by the
    // per-block vote streams duplicated that layer and created a rate-limit
    // collision that starved the real consensus.

    /// v4.3: VRF Leader Claim — slot proof with gossip relay. The schedule is a public
    /// deterministic hash of on-chain inputs; the claim only proves who holds the slot.
    /// Each elected node broadcasts its VRF proof at rotation boundary
    /// All nodes verify, store, and RELAY to peers (TTL-limited gossip)
    /// vrf_public_key included so claims are self-verifiable without prior key exchange
    /// gossip_ttl: decremented on each relay hop; 0 = do not relay further
    VrfLeaderClaim {
        round: u64,              // Leadership round (= rotation period)
        node_id: String,         // Claiming node
        vrf_output: Vec<u8>,     // 32-byte VRF output
        vrf_proof: Vec<u8>,      // ~3309-byte ML-DSA-65 detached signature
        slot_seed: Vec<u8>,      // 32-byte slot seed (for verification)
        reputation: f64,         // Node's reputation at claim time
        timestamp: u64,          // Claim timestamp
        vrf_public_key: Vec<u8>, // 1952-byte ML-DSA-65 public key (self-verifiable claims)
        gossip_ttl: u8,          // Gossip relay hops remaining (0 = no further relay)
    },

    /// DEPRECATED v4.0: EmergencyProducerChange replaced by BFT Timeout Protocol
    /// ═══════════════════════════════════════════════════════════════════════════
    /// WHY REMOVED:
    /// 1. Non-deterministic: One node can trigger, others may disagree
    /// 2. Spam vector: Malicious node can flood network with false emergencies  
    /// 3. No consensus: Producer change without 2/3+ agreement causes forks
    /// 
    /// NEW ARCHITECTURE:
    /// - Failover uses BFT Timeout Protocol (2/3+ votes required)
    /// - Attacks handled via on-chain slashing in MacroBlock
    /// - Reputation computed from blockchain (deterministic_reputation.rs)
    /// ═══════════════════════════════════════════════════════════════════════════
    #[deprecated(since = "4.0.0", note = "Use BFT Timeout Protocol instead")]
    EmergencyProducerChange {
        failed_producer: String,
        new_producer: String,
        block_height: u64,
        change_type: String,
        timestamp: u64,
        #[serde(default)]
        sender_node_id: Option<String>,
    },
    
    /// ShredProtocol chunk for efficient block propagation
    ShredProtocolChunk {
        chunk: ShredProtocolChunk,
    },
    
    /// Request blocks for sync
    RequestBlocks {
        from_height: u64,
        to_height: u64,
        requester_id: String,
    },

    /// Response with batch of blocks
    BlocksBatch {
        blocks: Vec<(u64, Vec<u8>)>,  // (height, data) pairs
        from_height: u64,
        to_height: u64,
        sender_id: String,
    },
    
    /// Sync status query
    SyncStatus {
        current_height: u64,
        target_height: u64,
        syncing: bool,
        node_id: String,
    },
    
    /// Request macroblocks for sync (PRODUCTION: Full macroblock sync support)
    /// Macroblocks are requested by INDEX (not height): index 1 = blocks 1-90, index 2 = blocks 91-180
    RequestMacroblocks {
        from_index: u64,
        to_index: u64,
        requester_id: String,
    },
    
    /// Response with batch of macroblocks
    /// SCALABILITY: Limited to 10 macroblocks per batch (~1MB max)
    MacroblocksBatch {
        macroblocks: Vec<(u64, Vec<u8>)>,  // (index, data) pairs
        from_index: u64,
        to_index: u64,
        sender_id: String,
    },
    
    /// v2.95: QUIC-based peer list exchange (replaces HTTP GET /api/v1/peers)
    /// Enables peer discovery when TCP ports are blocked by firewalls
    PeerListRequest {
        requester_id: String,
    },

    /// v2.95: Response with peer list via QUIC
    PeerListResponse {
        peers: Vec<(String, String, u64)>,  // (addr, node_id, height)
        sender_id: String,
    },

    /// Request consensus state for recovery
    RequestConsensusState {
        round: u64,
        requester_id: String,
    },
    
    /// Response with consensus state
    ConsensusState {
        round: u64,
        state_data: Vec<u8>,  // bincode handles Vec<u8> natively
        sender_id: String,
    },
    
    /// v3.16: Producer vote for Byzantine 66% consensus
    /// Sent at rotation boundaries to agree on producer selection
    ProducerVote {
        block_height: u64,
        voted_producer: String,
        voter_id: String,
        timeout_round: u64,  // Include timeout_round for deterministic verification
    },
    
    /// PRODUCTION: PQ certificate announcement for compact signatures
    CertificateAnnounce {
        node_id: String,
        cert_serial: String,
        certificate: Vec<u8>,  // Serialized PqCertificate - bincode handles natively
        timestamp: u64,
    },
    
    /// Request certificate by serial number
    CertificateRequest {
        requester_id: String,
        node_id: String,       // Owner of certificate  
        cert_serial: String,   // Serial number requested
        timestamp: u64,
    },
    
    /// Response with certificate
    CertificateResponse {
        node_id: String,
        cert_serial: String,
        certificate: Vec<u8>,  // Serialized PqCertificate - bincode handles natively
        timestamp: u64,
    },
    
    /// PRODUCTION: Light Node registration gossip for decentralized registry sync
    /// All Super nodes maintain synchronized Light Node registry via gossip
    /// Pure ML-DSA-65: ML-DSA-65 quantum signature authentication
    LightNodeRegistration {
        node_id: String,              // Privacy-preserving pseudonym (hash-based)
        wallet_address: String,       // Owner wallet for reward claims
        device_token_hash: String,    // Hashed FCM token for privacy
        quantum_pubkey: String,       // CRYSTALS-ML-DSA-65 (ML-DSA-65) public key
        registered_at: u64,           // Registration timestamp
        signature: String,            // ML-DSA-65 quantum signature over wallet_address
        gossip_hop: u8,               // Hop count for gossip TTL (max 3)
        #[serde(default)]
        push_type: PushType,          // FCM | UnifiedPush | Polling
        #[serde(default)]
        unified_push_endpoint: Option<String>,  // UnifiedPush URL
        #[serde(default)]
        last_seen: u64,               // Last successful ping response
        #[serde(default)]
        consecutive_failures: u8,     // Failed pings counter
        #[serde(default = "default_true")]
        is_active: bool,              // Node activity status
        // PING DELEGATION v7.1
        #[serde(default)]
        ping_pubkey: String,          // ML-DSA-65 ping pubkey (3904 hex) or legacy Ed25519 (64 hex)
        #[serde(default)]
        ping_delegation_cert: String, // Dilithium cert authorizing ping_pubkey
    },
    
    /// PRODUCTION: Request Light Node registry sync from peer
    LightNodeRegistryRequest {
        requester_id: String,
        last_sync_timestamp: u64,     // Only send registrations after this time
    },
    
    /// PRODUCTION: Response with Light Node registry batch
    LightNodeRegistryResponse {
        sender_id: String,
        registrations: Vec<LightNodeRegistrationData>,  // Batch of registrations
        total_count: u64,             // Total nodes in registry
    },
    
    /// PRODUCTION: Light Node attestation - proof that Light node responded to ping
    /// Gossiped after pinger receives signed response from Light node
    LightNodeAttestation {
        light_node_id: String,        // Light node that was pinged
        pinger_id: String,            // Super node that pinged
        slot: u64,                    // Time slot for deduplication
        timestamp: u64,               // When attestation was created
        light_node_signature: String, // Light node's signature on challenge
        pinger_signature: String,     // Pinger's signature on attestation
        challenge: String,            // Original challenge
        gossip_hop: u8,               // Hop count for gossip TTL (max 3)
        block_height: u64,            // v2.59: Block height for epoch-based filtering
    },
    
    /// PRODUCTION: Active Super node announcement for pinger selection sync
    /// Gossiped when node starts and periodically (every 10 min) to maintain active list
    ActiveNodeAnnouncement {
        node_id: String,              // Node identifier
        node_type: String,            // "super" (v3.18: Full removed)
        shard_id: u8,                 // Node's shard (0-255)
        reputation: f64,              // Current reputation score
        timestamp: u64,               // Announcement timestamp
        signature: String,            // Dilithium signature for authenticity
        gossip_hop: u8,               // Hop count for gossip TTL (max 3)
    },
    
    /// PRODUCTION: Request active nodes list from peer (on startup/reconnect)
    ActiveNodesRequest {
        requester_id: String,
    },
    
    /// PRODUCTION: Response with active Super nodes list
    ActiveNodesResponse {
        sender_id: String,
        active_nodes: Vec<ActiveNodeInfo>,  // List of active nodes
    },
    
    /// PRODUCTION: System event broadcast (reorg, emergency, etc.)
    SystemEvent {
        event_type: String,   // "chain_reorg", "emergency_shutdown", etc.
        data: String,         // JSON-encoded event data
        timestamp: u64,
        from_node: String,
    },
    
    /// PRODUCTION v2.21.3: Request missing ShredProtocol chunks for block recovery
    /// This enables efficient retransmit of individual chunks instead of full blocks
    /// 
    /// ARCHITECTURE:
    /// 1. Node detects missing chunks after SHRED_CHUNK_TIMEOUT (3 seconds)
    /// 2. Node sends RequestMissingChunks to peers that sent other chunks for this block
    /// 3. Peers respond with MissingChunksResponse containing cached chunks
    /// 4. Node can reconstruct block with fewer total chunk downloads
    ///
    /// BENEFITS vs RequestBlocks:
    /// - Bandwidth: Request 1KB chunks vs 12KB blocks
    /// - Latency: Faster recovery, no full block download
    /// - Scalability: Less network load for high-throughput scenarios
    RequestMissingChunks {
        block_height: u64,
        missing_indices: Vec<usize>,  // Which chunk indices are missing
        requester_id: String,
        timestamp: u64,
    },
    
    /// PRODUCTION v2.21.3: Response with requested chunks
    MissingChunksResponse {
        block_height: u64,
        chunks: Vec<(usize, Vec<u8>, bool)>,  // (index, data, is_parity)
        original_block_size: usize,
        is_macroblock: bool,
        sender_id: String,
        // Identity of the served set: which block these bytes belong to and which
        // Reed-Solomon coding count produced the parity rows. The receiver rejects a
        // response that contradicts its assembly instead of merging foreign bytes.
        block_hash: Option<[u8; 32]>,
        num_coding: usize,
    },
    
    /// PRODUCTION v2.37: Dedicated MacroBlock broadcast (NOT via ShredProtocol!)
    /// ═══════════════════════════════════════════════════════════════════════════
    /// WHY SEPARATE CHANNEL:
    /// - ShredProtocol uses block height as dedup key
    /// - MacroBlock #1 and Microblock #1 both have height=1 → collision!
    /// - Separate broadcast ensures 100% MacroBlock delivery
    /// - Dedicated channel avoids collision with microblocks
    /// ═══════════════════════════════════════════════════════════════════════════
    MacroBlockBroadcast {
        index: u64,           // MacroBlock index (epoch number)
        data: Vec<u8>,        // Compressed macroblock data (zstd)
        sender_id: String,    // Leader who created macroblock
        epoch: u64,           // Epoch number (same as index)
    },

    /// v5.1: Kademlia FIND_NODE — iterative peer lookup by target hash
    /// Receiver returns K closest peers from its routing table
    FindNode {
        requester_id: String,
        target_hash: Vec<u8>,     // 32-byte SHA3-256 hash of target node ID
        request_id: u64,          // Correlate request/response
    },

    /// v5.1: Kademlia FIND_NODE response
    FindNodeResponse {
        responder_id: String,
        closest_peers: Vec<(String, String)>, // (node_id, addr) pairs
        request_id: u64,
    },

    /// v3.33: Block Attestation — validator confirms block validity after receiving it.
    /// Attestation = Dilithium signature over (block_height || block_hash).
    /// Blocks with 2/3+ attestations have higher fork-choice weight.
    /// Scalability: only qualified producers attest (~20 VRF winners + ~100 entropy sample).
    BlockAttestationMsg {
        block_height: u64,
        block_hash: Vec<u8>,       // 32-byte SHA3 hash of microblock
        attester_id: String,       // Node that verified and attests
        signature: Vec<u8>,        // ML-DSA-65 signature over "QNET_ATTEST:{height}:{hash}"
        timestamp: u64,
    },

    /// Empty-slot attestation — committee member declares that the producer
    /// for `slot_height` failed to broadcast a valid block within the slot
    /// grace period, and the network should advance to the next producer
    /// in rotation. Once 2f+1 distinct attestations accumulate for the
    /// same (slot_height, expected_producer), failover is deterministic.
    /// Replaces reactive timeout_round for microblock-level rotation.
    /// Empty-slot attestation — committee member declares that the producer
    /// for `slot_height` failed to broadcast a valid block within the slot
    /// grace period, and the network should advance to the next producer
    /// in rotation. Once 2f+1 distinct attestations accumulate for the
    /// same (slot_height, expected_producer), failover is deterministic.
    /// Replaces reactive timeout_round for microblock-level rotation.
    EmptySlotAttestationMsg {
        slot_height: u64,
        expected_producer: String,
        attester_id: String,
        signature: Vec<u8>,        // ML-DSA-65 over "QNET_EMPTY_SLOT:{slot_height}:{expected_producer}"
        timestamp: u64,
    },

    /// v4.6: VRF Public Key Announcement — exchange ML-DSA-65 VRF keys between nodes.
    /// Broadcast on startup and at every macroblock boundary.
    /// Receiver verifies self-signature (proves ownership of secret key).
    /// Without this, block/attestation signature verification fails (no_pk_registered).
    VrfKeyAnnounce {
        node_id: String,
        vrf_public_key: Vec<u8>,   // 1952-byte ML-DSA-65 public key
        self_signature: Vec<u8>,   // ML-DSA-65 detached signature over "QNET_VRF_KEY_v1:{node_id}"
        timestamp: u64,
    },

    // NOTE: bincode serializes enum variants by POSITIONAL index — APPEND new variants at the
    // tail only; inserting mid-enum shifts every later index and breaks wire compat with deployed
    // binaries.
    /// Control-lane fetch of ONE self-contained QC-bound macroblock by index (snapshot binding /
    /// anchor verify). Deliberately NOT in is_bulk_lane_message → stays on the high-priority lane
    /// and gets the reserved control-lane serve quota that a bulk cold-sync flood cannot consume.
    RequestMacroblockAnchor {
        index: u64,
        requester_id: String,
    },

    /// Response carrying a single QC-bound macroblock for RequestMacroblockAnchor.
    MacroblockAnchor {
        index: u64,
        data: Vec<u8>,
        sender_id: String,
    },

    /// GALC: one genesis node's partial signature over a checkpoint (mb_index, mb_hash,
    /// committee_digest). Aggregated to >=2f+1 → a self-authenticating capsule. Control-lane.
    GenesisCheckpointSig {
        version: u16,
        network_id: [u8; 32],
        mb_index: u64,
        mb_hash: [u8; 32],
        committee_digest_anchor: [u8; 32],
        committee_digest_pred: [u8; 32],
        minted_at_height: u64,
        genesis_id: String,
        sig: String,
    },

    /// GALC: a complete >=2f+1-signed capsule (bincode of galc::GenesisCheckpoint). Relayed by any super.
    GenesisCheckpoint {
        data: Vec<u8>,
    },

    /// GALC: cold-joiner request for the latest held capsule. Control-lane.
    RequestGenesisCheckpoint {
        requester_id: String,
    },

    /// Coordinated-recovery decree: "recover from target_height", valid only under a quorum of
    /// genesis consensus signatures over the chain-bound payload. Replay-floored by seq.
    RecoveryDecree {
        seq: u64,
        target_height: u64,
        sigs: Vec<(String, Vec<u8>)>,
    },
}

/// PRODUCTION: Active node info for gossip sync
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveNodeInfo {
    pub node_id: String,
    pub node_type: String,          // "super" (v3.18: Full removed)
    pub shard_id: u8,
    pub reputation: f64,
    pub last_seen: u64,             // Last heartbeat/announcement timestamp
    /// v9.3: Last known block height (from heartbeat/announcement).
    /// Used to exclude syncing nodes from consensus and choose correct sync peers.
    #[serde(default)]
    pub block_height: u64,
}


/// BFT Timeout Proof — n-f signed votes over one (window, round, anchor); the votes ARE the proof.
/// anchor is the deterministic sealed anchor for the window (re-derived by every verifier), NOT any
/// voter's local tip — so validity is independent of the voters' finality skew.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TimeoutProof {
    pub height: u64,              // vote window (target_height / 90)
    pub timeout_round: u64,
    pub anchor: [u8; 32],         // hash(macroblock window-2), zeros for window<3
    pub votes: Vec<SignedTimeoutVote>,
}

/// One vote inside a TC: signature over timeout_vote_message(window, round, anchor, OWN fields).
/// high_qc/tip are per-voter hints + accountability — verified in the signature, never quorum-read
/// as a max-of-claims (the certified-prefix floor is what the LOCAL verifier has verified).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SignedTimeoutVote {
    pub voter_id: String,
    pub signature: Vec<u8>,
    pub high_qc_idx: u64,
    pub high_qc_hash: [u8; 32],
    pub tip_height: u64,
    pub tip_hash: [u8; 32],
}

// Legacy alias for compatibility
pub type TimeoutCertificate = TimeoutProof;
pub type TimeoutVoteData = SignedTimeoutVote;

// `AggregatedSignedVote` / `AggregatedTimeoutCertificate` REMOVED with the
// cross-round pacemaker (see the NetworkMessage tombstone). Same-round 2f+1 is
// carried by `TimeoutProof` — all votes share one round + hash.

// v14.7.2: per-microblock `QuorumCertificate` struct + verify REMOVED.
// Microblock BFT safety is delivered by the canonical macroblock
// commit/reveal path; a per-block QC container is not needed.

/// Block received from P2P network for processing
#[derive(Debug, Clone)]
pub struct ReceivedBlock {
    pub height: u64,
    pub data: Vec<u8>,
    pub block_type: String,
    pub from_peer: String,
    pub timestamp: u64,
}

/// Transaction received from P2P network for mempool processing
#[derive(Debug, Clone)]
pub struct ReceivedTransaction {
    pub tx_hash: String,
    pub tx_data: Vec<u8>,
    pub from_peer: String,
    pub timestamp: u64,
}


/// PRODUCTION: Gossip and heartbeat helper methods for SimplifiedP2P

/// Implementation of sync and catch-up methods for SimplifiedP2P

/// Helper function to convert region enum to string
fn region_string(region: &Region) -> &'static str {
    match region {
        Region::NorthAmerica => "NorthAmerica",
        Region::Europe => "Europe",
        Region::Asia => "Asia",
        Region::SouthAmerica => "SouthAmerica",
        Region::Africa => "Africa",
        Region::Oceania => "Oceania",
    }
}

/// v15.9: Extract a leading-octet prefix from an IPv4 address string.
/// `octets = 3` returns the /24 prefix (e.g. "192.168.1"),
/// `octets = 2` returns the /16 prefix (e.g. "192.168").
/// Returns None for malformed input or non-IPv4 values (IPv6 addresses,
/// hostnames). The bind path is the same `peer_ip` extracted at the
/// top of `add_peer_lockfree` — already validated as host part of an
/// `IP:PORT` string, so production input is uniformly IPv4.
pub fn extract_subnet_prefix(ip: &str, octets: usize) -> Option<String> {
    if octets == 0 || octets > 4 {
        return None;
    }
    // Reject IPv6 (':' in host) and obvious non-IPv4 strings.
    if ip.contains(':') || ip.is_empty() {
        return None;
    }
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    // Each octet must be a valid 0..=255 number.
    for p in &parts {
        match p.parse::<u8>() {
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    Some(parts[..octets].join("."))
}

/// PRIVACY: Generate privacy-preserving identifier for IP addresses
/// This replaces direct IP display in logs to protect user privacy
pub fn get_privacy_id_for_addr(addr: &str) -> String {
    // Extract IP from "IP:PORT" format if needed
    let ip = if addr.contains(':') {
        addr.split(':').next().unwrap_or(addr)
    } else {
        addr
    };
    
    // Check if this is a Genesis node (public knowledge)
    if let Some(genesis_id) = crate::genesis_constants::get_genesis_id_by_ip(ip) {
        return format!("genesis_node_{}", genesis_id);
    }
    
    // Private/internal IPs (Docker bridges, private LANs) get a separate label. RFC1918 172 is
    // private ONLY for second octet 16..=31 — 172.32+ (e.g. carrier-grade 172.58.x) is PUBLIC and
    // must not be mislabeled "private_" (it surfaced as the impostor IP behind the gate-reject flood).
    let is_private = ip.starts_with("10.")
        || ip.starts_with("192.168.")
        || ip.strip_prefix("172.")
             .and_then(|rest| rest.split('.').next())
             .and_then(|oct| oct.parse::<u8>().ok())
             .map(|oct| (16..=31).contains(&oct))
             .unwrap_or(false);
    if is_private {
        let ip_hash = blake3::hash(format!("PRIVATE_{}", ip).as_bytes());
        return format!("private_{}", &ip_hash.to_hex()[..8]);
    }
    
    // For all other IPs, generate privacy-preserving hash
    let ip_hash = blake3::hash(format!("NODE_{}", ip).as_bytes());
    format!("node_{}", &ip_hash.to_hex()[..8])
}



/// QUANTUM: Get Genesis bootstrap IPs using EXISTING genesis_constants
pub fn get_genesis_bootstrap_ips() -> Vec<String> {
    // EXISTING: Use genesis_constants::GENESIS_NODE_IPS to avoid code duplication
    use crate::genesis_constants::GENESIS_NODE_IPS;
    GENESIS_NODE_IPS.iter()
        .map(|(ip, _)| ip.to_string())
        .collect()
}

/// QUANTUM: Check if IP is a Genesis node using EXISTING constants
fn is_genesis_node_ip(ip: &str) -> bool {
    // EXISTING: Use genesis_constants::get_genesis_id_by_ip() to avoid duplication
    use crate::genesis_constants::get_genesis_id_by_ip;
    get_genesis_id_by_ip(ip).is_some()
}

/// Decompress zstd-compressed bytes with a HARD output ceiling.
///
/// `zstd::decode_all` reads the input to completion and allocates whatever
/// the stream asks for. Adversarial inputs can be ~1000× their on-the-wire
/// size, so an attacker who slips a 10 MB packet past the QUIC
/// `MAX_MESSAGE_SIZE` gate could decompress into several GB of RAM. We
/// stream the decoder into a buffer wrapped by `std::io::Read::take` so
/// the very first byte beyond `max_output_bytes` short-circuits with
/// `Err(InvalidInput)` — the partially-decoded buffer is dropped and the
/// caller drops the message. No additional RAM beyond `max_output_bytes`
/// is ever observed.
///
/// Threat addressed
/// ────────────────
/// DoS via decompression bomb: a bounded packet (≤ MAX_MESSAGE_SIZE) that
/// expands to gigabytes during decoding. With this cap the worst-case RAM
/// allocation per malicious packet is `max_output_bytes`, and the rate of
/// such packets is bounded by the upstream P2P rate limiter.
///
/// Scalability
/// ───────────
/// O(N) in `output_size` (typical zstd decode). Independent of network
/// peer count. The 4 KiB streaming buffer is constant per call. Used on
/// hot paths (incoming P2P decompression) so we deliberately avoid
/// allocation churn — the resulting `Vec<u8>` is built once with a
/// pre-sized capacity hint of 1 MiB or `max_output_bytes`, whichever is
/// smaller.
///
/// Returns the decoded bytes on success. On overflow the error message
/// names the cap that was breached so operators can correlate the WARN
/// log to the configured ceiling.
pub fn decompress_zstd_bounded(input: &[u8], max_output_bytes: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut decoder = zstd::Decoder::new(input)?;
    // Pre-size to a small constant; the bounded reader caps the upper end.
    let initial_cap = max_output_bytes.min(1 * 1024 * 1024);
    let mut output: Vec<u8> = Vec::with_capacity(initial_cap);
    // `Read::take` prevents any read past the cap from succeeding without
    // having to peek-and-drop bytes ourselves. We give it `max + 1` so a
    // payload that decodes to EXACTLY `max` succeeds, but `max + 1` trips
    // the limit and returns 0 (EOF) before the inner buffer can grow.
    let cap_plus_one = max_output_bytes.saturating_add(1) as u64;
    let mut bounded = decoder.by_ref().take(cap_plus_one);
    let _ = bounded.read_to_end(&mut output)?;
    if output.len() > max_output_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "decompressed_size_exceeds_cap output_bytes={} cap_bytes={}",
                output.len(), max_output_bytes
            ),
        ));
    }
    Ok(output)
}

/// Helper function to get Genesis region by index (0-4)
#[allow(dead_code)]
fn get_genesis_region_by_index(index: usize) -> Region {
    // EXISTING: Map Genesis node indices to their regions from genesis_constants.rs
    match index {
        0 => Region::NorthAmerica, // genesis_node_001 (154.38.160.39)
        1 => Region::Europe,        // genesis_node_002 (62.171.157.44)
        2 => Region::Europe,        // genesis_node_003 (161.97.86.81)
        3 => Region::Europe,        // genesis_node_004 (5.189.130.160)
        4 => Region::Europe,        // genesis_node_005 (162.244.25.114)
        _ => Region::Europe,        // Default fallback
    }
}

// ARCHITECTURE FIX: Removed peer blockchain registry functions
// 
// REASON: Peer discovery is a P2P task, NOT a blockchain task!
//
// PROBLEMS WITH OLD APPROACH:
// 1. Created activation TX for every peer connection
// 2. TX never included in blocks (blocks are empty in Phase 1)
// 3. TX accumulated in mempool infinitely (no TTL, no gossip)
// 4. Not scalable (1M nodes × 2K peers = 2B useless TX!)
// 5. Mixed peer discovery with paid node activation (wrong!)
//
// CORRECT APPROACH:
// - Peer info stored in DashMap (already done in add_peer_safe)
// - P2P gossip for peer updates (if needed)
// - No blockchain TX for peer discovery
// - BlockchainActivationRegistry ONLY for paid activations (1DEV/QNC)





/// QUANTUM: Discover Genesis nodes via DHT protocol
#[allow(dead_code)]
fn discover_genesis_nodes_via_dht() -> Vec<String> {
    // CRITICAL FIX: During cold start (empty blockchain), use hardcoded Genesis IPs as fallback
    // This is REQUIRED for initial Genesis node bootstrap when blockchain registry is empty
    
    let is_genesis_bootstrap = std::env::var("QNET_BOOTSTRAP_ID")
        .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
        .unwrap_or(false);
        
    if is_genesis_bootstrap {
        // EXISTING: Use genesis_constants::GENESIS_NODE_IPS for cold start fallback
        use crate::genesis_constants::GENESIS_NODE_IPS;
        let genesis_fallback_ips = GENESIS_NODE_IPS.iter()
            .map(|(ip, _)| ip.to_string())
            .collect::<Vec<String>>();
        
        if crate::node::is_info() {
            println!("[ERR][P2P] COLD START: Using hardcoded Genesis IPs for initial bootstrap");
        }
        if crate::node::is_info() {
            println!("[INFO][P2P] Once registered in blockchain, will use quantum discovery");
        }
        return genesis_fallback_ips;
    }
    
    // For normal nodes, use empty list (will fall back to peer exchange)
    Vec::new()
}

#[allow(dead_code)]

/// Module-level read of HIGHEST_CERTIFIED_ROUND for (macroblock_index).
/// Used by `block_pipeline::verify_stage` which has no P2P handle.
pub fn highest_certified_round_for(mb_index: u64) -> u64 {
    HIGHEST_CERTIFIED_ROUND.get(&mb_index).map(|v| *v).unwrap_or(0)
}

// ═══════════════════════════════════════════════════════════════════════════
// v14.7 (pt 9): SERIALIZERS / DESERIALIZERS for persistent consensus state.
// ═══════════════════════════════════════════════════════════════════════════
// The persistence layer (storage.rs) exposes opaque byte-blob save/load for
// the two consensus DashMaps:
//   * TIMEOUT_CERTIFICATES   (full certificate payload with 2f+1 votes)
//   * HIGHEST_CERTIFIED_ROUND (O(1) tracker)
// These helpers produce and consume bincode payloads without leaking the
// internal DashMap type to callers. The format is versioned via the storage
// key suffix ("..._v1") so a future schema change is non-breaking.
//
// Scales cleanly beyond 1000 validators because what we serialise is the
// per-macroblock-index state, pruned to the retention window by the periodic
// cleanup loop. Payload size is O(active_mb_window) not O(total_validators).
// ═══════════════════════════════════════════════════════════════════════════
pub fn snapshot_timeout_certificates() -> Vec<u8> {
    let entries: Vec<((u64, u64), TimeoutCertificate)> = TIMEOUT_CERTIFICATES
        .iter()
        .map(|e| (*e.key(), e.value().clone()))
        .collect();
    bincode::serialize(&entries).unwrap_or_default()
}

pub fn snapshot_highest_certified_rounds() -> Vec<u8> {
    let entries: Vec<(u64, u64)> = HIGHEST_CERTIFIED_ROUND
        .iter()
        .map(|e| (*e.key(), *e.value()))
        .collect();
    bincode::serialize(&entries).unwrap_or_default()
}

// v14.8.7: `snapshot_highest_adopted_rounds` / `rehydrate_highest_adopted_rounds`
// REMOVED together with HIGHEST_ADOPTED_ROUND. The persisted blob for the
// adopted-round tracker is no longer produced; callers in storage.rs must
// stop invoking them, and any legacy on-disk blob is simply ignored (we
// always re-derive state from TIMEOUT_CERTIFICATES on boot).

/// Rehydrated TC counts: (installed, rejected).
pub type RehydrateCounts = (usize, usize);

/// Structural pre-filter over a persisted TC blob: key must match the proof's own fields and the
/// vote set must be non-empty. Pure and cheap — it decides nothing on its own; every survivor still
/// has to pass signature verification before it may enter TIMEOUT_CERTIFICATES.
pub fn tc_blob_structural(bytes: &[u8]) -> Vec<((u64, u64), TimeoutCertificate)> {
    if bytes.is_empty() { return Vec::new(); }
    match bincode::deserialize::<Vec<((u64, u64), TimeoutCertificate)>>(bytes) {
        Ok(entries) => entries
            .into_iter()
            .filter(|(k, v)| v.height == k.0 && v.timeout_round == k.1 && !v.votes.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Rehydrate the certified-round tracker — a pair is installed ONLY when the co-persisted TC blob
/// (rehydrated first) actually holds that (mb, round) proof. Raw pairs from disk are otherwise a
/// forgeable production input.
pub fn rehydrate_highest_certified_rounds(bytes: &[u8]) -> usize {
    if bytes.is_empty() { return 0; }
    match bincode::deserialize::<Vec<(u64, u64)>>(bytes) {
        Ok(entries) => {
            let mut count = 0usize;
            for (k, v) in entries {
                if TIMEOUT_CERTIFICATES.contains_key(&(k, v)) {
                    HIGHEST_CERTIFIED_ROUND.insert(k, v);
                    count += 1;
                }
            }
            count
        }
        Err(_) => 0,
    }
}

// v14.7.2: per-microblock block-commit helpers, leader-lock helpers,
// `commit_vote_msg` / `insert_verified_commit_vote` / `quorum_cert_for_block`
// / `fast_finalized_height` / `cleanup_commit_state` / `qc_threshold_2f_plus_1`
// / `ACTIVE_VALIDATOR_COUNT_CACHE` / `update_active_validator_cache`
// / `broadcast_block_commit_vote` — ALL REMOVED.
//
// Rationale: they existed to support the per-microblock QC pattern that
// duplicated the macroblock commit/reveal path. With the per-block QC
// layer gone the helpers have no callers. Macroblock 2f+1 threshold is
// computed live from `SimplifiedP2P::get_active_validator_count` at each
// use-site — no free-function cache is necessary anymore.


// =============================================================================
// UNIT TESTS FOR UNIFIED P2P CRYPTO FUNCTIONS
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    // ONE test fn: these invariants share module statics — parallel test threads must not interleave.
    #[test]
    fn failover_view_sync_invariants() {
        let _guard = TEST_FAILOVER_STATE_LOCK.lock();
        test_clear_timeout_state();

        // ── Canonical vote payload: versioned domain tag; every field changes the signed bytes.
        let a = [1u8; 32]; let qh = [2u8; 32]; let th = [3u8; 32];
        let m = timeout_vote_message(7, 3, &a, 5, &qh, 640, &th);
        assert!(m.starts_with("QNET_TIMEOUT_V2:7:3:"), "domain-tagged + versioned");
        assert_ne!(m, timeout_vote_message(7, 3, &[9u8; 32], 5, &qh, 640, &th), "anchor binds");
        assert_ne!(m, timeout_vote_message(7, 3, &a, 5, &qh, 641, &th), "tip binds");
        assert_ne!(m, timeout_vote_message(8, 3, &a, 5, &qh, 640, &th), "window binds");

        // ── Genesis-era committee (w<3): the fixed genesis set, n=5 ⇒ f=1, quorum=4 — never
        // signature-only. Anchor = zeros.
        let c0 = failover_committee_for_window(0).expect("genesis committee");
        assert_eq!(c0.len(), crate::genesis_constants::GENESIS_CONSENSUS_PKS.len());
        assert_eq!(qnet_consensus::checkpoint_bft::quorum_size(c0.len()), 4, "n=5 ⇒ quorum 4");
        assert_eq!(sealed_anchor_for_window(2), Some([0u8; 32]), "w<3 ⇒ zero anchor");

        // ── f+1 window amplification, MIN-target. Genesis f=1 ⇒ need 2 distinct voters.
        test_insert_timeout_vote(2, 1, "voter_a");
        test_insert_timeout_vote(2, 1, "voter_b");          // w=2 supported (2 distinct)
        test_insert_timeout_vote(1, 1, "voter_c");          // w=1 NOT supported (1 distinct)
        assert_eq!(lowest_window_with_support(0), Some(2), "f+1 support fires; single vote does not");
        // Same voter across two rounds of one window counts ONCE (distinct-voter rule).
        test_insert_timeout_vote(1, 2, "voter_c");
        assert_eq!(lowest_window_with_support(0), Some(2), "same voter twice ≠ two voters");
        // A second distinct voter on w=1 flips the min-target to the LOWER supported window.
        test_insert_timeout_vote(1, 1, "voter_d");
        assert_eq!(lowest_window_with_support(0), Some(1), "MIN of supported windows wins");
        assert_eq!(lowest_window_with_support(1), Some(2), "strictly-above filter");
        assert_eq!(lowest_window_with_support(2), None, "nothing above");

        // ── Rehydration hardening. A certified-round pair installs ONLY when backed by a co-persisted
        // structurally-consistent TC. Rehydrate must NOT raise the floor — that boot re-raise is what
        // permanently deafened a rolled-back node in its own window; the floor is finality-derived.
        test_clear_timeout_state();
        crate::node::LAST_FINALIZED_HEIGHT.store(0, std::sync::atomic::Ordering::SeqCst);
        let vote = SignedTimeoutVote {
            voter_id: "voter_a".into(), signature: vec![1],
            high_qc_idx: 0, high_qc_hash: [0u8; 32], tip_height: 629, tip_hash: [0u8; 32],
        };
        let good = TimeoutProof { height: 7, timeout_round: 3, anchor: [0u8; 32], votes: vec![vote.clone()] };
        let mismatched = TimeoutProof { height: 6, timeout_round: 1, anchor: [0u8; 32], votes: vec![vote] };
        let blob = bincode::serialize(&vec![((7u64, 3u64), good), ((8u64, 1u64), mismatched)]).unwrap();
        assert_eq!(tc_blob_structural(&blob).len(), 1, "key/field-mismatched TC dropped by the pre-filter");
        assert_eq!(observed_tc_window_floor(), 0, "rehydrate never raises the floor");
        // Nothing was signature-verified, so TIMEOUT_CERTIFICATES stays empty and the certified-round
        // tracker cannot be seeded from disk alone — raw pairs are not a production input.
        let pairs = bincode::serialize(&vec![(7u64, 3u64), (9u64, 5u64)]).unwrap();
        assert_eq!(rehydrate_highest_certified_rounds(&pairs), 0, "unverified pairs NOT installed");
        assert_eq!(highest_certified_round_for(7), 0);
        assert_eq!(highest_certified_round_for(9), 0);

        // ── Floor = finalized window (a ratchet, always ≤ tip). A rollback of UNFINALIZED blocks leaves
        // finality AND the certs intact, so a re-advancing node re-elects the certified producer; the
        // eviction still prunes banked votes below a freshly-certified window (double-TC belt).
        test_clear_timeout_state();
        crate::node::LAST_FINALIZED_HEIGHT.store(2 * 90, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(observed_tc_window_floor(), 2, "floor = finalized window");
        test_insert_timeout_vote(4, 1, "voter_a"); // banked at window 4
        test_insert_timeout_vote(6, 1, "voter_b"); // at window 6
        evict_votes_below_certified(5); // a TC certified window 5
        assert!(!TIMEOUT_VOTES.contains_key(&(4, 1)), "below-certified banked vote pruned");
        assert!(TIMEOUT_VOTES.contains_key(&(6, 1)), "at-or-above vote retained");
        // A stuck node with tip in window 4-5 has floor 2 (finality) — it CAN still receive/form a TC
        // for its own window, the wedge this fixes. Certified round survives (finality 2 < window 5).
        assert_eq!(observed_tc_window_floor(), 2, "floor stays at finality, never above the tip");
        crate::node::LAST_FINALIZED_HEIGHT.store(0, std::sync::atomic::Ordering::SeqCst);

        // ── A4 self-yield gate: the self-expected leader emits its single decisive view-change vote
        // once (quorum − 1) DISTINCT committee peers already want to rotate off it — never at f+1,
        // never cross-round, and never if it already voted this round.
        test_clear_timeout_state();
        let sw = 0u64; // genesis window: committee = 5 ⇒ quorum 4 ⇒ decisive at 3 others
        test_insert_timeout_vote(sw, 1, "g_a");
        test_insert_timeout_vote(sw, 1, "g_b");
        assert!(!round_one_short_of_quorum(sw, "g_e"), "2 < quorum-1 ⇒ our vote not yet decisive");
        test_insert_timeout_vote(sw, 1, "g_c"); // 3 distinct = quorum-1
        assert!(round_one_short_of_quorum(sw, "g_e"), "quorum-1 others ⇒ self-yield fires");
        assert!(!round_one_short_of_quorum(sw, "g_a"), "already voted this round ⇒ not withholding");

        test_clear_timeout_state();
    }

    /// The live-conn signed-head reply fires ONLY for a genuine follower (behind by >= HEAD_REPLY_MIN_GAP),
    /// so an at-tip / within-gap peer triggers no chatter while a real follower always gets the tip feed.
    #[test]
    fn head_reply_gap_gate_only_fires_for_genuine_followers() {
        let our = 1000u64;
        // Within-gap peers: no reply.
        assert!(!(our >= (our - 1).saturating_add(HEAD_REPLY_MIN_GAP)), "at-tip peer must NOT trigger a reply");
        assert!(!(our >= (our - (HEAD_REPLY_MIN_GAP - 1)).saturating_add(HEAD_REPLY_MIN_GAP)), "within-gap peer must NOT trigger");
        // Exactly at the gap boundary, and a deep follower: reply fires.
        let at_gap = our - HEAD_REPLY_MIN_GAP;
        assert!(our >= at_gap.saturating_add(HEAD_REPLY_MIN_GAP), "follower behind by exactly the gap MUST trigger");
        let deep = our.saturating_sub(5000);
        assert!(our >= deep.saturating_add(HEAD_REPLY_MIN_GAP), "deep follower MUST trigger");
    }

    /// The ingest failover-round authority must mirror the producer's own round check exactly:
    /// a block at relative `block_round` is authorised iff its ABSOLUTE round (block_round +
    /// baseline) is ≤ the 2f+1-certified HIGHEST_CERTIFIED_ROUND. Both sides read the same map,
    /// so the gate and the producer can never disagree on whether a failover round is authorised.
    #[test]
    fn failover_round_authorized_matches_producer_authority() {
        let _guard = TEST_FAILOVER_STATE_LOCK.lock();
        // Unique mb_idx values so the global consensus DashMaps don't collide with other tests.
        // baseline is now CARRIED in the block (3rd arg), not read from LAST_FINALIZED_ROUND_PER_MB.
        let mb = 9_100_001u64;
        // 2f+1 certified ABSOLUTE round 12 for this macroblock.
        HIGHEST_CERTIFIED_ROUND.insert(mb, 12);
        assert!(failover_round_authorized(mb, 0, 0),  "round 0 (happy path) is always authorised");
        assert!(failover_round_authorized(mb, 11, 0), "round below certified is authorised");
        assert!(failover_round_authorized(mb, 12, 0), "round == certified is authorised");
        assert!(!failover_round_authorized(mb, 13, 0), "round above certified is NOT authorised (uncertified/forged)");

        // Non-zero carried baseline ⇒ the comparison is in ABSOLUTE units (block_round + carried_baseline).
        let mb2 = 9_100_002u64;
        HIGHEST_CERTIFIED_ROUND.insert(mb2, 12);    // absolute certified round
        assert!(failover_round_authorized(mb2, 7, 5),  "abs 7+5=12 <= 12 → authorised");
        assert!(!failover_round_authorized(mb2, 8, 5), "abs 8+5=13 > 12 → rejected");

        // No certified round recorded ⇒ only the happy path (round 0) passes.
        let mb3 = 9_100_003u64;
        assert!(failover_round_authorized(mb3, 0, 0),  "uninitialised mb: round 0 still ok");
        assert!(!failover_round_authorized(mb3, 1, 0), "uninitialised mb: any failover round rejected");
    }

    /// Test rate limiter functionality
    #[test]
    fn test_rate_limiter() {
        let limit = RateLimit {
            requests: vec![],
            max_requests: 100,
            window_seconds: 60,
            blocked_until: 0,
        };
        
        // Fresh rate limit should not be blocked
        assert_eq!(limit.blocked_until, 0, "New rate limiter should not be blocked");
        assert!(limit.requests.is_empty(), "New rate limiter should have no requests");
        assert_eq!(limit.max_requests, 100, "Max requests should be 100");
    }
    
    /// Test blacklist entry expiration
    #[test]
    fn test_blacklist_entry_expiration() {
        use std::time::Instant;
        
        // Create entry with short duration that will be checked
        let expired_entry = BlacklistEntry {
            reason: BlacklistReason::SyncTimeout,
            timestamp: Instant::now().checked_sub(std::time::Duration::from_secs(1000))
                .unwrap_or_else(Instant::now),
            duration_secs: 100, // Expired 900 seconds ago
            attempts: 1,
        };
        
        assert!(!expired_entry.is_active(), "Entry should be expired");
        
        let active_entry = BlacklistEntry {
            reason: BlacklistReason::SlowResponse,
            timestamp: Instant::now(),
            duration_secs: 2000, // Active for next 2000 seconds
            attempts: 1,
        };
        
        assert!(active_entry.is_active(), "Entry should be active");
    }
    
    /// Test permanent blacklist (duration = 0).
    ///
    /// FIX: previous version used `Instant::now() - Duration::from_secs(86400)`
    /// which panics on Windows when the resulting `Instant` would be earlier
    /// than the system boot time (e.g. on a freshly-booted CI runner). The
    /// `Instant - Duration` operator's `checked_sub` semantics underflow in
    /// that case, so we use `checked_sub` explicitly and fall back to
    /// `Instant::now()` when the saturation kicks in. The test invariant
    /// (a `duration_secs == 0` entry is always active) holds regardless of
    /// the timestamp's absolute value, so the fallback is semantically
    /// equivalent.
    #[test]
    fn test_permanent_blacklist() {
        use std::time::Instant;

        let now = Instant::now();
        let timestamp = now
            .checked_sub(std::time::Duration::from_secs(86400))
            .unwrap_or(now);

        let entry = BlacklistEntry {
            reason: BlacklistReason::MaliciousBehavior,
            timestamp,
            duration_secs: 0, // Permanent
            attempts: 5,
        };

        assert!(entry.is_active(), "Permanent blacklist should always be active");
    }
    
    /// Test PQ P2P signature format detection
    #[test]
    fn test_pq_p2p_signature_format() {
        let pq_sig = r#"pq_p2p:{"node_id":"test_node"}"#;
        let legacy_sig = "dilithium_sig_abc123";
        let heartbeat_sig = "heartbeat_v2_test_node_1234567890";

        assert!(pq_sig.starts_with("pq_p2p:"));
        assert!(legacy_sig.starts_with("dilithium_sig_"));
        assert!(heartbeat_sig.starts_with("heartbeat_v2_"));
    }
    
    /// Test CompactPqSignature JSON parsing for P2P
    /// OPTIMIZED v2.23: RAW bytes, dilithium_message_signature removed
    #[test]
    fn test_compact_signature_p2p_parsing() {
        use crate::crypto::CompactPqSignature;
        
        // Pure ML-DSA-65: RAW bytes format (Dilithium is the sole authenticator)
        let sig = CompactPqSignature {
            node_id: "p2p_test".to_string(),
            cert_serial: "CERT-P2P-123".to_string(),
            dilithium_key_signature: vec![1, 2, 3],  // RAW bytes
            signed_at: 9999999999,
        };
        
        // Test roundtrip
        let json = serde_json::to_string(&sig).expect("Serialization failed");
        let restored: CompactPqSignature = serde_json::from_str(&json)
            .expect("Deserialization failed");
        
        assert_eq!(sig.node_id, restored.node_id);
        assert_eq!(sig.dilithium_key_signature, restored.dilithium_key_signature);
        assert!(sig.signed_at > 0);
    }
    
    /// Test encapsulated data recreation for verification
    #[test]
    fn test_encapsulated_data_verification_format() {
        use sha3::{Sha3_256, Digest};
        
        // Simulate message hashing
        let message = "test p2p message";
        let mut hasher = Sha3_256::new();
        hasher.update(message.as_bytes());
        let message_hash = hasher.finalize();
        
        assert_eq!(message_hash.len(), 32);
        
        // Simulate re-rooted encapsulated data creation (P8: message_hash || timestamp)
        let timestamp: u64 = 1700000000;

        let mut encapsulated = Vec::new();
        encapsulated.extend_from_slice(&message_hash);
        encapsulated.extend_from_slice(&timestamp.to_le_bytes());

        // Pure ML-DSA-65 preimage: 32 + 8 = 40 bytes
        assert_eq!(encapsulated.len(), 40);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // SHRED PROTOCOL RETRANSMIT TESTS (v2.21.3)
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Test ShredChunkCacheEntry creation and storage
    #[test]
    fn test_shred_chunk_cache_entry() {
        let chunks = vec![
            Some(vec![1u8; 1024]),
            Some(vec![2u8; 1024]),
            None,  // Missing chunk
            Some(vec![4u8; 1024]),
        ];
        let parity = vec![
            Some(vec![5u8; 1024]),
            None,
        ];
        
        let entry = ShredChunkCacheEntry {
            chunks: chunks.clone(),
            parity_chunks: parity.clone(),
            original_block_size: 4096,
            is_macroblock: false,
            cached_at: std::time::Instant::now(),
            block_hash: Some([9u8; 32]),
            num_coding: 2,
        };

        assert_eq!(entry.chunks.len(), 4);
        assert_eq!(entry.parity_chunks.len(), 2);
        assert!(entry.chunks[0].is_some());
        assert!(entry.chunks[2].is_none());
        assert_eq!(entry.original_block_size, 4096);
        assert!(!entry.is_macroblock);
        assert_eq!(entry.block_hash, Some([9u8; 32]));
        assert_eq!(entry.num_coding, 2);
    }
    
    /// Test adaptive peer selection for retransmit requests
    #[test]
    fn test_retransmit_adaptive_peer_count() {
        // Small network (5-10 nodes) → 3 peers
        let peer_count_5 = 5;
        let request_count_5 = if peer_count_5 <= 10 { 3.min(peer_count_5) } else { 0 };
        assert_eq!(request_count_5, 3);
        
        // Medium network (100 nodes) → 5 peers
        let peer_count_100 = 100;
        let request_count_100 = if peer_count_100 <= 100 { 5.min(peer_count_100) } else { 0 };
        assert_eq!(request_count_100, 5);
        
        // Large network (1000 nodes) → 6 peers
        let peer_count_1000 = 1000;
        let request_count_1000 = if peer_count_1000 <= 1_000 { 6 } else { 0 };
        assert_eq!(request_count_1000, 6);
        
        // Very large network (10000 nodes) → 7 peers
        let peer_count_10000 = 10000;
        let request_count_10000 = if peer_count_10000 <= 10_000 { 7 } else { 0 };
        assert_eq!(request_count_10000, 7);
        
        // Massive network (100000 nodes) → 8 peers
        let peer_count_100000 = 100000;
        let request_count_100000 = if peer_count_100000 <= 100_000 { 8 } else { 10 };
        assert_eq!(request_count_100000, 8);
    }
    
    /// Test SHRED constants are correctly defined
    #[test]
    fn test_shred_retransmit_constants() {
        assert_eq!(SHRED_CHUNK_TIMEOUT_SECS, 5, "Timeout should be 5 seconds (v2.31)");
        assert_eq!(SHRED_CHUNK_CACHE_SIZE, 5_000, "Cache holds the ~83min (5000-block @1s) repair window");
        assert_eq!(SHRED_CHUNK_MAX_RETRIES, 4, "Max retries should be 4 (v2.31)");
    }
    
    /// Test ShredProtocolBlockAssembly with retransmit fields
    #[test]
    fn test_shred_assembly_retransmit_fields() {
        let assembly = ShredProtocolBlockAssembly {
            height: 100,
            chunks_received: vec![None; 12],
            parity_chunks: vec![None; 6],
            total_chunks: 12,
            parity_count: 6,
            original_block_size: 12000,
            is_macroblock: false,
            started_at: std::time::Instant::now(),
            retransmit_attempts: 0,
            retransmit_requested_at: None,
            certificate: None, // v2.26: Certificate from chunk #0
            expected_block_hash: None, // FIX R23-P3: post-reconstruction hash check
        };
        
        assert_eq!(assembly.retransmit_attempts, 0);
        assert!(assembly.retransmit_requested_at.is_none());
        assert_eq!(assembly.total_chunks, 12);
        assert_eq!(assembly.parity_count, 6);
    }
    
    /// Test missing chunk indices calculation
    #[test]
    fn test_missing_chunk_indices() {
        let chunks_received = vec![
            Some(vec![1u8; 1024]),  // 0 - present
            None,                   // 1 - missing
            Some(vec![3u8; 1024]),  // 2 - present
            None,                   // 3 - missing
            Some(vec![5u8; 1024]),  // 4 - present
        ];
        
        let missing_data: Vec<usize> = chunks_received.iter()
            .enumerate()
            .filter(|(_, c)| c.is_none())
            .map(|(i, _)| i)
            .collect();
        
        assert_eq!(missing_data, vec![1, 3]);
        assert_eq!(missing_data.len(), 2);
    }
    
    /// Test NetworkMessage::RequestMissingChunks serialization
    #[test]
    fn test_request_missing_chunks_message() {
        let msg = NetworkMessage::RequestMissingChunks {
            block_height: 12345,
            missing_indices: vec![1, 3, 5, 7],
            requester_id: "genesis_node_001".to_string(),
            timestamp: 1700000000,
        };
        
        // Test serialization roundtrip
        let serialized = serde_json::to_string(&msg).expect("Serialization should work");
        let deserialized: NetworkMessage = serde_json::from_str(&serialized).expect("Deserialization should work");
        
        match deserialized {
            NetworkMessage::RequestMissingChunks { block_height, missing_indices, requester_id, timestamp } => {
                assert_eq!(block_height, 12345);
                assert_eq!(missing_indices, vec![1, 3, 5, 7]);
                assert_eq!(requester_id, "genesis_node_001");
                assert_eq!(timestamp, 1700000000);
            }
            _ => panic!("Wrong message type after deserialization"),
        }
    }
    
    /// Test NetworkMessage::MissingChunksResponse serialization  
    #[test]
    fn test_missing_chunks_response_message() {
        let msg = NetworkMessage::MissingChunksResponse {
            block_height: 12345,
            chunks: vec![
                (1, vec![1u8; 100], false),  // data chunk
                (13, vec![2u8; 100], true),  // parity chunk
            ],
            original_block_size: 12000,
            is_macroblock: false,
            sender_id: "genesis_node_002".to_string(),
            block_hash: Some([7u8; 32]),
            num_coding: 6,
        };

        let serialized = serde_json::to_string(&msg).expect("Serialization should work");
        let deserialized: NetworkMessage = serde_json::from_str(&serialized).expect("Deserialization should work");

        match deserialized {
            NetworkMessage::MissingChunksResponse { block_height, chunks, original_block_size, is_macroblock, sender_id, block_hash, num_coding } => {
                assert_eq!(block_height, 12345);
                assert_eq!(chunks.len(), 2);
                assert_eq!(chunks[0].0, 1);  // index
                assert!(!chunks[0].2);       // is_parity = false
                assert_eq!(chunks[1].0, 13); // index
                assert!(chunks[1].2);        // is_parity = true
                assert_eq!(original_block_size, 12000);
                assert!(!is_macroblock);
                assert_eq!(sender_id, "genesis_node_002");
                assert_eq!(block_hash, Some([7u8; 32]));
                assert_eq!(num_coding, 6);
            }
            _ => panic!("Wrong message type after deserialization"),
        }
    }
    
    /// Test macroblock support in retransmit
    #[test]
    fn test_retransmit_macroblock_support() {
        let msg = NetworkMessage::MissingChunksResponse {
            block_height: 90,  // First macroblock
            chunks: vec![(0, vec![1u8; 1024], false)],
            original_block_size: 50000,
            is_macroblock: true,  // ← MACROBLOCK
            sender_id: "test".to_string(),
            block_hash: None,
            num_coding: 0,
        };
        
        match msg {
            NetworkMessage::MissingChunksResponse { is_macroblock, .. } => {
                assert!(is_macroblock, "Macroblock flag should be true");
            }
            _ => panic!("Wrong message type"),
        }
    }


    /// 2f+1 calculation matches BFT formula across small / medium /
    /// large committee sizes. This is the threshold the runtime computes
    /// from `get_active_validator_count()` to gate timeout-certificate
    /// formation.
    #[test]
    fn test_skip_cert_two_f_plus_one_formula() {
        // v34: the failover/timeout layer now uses the SAME quorum as the macroblock BFT —
        // quorum_size(n) = n − f, f = ⌊(n−1)/3⌋ (the SAFE n−f, NOT the old ceil(2n/3) which is a
        // strictly smaller, UNSAFE quorum at n ≡ 0 mod 3). Cases INCLUDE n ≡ 0 mod 3 (6, 9, 12),
        // where the old (2n+2)/3 gave the wrong (smaller) value — so this test would have caught
        // a regression to the old formula.
        for (n, expected) in [
            (4usize, 3usize), (5, 4), (6, 5), (9, 7), (10, 7), (12, 9), (100, 67), (1_000, 667),
        ] {
            assert_eq!(qnet_consensus::checkpoint_bft::quorum_size(n), expected,
                "quorum_size mismatch for N={}", n);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // v15.9: SUBNET DIVERSITY TESTS
    // ────────────────────────────────────────────────────────────────────────
    // Pin the IPv4 prefix-extraction invariants used by the eclipse-defence
    // peer-admission filter. Bad parsing here directly weakens diversity —
    // every malformed input must return None (silently bypass rather than
    // hash unrelated peers into the same bucket).
    // ════════════════════════════════════════════════════════════════════════

    #[test]
    fn test_extract_subnet_24_well_formed() {
        assert_eq!(extract_subnet_prefix("192.168.1.42", 3), Some("192.168.1".to_string()));
        assert_eq!(extract_subnet_prefix("10.0.0.1", 3), Some("10.0.0".to_string()));
        assert_eq!(extract_subnet_prefix("8.8.8.8", 3), Some("8.8.8".to_string()));
    }

    #[test]
    fn test_extract_subnet_16_well_formed() {
        assert_eq!(extract_subnet_prefix("192.168.1.42", 2), Some("192.168".to_string()));
        assert_eq!(extract_subnet_prefix("10.0.0.1", 2), Some("10.0".to_string()));
    }

    #[test]
    fn test_extract_subnet_rejects_ipv6() {
        assert_eq!(extract_subnet_prefix("2001:db8::1", 3), None);
        assert_eq!(extract_subnet_prefix("::1", 3), None);
    }

    #[test]
    fn test_extract_subnet_rejects_malformed() {
        assert_eq!(extract_subnet_prefix("", 3), None);
        assert_eq!(extract_subnet_prefix("not-an-ip", 3), None);
        assert_eq!(extract_subnet_prefix("1.2.3", 3), None);          // too few
        assert_eq!(extract_subnet_prefix("1.2.3.4.5", 3), None);      // too many
        assert_eq!(extract_subnet_prefix("256.0.0.1", 3), None);      // octet out of range
        assert_eq!(extract_subnet_prefix("1.2.3.abc", 3), None);      // non-numeric
    }

    #[test]
    fn test_extract_subnet_rejects_invalid_octet_count() {
        assert_eq!(extract_subnet_prefix("1.2.3.4", 0), None);
        assert_eq!(extract_subnet_prefix("1.2.3.4", 5), None);
    }

    #[test]
    fn test_extract_subnet_full_address() {
        assert_eq!(extract_subnet_prefix("1.2.3.4", 4), Some("1.2.3.4".to_string()));
    }

    #[test]
    fn test_extract_subnet_single_octet() {
        assert_eq!(extract_subnet_prefix("10.0.0.1", 1), Some("10".to_string()));
    }

    #[test]
    fn test_subnet_prefix_distinguishes_distinct_blocks() {
        // Two peers in different /24 blocks but the same /16 must have
        // different /24 prefixes and matching /16 prefixes.
        let a = extract_subnet_prefix("203.0.113.1", 3);
        let b = extract_subnet_prefix("203.0.114.1", 3);
        assert_ne!(a, b, "/24 must distinguish 113 vs 114");

        let a16 = extract_subnet_prefix("203.0.113.1", 2);
        let b16 = extract_subnet_prefix("203.0.114.1", 2);
        assert_eq!(a16, b16, "/16 must collapse 113 and 114 into 203.0");
    }

    // ════════════════════════════════════════════════════════════════════
    // FIX #20 REGRESSION TESTS — bounded zstd decompression (DoS defence)
    // ════════════════════════════════════════════════════════════════════
    // Locks in the invariant that `decompress_zstd_bounded` rejects payloads
    // whose decompressed size exceeds the caller-supplied cap. A regression
    // here re-opens the decompression-bomb DoS class on every incoming P2P
    // path that uses it (MacroBlockBroadcast, sync paths).

    /// Helper: zstd-compress raw bytes for a test fixture.
    fn zstd_compress_for_test(input: &[u8]) -> Vec<u8> {
        zstd::encode_all(input, 1).expect("zstd encode must succeed for test input")
    }

    #[test]
    fn decompress_zstd_bounded_accepts_payload_below_cap() {
        // Payload well under the cap: must decode cleanly.
        let original = b"hello qnet decompression test payload".to_vec();
        let compressed = zstd_compress_for_test(&original);
        let decoded = decompress_zstd_bounded(&compressed, 1024).expect("must decode below cap");
        assert_eq!(decoded, original, "decoded bytes must match original");
    }

    #[test]
    fn decompress_zstd_bounded_accepts_payload_at_exact_cap() {
        // Boundary case: decompressed size equals the cap exactly.
        // The implementation's `cap_plus_one` reader allows this and the
        // post-read length check stays `<= cap`. A regression that uses
        // `< cap` instead would break this test.
        let original = vec![0xABu8; 8 * 1024];
        let compressed = zstd_compress_for_test(&original);
        let decoded = decompress_zstd_bounded(&compressed, original.len())
            .expect("must accept exact-size payload");
        assert_eq!(decoded.len(), original.len());
        assert_eq!(decoded, original);
    }

    #[test]
    fn decompress_zstd_bounded_rejects_payload_above_cap() {
        // Bomb-style input: decompressed size exceeds the cap by a single
        // byte. The cap is the security boundary; +1 must reject.
        let original = vec![0u8; 4096]; // highly compressible
        let compressed = zstd_compress_for_test(&original);
        let result = decompress_zstd_bounded(&compressed, original.len() - 1);
        assert!(result.is_err(), "must reject when decoded > cap");
        let err_str = result.err().unwrap().to_string();
        assert!(
            err_str.contains("decompressed_size_exceeds_cap"),
            "error message must name the breached cap, got: {}", err_str
        );
    }

    #[test]
    fn decompress_zstd_bounded_rejects_high_ratio_bomb() {
        // Realistic decompression-bomb shape: a small input that expands
        // dramatically. We give the cap headroom for the small input but
        // not for the expanded output.
        // 1 MB of repeated zeroes typically compresses to a few KB.
        let original = vec![0u8; 1 * 1024 * 1024];
        let compressed = zstd_compress_for_test(&original);
        // Cap is 4 KB — well above input size, well below decompressed.
        // This proves the cap operates on OUTPUT, not INPUT.
        let result = decompress_zstd_bounded(&compressed, 4 * 1024);
        assert!(result.is_err(), "1 MB-output bomb must be rejected at 4 KB output cap");
    }

    #[test]
    fn decompress_zstd_bounded_rejects_malformed_zstd() {
        // Random bytes that are not a valid zstd stream. The function
        // must return Err (not panic, not silently produce empty output).
        let garbage: Vec<u8> = (0..512).map(|i| (i * 7 + 13) as u8).collect();
        let result = decompress_zstd_bounded(&garbage, 1024);
        assert!(result.is_err(), "malformed zstd must error, not panic");
    }

    #[test]
    fn decompress_zstd_bounded_handles_empty_payload() {
        // Empty original input compresses to a small valid zstd frame
        // (header + EOF). Decoding must succeed and yield an empty Vec.
        let compressed = zstd_compress_for_test(&[]);
        let decoded = decompress_zstd_bounded(&compressed, 1024).expect("empty input must decode");
        assert!(decoded.is_empty(), "empty input decodes to empty output");
    }
}

// FIX-3: Turbine-style relay tree over the CANONICAL committee (committee_for_height — byte-identical
// on every node), so a complete F-ary heap on its indices is a network-agreed tree. Leader egress
// becomes O(root_fanout) and total relay O(m) with provable coverage (unit-tested below). Rotated by
// chunk_index so different chunks seed at different roots. Non-committee nodes are not tree members —
// they PULL (handle_block_request serves finalized blocks to any peer). Pure index math; addressing +
// send happens in the broadcast/forward methods.

/// Physical committee index of the tier-0 root for `chunk_index` over an m-node committee.
fn shred_tree_root(m: usize, chunk_index: usize) -> usize {
    if m == 0 { 0 } else { chunk_index % m }
}

/// Deterministic committee-tree fanout — a pure function of roster size m, so every member builds the
/// SAME F-ary heap and coverage is provable. The per-node latency/peer-count get_shred_protocol_fanout is
/// NOT usable here: two honest members in different latency buckets would pick different F and orphan
/// index bands (a node's f=8 parent skips the children an f=16 sibling covers). Adaptive fanout stays only
/// for the genesis flat-relay fallback (roster None), where it is a redundancy knob, not a tree parameter.
fn shred_tree_fanout(m: usize) -> usize {
    match m {
        0..=64 => 8,
        65..=1024 => 16,
        _ => 32,
    }
}

/// Per-block cache of the FIX-3 relay-tree committee roster. All ~255 chunks of one block share the same
/// committee_for_height(h); without this the hot broadcast/forward path pays a RocksDB read + full
/// MacroBlock deserialize + O(N) VRF sample PER CHUNK (255/block at 100k+ candidates). Bounded to recent.
static SHRED_ROSTER_CACHE: once_cell::sync::Lazy<dashmap::DashMap<u64, Vec<String>>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// Physical committee indices of `my_idx`'s children in the rotated F-ary heap (empty ⇒ leaf).
fn shred_tree_children(m: usize, fanout: usize, chunk_index: usize, my_idx: usize) -> Vec<usize> {
    if m <= 1 || fanout == 0 || my_idx >= m { return Vec::new(); }
    let root = chunk_index % m;
    let my_logical = (my_idx + m - root) % m; // (my_idx - root) mod m
    let mut out = Vec::new();
    for k in 1..=fanout {
        match my_logical.checked_mul(fanout).and_then(|x| x.checked_add(k)) {
            Some(cl) if cl < m => out.push((root + cl) % m),
            _ => break,
        }
    }
    out
}

#[cfg(test)]
mod shred_tree_tests {
    use super::{shred_tree_root, shred_tree_children};

    // BFS from the seeded root via children() — models producer→root→relay.
    fn covered(m: usize, f: usize, chunk: usize) -> std::collections::BTreeSet<usize> {
        let mut seen = std::collections::BTreeSet::new();
        let mut q = std::collections::VecDeque::new();
        let root = shred_tree_root(m, chunk);
        seen.insert(root);
        q.push_back(root);
        while let Some(n) = q.pop_front() {
            for c in shred_tree_children(m, f, chunk, n) {
                if seen.insert(c) { q.push_back(c); }
            }
        }
        seen
    }

    #[test]
    fn full_coverage_all_configs() {
        for &m in &[1usize, 2, 5, 50, 200, 1000] {
            for &f in &[8usize, 16] {
                for chunk in 0..=m.min(40) {
                    let seen = covered(m, f, chunk);
                    assert_eq!(seen.len(), m, "m={} f={} chunk={} covered={}", m, f, chunk, seen.len());
                }
            }
        }
    }

    #[test]
    fn children_valid_and_distinct() {
        for &m in &[5usize, 50, 1000] {
            for &f in &[8usize, 16] {
                for &chunk in &[0usize, 3, m - 1] {
                    for i in 0..m {
                        let ch = shred_tree_children(m, f, chunk, i);
                        for &c in &ch { assert!(c < m, "child {} >= m {}", c, m); }
                        let uniq: std::collections::BTreeSet<_> = ch.iter().collect();
                        assert_eq!(uniq.len(), ch.len(), "duplicate child at m={} i={}", m, i);
                    }
                }
            }
        }
    }
}

// Self-describing FEC round-trip: the invariant behind carrying `num_coding_shreds` on every shred — the
// decoder MUST reconstruct with the SAME (data, parity) dimensions the producer encoded with, or
// `rs.reconstruct()` returns Ok-but-WRONG bytes. These tests exercise the exact codec the shred path uses
// (reed_solomon_erasure::galois_8), independent of any P2P instance.
#[cfg(test)]
mod shred_fec_tests {
    use reed_solomon_erasure::galois_8::ReedSolomon;

    // Encode `data` shards → `parity` coding shards; return the full padded shard vector.
    fn encode(data: &[Vec<u8>], parity: usize, shard_len: usize) -> Vec<Vec<u8>> {
        let rs = ReedSolomon::new(data.len(), parity).expect("rs new");
        let mut shards: Vec<Vec<u8>> = data.iter()
            .map(|d| { let mut v = d.clone(); v.resize(shard_len, 0); v })
            .collect();
        for _ in 0..parity { shards.push(vec![0u8; shard_len]); }
        rs.encode(&mut shards).expect("rs encode");
        shards
    }

    #[test]
    fn matched_dims_recover_dropped_data_shreds() {
        // Producer: 8 data + 6 coding (a 1.75× tier). Drop up to 6 data shreds; the decoder that uses the
        // SAME (8, 6) dims must recover every original data shred exactly.
        let (n, p, len) = (8usize, 6usize, 64usize);
        let orig: Vec<Vec<u8>> = (0..n).map(|i| vec![(i as u8).wrapping_mul(37).wrapping_add(1); len]).collect();
        let coded = encode(&orig, p, len);
        for drop in 0..=p {
            let mut shards: Vec<Option<Vec<u8>>> = coded.iter().cloned().map(Some).collect();
            for i in 0..drop { shards[i] = None; } // lose `drop` data shreds (≤ parity ⇒ recoverable)
            let rs = ReedSolomon::new(n, p).expect("decoder rs");
            rs.reconstruct(&mut shards).expect("reconstruct");
            for i in 0..n {
                assert_eq!(shards[i].as_ref().unwrap(), &orig[i],
                           "matched (n={},p={}) must recover data shard {} after dropping {}", n, p, i, drop);
            }
        }
    }

    #[test]
    fn undersized_parity_guess_loses_reconstructability() {
        // The REAL effect of guessing the coding count (the reed_solomon_erasure coding matrix is
        // index-stable, so a subset of coding shards still decodes CORRECTLY — it does NOT produce wrong
        // bytes). The bug is that the legacy decoder sized its parity vector to total*0.5 and DROPPED every
        // coding shred beyond that, throwing away half the producer's redundancy — so under heavier loss it
        // can no longer reconstruct, falling to repair. Here: producer 8 data + 6 coding; lose 5 data shreds
        // (> the 4 the legacy guess keeps, ≤ the 6 real). The self-described decoder (parity=6) recovers;
        // the guess decoder (parity=4) cannot even be fed enough shards to reach the data count.
        let (n, p_enc, len) = (8usize, 6usize, 64usize);
        let orig: Vec<Vec<u8>> = (0..n).map(|i| vec![(i as u8).wrapping_mul(37).wrapping_add(1); len]).collect();
        let coded = encode(&orig, p_enc, len); // 8 data + 6 coding

        // SELF-DESCRIBED decoder (parity=6): keeps all 6 coding shreds, loses 5 data ⇒ 3 data + 6 coding =
        // 9 ≥ 8 ⇒ reconstructs.
        {
            let mut shards: Vec<Option<Vec<u8>>> = coded.iter().cloned().map(Some).collect();
            for i in 0..5 { shards[i] = None; }
            let rs = ReedSolomon::new(n, p_enc).expect("decoder rs");
            rs.reconstruct(&mut shards).expect("self-described decoder must reconstruct");
            for i in 0..n {
                assert_eq!(shards[i].as_ref().unwrap(), &orig[i], "self-described recovers data shard {}", i);
            }
        }

        // LEGACY guess decoder (parity=4): it would have DROPPED coding shreds 4 and 5, so at most 3 data +
        // 4 coding = 7 < 8 ⇒ below the RS data count ⇒ cannot reconstruct. Model that: only the first 4
        // coding shreds are available to it.
        {
            let mut shards: Vec<Option<Vec<u8>>> =
                coded.iter().take(n + 4).cloned().map(Some).collect(); // 8 data + 4 coding
            for i in 0..5 { shards[i] = None; }
            let available = shards.iter().filter(|s| s.is_some()).count();
            assert!(available < n,
                    "legacy 0.5× guess keeps only {} shreds (< {} data) ⇒ cannot reconstruct this loss",
                    available, n);
        }
    }
}


// =============================================================================
// PEER ADMISSION: one funnel, bounded tables, gate-before-evict
// =============================================================================
#[cfg(test)]
mod tests_peer_admission {
    use super::*;

    fn fixture_peer(id: &str, ip: &str, last_seen: u64, is_outbound: bool) -> PeerInfo {
        PeerInfo {
            id: id.to_string(),
            addr: format!("{}:8001", ip),
            node_type: NodeType::Super,
            region: Region::Europe,
            last_seen,
            is_stable: true,
            latency_ms: 0,
            connection_count: 1,
            bandwidth_usage: 0,
            node_id_hash: Vec::new(),
            // Out of reach of get_bucket_index (first differing bit of two SHA3 digests),
            // so the fixture never trips K-bucket replacement.
            bucket_index: 250,
            reputation: 70.0,
            consensus_score: 70.0,
            network_score: 100.0,
            reputation_score: None,
            successful_pings: 0,
            failed_pings: 0,
            last_block_height: 0,
            last_height_attested_at: 0,
            is_outbound,
        }
    }

    /// A gossiped address may only carry an identity the pinned table or the chain committed.
    /// This is the single binding both PeerListResponse and PeerDiscovery resolve through.
    #[test]
    fn gossip_identity_comes_from_pin_or_chain_never_the_wire() {
        let (gip, gid) = crate::genesis_constants::GENESIS_NODE_IPS[0];
        // Pinned address answers from the binary, whatever the relay claimed.
        assert_eq!(
            SimplifiedP2P::gossip_bound_identity("attacker_claimed_id", gip),
            Some(format!("genesis_node_{}", gid)),
        );
        // A genesis identity claimed from any other address is refused outright.
        assert_eq!(SimplifiedP2P::gossip_bound_identity("genesis_node_001", "203.0.113.7"), None);
        // An unregistered identity has no committed endpoint, so it is refused.
        assert_eq!(SimplifiedP2P::gossip_bound_identity("super_unbound", "203.0.113.7"), None);
        // A chain-registered identity binds only to its committed IP.
        crate::genesis_constants::register_node_endpoint("super_bound_a", "http://203.0.113.8:8001");
        assert_eq!(
            SimplifiedP2P::gossip_bound_identity("super_bound_a", "203.0.113.8"),
            Some("super_bound_a".to_string()),
        );
        assert_eq!(SimplifiedP2P::gossip_bound_identity("super_bound_a", "203.0.113.9"), None);
    }

    /// The regional dial-candidate map is a gossip sink: it must dedup and stay capped, or one
    /// connection grows it without bound and the establishment sweep walks every entry.
    #[test]
    fn regional_candidates_dedup_and_stay_capped() {
        let map: Arc<Mutex<HashMap<Region, Vec<PeerInfo>>>> = Arc::new(Mutex::new(HashMap::new()));

        assert!(SimplifiedP2P::push_regional_peer(&map, fixture_peer("p0", "198.51.100.1", 100, false)));
        assert!(!SimplifiedP2P::push_regional_peer(&map, fixture_peer("p0b", "198.51.100.1", 200, false)),
                "same addr is deduped");
        assert_eq!(map.lock().get(&Region::Europe).map(|v| v.len()), Some(1));

        // Fill past the cap with distinct addresses; the region never exceeds it.
        for i in 0..(MAX_REGIONAL_PEERS_PER_REGION + 64) {
            let ip = format!("198.51.{}.{}", 100 + i / 200, 2 + (i % 200));
            SimplifiedP2P::push_regional_peer(&map, fixture_peer(&format!("p{}", i), &ip, 1000 + i as u64, false));
        }
        let region_len = map.lock().get(&Region::Europe).map(|v| v.len()).unwrap_or(0);
        assert_eq!(region_len, MAX_REGIONAL_PEERS_PER_REGION, "region is hard-capped");
        // The oldest candidate is the one evicted.
        assert!(!map.lock().get(&Region::Europe).unwrap().iter().any(|p| p.addr == "198.51.100.1:8001"),
                "oldest candidate evicted first");
    }

    /// A candidate an inbound gate is about to refuse must not cost a live peer its slot,
    /// or repeated refused attempts drain the table down to the pinned set.
    #[test]
    fn gate_rejected_candidate_evicts_nothing() {
        let node = SimplifiedP2P::new("test_gate_node".into(), NodeType::Super, Region::Europe, 8001);

        // Fill the table to the global cap directly: add_peer_lockfree's own K-bucket rule would
        // stop long before 1000, and what is under test is behaviour AT the cap.
        for i in 0..MAX_CONNECTED_PEERS {
            let (a, b) = ((i / 250) as u8, (i % 250) as u8);
            let p = if i < 2 {
                fixture_peer(&format!("inb{}", i), &format!("203.0.113.{}", i + 1), 5000 + i as u64, false)
            } else {
                fixture_peer(&format!("out{}", i), &format!("198.{}.{}.7", 20 + a, b + 1), 5000 + i as u64, true)
            };
            node.peer_id_to_addr.insert(p.id.clone(), p.addr.clone());
            node.connected_peers_lockfree.insert(p.addr.clone(), p);
        }
        assert_eq!(node.connected_peers_lockfree.len(), MAX_CONNECTED_PEERS);
        let before: std::collections::HashSet<String> =
            node.connected_peers_lockfree.iter().map(|e| e.key().clone()).collect();

        // Third inbound peer from 203.0.113.0/24: refused by the subnet-diversity cap.
        let refused = fixture_peer("attacker", "203.0.113.9", 9_000, false);
        assert!(!node.add_peer_lockfree(refused), "subnet-capped candidate is refused");
        let after: std::collections::HashSet<String> =
            node.connected_peers_lockfree.iter().map(|e| e.key().clone()).collect();
        assert_eq!(before, after, "a refused candidate evicted nobody");

        // A candidate that IS admissible still pays the LRU eviction: the cap holds, oldest goes.
        let admitted = fixture_peer("chosen", "198.19.19.19", 9_001, true);
        assert!(node.add_peer_lockfree(admitted), "outbound candidate admitted at cap");
        assert_eq!(node.connected_peers_lockfree.len(), MAX_CONNECTED_PEERS, "cap holds");
        assert!(node.connected_peers_lockfree.contains_key("198.19.19.19:8001"));
        assert!(!node.connected_peers_lockfree.contains_key("203.0.113.1:8001"),
                "oldest non-pinned peer is the one evicted");
    }

    /// A zeroed (banned/jailed) Super with a matching committed endpoint passes the identity
    /// binding, so the reputation floor is the only thing left to refuse it: it must see the
    /// committed score, never the parser's placeholder.
    #[test]
    fn inbound_reputation_floor_refuses_a_zeroed_peer() {
        let node = SimplifiedP2P::new("test_rep_node".into(), NodeType::Super, Region::Europe, 8001);
        let mut zeroed = fixture_peer("super_zeroed", "198.51.100.42", 1, false);
        zeroed.reputation = 0.0;
        zeroed.consensus_score = 0.0;
        assert!(!node.add_peer_lockfree(zeroed), "reputation below the inbound floor is refused");
        // The parser's placeholder is above the floor, which is exactly why the gossip paths must
        // overwrite it with the committed value before calling in.
        assert!(qnet_consensus::deterministic_reputation::INITIAL_REPUTATION >= MIN_INBOUND_PEER_REPUTATION);
    }

    /// The gossip paths resolve the score through get_node_reputation_from_blockchain, so that
    /// helper must actually read the committed tombstone: while it returned a constant floor,
    /// every reputation gate in the file was structurally unreachable.
    #[test]
    fn committed_tombstone_resolves_to_zero_reputation() {
        use qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
        if crate::node::try_get_state().is_none() {
            crate::node::init_global_state(std::sync::Arc::new(
                tokio::sync::RwLock::new(qnet_state::State::new()),
            ));
        }
        // Insert into whichever applied-state map is installed, so the test is independent of
        // who won the process-wide OnceCell.
        let state = crate::node::try_get_state().expect("applied state installed");
        {
            let guard = state.try_read().expect("applied state uncontended in tests");
            let mut banned = qnet_state::Account::new("super_tombstoned".to_string());
            banned.banned_at_height = 7;
            guard.accounts.insert("super_tombstoned".to_string(), banned);
            guard.accounts.insert(
                "super_clean".to_string(),
                qnet_state::Account::new("super_clean".to_string()),
            );
        }

        let node = SimplifiedP2P::new("test_tomb_node".into(), NodeType::Super, Region::Europe, 8001);
        assert_eq!(node.get_node_reputation_from_blockchain("super_tombstoned"), 0.0,
                   "a tombstoned account reads as zero");
        assert_eq!(node.get_node_reputation_from_blockchain("super_clean"), INITIAL_REPUTATION,
                   "an un-banned account reads the floor");

        // And the inbound gate then refuses it, which is the point of resolving the real score.
        let mut peer = fixture_peer("super_tombstoned", "198.51.100.77", 1, false);
        peer.reputation = node.get_node_reputation_from_blockchain(&peer.id);
        peer.consensus_score = peer.reputation;
        assert!(!node.add_peer_lockfree(peer), "a tombstoned peer is refused by the inbound floor");
    }

    /// A peer_id_to_addr row whose peer table entry is gone is a DANGLING INDEX, not a connection.
    /// While the dedup treated it as "already connected", any identity that ever lost its entry
    /// outside remove_peer_lockfree — an inbound QUIC handshake, a rebalance drop — became
    /// permanently unadmittable, and every directed send kept routing to the dead address.
    #[test]
    fn a_dangling_id_index_does_not_lock_a_peer_out() {
        let node = SimplifiedP2P::new("test_dangle_node".into(), NodeType::Super, Region::Europe, 8001);

        let p = fixture_peer("super_dangle", "198.51.100.55", 42, true);
        assert!(node.add_peer_lockfree(p.clone()), "first admission");
        assert_eq!(node.get_peer_address_by_id("super_dangle").as_deref(), Some("198.51.100.55:8001"));

        // Orphan the index the way a bare map delete used to: entry gone, id → addr left behind.
        node.connected_peers_lockfree.remove(&p.addr);
        assert!(node.peer_id_to_addr.contains_key("super_dangle"), "index is now dangling");

        // Readmission at the SAME address, and at a new one, must both succeed.
        assert!(node.add_peer_lockfree(p.clone()), "readmitted over a dangling index");
        node.remove_peer_lockfree(&p.addr);
        assert!(!node.peer_id_to_addr.contains_key("super_dangle"),
                "the only remover clears the id index with the entry");

        let moved = fixture_peer("super_dangle", "198.51.100.56", 43, true);
        assert!(node.add_peer_lockfree(moved.clone()));
        node.connected_peers_lockfree.remove(&moved.addr);
        let relocated = fixture_peer("super_dangle", "198.51.100.57", 44, true);
        assert!(node.add_peer_lockfree(relocated.clone()), "readmitted at a new address");
        assert_eq!(node.get_peer_address_by_id("super_dangle").as_deref(), Some("198.51.100.57:8001"));

        // A LIVE duplicate is still deduped — the fix must not turn the dedup off.
        let dup = fixture_peer("super_dangle", "198.51.100.58", 45, true);
        assert!(!node.add_peer_lockfree(dup), "a live entry at the mapped address still dedups");
    }
}

#[cfg(test)]
mod attestation_admission_tests {
    use super::*;

    /// The gates that keep an attestation flood cheap for us and costly for the sender: a replay is
    /// refused before the ~5ms verify, and the per-height hash cap stops unbounded map keys — the
    /// exact hole that forced this mechanism off before.
    #[test]
    fn replays_and_hash_floods_are_refused_before_the_verify() {
        let h = 9_000_001u64;               // distinct height: the store is process-wide
        let a = |n: u8| { let mut x = [0u8; 32]; x[0] = n; x };

        assert!(attestation_admissible(h, &a(1), "n1"), "a fresh attester must be admissible");
        record_block_attestation(h, a(1), "n1".to_string());
        assert!(!attestation_admissible(h, &a(1), "n1"), "a replay must be refused before verify");
        assert!(attestation_admissible(h, &a(1), "n2"), "a second attester on one hash is fine");

        for n in 2..=MAX_ATTESTED_HASHES_PER_HEIGHT as u8 {
            assert!(attestation_admissible(h, &a(n), "n1"));
            record_block_attestation(h, a(n), "n1".to_string());
        }
        assert!(!attestation_admissible(h, &a(99), "n1"),
                "a fresh hash past the per-height cap must be refused");
    }
}

#[cfg(test)]
mod attest_heartbeat_tests {
    use super::*;

    /// One line per rotation window per half. Keying the heartbeat on a fixed height always landed
    /// on one slot, so a single committee member printed it and the loop looked dead everywhere else.
    #[test]
    fn the_heartbeat_fires_once_per_window_and_the_halves_are_independent() {
        let w = 900_000u64 * crate::node::ROTATION_INTERVAL_BLOCKS;
        assert!(attest_heartbeat_due(w + 1, true), "first height of a window must fire");
        assert!(!attest_heartbeat_due(w + 2, true), "same window must not fire twice");
        assert!(!attest_heartbeat_due(w + crate::node::ROTATION_INTERVAL_BLOCKS, true),
                "still the same window");
        assert!(attest_heartbeat_due(w + crate::node::ROTATION_INTERVAL_BLOCKS + 1, true),
                "the next window must fire again");
        // The receive half tracks its own window, so one side cannot silence the other.
        assert!(attest_heartbeat_due(w + 1, false), "receive half is independent");
    }
}

#[cfg(test)]
mod tests_failover_slot_key {
    use super::*;

    /// Forensic h=169830. The failover round is keyed by macroblock window (h/90) while a leader
    /// tenure is 30 blocks; 90 = 3 x 30, so every window rollover lands on the LAST slot of a
    /// tenure. Keying that slot on the fresh window read round 0 and re-elected the leader the
    /// network had already skipped for 29 consecutive slots — one un-skippable slot, and the chain
    /// stopped there. The round must follow the tenure across the boundary.
    /// Windows far from any other test's keys, and only this test's own entries are touched:
    /// the maps are process-global and the harness runs tests in parallel threads.
    const W0: u64 = 900_000;         // tenure begins here
    const H_MID: u64 = W0 * 90 - 1;  // mid-tenure slot, own window
    const H_BOUNDARY: u64 = W0 * 90; // last slot of the tenure, first of the next window
    const H_NEXT: u64 = W0 * 90 + 1; // fresh tenure in the new window

    #[test]
    fn a_tenure_keeps_its_certified_round_across_a_window_boundary() {
        let _guard = TEST_FAILOVER_STATE_LOCK.lock();
        HIGHEST_CERTIFIED_ROUND.insert(W0 - 1, 3); // the round the network rotated onto
        assert_eq!(certified_round_for_slot(H_MID), 3, "mid-tenure slot, own window");
        assert_eq!(certified_round_for_slot(H_BOUNDARY), 3,
                   "last slot of the tenure: the boundary must not discard the certified skip");
        // A NEW tenure starting in the new window is not entitled to the old round.
        assert_eq!(certified_round_for_slot(H_NEXT), 0, "fresh tenure, fresh window");
        // The election and the ingest gate must agree on that slot, or the block is refused.
        assert!(failover_round_authorized_for_slot(H_BOUNDARY, 3, 0),
                "the block the carried round elects is authorised by the same rule");
        assert!(!failover_round_authorized_for_slot(H_BOUNDARY, 4, 0), "an uncertified round is still refused");

        // Applying that boundary block records its absolute round as the NEW window's baseline.
        // The next slot must still be able to stamp it, or the repair just moves the halt one slot.
        LAST_FINALIZED_ROUND_PER_MB.insert(W0, 3);
        let (rel, carried) = rotation_round_and_baseline_for_slot(H_NEXT);
        assert_eq!(rel.saturating_add(carried), 0,
                   "a fresh tenure stamps its own round, not the one carried into the window");
        assert!(failover_round_authorized_for_slot(H_NEXT, rel, carried),
                "the block the next slot stamps is authorised by every honest node");
        // The ceiling must stay a function of CERTIFIED state only: a restarted peer, whose apply
        // baseline is empty, has to compute the same answer.
        assert_eq!(certified_round_for_slot(H_NEXT), 0, "the apply baseline never raises the ceiling");

        HIGHEST_CERTIFIED_ROUND.remove(&(W0 - 1));
        LAST_FINALIZED_ROUND_PER_MB.remove(&W0);
    }

    /// Both operands are certificate-driven, so the carry cannot invent a round: with nothing
    /// certified anywhere the slot stays at 0 and the round-0 leader is elected as usual.
    #[test]
    fn the_carry_never_invents_a_round() {
        let _guard = TEST_FAILOVER_STATE_LOCK.lock();
        // Untouched windows: nothing certified anywhere, so every slot stays at round 0.
        assert_eq!(certified_round_for_slot(800_000 * 90), 0);
        assert_eq!(certified_round_for_slot(800_000 * 90 + 1), 0);
        assert_eq!(certified_round_for_slot(800_001 * 90 - 1), 0);
    }
}

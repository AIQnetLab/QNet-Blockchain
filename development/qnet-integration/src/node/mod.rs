//! Blockchain node implementation
mod lifecycle;
mod production;
mod monitoring;
mod activation;
mod sync;
mod transactions;
mod consensus;
mod leader;
mod registration;
mod committee;
mod state_apply;

mod rewards;

/// Concatenated source of every file in this module. Source-scanning invariant tests use it
/// so a method moving between submodules cannot silently disarm them.
#[cfg(test)]
/// The file list `node_sources` concatenates, exposed so a test can compare it against the
/// directory on disk.
#[cfg(test)]
pub(crate) fn node_sources_manifest() -> &'static [&'static str] {
    &["mod.rs", "activation.rs", "committee.rs", "consensus.rs", "leader.rs", "lifecycle.rs",
      "monitoring.rs", "production.rs", "registration.rs", "rewards.rs", "state_apply.rs",
      "sync.rs", "transactions.rs"]
}

#[cfg(test)]
pub(crate) fn node_sources() -> String {
    [
        include_str!("mod.rs"),
        include_str!("activation.rs"),
        include_str!("committee.rs"),
        include_str!("consensus.rs"),
        include_str!("leader.rs"),
        include_str!("lifecycle.rs"),
        include_str!("monitoring.rs"),
        include_str!("production.rs"),
        include_str!("registration.rs"),
        include_str!("rewards.rs"),
        include_str!("state_apply.rs"),
        include_str!("sync.rs"),
        include_str!("transactions.rs"),
    ].concat()
        // include_str! keeps the checkout's line endings, and git rewrites them on Windows. The
        // scanners below match multi-line patterns, so normalise once here rather than have a
        // source-shape assertion depend on how the tree happens to be checked out.
        .replace("
", "
")
}

pub(crate) use crate::{
    errors::QNetError,
    storage::Storage,
    // validator::Validator, // disabled for compilation
    unified_p2p::{SimplifiedP2P, NodeType as UnifiedNodeType, Region as UnifiedRegion, NetworkMessage, BlockExistenceResult},
};

// PROTOCOL VERSION for compatibility checks
pub const PROTOCOL_VERSION: u32 = 1;  // Increment when breaking changes are made
pub const MIN_COMPATIBLE_VERSION: u32 = 1;  // Minimum version we can work with

// v15.15: BFT scaling — single source of truth for committee size N.
// Two-tier: microblocks (1s, single-producer ML-DSA-65, rotate every
// ROTATION_INTERVAL_BLOCKS); macroblocks (every 90, n−f Checkpoint-BFT QC =
// finality). Threshold on every path = checkpoint_bft::quorum_size(N) = N − f
// with f = floor((N-1)/3); it equals 2f+1 only at N = 3f+1, so never write 2f+1.
// N per epoch: mb_idx<=2 -> genesis_node_count() (baked); mb_idx>=3 ->
// eligible_producers.len() of macroblock (mb_idx-2) [N-2 snapshot, strict,
// no fallback]. Eligible <= MAX_VALIDATORS=1000 = the round committee; the BFT
// committee == the VRF-capped round (COMMITTEE_SIZE==THRESHOLD==1000).
// Producer & validator MUST derive N from this same per-epoch source on
// the three agreement paths (pre-round gate / finalize_round_by_number /
// validate_macroblock) — an honest producer cannot finalize a macroblock
// an honest validator would reject.

// PRODUCTION CONSTANTS - No hardcoded magic numbers!
/// Maximum eligible producers/validators per epoch AND per consensus round.
/// Single source of truth — used in snapshot creation, candidate selection,
/// emergency fallback, and Checkpoint-BFT committee config.
/// Scales BFT to millions of nodes: only 1000 participate in voting/production.
/// See the BFT SCALING ARCHITECTURE block above for the full pipeline.
pub const MAX_VALIDATORS: usize = 1000;
pub const ROTATION_INTERVAL_BLOCKS: u64 = 30; // Producer rotation every 30 blocks
#[allow(dead_code)]
const MIN_BYZANTINE_NODES: usize = 4; // 3f+1 where f=1
const SNAPSHOT_FULL_INTERVAL: u64 = 43200; // Full snapshot every 12 hours (43,200 microblocks = 480 macroblocks)
pub const SNAPSHOT_INCREMENTAL_INTERVAL: u64 = 3600; // Incremental snapshot every 1 hour (3,600 microblocks = 40 macroblocks)
pub const SNAPSHOT_EARLY_ANCHOR_HEIGHT: u64 = 90; // First consensus-bindable boundary (mb_idx=1): a young chain has a servable snapshot well before the 3600 interval
/// Newest snapshots retained per type by cleanup_old_snapshots (single source of truth).
pub const SNAPSHOT_KEEP_COUNT: usize = 3;
/// A node behind the tip by more than this block-gap snapshot-jumps instead of block-replaying
/// (single source; both SyncManager and the legacy node.rs catch-up read it).
pub const SNAPSHOT_SYNC_SWITCH_GAP: u64 = 1_500;
/// Microblock BODIES older than this are pruned (kept: hashes + macroblocks + snapshots + state).
/// = 6 epochs (~24h). Single source; both prune sites (node.rs producer path + block_pipeline apply
/// path) read it. See prune_old_microblock_bodies (storage.rs).
pub const MICROBLOCK_BODY_RETENTION_BLOCKS: u64 = 6 * 14_400;

/// Largest macroblock a peer may expand to. At a 1000-node committee the QC is ~2.2 MB of
/// ML-DSA signatures plus ~90 KB of roster, so 16 MB is generous with room for growth.
pub const MAX_MACROBLOCK_DECOMPRESSED: usize = 16 * 1024 * 1024;

/// The operator's BIP39 mnemonic — the SAME secret as their mobile wallet.
///
/// Preferred source is a file named by `QNET_WALLET_SEED_FILE` (mode 0600): a value passed as a
/// container environment variable is readable via `docker inspect`, via `/proc/<pid>/environ`,
/// and by most log/monitoring agents. The env var still works so an existing deployment keeps
/// running; it is reported once, loudly.
///
/// Deliberately does NOT unset the variable after reading: every caller here runs on the async
/// runtime, and `setenv`/`unsetenv` are not thread-safe against a concurrent `getenv`, so
/// removing it would be undefined behaviour in a live process. Nothing is cached either — the
/// secret is read on demand and dropped, rather than held in a process-lifetime map.
pub fn load_wallet_seed(var: &str) -> Option<String> {
    if let Ok(path) = std::env::var(format!("{}_FILE", var)) {
        match std::fs::read_to_string(&path) {
            Ok(s) => {
                let seed = s.trim().to_string();
                if !seed.is_empty() {
                    return Some(seed);
                }
                println!("[WARN][SECURITY] wallet_seed_file_empty var={} path={}", var, path);
            }
            Err(e) => {
                println!("[WARN][SECURITY] wallet_seed_file_unreadable var={} path={} err={}", var, path, e);
            }
        }
    }
    match std::env::var(var) {
        Ok(seed) if !seed.trim().is_empty() => {
            static WARNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if !WARNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                println!("[WARN][SECURITY] wallet_seed_from_env var={} exposure=docker_inspect,proc_environ action=use_{}_FILE", var, var);
            }
            Some(seed.trim().to_string())
        }
        _ => None,
    }
}
/// SYNC-SAFETY INVARIANT (compile-time): a cold/lagging node never needs a pruned microblock body.
/// When it is more than SNAPSHOT_SYNC_SWITCH_GAP behind it snapshot-jumps, then block-replays only
/// the tail from the OLDEST retained snapshot to tip (≤ SNAPSHOT_KEEP_COUNT × SNAPSHOT_INCREMENTAL_
/// INTERVAL blocks). That tail — and the sub-switch-gap block-sync range — must stay INSIDE the
/// body-retention window. This const-assert turns any future change to these constants into a COMPILE
/// ERROR instead of a silent cold-join / catch-up break (e.g. lowering keep_count, raising the switch
/// gap, or shrinking retention).
const _: () = assert!(
    MICROBLOCK_BODY_RETENTION_BLOCKS > SNAPSHOT_SYNC_SWITCH_GAP
        && MICROBLOCK_BODY_RETENTION_BLOCKS > (SNAPSHOT_KEEP_COUNT as u64) * SNAPSHOT_INCREMENTAL_INTERVAL,
    "microblock-body retention must exceed both the snapshot-switch gap and the retained-snapshot span, else cold/lagging sync could need a pruned body",
);

/// Active-node count mirrored from the production loop, read O(1) off the hot apply path by the
/// snapshot-holder predicate. 0 = unknown ⇒ all-hold (a count-read gap can never make NOBODY hold).
pub static SNAPSHOT_HOLDER_ACTIVE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Which nodes MATERIALIZE the full snapshot at a boundary. Small networks (and the early h=90 anchor)
/// = every node holds (current behavior, guaranteed cold-join coverage). At scale a deterministic
/// ~1-in-SAMPLE_DENOM sample holds, rotating per snapshot interval, so storage/CPU is O(N/denom) not
/// O(N); holders advertise via latest_full_snap and joiners discover them by peer fan-out (unchanged).
pub fn should_materialize_snapshot(node_id: &str, height: u64) -> bool {
    const THRESHOLD: u64 = 50;   // ≤ this many active nodes ⇒ every node holds
    const SAMPLE_DENOM: u64 = 5; // above THRESHOLD ⇒ ~1-in-5 hold
    if height == SNAPSHOT_EARLY_ANCHOR_HEIGHT { return true; } // first anchor always universal
    let n = SNAPSHOT_HOLDER_ACTIVE_COUNT.load(std::sync::atomic::Ordering::Relaxed);
    if n <= THRESHOLD { return true; }
    use sha3::{Digest, Sha3_256};
    let mut h = Sha3_256::new();
    h.update(b"QNET_SNAP_HOLDER_V1:");
    h.update(node_id.as_bytes());
    h.update(&(height / SNAPSHOT_INCREMENTAL_INTERVAL).to_le_bytes());
    let d = h.finalize();
    u64::from_le_bytes(d[0..8].try_into().unwrap_or([0u8; 8])) % SAMPLE_DENOM == 0
}
const API_HEALTH_CHECK_RETRIES: u32 = 5; // API health check attempts
const API_HEALTH_CHECK_DELAY_SECS: u64 = 2; // Delay between health checks

// FINALITY WINDOW: Production-grade value for Byzantine safety
// CRITICAL: Blocks must be this deep to be used for deterministic entropy
// 10 blocks = 10 seconds provides safe buffer for:
// - Global network propagation delays (100-300ms intercontinental)
// - P2P block propagation (~500ms-1s)
// - Node synchronization during failover
// - Byzantine consensus coordination
pub const FINALITY_WINDOW: u64 = 10; // 10 blocks = 10 seconds (safe for production)


// CRITICAL: Module for shared producer cache to prevent duplicate static declarations
// v2.96: Using DashMap for lock-free access in hot path
mod producer_cache {
    use dashmap::DashMap;
    use once_cell::sync::Lazy;
    
    // PRODUCTION v2.96: Lock-free cache for producer selection
    // This cache stores (producer_id, candidates) per leadership round
    // DashMap provides concurrent read/write without blocking tokio runtime
    pub static CACHED_PRODUCER_SELECTION: Lazy<DashMap<u64, (String, Vec<(String, f64)>)>> = 
        Lazy::new(|| DashMap::new());
}

// PRODUCTION v4.0: Global VRF instance for static access in select_producer
// v16.2: pub so unified_p2p::handle_message can access for sync ack signing
// in the round-change ready handshake path (sync handler can't await async
// `create_consensus_signature`, raw `detached_sign` from this Arc is fast).
pub static GLOBAL_VRF_INSTANCE: parking_lot::Mutex<Option<Arc<crate::crypto::vrf::DilithiumVrf>>> =
    parking_lot::Mutex::new(None);

pub(crate) use qnet_state::{State as StateManager, MicroBlock};
pub(crate) use qnet_sharding::MAX_SHARDS;
pub(crate) use std::sync::Arc;
pub(crate) use std::collections::HashMap;
pub(crate) use tokio::sync::RwLock;
pub(crate) use hex;
pub(crate) use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Safe timestamp getter with fallback
pub fn get_timestamp_safe() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_secs()
}
pub(crate) use std::env;

// Emergency producer flag removed (non-deterministic, racy, no consensus).
// Replaced by BFT-agreed rotation: the producer is
// candidates[(base_idx + rotation_round) % N] where rotation_round is the
// strict same-round n−f BFT-certified round (HIGHEST_CERTIFIED_ROUND),
// identical on every node once signed votes are gossiped. Wall clock only
// gates WHEN to vote (capped
// 30 s under catch-up). Macroblock commit view-change reuses the same
// certified-round path — one consensus domain, one deterministic derivation.
pub(crate) use std::sync::atomic::{AtomicU64 as StdAtomicU64, Ordering as StdOrdering};
pub(crate) use parking_lot::RwLock as ParkingRwLock;

// DEPRECATED: Kept for backward compatibility, always returns None
#[allow(dead_code)]
static EMERGENCY_PRODUCER_HEIGHT: StdAtomicU64 = StdAtomicU64::new(0);
#[allow(dead_code)]
static EMERGENCY_PRODUCER_END_HEIGHT: StdAtomicU64 = StdAtomicU64::new(0);
lazy_static::lazy_static! {
    static ref EMERGENCY_PRODUCER_ID: ParkingRwLock<String> = ParkingRwLock::new(String::new());
}

/// DEPRECATED v4.0: Use BFT Timeout Protocol instead
#[deprecated(since = "4.0.0", note = "Use BFT Timeout Protocol for failover")]
#[allow(dead_code)]
pub fn set_emergency_producer_flag(_block_height: u64, _producer: String) {
    // DEPRECATED v4.0: No-op, use BFT Timeout Protocol instead
    if is_debug() {
        println!("[DBG][DEPRECATED] set_emergency_producer_flag called but ignored");
    }
}

/// DEPRECATED v4.0: Always returns None, use BFT Timeout Protocol instead
#[deprecated(since = "4.0.0", note = "Use BFT Timeout Protocol for failover")]
pub fn get_emergency_producer() -> Option<(u64, String)> {
    // DEPRECATED v4.0: Always returns None
    // Failover now handled by BFT Timeout Protocol (certified_timeout_round)
    None
}

/// DEPRECATED v4.0: Always returns 0
#[deprecated(since = "4.0.0", note = "Use BFT Timeout Protocol for failover")]
#[allow(dead_code)]
pub fn get_emergency_end_height() -> u64 {
    0
}

/// DEPRECATED v4.0: No-op
#[deprecated(since = "4.0.0", note = "Use BFT Timeout Protocol for failover")]
#[allow(dead_code)]
pub fn clear_emergency_producer() {
    // DEPRECATED v4.0: No-op
}

// ═══════════════════════════════════════════════════════════════════════════════
// v3.6: REMOVED FAILED_PRODUCERS_FOR_BLOCK - IT CAUSED NON-DETERMINISTIC FORKS!
// ═══════════════════════════════════════════════════════════════════════════════
// PROBLEM: Each node had DIFFERENT local failed producers list because:
//   1. Different nodes detected timeouts at DIFFERENT times (network delays)
//   2. Different lists → Different candidate filtering → Different emergency producers
//   3. RESULT: FORK when two nodes select themselves as emergency!
//
// SOLUTION: Use ONLY the deterministic failed_producer parameter passed to
// select_emergency_producer(). This value comes from the emergency message
// which is the SAME for all nodes. If emergency producer also fails:
//   1. New emergency message with IT as failed_producer
//   2. All nodes receive SAME message → Select SAME next producer → NO FORK
// ═══════════════════════════════════════════════════════════════════════════════

// Coordinator FSM (GLOBAL_COORDINATOR.snapshot()) is the authoritative sync state.
pub(crate) use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
// Read cross-file by storage.rs to WAL-disable the bulk-apply fast-path (perf only; on is safe).
pub static FAST_SYNC_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Signed NodeRegistration awaiting on-chain inclusion: (node_id, tx_bytes, backoff_tick, attest_epoch).
/// The periodic loop rebroadcasts it (burst then trickle, field 3 is the backoff tick) so a join-time
/// broadcast dropped while poorly connected still reaches a producer, scaling to thousands of joiners.
/// Field 4 is the epoch the embedded burn attestations bind — the convergence driver's re-arm edge
/// (re-collect when current_epoch >= attest_epoch + MAX_ATTEST_EPOCH_LAG, i.e. the bytes went
/// verifier-stale). Cleared when is_node_registration_onchain becomes true. The driver is the SOLE
/// arm/re-arm writer; the rebroadcast loop keeps an idempotent on-chain clear.
pub static PENDING_NODE_REGISTRATION: std::sync::Mutex<Option<(String, Vec<u8>, u32, u64)>> =
    std::sync::Mutex::new(None);

/// Max deficit (strict corroborated ceiling − local tip) at arm time. attest_epoch is pinned at
/// quorum completion, so the lag-2 verifier window (180 blocks) starts there; 45 leaves the
/// inclusion lane (backlog<800 draining 8/block ⇒ <100 blocks) inside it with margin.
pub(crate) const DEFICIT_BOUND: u64 = 45;
const REG_DRIVER_DEFER_SECS: u64 = 15;      // gate-defer poll (cheap checks only)
const REG_DRIVER_COOLDOWN_SECS: u64 = 90;   // >=1 epoch between collect attempts (serial 30s reqwest)
const ARM_TIER2_AT_SECS: u64 = 270;         // strict-starved time before the widened tier engages
const WC_DEFER_MAX: u32 = 8;                // consecutive widened-defers before the bounded fail-open

/// Driver-local arm-ladder state (strict-starvation clock + widened-defer counter + dial pacing).
#[derive(Default)]
pub(crate) struct ArmLadderState {
    strict_zero_since: Option<std::time::Instant>,
    wc_defers: u32,
    last_dial: Option<std::time::Instant>,
}

/// Fail-closed registration arm gate + anti-livelock ladder.
/// T1 coordinator_is_production_ready — necessary but fails open alone (Synchronized{0}); T2+T3
/// carry the fix. T2 strict corroborated ceiling (unified_p2p::corroborated_head_ceiling — the
/// (f+1)-th highest fresh in-set height, un-floored): 0 ⇒ unknown ⇒ ladder, never arm blind.
/// T3 local within DEFICIT_BOUND of that ceiling. Ladder when strict starves: Tier-1.5 dials the
/// exact in-set predicate set to earn corroborators; Tier-2 consults the quarantined widened
/// ceiling (Sybil-capped, forged-high clamped) floored at the genesis-verified GALC capsule; after
/// WC_DEFER_MAX widened-only defers the gate fails OPEN into a throttled arm — the attestor-side
/// epoch bound is the authoritative arbiter, so the worst adversarial outcome is a bounded number
/// of refused arms, never indefinite denial and never a forged registration.
fn registration_arm_gate(ladder: &mut ArmLadderState) -> bool {
    if !coordinator_is_production_ready() { return false; }
    let p2p = match try_get_p2p() { Some(p) => p, None => return false };
    let local = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire);
    let ceiling = p2p.corroborated_head_ceiling();
    if ceiling > 0 {
        ladder.strict_zero_since = None;
        ladder.wc_defers = 0;
        if ceiling > local.saturating_add(DEFICIT_BOUND) {
            if is_info() { println!("[INFO][REG] arm_defer reason=behind local={} ceiling={}", local, ceiling); }
            return false;
        }
        return true;
    }
    let since = *ladder.strict_zero_since.get_or_insert_with(std::time::Instant::now);
    // Dial pacing: unreachable in-set addrs must not be re-fed every defer tick (the regional
    // dial pipeline has no dedup for never-connecting peers) — at most one dial per Tier-2 window.
    if ladder.last_dial.map_or(true, |t| t.elapsed().as_secs() >= ARM_TIER2_AT_SECS) {
        ladder.last_dial = Some(std::time::Instant::now());
        p2p.dial_in_set_for_arm();
    }
    if since.elapsed().as_secs() < ARM_TIER2_AT_SECS {
        if is_info() { println!("[INFO][REG] arm_defer reason=strict_starved tier=1.5 elapsed={}s", since.elapsed().as_secs()); }
        return false;
    }
    let wc = p2p.corroborated_head_ceiling_widened(local);
    // Capsule macroblock index → height (blocks per macroblock).
    let capsule_floor = crate::galc::effective_pin_checkpoint().0
        .saturating_mul(qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL);
    let evidence = wc.0.max(capsule_floor);
    if evidence <= local.saturating_add(crate::unified_p2p::DEFICIT_BOUND_WIDE) {
        // Strict is STILL starved — keep the Tier-2 clock running so a failed arm attempt
        // re-enters at Tier-2 directly (not another full Tier-1.5 wait).
        ladder.wc_defers = 0;
        return true;
    }
    ladder.wc_defers += 1;
    if ladder.wc_defers >= WC_DEFER_MAX {
        println!("[WARN][REG] arm_gate_fail_open defers={} local={} widened={} capsule_floor={}",
                 WC_DEFER_MAX, local, wc.0, capsule_floor);
        ladder.wc_defers = 0;
        return true;
    }
    if is_info() {
        println!("[INFO][REG] arm_defer reason=widened_deficit tier=2 local={} evidence={} defers={}",
                 local, evidence, ladder.wc_defers);
    }
    false
}

// ═══════════════════════════════════════════════════════════════════════════════
// L1 ARCHITECTURE: Global coordinator handle for phase-aware decisions
// Set once during node startup, read from anywhere.
// ═══════════════════════════════════════════════════════════════════════════════
lazy_static::lazy_static! {
    pub static ref GLOBAL_COORDINATOR: parking_lot::RwLock<Option<crate::consensus_state::CoordinatorHandle>> =
        parking_lot::RwLock::new(None);
}

/// Check if node is synchronized via the coordinator FSM — the single source of
/// truth. Before the coordinator is installed during boot the node is, by
/// definition, not yet synchronized.
#[inline]
pub fn coordinator_is_synchronized() -> bool {
    if let Some(ref handle) = *GLOBAL_COORDINATOR.read() {
        handle.snapshot().is_synchronized()
    } else {
        false
    }
}

/// Check if node is syncing via the coordinator FSM (the single source of truth).
#[inline]
pub fn coordinator_is_syncing() -> bool {
    if let Some(ref handle) = *GLOBAL_COORDINATOR.read() {
        handle.snapshot().is_syncing()
    } else {
        // No coordinator installed yet (pre-boot): the FSM is the only sync source of truth,
        // so nothing is syncing before it exists. The production hard-gate still holds output.
        false
    }
}

/// Check if node is ready for production via coordinator.
#[inline]
pub fn coordinator_is_production_ready() -> bool {
    if let Some(ref handle) = *GLOBAL_COORDINATOR.read() {
        handle.snapshot().is_production_ready()
    } else {
        false
    }
}

/// Current sync target height from the coordinator FSM. Returns the Syncing
/// phase target_height, else 0 (not syncing). Single source of truth — the
/// verify path reads this for the "consensus-confirmed below target" gate.
#[inline]
pub fn coordinator_sync_target() -> u64 {
    if let Some(ref handle) = *GLOBAL_COORDINATOR.read() {
        match handle.snapshot().phase {
            crate::consensus_state::ConsensusPhase::Syncing { target_height, .. } => target_height,
            _ => 0,
        }
    } else {
        0
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// v3.10: FORK PREVENTION - 4 Critical Bug Fixes
// ═══════════════════════════════════════════════════════════════════════════════
// BUG 1: Block not received after consensus - need to request it
// BUG 2: Production without sufficient consensus (votes < 40%)
// BUG 3: Forked node spam blocks emergency recovery
// BUG 4: Fork detection doesn't work for invalid blocks
// ═══════════════════════════════════════════════════════════════════════════════

// BUG 1 FIX: Track blocks awaiting after consensus passed
// Key: block_height, Value: (consensus_time, producer_id, requested_count)
lazy_static::lazy_static! {
    static ref CONSENSUS_AWAITING_BLOCK: ParkingRwLock<std::collections::HashMap<u64, (std::time::Instant, String, u16)>> =
        ParkingRwLock::new(std::collections::HashMap::new());
}

/// BUG 1: Register that consensus passed for block, now waiting for data
/// CRITICAL FIX: Use entry().or_insert() to preserve existing timer and retry count.
/// Previous code used insert() which reset Instant::now() and request_count=0 every
/// loop iteration, preventing the 8-second timeout from ever firing.
pub fn register_consensus_awaiting_block(height: u64, producer: &str) {
    let mut awaiting = CONSENSUS_AWAITING_BLOCK.write();
    let is_new = !awaiting.contains_key(&height);
    awaiting.entry(height).or_insert_with(|| (std::time::Instant::now(), producer.to_string(), 0));
    if is_new && is_info() {
        println!("[INFO][CONS] awaiting_block h={} producer={}", height, producer);
    }
}

/// BUG 1: Mark block as received (remove from awaiting)
pub fn mark_block_received(height: u64) {
    let mut awaiting = CONSENSUS_AWAITING_BLOCK.write();
    if awaiting.remove(&height).is_some() {
        if is_debug() {
            println!("[DBG][CONS] block_received h={}", height);
        }
    }
}

/// BUG 1: Check if any blocks are awaiting for too long and need request
/// Returns list of (height, producer) pairs that need to be requested
pub fn get_blocks_needing_request(timeout_secs: u64) -> Vec<(u64, String)> {
    let mut awaiting = CONSENSUS_AWAITING_BLOCK.write();
    let mut need_request = Vec::new();
    let mut to_remove = Vec::new();
    
    for (height, (time, producer, request_count)) in awaiting.iter_mut() {
        if time.elapsed().as_secs() >= timeout_secs {
            // Max 5 requests per block
            if *request_count < 5 {
                need_request.push((*height, producer.clone()));
                *request_count += 1;
                *time = std::time::Instant::now(); // Reset timer
                if is_warn() {
                    println!("[WARN][CONS] block_timeout h={} producer={} retry={}", 
                             height, producer, request_count);
                }
            } else {
                // Too many retries - give up and mark for removal
                to_remove.push(*height);
                println!("[ERR][CONS] block_request_failed h={} producer={} max_retries", 
                         height, producer);
            }
        }
    }
    
    // Remove blocks that exceeded retry limit
    for h in to_remove {
        awaiting.remove(&h);
    }
    
    need_request
}

// BUG 3 FIX: Track excluded/forked producers (lock-free with timestamp)
// Key: producer_id, Value: (excluded_at, reason, excluded_until_height)
lazy_static::lazy_static! {
    static ref EXCLUDED_PRODUCERS: ParkingRwLock<std::collections::HashMap<String, (std::time::Instant, String, u64)>> = 
        ParkingRwLock::new(std::collections::HashMap::new());
}

/// BUG 3: Mark producer as excluded (blocks from them will be ignored)
pub fn exclude_producer(producer_id: &str, reason: &str, until_height: u64) {
    let mut excluded = EXCLUDED_PRODUCERS.write();
    excluded.insert(
        producer_id.to_string(), 
        (std::time::Instant::now(), reason.to_string(), until_height)
    );
    println!("[INFO][FORK] producer_excluded id={} reason={} until_h={}", 
             producer_id, reason, until_height);
}

/// BUG 3: Check if producer is currently excluded
pub fn is_producer_excluded(producer_id: &str, current_height: u64) -> bool {
    let excluded = EXCLUDED_PRODUCERS.read();
    if let Some((_, _, until_height)) = excluded.get(producer_id) {
        if current_height < *until_height {
            return true;
        }
    }
    false
}

/// BUG 3: Clear expired exclusions
pub fn clear_expired_exclusions(current_height: u64) {
    let mut excluded = EXCLUDED_PRODUCERS.write();
    excluded.retain(|_, (_, _, until_height)| current_height < *until_height);
}

/// v9.5: Fork recovery cooldown — prevents spamming sync_macroblocks when fork detection
/// triggers repeatedly. Without this, 30000 nodes simultaneously forking would each
/// spam macroblock requests every consensus tick (1s), overwhelming the network.
/// Cooldown: 60 seconds between fork recovery attempts.
static LAST_FORK_RECOVERY: StdAtomicU64 = StdAtomicU64::new(0);
const FORK_RECOVERY_COOLDOWN_SECS: u64 = 60;

/// v9.5: Check if fork recovery is allowed (respects cooldown)
/// Uses compare_exchange to prevent TOCTOU race (multiple concurrent triggers)
pub fn try_fork_recovery() -> bool {
    let now = get_timestamp_safe();
    let last = LAST_FORK_RECOVERY.load(StdOrdering::Acquire);
    if now.saturating_sub(last) >= FORK_RECOVERY_COOLDOWN_SECS {
        // Atomic CAS: only one thread wins the race
        LAST_FORK_RECOVERY.compare_exchange(
            last, now, StdOrdering::Release, StdOrdering::Relaxed
        ).is_ok()
    } else {
        false
    }
}

/// BUG 4 FIX: Last runtime fork check timestamp
static LAST_FORK_CHECK: StdAtomicU64 = StdAtomicU64::new(0);

/// BUG 4: Check if runtime fork detection is needed (every 30 seconds)
/// Uses compare_exchange to prevent TOCTOU race
pub fn should_check_fork() -> bool {
    let now = get_timestamp_safe();
    let last = LAST_FORK_CHECK.load(StdOrdering::Acquire);
    if now.saturating_sub(last) >= 30 {
        LAST_FORK_CHECK.compare_exchange(
            last, now, StdOrdering::Release, StdOrdering::Relaxed
        ).is_ok()
    } else {
        false
    }
}

// QC-verified finality frontier (height = highest macroblock whose n−f QC this node verified ×90).
// The cold-join sync target floors on THIS, never a peer-reported median: a self-reported height is
// unauthenticated, so averaging it can't be a trust anchor and on a fresh joiner the honest sample is
// stale-low → the node would stop below the real tip. The frontier is unforgeable (raising it needs a
// valid n−f Dilithium QC under the embedded genesis committee). 0 before the first macroblock (h<90)
// ⇒ callers fall back to the capped near-tip hint, so the genesis bootstrap is never blocked.
static QC_VERIFIED_FRONTIER: AtomicU64 = AtomicU64::new(0);

// Content-verified finality ceiling (height = highest macroblock index ×90 whose every local body hash
// matches its QC-certified list, contiguously from the anchor). QC_VERIFIED_FRONTIER certifies a
// macroblock's OWN n−f QC but NOT that this node holds the matching microblock BODIES; a node with a
// losing-fork tail below the frontier must not adopt-finalize over it (the node-001 h=30780 safety
// violation). SYNC-ADOPT floors on THIS. Monotone; re-derived from storage, bounded per advance call.
static CONTENT_VERIFIED_FRONTIER: AtomicU64 = AtomicU64::new(0);

// v3.5: Flag to skip slot timing after sync completion
// PROBLEM: After sync, node may be "ahead" of slot time and wait unnecessarily
// while network expects block from it immediately
// SOLUTION: Skip slot timing wait on first block after sync if we're producer
static JUST_COMPLETED_SYNC: AtomicBool = AtomicBool::new(false);

/// v9.0: Progress-based sync timeout. Updated on each synced block.
/// Deadlock = no progress for 120s (instead of fixed 300s cap).
pub static LAST_SYNC_PROGRESS_TIME: AtomicU64 = AtomicU64::new(0);

// BFT-driven microblock rotation round. timeout_round_for_rotation =
// HIGHEST_CERTIFIED_ROUND[mb_idx] (signed same-round n−f TC) from
// ML-DSA-65-verified gossip, so a catch-up node sees the same round as
// the network and elects the same producer. Wall clock is NEVER in the
// rotation formula (a wall-clock ((now-parent_ts)) term caused the h=339
// catch-up fork: high rank cycles to self → 2nd block at the same height).
// Wall clock only: local_delay (when to broadcast TimeoutVote; capped
// 30s pre-PRODUCTION_UNLOCKED) + stall diagnostics. CURRENT_TIMEOUT_
// ROUND caches the value; reset to 0 on tip advance.

/// v19: TELEMETRY-ONLY snapshot of the rotation round most recently observed
/// by the stall-detection loop. Once read by producer selection / block
/// construction; that consensus path now reads `get_highest_certified_round`
/// directly to avoid the per-tip-advance reset race that briefly returned 0
/// while the network was still at a non-zero BFT-certified round.
///
/// Kept for: status RPC (`current_timeout_round`), debug logs, telemetry
/// metrics. Setting / resetting it is side-effect-free with respect to
/// consensus correctness.
static CURRENT_TIMEOUT_ROUND: AtomicU64 = AtomicU64::new(0);

/// Height for which `CURRENT_TIMEOUT_ROUND` was last set. Informational;
/// `reset_timeout_round` clears the round value on every tip advance.
#[allow(dead_code)]
static TIMEOUT_ROUND_HEIGHT: AtomicU64 = AtomicU64::new(0);

/// Read the most recently observed BFT rotation round.
/// v19: TELEMETRY-ONLY. Consensus paths (producer selection, block
/// construction) read `get_highest_certified_round(mb_index)` directly
/// from `SimplifiedP2P` instead — that is the same DashMap the stall
/// detector itself reads, with no oscillation under tip-advance races.
pub fn get_current_timeout_round() -> u64 {
    CURRENT_TIMEOUT_ROUND.load(Ordering::SeqCst)
}

/// Update the telemetry snapshot of the current rotation round. Called by
/// the stall-detection loop after re-reading `certified_timeout_round`.
/// v19: stored value is no longer authoritative for producer selection.
pub fn set_timeout_round(round: u64, height: u64) {
    CURRENT_TIMEOUT_ROUND.store(round, Ordering::SeqCst);
    TIMEOUT_ROUND_HEIGHT.store(height, Ordering::SeqCst);
}

/// Clear the telemetry snapshot on tip advance.
/// v19: this no longer affects consensus — producer selection reads the
/// n−f BFT-certified round directly. The reset is preserved so that
/// status / debug logs do not stale-display a previous slot's round.
pub fn reset_timeout_round() {
    CURRENT_TIMEOUT_ROUND.store(0, Ordering::SeqCst);
}

// v23: BFT-certified microblock leader rotation (canonical L1). leader(h)
// is a PURE function of finalised on-chain state:
//   select_microblock_producer_with_round(h,
//     candidates=eligible_producers(macroblock N-2),
//     vrf_entropy=SHA3(macroblock(N-2).deterministic_fields),
//     leadership_round=(h-1)/ROTATION_INTERVAL_BLOCKS,
//     timeout_round=get_certified_rotation_round(h/90))
// timeout_round advances ONLY on a same-round n−f ML-DSA-65 TimeoutCertificate;
// wall clock is NEVER a leader-selection input → identical
// leader on every honest node (no NTP-drift dual-production split; the
// v22 clock-derived seed that caused it is gone). Liveness: silent
// primary → n−f TimeoutVote → certified round advances same on all →
// bounded recovery ≈ grace + 1 RTT. O(1). Macroblock Checkpoint-BFT QC = final.


// Runtime clock-drift monitor. On each applied network block observe
// drift = local_now - block.timestamp (producer-signed wall clock, n−f-
// agreed median). Track EMA of |drift|: >10s → [WARN][DRIFT]; >30s →
// rate-limited (5 min) NTP re-sync nudge (timedatectl/chronyc/ntpdate,
// spawned, non-fatal). Purely observational — never feeds rotation,
// producer selection or any consensus decision, so it cannot cause or
// prevent forks. O(1)/block.

/// Fixed-point EMA of |drift_seconds| × 1000 (millisecond precision).
/// Reset to 0 on genesis boot. Updated on every applied network block.
static CLOCK_DRIFT_EMA_MILLIS: AtomicU64 = AtomicU64::new(0);

/// Peak observed drift (seconds). Informational, never cleared.
static CLOCK_DRIFT_PEAK_SECS: AtomicU64 = AtomicU64::new(0);

// Clock drift is a non-issue for consensus: block_ts is slot-anchored
// (genesis + height*SLOT, exact-match validated), so timing is deterministic
// per height and a drifted clock can neither fork nor stall the network —
// nothing to self-calibrate and no reason to self-pause. The former median
// network-time ring / effective_now / Median-Past machinery was inert (no
// live callers) and has been removed; observe_clock_drift below survives only
// as an operator-facing drift monitor with no consensus effect.

/// Feed an observation into the drift monitor.
/// `block_ts`  — on-chain timestamp of a just-applied network block.
/// `local_now` — wall clock when the block was applied.
/// Pure observational — safe to call from any thread.
///
/// Monitoring-only: tracks an EMA of |wall - block_ts| and its peak, and logs
/// [WARN][PACING] when the EMA crosses ~10 s. It never pauses production, gates
/// voting, or feeds any consensus decision, so it cannot cause or prevent a
/// fork — a drifted node stays productive and keeps contributing to the BFT
/// quorum. Consensus timing safety is structural (slot-anchored timestamps),
/// not a product of this monitor.
pub fn observe_clock_drift(block_ts: u64, local_now: u64) {
    // Signed drift in seconds. Positive = our clock ahead of network.
    let abs_drift_secs: u64 = if local_now >= block_ts {
        local_now - block_ts
    } else {
        block_ts - local_now
    };

    let drift_millis: u64 = abs_drift_secs.saturating_mul(1000);

    // EMA with α = 1/8 (slow-moving, ignores single-block outliers).
    // ema_new = ema_old * 7/8 + drift * 1/8
    let prev = CLOCK_DRIFT_EMA_MILLIS.load(Ordering::Relaxed);
    let next = ((prev.saturating_mul(7)) + drift_millis) / 8;
    CLOCK_DRIFT_EMA_MILLIS.store(next, Ordering::Relaxed);

    // Peak tracker (max only).
    let peak = CLOCK_DRIFT_PEAK_SECS.load(Ordering::Relaxed);
    if abs_drift_secs > peak {
        CLOCK_DRIFT_PEAK_SECS.store(abs_drift_secs, Ordering::Relaxed);
    }

    // Monitoring: log when EMA crosses the operator-attention threshold.
    // Purely informational — no consensus side-effect (block_ts is
    // slot-anchored, so timing correctness never depends on the wall clock).
    let ema_secs = next / 1000;
    // Sampled (1 per PACING_LOG_EVERY blocks, ~5 min): the lag is informational — block_ts is
    // slot-anchored/deterministic, so it cannot fork; logging every block just spams.
    const PACING_LOG_EVERY: u64 = 300;
    static PACING_LOG_CTR: AtomicU64 = AtomicU64::new(0);
    if ema_secs > 10 && is_warn()
        && PACING_LOG_CTR.fetch_add(1, Ordering::Relaxed) % PACING_LOG_EVERY == 0 {
        println!(
            "[WARN][PACING] ema={}s peak={}s wall={} block_ts={} — chain off real-time schedule (sampled 1/{})",
            ema_secs, abs_drift_secs, local_now, block_ts, PACING_LOG_EVERY
        );
    }
}

// Auto NTP re-sync trigger was removed: the in-container invocations required
// a SYS_TIME capability we do not grant, so every call was a no-op. Drift needs
// no correction now that timestamps are slot-anchored; operator NTP hygiene is
// surfaced via the [WARN][PACING] log above.

/// Read current drift EMA in seconds (for metrics/health endpoints).
pub fn get_clock_drift_ema_secs() -> u64 {
    CLOCK_DRIFT_EMA_MILLIS.load(Ordering::Relaxed) / 1000
}

/// Read peak observed drift in seconds (for metrics/health endpoints).
pub fn get_clock_drift_peak_secs() -> u64 {
    CLOCK_DRIFT_PEAK_SECS.load(Ordering::Relaxed)
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCER VALIDATION CACHE: Tracks expected producer per height
// Populated by the main consensus loop; producer authority itself is enforced by the Category-B
// ingest reject, the storage L4 anti-fork gate and equivocation slashing.
// ═══════════════════════════════════════════════════════════════════════════════
lazy_static::lazy_static! {
    static ref EXPECTED_PRODUCER_CACHE: ParkingRwLock<std::collections::HashMap<u64, (String, u64)>> =
        ParkingRwLock::new(std::collections::HashMap::new());
}

/// Cache the expected producer for a given block height (called from main loop).
///
/// An EMPTY producer is never cached. Empty means this node could not derive the roster and is
/// abstaining; caching it would make `get_expected_producer` return Some(("", round)), every incoming
/// block would then fail `mb.producer != expected`, and the abstaining node would HARD REJECT the whole
/// chain instead of quietly following it. Absent-from-cache is the soft path, which is what abstention
/// must mean.
pub fn cache_expected_producer(height: u64, producer: &str, timeout_round: u64) {
    let mut cache = EXPECTED_PRODUCER_CACHE.write();
    if producer.is_empty() {
        cache.remove(&height);
        return;
    }
    cache.insert(height, (producer.to_string(), timeout_round));
    if cache.len() > 200 {
        let min_height = height.saturating_sub(100);
        cache.retain(|h, _| *h >= min_height);
    }
}

/// Get the expected producer for a given block height (None if not cached / historical)
pub fn get_expected_producer(height: u64) -> Option<(String, u64)> {
    EXPECTED_PRODUCER_CACHE.read().get(&height).cloned()
}

/// Re-derive the deterministic leader for `height` at an ARBITRARY rotation round — the
/// producer==leader hard-gate at ingest needs the leader for the BLOCK's claimed round, not
/// our locally-cached round. Reuses the round-0 baseline `CACHED_PRODUCER_SELECTION` (round0
/// producer + ordered candidate roster per leadership_round): leader = candidates[(round0_idx
/// + round) % N], the exact formula the producer uses (select_microblock_producer_with_round).
/// None ⇒ this node hasn't computed that window's roster yet (lag/cold-join) ⇒ caller keeps the
/// soft path (the round is already TC-certified, the block stays replayable). O(N), N ≤ 1000.
pub fn expected_producer_for_round(height: u64, round: u64) -> Option<String> {
    let lr = if height <= 30 { 0 } else { (height - 1) / 30 };
    let entry = producer_cache::CACHED_PRODUCER_SELECTION.get(&lr)?;
    let (round0_producer, candidates) = entry.value();
    if candidates.is_empty() { return None; }
    let round0_idx = candidates.iter().position(|(id, _)| id == round0_producer)?;
    Some(candidates[(round0_idx + round as usize) % candidates.len()].0.clone())
}

/// The producer public key a block-validity check must resolve: RAM first, then the COMMITTED
/// node_registry row, then the pinned genesis anchor.
///
/// RAM alone cannot carry a consensus verdict at scale. `VRF_PK_REGISTRY` is capped and REFUSES new
/// inserts once full rather than evicting, and light-node registrations share the same map against a
/// 10M-light target — so whether a super's key is present depends on what happened to fit, and a
/// verdict that differs by cache contents forks honest nodes. The registry CF is the authority; RAM is
/// a cache in front of it, and since the gossip installs were removed it holds only the pinned genesis
/// set, chain-applied registrations and this node's own key. Ordering matters: RAM first keeps the
/// common case a map lookup instead of a point-read on the per-block path.
pub(crate) fn producer_verify_pk(storage: &Storage, node_id: &str) -> Option<Vec<u8>> {
    crate::genesis_constants::get_vrf_public_key(node_id)
        .or_else(|| storage.load_vrf_public_key(node_id).ok().flatten())
        .or_else(|| crate::genesis_constants::get_genesis_anchor_pk(node_id))
}

/// SYNC producer-signature check for the fork-choice EQUAL-round tie-break. maybe_supersede runs on
/// UNVERIFIED gossip/repair bytes (verify_stage is skipped for a stored-height duplicate), so a forged
/// competitor whose (unsigned) `signature` field is ground to a lower hash could otherwise trigger a
/// wasteful reorg. This rejects any block not validly signed by its producer — a grinded random sig
/// fails the Dilithium verify, so only a GENUINE same-round self-fork (re-signed by the real producer,
/// who has the key) can win the tie-break. Mirrors the v4 path of the async verify_microblock_signature:
/// Block_Sig_v23.1 digest + detached ML-DSA-65 against the producer's registered VRF PK. h==0/genesis
/// never reaches here (maybe_supersede early-returns h==0); relaunch-from-scratch has no legacy sigs.
pub(crate) fn verify_microblock_producer_sig_sync(storage: &Storage, mb: &qnet_state::MicroBlock) -> bool {
    let sig_str = match std::str::from_utf8(&mb.signature) { Ok(s) => s, Err(_) => return false };
    let sig_hex = match sig_str.strip_prefix("dilithium3_v4:") { Some(x) => x, None => return false };
    let sig_bytes = match hex::decode(sig_hex) { Ok(b) => b, Err(_) => return false };
    let pk = match producer_verify_pk(storage, &mb.producer) { Some(p) => p, None => return false };
    use sha3::Digest;
    let mut hasher = sha3::Sha3_256::new();
    hasher.update(b"Block_Sig_v23.1");
    hasher.update(&mb.height.to_be_bytes());
    hasher.update(&mb.timestamp.to_be_bytes());
    hasher.update(&mb.merkle_root);
    hasher.update(&mb.previous_hash);
    hasher.update(&mb.state_root);
    hasher.update(mb.producer.as_bytes());
    if let Some(ref vrf_out) = mb.vrf_output { hasher.update(vrf_out); }
    hasher.update(&mb.timeout_round.to_be_bytes());
    hasher.update(&mb.carried_baseline.to_be_bytes());
    // Blocker-3: bind the WIRE pk-presence (matches signer) so a pk-stripped fork copy fails this
    // tie-break verify instead of being accepted as a validly-signed sibling.
    hasher.update(&microblock_pk_digest(&mb.transactions));
    let msg_hash = hasher.finalize();
    use pqcrypto_mldsa::mldsa65 as dilithium3;
    use pqcrypto_traits::sign::{PublicKey as PkTrait, DetachedSignature as SigTrait};
    let d3_pk = match <dilithium3::PublicKey as PkTrait>::from_bytes(&pk) { Ok(p) => p, Err(_) => return false };
    let d3_sig = match <dilithium3::DetachedSignature as SigTrait>::from_bytes(&sig_bytes) { Ok(s) => s, Err(_) => return false };
    dilithium3::verify_detached_signature(&d3_sig, msg_hash.as_ref(), &d3_pk).is_ok()
}

/// Blocker-3: digest binding a block's WIRE pk-presence into the producer signature. The block hash +
/// merkle_root exclude each tx's dilithium_public_key (FIX-5 pk-elision), so a relay can strip/add a
/// first-use wire pk and produce a byte-different-but-SAME-HASH block the victim can't verify → the
/// apply frontier defers forever. Folding this digest into Block_Sig_v23.1 makes any such tamper flip
/// the signed digest ⇒ the producer sig fails ⇒ the corrupt copy is rejected (re-fetched from an honest
/// peer), never accepted-by-hash. Honest propagation preserves the wire form byte-faithfully (elided
/// stays elided, first-use stays present), so it is stable across relays; only tampering diverges it.
/// Note: `None` and `Some(empty)` both encode "elided" and MUST fold identically — a length-0 marker.
pub(crate) fn microblock_pk_digest(txs: &[qnet_state::Transaction]) -> [u8; 32] {
    use sha3::{Digest, Sha3_256};
    let mut h = Sha3_256::new();
    h.update(b"pkdg2");
    for tx in txs {
        match tx.dilithium_public_key.as_deref() {
            Some(pk) if !pk.is_empty() => {
                h.update(&(pk.len() as u32).to_be_bytes());
                h.update(pk);
            }
            _ => { h.update(&0u32.to_be_bytes()); }
        }
        // The signature is elided from canonical_bytes, so it is outside tx.hash and merkle_root. It
        // decides whether a merkle claim is credited (claim_authorized), which makes it a consensus
        // input — bind it here or a relay could strip it and split state_root off an intact block.
        match tx.dilithium_signature.as_deref() {
            Some(sig) if !sig.is_empty() => {
                h.update(&(sig.len() as u32).to_be_bytes());
                h.update(sig);
            }
            _ => { h.update(&0u32.to_be_bytes()); }
        }
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&h.finalize());
    out
}

#[cfg(test)]
mod fix5_kat_tests {
    // FIX-5 Known-Answer Test: a wallet-signed value-TX in the NEW raw-detached wire format must pass
    // the PRODUCTION value verifier + the API-1 eon(pk)==from bind. ML-DSA-65 sign is hedged/randomized
    // so this asserts the verify RELATION + identity derivation (deterministic), not byte-identical sig
    // production. The clients pin the same preimage string and eon derivation against this vector
    // (qnet-mobile __tests__/fix5_kat.test.js, qnet-wallet tools/dilithium-wasm/compat_test.js).
    use pqcrypto_mldsa::mldsa65 as d3;
    use pqcrypto_traits::sign::{PublicKey as PkT, DetachedSignature as SigT};

    #[test]
    fn fix5_value_tx_raw_detached_verifies_and_binds() {
        // 1. Fresh ML-DSA-65 keypair; the wallet address is eon(SHA512(pk_bytes)).
        let (pk, sk) = d3::keypair();
        let pk_bytes = pk.as_bytes().to_vec();
        assert_eq!(pk_bytes.len(), 1952, "pk must be 1952 raw bytes");
        let from = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey_bytes(&pk_bytes)
            .expect("eon derivation");
        let to = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey_bytes(
            d3::keypair().0.as_bytes()).expect("second eon");

        // 2. Build a Transfer TX and its canonical SIGN preimage (unchanged by FIX-5).
        let mut tx = qnet_state::Transaction::new(
            from.clone(), Some(to.clone()), 1_000_000_000u64, 0, 10, 10_000, 1_700_000_000, None,
            qnet_state::TransactionType::Transfer { from: from.clone(), to: to.clone(), amount: 1_000_000_000 },
            None,
        );
        let msg = super::BlockchainNode::build_canonical_verify_message(&tx);
        let expected_prefix = format!("{}transfer:", qnet_state::transaction::chain_tag());
        assert!(msg.starts_with(&expected_prefix), "preimage = q<chain>|transfer:...");

        // 3. RAW detached signature (3309 bytes) over the preimage — the FIX-5 wire form.
        let sig = d3::detached_sign(msg.as_bytes(), &sk);
        let sig_bytes = sig.as_bytes().to_vec();
        assert_eq!(sig_bytes.len(), 3309, "detached sig must be 3309 raw bytes");
        tx = tx.with_quantum_signature(Some(sig_bytes.clone()), Some(pk_bytes.clone()));

        // 4. The PRODUCTION verifier accepts these exact bytes (wire pk present = first-use).
        assert!(super::BlockchainNode::verify_user_tx_dilithium(&tx),
                "raw-detached value-TX must verify on the node");

        // 5. API-1 bind holds; a wrong pk (different key) must FAIL the bind.
        assert_eq!(
            crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey_bytes(&pk_bytes).as_deref(),
            Some(from.as_str()));
        let mut forged = tx.clone();
        forged = forged.with_quantum_signature(Some(sig_bytes), Some(d3::keypair().0.as_bytes().to_vec()));
        assert!(!super::BlockchainNode::verify_user_tx_dilithium(&forged),
                "a pk not deriving to `from` must be rejected");

        // 6. Detached verify == the raw relation the JS harness reproduces.
        let d3_pk = <d3::PublicKey as PkT>::from_bytes(&pk_bytes).unwrap();
        let d3_sig = <d3::DetachedSignature as SigT>::from_bytes(sig.as_bytes()).unwrap();
        assert!(d3::verify_detached_signature(&d3_sig, msg.as_bytes(), &d3_pk).is_ok());
    }

    // Regression guard: the NODE-BINARY lifecycle signer must emit the RAW detached wire form
    // (3309 B sig + 1952 B pk) that verify_node_lifecycle_dilithium requires. The envelope form
    // (sign_consensus) is length-gated out and silently killed super registration + reactivation.
    #[test]
    fn fix5_node_lifecycle_signer_roundtrips_through_verifier() {
        use pqcrypto_traits::sign::SecretKey as SkT;
        let (pk, sk) = d3::keypair();
        let identity = crate::crypto::vrf::WalletIdentity::from_seed_and_keys(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            pk.as_bytes().to_vec(), sk.as_bytes().to_vec()).expect("identity");
        let node_id = "super_node_lifecycle_kat";
        let mut tx = qnet_state::Transaction::new(
            node_id.to_string(), None, 0, 0, 0, 0, 1_700_000_000, None,
            qnet_state::TransactionType::NodeReactivation {
                node_id: node_id.to_string(), current_height: 100,
                last_macroblock_hash: String::new(), last_macroblock_index: 1,
                api_endpoint: "http://203.0.113.7:8001".to_string(),
            }, None);
        super::BlockchainNode::sign_reactivation_tx(&mut tx, node_id, Some(&identity));
        assert_eq!(tx.dilithium_signature.as_ref().map(|s| s.len()), Some(3309), "raw detached sig");
        assert_eq!(tx.dilithium_public_key.as_ref().map(|p| p.len()), Some(1952), "raw pk");
        assert!(super::BlockchainNode::verify_node_lifecycle_dilithium(&tx),
                "node-signed NodeReactivation must verify raw-detached");
        // A relayer rewriting a body field must break the SIGNATURE, not merely the (unsigned) hash.
        let mut tampered = tx.clone();
        if let qnet_state::TransactionType::NodeReactivation { last_macroblock_index, .. } = &mut tampered.tx_type {
            *last_macroblock_index = 10_000_000_000_000_000;
        }
        assert!(!super::BlockchainNode::verify_node_lifecycle_dilithium(&tampered),
                "a rewritten dedup epoch must fail the signature");
    }

    /// EVERY NodeReactivation body field must be inside the signed preimage. The TX hash is not
    /// signed, so an unbound field is free for a relayer to rewrite — and `last_macroblock_index` is
    /// the apply dedup epoch, so one rewritten copy would bar the sender from ever reactivating.
    #[test]
    fn reactivation_preimage_binds_every_body_field() {
        let mk = |ep: &str, h: u64, mbh: &str, mbi: u64| qnet_state::Transaction::new(
            "super_ep_bind".to_string(), None, 0, 0, 0, 0, 1_700_000_000, None,
            qnet_state::TransactionType::NodeReactivation {
                node_id: "super_ep_bind".to_string(), current_height: h,
                last_macroblock_hash: mbh.to_string(), last_macroblock_index: mbi,
                api_endpoint: ep.to_string(),
            }, None);
        let base = ("http://203.0.113.7:8001", 180u64, "aa".repeat(32), 2u64);
        let msg = |t: &(&str, u64, String, u64)| super::BlockchainNode::build_canonical_verify_message(
            &mk(t.0, t.1, &t.2, t.3));

        let a = msg(&base);
        assert_eq!(a, msg(&base), "same inputs, same preimage");
        for mutated in [
            ("http://198.51.100.9:8001", base.1, base.2.clone(), base.3),
            (base.0, 9_000_000_000, base.2.clone(), base.3),
            (base.0, base.1, "bb".repeat(32), base.3),
            (base.0, base.1, base.2.clone(), 10_000_000_000_000_000),
        ] {
            assert_ne!(a, msg(&mutated), "a rewritten body field must change the preimage");
        }

        // Signer and verifier build the identical bytes (chain tag applied once, at the same place).
        assert_eq!(a, super::BlockchainNode::chain_bind(
            &super::BlockchainNode::node_reactivation_message(
                "super_ep_bind", 1_700_000_000, base.0, base.1, &base.2, base.3)));
    }

    /// One endpoint validator, shared by registration and reactivation.
    #[test]
    fn public_api_endpoint_rules_are_shared() {
        use qnet_state::transaction::validate_public_api_endpoint as v;
        assert!(v("").is_ok(), "empty = IP hidden");
        assert!(v("http://203.0.113.7:8001").is_ok());
        assert!(v("203.0.113.7:8001").is_err(), "scheme required");
        assert!(v("http://127.0.0.1:8001").is_err());
        assert!(v("http://192.168.1.4:8001").is_err());
        assert!(v("http://[fe80::1]:8001").is_err());
    }
}

#[cfg(test)]
mod producer_round_tests {
    /// The heartbeat admission lag is duplicated across crates (qnet-state cannot depend on
    /// qnet-integration). Drift between them is a consensus split, so assert equality here.
    #[test]
    fn hb_anchor_lag_matches_across_crates() {
        assert_eq!(crate::node::HB_ANCHOR_MAX_LAG,
                   qnet_state::transaction::HB_ANCHOR_MAX_LAG_BLOCKS,
                   "apply-side and producer-side heartbeat lag must agree");
    }

    // A1 ingest hard-gate derivation: leader for an arbitrary round rotates deterministically off the
    // round-0 baseline, and a window we never computed yields None (caller keeps the soft path).
    #[test]
    fn expected_producer_for_round_rotates_deterministically() {
        let roster: Vec<(String, f64)> = (0..5).map(|i| (format!("n{}", i), 0.0)).collect();
        // leadership_round 2 = heights 61..=90; round-0 elected leader = n3 (idx 3).
        super::producer_cache::CACHED_PRODUCER_SELECTION.insert(2, ("n3".to_string(), roster));
        // leader(R) = candidates[(3 + R) % 5]
        assert_eq!(super::expected_producer_for_round(61, 0).as_deref(), Some("n3"));
        assert_eq!(super::expected_producer_for_round(61, 1).as_deref(), Some("n4"));
        assert_eq!(super::expected_producer_for_round(90, 2).as_deref(), Some("n0")); // wrap
        assert_eq!(super::expected_producer_for_round(75, 5).as_deref(), Some("n3")); // full cycle
        assert_eq!(super::expected_producer_for_round(999_991, 1), None);             // uncomputed ⇒ soft path
        super::producer_cache::CACHED_PRODUCER_SELECTION.remove(&2);
    }
}

/// v3.31: Clear stale entries above rollback height
pub fn clear_expected_producer_cache_above(max_height: u64) {
    let mut cache = EXPECTED_PRODUCER_CACHE.write();
    cache.retain(|h, _| *h <= max_height);
}

// ═══════════════════════════════════════════════════════════════════════════════
// v33: MACROBLOCK WINDOW CONTENT ACCUMULATOR — deterministic checkpoint content.
//
// The checkpoint content (the window's block hashes) was computed by
// RE-READING the 90 window blocks from storage at window-end. That read is racy:
// a block already applied to the chain but not yet flushed returns None, so a node
// builds PARTIAL content (e.g. 89/90) that diverges from nodes with the full
// window → the n−f checkpoint can't form → finality stalls (the recurring stall).
//
// Fix: accumulate each block's hash at COMMIT time — when the block is in hand —
// into a per-window buffer. At window-end the buffer is already
// complete, in order, and IDENTICAL on every node (all apply the same canonical
// blocks in the same order). No re-read, no race — deterministic by construction.
// The head block's state_root (set only after TX apply) is still read separately
// via the existing bounded head-wait.
// ═══════════════════════════════════════════════════════════════════════════════
lazy_static::lazy_static! {
    /// Key: macroblock index. Value: per-position block hash for the 90-block window, indexed by
    /// (height - window_start). The beacon folds these same hashes.
    static ref WINDOW_CONTENT_ACCUM: ParkingRwLock<std::collections::HashMap<u64, Vec<[u8; 32]>>> =
        ParkingRwLock::new(std::collections::HashMap::new());
}

/// Append a committed block's hash to its macroblock window buffer.
/// Called at the canonical commit point on EVERY apply path (production + pipeline),
/// so every node accumulates the identical window from the identical canonical chain.
/// Position-based with truncate-on-reapply: a re-applied block (after a rollback)
/// overwrites its slot and drops later slots; an out-of-order gap clears the buffer
/// so the consumer falls back to the storage re-read for that one window. O(1).
pub fn accumulate_window_block(height: u64, mb: &qnet_state::MicroBlock) {
    if height == 0 { return; } // genesis is not part of any 90-block window
    let mb_idx = (height - 1) / 90 + 1;
    let start_h = (mb_idx - 1) * 90 + 1;
    let pos = (height - start_h) as usize;
    if pos >= 90 { return; }
    let entry = mb.hash();
    let mut map = WINDOW_CONTENT_ACCUM.write();
    let buf = map.entry(mb_idx).or_insert_with(Vec::new);
    if pos <= buf.len() {
        buf.truncate(pos);   // re-apply (pos<len) or contiguous (pos==len)
        buf.push(entry);
    } else {
        buf.clear();         // out-of-order gap → consumer falls back to re-read
    }
    // Bound memory: keep only recent windows (finality trails the tip by ≤3 windows).
    if map.len() > 12 {
        let keep_from = mb_idx.saturating_sub(8);
        map.retain(|k, _| *k >= keep_from);
    }
}

/// The window's block hashes for a fully-accumulated 90-block window, or None if the buffer is
/// incomplete (caller falls back to the re-read). Both mb_hashes and the beacon fold this one vector.
pub fn window_content_from_accum(mb_idx: u64) -> Option<Vec<[u8; 32]>> {
    let map = WINDOW_CONTENT_ACCUM.read();
    let buf = map.get(&mb_idx)?;
    if buf.len() != 90 { return None; }
    Some(buf.clone())
}

/// v36: deterministic recent-Heartbeat liveness for Phase-2A producer eligibility.
///
/// Phase-2A previously read the recent-Heartbeat bit from `load_account(reg).heartbeat_slots`, i.e. the
/// persisted `accounts` CF — which is written by a DETACHED best-effort persist (microblocks are the
/// authoritative store). The eligible snapshot runs async, so each committee member read a different
/// persist-lag prefix → divergent eligible_producers → the QC-bound epoch_commitment split → n−f never
/// formed → finality stall. Fix: derive the set from the COMMITTED block bodies (synchronously saved at
/// apply, canonical + identical on every node), bounded to `scan_end`. Returns the supers that sent a
/// Heartbeat whose ANCHOR fell in the current or previous subwindow (same epoch — mirrors the old bitmask
/// recency) and that was included in a block at-or-below scan_end. A pure function of the canonical chain
/// ≤ scan_end ⇒ identical on every committee member, with NO live-tip dependence. Scans ≤2 subwindows
/// (~2880 blocks), off the production path; bodies are retained 6 epochs, far beyond this window.
/// (current, previous) GLOBAL subwindow indices (anchor/1440) for `scan_end`. prev = cur-1 SPANS the
/// epoch boundary: a Heartbeat from the prior epoch's last subwindow is still recent liveness. This is
/// the flicker fix — the earlier per-epoch reset (prev=cur at each epoch's first subwindow) ejected the
/// whole non-genesis eligible set every epoch start. Pure fn of scan_end (the deterministic N-2 boundary,
/// identical on every committee member — NOT the live tip), so it never diverges. The set feeds
/// epoch_commitment→QC, so this MUST be a genesis rule, identical on every node. Pure ⇒ deterministic.
fn recency_subwindow_indices(scan_end: u64) -> (u64, u64) {
    let cur_idx = scan_end / 1440;
    (cur_idx, cur_idx.saturating_sub(1))
}

/// Deterministic light-reward roster cutoff (`before_height`) for `epoch`. Gated by
/// `light_reg_epoch_roster` (a coordinated live-net rollout, gated on epoch_start): at/after activation
/// the roster freezes at the bitmap commit-window open (epoch_start + 14400 - 50), so a light node
/// registered DURING the epoch (before its last 50 volatile blocks) is in the roster and earns for that
/// epoch — including epoch 0, which an epoch_start=0 cutoff would leave permanently empty. BELOW
/// activation: legacy epoch_start (byte-exact to the deployed binary, so a mixed-version net agrees on
/// the light bitmap until the flip). The bitmap CREATOR and the reward READER use this identically;
/// pure fn of the epoch ⇒ they never diverge. For a fresh genesis set the gate to 0. Pure ⇒ deterministic.
/// Stable 5-genesis light shard of a node_id — roster-size-INDEPENDENT (unlike the old positional split,
/// whose contiguous boundaries shifted as the roster grew, moving a node's owner between attest time and
/// bitmap-build time). blake3(node_id) → u64(first 8 bytes LE) % 5. THE ONE canonical shard fn: the bitmap
/// builder and EVERY reader (emission recompute, ping-commitment collector, snapshot_light_eligible) map
/// bits↔nodes by enumerating the deterministic sorted roster with a per-shard counter — bit i in shard g is
/// the i-th sorted node with light_shard_of()==g — so all nodes agree byte-for-byte on the committed bitmap.
pub(crate) fn light_shard_of(node_id: &str) -> usize {
    let h = blake3::hash(node_id.as_bytes());
    (u64::from_le_bytes(h.as_bytes()[..8].try_into().unwrap_or([0u8; 8])) % 5) as usize
}

pub(crate) fn light_roster_cutoff(epoch: u64) -> u64 {
    let epoch_start = epoch.saturating_mul(14400);
    if qnet_state::feature_gates::is_active("light_reg_epoch_roster", epoch_start) {
        epoch_start + (14400 - 50)
    } else {
        epoch_start
    }
}

/// Recent-Heartbeat liveness set for Phase-2A, read from the apply-time lhb_ index — O(recent supers),
/// no block-body deserialization. Byte-identical to the body scan (`recent_heartbeat_senders_scan`,
/// determinism-tested): the index is written on both apply paths and canonicalized at every height
/// reset, so every node reads the same set for the same scan_end.
fn recent_heartbeat_senders(storage: &crate::storage::Storage, scan_end: u64) -> Option<std::collections::HashSet<String>> {
    let (cur_idx, prev_idx) = recency_subwindow_indices(scan_end);
    match storage.recent_heartbeat_senders_indexed(cur_idx, prev_idx, scan_end) {
        Ok(set) => Some(set),
        // Pruned below the needed subwindow ⇒ the liveness answer for this window is no longer derivable
        // here. `unwrap_or_default()` used to turn that into an EMPTY set, i.e. "nobody is live" — a
        // silently different roster on this node alone.
        Err(e) => {
            if is_warn() { println!("[WARN][ROSTER] heartbeat_index_unusable scan_end={} err={}", scan_end, e); }
            None
        }
    }
}

/// The window `w` randomness beacon, DERIVED from the microblock chain instead of read out of the
/// macroblock that seals it.
///
/// The sealed value is `accumulate_beacon(hash of every microblock in the window)` — the same block
/// hashes the checkpoint QC signs in `window_mb_hashes`, so the macroblock only STORES it; it is not
/// the authority. Reading it from there made the seed unavailable the moment finality stopped, which
/// is what turns a finality stall into a height stall.
///
/// None ⇒ some body in the window is missing ⇒ the caller abstains. Window w spans
/// (w-1)*90+1 ..= w*90, i.e. at most 180 blocks behind the production point — always inside the
/// 6-epoch body retention.
pub(crate) fn derive_window_beacon(storage: &Storage, w: u64) -> Option<[u8; 32]> {
    if w == 0 { return None; }
    let (start, end) = ((w - 1) * 90 + 1, w * 90);
    let mut v: Vec<[u8; 32]> = Vec::with_capacity(90);
    for h in start..=end {
        let mb = storage.load_microblock_auto_format(h).ok().flatten()?;
        v.push(mb.hash());
    }
    Some(qnet_consensus::checkpoint_bft::accumulate_beacon(&v))
}

/// True iff `node_id` was equivocation-banned at or below `window_head`, read the way the reward roster
/// already reads it: the LIVE applied state first, disk only for an evicted account.
///
/// The accounts column family is NOT the source of truth here. It is written asynchronously and
/// best-effort after apply, and the producer-inline apply never writes it at all — so a node that just
/// produced the block carrying an equivocation proof would disagree with every validator about its own
/// block. The StateManager map IS what state_root is computed from, and `banned_at_height` is
/// write-once monotone, so reading it at a later tip still answers the as-of-window question exactly.
fn banned_at_or_below(
    state_guard: &StateManager,
    storage: &crate::storage::Storage,
    node_id: &str,
    window_head: u64,
) -> bool {
    let hit = |h: u64| h > 0 && h <= window_head;
    match state_guard.accounts.get(node_id) {
        Some(a) => hit(a.value().banned_at_height),
        None => storage.load_account(node_id).ok().flatten().map_or(false, |a| hit(a.banned_at_height)),
    }
}

/// Activation warmup (2 epochs): a registered super is producer-eligible only after its registration
/// is buried this many blocks, so a freshly-joined node syncs as an observer before it can be elected.
/// Its slot is therefore always fillable, so the epoch-boundary producer/committee membership window
/// never forces a spurious failover on a not-yet-ready joiner. Genesis (reg_height 0) is exempt.
const ACTIVATION_WARMUP_BLOCKS: u64 = 180;

/// Phase-2A eligible additions: the registered-Super nodes that are recently live (on-chain Heartbeat
/// in cur/prev subwindow), registration-confirmed + warmup-buried by scan_end, and at/above the
/// reputation floor — excluding ids already in `already_eligible`. Returned in node_id-ascending order
/// (the consensus canonical key; feeds epoch_commitment→QC so it MUST be identical on every node).
///
/// SCALE: the recent-HB membership (O(1), in-memory) gates the per-candidate reg-height DISK point-read,
/// so only the recent∩registered set (a few thousand) hits disk — NOT the full 100k+ registrant set. This
/// is a pure predicate reorder of an AND, so the output is byte-identical to gating on reg-height first.
fn phase2a_eligible_additions(
    state_guard: &StateManager,
    storage: &crate::storage::Storage,
    registered_super_nodes: &std::collections::HashSet<String>,
    recent_hb: &std::collections::HashSet<String>,
    already_eligible: &std::collections::HashSet<String>,
    reputation_map: &std::collections::HashMap<String, f64>,
    scan_end: u64,
    min_reputation_bp: u32,
) -> Vec<qnet_state::EligibleProducer> {
    // A candidate re-admitted here is, by definition, NOT in consensus_participants, so the reputation
    // fold above never saw it and `unwrap_or(INITIAL_REPUTATION)` below would hand a proven-Byzantine
    // node a clean 70. The ban has to be read here too, from the same state_root-certified field.
    let mut regs: Vec<&String> = registered_super_nodes.iter().collect();
    regs.sort();
    let mut out: Vec<qnet_state::EligibleProducer> = Vec::new();
    for reg in regs {
        if already_eligible.contains(reg) { continue; }
        // Restart bar, enforced here too: this arm re-admits any registered heartbeating identity, so
        // filtering only the carry-over would return every barred node on the next window.
        if crate::genesis_constants::restart_excludes(reg) { continue; }
        if !recent_hb.contains(reg) { continue; }
        // Buried by the activation warmup before scan_end. The pool is already height-bounded at the
        // source, so this is the warmup rule alone. Genesis (reg_height 0) is exempt.
        match storage.node_reg_height(reg) {
            Ok(Some(h)) if h == 0 || h.saturating_add(ACTIVATION_WARMUP_BLOCKS) <= scan_end => {}
            _ => continue,
        }
        if banned_at_or_below(state_guard, storage, reg, scan_end) {
            continue; // proven equivocator — never re-admitted
        }
        let rep = (reputation_map.get(reg).copied()
            .unwrap_or(qnet_consensus::deterministic_reputation::INITIAL_REPUTATION)
            .clamp(0.0, 100.0) * 100.0).round() as u32;
        if rep < min_reputation_bp { continue; }
        out.push(qnet_state::EligibleProducer { node_id: reg.clone(), reputation: rep });
    }
    out
}

/// Reference body scan (test oracle for the lhb_ index; not on any production path).
#[cfg(test)]
fn recent_heartbeat_senders_scan(storage: &crate::storage::Storage, scan_end: u64) -> std::collections::HashSet<String> {
    let (cur_idx, prev_idx) = recency_subwindow_indices(scan_end);
    let start = prev_idx.saturating_mul(1440);
    let mut set: std::collections::HashSet<String> = std::collections::HashSet::new();
    for h in start..=scan_end {
        if let Ok(Some(block)) = storage.load_microblock_auto_format(h) {
            for tx in &block.transactions {
                if let qnet_state::TransactionType::Heartbeat { node_id, anchor_height, .. } = &tx.tx_type {
                    // Mirror index_heartbeat_inclusion: a stale or future anchor grants no liveness.
                    if *anchor_height >= h || h - *anchor_height > HB_ANCHOR_MAX_LAG { continue; }
                    let s = anchor_height / 1440;
                    if s == cur_idx || s == prev_idx { set.insert(node_id.clone()); }
                }
            }
        }
    }
    set
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTION v2.50: Lock-free global storage with OnceCell + Arc
// RocksDB does NOT support multiple connections - single instance shared immutably
// 10x faster than Mutex-based approach for block writes
// ═══════════════════════════════════════════════════════════════════════════════

/// Global storage instance - initialized once, shared immutably
pub static GLOBAL_STORAGE_INSTANCE: OnceCell<Arc<Storage>> = OnceCell::const_new();

/// Initialize global storage (call once during node startup)
pub fn init_global_storage(storage: Arc<Storage>) {
    if GLOBAL_STORAGE_INSTANCE.set(storage).is_err() {
        if is_warn() { println!("[WARN][STORAGE] already_initialized"); }
    } else {
        if is_info() { println!("[INFO][STORAGE] init_complete mode=OnceCell+Arc"); }
    }
}

/// Get reference to global storage (panics if not initialized)
#[inline]
pub fn get_storage() -> &'static Arc<Storage> {
    GLOBAL_STORAGE_INSTANCE.get().expect("[CRIT][STORAGE] not_initialized")
}

/// Try to get reference to global storage (returns None if not initialized)
#[inline]
pub fn try_get_storage() -> Option<&'static Arc<Storage>> {
    GLOBAL_STORAGE_INSTANCE.get()
}

/// Applied state, published once at startup. The A1 roster derivation runs from an associated fn on the
/// candidate path (no &self there) and needs the SAME map state_root is computed from — the accounts
/// column family is an async best-effort mirror and must never back a consensus verdict.
pub static GLOBAL_STATE_INSTANCE: OnceCell<Arc<RwLock<StateManager>>> = OnceCell::const_new();

pub fn init_global_state(state: Arc<RwLock<StateManager>>) {
    let _ = GLOBAL_STATE_INSTANCE.set(state);
}

#[inline]
pub fn try_get_state() -> Option<&'static Arc<RwLock<StateManager>>> {
    GLOBAL_STATE_INSTANCE.get()
}

// CRITICAL FIX: Track last block production time globally for stall detection
// This prevents network from getting stuck when all nodes stop producing
pub static LAST_BLOCK_PRODUCED_TIME: AtomicU64 = AtomicU64::new(0);
pub static LAST_BLOCK_PRODUCED_HEIGHT: AtomicU64 = AtomicU64::new(0);
// Stall/timeout liveness timer: wall instant when our applied height last advanced.
// Decoupled from slot-anchored block_ts so local_delay = real no-progress, not the
// chain's lifetime production deficit.
pub static STALL_PROGRESS_HEIGHT: AtomicU64 = AtomicU64::new(0);
pub static STALL_PROGRESS_WALL: AtomicU64 = AtomicU64::new(0);
// A4: no-progress timer for the 180s deadlock-escape ceiling, keyed on the certified VIEW
// (mb_idx, certified failover_round) instead of applied height. B's tail-convergence reorgs thrash
// LAST_BLOCK_PRODUCED_HEIGHT (hence STALL_PROGRESS_WALL), which kept resetting the height-based
// ceiling and starved the escape from the alive-but-stuck 4-of-5 deadlock. This resets ONLY when the
// certified round genuinely advances (correct PBFT view-timer semantics). MAX = unset (view 0 is real).
pub static ROUND_ENTRY_VIEW: AtomicU64 = AtomicU64::new(u64::MAX);
pub static ROUND_ENTRY_WALL: AtomicU64 = AtomicU64::new(0);

// Producer liveness watchdog. Forensic: node 002 went silent 85.6 s at
// h=154345 (a sync RocksDB call under compaction blocked the async runtime;
// fixed in v15.10/11). Defence-in-depth against any future runtime stall:
// the producer loop stamps PRODUCER_HEARTBEAT_MS each iteration; a separate
// task polls every 500 ms — ≥3 s → producer_silent, ≥10 s → producer_dead.
// Log-only; never modifies producer state, so it can't fork (failover stays
// on the BFT timeout-vote path). O(1).
pub static PRODUCER_HEARTBEAT_MS: AtomicU64 = AtomicU64::new(0);
pub static PRODUCER_WATCHDOG_STARTED: AtomicU64 = AtomicU64::new(0);

/// v16.1: Throttle for the network-broadcast heartbeat. The local
/// `record_producer_heartbeat` runs at every production-loop iteration
/// (sub-second), but the network broadcast must respect a 1s minimum
/// interval — the receivers' rate limiter caps inbound to 60/min/peer
/// and the slot cadence is itself ~1s. Stored as wall-clock ms.
pub static LAST_NETWORK_HEARTBEAT_MS: AtomicU64 = AtomicU64::new(0);
const NETWORK_HEARTBEAT_INTERVAL_MS: u64 = 1_000;

/// Self-restart budget for the stuck-height watchdog. A restart clears local transport and RAM
/// state; if the block is still unobtainable after this many attempts the cause is structural and
/// further restarts only destroy accumulated consensus state.
const MAX_STUCK_SELF_RESTARTS: u32 = 3;
/// Restart attempts survive the process, so the watchdog cannot reset its own budget by restarting.
/// Path is bound to the SAME directory the storage opened — resolving it independently risks writing
/// the budget to a path the deployment does not persist, silently restoring the infinite loop.
static STUCK_RESTART_DIR: once_cell::sync::OnceCell<std::path::PathBuf> = once_cell::sync::OnceCell::new();

/// Bind the restart-budget location to the node's actual data directory. Called once at storage init.
pub fn bind_stuck_restart_dir(data_dir: &str) {
    let _ = STUCK_RESTART_DIR.set(std::path::PathBuf::from(data_dir));
}

fn stuck_restart_file() -> std::path::PathBuf {
    STUCK_RESTART_DIR.get().cloned()
        .unwrap_or_else(|| std::path::PathBuf::from(
            std::env::var("QNET_DATA_DIR").unwrap_or_else(|_| "/app/data".to_string())))
        .join("stuck_restart_state")
}

/// Count one restart attempt for `height`; resets when the stuck height changes (real progress).
fn record_stuck_restart_attempt(height: u64) -> u32 {
    let path = stuck_restart_file();
    let prev = std::fs::read_to_string(&path).ok()
        .and_then(|s| {
            let mut it = s.trim().split(':');
            Some((it.next()?.parse::<u64>().ok()?, it.next()?.parse::<u32>().ok()?))
        });
    let attempts = match prev {
        Some((h, n)) if h == height => n.saturating_add(1),
        _ => 1,
    };
    // A failed write means the budget cannot persist and the node would restart forever. Report it
    // loudly and treat this attempt as terminal — staying up degraded beats an invisible loop.
    if let Err(e) = std::fs::write(&path, format!("{}:{}", height, attempts)) {
        println!("[CRIT][NODE] restart_budget_write_failed path={} err={} action=treat_as_exhausted",
                 path.display(), e);
        return u32::MAX;
    }
    attempts
}

/// Clear the restart budget once the node makes real progress past the stuck height.
pub fn clear_stuck_restart_state() {
    let _ = std::fs::remove_file(stuck_restart_file());
}

/// Wall-clock ms of the last tick this node held production authority.
static LAST_LEADERSHIP_MS: AtomicU64 = AtomicU64::new(0);
/// Keep heartbeating this long after the rotation ends — covers peers still a few blocks behind
/// that would otherwise read the handoff silence as producer death. Short, because verified blocks
/// already feed liveness for free; this only bridges the gap between the last block and the handoff.
const LEADER_HEARTBEAT_GRACE_MS: u64 = 5_000;

#[inline]
pub fn record_producer_heartbeat() {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    PRODUCER_HEARTBEAT_MS.store(now_ms, std::sync::atomic::Ordering::Relaxed);
}

/// v5.5: Post-restart production lockout.
/// After restart, a node must NOT produce blocks until it has confirmed sync
/// with the network by receiving at least one NEW block from a peer.
/// This prevents freshly restarted nodes from producing with stale timeout_round,
/// which caused forks during rolling updates.
/// 0 = locked (no production), 1 = unlocked (production allowed)
pub static PRODUCTION_UNLOCKED: AtomicU64 = AtomicU64::new(0);

/// Wall-clock (secs) of this process's first pacemaker tick = the boot instant. Lazy-set once.
/// The QUIC mesh takes tens-of-seconds to ~2 min to re-form after a (re)start, but the timeout-vote
/// grace is only STALL_GRACE_SECS (5s). Without a boot window a freshly-restarted node — or a whole
/// co-restarted cohort — escalates its certified round on a phantom "producer silent" before the real
/// block can propagate; the inflated round then permanently rejects the network's valid lower-round
/// blocks (the rolling-upgrade escalation-lock). Emission is suppressed until the mesh has had time
/// to form. Normal failover (uptime ≫ grace, meshed, producer genuinely silent) is unaffected.
pub static NODE_BOOT_WALL: AtomicU64 = AtomicU64::new(0);
/// Amplified failover window this node adopted (0 = none) + consecutive stuck ticks on it.
/// Drives the 3-tick resume valve: suppress the own lower key while syncing toward the amplified
/// window, resume it IN ADDITION if the window's blocks don't arrive (delay, never park).
static AMPLIFIED_WINDOW: AtomicU64 = AtomicU64::new(0);
static AMPLIFY_STUCK_TICKS: AtomicU64 = AtomicU64::new(0);
/// Min validated peers a node must see before it may drive view-change (real quorum reachable).
pub const TIMEOUT_ESCALATION_MIN_PEERS: usize = 2;
/// Short post-boot floor before any escalation — guards the first ticks against a mesh-not-yet race.
pub const TIMEOUT_ESCALATION_BOOT_FLOOR_SECS: u64 = 15;

/// Unsealed production allowance in WINDOWS — shared by the production throttle, the failover
/// suppression gate, and the amplification bound (derived from ONE constant so they cannot drift).
/// Guarantees macroblock w-2 is sealed for every producible window w.
pub(crate) const MAX_UNSEALED_WINDOWS: u64 = 2;

/// Max failover round per window before it is a sync/partition problem (chronic-stall), not producer
/// liveness. Doubles as the ACCEPTANCE bound on the round dimension so a Byzantine committee member
/// cannot mint unbounded distinct (window, round) vote keys.
pub const MAX_FAILOVER_ROUND: u64 = 50;

/// PARTICIPATION-only recovery arm: `(anchor_mb, anchor_mb_hash, anchor_cp_index)`.
///
/// This gates ONLY what this node will propose, vote and count. It NEVER gates validity: whether a
/// certificate is relaxed is a pure function of that certificate's own bytes plus one final
/// macroblock (see `resolve_recovery_pin`). Keeping the two predicates separate is what makes
/// disagreement here cost liveness (no QC forms, retry) instead of forking the chain.
pub static RC_ARMED: once_cell::sync::Lazy<parking_lot::RwLock<Option<(u64, [u8; 32], u64)>>> =
    once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(None));

/// Seconds of certified-checkpoint silence before the recovery arm may engage. Two orders of
/// magnitude above VIEW_TIMEOUT_MS so no transient, view change or rotation can reach it.
pub const RC_STALL_SECS: u64 = 600;

/// Master switch for the recovery relaxation. OFF, and it must stay off at this threshold.
///
/// The idea: for RC_SPAN_INDICES windows above a sealed anchor, keep the committee and drop the
/// threshold to `relaxed_quorum(n) = n/2+1`, so a quorum that lost more than f members recovers
/// without operator coordination.
///
/// WHY IT CANNOT BE ENABLED AS SPECIFIED. Two strict quorums intersect in `n - 2f >= f + 1` members,
/// so the intersection always holds an honest one — that is what makes a certified checkpoint final.
/// Two RELAXED quorums intersect in `2*(n/2+1) - n` = 2 members, a CONSTANT, while `f = (n-1)/3`
/// grows with the committee: 2 vs f=3 at n=10, 2 vs f=333 at n=1000. From n=10 up the whole
/// intersection can be Byzantine, so two conflicting checkpoints for one window head are both valid,
/// both seal, and first-write-wins makes the split permanent. Convicting the double-signers afterwards
/// bans them but does not reconverge the chain. No amount of implementation closes this: any threshold
/// below 2f+1 trades safety for liveness, which a BFT chain must not do.
///
/// Enabling requires a different mechanism, not a fix — shrink the committee (which shrinks f) rather
/// than the threshold, or keep the coordinated restart, which is honest about needing social input.
/// The machinery below stays compiled and correct so that redesign has a starting point.
pub const RC_ENABLED: bool = false;

/// The armed anchor, or None.
pub fn rc_armed() -> Option<(u64, [u8; 32], u64)> { *RC_ARMED.read() }

/// An operator asked to arm. The RPC must NOT write `RC_ARMED` directly — the driver has to be told
/// too, and only the consensus loop does that. Writing the global alone left the driver unarmed and
/// the loop in its already-armed branch forever, disabling the automatic arm. One-shot, consumed by
/// the loop, so both paths run identical code and the operator shortens only the stall wait.
static RC_ARM_REQUEST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn rc_request_arm() { RC_ARM_REQUEST.store(true, std::sync::atomic::Ordering::SeqCst); }

/// Consume the request. True at most once per operator call.
pub fn rc_take_arm_request() -> bool { RC_ARM_REQUEST.swap(false, std::sync::atomic::Ordering::SeqCst) }

/// An operator asked to DISARM. Symmetric with the arm for the same reason: clearing only the global
/// leaves `driver.rc` set, so the driver keeps emitting pinned checkpoints while the global says
/// disarmed, and the loop's unarmed branch simply re-arms on the next tick — a no-op the operator
/// cannot see. One-shot, consumed by the consensus loop, which is the only place that can tell both.
static RC_DISARM_REQUEST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn rc_request_disarm() { RC_DISARM_REQUEST.store(true, std::sync::atomic::Ordering::SeqCst); }

/// Consume the request. True at most once per operator call.
pub fn rc_take_disarm_request() -> bool { RC_DISARM_REQUEST.swap(false, std::sync::atomic::Ordering::SeqCst) }

/// Does the cached proposal for this certificate's subject carry the pin THIS node armed? An unknown
/// subject, an unpinned one and a foreign anchor all answer false, so anything this node cannot tie
/// to its own arm is checked strictly.
fn rc_subject_pinned(index: u64, checkpoint_hash: &[u8; 32]) -> bool {
    let armed = match rc_armed() { Some((a, ah, _)) => (a, ah), None => return false };
    VOTE_PROPOSAL_META.get(&(index, *checkpoint_hash))
        .and_then(|m| m.value().2).map(|p| p == armed).unwrap_or(false)
}

/// Effective threshold for a live-gossip certificate under THIS node's arm. The pin lowers the bar
/// only for a certificate that CARRIES it — mirroring the engine's own tally — so a certificate over
/// an UNPINNED checkpoint is never relaxed just because its index sits in a span. Advisory: the
/// macroblock authority re-resolves the pin from the certificate's own bytes.
pub fn rc_effective_quorum(index: u64, checkpoint_hash: &[u8; 32], committee_len: usize) -> usize {
    let relaxed = RC_ENABLED && rc_subject_pinned(index, checkpoint_hash);
    qnet_consensus::checkpoint_bft::effective_quorum(committee_len, relaxed)
}

// MICROBLOCK FAILOVER STAYS STRICT under a span, deliberately. A timeout vote's message and its
// threshold were both derived from the LOCAL arm, so an armed and an unarmed node reconstructed
// different preimages, dropped each other's votes, and certified different rotation rounds — two
// producers for one height, i.e. a fork out of local state. Relaxing it soundly needs the pin
// carried IN the vote and resolved against committed data, like the checkpoint QC; until then the
// span recovers FINALITY over blocks a live producer keeps making, and a dead producer costs
// liveness. quorum_size everywhere is the fail-closed side of that trade.

/// Committee members this node has a signature-verified consensus message from inside the stall
/// window. Published by the consensus loop so the halt test and the operator RPC read ONE view —
/// two different liveness answers would let an operator arm on numbers the engine disagrees with.
pub static RC_HEARD: once_cell::sync::Lazy<parking_lot::RwLock<std::collections::HashSet<String>>> =
    once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(std::collections::HashSet::new()));

pub fn rc_publish_heard(live: std::collections::HashSet<String>) { *RC_HEARD.write() = live; }

pub fn rc_recent_consensus_senders() -> std::collections::HashSet<String> { RC_HEARD.read().clone() }

/// The committee the consensus loop is currently driving — the SAME set `verify_msg`'s membership
/// gate filters inbound messages against, so `RC_HEARD` and this denominator come from one
/// population. It is also the set a relaxed certificate is quorum-checked over. Published by the loop
/// because counting a different set made the arm unreachable at scale: a near-disjoint sample yields
/// tens of "live" members against a relaxed quorum of hundreds, so the arm refuses forever.
pub static RC_COMMITTEE: once_cell::sync::Lazy<parking_lot::RwLock<Vec<String>>> =
    once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(Vec::new()));

pub fn rc_publish_committee(committee: Vec<String>) { *RC_COMMITTEE.write() = committee; }

pub fn rc_current_committee() -> Vec<String> { RC_COMMITTEE.read().clone() }

/// Why an arm attempt was refused. Reported verbatim by node_armRecovery so an operator sees the
/// reason rather than a silent false.
pub enum RcArmRefusal {
    /// Master switch off. Kept so the mechanism can be disabled without touching any gate.
    Disabled,
    NotHalted,
    AnchorMissing,
    AnchorRelaxed,
    CommitteeBelowFloor(usize),
    QuorumStillReachable(usize, usize),
    TooFewLive(usize, usize),
}

impl RcArmRefusal {
    pub fn reason(&self) -> String {
        match self {
            RcArmRefusal::Disabled => "recovery_relaxation_disabled".to_string(),
            RcArmRefusal::NotHalted => "not_halted".to_string(),
            RcArmRefusal::AnchorMissing => "anchor_missing".to_string(),
            RcArmRefusal::AnchorRelaxed => "anchor_relaxed".to_string(),
            RcArmRefusal::CommitteeBelowFloor(n) => format!("committee_below_floor n={}", n),
            RcArmRefusal::QuorumStillReachable(h, q) => format!("quorum_still_reachable heard={} q={}", h, q),
            RcArmRefusal::TooFewLive(h, r) => format!("too_few_live heard={} relaxed_q={}", h, r),
        }
    }
}

/// Evaluate the halt condition and arm on success. `heard` = committee members this node has a
/// signature-verified consensus message from inside the stall window.
///
/// Every condition is mandatory for BOTH the operator RPC and the automatic path — the operator can
/// only shorten the stall wait, never bypass the floor, the halt itself, or the no-chained-span rule.
pub fn rc_try_arm(
    storage: &Storage,
    heard: &std::collections::HashSet<String>,
    stalled: bool,
) -> Result<(u64, [u8; 32], u64), RcArmRefusal> {
    let out = rc_try_arm_dry(storage, heard, stalled)?;
    *RC_ARMED.write() = Some(out);
    if is_warn() {
        println!("[WARN][RC] armed anchor_mb={} cp_index={}", out.0, out.2);
    }
    Ok(out)
}

/// Every condition of `rc_try_arm`, evaluated with NO side effect. Lets the operator RPC report the
/// real refusal reason without arming, so the actual arm can be left to the consensus loop — which is
/// the only place that can also tell the driver and honour its refusal.
pub fn rc_try_arm_dry(
    storage: &Storage,
    heard: &std::collections::HashSet<String>,
    stalled: bool,
) -> Result<(u64, [u8; 32], u64), RcArmRefusal> {
    if !RC_ENABLED { return Err(RcArmRefusal::Disabled); }
    use qnet_consensus::checkpoint_bft::{Checkpoint, QuorumCertificate, RELAXED_MIN_COMMITTEE,
                                         checkpoint_content_digest, quorum_size, relaxed_quorum};
    if !stalled { return Err(RcArmRefusal::NotHalted); }
    let a = storage.last_sealed_mb_index();
    if a == 0 { return Err(RcArmRefusal::AnchorMissing); }
    let mb_a = storage.get_macroblock_by_height(a).ok().flatten()
        .and_then(BlockchainNode::macroblock_plaintext)
        .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok())
        .ok_or(RcArmRefusal::AnchorMissing)?;
    let (cp_a, _qc_a): (Checkpoint, QuorumCertificate) = mb_a.consensus_data.checkpoint_qc.as_ref()
        .and_then(|b| bincode::deserialize(b).ok())
        .ok_or(RcArmRefusal::AnchorMissing)?;
    // No chained spans: the anchor must itself be full-quorum-sealed. Enforced HERE, not at the
    // macroblock authority: which certificate a node stored for the anchor window is per-node data
    // (`MacroBlock::hash` omits consensus_data, so a pinned and an unpinned certificate for one
    // window are the same block), and a validity rule may read nothing that varies between them.
    // As a participation rule it still binds — a chained pin needs relaxed_quorum SIGNATURES, and no
    // honest node signs a pin it did not arm.
    if cp_a.recovery_anchor.is_some() { return Err(RcArmRefusal::AnchorRelaxed); }
    // Liveness over the committee the loop is DRIVING, which is the population `heard` is filtered
    // to and the set a relaxed certificate is checked over — so the census answers the question that
    // decides the span: can the relaxed quorum actually be reached.
    let cs = rc_current_committee();
    if cs.len() < RELAXED_MIN_COMMITTEE { return Err(RcArmRefusal::CommitteeBelowFloor(cs.len())); }
    let live = cs.iter().filter(|id| heard.contains(*id)).count();
    let q = quorum_size(cs.len());
    let qr = relaxed_quorum(cs.len());
    // Strictly between the two thresholds: at or above `q` the chain is not quorum-blocked (the halt
    // is something else and relaxing would not fix it); below `qr` the relaxation cannot help either.
    if live >= q { return Err(RcArmRefusal::QuorumStillReachable(live, q)); }
    if live < qr { return Err(RcArmRefusal::TooFewLive(live, qr)); }
    // The pin names the anchor by its checkpoint CONTENT digest — MacroBlock::hash() omits
    // consensus_data, so a block hash cannot authenticate anything the resolver reads out of it.
    let ah = checkpoint_content_digest(&cp_a);
    if is_warn() {
        println!("[WARN][RC] arm_eligible anchor_mb={} cp_index={} committee={} q_strict={} q_relaxed={} live={}",
                 a, cp_a.index, cs.len(), q, qr, live);
    }
    Ok((a, ah, cp_a.index))
}

/// Clear the arm. Called the instant a macroblock above `A + 2` seals — the span is over and the
/// chain is back on the strict threshold.
pub fn rc_disarm() {
    if RC_ARMED.write().take().is_some() && is_warn() {
        println!("[WARN][RC] disarmed reason=span_complete");
    }
}

// The span used to override the committee to the anchor macroblock's own C_S. It no longer does,
// anywhere: C_S and the committee derived for a stuck window are two independent VRF samples of one
// roster, so at scale they are near-disjoint and a relaxed quorum over C_S need not intersect a
// strict quorum over the derived set — a two-content finality fork with no Byzantine node at all.
// The span relaxes the THRESHOLD only, over the committee every path already derives.

/// Value-TX ML-DSA-65 verify concurrency, sized to cores. TWO reserved pools so a cheap mempool
/// flood on the admission lane can never starve consensus block-validation (cross-lane DoS).
fn value_verify_permits() -> usize {
    std::env::var("QNET_VALUE_VERIFY_PERMITS").ok().and_then(|s| s.parse::<usize>().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)).max(4)
}
/// Admission lane (RPC + gossip): try_acquire, fail-closed — the external client resubmits.
pub(crate) static VALUE_TX_VERIFY_SEM: once_cell::sync::Lazy<tokio::sync::Semaphore> =
    once_cell::sync::Lazy::new(|| tokio::sync::Semaphore::new(value_verify_permits()));
/// Block-validation lane: reserved pool, AWAITED. A valid block is never rejected for local CPU
/// busy — the reject verdict must stay a pure function of TX bytes, never of local load.
pub(crate) static BLOCK_VERIFY_SEM: once_cell::sync::Lazy<tokio::sync::Semaphore> =
    once_cell::sync::Lazy::new(|| tokio::sync::Semaphore::new(value_verify_permits()));

/// Which verify lane a caller runs on — selects the semaphore + acquire policy above.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum VerifyLane { Admission, Block }

/// Whether a NodeReactivation's wire key matches the vrf_pk committed for its sender
/// (see BlockchainNode::reactivation_key_state).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReactivationKey { NotApplicable, Bound, Mismatch, Unknown }

/// FIX-5 pk-elision resolution verdict (see BlockchainNode::rehydrate_elided_pk).
///   Resolved      — wire pk present, or filled from committed state → verify may proceed.
///   Unresolved    — elided AND no committed pk for tx.from → caller MUST defer, NEVER hard-reject
///                   (an absent committed pk is indistinguishable from not-yet-synced; rejecting it
///                   would let a snapshot/catch-up node deterministically drop a valid canonical
///                   block → fork).
///   NotApplicable — not an elidable value TX → leave untouched.
pub(crate) enum PkResolve { Resolved, Unresolved, NotApplicable }

/// Producer pre-apply classification for one candidate tx (see BlockchainNode::producer_tx_prepare).
///   Admit         — keep in the block, no signature verify needed (system TX, sig-less burn-authorized reg).
///   Evict         — genuinely inadmissible (bad structure / missing sig) → drop AND remove from mempool.
///   Defer         — elided value-TX whose committed pk isn't present on THIS node yet → exclude from THIS
///                   block but KEEP in mempool for a later block (mirror the validator's committee_deferred;
///                   hard-evicting a not-yet-resolvable VALID tx would silently lose it).
///   Verify(clone) — needs an ML-DSA-65 verify; the clone carries the (possibly rehydrated) pk.
pub(crate) enum TxPrep { Admit, Evict, Defer, Verify(qnet_state::Transaction) }

/// Positive-only ML-DSA-65 verify memo. A hit proves this exact (pk, sig, canonical-msg) already
/// passed open()+eon-bind, so admission's verify is not repeated at block-validation / producer
/// re-check (halves value-TX verify CPU). Bounded, approximate eviction — a miss just re-verifies.
/// Never keyed on tx.hash (sig-unbound → forgeable) and negatives are never stored (flood-DoS).
static VALUE_VERIFY_CACHE: once_cell::sync::Lazy<dashmap::DashMap<[u8; 32], ()>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);
const VALUE_VERIFY_CACHE_CAP: usize = 262_144; // ~8 MB of 32-byte keys

fn value_verify_cache_put(key: [u8; 32]) {
    let c: &dashmap::DashMap<[u8; 32], ()> = &VALUE_VERIFY_CACHE;
    if c.len() >= VALUE_VERIFY_CACHE_CAP {
        // Drop a couple of arbitrary entries to stay bounded (O(1); a miss re-verifies).
        let victims: Vec<[u8; 32]> = c.iter().take(2).map(|e| *e.key()).collect();
        for v in victims { c.remove(&v); }
    }
    c.insert(key, ());
}

/// Production ceiling, a pure function of committed scalars (identical on every honest node). The ONE
/// bound is the frozen-roster horizon: MAX_DERIVED_ROSTER_WINDOWS windows past the last seal. There is
/// deliberately NO finality-height ceiling — its release condition would be a QC over the disputed
/// tail, i.e. the very thing a stall removes; A1 keeps producing off the frozen anchor instead.
/// `last_finalized` is accepted for the callers' symmetry but unused. Local pacing only, never hashed.
pub(crate) fn production_throttle_reason(next_block_height: u64, last_finalized: u64, seal_base: u64) -> Option<&'static str> {
    let _ = last_finalized;
    // A1: production does not stop when finality stops — roster and seed come from the frozen anchor
    // M_A (frozen_roster / frozen_beacon), pure functions of sealed bytes. The one ceiling is the
    // frozen horizon: MAX_DERIVED_ROSTER_WINDOWS windows past the last seal, then park and sync (an
    // unbounded unfinalized tail is an unbounded reorg). Pure scalars ⇒ all nodes park at one height.
    const MAX_DERIVED_BLOCKS: u64 = (BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64)
        * qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
    let seal_over = seal_base > 0 && next_block_height > seal_base + MAX_DERIVED_BLOCKS;
    if seal_over { Some("roster_derivation_horizon") } else { None }
}

/// Local right-to-produce precondition — the companion to production_throttle_reason.
/// Reads ONLY committed local facts: this node's own content-verified finality marker and whether
/// the parent body is in its own store. Deliberately no peer count, no peer height, no freshness
/// window: an input shared by every node cannot tell isolation (asymmetric) from a dead observation
/// channel (symmetric), and failing closed on a symmetric input halts the whole cluster at once.
/// Some(reason) ⇒ must not build this height.
pub(crate) fn production_local_precondition(storage: &Storage, next_block_height: u64) -> Option<&'static str> {
    // Never build at or below our own finality marker: fork-choice early-returns there, so such a
    // block can never be canonical, and the height is settled by an n-f QC over content this node
    // re-verified itself.
    if next_block_height <= LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::SeqCst) {
        return Some("at_or_below_finalized");
    }
    // Parent must be held locally. This is the anti-sibling fact the corroboration gate approximated
    // in network terms: a node without h-1 cannot chain at h at all.
    if next_block_height > 1 {
        let prev = next_block_height - 1;
        let held = storage.load_microblock_auto_format(prev).ok().flatten().is_some();
        if !held {
            return Some("missing_parent");
        }
    }
    None
}

// failover_slot_height REMOVED: the failover vote key derives from the voter's OWN verified tip
// (window = (tip+1)/90) + f+1 committee-signed amplification — never from a peer-height frontier.

/// v4.6: Track last height at which VRF key was announced to peers
static LAST_VRF_KEY_ANNOUNCE_HEIGHT: AtomicU64 = AtomicU64::new(0);

// CRITICAL FIX v2.48: Track ACTUALLY FINALIZED consensus round
// Updated ONLY when MacroBlock is SAVED in storage (not at spawn!)
// This prevents round mismatch between nodes
pub static LAST_FINALIZED_CONSENSUS_ROUND: AtomicU64 = AtomicU64::new(0);

/// Highest microblock height this node has ever signed as producer. Mirrors the durable
/// metadata watermark; monotone, never lowered by rollback.
pub static HIGHEST_SIGNED_HEIGHT: AtomicU64 = AtomicU64::new(0);

// v3.33: FORMAL FINALITY — blocks at or below this height are IRREVERSIBLE.
// Updated when macroblock is saved (macroblock covers 90 microblocks).
// All rollback paths MUST check this: rollback below finalized height is FORBIDDEN.
// This provides the same guarantee as Casper FFG checkpoints.
/// Max anchor lag the heartbeat admission rule allows. An epoch's liveness is therefore only SETTLED
/// this many blocks past its end — sampling eligibility before that reads a set no later observer can
/// reproduce.
pub const HB_ANCHOR_MAX_LAG: u64 = 90;

/// Height whose inline-apply rebuild failed. Non-zero ⇒ RAM state is UNVOUCHED and this node must
/// not produce: shipping a block built on it would fork the node off. NEVER cleared in-process — a
/// restart is the only way to rebuild RAM safely.
pub static INLINE_APPLY_UNVOUCHED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub static LAST_FINALIZED_HEIGHT: AtomicU64 = AtomicU64::new(0);

/// FIX R23-F3: Weak subjectivity checkpoint — prevents long-range attacks.
/// A syncing node MUST NOT accept a chain whose tip is below this height.
/// Updated via env var QNET_WEAK_SUBJECTIVITY_CHECKPOINT or hardcoded after each release.
/// Genesis/testnet: 0 (no checkpoint). Production: set to recent finalized height.
pub static WEAK_SUBJECTIVITY_CHECKPOINT: AtomicU64 = AtomicU64::new(0);

/// FIX R23-F3: Initialize weak subjectivity checkpoint from env or config.
pub fn init_weak_subjectivity_checkpoint() {
    if let Ok(val) = std::env::var("QNET_WEAK_SUBJECTIVITY_CHECKPOINT") {
        if let Ok(height) = val.parse::<u64>() {
            WEAK_SUBJECTIVITY_CHECKPOINT.store(height, std::sync::atomic::Ordering::SeqCst);
            println!("[INFO][FINALITY] weak_subjectivity_checkpoint={}", height);
        }
    }
}

/// FIX R23-F3: Validate chain tip against weak subjectivity checkpoint.
/// Called during initial sync to reject chains that are too old.
pub fn check_weak_subjectivity(chain_tip: u64) -> Result<(), String> {
    let checkpoint = WEAK_SUBJECTIVITY_CHECKPOINT.load(std::sync::atomic::Ordering::SeqCst);
    if checkpoint > 0 && chain_tip < checkpoint {
        Err(format!(
            "WEAK_SUBJECTIVITY_VIOLATION: chain_tip={} is below checkpoint={}. \
             This chain may be a long-range attack fork. Update your node or verify the chain.",
            chain_tip, checkpoint
        ))
    } else {
        Ok(())
    }
}

/// Snapshot-anchor weak-subjectivity floor (runtime). A cold-join snapshot to height H
/// (macroblock A = H/90) verified its n−f anchor QC + Pattern-C state ⇒ that anchor is the
/// joiner's trusted floor: macroblocks <= A are trusted history, not re-validated via the N-2
/// lineage walk nor via sub-anchor microblocks the snapshot legitimately omits. 0 for
/// warm/genesis nodes ⇒ every gate below behaves identically to today.
pub static SNAPSHOT_ANCHOR_MB: AtomicU64 = AtomicU64::new(0);
static SNAPSHOT_ANCHOR_HASH: [AtomicU64; 4] =
    [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];

fn store_anchor_hash(h: &[u8; 32]) {
    for i in 0..4 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&h[i * 8..i * 8 + 8]);
        SNAPSHOT_ANCHOR_HASH[i].store(u64::from_le_bytes(b), std::sync::atomic::Ordering::SeqCst);
    }
}
fn load_anchor_hash() -> [u8; 32] {
    let mut h = [0u8; 32];
    for i in 0..4 {
        h[i * 8..i * 8 + 8]
            .copy_from_slice(&SNAPSHOT_ANCHOR_HASH[i].load(std::sync::atomic::Ordering::SeqCst).to_le_bytes());
    }
    h
}

/// Effective WS FLOOR = max(embedded genesis WS, locally-adopted snapshot anchor) by index. Consensus
/// validation reads `.0` as the below-which-we-don't-re-verify floor so the lineage walk stops at the
/// joiner's verified anchor instead of reaching toward genesis for history it does not hold. NOTE: the
/// returned `.1` for a runtime anchor is the END of an already-verified lineage, NOT an inductive
/// trust root — verify_v2_macroblock roots the cold-join walk in the BINARY pin (genesis_constants::
/// ws_checkpoint()) / the genesis committee, never in this self-reported hash.
pub fn effective_ws_checkpoint() -> (u64, [u8; 32]) {
    let gen = crate::genesis_constants::ws_checkpoint();
    let anchor = SNAPSHOT_ANCHOR_MB.load(std::sync::atomic::Ordering::SeqCst);
    if anchor > gen.0 { (anchor, load_anchor_hash()) } else { gen }
}

/// Adopt the snapshot anchor as the trusted finality + WS floor, AFTER the genesis/pin-rooted lineage
/// walk verified the macroblock chain up to it (verify_snapshot_consensus_binding) and Pattern-C bound
/// its state. The checkpoint QC is n−f ⇒ finality by definition, so the joiner lifts finality to the
/// anchor height without replaying sub-anchor microblocks. `anchor_hash` is stored only as the local
/// skip-reverify marker (the END of the verified lineage), never as the inductive root for a future
/// joiner — that root stays the binary WS pin / genesis keys.
pub fn adopt_snapshot_finality(snapshot_height: u64, anchor_hash: [u8; 32]) {
    let anchor_mb = snapshot_height / 90;
    if anchor_mb == 0 { return; }
    // Honest producers snapshot only on a macroblock boundary, and this height is
    // peer-advertised. A floor check admits any off-boundary value straight into the finality
    // markers; the modulus is the shape check that belongs at the writer, not at one caller.
    if snapshot_height % qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL != 0 {
        if is_warn() {
            println!("[WARN][SNAPSHOT] finality_adopt_refused h={} reason=off_macro_boundary", snapshot_height);
        }
        return;
    }
    store_anchor_hash(&anchor_hash);
    SNAPSHOT_ANCHOR_MB.store(anchor_mb, std::sync::atomic::Ordering::SeqCst);
    // Finality advance under FINALITY_MUTEX: try_advance_finality does a non-atomic load-check-store
    // under the same lock, so an unlocked fetch_max here could be clobbered down by a concurrent stale
    // round. adopt is sync (no .await, no re-entry), so the parking_lot guard is held microseconds.
    {
        let _g = crate::storage::lock_finality_state();
        LAST_FINALIZED_CONSENSUS_ROUND.fetch_max(snapshot_height, std::sync::atomic::Ordering::SeqCst);
        LAST_FINALIZED_HEIGHT.fetch_max(snapshot_height, std::sync::atomic::Ordering::SeqCst);
    }
    WEAK_SUBJECTIVITY_CHECKPOINT.fetch_max(snapshot_height, std::sync::atomic::Ordering::SeqCst);
    // Seed the apply frontier + QC frontier to the anchor so the joiner tails from anchor+1 (no genesis
    // replay) and the bulk-sync target isn't collapsed to chain_height/90. fetch_max ⇒ only advances.
    crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.fetch_max(snapshot_height, std::sync::atomic::Ordering::SeqCst);
    QC_VERIFIED_FRONTIER.fetch_max(anchor_mb.saturating_mul(90), std::sync::atomic::Ordering::SeqCst);
    // Install the contiguous apply-frontier WITH the floor (atomic adoption). The apply-dedup gate
    // treats height<=SNAPSHOT_ANCHOR_MB*90 as already-final, so chain_height must never trail the
    // anchor — otherwise sync re-requests sub-anchor bodies that apply forever dup-skips → wedge. The
    // bound snapshot legitimately replaces sub-anchor bodies, so the anchor IS the contiguous base.
    // Raise-only; the clean fast_sync path already sets this, recovery/catch-up adopts did not.
    if let Some(storage) = try_get_storage() {
        if storage.get_chain_height().unwrap_or(0) < snapshot_height {
            if let Err(e) = storage.set_chain_height(snapshot_height) {
                if is_warn() { println!("[WARN][SYNC] adopt_set_chain_height_fail h={} err={}", snapshot_height, e); }
            }
        }
    }
    persist_snapshot_anchor(anchor_mb, &anchor_hash);
    println!("[INFO][SYNC] snapshot_finality_adopted h={} mb={}", snapshot_height, anchor_mb);
}

/// Persist the adopted anchor (anchor_mb LE ++ hash) so a warm restart reloads the trusted floor.
fn persist_snapshot_anchor(anchor_mb: u64, anchor_hash: &[u8; 32]) {
    if let Some(storage) = try_get_storage() {
        let mut bytes = Vec::with_capacity(40);
        bytes.extend_from_slice(&anchor_mb.to_le_bytes());
        bytes.extend_from_slice(anchor_hash);
        if let Err(e) = storage.put_snapshot_anchor(&bytes) {
            if is_warn() { println!("[WARN][SYNC] snapshot_anchor_persist_failed mb={} err={}", anchor_mb, e); }
        }
    }
}

/// Reload the persisted snapshot anchor at boot, BEFORE the first live block, so a warm-restarted
/// cold-joiner keeps its trusted floor (SNAPSHOT_ANCHOR_MB is a process static a restart resets to 0).
/// Monotonic; no-op for warm/genesis nodes (no persisted anchor).
pub fn reload_snapshot_anchor() {
    let storage = match try_get_storage() { Some(s) => s, None => return };
    let bytes = match storage.get_snapshot_anchor() { Ok(Some(b)) if b.len() == 40 => b, _ => return };
    let mut mb = [0u8; 8]; mb.copy_from_slice(&bytes[0..8]);
    let anchor_mb = u64::from_le_bytes(mb);
    if anchor_mb == 0 { return; }
    let mut hash = [0u8; 32]; hash.copy_from_slice(&bytes[8..40]);
    let prev = SNAPSHOT_ANCHOR_MB.fetch_max(anchor_mb, std::sync::atomic::Ordering::SeqCst);
    if anchor_mb > prev { store_anchor_hash(&hash); }
    let anchor_h = anchor_mb.saturating_mul(90);
    LAST_FINALIZED_HEIGHT.fetch_max(anchor_h, std::sync::atomic::Ordering::SeqCst);
    LAST_FINALIZED_CONSENSUS_ROUND.fetch_max(anchor_h, std::sync::atomic::Ordering::SeqCst);
    // Restore the WS security floor (= anchor height) so a crash right after promote is fail-LOW and
    // healed here, never fail-high (a lower WS floor would let the binder accept a snapshot below the
    // adopted finality).
    WEAK_SUBJECTIVITY_CHECKPOINT.fetch_max(anchor_h, std::sync::atomic::Ordering::SeqCst);
    // Heal the contiguous frontier up to the reloaded floor: a node whose chain_height was driven
    // below the anchor by a pre-restart rollback would otherwise re-wedge (durable chain_height <
    // reloaded anchor ⇒ sub-anchor re-request loop). Raise-only; runs once at boot before live blocks.
    if storage.get_chain_height().unwrap_or(0) < anchor_h {
        let _ = storage.set_chain_height(anchor_h);
    }
    if is_info() { println!("[INFO][SYNC] snapshot_anchor_reloaded mb={} h={}", anchor_mb, anchor_h); }
}

/// v9.0 BUG-30: Check if rollback to target_height is allowed by finality rules.
/// LEGACY v14.8: Non-atomic finality check. Exists only for diagnostic paths
/// that need to inspect the current finality boundary WITHOUT claiming the
/// rollback slot. All write-side rollback paths MUST instead use
/// `crate::storage::begin_finality_guarded_rollback(target, finalized_h)`,
/// which atomically combines the check with claiming the slot so that no
/// thread can advance finality between the check and the delete loop.
#[allow(dead_code)]
pub fn check_finality_allows_rollback(target_height: u64) -> Result<(), String> {
    let finalized_height = LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::SeqCst);
    if finalized_height > 0 && target_height < finalized_height {
        Err(format!(
            "FINALITY_VIOLATION: rollback to {} blocked — blocks up to {} are finalized",
            target_height, finalized_height
        ))
    } else {
        Ok(())
    }
}

/// v10.0: UNIFIED ROLLBACK CLEANUP — single function for ALL rollback paths.
/// Prevents the bug where a new rollback path forgets to clear entropy/vote caches.
/// Called after blocks are deleted and height is updated.
pub fn complete_rollback_cleanup(target_height: u64) {
    // Both caches are read ahead of storage; a stale entry above the rollback point lets an
    // orphaned child pass chain-continuity and persist parentless.
    if let Some(s) = try_get_storage() { s.invalidate_recent_microblocks_above(target_height); }
    crate::unified_p2p::truncate_stored_height(target_height);
    crate::unified_p2p::clear_all_pending_sync();
    crate::unified_p2p::clear_all_pending_sync_macroblocks();
    clear_expected_producer_cache_above(target_height);
    PRODUCER_VOTES.retain(|k, _| k.0 < target_height);
    // No TC-state cleanup on rollback: the failover floor is derived from finality (a ratchet that
    // never regresses), and a certified round is a fact the rollback cannot unmake — keeping it lets
    // the node re-elect the network-agreed producer when it re-advances, instead of re-forking at round 0.
}


/// Unified finality advancement — the single entry point for ALL finality paths.
/// Advances LAST_FINALIZED_HEIGHT/ROUND monotonically; returns true once final
/// at/beyond `round`. The canonical chain is resolved by round-based fork-choice,
/// so this path never gates on entropy — it only moves finality forward.
pub fn try_advance_finality(round: u64, context: &str) -> bool {
    // v14.8.1: ATOMIC ROLLBACK INVARIANT — serialised via FINALITY_MUTEX.
    //
    // Holding the finality-state mutex across the full read-check-store
    // sequence eliminates the TOCTOU that atomic-only protection could not
    // close: a rollback claim cannot land between our read of
    // is_rollback_in_progress and our store to LAST_FINALIZED_HEIGHT while
    // we hold this lock. The mutex is held for microseconds; it never
    // covers `.await` points or storage I/O. Contention is negligible at
    // scale because macroblock finality ticks at epoch boundaries (~every
    // 90 s per mb), not per-microblock.
    let _finality_guard = crate::storage::lock_finality_state();

    if crate::storage::is_rollback_in_progress() {
        if is_warn() {
            println!("[WARN][{}] skip_finality_rollback_in_progress round={}", context, round);
        }
        return false;
    }
    // Finality is monotonic: a finalized height is irreversible and never moves
    // backward through this path. The only legitimate lowering is explicit fork
    // recovery, which resets the markers via direct stores under this same mutex —
    // never here. This guard keeps the single finality source robust when any
    // caller (the v2 checkpoint bridge or a legacy MB/ASYNC path) passes a stale
    // round: it can only advance, never regress what a later checkpoint finalized.
    let current = LAST_FINALIZED_CONSENSUS_ROUND.load(std::sync::atomic::Ordering::SeqCst);
    if round <= current {
        return true; // already final at/beyond this height — no-op success
    }
    LAST_FINALIZED_CONSENSUS_ROUND.store(round, std::sync::atomic::Ordering::SeqCst);
    LAST_FINALIZED_HEIGHT.store(round, std::sync::atomic::Ordering::SeqCst);
    // Release the finality mutex BEFORE the post-advance refresh so the invariant above (no storage I/O
    // under the lock) holds. On real advance: refresh the committee clamp anchor (once/epoch) + re-sign head.
    drop(_finality_guard);
    if let Some(storage) = try_get_storage() {
        refresh_current_committee(&storage, round);
        // Finality is irreversible, so branches at or below it can never be adopted — dropping
        // them here is what bounds the retained tree. Throttled to macroblock boundaries: the scan
        // is over headers, and running it every block would be pure overhead at 1 block/s.
        if round % qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL == 0 {
            let s = storage.clone();
            tokio::spawn(async move {
                tokio::task::spawn_blocking(move || { s.prune_branches_below_finality(round); }).await.ok();
            });
        }
    }
    if let Some(p2p) = try_get_p2p() {
        p2p.refresh_signed_head_throttled(round);
    }
    true
}

/// Re-feed the retained branch that continues from `from_height` back into the pipeline. After a
/// rollback the competing branch is already in the store (kept by hash, not deleted), so the chain
/// can continue from local data instead of a network round-trip. Returns how many blocks were
/// re-submitted. Feeding through the normal ingest path means every gate still applies — this is a
/// shortcut in transport only, never in validation.
pub fn adopt_retained_successor(storage: &Arc<Storage>, from_height: u64) -> usize {
    let ingest = match try_get_pipeline_ingest() { Some(i) => i, None => return 0 };
    let parent_hash = match storage.canonical_hash_at(from_height) { Some(h) => h, None => return 0 };
    let mut submitted = 0usize;
    let mut cursor = parent_hash;
    // Walk forward while exactly one retained child continues the chain. A branch point (more than
    // one child) is left to fork-choice — adopting either side here would be an arbitrary decision.
    loop {
        let children = storage.children_of(&cursor);
        if children.len() != 1 { break; }
        let child = children[0];
        let body = match storage.load_body_by_hash(&child) { Some(b) => b, None => break };
        let bytes = match bincode::serialize(&body) { Ok(b) => b, Err(_) => break };
        let ib = crate::block_pipeline::IngestBlock {
            height: body.height,
            data: bytes,
            block_type: "micro".to_string(),
            from_peer: "local_branch".to_string(),
            received_at: 0,
        };
        if !ingest.submit(ib) { break; }
        submitted += 1;
        cursor = child;
        if submitted >= 128 { break; } // bounded: the rest arrives through normal sync
    }
    submitted
}

/// Refresh the cached committee membership (anti-forgery head-clamp anchor) once per epoch. members =
/// committee node_ids (empty in the genesis era); genesis_ids always present so the 5 genesis stay an
/// anchor at any scale. O(R<=1000) recompute under the finality mutex, no-op when the epoch is unchanged.
fn refresh_current_committee(storage: &Storage, h: u64) {
    let epoch = h.saturating_sub(1) / 90 + 1;
    if epoch == crate::unified_p2p::CURRENT_COMMITTEE.read().epoch { return; }
    // Resolving is not the same fact as HOLDING. Stamping the epoch on the failure path latched an
    // EMPTY member set until finality crossed into the next epoch, and every consumer of
    // CURRENT_COMMITTEE then read "no members" as a fact rather than as "not yet".
    let members: std::collections::HashSet<String> = match BlockchainNode::committee_for_height(storage, h) {
        Some(v) => v.into_iter().collect(),
        None => {
            if is_warn() {
                println!("[WARN][CONS] committee_snapshot_deferred epoch={} h={} reason=n2_anchor_absent", epoch, h);
            }
            return;
        }
    };
    let genesis_ids: std::collections::HashSet<String> = (1..=crate::genesis_constants::genesis_node_count())
        .map(|i| format!("genesis_node_{:03}", i)).collect();
    *crate::unified_p2p::CURRENT_COMMITTEE.write() =
        std::sync::Arc::new(crate::unified_p2p::CommitteeSnapshot { epoch, members, genesis_ids });
}

/// v10.2: Atomic height update helper — DISK FIRST, RAM SECOND.
/// Updates all 3 height sources in one call to prevent inconsistency.
///
/// ORDER IS CRITICAL:
///   1. DISK (RocksDB) — persistent, survives crash
///   2. RAM (RwLock) — used by consensus engine
///   3. RAM (AtomicU64) — advertised to peers
///
/// If crash happens between 1 and 2: on restart, disk has correct height,
/// RAM will be initialized from disk. This is safe.
/// Previous order (RAM first, disk second) could leave RAM ahead of disk
/// after crash — causing chain_height/storage divergence.
pub async fn update_all_heights(
    height_lock: &tokio::sync::RwLock<u64>,
    storage: &crate::storage::Storage,
    new_height: u64,
) {
    // Step 1: DISK — persistent store (crash-safe)
    if let Err(e) = storage.set_chain_height(new_height) {
        eprintln!("[ERR][STORAGE] set_chain_height failed h={}: {}", new_height, e);
        // CRITICAL: Do NOT update RAM if disk write failed!
        // RAM ahead of disk = the exact bug that causes chain_height/storage divergence.
        return;
    }
    // Step 2: RAM (RwLock) — consensus engine reads
    {
        let mut h = height_lock.write().await;
        *h = new_height;
    }
    // Step 3: RAM (AtomicU64) — peer advertisement. Plain store: this mirrors storage+RAM atomically
    // INCLUDING the legitimate downward move of a fork-rollback (its sole caller), so it must lower.
    // Cold-join frontier monotonicity below the anchor is enforced at adopt + apply-commit, not here.
    crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.store(
        new_height, std::sync::atomic::Ordering::SeqCst
    );
}

// CRITICAL FIX v2.49: Prevent duplicate consensus tasks for same MacroBlock
// Only ONE consensus task can be active per MacroBlock index at any time
// Uses compare_exchange to atomically check-and-set
// Value 0 = no active consensus, Value N = consensus active for MB#N
pub static ACTIVE_CONSENSUS_MB: AtomicU64 = AtomicU64::new(0);

/// Releases the ACTIVE_CONSENSUS_MB lock if the consensus task exits WITHOUT signalling (a
/// content defer). Without this a deferred task leaks the lock for the rest of the epoch, so
/// the window is never re-attempted and finality wedges. Disarmed on success to keep the lock
/// held (overridden by the next epoch), matching prior semantics.
struct ActiveConsensusGuard { mb_idx: u64, signalled: bool }
impl Drop for ActiveConsensusGuard {
    fn drop(&mut self) {
        if !self.signalled {
            let _ = ACTIVE_CONSENSUS_MB.compare_exchange(
                self.mb_idx, 0,
                std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

/// May this node join THIS (unfinalized) window's checkpoint consensus? Synced nodes always may.
/// A SYNCING node may iff it holds the full window (local_h >= mb_end_height): it can build+sign
/// the checkpoint correctly, receivers' content_ok rejects any divergent vote, and the extra
/// committee participant only helps reach quorum (unblocks a macro-boundary finality-lag redrive).
/// A syncing node WITHOUT the window defers to macroblock sync instead.
pub(crate) fn checkpoint_participation_allowed(is_synchronized: bool, local_h: u64, mb_end_height: u64) -> bool {
    is_synchronized || local_h >= mb_end_height
}

// ═══════════════════════════════════════════════════════════════════════════════
// v3.10: FAILOVER METRICS - Track slot delay and timeout rounds for monitoring
// Used to detect network stalls and producer failures
// ═══════════════════════════════════════════════════════════════════════════════
static METRIC_SLOT_DELAY_MAX: AtomicU64 = AtomicU64::new(0);      // Max slot delay in current window
static METRIC_TIMEOUT_ROUND_MAX: AtomicU64 = AtomicU64::new(0);   // Max timeout_round in current window
static METRIC_FAILOVER_COUNT: AtomicU64 = AtomicU64::new(0);      // Total failover events (timeout_round > 0)
static METRIC_LAST_RESET: AtomicU64 = AtomicU64::new(0);          // Timestamp of last metrics reset
static METRIC_TIMESTAMP_REJECTIONS: AtomicU64 = AtomicU64::new(0); // Blocks rejected due to invalid timestamp

// ═══════════════════════════════════════════════════════════════════════════════
// COMMITTEE-ATTESTATION OBSERVABILITY METRICS
// ═══════════════════════════════════════════════════════════════════════════════
// These counters expose the per-microblock attestation layer to operators.
// They are reset on the same 5-minute rolling window as the failover metrics
// above. All updates are atomic relaxed-ordered (telemetry, not consensus).
// ═══════════════════════════════════════════════════════════════════════════════
static METRIC_ATTEST_BROADCAST_COUNT: AtomicU64 = AtomicU64::new(0);     // Block attestations this node broadcast
static METRIC_EMPTY_SLOT_BROADCAST_COUNT: AtomicU64 = AtomicU64::new(0); // Empty-slot attestations this node broadcast
static METRIC_EMPTY_SLOT_FAILOVERS: AtomicU64 = AtomicU64::new(0);       // Times empty-slot 2f+1 advanced rotation
static METRIC_FORK_KEEP_LOCAL_LAYER1: AtomicU64 = AtomicU64::new(0);     // 2f+1 supermajority kept local block
static METRIC_FORK_RESYNC: AtomicU64 = AtomicU64::new(0);                // Local chain abandoned, resyncing
static METRIC_LATEST_COMMITTEE_SIZE: AtomicU64 = AtomicU64::new(0);      // Last observed committee size

/// Process startup wall-clock timestamp. Set ONCE at first call to
/// `node_uptime_secs()` and never updated. Used by the LMD-GHOST layer to
/// gate chain-weight-based fork decisions until the local attestation store
/// has had time to populate from the gossip stream after a restart.
static NODE_START_TIMESTAMP: AtomicU64 = AtomicU64::new(0);

/// Minimum uptime (seconds) before a node trusts its local attestation store
/// for cumulative chain-weight comparison. Below this, the node falls back to
/// the conservative "2f+1 on disputed block" decision. Long enough to let the
/// gossip layer rebuild attestation state after restart at any committee
/// size up to the cap.
pub const ATTESTATION_WARMUP_SECS: u64 = 30;

/// Returns this node's uptime in seconds. Initialises the start timestamp on
/// first call (idempotent — multiple calls return monotonically increasing values).
#[inline]
pub fn node_uptime_secs() -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let start = NODE_START_TIMESTAMP.load(Ordering::Relaxed);
    if start == 0 {
        // First call: store now (CAS to win race with any concurrent caller).
        let _ = NODE_START_TIMESTAMP.compare_exchange(
            0, now, Ordering::Relaxed, Ordering::Relaxed,
        );
        return 0;
    }
    now.saturating_sub(start)
}

/// Returns true once the attestation store has had time to populate after
/// startup. Below this the LMD-GHOST chain-weight layer should defer to the
/// per-block 2f+1 rule alone, because the local attestation count for our
/// chain is artificially low (we missed the attestations broadcast before
/// our process started).
#[inline]
pub fn attestation_layer_warmed_up() -> bool {
    node_uptime_secs() >= ATTESTATION_WARMUP_SECS
}

/// Microblock slot duration. block_ts is a pure function of height anchored to
/// genesis (block_ts = genesis_ts + height*SLOT) ⇒ clock-independent: no drift,
/// no median ring, no NTP dependency, deterministic on every node.
pub const MICROBLOCK_INTERVAL_SECS: u64 = 1;

/// Genesis anchor for slot timestamps: block 0's signed timestamp, cached on
/// first load (immutable for the chain's life).
static GENESIS_TS_CACHE: AtomicU64 = AtomicU64::new(0);

/// Block 0's timestamp (the genesis wall-clock instant). 0 only before genesis exists.
pub fn genesis_timestamp(storage: &crate::storage::Storage) -> u64 {
    // GLOBAL_GENESIS_TIMESTAMP is the canonical anchor (set at block-0 apply) — prefer it
    // so generation and validation derive block_ts from one identical source.
    let g = crate::GLOBAL_GENESIS_TIMESTAMP.load(Ordering::Relaxed);
    if g != 0 { return g; }
    let c = GENESIS_TS_CACHE.load(Ordering::Relaxed);
    if c != 0 { return c; }
    let ts = storage.load_microblock_auto_format(0).ok().flatten().map(|b| b.timestamp).unwrap_or(0);
    if ts != 0 { GENESIS_TS_CACHE.store(ts, Ordering::Relaxed); }
    ts
}

/// Deterministic clock-independent timestamp for a microblock at `height`.
#[inline]
pub fn expected_block_timestamp(genesis_ts: u64, height: u64) -> u64 {
    genesis_ts.saturating_add(height.saturating_mul(MICROBLOCK_INTERVAL_SECS))
}

/// Get current failover metrics (for Prometheus/Grafana integration)
pub fn get_failover_metrics() -> (u64, u64, u64, u64) {
    (
        METRIC_SLOT_DELAY_MAX.load(Ordering::Relaxed),
        METRIC_TIMEOUT_ROUND_MAX.load(Ordering::Relaxed),
        METRIC_FAILOVER_COUNT.load(Ordering::Relaxed),
        METRIC_TIMESTAMP_REJECTIONS.load(Ordering::Relaxed),
    )
}

/// v3.12: Simplified failover metrics (removed NTP drift - now using proper timestamp validation)
#[derive(Debug, Clone, serde::Serialize)]
pub struct FailoverMetrics {
    pub max_slot_delay: u64,
    pub max_timeout_round: u64,
    pub failover_count: u64,
    pub timestamp_rejections: u64,
    pub window_seconds: u64,
    pub current_timeout_round: u64,
    pub genesis_timestamp: u64,
    pub current_time: u64,

    // Committee-attestation observability (per-microblock layer)
    pub attest_broadcast_count: u64,
    pub empty_slot_broadcast_count: u64,
    pub empty_slot_failovers: u64,
    pub fork_keep_local_layer1: u64,
    pub fork_resync_count: u64,
    pub latest_committee_size: u64,
    pub node_uptime_secs: u64,
}

/// v3.12: Get failover metrics for monitoring
pub fn get_extended_failover_metrics() -> FailoverMetrics {
    FailoverMetrics {
        max_slot_delay: METRIC_SLOT_DELAY_MAX.load(Ordering::Relaxed),
        max_timeout_round: METRIC_TIMEOUT_ROUND_MAX.load(Ordering::Relaxed),
        failover_count: METRIC_FAILOVER_COUNT.load(Ordering::Relaxed),
        timestamp_rejections: METRIC_TIMESTAMP_REJECTIONS.load(Ordering::Relaxed),
        window_seconds: 300,
        // Current BFT-agreed rotation round (HIGHEST_CERTIFIED_ROUND) stored by
        // the stall detector; 0 when network is in steady state.
        current_timeout_round: get_current_timeout_round(),
        genesis_timestamp: crate::GLOBAL_GENESIS_TIMESTAMP.load(Ordering::Relaxed),
        current_time: get_timestamp_safe(),

        // Committee-attestation observability
        attest_broadcast_count: METRIC_ATTEST_BROADCAST_COUNT.load(Ordering::Relaxed),
        empty_slot_broadcast_count: METRIC_EMPTY_SLOT_BROADCAST_COUNT.load(Ordering::Relaxed),
        empty_slot_failovers: METRIC_EMPTY_SLOT_FAILOVERS.load(Ordering::Relaxed),
        fork_keep_local_layer1: METRIC_FORK_KEEP_LOCAL_LAYER1.load(Ordering::Relaxed),
        fork_resync_count: METRIC_FORK_RESYNC.load(Ordering::Relaxed),
        latest_committee_size: METRIC_LATEST_COMMITTEE_SIZE.load(Ordering::Relaxed),
        node_uptime_secs: node_uptime_secs(),
    }
}

/// Periodic emission of committee-attestation metrics. Called from the same
/// path as `update_failover_metrics`'s 5-minute reset; logs the rolling
/// window's counters at INFO when there is non-trivial activity.
fn emit_attestation_metrics_window(window_secs: u64) {
    let attests = METRIC_ATTEST_BROADCAST_COUNT.swap(0, Ordering::Relaxed);
    let empty = METRIC_EMPTY_SLOT_BROADCAST_COUNT.swap(0, Ordering::Relaxed);
    let empty_failovers = METRIC_EMPTY_SLOT_FAILOVERS.swap(0, Ordering::Relaxed);
    let keep1 = METRIC_FORK_KEEP_LOCAL_LAYER1.swap(0, Ordering::Relaxed);
    let resync = METRIC_FORK_RESYNC.swap(0, Ordering::Relaxed);
    let committee = METRIC_LATEST_COMMITTEE_SIZE.load(Ordering::Relaxed);

    let any_activity = attests > 0 || empty > 0 || empty_failovers > 0
        || keep1 > 0 || resync > 0;

    if any_activity {
        println!(
            "[METRICS][ATTEST] window={}s committee={} attests={} empty_atts={} empty_failovers={} keep_local_layer1={} resync={}",
            window_secs, committee, attests, empty, empty_failovers, keep1, resync,
        );
    }
}

/// Update failover metrics (called from stall detection)
fn update_failover_metrics(slot_delay: u64, timeout_round: u64) {
    // Update max values
    let _ = METRIC_SLOT_DELAY_MAX.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        if slot_delay > current { Some(slot_delay) } else { None }
    });
    
    let _ = METRIC_TIMEOUT_ROUND_MAX.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        if timeout_round > current { Some(timeout_round) } else { None }
    });
    
    // Count failover events
    if timeout_round > 0 {
        METRIC_FAILOVER_COUNT.fetch_add(1, Ordering::Relaxed);
    }
    
    // Reset metrics every 5 minutes (300 seconds) for rolling window
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let last_reset = METRIC_LAST_RESET.load(Ordering::Relaxed);
    
    if now.saturating_sub(last_reset) > 300 {
        // Log metrics before reset
        let max_delay = METRIC_SLOT_DELAY_MAX.swap(0, Ordering::Relaxed);
        let max_round = METRIC_TIMEOUT_ROUND_MAX.swap(0, Ordering::Relaxed);
        let failovers = METRIC_FAILOVER_COUNT.swap(0, Ordering::Relaxed);
        METRIC_LAST_RESET.store(now, Ordering::Relaxed);

        // Committee-attestation metrics for the same rolling window
        emit_attestation_metrics_window(300);

        if max_delay > 0 || failovers > 0 {
            println!("[METRICS][FAILOVER] window=5min max_slot_delay={}s max_timeout_round={} failover_events={}",
                     max_delay, max_round, failovers);
        }
    }
}

// FIX v2.28: Counter for newly received certificates
// Retry loop checks this to trigger immediate retry when certificate arrives
pub static NEW_CERTIFICATE_COUNTER: AtomicU64 = AtomicU64::new(0);

// PRODUCTION v2.31: Rate limiting for concurrent macroblock check tasks
// Prevents spawn storm on high-traffic networks (100K+ nodes)
static ACTIVE_MACROBLOCK_CHECK_TASKS: AtomicU64 = AtomicU64::new(0);
const MAX_CONCURRENT_MACROBLOCK_CHECKS: u64 = 5;

// PRODUCTION v2.43.4: Backpressure for block broadcasts
// Limits concurrent broadcasts to prevent QUIC overload
// v2.43.2-v2.43.3 had network-ahead check that caused deadlocks - REMOVED
// Now using ONLY broadcast backpressure which naturally limits production speed
pub static PENDING_BROADCAST_COUNT: AtomicU64 = AtomicU64::new(0);
#[allow(dead_code)] // v24: gate removed, constant retained for telemetry compatibility
const MAX_PENDING_BROADCASTS: u64 = 2;  // Allow 2 concurrent broadcasts

// ═══════════════════════════════════════════════════════════════════════════
// QNET STRUCTURED LOGGING SYSTEM v2.32
// ═══════════════════════════════════════════════════════════════════════════
// Professional logging for production validators
// 
// Levels (QNET_LOG_LEVEL env var):
//   0 = OFF    - No logs except panics
//   1 = ERROR  - Critical errors only
//   2 = WARN   - Errors + warnings (recommended for production)
//   3 = INFO   - Normal operation logs (default)
//   4 = DEBUG  - Detailed debugging
//   5 = TRACE  - Everything (performance impact!)
//
// Format: [LEVEL][MODULE] message key=value key2=value2
// Example: [INFO][BLOCK] produced height=1234 txs=50 ms=12
// ═══════════════════════════════════════════════════════════════════════════

pub static LOG_LEVEL: AtomicU64 = AtomicU64::new(3); // Default: INFO

/// Initialize logging from QNET_LOG_LEVEL environment variable
pub fn init_logging() {
    let level = std::env::var("QNET_LOG_LEVEL")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(3);
    LOG_LEVEL.store(level.min(5), std::sync::atomic::Ordering::Relaxed);
}

// Level checks - zero overhead when disabled via branch prediction
#[inline(always)] pub fn lvl() -> u64 { LOG_LEVEL.load(std::sync::atomic::Ordering::Relaxed) }
#[inline(always)] pub fn is_err() -> bool { lvl() >= 1 }
#[inline(always)] pub fn is_warn() -> bool { lvl() >= 2 }
#[inline(always)] pub fn is_info() -> bool { lvl() >= 3 }
#[inline(always)] pub fn is_debug() -> bool { lvl() >= 4 }
#[inline(always)] pub fn is_trace() -> bool { lvl() >= 5 }

// Per-block logging (reduces spam for high-frequency events)
#[inline(always)] pub fn log_every_n(h: u64, n: u64) -> bool { h <= 5 || h % n == 0 }
#[inline(always)] pub fn log_block(h: u64) -> bool { log_every_n(h, 100) || is_debug() }
#[inline(always)] pub fn log_block_10(h: u64) -> bool { log_every_n(h, 10) || is_trace() }

// NOTE: Removed ROTATION_NOTIFY - simple 1-second timing is more reliable
// Testing showed that natural timing without interrupts prevents race conditions

// ═══════════════════════════════════════════════════════════════════════════════
// CRITICAL FIX v2.96: Lock-free entropy responses using DashMap
// PROBLEM: std::sync::Mutex blocked tokio runtime during async operations
// SOLUTION: DashMap provides lock-free concurrent access - no blocking!
// ═══════════════════════════════════════════════════════════════════════════════
pub(crate) use dashmap::DashMap;

lazy_static::lazy_static! {
    /// v3.16: Lock-free concurrent HashMap for producer votes
    /// Key: (block_height, voter_node_id)
    /// Value: voted_producer_id
    /// Used for Byzantine 66% consensus on producer selection
    pub static ref PRODUCER_VOTES: DashMap<(u64, String), String> = DashMap::new();

}

/// v9.0: Equivocation evidence queue for timeout vote double-voting.
/// Key: (height, voter_id), Value: (round, detected_timestamp).
/// Drained at macroblock creation and included as slashing events.
pub static EQUIVOCATION_EVIDENCE: once_cell::sync::Lazy<DashMap<(u64, String), (u64, u64)>> =
    once_cell::sync::Lazy::new(|| DashMap::new());

/// v15.11 L6: Block-equivocation evidence — cryptographic proof that a producer
/// signed two different microblocks at the same height. Both signatures are
/// individually valid ML-DSA-65 attestations, which together form unforgeable
/// evidence that the producer violated the single-block-per-slot rule.
///
/// Detection paths:
///   1. Storage-level L4 guard at `save_microblock` — incoming block hashes
///      mismatch a previously-stored block at the same height.
///   2. Network-level L5 majority-wins resolver — peer reports a conflicting
///      block during apply pipeline.
///
/// Both paths funnel into this map. Drained at macroblock creation along with
/// timeout equivocations, included in the next macroblock's slashing list.
///
/// Storage shape:
///   Key:   (height, producer_id) — one offence per (slot, validator)
///   Value: BlockEquivocationEvidence { hash_a, hash_b, ts, header_a, header_b }
///
/// Both `(hash, sig)` pairs are kept so on-chain verifiers can re-check the
/// ML-DSA-65 signatures against the canonical signing message format and
/// confirm the offence without trusting the reporting node.
///
/// Memory: ~6.7 KB per offence (2 × ML-DSA-65 signatures + 2 × 32-byte hashes
/// + metadata). At 0.001 % equivocation rate × 1000-validator committee
/// × 1 epoch = ~70 KB. Cleared on macroblock inclusion.
#[derive(Debug, Clone)]
pub struct BlockEquivocationEvidence {
    pub hash_a: [u8; 32],
    pub hash_b: [u8; 32],
    pub detected_ts: u64,
    // Full signable headers of both conflicting blocks — used to build the on-chain
    // EquivocationProof TX (the rejected block is not in storage, so it is captured here).
    pub header_a: qnet_state::EquivocationHeader,
    pub header_b: qnet_state::EquivocationHeader,
}

pub static BLOCK_EQUIVOCATION_EVIDENCE: once_cell::sync::Lazy<DashMap<(u64, String), BlockEquivocationEvidence>> =
    once_cell::sync::Lazy::new(|| DashMap::new());

/// THE block-identity digest for equivocation — the fields that make two blocks DIFFERENT blocks.
///
/// Byte-identical to `MicroBlock::hash`'s field set, deliberately: the storage anti-fork guard
/// produces the evidence when those hashes differ, and the on-chain acceptor decides the ban from it.
/// If the two ever disagree, one of them is wrong about what a block IS.
///
/// It must NOT compare the signature or the VRF proof. Both are randomised ML-DSA outputs, so an
/// honest producer re-emitting the same block after a rollback signs different bytes over the same
/// digest — comparing them would turn a normal restart into a permanent, chain-committed ban.
pub(crate) fn equivocation_identity_hash(
    height: u64,
    producer_id: &str,
    h: &qnet_state::EquivocationHeader,
) -> [u8; 32] {
    let mut hasher = Sha3_256::new();
    hasher.update(&height.to_le_bytes());
    hasher.update(&h.timestamp.to_le_bytes());
    hasher.update(&h.previous_hash);
    hasher.update(&h.merkle_root);
    hasher.update(producer_id.as_bytes());
    hasher.update(&h.timeout_round.to_le_bytes());
    hasher.update(&h.carried_baseline.to_le_bytes());
    // Mirrors MicroBlock::hash, which binds state_root. Without it a state-root-only fork folds
    // pin-identical inputs on both sides — same txs, same merkle_root, deterministic timestamp,
    // and vrf_output is None in production — so hash_a == hash_b and the evidence is discarded
    // before it can be recorded. The fork would be rejected but never slashable.
    hasher.update(&h.state_root);
    qnet_state::block::fold_vrf_output(&mut hasher, &h.vrf_output);
    let mut out = [0u8; 32];
    out.copy_from_slice(&hasher.finalize());
    out
}

/// Records a block-equivocation offence for the next macroblock's slashing list.
///
/// Idempotent on (height, producer_id) — the first detection wins. Subsequent
/// reports for the same offence are dropped (the cryptographic proof is the
/// same; recording it twice has no incremental value but would inflate memory).
///
/// Caller MUST verify both signatures are valid ML-DSA-65 attestations from
/// `producer_id` over their respective `(height, hash_x)` messages BEFORE
/// calling — this function trusts its inputs and does not re-verify.
pub fn record_block_equivocation(
    height: u64,
    producer_id: &str,
    header_a: qnet_state::EquivocationHeader,
    header_b: qnet_state::EquivocationHeader,
) {
    let hash_a = equivocation_identity_hash(height, producer_id, &header_a);
    let hash_b = equivocation_identity_hash(height, producer_id, &header_b);
    if hash_a == hash_b {
        return; // Same block — not equivocation.
    }
    let now_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = (height, producer_id.to_string());
    let already_recorded = BLOCK_EQUIVOCATION_EVIDENCE.contains_key(&key);
    BLOCK_EQUIVOCATION_EVIDENCE.entry(key)
        .or_insert(BlockEquivocationEvidence {
            hash_a, hash_b, detected_ts: now_ts, header_a, header_b,
        });
    if !already_recorded {
        if is_warn() {
            println!("[WARN][SLASH] block_equivocation_recorded h={} producer={} ts={}",
                     height, producer_id, now_ts);
        }
        // Publish immediately: whoever detects is almost never the next producer, and evidence held
        // privately simply ages out. Only on the FIRST record, so a repeat sighting is not re-spam.
        gossip_pending_equivocation_evidence();
    }
}

/// Drains pending block-equivocation evidence into canonical `EquivocationProof`
/// system TXs for the block this node is producing. Evidence is ALSO gossiped at detection
/// (gossip_pending_equivocation_evidence) so a proof no longer depends on its own detector winning
/// a slot; the proof applies to state (banned_at_height) and is cryptographically re-verified at
/// admission and at block validity, so a forged one never lands.
/// Returns `(tx_hash, bincode_bytes)` pairs; drained entries are
/// removed (drain-once — multiple detectors give inclusion redundancy without
/// re-spamming the chain).
///
/// Canonical construction (identical on every detector, so the chain dedups
/// naturally and the fold is order-free): headers are ordered so the smaller
/// block-hash is `block_a`, `from = "system_slashing"`, `timestamp` taken from
/// the ordered `block_a` (NO wall-clock — keeps the TX hash reproducible).
/// `max` caps the per-block drain so an evidence burst can't blow the 1-sec
/// production deadline; the remainder is picked up by the next block produced.
/// Canonical `EquivocationProof` TX for one piece of evidence. SINGLE construction shared by the
/// producer drain and the gossip publisher, so every detector emits byte-identical bytes and the
/// chain dedups on hash instead of accumulating variants.
fn build_block_equivocation_tx(
    key: &(u64, String),
    ev: &BlockEquivocationEvidence,
) -> Option<(String, Vec<u8>)> {
    // Canonical header order — smaller block-hash is block_a (detection-order-free).
    let (block_a, block_b) = if ev.hash_a <= ev.hash_b {
        (ev.header_a.clone(), ev.header_b.clone())
    } else {
        (ev.header_b.clone(), ev.header_a.clone())
    };
    let mut tx = qnet_state::Transaction {
        hash: String::new(),
        from: "system_slashing".to_string(),
        to: None,
        amount: 0,
        nonce: 0,
        gas_price: 0,
        gas_limit: 0,
        timestamp: block_a.timestamp, // deterministic (no SystemTime)
        signature: None,
        public_key: None,
        tx_type: qnet_state::TransactionType::EquivocationProof {
            offender: key.1.clone(),
            height: key.0,
            block_a,
            block_b,
        },
        data: None,
        dilithium_signature: None,
        dilithium_public_key: None,
        chain_id: qnet_state::transaction::QNET_CHAIN_ID,
    };
    tx.hash = tx.calculate_hash();
    bincode::serialize(&tx).ok().map(|bytes| (tx.hash.clone(), bytes))
}

/// Publish pending block-equivocation evidence to peers WITHOUT draining it.
///
/// Evidence used to be block-level only, so a proof reached the chain solely if its own detector
/// happened to produce a block before the evidence aged out — at any real validator count that is
/// almost never, which is why the ban never fired. Gossiping cannot affect the VERDICT (the ban set
/// is recomputed from COMMITTED proofs and each one is cryptographically re-verified at admission
/// and at block validity); it only decides whether a proof ever reaches a producer at all.
pub fn gossip_pending_equivocation_evidence() {
    let p2p = match try_get_p2p() { Some(p) => p, None => return };
    for entry in BLOCK_EQUIVOCATION_EVIDENCE.iter() {
        if let Some((_, bytes)) = build_block_equivocation_tx(entry.key(), entry.value()) {
            let _ = p2p.broadcast_transaction(bytes);
        }
    }
}

pub fn drain_equivocation_proof_txs(max: usize) -> Vec<(String, Vec<u8>)> {
    if BLOCK_EQUIVOCATION_EVIDENCE.is_empty() {
        return Vec::new();
    }
    let keys: Vec<(u64, String)> = BLOCK_EQUIVOCATION_EVIDENCE
        .iter()
        .take(max)
        .map(|e| e.key().clone())
        .collect();
    let mut out: Vec<(String, Vec<u8>)> = Vec::with_capacity(keys.len());
    for key in keys {
        let ev = match BLOCK_EQUIVOCATION_EVIDENCE.get(&key) {
            Some(v) => v.clone(),
            None => continue,
        };
        match build_block_equivocation_tx(&key, &ev) {
            Some((tx_hash, bytes)) => {
                BLOCK_EQUIVOCATION_EVIDENCE.remove(&key);
                if is_warn() {
                    println!(
                        "[WARN][SLASH] equivocation_proof_tx_built offender={} h={} tx={}",
                        key.1, key.0, qnet_state::char_prefix(&tx_hash, 16),
                    );
                }
                out.push((tx_hash, bytes));
            }
            None => {
                if is_warn() {
                    println!("[WARN][SLASH] equivocation_proof_serialize_fail h={}", key.0);
                }
            }
        }
    }
    out
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHECKPOINT-VOTE EQUIVOCATION (accountable safety) — a committee member signing two
// DIFFERENT checkpoints at the SAME consensus round. Mirrors block equivocation but for
// BFT votes. Detection is purely OBSERVATIONAL on the inbound consensus path (never alters
// vote handling / QC formation). The proof carries BOTH full checkpoint preimages because a
// vote signature covers only the checkpoint hash — the round must be proven from the
// checkpoint content (its hash includes the index), else two honest votes from different
// rounds could be falsely paired into a forged "equivocation".
// ═══════════════════════════════════════════════════════════════════════════════

/// Recorded vote-equivocation offence: both full conflicting checkpoints (bincode) + the
/// offender's two consensus-key signatures. Self-validating in the fold.
#[derive(Debug, Clone)]
pub struct VoteEquivocationEvidence {
    pub checkpoint_a: Vec<u8>,
    pub sig_a: Vec<u8>,
    pub checkpoint_b: Vec<u8>,
    pub sig_b: Vec<u8>,
    pub detected_ts: u64,
}

/// (round index, voter) → recorded offence. Drained into VoteEquivocationProof TXs and removed.
pub static VOTE_EQUIVOCATION_EVIDENCE: once_cell::sync::Lazy<DashMap<(u64, String), VoteEquivocationEvidence>> =
    once_cell::sync::Lazy::new(|| DashMap::new());

/// (round index, checkpoint_hash) → bincode of the full Checkpoint proposed at that round —
/// lets the vote observer recover the preimage for a voted hash to build a SOUND proof.
static VOTE_PROPOSAL_CACHE: once_cell::sync::Lazy<DashMap<(u64, [u8; 32]), Vec<u8>>> =
    once_cell::sync::Lazy::new(|| DashMap::new());

/// (round index, voter) → the FIRST checkpoint_hash seen from that voter at that round. A second,
/// DIFFERENT hash at the same (round, voter) is equivocation. DETECTION only: 32 bytes, so the full
/// window costs tens of MB at a 1000-committee instead of the gigabytes a stored signature costs.
static VOTE_FIRST_SEEN: once_cell::sync::Lazy<DashMap<(u64, String), [u8; 32]>> =
    once_cell::sync::Lazy::new(|| DashMap::new());

/// (round index, voter) → the wire signature of that first vote, kept only long enough to BUILD a
/// proof. A ML-DSA-65 wire signature is ~7 KB and a proof is rare, so it is retained over a far
/// shorter window than detection; detection itself never reads this map.
static VOTE_FIRST_SIG: once_cell::sync::Lazy<DashMap<(u64, String), Vec<u8>>> =
    once_cell::sync::Lazy::new(|| DashMap::new());

/// Sliding retention window (rounds) for vote DETECTION — hashes only.
const VOTE_DETECT_WINDOW: u64 = 256;

/// Sliding retention window (rounds) for the proof-material signatures. A same-round double vote is
/// only consensus-relevant while its round is live — two indices from decision — so 8 rounds covers
/// every pair that can affect anything, at 1/32 of the detection window's memory. The cross-index
/// head arm needs both votes inside it too; a conflict detected past it is logged as unprovable.
const VOTE_SIG_WINDOW: u64 = 8;

/// Rounds between retention sweeps, and the index at which the next one is due.
const VOTE_SWEEP_STEP: u64 = 64;
static VOTE_SWEEP_NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Evict everything outside the retention windows. Driven by a monotone WATERMARK, not by
/// `index % STEP`: a view jump can step over every multiple of the step, and a halt advances the
/// index one view at a time while nothing commits — under a modulus the sweep could then never fire
/// while the maps keep growing. Called on EVERY observed vote, so no branch can skip retention.
fn vote_detect_sweep(index: u64) {
    use std::sync::atomic::Ordering;
    let due = VOTE_SWEEP_NEXT.load(Ordering::Relaxed);
    if index < due { return; }
    if VOTE_SWEEP_NEXT
        .compare_exchange(due, index.saturating_add(VOTE_SWEEP_STEP), Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return; // another thread is sweeping this step
    }
    let keep_sig = index.saturating_sub(VOTE_SIG_WINDOW);
    VOTE_FIRST_SIG.retain(|k, _| k.0 >= keep_sig);
    let keep = index.saturating_sub(VOTE_DETECT_WINDOW);
    VOTE_FIRST_SEEN.retain(|k, _| k.0 >= keep);
    VOTE_PROPOSAL_CACHE.retain(|k, _| k.0 >= keep);
    VOTE_PROPOSAL_COUNT.retain(|k, _| *k >= keep);
    VOTE_PROPOSAL_META.retain(|k, _| k.0 >= keep);
    // Head-keyed, so it prunes on the INDEX the first vote was cast at, not on the key.
    VOTE_HEAD_FIRST_SEEN.retain(|_, v| v.0 >= keep);
}

/// Evidence already held against this offender? A ban is permanent and write-once, so one proof per
/// offender is all that can ever be applied — and without this an equivocator that repeats every
/// round would grow the pending-evidence map (two full checkpoints per entry) for the whole halt.
fn vote_evidence_held_for(offender: &str) -> bool {
    !VOTE_EQUIVOCATION_EVIDENCE.is_empty()
        && VOTE_EQUIVOCATION_EVIDENCE.iter().any(|e| e.key().1 == offender)
}

/// A round has ONE honest proposal; an equivocating leader has two. Anything beyond that proves
/// nothing extra, and the admission gate accepts a Proposal from any committee MEMBER (not just the
/// leader), so an uncapped cache is a remotely-driven allocation: committee_size distinct checkpoints
/// per index, times the retention window, times megabytes each.
const MAX_PROPOSALS_PER_INDEX: usize = 4;

/// (round index) → how many distinct proposals were cached for it. Pruned with the caches below.
static VOTE_PROPOSAL_COUNT: once_cell::sync::Lazy<DashMap<u64, usize>> =
    once_cell::sync::Lazy::new(|| DashMap::new());

/// (round index, checkpoint_hash) -> (window head, content digest, recovery pin) of a cached
/// proposal. Lets the vote observer key a checkpoint by its HEAD without deserializing a Checkpoint
/// on every vote (up to committee-size votes per index). Same key, same cap and same pruning as
/// VOTE_PROPOSAL_CACHE, so it adds no unbounded state.
static VOTE_PROPOSAL_META: once_cell::sync::Lazy<DashMap<(u64, [u8; 32]), (u64, [u8; 32], Option<(u64, [u8; 32])>)>> =
    once_cell::sync::Lazy::new(|| DashMap::new());

/// (window head, voter) -> the FIRST vote seen from that voter at that head, as
/// (index, checkpoint_hash, content digest, pinned). EVERY observed vote is recorded, not only a
/// pinned one: an equivocator that votes unpinned-then-pinned at one head is convictable, and
/// recording only pinned first votes made exactly that ordering invisible. The pinned flag is kept
/// in the value and re-checked when a conflict is emitted, mirroring the engine's rule. No signature
/// is stored — the proof takes it from VOTE_FIRST_SIG, which already holds one per (index, voter).
static VOTE_HEAD_FIRST_SEEN: once_cell::sync::Lazy<DashMap<(u64, String), (u64, [u8; 32], [u8; 32], bool)>> =
    once_cell::sync::Lazy::new(|| DashMap::new());

/// Observe an authentic checkpoint PROPOSAL (call only AFTER its proposer sig verified): cache
/// its preimage so a later equivocating vote on it can be proven. Capped per round.
pub fn observe_checkpoint_proposal(index: u64, checkpoint_hash: [u8; 32], checkpoint_bytes: Vec<u8>) {
    if VOTE_PROPOSAL_CACHE.contains_key(&(index, checkpoint_hash)) { return; }
    {
        let mut count = VOTE_PROPOSAL_COUNT.entry(index).or_insert(0);
        if *count >= MAX_PROPOSALS_PER_INDEX { return; }
        *count += 1;
    }
    if let Ok(cp) = bincode::deserialize::<qnet_consensus::checkpoint_bft::Checkpoint>(&checkpoint_bytes) {
        VOTE_PROPOSAL_META.insert(
            (index, checkpoint_hash),
            (cp.window_head_height,
             qnet_consensus::checkpoint_bft::checkpoint_content_digest(&cp),
             cp.recovery_anchor));
    }
    VOTE_PROPOSAL_CACHE.insert((index, checkpoint_hash), checkpoint_bytes);
}

/// CROSS-INDEX arm of the vote detector, keyed on the WINDOW HEAD. Under a pin the checkpoint index
/// is deliberately free, so a member can certify two conflicting contents at one head without ever
/// double-voting at one index — invisible to the same-round detector, and the exact pair two
/// intersecting relaxed quorums need to fork. `CheckpointConsensus::on_proposal` refuses to sign it,
/// so an honest replica never produces this evidence.
///
/// EVERY observed vote at a head is recorded; the offence still needs at least one PINNED side (an
/// unpinned/unpinned pair is legal — a rollback may re-vote an uncertified window), which is checked
/// when the conflict is emitted, exactly as the engine checks it when refusing.
fn observe_head_vote(index: u64, voter: &str, checkpoint_hash: [u8; 32], signature: &[u8]) {
    let (head, digest, pin) = match VOTE_PROPOSAL_META.get(&(index, checkpoint_hash)) {
        Some(m) => *m.value(),
        None => return, // preimage unknown => no sound proof can be built from this vote
    };
    let pinned = pin.is_some();
    let key = (head, voter.to_string());
    let prior = VOTE_HEAD_FIRST_SEEN.get(&key).map(|e| *e.value());
    match prior {
        Some((first_index, first_hash, first_digest, first_pinned)) => {
            if first_digest == digest || first_hash == checkpoint_hash { return; }
            if !(first_pinned || pinned) { return; }
            let ev_key = (index, voter.to_string());
            if vote_evidence_held_for(voter) { return; }
            let sig_key = (first_index, voter.to_string());
            let hash_ok = VOTE_FIRST_SEEN.get(&sig_key).map(|e| *e.value() == first_hash).unwrap_or(false);
            let first_sig = match (hash_ok, VOTE_FIRST_SIG.get(&sig_key)) {
                (true, Some(e)) => e.value().clone(),
                // Detected, but the first vote's signature aged out of VOTE_SIG_WINDOW — the offence
                // is real and unprovable. Loud, because silence here reads as "no equivocation".
                _ => {
                    if is_warn() {
                        println!("[WARN][SLASH] vote_equivocation_unprovable head={} voter={} idx_first={} idx_new={} reason=first_signature_evicted",
                                 head, voter, first_index, index);
                    }
                    return;
                }
            };
            let cp_first = VOTE_PROPOSAL_CACHE.get(&(first_index, first_hash)).map(|e| e.value().clone());
            let cp_new = VOTE_PROPOSAL_CACHE.get(&(index, checkpoint_hash)).map(|e| e.value().clone());
            if let (Some(cp_first), Some(cp_new)) = (cp_first, cp_new) {
                // Canonical order (smaller hash = a) so every detector builds an identical TX.
                let (checkpoint_a, sig_a, checkpoint_b, sig_b) = if first_hash <= checkpoint_hash {
                    (cp_first, first_sig, cp_new, signature.to_vec())
                } else {
                    (cp_new, signature.to_vec(), cp_first, first_sig)
                };
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                VOTE_EQUIVOCATION_EVIDENCE.insert(ev_key, VoteEquivocationEvidence {
                    checkpoint_a, sig_a, checkpoint_b, sig_b, detected_ts: now,
                });
                if is_warn() {
                    println!("[WARN][SLASH] pinned_head_double_vote_recorded head={} voter={} idx_a={} idx_b={}",
                             head, voter, first_index, index);
                }
            }
        }
        None => { VOTE_HEAD_FIRST_SEEN.insert(key, (index, checkpoint_hash, digest, pinned)); }
    }
}

/// Observe an authentic checkpoint VOTE (call only AFTER verify_msg passed). Detects a same-round
/// double-vote and records sound evidence. Pure side effect — never influences vote handling.
/// Idempotent per (round, voter). Records only when BOTH checkpoint preimages are locally known
/// (best-effort, like the block L4 guard); a missing preimage simply yields no proof here.
pub fn observe_checkpoint_vote(index: u64, voter: &str, checkpoint_hash: [u8; 32], signature: Vec<u8>) {
    // Retention runs FIRST and unconditionally: every early return below is a path the old
    // sweep — buried in the insert arm behind `index % 64 == 0` — could not reach.
    vote_detect_sweep(index);
    observe_head_vote(index, voter, checkpoint_hash, &signature);
    let key = (index, voter.to_string());
    if vote_evidence_held_for(voter) { return; }
    let prior = VOTE_FIRST_SEEN.get(&key).map(|e| *e.value());
    match prior {
        Some(first_hash) => {
            if first_hash == checkpoint_hash { return; } // same vote re-seen — not equivocation
            // Keyed on committed CONTENT, mirroring the verifier: a pin frees the index, so one
            // replica legally votes twice at one round over the same position — once unpinned, once
            // pinned — and those two carry different hashes.
            let d_first = VOTE_PROPOSAL_META.get(&(index, first_hash)).map(|m| m.value().1);
            let d_new = VOTE_PROPOSAL_META.get(&(index, checkpoint_hash)).map(|m| m.value().1);
            if d_first.is_none() || d_first == d_new { return; }
            let first_sig = match VOTE_FIRST_SIG.get(&key) {
                Some(e) => e.value().clone(),
                // Detected, but the first vote's signature aged out of VOTE_SIG_WINDOW.
                None => {
                    if is_warn() {
                        println!("[WARN][SLASH] vote_equivocation_unprovable index={} voter={} reason=first_signature_evicted",
                                 index, voter);
                    }
                    return;
                }
            };
            let cp_first = VOTE_PROPOSAL_CACHE.get(&(index, first_hash)).map(|e| e.value().clone());
            let cp_new = VOTE_PROPOSAL_CACHE.get(&(index, checkpoint_hash)).map(|e| e.value().clone());
            if let (Some(cp_first), Some(cp_new)) = (cp_first, cp_new) {
                // Canonical order (smaller hash = a) so every detector builds an identical TX.
                let (checkpoint_a, sig_a, checkpoint_b, sig_b) = if first_hash <= checkpoint_hash {
                    (cp_first, first_sig, cp_new, signature)
                } else {
                    (cp_new, signature, cp_first, first_sig)
                };
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                VOTE_EQUIVOCATION_EVIDENCE.insert(key, VoteEquivocationEvidence {
                    checkpoint_a, sig_a, checkpoint_b, sig_b, detected_ts: now,
                });
                if is_warn() {
                    println!("[WARN][SLASH] vote_equivocation_recorded index={} voter={}", index, voter);
                }
            }
        }
        None => {
            VOTE_FIRST_SEEN.insert(key.clone(), checkpoint_hash);
            VOTE_FIRST_SIG.insert(key, signature);
        }
    }
}

/// Drains pending vote-equivocation evidence into canonical `VoteEquivocationProof` system TXs
/// for the block this node is producing (block-level, never gossiped — same model as block
/// equivocation). Deterministic TX bytes (canonical checkpoint order + checkpoint_a.timestamp,
/// no wall-clock) ⇒ detectors dedup. Returns (tx_hash, bytes); drained entries are removed.
pub fn drain_vote_equivocation_proof_txs(max: usize) -> Vec<(String, Vec<u8>)> {
    if VOTE_EQUIVOCATION_EVIDENCE.is_empty() {
        return Vec::new();
    }
    let keys: Vec<(u64, String)> = VOTE_EQUIVOCATION_EVIDENCE.iter().take(max).map(|e| e.key().clone()).collect();
    let mut out: Vec<(String, Vec<u8>)> = Vec::with_capacity(keys.len());
    for key in keys {
        let ev = match VOTE_EQUIVOCATION_EVIDENCE.get(&key) { Some(v) => v.clone(), None => continue };
        let offender = key.1.clone();
        // Deterministic timestamp from the canonical first checkpoint (the round-agreed head ts).
        let ts = bincode::deserialize::<qnet_consensus::checkpoint_bft::Checkpoint>(&ev.checkpoint_a)
            .map(|c| c.timestamp).unwrap_or(0);
        let mut tx = qnet_state::Transaction {
            hash: String::new(),
            from: "system_slashing".to_string(),
            to: None,
            amount: 0,
            nonce: 0,
            gas_price: 0,
            gas_limit: 0,
            timestamp: ts,
            signature: None,
            public_key: None,
            tx_type: qnet_state::TransactionType::VoteEquivocationProof {
                offender: offender.clone(),
                checkpoint_a: ev.checkpoint_a,
                signature_a: ev.sig_a,
                checkpoint_b: ev.checkpoint_b,
                signature_b: ev.sig_b,
            },
            data: None,
            dilithium_signature: None,
            dilithium_public_key: None,
            chain_id: qnet_state::transaction::QNET_CHAIN_ID,
        };
        tx.hash = tx.calculate_hash();
        match bincode::serialize(&tx) {
            Ok(bytes) => {
                let tx_hash = tx.hash.clone();
                VOTE_EQUIVOCATION_EVIDENCE.remove(&key);
                if is_warn() {
                    println!("[WARN][SLASH] vote_equivocation_proof_tx_built offender={} index={} tx={}",
                             offender, key.0, qnet_state::char_prefix(&tx_hash, 16));
                }
                out.push((tx_hash, bytes));
            }
            Err(e) => if is_warn() {
                println!("[WARN][SLASH] vote_equivocation_serialize_fail index={} err={}", key.0, e);
            },
        }
    }
    out
}

// v15.0 consensus-stall registry (CONSENSUS_STALLED / mark_consensus_stalled /
// is_consensus_stalled) REMOVED: it tracked the old commit-reveal fallback
// (reveal_shortage / phase_error) and had zero writers and zero readers under
// Checkpoint-BFT v2. v2 liveness is handled by the TimeoutCertificate view-change
// (consensus_v2_node), not a stall flag.

/// Out-of-turn producer tracking: producer_id -> (window_start_height, count)
/// If a producer sends >3 blocks out of turn within 100 blocks, reject subsequent ones.
static OOT_PRODUCER_COUNT: once_cell::sync::Lazy<DashMap<String, (u64, u32)>> =
    once_cell::sync::Lazy::new(|| DashMap::new());

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY LEAK FIX v3.20: Periodic cleanup for global DashMaps
// PROBLEM: PRODUCER_VOTES, REQUESTED_CERTIFICATES grow unbounded
// SOLUTION: Remove entries older than current_height - CLEANUP_HEIGHT_WINDOW
// ═══════════════════════════════════════════════════════════════════════════════
const CLEANUP_HEIGHT_WINDOW: u64 = 500; // Keep last 500 microblocks (~8 min at 1 block/sec)
/// Slashing horizon for UNSUBMITTED evidence — one epoch. Deliberately decoupled from the operational
/// window above: that one is sized for vote/certificate churn, and reusing it silently gave a proof
/// eight minutes to find a producer.
const EVIDENCE_RETENTION_BLOCKS: u64 = 14_400;
/// Hard cap on pending block-equivocation entries, newest heights kept.
const MAX_PENDING_EVIDENCE: usize = 4_096;
static LAST_DASHMAP_CLEANUP_HEIGHT: StdAtomicU64 = StdAtomicU64::new(0);

/// v3.20: Cleanup old entries from global DashMaps to prevent memory leaks
/// Should be called periodically (every ~10 blocks)
pub fn cleanup_global_hashmaps(current_height: u64) {
    // Only cleanup every 10 blocks to avoid overhead
    let last_cleanup = LAST_DASHMAP_CLEANUP_HEIGHT.load(StdOrdering::Relaxed);
    if current_height < last_cleanup + 10 {
        return;
    }
    LAST_DASHMAP_CLEANUP_HEIGHT.store(current_height, StdOrdering::Relaxed);
    
    let min_valid_height = current_height.saturating_sub(CLEANUP_HEIGHT_WINDOW);
    
    // Cleanup PRODUCER_VOTES - remove entries for old heights
    let votes_before = PRODUCER_VOTES.len();
    PRODUCER_VOTES.retain(|k, _| k.0 >= min_valid_height);
    let votes_removed = votes_before.saturating_sub(PRODUCER_VOTES.len());


    // Cleanup REQUESTED_CERTIFICATES - keep only recent (last 5 minutes)
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let cert_before = REQUESTED_CERTIFICATES.len();
    REQUESTED_CERTIFICATES.retain(|_, &mut timestamp| now.saturating_sub(timestamp) < 300);
    let cert_removed = cert_before.saturating_sub(REQUESTED_CERTIFICATES.len());
    
    // Evidence gets its OWN, far longer horizon than the operational caches above. On the 500-block
    // window a proof had ~8 minutes to reach a producer, which at any real validator count meant
    // essentially never — the ban existed but could not be issued. One epoch is ample even across a
    // partition, and the count cap keeps a repeat offender from turning self-incrimination into
    // memory pressure.
    let evidence_floor = current_height.saturating_sub(EVIDENCE_RETENTION_BLOCKS);
    let equivoc_before = EQUIVOCATION_EVIDENCE.len();
    EQUIVOCATION_EVIDENCE.retain(|k, _| k.0 >= evidence_floor);
    let equivoc_removed = equivoc_before.saturating_sub(EQUIVOCATION_EVIDENCE.len());

    let block_equivoc_before = BLOCK_EQUIVOCATION_EVIDENCE.len();
    BLOCK_EQUIVOCATION_EVIDENCE.retain(|k, _| k.0 >= evidence_floor);
    if BLOCK_EQUIVOCATION_EVIDENCE.len() > MAX_PENDING_EVIDENCE {
        let mut heights: Vec<u64> = BLOCK_EQUIVOCATION_EVIDENCE.iter().map(|e| e.key().0).collect();
        heights.sort_unstable();
        let keep_from = heights[heights.len() - MAX_PENDING_EVIDENCE];
        BLOCK_EQUIVOCATION_EVIDENCE.retain(|k, _| k.0 >= keep_from);
    }
    let block_equivoc_removed = block_equivoc_before.saturating_sub(BLOCK_EQUIVOCATION_EVIDENCE.len());

    // Cleanup OOT producer tracking — remove entries with stale windows
    OOT_PRODUCER_COUNT.retain(|_, (window_start, _)| *window_start >= min_valid_height);

    // Prune the remote-producer heartbeat maps (the sole pruner was previously uncalled → the three
    // REMOTE_PRODUCER_HEARTBEAT_* maps grew unbounded toward 100k supers). Only acts above half-cap and
    // evicts entries not refreshed in the window, so active producers are never dropped.
    crate::unified_p2p::evict_stale_producer_heartbeats(600_000);

    if (votes_removed > 0 || cert_removed > 0 || equivoc_removed > 0 || block_equivoc_removed > 0) && is_info() {
        println!("[INFO][MEM] cleanup h={} votes={} certs={} equivoc={} block_equivoc={}",
                 current_height, votes_removed, cert_removed, equivoc_removed, block_equivoc_removed);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTION v2.50: Lock-free quantum crypto with OnceCell + Arc
// 25x faster than Mutex-based approach - zero lock contention
// Architecture: OnceCell guarantees single initialization, Arc enables zero-copy sharing
// ═══════════════════════════════════════════════════════════════════════════════

pub(crate) use tokio::sync::OnceCell;
// Note: Arc already imported at top of file

/// Global quantum crypto instance - initialized once, shared immutably
/// Uses OnceCell for safe lazy initialization + Arc for thread-safe sharing
pub static GLOBAL_QUANTUM_CRYPTO: OnceCell<Arc<crate::quantum_crypto::QNetQuantumCrypto>> = OnceCell::const_new();

/// Initialize global quantum crypto (call once at node startup)
/// Returns Ok(()) if already initialized or initialization succeeds
pub async fn init_global_quantum_crypto() -> Result<(), String> {
    use std::time::Instant;
    let start = Instant::now();
    
    GLOBAL_QUANTUM_CRYPTO.get_or_try_init(|| async {
        if is_info() { 
            println!("[INFO][CRYPTO] init_start mode=OnceCell+Arc algorithm=CRYSTALS-Dilithium3"); 
        }
        
        let mut crypto = crate::quantum_crypto::QNetQuantumCrypto::new();
        crypto.initialize().await.map_err(|e| format!("init_failed: {}", e))?;
        
        Ok(Arc::new(crypto))
    }).await.map(|_| {
        if is_info() { 
            println!("[INFO][CRYPTO] init_complete lock_free=true latency_ms={}", start.elapsed().as_millis()); 
        }
    })
}

/// Get reference to global quantum crypto (panics if not initialized)
/// For performance-critical paths - avoid Option checks
#[inline]
pub fn get_quantum_crypto() -> &'static Arc<crate::quantum_crypto::QNetQuantumCrypto> {
    GLOBAL_QUANTUM_CRYPTO.get().expect("[CRIT][CRYPTO] not_initialized call=init_global_quantum_crypto")
}

/// Try to get reference to global quantum crypto (returns None if not initialized)
/// Safe version for non-critical paths
#[inline]
pub fn try_get_quantum_crypto() -> Option<&'static Arc<crate::quantum_crypto::QNetQuantumCrypto>> {
    GLOBAL_QUANTUM_CRYPTO.get()
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTION v2.30: EXPLICIT NODE STATE MACHINE
// Provides clear visibility into node's current operational state
// Industry-standard state machine for blockchain nodes
// ═══════════════════════════════════════════════════════════════════════════════

/// Node operational state for debugging and monitoring
#[derive(Debug, Clone, PartialEq)]
pub enum NodeState {
    /// Node just started, initializing components
    Initializing,
    
    /// Syncing with network (behind network_height)
    Syncing { 
        local_height: u64, 
        target_height: u64,
        progress_percent: u8,
    },
    
    /// Waiting for macroblock to be available for next epoch
    WaitingForMacroblock { 
        epoch: u64,
        macroblock_index: u64,
    },
    
    /// Fork detected, resolving which chain to follow
    ResolvingFork { 
        fork_height: u64,
        our_hash: String,
    },
    
    /// Actively producing blocks (our turn)
    Producing { 
        round: u64, 
        current_height: u64,
    },
    
    /// Validating blocks from other producers (not our turn)
    Validating { 
        current_producer: String,
        current_height: u64,
    },
    
    /// Idle - no blocks to process, waiting for next cycle
    Idle {
        last_height: u64,
    },
    
    /// Error state - node cannot operate
    Error { 
        reason: String,
        recoverable: bool,
    },
}

impl std::fmt::Display for NodeState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NodeState::Initializing => write!(f, "🚀 INITIALIZING"),
            NodeState::Syncing { local_height, target_height, progress_percent } => 
                write!(f, "🔄 SYNCING {}/{} ({}%)", local_height, target_height, progress_percent),
            NodeState::WaitingForMacroblock { epoch, macroblock_index } => 
                write!(f, "⏳ WAITING_MACROBLOCK epoch={} mb={}", epoch, macroblock_index),
            NodeState::ResolvingFork { fork_height, our_hash } => 
                write!(f, "🔀 RESOLVING_FORK height={} hash={}", fork_height, our_hash),
            NodeState::Producing { round, current_height } =>
                write!(f, "⛏️ PRODUCING round={} height={}", round, current_height),
            NodeState::Validating { current_producer, current_height } => 
                write!(f, "✅ VALIDATING producer={} height={}", current_producer, current_height),
            NodeState::Idle { last_height } => 
                write!(f, "😴 IDLE last_height={}", last_height),
            NodeState::Error { reason, recoverable } => 
                write!(f, "❌ ERROR: {} (recoverable={})", reason, recoverable),
        }
    }
}

// v2.96: Global node state with fast parking_lot lock (never poisons, 2-3x faster)
lazy_static::lazy_static! {
    pub static ref GLOBAL_NODE_STATE: ParkingRwLock<NodeState> =
        ParkingRwLock::new(NodeState::Initializing);
}

// Node-state escalation ladder. Counts consecutive ERROR transitions
// (reset on any non-error) so escalate_error_state() can drive
// deterministic recovery (force round advance → resync → peer rediscovery
// → halt) for a node stuck in a recovery cycle. Forensic h=781: the legacy
// machine cycled VALIDATING→WAITING→ERROR{recoverable} ~11h with the
// recoverable flag having no consumer. Each escalation step is a SAFE
// primitive (never modifies finalisation guarantees). O(1)/transition.

/// Number of consecutive `NodeState::Error{recoverable=true}` transitions.
/// Reset to 0 on any non-Error transition.
pub static ERROR_CYCLE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Last height at which an Error transition fired. Used by escalation to
/// trigger chronic-stall resync only when the same height keeps failing.
pub static ERROR_LAST_HEIGHT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Last wall-clock seconds at which `escalate_error_state` triggered a
/// resync action — prevents resync flood when many cycles fire in burst.
static ERROR_LAST_RESYNC_SECS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Escalation thresholds. Calibrated for the ~1s microblock cadence so each
/// stage covers a meaningful number of slots before promoting to the next.
/// All stages are SIGNAL-based (set process-wide flags consumed by other
/// loops). None mutate BFT consensus state directly — that property is
/// what was violated by the v16.1 force_round_advance stage that has been
/// removed in v16.2.
const ERROR_ESCALATE_RESYNC_AT: u64 = 10;         // ≥10 cycles → trigger background resync
const ERROR_ESCALATE_PEER_REFRESH_AT: u64 = 30;   // ≥30 cycles → drop + rediscover peers
const ERROR_ESCALATE_HALT_AT: u64 = 120;          // ≥120 cycles (~2 min) → mark Halted
const ERROR_RESYNC_COOLDOWN_SECS: u64 = 60;       // resync trigger cooldown
/// Threshold above which the ladder reset event is worth logging — picks the
/// first signal-based stage so operators see when a recovery cycle that
/// reached actionable territory was cleared by progress.
const ERROR_CYCLE_RESET_LOG_AT: u64 = ERROR_ESCALATE_RESYNC_AT;

/// Update node state with logging and escalation accounting.
///
/// v16.2: escalation ladder is strictly SIGNAL-based — no consensus-state
/// mutation. Stages set AtomicBool flags that downstream loops consume:
///   * Stage 2 (cycles=10): `CHRONIC_STALL_REQUESTED` → resync from peers
///   * Stage 3 (cycles=30): `PEER_REFRESH_REQUESTED` → peer rediscovery
///   * Stage 4 (cycles≥120): `HALT_REQUESTED` → process::exit(1)
///
/// Safety: every action either pulls verified evidence from peers (resync,
/// rediscovery) or surfaces to the orchestrator (halt). None of them touches
/// `CURRENT_TIMEOUT_ROUND`, `HIGHEST_CERTIFIED_ROUND`, or any other consensus
/// state — which is why determinism of producer selection holds across the
/// whole committee even when individual nodes hit the ladder at different
/// moments.
pub fn set_node_state(new_state: NodeState) {
    let old_state = GLOBAL_NODE_STATE.read().clone();

    if old_state == new_state {
        return;
    }

    // ── Escalation accounting ──
    match &new_state {
        NodeState::Error { recoverable: true, .. } => {
            let cycles = ERROR_CYCLE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            // Background-safe escalation. The trigger functions do not block
            // the caller — they spawn async tasks where required.
            escalate_error_state(cycles);
        }
        // Any non-error (or non-recoverable) transition resets the ladder.
        _ => {
            let prev = ERROR_CYCLE_COUNT.swap(0, std::sync::atomic::Ordering::Relaxed);
            if prev >= ERROR_CYCLE_RESET_LOG_AT && is_info() {
                println!("[INFO][STATE] error_cycle_reset prev_cycles={}", prev);
            }
        }
    }

    if is_info() {
        println!("[INFO][STATE] {} → {}", old_state, new_state);
    }
    *GLOBAL_NODE_STATE.write() = new_state;
}

/// Drive recovery actions based on consecutive Error cycle count.
/// Called from `set_node_state` only — never schedule directly.
///
/// v16.2: REMOVED stage 1 force_round_advance. Local mutation of
/// `CURRENT_TIMEOUT_ROUND` outside BFT consensus broke the determinism
/// guarantee — different nodes hit `ERROR_ESCALATE_FORCE_ROUND_AT` at
/// different moments and bumped the global selection input to different
/// values, producing divergent producer selections and visible forks at
/// the v16.1 deploy. The whole purpose of `set_timeout_round` is that the
/// value is sourced ONLY from `HIGHEST_CERTIFIED_ROUND` — an n−f
/// supermajority signed by ML-DSA-65-verified votes.
///
/// Recovery is now driven exclusively by signal-based stages 2..4 below,
/// which never mutate consensus state — they only set process-wide flags
/// that downstream loops consume to trigger network operations (resync,
/// peer rediscovery, halt). All decisions remain BFT-consensus driven.
fn escalate_error_state(cycles: u64) {
    match cycles {
        c if c == ERROR_ESCALATE_RESYNC_AT => {
            // Stage 2: trigger background resync from canonical peers.
            // Cooldown-gated to avoid resync flood under sustained errors.
            let now_secs = get_timestamp_safe();
            let last = ERROR_LAST_RESYNC_SECS.load(std::sync::atomic::Ordering::Relaxed);
            if now_secs.saturating_sub(last) >= ERROR_RESYNC_COOLDOWN_SECS {
                ERROR_LAST_RESYNC_SECS.store(now_secs, std::sync::atomic::Ordering::Relaxed);
                let height = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                    .load(std::sync::atomic::Ordering::Relaxed);
                println!(
                    "[WARN][STATE] escalate=trigger_resync cycles={} from_h={} cooldown_secs={}",
                    cycles, height, ERROR_RESYNC_COOLDOWN_SECS
                );
                // Set a process-wide flag so the production loop's chronic
                // stall path picks up the request without us blocking here.
                CHRONIC_STALL_REQUESTED.store(true, std::sync::atomic::Ordering::Relaxed);
            } else if is_info() {
                println!(
                    "[INFO][STATE] escalate=resync_skipped_cooldown cycles={} since_last={}s",
                    cycles, now_secs.saturating_sub(last)
                );
            }
        }
        c if c == ERROR_ESCALATE_PEER_REFRESH_AT => {
            // Stage 3: signal peer-discovery refresh. The connectivity
            // subsystem checks this flag every tick and rotates peers
            // when set. Identity bindings (anchored / on-chain) survive.
            PEER_REFRESH_REQUESTED.store(true, std::sync::atomic::Ordering::Relaxed);
            println!(
                "[WARN][STATE] escalate=peer_rediscovery cycles={} action=drop_and_redial",
                cycles
            );
        }
        c if c >= ERROR_ESCALATE_HALT_AT => {
            // Stage 4: terminal. Surface to the watchdog/RPC layer so the
            // process can be restarted by the orchestrator. Don't silently
            // recurse into another state change here.
            eprintln!(
                "[CRIT][STATE] escalate=halt_signal cycles={} action=external_restart_required",
                cycles
            );
            HALT_REQUESTED.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        _ => {
            // No-op between stage boundaries.
        }
    }

    // Lightweight progress log every 5 cycles so operators can see the
    // ladder advancing without spamming on every cycle.
    if cycles % 5 == 0 && is_info() {
        println!("[INFO][STATE] error_cycle_count={}", cycles);
    }
}

/// Get current node state
pub fn get_node_state() -> NodeState {
    GLOBAL_NODE_STATE.read().clone()
}

// v16.1: Process-wide flags consumed by the production / connectivity loops
// to enact the escalation ladder without coupling state machine to those
// subsystems directly. Each is a single AtomicBool, O(1) check per tick.
pub static CHRONIC_STALL_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
pub static PEER_REFRESH_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
pub static HALT_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

// Per-peer backpressure was superseded by the adaptive-throttle removal:
// the global production gate is gone (producer runs at the full 1 s
// cadence), slow peers self-recover via the sync subsystem, and QUIC
// handles per-peer flow control at the transport level. No consensus-layer
// backpressure state is needed.

// Stall-driven timeout-vote emission throttle. Per-mb_idx last-emission
// timestamp; the stall detector re-emits emit_macroblock_view_change_vote
// at most once per STALL_GRACE_SECS/mb/node, bounding gossip during a stall
// at any committee size. Purely an efficiency guard — receiver-side
// TIMEOUT_VOTES enforces (height,round,voter) uniqueness, so duplicate
// emissions can't affect the n−f count. Pruned by cleanup_old_timeout_data.
pub static LAST_TIMEOUT_EMIT_PER_MB:
    once_cell::sync::Lazy<dashmap::DashMap<u64, u64>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

// v23.1: sticky leader per leadership-round view. Once a fallback
// producer (timeout_round>0) produces a block in leadership_round L it
// STICKS as leader for the rest of L (next 30-block boundary) — not
// re-consulting the failed primary avoids a per-block 5s-stall + n−f
// thrash. Canonical BFT-PoS "stable leader within view" (view=30-block
// round); holds until view end OR n−f re-vote (sticky also failed).
// Safety: sticky honored ONLY if locked_round >= certified_round (else
// invalidate + fresh select); sticky = deterministic
// select_microblock_producer_with_round(...) → all honest nodes lock the
// SAME producer; per leadership_round → new window = fresh selection. O(1).
pub static STICKY_LEADER_PER_VIEW:
    once_cell::sync::Lazy<dashmap::DashMap<u64, (String, u64)>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

// CRITICAL: Global mempool instance for activation registry integration
// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTION v2.50: Lock-free global mempool with OnceCell + Arc
// SimpleMempool is already thread-safe internally (DashMap + parking_lot)
// No outer lock needed - just share the Arc immutably
// ═══════════════════════════════════════════════════════════════════════════════

/// Global mempool instance - initialized once, shared immutably
pub static GLOBAL_MEMPOOL_INSTANCE: OnceCell<Arc<qnet_mempool::SimpleMempool>> = OnceCell::const_new();

/// Initialize global mempool (call once during node startup)
pub fn init_global_mempool(mempool: Arc<qnet_mempool::SimpleMempool>) {
    if GLOBAL_MEMPOOL_INSTANCE.set(mempool).is_err() {
        if is_warn() { println!("[WARN][MEMPOOL] already_initialized"); }
    } else {
        if is_info() { println!("[INFO][MEMPOOL] init_complete mode=OnceCell+Arc"); }
    }
}

/// Get reference to global mempool (panics if not initialized)
#[inline]
pub fn get_mempool() -> &'static Arc<qnet_mempool::SimpleMempool> {
    GLOBAL_MEMPOOL_INSTANCE.get().expect("[CRIT][MEMPOOL] not_initialized")
}

/// Try to get reference to global mempool (returns None if not initialized)
#[inline]
pub fn try_get_mempool() -> Option<&'static Arc<qnet_mempool::SimpleMempool>> {
    GLOBAL_MEMPOOL_INSTANCE.get()
}

/// v4.3: Global P2P instance — for broadcasting TX from activation_validation.rs
/// Without this, NodeActivation TX stays in local mempool and is only included
/// when this specific node becomes block producer.
pub static GLOBAL_P2P_INSTANCE: OnceCell<Arc<crate::unified_p2p::SimplifiedP2P>> = OnceCell::const_new();

/// Initialize global P2P (call once during node startup, after P2P is ready)
/// Process-wide pipeline ingest handle. Needed by paths that must re-feed locally-held blocks
/// (branch adoption after a rollback) without owning a node reference.
static GLOBAL_PIPELINE_INGEST: once_cell::sync::OnceCell<crate::block_pipeline::PipelineIngest> =
    once_cell::sync::OnceCell::new();

pub fn init_global_pipeline_ingest(ingest: crate::block_pipeline::PipelineIngest) {
    let _ = GLOBAL_PIPELINE_INGEST.set(ingest);
}

pub fn try_get_pipeline_ingest() -> Option<&'static crate::block_pipeline::PipelineIngest> {
    GLOBAL_PIPELINE_INGEST.get()
}

pub fn init_global_p2p(p2p: Arc<crate::unified_p2p::SimplifiedP2P>) {
    if GLOBAL_P2P_INSTANCE.set(p2p).is_err() {
        if is_warn() { println!("[WARN][P2P] global_p2p_already_initialized"); }
    } else {
        if is_info() { println!("[INFO][P2P] global_p2p_init_complete"); }
    }
}

/// Try to get reference to global P2P (returns None if not initialized)
#[inline]
pub fn try_get_p2p() -> Option<&'static Arc<crate::unified_p2p::SimplifiedP2P>> {
    GLOBAL_P2P_INSTANCE.get()
}

/// Snapshot anchor QC gate (P2/P1). A fast-sync snapshot is trustworthy ONLY if the macroblock
/// it binds to carries an n−f checkpoint QC the joiner itself verifies against the committee
/// anchored (via N-2 / genesis) to the embedded genesis consensus keys. `verify_v2_macroblock`
/// returns Ok early for a None-QC macroblock, so without this a Byzantine peer could serve a
/// self-consistent FORGED (macroblock, snapshot) pair that the binder's merkle recompute accepts.
/// node_id/node_type do NOT affect the derived committee (it is on-chain-deterministic; node_type
/// is unused, node_id only self-includes a genesis verifier), so the running identity is used.
/// Returns Err — snapshot rejected, fall back to verified block-sync — when the anchor lacks a QC,
/// p2p is not yet up, or the QC fails to verify.
pub(crate) async fn verify_snapshot_anchor_qc(
    macroblock: &qnet_state::MacroBlock,
    mb_idx: u64,
    storage: &Storage,
) -> Result<(), String> {
    if macroblock.consensus_data.checkpoint_qc.is_none() {
        return Err(format!("anchor_no_qc mb={}", mb_idx));
    }
    let p2p = try_get_p2p().ok_or_else(|| format!("anchor_no_p2p mb={}", mb_idx))?;
    let node_id = crate::unified_p2p::GLOBAL_NODE_ID.read().clone();
    BlockchainNode::verify_v2_macroblock(macroblock, mb_idx, p2p, &node_id, NodeType::Super, storage).await
}

/// QC-verified finality frontier as a height (idx*90): the highest macroblock OBJECT this node holds,
/// which is QC-verified by construction (process_received_macroblock / local finalize both gate on
/// verify_v2_macroblock against the genesis-anchored committee before storage). Drives the bulk
/// macroblock lineage walk toward the peer-hinted top so the frontier climbs to the network's verified
/// tip. The peer hint is MAX (not median): an over-reported height only makes us probe a higher index,
/// where a forged macroblock fails the QC gate and never stores — so MAX self-limits to reality and the
/// median's anti-high-poisoning role is subsumed by the QC verify. Returns 0 before any macroblock
/// (h<90 / fresh genesis) so callers fall back to the capped near-tip hint (bootstrap never blocked).
/// O(epoch checkpoints); WS checkpoint truncates the lineage at maturity. NOT for hot loops.
pub(crate) fn qc_verified_frontier_height() -> u64 {
    const MB: u64 = 90; // microblocks per macroblock (boundary granularity)
    use std::sync::atomic::Ordering::Relaxed;
    let storage = match try_get_storage() { Some(s) => s, None => return QC_VERIFIED_FRONTIER.load(Relaxed) };
    // Base = last contiguously-SEALED macroblock object, NOT chain_height/90 (the microblock tip): SYNC-ADOPT
    // adopts finality up to this frontier, and adopting past a boundary whose 2f+1 object is not yet sealed
    // lets the marker outrun the object and shut the macro re-propose gate (macroblock_index > last_finalized_mb).
    let local_mb = storage.last_sealed_mb_index();
    // Hint = MAX of the served-availability oracle and the attested network-tip oracle, so the frontier
    // probe keeps pace with the applied microblock tip (a forged-high hint self-limits at the QC gate).
    let hint_mb = try_get_p2p()
        .map(|p| p.get_best_peer_height().max(p.get_cached_network_height().unwrap_or(0)) / MB)
        .unwrap_or(0);
    // Fire-and-forget the bulk lineage extension (throttled) — NEVER block the production hot path on
    // peer I/O. The local scan below reports the frontier from whatever has already been QC-stored;
    // the spawned walk extends it for the next call. Skip-present + windowed; fetches objects + N-2
    // anchors so verify_v2_macroblock certifies each before storage.
    // Seal frontier lags the applied tip: the SINGLE sync coordinator owns the macroblock fetch. Nudge it
    // (idempotent flag, no spawn) instead of a parallel repair here — check_desync re-derives the same
    // deficit from the unified target and execute_sync's macroblock pass fills it. Threshold matches
    // check_desync's mb dimension (MAX_UNSEALED_WINDOWS absorbs the healthy unsealed tail) so detection
    // and repair agree; deficits within the tail arrive via normal macroblock gossip.
    if hint_mb > local_mb.saturating_add(MAX_UNSEALED_WINDOWS) {
        crate::sync_manager::nudge_sync_check();
    }
    // Highest STORED macroblock object above local progress. Existence ⟹ QC-verified: the only store
    // paths are process_received_macroblock (gated on verify_v2_macroblock before save_macroblock) and
    // the local sealer (own n−f QC); no reachable path stores a None-QC macroblock. Bounded scan —
    // cap the window so a far-ahead hint can't trigger an unbounded DB scan.
    let scan_top = hint_mb.min(local_mb.saturating_add(128));
    let mut frontier = local_mb.saturating_mul(MB);
    let mut idx = scan_top;
    while idx > local_mb {
        if storage.get_macroblock_by_height(idx).ok().flatten().is_some() {
            frontier = idx.saturating_mul(MB);
            break;
        }
        idx = idx.saturating_sub(1);
    }
    QC_VERIFIED_FRONTIER.fetch_max(frontier, Relaxed);
    QC_VERIFIED_FRONTIER.load(Relaxed)
}

/// O(1) cached QC frontier (no network probe) for hot gates. Monotonic; refreshed by every
/// qc_verified_frontier_height() probe AND every QC macroblock commit (fetch_max at save_macroblock).
pub(crate) fn qc_verified_frontier_cached() -> u64 {
    QC_VERIFIED_FRONTIER.load(std::sync::atomic::Ordering::Relaxed)
}

/// SINGLE source of truth for "how far behind am I" — every behind/target/gap decision reads THIS so
/// no two consumers can disagree. Returns (applied, target, gap): applied = own applied tip; target =
/// highest known head from monotonic, never-decaying signals (QC-verified frontier ∨ authenticated
/// best-peer/signed-head). NEVER gated by a peer-attestation TTL quorum a client-only joiner can't
/// sustain; safety stays in per-block QC/Dilithium verify on apply. The authoritative "am I synced"
/// boolean is the coordinator FSM (coordinator_is_synchronized) — this returns the raw gap only.
pub fn network_status() -> (u64, u64, u64) {
    use std::sync::atomic::Ordering::Relaxed;
    let applied = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(Relaxed);
    // Target = re-derived connected-peer tip (poison drops on disconnect), already floored by QC frontier
    // + local inside get_max_peer_height. No monotonic-stuck atomic gates "am I synced".
    let target = try_get_p2p().map(|p| p.get_max_peer_height()).unwrap_or(applied);
    (applied, target, target.saturating_sub(applied))
}

// CRITICAL: Track certificate requests to prevent DDoS (request flooding)
// Maps certificate_serial -> last_request_timestamp
// v2.96: Using DashMap for lock-free operations
lazy_static::lazy_static! {
    static ref REQUESTED_CERTIFICATES: DashMap<String, u64> = DashMap::new();
}

pub(crate) use sha3::{Sha3_256, Sha3_512, Digest};
pub(crate) use serde_json;
pub(crate) use bincode::{self, Options};
pub(crate) use serde::{Serialize, Deserialize};


// DYNAMIC NETWORK DETECTION - No timestamp dependency for robust deployment

/// v3.18: Removed Super node type - only Light and Super remain
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum NodeType {
    Light,
    Super,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Region {
    NorthAmerica,
    Europe,
    Asia,
    SouthAmerica,
    Africa,
    Oceania,
}

/// Performance configuration from environment variables
#[derive(Debug, Clone)]
pub struct PerformanceConfig {
    pub enable_sharding: bool,
    pub shard_count: usize,
    
    pub parallel_validation: bool,
    pub parallel_threads: usize,
    
    pub p2p_compression: bool,
    pub batch_size: usize,
    
    pub high_throughput: bool,
    pub high_frequency: bool,
    // REMOVED: skip_validation - ALWAYS validate in production for security
    pub create_empty_blocks: bool,
}

impl Default for PerformanceConfig {
    fn default() -> Self {
        // AUTO-DETECT: CPU cores for optimal performance
        let cpu_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4); // Fallback: 4 cores
        
        // OPTIONAL: CPU usage limit (percentage or absolute number)
        let cpu_limit_percent = env::var("QNET_CPU_LIMIT_PERCENT")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|&p| p > 0 && p <= 100)
            .unwrap_or(100); // Default: use 100% of available CPU
        
        let max_threads_allowed = env::var("QNET_MAX_THREADS")
            .ok()
            .and_then(|s| s.parse::<usize>().ok());
        
        // Calculate effective CPU allocation
        let effective_cpu_count = if let Some(max_threads) = max_threads_allowed {
            // Manual cap takes priority
            max_threads.min(cpu_count)
        } else if cpu_limit_percent < 100 {
            // Apply percentage limit
            let limited = (cpu_count * cpu_limit_percent) / 100;
            limited.max(2) // Minimum 2 threads even with limit
        } else {
            // Use all available
            cpu_count
        };
        
        // AUTO-TUNE: Parallel validation only makes sense on multi-core systems
        let auto_parallel_validation = if env::var("QNET_PARALLEL_VALIDATION").is_ok() {
            env::var("QNET_PARALLEL_VALIDATION").unwrap_or_default() == "1"
        } else {
            // AUTO-ENABLE if effective CPU >= 8 cores
            effective_cpu_count >= 8
        };
        
        // AUTO-TUNE: Thread count = effective CPUs (minimum 2, recommended 4)
        let auto_parallel_threads = env::var("QNET_PARALLEL_THREADS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| {
                // Use effective cores, but respect CPU limit
                // Minimum 2 threads, recommended 4+ for production
                if effective_cpu_count >= 4 {
                    effective_cpu_count // Use all allocated cores
                } else {
                    effective_cpu_count.max(2) // Minimum 2, don't force 4 on limited systems
                }
            });
        
        if is_info() { println!("[INFO][PERF] auto_tune cores={}", cpu_count); }
        if cpu_limit_percent < 100 {
            if is_info() { println!("[INFO][PERF] cpu_limit={}% effective_cores={}", 
                    cpu_limit_percent, effective_cpu_count); }
            
            // WARNING: Extremely low CPU allocation
            if effective_cpu_count < 4 {
                if is_warn() { println!("[WARN][PERF] low_cpu_alloc cores={} min_recommended=4", 
                        effective_cpu_count); }
            }
        } else if let Some(max) = max_threads_allowed {
            if is_info() { println!("[INFO][PERF] thread_cap={} available={}", max, cpu_count); }
            if max < 4 {
                if is_warn() { println!("[WARN][PERF] low_thread_cap={} recommended=4", max); }
            }
        }
        if is_info() { println!("[INFO][PERF] parallel_validation={} threshold=8cores", 
                if auto_parallel_validation { "enabled" } else { "disabled" }); }
        if is_info() { println!("[INFO][PERF] parallel_threads={}", auto_parallel_threads); }
        
        Self {
            enable_sharding: env::var("QNET_ENABLE_SHARDING").unwrap_or_default() == "1",
            // PRODUCTION: Shards for TX processing parallelism (NOT storage partitioning)
            // NOTE: Actual shard count is determined by network size via ShardCoordinator
            // Manual override only affects LOCAL parallel processing, not network consensus
            shard_count: env::var("QNET_SHARD_COUNT")
                .unwrap_or_default()
                .parse()
                .unwrap_or(256)
                .min(MAX_SHARDS as usize)  // Cap at MAX_SHARDS (256)
                .max(1),                    // Minimum 1 shard
            
            parallel_validation: auto_parallel_validation,
            // AUTO-TUNE: Use all available CPU cores for maximum throughput
            parallel_threads: auto_parallel_threads,
            
            p2p_compression: env::var("QNET_P2P_COMPRESSION").unwrap_or_default() == "1",
            batch_size: env::var("QNET_BATCH_SIZE").unwrap_or_default().parse().unwrap_or(200000),
            
            high_throughput: env::var("QNET_HIGH_THROUGHPUT").unwrap_or_default() == "1",
            high_frequency: env::var("QNET_HIGH_FREQUENCY").unwrap_or_default() == "1",
            create_empty_blocks: env::var("QNET_CREATE_EMPTY_BLOCKS").unwrap_or_default() == "1",
        }
    }
}

/// Track rotation progress for atomic rewards
#[derive(Clone)]
pub struct RotationTracker {
    // leadership_round -> (producer_id, blocks_created, start_height)  
    current_rotations: Arc<RwLock<HashMap<u64, (String, u32, u64)>>>,
}

impl RotationTracker {
    pub fn new() -> Self {
        Self {
            current_rotations: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    
    /// Track block production
    pub async fn track_block(&self, height: u64, producer: &str) {
        // CRITICAL FIX: Blocks 1-30 are round 0, 31-60 are round 1, etc.
        let round = if height == 0 {
            0  // Genesis block
        } else {
            (height - 1) / ROTATION_INTERVAL_BLOCKS
        };
        let mut rotations = self.current_rotations.write().await;
        
        let entry = rotations.entry(round).or_insert((producer.to_string(), 0, height));
        entry.1 += 1; // Increment block count
    }
    
    /// Check if rotation completed and return producer info
    pub async fn check_rotation_complete(&self, height: u64) -> Option<(String, u32)> {
        if height % ROTATION_INTERVAL_BLOCKS == 0 && height > 0 {
            let round = (height - 1) / ROTATION_INTERVAL_BLOCKS; // Previous round
            let mut rotations = self.current_rotations.write().await;
            
            if let Some((producer, blocks, _)) = rotations.remove(&round) {
                return Some((producer, blocks));
            }
        }
        None
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2.96: HeartbeatCommitment TX tracking with confirmation and retry support
// ═══════════════════════════════════════════════════════════════════════════════

/// Status of HeartbeatCommitment TX - tracks from creation to confirmation
#[derive(Debug, Clone)]
pub struct HeartbeatCommitmentStatus {
    /// TX hash for tracking (latest)
    pub tx_hash: String,
    /// ALL TX hashes sent for this epoch (original + retries)
    /// v10.1 FIX: confirmation check must find ANY of these, not just the latest
    pub all_tx_hashes: Vec<String>,
    /// Block height when TX was created and sent
    pub sent_at_height: u64,
    /// Block height when TX was confirmed (included in block), None if pending
    pub confirmed_at_height: Option<u64>,
    /// Number of retry attempts
    pub retry_count: u8,
    /// Timestamp when TX was created
    pub created_at: u64,
}

impl HeartbeatCommitmentStatus {
    pub fn new(tx_hash: String, sent_at_height: u64) -> Self {
        let all = vec![tx_hash.clone()];
        Self {
            tx_hash,
            all_tx_hashes: all,
            sent_at_height,
            confirmed_at_height: None,
            retry_count: 0,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        }
    }
    
    pub fn is_confirmed(&self) -> bool {
        self.confirmed_at_height.is_some()
    }
    
    pub fn mark_confirmed(&mut self, block_height: u64) {
        self.confirmed_at_height = Some(block_height);
    }
    
    pub fn increment_retry(&mut self) {
        self.retry_count += 1;
    }
}

/// Main blockchain node with unified P2P and regional clustering
pub struct BlockchainNode {
    storage: Arc<Storage>,
    state: Arc<RwLock<StateManager>>,
    // CRITICAL v2.26: Removed outer RwLock - SimpleMempool is already thread-safe (DashMap + parking_lot)
    // This eliminates the 100K TPS bottleneck from external lock contention
    mempool: Arc<qnet_mempool::SimpleMempool>,
    // validator: Arc<Validator>, // disabled for compilation

    // Unified P2P with regional clustering and automatic failover (single network interface)
    unified_p2p: Option<Arc<SimplifiedP2P>>,

    // Node configuration
    node_id: String,
    node_type: NodeType,
    region: Region,
    
    // Malicious behavior detection
    
    // MEV PROTECTION: Optional private bundle mempool (0-20% dynamic allocation)
    // ARCHITECTURE: Protects critical transactions (DeFi, arbitrage) from front-running
    mev_mempool: Option<Arc<qnet_mempool::MevProtectedMempool>>,
    
    // Rotation tracking for atomic rewards
    rotation_tracker: Arc<RotationTracker>,
    p2p_port: u16,
    bootstrap_peers: Vec<String>,
    
    // Performance configuration
    perf_config: PerformanceConfig,
    
    // Security configuration (integrated with qnet-core security)
    security_config: qnet_core::security::SecurityConfig,
    
    // State
    height: Arc<RwLock<u64>>,
    is_running: Arc<RwLock<bool>>,
    
    // Micro/macro block tracking
    current_microblocks: Arc<RwLock<Vec<qnet_state::MicroBlock>>>,
    last_microblock_time: Arc<RwLock<Instant>>,
    microblock_interval: Duration,
    is_leader: Arc<RwLock<bool>>,
    
    // DYNAMIC: Block production timing (no timestamp dependency)
    last_block_attempt: Arc<tokio::sync::Mutex<Option<Instant>>>,
    

    
    // PRODUCTION: Consensus phase synchronization data
    consensus_nonce_storage: Arc<RwLock<HashMap<String, ([u8; 32], Vec<u8>)>>>, // participant -> (nonce, reveal_data)
    
    // Sharding components for regional scaling
    shard_coordinator: Option<Arc<qnet_sharding::ShardCoordinator>>,
    parallel_validator: Option<Arc<qnet_sharding::ParallelValidator>>,
    
    // Archive replication manager for distributed storage
    archive_manager: Arc<tokio::sync::RwLock<crate::archive_manager::ArchiveReplicationManager>>,
    
    // Reward manager for lazy rewards system
    
    // PRODUCTION v2.96: Track HeartbeatCommitment TXs with confirmation status
    // DashMap: epoch -> HeartbeatCommitmentStatus (pending/confirmed + retry tracking)
    // Replaces simple HashSet for retry mechanism support
    heartbeat_commitment_tracker: Arc<DashMap<u64, HeartbeatCommitmentStatus>>,
    
    // PRODUCTION v2.78: Track BitmapCommitment TXs by epoch with confirmation + retry
    // Same pattern as heartbeat_commitment_tracker for consistency
    bitmap_commitment_tracker: Arc<DashMap<u64, HeartbeatCommitmentStatus>>,
    
    // Parallel Executor for parallel transaction execution
    parallel_executor: Option<Arc<crate::parallel_executor::ParallelExecutor>>,
    
    // Adaptive BFT for adaptive timeouts
    adaptive_bft: Arc<crate::adaptive_bft::AdaptiveBft>,
    
    // Pre-execution for speculative transaction processing
    pre_execution: Arc<crate::pre_execution::PreExecutionManager>,
    
    // Event-based block notification system (replaces polling in consensus listener)
    // Sender broadcasts new block height to all subscribers
    block_event_tx: tokio::sync::broadcast::Sender<u64>,
    
    // v3.35: O(1) node registration cache — replaces O(N) blockchain scan
    // Maps node_id -> (NodeType, wallet_address, api_endpoint)
    // Populated on startup from blockchain + updated when NodeRegistration TXs are processed
    node_registration_cache: Arc<DashMap<String, (qnet_state::NodeType, String, String)>>,

    // PRODUCTION v4.0: Wallet identity from QNET_WALLET_SEED (seed → wallet + ML-DSA-65 keypair)
    // Used for: VRF producer election, registration proof, P2P message signing
    wallet_identity: Option<Arc<crate::crypto::vrf::WalletIdentity>>,

    // ML-DSA-65-VRF instance. The leader schedule is a public deterministic hash;
    // the VRF signs slot proofs and feeds the randomness beacon.
    // Initialized from wallet_identity's keypair at startup
    vrf_instance: Option<Arc<crate::crypto::vrf::DilithiumVrf>>,

    // ═══════════════════════════════════════════════════════════════════
    // L1 ARCHITECTURE: Coordinator + Pipeline + SyncManager
    // Replaces 127 atomic flags with single state machine,
    // monolithic process_received_blocks with staged pipeline,
    // ad-hoc sync with wave-based sync manager.
    // ═══════════════════════════════════════════════════════════════════

    /// Consensus state coordinator — single source of truth for node phase
    coordinator_handle: Option<crate::consensus_state::CoordinatorHandle>,

    /// Pipeline ingest handle — submit blocks for decode → verify → apply
    pipeline_ingest: Option<crate::block_pipeline::PipelineIngest>,

    /// Sync manager handle — wave-based block download coordinator
    sync_handle: Option<crate::sync_manager::SyncHandle>,
}

/// What the schedule allows at a height. Total, and identical on every node — the verdict is pure
/// height arithmetic, so there is no "cannot tell" arm and no cohort that skips enforcement.
#[derive(Debug, PartialEq, Eq)]
pub enum EmissionExpectation {
    /// The schedule allows no emission at this height — any claimed amount is invalid.
    NoneDue,
    /// The single amount this height may mint.
    Exact(u64),
}

// ═══════════════════════════════════════════════════════════════════════
// v10.0: BlockApplyResult — returned by apply_block_to_state()
// Contains merkle root + all deferred side effects for caller persistence.
// ═══════════════════════════════════════════════════════════════════════
pub struct BlockApplyResult {
    pub merkle_root: [u8; 32],
    /// Set when a claim referenced an epoch whose certifying macroblock is absent. The block MUST
    /// NOT be committed: fetch that macroblock and re-apply.
    pub reward_epoch_missing: Option<u64>,

    pub deferred_pool3: u64,
    // (node_id, type_str, wallet, burn_tx). burn_tx empty for non-NodeRegistration (activations).
    // (node_id, type, wallet, burn, consensus_pubkey_hex). The 5th = the registrant's on-chain
    // vrf/consensus pubkey (tx.dilithium_public_key) → registry_root binds sha3 of it for light-client
    // committee verification. Empty for activation/pseudonym rows (the NodeRegistration row is authoritative).
    pub deferred_registrations: Vec<(String, String, String, String, String)>,
    /// (node_id, wallet) of the NodeRegistration TXs applied in this block — the dedup reseed source.
    /// Kept separate from deferred_registrations because activations write registry rows too, and an
    /// activation-derived origin would make a restarted node reject the honest follow-on registration.
    /// The producer marks these inline; a validator must mark exactly the same set or its dedup map is
    /// incomplete after a restart and it admits a duplicate registration nobody else does.
    pub deferred_registration_origins: Vec<(String, String)>,
    /// FIX-5: (sender_address, raw ML-DSA-65 pk) for each value-TX carrying a wire pk (first-use).
    /// Drained at commit into the dilithium_pk_root LtHash (marker-guarded ⇒ once per account).
    pub deferred_pk_binds: Vec<(String, Vec<u8>)>,
    /// AFTER the state write-lock so the O(recipients) merkle build never blocks block apply.
    /// Boundary height whose committed light-eligibility the caller snapshots into the light_elig_ recency
    /// index — run AFTER the state write-lock so the O(roster) scan never blocks block apply at scale.
    pub deferred_light_elig: Option<u64>,
    /// Durable side-index rows this block WOULD write. Both indices are write-once — `super_elig_`
    /// is add-only, `light_bm_` keeps the lowest inclusion height — so a speculative apply that loses its slot can
    /// never take its rows back. Held here and written only once the block is canonical.
    pub side_indices: BlockSideIndices,
}

#[derive(Default, Debug)]
pub struct BlockSideIndices {
    /// (epoch, genesis shard index, inclusion height, bitmap)
    pub light_bitmaps: Vec<(u64, usize, u64, Vec<u8>)>,
    /// Display-only rich-list deltas. In no root, but still a durable write that must not happen
    /// speculatively.
    pub richlist: Vec<(String, Option<u64>)>,
    /// (finalized epoch, eligible super node_ids) — computed under the state lock, written after.
    pub super_eligible: Option<(u64, Vec<String>)>,
    pub block_logs: Vec<(String, String, Vec<u8>)>,
    pub token_rows: Vec<crate::storage::TokenTransferRow>,
}

/// Outcome of resolving a wallet's per-epoch claim against the sharded reward structure.
#[derive(Debug)]
pub(crate) enum ShardClaim {
    /// Recipient found; (amount, proof) — proof empty when the caller requested amount-only.
    Proof(u64, Vec<(String, bool)>),
    /// Structure present + consistent with the committed root, but the wallet is not a recipient.
    NotRecipient,
    /// Reconstructed shard-roots do not recombine to the committed root (drifted/catch-up node): skip.
    Divergent,
    /// Sharded structure not present on this node (e.g. snapshot-synced): caller rebuilds once.
    Absent,
}

#[allow(dead_code)]
/// The burn owner's authorization, carried to every attestor. An attestor that cannot verify it
/// against the burning Solana address refuses to attest — otherwise the first caller to name ANY
/// beneficiary for a PUBLIC burn_tx locks the per-attestor dedup and bricks the real owner's burn.
/// Replayable source of an epoch's ELIGIBLE light nodes, in node_id order.
///
/// Holds only the 5 shard bitmaps and the roster cutoff — never the recipient list. `for_each`
/// re-derives the eligible set from the on-disk roster scan on every call, so the reward build can
/// COUNT and then EMIT without materialising ~10M entries (the collected vector was ~1.5 GB at the
/// target). Deterministic across passes and nodes: the scan is node_id-ordered and the shard-local
/// index is recomputed in that same order — exactly how the bitmap was written.
#[derive(Default, Clone)]
pub(crate) struct LightRewardSource {
    cutoff: u64,
    bitmaps: std::collections::BTreeMap<usize, Vec<u8>>,
}

impl LightRewardSource {
    fn for_each(
        &self,
        storage: &crate::storage::Storage,
        f: &mut dyn FnMut(&str, &str),
    ) -> crate::errors::IntegrationResult<()> {
        if self.bitmaps.is_empty() { return Ok(()); }
        // Bit position is the node's PERMANENT reg_index. Under the old scan-relative ordinal a
        // truncated roster shifted every later node, so the bitmap was read at the wrong offsets:
        // not a smaller payout set, a DIFFERENT one. light_roster_for_each is fail-closed on a
        // mid-scan error, which propagates here.
        storage.light_roster_for_each(self.cutoff, |node_id, wallet, reg_index| {
            let gidx = light_shard_of(node_id);
            let bit = reg_index as usize;
            if let Some(bm) = self.bitmaps.get(&gidx) {
                if bm.get(bit / 8).map(|b| b & (1 << (bit % 8)) != 0).unwrap_or(false) {
                    f(node_id, wallet);
                }
            }
        })
    }
}

/// Frozen-roster disposition (A1 R1). Selected once per resolution from an atomic (L, B) read.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum RosterMode { Sealed, Defer, Frozen }


pub struct BurnOwnerProof<'a> {
    pub node_id: &'a str,
    pub registration_proof: &'a str,
    pub timestamp: u64,
    pub signature: &'a str,
    /// sha3-256 tag of the registration's attestation root, so the attestor rebuilds the exact string
    /// the owner signed without needing the 1952-byte key itself.
    pub attest_root_tag: &'a str,
}

impl BlockchainNode {
    
    /// v2.96: Get state manager for blockchain state access (pending_rewards, balances, etc)
    pub fn get_state_manager(&self) -> Arc<RwLock<StateManager>> {
        self.state.clone()
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PRODUCTION v4.0: Wallet Identity + ML-DSA-65-VRF
    // ═══════════════════════════════════════════════════════════════════════

    /// Initialize WalletIdentity from seed phrase
    /// Loads persistent ML-DSA-65 keypair from DilithiumKeyManager
    /// Derives deterministic wallet address from seed (SHA3-256)
    fn initialize_wallet_identity(&mut self, wallet_seed: &str) -> Result<(), String> {
        use crate::crypto::key_manager::DilithiumKeyManager;
        use crate::crypto::vrf::WalletIdentity;
        use pqcrypto_traits::sign::{PublicKey as PkTrait, SecretKey as SkTrait};

        // ─────────────────────────────────────────────────────────────────
        // ANCHOR INSTALL MUST PRECEDE THE STRICT GUARD
        // ─────────────────────────────────────────────────────────────────
        // The strict guard below consults `get_consensus_pk_anchor`, which
        // reads the anchor map populated by `install_genesis_anchors_at_startup`.
        // Historically the anchor install ran inside `start()` AFTER node
        // construction (which is what runs `initialize_wallet_identity`),
        // so the anchor map was empty at strict-guard time and the guard
        // silently no-op'd. Calling the installer here as the first action
        // of `initialize_wallet_identity` puts the file load BEFORE the
        // strict guard so the guard can actually do its job.
        //
        // Idempotency: `install_genesis_anchors_at_startup` is a no-op once
        // the consensus-layer anchor map is populated (immutable singleton).
        // Calling it twice (here + in `start()`) costs at most one extra
        // file-existence check and one log line.
        let _ = crate::genesis_constants::install_genesis_anchors_at_startup();

        // v27 HOLE1: fail-closed backend self-test before any key use
        // (incompat → boot refusal, not split).
        crate::crypto::genesis_key::assert_backend_compatible_or_die();

        // v27 HOLE1: deterministic keypair from mnemonic (wipe-safe, no TOFU);
        // key_dir kept only as the process-wide cache key.
        let key_dir = std::path::PathBuf::from("/app/data/keys");
        let km = DilithiumKeyManager::new(self.node_id.clone(), &key_dir)
            .map_err(|e| format!("[ERR][NODE] key_manager_init err={}", e))?;
        // Fail-closed structural guard: a wrong-length seed must refuse boot, not
        // silently derive a valid-but-wrong identity. Derivation below reads
        // wallet_seed unchanged, so a valid mnemonic is unaffected (genesis-safe).
        crate::crypto::solana_derivation::validate_bip39_structure(wallet_seed)
            .map_err(|e| format!("[ERR][NODE] wallet_seed_invalid {}", e))?;
        let (pk, sk) = km.get_keypair_from_mnemonic(wallet_seed)
            .map_err(|e| format!("[ERR][NODE] keypair err={}", e))?;
        let pk_bytes = PkTrait::as_bytes(&pk).to_vec();
        let sk_bytes = SkTrait::as_bytes(&sk).to_vec();

        // Strict identity-key anchor enforcement: refuse to start (FATAL
        // panic) when the local ML-DSA-65 PK does not match this node's
        // chain anchor. Closes the pk_mismatch deadlock root cause — a node
        // that lost its keypair and regenerated a random PK silently signs
        // with a key no peer's registry accepts (every inbound sig
        // Tier-1-rejected; it only burns pacemaker slots, h=781). Anchor
        // present + match → proceed; mismatch → panic (restore the keypair
        // from backup, never overwrite the anchor); no anchor → proceed
        // (non-genesis identity binding is via signed NodeRegistration).
        // O(1) lookup at startup.
        if let Some(anchor_pk) = qnet_consensus::consensus_crypto::get_consensus_pk_anchor(&self.node_id) {
            if anchor_pk != pk_bytes {
                // Build a non-secret diagnostic for the operator. Hash both
                // PKs so we never log raw key bytes; the prefix is enough
                // to verify which key file the operator has on disk.
                let local_hash = hex::encode(&Sha3_256::digest(&pk_bytes)[..8]);
                let anchor_hash = hex::encode(&Sha3_256::digest(&anchor_pk)[..8]);
                eprintln!(
                    "[CRIT][NODE] identity_anchor_mismatch node={} local_pk_hash={} anchor_pk_hash={} \
                     action=halt_startup hint=restore_dilithium_keypair_bin_from_backup",
                    self.node_id, local_hash, anchor_hash
                );
                return Err(format!(
                    "FATAL: identity-anchor mismatch for {}. Local keypair does not match the \
                     genesis anchor; the previous keypair file was lost or replaced. Restore \
                     /app/data/keys/dilithium_keypair.bin from backup before starting again. \
                     Continuing would silently invalidate every signature this node emits.",
                    self.node_id
                ));
            }
            if is_info() {
                let pk_hash_short = hex::encode(&Sha3_256::digest(&pk_bytes)[..8]);
                println!(
                    "[INFO][NODE] identity_anchor_match node={} pk_hash={}",
                    self.node_id, pk_hash_short
                );
            }
        }

        // Create WalletIdentity (seed → wallet address + keypair reference)
        let identity = WalletIdentity::from_seed_and_keys(wallet_seed, pk_bytes.clone(), sk_bytes)?;

        println!("[INFO][NODE] wallet={} pk_len={}", identity.wallet_address, identity.dilithium_pk.len());

        // Wallet half of the genesis identity anchor. The consensus half above is loud on mismatch;
        // without this one a genesis node whose seed drifted from GENESIS_WALLETS runs fine and
        // credits every reward to an address its operator holds no key for.
        if let Some(bootstrap_id) = self.node_id.strip_prefix("genesis_node_") {
            if let Some((_, anchor_wallet)) = crate::genesis_constants::GENESIS_WALLETS
                .iter().find(|(id, _)| *id == bootstrap_id)
            {
                if identity.wallet_address != *anchor_wallet {
                    eprintln!(
                        "[CRIT][NODE] genesis_wallet_anchor_mismatch node={} local={} anchor={} \
                         action=halt_startup hint=check_QNET_WALLET_SEED_matches_genesis_seed",
                        self.node_id, identity.wallet_address, anchor_wallet
                    );
                    return Err(format!(
                        "FATAL: genesis wallet anchor mismatch for {}. The seed in use derives {} \
                         but the chain credits rewards to {}. Start with the genesis seed for this \
                         bootstrap id; continuing would pay this node into an unowned wallet.",
                        self.node_id, identity.wallet_address, anchor_wallet
                    ));
                }
                println!("[INFO][NODE] genesis_wallet_anchor_match node={} wallet={}",
                         self.node_id, identity.wallet_address);
            }
        }

        // v4.2: Register own VRF public key in global registry + persist to RocksDB
        // Without this, other nodes cannot verify our VRF claims
        crate::genesis_constants::register_vrf_public_key(&self.node_id, &pk_bytes);
        let pk_hex = hex::encode(&pk_bytes);
        if let Err(e) = self.storage.save_vrf_public_key(&self.node_id, &pk_hex) {
            println!("[WARN][VRF] pk_persist err={}", e);
        }
        if is_info() {
            println!("[INFO][VRF] self_pk_registered node={} pk_hash={}",
                     self.node_id, &pk_hex[..16]);
        }

        // v14.8: Register OWN PK with the consensus-layer registry. We hold the
        // private key locally, so self-registration is implicitly proven. This
        // closes the "pk_not_registered" rejection path for our own signatures
        // as soon as the node has a keypair in hand.
        //
        // v16.1: After the anchor match guard above, this call is guaranteed
        // to either succeed (PK matches anchor or no anchor) or be rejected
        // by `register_consensus_pk_from_chain`'s anti-squat check (which
        // would only fire on a defensive double-check race — the explicit
        // panic above already covers the normal path).
        if !qnet_consensus::consensus_crypto::register_consensus_pk_from_chain(&self.node_id, &pk_bytes) {
            println!("[WARN][CONSENSUS] self_consensus_pk_register_failed node={}", self.node_id);
        }

        // Create VRF instance from this identity
        let vrf = identity.create_vrf(&self.node_id)?;

        let vrf_arc = Arc::new(vrf);
        self.wallet_identity = Some(Arc::new(identity));
        self.vrf_instance = Some(vrf_arc.clone());

        // Set global VRF instance for static access in select_producer
        {
            let mut global = GLOBAL_VRF_INSTANCE.lock();
            *global = Some(vrf_arc);
        }
        Ok(())
    }

    /// Get wallet address (prefers seed-derived, falls back to legacy)
    pub fn get_wallet_address_v2(&self) -> String {
        if let Some(ref identity) = self.wallet_identity {
            identity.wallet_address.clone()
        } else {
            self.get_wallet_address() // legacy fallback
        }
    }

    /// Get VRF instance for producer election
    pub fn get_vrf(&self) -> Option<Arc<crate::crypto::vrf::DilithiumVrf>> {
        self.vrf_instance.clone()
    }

    /// Get wallet identity for signing
    pub fn get_wallet_identity(&self) -> Option<Arc<crate::crypto::vrf::WalletIdentity>> {
        self.wallet_identity.clone()
    }

    
    /// PRODUCTION v2.78 / v3.41: Cleanup ALL ephemeral data from RocksDB (>24h)
    /// Called every hour by continuous pinging loop
    /// SAFETY: Only removes data older than 24h, current epoch (4h) data is preserved
    /// v3.41: Extended to clean ping_history, consensus, failover_events,
    /// old snapshots + compaction to physically reclaim disk space
    pub async fn cleanup_old_storage_data(&self) {
        // CRITICAL: cutoff = now - 24h, so only data older than 24h is removed
        // Current epoch is 4h, so last 6 epochs (24h) are kept safe
        let cutoff = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() - (24 * 60 * 60);
        let current_height = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);

        // v4.1: Cleanup heartbeat_commitment_tracker (keep last 5 epochs).
        // Lock-free RAM retain — stays inline.
        {
            const EMISSION_BLOCK_INTERVAL: u64 = 14400;
            let current_epoch = current_height / EMISSION_BLOCK_INTERVAL;
            let before = self.heartbeat_commitment_tracker.len();
            self.heartbeat_commitment_tracker.retain(|epoch, _| {
                *epoch + 5 >= current_epoch
            });
            let removed = before.saturating_sub(self.heartbeat_commitment_tracker.len());
            if removed > 0 && is_info() {
                println!("[INFO][CLEANUP] heartbeat_commitment_tracker_cleaned removed={} current_epoch={}", removed, current_epoch);
            }
        }

        // The RocksDB sweep is multi-second synchronous FFI (measured 3-6s, and it grows
        // with the database). Awaiting it on the consensus runtime stalls block apply and
        // starves the producer watchdog, which then reports the node as silent.
        let storage = self.storage.clone();
        let started = std::time::Instant::now();
        let joined = tokio::task::spawn_blocking(move || {
            // Attestations are swept inside run_ephemeral_cleanup so its compaction decision
            // sees that CF's deletions too.
            if let Err(e) = storage.run_ephemeral_cleanup(current_height, cutoff) {
                if is_warn() {
                    println!("[WARN][CLEANUP] ephemeral_cleanup_failed err={}", e);
                }
            }
            // Macroblocks are never pruned on a Super (archival role), so their committee signatures
            // are the one store with no horizon. Strip them past the cold-join walk budget; the
            // checkpoint half every stored reader uses stays.
            if let Err(e) = storage.strip_macroblock_qc_sigs() {
                if is_warn() {
                    println!("[WARN][CLEANUP] qc_sig_strip_failed err={}", e);
                }
            }
        })
        .await;
        if joined.is_err() && is_warn() {
            println!("[WARN][CLEANUP] cleanup_task_panicked elapsed_ms={}", started.elapsed().as_millis());
        }
    }
    

    /// Get Parallel Executor reference
    pub fn get_parallel_executor(&self) -> &Option<Arc<crate::parallel_executor::ParallelExecutor>> {
        &self.parallel_executor
    }
    
    /// Get Pre-execution manager
    pub fn get_pre_execution(&self) -> Arc<crate::pre_execution::PreExecutionManager> {
        self.pre_execution.clone()
    }
    
    /// Get Adaptive BFT manager
    pub fn get_adaptive_bft(&self) -> Arc<crate::adaptive_bft::AdaptiveBft> {
        self.adaptive_bft.clone()
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v2.71: ON-CHAIN NODE REGISTRATION
    // All nodes must register on-chain to receive rewards
    // This ensures wallet→node binding is cryptographically verified and immutable
    // ═══════════════════════════════════════════════════════════════════════════
    
    pub async fn get_height(&self) -> u64 {
        *self.height.read().await
    }
    
    /// v2.42.2: Synchronous height access for heartbeat service
    /// Uses try_read to avoid blocking - returns last known height or 0
    /// SAFE: Can be called from any context (sync or async)
    pub fn get_height_sync(&self) -> u64 {
        // Try non-blocking read first
        match self.height.try_read() {
            Ok(guard) => *guard,
            Err(_) => {
                // Lock contention - return 0 (heartbeat will use current height next time)
                // This is safe because heartbeats are not height-critical
                0
            }
        }
    }
    
    pub async fn get_peer_count(&self) -> Result<usize, QNetError> {
        if let Some(unified_p2p) = &self.unified_p2p {
            Ok(unified_p2p.get_peer_count())
        } else {
            Ok(0)
        }
    }
    
    pub fn get_node_type(&self) -> NodeType {
        self.node_type
    }
    
    /// Add discovered peers to P2P system (for dynamic peer injection)
    pub fn add_discovered_peers(&self, peer_addresses: &[String]) {
        if let Some(unified_p2p) = &self.unified_p2p {
            unified_p2p.add_discovered_peers(peer_addresses);
        }
    }
    
    pub fn get_region(&self) -> Region {
        self.region
    }
    
    pub fn get_port(&self) -> u16 {
        self.p2p_port
    }
    
    pub fn get_node_id(&self) -> String {
        self.node_id.clone()
    }
    
    pub fn get_storage(&self) -> Arc<Storage> {
        self.storage.clone()
    }
    
    pub async fn is_leader(&self) -> bool {
        *self.is_leader.read().await
    }
    
    /// Check if this node will be the producer for the next block
    pub async fn is_next_block_producer(&self) -> bool {
        // CRITICAL FIX: Use network consensus height, not local height
        // This prevents multiple nodes thinking they are producers
        let local_height = self.get_height().await;
        let network_height = if let Some(p2p) = &self.unified_p2p {
            // Try to get network consensus height
            match p2p.sync_blockchain_height().await {
                Ok(h) => h,
                Err(_) => {
                    // Fallback to cached or local height
                    p2p.get_cached_network_height()
                        .unwrap_or(local_height)
                }
            }
        } else {
            local_height
        };
        
        // CRITICAL FIX: Use local height for next block, not network height
        // We need to check if THIS node is producer for ITS next block
        let next_height = local_height + 1;
        
        // Get producer for next block using same logic as microblock production
        let producer = Self::select_microblock_producer(
            next_height,
            &self.unified_p2p,
            &self.node_id,
            self.node_type,
            Some(&self.storage),
        ).await;
        
        // Additional check: only return true if we're synchronized
        let is_synchronized = !self.is_syncing() && 
                            self.get_height().await >= network_height.saturating_sub(10);
        
        producer == self.node_id && is_synchronized
    }
    
    /// Check if node is currently syncing.
    /// Uses coordinator state machine (preferred) with legacy flag fallback.
    pub fn is_syncing(&self) -> bool {
        coordinator_is_syncing() || !coordinator_is_synchronized()
    }
    
    pub fn get_start_time(&self) -> chrono::DateTime<chrono::Utc> {
        // PRODUCTION FIX: Use actual node start time from environment
        if let Ok(start_time_str) = std::env::var("QNET_NODE_START_TIME") {
            if let Ok(timestamp) = start_time_str.parse::<i64>() {
                return chrono::DateTime::from_timestamp(timestamp, 0)
                    .unwrap_or_else(|| chrono::Utc::now());
            }
        }
        // Fallback to current time if not set (should not happen)
        chrono::Utc::now()
    }
    
    /// PRIVACY: Get public display name for API responses (preserves consensus node_id)
    pub fn get_public_display_name(&self) -> String {
        match self.node_type {
            NodeType::Light => {
                // Light nodes already use pseudonyms from registration
                self.node_id.clone()
            },
            _ => {
                // CRITICAL: Genesis nodes keep original ID for consensus stability
                if self.node_id.starts_with("genesis_node_") {
                    return self.node_id.clone();
                }
                
                // Super nodes: Generate privacy-preserving display name
                self.generate_full_super_display_name()
            }
        }
    }
    
    /// PRIVACY: Generate display name for Super nodes (preserves IP privacy)
    fn generate_full_super_display_name(&self) -> String {
        // EXISTING PATTERN: Use blake3 hash like other identity functions
        let wallet_address = self.get_wallet_address();
        let display_hash = blake3::hash(format!("FULL_SUPER_DISPLAY_{}_{}", 
                                                wallet_address, 
                                                format!("{:?}", self.node_type)).as_bytes());
        
        // PRIVACY: Generate server-friendly display name without revealing IP
        // v3.18: Super node type removed
        let node_type_prefix = match self.node_type {
            NodeType::Super => "super",
            NodeType::Light => "light",
        };
        
        let region_hint = format!("{:?}", self.region).to_lowercase();
        
        format!("{}_{}_{}", 
                node_type_prefix,
                region_hint, 
                &display_hash.to_hex()[..8])
    }
    

    /// PRODUCTION: Get unified P2P instance for external access (RPC, etc.)
    pub fn get_unified_p2p(&self) -> Option<Arc<SimplifiedP2P>> {
        self.unified_p2p.clone()
    }

    pub fn get_regional_health(&self) -> f64 {
        if let Some(unified_p2p) = &self.unified_p2p {
            unified_p2p.get_regional_health()
        } else {
            0.0
        }
    }
    
    pub async fn get_mempool_size(&self) -> Result<usize, QNetError> {
        // v2.26: Direct access - SimpleMempool is already thread-safe
        Ok(self.mempool.size())
    }
    
    /// Get mempool Arc for RPC access
    /// v2.26: No outer RwLock - SimpleMempool is already thread-safe (DashMap + parking_lot)
    pub fn get_mempool(&self) -> Arc<qnet_mempool::SimpleMempool> {
        self.mempool.clone()
    }
    
    /// Get MEV mempool if enabled
    pub fn get_mev_mempool(&self) -> Option<Arc<qnet_mempool::MevProtectedMempool>> {
        self.mev_mempool.clone()
    }
    
    /// Get P2P for reputation lookups
    pub fn get_p2p(&self) -> Option<Arc<SimplifiedP2P>> {
        self.unified_p2p.clone()
    }
    
    // =========================================================================
    // SNAPSHOT API (v2.19.12) - For P2P Fast Sync
    // =========================================================================
    
    /// Get latest snapshot height for P2P sync
    pub fn get_latest_snapshot_height(&self) -> Result<Option<u64>, QNetError> {
        self.storage.get_latest_snapshot_height()
            .map_err(|e| QNetError::StorageError(e.to_string()))
    }

    pub fn get_highest_snapshot_height_le(&self, ceiling: u64) -> Result<Option<u64>, QNetError> {
        self.storage.get_highest_snapshot_height_le(ceiling)
            .map_err(|e| QNetError::StorageError(e.to_string()))
    }
    
    /// Get snapshot IPFS CID if available
    pub fn get_snapshot_ipfs_cid(&self, height: u64) -> Result<Option<String>, QNetError> {
        self.storage.get_snapshot_ipfs_cid(height)
            .map_err(|e| QNetError::StorageError(e.to_string()))
    }
    
    /// Get raw snapshot data for P2P download
    pub fn get_snapshot_data(&self, height: u64) -> Result<Option<Vec<u8>>, QNetError> {
        self.storage.get_snapshot_data(height)
            .map_err(|e| QNetError::StorageError(e.to_string()))
    }
    
    pub async fn get_block(&self, height: u64) -> Result<Option<qnet_state::Block>, QNetError> {
        // v2.70: Use auto-format loader that handles both EfficientMicroBlock and legacy MicroBlock
        // EfficientMicroBlock stores only TX hashes - full TXs are in separate "transactions" CF
        // load_microblock_auto_format() reconstructs full block with transactions
        match self.storage.load_microblock_auto_format(height) {
            Ok(Some(microblock)) => {
                // Convert MicroBlock to Block format for API compatibility
                let block = qnet_state::Block {
                    height: microblock.height,
                    timestamp: microblock.timestamp,
                    previous_hash: microblock.previous_hash,
                    merkle_root: microblock.merkle_root,
                    transactions: microblock.transactions,
                    producer: microblock.producer.clone(),
                    signature: microblock.signature,
                    block_type: "MICROBLOCK".to_string(),
                };
                Ok(Some(block))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(QNetError::StorageError(e.to_string())),
        }
    }
    
    pub async fn get_macroblock(&self, index: u64) -> Result<Option<qnet_state::MacroBlock>, QNetError> {
        // Get macroblock by index (not height!)
        // Macroblock #1 = blocks 1-90, #2 = blocks 91-180, etc.
        match self.storage.get_macroblock_by_height(index) {
            Ok(Some(data)) => {
                // Fail-closed: a zstd-magic block that won't decompress is corrupt — hard reject,
                // never fall through to raw bytes (that would parse-diverge across nodes).
                let decompressed_data = Self::macroblock_plaintext(data)
                    .ok_or_else(|| QNetError::StorageError(
                        format!("[REJECT][BLOCK] macroblock_decompress_failed index={}", index)))?;

                // Deserialize MacroBlock
                match bincode::deserialize::<qnet_state::MacroBlock>(&decompressed_data) {
                    Ok(macroblock) => Ok(Some(macroblock)),
                    Err(e) => Err(QNetError::StorageError(format!("Failed to deserialize macroblock: {}", e))),
                }
            }
            Ok(None) => Ok(None),
            Err(e) => Err(QNetError::StorageError(e.to_string())),
        }
    }
    
}

/// Peer information for RPC responses
#[derive(Debug, Clone)]
pub struct PeerInfo {
    pub id: String,
    pub address: String,
    pub node_type: String,
    pub region: String,
    pub last_seen: u64,
    pub connection_time: u64,
    pub reputation: f64,
    pub version: Option<String>,
}

/// Transaction information for RPC responses  
#[derive(Debug, Clone)]
pub struct TransactionInfo {
    pub hash: String,
    pub from: String,
    pub to: Option<String>,
    pub amount: u64,
    pub nonce: u64,
    pub gas_price: u64,
    pub gas_limit: u64,
    pub timestamp: u64,
    pub block_height: Option<u64>,
    pub status: String,
    pub tx_type: Option<String>,
    // Fast Finality Indicators (optional for backward compatibility)
    pub confirmation_level: Option<ConfirmationLevel>,
    pub safety_percentage: Option<f64>,
    pub confirmations: Option<u32>,
    pub time_to_finality: Option<u64>,
    // QUANTUM v2.25.2: Optional Dilithium signature info
    pub dilithium_signature: Option<String>,
    pub dilithium_public_key: Option<String>,
}

impl TransactionInfo {
    /// QUANTUM v2.25.2: Check if transaction has Dilithium signature.
    /// FIX-5: SIGNATURE-only — the pubkey is elidable once committed on-chain (the node rehydrates it),
    /// so requiring it here would label every elided TX "unsigned" in the RPC/explorer view. Mirrors the
    /// consensus-side qnet_state::Transaction::is_quantum_signed.
    pub fn is_quantum_signed(&self) -> bool {
        self.dilithium_signature.is_some()
    }
    
    /// QUANTUM v2.25.2: Get effective gas price (50% higher for Dilithium TX)
    pub fn effective_gas_price(&self) -> u64 {
        if self.is_quantum_signed() {
            self.gas_price + (self.gas_price / 2)
        } else {
            self.gas_price
        }
    }
}

/// Fast Finality Indicators - confirmation levels for better UX
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum ConfirmationLevel {
    Pending,           // In mempool (0s)
    InBlock,           // 1 confirmation in microblock (1-2s)
    QuickConfirmed,    // 5+ confirmations (5-10s)  
    NearFinal,         // 30+ confirmations (30s)
    FullyFinalized,    // In macroblock (90s)
}

/// PRODUCTION: Cryptographic verification of genesis node certificates
/// Prevents impersonation attacks by validating node identity
#[allow(dead_code)]
fn verify_genesis_node_certificate(node_id: &str) -> bool {
    use std::env;
    
    // Bootstrap nodes are trusted during initial network formation
    // Check if this is a bootstrap node (Genesis nodes 001-005)
    let is_bootstrap_node = std::env::var("QNET_BOOTSTRAP_ID").is_ok() || 
                           std::env::var("QNET_GENESIS_BOOTSTRAP").unwrap_or_default() == "1";
    
    if is_bootstrap_node {
        println!("[INFO][NODE] bootstrap_allowed node={} cert_check=skipped", node_id);
        return true; // Trust bootstrap nodes during initial network formation
    }
    
    // SECURITY: Genesis nodes must have cryptographic proof of identity
    // In production, this would verify against hardcoded genesis certificates
    
    // Get genesis certificate from secure environment
    let genesis_cert_key = format!("QNET_GENESIS_CERT_{}", node_id.replace("-", "_"));
    let genesis_certificate = match env::var(&genesis_cert_key) {
        Ok(cert) => cert,
        Err(_) => {
            // PRODUCTION: Genesis nodes MUST have certificates (after bootstrap period)
            println!("[ERR][NODE] genesis_cert_missing node={}", node_id);
            return false;
        }
    };
    
    // PRODUCTION: Verify certificate format and cryptographic signature
    if genesis_certificate.len() < 64 || !genesis_certificate.starts_with("genesis_cert_") {
        println!("[ERR][NODE] genesis_cert_invalid node={}", node_id);
        return false;
    }
    
    // Create verification hash
    let mut hasher = Sha3_256::new();
    hasher.update(node_id.as_bytes());
    hasher.update(b"qnet-genesis-verification-v1");
    hasher.update(genesis_certificate.as_bytes());
    let verification_hash = hasher.finalize();
    
    // SECURITY: Certificate must contain valid cryptographic proof
    let expected_hash = format!("{:x}", &verification_hash[..8].iter().fold(0u64, |acc, &b| acc << 8 | b as u64));
    genesis_certificate.contains(&expected_hash)
}

impl Clone for BlockchainNode {
    fn clone(&self) -> Self {
        Self {
            storage: self.storage.clone(),
            state: self.state.clone(),
            mempool: self.mempool.clone(),
            unified_p2p: self.unified_p2p.clone(),
            node_id: self.node_id.clone(),
            node_type: self.node_type,
            region: self.region,
            mev_mempool: self.mev_mempool.clone(),
            rotation_tracker: self.rotation_tracker.clone(),
            p2p_port: self.p2p_port,
            bootstrap_peers: self.bootstrap_peers.clone(),
            perf_config: self.perf_config.clone(),
            security_config: self.security_config.clone(),
            heartbeat_commitment_tracker: self.heartbeat_commitment_tracker.clone(),
            bitmap_commitment_tracker: self.bitmap_commitment_tracker.clone(),
            height: self.height.clone(),
            is_running: self.is_running.clone(),
            node_registration_cache: self.node_registration_cache.clone(),
            wallet_identity: self.wallet_identity.clone(),
            vrf_instance: self.vrf_instance.clone(),
            current_microblocks: self.current_microblocks.clone(),
            last_microblock_time: self.last_microblock_time.clone(),
            microblock_interval: self.microblock_interval,
            is_leader: self.is_leader.clone(),
            
            // DYNAMIC: Block production timing (thread-safe for async tasks)
            last_block_attempt: self.last_block_attempt.clone(),
            
            consensus_nonce_storage: self.consensus_nonce_storage.clone(),
            shard_coordinator: self.shard_coordinator.clone(),
            parallel_validator: self.parallel_validator.clone(),
            archive_manager: self.archive_manager.clone(),
            parallel_executor: self.parallel_executor.clone(),
            adaptive_bft: self.adaptive_bft.clone(),
            pre_execution: self.pre_execution.clone(),
            block_event_tx: self.block_event_tx.clone(),
            // L1 architecture handles (clone-friendly)
            coordinator_handle: self.coordinator_handle.clone(),
            pipeline_ingest: self.pipeline_ingest.clone(),
            sync_handle: self.sync_handle.clone(),
        }
    }
}

// =============================================================================
// UNIT TESTS FOR NODE CRYPTO FUNCTIONS
// =============================================================================
#[cfg(test)]
mod tests {
    /// No light recipients: the two-pool split then routes the whole pool to the operator
    /// side, which is the equal-per-eligible case these reward tests exercise.
    const NO_LIGHTS: &[(String, String)] = &[];

    use super::*;

    // Checkpoint participation gate: a synced node always participates; a syncing node participates
    // ONLY if it holds the full window (so a macro-boundary finality-lag redrive can seal on a
    // briefly-syncing node), else it defers to macroblock sync.
    #[test]
    fn checkpoint_participation_gate() {
        let mb_end = 180u64;
        assert!(checkpoint_participation_allowed(true, 0, mb_end));        // synced → always
        assert!(checkpoint_participation_allowed(true, 50, mb_end));       // synced, behind → still
        assert!(checkpoint_participation_allowed(false, 180, mb_end));     // syncing, has window → yes
        assert!(checkpoint_participation_allowed(false, 250, mb_end));     // syncing, ahead of end → yes
        assert!(!checkpoint_participation_allowed(false, 179, mb_end));    // syncing, missing last block → defer
        assert!(!checkpoint_participation_allowed(false, 0, mb_end));      // syncing, no window → defer
    }

    // P3 test microblock: distinct body per (height,tag) so hash() differs; all other fields inert.
    #[cfg(test)]
    fn p3_micro(height: u64, tag: u8) -> qnet_state::MicroBlock {
        qnet_state::MicroBlock {
            height, timestamp: 0, transactions: vec![], producer: "genesis_node_001".to_string(),
            signature: vec![0u8; 64], merkle_root: [tag; 32], previous_hash: [0u8; 32],
            vrf_output: None, vrf_proof: None, fees_collected: 0,
            state_root: [0u8; 32], timeout_round: 0, carried_baseline: 0, timeout_proof: None,
        }
    }

    /// Persist a chained run of p3 bodies — storage enforces parent linkage, so an unlinked run is
    /// not a reachable state. Returns the stored hashes in height order.
    #[cfg(test)]
    fn p3_seed_chain(storage: &crate::storage::Storage, from: u64, to: u64, tag_of: impl Fn(u64) -> u8) -> Vec<[u8; 32]> {
        let mut out = Vec::new();
        // Continue from whatever is already stored below `from`, so successive calls extend one chain.
        let mut parent = if from == 0 { [0u8; 32] } else {
            storage.load_microblock_auto_format(from - 1).ok().flatten()
                .map(|p| p.hash()).unwrap_or([0u8; 32])
        };
        for h in from..=to {
            let mut mb = p3_micro(h, tag_of(h));
            mb.previous_hash = parent;
            parent = mb.hash();
            out.push(mb.hash());
            storage.save_microblock(h, &bincode::serialize(&mb).expect("ser")).expect("save");
        }
        out
    }

    // P3 SAFETY (content-not-presence finality): window_content_verdict is the comparator every
    // finality-advance path funnels through. A local body whose hash differs from the QC-certified hash
    // MUST be `mismatched` (so finality cannot advance over it — the node-001 h=30780 "finalized its own
    // same-state fork" violation); a genuinely-absent body is `missing` not `mismatched` (a matching
    // window with pruned-old bodies is not wrongly blocked); a too-short certified list is fail-closed.
    #[test]
    fn window_content_verdict_flags_fork_not_pruned() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");

        let certified: Vec<[u8; 32]> = p3_seed_chain(&storage, 1, 4, |h| h as u8);

        // Honest window: stored == certified ⇒ nothing deferred (the happy path is never blocked).
        let (miss, mism) = BlockchainNode::window_content_verdict(&storage, &certified, 1, 4);
        assert!(miss.is_empty() && mism.is_empty(), "honest window must not defer");

        // QC certified a DIFFERENT body at height 3 than the one we locally hold (the 001 fork).
        let mut forked = certified.clone();
        forked[2] = [0xEE; 32];
        let (miss, mism) = BlockchainNode::window_content_verdict(&storage, &forked, 1, 4);
        assert_eq!(mism, vec![3], "fork body flagged mismatched ⇒ finality must not advance");
        assert!(miss.is_empty());

        // Absent (pruned-old) bodies at 5,6: the None arm fires ⇒ `missing`, never `mismatched`.
        let (miss, mism) = BlockchainNode::window_content_verdict(&storage, &certified, 1, 6);
        assert_eq!(miss, vec![5, 6]);
        assert!(mism.is_empty());

        // Fail-closed: a certified list shorter than the range counts uncovered heights as mismatched.
        let (miss, mism) = BlockchainNode::window_content_verdict(&storage, &certified[..2], 1, 4);
        assert!(miss.is_empty());
        assert_eq!(mism, vec![3, 4], "heights beyond the certified list are fail-closed");
    }

    // P3 SAFETY (restart-during-fork): a node that durably APPLIED a losing fork must NOT boot-finalize
    // it. boot_content_finality_ceiling walks DOWN from chain_height's window; a content-mismatched
    // (fork) window steps down, the first window whose local bodies match its QC-certified hashes is the
    // ceiling. Canonical window 1 + fork window 2 ⇒ ceiling clamps to 90; both-canonical ⇒ 180 (the
    // clamp is content-driven, not a cap).
    #[tokio::test]
    async fn boot_content_finality_ceiling_clamps_below_a_fork_window() {
        use std::sync::atomic::Ordering;
        // Snapshot anchor 0 (default) so the walk is not short-circuited by an anchor.
        crate::node::SNAPSHOT_ANCHOR_MB.store(0, Ordering::SeqCst);

        // Build a storage with window 1 canonical and window 2 either canonical or a fork.
        async fn build(window2_forked: bool) -> (tempfile::TempDir, crate::storage::Storage) {
            let dir = tempfile::TempDir::new().expect("tempdir");
            let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
            let w1 = p3_seed_chain(&storage, 1, 90, |h| (h % 250 + 1) as u8);
            let stored_w2 = p3_seed_chain(&storage, 91, 180, |h| (h % 250 + 1) as u8);
            // Certify the stored bodies when canonical; certify obviously-wrong hashes when forked.
            let w2: Vec<[u8; 32]> = if window2_forked {
                stored_w2.iter().map(|_| [0xFFu8; 32]).collect()
            } else { stored_w2 };
            let cd = qnet_state::ConsensusData::default();
            storage.save_macroblock(1, &qnet_state::MacroBlock::new(1, 0, [0u8; 32], w1, [0u8; 32], cd.clone())).await.expect("mb1");
            storage.save_macroblock(2, &qnet_state::MacroBlock::new(2, 0, [0u8; 32], w2, [0u8; 32], cd)).await.expect("mb2");
            (dir, storage)
        }

        // Fork in window 2: a node that applied through height 180 must clamp its boot finality to 90.
        let (_d1, s_fork) = build(true).await;
        crate::node::CONTENT_VERIFIED_FRONTIER.store(0, Ordering::Relaxed);
        assert_eq!(BlockchainNode::boot_content_finality_ceiling(&s_fork, 180), 90,
                   "fork window 2 must clamp boot finality to the window-1 top");

        // Both windows canonical: the ceiling reaches 180 — proves the clamp is content-driven.
        let (_d2, s_ok) = build(false).await;
        assert_eq!(BlockchainNode::boot_content_finality_ceiling(&s_ok, 180), 180,
                   "two canonical windows ⇒ full ceiling");
    }

    // ── BAN-SET ANCHOR WALK-BACK (storage-backed) ──────────────────────────────────────────────
    //
    // A single macroblock that never sealed used to make EVERY later window underivable, which is
    // terminal: the window is also the N-2 election anchor two epochs on. Walking back to an older
    // anchor and scanning further is exact — bans are write-once monotone over committed bodies — so
    // the only thing that may change is the work, never the answer. What must NOT change is fail-stop:
    // a body missing anywhere in the widened span still abstains.

    /// Storage holding microblocks 1..=270 plus whichever macroblock anchors `mbs` names.
    async fn ban_env(mbs: &[u64], banned: &[&str], drop_body: Option<u64>)
        -> (tempfile::TempDir, crate::storage::Storage) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        for h in 1..=270u64 {
            if Some(h) == drop_body { continue; }
            p3_seed_chain(&storage, h, h, |x| (x % 250 + 1) as u8);
        }
        let list: Vec<String> = banned.iter().map(|s| s.to_string()).collect();
        for &i in mbs {
            let mut cd = qnet_state::ConsensusData::default();
            cd.banned_validators = Some(bincode::serialize(&list).expect("ser bans"));
            let mb = qnet_state::MacroBlock::new(i, 0, [0u8; 32], vec![], [0u8; 32], cd);
            storage.save_macroblock(i, &mb).await.expect("save mb");
        }
        (dir, storage)
    }

    #[tokio::test]
    async fn ban_set_walks_back_to_an_older_anchor_without_weakening_fail_stop() {
        // Baseline: the immediate anchor is present.
        let (_d, s) = ban_env(&[1, 2], &["offender"], None).await;
        let direct = BlockchainNode::compute_cumulative_ban_set(&s, 3).await;
        assert!(direct.as_ref().is_some_and(|b| b.contains("offender")),
                "with anchor mb2 present the set must carry the anchored ban");

        // Same question, anchor mb2 missing: the walk reaches mb1 and scans one window further.
        let (_d2, s2) = ban_env(&[1], &["offender"], None).await;
        let walked = BlockchainNode::compute_cumulative_ban_set(&s2, 3).await;
        assert_eq!(walked, direct,
                   "a walked-back anchor must yield the IDENTICAL set, not merely a usable one");

        // Fail-stop is untouched: a body missing inside the widened span still abstains.
        let (_d3, s3) = ban_env(&[1], &["offender"], Some(100)).await;
        assert_eq!(BlockchainNode::compute_cumulative_ban_set(&s3, 3).await, None,
                   "a pruned/absent body in the scanned span must still abstain");

        // No anchor at all within the horizon: abstain, exactly as before.
        let (_d4, s4) = ban_env(&[], &[], None).await;
        assert_eq!(BlockchainNode::compute_cumulative_ban_set(&s4, 3).await, None,
                   "no reachable anchor ⇒ abstain until sync");
    }

    // ── RECOVERY RELAXATION (storage-backed) ───────────────────────────────────────────────────
    //
    // resolve_recovery_pin is THE authority: it decides the committee AND the threshold for a relaxed
    // macroblock, reading nothing but the anchor macroblock — final, at or below the last seal, and
    // retained forever (only microblock BODIES prune). These tests write NO microblock bodies at all,
    // which is precisely the post-prune condition, so a pass here is also the prune-survival proof.

    /// Build + store anchor macroblock `a` and return `(its pin digest, its checkpoint)`. The pin
    /// digest is `checkpoint_content_digest`, which is what a recovery anchor names.
    async fn rc_anchor(
        storage: &crate::storage::Storage, a: u64, cp_index: u64, committee_len: usize,
        chained: bool, head: u64,
    ) -> ([u8; 32], qnet_consensus::checkpoint_bft::Checkpoint) {
        use qnet_consensus::checkpoint_bft::{Checkpoint, QuorumCertificate, sig_merkle_root};
        let committee: Vec<String> = (0..committee_len).map(|i| format!("cs_{:04}", i)).collect();
        let cp = Checkpoint {
            index: cp_index, parent_qc: None, window_head_height: head,
            window_mb_hashes: vec![], state_root: [1u8; 32], beacon: [2u8; 32],
            epoch_commitment: [3u8; 32], reward_root: [0u8; 32], registry_root: [0u8; 32],
            logs_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32],
            total_supply: 0, timestamp: 0, proposer: committee[0].clone(), proposer_sig: vec![],
            // `chained` makes the anchor itself relaxed — the one thing that must never be an anchor.
            recovery_anchor: if chained { Some((a - 1, [9u8; 32])) } else { None },
        };
        let sigs: Vec<Vec<u8>> = committee.iter().map(|s| s.as_bytes().to_vec()).collect();
        let qc = QuorumCertificate {
            checkpoint_hash: cp.hash(), index: cp.index,
            sig_merkle_root: sig_merkle_root(&sigs), signers: committee.clone(), sigs,
        };
        let mut cd = qnet_state::ConsensusData::default();
        cd.checkpoint_qc = Some(bincode::serialize(&(cp.clone(), qc)).unwrap());
        cd.consensus_committee = Some(committee);
        let mb = qnet_state::MacroBlock::new(a, 0, [0u8; 32], vec![], [1u8; 32], cd);
        storage.save_macroblock(a, &mb).await.expect("save anchor");
        (qnet_consensus::checkpoint_bft::checkpoint_content_digest(&cp), cp)
    }

    /// A relaxed checkpoint pinned to `(a, ah)` at step `k`, correct in every field by default.
    fn rc_pinned_cp(
        cp_a: &qnet_consensus::checkpoint_bft::Checkpoint, a: u64, ah: [u8; 32], k: u64,
        parent_hash: [u8; 32],
    ) -> qnet_consensus::checkpoint_bft::Checkpoint {
        use qnet_consensus::checkpoint_bft::{Checkpoint, QcRef, recovery_window_head};
        // Index tracks the anchor's here only so the parent link is contiguous; the pin does NOT
        // constrain it, and `pinned_cp_at_index` below exercises exactly that.
        let index = cp_a.index + k;
        let head = recovery_window_head(cp_a.window_head_height, k);
        Checkpoint {
            index, parent_qc: Some(QcRef { index: index - 1, checkpoint_hash: parent_hash }),
            window_head_height: head, window_mb_hashes: vec![], state_root: [4u8; 32],
            beacon: [5u8; 32], epoch_commitment: [6u8; 32], reward_root: [0u8; 32],
            registry_root: [0u8; 32], logs_root: [0u8; 32], dilithium_pk_root: [0u8; 32],
            reward_epoch_root: [0u8; 32], total_supply: 0, timestamp: 0,
            proposer: "cs_0000".into(), proposer_sig: vec![], recovery_anchor: Some((a, ah)),
        }
    }

    #[tokio::test]
    async fn resolve_recovery_pin_accepts_defers_and_rejects() {
        use qnet_consensus::checkpoint_bft::{QcRef, RC_SPAN_INDICES, quorum_size, relaxed_quorum};
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        let (a, cp_index, n) = (4u64, 17u64, 12usize);
        let (ah, cp_a) = rc_anchor(&storage, a, cp_index, n, false, a * 90).await;
        let ok = rc_pinned_cp(&cp_a, a, ah, 1, cp_a.hash());

        // ACCEPT: the pin lowers the THRESHOLD over the committee the caller derived. It returns no
        // committee at all — a pin that chose its own signing set is what let two quorums miss.
        let q = BlockchainNode::resolve_recovery_pin(&storage, a + 1, &ok, a, ah, n)
            .expect("well-formed pin must resolve");
        assert_eq!(q, relaxed_quorum(n));
        assert!(q < quorum_size(n), "the relaxation must actually lower the bar");
        // THE intersection property the relaxed threshold rests on, over ONE committee.
        assert!(q + quorum_size(n) > n, "relaxed + strict must intersect");
        assert!(2 * q > n, "two relaxed quorums must intersect");

        // DEFER, never reject: a node that has not pulled MB_A yet must fetch and retry. Rejecting
        // here would brick every cold join across the span, permanently.
        let e = BlockchainNode::resolve_recovery_pin(&storage, 99, &ok, 77, ah, n).unwrap_err();
        assert!(e.contains("v2_rc_defer_anchor") && e.contains("need_anchor=77"),
                "absent anchor must DEFER with a backfillable key, got {}", e);

        // Anchor digest mismatch: the pin names an anchor CONTENT this node does not hold.
        let e = BlockchainNode::resolve_recovery_pin(&storage, a + 1, &ok, a, [0xAB; 32], n).unwrap_err();
        assert!(e.contains("v2_rc_anchor_mismatch"), "got {}", e);

        // Off-pin position: the window head is off the CHECKPOINT_INTERVAL grid.
        let mut bad = ok.clone(); bad.window_head_height += 1;
        assert!(BlockchainNode::resolve_recovery_pin(&storage, a + 1, &bad, a, ah, n)
            .unwrap_err().contains("v2_rc_unpinned"));

        // Past the span: k = RC_SPAN_INDICES + 1 has no legal window.
        let over = rc_pinned_cp(&cp_a, a, ah, RC_SPAN_INDICES + 1, cp_a.hash());
        assert!(BlockchainNode::resolve_recovery_pin(&storage, a + 3, &over, a, ah, n)
            .unwrap_err().contains("v2_rc_unpinned"));

        // k = 0 (the anchor's own window) is not a span position either.
        let mut zero = ok.clone(); zero.index = cp_a.index; zero.window_head_height = cp_a.window_head_height;
        assert!(BlockchainNode::resolve_recovery_pin(&storage, a, &zero, a, ah, n)
            .unwrap_err().contains("v2_rc_unpinned"));

        // The parent link is MONOTONE, not contiguous, and carries no hash clause. The f+1 view jump
        // stays live during a span and leaves a gap between high_qc.index and the round being driven;
        // a contiguity rule made every proposal after such a jump unverifiable, which killed the span
        // at exactly the point it was meant to hand the chain back. And the anchor's QC hash folds the
        // anchor's index and proposer, which a legal re-proposal changes — so it is not checkable.
        let free_parent = rc_pinned_cp(&cp_a, a, ah, 1, [0xCD; 32]);
        assert!(BlockchainNode::resolve_recovery_pin(&storage, a + 1, &free_parent, a, ah, n).is_ok(),
                "no hash clause: an arbitrary parent hash must not decide validity here");
        let mut gap = ok.clone();
        gap.parent_qc = Some(QcRef { index: ok.index - 3, checkpoint_hash: cp_a.hash() });
        assert!(BlockchainNode::resolve_recovery_pin(&storage, a + 1, &gap, a, ah, n).is_ok(),
                "an f+1 view jump leaves a gap and must stay verifiable");

        // Monotonicity is still required, and a parent-less pinned checkpoint is refused.
        let mut backwards = ok.clone();
        backwards.parent_qc = Some(QcRef { index: ok.index, checkpoint_hash: cp_a.hash() });
        assert!(BlockchainNode::resolve_recovery_pin(&storage, a + 1, &backwards, a, ah, n)
            .unwrap_err().contains("v2_rc_parent"));
        let mut orphan = ok.clone(); orphan.parent_qc = None;
        assert!(BlockchainNode::resolve_recovery_pin(&storage, a + 1, &orphan, a, ah, n)
            .unwrap_err().contains("v2_rc_parent"));

        // Anchor 0 is never a valid pin.
        assert!(BlockchainNode::resolve_recovery_pin(&storage, 1, &ok, 0, ah, n)
            .unwrap_err().contains("v2_rc_anchor_zero"));

        // Later steps resolve identically — the span must be able to reach its last window.
        let k2 = rc_pinned_cp(&cp_a, a, ah, 2, [0xEE; 32]);
        assert!(BlockchainNode::resolve_recovery_pin(&storage, a + 1, &k2, a, ah, n).is_ok());
        let k6 = rc_pinned_cp(&cp_a, a, ah, RC_SPAN_INDICES, [0xEE; 32]);
        assert!(BlockchainNode::resolve_recovery_pin(&storage, a + 2, &k6, a, ah, n).is_ok());
    }

    // The pin's identity is the anchor CHECKPOINT's content digest, never MacroBlock::hash() and
    // never anything outside that digest. The block hash omits consensus_data, so two nodes can hold
    // hash-equal macroblocks whose stored CERTIFICATE differs — a conformant re-proposal at another
    // round, or a pinned and an unpinned certificate for one window. The digest is invariant across
    // all of them, which is the only reason a validity verdict may rest on it.
    #[tokio::test]
    async fn recovery_pin_identity_is_invariant_across_anchor_certificate_variants() {
        use qnet_consensus::checkpoint_bft::checkpoint_content_digest;
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        let (a, n) = (4u64, 12usize);
        let (ah, cp_a) = rc_anchor(&storage, a, 17, n, false, a * 90).await;

        // A re-proposal of the anchor window at another index/proposer: different hash(), IDENTICAL
        // content digest, so the pin still resolves against it.
        let mut reproposal = cp_a.clone();
        reproposal.index = cp_a.index + 4;
        reproposal.proposer = "cs_0003".into();
        assert_ne!(reproposal.hash(), cp_a.hash());
        assert_eq!(checkpoint_content_digest(&reproposal), ah);

        // A PINNED certificate for the same window resolves identically too. It must: which of the
        // two a node stored is per-node data, and if the digest moved with it, half the network
        // would reject a span the other half certified — permanently.
        let mut relaxed_variant = cp_a.clone();
        relaxed_variant.recovery_anchor = Some((a - 1, [7u8; 32]));
        assert_ne!(relaxed_variant.hash(), cp_a.hash());
        assert_eq!(checkpoint_content_digest(&relaxed_variant), ah);
        let (ah_c, cp_c) = rc_anchor(&storage, 6, 21, n, true, 6 * 90).await;
        let chained = rc_pinned_cp(&cp_c, 6, ah_c, 1, cp_c.hash());
        assert!(BlockchainNode::resolve_recovery_pin(&storage, 7, &chained, 6, ah_c, n).is_ok(),
                "the resolver reads nothing that varies between certificates for one window");
        // The no-chained-span bound lives on the ARM instead, where a divergent read costs liveness:
        // a chained pin needs relaxed_quorum signatures, and no honest node signs a pin it did not arm.
        assert!(cp_c.recovery_anchor.is_some());

        // Anything the digest DOES cover still binds.
        let mut moved_head = cp_a.clone();
        moved_head.window_head_height += 30;
        assert_ne!(checkpoint_content_digest(&moved_head), ah);
    }

    // The vote commitment must outlive the process, or a restart during the very halt the span exists
    // for makes an honest replica emit the pair its peers convict. It is written before the vote is
    // signed, reloaded on the next boot, and pruned only below the retention window — a head under
    // the committed frontier can never be proposed again.
    #[test]
    fn vote_commitments_round_trip_and_prune_below_the_retention_window() {
        use qnet_consensus::checkpoint_bft::CONSENSUS_STATE_RETAIN;
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        assert!(storage.load_checkpoint_votes().expect("load").is_empty());

        storage.record_checkpoint_vote(7, 210, &[1u8; 32], false, 6, &[2u8; 32]).expect("record");
        storage.record_checkpoint_vote(8, 240, &[3u8; 32], true, 7, &[4u8; 32]).expect("record");
        let mut got = storage.load_checkpoint_votes().expect("load");
        got.sort_by_key(|r| r.0);
        assert_eq!(got, vec![(7, 210, [1u8; 32], false, 6, [2u8; 32]),
                             (8, 240, [3u8; 32], true, 7, [4u8; 32])]);

        // A later vote prunes what is buried; everything inside the window survives.
        let far = 8 + CONSENSUS_STATE_RETAIN + 1;
        storage.record_checkpoint_vote(far, far * 30, &[5u8; 32], true, far - 1, &[6u8; 32]).expect("record");
        let kept: Vec<u64> = storage.load_checkpoint_votes().expect("load").iter().map(|r| r.0).collect();
        assert_eq!(kept, vec![far], "records below index-RETAIN are evicted");
    }

    // Two bounds that keep the relaxation from becoming a genesis-scale weapon.
    #[tokio::test]
    async fn resolve_recovery_pin_refuses_small_committees_and_offboundary_anchors() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");

        // Below RELAXED_MIN_COMMITTEE the relaxation does not exist: at n=5 it would buy one node of
        // liveness while making a single Byzantine member sufficient to break safety. The floor is on
        // the CERTIFYING committee, which is the one the caller derived.
        let (ah5, cp5) = rc_anchor(&storage, 6, 21, 12, false, 6 * 90).await;
        let cp = rc_pinned_cp(&cp5, 6, ah5, 1, cp5.hash());
        assert!(BlockchainNode::resolve_recovery_pin(&storage, 7, &cp, 6, ah5, 5)
            .unwrap_err().contains("v2_rc_floor"));

        // The anchor must sit on a macroblock boundary (a*90); anything else is not a sealed anchor.
        let (ah_off, cp_off) = rc_anchor(&storage, 8, 25, 12, false, 8 * 90 + 1).await;
        let cp = rc_pinned_cp(&cp_off, 8, ah_off, 1, cp_off.hash());
        assert!(BlockchainNode::resolve_recovery_pin(&storage, 9, &cp, 8, ah_off, 12)
            .unwrap_err().contains("v2_rc_anchor_offboundary"));
    }

    // GALC v2: consensus_committee is now the signature-checking set for a relaxed checkpoint, and
    // banned_validators is already trusted verbatim by load_macroblock_ban_set. MacroBlock::hash()
    // omits consensus_data entirely, so at the pin branches BOTH were unauthenticated — a hash-equal
    // impostor could swap either. The digest must now move when they do.
    #[test]
    fn galc_committee_digest_binds_committee_and_bans() {
        let mk = |cmt: Option<Vec<String>>, banned: Option<Vec<u8>>| {
            let mut cd = qnet_state::ConsensusData::default();
            cd.eligible_producers = Some(vec![1, 2, 3]);
            cd.randomness_beacon = Some([7u8; 32]);
            cd.consensus_committee = cmt;
            cd.banned_validators = banned;
            qnet_state::MacroBlock::new(5, 0, [0u8; 32], vec![], [1u8; 32], cd)
        };
        let base = mk(Some(vec!["a".into(), "b".into()]), Some(vec![9]));
        let swap_cmt = mk(Some(vec!["a".into(), "c".into()]), Some(vec![9]));
        let swap_ban = mk(Some(vec!["a".into(), "b".into()]), Some(vec![8]));
        let none_cmt = mk(None, Some(vec![9]));
        let empty_cmt = mk(Some(vec![]), Some(vec![9]));

        // The bodies are hash-EQUAL — that is exactly why the digest has to carry them.
        assert_eq!(base.hash(), swap_cmt.hash());
        assert_eq!(base.hash(), swap_ban.hash());

        let d = |m: &qnet_state::MacroBlock| crate::galc::committee_fields_digest(m);
        assert_ne!(d(&base), d(&swap_cmt), "committee swap must move the digest");
        assert_ne!(d(&base), d(&swap_ban), "ban-set swap must move the digest");
        // Present/absent is tagged, so None and empty-Vec can never collide.
        assert_ne!(d(&none_cmt), d(&empty_cmt));
        assert_eq!(d(&base), d(&base));
    }

    // The invariant the whole design rests on: no signer set enters ANY hash or cross-node comparison,
    // so two sealers holding byte-different valid QCs still agree on every compared value.
    #[tokio::test]
    async fn signer_set_enters_no_hash() {
        use qnet_consensus::checkpoint_bft::{QuorumCertificate, sig_merkle_root};
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        let (_ah, cp_a) = rc_anchor(&storage, 4, 17, 12, false, 4 * 90).await;
        let mb_hash = storage.get_macroblock_by_height(4).ok().flatten()
            .and_then(BlockchainNode::macroblock_plaintext)
            .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok())
            .map(|m| m.hash()).expect("stored anchor");

        // Re-seal the SAME checkpoint under a different (smaller, differently-ordered) signer set.
        let alt: Vec<String> = (0..7).map(|i| format!("cs_{:04}", 11 - i)).collect();
        let sigs: Vec<Vec<u8>> = alt.iter().map(|s| s.as_bytes().to_vec()).collect();
        let qc2 = QuorumCertificate {
            checkpoint_hash: cp_a.hash(), index: cp_a.index,
            sig_merkle_root: sig_merkle_root(&sigs), signers: alt, sigs,
        };
        let mut cd = qnet_state::ConsensusData::default();
        cd.checkpoint_qc = Some(bincode::serialize(&(cp_a.clone(), qc2)).unwrap());
        cd.consensus_committee = Some((0..12).map(|i| format!("cs_{:04}", i)).collect());
        let mb2 = qnet_state::MacroBlock::new(4, 0, [0u8; 32], vec![], [1u8; 32], cd);

        assert_eq!(mb2.hash(), mb_hash, "MacroBlock::hash must not see the signer set");
        // committee_fields_digest folds the committee, NOT who signed — otherwise two honest sealers
        // would produce different GALC digests and the pin branches would reject each other.
        let orig = storage.get_macroblock_by_height(4).ok().flatten()
            .and_then(BlockchainNode::macroblock_plaintext)
            .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok()).expect("stored");
        assert_eq!(crate::galc::committee_fields_digest(&orig), crate::galc::committee_fields_digest(&mb2));
    }

    /// Store a macroblock carrying a usable committee snapshot at `idx`.
    async fn seed_committee_mb(storage: &crate::storage::Storage, idx: u64, n: usize) {
        let elig: Vec<qnet_state::EligibleProducer> = (0..n)
            .map(|i| qnet_state::EligibleProducer { node_id: format!("node_{:04}", i), reputation: 7000 })
            .collect();
        let mut cd = qnet_state::ConsensusData::default();
        cd.eligible_producers = Some(bincode::serialize(&elig).unwrap());
        cd.randomness_beacon = Some([idx as u8; 32]);
        let mb = qnet_state::MacroBlock::new(idx, 0, [0u8; 32], vec![], [1u8; 32], cd);
        storage.save_macroblock(idx, &mb).await.expect("save");
    }

    // reward_root is a hashed checkpoint field: if the streamed build and the in-memory build ever
    // disagree by one byte, the producer and every validator recomputing land on different roots and
    // the window can never certify. Pin equality across shard boundaries and duplicate wallets.
    #[tokio::test]
    async fn streamed_reward_root_matches_in_memory() {
        let dir = tempfile::TempDir::new().unwrap();
        let st = crate::storage::Storage::new(dir.path().to_str().unwrap()).unwrap();
        // Sizes around REWARD_SHARD_SIZE=4096: single partial shard, exact multiple, and a spill.
        for &(ns, nl) in &[(1usize, 0usize), (3, 7), (0, 4096), (5, 4091), (11, 9000)] {
            let supers: Vec<(String, String)> = (0..ns)
                .map(|i| (format!("super_{:06}", i), format!("wal_s{:06}", i))).collect();
            // Every 3rd light reuses an earlier wallet, so the per-wallet summation is exercised.
            let lights: Vec<(String, String)> = (0..nl)
                .map(|i| (format!("light_{:06}", i), format!("wal_l{:06}", if i % 3 == 0 { i / 3 } else { i })))
                .collect();
            let epoch = 40 + ns as u64;
            let total = 251_432_340_000_000u64;

            let (want_vec, want_root) =
                BlockchainNode::distribute_split_rewards(&supers, &lights, total, epoch);
            let mut got_vec: Vec<(String, u64)> = Vec::new();
            let light_iter = |f: &mut dyn FnMut(&str, &str)| {
                for (n, w) in &lights { f(n, w); }
                Ok(())
            };
            let (count, paid, got_root) = BlockchainNode::build_epoch_rewards_streamed(
                &st, &supers, light_iter, total, epoch,
                |_i, shard, _r| got_vec.extend_from_slice(shard),
            ).expect("streamed build");

            assert_eq!(got_root, want_root, "root differs at ns={} nl={}", ns, nl);
            assert_eq!(got_vec, want_vec, "leaf set differs at ns={} nl={}", ns, nl);
            assert_eq!(count, want_vec.len(), "count differs at ns={} nl={}", ns, nl);
            assert_eq!(paid, want_vec.iter().map(|(_, a)| *a).sum::<u64>(), "total differs");
            if !want_vec.is_empty() {
                assert_eq!(paid, total, "emission must be conserved at ns={} nl={}", ns, nl);
            }
        }
    }

    /// The PERSISTED shard meta must recombine to the COMMITTED root. My first streamed persist arm
    /// recomputed the shard root instead of using the builder's, and the two derivations disagreed for a
    /// single sub-4096 shard (natural vs padded height) — every claim then read as Divergent on the
    /// producing node. Sizes below span the divergence window that bug had (N <= 2048) and above it.
    #[tokio::test]
    async fn persisted_shard_meta_recombines_to_committed_root() {
        let dir = tempfile::TempDir::new().unwrap();
        let st = crate::storage::Storage::new(dir.path().to_str().unwrap()).unwrap();
        for &n in &[1usize, 2, 6, 100, 2048, 2049, 4096, 4097, 9000] {
            let epoch = 160 + n as u64;
            let supers: Vec<(String, String)> = (0..n)
                .map(|i| (format!("super_{:07}", i), format!("wal_{:07}", i))).collect();
            let mut roots: Vec<[u8; 32]> = Vec::new();
            let (_c, _p, committed) = BlockchainNode::build_epoch_rewards_streamed(
                &st, &supers, |_f: &mut dyn FnMut(&str, &str)| Ok(()),
                251_432_340_000_000u64, epoch,
                |_i, _shard, r| roots.push(r),
            ).expect("build");
            assert!(!roots.is_empty(), "n={} produced no shard", n);
            let recombined = if roots.len() == 1 {
                hex::encode(roots[0])
            } else {
                hex::encode(qnet_core::crypto::merkle::merkle_continue_root(&roots))
            };
            assert_eq!(recombined, committed,
                       "persisted shard meta must recombine to the committed root at n={}", n);
        }
    }

    // The scratch CF must never survive a build: leftovers would double-count on the next epoch.
    #[tokio::test]
    async fn reward_agg_scratch_is_cleared_after_build() {
        let dir = tempfile::TempDir::new().unwrap();
        let st = crate::storage::Storage::new(dir.path().to_str().unwrap()).unwrap();
        let supers: Vec<(String, String)> = (0..4)
            .map(|i| (format!("super_{:06}", i), format!("wal_s{:06}", i))).collect();
        BlockchainNode::build_epoch_rewards_streamed(
            &st, &supers, |_f: &mut dyn FnMut(&str, &str)| Ok(()), 1_000, 7, |_, _, _| {})
            .expect("build");
        // Every build allocates a private range and clears it on exit, so no range holds rows.
        let mut seen = 0usize;
        for b in 0..8u64 { st.reward_agg_for_each_wallet(b, |_, _| seen += 1).expect("scan"); }
        assert_eq!(seen, 0, "scratch rows survived the build");
        // Two interleaved builds must not see each other's rows (the race the build id closes).
        let a_id = st.reward_agg_new_build();
        let b_id = st.reward_agg_new_build();
        assert_ne!(a_id, b_id, "each build gets its own range");
        st.reward_agg_put_batch(a_id, &[("w1".into(), "n1".into(), 5u64)]).unwrap();
        let mut only_a = 0usize;
        st.reward_agg_for_each_wallet(b_id, |_, _| only_a += 1).unwrap();
        assert_eq!(only_a, 0, "build ranges must be isolated");
    }

    // ── A1 frozen-roster ──────────────────────────────────────────────────────────────────────────
    /// Standalone anchor macroblock with `n` supers, tagged so two anchors differ in BOTH the beacon
    /// (frozen_beacon input) and the state_root (a hash_macroblock_entropy input) — the frozen
    /// derivations' only inputs.
    fn mk_frozen_anchor(n: usize, tag: u8) -> qnet_state::MacroBlock {
        let elig: Vec<qnet_state::EligibleProducer> = (0..n)
            .map(|i| qnet_state::EligibleProducer { node_id: format!("super_{:04}", i), reputation: 7000 })
            .collect();
        let mut cd = qnet_state::ConsensusData::default();
        cd.eligible_producers = Some(bincode::serialize(&elig).unwrap());
        cd.randomness_beacon = Some([tag; 32]);
        qnet_state::MacroBlock::new(10, 0, [0u8; 32], vec![[7u8; 32]], [tag; 32], cd)
    }

    /// R20.1 purity: every frozen derivation is a pure function of (anchor bytes, window). Roster is
    /// CONSTANT across the horizon; entropy/beacon are deterministic per window, distinct across
    /// windows, and bound to the anchor bytes — so two nodes on the same M_A agree byte-for-byte
    /// regardless of any unfinalized tail (the tail is structurally unreadable here).
    #[test]
    fn frozen_derivations_are_pure_and_window_scoped() {
        let a = mk_frozen_anchor(50, 0x11);
        let r = BlockchainNode::frozen_roster(&a);
        assert_eq!(r, BlockchainNode::frozen_roster(&a), "roster is a pure function of the anchor");
        assert_eq!(r.len(), 50);
        assert!(r.windows(2).all(|w| w[0].node_id <= w[1].node_id), "roster canonically sorted");
        for w in [3u64, 4, 32] {
            assert_eq!(BlockchainNode::frozen_beacon(&a, w), BlockchainNode::frozen_beacon(&a, w));
        }
        assert_ne!(BlockchainNode::frozen_beacon(&a, 3), BlockchainNode::frozen_beacon(&a, 4), "beacon varies per window");
        let b = mk_frozen_anchor(50, 0x22);
        assert_ne!(BlockchainNode::frozen_beacon(&a, 3), BlockchainNode::frozen_beacon(&b, 3), "beacon binds anchor bytes");
    }

    /// R20.8 identity arm: at COMMITTEE_THRESHOLD with a <=1000 roster the committee IS the roster for
    /// every window (per-window resampling absorbs zero churn today), and it is deterministic.
    #[test]
    fn frozen_committee_is_identity_at_threshold() {
        let a = mk_frozen_anchor(50, 0x11);
        let mut roster: Vec<String> = BlockchainNode::frozen_roster(&a).into_iter().map(|p| p.node_id).collect();
        roster.sort();
        for w in [3u64, 10, 32] {
            let c = BlockchainNode::frozen_committee(&a, w);
            assert_eq!(c, BlockchainNode::frozen_committee(&a, w), "deterministic per window");
            let mut cs = c.clone(); cs.sort();
            assert_eq!(cs, roster, "committee == roster at threshold, window {}", w);
        }
    }

    /// M_A selection descends the contiguous sealed prefix to the newest USABLE macroblock (R2.1).
    #[tokio::test]
    async fn frozen_anchor_selects_newest_usable() {
        let dir = tempfile::TempDir::new().unwrap();
        let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).unwrap();
        seed_committee_mb(&s, 8, 50).await;
        seed_committee_mb(&s, 10, 50).await;
        assert_eq!(BlockchainNode::frozen_anchor(&s, 10).expect("anchor").0, 10, "newest usable at L");
        assert_eq!(BlockchainNode::frozen_anchor(&s, 9).expect("descends").0, 8, "9 absent ⇒ descend to 8");
        assert!(BlockchainNode::frozen_anchor(&s, 7).is_none(), "below the seeded floor ⇒ abstain");
    }

    /// R20.1 two-instance purity: two nodes sharing anchor M_A but with DIFFERENT unfinalized tails
    /// derive byte-identical roster/beacon/entropy/committee for every horizon window — the tail is
    /// structurally unreadable, so no partition can elect different producers off the same anchor.
    #[tokio::test]
    async fn frozen_derivations_agree_across_divergent_tails() {
        let (da, db) = (tempfile::TempDir::new().unwrap(), tempfile::TempDir::new().unwrap());
        let sa = crate::storage::Storage::new(da.path().to_str().unwrap()).unwrap();
        let sb = crate::storage::Storage::new(db.path().to_str().unwrap()).unwrap();
        for i in 1..=10u64 { seed_committee_mb(&sa, i, 40).await; seed_committee_mb(&sb, i, 40).await; }
        seed_committee_mb(&sa, 99, 7).await; // A's divergent tail (above the L=10 seal); B has none.
        let (ia, ma) = BlockchainNode::frozen_anchor(&sa, 10).unwrap();
        let (ib, mb) = BlockchainNode::frozen_anchor(&sb, 10).unwrap();
        assert_eq!(ia, ib, "same anchor index off the same seal");
        for w in 11..=42u64 {
            assert_eq!(BlockchainNode::frozen_roster(&ma), BlockchainNode::frozen_roster(&mb));
            assert_eq!(BlockchainNode::frozen_beacon(&ma, w), BlockchainNode::frozen_beacon(&mb, w));
            assert_eq!(BlockchainNode::frozen_committee(&ma, w), BlockchainNode::frozen_committee(&mb, w));
        }
    }

    /// The three-way disposition (R1) on contiguously-sealed state with no higher QC frontier (L==B).
    #[tokio::test]
    async fn roster_mode_three_way() {
        let dir = tempfile::TempDir::new().unwrap();
        let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).unwrap();
        for i in 1..=10u64 { seed_committee_mb(&s, i, 5).await; }
        assert_eq!(s.last_sealed_mb_index(), 10, "contiguous seal ⇒ L=10");
        assert_eq!(BlockchainNode::roster_mode(&s, 12), RosterMode::Sealed, "w-2=10 <= L");
        assert_eq!(BlockchainNode::roster_mode(&s, 13), RosterMode::Frozen, "w-2=11 > L, L==B");
    }

    /// Election entropy must be a pure function of macroblock N-2. Height, round and candidate set
    /// were identical on two honest nodes at h=272 — `round=9 timeout=1` with 5 candidates on both —
    /// yet one elected index 0 and the other index 2, because the seed was taken from different
    /// objects: one node's roster_mode said Sealed (seed = N-2) and the other's said Frozen
    /// (seed = frozen_anchor(L)). L is last_sealed_mb_index, node-local runtime state, so a few
    /// seconds of ingest skew was enough for both to elect THEMSELVES and produce. Anything
    /// node-local in this derivation is a fork with no adversary present.
    #[test]
    fn election_entropy_never_reads_node_local_seal_state() {
        let src = include_str!("leader.rs");
        let i = src.find("let vrf_entropy = {").expect("entropy derivation");
        // Brace-matched to the derivation block: the surrounding selection may legitimately read
        // other state, so a fixed-size window would either miss the end or overrun into it.
        let (mut depth, mut end) = (0i32, i);
        for (k, ch) in src[i..].char_indices() {
            if ch == '{' { depth += 1; }
            else if ch == '}' { depth -= 1; if depth == 0 { end = i + k; break; } }
        }
        // Comments in this block explain WHY the local sources are excluded, so scan code only.
        let body: String = src[i..end]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("
");
        let body = body.as_str();
        for local in ["roster_mode", "frozen_anchor", "frozen_entropy", "last_sealed_mb_index"] {
            assert!(!body.contains(local),
                    "election entropy consults node-local seal state ({local}) — two honest nodes                      with different ingest timing would seed differently and both self-elect");
        }
        assert!(body.contains("resolve_producer_source_macroblock"),
                "entropy must come from the N-2 macroblock");
    }

    /// FAILOVER_COMMITTEE_CACHE memoizes the failover committee on (window, last_sealed_mb_index) on
    /// the stated premise that the seal frontier "moves exactly when the answer can", and the memo is
    /// read BEFORE roster_mode. So roster_mode's answer must depend on L and on nothing else. Making
    /// it also key on the PRESENCE of macroblock w-2 looks like a repair — a window only needs w-2, and
    /// macroblocks arrive out of order — but it lets the answer flip Defer/Frozen → Sealed under an
    /// UNCHANGED key: the stale frozen committee is then served forever while sealed_anchor_for_window,
    /// which is uncached, already returns the sealed anchor, so the committee and the anchor name
    /// different macroblocks and this node tallies failover quorum over a set no peer is using.
    /// Deferring costs nothing here: sync_macroblock_deficit repairs from sealed+1, which IS the hole.
    #[tokio::test]
    async fn roster_mode_answer_moves_only_when_the_seal_frontier_moves() {
        let dir = tempfile::TempDir::new().unwrap();
        let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).unwrap();
        for i in [1u64, 2, 3] { seed_committee_mb(&s, i, 5).await; }
        assert_eq!(s.last_sealed_mb_index(), 3);
        let before = BlockchainNode::roster_mode(&s, 7);

        // Macroblock 5 lands out of order; the hole at 4 keeps the frontier where it was.
        seed_committee_mb(&s, 5, 5).await;
        assert_eq!(s.last_sealed_mb_index(), 3, "a hole at 4 pins the contiguous prefix at 3");

        // The cached failover committee is still keyed (7, 3). The answer must not have moved under it.
        assert_eq!(BlockchainNode::roster_mode(&s, 7), before,
                   "roster_mode moved under a fixed cache key — a stale committee would be served                     while the uncached anchor already advanced");
    }

    /// Restart GAP B: the barred set must be filtered at EVERY committee/producer derivation that reads
    /// a macroblock's eligible field, or a restart re-stalls at the K+1/K+2 tail windows. Source-scan
    /// (the manifest ships empty, so behaviour cannot be exercised without a crafted release).
    #[test]
    fn restart_excludes_filters_committee_readers() {
        // Scanned per file: these two readers live in different submodules, and a concatenation
        // would let this test match its own anchor literals in this file instead of the code.
        for (src, anchor) in [
            (include_str!("committee.rs"), "fn committee_from_macroblock"),
            (include_str!("leader.rs"), "fn frozen_committee"),
        ] {
            let i = src.find(anchor).unwrap_or_else(|| panic!("missing {}", anchor));
            assert!(src[i..i + 1200].contains("restart_excludes"),
                    "{} must filter restart_excludes (GAP B)", anchor);
        }
    }

    /// Restart GAP A: the fresh-genesis mint must refuse while a WS restart pin is active, or a full
    /// wipe re-seeds zero state and destroys the ledger (no re-mint path). process::exit is not
    /// unit-testable, so pin the guard by source-scan just before the mint.
    #[test]
    fn mint_refused_under_active_ws_pin() {
        let src = include_str!("production.rs");
        let mint = src.find("first-ever launch confirmed").expect("mint site");
        assert!(src[mint.saturating_sub(2500)..mint].contains("ws_checkpoint_index() > 0"),
                "the genesis mint must refuse while a WS restart pin is active (GAP A)");
    }

    // DEFECT B + THE REVERT OF ITS FIRST FIX. Two independent functions used to answer "who is the
    // committee for this window" with DIFFERENT staleness policies — one read macroblock N-2 with no
    // walk-back, the other walked back 8. Two answers to one question is a fork surface that fires on
    // an ordinary honest outage, with no adversary present. They are now ONE resolver.
    //
    // The first attempt at that unification gave the shared resolver a 32-deep walk-back so failover
    // could form past the seal. That was WRONG and is the property this test now pins: the walk-back
    // returned whichever macroblock the node happened to hold, the VRF seed comes from THAT macroblock,
    // so two nodes stopping at different indices draw different committees — and the burn gate turns
    // that into a HARD REJECT, while the defer valve (`n2_committee_absent`) is this very function
    // returning None, so a walk-back deletes the defer. Stall, never guess.
    #[tokio::test]
    async fn committee_resolver_is_strict_and_never_guesses() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");

        // Only macroblock 10 is sealed. Nothing above it exists — the halt condition.
        seed_committee_mb(&storage, 10, 40).await;

        // N-2 present: resolved directly.
        let at_12 = BlockchainNode::committee_for_height(&storage, 12 * 90);
        assert_eq!(at_12.as_ref().map(|c| c.len()), Some(40), "N-2 sealed must resolve");

        // N-2 absent: None on EVERY node, at every distance. Never "the newest macroblock I hold" —
        // that makes a block-validity verdict a function of local RocksDB contents.
        for back in [1u64, 2, 8, 16, 32, 40] {
            let h = (12 + back) * 90;
            assert!(BlockchainNode::committee_for_height(&storage, h).is_none(),
                    "resolver guessed {} windows past the seal — that is a per-node committee", back);
        }
        // And the guess is not hiding one level down either.
        assert!(BlockchainNode::committee_from_macroblock(&storage, 11, 13).is_none());

        // Committee and beacon must come from the SAME macroblock, or leader selection and membership
        // are computed against different randomness.
        let src = include_str!("committee.rs");
        let f = src.find("fn committee_from_macroblock").expect("resolver");
        let body = &src[f..f + 1200];
        assert!(body.contains("mb.consensus_data.randomness_beacon"),
                "the beacon must come from the same macroblock as the snapshot");

        // And the resolved committee really is a function of THAT macroblock's beacon: two macroblocks
        // with identical rosters but different beacons must sample differently once the roster exceeds
        // the committee cap. Below the cap sample_committee returns the whole set, so seed a roster
        // above COMMITTEE_THRESHOLD to make the seed observable.
        let dir2 = tempfile::TempDir::new().expect("tempdir");
        let s2 = crate::storage::Storage::new(dir2.path().to_str().unwrap()).expect("storage");
        seed_committee_mb(&s2, 10, BlockchainNode::COMMITTEE_THRESHOLD + 500).await;
        let dir3 = tempfile::TempDir::new().expect("tempdir");
        let s3 = crate::storage::Storage::new(dir3.path().to_str().unwrap()).expect("storage");
        seed_committee_mb(&s3, 11, BlockchainNode::COMMITTEE_THRESHOLD + 500).await;
        let a = BlockchainNode::committee_for_height(&s2, 12 * 90).expect("a");
        let b = BlockchainNode::committee_for_height(&s3, 13 * 90).expect("b");
        assert_eq!(a.len(), BlockchainNode::CONSENSUS_COMMITTEE_SIZE);
        assert_ne!(a, b, "a different macroblock beacon must yield a different VRF subset");
    }

    // THE REASON THE PIN NO LONGER BINDS THE INDEX. A TimeoutCertificate advances the view WITHOUT
    // certifying a window, so after even one dead leader the checkpoint index runs permanently ahead
    // of the window offset. While the pin required `index == anchor_index + k` no `k` could satisfy
    // both equations and the relaxation was unusable on exactly the processes a halt grows out of.
    // The pin now constrains the WINDOW only; the index is free.
    #[tokio::test]
    async fn pin_accepts_any_index_once_a_view_change_has_shifted_it() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        let (a, cp_index, n) = (4u64, 17u64, 12usize);
        let (ah, cp_a) = rc_anchor(&storage, a, cp_index, n, false, a * 90).await;

        // k=1 window, but the index sits 5 rounds above the anchor because five views timed out.
        let mut shifted = rc_pinned_cp(&cp_a, a, ah, 1, cp_a.hash());
        shifted.index = cp_a.index + 6;
        shifted.parent_qc = Some(qnet_consensus::checkpoint_bft::QcRef {
            index: shifted.index - 1, checkpoint_hash: cp_a.hash() });
        // Under the old index pin this was `v2_rc_unpinned`. It must now resolve.
        let q = BlockchainNode::resolve_recovery_pin(&storage, a + 1, &shifted, a, ah, n)
            .expect("a shifted index must not make the pin unsatisfiable");
        assert_eq!(q, qnet_consensus::checkpoint_bft::relaxed_quorum(n));

        // The WINDOW is still pinned, at every index: off the grid and past the span both fail.
        let mut off_grid = shifted.clone();
        off_grid.window_head_height += 1;
        assert!(BlockchainNode::resolve_recovery_pin(&storage, a + 1, &off_grid, a, ah, n)
            .unwrap_err().contains("v2_rc_unpinned"));
        let mut past = shifted.clone();
        past.window_head_height = cp_a.window_head_height
            + (qnet_consensus::checkpoint_bft::RC_SPAN_INDICES + 1) * 30;
        assert!(BlockchainNode::resolve_recovery_pin(&storage, a + 3, &past, a, ah, n)
            .unwrap_err().contains("v2_rc_unpinned"));
        // A gap left by the f+1 jump must RESOLVE: the jump sets current_index without advancing
        // high_qc, so requiring contiguity here killed the span on the very packet loss it exists for.
        let mut gap = shifted.clone();
        gap.parent_qc = Some(qnet_consensus::checkpoint_bft::QcRef {
            index: shifted.index - 4, checkpoint_hash: cp_a.hash() });
        assert!(BlockchainNode::resolve_recovery_pin(&storage, a + 1, &gap, a, ah, n).is_ok());
    }

    // Vote equivocation has TWO sound shapes now that a pin frees the checkpoint index: same-round,
    // and same-WINDOW-HEAD with different committed CONTENT and at least one side pinned. The second
    // is the accountability arm the relaxed threshold rests on — two quorums over one head intersect,
    // and the shared signer is only visible across rounds. Keying it on the content digest is what
    // keeps it sound: a conformant re-proposal of one window at a new index has identical content and
    // can never be convicted, and an unpinned pair (a rollback re-voting an uncertified window) is
    // outside the rule entirely.
    #[test]
    fn vote_equivocation_admits_same_round_and_pinned_head() {
        use qnet_consensus::checkpoint_bft::{Checkpoint, QcRef, pinned_double_vote,
                                             same_round_double_vote};
        let mk = |index: u64, head: u64, sr: [u8; 32], ra: Option<(u64, [u8; 32])>| Checkpoint {
            index, parent_qc: Some(QcRef { index: index - 1, checkpoint_hash: [1u8; 32] }),
            window_head_height: head, window_mb_hashes: vec![], state_root: sr, beacon: [2u8; 32],
            epoch_commitment: [3u8; 32], reward_root: [0u8; 32], registry_root: [0u8; 32],
            logs_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32],
            total_supply: 0, timestamp: 0, proposer: "p".into(), proposer_sig: vec![],
            recovery_anchor: ra,
        };
        let pin = Some((4u64, [9u8; 32]));

        // CONVICTABLE: one head, two contents, different rounds, pinned.
        let a = mk(18, 390, [4u8; 32], pin);
        let b = mk(19, 390, [5u8; 32], pin);
        assert!(pinned_double_vote(&a, &b));
        // A rival anchor is no escape hatch — the key is the head, not the pin.
        assert!(pinned_double_vote(&a, &mk(19, 390, [5u8; 32], Some((5, [8u8; 32])))));
        // Strict-vs-pinned at one head is the same fork and is equally convictable.
        assert!(pinned_double_vote(&a, &mk(19, 390, [5u8; 32], None)));

        // NEVER convictable: the protocol-mandated re-proposal (identical content, new round and
        // proposer), a span simply ADVANCING to the next head, and an unpinned pair.
        let mut reproposal = a.clone();
        reproposal.index = 25; reproposal.proposer = "q".into();
        assert_ne!(reproposal.hash(), a.hash());
        assert!(!pinned_double_vote(&a, &reproposal));
        assert!(!pinned_double_vote(&a, &mk(19, 420, [5u8; 32], pin)));
        assert!(!pinned_double_vote(&mk(18, 390, [4u8; 32], None), &mk(19, 390, [5u8; 32], None)));

        // SAME ROUND is content-keyed too: the pin frees the index, so one replica legally votes twice
        // at one round over the same position — once unpinned, once pinned — and those two hash
        // differently. Convicting on the hash would ban every replica that recovers.
        let plain = mk(18, 390, [4u8; 32], None);
        assert_ne!(a.hash(), plain.hash());
        assert!(!same_round_double_vote(&a, &plain));
        assert!(same_round_double_vote(&a, &mk(18, 390, [7u8; 32], pin)));
        assert!(!same_round_double_vote(&a, &mk(19, 390, [7u8; 32], pin)), "different rounds");
    }

    // Arm and disarm must both reach the DRIVER. Clearing only the global left driver.rc set, so the
    // node kept emitting relaxed checkpoints while reporting itself unarmed, and the loop's unarmed
    // branch simply re-armed on the next tick — an operator disarm with no observable effect.
    #[test]
    fn arm_and_disarm_are_both_one_shot_requests_for_the_loop() {
        assert!(!crate::node::rc_take_disarm_request(), "starts clear");
        crate::node::rc_request_disarm();
        assert!(crate::node::rc_take_disarm_request(), "consumed exactly once");
        assert!(!crate::node::rc_take_disarm_request());
        // An arm request is symmetric and equally one-shot.
        assert!(!crate::node::rc_take_arm_request(), "starts clear");
        crate::node::rc_request_arm();
        assert!(crate::node::rc_take_arm_request(), "consumed exactly once");
        assert!(!crate::node::rc_take_arm_request());
    }

    // NodeReactivation writes the endpoint registry under its INNER node_id, but the only
    // authenticated identity on the TX is `tx.from` (the signature preimage and the pipeline's
    // committed-key lookup both use it). Unbound, one registered super rewrites any victim's endpoint
    // to its own IP and every peer then refuses the victim's handshake. The bind is a pure function of
    // TX bytes, so both the gossip and the apply path reach the same verdict.
    #[test]
    fn reactivation_endpoint_is_bound_to_the_authenticated_identity() {
        let mk = |from: &str, node_id: &str| qnet_state::Transaction {
            hash: String::new(), from: from.to_string(), to: None, amount: 0, nonce: 0,
            gas_price: 0, gas_limit: 0, timestamp: 0, signature: None, public_key: None,
            tx_type: qnet_state::TransactionType::NodeReactivation {
                node_id: node_id.to_string(), current_height: 1,
                last_macroblock_hash: String::new(), last_macroblock_index: 0,
                api_endpoint: "http://1.2.3.4:8001".to_string(),
            },
            data: None, dilithium_signature: Some(vec![1u8; 3309]),
            dilithium_public_key: Some(vec![2u8; 1952]),
            chain_id: qnet_state::transaction::QNET_CHAIN_ID,
        };
        assert!(BlockchainNode::verify_system_tx_binds(&mk("super_A", "super_A")).is_ok());
        let e = BlockchainNode::verify_system_tx_binds(&mk("super_ATK", "super_VICTIM")).unwrap_err();
        assert!(e.contains("NodeReactivation identity split"), "got {}", e);
        // The signature-presence rule stays: an unsigned reactivation has no authenticator at all.
        let mut unsigned = mk("super_A", "super_A");
        unsigned.dilithium_signature = None;
        assert!(BlockchainNode::verify_system_tx_binds(&unsigned).is_err());
    }

    // B2. The NodeRegistration dedup set must be seeded from rows `registry_root` ACTUALLY covers.
    // It was seeded from the `nreg_` prefix, which `compute_lt_state_cf` does not fold, while a
    // cold-join snapshot is imported into the registry CF unfiltered — so ONE injected `nreg_<victim>`
    // row made the joiner skip that node's real registration as a duplicate. The skip is per-TX, the
    // block is still accepted, `state_root` still matches, and the joiner's `registry_root` is
    // permanently one row short: a silent, unrecoverable exit from the quorum chosen by the server.
    #[tokio::test]
    async fn dedup_seed_ignores_registry_rows_outside_the_root() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        let cf = storage.registry_cf_for_test();

        // A genuine, root-covered registration: reachable via srtr_, payload under node_<id>.
        storage.put_registry_row_for_test(&cf, b"srtr_node_real", b"x");
        storage.put_registry_row_for_test(&cf, b"node_node_real",
            br#"{"reg_height":10,"wallet":"w_real","burn":"b","vrf_pk_sha3":""}"#);

        // What a forged snapshot injects: an orphan nreg_ row for an identity that has NOT registered,
        // plus a node_ payload with no roster row pointing at it. Neither is in registry_root.
        storage.put_registry_row_for_test(&cf, b"nreg_node_victim", b"w_victim");
        storage.put_registry_row_for_test(&cf, b"node_node_victim",
            br#"{"reg_height":11,"wallet":"w_victim","burn":"b","vrf_pk_sha3":""}"#);

        let covered = storage.registry_root_covered_origins().expect("covered");
        assert_eq!(covered, vec![("node_real".to_string(), "w_real".to_string())],
                   "the dedup seed must contain exactly the root-covered bindings");
        assert!(!covered.iter().any(|(id, _)| id == "node_victim"),
                "an injected orphan must not pre-seed the dedup set — that is the silent quorum exit");

        // A roster row whose payload has no reg_height is an unconfirmed RPC/discovery cache write and
        // is excluded by the root's own fold, so it must be excluded here too.
        storage.put_registry_row_for_test(&cf, b"srtr_node_unconf", b"x");
        storage.put_registry_row_for_test(&cf, b"node_node_unconf", br#"{"wallet":"w_u"}"#);
        assert_eq!(storage.registry_root_covered_origins().expect("covered").len(), 1,
                   "unconfirmed rows are outside the root and must stay outside the seed");
    }

    // B3. Reaching fork_conflict means the slot was taken during the save's own await — the slot-taken
    // guard filters every already-occupied case — so this block DID write its durable deltas
    // (registry_root LtHash add, cbw_, nreg_, dpk bind) that rollback_block cannot reverse. The apply
    // arm must signal a rebuild exactly as the producer arm already does; leaving it silent keeps two
    // hashed checkpoint fields permanently wrong on that node and the boot rebuilds re-fold the orphan.
    #[test]
    fn fork_conflict_on_the_apply_arm_signals_a_rebuild() {
        let src = include_str!("../block_pipeline.rs");
        let benign = src.find("let benign_race = err_text.contains(\"fork_conflict\")")
            .expect("the benign-race classifier must still exist");
        let arm = &src[benign..];
        let sig = arm.find("signal_fork_recovery(")
            .expect("the apply arm's fork_conflict case must signal a rebuild");
        assert!(sig < 4_000, "the signal drifted out of the benign-race arm (offset {})", sig);
        // And ONLY for fork_conflict: a rollback already in flight, or storage that keeps no blocks,
        // materialised nothing, so signalling there would start a second, deeper recovery.
        assert!(arm[..sig].contains("if err_text.contains(\"fork_conflict\")"),
                "the signal must be gated on fork_conflict alone");
    }

    // DEFECT A (anchor half). The failover vote anchor read MacroBlock::hash(w-2) and returned None
    // once that macroblock did not exist — i.e. ~3 minutes into any stall — so a TimeoutVote could be
    // neither built nor verified exactly when rotation was needed.
    // The anchor stays on macroblock w-2. A microblock-hash source was tried to reach past the seal
    // frontier and is strictly WORSE: every caller resolves failover_committee_for_window first, which
    // already needs that macroblock, while a snapshot joiner holds no microblock aliases below its
    // anchor. Same availability, narrower source.
    #[test]
    fn failover_anchor_is_the_macroblock_the_committee_gate_already_needs() {
        let src = include_str!("../unified_p2p/mod.rs");
        let f = src.find("pub fn sealed_anchor_for_window").expect("anchor fn");
        let body = &src[f..f + 1400];
        assert!(body.contains("get_macroblock_by_height(w - 2)"));
        assert!(!body.contains("canonical_hash_at"));
    }

    // A restart is only a REPAIR if the barred identities stay out. The eligible set is not a
    // carried-forward set that decays — `phase2a_eligible_additions` recomputes it every window as the
    // fixed point {registered AND recently-heartbeating}, so filtering only the carry-over would put
    // every barred identity back into the quorum denominator on the very next window and the restarted
    // chain would re-halt on the same set within minutes. Both arms must enforce the bar.
    #[test]
    fn restart_bar_is_enforced_on_both_eligibility_arms() {
        let src = &node_sources();
        // Carry-over filter inside create_eligible_producers_snapshot.
        let carry = src.find("// Restart bar, checked before the genesis carve-out")
            .expect("carry-over arm must check the restart bar");
        // Re-admission arm inside phase2a_eligible_additions.
        let readmit = src.find("// Restart bar, enforced here too")
            .expect("Phase-2A re-admission arm must check the restart bar");
        assert_ne!(carry, readmit);
        // Each anchor must be followed by the guard itself, not just by a comment claiming it. Counting
        // occurrences file-wide cannot work here: this test reads its own source, so its string
        // literals would be counted too.
        let guard_gap = |from: usize| src[from..].find("restart_excludes(")
            .expect("the guard must appear after its own comment");
        assert!(guard_gap(carry) < 800, "carry-over arm: comment without the guard next to it");
        assert!(guard_gap(readmit) < 800, "Phase-2A arm: comment without the guard next to it");

        // The bar is checked BEFORE the genesis carve-out, so a compromised genesis identity can also
        // be retired. Otherwise the set with the most authority is the one that can never be cleaned.
        let genesis_carve = src.find("// Genesis stays: it is the bootstrap floor").expect("carve-out");
        assert!(carry < genesis_carve, "the restart bar must precede the genesis carve-out");

        // Inert in this binary: nothing is barred, so neither arm changes behaviour at genesis.
        assert!(!crate::genesis_constants::restart_active());
        assert!(!crate::genesis_constants::restart_excludes("genesis_node_001"));
    }

    // The span's heads must land inside macroblocks A+1 and A+2 and nowhere else — that is what makes
    // `recovery_failover_windows` and the propose-time step bound name one range, and what keeps the
    // already-sealed anchor window on the strict threshold.
    #[test]
    fn span_heads_cover_exactly_the_two_macroblocks_above_the_anchor() {
        use qnet_consensus::checkpoint_bft::{MACROBLOCK_INTERVAL, RC_SPAN_INDICES,
                                             recovery_failover_windows, recovery_window_head};
        for a in [1u64, 4, 100, 160_000] {
            let (lo, hi) = recovery_failover_windows(a);
            assert_eq!((lo, hi), (a + 1, a + 2), "the anchor's own window stays strict");
            let h_a = a * MACROBLOCK_INTERVAL;
            for k in 1..=RC_SPAN_INDICES {
                let head = recovery_window_head(h_a, k);
                let w = (head - 1) / MACROBLOCK_INTERVAL + 1;
                assert!(w >= lo && w <= hi, "k={} landed on failover window {}", k, w);
            }
            // The last span head is exactly the A+2 boundary — 6 * 30 == 2 * 90.
            assert_eq!(recovery_window_head(h_a, RC_SPAN_INDICES), (a + 2) * MACROBLOCK_INTERVAL);
        }
    }

    // The arm can only ever SHORTEN the stall wait. Every other condition is re-checked identically
    // for the operator RPC and the automatic path, so an operator cannot relax a healthy network.
    #[tokio::test]
    async fn rc_arm_refuses_healthy_and_ineligible() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        let empty = std::collections::HashSet::new();

        // The switch answers before every other condition, on both entry points and whatever the
        // chain looks like: healthy, halted with no anchor, or halted with a sealed one.
        for halted in [false, true] {
            assert_eq!(crate::node::rc_try_arm(&storage, &empty, halted).unwrap_err().reason(),
                       "recovery_relaxation_disabled");
            assert_eq!(crate::node::rc_try_arm_dry(&storage, &empty, halted).unwrap_err().reason(),
                       "recovery_relaxation_disabled");
        }
        for i in 1..=4u64 { let _ = rc_anchor(&storage, i, 10 + i, 12, false, i * 90).await; }
        assert_eq!(storage.last_sealed_mb_index(), 4);
        assert_eq!(crate::node::rc_try_arm_dry(&storage, &empty, true).unwrap_err().reason(),
                   "recovery_relaxation_disabled");

        // Refusal reasons are distinct and legible — an operator must see WHY, not a bare false.
        assert_eq!(crate::node::RcArmRefusal::CommitteeBelowFloor(5).reason(), "committee_below_floor n=5");
        assert_eq!(crate::node::RcArmRefusal::QuorumStillReachable(9, 8).reason(),
                   "quorum_still_reachable heard=9 q=8");
        assert_eq!(crate::node::RcArmRefusal::TooFewLive(3, 6).reason(), "too_few_live heard=3 relaxed_q=6");
        assert_eq!(crate::node::RcArmRefusal::AnchorRelaxed.reason(), "anchor_relaxed");

        // Nothing above armed anything.
        assert!(crate::node::rc_armed().is_none());
        // Unarmed, every threshold is the strict one — for a pinned subject as much as an unknown one.
        for n in [5usize, 50, 1000] {
            assert_eq!(crate::node::rc_effective_quorum(5, &[0xAB; 32], n),
                       qnet_consensus::checkpoint_bft::quorum_size(n));
        }
        // Any relaxed and any strict quorum over ONE committee provably intersect, and so do two
        // relaxed ones — that is what makes the pin a threshold change and nothing more.
        for n in [50usize, 1000] {
            let q = qnet_consensus::checkpoint_bft::relaxed_quorum(n);
            assert!(q + qnet_consensus::checkpoint_bft::quorum_size(n) > n);
            assert!(2 * q > n);
            assert!(q <= qnet_consensus::checkpoint_bft::quorum_size(n));
        }
    }

    // Phase-2A recency window (genesis rule, no gate): prev = cur-1 SPANS the epoch boundary so the
    // prior epoch's subwindow 9 is still recent liveness — the flicker fix. Feeds epoch_commitment→QC,
    // so it MUST be identical on every node from block 0.
    #[test]
    fn recency_subwindow_indices_boundary() {
        assert_eq!(recency_subwindow_indices(5 * 1440), (5, 4));          // mid-epoch
        assert_eq!(recency_subwindow_indices(5 * 1440 + 100), (5, 4));
        assert_eq!(recency_subwindow_indices(0), (0, 0));                 // h0 saturates
        assert_eq!(recency_subwindow_indices(14400), (10, 9));           // epoch boundary bridges (no flicker)
        assert_eq!(recency_subwindow_indices(14400 + 50), (10, 9));
        assert_eq!(recency_subwindow_indices(14400 + 1440), (11, 10));
        assert_eq!(recency_subwindow_indices(2 * 14400), (20, 19));      // epoch2 boundary bridges
    }

    // E1 determinism: the SCALE-inverted Phase-2A additions (recent-HB-gated point-reads) MUST be
    // byte-identical in membership AND order to the old full-scan reference (reg-height point-read
    // first, then recent-HB check). If they diverge the committee + epoch_commitment fork.
    #[test]
    fn phase2a_additions_equal_full_scan_reference() {
        use std::collections::{HashMap, HashSet};
        const FLOOR: u32 = 7000;
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");

        // scan_end mid-epoch 5 → recency subwindows (5,4); heartbeats anchored in those pass recency.
        let scan_end = 5 * 1440 + 100;
        let (cur, prev) = recency_subwindow_indices(scan_end);
        let sw_anchor = |sw: u64| sw * 1440 + 10; // an anchor height inside subwindow sw

        // Registered supers (srtr_ index) at varied reg_heights. Deliberately NOT alphabetical insert
        // order so a broken sort would surface. Genesis carries reg_height 0.
        storage.save_node_registration_at_height("genesis_node_001", "super", "wG", 80.0, 0).unwrap();
        storage.save_node_registration_at_height("super_c", "super", "wC", 90.0, 100).unwrap();
        storage.save_node_registration_at_height("super_a", "super", "wA", 90.0, 200).unwrap();
        storage.save_node_registration_at_height("super_b", "super", "wB", 90.0, 300).unwrap();
        // Registered but low reputation → filtered by the floor.
        storage.save_node_registration_at_height("super_lowrep", "super", "wL", 50.0, 150).unwrap();
        // Registered AFTER scan_end → confirmed-by-scan_end gate excludes it.
        storage.save_node_registration_at_height("super_future", "super", "wF", 90.0, scan_end + 500).unwrap();
        // A light node that also heartbeats: NOT in srtr_, must never be admitted as a super.
        storage.save_node_registration_at_height("light_x", "light", "wLX", 90.0, 120).unwrap();

        // Heartbeats (lhb_ index). Recent (cur/prev subwindow) vs stale (older subwindow).
        for (id, sw) in [
            ("genesis_node_001", cur), ("super_c", prev), ("super_a", cur),
            ("super_lowrep", cur), ("super_future", cur), ("light_x", cur),
            ("super_b", prev.saturating_sub(2)), // STALE → super_b not recently live → excluded
        ] {
            storage.index_heartbeat_inclusion(id, sw_anchor(sw), scan_end.min(sw_anchor(sw) + 5)).unwrap();
        }

        let registered_super_nodes: HashSet<String> = storage.super_registrations_sorted()
            .unwrap().into_iter().map(|(id, _w)| id).collect();
        let recent_hb = recent_heartbeat_senders(&storage, scan_end).expect("index intact in test");
        // Consensus reputation supplied directly (this test isolates the eligibility predicates).
        let reputation_map: HashMap<String, f64> = [
            ("genesis_node_001", 80.0), ("super_c", 90.0), ("super_a", 90.0),
            ("super_b", 90.0), ("super_lowrep", 50.0), ("super_future", 90.0), ("light_x", 90.0),
        ].iter().map(|(k, v)| (k.to_string(), *v)).collect();
        let already: HashSet<String> = HashSet::new();

        // Inverted (production) path.
        let st = qnet_state::State::new();
        let got = phase2a_eligible_additions(
            &st, &storage, &registered_super_nodes, &recent_hb, &already, &reputation_map, scan_end, FLOOR,
        );

        // OLD full-scan reference: iterate ALL registrants sorted, reg-height point-read FIRST, then the
        // recent-HB membership check (the pre-inversion evaluation order).
        let mut regs: Vec<&String> = registered_super_nodes.iter().collect();
        regs.sort();
        let mut want: Vec<qnet_state::EligibleProducer> = Vec::new();
        for reg in regs {
            if already.contains(reg) { continue; }
            match storage.node_reg_height(reg) {
                Ok(Some(h)) if h <= scan_end => {}
                _ => continue,
            }
            if !recent_hb.contains(reg) { continue; }
            let rep = (reputation_map.get(reg).copied()
                .unwrap_or(qnet_consensus::deterministic_reputation::INITIAL_REPUTATION)
                .clamp(0.0, 100.0) * 100.0).round() as u32;
            if rep < FLOOR { continue; }
            want.push(qnet_state::EligibleProducer { node_id: reg.clone(), reputation: rep });
        }

        assert_eq!(got, want, "inverted additions must equal full-scan reference (membership AND order)");
        // Expected eligible: genesis_node_001, super_a, super_c (sorted). Excluded: super_b (stale HB),
        // super_lowrep (floor), super_future (reg > scan_end), light_x (not in srtr_).
        let ids: Vec<&str> = got.iter().map(|p| p.node_id.as_str()).collect();
        assert_eq!(ids, vec!["genesis_node_001", "super_a", "super_c"]);
    }

    // Light-reward roster cutoff. light_reg_epoch_roster is genesis-active (gate=0) for a fresh genesis,
    // so EVERY epoch (incl. 0) freezes the roster at the commit-window open (epoch_start + 14350) — a light
    // node registered mid-epoch earns for that epoch. Creator + reader call it identically (no divergence).
    #[test]
    fn light_roster_cutoff_gate() {
        assert_eq!(light_roster_cutoff(0), 14_350);              // epoch 0: commit-window from genesis
        assert_eq!(light_roster_cutoff(7), 7 * 14_400 + 14_350); // 115150
        assert_eq!(light_roster_cutoff(8), 8 * 14_400 + 14_350); // 129550
    }

    // Verify-before-serve invariant: the gate hasher (epoch_reward_merkle_root) MUST reproduce the exact
    // root emission committed for the SAME leaf-set — else it would false-reject correct data on every node
    // and break all claims. Locks the two hashers together; the epoch binding must also change the root.
    #[test]
    fn reward_verify_hasher_matches_committed_root() {
        let eligible = vec![
            ("genesis_node_001".to_string(), "EON1walletA".to_string()),
            ("super_node_x".to_string(),      "EON1walletB".to_string()),
            ("light_node_y".to_string(),      "EON1walletC".to_string()),
        ];
        let epoch = 7u64;
        let (wallets, root) = super::BlockchainNode::distribute_split_rewards(&eligible, NO_LIGHTS, 300, epoch);
        assert!(!root.is_empty() && !wallets.is_empty());
        assert_eq!(super::BlockchainNode::epoch_reward_merkle_root(&wallets, epoch), root,
            "verify-gate hasher must reproduce the committed reward_root byte-for-byte");
        assert_ne!(super::BlockchainNode::epoch_reward_merkle_root(&wallets, epoch + 1), root,
            "leaf binds the epoch ⇒ a cross-epoch leaf-set is correctly rejected");
        assert!(super::BlockchainNode::epoch_reward_merkle_root(&[], epoch).is_empty());
    }

    // Scale (10M+ light): a shard-decomposed reward proof MUST be byte-identical to the monolithic
    // single-tree proof for EVERY leaf-count and index (incl. odd counts, partial/single-leaf last
    // shards, N < shard_size) — else a serving node's O(shard) proof would fail on-chain and break all
    // claims. Proven here so reward_root, the wire proof, on-chain verify, and the app stay UNCHANGED.
    #[test]
    fn reward_shard_proof_equals_monolithic() {
        use qnet_core::crypto::merkle;
        let leafset = |n: usize| -> Vec<String> {
            (0..n).map(|i| {
                let mut h = Sha3_256::new(); h.update(&(i as u64).to_le_bytes()); hex::encode(h.finalize())
            }).collect::<Vec<_>>()
        };
        let counts: Vec<usize> = (1..=130).chain(vec![255, 256, 257, 300, 511, 512, 513]).collect();
        for &n in &counts {
            let leaves = leafset(n);
            let mono_root = merkle::compute_merkle_root(&leaves).unwrap();
            for &ssz in &[2usize, 4, 8, 16] {
                let roots = merkle::reward_shard_roots(&leaves, ssz).unwrap();
                assert_eq!(hex::encode(merkle::merkle_continue_root(&roots)), mono_root,
                    "root mismatch n={} shard_size={}", n, ssz);
                for i in 0..n {
                    let s = i / ssz;
                    let start = s * ssz;
                    let end = (start + ssz).min(n);
                    let mono = merkle::generate_merkle_proof(&leaves, i).unwrap();
                    let sh = merkle::generate_reward_proof_sharded(&leaves[start..end], i - start, &roots, s, ssz).unwrap();
                    // The proof MUST be byte-identical to the monolithic single-tree proof (all N).
                    assert_eq!(sh, mono, "proof mismatch n={} shard_size={} i={}", n, ssz, i);
                    // And verify against the (unchanged) monolithic root. n=1 is a pre-existing verify edge
                    // (single-leaf, empty proof) that never occurs in a reward set (always >= 6 recipients).
                    if n >= 2 {
                        assert!(merkle::verify_merkle_proof(&leaves[i], &mono_root, &sh),
                            "verify n={} shard_size={} i={}", n, ssz, i);
                    }
                }
            }
        }
    }

    // Storage round-trip for the sharded reward structure: partition → store → locate → serve. Proves
    // reward_proof_from_shard returns the right amount + a proof that verifies against the committed root
    // AND is byte-identical to the monolithic proof, across single- and multi-shard sizes, plus the
    // NotRecipient / Divergent / Absent outcomes. Complements the pure-merkle equivalence test above.
    #[test]
    fn reward_shard_storage_roundtrip() {
        use qnet_core::crypto::merkle;
        let epoch = 7u64;
        // Ascending-by-wallet (matches the BTreeMap order every writer produces); amount = 1000 + i.
        let mk = |n: usize| -> Vec<(String, u64)> {
            (0..n).map(|i| (format!("eon{:012}", i), 1000u64 + i as u64)).collect()
        };
        let ssz = BlockchainNode::REWARD_SHARD_SIZE;
        for &n in &[1usize, 2, 5, 100, ssz - 1, ssz, ssz + 1, 2 * ssz + 37] {
            let dir = tempfile::TempDir::new().expect("tempdir");
            let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
            let wallets = mk(n);
            let committed = BlockchainNode::epoch_reward_merkle_root(&wallets, epoch);
            BlockchainNode::save_epoch_reward_sharded(&storage, epoch, &wallets);

            let leaves: Vec<String> = wallets.iter()
                .map(|(w, a)| BlockchainNode::reward_leaf_hash_hex(w, epoch, *a)).collect();

            // Sample boundary + interior indices (verifying all is O(n·shard); sample for large n).
            let mut idxs: Vec<usize> = vec![0, n - 1];
            for b in [ssz.saturating_sub(1), ssz, ssz + 1, n / 2] { if b < n { idxs.push(b); } }
            idxs.sort(); idxs.dedup();
            for &i in &idxs {
                let (w, amt) = wallets[i].clone();
                match BlockchainNode::reward_proof_from_shard(&storage, epoch, &committed, &w, true) {
                    ShardClaim::Proof(a, proof) => {
                        assert_eq!(a, amt, "amount n={} i={}", n, i);
                        // n=1 is the pre-existing single-leaf verify edge (never a real reward set).
                        assert!(n == 1 || merkle::verify_merkle_proof(&leaves[i], &committed, &proof),
                            "verify n={} i={}", n, i);
                        assert_eq!(proof, merkle::generate_merkle_proof(&leaves, i).unwrap(),
                            "proof != monolithic n={} i={}", n, i);
                    }
                    other => panic!("expected Proof n={} i={} got {:?}", n, i, other),
                }
                // Amount-only path: same amount, no proof gen.
                match BlockchainNode::reward_proof_from_shard(&storage, epoch, &committed, &w, false) {
                    ShardClaim::Proof(a, p) => { assert_eq!(a, amt); assert!(p.is_empty()); }
                    other => panic!("amount-only expected Proof n={} i={} got {:?}", n, i, other),
                }
            }
            // Not in the set ⇒ NotRecipient (structure present + consistent).
            assert!(matches!(
                BlockchainNode::reward_proof_from_shard(&storage, epoch, &committed, "zzz_absent_wallet", true),
                ShardClaim::NotRecipient), "NotRecipient n={}", n);
            // Wrong committed root ⇒ Divergent (never serves a mismatching claim).
            assert!(matches!(
                BlockchainNode::reward_proof_from_shard(&storage, epoch, &"00".repeat(32), &wallets[0].0, true),
                ShardClaim::Divergent), "Divergent n={}", n);
            // Never-written epoch ⇒ Absent (caller rebuilds once).
            assert!(matches!(
                BlockchainNode::reward_proof_from_shard(&storage, epoch + 999, &committed, &wallets[0].0, true),
                ShardClaim::Absent), "Absent n={}", n);
        }
    }

    // Failover vote key = pure fn of the voter's OWN verified tip (window = (tip+1)/90); spread
    // tips converge via f+1 committee-signed window amplification (tested in unified_p2p), never
    // via a peer-height sample. The order statistic survives only as a SYNC-HINT oracle.
    #[test]
    fn failover_key_is_own_tip_windowed() {
        // Converged tips (chain stopped ⇒ gossip equalizes within one delay) ⇒ identical window key.
        let tip = 4080u64;
        for _node in 0..5 { assert_eq!((tip + 1) / 90, 45, "converged tips ⇒ one (window) key"); }
        // Deep-inside-window spread (incident 4065..4079) ⇒ STILL one key: same window.
        for local_tip in [4065u64, 4069, 4072, 4075, 4079] {
            assert_eq!((local_tip + 1) / 90, 45, "same window despite spread tips");
        }
        // Boundary straddle (4049 vs 4050) ⇒ adjacent windows; convergence is f+1 amplification
        // (min-target) + TC-floor monotonicity — NOT any shared height sample.
        assert_eq!((4049u64 + 1) / 90, 45);
        assert_eq!((4050u64 + 1) / 90, 45);
        assert_eq!((4139u64 + 1) / 90, 46, "next window starts at target 4140");

        // Hint oracle (clamp_overclaim / sync targeting ONLY): lone-liar and thin-sample safety.
        use crate::unified_p2p::frontier_order_statistic as fos;
        let sample = vec![4053u64, 4051, 4049, 4049, 4049, 4049];
        assert_eq!(fos(sample.clone()), 4051, "(f+1)-th highest hint");
        let mut rot = sample.clone(); rot.rotate_left(3);
        assert_eq!(fos(rot), 4051, "order-independent");
        assert_eq!(fos(vec![]), 0, "no corroborators ⇒ no hint");
        assert_eq!(fos(vec![9_000_000u64, 4050]), 0, "thin sample ⇒ no hint (no lone-liar steer)");
    }

    // lhb_ liveness index == body scan, byte-identical (Phase-2A eligibility feeds epoch_commitment;
    // any index/scan divergence is a fork). Covers min-inclusion, reorg canonicalize, re-apply recovery.
    #[test]
    fn heartbeat_index_matches_body_scan() {
        fn hb_tx(node_id: &str, anchor_height: u64) -> qnet_state::Transaction {
            // Storage stores txs separately keyed by 64-hex hash — must be valid hex, unique per tx.
            let uniq = node_id.bytes().fold(anchor_height, |a, b| a.wrapping_mul(131).wrapping_add(b as u64));
            qnet_state::Transaction {
                from: node_id.to_string(),
                to: None,
                amount: 0,
                tx_type: qnet_state::TransactionType::Heartbeat {
                    node_id: node_id.to_string(),
                    anchor_height,
                    anchor_hash: String::new(),
                },
                timestamp: 0,
                hash: format!("{:064x}", uniq),
                signature: None,
                public_key: None,
                gas_price: u64::MAX,
                gas_limit: 0,
                nonce: 1,
                data: None,
                dilithium_signature: None,
                dilithium_public_key: Some(node_id.to_string().into_bytes()),
                chain_id: qnet_state::transaction::QNET_CHAIN_ID,
            }
        }
        fn put_block(storage: &crate::storage::Storage, height: u64, txs: Vec<qnet_state::Transaction>) {
            let mb = qnet_state::MicroBlock {
                height,
                timestamp: 0,
                transactions: txs,
                producer: "genesis_node_001".to_string(),
                signature: vec![0u8; 64],
                merkle_root: [0u8; 32],
                previous_hash: [0u8; 32],
                vrf_output: None,
                vrf_proof: None,
                fees_collected: 0,
                state_root: [0u8; 32],
                timeout_round: 0,
                carried_baseline: 0,
                timeout_proof: None,
            };
            let data = bincode::serialize(&mb).expect("serialize");
            storage.save_microblock(height, &data).expect("save");
        }
        let _dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(_dir.path().to_str().unwrap()).expect("storage");

        // (height, node, anchor): spans subwindows 0..2, incl. a REPEAT inclusion for (sw1, super_a).
        // Every anchor is strictly past and within HB_ANCHOR_MAX_LAG — the writer drops anything else,
        // so a fixture that violated it would no longer describe a heartbeat the chain can carry.
        let blocks: Vec<(u64, &str, u64)> = vec![
            (100, "super_a", 50),      // sw0, lag 50
            (1500, "super_b", 1499),   // sw1, lag 1
            (1600, "super_a", 1550),   // sw1 first inclusion, lag 50
            (2000, "super_a", 1950),   // sw1 repeat, lag 50 — min must stay 1600
            (2950, "super_c", 2890),   // sw2, lag 60
        ];
        for (h, id, a) in &blocks {
            put_block(&storage, *h, vec![hb_tx(id, *a)]);
            storage.index_heartbeat_inclusion(id, *a, *h).expect("index"); // apply-path writer
        }
        for scan_end in [100u64, 1499, 1500, 1600, 1999, 2000, 2880, 2950, 3000] {
            assert_eq!(recent_heartbeat_senders(&storage, scan_end).expect("index intact"),
                       recent_heartbeat_senders_scan(&storage, scan_end),
                       "index != scan at scan_end={}", scan_end);
        }
        // Min-inclusion survives the repeat: reader at 1999 must already see super_a via 1600.
        assert!(recent_heartbeat_senders(&storage, 1999).expect("index intact").contains("super_a"));

        // Reorg to 1599: entries included above are dropped; index == scan at the new tip.
        storage.canonicalize_heartbeat_index(1599).expect("canonicalize");
        assert_eq!(recent_heartbeat_senders(&storage, 1599).expect("index intact"),
                   recent_heartbeat_senders_scan(&storage, 1599), "post-reorg mismatch");
        // Re-apply of the (same) fork tail restores full equality — writer is idempotent.
        for (h, id, a) in blocks.iter().filter(|(h, _, _)| *h > 1599) {
            storage.index_heartbeat_inclusion(id, *a, *h).expect("re-index");
        }
        for scan_end in [2000u64, 2950, 3000] {
            assert_eq!(recent_heartbeat_senders(&storage, scan_end).expect("index intact"),
                       recent_heartbeat_senders_scan(&storage, scan_end),
                       "post-reapply index != scan at scan_end={}", scan_end);
        }
    }

    // committee_for_height determinism: genesis era ⇒ None (caller uses the genesis committee), and
    // an ABSENT N-2 snapshot ⇒ None — REJECT, never a per-node walk-back guess (which would fork).
    #[test]
    fn committee_for_height_genesis_and_absent_n2() {
        let _dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(_dir.path().to_str().unwrap()).expect("storage");
        assert!(BlockchainNode::committee_for_height(&storage, 1).is_none(), "genesis era ⇒ None");
        assert!(BlockchainNode::committee_for_height(&storage, 90).is_none(), "epoch 1 ⇒ None");
        assert!(BlockchainNode::committee_for_height(&storage, 180).is_none(), "epoch 2 ⇒ None");
        // height 300 ⇒ epoch 4 ⇒ needs macroblock idx 2; absent ⇒ None (no guess), not a divergent set.
        assert!(BlockchainNode::committee_for_height(&storage, 300).is_none(), "absent N-2 ⇒ None (no guess)");
    }

    // Regression guard for the genesis registry_root fork: the block CREATOR (apply_genesis_registrations)
    // must write vrf_pk co-resident, byte-identical to the peer-apply path — else its registry_root
    // diverges from synced peers and proposal_content never reaches 2f+1. Pins creator == peer == vrf-bound.
    #[test]
    fn genesis_apply_writes_vrf_byte_identical_to_peer() {
        // FIX-5: the on-chain pk rides as RAW bytes; write_registration_row binds it only at the exact
        // ML-DSA-65 key length, so use a valid-length placeholder so the vrf row is actually written.
        let mut gtx = BlockchainNode::create_node_registration_tx_with_timestamp(
            "genesis_node_001", qnet_state::NodeType::Super, "walletG", "genesis", "", Some(0));
        gtx.dilithium_public_key = Some(vec![0xABu8; crate::crypto::vrf::D3_PK_BYTES]);

        // Creator path (the fix): reg_height 0 + vrf via the shared canonical writer.
        let _dc = tempfile::TempDir::new().expect("tempdir");
        let creator = crate::storage::Storage::new(_dc.path().to_str().unwrap()).expect("storage");
        BlockchainNode::apply_genesis_registrations(&creator, std::slice::from_ref(&gtx));

        // Peer-apply path: the deferred consumer writes the same row (super ⇒ vrf from the TX pubkey).
        let _dp = tempfile::TempDir::new().expect("tempdir");
        let peer = crate::storage::Storage::new(_dp.path().to_str().unwrap()).expect("storage");
        let vrf = vec![0xABu8; crate::crypto::vrf::D3_PK_BYTES]; // FIX-5: raw pk bytes, same as the TX carries
        peer.save_node_registration_at_height_burn_vrf("genesis_node_001", "super", "walletG", 1.0, 0, "", Some(vrf.as_slice())).unwrap();
        assert_eq!(creator.compute_registry_root(0).unwrap(), peer.compute_registry_root(0).unwrap(),
                   "genesis creator path must be byte-identical to the peer-apply path");

        // vrf is actually bound: a vrf-less write yields a DIFFERENT root (proves the regression is closed).
        let _dn = tempfile::TempDir::new().expect("tempdir");
        let novrf = crate::storage::Storage::new(_dn.path().to_str().unwrap()).expect("storage");
        novrf.save_node_registration_at_height_burn("genesis_node_001", "super", "walletG", 1.0, 0, "").unwrap();
        assert_ne!(creator.compute_registry_root(0).unwrap(), novrf.compute_registry_root(0).unwrap(),
                   "vrf_pk must be bound into registry_root (creator != vrf-less)");
    }

    // The genesis-INGEST paths (HTTP pull, file import, existing-store restore) cached the rows
    // without stamping reg_height. registry_root folds only stamped rows, so such a node committed a
    // root that omitted all 5 genesis nodes and was Rejected at every checkpoint until some later
    // restart happened to stamp them. Pins that caching alone is NOT enough and that the pairing with
    // apply_genesis_registrations is what makes an ingesting node agree with the creator.
    #[test]
    fn genesis_ingest_must_stamp_not_only_cache() {
        let mut gtx = BlockchainNode::create_node_registration_tx_with_timestamp(
            "genesis_node_001", qnet_state::NodeType::Super, "walletG", "genesis", "", Some(0));
        gtx.dilithium_public_key = Some(vec![0xABu8; crate::crypto::vrf::D3_PK_BYTES]);

        let _dc = tempfile::TempDir::new().expect("tempdir");
        let creator = crate::storage::Storage::new(_dc.path().to_str().unwrap()).expect("storage");
        BlockchainNode::cache_node_registrations_from_transactions(&creator, std::slice::from_ref(&gtx));
        BlockchainNode::apply_genesis_registrations(&creator, std::slice::from_ref(&gtx));

        // Cache-only: what every ingest path used to do on its own.
        let _di = tempfile::TempDir::new().expect("tempdir");
        let ingest = crate::storage::Storage::new(_di.path().to_str().unwrap()).expect("storage");
        BlockchainNode::cache_node_registrations_from_transactions(&ingest, std::slice::from_ref(&gtx));
        assert_ne!(creator.compute_registry_root(0).unwrap(), ingest.compute_registry_root(0).unwrap(),
                   "cache-only must NOT already match — otherwise this guard proves nothing");
        assert_eq!(ingest.compute_registry_root(0).unwrap(),
                   crate::registry_lthash::LtHash::new().root(),
                   "an unstamped row must be invisible to registry_root");

        // Stamping afterwards converges it, and is idempotent.
        BlockchainNode::apply_genesis_registrations(&ingest, std::slice::from_ref(&gtx));
        assert_eq!(creator.compute_registry_root(0).unwrap(), ingest.compute_registry_root(0).unwrap(),
                   "a stamped ingest path must agree with the creator");
        BlockchainNode::apply_genesis_registrations(&ingest, std::slice::from_ref(&gtx));
        assert_eq!(creator.compute_registry_root(0).unwrap(), ingest.compute_registry_root(0).unwrap(),
                   "re-stamping must be idempotent");
    }

    // ── B cutover: merkle reward-claim determinism + security ──
    // The producer's committed root and every node's apply-time recompute call the SAME
    // the reward split over the SAME consensus inputs. These pin the three properties
    // the cross-node agreement depends on: order-independence, conservation, proof verifiability.

    #[test]
    fn reward_distribution_is_order_independent() {
        // Same eligible set in two different input orders → identical root + per-wallet amounts.
        // This is THE determinism guarantee: light-node merge order (HashMap) must not matter.
        let a = vec![
            ("node_c".to_string(), "wallet_c".to_string()),
            ("node_a".to_string(), "wallet_a".to_string()),
            ("node_b".to_string(), "wallet_b".to_string()),
        ];
        let b = vec![
            ("node_a".to_string(), "wallet_a".to_string()),
            ("node_b".to_string(), "wallet_b".to_string()),
            ("node_c".to_string(), "wallet_c".to_string()),
        ];
        let total = 1_000_000_001; // not divisible by 3 → exercises the remainder split
        let (va, ra) = BlockchainNode::distribute_split_rewards(&a, NO_LIGHTS, total, 160);
        let (vb, rb) = BlockchainNode::distribute_split_rewards(&b, NO_LIGHTS, total, 160);
        assert_eq!(ra, rb, "root must be order-independent");
        assert_eq!(va, vb, "per-wallet amounts must be order-independent");
        assert!(!ra.is_empty());
    }

    #[test]
    fn reward_distribution_conserves_total() {
        let elig: Vec<(String, String)> =
            (0..7).map(|i| (format!("node_{}", i), format!("wallet_{}", i))).collect();
        let total = 1_000_000_000_000u64 + 5; // remainder = 5 over 7 eligible
        let (v, root) = BlockchainNode::distribute_split_rewards(&elig, NO_LIGHTS, total, 320);
        let sum: u64 = v.iter().map(|(_, a)| *a).sum();
        assert_eq!(sum, total, "Σ distributed must equal total (no QNC lost or created)");
        let max = v.iter().map(|(_, a)| *a).max().unwrap();
        let min = v.iter().map(|(_, a)| *a).min().unwrap();
        assert!(max - min <= 1, "equal-per-eligible: amounts differ by at most 1 nano");
        assert!(!root.is_empty());
    }

    #[test]
    fn light_eligibility_bitmap_roundtrips() {
        // Fork-safety: the reward reader must recover EXACTLY the shard-local indices the bitmap
        // producer marked. Encode with the real producer fn, decode with the reader's bit logic.
        let index_span = 13u32;
        let eligible: Vec<u32> = vec![0, 3, 7, 12];
        let tx = BlockchainNode::create_light_node_bitmap_tx("genesis_node_002", 5, &eligible, index_span)
            .expect("bitmap tx");
        let bm = match tx.tx_type {
            qnet_state::TransactionType::LightNodeEligibilityBitmap { bitmap_compressed, index_span: ta, eligible_count, .. } => {
                assert_eq!(ta, index_span);
                assert_eq!(eligible_count, eligible.len() as u32);
                zstd::decode_all(&bitmap_compressed[..]).expect("decompress")
            }
            _ => panic!("wrong tx type"),
        };
        let mut recovered: Vec<u32> = Vec::new();
        for i in 0..index_span as usize {
            if bm[i / 8] & (1 << (i % 8)) != 0 { recovered.push(i as u32); }
        }
        assert_eq!(recovered, eligible, "reader must recover exactly the producer's eligible set");
    }

    #[test]
    fn light_hash_shard_bitmap_round_trip() {
        // Fork-safety: the bitmap builder and every reader (emission recompute, ping-commitment collector,
        // snapshot_light_eligible) map bits↔nodes via the SAME stable hash-shard (light_shard_of + a per-shard
        // sorted counter: bit i in shard g = the i-th sorted roster node with light_shard_of()==g). Build
        // per-shard bitmaps for a roster + eligible subset, decode them, and assert the exact set round-trips.
        use std::collections::{HashMap, HashSet};
        let mut roster: Vec<String> = (0..2000u32)
            .map(|i| format!("light_mobile_{:016x}", (i as u64).wrapping_mul(0x9E3779B97F4A7C15)))
            .collect();
        roster.sort();
        let eligible_ref: HashSet<&String> = roster.iter().step_by(3).collect(); // every 3rd node attests

        for id in &roster { assert!(light_shard_of(id) < 5, "every node maps to a shard in 0..5"); }

        // BUILDER: per-shard bitmap; bit li set iff the li-th sorted shard member is eligible.
        let mut bitmaps: HashMap<usize, Vec<u8>> = HashMap::new();
        let mut totals = [0usize; 5];
        {
            let mut counters = [0usize; 5];
            for id in &roster {
                let g = light_shard_of(id);
                let li = counters[g];
                counters[g] += 1;
                totals[g] += 1;
                if eligible_ref.contains(id) {
                    let bm = bitmaps.entry(g).or_default();
                    let byte = li / 8;
                    if bm.len() <= byte { bm.resize(byte + 1, 0); }
                    bm[byte] |= 1 << (li % 8);
                }
            }
        }

        // READER: same enumeration recovers the eligible set from the bitmaps.
        let mut recovered: HashSet<String> = HashSet::new();
        {
            let mut counters = [0usize; 5];
            for id in &roster {
                let g = light_shard_of(id);
                let li = counters[g];
                counters[g] += 1;
                if let Some(bm) = bitmaps.get(&g) {
                    if bm.get(li / 8).map(|b| b & (1 << (li % 8)) != 0).unwrap_or(false) {
                        recovered.insert(id.clone());
                    }
                }
            }
        }

        let expected: HashSet<String> = eligible_ref.iter().map(|s| (*s).clone()).collect();
        assert_eq!(recovered, expected, "hash-shard bitmap must round-trip the exact eligible set (builder == reader)");
        assert_eq!(totals.iter().sum::<usize>(), roster.len(), "shards partition the roster");
        // With a large uniform roster each shard should be within a few % of total/5 (no positional skew).
        for (g, &t) in totals.iter().enumerate() {
            assert!(t > roster.len() / 8, "shard {} unexpectedly small ({} of {})", g, t, roster.len());
        }
    }

    /// The split must conserve exactly, aggregate per WALLET, and never strand a pool that has no
    /// recipients — at launch there are no light clients, so a fixed 75% user share would mint value
    /// nobody could ever claim.
    #[test]
    fn split_conserves_aggregates_and_never_strands() {
        let sup: Vec<(String, String)> = (0..4)
            .map(|i| (format!("super_node_{:04}", i), format!("wallet_s{}", i))).collect();
        let lit: Vec<(String, String)> = (0..400)
            .map(|i| (format!("light_node_{:04}", i), format!("wallet_l{}", i))).collect();
        let total: u64 = 251_432_340_000_000;

        let (v, _) = BlockchainNode::distribute_split_rewards(&sup, &lit, total, 160);
        assert_eq!(v.iter().map(|(_, a)| *a).sum::<u64>(), total, "emission must be conserved exactly");
        let op: u64 = v.iter().filter(|(w, _)| w.starts_with("wallet_s")).map(|(_, a)| *a).sum();
        // 4 operators share 25%, 400 users share 75% ⇒ an operator earns ~33x a user.
        let per_op = op / 4;
        let per_user = (total - op) / 400;
        assert!(per_op > per_user * 30 && per_op < per_user * 36, "per_op={} per_user={}", per_op, per_user);

        // No users yet: operators take the whole emission, nothing is stranded.
        let (v2, _) = BlockchainNode::distribute_split_rewards(&sup, &[], total, 160);
        assert_eq!(v2.iter().map(|(_, a)| *a).sum::<u64>(), total);
        // No operators: users take the whole emission.
        let (v3, _) = BlockchainNode::distribute_split_rewards(&[], &lit, total, 160);
        assert_eq!(v3.iter().map(|(_, a)| *a).sum::<u64>(), total);
    }

    /// One wallet holding BOTH a super and a light identity must produce ONE leaf. Two pools appending
    /// separately would emit the wallet twice and break the sharded claim path.
    #[test]
    fn split_emits_one_leaf_per_wallet() {
        let sup = vec![("super_node_0001".to_string(), "shared_wallet".to_string())];
        let lit = vec![("light_node_0001".to_string(), "shared_wallet".to_string())];
        let (v, _) = BlockchainNode::distribute_split_rewards(&sup, &lit, 1_000_000, 160);
        assert_eq!(v.len(), 1, "a wallet must appear once, got {:?}", v);
        assert_eq!(v[0].1, 1_000_000, "both pool shares must land on the same leaf");
    }

    #[test]
    fn reward_claim_proof_round_trip() {
        // Producer builds the root; a claimant proves its exact (wallet, epoch, amount) leaf.
        // A tampered amount must NOT verify — this is the claim's security property.
        let epoch = 480u64;
        let elig: Vec<(String, String)> =
            (0..5).map(|i| (format!("n{}", i), format!("w{}", i))).collect();
        let (wallet_vec, root) = BlockchainNode::distribute_split_rewards(&elig, NO_LIGHTS, 500, epoch);
        let leaf_of = |w: &str, amount: u64| {
            let mut h = Sha3_256::new();
            h.update(w.as_bytes());
            h.update(&epoch.to_le_bytes());
            h.update(&amount.to_le_bytes());
            hex::encode(h.finalize())
        };
        let leaves: Vec<String> = wallet_vec.iter().map(|(w, a)| leaf_of(w, *a)).collect();
        let idx = 2usize;
        let (w, amount) = &wallet_vec[idx];
        let proof = qnet_core::crypto::merkle::generate_merkle_proof(&leaves, idx).unwrap();
        assert!(
            qnet_core::crypto::merkle::verify_merkle_proof(&leaf_of(w, *amount), &root, &proof),
            "valid (wallet,epoch,amount) proof must verify against the committed root"
        );
        assert!(
            !qnet_core::crypto::merkle::verify_merkle_proof(&leaf_of(w, amount + 1), &root, &proof),
            "tampered amount must fail verification (no over-claim)"
        );
    }

    // v34: reward/producer eligibility reads the UNFORGEABLE on-chain liveness count (popcount
    // of the subwindow bitmask set by validated Heartbeat TXs), NOT the self-attested HBC count.
    // The reader picks the live bitmask for the current epoch, the finalized count for the
    // just-previous epoch (so the boundary reward snapshot is race-free), else 0.
    #[test]
    fn account_heartbeat_count_reads_correct_epoch() {
        let mut acct = qnet_state::Account::new("super_x".to_string());
        acct.heartbeat_epoch = 5;
        acct.heartbeat_slots = 0b1_1111_1111; // 9 subwindows set
        acct.heartbeat_final_epoch = 4;
        acct.heartbeat_final_slots = 0x7F; // 7 subwindows
        assert_eq!(BlockchainNode::account_heartbeat_count(&acct, 5), 9, "current epoch → live popcount");
        assert_eq!(BlockchainNode::account_heartbeat_count(&acct, 4), 7, "previous epoch → finalized count");
        assert_eq!(BlockchainNode::account_heartbeat_count(&acct, 3), 0, "older epoch → 0 (not eligible)");
        assert_eq!(BlockchainNode::account_heartbeat_count(&acct, 6), 0, "future epoch → 0");
    }

    // P1-D: the committee anchor (N-2) for v2 QC verification. The genesis boundary (index<3 → None)
    // is the subtle part — an off-by-one there would defer the bootstrap macroblocks forever (mb=2's
    // N-2 is mb=0, which is never created), or conversely walk back and split honest nodes.
    #[test]
    fn v2_committee_anchor_index_boundary() {
        assert_eq!(BlockchainNode::v2_committee_anchor_index(0), None);
        assert_eq!(BlockchainNode::v2_committee_anchor_index(1), None);
        assert_eq!(BlockchainNode::v2_committee_anchor_index(2), None, "mb=2's N-2=0 is never created → bootstrap anchor, no defer");
        assert_eq!(BlockchainNode::v2_committee_anchor_index(3), Some(1), "mb=3 anchors on mb=1 (first real on-chain N-2)");
        assert_eq!(BlockchainNode::v2_committee_anchor_index(10), Some(8));
    }

    /// Test CompactPqSignature deserialization
    /// OPTIMIZED v2.23: RAW bytes format, dilithium_message_signature removed
    #[test]
    fn test_compact_signature_parsing() {
        // Pure ML-DSA-65 (P8): Create signature directly (RAW bytes format)
        let sig = crate::crypto::CompactPqSignature {
            node_id: "test_node".to_string(),
            cert_serial: "CERT-123".to_string(),
            dilithium_key_signature: vec![1, 2, 3, 4, 5],  // RAW bytes
            signed_at: 1234567890,
        };
        
        // Verify fields
        assert_eq!(sig.node_id, "test_node");
        assert_eq!(sig.cert_serial, "CERT-123");
        assert!(!sig.dilithium_key_signature.is_empty());
        
        // Test roundtrip
        let json = serde_json::to_string(&sig).expect("Serialization failed");
        let restored: crate::crypto::CompactPqSignature = serde_json::from_str(&json)
            .expect("Deserialization failed");
        assert_eq!(sig.node_id, restored.node_id);
        assert_eq!(sig.dilithium_key_signature, restored.dilithium_key_signature);
    }
    
    /// Test signature prefix detection
    #[test]
    fn test_signature_prefix_detection() {
        let compact_sig = "compact:{\"node_id\":\"test\"}";
        let pq_sig = "pq:{\"cert\":{}}";
        let dilithium_sig = "dilithium_sig_abc123";
        let p2p_sig = "pq_p2p:{\"node_id\":\"test\"}";

        assert!(compact_sig.starts_with("compact:"));
        assert!(pq_sig.starts_with("pq:"));
        assert!(dilithium_sig.starts_with("dilithium_sig_"));
        assert!(p2p_sig.starts_with("pq_p2p:"));
    }
    
    /// Test microblock hash computation
    #[test]
    fn test_microblock_hash_computation() {
        
        let test_data = b"test microblock data";
        let mut hasher = Sha3_256::new();
        hasher.update(test_data);
        let hash = hasher.finalize();
        
        // SHA3-256 produces 32 bytes
        assert_eq!(hash.len(), 32);
        
        // Same input should produce same hash
        let mut hasher2 = Sha3_256::new();
        hasher2.update(test_data);
        let hash2 = hasher2.finalize();
        assert_eq!(hash, hash2);
    }
    
    /// Test GLOBAL_QUANTUM_CRYPTO initialization pattern (v2.50: OnceCell+Arc)
    #[tokio::test]
    async fn test_global_crypto_initialization() {
        // v2.50: Initialize and verify lock-free access
        let _ = init_global_quantum_crypto().await;
        let crypto = try_get_quantum_crypto();
        assert!(crypto.is_some(), "Global crypto should be initialized");
    }
    
    /// Test re-rooted encapsulated data format (pure ML-DSA-65, P8)
    #[test]
    fn test_encapsulated_data_format() {
        let message_hash = [1u8; 32]; // 32 bytes SHA3-256
        let timestamp: u64 = 1234567890;

        let mut encapsulated = Vec::new();
        encapsulated.extend_from_slice(&message_hash);
        encapsulated.extend_from_slice(&timestamp.to_le_bytes());

        // Pure ML-DSA-65 preimage: 32 + 8 = 40 bytes
        assert_eq!(encapsulated.len(), 40);

        // Verify hex encoding works
        let hex = hex::encode(&encapsulated);
        assert_eq!(hex.len(), 80); // 40 * 2
    }

    // ═════════════════════════════════════════════════════════════════════════
    // EQUIVOCATION-SLASHING PROOF VERIFICATION — fail-safe + soundness.
    // Pins the two load-bearing guarantees of the on-chain slashing path:
    //   (1) a REAL same-height (block) / same-round (vote) double-sign IS detected
    //       — the verifier is not vacuously-false; and
    //   (2) NOTHING ELSE bans — forged sig, identical artefacts, unregistered key,
    //       and (the false-slashing trap) two HONEST votes from DIFFERENT rounds.
    // A false positive here would ban an honest node, so (2) is the critical set.
    // ═════════════════════════════════════════════════════════════════════════

    fn eqv_storage() -> (crate::storage::Storage, tempfile::TempDir) {
        let d = tempfile::tempdir().expect("tempdir");
        (crate::storage::Storage::new(d.path().to_str().unwrap()).expect("storage"), d)
    }

    /// Publishes the key to COMMITTED state, which is where the verifiers read it — the RAM registry
    /// is deliberately not consulted (it is per-process and idle-evicted ⇒ a fork source).
    fn eqv_gen_and_register(
        storage: &crate::storage::Storage,
        node_id: &str,
    ) -> (Vec<u8>, pqcrypto_mldsa::mldsa65::SecretKey) {
        use pqcrypto_traits::sign::PublicKey as _;
        let (pk, sk) = pqcrypto_mldsa::mldsa65::keypair();
        let pk_bytes = pk.as_bytes().to_vec();
        storage.save_vrf_public_key(node_id, &hex::encode(&pk_bytes)).expect("publish vrf pk");
        // A ban verdict resolves the offender key only when the CANONICAL registry row commits to it —
        // the standalone key row survives a reorg that removed the registration, so it cannot stand alone.
        storage.save_node_registration_at_height_burn_vrf(
            node_id, "super", &format!("w_{}", node_id), 1.0, 1, "", Some(&pk_bytes)).expect("register");
        (pk_bytes, sk)
    }

    fn eqv_mk_header(ts: u64, merkle: u8, round: u64) -> qnet_state::EquivocationHeader {
        qnet_state::EquivocationHeader {
            timestamp: ts,
            merkle_root: [merkle; 32],
            previous_hash: [9u8; 32],
            state_root: [0u8; 32],
            vrf_output: None,
            timeout_round: round,
            carried_baseline: 0,
            pk_digest: [0u8; 32],
            signature: Vec::new(),
        }
    }

    fn eqv_sign_block(
        sk: &pqcrypto_mldsa::mldsa65::SecretKey,
        height: u64,
        producer: &str,
        h: &qnet_state::EquivocationHeader,
    ) -> Vec<u8> {
        use pqcrypto_traits::sign::DetachedSignature as _;
        // Reconstruct the EXACT Block_Sig_v23.1 digest verify_block_header_sig checks.
        let mut hasher = Sha3_256::new();
        hasher.update(b"Block_Sig_v23.1");
        hasher.update(&height.to_be_bytes());
        hasher.update(&h.timestamp.to_be_bytes());
        hasher.update(&h.merkle_root);
        hasher.update(&h.previous_hash);
        hasher.update(&h.state_root);
        hasher.update(producer.as_bytes());
        if let Some(ref vrf) = h.vrf_output { hasher.update(vrf); }
        hasher.update(&h.timeout_round.to_be_bytes());
        hasher.update(&h.carried_baseline.to_be_bytes());
        hasher.update(&h.pk_digest);
        let digest = hasher.finalize();
        let sig = pqcrypto_mldsa::mldsa65::detached_sign(digest.as_ref(), sk);
        format!("dilithium3_v4:{}", hex::encode(sig.as_bytes())).into_bytes()
    }

    fn eqv_mk_checkpoint(node: &str, index: u64, mb: u8) -> qnet_consensus::checkpoint_bft::Checkpoint {
        qnet_consensus::checkpoint_bft::Checkpoint {
            index,
            parent_qc: None,
            window_head_height: index.saturating_mul(90),
            window_mb_hashes: vec![[mb; 32]],
            state_root: [0u8; 32],
            beacon: [0u8; 32],
            epoch_commitment: [0u8; 32],
            reward_root: [0u8; 32],
            registry_root: [0u8; 32],
            logs_root: [0u8; 32],
            dilithium_pk_root: [0u8; 32],
            reward_epoch_root: [0u8; 32],
            total_supply: 0,
            timestamp: 1000,
            proposer: node.to_string(),
            proposer_sig: Vec::new(), recovery_anchor: None,
        }
    }

    // Build a vote signature in the canonical consensus_crypto combined format
    // ("dilithium_sig_<node>_<b64>" of [sig_len][SignedMessage][pk_len][pk]) over the
    // exact QNET_BFT2_VOTE:<hex(hash)> message a real voter signs.
    fn eqv_sign_vote(
        node: &str,
        pk_bytes: &[u8],
        sk: &pqcrypto_mldsa::mldsa65::SecretKey,
        checkpoint_hash: [u8; 32],
    ) -> Vec<u8> {
        use pqcrypto_traits::sign::SignedMessage as _;
        use base64::{Engine as _, engine::general_purpose};
        let message = format!("QNET_BFT2_VOTE:{}", hex::encode(checkpoint_hash));
        let signed = pqcrypto_mldsa::mldsa65::sign(message.as_bytes(), sk);
        let sm = signed.as_bytes();
        let mut combined = Vec::new();
        combined.extend_from_slice(&(sm.len() as u32).to_le_bytes());
        combined.extend_from_slice(sm);
        combined.extend_from_slice(&(pk_bytes.len() as u32).to_le_bytes());
        combined.extend_from_slice(pk_bytes);
        format!("dilithium_sig_{}_{}", node, general_purpose::STANDARD.encode(&combined)).into_bytes()
    }

    /// ONE genuine public block must never yield a valid proof. The struct derives PartialEq and
    /// carries `signature`, so comparing whole headers made two copies of the same block "different"
    /// as soon as their signature bytes differed — and hex::decode accepts either case, so simply
    /// re-casing the hex of a public signature produced two headers that both verify. Anyone could
    /// have minted a permanent, chain-committed ban against any producer from a block they merely
    /// read; at n=5, two such bans halt finality for good.
    #[test]
    fn eqv_recased_signature_of_one_block_is_not_equivocation() {
        let node = "eqv_test_blk_recase";
        let (_st, _d) = eqv_storage();
        let (_pk, sk) = eqv_gen_and_register(&_st, node);
        let h = 100u64;
        let mut a = eqv_mk_header(1000, 1, 0);
        a.signature = eqv_sign_block(&sk, h, node, &a);
        let mut b = a.clone();
        b.signature = String::from_utf8(a.signature.clone()).unwrap().to_uppercase().into_bytes();
        // Same wire signature, different bytes — and the header structs now genuinely differ.
        assert_ne!(a.signature, b.signature);
        assert_ne!(a, b, "struct equality is exactly what must NOT decide this");
        assert!(!BlockchainNode::verify_equivocation_proof(&_st, node, h, &a, &b),
                "re-casing one block's signature hex must not forge an equivocation proof");
    }

    /// ML-DSA signing is randomised, so an honest producer that re-emits the same block after a
    /// rollback signs different bytes over the identical digest. That is a restart, not a double
    /// sign, and must never be slashable — no attacker required for this one.
    #[test]
    fn eqv_resigned_same_block_is_not_equivocation() {
        let node = "eqv_test_blk_resign";
        let (_st, _d) = eqv_storage();
        let (_pk, sk) = eqv_gen_and_register(&_st, node);
        let h = 100u64;
        let mut a = eqv_mk_header(1000, 1, 0);
        let mut b = a.clone();
        a.signature = eqv_sign_block(&sk, h, node, &a);
        b.signature = eqv_sign_block(&sk, h, node, &b);
        assert_ne!(a.signature, b.signature, "ML-DSA signing is randomised");
        assert!(!BlockchainNode::verify_equivocation_proof(&_st, node, h, &a, &b),
                "re-signing the SAME block must not be slashable");
    }

    /// Two blocks that differ ONLY in the beacon contribution are the split that binding vrf_output
    /// into block identity closed — so they must now be a slashable double-sign, not "the same block".
    #[test]
    fn eqv_differing_vrf_output_is_equivocation() {
        let node = "eqv_test_blk_vrf";
        let (_st, _d) = eqv_storage();
        let (_pk, sk) = eqv_gen_and_register(&_st, node);
        let h = 100u64;
        let mut a = eqv_mk_header(1000, 1, 0);
        let mut b = eqv_mk_header(1000, 1, 0);
        a.vrf_output = Some([1u8; 32]);
        b.vrf_output = Some([2u8; 32]);
        a.signature = eqv_sign_block(&sk, h, node, &a);
        b.signature = eqv_sign_block(&sk, h, node, &b);
        assert!(BlockchainNode::verify_equivocation_proof(&_st, node, h, &a, &b),
                "same hash, different beacon contribution IS a double-sign");
    }

    #[test]
    fn eqv_block_valid_double_sign_is_detected() {
        let node = "eqv_test_blk_valid";
        let (_st, _d) = eqv_storage();
        let (_pk, sk) = eqv_gen_and_register(&_st, node);
        let h = 100u64;
        let mut a = eqv_mk_header(1000, 1, 0);
        let mut b = eqv_mk_header(1001, 2, 0); // same producer/height, different content
        a.signature = eqv_sign_block(&sk, h, node, &a);
        b.signature = eqv_sign_block(&sk, h, node, &b);
        assert!(BlockchainNode::verify_equivocation_proof(&_st, node, h, &a, &b),
                "a real same-height double-sign MUST verify (verifier non-vacuous)");
    }

    #[test]
    fn eqv_block_forged_sig_does_not_ban() {
        let node = "eqv_test_blk_forged";
        let (_st, _d) = eqv_storage();
        let (_pk, sk) = eqv_gen_and_register(&_st, node);
        let h = 100u64;
        let mut a = eqv_mk_header(1000, 1, 0);
        let mut b = eqv_mk_header(1001, 2, 0);
        a.signature = eqv_sign_block(&sk, h, node, &a);
        b.signature = eqv_sign_block(&sk, h, node, &b);
        let n = b.signature.len() - 1;
        b.signature[n] ^= 0xFF; // corrupt one hex char of b's sig
        assert!(!BlockchainNode::verify_equivocation_proof(&_st, node, h, &a, &b),
                "a forged signature MUST NOT ban (no false slashing)");
    }

    #[test]
    fn eqv_block_identical_does_not_ban() {
        let node = "eqv_test_blk_ident";
        let (_st, _d) = eqv_storage();
        let (_pk, sk) = eqv_gen_and_register(&_st, node);
        let h = 100u64;
        let mut a = eqv_mk_header(1000, 1, 0);
        a.signature = eqv_sign_block(&sk, h, node, &a);
        let b = a.clone();
        assert!(!BlockchainNode::verify_equivocation_proof(&_st, node, h, &a, &b),
                "identical headers are not equivocation");
    }

    #[test]
    fn eqv_block_unregistered_offender_does_not_ban() {
        let node = "eqv_test_blk_unregistered_never";
        let (_st, _d) = eqv_storage(); // empty chain state: the key was never published
        let a = eqv_mk_header(1000, 1, 0);
        let b = eqv_mk_header(1001, 2, 0);
        assert!(!BlockchainNode::verify_equivocation_proof(&_st, node, 100, &a, &b),
                "no on-chain PK ⇒ cannot ban");
    }

    #[tokio::test]
    async fn eqv_vote_same_round_double_sign_is_detected() {
        let node = "eqv_test_vote_same";
        let (_st, _d) = eqv_storage();
        let (pk, sk) = eqv_gen_and_register(&_st, node);
        let ca = eqv_mk_checkpoint(node, 5, 7);
        let cb = eqv_mk_checkpoint(node, 5, 8); // SAME round, different content
        let sa = eqv_sign_vote(node, &pk, &sk, ca.hash());
        let sb = eqv_sign_vote(node, &pk, &sk, cb.hash());
        let ba = bincode::serialize(&ca).unwrap();
        let bb = bincode::serialize(&cb).unwrap();
        assert!(BlockchainNode::verify_vote_equivocation_proof(&_st, node, &ba, &sa, &bb, &sb).await,
                "a real same-round double-vote MUST verify (verifier non-vacuous)");
    }

    #[tokio::test]
    async fn eqv_vote_different_round_does_not_ban() {
        // THE false-slashing trap: identical VALID sigs, only the round differs →
        // two honest votes in successive rounds, NOT equivocation.
        let node = "eqv_test_vote_diffround";
        let (_st, _d) = eqv_storage();
        let (pk, sk) = eqv_gen_and_register(&_st, node);
        let ca = eqv_mk_checkpoint(node, 5, 7);
        let cb = eqv_mk_checkpoint(node, 6, 7); // DIFFERENT round
        let sa = eqv_sign_vote(node, &pk, &sk, ca.hash());
        let sb = eqv_sign_vote(node, &pk, &sk, cb.hash());
        let ba = bincode::serialize(&ca).unwrap();
        let bb = bincode::serialize(&cb).unwrap();
        assert!(!BlockchainNode::verify_vote_equivocation_proof(&_st, node, &ba, &sa, &bb, &sb).await,
                "two honest votes from DIFFERENT rounds MUST NOT ban (false-slashing guard)");
    }

    // THE accountability arm the freed index rests on, exercised through the on-chain verifier: one
    // window head, two committed contents, DIFFERENT rounds, one side pinned. Same-round equivocation
    // cannot see this pair, and without it a shared signer of two relaxed quorums forks the chain for
    // free.
    #[tokio::test]
    async fn eqv_vote_pinned_head_cross_round_is_detected() {
        let node = "eqv_test_vote_pinned_head";
        let (_st, _d) = eqv_storage();
        let (pk, sk) = eqv_gen_and_register(&_st, node);
        let mut ca = eqv_mk_checkpoint(node, 5, 7);
        let mut cb = eqv_mk_checkpoint(node, 8, 9);      // later round, SAME head, other content
        cb.window_head_height = ca.window_head_height;
        ca.recovery_anchor = Some((4, [9u8; 32]));
        let sa = eqv_sign_vote(node, &pk, &sk, ca.hash());
        let sb = eqv_sign_vote(node, &pk, &sk, cb.hash());
        let (ba, bb) = (bincode::serialize(&ca).unwrap(), bincode::serialize(&cb).unwrap());
        assert!(BlockchainNode::verify_vote_equivocation_proof(&_st, node, &ba, &sa, &bb, &sb).await,
                "one head, two contents, at least one pinned MUST ban");
    }

    // THE false-slashing traps the pin creates, both through the real verifier. An honest replica
    // emits BOTH of these while recovering: the pinned re-proposal of the round it already voted at,
    // and the re-proposal of one window at a later round. Neither may ban.
    #[tokio::test]
    async fn eqv_vote_pin_and_reproposal_of_one_content_do_not_ban() {
        let node = "eqv_test_vote_pin_conformant";
        let (_st, _d) = eqv_storage();
        let (pk, sk) = eqv_gen_and_register(&_st, node);
        let ca = eqv_mk_checkpoint(node, 5, 7);
        // Same round, same content, pin added: two distinct signatures, one committed content.
        let mut pinned = ca.clone();
        pinned.recovery_anchor = Some((4, [9u8; 32]));
        assert_ne!(ca.hash(), pinned.hash());
        let sa = eqv_sign_vote(node, &pk, &sk, ca.hash());
        let sp = eqv_sign_vote(node, &pk, &sk, pinned.hash());
        let (ba, bp) = (bincode::serialize(&ca).unwrap(), bincode::serialize(&pinned).unwrap());
        assert!(!BlockchainNode::verify_vote_equivocation_proof(&_st, node, &ba, &sa, &bp, &sp).await,
                "adding the pin to the round already voted is the recovery step, not an offence");
        // Later round, other proposer, same content: the protocol-mandated re-proposal.
        let mut re = ca.clone();
        re.index = 9; re.proposer = "someone_else".into();
        let sr = eqv_sign_vote(node, &pk, &sk, re.hash());
        let br = bincode::serialize(&re).unwrap();
        assert!(!BlockchainNode::verify_vote_equivocation_proof(&_st, node, &bp, &sp, &br, &sr).await,
                "a re-proposal of one window at a new round must never ban");
        // And an UNPINNED pair at one head stays outside the rule: a rollback may legally re-vote an
        // uncertified window.
        let mut roll = ca.clone();
        roll.index = 11; roll.state_root = [3u8; 32];
        let sroll = eqv_sign_vote(node, &pk, &sk, roll.hash());
        let broll = bincode::serialize(&roll).unwrap();
        assert!(!BlockchainNode::verify_vote_equivocation_proof(&_st, node, &ba, &sa, &broll, &sroll).await,
                "an unpinned pair at one head is not an offence");
    }

    #[tokio::test]
    async fn eqv_vote_identical_does_not_ban() {
        let node = "eqv_test_vote_ident";
        let (_st, _d) = eqv_storage();
        let (pk, sk) = eqv_gen_and_register(&_st, node);
        let ca = eqv_mk_checkpoint(node, 5, 7);
        let sa = eqv_sign_vote(node, &pk, &sk, ca.hash());
        let ba = bincode::serialize(&ca).unwrap();
        assert!(!BlockchainNode::verify_vote_equivocation_proof(&_st, node, &ba, &sa, &ba, &sa).await,
                "identical checkpoint is not equivocation");
    }

    #[tokio::test]
    async fn eqv_vote_forged_sig_does_not_ban() {
        let node = "eqv_test_vote_forged";
        let (_st, _d) = eqv_storage();
        let (pk, sk) = eqv_gen_and_register(&_st, node);
        let ca = eqv_mk_checkpoint(node, 5, 7);
        let cb = eqv_mk_checkpoint(node, 5, 8);
        let sa = eqv_sign_vote(node, &pk, &sk, ca.hash());
        let ba = bincode::serialize(&ca).unwrap();
        let bb = bincode::serialize(&cb).unwrap();
        let forged = b"dilithium_sig_eqv_test_vote_forged_not_a_real_signature".to_vec();
        assert!(!BlockchainNode::verify_vote_equivocation_proof(&_st, node, &ba, &sa, &bb, &forged).await,
                "a forged vote signature MUST NOT ban");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // BURN-ATTESTATION QUORUM — Phase-1 proof-of-burn consensus gate. Closes the
    // Byzantine-producer fake-burn Sybil hole: a non-genesis NodeRegistration is
    // valid only with ≥2f+1 distinct VALID genesis signatures over the canonical
    // burn message. All sub-checks in ONE test — the consensus PK registry is
    // process-global and these use the fixed genesis_node_00X ids, so a single
    // registration avoids cross-test races.
    // ═════════════════════════════════════════════════════════════════════════
    fn burn_gen_genesis(_genesis_id: &str) -> (Vec<u8>, pqcrypto_mldsa::mldsa65::SecretKey) {
        use pqcrypto_traits::sign::PublicKey as _;
        // No CONSENSUS_PK_REGISTRY registration: the committee verifier resolves each attestor's PK
        // from on-chain storage (load_vrf_public_key), not the RAM registry. Registering here would
        // collide across tests (the registry is immutable per id) — the caller saves PKs to storage.
        let (pk, sk) = pqcrypto_mldsa::mldsa65::keypair();
        (pk.as_bytes().to_vec(), sk)
    }
    fn burn_sign(genesis_id: &str, pk: &[u8], sk: &pqcrypto_mldsa::mldsa65::SecretKey, msg: &str) -> String {
        use pqcrypto_traits::sign::SignedMessage as _;
        use base64::{Engine as _, engine::general_purpose};
        let signed = pqcrypto_mldsa::mldsa65::sign(msg.as_bytes(), sk);
        let sm = signed.as_bytes();
        let mut c = Vec::new();
        c.extend_from_slice(&(sm.len() as u32).to_le_bytes());
        c.extend_from_slice(sm);
        c.extend_from_slice(&(pk.len() as u32).to_le_bytes());
        c.extend_from_slice(pk);
        format!("dilithium_sig_{}_{}", genesis_id, general_purpose::STANDARD.encode(&c))
    }

    // C-2 QC-sig compaction KAT: a full-format vote sig strips to a smaller compact sig that verifies
    // against the committee-resolved pk (the exact node QC-verify path), and every tamper rejects. This
    // is the headless proof the strip↔compact-verify round-trip is byte-correct (the live mobile client
    // is pk-agnostic + already verifies against the committee pk; still cross-check byte-exact when live).
    #[test]
    fn c2_qc_sig_compaction_roundtrip() {
        use qnet_consensus::consensus_crypto::{strip_embedded_pk, verify_consensus_signature_compact};
        let (pk, sk) = burn_gen_genesis("genesis_node_001");
        let msg = "QNET_BFT2_VOTE:deadbeefcafe";
        let full = burn_sign("genesis_node_001", &pk, &sk, msg);
        let compact = strip_embedded_pk(&full).expect("full-format sig must strip");
        assert!(compact.len() < full.len(), "compact sig is smaller (embedded pk dropped)");
        assert!(verify_consensus_signature_compact("genesis_node_001", msg, &compact, &pk),
            "compact verify with the correct committee pk + message must pass");
        // Every tamper rejects: wrong message, wrong pk, wrong claimed id.
        assert!(!verify_consensus_signature_compact("genesis_node_001", "QNET_BFT2_VOTE:00", &compact, &pk));
        let (other_pk, _) = burn_gen_genesis("genesis_node_002");
        assert!(!verify_consensus_signature_compact("genesis_node_001", msg, &compact, &other_pk));
        assert!(!verify_consensus_signature_compact("genesis_node_002", msg, &compact, &pk), "id in string must match");
        // Idempotent: an already-compact sig is not re-strippable (no double-strip forming bad qc.sigs).
        assert!(strip_embedded_pk(&compact).is_none(), "compact sig must not re-strip");
        // A non-dilithium_sig_ envelope (e.g. a Byzantine pq_bin: vote) is not strippable ⇒ the driver
        // drops it so it can never lock an unverifiable leaf into the QC (finality-stall guard).
        assert!(strip_embedded_pk("pq_bin:AAAA").is_none(), "non-dilithium_sig_ envelope must not strip");
        // The compact verifier rejects a FULL-format sig (exact [sig_len][SignedMessage] length is enforced).
        assert!(!verify_consensus_signature_compact("genesis_node_001", msg, &full, &pk),
            "compact verifier must reject a full (pk-trailer) sig");
    }
    // Default: cost == amount (at-cost), attest_epoch=1 (genesis committee at the GATE=0 height). Use
    // burn_reg_tx_cost for an explicit cost, burn_reg_tx_epoch for a non-genesis attest_epoch.
    fn burn_reg_tx(reg_proof: &str, burn_tx: &str, amount: u64, attestors: Vec<(String, String)>) -> qnet_state::Transaction {
        burn_reg_tx_full(&burn_node_id(), reg_proof, burn_tx, amount, amount, attestors, 1)
    }
    fn burn_reg_tx_epoch(reg_proof: &str, burn_tx: &str, amount: u64, attestors: Vec<(String, String)>, attest_epoch: u64) -> qnet_state::Transaction {
        burn_reg_tx_full(&burn_node_id(), reg_proof, burn_tx, amount, amount, attestors, attest_epoch)
    }
    fn burn_reg_tx_cost(reg_proof: &str, burn_tx: &str, amount: u64, cost: u64, attestors: Vec<(String, String)>) -> qnet_state::Transaction {
        burn_reg_tx_full(&burn_node_id(), reg_proof, burn_tx, amount, cost, attestors, 1)
    }
    fn burn_reg_tx_id(node_id: &str, reg_proof: &str, burn_tx: &str, amount: u64, attestors: Vec<(String, String)>) -> qnet_state::Transaction {
        burn_reg_tx_full(node_id, reg_proof, burn_tx, amount, amount, attestors, 1)
    }
    /// Fixed test burner: the Solana address that "made" the burn plus its signing key. Deterministic
    /// so every helper below produces the same attested burn_wallet and a verifiable owner signature.
    fn burn_owner() -> (String, ed25519_dalek::SigningKey) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        (bs58::encode(sk.verifying_key().to_bytes()).into_string(), sk)
    }
    /// Beneficiary wallet for the burn tests: derived from the burner's Solana address, so the
    /// registration satisfies the beneficiary-consent rule by derivation (solana_bound).
    fn burn_beneficiary() -> String {
        crate::crypto::solana_derivation::eon_from_solana_address(&burn_owner().0)
    }
    fn burn_node_id() -> String {
        crate::rpc::generate_super_node_pseudonym(&burn_beneficiary())
    }
    fn burn_owner_sig_for(node_id: &str, wallet: &str, reg_proof: &str, ts: u64) -> String {
        burn_owner_sig_full(node_id, wallet, reg_proof, ts, &[], "")
    }
    fn burn_owner_sig_full(node_id: &str, wallet: &str, reg_proof: &str, ts: u64, root: &[u8], burn_tx: &str) -> String {
        use ed25519_dalek::Signer;
        let (_addr, sk) = burn_owner();
        let msg = qnet_state::Transaction::burn_owner_bind_message(node_id, wallet, reg_proof, ts, root, burn_tx);
        hex::encode(sk.sign(msg.as_bytes()).to_bytes())
    }
    fn burn_reg_tx_full(node_id: &str, reg_proof: &str, burn_tx: &str, amount: u64, cost: u64, attestors: Vec<(String, String)>, attest_epoch: u64) -> qnet_state::Transaction {
        let beneficiary = burn_beneficiary();
        let mut tx = qnet_state::Transaction {
            hash: String::new(), from: beneficiary.clone(), to: None, amount: 0, nonce: 0,
            gas_price: 0, gas_limit: 0, timestamp: 1000, signature: None, public_key: None,
            tx_type: qnet_state::TransactionType::NodeRegistration {
                node_id: node_id.to_string(),
                node_type: qnet_state::NodeType::Super,
                wallet_address: beneficiary.clone(),
                registration_proof: reg_proof.to_string(),
                api_endpoint: String::new(),
                burn_tx: burn_tx.to_string(),
                vrf_pk: Vec::new(),
                burn_wallet: burn_owner().0,
                burn_owner_sig: burn_owner_sig_full(node_id, &beneficiary, reg_proof, 1000, &[], burn_tx),
                burn_amount: amount,
                burn_cost: cost,
                burn_attestors: attestors,
                attest_epoch,
            },
            data: None, dilithium_signature: None, dilithium_public_key: None, chain_id: qnet_state::transaction::QNET_CHAIN_ID,
        };
        tx.hash = tx.calculate_hash();
        tx
    }

    #[tokio::test]
    async fn burn_attestation_quorum_accept_and_reject() {
        const GATE: u64 = qnet_state::feature_gates::BURN_ATTESTATION_GATE_HEIGHT;
        let (pk1, sk1) = burn_gen_genesis("genesis_node_001");
        let (pk2, sk2) = burn_gen_genesis("genesis_node_002");
        let (pk3, sk3) = burn_gen_genesis("genesis_node_003");
        let (pk4, sk4) = burn_gen_genesis("genesis_node_004");
        // On-chain PK source for the deterministic bound verifier (committee path resolves each
        // attestor's key via load_vrf_public_key, NOT the RAM registry). At height 0 the committee
        // is the genesis set; threshold = quorum_size(5) = n−f = 4.
        let _dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(_dir.path().to_str().unwrap()).expect("storage");
        storage.save_vrf_public_key("genesis_node_001", &hex::encode(&pk1)).unwrap();
        storage.save_vrf_public_key("genesis_node_002", &hex::encode(&pk2)).unwrap();
        storage.save_vrf_public_key("genesis_node_003", &hex::encode(&pk3)).unwrap();
        storage.save_vrf_public_key("genesis_node_004", &hex::encode(&pk4)).unwrap();
        let burn_tx = "solBurnSig123";
        let amount = 1500u64;
        let cost = 1500u64; // default helper sets cost==amount; the signed message must carry it
        let msg = qnet_state::Transaction::burn_attestation_message(burn_tx, &burn_owner().0, &burn_beneficiary(), amount, &qnet_state::NodeType::Super, cost, 1);
        let a1 = ("genesis_node_001".to_string(), burn_sign("genesis_node_001", &pk1, &sk1, &msg));
        let a2 = ("genesis_node_002".to_string(), burn_sign("genesis_node_002", &pk2, &sk2, &msg));
        let a3 = ("genesis_node_003".to_string(), burn_sign("genesis_node_003", &pk3, &sk3, &msg));
        let a4 = ("genesis_node_004".to_string(), burn_sign("genesis_node_004", &pk4, &sk4, &msg));

        // (1) 4 distinct valid committee sigs (n−f = quorum_size(5)) over the cost-bearing message ⇒ ACCEPT.
        let tx = burn_reg_tx("burn", burn_tx, amount, vec![a1.clone(), a2.clone(), a3.clone(), a4.clone()]);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&tx, GATE, &storage).await.is_ok(), "4-of-5 quorum at-cost must pass");

        // (2a) only 3 distinct ⇒ REJECT (below n−f=4).
        let tx2 = burn_reg_tx("burn", burn_tx, amount, vec![a1.clone(), a2.clone(), a3.clone()]);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&tx2, GATE, &storage).await.is_err(), "3/4 below quorum must reject");

        // (2b) duplicate signer must not pad the count (a1 twice + a2 + a3 = 3 distinct < 4).
        let txd = burn_reg_tx("burn", burn_tx, amount, vec![a1.clone(), a1.clone(), a2.clone(), a3.clone()]);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&txd, GATE, &storage).await.is_err(), "duplicate signer must not reach quorum");

        // (2c) a MUTATED burn field ⇒ recomputed message differs ⇒ sigs invalid ⇒ REJECT.
        let txm = burn_reg_tx("burn", burn_tx, amount + 1, vec![a1.clone(), a2.clone(), a3.clone(), a4.clone()]);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&txm, GATE, &storage).await.is_err(), "mutated amount must break the quorum");

        // (2d) a non-committee signer id is not counted (filtered before sig check) ⇒ only 3 valid ⇒ REJECT.
        let txn = burn_reg_tx("burn", burn_tx, amount, vec![a1.clone(), a2.clone(), a3.clone(), ("super_impostor".to_string(), a4.1.clone())]);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&txn, GATE, &storage).await.is_err(), "non-committee signer must not count");

        // (3) gate active from genesis (BURN_ATTESTATION_GATE_HEIGHT=0): a bare non-genesis
        // registration is REJECTED at h=0 — no Sybil-free window (genesis-exempt path is case (4)).
        let txbare = burn_reg_tx("burn", "", 0, vec![]);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&txbare, 0, &storage).await.is_err(), "non-genesis bare reg rejected from genesis");

        // (4) REAL genesis node_id exempt (protocol-minted) ⇒ ACCEPT; a non-genesis node_id claiming
        // reg_proof="genesis" MUST be rejected — no free Sybil bypass of the burn quorum.
        let txe = burn_reg_tx_id("genesis_node_001", "genesis", "", 0, vec![]);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&txe, GATE, &storage).await.is_ok(), "real genesis identity exempt");
        let txf = burn_reg_tx_id("super_impostor", "genesis", "", 0, vec![]);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&txf, GATE, &storage).await.is_err(), "non-genesis reg_proof=genesis must reject");

        // (5) missing burn_tx at the active height (the dodge) ⇒ REJECT even with valid sigs present.
        let txnoburn = burn_reg_tx("burn", "", 0, vec![a1.clone(), a2.clone(), a3.clone(), a4.clone()]);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&txnoburn, GATE, &storage).await.is_err(), "missing burn_tx must reject");

        // (6) on-chain burn→wallet uniqueness: a burn already committed-bound to a DIFFERENT wallet
        // ⇒ REJECT even with a full valid quorum (Sybil amplification under a rotating committee).
        storage.committed_burn_wallet_put(burn_tx, "super_some_other_node").unwrap();
        let txreuse = burn_reg_tx("burn", burn_tx, amount, vec![a1.clone(), a2.clone(), a3.clone(), a4.clone()]);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&txreuse, GATE, &storage).await.is_err(), "burn reused for a different wallet must reject");

        // (7) AT-COST reduced tier (e.g. burn_pct ⇒ cost 1350): a 4-of-5 quorum over the cost-bearing
        // message with burn_amount >= cost ⇒ ACCEPT. The committee attested 1350, the joiner paid 1350.
        let burn_tx7 = "solBurnSig7";
        let cost7 = 1350u64;
        let msg7 = qnet_state::Transaction::burn_attestation_message(burn_tx7, &burn_owner().0, &burn_beneficiary(), cost7, &qnet_state::NodeType::Super, cost7, 1);
        let q7: Vec<(String, String)> = vec![
            ("genesis_node_001".to_string(), burn_sign("genesis_node_001", &pk1, &sk1, &msg7)),
            ("genesis_node_002".to_string(), burn_sign("genesis_node_002", &pk2, &sk2, &msg7)),
            ("genesis_node_003".to_string(), burn_sign("genesis_node_003", &pk3, &sk3, &msg7)),
            ("genesis_node_004".to_string(), burn_sign("genesis_node_004", &pk4, &sk4, &msg7)),
        ];
        let tx7 = burn_reg_tx_cost("burn", burn_tx7, cost7, cost7, q7);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&tx7, GATE, &storage).await.is_ok(), "at-cost reduced-tier quorum must pass");

        // (8) UNDER-COST: committee attested cost=1500 but burn_amount=300 (joiner tried to pay ~300 for
        // a 1500 node). amount < burn_cost ⇒ REJECT even though all 4 sigs over the message are valid —
        // closes the core Sybil hole (a cheap burn buying a full node).
        let burn_tx8 = "solBurnSig8";
        let cost8 = 1500u64;
        let under = 300u64;
        let msg8 = qnet_state::Transaction::burn_attestation_message(burn_tx8, &burn_owner().0, &burn_beneficiary(), under, &qnet_state::NodeType::Super, cost8, 1);
        let q8: Vec<(String, String)> = vec![
            ("genesis_node_001".to_string(), burn_sign("genesis_node_001", &pk1, &sk1, &msg8)),
            ("genesis_node_002".to_string(), burn_sign("genesis_node_002", &pk2, &sk2, &msg8)),
            ("genesis_node_003".to_string(), burn_sign("genesis_node_003", &pk3, &sk3, &msg8)),
            ("genesis_node_004".to_string(), burn_sign("genesis_node_004", &pk4, &sk4, &msg8)),
        ];
        let tx8 = burn_reg_tx_cost("burn", burn_tx8, under, cost8, q8);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&tx8, GATE, &storage).await.is_err(), "under-cost burn must reject (amount < attested cost)");

        // (9) M-5 transition (no downgrade-strand): a genesis-era attestation (attest_epoch=2) whose reg
        // lands in EARLY post-genesis (apply height 210 ⇒ epoch 3) MUST still ACCEPT — the committee is
        // genesis-derived there, the ≤2-epoch recency window covers it, and there is no downgrade guard to
        // permanently reject a legit genesis-era-armed registration (would strand the on-Solana burn).
        let burn_tx9 = "solBurnSig9";
        let msg9 = qnet_state::Transaction::burn_attestation_message(burn_tx9, &burn_owner().0, &burn_beneficiary(), amount, &qnet_state::NodeType::Super, amount, 2);
        let q9: Vec<(String, String)> = vec![
            ("genesis_node_001".to_string(), burn_sign("genesis_node_001", &pk1, &sk1, &msg9)),
            ("genesis_node_002".to_string(), burn_sign("genesis_node_002", &pk2, &sk2, &msg9)),
            ("genesis_node_003".to_string(), burn_sign("genesis_node_003", &pk3, &sk3, &msg9)),
            ("genesis_node_004".to_string(), burn_sign("genesis_node_004", &pk4, &sk4, &msg9)),
        ];
        let tx9 = burn_reg_tx_epoch("burn", burn_tx9, amount, q9, 2);
        assert!(BlockchainNode::verify_burn_attestation_quorum(&tx9, 210, &storage).await.is_ok(),
            "genesis-era attestation landing in early post-genesis must accept (no downgrade-strand)");

        // (10) BURN THEFT: an attacker replays a public burn (+ its real quorum) naming its OWN wallet
        // as beneficiary. The burner never signed that beneficiary ⇒ REJECT. Also covers the mirror
        // case (squatting a victim's wallet): both fail the same owner-signature check.
        let burn_tx10 = "solBurnSig10";
        let stolen = qnet_state::Transaction::burn_attestation_message(
            burn_tx10, &burn_owner().0, "walletThief", amount, &qnet_state::NodeType::Super, amount, 1);
        let q10: Vec<(String, String)> = vec![
            ("genesis_node_001".to_string(), burn_sign("genesis_node_001", &pk1, &sk1, &stolen)),
            ("genesis_node_002".to_string(), burn_sign("genesis_node_002", &pk2, &sk2, &stolen)),
            ("genesis_node_003".to_string(), burn_sign("genesis_node_003", &pk3, &sk3, &stolen)),
            ("genesis_node_004".to_string(), burn_sign("genesis_node_004", &pk4, &sk4, &stolen)),
        ];
        let mut tx10 = burn_reg_tx("burn", burn_tx10, amount, q10);
        if let qnet_state::TransactionType::NodeRegistration { wallet_address, .. } = &mut tx10.tx_type {
            *wallet_address = "walletThief".to_string();
        }
        assert!(BlockchainNode::verify_burn_attestation_quorum(&tx10, GATE, &storage).await.is_err(),
            "a burn cannot activate a beneficiary its owner never signed");

        // (11) an absent owner signature is not a bypass, and a signature over a DIFFERENT beneficiary
        // does not transfer: both REJECT with an otherwise-perfect quorum.
        let burn_tx11 = "solBurnSig11";
        let msg11 = qnet_state::Transaction::burn_attestation_message(
            burn_tx11, &burn_owner().0, &burn_beneficiary(), amount, &qnet_state::NodeType::Super, amount, 1);
        let q11: Vec<(String, String)> = vec![
            ("genesis_node_001".to_string(), burn_sign("genesis_node_001", &pk1, &sk1, &msg11)),
            ("genesis_node_002".to_string(), burn_sign("genesis_node_002", &pk2, &sk2, &msg11)),
            ("genesis_node_003".to_string(), burn_sign("genesis_node_003", &pk3, &sk3, &msg11)),
            ("genesis_node_004".to_string(), burn_sign("genesis_node_004", &pk4, &sk4, &msg11)),
        ];
        let mut tx11 = burn_reg_tx("burn", burn_tx11, amount, q11.clone());
        if let qnet_state::TransactionType::NodeRegistration { burn_owner_sig, .. } = &mut tx11.tx_type {
            burn_owner_sig.clear();
        }
        assert!(BlockchainNode::verify_burn_attestation_quorum(&tx11, GATE, &storage).await.is_err(),
            "missing burn_owner_sig must reject");
        let mut tx11b = burn_reg_tx("burn", burn_tx11, amount, q11);
        if let qnet_state::TransactionType::NodeRegistration { burn_owner_sig, .. } = &mut tx11b.tx_type {
            *burn_owner_sig = burn_owner_sig_for(&burn_node_id(), "walletOther", "burn", 1000);
        }
        assert!(BlockchainNode::verify_burn_attestation_quorum(&tx11b, GATE, &storage).await.is_err(),
            "owner sig over a different beneficiary must not transfer");
    }

    // The ban that decides roster membership is read from state_root-certified account data, and the
    // field is write-once monotone — so the answer for a PAST window must be exact even when read at a
    // later tip. Both directions get a case, because getting either wrong splits epoch_commitment.
    #[tokio::test]
    async fn ban_is_read_from_state_and_bounded_by_the_window() {
        let _dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(_dir.path().to_str().unwrap()).expect("storage");
        let mut banned_early = qnet_state::Account::new("super_banned_early".to_string());
        banned_early.banned_at_height = 100;          // inside window 2 (head = 180)
        let mut banned_late = qnet_state::Account::new("super_banned_late".to_string());
        banned_late.banned_at_height = 5_000;         // long after window 2
        let clean = qnet_state::Account::new("super_clean".to_string());
        storage.persist_accounts_batch(
            vec![(banned_early.address.clone(), banned_early.clone()),
                 (banned_late.address.clone(), banned_late.clone()),
                 (clean.address.clone(), clean.clone())],
            Vec::new()).await.expect("persist accounts");
        let ids: Vec<String> = vec!["super_banned_early".into(), "super_banned_late".into(), "super_clean".into()];

        let st = qnet_state::State::new();
        let rep = BlockchainNode::compute_consensus_reputation_map(&storage, &ids, 2, &st).await;
        assert_eq!(rep.get("super_banned_early").copied(), Some(0.0),
            "a ban at or below the window head must zero reputation");
        assert_ne!(rep.get("super_banned_late").copied(), Some(0.0),
            "a ban ABOVE the window head must not apply retroactively to an earlier window");
        assert_ne!(rep.get("super_clean").copied(), Some(0.0));

        // The same account read at a much later window DOES count — write-once means the field keeps
        // answering the as-of question for every window at or after the ban.
        let later = BlockchainNode::compute_consensus_reputation_map(&storage, &ids, 100, &st).await;
        assert_eq!(later.get("super_banned_early").copied(), Some(0.0));
        assert_eq!(later.get("super_banned_late").copied(), Some(0.0),
            "window head 9000 > 5000 ⇒ now banned");

        // Re-admission must honour it too: phase2a never sees the reputation map for a node that is not
        // a consensus participant, so it has to read the ban itself.
        let registered: std::collections::HashSet<String> =
            ids.iter().cloned().collect();
        let recent: std::collections::HashSet<String> = ids.iter().cloned().collect();
        for id in &ids {
            storage.save_node_registration_at_height_burn_vrf(id, "super", "w", 1.0, 1, "", None).unwrap();
        }
        let empty_rep: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
        let added = super::phase2a_eligible_additions(
            &st, &storage, &registered, &recent, &std::collections::HashSet::new(), &empty_rep, 9_000, 7000);
        let added_ids: Vec<&str> = added.iter().map(|p| p.node_id.as_str()).collect();
        assert!(!added_ids.contains(&"super_banned_early"), "a proven equivocator must never be re-admitted");
        assert!(!added_ids.contains(&"super_banned_late"), "same, for a ban below the scan end");
        assert!(added_ids.contains(&"super_clean"), "a clean registered super must still be admitted");
    }

    // An abstaining node must FOLLOW the chain, not reject it. Empty means "I could not derive the
    // roster"; if that reached the expectation cache, every incoming block would mismatch and the node
    // would hard-reject the whole chain. This is what made abstention unusable and forced the
    // roster-substituting walk-back that was the fork surface.
    #[test]
    fn empty_producer_is_never_cached_as_an_expectation() {
        crate::node::clear_expected_producer_cache_above(0);
        crate::node::cache_expected_producer(4242, "super_real", 7);
        assert_eq!(crate::node::get_expected_producer(4242), Some(("super_real".to_string(), 7)));
        // Abstention must CLEAR the expectation, not overwrite it with "".
        crate::node::cache_expected_producer(4242, "", 8);
        assert_eq!(crate::node::get_expected_producer(4242), None,
            "an abstaining node must fall to the soft path, never to a hard reject");
        crate::node::cache_expected_producer(4243, "", 1);
        assert_eq!(crate::node::get_expected_producer(4243), None);
        crate::node::clear_expected_producer_cache_above(0);
    }

    // The producer roster feeds epoch_commitment and thence a QC, so it must be a function of the
    // HEIGHT, never of how far this node happens to have applied. Pinned here because roster divergence
    // is this codebase's documented cause of finality stalls.
    #[test]
    fn super_roster_is_bounded_by_height() {
        let _dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(_dir.path().to_str().unwrap()).expect("storage");
        for (id, h) in [("super_a", 10u64), ("super_b", 500), ("super_c", 5000)] {
            storage.save_node_registration_at_height_burn_vrf(id, "super", &format!("w_{}", id), 1.0, h, "", None).unwrap();
        }
        let ids = |h: u64| {
            let mut v: Vec<String> = storage.super_registrations_as_of(h).unwrap()
                .into_iter().map(|(id, _)| id).collect();
            v.sort();
            v
        };
        assert_eq!(ids(0), Vec::<String>::new(), "nothing is confirmed at height 0");
        assert_eq!(ids(10), vec!["super_a"], "inclusive at the registration height");
        assert_eq!(ids(499), vec!["super_a"], "a later registration is not visible earlier");
        assert_eq!(ids(500), vec!["super_a", "super_b"]);
        assert_eq!(ids(1_000_000), vec!["super_a", "super_b", "super_c"]);
        // The unbounded twin returns everything applied, which is exactly why it must not feed consensus.
        let mut unbounded: Vec<String> = storage.super_registrations_sorted().unwrap()
            .into_iter().map(|(id, _)| id).collect();
        unbounded.sort();
        assert_eq!(unbounded.len(), 3);
        assert_ne!(unbounded, ids(499), "the unbounded pool is a superset of the height-bounded one");
    }

    // The registration identity rules, pinned. Each one alone is enough to permanently occupy a
    // victim's derivable node_id or to hand a relayer control of a node's consensus key, so each gets
    // an explicit regression.
    #[tokio::test]
    async fn registration_identity_rules() {
        const GATE: u64 = qnet_state::feature_gates::BURN_ATTESTATION_GATE_HEIGHT;
        let _dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(_dir.path().to_str().unwrap()).expect("storage");

        // node_id MUST be the wallet pseudonym: a burn cannot activate an id derived from a wallet
        // other than the one it names (anti-squat), and the rule is height-independent.
        let mut squat = burn_reg_tx("burn", "solBurnSquat", 1500, vec![]);
        if let qnet_state::TransactionType::NodeRegistration { node_id, .. } = &mut squat.tx_type {
            *node_id = "super_someone_elses_id".to_string();
        }
        assert!(BlockchainNode::verify_burn_attestation_quorum(&squat, GATE, &storage).await.is_err(),
            "node_id that is not the wallet pseudonym must reject");
        assert!(!BlockchainNode::registration_identity_bound(
            "super_someone_elses_id", &qnet_state::NodeType::Super, &burn_beneficiary(), "burn"));
        assert!(BlockchainNode::registration_identity_bound(
            &burn_node_id(), &qnet_state::NodeType::Super, &burn_beneficiary(), "burn"));
        // Genesis identities are protocol-minted and exempt; a non-genesis id claiming the exemption is not.
        assert!(BlockchainNode::registration_identity_bound(
            "genesis_node_001", &qnet_state::NodeType::Super, "any_wallet", "genesis"));
        assert!(!BlockchainNode::registration_identity_bound(
            "super_impostor", &qnet_state::NodeType::Super, "any_wallet", "genesis"));

        // The consensus key lives in the HASHED body, so a relayer cannot swap it silently: any edit
        // invalidates the TX hash. This is what stops an identity takeover mid-flight.
        let mut tx = burn_reg_tx("burn", "solBurnVrf", 1500, vec![]);
        let h0 = tx.hash.clone();
        if let qnet_state::TransactionType::NodeRegistration { vrf_pk, .. } = &mut tx.tx_type {
            *vrf_pk = vec![7u8; 1952];
        }
        assert_ne!(tx.calculate_hash(), h0, "vrf_pk must be inside the TX hash preimage");

        // Beneficiary consent: a valid burn + a valid owner signature still cannot name a wallet the
        // registrant does not control (neither wallet-key-derived nor burner-derived).
        let mut foreign = burn_reg_tx("burn", "solBurnForeign", 1500, vec![]);
        if let qnet_state::TransactionType::NodeRegistration { wallet_address, node_id, burn_owner_sig, .. } = &mut foreign.tx_type {
            *wallet_address = "walletNotMine".to_string();
            *node_id = crate::rpc::generate_super_node_pseudonym("walletNotMine");
            *burn_owner_sig = burn_owner_sig_for(node_id, "walletNotMine", "burn", 1000);
        }
        assert!(BlockchainNode::verify_burn_attestation_quorum(&foreign, GATE, &storage).await.is_err(),
            "a burn cannot name a beneficiary the registrant does not control");
    }

    // The heartbeat carries a RAW detached signature and no key. Its authenticity therefore rests
    // entirely on resolving the signer's COMMITTED consensus key, so each way that resolution can be
    // wrong gets a case.
    #[test]
    fn heartbeat_verifies_against_the_committed_key_only() {
        use pqcrypto_mldsa::mldsa65 as d3;
        use pqcrypto_traits::sign::{DetachedSignature as SigT, PublicKey as PkT, SecretKey as SkT};
        let _dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(_dir.path().to_str().unwrap()).expect("storage");
        let node_id = "super_hb_kat";
        let (pk, sk) = d3::keypair();
        storage.save_vrf_public_key(node_id, &hex::encode(PkT::as_bytes(&pk))).unwrap();
        // The verdict keys on the CANONICAL registry row's commitment, so the identity must be
        // registered on chain, not merely present in the standalone key row.
        storage.save_node_registration_at_height_burn_vrf(
            node_id, "super", "walletHB", 1.0, 1, "", Some(PkT::as_bytes(&pk))).unwrap();

        let mk = |signer: &d3::SecretKey, anchor_hash: &str| {
            let mut tx = qnet_state::Transaction {
                from: node_id.to_string(), to: None, amount: 0,
                tx_type: qnet_state::TransactionType::Heartbeat {
                    node_id: node_id.to_string(), anchor_height: 100,
                    anchor_hash: anchor_hash.to_string(),
                },
                timestamp: 1_700_000_000, hash: String::new(), signature: None, public_key: None,
                gas_price: u64::MAX, gas_limit: 0, nonce: 1, data: None,
                dilithium_signature: None,
                dilithium_public_key: Some(node_id.to_string().into_bytes()),
                chain_id: qnet_state::transaction::QNET_CHAIN_ID,
            };
            let msg = BlockchainNode::build_canonical_verify_message(&tx);
            tx.dilithium_signature = Some(SigT::as_bytes(&d3::detached_sign(msg.as_bytes(), signer)).to_vec());
            tx.hash = tx.calculate_hash();
            tx
        };

        let good = mk(&sk, "abc");
        assert_eq!(good.dilithium_signature.as_ref().map(|s| s.len()), Some(3309), "raw detached, no key rides along");
        assert!(BlockchainNode::verify_heartbeat_dilithium(&good, &storage), "committed key must verify");

        // Signed by a key the chain never committed for this id.
        let (_opk, osk) = d3::keypair();
        assert!(!BlockchainNode::verify_heartbeat_dilithium(&mk(&osk, "abc"), &storage),
            "a foreign key must not verify");

        // Message tamper: the anchor is inside the signed preimage.
        let mut tampered = good.clone();
        if let qnet_state::TransactionType::Heartbeat { anchor_hash, .. } = &mut tampered.tx_type {
            *anchor_hash = "xyz".to_string();
        }
        assert!(!BlockchainNode::verify_heartbeat_dilithium(&tampered, &storage),
            "a rewritten anchor must break the signature");

        // A key that resolves locally but is NOT the one the canonical row commits must reject: that row
        // is pruned on reorg, the standalone one is not.
        let (fpk, _fsk) = d3::keypair();
        storage.save_vrf_public_key("super_hb_stale", &hex::encode(PkT::as_bytes(&fpk))).unwrap();
        let mut stale = good.clone();
        if let qnet_state::TransactionType::Heartbeat { node_id, .. } = &mut stale.tx_type {
            *node_id = "super_hb_stale".to_string();
        }
        assert!(!BlockchainNode::verify_heartbeat_dilithium(&stale, &storage),
            "a key with no canonical registry commitment must reject");

        // Unknown identity resolves no key ⇒ reject, never a pass.
        let mut unknown = good.clone();
        if let qnet_state::TransactionType::Heartbeat { node_id, .. } = &mut unknown.tx_type {
            *node_id = "super_never_registered".to_string();
        }
        assert!(!BlockchainNode::verify_heartbeat_dilithium(&unknown, &storage),
            "an unresolvable identity must reject");
    }

    // The burner authorizes a SPECIFIC beneficiary, attestation root and burn. Each field dropped from
    // that message was a real hole, so each gets a case.
    #[test]
    fn burn_owner_message_binds_root_and_burn() {
        let m = |root: &[u8], burn: &str| qnet_state::Transaction::burn_owner_bind_message(
            "nid", "wallet", "proof", 1000, root, burn);
        let base = m(&[1u8; 32], "burnA");
        assert_eq!(base, m(&[1u8; 32], "burnA"), "deterministic");
        assert_ne!(base, m(&[2u8; 32], "burnA"), "attestation root is bound");
        assert_ne!(base, m(&[1u8; 32], "burnB"), "burn_tx is bound");
        assert_ne!(base, m(&[], "burnA"), "an absent root is distinct from a present one");
        assert_eq!(qnet_state::Transaction::attest_root_tag(&[]), "", "no root ⇒ empty tag");
        assert_eq!(qnet_state::Transaction::attest_root_tag(&[1u8; 32]).len(), 64, "sha3-256 hex");
    }

    // Unbounded wire fields reach base58/hex decoders on the unauthenticated gossip path, and base58
    // decode is quadratic. validate() is the bound, so it must reject before anything decodes.
    #[test]
    fn registration_fields_are_length_bounded() {
        let mut tx = burn_reg_tx("burn", "solBurnLen", 1500, vec![]);
        if let qnet_state::TransactionType::NodeRegistration { burn_wallet, .. } = &mut tx.tx_type {
            *burn_wallet = "1".repeat(200_000);
        }
        tx.hash = tx.calculate_hash();
        assert!(tx.validate().is_err(), "oversized burn_wallet must be rejected before any decode");

        let mut tx2 = burn_reg_tx("burn", "solBurnLen2", 1500, vec![]);
        if let qnet_state::TransactionType::NodeRegistration { burn_owner_sig, .. } = &mut tx2.tx_type {
            *burn_owner_sig = "a".repeat(100_000);
        }
        tx2.hash = tx2.calculate_hash();
        assert!(tx2.validate().is_err(), "oversized burn_owner_sig must be rejected");

        // A well-formed registration still validates.
        let ok = burn_reg_tx("burn", "solBurnLen3", 1500, vec![]);
        assert!(ok.validate().is_ok(), "a well-formed registration must still validate");
    }

    // Fork-fix coverage: at a POST-genesis height with no locally-readable N-2 macroblock, verify
    // MUST reject (node behind ⇒ resync), NEVER fall back to the genesis set — otherwise a lagging
    // node accepts against 5-genesis while synced nodes validate against the real committee → fork.
    // A full valid 4-of-5 genesis quorum (which WOULD pass under the buggy genesis-fallback) is used
    // to prove the rejection is due to the missing committee, not a weak quorum.
    #[tokio::test]
    async fn burn_attestation_post_genesis_without_committee_rejects() {
        let (pk1, sk1) = burn_gen_genesis("genesis_node_001");
        let (pk2, sk2) = burn_gen_genesis("genesis_node_002");
        let (pk3, sk3) = burn_gen_genesis("genesis_node_003");
        let (pk4, sk4) = burn_gen_genesis("genesis_node_004");
        let _dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(_dir.path().to_str().unwrap()).expect("storage");
        storage.save_vrf_public_key("genesis_node_001", &hex::encode(&pk1)).unwrap();
        storage.save_vrf_public_key("genesis_node_002", &hex::encode(&pk2)).unwrap();
        storage.save_vrf_public_key("genesis_node_003", &hex::encode(&pk3)).unwrap();
        storage.save_vrf_public_key("genesis_node_004", &hex::encode(&pk4)).unwrap();
        let burn_tx = "solBurnSigPG";
        let amount = 1500u64;
        let msg = qnet_state::Transaction::burn_attestation_message(burn_tx, &burn_owner().0, &burn_beneficiary(), amount, &qnet_state::NodeType::Super, amount, 4);
        let attest = vec![
            ("genesis_node_001".to_string(), burn_sign("genesis_node_001", &pk1, &sk1, &msg)),
            ("genesis_node_002".to_string(), burn_sign("genesis_node_002", &pk2, &sk2, &msg)),
            ("genesis_node_003".to_string(), burn_sign("genesis_node_003", &pk3, &sk3, &msg)),
            ("genesis_node_004".to_string(), burn_sign("genesis_node_004", &pk4, &sk4, &msg)),
        ];
        let tx = burn_reg_tx_epoch("burn", burn_tx, amount, attest, 4);
        // height 300 ⇒ epoch 4; attest_epoch=4 ⇒ N-2 = macroblock idx 2, ABSENT in this fresh storage ⇒
        // committee None, post-genesis ⇒ MUST reject (not genesis-fallback-accept).
        assert!(BlockchainNode::verify_burn_attestation_quorum(&tx, 300, &storage).await.is_err(),
            "post-genesis without N-2 committee must REJECT, not fall back to the genesis set");
    }
}

// Regression tests pinning get_certified_rotation_round determinism: it
// MUST be a pure function of HIGHEST_CERTIFIED_ROUND (2f+1 only, NEVER
// adopted) + the per-mb baseline — no clock, no read-path atomics —
// saturating on certified-baseline and monotonic, so a regression can't
// reintroduce a clock-derived or f+1-adopted rotation source (h=556).
#[cfg(test)]
mod tests_v23_rotation_round {
    // No `use super::*` — tests reference `crate::unified_p2p::*` fully
    // qualified so all rotation-state mutations go through the canonical
    // public API (no parent-module shortcut that could mask incorrect
    // visibility regressions).

    /// Healthy fresh macroblock: no timeout votes seen, no baseline
    /// recorded. `get_certified_rotation_round` MUST return 0 — primary
    /// VRF leader at round 0 is selected.
    #[test]
    fn round_zero_on_fresh_macroblock() {
        let mb_idx: u64 = 1_000_001;
        // Without any state mutations, certified=0, baseline=0
        // → certified rotation round = 0.
        assert_eq!(crate::unified_p2p::get_certified_rotation_round(mb_idx), 0);
    }

    /// Saturating subtraction defends against finalisation ordering
    /// races — if `record_finalized_round` records a baseline equal to
    /// (or transiently greater than) the live certified round, the
    /// function MUST saturate to 0, not wrap.
    #[test]
    fn round_saturates_when_baseline_exceeds_live() {
        let mb_idx: u64 = 1_000_002;
        // Record a baseline of 5 with no live round movement — certified=0,
        // baseline=5, saturating_sub yields 0.
        crate::unified_p2p::record_finalized_round(mb_idx, 5);
        assert_eq!(crate::unified_p2p::get_certified_rotation_round(mb_idx), 0);
    }

    /// Leader rotation `(round0_idx + timeout_round) % N` is a PERMUTATION of 0..N for every base
    /// index — so as the n−f-certified timeout_round increments, every candidate is visited and an
    /// honest producer is reached within f+1 rounds (the classical BFT bound; no reputation). Guards
    /// the round-robin coverage the liveness argument relies on.
    #[test]
    fn rotation_visits_every_candidate() {
        for n in 2usize..=12 {
            for r0 in 0..n {
                let seen: std::collections::BTreeSet<usize> = (0..n).map(|t| (r0 + t) % n).collect();
                assert_eq!(seen, (0..n).collect::<std::collections::BTreeSet<usize>>(),
                           "rotation must be a permutation of 0..{} (r0={})", n, r0);
            }
        }
    }
}

/// Regression guard for the production ceiling (production_throttle_reason). A1 removed the finality
/// clause: production must NOT stop because the QC layer stopped, only when the roster derivation can no
/// longer reach a sealed anchor. Pure function of committed scalars, so every node pauses at the same
/// height.
#[cfg(test)]
mod tests_production_throttle {
    use super::{production_throttle_reason, BlockchainNode};

    const HORIZON: u64 = (BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64) * 90;

    #[test]
    fn finality_alone_never_throttles() {
        // The whole point of A1: a frozen finality marker with a live seal base must not pause anyone.
        let f: u64 = 33_390;
        for next in [f + 1, f + 90, f + 91, f + 1_000, f + 100_000] {
            assert_eq!(production_throttle_reason(next, f, 0), None,
                "finality lag alone must never stop production (h={})", next);
        }
    }

    #[test]
    fn derivation_horizon_is_the_only_ceiling() {
        let s: u64 = 33_480;
        assert_eq!(production_throttle_reason(s + HORIZON, 0, s), None, "open through the horizon");
        assert_eq!(production_throttle_reason(s + HORIZON + 1, 0, s), Some("roster_derivation_horizon"),
            "closed one block past it");
        // A stale finality marker does not change the verdict in either direction.
        assert_eq!(production_throttle_reason(s + HORIZON, 1, s), None);
        assert_eq!(production_throttle_reason(s + HORIZON + 1, 1, s), Some("roster_derivation_horizon"));
    }

    #[test]
    fn the_horizon_is_far_past_the_old_finality_wall() {
        // The old ceiling was last_finalized + 90 and the structural wall was seal + 180. Both are now
        // well inside the window production can run.
        assert!(HORIZON > 180, "horizon {} must exceed the old (S+2)*90 structural wall", HORIZON);
    }

    #[test]
    fn zero_bases_never_throttle() {
        assert_eq!(production_throttle_reason(1_000_000, 0, 0), None);
    }
}

#[cfg(test)]
mod tests_vote_detector_retention {
    use super::*;
    use qnet_consensus::checkpoint_bft::Checkpoint;

    fn cp_at(index: u64, state: u8) -> Checkpoint {
        Checkpoint {
            index, parent_qc: None, window_head_height: index * 90,
            window_mb_hashes: vec![[state; 32]], state_root: [state; 32],
            beacon: [0u8; 32], epoch_commitment: [0u8; 32], reward_root: [0u8; 32],
            registry_root: [0u8; 32], dilithium_pk_root: [0u8; 32], reward_epoch_root: [0u8; 32],
            logs_root: [0u8; 32], total_supply: 0, timestamp: 0,
            proposer: "det_leader".into(), proposer_sig: Vec::new(), recovery_anchor: None,
        }
    }

    fn cache(cp: &Checkpoint) -> [u8; 32] {
        let h = cp.hash();
        observe_checkpoint_proposal(cp.index, h, bincode::serialize(cp).expect("serialize"));
        h
    }

    /// Detection runs over the full window on 32-byte hashes; the ~7 KB wire signature lives in a far
    /// shorter window, and the sweep is driven by a watermark so it fires on any advancing index —
    /// not only on multiples of 64, which a view jump or a crawling halt can step over entirely.
    #[test]
    fn detector_keeps_detecting_after_the_proof_signature_ages_out() {
        let base: u64 = 1_000_000; // base % 64 == 0
        let (a, b) = (cp_at(base, 1), cp_at(base, 2));
        let (ha, hb) = (cache(&a), cache(&b));

        // Both votes inside VOTE_SIG_WINDOW ⇒ a full proof is built.
        observe_checkpoint_vote(base, "det_provable", ha, vec![9u8; 64]);
        observe_checkpoint_vote(base, "det_provable", hb, vec![8u8; 64]);
        assert!(vote_evidence_held_for("det_provable"), "same-round double vote must convict");

        // A second offence by the same offender adds no second entry — the ban is write-once, and
        // without this an equivocator repeating every round grows the pending map for a whole halt.
        let before = VOTE_EQUIVOCATION_EVIDENCE.len();
        let (c, d) = (cp_at(base + 1, 3), cp_at(base + 1, 4));
        let (hc, hd) = (cache(&c), cache(&d));
        observe_checkpoint_vote(base + 1, "det_provable", hc, vec![7u8; 64]);
        observe_checkpoint_vote(base + 1, "det_provable", hd, vec![6u8; 64]);
        assert_eq!(VOTE_EQUIVOCATION_EVIDENCE.len(), before, "one proof per offender");

        // Now age the signature out. `far` is NOT a multiple of 64: under the old `index % 64 == 0`
        // rule no sweep would ever have run here.
        let round = base + 1000;
        let (e, f) = (cp_at(round, 5), cp_at(round, 6));
        let (he, hf) = (cache(&e), cache(&f));
        observe_checkpoint_vote(round, "det_unprovable", he, vec![5u8; 64]);
        let far = round + VOTE_SWEEP_STEP + 40;
        assert_ne!(far % VOTE_SWEEP_STEP, 0, "the sweep must not depend on the index modulus");
        observe_checkpoint_vote(far, "det_other", [0xAB; 32], vec![4u8; 64]);

        let key = (round, "det_unprovable".to_string());
        assert!(VOTE_FIRST_SEEN.contains_key(&key), "detection state survives the whole detect window");
        assert!(!VOTE_FIRST_SIG.contains_key(&key), "the signature is evicted after VOTE_SIG_WINDOW");

        // The conflict is still SEEN; it simply cannot be proven, and says so.
        observe_checkpoint_vote(round, "det_unprovable", hf, vec![3u8; 64]);
        assert!(!vote_evidence_held_for("det_unprovable"), "no proof without the first signature");
        assert!(VOTE_FIRST_SEEN.contains_key(&key), "detection state is not consumed by the miss");
    }
}

#[cfg(test)]
mod tests_production_predicate {
    use super::*;

    /// The right to produce must not read peer state. A network-observation term here is identical
    /// on every member of a connected mesh, so failing closed on it stops the whole cluster at once
    /// — which is exactly what froze five genesis nodes at height 11 for 33 hours.
    #[test]
    fn production_local_precondition_reads_no_peer_state() {
        let src = &node_sources();
        let start = src.find("pub(crate) fn production_local_precondition(")
            .expect("production_local_precondition must exist");
        let body = &src[start..start + 1600];
        let end = body.find("
}
").expect("function body must terminate");
        let body = &body[..end];
        for forbidden in [
            "fresh_in_set_peer_heights",
            "get_validated_active_peers",
            "peer_count",
            "BEST_PEER_HEIGHT",
            "get_max_peer_height",
        ] {
            assert!(
                !body.contains(forbidden),
                "production_local_precondition must not read `{}` — the right to produce is local",
                forbidden
            );
        }
    }

    /// `node_sources()` lists its files as literals, because include_str! takes no glob. A module
    /// added without a matching entry would silently stop being covered by every source-scanning
    /// invariant in this file — the same "it compiles, so nobody notices" shape those tests exist to
    /// catch. Read the directory at run time and compare.
    #[test]
    fn node_sources_covers_every_module_file() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/node");
        let listed = crate::node::node_sources_manifest();
        let mut missing: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&dir).expect("src/node must be readable") {
            let name = entry.expect("dir entry").file_name().to_string_lossy().into_owned();
            if name.ends_with(".rs") && !listed.contains(&name.as_str()) {
                missing.push(name);
            }
        }
        assert!(missing.is_empty(),
                "node_sources() does not include {:?} — source-scanning tests would skip it", missing);
    }

    /// The corroboration gate is gone and must not come back under any name: a fail-closed
    /// precondition on peer observation cannot distinguish isolation from a dead channel.
    #[test]
    fn corroboration_gate_is_not_reintroduced() {
        let src = &node_sources();
        // Needles are split so this test's own source does not match them.
        assert!(
            !src.contains(concat!("CORROBORATION_", "BOOTSTRAP_FLOOR")),
            "the corroboration production gate was removed deliberately"
        );
        assert!(
            !src.contains(concat!("reason=no_", "corroboration")),
            "production must never block on absent peer corroboration"
        );
    }
}

// ============================================================================
// BLOCK PROCESSING PIPELINE — Staged Architecture
// ============================================================================
//
// Replaces the monolithic process_received_blocks() (~1200 lines) with
// a staged pipeline where each stage is an independent async task:
//
//   Ingest → Decode → Verify → Apply → Notify
//   ↓ bad    ↓ bad    ↓ bad
//   drop     drop     drop
//
// Key properties:
//   1. One bad block does NOT stall the pipeline (dropped at its stage)
//   2. Each stage has bounded channels — backpressure, not OOM
//   3. Stages are independently testable
//   4. Clear metrics per stage (queued, processed, dropped)
//
// Scalability:
//   - Verify stage can be parallelized (N workers) for thousands of nodes
//   - Apply stage is sequential (single RocksDB writer) — correct by design
//   - Bounded channels protect memory under load from malicious peers
//
// Apply stage performs ALL side effects:
//   - State snapshot + rollback on mismatch
//   - apply_block_to_state (rewards, emissions, registrations)
//   - State root verification
//   - VRF key extraction from NodeRegistration TXs
//   - Deferred side effects (pool3, registrations, emissions, reward clears)
//   - Block attestation broadcasting
//   - Height updates (RAM + RocksDB + atomic)
//   - Block event broadcasting
//   - Coordinator notification
// ============================================================================

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio::sync::RwLock;

use crate::storage::Storage;
use crate::consensus_state::{CoordinatorHandle, ConsensusEvent};
use crate::node::{is_info, is_warn, is_debug, BlockchainNode};
use crate::unified_p2p::SimplifiedP2P;
use qnet_consensus::lazy_rewards::PhaseAwareRewardManager;

// ============================================================================
// v14.7.2: FORK RECOVERY SIGNAL (macroblock-divergence only)
// ============================================================================
// Peer-counting heuristics (FORK_BREAK_PEER_THRESHOLD, HASH_CHAIN_BREAK_TRACKER,
// per-peer hash_chain_break aggregation) have been removed. They were
// Byzantine-unsafe at scale: f+1 peers bounded by [3,20] is not a canonical
// BFT threshold, and the "distinct peers" counter is trivially gamed by
// a single attacker spawning sockets.
//
// Canonical fork detection now lives at the macroblock layer:
//   - Every 90-block boundary runs 2f+1 commit/reveal consensus on the
//     finalized macroblock. Divergence there = confirmed Byzantine fork.
//   - Until then, invalid blocks are rejected and the node waits for the
//     canonical macroblock consensus to resolve.
// ============================================================================

/// Global fork recovery signal: fork_height (0 = no signal).
/// Set by the macroblock-divergence detector OR by the v16.2 observer-based
/// 2f+1 BlockRejection aggregator (`unified_p2p::handle BlockRejection`);
/// consumed by the main consensus loop. Public so the cross-module rejection
/// aggregator can raise the signal directly without going through a separate
/// IPC channel.
pub static FORK_RECOVERY_HEIGHT: AtomicU64 = AtomicU64::new(0);

/// Check and consume fork recovery signal.
/// Returns Some(fork_height) if recovery is needed.
pub fn take_fork_recovery_signal() -> Option<u64> {
    let h = FORK_RECOVERY_HEIGHT.swap(0, Ordering::SeqCst);
    if h > 0 {
        // Clear the accumulated witnesses once a recovery is scheduled —
        // otherwise stale entries would re-fire the signal on the next
        // height that rolls through the pipeline.
        HASH_CHAIN_BREAK_WITNESSES.clear();
        Some(h)
    } else {
        None
    }
}

// ============================================================================
// v14.8.7: DISTINCT-PEER WITNESS TRACKER for microblock minority-fork detection.
// ============================================================================
// Keyed by height; value is the set of distinct peer_ids that reported a
// `hash_chain_break` at that height. The threshold for DETECTION is f+1
// (not 2f+1 which is the threshold for COMMIT decisions). Rationale:
//
//   * 2f+1 is required when we want to COMMIT a decision — only a Byzantine
//     supermajority can outvote any colluding f. Using 2f+1 for a rollback
//     trigger was a v14.8.5 mistake: it requires MORE honest witnesses
//     than actually exist when the local node is on the minority fork.
//     Observed: when n=5 and one node is on a minority 1-node fork, only
//     2 distinct honest peers report the break; 2f+1=3 never trips; the
//     node stays stuck forever.
//   * f+1 is correct for DETECTION because it is the "at least one honest"
//     threshold: any set of f+1 distinct peers contains at least one
//     honest validator. Since each witness is a Dilithium3-authenticated
//     peer_id bound to a registered validator public key (not a socket),
//     an attacker cannot inflate the witness count with Sybils; they
//     would need f+1 distinct validator keys to trigger a false positive,
//     which by definition is outside the Byzantine fault model (adversary
//     controls ≤ f keys).
//
//   Safety: an f+1 threshold does not cause false rollbacks because an
//   honest validator only reports hash_chain_break for a real parent_hash
//   mismatch at the reported height, which it observed in a signed
//   envelope from a peer on a different chain. A real break = real fork.
//
//   Liveness: this recovers a node trapped on a minority fork as soon as
//   f+1 peers advance past it, which is the smallest network-observable
//   quorum that proves we are behind the canonical chain.
//
// DashMap+DashSet combo gives lock-free concurrent writes across pipeline
// worker threads. Bounded by height cleanup (cleanup_break_tracker) to keep
// memory flat regardless of chain length.
// ============================================================================
use dashmap::DashSet;
static HASH_CHAIN_BREAK_WITNESSES: once_cell::sync::Lazy<
    dashmap::DashMap<u64, DashSet<String>>
> = once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// Record that `peer_id` reported a hash_chain_break at `height`.
///
/// v16.2: ADVISORY-ONLY MODEL. Witness count here measures how many
/// DISTINCT peers SENT us a forked-looking block at the same height —
/// not how many INDEPENDENT OBSERVERS detected the fork. With at most
/// `f` Byzantine producers in a 3f+1 system, the maximum source count
/// is `f` (typically 1 in practice), which means a 2f+1 source-based
/// rollback threshold is mathematically unreachable in the common
/// failure scenario. The v16.1 destructive-rollback path was therefore
/// dead code — never triggered in any observed deploy.
///
/// Rather than carry dead consensus-mutating code, v16.2 collapses the
/// behaviour to its useful subset:
///   * Track distinct sources per height in `HASH_CHAIN_BREAK_WITNESSES`.
///   * Once any source set crosses `f+1`, emit an advisory `[WARN]` so
///     operators see partial-agreement evidence in postmortems.
///   * Tag every source peer for the 5-minute fork cooldown so
///     `get_sync_peers_filtered_by_height` deprioritises them when the
///     local chain refills the disputed range. This breaks the v15.x
///     rollback cascade WITHOUT touching consensus state — the local
///     chain stays canonical, only sync source preference changes.
///
/// A future extension (`v16.3+`) can introduce a true observer-based
/// rollback by adding a `BlockRejection` gossip message: each honest
/// node would broadcast a signed rejection on `verify_failed`, and 2f+1
/// distinct OBSERVER signatures for the same `(height, source_peer_id)`
/// tuple would justify destructive action. Until that protocol exists,
/// no destructive rollback fires from this path — recovery happens via
/// the existing 2f+1 macroblock commit-reveal which finalises the
/// canonical branch every 90 microblocks regardless of microblock-level
/// disagreement.
///
/// Scalability: per-height witness sets bounded by active validator
/// count (≤ MAX_VALIDATORS = 1000 in committee). Cleanup sweep evicts
/// entries below current chain tip.
pub fn record_hash_chain_break_witness(height: u64, peer_id: &str) {
    if peer_id.is_empty() || peer_id == "self" {
        return;
    }
    let entry = HASH_CHAIN_BREAK_WITNESSES.entry(height).or_insert_with(DashSet::new);
    if !entry.insert(peer_id.to_string()) {
        // peer already counted for this height — no change
        return;
    }
    let witnesses = entry.len();
    drop(entry);

    // Use the consensus layer's canonical active validator count.
    // Fall back to the genesis floor (5) when the integration layer has
    // not yet installed a count (very early boot).
    let total_validators: usize = {
        let n = qnet_consensus::consensus_crypto::consensus_pk_registry_len();
        if n >= 3 { n } else { 5 }
    };

    // f+1 = ceil(n/3): "at least one honest witness" — ADVISORY ONLY.
    let threshold_f_plus_1 = (total_validators.saturating_add(2)) / 3;
    let detection_threshold = threshold_f_plus_1.max(2);

    // Advisory signal at f+1. Tags every reporter as a fork-source so the
    // canonical-aware sync peer selector deprioritises them. No state
    // mutation, no rollback — the local chain is preserved and the next
    // 2f+1 macroblock commit-reveal naturally finalises the canonical
    // branch every 90 microblocks.
    if witnesses == detection_threshold {
        if is_warn() {
            println!(
                "[WARN][PIPELINE] fork_detection_signal h={} witnesses={} threshold_f_plus_1={} action=advisory_log_plus_peer_cooldown",
                height, witnesses, detection_threshold
            );
        }
        if let Some(set) = HASH_CHAIN_BREAK_WITNESSES.get(&height) {
            for w in set.iter() {
                mark_peer_as_fork_source(w.key());
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// v16.1: FORKED PEER COOLDOWN
// ═══════════════════════════════════════════════════════════════════════════
// Peers that supplied blocks of a branch we just rolled back from (or which
// triggered the f+1 fork-detection signal) are tagged here for a bounded
// cooldown window. The canonical-aware sync peer selector reads this map
// and de-prioritises tagged peers until the cooldown expires — letting the
// resync pull from peers on the canonical branch instead of refetching
// the same forked blocks.
//
// Bounded retention: 5-minute cooldown per peer. Auto-evicted on next
// fork event for that peer (refresh) or via the periodic sweep below.
// At 100k super-node deployment this map is bounded by the union of
// recent fork participants — typically << 1000 entries.
// ═══════════════════════════════════════════════════════════════════════════

const FORKED_PEER_COOLDOWN_MS: u64 = 5 * 60 * 1000; // 5 min

static FORKED_PEER_COOLDOWN: once_cell::sync::Lazy<dashmap::DashMap<String, u64>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// Mark `peer_id` as having supplied a forked-branch block. Used by the
/// canonical-aware sync peer selector to prefer other peers during the
/// cooldown window. Idempotent — refreshes timestamp on repeated hits.
pub fn mark_peer_as_fork_source(peer_id: &str) {
    if peer_id.is_empty() || peer_id == "self" {
        return;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    FORKED_PEER_COOLDOWN.insert(peer_id.to_string(), now_ms);
}

/// Returns true while `peer_id` is within the fork-cooldown window. The
/// canonical-aware sync peer selector skips peers for which this returns
/// true; if the entire candidate set is in cooldown, the selector falls
/// back to the full set rather than starving sync (preferring suspect
/// peers over no peers at all when liveness is at stake).
pub fn is_peer_in_fork_cooldown(peer_id: &str) -> bool {
    let entry = match FORKED_PEER_COOLDOWN.get(peer_id) {
        Some(e) => e,
        None => return false,
    };
    let marked_at = *entry.value();
    drop(entry);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let in_cooldown = now_ms.saturating_sub(marked_at) < FORKED_PEER_COOLDOWN_MS;
    if !in_cooldown {
        // Lazy eviction — opportunistically clean expired entries on
        // every read. Avoids a separate cleanup task at the cost of a
        // single DashMap remove per expiration check.
        FORKED_PEER_COOLDOWN.remove(peer_id);
    }
    in_cooldown
}

/// Periodic sweep called from the existing cleanup task. Removes entries
/// older than the cooldown window so the map stays bounded under sustained
/// fork activity. O(N) over current map size; runs at low cadence (the
/// caller's existing 5-minute sweep is sufficient).
pub fn cleanup_forked_peer_cooldown() {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    FORKED_PEER_COOLDOWN.retain(|_, marked_at| {
        now_ms.saturating_sub(*marked_at) < FORKED_PEER_COOLDOWN_MS
    });
}

/// Periodic cleanup of stale witness entries below `min_height`.
/// Called by unified_p2p cleanup tasks.
pub fn cleanup_break_tracker(min_height: u64) {
    HASH_CHAIN_BREAK_WITNESSES.retain(|h, _| *h >= min_height);
}

// ============================================================================
// v18: MISSING-PARENT ACTIVE SYNC TRIGGER (storage gap recovery)
// ============================================================================
//
// When the verify stage attempts `load_microblock_auto_format(parent_h)` and
// the parent is absent from local storage (Ok(None)), the legacy behaviour
// was to defer the child block and wait for the parent to arrive on its own
// via gossip. Under partial propagation that wait can be unbounded — the
// deferred buffer fills up, the child is evicted, and the gap stays open
// indefinitely. This is the storage-side root cause of the v17.x stall
// observed at h=180-241 where individual nodes had block subsets like
// {1, 2, 211, 213, 214, 216, ...} with permanent holes.
//
// v18: when a parent miss is detected, the verify stage proactively triggers
// `request_block_repair(parent_h)` on the global P2P instance, which fans
// out a `RequestBlocks{from=parent_h, to=parent_h}` to the top peers by
// reputation in parallel. The first response that arrives is decoded by
// the existing `handle_blocks_batch` path and re-enters the pipeline as
// a normal incoming block, where it is verified, applied, and triggers
// retry of the deferred child via the existing deferred-drain loop.
//
// Design properties
// ─────────────────
//   * Single-flight per height: a height already in the request map is
//     not re-requested while the previous request is in-flight (within
//     the cooldown window). Eliminates thundering-herd amplification when
//     many child blocks arrive for the same missing parent.
//   * TTL retention: stale entries (older than the cooldown) are evicted
//     opportunistically on read. Memory bounded by the active request
//     fan, which equals the gap size in the worst case (≪ chain height).
//   * Detached spawn: the request is fired from a `tokio::spawn` task so
//     the verify stage never blocks on network I/O. Failure to enqueue
//     leaves the deferred entry in place — the legacy passive-wait path
//     remains as the last-resort fallback, so this code only ever ADDS
//     a recovery vector, never removes one.
//   * Idempotent across pipeline workers: the dedup map is process-wide
//     so multiple verify tasks (e.g. parallel verify pool) never race on
//     duplicate sends.
//
// Scalability
// ───────────
//   * O(1) DashMap operation per missing-parent encounter (insert-and-check).
//   * `request_block_repair` itself sends to top-3 peers in parallel,
//     bounded send fan-out regardless of network size.
//   * Cooldown evicts stale entries lazily; periodic sweep below caps
//     long-tail growth at any committee size.
//
// Security
// ────────
//   * Returned blocks pass the full pipeline (signature + hash chain +
//     state apply) before being committed — no trust in the responding
//     peer beyond the canonical verify stages.
//   * No new attack surface: an attacker who sends bogus blocks to
//     `RequestBlocks` is rejected at verify just like any other malformed
//     gossip block. Attacker cannot exhaust this map because TTL eviction
//     drops stale entries; sustained DoS would also fail the existing
//     `is_consensus_rate_limited` check on the request handler side.
// ============================================================================

/// How long a single (height) request stays in the dedup map before another
/// retry is allowed. Long enough to cover RTT + decode + apply on slow links
/// (1000+ super-node deployment, WAN), short enough that a real persistent
/// missing block triggers fresh requests without the operator restarting.
const MISSING_BLOCK_REQUEST_TTL_MS: u64 = 30_000; // 30 seconds

/// Per-height in-flight request tracker. Key = parent height that is missing
/// locally; value = unix-ms timestamp of the most recent request attempt.
/// Lock-free DashMap keeps the verify stage non-blocking under load.
static MISSING_BLOCK_REQUESTED: once_cell::sync::Lazy<dashmap::DashMap<u64, u64>> =
    once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// Trigger an active sync request for a missing parent block, with single-flight
/// dedup. Returns true when this call dispatched a request, false when an
/// in-flight request is still within the cooldown window.
///
/// The actual network send is performed on a detached tokio task so the verify
/// stage thread never blocks on peer I/O. If the global P2P instance is not
/// yet initialized (very early boot), the call is a silent no-op — verify
/// stage falls back to the legacy passive-wait deferral path.
pub fn request_missing_parent(parent_h: u64) -> bool {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Single-flight: refuse to re-trigger while a request is in-flight.
    // The DashMap entry is updated atomically — no two threads can both
    // observe "no recent request" and double-fire.
    let should_dispatch = match MISSING_BLOCK_REQUESTED.entry(parent_h) {
        dashmap::mapref::entry::Entry::Occupied(mut occupied) => {
            let last = *occupied.get();
            if now_ms.saturating_sub(last) < MISSING_BLOCK_REQUEST_TTL_MS {
                false // still in cooldown
            } else {
                *occupied.get_mut() = now_ms;
                true // cooldown expired — refresh and dispatch
            }
        }
        dashmap::mapref::entry::Entry::Vacant(vacant) => {
            vacant.insert(now_ms);
            true
        }
    };

    if !should_dispatch {
        return false;
    }

    // Detached dispatch — never block the caller (verify stage) on network.
    if let Some(p2p_arc) = crate::node::try_get_p2p() {
        let p2p_clone = p2p_arc.clone();
        tokio::spawn(async move {
            if let Err(e) = p2p_clone.request_block_repair(parent_h).await {
                if is_debug() {
                    println!("[DBG][PIPELINE] missing_parent_request_failed h={} err={}",
                             parent_h, e);
                }
            } else if is_info() {
                println!("[INFO][PIPELINE] missing_parent_requested h={} action=fanout_to_top_peers",
                         parent_h);
            }
        });
        true
    } else {
        if is_debug() {
            println!("[DBG][PIPELINE] missing_parent_request_skipped h={} reason=p2p_not_ready",
                     parent_h);
        }
        false
    }
}

// ════════════════════════════════════════════════════════════════════════════
// v19: RANGE-SYNC TRIGGER for large storage gaps
// ════════════════════════════════════════════════════════════════════════════
//
// Problem the v18 single-flight path leaves open
// ──────────────────────────────────────────────
// `request_missing_parent` issues one request per missing height with a 30 s
// dedup TTL. When the local pipeline finds itself N blocks behind the network
// tip (observed at h=90 vs network tip h=121, gap=31), the cascade of
// individual single-height requests recovers at most one block per TTL window
// per missing height, which produces a worst-case recovery time of
// `gap × TTL ≈ 15 minutes` on a 31-block gap — orders of magnitude slower
// than the underlying network can deliver. While the cascade is in flight
// the producer's downstream blocks keep arriving and queue up in the
// deferred buffer, never converting into applied state.
//
// What the network actually has
// ─────────────────────────────
// `unified_p2p::sync_blocks(from, to)` is the canonical block-range sync
// primitive used elsewhere in the codebase: parallel fan-out to the
// top-reputation validators with `MAX_BATCH_BLOCKS = 500` per request and
// timeout-aligned peer rotation. A single call retrieves every block in the
// requested range from authenticated peers in one round-trip; the responses
// arrive as `BlocksBatch` envelopes that re-enter the same pipeline through
// `handle_blocks_batch → block_tx → ingest`.
//
// The v19 fix simply wires that primitive into the verify-stage gap-detection
// path: when the missing parent is more than `RANGE_SYNC_GAP_THRESHOLD`
// blocks below the just-arrived child, dispatch a single range request
// instead of N single-flights.
//
// Single-flight per RANGE
// ───────────────────────
// The legacy per-height dedup map (`MISSING_BLOCK_REQUESTED`) is preserved
// for the small-gap path. Range sync uses a separate, time-windowed dedup
// (`MISSING_BLOCK_RANGE_REQUESTED`) keyed by `(local_tip, target_height)`
// pair — multiple gap detections within the cooldown window collapse to
// one outbound request, so a hot stream of deferred children does not
// amplify into a request storm.
//
// Scalability
// ───────────
//   * O(1) dedup-map ops per gap detection. Bounded by the active gap set,
//     typically << 100 entries even on a 100K-super-node deployment.
//   * Range request itself caps at MAX_BATCH_BLOCKS = 500 blocks per peer.
//     Top-3 peers parallel send ⇒ ~1500 blocks delivered per round-trip
//     under contention, ~500 under healthy single-peer fan-out.
//   * Detached `tokio::spawn` keeps the verify stage non-blocking.
//
// Security
// ────────
//   * Range responses re-enter the canonical pipeline (signature + hash
//     chain + state apply). Attacker cannot inject blocks bypassing
//     `verify_consensus_signature`, equivalence with the v18 single-flight
//     security boundary.
//   * Dedup map is per-target-height keyed; an attacker cannot exhaust
//     it because TTL eviction releases slots, and `cleanup_missing_block_requests`
//     evicts in periodic sweeps regardless of activity.
// ════════════════════════════════════════════════════════════════════════════

/// Threshold (in blocks) above which the verify stage prefers a single
/// range-sync over the cascade of single-height requests. Picked to keep
/// the small-gap regime (1–5 blocks, normal gossip jitter) on the
/// lighter-weight per-height path while ensuring any genuine catch-up gap
/// converts to a batched range request.
const RANGE_SYNC_GAP_THRESHOLD: u64 = 5;

/// TTL for in-flight range-sync request dedup. Slightly longer than the
/// per-height TTL so a cascade of children does not generate overlapping
/// batched requests for substantially the same range.
const MISSING_BLOCK_RANGE_TTL_MS: u64 = 60_000; // 60 seconds

/// Range-sync dedup map. Key = `(from_height, to_height)`; value =
/// dispatch timestamp in unix-ms. Lock-free DashMap, evicted on TTL
/// by `cleanup_missing_block_requests`.
static MISSING_BLOCK_RANGE_REQUESTED: once_cell::sync::Lazy<
    dashmap::DashMap<(u64, u64), u64>
> = once_cell::sync::Lazy::new(dashmap::DashMap::new);

/// Trigger a range sync covering `from..=to`. Returns true on dispatch,
/// false if a recent request for the same range is still in cooldown or
/// the global P2P instance is not yet initialized.
///
/// The actual network call (`unified_p2p::sync_blocks`) runs on a detached
/// task so the verify stage thread is never blocked on I/O.
pub fn request_missing_range(from: u64, to: u64) -> bool {
    if to < from {
        return false;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Single-flight per (from, to) tuple within the cooldown window.
    let should_dispatch = match MISSING_BLOCK_RANGE_REQUESTED.entry((from, to)) {
        dashmap::mapref::entry::Entry::Occupied(mut occupied) => {
            let last = *occupied.get();
            if now_ms.saturating_sub(last) < MISSING_BLOCK_RANGE_TTL_MS {
                false
            } else {
                *occupied.get_mut() = now_ms;
                true
            }
        }
        dashmap::mapref::entry::Entry::Vacant(vacant) => {
            vacant.insert(now_ms);
            true
        }
    };

    if !should_dispatch {
        return false;
    }

    if let Some(p2p_arc) = crate::node::try_get_p2p() {
        let p2p_clone = p2p_arc.clone();
        tokio::spawn(async move {
            match p2p_clone.sync_blocks(from, to).await {
                Ok(_) => {
                    if is_info() {
                        println!(
                            "[INFO][PIPELINE] missing_range_requested from={} to={} blocks={} action=batched_top_peers",
                            from, to, to.saturating_sub(from).saturating_add(1)
                        );
                    }
                }
                Err(e) => {
                    if is_debug() {
                        println!(
                            "[DBG][PIPELINE] missing_range_request_failed from={} to={} err={}",
                            from, to, e
                        );
                    }
                }
            }
        });
        true
    } else {
        if is_debug() {
            println!(
                "[DBG][PIPELINE] missing_range_request_skipped from={} to={} reason=p2p_not_ready",
                from, to
            );
        }
        false
    }
}

/// Periodic cleanup of expired request entries. Called from the existing
/// cleanup task on the same cadence as `cleanup_forked_peer_cooldown` to
/// keep the map bounded regardless of chain length or stall duration.
pub fn cleanup_missing_block_requests() {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    MISSING_BLOCK_REQUESTED.retain(|_, last| {
        now_ms.saturating_sub(*last) < MISSING_BLOCK_REQUEST_TTL_MS
    });
    // v19: range-sync dedup map shares the same retention sweep so it
    // stays bounded under sustained gap-recovery activity without a
    // separate cleanup task.
    MISSING_BLOCK_RANGE_REQUESTED.retain(|_, last| {
        now_ms.saturating_sub(*last) < MISSING_BLOCK_RANGE_TTL_MS
    });
}

// ============================================================================
// PIPELINE TYPES
// ============================================================================

/// Raw block received from network (any source: sync, broadcast, shred).
#[derive(Debug, Clone)]
pub struct IngestBlock {
    pub height: u64,
    pub data: Vec<u8>,
    pub block_type: String,
    pub from_peer: String,
    pub received_at: u64,
}

/// Block after successful decoding (decompressed + deserialized).
#[derive(Debug, Clone)]
pub struct DecodedBlock {
    pub height: u64,
    pub raw_data: Vec<u8>,
    pub decompressed: Vec<u8>,
    pub microblock: qnet_state::MicroBlock,
    pub from_peer: String,
}

/// Block after verification (signature, hash chain, timestamp).
#[derive(Debug)]
pub struct VerifiedBlock {
    pub height: u64,
    pub decompressed: Vec<u8>,
    pub microblock: qnet_state::MicroBlock,
    pub from_peer: String,
}

// ============================================================================
// PIPELINE METRICS
// ============================================================================

/// Per-stage counters for monitoring and debugging.
pub struct PipelineMetrics {
    pub ingested: AtomicU64,
    pub decoded: AtomicU64,
    pub decode_failed: AtomicU64,
    pub verified: AtomicU64,
    pub verify_failed: AtomicU64,
    pub applied: AtomicU64,
    pub apply_failed: AtomicU64,
    pub duplicates_skipped: AtomicU64,
    /// v15.3: Blocks ARRIVED via gossip but their height is far beyond the
    /// node's current chain tip (`apply_tip + GOSSIP_HORIZON`). They are
    /// NOT failures — sync will fetch the corresponding range when the
    /// chain tip advances close enough. Counted SEPARATELY from
    /// `verify_failed` so backpressure metrics treat them as "dropped, no
    /// retry pending" rather than "in flight, stuck".
    pub future_dropped: AtomicU64,
    /// v15.3: Blocks evicted from the verify-stage deferred buffer because
    /// they aged out (more than 500 blocks behind the local tip). Same
    /// non-failure semantics as `future_dropped` — sync will refetch when
    /// the chain tip approaches that range. Tracked separately so the
    /// backpressure formula can debit them from the in-flight estimate
    /// without overloading the `verify_failed` semantics.
    pub deferred_evicted: AtomicU64,

    /// v15.4 DIAGNOSTICS: per-stage live progress markers. The watchdog
    /// task reads these to identify exactly which block + which operation
    /// is hung when the verified/applied counters stop advancing. Stored as
    /// AtomicU64 so updates are lock-free at any node count.
    ///
    /// `verify_current_h` / `apply_current_h`: height of the block the
    /// stage is processing right now. 0 means stage is idle (waiting on
    /// channel recv).
    ///
    /// `verify_op` / `apply_op`: PIPELINE_OP_* constant identifying the
    /// sub-step within the stage. 0 = idle. Decoded by `op_name()` in the
    /// watchdog dump for human-readable diagnostics.
    ///
    /// `verify_op_started_ms` / `apply_op_started_ms`: epoch milliseconds
    /// at which the current op was entered. The watchdog computes
    /// `now_ms() - started_ms` to report op-age. Updated together with
    /// the op marker on every transition.
    ///
    /// Non-atomic relative to each other (the trio is updated as separate
    /// stores). This is acceptable: the watchdog only fires on stalls of
    /// ≥30 s, vastly larger than any plausible interleaving window between
    /// the three stores. Diagnostic snapshots may be momentarily
    /// inconsistent but the stuck condition itself is stable for tens of
    /// seconds before the dump runs.
    pub verify_current_h: AtomicU64,
    pub verify_op: AtomicU64,
    pub verify_op_started_ms: AtomicU64,
    pub apply_current_h: AtomicU64,
    pub apply_op: AtomicU64,
    pub apply_op_started_ms: AtomicU64,
}

/// v15.4: Op codes for per-stage progress markers. Read by the watchdog
/// to produce human-readable stuck-pipeline dumps.
pub const PIPELINE_OP_IDLE: u64 = 0;
pub const PIPELINE_OP_VERIFY_LOAD_PREV: u64 = 11;
pub const PIPELINE_OP_VERIFY_SIG: u64 = 12;
pub const PIPELINE_OP_VERIFY_SEND: u64 = 13;
pub const PIPELINE_OP_APPLY_DEDUP: u64 = 21;
pub const PIPELINE_OP_APPLY_STATE_LOCK: u64 = 22;
pub const PIPELINE_OP_APPLY_SNAPSHOT: u64 = 23;
pub const PIPELINE_OP_APPLY_STATE: u64 = 24;
pub const PIPELINE_OP_APPLY_SAVE_BLOCK: u64 = 25;
pub const PIPELINE_OP_APPLY_SET_HEIGHT: u64 = 26;
pub const PIPELINE_OP_APPLY_DEFERRED_FX: u64 = 27;

/// Decode an op marker into a short human-readable string for diagnostics.
fn op_name(op: u64) -> &'static str {
    match op {
        PIPELINE_OP_IDLE => "idle",
        PIPELINE_OP_VERIFY_LOAD_PREV => "verify:load_prev_block",
        PIPELINE_OP_VERIFY_SIG => "verify:signature",
        PIPELINE_OP_VERIFY_SEND => "verify:send_to_apply",
        PIPELINE_OP_APPLY_DEDUP => "apply:dedup_check",
        PIPELINE_OP_APPLY_STATE_LOCK => "apply:state_lock_acquire",
        PIPELINE_OP_APPLY_SNAPSHOT => "apply:create_snapshot",
        PIPELINE_OP_APPLY_STATE => "apply:apply_state_mutations",
        PIPELINE_OP_APPLY_SAVE_BLOCK => "apply:save_microblock",
        PIPELINE_OP_APPLY_SET_HEIGHT => "apply:set_chain_height",
        PIPELINE_OP_APPLY_DEFERRED_FX => "apply:deferred_side_effects",
        _ => "unknown",
    }
}

/// Current epoch in milliseconds. Diagnostic-only — never feeds consensus.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl PipelineMetrics {
    pub fn new() -> Self {
        Self {
            ingested: AtomicU64::new(0),
            decoded: AtomicU64::new(0),
            decode_failed: AtomicU64::new(0),
            verified: AtomicU64::new(0),
            verify_failed: AtomicU64::new(0),
            applied: AtomicU64::new(0),
            apply_failed: AtomicU64::new(0),
            duplicates_skipped: AtomicU64::new(0),
            future_dropped: AtomicU64::new(0),
            deferred_evicted: AtomicU64::new(0),
            verify_current_h: AtomicU64::new(0),
            verify_op: AtomicU64::new(0),
            verify_op_started_ms: AtomicU64::new(0),
            apply_current_h: AtomicU64::new(0),
            apply_op: AtomicU64::new(0),
            apply_op_started_ms: AtomicU64::new(0),
        }
    }

    /// v15.4: Mark verify stage as entering an op on a specific block.
    /// Three stores are independent — see struct doc for ordering notes.
    pub fn mark_verify_op(&self, height: u64, op: u64) {
        self.verify_current_h.store(height, Ordering::Relaxed);
        self.verify_op.store(op, Ordering::Relaxed);
        self.verify_op_started_ms.store(now_ms(), Ordering::Relaxed);
    }

    /// v15.4: Mark verify stage as idle (between blocks).
    pub fn mark_verify_idle(&self) {
        self.verify_current_h.store(0, Ordering::Relaxed);
        self.verify_op.store(PIPELINE_OP_IDLE, Ordering::Relaxed);
        self.verify_op_started_ms.store(now_ms(), Ordering::Relaxed);
    }

    /// v15.4: Mark apply stage as entering an op on a specific block.
    pub fn mark_apply_op(&self, height: u64, op: u64) {
        self.apply_current_h.store(height, Ordering::Relaxed);
        self.apply_op.store(op, Ordering::Relaxed);
        self.apply_op_started_ms.store(now_ms(), Ordering::Relaxed);
    }

    /// v15.4: Mark apply stage as idle (between blocks).
    pub fn mark_apply_idle(&self) {
        self.apply_current_h.store(0, Ordering::Relaxed);
        self.apply_op.store(PIPELINE_OP_IDLE, Ordering::Relaxed);
        self.apply_op_started_ms.store(now_ms(), Ordering::Relaxed);
    }

    pub fn log_summary(&self) {
        if is_info() {
            println!(
                "[INFO][PIPELINE] ingested={} decoded={} decode_fail={} verified={} verify_fail={} applied={} apply_fail={} dup_skip={} future_drop={} defer_evict={}",
                self.ingested.load(Ordering::Relaxed),
                self.decoded.load(Ordering::Relaxed),
                self.decode_failed.load(Ordering::Relaxed),
                self.verified.load(Ordering::Relaxed),
                self.verify_failed.load(Ordering::Relaxed),
                self.applied.load(Ordering::Relaxed),
                self.apply_failed.load(Ordering::Relaxed),
                self.duplicates_skipped.load(Ordering::Relaxed),
                self.future_dropped.load(Ordering::Relaxed),
                self.deferred_evicted.load(Ordering::Relaxed),
            );
        }
    }
}

// ============================================================================
// PIPELINE CONFIG
// ============================================================================

/// Tuning parameters for the pipeline.
pub struct PipelineConfig {
    /// Channel buffer between ingest → decode
    pub ingest_buffer: usize,
    /// Channel buffer between decode → verify
    pub decode_buffer: usize,
    /// Channel buffer between verify → apply
    pub verify_buffer: usize,
    /// Number of parallel verify workers
    pub verify_workers: usize,
    /// Maximum block size in bytes (reject larger blocks as DoS)
    pub max_block_bytes: usize,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            ingest_buffer: 4096,
            decode_buffer: 2048,
            verify_buffer: 1024,
            verify_workers: 2,
            max_block_bytes: 50 * 1024 * 1024, // 50 MB max
        }
    }
}

impl PipelineConfig {
    /// Config optimized for genesis bootstrap (5 nodes, small network).
    pub fn genesis() -> Self {
        Self {
            ingest_buffer: 256,
            decode_buffer: 128,
            verify_buffer: 64,
            verify_workers: 1,
            max_block_bytes: 50 * 1024 * 1024,
        }
    }

    /// Config optimized for production (thousands of peers).
    pub fn production() -> Self {
        Self {
            ingest_buffer: 8192,
            decode_buffer: 4096,
            verify_buffer: 2048,
            verify_workers: 4,
            max_block_bytes: 50 * 1024 * 1024,
        }
    }
}

// ============================================================================
// APPLY CONTEXT — holds all references needed by apply stage
// ============================================================================

/// Everything the apply stage needs to perform full block application.
/// Created once at pipeline startup, cloned into the apply task.
pub struct ApplyContext {
    pub storage: Arc<Storage>,
    pub state: Arc<RwLock<crate::StateManager>>,
    pub coordinator: CoordinatorHandle,
    pub height: Arc<RwLock<u64>>,
    pub reward_manager: Arc<RwLock<PhaseAwareRewardManager>>,
    pub unified_p2p: Option<Arc<SimplifiedP2P>>,
    pub block_event_tx: tokio::sync::broadcast::Sender<u64>,
    pub node_id: String,
    /// v14.9: Event-driven apply signal. Fired after every successful
    /// block save in the pipeline. Sync manager waits on this instead of
    /// poll-sleeping, turning catch-up from 2 blk/s → bandwidth-limited.
    pub apply_notify: Arc<tokio::sync::Notify>,
}

// ============================================================================
// PIPELINE — the main struct
// ============================================================================

/// Handle for submitting blocks into the pipeline.
/// Clone-friendly, given to P2P layer and sync manager.
#[derive(Clone)]
pub struct PipelineIngest {
    tx: mpsc::Sender<IngestBlock>,
    metrics: Arc<PipelineMetrics>,
    /// v14.9: Shared apply-event signal. Fired after each successful save.
    /// Sync manager `.notified().await` instead of polling storage.
    apply_notify: Arc<tokio::sync::Notify>,
}

impl PipelineIngest {
    /// Submit a block for processing. Returns false if pipeline is full (backpressure).
    pub fn submit(&self, block: IngestBlock) -> bool {
        self.metrics.ingested.fetch_add(1, Ordering::Relaxed);
        match self.tx.try_send(block) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                if is_debug() {
                    println!("[DBG][PIPELINE] ingest_backpressure queue=full");
                }
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    /// Submit with async wait (for sync manager that can afford to wait).
    pub async fn submit_async(&self, block: IngestBlock) -> bool {
        self.metrics.ingested.fetch_add(1, Ordering::Relaxed);
        self.tx.send(block).await.is_ok()
    }

    /// Get pipeline metrics snapshot.
    pub fn metrics(&self) -> &PipelineMetrics {
        &self.metrics
    }

    /// v14.9: Access to the apply-event signal.
    /// Sync manager calls `pipeline.apply_notify().notified().await` to
    /// wake up the instant a block hits storage — zero-latency progress
    /// without any sleep/poll loop.
    pub fn apply_notify(&self) -> Arc<tokio::sync::Notify> {
        self.apply_notify.clone()
    }

    /// v14.10: Total blocks currently "in the system" — ingested but not yet
    /// finalized (applied / rejected / skipped). Used by SyncManager as the
    /// single source of truth for backpressure decisions.
    ///
    /// Calculation: ingested − applied − (all terminal-failure counters) − dup_skip.
    /// The deferred-buffer residents are COUNTED (good — they occupy pipeline
    /// capacity). Blocks that truly finished (applied or rejected) are excluded.
    ///
    /// Scalability: 4 atomic loads, O(1). Safe at 10K+ super-nodes — this is
    /// read by SyncManager on every iteration, no locks.
    pub fn in_flight(&self) -> u64 {
        // ═══════════════════════════════════════════════════════════════════
        // v15.3: SCALE-CORRECT BACKPRESSURE METRIC.
        //
        // The original `ingested - finished` formula treated only "applied
        // or rejected at decode/verify/apply" as terminal — but during a
        // multi-thousand-block catch-up the same block height arrives many
        // times via SHRED redundancy and sync retries, each arrival
        // incrementing `ingested` while only one eventually applies. The
        // accumulated "phantom" delta inflated the in-flight estimate well
        // past the bounded channel/buffer capacity (~16K), forced
        // backpressure credits to zero, and starved sync_manager of
        // dispatch budget exactly when it needed to fetch parents to
        // unblock the pipeline. Observed 58K phantom on node 001 against a
        // real pipeline occupancy of < 2K.
        //
        // Two corrections:
        //
        //   1. Add `future_dropped` and `deferred_evicted` to the
        //      `finished` set. Both are terminal drops with no retry
        //      pending in this pipeline — sync re-requests later when the
        //      tip approaches. Counting them as finished prevents them
        //      from accumulating into the in-flight estimate.
        //
        //   2. Hard-clamp the result to the sum of all bounded buffers in
        //      the pipeline. The actual occupancy can NEVER exceed the
        //      sum of channel capacities + deferred buffer size, regardless
        //      of historical counter behaviour. Clamping protects against
        //      any future double-count source we might miss — the metric
        //      always reports a number physically achievable by the
        //      pipeline.
        //
        // Scalability: 9 atomic loads, O(1). Read by SyncManager on every
        // dispatch iteration; bounded by `MAX_PIPELINE_OCCUPANCY` so
        // credits stay sensible at any historical-drop volume. Safe for
        // 10K+ super-node committees.
        // ═══════════════════════════════════════════════════════════════════
        let ingested = self.metrics.ingested.load(Ordering::Relaxed);
        let finished = self.metrics.applied.load(Ordering::Relaxed)
            .saturating_add(self.metrics.decode_failed.load(Ordering::Relaxed))
            .saturating_add(self.metrics.verify_failed.load(Ordering::Relaxed))
            .saturating_add(self.metrics.apply_failed.load(Ordering::Relaxed))
            .saturating_add(self.metrics.duplicates_skipped.load(Ordering::Relaxed))
            .saturating_add(self.metrics.future_dropped.load(Ordering::Relaxed))
            .saturating_add(self.metrics.deferred_evicted.load(Ordering::Relaxed));

        let raw = ingested.saturating_sub(finished);

        // Sum of every bounded buffer in the pipeline:
        //   ingest channel  (production: 8192, default: 4096)
        //   decode channel  (production: 4096, default: 2048)
        //   verify channel  (production: 2048, default: 1024)
        //   deferred buffer (DEFERRED_MAX = 2000)
        //   apply queue is small (1-2 items) — included implicitly in the
        //     verify-channel budget since apply consumes from there.
        // Use the production sizing as the cap so the metric is correct on
        // any deployment scale; smaller deployments simply never hit it.
        const MAX_PIPELINE_OCCUPANCY: u64 = 8192 + 4096 + 2048 + 2000;
        raw.min(MAX_PIPELINE_OCCUPANCY)
    }

    /// v14.10: Current ingest-channel free capacity (blocks the pipeline can
    /// accept right now before hitting the ingest buffer limit). Useful as a
    /// short-term "room available" indicator; SyncManager pairs this with
    /// `in_flight()` for a full picture.
    pub fn ingest_capacity_remaining(&self) -> usize {
        self.tx.capacity()
    }
}

/// Block processing pipeline. Creates stages and runs them.
pub struct BlockPipeline;

impl BlockPipeline {
    /// Create and start the pipeline. Returns the ingest handle.
    ///
    /// All stages are spawned as independent tokio tasks.
    /// The pipeline is alive as long as the ingest handle exists.
    pub fn start(
        config: PipelineConfig,
        ctx: ApplyContext,
    ) -> PipelineIngest {
        let metrics = Arc::new(PipelineMetrics::new());

        // Create inter-stage channels
        let (ingest_tx, ingest_rx) = mpsc::channel::<IngestBlock>(config.ingest_buffer);
        let (decode_tx, decode_rx) = mpsc::channel::<DecodedBlock>(config.decode_buffer);
        let (verify_tx, verify_rx) = mpsc::channel::<VerifiedBlock>(config.verify_buffer);

        // Stage 1: Ingest → Decode (decompress + deserialize)
        let metrics_decode = metrics.clone();
        let storage_decode = ctx.storage.clone();
        let p2p_decode = ctx.unified_p2p.clone();
        tokio::spawn(Self::decode_stage(
            ingest_rx,
            decode_tx,
            storage_decode,
            metrics_decode,
            config.max_block_bytes,
            p2p_decode,
        ));

        // Stage 2: Decode → Verify (signature, hash chain, timestamp)
        let metrics_verify = metrics.clone();
        let storage_verify = ctx.storage.clone();
        let coordinator_verify = ctx.coordinator.clone();
        let p2p_verify = ctx.unified_p2p.clone();
        tokio::spawn(Self::verify_stage(
            decode_rx,
            verify_tx,
            storage_verify,
            coordinator_verify,
            metrics_verify,
            ctx.node_id.clone(),
            p2p_verify,
        ));

        // Stage 3: Verify → Apply (state transitions + storage write + ALL side effects)
        // MUST be single-threaded (sequential writes to RocksDB + state)
        // v14.9: clone apply_notify BEFORE moving ctx into apply_stage —
        // sync manager will wait on the same Notify to progress without sleep.
        let ctx_apply_notify = ctx.apply_notify.clone();
        let metrics_apply = metrics.clone();
        tokio::spawn(Self::apply_stage(
            verify_rx,
            ctx,
            metrics_apply,
        ));

        // Periodic metrics logging
        let metrics_log = metrics.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                metrics_log.log_summary();
            }
        });

        // ════════════════════════════════════════════════════════════════════
        // v15.4 DIAGNOSTICS: PIPELINE PROGRESS WATCHDOG
        // ════════════════════════════════════════════════════════════════════
        // Background poller that detects when verify or apply stages stop
        // making forward progress. Designed to surface the exact hung
        // operation when the verified/applied counters freeze — observed
        // in production on node 001 with verified=applied=5256 frozen for
        // 5 minutes while macroblock saves continued (different code
        // path), with no error logs. Without this watchdog the only
        // visible signal was the WATCHDOG-driven 300 s process restart.
        //
        // Trigger semantics:
        //   * Sample `verified` and `applied` counters every WATCHDOG_TICK
        //     seconds.
        //   * If a counter has not advanced for STUCK_THRESHOLD seconds
        //     AND the corresponding stage's op marker is non-idle, emit a
        //     CRIT diagnostic dump. Idle-with-no-progress means the stage
        //     is correctly waiting on an empty channel — the issue is
        //     upstream and a separate alarm path will surface it.
        //   * Re-arm only after the counter advances. Repeated dumps for
        //     the same hang are suppressed by tracking the last reported
        //     counter; a new dump fires only when stuck-state persists
        //     past another STUCK_THRESHOLD window or after recovery.
        //
        // Cost: O(1) atomics read every 5 s, lock-free. Negligible for
        // any node count. Diagnostic-only — never participates in
        // consensus, never gates block flow.
        //
        // Why this is safe to deploy: pure observation. The watchdog
        // makes no state mutations — it reads atomic counters and writes
        // log lines. Even if the diagnostic logic is wrong, the worst
        // case is a noisy log; consensus, networking, storage are
        // entirely unaffected.
        // ════════════════════════════════════════════════════════════════════
        let metrics_watchdog = metrics.clone();
        tokio::spawn(async move {
            const WATCHDOG_TICK: std::time::Duration = std::time::Duration::from_secs(5);
            const STUCK_THRESHOLD_MS: u64 = 30_000;
            let mut last_verified: u64 = 0;
            let mut last_applied: u64 = 0;
            let mut last_verified_progress_ms: u64 = now_ms();
            let mut last_applied_progress_ms: u64 = now_ms();
            let mut last_verify_dump_ms: u64 = 0;
            let mut last_apply_dump_ms: u64 = 0;
            let mut interval = tokio::time::interval(WATCHDOG_TICK);
            loop {
                interval.tick().await;
                let now = now_ms();
                let verified_now = metrics_watchdog.verified.load(Ordering::Relaxed);
                let applied_now = metrics_watchdog.applied.load(Ordering::Relaxed);

                if verified_now != last_verified {
                    last_verified = verified_now;
                    last_verified_progress_ms = now;
                }
                if applied_now != last_applied {
                    last_applied = applied_now;
                    last_applied_progress_ms = now;
                }

                let verify_op = metrics_watchdog.verify_op.load(Ordering::Relaxed);
                let verify_h = metrics_watchdog.verify_current_h.load(Ordering::Relaxed);
                let verify_op_started = metrics_watchdog.verify_op_started_ms.load(Ordering::Relaxed);
                let verify_stall_ms = now.saturating_sub(last_verified_progress_ms);
                let verify_op_age_ms = now.saturating_sub(verify_op_started);

                let apply_op = metrics_watchdog.apply_op.load(Ordering::Relaxed);
                let apply_h = metrics_watchdog.apply_current_h.load(Ordering::Relaxed);
                let apply_op_started = metrics_watchdog.apply_op_started_ms.load(Ordering::Relaxed);
                let apply_stall_ms = now.saturating_sub(last_applied_progress_ms);
                let apply_op_age_ms = now.saturating_sub(apply_op_started);

                // VERIFY STALL DUMP: counter unchanged for ≥30 s and op != idle.
                if verify_stall_ms >= STUCK_THRESHOLD_MS
                    && verify_op != PIPELINE_OP_IDLE
                    && now.saturating_sub(last_verify_dump_ms) >= STUCK_THRESHOLD_MS
                {
                    eprintln!(
                        "[CRIT][PIPELINE] verify_stuck stall_ms={} hung_h={} op={} op_age_ms={} verified={} applied={} ingested={} decoded={} verify_fail={} future_drop={} defer_evict={}",
                        verify_stall_ms,
                        verify_h,
                        op_name(verify_op),
                        verify_op_age_ms,
                        verified_now,
                        applied_now,
                        metrics_watchdog.ingested.load(Ordering::Relaxed),
                        metrics_watchdog.decoded.load(Ordering::Relaxed),
                        metrics_watchdog.verify_failed.load(Ordering::Relaxed),
                        metrics_watchdog.future_dropped.load(Ordering::Relaxed),
                        metrics_watchdog.deferred_evicted.load(Ordering::Relaxed),
                    );
                    last_verify_dump_ms = now;
                }

                // APPLY STALL DUMP: counter unchanged for ≥30 s and op != idle.
                if apply_stall_ms >= STUCK_THRESHOLD_MS
                    && apply_op != PIPELINE_OP_IDLE
                    && now.saturating_sub(last_apply_dump_ms) >= STUCK_THRESHOLD_MS
                {
                    eprintln!(
                        "[CRIT][PIPELINE] apply_stuck stall_ms={} hung_h={} op={} op_age_ms={} verified={} applied={} apply_fail={} dup_skip={}",
                        apply_stall_ms,
                        apply_h,
                        op_name(apply_op),
                        apply_op_age_ms,
                        verified_now,
                        applied_now,
                        metrics_watchdog.apply_failed.load(Ordering::Relaxed),
                        metrics_watchdog.duplicates_skipped.load(Ordering::Relaxed),
                    );
                    last_apply_dump_ms = now;
                }
            }
        });

        PipelineIngest {
            tx: ingest_tx,
            metrics,
            apply_notify: ctx_apply_notify,
        }
    }

    // ========================================================================
    // STAGE 1: DECODE
    // ========================================================================
    // Decompresses (zstd) and deserializes raw bytes into MicroBlock.
    // Drops blocks that can't be decoded — no retry, no buffering.
    // This is the FIRST line of defense against corrupt/malicious data.
    // ========================================================================

    async fn decode_stage(
        mut rx: mpsc::Receiver<IngestBlock>,
        tx: mpsc::Sender<DecodedBlock>,
        storage: Arc<Storage>,
        metrics: Arc<PipelineMetrics>,
        max_block_bytes: usize,
        unified_p2p: Option<Arc<SimplifiedP2P>>,
    ) {
        while let Some(block) = rx.recv().await {
            // v14.8: local apply-quarantine — drop blocks from peers that
            // have repeatedly produced state_root mismatches or invalid
            // payloads. Cheap DashMap lookup; lets us skip decode/verify
            // on known-bad sources without any global lock.
            if let Some(ref p2p) = unified_p2p {
                if p2p.is_peer_quarantined(&block.from_peer) {
                    if is_debug() {
                        println!("[DBG][PIPELINE] quarantined_peer_drop h={} from={}",
                                 block.height, block.from_peer);
                    }
                    metrics.decode_failed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            }

            // Size check (DoS protection)
            if block.data.len() > max_block_bytes {
                if is_warn() {
                    println!("[WARN][PIPELINE] oversized_block h={} bytes={} max={} from={}",
                             block.height, block.data.len(), max_block_bytes, block.from_peer);
                }
                metrics.decode_failed.fetch_add(1, Ordering::Relaxed);
                continue;
            }

            // Minimum size check
            if block.data.len() < 64 {
                if is_warn() {
                    println!("[WARN][PIPELINE] undersized_block h={} bytes={} from={}",
                             block.height, block.data.len(), block.from_peer);
                }
                metrics.decode_failed.fetch_add(1, Ordering::Relaxed);
                continue;
            }

            // Dedup: skip if already in storage
            if storage.load_microblock(block.height)
                .map(|opt| opt.is_some())
                .unwrap_or(false)
            {
                metrics.duplicates_skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            }

            // Decompress (zstd or raw) with size limit to prevent decompression bombs
            const MAX_DECOMPRESSED_SIZE: usize = 50 * 1024 * 1024; // 50MB limit
            let decompressed = match zstd::stream::Decoder::new(&block.data[..]) {
                Ok(decoder) => {
                    use std::io::Read;
                    let mut buf = Vec::new();
                    match decoder.take(MAX_DECOMPRESSED_SIZE as u64 + 1).read_to_end(&mut buf) {
                        Ok(_) => {
                            if buf.len() > MAX_DECOMPRESSED_SIZE {
                                if is_warn() {
                                    println!("[WARN][PIPELINE] decompression_bomb h={} decompressed_bytes={} max={} from={}",
                                             block.height, buf.len(), MAX_DECOMPRESSED_SIZE, block.from_peer);
                                }
                                metrics.decode_failed.fetch_add(1, Ordering::Relaxed);
                                continue;
                            }
                            buf
                        }
                        Err(_) => block.data.clone(), // Decode error — try raw
                    }
                }
                Err(_) => block.data.clone(), // Not zstd compressed — use as-is
            };

            // Deserialize
            match bincode::deserialize::<qnet_state::MicroBlock>(&decompressed) {
                Ok(microblock) => {
                    // Height sanity check
                    if microblock.height != block.height {
                        if is_warn() {
                            println!("[WARN][PIPELINE] height_mismatch declared={} actual={} from={}",
                                     block.height, microblock.height, block.from_peer);
                        }
                        metrics.decode_failed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }

                    let decoded = DecodedBlock {
                        height: block.height,
                        raw_data: block.data,
                        decompressed,
                        microblock,
                        from_peer: block.from_peer,
                    };

                    metrics.decoded.fetch_add(1, Ordering::Relaxed);

                    if let Err(_) = tx.send(decoded).await {
                        break; // Next stage closed — pipeline shutting down
                    }
                }
                Err(e) => {
                    if is_warn() {
                        println!("[WARN][PIPELINE] decode_failed h={} bytes={} from={} err={}",
                                 block.height, block.data.len(), block.from_peer, e);
                    }
                    metrics.decode_failed.fetch_add(1, Ordering::Relaxed);
                    // Block is DROPPED — no retry. Next copy from another peer will arrive.
                }
            }
        }
    }

    // ========================================================================
    // STAGE 2: VERIFY
    // ========================================================================
    // Validates: signature (Dilithium/Ed25519), hash chain, producer eligibility.
    // Can be parallelized — signature verification is CPU-bound and independent.
    // ========================================================================

    async fn verify_stage(
        mut rx: mpsc::Receiver<DecodedBlock>,
        tx: mpsc::Sender<VerifiedBlock>,
        storage: Arc<Storage>,
        coordinator: CoordinatorHandle,
        metrics: Arc<PipelineMetrics>,
        node_id: String,
        unified_p2p: Option<Arc<SimplifiedP2P>>,
    ) {
        // v13.1: Bounded deferred buffer for out-of-order blocks.
        // When blocks arrive before their parent (normal during sync),
        // they're stored here instead of being dropped. After each new block
        // is verified, we drain deferred blocks whose parent has now arrived.
        // Bounded to prevent OOM under load (thousands of Super nodes).
        const DEFERRED_MAX: usize = 2000;
        let mut deferred: HashMap<u64, DecodedBlock> = HashMap::new();

        // ═══════════════════════════════════════════════════════════════════
        // v15.3: GOSSIP HORIZON — drop blocks far beyond local chain tip.
        //
        // Root-cause fix for the catch-up backpressure deadlock observed on
        // node 001 at h=3960 with network at h=39800. Without a horizon
        // filter the pipeline received SHRED-broadcast blocks from the
        // network tip continuously while the node was thousands of blocks
        // behind. Those blocks could never verify (parents missing), filled
        // the bounded deferred buffer with future-state material, forced
        // legitimate sync responses (close to local tip) to be dropped on
        // arrival, and inflated the historical drop counter beyond the
        // backpressure threshold. The result was a self-perpetuating
        // throttle on sync request dispatch — sync_manager believed the
        // pipeline was overloaded when in reality it was being starved of
        // the very blocks it needed.
        //
        // Fix: any block more than `GOSSIP_HORIZON` ahead of the current
        // local chain tip is dropped immediately, BEFORE entering the
        // deferred buffer. It is counted in `future_dropped`, not
        // `verify_failed`, so the backpressure formula treats it as a
        // permanent drop with no retry pending in the pipeline. Sync
        // re-requests the block when the local tip is close enough.
        //
        // Sizing: GOSSIP_HORIZON = 200 covers ~200 seconds of network
        // production at 1 block/s — large enough to absorb normal
        // re-broadcast turbulence at the tip, small enough to keep the
        // deferred buffer pointed at near-tip blocks where it does useful
        // work. Independent of committee size.
        //
        // Scalability: O(1) check per block (one storage read for chain_h).
        // The chain-height read is cached lazily inside this loop so it
        // does not become a per-block syscall.
        //
        // Safety: dropping a future block here is safe — it is identical to
        // the block never reaching us via gossip in the first place. The
        // block is finalised and replayable from the canonical chain;
        // sync_manager will pull it via range request once the local tip
        // crosses (block.height - GOSSIP_HORIZON).
        // ═══════════════════════════════════════════════════════════════════
        const GOSSIP_HORIZON: u64 = 200;
        let mut horizon_cache_h: u64 = 0;
        let mut horizon_cache_age: u32 = 0;

        'outer: while let Some(decoded) = rx.recv().await {
            // v15.4 DIAG: a fresh block has just arrived — between recv()
            // calls the stage was idle on the channel, so reset the op
            // marker to a clean idle baseline. The earlier mark_verify_op
            // calls only fire on the success-with-progress path; without
            // this reset, an early-continue path (horizon drop, deferred
            // insert, hash break, sig fail, etc.) would leave a stale
            // op marker visible to the watchdog if the channel then went
            // quiet. Resetting on recv keeps the watchdog's "op stuck"
            // signal trustworthy: a non-idle op means a block is actively
            // being processed right now.
            metrics.mark_verify_idle();

            // Refresh local chain tip for the horizon filter every 16 blocks —
            // amortises storage reads while keeping the horizon close to real.
            if horizon_cache_age == 0 {
                horizon_cache_h = storage.get_chain_height().unwrap_or(0);
            }
            horizon_cache_age = (horizon_cache_age + 1) & 0xF;

            // Apply horizon filter at the entry point — never enters deferred
            // buffer. Drops are non-failure (sync will refetch).
            if decoded.microblock.height > horizon_cache_h.saturating_add(GOSSIP_HORIZON) {
                metrics.future_dropped.fetch_add(1, Ordering::Relaxed);
                if is_debug() {
                    println!(
                        "[DBG][PIPELINE] gossip_horizon_drop h={} local_tip={} horizon={}",
                        decoded.microblock.height, horizon_cache_h, GOSSIP_HORIZON,
                    );
                }
                continue;
            }

            // Process this block, then try to drain deferred chain
            let mut to_process = vec![decoded];

            while let Some(decoded) = to_process.pop() {
            let mb = &decoded.microblock;

            // 1. Hash chain continuity (except genesis)
            if mb.height > 0 {
                // v15.4 DIAG: mark verify stage as entering the prev-block
                // load. If the watchdog later observes verified counter
                // frozen with op=verify:load_prev_block, we know RocksDB
                // read on the parent height is hung — most likely point of
                // contention with apply-stage writes during macroblock
                // bursts. `load_start` instruments the read to log slow
                // tail latencies (>500 ms) without spamming on healthy
                // nodes.
                metrics.mark_verify_op(mb.height, PIPELINE_OP_VERIFY_LOAD_PREV);
                let load_start = std::time::Instant::now();
                // v15.6: Run the synchronous RocksDB read on the dedicated blocking
                // pool so it never starves a tokio worker. Under macroblock-burst
                // contention the same async worker also drives apply-stage state
                // mutations and consensus message handling — leaving the read on
                // the async path made a single hot-row scan stall every other
                // task on this thread for tens of seconds (observed at h=12247
                // with op_age_ms=21977). Spawn-blocking decouples the I/O
                // latency from runtime liveness and matches the pattern already
                // used at every other RocksDB hot-read site in this codebase.
                let storage_for_load = storage.clone();
                let parent_h = mb.height - 1;
                let load_result = match tokio::task::spawn_blocking(move || {
                    storage_for_load.load_microblock_auto_format(parent_h)
                }).await {
                    Ok(res) => res,
                    Err(join_err) => {
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] verify_load_prev_join_err h={} parent_h={} err={}",
                                mb.height, parent_h, join_err
                            );
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                };
                let load_elapsed = load_start.elapsed();
                if load_elapsed > std::time::Duration::from_millis(500) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] slow_storage_read stage=verify h={} parent_h={} elapsed_ms={}",
                            mb.height, mb.height - 1, load_elapsed.as_millis()
                        );
                    }
                }
                let prev_hash_ok = match load_result {
                    Ok(Some(prev_block)) => {
                        // Verify previous_hash matches actual prev block hash
                        let prev_hash = prev_block.hash();
                        mb.previous_hash == prev_hash
                    }
                    Ok(None) => {
                        // Capture height fields BEFORE moving `decoded` into
                        // the deferred map — `mb` is borrowed from `decoded`
                        // and would be invalidated by the move otherwise.
                        let child_h = mb.height;
                        let parent_h = mb.height - 1;
                        // Previous block not yet available — defer for retry.
                        // When parent arrives, this block will be re-checked.
                        if deferred.len() < DEFERRED_MAX {
                            if is_debug() {
                                println!("[DBG][PIPELINE] block_deferred h={} need_h={} buf={}",
                                         child_h, parent_h, deferred.len());
                            }
                            deferred.insert(child_h, decoded);
                        } else {
                            // Buffer full — drop oldest to make room
                            if is_info() {
                                println!("[INFO][PIPELINE] deferred_full h={} dropped (buf={})",
                                         child_h, DEFERRED_MAX);
                            }
                            metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        }

                        // ───────────────────────────────────────────────────
                        // v18: ACTIVE SYNC TRIGGER (storage gap recovery)
                        // ───────────────────────────────────────────────────
                        // Passive defer alone is insufficient under partial
                        // gossip propagation: if the parent never arrives via
                        // broadcast (peer offline, network partition healed
                        // mid-window, dropped shred), the deferred buffer
                        // fills with orphaned children and the gap stays
                        // open indefinitely — observed at h=180-241 with
                        // permanent block subsets like {1, 2, 211, 213,
                        // 214, ...}. Proactively request the missing parent
                        // from peers in parallel; the request is single-
                        // flighted per height and runs on a detached task,
                        // so the verify stage never blocks on network I/O.
                        //
                        // v19: SIZE-ADAPTIVE RECOVERY
                        // ───────────────────────────────────────────────────
                        // The v18 single-flight path is well-tuned for the
                        // small-gap regime (1–5 blocks of normal gossip
                        // jitter) but recovers a 30-block gap in about
                        // `gap × 30 s = 15 min`. For real catch-up windows
                        // we now switch to a single batched range request
                        // covering `local_tip+1 ..= child_h`, served by
                        // `unified_p2p::sync_blocks` in a single round-trip.
                        //
                        // The two paths are complementary, not redundant:
                        // - Small gap (≤ RANGE_SYNC_GAP_THRESHOLD): per-
                        //   height single-flight remains the cheapest
                        //   recovery and avoids range-fanout amplification
                        //   for transient gossip jitter.
                        // - Large gap (> threshold): batched range avoids
                        //   the multi-minute cascade. Single-flight per
                        //   range tuple prevents request storms when many
                        //   children for the same parent arrive at once.
                        // ───────────────────────────────────────────────────
                        let local_tip = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                            .load(Ordering::Relaxed);
                        let gap = child_h.saturating_sub(local_tip);
                        if gap > RANGE_SYNC_GAP_THRESHOLD {
                            // Large gap — fetch the entire missing range in one batch.
                            let from = local_tip.saturating_add(1);
                            let _ = request_missing_range(from, child_h);
                        } else {
                            // Small gap — keep the lighter per-height path.
                            let _ = request_missing_parent(parent_h);
                        }

                        // ───────────────────────────────────────────────────
                        // v18: WATCHDOG DIAGNOSTIC FIX
                        // ───────────────────────────────────────────────────
                        // Mark verify stage as IDLE on the deferral path so
                        // the watchdog does not report `verify_stuck` with
                        // a stale `op_age_ms` value (counter measured against
                        // the last `mark_verify_op` even though the operation
                        // logically completed via the deferral branch). Pre-
                        // v18 the verify_op timestamp stayed pinned to the
                        // first deferred block until a non-deferred block
                        // arrived, producing misleading multi-hour
                        // op_age_ms values in stalled-network logs.
                        // ───────────────────────────────────────────────────
                        metrics.mark_verify_idle();
                        continue;
                    }
                    Err(e) => {
                        if is_warn() {
                            println!("[WARN][PIPELINE] prev_load_err h={} err={}", mb.height, e);
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                };

                if !prev_hash_ok {
                    if is_warn() {
                        println!("[WARN][PIPELINE] hash_chain_break h={} from={} block_round={}",
                                 mb.height, decoded.from_peer, mb.timeout_round);
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);

                    // ═══════════════════════════════════════════════════════════════════════
                    // v16.2: OBSERVER-BASED BLOCK REJECTION + ADVISORY WITNESS
                    // ═══════════════════════════════════════════════════════════════════════
                    // Two parallel paths fire on every locally-detected hash chain
                    // break — each addresses a different recovery mechanism:
                    //
                    //   1. Source-witness counting (advisory): records `from_peer`
                    //      in the per-height witness DashMap and tags the source
                    //      for the fork-cooldown peer-selection helper. Useful for
                    //      operator visibility and resync-source steering, but
                    //      never destructive on its own (single-source ceiling).
                    //
                    //   2. Observer-based rejection (destructive): broadcasts a
                    //      Dilithium3-signed `BlockRejection` to all validator
                    //      peers, declaring "I, observer X, locally rejected
                    //      block_hash H from source S at height N because my
                    //      local prev was P, not block.previous_hash". Receivers
                    //      verify the observer signature, aggregate distinct
                    //      observer_ids per (height, source), and trigger
                    //      destructive rollback when the count crosses 2f+1.
                    //
                    // This is the BFT-canonical pattern — supermajority of
                    // INDEPENDENT OBSERVERS justifies state mutation. A single
                    // Byzantine source cannot trigger rollback against an honest
                    // chain because ≤f Byzantine observers cannot reach 2f+1.
                    //
                    // Non-genesis-only: skip for h=0 (no prev to compare against).
                    if mb.height > 0 {
                        record_hash_chain_break_witness(
                            mb.height,
                            &decoded.from_peer,
                        );

                        // Broadcast observer-side rejection if we have the P2P
                        // handle and this isn't a self-emitted block (a producer
                        // never rejects its own block — that path is the local
                        // signing failure, handled elsewhere).
                        if let Some(ref p2p) = unified_p2p {
                            if !decoded.from_peer.is_empty() && decoded.from_peer != "self" {
                                let rejected_hash = decoded.microblock.hash();
                                // Best-effort load of our local view of the
                                // parent for diagnostic purposes — receivers do
                                // not act on this field, it's purely evidence.
                                let local_prev_hash = match storage
                                    .load_microblock_auto_format(mb.height.saturating_sub(1))
                                {
                                    Ok(Some(local_prev)) => local_prev.hash(),
                                    _ => [0u8; 32],
                                };
                                let payload = format!(
                                    "QNET_BLOCK_REJECTION_V1:{}:{}:{}:{}:{}",
                                    node_id,
                                    mb.height,
                                    decoded.from_peer,
                                    hex::encode(&rejected_hash),
                                    hex::encode(&local_prev_hash)
                                );
                                let sig_bytes = if let Some(crypto) = crate::node::try_get_quantum_crypto() {
                                    match crypto
                                        .create_consensus_signature(
                                            &node_id,
                                            &payload,
                                        )
                                        .await
                                    {
                                        Ok(sig) => Some(sig.signature.as_bytes().to_vec()),
                                        Err(e) => {
                                            if is_warn() {
                                                println!(
                                                    "[WARN][REJECT] sign_failed h={} err={}",
                                                    mb.height, e
                                                );
                                            }
                                            None
                                        }
                                    }
                                } else {
                                    None
                                };
                                if let Some(sig) = sig_bytes {
                                    p2p.broadcast_block_rejection(
                                        mb.height,
                                        decoded.from_peer.clone(),
                                        rejected_hash,
                                        local_prev_hash,
                                        sig,
                                    );
                                }
                            }
                        }
                    }

                    continue;
                }
            }

            // 2. Timestamp validation (only in live mode — sync mode skips)
            // v14.8.11: three-check canonical timestamp model.
            //   (a) FUTURE:       block.ts ≤ wall_clock + TIMESTAMP_FUTURE_TOLERANCE
            //   (b) MEDIAN-PAST:  block.ts > median(last 11 on-chain timestamps)
            //   (c) MONOTONICITY: block.ts > parent.ts (enforced in step 1 hash chain)
            // Same ruleset is applied in `validate_received_microblock`; this
            // pipeline check catches bad blocks before they reach the apply
            // stage.
            let snap = coordinator.snapshot();
            if !snap.is_syncing() && mb.height > 0 {
                let now = crate::node::get_timestamp_safe();
                // (a) FUTURE check against raw wall clock: canonical design, so
                // an attacker cannot game the window via network-adjusted time.
                // TIMESTAMP_FUTURE_TOLERANCE = 7200 s (2 h) comfortably covers
                // realistic hypervisor / NTP events without letting Byzantine
                // inflation go unchecked.
                if mb.timestamp > now + crate::node::TIMESTAMP_FUTURE_TOLERANCE {
                    if is_warn() {
                        println!("[WARN][PIPELINE] future_block h={} delta=+{}s from={}",
                                 mb.height, mb.timestamp.saturating_sub(now), decoded.from_peer);
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                // (b) MEDIAN-PAST rule. Silently skipped during the first ~11
                // blocks after boot when the ring is undersized.
                // v15.15: height-ordered (BIP-113 canonical) — median is taken
                // over the parent-chain segment [mb.height - WINDOW, mb.height),
                // not over the last WINDOW insertions. Fixes false positives
                // during catch-up sync where blocks legitimately re-arrive in
                // non-height order.
                if let Some(median_past) = crate::node::median_past_timestamp_at_height(mb.height) {
                    if mb.timestamp <= median_past {
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] median_past_violation h={} ts={} median_past={} from={}",
                                mb.height, mb.timestamp, median_past, decoded.from_peer
                            );
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                }
            }

            // v22: cert presence gate REMOVED. Microblocks no longer carry a
            // rotation round (`mb.timeout_round` is always 0 — see
            // `node.rs::microblock_construction`). The previous gate existed to
            // require AggregatedTimeoutCert presence for round>0 microblocks;
            // the round>0 case is now structurally unreachable from honest
            // producers, and dishonest emitters are caught by the signature
            // gate immediately below. Macroblock layer retains its own 2f+1
            // commit-reveal finality — that path is unchanged.

            // 3. Signature verification
            // Genesis block (h=0) uses embedded self-signed keys — skip standard verification.
            // Every other height MUST carry a producer signature; empty sig is a hard reject.
            if mb.height > 0 {
                // MANDATORY signature: previously empty `mb.signature` slipped past
                // verification entirely (the surrounding `if !mb.signature.is_empty()`
                // wrapped the verify call but had no else branch — empty was implicit
                // accept). Honest producers always emit
                // "dilithium3_v4:<hex>" via `sign_microblock_with_dilithium`,
                // so an empty signature on a non-genesis block can only come from
                // a malformed or hostile sender. Reject hard.
                if mb.signature.is_empty() {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] sig_missing h={} prod={} from={} action=reject",
                            mb.height, mb.producer, decoded.from_peer
                        );
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }

                // v15.4 DIAG: mark op as signature verify. Dilithium3
                // verify is a sync C-binding called via an async
                // wrapper; if it ever blocks the runtime worker
                // thread under load, the watchdog will surface this
                // op as the stuck point.
                metrics.mark_verify_op(mb.height, PIPELINE_OP_VERIFY_SIG);
                let sig_start = std::time::Instant::now();
                let verify_ok = match BlockchainNode::verify_microblock_signature(
                    &decoded.microblock,
                    &decoded.microblock.producer,
                    None, // No P2P needed for sync verification
                ).await {
                    Ok(valid) => valid,
                    Err(e) => {
                        if is_warn() {
                            println!("[WARN][PIPELINE] sig_verify_err h={} err={}", mb.height, e);
                        }
                        false
                    }
                };

                let sig_elapsed = sig_start.elapsed();
                if sig_elapsed > std::time::Duration::from_millis(500) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] slow_signature_verify h={} elapsed_ms={}",
                            mb.height, sig_elapsed.as_millis()
                        );
                    }
                }
                if !verify_ok {
                    if is_warn() {
                        println!("[WARN][PIPELINE] sig_invalid h={} prod={} from={}",
                                 mb.height, mb.producer, decoded.from_peer);
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            }

            // ═══════════════════════════════════════════════════════════════════════════
            // 4. Producer authority check — v14.8.10 CANONICAL (same-round ≡ HARD reject)
            // ═══════════════════════════════════════════════════════════════════════════
            // Two categories of producer mismatch remain possible on ingest:
            //
            //   A. timeout_divergence: block.timeout_round != locally cached round.
            //      The cached `(expected_producer, expected_round)` pair was
            //      populated by the main loop using `get_current_timeout_round()`
            //      — the BFT-agreed `certified.max(adopted)` value. A remote
            //      producer may have produced at a different round because its
            //      view of HIGHEST_CERTIFIED_ROUND / HIGHEST_ADOPTED_ROUND had
            //      advanced by the time of signing, or because we have not yet
            //      received the signed votes that moved our local value. We do
            //      NOT re-derive the expected producer at the block's claimed
            //      round on ingest (that would require refreshing VRF state
            //      with the remote's pre-image), so we only log and let hash
            //      chain + signature + 2f+1 macroblock commit handle it.
            //
            //   B. same_round_mismatch: cached round == block.timeout_round, but
            //      block.producer != expected. The cache was populated by the
            //      deterministic VRF formula `(base_idx + timeout_round) % N`,
            //      which is the same formula every honest validator uses. A
            //      block claiming this rank MUST be signed by the cached
            //      producer — any other signer does not have authority for
            //      that slot. HARD REJECT.
            //
            // Historical note: rejecting on producer mismatch was blamed for
            // forks in v13.3 because the expected-producer cache at that time
            // depended on LOCAL non-deterministic state. Under v14.8.10 the
            // cache is populated from the stored BFT-agreed round, which is a
            // pure function of Dilithium3-verified signed votes and on-chain
            // VRF state — every validator at the same height & round derives
            // the same expected producer. Hard rejection is therefore
            // consistent across honest validators: either all reject the block,
            // or none do. No fork.
            //
            // Gated to `!is_syncing()` so historical blocks received during
            // catch-up aren't judged against the live cache.
            //
            // Scalability: O(1) cache lookup. Identical cost at 5 or 5000 validators.
            if !snap.is_syncing() && mb.height > 0 {
                // ═══════════════════════════════════════════════════════════════
                // v23.1: BFT-CERTIFIED ROUND AUTHENTICITY GATE
                // ═══════════════════════════════════════════════════════════════
                // A block claims to have been produced at rotation round
                // `mb.timeout_round`. Verify the claim is plausible against
                // this node's local view of supermajority-certified rounds
                // for the containing macroblock.
                //
                // Allow a small forward drift (TIMEOUT_ROUND_DRIFT_WINDOW)
                // to absorb honest gossip propagation latency — a producer
                // can legitimately see 2f+1 votes for round R before this
                // node's local DashMap has been updated by the same gossip
                // stream. After the drift window, the claim is implausibly
                // far ahead of any cert this node could ever have seen,
                // so it must come from a Byzantine signer (authentic
                // producer with valid Dilithium3 key but signing an
                // unsupportable claim).
                //
                // Why this matters
                // ────────────────
                // After v23.1's timeout_round binding in hash+signature
                // (block.rs:hash, sign_microblock_with_dilithium), the
                // producer's claim is CRYPTOGRAPHICALLY ATTESTED — it
                // cannot be mutated in transit. But a Byzantine producer
                // can still SIGN an arbitrary round claim. Without this
                // gate, downstream code (notably `record_finalized_round`
                // called at apply) would advance `LAST_FINALIZED_ROUND_PER_MB`
                // to the Byzantine value, locking out future rotation
                // until 2f+1 honest evidence catches up to the inflated
                // baseline. This is a DoS class — bounded here.
                //
                // The v15.0 `rotation_backfill_request` path below still
                // fires as a soft signal: if the producer's claim is
                // legitimate (cert exists somewhere), peer-side retrieval
                // catches our local certified up to match.
                //
                // Drift window = 3: covers ~3 gossip RTTs at the
                // 1000-validator committee cap (log_5 propagation depth
                // ≈ 4 hops × ~50ms each = 200ms; cross-region asymmetry
                // could extend this to ~1s; 3 rounds × 5s emit grace
                // covers the worst-case propagation race).
                //
                // Scalability: one O(1) DashMap read per block ingest.
                // Identical cost at 5 or 10 000 super-nodes.
                // ═══════════════════════════════════════════════════════════════
                const TIMEOUT_ROUND_DRIFT_WINDOW: u64 = 3;
                let mb_idx = mb.height / 90;
                let local_certified =
                    crate::unified_p2p::highest_certified_round_for(mb_idx);
                if mb.timeout_round > local_certified.saturating_add(TIMEOUT_ROUND_DRIFT_WINDOW) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] timeout_round_implausible h={} mb={} claimed={} local_certified={} drift_window={} action=hard_reject from={}",
                            mb.height, mb_idx, mb.timeout_round,
                            local_certified, TIMEOUT_ROUND_DRIFT_WINDOW,
                            decoded.from_peer,
                        );
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }

                if let Some((expected, expected_round)) = crate::node::get_expected_producer(mb.height) {
                    if mb.producer != expected {
                        if mb.timeout_round != expected_round {
                            // Category A: Timeout divergence — different round claimed.
                            // Bounded above by the v23.1 authenticity gate; this branch
                            // covers honest gossip-window divergence (within drift) where
                            // the claim is plausible but doesn't match our cached view.
                            // Signature + hash chain + macroblock 2f+1 commit still enforce
                            // correctness; the BFT-driven rotation converges once vote
                            // gossip propagates.
                            if is_info() {
                                println!("[INFO][PIPELINE] timeout_divergence h={} our_round={} block_round={} our_prod={} block_prod={}",
                                         mb.height, expected_round, mb.timeout_round, expected, mb.producer);
                            }
                        } else {
                            // Category B: same rank, DIFFERENT producer → unauthorised.
                            // HARD REJECT — producer did not earn this slot per VRF.
                            if is_warn() {
                                println!(
                                    "[WARN][PIPELINE] producer_unauthorised_reject h={} round={} expected={} got={} from={}",
                                    mb.height, expected_round, expected, mb.producer, decoded.from_peer
                                );
                            }
                            metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                    }
                }
            }

            // ═══════════════════════════════════════════════════════════════════════════
            // v14.8.6: INGEST-SIDE STALE-ROUND REJECT REMOVED (semantic bug fix)
            // ═══════════════════════════════════════════════════════════════════════════
            // Earlier revisions (v14.6 → v14.8.5) compared an incoming microblock's
            // `timeout_round` against this node's cached `HIGHEST_CERTIFIED_ROUND` for
            // the containing macroblock index and rejected any block whose round was
            // lower. That check mixed TWO INDEPENDENT DOMAINS:
            //
            //   * `mb.timeout_round`       — microblock producer-rotation counter.
            //                                0 on the happy path (first producer ok),
            //                                increments only when this particular slot
            //                                was skipped and a failover leader signed.
            //
            //   * `HIGHEST_CERTIFIED_ROUND[mb_idx]` — view round of the MACROBLOCK
            //                                commit/reveal consensus (90-block epoch).
            //                                Advances on macroblock-level timeouts when
            //                                2f+1 is temporarily unreachable, entirely
            //                                decoupled from microblock production.
            //
            // These counters are orthogonal by design. A healthy producer will sign
            // microblocks at round=0 all day long while, simultaneously, macroblock
            // view changes may have escalated certified_round to N>0 because the
            // epoch's 2f+1 aggregator is flaky. Rejecting valid microblocks because
            // `0 < N` breaks liveness without adding safety. The canonical rule is
            // to compare rounds only WITHIN the same consensus domain; cross-domain
            // comparison is never valid.
            //
            // Safety for microblocks is preserved by four independent invariants
            // which remain in force:
            //   1. Dilithium3 producer signature   — checked above at step 3.
            //   2. `prev_hash` continuity          — checked above at step 2.
            //   3. VRF-deterministic producer      — soft-check at step 4 (logs
            //                                        timeout_divergence / producer
            //                                        mismatch without rejecting).
            //   4. 2f+1 macroblock commit/reveal   — retroactively ratifies every
            //                                        microblock below the epoch
            //                                        boundary; any split-brain
            //                                        branch cannot collect 2f+1.
            //
            // v22 update: the legacy producer-side pre-save `yield_stale_round`
            // guard (v15.11) was deleted alongside the round-based microblock
            // failover model. v22 microblock production is pure VRF + time-
            // derived skip-slot offset; there is exactly ONE valid producer
            // per height, so the cross-domain comparison the guard relied on
            // is no longer meaningful. Safety on the producer's own path is
            // preserved by deterministic VRF expectation (`get_expected_producer`)
            // + Dilithium3 self-signature + hash-chain continuity.
            // ═══════════════════════════════════════════════════════════════════════════

            // v14.7.2: per-microblock pipelined-QC verify REMOVED.
            // BFT safety for microblocks is delivered by the combination of:
            //   1. Dilithium3 producer signature (identity binding);
            //   2. hash-chain continuity (parent_hash check above);
            //   3. Deterministic VRF-derived `expected_producer` (Category B
            //      ingest reject; v22 collapse left a single valid signer per
            //      slot, so any second candidate is invalid by construction);
            //   4. 2f+1 macroblock commit/reveal at the 90-block boundary
            //      that hard-finalises and, by implication, retroactively
            //      ratifies every microblock below it.
            // A per-block QC is redundant with (4) and was also the source
            // of a production rate-limit collision. Removed.

            // ═══════════════════════════════════════════════════════════════════════════
            // 4b. INTERNAL-ONLY TRANSACTION TYPE GUARD (post-genesis)
            // ═══════════════════════════════════════════════════════════════════════════
            // Some transaction types are produced ONLY by genesis-block construction
            // (CreateAccount with mint) or are deprecated enum variants that should
            // never appear at all. A Byzantine producer could construct a block that
            // bypasses mempool admission and directly contains such a TX — this
            // backstop rejects the entire block at ingest time.
            //
            // ALLOWED in genesis (height == 0): CreateAccount (initial supply setup).
            // ALLOWED ONLY in genesis: nothing else from the deprecated set.
            //
            // REJECTED post-genesis (height > 0):
            //   * CreateAccount       — locked to genesis bootstrap
            //   * BatchRewardClaims   — deprecated, never instantiated
            //   * BatchNodeActivations — deprecated, never instantiated
            //   * BatchTransfers      — unused enum variant
            //
            // SAFETY: this is a HARD REJECT of the whole block, not just the
            // offending transaction. Including a forbidden TX is a sign of a
            // malicious producer; the block is unsafe to apply, and the peer
            // sending it accumulates negative reputation.
            //
            // SCALABILITY: O(tx_count) per block, single match per TX. Bounded
            // identical at 5 or 5000 validators.
            // ═══════════════════════════════════════════════════════════════════════════
            if mb.height > 0 {
                for tx in &decoded.microblock.transactions {
                    let forbidden = matches!(tx.tx_type,
                        qnet_state::TransactionType::CreateAccount { .. } |
                        qnet_state::TransactionType::BatchRewardClaims { .. } |
                        qnet_state::TransactionType::BatchNodeActivations { .. } |
                        qnet_state::TransactionType::BatchTransfers { .. }
                    );
                    if forbidden {
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] forbidden_tx_type_in_block h={} tx_type_discriminant={:?} producer={} from_peer={} action=reject_block",
                                mb.height,
                                std::mem::discriminant(&tx.tx_type),
                                mb.producer,
                                decoded.from_peer
                            );
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        // Continue 'outer-style: drop this block entirely. We don't
                        // strip the offending TX because that would mutate a block
                        // already producer-signed; instead we discard the block and
                        // sync_manager will refetch the canonical version from a
                        // different peer.
                        continue 'outer;
                    }
                }
            }

            // ═══════════════════════════════════════════════════════════════════════════
            // 5. PER-TRANSACTION SIGNATURE VERIFICATION (post-genesis only)
            // ═══════════════════════════════════════════════════════════════════════════
            // SECURITY INVARIANT: every user-submitted transaction inside the block
            // MUST carry a cryptographically valid Ed25519 signature (and Dilithium3
            // when present). Without this check, a Byzantine producer could include
            // forged transactions that drain arbitrary wallets — the producer's own
            // block signature (step 3) authenticates the BLOCK envelope but says
            // nothing about whether the transactions WITHIN the block were authorised
            // by their senders.
            //
            // GENESIS BYPASS (mb.height == 0):
            //   The genesis block is a one-time deterministic bootstrap whose content
            //   is fixed by network configuration (genesis distribution, system
            //   account creation, genesis-node registration). Its in-block TXs use
            //   literal-string authorisation tokens ("system", "genesis") that
            //   pre-date the Ed25519 client-signing model — they are NOT real
            //   Ed25519 signatures. Authority is enforced at apply time by string
            //   match against the well-known reserved sender set.
            //
            //   Genesis safety is guaranteed by THREE independent invariants that
            //   do NOT require per-TX signature verification:
            //     1. Producer signature (step 3) — the genesis producer's
            //        Dilithium3 signature on the BLOCK envelope is verified.
            //     2. Genesis-hash determinism — every honest node computes the
            //        identical genesis block from the identical config, so any
            //        deviation (extra TX, modified amount, swapped recipient)
            //        is rejected by hash-chain continuity at the next block.
            //     3. One-time event — genesis runs exactly once at network
            //        bootstrap, height==0; no reusable attack surface exists.
            //
            //   Skipping per-TX signature verification at height==0 therefore
            //   loses no real security property while restoring the legitimate
            //   bootstrap path. All blocks at height>0 receive full per-TX
            //   verification, closing the byzantine-producer drain vector that
            //   motivated this section.
            //
            // WHY THIS LIVES IN THE PIPELINE, NOT THE STATE LAYER:
            //   * Mempool ingestion already verifies signatures before admission
            //     (verify_ed25519_batch in node.rs). That covers the user-submitted
            //     path: TX → RPC → mempool → producer.
            //   * Block ingestion bypasses the local mempool entirely: a remote
            //     producer's block contains TXs that THIS node never validated.
            //     Without a verification step here, those TXs reach state-apply
            //     unchecked. apply_transaction_lazy in state.rs intentionally does
            //     NOT verify signatures (single-responsibility — it applies state
            //     mutations on already-validated TXs, and re-checking inside the
            //     state lock would serialise verification needlessly).
            //   * Therefore signature verification of in-block TXs is the ingest
            //     pipeline's responsibility. This step closes the gap.
            //
            // SCOPE — WHAT IS VERIFIED:
            //   * Ed25519 batch verify for every TX with `tx.signature.is_some()`.
            //   * Dilithium3 verify for every TX with `tx.dilithium_signature.is_some()`.
            //   * SYSTEM TXs (RewardDistribution from system_emission, CreateAccount
            //     bootstrap, BatchRewardClaims, BatchNodeActivations) are exempt —
            //     they are signed at block-construction time by the producer and
            //     validated against on-chain proofs (1DEV burn, 2f+1 macroblock
            //     evidence, ping commitment chain) elsewhere in the apply path.
            //     The same exemption set is mirrored from `verify_ed25519_batch`
            //     in node.rs to keep the mempool and ingest paths consistent.
            //
            // SCOPE — WHAT IS NOT VERIFIED HERE:
            //   * Nonce, balance, business-logic checks remain in apply stage where
            //     account state is mutated atomically.
            //   * Replay protection is enforced by per-account nonce monotonicity
            //     in apply_to_state — a replayed signed TX still fails on nonce.
            //
            // PERFORMANCE:
            //   * Ed25519 batch verify is ~5-10 ms per 100-TX block (negligible
            //     against the 1-second slot budget). The batch path uses the same
            //     `verify_ed25519_batch` helper as mempool admission so the cost
            //     curve and CPU profile are identical to the well-understood
            //     gossip-ingest path.
            //   * Dilithium3 individual verify is ~3 ms per signature; only runs
            //     for TXs that opted into post-quantum signing. At committee=128
            //     and 100 TXs of which ~5 are hybrid, this adds ~15 ms — bounded.
            //   * The check runs OFF the apply-stage state lock, so it never
            //     blocks block application or state mutation paths.
            //
            // SCALABILITY (thousands of validators):
            //   * Verification cost is per-block, not per-validator. Every node
            //     verifies its own ingest stream independently — no cross-node
            //     coordination, no extra gossip traffic. O(tx_count) per block,
            //     identical at 5 or 5000 validators.
            //   * Batch verification amortises elliptic-curve operations across
                //     all signed TXs in a block, multiplying throughput vs naïve
            //     per-TX verification.
            //
            // ═══════════════════════════════════════════════════════════════════════════
            if mb.height == 0 {
                if is_info() {
                    println!(
                        "[INFO][PIPELINE] genesis_block_skip_tx_sig h=0 txs={} producer={}",
                        decoded.microblock.transactions.len(),
                        mb.producer
                    );
                }
            } else if !decoded.microblock.transactions.is_empty() {
                metrics.mark_verify_op(mb.height, PIPELINE_OP_VERIFY_SIG);
                let txsig_start = std::time::Instant::now();

                // Ed25519 batch verification (shared helper with mempool path).
                // Returns the indices of TXs whose Ed25519 sig verified OR which
                // are in the system-TX exempt set. Any TX index NOT in the
                // returned set has either a missing or invalid Ed25519 sig.
                let valid_indices = crate::node::BlockchainNode::verify_ed25519_batch(
                    &decoded.microblock.transactions,
                );
                let valid_set: std::collections::HashSet<usize> =
                    valid_indices.into_iter().collect();

                let total_txs = decoded.microblock.transactions.len();
                if valid_set.len() != total_txs {
                    let invalid_count = total_txs - valid_set.len();
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] tx_sig_invalid h={} invalid={}/{} producer={} from={} action=reject_block",
                            mb.height, invalid_count, total_txs, mb.producer, decoded.from_peer
                        );
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue; // HARD REJECT — Byzantine producer included forged TXs
                }

                // Dilithium3 verification for TXs that opted into PQ signing.
                // Inline to avoid a second helper call: we only iterate over
                // the small subset with `dilithium_signature.is_some()`.
                let mut dilithium_invalid = 0usize;
                for (idx, tx) in decoded.microblock.transactions.iter().enumerate() {
                    if tx.dilithium_signature.is_none() {
                        continue;
                    }
                    let dilithium_sig = match &tx.dilithium_signature {
                        Some(s) if !s.is_empty() => s,
                        _ => continue, // empty sig is treated as absent
                    };
                    let dilithium_pk = match &tx.dilithium_public_key {
                        Some(p) if !p.is_empty() => p,
                        _ => {
                            // Has dilithium_signature but no dilithium_public_key —
                            // malformed TX, reject the block.
                            if is_warn() {
                                println!(
                                    "[WARN][PIPELINE] dilithium_pk_missing h={} tx_idx={} producer={} action=reject_block",
                                    mb.height, idx, mb.producer
                                );
                            }
                            dilithium_invalid += 1;
                            continue;
                        }
                    };

                    let sig_bytes = match hex::decode(dilithium_sig) {
                        Ok(b) if b.len() == 3309 => b, // ML-DSA-65 detached sig
                        _ => {
                            dilithium_invalid += 1;
                            continue;
                        }
                    };
                    let pk_bytes = match hex::decode(dilithium_pk) {
                        Ok(b) if b.len() == 1952 => b, // ML-DSA-65 public key
                        _ => {
                            dilithium_invalid += 1;
                            continue;
                        }
                    };

                    use pqcrypto_mldsa::mldsa65 as dilithium3;
                    use pqcrypto_traits::sign::PublicKey as PkTrait;
                    use pqcrypto_traits::sign::DetachedSignature as SigTrait;

                    let pk = match dilithium3::PublicKey::from_bytes(&pk_bytes) {
                        Ok(p) => p,
                        Err(_) => { dilithium_invalid += 1; continue; }
                    };
                    let sig = match dilithium3::DetachedSignature::from_bytes(&sig_bytes) {
                        Ok(s) => s,
                        Err(_) => { dilithium_invalid += 1; continue; }
                    };

                    // Canonical message — same builder used by RPC validation
                    // path so the signed bytes are byte-identical across all
                    // verification sites.
                    let message = crate::node::BlockchainNode::build_canonical_verify_message(tx);

                    if dilithium3::verify_detached_signature(&sig, message.as_bytes(), &pk).is_err() {
                        dilithium_invalid += 1;
                    }
                }

                if dilithium_invalid > 0 {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] dilithium_invalid h={} count={} producer={} from={} action=reject_block",
                            mb.height, dilithium_invalid, mb.producer, decoded.from_peer
                        );
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue; // HARD REJECT — Byzantine producer with bad PQ sigs
                }

                let txsig_elapsed = txsig_start.elapsed();
                if txsig_elapsed > std::time::Duration::from_millis(100) {
                    if is_info() {
                        println!(
                            "[INFO][PIPELINE] tx_sig_verify h={} txs={} elapsed_ms={}",
                            mb.height, total_txs, txsig_elapsed.as_millis()
                        );
                    }
                }
            }

            // All checks passed — forward to apply stage
            let block_height = decoded.height; // Copy before move
            let verified = VerifiedBlock {
                height: block_height,
                decompressed: decoded.decompressed,
                microblock: decoded.microblock,
                from_peer: decoded.from_peer,
            };

            metrics.verified.fetch_add(1, Ordering::Relaxed);

            if block_height <= 5 || block_height % 100 == 0 {
                if is_info() {
                    println!("[INFO][PIPELINE] verified h={} prod={} txs={}",
                             verified.height, verified.microblock.producer,
                             verified.microblock.transactions.len());
                }
            }

            // v15.4 DIAG: mark verify→apply send. If apply's mpsc receiver
            // is full because apply itself is hung on RocksDB or state
            // lock, this await will block. Watchdog reading op=verify:
            // send_to_apply with a stuck `applied` counter implicates
            // apply-stage backpressure as the root cause.
            metrics.mark_verify_op(block_height, PIPELINE_OP_VERIFY_SEND);
            let send_start = std::time::Instant::now();
            if let Err(_) = tx.send(verified).await {
                break 'outer;
            }
            let send_elapsed = send_start.elapsed();
            if send_elapsed > std::time::Duration::from_millis(500) {
                if is_warn() {
                    println!(
                        "[WARN][PIPELINE] slow_send_to_apply h={} elapsed_ms={} (apply-stage backpressure)",
                        block_height, send_elapsed.as_millis()
                    );
                }
            }
            metrics.mark_verify_idle();

            // v13.1: Drain deferred chain — the block we just verified may unblock
            // a sequence of deferred blocks: h+1 → h+2 → h+3 ...
            // This turns O(N*M) retry into O(N) sequential drain.
            let mut next = block_height + 1;
            while let Some(def) = deferred.remove(&next) {
                to_process.push(def);
                next += 1;
            }

            } // end while let Some(decoded) = to_process.pop()

            // Periodic deferred cleanup: evict entries older than 500 blocks behind tip
            if deferred.len() > 100 {
                let chain_h = storage.get_chain_height().unwrap_or(0);
                if chain_h > 500 {
                    let cutoff = chain_h - 500;
                    let before = deferred.len();
                    deferred.retain(|h, _| *h > cutoff);
                    let evicted = before - deferred.len();
                    if evicted > 0 {
                        // v15.3: register eviction in dedicated counter so the
                        // backpressure formula can subtract these from the
                        // in-flight estimate. Without this, evicted blocks
                        // remained "ingested but never finished" forever and
                        // contributed to the false-overload signal that
                        // throttled sync request dispatch.
                        metrics.deferred_evicted.fetch_add(evicted as u64, Ordering::Relaxed);
                        if is_info() {
                            println!("[INFO][PIPELINE] deferred_evict count={} cutoff={} remaining={}",
                                     evicted, cutoff, deferred.len());
                        }
                    }
                }
            }
        }
    }

    // ========================================================================
    // STAGE 3: APPLY
    // ========================================================================
    // Sequential: applies transactions to state, saves block to RocksDB,
    // handles ALL side effects, notifies coordinator.
    //
    // This stage MUST be single-threaded — RocksDB writes and state updates
    // must be ordered by height. The verify stage guarantees blocks arrive
    // in valid order.
    //
    // Side effects (matching process_received_blocks):
    //   - Block snapshot for rollback on state_root mismatch
    //   - apply_block_to_state: rewards, emissions, registrations
    //   - State root verification
    //   - Deferred side effects: pool3, registrations, emissions, reward clears
    //   - VRF key extraction from NodeRegistration TXs
    //   - Block attestation broadcasting (when synced)
    //   - Height updates: RAM + RocksDB + LOCAL_BLOCKCHAIN_HEIGHT atomic
    //   - Block event broadcasting (for consensus listener)
    //   - Coordinator notification (BlockApplied event)
    //   - Pending sync cleanup
    // ========================================================================

    async fn apply_stage(
        mut rx: mpsc::Receiver<VerifiedBlock>,
        ctx: ApplyContext,
        metrics: Arc<PipelineMetrics>,
    ) {
        while let Some(block) = rx.recv().await {
            let height = block.height;
            let producer = block.microblock.producer.clone();
            let tx_count = block.microblock.transactions.len();

            // v15.4 DIAG: mark dedup check. Sync RocksDB read on the apply
            // path; if hung, watchdog will surface it.
            metrics.mark_apply_op(height, PIPELINE_OP_APPLY_DEDUP);
            let dedup_start = std::time::Instant::now();
            // v15.6: Dedup check runs on the blocking pool. The RocksDB lookup
            // on a hot row competes with the same column family the apply
            // stage writes to a few microseconds later; running it on the
            // async path made one slow read freeze the entire stage. The
            // tokio::task::spawn_blocking handoff is cheap (single channel
            // hop) and isolates this I/O from runtime liveness.
            let storage_for_dedup = ctx.storage.clone();
            let already_applied = match tokio::task::spawn_blocking(move || {
                storage_for_dedup.load_microblock(height)
                    .map(|opt| opt.is_some())
                    .unwrap_or(false)
            }).await {
                Ok(v) => v,
                Err(join_err) => {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] apply_dedup_join_err h={} err={}",
                            height, join_err
                        );
                    }
                    false
                }
            };
            let dedup_elapsed = dedup_start.elapsed();
            if dedup_elapsed > std::time::Duration::from_millis(500) {
                if is_warn() {
                    println!(
                        "[WARN][PIPELINE] slow_storage_read stage=apply op=dedup h={} elapsed_ms={}",
                        height, dedup_elapsed.as_millis()
                    );
                }
            }
            if already_applied {
                metrics.duplicates_skipped.fetch_add(1, Ordering::Relaxed);
                crate::unified_p2p::clear_block_pending_sync(height);
                metrics.mark_apply_idle();
                continue;
            }

            // ── State application with snapshot + rollback support ──
            // v15.4 DIAG: mark state-lock acquisition. If a competing
            // writer holds the state RwLock for an extended period
            // (e.g., a slow snapshot operation in BlockchainNode), this
            // ────────────────────────────────────────────────────────────────
            // v15.10 STAGE-2: PRE-WARM ACCOUNT CACHE
            // ────────────────────────────────────────────────────────────────
            // Before we acquire the state write lock and start mutating
            // accounts, walk the block's transactions and ensure every
            // address the apply path will touch is resident in the
            // in-memory account map. Addresses that are already cached
            // get a refreshed `last_access` timestamp; cold addresses
            // are loaded from disk via the `AccountStore` fallback (read
            // path is lock-free and concurrent-safe).
            //
            // Rationale: with a bounded cache, the apply path's
            // `accounts.get_mut(from)` would fail for any cold sender
            // address. Pre-warming under a READ lock guarantees the
            // working set is resident at the moment the WRITE lock is
            // taken, while keeping the disk-read latency outside the
            // critical section.
            //
            // Cost (typical block, ~100-1000 TX):
            //   * ≤ 2 × tx_count point reads on the `accounts` CF
            //   * RocksDB SSD ~50-100 µs per read
            //   * ≤ 100 ms total — runs concurrent with other apply
            //     paths (reader lock allows fan-out).
            // ────────────────────────────────────────────────────────────────
            {
                use std::collections::HashSet;
                let mut warm_set: HashSet<String> = HashSet::new();
                for tx in &block.microblock.transactions {
                    if !tx.from.is_empty() {
                        warm_set.insert(tx.from.clone());
                    }
                    if let qnet_state::TransactionType::Transfer { to, .. } = &tx.tx_type {
                        if !to.is_empty() {
                            warm_set.insert(to.clone());
                        }
                    }
                }
                if !warm_set.is_empty() {
                    let warm_vec: Vec<String> = warm_set.into_iter().collect();
                    let sg_warm = ctx.state.read().await;
                    let hit = sg_warm.warm_accounts(&warm_vec);
                    drop(sg_warm);
                    if is_debug() {
                        println!(
                            "[DBG][PIPELINE] account_warm h={} requested={} resident={}",
                            height, warm_vec.len(), hit,
                        );
                    }
                }
            }

            // op will be the stuck point.
            metrics.mark_apply_op(height, PIPELINE_OP_APPLY_STATE_LOCK);
            let lock_start = std::time::Instant::now();
            let apply_ok = {
                let state_guard = ctx.state.write().await;
                let lock_elapsed = lock_start.elapsed();
                if lock_elapsed > std::time::Duration::from_millis(500) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] slow_state_lock h={} elapsed_ms={}",
                            height, lock_elapsed.as_millis()
                        );
                    }
                }

                // Genesis block: clear state first (idempotent)
                if height == 0 {
                    let existing = state_guard.account_count();
                    if existing > 0 {
                        if is_info() { println!("[INFO][PIPELINE] genesis_clear_state accounts={}", existing); }
                        state_guard.clear();
                    }
                }

                // Create block snapshot for rollback (only for blocks with state_root)
                let has_state_root = block.microblock.state_root != [0u8; 32];
                // v15.4 DIAG: snapshot creation copies relevant account
                // state — bounded but non-trivial work.
                metrics.mark_apply_op(height, PIPELINE_OP_APPLY_SNAPSHOT);
                let snap_start = std::time::Instant::now();
                let mut block_snapshot = if has_state_root {
                    Some(state_guard.create_block_snapshot(height))
                } else {
                    None
                };
                let snap_elapsed = snap_start.elapsed();
                if snap_elapsed > std::time::Duration::from_millis(500) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] slow_create_snapshot h={} elapsed_ms={}",
                            height, snap_elapsed.as_millis()
                        );
                    }
                }

                // Get processed emission MBs for double-emission prevention
                let processed_emission_set = {
                    let reward_mgr = ctx.reward_manager.read().await;
                    reward_mgr.get_processed_emission_macroblocks().clone()
                };

                // v15.4 DIAG: state mutation phase — applies all
                // transactions and updates accounts. Heavy CPU but no
                // I/O, so unlikely to hang from external contention.
                metrics.mark_apply_op(height, PIPELINE_OP_APPLY_STATE);
                let apply_state_start = std::time::Instant::now();
                // Apply all state mutations via shared function
                let apply_result = BlockchainNode::apply_block_to_state(
                    &state_guard,
                    &block.microblock,
                    &ctx.storage,
                    block_snapshot.as_mut(),
                    Some(&processed_emission_set),
                );
                let apply_state_elapsed = apply_state_start.elapsed();
                if apply_state_elapsed > std::time::Duration::from_millis(500) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] slow_apply_state h={} txs={} elapsed_ms={}",
                            height, tx_count, apply_state_elapsed.as_millis()
                        );
                    }
                }

                let computed_state_root = apply_result.merkle_root;

                // State root verification
                if has_state_root && computed_state_root != block.microblock.state_root {
                    eprintln!("[ERR][PIPELINE] state_root_mismatch h={} from={} expected={} computed={}",
                             height,
                             block.from_peer,
                             hex::encode(&block.microblock.state_root[..8]),
                             hex::encode(&computed_state_root[..8]));

                    // Rollback to pre-block state
                    if let Some(ref snapshot) = block_snapshot {
                        state_guard.rollback_block(snapshot);
                        if is_info() { println!("[INFO][PIPELINE] block_rollback h={}", height); }
                    }
                    metrics.apply_failed.fetch_add(1, Ordering::Relaxed);
                    crate::unified_p2p::clear_block_pending_sync(height);

                    // v14.8: Per-peer local quarantine — repeated state_root
                    // mismatches from the same peer signal either (a) the
                    // peer is on a different fork, or (b) the peer is
                    // actively hostile. Either way, stop wasting apply
                    // cycles on them for a cooldown window. This is a
                    // LOCAL defense; on-chain slashing still happens via
                    // the macroblock analyze_chain_for_slashing path.
                    if let Some(ref p2p) = ctx.unified_p2p {
                        p2p.record_apply_strike(&block.from_peer, "state_root_mismatch");
                    }
                    metrics.mark_apply_idle();
                    continue;
                }

                // v14.8: Successful apply — clear any past strikes for this peer.
                if let Some(ref p2p) = ctx.unified_p2p {
                    p2p.record_apply_success(&block.from_peer);
                }

                // State verified — save block.
                // v15.6: RocksDB writes go through the blocking pool. Macroblock
                // bursts trigger background compactions that can stall foreground
                // writes for hundreds of milliseconds; running save on the async
                // path made the entire pipeline freeze under that contention.
                // The decompressed bytes are moved into the closure (zero copy
                // overhead beyond the Arc clone for storage); set_chain_height
                // follows immediately so both writes share the same blocking
                // context and complete before the apply slot is released.
                metrics.mark_apply_op(height, PIPELINE_OP_APPLY_SAVE_BLOCK);
                let save_start = std::time::Instant::now();
                let storage_for_save = ctx.storage.clone();
                let block_bytes_for_save = block.decompressed.clone();
                let save_result = match tokio::task::spawn_blocking(move || {
                    storage_for_save.save_microblock(height, &block_bytes_for_save)
                }).await {
                    Ok(res) => res,
                    Err(join_err) => {
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] apply_save_join_err h={} err={}",
                                height, join_err
                            );
                        }
                        Err(crate::errors::IntegrationError::StorageError(format!("join error: {}", join_err)))
                    }
                };
                let save_elapsed = save_start.elapsed();
                if save_elapsed > std::time::Duration::from_millis(500) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] slow_storage_write op=save_microblock h={} elapsed_ms={} bytes={}",
                            height, save_elapsed.as_millis(), block.decompressed.len()
                        );
                    }
                }
                match save_result {
                    Ok(()) => {
                        // v15.11: Record finalized round so the next height in
                        // this macroblock starts with a clean baseline. Mirrors
                        // the producer-side recording — every honest validator
                        // applying the same block records the same baseline,
                        // keeping per-mb effective rounds in sync across the
                        // committee.
                        crate::unified_p2p::record_finalized_round(
                            height / 90,
                            block.microblock.timeout_round,
                        );

                        // ═══════════════════════════════════════════════════════════════════════════
                        // v15.12 L1: PEER-APPLY MEMPOOL CLEANUP — closes the cross-block dedup gap
                        // ═══════════════════════════════════════════════════════════════════════════
                        // Forensic case h=14351 → h=14461:
                        //   Block 14351 (producer=node_004) included 5 HeartbeatCommitments.
                        //   Every other validator applied that block via this pipeline path,
                        //   but the v15.5 mempool cleanup hook lived ONLY on the producer-side
                        //   block-construction path (node.rs:21199 `block_produced_cleanup`).
                        //   Result: peer validators kept the same 5 TXs in their local mempools,
                        //   so when one of them (node_002) became producer at h=14461 it pulled
                        //   the same 5 commitments from its mempool again and re-included them
                        //   in the block. State-level `check_duplicate_commitment` rejected the
                        //   apply (good — no double accounting), but the TX bytes still
                        //   occupied block storage and produced visible duplicates in the
                        //   explorer + a 75 KB / block bandwidth tax for every subsequent
                        //   producer until mempool TTL eviction kicked in.
                        //
                        // Industry-grade fix:
                        //   Mempool cleanup must fire on EVERY block apply event — both the
                        //   producer-side path (already covered in `node.rs::start_microblock_production`)
                        //   AND this peer-side pipeline path. Symmetric semantics: once a TX is
                        //   on chain, no honest validator's mempool should re-offer it for
                        //   inclusion in any subsequent block.
                        //
                        // Also stamps `record_included_txs` so any in-flight gossip carrying a
                        // late copy of the same TX hash gets dropped at the next admission
                        // attempt (already-included guard in `SimpleMempool::add_*`).
                        //
                        // Scalability:
                        //   * O(tx_count) hash compute + 1 batched DashMap remove per apply.
                        //     Typical block: 0-50 TXs → microseconds. Genesis-mesh emission
                        //     boundary peak ~150 TXs → still sub-millisecond.
                        //   * Runs on the apply task's tokio thread inline — no blocking I/O,
                        //     no extra task spawn, no inter-task signalling.
                        //   * Safe at thousands of super-node committee size: the mempool's
                        //     per-receive replacement (`replace_or_register_commitment`) and
                        //     this cleanup form a closed-loop invariant that bounds mempool
                        //     occupancy to (active_validators × commitment_types) regardless
                        //     of total network size.
                        // ═══════════════════════════════════════════════════════════════════════════
                        if !block.microblock.transactions.is_empty() {
                            let included_hashes: Vec<String> = block.microblock.transactions.iter()
                                .map(|tx| tx.hash.clone())
                                .collect();
                            if let Some(mempool_arc) = crate::node::try_get_mempool() {
                                mempool_arc.record_included_txs(&included_hashes);
                                mempool_arc.batch_remove_transactions(&included_hashes);

                                // ═══════════════════════════════════════════════════════════════════
                                // v15.12 L3: NOTIFY MEMPOOL OF FINALIZED COMMITMENT EPOCHS
                                // ═══════════════════════════════════════════════════════════════════
                                // Walk the applied block's transactions; for every commitment-class
                                // TX, mark its `(identity, epoch_or_index, type_id)` key in the
                                // mempool's `committed_epochs_cache`. Subsequent admission attempts
                                // for the same key are rejected at the door (lock-free DashMap
                                // lookup, ~50 ns), preventing late gossip / re-broadcast traffic
                                // from re-populating the local mempool with already-on-chain TXs.
                                //
                                // Together with the producer-side L2 state check and the bulk
                                // mempool removal above, this closes the cross-block duplication
                                // window observed at h=14351 → h=14461 (5 HeartbeatCommitments
                                // shipped twice 110 blocks apart due to peer-apply mempool
                                // retention).
                                //
                                // Scalability: one DashMap insert per commitment TX per applied
                                // block. At MAX_VALIDATORS=1000 epoch boundary peak = ~1000 inserts
                                // per epoch boundary block — sub-millisecond at any committee size.
                                // ═══════════════════════════════════════════════════════════════════
                                let mut commitment_marks = 0usize;
                                for tx in &block.microblock.transactions {
                                    if let Some(key) = tx.commitment_dedup_key() {
                                        mempool_arc.mark_commitment_finalized(key);
                                        commitment_marks += 1;
                                    }
                                }

                                if is_info() {
                                    if commitment_marks > 0 {
                                        println!(
                                            "[INFO][MEMPOOL] peer_apply_cleanup h={} tx_count={} commitments_marked={}",
                                            height, included_hashes.len(), commitment_marks
                                        );
                                    } else {
                                        println!(
                                            "[INFO][MEMPOOL] peer_apply_cleanup h={} tx_count={}",
                                            height, included_hashes.len()
                                        );
                                    }
                                }
                            }
                        }

                        // v15.6: chain-height bump on the blocking pool too —
                        // it is an atomic CF write but pays the same compaction
                        // queue penalty as the block save above.
                        metrics.mark_apply_op(height, PIPELINE_OP_APPLY_SET_HEIGHT);
                        let height_start = std::time::Instant::now();
                        let storage_for_height = ctx.storage.clone();
                        let height_result = match tokio::task::spawn_blocking(move || {
                            storage_for_height.set_chain_height(height)
                        }).await {
                            Ok(res) => res,
                            Err(join_err) => {
                                if is_warn() {
                                    println!(
                                        "[WARN][PIPELINE] set_height_join_err h={} err={}",
                                        height, join_err
                                    );
                                }
                                Err(crate::errors::IntegrationError::StorageError(format!("join error: {}", join_err)))
                            }
                        };
                        let height_elapsed = height_start.elapsed();
                        if height_elapsed > std::time::Duration::from_millis(500) {
                            if is_warn() {
                                println!(
                                    "[WARN][PIPELINE] slow_storage_write op=set_height h={} elapsed_ms={}",
                                    height, height_elapsed.as_millis()
                                );
                            }
                        }
                        if let Err(e) = height_result {
                            if is_warn() { println!("[WARN][PIPELINE] set_height_failed h={} err={}", height, e); }
                        }
                        // v15.4 DIAG: deferred-side-effects phase. Mostly
                        // RocksDB writes for registrations and reward
                        // bookkeeping; bounded but accumulates.
                        metrics.mark_apply_op(height, PIPELINE_OP_APPLY_DEFERRED_FX);

                        // ── Deferred side effects (block is committed) ──
                        if apply_result.deferred_pool3 > 0 {
                            if let Some(ref p2p) = ctx.unified_p2p {
                                p2p.add_to_pool3(apply_result.deferred_pool3);
                            }
                        }
                        for (node_id, type_str, wallet) in &apply_result.deferred_registrations {
                            let _ = ctx.storage.save_node_registration(node_id, type_str, wallet, 1.0);
                        }
                        for mb_idx in &apply_result.deferred_emission_mbs {
                            let mut reward_mgr = ctx.reward_manager.write().await;
                            let mut processed_set = reward_mgr.get_processed_emission_macroblocks().clone();
                            processed_set.insert(*mb_idx);
                            reward_mgr.set_processed_emission_macroblocks(processed_set.clone());
                            drop(reward_mgr);
                            if let Err(e) = ctx.storage.save_processed_emission_macroblocks(&processed_set) {
                                eprintln!("[WARN][PIPELINE] emission_save_fail mb={} err={}", mb_idx, e);
                            }
                        }
                        for (node_id, amount) in &apply_result.deferred_reward_clears {
                            {
                                let mut reward_mgr = ctx.reward_manager.write().await;
                                let _ = reward_mgr.clear_pending_reward(node_id);
                            }
                            if let Err(e) = ctx.storage.delete_pending_reward(node_id) {
                                if is_debug() { println!("[DBG][PIPELINE] claim_delete_fail node={} err={}", node_id, e); }
                            } else if is_info() {
                                println!("[INFO][PIPELINE] synced_claim node={} amount={} QNC", node_id, amount / 1_000_000_000);
                            }
                        }

                        // ── VRF key extraction from NodeRegistration TXs ──
                        if !block.microblock.transactions.is_empty() {
                            let has_reg_tx = block.microblock.transactions.iter().any(|tx| {
                                matches!(&tx.tx_type,
                                    qnet_state::TransactionType::NodeRegistration { .. } |
                                    qnet_state::TransactionType::NodeReactivation { .. })
                            });
                            if has_reg_tx {
                                BlockchainNode::cache_node_registrations_from_transactions(
                                    &ctx.storage, &block.microblock.transactions,
                                );
                                if is_info() {
                                    println!("[INFO][PIPELINE] vrf_keys_extracted h={} txs={}", height, tx_count);
                                }
                            }
                        }

                        // ═══════════════════════════════════════════════════════════════
                        // v15.10: Cross-shard 2PC apply hook removed.
                        // Architectural decision: QNet stays single-shard for the
                        // foreseeable future. Sharding scaffolding remains as
                        // dormant scaffolding in `qnet_consensus::cross_shard` and
                        // `qnet_consensus::sharded_consensus` modules — the
                        // primitives are tested and ready, but the apply path no
                        // longer touches them and the wire-format `CrossShard*`
                        // transaction variants have been removed from
                        // `TransactionType` to prevent any accidental
                        // activation. See `qnet-sharding/lib.rs` module header
                        // for the full rationale.
                        // ═══════════════════════════════════════════════════════════════

                        // ═══════════════════════════════════════════════════════════
                        // v15.9: WRITE-THROUGH ACCOUNT PERSISTENCE (Stage 1)
                        // ───────────────────────────────────────────────────────────
                        // Mirror every account that this block mutated into the
                        // persistent `accounts` column family. The mutation set is
                        // sourced from the `BlockSnapshot` journal, which already
                        // tracks every address touched by the block (modified
                        // pre-images + freshly created keys). For each address we
                        // re-read the post-image from the in-memory map and stage
                        // it into a single `WriteBatch` committed atomically on
                        // the blocking thread pool.
                        //
                        // CRASH SAFETY
                        // ───────────────────────────────────────────────────────────
                        // After this commit returns, a node that crashes can
                        // restart with a durable copy of every account at this
                        // block's height. Together with `set_chain_height`
                        // (already persisted above) this gives the runtime an
                        // on-disk source-of-truth for state at every committed
                        // block — no more "lost mutations between snapshots"
                        // when an unexpected restart hits the production node.
                        //
                        // Skipped when `block_snapshot` is None (genesis-window
                        // blocks without state_root verification) — there is no
                        // mutation set to persist in that case.
                        //
                        // SCALABILITY (1 000+ super nodes)
                        // ───────────────────────────────────────────────────────────
                        // Cost: one batch put per touched account per block.
                        // Typical block touches ≤ 100 accounts × ~150 B = ~15 KB
                        // committed atomically — single-digit millisecond on
                        // commodity SSDs. Runs on the blocking pool so the
                        // tokio reactor stays free for consensus / P2P / RPC.
                        if let Some(ref snapshot) = block_snapshot {
                            let mut modified: Vec<(String, qnet_state::Account)> =
                                Vec::with_capacity(snapshot.accounts().len() + snapshot.created_keys().len());
                            let mut deleted: Vec<String> = Vec::new();

                            // Modified addresses: pre-image existed; check if
                            // the post-image still exists (it might have been
                            // removed entirely if the apply path deletes
                            // accounts in some flow).
                            for addr in snapshot.accounts().keys() {
                                match state_guard.accounts.get(addr) {
                                    Some(entry) => {
                                        modified.push((addr.clone(), entry.value().clone()));
                                    }
                                    None => {
                                        deleted.push(addr.clone());
                                    }
                                }
                            }
                            // Created addresses: pre-image did NOT exist; just
                            // capture the post-image. (If the apply created
                            // and then immediately removed an account in the
                            // same block, it is already absent from the map
                            // and we skip the put.)
                            for addr in snapshot.created_keys() {
                                if let Some(entry) = state_guard.accounts.get(addr) {
                                    modified.push((addr.clone(), entry.value().clone()));
                                }
                            }

                            if !modified.is_empty() || !deleted.is_empty() {
                                // ───────────────────────────────────────────────
                                // Persist in the BACKGROUND so we never await on
                                // RocksDB while still holding `state_guard`.
                                // Holding the state write lock across an async
                                // I/O would serialise the entire apply pipeline
                                // behind disk latency — exactly the failure mode
                                // Fix #2 was introduced to avoid. The spawned
                                // task takes ownership of the modified/deleted
                                // buffers and an Arc<Storage> clone; it cannot
                                // outlive the runtime, and a logged failure is
                                // recoverable via microblock replay (the
                                // canonical Stage-1 invariant: account CF is
                                // best-effort, microblocks are authoritative).
                                // ───────────────────────────────────────────────
                                let storage_for_persist = ctx.storage.clone();
                                let height_for_persist = height;
                                let modified_count = modified.len();
                                let deleted_count = deleted.len();
                                tokio::spawn(async move {
                                    let persist_start = std::time::Instant::now();
                                    match storage_for_persist
                                        .persist_accounts_batch(modified, deleted)
                                        .await
                                    {
                                        Ok((puts, dels)) => {
                                            let elapsed = persist_start.elapsed();
                                            if elapsed > std::time::Duration::from_millis(200) {
                                                if is_warn() {
                                                    println!(
                                                        "[WARN][PIPELINE] slow_persist_accounts h={} puts={} dels={} elapsed_ms={}",
                                                        height_for_persist, puts, dels, elapsed.as_millis(),
                                                    );
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            if is_warn() {
                                                println!(
                                                    "[WARN][PIPELINE] persist_accounts_failed h={} puts={} dels={} err={:?}",
                                                    height_for_persist, modified_count, deleted_count, e,
                                                );
                                            }
                                        }
                                    }
                                });
                            }
                        }

                        true // success
                    }
                    Err(e) => {
                        eprintln!("[ERR][PIPELINE] save_failed h={} err={:?}", height, e);
                        // Rollback in-memory state
                        if let Some(ref snapshot) = block_snapshot {
                            state_guard.rollback_block(snapshot);
                            if is_info() { println!("[INFO][PIPELINE] block_rollback h={} reason=save_failed", height); }
                        }

                        // ═══════════════════════════════════════════════════════════════════════════
                        // v15.11 L5: MAJORITY-WINS FORK RESOLUTION TRIGGER
                        // ═══════════════════════════════════════════════════════════════════════════
                        // Save failed with `fork_conflict` means the storage L4 guard caught a
                        // different block at the same height (the local one we previously stored
                        // does NOT match the incoming one). The L4 guard already recorded
                        // cryptographic equivocation evidence for the slashing pipeline; here we
                        // additionally invoke the BFT majority resolver to decide which chain is
                        // canonical and roll back the local minority chain if needed.
                        //
                        // Triggered ONLY on the `fork_conflict` error path; other StorageError
                        // variants (full disk, IO error, corruption) are propagated unchanged.
                        //
                        // Safety:
                        //   * Resolver requires 2f+1 supermajority before any rollback — Byzantine
                        //     ≤ f cannot induce a wrong rollback.
                        //   * On Abstain (no quorum), local chain is preserved — defensive bias.
                        //   * Rollback is gated by `try_fork_recovery()` to prevent simultaneous
                        //     rollback storms (only one fork-recovery in flight at a time).
                        //
                        // Scalability:
                        //   * Triggered only on fork conflict (rare event by design).
                        //   * One async task per conflict, bounded by the resolver's 800 ms
                        //     timeout. No load on the apply pipeline itself — fire-and-forget.
                        let err_msg = format!("{}", e);
                        if err_msg.contains("fork_conflict") {
                            if let Some(ref p2p) = ctx.unified_p2p {
                                let p2p_clone = p2p.clone();
                                let storage_for_lookup = ctx.storage.clone();
                                let incoming_hash = block.microblock.hash();
                                let conflict_height = height;
                                tokio::spawn(async move {
                                    // Recover the existing block's hash from storage (the one
                                    // that L4 detected as conflicting against incoming).
                                    let existing_hash = match tokio::task::spawn_blocking(move || {
                                        storage_for_lookup
                                            .load_microblock_hash(conflict_height)
                                            .ok()
                                            .flatten()
                                    })
                                    .await
                                    {
                                        Ok(Some(h)) => h,
                                        _ => {
                                            // Without the existing hash we cannot resolve;
                                            // L4 evidence is still recorded for slashing.
                                            return;
                                        }
                                    };

                                    let _ = crate::node::handle_fork_at_height(
                                        conflict_height,
                                        incoming_hash,
                                        existing_hash,
                                        p2p_clone,
                                    )
                                    .await;
                                });
                            }
                        }

                        false
                    }
                }
            }; // state_guard dropped here

            if !apply_ok {
                metrics.apply_failed.fetch_add(1, Ordering::Relaxed);
                crate::unified_p2p::clear_block_pending_sync(height);
                metrics.mark_apply_idle();
                continue;
            }

            // ── Post-save updates (no state lock held) ──
            metrics.applied.fetch_add(1, Ordering::Relaxed);

            // ── v13.1: Timeout tracking (was missing — root cause of fork divergence) ──
            // Pipeline is the ONLY block processing path since v13.0.
            // Without these updates, LAST_BLOCK_PRODUCED_TIME stays at genesis_ts,
            // causing timeout_round to escalate forever → different rounds on each
            // node → different leader selection → fork from block 5 onward.
            {
                let prev_tip = crate::node::LAST_BLOCK_PRODUCED_HEIGHT.load(Ordering::Relaxed);
                crate::node::LAST_BLOCK_PRODUCED_TIME.store(
                    block.microblock.timestamp, Ordering::Relaxed,
                );
                crate::node::LAST_BLOCK_PRODUCED_HEIGHT.store(height, Ordering::Relaxed);

                // v14.8.10: observational clock-drift monitor. Feeds on-chain
                // block timestamp (producer-signed wall clock, agreed by 2f+1
                // honest committee for finalised macroblocks) into an EMA of
                // |local_now − block_ts|. Purely observational — triggers
                // WARN log and async NTP re-sync on drift, NEVER participates
                // in consensus rotation. Safe at any validator-count scale.
                crate::node::observe_clock_drift(
                    block.microblock.timestamp,
                    crate::node::get_timestamp_safe(),
                );

                // v14.8.10: Reset global CURRENT_TIMEOUT_ROUND atomic ONLY on
                // tip advance (next expected microblock applied). While
                // receiving blocks far behind tip (catch-up sync), the stored
                // round stays intact so a syncing node does not disrupt
                // rotation of nodes already at the tip. On genuine tip advance
                // the round is cleared because the happy-path producer has
                // succeeded — next block starts back at round 0 until a new
                // stall is detected.
                let is_tip_advance = height == prev_tip + 1;
                if is_tip_advance {
                    crate::node::reset_timeout_round();
                    if crate::node::is_debug() {
                        println!("[DBG][PIPELINE] round_reset h={} prev_tip={}", height, prev_tip);
                    }
                } else if height > prev_tip + 1 && crate::node::is_debug() {
                    println!("[DBG][PIPELINE] round_preserved h={} prev_tip={} reason=sync_or_skip",
                             height, prev_tip);
                }
            }

            // Update sync progress timestamp (deadlock detection)
            crate::node::LAST_SYNC_PROGRESS_TIME.store(
                crate::node::get_timestamp_safe(), Ordering::Relaxed,
            );

            // Update RAM height
            {
                let mut h = ctx.height.write().await;
                if height > *h {
                    *h = height;
                }
            }

            // Update global atomic height (P2P heartbeat reports this)
            crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.store(
                height, std::sync::atomic::Ordering::Release,
            );

            // Clear pending sync for this block
            crate::unified_p2p::clear_block_pending_sync(height);

            // ────────────────────────────────────────────────────────────────
            // v15.0: CHAIN-DERIVED ROTATION STATE CATCH-UP
            //
            // Closes the rotation-state-desync cascade. A node that came
            // back online at h=2790 and synced forward to h=2880 previously
            // applied the block with timeout_round=6 but had
            // HIGHEST_CERTIFIED_ROUND[mb_idx] = 0 because it never witnessed
            // the live BFT voting. Its producer-selection therefore computed
            // the primary leader (VRF winner at round 0) instead of the
            // rotated-to-round-6 producer, leading to the observed two-
            // producer fork for the same height.
            //
            // Fix: if an applied block was produced at timeout_round > local
            // HIGHEST_CERTIFIED_ROUND for the containing macroblock index,
            // proactively request timeout certificates from peers. The
            // response path re-verifies each certificate's 2f+1 signatures
            // (`handle_timeout_proof_broadcast` / `handle_aggregated_timeout_cert`)
            // before advancing state — so this is NOT a trust-the-block
            // shortcut; the block merely triggers the backfill.
            //
            // Safety:
            //   * timeout_round in the block is NOT used to advance rotation
            //     state directly (that would let ≤ f byzantine producers
            //     forge arbitrary rotation). It only signals "a certificate
            //     exists somewhere in the network — fetch it."
            //   * Self-limiting via the monotonic local_certified guard:
            //     as soon as the first successful backfill response advances
            //     HIGHEST_CERTIFIED_ROUND past this block's timeout_round,
            //     subsequent blocks in the same catch-up batch stop firing
            //     requests. Worst case during partition-induced catch-up is
            //     ~N requests (one per block applied faster than the peer
            //     RTT), bounded by the sync window.
            //
            // Scalability: one fan-out request to ≤ 5 peers only when the
            // condition fires. For the steady-state (block.timeout_round
            // matches local state) this costs zero. Bounded by the
            // active-macroblock cleanup window.
            // ────────────────────────────────────────────────────────────────
            let block_timeout_round = block.microblock.timeout_round;
            if block_timeout_round > 0 {
                let mb_idx = height / 90;
                let local_certified = crate::unified_p2p::highest_certified_round_for(mb_idx);
                if block_timeout_round > local_certified {
                    if let Some(ref p2p) = ctx.unified_p2p {
                        if is_info() {
                            println!(
                                "[INFO][PIPELINE] rotation_backfill_request h={} mb={} block_round={} local_certified={}",
                                height, mb_idx, block_timeout_round, local_certified,
                            );
                        }
                        // Request certificates for the macroblock window
                        // covering this block — peers serve both same-round
                        // and aggregated certificates in one response.
                        p2p.request_timeout_proofs(mb_idx, mb_idx);
                    }
                }
            }

            // ────────────────────────────────────────────────────────────────
            // v15.9: COMMITTEE-WIDE SNAPSHOT CREATION (deterministic apply-stage trigger)
            //
            // Every honest node materialises the canonical snapshot at every
            // `SNAPSHOT_INCREMENTAL_INTERVAL` boundary so that:
            //   * fresh nodes can chunked-parallel-download from any of the
            //     N committee members, not just the producer;
            //   * the macroblock `snapshot_root` consensus binding has a
            //     byte-identical artefact to hash on every honest node;
            //   * the rollback-reconciliation path can deterministically
            //     find a snapshot ≤ any rollback target.
            //
            // SOURCE OF TRUTH — IN-MEMORY STATE (not RocksDB accounts CF)
            // ────────────────────────────────────────────────────────────────
            // Earlier revisions delegated to `Storage::create_incremental_snapshot`,
            // which iterated the persistent `accounts` column family. That CF
            // is only ever written during snapshot RESTORE (boot-time / sync),
            // never during runtime block apply, so it carried whatever data
            // the last bootstrap restored — completely disconnected from the
            // current chain tip. The resulting snapshots were either empty
            // (on a fresh node) or stale (post-restart), and the
            // `snapshot_root` binding hashed those bad bytes.
            //
            // The fix: serialise from `state.accounts` (the in-memory
            // `Arc<DashMap>` that every block-apply path mutates), the same
            // source the emission-rewards path uses (node.rs:27680+). This
            // is the canonical runtime view of account state.
            //
            // CANONICAL ENCODING
            // ────────────────────────────────────────────────────────────────
            // DashMap iteration order is shard-dependent and varies node-to-
            // node even with identical content. We sort by account address
            // before bincode-serialising so every honest node produces the
            // SAME bytes — without this the SHA3-256 in `snapshot_root`
            // would diverge across the committee and the supermajority
            // binding could never converge.
            //
            // OFF-REACTOR EXECUTION
            // ────────────────────────────────────────────────────────────────
            // At 1 M+ accounts the iterate+clone+sort+serialise+zstd path
            // takes seconds and 100s of MB of working memory. We spawn it
            // on the tokio blocking pool with a strong `Arc` to the
            // accounts map; the apply pipeline returns immediately and the
            // next block can be processed while the snapshot writes in the
            // background. A failure is logged at WARN level — never blocks
            // consensus liveness.
            //
            // SCALABILITY (1 000+ super nodes)
            // ────────────────────────────────────────────────────────────────
            // Per-block overhead is a single integer modulus check; the
            // heavy work fires once every 3 600 blocks (~1 hour). Each node
            // performs identical work — total network cost is unchanged
            // versus the producer-only model, the artefact is simply
            // replicated to every committee member.
            // ────────────────────────────────────────────────────────────────
            const SNAPSHOT_INCREMENTAL_INTERVAL: u64 = 3_600;
            if height > 0 && height % SNAPSHOT_INCREMENTAL_INTERVAL == 0 {
                let storage_for_snapshot = ctx.storage.clone();
                let state_for_snapshot = ctx.state.clone();
                let snapshot_height = height;
                tokio::spawn(async move {
                    let start = std::time::Instant::now();

                    // Read the in-memory state under a brief read lock to
                    // capture: (a) a strong handle to the accounts map,
                    // (b) the current state_root, (c) the current
                    // total_supply. We drop the lock before the heavy
                    // serialise step so block apply is not blocked.
                    let (accounts_arc, state_root, total_supply) = {
                        let sg = state_for_snapshot.read().await;
                        let accounts_arc = sg.accounts.clone();
                        let state_root = sg.calculate_state_root().unwrap_or([0u8; 32]);
                        let total_supply = sg.chain_state.read().total_supply;
                        (accounts_arc, state_root, total_supply)
                    };

                    // Heavy work: iterate DashMap, clone, sort, bincode.
                    // Lives on the blocking thread pool so the reactor
                    // stays free; the closure consumes `accounts_arc` so
                    // no shared-state hazards remain after spawn.
                    let serialise_result = tokio::task::spawn_blocking(move || {
                        let mut accounts: Vec<(String, qnet_state::Account)> = accounts_arc
                            .iter()
                            .map(|e| (e.key().clone(), e.value().clone()))
                            .collect();
                        accounts.sort_by(|a, b| a.0.cmp(&b.0));
                        bincode::serialize(&accounts)
                    }).await;

                    let state_data = match serialise_result {
                        Ok(Ok(data)) => data,
                        Ok(Err(e)) => {
                            if is_warn() {
                                println!(
                                    "[WARN][PIPELINE] snapshot_serialize_fail h={} err={}",
                                    snapshot_height, e,
                                );
                            }
                            return;
                        }
                        Err(e) => {
                            if is_warn() {
                                println!(
                                    "[WARN][PIPELINE] snapshot_join_fail h={} err={:?}",
                                    snapshot_height, e,
                                );
                            }
                            return;
                        }
                    };

                    if state_data.is_empty() {
                        // Genesis-window or pre-state node — nothing to bind.
                        return;
                    }

                    // Write the canonical snapshot artefact. `save_state_snapshot`
                    // wraps zstd-15 + integrity hash + atomic batch write —
                    // already off-reactor (Fix #2 spawn_blocking).
                    match storage_for_snapshot
                        .save_state_snapshot(
                            snapshot_height,
                            state_root,
                            total_supply,
                            state_data,
                        )
                        .await
                    {
                        Ok(_) => {
                            if is_info() {
                                println!(
                                    "[INFO][PIPELINE] snapshot_created h={} elapsed_ms={} source=apply_stage",
                                    snapshot_height,
                                    start.elapsed().as_millis(),
                                );
                            }
                        }
                        Err(e) => {
                            if is_warn() {
                                println!(
                                    "[WARN][PIPELINE] snapshot_save_failed h={} err={:?}",
                                    snapshot_height, e,
                                );
                            }
                        }
                    }
                });
            }

            // ────────────────────────────────────────────────────────────────
            // v14.10: GENESIS GLOBAL STATE (was missing in pipeline apply path!)
            //
            // The canonical `genesis_config::apply_genesis_state` sets two
            // process-global fields that are NOT touched by the regular
            // per-transaction apply path:
            //   1. GLOBAL_GENESIS_TIMESTAMP — used by consensus timing (rounds,
            //      timeout_round, PoH slot calc). If left at 0 the node
            //      computes rotation rounds against Unix epoch — unusable.
            //   2. Dynamic pricing state seed — cold-start base fee at genesis.
            //
            // When a fresh node fetches genesis via HTTP at startup, the
            // startup path calls `apply_genesis_state` explicitly. But when a
            // fresh node receives h=0 over P2P (because HTTP genesis endpoint
            // is unavailable), the pipeline applies the block but skips these
            // two globals — leaving consensus broken until the node restarts.
            //
            // This block fixes that gap: on h=0 apply via pipeline, run the
            // same global-state initialisation. Idempotent (checks existing
            // value to avoid redundant stores on every h=0 replay).
            // ────────────────────────────────────────────────────────────────
            if height == 0 {
                let current_gen_ts = crate::GLOBAL_GENESIS_TIMESTAMP
                    .load(std::sync::atomic::Ordering::Relaxed);
                if current_gen_ts == 0 || current_gen_ts != block.microblock.timestamp {
                    crate::GLOBAL_GENESIS_TIMESTAMP.store(
                        block.microblock.timestamp,
                        std::sync::atomic::Ordering::Relaxed,
                    );
                    crate::update_global_pricing_state(
                        0.0_f64, 5_u64, block.microblock.timestamp,
                    );
                    if is_info() {
                        println!("[INFO][PIPELINE] genesis_globals_set ts={} path=pipeline_apply",
                                 block.microblock.timestamp);
                    }
                }
            }

            // Broadcast block event (for consensus listener)
            let _ = ctx.block_event_tx.send(height);

            // v14.9: Wake sync manager and any other apply-waiters.
            // Zero-cost when no waiters (atomic notify slot).
            // At thousands of Super nodes scale this is O(1) — Notify uses
            // a single atomic flag + waker list; no per-waiter lock.
            ctx.apply_notify.notify_waiters();

            // Notify coordinator
            ctx.coordinator.try_send(ConsensusEvent::BlockApplied {
                height,
                producer: producer.clone(),
                timestamp: block.microblock.timestamp,
            });

            // v14.9: WS broadcast for real-time explorer updates.
            // Ported from the removed process_received_blocks path —
            // without this, NewBlock events never reach WS subscribers.
            crate::rpc::broadcast_ws_event(crate::rpc::WsEvent::NewBlock {
                height: block.microblock.height,
                hash: hex::encode(block.microblock.hash()),
                timestamp: block.microblock.timestamp,
                tx_count: block.microblock.transactions.len(),
                producer: block.microblock.producer.clone(),
            });

            // Per-microblock BlockCommitVote (HotStuff-style blocking QC)
            // remains DISABLED on this path. The previous quorum-certificate
            // approach shared the "commit" rate-limit key with macroblock
            // ConsensusCommit and starved real macroblock consensus from peers.
            //
            // Per-microblock confirmation is now provided by the COMMITTEE-
            // ATTESTATION layer (see `attestation_committee.rs` and the
            // BlockAttestationMsg / EmptySlotAttestationMsg handlers in
            // `unified_p2p.rs`). That layer is non-blocking — attestations
            // travel on a separate gossip channel, do not gate block
            // production, and form the basis of the cumulative-weight fork
            // choice rule (`chain_weight.rs`). It supplies per-block 2f+1
            // safety AND deterministic empty-slot failover, without sharing
            // the macroblock commit rate-limit bucket. Macroblock 2f+1
            // commit/reveal at the 90-block boundary remains the canonical
            // finality anchor.

            // ── Reputation update for block producer ──
            // Handled by deterministic reputation system via macroblock processing
            // (not per-microblock — that's by design)

            if height <= 5 || height % 50 == 0 {
                if is_info() {
                    println!("[INFO][PIPELINE] applied h={} prod={} txs={}", height, producer, tx_count);
                }
            }

            // v15.4 DIAG: clear apply op marker — between blocks the stage
            // is legitimately idle waiting on the channel. This lets the
            // watchdog distinguish "apply hung mid-block" (op != idle for
            // ≥30 s) from "no input arriving" (op = idle) so a slow
            // upstream is never mis-attributed to apply.
            metrics.mark_apply_idle();
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// v18: REGRESSION TESTS — active sync trigger + dedup semantics
// ════════════════════════════════════════════════════════════════════════════
// These tests lock in the security and liveness invariants enforced by the
// new MISSING_BLOCK_REQUESTED dedup map and request_missing_parent helper.
// A regression on ANY of these means either:
//   * The thundering-herd protection (single-flight per height within TTL)
//     was broken — risk of bandwidth amplification when many child blocks
//     arrive for the same missing parent.
//   * The TTL retention was broken — risk of unbounded map growth or
//     legitimate retry of a genuinely-missing parent being silently
//     suppressed forever.
// Each test asserts a SECURITY or LIVENESS property, never a styling choice.
#[cfg(test)]
mod tests_v18_active_sync {
    use super::*;

    // The dedup map (`MISSING_BLOCK_REQUESTED`) is process-wide and shared
    // across cargo's parallel test workers. To avoid cross-test interference
    // each test below uses a UNIQUE height (>= 1_000_000_000) so its key
    // space cannot collide with production heights or other tests' keys.
    // No shared `reset_request_map` helper is used — every test scopes its
    // assertions to its own height key, and `cleanup_missing_block_requests`
    // tests check height-specific presence, not whole-map state.

    const H_FIRST_CALL: u64 = 1_000_000_001;
    const H_DUPLICATE: u64 = 1_000_000_002;
    const H_CLEANUP_EVICT: u64 = 1_000_000_003;
    const H_CLEANUP_KEEP: u64 = 1_000_000_004;
    const H_TTL_EXPIRY: u64 = 1_000_000_005;

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// First call for an unseen height MUST insert the dedup entry.
    /// Without this, the very first orphaned-parent observation in a
    /// fresh boot would silently no-op and the legacy passive-wait
    /// remains the only recovery vector — defeating the purpose of v18.
    ///
    /// Note: the actual network send is gated on `try_get_p2p()` — in a
    /// unit-test context the global is None, so dispatch returns false
    /// from the network branch but the dedup-map insert MUST still
    /// happen. The test verifies the insert by reading the height key.
    #[test]
    fn first_call_inserts_into_dedup_map() {
        // Make sure we start from a clean state for THIS specific height key.
        // Avoid clearing the whole map — other parallel tests use other keys.
        MISSING_BLOCK_REQUESTED.remove(&H_FIRST_CALL);
        let _ = request_missing_parent(H_FIRST_CALL);
        assert!(
            MISSING_BLOCK_REQUESTED.contains_key(&H_FIRST_CALL),
            "first call must insert the height into the request map"
        );
    }

    /// A second call for the SAME height within the TTL window MUST NOT
    /// refresh the timestamp. This is the single-flight guarantee —
    /// without it, a flood of child blocks for the same missing parent
    /// would amplify into the same number of outbound `RequestBlocks`
    /// messages, wasting peer bandwidth at 1000+ super-node scale.
    #[test]
    fn duplicate_within_ttl_is_rejected() {
        MISSING_BLOCK_REQUESTED.remove(&H_DUPLICATE);
        let _ = request_missing_parent(H_DUPLICATE);
        let first_ts = *MISSING_BLOCK_REQUESTED
            .get(&H_DUPLICATE)
            .expect("first insert must succeed")
            .value();
        // Second call within the same millisecond MUST NOT advance the
        // timestamp — verifies the cooldown branch was taken.
        let _ = request_missing_parent(H_DUPLICATE);
        let second_ts = *MISSING_BLOCK_REQUESTED
            .get(&H_DUPLICATE)
            .expect("entry must still be present")
            .value();
        assert_eq!(
            first_ts, second_ts,
            "second call within TTL must NOT refresh the timestamp"
        );
    }

    /// Cleanup MUST evict entries older than the TTL. Without this the
    /// map grows unboundedly under sustained gap-recovery activity at
    /// thousand-node deployment scale.
    ///
    /// Cargo runs tests in parallel, so any other test that calls
    /// `cleanup_missing_block_requests()` may evict our stale-TS entry
    /// before this test asserts on it. To make the test deterministic
    /// under parallelism we directly compute the post-cleanup expectation:
    /// after `cleanup_missing_block_requests()`, an entry that was inserted
    /// with a stale timestamp MUST be absent regardless of the order in
    /// which other tests' cleanups interleaved with this one. The function
    /// is idempotent — multiple cleanups don't change the post-condition.
    #[test]
    fn cleanup_evicts_stale_entries() {
        let stale_ts = now_ms().saturating_sub(MISSING_BLOCK_REQUEST_TTL_MS + 1000);
        MISSING_BLOCK_REQUESTED.insert(H_CLEANUP_EVICT, stale_ts);

        // Run cleanup explicitly. Any parallel test's cleanup that ran
        // between our insert and this call would also evict our stale
        // entry — which is the post-condition we are asserting. Either
        // way, the entry MUST be gone after this point.
        cleanup_missing_block_requests();
        assert!(
            !MISSING_BLOCK_REQUESTED.contains_key(&H_CLEANUP_EVICT),
            "cleanup must evict entries older than the TTL (key={})",
            H_CLEANUP_EVICT
        );
    }

    /// Cleanup MUST NOT evict entries within the TTL window. False
    /// positives here would cause re-dispatch of in-flight requests,
    /// re-introducing the thundering-herd we are trying to prevent.
    #[test]
    fn cleanup_preserves_fresh_entries() {
        MISSING_BLOCK_REQUESTED.insert(H_CLEANUP_KEEP, now_ms());

        cleanup_missing_block_requests();
        assert!(
            MISSING_BLOCK_REQUESTED.contains_key(&H_CLEANUP_KEEP),
            "cleanup must keep entries inserted within the TTL"
        );
    }

    /// After TTL expiry, a follow-up call MUST refresh the timestamp
    /// (the previous request is presumed lost — peer offline, packet
    /// drop — and a new attempt is warranted). Without this, a
    /// genuinely-missing parent that the network failed to deliver
    /// once would be silently abandoned forever — exactly the v17.x
    /// stall failure mode.
    #[test]
    fn ttl_expiry_allows_retry() {
        let stale_ts = now_ms().saturating_sub(MISSING_BLOCK_REQUEST_TTL_MS + 1000);
        MISSING_BLOCK_REQUESTED.insert(H_TTL_EXPIRY, stale_ts);

        let _ = request_missing_parent(H_TTL_EXPIRY);
        let new_ts = *MISSING_BLOCK_REQUESTED
            .get(&H_TTL_EXPIRY)
            .expect("entry must still exist")
            .value();
        assert!(
            new_ts > stale_ts,
            "expired-TTL retry must refresh the timestamp (was {} now {})",
            stale_ts, new_ts
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// v19: REGRESSION TESTS — RANGE-SYNC DEDUP
// ═══════════════════════════════════════════════════════════════════════════
// Mirror of `tests_v18_active_sync` for the range-sync path added in v19.
// The single-flight semantics here protect against thundering-herd at thousand-
// node scale: when a long stall ends and many peers simultaneously surface
// their tip-advance, every local pipeline observation of an out-of-order child
// would otherwise emit one `sync_blocks(local_tip+1, child_h)` request per
// missing block — flooding the top-3 peers with duplicate batched fetches.
// Each test asserts a SECURITY or LIVENESS property, never a styling choice.
#[cfg(test)]
mod tests_v19_range_sync {
    use super::*;

    // Use a disjoint key space from the v18 tests above so cargo's parallel
    // workers cannot interfere across modules.
    const FROM_FIRST_CALL: u64 = 1_000_001_001;
    const TO_FIRST_CALL: u64 = 1_000_001_500;

    const FROM_DUPLICATE: u64 = 1_000_002_001;
    const TO_DUPLICATE: u64 = 1_000_002_500;

    const FROM_CLEANUP_EVICT: u64 = 1_000_003_001;
    const TO_CLEANUP_EVICT: u64 = 1_000_003_500;

    const FROM_CLEANUP_KEEP: u64 = 1_000_004_001;
    const TO_CLEANUP_KEEP: u64 = 1_000_004_500;

    const FROM_TTL_EXPIRY: u64 = 1_000_005_001;
    const TO_TTL_EXPIRY: u64 = 1_000_005_500;

    const FROM_INVALID: u64 = 1_000_006_500;
    const TO_INVALID: u64 = 1_000_006_001;

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// First call for a fresh `(from, to)` pair MUST insert the dedup entry.
    /// The actual network dispatch is gated on `try_get_p2p()` — in unit-test
    /// context the global is None, so the function returns false; the dedup
    /// insert MUST still happen so a follow-up call within the TTL window
    /// is suppressed even if p2p comes online in between (the only honest
    /// way to differentiate "first call" from "duplicate" is the map state).
    #[test]
    fn range_first_call_inserts_into_dedup_map() {
        MISSING_BLOCK_RANGE_REQUESTED.remove(&(FROM_FIRST_CALL, TO_FIRST_CALL));
        let _ = request_missing_range(FROM_FIRST_CALL, TO_FIRST_CALL);
        assert!(
            MISSING_BLOCK_RANGE_REQUESTED.contains_key(&(FROM_FIRST_CALL, TO_FIRST_CALL)),
            "first range call must insert (from, to) into the dedup map"
        );
    }

    /// A second call for the SAME `(from, to)` pair within the TTL window
    /// MUST NOT refresh the timestamp. Without this guarantee, every child
    /// block landing during a long stall would amplify into another batched
    /// fetch covering substantially the same range — at 1000-peer scale a
    /// 500-block gap with 50 in-flight children = 25 000 redundant requests.
    #[test]
    fn range_duplicate_within_ttl_is_rejected() {
        MISSING_BLOCK_RANGE_REQUESTED.remove(&(FROM_DUPLICATE, TO_DUPLICATE));
        let _ = request_missing_range(FROM_DUPLICATE, TO_DUPLICATE);
        let first_ts = *MISSING_BLOCK_RANGE_REQUESTED
            .get(&(FROM_DUPLICATE, TO_DUPLICATE))
            .expect("first insert must succeed")
            .value();
        let _ = request_missing_range(FROM_DUPLICATE, TO_DUPLICATE);
        let second_ts = *MISSING_BLOCK_RANGE_REQUESTED
            .get(&(FROM_DUPLICATE, TO_DUPLICATE))
            .expect("entry must still be present")
            .value();
        assert_eq!(
            first_ts, second_ts,
            "second range call within TTL must NOT refresh the timestamp"
        );
    }

    /// `cleanup_missing_block_requests` MUST evict range entries older than
    /// `MISSING_BLOCK_RANGE_TTL_MS`. Without this the range dedup map grows
    /// unboundedly under sustained gap-recovery activity at thousand-node
    /// deployment scale (every long stall adds one entry per `(from, to)`
    /// pair seen).
    #[test]
    fn range_cleanup_evicts_stale_entries() {
        let stale_ts = now_ms().saturating_sub(MISSING_BLOCK_RANGE_TTL_MS + 1000);
        MISSING_BLOCK_RANGE_REQUESTED.insert((FROM_CLEANUP_EVICT, TO_CLEANUP_EVICT), stale_ts);

        cleanup_missing_block_requests();
        assert!(
            !MISSING_BLOCK_RANGE_REQUESTED.contains_key(&(FROM_CLEANUP_EVICT, TO_CLEANUP_EVICT)),
            "cleanup must evict range entries older than the TTL"
        );
    }

    /// Cleanup MUST NOT evict range entries within the TTL window. False
    /// positives here would re-dispatch in-flight `sync_blocks` against
    /// peers and re-introduce the thundering-herd we are trying to prevent.
    #[test]
    fn range_cleanup_preserves_fresh_entries() {
        MISSING_BLOCK_RANGE_REQUESTED.insert((FROM_CLEANUP_KEEP, TO_CLEANUP_KEEP), now_ms());
        cleanup_missing_block_requests();
        assert!(
            MISSING_BLOCK_RANGE_REQUESTED.contains_key(&(FROM_CLEANUP_KEEP, TO_CLEANUP_KEEP)),
            "cleanup must keep range entries inserted within the TTL"
        );
    }

    /// After TTL expiry, a follow-up range request MUST refresh the
    /// timestamp. Mirror of the per-height TTL-expiry contract: if the
    /// previous request was lost (peer offline, packet drop), the network
    /// MUST be allowed to retry — otherwise a genuinely-missing range that
    /// the network failed to deliver once would be silently abandoned
    /// forever.
    #[test]
    fn range_ttl_expiry_allows_retry() {
        let stale_ts = now_ms().saturating_sub(MISSING_BLOCK_RANGE_TTL_MS + 1000);
        MISSING_BLOCK_RANGE_REQUESTED.insert((FROM_TTL_EXPIRY, TO_TTL_EXPIRY), stale_ts);

        let _ = request_missing_range(FROM_TTL_EXPIRY, TO_TTL_EXPIRY);
        let new_ts = *MISSING_BLOCK_RANGE_REQUESTED
            .get(&(FROM_TTL_EXPIRY, TO_TTL_EXPIRY))
            .expect("entry must still exist")
            .value();
        assert!(
            new_ts > stale_ts,
            "expired-TTL range retry must refresh the timestamp (was {} now {})",
            stale_ts, new_ts
        );
    }

    /// An inverted range (`to < from`) MUST be rejected without inserting
    /// into the dedup map. Without this guard a faulty caller could pin
    /// arbitrary `(from, to)` keys that never legitimately appear in
    /// dispatch, slowly leaking memory and obscuring real stall patterns
    /// in operator dashboards.
    #[test]
    fn range_inverted_input_is_rejected() {
        MISSING_BLOCK_RANGE_REQUESTED.remove(&(FROM_INVALID, TO_INVALID));
        let dispatched = request_missing_range(FROM_INVALID, TO_INVALID);
        assert!(
            !dispatched,
            "inverted range (to < from) must be rejected"
        );
        assert!(
            !MISSING_BLOCK_RANGE_REQUESTED.contains_key(&(FROM_INVALID, TO_INVALID)),
            "inverted range MUST NOT insert into the dedup map"
        );
    }
}

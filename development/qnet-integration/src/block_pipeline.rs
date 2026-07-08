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

// Apply-stage circuit-breaker: consecutive apply failures (state_root_mismatch) with no
// clean apply in between. Repeated failure means the local base is contaminated; the node
// stops re-applying onto it (the wedge) and escalates to fail-closed fork recovery. Counted
// across heights so a mismatch that hops to the next height cannot reset the count and dodge
// the breaker. Cleared on any successful apply.
static APPLY_MISMATCH_COUNT: AtomicU64 = AtomicU64::new(0);
const APPLY_MISMATCH_BREAKER: u64 = 3;

/// Record an apply failure; returns true once it trips the breaker.
fn record_apply_mismatch() -> bool {
    APPLY_MISMATCH_COUNT.fetch_add(1, Ordering::Relaxed) + 1 >= APPLY_MISMATCH_BREAKER
}

/// Reset the breaker after a clean apply.
fn clear_apply_mismatch() {
    if APPLY_MISMATCH_COUNT.load(Ordering::Relaxed) != 0 {
        APPLY_MISMATCH_COUNT.store(0, Ordering::Relaxed);
    }
}

// Distinct-peer witness tracker for microblock minority-fork detection.
// Height → set of distinct peer_ids that reported hash_chain_break there.
// DETECTION threshold is f+1, NOT 2f+1: a node on a minority fork cannot
// gather 2f+1 honest witnesses (it would never trip → stuck forever, the
// v14.8.5 bug). f+1 = "at least one honest" and is Sybil-proof because each
// witness is a Dilithium3-authenticated validator peer_id (a false positive
// needs f+1 real keys, outside the ≤f fault model). Safe: an honest node
// only reports a break on a real parent_hash mismatch from a signed peer
// envelope. Lock-free DashMap/DashSet; bounded by cleanup_break_tracker.
use dashmap::DashSet;
static HASH_CHAIN_BREAK_WITNESSES: once_cell::sync::Lazy<
    dashmap::DashMap<u64, DashSet<String>>
> = once_cell::sync::Lazy::new(dashmap::DashMap::new);

// v31.1: height→hash RAM cache. Verify reads parent hash here before
// RocksDB, dodging LSM-read contention with concurrent apply writes.
// Bounded LRU; deeper history falls back to disk on miss. ~1.2 MB at cap.
const RECENT_BLOCK_HASHES_MAX: usize = 30_000;
pub static RECENT_BLOCK_HASHES: once_cell::sync::Lazy<
    dashmap::DashMap<u64, [u8; 32]>
> = once_cell::sync::Lazy::new(dashmap::DashMap::new);

// v32.10: cooldown for macroblock-anchored fork-recovery trigger.
// Height → wall-clock secs of last trigger. 60s/height prevents thrashing
// when the same break repeats during resync.
static FORK_RECOVERY_TRIGGER_TIMES: once_cell::sync::Lazy<
    dashmap::DashMap<u64, u64>
> = once_cell::sync::Lazy::new(dashmap::DashMap::new);
const FORK_RECOVERY_COOLDOWN_SECS: u64 = 60;

// Cooldown for the failover-cert pull-on-reject. mb_idx → wall-clock secs of last request.
// Bounds how often a node stuck on an uncertified failover block asks peers for that window's
// timeout certificates (the request/serve already exists for sync and returns the same-round
// 2f+1 TimeoutCertificate). 2s is fast enough to recover within a window, slow enough that
// the repeated per-block reject loop can't flood peers.
static FAILOVER_CERT_PULL_TIMES: once_cell::sync::Lazy<
    dashmap::DashMap<u64, u64>
> = once_cell::sync::Lazy::new(dashmap::DashMap::new);
const FAILOVER_CERT_PULL_COOLDOWN_SECS: u64 = 2;

/// Cache parent hash after apply commit / verify success / self-save.
#[inline]
pub fn cache_block_hash(height: u64, hash: [u8; 32]) {
    RECENT_BLOCK_HASHES.insert(height, hash);
    // LRU trim by lowest height when over cap.
    if RECENT_BLOCK_HASHES.len() > RECENT_BLOCK_HASHES_MAX {
        let mut min_h = u64::MAX;
        for entry in RECENT_BLOCK_HASHES.iter() {
            let h = *entry.key();
            if h < min_h { min_h = h; }
        }
        if min_h != u64::MAX {
            RECENT_BLOCK_HASHES.remove(&min_h);
        }
    }
}

/// O(1) RAM lookup for parent hash; None ⇒ caller falls back to RocksDB.
#[inline]
pub fn lookup_block_hash(height: u64) -> Option<[u8; 32]> {
    RECENT_BLOCK_HASHES.get(&height).map(|e| *e.value())
}

/// Deterministic microblock fork-choice (failover race): a same-height block from
/// a STRICTLY HIGHER 2f+1-certified rotation round supersedes the one we hold.
/// Routes it to the finality-guarded reorg via FORK_RECOVERY_HEIGHT — the existing
/// recovery rolls back (never below finality), reconciles state, and resyncs to the
/// certified chain. Both timeout_round values share the per-height baseline, so the
/// higher one is the failover winner. Safety: round must be 2f+1-certified (≤f
/// Byzantine cannot forge a TC); height must be above finality; per-height cooldown
/// bounds re-triggers; the resync re-verifies every block. One bounded decode, only
/// for stored heights above finality.
fn maybe_supersede_by_certified_round(storage: &Arc<Storage>, block: &IngestBlock) {
    let h = block.height;
    if h == 0 { return; }
    let finalized = crate::node::LAST_FINALIZED_HEIGHT.load(Ordering::SeqCst);
    if h <= finalized { return; } // never reorg finalized history

    let our_round = match storage.load_microblock_auto_format(h) {
        Ok(Some(mb)) => mb.timeout_round,
        _ => return,
    };

    // Fast path: if no round higher than ours is 2f+1-certified, no competitor can
    // win — skip the decode entirely (the common no-failover case). Absolute units.
    let mb_idx = h / 90;
    let baseline = crate::unified_p2p::get_baseline_round(mb_idx);
    let certified_abs = crate::unified_p2p::highest_certified_round_for(mb_idx);
    if our_round.saturating_add(baseline) >= certified_abs { return; }

    // Bounded decode (zstd|raw → MicroBlock) just to read the incoming round.
    const MAX_DECOMPRESSED: usize = 50 * 1024 * 1024;
    let decompressed = match zstd::stream::Decoder::new(&block.data[..]) {
        Ok(dec) => {
            use std::io::Read;
            let mut buf = Vec::new();
            match dec.take(MAX_DECOMPRESSED as u64 + 1).read_to_end(&mut buf) {
                Ok(_) if buf.len() <= MAX_DECOMPRESSED => buf,
                _ => return,
            }
        }
        Err(_) => block.data.clone(),
    };
    let incoming = match bincode::deserialize::<qnet_state::MicroBlock>(&decompressed) {
        Ok(mb) if mb.height == h && mb.timeout_round > our_round => mb,
        _ => return, // decode failed, height mismatch, or not a higher round → keep ours
    };

    // The higher round must itself be 2f+1-certified (a forged round is ignored
    // here and would also fail the v23.1 ingest gate on resync).
    if incoming.timeout_round.saturating_add(baseline) > certified_abs { return; }

    // Per-height cooldown (shared with macroblock-anchored recovery).
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    if let Some(t) = FORK_RECOVERY_TRIGGER_TIMES.get(&h) {
        if now.saturating_sub(*t) < FORK_RECOVERY_COOLDOWN_SECS { return; }
    }
    FORK_RECOVERY_TRIGGER_TIMES.insert(h, now);

    // Signal the LAST-GOOD height (disputed-1, clamped >= finalized). The v33 consumer
    // rolls back TO this height and deletes strictly above it, so it must be h-1 for the
    // losing block at h to be dropped — matching anchor_recovery (disputed-2) and
    // apply_breaker (height-1). Deepest pending target wins (min) so a concurrent, deeper
    // signal is never masked. (h > finalized is guaranteed above; .max is a floor clamp.)
    let target = h.saturating_sub(1).max(finalized);
    let prev = FORK_RECOVERY_HEIGHT.load(Ordering::SeqCst);
    if prev == 0 || target < prev {
        FORK_RECOVERY_HEIGHT.store(target, Ordering::SeqCst);
    }
    if is_warn() {
        println!("[WARN][FORK] round_supersede h={} our_round={} new_round={} action=reorg_to_certified",
                 h, our_round, incoming.timeout_round);
    }
}

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
/// the existing 2f+1 macroblock Checkpoint-BFT QC which finalises the
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
    // 2f+1 macroblock Checkpoint-BFT QC naturally finalises the canonical
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
    FORK_RECOVERY_TRIGGER_TIMES.retain(|h, _| *h >= min_height);
}

// v18: missing-parent active sync. When verify finds parent_h absent
// (load_microblock=Ok(None)), legacy defer+passive-wait was unbounded
// under partial propagation → deferred buffer fills, gap stays open (v17.x
// stall h=180-241). Fix: proactively request_block_repair(parent_h)
// (parallel fan to top-rep peers); response re-enters the normal pipeline
// and drains the deferred child. Single-flight per height (process-wide
// dedup + cooldown → no thundering herd across verify workers); detached
// spawn (verify never blocks); passive-wait fallback retained (ADDS a
// recovery vector only). Returned blocks pass full canonical verify.

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

// v19: range-sync for large gaps. v18 single-flight (1 req/height, 30s
// TTL) recovers ~1 block/TTL → a 31-block gap ≈ gap×TTL ≈ 15min while the
// deferred buffer fills. Fix: when the missing parent is >
// RANGE_SYNC_GAP_THRESHOLD below the child, dispatch ONE sync_blocks(from,
// to) (canonical: parallel top-rep fan, MAX_BATCH_BLOCKS=500/req; responses
// re-enter via handle_blocks_batch→ingest) instead of N single-flights.
// Separate range dedup MISSING_BLOCK_RANGE_REQUESTED keyed (local_tip,
// target), time-windowed → no request storm; per-height dedup kept for the
// small-gap path. Detached spawn; responses pass full canonical verify.

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
///
/// v25 H14: `sig_pre_verified` lets the multi-worker verify pool pass an
/// already-verified Dilithium3 signature result forward to `verify_stage`
/// so the canonical state-bound stage does not pay for a redundant
/// per-block signature check. When the parallel verify pool is enabled
/// (`verify_workers > 1`), the worker that pre-verifies sets this to
/// `true`; `verify_stage` then skips its own verify call. When the single-
/// worker path is used (default for resource-constrained nodes), the flag
/// stays `false` and `verify_stage` performs the verify as before — full
/// behavioural backward compatibility, faster hot path under the parallel
/// configuration.
#[derive(Debug, Clone)]
pub struct DecodedBlock {
    pub height: u64,
    pub raw_data: Vec<u8>,
    pub decompressed: Vec<u8>,
    pub microblock: qnet_state::MicroBlock,
    pub from_peer: String,
    /// True when the producer's Dilithium3 signature was already
    /// successfully verified upstream of `verify_stage` (e.g., in the
    /// parallel worker pool of `block_pipeline`). Default `false` for
    /// any path that has not explicitly run the check.
    pub sig_pre_verified: bool,
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
        // Scale-correct backpressure metric. `ingested - finished`
        // over-counted: during catch-up the same height arrives many times
        // (SHRED redundancy, sync retries), each bumping `ingested` while
        // only one applies → phantom delta inflated in-flight past buffer
        // capacity → backpressure credits hit 0 → starved sync exactly when
        // it needed to fetch parents (observed 58K phantom vs <2K real on
        // node 001). Fixes: (1) count future_dropped + deferred_evicted as
        // finished (terminal, sync re-requests later); (2) hard-clamp to the
        // sum of bounded buffers (occupancy can't physically exceed it).
        // 9 atomic loads, O(1).
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

        // v25: N-worker parallel signature-verify pool. decode_rx -> N workers
        // (Dilithium3 producer-sig verify, CPU-bound, parallel) -> sig_verified_rx
        // FIFO -> verify_stage (state-bound: deferred buffer + hash-chain,
        // single-threaded) -> apply. Parallel pre-verify is safe: verify is a pure
        // fn; downstream out-of-order handled by the deferred buffer. Super-node
        // path only. Steady ~1 verify/s (1 worker ok); pool for catch-up/burst.
        // Sizing: catch-up=num_cpus, steady=2.
        let verify_workers = std::cmp::max(1, config.verify_workers);

        // Pre-verify FIFO between worker pool and the state-bound stage.
        // Sized to the same depth as the original decode_rx so the worker
        // pool never blocks the dispatcher; the state-bound stage drains
        // as fast as it can apply.
        let (sig_verified_tx, sig_verified_rx) =
            mpsc::channel::<DecodedBlock>(std::cmp::max(64, config.verify_buffer));

        if verify_workers > 1 {
            // ── Multi-worker path ──
            // The dispatcher owns `decode_rx` and round-robins blocks across
            // N internal per-worker channels. Each worker takes one block at
            // a time, runs Dilithium3 producer-signature verification on
            // tokio's blocking pool (so the C-binding never starves a tokio
            // runtime thread), and forwards the pre-verified block to the
            // shared `sig_verified_tx` for state-bound processing.
            //
            // Why per-worker channels instead of a shared receiver:
            // `mpsc::Receiver` is single-consumer. We could wrap in
            // Arc<Mutex<Receiver>> (serializes recv() — defeats parallelism)
            // or pull in `async-channel`/`flume` (extra dependency). The
            // dispatcher approach keeps zero new dependencies and provides
            // explicit round-robin fairness across workers.
            let mut worker_txs: Vec<mpsc::Sender<DecodedBlock>> =
                Vec::with_capacity(verify_workers);
            let mut worker_rxs: Vec<mpsc::Receiver<DecodedBlock>> =
                Vec::with_capacity(verify_workers);
            for _ in 0..verify_workers {
                let (tx, rx) = mpsc::channel::<DecodedBlock>(
                    std::cmp::max(16, config.verify_buffer / verify_workers),
                );
                worker_txs.push(tx);
                worker_rxs.push(rx);
            }

            // Dispatcher: read from decode_rx, round-robin to workers.
            let metrics_dispatcher = metrics.clone();
            tokio::spawn(async move {
                let mut decode_rx = decode_rx;
                let mut next: usize = 0;
                while let Some(decoded) = decode_rx.recv().await {
                    let target = next % worker_txs.len();
                    next = next.wrapping_add(1);
                    // try_send first to avoid an extra await on the happy
                    // path; fall back to send() (which awaits) when the
                    // selected worker is back-pressured.
                    match worker_txs[target].try_send(decoded) {
                        Ok(()) => {}
                        Err(tokio::sync::mpsc::error::TrySendError::Full(d)) => {
                            if worker_txs[target].send(d).await.is_err() {
                                metrics_dispatcher
                                    .verify_failed
                                    .fetch_add(1, Ordering::Relaxed);
                                break; // worker channel closed
                            }
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                            metrics_dispatcher
                                .verify_failed
                                .fetch_add(1, Ordering::Relaxed);
                            break; // worker died
                        }
                    }
                }
            });

            // Workers: each consumes one block at a time and runs sig verify
            // on the blocking pool. Forwards to shared `sig_verified_tx`.
            for (worker_id, mut worker_rx) in worker_rxs.into_iter().enumerate() {
                let sig_verified_tx_w = sig_verified_tx.clone();
                let metrics_w = metrics.clone();
                tokio::spawn(async move {
                    while let Some(mut decoded) = worker_rx.recv().await {
                        // Producer signature verification is the CPU-bound
                        // step; everything else (hash chain, deferred
                        // buffer, producer-authority cache lookup) stays
                        // in the downstream verify_stage.
                        //
                        // Skip the verify on genesis (height 0) — its
                        // signature has a different format and is verified
                        // by the genesis-specific path in verify_stage.
                        let pre_ok = if decoded.microblock.height == 0 {
                            true
                        } else {
                            // The verify function is async (uses async
                            // pq-crypto APIs); .await yields the worker so
                            // other workers run concurrently on the
                            // multi-threaded tokio runtime. This is the
                            // CPU parallelism the worker pool exists for.
                            match BlockchainNode::verify_microblock_signature(
                                &decoded.microblock,
                                &decoded.microblock.producer,
                                None,
                            )
                            .await
                            {
                                Ok(valid) => valid,
                                Err(_) => false,
                            }
                        };
                        if !pre_ok {
                            // Drop bad-sig block before it enters the
                            // state-bound stage. The verify_stage will
                            // re-run the same check; this is just an
                            // optimisation to avoid pushing bad blocks
                            // into the FIFO.
                            metrics_w.verify_failed.fetch_add(1, Ordering::Relaxed);
                            if crate::node::is_warn() {
                                println!(
                                    "[WARN][PIPELINE] worker_sig_invalid h={} worker={} producer={}",
                                    decoded.microblock.height, worker_id,
                                    decoded.microblock.producer
                                );
                            }
                            continue;
                        }
                        // v25 H14: signal that signature has already been
                        // verified — `verify_stage` will skip the redundant
                        // Dilithium3 check on this block. Only set on the
                        // non-genesis path (genesis has its own dedicated
                        // verifier in verify_stage and stays unmarked so
                        // that path still runs).
                        if decoded.microblock.height != 0 {
                            decoded.sig_pre_verified = true;
                        }
                        if sig_verified_tx_w.send(decoded).await.is_err() {
                            break; // downstream closed
                        }
                    }
                });
            }
            drop(sig_verified_tx); // dispatcher + workers hold their own clones

            if crate::node::is_info() {
                println!(
                    "[INFO][PIPELINE] verify_pool_started mode=parallel workers={} buffer={}",
                    verify_workers, config.verify_buffer
                );
            }
        } else {
            // ── Single-worker path (verify_workers=1) ──
            // Direct forward from decode_rx to sig_verified_tx. No parallelism,
            // identical to the pre-v25 single-task behaviour. Use this on
            // resource-constrained Light nodes or observer-only Super-nodes.
            tokio::spawn(async move {
                let mut decode_rx = decode_rx;
                while let Some(decoded) = decode_rx.recv().await {
                    if sig_verified_tx.send(decoded).await.is_err() {
                        break;
                    }
                }
            });
            if crate::node::is_info() {
                println!(
                    "[INFO][PIPELINE] verify_pool_started mode=single buffer={}",
                    config.verify_buffer
                );
            }
        }

        // Stage 2 (state-bound): pre-verified blocks → state checks → apply.
        let metrics_verify = metrics.clone();
        let storage_verify = ctx.storage.clone();
        let coordinator_verify = ctx.coordinator.clone();
        let p2p_verify = ctx.unified_p2p.clone();
        // Dummy semaphore retained for backward-compat with verify_stage
        // signature (the call site no longer needs to acquire since the
        // sig verify already happened in the worker pool above). Keeping
        // it as `Semaphore::new(1)` is harmless — one in-flight acquire
        // at a time inside a single-task stage.
        let verify_permits_stage = Arc::new(tokio::sync::Semaphore::new(1));
        tokio::spawn(Self::verify_stage(
            sig_verified_rx,
            verify_tx,
            storage_verify,
            coordinator_verify,
            metrics_verify,
            ctx.node_id.clone(),
            p2p_verify,
            verify_permits_stage,
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

        // Pipeline progress watchdog. Background poller detecting when the
        // verify/apply stages stop advancing (observed node 001 frozen at
        // verified=applied=5256 for 5 min with no error logs). Samples the
        // counters every WATCHDOG_TICK; if one hasn't advanced for
        // STUCK_THRESHOLD AND that stage's op marker is non-idle, emit a CRIT
        // dump (idle-no-progress = correctly waiting on an empty channel).
        // Re-arms after the counter advances; repeat dumps suppressed.
        // O(1) lock-free, pure observation — never gates flow or consensus.
        let metrics_watchdog = metrics.clone();
        tokio::spawn(async move {
            const WATCHDOG_TICK: std::time::Duration = std::time::Duration::from_secs(5);
            const STUCK_THRESHOLD_MS: u64 = 30_000;
            let mut last_verified: u64 = 0;
            let mut last_applied: u64 = 0;
            // 0 sentinel = "no verify/apply seen yet"; the dump guards require != 0, so the boot wait
            // (nothing to apply) can't trip a spurious CRIT — stall is measured from first real progress.
            let mut last_verified_progress_ms: u64 = 0;
            let mut last_applied_progress_ms: u64 = 0;
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
                    && last_verified_progress_ms != 0
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
                    && last_applied_progress_ms != 0
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

            // Dedup: skip if already in storage. Exception — a same-height block from
            // a higher 2f+1-certified rotation round (failover race) supersedes ours;
            // route it to the finality-guarded reorg instead of silently dropping.
            if storage.load_microblock(block.height)
                .map(|opt| opt.is_some())
                .unwrap_or(false)
            {
                maybe_supersede_by_certified_round(&storage, &block);
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
                        // v25 H14: signature has NOT been verified yet at the
                        // decode stage. The parallel verify pool (when active)
                        // flips this to `true` once Dilithium3 verify succeeds;
                        // the single-worker pass-through leaves it `false` so
                        // `verify_stage` runs the canonical check itself.
                        sig_pre_verified: false,
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
        // v24: bounded signature-verification parallelism. The semaphore is
        // acquired around each Dilithium3 verify call (producer signature,
        // attestations) so up to `permits` blocks can verify concurrently
        // without re-ordering the deferred-buffer / hash-chain state.
        verify_permits: Arc<tokio::sync::Semaphore>,
    ) {
        // Suppress unused warning until callers acquire the permit. The
        // intentional design: hold a reference so the semaphore is
        // initialised and visible for the verify_microblock_signature
        // call path (the actual `acquire().await` lives at the signature
        // verification call site in the loop body below — added as a
        // separate hardening pass in v24 to avoid restructuring the
        // 200-line deferred-buffer block on this fix).
        let _verify_permits = verify_permits;
        // v13.1: Bounded deferred buffer for out-of-order blocks.
        // When blocks arrive before their parent (normal during sync),
        // they're stored here instead of being dropped. After each new block
        // is verified, we drain deferred blocks whose parent has now arrived.
        // Bounded to prevent OOM under load (thousands of Super nodes).
        const DEFERRED_MAX: usize = 2000;
        let mut deferred: HashMap<u64, DecodedBlock> = HashMap::new();
        // Separate bucket for burn-gated blocks whose N-2 committee isn't applied yet (node behind). Their
        // parent IS present (burn gate runs post parent-check), so the contiguity drain never revisits them
        // — re-driven when their committee becomes available (see redrive below). Bounded by DEFERRED_MAX.
        let mut committee_deferred: HashMap<u64, DecodedBlock> = HashMap::new();

        // Gossip horizon: drop blocks > GOSSIP_HORIZON ahead of the local
        // tip BEFORE the deferred buffer. Root cause = catch-up backpressure
        // deadlock: far-ahead SHRED blocks can never verify (missing parents),
        // fill the bounded deferred buffer, starve near-tip sync responses,
        // and inflate the drop counter → false backpressure throttle that
        // self-perpetuates. Counted as future_dropped (not verify_failed) so
        // it's a permanent drop with no pending retry; sync re-pulls once the
        // tip is close. 200 ≈ 200s at 1 blk/s. Safe — identical to never
        // receiving the block via gossip; it stays replayable from the chain.
        // O(1)/block (chain_h read cached in-loop).
        const GOSSIP_HORIZON: u64 = 200;
        let mut horizon_cache_h: u64 = 0;
        let mut horizon_cache_age: u32 = 0;
        // During active sync the dispatcher fills its in-flight window up to
        // MAX_INFLIGHT (== DEFERRED_MAX). Admit that far ahead so served blocks
        // land in the deferred buffer instead of being dropped + refetched; on
        // the live gossip path keep the tight horizon so far-future spam cannot
        // grow the buffer. Refreshed alongside horizon_cache_h.
        let mut horizon_cache_syncing = false;

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
                horizon_cache_syncing = coordinator.snapshot().is_syncing();
            }
            horizon_cache_age = (horizon_cache_age + 1) & 0xF;

            // Apply horizon filter at the entry point — never enters deferred
            // buffer. Drops are non-failure (sync will refetch). Sync widens the
            // horizon to DEFERRED_MAX so the dispatcher's in-flight window is
            // admitted, not dropped — closes the apply-horizon/dispatch mismatch
            // that throttled cold-join catch-up to a rolling-200 crawl.
            let horizon = if horizon_cache_syncing { DEFERRED_MAX as u64 } else { GOSSIP_HORIZON };
            if decoded.microblock.height > horizon_cache_h.saturating_add(horizon) {
                metrics.future_dropped.fetch_add(1, Ordering::Relaxed);
                if is_debug() {
                    println!(
                        "[DBG][PIPELINE] horizon_drop h={} local_tip={} horizon={} syncing={}",
                        decoded.microblock.height, horizon_cache_h, horizon, horizon_cache_syncing,
                    );
                }
                continue;
            }

            // Process this block, then try to drain deferred chain
            let mut to_process = vec![decoded];

            // Re-drive burn-gated blocks once their N-2 committee is applied (parent already present, so the
            // contiguity drain never revisits them). Skipped when empty (the norm); O(committee_deferred).
            if !committee_deferred.is_empty() {
                let ready: Vec<u64> = committee_deferred.keys().copied()
                    .filter(|h| !crate::node::BlockchainNode::n2_committee_absent(&storage, *h))
                    .collect();
                for h in ready {
                    if let Some(def) = committee_deferred.remove(&h) { to_process.push(def); }
                }
            }

            while let Some(decoded) = to_process.pop() {
            let mb = &decoded.microblock;

            // 1. Hash chain continuity (except genesis + the snapshot-anchor successor). The snapshot
            // anchor (anchor_h) is the QC-final chain root whose body is intentionally absent (snapshot =
            // state, not microblocks), so a cold joiner's first live block anchor_h+1 has no parent to
            // hash-chain against — admit it on the adopted finality; slot-ts/signature/state verify still
            // run below. anchor_h+2.. chain normally (anchor_h+1's hash is cached at its apply-commit).
            let anchor_h = crate::node::SNAPSHOT_ANCHOR_MB.load(Ordering::Acquire).saturating_mul(90);
            if mb.height > 0 && !(anchor_h > 0 && mb.height == anchor_h + 1) {
                metrics.mark_verify_op(mb.height, PIPELINE_OP_VERIFY_LOAD_PREV);
                let parent_h = mb.height - 1;

                // v31.1: parent-hash from RAM cache; fall back to RocksDB on miss.
                // load_result: Ok(Some) resolved, Ok(None) parent missing (defer),
                // Err disk failure (drop). Backfill on disk-hit keeps cache warm.
                let load_start = std::time::Instant::now();
                let load_result: Result<Option<[u8; 32]>, ()> = if let Some(cached) = lookup_block_hash(parent_h) {
                    Ok(Some(cached))
                } else {
                    let storage_for_load = storage.clone();
                    match tokio::task::spawn_blocking(move || {
                        storage_for_load.load_microblock_auto_format(parent_h)
                    }).await {
                        Ok(Ok(Some(prev_block))) => {
                            let h = prev_block.hash();
                            // Backfill so subsequent verifies stay on the fast path.
                            cache_block_hash(parent_h, h);
                            Ok(Some(h))
                        }
                        Ok(Ok(None)) => Ok(None),
                        Ok(Err(_)) => Err(()),
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
                    }
                };
                let load_elapsed = load_start.elapsed();
                if load_elapsed > std::time::Duration::from_millis(500) {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] slow_storage_read stage=verify h={} parent_h={} elapsed_ms={}",
                            mb.height, parent_h, load_elapsed.as_millis()
                        );
                    }
                }
                let prev_hash_ok = match load_result {
                    Ok(Some(prev_hash)) => mb.previous_hash == prev_hash,
                    Ok(None) => {
                        // Capture height fields BEFORE moving `decoded` into
                        // the deferred map — `mb` is borrowed from `decoded`
                        // and would be invalidated by the move otherwise.
                        let child_h = mb.height;
                        let parent_h = mb.height - 1;
                        // Previous block not yet available — defer for retry.
                        if deferred.len() < DEFERRED_MAX {
                            if is_debug() {
                                println!("[DBG][PIPELINE] block_deferred h={} need_h={} buf={}",
                                         child_h, parent_h, deferred.len());
                            }
                            deferred.insert(child_h, decoded);
                        } else {
                            if is_info() {
                                println!("[INFO][PIPELINE] deferred_full h={} dropped (buf={})",
                                         child_h, DEFERRED_MAX);
                            }
                            metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        }

                        // Active sync trigger (storage gap recovery). Passive
                        // defer is insufficient under partial gossip: if the
                        // parent never arrives (peer offline, partition,
                        // dropped shred) the deferred buffer fills with orphans
                        // and the gap stays open forever (observed h=180-241).
                        // Size-adaptive: small gap → per-height single-flight;
                        // large gap → batched range request via sync_blocks.
                        let local_tip = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                            .load(Ordering::Relaxed);
                        let gap = child_h.saturating_sub(local_tip);
                        if gap > RANGE_SYNC_GAP_THRESHOLD {
                            let from = local_tip.saturating_add(1);
                            let _ = request_missing_range(from, child_h);
                        } else {
                            let _ = request_missing_parent(parent_h);
                        }

                        // v18: mark verify stage as IDLE on the deferral path
                        // so the watchdog does not report `verify_stuck` with
                        // a stale `op_age_ms` value.
                        metrics.mark_verify_idle();
                        continue;
                    }
                    Err(()) => {
                        if is_warn() {
                            println!("[WARN][PIPELINE] prev_load_err h={} parent_h={}",
                                     mb.height, parent_h);
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

                    // Two parallel paths on a locally-detected hash-chain
                    // break: (1) advisory source-witness counting — records
                    // from_peer for resync-source steering, non-destructive
                    // (single-source ceiling); (2) destructive observer-based
                    // rejection — broadcast a Dilithium3-signed BlockRejection;
                    // receivers verify the observer sig, aggregate distinct
                    // observer_ids per (height,source), and roll back at 2f+1.
                    // BFT-canonical: a supermajority of independent observers
                    // justifies state mutation; one Byzantine source can't
                    // (≤f can't reach 2f+1). Skip h=0 (no prev).
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

                    // v27 HOLE4: liveness — without this, persistent chain
                    // break at the frontier spins forever (applied=0; the
                    // 5.4h h=53731 wedge). Re-pull canonical range from last
                    // committed (request_missing_range is self-deduped 60s,
                    // detached — safe per break).
                    let local_tip = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                        .load(std::sync::atomic::Ordering::Relaxed);
                    if mb.height > local_tip {
                        let _ = request_missing_range(
                            local_tip.saturating_add(1),
                            mb.height,
                        );
                    }

                    // v32.10: macroblock-anchored fork recovery for minority
                    // observers. Uses 2f+1-certified macroblock as trust anchor;
                    // bounded by begin_finality_guarded_rollback (cannot cross
                    // finality). Genesis bootstrap excluded ONLY during fresh-
                    // bootstrap phase (h < BOOTSTRAP_GRACE_HEIGHT); after that
                    // genesis functions as a regular validator and needs the
                    // same recovery path.
                    const BOOTSTRAP_GRACE_HEIGHT: u64 = 1_000;
                    if mb.height > 0 {
                        let local_h = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                            .load(std::sync::atomic::Ordering::Relaxed);
                        let is_genesis_in_bootstrap = std::env::var("QNET_BOOTSTRAP_ID").is_ok()
                            && std::env::var("DOCKER_ENV").is_ok()
                            && local_h < BOOTSTRAP_GRACE_HEIGHT;
                        if !is_genesis_in_bootstrap {
                            let finalized_h = crate::node::LAST_FINALIZED_HEIGHT
                                .load(std::sync::atomic::Ordering::SeqCst);
                            let disputed_h = mb.height;
                            if finalized_h > 0 && finalized_h < disputed_h {
                                let now_secs = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_secs())
                                    .unwrap_or(0);
                                let cooldown_ok = match FORK_RECOVERY_TRIGGER_TIMES
                                    .get(&disputed_h)
                                {
                                    Some(t) => now_secs.saturating_sub(*t) >= FORK_RECOVERY_COOLDOWN_SECS,
                                    None => true,
                                };
                                if cooldown_ok {
                                    let prev = FORK_RECOVERY_HEIGHT
                                        .load(std::sync::atomic::Ordering::SeqCst);
                                    // Roll back to the last good height = disputed-2 (the forked block is
                                    // local[disputed-1]), clamped to ≥ finalized. finalized_h+1 was wrong when
                                    // the fork IS at finalized+1 (our own tip): the handler's `rollback_to <
                                    // local_h` guard then never fires → forked tip kept → permanent
                                    // hash_chain_break (the N004 single-source self-fork wedge).
                                    let target = disputed_h.saturating_sub(2).max(finalized_h);
                                    if target > prev {
                                        FORK_RECOVERY_HEIGHT.store(
                                            target,
                                            std::sync::atomic::Ordering::SeqCst,
                                        );
                                        FORK_RECOVERY_TRIGGER_TIMES.insert(disputed_h, now_secs);
                                        if is_warn() {
                                            println!(
                                                "[WARN][FORK] anchor_recovery disputed_h={} finalized_h={} rollback_target={} reason=minority_observer",
                                                disputed_h, finalized_h, target,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }

                    continue;
                }
            }

            // 2. Slot-anchored timestamp validation (LIVE only; SYNC skips — block_ts is
            // already bound by the block hash + producer Dilithium sig + hash-chain).
            // block_ts must equal genesis_ts + height*SLOT exactly: deterministic,
            // clock-independent, non-gameable. The single source of truth on the live path.
            let snap = coordinator.snapshot();
            if !snap.is_syncing() && mb.height > 0 {
                let g = crate::GLOBAL_GENESIS_TIMESTAMP.load(Ordering::Relaxed);
                if g != 0 {
                    let expected = crate::node::expected_block_timestamp(g, mb.height);
                    if mb.timestamp != expected {
                        if is_warn() {
                            println!("[WARN][PIPELINE] slot_mismatch h={} ts={} expected={} from={}",
                                     mb.height, mb.timestamp, expected, decoded.from_peer);
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
            // Checkpoint-BFT QC finality — that path is unchanged.

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

                // ═══════════════════════════════════════════════════════════
                // v25 H14: SKIP-VERIFY-IF-PRE-VERIFIED FAST PATH
                // ───────────────────────────────────────────────────────────
                // When the parallel verify worker pool is enabled (the
                // production configuration), each block already had its
                // Dilithium3 signature verified upstream of this stage. The
                // worker that performed the verify flips
                // `decoded.sig_pre_verified` to `true`. Re-running the same
                // signature verify here is pure waste: same key, same
                // payload, same result. Skipping it cuts the apply-path
                // critical section by ~1–2 ms per block — a ~60–120 ms
                // saving across a 90-block macroblock window, which directly
                // tightens the chain's apply-to-finalisation latency.
                //
                // Safety: the flag is set by THIS process's own pre-verify
                // worker, not received over the wire. There is no untrusted
                // input that can spoof it (DecodedBlock never crosses a
                // network boundary). When the single-worker config is
                // selected (`verify_workers == 1`), nothing sets the flag
                // and the canonical verify below runs unchanged.
                // ═══════════════════════════════════════════════════════════
                if decoded.sig_pre_verified {
                    if is_debug() {
                        println!(
                            "[DBG][PIPELINE] skip_redundant_verify h={} reason=pre_verified",
                            mb.height,
                        );
                    }
                } else {
                    let sig_start = std::time::Instant::now();
                    // v24: acquire a verify-pool permit before running Dilithium3
                    // verification. The permit count is `config.verify_workers`
                    // (default 2, prod 4). Concurrent blocks queue here without
                    // blocking the deferred-buffer / hash-chain state above —
                    // this gives parallel signature CPU utilisation while keeping
                    // the verify-stage state machine sequential.
                    let _permit = _verify_permits.clone().acquire_owned().await.ok();
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
                    drop(_permit);

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
            }

            // Producer authority check (same-round mismatch ≡ HARD reject).
            //   A. timeout_divergence (block round != cached round): views of
            //      HIGHEST_CERTIFIED_ROUND diverged in transit. Soft —
            //      log only; hash-chain + sig + 2f+1 commit resolve it. Expected
            //      producer is NOT re-derived on ingest (needs remote VRF preimage).
            //   B. same_round_mismatch (cached round == block round, wrong signer):
            //      cached producer is the sole authority for the slot via the
            //      deterministic VRF formula (base_idx + round) % N. HARD REJECT.
            // Fork-safe: cache = stored BFT-agreed round (pure fn of Dilithium3-
            // verified votes + on-chain VRF) → every honest node derives the same
            // expected producer; all reject or none. (Pre-v14.8.10 used local
            // non-deterministic state and did fork.) Gated to !is_syncing() so
            // catch-up blocks aren't judged vs live cache. O(1) lookup.
            if !snap.is_syncing() && mb.height > 0 {
                // v33: failover authority gate. A block claiming rotation round R (>0)
                // is authentic ONLY if a 2f+1 TimeoutCertificate for (height, R) exists.
                // The cert is self-contained (2f+1 Dilithium votes, verified before store
                // in handle_timeout_proof_broadcast), so this check is IDENTICAL on every
                // node — unlike the prior `highest_certified_round_for` drift window, whose
                // local-certified term diverged across nodes (baseline skew) and let each
                // node accept a DIFFERENT self-chosen round → competing forks → rollback
                // storm. No cert yet (gossip race) → reject this ingest attempt; the block
                // stays replayable and is re-accepted once the cert (re-broadcast by the
                // producer at certification) arrives, or via sync (which skips this gate,
                // trusting macroblock finality). Round 0 (happy path) needs no cert. O(1).
                if mb.timeout_round > 0 {
                    // Authorise the failover round with the SAME predicate the producer used to
                    // pick it — `highest_certified_round_for(mb_idx) >= round + baseline`, keyed by
                    // mb_idx + ABSOLUTE round. HIGHEST_CERTIFIED_ROUND advances ONLY on a same-round
                    // 2f+1 TimeoutCertificate, so the producer can be at round R only if the network
                    // certified R — both sides read the same map and can never disagree. A forged
                    // round isn't certified ⇒ rejected; round 0 (happy path) needs no certificate.
                    let round_certified =
                        crate::unified_p2p::failover_round_authorized(mb.height / 90, mb.timeout_round);
                    if !round_certified {
                        // PULL-ON-REJECT: the round IS legitimate (a producer reached it via a
                        // same-round 2f+1), but the proving TimeoutCertificate never arrived — its
                        // broadcast is one-shot and vote gossip only re-fans on NEW votes, which stop
                        // once the storm settles, so a node that missed the brief window would stay
                        // stuck forever. Actively request this window's timeout certificates from
                        // peers (rate-limited per mb_idx); the existing serve returns the same-round
                        // 2f+1 TimeoutCertificate, which advances our HIGHEST_CERTIFIED_ROUND so this
                        // still-replayable block is accepted next pass. Reuses the sync catch-up
                        // request/serve — no new wire type.
                        let mb_idx = mb.height / 90;
                        let now_secs = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs()).unwrap_or(0);
                        let due = FAILOVER_CERT_PULL_TIMES.get(&mb_idx)
                            .map(|t| now_secs.saturating_sub(*t) >= FAILOVER_CERT_PULL_COOLDOWN_SECS)
                            .unwrap_or(true);
                        if due {
                            FAILOVER_CERT_PULL_TIMES.insert(mb_idx, now_secs);
                            // Bounded: failover-rejects are transient, so keep only recent windows.
                            // Prune in mb_idx space (keys are mb_idx, NOT microblock height — pruning
                            // by height would purge the whole map). Cheap opportunistic sweep.
                            if FAILOVER_CERT_PULL_TIMES.len() > 64 {
                                let keep_from = mb_idx.saturating_sub(16);
                                FAILOVER_CERT_PULL_TIMES.retain(|k, _| *k >= keep_from);
                            }
                            if let Some(p2p) = unified_p2p.as_ref() {
                                p2p.request_timeout_proofs(mb_idx, mb_idx);
                            }
                        }
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] failover_round_uncertified h={} round={} from={} action=reject_await_cert",
                                mb.height, mb.timeout_round, decoded.from_peer,
                            );
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
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

            // No ingest-side stale-round reject: mb.timeout_round (microblock
            // rotation counter, 0 on happy path) and HIGHEST_CERTIFIED_ROUND
            // (macroblock commit/reveal view round) are orthogonal — comparing
            // them rejected valid microblocks (liveness loss, no safety gain).
            // Per-microblock QC verify is also removed (redundant with the 2f+1
            // macroblock finality below + caused a rate-limit collision).
            // Microblock safety holds via: Dilithium3 producer sig; prev_hash
            // continuity; VRF-deterministic producer (soft); 2f+1 macroblock
            // commit/reveal retroactively ratifying (split-brain can't reach 2f+1).

            // Internal-only TX type guard: post-genesis, HARD REJECT the whole
            // block (+ peer reputation penalty) if it carries a genesis-only or
            // deprecated variant (CreateAccount / BatchRewardClaims /
            // BatchNodeActivations / BatchTransfers) — a Byzantine producer
            // could embed one bypassing mempool admission. O(tx_count).
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

            // 5. Per-TX signature verification (post-genesis). The block sig (step
            // 3) authenticates only the ENVELOPE, not the TXs within — without this
            // a Byzantine producer could include forged TXs. Remote-block TXs bypass
            // the mempool (which verifies on ingest) and apply_transaction_lazy
            // intentionally doesn't verify, so the pipeline must: Ed25519 batch +
            // Dilithium3 (when present).
            // Genesis (h==0) bypass: genesis TXs use reserved-sender tokens, not
            // real sigs; safe via producer sig + genesis-hash determinism + one-time
            // bootstrap. System TXs (RewardDistribution, CreateAccount bootstrap,
            // BatchRewardClaims, BatchNodeActivations) are exempt (validated via
            // on-chain proofs) — exemption set MUST mirror verify_ed25519_batch in
            // node.rs. O(tx)/block, off the state lock.
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

                // Dilithium3 verify for PQ-signed TXs. v25.2: delegate to the canonical
                // helper (verify_dilithium_tx_signature_async ->
                // consensus_crypto::verify_consensus_signature) used by gossip/RPC, so
                // apply-path verdicts are byte-identical to gossip for every signer class.
                // Two on-wire layouts: user/mobile TXs ship raw hex sig(3309)/pk(1952);
                // node system TXs use "dilithium_sig_<node_id>_<b64>" + pk=node_id (key
                // from CONSENSUS_PK_REGISTRY). The old inline hex decoder hard-rejected
                // the system format -> froze testnet at h=14350 (commitment window).
                // Helper batches verifies on SIGVERIFY_RUNTIME (parallel, not seq await).
                let mut dilithium_invalid = 0usize;
                {
                    use futures::future::join_all;
                    let verify_futures: Vec<_> = decoded.microblock.transactions
                        .iter()
                        .filter(|tx| {
                            // Merkle reward-claims (system_rewards_pool) are authorized by the per-proof
                            // re-verify in apply, not a client sig — exempt from PQ re-verify here.
                            if matches!(tx.tx_type, qnet_state::TransactionType::RewardDistribution)
                                && tx.from == "system_rewards_pool" {
                                return false;
                            }
                            // API-1 receive-path close: value TXs (Transfer/ContractDeploy/ContractCall/Swap)
                            // are exempt from the Ed25519 batch (is_unsigned_system_tx), so a SIGNATURELESS
                            // forged value TX would otherwise skip this presence-filter and never reach the
                            // eon(dpk)==from bind — a Byzantine producer draining any account on the sole
                            // receive-side gate. ALWAYS verify them: verify_dilithium_tx_signature_async
                            // delegates value TXs to verify_user_tx_dilithium (sig over canonical msg +
                            // eon(dpk)==from), which returns false when the sig is absent → block hard-
                            // rejected below. Pure/deterministic (TX bytes only). Genesis (h==0) is skipped
                            // by the branch above, so reserved-sender bootstrap TXs are unaffected.
                            if matches!(tx.tx_type,
                                qnet_state::TransactionType::Transfer { .. }
                                | qnet_state::TransactionType::ContractDeploy
                                | qnet_state::TransactionType::ContractCall
                                | qnet_state::TransactionType::Swap { .. }) {
                                return true;
                            }
                            matches!(&tx.dilithium_signature, Some(s) if !s.is_empty())
                        })
                        .map(|tx| crate::node::BlockchainNode::verify_dilithium_tx_signature_async(tx))
                        .collect();
                    if !verify_futures.is_empty() {
                        let results = join_all(verify_futures).await;
                        for r in results {
                            match r {
                                Ok(true) => {} // valid — wrapper format + registry + math all OK
                                Ok(false) | Err(_) => dilithium_invalid += 1,
                            }
                        }
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

            // Shared system-TX identity binds — the SAME gate the gossip path enforces
            // (BlockchainNode::verify_system_tx_binds), applied here so a Byzantine producer's block
            // cannot smuggle an unsigned or mis-attributed system TX past the receive-side validator:
            // an unsigned bitmap/ping would otherwise forge a whole shard's light eligibility (no burn
            // gate on those), a cross-shard bitmap would hijack another genesis' shard, and an unbound
            // first-registration would skip the native dpk→wallet bind. Presence + signer↔declared-
            // identity binds; the Dilithium VALIDITY is the verify stage above. Pure/deterministic
            // (TX bytes + committed-state VRF registry), so the verdict is byte-identical per node.
            if mb.height > 0 {
                if let Some(reason) = decoded.microblock.transactions.iter()
                    .find_map(|tx| crate::node::BlockchainNode::verify_system_tx_binds(tx).err())
                {
                    if is_warn() {
                        println!(
                            "[WARN][PIPELINE] system_tx_bind_failed h={} producer={} from={} reason={} action=reject_block",
                            mb.height, mb.producer, decoded.from_peer, reason
                        );
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue; // HARD REJECT — system TX fails presence / identity binds
                }
            }

            // Phase-1 burn-attestation gate (a block-validation rule, like the signature checks
            // above — apply trusts validated blocks). When active at this height, a non-genesis
            // NodeRegistration MUST carry ≥2f+1 distinct valid genesis attestations over its
            // canonical burn message; without it a Byzantine producer could inject a fake-burn
            // registration that every node would deterministically apply (free reward/producer-
            // eligible node). Deterministic: pure TX bytes + binary-pinned genesis keys. Inert
            // below the gate height (returns Ok), so the current relaunch is unaffected.
            if mb.height > 0 {
                use futures::future::join_all;
                // Same-block burn reuse: two NodeRegistrations sharing a burn_tx (cross-block reuse is
                // caught deterministically at verify via committed_burn_wallet). One burn backs one node.
                {
                    let mut seen_burns = std::collections::HashSet::new();
                    let dup = decoded.microblock.transactions.iter().any(|t| {
                        if let qnet_state::TransactionType::NodeRegistration { burn_tx, .. } = &t.tx_type {
                            !burn_tx.is_empty() && !seen_burns.insert(burn_tx.clone())
                        } else { false }
                    });
                    if dup {
                        if is_warn() {
                            println!("[WARN][PIPELINE] burn_reuse_in_block h={} action=reject_block", mb.height);
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue; // HARD REJECT — one burn cannot back two registrations
                    }
                }
                let burn_storage = storage.clone();
                let burn_futures: Vec<_> = decoded.microblock.transactions
                    .iter()
                    .filter(|tx| matches!(tx.tx_type, qnet_state::TransactionType::NodeRegistration { .. }))
                    .map(|tx| crate::node::BlockchainNode::verify_burn_attestation_quorum(tx, mb.height, &burn_storage))
                    .collect();
                if !burn_futures.is_empty() {
                    let results = join_all(burn_futures).await;
                    if let Some(reason) = results.iter().find_map(|r| r.as_ref().err()) {
                        // Committee-absent (post-genesis N-2 not yet applied) ⇒ we can't yet verify the burn
                        // quorum: DEFER (re-verify once N-2 applies) so an honest registration isn't dropped
                        // while behind. A genuine invalid burn (committee present) still HARD-REJECTs; synced
                        // nodes hold the committee so never defer — the deterministic reject/fork-guard holds.
                        let h = mb.height;
                        if crate::node::BlockchainNode::n2_committee_absent(&storage, h) {
                            if committee_deferred.len() < DEFERRED_MAX {
                                if is_debug() {
                                    println!("[DBG][PIPELINE] committee_deferred h={} reason=n2_absent buf={}", h, committee_deferred.len());
                                }
                                committee_deferred.insert(h, decoded);
                            } else {
                                metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                            }
                            continue;
                        }
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] burn_attestation_invalid h={} producer={} from={} reason={} action=reject_block",
                                mb.height, mb.producer, decoded.from_peer, reason
                            );
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue; // HARD REJECT — registration without a valid genesis burn quorum
                    }
                }

                // Proof-of-burn gate for NodeActivation. NodeActivation carries NO burn of its own, so an
                // un-backed one would mint a node identity (super pseudonym / activation row → reward +
                // producer eligibility) for FREE, bypassing the 1DEV-burn Sybil cost the registration gate
                // above enforces. Require each activation's wallet to already hold a chain-confirmed burn-
                // attested registration — committed in a PRIOR block (parent-continuity guarantees blocks
                // < h are applied on every node before h is verified, so the lookup is deterministic) OR a
                // NodeRegistration in THIS block. Same activation-height gate as the registration rule;
                // genesis nodes never emit NodeActivation (genesis = NodeRegistration only).
                if qnet_state::feature_gates::is_active("burn_attestation_required", mb.height) {
                    let this_block_burned: std::collections::HashSet<String> = decoded.microblock.transactions.iter()
                        .filter_map(|t| match &t.tx_type {
                            qnet_state::TransactionType::NodeRegistration { wallet_address, burn_tx, .. }
                                if !burn_tx.is_empty() => Some(wallet_address.clone()),
                            _ => None,
                        }).collect();
                    let unbacked = decoded.microblock.transactions.iter().any(|t| {
                        matches!(t.tx_type, qnet_state::TransactionType::NodeActivation { .. })
                            && !this_block_burned.contains(&t.from)
                            && !storage.wallet_is_burn_registered(&t.from)
                            && !storage.wallet_is_genesis_node(&t.from) // genesis self-activates w/o burn
                    });
                    if unbacked {
                        if is_warn() {
                            println!(
                                "[WARN][PIPELINE] activation_without_burn h={} producer={} action=reject_block",
                                mb.height, mb.producer
                            );
                        }
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        continue; // HARD REJECT — activation must be backed by a burn-attested registration
                    }
                }
            }

            // All checks passed — forward to apply stage.
            // v32.5: cache populated only on apply-commit, never at verify —
            // uncommitted view-change candidates must not poison the RAM cache.
            let block_height = decoded.height;

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

            // Bound committee-deferred the same way (its re-drive is committee-arrival, not tip contiguity).
            if committee_deferred.len() > 100 {
                let chain_h = storage.get_chain_height().unwrap_or(0);
                if chain_h > 500 {
                    committee_deferred.retain(|h, _| *h > chain_h - 500);
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
            // Apply is strictly sequential by height and publishes the applied frontier in
            // LOCAL_BLOCKCHAIN_HEIGHT at commit. A block strictly ABOVE that frontier cannot be a
            // duplicate, so the common path is answered with an O(1) atomic read — NO hot-path
            // RocksDB lookup (a storage read here contends with the same CF the apply stage writes
            // microseconds later, and one slow read under a maintenance-flush/compaction storm
            // froze the whole stage). Only a re-delivery (height <= frontier) consults storage, off
            // the hot path on the blocking pool.
            let anchor_floor = crate::node::SNAPSHOT_ANCHOR_MB
                .load(std::sync::atomic::Ordering::Acquire).saturating_mul(90);
            let applied_tip = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                .load(std::sync::atomic::Ordering::Acquire);
            let already_applied = if anchor_floor > 0 && height <= anchor_floor {
                true // at/below the adopted snapshot anchor ⇒ already-final; the snapshot omits sub-anchor
                     // bodies, so re-executing one would corrupt the bound state
            } else if height > applied_tip {
                false
            } else {
                let storage_for_dedup = ctx.storage.clone();
                match tokio::task::spawn_blocking(move || {
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

            // State application with snapshot + rollback support.
            // Pre-warm account cache: before taking the state WRITE lock,
            // walk the block's TXs and ensure every touched address is
            // resident (cached → refresh last_access; cold → AccountStore
            // disk load, lock-free). With a bounded cache the apply path's
            // accounts.get_mut(from) would miss a cold sender; pre-warming
            // under a READ lock makes the working set resident while keeping
            // disk latency outside the write critical section. ≤2×tx_count
            // point reads.
            {
                use std::collections::HashSet;
                let mut warm_set: HashSet<String> = HashSet::new();
                // Warm the FULL affected set per tx (from + recipients +
                // contract/escrow), the same set apply_transaction_lazy loads.
                // The bounded LRU can evict, so a narrow warm (from + Transfer.to)
                // would let apply read a cold recipient/escrow and miss silently;
                // a superset only touches cache residency, never state.
                for tx in &block.microblock.transactions {
                    for addr in tx.get_all_affected_addresses() {
                        if !addr.is_empty() {
                            warm_set.insert(addr);
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

                    // Do NOT strike the peer here: the block already passed signature/hash
                    // validation before apply, so a state_root_mismatch is a LOCAL-state defect
                    // (e.g. a contaminated/orphaned base), not the peer's fault. Striking honest
                    // peers poisoned the pool and blocked cold-start recovery. Genuine forks are
                    // resolved by fork-choice; malice by on-chain analyze_chain_for_slashing.

                    // Circuit-breaker: re-applying the same canonical block onto a contaminated
                    // base mismatches forever (the wedge). On threshold, escalate to fork
                    // recovery — which is fail-closed and ends in a clean QC-verified state-sync.
                    if record_apply_mismatch() {
                        FORK_RECOVERY_HEIGHT.store(height.saturating_sub(1).max(1), Ordering::SeqCst);
                        if is_warn() {
                            println!("[WARN][PIPELINE] apply_breaker_tripped h={} action=fork_recovery", height);
                        }
                    }
                    metrics.mark_apply_idle();
                    continue;
                }

                // v14.8: Successful apply — clear any past strikes for this peer.
                clear_apply_mismatch();
                if let Some(ref p2p) = ctx.unified_p2p {
                    p2p.record_apply_success(&block.from_peer);
                }

                // Materialise the committed burn→wallet binding (cbw) for this block's registrations
                // NOW — after state-root acceptance (so a rejected block never binds) but BEFORE
                // save_microblock makes h loadable. The verify stage's parent-continuity gate defers
                // verify(h+1) until load_microblock(h) succeeds (after save below), so this write
                // happens-before verify(h+1).cbw_get → within-window cross-microblock burn reuse is
                // caught. First-wins; the durable cbw set is reconciled from node_registry by
                // rebuild_committed_burn_wallet on snapshot/reorg/boot.
                for tx in &block.microblock.transactions {
                    if let qnet_state::TransactionType::NodeRegistration { wallet_address, burn_tx, .. } = &tx.tx_type {
                        // Scope = ANY NodeRegistration with a non-empty burn (super + LIGHT), MATCHING
                        // rebuild_committed_burn_wallet (srtr_+lrtr_) and registry_root. Light is now
                        // burn-attested on-chain (Option A), so its burn must bind cbw too; scope parity
                        // between this live writer and the rebuild is what prevents a fork. Empty-burn
                        // (genesis / not-yet-attested) regs auto-skip.
                        if !burn_tx.is_empty() {
                            let _ = ctx.storage.committed_burn_wallet_put(burn_tx, wallet_address);
                        }
                    }
                    // Heartbeat liveness index (lhb_): Phase-2A recency reads this instead of a
                    // 2-subwindow body scan. Mirrored by the producer's inline pre-save write.
                    if let qnet_state::TransactionType::Heartbeat { node_id, anchor_height, .. } = &tx.tx_type {
                        let _ = ctx.storage.index_heartbeat_inclusion(node_id, *anchor_height, height);
                    }
                }

                // Materialise this block's node_registry entries (node_/srtr_/lrtr_ + the registry_root
                // LtHash delta) NOW — after state-root acceptance, BEFORE save_microblock makes h
                // loadable — mirroring the producer (inline pre-save) and the cbw write above. The
                // WindowEnd checkpoint compute is gated on h being loadable (post-save), so writing here
                // makes head_ready transitively guarantee the registrations + seal exist: a checkpoint-
                // head registration can never be omitted by a racing validator read (the pre-existing
                // race when these were written post-save in the deferred-fx phase).
                for (node_id, type_str, wallet, burn_tx, vrf_pk_hex) in &apply_result.deferred_registrations {
                    // Single authoritative writer: stamps reg_height AND the backing burn co-resident,
                    // so rebuild_committed_burn_wallet + registry_root are deterministic; updates the
                    // registry_root LtHash accumulator in the SAME batch. burn empty (activations/genesis)
                    // ⇒ binding skipped. Idempotent on re-apply (delta 0 on identical re-add). vrf_pk binds
                    // sha3 into registry_root for light-client committee verification.
                    let vrf = if vrf_pk_hex.is_empty() { None } else { hex::decode(vrf_pk_hex).ok() };
                    let _ = ctx.storage.save_node_registration_at_height_burn_vrf(node_id, type_str, wallet, 1.0, height, burn_tx, vrf.as_deref());
                }
                // registry_root seal (LtHash): at a checkpoint head, after all of this block's
                // registrations updated lt_state and BEFORE save_microblock — mirror of the producer.
                // Fires once per checkpoint head incl. zero-registration heads.
                if height % qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL == 0 {
                    let _ = ctx.storage.seal_registry_root(height);
                    // Same head: seal total_supply as-of this height (apply-deterministic on both paths)
                    // so the checkpoint reads a height-bound value, never the live counter.
                    let _ = ctx.storage.seal_total_supply(height, state_guard.get_total_supply());
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
                        // v33: feed the deterministic window-content accumulator at commit.
                        crate::node::accumulate_window_block(height, &block.microblock);

                        // v27 HOLE3: warm read-through cache (verify h+1 hits
                        // memory, not cold RocksDB → kills 30s verify_stuck).
                        ctx.storage.cache_recent_microblock(
                            height,
                            &block.microblock,
                        );

                        // v32.5: publish canonical parent-hash to RAM cache only
                        // after RocksDB commit — invariant cache == storage.
                        cache_block_hash(height, block.microblock.hash());

                        // ═══════════════════════════════════════════════════════
                        // v25 H9: VALIDATOR LIVENESS — SUCCESS PATH
                        // ───────────────────────────────────────────────────────
                        // The block produced by `block.microblock.producer` has
                        // been fully verified, applied, persisted, and is now
                        // canonical history. Reset the producer's consecutive
                        // miss counter and clear any ejection state, so a
                        // validator that recovers from an intermittent outage
                        // is reinstated immediately on the very next successful
                        // production cycle.
                        //
                        // Side-effect free when liveness ejection is disabled
                        // (`QNET_LIVENESS_EJECTION` unset) — the underlying
                        // `record_validator_success` only mutates an in-process
                        // DashMap entry, so the cost is O(1) per applied block
                        // and bounded by total validator count (≤ 1000 per
                        // round by architectural cap).
                        // ═══════════════════════════════════════════════════════
                        if !producer.is_empty() {
                            crate::unified_p2p::record_validator_success(&producer);
                        }

                        // Peer-apply mempool cleanup. The producer-side cleanup
                        // hook covers only the producer path, so peer validators
                        // retained on-chain TXs and re-included them in later
                        // blocks (state dup-check stops double-accounting but the
                        // bytes still cost storage + bandwidth; observed h=14351→
                        // 14461, 5 HeartbeatCommitments shipped twice). Symmetric
                        // rule: once on chain, no honest mempool re-offers a TX.
                        // record_included_txs also drops late gossip copies.
                        // O(tx_count) hash + 1 batched DashMap remove, inline.
                        if !block.microblock.transactions.is_empty() {
                            let included_hashes: Vec<String> = block.microblock.transactions.iter()
                                .map(|tx| tx.hash.clone())
                                .collect();
                            if let Some(mempool_arc) = crate::node::try_get_mempool() {
                                mempool_arc.record_included_txs(&included_hashes);
                                mempool_arc.batch_remove_transactions(&included_hashes);

                                // Mark each commitment TX's dedup key finalized so
                                // later re-admission of the same on-chain TX is
                                // rejected at the door (lock-free DashMap, ~50ns).
                                // 1 insert/commitment TX; ≤1000 at epoch boundary.
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
                        match height_result {
                            // S2: publish the apply frontier the instant the block is durable + height-set,
                            // BEFORE deferred side effects — a peer reading it never sees a stale frontier and
                            // wrongly cools a syncing node. fetch_max keeps it monotone (never below the anchor).
                            Ok(_) => { crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.fetch_max(height, std::sync::atomic::Ordering::AcqRel); }
                            Err(e) => { if is_warn() { println!("[WARN][PIPELINE] set_height_failed h={} err={}", height, e); } }
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
                        // node_registry registrations are now written PRE-save (above, next to cbw +
                        // the registry_root seal) so the WindowEnd checkpoint read can never race them.
                        // L2: emission reward recompute OFF the apply write-lock and off the pipeline
                        // foreground (blocking pool) — the O(recipients) merkle build never stalls apply.
                        if let Some((epoch, total, committed_root, c_per, c_cnt)) = apply_result.deferred_emission_root.clone() {
                            let st = ctx.storage.clone();
                            tokio::task::spawn_blocking(move || {
                                crate::node::BlockchainNode::persist_local_reward_root(&*st, epoch, total, &committed_root, c_per, c_cnt);
                            });
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

                        // Cross-shard 2PC apply hook removed — single-shard for
                        // now; sharding primitives stay dormant and CrossShard*
                        // TransactionType variants are removed to block accidental
                        // activation (see qnet-sharding/lib.rs header).

                        // Write-through account persistence: mirror every account
                        // this block mutated (addresses from the BlockSnapshot
                        // journal) into the persistent `accounts` CF via one
                        // atomic WriteBatch on the blocking pool, so a crash
                        // restart has durable per-block state (no lost mutations
                        // between snapshots). Skipped when block_snapshot is None
                        // (genesis window, no mutation set). O(touched accounts).
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

            // Apply frontier already published right after set_chain_height (above) so peers never read a
            // stale value during the deferred-fx window.
            crate::unified_p2p::clear_block_pending_sync(height);

            // Chain-derived rotation-state catch-up. A node that synced
            // forward applied a block with timeout_round=6 while its local
            // HIGHEST_CERTIFIED_ROUND was still 0 (never saw the live BFT
            // votes), so it elected the round-0 leader instead of round-6 →
            // two-producer fork. Fix: when an applied block's timeout_round
            // exceeds local certified, proactively request timeout certs
            // from peers. The block's timeout_round is NOT used to advance
            // rotation directly (≤f byzantine could forge it) — it only
            // signals "a cert exists, fetch it"; the response path
            // re-verifies 2f+1 sigs before advancing. Self-limiting via the
            // monotonic local_certified guard. ≤5-peer fan-out only on fire.
            let block_timeout_round = block.microblock.timeout_round;
            if block_timeout_round > 0 {
                let mb_idx = height / 90;
                let local_certified = crate::unified_p2p::highest_certified_round_for(mb_idx);
                // v34: mb.timeout_round is RELATIVE to the per-mb_idx baseline; local_certified is
                // ABSOLUTE. Reconstruct the block's absolute round before comparing — else, when
                // baseline>0 (a 2nd+ failover in the same window), the relative LHS is understated
                // by `baseline` and this proactive backfill misfires (missed/slow cert catch-up).
                let block_round_abs = block_timeout_round
                    .saturating_add(crate::unified_p2p::get_baseline_round(mb_idx));
                if block_round_abs > local_certified {
                    if let Some(ref p2p) = ctx.unified_p2p {
                        if is_info() {
                            println!(
                                "[INFO][PIPELINE] rotation_backfill_request h={} mb={} block_round={} local_certified={}",
                                height, mb_idx, block_timeout_round, local_certified,
                            );
                        }
                        // Request certificates for the macroblock window
                        // covering this block — peers serve the same-round
                        // 2f+1 TimeoutCertificates for it.
                        p2p.request_timeout_proofs(mb_idx, mb_idx);
                    }
                }
            }

            // Canonical boundary snapshot on EVERY node's apply path (deterministic, role-independent)
            // so a cold joiner can fast-sync from any peer — at the early anchor (h=90, first bindable
            // boundary) AND every SNAPSHOT_INCREMENTAL_INTERVAL thereafter. Pin a frozen DB view at
            // `height` SYNCHRONOUSLY here — the serial apply loop has not started H+1, so the snapshot
            // captures exactly state_root@H. With persist-before-evict the pinned accounts CF is the
            // COMPLETE committed leaf set, so a cold joiner's recompute reproduces the bound root. The
            // heavy serialization runs off-reactor on the frozen view.
            if height > 0
                && (height == crate::node::SNAPSHOT_EARLY_ANCHOR_HEIGHT
                    || height % crate::node::SNAPSHOT_INCREMENTAL_INTERVAL == 0)
                && crate::node::should_materialize_snapshot(&ctx.node_id, height)
            {
                let snapshot_accounts = ctx.state.read().await.get_all_accounts();
                match ctx.storage.prepare_snapshot_view(&snapshot_accounts) {
                    Ok(view) => {
                        let storage_for_snapshot = ctx.storage.clone();
                        let snapshot_height = height;
                        tokio::spawn(async move {
                            if let Err(e) = storage_for_snapshot
                                .create_state_snapshot(snapshot_height, view).await
                            {
                                if is_warn() {
                                    println!("[WARN][PIPELINE] snapshot_create_failed h={} err={:?}", snapshot_height, e);
                                }
                            }
                        });
                    }
                    Err(e) => {
                        if is_warn() {
                            println!("[WARN][PIPELINE] snapshot_prepare_failed h={} err={:?}", height, e);
                        }
                    }
                }
            }

            // STORAGE HYGIENE (epoch boundary) on EVERY node's apply path — the body-prune's twin
            // to the producer path in node.rs:17800. apply_stage is the single universal per-block
            // apply path for received blocks (gossip broadcast AND batch sync both funnel through
            // block_tx → pipeline), so this prunes on EVERY Super node that APPLIES a 14400-boundary
            // block. It intentionally does NOT use should_materialize_snapshot's ~1-in-5 holder gate,
            // so its per-node coverage is strictly BROADER than the co-located snapshot materialization
            // (each node must bound its OWN storage regardless of snapshot-holder duty). The prior
            // producer-only trigger left every non-boundary-producer growing unbounded (observed live:
            // one genesis at full ~2.8GB history vs a pruned one at ~1.1GB). prune_old_microblock_bodies
            // self-gates to Super and is watermark-based/idempotent (catch-up: drops everything below
            // height − 6 epochs), so any single applied boundary reclaims the whole window. Body-only
            // prune keeps hashes + macroblocks + snapshots + state → non-consensus, cannot affect
            // state_root or cold-join. (14400 is a multiple of the 3600 snapshot interval, so every
            // prune boundary is also a snapshot boundary — compatible cadences.)
            //
            // NOTE: recompress_old_blocks() is deliberately NOT run here. It is O(chain) — it re-scans
            // and re-decompresses the WHOLE history plus an unconditional full-CF compaction every
            // call, with near-zero steady-state benefit (blocks already at their age-bucket level are
            // not rewritten). Multiplying that across every node every epoch would burn CPU and contend
            // the apply write path at the boundary, so recompression stays producer-only (node.rs).
            if height % 14_400 == 0 && height > 0 {
                let storage_for_body_prune = ctx.storage.clone();
                let prune_h = height;
                tokio::spawn(async move {
                    match storage_for_body_prune.prune_old_microblock_bodies(prune_h, crate::node::MICROBLOCK_BODY_RETENTION_BLOCKS) {
                        Ok(0) => {}
                        Ok(n) => println!("[INFO][PIPELINE] microblock_bodies_pruned count={} window=6epochs h={}", n, prune_h),
                        Err(e) => { if is_warn() { println!("[WARN][PIPELINE] body_prune_failed err={:?}", e); } }
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
            // production, and form the basis of the per-block 2f+1 fork-choice
            // keep-local rule. It supplies that 2f+1 safety AND deterministic
            // empty-slot failover, without sharing
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

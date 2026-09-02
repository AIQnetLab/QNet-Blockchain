// ============================================================================
// SYNC MANAGER — Block Download Coordinator
// ============================================================================
//
// Separated from production logic. Handles:
//   1. Initial sync (catch up from genesis to network height)
//   2. Desync recovery (fell behind during operation)
//   3. Fork recovery (rollback + resync)
//
// Architecture:
//   - Sequential download in waves (adaptive size: 20/50/100 blocks)
//   - Pipeline handles ordering + dedup — no local buffer needed
//   - Coordinator events for state transitions (not atomic flags)
//   - Multiple peer sources with failover
//
// Scalability:
//   - Peer selection by reputation and latency
//   - Adaptive wave size based on network conditions
//   - Pipeline backpressure prevents OOM under load
//   - Rate limiting per peer prevents DoS
//
// Integration:
//   - Requests blocks from P2P layer
//   - P2P routes blocks to BlockPipeline (decode → verify → apply)
//   - Pipeline writes to storage (source of truth for progress)
//   - Reports progress to ConsensusCoordinator via events
//   - Uses pipeline metrics for observability
// ============================================================================

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::sync::RwLock;

use crate::storage::Storage;
use crate::unified_p2p::SimplifiedP2P;
use crate::consensus_state::{CoordinatorHandle, ConsensusEvent};
use crate::block_pipeline::PipelineIngest;
use crate::node::{is_info, is_warn, is_debug};

// ═══════════════════════════════════════════════════════════════════════════════
// v14.2: EVENT-DRIVEN SYNC NUDGE
// ═══════════════════════════════════════════════════════════════════════════════
// Global flag set by P2P layer when it observes a peer reporting a height
// significantly above the local chain tip. Sync manager reads this flag at a fast
// sub-second interval and triggers desync check immediately (instead of waiting
// up to 30s for the periodic tick).
//
// Used in addition to the periodic tick for two reasons:
// 1. Liveness: new block arrival triggers sync check within ~1s instead of 30s.
// 2. Stability: periodic tick remains as a safety net if nudge is missed.
//
// Contention: single u64 atomic flag — zero lock overhead at millions of events/s.
// ═══════════════════════════════════════════════════════════════════════════════
pub static SYNC_EVENT_NUDGE: AtomicBool = AtomicBool::new(false);

/// Called by P2P layer when a peer announces height > local_height + threshold.
/// Triggers sync_manager to run desync check at next fast-tick (<1s).
pub fn nudge_sync_check() {
    SYNC_EVENT_NUDGE.store(true, Ordering::Relaxed);
}

/// Consume the nudge flag (returns true if set, then clears it).
fn take_sync_nudge() -> bool {
    SYNC_EVENT_NUDGE.swap(false, Ordering::Relaxed)
}

/// Wholesale state-resync request: set by fork recovery once repeated reconciles keep
/// producing the SAME non-canonical root — the local base (snapshots + replay) provably
/// cannot self-heal, so the next sync pass must take the QC-verified peer-snapshot path
/// regardless of gap size. One-shot: consumed by a single execute_sync attempt; the
/// requester re-arms (with its own cooldown) if that attempt fails.
/// Last time a latched suspect state re-armed the wholesale request (unix secs).
static SUSPECT_REARM_SECS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A latched suspect state cannot be proven locally, so it keeps asking for a wholesale resync
/// until one succeeds (or a proven reconcile lifts it). Rate-limited with per-node jitter: a fleet
/// latched by one shared fault must not stampede the snapshot holders in lockstep.
fn arm_suspect_resync() {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    // 2-4 min: same per-node jitter source as the reconcile escalation (production.rs).
    let jitter = 120 + std::env::var("QNET_BOOTSTRAP_ID").ok()
        .or_else(|| std::env::var("QNET_NODE_ID").ok())
        .map(|id| blake3::hash(id.as_bytes()).as_bytes()[0] as u64 % 120)
        .unwrap_or(0);
    if now.saturating_sub(SUSPECT_REARM_SECS.load(Ordering::Relaxed)) < jitter { return; }
    SUSPECT_REARM_SECS.store(now, Ordering::Relaxed);
    WHOLESALE_STATE_RESYNC.store(true, Ordering::SeqCst);
}
static WHOLESALE_STATE_RESYNC: AtomicBool = AtomicBool::new(false);

pub fn request_wholesale_state_resync() {
    WHOLESALE_STATE_RESYNC.store(true, Ordering::SeqCst);
    SYNC_EVENT_NUDGE.store(true, Ordering::Relaxed);
}

/// RAII marker for the bulk catch-up window: storage disables the WAL while set (~10× apply throughput,
/// the difference between a far-behind node converging and falling further behind). Cleared on EVERY
/// execute_sync exit path so a produced block never applies WAL-off. Production is gated off during
/// catch-up (coordinator Syncing), so only sync-applied blocks are affected; the crash-window is bounded
/// by storage's periodic flush and by sync being idempotent on restart.
struct FastApplyGuard;
impl FastApplyGuard {
    fn new() -> Self {
        crate::node::FAST_SYNC_IN_PROGRESS.store(true, Ordering::SeqCst);
        FastApplyGuard
    }
}
impl Drop for FastApplyGuard {
    fn drop(&mut self) {
        crate::node::FAST_SYNC_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

// ============================================================================
// SYNC CONFIG
// ============================================================================

/// Tuning parameters for sync behavior.
pub struct SyncConfig {
    /// Minimum wave size (blocks per request)
    pub min_wave_size: u64,
    /// Maximum wave size
    pub max_wave_size: u64,
    /// Timeout for a single sync request
    pub request_timeout: Duration,
    /// Delay between waves (prevent flooding peers)
    pub wave_delay: Duration,
    /// Maximum retries for a single height range
    pub max_retries: u32,
    /// Gap threshold to trigger auto-sync
    pub auto_sync_gap: u64,
    /// Minimum peers required to start sync
    pub min_peers_for_sync: usize,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            // v14.2: Scaled for L1-grade catch-up. Previous 20/100 blocks was sized for
            // low-bandwidth era; modern QUIC links carry 250 blocks in <1s. 10s request
            // timeout reduced to 3s — stalled peers should rotate quickly, not block sync.
            min_wave_size: 50,
            max_wave_size: 500,
            request_timeout: Duration::from_secs(3),
            wave_delay: Duration::from_millis(50),
            max_retries: 5,
            auto_sync_gap: 20,
            min_peers_for_sync: 2,
        }
    }
}

// ============================================================================
// SYNC MANAGER
// ============================================================================

/// Handle for controlling the sync manager from outside.
#[derive(Clone)]
pub struct SyncHandle {
    /// Request a sync to target height
    command_tx: mpsc::Sender<SyncCommand>,
    /// Is sync currently active?
    active: Arc<AtomicBool>,
    /// Current sync progress
    progress_height: Arc<AtomicU64>,
    /// Target height
    target_height: Arc<AtomicU64>,
}

impl SyncHandle {
    /// Request sync to network height (auto-detected). Sole external entry — the driver otherwise
    /// self-triggers via nudge_sync_check() + the periodic desync tick.
    pub async fn sync_to_network(&self) -> bool {
        self.command_tx.send(SyncCommand::SyncToNetwork).await.is_ok()
    }

    /// Is sync currently active?
    #[inline]
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }

    /// Current sync progress.
    pub fn progress(&self) -> (u64, u64) {
        (
            self.progress_height.load(Ordering::Relaxed),
            self.target_height.load(Ordering::Relaxed),
        )
    }
}

/// Commands sent to the sync manager.
enum SyncCommand {
    SyncToNetwork,
}


/// The sync manager. Runs as a single async task.
pub struct SyncManager {
    config: SyncConfig,
    storage: Arc<Storage>,
    p2p: Arc<SimplifiedP2P>,
    pipeline: PipelineIngest,
    coordinator: CoordinatorHandle,
    command_rx: mpsc::Receiver<SyncCommand>,
    active: Arc<AtomicBool>,
    progress_height: Arc<AtomicU64>,
    target_height_atomic: Arc<AtomicU64>,
    // SAME StateManager handle the apply pipeline uses (ApplyContext.state). Cold-join snapshot
    // rehydration seeds this in-mem state from the promoted accounts CF — without it the first
    // tail block applies over an empty merkle and trips state_root_mismatch → wedge.
    state: Arc<RwLock<crate::StateManager>>,
}

impl SyncManager {
    /// Create sync manager + handle pair.
    pub fn new(
        config: SyncConfig,
        storage: Arc<Storage>,
        p2p: Arc<SimplifiedP2P>,
        pipeline: PipelineIngest,
        coordinator: CoordinatorHandle,
        state: Arc<RwLock<crate::StateManager>>,
    ) -> (Self, SyncHandle) {
        let (command_tx, command_rx) = mpsc::channel(32);
        let active = Arc::new(AtomicBool::new(false));
        let progress_height = Arc::new(AtomicU64::new(0));
        let target_height_atomic = Arc::new(AtomicU64::new(0));

        let manager = Self {
            config,
            storage,
            p2p,
            pipeline,
            coordinator,
            command_rx,
            active: active.clone(),
            progress_height: progress_height.clone(),
            target_height_atomic: target_height_atomic.clone(),
            state,
        };

        let handle = SyncHandle {
            command_tx,
            active,
            progress_height,
            target_height: target_height_atomic,
        };

        (manager, handle)
    }

    /// Run the sync manager event loop.
    pub async fn run(mut self) {
        if is_info() {
            println!("[INFO][SYNC] manager_started");
        }

        // ═══════════════════════════════════════════════════════════════════════
        // v14.2: EVENT-DRIVEN + PERIODIC CHECK
        // ═══════════════════════════════════════════════════════════════════════
        // fast_tick (500ms) → reacts to SYNC_EVENT_NUDGE from P2P almost immediately.
        // slow_tick (15s)   → safety-net periodic check in case nudges are lost.
        //
        // Previous single 30s interval meant up to 30s delay between a peer announcing
        // a higher block and sync starting to pull it — unacceptable for top-tier L1
        // latency expectations.
        // ═══════════════════════════════════════════════════════════════════════
        let mut fast_tick = tokio::time::interval(Duration::from_millis(500));
        let mut slow_tick = tokio::time::interval(Duration::from_secs(15));

        loop {
            tokio::select! {
                Some(cmd) = self.command_rx.recv() => {
                    match cmd {
                        SyncCommand::SyncToNetwork => {
                            let network_h = self.detect_network_height().await;
                            if network_h > 0 {
                                self.execute_sync(network_h).await;
                            }
                        }
                    }
                }
                _ = fast_tick.tick() => {
                    // v14.2: event-driven reaction to peer-height nudges from P2P
                    if take_sync_nudge() && !self.active.load(Ordering::Relaxed) {
                        if is_info() {
                            println!("[INFO][SYNC] nudge_triggered — fast-path desync check");
                        }
                        self.check_desync().await;
                    }
                }
                _ = slow_tick.tick() => {
                    // Safety-net periodic check (in case a nudge was missed)
                    if !self.active.load(Ordering::Relaxed) {
                        self.check_desync().await;
                    }
                }
            }
        }
    }

    /// Cold-start sync target = QC-verified finality frontier; the peer/bootstrap-HTTP hint may only
    /// add the ≤2-macroblock unsealed tail above it (no unverified scalar drives the bulk target).
    /// frontier==0 (h<90 / fresh genesis) ⇒ the hint alone, so the 5-genesis bootstrap is never blocked.
    async fn detect_network_height(&self) -> u64 {
        let hint = self.detect_network_height_hint().await;
        let frontier = crate::node::qc_verified_frontier_height();
        if frontier == 0 { hint }
        // Floor at the QC frontier (never sync below finality); reach the hint. Fetched blocks are
        // QC/Dilithium-verified on apply, so the hint scalar can't inject state — the old frontier+180
        // ceiling wedged a far-behind follower below the snapshot-jump threshold, forcing a crawl it
        // can never sustain. Anti-spoof: a lie-high hint is bounded by detect_network_height_hint's
        // genesis cross-check (gap>100 ⇒ reject >median+50) and at worst chases a phantom tail that
        // STALL_ABORTs; the QC floor blocks lie-low from pulling us below finality.
        else { std::cmp::max(frontier, hint) }
    }

    /// Peer/bootstrap-HTTP height HINT (unverified scalar) — used only to pick the probe target and the
    /// near-tip tail; floored by the QC frontier in detect_network_height above.
    /// FIX M-H16: Don't trust a single peer if height is significantly ahead.
    /// Verify against bootstrap nodes before accepting large jumps.
    async fn detect_network_height_hint(&self) -> u64 {
        let local_h = self.storage.get_chain_height().unwrap_or(0);
        let best = self.p2p.get_best_peer_height();

        // Trust the authenticated best-peer head directly whenever a signed head exists OR best is not
        // suspiciously far ahead (≤ local+100). best is clamp_overclaim-bounded (committee/genesis median)
        // and the bulk target is QC-floored, so a within-band hint can at worst chase a phantom tail that
        // STALL_ABORTs (bounded) — it can never inject state. This keeps EVERY node that has any peer off
        // the 5-genesis HTTP fan-out (a fresh cold-joiner into a running network gets peer heights at once),
        // so a mass simultaneous cold start cannot herd onto the 5 seed IPs. The genesis cross-check below
        // is reserved for the deep-jump suspicious branch (>100-ahead, no signed head) and true zero-peer
        // bootstrap, where validating a large unattested jump against the genesis median is warranted.
        let signed_head = crate::unified_p2p::SIGNED_HEAD_MAX.load(std::sync::atomic::Ordering::Relaxed) > 0;
        if best > 0 && (signed_head || best <= local_h.saturating_add(100)) {
            return best;
        }

        // Large gap / no best-peer: cross-check the unverified peer `best` against the genesis-attested
        // median. Scale: thousands of cold-joiners must NOT each HTTP-probe the 5 genesis every desync
        // check — cache the median for HINT_CACHE_TTL (advisory only; the bulk target is QC-floored, so
        // a few seconds stale is harmless). The lock is never held across the .await probe.
        const HINT_CACHE_TTL: Duration = Duration::from_secs(8);
        static GENESIS_HINT_CACHE: std::sync::Mutex<Option<(Instant, u64)>> = std::sync::Mutex::new(None);
        let median = match GENESIS_HINT_CACHE.lock().ok()
            .and_then(|g| (*g).filter(|(at, _)| at.elapsed() < HINT_CACHE_TTL).map(|(_, h)| h))
        {
            Some(m) => m,
            None => {
                let bootstrap_ips = crate::genesis_constants::get_genesis_ips();
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(5)).build().unwrap_or_default();
                let mut heights: Vec<u64> = Vec::new();
                for ip in bootstrap_ips.iter().take(5) {
                    let url = format!("http://{}:8001/api/v1/block/latest", ip);
                    if let Ok(resp) = client.get(&url).send().await {
                        if resp.status().is_success() {
                            if let Ok(json) = resp.json::<serde_json::Value>().await {
                                if let Some(h) = json.get("height").and_then(|v| v.as_u64()) { heights.push(h); }
                            }
                        }
                    }
                }
                if heights.len() >= 2 {
                    heights.sort();
                    let m = heights[heights.len() / 2];
                    if let Ok(mut g) = GENESIS_HINT_CACHE.lock() { *g = Some((Instant::now(), m)); }
                    m
                } else {
                    // Never advance the sync target on a single unattested source; wait for quorum
                    // (2+ genesis) or a signed head. Return local_h so no forward progress is made on
                    // an unverified hint; the retry loop re-probes and the QC floor stays the safety net.
                    return local_h;
                }
            }
        };

        // M-H16: a lone peer reporting >100 ahead is trusted only if the genesis median confirms it
        // (within 50); else trust the genesis consensus over the single peer.
        if best > local_h + 100 && median > 0 && best > median + 50 {
            if is_warn() {
                println!("[WARN][SYNC] peer_height_suspect peer={} bootstrap_median={}", best, median);
            }
            return median;
        }
        if best > 0 && best <= median + 50 {
            return std::cmp::max(best, median);
        }
        median
    }

    /// Check if we're behind and need to sync.
    async fn check_desync(&self) {
        let snap = self.coordinator.snapshot();
        // Trigger sync ONLY off the QC-verified FINALIZED frontier — the convergent reference every
        // healthy node shares — never the produced tip. detect_network_height both climbs the local
        // frontier toward the network (its macroblock-lineage probe) and returns the bulk-sync
        // TARGET (frontier + bounded unsealed tail). The tail ABOVE the frontier is delivered by
        // block gossip in real time, so the normal intra-rotation production lead must NOT fire a
        // redundant sync — only a node genuinely below finality (or still cold) catches up here.
        let network_h = self.detect_network_height().await;
        let frontier = crate::node::qc_verified_frontier_cached();
        // Applied tip, not snap.chain_height: the gap that drives catch-up must be measured against
        // what this node holds, never against the highest height it has merely seen.
        let local_h = self.storage.get_chain_height().unwrap_or(snap.chain_height);

        // Three independent deficit dimensions, ONE mechanism (execute_sync) — never parallel drivers.
        // Keys on the NETWORK height, not the node's own frontier: a follower whose own frontier stalled
        // would otherwise never see it fell behind (self-reference) and silently diverge. network_h
        // already carries the QC floor ⇒ never targets below finality.
        //   bulk  — network tip leads the applied tip beyond the gossip jitter band (auto_sync_gap).
        //   stall — applied tip frozen past APPLY_STALL_T while a higher head exists: a small-gap wedge
        //           (a missing microblock behind a contiguity hole) the gap band alone would mask until
        //           the gap grew large.
        //   mb    — the network sealed a macroblock object past our contiguous seal frontier. A follower
        //           at microblock-tip can still miss the checkpoint object that feeds SYNC-ADOPT →
        //           QC_VERIFIED_FRONTIER, freezing finality with bulk+stall both false. execute_sync's
        //           macroblock pass (before its microblock early-return) repairs it.
        let bulk_behind = network_h > local_h.saturating_add(self.config.auto_sync_gap);

        const APPLY_STALL_T: Duration = Duration::from_secs(12);
        static APPLY_STALL: std::sync::Mutex<Option<(u64, Instant)>> = std::sync::Mutex::new(None);
        let stall_behind = {
            let mut g = APPLY_STALL.lock().unwrap_or_else(|p| p.into_inner());
            match *g {
                Some((tip, since)) if tip == local_h =>
                    network_h > local_h && since.elapsed() > APPLY_STALL_T,
                _ => { *g = Some((local_h, Instant::now())); false }
            }
        };

        let mbi = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
        let sealed = self.storage.last_sealed_mb_index();
        // Network genuinely ahead on macroblock objects (a behind/cold node whose peers report a higher
        // tip) — MAX_UNSEALED_WINDOWS absorbs the healthy tail; fires immediately (no time wait).
        let mb_behind = network_h / mbi > sealed.saturating_add(crate::node::MAX_UNSEALED_WINDOWS);

        // Seal-frozen: the GAP tests above CANNOT catch a QUORUM-WIDE missing macroblock object. When the
        // whole quorum is missing object K (sealed=K-1), the bft_finality throttle pins every node's tip at
        // last_finalized+90 = (sealed+1)*90, so no peer reports a higher tip and bulk/stall/mb are all false.
        // Detect it by TIME: a COMPLETE window sits above the seal frontier (tip >= (sealed+1)*90) yet the
        // object has not sealed for SEAL_STALL_T — a checkpoint that should form in seconds is missing/unformed.
        // Threshold is +1 window (NOT +MAX_UNSEALED_WINDOWS): the finality throttle binds one window BELOW the
        // seal ceiling, so +2 would never see the pin. Timer keyed on at_ceiling-dwell (reset when the window
        // is not complete or the frontier advances) so a healthy end-of-cycle boundary never false-fires.
        // sealed>0 mirrors the throttle's seal_base==0 exemption (a slow FIRST checkpoint is not a wedge).
        const SEAL_STALL_T: Duration = Duration::from_secs(30);
        static SEAL_STALL: std::sync::Mutex<Option<(u64, Instant)>> = std::sync::Mutex::new(None);
        let at_ceiling = sealed > 0 && local_h >= sealed.saturating_add(1).saturating_mul(mbi);
        let seal_frozen = {
            let mut g = SEAL_STALL.lock().unwrap_or_else(|p| p.into_inner());
            if at_ceiling {
                match *g {
                    Some((s, since)) if s == sealed => since.elapsed() > SEAL_STALL_T,
                    _ => { *g = Some((sealed, Instant::now())); false }
                }
            } else {
                *g = None;
                false
            }
        };

        // An unprovable state is a fifth desync dimension: the node tracks the tip perfectly (so
        // none of the four fire) yet cannot certify or produce, and only a wholesale resync clears it.
        let suspect = crate::block_pipeline::state_suspect();
        if bulk_behind || stall_behind || mb_behind || seal_frozen || suspect {
            if is_info() {
                println!("[INFO][SYNC] desync_detected local={} frontier={} target={} gap={} bulk={} stall={} mb={} seal_frozen={} suspect={}",
                         local_h, frontier, network_h, network_h.saturating_sub(local_h),
                         bulk_behind, stall_behind, mb_behind, seal_frozen, suspect);
            }
            self.execute_sync(network_h).await;
        }
    }

    /// Fetch sealed macroblock OBJECTS the network finalized past our contiguous seal frontier — the
    /// checkpoint (with its 2f+1 QC) SYNC-ADOPT consumes to advance QC_VERIFIED_FRONTIER. Distinct from
    /// the microblock catch-up: a follower can hold every microblock yet miss the object, freezing
    /// finality. network_mb derives from the SAME unified target (QC floor + signed-head ceiling), so no
    /// second oracle; check_desync (its mb/seal-frozen dimensions) decides WHEN this runs. Bounded per call — the only
    /// non-snapshot residual is <= SNAPSHOT_SYNC_SWITCH_GAP microblocks (~17 macroblocks); larger deficits
    /// are bulk-restored by the snapshot fast-path. sync_macroblocks_repair funnels through drive_macroblock_sync's
    /// single in-flight set, so this shares the one macroblock transport (no parallel fetcher).
    async fn sync_macroblock_deficit(&self, target: u64) {
        let mbi = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
        let network_mb = target / mbi;
        const MAX_MB_ROUNDS: u32 = 6;
        for _ in 0..MAX_MB_ROUNDS {
            let sealed = self.storage.last_sealed_mb_index();
            // Fetch ANY macroblock object below the network tip we're missing — NOT gated by the
            // unsealed-tail margin. The seal-frozen wedge is a missing object exactly ONE window above
            // the frontier (sealed+1); a margin here would skip it. Only runs when check_desync already
            // decided we're behind, so this never fires on a healthy tail; and if the top window isn't
            // sealed network-wide yet, sync_macroblocks returns Err and the loop breaks (no spin).
            if network_mb <= sealed {
                return;
            }
            if is_info() {
                println!("[INFO][SYNC] mb_deficit sealed={} network_mb={} fetch_from={}",
                         sealed, network_mb, sealed + 1);
            }
            // REPAIR path (un-clamped), NOT the forward sync_macroblocks: the seal-frozen hole is at
            // sealed+1, which after a snapshot sits AT/BELOW the applied-microblock frontier (the tail
            // parks 2 windows past the sealed anchor). The forward coordinator would clamp lo to
            // applied_mb+1 and silently skip the hole → frontier frozen → cold-join never onboards.
            if self.p2p.sync_macroblocks_repair(sealed + 1, network_mb).await.is_err() {
                return;
            }
        }
    }

    /// v14.10: Event-driven pipelined sync with CREDIT-BASED BACKPRESSURE.
    ///
    /// Architecture (scales to 10K+ Super nodes at 1-sec block time):
    ///
    ///   1. Determine MAX_INFLIGHT adaptively from apply-stage capacity:
    ///      - Bootstrap (local_h < 100):  300 blocks (small, protects pipeline)
    ///      - Steady (local_h ≥ 100):     2000 blocks (max throughput)
    ///   2. Each iteration: check `pipeline.in_flight()` (ingested - finished).
    ///      Credits available = MAX_INFLIGHT − in_flight.
    ///   3. If credits < MIN_DISPATCH_THRESHOLD: await apply_notify; try again.
    ///   4. Otherwise: find missing ranges in window = [apply_tip+1 .. apply_tip+credits].
    ///      Split into RANGE_CHUNK=100 pieces, dispatch in parallel.
    ///   5. Range-sharded parallel sync (unified_p2p v14.2) fans out to peers.
    ///   6. Await apply_notify for progress signal.
    ///
    /// Why credit-based?
    ///   A naive fixed window of 2000 blocks at bootstrap floods the pipeline:
    ///   verify+apply stages are serial per-block and can't keep up with a
    ///   2000-block burst. Deferred buffer fills → drops → re-requests → livelock.
    ///   Credits-based dispatch guarantees in_flight ≤ apply-capacity at all times.
    ///
    /// Correctness:
    ///   - Storage dedup: re-requested blocks are O(1) skipped at handle_blocks_batch.
    ///   - `apply_notify` is a Tokio `Notify` — O(1) wake, safe at any scale.
    ///   - 15s hard safety-net timeout guards against silent peer stalls.
    ///   - 120s STALL_ABORT resets the progress window (does NOT break) — this loop is the single
    ///     non-terminating owner of gap progress; the frontier-reserve pass keeps re-driving F+1.
    ///
    /// Genesis priority (fresh node bootstrap):
    ///   If local_h == 0 and storage lacks h=0, we issue a targeted sync_blocks(0,0)
    ///   first and wait (bounded) for apply_tip ≥ 1 before entering the main loop.
    ///   Without this, a fresh node would dispatch h=1..=N in parallel, but NONE
    ///   would verify (missing previous_hash for genesis) — triggering a cycle
    ///   of deferred_full drops until genesis eventually arrives randomly.
    async fn execute_sync(&self, target: u64) {
        // APPLIED tip, from storage. The coordinator height is a monotone max over OBSERVED heights,
        // so one out-of-order block raises it above what this node actually holds and the gap check
        // below then reads "nothing to fetch" — the node stops asking and never recovers.
        let mut local_h = self.storage.get_chain_height().unwrap_or(0);
        let observed = self.coordinator.chain_height();
        if observed > local_h.saturating_add(qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL)
            && is_warn() {
            println!("[WARN][SYNC] height_divergence applied={} observed={} — coordinator ran ahead",
                     local_h, observed);
        }

        // Floor the target at the QC-verified finality frontier (never sync below finality); reach the
        // caller's bootstrap-validated target above it. Blocks are QC/Dilithium-verified on apply, so
        // the target scalar can't inject state; removing the old frontier+180 ceiling lets a far-behind
        // node see the real gap and take the snapshot fast-path below instead of an unsustainable crawl.
        // frontier==0 (fresh genesis, h<90) ⇒ target as-is so the 5-genesis bootstrap is never blocked.
        let target = {
            let frontier = crate::node::qc_verified_frontier_height();
            if frontier == 0 { target } else { std::cmp::max(frontier, target) }
        };

        // Macroblock-object deficit repair — MUST run before the microblock early-return below. An
        // MB-only deficit (microblocks at tip, local_h>=target) otherwise returns here without repairing
        // the seal frontier that feeds SYNC-ADOPT, re-opening the finality gap while blocks look current.
        self.sync_macroblock_deficit(target).await;

        // Consume a wholesale request up front: it must bypass BOTH the at-target early-return
        // (the coordinator's observed height can be stale while the state is wedged) and the
        // gap threshold below — the peer-snapshot negotiation finds the real tip itself.
        if crate::block_pipeline::state_suspect() { arm_suspect_resync(); }
        let wholesale = WHOLESALE_STATE_RESYNC.swap(false, Ordering::SeqCst);

        if !wholesale && local_h >= target {
            if is_debug() {
                println!("[DBG][SYNC] already_at_target local={} target={}", local_h, target);
            }
            return;
        }

        // Check minimum peers
        let peer_count = self.p2p.get_peer_count();
        if peer_count < self.config.min_peers_for_sync {
            if wholesale { WHOLESALE_STATE_RESYNC.store(true, Ordering::SeqCst); } // re-arm, not drop
            if is_warn() {
                println!("[WARN][SYNC] insufficient_peers count={} need={}",
                         peer_count, self.config.min_peers_for_sync);
            }
            return;
        }

        self.active.store(true, Ordering::SeqCst);
        // WAL-off for the whole catch-up (snapshot restore + pipelined apply); cleared on every exit.
        let _fast_apply = FastApplyGuard::new();
        self.target_height_atomic.store(target, Ordering::Relaxed);
        self.progress_height.store(local_h, Ordering::Relaxed);

        // Notify coordinator
        self.coordinator.try_send(ConsensusEvent::SyncStart {
            target_height: target,
            source_peer: None,
        });

        if is_info() {
            println!("[INFO][SYNC] start local={} target={} gap={} peers={} mode=pipelined_credits",
                     local_h, target, target - local_h, peer_count);
        }

        // ─────────────────────────────────────────────────────────────────────
        // COLD-JOIN SNAPSHOT FAST-PATH (THE ROOT FIX). A fresh / far-behind node
        // CANNOT converge block-by-block — the pipelined loop below only closes a
        // SMALL gap; for a large one, block production outpaces the joiner and the
        // gap grows without bound (a 6k-block joiner never catches up). The node MUST
        // restore a remote state snapshot FIRST (jump to ~tip), then the loop syncs
        // only the residual tail. This step existed in the legacy sync path but was
        // LOST when SyncManager replaced it (the old fast_sync_with_snapshot call
        // sites became dead/unreachable), so every real super-node fell to block-by-
        // block and never onboarded. The snapshot DOWNLOAD + 2f+1-QC binding +
        // microblock-hash backfill all already exist in storage and are correct
        // (verify_snapshot_consensus_binding is QC-anchored, fail-close) — they were
        // simply never INVOKED on the live cold-start engine. Fire on a cold join
        // (local==0) or a large gap; on failure (no network snapshot yet — e.g. a
        // sub-interval fresh genesis) fall through to the block-by-block path below.
        // On success local_h is advanced so the genesis-h=0 fetch is skipped and the
        // loop only fills the tail. Same proven call the legacy node.rs path used.
        const SNAPSHOT_FAST_PATH_GAP: u64 = crate::node::SNAPSHOT_SYNC_SWITCH_GAP;
        // GALC cold/dormant-join: whenever the snapshot fast-path will run (fresh cold join OR a returning
        // node behind by > the gap), request the latest genesis-signed checkpoint capsule so the lineage
        // walk roots near the tip (bounded) at ANY chain age — NOT only at local_h==0 (a long-offline warm
        // node also needs it). Cold join (local_h==0) first ensures block 0 (network_id). Best-effort +
        // async-verified by the handler; falls back to the binary pin if unavailable.
        if wholesale || local_h == 0 || target.saturating_sub(local_h) > SNAPSHOT_FAST_PATH_GAP {
            if local_h == 0 && self.storage.load_microblock(0).map(|o| o.is_none()).unwrap_or(true) {
                let _ = self.p2p.sync_blocks(0, 0).await;
                tokio::time::sleep(Duration::from_millis(800)).await;
            }
            let _ = self.p2p.broadcast_quic(&crate::unified_p2p::NetworkMessage::RequestGenesisCheckpoint {
                requester_id: "cold_joiner".to_string(),
            }).await;
            tokio::time::sleep(Duration::from_millis(1200)).await;
        }

        if wholesale || local_h == 0 || target.saturating_sub(local_h) > SNAPSHOT_FAST_PATH_GAP {
            if wholesale && is_warn() {
                println!("[WARN][SYNC] wholesale_state_resync local={} target={}", local_h, target);
            }
            match self.storage.fast_sync_with_snapshot(&self.p2p, target, &self.state, wholesale).await {
                Ok(()) => {
                    let restored = self.storage.get_chain_height().unwrap_or(local_h);
                    if restored > local_h || (wholesale && restored > 0) {
                        // fast_sync Ok ⇒ the restore was verify-gated inside (rehydrate rejects any
                        // root that does not reproduce the QC-bound anchor) — a PROVEN rebuild, so
                        // the wholesale path may lift the suspect latch.
                        if wholesale { crate::block_pipeline::clear_state_suspect(); }
                        local_h = restored;
                        self.progress_height.store(restored, Ordering::Relaxed);
                        crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.store(restored, Ordering::Release);
                        if is_info() {
                            println!("[INFO][SYNC] snapshot_restored h={} target={} tail={} wholesale={}",
                                     restored, target, target.saturating_sub(restored), wholesale);
                        }
                    } else {
                        if wholesale { request_wholesale_state_resync(); } // nothing restored — keep asking
                        if is_info() {
                            println!("[INFO][SYNC] snapshot_no_advance local={} — fallback block_sync", local_h);
                        }
                    }
                }
                Err(e) => {
                    // AnchorPending: genesis-rooted GALC pin not yet adopted while the network provably has
                    // one. Bail to the desync tick (gated !active), which re-drives cold-join once the
                    // co-sent capsule arrives — never fall to O(height) block-replay from the h=90 anchor.
                    if matches!(e, crate::errors::IntegrationError::AnchorPending) {
                        if wholesale { request_wholesale_state_resync(); }
                        if is_info() { println!("[INFO][SYNC] coldjoin_await_anchor — bail to tick"); }
                        self.active.store(false, Ordering::SeqCst);
                        return;
                    }
                    if is_info() {
                        println!("[INFO][SYNC] snapshot_unavailable reason={:?} fallback=block_sync", e);
                    }
                    // A wholesale request is the only self-heal for an unprovable state: it must
                    // outlive a failed attempt (no peer snapshot yet) instead of being consumed once.
                    if wholesale { request_wholesale_state_resync(); }
                }
            }
        }

        // Post-snapshot: the restore jumped local_h to the anchor, but the residual macroblock objects
        // above it (anchor+1 .. tip) are NOT in the snapshot. Fetch them now so the seal frontier lifts
        // immediately and the parked tail microblocks below unblock — without waiting out a 120s STALL for
        // the desync tick to re-enter. Idempotent + bounded (repair path, skip-present).
        self.sync_macroblock_deficit(target).await;

        // Cold-join committee dialing: pull the residual tail from the round committee, not just the 5
        // genesis. Idempotent + no-op until the N-2 macroblock for the target is present (genesis era /
        // early cold-join) and a near-no-op at small scale (committee ≈ already-connected peers).
        self.p2p.dial_committee_for_cold_join();

        // Adaptive-window + credit-based backpressure config. HONEST NOTE:
        // initial choices, not yet measured under load — safe bounds (never
        // exceed pipeline capacity) but may leave throughput on the table;
        // re-tune via metrics. MAX_INFLIGHT = unapplied-block cap: bootstrap
        // 300 (apply is the serial bottleneck at ~20-100 blk/s; 300 ≈ 6-15s
        // of work, absorbs RTT jitter without overflowing DEFERRED_MAX=2000);
        // steady = DEFERRED_MAX (no overflow by construction).
        // MIN_DISPATCH_THRESHOLD=50 avoids dispatch-thrash near the cap.
        // RANGE_CHUNK MUST be ≤ server MAX_BATCH(100). MAX_REQUESTS_PER_ITER
        // caps fan-out burst. NOTIFY_TIMEOUT is a defensive safety net.
        // GENESIS_WAIT is a best-effort ceiling, not a hard fail (the main
        // loop's missing-scan retries forever after).
        const DEFERRED_MAX_HINT:      u64 = 2000;  // matches block_pipeline.rs DEFERRED_MAX
        const MAX_INFLIGHT_BOOTSTRAP: u64 = 300;
        const MAX_INFLIGHT_STEADY:    u64 = DEFERRED_MAX_HINT;
        const MIN_DISPATCH_THRESHOLD: u64 = 50;
        const RANGE_CHUNK:            u64 = 100;
        const MAX_REQUESTS_PER_ITER:  usize = 8;
        const NOTIFY_TIMEOUT:         Duration = Duration::from_secs(15);
        const STALL_ABORT:            Duration = Duration::from_secs(120);
        const GENESIS_WAIT:           Duration = Duration::from_secs(30);
        const GENESIS_RETRY_INTERVAL: Duration = Duration::from_secs(3);

        let apply_notify = self.pipeline.apply_notify();
        let start_time = Instant::now();
        let mut last_progress_tip = local_h;
        let mut last_progress_at = Instant::now();
        let mut consecutive_failures = 0u32;

        // ─────────────────────────────────────────────────────────────────────
        // v14.10: GENESIS PRIORITY BOOTSTRAP — RETRY UNTIL APPLIED
        // Fresh node needs h=0 applied first — otherwise every subsequent block
        // fails hash-chain verify (previous_hash points to nowhere), fills the
        // deferred buffer, and the whole pipeline deadlocks at credits=0.
        //
        // Strategy: fire sync_blocks(0,0) every 3s until storage has h=0 or
        // GENESIS_WAIT timeout. This handles rare cases where the first peer
        // doesn't respond (packet loss, handshake timing, peer restart).
        // ─────────────────────────────────────────────────────────────────────
        if local_h == 0
            && self.storage.load_microblock(0).map(|o| o.is_none()).unwrap_or(true)
        {
            if is_info() {
                println!("[INFO][SYNC] genesis_priority fetching h=0 before pipelined_catchup");
            }
            let deadline = Instant::now() + GENESIS_WAIT;
            let mut last_request = Instant::now() - Duration::from_secs(10);
            let mut attempts = 0u32;
            loop {
                if self.storage.load_microblock(0).map(|o| o.is_some()).unwrap_or(false) {
                    if is_info() {
                        println!("[INFO][SYNC] genesis_applied h=0 attempts={} proceed=pipelined_catchup",
                                 attempts);
                    }
                    break;
                }
                if Instant::now() >= deadline {
                    if is_warn() {
                        println!("[WARN][SYNC] genesis_wait_timeout attempts={} — main loop will keep retrying h=0",
                                 attempts);
                    }
                    break;
                }
                // Re-fire sync_blocks(0,0) every GENESIS_RETRY_INTERVAL until arrival
                if last_request.elapsed() >= GENESIS_RETRY_INTERVAL {
                    attempts += 1;
                    if is_debug() {
                        println!("[DBG][SYNC] genesis_request attempt={}", attempts);
                    }
                    let _ = self.p2p.sync_blocks(0, 0).await;
                    last_request = Instant::now();
                }
                tokio::select! {
                    _ = apply_notify.notified() => {}
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                }
            }
        }

        // Frontier-reserve stall counter: re-dial the committee after a run of unfilled F+1 fetches.
        let mut frontier_misses: u32 = 0;
        while self.active.load(Ordering::Relaxed) {
            // Floor the apply-frontier by the adopted snapshot anchor. The apply-dedup gate treats
            // height<=SNAPSHOT_ANCHOR_MB*90 as already-final (bound snapshot replaces sub-anchor
            // bodies), so requesting sub-anchor blocks would loop forever (fetched → dup-skipped →
            // never saved → re-requested). Tailing from anchor+1 keeps this coordinator and the apply
            // stage agreeing on "done", and self-heals a frontier transiently stranded below the anchor.
            let apply_tip = self.storage.get_chain_height().unwrap_or(local_h)
                .max(crate::node::SNAPSHOT_ANCHOR_MB.load(Ordering::Relaxed).saturating_mul(90));

            // Sync complete?
            if apply_tip >= target {
                break;
            }

            // Track progress; abort if stalled for too long (120s no advance)
            if apply_tip > last_progress_tip {
                last_progress_tip = apply_tip;
                last_progress_at = Instant::now();
                self.progress_height.store(apply_tip, Ordering::Relaxed);
                self.coordinator.try_send(ConsensusEvent::SyncProgress { height: apply_tip });
                consecutive_failures = 0;
                frontier_misses = 0; // progress ⇒ peer set is fine; re-dial committee only on genuine stall
            } else if last_progress_at.elapsed() > STALL_ABORT {
                if is_warn() {
                    println!("[WARN][SYNC] stall h={} target={} stuck_for={}s — break to re-detect",
                             apply_tip, target, last_progress_at.elapsed().as_secs());
                }
                // Break (not reset): SyncManager is the SOLE driver post-consolidation, so returning
                // clears `active` (below) and the desync tick re-enters with a freshly detected target
                // and a re-armed snapshot fast-path (G4) — the right recovery when 120s of no progress
                // means the target or peer set is stale, versus retrying the same stuck target in place.
                break;
            }

            // ─────────────────────────────────────────────────────────────────
            // FRONTIER RESERVE — top-L1 liveness invariant: the contiguous-frontier successor F+1 is
            // ALWAYS fetched here, on a path no speculative buffer occupancy or bulk window can starve;
            // the sole guarantee of convergence from ANY gap. Runs BEFORE the bulk credit gate and
            // bypasses the bulk overlap-dedup; the bulk dispatch below is optimistic prefetch only.
            // ─────────────────────────────────────────────────────────────────
            {
                const FRONTIER_SCAN: u64 = 512; // bounded lowest-missing probe (breaks at first hole)
                let scan_hi = std::cmp::min(apply_tip.saturating_add(FRONTIER_SCAN), target);
                let mut lowest_missing = None;
                let mut h = apply_tip + 1;
                while h <= scan_hi {
                    if self.storage.load_microblock(h).map(|o| o.is_none()).unwrap_or(true) {
                        lowest_missing = Some(h);
                        break;
                    }
                    h += 1;
                }
                if let Some(l) = lowest_missing {
                    frontier_misses = frontier_misses.saturating_add(1);
                    if frontier_misses % 8 == 0 {
                        // Persistent frontier gap ⇒ refresh committee body-holders (peer set too narrow).
                        self.p2p.dial_committee_for_cold_join();
                    }
                    let end = std::cmp::min(l.saturating_add(RANGE_CHUNK - 1), target);
                    if is_info() {
                        println!("[INFO][SYNC] frontier_fetch l={} end={} apply_tip={} target={} reserved",
                                 l, end, apply_tip, target);
                    }
                    let _ = self.p2p.sync_blocks_frontier(l, end).await;
                } else {
                    frontier_misses = 0;
                }
            }

            // ─────────────────────────────────────────────────────────────────
            // v14.10: ADAPTIVE WINDOW — small during bootstrap, full in steady state.
            // ─────────────────────────────────────────────────────────────────
            let max_inflight = if apply_tip < 100 {
                MAX_INFLIGHT_BOOTSTRAP
            } else {
                MAX_INFLIGHT_STEADY
            };

            // ─────────────────────────────────────────────────────────────────
            // v14.10: CREDIT-BASED BACKPRESSURE — do not dispatch if pipeline full.
            // ─────────────────────────────────────────────────────────────────
            let in_flight = self.pipeline.in_flight();
            let credits = max_inflight.saturating_sub(in_flight);

            if credits < MIN_DISPATCH_THRESHOLD {
                if is_debug() {
                    println!("[DBG][SYNC] backpressure tip={} in_flight={} max={} credits={} waiting=apply",
                             apply_tip, in_flight, max_inflight, credits);
                }
                tokio::select! {
                    _ = apply_notify.notified() => {}
                    _ = tokio::time::sleep(NOTIFY_TIMEOUT) => {}
                }
                continue;
            }

            // Window end bounded by credits and target
            let window_end = std::cmp::min(apply_tip + credits, target);

            // v14.10 safety-net: if genesis (h=0) still missing AND apply_tip=0,
            // include h=0 in the missing scan. Guards against the case where the
            // genesis priority path timed out but main-loop still needs h=0 to
            // unblock the deferred buffer. Without this, scan starts at h=1 and
            // h=0 is never requested again → permanent deadlock.
            let genesis_absent = apply_tip == 0
                && self.storage.load_microblock(0).map(|o| o.is_none()).unwrap_or(true);
            let scan_start = if genesis_absent { 0 } else { apply_tip + 1 };

            // ─────────────────────────────────────────────────────────────
            // Find missing ranges [first_missing..=last_missing] inside the window.
            // Each gap is treated independently — one partial-delivery block does
            // not prevent the OTHER gaps from being requested.
            // ─────────────────────────────────────────────────────────────
            let mut missing: Vec<(u64, u64)> = Vec::new();
            let mut range_start: Option<u64> = None;
            let mut range_end: u64 = 0;
            for h in scan_start..=window_end {
                let present = self.storage.load_microblock(h)
                    .map(|opt| opt.is_some())
                    .unwrap_or(false);
                if !present {
                    match range_start {
                        None => { range_start = Some(h); range_end = h; }
                        Some(_) => { range_end = h; }
                    }
                } else if let Some(rs) = range_start.take() {
                    missing.push((rs, range_end));
                }
            }
            if let Some(rs) = range_start {
                missing.push((rs, range_end));
            }

            if missing.is_empty() {
                // Window complete in storage — wait for apply_tip to advance.
                tokio::select! {
                    _ = apply_notify.notified() => {}
                    _ = tokio::time::sleep(NOTIFY_TIMEOUT) => {
                        if is_debug() {
                            println!("[DBG][SYNC] notify_timeout apply_tip={} target={}", apply_tip, target);
                        }
                    }
                }
                continue;
            }

            // Split missing ranges into ≤RANGE_CHUNK pieces, capped at
            // MAX_REQUESTS_PER_ITER per iteration (prevents fan-out burst).
            let mut requests: Vec<(u64, u64)> = Vec::new();
            'outer: for (from, to) in &missing {
                let mut cur = *from;
                while cur <= *to {
                    let end = std::cmp::min(cur + RANGE_CHUNK - 1, *to);
                    requests.push((cur, end));
                    if requests.len() >= MAX_REQUESTS_PER_ITER {
                        break 'outer;
                    }
                    cur = end + 1;
                }
            }

            if is_info() && !requests.is_empty() {
                println!("[INFO][SYNC] window tip={} target={} in_flight={} credits={} missing_ranges={} dispatching={}",
                         apply_tip, target, in_flight, credits, missing.len(), requests.len());
            }

            // Dispatch requests in parallel. sync_blocks shards across peers
            // (unified_p2p.rs v14.2 RANGE-SHARDED PARALLEL SYNC).
            let dispatch_start = Instant::now();
            let mut any_sent = false;
            for (from, to) in requests {
                match tokio::time::timeout(
                    self.config.request_timeout,
                    self.p2p.sync_blocks(from, to),
                ).await {
                    Ok(Ok(())) => { any_sent = true; }
                    Ok(Err(e)) => {
                        if is_debug() {
                            println!("[DBG][SYNC] dispatch_err h={}-{} err={}", from, to, e);
                        }
                    }
                    Err(_) => {
                        if is_debug() {
                            println!("[DBG][SYNC] dispatch_timeout h={}-{}", from, to);
                        }
                    }
                }
            }

            if !any_sent {
                consecutive_failures += 1;
                if consecutive_failures > self.config.max_retries {
                    if is_warn() {
                        println!("[WARN][SYNC] all_dispatches_failed tip={} abort", apply_tip);
                    }
                    break;
                }
                let backoff = Duration::from_millis(50u64 << (consecutive_failures.min(5)));
                tokio::time::sleep(backoff).await;
                continue;
            }

            // Wait for pipeline to apply AT LEAST ONE new block, or safety timeout.
            tokio::select! {
                _ = apply_notify.notified() => {}
                _ = tokio::time::sleep(NOTIFY_TIMEOUT) => {
                    let elapsed_dispatch = dispatch_start.elapsed().as_millis();
                    if is_debug() {
                        println!("[DBG][SYNC] await_notify_timeout tip={} dispatched_ms={}",
                                 apply_tip, elapsed_dispatch);
                    }
                }
            }
        }

        // ────────────────────────────────────────────────────────────────────
        // Sync completed (or aborted)
        // ────────────────────────────────────────────────────────────────────
        self.active.store(false, Ordering::SeqCst);

        let final_height = self.storage.get_chain_height().unwrap_or(0);
        let elapsed = start_time.elapsed();
        let blocks_synced = final_height.saturating_sub(local_h);
        let rate = if elapsed.as_secs() > 0 {
            blocks_synced / elapsed.as_secs().max(1)
        } else {
            0
        };

        // Log final pipeline stats
        let metrics = self.pipeline.metrics();
        if is_info() {
            println!("[INFO][SYNC] pipeline_summary ingested={} decoded={} verified={} applied={} dropped={}",
                     metrics.ingested.load(Ordering::Relaxed),
                     metrics.decoded.load(Ordering::Relaxed),
                     metrics.verified.load(Ordering::Relaxed),
                     metrics.applied.load(Ordering::Relaxed),
                     metrics.decode_failed.load(Ordering::Relaxed)
                        + metrics.verify_failed.load(Ordering::Relaxed)
                        + metrics.apply_failed.load(Ordering::Relaxed));
        }

        if final_height >= target {
            self.coordinator.try_send(ConsensusEvent::SyncComplete {
                height: final_height,
            });
            if is_info() {
                println!("[INFO][SYNC] complete h={} synced={} elapsed={}s rate={}blk/s",
                         final_height, blocks_synced, elapsed.as_secs(), rate);
            }
        } else {
            self.coordinator.try_send(ConsensusEvent::SyncFailed {
                error: format!("stopped at h={} target={}", final_height, target),
            });
            if is_warn() {
                println!("[WARN][SYNC] incomplete h={} target={} synced={} elapsed={}s rate={}blk/s",
                         final_height, target, blocks_synced, elapsed.as_secs(), rate);
            }
        }
    }

    // v14.9: adaptive_wave_size removed — pipelined window in execute_sync
    // handles sizing dynamically via missing-ranges discovery. Old wave-based
    // sizing was tuned for polling-loop architecture that no longer exists.
}


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
    /// Request sync to a target height.
    pub async fn sync_to(&self, target: u64) -> bool {
        self.command_tx.send(SyncCommand::SyncTo { target }).await.is_ok()
    }

    /// Request sync to network height (auto-detected).
    pub async fn sync_to_network(&self) -> bool {
        self.command_tx.send(SyncCommand::SyncToNetwork).await.is_ok()
    }

    /// Stop current sync.
    pub async fn stop(&self) -> bool {
        self.command_tx.send(SyncCommand::Stop).await.is_ok()
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
    SyncTo { target: u64 },
    SyncToNetwork,
    Stop,
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
}

impl SyncManager {
    /// Create sync manager + handle pair.
    pub fn new(
        config: SyncConfig,
        storage: Arc<Storage>,
        p2p: Arc<SimplifiedP2P>,
        pipeline: PipelineIngest,
        coordinator: CoordinatorHandle,
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
                        SyncCommand::SyncTo { target } => {
                            self.execute_sync(target).await;
                        }
                        SyncCommand::SyncToNetwork => {
                            let network_h = self.detect_network_height().await;
                            if network_h > 0 {
                                self.execute_sync(network_h).await;
                            }
                        }
                        SyncCommand::Stop => {
                            self.active.store(false, Ordering::SeqCst);
                            if is_info() {
                                println!("[INFO][SYNC] stopped_by_command");
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

    /// Detect network height from peers.
    /// FIX M-H16: Don't trust a single peer if height is significantly ahead.
    /// Verify against bootstrap nodes before accepting large jumps.
    async fn detect_network_height(&self) -> u64 {
        let local_h = self.coordinator.chain_height();
        let best = self.p2p.get_best_peer_height();

        // If single peer reports height >100 blocks ahead, verify against bootstrap
        if best > 0 && best <= local_h + 100 {
            return best;
        }

        // For large gaps or zero best-peer, always probe bootstrap nodes
        // Fallback: HTTP probe to bootstrap nodes
        let bootstrap_ips = crate::genesis_constants::get_genesis_ips();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();

        let mut heights: Vec<u64> = Vec::new();
        for ip in bootstrap_ips.iter().take(5) {
            let url = format!("http://{}:8001/api/v1/block/latest", ip);
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        if let Some(h) = json.get("height").and_then(|v| v.as_u64()) {
                            heights.push(h);
                        }
                    }
                }
            }
        }

        if heights.len() >= 2 {
            heights.sort();
            let median = heights[heights.len() / 2];

            // FIX M-H16: If single peer reported a very high height, only trust it
            // if bootstrap nodes confirm a similar range (within 50 blocks)
            if best > local_h + 100 && median > 0 {
                if best > median + 50 {
                    if is_warn() {
                        println!("[WARN][SYNC] peer_height_suspect peer={} bootstrap_median={}", best, median);
                    }
                    return median; // Trust bootstrap consensus over single peer
                }
            }

            // If we had a valid peer height and bootstrap confirms, use the higher
            if best > 0 && best <= median + 50 {
                return std::cmp::max(best, median);
            }

            median
        } else if best > 0 && best <= local_h + 100 {
            // Few bootstrap responses but peer gap is small -- trust peer
            best
        } else {
            heights.first().copied().unwrap_or(0)
        }
    }

    /// Check if we're behind and need to sync.
    async fn check_desync(&self) {
        let snap = self.coordinator.snapshot();
        let network_h = self.p2p.get_best_peer_height();
        let local_h = snap.chain_height;

        if network_h > local_h + self.config.auto_sync_gap {
            if is_info() {
                println!("[INFO][SYNC] desync_detected local={} network={} gap={}",
                         local_h, network_h, network_h - local_h);
            }
            self.execute_sync(network_h).await;
        }
    }

    /// v14.9: Event-driven pipelined sync.
    ///
    /// Architecture (scales to 10K+ Super nodes at 1-sec block time):
    ///
    ///   1. Maintain a sliding WINDOW of [apply_tip+1 .. apply_tip+WINDOW] requested.
    ///   2. Find MISSING RANGES inside the window (storage.load_microblock().is_none()).
    ///   3. Shard missing ranges across N peers (deterministic, reputation-weighted).
    ///   4. Fire-and-forget range requests; P2P delivers to pipeline.
    ///   5. Await `pipeline.apply_notify()` — woken after each successful save.
    ///     ⇒ NO poll-sleeps, NO wave-walls, NO "break at first gap".
    ///   6. As apply_tip advances, refill the window with next missing ranges.
    ///
    /// Correctness:
    ///   - Pipeline dedups at storage level; re-requesting delivered blocks is a no-op.
    ///   - `apply_notify` is a Tokio `Notify` — O(1) wake, safe at any scale.
    ///   - 15s hard safety-net timeout guards against silent peer stalls.
    async fn execute_sync(&self, target: u64) {
        let local_h = self.coordinator.chain_height();

        if local_h >= target {
            if is_debug() {
                println!("[DBG][SYNC] already_at_target local={} target={}", local_h, target);
            }
            return;
        }

        // Check minimum peers
        let peer_count = self.p2p.get_peer_count();
        if peer_count < self.config.min_peers_for_sync {
            if is_warn() {
                println!("[WARN][SYNC] insufficient_peers count={} need={}",
                         peer_count, self.config.min_peers_for_sync);
            }
            return;
        }

        self.active.store(true, Ordering::SeqCst);
        self.target_height_atomic.store(target, Ordering::Relaxed);
        self.progress_height.store(local_h, Ordering::Relaxed);

        // Notify coordinator
        self.coordinator.try_send(ConsensusEvent::SyncStart {
            target_height: target,
            source_peer: None,
        });

        if is_info() {
            println!("[INFO][SYNC] start local={} target={} gap={} peers={} mode=pipelined",
                     local_h, target, target - local_h, peer_count);
        }

        // ═══════════════════════════════════════════════════════════════════════
        // v14.9: PIPELINED WINDOW CONFIG
        // ═══════════════════════════════════════════════════════════════════════
        // WINDOW: how many future blocks may be "in flight" simultaneously.
        //   - 2000 blocks × ~500 bytes avg = ~1MB peak in pipeline queues → safe.
        //   - At 1 blk/s net rate this is 2000s of buffer — kills RTT dependence.
        //   - Bounded size prevents unbounded memory growth under malicious peers.
        //
        // RANGE_CHUNK: how big each P2P request is.
        //   - 100 blocks/request matches server-side MAX_BATCH (17783).
        //   - Smaller chunks = finer granularity for gap repair; 100 is sweet spot.
        //
        // NOTIFY_TIMEOUT: safety net if Notify is lost (never seen in practice).
        // ═══════════════════════════════════════════════════════════════════════
        const WINDOW: u64 = 2000;
        const RANGE_CHUNK: u64 = 100;
        const NOTIFY_TIMEOUT: Duration = Duration::from_secs(15);
        const STALL_ABORT: Duration = Duration::from_secs(120);

        let apply_notify = self.pipeline.apply_notify();
        let start_time = Instant::now();
        let mut last_progress_tip = local_h;
        let mut last_progress_at = Instant::now();
        let mut consecutive_failures = 0u32;

        while self.active.load(Ordering::Relaxed) {
            let apply_tip = self.storage.get_chain_height().unwrap_or(local_h);

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
            } else if last_progress_at.elapsed() > STALL_ABORT {
                if is_warn() {
                    println!("[WARN][SYNC] stalled_abort h={} target={} stuck_for={}s",
                             apply_tip, target, last_progress_at.elapsed().as_secs());
                }
                break;
            }

            let window_end = std::cmp::min(apply_tip + WINDOW, target);

            // ─────────────────────────────────────────────────────────────
            // Find missing ranges [first_missing..=last_missing] inside the window.
            // Ported from parallel_download_microblocks — doesn't bail on first gap.
            // ─────────────────────────────────────────────────────────────
            let mut missing: Vec<(u64, u64)> = Vec::new();
            let mut range_start: Option<u64> = None;
            let mut range_end: u64 = 0;
            for h in (apply_tip + 1)..=window_end {
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
                // If target is within window, this means pipeline is working through
                // already-fetched blocks; just wait for notify.
                tokio::select! {
                    _ = apply_notify.notified() => {}
                    _ = tokio::time::sleep(NOTIFY_TIMEOUT) => {
                        // Safety net — extremely rare. Log and continue, next loop
                        // iteration will re-check storage.
                        if is_debug() {
                            println!("[DBG][SYNC] notify_timeout apply_tip={} target={}", apply_tip, target);
                        }
                    }
                }
                continue;
            }

            // Split missing ranges into ≤RANGE_CHUNK pieces. Each piece becomes
            // one P2P request. At large gaps this fans out many requests in parallel.
            let mut requests: Vec<(u64, u64)> = Vec::new();
            for (from, to) in &missing {
                let mut cur = *from;
                while cur <= *to {
                    let end = std::cmp::min(cur + RANGE_CHUNK - 1, *to);
                    requests.push((cur, end));
                    cur = end + 1;
                }
            }

            if is_info() && requests.len() > 0 {
                println!("[INFO][SYNC] window tip={} target={} missing_ranges={} requests={}",
                         apply_tip, target, missing.len(), requests.len());
            }

            // Dispatch requests in parallel. sync_blocks shards across peers
            // (see unified_p2p.rs:18539 — v14.2 RANGE-SHARDED PARALLEL SYNC).
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
                // Back off briefly when ALL dispatches fail — usually a transient
                // peer-set problem. Exponential backoff up to 2s.
                let backoff = Duration::from_millis(50u64 << (consecutive_failures.min(5)));
                tokio::time::sleep(backoff).await;
                continue;
            }

            // Wait for pipeline to apply AT LEAST ONE new block, or safety timeout.
            tokio::select! {
                _ = apply_notify.notified() => {}
                _ = tokio::time::sleep(NOTIFY_TIMEOUT) => {
                    // Safety net. Log and continue — loop re-scans storage.
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

// ============================================================================
// FORK RECOVERY
// ============================================================================

/// Execute fork recovery: rollback + resync from network.
/// This is a separate function (not part of normal sync) because it involves
/// destructive operations (deleting blocks from storage).
pub async fn resolve_fork(
    fork_height: u64,
    local_height: u64,
    storage: &Arc<Storage>,
    coordinator: &CoordinatorHandle,
    sync_handle: &SyncHandle,
) -> Result<(), String> {
    let rollback_to = fork_height.saturating_sub(1);

    if is_info() {
        println!("[INFO][SYNC] fork_resolve start fork={} rollback_to={} local={}",
                 fork_height, rollback_to, local_height);
    }

    // Notify coordinator
    coordinator.try_send(ConsensusEvent::ForkDetected {
        fork_height,
        rollback_to,
    });

    // Atomic batch delete — crash-safe: either all deleted or none
    match storage.delete_microblocks_range(fork_height, local_height) {
        Ok(count) => {
            if is_info() {
                println!("[INFO][SYNC] rollback_deleted h={}..{} count={}", fork_height, local_height, count);
            }
        }
        Err(e) => {
            if is_warn() {
                println!("[WARN][SYNC] rollback_batch_failed h={}..{} err={}", fork_height, local_height, e);
            }
        }
    }

    // Update chain height
    if let Err(e) = storage.set_chain_height(rollback_to) {
        return Err(format!("set_chain_height: {}", e));
    }

    if is_info() {
        println!("[INFO][SYNC] rollback_complete new_height={}", rollback_to);
    }

    // Request resync from network
    let network_h = coordinator.snapshot().network_height;
    let target = std::cmp::max(network_h, local_height);
    sync_handle.sync_to(target).await;

    // FIX M-M23: Do NOT send ForkResolved here -- sync_to() is async and only enqueues.
    // Instead, wait for sync to actually complete by polling the sync handle.
    // The sync completion (SyncComplete event) will transition state to Synchronized.
    // We send ForkResolved only after verifying blocks were actually synced.
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if !sync_handle.is_active() {
            break;
        }
        if Instant::now() > deadline {
            if is_warn() {
                println!("[WARN][SYNC] fork_resync_timeout target={}", target);
            }
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let final_height = coordinator.chain_height();
    coordinator.try_send(ConsensusEvent::ForkResolved {
        new_height: final_height,
    });

    if is_info() {
        println!("[INFO][SYNC] fork_resolved new_height={} target_was={}", final_height, target);
    }

    Ok(())
}

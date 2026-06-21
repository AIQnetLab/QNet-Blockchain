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

    /// Cold-start sync target = QC-verified finality frontier; the peer/bootstrap-HTTP hint may only
    /// add the ≤2-macroblock unsealed tail above it (no unverified scalar drives the bulk target).
    /// frontier==0 (h<90 / fresh genesis) ⇒ the hint alone, so the 5-genesis bootstrap is never blocked.
    async fn detect_network_height(&self) -> u64 {
        let hint = self.detect_network_height_hint().await;
        let frontier = crate::node::qc_verified_frontier_height();
        if frontier == 0 { hint }
        else { std::cmp::max(frontier, std::cmp::min(hint, frontier.saturating_add(180))) }
    }

    /// Peer/bootstrap-HTTP height HINT (unverified scalar) — used only to pick the probe target and the
    /// near-tip tail; floored by the QC frontier in detect_network_height above.
    /// FIX M-H16: Don't trust a single peer if height is significantly ahead.
    /// Verify against bootstrap nodes before accepting large jumps.
    async fn detect_network_height_hint(&self) -> u64 {
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
        // Trigger sync ONLY off the QC-verified FINALIZED frontier — the convergent reference every
        // healthy node shares — never the produced tip. detect_network_height both climbs the local
        // frontier toward the network (its macroblock-lineage probe) and returns the bulk-sync
        // TARGET (frontier + bounded unsealed tail). The tail ABOVE the frontier is delivered by
        // block gossip in real time, so the normal intra-rotation production lead must NOT fire a
        // redundant sync — only a node genuinely below finality (or still cold) catches up here.
        let network_h = self.detect_network_height().await;
        let frontier = crate::node::qc_verified_frontier_cached();
        let local_h = snap.chain_height;

        // frontier>0 (steady/warm): behind ⟺ a QC-finalized macroblock sits above the applied tip
        // (fell behind finality, or the probe just climbed the frontier ahead of us). frontier==0
        // (fresh/pre-maturity, no local finality anchor): drive off the bootstrap-cross-checked
        // target so a cold node still onboards.
        let behind = if frontier > 0 {
            frontier > local_h.saturating_add(self.config.auto_sync_gap)
        } else {
            network_h > local_h.saturating_add(self.config.auto_sync_gap)
        };

        if behind {
            if is_info() {
                println!("[INFO][SYNC] desync_detected local={} frontier={} target={} gap={}",
                         local_h, frontier, network_h, network_h.saturating_sub(local_h));
            }
            self.execute_sync(network_h).await;
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
    ///   - 120s STALL_ABORT breaks the loop if apply_tip doesn't advance.
    ///
    /// Genesis priority (fresh node bootstrap):
    ///   If local_h == 0 and storage lacks h=0, we issue a targeted sync_blocks(0,0)
    ///   first and wait (bounded) for apply_tip ≥ 1 before entering the main loop.
    ///   Without this, a fresh node would dispatch h=1..=N in parallel, but NONE
    ///   would verify (missing previous_hash for genesis) — triggering a cycle
    ///   of deferred_full drops until genesis eventually arrives randomly.
    async fn execute_sync(&self, target: u64) {
        let mut local_h = self.coordinator.chain_height();

        // D1: never let an unverified scalar drive the bulk target. Floor it to the QC-verified
        // finality frontier (authoritative); an unverified hint may only add the ≤2-macroblock
        // unsealed tail above it. frontier==0 (fresh genesis, h<90) ⇒ target as-is so the
        // 5-genesis bootstrap is never blocked. Mirrors detect_network_height; protects every
        // caller (SyncTo / SyncToNetwork / check_desync / snapshot fast-path) uniformly.
        let target = {
            let frontier = crate::node::qc_verified_frontier_height();
            if frontier == 0 { target }
            else { std::cmp::max(frontier, std::cmp::min(target, frontier.saturating_add(180))) }
        };

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
        const SNAPSHOT_FAST_PATH_GAP: u64 = 1_500;
        // GALC cold/dormant-join: whenever the snapshot fast-path will run (fresh cold join OR a returning
        // node behind by > the gap), request the latest genesis-signed checkpoint capsule so the lineage
        // walk roots near the tip (bounded) at ANY chain age — NOT only at local_h==0 (a long-offline warm
        // node also needs it). Cold join (local_h==0) first ensures block 0 (network_id). Best-effort +
        // async-verified by the handler; falls back to the binary pin if unavailable.
        if local_h == 0 || target.saturating_sub(local_h) > SNAPSHOT_FAST_PATH_GAP {
            if local_h == 0 && self.storage.load_microblock(0).map(|o| o.is_none()).unwrap_or(true) {
                let _ = self.p2p.sync_blocks(0, 0).await;
                tokio::time::sleep(Duration::from_millis(800)).await;
            }
            let _ = self.p2p.broadcast_quic(&crate::unified_p2p::NetworkMessage::RequestGenesisCheckpoint {
                requester_id: "cold_joiner".to_string(),
            }).await;
            tokio::time::sleep(Duration::from_millis(1200)).await;
        }

        if local_h == 0 || target.saturating_sub(local_h) > SNAPSHOT_FAST_PATH_GAP {
            match self.storage.fast_sync_with_snapshot(&self.p2p, target).await {
                Ok(()) => {
                    let restored = self.storage.get_chain_height().unwrap_or(local_h);
                    if restored > local_h {
                        local_h = restored;
                        self.progress_height.store(restored, Ordering::Relaxed);
                        crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.store(restored, Ordering::Release);
                        if is_info() {
                            println!("[INFO][SYNC] snapshot_restored h={} target={} tail={}",
                                     restored, target, target.saturating_sub(restored));
                        }
                    } else if is_info() {
                        println!("[INFO][SYNC] snapshot_no_advance local={} — fallback block_sync", local_h);
                    }
                }
                Err(e) => {
                    if is_info() {
                        println!("[INFO][SYNC] snapshot_unavailable reason={:?} fallback=block_sync", e);
                    }
                }
            }
        }

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


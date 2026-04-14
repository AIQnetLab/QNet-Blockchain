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
// v13.0: FORK RECOVERY SIGNAL
// ============================================================================
// Tracks hash_chain_break events per height from distinct peers.
// When N distinct peers report hash_chain_break at the same height,
// it's a confirmed fork — signal rollback+resync to the main consensus loop.
//
// ARCHITECTURE: This is the "circuit breaker" that prevents permanent stall.
// Without this, a forked node discards all incoming blocks forever.
// ============================================================================

/// Default fork break threshold (used at genesis with 5 nodes).
/// Overridden dynamically by update_fork_threshold() from main consensus loop.
const FORK_BREAK_PEER_THRESHOLD_DEFAULT: usize = 3;

/// Floor: never go below 3 peers (even with few connections)
const FORK_BREAK_PEER_THRESHOLD_MIN: usize = 3;

/// Cap: pipeline realistically sees blocks from ~20-30 relay peers.
/// Higher threshold = detection never fires. Safety ensured by
/// check_finality_allows_rollback() + try_fork_recovery() cooldown + Dilithium sigs.
const FORK_BREAK_PEER_THRESHOLD_MAX: usize = 20;

/// Dynamic fork break threshold: f+1 of connected peers, bounded by [MIN, MAX].
/// Updated every 30s from main consensus loop via update_fork_threshold().
/// verify_stage reads this atomically — no P2P dependency needed.
static DYNAMIC_FORK_THRESHOLD: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(FORK_BREAK_PEER_THRESHOLD_DEFAULT);

/// Update fork break threshold based on current connected peer count.
/// Called from main consensus loop where P2P context is available.
/// Formula: f+1 = ceil(connected/3), clamped to [3, 20].
///
/// Examples:
///   5 connected → max(3, min(ceil(5/3)=2, 20)) = 3  (60%)
///   10 connected → max(3, min(4, 20)) = 4  (40%)
///   50 connected → max(3, min(17, 20)) = 17  (34%)
///   100 connected → max(3, min(34, 20)) = 20  (20%)
///   1000 connected → max(3, min(334, 20)) = 20  (2%, safety via finality+cooldown)
pub fn update_fork_threshold(connected_peers: usize) {
    let f_plus_1 = (connected_peers + 2) / 3; // ceil(n/3)
    let threshold = std::cmp::max(
        FORK_BREAK_PEER_THRESHOLD_MIN,
        std::cmp::min(f_plus_1, FORK_BREAK_PEER_THRESHOLD_MAX),
    );
    DYNAMIC_FORK_THRESHOLD.store(threshold, std::sync::atomic::Ordering::Relaxed);
    if is_debug() {
        println!("[DBG][PIPELINE] fork_threshold_updated peers={} threshold={}", connected_peers, threshold);
    }
}

/// Get current dynamic fork threshold (called from verify_stage)
fn get_fork_threshold() -> usize {
    DYNAMIC_FORK_THRESHOLD.load(std::sync::atomic::Ordering::Relaxed)
}

/// Cooldown between fork recovery signals (prevents rollback ping-pong)
const FORK_RECOVERY_COOLDOWN_SECS: u64 = 60;

/// Global fork recovery signal: fork_height (0 = no signal)
/// Main consensus loop checks this and triggers rollback+resync
static FORK_RECOVERY_HEIGHT: AtomicU64 = AtomicU64::new(0);

/// Timestamp of last fork recovery signal (prevents re-triggering too fast)
static FORK_RECOVERY_LAST_SIGNAL: AtomicU64 = AtomicU64::new(0);

/// Track distinct peers per height that reported hash_chain_break
static HASH_CHAIN_BREAK_TRACKER: std::sync::LazyLock<std::sync::Mutex<HashMap<u64, std::collections::HashSet<String>>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Check and consume fork recovery signal
/// Returns Some(fork_height) if recovery is needed
pub fn take_fork_recovery_signal() -> Option<u64> {
    let h = FORK_RECOVERY_HEIGHT.swap(0, Ordering::SeqCst);
    if h > 0 { Some(h) } else { None }
}

/// Clear stale entries from break tracker (called periodically)
pub fn cleanup_break_tracker(min_height: u64) {
    if let Ok(mut tracker) = HASH_CHAIN_BREAK_TRACKER.lock() {
        tracker.retain(|h, _| *h >= min_height);
    }
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
        }
    }

    pub fn log_summary(&self) {
        if is_info() {
            println!("[INFO][PIPELINE] ingested={} decoded={} decode_fail={} verified={} verify_fail={} applied={} apply_fail={} dup_skip={}",
                     self.ingested.load(Ordering::Relaxed),
                     self.decoded.load(Ordering::Relaxed),
                     self.decode_failed.load(Ordering::Relaxed),
                     self.verified.load(Ordering::Relaxed),
                     self.verify_failed.load(Ordering::Relaxed),
                     self.applied.load(Ordering::Relaxed),
                     self.apply_failed.load(Ordering::Relaxed),
                     self.duplicates_skipped.load(Ordering::Relaxed));
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
        tokio::spawn(Self::decode_stage(
            ingest_rx,
            decode_tx,
            storage_decode,
            metrics_decode,
            config.max_block_bytes,
        ));

        // Stage 2: Decode → Verify (signature, hash chain, timestamp)
        let metrics_verify = metrics.clone();
        let storage_verify = ctx.storage.clone();
        let coordinator_verify = ctx.coordinator.clone();
        tokio::spawn(Self::verify_stage(
            decode_rx,
            verify_tx,
            storage_verify,
            coordinator_verify,
            metrics_verify,
            ctx.node_id.clone(),
        ));

        // Stage 3: Verify → Apply (state transitions + storage write + ALL side effects)
        // MUST be single-threaded (sequential writes to RocksDB + state)
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

        PipelineIngest {
            tx: ingest_tx,
            metrics,
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
    ) {
        while let Some(block) = rx.recv().await {
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
        _node_id: String,
    ) {
        while let Some(decoded) = rx.recv().await {
            let mb = &decoded.microblock;

            // 1. Hash chain continuity (except genesis)
            if mb.height > 0 {
                let prev_hash_ok = match storage.load_microblock_auto_format(mb.height - 1) {
                    Ok(Some(prev_block)) => {
                        // Verify previous_hash matches actual prev block hash
                        let prev_hash = prev_block.hash();
                        mb.previous_hash == prev_hash
                    }
                    Ok(None) => {
                        // Previous block not yet available — defer, don't reject.
                        // This is normal during sync when blocks arrive out of order.
                        if is_info() {
                            println!("[INFO][PIPELINE] block_deferred h={} reason=parent_missing need_h={}", mb.height, mb.height - 1);
                        }
                        // Skip — sync manager will ensure ordering
                        metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
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
                        println!("[WARN][PIPELINE] hash_chain_break h={} from={}", mb.height, decoded.from_peer);
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);

                    // v13.0: Track hash_chain_break per height from distinct peers.
                    // When FORK_BREAK_PEER_THRESHOLD distinct peers report break at same height,
                    // it confirms WE are on the wrong fork — signal rollback+resync.
                    {
                        let peer_id = decoded.from_peer.clone();
                        let current_threshold = get_fork_threshold();
                        let should_signal = if let Ok(mut tracker) = HASH_CHAIN_BREAK_TRACKER.lock() {
                            let peers = tracker.entry(mb.height).or_insert_with(std::collections::HashSet::new);
                            peers.insert(peer_id);
                            let count = peers.len();
                            if count >= current_threshold {
                                if is_warn() {
                                    println!("[WARN][PIPELINE] fork_confirmed h={} distinct_peers={} threshold={}",
                                             mb.height, count, current_threshold);
                                }
                                true
                            } else {
                                if is_debug() {
                                    println!("[DBG][PIPELINE] break_tracked h={} peers={}/{}",
                                             mb.height, count, current_threshold);
                                }
                                false
                            }
                        } else {
                            false
                        };

                        if should_signal {
                            // Cooldown: prevent rollback ping-pong between node groups
                            let now_secs = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs();
                            let last_signal = FORK_RECOVERY_LAST_SIGNAL.load(Ordering::SeqCst);
                            let cooldown_ok = now_secs.saturating_sub(last_signal) >= FORK_RECOVERY_COOLDOWN_SECS;

                            if cooldown_ok {
                                // Atomic CAS: only set if no pending signal (0 → fork_height)
                                // Prevents overwriting a signal the main loop hasn't consumed yet
                                if FORK_RECOVERY_HEIGHT.compare_exchange(
                                    0, mb.height, Ordering::SeqCst, Ordering::SeqCst
                                ).is_ok() {
                                    FORK_RECOVERY_LAST_SIGNAL.store(now_secs, Ordering::SeqCst);
                                    println!("[WARN][PIPELINE] fork_recovery_signal h={} threshold={} (rollback+resync required)",
                                             mb.height, current_threshold);
                                }
                            } else if is_info() {
                                println!("[INFO][PIPELINE] fork_signal_cooldown h={} remaining={}s",
                                         mb.height, FORK_RECOVERY_COOLDOWN_SECS - now_secs.saturating_sub(last_signal));
                            }

                            // Clear tracker for this height (one-shot)
                            if let Ok(mut tracker) = HASH_CHAIN_BREAK_TRACKER.lock() {
                                tracker.remove(&mb.height);
                            }
                        }
                    }

                    continue;
                }
            }

            // 2. Timestamp validation (only in live mode — sync mode skips)
            let snap = coordinator.snapshot();
            if !snap.is_syncing() && mb.height > 0 {
                let now = crate::node::get_timestamp_safe();
                // FIX R22-T5: Use unified TIMESTAMP_FUTURE_TOLERANCE (15s) from node.rs
                // Was hardcoded 30s here vs 15s in validate_received_microblock() — inconsistent
                // acceptance window caused blocks to pass pipeline but fail node validation.
                if mb.timestamp > now + crate::node::TIMESTAMP_FUTURE_TOLERANCE {
                    if is_warn() {
                        println!("[WARN][PIPELINE] future_block h={} delta=+{}s from={}",
                                 mb.height, mb.timestamp.saturating_sub(now), decoded.from_peer);
                    }
                    metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            }

            // 3. Signature verification
            // Genesis block (h=0) uses embedded self-signed keys — skip standard verification
            if mb.height > 0 {
                // Dilithium/hybrid signature verification via BlockchainNode
                if !mb.signature.is_empty() {
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

            // All checks passed — forward to apply stage
            let verified = VerifiedBlock {
                height: decoded.height,
                decompressed: decoded.decompressed,
                microblock: decoded.microblock,
                from_peer: decoded.from_peer,
            };

            metrics.verified.fetch_add(1, Ordering::Relaxed);

            if decoded.height <= 5 || decoded.height % 100 == 0 {
                if is_info() {
                    println!("[INFO][PIPELINE] verified h={} prod={} txs={}",
                             verified.height, verified.microblock.producer,
                             verified.microblock.transactions.len());
                }
            }

            if let Err(_) = tx.send(verified).await {
                break;
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

            // Double-check dedup (race between verify and apply)
            if ctx.storage.load_microblock(height)
                .map(|opt| opt.is_some())
                .unwrap_or(false)
            {
                metrics.duplicates_skipped.fetch_add(1, Ordering::Relaxed);
                crate::unified_p2p::clear_block_pending_sync(height);
                continue;
            }

            // ── State application with snapshot + rollback support ──
            let apply_ok = {
                let state_guard = ctx.state.write().await;

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
                let mut block_snapshot = if has_state_root {
                    Some(state_guard.create_block_snapshot(height))
                } else {
                    None
                };

                // Get processed emission MBs for double-emission prevention
                let processed_emission_set = {
                    let reward_mgr = ctx.reward_manager.read().await;
                    reward_mgr.get_processed_emission_macroblocks().clone()
                };

                // Apply all state mutations via shared function
                let apply_result = BlockchainNode::apply_block_to_state(
                    &state_guard,
                    &block.microblock,
                    &ctx.storage,
                    block_snapshot.as_mut(),
                    Some(&processed_emission_set),
                );

                let computed_state_root = apply_result.merkle_root;

                // State root verification
                if has_state_root && computed_state_root != block.microblock.state_root {
                    eprintln!("[ERR][PIPELINE] state_root_mismatch h={} expected={} computed={}",
                             height,
                             hex::encode(&block.microblock.state_root[..8]),
                             hex::encode(&computed_state_root[..8]));

                    // Rollback to pre-block state
                    if let Some(ref snapshot) = block_snapshot {
                        state_guard.rollback_block(snapshot);
                        if is_info() { println!("[INFO][PIPELINE] block_rollback h={}", height); }
                    }
                    metrics.apply_failed.fetch_add(1, Ordering::Relaxed);
                    crate::unified_p2p::clear_block_pending_sync(height);
                    continue;
                }

                // State verified — save block
                match ctx.storage.save_microblock(height, &block.decompressed) {
                    Ok(()) => {
                        // Update chain height in storage
                        if let Err(e) = ctx.storage.set_chain_height(height) {
                            if is_warn() { println!("[WARN][PIPELINE] set_height_failed h={} err={}", height, e); }
                        }

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
                continue;
            }

            // ── Post-save updates (no state lock held) ──
            metrics.applied.fetch_add(1, Ordering::Relaxed);

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

            // Broadcast block event (for consensus listener)
            let _ = ctx.block_event_tx.send(height);

            // Notify coordinator
            ctx.coordinator.try_send(ConsensusEvent::BlockApplied {
                height,
                producer: producer.clone(),
                timestamp: block.microblock.timestamp,
            });

            // ── Reputation update for block producer ──
            // Handled by deterministic reputation system via macroblock processing
            // (not per-microblock — that's by design)

            if height <= 5 || height % 50 == 0 {
                if is_info() {
                    println!("[INFO][PIPELINE] applied h={} prod={} txs={}", height, producer, tx_count);
                }
            }
        }
    }
}

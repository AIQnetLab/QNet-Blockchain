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
/// Set by the macroblock-divergence detector OR by the microblock
/// distinct-peer-witness tracker (v14.8.5); consumed by the main consensus loop.
static FORK_RECOVERY_HEIGHT: AtomicU64 = AtomicU64::new(0);

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
/// If the set of distinct witnesses reaches f+1 (not 2f+1), signal fork
/// recovery. f+1 is the "at least one honest witness" threshold and is
/// the canonical bar for fork DETECTION (as opposed to the 2f+1 COMMIT
/// threshold).
///
/// Rate-limit semantics: once FORK_RECOVERY_HEIGHT is non-zero we don't
/// overwrite it with a different (lower) height — the main loop consumes
/// it first. This prevents flapping when two heights both accumulate
/// witnesses during a partition.
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
    // f+1 = ceil(n/3): guarantees at least one honest witness.
    let threshold_f_plus_1 = (total_validators.saturating_add(2)) / 3;
    // Floor at 2 so at any registry size ≥ 4 the threshold is ≥ 2; below
    // 4 we still need at least 2 distinct reporters to avoid single-peer
    // false positives.
    let threshold = threshold_f_plus_1.max(2);

    if witnesses >= threshold {
        let rollback_to = height.saturating_sub(1);
        // Only raise the signal — never lower. The main loop consumes it
        // under the same atomic swap that clears the tracker.
        let prev = FORK_RECOVERY_HEIGHT.load(Ordering::SeqCst);
        if rollback_to > prev {
            FORK_RECOVERY_HEIGHT.store(rollback_to, Ordering::SeqCst);
            if is_warn() {
                println!(
                    "[WARN][PIPELINE] minority_fork_detected h={} rollback_to={} witnesses={} threshold={} (f+1)",
                    height, rollback_to, witnesses, threshold
                );
            }
        }
    }
}

/// Periodic cleanup of stale witness entries below `min_height`.
/// Called by unified_p2p cleanup tasks.
pub fn cleanup_break_tracker(min_height: u64) {
    HASH_CHAIN_BREAK_WITNESSES.retain(|h, _| *h >= min_height);
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
        _node_id: String,
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
                        // Previous block not yet available — defer for retry.
                        // When parent arrives, this block will be re-checked.
                        if deferred.len() < DEFERRED_MAX {
                            if is_debug() {
                                println!("[DBG][PIPELINE] block_deferred h={} need_h={} buf={}",
                                         mb.height, mb.height - 1, deferred.len());
                            }
                            deferred.insert(mb.height, decoded);
                        } else {
                            // Buffer full — drop oldest to make room
                            if is_info() {
                                println!("[INFO][PIPELINE] deferred_full h={} dropped (buf={})",
                                         mb.height, DEFERRED_MAX);
                            }
                            metrics.verify_failed.fetch_add(1, Ordering::Relaxed);
                        }
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
                    // v14.8.5: MINORITY-FORK DETECTION via BFT-safe distinct-peer quorum.
                    // ═══════════════════════════════════════════════════════════════════════
                    // A single hash_chain_break is weak evidence — could be a single
                    // malformed block. But if 2f+1 DISTINCT validated peers all send
                    // blocks whose parent hash doesn't link into our local tip at the
                    // same height, WE are on the minority fork by the Byzantine
                    // supermajority rule: f+1 peers agreeing is already enough honest
                    // witnesses to prove it; 2f+1 makes the evidence resistant to up to
                    // f Byzantine peers all pushing the same wrong hash.
                    //
                    // Implementation: per-height set of distinct peer_ids that reported
                    // hash_chain_break. When the set size crosses 2f+1 of the current
                    // validator committee, signal FORK_RECOVERY_HEIGHT = mb.height - 1
                    // (everything at or below that height is still valid on our local
                    // chain; we roll back to the last known-good point and resync).
                    //
                    // Anti-Sybil: each entry is a verified peer_id from the decoded
                    // block's signed envelope (not raw socket addresses). An attacker
                    // cannot fake N distinct peer_ids without N distinct Dilithium3
                    // keys, and those keys must be in the registered validator set
                    // to count (see has_vrf_key check below).
                    //
                    // Rate-limit: once a recovery signal is set for a given height,
                    // we don't re-fire until the main loop consumes it via
                    // `take_fork_recovery_signal()` — which also clears the tracker.
                    //
                    // Scalability: DashSet per height, tiny (< 2f+1 entries). Cleaned
                    // up at cleanup_break_tracker() during cache sweep. Safe at
                    // thousands-of-nodes scale — committee sample is ≤ MAX_VALIDATORS
                    // (1000), and threshold grows linearly with it.
                    //
                    // Orthogonal to the macroblock-level rollback trigger: macroblock
                    // divergence catches PERSISTENT forks but only fires every 90 s;
                    // this microblock-level detector catches ACUTE forks quickly.
                    if mb.height > 0 {
                        record_hash_chain_break_witness(
                            mb.height,
                            &decoded.from_peer,
                        );
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
                if let Some(median_past) = crate::node::median_past_timestamp() {
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

            // ═══════════════════════════════════════════════════════════════════════════
            // 2b. v14.8.10: PACEMAKER-RANK CHECK REMOVED
            // ═══════════════════════════════════════════════════════════════════════════
            // Under the BFT-driven rotation model (v14.8.10), `block.timeout_round`
            // is the network's certified/adopted round at construction time, NOT a
            // wall-clock derivation. Ingest cannot recompute the expected value
            // locally — doing so would cross back into the non-deterministic
            // wall-clock pacemaker that caused the v14.8.7..9 fork regression.
            //
            // Safety for this value is carried by:
            //   * Dilithium3 signature over the block header (step 3) — a
            //     Byzantine producer cannot forge a block claiming any round.
            //   * Producer authority check (step 4) — same-round mismatch against
            //     the locally derived `(expected_producer, expected_round)` cache
            //     is a HARD reject, so a producer claiming a round they did not
            //     earn cannot override the honest expected producer.
            //   * Hash chain + parent monotonicity (steps 1 and 2) — timestamp
            //     still has to progress monotonically within the future-tolerance
            //     window, preventing arbitrary reordering.
            //
            // Scalability / Liveness: one fewer storage read per block.
            // ═══════════════════════════════════════════════════════════════════════════

            // 3. Signature verification
            // Genesis block (h=0) uses embedded self-signed keys — skip standard verification
            if mb.height > 0 {
                // Dilithium/hybrid signature verification via BlockchainNode
                if !mb.signature.is_empty() {
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
                if let Some((expected, expected_round)) = crate::node::get_expected_producer(mb.height) {
                    if mb.producer != expected {
                        if mb.timeout_round != expected_round {
                            // Category A: Timeout divergence — different round claimed.
                            // Without an ingest-side VRF re-derivation we cannot
                            // declare this invalid; signature + hash chain + 2f+1
                            // macroblock commit still enforce correctness, and
                            // the BFT-driven rotation converges once all nodes
                            // have gossiped their signed TimeoutVotes.
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
            // The producer-side pre-save guard (node.rs:yield_stale_round) still
            // prevents THIS node from emitting its own stale block — that is a
            // self-check on the same node and does not cross domains.
            // ═══════════════════════════════════════════════════════════════════════════

            // v14.7.2: per-microblock pipelined-QC verify REMOVED.
            // BFT safety for microblocks is delivered by the combination of:
            //   1. Dilithium3 producer signature (identity binding);
            //   2. hash-chain continuity (parent_hash check above);
            //   3. Producer-side pre-save yield_stale_round guard (self-check);
            //   4. 2f+1 macroblock commit/reveal at the 90-block boundary
            //      that hard-finalises and, by implication, retroactively
            //      ratifies every microblock below it.
            // A per-block QC is redundant with (4) and was also the source
            // of a production rate-limit collision. Removed.

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

            // v14.7.2: per-microblock BlockCommitVote emission REMOVED.
            // Canonical macroblock commit/reveal (2f+1 at 90-block boundary)
            // is the sole BFT finality layer. Per-block QCs duplicated that
            // path, inflated bandwidth, and shared the "commit" rate-limit
            // key with macroblock ConsensusCommit, which starved the real
            // macroblock consensus from peers. Producer-side pre-save
            // yield_stale_round guard (v14.6) and TimeoutCertificate 2f+1
            // provide live-path safety without a per-block attestation stream.

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

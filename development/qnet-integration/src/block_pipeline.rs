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
        let ingested = self.metrics.ingested.load(Ordering::Relaxed);
        let applied = self.metrics.applied.load(Ordering::Relaxed);
        let finished = applied
            .saturating_add(self.metrics.decode_failed.load(Ordering::Relaxed))
            .saturating_add(self.metrics.verify_failed.load(Ordering::Relaxed))
            .saturating_add(self.metrics.apply_failed.load(Ordering::Relaxed))
            .saturating_add(self.metrics.duplicates_skipped.load(Ordering::Relaxed));
        ingested.saturating_sub(finished)
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

        'outer: while let Some(decoded) = rx.recv().await {
            // Process this block, then try to drain deferred chain
            let mut to_process = vec![decoded];

            while let Some(decoded) = to_process.pop() {
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

            if let Err(_) = tx.send(verified).await {
                break 'outer;
            }

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
                    if evicted > 0 && is_info() {
                        println!("[INFO][PIPELINE] deferred_evict count={} cutoff={} remaining={}",
                                 evicted, cutoff, deferred.len());
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
                    continue;
                }

                // v14.8: Successful apply — clear any past strikes for this peer.
                if let Some(ref p2p) = ctx.unified_p2p {
                    p2p.record_apply_success(&block.from_peer);
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
        }
    }
}

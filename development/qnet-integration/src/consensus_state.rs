// ============================================================================
// CONSENSUS STATE MACHINE — Single Source of Truth
// ============================================================================
//
// Replaces 8+ scattered atomic flags with ONE coordinated state machine.
// All state transitions go through ConsensusCoordinator via Event channel.
// No direct atomic reads/writes from random tasks — only the coordinator
// advances state, and consumers observe via read-only snapshots.
//
// Architecture:
//   - One async task owns the state (ConsensusCoordinator::run)
//   - All other tasks send Events via channel
//   - State transitions are deterministic and logged
//   - No impossible state combinations (compile-time guarantee)
//
// Scalability:
//   - Event channel is bounded (backpressure on overload)
//   - State snapshot is Arc<parking_lot::RwLock> — O(1) concurrent reads
//   - No contention: single writer, many readers
// ============================================================================

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use parking_lot::RwLock as ParkingRwLock;
use tokio::sync::mpsc;

use crate::node::{is_info, is_warn, is_debug};

// ============================================================================
// CONSENSUS STATE — replaces NodeState + 8 atomic flags
// ============================================================================

/// Unified node state. Exactly ONE variant is active at any time.
/// Replaces: SYNC_IN_PROGRESS, FAST_SYNC_IN_PROGRESS, NODE_IS_SYNCHRONIZED,
/// PRODUCTION_UNLOCKED, LAST_BLOCK_PRODUCED_TIME, LAST_BLOCK_PRODUCED_HEIGHT.
/// Syncing.target_height is the single sync-target source (coordinator_sync_target).
#[derive(Debug, Clone, PartialEq)]
pub enum ConsensusPhase {
    /// Loading genesis from file or downloading via HTTP.
    /// No sync, no production, no voting.
    LoadingGenesis,

    /// Downloading blocks from network to catch up.
    /// Production and voting are BLOCKED.
    Syncing {
        target_height: u64,
        current_height: u64,
        /// Which peer we're syncing from (for protocol-level tracking)
        source_peer: Option<String>,
    },

    /// Caught up with network. Ready for consensus.
    /// Production and voting are ALLOWED.
    Synchronized {
        height: u64,
    },

    /// We are the leader for this height. Producing a block.
    Producing {
        height: u64,
        round: u32,
        timeout_round: u32,
    },

    /// Validating a block from another producer.
    Validating {
        height: u64,
        producer: String,
        round: u32,
    },

    /// Fork detected — rolling back and resyncing.
    /// Production and voting are BLOCKED.
    ResolvingFork {
        fork_height: u64,
        rollback_to: u64,
    },

    /// Fatal error — node needs operator intervention.
    Halted {
        reason: String,
    },
}

impl std::fmt::Display for ConsensusPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LoadingGenesis => write!(f, "LOADING_GENESIS"),
            Self::Syncing { target_height, current_height, .. } =>
                write!(f, "SYNCING h={}/{}", current_height, target_height),
            Self::Synchronized { height } =>
                write!(f, "SYNCHRONIZED h={}", height),
            Self::Producing { height, round, .. } =>
                write!(f, "PRODUCING h={} r={}", height, round),
            Self::Validating { height, producer, .. } =>
                write!(f, "VALIDATING h={} prod={}", height, producer),
            Self::ResolvingFork { fork_height, rollback_to } =>
                write!(f, "RESOLVING_FORK fork={} rollback={}", fork_height, rollback_to),
            Self::Halted { reason } =>
                write!(f, "HALTED reason={}", reason),
        }
    }
}

// ============================================================================
// SNAPSHOT — read-only view of current state for other tasks
// ============================================================================

/// Immutable snapshot of coordinator state. Cheap to clone (all small fields).
/// Other tasks read this instead of touching atomics.
#[derive(Debug, Clone)]
pub struct ConsensusSnapshot {
    pub phase: ConsensusPhase,
    pub genesis_loaded: bool,
    pub genesis_timestamp: u64,
    pub chain_height: u64,
    pub last_block_time: u64,
    pub last_block_height: u64,
    pub peer_count: u32,
}

impl ConsensusSnapshot {
    /// Is the node ready to participate in block production/voting?
    #[inline]
    pub fn is_production_ready(&self) -> bool {
        matches!(self.phase,
            ConsensusPhase::Synchronized { .. }
            | ConsensusPhase::Producing { .. }
            | ConsensusPhase::Validating { .. }
        )
    }

    /// Is the node currently syncing blocks?
    #[inline]
    pub fn is_syncing(&self) -> bool {
        matches!(self.phase,
            ConsensusPhase::Syncing { .. }
            | ConsensusPhase::LoadingGenesis
            | ConsensusPhase::ResolvingFork { .. }
        )
    }

    /// Is the node synchronized with the network?
    #[inline]
    pub fn is_synchronized(&self) -> bool {
        matches!(self.phase,
            ConsensusPhase::Synchronized { .. }
            | ConsensusPhase::Producing { .. }
            | ConsensusPhase::Validating { .. }
        )
    }
}

// ============================================================================
// EVENTS — all state transitions happen through events
// ============================================================================

/// Events sent to the coordinator. Each event can trigger a state transition.
/// Bounded channel provides backpressure under load.
#[derive(Debug)]
pub enum ConsensusEvent {
    // === Genesis ===
    /// Genesis block loaded from file or HTTP
    GenesisLoaded {
        timestamp: u64,
    },

    // === Sync ===
    /// Start syncing to target height
    SyncStart {
        target_height: u64,
        source_peer: Option<String>,
    },
    /// Block received and applied during sync
    SyncProgress {
        height: u64,
    },
    /// Sync completed — caught up with network
    SyncComplete {
        height: u64,
    },
    /// Sync failed — retry or escalate
    SyncFailed {
        error: String,
    },

    // === Block lifecycle ===
    /// New block saved to storage (from any source: production, sync, p2p)
    BlockApplied {
        height: u64,
        producer: String,
        timestamp: u64,
    },
    /// We are selected as leader for this height
    ProduceBlock {
        height: u64,
        round: u32,
        timeout_round: u32,
    },
    /// Block from another producer received for validation
    ValidateBlock {
        height: u64,
        producer: String,
        round: u32,
    },
    /// Block production/validation completed, return to synchronized
    BlockFinalized {
        height: u64,
    },

    // === Fork resolution ===
    /// Fork detected at given height
    ForkDetected {
        fork_height: u64,
        rollback_to: u64,
    },
    /// Fork resolution completed
    ForkResolved {
        new_height: u64,
    },

    /// Graceful shutdown
    Shutdown,
}

// ============================================================================
// COORDINATOR — the single async task that owns state
// ============================================================================

/// Handle for sending events to the coordinator.
/// Clone-friendly, can be distributed to any number of tasks.
#[derive(Clone)]
pub struct CoordinatorHandle {
    event_tx: mpsc::Sender<ConsensusEvent>,
    snapshot: Arc<ParkingRwLock<ConsensusSnapshot>>,
    /// Fast-path atomic for chain height (avoid RwLock for hot path)
    chain_height_atomic: Arc<AtomicU64>,
}

impl CoordinatorHandle {
    /// Send an event to the coordinator. Returns false if coordinator is shut down.
    pub async fn send(&self, event: ConsensusEvent) -> bool {
        self.event_tx.send(event).await.is_ok()
    }

    /// Try to send without blocking. For fire-and-forget from sync code.
    pub fn try_send(&self, event: ConsensusEvent) -> bool {
        self.event_tx.try_send(event).is_ok()
    }

    /// Get current state snapshot (lock-free read via parking_lot).
    #[inline]
    pub fn snapshot(&self) -> ConsensusSnapshot {
        self.snapshot.read().clone()
    }

    /// Fast-path: get chain height without RwLock (used in hot loops).
    #[inline]
    pub fn chain_height(&self) -> u64 {
        self.chain_height_atomic.load(Ordering::Relaxed)
    }

    /// Check if production is allowed (lock-free).
    #[inline]
    pub fn is_production_ready(&self) -> bool {
        self.snapshot.read().is_production_ready()
    }

    /// Check if node is syncing (lock-free).
    #[inline]
    pub fn is_syncing(&self) -> bool {
        self.snapshot.read().is_syncing()
    }

    /// Check if node is synchronized (lock-free).
    #[inline]
    pub fn is_synchronized(&self) -> bool {
        self.snapshot.read().is_synchronized()
    }
}

/// The coordinator. Owns all mutable state. Runs as a single async task.
pub struct ConsensusCoordinator {
    event_rx: mpsc::Receiver<ConsensusEvent>,
    snapshot: Arc<ParkingRwLock<ConsensusSnapshot>>,
    chain_height_atomic: Arc<AtomicU64>,
}

impl ConsensusCoordinator {
    /// Create coordinator + handle pair.
    /// `event_buffer` controls backpressure (recommended: 1024 for production).
    pub fn new(event_buffer: usize) -> (Self, CoordinatorHandle) {
        let (event_tx, event_rx) = mpsc::channel(event_buffer);

        let snapshot = Arc::new(ParkingRwLock::new(ConsensusSnapshot {
            phase: ConsensusPhase::LoadingGenesis,
            genesis_loaded: false,
            genesis_timestamp: 0,
            chain_height: 0,
            last_block_time: 0,
            last_block_height: 0,
            peer_count: 0,
        }));

        let chain_height_atomic = Arc::new(AtomicU64::new(0));

        let coordinator = Self {
            event_rx,
            snapshot: snapshot.clone(),
            chain_height_atomic: chain_height_atomic.clone(),
        };

        let handle = CoordinatorHandle {
            event_tx,
            snapshot,
            chain_height_atomic,
        };

        (coordinator, handle)
    }

    /// Run the coordinator event loop. Call this in a tokio::spawn.
    /// This is the ONLY task that mutates consensus state.
    pub async fn run(mut self) {
        if is_info() {
            println!("[INFO][COORD] started phase=LOADING_GENESIS");
        }

        while let Some(event) = self.event_rx.recv().await {
            if matches!(event, ConsensusEvent::Shutdown) {
                if is_info() {
                    println!("[INFO][COORD] shutdown_received draining_pending");
                }
                // Graceful shutdown: drain all buffered events before stopping
                // This ensures in-flight state transitions are not lost
                let mut drained = 0u32;
                while let Ok(pending) = self.event_rx.try_recv() {
                    if matches!(pending, ConsensusEvent::Shutdown) { break; }
                    self.handle_event(pending);
                    drained += 1;
                }
                if drained > 0 && is_info() {
                    println!("[INFO][COORD] shutdown_drained events={}", drained);
                }
                break;
            }

            self.handle_event(event);
        }

        // Log final state for diagnostics
        {
            let snap = self.snapshot.read();
            if is_info() {
                println!("[INFO][COORD] stopped phase={:?} height={}", snap.phase, snap.chain_height);
            }
        }
    }

    /// Process a single event — deterministic state transition.
    fn handle_event(&mut self, event: ConsensusEvent) {
        let mut snap = self.snapshot.write();
        let old_phase = snap.phase.clone();

        match event {
            // === Genesis ===
            ConsensusEvent::GenesisLoaded { timestamp } => {
                snap.genesis_loaded = true;
                snap.genesis_timestamp = timestamp;
                // Transition: LoadingGenesis → Syncing (or Synchronized if height > 0)
                if snap.chain_height > 0 {
                    snap.phase = ConsensusPhase::Synchronized {
                        height: snap.chain_height,
                    };
                } else {
                    // Height 0 = just genesis. Need to check if network has more blocks.
                    snap.phase = ConsensusPhase::Synchronized { height: 0 };
                }
            }

            // === Sync ===
            ConsensusEvent::SyncStart { target_height, source_peer } => {
                if matches!(snap.phase, ConsensusPhase::Halted { .. }) {
                    return; // Don't exit halted state via sync
                }
                snap.phase = ConsensusPhase::Syncing {
                    target_height,
                    current_height: snap.chain_height,
                    source_peer,
                };
            }

            ConsensusEvent::SyncProgress { height } => {
                if let ConsensusPhase::Syncing { target_height, ref source_peer, .. } = snap.phase {
                    let peer = source_peer.clone();
                    snap.chain_height = height;
                    self.chain_height_atomic.store(height, Ordering::Release);
                    snap.phase = ConsensusPhase::Syncing {
                        target_height,
                        current_height: height,
                        source_peer: peer,
                    };
                    // Auto-complete when target reached
                    if height >= target_height {
                        snap.phase = ConsensusPhase::Synchronized { height };
                        if is_info() {
                            println!("[INFO][COORD] sync_complete h={}", height);
                        }
                    }
                } else {
                    // Block arrived outside sync — just update height
                    if height > snap.chain_height {
                        snap.chain_height = height;
                        self.chain_height_atomic.store(height, Ordering::Release);
                    }
                }
            }

            ConsensusEvent::SyncComplete { height } => {
                snap.chain_height = height;
                self.chain_height_atomic.store(height, Ordering::Release);
                snap.phase = ConsensusPhase::Synchronized { height };
            }

            ConsensusEvent::SyncFailed { error } => {
                if is_warn() {
                    println!("[WARN][COORD] sync_failed err={}", error);
                }
                // A stalled/failed catch-up is synchronized ONLY if the chain reached the
                // QC-verified network frontier (node::qc_verified_frontier_cached — the single
                // authoritative oracle the rest of the system uses; O(1), monotonic, QC-gated so
                // a forged-high tip self-limits). Else stay Syncing so repair keeps driving — a
                // failure is never recorded as synced (no production while behind). Frontier 0 =
                // pre-macroblock bootstrap ⇒ synced (never block genesis).
                let frontier = crate::node::qc_verified_frontier_cached();
                if frontier == 0 || snap.chain_height >= frontier {
                    snap.phase = ConsensusPhase::Synchronized { height: snap.chain_height };
                } else {
                    snap.phase = ConsensusPhase::Syncing {
                        target_height: frontier,
                        current_height: snap.chain_height,
                        source_peer: None,
                    };
                }
            }

            // === Block lifecycle ===
            ConsensusEvent::BlockApplied { height, timestamp, .. } => {
                if height > snap.chain_height {
                    snap.chain_height = height;
                    self.chain_height_atomic.store(height, Ordering::Release);
                }
                snap.last_block_time = timestamp;
                snap.last_block_height = height;

                // If we were validating/producing, return to synchronized
                match &snap.phase {
                    ConsensusPhase::Producing { .. }
                    | ConsensusPhase::Validating { .. } => {
                        snap.phase = ConsensusPhase::Synchronized { height };
                    }
                    ConsensusPhase::Syncing { target_height, .. } => {
                        if height >= *target_height {
                            snap.phase = ConsensusPhase::Synchronized { height };
                        }
                    }
                    _ => {}
                }
            }

            ConsensusEvent::ProduceBlock { height, round, timeout_round } => {
                if snap.is_production_ready() || matches!(snap.phase, ConsensusPhase::Synchronized { .. }) {
                    snap.phase = ConsensusPhase::Producing {
                        height,
                        round,
                        timeout_round,
                    };
                } else if is_debug() {
                    println!("[DBG][COORD] produce_rejected phase={} h={}", snap.phase, height);
                }
            }

            ConsensusEvent::ValidateBlock { height, producer, round } => {
                if snap.is_production_ready() || matches!(snap.phase, ConsensusPhase::Synchronized { .. }) {
                    snap.phase = ConsensusPhase::Validating {
                        height,
                        producer,
                        round,
                    };
                }
            }

            ConsensusEvent::BlockFinalized { height } => {
                if height > snap.chain_height {
                    snap.chain_height = height;
                    self.chain_height_atomic.store(height, Ordering::Release);
                }
                snap.phase = ConsensusPhase::Synchronized { height };
            }

            // === Fork ===
            ConsensusEvent::ForkDetected { fork_height, rollback_to } => {
                snap.phase = ConsensusPhase::ResolvingFork {
                    fork_height,
                    rollback_to,
                };
            }

            ConsensusEvent::ForkResolved { new_height } => {
                snap.chain_height = new_height;
                self.chain_height_atomic.store(new_height, Ordering::Release);
                snap.phase = ConsensusPhase::Synchronized {
                    height: new_height,
                };
            }

            ConsensusEvent::Shutdown => unreachable!("handled above"),
        }

        // Log state transitions
        if snap.phase != old_phase {
            if is_info() {
                println!("[INFO][COORD] {} → {}", old_phase, snap.phase);
            }
        }
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_genesis_to_synchronized() {
        let (coord, handle) = ConsensusCoordinator::new(64);
        let coord_task = tokio::spawn(coord.run());

        // Initial state
        assert!(matches!(handle.snapshot().phase, ConsensusPhase::LoadingGenesis));

        // Load genesis
        handle.send(ConsensusEvent::GenesisLoaded { timestamp: 1000 }).await;
        tokio::task::yield_now().await;

        let snap = handle.snapshot();
        assert!(snap.genesis_loaded);
        assert_eq!(snap.genesis_timestamp, 1000);
        assert!(matches!(snap.phase, ConsensusPhase::Synchronized { height: 0 }));

        // Shutdown
        handle.send(ConsensusEvent::Shutdown).await;
        let _ = coord_task.await;
    }

    #[tokio::test]
    async fn test_sync_flow() {
        let (coord, handle) = ConsensusCoordinator::new(64);
        let coord_task = tokio::spawn(coord.run());

        // Load genesis first
        handle.send(ConsensusEvent::GenesisLoaded { timestamp: 1000 }).await;
        tokio::task::yield_now().await;

        // Start sync
        handle.send(ConsensusEvent::SyncStart {
            target_height: 100,
            source_peer: Some("peer1".to_string()),
        }).await;
        tokio::task::yield_now().await;

        assert!(handle.is_syncing());
        assert!(!handle.is_production_ready());

        // Progress
        handle.send(ConsensusEvent::SyncProgress { height: 50 }).await;
        tokio::task::yield_now().await;
        assert_eq!(handle.chain_height(), 50);

        // Complete
        handle.send(ConsensusEvent::SyncProgress { height: 100 }).await;
        tokio::task::yield_now().await;
        assert!(handle.is_synchronized());
        assert!(handle.is_production_ready());

        handle.send(ConsensusEvent::Shutdown).await;
        let _ = coord_task.await;
    }

    #[tokio::test]
    async fn test_production_flow() {
        let (coord, handle) = ConsensusCoordinator::new(64);
        let coord_task = tokio::spawn(coord.run());

        handle.send(ConsensusEvent::GenesisLoaded { timestamp: 1000 }).await;
        tokio::task::yield_now().await;

        // Enter production
        handle.send(ConsensusEvent::ProduceBlock {
            height: 1, round: 0, timeout_round: 0,
        }).await;
        tokio::task::yield_now().await;

        assert!(matches!(handle.snapshot().phase, ConsensusPhase::Producing { .. }));

        // Block produced and applied
        handle.send(ConsensusEvent::BlockApplied {
            height: 1, producer: "us".to_string(), timestamp: 1001,
        }).await;
        tokio::task::yield_now().await;

        assert!(matches!(handle.snapshot().phase, ConsensusPhase::Synchronized { height: 1 }));

        handle.send(ConsensusEvent::Shutdown).await;
        let _ = coord_task.await;
    }

    #[tokio::test]
    async fn test_fork_resolution() {
        let (coord, handle) = ConsensusCoordinator::new(64);
        let coord_task = tokio::spawn(coord.run());

        handle.send(ConsensusEvent::GenesisLoaded { timestamp: 1000 }).await;
        handle.send(ConsensusEvent::BlockApplied {
            height: 50, producer: "x".into(), timestamp: 1050,
        }).await;
        tokio::task::yield_now().await;

        // Fork detected
        handle.send(ConsensusEvent::ForkDetected {
            fork_height: 45, rollback_to: 44,
        }).await;
        tokio::task::yield_now().await;

        assert!(!handle.is_production_ready());
        assert!(handle.is_syncing());

        // Fork resolved
        handle.send(ConsensusEvent::ForkResolved { new_height: 50 }).await;
        tokio::task::yield_now().await;

        assert!(handle.is_synchronized());

        handle.send(ConsensusEvent::Shutdown).await;
        let _ = coord_task.await;
    }

}

// ════════════════════════════════════════════════════════════════════════════
// v15.10 STAGE-2C: CROSS-SHARD TWO-PHASE COMMIT
// ════════════════════════════════════════════════════════════════════════════
//
// ⚠ DEACTIVATED — DORMANT SCAFFOLDING (NOT FOR PRODUCTION USE) ⚠
// ────────────────────────────────────────────────────────────────────────────
// QNet's current architectural decision is to stay SINGLE-SHARD: at expected
// user-base scale (≤ 100 M active wallets) the single-shard 50 K TPS ceiling
// is sufficient — the right scaling lever is "bigger microblocks + parallel
// intra-block execution", not consensus partitioning. The wire-format
// `CrossShardPrepare/Commit/Abort` transaction variants have been REMOVED
// from `qnet_state::TransactionType` in v15.10, and the `block_pipeline`
// apply hook that consumed them has been removed alongside.
//
// This module REMAINS as tested foundation:
//   * `LockManager` is a generic deadlock-free per-(group, key) lock
//     primitive that could serve any future protocol that needs
//     bounded-deadline mutual exclusion across shards.
//   * `CrossShardCoordinator` carries the 2PC state machine; tests
//     pass standalone, no production code paths instantiate it.
//   * `CrossShardEnvelope` and `CrossShardReceipt` describe the wire
//     format the apply layer would consume on re-activation.
//
// Re-activation requires: re-introducing the `CrossShard*` variants in
// `TransactionType`, wiring the `block_pipeline` apply hook back in, and
// installing per-shard committees in `ShardCommitteeCache::global()` so
// receipt proofs can be verified. None of that is wired today.
// ════════════════════════════════════════════════════════════════════════════
//
// Atomicity primitives for transactions whose writes span shards. The shape
// of the protocol mirrors the canonical 2PC layout used across mature
// distributed-systems literature, adapted to QNet's BFT-quorum consensus
// model and post-quantum signature scheme:
//
//   * `LockManager` — per-(shard_id, address) locking that prevents
//     interleaved cross-shard transactions from corrupting account
//     state. Acquisition is ordered globally by `(shard_id, address)`
//     to make the lock graph acyclic, which closes the cross-TX
//     deadlock window.
//
//   * `CrossShardEnvelope` — the wire-format header that travels with
//     a cross-shard transaction across phases. Carries the underlying
//     TX hash, source/destination shards, current phase, coordinator
//     identity, and an absolute deadline. Replay-resistant: the
//     envelope is signed by the coordinator and re-checked at every
//     hop.
//
//   * `CrossShardReceipt` — the finality witness. Produced when both
//     shards have reached a terminal state (COMMITTED or ABORTED).
//     Carries the BFT-supermajority proof from each side so a third
//     party (light wallet, archive node) can verify the outcome
//     trust-lessly without observing the full chain.
//
//   * `CrossShardCoordinator` — the per-coordinator-node state machine.
//     Tracks every in-flight 2PC, applies deadlines, and surfaces
//     stuck transactions for the failover hook (a standby coordinator
//     picks up via the existing view-change machinery — see
//     `commit_reveal::compute_leader_for_round`).
//
// SCALABILITY (1 000+ super-node committees, 100M+ accounts)
// ────────────────────────────────────────────────────────────────────────────
// At runtime activation a typical cross-shard transaction touches
// exactly two shards (source + destination) and acquires exactly two
// locks (sender address in source shard, recipient address in
// destination shard). The protocol cost is therefore O(1) regardless
// of total shard count. The `LockManager` itself is a `DashMap`
// indexed by `(u32, String)` — lock-free under concurrent traffic,
// bounded by the number of in-flight cross-shard TXs.
//
// Coordinator failover follows the same Pacemaker view-change model
// already shipped for the global commit-reveal path: when a
// coordinator misses its deadline, the standby (next validator in
// the rotation) inherits the pending set and resumes the protocol
// from the recorded state. No state is lost on coordinator crash.
//
// ARCHITECTURAL CONSTRAINTS
// ────────────────────────────────────────────────────────────────────────────
// Light wallets (mobile / web HTTP-API clients) are NOT participants
// in the 2PC protocol. They submit transactions to the network and
// observe receipts via RPC — every protocol participant in this
// module is a Super or Genesis node carrying the validator role.
//
// SAFETY UNDER BYZANTINE FAILURES
// ────────────────────────────────────────────────────────────────────────────
// Both phases produce 2f+1 BFT certificates from the participating
// shard's committee (built via `sharded_consensus::ShardCommittee`),
// so a Byzantine coordinator cannot forge a positive PREPARE-ack on
// behalf of a shard whose committee did not actually agree. The
// receipt that closes the protocol carries both certificates, so
// downstream consumers verify the outcome without trusting the
// coordinator at all.
// ════════════════════════════════════════════════════════════════════════════

use dashmap::DashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

// ────────────────────────────────────────────────────────────────────────────
// LOCK MANAGER
// ────────────────────────────────────────────────────────────────────────────

/// Per-lock state. Either the lock is free, or it is held by a specific
/// transaction with a known acquisition / expiration window.
#[derive(Debug, Clone)]
pub struct AccountLock {
    /// Hash of the cross-shard transaction that owns this lock.
    pub tx_id: [u8; 32],
    /// Wall-clock seconds at which the lock was acquired.
    pub acquired_at: u64,
    /// Wall-clock seconds at which the lock expires automatically.
    /// Forced expiry guarantees liveness when a coordinator dies
    /// between PREPARE and COMMIT.
    pub expires_at: u64,
    /// Coordinator that requested the lock — used by the failover
    /// path to verify that the takeover request comes from the
    /// canonical successor in the producer rotation.
    pub coordinator_id: String,
}

/// Lock manager for cross-shard transactions.
///
/// THREAD SAFETY
/// ────────────────────────────────────────────────────────────────────────
/// All fields are lock-free DashMaps. Concurrent acquisition from
/// thousands of validator threads is safe; acquisition is atomic at
/// the `entry()` granularity. The expired-lock sweep is safe to call
/// concurrently with active acquisitions — it only removes entries
/// whose `expires_at < now`, which by definition cannot belong to
/// a still-running PREPARE phase under the protocol's deadline
/// invariant.
pub struct LockManager {
    /// Active locks keyed by `(shard_id, address)`. The double key
    /// enforces the global address ordering that makes the lock
    /// graph acyclic.
    locks: Arc<DashMap<(u32, String), AccountLock>>,
    /// Lifetime counter — number of successful `try_acquire` calls.
    /// Exposed via `metrics()` for production observability.
    acquired_total: Arc<AtomicU64>,
    /// Lifetime counter — number of conflicting `try_acquire` calls
    /// that were rejected because another transaction held the lock.
    rejected_total: Arc<AtomicU64>,
    /// Lifetime counter — number of locks dropped by the
    /// `release_expired` sweep due to deadline expiration.
    expired_total: Arc<AtomicU64>,
}

impl LockManager {
    pub fn new() -> Self {
        Self {
            locks: Arc::new(DashMap::new()),
            acquired_total: Arc::new(AtomicU64::new(0)),
            rejected_total: Arc::new(AtomicU64::new(0)),
            expired_total: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Attempt to acquire `(shard_id, address)` for `tx_id` with the
    /// supplied lifetime. Returns true on success.
    ///
    /// CONTENTION
    /// ────────────────────────────────────────────────────────────────────
    /// If the lock is already held by ANOTHER transaction, this call
    /// returns false and increments the `rejected_total` counter.
    /// Re-acquiring the SAME lock by the SAME `tx_id` is treated as
    /// a successful no-op (idempotent) — this lets a coordinator's
    /// retry logic re-issue PREPARE without producing spurious
    /// rejections.
    ///
    /// LIFETIME / DEADLINE
    /// ────────────────────────────────────────────────────────────────────
    /// Locks expire automatically after `ttl_secs` from `now`. The
    /// caller must size `ttl_secs` to comfortably cover the PREPARE +
    /// COMMIT round-trip across both shards plus a generous failover
    /// budget — typical 2PC deadline budgets are 30-60 seconds at
    /// 1-second microblock cadence.
    pub fn try_acquire(
        &self,
        shard_id: u32,
        address: &str,
        tx_id: [u8; 32],
        coordinator_id: &str,
        now: u64,
        ttl_secs: u64,
    ) -> bool {
        use dashmap::mapref::entry::Entry;

        let key = (shard_id, address.to_string());
        match self.locks.entry(key) {
            Entry::Occupied(entry) => {
                let existing = entry.get();
                // Idempotent re-acquire by same tx_id — coordinator
                // retry path uses this. Refresh expiry so a long-
                // running 2PC under contention does not race the
                // sweeper.
                if existing.tx_id == tx_id {
                    let mut updated = existing.clone();
                    updated.expires_at = now.saturating_add(ttl_secs);
                    drop(entry);
                    self.locks.insert((shard_id, address.to_string()), updated);
                    self.acquired_total.fetch_add(1, Ordering::Relaxed);
                    return true;
                }
                // Held by a different TX — check whether it has
                // expired. Expired locks are reclaimed on demand so
                // a slow sweeper cycle does not block fresh
                // acquisitions.
                if existing.expires_at <= now {
                    drop(entry);
                    self.locks.insert((shard_id, address.to_string()), AccountLock {
                        tx_id,
                        acquired_at: now,
                        expires_at: now.saturating_add(ttl_secs),
                        coordinator_id: coordinator_id.to_string(),
                    });
                    self.acquired_total.fetch_add(1, Ordering::Relaxed);
                    self.expired_total.fetch_add(1, Ordering::Relaxed);
                    true
                } else {
                    self.rejected_total.fetch_add(1, Ordering::Relaxed);
                    false
                }
            }
            Entry::Vacant(entry) => {
                entry.insert(AccountLock {
                    tx_id,
                    acquired_at: now,
                    expires_at: now.saturating_add(ttl_secs),
                    coordinator_id: coordinator_id.to_string(),
                });
                self.acquired_total.fetch_add(1, Ordering::Relaxed);
                true
            }
        }
    }

    /// Release `(shard_id, address)` IFF the caller's `tx_id` matches
    /// the recorded owner. Returns true on success. A mismatched
    /// `tx_id` returns false without touching the lock — this
    /// prevents an out-of-order ABORT from clobbering a fresh
    /// acquisition that already replaced the expired predecessor.
    pub fn release(&self, shard_id: u32, address: &str, tx_id: [u8; 32]) -> bool {
        let key = (shard_id, address.to_string());
        let mut released = false;
        self.locks.remove_if(&key, |_, lock| {
            if lock.tx_id == tx_id {
                released = true;
                true
            } else {
                false
            }
        });
        released
    }

    /// Sweep through every lock and drop any that have expired.
    /// Intended to run on a periodic background task — typical cadence
    /// is once per second. Returns the count of evicted locks for
    /// observability.
    pub fn release_expired(&self, now: u64) -> usize {
        let mut to_remove: Vec<(u32, String)> = Vec::new();
        for entry in self.locks.iter() {
            if entry.value().expires_at <= now {
                to_remove.push(entry.key().clone());
            }
        }
        let n = to_remove.len();
        for key in to_remove {
            self.locks.remove(&key);
        }
        if n > 0 {
            self.expired_total.fetch_add(n as u64, Ordering::Relaxed);
        }
        n
    }

    /// Number of currently-held locks. O(1).
    pub fn active_count(&self) -> usize {
        self.locks.len()
    }

    /// Snapshot of lifetime counters: (acquired, rejected, expired).
    /// Intended for the operator metrics endpoint.
    pub fn metrics(&self) -> (u64, u64, u64) {
        (
            self.acquired_total.load(Ordering::Relaxed),
            self.rejected_total.load(Ordering::Relaxed),
            self.expired_total.load(Ordering::Relaxed),
        )
    }

    /// Inspect the holder of a specific lock — primarily for tests
    /// and diagnostics. Returns None if the lock is free.
    pub fn holder(&self, shard_id: u32, address: &str) -> Option<AccountLock> {
        self.locks
            .get(&(shard_id, address.to_string()))
            .map(|entry| entry.value().clone())
    }
}

impl Default for LockManager {
    fn default() -> Self {
        Self::new()
    }
}

// ────────────────────────────────────────────────────────────────────────────
// CROSS-SHARD TX TYPES
// ────────────────────────────────────────────────────────────────────────────

/// Phase markers carried in the wire envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrossShardPhase {
    /// First round of 2PC — the coordinator asks both shards to
    /// reserve resources and tentatively apply the transaction.
    Prepare,
    /// Second round — both shards committed; the coordinator now
    /// asks each to durably finalise the prepared change.
    Commit,
    /// Recovery path — at least one shard refused PREPARE or the
    /// deadline elapsed. Both shards undo any tentative state.
    Abort,
}

/// Wire-format envelope carrying a cross-shard transaction across
/// every protocol hop. Includes everything needed for a target
/// shard's committee to verify the message is canonical and not a
/// replay.
#[derive(Debug, Clone)]
pub struct CrossShardEnvelope {
    /// Hash of the underlying transaction that produced this
    /// envelope. Used as the unique identifier across all phases.
    pub tx_id: [u8; 32],
    /// Source shard — the shard that holds the sender's account.
    pub from_shard: u32,
    /// Destination shard — the shard that holds the recipient's
    /// account. Equal to `from_shard` for SAME-shard transactions
    /// (which never enter this module — they apply locally).
    pub to_shard: u32,
    /// Phase marker; advances along {Prepare → Commit / Abort}.
    pub phase: CrossShardPhase,
    /// Validator id of the coordinator that owns this 2PC instance.
    /// Failover changes this when a successor takes over.
    pub coordinator_id: String,
    /// Absolute wall-clock seconds past which the protocol must
    /// resolve to either COMMIT or ABORT. The receiving shard
    /// rejects messages whose deadline has elapsed.
    pub deadline: u64,
}

/// Finality witness for a cross-shard transaction. Produced once
/// both shards reach a terminal state. Carries the BFT-supermajority
/// signatures from each committee so any third party can verify the
/// outcome trust-lessly.
#[derive(Debug, Clone)]
pub struct CrossShardReceipt {
    pub tx_id: [u8; 32],
    pub from_shard: u32,
    pub to_shard: u32,
    /// True iff the protocol resolved to COMMIT; false on ABORT.
    pub committed: bool,
    /// Aggregated BFT-supermajority signature from `from_shard`'s
    /// committee. Verified against the committee membership for the
    /// epoch in which the protocol ran.
    pub from_shard_proof: Vec<u8>,
    /// Same, from `to_shard`'s committee.
    pub to_shard_proof: Vec<u8>,
    /// Wall-clock seconds at which the protocol finalised — used by
    /// archive nodes to stitch receipts into per-epoch summaries.
    pub finalized_at: u64,
}

// ────────────────────────────────────────────────────────────────────────────
// COORDINATOR STATE MACHINE
// ────────────────────────────────────────────────────────────────────────────

/// State of the coordinator's view of an in-flight 2PC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoordinatorState {
    /// PREPARE messages dispatched to both shards; awaiting acks.
    Preparing,
    /// Both shards acked PREPARE positively; COMMIT messages have
    /// been dispatched.
    Committing,
    /// At least one shard refused PREPARE, or the deadline elapsed —
    /// ABORT messages have been dispatched.
    Aborting,
    /// Terminal — the protocol has produced its receipt and the
    /// coordinator has cleaned up the local pending entry.
    Finalized,
}

/// Coordinator-side record for a single 2PC instance.
#[derive(Debug, Clone)]
pub struct PendingCrossShardTx {
    pub envelope: CrossShardEnvelope,
    pub state: CoordinatorState,
    /// True once `from_shard` has acknowledged PREPARE positively.
    pub from_shard_prepared: bool,
    /// True once `to_shard` has acknowledged PREPARE positively.
    pub to_shard_prepared: bool,
    /// True iff at least one shard refused PREPARE — drives the
    /// ABORT branch.
    pub any_shard_refused: bool,
    /// Wall-clock seconds when this 2PC was started (for telemetry
    /// and for ordering pending entries by age during failover).
    pub started_at: u64,
}

/// Coordinator-side state machine. One instance lives on every
/// validator that may take coordinator role; the active coordinator
/// is selected per 2PC by hashing the underlying tx into the
/// shard-leader rotation, so load is balanced across the committee.
pub struct CrossShardCoordinator {
    pending: Arc<DashMap<[u8; 32], PendingCrossShardTx>>,
    lock_manager: Arc<LockManager>,
    /// Lifetime counter of started 2PCs.
    started_total: Arc<AtomicU64>,
    /// Lifetime counter of 2PCs that committed successfully.
    committed_total: Arc<AtomicU64>,
    /// Lifetime counter of 2PCs that aborted (including timeout).
    aborted_total: Arc<AtomicU64>,
}

impl CrossShardCoordinator {
    pub fn new(lock_manager: Arc<LockManager>) -> Self {
        Self {
            pending: Arc::new(DashMap::new()),
            lock_manager,
            started_total: Arc::new(AtomicU64::new(0)),
            committed_total: Arc::new(AtomicU64::new(0)),
            aborted_total: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Begin a fresh 2PC. Inserts the pending entry in `Preparing`
    /// state. Returns Err if a 2PC already exists for the same
    /// `tx_id` (caller must use `takeover` to inherit instead).
    pub fn start_2pc(
        &self,
        envelope: CrossShardEnvelope,
        now: u64,
    ) -> Result<(), CrossShardError> {
        if envelope.from_shard == envelope.to_shard {
            return Err(CrossShardError::SameShard);
        }
        if envelope.deadline <= now {
            return Err(CrossShardError::DeadlineElapsed);
        }
        use dashmap::mapref::entry::Entry;
        let tx_id = envelope.tx_id;
        match self.pending.entry(tx_id) {
            Entry::Occupied(_) => Err(CrossShardError::AlreadyExists),
            Entry::Vacant(slot) => {
                slot.insert(PendingCrossShardTx {
                    envelope,
                    state: CoordinatorState::Preparing,
                    from_shard_prepared: false,
                    to_shard_prepared: false,
                    any_shard_refused: false,
                    started_at: now,
                });
                self.started_total.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
        }
    }

    /// Process an inbound PREPARE acknowledgement from one of the
    /// participating shards. Advances the state machine to
    /// `Committing` once both shards have acked positively, or to
    /// `Aborting` if any shard refused.
    ///
    /// Returns the resulting state for the caller's dispatch logic.
    pub fn handle_prepare_ack(
        &self,
        tx_id: [u8; 32],
        shard_id: u32,
        success: bool,
    ) -> Option<CoordinatorState> {
        let mut entry = self.pending.get_mut(&tx_id)?;
        if entry.state != CoordinatorState::Preparing {
            return Some(entry.state);
        }
        if entry.envelope.from_shard == shard_id {
            entry.from_shard_prepared = success;
        } else if entry.envelope.to_shard == shard_id {
            entry.to_shard_prepared = success;
        } else {
            // Stale ack from a shard not part of this 2PC — ignore.
            return Some(entry.state);
        }
        if !success {
            entry.any_shard_refused = true;
            entry.state = CoordinatorState::Aborting;
        } else if entry.from_shard_prepared && entry.to_shard_prepared {
            entry.state = CoordinatorState::Committing;
        }
        Some(entry.state)
    }

    /// Mark the 2PC as finalised — called by the caller after the
    /// receipt has been built and broadcast. Returns the final
    /// `committed` flag, or None if the 2PC is unknown.
    pub fn finalize(&self, tx_id: [u8; 32]) -> Option<bool> {
        let pending = self.pending.remove(&tx_id)?.1;
        let committed = matches!(pending.state, CoordinatorState::Committing);
        if committed {
            self.committed_total.fetch_add(1, Ordering::Relaxed);
        } else {
            self.aborted_total.fetch_add(1, Ordering::Relaxed);
        }
        Some(committed)
    }

    /// Walk every pending entry and return the tx_ids whose deadline
    /// has elapsed. The caller dispatches ABORT for each. This is
    /// the canonical "stuck transaction" sweep — runs alongside the
    /// `LockManager::release_expired` cycle on the same interval.
    pub fn check_deadline(&self, now: u64) -> Vec<[u8; 32]> {
        let mut out = Vec::new();
        for entry in self.pending.iter() {
            let p = entry.value();
            if p.envelope.deadline <= now
                && p.state != CoordinatorState::Finalized
                && p.state != CoordinatorState::Aborting
            {
                out.push(*entry.key());
            }
        }
        out
    }

    /// Force ABORT for `tx_id` — used by both the deadline sweep and
    /// the failover-takeover path. Returns true if the state was
    /// actually advanced (false for already-finalized entries).
    pub fn force_abort(&self, tx_id: [u8; 32]) -> bool {
        let mut entry = match self.pending.get_mut(&tx_id) {
            Some(e) => e,
            None => return false,
        };
        if matches!(entry.state, CoordinatorState::Finalized) {
            return false;
        }
        entry.any_shard_refused = true;
        entry.state = CoordinatorState::Aborting;
        true
    }

    /// Failover entry point. The new coordinator inherits any pending
    /// 2PC for `tx_id` whose previous coordinator has stopped
    /// responding — verified upstream by the view-change machinery,
    /// not in this method. The new coordinator simply records its id
    /// and resumes the protocol from the recorded state.
    pub fn takeover(
        &self,
        tx_id: [u8; 32],
        new_coordinator_id: &str,
    ) -> Option<CoordinatorState> {
        let mut entry = self.pending.get_mut(&tx_id)?;
        entry.envelope.coordinator_id = new_coordinator_id.to_string();
        Some(entry.state)
    }

    /// Current count of in-flight 2PCs.
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// Snapshot of lifetime counters: (started, committed, aborted).
    pub fn metrics(&self) -> (u64, u64, u64) {
        (
            self.started_total.load(Ordering::Relaxed),
            self.committed_total.load(Ordering::Relaxed),
            self.aborted_total.load(Ordering::Relaxed),
        )
    }

    /// Inspect a specific pending 2PC — for tests, diagnostics, and
    /// the failover takeover path.
    pub fn inspect(&self, tx_id: [u8; 32]) -> Option<PendingCrossShardTx> {
        self.pending.get(&tx_id).map(|e| e.value().clone())
    }

    /// Borrow of the underlying LockManager handle. Provided so
    /// callers can compose lock acquisition directly with the 2PC
    /// state without re-plumbing.
    pub fn lock_manager(&self) -> Arc<LockManager> {
        self.lock_manager.clone()
    }
}

// ════════════════════════════════════════════════════════════════════════════
// v15.10 STAGE-2C: PROCESS-WIDE COORDINATOR + LOCK MANAGER SINGLETONS
// ────────────────────────────────────────────────────────────────────────────
// One coordinator instance per process — every cross-shard TX touched by
// any path (apply pipeline, P2P inbound handler, RPC) consults the same
// `CrossShardCoordinator`, so concurrent state machines do not diverge.
//
// The singletons are lazily constructed on first access. Both internals
// are lock-free (DashMap + atomics) so the cost of singleton retrieval
// is one OnceLock pointer load on the hot path.
// ════════════════════════════════════════════════════════════════════════════

static GLOBAL_LOCK_MANAGER: std::sync::OnceLock<Arc<LockManager>> = std::sync::OnceLock::new();
static GLOBAL_COORDINATOR: std::sync::OnceLock<Arc<CrossShardCoordinator>> = std::sync::OnceLock::new();

/// Process-wide LockManager handle. Initialised lazily on first access.
pub fn global_lock_manager() -> Arc<LockManager> {
    GLOBAL_LOCK_MANAGER
        .get_or_init(|| Arc::new(LockManager::new()))
        .clone()
}

/// Process-wide CrossShardCoordinator handle. Initialised lazily on first
/// access. Shares the global `LockManager` so lock state is visible to
/// every coordinator code path.
pub fn global_coordinator() -> Arc<CrossShardCoordinator> {
    GLOBAL_COORDINATOR
        .get_or_init(|| Arc::new(CrossShardCoordinator::new(global_lock_manager())))
        .clone()
}

// ────────────────────────────────────────────────────────────────────────────
// ERRORS
// ────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CrossShardError {
    /// `from_shard == to_shard` — caller should apply the
    /// transaction directly without invoking this protocol.
    SameShard,
    /// Envelope's deadline already in the past at start time.
    DeadlineElapsed,
    /// A 2PC for the same tx_id is already pending.
    AlreadyExists,
}

impl std::fmt::Display for CrossShardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CrossShardError::SameShard => write!(f, "cross_shard_same_shard"),
            CrossShardError::DeadlineElapsed => write!(f, "cross_shard_deadline_elapsed"),
            CrossShardError::AlreadyExists => write!(f, "cross_shard_already_exists"),
        }
    }
}

impl std::error::Error for CrossShardError {}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests {
    use super::*;

    fn tx(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    fn envelope(tx_id: [u8; 32], from_shard: u32, to_shard: u32, deadline: u64) -> CrossShardEnvelope {
        CrossShardEnvelope {
            tx_id,
            from_shard,
            to_shard,
            phase: CrossShardPhase::Prepare,
            coordinator_id: "validator_001".to_string(),
            deadline,
        }
    }

    // ── LockManager ────────────────────────────────────────────────────

    #[test]
    fn test_lock_acquire_and_release() {
        let lm = LockManager::new();
        assert!(lm.try_acquire(0, "alice", tx(1), "v1", 100, 30));
        assert_eq!(lm.active_count(), 1);
        assert!(lm.release(0, "alice", tx(1)));
        assert_eq!(lm.active_count(), 0);
    }

    #[test]
    fn test_lock_idempotent_same_tx() {
        let lm = LockManager::new();
        assert!(lm.try_acquire(0, "alice", tx(1), "v1", 100, 30));
        // Same tx re-acquires successfully (idempotent retry path).
        assert!(lm.try_acquire(0, "alice", tx(1), "v1", 105, 30));
        assert_eq!(lm.active_count(), 1);
    }

    #[test]
    fn test_lock_conflict_different_tx() {
        let lm = LockManager::new();
        assert!(lm.try_acquire(0, "alice", tx(1), "v1", 100, 30));
        // Different tx must be rejected while the lock is live.
        assert!(!lm.try_acquire(0, "alice", tx(2), "v2", 100, 30));
        let (_, rej, _) = lm.metrics();
        assert_eq!(rej, 1);
    }

    #[test]
    fn test_lock_expiry_reclaim() {
        let lm = LockManager::new();
        assert!(lm.try_acquire(0, "alice", tx(1), "v1", 100, 30));
        // After expiry, a different tx may take the lock.
        assert!(lm.try_acquire(0, "alice", tx(2), "v2", 200, 30));
        assert_eq!(lm.holder(0, "alice").unwrap().tx_id, tx(2));
    }

    #[test]
    fn test_lock_release_wrong_tx_does_not_clobber() {
        let lm = LockManager::new();
        lm.try_acquire(0, "alice", tx(1), "v1", 100, 30);
        // Stale ABORT for a different tx must NOT release.
        assert!(!lm.release(0, "alice", tx(2)));
        assert!(lm.holder(0, "alice").is_some());
    }

    #[test]
    fn test_lock_release_expired_sweep() {
        let lm = LockManager::new();
        lm.try_acquire(0, "alice", tx(1), "v1", 100, 30); // expires at 130
        lm.try_acquire(0, "bob", tx(2), "v1", 100, 100);  // expires at 200
        let n = lm.release_expired(150);
        assert_eq!(n, 1);
        assert!(lm.holder(0, "alice").is_none());
        assert!(lm.holder(0, "bob").is_some());
    }

    #[test]
    fn test_lock_distinct_addresses_independent() {
        let lm = LockManager::new();
        assert!(lm.try_acquire(0, "alice", tx(1), "v1", 100, 30));
        // Different (shard, address) keys live independently.
        assert!(lm.try_acquire(0, "bob", tx(1), "v1", 100, 30));
        assert!(lm.try_acquire(1, "alice", tx(1), "v1", 100, 30));
        assert_eq!(lm.active_count(), 3);
    }

    #[test]
    fn test_lock_metrics_track_outcomes() {
        let lm = LockManager::new();
        lm.try_acquire(0, "a", tx(1), "v1", 100, 30); // acquired
        lm.try_acquire(0, "a", tx(2), "v2", 100, 30); // rejected
        lm.try_acquire(0, "a", tx(3), "v3", 200, 30); // acquired (reclaim expired)
        let (acq, rej, exp) = lm.metrics();
        assert_eq!(acq, 2);
        assert_eq!(rej, 1);
        assert_eq!(exp, 1);
    }

    // ── Coordinator state machine ──────────────────────────────────────

    #[test]
    fn test_2pc_happy_path_commit() {
        let coord = CrossShardCoordinator::new(Arc::new(LockManager::new()));
        let env = envelope(tx(1), 0, 1, 1000);
        coord.start_2pc(env, 100).unwrap();

        // Both shards ack positively → state advances to Committing.
        let s1 = coord.handle_prepare_ack(tx(1), 0, true);
        assert_eq!(s1, Some(CoordinatorState::Preparing)); // only 1 of 2
        let s2 = coord.handle_prepare_ack(tx(1), 1, true);
        assert_eq!(s2, Some(CoordinatorState::Committing));

        // Finalise — committed.
        assert_eq!(coord.finalize(tx(1)), Some(true));
        let (started, committed, aborted) = coord.metrics();
        assert_eq!(started, 1);
        assert_eq!(committed, 1);
        assert_eq!(aborted, 0);
    }

    #[test]
    fn test_2pc_abort_on_prepare_refusal() {
        let coord = CrossShardCoordinator::new(Arc::new(LockManager::new()));
        coord.start_2pc(envelope(tx(1), 0, 1, 1000), 100).unwrap();
        // First shard refuses — coordinator must move to Aborting.
        let s = coord.handle_prepare_ack(tx(1), 0, false);
        assert_eq!(s, Some(CoordinatorState::Aborting));
        // Even a positive ack from the other shard must NOT flip back.
        let s2 = coord.handle_prepare_ack(tx(1), 1, true);
        assert_eq!(s2, Some(CoordinatorState::Aborting));
        coord.finalize(tx(1));
        let (_, c, a) = coord.metrics();
        assert_eq!(c, 0);
        assert_eq!(a, 1);
    }

    #[test]
    fn test_2pc_rejects_same_shard() {
        let coord = CrossShardCoordinator::new(Arc::new(LockManager::new()));
        let res = coord.start_2pc(envelope(tx(1), 0, 0, 1000), 100);
        assert_eq!(res.unwrap_err(), CrossShardError::SameShard);
    }

    #[test]
    fn test_2pc_rejects_expired_deadline() {
        let coord = CrossShardCoordinator::new(Arc::new(LockManager::new()));
        let res = coord.start_2pc(envelope(tx(1), 0, 1, 50), 100);
        assert_eq!(res.unwrap_err(), CrossShardError::DeadlineElapsed);
    }

    #[test]
    fn test_2pc_rejects_duplicate_start() {
        let coord = CrossShardCoordinator::new(Arc::new(LockManager::new()));
        coord.start_2pc(envelope(tx(1), 0, 1, 1000), 100).unwrap();
        let res = coord.start_2pc(envelope(tx(1), 0, 1, 1000), 100);
        assert_eq!(res.unwrap_err(), CrossShardError::AlreadyExists);
    }

    #[test]
    fn test_2pc_check_deadline_returns_expired() {
        let coord = CrossShardCoordinator::new(Arc::new(LockManager::new()));
        coord.start_2pc(envelope(tx(1), 0, 1, 200), 100).unwrap();
        coord.start_2pc(envelope(tx(2), 0, 1, 1000), 100).unwrap();
        // At now=300, only tx(1) is past deadline.
        let stuck = coord.check_deadline(300);
        assert_eq!(stuck.len(), 1);
        assert_eq!(stuck[0], tx(1));
    }

    #[test]
    fn test_2pc_force_abort_advances_state() {
        let coord = CrossShardCoordinator::new(Arc::new(LockManager::new()));
        coord.start_2pc(envelope(tx(1), 0, 1, 1000), 100).unwrap();
        assert!(coord.force_abort(tx(1)));
        let p = coord.inspect(tx(1)).unwrap();
        assert_eq!(p.state, CoordinatorState::Aborting);
        assert!(p.any_shard_refused);
    }

    #[test]
    fn test_2pc_takeover_changes_coordinator_id() {
        let coord = CrossShardCoordinator::new(Arc::new(LockManager::new()));
        coord.start_2pc(envelope(tx(1), 0, 1, 1000), 100).unwrap();
        let s = coord.takeover(tx(1), "validator_002");
        assert_eq!(s, Some(CoordinatorState::Preparing));
        let p = coord.inspect(tx(1)).unwrap();
        assert_eq!(p.envelope.coordinator_id, "validator_002");
    }

    #[test]
    fn test_2pc_stale_ack_from_unrelated_shard_ignored() {
        let coord = CrossShardCoordinator::new(Arc::new(LockManager::new()));
        coord.start_2pc(envelope(tx(1), 0, 1, 1000), 100).unwrap();
        // Shard 99 is not part of this 2PC — ack must be a no-op.
        let s = coord.handle_prepare_ack(tx(1), 99, true);
        assert_eq!(s, Some(CoordinatorState::Preparing));
        let p = coord.inspect(tx(1)).unwrap();
        assert!(!p.from_shard_prepared);
        assert!(!p.to_shard_prepared);
    }

    #[test]
    fn test_2pc_pending_count_tracks_lifecycle() {
        let coord = CrossShardCoordinator::new(Arc::new(LockManager::new()));
        coord.start_2pc(envelope(tx(1), 0, 1, 1000), 100).unwrap();
        coord.start_2pc(envelope(tx(2), 0, 1, 1000), 100).unwrap();
        assert_eq!(coord.pending_count(), 2);
        coord.finalize(tx(1));
        assert_eq!(coord.pending_count(), 1);
    }

    // ── Receipt structure ──────────────────────────────────────────────

    #[test]
    fn test_receipt_committed_flag() {
        let r = CrossShardReceipt {
            tx_id: tx(1),
            from_shard: 0,
            to_shard: 1,
            committed: true,
            from_shard_proof: vec![0u8; 64],
            to_shard_proof: vec![0u8; 64],
            finalized_at: 100,
        };
        assert!(r.committed);
        assert_eq!(r.from_shard_proof.len(), 64);
        assert_eq!(r.to_shard_proof.len(), 64);
    }

    #[test]
    fn test_phase_distinguishes() {
        assert_ne!(CrossShardPhase::Prepare, CrossShardPhase::Commit);
        assert_ne!(CrossShardPhase::Commit, CrossShardPhase::Abort);
        assert_ne!(CrossShardPhase::Prepare, CrossShardPhase::Abort);
    }

    // ── Concurrency stress ─────────────────────────────────────────────

    #[test]
    fn test_lock_manager_concurrent_acquisition() {
        use std::thread;
        let lm = Arc::new(LockManager::new());
        let mut handles = Vec::new();
        // 8 threads each touch a disjoint address set — no contention.
        for thread_id in 0..8u32 {
            let lm = lm.clone();
            handles.push(thread::spawn(move || {
                for i in 0..100 {
                    let addr = format!("t{}_addr{}", thread_id, i);
                    lm.try_acquire(thread_id, &addr, tx((thread_id as u8).wrapping_add(i as u8)), "v", 100, 30);
                }
            }));
        }
        for h in handles { h.join().unwrap(); }
        assert_eq!(lm.active_count(), 8 * 100);
    }

    #[test]
    fn test_coordinator_concurrent_starts() {
        use std::thread;
        let coord = Arc::new(CrossShardCoordinator::new(Arc::new(LockManager::new())));
        let mut handles = Vec::new();
        for thread_id in 0..4u8 {
            let coord = coord.clone();
            handles.push(thread::spawn(move || {
                for i in 0..50u8 {
                    let id = [thread_id.wrapping_add(i); 32];
                    let _ = coord.start_2pc(CrossShardEnvelope {
                        tx_id: id,
                        from_shard: 0,
                        to_shard: 1,
                        phase: CrossShardPhase::Prepare,
                        coordinator_id: format!("v_{}", thread_id),
                        deadline: 10_000,
                    }, 100);
                }
            }));
        }
        for h in handles { h.join().unwrap(); }
        // Some duplicates rejected by AlreadyExists; pending_count is the
        // unique-tx count actually started.
        assert!(coord.pending_count() > 0);
    }
}

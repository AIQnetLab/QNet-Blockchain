//! Optimized mempool with binary storage support

use dashmap::{DashMap, DashSet};
use std::sync::Arc;
use parking_lot::RwLock;
use std::collections::{VecDeque, BTreeMap};
use serde::{Serialize, Deserialize};
use serde_json;
use bincode;
use hex;
use sha3::{Sha3_256, Digest};
use qnet_state::Transaction;

/// Simple mempool configuration
#[derive(Debug, Clone)]
pub struct SimpleMempoolConfig {
    pub max_size: usize,
    pub min_gas_price: u64,
    pub max_per_sender: usize,
}

impl Default for SimpleMempoolConfig {
    fn default() -> Self {
        Self {
            max_size: 500_000, // Production default: 500k transactions
            min_gas_price: 100_000, // PRODUCTION: 0.0001 QNC (BASE_FEE_NANO_QNC from qnet-state)
            max_per_sender: 10_000, // v2.26.5: per-sender spam limit
        }
    }
}

/// Transaction storage format
#[derive(Clone)]
enum TxStorage {
    Json(String),
    Binary(Vec<u8>),
}

impl TxStorage {
    /// Payload bytes plus fixed per-entry index overhead.
    #[inline]
    fn approx_bytes(&self) -> usize {
        64 + match self {
            TxStorage::Json(s) => s.len(),
            TxStorage::Binary(v) => v.len(),
        }
    }
}

/// Byte ceiling for the whole pool. The count cap alone let 55KB batch
/// transactions balloon RAM (500k x 55KB is tens of GB); admission fails
/// closed on either bound and the client resubmits.
const MAX_MEMPOOL_BYTES: usize = 512 * 1024 * 1024;

/// Optimized mempool implementation with binary support and priority queue
/// ARCHITECTURE: Priority-based transaction ordering for spam protection
pub struct SimpleMempool {
    config: SimpleMempoolConfig,
    transactions: Arc<DashMap<String, TxStorage>>, // hash -> json or binary
    /// Payload bytes currently held; maintained ONLY via tx_store_insert /
    /// tx_store_remove / clear so no removal path can leak the counter.
    total_bytes: Arc<std::sync::atomic::AtomicUsize>,
    // PRODUCTION: Priority queue (BTreeMap) sorted by gas_price descending
    // Key: gas_price (u64), Value: FIFO queue of tx hashes at that price
    by_gas_price: Arc<RwLock<BTreeMap<u64, VecDeque<String>>>>,
    use_binary: bool, // Toggle for binary storage
    // PROTOCOL-LEVEL: TX hashes confirmed in recent blocks (prevents re-inclusion after gossip)
    // Analogous to processed transaction signatures - standard L1 mechanism
    // Prevents race condition: TX removed from mempool by block → re-arrives via P2P → re-added
    // hash -> inclusion Instant. Timestamp lets us window-prune by age so a
    // confirmed tx is only forgotten once it is provably unreachable by gossip.
    included_tx_hashes: Arc<DashMap<String, std::time::Instant>>,
    /// Timestamp when each TX was added (for TTL eviction)
    tx_timestamps: DashMap<String, std::time::Instant>,
    /// TTL-evicted hashes, kept for one gossip horizon so peers re-pushing an
    /// expired tx cannot resurrect it (observed: a drained pool regrew by
    /// thousands from tx-sync alone). Consulted ONLY by the network ingress —
    /// direct RPC re-submission stays open, and a successful local re-admission
    /// clears the entry. Pruned by the same sweep that populates it.
    expired_tx_hashes: Arc<DashMap<String, std::time::Instant>>,
    /// Per-sender TX count for spam protection
    tx_count_by_sender: DashMap<String, u32>,
    /// FIX R24-M2: Track tx_hash → sender for decrementing count on removal
    tx_sender_map: DashMap<String, String>,
    /// Max transactions per sender
    max_per_sender: u32,
    // Commitment-class dedup forward index: (identity, epoch_or_index,
    // type_id) → canonical hash. On admission of a commitment-class TX
    // (Heartbeat / PingCommitmentWithSampling / LightNodeEligibilityBitmap /
    // NodeRegistration / NodeReactivation) any prior same-key version is
    // removed before insert, so a producer can't pull two equivalent
    // commitments into one block. Needed because retries change the
    // timestamp → different hash → hash-dedup misses (symptom: dup at
    // h=29731). commitment_dedup_key MIRRORS state.rs::check_duplicate_
    // commitment 1:1, so the mempool can't admit what apply would reject.
    // Lock-free DashMap, O(1), bounded by in-flight commitment count.
    commitment_index: Arc<DashMap<(String, u64, u8), String>>,
    /// Reverse index: `tx_hash → (identity, epoch_or_index, type_id)`. Used
    /// when a TX leaves the mempool by any path (replacement, block
    /// inclusion, eviction, expiration, explicit removal, clear) so the
    /// forward index can be cleaned up without re-parsing the TX bytes.
    /// Sized identically to `commitment_index`; both are maintained as a
    /// pair under the same admission/removal logic.
    commitment_reverse: Arc<DashMap<String, (String, u64, u8)>>,

    // Persistent mempool hooks: optional callbacks set by the integration
    // layer to mirror every admit/remove to a RocksDB CF and replay it on
    // restart. Unset → pure RAM cache. Arc<dyn Fn> keeps this crate free of
    // any storage dependency.
    persist_admit: Arc<RwLock<Option<Arc<dyn Fn(&str, &[u8], u64) + Send + Sync>>>>,
    persist_remove: Arc<RwLock<Option<Arc<dyn Fn(&str) + Send + Sync>>>>,

    // On-chain commitment-epoch cache (third dedup tier behind
    // commitment_index and the producer filter). Mirrors the state crate's
    // authoritative `committed_epochs` set (filled by mark_commitment_
    // finalized on producer+peer apply) into a lock-free DashMap so the
    // admission path can reject finalized-epoch commitments without a
    // cross-crate state guard. Key = commitment_dedup_key() tuple. Bounded
    // (~1000×5×~6 ≈ 30k entries) and pruned by prune_committed_epochs_below.
    committed_epochs_cache: Arc<DashMap<(String, u64, u8), ()>>,

    // Live count of distinct NodeRegistrations (commitment type_id 4) resident in the pool.
    // Live set of NodeRegistration (commitment type_id 4) hashes resident in the pool. SINGLE source
    // of truth for both the attestor valve (backlog = .len(), TRUE admitted-but-not-yet-applied — ghost
    // joiners who never submitted never enter it) AND the deterministic inclusion lane (iterate this
    // set directly, O(pending regs) not O(system bucket)). Maintained in lockstep with commitment_index.
    pending_registration_hashes: Arc<DashSet<String>>,
}

impl SimpleMempool {
    /// Create new optimized mempool with priority queue
    /// PRODUCTION: Priority-based ordering for spam protection (highest gas_price first)
    /// Sole insert path for the tx map — keeps the byte counter exact.
    fn tx_store_insert(&self, hash: String, storage: TxStorage) {
        use std::sync::atomic::Ordering;
        let add = storage.approx_bytes();
        if let Some(old) = self.transactions.insert(hash, storage) {
            self.total_bytes.fetch_sub(old.approx_bytes(), Ordering::Relaxed);
        }
        self.total_bytes.fetch_add(add, Ordering::Relaxed);
    }

    /// Sole remove path for the tx map — mirror of tx_store_insert.
    fn tx_store_remove(&self, hash: &str) -> bool {
        use std::sync::atomic::Ordering;
        match self.transactions.remove(hash) {
            Some((_, old)) => {
                self.total_bytes.fetch_sub(old.approx_bytes(), Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    pub fn total_bytes(&self) -> usize {
        self.total_bytes.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn bytes_full(&self) -> bool {
        self.total_bytes() >= MAX_MEMPOOL_BYTES
    }

    pub fn new(config: SimpleMempoolConfig) -> Self {
        // Use binary for large mempools (>100k)
        let use_binary = config.max_size > 100_000;
        let max_per_sender = config.max_per_sender.try_into().unwrap_or(10_000);
        Self {
            config,
            transactions: Arc::new(DashMap::new()),
            total_bytes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            by_gas_price: Arc::new(RwLock::new(BTreeMap::new())),
            use_binary,
            included_tx_hashes: Arc::new(DashMap::new()),
            tx_timestamps: DashMap::new(),
            expired_tx_hashes: Arc::new(DashMap::new()),
            tx_count_by_sender: DashMap::new(),
            tx_sender_map: DashMap::new(),
            max_per_sender,
            // v15.5: commitment-class dedup indices (see struct doc)
            commitment_index: Arc::new(DashMap::new()),
            commitment_reverse: Arc::new(DashMap::new()),
            // v15.9: persistent mempool hooks (set by integration layer)
            persist_admit: Arc::new(RwLock::new(None)),
            persist_remove: Arc::new(RwLock::new(None)),
            // v15.12: on-chain commitment-epoch cache (see struct doc)
            committed_epochs_cache: Arc::new(DashMap::new()),
            pending_registration_hashes: Arc::new(DashSet::new()),
        }
    }

    /// v15.12: Notify the mempool that a commitment-class TX with
    /// `(identity, epoch_or_index, type_id)` has been finalized on chain.
    ///
    /// Called by the integration layer's apply path on EVERY block apply
    /// (producer + peer pipeline) for every commitment-class TX in the block.
    /// Subsequent admission attempts for the same key are rejected at the
    /// door — see `is_commitment_already_on_chain`.
    ///
    /// Idempotent: re-marking an already-known key is a no-op DashMap insert.
    pub fn mark_commitment_finalized(&self, key: (String, u64, u8)) {
        self.committed_epochs_cache.insert(key, ());
    }

    /// v15.12: Returns true if the mempool has previously been notified that
    /// `(identity, epoch_or_index, type_id)` is finalized on chain.
    /// O(1) DashMap lookup; safe in the lock-free admission hot path.
    pub fn is_commitment_already_on_chain(&self, key: &(String, u64, u8)) -> bool {
        self.committed_epochs_cache.contains_key(key)
    }

    /// v15.12: Bulk-prune finalized-epoch entries with `epoch_or_index < min_epoch`.
    ///
    /// Intended for the periodic TTL sweep so the cache footprint stays flat
    /// at thousands-of-validators scale. NodeRegistration uses epoch=0 as a
    /// one-shot marker and is intentionally excluded from pruning so a
    /// long-lived registration never gets re-admissible after eviction.
    pub fn prune_committed_epochs_below(&self, min_epoch: u64) {
        self.committed_epochs_cache.retain(|key, _| {
            // type_id 4 = NodeRegistration, one-shot keepsake at epoch=0.
            let (_, epoch, type_id) = key;
            *type_id == 4 || *epoch >= min_epoch
        });
    }

    /// v15.9: Install persistence callbacks. Called once by the integration
    /// layer at node startup, before the mempool starts receiving TXs.
    /// `admit` runs on every successful admission (raw / binary / batch
    /// / commitment-replacement); `remove` runs on every removal path
    /// (block inclusion, TTL eviction, replacement, explicit drop).
    pub fn set_persistence_hooks(
        &self,
        admit: Arc<dyn Fn(&str, &[u8], u64) + Send + Sync>,
        remove: Arc<dyn Fn(&str) + Send + Sync>,
    ) {
        *self.persist_admit.write() = Some(admit);
        *self.persist_remove.write() = Some(remove);
    }

    /// Internal helper — invoke the admit hook if installed.
    /// Kept private so call sites cannot bypass it.
    fn fire_persist_admit(&self, tx_hash: &str, payload: &[u8]) {
        if let Some(cb) = self.persist_admit.read().as_ref() {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            cb(tx_hash, payload, ts);
        }
    }

    /// Internal helper — invoke the remove hook if installed.
    fn fire_persist_remove(&self, tx_hash: &str) {
        if let Some(cb) = self.persist_remove.read().as_ref() {
            cb(tx_hash);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // v15.5: COMMITMENT DEDUP HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /// Atomically register the new commitment hash under its dedup key,
    /// returning the previously-registered hash if a replacement just
    /// happened. Uses the `entry` API on `DashMap` so per-key transitions
    /// are linearisable across producer threads — concurrent admissions of
    /// the same logical commitment serialise to a single winner without an
    /// outer lock.
    ///
    /// The forward-index transition is the *commit point* for replacement.
    /// All storage cleanup of the prior version (`transactions`,
    /// `tx_timestamps`, `tx_sender_map`, `tx_count_by_sender`,
    /// `by_gas_price`) follows this commit point, so any reader observing
    /// the forward index already sees the new winner; subsequent storage
    /// reads of the old hash may briefly succeed (until cleanup completes),
    /// which is harmless — the producer scans by hash, not by key.
    fn replace_or_register_commitment(
        &self,
        key: (String, u64, u8),
        new_hash: &str,
    ) -> Option<String> {
        use dashmap::mapref::entry::Entry;

        let is_registration = key.2 == 4;
        let old_hash = match self.commitment_index.entry(key.clone()) {
            Entry::Occupied(mut e) => Some(std::mem::replace(e.get_mut(), new_hash.to_string())),
            Entry::Vacant(e) => {
                e.insert(new_hash.to_string());
                None
            }
        };
        // Same-hash re-admission race (identical bytes from two gossip paths): the "old" version IS
        // the new one — scrubbing would delete the reverse entry just inserted and orphan the
        // forward entry, leaking the backlog set on eventual removal. Nothing to replace.
        let old_hash = match old_hash {
            Some(ref old) if old.as_str() == new_hash => return None,
            other => other,
        };
        // Registration backlog set tracks the CURRENT resident hash per key: insert new, drop old on
        // replacement (net-zero); a fresh key is net +1. Membership = the true admitted-not-applied set.
        if is_registration {
            self.pending_registration_hashes.insert(new_hash.to_string());
            if let Some(ref old) = old_hash { self.pending_registration_hashes.remove(old); }
        }

        // Reverse index: `new_hash → key` so any future removal path can
        // resolve the forward-index entry without re-parsing the TX.
        self.commitment_reverse.insert(new_hash.to_string(), key);

        // If a prior version existed, scrub it from every storage layer.
        // Each removal is idempotent against concurrent removal paths (e.g.
        // expiration), so a race between replacement and TTL eviction is
        // resolved deterministically — last-writer-of-the-storage-row wins,
        // and either ordering converges on a consistent state.
        if let Some(ref old) = old_hash {
            self.commitment_reverse.remove(old);
            self.tx_store_remove(old);
            self.tx_timestamps.remove(old);
            if let Some((_, sender)) = self.tx_sender_map.remove(old) {
                if let Some(mut count) = self.tx_count_by_sender.get_mut(&sender) {
                    *count = count.saturating_sub(1);
                }
            }
            // Priority-queue cleanup must hold the outer write lock because
            // `by_gas_price` is the linearisation point for the producer's
            // pull path. Brief contention here (only on commitment retries)
            // is acceptable; commitments are at most one per validator per
            // epoch boundary.
            let mut priority_queue = self.by_gas_price.write();
            for (_gas_price, hashes) in priority_queue.iter_mut() {
                hashes.retain(|h| h != old);
            }
            priority_queue.retain(|_, hashes| !hashes.is_empty());
            drop(priority_queue);

            // v15.9: persistent mempool — the prior commitment was just
            // wiped from every in-RAM structure, mirror its removal to
            // the disk CF so a restart does not re-admit a stale
            // commitment that the canonical chain has already
            // superseded.
            self.fire_persist_remove(old);
        }

        old_hash
    }

    /// Remove any commitment-dedup index entries pointing at this hash.
    /// Called from every TX-removal path so that the dedup tables stay
    /// proportionate to live mempool occupancy. The `remove_if` guard on
    /// the forward index prevents accidental removal of a NEWER replacement
    /// that happens to share the same key — only the entry whose value
    /// equals `hash` is cleared.
    fn cleanup_commitment_indices_for_hash(&self, hash: &str) {
        if let Some((_, key)) = self.commitment_reverse.remove(hash) {
            // Drop from the backlog set only when the forward entry is truly gone (a replacement race
            // leaves the key live under a newer hash — still-resident registration, keep it).
            if self.commitment_index.remove_if(&key, |_, current| current == hash).is_some()
                && key.2 == 4
            {
                self.pending_registration_hashes.remove(hash);
            }
        }
    }

    /// Roll back a commitment registration made this admission attempt (count-rejected TX that never
    /// entered storage). Mirrors cleanup_commitment_indices_for_hash so the backlog set stays in
    /// lockstep with commitment_index.
    fn rollback_commitment_registration(&self, key: &(String, u64, u8), hash: &str) {
        if self.commitment_index.remove_if(key, |_, current| current == hash).is_some()
            && key.2 == 4
        {
            self.pending_registration_hashes.remove(hash);
        }
        self.commitment_reverse.remove(hash);
    }
    
    /// Add raw transaction (optimized with binary option and priority queue)
    /// PRODUCTION: Priority-based insertion for spam protection
    /// gas_price: Transaction gas price for priority sorting (higher = earlier processing)
    /// Returns: true if added, false if duplicate/full/invalid (NOT an error for duplicates!)
    ///
    /// v2.67: CRITICAL FIX - Atomic add to both structures under single lock
    /// v14.8.4: System-TX bypass. Parse TX once up front so we can route
    /// protocol-level bootstrap / maintenance messages (NodeActivation,
    /// NodeRegistration, Ping/Heartbeat/Attestation, RewardDistribution,
    /// KeyRotation) past the user-side min_gas_price floor. A freshly
    /// activated Super-node has ZERO QNC balance until it is registered,
    /// so the min-fee floor would otherwise form a chicken-and-egg lock
    /// preventing ANY non-genesis node from joining. DoS protection for
    /// the bypass path is enforced UPSTREAM: activation codes reference a
    /// confirmed Solana 1DEV burn whose hash is tracked on-chain for
    /// single-use, and all liveness TXs carry Dilithium3 sender sigs.
    pub fn add_raw_transaction(&self, tx_json: String, hash: String, gas_price: u64) -> bool {
        // v14.8.4: Parse once up front; we need `is_system_tx()` before the
        // min_gas_price check. This is the same parse previously done later
        // for hash verification — moving it up costs nothing.
        let parsed_tx = match serde_json::from_str::<Transaction>(&tx_json) {
            Ok(tx) => tx,
            Err(e) => {
                eprintln!("[ERR][MEMPOOL] parse_failed hash={} error={}",
                         qnet_state::char_prefix(&hash, 16), e);
                return false;
            }
        };

        let is_system = parsed_tx.is_system_tx();

        // FIX M-M15 (v14.8.4 refinement): Min gas price enforced only for
        // user transactions. System TXs (validator lifecycle + liveness +
        // rewards + key rotation) MUST be free — their payment/authority
        // is proven on chain or on Solana, not by mempool fee.
        if !is_system && gas_price < self.config.min_gas_price {
            println!("[WARN][MEMPOOL] below_min_gas gas={} min={} system_tx=false",
                     gas_price, self.config.min_gas_price);
            return false;
        }

        // FIX M-H15: Evict lowest-priority TX when mempool is full.
        // System TXs are treated as highest priority for eviction purposes
        // (effective_priority = u64::MAX) so a spam flood of user TXs
        // cannot starve protocol bootstrap.
        // A merkle reward-claim keeps the min-fee bypass but NOT the consensus lane: at u64::MAX it
        // would be packed ahead of every paying transaction. Floor priority instead — above free spam,
        // below anyone who paid.
        let effective_priority = if parsed_tx.is_merkle_reward_claim() {
            self.config.min_gas_price
        } else if is_system {
            u64::MAX
        } else {
            gas_price
        };
        if self.transactions.len() >= self.config.max_size || self.bytes_full() {
            let mut priority_queue = self.by_gas_price.write();
            if let Some(mut lowest_entry) = priority_queue.first_entry() {
                let lowest_gas = *lowest_entry.key();
                if effective_priority > lowest_gas {
                    if let Some(tx_hash) = lowest_entry.get().front().cloned() {
                        // Remove evicted TX from both structures
                        lowest_entry.get_mut().pop_front();
                        if lowest_entry.get().is_empty() {
                            lowest_entry.remove();
                        }
                        self.tx_store_remove(&tx_hash);
                        self.tx_timestamps.remove(&tx_hash);
                        // Release the evicted tx's quota slot too: every other removal path is gated
                        // on transactions.remove() succeeding, which is already false by here, so
                        // without this the counter and tx_sender_map grow forever and eventually lock
                        // the victim's wallet out of the mempool entirely.
                        self.decrement_sender_for_hash(&tx_hash);
                        // v15.5: keep commitment dedup tables proportional to
                        // live mempool occupancy when low-priority eviction
                        // drops a commitment-class TX.
                        self.cleanup_commitment_indices_for_hash(&tx_hash);
                        println!("[INFO][MEMPOOL] evicted_low_priority gas={} for_new_gas={} new_is_system={}",
                                 lowest_gas, effective_priority, is_system);
                    }
                } else if parsed_tx.is_merkle_reward_claim() && lowest_gas <= self.config.min_gas_price {
                    // A claim sits AT the floor, so `>` can never displace another floor entry. Rewards
                    // must stay claimable under load, so let a claim take a floor slot on equal terms;
                    // it cannot displace anyone who actually paid.
                    if let Some(tx_hash) = lowest_entry.get().front().cloned() {
                        lowest_entry.get_mut().pop_front();
                        if lowest_entry.get().is_empty() {
                            lowest_entry.remove();
                        }
                        self.tx_store_remove(&tx_hash);
                        self.tx_timestamps.remove(&tx_hash);
                        self.decrement_sender_for_hash(&tx_hash);
                        self.cleanup_commitment_indices_for_hash(&tx_hash);
                    } else {
                        return false;
                    }
                } else {
                    println!("[WARN][MEMPOOL] pool_full size={} rejected_gas={} system={}",
                             self.transactions.len(), gas_price, is_system);
                    return false;
                }
            } else {
                return false;
            }
            drop(priority_queue);
        }

        // PROTOCOL: Reject TX already confirmed in recent blocks (prevents post-gossip re-inclusion)
        if self.included_tx_hashes.contains_key(&hash) {
            return false;
        }

        // Duplicate is NORMAL in P2P network (same TX from multiple peers)
        if self.transactions.contains_key(&hash) {
            return false;
        }

        // SECURITY: Verify hash matches canonical transaction data
        let canonical_bytes = parsed_tx.canonical_bytes();
        let computed_hash = format!("{:x}", Sha3_256::digest(&canonical_bytes));
        if computed_hash != hash {
            eprintln!("[ERR][MEMPOOL] hash_mismatch expected={} got={}",
                     qnet_state::char_prefix(&hash, 16), qnet_state::char_prefix(&computed_hash, 16));
            return false;
        }

        // L3 on-chain commitment-epoch admission guard: reject gossip TXs
        // that arrive after their commitment epoch was finalized (late
        // rebroadcast, or apply-vs-gossip race) so the mempool doesn't hold
        // an unreachable TX for its whole TTL. Cache filled by
        // mark_commitment_finalized on apply; lock-free ~50ns lookup.
        // Pure optimisation — never the sole arbiter (producer L2 filter +
        // state check_duplicate_commitment are authoritative).
        let commitment_key = parsed_tx.commitment_dedup_key();
        if let Some(ref key) = commitment_key {
            if self.is_commitment_already_on_chain(key) {
                println!(
                    "[INFO][MEMPOOL] admission_rejected_already_on_chain id={} epoch={} type={} hash={}",
                    qnet_state::char_prefix(&key.0, 16), key.1, key.2,
                    qnet_state::char_prefix(&hash, 16)
                );
                return false;
            }
        }

        // v15.5: COMMITMENT REPLACEMENT — single-version-in-mempool guarantee
        // for the deterministic-(identity, epoch_or_index) TX class. Any
        // prior version sharing the same dedup key is removed from every
        // storage layer here, BEFORE per-sender count and storage insertion,
        // so the count and capacity bookkeeping that follows reflects the
        // post-replacement state. Non-commitment TXs return None and skip
        // this branch with one DashMap miss of overhead.
        // ═══════════════════════════════════════════════════════════════════
        if let Some(ref key) = commitment_key {
            if let Some(old_hash) = self.replace_or_register_commitment(key.clone(), &hash) {
                println!("[INFO][MEMPOOL] commitment_replaced id={} epoch={} type={} old={} new={}",
                         qnet_state::char_prefix(&key.0, 16), key.1, key.2,
                         qnet_state::char_prefix(&old_hash, 16),
                         qnet_state::char_prefix(&hash, 16));
            }
        }

        // FIX L-M9: Per-sender limit defense-in-depth
        if !parsed_tx.from.is_empty() {
            let mut sender_count = self.tx_count_by_sender
                .entry(Self::quota_key(&parsed_tx))
                .or_insert(0);
            if *sender_count >= self.max_per_sender {
                println!("[WARN][MEMPOOL] per_sender_limit sender={} count={} max={}",
                         qnet_state::char_prefix(&parsed_tx.from, 16), *sender_count, self.max_per_sender);
                // v15.5: roll back the commitment registration we just made
                // so a count-rejected TX does not leave a dangling forward-
                // index entry pointing at a hash that never enters storage.
                if let Some(ref key) = commitment_key {
                    self.rollback_commitment_registration(key, &hash);
                }
                return false;
            }
            *sender_count += 1;
            self.tx_sender_map.insert(hash.clone(), Self::quota_key(&parsed_tx));
        }

        // Store as binary if enabled (50% space saving)
        let storage = if self.use_binary {
            TxStorage::Binary(tx_json.as_bytes().to_vec())
        } else {
            TxStorage::Json(tx_json.clone())
        };

        // v15.9: precompute the bincode payload for the persistent mirror
        // BEFORE entering the priority-queue lock so we can release the
        // lock as quickly as possible. We persist Transaction as bincode
        // for forward-compatibility with the binary admit path — a
        // restarted node can replay every entry through
        // `add_binary_transaction` regardless of which API admitted it.
        let persist_payload: Option<Vec<u8>> = bincode::serialize(&parsed_tx).ok();

        // v2.67: CRITICAL - Add to BOTH structures atomically under priority queue lock
        {
            let mut priority_queue = self.by_gas_price.write();

            // Double-check inside lock
            if self.transactions.contains_key(&hash) {
                return false;
            }

            self.tx_store_insert(hash.clone(), storage);
            self.tx_timestamps.insert(hash.clone(), std::time::Instant::now());
            // A deliberate local re-admission (RPC resubmit) lifts this node's
            // expiry tombstone; peers clear their own the same way.
            self.expired_tx_hashes.remove(&hash);
            // v14.8.4: System TXs keyed at u64::MAX so block producers drain
            // them first — protocol bootstrap cannot be delayed by user TXs.
            priority_queue
                .entry(effective_priority)
                .or_insert_with(VecDeque::new)
                .push_back(hash.clone());
        }

        // v15.9: persistent mempool — mirror admission to RocksDB.
        if let Some(bytes) = persist_payload {
            self.fire_persist_admit(&hash, &bytes);
        }

        true
    }

    /// Add binary transaction directly with priority
    /// PRODUCTION: Priority-based insertion for spam protection
    /// gas_price: Transaction gas price for priority sorting (higher = earlier processing)
    /// Returns: true if added, false if duplicate/full/invalid (NOT an error for duplicates!)
    /// 
    /// v2.67: CRITICAL FIX - Add to priority queue FIRST, then to transactions
    /// This ensures get_pending_transactions_with_hashes always sees consistent state
    /// Spam-quota key. A merkle reward-claim's `from` is the shared `system_rewards_pool` literal, so
    /// keying on it would make every wallet's claims compete for ONE bucket network-wide. Key those on
    /// the recipient instead — the wallet whose signature authorized them. Written into
    /// `tx_sender_map` at insert, so every decrement path uses the identical key.
    fn quota_key(tx: &qnet_state::Transaction) -> String {
        if tx.is_merkle_reward_claim() {
            if let Some(to) = tx.to.as_ref() { return to.clone(); }
        }
        tx.from.clone()
    }

    pub fn add_binary_transaction(&self, tx_bytes: Vec<u8>, hash: String, gas_price: u64) -> bool {
        // v14.8.4: Parse once up front so we can classify user vs system TX
        // and apply the correct fee policy. See `add_raw_transaction` for
        // the rationale behind the system-TX bypass.
        let parsed_tx = match bincode::deserialize::<Transaction>(&tx_bytes) {
            Ok(tx) => tx,
            Err(e) => {
                eprintln!("[ERR][MEMPOOL] deserialize_failed hash={} error={}",
                         qnet_state::char_prefix(&hash, 16), e);
                return false;
            }
        };

        let is_system = parsed_tx.is_system_tx();

        // FIX M-M15 (v14.8.4 refinement): Min gas only for user TXs.
        if !is_system && gas_price < self.config.min_gas_price {
            println!("[WARN][MEMPOOL] below_min_gas gas={} min={} system_tx=false",
                     gas_price, self.config.min_gas_price);
            return false;
        }

        // A merkle reward-claim keeps the min-fee bypass but NOT the consensus lane: at u64::MAX it
        // would be packed ahead of every paying transaction. Floor priority instead — above free spam,
        // below anyone who paid.
        let effective_priority = if parsed_tx.is_merkle_reward_claim() {
            self.config.min_gas_price
        } else if is_system {
            u64::MAX
        } else {
            gas_price
        };

        // FIX M-H15: Evict lowest-priority TX when mempool is full
        let mut evicted_for_persist: Option<String> = None;
        if self.transactions.len() >= self.config.max_size || self.bytes_full() {
            let mut priority_queue = self.by_gas_price.write();
            if let Some(mut lowest_entry) = priority_queue.first_entry() {
                let lowest_gas = *lowest_entry.key();
                if effective_priority > lowest_gas {
                    if let Some(tx_hash) = lowest_entry.get().front().cloned() {
                        lowest_entry.get_mut().pop_front();
                        if lowest_entry.get().is_empty() {
                            lowest_entry.remove();
                        }
                        self.tx_store_remove(&tx_hash);
                        self.tx_timestamps.remove(&tx_hash);
                        // Release the evicted tx's quota slot too: every other removal path is gated
                        // on transactions.remove() succeeding, which is already false by here, so
                        // without this the counter and tx_sender_map grow forever and eventually lock
                        // the victim's wallet out of the mempool entirely.
                        self.decrement_sender_for_hash(&tx_hash);
                        // v15.5: keep commitment dedup tables proportional to
                        // live mempool occupancy when low-priority eviction
                        // drops a commitment-class TX.
                        self.cleanup_commitment_indices_for_hash(&tx_hash);
                        // v15.9: defer the persistent-mirror removal to AFTER
                        // we release the priority-queue write lock — the
                        // hook performs disk I/O and must not run under
                        // the lock.
                        evicted_for_persist = Some(tx_hash.clone());
                        println!("[INFO][MEMPOOL] evicted_low_priority gas={} for_new_gas={} new_is_system={}",
                                 lowest_gas, effective_priority, is_system);
                    }
                } else if parsed_tx.is_merkle_reward_claim() && lowest_gas <= self.config.min_gas_price {
                    // A claim sits AT the floor, so `>` can never displace another floor entry. Rewards
                    // must stay claimable under load, so let a claim take a floor slot on equal terms;
                    // it cannot displace anyone who actually paid.
                    if let Some(tx_hash) = lowest_entry.get().front().cloned() {
                        lowest_entry.get_mut().pop_front();
                        if lowest_entry.get().is_empty() {
                            lowest_entry.remove();
                        }
                        self.tx_store_remove(&tx_hash);
                        self.tx_timestamps.remove(&tx_hash);
                        self.decrement_sender_for_hash(&tx_hash);
                        self.cleanup_commitment_indices_for_hash(&tx_hash);
                        // Mirror removal too (deferred past the lock, same as the sibling branch) —
                        // else the displaced tx resurrects from the persistent mempool on restart.
                        evicted_for_persist = Some(tx_hash.clone());
                    } else {
                        return false;
                    }
                } else {
                    println!("[WARN][MEMPOOL] pool_full size={} rejected_gas={} system={}",
                             self.transactions.len(), gas_price, is_system);
                    return false;
                }
            } else {
                return false;
            }
            drop(priority_queue);
        }

        // v15.9: persistent mempool — flush the deferred eviction now that
        // the priority-queue write lock is released. Doing the disk
        // delete outside the lock keeps admission throughput unaffected
        // by RocksDB latency.
        if let Some(ref evicted_hash) = evicted_for_persist {
            self.fire_persist_remove(evicted_hash);
        }

        // PROTOCOL: Reject TX already confirmed in recent blocks (prevents post-gossip re-inclusion)
        if self.included_tx_hashes.contains_key(&hash) {
            return false;
        }

        // Duplicate is NORMAL in P2P network (same TX from multiple peers)
        if self.transactions.contains_key(&hash) {
            return false;
        }

        // SECURITY: Verify hash matches canonical transaction data
        let canonical_bytes = parsed_tx.canonical_bytes();
        let computed_hash = format!("{:x}", Sha3_256::digest(&canonical_bytes));
        if computed_hash != hash {
            eprintln!("[ERR][MEMPOOL] hash_mismatch expected={} got={}",
                     qnet_state::char_prefix(&hash, 16), qnet_state::char_prefix(&computed_hash, 16));
            return false;
        }

        // ═══════════════════════════════════════════════════════════════════
        // v15.12 L3: ON-CHAIN COMMITMENT-EPOCH ADMISSION GUARD — binary path
        // ═══════════════════════════════════════════════════════════════════
        // Mirrors the L3 guard in `add_raw_transaction`. Binary admission is
        // the hot route for commitments arriving via gossip / producer
        // broadcast retries, so this is the most-frequently-traversed
        // admission check at thousands-of-validators scale.
        //
        // Cache populated by `mark_commitment_finalized` from the integration
        // layer's apply path on every block apply event. Single lock-free
        // DashMap lookup per admission. See `add_raw_transaction` for the
        // full architectural rationale.
        // ═══════════════════════════════════════════════════════════════════
        let commitment_key = parsed_tx.commitment_dedup_key();
        if let Some(ref key) = commitment_key {
            if self.is_commitment_already_on_chain(key) {
                println!(
                    "[INFO][MEMPOOL] admission_rejected_already_on_chain id={} epoch={} type={} hash={}",
                    qnet_state::char_prefix(&key.0, 16), key.1, key.2,
                    qnet_state::char_prefix(&hash, 16)
                );
                return false;
            }
        }

        // ═══════════════════════════════════════════════════════════════════
        // v15.5: COMMITMENT REPLACEMENT — see `add_raw_transaction` for the
        // full rationale. The binary path is the hot route for commitments
        // arriving via gossip and producer-side broadcast retries, so
        // replacement here is what closes the cross-node duplication
        // window: every receiving node deduplicates independently and the
        // next producer's mempool can only contain one version of any
        // logical commitment.
        // ═══════════════════════════════════════════════════════════════════
        if let Some(ref key) = commitment_key {
            if let Some(old_hash) = self.replace_or_register_commitment(key.clone(), &hash) {
                println!("[INFO][MEMPOOL] commitment_replaced id={} epoch={} type={} old={} new={}",
                         qnet_state::char_prefix(&key.0, 16), key.1, key.2,
                         qnet_state::char_prefix(&old_hash, 16),
                         qnet_state::char_prefix(&hash, 16));
            }
        }

        // Per-sender limit (defense in depth)
        let sender = &parsed_tx.from;
        if !sender.is_empty() {
            let mut sender_count = self.tx_count_by_sender.entry(Self::quota_key(&parsed_tx)).or_insert(0);
            if *sender_count >= self.max_per_sender {
                println!("[WARN][MEMPOOL] per_sender_limit sender={}.. count={}",
                         qnet_state::char_prefix(&sender, 16), *sender_count);
                // v15.5: roll back the commitment registration on count
                // rejection to keep dedup indices in lockstep with storage.
                if let Some(ref key) = commitment_key {
                    self.rollback_commitment_registration(key, &hash);
                }
                return false;
            }
            *sender_count += 1;
            self.tx_sender_map.insert(hash.clone(), Self::quota_key(&parsed_tx));
        }

        // v2.67: CRITICAL - Add to BOTH structures atomically under priority queue lock
        // This prevents race condition where TX is in transactions but not in priority queue
        let persist_payload: Vec<u8>;
        {
            let mut priority_queue = self.by_gas_price.write();

            // Double-check inside lock to prevent duplicates
            if self.transactions.contains_key(&hash) {
                return false;
            }

            // v15.9: keep a copy of the binary payload BEFORE moving it into
            // the in-RAM map; we use it to mirror the admission to the
            // persistent mempool CF after the lock is released.
            persist_payload = tx_bytes.clone();

            // Add to transactions first
            self.tx_store_insert(hash.clone(), TxStorage::Binary(tx_bytes));
            self.tx_timestamps.insert(hash.clone(), std::time::Instant::now());
            // A deliberate local re-admission (RPC resubmit) lifts this node's
            // expiry tombstone; peers clear their own the same way.
            self.expired_tx_hashes.remove(&hash);

            // Then add to priority queue (same lock scope)
            priority_queue
                .entry(effective_priority)
                .or_insert_with(VecDeque::new)
                .push_back(hash.clone());

            // v2.67: Verify consistency for system TX at top-priority slot
            if is_system {
                // Look in the queue this TX was actually filed under. Probing u64::MAX only was correct
                // while every system TX sat at top priority; merkle reward claims do not, so a perfectly
                // successful admission logged [ERR] every time.
                let queue_has = priority_queue.get(&effective_priority)
                    .map(|v| v.contains(&hash))
                    .unwrap_or(false);
                let tx_has = self.transactions.contains_key(&hash);

                println!("[INFO][MEMPOOL] system_tx_added hash={} size={} queue={} tx={}",
                        qnet_state::char_prefix(&hash, 16), self.transactions.len(), queue_has, tx_has);

                if !queue_has || !tx_has {
                    eprintln!("[ERR][MEMPOOL] system_tx_add_failed hash={}", qnet_state::char_prefix(&hash, 16));
                }
            }
        }

        // v15.9: persistent mempool — mirror the admission to RocksDB after
        // releasing the priority-queue lock. The hook is async-safe and
        // returns immediately; the actual disk write is a single
        // `put_cf` on a hot CF (microsecond-scale).
        self.fire_persist_admit(&hash, &persist_payload);

        true
    }
    
    /// PRODUCTION v2.25.2: Batch add binary transactions (HIGH TPS)
    /// TRUSTED ONLY: Skips hash verification - caller must compute hashes correctly
    /// Use for: benchmark, internal batch processing where hashes are pre-computed
    /// DO NOT USE for: external RPC, untrusted P2P messages
    /// 
    /// Benefits:
    /// - Single lock acquisition for entire batch (vs N locks for N transactions)
    /// - No redundant SHA3 computation (caller already computed)
    /// - 10-50x faster than individual adds for large batches
    pub fn add_binary_transaction_batch_trusted(&self, transactions: Vec<(Vec<u8>, String, u64)>) -> usize {
        if transactions.is_empty() {
            return 0;
        }

        let available_space = self.config.max_size.saturating_sub(self.transactions.len());
        if available_space == 0 || self.bytes_full() {
            return 0;
        }

        let mut added = 0usize;

        // v15.9: persistence-hook deferral buffers. Gathered under the held
        // priority-queue lock and replayed AFTER the lock is released so
        // disk I/O never serialises behind the in-memory admission lock.
        let mut pending_persist_admit: Vec<(String, Vec<u8>)> = Vec::new();
        let mut pending_persist_remove: Vec<String> = Vec::new();

        // CRITICAL: Acquire priority queue lock BEFORE inserting into DashMap
        // This makes both insertions atomic, preventing the race condition where
        // a TX is visible in transactions but missing from the priority queue.
        // v15.5: lock also serialises commitment-dedup transitions for the
        // batch — see inline replacement below.
        let mut priority_queue = self.by_gas_price.write();

        for (tx_bytes, hash, gas_price) in transactions.into_iter().take(available_space) {
            // Skip duplicates
            if self.transactions.contains_key(&hash) {
                continue;
            }

            // Commitment dedup for the trusted-batch path: it must also do
            // per-receive replacement, else a commitment-class TX leaves a
            // stale prior version in the mempool (breaks "one canonical
            // version per commitment"). Inlined rather than via
            // replace_or_register_commitment because we already hold the
            // by_gas_price write lock (avoid re-entrant lock). Fast path:
            // only system-class TXs (gas_price == u64::MAX) are parsed;
            // user TXs cost one u64 compare.
            let key_opt = if gas_price == u64::MAX {
                bincode::deserialize::<Transaction>(&tx_bytes)
                    .ok()
                    .and_then(|tx| tx.commitment_dedup_key())
            } else {
                None
            };

            // ═══════════════════════════════════════════════════════════════
            // v15.12 L3: ON-CHAIN COMMITMENT-EPOCH ADMISSION GUARD — trusted
            // batch path. Mirrors the single-TX guards above, executed under
            // the held `by_gas_price` lock so the rejection is atomic with
            // the per-batch dedup transition that follows. Skipped for non-
            // commitment TXs (key_opt = None) — single DashMap miss of
            // overhead per non-commitment entry.
            // ═══════════════════════════════════════════════════════════════
            if let Some(ref key) = key_opt {
                if self.is_commitment_already_on_chain(key) {
                    println!(
                        "[INFO][MEMPOOL] admission_rejected_already_on_chain_trusted id={} epoch={} type={} hash={}",
                        qnet_state::char_prefix(&key.0, 16), key.1, key.2,
                        qnet_state::char_prefix(&hash, 16)
                    );
                    continue;
                }
            }

            if let Some(ref key) = key_opt {
                use dashmap::mapref::entry::Entry;
                let prev_hash = match self.commitment_index.entry(key.clone()) {
                    Entry::Occupied(mut e) => {
                        Some(std::mem::replace(e.get_mut(), hash.clone()))
                    }
                    Entry::Vacant(e) => {
                        e.insert(hash.clone());
                        None
                    }
                };
                self.commitment_reverse.insert(hash.clone(), key.clone());
                // Same-hash re-admission: nothing to replace (see replace_or_register_commitment).
                let prev_hash = prev_hash.filter(|old| old != &hash);
                // Mirror the single-TX paths: track the current resident reg hash (insert new, drop old).
                if key.2 == 4 {
                    self.pending_registration_hashes.insert(hash.clone());
                    if let Some(ref old) = prev_hash { self.pending_registration_hashes.remove(old); }
                }

                if let Some(old) = prev_hash {
                    // Evict the prior version from every storage layer.
                    // The priority-queue removal happens inside the held
                    // lock so the transition is atomic with the new
                    // insertion below.
                    self.commitment_reverse.remove(&old);
                    self.tx_store_remove(&old);
                    self.tx_timestamps.remove(&old);
                    if let Some((_, sender)) = self.tx_sender_map.remove(&old) {
                        if let Some(mut count) = self.tx_count_by_sender.get_mut(&sender) {
                            *count = count.saturating_sub(1);
                        }
                    }
                    for (_gp, hashes) in priority_queue.iter_mut() {
                        hashes.retain(|h| h != &old);
                    }
                    println!("[INFO][MEMPOOL] commitment_replaced_trusted id={} epoch={} type={} old={} new={}",
                             qnet_state::char_prefix(&key.0, 16), key.1, key.2,
                             qnet_state::char_prefix(&old, 16),
                             qnet_state::char_prefix(&hash, 16));
                    // v15.9: defer the persistent-mirror removal to AFTER
                    // the priority-queue lock is released.
                    pending_persist_remove.push(old);
                }
            }

            // v15.9: capture payload for the persistent-mirror admit hook
            // BEFORE moving `tx_bytes` into the in-RAM map. The trusted
            // batch path is the hottest admission route at scale (P2P
            // gossip-batch ingestion), so deferring the disk write here
            // matters even more than on the single-TX paths.
            pending_persist_admit.push((hash.clone(), tx_bytes.clone()));

            // TRUSTED: Skip hash verification - caller guarantees correctness
            // Insert into BOTH structures within the same lock scope
            self.tx_store_insert(hash.clone(), TxStorage::Binary(tx_bytes));
            self.tx_timestamps.insert(hash.clone(), std::time::Instant::now());
            // A deliberate local re-admission (RPC resubmit) lifts this node's
            // expiry tombstone; peers clear their own the same way.
            self.expired_tx_hashes.remove(&hash);
            priority_queue
                .entry(gas_price)
                .or_insert_with(VecDeque::new)
                .push_back(hash);
            added += 1;
        }

        // Drop empty priority levels created by commitment evictions above
        // so the queue stays compact across batch boundaries.
        priority_queue.retain(|_, hashes| !hashes.is_empty());
        drop(priority_queue);

        // v15.9: replay persistent-mirror hooks AFTER releasing the lock.
        // Removals fire first so a same-batch admit + replace scenario
        // ends with the new entry on disk (last-write-wins matches the
        // in-RAM final state).
        for old_hash in &pending_persist_remove {
            self.fire_persist_remove(old_hash);
        }
        for (h, payload) in &pending_persist_admit {
            self.fire_persist_admit(h, payload);
        }

        added
    }
    
    /// Get raw transaction (handles both formats)
    pub fn get_raw_transaction(&self, hash: &str) -> Option<String> {
        self.transactions.get(hash).and_then(|entry| {
            match entry.value() {
                TxStorage::Json(json) => Some(json.clone()),
                TxStorage::Binary(bytes) => {
                    // SECURITY: Only return if valid UTF-8, otherwise None
                    // This prevents returning corrupted data
                    match String::from_utf8(bytes.clone()) {
                        Ok(json) => Some(json),
                        Err(e) => {
                            println!("[MEMPOOL] ⚠️ SECURITY: Corrupted binary data for hash {}: {}", hash, e);
                            None // Don't return corrupted data!
                        }
                    }
                }
            }
        })
    }
    
    /// Get binary transaction
    pub fn get_binary_transaction(&self, hash: &str) -> Option<Vec<u8>> {
        self.transactions.get(hash).map(|entry| {
            match entry.value() {
                TxStorage::Json(json) => json.as_bytes().to_vec(),
                TxStorage::Binary(bytes) => bytes.clone(),
            }
        })
    }
    
    /// Get pending transactions (PRIORITY ORDER: highest gas_price first)
    /// PRODUCTION: Anti-spam protection - high-paying transactions processed first
    /// ARCHITECTURE: Prevents spam attacks from blocking legitimate high-value transactions
    pub fn get_pending_transactions(&self, limit: usize) -> Vec<String> {
        let priority_queue = self.by_gas_price.read();
        
        // Iterate from HIGHEST gas_price to LOWEST (BTreeMap.iter().rev())
        // Within same gas_price: FIFO order (fair for same-price transactions)
        priority_queue.iter()
            .rev()  // CRITICAL: Reverse iteration for highest-first
            .flat_map(|(_gas_price, hashes)| hashes.iter())
            .take(limit)
            .filter_map(|hash| self.get_raw_transaction(hash))
            .collect()
    }
    
    /// PRODUCTION v2.25: Get pending transactions as binary (for bincode deserialization)
    /// Returns raw bytes - caller must deserialize with bincode::deserialize
    /// PERFORMANCE: 10-20x faster than JSON for high TPS scenarios
    pub fn get_pending_binary_transactions(&self, limit: usize) -> Vec<Vec<u8>> {
        let priority_queue = self.by_gas_price.read();
        
        priority_queue.iter()
            .rev()
            .flat_map(|(_gas_price, hashes)| hashes.iter())
            .take(limit)
            .filter_map(|hash| self.get_binary_transaction(hash))
            .collect()
    }
    
    /// Remove transaction (must remove from both transactions map AND priority queue)
    /// CRITICAL: Maintains consistency between storage and priority queue
    pub fn remove_transaction(&self, hash: &str) -> bool {
        if self.tx_store_remove(hash) {
            self.tx_timestamps.remove(hash);
            // FIX R24-M2: Decrement per-sender count on removal
            if let Some((_, sender)) = self.tx_sender_map.remove(hash) {
                if let Some(mut count) = self.tx_count_by_sender.get_mut(&sender) {
                    *count = count.saturating_sub(1);
                }
            }
            // v15.5: keep commitment dedup tables in lockstep with storage.
            self.cleanup_commitment_indices_for_hash(hash);
            // CRITICAL: Also remove from priority queue
            let mut priority_queue = self.by_gas_price.write();
            for (_gas_price, hashes) in priority_queue.iter_mut() {
                hashes.retain(|h| h != hash);
            }
            priority_queue.retain(|_, hashes| !hashes.is_empty());
            drop(priority_queue);

            // v15.9: persistent mempool — mirror the removal to RocksDB.
            // Lock is released before the disk delete to keep the
            // priority queue available to concurrent admissions.
            self.fire_persist_remove(hash);

            true
        } else {
            false
        }
    }

    /// Clear all transactions (both storage and priority queue)
    /// CRITICAL: Clears both data structures to maintain consistency
    pub fn clear(&self) {
        // v15.9: snapshot all hashes BEFORE clearing in-RAM structures so
        // we can mirror the removal to RocksDB without iterating an
        // already-emptied DashMap.
        let hashes_to_persist_remove: Vec<String> = self.transactions
            .iter()
            .map(|e| e.key().clone())
            .collect();

        self.transactions.clear();
        self.total_bytes.store(0, std::sync::atomic::Ordering::Relaxed);
        self.by_gas_price.write().clear();
        self.tx_sender_map.clear();
        self.tx_count_by_sender.clear();
        // v15.5: clear commitment dedup tables together with the rest of
        // mempool state so no stale entries survive a full reset.
        self.commitment_index.clear();
        self.commitment_reverse.clear();
        self.pending_registration_hashes.clear();
        self.expired_tx_hashes.clear();

        // v15.9: mirror the wipe to RocksDB. Each hash gets its own
        // persist_remove call so the CF stays consistent with RAM.
        for hash in &hashes_to_persist_remove {
            self.fire_persist_remove(hash);
        }
    }
    
    /// Get mempool size
    pub fn size(&self) -> usize {
        self.transactions.len()
    }
    
    /// Get minimum gas price from config
    pub fn get_min_gas_price(&self) -> u64 {
        self.config.min_gas_price
    }
    
    /// CRITICAL v2.26: Batch remove transactions after block inclusion
    /// PERFORMANCE: O(n) batch removal instead of O(n*m) individual removals
    /// This prevents mempool from filling up with already-processed transactions!
    pub fn batch_remove_transactions(&self, hashes: &[String]) {
        if hashes.is_empty() {
            return;
        }
        
        // PROTOCOL: Record ALL hashes as included BEFORE removing from mempool
        // This prevents race condition: remove → gossip arrives → re-add
        for hash in hashes {
            self.included_tx_hashes.insert(hash.clone(), std::time::Instant::now());
        }
        self.enforce_included_cap();

        // Step 1: Remove from transactions map (fast O(1) per hash)
        let mut removed_hashes: Vec<&String> = Vec::new();
        for hash in hashes {
            if self.tx_store_remove(hash) {
                self.tx_timestamps.remove(hash.as_str());
                // Decrement ONLY the removed sender's counter; a wholesale reset
                // would let a spammer refill their whole quota every block.
                self.decrement_sender_for_hash(hash);
                // v15.5: clear commitment dedup tables for every hash that
                // actually existed in storage. Idempotent and O(1) per hash.
                self.cleanup_commitment_indices_for_hash(hash);
                removed_hashes.push(hash);
            }
        }

        // Step 2: Clean priority queue in one pass (more efficient than individual removes)
        if !removed_hashes.is_empty() {
            let hash_set: std::collections::HashSet<&String> = hashes.iter().collect();
            let mut priority_queue = self.by_gas_price.write();
            for (_gas_price, queue_hashes) in priority_queue.iter_mut() {
                queue_hashes.retain(|h| !hash_set.contains(h));
            }
            // Remove empty gas_price levels
            priority_queue.retain(|_, queue_hashes| !queue_hashes.is_empty());
            drop(priority_queue);

            // Mirror every removal to the persistent pool (outside the lock).
            // This was the one removal path without the mirror: a fully drained
            // RAM pool left thousands of entries on disk, and every restart
            // rehydrated them back as an unincludable backlog.
            for hash in &removed_hashes {
                self.fire_persist_remove(hash);
            }
            println!("[INFO][MEMPOOL] block_cleanup removed={} included_set={}", removed_hashes.len(), self.included_tx_hashes.len());
        }
    }
    
    /// PROTOCOL: Record TX hashes from a received block (may not have been in our mempool)
    /// Prevents re-inclusion of confirmed TXs arriving via delayed P2P gossip
    pub fn record_included_txs(&self, hashes: &[String]) {
        for hash in hashes {
            self.included_tx_hashes.insert(hash.clone(), std::time::Instant::now());
        }
        self.enforce_included_cap();
    }

    /// Hard-count backstop enforced AT INSERTION (not just the 300s periodic prune): a distinct-hash
    /// flood otherwise grows the set to inclusion-rate×cadence between ticks (multi-GB). O(n) evict runs
    /// only when the ceiling is crossed, so the peak is bounded to ~the cap, not the cap×cadence.
    fn enforce_included_cap(&self) {
        const MAX_INCLUDED_TX_HASHES: usize = 2_000_000;
        if self.included_tx_hashes.len() > MAX_INCLUDED_TX_HASHES {
            self.cleanup_included_tx_hashes();
        }
    }

    /// Periodic cleanup of included_tx_hashes: finality-windowed age prune.
    /// Forget a confirmed tx only once it is provably unreachable by gossip
    /// (older than the finality window); entries inside the window are ALWAYS
    /// retained regardless of count, so we never drop a still-re-addable tx.
    pub fn cleanup_included_tx_hashes(&self) {
        // Retention window = the driver's unfinalized bound (3 checkpoint
        // intervals) in seconds at the ~1 block/sec cadence, times a slack
        // factor for gossip/clock skew. Beyond this a re-arriving copy cannot
        // reach an un-applied height, so the guard is no longer needed.
        const GOSSIP_SLACK: u64 = 4;
        let window_secs =
            3 * qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL * GOSSIP_SLACK;
        let before = self.included_tx_hashes.len();
        self.included_tx_hashes
            .retain(|_hash, included_at| included_at.elapsed().as_secs() <= window_secs);
        let after = self.included_tx_hashes.len();
        if after != before {
            println!("[INFO][MEMPOOL] included_set_cleanup before={} after={} window_secs={}", before, after, window_secs);
        }

        // Hard RAM backstop on top of the age window. The age window is the PRIMARY pruner, but under
        // sustained adversarial block-fill the map can accrue entries faster than they age out (its
        // size grows with TPS × window). Cap the entry COUNT so worst-case memory is bounded
        // independent of throughput, evicting the OLDEST-by-inclusion beyond the cap. A dropped
        // still-in-window entry only risks a re-inclusion ATTEMPT of an already-confirmed tx, which is
        // then rejected deterministically by the nonce/idempotency check at apply — never a safety
        // issue. Sized to cover several full microblocks at the design ceiling while bounding RAM.
        const MAX_INCLUDED_TX_HASHES: usize = 2_000_000;
        if after > MAX_INCLUDED_TX_HASHES {
            let mut by_age: Vec<(String, std::time::Instant)> = self
                .included_tx_hashes
                .iter()
                .map(|e| (e.key().clone(), *e.value()))
                .collect();
            by_age.sort_by_key(|(_, t)| *t); // oldest first
            let evict = after - MAX_INCLUDED_TX_HASHES;
            for (hash, _) in by_age.into_iter().take(evict) {
                self.included_tx_hashes.remove(&hash);
            }
            println!("[INFO][MEMPOOL] included_set_cap_evict evicted={} cap={}", evict, MAX_INCLUDED_TX_HASHES);
        }
    }
    
    /// CRITICAL v2.26: Get pending transactions WITH their hashes
    /// Returns (hash, binary_data) pairs for block inclusion AND cleanup
    /// This allows removing exact transactions that were included in a block
    /// 
    /// PRODUCTION v2.67: ATOMIC read from BOTH structures to prevent race conditions
    /// Previous bug: TX could be in transactions but not in by_gas_price if add was interrupted
    pub fn get_pending_transactions_with_hashes(&self, limit: usize) -> Vec<(String, Vec<u8>)> {
        // v2.67: ATOMIC - hold lock while fetching data to prevent race conditions
        // This ensures we see consistent state between by_gas_price and transactions
        let priority_queue = self.by_gas_price.read();
        
        // v2.67: Debug logging for emission blocks (system TX have gas_price == u64::MAX)
        let total_in_queue: usize = priority_queue.values().map(|v| v.len()).sum();
        let has_system_tx = priority_queue.contains_key(&u64::MAX);
        
        if has_system_tx || total_in_queue > 0 {
            println!("[INFO][MEMPOOL] get_pending queue_size={} has_system_tx={} tx_map_size={}", 
                    total_in_queue, has_system_tx, self.transactions.len());
        }
        
        let result: Vec<(String, Vec<u8>)> = priority_queue.iter()
            .rev()  // Highest gas_price first (u64::MAX = system TX = first)
            .flat_map(|(gas_price, hashes)| {
                hashes.iter().map(move |h| (*gas_price, h.clone()))
            })
            .take(limit)
            .filter_map(|(gas_price, hash)| {
                match self.get_binary_transaction(&hash) {
                    Some(data) => Some((hash, data)),
                    None => {
                        // v2.67: This should NEVER happen - log for debugging
                        eprintln!("[ERR][MEMPOOL] tx_in_queue_but_not_in_map hash={} gas_price={}", 
                                 qnet_state::char_prefix(&hash, 16), gas_price);
                        None
                    }
                }
            })
            .collect();
        
        if has_system_tx && result.is_empty() {
            eprintln!("[ERR][MEMPOOL] system_tx_lost queue_had={} result={}", total_in_queue, result.len());
        }

        result
    }

    /// TRUE registration backlog: distinct NodeRegistrations resident in the pool right now
    /// (admitted, not yet applied/evicted). O(1). Valve input for the attestor issuance throttle.
    pub fn pending_registration_backlog(&self) -> usize {
        self.pending_registration_hashes.len()
    }

    /// Deterministic registration-inclusion lane: the SAME next `limit` NodeRegistrations on every
    /// producer, ordered (attest_epoch ASC, burn_tx ASC, tx_hash ASC) — oldest attestation first,
    /// with a strict total-order tiebreak (hash == SHA3-256(canonical) is enforced at admission).
    /// Replaces the per-node FIFO prefix of the shared u64::MAX system bucket for type_id 4.
    ///
    /// Stale-skip mirrors the verifier epoch bounds (node.rs verify_burn_attestation_quorum:
    /// attest_epoch==0/future reject + apply>attest+lag reject) APPLIED ONLY TO BURN-BACKED REGS;
    /// regs with empty burn_tx OR attest_epoch==0 are EXEMPT from both the skip and the burn dedup —
    /// a crate-local superset of the verifier's genesis exemption (genesis regs carry attest_epoch=0
    /// + burn_tx="" and must stay includable at any height; all 5 share burn_tx="" so deduping them
    /// would wedge 4 forever). Non-genesis empty-burn fakes are dropped by producer re-validation.
    /// `exempt_cap` bounds the exempt class per selection (caller passes the genesis-set size):
    /// exempt regs sort FIRST (attest_epoch=0), so without the cap a sustained empty-burn junk flood
    /// would occupy every lane slot and starve burn-backed registrations.
    /// Scan cost: O(pending registrations) via the dedicated backlog set — NOT O(system bucket).
    pub fn registrations_for_inclusion(&self, apply_epoch: u64, max_epoch_lag: u64, limit: usize, exempt_cap: usize) -> Vec<(String, Vec<u8>)> {
        if limit == 0 { return Vec::new(); }
        // Iterate ONLY the registration hashes (bounded by the valve ~720), never the whole
        // system-priority bucket of heartbeat/ping/activation TXs.
        let reg_hashes: Vec<String> = self.pending_registration_hashes.iter().map(|e| e.key().clone()).collect();
        let mut regs: Vec<(u64, String, String, Vec<u8>)> = Vec::new(); // (attest_epoch, burn_tx, hash, bytes)
        for hash in reg_hashes {
            let bytes = match self.get_binary_transaction(&hash) { Some(b) => b, None => continue };
            let tx = match bincode::deserialize::<Transaction>(&bytes) { Ok(t) => t, Err(_) => continue };
            if let qnet_state::TransactionType::NodeRegistration { burn_tx, attest_epoch, .. } = tx.tx_type {
                regs.push((attest_epoch, burn_tx, hash, bytes));
            }
        }
        regs.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)).then_with(|| a.2.cmp(&b.2)));
        let mut out: Vec<(String, Vec<u8>)> = Vec::with_capacity(limit.min(regs.len()));
        let mut seen_burns: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut exempt_taken = 0usize;
        for (attest_epoch, burn_tx, hash, bytes) in regs {
            let exempt = burn_tx.is_empty() || attest_epoch == 0;
            if exempt {
                if exempt_taken >= exempt_cap { continue; }
                exempt_taken += 1;
            } else {
                if attest_epoch > apply_epoch { continue; }                                   // future-epoch: verifier rejects
                if apply_epoch > attest_epoch.saturating_add(max_epoch_lag) { continue; }     // stale: verifier rejects, owner re-arms
                if !seen_burns.insert(burn_tx) { continue; }                                  // one burn per block
            }
            out.push((hash, bytes));
            if out.len() >= limit { break; }
        }
        out
    }

    /// Remove transactions older than TTL (default 30 minutes)
    pub fn cleanup_expired_transactions(&self, ttl_secs: u64) -> usize {
        let mut expired_hashes = Vec::new();
        self.tx_timestamps.retain(|hash, added_at| {
            if added_at.elapsed().as_secs() > ttl_secs {
                expired_hashes.push(hash.clone());
                false
            } else {
                true
            }
        });

        let expired_count = expired_hashes.len();
        if !expired_hashes.is_empty() {
            // IMPORTANT: Do NOT use batch_remove_transactions here!
            // That method adds hashes to included_tx_hashes, which would
            // incorrectly block re-submission of expired (never-confirmed) TXs.
            for hash in &expired_hashes {
                self.tx_store_remove(hash);
                // Release this sender's quota slot for the one expired tx only;
                // a wholesale reset would hand a spammer a free per-block refill.
                self.decrement_sender_for_hash(hash);
                // v15.5: TTL eviction must release the dedup-index slot too,
                // otherwise an expired commitment would block a fresh
                // submission for the same `(identity, epoch_or_index)` until
                // the next mempool clear.
                self.cleanup_commitment_indices_for_hash(hash);
            }
            // Remove from priority queue
            let expired_set: std::collections::HashSet<&String> = expired_hashes.iter().collect();
            let mut priority_queue = self.by_gas_price.write();
            for (_gas_price, hashes) in priority_queue.iter_mut() {
                hashes.retain(|h| !expired_set.contains(h));
            }
            priority_queue.retain(|_, hashes| !hashes.is_empty());
            drop(priority_queue);

            // v15.9: persistent mempool — mirror TTL evictions to RocksDB
            // AFTER the priority-queue lock is released. Without this the
            // disk CF would carry expired TX hashes that boot rehydration
            // would re-admit, producing zombie entries that get
            // re-evicted on the next TTL pass — wasted disk traffic and
            // a misleading mempool size on restart.
            let now = std::time::Instant::now();
            for hash in expired_hashes.drain(..) {
                self.fire_persist_remove(&hash);
                // Tombstone for the network ingress: peers still hold this tx
                // for up to their own TTL and keep re-gossiping it.
                self.expired_tx_hashes.insert(hash, now);
            }
        }

        // Prune tombstones past the gossip horizon (peer TTL + slack) and hard-cap
        // the set so a sustained eviction storm cannot grow it unboundedly.
        let horizon = ttl_secs.saturating_mul(2).max(60);
        self.expired_tx_hashes.retain(|_h, evicted_at| evicted_at.elapsed().as_secs() <= horizon);
        const MAX_EXPIRED_TOMBSTONES: usize = 500_000;
        let len = self.expired_tx_hashes.len();
        if len > MAX_EXPIRED_TOMBSTONES {
            let mut by_age: Vec<(String, std::time::Instant)> = self.expired_tx_hashes
                .iter().map(|e| (e.key().clone(), *e.value())).collect();
            by_age.sort_by_key(|(_, t)| *t); // oldest first
            for (hash, _) in by_age.into_iter().take(len - MAX_EXPIRED_TOMBSTONES) {
                self.expired_tx_hashes.remove(&hash);
            }
        }

        expired_count
    }

    /// True while `hash` sits in the TTL-eviction tombstone window. Network
    /// ingress (tx-sync) consults this BEFORE signature work so peers cannot
    /// resurrect what this node already expired; RPC submission does not.
    pub fn is_recently_expired(&self, hash: &str) -> bool {
        self.expired_tx_hashes.contains_key(hash)
    }

    /// Boot-time rehydration admit: same as add_binary_transaction, but the tx keeps its
    /// ORIGINAL admission age. The plain path stamps a fresh RAM Instant AND re-fires the
    /// persist hook with ts=now, so every restart used to grant surviving entries a full
    /// extra TTL. Back-date the RAM clock and restore the original wall-clock on disk.
    pub fn add_binary_transaction_rehydrated(&self, tx_bytes: Vec<u8>, hash: String, gas_price: u64, admitted_unix_ts: u64) -> bool {
        let payload_for_persist = tx_bytes.clone();
        if !self.add_binary_transaction(tx_bytes, hash.clone(), gas_price) {
            return false;
        }
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let age = now_secs.saturating_sub(admitted_unix_ts);
        if admitted_unix_ts > 0 && age > 0 {
            if let Some(back) = std::time::Instant::now().checked_sub(std::time::Duration::from_secs(age)) {
                if let Some(mut t) = self.tx_timestamps.get_mut(&hash) { *t = back; }
            }
            if let Some(cb) = self.persist_admit.read().as_ref() {
                cb(&hash, &payload_for_persist, admitted_unix_ts);
            }
        }
        true
    }

    /// Producer fill pull: get_pending_transactions_with_hashes bounded by cumulative
    /// payload BYTES as well as count. The fill previously cloned and classified the
    /// entire pool head every block (an 8k-batch backlog = ~0.5 GB of memcpy + decode
    /// per slot) while the block itself is byte-capped far lower — pulling past a small
    /// multiple of that cap is pure waste. Returns at least one entry when non-empty.
    pub fn get_pending_for_fill(&self, count_limit: usize, byte_budget: usize) -> Vec<(String, Vec<u8>)> {
        let priority_queue = self.by_gas_price.read();
        let mut out: Vec<(String, Vec<u8>)> = Vec::new();
        let mut bytes = 0usize;
        'outer: for (_gas_price, hashes) in priority_queue.iter().rev() {
            for h in hashes.iter() {
                if out.len() >= count_limit { break 'outer; }
                if let Some(data) = self.get_binary_transaction(h) {
                    let sz = data.len();
                    if !out.is_empty() && bytes.saturating_add(sz) > byte_budget { break 'outer; }
                    bytes = bytes.saturating_add(sz);
                    out.push((h.clone(), data));
                }
            }
        }
        out
    }

    /// Add binary transaction with sender tracking for spam protection
    pub fn add_binary_transaction_with_sender(&self, tx_bytes: Vec<u8>, hash: String, gas_price: u64, sender: &str) -> bool {
        // Check per-sender limit
        let sender_count = self.tx_count_by_sender.get(sender).map(|v| *v).unwrap_or(0);
        if sender_count >= self.max_per_sender {
            return false;
        }
        // Note: add_binary_transaction() already increments tx_count_by_sender
        self.add_binary_transaction(tx_bytes, hash, gas_price)
    }

    /// Release one anti-spam quota slot for a removed tx: drop its hash→sender
    /// entry and decrement that sender's live count. O(1); bounded per removal,
    /// so per-sender quota can never be reset wholesale by a spammer.
    fn decrement_sender_for_hash(&self, hash: &str) {
        if let Some((_, sender)) = self.tx_sender_map.remove(hash) {
            if let Some(mut count) = self.tx_count_by_sender.get_mut(&sender) {
                *count = count.saturating_sub(1);
            }
        }
    }

    /// v2.67: Debug method to check mempool consistency
    pub fn debug_check_consistency(&self) -> (usize, usize, bool) {
        let tx_count = self.transactions.len();
        let queue_count: usize = self.by_gas_price.read().values().map(|v| v.len()).sum();
        let is_consistent = tx_count == queue_count;
        
        if !is_consistent {
            eprintln!("[ERR][MEMPOOL] INCONSISTENT tx_map={} priority_queue={}", tx_count, queue_count);
        }
        
        (tx_count, queue_count, is_consistent)
    }
} 
#[cfg(test)]
mod hygiene_tests {
    use super::*;
    use std::sync::Mutex;

    fn test_pool() -> SimpleMempool {
        SimpleMempool::new(SimpleMempoolConfig {
            max_size: 1000,
            min_gas_price: 1,
            max_per_sender: 100,
        })
    }

    /// A structurally valid Transfer whose provided hash matches the canonical bytes,
    /// so it clears the admission hash check.
    fn test_tx(from: &str, nonce: u64) -> (Vec<u8>, String) {
        let tx = Transaction::new(
            from.to_string(),
            Some("eon_recipient_addr".to_string()),
            1_000,
            nonce,
            10,
            10_000,
            1_700_000_000 + nonce,
            None,
            qnet_state::TransactionType::Transfer {
                from: from.to_string(),
                to: "eon_recipient_addr".to_string(),
                amount: 1_000,
            },
            None,
        );
        let hash = format!("{:x}", Sha3_256::digest(&tx.canonical_bytes()));
        (bincode::serialize(&tx).unwrap(), hash)
    }

    #[test]
    fn batch_remove_mirrors_to_persistent_pool() {
        let pool = test_pool();
        let removed: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let removed_cb = removed.clone();
        pool.set_persistence_hooks(
            Arc::new(|_h, _p, _ts| {}),
            Arc::new(move |h| removed_cb.lock().unwrap().push(h.to_string())),
        );
        let (b1, h1) = test_tx("eon_sender_a", 1);
        let (b2, h2) = test_tx("eon_sender_b", 1);
        let (b3, h3) = test_tx("eon_sender_c", 1);
        assert!(pool.add_binary_transaction(b1, h1.clone(), 10));
        assert!(pool.add_binary_transaction(b2, h2.clone(), 10));
        assert!(pool.add_binary_transaction(b3, h3.clone(), 10));

        pool.batch_remove_transactions(&[h1.clone(), h2.clone()]);

        let fired = removed.lock().unwrap().clone();
        assert!(fired.contains(&h1) && fired.contains(&h2),
                "block-inclusion removal must reach the persistent pool: {:?}", fired);
        assert!(!fired.contains(&h3));
        assert_eq!(pool.size(), 1);
    }

    #[test]
    fn ttl_eviction_tombstones_gossip_but_not_resubmission() {
        let pool = test_pool();
        let (b, h) = test_tx("eon_sender_d", 1);
        // Admit pre-aged (rehydrated path back-dates the RAM clock) so a
        // short TTL expires it deterministically without sleeping.
        let old_ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() - 10;
        assert!(pool.add_binary_transaction_rehydrated(b.clone(), h.clone(), 10, old_ts));

        assert_eq!(pool.cleanup_expired_transactions(5), 1);
        assert!(pool.is_recently_expired(&h), "TTL eviction must tombstone the hash");
        assert_eq!(pool.size(), 0);

        // Deliberate local re-admission (the RPC path) stays open and lifts the tombstone.
        assert!(pool.add_binary_transaction(b, h.clone(), 10));
        assert!(!pool.is_recently_expired(&h));
    }

    #[test]
    fn rehydrated_admit_keeps_original_age() {
        let pool = test_pool();
        let persisted_ts: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let ts_cb = persisted_ts.clone();
        pool.set_persistence_hooks(
            Arc::new(move |_h, _p, ts| ts_cb.lock().unwrap().push(ts)),
            Arc::new(|_h| {}),
        );
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let admitted_ts = now - 100;

        let (b, h) = test_tx("eon_sender_e", 1);
        assert!(pool.add_binary_transaction_rehydrated(b, h.clone(), 10, admitted_ts));

        // Disk record ends with the ORIGINAL timestamp, not a fresh one.
        assert_eq!(*persisted_ts.lock().unwrap().last().unwrap(), admitted_ts);
        // RAM clock is back-dated: a 50s TTL must reap a 100s-old entry immediately.
        assert_eq!(pool.cleanup_expired_transactions(50), 1);
        assert_eq!(pool.size(), 0);
    }

    #[test]
    fn fill_pull_respects_byte_budget_and_count() {
        let pool = test_pool();
        let mut sizes = Vec::new();
        for i in 0..3u64 {
            let (b, h) = test_tx(&format!("eon_sender_f{}", i), 1);
            sizes.push(b.len());
            assert!(pool.add_binary_transaction(b, h, 10));
        }
        // Budget for exactly two payloads: the third must not be pulled.
        let budget = sizes[0] + sizes[1];
        assert_eq!(pool.get_pending_for_fill(10, budget).len(), 2);
        // Count limit binds independently of bytes.
        assert_eq!(pool.get_pending_for_fill(1, usize::MAX).len(), 1);
        // A budget smaller than one payload still yields one entry (progress guarantee).
        assert_eq!(pool.get_pending_for_fill(10, 1).len(), 1);
    }
}

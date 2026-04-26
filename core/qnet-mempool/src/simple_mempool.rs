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

/// Optimized mempool implementation with binary support and priority queue
/// ARCHITECTURE: Priority-based transaction ordering for spam protection
pub struct SimpleMempool {
    config: SimpleMempoolConfig,
    transactions: Arc<DashMap<String, TxStorage>>, // hash -> json or binary
    // PRODUCTION: Priority queue (BTreeMap) sorted by gas_price descending
    // Key: gas_price (u64), Value: FIFO queue of tx hashes at that price
    by_gas_price: Arc<RwLock<BTreeMap<u64, VecDeque<String>>>>,
    use_binary: bool, // Toggle for binary storage
    // PROTOCOL-LEVEL: TX hashes confirmed in recent blocks (prevents re-inclusion after gossip)
    // Analogous to processed transaction signatures - standard L1 mechanism
    // Prevents race condition: TX removed from mempool by block → re-arrives via P2P → re-added
    included_tx_hashes: Arc<DashSet<String>>,
    /// Timestamp when each TX was added (for TTL eviction)
    tx_timestamps: DashMap<String, std::time::Instant>,
    /// Per-sender TX count for spam protection
    tx_count_by_sender: DashMap<String, u32>,
    /// FIX R24-M2: Track tx_hash → sender for decrementing count on removal
    tx_sender_map: DashMap<String, String>,
    /// Max transactions per sender
    max_per_sender: u32,
    // ════════════════════════════════════════════════════════════════════════
    // v15.5: COMMITMENT-CLASS TX DEDUPLICATION (sender+epoch replacement)
    // ════════════════════════════════════════════════════════════════════════
    // Forward index: `(identity, epoch_or_index, type_id)` → current canonical
    // hash for that logical commitment. On admission of a commitment-class
    // TX (HeartbeatCommitment, PingCommitmentWithSampling,
    // LightNodeEligibilityBitmap, NodeRegistration, NodeReactivation), this
    // index is consulted: any prior version with the same key is removed
    // from every storage structure before the new TX is inserted, so the
    // next producer can never pull two semantically-equivalent commitments
    // into a single block.
    //
    // Without this index, retries created TXs with different hashes (because
    // the per-attempt timestamp changed) which the hash-based dedup did not
    // catch — the explorer-observable duplication at h=29731 (4 nodes ×
    // 2 HeartbeatCommitment each) is the symptom this fixes.
    //
    // Scalability: lock-free `DashMap` keyed on a tight `(String, u64, u8)`
    // tuple; admissions are O(1) and entries are bounded by the count of
    // distinct logical commitments currently in flight (≤ active validator
    // committee size per type — well-bounded at thousands of nodes).
    //
    // Identity / epoch derivation in `Transaction::commitment_dedup_key`
    // MIRRORS `state.rs::check_duplicate_commitment` 1-to-1, so the mempool
    // can never admit a TX that would later be rejected at apply time as
    // a duplicate of one already on chain.
    commitment_index: Arc<DashMap<(String, u64, u8), String>>,
    /// Reverse index: `tx_hash → (identity, epoch_or_index, type_id)`. Used
    /// when a TX leaves the mempool by any path (replacement, block
    /// inclusion, eviction, expiration, explicit removal, clear) so the
    /// forward index can be cleaned up without re-parsing the TX bytes.
    /// Sized identically to `commitment_index`; both are maintained as a
    /// pair under the same admission/removal logic.
    commitment_reverse: Arc<DashMap<String, (String, u64, u8)>>,
}

impl SimpleMempool {
    /// Create new optimized mempool with priority queue
    /// PRODUCTION: Priority-based ordering for spam protection (highest gas_price first)
    pub fn new(config: SimpleMempoolConfig) -> Self {
        // Use binary for large mempools (>100k)
        let use_binary = config.max_size > 100_000;
        let max_per_sender = config.max_per_sender.try_into().unwrap_or(10_000);
        Self {
            config,
            transactions: Arc::new(DashMap::new()),
            by_gas_price: Arc::new(RwLock::new(BTreeMap::new())),
            use_binary,
            included_tx_hashes: Arc::new(DashSet::new()),
            tx_timestamps: DashMap::new(),
            tx_count_by_sender: DashMap::new(),
            tx_sender_map: DashMap::new(),
            max_per_sender,
            // v15.5: commitment-class dedup indices (see struct doc)
            commitment_index: Arc::new(DashMap::new()),
            commitment_reverse: Arc::new(DashMap::new()),
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

        let old_hash = match self.commitment_index.entry(key.clone()) {
            Entry::Occupied(mut e) => Some(std::mem::replace(e.get_mut(), new_hash.to_string())),
            Entry::Vacant(e) => {
                e.insert(new_hash.to_string());
                None
            }
        };

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
            self.transactions.remove(old);
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
            self.commitment_index.remove_if(&key, |_, current| current == hash);
        }
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
                         &hash[..16.min(hash.len())], e);
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
        let effective_priority = if is_system { u64::MAX } else { gas_price };
        if self.transactions.len() >= self.config.max_size {
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
                        self.transactions.remove(&tx_hash);
                        self.tx_timestamps.remove(&tx_hash);
                        // v15.5: keep commitment dedup tables proportional to
                        // live mempool occupancy when low-priority eviction
                        // drops a commitment-class TX.
                        self.cleanup_commitment_indices_for_hash(&tx_hash);
                        println!("[INFO][MEMPOOL] evicted_low_priority gas={} for_new_gas={} new_is_system={}",
                                 lowest_gas, effective_priority, is_system);
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
        if self.included_tx_hashes.contains(&hash) {
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
                     &hash[..16.min(hash.len())], &computed_hash[..16.min(computed_hash.len())]);
            return false;
        }

        // ═══════════════════════════════════════════════════════════════════
        // v15.5: COMMITMENT REPLACEMENT — single-version-in-mempool guarantee
        // for the deterministic-(identity, epoch_or_index) TX class. Any
        // prior version sharing the same dedup key is removed from every
        // storage layer here, BEFORE per-sender count and storage insertion,
        // so the count and capacity bookkeeping that follows reflects the
        // post-replacement state. Non-commitment TXs return None and skip
        // this branch with one DashMap miss of overhead.
        // ═══════════════════════════════════════════════════════════════════
        let commitment_key = parsed_tx.commitment_dedup_key();
        if let Some(ref key) = commitment_key {
            if let Some(old_hash) = self.replace_or_register_commitment(key.clone(), &hash) {
                println!("[INFO][MEMPOOL] commitment_replaced id={} epoch={} type={} old={} new={}",
                         &key.0[..16.min(key.0.len())], key.1, key.2,
                         &old_hash[..16.min(old_hash.len())],
                         &hash[..16.min(hash.len())]);
            }
        }

        // FIX L-M9: Per-sender limit defense-in-depth
        if !parsed_tx.from.is_empty() {
            let mut sender_count = self.tx_count_by_sender
                .entry(parsed_tx.from.clone())
                .or_insert(0);
            if *sender_count >= self.max_per_sender {
                println!("[WARN][MEMPOOL] per_sender_limit sender={} count={} max={}",
                         &parsed_tx.from[..16.min(parsed_tx.from.len())], *sender_count, self.max_per_sender);
                // v15.5: roll back the commitment registration we just made
                // so a count-rejected TX does not leave a dangling forward-
                // index entry pointing at a hash that never enters storage.
                if let Some(ref key) = commitment_key {
                    self.commitment_index.remove_if(key, |_, current| current == &hash);
                    self.commitment_reverse.remove(&hash);
                }
                return false;
            }
            *sender_count += 1;
            self.tx_sender_map.insert(hash.clone(), parsed_tx.from.clone());
        }

        // Store as binary if enabled (50% space saving)
        let storage = if self.use_binary {
            TxStorage::Binary(tx_json.as_bytes().to_vec())
        } else {
            TxStorage::Json(tx_json)
        };

        // v2.67: CRITICAL - Add to BOTH structures atomically under priority queue lock
        {
            let mut priority_queue = self.by_gas_price.write();

            // Double-check inside lock
            if self.transactions.contains_key(&hash) {
                return false;
            }

            self.transactions.insert(hash.clone(), storage);
            self.tx_timestamps.insert(hash.clone(), std::time::Instant::now());
            // v14.8.4: System TXs keyed at u64::MAX so block producers drain
            // them first — protocol bootstrap cannot be delayed by user TXs.
            priority_queue
                .entry(effective_priority)
                .or_insert_with(VecDeque::new)
                .push_back(hash);
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
    pub fn add_binary_transaction(&self, tx_bytes: Vec<u8>, hash: String, gas_price: u64) -> bool {
        // v14.8.4: Parse once up front so we can classify user vs system TX
        // and apply the correct fee policy. See `add_raw_transaction` for
        // the rationale behind the system-TX bypass.
        let parsed_tx = match bincode::deserialize::<Transaction>(&tx_bytes) {
            Ok(tx) => tx,
            Err(e) => {
                eprintln!("[ERR][MEMPOOL] deserialize_failed hash={} error={}",
                         &hash[..16.min(hash.len())], e);
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

        let effective_priority = if is_system { u64::MAX } else { gas_price };

        // FIX M-H15: Evict lowest-priority TX when mempool is full
        if self.transactions.len() >= self.config.max_size {
            let mut priority_queue = self.by_gas_price.write();
            if let Some(mut lowest_entry) = priority_queue.first_entry() {
                let lowest_gas = *lowest_entry.key();
                if effective_priority > lowest_gas {
                    if let Some(tx_hash) = lowest_entry.get().front().cloned() {
                        lowest_entry.get_mut().pop_front();
                        if lowest_entry.get().is_empty() {
                            lowest_entry.remove();
                        }
                        self.transactions.remove(&tx_hash);
                        self.tx_timestamps.remove(&tx_hash);
                        // v15.5: keep commitment dedup tables proportional to
                        // live mempool occupancy when low-priority eviction
                        // drops a commitment-class TX.
                        self.cleanup_commitment_indices_for_hash(&tx_hash);
                        println!("[INFO][MEMPOOL] evicted_low_priority gas={} for_new_gas={} new_is_system={}",
                                 lowest_gas, effective_priority, is_system);
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
        if self.included_tx_hashes.contains(&hash) {
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
                     &hash[..16.min(hash.len())], &computed_hash[..16.min(computed_hash.len())]);
            return false;
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
        let commitment_key = parsed_tx.commitment_dedup_key();
        if let Some(ref key) = commitment_key {
            if let Some(old_hash) = self.replace_or_register_commitment(key.clone(), &hash) {
                println!("[INFO][MEMPOOL] commitment_replaced id={} epoch={} type={} old={} new={}",
                         &key.0[..16.min(key.0.len())], key.1, key.2,
                         &old_hash[..16.min(old_hash.len())],
                         &hash[..16.min(hash.len())]);
            }
        }

        // Per-sender limit (defense in depth)
        let sender = &parsed_tx.from;
        if !sender.is_empty() {
            let mut sender_count = self.tx_count_by_sender.entry(sender.clone()).or_insert(0);
            if *sender_count >= self.max_per_sender {
                println!("[WARN][MEMPOOL] per_sender_limit sender={}.. count={}",
                         &sender[..16.min(sender.len())], *sender_count);
                // v15.5: roll back the commitment registration on count
                // rejection to keep dedup indices in lockstep with storage.
                if let Some(ref key) = commitment_key {
                    self.commitment_index.remove_if(key, |_, current| current == &hash);
                    self.commitment_reverse.remove(&hash);
                }
                return false;
            }
            *sender_count += 1;
            self.tx_sender_map.insert(hash.clone(), sender.clone());
        }

        // v2.67: CRITICAL - Add to BOTH structures atomically under priority queue lock
        // This prevents race condition where TX is in transactions but not in priority queue
        {
            let mut priority_queue = self.by_gas_price.write();

            // Double-check inside lock to prevent duplicates
            if self.transactions.contains_key(&hash) {
                return false;
            }

            // Add to transactions first
            self.transactions.insert(hash.clone(), TxStorage::Binary(tx_bytes));
            self.tx_timestamps.insert(hash.clone(), std::time::Instant::now());

            // Then add to priority queue (same lock scope)
            priority_queue
                .entry(effective_priority)
                .or_insert_with(VecDeque::new)
                .push_back(hash.clone());

            // v2.67: Verify consistency for system TX at top-priority slot
            if is_system {
                let queue_has = priority_queue.get(&u64::MAX)
                    .map(|v| v.contains(&hash))
                    .unwrap_or(false);
                let tx_has = self.transactions.contains_key(&hash);

                println!("[INFO][MEMPOOL] system_tx_added hash={} size={} queue={} tx={}",
                        &hash[..16.min(hash.len())], self.transactions.len(), queue_has, tx_has);

                if !queue_has || !tx_has {
                    eprintln!("[ERR][MEMPOOL] system_tx_add_failed hash={}", &hash[..16.min(hash.len())]);
                }
            }
        }
        
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
        if available_space == 0 {
            return 0;
        }

        let mut added = 0usize;

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

            // ═══════════════════════════════════════════════════════════════
            // v15.5: COMMITMENT DEDUP FOR TRUSTED BATCH PATH.
            //
            // Without this branch the trusted-batch ingestion would bypass
            // the per-receive replacement that single-TX paths enforce, and
            // a commitment-class TX flowing through this path could leave a
            // stale prior version in the local mempool. Producer-side
            // filtering would still keep duplicates out of any block, but
            // the mempool itself would temporarily carry redundant entries
            // — a divergence from the top-tier L1 invariant of "one
            // canonical version per logical commitment in mempool".
            //
            // The replacement is inlined here (rather than delegated to
            // `replace_or_register_commitment`) because the helper acquires
            // its own write on `by_gas_price`, and we already hold that
            // lock for the duration of the batch. Inlining avoids a
            // re-entrant lock attempt while preserving identical
            // semantics for the dedup indices.
            //
            // Fast path: only parse TXs whose gas_price hint marks them as
            // system-class (u64::MAX). User TXs — the bulk of any trusted
            // batch — skip parsing entirely and pay only a single `u64`
            // comparison of overhead. Worst case (a batch of all
            // commitments at an epoch boundary) parses each TX exactly
            // once with no extra lock acquisitions.
            // ═══════════════════════════════════════════════════════════════
            let key_opt = if gas_price == u64::MAX {
                bincode::deserialize::<Transaction>(&tx_bytes)
                    .ok()
                    .and_then(|tx| tx.commitment_dedup_key())
            } else {
                None
            };

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

                if let Some(old) = prev_hash {
                    // Evict the prior version from every storage layer.
                    // The priority-queue removal happens inside the held
                    // lock so the transition is atomic with the new
                    // insertion below.
                    self.commitment_reverse.remove(&old);
                    self.transactions.remove(&old);
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
                             &key.0[..16.min(key.0.len())], key.1, key.2,
                             &old[..16.min(old.len())],
                             &hash[..16.min(hash.len())]);
                }
            }

            // TRUSTED: Skip hash verification - caller guarantees correctness
            // Insert into BOTH structures within the same lock scope
            self.transactions.insert(hash.clone(), TxStorage::Binary(tx_bytes));
            self.tx_timestamps.insert(hash.clone(), std::time::Instant::now());
            priority_queue
                .entry(gas_price)
                .or_insert_with(VecDeque::new)
                .push_back(hash);
            added += 1;
        }

        // Drop empty priority levels created by commitment evictions above
        // so the queue stays compact across batch boundaries.
        priority_queue.retain(|_, hashes| !hashes.is_empty());

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
        if self.transactions.remove(hash).is_some() {
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
            true
        } else {
            false
        }
    }

    /// Clear all transactions (both storage and priority queue)
    /// CRITICAL: Clears both data structures to maintain consistency
    pub fn clear(&self) {
        self.transactions.clear();
        self.by_gas_price.write().clear();
        self.tx_sender_map.clear();
        self.tx_count_by_sender.clear();
        // v15.5: clear commitment dedup tables together with the rest of
        // mempool state so no stale entries survive a full reset.
        self.commitment_index.clear();
        self.commitment_reverse.clear();
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
            self.included_tx_hashes.insert(hash.clone());
        }
        
        // Step 1: Remove from transactions map (fast O(1) per hash)
        let mut removed_count = 0;
        for hash in hashes {
            if self.transactions.remove(hash).is_some() {
                self.tx_timestamps.remove(hash.as_str());
                // v15.5: clear commitment dedup tables for every hash that
                // actually existed in storage. Idempotent and O(1) per hash.
                self.cleanup_commitment_indices_for_hash(hash);
                removed_count += 1;
            }
        }

        // Step 2: Clean priority queue in one pass (more efficient than individual removes)
        if removed_count > 0 {
            let hash_set: std::collections::HashSet<&String> = hashes.iter().collect();
            let mut priority_queue = self.by_gas_price.write();
            for (_gas_price, queue_hashes) in priority_queue.iter_mut() {
                queue_hashes.retain(|h| !hash_set.contains(h));
            }
            // Remove empty gas_price levels
            priority_queue.retain(|_, queue_hashes| !queue_hashes.is_empty());
        }
        
        if removed_count > 0 {
            // FIX L-M16: Reset sender counts after bulk removal
            self.reset_sender_counts();
            println!("[INFO][MEMPOOL] block_cleanup removed={} included_set={}", removed_count, self.included_tx_hashes.len());
        }
    }
    
    /// PROTOCOL: Record TX hashes from a received block (may not have been in our mempool)
    /// Prevents re-inclusion of confirmed TXs arriving via delayed P2P gossip
    pub fn record_included_txs(&self, hashes: &[String]) {
        for hash in hashes {
            self.included_tx_hashes.insert(hash.clone());
        }
    }
    
    /// Periodic cleanup of included_tx_hashes to prevent unbounded growth
    /// Safe to call periodically - evicts ~50% when set exceeds threshold
    /// ARCHITECTURE: 100K entries ≈ 100K blocks worth of TXs (at ~1 TX/block avg)
    /// At 1 block/sec that's ~28 hours of history - more than enough for gossip delay
    /// FIX L-M17: More aggressive cleanup -- retain ~25% to favor recent entries
    /// Uses 2-bit mask for probabilistic retention (deterministic per hash)
    pub fn cleanup_included_tx_hashes(&self) {
        const MAX_INCLUDED_SIZE: usize = 100_000;
        let current_size = self.included_tx_hashes.len();
        if current_size > MAX_INCLUDED_SIZE {
            // Retain ~25% by hash prefix (2-bit mask)
            self.included_tx_hashes.retain(|hash| {
                hash.as_bytes().first().map(|b| b & 3 == 0).unwrap_or(false)
            });
            println!("[INFO][MEMPOOL] included_set_cleanup before={} after={}", current_size, self.included_tx_hashes.len());
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
                                 &hash[..16.min(hash.len())], gas_price);
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

        if !expired_hashes.is_empty() {
            // IMPORTANT: Do NOT use batch_remove_transactions here!
            // That method adds hashes to included_tx_hashes, which would
            // incorrectly block re-submission of expired (never-confirmed) TXs.
            for hash in &expired_hashes {
                self.transactions.remove(hash);
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

            // FIX L-M16: Reset sender counts after bulk removal to stay accurate
            // Without per-TX sender tracking, a full reset is the safest approach
            self.reset_sender_counts();
        }

        expired_hashes.len()
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

    /// Reset per-sender counts (call periodically, e.g., every block)
    pub fn reset_sender_counts(&self) {
        self.tx_count_by_sender.clear();
        self.tx_sender_map.clear();
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
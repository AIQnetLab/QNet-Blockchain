//! Snapshot creation, chunked transfer, consensus binding, staging promotion and fast sync.

use super::*;

impl Storage {
    /// Create state snapshot at the given height (snapshot system for fast
    /// node sync; runs at every INCREMENTAL_INTERVAL boundary).
    ///
    /// Always writes a FULL snapshot. The old incremental path wrote an
    /// empty `delta_{height}` placeholder no consumer read, so the
    /// `snapshot_root` consensus binding only activated on the 12h FULL
    /// boundary — 11/12 hourly boundaries fell through to legacy_accept and
    /// the L4 defence stayed dormant. Now one canonical full_snap_{height}
    /// per boundary feeds the receiver, snapshot_root, and the rollback
    /// reconciler alike. Runs on the blocking pool (seconds at 1M+
    /// accounts); a real delta path is future work.
    // (sync, at a macroblock boundary) Flush the hot account set + pin a frozen
    // DB view at this height. The caller invokes this synchronously in the apply
    // path (before H+1 mutates the CF), then hands the view to the async
    // create_*_snapshot serializer. Proxy to PersistentStorage.
    pub fn prepare_snapshot_view(
        &self,
        hot_accounts: &[(String, qnet_state::Account)],
    ) -> IntegrationResult<PinnedDbSnapshot> {
        self.persistent.prepare_snapshot_view(hot_accounts)
    }

    /// O(1) RocksDB estimate of total persisted accounts — the TOTAL on-disk
    /// account count (every hot ∪ cold row in the "accounts" CF), NOT the bounded
    /// LRU cache size. Best-effort: unwraps to 0 on missing CF / None / Err so it
    /// never panics. node.rs uses it for the merkle-store auto-heuristic.
    pub fn estimate_account_count(&self) -> u64 {
        self.persistent.db.cf_handle("accounts")
            .and_then(|cf| self.persistent.db
                .property_int_value_cf(&cf, "rocksdb.estimate-num-keys")
                .ok()
                .flatten())
            .unwrap_or(0)
    }

    pub fn record_checkpoint_vote(&self, index: u64, window_head: u64, content_digest: &[u8; 32],
                                  pinned: bool, parent_index: u64, parent_hash: &[u8; 32])
        -> IntegrationResult<()> {
        self.persistent.record_checkpoint_vote(index, window_head, content_digest, pinned,
                                               parent_index, parent_hash)
    }
    pub fn load_checkpoint_votes(&self)
        -> IntegrationResult<Vec<(u64, u64, [u8; 32], bool, u64, [u8; 32])>> {
        self.persistent.load_checkpoint_votes()
    }
    pub fn put_galc_held(&self, bytes: &[u8]) -> IntegrationResult<()> { self.persistent.put_galc_held(bytes) }
    pub fn get_galc_held(&self) -> IntegrationResult<Option<Vec<u8>>> { self.persistent.get_galc_held() }
    /// The macroblock index this node cold-joined at, or 0 for a from-genesis node.
    ///
    /// This is the ONE honest test for "the data is missing because *I* joined late" versus "the data is
    /// missing on every node". Absence below the anchor is local blindness and the node must abstain;
    /// absence at or above it is a fact the whole network shares, and abstaining on a shared fact is how
    /// a recoverable state becomes a permanent halt — nobody signals, ever.
    pub fn snapshot_join_anchor_mb(&self) -> u64 {
        self.persistent.get_snapshot_anchor().ok().flatten()
            .filter(|v| v.len() >= 8)
            .map(|v| { let mut b = [0u8; 8]; b.copy_from_slice(&v[..8]); u64::from_le_bytes(b) })
            .unwrap_or(0)
    }

    pub fn put_snapshot_anchor(&self, bytes: &[u8]) -> IntegrationResult<()> { self.persistent.put_snapshot_anchor(bytes) }
    pub fn get_snapshot_anchor(&self) -> IntegrationResult<Option<Vec<u8>>> { self.persistent.get_snapshot_anchor() }

    pub async fn create_incremental_snapshot(
        &self,
        height: u64,
        view: PinnedDbSnapshot,
    ) -> IntegrationResult<()> {
        // v32.6: caller (node.rs) controls trigger heights — early anchor
        // at h=90 + baseline every 3600. This function only enforces
        // height>0; it always writes a full state snapshot when called.
        if height == 0 {
            return Ok(());
        }
        self.create_state_snapshot(height, view).await
    }
    
    /// Create full state snapshot at specified height
    ///
    /// v15.9: BLOCKING-POOL EXECUTION
    /// ────────────────────────────────────────────────────────────────────
    /// This is the heaviest single I/O+CPU operation in the storage layer:
    /// it iterates every account, every pending reward, every contract
    /// storage cell, and every registry entry — then zstd-3 compresses
    /// the concatenated payload. At 1M+ accounts the iteration alone is
    /// hundreds of milliseconds and the compression scales with payload
    /// size (tens to hundreds of MB). All of this work is moved to
    /// `tokio::task::spawn_blocking` so the async reactor stays free
    /// to drive consensus, P2P, and RPC during the snapshot window.
    ///
    /// CANONICAL TIMESTAMP — sourced from the boundary microblock OUTSIDE
    /// the blocking closure to keep that path linear and easy to reason
    /// about. The lookup is a single point read (microseconds) and does
    /// not need to be on the blocking pool.
    pub async fn create_state_snapshot(
        &self,
        height: u64,
        view: PinnedDbSnapshot,
    ) -> IntegrationResult<()> {
        // Caller (create_incremental_snapshot) already enforces trigger heights.
        if height == 0 {
            return Ok(()); // No snapshot at genesis
        }

        println!("[INFO][STORAGE] state_snapshot_start height={}", height);
        let start_time = std::time::Instant::now();

        // Canonical timestamp from the boundary microblock (not wall-clock) ⇒
        // byte-equal snapshots across honest nodes. Single point read, off-closure.
        let timestamp: u64 = match self.load_microblock_auto_format(height) {
            Ok(Some(boundary_block)) => boundary_block.timestamp,
            _ => 0,
        };

        // All CF reads go through the pinned snapshot (view.snap): a frozen
        // point-in-time view captured synchronously at this height, so the dump
        // reproduces exactly state_root@H even while H+1.. mutate the live DB.
        let (account_count, rewards_count, contract_entries, registry_count, compressed_kb, uncompressed_kb) =
            tokio::task::spawn_blocking(move || -> IntegrationResult<(u64, u64, u64, u64, usize, usize)> {
                use std::io::Write;
                let db = &view.db;
                let snap = &view.snap;
                let snapshots_cf = db.cf_handle("snapshots")
                    .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

                // Stream the logical payload straight into a zstd encoder so the full
                // uncompressed blob (multi-GB at 10M accounts) is NEVER materialized.
                // `uncompressed_len` tracks the running byte count fed to the encoder,
                // reproducing the exact wire header without holding the blob. Content and
                // order are byte-identical to the prior in-RAM [0x02 | body] layout, so
                // every node still streams the same bytes ⇒ the frame stays deterministic.
                let mut encoder = zstd::Encoder::new(Vec::new(), 3)
                    .map_err(|e| IntegrationError::Other(format!("Full snapshot encoder init error: {}", e)))?;
                let mut uncompressed_len: u64 = 0;
                // Feed a chunk into the encoder while accumulating its length into
                // `uncompressed_len` (checked-add: a >u64 payload is unrepresentable,
                // never a silent wrap on the consensus-critical header).
                macro_rules! feed {
                    ($enc:expr, $len:expr, $chunk:expr) => {{
                        let c = $chunk;
                        $enc.write_all(c)
                            .map_err(|e| IntegrationError::Other(format!("Full snapshot write error: {}", e)))?;
                        $len = $len.checked_add(c.len() as u64)
                            .ok_or_else(|| IntegrationError::Other("snapshot length overflow".to_string()))?;
                    }};
                }

                // Type discriminator first (0x02 = SNAP_TYPE_FULL), then the header fields.
                feed!(encoder, uncompressed_len, &[0x02u8]); // SNAP_TYPE_FULL
                feed!(encoder, uncompressed_len, &crate::node::PROTOCOL_VERSION.to_le_bytes());
                feed!(encoder, uncompressed_len, &height.to_le_bytes());
                feed!(encoder, uncompressed_len, &timestamp.to_le_bytes());

                // 4. Account state — the COMPLETE committed tree leaf set. The pinned view's accounts
                //    CF holds every hot account (flushed at prepare) ∪ every cold account (persist-
                //    before-evict), so recompute reproduces the QC-bound state_root even past the LRU
                //    cap. Key-ordered iteration ⇒ byte-identical snapshots across nodes.
                let accounts_cf = db.cf_handle("accounts")
                    .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
                let mut account_count = 0u64;
                for item in snap.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start) {
                    let (key, value) = item?;
                    feed!(encoder, uncompressed_len, &(key.len() as u32).to_le_bytes());
                    feed!(encoder, uncompressed_len, &key);
                    feed!(encoder, uncompressed_len, &(value.len() as u32).to_le_bytes());
                    feed!(encoder, uncompressed_len, &value);
                    account_count += 1;
                }

                // 5. v2.75: Include pending_rewards for fast sync (lazy rewards survive restart)
                let mut rewards_count = 0u64;
                if let Some(rewards_cf) = db.cf_handle("pending_rewards") {
                    // Write marker for rewards section
                    feed!(encoder, uncompressed_len, b"REWARDS_V1");

                    let rewards_iter = snap.iterator_cf(&rewards_cf, rocksdb::IteratorMode::Start);
                    for item in rewards_iter {
                        let (key, value) = item?;
                        // Skip the derived light_elig_ recency index (whole-network × 4 epochs = up to ~40M
                        // keys at 10M light nodes): promote_snapshot_staging clears pending_rewards anyway and
                        // the joiner re-derives light_elig_ at boot, so shipping it only bloats the snapshot.
                        if key.starts_with(b"light_elig_") { continue; }
                        feed!(encoder, uncompressed_len, &(key.len() as u32).to_le_bytes());
                        feed!(encoder, uncompressed_len, &key);
                        feed!(encoder, uncompressed_len, &(value.len() as u32).to_le_bytes());
                        feed!(encoder, uncompressed_len, &value);
                        rewards_count += 1;
                    }

                    // Write end marker
                    feed!(encoder, uncompressed_len, b"REWARDS_END");
                }

                // 6. v5.0: Include contract_storage for full state recovery
                let mut contract_entries = 0u64;
                if let Some(cs_cf) = db.cf_handle("contract_storage") {
                    feed!(encoder, uncompressed_len, b"CONTRACT_STORAGE_V1");
                    let cs_iter = snap.iterator_cf(&cs_cf, rocksdb::IteratorMode::Start);
                    for item in cs_iter {
                        let (key, value) = item?;
                        feed!(encoder, uncompressed_len, &(key.len() as u32).to_le_bytes());
                        feed!(encoder, uncompressed_len, &key);
                        feed!(encoder, uncompressed_len, &(value.len() as u32).to_le_bytes());
                        feed!(encoder, uncompressed_len, &value);
                        contract_entries += 1;
                    }
                    feed!(encoder, uncompressed_len, b"CONTRACT_STORAGE_END");
                }

                // 7. v5.0: Include node_registry for producer wallet lookups after snapshot restore
                let mut registry_count = 0u64;
                if let Some(nr_cf) = db.cf_handle("node_registry") {
                    feed!(encoder, uncompressed_len, b"NODE_REGISTRY_V1");
                    let nr_iter = snap.iterator_cf(&nr_cf, rocksdb::IteratorMode::Start);
                    for item in nr_iter {
                        let (key, value) = item?;
                        // Exclude the display-only rich-list index (rlst_/rlpos_/rlcnt/meta_richlist_
                        // index_v1): it is NOT covered by registry_root/state_root, so serving it in the
                        // consensus-bootstrap artifact would (a) let a byzantine server inject a forged
                        // rich list and (b) diverge snapshot BYTES between honest nodes on a swallowed
                        // reconcile error. The joiner rebuilds it locally from accounts after promote.
                        if key.starts_with(b"rlst_") || key.starts_with(b"rlpos_")
                            || key.starts_with(b"rlcnt") || key.starts_with(b"meta_richlist_index_v1")
                        { continue; }
                        feed!(encoder, uncompressed_len, &(key.len() as u32).to_le_bytes());
                        feed!(encoder, uncompressed_len, &key);
                        feed!(encoder, uncompressed_len, &(value.len() as u32).to_le_bytes());
                        feed!(encoder, uncompressed_len, &value);
                        registry_count += 1;
                    }
                    feed!(encoder, uncompressed_len, b"NODE_REGISTRY_END");
                }

                // finish() flushes the final zstd frame and returns the wrapped Vec — a
                // complete single stream, decoded identically by the untouched loader.
                let compressed = encoder.finish()
                    .map_err(|e| IntegrationError::Other(format!("Full snapshot compression error: {}", e)))?;

                // Integrity hash over compressed data
                use sha3::{Sha3_256, Digest};
                let mut hasher = Sha3_256::new();
                hasher.update(&compressed);
                let hash = hasher.finalize();

                // Wire format: [sha3_hash(32) | uncompressed_len(8) | Zstd_compressed]
                let snapshot_key = format!("full_snap_{}", height);
                let mut final_data = Vec::with_capacity(40 + compressed.len());
                final_data.extend_from_slice(hash.as_slice());
                final_data.extend_from_slice(&uncompressed_len.to_le_bytes());
                final_data.extend_from_slice(&compressed);

                // Atomic write: full snapshot data + latest_full_snap pointer
                let mut snap_batch = WriteBatch::default();
                snap_batch.put_cf(&snapshots_cf, snapshot_key.as_bytes(), &final_data);
                snap_batch.put_cf(&snapshots_cf, b"latest_full_snap", &height.to_le_bytes());
                db.write(snap_batch)?;

                Ok((
                    account_count,
                    rewards_count,
                    contract_entries,
                    registry_count,
                    compressed.len() / 1024,
                    uncompressed_len as usize / 1024,
                ))
            })
            .await
            .map_err(|e| IntegrationError::Other(format!("create_state_snapshot_join_err: {}", e)))??;

        let duration = start_time.elapsed();
        println!("[INFO][SNAPSHOT] full_snap_created h={} accounts={} rewards={} contracts={} registry={} compressed={}KB uncompressed={}KB elapsed={:.2}s",
                 height, account_count, rewards_count, contract_entries, registry_count, compressed_kb, uncompressed_kb, duration.as_secs_f64());

        // PRODUCTION: Clean up old snapshots (keep only last 5).
        // Runs after the snapshot is durably persisted; cleanup uses the
        // same sync RocksDB API but its working set is small (≤5 keys).
        self.cleanup_old_snapshots(5)?;

        Ok(())
    }
    
    /// Apply-bound state_root + QC-certified total_supply at macroblock `mb_idx`, read from the
    /// macroblock's embedded (Checkpoint, QC). total_supply is in Checkpoint::hash ⇒ 2f+1-certified — the
    /// SAME source cold-join rehydrate uses, never a drifting live read. A pre-emission anchor (epoch<2)
    /// may carry no checkpoint_qc ⇒ total_supply falls back to the balance sum (exact while minted==sum).
    /// None ⇒ macroblock absent / corrupt QC (caller fails closed to full replay — never a wrong supply).
    pub fn anchor_root_and_supply(&self, mb_idx: u64, accounts: &[(String, qnet_state::Account)]) -> Option<([u8; 32], u64)> {
        let bytes = self.get_macroblock_by_height(mb_idx).ok()??;
        let mb: qnet_state::MacroBlock = bincode::deserialize(&bytes).ok()?;
        let ts = match &mb.consensus_data.checkpoint_qc {
            // Present-but-corrupt QC ⇒ fail closed to full replay (NEVER fall through to the balance sum,
            // which is wrong post-emission); log distinctly since a locally-sealed QC should never corrupt.
            Some(b) => match bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint, qnet_consensus::checkpoint_bft::QuorumCertificate)>(b) {
                Ok((cp, _)) => cp.total_supply,
                Err(e) => {
                    if crate::node::is_warn() { println!("[WARN][SNAPSHOT] anchor_qc_corrupt mb={} err={} action=full_replay", mb_idx, e); }
                    return None;
                }
            },
            None => accounts.iter().map(|(_, a)| a.balance).fold(0u64, |acc, b| acc.saturating_add(b)),
        };
        Some((mb.state_root, ts))
    }

    pub async fn load_latest_state_snapshot(&self) -> IntegrationResult<Option<(u64, [u8; 32], Vec<u8>, u64)>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        // Local restart restores from the apply-bound full_snap_ (the SAME complete snapshot P2P serves),
        // NOT the retired live-captured state_snap_ (whose content drifted past its label height). accounts
        // come from the snapshot; state_root + total_supply come from the anchor macroblock's QC-bound
        // checkpoint (the cold-join source), never a drifting live read.
        // Candidates newest→oldest, NOT only the pointer: a snapshot taken past a finality stall has no
        // sealed anchor macroblock, and giving up there turned every restart during the stall into a
        // from-genesis replay while perfectly anchored older snapshots sat one key away.
        let mut candidates: Vec<u64> = Vec::new();
        if let Some(data) = self.persistent.db.get_cf(&snapshots_cf, b"latest_full_snap")? {
            if data.len() >= 8 {
                candidates.push(u64::from_le_bytes(data[..8].try_into()
                    .map_err(|_| IntegrationError::StorageError("Invalid latest_full_snap pointer".to_string()))?));
            }
        }
        for item in self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::Start) {
            if let Ok((key, _)) = item {
                if let Some(h_str) = String::from_utf8_lossy(&key).strip_prefix("full_snap_") {
                    if let Ok(h) = h_str.parse::<u64>() { if !candidates.contains(&h) { candidates.push(h); } }
                }
            }
        }
        candidates.sort_unstable_by(|a, b| b.cmp(a));
        if candidates.is_empty() { return Ok(None); }

        for height in candidates {
            let value = match self.persistent.db.get_cf(&snapshots_cf, format!("full_snap_{}", height).as_bytes())? {
                Some(v) => v,
                None => {
                    eprintln!("[WARN][SNAPSHOT] full_snap_ h={} key missing — trying older", height);
                    continue;
                }
            };

            // decode_snapshot_accounts verifies integrity + decompresses + parses the full_snap_ payload
            // (Format A: accounts then the rewards/contracts/registry sections). Re-serialize as the bincode
            // Vec the TIER-1 consumer expects, so the restore path below is unchanged.
            let accounts = match self.decode_snapshot_accounts(&value) {
                Ok(a) => a,
                Err(e) => {
                    eprintln!("[WARN][SNAPSHOT] full_snap_ h={} decode_fail err={} — trying older", height, e);
                    continue;
                }
            };

            // full_snap_ heights are macroblock boundaries (h=90 + multiples of SNAPSHOT_INCREMENTAL_INTERVAL),
            // so the anchor macroblock at height/90 carries the apply-bound state_root + QC total_supply.
            let mb_idx = height / 90;
            let (state_root, total_supply) = match self.anchor_root_and_supply(mb_idx, &accounts) {
                Some(rs) => rs,
                None => {
                    eprintln!("[WARN][SNAPSHOT] full_snap_ h={} anchor mb={} unavailable — trying older", height, mb_idx);
                    continue;
                }
            };

            let accounts_data = bincode::serialize(&accounts)
                .map_err(|e| IntegrationError::SerializationError(format!("reserialize_full_snap_accounts: {}", e)))?;

            if crate::node::is_info() {
                println!("[INFO][SNAPSHOT] full_snap_loaded h={} total_supply={} accounts={}",
                         height, total_supply, accounts.len());
            }

            return Ok(Some((height, state_root, accounts_data, total_supply)));
        }

        eprintln!("[WARN][SNAPSHOT] no anchored full_snap_ — full replay");
        Ok(None)
    }
    
    /// v2.99: Load state snapshot by height and restore into StateManager
    /// Load a state snapshot by height and return (state_root, accounts_bincode) for StateManager restoration.
    /// Payload: [type=0x01 | state_root(32) | accounts_bincode]
    // Persistent mempool API: pending TXs are mirrored to the `mempool` CF
    // on admission and removed on inclusion / TTL / drop, so a producer that
    // dies between accepting and including a TX doesn't silently drop it —
    // the next process reloads the queue under the same gas-price ordering.
    // Per entry, keyed by tx hash: [admission_ts u64 LE | tx_payload] (ts
    // rebuilds TTL/by_gas_price on reload with no extra round-trip). One
    // put_cf per TX; boot scan runs in spawn_blocking to free the reactor.

    /// Persist a single pending mempool entry.
    /// Called from the integration layer immediately after a TX is admitted
    /// to the in-RAM `SimpleMempool`, so a crash between admission and
    /// block inclusion does not lose the TX.
    pub fn save_pending_tx(&self, tx_hash: &str, payload: &[u8], admission_ts: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("mempool")
            .ok_or_else(|| IntegrationError::StorageError("mempool column family not found".to_string()))?;
        let mut value = Vec::with_capacity(8 + payload.len());
        value.extend_from_slice(&admission_ts.to_le_bytes());
        value.extend_from_slice(payload);
        self.persistent.db.put_cf(&cf, tx_hash.as_bytes(), &value)?;
        Ok(())
    }

    /// Remove a pending mempool entry (called on block inclusion,
    /// TTL expiration, replacement, or explicit drop).
    pub fn delete_pending_tx(&self, tx_hash: &str) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("mempool")
            .ok_or_else(|| IntegrationError::StorageError("mempool column family not found".to_string()))?;
        self.persistent.db.delete_cf(&cf, tx_hash.as_bytes())?;
        Ok(())
    }

    /// Scan the entire `mempool` CF and return every persisted entry.
    /// Used at node startup to repopulate the in-RAM mempool. Each tuple
    /// is `(tx_hash, payload_bytes, admission_ts)`.
    /// Runs on the async caller; in node.rs we wrap the entire restore
    /// pass in `tokio::task::spawn_blocking` to keep the reactor free
    /// while large mempools (≥100K entries) are streamed back in.
    pub fn load_all_pending_txs(&self) -> IntegrationResult<Vec<(String, Vec<u8>, u64)>> {
        let cf = self.persistent.db.cf_handle("mempool")
            .ok_or_else(|| IntegrationError::StorageError("mempool column family not found".to_string()))?;
        let mut out: Vec<(String, Vec<u8>, u64)> = Vec::new();
        let iter = self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, value) = item?;
            if value.len() < 8 { continue; }
            let admission_ts = u64::from_le_bytes(
                value[..8].try_into()
                    .map_err(|_| IntegrationError::StorageError("Invalid mempool entry header".to_string()))?
            );
            let payload = value[8..].to_vec();
            let tx_hash = String::from_utf8_lossy(&key).into_owned();
            out.push((tx_hash, payload, admission_ts));
        }
        Ok(out)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // v15.10 STAGE-2C: CROSS-SHARD 2PC PERSISTENCE API
    // ───────────────────────────────────────────────────────────────────────
    // Two surfaces:
    //   * `cross_shard_pending` — in-flight 2PC envelopes keyed by
    //     `tx_id` (32-byte). Survives coordinator restarts; the failover
    //     path on a successor node reads this CF to reconstitute state.
    //   * `cross_shard_receipts` — terminal receipts keyed by `tx_id`.
    //     Append-only; queried by wallets through the
    //     `/api/v1/cross-shard/receipt/{tx_id}` RPC endpoint.
    //
    // PRIVACY-FIRST LOGGING
    // ───────────────────────────────────────────────────────────────────────
    // Logged tx_id previews are truncated to the first 16 hex chars,
    // matching the rest of the codebase's privacy posture.

    /// Persist a `CrossShardEnvelope` (or any wire-format bytes) for the
    /// given `tx_id`. Idempotent: re-saving overwrites the previous
    /// value, which is the correct behaviour when the coordinator
    /// re-broadcasts a phase advancement (for example after a restart).
    pub fn save_cross_shard_pending(&self, tx_id: &[u8; 32], payload: &[u8]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("cross_shard_pending")
            .ok_or_else(|| IntegrationError::StorageError("cross_shard_pending column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, tx_id, payload)?;
        Ok(())
    }

    /// Read the persisted envelope (if any) for `tx_id`. Returns None
    /// when the 2PC has already been finalised — finalisation moves the
    /// record from `pending` to `receipts`.
    pub fn load_cross_shard_pending(&self, tx_id: &[u8; 32]) -> IntegrationResult<Option<Vec<u8>>> {
        let cf = self.persistent.db.cf_handle("cross_shard_pending")
            .ok_or_else(|| IntegrationError::StorageError("cross_shard_pending column family not found".to_string()))?;
        Ok(self.persistent.db.get_cf(&cf, tx_id)?)
    }

    /// Drop the pending entry for `tx_id`. Called when the protocol
    /// reaches a terminal state (after `save_cross_shard_receipt`).
    pub fn delete_cross_shard_pending(&self, tx_id: &[u8; 32]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("cross_shard_pending")
            .ok_or_else(|| IntegrationError::StorageError("cross_shard_pending column family not found".to_string()))?;
        self.persistent.db.delete_cf(&cf, tx_id)?;
        Ok(())
    }

    /// Persist a terminal-state `CrossShardReceipt`. Append-only — the
    /// receipt MUST NOT be overwritten once written, because wallets
    /// rely on its immutability for trust-less verification.
    pub fn save_cross_shard_receipt(&self, tx_id: &[u8; 32], payload: &[u8]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("cross_shard_receipts")
            .ok_or_else(|| IntegrationError::StorageError("cross_shard_receipts column family not found".to_string()))?;
        // Idempotent re-save with byte-identical payload is allowed
        // (replay of the same finalisation event); divergent payloads
        // are detected at the integration layer through the receipt's
        // BFT proofs and rejected before reaching this method.
        self.persistent.db.put_cf(&cf, tx_id, payload)?;
        Ok(())
    }

    /// Read the receipt (if any) for `tx_id`. The wallet RPC endpoint
    /// uses this to surface the trust-less outcome of a cross-shard
    /// transaction. Returns None for tx_ids that are still in flight or
    /// have never been seen.
    pub fn load_cross_shard_receipt(&self, tx_id: &[u8; 32]) -> IntegrationResult<Option<Vec<u8>>> {
        let cf = self.persistent.db.cf_handle("cross_shard_receipts")
            .ok_or_else(|| IntegrationError::StorageError("cross_shard_receipts column family not found".to_string()))?;
        Ok(self.persistent.db.get_cf(&cf, tx_id)?)
    }

    /// Iterate every persisted pending 2PC and return `(tx_id, payload)`
    /// pairs. Used at coordinator startup to rehydrate the in-RAM
    /// `CrossShardCoordinator.pending` map; subsequent failover-driven
    /// takeovers can advance the protocol from the recorded state
    /// without losing any in-flight commitments.
    pub fn load_all_cross_shard_pending(&self) -> IntegrationResult<Vec<([u8; 32], Vec<u8>)>> {
        let cf = self.persistent.db.cf_handle("cross_shard_pending")
            .ok_or_else(|| IntegrationError::StorageError("cross_shard_pending column family not found".to_string()))?;
        let mut out = Vec::new();
        let iter = self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, value) = item?;
            if key.len() == 32 {
                let mut tx_id = [0u8; 32];
                tx_id.copy_from_slice(&key);
                out.push((tx_id, value.to_vec()));
            }
        }
        Ok(out)
    }

    /// Drop every entry in the `mempool` CF. Reserved for explicit
    /// admin-level resets; not part of the normal lifecycle.
    pub fn clear_pending_txs(&self) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("mempool")
            .ok_or_else(|| IntegrationError::StorageError("mempool column family not found".to_string()))?;
        let mut batch = WriteBatch::default();
        let iter = self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, _) = item?;
            batch.delete_cf(&cf, &key);
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// v15.9: ROLLBACK SUPPORT — locate the freshest state snapshot whose
    /// height is ≤ `target_height`. Used by the reorg / fork-recovery
    /// path to rebuild the in-memory account state to a consistent
    /// pre-rollback baseline before replaying the surviving microblocks.
    ///
    /// SCAN STRATEGY
    /// ───────────────────────────────────────────────────────────────────
    /// Snapshots are emitted at `SNAPSHOT_INCREMENTAL_INTERVAL` (3 600)
    /// boundaries. We start from the highest such boundary not exceeding
    /// `target_height` and walk downwards by one interval at a time,
    /// probing both `state_snap_*` and `full_snap_*` keys per height.
    /// First hit wins. Returns `Some((snap_height, payload_bytes))`.
    /// `None` means no usable snapshot exists at or below the target —
    /// the caller must fall back to full replay from genesis.
    ///
    /// SCALABILITY
    /// ───────────────────────────────────────────────────────────────────
    /// Cost is bounded: at most `target_height / SNAPSHOT_INCREMENTAL_INTERVAL`
    /// point reads, which decays as the chain grows because cleanup
    /// keeps only the last 5 snapshots. In steady state this is at
    /// most 5 reads regardless of chain length.
    pub fn find_snapshot_at_or_before(
        &self,
        target_height: u64,
    ) -> IntegrationResult<Option<(u64, Vec<u8>)>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        if target_height == 0 {
            return Ok(None);
        }

        // v32.15: scan actual stored snapshot keys for the freshest height ≤ target.
        // Prior fixed-3600-stride probing missed snapshots stored at macroblock
        // boundaries (multiples of 90, not 3600) and any non-stride heights left
        // after pruning → forced the fragile full-replay-from-0 recovery path.
        // Retained-snapshot count is bounded by the pruning policy, so this full
        // scan is O(retained) — tens of entries even at production scale.
        use rocksdb::IteratorMode;
        let mut best_height: Option<u64> = None;
        let iter = self.persistent.db.iterator_cf(&snapshots_cf, IteratorMode::Start);
        for item in iter {
            let (key, value) = match item {
                Ok(kv) => kv,
                Err(_) => continue,
            };
            if value.is_empty() {
                continue;
            }
            let key_str = match std::str::from_utf8(&key) {
                Ok(s) => s,
                Err(_) => continue,
            };
            // full_snap_ only — state_snap_ retired; scan + fetch (below) must agree on the same prefix.
            if let Some(hs) = key_str.strip_prefix("full_snap_") {
                if let Ok(h) = hs.parse::<u64>() {
                    if h <= target_height && best_height.map_or(true, |b| h > b) {
                        best_height = Some(h);
                    }
                }
            }
        }

        match best_height {
            Some(h) => {
                // full_snap_ is the single snapshot artifact (state_snap_ retired); reconcile reads its
                // accounts + takes total_supply from the anchor macroblock's QC checkpoint.
                let key = format!("full_snap_{}", h);
                match self.persistent.db.get_cf(&snapshots_cf, key.as_bytes())? {
                    Some(data) if !data.is_empty() => Ok(Some((h, data))),
                    _ => Ok(None),
                }
            }
            None => Ok(None),
        }
    }

    /// Decode a snapshot blob into its account list for in-memory state rebuild during
    /// fork-recovery. Reads BOTH the canonical full_snap_ (Format A: raw accounts-CF dump)
    /// and the legacy state_snap_ (Format B: bincode Vec). Accounts only — other CF sections
    /// ignored. Pure (no DB). Inverse of create_state_snapshot/save_state_snapshot writers.
    pub fn decode_snapshot_accounts(&self, snap_data: &[u8]) -> IntegrationResult<Vec<(String, qnet_state::Account)>> {
        if snap_data.len() < 41 {
            return Err(IntegrationError::StorageError(format!("snapshot too short: {} bytes", snap_data.len())));
        }
        let stored_hash = &snap_data[..32];
        let compressed = &snap_data[40..];
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(compressed);
        if stored_hash != hasher.finalize().as_slice() {
            return Err(IntegrationError::StorageError("snapshot integrity check failed".to_string()));
        }
        let buf = zstd::decode_all(compressed)
            .map_err(|e| IntegrationError::StorageError(format!("snapshot decompress failed: {}", e)))?;
        if buf.first().copied() != Some(0x02) || buf.len() < 5 {
            return Err(IntegrationError::StorageError("snapshot wrong/short type".to_string()));
        }
        // probe u32 after type byte: >=10_000 ⇒ Format B (state_root bytes); else Format A version
        let probe = u32::from_le_bytes(buf[1..5].try_into().unwrap());
        let mut out: Vec<(String, qnet_state::Account)> = Vec::new();
        if probe >= 10_000 {
            // Format B: [0x02 | state_root(32) | total_supply(8) | height(8) | bincode(Vec<(addr,Account)>)]
            let body = 1 + 32 + 8 + 8;
            if buf.len() < body { return Err(IntegrationError::StorageError("format_b truncated".to_string())); }
            out = bincode::deserialize(&buf[body..])
                .map_err(|e| IntegrationError::SerializationError(format!("format_b decode: {}", e)))?;
        } else {
            // Format A: [0x02 | version(4) | height(8) | ts(8) | (klen|k|vlen|v)* | REWARDS_V1 ...]
            let mut cursor = 1 + 4 + 8 + 8;
            while cursor < buf.len() {
                if cursor + 10 <= buf.len() && &buf[cursor..cursor + 10] == b"REWARDS_V1" { break; }
                if cursor + 4 > buf.len() { break; }
                let klen = u32::from_le_bytes(buf[cursor..cursor + 4].try_into().unwrap()) as usize;
                cursor += 4;
                if cursor + klen > buf.len() { break; }
                let key = &buf[cursor..cursor + klen]; cursor += klen;
                if cursor + 4 > buf.len() { break; }
                let vlen = u32::from_le_bytes(buf[cursor..cursor + 4].try_into().unwrap()) as usize;
                cursor += 4;
                if cursor + vlen > buf.len() { break; }
                let val = &buf[cursor..cursor + vlen]; cursor += vlen;
                let addr = String::from_utf8(key.to_vec())
                    .map_err(|e| IntegrationError::StorageError(format!("addr utf8: {}", e)))?;
                let account = bincode::deserialize::<qnet_state::Account>(val)
                    .map_err(|e| IntegrationError::SerializationError(format!("account decode: {}", e)))?;
                out.push((addr, account));
            }
        }
        Ok(out)
    }


    /// Load a full snapshot by height and restore accounts + rewards directly into RocksDB.
    /// v10.1: Supports TWO binary formats:
    ///   Format A (create_state_snapshot): [0x02 | protocol_version:u32 | height:u64 | timestamp:u64 | KV pairs...]
    ///   Format B (save_state_snapshot):   [0x02 | state_root:[u8;32] | total_supply:u64 | height:u64 | bincode(accounts)]
    /// Detection: after 0x02, read 4 bytes as u32. protocol_version < 10_000 → Format A. Otherwise → Format B.
    /// stage=true restores into the *_stage CFs (verify-then-promote cold-join: live state stays
    /// untouched until the binding passes); stage=false restores directly into live CFs.
    pub async fn load_state_snapshot(&self, height: u64, stage: bool) -> IntegrationResult<()> {
        if crate::node::is_info() {
            println!("[INFO][SNAPSHOT] full_snap_loading h={} stage={}", height, stage);
        }
        let accounts_cf_name = if stage { "accounts_stage" } else { "accounts" };
        let rewards_cf_name = if stage { "pending_rewards_stage" } else { "pending_rewards" };
        let contract_cf_name = if stage { "contract_storage_stage" } else { "contract_storage" };
        let registry_cf_name = if stage { "node_registry_stage" } else { "node_registry" };

        // Clear the staging CFs BEFORE a fresh staged load. A crash in a prior attempt's narrow
        // promote window (marker deleted but stage-clear not yet finished) can leave stale rows;
        // loading a new snapshot on top would then let those poison this snapshot's Pattern-C
        // merkle recompute → a fail-closed reject of an otherwise-honest snapshot (a liveness
        // hole, forcing a needless full replay). The *_stage CFs are throwaway verify-space, so
        // truncating them here is always safe and makes each staged load self-contained.
        if stage {
            for cf in &[accounts_cf_name, rewards_cf_name, contract_cf_name, registry_cf_name] {
                let _ = self.clear_cf(cf);
            }
        }

        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        // v10.1: Try full_snap_ first, then state_snap_ (download_snapshot_chunked saves as full_snap_,
        // but the data may have originated from a peer's state_snap_ via get_snapshot_data)
        let snapshot_key = format!("full_snap_{}", height);
        let snapshot_data = match self.persistent.db.get_cf(&snapshots_cf, snapshot_key.as_bytes())? {
            Some(d) => d,
            None => {
                // Fallback: try state_snap_ key directly (local node)
                let state_key = format!("state_snap_{}", height);
                self.persistent.db.get_cf(&snapshots_cf, state_key.as_bytes())?
                    .ok_or_else(|| IntegrationError::StorageError(
                        format!("Snapshot at h={} not found (tried full_snap_ and state_snap_)", height)
                    ))?
            }
        };

        // Bounds check: [sha3_hash(32) | uncompressed_len(8)] + at least 1 byte compressed
        if snapshot_data.len() < 41 {
            return Err(IntegrationError::StorageError(format!(
                "Full snapshot at h={} malformed: only {} bytes", height, snapshot_data.len()
            )));
        }

        let stored_hash = &snapshot_data[..32];
        let _uncompressed_len = u64::from_le_bytes(snapshot_data[32..40].try_into()
            .map_err(|_| IntegrationError::StorageError("Invalid snapshot header".to_string()))?);
        let compressed_data = &snapshot_data[40..];

        // Integrity check
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(compressed_data);
        let computed_hash = hasher.finalize();

        if stored_hash != computed_hash.as_slice() {
            return Err(IntegrationError::StorageError(format!(
                "Full snapshot at h={} integrity check failed", height
            )));
        }

        // Decompress with Zstd (unified format, same as save path)
        let decompressed = zstd::decode_all(compressed_data)
            .map_err(|e| IntegrationError::StorageError(format!("Full snapshot decompression failed h={}: {}", height, e)))?;

        // Parse and restore state
        let mut cursor = 0;

        // Verify type discriminator
        if decompressed.is_empty() || decompressed[0] != 0x02 {
            return Err(IntegrationError::StorageError(format!(
                "Full snapshot h={} wrong type: 0x{:02x} (expected 0x02)", height,
                decompressed.first().copied().unwrap_or(0)
            )));
        }
        cursor += 1; // skip type byte

        // v10.1: DETECT FORMAT — read first 4 bytes after type discriminator
        // Format A (create_state_snapshot): protocol_version as u32 (always < 10_000)
        // Format B (save_state_snapshot):   first 4 bytes of state_root hash (random, virtually always >= 10_000)
        if cursor + 4 > decompressed.len() {
            return Err(IntegrationError::StorageError(format!(
                "Full snapshot h={} truncated after type byte", height
            )));
        }
        let probe = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into()
            .map_err(|_| IntegrationError::StorageError("Invalid probe field".to_string()))?);

        let is_format_b = probe >= 10_000; // state_root hash byte → huge number

        if is_format_b {
            // ═══════════════════════════════════════════════════════════════════
            // FORMAT B (legacy P2P state_snap_ download): [0x02 | state_root(32) | total_supply(8) |
            //   height(8) | bincode(accounts)] — carries ONLY the accounts CF.
            // ═══════════════════════════════════════════════════════════════════
            // This snapshot-restore path is Super consensus machinery. Light nodes are pure mobile API
            // clients — they store NO chain data and never cold-join, so they never reach here. A
            // Format-B blob lacks node_registry (vrf_pk / srtr_ / lrtr_ / cbw), so it is incomplete for
            // the consensus roster a Super must derive: reject closed and let the caller re-target a
            // complete (Format A) source or fall back to verified block-sync.
            return Err(IntegrationError::StorageError(format!(
                "format_B_incomplete_for_consensus h={} reason=no_node_registry", height
            )));
        }

        // ═══════════════════════════════════════════════════════════════════
        // FORMAT A: create_state_snapshot — [0x02 | version(4) | height(8) | timestamp(8) | KV pairs | markers...]
        // This is the canonical full snapshot format.
        // ═══════════════════════════════════════════════════════════════════
        let version = probe; // already read as u32
        cursor += 4;

        if version != crate::node::PROTOCOL_VERSION {
            println!("[WARN][STORAGE] snapshot_version_mismatch snapshot_v={} current_v={}",
                     version, crate::node::PROTOCOL_VERSION);
        }

        // Skip height and timestamp
        cursor += 16;
        
        // Restore accounts
        let accounts_cf = self.persistent.db.cf_handle(accounts_cf_name)
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        
        let mut batch = WriteBatch::default();
        let mut account_count = 0;
        
        // Read accounts until we hit REWARDS_V1 marker or end of data
        while cursor < decompressed.len() {
            // Check for REWARDS_V1 marker (10 bytes)
            if cursor + 10 <= decompressed.len() && &decompressed[cursor..cursor+10] == b"REWARDS_V1" {
                break; // Switch to rewards section
            }
            
            if cursor + 4 > decompressed.len() { break; }
            let key_len = u32::from_le_bytes(
                match decompressed[cursor..cursor+4].try_into() {
                    Ok(b) => b,
                    Err(_) => break, // v9.1: safe break instead of panic
                }
            ) as usize;
            cursor += 4;

            if cursor + key_len > decompressed.len() { break; }
            let key = &decompressed[cursor..cursor+key_len];
            cursor += key_len;

            if cursor + 4 > decompressed.len() { break; }
            let value_len = u32::from_le_bytes(
                match decompressed[cursor..cursor+4].try_into() {
                    Ok(b) => b,
                    Err(_) => break, // v9.1: safe break instead of panic
                }
            ) as usize;
            cursor += 4;
            
            if cursor + value_len > decompressed.len() { break; }
            let value = &decompressed[cursor..cursor+value_len];
            cursor += value_len;
            
            batch.put_cf(&accounts_cf, key, value);
            account_count += 1;
        }
        
        self.persistent.db.write(batch)?;
        
        // v2.75: Restore pending_rewards if present
        let mut rewards_count = 0;
        if cursor + 10 <= decompressed.len() && &decompressed[cursor..cursor+10] == b"REWARDS_V1" {
            cursor += 10; // Skip marker
            
            if let Some(rewards_cf) = self.persistent.db.cf_handle(rewards_cf_name) {
                let mut rewards_batch = WriteBatch::default();
                
                // Read until REWARDS_END marker
                while cursor < decompressed.len() {
                    // Check for REWARDS_END marker (11 bytes)
                    if cursor + 11 <= decompressed.len() && &decompressed[cursor..cursor+11] == b"REWARDS_END" {
                        cursor += 11; // Skip past marker so next section is reachable
                        break;
                    }
                    
                    if cursor + 4 > decompressed.len() { break; }
                    let key_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().expect("Key length must be 4 bytes")) as usize;
                    cursor += 4;
                    
                    if cursor + key_len > decompressed.len() { break; }
                    let key = &decompressed[cursor..cursor+key_len];
                    cursor += key_len;
                    
                    if cursor + 4 > decompressed.len() { break; }
                    let value_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().expect("Value length must be 4 bytes")) as usize;
                    cursor += 4;
                    
                    if cursor + value_len > decompressed.len() { break; }
                    let value = &decompressed[cursor..cursor+value_len];
                    cursor += value_len;
                    
                    rewards_batch.put_cf(&rewards_cf, key, value);
                    rewards_count += 1;
                }
                
                self.persistent.db.write(rewards_batch)?;
            }
        }
        
        // v5.0: Restore contract_storage from snapshot
        let mut contract_count = 0u64;
        if cursor + 19 <= decompressed.len() && &decompressed[cursor..cursor+19] == b"CONTRACT_STORAGE_V1" {
            cursor += 19;
            if let Some(cs_cf) = self.persistent.db.cf_handle(contract_cf_name) {
                let mut cs_batch = WriteBatch::default();
                while cursor < decompressed.len() {
                    if cursor + 20 <= decompressed.len() && &decompressed[cursor..cursor+20] == b"CONTRACT_STORAGE_END" {
                        cursor += 20;
                        break;
                    }
                    if cursor + 4 > decompressed.len() { break; }
                    let key_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().unwrap_or([0;4])) as usize;
                    cursor += 4;
                    if cursor + key_len > decompressed.len() { break; }
                    let key = &decompressed[cursor..cursor+key_len];
                    cursor += key_len;
                    if cursor + 4 > decompressed.len() { break; }
                    let value_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().unwrap_or([0;4])) as usize;
                    cursor += 4;
                    if cursor + value_len > decompressed.len() { break; }
                    let value = &decompressed[cursor..cursor+value_len];
                    cursor += value_len;
                    cs_batch.put_cf(&cs_cf, key, value);
                    contract_count += 1;
                }
                self.persistent.db.write(cs_batch)?;
            }
        }

        // v5.0: Restore node_registry from snapshot
        let mut registry_count = 0u64;
        if cursor + 16 <= decompressed.len() && &decompressed[cursor..cursor+16] == b"NODE_REGISTRY_V1" {
            cursor += 16;
            if let Some(nr_cf) = self.persistent.db.cf_handle(registry_cf_name) {
                let mut nr_batch = WriteBatch::default();
                while cursor < decompressed.len() {
                    if cursor + 17 <= decompressed.len() && &decompressed[cursor..cursor+17] == b"NODE_REGISTRY_END" {
                        let _ = cursor + 17; // consumed; loop breaks
                        break;
                    }
                    if cursor + 4 > decompressed.len() { break; }
                    let key_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().unwrap_or([0;4])) as usize;
                    cursor += 4;
                    if cursor + key_len > decompressed.len() { break; }
                    let key = &decompressed[cursor..cursor+key_len];
                    cursor += key_len;
                    if cursor + 4 > decompressed.len() { break; }
                    let value_len = u32::from_le_bytes(decompressed[cursor..cursor+4].try_into().unwrap_or([0;4])) as usize;
                    cursor += 4;
                    if cursor + value_len > decompressed.len() { break; }
                    let value = &decompressed[cursor..cursor+value_len];
                    cursor += value_len;
                    nr_batch.put_cf(&nr_cf, key, value);
                    registry_count += 1;
                }
                self.persistent.db.write(nr_batch)?;
                // Derived indices (roster srtr_/lrtr_, cbw burn→wallet, registry_lthash) live in
                // metadata, NOT in the snapshot blob. Rebuild them deterministically from the restored
                // node_registry, bounded by the snapshot height. In stage mode this runs at promote
                // (against live), never on the staging copy.
                if !stage {
                    let _ = self.backfill_roster_indices();
                    match self.rebuild_committed_burn_wallet(height) {
                        Ok(n) if crate::node::is_info() => println!("[INFO][SNAPSHOT] cbw_rebuilt bindings={}", n),
                        Err(e) => println!("[WARN][SNAPSHOT] cbw_rebuild_failed err={}", e),
                        _ => {}
                    }
                    if let Err(e) = self.rebuild_registry_lthash(height) {
                        println!("[WARN][SNAPSHOT] registry_lthash_rebuild_failed err={}", e);
                    }
                    // FIX-5: derive dilithium_pk_root LtHash from the restored accounts (metadata CF is
                    // not snapshot-carried) so elided-pk verify + the next checkpoint match the network.
                    if let Err(e) = self.rebuild_dilithium_pk_lthash() {
                        println!("[WARN][SNAPSHOT] dilithium_pk_lthash_rebuild_failed err={}", e);
                    }
                    // Never inherit peer-supplied rich-list rows (display-only, snapshot-unverified) —
                    // the boot rebuild re-derives from the restored accounts.
                    let _ = self.richlist_clear();
                }
            }
        }

        if crate::node::is_info() {
            println!("[INFO][SNAPSHOT] full_snap_restored h={} accounts={} rewards={} contracts={} registry={}",
                     height, account_count, rewards_count, contract_count, registry_count);
        }

        // v32.10: trust Pattern C. SHA3 byte integrity + Zstd parse + format
        // probe already reject malformed bytes upstream. Cryptographic
        // snapshot_root verification (verify_snapshot_consensus_binding)
        // matches macroblock 2f+1 commitment — that is the security gate,
        // not entry counts. Empty-state anchors (h=90 fresh net: registry>0,
        // accounts=0) are legitimate.
        if account_count == 0 && crate::node::is_info() {
            println!(
                "[INFO][SNAPSHOT] empty_state_anchor h={} registry={} mode=pre_first_transfer",
                height, registry_count,
            );
        }

        // Live restore advances chain_height to the snapshot height so catch-up fetches only
        // blocks AFTER it. Stage mode leaves chain_height untouched — it is advanced by promote
        // once the binding passes.
        if !stage {
            self.set_chain_height(height)?;
            println!("[INFO][SNAPSHOT] format_A_chain_height_set h={}", height);
        }

        Ok(())
    }
    
    // v3.41: cleanup_old_snapshots unified into the ephemeral cleanup section above
    
    // PRODUCTION: IPFS integration for decentralized snapshot distribution
    
    /// Upload snapshot to IPFS and return CID (Content Identifier)
    pub async fn upload_snapshot_to_ipfs(&self, height: u64) -> IntegrationResult<String> {
        // PRODUCTION: Check if IPFS is available (OPTIONAL feature)
        let ipfs_api = match std::env::var("IPFS_API_URL") {
            Ok(url) => url,
            Err(_) => {
                // IPFS is OPTIONAL - skip if not configured
                return Err(IntegrationError::Other("IPFS not configured (set IPFS_API_URL to enable)".to_string()));
            }
        };
        
        println!("[INFO][STORAGE] ipfs_snapshot_upload_start height={}", height);
        
        // Get snapshot data BEFORE any async operations (avoids Send issues)
        let snapshot_data = {
            let snapshots_cf = self.persistent.db.cf_handle("snapshots")
                .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
            
            // IPFS upload feeds P2P cold-join ⇒ full_snap_ ONLY (complete); never the incomplete state_snap_.
            let full_key = format!("full_snap_{}", height);
            self.persistent.db.get_cf(&snapshots_cf, full_key.as_bytes())?
                .ok_or_else(|| IntegrationError::StorageError(format!("Snapshot at height {} not found", height)))?
        }; // RocksDB handle is dropped here
        
        // PRODUCTION: Create IPFS-compatible metadata
        let _metadata = json!({
            "version": crate::node::PROTOCOL_VERSION,
            "height": height,
            "timestamp": chrono::Utc::now().timestamp(),
            "type": "qnet_snapshot",
            "compression": "lz4",
            "size": snapshot_data.len()
        });
        
        // PRODUCTION: Use HTTP client to upload to IPFS
        // In production environment, would use ipfs-api crate
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120)) // 2 minutes for large snapshots
            .build()
            .map_err(|e| IntegrationError::Other(format!("HTTP client error: {}", e)))?;
        
        // Create multipart form for IPFS add endpoint
        let form = reqwest::multipart::Form::new()
            .part("file", reqwest::multipart::Part::bytes(snapshot_data)
                .file_name(format!("qnet_snapshot_{}.dat", height)));
        
        // Upload to IPFS
        let response = client.post(&format!("{}/api/v0/add", ipfs_api))
            .multipart(form)
            .send()
            .await
            .map_err(|e| IntegrationError::Other(format!("IPFS upload failed: {}", e)))?;
        
        if response.status().is_success() {
            let result: serde_json::Value = response.json().await
                .map_err(|e| IntegrationError::Other(format!("IPFS response parse error: {}", e)))?;
            
            if let Some(cid) = result.get("Hash").and_then(|v| v.as_str()) {
                // Store IPFS CID reference (in a scope to drop cf_handle)
                {
                    let ipfs_key = format!("ipfs_{}", height);
                    let snapshots_cf = self.persistent.db.cf_handle("snapshots")
                        .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
                    self.persistent.db.put_cf(&snapshots_cf, ipfs_key.as_bytes(), cid.as_bytes())?;
                } // cf_handle is dropped here
                
                println!("[INFO][STORAGE] ipfs_snapshot_uploaded cid={}", cid);
                
                // PRODUCTION: Pin the content to ensure persistence (now safe after cf_handle is dropped)
                self.pin_ipfs_content(&ipfs_api, cid).await?;
                
                return Ok(cid.to_string());
            }
        }
        
        Err(IntegrationError::StorageError("Failed to upload snapshot to IPFS".to_string()))
    }
    
    /// Pin IPFS content to ensure it stays available
    pub(super) async fn pin_ipfs_content(&self, ipfs_api: &str, cid: &str) -> IntegrationResult<()> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| IntegrationError::Other(format!("HTTP client error: {}", e)))?;
        
        let response = client.post(&format!("{}/api/v0/pin/add", ipfs_api))
            .query(&[("arg", cid)])
            .send()
            .await
            .map_err(|e| IntegrationError::Other(format!("IPFS pin failed: {}", e)))?;
        
        if response.status().is_success() {
            println!("[INFO][STORAGE] ipfs_content_pinned cid={}", cid);
            Ok(())
        } else {
            Err(IntegrationError::StorageError(format!("Failed to pin IPFS content: {}", cid)))
        }
    }
    
    /// Download snapshot from IPFS by CID
    pub async fn download_snapshot_from_ipfs(&self, cid: &str, height: u64) -> IntegrationResult<()> {
        let ipfs_gateway = match std::env::var("IPFS_GATEWAY_URL") {
            Ok(url) => url,
            Err(_) => {
                // DECENTRALIZED: No default to centralized services!
                // User must configure their own IPFS gateway or local node
                return Err(IntegrationError::Other(
                    "IPFS gateway not configured (set IPFS_GATEWAY_URL or run local IPFS node)".to_string()
                ));
            }
        };
        
        println!("[INFO][STORAGE] ipfs_snapshot_download_start cid={}", cid);
        
        // PRODUCTION: Try gateways from environment or peers
        let mut gateways = vec![ipfs_gateway.clone()];
        
        // Add additional gateways from environment (comma-separated)
        if let Ok(extra_gateways) = std::env::var("IPFS_EXTRA_GATEWAYS") {
            for gateway in extra_gateways.split(',') {
                gateways.push(gateway.trim().to_string());
            }
        }
        
        // DECENTRALIZED: Prefer local IPFS nodes from peers
        // In production, would discover IPFS gateways from P2P network
        // Not hardcoding any centralized services!
        
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300)) // 5 minutes for large downloads
            .build()
            .map_err(|e| IntegrationError::Other(format!("HTTP client error: {}", e)))?;
        
        let mut snapshot_data = None;
        
        // Try each gateway until success
        for gateway in &gateways {
            let url = format!("{}/ipfs/{}", gateway, cid);
            println!("[INFO][STORAGE] ipfs_trying_gateway url={}", gateway);
            
            match client.get(&url).send().await {
                Ok(response) if response.status().is_success() => {
                    match response.bytes().await {
                        Ok(data) => {
                            snapshot_data = Some(data.to_vec());
                            println!("[INFO][STORAGE] ipfs_downloaded bytes={} gateway={}", data.len(), gateway);
                            break;
                        },
                        Err(e) => {
                            println!("[WARN][STORAGE] ipfs_read_failed gateway={} err={}", gateway, e);
                            continue;
                        }
                    }
                },
                Ok(response) => {
                    println!("[WARN][STORAGE] ipfs_gateway_error gateway={} status={}", gateway, response.status());
                    continue;
                },
                Err(e) => {
                    println!("[WARN][STORAGE] ipfs_connect_failed gateway={} err={}", gateway, e);
                    continue;
                }
            }
        }
        
        let data = snapshot_data
            .ok_or_else(|| IntegrationError::StorageError("Failed to download from any IPFS gateway".to_string()))?;
        
        // Verify and save snapshot
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        // Verify hash before saving
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(&data[40..]); // Skip hash and size fields
        let computed_hash = hasher.finalize();
        
        if &data[..32] != computed_hash.as_slice() {
            return Err(IntegrationError::StorageError("IPFS snapshot integrity check failed".to_string()));
        }
        
        // Save snapshot locally (full format from IPFS)
        let snapshot_key = format!("full_snap_{}", height);
        self.persistent.db.put_cf(&snapshots_cf, snapshot_key.as_bytes(), &data)?;
        
        // Save IPFS reference
        let ipfs_key = format!("ipfs_{}", height);
        self.persistent.db.put_cf(&snapshots_cf, ipfs_key.as_bytes(), cid.as_bytes())?;
        
        println!("[INFO][STORAGE] ipfs_snapshot_saved height={}", height);
        
        Ok(())
    }
    
    /// Get IPFS CID for a snapshot at given height
    pub fn get_snapshot_ipfs_cid(&self, height: u64) -> IntegrationResult<Option<String>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        
        let ipfs_key = format!("ipfs_{}", height);
        match self.persistent.db.get_cf(&snapshots_cf, ipfs_key.as_bytes())? {
            Some(cid_bytes) => Ok(Some(String::from_utf8_lossy(&cid_bytes).to_string())),
            None => Ok(None)
        }
    }
    
    // NOTE: a former `announce_snapshot_to_peers` broadcast a StateSnapshot IPFS-CID hint to
    // every peer, but the receiver only logged it (never fetched) — dead traffic. State sync
    // is fully handled by GALC + the QC-anchored snapshot/full-sync path, so the announcement
    // was removed.

    /// EIP-4444-style body expiry for the archival (Super) tier. Microblock BODIES
    /// (the bulk: heartbeats + TXs) older than `retention_blocks` are dropped, while
    /// the hash index (metadata), macroblocks, snapshots and account state are kept —
    /// so chain-continuity (previous_hash) stays an O(1) hash-index lookup and reward
    /// eligibility (read from state + macroblock summaries) is unaffected. Block 0
    /// (genesis) is never pruned. A watermark in `metadata` bounds each run to the
    /// newly-aged-out range (O(retention/run), not O(height)). Safe by construction:
    /// every body reader uses `if let Ok(Some(..))`, so a pruned body is skipped, and
    /// cold-start replays from a <=1h snapshot, never across the retention window.
    /// Returns the number of bodies pruned this run.
    /// Height below which per-block bodies AND blocklogs have been pruned on this node (0 if never
    /// pruned) — the `body_prune_watermark` written by prune_old_microblock_bodies. getLogs reads
    /// this to report `pruned_below`, so an empty result for an aged-out height is distinguishable
    /// from a block that genuinely emitted no events (both otherwise return count:0).
    pub fn log_prune_floor(&self) -> u64 {
        self.persistent.db.cf_handle("metadata")
            .and_then(|cf| self.persistent.db.get_cf(&cf, b"body_prune_watermark").ok().flatten())
            .filter(|v| v.len() == 8)
            .map(|v| { let mut b = [0u8; 8]; b.copy_from_slice(&v[..8]); u64::from_le_bytes(b) })
            .unwrap_or(0)
    }

    pub fn prune_old_microblock_bodies(&self, current_height: u64, retention_blocks: u64) -> IntegrationResult<u64> {
        // Super (incl. genesis) is the only tier that stores block data: Light nodes
        // are stateless mobile clients and Full nodes are removed. Off-tier or before
        // the first full retention window → nothing to prune.
        if self.storage_mode != StorageMode::Super || current_height <= retention_blocks {
            return Ok(0);
        }
        // Body-only prune: deletes ONLY microblock_{h} bodies, KEEPING macroblock objects +
        // microblock_hash_{h} (the cold-join lineage walk reads macroblock OBJECTS, never bodies), so it
        // can never cross anything that walk needs — no WS-floor clamp required. (An earlier clamp tied to
        // the FROZEN snapshot join-anchor wrongly froze pruning forever above the anchor → unbounded
        // growth on snapshot-joined nodes; removed.)
        let prune_before = current_height - retention_blocks;

        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        const WATERMARK_KEY: &[u8] = b"body_prune_watermark";
        let watermark = self.persistent.db.get_cf(&metadata_cf, WATERMARK_KEY)?
            .filter(|v| v.len() == 8)
            .map(|v| {
                let mut b = [0u8; 8];
                b.copy_from_slice(&v[..8]);
                u64::from_le_bytes(b)
            })
            .unwrap_or(0);

        // Never touch genesis (h=0); resume from the watermark.
        let from = watermark.max(1);
        if prune_before <= from {
            return Ok(0);
        }

        let mut batch = WriteBatch::default();
        for h in from..prune_before {
            // Body only — KEEP metadata/microblock_hash_{h} (continuity) + macroblocks.
            batch.delete_cf(&microblocks_cf, mb_body_key(h).as_bytes());
            // The ancestry rows describe a body that is going away and nothing will ever walk
            // ancestry through an expired range. Left in place they grow ~220 B/block forever
            // (~7 GB/year/node) on the very tier whose purpose is bounding disk. The height→hash
            // alias is deliberately kept: continuity checks still need it.
            if let Ok(Some(existing)) = self.persistent.load_microblock_hash(h) {
                if let Some(prev) = self.persistent.header_index(&existing).map(|hd| hd.previous_hash) {
                    batch.delete_cf(&metadata_cf, &block_child_key(&prev, &existing));
                }
                batch.delete_cf(&metadata_cf, &block_header_key(&existing));
            }
            // Co-prune the OFF-consensus WASM log receipts on the same window: getLogs serves only a
            // bounded recent range (<< retention_blocks), so aged-out blocklogs are unreachable and
            // safe to drop. Default CF (save_raw); zero-padded key ⇒ lexicographically contiguous.
            batch.delete(format!("blocklogs_{:010}", h).as_bytes());
            batch.delete(format!("blocklogsroot_{:010}", h).as_bytes()); // co-prune the per-block sub-root
        }
        batch.put_cf(&metadata_cf, WATERMARK_KEY, &prune_before.to_le_bytes());
        self.persistent.db.write(batch)?;
        // Physically reclaim the aged-out body range (tombstones otherwise persist until natural
        // compaction). Range-scoped ⇒ cost proportional to the pruned span, not the whole CF.
        self.persistent.db.compact_range_cf(
            &microblocks_cf,
            Some(mb_body_key(from).as_bytes()),
            Some(mb_body_key(prune_before).as_bytes()),
        );
        // Same reclaim for the co-pruned blocklogs range (default CF).
        self.persistent.db.compact_range(
            Some(format!("blocklogs_{:010}", from).as_bytes()),
            Some(format!("blocklogs_{:010}", prune_before).as_bytes()),
        );
        // Co-prune the token-transfer index below the same floor (bounded per run; drains a backlog
        // over cycles). Mirrors the tx_by_address retention so this index cannot grow unbounded.
        let pruned_xfers = self.prune_token_transfers_below(prune_before);
        if crate::node::is_info() {
            println!("[INFO][STORAGE] body_prune_compacted from={} to={} xfer_index_pruned={}", from, prune_before, pruned_xfers);
        }

        Ok(prune_before - from)
    }

    /// SLIDING WINDOW: Prune old blocks outside of retention window
    pub fn prune_old_blocks(&self) -> IntegrationResult<()> {
        // Super nodes keep everything (archival role)
        if self.storage_mode == StorageMode::Super {
            return Ok(()); // Super nodes are our "archive" nodes - keep everything
        }
        
        // Light nodes don't store full blocks at all
        if self.storage_mode == StorageMode::Light {
            return self.prune_for_light_node();
        }
        
        let current_height = self.get_chain_height()?;
        if current_height <= self.sliding_window_size {
            return Ok(()); // Not enough blocks yet
        }
        
        let prune_before = current_height - self.sliding_window_size;
        
        // Find last snapshot before pruning point
        let last_snapshot = (prune_before / 10_000) * 10_000; // Round down to snapshot
        if last_snapshot == 0 {
            return Ok(()); // Don't prune before first snapshot
        }
        
        println!("[INFO][STORAGE] block_pruning_start keeping_from={}", prune_before);
        
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let mut batch = WriteBatch::default();
        let mut pruned_count = 0;
        
        // Prune blocks before the window, but after last snapshot
        for height in (last_snapshot + 1)..prune_before {
            // Prune microblocks
            let micro_key = mb_body_key(height);
            if self.persistent.db.get_cf(&microblocks_cf, micro_key.as_bytes())?.is_some() {
                batch.delete_cf(&microblocks_cf, micro_key.as_bytes());
                pruned_count += 1;
            }
            
            // CRITICAL FIX: Also prune macroblocks (they were NEVER deleted!)
            // Macroblocks have their own numbering: macro #1 = after micro 90, macro #2 = after micro 180
            // Check if this microblock height corresponds to a macroblock
            if height % 90 == 0 && height > 0 {
                // This microblock height has a corresponding macroblock
                let macro_number = height / 90;
                let macro_key = format!("macroblock_{}", macro_number);
                if self.persistent.db.get_cf(&microblocks_cf, macro_key.as_bytes())?.is_some() {
                    batch.delete_cf(&microblocks_cf, macro_key.as_bytes());
                    pruned_count += 1;
                    println!("[INFO][STORAGE] macroblock_pruned macro_num={} micro_height={}", 
                            macro_number, height);
                }
            }
                
                // Apply batch every 1000 blocks to avoid memory issues
                if pruned_count % 1000 == 0 {
                    self.persistent.db.write(batch)?;
                    batch = WriteBatch::default();
                    println!("[INFO][STORAGE] pruning_progress count={}", pruned_count);
            }
        }
        
        // Apply remaining batch
        if !batch.is_empty() {
            self.persistent.db.write(batch)?;
        }
        
        // Force compaction to reclaim space
        self.persistent.db.compact_range_cf(&microblocks_cf, 
            Some(mb_body_key(last_snapshot).as_bytes()),
            Some(mb_body_key(prune_before).as_bytes()));
        
        println!("[INFO][STORAGE] blocks_pruned count={} before_height={} snapshot_at={}", 
                pruned_count, prune_before, last_snapshot);
        
        // CRITICAL: Also prune transactions from pruned blocks
        // Transactions are stored separately and must be cleaned up
        let tx_pruned = self.prune_old_transactions(prune_before)?;
        if tx_pruned > 0 {
            println!("[INFO][STORAGE] txs_pruned count={}", tx_pruned);
        }
        
        // Update metadata
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.persistent.db.put_cf(&metadata_cf, b"oldest_block", &prune_before.to_le_bytes())?;
        
        Ok(())
    }
    
    /// v9.0: Prune old transactions + tx_index + tx_by_address below retention height.
    /// Uses HashSet for O(1) lookups (was O(n) Vec::contains — quadratic on large datasets).
    /// Called from prune_old_blocks() for non-Super nodes, and from run_ephemeral_cleanup()
    /// for ALL node types (Super nodes keep blocks but prune tx indices beyond retention).
    /// Bounded per-call prune of `transactions` / `tx_index` / `tx_by_address`.
    ///
    /// The two index families are pruned on INDEPENDENT criteria: `tx_index` by the block height
    /// it stores, `tx_by_address` by the timestamp embedded in its own key
    /// (`addr_{address}_{ts:016x}_{tx_hash}`). Deriving the address rows from the set of hashes
    /// collected in this call would orphan every matching row outside the window — the two column
    /// families sort on unrelated orders, and once the `tx_index` row is gone the hash can never
    /// be rediscovered.
    ///
    /// Both scans resume from a persisted cursor and stop at a row cap, so one call costs O(cap)
    /// regardless of index size. Returns the number of transactions pruned; the hourly cadence
    /// catches up.
    pub fn prune_old_transactions(&self, prune_before_height: u64) -> IntegrationResult<u64> {
        // A fixed row cap is a throughput bet: set it below the production rate and retention stops
        // holding, silently, exactly when the chain gets busy. Budget instead from the work that must
        // be done — one full sweep of each index inside the retention window — measured from RocksDB's
        // own key estimate, with a floor so a young chain still makes progress and a ceiling so one
        // call cannot stall the maintenance thread.
        let runs_in_window = (TX_INDEX_RETENTION_BLOCKS / 3_600).max(1) * PRUNE_RUNS_PER_HOUR;
        let tx_scan_cap = self.sweep_budget("tx_index", runs_in_window);
        let addr_scan_cap = self.sweep_budget("tx_by_address", runs_in_window);

        let tx_cf = self.persistent.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        let tx_index_cf = self.persistent.db.cf_handle("tx_index")
            .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
        let tx_by_addr_cf = self.persistent.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        let meta_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let read_cursor = |k: &[u8]| -> Vec<u8> {
            self.persistent.db.get_cf(&meta_cf, k).ok().flatten().unwrap_or_default()
        };

        let mut batch = WriteBatch::default();
        let mut pruned_count: u64 = 0;

        // ── transactions + tx_index, by stored block height ──
        let tx_cursor = read_cursor(b"prune_tx_index_cursor");
        let tx_mode = if tx_cursor.is_empty() {
            rocksdb::IteratorMode::Start
        } else {
            rocksdb::IteratorMode::From(&tx_cursor, rocksdb::Direction::Forward)
        };
        let mut examined = 0usize;
        let mut last_tx_key: Option<Vec<u8>> = None;
        for item in self.persistent.db.iterator_cf(&tx_index_cf, tx_mode) {
            let (key, value) = item?;
            examined += 1;
            last_tx_key = Some(key.to_vec());
            if value.len() >= 8 {
                let block_height = u64::from_be_bytes(value[..8].try_into().unwrap_or([0u8; 8]));
                if block_height < prune_before_height {
                    batch.delete_cf(&tx_cf, &key);
                    batch.delete_cf(&tx_index_cf, &key);
                    pruned_count += 1;
                    if pruned_count % 5000 == 0 {
                        self.persistent.db.write(batch)?;
                        batch = WriteBatch::default();
                    }
                }
            }
            if examined >= tx_scan_cap {
                break;
            }
        }
        // Cap reached → resume here next call; scan finished → wrap to the start.
        let next_tx_cursor: Vec<u8> = if examined >= tx_scan_cap {
            last_tx_key.unwrap_or_default()
        } else {
            Vec::new()
        };
        batch.put_cf(&meta_cf, b"prune_tx_index_cursor", &next_tx_cursor);

        // ── tx_by_address, by the inclusion HEIGHT in its own key ──
        // Scanned independently of tx_index (the two families sort on unrelated orders, so deriving
        // one from the other orphans rows), but cut on the SAME height rule. The key used to carry
        // `tx.timestamp`, which the sender picks: one row stamped in the future was unreachable by
        // any prune, forever.

        let addr_cursor = read_cursor(b"prune_addr_cursor");
        let addr_mode = if addr_cursor.is_empty() {
            rocksdb::IteratorMode::Start
        } else {
            rocksdb::IteratorMode::From(&addr_cursor, rocksdb::Direction::Forward)
        };
        let mut addr_examined = 0usize;
        let mut addr_pruned: u64 = 0;
        let mut addr_unparsed: u64 = 0;
        let mut last_addr_key: Option<Vec<u8>> = None;
        for item in self.persistent.db.iterator_cf(&tx_by_addr_cf, addr_mode) {
            let (key, _value) = item?;
            addr_examined += 1;
            last_addr_key = Some(key.to_vec());
            match Self::addr_index_height(&key) {
                Some(h) if h < prune_before_height => {
                    batch.delete_cf(&tx_by_addr_cf, &key);
                    addr_pruned += 1;
                    if addr_pruned % 5000 == 0 {
                        self.persistent.db.write(batch)?;
                        batch = WriteBatch::default();
                    }
                }
                Some(_) => {}
                // Not a key this writer produces. Never deleted on a guess (a parse miss is not
                // evidence of age), but counted so corruption is visible instead of silent.
                None => addr_unparsed += 1,
            }
            if addr_examined >= addr_scan_cap {
                break;
            }
        }
        let next_addr_cursor: Vec<u8> = if addr_examined >= addr_scan_cap {
            last_addr_key.unwrap_or_default()
        } else {
            Vec::new()
        };
        batch.put_cf(&meta_cf, b"prune_addr_cursor", &next_addr_cursor);

        if !batch.is_empty() {
            self.persistent.db.write(batch)?;
        }

        if addr_unparsed > 0 {
            println!("[WARN][PRUNE] addr_index_unparsed rows={} action=retained", addr_unparsed);
        }
        if (pruned_count > 0 || addr_pruned > 0) && crate::node::is_info() {
            println!("[INFO][PRUNE] tx_done txs={} addr_entries={} before_h={} tx_scanned={}/{} addr_scanned={}/{}",
                     pruned_count, addr_pruned, prune_before_height,
                     examined, tx_scan_cap, addr_examined, addr_scan_cap);
        }

        Ok(pruned_count)
    }

    /// Inclusion height embedded in a `tx_by_address` key: `addr_{address}_{height:016x}_{tx_hash}`.
    /// The address itself may contain `_`, so the field is located from the RIGHT.
    pub(super) fn addr_index_height(key: &[u8]) -> Option<u64> {
        let s = std::str::from_utf8(key).ok()?;
        let mut parts = s.rsplitn(3, '_');
        let _tx_hash = parts.next()?;
        let h_hex = parts.next()?;
        u64::from_str_radix(h_hex, 16).ok()
    }

    /// Rows one maintenance pass may examine in a column family so that `runs_in_window` passes
    /// sweep all of it. Uses RocksDB's own key estimate, so the budget tracks real load instead of
    /// a number someone picked once. Floor: a young index still drains. Ceiling: one pass stays short
    /// enough that the hourly maintenance thread never becomes the bottleneck.
    pub(super) fn sweep_budget(&self, cf_name: &str, runs_in_window: u64) -> usize {
        const MIN_SWEEP: usize = 50_000;
        const MAX_SWEEP: usize = 5_000_000;
        let est = self.persistent.db.cf_handle(cf_name)
            .and_then(|cf| self.persistent.db.property_int_value_cf(&cf, "rocksdb.estimate-num-keys").ok().flatten())
            .unwrap_or(0);
        let needed = (est / runs_in_window.max(1)) as usize;
        needed.clamp(MIN_SWEEP, MAX_SWEEP)
    }

    /// DEPRECATED — legacy "headers-only" Light pruning pass.
    ///
    /// Current Light tier (v3.18+) is a pure mobile API client with
    /// zero on-device chain storage; the `save_microblock` path is a
    /// no-op for `StorageMode::Light`, so this pruning function should
    /// never observe any rows to convert. Retained for backward
    /// compatibility with the historical header-rotation tier and to
    /// keep call sites compiling. Will be removed in a future cleanup.
    pub(super) fn prune_for_light_node(&self) -> IntegrationResult<()> {
        println!("[INFO][STORAGE] light_node_prune_start mode=legacy_no_op");
        
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        let mut batch = WriteBatch::default();
        let mut converted = 0;
        
        // Convert full blocks to headers only
        let iter = self.persistent.db.iterator_cf(&microblocks_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, value) = item?;
            
            // Skip if already a header
            if value.len() < 1000 { // Headers are much smaller than full blocks
                continue;
            }
            
            // Extract header from full block (simplified - in production would deserialize properly)
            let header = &value[..200.min(value.len())]; // bytes, not str
            batch.put_cf(&microblocks_cf, &key, header);
            converted += 1;
            
            if converted % 100 == 0 {
                self.persistent.db.write(batch)?;
                batch = WriteBatch::default();
            }
        }
        
        if !batch.is_empty() {
            self.persistent.db.write(batch)?;
        }
        
        println!("[INFO][STORAGE] blocks_to_headers converted={}", converted);
        
        Ok(())
    }
    
    /// Get current storage mode
    pub fn get_storage_mode(&self) -> StorageMode {
        self.storage_mode
    }
    
    /// Check if block is within retention window
    pub fn is_block_retained(&self, _height: u64) -> bool {
        match self.storage_mode {
            StorageMode::Super => true,  // Super nodes keep everything (archival)
            StorageMode::Light => false, // Light nodes don't store blocks (API client)
        }
    }
    
    /// Estimate storage requirements for current configuration
    pub fn estimate_storage_requirements(&self) -> String {
        // v3.19: Light nodes = NO storage (pure API client), Super = archival
        match self.storage_mode {
            StorageMode::Light => "0 MB (API client only, no local storage)".to_string(),
            StorageMode::Super => "500 GB - 1 TB (complete blockchain history with compression)".to_string(),
        }
    }
    
    /// Get the latest snapshot height available for fast sync.
    /// Prefers full snapshots (latest_full_snap) over state snapshots (latest_state_snap),
    /// falls back to numerical scan over all snapshot_* keys.
    /// Highest RETAINED snapshot height ≤ ceiling — cold-join verifiable-anchor negotiation. A joiner
    /// clamps to its exogenously-verifiable anchor (GALC pin / h=90); a peer whose latest snapshot is
    /// ABOVE that pin must still offer the highest one ≤ it. None ⇒ peer retains no snapshot ≤ ceiling.
    pub fn get_highest_snapshot_height_le(&self, ceiling: u64) -> IntegrationResult<Option<u64>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;
        let mut best = 0u64;
        let iter = self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            if let Ok((key, _)) = item {
                let key_str = String::from_utf8_lossy(&key);
                // full_snap_ ONLY — we advertise to P2P joiners, who must receive a COMPLETE snapshot.
                let h_opt = key_str.strip_prefix("full_snap_");
                if let Some(h_str) = h_opt {
                    if let Ok(h) = h_str.parse::<u64>() {
                        if h <= ceiling && h > best { best = h; }
                    }
                }
            }
        }
        Ok(if best > 0 { Some(best) } else { None })
    }

    pub fn get_latest_snapshot_height(&self) -> IntegrationResult<Option<u64>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        // Advertised to P2P joiners ⇒ full_snap_ ONLY (complete snapshots); state_snap_ is local-only.
        // 1. Prefer the full-snapshot pointer.
        if let Ok(Some(data)) = self.persistent.db.get_cf(&snapshots_cf, b"latest_full_snap") {
            if data.len() >= 8 {
                if let Ok(bytes) = data[..8].try_into() {
                    let height = u64::from_le_bytes(bytes);
                    if height > 0 { return Ok(Some(height)); }
                }
            }
        }

        // 2. Fall back to a scan over full_snap_ keys (nodes without the pointer).
        let mut latest_height = 0u64;
        let iter = self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            if let Ok((key, _)) = item {
                let key_str = String::from_utf8_lossy(&key);
                if let Some(h_str) = key_str.strip_prefix("full_snap_") {
                    if let Ok(h) = h_str.parse::<u64>() {
                        if h > latest_height { latest_height = h; }
                    }
                }
            }
        }

        if latest_height > 0 { Ok(Some(latest_height)) } else { Ok(None) }
    }
    
    /// v32.9: Canonical state root computed from accounts CF in RocksDB.
    /// Deterministic across nodes — every honest node hashes the same
    /// sorted (key, value) list domain-separated by height. Used for
    /// snapshot consensus binding via Pattern C (state_root commitment
    /// instead of opaque SHA3-of-bytes). Independent of in-memory
    /// StateManager so verifier can compute after applying a downloaded
    /// snapshot without re-initialising state.
    pub fn compute_canonical_state_root(&self, height: u64) -> IntegrationResult<[u8; 32]> {
        let accounts_cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;

        let mut entries: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        let iter = self.persistent.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            match item {
                Ok((k, v)) => entries.push((k.to_vec(), v.to_vec())),
                Err(e) => return Err(IntegrationError::StorageError(format!("canonical_root_iter_err: {}", e))),
            }
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));

        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(b"QNET_CANONICAL_STATE_ROOT_V1:");
        hasher.update(&height.to_le_bytes());
        hasher.update(&(entries.len() as u64).to_le_bytes());
        for (k, v) in &entries {
            hasher.update(&(k.len() as u32).to_le_bytes());
            hasher.update(k);
            hasher.update(&(v.len() as u32).to_le_bytes());
            hasher.update(v);
        }
        let mut root = [0u8; 32];
        root.copy_from_slice(&hasher.finalize());
        Ok(root)
    }

    /// Rebuild the canonical account-state merkle root (the consensus
    /// finalize_merkle output) from the accounts CF. Binds a restored snapshot
    /// to the QC-certified mb.state_root: a forged snapshot yields a different
    /// root. Deterministic — a fresh StateMerkleTree full-recomputes (no
    /// incremental cache), matching every node's finalize().
    pub fn recompute_account_merkle_root(&self) -> IntegrationResult<[u8; 32]> {
        self.recompute_account_merkle_root_cf("accounts")
    }

    /// Account merkle over an explicit CF: "accounts" (live) or "accounts_stage" (cold-join verify).
    /// Streams the CF row-by-row into a throwaway tree (no full Vec) — the finalized root is identical
    /// (the tree is leaf-set-keyed, so insertion streaming vs batch yields the same root).
    pub fn recompute_account_merkle_root_cf(&self, cf_name: &str) -> IntegrationResult<[u8; 32]> {
        let accounts_cf = self.persistent.db.cf_handle(cf_name)
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut tree = qnet_state::StateMerkleTree::new();
        for item in self.persistent.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start) {
            let (k, v) = item.map_err(|e| IntegrationError::StorageError(format!("merkle_iter_err: {}", e)))?;
            let addr = String::from_utf8(k.to_vec())
                .map_err(|e| IntegrationError::StorageError(format!("merkle_addr_utf8_err: {}", e)))?;
            let account: qnet_state::Account = bincode::deserialize(&v)
                .map_err(|e| IntegrationError::SerializationError(format!("merkle_account_decode_err: {}", e)))?;
            // V2 SNAPSHOT BINDING: under the SROOT schema the contract account leaf commits only
            // storage_root, NOT the raw contract_storage map (the old full-map fold is gone). So a
            // restored/untrusted contract_storage that does NOT hash to the committed storage_root would
            // still reproduce state_root and pass the Pattern-C bind — yet serve forged balances and fork
            // on the next write. Re-derive and reject the mismatch here (O(entries)) to restore the
            // transitive binding the fold gave for free, so a tampered snapshot fails the bind check.
            if !qnet_state::StateMerkleTree::contract_storage_root_matches(&account) {
                return Err(IntegrationError::StorageError(format!(
                    "[REJECT][SNAPSHOT] storage_root_mismatch addr={} cf={}", addr, cf_name)));
            }
            tree.insert_lazy(&addr, &account);
        }
        Ok(tree.finalize())
    }

    /// Get raw snapshot data for P2P download (v2.19.12)
    /// Returns compressed binary snapshot data
    pub fn get_snapshot_data(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        // P2P cold-join serve: full_snap_ ONLY. state_snap_ is an accounts+supply local-restart artifact
        // (incomplete — no rewards/contracts/registry CFs) and must NEVER be served to a joiner, who would
        // recompute a wrong bound root. The local/P2P role is now EXPLICIT, not an accidental key-unit gap.
        let key = format!("full_snap_{}", height);
        if let Some(data) = self.persistent.db.get_cf(&snapshots_cf, key.as_bytes())? {
            return Ok(Some(data));
        }
        Ok(None)
    }
    
    /// Binder lineage-walk budget (macroblocks): the max genesis/pin-rooted N-2 QC walk a cold joiner will
    /// re-verify. SINGLE SOURCE for both the snapshot SELECTION ceiling (download_and_load_snapshot) and the
    /// binder (verify_snapshot_consensus_binding) so the two can never drift. ~2 weeks at 1 blk/s ⇒ realistic
    /// binary-WS-pin rotation cadence; a fresh GALC capsule normally keeps the real walk ≈ 0.
    pub(super) const SNAPSHOT_MAX_WS_WALK_MB: u64 = 13_440;

    /// Committee signatures are the bulk of a macroblock — 2f+1 ML-DSA-65 envelopes, ~3 MB at the
    /// 1000-member target committee, against a few KB for everything else. They are read ONLY by
    /// `verify_v2_macroblock`, which runs at INGEST; every reader of a STORED macroblock takes the
    /// checkpoint half (reward roots, total_supply, registry_root, recovery anchor). So the sigs are
    /// needed exactly as long as a cold joiner may still walk to this index — the binder budget below
    /// — plus margin for tip skew between joiner and server and the walk's one-below descent.
    ///
    /// Without this, macroblock storage on a Super (which prunes nothing) grows ~1 TB/year at target
    /// scale and has no horizon at all. Stripping is fork-free by construction: `MacroBlock::hash()`
    /// excludes consensus_data, and `sig_merkle_root` stays, so the removed set is still committed.
    pub(super) const QC_SIG_RETENTION_MB: u64 = Self::SNAPSHOT_MAX_WS_WALK_MB + 1_440;

    /// Strip committee signatures from macroblocks whose index is below the retention horizon, keeping
    /// the checkpoint, the signer list and `sig_merkle_root`. Bounded and resumable: the cursor is the
    /// highest index already swept, so runs form one monotone forward sweep and never re-read the tail.
    /// Absent indices (a snapshot-joined node holds none below its anchor) advance the cursor for free.
    /// Returns how many macroblocks were rewritten.
    pub fn strip_macroblock_qc_sigs(&self) -> IntegrationResult<u64> {
        /// Indices looked at per call. A miss is one bloom-filter probe, so this may be large — it is
        /// what lets a snapshot-joined node sweep past its empty pre-anchor range in a few runs.
        const EXAMINE_CAP: u64 = 50_000;
        /// Macroblocks rewritten per call: the real work bound (decode + re-serialize + write).
        const REWRITE_CAP: u64 = 512;

        let tip_mb = self.get_chain_height()?.saturating_div(90);
        let floor = match tip_mb.checked_sub(Self::QC_SIG_RETENTION_MB) {
            Some(f) if f > 0 => f,
            _ => return Ok(0), // young chain: nothing is outside the walk budget yet
        };

        let micro_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let meta_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let mut swept = self.persistent.db.get_cf(&meta_cf, b"qc_sig_strip_cursor")?
            .filter(|v| v.len() == 8)
            .map(|v| u64::from_be_bytes(v[..8].try_into().unwrap_or([0u8; 8])))
            .unwrap_or(0);

        let mut batch = WriteBatch::default();
        let mut rewritten: u64 = 0;
        let mut examined: u64 = 0;
        while swept < floor && examined < EXAMINE_CAP && rewritten < REWRITE_CAP {
            let index = swept + 1;
            examined += 1;
            swept = index;
            let key = format!("macroblock_{}", index);
            let raw = match self.persistent.db.get_cf(&micro_cf, key.as_bytes())? {
                Some(r) if !r.is_empty() => r,
                _ => continue,
            };
            // Stored macroblocks may be zstd-framed; re-store in the SAME framing so no reader has to
            // learn a new one.
            let compressed = raw.len() >= 4 && raw[0..4] == [0x28, 0xb5, 0x2f, 0xfd];
            let plain = if compressed {
                match zstd::decode_all(&raw[..]) { Ok(d) => d, Err(_) => continue }
            } else {
                raw
            };
            let mut mb: qnet_state::MacroBlock = match bincode::deserialize(&plain) {
                Ok(m) => m,
                Err(_) => continue, // unreadable row: leave it exactly as found, never destroy
            };
            let qc_bytes = match mb.consensus_data.checkpoint_qc.as_ref() { Some(b) => b, None => continue };
            let (cp, mut qc): (qnet_consensus::checkpoint_bft::Checkpoint,
                               qnet_consensus::checkpoint_bft::QuorumCertificate) =
                match bincode::deserialize(qc_bytes) { Ok(v) => v, Err(_) => continue };
            if qc.sigs.is_empty() { continue; }
            qc.sigs = Vec::new();
            let restripped = match bincode::serialize(&(cp, qc)) { Ok(b) => b, Err(_) => continue };
            mb.consensus_data.checkpoint_qc = Some(restripped);
            let reserialized = match bincode::serialize(&mb) { Ok(b) => b, Err(_) => continue };
            let out = if compressed {
                match zstd::encode_all(&reserialized[..], 3) { Ok(c) => c, Err(_) => continue }
            } else {
                reserialized
            };
            batch.put_cf(&micro_cf, key.as_bytes(), &out);
            rewritten += 1;
        }

        batch.put_cf(&meta_cf, b"qc_sig_strip_cursor", &swept.to_be_bytes());
        self.persistent.db.write(batch)?;
        if rewritten > 0 && crate::node::is_info() {
            println!("[INFO][STORAGE] qc_sigs_stripped count={} up_to={} floor={}", rewritten, swept, floor);
        }
        Ok(rewritten)
    }

    /// True iff this stored macroblock still carries its committee signatures. A stripped one is
    /// useless to a syncing peer: `verify_v2_macroblock` would read the empty set as an invalid QC and
    /// score the honest server as byzantine, so the sync path serves it as ABSENT instead.
    pub fn macroblock_carries_qc_sigs(mb: &qnet_state::MacroBlock) -> bool {
        mb.consensus_data.checkpoint_qc.as_ref().map_or(false, |b| {
            bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint,
                                    qnet_consensus::checkpoint_bft::QuorumCertificate)>(b)
                .map_or(false, |(_, qc)| !qc.sigs.is_empty())
        })
    }

    /// Highest macroblock index contiguously present at/above the apply frontier (chain_height/90). Present
    /// ⟹ inductively QC-verified (stored only after verify_v2). SINGLE SOURCE for the selection ceiling AND
    /// the binder walk budget so the two extents can never drift. Bounded: chain_height/90 is a tight lower
    /// bound and any fill-ahead is capped at SNAPSHOT_MAX_WS_WALK_MB, so this never scans O(chain).
    pub(super) fn own_contiguous_frontier_mb(&self) -> u64 {
        let mut f = self.get_chain_height().unwrap_or(0) / 90;
        while self.get_macroblock_by_height(f.saturating_add(1)).ok().flatten().is_some() {
            f = f.saturating_add(1);
        }
        f
    }

    /// v5.0: Download snapshot from network — chunked parallel download with fallback
    pub async fn download_and_load_snapshot(&self, p2p: &crate::unified_p2p::SimplifiedP2P) -> IntegrationResult<u64> {
        let peers = p2p.get_validated_active_peers();
        if peers.is_empty() {
            return Err(IntegrationError::Other("No peers available for snapshot download".to_string()));
        }

        // Two-phase snapshot negotiation. Phase 1: query each peer's
        // advertised snapshot height (differ per-node — creation is per-node).
        // Phase 2: pick best_height and download ONLY from peers that
        // reported exactly it — including lower/no-height peers would return
        // None on get_snapshot_chunk and break the manifest chain, forcing
        // fallback even when a capable peer exists. >1 such peer → parallel
        // fan-out; exactly 1 → serial (still faster than block-by-block).
        // IPFS fast path preserved: ipfs_cid + IPFS_ENABLED short-circuits
        // to the gateway, bypassing peer fan-out. O(active_peers) discovery.

        // v31.5: Phase 1 discovery — parallel fan-out via join_all.
        // Cost = max(rtt) regardless of peer count.
        let mut best_height = 0u64;
        let mut peer_heights: Vec<(String, u64)> = Vec::new();

        // A1: settle the genesis-rooted GALC pin BEFORE reading the ceiling — the capsule arrives +
        // Dilithium-verifies asynchronously, so a joiner without a near-tip pin acquires it first to keep the
        // binder walk ≈ 0. Re-sample the (f+1)-corroborated tip EACH pass: at t=0 the cache can read 0 (peers
        // up, head not yet reported), so should_have_capsule latches ONLY once a mature tip (mb >=
        // GALC_MINT_INTERVAL) is corroborated. A corroborated young chain fail-opens; an unproven tip keeps
        // polling. On mature-tip-but-pin-absent it returns retryable AnchorPending (bounded eclipse floor).
        static COLDJOIN_ANCHOR_PENDING_ROUNDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        const COLDJOIN_ANCHOR_PENDING_MAX: u64 = 10; // ~2 min of retries, then fail-open (eclipse liveness floor)
        // Engage the pin-wait keyed on pin-staleness vs the (f+1)-corroborated mature tip — NOT own_frontier
        // (concurrent linear sync advancing it, or a prior low-anchor adoption, must never disarm the wait).
        // Skip it when a near-tip pin is already held OR our own contiguous verified frontier can already bind
        // a snapshot within the walk budget (no capsule needed). All callers gate this on far-behind.
        let corr_tip_mb = p2p.corroborated_head_ceiling() / 90;
        // FRESH (near-tip) pin. Keyed on STALENESS, not mere existence — a stale nonzero pin (old capsule
        // from a lagging peer) must NOT count as reached. Takes the tip explicitly so the loop re-checks
        // against the LIVE corroborated tip each pass. Margin = 2 mint intervals, not 1: the capsule roots at
        // the latest FINALIZED 40-boundary K while corr_tip_mb is the (unfinalized) microblock tip that leads
        // it by up to ~1 interval (boundary floor + finality lag), so a 1-interval margin would misflag the
        // freshest mintable capsule as stale for part of each cycle → spurious AnchorPending. 2 intervals
        // absorbs the gap; a genuinely old capsule (≥2 intervals below tip) is still stale and the resulting
        // binder walk stays ≤2 intervals (cheap).
        let pin_fresh = |mb: u64, tip_mb: u64| mb > 0 && tip_mb > 0
            && mb.saturating_add(2 * crate::galc::GALC_MINT_INTERVAL) > tip_mb;
        // A node whose own contiguous frontier is within the walk budget of the tip binds cheaply from its
        // own lineage and needs no capsule — do not stall it in the wait (it would AnchorPending pointlessly).
        let frontier_can_bind = corr_tip_mb > 0
            && corr_tip_mb.saturating_sub(self.own_contiguous_frontier_mb()) <= Self::SNAPSHOT_MAX_WS_WALK_MB;
        if !pin_fresh(crate::galc::effective_pin_checkpoint().0, corr_tip_mb) && !frontier_can_bind {
            const GALC_PIN_WAIT_ATTEMPTS: u32 = 20;       // ≤ ~10s per cold-join call
            const GALC_PIN_WAIT_INTERVAL_MS: u64 = 500;
            let mut should_have_capsule = false;          // set true ONLY on a (f+1)-corroborated mature tip
            let mut tip_live = corr_tip_mb;
            for i in 0..GALC_PIN_WAIT_ATTEMPTS {
                // Re-read the LIVE (f+1)-corroborated tip each pass: corroborated_head_ceiling() is the
                // (f+1)-th highest fresh in-set peer height, or 0 when < f+1 corroborators — a lone lying peer
                // cannot raise it. 0 = uncorroborated → keep polling.
                tip_live = p2p.corroborated_head_ceiling() / 90;
                // Break on a FRESH pin (near the live tip), not mere existence: a stale nonzero pin keeps
                // polling for the near-tip capsule via the re-request below, else the ceiling would collapse.
                if pin_fresh(crate::galc::effective_pin_checkpoint().0, tip_live) { break; }
                if tip_live >= crate::galc::GALC_MINT_INTERVAL { should_have_capsule = true; }
                else if tip_live > 0 { break; }            // CORROBORATED young chain (< first capsule) → fail-open to h=90
                // tip_live == 0: no f+1 corroboration yet → keep polling (never latch from an unproven tip)
                if i % 4 == 0 {                            // re-request every ~2s (a reply may be lost)
                    let _ = p2p.broadcast_quic(&crate::unified_p2p::NetworkMessage::RequestGenesisCheckpoint {
                        requester_id: "snapshot_ceiling".to_string(),
                    }).await;
                }
                tokio::time::sleep(std::time::Duration::from_millis(GALC_PIN_WAIT_INTERVAL_MS)).await;
            }
            // Mature tip but still no FRESH pin (stale-nonzero OR absent): return retryable AnchorPending so
            // the caller bails to the desync tick rather than rooting the ceiling at a stale/genesis extent.
            // Bounded escape after COLDJOIN_ANCHOR_PENDING_MAX rounds → fail-open to block-replay (eclipse floor).
            // The counter is process-global (shared across cold-join drivers); in a true eclipse every driver
            // takes the increment (none the reset), so it climbs monotonically to MAX — no livelock.
            if should_have_capsule && !pin_fresh(crate::galc::effective_pin_checkpoint().0, tip_live) {
                let rounds = COLDJOIN_ANCHOR_PENDING_ROUNDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                if rounds <= COLDJOIN_ANCHOR_PENDING_MAX {
                    if crate::node::is_info() {
                        println!("[INFO][SYNC] coldjoin_anchor_pending round={}/{} — retry next tick", rounds, COLDJOIN_ANCHOR_PENDING_MAX);
                    }
                    return Err(IntegrationError::AnchorPending);
                }
                if crate::node::is_warn() {
                    println!("[WARN][SYNC] coldjoin_anchor_pending_exhausted rounds={} — fail-open to block-replay (degraded/eclipse)", rounds);
                }
            }
            COLDJOIN_ANCHOR_PENDING_ROUNDS.store(0, std::sync::atomic::Ordering::Relaxed);
        }

        // Exogenously-verifiable negotiation ceiling — genesis/pin/frontier-rooted, NEVER a raw peer tip. A
        // cold joiner may adopt any snapshot whose anchor the binder re-verifies from a trusted root within its
        // REAL walk budget (SNAPSHOT_MAX_WS_WALK_MB, the same CONSTANT verify_snapshot_consensus_binding
        // enforces). Roots: the GALC pin, the rotated WS floor, or its OWN highest contiguous-present macro-
        // block (present ⟹ inductively QC-verified from genesis). Prior code capped this at base+15mb, below
        // the latest snapshot whenever the verified extent lags it by ≥1 interval (40mb) → the joiner was
        // forced onto a stale anchor + O(chain) tail. NOTE: the binder credits the pin as a walk root ONLY
        // when usable (ws_floor < pin ≤ anchor); a capsule minted one interval ABOVE the negotiated anchor
        // roots the binder at ws_floor instead, so at a boundary crossing an admitted snapshot may be re-
        // verified from ws_floor/frontier (transiently rejected + retried next tick, never mis-bound). Bytes
        // stay bound to the anchor's 2f+1 snapshot_root on promote and a forged anchor fails the QC walk →
        // block replay, so the wide ceiling never weakens weak-subjectivity. base==0 + no mature tip ⇒ h=90.
        let verifiable_ceiling = {
            let pin_mb = crate::galc::effective_pin_checkpoint().0;
            let ws_floor_mb = crate::node::effective_ws_checkpoint().0;
            let base_mb = pin_mb.max(ws_floor_mb).max(self.own_contiguous_frontier_mb());
            if base_mb == 0 && corr_tip_mb < crate::galc::GALC_MINT_INTERVAL {
                crate::node::SNAPSHOT_EARLY_ANCHOR_HEIGHT
            } else {
                base_mb.saturating_add(Self::SNAPSHOT_MAX_WS_WALK_MB).saturating_mul(90)
            }
        };

        let queries: Vec<_> = peers.iter().map(|peer| {
            let addr = peer.addr.clone();
            let storage_ref = self;
            async move {
                let result = storage_ref.query_peer_snapshot(&addr, verifiable_ceiling).await;
                (addr, result)
            }
        }).collect();

        let results = futures::future::join_all(queries).await;

        for (addr, result) in results {
            if let Ok(Some((height, cid))) = result {
                if height > verifiable_ceiling { continue; } // defense: peer ignored the ceiling param
                if height > best_height {
                    best_height = height;
                }
                // IPFS fast path — content-addressed, scales with the swarm
                // rather than the validator committee.
                if !cid.is_empty() && std::env::var("IPFS_ENABLED").unwrap_or_default() == "1" {
                    if let Ok(_) = self.download_snapshot_from_ipfs(&cid, height).await {
                        // An IPFS CID is content-addressed but NOT consensus-bound — route it through the
                        // SAME staged 2f+1-QC anchor binding + promote as the chunked/legacy paths.
                        if let Ok(h) = self.verify_and_promote_staged(p2p, height).await {
                            println!("[INFO][SYNC] snapshot_from_ipfs h={} bound=ok", h);
                            return Ok(h);
                        }
                    }
                }
                peer_heights.push((addr, height));
            }
        }

        if best_height == 0 || peer_heights.is_empty() {
            return Err(IntegrationError::Other("No snapshots available from network".to_string()));
        }

        // ── Phase 2: pick the HIGHEST height advertised by a quorum (>=2) of peers so the
        // download has redundant sources for parallel fan-out + retry. The single max is
        // often one peer mid-boundary → serial download. Fall back to max if none shared.
        let target_height = {
            let mut counts: std::collections::BTreeMap<u64, usize> = std::collections::BTreeMap::new();
            for (_, h) in &peer_heights { *counts.entry(*h).or_insert(0) += 1; }
            let quorum = 2usize.min(peer_heights.len());
            counts.iter().rev().find(|(_, c)| **c >= quorum).map(|(h, _)| *h).unwrap_or(best_height)
        };
        let peer_addrs: Vec<String> = peer_heights
            .iter()
            .filter(|(_, h)| *h == target_height)
            .map(|(addr, _)| addr.clone())
            .collect();

        if peer_addrs.is_empty() {
            return Err(IntegrationError::Other(format!(
                "snapshot_peer_filter_empty target_height={} candidates={}",
                target_height, peer_heights.len(),
            )));
        }

        // Forward-only: never adopt a snapshot at/below our own chain height (promote sets chain_height,
        // so a ≤-local snapshot would REGRESS the node). The verifiable-ceiling clamp can yield a
        // below-local anchor for a node already past it (e.g. capsule-less + advanced via replay) — fall
        // to block replay instead, which continues forward.
        let local_h = self.get_chain_height().unwrap_or(0);
        if target_height <= local_h {
            return Err(IntegrationError::Other(format!(
                "snapshot_not_forward target={} local={} action=block_replay", target_height, local_h
            )));
        }

        // Snapshot is the preferred cold-join path: a transient binding/download failure is retried each
        // desync tick (~15s backoff), never permanently latched. Forward-only guard above is the only
        // suppression; convergence relies on the frontier-reserved dispatcher, not on disabling the jump.
        println!(
            "[INFO][SYNC] snapshot_download h={} capable_peers={}/{} discovery=two_phase",
            target_height, peer_addrs.len(), peer_heights.len(),
        );

        // Chunked parallel download first (restores into staging), fallback to single-peer. Then
        // verify-then-promote: the staged snapshot is bound to the 2f+1 macroblock root and only on
        // success copied into live state; ANY failure drops staging and falls to block replay.
        match self.download_snapshot_chunked(p2p, &peer_addrs, target_height).await {
            Ok(()) => self.verify_and_promote_staged(p2p, target_height).await,
            Err(e) => {
                println!("[WARN][SYNC] chunked_download_failed err={} fallback=legacy", e);
                self.download_snapshot_legacy(p2p, &peer_addrs[0], target_height).await?;
                self.verify_and_promote_staged(p2p, target_height).await
            }
        }
    }

    /// Verify a STAGED snapshot against its 2f+1 anchor and, on success, promote it into live state.
    /// On any failure drop staging and return Err so the caller falls to block replay. Pre-anchor
    /// (mb_idx==0) cold-join is handled by replay, never a snapshot.
    pub(super) async fn verify_and_promote_staged(
        &self,
        p2p: &crate::unified_p2p::SimplifiedP2P,
        height: u64,
    ) -> IntegrationResult<u64> {
        if height / 90 == 0 {
            let _ = self.discard_snapshot_state(height);
            return Err(IntegrationError::Other(format!(
                "snapshot_below_anchor h={} action=block_replay", height
            )));
        }
        match self.verify_snapshot_consensus_binding(p2p, height).await {
            Ok(anchor) => {
                // A failure here may have already replaced live accounts, so the marker and staging
                // MUST survive for boot recovery. Pre-destructive failures clean up inside promote.
                self.promote_snapshot_staging(height, anchor).await?;
                Ok(height)
            }
            Err(e) => {
                // Drop staging; snapshot path stays available for retry (no permanent latch).
                let _ = self.discard_snapshot_state(height);
                Err(e)
            }
        }
    }

    // Trustless-bootstrap binding. A byzantine peer can serve a self-
    // consistent forged snapshot (per-chunk hashes only prove "download
    // matches the peer's metadata", not chain-canonicity). Binding: the
    // snapshot-boundary macroblock embeds consensus_data.snapshot_root =
    // SHA3-256 of the canonical snapshot bytes (byte-stable across the
    // committee, finalised by a 2f+1 Checkpoint-BFT QC → forging needs 2f+1 keys).
    // Verifier: SHA3 the saved snapshot → fetch macroblock at height/90
    // (local then P2P) → compare → accept or ROLL BACK (delete
    // full_snap_/state_snap_ keys). Every fetch/binding failure returns Err
    // (no graceful-degradation accept) so the caller falls to byzantine-safe
    // block-by-block sync — costs 1 RTT, no attacker state contamination.
    // O(1)/bootstrap.
    /// Verifies a STAGED snapshot (in the *_stage CFs) against the 2f+1-bound macroblock lineage.
    /// Returns the anchor macroblock hash on success (caller promotes); on ANY failure drops the
    /// staging CFs and returns Err so live state is never touched and the caller falls to block-sync.
    pub(super) async fn verify_snapshot_consensus_binding(
        &self,
        p2p: &crate::unified_p2p::SimplifiedP2P,
        snapshot_height: u64,
    ) -> IntegrationResult<[u8; 32]> {
        // Genesis-window snapshots (mb_idx < 1) cannot be bound to a consensus-finalised macroblock —
        // nothing earlier to anchor against. The caller routes pre-anchor cold-join to block replay.
        let mb_idx = snapshot_height / 90;
        if mb_idx == 0 {
            return Ok([0u8; 32]);
        }

        // ── Genesis/pin-rooted inductive lineage walk (weak-subjectivity trust root) ───────────────
        // A snapshot peer controls the bytes it serves, so the anchor's 2f+1 QC must NOT be trusted
        // against a committee derived from peer-served data alone (that is circular — a byzantine server
        // forges a self-consistent anchor + predecessors + QC). Instead we re-verify the macroblock
        // lineage from an EXOGENOUS root up to the anchor: verify_v2_macroblock checks each macroblock's
        // QC against the committee sampled from its already-verified N-2 predecessor, and a macroblock
        // only stores after that verify passes (process_received_macroblock), so "contiguously present
        // in storage" ⟺ "inductively verified". Roots: fresh/young chain ⇒ genesis (the first two
        // macroblocks use the embedded genesis committee); mature chain ⇒ the binary WS pin (its
        // macroblock by hash + predecessor by the previous_hash chain, handled in verify_v2_macroblock).
        struct AnchorReset(u64);
        impl Drop for AnchorReset {
            fn drop(&mut self) {
                // Restore the prior runtime floor on ANY early return; only a fully-verified anchor
                // commits a new floor (adopt_snapshot_finality + mem::forget at the end). No provisional
                // floor is set during the walk (the old mb_idx-3 shortcut was the circularity hole).
                // CAP by the live chain_height: discard_snapshot_state zeroes chain_height on a full
                // state wipe (a snapshot rejected after a prior one was adopted), so a blind restore of
                // the higher prior anchor would strand the dedup floor above an empty chain (the cross-
                // attempt invariant break). A non-wiping early return leaves chain_height == prior, so the
                // prior anchor is restored unchanged.
                let chain_mb = crate::node::try_get_storage()
                    .and_then(|s| s.get_chain_height().ok())
                    .map(|h| h / 90)
                    .unwrap_or(self.0);
                crate::node::SNAPSHOT_ANCHOR_MB.store(self.0.min(chain_mb), std::sync::atomic::Ordering::SeqCst);
            }
        }
        let anchor_guard = AnchorReset(crate::node::SNAPSHOT_ANCHOR_MB.load(std::sync::atomic::Ordering::SeqCst));

        // Security floor = ws_floor ONLY (binary pin / adopted snapshot anchor): a snapshot below the
        // exogenous finality floor has no trusted root beneath it to re-verify from — reject. The GALC
        // capsule is a walk SHORTENER, never a floor: a capsule ABOVE the anchor can't root the forward
        // N-2 lineage walk DOWN to it, so it roots the walk ONLY when at-or-below the anchor; else ws_floor.
        let ws_floor = crate::node::effective_ws_checkpoint();
        if mb_idx < ws_floor.0 {
            let _ = self.discard_snapshot_state(snapshot_height);
            return Err(IntegrationError::Other(format!(
                "snapshot_below_ws mb={} ws={} action=reject_snapshot", mb_idx, ws_floor.0
            )));
        }
        // Root the walk at the genesis-signed GALC capsule when one is co-located at/below the
        // snapshot anchor (walk ≈ 0). The capsule arrives + Dilithium-verifies asynchronously, so a
        // binding that ran right after the cold-join orchestrator's best-effort request would race it
        // and fall back to ws_floor → a full genesis-to-anchor re-verify (the slow-rejoin bug).
        // Deterministically request + bounded-wait for a usable capsule before rooting; on timeout
        // fall through to ws_floor (correct, only slower — never worse, no new launch requirement).
        let usable = |k: u64| k > ws_floor.0 && k <= mb_idx;
        let mut pin = crate::galc::effective_pin_checkpoint();
        // Skip the wait on a young network: the first capsule only mints at mb == GALC_MINT_INTERVAL,
        // so a snapshot anchored below it can never have a usable capsule — waiting is pure dead-time.
        // Tip proxy = the anchor itself (mb_idx). Fall straight through to ws_floor (fail-open path
        // below is unchanged); behaves exactly as before once mb_idx>=GALC_MINT_INTERVAL.
        if !usable(pin.0) && mb_idx >= crate::galc::GALC_MINT_INTERVAL {
            const GALC_WAIT_ATTEMPTS: u32 = 20;        // ≤ ~10s total
            const GALC_WAIT_INTERVAL_MS: u64 = 500;
            for i in 0..GALC_WAIT_ATTEMPTS {
                // A capsule already adopted ABOVE the anchor (cadence put the freshest mint a step ahead
                // of the negotiated snapshot) can never become usable by waiting — adoption is monotonic-up
                // — so root at ws_floor now instead of burning the timeout; the next snapshot boundary
                // re-aligns capsule and anchor.
                if pin.0 > mb_idx { break; }
                if i % 4 == 0 {                        // re-request every ~2s (a reply may be lost)
                    let _ = p2p.broadcast_quic(&crate::unified_p2p::NetworkMessage::RequestGenesisCheckpoint {
                        requester_id: "snapshot_binder".to_string(),
                    }).await;
                }
                tokio::time::sleep(std::time::Duration::from_millis(GALC_WAIT_INTERVAL_MS)).await;
                pin = crate::galc::effective_pin_checkpoint();
                if usable(pin.0) { break; }
            }
            if crate::node::is_info() {
                println!("[INFO][SYNC] galc_anchor_wait mb={} pin={} rooted={}",
                         mb_idx, pin.0, if usable(pin.0) { "capsule" } else { "ws_floor" });
            }
        }
        let walk_root: (u64, [u8; 32]) =
            if usable(pin.0) { (pin.0, pin.1) } else { ws_floor };
        // Bound the walk so a stale root can't degrade into an unbounded genesis-to-tip re-verify
        // (DoS-on-self CPU + a wider trust window). The GALC capsule normally keeps the root within a few
        // macroblocks of the anchor (walk ≈ 0); this is the FALLBACK ceiling when no capsule is held, sized
        // to ~2 weeks so the binary-pin rotation cadence is realistic. Measured from the EFFECTIVE walk start
        // = max(walk_root, own contiguous-present frontier): the fill loop below slides past present ⟹
        // inductively-verified macroblocks, so the real fetch/verify work is mb_idx - frontier, not
        // mb_idx - walk_root. Trust still roots at walk_root (pin/ws_floor); the frontier is self-verified,
        // never peer-claimed, so crediting it adds no attack surface and keeps this budget consistent with
        // the selection ceiling (which also folds in frontier). INERT for a young chain (span small).
        const MAX_WS_WALK_MB: u64 = Storage::SNAPSHOT_MAX_WS_WALK_MB; // single-sourced with the selection ceiling
        let walk_span_root = walk_root.0.max(self.own_contiguous_frontier_mb());
        if mb_idx.saturating_sub(walk_span_root) > MAX_WS_WALK_MB {
            let _ = self.discard_snapshot_state(snapshot_height);
            return Err(IntegrationError::Other(format!(
                "snapshot_ws_walk_too_long mb={} start={} root={} max={} action=upgrade_binary_pin",
                mb_idx, walk_span_root, walk_root.0, MAX_WS_WALK_MB
            )));
        }
        // Where to begin filling: from genesis (1) on a fresh chain; just above the walk_root when its
        // macroblock is already present (a prior adoption — fill only the new gap); else from the pinned
        // pair (walk_root.0-1) so the root macroblock + its predecessor bootstrap forward verification.
        let walk_from = if walk_root.0 == 0 {
            1
        } else if walk_root.0 == mb_idx && walk_root.0 > ws_floor.0 {
            // Capsule/pin co-located AT the snapshot anchor (strictly above the WS floor — so anchor-1
            // is at/above the floor and re-verifiable, never below it). The forward committee derivation
            // for the
            // first two tail macroblocks (anchor+1, anchor+2) reads N-2 = {anchor-1, anchor}. The capsule
            // binds BOTH digests (pin.2 anchor, pin.3 predecessor) and verify_v2_macroblock trusts the
            // predecessor by the anchor's previous_hash chain (pin.0-1 branch), so descend to anchor-1 to
            // fetch+verify it EVEN IF the anchor macroblock is already stored. Without this the predecessor
            // is skipped (walk_root+1 ⇒ empty range) → anchor+1 hits v2_qc_no_committee, anchor+3 then
            // defers on the resulting hole → post-snapshot finality wedges 2 mb past the anchor on a mature
            // chain. The cursor skips already-present macroblocks, so this is a no-op extra storage read
            // when the predecessor is already held; it costs one fetch only in the wedge case.
            walk_root.0.saturating_sub(1).max(1)
        } else if self.get_macroblock_by_height(walk_root.0).ok().flatten().is_some() {
            walk_root.0.saturating_add(1)
        } else {
            walk_root.0.saturating_sub(1).max(1)
        };

        // Fill the contiguous lineage [walk_from ..= mb_idx] bottom-up. The cursor slides past
        // already-stored (⇒ verified) macroblocks; each attempt re-requests from the lowest-missing so
        // the repair window slides forward. Back off only when an attempt made NO progress.
        const MB_FETCH_MAX_ATTEMPTS: u32 = 1500; // server caps ~10 macroblocks/response ⇒ ≥ MAX_WS_WALK_MB/10 (+margin)
        const MB_FETCH_BASE_DELAY_MS: u64 = 1_000;
        // Wall-clock budget: a mature-chain walk with no usable GALC capsule can run ~30min and starve
        // block replay (same task). Cap it; on timeout the incomplete-lineage path below drops staging,
        // latches the boundary (no re-arm), and the caller falls through to block replay. Kept under
        // STALL_ABORT(120s); a young chain (capsule co-located) finishes in ~0 well before it.
        const WALK_BUDGET_SECS: u64 = 90;
        let walk_deadline = std::time::Instant::now() + std::time::Duration::from_secs(WALK_BUDGET_SECS);
        let mut lineage_from = walk_from;
        let mut attempt = 0u32;
        loop {
            while lineage_from <= mb_idx
                && self.get_macroblock_by_height(lineage_from).ok().flatten().is_some()
            {
                lineage_from = lineage_from.saturating_add(1);
            }
            if lineage_from > mb_idx { break; } // full contiguous lineage present ⇒ inductively verified
            attempt += 1;
            if attempt > MB_FETCH_MAX_ATTEMPTS { break; }
            if std::time::Instant::now() >= walk_deadline {
                if crate::node::is_warn() {
                    println!("[WARN][SYNC] verifier_walk_budget_exceeded reached={} mb={} action=block_replay",
                        lineage_from.saturating_sub(1), mb_idx);
                }
                break;
            }
            let before = lineage_from;
            if crate::node::is_info() {
                println!(
                    "[INFO][SYNC] verifier_lineage_walk from={} to={} attempt={}/{} for_snapshot_h={}",
                    lineage_from, mb_idx, attempt, MB_FETCH_MAX_ATTEMPTS, snapshot_height,
                );
            }
            if let Err(e) = p2p.sync_macroblocks_repair(lineage_from, mb_idx).await {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][SYNC] verifier_lineage_fetch_retry from={} to={} attempt={}/{} err={}",
                        lineage_from, mb_idx, attempt, MB_FETCH_MAX_ATTEMPTS, e,
                    );
                }
            }
            // Re-slide to measure progress before deciding to back off.
            while lineage_from <= mb_idx
                && self.get_macroblock_by_height(lineage_from).ok().flatten().is_some()
            {
                lineage_from = lineage_from.saturating_add(1);
            }
            if lineage_from == before {
                let backoff_ms = MB_FETCH_BASE_DELAY_MS.saturating_mul(1u64 << (attempt - 1).min(3));
                tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            }
        }

        let macroblock_bytes = match self.get_macroblock_by_height(mb_idx)
            .map_err(|e| IntegrationError::Other(format!("mb_reload_err mb={} err={:?}", mb_idx, e)))?
        {
            Some(b) if lineage_from > mb_idx => b, // anchor present AND lineage [walk_from..=mb_idx] contiguous
            _ => {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][SYNC] verifier_lineage_incomplete mb={} reached={} attempts={} action=reject_snapshot",
                        mb_idx, lineage_from.saturating_sub(1), MB_FETCH_MAX_ATTEMPTS,
                    );
                }
                let _ = self.discard_snapshot_state(snapshot_height);
                return Err(IntegrationError::Other(format!(
                    "snapshot_binding_unavailable mb={} reason=lineage_incomplete reached={}",
                    mb_idx, lineage_from.saturating_sub(1)
                )));
            }
        };

        let macroblock: qnet_state::MacroBlock = match bincode::deserialize(&macroblock_bytes) {
            Ok(mb) => mb,
            Err(e) => {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][SYNC] verifier_macroblock_decode_failed mb={} err={} action=reject_snapshot",
                        mb_idx, e,
                    );
                }
                let _ = self.discard_snapshot_state(snapshot_height);
                return Err(IntegrationError::Other(format!(
                    "snapshot_binding_unavailable mb={} reason=mb_decode_failed err={}",
                    mb_idx, e
                )));
            }
        };

        // Anchor-QC gate (P2/P1): trust the macroblock's state_root ONLY after its own 2f+1
        // checkpoint QC verifies against the committee anchored to the embedded genesis keys.
        // Without this a Byzantine peer forges a self-consistent (macroblock, snapshot) pair the
        // merkle recompute below would accept (a None-QC macroblock passes verify_v2_macroblock's
        // early return). On ANY failure, discard the applied state → fall back to verified block-sync.
        if let Err(e) = crate::node::verify_snapshot_anchor_qc(&macroblock, mb_idx, self).await {
            if crate::node::is_warn() {
                println!(
                    "[WARN][SYNC] verifier_anchor_qc_failed mb={} snapshot_h={} err={} action=reject_snapshot",
                    mb_idx, snapshot_height, e,
                );
            }
            let _ = self.discard_snapshot_state(snapshot_height);
            return Err(IntegrationError::Other(format!(
                "snapshot_binding_unverified mb={} reason=anchor_qc_invalid err={}", mb_idx, e
            )));
        }

        // Step 2: the 2f+1-bound account-state root. The macroblock's top-level
        // state_root IS checkpoint.state_root (finalize_merkle), certified by the
        // checkpoint QC — the trustless anchor. (consensus_data.snapshot_root is unused.)
        let expected_root = macroblock.state_root;
        if expected_root == [0u8; 32] {
            if crate::node::is_warn() {
                println!(
                    "[WARN][SYNC] verifier_no_binding mb={} snapshot_h={} action=reject_snapshot",
                    mb_idx, snapshot_height,
                );
            }
            let _ = self.discard_snapshot_state(snapshot_height);
            return Err(IntegrationError::Other(format!(
                "snapshot_binding_missing mb={} reason=zero_state_root", mb_idx
            )));
        }

        // Pattern C: snapshot bytes are staged in accounts_stage. Recompute the SAME account merkle the
        // consensus committed (finalize_merkle) from the STAGED accounts and compare to the QC-bound
        // mb.state_root; a forged snapshot yields a different root.
        let computed = self.recompute_account_merkle_root_cf("accounts_stage")
            .map_err(|e| IntegrationError::Other(format!("merkle_recompute_err h={} err={:?}", snapshot_height, e)))?;

        if computed != expected_root {
            // Real rollback: a peer served state that doesn't match the 2f+1-bound root.
            // Wipe it entirely (not just the key) so it can't pollute the fallback block-sync.
            self.discard_snapshot_state(snapshot_height)?;
            return Err(IntegrationError::Other(format!(
                "snapshot_root_mismatch h={} mb={} expected={} computed={}",
                snapshot_height, mb_idx,
                hex::encode(&expected_root[..8]),
                hex::encode(&computed[..8]),
            )));
        }

        // #8 registry binding: the account-merkle check above covers ONLY the accounts CF, NOT the
        // node_registry CF — from which cbw AND the attestor VRF keys are derived. Without this an
        // untrusted snapshot server could serve correct accounts but a FORGED node_registry (rebinding
        // a burn to its own wallet, or swapping a VRF key) → the joiner accepts reused-burn blocks
        // honest nodes reject, or verifies attestations against forged keys. Recompute the deterministic
        // registry digest from the restored registry and compare to the anchor checkpoint's QC-certified
        // registry_root (bounded by the checkpoint's window head). Gated: until the rule activates the
        // root is computed+committed but not enforced here (staging window to prove live agreement).
        if qnet_state::feature_gates::is_active("registry_root_required", snapshot_height) {
            let cp_opt = macroblock.consensus_data.checkpoint_qc.as_ref().and_then(|b| {
                bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint, qnet_consensus::checkpoint_bft::QuorumCertificate)>(b).ok()
            }).map(|(cp, _)| cp);
            match cp_opt {
                Some(cp) => {
                    let computed_rr = match self.compute_registry_root_staged("node_registry_stage", cp.window_head_height) {
                        Some(r) => r,
                        // Unreadable staged registry: treat as a failed verify, not as a pass.
                        None => {
                            self.discard_snapshot_state(snapshot_height)?;
                            return Err(IntegrationError::Other(format!(
                                "snapshot_registry_root_unreadable h={} mb={}", snapshot_height, mb_idx)));
                        }
                    };
                    if computed_rr != cp.registry_root {
                        self.discard_snapshot_state(snapshot_height)?;
                        return Err(IntegrationError::Other(format!(
                            "snapshot_registry_root_mismatch h={} mb={} committed={} computed={}",
                            snapshot_height, mb_idx,
                            hex::encode(&cp.registry_root[..8]), hex::encode(&computed_rr[..8]),
                        )));
                    }
                    // FIX-5: same anti-forge boundary for the per-account ML-DSA-65 pk set. The account
                    // merkle (state_root) does NOT cover pk (excluded from hash_account by design), so an
                    // untrusted snapshot server could serve correct balances but omit/alter an account's
                    // pk → a joiner would stall that account's ELIDED TXs forever (unresolvable signer)
                    // or admit a rebound key. Recompute dilithium_pk_root over the STAGED accounts and
                    // compare to the QC-certified cp.dilithium_pk_root. Same gate as registry_root.
                    let computed_dpk = match self.compute_dilithium_pk_root_staged() {
                        Some(r) => r,
                        // Unreadable staged accounts: a failed verify, never a pass.
                        None => {
                            self.discard_snapshot_state(snapshot_height)?;
                            return Err(IntegrationError::Other(format!(
                                "snapshot_dilithium_pk_root_unreadable h={} mb={}", snapshot_height, mb_idx)));
                        }
                    };
                    if computed_dpk != cp.dilithium_pk_root {
                        self.discard_snapshot_state(snapshot_height)?;
                        return Err(IntegrationError::Other(format!(
                            "snapshot_dilithium_pk_root_mismatch h={} mb={} committed={} computed={}",
                            snapshot_height, mb_idx,
                            hex::encode(&cp.dilithium_pk_root[..8]), hex::encode(&computed_dpk[..8]),
                        )));
                    }
                }
                None => {
                    self.discard_snapshot_state(snapshot_height)?;
                    return Err(IntegrationError::Other(format!(
                        "snapshot_registry_root_unavailable mb={} reason=no_checkpoint_qc", mb_idx
                    )));
                }
            }
        }

        // No vrf_pk completeness gate: registry authenticity is bound by registry_root above; vrf_pk is in
        // no consensus root and self-heals via on-chain apply + VrfKeyAnnounce gossip. A super missing its
        // key is excluded only from QC verification (n−f quorum unaffected), never from the committee
        // sample — so a missing key must NOT reject otherwise-authentic state (would brick every joiner).

        // Staging verified (2f+1 QC + Pattern-C state + registry binding). Return the anchor hash;
        // promote commits the floors and copies staging→live atomically.
        std::mem::forget(anchor_guard);
        if crate::node::is_info() {
            println!(
                "[INFO][SYNC] verifier_pass mb={} snapshot_h={} root={} pattern=C",
                mb_idx, snapshot_height, hex::encode(&computed[..8]),
            );
        }
        Ok(macroblock.hash())
    }

    /// Wipe every key of a CF (cold-start rollback helper).
    pub(super) fn clear_cf(&self, cf_name: &str) -> IntegrationResult<()> {
        if let Some(cf) = self.persistent.db.cf_handle(cf_name) {
            let mut batch = WriteBatch::default();
            for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start) {
                let (k, _) = item?;
                batch.delete_cf(&cf, k);
            }
            self.persistent.db.write(batch)?;
        }
        Ok(())
    }

    /// Rebuild the per-key contract_storage CF from the (verified) accounts CF. contract_storage
    /// mirrors Account.contract_storage, which is bound by state_root, so deriving it here binds it
    /// transitively — the untrusted staged contract_storage is never promoted.
    pub(super) fn rebuild_contract_storage_from_accounts(&self) -> IntegrationResult<()> {
        let accounts_cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut n = 0u64;
        for item in self.persistent.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start) {
            let (_k, v) = item?;
            let acct: qnet_state::Account = match bincode::deserialize(&v) { Ok(a) => a, Err(_) => continue };
            if acct.is_contract && !acct.contract_storage.is_empty() {
                self.persistent.save_contract_storage(&acct.address, &acct.contract_storage)?;
                n += 1;
            }
        }
        if n > 0 && crate::node::is_info() {
            println!("[INFO][SNAPSHOT] contract_storage_rebuilt contracts={}", n);
        }
        Ok(())
    }

    /// Drop a rejected staged snapshot: truncate the *_stage CFs + the staged blob ONLY. Live state,
    /// chain_height and the finality floors are NEVER touched, so a reject degrades cleanly to block
    /// replay from the current committed height (no orphaned state, no wipe of replay progress).
    pub(super) fn discard_snapshot_state(&self, height: u64) -> IntegrationResult<()> {
        for cf in &["accounts_stage", "node_registry_stage", "pending_rewards_stage", "contract_storage_stage"] {
            let _ = self.clear_cf(cf);
        }
        if let Some(snapshots_cf) = self.persistent.db.cf_handle("snapshots") {
            for prefix in &["full_snap_", "state_snap_"] {
                let _ = self.persistent.db.delete_cf(&snapshots_cf, format!("{}{}", prefix, height).as_bytes());
            }
        }
        println!("[WARN][SYNC] snapshot_staging_dropped h={} action=degrade_to_replay", height);
        Ok(())
    }

    /// Promote a VERIFIED staged snapshot into live state, crash-atomically. Marker
    /// `promote_pending = [height(8)|anchor(32)]` is written first and cleared only after the copy +
    /// floor commit complete; a crash mid-copy re-runs idempotently from the intact staging on boot
    /// (recover_pending_snapshot_promote). The ONLY place a snapshot mutates live state.
    pub async fn promote_snapshot_staging(&self, height: u64, anchor_hash: [u8; 32]) -> IntegrationResult<()> {
        let meta = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;
        // A retried promote (boot recovery) must not overwrite live state on a node that has since
        // replayed past the snapshot height — set_chain_height below is not forward-only.
        let live_h = self.get_chain_height().map_err(|e| IntegrationError::StorageError(
            format!("promote_height_read_failed h={} err={:?}", height, e)))?;
        if live_h > height {
            let _ = self.persistent.db.delete_cf(&meta, b"promote_pending");
            let _ = self.discard_snapshot_state(height);
            return Err(IntegrationError::StorageError(format!(
                "promote_refused_regress snapshot_h={} live_h={}", height, live_h)));
        }
        let mut marker = height.to_le_bytes().to_vec();
        marker.extend_from_slice(&anchor_hash);
        self.persistent.db.put_cf(&meta, b"promote_pending", &marker)?;

        // Epoch reward roots: PROVE before anything destructive runs. Their macroblocks sit below
        // this node's weak-subjectivity floor and can never be re-fetched, so they must be carried —
        // but a forged set must fail while live state is still intact and the retry can start clean.
        if let Err(e) = self.carry_and_verify_epoch_roots(height) {
            // Nothing destructive has run yet, so drop the retry token and let the snapshot path
            // start clean. Every failure AFTER this point keeps the marker on purpose.
            let _ = self.persistent.db.delete_cf(&meta, b"promote_pending");
            let _ = self.discard_snapshot_state(height);
            return Err(e);
        }

        // Swap staging→live for the CONSENSUS-BOUND CFs only: accounts (state_root) + node_registry
        // (registry_root). The binder verified exactly these against the 2f+1 anchor.
        for (stage, live) in [("accounts_stage", "accounts"), ("node_registry_stage", "node_registry")] {
            self.clear_cf(live)?;
            let (s, l) = match (self.persistent.db.cf_handle(stage), self.persistent.db.cf_handle(live)) {
                (Some(s), Some(l)) => (s, l),
                _ => continue,
            };
            let mut batch = WriteBatch::default();
            let mut n = 0u64;
            let mut dropped = 0u64;
            for item in self.persistent.db.iterator_cf(&s, rocksdb::IteratorMode::Start) {
                let (k, v) = item?;
                // WHITELIST. registry_root folds only srtr_/lrtr_ -> node_<id>, so every OTHER prefix in
                // this section is unbound peer data. `vrf_pk_` is the worst: it is the key verify_qc and
                // vote_sig_compact_ok resolve against, and the immutable-once-stamped rule makes a
                // poisoned row permanent.
                //
                // vrf_pk_ is admitted only when it matches the COVERED commitment node_<id>.vrf_pk_sha3
                // — the hash cannot yield the key, so the key must be carried, but it can be bound.
                // Everything else is dropped and re-derived locally after promote.
                if live == "node_registry" && !Self::registry_key_is_root_covered(&k) {
                    let bound = k.strip_prefix(b"vrf_pk_".as_ref())
                        .and_then(|id| std::str::from_utf8(id).ok())
                        .map(|id| Self::staged_vrf_pk_matches_commitment(&self.persistent.db, &s, id, &v))
                        .unwrap_or(false);
                    if !bound { dropped += 1; continue; }
                }
                batch.put_cf(&l, &k, &v);
                n += 1;
                if n % 10_000 == 0 { self.persistent.db.write(std::mem::take(&mut batch))?; }
            }
            self.persistent.db.write(batch)?;
            if dropped > 0 {
                println!("[WARN][SNAPSHOT] registry_rows_dropped={} reason=not_covered_by_registry_root", dropped);
            }
        }
        self.clear_cf("contract_storage")?;
        self.rebuild_contract_storage_from_accounts()?;
        // Derived indices over the now-live registry (byte-identical to a from-genesis node at this
        // height). Propagate errors BEFORE committing height/floors/marker-delete: a failed rebuild must
        // NOT finalize the anchor with a stale cbw/registry_lthash (silent fork). On Err the marker +
        // staging survive, so recover_pending_snapshot_promote retries on next boot.
        self.backfill_roster_indices()?;
        self.rebuild_committed_burn_wallet(height)?;
        self.rebuild_registry_lthash(height)?;
        // FIX-5: dilithium_pk_root LtHash from the promoted live accounts — same fail-closed discipline
        // as cbw/registry (Err leaves staging + marker so the promote retries, never finalizes stale).
        self.rebuild_dilithium_pk_lthash()?;
        // Prove the carried epoch roots against the anchor's 2f+1-certified commitment. Fail-closed
        // like the rebuilds above: on mismatch the marker + staging survive and the promote retries,
        // so a snapshot server cannot hand this node roots the committee never signed.
        // Rich-list index is display-only and NOT snapshot-verified: clear any promoted/inherited rows
        // + the build marker so the joiner never serves a peer-supplied (possibly forged) rich list.
        // The boot rebuild then re-derives it locally from the verified accounts.
        let _ = self.richlist_clear();
        // Wallet→token reverse index (NON-consensus): rebuild from the freshly promoted accounts so a
        // cold-joined node serves per-wallet token lists in O(held). Best-effort — a failure must never
        // wedge the consensus-critical promote. Mark dirty FIRST (drops OWNS_INDEX_READY + clears the
        // build marker) so that if the rebuild Errs — or we crash mid-rebuild — the emptied CF is NEVER
        // left authoritative: the reader falls back to the O(N) scan and the NEXT boot re-runs the
        // backfill. backfill_owns_indices re-asserts READY on success; the marker is set ONLY then.
        self.mark_owns_index_dirty();
        let _ = self.clear_cf("wallet_token");
        if self.backfill_owns_indices().is_ok() { let _ = self.set_owns_index_built(height); }
        // Commit height + finality/WS floors + durable anchor (adopt_snapshot_finality persists it).
        self.set_chain_height(height)?;
        crate::node::adopt_snapshot_finality(height, anchor_hash);
        // Advertise the verified blob so this node can serve the snapshot it joined from.
        if let Some(snaps) = self.persistent.db.cf_handle("snapshots") {
            let _ = self.persistent.db.put_cf(&snaps, b"latest_full_snap", &height.to_le_bytes());
        }
        self.persistent.db.delete_cf(&meta, b"promote_pending")?;
        // Clear staging CFs ONLY (keep the blob for serving).
        for cf in &["accounts_stage", "node_registry_stage", "pending_rewards_stage", "contract_storage_stage"] {
            let _ = self.clear_cf(cf);
        }
        println!("[INFO][SYNC] snapshot_promoted h={} anchor_mb={}", height, height / 90);
        Ok(())
    }

    /// Boot recovery: if a promote was interrupted, the marker is still present and staging is intact —
    /// re-run the promote idempotently. On failure clear staging + marker and fall to block replay.
    /// `state`: when present (main boot path) the in-mem StateManager is rehydrated from the promoted
    /// CFs after a successful promote — same fail-closed semantics as the live cold-join. The boot
    /// TIER-1 restore runs BEFORE this recovery (no promoted state yet), so it would NOT rehydrate the
    /// recovered snapshot; doing it here closes that gap.
    pub async fn recover_pending_snapshot_promote(
        &self,
        state: Option<&std::sync::Arc<tokio::sync::RwLock<crate::StateManager>>>,
    ) {
        let meta = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return };
        let bytes = match self.persistent.db.get_cf(&meta, b"promote_pending") {
            Ok(Some(b)) if b.len() == 40 => b,
            _ => return,
        };
        let height = u64::from_le_bytes(bytes[..8].try_into().unwrap_or([0u8; 8]));
        let mut anchor = [0u8; 32];
        anchor.copy_from_slice(&bytes[8..40]);
        println!("[WARN][SYNC] promote_recovery h={} replay=staged", height);
        if let Err(e) = self.promote_snapshot_staging(height, anchor).await {
            // Keep the marker AND staging: this failure may have landed after live accounts were
            // already replaced, and they are the only state that can finish the job. A
            // pre-destructive failure has already cleared both inside promote, so nothing latches
            // that should not.
            println!("[ERR][SYNC] promote_recovery_failed h={} err={} action=retry_next_boot", height, e);
            return;
        }
        // Rehydrate the in-mem state from the recovered CFs (fail-closed). On mismatch the helper
        // clears the in-mem state; block replay from the promoted chain_height then rebuilds it.
        if let Some(state) = state {
            if let Err(e) = self.rehydrate_inmem_state_from_promoted_cf(state, height).await {
                println!("[WARN][SYNC] promote_recovery_rehydrate_failed h={} err={} action=block_replay", height, e);
            }
        }
    }

    /// Query peer for available snapshots
    pub(super) async fn query_peer_snapshot(&self, peer_addr: &str, max_height: u64) -> IntegrationResult<Option<(u64, String)>> {
        // Ask for the highest snapshot ≤ our exogenously-verifiable ceiling (not just the peer's latest,
        // which may be above our pin and therefore unverifiable cold).
        let url = format!("http://{}/api/v1/snapshot/latest?max_height={}", peer_addr, max_height);
        
        match reqwest::get(&url).await {
            Ok(response) => {
                if response.status().is_success() {
                    let data: serde_json::Value = response.json().await
                        .map_err(|e| IntegrationError::Other(format!("JSON error: {}", e)))?;
                    
                    if let (Some(height), Some(cid)) = (
                        data["height"].as_u64(),
                        data["ipfs_cid"].as_str()
                    ) {
                        // A peer with no snapshot answers height=0/available:false — it is NOT a target.
                        // Treating it as Some((0,…)) let the quorum picker resolve target=0 → a phantom
                        // h=0 download. Exclude it from negotiation entirely.
                        if height == 0 { return Ok(None); }
                        return Ok(Some((height, cid.to_string())));
                    }
                }
            },
            Err(e) => println!("[WARN][STORAGE] snapshot_peer_query_failed peer={} err={}", peer_addr, e),
        }
        
        Ok(None)
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v5.0: CHUNKED SNAP SYNC — parallel download from multiple peers
    // Snapshot is split into 4MB chunks, each verified independently.
    // ═══════════════════════════════════════════════════════════════════════════

    pub(super) const SNAPSHOT_CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4MB per chunk
    // v32.10: hard bounds on untrusted manifest fields. Prevents OOM DoS via
    // forged total_size / chunk_count from byzantine peer.
    pub(super) const MAX_SNAPSHOT_SIZE: u64 = 100 * 1024 * 1024 * 1024; // 100 GB
    pub(super) const MAX_CHUNK_COUNT: u64 = 100_000; // 100k × 4MB = 400GB max

    /// v32.10: deterministic SHA3-256 over canonical manifest bytes.
    /// Used by producer to commit into MacroBlock.snapshot_manifest_hash, and
    /// by joiner to verify fetched manifest matches the 2f+1-bound value.
    pub fn compute_manifest_hash(manifest: &SnapshotManifest) -> [u8; 32] {
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(b"QNET_SNAPSHOT_MANIFEST_V1:");
        hasher.update(&manifest.height.to_le_bytes());
        hasher.update(&manifest.total_size.to_le_bytes());
        hasher.update(&manifest.chunk_size.to_le_bytes());
        hasher.update(&manifest.chunk_count.to_le_bytes());
        hasher.update(&(manifest.chunk_hashes.len() as u64).to_le_bytes());
        for h in &manifest.chunk_hashes {
            hasher.update(&(h.len() as u32).to_le_bytes());
            hasher.update(h.as_bytes());
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&hasher.finalize());
        out
    }

    /// Get snapshot manifest (chunk count + per-chunk SHA3 hashes)
    /// Used by peers to request individual chunks for parallel download
    pub fn get_snapshot_manifest(&self, height: u64) -> IntegrationResult<Option<SnapshotManifest>> {
        let data = match self.get_snapshot_data(height)? {
            Some(d) => d,
            None => return Ok(None),
        };
        let total_size = data.len();
        let chunk_count = (total_size + Self::SNAPSHOT_CHUNK_SIZE - 1) / Self::SNAPSHOT_CHUNK_SIZE;
        let mut chunk_hashes = Vec::with_capacity(chunk_count);
        for i in 0..chunk_count {
            let start = i * Self::SNAPSHOT_CHUNK_SIZE;
            let end = std::cmp::min(start + Self::SNAPSHOT_CHUNK_SIZE, total_size);
            let hash = sha3::Sha3_256::digest(&data[start..end]);
            chunk_hashes.push(hex::encode(hash));
        }
        Ok(Some(SnapshotManifest {
            height,
            total_size: total_size as u64,
            chunk_size: Self::SNAPSHOT_CHUNK_SIZE as u64,
            chunk_count: chunk_count as u64,
            chunk_hashes,
        }))
    }

    /// Get a specific chunk of the snapshot (0-indexed)
    pub fn get_snapshot_chunk(&self, height: u64, chunk_index: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let data = match self.get_snapshot_data(height)? {
            Some(d) => d,
            None => return Ok(None),
        };
        let start = (chunk_index as usize) * Self::SNAPSHOT_CHUNK_SIZE;
        if start >= data.len() {
            return Ok(None);
        }
        let end = std::cmp::min(start + Self::SNAPSHOT_CHUNK_SIZE, data.len());
        Ok(Some(data[start..end].to_vec()))
    }

    /// Download snapshot using chunked parallel protocol from multiple peers
    /// Falls back to legacy single-request download if chunked protocol unavailable
    pub async fn download_snapshot_chunked(
        &self,
        p2p: &crate::unified_p2p::SimplifiedP2P,
        peer_addrs: &[String],
        height: u64,
    ) -> IntegrationResult<()> {
        if peer_addrs.is_empty() {
            return Err(IntegrationError::Other("No peers for chunked download".to_string()));
        }
        let start_time = std::time::Instant::now();

        // The manifest is NOT consensus-bound and cannot be: whether a node holds a snapshot at a
        // boundary is node-local, so committing its digest would split the macroblock body. The binder
        // is Pattern C — the staged accounts merkle recomputed against the QC-certified mb.state_root,
        // plus the registry-CF check — which runs after assembly. Everything read from the manifest
        // before that point is therefore treated as hostile and bounds-checked below.

        // Step 1: Fetch manifest from first responsive peer
        let mut manifest: Option<SnapshotManifest> = None;
        for addr in peer_addrs {
            let url = format!("http://{}/api/v1/snapshot/{}/manifest", addr, height);
            match reqwest::Client::new().get(&url).timeout(std::time::Duration::from_secs(10)).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(m) = resp.json::<SnapshotManifest>().await {
                        manifest = Some(m);
                        break;
                    }
                }
                _ => continue,
            }
        }

        let manifest = match manifest {
            Some(m) => m,
            None => {
                // Fallback: legacy single-request download from first peer
                if crate::node::is_info() {
                    println!("[INFO][SYNC] chunked_manifest_unavailable fallback=legacy");
                }
                return self.download_snapshot_legacy(p2p, &peer_addrs[0], height).await;
            }
        };

        // v32.10: untrusted-input bounds. Reject before allocation.
        if manifest.total_size > Self::MAX_SNAPSHOT_SIZE {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] manifest_rejected reason=total_size_overflow h={} got={} max={}",
                         height, manifest.total_size, Self::MAX_SNAPSHOT_SIZE);
            }
            return Err(IntegrationError::Other(format!(
                "manifest_total_size_exceeds_max h={} got={} max={}",
                height, manifest.total_size, Self::MAX_SNAPSHOT_SIZE
            )));
        }
        if manifest.chunk_count == 0 || manifest.chunk_count > Self::MAX_CHUNK_COUNT {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] manifest_rejected reason=chunk_count_invalid h={} got={} max={}",
                         height, manifest.chunk_count, Self::MAX_CHUNK_COUNT);
            }
            return Err(IntegrationError::Other(format!(
                "manifest_chunk_count_invalid h={} got={}", height, manifest.chunk_count
            )));
        }
        if manifest.chunk_size != Self::SNAPSHOT_CHUNK_SIZE as u64 {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] manifest_rejected reason=chunk_size_mismatch h={} got={} expected={}",
                         height, manifest.chunk_size, Self::SNAPSHOT_CHUNK_SIZE);
            }
            return Err(IntegrationError::Other(format!(
                "manifest_chunk_size_mismatch h={} got={} expected={}",
                height, manifest.chunk_size, Self::SNAPSHOT_CHUNK_SIZE
            )));
        }
        // Shape, not just count: these strings are peer-supplied and are byte-sliced when a chunk
        // mismatches, so a short one would panic the process (`panic = "abort"`).
        if let Some(bad) = manifest.chunk_hashes.iter()
            .position(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit())) {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] manifest_rejected reason=chunk_hash_malformed h={} idx={}", height, bad);
            }
            return Err(IntegrationError::Other(format!(
                "manifest_chunk_hash_malformed h={} idx={}", height, bad
            )));
        }
        if manifest.chunk_hashes.len() as u64 != manifest.chunk_count {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] manifest_rejected reason=hashes_len_mismatch h={} hashes={} count={}",
                         height, manifest.chunk_hashes.len(), manifest.chunk_count);
            }
            return Err(IntegrationError::Other(format!(
                "manifest_hashes_count_mismatch h={} hashes={} count={}",
                height, manifest.chunk_hashes.len(), manifest.chunk_count
            )));
        }
        // Consistency: total_size must fit exactly in chunk_count × chunk_size.
        let expected_chunks = (manifest.total_size + manifest.chunk_size - 1) / manifest.chunk_size;
        if expected_chunks != manifest.chunk_count {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] manifest_rejected reason=size_count_inconsistent h={} expected_chunks={} got={}",
                         height, expected_chunks, manifest.chunk_count);
            }
            return Err(IntegrationError::Other(format!(
                "manifest_size_count_inconsistent h={} expected_chunks={} got={}",
                height, expected_chunks, manifest.chunk_count
            )));
        }

        println!("[INFO][SYNC] chunked_download_start h={} chunks={} total={}MB",
                 height, manifest.chunk_count, manifest.total_size / (1024 * 1024));

        // Step 2: Download chunks in parallel (round-robin across peers)
        let chunk_count = manifest.chunk_count as usize;
        // Fallible: total_size is peer-supplied and the infallible `vec![0u8; n]` aborts the process on
        // an allocation the host cannot satisfy. On refusal fall through to block replay.
        let mut assembled: Vec<u8> = Vec::new();
        assembled.try_reserve_exact(manifest.total_size as usize).map_err(|_| {
            IntegrationError::Other(format!(
                "manifest_alloc_refused h={} total_size={}", height, manifest.total_size))
        })?;
        assembled.resize(manifest.total_size as usize, 0u8);
        let chunk_size = manifest.chunk_size as usize;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| IntegrationError::Other(format!("HTTP client error: {}", e)))?;

        // Download up to 4 chunks concurrently
        let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
        let chunks_result: Vec<(usize, IntegrationResult<Vec<u8>>)> = {
            let mut handles = Vec::with_capacity(chunk_count);
            for i in 0..chunk_count {
                let peer = peer_addrs[i % peer_addrs.len()].clone();
                let client = client.clone();
                let expected_hash = manifest.chunk_hashes[i].clone();
                let sem = semaphore.clone();
                handles.push(tokio::spawn(async move {
                    let _permit = match sem.acquire().await {
                        Ok(p) => p,
                        Err(_) => return Err(IntegrationError::Other("Snapshot semaphore closed".into())),
                    };
                    let url = format!("http://{}/api/v1/snapshot/{}/chunk/{}", peer, height, i);
                    let resp = client.get(&url).send().await
                        .map_err(|e| IntegrationError::Other(format!("Chunk {} download: {}", i, e)))?;
                    if !resp.status().is_success() {
                        return Err(IntegrationError::Other(format!("Chunk {} HTTP {}", i, resp.status())));
                    }
                    let bytes = resp.bytes().await
                        .map_err(|e| IntegrationError::Other(format!("Chunk {} read: {}", i, e)))?;
                    let actual_hash = hex::encode(sha3::Sha3_256::digest(&bytes));
                    if actual_hash != expected_hash {
                        return Err(IntegrationError::Other(
                            format!("Chunk {} hash mismatch expected={} got={}", i, &expected_hash[..16], &actual_hash[..16])
                        ));
                    }
                    Ok(bytes.to_vec())
                }));
            }
            let mut results = Vec::with_capacity(chunk_count);
            for (i, h) in handles.into_iter().enumerate() {
                let r = h.await.map_err(|e| IntegrationError::Other(format!("Chunk {} join: {}", i, e)))?;
                results.push((i, r));
            }
            results
        };

        // Step 3: Assemble chunks into full snapshot
        for (i, result) in chunks_result {
            let chunk_data = result?;
            let start = i * chunk_size;
            // The manifest fixes every chunk's length. A peer-supplied blob of any other size slices
            // out of bounds or mismatches copy_from_slice, and `panic = abort` turns that into a
            // remote node kill — so reject it as data instead of trusting the length.
            let expected_len = assembled.len().saturating_sub(start).min(chunk_size);
            if start >= assembled.len() || chunk_data.len() != expected_len {
                return Err(IntegrationError::Other(format!(
                    "snapshot_chunk_bad_len h={} idx={} got={} want={}",
                    height, i, chunk_data.len(), expected_len
                )));
            }
            assembled[start..start + expected_len].copy_from_slice(&chunk_data);
        }

        // Step 4: Save assembled snapshot to DB
        {
            let snapshots_cf = self.persistent.db.cf_handle("snapshots")
                .ok_or_else(|| IntegrationError::StorageError("snapshots CF not found".to_string()))?;
            let key = format!("full_snap_{}", height);
            self.persistent.db.put_cf(&snapshots_cf, key.as_bytes(), &assembled)?;
        }

        self.load_state_snapshot(height, true).await?;

        let elapsed = start_time.elapsed();
        println!("[INFO][SYNC] chunked_download_done h={} chunks={} total={}MB elapsed={:.1}s",
                 height, chunk_count, manifest.total_size / (1024 * 1024), elapsed.as_secs_f64());
        Ok(())
    }

    /// Legacy single-request snapshot download (backward compatibility)
    pub(super) async fn download_snapshot_legacy(
        &self,
        _p2p: &crate::unified_p2p::SimplifiedP2P,
        peer_addr: &str,
        height: u64,
    ) -> IntegrationResult<()> {
        // v32.10: legacy path serves single blob (no manifest). Total_size DoS
        // not applicable — reqwest body has its own decode limits. Pattern C
        // verification at caller catches forged state regardless.
        let url = format!("http://{}/api/v1/snapshot/{}", peer_addr, height);
        let response = reqwest::get(&url).await
            .map_err(|e| IntegrationError::Other(format!("Download error: {}", e)))?;
        if !response.status().is_success() {
            return Err(IntegrationError::Other("Snapshot download failed".to_string()));
        }
        let data = response.bytes().await
            .map_err(|e| IntegrationError::Other(format!("Download error: {}", e)))?;
        // Defense: a peer with no snapshot may answer 200 with a JSON error body. The real frame is
        // [sha3(32)|len(8)|zstd]; reject anything shorter than the 41-byte header or that looks like
        // JSON, so an error body is never stored as full_snap_ and then fails the integrity check.
        if data.len() < 41 || data.first() == Some(&b'{') {
            return Err(IntegrationError::Other(format!(
                "legacy_snapshot_not_binary h={} len={}", height, data.len()
            )));
        }
        // Defense: cap legacy blob size at MAX_SNAPSHOT_SIZE.
        if data.len() as u64 > Self::MAX_SNAPSHOT_SIZE {
            return Err(IntegrationError::Other(format!(
                "legacy_snapshot_oversize h={} got={} max={}",
                height, data.len(), Self::MAX_SNAPSHOT_SIZE
            )));
        }
        {
            let snapshots_cf = self.persistent.db.cf_handle("snapshots")
                .ok_or_else(|| IntegrationError::StorageError("snapshots CF not found".to_string()))?;
            let key = format!("full_snap_{}", height);
            self.persistent.db.put_cf(&snapshots_cf, key.as_bytes(), &data)?;
        }
        self.load_state_snapshot(height, true).await?;
        if crate::node::is_info() {
            println!("[INFO][SYNC] legacy_snapshot_applied h={}", height);
        }
        Ok(())
    }

    /// Download snapshot — tries chunked first, falls back to legacy
    #[allow(dead_code)]
    pub(super) async fn download_snapshot_from_peer(
        &self,
        p2p: &crate::unified_p2p::SimplifiedP2P,
        peer_addr: &str,
        height: u64,
    ) -> IntegrationResult<()> {
        self.download_snapshot_chunked(p2p, &[peer_addr.to_string()], height).await
    }

    /// Fast sync with snapshot for new nodes
    pub async fn fast_sync_with_snapshot(
        &self,
        p2p: &crate::unified_p2p::SimplifiedP2P,
        target_height: u64,
        state: &std::sync::Arc<tokio::sync::RwLock<crate::StateManager>>,
    ) -> IntegrationResult<()> {
        println!("[INFO][STORAGE] fast_sync_start target_height={}", target_height);

        // Light nodes do not perform fast-sync at all — they are pure
        // mobile API clients with zero on-device chain storage. All
        // chain reads happen via the Super-node REST API at request
        // time, so there is nothing to download here.
        if self.storage_mode == StorageMode::Light {
            println!("[INFO][STORAGE] fast_sync_skipped role=light_api_client");
            return Ok(());
        }

        // Try to find and load a snapshot
        match self.download_and_load_snapshot(p2p).await {
            Ok(snapshot_height) => {
                println!("[INFO][STORAGE] snapshot_loaded height={}", snapshot_height);

                // Derived consensus/reward indices (registry_root LtHash, cbw, roster) and the vrf_pk
                // completeness contract were materialized + checked inside verify_snapshot_consensus_binding
                // BEFORE the WS floor was adopted (fail-closed there, atomic with floor adoption), so by
                // here the snapshot is fully consistent and forward-ready.
                println!("[INFO][STORAGE] snapshot_indices_rebuilt h={}", snapshot_height);

                // CRITICAL: promote only swapped the on-disk CFs. The in-mem StateManager (merkle +
                // accounts DashMap) the apply pipeline reads is still empty — without rehydrating it the
                // first tail block (anchor+1) computes a near-empty state_root → state_root_mismatch →
                // rollback → apply circuit-breaker wedge. Fail-closed: on any rehydrate failure return
                // Err so the caller falls back to block-sync from a clean base.
                if let Err(e) = self.rehydrate_inmem_state_from_promoted_cf(state, snapshot_height).await {
                    // Rehydrate rejected the promoted snapshot (state_root mismatch) and cleared in-mem
                    // state. promote already advanced on-disk chain_height to the snapshot; reset it so
                    // the fallback block-sync restarts from genesis, not an orphaned mid-chain height.
                    let _ = self.reset_chain_height();
                    return Err(e);
                }

                if target_height > snapshot_height {
                    println!("[INFO][STORAGE] sync_remaining_start count={}",
                            target_height - snapshot_height);
                }
                Ok(())
            },
            Err(e) => {
                // AnchorPending is retryable (caller bails to the desync tick until the GALC pin arrives) —
                // not a failure, so don't emit the fallback warning for it.
                if !matches!(e, IntegrationError::AnchorPending) && crate::node::is_warn() {
                    println!("[WARN][STORAGE] snapshot_sync_failed err={:?} fallback=full_sync", e);
                }
                Err(e)
            }
        }
    }

    /// Cold-join: rehydrate the IN-MEM StateManager (merkle + accounts DashMap) from the just-promoted
    /// `accounts` CF, mirroring the boot TIER-1 restore (node.rs). promote_snapshot_staging only swaps
    /// the on-disk CFs; the apply pipeline reads this in-mem state, so without this the first tail block
    /// computes a near-empty state_root → mismatch → wedge. FAIL-CLOSED: if the rehydrated merkle does
    /// not match the anchor's 2f+1-bound state_root we clear the in-mem state and return Err so the
    /// caller falls back to block-replay from a clean base — never proceed with a mismatched state.
    pub async fn rehydrate_inmem_state_from_promoted_cf(
        &self,
        state: &std::sync::Arc<tokio::sync::RwLock<crate::StateManager>>,
        anchor_height: u64,
    ) -> IntegrationResult<()> {
        // OB1: block the apply pipeline from writing a tail block over the un-rehydrated (empty) in-mem
        // state for the whole rehydrate — including the synchronous macroblock read below, which can
        // stall under a compaction/flush storm and widen the adopt→rehydrate race. RAII clears on exit.
        struct RehydrateGuard;
        impl Drop for RehydrateGuard {
            fn drop(&mut self) { SNAPSHOT_REHYDRATE_IN_PROGRESS.store(false, Ordering::SeqCst); }
        }
        SNAPSHOT_REHYDRATE_IN_PROGRESS.store(true, Ordering::SeqCst);
        let _rehydrate_guard = RehydrateGuard;
        // Accounts are streamed row-by-row from the promoted CF into the merkle+DashMap below (no full
        // Vec materialization) — see the streaming restore after the anchor root/total_supply are read.
        // Emission watermark: highest emission macroblock already minted at/below the anchor. Derived
        // with the SAME formula the apply path uses (node.rs apply_block_to_state) so the rehydrated
        // node never re-mints an epoch the bound state already includes (>=2 epochs ⇒ double-mint).
        const EMISSION_BLOCK_INTERVAL: u64 = 14400;
        const MICROBLOCKS_PER_MB: u64 = 90;
        let current_epoch = anchor_height / EMISSION_BLOCK_INTERVAL;
        let last_minted_emission_mb = if current_epoch >= 2 {
            let rewarding_epoch = current_epoch.saturating_sub(2);
            rewarding_epoch.saturating_add(1).saturating_mul(EMISSION_BLOCK_INTERVAL) / MICROBLOCKS_PER_MB
        } else {
            0
        };

        // Anchor's committed state_root + QC-bound total_supply: the macroblock at anchor_height/90
        // carries BOTH — state_root directly (the SAME value verify_snapshot_consensus_binding checked
        // the staged accounts against) and total_supply via the embedded (Checkpoint, QC) in
        // consensus_data.checkpoint_qc. total_supply is in Checkpoint::hash() ⇒ qc.checkpoint_hash binds
        // it ⇒ 2f+1 certify it. We read this QC-bound value instead of summing balances: a balance sum
        // is correct ONLY pre-emission (epoch<2); at epoch>=2 emission mints supply credited later via
        // claim TXs, so minted>sum. total_supply is consensus-critical (emission cap) but NOT in
        // state_root (account-only), so it is bound separately here through the checkpoint.
        let mb_idx = anchor_height / MICROBLOCKS_PER_MB;
        let (anchor_state_root, total_supply): ([u8; 32], u64) = match self.get_macroblock_by_height(mb_idx)? {
            Some(bytes) => {
                let mb: qnet_state::MacroBlock = bincode::deserialize(&bytes)
                    .map_err(|e| IntegrationError::StorageError(format!("rehydrate_anchor_decode_fail {}", e)))?;
                // Extract the QC-bound total_supply from the embedded checkpoint. Pre-emission anchors
                // (epoch<2) MAY lack a checkpoint_qc (legacy/genesis) — fall back to the balance sum,
                // which is exact while minted==sum-of-balances.
                let ts = match &mb.consensus_data.checkpoint_qc {
                    // A PRESENT checkpoint_qc MUST decode — a corrupt QC is fail-closed (Err →
                    // block-replay), never a silent fall-back to a balance sum that is wrong post-emission.
                    Some(b) => {
                        let (cp, _) = bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint, qnet_consensus::checkpoint_bft::QuorumCertificate)>(b)
                            .map_err(|e| IntegrationError::StorageError(format!("rehydrate_checkpoint_decode_fail mb={} {}", mb_idx, e)))?;
                        cp.total_supply
                    }
                    // No checkpoint_qc ⇒ only legacy/genesis pre-emission anchors (epoch<2), where the
                    // balance sum is exact (minted==sum-of-balances). Streamed (O(1) RAM), not a Vec fold.
                    None => self.sum_all_account_balances()?,
                };
                (mb.state_root, ts)
            }
            None => {
                return Err(IntegrationError::StorageError(format!(
                    "rehydrate_anchor_missing mb={} h={}", mb_idx, anchor_height
                )));
            }
        };

        let sg = state.write().await;
        // STREAMING restore: feed the accounts CF row-by-row into the merkle + DashMap (no full Vec,
        // no double-hold — peak RAM drops from ~2x accounts to ~1x). A row that fails to decode is
        // skipped+logged; the resulting incompleteness trips the fail-closed merkle assert below
        // (clear + block-replay), so a corrupt row can never admit partial state.
        let cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let acct_iter = self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start).filter_map(|item| {
            let (k, v) = item.ok()?;
            let addr = String::from_utf8(k.to_vec()).ok()?;
            match bincode::deserialize::<qnet_state::Account>(&v) {
                Ok(a) => Some((addr, a)),
                Err(e) => { println!("[WARN][STATE] rehydrate_skip_corrupt_account err={}", e); None }
            }
        });
        // FAIL-CLOSED merkle assert BEFORE seeding chain_state — a mismatch then leaves no partial
        // chain_state to roll back (clear() resets accounts+merkle; chain_state was never mutated).
        // A mid-iteration failure leaves an arbitrary PREFIX of the snapshot in the accounts map, so
        // the Err path must wipe before returning — exactly as the mismatch branch below does.
        // Without it the caller falls back to a block replay on top of that prefix and applies every
        // credit in it a second time.
        let computed = match sg.restore_accounts_streamed(acct_iter) {
            Ok(root) => root,
            Err(e) => {
                sg.clear();
                return Err(IntegrationError::StorageError(format!("rehydrate_restore_fail {}", e)));
            }
        };
        if computed != anchor_state_root {
            println!("[ERR][STATE] rehydrate_merkle_mismatch expected={} computed={} action=clear_block_replay",
                     hex::encode(&anchor_state_root[..8]), hex::encode(&computed[..8]));
            sg.clear();
            return Err(IntegrationError::StorageError(format!(
                "rehydrate_merkle_mismatch h={} expected={} computed={}",
                anchor_height, hex::encode(&anchor_state_root[..8]), hex::encode(&computed[..8])
            )));
        }
        // Verified — seed chain_state now that the bound merkle is confirmed.
        {
            let mut cs = sg.chain_state.write();
            cs.height = anchor_height;
            cs.total_supply = total_supply;
            cs.last_minted_emission_mb = last_minted_emission_mb;
        }
        // Seal the anchor's total_supply so a cold-joiner can serve/verify the checkpoint at its anchor
        // head via get_total_supply_at (mirror of the registry_root seal carried through the binding).
        let _ = self.seal_total_supply(anchor_height, total_supply);
        // Rebuild the in-mem NodeRegistration-dedup map from the snapshot-bound node_registry CF (the CF
        // is bound by registry_root in the QC Checkpoint). restore_accounts seeds account leaves but NOT
        // this off-merkle map; without it a cold-joiner has an EMPTY registered_nodes for all reg_height<=
        // anchor entries, so a tail block with a duplicate NodeRegistration is admitted here (empty map ⇒
        // not "already registered") while from-genesis nodes reject it → registry_root divergence. Done
        // AFTER the fail-closed merkle assert so a rejected snapshot never seeds the map. Byte-identical
        // to a from-genesis node for all reg_height<=anchor bindings.
        self.reseed_commitment_dedup(&*sg)?;
        println!("[INFO][STATE] rehydrate_ok h={} root={} total_supply={} watermark_mb={}",
                 anchor_height, hex::encode(&anchor_state_root[..8]), total_supply, last_minted_emission_mb);
        Ok(())
    }

    // =========================================================================
    // SMART CONTRACT STORAGE METHODS
    // =========================================================================
    
}

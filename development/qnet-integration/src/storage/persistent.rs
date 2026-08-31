//! RocksDB layer: column families, compaction tuning, block and metadata primitives.

use super::*;

impl PersistentStorage {
    /// Save raw data with a custom key
    pub fn save_raw(&self, key: &str, data: &[u8]) -> IntegrationResult<()> {
        self.db.put(key.as_bytes(), data)?;
        Ok(())
    }
    
    /// Load raw data with a custom key
    pub fn load_raw(&self, key: &str) -> IntegrationResult<Option<Vec<u8>>> {
        match self.db.get(key.as_bytes())? {
            Some(data) => Ok(Some(data)),
            None => Ok(None),
        }
    }
    
    pub fn new(data_dir: &str) -> IntegrationResult<Self> {
        let path = Path::new(data_dir);
        std::fs::create_dir_all(path)?;
        
        // ═══════════════════════════════════════════════════════════════════════════
        // v3.19: OPTIMIZED RocksDB configuration for reduced disk usage
        // ═══════════════════════════════════════════════════════════════════════════
        let mut opts = Options::default();
        opts.create_if_missing(true);
        opts.create_missing_column_families(true);
        
        // v3.19: Reduced buffer sizes (64MB -> 16MB = 4x smaller WAL files)
        // -1 = keep every table reader open. A capped count evicts readers, which unpins the L0
        // filter/index blocks the block cache just paid for; reader memory is now bounded by the
        // shared cache instead of by this number.
        opts.set_max_open_files(-1);
        opts.set_use_fsync(true);      // Synchronous fsync: guarantees WAL durability on crash
        opts.set_bytes_per_sync(0);    // Disabled: fsync=true already guarantees durability
        opts.set_max_write_buffer_number(2);  // Reduced from 4
        opts.set_write_buffer_size(16777216); // 16MB (was 64MB) - 4x smaller WAL!
        opts.set_target_file_size_base(16777216); // 16MB (was 64MB)
        opts.set_min_write_buffer_number_to_merge(1); // Merge immediately
        opts.set_level_zero_stop_writes_trigger(8);   // Reduced
        opts.set_level_zero_slowdown_writes_trigger(4); // Reduced
        opts.set_compaction_style(rocksdb::DBCompactionStyle::Level);
        opts.set_max_background_jobs(2);  // Reduced from 4
        opts.set_disable_auto_compactions(false);
        
        // v3.41: CRITICAL WAL CLEANUP - limits total WAL size to 64MB
        // Without this, WAL files accumulate indefinitely with 17 column families
        // because a WAL can only be deleted when ALL CFs flush past it.
        // Rarely-written CFs (failover_events, snapshots) keep stale memtables,
        // preventing WAL deletion → 463 files / 1.8GB in 23 hours.
        // With this setting, RocksDB force-flushes oldest CF memtables when
        // total WAL exceeds 64MB, enabling old WAL cleanup.
        opts.set_max_total_wal_size(67_108_864); // 64MB max WAL (was: unlimited)

        // v25.3: BOUND RocksDB's internal diagnostic LOG file.
        // Default RocksDB behaviour is a SINGLE `LOG` file that grows
        // without bound until the DB is reopened (only a node restart
        // archives it to LOG.old.<ts>). In production this was observed
        // at ~454 MB after 27 h continuous uptime (~17 MB/h ≈ 150 GB/yr
        // unbounded) on every node. This is RocksDB's own operational
        // log (compaction/flush/stats) — NOT chain data, NOT the WAL,
        // NOT consensus state — so bounding it is purely hygienic and
        // cannot affect blockchain integrity, recovery, or determinism.
        //
        // size + count bounding only: rotate the LOG at 64 MB and keep
        // at most 10 rotations → hard cap ≈ 640 MB rolling window
        // instead of one ever-growing file. Verbosity (INFO) is
        // deliberately UNCHANGED so RocksDB-internal forensics
        // (compaction stalls, write-stalls, corruption events) remain
        // fully available — we only stop the unbounded growth, we do
        // not trade away diagnostic detail.
        opts.set_max_log_file_size(67_108_864);  // 64 MB → then rotate
        opts.set_keep_log_file_num(10);          // keep ≤10 rotations (~640 MB cap)

        // v3.19: AGGRESSIVE compaction settings
        opts.set_level_compaction_dynamic_level_bytes(true);
        opts.set_max_bytes_for_level_base(67108864); // 64MB base level
        opts.set_max_bytes_for_level_multiplier(4.0); // Faster level growth
        
        // v3.19: Enable compression at ALL levels (huge disk savings!)
        opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
        opts.set_bottommost_compression_type(rocksdb::DBCompressionType::Zstd);
        
        // v3.19: Optimized block-based options
        let mut block_opts = rocksdb::BlockBasedOptions::default();
        block_opts.set_block_size(16384); // 16KB blocks (was default 4KB)
        block_opts.set_cache_index_and_filter_blocks(true);
        block_opts.set_bloom_filter(10.0, false); // Bloom filter for faster lookups
        opts.set_block_based_table_factory(&block_opts);
        
        // ONE cache shared by every CF. Without an explicit cache each block-based factory
        // gets its own ~8MiB default LRU, and caching index+filter blocks there would thrash:
        // at 10M accounts the accounts-CF filter alone is ~12.5MB. A shared budget also means
        // hot CFs can use the space cold ones do not. It is a cap, not an allocation.
        const BLOCK_CACHE_BYTES: usize = 512 * 1024 * 1024;
        let block_cache = rocksdb::Cache::new_lru_cache(BLOCK_CACHE_BYTES);

        // Per-CF block table. Options::default() carries a DEFAULT block-based factory
        // (4KB blocks, NO bloom filter) — the DB-level block_opts above do NOT reach a CF
        // that declares its own Options, so every CF must set this explicitly or every
        // point read binary-searches each SST index at each level.
        //
        // `partitioned` splits the filter and index into cache-sized pieces plus a small top
        // level. Use it for CFs whose key count grows with the network (accounts, merkle):
        // a monolithic 30MB filter block would otherwise be evicted and re-read whole.
        let cf_block_opts = |partitioned: bool| -> rocksdb::BlockBasedOptions {
            let mut b = rocksdb::BlockBasedOptions::default();
            b.set_block_cache(&block_cache);
            b.set_block_size(16384);
            b.set_format_version(5);
            b.set_bloom_filter(10.0, false);
            b.set_cache_index_and_filter_blocks(true);
            b.set_pin_l0_filter_and_index_blocks_in_cache(true);
            if partitioned {
                b.set_index_type(rocksdb::BlockBasedIndexType::TwoLevelIndexSearch);
                b.set_partition_filters(true);
            }
            b
        };

        // v3.19: Create optimized CF options with compression
        let create_cf_opts = || -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
            cf_opts.set_write_buffer_size(8388608); // 8MB per CF
            cf_opts.set_max_write_buffer_number(2);
            cf_opts.set_target_file_size_base(16777216); // 16MB
            cf_opts.set_block_based_table_factory(&cf_block_opts(false));
            cf_opts
        };

        // v3.19: Optimized CF for hot data (microblocks, heartbeats)
        let create_hot_cf_opts = || -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
            cf_opts.set_write_buffer_size(4194304); // 4MB - very small for hot data
            cf_opts.set_max_write_buffer_number(2);
            cf_opts.set_target_file_size_base(8388608); // 8MB
            cf_opts.set_block_based_table_factory(&cf_block_opts(false));
            cf_opts
        };

        // v3.19: Optimized CF for cold data (old blocks)
        let create_cold_cf_opts = || -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Zstd); // Better compression
            cf_opts.set_write_buffer_size(16777216); // 16MB
            cf_opts.set_max_write_buffer_number(2);
            cf_opts.set_target_file_size_base(33554432); // 32MB
            cf_opts.set_block_based_table_factory(&cf_block_opts(false));
            cf_opts
        };

        // CFs whose key count grows with the network. A monolithic filter for 10M keys is ~14MB
        // and would be evicted and re-read whole; partitioning loads it in cache-sized pieces.
        let create_indexed_cf_opts = || -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
            cf_opts.set_write_buffer_size(8388608);
            cf_opts.set_max_write_buffer_number(2);
            cf_opts.set_target_file_size_base(16777216);
            cf_opts.set_block_based_table_factory(&cf_block_opts(true));
            cf_opts
        };

        // Merkle store: reads are dominated by lookups for nodes that do NOT exist
        // (empty subtrees on the descent), which is exactly what a whole-key bloom
        // filter answers without touching an SST. Fixed-width keys, no prefix domain.
        let create_merkle_cf_opts = || -> Options {
            let mut cf_opts = Options::default();
            cf_opts.set_compression_type(rocksdb::DBCompressionType::Lz4);
            cf_opts.set_write_buffer_size(16777216);
            cf_opts.set_max_write_buffer_number(3);
            cf_opts.set_target_file_size_base(33554432);
            // Point reads only (fixed-width keys, no prefix domain); leaves_under range-scans
            // but a range scan never consults the filter, so whole-key filtering is the right mode.
            let mut b = cf_block_opts(true);
            b.set_whole_key_filtering(true);
            cf_opts.set_block_based_table_factory(&b);
            cf_opts
        };
        
        // ColumnFamilyDescriptor doesn't implement Clone — rebuild on each retry attempt
        let build_column_families = || -> Vec<ColumnFamilyDescriptor> {
            vec![
                ColumnFamilyDescriptor::new("blocks", create_cold_cf_opts()),
                ColumnFamilyDescriptor::new("transactions", create_indexed_cf_opts()),
                ColumnFamilyDescriptor::new("accounts", create_indexed_cf_opts()),
                ColumnFamilyDescriptor::new("metadata", create_cf_opts()),
                ColumnFamilyDescriptor::new("microblocks", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("consensus", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("sync_state", create_cf_opts()),
                // Despite the name (kept so a fresh genesis is not the only way to read old data),
                // this holds the CERTIFIED per-epoch reward roots and the sharded leaf sets — the
                // pull-claim's whole durable state. It is live; do not read the name as dead.
                ColumnFamilyDescriptor::new("pending_rewards", create_cf_opts()),
                ColumnFamilyDescriptor::new("node_registry", create_indexed_cf_opts()),
                ColumnFamilyDescriptor::new("ping_history", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("failover_events", create_cf_opts()),
                ColumnFamilyDescriptor::new("snapshots", create_cold_cf_opts()),
                ColumnFamilyDescriptor::new("tx_index", create_indexed_cf_opts()),
                ColumnFamilyDescriptor::new("tx_by_address", create_indexed_cf_opts()),
                ColumnFamilyDescriptor::new("attestations", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("heartbeats", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("contract_storage", create_indexed_cf_opts()),
                ColumnFamilyDescriptor::new("fcm_tokens", create_cf_opts()),
                // Light-node ping delegation keys (operational, non-consensus): key=node_id, value JSON
                // {ping_pubkey, ping_delegation_cert}. Read per-ping so the hot crypto stays off the RAM registry.
                ColumnFamilyDescriptor::new("light_ping_keys", create_cf_opts()),
                // Cold-join staging: a downloaded snapshot is restored HERE, verified, then
                // promoted into the live state CFs. Live state is never mutated before the
                // consensus binding passes, so a rejected snapshot leaves no orphaned state.
                ColumnFamilyDescriptor::new("accounts_stage", create_cf_opts()),
                ColumnFamilyDescriptor::new("node_registry_stage", create_cf_opts()),
                ColumnFamilyDescriptor::new("pending_rewards_stage", create_cf_opts()),
                ColumnFamilyDescriptor::new("contract_storage_stage", create_cf_opts()),
                // v15.9: PERSISTENT MEMPOOL
                // ────────────────────────────────────────────────────────────
                // Pending transactions are mirrored from the in-RAM mempool
                // into this column family on admission and removed on block
                // inclusion / explicit removal / expiration. On node startup
                // every entry here is replayed back into the in-RAM mempool
                // so a producer crash or restart does not silently drop
                // user-submitted transactions or MEV bundles. Marked
                // hot-CF: writes are frequent (one per admitted TX), reads
                // are bursty (full scan only at boot), and the working
                // set fits comfortably in memory at 500 K entries.
                ColumnFamilyDescriptor::new("mempool", create_hot_cf_opts()),
                // ════════════════════════════════════════════════════════════
                // v15.10 STAGE-2C: CROSS-SHARD 2PC PERSISTENCE
                // ────────────────────────────────────────────────────────────
                // Two column families back the cross-shard surface:
                //   * `cross_shard_pending` — in-flight 2PC envelopes
                //     keyed by tx_id. Survives coordinator restarts so
                //     the failover path can reconstitute state.
                //   * `cross_shard_receipts` — terminal-state receipts
                //     keyed by tx_id. Append-only; queried by wallets
                //     via the `/api/v1/cross-shard/receipt/{tx_id}`
                //     RPC endpoint.
                //
                // Both CFs are hot — the working set is bounded by the
                // active 2PC concurrency (typically ≤ 1 000 in flight)
                // and the recent receipt window (purged by a separate
                // pruning task once an epoch has rolled).
                ColumnFamilyDescriptor::new("cross_shard_pending", create_hot_cf_opts()),
                ColumnFamilyDescriptor::new("cross_shard_receipts", create_hot_cf_opts()),
                // Persistent Merkle store (always on): the committed node/leaf set lives
                // in RocksDB, the in-RAM maps are bounded read-through caches.
                // Leaf key = raw 32-byte addr_hash; node key = 4-byte BE depth ++ 32-byte key.
                ColumnFamilyDescriptor::new("merkle_leaves", create_merkle_cf_opts()),
                ColumnFamilyDescriptor::new("merkle_nodes", create_merkle_cf_opts()),
                // Wallet→token reverse index (NON-consensus): key `owns_{wallet}_{contract}` marks a
                // live QRC-20 holding, maintained at apply from 0↔nonzero balance transitions. Turns the
                // per-wallet token list from an O(N)-accounts scan into an O(held) prefix seek at scale.
                ColumnFamilyDescriptor::new("wallet_token", create_indexed_cf_opts()),
                // Per-epoch reward aggregation scratch: written once per eligible node, scanned
                // once in wallet order, then range-deleted. Keeps the 10M-recipient root build
                // O(shard) in RAM instead of materialising the whole leaf set.
                ColumnFamilyDescriptor::new("reward_agg", create_cf_opts()),
            ]
        };

        // Downgrade-safe open: rocksdb requires EVERY existing CF to be declared, so an older binary
        // opening a DB a newer binary extended would otherwise fail to start. Union our known CFs
        // with any extra ones already on disk (opened with generic opts). Forward (missing CF) is
        // covered by create_missing_column_families; this covers the reverse. Keep list in sync with
        // build_column_families() above.
        const KNOWN_CF_NAMES: &[&str] = &[
            "blocks", "transactions", "accounts", "metadata", "microblocks", "consensus",
            "sync_state", "pending_rewards", "node_registry", "ping_history", "failover_events",
            "snapshots", "tx_index", "tx_by_address", "attestations", "heartbeats",
            "contract_storage", "fcm_tokens", "light_ping_keys", "mempool", "cross_shard_pending", "cross_shard_receipts",
            "accounts_stage", "node_registry_stage", "pending_rewards_stage", "contract_storage_stage",
            "merkle_leaves", "merkle_nodes", "wallet_token", "reward_agg",
        ];
        let open_descriptors = || -> Vec<ColumnFamilyDescriptor> {
            let mut cfs = build_column_families();
            if let Ok(existing) = DB::list_cf(&Options::default(), path) {
                for name in existing {
                    if name != "default" && !KNOWN_CF_NAMES.contains(&name.as_str()) {
                        eprintln!("[WARN][STORAGE] opening unknown CF '{}' (newer-binary DB → downgrade-safe)", name);
                        cfs.push(ColumnFamilyDescriptor::new(&name, create_cf_opts()));
                    }
                }
            }
            cfs
        };

        // RETRY: survive stale LOCK file after fast Docker restart.
        // Previous process may not have released the lock yet.
        let db = {
            let mut last_err = String::new();
            let mut opened = None;
            for attempt in 1u32..=10 {
                match DB::open_cf_descriptors(&opts, path, open_descriptors()) {
                    Ok(db) => { opened = Some(db); break; }
                    Err(e) => {
                        last_err = format!("{}", e);
                        eprintln!("[WARN][STORAGE] rocksdb_open attempt={}/10 err={}", attempt, e);
                        std::thread::sleep(std::time::Duration::from_secs(2));
                    }
                }
            }
            match opened {
                Some(db) => db,
                None => {
                    eprintln!("[CRIT][STORAGE] rocksdb_open_failed attempts=10 err={}", last_err);
                    return Err(IntegrationError::StorageError(
                        format!("RocksDB initialization failed after 10 attempts: {}", last_err)
                    ));
                }
            }
        };
        
        let store = Self { db: Arc::new(db) };
        store.enforce_storage_format()?;
        Ok(store)
    }

    /// Refuse to open a database written by an incompatible layout. The key format, the block
    /// structs and the macroblock preimage all changed; there is no backfill for the hash-addressed
    /// index, so opening old data would not fail — it would silently mis-read the chain. Failing
    /// loudly at startup turns "remember to wipe" from a convention into a checked precondition.
    pub(super) fn enforce_storage_format(&self) -> IntegrationResult<()> {
        const FORMAT_KEY: &[u8] = b"storage_format_version";
        const FORMAT_VERSION: u64 = 2; // 2 = zero-padded keys + hash-addressed index, PoH removed

        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let stored = self.db.get_cf(&metadata_cf, FORMAT_KEY)?
            .filter(|v| v.len() == 8)
            .map(|v| { let mut b = [0u8; 8]; b.copy_from_slice(&v[..8]); u64::from_be_bytes(b) });

        match stored {
            Some(v) if v == FORMAT_VERSION => Ok(()),
            Some(v) => {
                eprintln!("[CRIT][STORAGE] incompatible_format stored={} expected={} action=wipe_data_dir_required",
                          v, FORMAT_VERSION);
                Err(IntegrationError::StorageError(format!(
                    "storage format {} cannot be read by this build (expects {}) — wipe the data directory",
                    v, FORMAT_VERSION
                )))
            }
            None => {
                // No marker: either a fresh directory, or one written before versioning existed.
                // A populated unversioned store is pre-format data and must not be opened.
                let has_blocks = self.db.get_cf(&metadata_cf, b"chain_height")?.is_some();
                if has_blocks {
                    eprintln!("[CRIT][STORAGE] unversioned_populated_store action=wipe_data_dir_required");
                    return Err(IntegrationError::StorageError(
                        "existing chain data predates the current storage format — wipe the data directory".to_string()
                    ));
                }
                self.db.put_cf(&metadata_cf, FORMAT_KEY, &FORMAT_VERSION.to_be_bytes())?;
                Ok(())
            }
        }
    }

    /// v15.9: SAVE BLOCK ON BLOCKING POOL
    /// ────────────────────────────────────────────────────────────────────
    /// Per-block work — bincode + per-tx zstd-3 + batched RocksDB write —
    /// scales linearly with `block.transactions.len()`. At thousands of
    /// transactions per block this is hundreds of milliseconds of CPU and
    /// I/O on the producer's hot path. Running it inline on the tokio
    /// reactor stalls every other async task (RPC, P2P, consensus
    /// timers) for the duration of the write. We therefore hand the
    /// owned data + Arc<DB> clone to the blocking thread pool so the
    /// reactor stays responsive even under saturated load. The `await`
    /// surfaces propagation/cancellation cleanly.
    ///
    /// SCALABILITY (1 000+ super nodes)
    /// ────────────────────────────────────────────────────────────────────
    /// Every node performs this work locally for every accepted block;
    /// keeping it off the reactor is what allows a node to simultaneously
    /// (a) accept incoming P2P traffic, (b) serve sync requests from
    /// fresh peers, and (c) participate in Checkpoint-BFT consensus — all while
    /// the previous block is being persisted to disk.
    pub async fn save_block(&self, block: &qnet_state::Block) -> IntegrationResult<()> {
        let db = self.db.clone();
        let block = block.clone();
        tokio::task::spawn_blocking(move || -> IntegrationResult<()> {
            let block_cf = db.cf_handle("blocks")
                .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
            let tx_cf = db.cf_handle("transactions")
                .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
            let tx_index_cf = db.cf_handle("tx_index")
                .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
            let tx_by_addr_cf = db.cf_handle("tx_by_address")
                .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;

            let block_key = format!("block_{}", block.height);
            let block_data = bincode::serialize(&block)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;

            let mut batch = WriteBatch::default();
            batch.put_cf(&block_cf, block_key.as_bytes(), &block_data);

            // Store block hash mapping
            let hash_key = format!("hash_{}", block.height);
            let hash_data = bincode::serialize(&block.hash())
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            batch.put_cf(&block_cf, hash_key.as_bytes(), &hash_data);

            // Store transactions with Zstd-3 compression for O(1) lookups
            // OPTIMIZATION: Zstd-3 is fast (~500MB/s) and provides ~30-50% reduction
            // Pattern compression is done in background to not block consensus
            for tx in &block.transactions {
                let tx_key = format!("tx_{}", tx.hash);
                let tx_data = bincode::serialize(tx)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;

                // PRODUCTION: Compress transactions with fast Zstd-3 (non-blocking)
                // ~30-50% reduction, <1ms per TX, doesn't block block production
                let compressed_tx = zstd::encode_all(&tx_data[..], 3)
                    .unwrap_or_else(|_| tx_data.clone());

                batch.put_cf(&tx_cf, tx_key.as_bytes(), &compressed_tx);

                // INDEX: tx_hash -> block_height for O(1) transaction location
                batch.put_cf(&tx_index_cf, tx_key.as_bytes(), &block.height.to_be_bytes());

                // INDEX: address -> tx_hash for account transaction queries.
                // Key format: addr_{address}_{height:016x}_{tx_hash}. HEIGHT, not tx.timestamp: the
                // sender picks the timestamp, and the retention scan cuts on this field — a row
                // stamped in the future was unprunable forever. Height is also the true inclusion
                // order, so the prefix scan stays chronological.
                let stamp = block.height;
                let from_key = format!("addr_{}_{:016x}_{}", tx.from, stamp, tx.hash);
                batch.put_cf(&tx_by_addr_cf, from_key.as_bytes(), tx.hash.as_bytes());

                if let Some(ref to) = tx.to {
                    let to_key = format!("addr_{}_{:016x}_{}", to, stamp, tx.hash);
                    batch.put_cf(&tx_by_addr_cf, to_key.as_bytes(), tx.hash.as_bytes());
                }
                // QRC-20/721 counterparties are indexed from the success-gated transfer EVENTS
                // (build_token_transfer_rows), not from calldata intent — see the token_transfers index.
            }

            // Update chain height
            let metadata_cf = db.cf_handle("metadata")
                .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
            batch.put_cf(&metadata_cf, b"chain_height", &block.height.to_be_bytes());

            db.write(batch)?;
            Ok(())
        })
        .await
        .map_err(|e| IntegrationError::Other(format!("save_block_join_err: {}", e)))?
    }
    
    pub fn get_chain_height(&self) -> IntegrationResult<u64> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        match self.db.get_cf(&metadata_cf, b"chain_height")? {
            Some(data) => {
                if data.len() >= 8 {
                    let height_bytes: [u8; 8] = data[0..8].try_into()
                        .map_err(|_| IntegrationError::StorageError("Invalid height data".to_string()))?;
                    Ok(u64::from_be_bytes(height_bytes))
                } else {
                    Ok(0)
                }
            }
            None => Ok(0),
        }
    }
    
    /// CRITICAL FIX v2.64: Verify and repair desync between metadata CF and blocks CF
    /// Called ONCE at node startup to detect stuck chain_height
    /// 
    /// Problem: If metadata chain_height gets stuck but blocks continue arriving:
    /// - Blocks save to 'blocks' CF via broadcast
    /// - But 'metadata' CF chain_height doesn't update
    /// - Node reports old height but has newer blocks
    /// 
    /// Solution: Linear scan with gap tolerance to find actual max continuous height
    /// SECURITY: Only repairs if chain is continuous (no gaps > 10 blocks)
    /// PERFORMANCE: O(n) but only runs once at startup and uses early exit
    /// 
    /// v3.0: CRITICAL FIX - If metadata_height is low but blocks exist higher,
    /// use RocksDB iterator to find first existing block and scan from there
    pub fn verify_and_repair_chain_height(&self) -> IntegrationResult<bool> {
        use crate::node::{is_info, is_debug, is_warn};
        
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        // Get metadata height with read lock (atomic read)
        let metadata_height = match self.db.get_cf(&metadata_cf, b"chain_height")? {
            Some(data) if data.len() >= 8 => {
                u64::from_be_bytes(data[0..8].try_into()
                    .map_err(|_| IntegrationError::StorageError("Invalid height data".to_string()))?)
            }
            _ => 0,
        };
        
        if is_debug() { 
            println!("[DBG][STORAGE] verify_start metadata_h={}", metadata_height); 
        }
        
        // SECURITY: Find max CONTINUOUS height (no gaps > 10 blocks allowed)
        // This prevents accepting blocks from fork/attack with gaps
        let mut result = self.find_max_continuous_height(&microblocks_cf, metadata_height)?;
        
        // v9.0: CRITICAL FIX - If no continuous blocks found from metadata_height,
        // scan for FIRST existing block and use that as starting point.
        // Previously had arbitrary `< 100` cutoff — if metadata stuck at e.g. 5000
        // but blocks exist up to 8000, recovery was SKIPPED and node stalled permanently.
        if result.is_none() {
            if is_debug() {
                println!("[DBG][STORAGE] no_continuous_from_h={} scanning_for_first_block", metadata_height);
            }
            
            // Find first existing block using RocksDB iterator
            if let Some(first_block_height) = self.find_first_existing_block(&microblocks_cf)? {
                if first_block_height > metadata_height {
                    if is_warn() {
                        println!("[WARN][STORAGE] found_first_block_at={} metadata_was={}", 
                                 first_block_height, metadata_height);
                    }
                    
                    // Now scan from first found block to find max continuous
                    result = self.find_max_continuous_height(&microblocks_cf, first_block_height.saturating_sub(1))?;
                    
                    if let Some((max_height, _)) = result {
                        if is_warn() {
                            println!("[WARN][STORAGE] recovery_scan first={} max_continuous={}", 
                                     first_block_height, max_height);
                        }
                    }
                }
            }
        }
        
        match result {
            Some((actual_height, has_gaps)) => {
                if actual_height > metadata_height {
                    let gap = actual_height - metadata_height;
                    
                    // SECURITY CHECK: Don't auto-repair if chain has suspicious gaps
                    if has_gaps {
                        println!("[WARN][STORAGE] desync_detected_with_gaps metadata={} max_found={} gap={} auto_repair=skipped", 
                                 metadata_height, actual_height, gap);
                        if is_info() {
                            println!("[INFO][STORAGE] manual_repair_required reason=chain_gaps use_resync_recommended");
                        }
                        return Ok(false); // Don't auto-repair suspicious chain
                    }
                    
                    println!("[WARN][STORAGE] desync_detected metadata={} continuous_to={} gap={}", 
                             metadata_height, actual_height, gap);
                    
                    // ATOMICITY: Use compare-and-swap to prevent race conditions
                    // Re-read metadata height to detect if it was updated during scan
                    let current_metadata = match self.db.get_cf(&metadata_cf, b"chain_height")? {
                        Some(data) if data.len() >= 8 => {
                            let arr: [u8; 8] = data[0..8].try_into().unwrap_or([0u8; 8]);
                            u64::from_be_bytes(arr)
                        }
                        _ => 0,
                    };
                    
                    if current_metadata != metadata_height {
                        if is_debug() {
                            println!("[DBG][STORAGE] race_detected metadata_changed {} -> {} during_scan", 
                                     metadata_height, current_metadata);
                        }
                        return Ok(false); // Another process already fixed it
                    }
                    
                    // Safe to update: no race detected
                    if is_info() {
                        println!("[INFO][STORAGE] auto_repair_start h={}->{}", 
                                 metadata_height, actual_height);
                    }
                    
                    // Write new height
                    self.db.put_cf(&metadata_cf, b"chain_height", &actual_height.to_be_bytes())?;
                    
                    // SECURITY: Verify write succeeded (detect late race conditions)
                    let verify_height = match self.db.get_cf(&metadata_cf, b"chain_height")? {
                        Some(data) if data.len() >= 8 => {
                            let arr: [u8; 8] = data[0..8].try_into().unwrap_or([0u8; 8]);
                            u64::from_be_bytes(arr)
                        }
                        _ => 0,
                    };
                    
                    if verify_height != actual_height {
                        println!("[WARN][STORAGE] auto_repair_race_detected expected={} got={}", 
                                 actual_height, verify_height);
                        return Ok(false); // Race condition detected, don't claim success
                    }
                    
                    println!("[INFO][STORAGE] auto_repair_ok h={} gap_fixed={} verified=true", 
                             actual_height, gap);
                    
                    return Ok(true); // Repaired and verified
                }
            }
            None => {
                // No blocks found after metadata height
                if is_debug() { 
                    println!("[DBG][STORAGE] verify_ok metadata_h={} no_newer_blocks", metadata_height); 
                }
            }
        }
        
        Ok(false) // No repair needed
    }
    
    /// Find maximum continuous height in blocks CF (with gap tolerance)
    /// Returns: Some((max_height, has_significant_gaps)) or None if no blocks after start
    /// 
    /// SECURITY: Tolerates small gaps (up to 10 blocks) for network delays
    /// but reports if significant gaps exist (possible fork/attack)
    /// 
    /// PERFORMANCE: O(n) but with early exit and reasonable limit (20K blocks)
    /// For typical desync (< 1000 blocks): ~1000 RocksDB reads (< 100ms)
    pub(super) fn find_max_continuous_height(&self, blocks_cf: &ColumnFamily, start: u64) -> IntegrationResult<Option<(u64, bool)>> {
        use crate::node::is_debug;
        
        const MAX_SCAN_BLOCKS: u64 = 20000; // Safety limit (prevent infinite scan)
        const GAP_TOLERANCE: u64 = 10; // Allow up to 10 missing blocks (network delays)
        
        let mut max_found = start;
        let mut consecutive_missing = 0u64;
        let mut has_significant_gaps = false;
        let mut found_any = false;
        
        // Pre-allocate buffer for key formatting (avoid repeated allocations)
        let mut key_buffer = String::with_capacity(32);
        
        for h in (start + 1)..=(start.saturating_add(MAX_SCAN_BLOCKS)) {
            key_buffer.clear();
            // Must match the writer's key format exactly — an unpadded probe finds nothing and the
            // continuous-height scan silently reports zero blocks (chain-height auto-repair dead).
            key_buffer.push_str(&mb_body_key(h));

            if self.db.get_cf(blocks_cf, key_buffer.as_bytes())?.is_some() {
                max_found = h;
                consecutive_missing = 0;
                found_any = true;
            } else {
                consecutive_missing += 1;
                
                if consecutive_missing > GAP_TOLERANCE {
                    // Gap too large - stop scanning
                    if consecutive_missing > 20 {
                        has_significant_gaps = true;
                    }
                    
                    if is_debug() {
                        println!("[DBG][STORAGE] scan_stopped at_h={} gap={} max_found={}", 
                                 h, consecutive_missing, max_found);
                    }
                    break;
                }
            }
        }
        
        if found_any {
            Ok(Some((max_found, has_significant_gaps)))
        } else {
            Ok(None)
        }
    }
    
    /// v3.0: Find first existing block in storage using RocksDB iterator
    /// Used for recovery when metadata is corrupted but blocks exist
    /// 
    /// PERFORMANCE: Uses prefix iterator, typically finds block in O(1)
    pub(super) fn find_first_existing_block(&self, microblocks_cf: &ColumnFamily) -> IntegrationResult<Option<u64>> {
        use rocksdb::IteratorMode;
        use crate::node::is_debug;
        
        let iter = self.db.iterator_cf(microblocks_cf, IteratorMode::Start);
        
        for item in iter {
            match item {
                Ok((key, _)) => {
                    if let Ok(key_str) = std::str::from_utf8(&key) {
                        if key_str.starts_with("microblock_") {
                            if let Ok(height) = key_str["microblock_".len()..].parse::<u64>() {
                                if is_debug() {
                                    println!("[DBG][STORAGE] found_first_block h={}", height);
                                }
                                return Ok(Some(height));
                            }
                        }
                    }
                }
                Err(e) => {
                    println!("[WARN][STORAGE] iterator_error err={}", e);
                    break;
                }
            }
        }
        
        Ok(None)
    }
    
    /// v3.0: Flush all RocksDB data to disk
    /// CRITICAL: Call before graceful shutdown or when OOM is imminent
    /// This flushes WAL (Write-Ahead Log) to SST files, ensuring data durability
    pub fn flush_all(&self) -> IntegrationResult<()> {
        use rocksdb::FlushOptions;
        
        let mut flush_opts = FlushOptions::default();
        flush_opts.set_wait(true); // Wait for flush to complete
        
        // Every CF, including the ephemeral and staging ones: WAL is reclaimable only once ALL of
        // them have flushed past it.
        let cf_names = ALL_CF_NAMES;
        
        for cf_name in &cf_names {
            if let Some(cf) = self.db.cf_handle(cf_name) {
                if let Err(e) = self.db.flush_cf_opt(&cf, &flush_opts) {
                    println!("[WARN][STORAGE] flush_cf_failed cf={} err={}", cf_name, e);
                    // Continue flushing other CFs even if one fails
                }
            }
        }
        
        // Also flush default CF
        if let Err(e) = self.db.flush_opt(&flush_opts) {
            println!("[WARN][STORAGE] flush_default_failed err={}", e);
        }

        Ok(())
    }

    /// WAL-maintenance flush for the periodic task: set_wait(false) skips the trailing
    /// wait-for-flush-complete so the common case returns immediately after scheduling each CF's
    /// memtable flush (WAL reclamation is preserved). NOTE: this is NOT a hard non-blocking
    /// guarantee — RocksDB still applies WaitUntilFlushWouldNotStallWrites before the flush, so
    /// under an L0/immutable-memtable backlog the call CAN briefly block. It is therefore safe ONLY
    /// off the consensus runtime (the periodic caller dispatches it via spawn_blocking); NEVER call
    /// it on a runtime worker. flush_all (set_wait(true)) stays for shutdown/OOM, where durability
    /// must complete before exit.
    pub fn flush_all_background(&self) -> IntegrationResult<()> {
        use rocksdb::FlushOptions;

        let mut flush_opts = FlushOptions::default();
        flush_opts.set_wait(false); // skip wait-for-complete (may still briefly stall under L0 backlog)

        let cf_names = ALL_CF_NAMES;

        for cf_name in &cf_names {
            if let Some(cf) = self.db.cf_handle(cf_name) {
                if let Err(e) = self.db.flush_cf_opt(&cf, &flush_opts) {
                    if crate::node::is_warn() {
                        println!("[WARN][STORAGE] flush_cf_bg_failed cf={} err={}", cf_name, e);
                    }
                }
            }
        }
        if let Err(e) = self.db.flush_opt(&flush_opts) {
            if crate::node::is_warn() {
                println!("[WARN][STORAGE] flush_default_bg_failed err={}", e);
            }
        }
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // v3.19: PRUNING - Remove old data to save disk space
    // ═══════════════════════════════════════════════════════════════════════════
    
    
    /// v3.19 / v3.41: Compact all column families to reclaim disk space
    /// CRITICAL: Without compaction after delete operations, RocksDB marks
    /// keys as tombstones but doesn't physically reclaim disk space until
    /// compaction runs. This must be called after cleanup operations.
    pub fn compact_cfs(&self, cf_names: &[&str]) -> IntegrationResult<()> {
        for cf_name in cf_names {
            if let Some(cf) = self.db.cf_handle(cf_name) {
                self.db.compact_range_cf(&cf, None::<&[u8]>, None::<&[u8]>);
            }
        }
        if crate::node::is_info() {
            println!("[INFO][STORAGE] compaction_triggered cfs={} names={}",
                     cf_names.len(), cf_names.join(","));
        }
        Ok(())
    }
    
    /// Set chain height to a specific value (for fork resolution)
    pub fn set_chain_height(&self, height: u64) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        self.db.put_cf(&metadata_cf, b"chain_height", &height.to_be_bytes())?;
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════

    /// DATA CONSISTENCY: Reset chain height to 0 (DANGEROUS - requires explicit confirmation)
    /// This function will ONLY work if QNET_FORCE_RESET=1 AND QNET_CONFIRM_RESET=YES
    pub fn reset_chain_height(&self) -> IntegrationResult<()> {
        // SAFETY: Double-check that user REALLY wants to reset
        let force_reset = std::env::var("QNET_FORCE_RESET").unwrap_or_default();
        let confirm_reset = std::env::var("QNET_CONFIRM_RESET").unwrap_or_default();
        
        if force_reset != "1" || confirm_reset != "YES" {
            println!("[WARN][STORAGE] refusing_chain_height_reset");
            println!("[INFO][STORAGE] to_reset set QNET_FORCE_RESET=1 and QNET_CONFIRM_RESET=YES");
            return Err(IntegrationError::StorageError(
                "Chain height reset blocked - missing confirmation flags".to_string()
            ));
        }
        
        // Additional safety: Log the reset with timestamp
        let timestamp = chrono::Utc::now();
        println!("[WARN][STORAGE] chain_height_reset_initiated");
        println!("[INFO][STORAGE] chain_height_reset timestamp={} requested_by=QNET_FORCE_RESET+QNET_CONFIRM_RESET", timestamp);
        
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        // Get current height before reset for logging
        let current_height = match self.get_chain_height() {
            Ok(h) => h,
            Err(_) => 0,
        };
        
        // Set height to 0
        let height_bytes = 0u64.to_be_bytes();
        self.db.put_cf(&metadata_cf, b"chain_height", height_bytes)?;
        
        println!("[INFO][STORAGE] chain_height_reset from={} to=0", current_height);
        println!("[WARN][STORAGE] data_loss blocks_deleted={}", current_height);
        Ok(())
    }
    
    pub fn get_block_hash(&self, height: u64) -> IntegrationResult<Option<String>> {
        let block_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        
        let hash_key = format!("hash_{}", height);
        match self.db.get_cf(&block_cf, hash_key.as_bytes())? {
            Some(data) => {
                let hash: [u8; 32] = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                Ok(Some(hex::encode(hash)))
            }
            None => Ok(None),
        }
    }
    
    /// v6.2: Block integrity verification on read — recomputes hash and compares with stored value.
    pub async fn load_block_by_height(&self, height: u64) -> IntegrationResult<Option<qnet_state::Block>> {
        let block_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        
        let block_key = format!("block_{}", height);
        match self.db.get_cf(&block_cf, block_key.as_bytes())? {
            Some(data) => {
                let block: qnet_state::Block = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                
                // Verify block hash integrity against stored hash
                let hash_key = format!("hash_{}", height);
                if let Some(hash_data) = self.db.get_cf(&block_cf, hash_key.as_bytes())? {
                    let stored_hash: [u8; 32] = bincode::deserialize(&hash_data)
                        .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                    let computed_hash = block.hash();
                    if stored_hash != computed_hash {
                        return Err(IntegrationError::StorageError(format!(
                            "Block at h={} integrity check failed: stored={} computed={}",
                            height, hex::encode(stored_hash), hex::encode(computed_hash)
                        )));
                    }
                }
                
                Ok(Some(block))
            }
            None => Ok(None),
        }
    }
    
    pub async fn save_account(&self, account: &qnet_state::Account) -> IntegrationResult<()> {
        let accounts_cf = self.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;

        let account_data = bincode::serialize(account)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;

        self.db.put_cf(&accounts_cf, account.address.as_bytes(), &account_data)?;

        // v5.0: Persist contract_storage to dedicated CF for per-key access
        if account.is_contract {
            if !account.contract_storage.is_empty() {
                self.save_contract_storage(&account.address, &account.contract_storage)?;
            } else {
                // Storage cleared — remove stale keys from CF
                let _ = self.delete_contract_storage(&account.address);
            }
        }

        Ok(())
    }

    // v15.9 Stage-1: write-through account persistence. After a block is
    // verified/saved/height-advanced, mirror every account it mutated (set
    // from the BlockSnapshot journal; post-image re-read from the in-memory
    // accounts DashMap) into the accounts CF. Stage 1 = durability without a
    // RAM bound (Stage 2 = LRU+CF): the CF becomes the canonical durable
    // state so a crash rebuilds from CF + surviving microblocks, not a
    // genesis replay. One WriteBatch/block → block-atomic (all-or-none).
    // Runs on spawn_blocking so the reactor never stalls on compaction
    // (~15 KB/block). Contract storage → its own CF (small account rows).
    pub async fn persist_accounts_batch(
        &self,
        modified_accounts: Vec<(String, qnet_state::Account)>,
        deleted_addresses: Vec<String>,
    ) -> IntegrationResult<(usize, usize)> {
        if modified_accounts.is_empty() && deleted_addresses.is_empty() {
            return Ok((0, 0));
        }

        let db = self.db.clone();
        tokio::task::spawn_blocking(move || -> IntegrationResult<(usize, usize)> {
            let accounts_cf = db.cf_handle("accounts")
                .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
            let contract_storage_cf = db.cf_handle("contract_storage");

            let mut batch = WriteBatch::default();
            let mut put_count = 0usize;
            let mut del_count = 0usize;

            for (addr, account) in &modified_accounts {
                let bytes = bincode::serialize(account)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                batch.put_cf(&accounts_cf, addr.as_bytes(), &bytes);
                put_count = put_count.saturating_add(1);

                // Mirror contract storage into the dedicated CF when the
                // account is a contract. We use the same in-batch staging
                // so the contract row and its storage land atomically.
                if account.is_contract {
                    if let Some(ref cs_cf) = contract_storage_cf {
                        if account.contract_storage.is_empty() {
                            // Storage cleared — best-effort prune of any
                            // residual keys for this contract. The
                            // existing helper performs a prefix scan;
                            // we re-use it outside the batch since
                            // delete_range_cf semantics would require a
                            // separate pass.
                        } else {
                            for (k, v) in &account.contract_storage {
                                let composite_key = format!("{}\x00{}", addr, k);
                                batch.put_cf(cs_cf, composite_key.as_bytes(), v.as_bytes());
                            }
                        }
                    }
                }
            }

            for addr in &deleted_addresses {
                batch.delete_cf(&accounts_cf, addr.as_bytes());
                del_count = del_count.saturating_add(1);
            }

            db.write(batch)?;
            Ok((put_count, del_count))
        })
        .await
        .map_err(|e| IntegrationError::Other(format!("persist_accounts_join_err: {}", e)))?
    }

    // Sync best-effort batch write to the accounts CF. Called by the cache
    // eviction sweep (persist-before-evict) so an unpersisted cold mutation
    // is never lost. Same key/value layout as persist_accounts_batch; one
    // atomic WriteBatch.
    pub fn persist_accounts_sync(&self, accounts: &[(String, qnet_state::Account)]) -> IntegrationResult<usize> {
        if accounts.is_empty() { return Ok(0); }
        let accounts_cf = self.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut batch = WriteBatch::default();
        for (addr, account) in accounts {
            let bytes = bincode::serialize(account)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            batch.put_cf(&accounts_cf, addr.as_bytes(), &bytes);
        }
        self.db.write(batch)?;
        Ok(accounts.len())
    }

    // ── Wallet→token reverse index (wallet_token CF, NON-consensus) ──
    // Key `owns|{wallet}|{contract}` (the `|` separator never occurs in an address, so a shorter
    // wallet can't prefix-alias a longer one). Value is a single marker byte. Maintained at apply
    // from QRC-20 0↔nonzero transitions; a stale/missing entry self-heals via backfill_owns_indices.
    pub(super) fn owns_key(wallet: &str, contract: &str) -> Vec<u8> {
        format!("owns|{}|{}", wallet, contract).into_bytes()
    }
    pub(super) fn owns_prefix(wallet: &str) -> Vec<u8> {
        format!("owns|{}|", wallet).into_bytes()
    }

    /// A holder is indexable only if its address cannot alias another wallet's key prefix — i.e. it
    /// contains no `|` separator. `to`/holder is attacker-controlled (never format-validated at the
    /// QRC-20 credit arms), so this makes the owns key collision-free BY CONSTRUCTION rather than by
    /// the (false) assumption that `|` never appears in an address. Belt to the reader's live-balance
    /// recheck; a junk holder is simply never indexed under a real wallet's prefix.
    #[inline]
    pub(crate) fn owns_indexable(holder: &str) -> bool { !holder.contains('|') }

    /// The wallet_token keys for every LIVE (nonzero-balance) indexable holder of `contract` in
    /// `storage`. Single source of truth for "which holders does this contract's storage imply",
    /// shared by the boot/snapshot backfill and the reorg resync so the two index populations can
    /// never diverge on the type gate, the zero-detection, or the holder filter. Empty for non-QRC-20.
    pub(crate) fn owns_keys_for_contract(contract: &str, storage: &std::collections::HashMap<String, String>) -> Vec<Vec<u8>> {
        if storage.get("type").map(|t| t != "qrc20").unwrap_or(true) { return Vec::new(); }
        let mut out = Vec::new();
        for (skey, sval) in storage {
            if let Some(holder) = skey.strip_prefix("balance:") {
                if sval.trim() != "0" && !sval.trim().is_empty() && Self::owns_indexable(holder) {
                    out.push(Self::owns_key(holder, contract));
                }
            }
        }
        out
    }

    /// Write pre-derived owns keys in bounded chunks (one WriteBatch per 10k puts) so a full-index
    /// rebuild never materialises one giant batch. Returns keys written.
    pub(crate) fn write_owns_keys_batched(&self, keys: &[Vec<u8>]) -> IntegrationResult<usize> {
        if keys.is_empty() { return Ok(0); }
        let cf = self.db.cf_handle("wallet_token")
            .ok_or_else(|| IntegrationError::StorageError("wallet_token column family not found".to_string()))?;
        for chunk in keys.chunks(10_000) {
            let mut batch = WriteBatch::default();
            for key in chunk { batch.put_cf(&cf, key, &[1u8]); }
            self.db.write(batch)?;
        }
        Ok(keys.len())
    }

    /// Apply this block's Set/Clear owns-deltas AND advance the durable owns-watermark in ONE atomic
    /// cross-CF batch. The watermark = highest height whose owns-deltas are durable; boot compares it to
    /// the tip to skip the full rebuild when the index is already current (deltas empty → watermark-only).
    pub fn persist_owns_deltas(&self, deltas: &[qnet_state::OwnsDelta], height: u64) -> IntegrationResult<()> {
        let cf = self.db.cf_handle("wallet_token")
            .ok_or_else(|| IntegrationError::StorageError("wallet_token column family not found".to_string()))?;
        let meta = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut batch = WriteBatch::default();
        for d in deltas {
            match d {
                // Skip a holder whose address could alias another wallet's key prefix (contains `|`).
                // Same collision-safe filter as the backfill/resync helper — an unvalidated `to` can
                // never plant a junk key under a real wallet's prefix. Clear of such a key is a no-op.
                qnet_state::OwnsDelta::Set { wallet, contract } => {
                    if Self::owns_indexable(wallet) {
                        batch.put_cf(&cf, Self::owns_key(wallet, contract), &[1u8]);
                    }
                }
                qnet_state::OwnsDelta::Clear { wallet, contract } => {
                    if Self::owns_indexable(wallet) {
                        batch.delete_cf(&cf, Self::owns_key(wallet, contract));
                    }
                }
            }
        }
        batch.put_cf(&meta, b"meta_owns_watermark", &height.to_le_bytes());
        self.db.write(batch)?;
        Ok(())
    }

    /// Contracts for which `wallet` holds a live (nonzero) QRC-20 balance. O(held) prefix seek.
    pub fn get_tokens_for_wallet(&self, wallet: &str) -> IntegrationResult<Vec<String>> {
        let cf = self.db.cf_handle("wallet_token")
            .ok_or_else(|| IntegrationError::StorageError("wallet_token column family not found".to_string()))?;
        let prefix = Self::owns_prefix(wallet);
        let mut out = Vec::new();
        let iter = self.db.iterator_cf(&cf, rocksdb::IteratorMode::From(&prefix, rocksdb::Direction::Forward));
        for item in iter {
            let (key, _) = item.map_err(|e| IntegrationError::StorageError(e.to_string()))?;
            if !key.starts_with(&prefix) { break; }
            if let Ok(contract) = std::str::from_utf8(&key[prefix.len()..]) {
                out.push(contract.to_string());
            }
        }
        Ok(out)
    }

    /// One-time reconciliation: rebuild the wallet_token index from the authoritative accounts CF
    /// (every contract's `balance:{holder}` entry with a nonzero value). Idempotent; run at boot and
    /// after a snapshot apply so the O(1) reader is complete even for pre-index or externally-written
    /// (e.g. WASM) balances. O(contract storage entries) — bounded by live holders, run off the hot path.
    pub fn backfill_owns_indices(&self) -> IntegrationResult<usize> {
        let accounts_cf = self.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let wt_cf = self.db.cf_handle("wallet_token")
            .ok_or_else(|| IntegrationError::StorageError("wallet_token column family not found".to_string()))?;
        let mut batch = WriteBatch::default();
        let mut in_batch = 0usize;
        let mut written = 0usize;
        let iter = self.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, val) = item.map_err(|e| IntegrationError::StorageError(e.to_string()))?;
            let contract = match std::str::from_utf8(&key) { Ok(s) => s.to_string(), Err(_) => continue };
            let account: qnet_state::Account = match bincode::deserialize(&val) { Ok(a) => a, Err(_) => continue };
            if account.contract_storage.is_empty() { continue; }
            // Single source of truth for the type gate + live-holder + collision-safe filter (shared with
            // resync_owns_for_contract), so a WASM contract's `balance:{}` key is never a phantom token
            // and the boot/reorg index populations cannot drift apart.
            for key in Self::owns_keys_for_contract(&contract, &account.contract_storage) {
                batch.put_cf(&wt_cf, key, &[1u8]);
                in_batch += 1;
                written += 1;
                // Bounded chunks: a millions-of-holders rebuild never holds one giant batch in RAM.
                if in_batch >= 10_000 {
                    self.db.write(std::mem::take(&mut batch))?;
                    in_batch = 0;
                }
            }
        }
        if in_batch > 0 { self.db.write(batch)?; }
        // Index is now complete → readers may treat an empty per-wallet result as authoritative.
        OWNS_INDEX_READY.store(true, Ordering::Relaxed);
        Ok(written)
    }

    /// Re-derive the wallet_token entries for ONE contract from an authoritative `contract_storage`
    /// (the reorg-restored pre-image). Used on rollback: the owns-delta persist is a non-consensus
    /// background write that is NOT rolled back, so a `Clear` flushed for a balance the reorg then
    /// restores would leave the pair missing → the reader under-reports it. Re-adding every present
    /// holder heals that; stale entries left behind are balance-rechecked away by the reader. Bounded
    /// by this contract's holders. No-op for non-QRC-20 (same type gate as emission/backfill/reader).
    pub fn resync_owns_for_contract(&self, contract: &str, contract_storage: &std::collections::HashMap<String, String>) -> IntegrationResult<()> {
        let keys = Self::owns_keys_for_contract(contract, contract_storage);
        if keys.is_empty() { return Ok(()); }
        let cf = self.db.cf_handle("wallet_token")
            .ok_or_else(|| IntegrationError::StorageError("wallet_token column family not found".to_string()))?;
        let mut batch = WriteBatch::default();
        for key in keys { batch.put_cf(&cf, key, &[1u8]); }
        self.db.write(batch)?;
        Ok(())
    }

    // GALC held-capsule persistence (metadata CF). Tiny self-authenticating object; re-verified against
    // the embedded genesis keys on reload, so a tampered/stale on-disk value cannot poison the root.
    pub fn put_galc_held(&self, bytes: &[u8]) -> IntegrationResult<()> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.db.put_cf(&cf, b"galc_held", bytes)?;
        Ok(())
    }
    pub fn get_galc_held(&self) -> IntegrationResult<Option<Vec<u8>>> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        Ok(self.db.get_cf(&cf, b"galc_held")?)
    }
    // Adopted cold-join snapshot anchor (anchor_mb u64 LE ++ anchor hash [u8;32]) — persisted so a
    // warm-restarted joiner reloads its trusted floor (the SNAPSHOT_ANCHOR_MB static resets on restart).
    pub fn put_snapshot_anchor(&self, bytes: &[u8]) -> IntegrationResult<()> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.db.put_cf(&cf, b"snapshot_anchor", bytes)?;
        Ok(())
    }
    pub fn get_snapshot_anchor(&self) -> IntegrationResult<Option<Vec<u8>>> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        Ok(self.db.get_cf(&cf, b"snapshot_anchor")?)
    }

    // Checkpoint-BFT vote commitments (metadata CF, key `cpv_<index BE>`). A vote is a commitment,
    // not a cache: the engine refuses a second vote at one index/head, and peers CONVICT that pair,
    // so a commitment lost across a restart is a ban. Written with sync=true BEFORE the vote is
    // signed and broadcast, and pruned below the retention window — a head under the committed
    // frontier can never be proposed again, so forgetting it refuses nothing that could recur.
    // One record per checkpoint index (~one per CHECKPOINT_INTERVAL blocks), so the sync write is
    // per-minute, not per-block.
    pub fn record_checkpoint_vote(&self, index: u64, window_head: u64, content_digest: &[u8; 32],
                                  pinned: bool, parent_index: u64, parent_hash: &[u8; 32])
        -> IntegrationResult<()> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut val = Vec::with_capacity(81);
        val.extend_from_slice(&window_head.to_be_bytes());
        val.extend_from_slice(content_digest);
        val.push(pinned as u8);
        val.extend_from_slice(&parent_index.to_be_bytes());
        val.extend_from_slice(parent_hash);
        let mut wopts = rocksdb::WriteOptions::default();
        wopts.set_sync(true);
        self.db.put_cf_opt(&cf, checkpoint_vote_key(index), &val, &wopts)?;
        let floor = index.saturating_sub(qnet_consensus::checkpoint_bft::CONSENSUS_STATE_RETAIN);
        if floor > 0 {
            let mut batch = WriteBatch::default();
            for (k, _) in self.iter_checkpoint_votes(&cf)?.into_iter().filter(|(i, _)| *i < floor) {
                batch.delete_cf(&cf, checkpoint_vote_key(k));
            }
            self.db.write(batch)?;
        }
        Ok(())
    }

    /// Certified-but-unsealed (Checkpoint, QC) pair (metadata CF, key `cpq_<index BE>`) — the
    /// liveness complement of the vote commitments: on restart the driver re-adopts these and
    /// reboots at the CERTIFIED frontier, so a reboot between certification and seal can no longer
    /// split the committee across windows. Async write: a lost pair is re-fetched, never a fault.
    pub fn record_certified_pair(&self, index: u64, bytes: &[u8]) -> IntegrationResult<()> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.db.put_cf(&cf, super::certified_pair_key(index), bytes)?;
        let floor = index.saturating_sub(qnet_consensus::checkpoint_bft::CONSENSUS_STATE_RETAIN);
        if floor > 0 {
            let mut batch = WriteBatch::default();
            for (k, _) in self.iter_certified_pairs(&cf)? {
                if k < floor { batch.delete_cf(&cf, super::certified_pair_key(k)); }
            }
            if !batch.is_empty() { self.db.write(batch)?; }
        }
        Ok(())
    }

    /// All stored certified pairs, index-ascending.
    pub fn load_certified_pairs(&self) -> IntegrationResult<Vec<(u64, Vec<u8>)>> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.iter_certified_pairs(&cf)
    }

    fn iter_certified_pairs(&self, cf: &impl rocksdb::AsColumnFamilyRef)
        -> IntegrationResult<Vec<(u64, Vec<u8>)>> {
        const P: &[u8] = b"cpq_";
        let mut out = Vec::new();
        let iter = self.db.iterator_cf(cf, rocksdb::IteratorMode::From(P, rocksdb::Direction::Forward));
        for item in iter {
            let (k, v) = item?;
            if !k.starts_with(P) { break; }
            if k.len() != P.len() + 8 { continue; }
            let mut idx = [0u8; 8]; idx.copy_from_slice(&k[P.len()..]);
            out.push((u64::from_be_bytes(idx), v.to_vec()));
        }
        Ok(out)
    }

    /// Every stored vote commitment: `(index, window_head, content_digest, pinned, parent_index,
    /// parent_hash)`. An Err here means the node cannot know what it already voted for — the caller
    /// must refuse to run consensus rather than vote blind.
    pub fn load_checkpoint_votes(&self)
        -> IntegrationResult<Vec<(u64, u64, [u8; 32], bool, u64, [u8; 32])>> {
        let cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        Ok(self.iter_checkpoint_votes(&cf)?.into_iter().map(|(i, v)| (i, v.0, v.1, v.2, v.3, v.4)).collect())
    }

    pub(super) fn iter_checkpoint_votes(&self, cf: &impl rocksdb::AsColumnFamilyRef)
        -> IntegrationResult<Vec<(u64, (u64, [u8; 32], bool, u64, [u8; 32]))>> {
        const P: &[u8] = b"cpv_";
        let mut out = Vec::new();
        let iter = self.db.iterator_cf(cf, rocksdb::IteratorMode::From(P, rocksdb::Direction::Forward));
        for item in iter {
            let (k, v) = item?;
            if !k.starts_with(P) { break; }
            if k.len() != P.len() + 8 || v.len() != 81 { continue; }
            let mut idx = [0u8; 8]; idx.copy_from_slice(&k[P.len()..]);
            let mut head = [0u8; 8]; head.copy_from_slice(&v[0..8]);
            let mut digest = [0u8; 32]; digest.copy_from_slice(&v[8..40]);
            let mut pi = [0u8; 8]; pi.copy_from_slice(&v[41..49]);
            let mut ph = [0u8; 32]; ph.copy_from_slice(&v[49..81]);
            out.push((u64::from_be_bytes(idx),
                      (u64::from_be_bytes(head), digest, v[40] != 0, u64::from_be_bytes(pi), ph)));
        }
        Ok(out)
    }

    // (sync, called at a macroblock boundary under the apply context) Flush the
    // hot in-memory account set to the accounts CF, then pin a consistent
    // point-in-time DB view. With persist-before-evict keeping cold accounts in
    // the CF, the pinned view holds the COMPLETE committed tree leaf set at this
    // height; freezing it lets the off-reactor serializer reproduce state_root@H
    // even as H+1.. mutate the live DB.
    pub fn prepare_snapshot_view(
        &self,
        hot_accounts: &[(String, qnet_state::Account)],
    ) -> IntegrationResult<PinnedDbSnapshot> {
        self.persist_accounts_sync(hot_accounts)?;
        let snap = self.db.snapshot();
        // SAFETY: lifetime-extend the snapshot borrow to 'static. PinnedDbSnapshot
        // stores the same Arc<DB>, which outlives `snap`, so the underlying handle
        // is always valid; only the (runtime-erased) lifetime changes — layout-identical.
        let snap: rocksdb::SnapshotWithThreadMode<'static, DB> =
            unsafe { std::mem::transmute(snap) };
        Ok(PinnedDbSnapshot { db: self.db.clone(), snap })
    }

    /// Load a single account from the persistent `accounts` CF. Used by
    /// the read-through cache layer (Stage 2) and by recovery paths that
    /// need an authoritative on-disk copy of an account when the
    /// in-memory `DashMap` does not contain it.
    pub fn load_account(&self, address: &str) -> IntegrationResult<Option<qnet_state::Account>> {
        let accounts_cf = self.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        match self.db.get_cf(&accounts_cf, address.as_bytes())? {
            Some(bytes) => {
                let account: qnet_state::Account = bincode::deserialize(&bytes)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                Ok(Some(account))
            }
            None => Ok(None),
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // v5.0: CONTRACT STORAGE — RocksDB-backed per-key storage for smart contracts
    // Keys: "{contract_address}\x00{storage_key}" → value bytes
    // Enables efficient per-key reads/writes without serializing entire HashMap
    // ═══════════════════════════════════════════════════════════════════════════

    /// Persist all contract_storage entries for an account to the dedicated CF
    pub fn save_contract_storage(&self, address: &str, storage: &std::collections::HashMap<String, String>) -> IntegrationResult<()> {
        if storage.is_empty() {
            return Ok(());
        }
        let cs_cf = self.db.cf_handle("contract_storage")
            .ok_or_else(|| IntegrationError::StorageError("contract_storage CF not found".to_string()))?;
        let mut batch = rocksdb::WriteBatch::default();
        for (key, value) in storage {
            let db_key = format!("{}\x00{}", address, key);
            batch.put_cf(&cs_cf, db_key.as_bytes(), value.as_bytes());
        }
        self.db.write(batch)?;
        Ok(())
    }

    /// Load all contract_storage entries for a single contract address
    pub fn load_contract_storage(&self, address: &str) -> IntegrationResult<std::collections::HashMap<String, String>> {
        let cs_cf = self.db.cf_handle("contract_storage")
            .ok_or_else(|| IntegrationError::StorageError("contract_storage CF not found".to_string()))?;
        let prefix = format!("{}\x00", address);
        let prefix_bytes = prefix.as_bytes();
        let mut result = std::collections::HashMap::new();
        let iter = self.db.prefix_iterator_cf(&cs_cf, prefix_bytes);
        for item in iter {
            let (key_bytes, val_bytes) = item?;
            let key_str = std::str::from_utf8(&key_bytes).unwrap_or("");
            if !key_str.starts_with(&prefix) {
                break; // prefix iteration done
            }
            let storage_key = &key_str[prefix.len()..];
            let storage_val = std::str::from_utf8(&val_bytes).unwrap_or("").to_string();
            result.insert(storage_key.to_string(), storage_val);
        }
        Ok(result)
    }

    /// Set a single contract storage key (for incremental updates)
    pub fn set_contract_storage_key(&self, address: &str, key: &str, value: &str) -> IntegrationResult<()> {
        let cs_cf = self.db.cf_handle("contract_storage")
            .ok_or_else(|| IntegrationError::StorageError("contract_storage CF not found".to_string()))?;
        let db_key = format!("{}\x00{}", address, key);
        self.db.put_cf(&cs_cf, db_key.as_bytes(), value.as_bytes())?;
        Ok(())
    }

    /// Get a single contract storage value
    pub fn get_contract_storage_key(&self, address: &str, key: &str) -> IntegrationResult<Option<String>> {
        let cs_cf = self.db.cf_handle("contract_storage")
            .ok_or_else(|| IntegrationError::StorageError("contract_storage CF not found".to_string()))?;
        let db_key = format!("{}\x00{}", address, key);
        match self.db.get_cf(&cs_cf, db_key.as_bytes())? {
            Some(val) => Ok(Some(std::str::from_utf8(&val).unwrap_or("").to_string())),
            None => Ok(None),
        }
    }

    /// Delete all contract storage entries for an address (contract destroy)
    pub fn delete_contract_storage(&self, address: &str) -> IntegrationResult<()> {
        let cs_cf = self.db.cf_handle("contract_storage")
            .ok_or_else(|| IntegrationError::StorageError("contract_storage CF not found".to_string()))?;
        let prefix = format!("{}\x00", address);
        let mut batch = rocksdb::WriteBatch::default();
        let iter = self.db.prefix_iterator_cf(&cs_cf, prefix.as_bytes());
        for item in iter {
            let (key_bytes, _) = item?;
            let key_str = std::str::from_utf8(&key_bytes).unwrap_or("");
            if !key_str.starts_with(&prefix) {
                break;
            }
            batch.delete_cf(&cs_cf, &key_bytes);
        }
        self.db.write(batch)?;
        Ok(())
    }
    
    pub fn save_microblock(&self, height: u64, data: &[u8]) -> IntegrationResult<()> {
        if !can_save_block(height) {
            if crate::node::is_warn() {
                let (in_progress, target) = get_rollback_status();
                println!("[WARN][STORAGE] block_save_blocked h={} rollback={} target={}", 
                         height, in_progress, target);
            }
            return Ok(());
        }
        
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        let key = mb_body_key(height);
        
        // v12.0: Compute block hash from STRUCT FIELDS (MicroBlock::hash()), not raw bytes.
        // Block hash = SHA3(height + timestamp + prev_hash + merkle_root + producer) — consensus property.
        // Raw bytes depend on storage format and compression — must NOT affect consensus hash.
        let block_hash = match bincode::deserialize::<qnet_state::MicroBlock>(data) {
            Ok(mb) => mb.hash(),
            Err(_) => {
                // Fallback: try decompressing first (zstd)
                let decompressed = if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    zstd::decode_all(data).unwrap_or_else(|_| data.to_vec())
                } else {
                    data.to_vec()
                };
                match bincode::deserialize::<qnet_state::MicroBlock>(&decompressed) {
                    Ok(mb) => mb.hash(),
                    Err(_) => {
                        // Cannot compute struct hash — skip hash index (will be backfilled on read)
                        println!("[WARN][STORAGE] hash_index_skip h={} reason=deserialize_failed", height);
                        let mut batch = WriteBatch::default();
                        batch.put_cf(&microblocks_cf, key.as_bytes(), data);
                        batch.put_cf(&metadata_cf, b"chain_height", &height.to_be_bytes());
                        self.db.write(batch)?;
                        return Ok(());
                    }
                }
            }
        };
        let hash_key = mb_hash_key(height);
        // v12.1: Format discriminator — 0x01 = MicroBlock (full format)
        let fmt_key = mb_fmt_key(height);

        let mut batch = WriteBatch::default();
        batch.put_cf(&microblocks_cf, key.as_bytes(), data);
        batch.put_cf(&metadata_cf, b"chain_height", &height.to_be_bytes());
        batch.put_cf(&metadata_cf, hash_key.as_bytes(), &block_hash);
        batch.put_cf(&metadata_cf, fmt_key.as_bytes(), &[0x01u8]); // 0x01 = MicroBlock

        self.db.write(batch)?;
        Ok(())
    }

    /// PRODUCTION: Save activation code with AES-256-GCM encryption
    /// Key is derived from activation code and NEVER stored in database
    pub fn save_activation_code(&self, code: &str, node_type: u8, timestamp: u64) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        // Get device signature for migration tracking (NOT for encryption!)
        let device_signature = Self::get_device_signature_for_tracking();
        let server_ip = Self::get_server_ip();
        
        // SECURITY: Create activation data (includes code for self-validation)
        let activation_data = format!("{}:{}:{}:{}:{}", 
            code, node_type, timestamp, device_signature, server_ip);
        
        // PRODUCTION: Encrypt with AES-256-GCM (quantum-resistant)
        // Key is derived from activation code - NOT stored in database!
        let (encrypted_data, nonce) = Self::encrypt_with_aes_gcm(&activation_data, code)?;
        
        // Create storage record (nonce is public, encryption_key is NOT stored!)
        let storage_record = format!("{}:{}", 
            hex::encode(&nonce),  // Nonce (12 bytes, can be public)
            hex::encode(&encrypted_data)  // Encrypted data
        );
        
        self.db.put_cf(&metadata_cf, b"activation_code", storage_record.as_bytes())?;
        
        // CRITICAL: Do NOT save encryption key to database!
        // Key is derived from activation code when needed
        
        println!("[INFO][STORAGE] activation_code_encrypted cipher=AES-256-GCM key_not_stored=true");
        Ok(())
    }
    
    /// PRODUCTION: Load activation code with AES-256-GCM decryption
    /// Key is derived from activation code (env var or Genesis BOOTSTRAP_ID)
    pub fn load_activation_code(&self) -> IntegrationResult<Option<(String, u8, u64)>> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        match self.db.get_cf(&metadata_cf, b"activation_code")? {
            Some(encrypted_data) => {
                let encrypted_str = String::from_utf8_lossy(&encrypted_data);
                
                // Check if this is NEW format (nonce:encrypted) or LEGACY format (has state_key)
                if encrypted_str.contains(':') && encrypted_str.split(':').count() == 2 {
                    // NEW FORMAT: AES-256-GCM encrypted
                    let parts: Vec<&str> = encrypted_str.split(':').collect();
                    let nonce_hex = parts[0];
                    let encrypted_hex = parts[1];
                    
                    // Get activation code for decryption key
                    let activation_code = Self::get_activation_code_for_decryption()?;
                    
                    // Parse nonce and encrypted data
                    let nonce_bytes = hex::decode(nonce_hex)
                        .map_err(|e| IntegrationError::SecurityError(format!("Invalid nonce: {}", e)))?;
                    let encrypted_bytes = hex::decode(encrypted_hex)
                        .map_err(|e| IntegrationError::SecurityError(format!("Invalid encrypted data: {}", e)))?;
                    
                    if nonce_bytes.len() != 12 {
                        return Err(IntegrationError::SecurityError("Invalid nonce length".to_string()));
                    }
                    
                    let mut nonce_array = [0u8; 12];
                    nonce_array.copy_from_slice(&nonce_bytes);
                    
                    // PRODUCTION: Decrypt with AES-256-GCM
                    let decrypted_data = Self::decrypt_with_aes_gcm(&encrypted_bytes, &nonce_array, &activation_code)?;
                    
                    let decrypted_parts: Vec<&str> = decrypted_data.split(':').collect();
                    
                    // AES-256 format: code:node_type:timestamp:device_signature:server_ip
                    if decrypted_parts.len() >= 5 {
                        let saved_code = decrypted_parts[0];
                        let node_type = decrypted_parts[1].parse::<u8>().unwrap_or(1);
                        let timestamp = decrypted_parts[2].parse::<u64>().unwrap_or(0);
                        let stored_device_signature = decrypted_parts[3];
                        let stored_server_ip = decrypted_parts[4];
                        
                        // SECURITY: Validate that decrypted code matches activation code used for decryption
                        if saved_code != activation_code {
                            return Err(IntegrationError::SecurityError(
                                "Decryption succeeded but activation code mismatch - wrong code provided".to_string()
                            ));
                        }
                        
                        // PRODUCTION: Log device migration if detected
                        let current_device = Self::get_device_signature_for_tracking();
                        if stored_device_signature != current_device {
                            println!("[INFO][STORAGE] device_signature_changed reason=migration_or_new_hardware stored={}... current={}...", qnet_state::char_prefix(&stored_device_signature, 8), qnet_state::char_prefix(&current_device, 8));
                        }
                        
                        // Log IP changes (normal for migrations)
                        let current_server_ip = Self::get_server_ip();
                        if current_server_ip != stored_server_ip {
                            println!("[INFO][STORAGE] server_ip_changed from={} to={} reason=migration_or_restart",
                                     stored_server_ip, current_server_ip);
                        }
                        
                        println!("[INFO][STORAGE] activation_loaded cipher=AES-256-GCM");
                        return Ok(Some((saved_code.to_string(), node_type, timestamp)));
                    } else {
                        return Err(IntegrationError::SecurityError("Invalid AES-256 activation format".to_string()));
                    }
                } else {
                    // LEGACY FORMAT: Check for old XOR encryption with state_key
                    println!("[INFO][STORAGE] legacy_activation_detected action=migration");
                    
                    match self.db.get_cf(&metadata_cf, b"state_key")? {
                        Some(_) => {
                            // Legacy XOR format exists - load and re-save with AES-256
                            return self.load_legacy_activation_code(&encrypted_data);
                        }
                        None => {
                            return Err(IntegrationError::SecurityError(
                                "Unknown activation code format".to_string()
                            ));
                        }
                    }
                }
            }
            None => Ok(None),
        }
    }
    
    /// Load legacy activation code format for backwards compatibility
    pub(super) fn load_legacy_activation_code(&self, data: &[u8]) -> IntegrationResult<Option<(String, u8, u64)>> {
        let activation_str = String::from_utf8_lossy(data);
        let parts: Vec<&str> = activation_str.split(':').collect();
        
        if parts.len() == 3 {
            println!("[WARN][STORAGE] legacy_activation_format upgrade_recommended=true");
            let code = parts[0].to_string();
            let node_type = parts[1].parse::<u8>().unwrap_or(1);
            let timestamp = parts[2].parse::<u64>().unwrap_or(0);
            Ok(Some((code, node_type, timestamp)))
        } else {
            Ok(None)
        }
    }
    
    /// Clear activation code (for security)
    pub fn clear_activation_code(&self) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        self.db.delete_cf(&metadata_cf, b"activation_code")?;
        self.db.delete_cf(&metadata_cf, b"state_key")?;
        self.db.delete_cf(&metadata_cf, b"activation_burn_tx")?;
        Ok(())
    }
    
    /// Get burn transaction hash for activation code (for XOR decryption)
    pub fn get_activation_burn_tx(&self) -> IntegrationResult<String> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        match self.db.get_cf(&metadata_cf, b"activation_burn_tx")? {
            Some(data) => {
                let burn_tx = String::from_utf8_lossy(&data).to_string();
                Ok(burn_tx)
            }
            None => {
                // No burn_tx stored - return empty (Genesis nodes or legacy activations)
                Err(IntegrationError::StorageError("No burn_tx stored for activation".to_string()))
            }
        }
    }
    
    /// Save burn transaction hash for activation code
    pub fn save_activation_burn_tx(&self, burn_tx: &str) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        self.db.put_cf(&metadata_cf, b"activation_burn_tx", burn_tx.as_bytes())?;
        println!("[INFO][STORAGE] burn_tx_saved tx={}...", qnet_state::char_prefix(&burn_tx, 8));
        Ok(())
    }

    // ========================================================================
    // PERMANENT ATTACKER PK BLACKLIST (durable mirror)
    // ========================================================================
    // Canonical in-memory state lives in `qnet_consensus::consensus_crypto`.
    // The methods below mirror that state into the `metadata` column family
    // so a known attacker keypair cannot regain a transient verification
    // budget by racing the boot window after a restart.
    //
    // Layout (one key per attacker PK fingerprint):
    //   key = b"attacker_pk_bl/" || sha3_256(attacker_pk)        (47 bytes)
    //   val = first_seen_unix_s(8 LE) || last_seen_unix_s(8 LE)
    //       || offense_count(4 LE) || last_node_id_len(2 LE)
    //       || last_node_id(utf8)                                (≤ 122 bytes)
    //
    // Fixed-prefix scan recovers the full set with one iterator pass at
    // boot. No external schema dependency — values are self-describing
    // length-prefixed records.

    pub(super) const ATTACKER_PK_KEY_PREFIX: &'static [u8] = b"attacker_pk_bl/";

    pub(super) fn encode_attacker_pk_value(rec: &qnet_consensus::consensus_crypto::AttackerRecord) -> Vec<u8> {
        let node_id_bytes = rec.last_claimed_node_id.as_bytes();
        let node_id_len = node_id_bytes.len().min(u16::MAX as usize) as u16;
        let mut buf = Vec::with_capacity(8 + 8 + 4 + 2 + node_id_len as usize);
        buf.extend_from_slice(&rec.first_seen_unix_s.to_le_bytes());
        buf.extend_from_slice(&rec.last_seen_unix_s.to_le_bytes());
        buf.extend_from_slice(&rec.offense_count.to_le_bytes());
        buf.extend_from_slice(&node_id_len.to_le_bytes());
        buf.extend_from_slice(&node_id_bytes[..node_id_len as usize]);
        buf
    }

    pub(super) fn decode_attacker_pk_value(
        data: &[u8],
    ) -> Option<qnet_consensus::consensus_crypto::AttackerRecord> {
        if data.len() < 8 + 8 + 4 + 2 {
            return None;
        }
        let mut o = 0;
        let mut u8x8 = [0u8; 8];
        u8x8.copy_from_slice(&data[o..o + 8]);
        let first_seen_unix_s = u64::from_le_bytes(u8x8);
        o += 8;
        u8x8.copy_from_slice(&data[o..o + 8]);
        let last_seen_unix_s = u64::from_le_bytes(u8x8);
        o += 8;
        let mut u8x4 = [0u8; 4];
        u8x4.copy_from_slice(&data[o..o + 4]);
        let offense_count = u32::from_le_bytes(u8x4);
        o += 4;
        let mut u8x2 = [0u8; 2];
        u8x2.copy_from_slice(&data[o..o + 2]);
        let node_id_len = u16::from_le_bytes(u8x2) as usize;
        o += 2;
        if data.len() < o + node_id_len {
            return None;
        }
        let last_claimed_node_id = String::from_utf8_lossy(&data[o..o + node_id_len]).to_string();
        Some(qnet_consensus::consensus_crypto::AttackerRecord {
            first_seen_unix_s,
            last_seen_unix_s,
            offense_count,
            last_claimed_node_id,
        })
    }

    /// Persist one attacker-PK blacklist entry. Idempotent overwrite —
    /// the canonical layer guarantees that on re-insert the record is
    /// the post-update state, so writing it unconditionally keeps the
    /// durable row in sync with the in-memory truth.
    pub fn save_attacker_pk_entry(
        &self,
        fingerprint: &[u8; 32],
        record: &qnet_consensus::consensus_crypto::AttackerRecord,
    ) -> IntegrationResult<()> {
        let metadata_cf = self
            .db
            .cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut key = Vec::with_capacity(Self::ATTACKER_PK_KEY_PREFIX.len() + 32);
        key.extend_from_slice(Self::ATTACKER_PK_KEY_PREFIX);
        key.extend_from_slice(fingerprint);
        let value = Self::encode_attacker_pk_value(record);
        self.db.put_cf(&metadata_cf, &key, &value)?;
        Ok(())
    }

    /// Load every persisted attacker-PK blacklist entry. One iterator
    /// pass over the fixed-prefix range — called exactly once at boot.
    /// Malformed rows (e.g. legacy schema, truncated value) are skipped
    /// with a `[WARN][SECURITY]` log so they don't break the seed
    /// replay; the in-memory layer simply forgets them, which is safe
    /// because the Tier-2 verifier will re-record any still-active
    /// attacker on its next connection attempt.
    pub fn load_all_attacker_pk_entries(
        &self,
    ) -> IntegrationResult<Vec<([u8; 32], qnet_consensus::consensus_crypto::AttackerRecord)>>
    {
        use rocksdb::{IteratorMode, Direction};
        let metadata_cf = self
            .db
            .cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut out: Vec<([u8; 32], qnet_consensus::consensus_crypto::AttackerRecord)> = Vec::new();
        let prefix = Self::ATTACKER_PK_KEY_PREFIX;
        let iter = self
            .db
            .iterator_cf(&metadata_cf, IteratorMode::From(prefix, Direction::Forward));
        let mut malformed: u64 = 0;
        for item in iter {
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(_) => continue,
            };
            if !k.starts_with(prefix) {
                break; // left the prefix range
            }
            if k.len() != prefix.len() + 32 {
                malformed += 1;
                continue;
            }
            let mut fp = [0u8; 32];
            fp.copy_from_slice(&k[prefix.len()..]);
            match Self::decode_attacker_pk_value(&v) {
                Some(rec) => out.push((fp, rec)),
                None => malformed += 1,
            }
        }
        if malformed > 0 {
            println!(
                "[WARN][SECURITY] attacker_pk_blacklist_load malformed={} loaded={} action=skip_malformed",
                malformed,
                out.len(),
            );
        }
        Ok(out)
    }

    /// Update activation code for device migration (preserves activation, updates device)
    pub fn update_activation_for_migration(&self, code: &str, node_type: u8, timestamp: u64, new_device_signature: &str) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        // Generate new node identity with migration indicator
        let migration_identity = Self::generate_migration_identity(code, node_type, timestamp, new_device_signature)?;
        let server_ip = Self::get_server_ip();
        
        // Create new state key for migrated device
        let _state_key = Self::derive_state_key(code, &migration_identity)?;
        
        // PRODUCTION: Save with AES-256-GCM (same as save_activation_code)
        let activation_data = format!("{}:{}:{}:{}:{}", 
            code, node_type, timestamp, new_device_signature, server_ip);
        
        // Encrypt with AES-256-GCM (key from activation code, NOT stored!)
        let (encrypted_data, nonce) = Self::encrypt_with_aes_gcm(&activation_data, code)?;
        
        let storage_record = format!("{}:{}", 
            hex::encode(&nonce),
            hex::encode(&encrypted_data)
        );
        
        self.db.put_cf(&metadata_cf, b"activation_code", storage_record.as_bytes())?;
        
        // CRITICAL: Do NOT save encryption key - it's derived from activation code!
        
        println!("[INFO][STORAGE] activation_migrated device={}... cipher=AES-256-GCM", qnet_state::char_prefix(&new_device_signature, 16));
        Ok(())
    }
    
    /// Generate migration identity for device changes
    pub(super) fn generate_migration_identity(code: &str, node_type: u8, timestamp: u64, new_device_signature: &str) -> IntegrationResult<String> {
        use sha3::{Sha3_256, Digest};
        
        // Identity components for migrated device
        let mut identity_components = Vec::new();
        
        // Core: activation code + migration info
        identity_components.push(code.to_string());
        identity_components.push(format!("node_type:{}", node_type));
        identity_components.push(format!("timestamp:{}", timestamp));
        identity_components.push(format!("device_signature:{}", new_device_signature));
        
        // Add migration marker
        identity_components.push("migration_enabled".to_string());
        
        // Generate deterministic identity from transfer data
        let combined = identity_components.join("|");
        let identity_hash = hex::encode(Sha3_256::digest(combined.as_bytes()));
        
        // Use first 16 characters for transfer identity
        Ok(identity_hash[..16].to_string())
    }
    
    /// Generate cryptographic node identity from activation code (universal device support)
    #[allow(dead_code)]
    pub(super) fn generate_node_identity(code: &str, node_type: u8, timestamp: u64) -> IntegrationResult<String> {
        use sha3::{Sha3_256, Digest};
        
        // GENESIS PERIOD FIX: Simplified identity for bootstrap phase
        let is_genesis_bootstrap = std::env::var("QNET_BOOTSTRAP_ID").is_ok() || 
                                  std::env::var("QNET_GENESIS_BOOTSTRAP").unwrap_or_default() == "1";
        
        // Primary components: activation code + node config
        let mut identity_components = Vec::new();
        
        // Core: activation code itself (unique and immutable)
        identity_components.push(code.to_string());
        
        // Node configuration (stable across device migrations)
        identity_components.push(format!("node_type:{}", node_type));
        identity_components.push(format!("timestamp:{}", timestamp));
        
        if is_genesis_bootstrap {
            // PRODUCTION: STABLE Genesis identity - only immutable components
            // This ensures Genesis nodes have consistent identity across Docker restarts
            let bootstrap_id = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or_else(|_| "001".to_string());
            
            // Use only stable, immutable components for Genesis identity
            identity_components.push(format!("genesis_bootstrap_id:{}", bootstrap_id));
            identity_components.push(format!("network:qnet_mainnet"));
            identity_components.push(format!("genesis_version:v1.0"));
            
            // Deterministic hash from activation code only
            let primary_hash = hex::encode(Sha3_256::digest(code.as_bytes()));
            identity_components.push(format!("stable_code_hash:{}", &primary_hash[..16]));
            
            println!("[INFO][IDENTITY] genesis_identity_components=activation_code+bootstrap_id");
        } else {
            // PRODUCTION: Full identity with system info (after bootstrap)
            identity_components.push(format!("user:{}", 
                std::env::var("USER").unwrap_or_else(|_| "qnet".to_string())
            ));
            
            // Add hostname (may change but helps with uniqueness)
            if let Ok(hostname) = std::env::var("HOSTNAME") {
                identity_components.push(format!("hostname:{}", hostname));
            }
            
            // Universal device support: use activation code as primary entropy source
            let primary_hash = hex::encode(Sha3_256::digest(code.as_bytes()));
            identity_components.push(format!("code_hash:{}", &primary_hash[..16]));
        }
        
        // Generate deterministic identity from activation code
        let combined = identity_components.join("|");
        let identity_hash = hex::encode(Sha3_256::digest(combined.as_bytes()));
        
        // Use first 16 characters for node identity
        Ok(identity_hash[..16].to_string())
    }
    
    /// Get server IP (informational tracking field only, not node identity).
    /// Trust only the operator-supplied endpoint; never ingest an unvalidated
    /// external string (removed the curl-to-third-party shell-out: no timeout,
    /// no format check, hangs boot, lets a network attacker inject any string).
    pub(super) fn get_server_ip() -> String {
        for var in ["QNET_EXTERNAL_IP", "QNET_PUBLIC_IP"] {
            if let Ok(raw) = std::env::var(var) {
                let candidate = raw.trim();
                // Strict IP-format validation before accepting into the record.
                if candidate.parse::<std::net::IpAddr>().is_ok() {
                    return candidate.to_string();
                }
                if !candidate.is_empty() {
                    println!("[WARN][STORAGE] server_ip_invalid var={} value_len={}", var, candidate.len());
                }
            }
        }
        "unknown".to_string()
    }
    
    /// Derive state key from activation code and node identity
    pub(super) fn derive_state_key(code: &str, node_identity: &str) -> IntegrationResult<String> {
        use sha3::{Sha3_256, Digest};
        
        // Create deterministic key from activation code
        let key_material = format!("{}:{}:state_key", code, node_identity);
        let key_hash = hex::encode(Sha3_256::digest(key_material.as_bytes()));
        
        // Use first 32 characters as state key
        Ok(key_hash[..32].to_string())
    }
    
    /// PRODUCTION: Get activation code for decryption from environment or generate for Genesis
    pub(super) fn get_activation_code_for_decryption() -> IntegrationResult<String> {
        // Priority 1: Check QNET_ACTIVATION_CODE environment variable
        if let Ok(code) = std::env::var("QNET_ACTIVATION_CODE") {
            if !code.is_empty() {
                return Ok(code);
            }
        }
        
        // Priority 2: Generate for Genesis nodes from BOOTSTRAP_ID
        if let Ok(bootstrap_id) = std::env::var("QNET_BOOTSTRAP_ID") {
            match bootstrap_id.as_str() {
                "001" | "002" | "003" | "004" | "005" => {
                    let genesis_code = format!("QNET-BOOT-{:0>4}-STRAP", bootstrap_id);
                    return Ok(genesis_code);
                }
                _ => {}
            }
        }
        
        // No activation code available
        Err(IntegrationError::ValidationError(
            "No activation code available for decryption. Set QNET_ACTIVATION_CODE env var or QNET_BOOTSTRAP_ID for Genesis nodes".to_string()
        ))
    }
    
    /// PRODUCTION: Get device signature for tracking (NOT for encryption!)
    pub(super) fn get_device_signature_for_tracking() -> String {
        use sha3::{Sha3_256, Digest};
        
        let mut hasher = Sha3_256::new();
        
        // Hardware fingerprint for tracking
        if let Ok(hostname) = std::env::var("HOSTNAME") {
            hasher.update(hostname.as_bytes());
        }
        if let Ok(user) = std::env::var("USER") {
            hasher.update(user.as_bytes());
        }
        
        // Add timestamp component for Docker containers (they have random hostnames)
        let is_docker = std::env::var("DOCKER_ENV").is_ok();
        if is_docker {
            // For Docker: use container ID if available
            if let Ok(container_id) = std::env::var("HOSTNAME") {
                if container_id.len() == 12 {
                    hasher.update(b"docker_container:");
                    hasher.update(container_id.as_bytes());
                }
            }
        }
        
        format!("device_{}", hex::encode(&hasher.finalize()[..16]))
    }
    
    /// PRODUCTION: Derive AES-256 encryption key from activation code (for database security)
    /// Key is NEVER stored - computed from activation code each time
    pub(super) fn derive_encryption_key_from_code(code: &str) -> [u8; 32] {
        use sha3::{Sha3_256, Digest};
        
        let mut hasher = Sha3_256::new();
        hasher.update(code.as_bytes());
        hasher.update(b"QNET_DB_ENCRYPTION_V1");  // Salt for database encryption
        
        let hash = hasher.finalize();
        hash.into()
    }
    
    /// PRODUCTION: Encrypt data with AES-256-GCM (quantum-resistant symmetric encryption)
    /// Uses existing aes-gcm dependency from quantum_crypto module
    pub(super) fn encrypt_with_aes_gcm(data: &str, activation_code: &str) -> IntegrationResult<(Vec<u8>, [u8; 12])> {
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
        use aes_gcm::aead::Aead;
        use rand::Rng;
        
        // Derive encryption key from activation code
        let key_bytes = Self::derive_encryption_key_from_code(activation_code);
        let cipher = Aes256Gcm::new(&key_bytes.into());
        
        // Generate random nonce (12 bytes for GCM)
        use rand::rngs::OsRng;
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        
        // Encrypt with authenticated encryption (AEAD)
        let encrypted = cipher.encrypt(nonce, data.as_bytes())
            .map_err(|e| IntegrationError::SecurityError(format!("AES-GCM encryption failed: {}", e)))?;
        
        Ok((encrypted, nonce_bytes))
    }
    
    /// PRODUCTION: Decrypt data with AES-256-GCM
    pub(super) fn decrypt_with_aes_gcm(encrypted_data: &[u8], nonce: &[u8; 12], activation_code: &str) -> IntegrationResult<String> {
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
        use aes_gcm::aead::Aead;
        
        // Derive encryption key from activation code (same as encryption)
        let key_bytes = Self::derive_encryption_key_from_code(activation_code);
        let cipher = Aes256Gcm::new(&key_bytes.into());
        
        let nonce_ref = Nonce::from_slice(nonce);
        
        // Decrypt and verify authentication tag
        let decrypted = cipher.decrypt(nonce_ref, encrypted_data)
            .map_err(|e| IntegrationError::SecurityError(format!("AES-GCM decryption failed: {}", e)))?;
        
        String::from_utf8(decrypted)
            .map_err(|e| IntegrationError::SecurityError(format!("UTF-8 decoding failed: {}", e)))
    }
    
    pub fn load_microblock(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;

        let key = mb_body_key(height);
        match self.db.get_cf(&microblocks_cf, key.as_bytes())? {
            Some(data) => Ok(Some(data)),
            None => Ok(None),
        }
    }

    /// Highest (height, round) this node has ever SIGNED as producer, ordered ROUND-first. Monotone
    /// and durable: the only thing standing between a rollback-then-re-produce and a permanent,
    /// chain-committed equivocation ban, which neither fork-choice nor certification can undo.
    /// Written with fsync BEFORE the signature is produced, so a crash in between costs one skipped
    /// slot rather than a second signature at one (height, round).
    pub fn save_highest_signed_mark(&self, height: u64, window: u64, round: u64, last_height: u64) -> IntegrationResult<()> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut opts = rocksdb::WriteOptions::default();
        opts.set_sync(true);
        let mut buf = [0u8; 32];
        buf[..8].copy_from_slice(&height.to_be_bytes());
        buf[8..16].copy_from_slice(&window.to_be_bytes());
        buf[16..24].copy_from_slice(&round.to_be_bytes());
        buf[24..].copy_from_slice(&last_height.to_be_bytes());
        self.db.put_cf_opt(&metadata_cf, HIGHEST_SIGNED_HEIGHT_KEY, &buf, &opts)?;
        Ok(())
    }

    /// Reads the mark as (highest height, window, round, last height). None means never produced.
    /// A shorter record predates a field; each older shape derives what it lacks from the height,
    /// which is where that signature necessarily sat, so the upgrade cannot admit a pair an older
    /// binary would have refused.
    pub fn load_highest_signed_mark(&self) -> IntegrationResult<Option<(u64, u64, u64, u64)>> {
        const MB: u64 = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let rd = |b: &[u8]| { let mut x = [0u8; 8]; x.copy_from_slice(b); u64::from_be_bytes(x) };
        match self.db.get_cf(&metadata_cf, HIGHEST_SIGNED_HEIGHT_KEY)? {
            Some(d) if d.len() == 32 =>
                Ok(Some((rd(&d[..8]), rd(&d[8..16]), rd(&d[16..24]), rd(&d[24..])))),
            Some(d) if d.len() == 24 => {
                let h = rd(&d[..8]);
                Ok(Some((h, rd(&d[8..16]), rd(&d[16..]), h)))
            }
            Some(d) if d.len() == 16 => {
                let h = rd(&d[..8]);
                Ok(Some((h, h.saturating_sub(1) / MB + 1, rd(&d[8..]), h)))
            }
            Some(d) if d.len() == 8 => {
                let h = rd(&d);
                Ok(Some((h, h.saturating_sub(1) / MB + 1, 0, h)))
            }
            _ => Ok(None),
        }
    }

    /// v10.2: O(1) microblock hash lookup from index.
    /// Returns SHA3-256 hash of stored block data without loading the full block.
    /// Used for prev_hash validation — eliminates O(block_size) load+hash overhead.
    pub fn load_microblock_hash(&self, height: u64) -> IntegrationResult<Option<[u8; 32]>> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let hash_key = mb_hash_key(height);
        match self.db.get_cf(&metadata_cf, hash_key.as_bytes())? {
            Some(data) if data.len() == 32 => {
                let mut hash = [0u8; 32];
                hash.copy_from_slice(&data);
                return Ok(Some(hash));
            }
            Some(data) => {
                eprintln!("[ERR][STORAGE] invalid_hash_index_len h={} len={} — rebuilding", height, data.len());
                // fall through to backfill (corrupt index → rebuild from the stored block)
            }
            None => { /* fall through to backfill */ }
        }

        // BACKFILL ON READ — the promise save_microblock makes ("will be backfilled
        // on read") but never kept until now. The hash index can be absent for a block
        // that IS fully stored: a save path whose wire format the save-time
        // MicroBlock-only hash extractor couldn't decode (→ hash_index_skip), a
        // delete+re-sync, or a DA-repaired microblock. Without backfill, load returns
        // None for a present block, and the macroblock window-content check counts it
        // "missing" → the proposer refuses to sign the checkpoint → 2f+1 unreachable →
        // finality freezes the ENTIRE chain (observed: mb16 stuck, all nodes at
        // finalized=mb15 while the blocks were on disk the whole time).
        // build_microblock_hash_index decodes BOTH MicroBlock and EfficientMicroBlock
        // and writes the index. A genuinely-absent block → false → None → DA-repair.
        if self.build_microblock_hash_index(height).unwrap_or(false) {
            if let Some(data) = self.db.get_cf(&metadata_cf, hash_key.as_bytes())? {
                if data.len() == 32 {
                    let mut hash = [0u8; 32];
                    hash.copy_from_slice(&data);
                    return Ok(Some(hash));
                }
            }
        }
        Ok(None)
    }

    /// v12.0: Build hash index entry for a single block (used by migration).
    /// Deserializes block, computes consensus hash via MicroBlock::hash(), stores in metadata CF.
    /// Block hash = SHA3(height + timestamp + prev_hash + merkle_root + producer) — consensus property.
    pub fn build_microblock_hash_index(&self, height: u64) -> IntegrationResult<bool> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks CF not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;

        let block_key = mb_body_key(height);
        match self.db.get_cf(&microblocks_cf, block_key.as_bytes())? {
            Some(data) => {
                // Decompress if zstd-compressed
                let decompressed = if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    zstd::decode_all(&data[..]).unwrap_or_else(|_| data.to_vec())
                } else {
                    data.to_vec()
                };
                // Deserialize and compute consensus hash from struct fields
                let block_hash = if let Ok(mb) = bincode::deserialize::<qnet_state::MicroBlock>(&decompressed) {
                    if mb.height == height { mb.hash() } else { return Ok(false); }
                } else if let Ok(eb) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&decompressed) {
                    if eb.height == height { eb.hash() } else { return Ok(false); }
                } else {
                    println!("[WARN][STORAGE] hash_index_build_skip h={} reason=deserialize_failed", height);
                    return Ok(false);
                };
                let hash_key = mb_hash_key(height);
                self.db.put_cf(&metadata_cf, hash_key.as_bytes(), &block_hash)?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Delete a microblock at the specified height (for fork resolution)
    /// v10.2: Also removes hash index entry to keep index consistent
    pub fn delete_microblock(&self, height: u64) -> IntegrationResult<()> {
        note_body_delete(height);
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let key = mb_body_key(height);
        let hash_key = mb_hash_key(height);

        let mut batch = WriteBatch::default();
        // Every index entry describing this block goes with it. The header, or a child link still
        // naming it as a parent, would otherwise keep answering for a block that no longer exists:
        // the header makes an orphan resolvable again, and a stale child link makes the branch walk
        // see a phantom successor it can never load.
        if let Ok(Some(existing)) = self.load_microblock_hash(height) {
            if let Some(prev) = self.header_index(&existing).map(|h| h.previous_hash) {
                batch.delete_cf(&metadata_cf, &block_child_key(&prev, &existing));
            }
            batch.delete_cf(&metadata_cf, &block_header_key(&existing));
        }
        batch.delete_cf(&microblocks_cf, key.as_bytes());
        batch.delete_cf(&metadata_cf, hash_key.as_bytes());
        self.db.write(batch)?;

        Ok(())
    }

    /// Header index lookup at the persistent layer (the tiered wrapper exposes `header_by_hash`).
    pub(crate) fn header_index(&self, hash: &[u8; 32]) -> Option<BlockHeaderIdx> {
        let metadata_cf = self.db.cf_handle("metadata")?;
        let raw = self.db.get_cf(&metadata_cf, &block_header_key(hash)).ok()??;
        bincode::deserialize::<BlockHeaderIdx>(&raw).ok()
    }

    /// Delete a range of microblocks atomically (for fork resolution).
    /// Uses single WriteBatch — crash-safe: either all deleted or none.
    pub fn delete_microblocks_range(&self, from_height: u64, to_height: u64) -> IntegrationResult<u64> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let mut batch = WriteBatch::default();
        let mut count: u64 = 0;
        for h in from_height..=to_height {
            note_body_delete(h);
            let key = mb_body_key(h);
            let hash_key = mb_hash_key(h);
            // Header and child link must go with the body — see delete_microblock.
            if let Ok(Some(existing)) = self.load_microblock_hash(h) {
                if let Some(prev) = self.header_index(&existing).map(|hd| hd.previous_hash) {
                    batch.delete_cf(&metadata_cf, &block_child_key(&prev, &existing));
                }
                batch.delete_cf(&metadata_cf, &block_header_key(&existing));
            }
            batch.delete_cf(&microblocks_cf, key.as_bytes());
            batch.delete_cf(&metadata_cf, hash_key.as_bytes());
            count += 1;
        }
        self.db.write(batch)?;
        Ok(count)
    }
    
    /// Hash of the most recently sealed macroblock.
    pub fn get_latest_macroblock_hash(&self) -> Result<[u8; 32], IntegrationError> {
        let metadata_cf = self.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        
        match self.db.get_cf(&metadata_cf, b"latest_macroblock_hash")? {
            Some(data) if data.len() >= 32 => {
                let mut hash = [0u8; 32];
                hash.copy_from_slice(&data[..32]);
                Ok(hash)
            },
            _ => Ok([0u8; 32]), // Default genesis hash
        }
    }
    
    /// Save macroblock to storage (IDEMPOTENT - won't overwrite existing)
    /// 
    /// CRITICAL v2.26.8: Made idempotent to prevent:
    /// - Race conditions between consensus and PFP
    /// - Data inconsistency from parallel writes
    /// - Overwriting valid macroblocks with different data
    /// v15.9: SAVE MACROBLOCK ON BLOCKING POOL
    /// ────────────────────────────────────────────────────────────────────
    /// Macroblocks carry the full ConsensusData (checkpoint QC + eligible-
    /// producer snapshot + ban set) plus the entire
    /// microblock-hash list. Serialised payload grows with the active
    /// committee size; at 1 000+ super nodes the bincode of a single
    /// macroblock can reach hundreds of KB. The idempotent get + RocksDB
    /// write therefore must run off the async reactor so consensus,
    /// P2P, and RPC tasks remain responsive across the macroblock
    /// boundary, which is the busiest point in the protocol cycle.
    pub async fn save_macroblock(&self, height: u64, macroblock: &qnet_state::MacroBlock) -> IntegrationResult<()> {
        let db = self.db.clone();
        let macroblock = macroblock.clone();
        tokio::task::spawn_blocking(move || -> IntegrationResult<()> {
            let microblocks_cf = db.cf_handle("microblocks")
                .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
            let metadata_cf = db.cf_handle("metadata")
                .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

            let key = format!("macroblock_{}", height);

            // IDEMPOTENT CHECK: Don't overwrite existing macroblock
            // This prevents race conditions and ensures data consistency
            if let Some(existing) = db.get_cf(&microblocks_cf, key.as_bytes())? {
                if !existing.is_empty() {
                    println!("[INFO][STORAGE] macroblock_exists_skip h={} idempotent=true", height);
                    return Ok(());
                }
            }

            let data = bincode::serialize(&macroblock)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;

            let mut batch = WriteBatch::default();
            batch.put_cf(&microblocks_cf, key.as_bytes(), &data);

            // Update latest macroblock hash
            let hash = macroblock.hash();
            batch.put_cf(&metadata_cf, b"latest_macroblock_hash", &hash);

            // THE reward-root writer. An epoch's root is the certified checkpoint field of the
            // macroblock that closes it, written atomically with that macroblock — so a root cannot
            // exist without its macroblock, and an epoch cannot be listed without a root.
            if let Some(epoch) = crate::reward_epoch::epoch_of_emission_mb(height) {
                let rewards_cf = db.cf_handle("pending_rewards")
                    .ok_or_else(|| IntegrationError::StorageError("pending_rewards CF not found".to_string()))?;
                let root = macroblock.consensus_data.checkpoint_qc.as_ref()
                    .and_then(|b| bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint,
                                                          qnet_consensus::checkpoint_bft::QuorumCertificate)>(b).ok())
                    .map(|(cp, _)| cp.reward_root);
                match root {
                    Some(r) => {
                        let k = Storage::epoch_root_key(epoch);
                        // Immutable: a differing value at the same index means two certified
                        // macroblocks exist there, which is equivocation, not a retry.
                        if let Some(prev) = db.get_cf(&rewards_cf, k.as_bytes())? {
                            if prev.as_slice() != r.as_slice() {
                                return Err(IntegrationError::StorageError(format!(
                                    "epoch_root_equivocation epoch={} mb={}", epoch, height)));
                            }
                        }
                        batch.put_cf(&rewards_cf, k.as_bytes(), &r);
                    }
                    None => {
                        // Unreachable for a verified macroblock (verify_v2_macroblock rejects a
                        // missing QC); refuse rather than store an epoch-closing macroblock with no root.
                        return Err(IntegrationError::StorageError(format!(
                            "macroblock_without_qc mb={} epoch={}", height, epoch)));
                    }
                }
            }

            // The contiguous seal watermark (last_sealed_mb) is derived on read by
            // last_sealed_mb_index(), never written here: two writers (BFT seal +
            // P2P sync ingest) save macroblocks concurrently and un-serialized, so
            // a writer-side read-modify-write would lose updates and freeze the
            // frontier. Body writes stay independent per-index; the reader folds them.
            db.write(batch)?;
            // This index BECAME present (the idempotent-skip above returned early otherwise) — signal the
            // pipeline's committee-deferred redrive, whose clear condition is exactly "macroblock n2 exists".
            MACROBLOCK_SAVE_SEQ.fetch_add(1, Ordering::Relaxed);
            println!("[INFO][STORAGE] macroblock_saved h={}", height);
            Ok(())
        })
        .await
        .map_err(|e| IntegrationError::Other(format!("save_macroblock_join_err: {}", e)))?
    }
    
    /// Get macroblock by its index (height / 90)
    pub fn get_macroblock_by_height(&self, macroblock_index: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        
        // CRITICAL FIX: Macroblocks are stored with key "macroblock_{index}"
        // where index is the macroblock number (1 for blocks 1-90, 2 for blocks 91-180, etc)
        // NOT the block height! This matches save_macroblock which uses round_number
        let key = format!("macroblock_{}", macroblock_index);

        match self.db.get_cf(&microblocks_cf, key.as_bytes())? {
            Some(data) => Ok(Some(data)),
            None => Ok(None),
        }
    }

    /// Contiguous last-sealed-macroblock index (0 if none) — the TRUE seal frontier the production
    /// backpressure reads (never chain_height/90, the microblock tip, which can't bound a seal-stalled
    /// producer). Defined as the largest F with macroblock_1..F all present, derived here by scanning
    /// forward from the persisted hint (always <= F) and read-repairing the hint when it advances.
    /// Race-immune: a pure function of committed macroblocks with a single writer (this reader), so
    /// concurrent save_macroblock ordering cannot freeze it. Amortised O(1); one O(F) scan on cold cache.
    pub fn last_sealed_mb_index(&self) -> u64 {
        let metadata_cf = match self.db.cf_handle("metadata") { Some(cf) => cf, None => return 0 };
        let micro_cf = match self.db.cf_handle("microblocks") { Some(cf) => cf, None => return 0 };
        let hint = self.db.get_cf(&metadata_cf, b"last_sealed_mb").ok().flatten()
            .filter(|v| v.len() == 8)
            .map(|v| { let mut b = [0u8; 8]; b.copy_from_slice(&v[..8]); u64::from_le_bytes(b) })
            .unwrap_or(0);
        // Floor at the cold-join snapshot anchor: a snapshot-joined node holds NO sub-anchor macroblock
        // bodies (the anchor's 2f+1 QC finalized them in bulk), so contiguity is measured FROM the anchor,
        // not from 1 — otherwise the forward-scan finds macroblock_1 absent, reports 0, and disables seal
        // backpressure on every joined node. (metadata key snapshot_anchor = anchor_mb LE ++ hash.)
        let anchor = self.db.get_cf(&metadata_cf, b"snapshot_anchor").ok().flatten()
            .filter(|v| v.len() >= 8)
            .map(|v| { let mut b = [0u8; 8]; b.copy_from_slice(&v[..8]); u64::from_le_bytes(b) })
            .unwrap_or(0);
        let mut wm = hint.max(anchor);
        while self.db.get_cf(&micro_cf, format!("macroblock_{}", wm + 1).as_bytes())
            .ok().flatten().map_or(false, |v| !v.is_empty()) { wm += 1; }
        if wm > hint {
            let _ = self.db.put_cf(&metadata_cf, b"last_sealed_mb", &wm.to_le_bytes());
        }
        wm
    }
    
    /// PRODUCTION v2.45: Delete macroblock by index (for fork recovery)
    /// v9.0: Cleans ALL associated data: macroblock record + state/full/delta snapshots + IPFS ref.
    /// Key schema: macroblocks created at height = macroblock_index * 90.
    /// Snapshots use height-based keys: state_snap_{h}, full_snap_{h}, delta_{h}, ipfs_{h}.
    pub fn delete_macroblock(&self, macroblock_index: u64) -> IntegrationResult<()> {
        let microblocks_cf = self.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;

        let mut batch = rocksdb::WriteBatch::default();

        // Delete macroblock record
        let key = format!("macroblock_{}", macroblock_index);
        batch.delete_cf(&microblocks_cf, key.as_bytes());

        // v9.0: Delete ALL associated snapshot variants using correct key formats.
        // Macroblock at index N corresponds to microblock height N * 90.
        if let Some(snapshots_cf) = self.db.cf_handle("snapshots") {
            let height = macroblock_index * 90;
            // Delete all known snapshot key formats for this height
            batch.delete_cf(&snapshots_cf, format!("state_snap_{}", height).as_bytes());
            batch.delete_cf(&snapshots_cf, format!("full_snap_{}", height).as_bytes());
            batch.delete_cf(&snapshots_cf, format!("delta_{}", height).as_bytes());
            batch.delete_cf(&snapshots_cf, format!("ipfs_{}", height).as_bytes());
        }

        self.db.write(batch)?;

        if crate::node::is_info() {
            println!("[INFO][STORAGE] delete_mb idx={} h={} +snapshots", macroblock_index, macroblock_index * 90);
        }
        Ok(())
    }
    
    pub fn get_stats(&self) -> IntegrationResult<StorageStats> {
        let mut stats = StorageStats::default();
        
        // Get chain height
        stats.latest_height = self.get_chain_height()?;
        
        // Count blocks
        let block_cf = self.db.cf_handle("blocks")
            .ok_or_else(|| IntegrationError::StorageError("blocks column family not found".to_string()))?;
        let mut block_count = 0u64;
        let iter = self.db.iterator_cf(&block_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, _) = item?;
            if std::str::from_utf8(&key).unwrap_or("").starts_with("block_") {
                block_count += 1;
            }
        }
        stats.total_blocks = block_count;
        
        // Count transactions  
        let tx_cf = self.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        let mut tx_count = 0u64;
        let iter = self.db.iterator_cf(&tx_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, _) = item?;
            if std::str::from_utf8(&key).unwrap_or("").starts_with("tx_") {
                tx_count += 1;
            }
        }
        stats.total_transactions = tx_count;
        
        // Count accounts
        let accounts_cf = self.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut account_count = 0u64;
        let iter = self.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start);
        for _item in iter {
            account_count += 1;
        }
        stats.total_accounts = account_count;
        
        Ok(stats)
    }

    /// Save consensus round state for recovery after restart
    pub fn save_consensus_state(&self, round: u64, state: &[u8]) -> IntegrationResult<()> {
        let consensus_cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;

        let key = format!("round_{}", round);
        self.db.put_cf(&consensus_cf, key.as_bytes(), state)?;

        // Update latest round for quick lookup
        self.db.put_cf(&consensus_cf, b"latest_round", &round.to_be_bytes())?;

        Ok(())
    }

    /// Load consensus round state for recovery
    pub fn load_consensus_state(&self, round: u64) -> IntegrationResult<Option<Vec<u8>>> {
        let consensus_cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;

        let key = format!("round_{}", round);
        Ok(self.db.get_cf(&consensus_cf, key.as_bytes())?)
    }

    /// Get latest consensus round from storage
    pub fn get_latest_consensus_round(&self) -> IntegrationResult<u64> {
        let consensus_cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;

        match self.db.get_cf(&consensus_cf, b"latest_round")? {
            Some(bytes) => {
                let round = u64::from_be_bytes(bytes.try_into()
                    .map_err(|_| IntegrationError::StorageError("Invalid round data".to_string()))?);
                Ok(round)
            },
            None => Ok(0), // No consensus state saved yet
        }
    }

    // Timeout-certificate persistence. 2f+1 TimeoutCertificates and the
    // HIGHEST_CERTIFIED_ROUND tracker were RAM-only, so a restart
    // blanked them and the pre-save stale-primary guard malfunctioned for
    // the first seconds after reboot. Now write-through into the "consensus"
    // CF on every insert and rehydrated at startup before the
    // production loop. Keys: tcerts_v1 / hi_cert_v1 / hi_adopt_v1 (bincode
    // Vec). O(k) serialise, k = retention window (pruned per block).
    pub fn save_timeout_certificates(&self, payload: &[u8]) -> IntegrationResult<()> {
        let cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        self.db.put_cf(&cf, b"tcerts_v1", payload)?;
        Ok(())
    }

    pub fn load_timeout_certificates(&self) -> IntegrationResult<Option<Vec<u8>>> {
        let cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        Ok(self.db.get_cf(&cf, b"tcerts_v1")?)
    }

    pub fn save_highest_certified_rounds(&self, payload: &[u8]) -> IntegrationResult<()> {
        let cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        self.db.put_cf(&cf, b"hi_cert_v1", payload)?;
        Ok(())
    }

    pub fn load_highest_certified_rounds(&self) -> IntegrationResult<Option<Vec<u8>>> {
        let cf = self.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        Ok(self.db.get_cf(&cf, b"hi_cert_v1")?)
    }

    // `save_highest_adopted_rounds` / `load_highest_adopted_rounds` REMOVED with
    // the adopted-round tracker. Only TIMEOUT_CERTIFICATES (the 2f+1 supermajority
    // proof) and HIGHEST_CERTIFIED_ROUND are persisted — the hard finality evidence
    // that must survive restart. Any legacy "hi_adopt_v1" key on disk is harmless
    // stale bytes, ignored on boot — no migration needed.

    /// Save sync progress for resuming after restart
    pub fn save_sync_progress(&self, from_height: u64, to_height: u64, current: u64) -> IntegrationResult<()> {
        let sync_cf = self.db.cf_handle("sync_state")
            .ok_or_else(|| IntegrationError::StorageError("sync_state column family not found".to_string()))?;
        
        let data = bincode::serialize(&(from_height, to_height, current))
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        self.db.put_cf(&sync_cf, b"sync_progress", &data)?;
        Ok(())
    }
    
    /// Load sync progress for resuming
    pub fn load_sync_progress(&self) -> IntegrationResult<Option<(u64, u64, u64)>> {
        let sync_cf = self.db.cf_handle("sync_state")
            .ok_or_else(|| IntegrationError::StorageError("sync_state column family not found".to_string()))?;
        
        match self.db.get_cf(&sync_cf, b"sync_progress")? {
            Some(data) => {
                let progress = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(Some(progress))
            },
            None => Ok(None),
        }
    }
    
    /// Clear sync progress after completion
    pub fn clear_sync_progress(&self) -> IntegrationResult<()> {
        let sync_cf = self.db.cf_handle("sync_state")
            .ok_or_else(|| IntegrationError::StorageError("sync_state column family not found".to_string()))?;
        
        self.db.delete_cf(&sync_cf, b"sync_progress")?;
        Ok(())
    }
    
    /// Get microblock range for batch sync (raw format)
    /// NOTE: Use Storage::get_microblocks_range for network sync (it converts to full MicroBlock)
    pub async fn get_microblocks_range(&self, from: u64, to: u64) -> IntegrationResult<Vec<(u64, Vec<u8>)>> {
        let mut microblocks = Vec::new();
        
        for height in from..=to {
            if let Some(data) = self.load_microblock(height)? {
                microblocks.push((height, data));
            }
        }
        
        Ok(microblocks)
    }
    
    /// Legacy: Get block range for old Block format (only genesis)  
    pub async fn get_blocks_range(&self, from: u64, to: u64) -> IntegrationResult<Vec<qnet_state::Block>> {
        let mut blocks = Vec::new();
        
        for height in from..=to {
            if let Some(block) = self.load_block_by_height(height).await? {
                blocks.push(block);
            }
        }
        
        Ok(blocks)
    }

    /// Find transaction by hash in blockchain storage
    pub async fn find_transaction_by_hash(&self, tx_hash: &str) -> IntegrationResult<Option<qnet_state::Transaction>> {
        // PRODUCTION: Search for transaction in blockchain storage
        let tx_cf = self.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        
        let tx_key = format!("tx_{}", tx_hash);
        match self.db.get_cf(&tx_cf, tx_key.as_bytes())? {
            Some(data) => {
                // SIMPLIFIED (v2.19.10): Only Zstd compression used (lossless)
                // Pattern Recognition was removed because it was LOSSY
                
                // Strategy 1: Zstd-compressed (check magic number 0x28B52FFD)
                if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    let decompressed = zstd::decode_all(&data[..])
                        .map_err(|e| IntegrationError::Other(format!("Zstd decompression error: {}", e)))?;
                    let transaction: qnet_state::Transaction = bincode::deserialize(&decompressed)
                        .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                    return Ok(Some(transaction));
                }
                
                // Strategy 2: Uncompressed raw transaction (legacy data)
                let transaction: qnet_state::Transaction = bincode::deserialize(&data)
                    .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                Ok(Some(transaction))
            },
            None => {
                // Transaction not found in persistent storage
                Ok(None)
            }
        }
    }

    /// Get transaction block height from blockchain - O(1) with index
    pub async fn get_transaction_block_height(&self, tx_hash: &str) -> IntegrationResult<u64> {
        // OPTIMIZED: Use tx_index for O(1) lookup instead of O(n) iteration
        let tx_index_cf = self.db.cf_handle("tx_index")
            .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
        
        let tx_key = format!("tx_{}", tx_hash);
        match self.db.get_cf(&tx_index_cf, tx_key.as_bytes())? {
            Some(data) => {
                if data.len() >= 8 {
                    let height_bytes: [u8; 8] = data[0..8].try_into()
                        .map_err(|_| IntegrationError::StorageError("Invalid height data".to_string()))?;
                    Ok(u64::from_be_bytes(height_bytes))
                } else {
                    Err(IntegrationError::StorageError(format!("Invalid index data for transaction {}", tx_hash)))
                }
            },
            None => {
                // tx_index is the O(1) authority; a miss is an authoritative not-found.
                // No full-chain microblock scan (unbounded DoS amplifier on unknown hashes).
                Err(IntegrationError::StorageError(format!("Transaction {} not found in blockchain", tx_hash)))
            }
        }
    }
    
    /// Get transactions for an address (paginated, most recent first)
    pub async fn get_transactions_by_address(&self, address: &str, page: usize, per_page: usize) -> IntegrationResult<Vec<qnet_state::Transaction>> {
        let tx_by_addr_cf = self.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        let tx_cf = self.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        
        let prefix = format!("addr_{}_", address);
        
        // Iterate in reverse to get most recent first (keys are sorted by timestamp)
        let iter = self.db.iterator_cf(
            &tx_by_addr_cf,
            rocksdb::IteratorMode::From(
                format!("{}~", prefix).as_bytes(), // ~ is after hex digits in ASCII
                rocksdb::Direction::Reverse
            )
        );
        
        let mut transactions = Vec::new();
        let skip = page * per_page;
        let mut count = 0;
        let mut seen_hashes = std::collections::HashSet::new();
        
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if !key_str.starts_with(&prefix) {
                break;
            }
            
            // Get tx_hash from value
            let tx_hash = std::str::from_utf8(&value).unwrap_or("");
            
            // Deduplicate (same tx may appear twice if from==to)
            if seen_hashes.contains(tx_hash) {
                continue;
            }
            seen_hashes.insert(tx_hash.to_string());
            
            count += 1;
            if count <= skip {
                continue;
            }
            
            // Fetch full transaction (with Zstd decompression if needed)
            let tx_key = format!("tx_{}", tx_hash);
            if let Some(tx_data) = self.db.get_cf(&tx_cf, tx_key.as_bytes())? {
                // PRODUCTION: Decompress if Zstd compressed
                let decompressed = if tx_data.len() >= 4 && tx_data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    zstd::decode_all(&tx_data[..]).unwrap_or_else(|_| tx_data.to_vec())
                } else {
                    tx_data.to_vec()
                };
                
                if let Ok(tx) = bincode::deserialize::<qnet_state::Transaction>(&decompressed) {
                    transactions.push(tx);
                    if transactions.len() >= per_page {
                        break;
                    }
                }
            }
        }
        
        Ok(transactions)
    }

    /// Index a block's success-gated token-transfer events (P1). Canonical row stored once under
    /// `xfer_{height}_{log_index}`; from/to/contract pointer keys give O(hits) reverse prefix seeks.
    /// Reuses the tx_by_address CF (prefix-isolated), off-consensus. Idempotent per (height,log_index):
    /// a reorg re-apply overwrites the same keys.
    pub fn index_token_transfers(&self, rows: &[TokenTransferRow]) -> IntegrationResult<()> {
        if rows.is_empty() { return Ok(()); }
        let cf = self.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        let mut batch = WriteBatch::default();
        for r in rows {
            let canon = format!("xfer_{:016x}_{:08x}", r.height, r.log_index);
            let val = serde_json::to_vec(r)
                .map_err(|e| IntegrationError::StorageError(format!("xfer serialize: {}", e)))?;
            batch.put_cf(&cf, canon.as_bytes(), &val);
            if !r.from.is_empty() {
                batch.put_cf(&cf, format!("xfeadr_{}_{:016x}_{:08x}", xfer_seg(&r.from), r.height, r.log_index).as_bytes(), canon.as_bytes());
            }
            if !r.to.is_empty() {
                batch.put_cf(&cf, format!("xfeadr_{}_{:016x}_{:08x}", xfer_seg(&r.to), r.height, r.log_index).as_bytes(), canon.as_bytes());
            }
            batch.put_cf(&cf, format!("xfectr_{}_{:016x}_{:08x}", xfer_seg(&r.contract), r.height, r.log_index).as_bytes(), canon.as_bytes());
        }
        self.db.write(batch)?;
        Ok(())
    }

    /// Reverse (newest-first) prefix read of decoded transfer rows. `before` = the
    /// `{height:016x}_{log_index:08x}` cursor of the last row already seen (None ⇒ newest). Bounded by
    /// `limit` — a fixed O(limit) seek regardless of an address's lifetime volume.
    pub(super) fn read_token_transfers(&self, prefix: &str, limit: usize, before: Option<&str>) -> Vec<TokenTransferRow> {
        let cf = match self.db.cf_handle("tx_by_address") { Some(c) => c, None => return Vec::new() };
        let seek = match before {
            Some(c) => format!("{}{}", prefix, c),
            None => format!("{}~", prefix),
        };
        let iter = self.db.iterator_cf(&cf, rocksdb::IteratorMode::From(seek.as_bytes(), rocksdb::Direction::Reverse));
        let mut out = Vec::new();
        for item in iter {
            let (key, value) = match item { Ok(kv) => kv, Err(_) => break };
            let ks = match std::str::from_utf8(&key) { Ok(s) => s, Err(_) => break };
            if !ks.starts_with(prefix) { break; }
            // reverse-From starts AT an existing key — skip the cursor row itself.
            if let Some(c) = before { if &ks[prefix.len()..] == c { continue; } }
            if let Ok(Some(v)) = self.db.get_cf(&cf, &value) {
                if let Ok(row) = serde_json::from_slice::<TokenTransferRow>(&v) { out.push(row); }
            }
            if out.len() >= limit { break; }
        }
        out
    }

    /// Decoded token transfers where `address` is the sender OR recipient (newest first).
    pub fn get_token_transfers_by_address(&self, address: &str, limit: usize, before: Option<&str>) -> Vec<TokenTransferRow> {
        self.read_token_transfers(&format!("xfeadr_{}_", xfer_seg(address)), limit, before)
    }
    /// Decoded token transfers for one contract (newest first).
    pub fn get_token_transfers_by_contract(&self, contract: &str, limit: usize, before: Option<&str>) -> Vec<TokenTransferRow> {
        self.read_token_transfers(&format!("xfectr_{}_", xfer_seg(contract)), limit, before)
    }

    /// Decoded token transfers in the height range [from,to] (block order) — for explorer ingestion.
    /// Forward-scans only the canonical `xfer_` rows (pointer prefixes xfeadr_/xfectr_ sort before it).
    /// `after` = the `{height:016x}_{log_index:08x}` cursor of the last row already returned (None ⇒
    /// start of range); the scan resumes strictly AFTER it, so a single height holding more than `limit`
    /// events pages cleanly instead of silently dropping the tail. Returns (rows, truncated); truncated
    /// ⇒ another in-range row exists past this page (caller re-requests with `after` = last row's cursor).
    pub fn get_token_transfers_in_range(&self, from: u64, to: u64, limit: usize, after: Option<&str>) -> (Vec<TokenTransferRow>, bool) {
        let cf = match self.db.cf_handle("tx_by_address") { Some(c) => c, None => return (Vec::new(), false) };
        // Seek at max(from, cursor): keys are zero-padded hex so lexical order == height order. Clamping
        // to `from` stops a client-supplied cursor below `from` from forcing an unbounded pre-`from` scan.
        let from_start = format!("xfer_{:016x}_", from);
        let start = match after {
            Some(c) => { let ac = format!("xfer_{}", c); if ac > from_start { ac } else { from_start } }
            None => from_start,
        };
        let iter = self.db.iterator_cf(&cf, rocksdb::IteratorMode::From(start.as_bytes(), rocksdb::Direction::Forward));
        let mut out = Vec::new();
        let mut truncated = false;
        for item in iter {
            let (key, value) = match item { Ok(kv) => kv, Err(_) => break };
            let ks = match std::str::from_utf8(&key) { Ok(s) => s, Err(_) => break };
            if !ks.starts_with("xfer_") { break; }
            let row = match serde_json::from_slice::<TokenTransferRow>(&value) { Ok(r) => r, Err(_) => continue };
            if row.height > to { break; }
            if row.height < from { continue; }
            if let Some(c) = after { if &ks["xfer_".len()..] == c { continue; } } // skip the cursor row itself
            if out.len() >= limit { truncated = true; break; } // an in-range row remains past the page
            out.push(row);
        }
        (out, truncated)
    }

    /// Stage (into `batch`) deletes for every token-transfer index row (canonical + from/to/contract
    /// pointers) at one height. Caller commits — so the guard delete rides the SAME atomic batch.
    pub(super) fn stage_clear_token_transfers_at_height(&self, height: u64, batch: &mut WriteBatch) {
        let cf = match self.db.cf_handle("tx_by_address") { Some(c) => c, None => return };
        let prefix = format!("xfer_{:016x}_", height);
        let iter = self.db.iterator_cf(&cf, rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward));
        for item in iter {
            let (key, value) = match item { Ok(kv) => kv, Err(_) => break };
            if !std::str::from_utf8(&key).map(|s| s.starts_with(&prefix)).unwrap_or(false) { break; }
            if let Ok(r) = serde_json::from_slice::<TokenTransferRow>(&value) {
                let suffix = format!("{:016x}_{:08x}", r.height, r.log_index);
                if !r.from.is_empty() { batch.delete_cf(&cf, format!("xfeadr_{}_{}", xfer_seg(&r.from), suffix).as_bytes()); }
                if !r.to.is_empty() { batch.delete_cf(&cf, format!("xfeadr_{}_{}", xfer_seg(&r.to), suffix).as_bytes()); }
                batch.delete_cf(&cf, format!("xfectr_{}_{}", xfer_seg(&r.contract), suffix).as_bytes());
            }
            batch.delete_cf(&cf, &key);
        }
    }

    /// Reorg-consistency: if height `h` was applied before (blocklogs_h present), wipe its block_logs +
    /// token index so a re-applied replacement block fully overwrites BOTH — critical because gate-0
    /// logs_root is consensus-committed and pointer rows are address-keyed (never height-overwritten).
    /// The index clear AND the guard delete ride ONE atomic WriteBatch (RocksDB batches span CFs), so no
    /// crash window can disarm the guard while stale pointer rows survive. Fresh forward height = cheap miss.
    pub fn reset_block_token_data(&self, height: u64) {
        let key = format!("blocklogs_{:010}", height);
        let root_key = format!("blocklogsroot_{:010}", height);
        // Fire if EITHER the logs blob OR the sub-root is present. A partial persist (one written, the
        // other's save failed) must still be fully cleared before a re-applied block — else a stale
        // sub-root survives a log-reducing reorg and the seal folds a WRONG window root vs peers.
        let present = matches!(self.db.get(key.as_bytes()), Ok(Some(_)))
            || matches!(self.db.get(root_key.as_bytes()), Ok(Some(_)));
        if present {
            let mut batch = WriteBatch::default();
            self.stage_clear_token_transfers_at_height(height, &mut batch);
            batch.delete(key.as_bytes()); // default-CF guard key, atomic with the index deletes above
            batch.delete(root_key.as_bytes()); // drop the stale sub-root too
            if let Err(e) = self.db.write(batch) {
                if crate::node::is_warn() {
                    println!("[WARN][LOGS] reset_block_token_data h={} err={} (reorg re-index may leave stale pointers until next reset)", height, e);
                }
            }
        }
    }

    /// Retention: delete token-transfer index rows below `prune_before` (mirrors the tx_by_address /
    /// blocklogs prune). Canonical rows are height-prefixed so the scan is bounded to the aged range;
    /// capped per call so a backlog drains across cycles. Returns rows removed.
    pub fn prune_token_transfers_below(&self, prune_before: u64) -> usize {
        let cf = match self.db.cf_handle("tx_by_address") { Some(c) => c, None => return 0 };
        let end = format!("xfer_{:016x}_", prune_before);
        // Resume from the last-pruned height (watermark) rather than genesis, so a cycle doesn't re-skip
        // rows it already deleted (RocksDB tombstones linger until compaction). Everything below the
        // watermark is finalized+pruned, so no live row is skipped.
        let wm = self.db.get(b"token_prune_wm").ok().flatten()
            .and_then(|v| std::str::from_utf8(&v).ok().and_then(|s| s.parse::<u64>().ok())).unwrap_or(0);
        let start = format!("xfer_{:016x}_", wm);
        let iter = self.db.iterator_cf(&cf, rocksdb::IteratorMode::From(start.as_bytes(), rocksdb::Direction::Forward));
        let mut batch = WriteBatch::default();
        let mut n = 0usize;
        let mut last_h = wm;
        for item in iter {
            let (key, value) = match item { Ok(kv) => kv, Err(_) => break };
            let ks = match std::str::from_utf8(&key) { Ok(s) => s, Err(_) => break };
            if !ks.starts_with("xfer_") || ks.as_bytes() >= end.as_bytes() { break; }
            if let Ok(r) = serde_json::from_slice::<TokenTransferRow>(&value) {
                last_h = r.height;
                let suffix = format!("{:016x}_{:08x}", r.height, r.log_index);
                if !r.from.is_empty() { batch.delete_cf(&cf, format!("xfeadr_{}_{}", xfer_seg(&r.from), suffix).as_bytes()); }
                if !r.to.is_empty() { batch.delete_cf(&cf, format!("xfeadr_{}_{}", xfer_seg(&r.to), suffix).as_bytes()); }
                batch.delete_cf(&cf, format!("xfectr_{}_{}", xfer_seg(&r.contract), suffix).as_bytes());
            }
            batch.delete_cf(&cf, &key);
            n += 1;
            if n >= 50_000 { break; }
        }
        if n > 0 {
            // Fully drained the range ⇒ advance to prune_before; capped mid-range ⇒ resume at last height.
            let new_wm = if n >= 50_000 { last_h } else { prune_before };
            batch.put(b"token_prune_wm", new_wm.to_string().as_bytes());
            let _ = self.db.write(batch);
        }
        n
    }

    /// Count transactions for an address
    pub async fn count_transactions_by_address(&self, address: &str) -> IntegrationResult<usize> {
        let tx_by_addr_cf = self.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        
        let prefix = format!("addr_{}_", address);
        let iter = self.db.iterator_cf(&tx_by_addr_cf, rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward));
        
        let mut count = 0;
        let mut seen_hashes = std::collections::HashSet::new();
        
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if !key_str.starts_with(&prefix) {
                break;
            }
            
            let tx_hash = std::str::from_utf8(&value).unwrap_or("");
            if !seen_hashes.contains(tx_hash) {
                seen_hashes.insert(tx_hash.to_string());
                count += 1;
            }
        }
        
        Ok(count)
    }
    
    /// Get recent transactions globally (paginated, newest first)
    /// Uses tx_by_address CF which stores addr_{address}_{timestamp}_{tx_hash}
    /// By iterating in reverse, we get newest transactions first
    pub async fn get_recent_transactions(&self, page: usize, per_page: usize) -> IntegrationResult<(Vec<qnet_state::Transaction>, usize)> {
        let tx_by_addr_cf = self.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        let tx_cf = self.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        
        // Iterate in reverse to get newest transactions first
        let iter = self.db.iterator_cf(&tx_by_addr_cf, rocksdb::IteratorMode::End);
        
        let mut transactions = Vec::new();
        let mut seen_hashes = std::collections::HashSet::new();
        let skip_count = page.saturating_sub(1) * per_page;
        let mut skipped = 0;
        let mut total_count = 0;
        
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            // Only process addr_* keys
            if !key_str.starts_with("addr_") {
                continue;
            }
            
            let tx_hash = std::str::from_utf8(&value).unwrap_or("");
            
            // Skip duplicates (same TX can appear twice - from and to)
            if seen_hashes.contains(tx_hash) {
                continue;
            }
            seen_hashes.insert(tx_hash.to_string());
            total_count += 1;
            
            // Pagination: skip previous pages
            if skipped < skip_count {
                skipped += 1;
                continue;
            }
            
            // Already have enough for this page
            if transactions.len() >= per_page {
                continue; // Keep counting total but don't load more
            }
            
            // Load transaction
            let tx_key = format!("tx_{}", tx_hash);
            if let Some(tx_data) = self.db.get_cf(&tx_cf, tx_key.as_bytes())? {
                // Decompress if needed
                let decompressed = zstd::decode_all(tx_data.as_slice())
                    .unwrap_or_else(|_| tx_data.to_vec());
                
                if let Ok(tx) = bincode::deserialize::<qnet_state::Transaction>(&decompressed) {
                    transactions.push(tx);
                }
            }
        }
        
        Ok((transactions, total_count))
    }
    
    /// Count total transactions in the blockchain
    pub async fn count_total_transactions(&self) -> IntegrationResult<usize> {
        let tx_index_cf = self.db.cf_handle("tx_index")
            .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
        
        let iter = self.db.iterator_cf(&tx_index_cf, rocksdb::IteratorMode::Start);
        let count = iter.count();
        
        Ok(count)
    }
}

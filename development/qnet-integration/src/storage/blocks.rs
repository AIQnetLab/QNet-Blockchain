//! Block and microblock persistence, macroblocks, hash index and network-size estimates.

use super::*;

impl Storage {
    pub fn new(data_dir: &str) -> IntegrationResult<Self> {
        let persistent = PersistentStorage::new(data_dir)?;
        let transaction_pool = TransactionPool::new();
        
        // Detect node type from environment or config
        // v3.18: Full nodes removed - default to "super" (server node) if not specified
        let node_type = std::env::var("QNET_NODE_TYPE").unwrap_or_else(|_| "super".to_string());
        
        // DYNAMIC SHARD CALCULATION: Automatically scales with network growth
        // Uses existing calculate_optimal_shards() from reward_sharding module
        // NOTE: Shard count is calculated ONCE at startup and remains fixed during operation
        // This ensures storage consistency. Recalculation happens on node restart/update.
        // Production workflow: Rolling restart updates shard count across network.
        let _active_shards = if let Ok(manual_shards) = std::env::var("QNET_ACTIVE_SHARDS") {
            // Manual override for testing or specific deployment needs
            manual_shards.parse::<u64>().unwrap_or_else(|_| {
                let network_size = Self::estimate_network_size_from_storage(&persistent);
                crate::reward_sharding::calculate_optimal_shards(network_size) as u64
            })
        } else {
            // AUTO-DETECTION: Calculate based on blockchain registry and heuristics
            let network_size = Self::estimate_network_size_from_storage(&persistent);
            let optimal_shards = crate::reward_sharding::calculate_optimal_shards(network_size) as u64;
            
            if crate::node::is_debug() {
                println!("[DBG][STORAGE] auto_scaling optimal_shards={}", optimal_shards);
            }
            
            optimal_shards
        };
        
        // TIERED STORAGE CONFIGURATION (v3.18+ — only two roles).
        // ============================================================================
        // - Light: ZERO on-device chain storage. Mobile-only pure API client.
        //          No blocks, no headers, no certs in RocksDB. All chain data
        //          accessed via REST API on Super nodes; wallet app stores
        //          user TX history in AsyncStorage / localStorage. The
        //          `max_storage_gb` and `base_window` values below are
        //          legacy parameters retained for the tuple shape and a
        //          minimal RocksDB footprint (CF metadata, no chain data);
        //          actual chain-data writes are no-ops — see
        //          `StorageTierConfig::light()` and the `StorageMode::Light`
        //          branch in `save_microblock` further down this file.
        // - Super/Bootstrap: Full blocks, NO pruning (~2TB, complete history).
        // ============================================================================

        let (storage_mode, max_storage_gb, base_window, tier_config) = match node_type.to_lowercase().as_str() {
            "light" => (
                StorageMode::Light,
                1,      // legacy field — chain storage is disabled; this only sizes
                        // the RocksDB CF metadata footprint on mobile (≈ few MB).
                1_000,  // legacy field — Light never persists chain blocks; this
                        // value is unused at runtime (StorageMode::Light branch
                        // in save_microblock is a no-op).
                StorageTierConfig::light()
            ),
            // v3.18: "full" maps to Super for backward compatibility
            "full" | "super" | "bootstrap" => (
                StorageMode::Super, 
                2000, // ~2 TB
                0, // No pruning - keep EVERYTHING (archival)
                StorageTierConfig::super_node()
            ),
            _ => {
                println!("[WARN][STORAGE] unknown_node_type type={} default=super", node_type);
                (
                    StorageMode::Super, 
                    2000, 
                    0,
                    StorageTierConfig::super_node()
                )
            }
        };
        
        // Log tiered storage configuration (v3.18: only Light and Super)
        let (mode_name, storage_desc) = match storage_mode {
            StorageMode::Light => ("light", "mobile_api_client_no_chain_storage"),
            StorageMode::Super => ("super", "full_history_archival ~2TB"),
        };
        println!("[INFO][STORAGE] config mode={} storage={} pruning_window={}",
                 mode_name, storage_desc, tier_config.pruning_window_blocks);

        // v3.18: Only Light and Super modes — no sliding-window scaling needed.
        // Super nodes keep everything; Light nodes store no chain data at all,
        // so the `sliding_window` value below is unused on Light at runtime.
        let sliding_window = base_window;
        
        // Allow override via environment
        let max_storage_size = std::env::var("QNET_MAX_STORAGE_GB")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(max_storage_gb) * 1024 * 1024 * 1024;
            
        let sliding_window_size = std::env::var("QNET_SLIDING_WINDOW")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(sliding_window);
            
        println!("[WARN][STORAGE] Node configured as {:?} mode:", storage_mode);
        println!("[WARN][STORAGE]    Max storage: {} GB", max_storage_size / (1024 * 1024 * 1024));
        println!("[WARN][STORAGE]    Sliding window: {} blocks", 
                if sliding_window_size == u64::MAX { "unlimited".to_string() } else { sliding_window_size.to_string() });
        
        // SAFETY WARNING: Check aggressive pruning settings
        // v3.18: Aggressive pruning check (only for Light nodes, Super nodes are archival)
        let aggressive_pruning_enabled = std::env::var("QNET_AGGRESSIVE_PRUNING")
            .unwrap_or_else(|_| "0".to_string()) == "1";
        
        if aggressive_pruning_enabled && storage_mode == StorageMode::Light {
            let super_node_count = Self::estimate_super_node_count();
            let min_safe_super_nodes = 50u64;
            
            println!("[WARN][STORAGE] aggressive_pruning_enabled super_nodes={} min_required={}", 
                     super_node_count, min_safe_super_nodes);
            println!("This Full node will delete microblocks immediately after finalization!");
            println!("");
            println!("Network Status:");
            println!("  Super nodes in network: {}", super_node_count);
            println!("  Recommended minimum: {}", min_safe_super_nodes);
            
            if super_node_count < min_safe_super_nodes {
                println!("");
                println!("[WARN][STORAGE] CRITICAL: Network safety at RISK!");
                println!("   Not enough Super nodes to maintain full blockchain archive.");
                println!("   Aggressive pruning will be AUTOMATICALLY DISABLED during macroblock finalization.");
                println!("   Consider setting QNET_AGGRESSIVE_PRUNING=0 until network grows.");
            } else {
                println!("");
                println!("[INFO][STORAGE] network_safety=ok super_nodes={} maintains_archive=true", super_node_count);
                println!("   Aggressive pruning is safe but irreversible.");
                println!("   You will depend on Super nodes for historical data.");
            }
            println!("");
        }
        
        let pattern_recognizer = PatternRecognizer {
            pattern_stats: HashMap::new(),
        };
        
        // Initialize graceful degradation manager
        let graceful_degradation = GracefulDegradation::new(storage_mode);
        
        // Initialize the deprecated light-node header-rotation buffer.
        // Light tier is now a pure-API-client role (zero on-device chain
        // storage), so this buffer is a no-op in production — kept only
        // for backward-compat field presence. See `LightNodeRotation`
        // docstring above for the deprecation note.
        let light_rotation = LightNodeRotation::new(tier_config.pruning_window_blocks);
            
        // Wipe the reward-aggregation scratch: pure per-process working space, so anything present is
        // debris from a build that crashed. Cleared at open, before any build can read it.
        if let Some(cf) = persistent.db.cf_handle("reward_agg") {
            let mut b = WriteBatch::default();
            b.delete_range_cf(&cf, b"rag_".as_ref(), b"rah_".as_ref());
            let _ = persistent.db.write(b);
        }

        Ok(Self { 
            persistent,
            transaction_pool,
            max_storage_size,
            current_storage_usage: Arc::new(RwLock::new(0)),
            emergency_cleanup_enabled: true,
            storage_mode,
            sliding_window_size,
            pattern_recognizer: Arc::new(RwLock::new(pattern_recognizer)),
            tier_config,
            graceful_degradation: Arc::new(RwLock::new(graceful_degradation)),
            light_rotation: Arc::new(RwLock::new(light_rotation)),
            recent_microblocks: Arc::new(dashmap::DashMap::new()),
        })
    }
    
    pub fn get_chain_height(&self) -> IntegrationResult<u64> {
        self.persistent.get_chain_height()
    }
    
    /// Set chain height to a specific value (for fork resolution)
    pub fn set_chain_height(&self, height: u64) -> IntegrationResult<()> {
        self.persistent.set_chain_height(height)
    }
    
    /// DATA CONSISTENCY: Reset chain height to 0 (wrapper for persistent storage)
    pub fn reset_chain_height(&self) -> IntegrationResult<()> {
        self.persistent.reset_chain_height()
    }

    
    pub fn get_block_hash(&self, height: u64) -> IntegrationResult<Option<String>> {
        self.persistent.get_block_hash(height)
    }
    
    pub async fn save_block(&self, block: &qnet_state::Block) -> IntegrationResult<()> {
        // Check if storage is critically full before accepting new blocks
        if self.is_storage_critically_full()? {
            // Try emergency cleanup first
            println!("[WARN][STORAGE] Storage critically full - attempting emergency cleanup before save_block");
            self.emergency_cleanup()?;
            
            // Re-check after cleanup
            if self.is_storage_critically_full()? {
                return Err(IntegrationError::StorageError(
                    "Cannot save block: Storage is critically full even after emergency cleanup. Increase QNET_MAX_STORAGE_GB or add more disk space.".to_string()
                ));
            }
        }
        
        self.persistent.save_block(block).await
    }
    
    pub async fn load_block_by_height(&self, height: u64) -> IntegrationResult<Option<qnet_state::Block>> {
        self.persistent.load_block_by_height(height).await
    }
    
    /// See `SaveOutcome`. The apply-success branch feeds consensus accumulators (window content,
    /// finalized round) and the serve horizon, none of which may advance for a block that is not on
    /// disk, so anything other than `Stored` must not be treated as a commit.
    pub fn save_microblock(&self, height: u64, data: &[u8]) -> IntegrationResult<SaveOutcome> {
        // =====================================================================
        // v3.23: ROLLBACK PROTECTION - Check before any save operation
        // =====================================================================
        // Prevents race condition where parallel block receive overwrites rollback.
        // During rollback, blocks with height > target are silently skipped.
        // They will be re-requested after rollback completes.
        // =====================================================================
        if !can_save_block(height) {
            let (_in_progress, target) = get_rollback_status();
            println!("[WARN][STORAGE] block_save_blocked h={} rollback_target={}", height, target);
            return Ok(SaveOutcome::DeclinedRollback);
        }

        // L4 storage-level anti-fork guard (last line of defence). Forensic
        // h=174582: two different blocks saved at the same height on
        // different nodes; the pre-v15.11 presence-only check let the second
        // save silently no-op instead of detecting the equivocation. Now:
        // compute the canonical hash of the incoming MicroBlock (SHA3-256
        // over height+ts+prev_hash+merkle_root+producer) and compare to the
        // stored one — equal → idempotent silent OK; unequal → EQUIVOCATION,
        // record slashing evidence + REJECT; undeserialisable → legacy
        // presence fallback. Makes a divergent storage fork impossible on an
        // honest node. Pairs with producer L3, network L5 majority-wins, L6
        // slashing. O(1)/save; evidence bounded by the retention sweep.
        let incoming_block: Option<qnet_state::MicroBlock> =
            bincode::deserialize::<qnet_state::MicroBlock>(data).ok();
        let incoming_hash: Option<[u8; 32]> = incoming_block.as_ref().map(|mb| mb.hash());

        if let Ok(Some(existing_hash)) = self.persistent.load_microblock_hash(height) {
            match incoming_hash {
                Some(new_hash) if new_hash == existing_hash => {
                    // Idempotent re-save (peer broadcast / production race
                    // converged on the same canonical block). Silent OK.
                    if crate::node::is_info() {
                        println!("[INFO][STORAGE] dedup_blocked h={} (idempotent re-save, hash={:x?})",
                                 height, &new_hash[..8]);
                    }
                    return Ok(SaveOutcome::Stored); // already durable at this height
                }
                Some(new_hash) => {
                    // EQUIVOCATION — different block at the same height. Capture unforgeable
                    // proof headers from BOTH blocks (the incoming one is rejected here and
                    // never reaches storage) for the on-chain slashing TX, then reject.
                    let new_producer = incoming_block.as_ref()
                        .map(|mb| mb.producer.clone())
                        .unwrap_or_else(|| "unknown".to_string());

                    if crate::node::is_warn() {
                        println!(
                            "[ERR][FORK] equivocation_attempt h={} existing_hash={:x?} new_hash={:x?} new_producer={} action=reject_save_record_evidence",
                            height,
                            &existing_hash[..8],
                            &new_hash[..8],
                            new_producer,
                        );
                    }

                    // Record only when BOTH full blocks are in hand (they are at L4 — incoming
                    // in hand, existing re-loaded). The proof is self-validating (offender's sigs).
                    //
                    // MUST go through the format-aware loader. `load_microblock` returns the raw CF
                    // bytes, which a Super node writes as a possibly-compressed EfficientMicroBlock
                    // (format byte 0x02) — decoding those as a MicroBlock fails on EVERY block, so
                    // this was always None and the whole block-equivocation slashing path was dead:
                    // the guard rejected the variant and then silently dropped the evidence.
                    let existing_mb = self.load_microblock_auto_format(height).ok().flatten();
                    if let (Some(inc), Some(exist)) = (incoming_block.as_ref(), existing_mb.as_ref()) {
                        // Slashable equivocation requires the SAME producer to have signed BOTH
                        // blocks. Two DIFFERENT producers at one height is a failover/rotation
                        // race (honest liveness, resolved by round-based fork-choice) — rejected
                        // here but NEVER slashed.
                        if inc.producer == exist.producer {
                            let to_header = |mb: &qnet_state::MicroBlock| qnet_state::EquivocationHeader {
                                timestamp: mb.timestamp,
                                merkle_root: mb.merkle_root,
                                previous_hash: mb.previous_hash,
                                state_root: mb.state_root,
                                vrf_output: mb.vrf_output,
                                timeout_round: mb.timeout_round,
                                carried_baseline: mb.carried_baseline,
                                // Blocker-3: capture the signed pk_digest so the on-chain proof re-verify
                                // reconstructs the SAME Block_Sig_v23.1 digest as the producer.
                                pk_digest: crate::node::microblock_pk_digest(&mb.transactions),
                                signature: mb.signature.clone(),
                            };
                            crate::node::record_block_equivocation(height, &new_producer, to_header(exist), to_header(inc));
                        } else if crate::node::is_warn() {
                            println!(
                                "[WARN][FORK] same_height_distinct_producers h={} existing={} incoming={} action=reject_no_slash(failover_race)",
                                height, exist.producer, inc.producer,
                            );
                        }
                    }

                    // NON-DESTRUCTIVE: retain the competing block as a branch before refusing it the
                    // canonical slot. Its bytes are keyed by hash, so it displaces nothing and stays
                    // available to fork-choice. Previously they were dropped here, which is why a
                    // reorg had to re-download the winner it had just been handed.
                    if let Some(ref inc) = incoming_block {
                        self.retain_branch_block(inc, data);
                    }
                    return Err(IntegrationError::StorageError(format!(
                        "fork_conflict h={} existing_hash={:x?} new_hash={:x?} producer={}",
                        height,
                        &existing_hash[..8],
                        &new_hash[..8],
                        new_producer,
                    )));
                }
                None => {
                    // Could not deserialize incoming bytes (rare legacy path).
                    // Fall back to presence-only behaviour to avoid breaking
                    // raw-bytes fallback callers; log so the operator can
                    // investigate the format mismatch.
                    if crate::node::is_warn() {
                        println!(
                            "[WARN][STORAGE] dedup_presence_only h={} reason=incoming_undeserializable",
                            height,
                        );
                    }
                    return Ok(SaveOutcome::Stored); // a block is present at this height
                }
            }
        }

        // Parent linkage is an invariant of the STORE, not of the pipeline. Every writer (gossip
        // apply, sync batch, solicited repair, producer self-save) passes here, so enforcing it at
        // this boundary makes a parentless block unpersistable regardless of which upstream cache
        // or check went stale. Runs AFTER the dedup/equivocation block so an idempotent re-save
        // still short-circuits and same-height equivocation evidence is still recorded. A
        // present-but-mismatched parent is the orphan case; an ABSENT parent is left to the caller
        // (pruned history, snapshot cold-join, backfill).
        if let Some(ref mb) = incoming_block {
            // The anchor exemption exists for the ONE block that follows a promoted snapshot, whose
            // parent this node never held. Scope it to the cold-join window (chain still at/below the
            // anchor); once the chain has moved past it, that height is ordinary and must be checked.
            let anchor_h = crate::node::SNAPSHOT_ANCHOR_MB
                .load(std::sync::atomic::Ordering::Acquire).saturating_mul(90);
            let anchor_successor = anchor_h > 0
                && height == anchor_h + 1
                && self.persistent.get_chain_height().unwrap_or(0) <= anchor_h;
            if height > 0 && !anchor_successor {
                // The named parent must be the block CANONICALLY occupying the preceding slot.
                // Asking merely "do we hold this hash?" is a tautology — the claimed hash answers
                // for itself — and would admit a child of any retained branch. Absent canonical
                // parent stays permitted (pruned history / cold-join / backfill); a canonical
                // parent that does NOT match is the orphan case and is rejected.
                let canonical_parent = self.persistent.load_microblock_hash(height - 1).ok().flatten();
                if canonical_parent.map(|p| p != mb.previous_hash).unwrap_or(false) {
                    println!(
                        "[ERR][STORAGE] unlinked_block_rejected h={} producer={} parent_claimed={:x?}",
                        height, mb.producer, &mb.previous_hash[..8]
                    );
                    return Err(IntegrationError::StorageError(format!(
                        "unlinked_block h={} parent_mismatch", height
                    )));
                }
            }
        }

        // =====================================================================
        // TIERED STORAGE + GRACEFUL DEGRADATION (v2.19.9)
        // =====================================================================
        // This method now includes:
        // 1. Storage health check with graceful degradation
        // 2. Tiered storage based on node type (Light / Super)
        // 3. Light-node short-circuit: writes are no-ops (pure API client,
        //    no on-device chain storage). All chain-data persistence below
        //    runs only on Super nodes.
        // =====================================================================
        
        // Step 1: Check for graceful degradation (every 100 blocks to reduce overhead)
        if height % 100 == 0 {
            let _ = self.check_and_apply_degradation();
        }
        
        // Step 2: Check if storage is critically full
        if self.is_storage_critically_full()? {
            println!("[WARN][STORAGE] Storage critically full - attempting emergency cleanup");
            self.emergency_cleanup()?;
            
            // If still full after cleanup, try graceful degradation
            if self.is_storage_critically_full()? {
                // Force degradation check
                let _ = self.check_and_apply_degradation();
                
                // If STILL full after degradation, error out
                if self.is_storage_critically_full()? && self.get_effective_storage_mode() == StorageMode::Light {
                return Err(IntegrationError::StorageError(
                        "Cannot save microblock: Storage full even after degradation to Light mode. Add disk space!".to_string()
                    ));
                }
            }
        }
        
        // Step 3: Use effective storage mode (may be degraded)
        let effective_mode = self.get_effective_storage_mode();
        
        match effective_mode {
            StorageMode::Light => {
                // ═══════════════════════════════════════════════════════════════════════════
                // LIGHT MODE (v3.19): Pure API client - NO local storage
                // ═══════════════════════════════════════════════════════════════════════════
                // Light nodes (mobile wallets) do NOT store ANY blockchain data!
                // They are pure API clients like Phantom wallet:
                //
                // - Balance: GET /api/v1/balance/{wallet}
                // - TX history: GET /api/v1/address/{wallet}
                // - Send TX: POST /api/v1/transaction
                //
                // The wallet app (qnet-mobile, qnet-wallet) stores user's TX history
                // in its own localStorage/AsyncStorage - NOT in RocksDB!
                //
                // This function should NEVER be called for Light nodes in production.
                // If called, just ignore - Light nodes don't participate in sync.
                // ═══════════════════════════════════════════════════════════════════════════
                Ok(SaveOutcome::NotStoredMode) // a light node holds no blocks
            },
            StorageMode::Super => {
                // SUPER MODE: Full block storage with EfficientMicroBlock format
                if let Ok(microblock) = bincode::deserialize::<qnet_state::MicroBlock>(data) {
                    return self.save_microblock_efficient(height, &microblock).map(|_| SaveOutcome::Stored);
                }
                
                // Fallback: Apply adaptive compression to raw data
        let compressed_data = if height > 0 {
            self.compress_block_adaptive(data, height)?
        } else {
            data.to_vec()
        };
        
        self.persistent.save_microblock(height, &compressed_data).map(|_| SaveOutcome::Stored)
            }
        }
    }
    
    /// PRODUCTION: Save microblock in efficient format with separate TX storage
    /// This is the PRIMARY storage method for new blocks (v2.19.8+)
    /// 
    /// Architecture:
    /// - EfficientMicroBlock (hashes only) → microblocks CF (~3-6 KB/block)
    /// - Full transactions → transactions CF with Zstd-3 (~30-50% reduction)
    /// - TX indices → tx_index, tx_by_address CFs
    /// 
    /// Storage savings: ~80% compared to legacy MicroBlock format
    pub(super) fn save_microblock_efficient(&self, height: u64, microblock: &qnet_state::MicroBlock) -> IntegrationResult<()> {
        let tx_cf = self.persistent.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        let tx_index_cf = self.persistent.db.cf_handle("tx_index")
            .ok_or_else(|| IntegrationError::StorageError("tx_index column family not found".to_string()))?;
        let tx_by_addr_cf = self.persistent.db.cf_handle("tx_by_address")
            .ok_or_else(|| IntegrationError::StorageError("tx_by_address column family not found".to_string()))?;
        
        let mut batch = WriteBatch::default();
        let mut tx_hashes: Vec<[u8; 32]> = Vec::with_capacity(microblock.transactions.len());
        let mut total_original_size = 0usize;
        let mut total_compressed_size = 0usize;
        
        // Step 1: Save each transaction with PATTERN RECOGNITION + Zstd compression
        // Pattern Recognition provides 80-95% compression for common TX types
        for tx in &microblock.transactions {
            // v2.72: Use transaction's own hash (BLAKE3) for consistency with lookups
            // Previously we computed SHA3(bincode) which didn't match tx.hash
            // This caused find_transaction_by_hash() to fail for system TX
            let tx_hash_str = &tx.hash; // Already computed by tx.calculate_hash()
            
            // Convert to [u8; 32] for EfficientMicroBlock
            let tx_hash_bytes: [u8; 32] = {
                let decoded = hex::decode(tx_hash_str).unwrap_or_else(|_| vec![0u8; 32]);
                let mut arr = [0u8; 32];
                let len = decoded.len().min(32);
                arr[..len].copy_from_slice(&decoded[..len]);
                arr
            };
            tx_hashes.push(tx_hash_bytes);
            
            let tx_key = format!("tx_{}", tx_hash_str);
            
            // Serialize original transaction for size tracking
            let tx_data = bincode::serialize(tx)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            total_original_size += tx_data.len();
            
            // COMPRESSION: Use Zstd-3 for all transactions (lossless, ~50% reduction)
            // NOTE: Pattern Recognition was removed in v2.19.10 because it was LOSSY
            // - SimpleTransfer: 140→16 bytes BUT could not be reconstructed!
            // - find_transaction_by_hash() would fail for pattern-compressed TX
            // Zstd-3 provides good compression (~50%) while remaining fully lossless
            
            // Track pattern for statistics only (no lossy compression)
            let pattern = self.recognize_transaction_pattern(tx);
            {
                let mut recognizer = self.pattern_recognizer.write();
                *recognizer.pattern_stats.entry(pattern).or_insert(0) += 1;
            }
            
            // LOSSLESS: Always use Zstd-3 compression
            let compressed_tx = zstd::encode_all(&tx_data[..], 3)
                .unwrap_or_else(|_| tx_data.clone());
            
            total_compressed_size += compressed_tx.len();
            batch.put_cf(&tx_cf, tx_key.as_bytes(), &compressed_tx);
            
            // INDEX: tx_hash -> block_height for O(1) transaction location
            batch.put_cf(&tx_index_cf, tx_key.as_bytes(), &height.to_be_bytes());
            
            // INDEX: address -> tx_hash. HEIGHT-stamped for the same reason as the sibling writer:
            // the retention scan cuts on this field and tx.timestamp is author-supplied.
            let stamp = height;
            let from_key = format!("addr_{}_{:016x}_{}", tx.from, stamp, tx_hash_str);
            batch.put_cf(&tx_by_addr_cf, from_key.as_bytes(), tx_hash_str.as_bytes());
            
            // Index 'to' address (if present, including system addresses)
            let to_addr = tx.to.as_ref().map(|s| s.as_str()).unwrap_or(&tx.from);
            let to_key = format!("addr_{}_{:016x}_{}", to_addr, stamp, tx_hash_str);
            batch.put_cf(&tx_by_addr_cf, to_key.as_bytes(), tx_hash_str.as_bytes());

            // QRC-20/721 counterparties are indexed from the success-gated transfer EVENTS
            // (build_token_transfer_rows), not from calldata intent — see the token_transfers index.
        }
        
        // Log pattern compression results (every 100 blocks)
        if height % 100 == 0 && total_original_size > 0 {
            let tx_savings = (1.0 - total_compressed_size as f64 / total_original_size as f64) * 100.0;
            println!("[INFO][STORAGE] tx_compression h={} original_bytes={} compressed_bytes={} reduction_pct={:.1}",
                     height, total_original_size, total_compressed_size, tx_savings);
        }
        
        // Step 2: Create EfficientMicroBlock with hashes only (+ VRF)
        let efficient_block = qnet_state::EfficientMicroBlock {
            height: microblock.height,
            timestamp: microblock.timestamp,
            transaction_hashes: tx_hashes,
            producer: microblock.producer.clone(),
            signature: microblock.signature.clone(),
            previous_hash: microblock.previous_hash,
            merkle_root: microblock.merkle_root,
            // Quantum Randomness Beacon (QRB) v3.0
            vrf_output: microblock.vrf_output,
            vrf_proof: microblock.vrf_proof.clone(),
            // v3.18: Copy fees_collected for producer rewards
            fees_collected: microblock.fees_collected,
            // v3.27: State root for verification
            state_root: microblock.state_root,
            // v14.0: Timeout round for producer authority proof
            timeout_round: microblock.timeout_round,
            carried_baseline: microblock.carried_baseline,
        };
        
        // Serialize EfficientMicroBlock (much smaller than full MicroBlock)
        let efficient_data = bincode::serialize(&efficient_block)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;

        // Apply adaptive compression to EfficientMicroBlock
        let compressed_block = self.compress_block_adaptive(&efficient_data, height)?;

        // v9.0: Single atomic WriteBatch for ALL data: TXs + block header + chain_height.
        // Previously these were separate writes; a crash between any two left orphaned data
        // (TXs without a header, a header without its block).
        // Now: everything in ONE WriteBatch for crash-safe atomicity.
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks CF not found".to_string()))?;
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;
        let block_key = mb_body_key(height);

        // v12.0: Compute block hash from STRUCT FIELDS (MicroBlock::hash()), not raw bytes.
        // Block hash is a consensus property: SHA3(height + timestamp + prev_hash + merkle_root + producer).
        // Raw bytes depend on storage format (EfficientMicroBlock, zstd) and must NOT affect consensus hash.
        let block_hash = microblock.hash();
        let hash_key = mb_hash_key(height);

        // v12.1: Format discriminator — explicit metadata key eliminates bincode guessing.
        // On load, load_microblock_auto_format checks this key to know the exact format,
        // instead of trying both MicroBlock/EfficientMicroBlock deserializations.
        // Key: microblock_fmt_{height} → 0x02 (EfficientMicroBlock)
        let fmt_key = mb_fmt_key(height);

        batch.put_cf(&microblocks_cf, block_key.as_bytes(), &compressed_block);
        batch.put_cf(&metadata_cf, b"chain_height", &height.to_be_bytes());
        batch.put_cf(&metadata_cf, hash_key.as_bytes(), block_hash.as_slice());
        batch.put_cf(&metadata_cf, fmt_key.as_bytes(), &[0x02u8]); // 0x02 = EfficientMicroBlock
        // Header + child link written in the SAME batch as the body, so the hash-addressed view can
        // never disagree with the height view. The BODY is deliberately NOT duplicated under its
        // hash: a canonical block is reachable as alias → height → body, and duplicating ~10 KB per
        // block would double on-disk growth (0.6 → 1.2 GB/day/node). Only a block refused the
        // canonical slot gets a hash-keyed body copy (retain_branch_block) — that set is tiny and
        // is pruned at finality.
        let hdr = BlockHeaderIdx {
            height,
            previous_hash: microblock.previous_hash,
            producer: microblock.producer.clone(),
            state_root: microblock.state_root,
            timestamp: microblock.timestamp,
            tx_count: microblock.transactions.len() as u32,
        };
        if let Ok(hdr_bytes) = bincode::serialize(&hdr) {
            batch.put_cf(&metadata_cf, &block_header_key(&block_hash), &hdr_bytes);
        }
        batch.put_cf(&metadata_cf, &block_child_key(&microblock.previous_hash, &block_hash), &[]);
        // v32.7: WAL-disabled during catch-up for ~10× apply throughput.
        // Periodic flush every 500 blocks bounds at-risk window on crash.
        if crate::node::FAST_SYNC_IN_PROGRESS.load(std::sync::atomic::Ordering::Relaxed) {
            let mut wopts = rocksdb::WriteOptions::default();
            wopts.disable_wal(true);
            self.persistent.db.write_opt(batch, &wopts)?;
            if height % 500 == 0 {
                let _ = self.persistent.db.flush();
            }
        } else {
            self.persistent.db.write(batch)?;
        }

        // Log savings for monitoring (every 100 blocks)
        if height % 100 == 0 {
            let original_size = bincode::serialize(microblock).unwrap_or_default().len();
            let efficient_size = compressed_block.len();
            let savings = (1.0 - efficient_size as f64 / original_size as f64) * 100.0;
            println!("[INFO][STORAGE] efficient_block h={} original_bytes={} stored_bytes={} reduction_pct={:.1} txs_separate={}",
                     height, original_size, efficient_size, savings, microblock.transactions.len());
        }
        
        Ok(())
    }
    
    pub fn load_microblock(&self, height: u64) -> IntegrationResult<Option<Vec<u8>>> {
        self.persistent.load_microblock(height)
    }

    /// v32.7: durable flush — used by fast-sync exit path to persist
    /// WAL-disabled writes accumulated during catch-up.
    pub fn flush_db(&self) {
        let _ = self.persistent.db.flush();
    }

    /// v10.2: O(1) microblock hash lookup from index.
    /// Returns stored block hash without loading/decompressing the full block.
    pub fn load_microblock_hash(&self, height: u64) -> IntegrationResult<Option<[u8; 32]>> {
        self.persistent.load_microblock_hash(height)
    }

    /// Canonical anchor-hash accessor for Heartbeat TXs: hex of the microblock CONSENSUS hash at
    /// `height`, via the backfilling microblock-hash index — NOT get_block_hash, which reads the
    /// full-block "blocks" CF that microblocks never populate (it returns None for EVERY microblock
    /// anchor, silently breaking Heartbeat emission AND verification). Single source of truth so the
    /// emitter, every anchor consumer agrees on the format by construction.
    pub fn get_microblock_hash_hex(&self, height: u64) -> IntegrationResult<Option<String>> {
        Ok(self.load_microblock_hash(height)?.map(hex::encode))
    }

    /// v10.2: Save a hash index entry (used for backfilling during validation fallback).
    pub fn save_microblock_hash(&self, height: u64, hash: &[u8]) -> IntegrationResult<()> {
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;
        let hash_key = mb_hash_key(height);
        self.persistent.db.put_cf(&metadata_cf, hash_key.as_bytes(), hash)?;
        Ok(())
    }

    /// v10.2: Migrate existing blocks to hash index.
    /// Called once at startup if migration flag not set.
    /// Builds hash index for all existing microblocks.
    pub fn migrate_microblock_hash_index(&self) -> IntegrationResult<u64> {
        use crate::node::is_info;

        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata CF not found".to_string()))?;

        // Check if migration already completed
        if let Some(flag) = self.persistent.db.get_cf(&metadata_cf, b"hash_index_migrated")? {
            if flag == b"1" {
                if is_info() {
                    println!("[INFO][STORAGE] hash_index_migration already_complete");
                }
                return Ok(0);
            }
        }

        let chain_height = self.get_chain_height().unwrap_or(0);
        if chain_height == 0 {
            self.persistent.db.put_cf(&metadata_cf, b"hash_index_migrated", b"1")?;
            return Ok(0);
        }

        println!("[INFO][STORAGE] hash_index_migration start blocks=0..{}", chain_height);

        let mut indexed = 0u64;
        let mut batch_count = 0u64;
        let mut batch = rocksdb::WriteBatch::default();

        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks CF not found".to_string()))?;

        for h in 0..=chain_height {
            let block_key = mb_body_key(h);
            if let Some(data) = self.persistent.db.get_cf(&microblocks_cf, block_key.as_bytes())? {
                // v12.0: Deserialize block and compute consensus hash from struct fields.
                // Block hash = SHA3(height + timestamp + prev_hash + merkle_root + producer).
                // Raw bytes depend on storage format (bincode, zstd) — NOT a consensus property.
                let decompressed = if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    zstd::decode_all(&data[..]).unwrap_or_else(|_| data.to_vec())
                } else {
                    data.to_vec()
                };
                let block_hash = if let Ok(mb) = bincode::deserialize::<qnet_state::MicroBlock>(&decompressed) {
                    if mb.height == h { mb.hash() } else { continue; }
                } else if let Ok(eb) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&decompressed) {
                    if eb.height == h { eb.hash() } else { continue; }
                } else {
                    println!("[WARN][STORAGE] hash_index_migration_skip h={} reason=deserialize_failed", h);
                    continue;
                };
                let hash_key = mb_hash_key(h);
                batch.put_cf(&metadata_cf, hash_key.as_bytes(), &block_hash);
                indexed += 1;
                batch_count += 1;

                // Flush every 1000 blocks to limit memory usage
                if batch_count >= 1000 {
                    self.persistent.db.write(batch)?;
                    batch = rocksdb::WriteBatch::default();
                    batch_count = 0;
                    if h % 10000 == 0 {
                        println!("[INFO][STORAGE] hash_index_migration progress h={}/{} indexed={}", h, chain_height, indexed);
                    }
                }
            }
        }

        // Flush remaining + set migration flag
        batch.put_cf(&metadata_cf, b"hash_index_migrated", b"1");
        self.persistent.db.write(batch)?;

        println!("[INFO][STORAGE] hash_index_migration complete indexed={} total={}", indexed, chain_height);
        Ok(indexed)
    }

    /// Delete a microblock at the specified height (for fork resolution).
    /// v9.0: Also cleans up TX indices to prevent orphaned data.
    pub fn delete_microblock(&self, height: u64) -> IntegrationResult<()> {
        if crate::node::is_info() {
            println!("[INFO][STORAGE] delete_microblock h={}", height);
        }

        // v9.0: Load block BEFORE deletion to get TX hashes for index cleanup.
        // If block is in EfficientMicroBlock format, tx_hashes are directly available.
        // If load fails, still delete the block (orphaned indices are less bad than orphaned blocks).
        if let Ok(Some(block)) = self.load_microblock_auto_format(height) {
            let tx_cf = self.persistent.db.cf_handle("transactions");
            let tx_index_cf = self.persistent.db.cf_handle("tx_index");
            if let (Some(tx_cf), Some(tx_index_cf)) = (tx_cf, tx_index_cf) {
                let mut cleanup_batch = rocksdb::WriteBatch::default();
                for tx in &block.transactions {
                    let tx_key = format!("tx_{}", tx.hash);
                    cleanup_batch.delete_cf(&tx_cf, tx_key.as_bytes());
                    cleanup_batch.delete_cf(&tx_index_cf, tx_key.as_bytes());
                }
                if !block.transactions.is_empty() {
                    if let Err(e) = self.persistent.db.write(cleanup_batch) {
                        eprintln!("[WARN][STORAGE] tx_index_cleanup_failed h={} err={}", height, e);
                    }
                }
            }
        }

        // Delete the block header
        self.persistent.delete_microblock(height)
    }
    
    /// Delete a range of microblocks atomically (for fork resolution).
    /// FIX R23-S2: Single WriteBatch for blocks + TX indices + metadata.
    /// Crash-safe: either all deleted or none. Previously TX index cleanup was
    /// in separate batches, leaving orphaned indices on crash between batches.
    pub fn delete_microblocks_range(&self, from_height: u64, to_height: u64) -> IntegrationResult<u64> {
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")
            .ok_or_else(|| IntegrationError::StorageError("microblocks column family not found".to_string()))?;
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let tx_cf = self.persistent.db.cf_handle("transactions");
        let tx_index_cf = self.persistent.db.cf_handle("tx_index");

        let mut batch = rocksdb::WriteBatch::default();
        let mut count: u64 = 0;

        for h in from_height..=to_height {
            // Include TX index cleanup in the SAME atomic batch
            if let (Some(tx_cf), Some(tx_index_cf)) = (&tx_cf, &tx_index_cf) {
                if let Ok(Some(block)) = self.load_microblock_auto_format(h) {
                    for tx in &block.transactions {
                        let tx_key = format!("tx_{}", tx.hash);
                        batch.delete_cf(tx_cf, tx_key.as_bytes());
                        batch.delete_cf(tx_index_cf, tx_key.as_bytes());
                    }
                }
            }

            // Block data + metadata + hash + the hash-addressed index rows. Dropping the body while
            // keeping its header would leave a stale oracle that re-admits an orphan — the exact
            // shape of the h=54059 incident, with the header index standing in for the RAM cache.
            let key = mb_body_key(h);
            let hash_key = mb_hash_key(h);
            note_body_delete(h);
            if let Ok(Some(existing)) = self.persistent.load_microblock_hash(h) {
                if let Some(prev) = self.persistent.header_index(&existing).map(|hd| hd.previous_hash) {
                    batch.delete_cf(&metadata_cf, &block_child_key(&prev, &existing));
                }
                batch.delete_cf(&metadata_cf, &block_header_key(&existing));
            }
            batch.delete_cf(&microblocks_cf, key.as_bytes());
            batch.delete_cf(&metadata_cf, hash_key.as_bytes());

            count += 1;
        }

        self.persistent.db.write(batch)?;
        Ok(count)
    }

    /// Hash of the most recently stored macroblock.
        
    pub fn get_latest_macroblock_hash(&self) -> Result<[u8; 32], IntegrationError> {
        self.persistent.get_latest_macroblock_hash()
    }
    
    /// Get macroblock by its index (height / 90)
    pub fn get_macroblock_by_height(&self, macroblock_index: u64) -> IntegrationResult<Option<Vec<u8>>> {
        self.persistent.get_macroblock_by_height(macroblock_index)
    }
    
    /// PRODUCTION v2.45: Delete macroblock by index (for fork recovery)
    pub fn delete_macroblock(&self, macroblock_index: u64) -> IntegrationResult<()> {
        self.persistent.delete_macroblock(macroblock_index)
    }
    
    /// Save checkpoint block for Progressive Finalization
    pub async fn save_checkpoint(&self, height: u64, block: &qnet_state::MacroBlock) -> Result<(), String> {
        // Serialize and save as checkpoint
        let serialized = bincode::serialize(block)
            .map_err(|e| format!("Failed to serialize checkpoint: {}", e))?;
        
        let key = format!("checkpoint_{}", height);
        self.persistent.db.put(key, serialized)
            .map_err(|e| format!("Failed to save checkpoint: {}", e))?;
        
        println!("[INFO][STORAGE] checkpoint_saved h={}", height);
        Ok(())
    }
    
    /// Set a flag in storage (for emergency/critical markers)
    pub fn set_flag(&self, key: &str, value: bool) -> Result<(), String> {
        let flag_value = if value { vec![1u8] } else { vec![0u8] };
        self.persistent.db.put(key, flag_value)
            .map_err(|e| format!("Failed to set flag {}: {}", key, e))
    }
    
    /// Save data with a custom key
    pub fn save_data<T: serde::Serialize>(&self, key: &str, data: &T) -> Result<(), String> {
        let serialized = bincode::serialize(data)
            .map_err(|e| format!("Failed to serialize data: {}", e))?;
        
        self.persistent.db.put(key, serialized)
            .map_err(|e| format!("Failed to save data: {}", e))
    }
    
    
    pub async fn save_macroblock(&self, height: u64, macroblock: &qnet_state::MacroBlock) -> IntegrationResult<()> {
        // Check if storage is critically full before accepting new macroblocks
        if self.is_storage_critically_full()? {
            println!("[WARN][STORAGE] storage_critically_full action=emergency_cleanup_before_save_macroblock");
            self.emergency_cleanup()?;
            
            if self.is_storage_critically_full()? {
                return Err(IntegrationError::StorageError(
                    "Cannot save macroblock: Storage is critically full. Increase QNET_MAX_STORAGE_GB.".to_string()
                ));
            }
        }
        
        // Save the macroblock
        self.persistent.save_macroblock(height, macroblock).await?;
        
        // SECURITY: macroblock state_root = real account-state Merkle root at the window
        // head (head microblock's state_root). Cross-checks the 2f+1-signed checkpoint root
        // against this node's own computed state. Skip if the head microblock isn't local yet
        // (out-of-order sync) — microblock apply verifies its own state_root independently.
        {
            let head_h = height * 90;
            if let Ok(Some(head_mb)) = self.load_microblock_auto_format(head_h) {
                if head_mb.state_root != macroblock.state_root {
                    return Err(IntegrationError::StorageError(
                        format!("macroblock state_root mismatch at window {}: macroblock {:?} vs window-head h={} {:?}",
                                height, macroblock.state_root, head_h, head_mb.state_root)
                    ));
                }
            }
        }
        // NOTE: Account state snapshots are saved separately by emission/rewards processing
        // (node.rs) as Vec<(String, Account)>. Previously this path incorrectly saved
        // serialized MacroBlock data into state_snap keys, causing deserialization failures
        // on node restart (bincode expected Vec<(String,Account)> but got MacroBlock).
        
        // Storage strategy: Super/Genesis = archival (keep all microblocks
        // forever, serve sync, ~500MB-1GB/day); Light = pure API client, no
        // local storage (never reaches save_macroblock). New Super nodes
        // bootstrap via snapshot (download latest → restore accounts → sync
        // only snapshot_height..current).
        
        let is_genesis = std::env::var("QNET_BOOTSTRAP_ID").is_ok();
        
        // Super/Genesis: ARCHIVAL - keep all microblocks for network sync
        if is_genesis && macroblock.height % 1000 == 0 {
            println!("[INFO][STORAGE] archival_mode node_type=genesis height={}", macroblock.height);
        }
        // NO PRUNING - Super nodes are archival!
        
        Ok(())
    }
    
    /// Public wrapper for network size estimation (used by node configuration)
    pub fn estimate_network_size_for_config(&self) -> usize {
        Self::estimate_network_size_from_storage(&self.persistent)
    }
    
    /// Estimate total network size for dynamic shard calculation
    /// Uses multi-source detection: blockchain, environment, heuristics
    pub(super) fn estimate_network_size_from_storage(persistent: &PersistentStorage) -> usize {
        // Priority 1: Explicit network size from monitoring/orchestration
        if let Ok(size_str) = std::env::var("QNET_TOTAL_NETWORK_NODES") {
            if let Ok(size) = size_str.parse::<usize>() {
                println!("[INFO][STORAGE] network_size_from_monitoring nodes={}", size);
                return size;
            }
        }
        
        // Priority 2: Genesis phase detection (5 bootstrap nodes)
        if std::env::var("QNET_BOOTSTRAP_ID").is_ok() {
            println!("[INFO][STORAGE] genesis_phase bootstrap_nodes=5");
            return 5;
        }
        
        // Priority 3: Read actual node activations from blockchain storage
        if let Some(activations_cf) = persistent.db.cf_handle("activations") {
            let mut count = 0;
            let iter = persistent.db.iterator_cf(activations_cf, rocksdb::IteratorMode::Start);
            for _ in iter {
                count += 1;
            }
            
            if count > 0 {
                println!("[INFO][STORAGE] blockchain_registry activated_nodes={}", count);
                return count;
            }
        }
        
        // Priority 4: Conservative default (small network assumption)
        println!("[WARN][STORAGE] no_network_data default_nodes=100");
        100 // Conservative: assume small network to avoid over-sharding
    }
    
    /// Estimate Super node count in the network (conservative approximation)
    /// Used for safety checks before aggressive pruning
    pub(super) fn estimate_super_node_count() -> u64 {
        // Try to get from environment (set by monitoring/stats system)
        if let Ok(count_str) = std::env::var("QNET_SUPER_NODE_COUNT") {
            if let Ok(count) = count_str.parse::<u64>() {
                return count;
            }
        }
        
        // Conservative estimation based on network phase
        let bootstrap_id = std::env::var("QNET_BOOTSTRAP_ID").ok();
        
        if bootstrap_id.is_some() {
            // Genesis phase: 5 bootstrap Super nodes
            5
        } else {
            // Production: Conservative estimate based on total network size
            // In real deployment, this would query P2P or consensus layer
            // For now, return safe default that allows aggressive pruning
            50 // Assume mature network has enough Super nodes
        }
    }
    
}

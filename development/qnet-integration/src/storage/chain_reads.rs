//! Range reads, the branch tree below finality, body decoding and format migration.

use super::*;

impl Storage {
    /// Get microblocks range for batch sync  
    /// CRITICAL: Returns full MicroBlock format for network sync (not EfficientMicroBlock)
    /// This ensures receiving nodes can deserialize blocks with full transaction data
    pub async fn get_microblocks_range(&self, from: u64, to: u64) -> IntegrationResult<Vec<(u64, Vec<u8>)>> {
        let mut microblocks = Vec::new();
        
        // Get RocksDB column family for transactions
        let tx_cf = self.persistent.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        
        for height in from..=to {
            if let Some(raw_data) = self.load_microblock(height)? {
                // CRITICAL: Convert EfficientMicroBlock back to full MicroBlock for network sync
                // First try to deserialize as EfficientMicroBlock (new format)
                if let Ok(efficient_block) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&raw_data) {
                    // Reconstruct full MicroBlock with transactions from PERSISTENT storage
                    let mut transactions = Vec::with_capacity(efficient_block.transaction_hashes.len());
                    
                    for tx_hash in &efficient_block.transaction_hashes {
                        let tx_hash_hex = hex::encode(tx_hash);
                        
                        // First try in-memory cache for speed
                        if let Some(tx) = self.transaction_pool.get_transaction(tx_hash) {
                            transactions.push(tx);
                            continue;
                        }
                        
                        // Fallback to persistent RocksDB storage
                        let tx_key = format!("tx_{}", tx_hash_hex);
                        if let Ok(Some(data)) = self.persistent.db.get_cf(&tx_cf, tx_key.as_bytes()) {
                            // Decompress if Zstd-compressed
                            let tx_data = if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                                zstd::decode_all(&data[..]).unwrap_or(data.to_vec())
                            } else {
                                data.to_vec()
                            };
                            
                            if let Ok(tx) = bincode::deserialize::<qnet_state::Transaction>(&tx_data) {
                                // Cache for future use
                                let _ = self.transaction_pool.store_transaction(*tx_hash, tx.clone());
                                transactions.push(tx);
                            }
                        }
                    }
                    
                    // Create full MicroBlock (including QRB VRF data)
                    let full_block = qnet_state::MicroBlock {
                        height: efficient_block.height,
                        timestamp: efficient_block.timestamp,
                        transactions,
                        producer: efficient_block.producer,
                        signature: efficient_block.signature,
                        previous_hash: efficient_block.previous_hash,
                        merkle_root: efficient_block.merkle_root,
                        // QRB v3.0: VRF fields
                        vrf_output: efficient_block.vrf_output,
                        vrf_proof: efficient_block.vrf_proof,
                        // v3.18: Direct fee collection
                        fees_collected: efficient_block.fees_collected,
                        // v3.27: State root for verification
                        state_root: efficient_block.state_root,
                        // v14.0: Timeout round for producer authority
                        timeout_round: efficient_block.timeout_round,
                        carried_baseline: efficient_block.carried_baseline,
                        // #80: proof lives on the wire (gossip ingest); local read never re-adopts.
                        timeout_proof: None,
                    };
                    
                    // Serialize as full MicroBlock for network transmission
                    let full_data = bincode::serialize(&full_block)
                        .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                    
                    microblocks.push((height, full_data));
                } else {
                    // Already in MicroBlock format (legacy) - use as-is
                    microblocks.push((height, raw_data));
                }
            } else {
                // Stop at the first gap: serve only the contiguous prefix so a requester never gets a
                // sparse batch that hides a missing height (it applies the prefix, repairs the gap elsewhere).
                break;
            }
        }

        Ok(microblocks)
    }
    
    /// Legacy: Get blocks range for old Block format
    pub async fn get_blocks_range(&self, from: u64, to: u64) -> IntegrationResult<Vec<qnet_state::Block>> {
        self.persistent.get_blocks_range(from, to).await
    }
    
    /// Get transaction pool statistics
    pub fn get_transaction_pool_stats(&self) -> IntegrationResult<(usize, usize)> {
        self.transaction_pool.get_stats()
    }
    
    // =========================================================================
    // MACROBLOCK SYNC METHODS (PRODUCTION v2.19.12)
    // =========================================================================
    
    /// Get macroblocks range for batch sync
    /// PRODUCTION: Returns serialized MacroBlock data for network transmission
    /// 
    /// Architecture:
    /// - Macroblocks are indexed by INDEX (not height): index 1 = blocks 1-90
    /// - Max 10 macroblocks per batch (~1MB max)
    /// - Decompresses if stored compressed
    pub async fn get_macroblocks_range(&self, from_index: u64, to_index: u64) -> IntegrationResult<Vec<(u64, Vec<u8>)>> {
        let mut macroblocks = Vec::new();
        
        // SCALABILITY: Limit to 10 macroblocks per batch
        let actual_to = if to_index > from_index && to_index.saturating_sub(from_index) > 10 {
            from_index.saturating_add(9)
        } else {
            to_index
        };
        
        for index in from_index..=actual_to {
            if let Some(raw_data) = self.get_macroblock_by_height(index)? {
                // Decompress if needed (Zstd magic bytes check)
                let data = if raw_data.len() >= 4 && raw_data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    zstd::decode_all(&raw_data[..]).unwrap_or(raw_data)
                } else {
                    raw_data
                };
                
                // Verify it's a valid MacroBlock before sending, and that it still carries the
                // signatures the requester's verify needs — past the retention horizon it does not,
                // and serving it would look like a forged QC rather than an absent one.
                match bincode::deserialize::<qnet_state::MacroBlock>(&data) {
                    Ok(mb) if Self::macroblock_carries_qc_sigs(&mb) => macroblocks.push((index, data)),
                    Ok(_) => println!("[INFO][STORAGE] macroblock_qc_pruned index={} action=serve_absent", index),
                    Err(_) => println!("[WARN][STORAGE] invalid_macroblock_data index={}", index),
                }
            }
        }
        
        println!("[INFO][STORAGE] macroblock_sync_prepared count={} indices={}-{}", 
                 macroblocks.len(), from_index, actual_to);
        
        Ok(macroblocks)
    }
    
    /// Get the latest macroblock index
    /// PRODUCTION: Used to determine sync target
    pub fn get_latest_macroblock_index(&self) -> IntegrationResult<u64> {
        let chain_height = self.get_chain_height()?;
        if chain_height == 0 {
            Ok(0)
        } else {
            // Macroblock index = (height / 90), but only if that macroblock is complete
            let complete_macroblocks = chain_height / 90;
            Ok(complete_macroblocks)
        }
    }

    /// Contiguous last-sealed-macroblock index — the seal frontier for production backpressure.
    pub fn last_sealed_mb_index(&self) -> u64 {
        self.persistent.last_sealed_mb_index()
    }
    
    /// Load microblock with automatic format detection.
    /// v12.1: Uses `microblock_fmt_{height}` metadata key for deterministic format selection.
    /// Falls back to try-both logic for blocks saved before v12.1 (backward compat).
    /// Handles Zstd compression transparently.
    /// v27 HOLE3: warm cache post-apply. No-op during rollback; prunes
    /// above rollback target + beyond window (never serves stale height).
    pub fn cache_recent_microblock(&self, height: u64, mb: &qnet_state::MicroBlock) {
        let (rb_in_progress, rb_target) = get_rollback_status();
        if rb_in_progress {
            self.recent_microblocks.retain(|&h, _| h <= rb_target);
            return;
        }
        self.recent_microblocks.insert(height, Arc::new(mb.clone()));
        let floor = height.saturating_sub(RECENT_MB_CACHE_CAP);
        if floor > 0 {
            self.recent_microblocks.retain(|&h, _| h >= floor);
        }
    }

    /// Canonical hash occupying a slot, if any.
    pub fn canonical_hash_at(&self, height: u64) -> Option<[u8; 32]> {
        self.persistent.load_microblock_hash(height).ok().flatten()
    }

    /// What occupies a slot. `Burned` is a legal, permanent answer once slots are exclusive: a
    /// silent leader's slot is never filled by anyone. Callers must treat it as "move on", not as
    /// a gap to repair — conflating the two is what turns a skipped slot into a stall.
    pub fn slot_status(&self, height: u64) -> SlotStatus {
        match self.canonical_hash_at(height) {
            Some(h) => SlotStatus::Block(h),
            None => SlotStatus::Unknown,
        }
    }

    /// Load a body by its hash, directly from the hash-keyed store. No height is involved, so a
    /// non-canonical sibling is just as loadable as the canonical block — which is what fork-choice
    /// needs in order to compare branches rather than delete one of them.
    pub fn load_body_by_hash(&self, hash: &[u8; 32]) -> Option<qnet_state::MicroBlock> {
        let microblocks_cf = self.persistent.db.cf_handle("microblocks")?;
        match self.persistent.db.get_cf(&microblocks_cf, &block_body_key(hash)).ok()? {
            // Content addressing is only a guarantee if it is checked: a hash-keyed read must
            // return a body that actually hashes to the key, otherwise a corrupted or mis-keyed
            // row silently becomes "the block with that hash".
            Some(raw) => self.decode_stored_body(&raw).filter(|b| b.hash() == *hash),
            // Pre-hash-store blocks (written before this layout) still resolve through the height view.
            None => {
                let hdr = self.header_by_hash(hash)?;
                let body = self.load_microblock_auto_format(hdr.height).ok()??;
                if body.hash() == *hash { Some(body) } else { None }
            }
        }
    }

    /// Drop retained branches at or below `finalized_height`. Finality is 2f+1-irreversible, so a
    /// non-canonical block at a finalized height can never be adopted and only costs space. The
    /// canonical block is identified by the alias and is always kept — this is the ONLY place
    /// allowed to remove a body, which is what bounds the tree without weakening the store.
    pub fn prune_branches_below_finality(&self, finalized_height: u64) -> u64 {
        let (microblocks_cf, metadata_cf) = match (
            self.persistent.db.cf_handle("microblocks"),
            self.persistent.db.cf_handle("metadata"),
        ) {
            (Some(a), Some(b)) => (a, b),
            _ => return 0,
        };
        let mut batch = WriteBatch::default();
        let mut pruned = 0u64;
        // Markers retired without a body delete (the branch became canonical). Counted separately
        // so the batch is still written when every entry below finality is a winner — otherwise
        // those markers accumulate forever and, since the scan always restarts at brn_0, every
        // later finality advance re-walks them, turning this back into an O(chain) scan.
        let mut retired = 0u64;
        // Range-scan the BRANCH index only: its size is the number of retained forks, not the
        // length of the chain. Scanning every block header instead would make each finality
        // advance O(chain length) — unusable once the chain is millions of blocks long.
        let start = format!("brn_{:020}_", 0);
        let end_excl = format!("brn_{:020}_", finalized_height.saturating_add(1));
        let iter = self.persistent.db.iterator_cf(
            &metadata_cf,
            rocksdb::IteratorMode::From(start.as_bytes(), rocksdb::Direction::Forward),
        );
        for item in iter.flatten() {
            let (k, _) = item;
            if !k.starts_with(b"brn_") { break; }
            if k.as_ref() >= end_excl.as_bytes() { break; } // past the finality floor — still live
            if k.len() != 4 + 20 + 1 + 32 { continue; }
            let height: u64 = match std::str::from_utf8(&k[4..24]).ok().and_then(|s| s.parse().ok()) {
                Some(h) => h, None => continue,
            };
            let mut hash = [0u8; 32];
            hash.copy_from_slice(&k[25..]);
            // Keep whatever the canonical alias points at; drop only the losing siblings.
            if self.canonical_hash_at(height) == Some(hash) {
                batch.delete_cf(&metadata_cf, &k[..]); // it won — retire its branch marker
                // Winner is reachable by height from here on; the marker was the only pointer to its
                // hash-keyed copy, so dropping one without the other leaked ~10 KB per adopted block.
                batch.delete_cf(&microblocks_cf, &block_body_key(&hash));
                retired += 1;
                continue;
            }
            let prev = self.header_by_hash(&hash).map(|h| h.previous_hash);
            batch.delete_cf(&metadata_cf, &block_header_key(&hash));
            batch.delete_cf(&microblocks_cf, &block_body_key(&hash));
            if let Some(p) = prev {
                batch.delete_cf(&metadata_cf, &block_child_key(&p, &hash));
            }
            batch.delete_cf(&metadata_cf, &k[..]);
            pruned += 1;
        }
        if pruned > 0 || retired > 0 {
            if self.persistent.db.write(batch).is_ok() {
                if crate::node::is_info() {
                    println!("[INFO][STORAGE] branches_pruned count={} retired={} finalized_h={}",
                             pruned, retired, finalized_height);
                }
            } else { return 0; }
        }
        pruned
    }

    /// Store a block that lost (or has not yet won) the canonical slot. Body, header and child link
    /// only — no canonical alias, no chain height. Keeps a branch inspectable and re-adoptable
    /// without a network round-trip, and cannot affect the canonical chain by construction.
    pub fn retain_branch_block(&self, mb: &qnet_state::MicroBlock, raw: &[u8]) {
        let (microblocks_cf, metadata_cf) = match (
            self.persistent.db.cf_handle("microblocks"),
            self.persistent.db.cf_handle("metadata"),
        ) {
            (Some(a), Some(b)) => (a, b),
            _ => return,
        };
        let hash = mb.hash();
        let hdr = BlockHeaderIdx {
            height: mb.height,
            previous_hash: mb.previous_hash,
            producer: mb.producer.clone(),
            state_root: mb.state_root,
            timestamp: mb.timestamp,
            tx_count: mb.transactions.len() as u32,
        };
        let mut batch = WriteBatch::default();
        batch.put_cf(&microblocks_cf, &block_body_key(&hash), raw);
        if let Ok(b) = bincode::serialize(&hdr) {
            batch.put_cf(&metadata_cf, &block_header_key(&hash), &b);
        }
        batch.put_cf(&metadata_cf, &block_child_key(&mb.previous_hash, &hash), &[]);
        // Register in the branch index so pruning can find it without walking the whole chain.
        batch.put_cf(&metadata_cf, &branch_index_key(mb.height, &hash), &[]);
        if self.persistent.db.write(batch).is_ok() && crate::node::is_info() {
            println!("[INFO][STORAGE] branch_retained h={} hash={:x?} producer={}",
                     mb.height, &hash[..8], mb.producer);
        }
    }

    /// Hashes of every stored block that names `parent` as its predecessor — the branches leaving
    /// that point. Empty for a tip; more than one means a live fork this node can see in full.
    pub fn children_of(&self, parent: &[u8; 32]) -> Vec<[u8; 32]> {
        let metadata_cf = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return Vec::new() };
        let prefix = {
            let mut p = Vec::with_capacity(36);
            p.extend_from_slice(b"chd_");
            p.extend_from_slice(parent);
            p
        };
        let mut out = Vec::new();
        let iter = self.persistent.db.iterator_cf(
            &metadata_cf,
            rocksdb::IteratorMode::From(&prefix, rocksdb::Direction::Forward),
        );
        for item in iter.flatten() {
            let (k, _) = item;
            if !k.starts_with(&prefix) { break; }
            if k.len() == prefix.len() + 32 {
                let mut h = [0u8; 32];
                h.copy_from_slice(&k[prefix.len()..]);
                out.push(h);
            }
        }
        out
    }

    /// Decompress + reconstruct a stored body. Transactions are rehydrated through the existing
    /// height-based reconstruction so the hash-keyed read returns exactly the same block the
    /// canonical read does — the two views must never differ.
    pub(super) fn decode_stored_body(&self, raw: &[u8]) -> Option<qnet_state::MicroBlock> {
        let bytes = if raw.len() >= 4 && raw[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
            zstd::decode_all(raw).ok()?
        } else {
            raw.to_vec()
        };
        let height = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&bytes).ok()
            .map(|e| e.height)
            .or_else(|| bincode::deserialize::<qnet_state::MicroBlock>(&bytes).ok().map(|m| m.height))?;
        self.reconstruct_from_efficient(&bytes, height).ok().flatten()
            .or_else(|| bincode::deserialize::<qnet_state::MicroBlock>(&bytes).ok())
    }

    /// Load the body canonically occupying a slot.
    pub fn load_canonical_body(&self, height: u64) -> Option<qnet_state::MicroBlock> {
        match self.slot_status(height) {
            SlotStatus::Block(h) => self.load_body_by_hash(&h),
            _ => None,
        }
    }

    /// Next slot at or after `from` that holds a block. Iteration must go through this rather than
    /// `h + 1`, so a burned slot is skipped instead of being mistaken for a missing block.
    pub fn next_present_height(&self, from: u64, ceiling: u64) -> Option<u64> {
        let mut h = from;
        while h <= ceiling {
            if matches!(self.slot_status(h), SlotStatus::Block(_)) { return Some(h); }
            h = h.saturating_add(1);
            if h == 0 { break; }
        }
        None
    }

    /// Resolve a block header by its hash. Content-addressed: the answer cannot be stale, because
    /// the key is derived from the very bytes it describes. This is what replaces height-keyed
    /// parent resolution — a rollback can invalidate a height, never a hash.
    pub fn header_by_hash(&self, hash: &[u8; 32]) -> Option<BlockHeaderIdx> {
        let metadata_cf = self.persistent.db.cf_handle("metadata")?;
        let raw = self.persistent.db.get_cf(&metadata_cf, &block_header_key(hash)).ok()??;
        bincode::deserialize::<BlockHeaderIdx>(&raw).ok()
    }

    /// Drop cached bodies above `target_height`. The retain inside the cache/load paths only runs
    /// if one of them is called while the rollback flag is set; an explicit sink guarantees the
    /// read-through cache can never serve a deleted height after the flag clears.
    pub fn invalidate_recent_microblocks_above(&self, target_height: u64) {
        self.recent_microblocks.retain(|&h, _| h <= target_height);
    }

    pub fn load_microblock_auto_format(&self, height: u64) -> IntegrationResult<Option<qnet_state::MicroBlock>> {
        // v27 HOLE3: read-through fast path. Skipped + pruned during
        // rollback (RocksDB authoritative; never serve rolled-back height).
        let (rb_in_progress, rb_target) = get_rollback_status();
        if rb_in_progress {
            self.recent_microblocks.retain(|&h, _| h <= rb_target);
        } else if let Some(cached) = self.recent_microblocks.get(&height) {
            return Ok(Some(cached.value().as_ref().clone()));
        }

        // Try to load raw microblock data
        let raw_data = match self.load_microblock(height)? {
            Some(data) => data,
            None => return Ok(None),
        };

        // CRITICAL: Decompress if Zstd-compressed (magic bytes: 0x28 0xb5 0x2f 0xfd)
        let microblock_data = if raw_data.len() >= 4 && raw_data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
            zstd::decode_all(&raw_data[..])
                .map_err(|e| IntegrationError::Other(format!("Zstd decompression failed: {}", e)))?
        } else {
            raw_data
        };

        // v12.1: Check format discriminator metadata key (deterministic, no guessing).
        // 0x01 = MicroBlock (full), 0x02 = EfficientMicroBlock (compact).
        // If key doesn't exist → legacy block, fall through to try-both logic.
        let fmt_key = mb_fmt_key(height);
        let known_format = self.persistent.db.cf_handle("metadata")
            .and_then(|cf| self.persistent.db.get_cf(&cf, fmt_key.as_bytes()).ok())
            .flatten()
            .and_then(|v| v.first().copied());

        match known_format {
            Some(0x01) => {
                // Deterministic: stored as MicroBlock
                let block = bincode::deserialize::<qnet_state::MicroBlock>(&microblock_data)
                    .map_err(|e| IntegrationError::SerializationError(
                        format!("MicroBlock deserialize failed h={}: {}", height, e)))?;
                if block.height != height {
                    return Err(IntegrationError::StorageError(
                        format!("MicroBlock height mismatch: stored={} requested={}", block.height, height)));
                }
                return Ok(Some(block));
            }
            Some(0x02) => {
                // Deterministic: stored as EfficientMicroBlock — reconstruct full block
                return self.reconstruct_from_efficient(&microblock_data, height);
            }
            _ => {
                // Legacy block (no format key) — fall through to try-both logic
            }
        }

        // ===================================================================
        // LEGACY FALLBACK: Blocks saved before v12.1 (no format metadata key).
        // Try MicroBlock FIRST (genesis/broadcast format), then EfficientMicroBlock.
        // MicroBlock first because bincode can false-positive on wrong format.
        // Height sanity check catches garbled deserialization.
        // ===================================================================

        // Priority 1: Full MicroBlock (genesis, broadcast, legacy)
        if let Ok(full_block) = bincode::deserialize::<qnet_state::MicroBlock>(&microblock_data) {
            // Sanity check: height must match requested height (catches false-positive deserialize)
            if full_block.height == height {
                // Cache transactions for future EfficientMicroBlock lookups
                for tx in &full_block.transactions {
                    if let Ok(hash_bytes) = hex::decode(&tx.hash) {
                        if hash_bytes.len() == 32 {
                            let mut hash_array = [0u8; 32];
                            hash_array.copy_from_slice(&hash_bytes);
                            if let Err(e) = self.transaction_pool.store_transaction(hash_array, tx.clone()) {
                                println!("[WARN][STORAGE] tx_cache_failed tx={} err={}", hex::encode(hash_array), e);
                            }
                        }
                    }
                }
                return Ok(Some(full_block));
            }
        }

        // Priority 2: EfficientMicroBlock (compact storage format, height > 0)
        if let Ok(_) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&microblock_data) {
            return self.reconstruct_from_efficient(&microblock_data, height);
        }

        // Neither format worked
        Err(IntegrationError::StorageError(
            format!("Unable to deserialize microblock {} in any known format (bytes={})", height, microblock_data.len())
        ))
    }

    /// Reconstruct a full MicroBlock from EfficientMicroBlock binary data.
    /// Loads transactions from persistent RocksDB storage and in-memory cache.
    pub(super) fn reconstruct_from_efficient(&self, data: &[u8], height: u64) -> IntegrationResult<Option<qnet_state::MicroBlock>> {
        let efficient_block = bincode::deserialize::<qnet_state::EfficientMicroBlock>(data)
            .map_err(|e| IntegrationError::SerializationError(
                format!("EfficientMicroBlock deserialize failed h={}: {}", height, e)))?;

        if efficient_block.height != height {
            return Err(IntegrationError::StorageError(
                format!("EfficientMicroBlock height mismatch: stored={} requested={}", efficient_block.height, height)));
        }

        // Reconstruct full microblock: load transactions from persistent + cache
        let mut transactions = Vec::with_capacity(efficient_block.transaction_hashes.len());

        for tx_hash in &efficient_block.transaction_hashes {
            let tx_hash_hex = hex::encode(tx_hash);

            // First try in-memory cache for speed
            if let Some(tx) = self.transaction_pool.get_transaction(tx_hash) {
                transactions.push(tx);
                continue;
            }

            // Fallback to persistent RocksDB storage
            let tx_cf = match self.persistent.db.cf_handle("transactions") {
                Some(cf) => cf,
                None => {
                    println!("[WARN][STORAGE] tx_cf_not_found block={}", height);
                    continue;
                }
            };

            let tx_key = format!("tx_{}", tx_hash_hex);
            match self.persistent.db.get_cf(&tx_cf, tx_key.as_bytes()) {
                Ok(Some(data)) => {
                    // Decompress if Zstd-compressed
                    let tx_data = if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                        zstd::decode_all(&data[..]).unwrap_or(data.to_vec())
                    } else {
                        data.to_vec()
                    };

                    if let Ok(tx) = bincode::deserialize::<qnet_state::Transaction>(&tx_data) {
                        let _ = self.transaction_pool.store_transaction(*tx_hash, tx.clone());
                        transactions.push(tx);
                    } else {
                        println!("[WARN][STORAGE] tx_deserialize_failed tx={} block={}", tx_hash_hex, height);
                    }
                }
                Ok(None) => {
                    println!("[WARN][STORAGE] tx_not_found tx={} block={}", tx_hash_hex, height);
                }
                Err(e) => {
                    println!("[WARN][STORAGE] tx_load_err tx={} err={}", tx_hash_hex, e);
                }
            }
        }

        // Verify all transactions loaded
        let expected_tx_count = efficient_block.transaction_hashes.len();
        if transactions.len() != expected_tx_count && expected_tx_count > 0 {
            eprintln!("[ERR][STORAGE] incomplete_block h={} expected_txs={} loaded={}",
                     height, expected_tx_count, transactions.len());
            return Err(IntegrationError::StorageError(
                format!("Block {} missing {} transactions", height,
                        expected_tx_count - transactions.len())));
        }

        // Reconstruct full MicroBlock (including QRB VRF data)
        let microblock = qnet_state::MicroBlock {
            height: efficient_block.height,
            timestamp: efficient_block.timestamp,
            transactions,
            producer: efficient_block.producer,
            signature: efficient_block.signature,
            previous_hash: efficient_block.previous_hash,
            merkle_root: efficient_block.merkle_root,
            vrf_output: efficient_block.vrf_output,
            vrf_proof: efficient_block.vrf_proof,
            fees_collected: efficient_block.fees_collected,
            state_root: efficient_block.state_root,
            // v14.0: Timeout round for producer authority
            timeout_round: efficient_block.timeout_round,
            carried_baseline: efficient_block.carried_baseline,
            // #80: proof lives on the wire (gossip ingest); local read never re-adopts.
            timeout_proof: None,
        };

        Ok(Some(microblock))
    }
    
    /// Convert legacy microblock to efficient format (migration utility)
    pub fn migrate_legacy_microblock_to_efficient(&self, height: u64) -> IntegrationResult<bool> {
        // Load raw data
        let microblock_data = match self.load_microblock(height)? {
            Some(data) => data,
            None => return Ok(false),
        };
        
        // Check if it's already in efficient format
        if bincode::deserialize::<qnet_state::EfficientMicroBlock>(&microblock_data).is_ok() {
            println!("[INFO][STORAGE] microblock_already_efficient height={}", height);
            return Ok(false);
        }
        
        // Try to deserialize as legacy format
        let legacy_block = bincode::deserialize::<qnet_state::MicroBlock>(&microblock_data)
            .map_err(|e| IntegrationError::SerializationError(
                format!("Failed to deserialize legacy microblock {}: {}", height, e)
            ))?;
        
        println!("[INFO][STORAGE] microblock_converting_to_efficient height={}", height);
        
        // Save in new format with delta compression
        let block_data = bincode::serialize(&legacy_block)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        self.save_block_with_delta(height, &block_data)?;
        
        println!("[INFO][STORAGE] microblock_migrated height={}", height);
        Ok(true)
    }
    
    /// Batch migration of legacy microblocks (for system upgrade)
    pub fn batch_migrate_legacy_microblocks(&self, start_height: u64, end_height: u64) -> IntegrationResult<u64> {
        let mut migrated_count = 0;
        
        println!("[INFO][STORAGE] batch_migration_start from={} to={}", start_height, end_height);
        
        for height in start_height..=end_height {
            match self.migrate_legacy_microblock_to_efficient(height) {
                Ok(true) => {
                    migrated_count += 1;
                    if migrated_count % 100 == 0 {
                        println!("[INFO][STORAGE] migration_progress converted={}", migrated_count);
                    }
                },
                Ok(false) => {
                    // Already efficient or doesn't exist
                },
                Err(e) => {
                    println!("[WARN][STORAGE] microblock_migrate_failed height={} err={}", height, e);
                }
            }
        }
        
        println!("[INFO][STORAGE] batch_migration_done converted={}", migrated_count);
        
        Ok(migrated_count)
    }
    
}

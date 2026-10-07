//! Range reads, the branch tree below finality, body decoding and format migration.

use super::*;

/// What an indexer needs per block without the transactions: identity, linkage, size.
#[derive(Debug, Clone, PartialEq)]
pub struct MicroBlockHeader {
    pub height: u64,
    pub timestamp: u64,
    pub previous_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub producer: String,
    pub tx_count: usize,
}

/// Blocks below the tip the public recent-transactions feed reaches (one hour at one block per second),
/// and the transactions it holds in all. Together they bound the work of a feed request.
pub const RECENT_TX_FEED_BLOCKS: u64 = 3_600;
pub const RECENT_TX_FEED_WINDOW: usize = 1_000;

/// The recent-transactions feed: (height, hash) of the newest transactions up to `tip`, newest first,
/// together with the hash of the block it was built on, so a replaced tip is noticed.
pub(crate) struct RecentTxFeed {
    tip: u64,
    tip_hash: Option<[u8; 32]>,
    entries: std::collections::VecDeque<(u64, String)>,
}

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
            if let Some(raw_row) = self.load_microblock(height)? {
                // The row may be zstd-compressed (a warm-chain genesis restore writes it that way).
                let raw_data = if raw_row.len() >= 4 && raw_row[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                    zstd::decode_all(&raw_row[..]).unwrap_or(raw_row)
                } else { raw_row };
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
                    if transactions.len() != efficient_block.transaction_hashes.len() {
                        // Never ship a hollow body: its header hash still matches, so a requester
                        // would burn its repair budget on it. Same rule as a missing row — stop at
                        // the gap rather than return a sparse batch that hides it.
                        break;
                    }
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

    /// The body hash at `height` when it is committed chain: at or below the durable tip, which is
    /// written in the body's own batch. A row above it (a rollback's or a stopped replay's leftover)
    /// is not chain state; its slot stays open to the canonical block, whose save replaces it.
    pub fn committed_hash_at(&self, height: u64) -> Option<[u8; 32]> {
        if height > self.persistent.get_chain_height().unwrap_or(0) { return None; }
        self.canonical_hash_at(height)
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

    /// Header fields of a stored microblock from its row alone: no transaction reconstruction, no tx-pool
    /// feed. Ok(None) once the body is pruned (the hash index outlives it); Err for a row that is present
    /// but decodes in neither form.
    pub fn load_microblock_header(&self, height: u64) -> IntegrationResult<Option<MicroBlockHeader>> {
        let (rb_in_progress, _) = get_rollback_status();
        if !rb_in_progress {
            if let Some(mb) = self.recent_microblocks.get(&height) {
                let mb = mb.value();
                return Ok(Some(MicroBlockHeader {
                    height: mb.height, timestamp: mb.timestamp, previous_hash: mb.previous_hash,
                    merkle_root: mb.merkle_root, producer: mb.producer.clone(), tx_count: mb.transactions.len(),
                }));
            }
        }
        let raw = match self.load_microblock(height)? { Some(d) => d, None => return Ok(None) };
        let data = if raw.len() >= 4 && raw[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
            zstd::decode_all(&raw[..]).map_err(|e| IntegrationError::Other(format!("zstd: {}", e)))?
        } else { raw };
        // The format key decides when present; a legacy row without one is tried in both forms.
        let fmt = self.persistent.db.cf_handle("metadata")
            .and_then(|cf| self.persistent.db.get_cf(&cf, mb_fmt_key(height).as_bytes()).ok())
            .flatten()
            .and_then(|v| v.first().copied());
        if fmt != Some(0x01) {
            if let Ok(eb) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&data) {
                if eb.height == height {
                    return Ok(Some(MicroBlockHeader {
                        height, timestamp: eb.timestamp, previous_hash: eb.previous_hash, merkle_root: eb.merkle_root,
                        producer: eb.producer, tx_count: eb.transaction_hashes.len(),
                    }));
                }
            }
        }
        if fmt != Some(0x02) {
            if let Ok(mb) = bincode::deserialize::<qnet_state::MicroBlock>(&data) {
                if mb.height == height {
                    return Ok(Some(MicroBlockHeader {
                        height, timestamp: mb.timestamp, previous_hash: mb.previous_hash, merkle_root: mb.merkle_root,
                        producer: mb.producer, tx_count: mb.transactions.len(),
                    }));
                }
            }
        }
        Err(IntegrationError::StorageError(format!("undecodable_microblock_row h={} bytes={}", height, data.len())))
    }

    /// Hashes of a stored block's transactions in block order, from its row alone: no transaction body
    /// is read and nothing feeds the tx pool. Ok(None) when the slot holds no body (burned, pruned, absent).
    pub fn block_tx_hashes(&self, height: u64) -> IntegrationResult<Option<Vec<String>>> {
        let (rb_in_progress, _) = get_rollback_status();
        if !rb_in_progress {
            if let Some(mb) = self.recent_microblocks.get(&height) {
                return Ok(Some(mb.value().transactions.iter().map(|tx| tx.hash.clone()).collect()));
            }
        }
        let raw = match self.load_microblock(height)? { Some(d) => d, None => return Ok(None) };
        let data = if raw.len() >= 4 && raw[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
            zstd::decode_all(&raw[..]).map_err(|e| IntegrationError::Other(format!("zstd: {}", e)))?
        } else { raw };
        let fmt = self.persistent.db.cf_handle("metadata")
            .and_then(|cf| self.persistent.db.get_cf(&cf, mb_fmt_key(height).as_bytes()).ok())
            .flatten()
            .and_then(|v| v.first().copied());
        if fmt != Some(0x01) {
            if let Ok(eb) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&data) {
                if eb.height == height {
                    return Ok(Some(eb.transaction_hashes.iter().map(hex::encode).collect()));
                }
            }
        }
        if fmt != Some(0x02) {
            if let Ok(mb) = bincode::deserialize::<qnet_state::MicroBlock>(&data) {
                if mb.height == height {
                    return Ok(Some(mb.transactions.into_iter().map(|tx| tx.hash).collect()));
                }
            }
        }
        Err(IntegrationError::StorageError(format!("undecodable_microblock_row h={} bytes={}", height, data.len())))
    }

    /// (height, hash) of the transactions in the blocks `floor..=top`, newest first (height descending,
    /// and within a block from its last transaction to its first), at most `limit`. Also returns the
    /// heights visited: the walk stops at `limit` transactions or at `floor`, whichever comes first.
    fn recent_tx_walk(&self, top: u64, floor: u64, limit: usize) -> (Vec<(u64, String)>, u64) {
        let mut out = Vec::new();
        let mut visited = 0u64;
        let mut h = top;
        while h >= floor && out.len() < limit {
            visited += 1;
            match self.block_tx_hashes(h) {
                Ok(Some(hashes)) => out.extend(hashes.into_iter().rev().map(|x| (h, x))),
                Ok(None) => {}
                Err(e) => if crate::node::is_warn() {
                    println!("[WARN][STORAGE] recent_feed_block_unreadable h={} err={}", h, e);
                },
            }
            if h == 0 { break; }
            h -= 1;
        }
        out.truncate(limit);
        (out, visited)
    }

    /// Bring the feed to `tip`. While the committed block at the feed's tip is still the one it was built
    /// on, the feed holds this chain: an unchanged or lower `tip` (a request that read the height before
    /// another advanced the feed) reads nothing, and a grown tip reads only the new blocks. Anything else
    /// (first use, a rollback, a replaced tip, a gap past the reach): rebuilt from the newest blocks.
    /// Committed means at or below the durable tip (committed_hash_at): a row a rollback left above it is
    /// not chain, so it never vouches for blocks that replaced the ones below it.
    /// Returns the heights visited, at most RECENT_TX_FEED_BLOCKS.
    fn refresh_recent_tx_feed(&self, feed: &mut Option<RecentTxFeed>, tip: u64) -> u64 {
        let floor = tip.saturating_sub(RECENT_TX_FEED_BLOCKS - 1);
        if let Some(f) = feed.as_mut() {
            let held = self.committed_hash_at(f.tip) == f.tip_hash;
            // An empty slot at the feed's tip proves nothing about the blocks below it.
            if held && (tip == f.tip || (tip < f.tip && f.tip_hash.is_some())) {
                return 0;
            }
            if held && f.tip_hash.is_some() && f.tip < tip && tip - f.tip < RECENT_TX_FEED_BLOCKS {
                let tip_hash = self.committed_hash_at(tip);
                let (fresh, visited) = self.recent_tx_walk(tip, f.tip + 1, RECENT_TX_FEED_WINDOW);
                for entry in fresh.into_iter().rev() {
                    f.entries.push_front(entry);
                }
                while f.entries.back().map_or(false, |(h, _)| *h < floor) {
                    f.entries.pop_back();
                }
                f.entries.truncate(RECENT_TX_FEED_WINDOW);
                f.tip = tip;
                f.tip_hash = tip_hash;
                return visited;
            }
        }
        let tip_hash = self.committed_hash_at(tip);
        let (entries, visited) = self.recent_tx_walk(tip, floor, RECENT_TX_FEED_WINDOW);
        if crate::node::is_debug() {
            println!("[DBG][STORAGE] recent_feed_rebuilt tip={} visited={} txs={}", tip, visited, entries.len());
        }
        *feed = Some(RecentTxFeed { tip, tip_hash, entries: entries.into() });
        visited
    }

    /// One page of the public recent-transactions feed and the feed's size: newest first (height
    /// descending, and within a block from its last transaction to its first), over the last
    /// RECENT_TX_FEED_BLOCKS blocks up to `tip`, at most RECENT_TX_FEED_WINDOW transactions in all.
    /// The work is bounded by those caps and `per_page`, never by the history or the number of accounts:
    /// at an unchanged tip a request reads only its page's bodies, and a grown tip adds only the new blocks.
    /// A feed already past `tip` on the same chain serves it without what lies above `tip`. A body missing
    /// from the tx rows is left out of its page.
    pub fn recent_transactions_page(&self, tip: u64, page: usize, per_page: usize) -> IntegrationResult<(Vec<Transaction>, usize)> {
        let skip = page.saturating_sub(1).saturating_mul(per_page);
        let (hashes, total) = {
            let mut feed = self.recent_tx_feed.lock();
            self.refresh_recent_tx_feed(&mut feed, tip);
            match feed.as_ref() {
                Some(f) => {
                    let above = f.entries.iter().take_while(|(h, _)| *h > tip).count();
                    (
                        f.entries.iter().skip(above).skip(skip).take(per_page).map(|(_, hash)| hash.clone()).collect::<Vec<_>>(),
                        f.entries.len() - above,
                    )
                }
                None => (Vec::new(), 0),
            }
        };
        let tx_cf = self.persistent.db.cf_handle("transactions")
            .ok_or_else(|| IntegrationError::StorageError("transactions column family not found".to_string()))?;
        let mut transactions = Vec::with_capacity(hashes.len());
        for hash in hashes {
            let mut key = [0u8; 32];
            let cached = match hex::decode(&hash) {
                Ok(b) if b.len() == 32 => { key.copy_from_slice(&b); self.transaction_pool.get_transaction(&key) }
                _ => None,
            };
            if let Some(tx) = cached {
                transactions.push(tx);
                continue;
            }
            let data = match self.persistent.db.get_cf(&tx_cf, format!("tx_{}", hash).as_bytes())? {
                Some(d) => d,
                None => continue,
            };
            let data = if data.len() >= 4 && data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                zstd::decode_all(&data[..]).unwrap_or(data)
            } else { data };
            if let Ok(tx) = bincode::deserialize::<Transaction>(&data) {
                transactions.push(tx);
            }
        }
        Ok((transactions, total))
    }

    /// Block timestamp from the retained header row alone — no tx rows needed, so it survives body
    /// expiry (genesis timing must never depend on reconstructable transactions).
    pub fn block_timestamp_at(&self, height: u64) -> IntegrationResult<Option<u64>> {
        // The header row, written in the body's batch and deleted with it: metadata point reads, no
        // body decode. The body is read only for a row saved before the header index existed.
        if let Some(hash) = self.persistent.load_microblock_hash(height)? {
            if let Some(hd) = self.persistent.header_index(&hash) { return Ok(Some(hd.timestamp)); }
        }
        let raw = match self.load_microblock(height)? { Some(d) => d, None => return Ok(None) };
        let data = if raw.len() >= 4 && raw[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
            zstd::decode_all(&raw[..]).map_err(|e| IntegrationError::Other(format!("zstd: {}", e)))?
        } else { raw };
        if let Ok(eb) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&data) {
            if eb.height == height { return Ok(Some(eb.timestamp)); }
        }
        if let Ok(mb) = bincode::deserialize::<qnet_state::MicroBlock>(&data) {
            if mb.height == height { return Ok(Some(mb.timestamp)); }
        }
        Ok(None)
    }

    /// Addresses a stored block touched (every tx's affected set) plus its producer id, read
    /// straight from the stored form. Unlike load_microblock_auto_format this never rebuilds a
    /// MicroBlock and never feeds the tx pool (whose insert is O(pool) once full), so a deep
    /// rollback's candidate scan stays one point read per tx. Ok(None) ⇒ block absent.
    /// Txs missing from the tx CF are counted and logged — they are a coverage gap, not an error.
    pub fn touched_addresses_at(&self, height: u64) -> IntegrationResult<Option<(Vec<String>, String)>> {
        let raw = match self.load_microblock(height)? { Some(d) => d, None => return Ok(None) };
        let data = if raw.len() >= 4 && raw[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
            zstd::decode_all(&raw[..]).map_err(|e| IntegrationError::Other(format!("zstd: {}", e)))?
        } else { raw };
        let fmt = self.persistent.db.cf_handle("metadata")
            .and_then(|cf| self.persistent.db.get_cf(&cf, mb_fmt_key(height).as_bytes()).ok())
            .flatten().and_then(|v| v.first().copied());
        let mut out = Vec::new();
        if fmt != Some(0x01) {
            if let Ok(eb) = bincode::deserialize::<qnet_state::EfficientMicroBlock>(&data) {
                if eb.height == height {
                    let tx_cf = match self.persistent.db.cf_handle("transactions") {
                        Some(c) => c,
                        None => return Ok(Some((out, eb.producer))),
                    };
                    let mut missing = 0u32;
                    for h in &eb.transaction_hashes {
                        let key = format!("tx_{}", hex::encode(h));
                        let td = match self.persistent.db.get_cf(&tx_cf, key.as_bytes()) {
                            Ok(Some(d)) => d,
                            _ => { missing += 1; continue; }
                        };
                        let td = if td.len() >= 4 && td[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
                            zstd::decode_all(&td[..]).unwrap_or(td)
                        } else { td };
                        match bincode::deserialize::<qnet_state::Transaction>(&td) {
                            Ok(tx) => out.extend(tx.get_all_affected_addresses()),
                            Err(_) => missing += 1,
                        }
                    }
                    if missing > 0 {
                        println!("[WARN][STORAGE] touched_scan_txs_missing h={} missing={}", height, missing);
                    }
                    return Ok(Some((out, eb.producer)));
                }
            }
        }
        if let Ok(mb) = bincode::deserialize::<qnet_state::MicroBlock>(&data) {
            for tx in &mb.transactions { out.extend(tx.get_all_affected_addresses()); }
            return Ok(Some((out, mb.producer)));
        }
        Err(IntegrationError::StorageError(format!("touched_scan_unknown_format h={}", height)))
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
                    if crate::node::is_debug() {
                        println!("[DBG][STORAGE] tx_not_found tx={} block={}", tx_hash_hex, height);
                    }
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

#[cfg(test)]
mod header_read_tests {
    use super::*;

    fn open() -> (Storage, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = Storage::new(dir.path().to_str().unwrap()).expect("storage init");
        (storage, dir)
    }

    // Both stored forms yield the same header shape, a compact row reports its hash count as tx_count,
    // and an absent row is None rather than an error.
    #[test]
    fn header_reads_both_stored_forms_and_none_when_absent() {
        let (s, _d) = open();
        let full = qnet_state::MicroBlock::new(7, 1_700_000_007, [1u8; 32], vec![], "super_a".to_string());
        s.put_microblock_row_for_test(7, &bincode::serialize(&full).unwrap()).unwrap();
        let meta = s.persistent.db.cf_handle("metadata").unwrap();
        s.persistent.db.put_cf(&meta, mb_fmt_key(7).as_bytes(), &[0x01]).unwrap();
        let h7 = s.load_microblock_header(7).unwrap().expect("full row");
        assert_eq!((h7.height, h7.timestamp, h7.tx_count, h7.producer.as_str()), (7, 1_700_000_007, 0, "super_a"));
        assert_eq!(h7.previous_hash, [1u8; 32]);
        assert_eq!(h7.merkle_root, full.merkle_root);

        let eff = qnet_state::EfficientMicroBlock::new(8, 1_700_000_008, [2u8; 32], vec![[9u8; 32]; 3], "super_b".to_string());
        s.put_microblock_row_for_test(8, &bincode::serialize(&eff).unwrap()).unwrap();
        let h8 = s.load_microblock_header(8).unwrap().expect("compact row");
        assert_eq!((h8.height, h8.tx_count, h8.producer.as_str()), (8, 3, "super_b"));
        assert_eq!(h8.merkle_root, eff.merkle_root);

        assert!(s.load_microblock_header(9).unwrap().is_none(), "no row, no header");
        s.put_microblock_row_for_test(10, b"not a block").unwrap();
        assert!(s.load_microblock_header(10).is_err(), "a present row that decodes in neither form is an error");
    }
}

#[cfg(test)]
mod recent_feed_tests {
    use super::*;

    fn open() -> (Storage, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = Storage::new(dir.path().to_str().unwrap()).expect("storage init");
        (storage, dir)
    }

    fn tx(n: u64) -> Transaction {
        Transaction {
            from: format!("sender_{}", n),
            to: Some(format!("recipient_{}", n)),
            amount: n,
            tx_type: qnet_state::TransactionType::Transfer { from: format!("sender_{}", n), to: format!("recipient_{}", n), amount: n },
            timestamp: 1_700_000_000 + n,
            hash: format!("{:064x}", n),
            signature: None,
            public_key: None,
            gas_price: 10,
            gas_limit: 10_000,
            nonce: n,
            data: None,
            dilithium_signature: None,
            dilithium_public_key: None,
            chain_id: qnet_state::transaction::QNET_CHAIN_ID,
        }
    }

    /// Through the store's own save path (compact row, tx rows, hash index); returns the block hash.
    fn put(s: &Storage, height: u64, txs: Vec<Transaction>, previous_hash: [u8; 32]) -> [u8; 32] {
        let mb = qnet_state::MicroBlock {
            height, timestamp: 1_700_000_000 + height, transactions: txs, producer: "genesis_node_001".to_string(),
            signature: vec![0u8; 64], merkle_root: [0u8; 32], previous_hash, vrf_output: None, vrf_proof: None,
            fees_collected: 0, state_root: [0u8; 32], timeout_round: 0, carried_baseline: 0, timeout_proof: None,
        };
        s.save_microblock(height, &bincode::serialize(&mb).unwrap()).expect("save");
        mb.hash()
    }

    /// A bare compact row of `count` hashes at `height`, its hash-index entry and the durable tip moved to
    /// it, as a committed save leaves them; for long histories.
    fn put_row(s: &Storage, height: u64, count: u64, tag: u8) {
        let hashes = (0..count).map(|i| {
            let mut h = [tag; 32];
            h[..8].copy_from_slice(&height.to_be_bytes());
            h[8..16].copy_from_slice(&i.to_be_bytes());
            h
        }).collect();
        let eb = qnet_state::EfficientMicroBlock::new(height, 1_700_000_000 + height, [0u8; 32], hashes, "super_a".to_string());
        s.put_microblock_row_for_test(height, &bincode::serialize(&eb).unwrap()).unwrap();
        let mut id = [tag; 32];
        id[..8].copy_from_slice(&height.to_be_bytes());
        s.save_microblock_hash(height, &id).unwrap();
        s.set_chain_height(height).unwrap();
    }

    fn hashes(txs: &[Transaction]) -> Vec<String> { txs.iter().map(|t| t.hash.clone()).collect() }

    // Newest first: the higher block first, and inside a block its last transaction first. Pages walk the
    // feed without overlap, the size is the feed's, and a page past it is empty.
    #[test]
    fn the_feed_is_newest_first_and_pages_without_overlap() {
        let (s, _d) = open();
        let h1 = put(&s, 1, vec![tx(1), tx(2)], [0u8; 32]);
        let h2 = put(&s, 2, vec![], h1);
        let h3 = put(&s, 3, vec![tx(3), tx(4), tx(5)], h2);
        put(&s, 4, vec![tx(6)], h3);
        let page = |p| s.recent_transactions_page(4, p, 2).unwrap();
        assert_eq!(page(1), (vec![tx(6), tx(5)], 6));
        assert_eq!(hashes(&page(2).0), hashes(&[tx(4), tx(3)]));
        assert_eq!(hashes(&page(3).0), hashes(&[tx(2), tx(1)]));
        assert_eq!(page(4), (vec![], 6));
        assert_eq!(page(usize::MAX).0, vec![], "a huge page number is empty, not an overflow");
        // An earlier tip serves the chain as it stood there.
        assert_eq!(hashes(&s.recent_transactions_page(2, 1, 10).unwrap().0), hashes(&[tx(2), tx(1)]));
    }

    // The heights a build visits stop at the transaction cap or at the block reach, whichever comes first,
    // and neither grows with the history below them.
    #[test]
    fn a_build_visits_a_bounded_number_of_blocks_whatever_the_history() {
        for history in [1_500u64, 6_000] {
            let (s, _d) = open();
            for h in 1..=history { put_row(&s, h, 1, 0x11); }
            let mut feed = None;
            assert_eq!(s.refresh_recent_tx_feed(&mut feed, history), RECENT_TX_FEED_WINDOW as u64, "history {}", history);
            let f = feed.as_ref().unwrap();
            assert_eq!(f.entries.len(), RECENT_TX_FEED_WINDOW);
            assert_eq!(f.entries.front().unwrap().0, history);
            assert_eq!(f.entries.back().unwrap().0, history - RECENT_TX_FEED_WINDOW as u64 + 1);
        }
        for history in [4_000u64, 9_000] {
            let (s, _d) = open();
            for h in 1..=history { put_row(&s, h, 0, 0x22); }
            let mut feed = None;
            assert_eq!(s.refresh_recent_tx_feed(&mut feed, history), RECENT_TX_FEED_BLOCKS, "empty blocks, history {}", history);
            assert!(feed.as_ref().unwrap().entries.is_empty());
        }
        // A tip far above anything stored still visits no more than the reach.
        let (s, _d) = open();
        let mut feed = None;
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 10_000_000), RECENT_TX_FEED_BLOCKS);
        // A block holding more than the cap fills the feed with its newest transactions alone.
        put_row(&s, 7, (RECENT_TX_FEED_WINDOW + 500) as u64, 0x33);
        let mut feed = None;
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 7), 1);
        assert_eq!(feed.as_ref().unwrap().entries.len(), RECENT_TX_FEED_WINDOW);
    }

    // Same tip: nothing read. Grown tip on the same chain: only the new blocks. A lower tip on the same
    // chain (a request that read the height before another advanced the feed): nothing read, and its page
    // leaves out what lies above it. A rollback or a replaced block at the tip: rebuilt, so no transaction
    // of an abandoned block stays in the feed.
    #[test]
    fn the_feed_follows_the_tip_reading_only_what_changed() {
        let (s, _d) = open();
        for h in 1..=20 { put_row(&s, h, 2, 0x44); }
        let mut feed = None;
        // A first build visits every height down to genesis here: 15..=0.
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 15), 16);
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 15), 0, "unchanged tip reads nothing");
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 18), 3, "grown tip reads the new blocks only");
        let f = feed.as_ref().unwrap();
        assert_eq!((f.entries.len(), f.entries.front().unwrap().0), (36, 18));
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 16), 0, "a late request on the same chain reads nothing");
        assert_eq!(feed.as_ref().unwrap().tip, 18);
        assert_eq!(s.recent_transactions_page(18, 1, 100).unwrap().1, 36);
        assert_eq!(s.recent_transactions_page(16, 1, 100).unwrap().1, 32, "the page stops at its own tip");

        // A rollback to 16: the rows above it go, then other blocks take 17 and 18.
        let meta = s.persistent.db.cf_handle("metadata").unwrap();
        let bodies = s.persistent.db.cf_handle("microblocks").unwrap();
        for h in 17..=18u64 {
            s.persistent.db.delete_cf(&bodies, mb_body_key(h).as_bytes()).unwrap();
            s.persistent.db.delete_cf(&meta, mb_hash_key(h).as_bytes()).unwrap();
        }
        s.set_chain_height(16).unwrap();
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 16), 17, "the feed's tip is gone: rebuilt");
        let f = feed.as_ref().unwrap();
        assert_eq!((f.entries.len(), f.entries.front().unwrap().0), (32, 16));
        put_row(&s, 17, 2, 0x66);
        put_row(&s, 18, 2, 0x66);
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 18), 2);
        let f = feed.as_ref().unwrap();
        assert!(f.entries.iter().filter(|(h, _)| *h > 16).all(|(_, x)| x.ends_with("66")), "only the new blocks above 16");

        // The block at the tip replaced (another hash at the same height), then the chain grows past it.
        s.set_chain_height(20).unwrap();
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 20), 2);
        put_row(&s, 20, 1, 0x55);
        put_row(&s, 21, 1, 0x55);
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 21), 22, "the old tip is not the block built on: rebuilt");
        let f = feed.as_ref().unwrap();
        assert_eq!(f.entries.len(), 19 * 2 + 2);
        let at_20: Vec<&String> = f.entries.iter().filter(|(h, _)| *h == 20).map(|(_, x)| x).collect();
        assert_eq!(at_20.len(), 1, "only the replacing block's transaction at 20");
        assert!(at_20[0].ends_with("55"), "{}", at_20[0]);
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 21), 0);
    }

    // A rollback that leaves the old tip's row behind (a failed delete, a lowered height marker) and a chain
    // that regrows below it: the leftover is above the durable tip, so it vouches for nothing, and a request
    // at the regrown tip gets the replacing blocks, never the abandoned ones.
    #[test]
    fn a_row_left_above_the_durable_tip_never_keeps_abandoned_blocks_in_the_feed() {
        let (s, _d) = open();
        for h in 1..=20 { put_row(&s, h, 2, 0x44); }
        let mut feed = None;
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 20), 21);
        s.set_chain_height(15).unwrap();
        put_row(&s, 16, 2, 0x77);
        put_row(&s, 17, 2, 0x77);
        assert_eq!(s.load_microblock_hash(20).unwrap().map(|h| h[31]), Some(0x44), "the old tip's row is still there");
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 17), 18, "the old tip is above the durable tip: rebuilt");
        let f = feed.as_ref().unwrap();
        assert_eq!((f.tip, f.entries.len()), (17, 34));
        assert!(f.entries.iter().filter(|(h, _)| *h > 15).all(|(_, x)| x.ends_with("77")), "only the replacing blocks above 15");
        assert_eq!(s.refresh_recent_tx_feed(&mut feed, 17), 0);
    }
}

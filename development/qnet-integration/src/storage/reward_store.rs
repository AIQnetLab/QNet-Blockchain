//! Epoch reward shards, light-node eligibility bitmaps and batched account loads.

use super::*;

impl Storage {
    /// Persist one reward shard's sorted (wallet, amount) leaf slice.
    pub fn save_epoch_reward_shard(&self, epoch: u64, shard: usize, wallets: &[(String, u64)]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("epoch_wshard_{:010}_{:06}", epoch, shard);
        let data = bincode::serialize(wallets)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        self.persistent.db.put_cf(&cf, key.as_bytes(), &data)?;
        Ok(())
    }

    /// Load one reward shard's sorted (wallet, amount) leaf slice.
    pub fn load_epoch_reward_shard(&self, epoch: u64, shard: usize) -> IntegrationResult<Option<Vec<(String, u64)>>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("epoch_wshard_{:010}_{:06}", epoch, shard);
        match self.persistent.db.get_cf(&cf, key.as_bytes())? {
            Some(data) => Ok(Some(bincode::deserialize(&data)
                .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?)),
            None => Ok(None),
        }
    }

    /// Persist per-epoch shard metadata: the K shard subtree-roots and the first wallet of each
    /// shard (ascending). The bounds enable an O(log K) binary-search to locate a claimant's shard.
    pub fn save_epoch_shard_meta(&self, epoch: u64, roots: &[[u8; 32]], bounds: &[String]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("epoch_shardmeta_{:010}", epoch);
        let roots_vec: Vec<[u8; 32]> = roots.to_vec();
        let bounds_vec: Vec<String> = bounds.to_vec();
        let data = bincode::serialize(&(roots_vec, bounds_vec))
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        self.persistent.db.put_cf(&cf, key.as_bytes(), &data)?;
        Ok(())
    }

    /// Load per-epoch shard metadata (K roots, K first-wallet bounds).
    pub fn load_epoch_shard_meta(&self, epoch: u64) -> IntegrationResult<Option<(Vec<[u8; 32]>, Vec<String>)>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("epoch_shardmeta_{:010}", epoch);
        match self.persistent.db.get_cf(&cf, key.as_bytes())? {
            Some(data) => Ok(Some(bincode::deserialize(&data)
                .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?)),
            None => Ok(None),
        }
    }

    /// Drop a single epoch's sharded reward set + meta (range-delete all its shards). Used by the
    /// finalization path when a locally-frozen set no longer matches the 2f+1-certified root.
    pub fn delete_epoch_reward_shards(&self, epoch: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let start = format!("epoch_wshard_{:010}_{:06}", epoch, 0usize);
        let end = format!("epoch_wshard_{:010}_{:06}", epoch + 1, 0usize);
        self.persistent.db.delete_range_cf(&cf, start.as_bytes(), end.as_bytes())?;
        let meta = format!("epoch_shardmeta_{:010}", epoch);
        self.persistent.db.delete_cf(&cf, meta.as_bytes())?;
        Ok(())
    }

    /// O(1) range-delete of the sharded leaf-set CACHE (epoch_wshard_/epoch_shardmeta_) for epochs <
    /// before_epoch. Leaves epoch_root_/super_elig_/light_bm_ intact, so any pruned epoch's claim
    /// self-heals by re-deriving + verifying against the committed root. Wired from persist_local_reward_root.
    pub fn prune_epoch_reward_shards(&self, before_epoch: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let wend = format!("epoch_wshard_{:010}_", before_epoch);
        self.persistent.db.delete_range_cf(&cf, &b"epoch_wshard_0000000000_"[..], wend.as_bytes())?;
        let mend = format!("epoch_shardmeta_{:010}", before_epoch);
        self.persistent.db.delete_range_cf(&cf, &b"epoch_shardmeta_0000000000"[..], mend.as_bytes())?;
        Ok(())
    }

    /// Epochs whose shard cache (meta row) is present here, ascending.
    pub fn reward_shard_meta_epochs(&self) -> IntegrationResult<Vec<u64>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let prefix = b"epoch_shardmeta_";
        let mut out = Vec::new();
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::From(prefix, rocksdb::Direction::Forward)) {
            let (k, _) = item.map_err(|e| IntegrationError::StorageError(format!("shardmeta_iter: {}", e)))?;
            if !k.starts_with(prefix) { break; }
            if let Some(e) = std::str::from_utf8(&k[prefix.len()..]).ok().and_then(|d| d.parse::<u64>().ok()) {
                out.push(e);
            }
        }
        Ok(out)
    }

    fn claim_outcome_key(hash: &str) -> String { format!("claim_out_{}", hash) }
    /// The outcome row's height-ordered twin, so the prune reads only the rows it deletes.
    fn claim_outcome_order_key(height: u64, hash: &str) -> String { format!("claim_oh_{:020}_{}", height, hash) }

    /// What an applied merkle claim credited: (height, amount, epochs). Written by apply for every claim in a
    /// block, so a claim that credited nothing is not shown as a confirmed credit of its amount. Node-local
    /// display data, kept as long as the transaction index keeps the claim.
    pub fn save_claim_outcome(&self, hash: &str, height: u64, credited: u64, epochs: u32) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let mut v = Vec::with_capacity(20);
        v.extend_from_slice(&height.to_le_bytes());
        v.extend_from_slice(&credited.to_le_bytes());
        v.extend_from_slice(&epochs.to_le_bytes());
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(&cf, Self::claim_outcome_key(hash).as_bytes(), &v);
        batch.put_cf(&cf, Self::claim_outcome_order_key(height, hash).as_bytes(), b"");
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// The stored outcome of the claim `hash`: (height, credited, epochs credited).
    pub fn load_claim_outcome(&self, hash: &str) -> Option<(u64, u64, u32)> {
        let cf = self.persistent.db.cf_handle("pending_rewards")?;
        let v = self.persistent.db.get_cf(&cf, Self::claim_outcome_key(hash).as_bytes()).ok()??;
        if v.len() != 20 { return None; }
        Some((u64::from_le_bytes(v[..8].try_into().ok()?), u64::from_le_bytes(v[8..16].try_into().ok()?),
              u32::from_le_bytes(v[16..20].try_into().ok()?)))
    }

    /// Drop claim outcomes applied below `below_height`: the transaction index's own prune height, so a claim it
    /// still lists keeps its outcome. Walks the height-ordered rows and stops at the first one it keeps. An outcome
    /// rewritten at another height (a claim re-applied after a rollback) is kept until its own height passes.
    pub fn prune_claim_outcomes(&self, below_height: u64) -> IntegrationResult<usize> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let prefix = b"claim_oh_";
        let mut batch = rocksdb::WriteBatch::default();
        let mut n = 0usize;
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::From(prefix, rocksdb::Direction::Forward)) {
            let (k, _) = item.map_err(|e| IntegrationError::StorageError(format!("claim_oh_iter: {}", e)))?;
            if !k.starts_with(prefix) { break; }
            let rest = std::str::from_utf8(&k[prefix.len()..]).unwrap_or("");
            let (h, hash) = match rest.split_once('_') {
                Some((h, hash)) => (h.parse::<u64>().unwrap_or(0), hash),
                None => (0, ""),
            };
            if h >= below_height { break; }
            batch.delete_cf(&cf, &k);
            if !hash.is_empty() && self.load_claim_outcome(hash).map_or(false, |(oh, _, _)| oh == h) {
                batch.delete_cf(&cf, Self::claim_outcome_key(hash).as_bytes());
                n += 1;
            }
        }
        self.persistent.db.write(batch)?;
        Ok(n)
    }

    /// The fingerprint the recipient index keys a wallet by. 16 bytes, because an index hit is acted on as a leaf
    /// (the claim door refuses a batch that skips it, the head epoch is reported from it): at 10M recipients and 10M
    /// claimants a false hit is about 3e-25 per epoch, where 8 bytes gave about 5e-6.
    pub fn reward_recipient_fingerprint(wallet: &str) -> u128 {
        use sha3::{Digest, Sha3_256};
        let mut h = Sha3_256::new();
        h.update(b"QNET_RCPX_v1");
        h.update(wallet.as_bytes());
        let d = h.finalize();
        u128::from_be_bytes(d[..16].try_into().unwrap_or([0u8; 16]))
    }

    fn recipient_index_meta_key(epoch: u64) -> String { format!("rcpx_meta_{:010}", epoch) }
    fn recipient_index_bucket_key(epoch: u64, bucket: usize) -> String { format!("rcpx_bkt_{:010}_{:06}", epoch, bucket) }

    /// Durable per-epoch recipient index: each wallet holding a leaf in `epoch`, with its amount. It outlives the
    /// shard cache, so a claim walk passes an epoch a wallet was not paid in without rebuilding the epoch, and the
    /// balance routes still count an epoch whose shards were pruned. Buckets of (16-byte fingerprint, amount) of
    /// about RECIPIENT_BUCKET wallets each, so a lookup reads one meta row and one bucket. Amounts are a class byte
    /// into the meta row's table (an equal split has a handful of distinct amounts), or the full u64 when there are
    /// more than 255. Stored with the certified root it was built from, in one write batch replacing any earlier
    /// index of the epoch. Node-local: no frame or root carries it.
    pub fn save_reward_recipient_index(&self, epoch: u64, root: &[u8; 32], mut entries: Vec<(u128, u64)>) -> IntegrationResult<()> {
        const RECIPIENT_BUCKET: usize = 1024;
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        entries.sort_unstable();
        entries.dedup_by_key(|e| e.0);
        let mut table: Vec<u64> = entries.iter().map(|e| e.1).collect();
        table.sort_unstable();
        table.dedup();
        let wide = table.len() > 255;
        if wide { table.clear(); }
        let nb = ((entries.len() + RECIPIENT_BUCKET - 1) / RECIPIENT_BUCKET).max(1).next_power_of_two();
        let mut buckets: Vec<Vec<u8>> = vec![Vec::new(); nb];
        // Entries are sorted by fingerprint, so each bucket receives its own in ascending order.
        for (fp, amount) in &entries {
            let b = &mut buckets[(*fp as usize) & (nb - 1)];
            b.extend_from_slice(&fp.to_le_bytes());
            if wide {
                b.extend_from_slice(&amount.to_le_bytes());
            } else {
                b.push(table.binary_search(amount).unwrap_or(0) as u8);
            }
        }
        let mut batch = rocksdb::WriteBatch::default();
        batch.delete_range_cf(&cf, Self::recipient_index_bucket_key(epoch, 0).as_bytes(),
                              Self::recipient_index_bucket_key(epoch + 1, 0).as_bytes());
        for (i, b) in buckets.iter().enumerate() {
            if !b.is_empty() { batch.put_cf(&cf, Self::recipient_index_bucket_key(epoch, i).as_bytes(), b); }
        }
        let mut meta = Vec::with_capacity(46 + table.len() * 8);
        meta.extend_from_slice(root);
        meta.extend_from_slice(&(entries.len() as u64).to_le_bytes());
        meta.extend_from_slice(&(nb as u32).to_le_bytes());
        meta.push(wide as u8);
        meta.push(table.len() as u8);
        for a in &table { meta.extend_from_slice(&a.to_le_bytes()); }
        batch.put_cf(&cf, Self::recipient_index_meta_key(epoch).as_bytes(), &meta);
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// The certified root the epoch's recipient index was built from, if one is stored.
    pub fn reward_recipient_index_root(&self, epoch: u64) -> Option<[u8; 32]> {
        let cf = self.persistent.db.cf_handle("pending_rewards")?;
        let v = self.persistent.db.get_cf(&cf, Self::recipient_index_meta_key(epoch).as_bytes()).ok()??;
        if v.len() < 46 { return None; }
        v[..32].try_into().ok()
    }

    /// `wallet` in the epoch's recipient index built from `root`: Some(Some(amount)) when it holds a leaf,
    /// Some(None) when it does not, None when no index for that root is stored or a row is unreadable.
    pub fn reward_recipient_lookup(&self, epoch: u64, root: &[u8; 32], wallet: &str) -> Option<Option<u64>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")?;
        let meta = self.persistent.db.get_cf(&cf, Self::recipient_index_meta_key(epoch).as_bytes()).ok()??;
        if meta.len() < 46 || &meta[..32] != root { return None; }
        let nb = u32::from_le_bytes(meta[40..44].try_into().ok()?) as usize;
        let (wide, ncls) = (meta[44] == 1, meta[45] as usize);
        if nb == 0 || !nb.is_power_of_two() || meta.len() != 46 + ncls * 8 { return None; }
        let fp = Self::reward_recipient_fingerprint(wallet);
        let bucket = match self.persistent.db.get_cf(&cf, Self::recipient_index_bucket_key(epoch, (fp as usize) & (nb - 1)).as_bytes()) {
            Ok(Some(v)) => v,
            Ok(None) => return Some(None), // written in one batch with the meta row: an absent bucket is empty
            Err(_) => return None,
        };
        let rec = if wide { 24 } else { 17 };
        if bucket.len() % rec != 0 { return None; }
        let fp_at = |i: usize| u128::from_le_bytes(bucket[i * rec..i * rec + 16].try_into().unwrap_or([0u8; 16]));
        let (mut lo, mut hi) = (0usize, bucket.len() / rec);
        while lo < hi {
            let mid = (lo + hi) / 2;
            match fp_at(mid).cmp(&fp) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => {
                    let at = mid * rec + 16;
                    let amount = if wide {
                        u64::from_le_bytes(bucket[at..at + 8].try_into().ok()?)
                    } else {
                        let c = bucket[at] as usize;
                        if c >= ncls { return None; }
                        u64::from_le_bytes(meta[46 + c * 8..54 + c * 8].try_into().ok()?)
                    };
                    return Some(Some(amount));
                }
            }
        }
        Some(None)
    }

    /// Persist a Light-node eligibility bitmap (decompressed) keyed by (epoch, genesis_idx),
    /// indexed at apply so the emission recompute reads ≤5 keys, not a 14400-block scan. Last
    /// write per (epoch,gidx) wins — identical to the in-order block scan it replaces, and it
    /// survives heartbeat-body pruning so an old epoch stays recomputable.
    /// LOWEST INCLUSION HEIGHT WINS. The stored value must not depend on whether a node's in-memory dedup map
    /// happened to accept the TX — that map is not durable, so a restarted node would otherwise
    /// resolve a different bitmap for the epoch and fork reward_root.
    pub fn save_light_bitmap(&self, epoch: u64, gidx: usize, incl_height: u64, bitmap: &[u8]) -> IntegrationResult<()> {
        self.save_light_bitmap_from(epoch, gidx, gidx, incl_height, bitmap)
    }

    /// A shard's bitmap as committed by ONE of its owners. Each owner's copy is a row of its own, and
    /// `load_light_bitmaps` bit-ORs them: eligibility only ever grows, OR is order-independent, so
    /// every node reaches the same set whatever order the blocks arrived in. Keeping one row per shard
    /// instead would have made a backup's partial cover ERASE the primary's, which is worse than the
    /// gap it exists to fill.
    pub fn save_light_bitmap_from(&self, epoch: u64, shard: usize, signer: usize, incl_height: u64, bitmap: &[u8]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = Self::light_bm_key(epoch, shard, signer);
        // Lowest inclusion height wins. Arrival order is node-local; the height is canonical, so
        // every node holding both inclusions of a duplicated bitmap converges on the same row.
        if let Some(prev) = self.persistent.db.get_cf(&cf, key.as_bytes())? {
            if prev.len() >= 8 {
                let mut hb = [0u8; 8];
                hb.copy_from_slice(&prev[..8]);
                if u64::from_be_bytes(hb) <= incl_height { return Ok(()); }
            }
        }
        // Value = inclusion height (8 B BE) || bitmap. The stamp lets a rollback delete exactly the
        // rows an orphaned block wrote; first-write-wins alone would strand them.
        let mut v = Vec::with_capacity(8 + bitmap.len());
        v.extend_from_slice(&incl_height.to_be_bytes());
        v.extend_from_slice(bitmap);
        self.persistent.db.put_cf(&cf, key.as_bytes(), &v)?;
        Ok(())
    }

    /// The row one owner's bitmap for a shard lives under; the primary keeps the historic key.
    fn light_bm_key(epoch: u64, shard: usize, signer: usize) -> String {
        if signer == shard { format!("light_bm_{}_{}", epoch, shard) } else { format!("light_bm_{}_{}_{}", epoch, shard, signer) }
    }

    /// Whether `signer` already has its own committed bitmap row for this shard's epoch.
    pub fn has_light_bitmap_from(&self, epoch: u64, shard: usize, signer: usize) -> bool {
        self.persistent.db.cf_handle("pending_rewards")
            .and_then(|cf| self.persistent.db.get_cf(&cf, Self::light_bm_key(epoch, shard, signer).as_bytes()).ok().flatten())
            .is_some()
    }

    /// Persist a light node's per-epoch attestation (genesis restart resilience): the boundary bitmap TX
    /// is built from RAM only, so a mid-epoch restart would otherwise drop this shard's attestations.
    /// Zero-padded epoch key ⇒ O(1) range-delete prune. Idempotent. The value is `answered_at` (Unix
    /// seconds, 8 bytes BE): the pinger's stamp of the answer that counted the node in this epoch. A
    /// 1-byte value, written before the time was kept, carries none.
    pub fn save_light_epoch_eligible(&self, epoch: u64, node_id: &str, answered_at: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("lelig_{:010}_{}", epoch, node_id);
        self.persistent.db.put_cf(&cf, key.as_bytes(), answered_at.to_be_bytes())?;
        Ok(())
    }

    /// When the answer that counted `node_id` in `epoch` was given (`save_light_epoch_eligible`); None when
    /// this genesis holds no row for it, or one without a time.
    pub fn light_counted_answer_at(&self, node_id: &str, epoch: u64) -> Option<u64> {
        let cf = self.persistent.db.cf_handle("pending_rewards")?;
        let key = format!("lelig_{:010}_{}", epoch, node_id);
        self.persistent.db.get_cf(&cf, key.as_bytes()).ok().flatten()
            .filter(|v| v.len() == 8)
            .map(|v| { let mut b = [0u8; 8]; b.copy_from_slice(&v); u64::from_be_bytes(b) })
    }

    /// Reload persisted light attestations for epochs >= from_epoch (boot rebuild of the RAM map).
    pub fn load_light_epoch_eligible(&self, from_epoch: u64) -> IntegrationResult<Vec<(u64, String)>> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let mut out = Vec::new();
        let start = format!("lelig_{:010}_", from_epoch);
        for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(start.as_bytes(), Direction::Forward)) {
            let (k, _) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("light_epoch_eligible iterator failed: {}", e))),
            };
            if !k.starts_with(b"lelig_") { break; }
            let s = match std::str::from_utf8(&k[6..]) { Ok(s) => s, Err(_) => continue };
            if s.len() < 12 { continue; }
            if let Ok(epoch) = s[..10].parse::<u64>() { out.push((epoch, s[11..].to_string())); }
        }
        Ok(out)
    }

    /// O(1) range-delete of persisted attestations for epochs < before_epoch (mirror the RAM 3-epoch prune).
    pub fn prune_light_epoch_eligible(&self, before_epoch: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let end = format!("lelig_{:010}_", before_epoch);
        self.persistent.db.delete_range_cf(&cf, &b"lelig_0000000000_"[..], end.as_bytes())?;
        Ok(())
    }

    /// Each owner's own committed row of a shard's epoch, (owner, bitmap), before the OR that
    /// `load_light_bitmaps` takes. Read only: the device layer's cross-owner monitor compares them.
    pub fn load_light_bitmaps_by_owner(&self, epoch: u64, shard: usize) -> Vec<(usize, Vec<u8>)> {
        let Some(cf) = self.persistent.db.cf_handle("pending_rewards") else { return Vec::new(); };
        crate::node::light_shard_owners(shard).into_iter().filter_map(|signer| {
            let d = self.persistent.db.get_cf(&cf, Self::light_bm_key(epoch, shard, signer).as_bytes()).ok()??;
            (d.len() > 8).then(|| (signer, d[8..].to_vec()))
        }).collect()
    }

    /// Load the ≤5 Light eligibility bitmaps for an epoch as (genesis_idx → bitmap), sorted.
    pub fn load_light_bitmaps(&self, epoch: u64) -> IntegrationResult<std::collections::BTreeMap<usize, Vec<u8>>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let mut out: std::collections::BTreeMap<usize, Vec<u8>> = std::collections::BTreeMap::new();
        for shard in 0..5usize {
            // The shard's own row plus every backup owner's row, bit-ORed. A bit set by any owner
            // means that light node attested, and no owner can clear another's.
            for signer in crate::node::light_shard_owners(shard) {
                let key = Self::light_bm_key(epoch, shard, signer);
                if let Some(d) = self.persistent.db.get_cf(&cf, key.as_bytes())? {
                    if d.len() > 8 {
                        let bits = &d[8..];                       // strip the height stamp
                        let slot = out.entry(shard).or_default();
                        if slot.len() < bits.len() { slot.resize(bits.len(), 0); }
                        for (i, b) in bits.iter().enumerate() { slot[i] |= *b; }
                    }
                }
            }
        }
        Ok(out)
    }

    /// REORG ONLY: clear the CONSENSUS reward side-indices that an orphaned-fork block could have written
    /// above `up_to_height`, so the reorged node's emission `eligible` set cannot diverge from a from-genesis
    /// node (→ reward_root fork). Both are non-height-keyed, so orphans can only be pruned by epoch, and the
    /// two need DIFFERENT bounds because they update differently:
    ///   • super_elig_{E}_{node_id} is ADD-ONLY (save_super_eligible_batch never clears the epoch) and is
    ///     stamped at height (E+1)*14400. Any entry with E >= from_epoch was written STRICTLY above rollback_to
    ///     (a canonical node at rollback_to has not crossed that boundary) => pure orphan => clear. The live
    ///     forward pipeline re-derives super_elig_{from_epoch} from canonical account state when it re-crosses
    ///     the boundary. super_elig_{from_epoch-1} (stamped at from_epoch*14400 <= rollback_to) is legitimate
    ///     and preserved.
    ///   • light_bm_{E}_{gidx} is OVERWRITE-PER-KEY, so any epoch a genesis is online-on-canonical for self-
    ///     heals when it re-commits its bitmap. Clear only STRICTLY-FUTURE epochs (E > from_epoch): a canonical
    ///     node at rollback_to holds no legitimate bitmap for a future epoch, so those are pure orphans (covers
    ///     the rare genesis-offline-on-canonical case where no overwrite arrives). light_bm_{from_epoch} is
    ///     LEFT intact — it may be a legitimate current-epoch bitmap committed in the last-50-block window
    ///     at/below rollback_to, and clearing it risks a reward the reconcile-replay floor (snapshot <=
    ///     rollback_to) would not re-derive; an orphan copy self-heals via the canonical re-commit before that
    ///     epoch's emission.
    /// light_elig_ is deliberately NOT touched: it is a NON-consensus recency index (read only by /node/status
    /// for epochs {e-1,e-2} < from_epoch, never a cleared epoch), self-heals each boundary + range-prunes to
    /// ~3 epochs, and a full scan of its up-to-~40M rows under the rollback barrier would stall consensus for
    /// zero reward_root benefit. Call ONLY on the reorg-rollback path (forward re-apply follows); boot/snapshot
    /// inherit an already-reconciled index with no re-apply. Finalized past epochs are immutable + untouched.
    pub fn reconcile_reward_indices_above_epoch(&self, up_to_height: u64) -> IntegrationResult<u32> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        // Settle-aligned: super_elig_{E} is stamped at (E+1)*14400 + HB_ANCHOR_MAX_LAG, so a rollback
        // into that window must still clear epoch E. Dividing the bare height would keep it.
        let from_epoch = up_to_height.saturating_sub(crate::node::HB_ANCHOR_MAX_LAG) / 14400;
        let mut batch = rocksdb::WriteBatch::default();
        let mut cleared = 0u32;
        // (prefix, min_epoch_inclusive): super_elig_ clears the current epoch (its from_epoch entry is always
        // an orphan); light_bm_ only strictly-future (current-epoch bitmap may be legitimate + self-healing).
        // super_elig_ is epoch-keyed with no stamp: clear from the current epoch up.
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::From(b"super_elig_", rocksdb::Direction::Forward)) {
            let (k, _) = item.map_err(|e| IntegrationError::StorageError(
                format!("reconcile_reward_indices iterator error (reconcile incomplete): {}", e)))?;
            if !k.starts_with(b"super_elig_") { break; }
            let rest = &k[b"super_elig_".len()..];
            let end = rest.iter().position(|&b| b == b'_').unwrap_or(rest.len());
            if let Some(e) = std::str::from_utf8(&rest[..end]).ok().and_then(|s| s.parse::<u64>().ok()) {
                if e >= from_epoch { batch.delete_cf(&cf, &k); cleared += 1; }
            }
        }
        // light_bm_ carries its inclusion height, so delete EXACTLY the rows written above the
        // rollback target. Precise, and required now that the write is first-write-wins: a stranded
        // orphan bitmap would no longer be overwritten by the canonical re-commit.
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::From(b"light_bm_", rocksdb::Direction::Forward)) {
            let (k, v) = item.map_err(|e| IntegrationError::StorageError(
                format!("reconcile_reward_indices iterator error (reconcile incomplete): {}", e)))?;
            if !k.starts_with(b"light_bm_") { break; }
            if v.len() >= 8 {
                let h = u64::from_be_bytes(v[..8].try_into().unwrap_or([0u8; 8]));
                if h > up_to_height { batch.delete_cf(&cf, &k); cleared += 1; }
            }
        }
        if cleared > 0 { self.persistent.db.write(batch)?; }
        Ok(cleared)
    }

    /// Mark a super-node eligible for an epoch's reward (heartbeat popcount ≥ threshold), keyed
    /// per (epoch, node_id). Written at apply when the tally crosses the threshold — idempotent
    /// O(1) put. Lets the emission recompute read O(eligible) instead of an O(registered) per-super
    /// account scan. Deterministic: apply order = block order, and the tally is monotonic in-epoch.
    pub fn save_super_eligible(&self, epoch: u64, node_id: &str) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("super_elig_{}_{}", epoch, node_id);
        self.persistent.db.put_cf(&cf, key.as_bytes(), &[])?;
        Ok(())
    }

    /// Batch-load accounts from the persistent `accounts` CF in ONE RocksDB multi_get (vs N single
    /// reads). Lets the epoch-boundary super-eligibility pass resolve a large EVICTED-super set with a
    /// single batched I/O instead of sequential cold reads that would stall the boundary block at scale.
    /// Order matches `addresses`; missing/undecodable → None.
    pub fn load_accounts_batch(&self, addresses: &[String]) -> Vec<Option<qnet_state::Account>> {
        self.try_load_accounts_batch(addresses).into_iter().map(|r| r.ok().flatten()).collect()
    }

    /// The same read with each row's outcome: Err = unreadable (no CF, a RocksDB or decode error).
    pub fn try_load_accounts_batch(&self, addresses: &[String]) -> Vec<Result<Option<qnet_state::Account>, ()>> {
        let cf = match self.persistent.db.cf_handle("accounts") {
            Some(c) => c,
            None => return vec![Err(()); addresses.len()],
        };
        let unreadable = || { crate::storage::ACCOUNT_READ_ERRS.fetch_add(1, std::sync::atomic::Ordering::Relaxed); };
        self.persistent.db
            .multi_get_cf(addresses.iter().map(|a| (&cf, a.as_bytes())))
            .into_iter()
            .map(|r| match r {
                Ok(None) => Ok(None),
                Ok(Some(b)) => bincode::deserialize::<qnet_state::Account>(&b).map(Some).map_err(|_| unreadable()),
                Err(_) => { unreadable(); Err(()) }
            })
            .collect()
    }

}

#[cfg(test)]
mod tests_light_answer_time {
    use super::*;

    /// The row of a counted light node keeps the time of the answer that counted it; the loader still reads keys
    /// only, and a row written before the time was kept (one byte) has none.
    #[test]
    fn the_counting_answer_keeps_its_time_and_an_old_row_has_none() {
        let dir = tempfile::TempDir::new().unwrap();
        let s = Storage::new(dir.path().to_str().unwrap()).unwrap();
        s.save_light_epoch_eligible(150, "light_a", 1_790_000_123).unwrap();
        assert_eq!(s.light_counted_answer_at("light_a", 150), Some(1_790_000_123));
        assert_eq!(s.light_counted_answer_at("light_a", 149), None);
        assert_eq!(s.light_counted_answer_at("light_b", 150), None);
        assert_eq!(s.load_light_epoch_eligible(150).unwrap(), vec![(150, "light_a".to_string())]);
        let cf = s.persistent.db.cf_handle("pending_rewards").unwrap();
        s.persistent.db.put_cf(&cf, b"lelig_0000000151_light_a", [1u8]).unwrap();
        assert_eq!(s.light_counted_answer_at("light_a", 151), None);
        assert_eq!(s.load_light_epoch_eligible(150).unwrap().len(), 2, "the old row still counts the node");
    }
}

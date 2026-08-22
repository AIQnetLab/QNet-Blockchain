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

    /// Persist a Light-node eligibility bitmap (decompressed) keyed by (epoch, genesis_idx),
    /// indexed at apply so the emission recompute reads ≤5 keys, not a 14400-block scan. Last
    /// write per (epoch,gidx) wins — identical to the in-order block scan it replaces, and it
    /// survives heartbeat-body pruning so an old epoch stays recomputable.
    /// LOWEST INCLUSION HEIGHT WINS. The stored value must not depend on whether a node's in-memory dedup map
    /// happened to accept the TX — that map is not durable, so a restarted node would otherwise
    /// resolve a different bitmap for the epoch and fork reward_root.
    pub fn save_light_bitmap(&self, epoch: u64, gidx: usize, incl_height: u64, bitmap: &[u8]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("light_bm_{}_{}", epoch, gidx);
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

    /// Persist a light node's per-epoch attestation (genesis restart resilience): the boundary bitmap TX
    /// is built from RAM only, so a mid-epoch restart would otherwise drop this shard's attestations.
    /// Zero-padded epoch key ⇒ O(1) range-delete prune. Idempotent.
    pub fn save_light_epoch_eligible(&self, epoch: u64, node_id: &str) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = format!("lelig_{:010}_{}", epoch, node_id);
        self.persistent.db.put_cf(&cf, key.as_bytes(), &[1u8])?;
        Ok(())
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

    /// Load the ≤5 Light eligibility bitmaps for an epoch as (genesis_idx → bitmap), sorted.
    pub fn load_light_bitmaps(&self, epoch: u64) -> IntegrationResult<std::collections::BTreeMap<usize, Vec<u8>>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let mut out = std::collections::BTreeMap::new();
        for gidx in 0..5usize {
            let key = format!("light_bm_{}_{}", epoch, gidx);
            if let Some(d) = self.persistent.db.get_cf(&cf, key.as_bytes())? {
                if d.len() > 8 { out.insert(gidx, d[8..].to_vec()); } // strip the height stamp
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
        let cf = match self.persistent.db.cf_handle("accounts") {
            Some(c) => c,
            None => return vec![None; addresses.len()],
        };
        self.persistent.db
            .multi_get_cf(addresses.iter().map(|a| (&cf, a.as_bytes())))
            .into_iter()
            .map(|r| match r { Ok(Some(b)) => bincode::deserialize(&b).ok(), _ => None })
            .collect()
    }

}

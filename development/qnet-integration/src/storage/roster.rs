//! Roster indices, richlist, heartbeat inclusion index and reward aggregation.

use super::*;

/// Serialises the node_<id> read-modify-write per key.
///
/// The chain-confirmed identity {wallet, reg_height, burn} is preserved by reading the prior row at
/// the top of save_node_registration_inner — and that read is NOT atomic with the write at the end.
/// Two writers reach it from different tasks on one runtime: the chain-apply (reg_height Some) from
/// the block pipeline, and the RPC cache refresh (reg_height None) from the HTTP runtime, which fires
/// on every accepted light ping. If a stamp lands between the read and the write, the cache write
/// puts back a row with no reg_height — and every registry_root fold SKIPS a row without it,
/// permanently, with no repair path. That is the fork the comment in that function warns about.
///
/// Sharded so a genesis serving ~700 pings/s does not contend on a single lock; the critical section
/// is a point read plus a batch write, with no await inside it.
static NODE_ROW_LOCKS: once_cell::sync::Lazy<Vec<parking_lot::Mutex<()>>> =
    once_cell::sync::Lazy::new(|| (0..64).map(|_| parking_lot::Mutex::new(())).collect());

fn node_row_lock(node_id: &str) -> &'static parking_lot::Mutex<()> {
    let h = blake3::hash(node_id.as_bytes());
    let i = (u64::from_le_bytes(h.as_bytes()[..8].try_into().unwrap_or([0u8; 8])) % 64) as usize;
    &NODE_ROW_LOCKS[i]
}

impl Storage {
    /// Batch-write the eligible super set for an epoch in one WriteBatch (epoch-boundary snapshot).
    pub fn save_super_eligible_batch(&self, epoch: u64, node_ids: &[String]) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let mut batch = rocksdb::WriteBatch::default();
        for node_id in node_ids {
            batch.put_cf(&cf, format!("super_elig_{}_{}", epoch, node_id).as_bytes(), &[]);
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// Load the eligible super node_ids for an epoch (prefix scan, ascending by node_id).
    pub fn load_super_eligible(&self, epoch: u64) -> IntegrationResult<Vec<String>> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let prefix = format!("super_elig_{}_", epoch);
        let pb = prefix.as_bytes();
        let mut out: Vec<String> = Vec::new();
        let iter = self.persistent.db.iterator_cf(&cf, IteratorMode::From(pb, Direction::Forward));
        for item in iter {
            let (k, _) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("super_eligible iterator failed: {}", e))),
            };
            if !k.starts_with(pb) { break; }
            if let Ok(s) = std::str::from_utf8(&k[pb.len()..]) { out.push(s.to_string()); }
        }
        Ok(out)
    }

    /// B (liveness-from-chain): snapshot the finalized epoch's committed light-eligibility into a per-node
    /// recency index `light_elig_{epoch:010}_{node_id}`. Decodes the committed light bitmaps through the
    /// deterministic pre-epoch roster (SAME sharding the emission path uses), streamed (no O(roster) Vec)
    /// and chunked (bounded WriteBatch) for tens of millions of nodes. Read-only w.r.t. reward_root — the
    /// reward path recomputes from light_bm_ directly; this index only serves O(1) status recency.
    pub fn snapshot_light_eligible(&self, epoch: u64, cutoff: u64) -> IntegrationResult<usize> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let bitmaps = self.load_light_bitmaps(epoch).unwrap_or_default();
        let mut batch = rocksdb::WriteBatch::default();
        let (mut n, mut inbatch) = (0usize, 0usize);
        // Stable hash-shard (SAME as the bitmap builder + emission reader): bit i in shard g = the i-th
        // sorted roster node with light_shard_of()==g. Streamed (no O(roster) Vec), one walk.
        if !bitmaps.is_empty() {
            // Bit position is the node's PERMANENT reg_index, not a position in this scan. A
            // scan-relative ordinal shifted every later node whenever the roster changed, so the
            // bitmap was read at the wrong offsets — reporting the WRONG nodes, not fewer of them.
            let scan = self.light_roster_for_each(cutoff, |node_id, _w, reg_index| {
                let gidx = crate::node::light_shard_of(node_id);
                let bit = reg_index as usize;
                if let Some(bm) = bitmaps.get(&gidx) {
                    if bm.get(bit / 8).map(|b| b & (1 << (bit % 8)) != 0).unwrap_or(false) {
                        batch.put_cf(&cf, format!("light_elig_{:010}_{}", epoch, node_id).as_bytes(), &[]);
                        n += 1; inbatch += 1;
                        if inbatch >= 100_000 { let _ = self.persistent.db.write(std::mem::take(&mut batch)); inbatch = 0; }
                    }
                }
            });
            scan?;
        }
        // Recency needs ~2 epochs; range-delete anything older than a small window so the index stays
        // bounded (one range-delete, zero-padded key ⇒ lexical order == numeric order).
        if epoch >= 4 {
            batch.delete_range_cf(&cf, b"light_elig_0000000000_".as_ref(),
                format!("light_elig_{:010}_", epoch - 3).as_bytes());
        }
        self.persistent.db.write(batch)?;
        Ok(n)
    }

    /// B: did node_id attest in either of the last two COMMITTED epochs? Node-independent, two O(1)
    /// point-reads. The in-progress epoch (cur_height/14400) is not committed yet, so check e-1 and e-2.
    pub fn light_attested_recent_onchain(&self, node_id: &str, cur_height: u64) -> bool {
        let cf = match self.persistent.db.cf_handle("pending_rewards") { Some(c) => c, None => return false };
        let e = cur_height / 14400;
        for ep in [e.saturating_sub(1), e.saturating_sub(2)] {
            if self.persistent.db.get_cf(&cf, format!("light_elig_{:010}_{}", ep, node_id).as_bytes())
                .ok().flatten().is_some() { return true; }
        }
        false
    }

    /// Append an emission epoch to the sorted, append-only reward-epochs index (deduped).
    /// Lets the claim RPC enumerate exactly the epochs that carry a reward root in O(epochs)
    /// instead of scanning macroblock indices — so a wallet far behind on claims is found
    /// without any scan cap, and a batch claim can cover ALL unclaimed epochs at once.
    pub fn append_reward_epoch(&self, epoch: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        let key = b"reward_epochs_index";
        let mut list: Vec<u64> = match self.persistent.db.get_cf(&cf, key)? {
            Some(d) => bincode::deserialize(&d).unwrap_or_default(),
            None => Vec::new(),
        };
        if let Err(pos) = list.binary_search(&epoch) {
            list.insert(pos, epoch); // keep sorted + deduped
            let data = bincode::serialize(&list)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            self.persistent.db.put_cf(&cf, key, &data)?;
        }
        Ok(())
    }

    /// Load the sorted reward-epochs index (every emission epoch with a committed root).
    pub fn load_reward_epochs(&self) -> IntegrationResult<Vec<u64>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards column family not found".to_string()))?;
        match self.persistent.db.get_cf(&cf, b"reward_epochs_index")? {
            Some(d) => Ok(bincode::deserialize(&d).unwrap_or_default()),
            None => Ok(Vec::new()),
        }
    }


    
    // ============================================
    // SCALABILITY: NODE REGISTRY IN ROCKSDB
    // ============================================
    
    /// Save node registration information (for local cache only)
    /// NOTE: api_endpoint is now stored ON-CHAIN in NodeRegistration TX!
    /// Stores BOTH forward index (node_id → data) AND reverse index (wallet → node_id)
    /// for O(1) lookups in both directions.
    pub fn save_node_registration(&self, node_id: &str, node_type: &str, wallet: &str, reputation: f64) -> IntegrationResult<()> {
        self.save_node_registration_inner(node_id, node_type, wallet, reputation, None, None, None)
    }

    /// Block-apply registration: stamps the deterministic `reg_height` so the entry is recognised as
    /// chain-confirmed. Only such entries enter the reward roster (RPC-cache writes have no height).
    pub fn save_node_registration_at_height(&self, node_id: &str, node_type: &str, wallet: &str, reputation: f64, reg_height: u64) -> IntegrationResult<()> {
        self.save_node_registration_inner(node_id, node_type, wallet, reputation, Some(reg_height), None, None)
    }

    /// Chain-apply registration that also persists the backing `burn_tx` co-resident with `reg_height`
    /// in ONE node_ entry. This is the single authoritative writer of the burn binding: the committed
    /// burn→wallet index (cbw) is REBUILT deterministically from these entries on snapshot/reorg/boot
    /// (rebuild_committed_burn_wallet), and the registry digest (registry_root) hashes them. Genesis /
    /// non-burn callers use save_node_registration_at_height (burn empty). burn empty ⇒ binding skipped.
    pub fn save_node_registration_at_height_burn(&self, node_id: &str, node_type: &str, wallet: &str, reputation: f64, reg_height: u64, burn_tx: &str) -> IntegrationResult<()> {
        self.save_node_registration_inner(node_id, node_type, wallet, reputation, Some(reg_height), Some(burn_tx), None)
    }

    /// As above, but also binds the node's consensus pubkey (vrf_pk) into registry_root via the
    /// co-resident row. Used by the block-apply path (the on-chain NodeRegistration TX carries the key).
    /// Keyless callers (genesis/tests) use the plain variant (vrf None).
    pub fn save_node_registration_at_height_burn_vrf(&self, node_id: &str, node_type: &str, wallet: &str, reputation: f64, reg_height: u64, burn_tx: &str, vrf_pk: Option<&[u8]>) -> IntegrationResult<()> {
        self.save_node_registration_inner(node_id, node_type, wallet, reputation, Some(reg_height), Some(burn_tx), vrf_pk)
    }

    /// Roster-index value: `reg_height (8B BE) ++ reg_index (4B BE) ++ wallet`.
    ///
    /// reg_index rides here so a roster scan yields each node's permanent bitmap ordinal without a
    /// per-entry JSON parse of `node_<id>` — which is the entire reason these indices exist.
    pub(super) fn roster_index_value(reg_height: u64, reg_index: u32, wallet: &str) -> Vec<u8> {
        let mut val = Vec::with_capacity(12 + wallet.len());
        val.extend_from_slice(&reg_height.to_be_bytes());
        val.extend_from_slice(&reg_index.to_be_bytes());
        val.extend_from_slice(wallet.as_bytes());
        val
    }

    /// Inverse of `roster_index_value`. A short or non-UTF8 row is skipped, never defaulted.
    pub(super) fn decode_roster_index_value(v: &[u8]) -> Option<(u64, u32, &str)> {
        if v.len() < 12 { return None; }
        let h = u64::from_be_bytes(v[..8].try_into().ok()?);
        let idx = u32::from_be_bytes(v[8..12].try_into().ok()?);
        let wallet = std::str::from_utf8(&v[12..]).ok()?;
        Some((h, idx, wallet))
    }

    pub(super) fn save_node_registration_inner(&self, node_id: &str, node_type: &str, wallet: &str, reputation: f64, reg_height: Option<u64>, burn_tx: Option<&str>, vrf_pk: Option<&[u8]>) -> IntegrationResult<()> {
        // Held across the whole read-modify-write: the identity preservation below is only sound
        // if no other writer can slip a stamp in between the read and the batch write.
        let _row_guard = node_row_lock(node_id).lock();
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        // ATOMIC: WriteBatch ensures both forward and reverse indexes are written together
        // Prevents inconsistency if crash occurs between writes
        let mut batch = rocksdb::WriteBatch::default();

        // Forward index: node_id → data
        let key = format!("node_{}", node_id);
        // ALWAYS read the prior entry: needed both to preserve chain-confirmed fields against an
        // RPC-cache clobber AND to compute the registry_root LtHash delta (subtract the old row).
        let prior = self.persistent.db.get_cf(&registry_cf, key.as_bytes()).ok().flatten()
            .and_then(|old| serde_json::from_slice::<serde_json::Value>(&old).ok());
        let prior_height = prior.as_ref().and_then(|p| p["reg_height"].as_u64());

        // The chain-confirmed identity {wallet, reg_height, burn} is IMMUTABLE once stamped: those are
        // exactly the fields registry_root commits, so a non-deterministic RPC/discovery-cache write
        // (reg_height None) must NEVER rebind them — else node_ would diverge from lt_state → fork.
        // A chain-apply (reg_height Some) sets wallet; an RPC-cache write keeps the prior chain wallet.
        let final_wallet = if reg_height.is_some() {
            wallet.to_string()
        } else if prior_height.is_some() {
            prior.as_ref().and_then(|p| p["wallet"].as_str()).unwrap_or(wallet).to_string()
        } else {
            wallet.to_string()
        };
        // node_type is IMMUTABLE once chain-stamped, same rule as wallet. It is now folded into
        // row_lanes, and it decides light-roster membership at backfill — an RPC-cache write with a
        // peer-supplied type must never rebind it.
        let final_node_type = if reg_height.is_some() {
            node_type.to_string()
        } else if prior_height.is_some() {
            prior.as_ref().and_then(|p| p["node_type"].as_str()).unwrap_or(node_type).to_string()
        } else {
            node_type.to_string()
        };
        let mut data = json!({
            "node_type": final_node_type,
            "wallet": final_wallet,
            "reputation": reputation,
            "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
        });
        // reg_height is IMMUTABLE once chain-stamped (same invariant as wallet/burn): keep the FIRST
        // stamped height. A re-presented NodeActivation applies as an Ok no-op (single-use guard) yet
        // still re-pushes the super pseudonym row; without this it would re-stamp H1->H2 and, on a reorg
        // into [H1,H2), make the from-scratch recompute drop a row a never-reorged node still holds →
        // registry_root divergence. First chain-apply (prior None) uses the incoming height.
        if let Some(ph) = prior_height {
            data["reg_height"] = json!(ph);
        } else if let Some(h) = reg_height {
            data["reg_height"] = json!(h);
        }
        // burn binding: set when provided non-empty, else preserve a prior chain-confirmed burn.
        match burn_tx {
            Some(b) if !b.is_empty() => { data["burn"] = json!(b); }
            _ => {
                if let Some(b) = prior.as_ref().and_then(|p| p["burn"].as_str()) {
                    if !b.is_empty() { data["burn"] = json!(b); }
                }
            }
        }
        // vrf_pk_sha3: consensus-signer-key commitment, IMMUTABLE once stamped (same invariant as
        // wallet/burn/reg_height). sha3-256 of the node's consensus pubkey carried by the chain-apply
        // (NodeRegistration TX); co-resident here so the registry_root row field is byte-identical on
        // every node. A later RPC-cache write (vrf_pk None) preserves the stamped key. Light rows: "".
        let vrf_sha3_hex: String = match prior.as_ref().and_then(|p| p["vrf_pk_sha3"].as_str()) {
            Some(pv) if !pv.is_empty() => pv.to_string(),
            _ => match vrf_pk {
                Some(pk) if !pk.is_empty() => {
                    use sha3::{Digest, Sha3_256};
                    let mut h = Sha3_256::new();
                    Digest::update(&mut h, pk);
                    hex::encode(h.finalize())
                }
                _ => String::new(),
            },
        };
        if !vrf_sha3_hex.is_empty() { data["vrf_pk_sha3"] = json!(vrf_sha3_hex); }

        // reg_index: the node's permanent ordinal, assigned once from a monotone counter in THIS
        // batch. Bitmaps are indexed by it instead of by a position in a roster scan, where inserting
        // one registration shifted every later ordinal. Gate is byte-identical to the LtHash gate
        // below, so exactly the rows the root covers get an index. Immutable once stamped.
        //
        // The counter lives in the metadata CF, not in RAM: block apply is strictly serialized per
        // node, so read-modify-write inside the batch is race-free, and a process-local counter would
        // be RAM deciding a hashed field (I1).
        let space = Self::index_space_of(node_id, &final_node_type);
        let in_scope_for_index = space.is_some();
        let prior_index = prior.as_ref().and_then(|p| p["reg_index"].as_u64()).map(|v| v as u32);
        let final_index: u32 = match (prior_index, space) {
            (Some(existing), _) => existing,
            (None, Some(sp)) if reg_height.is_some() => {
                let mut counters = self.load_next_indices(&metadata_cf);
                let next = counters[sp];
                counters[sp] = next.saturating_add(1);
                batch.put_cf(&metadata_cf, Self::REGISTRY_NEXT_INDEX_KEY,
                             &Self::next_indices_bytes(&counters));
                next
            }
            _ => 0,
        };
        if reg_height.is_some() && in_scope_for_index {
            data["reg_index"] = json!(final_index);
        } else if let Some(existing) = prior_index {
            data["reg_index"] = json!(existing);
        }
        batch.put_cf(&registry_cf, key.as_bytes(), data.to_string().as_bytes());

        // No wallet→node reverse index: wallet→node is resolved by DERIVING the id (resolve_node_id) and
        // point-reading node_<id> — no mutable per-node slot exists to diverge across apply/gossip order.

        // Reward-roster indices (chain-confirmed only). Written in THIS batch so they are atomic
        // with the node_ entry and ride the node_registry snapshot (whole-CF copy). Keyed node_id-
        // first so a prefix scan yields the SAME node_id-ascending order the reward roster needs —
        // no JSON parse, no sort on the emission hot path. Gate = reg_height Some (first chain-apply):
        // RPC/discovery-cache writes (None) never index, mirroring the readers that skip un-stamped
        // entries; a later None re-cache preserves the prior height above and the index key already
        // exists, so we never write/delete on None. The super/light predicates are INDEPENDENT
        // (matching the two independent readers) — super keys on node_id prefix, light on node_type.
        if let Some(h) = reg_height {
            if node_id.starts_with("super_") || node_id.starts_with("genesis_node_") {
                let ik = format!("srtr_{}", node_id);
                // Value = reg_height (8B BE) ++ wallet, mirroring lrtr_. Carrying the height in the index
                // lets the producer/reward rosters apply their cutoff during the prefix scan, so the
                // height-bounded set costs one scan instead of a point-read + JSON parse per super.
                // Height IMMUTABLE once chain-stamped (same rule as the node_ row and lrtr_): keep the
                // FIRST stamped height, so an apply-history node and a snapshot-rebuilt node derive
                // byte-identical rosters for every cutoff.
                let eff_h = prior_height.unwrap_or(h);
                batch.put_cf(&registry_cf, ik.as_bytes(),
                             &Self::roster_index_value(eff_h, final_index, &final_wallet));
            }
            if final_node_type == "light" {
                let ik = format!("lrtr_{}", node_id);
                // Height IMMUTABLE once chain-stamped (mirror the node_ row above): keep the FIRST stamped
                // height, not a re-presented one, so the cutoff-filtered roster is byte-identical between an
                // apply-history node (this live write) and a snapshot/backfill-rebuilt node (which derives
                // lrtr_ from node_'s first-stamped reg_height). Using the raw incoming h would re-stamp
                // H1→H2 and, for any epoch cutoff in (H1,H2], shift the per-shard counter → reward_root fork.
                let eff_h = prior_height.unwrap_or(h);
                batch.put_cf(&registry_cf, ik.as_bytes(),
                             &Self::roster_index_value(eff_h, final_index, &final_wallet));
            }
        }

        // ── registry_root LtHash maintenance (incremental, O(1)) ──
        // Update the running multiset accumulator IN THE SAME BATCH as the node_ put, so node_ and
        // lt_state can never disagree across a crash. Gated on the CALL being a chain-apply
        // (reg_height param Some): block-apply is strictly serialized per node, so the load→delta→store
        // is race-free, and RPC-cache/discovery writes (None) are skipped entirely (they preserve the
        // chain-confirmed identity above, so they would be net-zero anyway — skipping avoids a
        // redundant lt_state write that could lost-update a concurrent chain-apply). Scope = exactly
        // the set compute_registry_root scans (super by node_id prefix OR node_type==light); node type
        // and id-prefix are immutable post-registration, so prior membership == current membership.
        // The delta = add(final row) - remove(prior row): a first registration adds once; a
        // re-registration subtracts the old identity and adds the new; an idempotent re-apply of the
        // same block reads back its own row (old==new) → net zero.
        if reg_height.is_some() {
            let in_scope = in_scope_for_index;
            if in_scope {
                let mut lt = self.registry_lt_load();
                // vrf_pk_sha3 is immutable, so old-row == new-row key bytes; decode both from their
                // own JSON for symmetry with the from-scratch rebuild.
                let final_vrf = hex::decode(&vrf_sha3_hex).unwrap_or_default();
                if let (Some(ph), Some(p)) = (prior_height, prior.as_ref()) {
                    let pw = p["wallet"].as_str().unwrap_or("");
                    let pb = p["burn"].as_str().unwrap_or("");
                    let pi = p["reg_index"].as_u64().unwrap_or(0) as u32;
                    let pt = p["node_type"].as_str().unwrap_or("");
                    let prior_vrf = p["vrf_pk_sha3"].as_str()
                        .and_then(|s| hex::decode(s).ok()).unwrap_or_default();
                    lt.remove(&crate::registry_lthash::row_lanes(node_id, pw, ph, pi, pt, pb, &prior_vrf));
                }
                let nh = data["reg_height"].as_u64().unwrap_or(0);
                let nb = data["burn"].as_str().unwrap_or("");
                let ni = data["reg_index"].as_u64().unwrap_or(0) as u32;
                lt.add(&crate::registry_lthash::row_lanes(
                    node_id, &final_wallet, nh, ni, &final_node_type, nb, &final_vrf));
                batch.put_cf(&metadata_cf, Self::REGISTRY_LT_STATE_KEY, lt.to_bytes().as_ref());
            }
        }

        // The raw consensus key rides the registration's own batch. Its only other writer is a
        // post-commit side effect that a replay never runs and a crash can lose, which is how a
        // restored node ended up unable to verify a producer it had committed to its own registry —
        // and a missing key is a hard block reject, so that node could never catch up again.
        // Same guards the standalone writer applies: never restate a pinned genesis identity, never
        // rebind an existing one.
        if let Some(pk) = vrf_pk {
            if !pk.is_empty() {
                let vrf_key = format!("vrf_pk_{}", node_id);
                let held = self.persistent.db.get_cf(&registry_cf, vrf_key.as_bytes()).ok().flatten();
                let anchor = qnet_consensus::consensus_crypto::get_consensus_pk_anchor(node_id);
                if held.is_none()
                    && !crate::genesis_constants::genesis_pk_overwrite_refused(anchor.as_deref(), pk)
                {
                    batch.put_cf(&registry_cf, vrf_key.as_bytes(), hex::encode(pk).as_bytes());
                }
            }
        }
        self.persistent.db.write(batch)?;

        Ok(())
    }

    /// Deterministic epoch roster of chain-confirmed Light nodes registered below `before_height`,
    /// sorted by node_id — the bit→node_id mapping for eligibility bitmaps, recomputable identically
    /// on every node. Reads the apply-time `lrtr_` index (prefix scan, node_id-ascending, no JSON,
    /// no sort) instead of a full-CF scan; byte-identical to `light_roster_sorted_scan` (asserted by
    /// a determinism test) but O(roster) without a per-entry JSON parse — scalable to millions.
    pub fn light_roster_sorted(&self, before_height: u64) -> IntegrationResult<Vec<(String, String)>> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let prefix = b"lrtr_";
        let mut out: Vec<(String, String)> = Vec::new();
        let iter = self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward));
        for item in iter {
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("light_roster_sorted iterator failed: {}", e))),
            };
            if !k.starts_with(prefix) { break; }
            let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s, Err(_) => continue };
            let (h, _idx, wallet) = match Self::decode_roster_index_value(&v) { Some(t) => t, None => continue };
            if h >= before_height { continue; }
            if !wallet.is_empty() { out.push((node_id.to_string(), wallet.to_string())); }
        }
        Ok(out)
    }

    // ── Native-QNC rich-list index (display) ─────────────────────────────────────────────────────
    // Top-K holders by balance, served O(K) without ever scanning all accounts. Keyed
    // `rlst_{(u64::MAX-balance) BE}_{addr}` so a forward prefix scan yields balance-descending,
    // address-ascending order. Companion `rlpos_{addr}` holds the indexed balance so an update knows
    // which sort key to delete; `rlcnt` is the holder count. Maintained incrementally at apply from a
    // block's touched addresses, rebuilt from live state at boot/snapshot/reorg. Display-only (in no
    // root/checkpoint), so a divergence or drift is cosmetic and self-heals on the next rebuild.

    pub(super) fn rlst_sort_key(addr: &str, balance: u64) -> Vec<u8> {
        let inv = (u64::MAX - balance).to_be_bytes();
        let mut k = Vec::with_capacity(5 + 8 + addr.len());
        k.extend_from_slice(b"rlst_");
        k.extend_from_slice(&inv);
        k.extend_from_slice(addr.as_bytes());
        k
    }

    /// Apply-time reconcile: `updates[i] = (addr, Some(balance))` when the address is a rich-list holder
    /// (non-contract, non-system, non-burn, balance>0), else `None` to remove it. One atomic batch;
    /// apply is serialized per node so the read-old → write-new is race-free. Maintains `rlcnt`.
    pub fn richlist_reconcile(&self, updates: &[(String, Option<u64>)]) -> IntegrationResult<()> {
        if updates.is_empty() { return Ok(()); }
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut batch = rocksdb::WriteBatch::default();
        let mut delta: i64 = 0;
        for (addr, new_bal) in updates {
            let pos_key = format!("rlpos_{}", addr);
            let old = self.persistent.db.get_cf(&cf, pos_key.as_bytes())?
                .and_then(|v| v.get(..8).and_then(|b| b.try_into().ok()).map(u64::from_be_bytes));
            if let Some(ob) = old {
                batch.delete_cf(&cf, Self::rlst_sort_key(addr, ob));
            }
            match new_bal {
                Some(nb) => {
                    batch.put_cf(&cf, Self::rlst_sort_key(addr, *nb), &nb.to_be_bytes());
                    batch.put_cf(&cf, pos_key.as_bytes(), &nb.to_be_bytes());
                    if old.is_none() { delta += 1; }
                }
                None => {
                    batch.delete_cf(&cf, pos_key.as_bytes());
                    if old.is_some() { delta -= 1; }
                }
            }
        }
        if delta != 0 {
            let cur = self.persistent.db.get_cf(&cf, b"rlcnt")?
                .and_then(|v| v.get(..8).and_then(|b| b.try_into().ok()).map(u64::from_be_bytes)).unwrap_or(0);
            let next = (cur as i64 + delta).max(0) as u64;
            batch.put_cf(&cf, b"rlcnt", &next.to_be_bytes());
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// Top-K holders (balance desc, address asc) — one bounded forward prefix scan, O(K).
    pub fn richlist_top_k(&self, k: usize) -> IntegrationResult<Vec<(String, u64)>> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let prefix = b"rlst_";
        let mut out: Vec<(String, u64)> = Vec::with_capacity(k.min(1024));
        let iter = self.persistent.db.iterator_cf(&cf, IteratorMode::From(prefix, Direction::Forward));
        for item in iter {
            if out.len() >= k { break; }
            let (key, val) = match item { Ok(kv) => kv, Err(_) => break };
            if !key.starts_with(prefix) { break; }
            if key.len() <= prefix.len() + 8 { continue; }
            let addr = match std::str::from_utf8(&key[prefix.len() + 8..]) { Ok(s) => s, Err(_) => continue };
            let bal = val.get(..8).and_then(|b| b.try_into().ok()).map(u64::from_be_bytes).unwrap_or(0);
            out.push((addr.to_string(), bal));
        }
        Ok(out)
    }

    /// Total rich-list holders (non-contract, non-system, non-burn, balance>0), O(1).
    pub fn richlist_holder_count(&self) -> u64 {
        match self.persistent.db.cf_handle("node_registry") {
            Some(cf) => self.persistent.db.get_cf(&cf, b"rlcnt").ok().flatten()
                .and_then(|v| v.get(..8).and_then(|b| b.try_into().ok()).map(u64::from_be_bytes)).unwrap_or(0),
            None => 0,
        }
    }

    /// Wipe the rich-list index (prefix range-deletes + reset count) — called before a full rebuild.
    pub fn richlist_clear(&self) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut batch = rocksdb::WriteBatch::default();
        // '`' (0x60) = '_'(0x5f)+1, so [start_prefix, prefix+'`') is exactly the prefix's key range.
        batch.delete_range_cf(&cf, b"rlst_".as_ref(), b"rlst`".as_ref());
        batch.delete_range_cf(&cf, b"rlpos_".as_ref(), b"rlpos`".as_ref());
        batch.delete_cf(&cf, b"rlcnt");
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// One-time marker so the O(N) rich-list rebuild scan runs once at boot, not on every restart.
    pub fn richlist_index_built(&self) -> bool {
        match self.persistent.db.cf_handle("node_registry") {
            Some(cf) => self.persistent.db.get_cf(&cf, b"meta_richlist_index_v1").map(|o| o.is_some()).unwrap_or(false),
            None => false,
        }
    }
    pub fn set_richlist_index_built(&self) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, b"meta_richlist_index_v1", b"1")?;
        Ok(())
    }

    /// Full rebuild by streaming the AUTHORITATIVE `accounts` CF (the complete hot∪cold mirror — persist-
    /// before-evict keeps it complete), not the bounded in-memory cache, so the index + holder_count are
    /// complete at any holder count. Runs entirely off the state lock; clears then repopulates in bounded
    /// batches. Returns Err on a storage failure so the caller can leave the one-time marker unset for retry.
    /// Returns the number of account rows SCANNED — not holders. The caller uses it to decide
    /// whether the one-time marker may be set: a rebuild that saw an empty accounts CF (a node that
    /// has not restored state yet) did no work, and marking it done leaves the index permanently
    /// dependent on the incremental path alone.
    pub fn richlist_rebuild_from_accounts(&self) -> IntegrationResult<u64> {
        use qnet_state::transaction::CANONICAL_BURN_ADDR;
        self.richlist_clear()?;
        let accounts_cf = self.persistent.db.cf_handle("accounts")
            .ok_or_else(|| IntegrationError::StorageError("accounts column family not found".to_string()))?;
        let mut batch: Vec<(String, Option<u64>)> = Vec::with_capacity(10_000);
        let mut scanned: u64 = 0;
        let mut total: u64 = 0;
        for item in self.persistent.db.iterator_cf(&accounts_cf, rocksdb::IteratorMode::Start) {
            let (k, v) = item.map_err(|e| IntegrationError::StorageError(format!("richlist_iter_err: {}", e)))?;
            scanned = scanned.saturating_add(1);
            let addr = match String::from_utf8(k.to_vec()) { Ok(s) => s, Err(_) => continue };
            if addr.as_str() == CANONICAL_BURN_ADDR || addr.starts_with("system_") { continue; }
            let acct: qnet_state::Account = match bincode::deserialize(&v) { Ok(a) => a, Err(_) => continue };
            if acct.is_contract || acct.balance == 0 { continue; }
            batch.push((addr, Some(acct.balance)));
            if batch.len() >= 10_000 {
                self.richlist_reconcile(&batch)?;
                total = total.saturating_add(batch.len() as u64);
                batch.clear();
            }
        }
        if !batch.is_empty() {
            total = total.saturating_add(batch.len() as u64);
            self.richlist_reconcile(&batch)?;
        }
        if crate::node::is_info() {
            println!("[INFO][RICHLIST] index_rebuilt holders={} scanned={}", total, scanned);
        }
        Ok(scanned)
    }

    /// Heartbeat liveness index write (apply path). Key `lhb_{anchor_subwindow:010}_{node_id}` →
    /// first inclusion height (8B BE). First-write-wins keeps the MIN inclusion height, so a reader
    /// bounded by scan_end reproduces the canonical body scan exactly (any inclusion of a cur/prev-
    /// subwindow anchor is ≥ subwindow start, so `min ≤ scan_end` ⟺ `∃ inclusion ≤ scan_end`).
    /// Lives in node_registry CF (rides the CF snapshot; NOT in registry_root — that scans only
    /// srtr_/lrtr_/node_ rows). Prunes subwindows < sw-2 via one range-delete (bounded: ~3 subwindows
    /// × supers). Apply is serialized per node ⇒ the get-then-put is race-free.
    pub fn index_heartbeat_inclusion(&self, node_id: &str, anchor_height: u64, included_height: u64) -> IntegrationResult<()> {
        // Same freshness rule the REWARD bit enforces in the apply arm: an anchor must be strictly past
        // and within HB_ANCHOR_MAX_LAG. Without it a stale heartbeat granted producer eligibility while
        // granting no reward — two liveness accounts drawn from different accept-sets. Enforced at the
        // single writer so the producer-inline and peer-apply callers cannot drift apart.
        if anchor_height >= included_height
            || included_height - anchor_height > crate::node::HB_ANCHOR_MAX_LAG {
            return Ok(());
        }
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let sw = anchor_height / 1440;
        let key = format!("lhb_{:010}_{}", sw, node_id);
        if self.persistent.db.get_cf(&registry_cf, key.as_bytes())?.is_none() {
            self.persistent.db.put_cf(&registry_cf, key.as_bytes(), &included_height.to_be_bytes())?;
        }
        // Prune once per subwindow advance (metadata watermark), not per heartbeat.
        //
        // RETENTION MUST COVER THE ROSTER-DERIVATION HORIZON. The reader needs the current and previous
        // subwindow AT THE WINDOW BEING DERIVED, and since production may run MAX_DERIVED_ROSTER_WINDOWS
        // past the last seal, a snapshot can be recomputed that far below the live tip. Keeping only
        // sw-2 would make the answer depend on how deep THIS node's seal is — i.e. on local index
        // availability — and that answer lands in eligible_producers → epoch_commitment, which is
        // byte-compared. Retaining the horizon plus the reader's own 2-subwindow span makes it a
        // function of the height alone.
        if sw >= LHB_RETAINED_SUBWINDOWS {
            let meta_cf = self.persistent.db.cf_handle("metadata")
                .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
            let want = sw - LHB_RETAINED_SUBWINDOWS;
            let have = self.persistent.db.get_cf(&meta_cf, b"lhb_pb")?
                .and_then(|v| v[..8.min(v.len())].try_into().ok().map(u64::from_be_bytes)).unwrap_or(0);
            if want > have {
                let mut batch = rocksdb::WriteBatch::default();
                batch.delete_range_cf(&registry_cf, b"lhb_0000000000_".as_ref(), format!("lhb_{:010}_", want).as_bytes());
                batch.put_cf(&meta_cf, b"lhb_pb", &want.to_be_bytes());
                self.persistent.db.write(batch)?;
            }
        }
        Ok(())
    }

    /// Indexed replacement for the recent-Heartbeat body scan: node_ids with a Heartbeat anchored in
    /// subwindow cur/prev and included at ≤ scan_end. Two bounded prefix scans, O(recent supers) —
    /// no block-body deserialization. Byte-identical to the body scan (determinism test).
    pub fn recent_heartbeat_senders_indexed(&self, cur_idx: u64, prev_idx: u64, scan_end: u64) -> IntegrationResult<std::collections::HashSet<String>> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        // FAIL-CLOSED. If either subwindow sits at or below the prune watermark the index no longer holds
        // the full answer, and a partial liveness set silently changes roster membership on THIS node
        // only. Refuse instead: the caller abstains and syncs. This is what keeps a future change to the
        // derivation horizon a stall rather than a fork.
        if let Some(meta_cf) = self.persistent.db.cf_handle("metadata") {
            if let Ok(Some(v)) = self.persistent.db.get_cf(&meta_cf, b"lhb_pb") {
                let pruned_below = v[..8.min(v.len())].try_into().ok().map(u64::from_be_bytes).unwrap_or(0);
                if pruned_below > 0 && prev_idx.min(cur_idx) < pruned_below {
                    return Err(IntegrationError::StorageError(format!(
                        "lhb_index_pruned needed_sw={} pruned_below={}", prev_idx.min(cur_idx), pruned_below)));
                }
            }
        }
        let mut out: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut idxs = [cur_idx, prev_idx];
        idxs.sort_unstable();
        let scan = |idx: u64, out: &mut std::collections::HashSet<String>| -> IntegrationResult<()> {
            let prefix = format!("lhb_{:010}_", idx);
            for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix.as_bytes(), Direction::Forward)) {
                let (k, v) = match item {
                    Ok(kv) => kv,
                    Err(e) => return Err(IntegrationError::StorageError(
                        format!("heartbeat_senders iterator failed: {}", e))),
                };
                if !k.starts_with(prefix.as_bytes()) { break; }
                if v.len() < 8 { continue; }
                let inc = u64::from_be_bytes(v[..8].try_into().unwrap_or([0u8; 8]));
                if inc <= scan_end {
                    if let Ok(id) = std::str::from_utf8(&k[prefix.len()..]) { out.insert(id.to_string()); }
                }
            }
            Ok(())
        };
        scan(idxs[0], &mut out)?;
        if idxs[1] != idxs[0] { scan(idxs[1], &mut out)?; }
        Ok(out)
    }

    /// True if `node_id` has an on-chain Heartbeat in the current or previous 1440-block
    /// subwindow at `cur_height` — the deterministic liveness answer identical on every node
    /// (two lhb_ point-reads). The RAM peer view can lag a healthy node after reconnects.
    pub fn heartbeat_recent_onchain(&self, node_id: &str, cur_height: u64) -> bool {
        let registry_cf = match self.persistent.db.cf_handle("node_registry") {
            Some(cf) => cf,
            None => return false,
        };
        let cur = cur_height / 1440;
        for sw in [cur, cur.saturating_sub(1)] {
            let key = format!("lhb_{:010}_{}", sw, node_id);
            if let Ok(Some(v)) = self.persistent.db.get_cf(&registry_cf, key.as_bytes()) {
                if v.len() >= 8
                    && u64::from_be_bytes(v[..8].try_into().unwrap_or([0u8; 8])) <= cur_height {
                    return true;
                }
            }
        }
        false
    }

    /// Streaming lrtr_ walk (reg_height < before_height), node_id-ascending — same rows and order as
    /// `light_roster_sorted` but O(1) memory: the reward reader at millions of light nodes must not
    /// collect the roster into a Vec on the emission path.
    pub fn light_roster_for_each<F: FnMut(&str, &str, u32)>(&self, before_height: u64, mut f: F) -> IntegrationResult<()> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let prefix = b"lrtr_";
        for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward)) {
            // Truncating here silently shrinks the light reward roster on one node; fail closed.
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("light_roster_for_each iterator failed: {}", e))),
            };
            if !k.starts_with(prefix) { break; }
            let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s, Err(_) => continue };
            let (h, idx, wallet) = match Self::decode_roster_index_value(&v) { Some(t) => t, None => continue };
            if h >= before_height { continue; }
            if !wallet.is_empty() { f(node_id, wallet, idx); }
        }
        Ok(())
    }

    /// Canonicalize the lhb_ index at a height reset (boot / snapshot-apply / reorg): drop entries
    /// included above the new tip, then re-index from the retained bodies of the last 3 subwindows
    /// (first-write-wins ⇒ idempotent; missing bodies skip — the CF-snapshot-carried index covers them).
    /// Keeps index == canonical chain on every path an old-binary or fork could have diverged.
    pub fn canonicalize_heartbeat_index(&self, up_to_height: u64) -> IntegrationResult<()> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut batch = rocksdb::WriteBatch::default();
        for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(b"lhb_", Direction::Forward)) {
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("heartbeat_canonicalize iterator failed: {}", e))),
            };
            if !k.starts_with(b"lhb_") { break; }
            let inc = if v.len() >= 8 { u64::from_be_bytes(v[..8].try_into().unwrap_or([0u8; 8])) } else { u64::MAX };
            if inc > up_to_height { batch.delete_cf(&registry_cf, &k); }
        }
        self.persistent.db.write(batch)?;
        // Same span as the prune floor, or a boot/reorg re-canonicalise would re-narrow the index the
        // deep readers depend on.
        let start_sw = (up_to_height / 1440).saturating_sub(LHB_RETAINED_SUBWINDOWS);
        for h in start_sw.saturating_mul(1440)..=up_to_height {
            if let Ok(Some(block)) = self.load_microblock_auto_format(h) {
                for tx in &block.transactions {
                    if let qnet_state::TransactionType::Heartbeat { node_id, anchor_height, .. } = &tx.tx_type {
                        let _ = self.index_heartbeat_inclusion(node_id, *anchor_height, h);
                    }
                }
            }
        }
        Ok(())
    }

    /// Sorted (node_id, wallet) of all chain-registered Super/genesis nodes — the deterministic
    /// candidate set for heartbeat-eligibility reward enumeration (popcount filter applied by caller).
    /// Reads the apply-time `srtr_` index (prefix scan, node_id-ascending, no JSON, no sort);
    /// byte-identical to `super_registrations_sorted_scan` but O(supers) without a per-entry parse.
    pub fn super_registrations_sorted(&self) -> IntegrationResult<Vec<(String, String)>> {
        let mut out: Vec<(String, String)> = Vec::new();
        self.super_roster_for_each(|node_id, wallet, _h, _idx| out.push((node_id.to_string(), wallet.to_string())))?;
        Ok(out)
    }

    /// The SUPER roster as of `up_to_height`: (node_id, wallet) for every chain-confirmed super whose
    /// `reg_height <= up_to_height`, ascending by node_id.
    ///
    /// This is the height-bounded twin of `super_registrations_sorted`, which has no height dimension at
    /// all and therefore returns whatever this node has applied RIGHT NOW. That set is a property of the
    /// applied branch, not of a height — and it is the input to the eligible-producer snapshot, whose
    /// output goes into `epoch_commitment` and thence into a QC. Today the divergence is masked because
    /// a per-candidate reg-height filter runs downstream; deriving the pool at the height in the first
    /// place removes the superset-then-filter pattern, so there is no window in which the two can differ.
    ///
    /// Both keys are pruned together on reorg/boot/snapshot canonicalisation, so `srtr_` is a sound
    /// membership index; the `node_` row supplies the height and the wallet.
    pub fn super_registrations_as_of(&self, up_to_height: u64) -> IntegrationResult<Vec<(String, String)>> {
        let mut out: Vec<(String, String)> = Vec::new();
        self.super_roster_for_each(|node_id, wallet, h, _idx| {
            if h <= up_to_height { out.push((node_id.to_string(), wallet.to_string())); }
        })?;
        Ok(out)
    }

    /// One ascending pass over the `srtr_` index, yielding (node_id, wallet, reg_height) straight from
    /// the index value. The single decoder for that value — every roster reader goes through it, so the
    /// encoding can never be read two different ways.
    pub(super) fn super_roster_for_each<F: FnMut(&str, &str, u64, u32)>(&self, mut f: F) -> IntegrationResult<()> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let prefix = b"srtr_";
        for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward)) {
            // A mid-iteration RocksDB error must NOT return a truncated roster as Ok: this set feeds
            // eligible_producers -> epoch_commitment, so a short read is a divergent commitment on one
            // node, not a smaller roster.
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("super_roster_for_each iterator failed: {}", e))),
            };
            if !k.starts_with(prefix) { break; }
            let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(x) => x, Err(_) => continue };
            let (h, idx, wallet) = match Self::decode_roster_index_value(&v) { Some(t) => t, None => continue };
            if wallet.is_empty() { continue; }
            f(node_id, wallet, h, idx);
        }
        Ok(())
    }

    /// Durable NodeRegistration-origin marker. Written ONLY by write_registration_row, so the set
    /// is exactly what the in-memory dedup map holds — activations write registry rows too, and
    /// reseeding from those would reject honest re-registrations.
    pub fn mark_node_registration_origin(&self, node_id: &str, wallet: &str) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        self.persistent.db.put_cf(&cf, format!("nreg_{}", node_id).as_bytes(), wallet.as_bytes())?;
        Ok(())
    }

    /// The registration-origin set: node_id -> wallet for every applied NodeRegistration.
    pub fn load_registration_origins(&self) -> IntegrationResult<Vec<(String, String)>> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let mut out = Vec::new();
        for item in self.persistent.db.prefix_iterator_cf(&cf, b"nreg_") {
            let (k, v) = match item { Ok(kv) => kv, Err(_) => continue };
            if !k.starts_with(b"nreg_") { break; }
            let id = match std::str::from_utf8(&k[5..]) { Ok(s) => s.to_string(), Err(_) => continue };
            let w = match std::str::from_utf8(&v) { Ok(s) => s.to_string(), Err(_) => continue };
            out.push((id, w));
        }
        Ok(out)
    }

    /// Every CHAIN-CONFIRMED node_id->wallet binding in the node_registry CF (super/genesis AND light,
    /// all types). Used to rebuild the in-mem `registered_nodes` NodeRegistration-dedup map on cold-join:
    /// the CF is snapshot-bound (registry_root in the QC Checkpoint), so deriving the dedup set from it is
    /// sound. Mirrors the `node_` decode used by backfill_roster_indices / rebuild_committed_burn_wallet
    /// (key `node_<id>`, JSON value, `wallet` field). Skips entries WITHOUT `reg_height` (non-deterministic
    /// RPC/discovery cache writes) so the set is identical to a from-genesis node — distinct from
    /// load_all_node_registrations, which is the startup P2P-registry restore and includes unconfirmed rows.
    /// Reset the derived commitment-dedup maps and reseed `registered_nodes` from the durable
    /// node_registry CF (bound by registry_root in the QC Checkpoint). THE single entry point for
    /// every path that rebuilds the chain view from a snapshot — cold-join rehydrate, boot restore
    /// and post-rollback reconcile — so the three cannot drift apart. Must run AFTER
    /// `rebuild_registry_lthash`, which prunes rows above the tip; reseeding first would re-import
    /// the very orphans that prune exists to drop.
    pub fn reseed_commitment_dedup(&self, sg: &qnet_state::State) -> IntegrationResult<usize> {
        sg.reset_commitment_dedup();
        let regs = self.registry_root_covered_origins()?;
        let n = regs.len();
        for (node_id, wallet) in regs {
            sg.seed_registered_node(&node_id, &wallet);
        }
        println!("[INFO][STATE] commitment_dedup_reseeded registered={}", n);
        Ok(n)
    }

    /// Is this node_registry key one that `registry_root` covers? Only these may be imported from a
    /// snapshot; every other prefix (`vrf_pk_`, `nreg_`, `lhb_`, endpoints, caches) is unbound peer
    /// data and is re-derived locally from the covered rows after promote.
    pub(crate) fn registry_key_is_root_covered(k: &[u8]) -> bool {
        // `node_<id>` ONLY. compute_lt_state_cf enumerates srtr_/lrtr_ by KEY and folds the payload out
        // of node_<id>, so the index VALUES (reg_height ++ payout wallet) are outside the root — and
        // super_roster_for_each reads both straight out of them. Importing them would let a snapshot
        // server dictate a joiner's payout wallets and effective reg_heights. They are a pure function
        // of the covered rows, so backfill_roster_indices rebuilds them byte-identically.
        k.starts_with(b"node_")
    }

    /// Does a staged `vrf_pk_<id>` value hash to the commitment in the staged, root-covered
    /// `node_<id>.vrf_pk_sha3`? Only then may it become the key the QC verifier resolves against.
    pub(super) fn staged_vrf_pk_matches_commitment(
        db: &rocksdb::DB, stage: &impl rocksdb::AsColumnFamilyRef, node_id: &str, pk: &[u8],
    ) -> bool {
        let raw = match db.get_cf(stage, format!("node_{}", node_id).as_bytes()) {
            Ok(Some(v)) => v, _ => return false,
        };
        let parsed: serde_json::Value = match serde_json::from_slice(&raw) { Ok(p) => p, Err(_) => return false };
        // reg_height present == chain-confirmed, the same filter the root's fold applies.
        if parsed["reg_height"].as_u64().is_none() { return false; }
        match parsed["vrf_pk_sha3"].as_str() {
            Some(tag) if !tag.is_empty() => {
                use sha3::{Digest, Sha3_256};
                hex::encode(Sha3_256::digest(pk)) == tag
            }
            _ => false,
        }
    }

    /// Every `(node_id, wallet)` binding `registry_root` actually covers: the same `srtr_`/`lrtr_` ->
    /// `node_<id>` traversal `compute_lt_state_cf` folds, chain-confirmed only.
    ///
    /// The dedup seed used to read the `nreg_` prefix, which the root does NOT cover, while a snapshot
    /// is imported unfiltered — so one injected `nreg_<victim>` row made a joiner skip that node's real
    /// registration as a duplicate and left its `registry_root` permanently one row short.
    pub fn registry_root_covered_origins(&self) -> IntegrationResult<Vec<(String, String)>> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let mut out = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for prefix in [b"srtr_".as_ref(), b"lrtr_".as_ref()] {
            for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(prefix, Direction::Forward)) {
                let (k, _) = match item {
                    Ok(kv) => kv,
                    Err(e) => return Err(IntegrationError::StorageError(
                        format!("registry_root_covered_origins iterator failed: {}", e))),
                };
                if !k.starts_with(prefix) { break; }
                let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s.to_string(), Err(_) => continue };
                if !seen.insert(node_id.clone()) { continue; } // already counted under the other prefix
                let nk = format!("node_{}", node_id);
                let val = match self.persistent.db.get_cf(&cf, nk.as_bytes()) { Ok(Some(v)) => v, _ => continue };
                let parsed: serde_json::Value = match serde_json::from_slice(&val) { Ok(p) => p, Err(_) => continue };
                // reg_height present == chain-confirmed. Its ABSENCE is what excludes the
                // non-deterministic RPC/discovery cache writes, exactly as the root's fold does.
                if parsed["reg_height"].as_u64().is_none() { continue; }
                // `registered_nodes` is written ONLY by NodeRegistration, but an activation also writes
                // a roster row. Seeding from every roster row makes a restarted node reject a genuine
                // later registration that every running node accepts — and a registration has no
                // account effect, so state_root still agrees while registry_root goes one row short.
                // Every gated registration carries a burn; activations do not. Genesis is exempt.
                let has_burn = parsed["burn"].as_str().map_or(false, |b| !b.is_empty());
                if !has_burn && !node_id.starts_with("genesis_node_") { continue; }
                let wallet = parsed["wallet"].as_str().unwrap_or("").to_string();
                if wallet.is_empty() { continue; }
                out.push((node_id, wallet));
            }
        }
        Ok(out)
    }

    pub(crate) fn epoch_root_key(epoch: u64) -> String { format!("epoch_root_{:010}", epoch) }

    /// Write a raw node_registry row. Test-only: the point of these tests is what happens when rows
    /// arrive from OUTSIDE the apply path — i.e. from an imported snapshot — so they must be placed
    /// without going through the writers that would sanitise them.
    #[cfg(test)]
    pub fn put_registry_row_for_test(&self, cf: &str, key: &[u8], val: &[u8]) {
        let h = self.persistent.db.cf_handle(cf).expect("registry CF");
        self.persistent.db.put_cf(&h, key, val).expect("put registry row");
    }

    #[cfg(test)]
    pub fn registry_cf_for_test(&self) -> String { "node_registry".to_string() }

    #[cfg(test)]
    pub fn wipe_epoch_root_cache_for_test(&self) {
        let _ = self.clear_cf("pending_rewards");
    }

    #[cfg(test)]
    pub fn seed_epoch_root_for_test(&self, epoch: u64, root: [u8; 32]) {
        let cf = self.persistent.db.cf_handle("pending_rewards").expect("pending_rewards CF");
        self.persistent.db.put_cf(&cf, Self::epoch_root_key(epoch).as_bytes(), &root).expect("seed root");
    }

    /// Verify the staged epoch roots against the anchor's certified commitment and ONLY THEN write
    /// them live. Nothing is mutated on the reject path, so a forged snapshot leaves no trace and the
    /// retry starts clean. Bounded by the same N-2 rule the commitment uses: rows above it are not
    /// covered by the proof, so they are dropped rather than trusted.
    pub(super) fn carry_and_verify_epoch_roots(&self, anchor_height: u64) -> IntegrationResult<usize> {
        let mb_index = anchor_height / qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
        // The proof target is Checkpoint.reward_epoch_root; it only authenticates a snapshot once the
        // committee compares it (feature_gates: reward_epoch_root_required), so the carry follows the
        // same gate. Active from genesis — this branch exists for a staged rollout, not for normal use.
        if !qnet_state::feature_gates::is_active("reward_epoch_root_required", anchor_height) {
            // Unreachable while the gate is active. Leave the live CF ALONE: carrying nothing is one
            // thing, wiping the rows a from-genesis node already holds is another.
            println!("[WARN][SNAPSHOT] epoch_roots_carry_skipped anchor_h={} reason=authenticator_gated_off", anchor_height);
            return Ok(0);
        }
        let certified = self.get_macroblock_by_height(mb_index)?
            .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok())
            .and_then(|mb| mb.consensus_data.checkpoint_qc)
            .and_then(|q| bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint,
                                                  qnet_consensus::checkpoint_bft::QuorumCertificate)>(&q).ok())
            .map(|(cp, _)| cp.reward_epoch_root)
            .ok_or_else(|| IntegrationError::StorageError(format!(
                "epoch_roots_unprovable anchor_mb={} (no certified commitment to prove against)", mb_index)))?;

        // ONLY the proven band is carried. The staged CF is NOT bound by anything (the binder covers
        // accounts/state_root, node_registry/registry_root and dpk_root — not this), so an unproven
        // row is attacker-chosen, and root_for_apply reads the cache before the macroblock, making it
        // sticky and authoritative. The (N-2, anchor] band is exactly {mb_idx-1, mb_idx}, whose
        // macroblocks the lineage walk guarantees present, so derive_epoch_root_from_macroblock
        // rebuilds them — dropping them costs nothing.
        let n2 = mb_index.saturating_sub(2);
        let mut carried: Vec<(u64, [u8; 32])> = Vec::new();
        if let Some(st) = self.persistent.db.cf_handle("pending_rewards_stage") {
            for item in self.persistent.db.iterator_cf(&st, rocksdb::IteratorMode::Start).flatten() {
                let (k, v) = item;
                if !k.starts_with(b"epoch_root_") || v.len() != 32 { continue; }
                let digits = match std::str::from_utf8(&k[11..]) { Ok(d) => d, Err(_) => continue };
                let epoch = match digits.parse::<u64>() { Ok(e) => e, Err(_) => continue };
                // Canonical key only: a non-padded or off-grid key is not something the canonical
                // writer produces, and admitting one lets a staged row be folded that the
                // commitment's grid walk can never reach.
                if digits.len() != 10 || Self::epoch_root_key(epoch).as_bytes() != k.as_ref() { continue; }
                if !crate::reward_epoch::is_reward_epoch(epoch) { continue; }
                // Band test WITHOUT arithmetic on the untrusted epoch: n2 - MB_PER_EPOCH is the
                // largest epoch the certificate covers.
                // Same predicate as the commitment, expressed without adding to the untrusted epoch:
                // saturating_sub collapses to 0 when n2 < MB_PER_EPOCH and would admit epoch 0 that
                // the commitment excludes, so a cold join at anchor macroblock 160 would mismatch.
                if n2 < crate::reward_epoch::MB_PER_EPOCH
                    || epoch > n2 - crate::reward_epoch::MB_PER_EPOCH { continue; }
                let mut r = [0u8; 32];
                r.copy_from_slice(&v);
                carried.push((epoch, r));
            }
        }
        carried.sort_by_key(|(e, _)| *e);

        let mut lt = crate::registry_lthash::LtHash::new();
        for (e, r) in &carried { lt.add(&crate::reward_epoch::epoch_root_lanes(*e, r)); }
        if lt.root() != certified {
            return Err(IntegrationError::StorageError(format!(
                "epoch_roots_mismatch anchor_h={} carried={} local={} certified={}",
                anchor_height, carried.len(),
                hex::encode(&lt.root()[..8]), hex::encode(&certified[..8]))));
        }

        // Proven — now, and only now, replace the live set.
        let live = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards CF not found".to_string()))?;
        // Replace ONLY the epoch-root rows. This CF also holds super_elig_/light_bm_/lelig_ and the
        // reward shards; wiping those costs a from-genesis node data it cannot re-derive.
        let mut batch = WriteBatch::default();
        for item in self.persistent.db
            .iterator_cf(&live, rocksdb::IteratorMode::From(b"epoch_root_", rocksdb::Direction::Forward))
            .flatten()
        {
            let (k, _) = item;
            if !k.starts_with(b"epoch_root_") { break; }
            batch.delete_cf(&live, &k);
        }
        for (e, r) in &carried {
            batch.put_cf(&live, Self::epoch_root_key(*e).as_bytes(), r);
        }
        self.persistent.db.write(batch)?;
        self.clear_epoch_fold_head(); // the root set was replaced wholesale
        println!("[INFO][SNAPSHOT] epoch_roots_verified anchor_h={} count={}", anchor_height, carried.len());
        Ok(carried.len())
    }

    /// Memo for the epoch-root commitment: folded lanes covering every epoch <= `last_epoch`. A pure
    /// cache — dropping it costs one re-walk, never correctness.
    pub fn load_epoch_fold_head(&self) -> Option<(u64, [u16; crate::registry_lthash::LANES])> {
        let cf = self.persistent.db.cf_handle("pending_rewards")?;
        let v = self.persistent.db.get_cf(&cf, b"epoch_fold_head").ok()??;
        if v.len() != 8 + crate::registry_lthash::LANES * 2 { return None; }
        let mut eb = [0u8; 8];
        eb.copy_from_slice(&v[..8]);
        let mut lanes = [0u16; crate::registry_lthash::LANES];
        for (i, l) in lanes.iter_mut().enumerate() {
            *l = u16::from_le_bytes([v[8 + i * 2], v[9 + i * 2]]);
        }
        Some((u64::from_le_bytes(eb), lanes))
    }

    pub fn save_epoch_fold_head(&self, last_epoch: u64, lanes: &[u16; crate::registry_lthash::LANES]) {
        if let Some(cf) = self.persistent.db.cf_handle("pending_rewards") {
            let mut v = Vec::with_capacity(8 + lanes.len() * 2);
            v.extend_from_slice(&last_epoch.to_le_bytes());
            for l in lanes.iter() { v.extend_from_slice(&l.to_le_bytes()); }
            let _ = self.persistent.db.put_cf(&cf, b"epoch_fold_head", &v);
        }
    }

    /// Drop the memo whenever the underlying root set is replaced wholesale (snapshot carry).
    pub fn clear_epoch_fold_head(&self) {
        if let Some(cf) = self.persistent.db.cf_handle("pending_rewards") {
            let _ = self.persistent.db.delete_cf(&cf, b"epoch_fold_head");
        }
    }

    /// Derive an epoch's root from the macroblock this node already holds, and cache it.
    /// Makes `epoch_root_` a true cache: wiping it (snapshot promote) costs a re-derivation, never
    /// correctness, and a macroblock stored before the row existed still resolves.
    pub fn derive_epoch_root_from_macroblock(&self, epoch: u64) -> IntegrationResult<Option<[u8; 32]>> {
        let mb_index = match crate::reward_epoch::certifying_mb_index(epoch) {
            Some(m) => m,
            None => return Ok(None), // overflowed ⇒ not a real epoch, never write a row for it
        };
        let bytes = match self.get_macroblock_by_height(mb_index)? { Some(b) => b, None => return Ok(None) };
        let mb: qnet_state::MacroBlock = match bincode::deserialize(&bytes) { Ok(m) => m, Err(_) => return Ok(None) };
        let root = match mb.consensus_data.checkpoint_qc.as_ref()
            .and_then(|b| bincode::deserialize::<(qnet_consensus::checkpoint_bft::Checkpoint,
                                                  qnet_consensus::checkpoint_bft::QuorumCertificate)>(b).ok())
            .map(|(cp, _)| cp.reward_root) {
            Some(r) => r,
            None => return Ok(None),
        };
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards CF not found".to_string()))?;
        self.persistent.db.put_cf(&cf, Self::epoch_root_key(epoch).as_bytes(), &root)?;
        Ok(Some(root))
    }

    /// The certified root for `epoch`, or None if this node has not stored its macroblock yet.
    /// All-zero is a real value (nothing was distributed), distinct from absent.
    pub fn load_epoch_root(&self, epoch: u64) -> IntegrationResult<Option<[u8; 32]>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards CF not found".to_string()))?;
        match self.persistent.db.get_cf(&cf, Self::epoch_root_key(epoch).as_bytes())? {
            Some(v) if v.len() == 32 => {
                let mut r = [0u8; 32];
                r.copy_from_slice(&v);
                Ok(Some(r))
            }
            _ => Ok(None),
        }
    }

    /// Every epoch whose root this node holds, ascending. Range scan, no separate index to drift.
    pub fn reward_epochs_from(&self, start: u64) -> IntegrationResult<Vec<u64>> {
        let cf = self.persistent.db.cf_handle("pending_rewards")
            .ok_or_else(|| IntegrationError::StorageError("pending_rewards CF not found".to_string()))?;
        let from = Self::epoch_root_key(start);
        let mut out = Vec::new();
        let iter = self.persistent.db.iterator_cf(
            &cf, rocksdb::IteratorMode::From(from.as_bytes(), rocksdb::Direction::Forward));
        for item in iter.flatten() {
            let (k, _) = item;
            if !k.starts_with(b"epoch_root_") { break; }
            if let Some(e) = std::str::from_utf8(&k[11..]).ok().and_then(|d| d.parse::<u64>().ok()) {
                out.push(e);
            }
        }
        Ok(out)
    }

    pub fn load_confirmed_node_registrations(&self) -> IntegrationResult<Vec<(String, String)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut out: Vec<(String, String)> = Vec::new();
        for item in self.persistent.db.prefix_iterator_cf(&registry_cf, b"node_") {
            let (k, v) = match item { Ok(kv) => kv, Err(_) => continue };
            let key = match std::str::from_utf8(&k) { Ok(s) => s, Err(_) => continue };
            let node_id = match key.strip_prefix("node_") { Some(id) => id, None => continue };
            let parsed: serde_json::Value = match serde_json::from_slice(&v) { Ok(p) => p, Err(_) => continue };
            if parsed["reg_height"].as_u64().is_none() { continue; } // chain-confirmed only
            let wallet = parsed["wallet"].as_str().unwrap_or("");
            if !wallet.is_empty() { out.push((node_id.to_string(), wallet.to_string())); }
        }
        Ok(out)
    }

    /// Legacy full-CF scan source of truth for the Light roster. Kept as the backfill builder and
    /// the determinism-test oracle for `light_roster_sorted` (index reader); NOT on any hot path.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn light_roster_sorted_scan(&self, before_height: u64) -> IntegrationResult<Vec<(String, String)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut out: Vec<(String, String)> = Vec::new();
        for item in self.persistent.db.iterator_cf(&registry_cf, rocksdb::IteratorMode::Start) {
            let (k, v) = item?;
            let key = match std::str::from_utf8(&k) { Ok(s) => s, Err(_) => continue };
            let node_id = match key.strip_prefix("node_") { Some(id) => id, None => continue };
            let parsed = match serde_json::from_slice::<serde_json::Value>(&v) { Ok(p) => p, Err(_) => continue };
            if parsed["node_type"].as_str() != Some("light") { continue; }
            match parsed["reg_height"].as_u64() {
                Some(h) if h < before_height => {}
                _ => continue,
            }
            let wallet = parsed["wallet"].as_str().unwrap_or("");
            if !wallet.is_empty() { out.push((node_id.to_string(), wallet.to_string())); }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// Legacy full-CF scan source of truth for the Super roster — backfill builder + determinism-test
    /// oracle for `super_registrations_sorted` (index reader); NOT on any hot path.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn super_registrations_sorted_scan(&self) -> IntegrationResult<Vec<(String, String)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut out: Vec<(String, String)> = Vec::new();
        for item in self.persistent.db.iterator_cf(&registry_cf, rocksdb::IteratorMode::Start) {
            let (k, v) = item?;
            let key = match std::str::from_utf8(&k) { Ok(s) => s, Err(_) => continue };
            let node_id = match key.strip_prefix("node_") { Some(id) => id, None => continue };
            if !(node_id.starts_with("super_") || node_id.starts_with("genesis_node_")) { continue; }
            let parsed = match serde_json::from_slice::<serde_json::Value>(&v) { Ok(p) => p, Err(_) => continue };
            // Only chain-confirmed registrations (reg_height stamped at block-apply / genesis boot) —
            // excludes non-deterministic RPC/discovery cache writes so the set is identical per node.
            if parsed["reg_height"].as_u64().is_none() { continue; }
            let wallet = parsed["wallet"].as_str().unwrap_or("");
            if !wallet.is_empty() { out.push((node_id.to_string(), wallet.to_string())); }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// Reconcile the reward-roster indices (`srtr_`/`lrtr_`) from the chain-confirmed `node_` entries.
    /// Needed once when upgrading a pre-index DB and after a snapshot jump (state fast-sync writes
    /// node_ entries directly, not via the apply funnel). Pure function of the stamped node_ set ⇒
    /// deterministic; skip-if-present ⇒ safe to re-run. Cold path only (one full-CF scan).
    pub fn backfill_roster_indices(&self) -> IntegrationResult<u32> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let iter = self.persistent.db.prefix_iterator_cf(&registry_cf, b"node_");
        let mut batch = rocksdb::WriteBatch::default();
        let mut added = 0u32;
        for item in iter {
            // Sole reconstructor of srtr_/lrtr_ on the promote path (the whitelist drops imported
            // rows), and registry_root enumerates those keys — a truncated scan is a divergent root.
            let (key, value) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("backfill_roster_indices iterator failed: {}", e))),
            };
            let key_str = match std::str::from_utf8(&key) { Ok(s) => s, Err(_) => continue };
            if !key_str.starts_with("node_") { continue; }
            let node_id = &key_str[5..];
            let parsed: serde_json::Value = match serde_json::from_slice(&value) { Ok(v) => v, Err(_) => continue };
            let h = match parsed["reg_height"].as_u64() { Some(h) => h, None => continue }; // chain-confirmed only
            let wallet = parsed["wallet"].as_str().unwrap_or("");
            let node_type = parsed["node_type"].as_str().unwrap_or("");
            let reg_index = parsed["reg_index"].as_u64().unwrap_or(0) as u32;
            if node_id.starts_with("super_") || node_id.starts_with("genesis_node_") {
                let ik = format!("srtr_{}", node_id);
                // AUTHORITATIVE, not skip-if-present: the index value is not covered by
                // registry_root, so a row that arrived any other way must be overwritten from the
                // covered node_<id>.
                batch.put_cf(&registry_cf, ik.as_bytes(), &Self::roster_index_value(h, reg_index, wallet));
                added += 1;
            }
            if node_type == "light" {
                let ik = format!("lrtr_{}", node_id);
                // Was skip-if-present while srtr_ was authoritative — the asymmetry meant a stale
                // light row survived a rebuild that healed the super rows beside it.
                batch.put_cf(&registry_cf, ik.as_bytes(), &Self::roster_index_value(h, reg_index, wallet));
                added += 1;
            }
        }
        if added > 0 {
            self.persistent.db.write(batch)?;
            println!("[INFO][STORAGE] backfill_roster_indices added={}", added);
        }
        Ok(added)
    }

    // ── reward aggregation scratch (10M-recipient root build) ────────────────────────────────────
    // Key: rag_{epoch:010}_{wallet}\0{node_id}. One PUT per eligible node — no read-modify-write.
    // RocksDB orders bytewise, which for these keys is exactly `BTreeMap<String, _>` order over the
    // wallet, so an ordered scan reproduces the in-memory aggregation byte-for-byte while holding
    // only one shard in RAM.
    pub(super) fn reward_agg_prefix(build: u64) -> Vec<u8> {
        format!("rag_{:020}_", build).into_bytes()
    }

    /// A private key range for one build. Two reward builds can legitimately run at once (the WindowEnd
    /// checkpoint/verify path and the producer's emission path are independent tasks), and they would
    /// otherwise share one epoch-keyed range — one clearing while the other writes, i.e. a wrong root on
    /// a consensus path. Per-build isolation removes the interaction entirely, with no lock on a path
    /// that does RocksDB I/O.
    pub fn reward_agg_new_build(&self) -> u64 {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    /// Wipe the entire scratch CF. Pure per-process working space with no cross-run meaning, so a crash
    /// mid-build can only leave rows that this clears at open — before any build can read them.
    pub fn reward_agg_clear_all(&self) -> IntegrationResult<()> {
        if let Some(cf) = self.persistent.db.cf_handle("reward_agg") {
            let mut batch = rocksdb::WriteBatch::default();
            batch.delete_range_cf(&cf, b"rag_".as_ref(), b"rah_".as_ref());
            self.persistent.db.write(batch)?;
        }
        Ok(())
    }

    /// Drop one build's scratch. Called before a build and on every exit path after it.
    pub fn reward_agg_clear(&self, build: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("reward_agg")
            .ok_or_else(|| IntegrationError::StorageError("reward_agg column family not found".to_string()))?;
        let from = Self::reward_agg_prefix(build);
        let mut to = from.clone();
        to.push(0xff);
        let mut b = rocksdb::WriteBatch::default();
        b.delete_range_cf(&cf, &from, &to);
        self.persistent.db.write(b)?;
        Ok(())
    }

    /// Append one (wallet, node_id) → amount row. Batched by the caller.
    pub fn reward_agg_put_batch(&self, build: u64, rows: &[(String, String, u64)]) -> IntegrationResult<()> {
        if rows.is_empty() { return Ok(()); }
        let cf = self.persistent.db.cf_handle("reward_agg")
            .ok_or_else(|| IntegrationError::StorageError("reward_agg column family not found".to_string()))?;
        let mut b = rocksdb::WriteBatch::default();
        for (wallet, node_id, amt) in rows {
            let mut k = Self::reward_agg_prefix(build);
            k.extend_from_slice(wallet.as_bytes());
            k.push(0u8); // separator below every printable byte ⇒ wallet order is never split by node_id
            k.extend_from_slice(node_id.as_bytes());
            b.put_cf(&cf, &k, &amt.to_be_bytes());
        }
        self.persistent.db.write(b)?;
        Ok(())
    }

    /// Stream the epoch's rows in WALLET order, summing the runs that share a wallet. `f` sees each
    /// distinct wallet exactly once, ascending — the same sequence `BTreeMap::into_iter` produces.
    /// Fails closed on a mid-scan iterator error (this feeds reward_root, a hashed checkpoint field).
    pub fn reward_agg_for_each_wallet<F: FnMut(&str, u64)>(&self, build: u64, mut f: F) -> IntegrationResult<()> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("reward_agg")
            .ok_or_else(|| IntegrationError::StorageError("reward_agg column family not found".to_string()))?;
        let prefix = Self::reward_agg_prefix(build);
        let mut cur: Option<(String, u64)> = None;
        for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(&prefix, Direction::Forward)) {
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("reward_agg iterator failed: {}", e))),
            };
            if !k.starts_with(&prefix) { break; }
            let tail = &k[prefix.len()..];
            let wallet = match tail.iter().position(|b| *b == 0u8) {
                Some(p) => match std::str::from_utf8(&tail[..p]) { Ok(w) => w, Err(_) => continue },
                None => continue,
            };
            if v.len() != 8 { continue; }
            let amt = u64::from_be_bytes(v[..8].try_into().unwrap_or([0u8; 8]));
            match cur.as_mut() {
                Some((w, sum)) if w == wallet => { *sum = sum.saturating_add(amt); }
                _ => {
                    if let Some((w, sum)) = cur.take() { f(&w, sum); }
                    cur = Some((wallet.to_string(), amt));
                }
            }
        }
        if let Some((w, sum)) = cur { f(&w, sum); }
        Ok(())
    }

    /// One-time marker so the O(N) roster-index migration scan runs once, not on every restart.
    pub fn roster_index_built(&self) -> bool {
        match self.persistent.db.cf_handle("node_registry") {
            Some(cf) => self.persistent.db.get_cf(&cf, b"meta_roster_index_v1").map(|o| o.is_some()).unwrap_or(false),
            None => false,
        }
    }

    /// Set the roster-index migration marker after a successful backfill.
    pub fn set_roster_index_built(&self) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, b"meta_roster_index_v1", b"1")?;
        Ok(())
    }

    /// wallet_token index is built AND clean (skip boot backfill, trust empty results): build marker
    /// present AND dirty-sentinel absent. The sentinel — not marker-absence — is the "must rebuild"
    /// authority: marking dirty WRITES a key, so a failed op leaves it dirty (safe over-rebuild).
    pub fn owns_index_built(&self) -> bool {
        match self.persistent.db.cf_handle("metadata") {
            Some(cf) => {
                let built = self.persistent.db.get_cf(&cf, b"meta_owns_index_v1").map(|o| o.is_some()).unwrap_or(false);
                let dirty = self.persistent.db.get_cf(&cf, b"meta_owns_dirty").map(|o| o.is_some()).unwrap_or(true);
                built && !dirty
            }
            None => false,
        }
    }

    /// Mark built+clean after a full backfill at `height`: set marker, stamp the watermark to `height`
    /// (index now current up to there), THEN clear the dirty-sentinel (a crash between leaves it dirty →
    /// next boot rebuilds).
    pub fn set_owns_index_built(&self, height: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, b"meta_owns_index_v1", b"1")?;
        self.persistent.db.put_cf(&cf, b"meta_owns_watermark", &height.to_le_bytes())?;
        self.persistent.db.delete_cf(&cf, b"meta_owns_dirty")?;
        Ok(())
    }

    /// Durable owns-watermark: highest height whose owns-deltas are known persisted (0 if never set).
    /// Boot rebuilds the index only when this lags the tip (unclean shutdown lost the last deltas).
    pub fn owns_watermark(&self) -> u64 {
        self.persistent.db.cf_handle("metadata")
            .and_then(|cf| self.persistent.db.get_cf(&cf, b"meta_owns_watermark").ok().flatten())
            .and_then(|v| <[u8; 8]>::try_from(v.as_slice()).ok())
            .map(u64::from_le_bytes)
            .unwrap_or(0)
    }

    /// Advance the owns-watermark alone (empty-delta block: index already consistent at `height`).
    pub fn set_owns_watermark(&self, height: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, b"meta_owns_watermark", &height.to_le_bytes())?;
        Ok(())
    }

    /// Owns keys implied by one contract's storage — pure derivation for callers that hold the
    /// in-memory state (boot rebuild extracts keys under the read guard, no map clones).
    pub fn owns_index_keys(contract: &str, contract_storage: &std::collections::HashMap<String, String>) -> Vec<Vec<u8>> {
        PersistentStorage::owns_keys_for_contract(contract, contract_storage)
    }

    /// Rebuild wallet_token from pre-derived owns keys: one range-delete tombstone (every key sits
    /// under the `owns|` prefix), chunked re-index, mark built+clean+READY with the watermark stamped
    /// to `at_height`. NON-consensus. Returns keys written.
    pub fn rebuild_owns_from_keys(&self, keys: &[Vec<u8>], at_height: u64) -> IntegrationResult<usize> {
        if let Some(cf) = self.persistent.db.cf_handle("wallet_token") {
            let mut batch = WriteBatch::default();
            batch.delete_range_cf(&cf, b"owns|".as_ref(), b"owns}".as_ref());
            self.persistent.db.write(batch)?;
        }
        let n = self.persistent.write_owns_keys_batched(keys)?;
        self.set_owns_index_built(at_height)?;
        OWNS_INDEX_READY.store(true, Ordering::Relaxed);
        Ok(n)
    }

    /// Flag wallet_token possibly-incomplete (dropped delta write, promote/reorg rebuild, or unclean-
    /// shutdown replay which re-applies blocks without owns deltas): write a durable dirty-sentinel (the
    /// crash-safe rebuild trigger) and drop READY so the live reader falls back to scan until the next
    /// boot rebuilds. NON-consensus.
    pub fn mark_owns_index_dirty(&self) {
        OWNS_INDEX_READY.store(false, Ordering::Relaxed);
        if let Some(cf) = self.persistent.db.cf_handle("metadata") {
            // If the sentinel write fails, zero the watermark instead: a watermark regression (< tip) is
            // an equally-durable boot-rebuild trigger, so a failed dirty-mark is never silently lost.
            if self.persistent.db.put_cf(&cf, b"meta_owns_dirty", b"1").is_err() {
                let _ = self.persistent.db.put_cf(&cf, b"meta_owns_watermark", &0u64.to_le_bytes());
            }
        }
    }

}

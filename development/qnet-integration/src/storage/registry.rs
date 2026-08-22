//! Burn attestation registry, homomorphic registry root and the Dilithium key-root journal.

use super::*;

impl Storage {
    /// Genesis-local PERSISTENT burn-attestation dedup (one burn_tx → one wallet). Survives process
    /// restart — the prior in-memory map was wiped on restart, letting one burn back >1 node across
    /// restarts. Genesis-node-local memory (NOT consensus state); under honest 2f+1 genesis a reused
    /// burn can never reach the on-chain quorum because honest attestors refuse to re-sign it.
    /// Keyed on the NODE, not the wallet. One wallet has two distinct pseudonyms (super and light), so a
    /// wallet-keyed dedup let a single 1DEV burn back BOTH — the cost is tier-independent and node_type is
    /// inside the signed message, so the second registration was fully valid. One burn, one node.
    pub fn attested_burn_put(&self, burn_tx: &str, node_id: &str) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, format!("attburn_{}", burn_tx).as_bytes(), node_id.as_bytes())?;
        Ok(())
    }

    /// The node_id this genesis already attested for `burn_tx`, or None.
    pub fn attested_burn_get(&self, burn_tx: &str) -> IntegrationResult<Option<String>> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        match self.persistent.db.get_cf(&cf, format!("attburn_{}", burn_tx).as_bytes())? {
            Some(v) => Ok(Some(String::from_utf8_lossy(&v).to_string())),
            None => Ok(None),
        }
    }

    /// Attestor-local cache of a Solana-verified burn: burn_tx → actual burned amount. Written on the
    /// first successful live getTransaction verify so throttle re-polls never re-hit Solana for the
    /// same burn. Admission-side only, never consensus.
    pub fn attest_burn_verified_put(&self, burn_tx: &str, burner: &str, actual_burned: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        self.persistent.db.put_cf(&cf, format!("attburnv_{}_{}", burn_tx, burner).as_bytes(), actual_burned.to_le_bytes())?;
        Ok(())
    }

    /// Cached Solana-verified burned amount for (burn_tx, burner), or None if never verified.
    /// Keyed by BOTH: the attestor now signs the burner address, so a cache hit must not let a second
    /// caller claim the same burn under a different sender and skip the fee-payer check.
    pub fn attest_burn_verified_get(&self, burn_tx: &str, burner: &str) -> IntegrationResult<Option<u64>> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        match self.persistent.db.get_cf(&cf, format!("attburnv_{}_{}", burn_tx, burner).as_bytes())? {
            Some(v) if v.len() == 8 => Ok(Some(u64::from_le_bytes(v[..8].try_into().unwrap_or([0u8; 8])))),
            _ => Ok(None),
        }
    }

    /// COMMITTED burn→wallet binding (on-chain uniqueness, NOT the genesis-local attested_burn).
    /// Written FIRST-WINS when a burn-backed NodeRegistration is applied; read at block-validation
    /// (verify_burn_attestation_quorum) to reject a second registration reusing the same burn for a
    /// different wallet. With a ROTATING committee the genesis-local dedup is insufficient (disjoint
    /// honest sub-committees could each attest the same burn); this committed binding is the
    /// deterministic global stop. Idempotent (only sets if unset → binding immutable).
    /// Bound to the NODE, not the wallet — see attested_burn_put. First-wins and immutable.
    pub fn committed_burn_wallet_put(&self, burn_tx: &str, node_id: &str) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let key = format!("cbw_{}", burn_tx);
        if self.persistent.db.get_cf(&cf, key.as_bytes())?.is_none() {
            self.persistent.db.put_cf(&cf, key.as_bytes(), node_id.as_bytes())?;
        }
        Ok(())
    }

    /// The node_id a `burn_tx` is committed-bound to on-chain, or None.
    pub fn committed_burn_wallet_get(&self, burn_tx: &str) -> IntegrationResult<Option<String>> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        match self.persistent.db.get_cf(&cf, format!("cbw_{}", burn_tx).as_bytes())? {
            Some(v) => Ok(Some(String::from_utf8_lossy(&v).to_string())),
            None => Ok(None),
        }
    }

    /// True iff `wallet` has a chain-confirmed burn-attested NodeRegistration — a node_ entry with a
    /// non-empty backing burn. Gates NodeActivation (which carries no burn of its own) at verify: an
    /// activation is valid only for a wallet that already proved a burn at registration, so a raw
    /// activation cannot mint a node identity (super pseudonym / reward-eligible row) for free.
    /// Derives the node_id (resolve_node_id) then one O(1) point-read of the node_ entry. Genesis
    /// registrations carry an empty burn (and never activate), so this correctly returns false for them.
    pub fn wallet_is_burn_registered(&self, wallet: &str) -> bool {
        let cf = match self.persistent.db.cf_handle("node_registry") { Some(c) => c, None => return false };
        let nid = match self.resolve_node_id(wallet) { Some(n) => n, None => return false };
        match self.persistent.db.get_cf(&cf, format!("node_{}", nid).as_bytes()) {
            Ok(Some(v)) => serde_json::from_slice::<serde_json::Value>(&v).ok()
                .and_then(|j| j["burn"].as_str().map(|b| !b.is_empty())).unwrap_or(false),
            _ => false,
        }
    }

    /// True iff `wallet` belongs to a GENESIS bootstrap node — constant-table membership. Genesis nodes
    /// are protocol-minted and activate WITHOUT a 1DEV burn (they ARE the bootstrap), so the
    /// NodeActivation burn-gate must exempt them — mirroring exactly the registration burn-attestation
    /// gate's genesis exemption. Without this, a genesis self-activation (empty burn) is wrongly dropped.
    pub fn wallet_is_genesis_node(&self, wallet: &str) -> bool {
        // Genesis membership is the constant table — no row lookup needed.
        crate::genesis_constants::GENESIS_WALLETS.iter().any(|(_, w)| *w == wallet)
    }

    /// Rebuild the committed burn→wallet index (cbw_) DETERMINISTICALLY from the chain-confirmed
    /// node_ registry entries, considering ONLY registrations with reg_height <= up_to_height.
    /// cbw is a pure DERIVED index, never deleted per-block — so a snapshot/fast-sync join (restores
    /// node_registry but not the 'metadata' CF where cbw lives) and any node after a reorg reconstruct
    /// a cbw IDENTICAL to a from-genesis node. The reg_height<=up_to bound excludes orphaned
    /// registrations on reorg (no per-block delete, no absence window). First-wins by (reg_height,
    /// node_id): the earliest canonical registration of a burn owns it. Atomic: the old cbw_ region is
    /// cleared and the rebuilt set written in ONE WriteBatch (no reader observes an empty intermediate).
    /// Scans BOTH roster indices — `srtr_` (super/genesis) and `lrtr_` (light, also burn-attested
    /// on-chain) — so cbw covers every burn-backed registration (see the in-loop note). Rebuild is
    /// O(registrations) but rare (boot/snapshot/reorg); the per-block path is incremental O(1).
    pub fn rebuild_committed_burn_wallet(&self, up_to_height: u64) -> IntegrationResult<u32> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let metadata_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut cands: Vec<(u64, String, String, String)> = Vec::new();
        // Scan BOTH roster indices: srtr_ (super/genesis) AND lrtr_ (light). Light nodes are also
        // burn-attested on-chain (Option A), so their burn→wallet binding must enter cbw and be
        // reconstructed here EXACTLY like the incremental (all-types) writers — else live-vs-rebuild
        // cbw diverges → fork. burn lives only in the node_ JSON (point-read), not in the index value.
        for prefix in [b"srtr_".as_ref(), b"lrtr_".as_ref()] {
            for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward)) {
                let (k, _) = match item {
                    Ok(kv) => kv,
                    Err(e) => return Err(IntegrationError::StorageError(
                        format!("cbw_rebuild_super iterator failed: {}", e))),
                };
                if !k.starts_with(prefix) { break; }
                let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s, Err(_) => continue };
                // Point-read the node_ entry for the co-resident (reg_height, burn, wallet).
                let nk = format!("node_{}", node_id);
                let val = match self.persistent.db.get_cf(&registry_cf, nk.as_bytes()) { Ok(Some(v)) => v, _ => continue };
                let parsed: serde_json::Value = match serde_json::from_slice(&val) { Ok(p) => p, Err(_) => continue };
                let h = match parsed["reg_height"].as_u64() { Some(h) => h, None => continue }; // chain-confirmed only
                if h > up_to_height { continue; } // orphan/above-bound exclusion
                let burn = parsed["burn"].as_str().unwrap_or("");
                let wallet = parsed["wallet"].as_str().unwrap_or("");
                if burn.is_empty() || wallet.is_empty() { continue; }
                cands.push((h, node_id.to_string(), burn.to_string(), wallet.to_string()));
            }
        }
        cands.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        // Bind the NODE, byte-identical to the live writer (write_registration_row). A wallet-keyed bind
        // let one burn back both of a wallet's pseudonyms; the rebuild must key the same way or a
        // reorg/boot recompute would disagree with the incremental writer.
        let mut bound: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for (_, node_id, burn, _wallet) in cands { bound.entry(burn).or_insert(node_id); }
        let mut batch = rocksdb::WriteBatch::default();
        for item in self.persistent.db.iterator_cf(&metadata_cf, IteratorMode::From(b"cbw_".as_ref(), Direction::Forward)) {
            let (k, _) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("cbw_rebuild_light iterator failed: {}", e))),
            };
            if !k.starts_with(b"cbw_") { break; }
            batch.delete_cf(&metadata_cf, &k);
        }
        let count = bound.len() as u32;
        for (burn, node_id) in bound {
            batch.put_cf(&metadata_cf, format!("cbw_{}", burn).as_bytes(), node_id.as_bytes());
        }
        self.persistent.db.write(batch)?;
        Ok(count)
    }

    /// Key of the running registry_root LtHash accumulator (metadata CF). One 2048-byte blob updated
    /// incrementally by save_node_registration_inner; recomputed from scratch on reorg/boot/snapshot.
    /// Monotone sources of `reg_index`, one per index space. In the metadata CF, not RAM: they feed
    /// a hashed field. Value = INDEX_SPACES x u32 BE.
    pub(super) const REGISTRY_NEXT_INDEX_KEY: &'static [u8] = b"registry_next_index";

    /// Index spaces: 0 = super/genesis, 1..=5 = light shard 0..4.
    ///
    /// A single global counter made every light shard's bitmap span the WHOLE registry, because the
    /// shard is `blake3(node_id) % 5` and is independent of the index — so each shard's highest
    /// member sat at the top of the space. At 10M lights that is a 1.26 MB raw bitmap per shard,
    /// ~840 KB compressed, against a 500,000-byte per-transaction cap: the light reward path stops
    /// emitting at ~60% of target. Ranking inside the node's own space keeps the ordinal just as
    /// permanent (the shard is a pure function of an immutable id) and drops the span to the shard's
    /// own size.
    pub(crate) const INDEX_SPACES: usize = 6;

    pub(super) fn index_space_of(node_id: &str, node_type: &str) -> Option<usize> {
        if node_id.starts_with("super_") || node_id.starts_with("genesis_node_") {
            Some(0)
        } else if node_type == "light" {
            Some(1 + crate::node::light_shard_of(node_id))
        } else {
            None
        }
    }

    pub(super) fn load_next_indices(&self, meta_cf: &rocksdb::ColumnFamily) -> [u32; Self::INDEX_SPACES] {
        let mut out = [0u32; Self::INDEX_SPACES];
        if let Ok(Some(v)) = self.persistent.db.get_cf(meta_cf, Self::REGISTRY_NEXT_INDEX_KEY) {
            if v.len() == Self::INDEX_SPACES * 4 {
                for i in 0..Self::INDEX_SPACES {
                    out[i] = u32::from_be_bytes([v[4 * i], v[4 * i + 1], v[4 * i + 2], v[4 * i + 3]]);
                }
            }
        }
        out
    }

    /// Chain-confirmed registered-node count: the sum of the per-index-space monotone counters,
    /// each advanced only by a registration that reached chain-apply. O(1) point read. Feeds the
    /// Phase-2 price multiplier, which needs a COMMITTED network size rather than a peer count.
    pub fn registered_node_count(&self) -> u64 {
        let meta_cf = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return 0 };
        self.load_next_indices(&meta_cf).iter().map(|n| *n as u64).sum()
    }

    pub(super) fn next_indices_bytes(v: &[u32; Self::INDEX_SPACES]) -> Vec<u8> {
        let mut out = Vec::with_capacity(Self::INDEX_SPACES * 4);
        for n in v.iter() {
            out.extend_from_slice(&n.to_be_bytes());
        }
        out
    }
    pub(super) const REGISTRY_LT_STATE_KEY: &'static [u8] = b"registry_lt_state";
    /// How far back per-checkpoint-head seals are retained (~1 epoch of 30-block heads). A read that
    /// misses a pruned seal falls back to the O(N) from-scratch recompute — correctness, not just perf.
    pub(super) const REGISTRY_SEAL_RETENTION: u64 = 14400;

    /// Load the running registry_root LtHash accumulator (empty if absent / not yet built).
    pub(super) fn registry_lt_load(&self) -> crate::registry_lthash::LtHash {
        let cf = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return crate::registry_lthash::LtHash::new() };
        match self.persistent.db.get_cf(&cf, Self::REGISTRY_LT_STATE_KEY) {
            Ok(Some(v)) => crate::registry_lthash::LtHash::from_bytes(&v),
            _ => crate::registry_lthash::LtHash::new(),
        }
    }

    // ── FIX-5: dilithium_pk_root — QC-signed LtHash over committed (address -> ML-DSA-65 pk) bindings ──
    pub(super) const DPK_LT_STATE_KEY: &'static [u8] = b"dpk_lt_state";

    pub(super) fn dpk_lt_load(&self) -> crate::registry_lthash::LtHash {
        let cf = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return crate::registry_lthash::LtHash::new() };
        match self.persistent.db.get_cf(&cf, Self::DPK_LT_STATE_KEY) {
            Ok(Some(v)) => crate::registry_lthash::LtHash::from_bytes(&v),
            _ => crate::registry_lthash::LtHash::new(),
        }
    }

    pub(super) fn dpk_root_seal_get(&self, height: u64) -> Option<[u8; 32]> {
        let cf = self.persistent.db.cf_handle("metadata")?;
        let mut key = b"dpkr_seal_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        match self.persistent.db.get_cf(&cf, &key) {
            Ok(Some(v)) if v.len() == 32 => { let mut out = [0u8; 32]; out.copy_from_slice(&v); Some(out) }
            _ => None,
        }
    }

    /// From-scratch: fold every account holding a bound 1952-byte ML-DSA-65 pk. O(accounts-with-pk).
    /// Fallback for `compute_dilithium_pk_root` + source for `rebuild_dilithium_pk_lthash`.
    pub(super) fn dpk_lt_from_accounts(&self) -> Option<crate::registry_lthash::LtHash> {
        self.dpk_lt_from_accounts_cf("accounts")
    }

    /// From-scratch dpk accumulator over an explicit accounts CF: "accounts" (live recompute /
    /// boot / reorg) or "accounts_stage" (cold-join snapshot-verify, before promotion). Order-
    /// independent, so iteration order is irrelevant — identical root on every node.
    /// None = FAIL CLOSED: dilithium_pk_root is a hashed checkpoint field, so a partial scan is a
    /// different commitment on this node, not a smaller key set.
    pub(super) fn dpk_lt_from_accounts_cf(&self, cf_name: &str) -> Option<crate::registry_lthash::LtHash> {
        let mut lt = crate::registry_lthash::LtHash::new();
        let cf = self.persistent.db.cf_handle(cf_name)?;
        for item in self.persistent.db.iterator_cf(&cf, rocksdb::IteratorMode::Start) {
            let (_, v) = match item {
                Ok(kv) => kv,
                Err(e) => {
                    println!("[CRIT][DPK] accounts_scan_failed cf={} err={}", cf_name, e);
                    return None;
                }
            };
            let acct: qnet_state::Account = match bincode::deserialize(&v) { Ok(a) => a, Err(_) => continue };
            if let Some(ref pk) = acct.dilithium_public_key {
                if pk.len() == 1952 { lt.add(&crate::registry_lthash::pk_row_lanes(&acct.address, pk)); }
            }
        }
        Some(lt)
    }

    /// Recompute `dilithium_pk_root` from the STAGED accounts (`accounts_stage`) for the untrusted-
    /// snapshot verify — mirror of `compute_registry_root_staged`. No seal exists during staging, so
    /// this is always the from-scratch scan over the restored per-account pubkeys.
    pub fn compute_dilithium_pk_root_staged(&self) -> Option<[u8; 32]> {
        Some(self.dpk_lt_from_accounts_cf("accounts_stage")?.root())
    }

    /// QC-signed digest of ALL committed (address -> ML-DSA-65 pk) bindings. FAST PATH = the per-
    /// checkpoint seal; FALLBACK = one from-scratch O(active-senders) accounts scan (only on a snapshot
    /// cold-join before the anchor seal exists). Bound into the macroblock Checkpoint as
    /// `dilithium_pk_root` so a node joining via an UNTRUSTED snapshot verifies its restored per-account
    /// pubkeys match the 2f+1-committed set — closing the elided-pk snapshot DoS at 100k cold-join.
    /// The pk is write-once + immutable, so the accumulator == its value as-of any height >= last bind;
    /// the seal pins the checkpoint head for the light client + snapshot verify.
    pub fn compute_dilithium_pk_root(&self, height: u64) -> Option<[u8; 32]> {
        if let Some(seal) = self.dpk_root_seal_get(height) { return Some(seal); }
        Some(self.dpk_lt_from_accounts()?.root())
    }

    /// Seal-STRICT variant for CONSENSUS compute sites (checkpoint fields). Fast path = the per-head seal;
    /// on a MISS it HEALS from the live accumulator when the pk-bind watermark proves it still equals the
    /// as-of-`height` value (recovery for a dropped seal-write — see body), else `None` ⇒ the caller DEFERS.
    /// It never falls back to the lossy tip-scoped accounts scan: that set is as-of this node's TIP, not
    /// `height`, and pk carries no height, so publishing it would diverge from peers whenever a first-use
    /// bind lands in (height, tip]. Snapshot cold-join keeps the scan.
    pub fn compute_dilithium_pk_root_sealed(&self, height: u64) -> Option<[u8; 32]> {
        if let Some(seal) = self.dpk_root_seal_get(height) { return Some(seal); }
        // Recovery for a dropped seal-write: a transient RocksDB error at apply must NOT permanently mute
        // this node's checkpoint votes at `height` (the finality-lag redrive re-signals the same head and
        // would hit the same miss). pk is write-once, so the live accumulator == its as-of-`height` value
        // IFF no bind landed after `height` — the watermark proves that. Re-seal from the live accumulator
        // and return it. If a later bind diverged the accumulator, the as-of-`height` value is truly
        // unrecoverable ⇒ still defer (None): quorum tolerates one node's rare residual defer.
        if height >= self.dpk_last_bind_height() && self.seal_dilithium_pk_root(height).is_ok() {
            return self.dpk_root_seal_get(height);
        }
        None
    }

    /// Bind an account's pk into the incremental LtHash exactly ONCE (marker `dpkctd_{addr}`). Called
    /// from the DETERMINISTIC apply-commit (producer-inline AND validator) for each value-TX sender
    /// whose account now carries a pk — NEVER the detached accounts persist (flush-timing non-det).
    /// pk write-once ⇒ marker makes re-calls idempotent. One WriteBatch (accumulator + marker + journal
    /// atomic). The journal row `dpkj_{height}{addr}` = 32-byte row seed gives the bind a HEIGHT, so a
    /// reorg can subtract exactly the orphaned binds (rollback_dpk_binds_above) — the same height-bound
    /// discipline cbw/registry_lthash already have. Pruned once the height is finality-covered.
    pub fn dpk_lt_bind(&self, address: &str, pk: &[u8], height: u64) -> IntegrationResult<()> {
        if pk.len() != 1952 { return Ok(()); }
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata cf missing".to_string()))?;
        let mut marker = b"dpkctd_".to_vec();
        marker.extend_from_slice(address.as_bytes());
        if matches!(self.persistent.db.get_cf(&cf, &marker), Ok(Some(_))) { return Ok(()); }
        let seed = crate::registry_lthash::pk_row_seed(address, pk);
        let mut lt = self.dpk_lt_load();
        lt.add(&crate::registry_lthash::lanes_from_seed(&seed));
        let mut batch = rocksdb::WriteBatch::default();
        batch.put_cf(&cf, Self::DPK_LT_STATE_KEY, lt.to_bytes().as_ref());
        batch.put_cf(&cf, &marker, &[1u8]);
        let mut jk = b"dpkj_".to_vec();
        jk.extend_from_slice(&height.to_be_bytes());
        jk.extend_from_slice(address.as_bytes());
        batch.put_cf(&cf, &jk, &seed);
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// Reorg heal: subtract every journaled bind with height > `target` — the exact inverse of
    /// dpk_lt_bind per orphaned entry, so the accumulator matches a from-genesis node at `target`.
    /// Also drops the orphaned markers (unblocks the canonical re-bind) and stale seals above `target`.
    /// O(rolled-back binds); one atomic batch, accumulator co-written. Call INSIDE the rollback barrier
    /// only (applies quiesced ⇒ no concurrent bind). The bind watermark may now over-report — safe:
    /// heal-on-read only gets stricter.
    pub fn rollback_dpk_binds_above(&self, target: u64) -> IntegrationResult<u32> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata cf missing".to_string()))?;
        let mut lt = self.dpk_lt_load();
        let mut batch = rocksdb::WriteBatch::default();
        let mut n = 0u32;
        let mut from = b"dpkj_".to_vec();
        from.extend_from_slice(&(target.saturating_add(1)).to_be_bytes());
        for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(&from, Direction::Forward)) {
            let (k, v) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("dpk_journal_rollback iterator failed: {}", e))),
            };
            if !k.starts_with(b"dpkj_") { break; }
            if v.len() == 32 && k.len() > 13 {
                let mut seed = [0u8; 32];
                seed.copy_from_slice(&v);
                lt.remove(&crate::registry_lthash::lanes_from_seed(&seed));
                let mut m = b"dpkctd_".to_vec();
                m.extend_from_slice(&k[13..]);
                batch.delete_cf(&cf, &m);
                n += 1;
            }
            batch.delete_cf(&cf, &k);
        }
        // Seals above target are orphan-branch values; canonical re-apply re-seals each head.
        let mut sfrom = b"dpkr_seal_".to_vec();
        sfrom.extend_from_slice(&(target.saturating_add(1)).to_be_bytes());
        for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(&sfrom, Direction::Forward)) {
            let (k, _) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("dpk_journal_rollback_prune iterator failed: {}", e))),
            };
            if !k.starts_with(b"dpkr_seal_") { break; }
            batch.delete_cf(&cf, &k);
        }
        if n > 0 {
            batch.put_cf(&cf, Self::DPK_LT_STATE_KEY, lt.to_bytes().as_ref());
        }
        self.persistent.db.write(batch)?;
        Ok(n)
    }

    /// Highest block height at which a pk bind mutated the accumulator. `compute_dilithium_pk_root_sealed`
    /// heals a lost seal only for heights >= this: pk is write-once, so the live accumulator still equals
    /// the as-of-height value there, whereas a later bind makes an earlier head's value unrecoverable.
    pub fn dpk_last_bind_height(&self) -> u64 {
        let cf = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return 0 };
        match self.persistent.db.get_cf(&cf, b"dpk_last_bind_h") {
            Ok(Some(v)) if v.len() == 8 => u64::from_be_bytes(v[..8].try_into().unwrap_or_default()),
            _ => 0,
        }
    }

    /// Advance the pk-bind watermark to `max(current, height)` — monotonic, since a reorg re-applying a
    /// lower head re-adds nothing under the write-once markers, so the watermark must never regress.
    /// Called once per block whose apply drained >=1 pk bind, on both apply paths.
    pub fn note_dpk_bind_height(&self, height: u64) -> IntegrationResult<()> {
        if height <= self.dpk_last_bind_height() { return Ok(()); }
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata cf missing".to_string()))?;
        self.persistent.db.put_cf(&cf, b"dpk_last_bind_h", &height.to_be_bytes())?;
        Ok(())
    }

    /// Seal `dpkr_seal_{H}` = sha3(dpk_lt) at a checkpoint head (mirror seal_registry_root); prune one
    /// retention window down. Called on BOTH apply paths beside seal_registry_root, after the binds.
    pub fn seal_dilithium_pk_root(&self, height: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata cf missing".to_string()))?;
        let root = self.dpk_lt_load().root();
        let mut batch = rocksdb::WriteBatch::default();
        let mut key = b"dpkr_seal_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        batch.put_cf(&cf, &key, &root);
        if height >= Self::REGISTRY_SEAL_RETENTION {
            let mut old = b"dpkr_seal_".to_vec();
            old.extend_from_slice(&(height - Self::REGISTRY_SEAL_RETENTION).to_be_bytes());
            batch.delete_cf(&cf, &old);
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// Prune bind-journal entries at/below `finalized_height` — the caller passes the SAME value that
    /// guards `begin_finality_guarded_rollback`, so no still-rollback-eligible bind is ever dropped (the
    /// local macroblock-body frontier runs AHEAD of finality during catch-up and MUST NOT be the floor).
    /// INVARIANT: call ONLY from the LIVE post-boot apply path — LAST_FINALIZED_HEIGHT is then settled and
    /// only advances (fetch_max), so prune-floor <= any future rollback floor. The two boot content-gate
    /// stores (which may LOWER finality to enable fork-healing rollback) run before the first live prune.
    /// Cap bounds one call; the FIFO-oldest remainder drains at the next checkpoint head (self-draining,
    /// no starvation) — a mass first-use burst is a bounded transient, never unbounded growth.
    pub fn prune_dpk_journal(&self, finalized_height: u64) -> IntegrationResult<()> {
        use rocksdb::{IteratorMode, Direction};
        if finalized_height == 0 { return Ok(()); }
        let cf = match self.persistent.db.cf_handle("metadata") { Some(c) => c, None => return Ok(()) };
        let mut batch = rocksdb::WriteBatch::default();
        let mut pruned = 0u32;
        for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(b"dpkj_", Direction::Forward)) {
            let (k, _) = match item { Ok(kv) => kv, Err(_) => break };
            if !k.starts_with(b"dpkj_") || k.len() < 13 { break; }
            let h = u64::from_be_bytes(k[5..13].try_into().unwrap_or_default());
            if h > finalized_height || pruned >= 100_000 { break; }
            batch.delete_cf(&cf, &k);
            pruned += 1;
        }
        if pruned > 0 { self.persistent.db.write(batch)?; }
        Ok(())
    }

    /// Rebuild dpk_lt + the `dpkctd_` markers from the accounts CF (boot + post-snapshot-apply +
    /// post-reorg self-heal). Mirror rebuild_registry_lthash. Setting markers here is load-bearing: a
    /// later re-assertion of an existing account's pk must NOT double-add after a rebuild. CRITICAL for
    /// reorg: FIRST wipe every stale `dpkctd_` marker (the accounts CF is height-versioned, so a
    /// rollback can strip an account's pk — but the marker lives in the un-rolled-back metadata CF; a
    /// surviving marker would make the canonical re-bind a silent no-op ⇒ the accumulator drifts from a
    /// from-genesis node ⇒ dilithium_pk_root fork). One atomic batch: clear markers → re-add present.
    /// Shared core: clear every count-marker, then fold each authoritative (address, pk) bind into a
    /// fresh LtHash, writing the accumulator LAST. Chunked so neither the marker sweep nor the fold
    /// spikes memory at target scale (millions of value-sending accounts). Crash-safety: the accumulator
    /// key is written last, and a crash mid-rebuild leaves stale markers the next rebuild clears first.
    pub(super) fn rebuild_dpk_lthash_core<I: Iterator<Item = (String, Vec<u8>)>>(&self, binds: I) -> IntegrationResult<u32> {
        use rocksdb::{IteratorMode, Direction};
        const DPK_REBUILD_CHUNK: usize = 20_000;
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata cf missing".to_string()))?;
        let mut lt = crate::registry_lthash::LtHash::new();
        let mut batch = rocksdb::WriteBatch::default();
        let mut pending = 0usize;
        // Clear every existing count-marker so a rollback-orphaned account cannot block its re-bind.
        let mprefix = b"dpkctd_".as_ref();
        for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(mprefix, Direction::Forward)) {
            let (k, _) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("dpk_lthash_marker iterator failed: {}", e))),
            };
            if !k.starts_with(mprefix) { break; }
            batch.delete_cf(&cf, &k);
            pending += 1;
            if pending >= DPK_REBUILD_CHUNK {
                self.persistent.db.write(std::mem::take(&mut batch))?;
                pending = 0;
            }
        }
        let mut n = 0u32;
        for (address, pk) in binds {
            if pk.len() != 1952 { continue; }
            lt.add(&crate::registry_lthash::pk_row_lanes(&address, &pk));
            let mut m = b"dpkctd_".to_vec();
            m.extend_from_slice(address.as_bytes());
            batch.put_cf(&cf, &m, &[1u8]);
            n += 1;
            pending += 1;
            if pending >= DPK_REBUILD_CHUNK {
                self.persistent.db.write(std::mem::take(&mut batch))?;
                pending = 0;
            }
        }
        // Accumulator LAST: it is the value every reader trusts, so it must not become visible before the
        // markers that justify it.
        batch.put_cf(&cf, Self::DPK_LT_STATE_KEY, lt.to_bytes().as_ref());
        self.persistent.db.write(batch)?;
        // A rebuild sets the accumulator to as-of-tip WITHOUT per-bind heights, so the heal-on-read guard
        // in compute_dilithium_pk_root_sealed must not keep trusting a watermark that predates it: raise
        // the watermark to the tip. Monotonic max ⇒ this only ever makes the guard STRICTER (defer instead
        // of heal), never looser, so it cannot introduce a wrong-heal on any path.
        let _ = self.note_dpk_bind_height(self.get_chain_height().unwrap_or(0));
        // Journal consistency after a full refold: an entry whose marker was NOT re-created belongs to
        // a bind absent from the rebuilt set — drop it so a later reorg cannot subtract a row the
        // accumulator no longer holds. O(journal) = unfinalized window only.
        {
            use rocksdb::{IteratorMode, Direction};
            let mut jbatch = rocksdb::WriteBatch::default();
            for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(b"dpkj_", Direction::Forward)) {
                let (k, _) = match item {
                    Ok(kv) => kv,
                    Err(e) => return Err(IntegrationError::StorageError(
                        format!("dpk_lthash_bind iterator failed: {}", e))),
                };
                if !k.starts_with(b"dpkj_") || k.len() < 13 { break; }
                let mut m = b"dpkctd_".to_vec();
                m.extend_from_slice(&k[13..]);
                if !matches!(self.persistent.db.get_cf(&cf, &m), Ok(Some(_))) {
                    jbatch.delete_cf(&cf, &k);
                }
            }
            self.persistent.db.write(jbatch)?;
        }
        Ok(n)
    }

    /// Recompute the dpk accumulator by SCANNING the accounts CF. Correct ONLY on the snapshot paths
    /// (apply + promote), where that CF *is* the verified restored state. NOT for boot (best-effort CF
    /// tail can be lost — boot feeds the in-memory tip via `rebuild_dilithium_pk_lthash_from`) and NOT
    /// for reorg (the rollback subtracts journaled binds via `rollback_dpk_binds_above`).
    pub fn rebuild_dilithium_pk_lthash(&self) -> IntegrationResult<u32> {
        let acf = match self.persistent.db.cf_handle("accounts") { Some(c) => c, None => return Ok(0) };
        let src = self.persistent.db.iterator_cf(&acf, rocksdb::IteratorMode::Start)
            .filter_map(|item| {
                let (_, v) = item.ok()?;
                let acct: qnet_state::Account = bincode::deserialize(&v).ok()?;
                let pk = acct.dilithium_public_key?;
                if pk.len() == 1952 { Some((acct.address, pk)) } else { None }
            });
        self.rebuild_dpk_lthash_core(src)
    }

    /// Recompute the dpk accumulator from an EXPLICIT authoritative (address, pk) set. The boot path feeds
    /// the in-memory StateManager tip here: the applied microblock log is authoritative, while the accounts
    /// CF is a best-effort background mirror whose tail an unclean restart can drop — scanning it at boot
    /// would omit rows AND clear their markers, forking that node's dilithium_pk_root permanently.
    pub fn rebuild_dilithium_pk_lthash_from(&self, binds: &[(String, Vec<u8>)]) -> IntegrationResult<u32> {
        self.rebuild_dpk_lthash_core(binds.iter().map(|(a, p)| (a.clone(), p.clone())))
    }

    /// Read a per-checkpoint-head seal `rr_seal_{H}` = sha3(lt_state as-of reg_height<=H), if present.
    pub(super) fn registry_root_seal_get(&self, height: u64) -> Option<[u8; 32]> {
        let cf = self.persistent.db.cf_handle("metadata")?;
        let mut key = b"rr_seal_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        match self.persistent.db.get_cf(&cf, &key) {
            Ok(Some(v)) if v.len() == 32 => { let mut out = [0u8; 32]; out.copy_from_slice(&v); Some(out) }
            _ => None,
        }
    }

    /// FROM-SCRATCH recompute of the registry_root LtHash accumulator over the chain-confirmed roster
    /// {node_id, wallet, reg_height, burn} (SUPER+genesis AND LIGHT) with reg_height <= up_to_height.
    /// Scans BOTH roster indices (srtr_+lrtr_) and DEDUPES by node_id (a node that — only via a crafted
    /// node_id — lands in both indices is counted ONCE, matching the single incremental delta per
    /// registration; without dedup the from-scratch path would double-count and diverge from the live
    /// accumulator → fork). Includes EVERY reg_height-stamped row, INCLUDING empty-burn genesis/not-yet-
    /// attested rows (unlike rebuild_committed_burn_wallet, which skips empty-burn) — the live delta adds
    /// them, so the recompute must too. LtHash is order-independent, so the scan order is irrelevant and
    /// the result is byte-identical to the incrementally-maintained accumulator at the same bound.
    pub(super) fn compute_lt_state(&self, up_to_height: u64) -> Option<crate::registry_lthash::LtHash> {
        self.compute_lt_state_cf("node_registry", up_to_height)
    }

    /// registry_root over an explicit registry CF: full from-scratch scan, NO seal — for cold-join
    /// staging verify ("node_registry_stage"), where no per-head seal exists.
    pub fn compute_registry_root_staged(&self, registry_cf_name: &str, up_to_height: u64) -> Option<[u8; 32]> {
        Some(self.compute_lt_state_cf(registry_cf_name, up_to_height)?.root())
    }

    /// None = FAIL CLOSED. A missing CF or a mid-scan iterator error would otherwise yield a root over
    /// a partial roster; registry_root is a hashed checkpoint field, so a short scan is not "a smaller
    /// registry", it is a different commitment on this node alone. Callers defer instead of publishing.
    pub(super) fn compute_lt_state_cf(&self, registry_cf_name: &str, up_to_height: u64) -> Option<crate::registry_lthash::LtHash> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle(registry_cf_name)?;
        let mut lt = crate::registry_lthash::LtHash::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for prefix in [b"srtr_".as_ref(), b"lrtr_".as_ref()] {
            for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward)) {
                let (k, _) = match item {
                    Ok(kv) => kv,
                    Err(e) => {
                        println!("[CRIT][REGISTRY] lt_state_scan_failed cf={} up_to={} err={}", registry_cf_name, up_to_height, e);
                        return None;
                    }
                };
                if !k.starts_with(prefix) { break; }
                let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s.to_string(), Err(_) => continue };
                if !seen.insert(node_id.clone()) { continue; } // counted under the other prefix already
                let nk = format!("node_{}", node_id);
                let val = match self.persistent.db.get_cf(&registry_cf, nk.as_bytes()) { Ok(Some(v)) => v, _ => continue };
                let parsed: serde_json::Value = match serde_json::from_slice(&val) { Ok(p) => p, Err(_) => continue };
                let h = match parsed["reg_height"].as_u64() { Some(h) => h, None => continue }; // chain-confirmed only
                if h > up_to_height { continue; } // orphan/above-bound exclusion
                let wallet = parsed["wallet"].as_str().unwrap_or("");
                let burn = parsed["burn"].as_str().unwrap_or("");
                let reg_index = parsed["reg_index"].as_u64().unwrap_or(0) as u32;
                let ntype = parsed["node_type"].as_str().unwrap_or("");
                let vrf = parsed["vrf_pk_sha3"].as_str().and_then(|s| hex::decode(s).ok()).unwrap_or_default();
                lt.add(&crate::registry_lthash::row_lanes(&node_id, wallet, h, reg_index, ntype, burn, &vrf));
            }
        }
        Some(lt)
    }

    /// Light-client registry dump as of `up_to_height`: the chain-confirmed roster
    /// (node_id, wallet, reg_height, burn, vrf_pk_sha3) with reg_height <= up_to_height, plus the
    /// LtHash root over them — byte-identical to the QC-signed registry_root sealed at that height.
    /// The light client recomputes the root and binds each committee pubkey to it. Read-only, cacheable.
    pub fn registry_entries_as_of(&self, up_to_height: u64) -> (Vec<serde_json::Value>, String) {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = match self.persistent.db.cf_handle("node_registry") { Some(cf) => cf, None => return (Vec::new(), String::new()) };
        let mut lt = crate::registry_lthash::LtHash::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut out: Vec<serde_json::Value> = Vec::new();
        for prefix in [b"srtr_".as_ref(), b"lrtr_".as_ref()] {
            for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward)) {
                // A partial dump would carry a root that no light client can match; serve nothing.
                let (k, _) = match item { Ok(kv) => kv, Err(_) => return (Vec::new(), String::new()) };
                if !k.starts_with(prefix) { break; }
                let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s.to_string(), Err(_) => continue };
                if !seen.insert(node_id.clone()) { continue; }
                let nk = format!("node_{}", node_id);
                let val = match self.persistent.db.get_cf(&registry_cf, nk.as_bytes()) { Ok(Some(v)) => v, _ => continue };
                let parsed: serde_json::Value = match serde_json::from_slice(&val) { Ok(p) => p, Err(_) => continue };
                let h = match parsed["reg_height"].as_u64() { Some(h) => h, None => continue };
                if h > up_to_height { continue; }
                let wallet = parsed["wallet"].as_str().unwrap_or("").to_string();
                let burn = parsed["burn"].as_str().unwrap_or("").to_string();
                let vrf = parsed["vrf_pk_sha3"].as_str().unwrap_or("").to_string();
                let vrf_bytes = hex::decode(&vrf).unwrap_or_default();
                let reg_index = parsed["reg_index"].as_u64().unwrap_or(0) as u32;
                let ntype = parsed["node_type"].as_str().unwrap_or("").to_string();
                lt.add(&crate::registry_lthash::row_lanes(&node_id, &wallet, h, reg_index, &ntype, &burn, &vrf_bytes));
                out.push(serde_json::json!({"node_id": node_id, "wallet": wallet, "reg_height": h,
                                            "reg_index": reg_index, "node_type": ntype,
                                            "burn": burn, "vrf_pk_sha3": vrf}));
            }
        }
        (out, hex::encode(lt.root()))
    }

    /// QC-certified digest of the chain-confirmed registry BURN-IDENTITY (SUPER+genesis AND LIGHT),
    /// considering ONLY registrations with reg_height <= up_to_height. Implemented as a SOUND INCREMENTAL
    /// multiset hash (LtHash, registry_lthash::LtHash) — O(1) per registration to maintain and O(1) to
    /// read via a per-checkpoint-head seal — so it scales to millions of on-chain light nodes (a flat
    /// per-checkpoint recompute is O(N); a plain additive-mod-2^N set hash is O(1) but FORGEABLE on an
    /// adversary-chosen snapshot roster via generalized-birthday — LtHash is the lattice-based primitive
    /// that is both incremental AND collision-resistant). Bound into the macroblock checkpoint as
    /// `registry_root` so a node joining via an UNTRUSTED snapshot can verify the restored node_registry
    /// (the SOURCE OF cbw for BOTH super and light) matches the 2f+1-committed registry, closing the
    /// forgeable-snapshot Sybil/fork vector. FAST PATH: the seal sha3(lt_state<=H) written at apply
    /// (read only at checkpoint heads, all multiples of CHECKPOINT_INTERVAL). FALLBACK (snapshot cold-
    /// join before the anchor is sealed / a pruned seal): one from-scratch O(N) recompute — correct at
    /// any height. Scope MUST equal cbw (rebuild_committed_burn_wallet scans the SAME srtr_+lrtr_).
    /// None ⇒ the from-scratch scan could not complete ⇒ the caller MUST defer, never publish.
    pub fn compute_registry_root(&self, up_to_height: u64) -> Option<[u8; 32]> {
        if let Some(seal) = self.registry_root_seal_get(up_to_height) { return Some(seal); }
        Some(self.compute_lt_state(up_to_height)?.root())
    }

    /// Seal `rr_seal_{height}` = sha3(current lt_state) — the O(1) read value for that checkpoint head.
    /// Called from the block-scoped end-of-apply hook (on BOTH producer-inline and validator-deferred
    /// paths, BEFORE save_microblock) once per applied block at height % CHECKPOINT_INTERVAL == 0, after
    /// all of that block's registrations have updated lt_state. Prunes the seal one retention-window
    /// below to bound growth (heights are checkpoint-aligned ⇒ exact key).
    pub fn seal_registry_root(&self, height: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let root = self.registry_lt_load().root();
        let mut batch = rocksdb::WriteBatch::default();
        let mut key = b"rr_seal_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        batch.put_cf(&cf, &key, &root);
        if height >= Self::REGISTRY_SEAL_RETENTION {
            let mut old = b"rr_seal_".to_vec();
            old.extend_from_slice(&(height - Self::REGISTRY_SEAL_RETENTION).to_be_bytes());
            batch.delete_cf(&cf, &old);
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// Seal `ts_seal_{height}` = total minted supply as of this checkpoint head — the O(1) deterministic
    /// value the WindowEnd checkpoint reads instead of the live counter (which races the in-block mint).
    /// Sealed at the SAME head as seal_registry_root on BOTH apply paths, after Phase-1 emit_rewards.
    pub fn seal_total_supply(&self, height: u64, total: u64) -> IntegrationResult<()> {
        let cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut batch = rocksdb::WriteBatch::default();
        let mut key = b"ts_seal_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        batch.put_cf(&cf, &key, &total.to_be_bytes());
        if height >= Self::REGISTRY_SEAL_RETENTION {
            let mut old = b"ts_seal_".to_vec();
            old.extend_from_slice(&(height - Self::REGISTRY_SEAL_RETENTION).to_be_bytes());
            batch.delete_cf(&cf, &old);
        }
        self.persistent.db.write(batch)?;
        Ok(())
    }

    /// Read the sealed total_supply for a checkpoint head; None until that head is applied+sealed,
    /// so the WindowEnd reader defers exactly like the [0;32] state_root defer.
    pub fn get_total_supply_at(&self, height: u64) -> Option<u64> {
        let cf = self.persistent.db.cf_handle("metadata")?;
        let mut key = b"ts_seal_".to_vec();
        key.extend_from_slice(&height.to_be_bytes());
        match self.persistent.db.get_cf(&cf, &key) {
            Ok(Some(v)) if v.len() == 8 => { let mut b = [0u8; 8]; b.copy_from_slice(&v); Some(u64::from_be_bytes(b)) }
            _ => None,
        }
    }

    /// Recompute the registry_root LtHash accumulator FROM SCRATCH at `up_to_height` and replace the
    /// running blob, then delete every seal strictly above the new tip (orphaned on reorg) and seal the
    /// new tip (so the immediate snapshot-verify / content_ok read is O(1), not an O(N) fallback). Call
    /// at EVERY height-reset site that calls rebuild_committed_burn_wallet — boot, snapshot-apply, and
    /// both reorg paths — so the live accumulator on a reorged/snapshot-joined node is byte-identical to
    /// a from-genesis node's at the same height. Atomic (one WriteBatch).
    /// ONE scan does BOTH: (a) recompute the registry_root LtHash accumulator from reg_height ≤
    /// up_to_height, and (b) PRUNE orphan roster entries (reg_height > up_to_height) left by now-
    /// discarded blocks — deleting node_/srtr_/lrtr_/wallet_. Then delete every seal strictly above the
    /// tip and seal the tip (so the immediate snapshot-verify read is O(1)). Folding the prune into this
    /// scan (was a separate full srtr_+lrtr_ pass) keeps a deep reorg at millions to TWO index scans
    /// (cbw + this), not three, under the rollback barrier. Why prune is needed: cbw + lt_state are
    /// reg_height-bounded so they already exclude orphans, but the reward-roster readers
    /// (super_registrations_sorted, light_roster_sorted) scan srtr_/lrtr_ KEYS directly, so an orphan-
    /// ONLY registration (never re-registered canonically) would keep its key and shift the hash-shard
    /// per-shard counter (local index) of every later same-shard member → reward_root divergence; deleting
    /// node_ also stops backfill_roster_indices from
    /// resurrecting it. Canonical target+1.. is re-added by the live apply pipeline on re-sync. Call at
    /// EVERY height-reset site (boot, snapshot-apply, both reorg paths) so a reorged/snapshot-joined/
    /// crash-recovered node is byte-identical to a from-genesis node. Returns the orphan count. Atomic.
    pub fn rebuild_registry_lthash(&self, up_to_height: u64) -> IntegrationResult<u32> {
        use rocksdb::{IteratorMode, Direction};
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let meta_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;
        let mut lt = crate::registry_lthash::LtHash::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut batch = rocksdb::WriteBatch::default(); // spans node_registry (prune) + metadata (lt/seals), atomic
        let mut pruned = 0u32;
        // reg_index is the row's RANK in canonical (reg_height, node_id) order — a pure function of
        // the surviving chain, not of the order this node happened to apply things. The live counter
        // equals that rank because blocks apply in height order, reg_height is immutable once stamped,
        // and a block's rows are stamped in node_id order (sort_registrations_canonically, called by
        // the validator drain, the producer's inline stamp and the genesis apply alike). So on a chain
        // this node never reorged, renumbering here is a verified no-op.
        //
        // It is NOT a no-op after a reorg, which is the whole reason it exists: pruning an orphan
        // registered between two survivors leaves a gap a from-genesis node does not have. Ranking the
        // survivors closes the gap and puts this node back on the network's numbering.
        let mut survivors: Vec<(u64, String, serde_json::Value)> = Vec::new();
        let mut next_index = [0u32; Self::INDEX_SPACES];
        for prefix in [b"srtr_".as_ref(), b"lrtr_".as_ref()] {
            for item in self.persistent.db.iterator_cf(&registry_cf, IteratorMode::From(prefix, Direction::Forward)) {
                let (k, _) = match item {
                    Ok(kv) => kv,
                    Err(e) => return Err(IntegrationError::StorageError(
                        format!("registry_lthash_rebuild iterator failed: {}", e))),
                };
                if !k.starts_with(prefix) { break; }
                let node_id = match std::str::from_utf8(&k[prefix.len()..]) { Ok(s) => s.to_string(), Err(_) => continue };
                if !seen.insert(node_id.clone()) { continue; } // counted/handled under the other prefix already
                let nk = format!("node_{}", node_id);
                let val = match self.persistent.db.get_cf(&registry_cf, nk.as_bytes()) { Ok(Some(v)) => v, _ => continue };
                let parsed: serde_json::Value = match serde_json::from_slice(&val) { Ok(p) => p, Err(_) => continue };
                let h = match parsed["reg_height"].as_u64() { Some(h) => h, None => continue };
                if h <= up_to_height {
                    // Ranks are assigned in the second pass, once every survivor is known.
                    survivors.push((h, node_id.clone(), parsed.clone()));
                } else {
                    // orphan of a discarded block — prune node_ + both roster indices. No wallet_ reverse
                    // index exists (resolution derives the id), so nothing else to drop.
                    batch.delete_cf(&registry_cf, nk.as_bytes());
                    batch.delete_cf(&registry_cf, format!("srtr_{}", node_id).as_bytes());
                    batch.delete_cf(&registry_cf, format!("lrtr_{}", node_id).as_bytes());
                    // The dedup-origin marker goes with the row: leaving it would reject the
                    // registration when the canonical chain re-applies it.
                    batch.delete_cf(&registry_cf, format!("nreg_{}", node_id).as_bytes());
                    pruned += 1;
                }
            }
        }
        // Canonical order, then contiguous ranks from 0. Rewriting the row is required: reg_index is
        // hashed, so a stale value on disk would fold into a root nobody else computes.
        survivors.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        for (h, node_id, mut parsed) in survivors.into_iter() {
            let ntype_for_space = parsed["node_type"].as_str().unwrap_or("").to_string();
            let sp = match Self::index_space_of(&node_id, &ntype_for_space) { Some(v) => v, None => continue };
            let rank = next_index[sp];
            next_index[sp] = rank.saturating_add(1);
            if parsed["reg_index"].as_u64().map(|v| v as u32) != Some(rank) {
                parsed["reg_index"] = serde_json::json!(rank);
                batch.put_cf(
                    &registry_cf,
                    format!("node_{}", node_id).as_bytes(),
                    parsed.to_string().as_bytes(),
                );
            }
            let wallet = parsed["wallet"].as_str().unwrap_or("");
            let burn = parsed["burn"].as_str().unwrap_or("");
            let ntype = parsed["node_type"].as_str().unwrap_or("");
            let vrf = parsed["vrf_pk_sha3"].as_str()
                .and_then(|s| hex::decode(s).ok()).unwrap_or_default();
            lt.add(&crate::registry_lthash::row_lanes(&node_id, wallet, h, rank, ntype, burn, &vrf));
        }

        let root = lt.root();
        batch.put_cf(&meta_cf, Self::REGISTRY_LT_STATE_KEY, lt.to_bytes().as_ref());
        batch.put_cf(&meta_cf, Self::REGISTRY_NEXT_INDEX_KEY, &Self::next_indices_bytes(&next_index));
        for item in self.persistent.db.iterator_cf(&meta_cf, IteratorMode::From(b"rr_seal_", Direction::Forward)) {
            let (k, _) = match item {
                Ok(kv) => kv,
                Err(e) => return Err(IntegrationError::StorageError(
                    format!("registry_lthash_seal iterator failed: {}", e))),
            };
            if !k.starts_with(b"rr_seal_") { break; }
            if k.len() == 8 + 8 {
                let h = u64::from_be_bytes(k[8..16].try_into().unwrap_or([0u8; 8]));
                if h > up_to_height { batch.delete_cf(&meta_cf, &k); }
            }
        }
        let mut key = b"rr_seal_".to_vec();
        key.extend_from_slice(&up_to_height.to_be_bytes());
        batch.put_cf(&meta_cf, &key, &root);
        self.persistent.db.write(batch)?;
        // Same reset sites (boot/snapshot/reorg) must also canonicalize the heartbeat liveness index.
        let _ = self.canonicalize_heartbeat_index(up_to_height);
        Ok(pruned)
    }

}

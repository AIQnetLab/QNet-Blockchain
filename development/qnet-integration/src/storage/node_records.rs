//! Node registrations, endpoints, VRF keys, ping history, reputation, FCM and cleanup sweeps.

use super::*;

impl Storage {
    /// True iff this node's NodeRegistration is chain-confirmed (reg_height stamped at
    /// block-apply / genesis boot) in the local node_registry. The on-chain binding is the
    /// source of truth — a locally-persisted activation code does NOT prove the registration
    /// TX landed. Used at boot to decide whether to (re)send the binding TX.
    pub fn is_node_registration_onchain(&self, node_id: &str) -> bool {
        let registry_cf = match self.persistent.db.cf_handle("node_registry") {
            Some(cf) => cf,
            None => return false,
        };
        let key = format!("node_{}", node_id);
        match self.persistent.db.get_cf(&registry_cf, key.as_bytes()) {
            Ok(Some(v)) => serde_json::from_slice::<serde_json::Value>(&v)
                .map(|p| p["reg_height"].as_u64().is_some())
                .unwrap_or(false),
            _ => false,
        }
    }

    /// O(1) lookup: get node by wallet — derives the canonical id + point-reads node_<id> (no reverse index).
    pub fn get_node_by_wallet(&self, wallet_address: &str) -> IntegrationResult<Option<(String, String)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let id = match self.resolve_node_id(wallet_address) { Some(i) => i, None => return Ok(None) };
        let node_type = match self.persistent.db.get_cf(&registry_cf, format!("node_{}", id).as_bytes())? {
            Some(v) => serde_json::from_slice::<serde_json::Value>(&v).ok()
                .and_then(|j| j["node_type"].as_str().map(|s| s.to_string())).unwrap_or_default(),
            None => return Ok(None),
        };
        Ok(Some((id, node_type)))
    }
    
    /// v4.9: Save device signature for node (used for migration detection)
    /// Key: device_{node_id} → device_id string
    /// When a super node migrates to a new server, the old server detects the change
    /// by comparing its own device_id with the stored one on genesis nodes.
    pub fn save_node_device_id(&self, node_id: &str, device_id: &str) -> IntegrationResult<()> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let key = format!("device_{}", node_id);
        let data = json!({
            "device_id": device_id,
            "updated_at": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
        });
        self.persistent.db.put_cf(&registry_cf, key.as_bytes(), data.to_string().as_bytes())?;
        Ok(())
    }
    
    /// v4.9: Get current device signature for node (O(1) lookup)
    /// Returns None if node not found or never had a device_id stored
    pub fn get_node_device_id(&self, node_id: &str) -> IntegrationResult<Option<String>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let key = format!("device_{}", node_id);
        match self.persistent.db.get_cf(&registry_cf, key.as_bytes())? {
            Some(value) => {
                let json_str = std::str::from_utf8(&value)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                let parsed: serde_json::Value = serde_json::from_str(json_str)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(parsed["device_id"].as_str().map(|s| s.to_string()))
            }
            None => Ok(None),
        }
    }
    
    /// Chain-announced RPC endpoint for a node, persisted in the registry CF (so it survives restarts
    /// and rides the state snapshot a cold joiner restores). NOT part of registry_root — it is reachability
    /// metadata, not consensus state. Sole writer is the block-apply registration scan; without it the
    /// endpoint lived only in a process-local map, so a fresh joiner could reach nothing but the pinned
    /// genesis IPs and burn-attestation quorum became unreachable once the committee outgrew them.
    pub fn save_node_endpoint(&self, node_id: &str, endpoint: &str) -> IntegrationResult<()> {
        if endpoint.is_empty() { return Ok(()); }
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        self.persistent.db.put_cf(&cf, format!("nep_{}", node_id).as_bytes(), endpoint.as_bytes())?;
        Ok(())
    }

    /// Committed RPC endpoint for `node_id`, or None if the node publishes no endpoint.
    pub fn load_node_endpoint(&self, node_id: &str) -> IntegrationResult<Option<String>> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        match self.persistent.db.get_cf(&cf, format!("nep_{}", node_id).as_bytes())? {
            Some(v) => Ok(String::from_utf8(v).ok().filter(|s| !s.is_empty())),
            None => Ok(None),
        }
    }

    /// Every persisted Super/genesis endpoint as (node_id, endpoint), for the boot rehydrate of the
    /// in-RAM endpoint registry. node_ids are type-prefixed, so the two seeks below cover exactly the
    /// same set `srtr_` indexes and never enter the `nep_light_*` key range (10M-scale, always empty
    /// because a light registration carries no endpoint) — bounded by the Super count, not the roster.
    pub fn load_all_node_endpoints(&self) -> IntegrationResult<Vec<(String, String)>> {
        use rocksdb::{IteratorMode, Direction};
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let mut out: Vec<(String, String)> = Vec::new();
        for prefix in [b"nep_genesis_node_".as_ref(), b"nep_super_".as_ref()] {
            for item in self.persistent.db.iterator_cf(&cf, IteratorMode::From(prefix, Direction::Forward)) {
                let (k, v) = match item {
                    Ok(kv) => kv,
                    Err(e) => return Err(IntegrationError::StorageError(
                        format!("load_all_node_endpoints iterator failed: {}", e))),
                };
                if !k.starts_with(prefix) { break; }
                let node_id = match std::str::from_utf8(&k[4..]) { Ok(s) => s, Err(_) => continue };
                let endpoint = match std::str::from_utf8(&v) { Ok(s) => s, Err(_) => continue };
                if node_id.is_empty() || endpoint.is_empty() { continue; }
                out.push((node_id.to_string(), endpoint.to_string()));
            }
        }
        Ok(out)
    }

    /// v4.0: Save VRF public key for node (persists across restarts)
    pub fn save_vrf_public_key(&self, node_id: &str, pk_hex: &str) -> IntegrationResult<()> {
        // Same rule as the RAM registry: a genesis identity's key is pinned in the binary and nothing
        // off the wire may restate it. This leg is the dangerous one — the row survives restarts, the
        // boot reload re-imports it without re-authentication, and the consensus vote/QC verifiers read
        // the row BEFORE falling back to the anchor, so a poisoned row outranks the pinned truth.
        let anchor = qnet_consensus::consensus_crypto::get_consensus_pk_anchor(node_id);
        let incoming = hex::decode(pk_hex).unwrap_or_default();
        if crate::genesis_constants::genesis_pk_overwrite_refused(anchor.as_deref(), &incoming) {
            println!("[ERR][STORAGE] genesis_vrf_pk_overwrite_refused node={}", node_id);
            return Ok(());
        }
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let key = format!("vrf_pk_{}", node_id);
        // IMMUTABLE ONCE STAMPED, for every identity — not only anchored genesis ones. This row is the
        // consensus trust root (vote/QC verify, producer-signature verify, burn-attestor PK), and a
        // later write for the same node_id was an identity takeover: a second registration naming an
        // existing node_id is a state no-op, so the rewrite was silent. Mirrors vrf_pk_sha3 in the
        // node_ row. Re-writing the SAME key stays idempotent.
        if let Some(existing) = self.persistent.db.get_cf(&registry_cf, key.as_bytes())? {
            if existing.as_slice() != pk_hex.as_bytes() {
                println!("[ERR][STORAGE] vrf_pk_rebind_refused node={}", node_id);
            }
            return Ok(());
        }
        self.persistent.db.put_cf(&registry_cf, key.as_bytes(), pk_hex.as_bytes())?;
        println!("[INFO][STORAGE] vrf_pk_saved node={}", node_id);
        Ok(())
    }
    
    /// The digest of the consensus key this node's committed registry row binds to `node_id`
    /// (`node_<id>.vrf_pk_sha3`, covered by registry_root). It is what makes a key offered on the
    /// wire verifiable without trusting the sender.
    pub fn vrf_pk_commitment(&self, node_id: &str) -> Option<String> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")?;
        let raw = self.persistent.db.get_cf(&registry_cf, format!("node_{}", node_id).as_bytes()).ok().flatten()?;
        let parsed: serde_json::Value = serde_json::from_slice(&raw).ok()?;
        parsed["reg_height"].as_u64()?; // chain-confirmed rows only
        parsed["vrf_pk_sha3"].as_str().filter(|t| !t.is_empty()).map(|t| t.to_string())
    }

    /// v4.0: Load VRF public key for node
    pub fn load_vrf_public_key(&self, node_id: &str) -> IntegrationResult<Option<Vec<u8>>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let key = format!("vrf_pk_{}", node_id);
        match self.persistent.db.get_cf(&registry_cf, key.as_bytes())? {
            Some(data) => {
                let hex_str = std::str::from_utf8(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                let pk_bytes = hex::decode(hex_str)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(Some(pk_bytes))
            }
            None => Ok(None),
        }
    }
    
    /// v4.0: Load ALL stored VRF public keys (for startup restoration)
    pub fn load_all_vrf_public_keys(&self) -> IntegrationResult<Vec<(String, Vec<u8>)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry CF not found".to_string()))?;
        let prefix = b"vrf_pk_";
        let mut result = Vec::new();
        let iter = self.persistent.db.prefix_iterator_cf(&registry_cf, prefix);
        for item in iter {
            if let Ok((key, value)) = item {
                let key_str = std::str::from_utf8(&key).unwrap_or("");
                if !key_str.starts_with("vrf_pk_") { break; }
                let node_id = &key_str[7..]; // Skip "vrf_pk_" prefix
                if let Ok(hex_str) = std::str::from_utf8(&value) {
                    if let Ok(pk_bytes) = hex::decode(hex_str) {
                        result.push((node_id.to_string(), pk_bytes));
                    }
                }
            }
        }
        println!("[INFO][STORAGE] vrf_pk_loaded count={}", result.len());
        Ok(result)
    }
    
    /// Load node registration
    pub fn load_node_registration(&self, node_id: &str) -> IntegrationResult<Option<(String, String, f64)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let key = format!("node_{}", node_id);
        match self.persistent.db.get_cf(&registry_cf, key.as_bytes())? {
            Some(data) => {
                let json_str = std::str::from_utf8(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                let parsed: serde_json::Value = serde_json::from_str(json_str)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                
                // PRODUCTION v2.41.1: Validate required fields
                let node_type = match parsed["node_type"].as_str() {
                    Some(t) => t.to_string(),
                    None => {
                        eprintln!("[WARN][STORAGE] node_registration_missing_type id={} data={}", 
                                 node_id, json_str);
                        return Err(IntegrationError::DeserializationError(
                            format!("Missing node_type for {}", node_id)));
                    }
                };
                let wallet = parsed["wallet"].as_str().unwrap_or("").to_string();
                let reputation = parsed["reputation"].as_f64()
                    .unwrap_or(qnet_consensus::deterministic_reputation::INITIAL_REPUTATION);
                
                Ok(Some((node_type, wallet, reputation)))
            },
            None => Ok(None),
        }
    }

    /// Chain-confirmed registration height of a node (None if unregistered or reg_height unstamped).
    /// Used to bound the eligible-producer candidate set to registrations confirmed AS OF a macroblock
    /// end_height: committee members at divergent live applied tips (production never waits for
    /// consensus) must compute the SAME set, so an ahead-of-end_height registration must be excluded
    /// identically on every node. Genesis nodes carry reg_height=0.
    /// The CANONICAL consensus-key commitment for `node_id`: sha3-256 of its consensus public key as
    /// recorded in the `node_` registry row. Unlike the standalone `vrf_pk_` row, this one is written
    /// only by chain apply, is reg_height-bounded, is covered by registry_root, and IS pruned when a
    /// branch is reorged out — so a verdict derived from it cannot depend on which branches this node
    /// happened to see.
    pub fn node_signer_key_commitment(&self, node_id: &str) -> IntegrationResult<Option<String>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        match self.persistent.db.get_cf(&registry_cf, format!("node_{}", node_id).as_bytes())? {
            Some(data) => {
                let parsed: serde_json::Value = serde_json::from_slice(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(parsed["vrf_pk_sha3"].as_str().filter(|v| !v.is_empty()).map(|v| v.to_string()))
            }
            None => Ok(None),
        }
    }

    pub fn node_reg_height(&self, node_id: &str) -> IntegrationResult<Option<u64>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let key = format!("node_{}", node_id);
        match self.persistent.db.get_cf(&registry_cf, key.as_bytes())? {
            Some(data) => {
                let parsed: serde_json::Value = serde_json::from_slice(&data)
                    .map_err(|e| IntegrationError::DeserializationError(e.to_string()))?;
                Ok(parsed["reg_height"].as_u64())
            }
            None => Ok(None),
        }
    }

    /// Get the node registered to a wallet (mobile app reads it even when the node is offline — data comes
    /// from chain storage, not node memory). Deterministic wallet→node resolution: derive the wallet's
    /// canonical id (pure fn of the wallet) and point-read node_<id>. No stored reverse index ⇒ every
    /// honest node returns the identical answer, no per-node flip. O(1) (≤3 point-reads). One wallet backs
    /// at most one node (each id costs a burn). Vec-typed for the existing callers; ≤1 element.
    pub fn get_nodes_by_wallet(&self, wallet_address: &str) -> IntegrationResult<Vec<(String, String, f64)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let id = match self.resolve_node_id(wallet_address) { Some(i) => i, None => return Ok(Vec::new()) };
        let (node_type, reputation) = match self.persistent.db.get_cf(&registry_cf, format!("node_{}", id).as_bytes())? {
            Some(v) => {
                let np: serde_json::Value = serde_json::from_slice(&v).unwrap_or_default();
                (np["node_type"].as_str().unwrap_or("").to_string(),
                 np["reputation"].as_f64().unwrap_or(qnet_consensus::deterministic_reputation::INITIAL_REPUTATION))
            }
            None => return Ok(Vec::new()),
        };
        Ok(vec![(id, node_type, reputation)])
    }

    /// Every node identity this wallet owns, with the permanent registry facts a client needs to render
    /// its own node lifecycle: (node_id, node_type, reg_height, burn_tx). Unlike `resolve_node_id` this
    /// returns ALL matches — one wallet can hold a Super and a Light identity at once — and it reads only
    /// the `node_<id>` row, which is retained for the life of the chain, so the answer survives the
    /// tx-index retention that removes the registration TX itself.
    pub fn wallet_node_records(&self, wallet: &str) -> IntegrationResult<Vec<(String, String, u64, String)>> {
        let cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        let mut cands: Vec<String> = Vec::with_capacity(3);
        for (id, w) in crate::genesis_constants::GENESIS_WALLETS {
            if *w == wallet { cands.push(format!("genesis_node_{}", id)); break; }
        }
        cands.push(crate::rpc::generate_super_node_pseudonym(wallet));
        cands.push(crate::rpc::generate_light_node_pseudonym(wallet));
        let mut out = Vec::new();
        for id in cands {
            let raw = match self.persistent.db.get_cf(&cf, format!("node_{}", id).as_bytes()) {
                Ok(Some(v)) => v,
                _ => continue,
            };
            let p: serde_json::Value = match serde_json::from_slice(&raw) { Ok(v) => v, Err(_) => continue };
            // Chain-confirmed only: an RPC/discovery cache row carries no reg_height and is not an event.
            let h = match p["reg_height"].as_u64() { Some(h) => h, None => continue };
            out.push((
                id,
                p["node_type"].as_str().unwrap_or("").to_string(),
                h,
                p["burn_tx"].as_str().unwrap_or("").to_string(),
            ));
        }
        Ok(out)
    }

    /// Derive the wallet's candidate node ids (pure functions of the wallet: genesis constant map, else
    /// super_node_<h> / light_mobile_<h>) and return the first whose node_<id> row exists. Recomputed
    /// identically on every node — resolution never reads a mutable, race-able reverse slot.
    pub(super) fn resolve_node_id(&self, wallet: &str) -> Option<String> {
        let cf = self.persistent.db.cf_handle("node_registry")?;
        let mut cands: Vec<String> = Vec::with_capacity(3);
        for (id, w) in crate::genesis_constants::GENESIS_WALLETS {
            if *w == wallet { cands.push(format!("genesis_node_{}", id)); break; }
        }
        cands.push(crate::rpc::generate_super_node_pseudonym(wallet));
        cands.push(crate::rpc::generate_light_node_pseudonym(wallet));
        cands.into_iter().find(|id|
            matches!(self.persistent.db.get_cf(&cf, format!("node_{}", id).as_bytes()), Ok(Some(_))))
    }
    
    /// v4.3: Load ALL node registrations from RocksDB for P2P registry restore on startup.
    /// Returns Vec of (node_id, wallet_address, node_type, registered_at) tuples.
    /// Called once during node initialization to populate in-memory P2P registry from
    /// blockchain state, ensuring the registry survives node restarts.
    /// This is a one-time startup operation — O(N) is acceptable here.
    pub fn load_all_node_registrations(&self) -> IntegrationResult<Vec<(String, String, String, u64)>> {
        let registry_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let prefix = b"node_";
        let iter = self.persistent.db.prefix_iterator_cf(&registry_cf, prefix);
        let mut result = Vec::new();
        
        for item in iter {
            if let Ok((key, value)) = item {
                let key_str = match std::str::from_utf8(&key) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                
                if !key_str.starts_with("node_") { continue; }
                let node_id = &key_str[5..];
                
                let json_str = match std::str::from_utf8(&value) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let parsed: serde_json::Value = match serde_json::from_str(json_str) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                
                let node_type = parsed["node_type"].as_str().unwrap_or("unknown").to_string();
                let wallet = parsed["wallet"].as_str().unwrap_or("").to_string();
                let timestamp = parsed["timestamp"].as_u64().unwrap_or(0);
                
                if !wallet.is_empty() {
                    result.push((node_id.to_string(), wallet, node_type, timestamp));
                }
            }
        }
        
        println!("[INFO][STORAGE] load_all_node_registrations count={}", result.len());
        Ok(result)
    }
    
    // ============================================
    // SCALABILITY: PING HISTORY IN ROCKSDB
    // ============================================
    
    /// Save ping attempt result
    pub fn save_ping_attempt(&self, node_id: &str, timestamp: u64, success: bool, response_time_ms: u32) -> IntegrationResult<()> {
        let ping_cf = self.persistent.db.cf_handle("ping_history")
            .ok_or_else(|| IntegrationError::StorageError("ping_history column family not found".to_string()))?;
        
        // Use timestamp in key for ordering
        let key = format!("ping_{}_{}", node_id, timestamp);
        let data = json!({
            "success": success,
            "response_time_ms": response_time_ms,
            "timestamp": timestamp
        });
        
        self.persistent.db.put_cf(&ping_cf, key.as_bytes(), data.to_string().as_bytes())?;
        
        // Cleanup old pings (older than 24 hours)
        self.cleanup_old_pings(node_id, timestamp - 86400)?;
        
        Ok(())
    }
    
    /// Get ping history for a node
    pub fn get_ping_history(&self, node_id: &str, since_timestamp: u64) -> IntegrationResult<Vec<(u64, bool, u32)>> {
        let ping_cf = self.persistent.db.cf_handle("ping_history")
            .ok_or_else(|| IntegrationError::StorageError("ping_history column family not found".to_string()))?;
        
        let mut pings = Vec::new();
        let prefix = format!("ping_{}_", node_id);
        let iter = self.persistent.db.iterator_cf(&ping_cf, rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward));
        
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if !key_str.starts_with(&prefix) {
                break; // Reached end of this node's pings
            }
            
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&value) {
                let timestamp = parsed["timestamp"].as_u64().unwrap_or(0);
                if timestamp >= since_timestamp {
                    let success = parsed["success"].as_bool().unwrap_or(false);
                    let response_time = parsed["response_time_ms"].as_u64().unwrap_or(0) as u32;
                    pings.push((timestamp, success, response_time));
                }
            }
        }
        
        Ok(pings)
    }
    
    /// Cleanup old ping records
    pub(super) fn cleanup_old_pings(&self, node_id: &str, cutoff_timestamp: u64) -> IntegrationResult<()> {
        let ping_cf = self.persistent.db.cf_handle("ping_history")
            .ok_or_else(|| IntegrationError::StorageError("ping_history column family not found".to_string()))?;
        
        let prefix = format!("ping_{}_", node_id);
        let iter = self.persistent.db.iterator_cf(&ping_cf, rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward));
        
        let mut batch = WriteBatch::default();
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if !key_str.starts_with(&prefix) {
                break;
            }
            
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&value) {
                let timestamp = parsed["timestamp"].as_u64().unwrap_or(0);
                if timestamp < cutoff_timestamp {
                    batch.delete_cf(&ping_cf, &key);
                }
            }
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(())
    }
    
    // ============================================
    // PRODUCTION: REPUTATION HISTORY STORAGE
    // ============================================
    
    /// Save reputation change event (for audit trail and history)
    pub(super) fn save_reputation_change_internal(&self, node_id: &str, old_value: f64, new_value: f64, reason: &str) -> IntegrationResult<()> {
        let rep_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // Key: rep_history_{node_id}_{timestamp} for chronological ordering
        let key = format!("rep_history_{}_{}", node_id, timestamp);
        let data = serde_json::json!({
            "node_id": node_id,
            "old_value": old_value,
            "new_value": new_value,
            "delta": new_value - old_value,
            "reason": reason,
            "timestamp": timestamp
        });
        
        self.persistent.db.put_cf(&rep_cf, key.as_bytes(), data.to_string().as_bytes())?;
        
        // Cleanup old history (keep only last 7 days)
        self.cleanup_old_reputation_history(node_id, timestamp - (7 * 86400))?;
        
        Ok(())
    }
    
    /// Get reputation history for a node
    pub(super) fn get_reputation_history_internal(&self, node_id: &str, limit: usize) -> IntegrationResult<Vec<serde_json::Value>> {
        let rep_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let mut history = Vec::new();
        let prefix = format!("rep_history_{}_", node_id);
        
        // Iterate in reverse to get most recent first
        let iter = self.persistent.db.iterator_cf(
            &rep_cf, 
            rocksdb::IteratorMode::From(
                format!("{}~", prefix).as_bytes(), // ~ is after digits in ASCII
                rocksdb::Direction::Reverse
            )
        );
        
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if !key_str.starts_with(&prefix) {
                break;
            }
            
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&value) {
                history.push(parsed);
                if history.len() >= limit {
                    break;
                }
            }
        }
        
        Ok(history)
    }
    
    /// Cleanup old reputation history records
    pub(super) fn cleanup_old_reputation_history(&self, node_id: &str, cutoff_timestamp: u64) -> IntegrationResult<()> {
        let rep_cf = self.persistent.db.cf_handle("node_registry")
            .ok_or_else(|| IntegrationError::StorageError("node_registry column family not found".to_string()))?;
        
        let prefix = format!("rep_history_{}_", node_id);
        let iter = self.persistent.db.iterator_cf(&rep_cf, rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward));
        
        let mut batch = WriteBatch::default();
        for item in iter {
            let (key, value) = item?;
            let key_str = std::str::from_utf8(&key).unwrap_or("");
            
            if !key_str.starts_with(&prefix) {
                break;
            }
            
            if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&value) {
                let timestamp = parsed["timestamp"].as_u64().unwrap_or(0);
                if timestamp < cutoff_timestamp {
                    batch.delete_cf(&rep_cf, &key);
                }
            }
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(())
    }
    
    // ============================================
    // FCM TOKEN STORAGE (genesis-local, never gossiped)
    // Stores real FCM device tokens so ping service can deliver push notifications.
    // Tokens are NOT in the P2P gossip registry (privacy / gossip bandwidth).
    // Key: node_id (pseudonym), Value: JSON { token, push_type, endpoint? }
    // ============================================

    /// Persist the real FCM device token for a light node (GDPR: stored only on the
    /// genesis node that received the registration, never gossiped).
    /// `ts` is the record's authoritative event time (stamped by the genesis that served the
    /// original refresh) — carried through peer sync verbatim so every copy converges LWW.
    pub fn save_fcm_token(
        &self,
        node_id: &str,
        token: &str,
        push_type: &str,
        endpoint: Option<&str>,
        ts: u64,
    ) -> IntegrationResult<()> {
        let fcm_cf = self.persistent.db.cf_handle("fcm_tokens")
            .ok_or_else(|| IntegrationError::StorageError("fcm_tokens column family not found".to_string()))?;

        let data = serde_json::json!({
            "token": token,
            "push_type": push_type,
            "endpoint": endpoint.unwrap_or(""),
            "updated_at": ts,
        });

        self.persistent.db.put_cf(&fcm_cf, node_id.as_bytes(), data.to_string().as_bytes())?;
        Ok(())
    }

    /// Full FCM record incl. its LWW timestamp: (token, push_type, endpoint, updated_at).
    pub fn get_fcm_record(&self, node_id: &str) -> Option<(String, String, Option<String>, u64)> {
        let (token, push_type, endpoint) = self.get_fcm_data(node_id)?;
        let fcm_cf = self.persistent.db.cf_handle("fcm_tokens")?;
        let raw = self.persistent.db.get_cf(&fcm_cf, node_id.as_bytes()).ok()??;
        let json: serde_json::Value = serde_json::from_slice(&raw).ok()?;
        Some((token, push_type, endpoint, json["updated_at"].as_u64().unwrap_or(0)))
    }

    /// Load FCM data for a light node.
    /// Returns `(token, push_type, endpoint)` or `None` if not found.
    pub fn get_fcm_data(&self, node_id: &str) -> Option<(String, String, Option<String>)> {
        let fcm_cf = self.persistent.db.cf_handle("fcm_tokens")?;

        let raw = self.persistent.db.get_cf(&fcm_cf, node_id.as_bytes()).ok()??;
        let json: serde_json::Value = serde_json::from_slice(&raw).ok()?;

        let token = json["token"].as_str().unwrap_or("").to_string();
        let push_type = json["push_type"].as_str().unwrap_or("polling").to_string();
        let endpoint = json["endpoint"].as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        if token.is_empty() { None } else { Some((token, push_type, endpoint)) }
    }

    /// C: light ping delegation keys — operational CF read per-ping so the crypto stays off the RAM
    /// registry. Written at register / gossip-receive AFTER the identity guard passes; No-op on empty.
    pub fn save_light_ping_keys(&self, node_id: &str, ping_pubkey: &str, ping_delegation_cert: &str) -> IntegrationResult<()> {
        if ping_pubkey.is_empty() { return Ok(()); }
        let cf = self.persistent.db.cf_handle("light_ping_keys")
            .ok_or_else(|| IntegrationError::StorageError("light_ping_keys column family not found".to_string()))?;
        let v = json!({ "ping_pubkey": ping_pubkey, "ping_delegation_cert": ping_delegation_cert });
        self.persistent.db.put_cf(&cf, node_id.as_bytes(), v.to_string().as_bytes())?;
        Ok(())
    }
    pub fn get_light_ping_keys(&self, node_id: &str) -> Option<(String, String)> {
        let cf = self.persistent.db.cf_handle("light_ping_keys")?;
        let raw = self.persistent.db.get_cf(&cf, node_id.as_bytes()).ok()??;
        let j: serde_json::Value = serde_json::from_slice(&raw).ok()?;
        let pk = j["ping_pubkey"].as_str().unwrap_or("").to_string();
        if pk.is_empty() { return None; }
        Some((pk, j["ping_delegation_cert"].as_str().unwrap_or("").to_string()))
    }

    // ============================================
    // PRODUCTION: ATTESTATION STORAGE (Light nodes)
    // ============================================
    
    /// Save Light node attestation (persistent for reward calculation)
    pub fn save_attestation(&self, light_node_id: &str, slot: u64, pinger_id: &str, timestamp: u64) -> IntegrationResult<()> {
        let att_cf = self.persistent.db.cf_handle("attestations")
            .ok_or_else(|| IntegrationError::StorageError("attestations column family not found".to_string()))?;
        
        // Key: att_{light_node_id}_{slot} for deduplication
        let key = format!("att_{}_{}", light_node_id, slot);
        let data = json!({
            "light_node_id": light_node_id,
            "slot": slot,
            "pinger_id": pinger_id,
            "timestamp": timestamp
        });
        
        self.persistent.db.put_cf(&att_cf, key.as_bytes(), data.to_string().as_bytes())?;
        Ok(())
    }
    
    /// Check if attestation exists for Light node in slot
    pub fn has_attestation(&self, light_node_id: &str, slot: u64) -> IntegrationResult<bool> {
        let att_cf = self.persistent.db.cf_handle("attestations")
            .ok_or_else(|| IntegrationError::StorageError("attestations column family not found".to_string()))?;
        
        let key = format!("att_{}_{}", light_node_id, slot);
        Ok(self.persistent.db.get_cf(&att_cf, key.as_bytes())?.is_some())
    }
    
    /// Count attestations for Light node in 4h window (for reward eligibility)
    pub fn count_attestations_in_window(&self, light_node_id: &str, window_start_slot: u64, window_end_slot: u64) -> IntegrationResult<u32> {
        let att_cf = self.persistent.db.cf_handle("attestations")
            .ok_or_else(|| IntegrationError::StorageError("attestations column family not found".to_string()))?;
        
        let mut count = 0u32;
        for slot in window_start_slot..=window_end_slot {
            let key = format!("att_{}_{}", light_node_id, slot);
            if self.persistent.db.get_cf(&att_cf, key.as_bytes())?.is_some() {
                count += 1;
            }
        }
        Ok(count)
    }
    
    /// Cleanup old attestations (older than 24 hours)
    /// Bounded, resumable sweep over a column family: examine at most `SWEEP_SCAN_CAP` rows
    /// starting from a persisted cursor, delete the ones `is_stale` rejects, and store where to
    /// resume. An unbounded pass over a CF that grows with the network is a multi-second stall on
    /// whatever thread called it, and it accumulates one WriteBatch for the whole result.
    pub(super) fn bounded_sweep<F>(&self, cf_name: &str, cursor_key: &[u8], is_stale: F) -> IntegrationResult<u32>
    where
        F: Fn(&[u8], &[u8]) -> bool,
    {
        /// Rows examined per call. The hourly cadence catches up on the rest.
        const SWEEP_SCAN_CAP: usize = 100_000;

        let cf = self.persistent.db.cf_handle(cf_name)
            .ok_or_else(|| IntegrationError::StorageError(format!("{} column family not found", cf_name)))?;
        let meta_cf = self.persistent.db.cf_handle("metadata")
            .ok_or_else(|| IntegrationError::StorageError("metadata column family not found".to_string()))?;

        let cursor = self.persistent.db.get_cf(&meta_cf, cursor_key).ok().flatten().unwrap_or_default();
        let mode = if cursor.is_empty() {
            rocksdb::IteratorMode::Start
        } else {
            rocksdb::IteratorMode::From(&cursor, rocksdb::Direction::Forward)
        };

        let mut batch = WriteBatch::default();
        let mut removed = 0u32;
        let mut examined = 0usize;
        let mut last_key: Option<Vec<u8>> = None;

        for item in self.persistent.db.iterator_cf(&cf, mode) {
            let (key, value) = item?;
            examined += 1;
            last_key = Some(key.to_vec());
            if is_stale(&key, &value) {
                batch.delete_cf(&cf, &key);
                removed += 1;
                if removed % 5000 == 0 {
                    self.persistent.db.write(batch)?;
                    batch = WriteBatch::default();
                }
            }
            if examined >= SWEEP_SCAN_CAP {
                break;
            }
        }

        // Cap reached -> resume here next call; scan finished -> wrap to the start.
        let next: Vec<u8> = if examined >= SWEEP_SCAN_CAP { last_key.unwrap_or_default() } else { Vec::new() };
        batch.put_cf(&meta_cf, cursor_key, &next);
        self.persistent.db.write(batch)?;
        Ok(removed)
    }

    pub fn cleanup_old_attestations(&self, cutoff_timestamp: u64) -> IntegrationResult<u32> {
        self.bounded_sweep("attestations", b"sweep_attestations_cursor", |_k, v| {
            serde_json::from_slice::<serde_json::Value>(v)
                .ok()
                .and_then(|p| p["timestamp"].as_u64())
                .map_or(false, |ts| ts < cutoff_timestamp)
        })
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // v3.41: EPHEMERAL DATA CLEANUP - all CFs older than 24h
    // WAL files can only be deleted when ALL CFs flush. Rarely-written CFs
    // (ping_history, consensus, failover_events) keep stale memtables
    // preventing WAL cleanup. These methods + compact_all() reclaim disk space.
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// v3.41: Cleanup old ping_history entries (older than cutoff_timestamp)
    pub fn cleanup_old_pings_all(&self, cutoff_timestamp: u64) -> IntegrationResult<u32> {
        self.bounded_sweep("ping_history", b"sweep_ping_cursor", |_k, v| {
            serde_json::from_slice::<serde_json::Value>(v)
                .ok()
                .and_then(|p| p["timestamp"].as_u64())
                .map_or(false, |ts| ts > 0 && ts < cutoff_timestamp)
        })
    }

    /// v3.41: Cleanup old consensus rounds (keep only recent rounds)
    /// Consensus keys: "round_{number}" — only current round needed
    pub fn cleanup_old_consensus(&self, current_round: u64, retention_rounds: u64) -> IntegrationResult<u32> {
        let consensus_cf = self.persistent.db.cf_handle("consensus")
            .ok_or_else(|| IntegrationError::StorageError("consensus column family not found".to_string()))?;
        
        if current_round <= retention_rounds {
            return Ok(0);
        }
        
        let cutoff_round = current_round - retention_rounds;
        let iter = self.persistent.db.iterator_cf(&consensus_cf, rocksdb::IteratorMode::Start);
        let mut batch = WriteBatch::default();
        let mut removed = 0u32;
        
        for item in iter {
            let (key, _value) = item?;
            let key_str = String::from_utf8_lossy(&key);
            // Skip "latest_round" meta-key
            if let Some(round_str) = key_str.strip_prefix("round_") {
                if let Ok(round) = round_str.parse::<u64>() {
                    if round < cutoff_round {
                        batch.delete_cf(&consensus_cf, &key);
                        removed += 1;
                        if removed % 1000 == 0 {
                            self.persistent.db.write(batch)?;
                            batch = WriteBatch::default();
                        }
                    }
                }
            }
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(removed)
    }
    
    /// v3.41: Cleanup old failover events (older than cutoff_timestamp)
    /// Key format: "failover_{height:012}_{timestamp}" (see save_failover_event)
    /// Value format: bincode-serialized FailoverEvent (timestamp is i64, NOT fixed offset)
    /// SAFE: Parse timestamp from KEY (reliable) instead of value (variable layout)
    pub fn cleanup_old_failover_events(&self, cutoff_timestamp: u64) -> IntegrationResult<u32> {
        let failover_cf = self.persistent.db.cf_handle("failover_events")
            .ok_or_else(|| IntegrationError::StorageError("failover_events column family not found".to_string()))?;
        
        let iter = self.persistent.db.iterator_cf(&failover_cf, rocksdb::IteratorMode::Start);
        let mut batch = WriteBatch::default();
        let mut removed = 0u32;
        
        for item in iter {
            let (key, _value) = item?;
            let key_str = String::from_utf8_lossy(&key);
            
            // Parse timestamp from key: "failover_{height:012}_{timestamp}"
            // Also handle keys that don't match the expected format
            let is_old = if key_str.starts_with("failover_") {
                let parts: Vec<&str> = key_str.splitn(3, '_').collect();
                if parts.len() == 3 {
                    // parts[2] is the timestamp (i64 stored as string)
                    if let Ok(ts) = parts[2].parse::<i64>() {
                        ts > 0 && (ts as u64) < cutoff_timestamp
                    } else {
                        false
                    }
                } else {
                    false
                }
            } else {
                false
            };
            
            if is_old {
                batch.delete_cf(&failover_cf, &key);
                removed += 1;
                if removed % 1000 == 0 {
                    self.persistent.db.write(batch)?;
                    batch = WriteBatch::default();
                }
            }
        }
        
        if batch.len() > 0 {
            self.persistent.db.write(batch)?;
        }
        
        Ok(removed)
    }
    
    /// Cleanup old snapshots, keeping only the latest `keep_count` per type.
    /// Keys: "full_snap_{height}" and "state_snap_{height}". Updates pointers atomically.
    pub fn cleanup_old_snapshots(&self, keep_count: usize) -> IntegrationResult<u32> {
        let snapshots_cf = self.persistent.db.cf_handle("snapshots")
            .ok_or_else(|| IntegrationError::StorageError("snapshots column family not found".to_string()))?;

        let mut removed = 0u32;

        // Clean up both full_snap_ and state_snap_ independently
        for prefix in &["full_snap_", "state_snap_"] {
            let pointer_key: &[u8] = if *prefix == "full_snap_" {
                b"latest_full_snap"
            } else {
                b"latest_state_snap"
            };

            let mut heights: Vec<u64> = Vec::new();
            let iter = self.persistent.db.iterator_cf(&snapshots_cf, rocksdb::IteratorMode::Start);
            for item in iter {
                if let Ok((key, _)) = item {
                    let key_str = String::from_utf8_lossy(&key);
                    if let Some(h_str) = key_str.strip_prefix(prefix) {
                        if let Ok(h) = h_str.parse::<u64>() {
                            heights.push(h);
                        }
                    }
                }
            }

            if heights.len() <= keep_count {
                continue;
            }

            heights.sort_unstable_by(|a, b| b.cmp(a));
            let surviving_max = heights[0];
            let to_delete = &heights[keep_count..];

            let mut batch = WriteBatch::default();
            for h in to_delete {
                // Keep the genesis early anchor (h=90) as a universal cold-join floor: it is always
                // committee-verifiable (genesis committee), so a capsule-less joiner can always fast-sync to it.
                if *h == crate::node::SNAPSHOT_EARLY_ANCHOR_HEIGHT { continue; }
                let key = format!("{}{}", prefix, h);
                batch.delete_cf(&snapshots_cf, key.as_bytes());
                removed += 1;
            }

            // Update pointer to the newest surviving snapshot
            batch.put_cf(&snapshots_cf, pointer_key, &surviving_max.to_le_bytes());
            self.persistent.db.write(batch)?;
        }

        Ok(removed)
    }
    
    /// v3.41: Run full ephemeral data cleanup cycle + compaction
    /// Cleans: ping_history, consensus, failover_events, old snapshots
    /// Then triggers compaction on ALL CFs to physically reclaim disk space
    pub fn run_ephemeral_cleanup(&self, current_height: u64, cutoff_timestamp: u64) -> IntegrationResult<()> {
        let start = std::time::Instant::now();
        
        // 1. Ping history + attestations (>24h). Both live here so the compaction decision
        //    below sees every deletion this pass made.
        let pings_removed = self.cleanup_old_pings_all(cutoff_timestamp).unwrap_or(0);
        let att_removed = match self.cleanup_old_attestations(cutoff_timestamp) {
            Ok(n) => n,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][CLEANUP] attestations_cleanup_failed err={}", e);
                }
                0
            }
        };
        
        
        // 3. Consensus rounds — keep last 1000 rounds
        let current_round = current_height / 90; // macroblock every 90 blocks
        let consensus_removed = self.cleanup_old_consensus(current_round, 1000).unwrap_or(0);
        
        // 4. Failover events (>24h)
        let failover_removed = self.cleanup_old_failover_events(cutoff_timestamp).unwrap_or(0);
        
        // 5. Old snapshots — keep latest SNAPSHOT_KEEP_COUNT (bound by the sync-safety const-assert
        //    in node.rs: keep_count × snapshot interval must stay inside the body-retention window).
        let snapshots_removed = self.cleanup_old_snapshots(crate::node::SNAPSHOT_KEEP_COUNT).unwrap_or(0);

        // 6. v9.0: Prune old tx_index + tx_by_address (runs on ALL node types including Super).
        // Retention: 100,000 blocks (~28h at 1 block/sec). Explorer API queries use tx_by_address;
        // keeping ~1 day is sufficient for most wallet UIs. Historical queries → archive node.
        let tx_pruned = if current_height > TX_INDEX_RETENTION_BLOCKS {
            let prune_before = current_height - TX_INDEX_RETENTION_BLOCKS;
            self.prune_old_transactions(prune_before).unwrap_or(0)
        } else {
            0
        };

        let total_removed = pings_removed as u64 + att_removed as u64 + consensus_removed as u64
            + failover_removed as u64 + snapshots_removed as u64 + tx_pruned;

        // 7. Compact ONLY the CFs that were deleted from, and only once enough rows
        //    went to justify it. Compacting every CF rewrote microblocks + merkle_nodes
        //    (which hold no tombstones) hourly, and `cleanup_old_snapshots` always
        //    removes at least one row so the old `total_removed > 0` guard never closed.
        const COMPACT_MIN_ROWS: u64 = 1_000;
        let mut dirty_cfs: Vec<&str> = Vec::new();
        if att_removed as u64 >= COMPACT_MIN_ROWS { dirty_cfs.push("attestations"); }
        if pings_removed as u64 >= COMPACT_MIN_ROWS { dirty_cfs.push("ping_history"); }
        if consensus_removed as u64 >= COMPACT_MIN_ROWS { dirty_cfs.push("consensus"); }
        if failover_removed as u64 >= COMPACT_MIN_ROWS { dirty_cfs.push("failover_events"); }
        if tx_pruned >= COMPACT_MIN_ROWS {
            dirty_cfs.extend_from_slice(&["transactions", "tx_index", "tx_by_address"]);
        }
        if !dirty_cfs.is_empty() {
            if let Err(e) = self.persistent.compact_cfs(&dirty_cfs) {
                println!("[WARN][CLEANUP] compaction_failed err={}", e);
            }
        }

        let elapsed = start.elapsed();
        if total_removed > 0 {
            println!("[INFO][CLEANUP] ephemeral_cleanup_done elapsed={:?} pings={} attestations={} consensus={} failover={} snapshots={} tx_idx={} total={}",
                     elapsed, pings_removed, att_removed, consensus_removed, failover_removed, snapshots_removed, tx_pruned, total_removed);
        }
        
        Ok(())
    }
    
    // ===== FAILOVER EVENT METHODS =====
    
    /// Save a failover event (optimized with bincode serialization and LZ4 compression)
    /// NOTE: Light nodes should NOT call this method - they don't store failover history
    pub fn save_failover_event(&self, event: &FailoverEvent) -> IntegrationResult<()> {
        // Gate on the authoritative configured role, not an env string a
        // caller could flip: a safety record must not be env-bypassable.
        // Light nodes are pure API clients with no chain storage.
        if self.storage_mode != StorageMode::Super {
            return Ok(());
        }

        let failover_cf = self.persistent.db.cf_handle("failover_events")
            .ok_or_else(|| IntegrationError::StorageError("failover_events column family not found".to_string()))?;

        // Use height as key for efficient range queries
        // Format: failover_<height>_<timestamp> for uniqueness
        let key = format!("failover_{:012}_{}", event.height, event.timestamp);

        // Serialize with bincode (more efficient than JSON)
        let value = bincode::serialize(event)
            .map_err(|e| IntegrationError::StorageError(format!("Failed to serialize failover event: {}", e)))?;

        self.persistent.db.put_cf(&failover_cf, key.as_bytes(), &value)?;

        // Bounded retention: ~30 days (≈100 failovers/day worst case).
        self.cleanup_old_failovers(10_000)?;

        Ok(())
    }
    
    /// Get failover history (optimized with range queries and limit)
    pub fn get_failover_history(&self, from_height: u64, limit: usize) -> IntegrationResult<Vec<FailoverEvent>> {
        let failover_cf = self.persistent.db.cf_handle("failover_events")
            .ok_or_else(|| IntegrationError::StorageError("failover_events column family not found".to_string()))?;
        
        let mut events = Vec::new();
        let start_key = format!("failover_{:012}_", from_height);
        
        let iter = self.persistent.db.iterator_cf(
            &failover_cf,
            rocksdb::IteratorMode::From(start_key.as_bytes(), rocksdb::Direction::Forward)
        );
        
        for item in iter.take(limit) {
            let (_, value) = item?;
            
            if let Ok(event) = bincode::deserialize::<FailoverEvent>(&value) {
                if event.height >= from_height {
                    events.push(event);
                }
            }
        }
        
        Ok(events)
    }
    
    /// Get failover statistics for monitoring
    pub fn get_failover_stats(&self) -> IntegrationResult<serde_json::Value> {
        let failover_cf = self.persistent.db.cf_handle("failover_events")
            .ok_or_else(|| IntegrationError::StorageError("failover_events column family not found".to_string()))?;
        
        let mut total_count = 0;
        let mut by_producer = HashMap::<String, u32>::new();
        let mut by_reason = HashMap::<String, u32>::new();
        
        let iter = self.persistent.db.iterator_cf(&failover_cf, rocksdb::IteratorMode::Start);
        
        for item in iter {
            let (_, value) = item?;
            
            if let Ok(event) = bincode::deserialize::<FailoverEvent>(&value) {
                total_count += 1;
                *by_producer.entry(event.failed_producer).or_insert(0) += 1;
                *by_reason.entry(event.reason).or_insert(0) += 1;
            }
        }
        
        Ok(json!({
            "total_failovers": total_count,
            "by_producer": by_producer,
            "by_reason": by_reason
        }))
    }
    
    /// Cleanup old failover events with smart retention policy
    pub(super) fn cleanup_old_failovers(&self, max_events: usize) -> IntegrationResult<()> {
        let failover_cf = self.persistent.db.cf_handle("failover_events")
            .ok_or_else(|| IntegrationError::StorageError("failover_events column family not found".to_string()))?;
        
        // Two-phase cleanup strategy:
        // 1. Remove events older than 30 days (primary)
        // 2. Keep max_events limit (secondary safety)
        
        let thirty_days_ago = chrono::Utc::now().timestamp() - (30 * 24 * 3600);
        let mut batch = WriteBatch::default();
        let mut count = 0;
        let mut old_count = 0;
        
        // First pass: count and remove old events
        let iter = self.persistent.db.iterator_cf(&failover_cf, rocksdb::IteratorMode::Start);
        for item in iter {
            let (key, value) = item?;
            count += 1;
            
            // Try to deserialize to check timestamp
            if let Ok(event) = bincode::deserialize::<FailoverEvent>(&value) {
                if event.timestamp < thirty_days_ago {
                    batch.delete_cf(&failover_cf, &key);
                    old_count += 1;
                }
            }
        }
        
        // Apply time-based cleanup
        if old_count > 0 {
            self.persistent.db.write(batch)?;
            println!("[INFO][STORAGE] failover_cleanup count={} older_than_days=30", old_count);
        }
        
        // Second safety check: if still too many events, trim oldest
        if count - old_count > max_events {
            let to_delete = (count - old_count) - max_events;
            let mut batch = WriteBatch::default();
            let iter = self.persistent.db.iterator_cf(&failover_cf, rocksdb::IteratorMode::Start);
            
            for item in iter.take(to_delete) {
                let (key, _) = item?;
                batch.delete_cf(&failover_cf, &key);
            }
            
            self.persistent.db.write(batch)?;
            println!("[INFO][STORAGE] failover_trimmed count={} limit={}", to_delete, max_events);
        }
        
        Ok(())
    }
    
}

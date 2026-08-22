//! Contract metadata and storage, block logs and their roots, jail status records.

use super::*;

impl Storage {
    /// Get contract info by address
    pub fn get_contract_info(&self, contract_address: &str) -> IntegrationResult<Option<StoredContractInfo>> {
        let key = format!("contract:info:{}", contract_address);
        
        match self.persistent.load_raw(&key)? {
            Some(data) => {
                match serde_json::from_slice::<StoredContractInfo>(&data) {
                    Ok(stored) => Ok(Some(stored)),
                    Err(e) => {
                        println!("[WARN][STORAGE] contract_info_deserialize_failed err={:?}", e);
                        Ok(None)
                    }
                }
            }
            None => Ok(None)
        }
    }
    
    /// Save contract info
    pub fn save_contract_info(&self, contract_address: &str, info: &StoredContractInfo) -> IntegrationResult<()> {
        let key = format!("contract:info:{}", contract_address);
        
        let data = serde_json::to_vec(info)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        self.persistent.save_raw(&key, &data)?;
        
        // Also save to contract list for enumeration
        self.add_contract_to_list(contract_address)?;
        
        Ok(())
    }
    
    /// Add contract address to the list of all contracts
    pub(super) fn add_contract_to_list(&self, contract_address: &str) -> IntegrationResult<()> {
        let list_key = "contract:list";
        
        // Load existing list
        let mut contracts: Vec<String> = match self.persistent.load_raw(list_key)? {
            Some(data) => serde_json::from_slice(&data).unwrap_or_default(),
            None => Vec::new(),
        };
        
        // Add if not already present
        if !contracts.contains(&contract_address.to_string()) {
            contracts.push(contract_address.to_string());
            let data = serde_json::to_vec(&contracts)
                .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
            self.persistent.save_raw(list_key, &data)?;
        }
        
        Ok(())
    }
    
    /// Get list of all contract addresses
    pub fn get_all_contract_addresses(&self) -> IntegrationResult<Vec<String>> {
        let list_key = "contract:list";
        
        match self.persistent.load_raw(list_key)? {
            Some(data) => {
                let contracts: Vec<String> = serde_json::from_slice(&data)
                    .unwrap_or_default();
                Ok(contracts)
            }
            None => Ok(Vec::new())
        }
    }
    
    /// Get contract state value by key
    pub fn get_contract_state(&self, contract_address: &str, state_key: &str) -> IntegrationResult<Option<String>> {
        let key = format!("contract:state:{}:{}", contract_address, state_key);
        
        match self.persistent.load_raw(&key)? {
            Some(data) => {
                match String::from_utf8(data) {
                    Ok(value) => Ok(Some(value)),
                    Err(e) => {
                        println!("[WARN][STORAGE] contract_state_decode_failed err={:?}", e);
                        Ok(None)
                    }
                }
            }
            None => Ok(None)
        }
    }
    
    /// Save contract state value
    pub fn save_contract_state(&self, contract_address: &str, state_key: &str, value: &str) -> IntegrationResult<()> {
        let key = format!("contract:state:{}:{}", contract_address, state_key);
        self.persistent.save_raw(&key, value.as_bytes())
    }

    /// Receipt store: persist a block's captured WASM event logs for RPC `getLogs`.
    /// Keyed by height; value = bincode of `Vec<(tx_hash, contract_hex, data)>` in emit order.
    /// Not part of state_root, but the leaves feed the gate-0 `logs_root` consensus commitment
    /// (block_logs_root_of → collect_window_block_roots), so a persist/decode failure diverges this node's window logs_root.
    pub fn save_block_logs(&self, height: u64, logs: &[(String, String, Vec<u8>)]) -> IntegrationResult<()> {
        if logs.is_empty() { return Ok(()); }
        let key = format!("blocklogs_{:010}", height);
        let bytes = bincode::serialize(logs)
            .map_err(|e| IntegrationError::StorageError(format!("blocklogs serialize: {}", e)))?;
        self.persistent.save_raw(&key, &bytes)
    }

    /// Read one block's captured WASM logs (emit order), or empty if none. A decode failure is fail-safe
    /// (empty) but warns — it desyncs this node's consensus-committed logs_root.
    pub fn get_block_logs(&self, height: u64) -> Vec<(String, String, Vec<u8>)> {
        let key = format!("blocklogs_{:010}", height);
        match self.persistent.load_raw(&key) {
            Ok(Some(bytes)) => match bincode::deserialize(&bytes) {
                Ok(v) => v,
                Err(e) => {
                    if crate::node::is_warn() {
                        println!("[WARN][LOGS] block_logs_decode_failed h={} err={} (logs_root may diverge)", height, e);
                    }
                    Vec::new()
                }
            },
            _ => Vec::new(),
        }
    }

    /// Per-block logs SUB-ROOT (level 1 of the sharded logs commitment = `logs_merkle_root` over the
    /// block's log leaves). Written at apply so the macroblock seal folds ~90 sub-roots via
    /// `logs_window_root` (never a re-hash of the whole window), and a light-client `/logs/proof` reads
    /// ONE block's leaves + the sub-roots — both O(one block), not O(window). Absent ⇒ log-less block ([0;32]).
    pub fn save_block_logs_root(&self, height: u64, root: &[u8; 32]) -> IntegrationResult<()> {
        let key = format!("blocklogsroot_{:010}", height);
        self.persistent.save_raw(&key, root)
    }
    pub fn get_block_logs_root(&self, height: u64) -> Option<[u8; 32]> {
        let key = format!("blocklogsroot_{:010}", height);
        match self.persistent.load_raw(&key) {
            Ok(Some(bytes)) if bytes.len() == 32 => { let mut r = [0u8; 32]; r.copy_from_slice(&bytes); Some(r) }
            _ => None,
        }
    }

    // NOTE: contract WASM code + storage are NOT kept in a separate RocksDB namespace.
    // They live inside `Account.contract_storage` (the "code" key + hex data entries), so
    // they are part of the state-root-hashed account leaf and survive snapshot/restore for
    // free. The former `save_contract_code`/`get_contract_code` raw-KV helpers were dead
    // (never the real path) and have been removed.

    // =========================================================================
    // JAIL PERSISTENCE (for network-wide consistency)
    // =========================================================================
    
    /// Save jail status for a node (persists across restarts)
    pub fn save_jail_status(&self, node_id: &str, jailed_until: u64, jail_count: u32, reason: &str) -> IntegrationResult<()> {
        let key = format!("jail:{}", node_id);
        let value = format!("{}:{}:{}", jailed_until, jail_count, reason);
        self.persistent.save_raw(&key, value.as_bytes())
    }
    
    /// Get jail status for a node
    pub fn get_jail_status(&self, node_id: &str) -> IntegrationResult<Option<(u64, u32, String)>> {
        let key = format!("jail:{}", node_id);
        match self.persistent.load_raw(&key)? {
            Some(data) => {
                match String::from_utf8(data) {
                    Ok(value) => {
                        let parts: Vec<&str> = value.splitn(3, ':').collect();
                        if parts.len() >= 3 {
                            let jailed_until = parts[0].parse().unwrap_or(0);
                            let jail_count = parts[1].parse().unwrap_or(0);
                            let reason = parts[2].to_string();
                            Ok(Some((jailed_until, jail_count, reason)))
                        } else {
                            Ok(None)
                        }
                    }
                    Err(_) => Ok(None)
                }
            }
            None => Ok(None)
        }
    }
    
    /// Remove jail status for a node (when released)
    pub fn remove_jail_status(&self, node_id: &str) -> IntegrationResult<()> {
        let key = format!("jail:{}", node_id);
        // Save empty to mark as removed (RocksDB doesn't have direct delete in our wrapper)
        self.persistent.save_raw(&key, &[])
    }
    
    /// Get all jail statuses (for loading on startup)
    pub fn get_all_jail_statuses(&self) -> IntegrationResult<Vec<(String, u64, u32, String)>> {
        // Scan for all jail: prefixed keys
        let result = Vec::new();
        
        // Use iterator if available, otherwise return empty
        // Note: This is a simplified implementation - in production you'd use RocksDB iterator
        // For now, we rely on network sync for jail propagation
        
        Ok(result)
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // CERTIFICATE STORAGE ARCHITECTURE v2.29
    // ═══════════════════════════════════════════════════════════════════════════
    // Certificates are NOT stored separately!
    // They are ALREADY embedded in each block's vrf_proof field.
    // 
    // vrf_proof contains PqSignature which includes:
    // - certificate: PqCertificate (~2.6KB)
    // - dilithium_key_signature (pure ML-DSA-65 after P8)
    //
    // For historical block validation:
    // 1. Load block from storage (already have vrf_proof)
    // 2. Extract certificate from vrf_proof
    // 3. Verify signature using extracted certificate
    //
    // This approach uses ZERO additional storage!
    // ═══════════════════════════════════════════════════════════════════════════
}

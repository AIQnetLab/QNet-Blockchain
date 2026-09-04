//! Node registration, heartbeats, light-node eligibility and Merkle reward claims.

use super::*;

impl BlockchainNode {
    /// Create NodeRegistration transaction for on-chain binding
    /// This TX is included in blocks and visible to all nodes
    /// For genesis TXs: use fixed_timestamp=Some(0) for deterministic hashes across all nodes
    /// For runtime TXs: use fixed_timestamp=None for current time
    /// 
    /// v3.35: api_endpoint parameter:
    /// - Super/Genesis: pass public URL (e.g., "https://1.2.3.4:8001") or empty "" to hide
    /// - Light: MUST be empty "" (mobile privacy protection)
    pub fn create_node_registration_tx_with_timestamp(
        node_id: &str,
        node_type: qnet_state::NodeType,
        wallet_address: &str,
        registration_proof: &str,
        api_endpoint: &str,
        fixed_timestamp: Option<u64>,
    ) -> qnet_state::Transaction {
        use qnet_state::TransactionType;
        
        let timestamp = fixed_timestamp.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        });
        
        // SECURITY: Light nodes NEVER have api_endpoint
        let final_endpoint = if node_type == qnet_state::NodeType::Light {
            String::new()
        } else {
            api_endpoint.to_string()
        };
        
        let is_light = node_type == qnet_state::NodeType::Light;
        let mut tx = qnet_state::Transaction {
            hash: String::new(),
            from: wallet_address.to_string(),
            to: None,
            amount: 0,
            nonce: 0,
            gas_price: 0, // Registration is FREE
            gas_limit: 0,
            timestamp,
            signature: None, // Will be signed by system for genesis, by user for others
            public_key: None,
            tx_type: TransactionType::NodeRegistration {
                node_id: node_id.to_string(),
                node_type,
                wallet_address: wallet_address.to_string(),
                registration_proof: registration_proof.to_string(),
                api_endpoint: final_endpoint.clone(),
                // Phase-1 burn-attestation carrier. Empty here: genesis (registration_proof=="genesis")
                // is exempt; a burn-backed super fills these (burn_tx/amount/cost + 2f+1 committee quorum)
                // via the attestation collection path before broadcasting.
                burn_tx: String::new(),
                burn_wallet: String::new(),
                burn_owner_sig: String::new(),
                // B1: announce the node's consensus/VRF pubkey on-chain (canonical carrier) so it rides
                // the snapshot's node_registry copy. Light never signs consensus, so it carries none.
                vrf_pk: if is_light {
                    Vec::new()
                } else {
                    crate::genesis_constants::get_vrf_public_key(node_id).unwrap_or_default()
                },
                burn_amount: 0,
                burn_cost: 0,
                burn_attestors: Vec::new(),
                attest_epoch: 0,
            },
            data: Some(format!("node_registration:{}:{}:{}:{}", node_id, wallet_address, registration_proof, final_endpoint)),
            dilithium_signature: None,
            // Envelope key = the WALLET key, filled in by the signer. Genesis TXs carry their anchored
            // key here instead (they are protocol-minted and have no wallet-key proof).
            dilithium_public_key: None,
            chain_id: qnet_state::transaction::QNET_CHAIN_ID,
        };

        tx.hash = tx.calculate_hash();
        tx
    }

    /// Create NodeRegistration TX for runtime (uses current timestamp)
    /// For Light nodes: api_endpoint is ignored (always empty for privacy)
    /// For Super nodes: pass public API endpoint or empty to hide
    pub fn create_node_registration_tx(
        node_id: &str,
        node_type: qnet_state::NodeType,
        wallet_address: &str,
        registration_proof: &str,
    ) -> qnet_state::Transaction {
        // Default: no api_endpoint (Light nodes), caller should use _with_endpoint for Super
        Self::create_node_registration_tx_with_timestamp(node_id, node_type, wallet_address, registration_proof, "", None)
    }
    
    /// Create NodeRegistration TX with explicit API endpoint (for Super nodes)
    pub fn create_node_registration_tx_with_endpoint(
        node_id: &str,
        node_type: qnet_state::NodeType,
        wallet_address: &str,
        registration_proof: &str,
        api_endpoint: &str,
    ) -> qnet_state::Transaction {
        Self::create_node_registration_tx_with_timestamp(node_id, node_type, wallet_address, registration_proof, api_endpoint, None)
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v9.4: NodeReactivation TX — returning nodes signal they're back online.
    // Flow mirrors NodeRegistration (sync, not async); both sign pure ML-DSA-65:
    //   Genesis nodes: unsigned system TX
    //   Super nodes: ML-DSA-65 (ML-DSA-65) signed via sign_reactivation_tx (no Ed25519 leg,
    //     same as sign_node_registration_tx)
    // ═══════════════════════════════════════════════════════════════════════════

    /// Create base NodeReactivation TX (unsigned).
    /// Signing is done separately by the caller via sign_reactivation_tx().
    /// ALL nodes (Genesis + Super) sign with pure ML-DSA-65 / ML-DSA-65 (WalletIdentity).
    pub fn create_node_reactivation_tx(
        node_id: &str,
        current_height: u64,
        last_macroblock_hash: &str,
        last_macroblock_index: u64,
        api_endpoint: &str,
    ) -> qnet_state::Transaction {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let mut tx = qnet_state::Transaction {
            from: node_id.to_string(),
            to: None,
            amount: 0,
            nonce: last_macroblock_index, // Epoch-based nonce for dedup
            gas_price: u64::MAX,          // MAX priority — must land quickly
            gas_limit: 0,                 // FREE system operation
            timestamp,
            hash: String::new(),
            signature: None,              // Filled by caller for Super nodes
            public_key: None,             // Filled by caller for Super nodes
            tx_type: qnet_state::TransactionType::NodeReactivation {
                node_id: node_id.to_string(),
                current_height,
                last_macroblock_hash: last_macroblock_hash.to_string(),
                last_macroblock_index,
                api_endpoint: api_endpoint.to_string(),
            },
            data: Some(format!(
                "node_reactivation:{}:h={}:mb={}:{}",
                node_id, current_height, last_macroblock_index,
                qnet_state::char_prefix(&last_macroblock_hash, 16)
            )),
            dilithium_signature: None,    // Filled by caller for Super nodes
            dilithium_public_key: None,   // Filled by caller for Super nodes
            chain_id: qnet_state::transaction::QNET_CHAIN_ID,
        };

        tx.hash = tx.calculate_hash();
        tx
    }

    /// v9.4: Create and SIGN NodeReactivation TX (for Super nodes with wallet identity).
    /// Same signing flow as NodeRegistration for Super nodes (line 27237-27283):
    ///   1. Ed25519 from BIP44 mnemonic
    ///   2. ML-DSA-65 from WalletIdentity
    ///   3. Mark as signed, recalculate hash
    pub fn sign_reactivation_tx(
        tx: &mut qnet_state::Transaction,
        node_id: &str,
        wallet_identity: Option<&crate::crypto::vrf::WalletIdentity>,
    ) {
        // Every signed field comes from the TX itself, so the signer and the three verifiers cannot
        // drift: a field added to the type but not read here would silently leave itself unbound.
        let (api_endpoint, current_height, last_mb_hash, last_mb_index) = match &tx.tx_type {
            qnet_state::TransactionType::NodeReactivation {
                api_endpoint, current_height, last_macroblock_hash, last_macroblock_index, ..
            } => (api_endpoint.as_str(), *current_height, last_macroblock_hash.as_str(), *last_macroblock_index),
            _ => ("", 0, "", 0),
        };
        let canonical_msg = Self::chain_bind(&Self::node_reactivation_message(
            node_id, tx.timestamp, api_endpoint, current_height, last_mb_hash, last_mb_index));

        // Pure ML-DSA-65: NodeReactivation is authenticated solely by the node's registered
        // ML-DSA-65 identity key (verified against the on-chain VRF key at block validation).
        // Ed25519 was an illusory second leg — quantum-breakable, no identity binding — removed.
        if let Some(identity) = wallet_identity {
            // FIX-5 wire: RAW detached sig (3309 B) + RAW pk (1952 B) — the exact form every verifier
            // (verify_node_lifecycle_dilithium) requires. sign_consensus's envelope string is length-gated
            // out (len != 3309), which silently killed reactivation network-wide.
            match identity.sign(canonical_msg.as_bytes()) {
                Ok(detached_sig) => {
                    tx.dilithium_signature = Some(detached_sig);
                    tx.dilithium_public_key = Some(identity.dilithium_pk.to_vec());
                }
                Err(e) => {
                    eprintln!("[WARN][REACTIVATION] dilithium3_sign_failed: {}", e);
                }
            }
        }

        // Recalculate hash after signing.
        tx.hash = tx.calculate_hash();

        println!("[INFO][REACTIVATION] signed dilithium3={} node={}",
            tx.dilithium_signature.is_some(), node_id);
    }

    /// v12.0: Get consensus hash of macroblock from storage.

    /// Find node registration in blockchain (searches all blocks)
    /// Returns (node_type, wallet_address) if found
    pub async fn find_node_registration(&self, node_id: &str) -> Option<(qnet_state::NodeType, String)> {
        self.find_node_registration_full(node_id).await
            .map(|(nt, wa, _)| (nt, wa))
    }
    
    /// Find full node registration including api_endpoint
    /// Returns (node_type, wallet_address, api_endpoint) if found
    /// v3.35: 3-LEVEL LOOKUP for O(1) performance:
    ///   Level 1: DashMap in-memory cache (fastest, ~1ns)
    ///   Level 2: RocksDB persistent cache (~10μs)
    ///   Level 3: Blockchain scan (slow, O(N) — only on cold start/miss)
    pub async fn find_node_registration_full(&self, node_id: &str) -> Option<(qnet_state::NodeType, String, String)> {
        use qnet_state::TransactionType;
        
        // LEVEL 1: In-memory DashMap — O(1), ~1ns
        if let Some(entry) = self.node_registration_cache.get(node_id) {
            let (nt, wallet, endpoint) = entry.value().clone();
            return Some((nt, wallet, endpoint));
        }
        
        // LEVEL 2: RocksDB persistent cache -- O(1), ~10us
        if let Ok(Some((type_str, wallet, _rep))) = self.storage.load_node_registration(node_id) {
            let type_lower = type_str.to_lowercase();
            // BACKWARD COMPAT: RocksDB may contain "full" from pre-v3.18 data
            if type_lower == "full" && is_warn() {
                println!("[WARN][REG] legacy_full_type node={} (mapped to Super, re-register to fix)", node_id);
            }
            let node_type = match type_lower.as_str() {
                "super" | "full" => qnet_state::NodeType::Super,
                _ => qnet_state::NodeType::Light,
            };
            // Promote to Level 1 cache (endpoint not stored in RocksDB — use empty)
            self.node_registration_cache.insert(
                node_id.to_string(), 
                (node_type.clone(), wallet.clone(), String::new())
            );
            return Some((node_type, wallet, String::new()));
        }
        
        // LEVEL 3: Full blockchain scan — O(N), SLOW (only on cache miss after restart)
        let current_height = self.get_height().await;
        
        for height in (0..=current_height).rev() {
            if let Ok(Some(block)) = self.storage.load_microblock_auto_format(height) {
                for tx in &block.transactions {
                    if let TransactionType::NodeRegistration { 
                        node_id: reg_node_id, 
                        node_type, 
                        wallet_address,
                        api_endpoint,
                        .. 
                    } = &tx.tx_type {
                        if reg_node_id == node_id {
                            // Populate BOTH caches for future O(1) lookups
                            self.node_registration_cache.insert(
                                node_id.to_string(),
                                (node_type.clone(), wallet_address.clone(), api_endpoint.clone())
                            );
                            self.cache_node_registration(node_id, node_type.clone(), wallet_address.clone()).await;
                            if is_debug() { 
                                println!("[DBG][REG] found_onchain node={} wallet={}... endpoint={} h={}", 
                                         node_id, qnet_state::char_prefix(&wallet_address, 16),
                                         if api_endpoint.is_empty() { "hidden" } else { api_endpoint },
                                         height); 
                            }
                            return Some((node_type.clone(), wallet_address.clone(), api_endpoint.clone()));
                        }
                    }
                }
            }
        }
        
        None
    }
    
    /// Get all registered nodes with public API endpoints (for mobile app discovery)
    /// Returns Vec<(node_id, api_endpoint, node_type, reputation, last_seen, is_synced)>
    /// 
    /// v3.35: FULL VALIDATION
    /// - reputation >= 70% (consensus threshold)
    /// - last_seen < 5 minutes (node is online) - from P2P heartbeat
    /// - is_synced = true (not more than 5 blocks behind current height)
    /// - Genesis nodes always included (infrastructure backbone)
    pub async fn get_all_public_api_nodes(&self) -> Vec<(String, String, qnet_state::NodeType, f64, u64, bool)> {
        use qnet_state::TransactionType;

        // Cache API node results for 60s to avoid O(N) chain scan on every call
        static API_NODES_CACHE: once_cell::sync::Lazy<
            parking_lot::Mutex<(std::time::Instant, Vec<(String, String, qnet_state::NodeType, f64, u64, bool)>)>
        > = once_cell::sync::Lazy::new(|| {
            parking_lot::Mutex::new((std::time::Instant::now() - std::time::Duration::from_secs(120), Vec::new()))
        });

        {
            let cache = API_NODES_CACHE.lock();
            if cache.0.elapsed().as_secs() < 60 && !cache.1.is_empty() {
                return cache.1.clone();
            }
        }

        let mut result = Vec::new();
        let current_height = self.get_height().await;
        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // v3.35: Get P2P peer info for online/sync status
        // Contains: (last_seen timestamp, last_block_height from heartbeat)
        let peer_info: std::collections::HashMap<String, (u64, u64)> = if let Some(ref p2p) = self.unified_p2p {
            p2p.get_validated_active_peers().iter()
                .map(|p| (p.id.clone(), (p.last_seen, p.last_block_height)))
                .collect()
        } else {
            std::collections::HashMap::new()
        };
        
        // Collect all registrations (last one wins for each node_id)
        let mut registrations: std::collections::HashMap<String, (String, qnet_state::NodeType)> = 
            std::collections::HashMap::new();
        
        for height in 0..=current_height {
            if let Ok(Some(block)) = self.storage.load_microblock_auto_format(height) {
                for tx in &block.transactions {
                    if let TransactionType::NodeRegistration { 
                        node_id, 
                        node_type, 
                        api_endpoint,
                        .. 
                    } = &tx.tx_type {
                        // Only include nodes with public API (non-empty endpoint)
                        // Light nodes are automatically excluded (their endpoint is always empty)
                        if !api_endpoint.is_empty() {
                            registrations.insert(node_id.clone(), (api_endpoint.clone(), node_type.clone()));
                        }
                    }
                }
            }
        }
        
        // Reputation display value. The RAM telemetry engine was removed; under the
        // deterministic model an active node sits at the floor — tombstones gate consensus
        // eligibility via the chain fold elsewhere, not this peer-list view.
        
        for (node_id, (endpoint, node_type)) in registrations {
            let reputation = qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
            
            // Scale is 0..100, not 0..1 — compare against the shared constant, never a literal.
            if reputation < qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION { continue; }
            
            // v3.35: Check online status and sync status
            let is_genesis = node_id.starts_with("genesis_node_");
            
            if is_genesis {
                // Genesis nodes always included (infrastructure backbone)
                // last_seen = current_time (always online), is_synced = true
                result.push((node_id, endpoint, node_type, reputation, current_time, true));
            } else {
                // For non-Genesis nodes: check P2P heartbeat data
                if let Some((last_seen, peer_height)) = peer_info.get(&node_id) {
                    let age_secs = current_time.saturating_sub(*last_seen);
                    
                    // Must be seen in last 5 minutes (300 sec)
                    if age_secs > 300 {
                        if is_debug() {
                            println!("[DBG][API] skip_node node={} reason=stale age_secs={}", node_id, age_secs);
                        }
                        continue;
                    }
                    
                    // Check sync status: not more than 5 blocks behind
                    let is_synced = current_height <= *peer_height + 5;
                    
                    if !is_synced {
                        if is_debug() {
                            println!("[DBG][API] skip_node node={} reason=behind peer_h={} current_h={}", 
                                     node_id, peer_height, current_height);
                        }
                        continue;
                    }
                    
                    result.push((node_id, endpoint, node_type, reputation, *last_seen, is_synced));
                } else {
                    // Node not in P2P peers - skip (probably offline)
                    if is_debug() {
                        println!("[DBG][API] skip_node node={} reason=not_in_peers", node_id);
                    }
                    continue;
                }
            }
        }
        
        // Store in cache before returning
        {
            let mut cache = API_NODES_CACHE.lock();
            *cache = (std::time::Instant::now(), result.clone());
        }

        result
    }

    /// Cache node registration for fast lookups
    pub(super) async fn cache_node_registration(&self, node_id: &str, node_type: qnet_state::NodeType, wallet: String) {
        // Use storage for persistence
        // v3.18: Super node type removed
        let type_str = match node_type {
            qnet_state::NodeType::Light => "light",
            qnet_state::NodeType::Super => "super",
        };
        let _ = self.storage.save_node_registration(node_id, type_str, &wallet, 1.0);
    }
    
    #[allow(dead_code)]
    pub(super) async fn get_cached_node_registration(&self, node_id: &str) -> Option<(qnet_state::NodeType, String)> {
        match self.storage.load_node_registration(node_id) {
            Ok(Some((type_str, wallet, _))) => {
                // BACKWARD COMPAT: "full" from pre-v3.18 mapped to Super
                let node_type = match type_str.to_lowercase().as_str() {
                    "super" | "full" => qnet_state::NodeType::Super,
                    _ => qnet_state::NodeType::Light,
                };
                Some((node_type, wallet))
            }
            _ => None,
        }
    }
    
    /// CRITICAL FIX v3.2: Cache all NodeRegistration TXs from a block
    /// This ensures block CREATOR (not just receivers) has wallet addresses cached
    /// Required for: genesis block creator, regular block producers with NodeRegistration TXs
    /// Without this, producer can't look up wallet addresses for reward distribution
    /// v3.35: Also populates DashMap in-memory cache for O(1) lookups
    pub(super) fn cache_node_registrations_from_transactions_with_dashmap(
        storage: &crate::storage::Storage, 
        transactions: &[qnet_state::Transaction],
        cache: &DashMap<String, (qnet_state::NodeType, String, String)>,
    ) {
        use qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
        
        for tx in transactions {
            match &tx.tx_type {
                qnet_state::TransactionType::NodeRegistration {
                    node_id, node_type, wallet_address, api_endpoint, ..
                } => {
                    let type_str = Self::registration_type_str(node_type);
                    // Level 1: DashMap in-memory cache
                    cache.insert(
                        node_id.clone(),
                        (node_type.clone(), wallet_address.clone(), api_endpoint.clone())
                    );
                    // v30.B1: mirror endpoint IP into global registry for the
                    // QUIC accept-path IP-identity gate. Chain-authenticated
                    // (TX is signature-validated before this code path).
                    crate::genesis_constants::register_node_endpoint(node_id, api_endpoint);
                    // Persist it too: the RAM map holds only what THIS process applied, so a restart or
                    // a snapshot cold-join left every non-genesis committee member unreachable.
                    if let Err(e) = storage.save_node_endpoint(node_id, api_endpoint) {
                        if is_warn() { println!("[WARN][STORAGE] endpoint_save_failed node={} err={}", node_id, e); }
                    }
                    // Level 2: RocksDB persistent cache (forward + reverse index)
                    if let Err(e) = storage.save_node_registration(node_id, type_str, wallet_address, INITIAL_REPUTATION) {
                        eprintln!("[WARN][REG] cache_from_block_fail node={} err={}", node_id, e);
                    } else if is_info() {
                        println!("[INFO][REG] cached_from_produced_block node={} wallet={}...",
                                 node_id, qnet_state::char_prefix(&wallet_address, 16));
                    }
                    // NOTE: the committed burn→wallet binding (cbw) is NO LONGER written here. It is
                    // materialised incrementally at apply BEFORE save_microblock (within-window
                    // ordering) and rebuilt deterministically from node_registry on snapshot/reorg/boot
                    // (rebuild_committed_burn_wallet). This call site runs AFTER save, too late for the
                    // verify(h+1) read, so it must not be the binding's writer.

                    // v4.6: Extract VRF public key from on-chain TX (non-genesis nodes).
                    // FIX-5: the TX carries the pk as RAW 1952 bytes (no hex hop).
                    if let Some(pk_bytes) = Self::registration_consensus_pk(tx) {
                        {
                            let pk_bytes = &pk_bytes;
                            // Log if registering key from unsigned TX (no proof-of-possession)
                            if tx.dilithium_signature.is_none() || tx.dilithium_signature.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                                // Genesis identities install their key from the trusted genesis block
                                // (no proof-of-possession by design) — DBG. Only a NON-genesis unsigned
                                // key warrants a WARN (real missing-PoP signal).
                                if node_id.starts_with("genesis_node_") {
                                    if is_debug() { println!("[DBG][VRF] genesis_key_registered node={}", qnet_state::char_prefix(&node_id, 16)); }
                                } else {
                                    println!("[WARN][VRF] key_registered_without_pop node={}",
                                             qnet_state::char_prefix(&node_id, 16));
                                }
                            }
                            {
                                // Persist first, then mirror the COMMITTED row into RAM. The row is
                                // immutable once stamped, so a second registration naming an existing
                                // node_id (a state-level no-op the block still carries) cannot rebind
                                // the identity in either place. RAM mirrors disk exactly, so the vote /
                                // QC / producer-signature verifiers and the boot reload all resolve the
                                // same key.
                                if let Err(e) = storage.save_vrf_public_key(node_id, &hex::encode(pk_bytes)) {
                                    if crate::node::is_warn() {
                                        println!("[WARN][STORAGE] vrf_pk_save_failed node={} err={}", node_id, e);
                                    }
                                }
                                let committed = storage.load_vrf_public_key(node_id).ok().flatten();
                                let committed = match committed {
                                    Some(c) if c.len() == crate::crypto::vrf::D3_PK_BYTES => c,
                                    _ => continue,
                                };
                                if committed.as_slice() != pk_bytes.as_slice() {
                                    println!("[ERR][VRF-KEY] rebind_refused node={} hint=identity_is_immutable",
                                             qnet_state::char_prefix(node_id, 16));
                                    continue;
                                }
                                let had_ram = crate::genesis_constants::has_vrf_key(node_id);
                                crate::genesis_constants::register_vrf_public_key(node_id, &committed);
                                let _ = qnet_consensus::consensus_crypto::register_consensus_pk_from_chain(node_id, &committed);
                                if is_info() {
                                    println!("[INFO][VRF-KEY] on_chain_registered node={} pk_hash={} had_ram={}",
                                             node_id, hex::encode(&committed[..8]), had_ram);
                                }
                            }
                        }
                    }
                }
                // v9.4: NodeReactivation — register VRF key if present (same as NodeRegistration).
                // FIX-5: pk rides as RAW 1952 bytes; storage row stays hex.
                qnet_state::TransactionType::NodeReactivation { node_id, api_endpoint, .. } => {
                    // Refresh the committed endpoint exactly as NodeRegistration does. A node that
                    // returns on a new IP kept the old one, and both the QUIC identity gate and gossip
                    // address binding then refuse it. Empty = the operator hides the IP: leave the
                    // stored value alone rather than blanking a reachable address.
                    if !api_endpoint.is_empty() {
                        crate::genesis_constants::register_node_endpoint(node_id, api_endpoint);
                        if let Err(e) = storage.save_node_endpoint(node_id, api_endpoint) {
                            if is_warn() { println!("[WARN][STORAGE] endpoint_save_failed node={} err={}", node_id, e); }
                        } else if is_info() {
                            println!("[INFO][REG] endpoint_refreshed node={} source=reactivation", node_id);
                        }
                    }
                    if let Some(ref pk_bytes) = tx.dilithium_public_key {
                        if pk_bytes.len() == crate::crypto::vrf::D3_PK_BYTES {
                            if !crate::genesis_constants::has_vrf_key(node_id) {
                                crate::genesis_constants::register_vrf_public_key(node_id, pk_bytes);
                                // v14.8: Mirror to consensus-layer registry (chain-authenticated).
                                let _ = qnet_consensus::consensus_crypto::register_consensus_pk_from_chain(node_id, pk_bytes);
                                if let Err(e) = storage.save_vrf_public_key(node_id, &hex::encode(pk_bytes)) {
                                    if crate::node::is_warn() {
                                        println!("[WARN][STORAGE] vrf_pk_save_failed node={} err={}", node_id, e);
                                    }
                                }
                                if is_info() {
                                    println!("[INFO][VRF-KEY] reactivation_registered node={} pk_hash={}",
                                             node_id, hex::encode(&pk_bytes[..8]));
                                }
                            }
                        }
                    }
                }
                qnet_state::TransactionType::NodeActivation { .. } => {
                    // No cached identity row: a node's identity is the wallet-derived super_/light_ pseudonym
                    // written by NodeRegistration apply. A tx-hash-keyed activation_ row is a phantom (never
                    // resolved) and, at 10M light, dead storage — so skip it.
                }
                _ => {}
            }
        }
    }
    
    /// Legacy wrapper for backward compatibility (static calls without DashMap)
    pub fn cache_node_registrations_from_transactions(storage: &crate::storage::Storage, transactions: &[qnet_state::Transaction]) {
        Self::cache_node_registrations_from_transactions_with_dashmap(storage, transactions, &DashMap::new());
    }

    /// Index a Light eligibility bitmap at apply (epoch = height/14400 window) so the emission
    /// recompute reads ≤5 keys, not a 14400-block scan. Last-in-window write wins (== scan). THE ONE
    /// writer for this index, called from BOTH apply_block_to_state (validator) AND the producer-inline
    /// apply, so the producer of a bitmap-carrying block stamps its own shard IDENTICALLY — else its
    /// light reward roster diverges from validators at the emission boundary → reward_root fork.
    pub(super) fn collect_light_eligibility_bitmap(out: &mut Vec<(u64, usize, u64, Vec<u8>)>, h: u64, tx: &qnet_state::Transaction) {
        if let qnet_state::TransactionType::LightNodeEligibilityBitmap {
            genesis_id, epoch, index_span, eligible_count, bitmap_compressed,
        } = &tx.tx_type {
            if let Some(gidx) = genesis_id.strip_prefix("genesis_node_")
                .and_then(|n| n.parse::<usize>().ok())
                .filter(|n| (1..=5).contains(n)).map(|n| n - 1)
            {
                // File under the TX's own (signed) epoch — the epoch the bitmap was built for and that the
                // emission reader loads — NOT the inclusion height h/14400. A bitmap that drifts across the
                // epoch boundary (late inclusion) must still land under its built epoch, else that shard loses
                // the epoch's rewards. Bound to {current, just-ended} epoch vs inclusion so a stale/future-dated
                // epoch cannot plant a bitmap. Deterministic on every node (h and epoch are canonical).
                let inc_epoch = h / 14400;
                if *epoch <= inc_epoch && *epoch + 1 >= inc_epoch {
                    if let Ok(bm) = crate::unified_p2p::decompress_zstd_bounded(
                        &bitmap_compressed[..], qnet_state::transaction::MAX_BITMAP_DECOMPRESSED)
                    {
                        // The two facts that make eligible_count mean anything, checked where the
                        // decompressed bitmap already exists. Without them the count is self-declared:
                        // a genesis could claim any number of eligible lights for its shard. Pure
                        // functions of the TX bytes, so the verdict is identical on every node.
                        let want_len = ((*index_span as usize) + 7) / 8;
                        let popcount: u32 = bm.iter().map(|b| b.count_ones()).sum();
                        if bm.len() != want_len || popcount != *eligible_count {
                            println!("[WARN][LIGHT-BITMAP] shape_mismatch genesis={} epoch={} len={}/{} popcount={}/{} action=drop",
                                     genesis_id, epoch, bm.len(), want_len, popcount, eligible_count);
                        } else {
                            out.push((*epoch, gidx, h, bm));
                        }
                    }
                }
            }
        }
    }

    pub(super) fn build_token_transfer_rows(
        accounts: &std::sync::Arc<dashmap::DashMap<String, qnet_state::Account>>,
        height: u64, timestamp: u64,
        logs: &[(String, String, Vec<u8>)],
    ) -> Vec<crate::storage::TokenTransferRow> {
        let mut rows = Vec::new();
        for (log_index, (tx_hash, contract, data)) in logs.iter().enumerate() {
            if let Some(ev) = qnet_state::wasm_exec::decode_transfer_log(data) {
                let is_token = accounts.get(contract).map(|a|
                    a.is_qrc20() || a.contract_storage.get("type").map(|t| t == "qrc721").unwrap_or(false)
                ).unwrap_or(false);
                if !is_token { continue; }
                rows.push(crate::storage::TokenTransferRow {
                    contract: contract.clone(), from: ev.from, to: ev.to, amount: ev.amount,
                    kind: ev.kind, std: ev.std, token_id: ev.token_id,
                    tx_hash: tx_hash.clone(), log_index: log_index as u32, height, timestamp,
                });
            }
        }
        rows
    }

    /// Single canonical writer of ONE chain-confirmed NodeRegistration's registry row: stamps
    /// reg_height + burn + vrf_pk co-resident (save_node_registration_at_height_burn_vrf) plus the
    /// backing cbw binding. The ONE place producer-inline and genesis derive the row, so registry_root
    /// is byte-identical on every node. vrf bound for consensus signers (super/genesis) only; light None.
    pub(super) fn write_registration_row(
        storage: &crate::storage::Storage,
        node_id: &str,
        node_type: &qnet_state::NodeType,
        wallet: &str,
        burn_tx: &str,
        dilithium_pk: Option<&Vec<u8>>,
        height: u64,
    ) {
        let type_str = Self::registration_type_str(node_type);
        let vrf = if matches!(node_type, qnet_state::NodeType::Super) {
            // FIX-5: pk rides the TX as raw bytes — accept only an exact ML-DSA-65 key
            dilithium_pk.filter(|v| v.len() == crate::crypto::vrf::D3_PK_BYTES).cloned()
        } else { None };
        let _ = storage.save_node_registration_at_height_burn_vrf(node_id, type_str, wallet, 1.0, height, burn_tx, vrf.as_deref());
        // Registration-origin marker: the dedup reseed source. Activations write registry rows too,
        // so reseeding from those would reject honest registrations.
        let _ = storage.mark_node_registration_origin(node_id, wallet);
        if !burn_tx.is_empty() {
            let _ = storage.committed_burn_wallet_put(burn_tx, node_id);
        }
    }

    /// Apply block-0 genesis NodeRegistration TXs through the SAME canonical row writer as a peer-
    /// applying validator (reg_height 0, burn, vrf co-resident), so the creator's registry_root and
    /// reward roster are byte-identical to synced peers. Replaces the old height-only backfill that
    /// dropped vrf_pk and diverged the creator's registry_root. Idempotent (immutable once stamped).
    pub(crate) fn apply_genesis_registrations(storage: &crate::storage::Storage, transactions: &[qnet_state::Transaction]) {
        // Block 0 stamps reg_index like any other block, so it is ordered by the same rule — the
        // genesis TX list is deterministic but NOT node_id-sorted, and the rebuild ranks by node_id.
        let mut rows: Vec<(&str, &qnet_state::NodeType, &str, &str, Option<&Vec<u8>>)> = Vec::new();
        for tx in transactions {
            if let qnet_state::TransactionType::NodeRegistration { node_id, node_type, wallet_address, burn_tx, .. } = &tx.tx_type {
                rows.push((node_id, node_type, wallet_address, burn_tx, tx.dilithium_public_key.as_ref()));
            }
        }
        rows.sort_by(|a, b| a.0.cmp(b.0));
        for (node_id, node_type, wallet, burn_tx, pk) in rows {
            Self::write_registration_row(storage, node_id, node_type, wallet, burn_tx, pk, 0);
        }
    }

    /// Register all 5 Genesis nodes on-chain (called once at blockchain start)
    /// Returns Vec of registration transactions to include in genesis/first block
    /// Create Genesis node registration TXs with FIXED timestamp for determinism
    /// CRITICAL: All 5 Genesis nodes MUST create IDENTICAL TXs for consensus
    /// Uses timestamp=0 (genesis epoch) to ensure same hashes across all nodes
    ///
    /// v16.1: Embeds the anchored ML-DSA-65 public key for each genesis identity
    /// when an anchor map is installed (`set_genesis_anchor_pks`). Embedding the
    /// PK in the genesis NodeRegistration TX is the canonical way to bind
    /// identity → key in finalized chain state, replacing the v15.x trust-on-
    /// first-verify path that allowed cross-restart pk_mismatch.
    ///
    /// When anchors are not yet installed (cold-boot before operator writes
    /// `genesis_anchors.json`), the field stays `None` and identity binding
    /// falls back to the legacy P2P announce path. Operators are expected to
    /// install anchors and restart before the network reaches its first
    /// macroblock boundary so binding is locked in for the long run.
    pub fn create_genesis_registration_txs() -> Vec<qnet_state::Transaction> {
        let mut txs = Vec::new();

        // CRITICAL: Fixed timestamp = 0 for deterministic TX hashes
        // This ensures ALL nodes produce IDENTICAL genesis block
        const GENESIS_TX_TIMESTAMP: u64 = 0;

        for (bootstrap_id, wallet) in crate::genesis_constants::GENESIS_WALLETS {
            let node_id = format!("genesis_node_{}", bootstrap_id);

            // v3.35: Genesis nodes are ALWAYS public - get IP from constants
            let api_endpoint = crate::genesis_constants::GENESIS_NODE_IPS.iter()
                .find(|(_, id)| *id == *bootstrap_id)
                .map(|(ip, _)| format!("http://{}:8001", ip))
                .unwrap_or_default();

            let mut tx = Self::create_node_registration_tx_with_timestamp(
                &node_id,
                qnet_state::NodeType::Super,
                wallet,
                "genesis", // Proof for genesis nodes
                &api_endpoint, // v3.35: Public API endpoint
                Some(GENESIS_TX_TIMESTAMP), // Fixed timestamp for determinism
            );

            // v16.1: Embed the anchored ML-DSA-65 PK directly in the genesis TX
            // payload. When all genesis nodes apply this same TX they install
            // the SAME (node_id → PK) binding via
            // `cache_node_registrations_from_transactions_with_dashmap`, which
            // mirrors into `register_consensus_pk_from_chain`. This eliminates
            // the v15.x race where each peer learned the genesis PK from the
            // first VRF announce that arrived (TOFV), making cross-restart key
            // regeneration silently invalidate every signature.
            //
            // Determinism: anchored PKs are byte-identical across every node
            // because they are loaded from the SAME `genesis_anchors.json`
            // shipped by the operator. tx.hash recomputes below to bind the
            // PK into the canonical TX bytes — without rehashing, late
            // anchor installation would produce different TX hashes across
            // peers and the genesis block would itself fork.
            if let Some(anchor_pk) = crate::genesis_constants::get_genesis_anchor_pk(&node_id) {
                // Consensus key rides the HASHED body field so no relayer can swap it. Sourced from the
                // pinned anchor, not the local registry, so every node builds identical genesis bytes.
                if let qnet_state::TransactionType::NodeRegistration { vrf_pk, .. } = &mut tx.tx_type {
                    *vrf_pk = anchor_pk.to_vec();
                }
                tx.dilithium_public_key = Some(anchor_pk.to_vec());
                tx.hash = tx.calculate_hash();
            } else if is_info() {
                println!(
                    "[INFO][REG] genesis_tx_no_anchor node={} reason=anchor_file_not_yet_installed",
                    node_id
                );
            }

            if is_info() {
                println!("[INFO][REG] genesis_tx_created node={} wallet={}... endpoint={} hash={}... pk_anchored={}",
                         node_id, qnet_state::char_prefix(&wallet, 16),
                         api_endpoint,
                         qnet_state::char_prefix(&tx.hash, 16),
                         tx.dilithium_public_key.is_some());
            }
            txs.push(tx);
        }

        txs
    }
    
    /// v2.98: SECURITY FIX - Get wallet ONLY from on-chain registration!
    /// NO FALLBACK! This prevents reward manipulation.
    /// This is the SINGLE SOURCE OF TRUTH for node→wallet mapping
    pub async fn get_node_wallet(&self, node_id: &str) -> Option<String> {
        // Check on-chain registration ONLY
        if let Some((_, wallet)) = self.find_node_registration(node_id).await {
            return Some(wallet);
        }
        
        // NO FALLBACK! Node MUST be registered on-chain!
        // Genesis nodes are registered in genesis block at height 0
        None
    }

    /// Deterministic per-node block offset (0..1439) within a subwindow, so 100k+ super-nodes
    /// spread heartbeat emission across the whole subwindow instead of bursting at its boundary.
    pub(super) fn heartbeat_offset(node_id: &str, subwindow: u64) -> u64 {
        let mut h = Sha3_256::new();
        h.update(node_id.as_bytes());
        h.update(&subwindow.to_le_bytes());
        let d = h.finalize();
        (((u64::from(d[0]) << 8) | u64::from(d[1])) % 1440) as u64
    }

    /// v34: build ONE unforgeable Heartbeat TX anchored to a recent block (current_height-2).
    /// `tx_type.signature` is the consensus Dilithium sig over the anchor (verified by
    /// Anchor rule: must equal a real recent block hash + be timely + sig valid (producer-gated)
    /// vs the node's registry PK ⇒ an offline node cannot fabricate it). The envelope carries the
    /// standard ML-DSA-65 sig like every system TX. Returns None if the anchor hash is unavailable or
    /// signing fails (caller skips this tick, retries next).
    pub(super) async fn create_heartbeat_tx_static(
        storage: &Arc<Storage>,
        node_id: &str,
        current_height: u64,
        identity: Option<&crate::crypto::vrf::WalletIdentity>,
    ) -> Option<qnet_state::Transaction> {
        if current_height < 2 { return None; }
        let anchor_height = current_height - 2;
        let anchor_hash = storage.get_microblock_hash_hex(anchor_height).ok().flatten()?;
        let hb_msg = Self::chain_bind(&format!("QNET_HEARTBEAT:{}:{}:{}", node_id, anchor_height, anchor_hash));
        // RAW detached ML-DSA-65 signature (3309 B) instead of the base64 envelope that also carried a
        // copy of the 1952-byte public key. The verifier resolves the key from committed state, so the
        // copy was pure duplication: one heartbeat per node per subwindow, 100k nodes, is the single
        // largest recurring wire cost in the protocol — this halves it.
        let hb_sig = identity?.sign(hb_msg.as_bytes()).ok()?;
        let epoch = current_height / 14400;
        let subwindow = (current_height % 14400) / 1440;
        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let mut tx = qnet_state::Transaction {
            from: node_id.to_string(),
            to: None,
            amount: 0,
            tx_type: qnet_state::TransactionType::Heartbeat {
                node_id: node_id.to_string(),
                anchor_height,
                anchor_hash,
            },
            timestamp: current_time,
            hash: String::new(),
            signature: None,
            public_key: None,
            gas_price: u64::MAX,
            gas_limit: 0,
            nonce: epoch * 10 + subwindow + 1,
            data: None,
            dilithium_signature: Some(hb_sig),
            // Signer LABEL, not a key: the consensus key is resolved from committed state.
            dilithium_public_key: Some(node_id.to_string().into_bytes()),
            chain_id: qnet_state::transaction::QNET_CHAIN_ID,
        };
        tx.hash = tx.calculate_hash();
        Some(tx)
    }

    /// PRODUCTION v2.89: Create LightNodeEligibilityBitmap TX
    /// Ultra-compact bitmap representation of eligible Light nodes
    /// 
    /// SCALABILITY:
    /// - 2M Light nodes = 250KB bitmap (1 bit per node)
    /// - zstd compression: ~50KB per TX
    /// - One TX per Genesis (not 200+ TX for samples!)
    /// 
    /// ARCHITECTURE:
    /// - Genesis collects attestations for assigned Light nodes
    /// - Creates bitmap: bit[i] = 1 if Light node #i responded
    /// - Compresses with zstd and sends as single TX
    /// - MacroBlock merges all 5 Genesis bitmaps for rewards
    pub(super) fn create_light_node_bitmap_tx(
        genesis_id: &str,
        epoch: u64,
        eligible_indices: &[u32],  // reg_index of each Light node that responded
        index_span: u32,           // highest reg_index in this shard + 1 — the bitmap's span
    ) -> Result<qnet_state::Transaction, QNetError> {
        // Create bitmap: 1 bit per Light node
        let bitmap_size = (index_span as usize + 7) / 8;
        let mut bitmap = vec![0u8; bitmap_size];
        
        // Set bits for eligible nodes
        for &idx in eligible_indices {
            if idx < index_span {
                let byte_idx = idx as usize / 8;
                let bit_idx = idx as usize % 8;
                bitmap[byte_idx] |= 1 << bit_idx;
            }
        }
        
        // Compress with zstd (already used in project)
        let bitmap_compressed = zstd::encode_all(&bitmap[..], 3)
            .map_err(|e| QNetError::SerializationError(format!("zstd compress failed: {}", e)))?;
        
        let eligible_count = eligible_indices.len() as u32;
        
        if is_info() {
            println!("[INFO][LIGHT-BITMAP] Creating TX genesis={} epoch={} eligible={}/{} raw={}KB compressed={}KB",
                     genesis_id, epoch, eligible_count, index_span,
                     bitmap.len() / 1024, bitmap_compressed.len() / 1024);
        }
        
        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let mut tx = qnet_state::Transaction {
            from: genesis_id.to_string(),
            to: None,
            amount: 0,
            tx_type: qnet_state::TransactionType::LightNodeEligibilityBitmap {
                genesis_id: genesis_id.to_string(),
                epoch,
                index_span,
                eligible_count,
                bitmap_compressed,
            },
            timestamp: current_time,
            hash: String::new(),
            signature: None,
            public_key: None,
            gas_price: u64::MAX, // System TX priority
            gas_limit: 0,        // FREE operation
            nonce: epoch + 1,    // PROTOCOL: Epoch-based nonce (deterministic unique per epoch)
            data: Some(format!("Light Node Bitmap: {} eligible / {} assigned, epoch {}", 
                              eligible_count, index_span, epoch)),
            dilithium_signature: None,
            dilithium_public_key: None,
            chain_id: qnet_state::transaction::QNET_CHAIN_ID,
        };

        tx.hash = tx.calculate_hash();

        Ok(tx)
    }

    /// Epoch-boundary super reward-eligibility snapshot. At the first block of epoch N+1 — the only
    /// moment account_heartbeat_count(.,N) is still valid for every super (rolled or not) — record the
    /// popcount>=9 set deterministically from committed state into super_elig_{N}, one WriteBatch.
    /// Replaces the per-TX writer so producer and replicas (different apply paths) record an identical
    /// set; called from both apply_block_to_state and the producer inline-apply path. Idempotent.
    pub(crate) fn compute_super_eligible_at_settle(
        state_guard: &StateManager,
        storage: &crate::storage::Storage,
        h: u64,
    ) -> Option<(u64, Vec<String>)> {
        const EPOCH_BLOCKS: u64 = 14400;
        // Settle point, not the boundary: heartbeats anchored in the closing epoch are admissible for
        // HB_ANCHOR_MAX_LAG more blocks, so a boundary sample is a set that no later observer — a
        // snapshot joiner, a re-deriving node — can reproduce.
        if h < EPOCH_BLOCKS || h % EPOCH_BLOCKS != HB_ANCHOR_MAX_LAG { return None; }
        let finalized_epoch = h / EPOCH_BLOCKS - 1;
        Self::compute_super_eligible_for_epoch(state_guard, storage, finalized_epoch)
            .map(|e| (finalized_epoch, e))
    }

    /// The popcount>=9 super set for a FINALIZED epoch, read from committed account tallies. Valid at
    /// any height inside epoch `finalized_epoch + 1`: the account keeps the finalized epoch's count
    /// until the next roll, which is what lets a snapshot-joined node reproduce the row it never saw.
    pub(crate) fn compute_super_eligible_for_epoch(
        state_guard: &StateManager,
        storage: &crate::storage::Storage,
        finalized_epoch: u64,
    ) -> Option<Vec<String>> {
        // Same height-bounding as the producer snapshot: this roster decides an epoch's reward leaves,
        // which are committed in reward_root, so it must not include a registration applied after the
        // epoch it is settling. Registrations land at most at the settle height of epoch+1.
        let settle_end = (finalized_epoch + 1) * 14_400 + HB_ANCHOR_MAX_LAG;
        let supers = match storage.super_registrations_as_of(settle_end) { Ok(s) => s, Err(_) => return None };
        let mut eligible: Vec<String> = Vec::new();
        // Resident supers: read the committed tally from RAM (authoritative). Evicted (inactive) ones:
        // collect for ONE batched disk read below — avoids N sequential cold reads stalling the
        // boundary block at scale. Same set + same values as a per-super warm_account loop.
        let mut evicted: Vec<String> = Vec::new();
        for (node_id, _wallet) in &supers {
            match state_guard.accounts.get(node_id) {
                Some(acct) => {
                    // A banned identity earns nothing. The ban is read from ACCOUNT state — which the
                    // snapshot already proves and every node reproduces identically — instead of being
                    // looked up in the macroblock that certified it: that lookup is what made four
                    // earlier attempts either non-deterministic across node classes or unhealable.
                    if acct.banned_at_height == 0
                        && Self::account_heartbeat_count(acct.value(), finalized_epoch) >= 9 {
                        eligible.push(node_id.clone());
                    }
                }
                None => evicted.push(node_id.clone()),
            }
        }
        if !evicted.is_empty() {
            for (node_id, acct) in evicted.iter().zip(storage.load_accounts_batch(&evicted)) {
                if let Some(a) = acct {
                    if a.banned_at_height == 0
                        && Self::account_heartbeat_count(&a, finalized_epoch) >= 9 {
                        eligible.push(node_id.clone());
                    }
                }
            }
        }
        Some(eligible)
    }

    /// v34: a node's UNFORGEABLE liveness count for `epoch`, read from its on-chain account tally
    /// (popcount of the subwindow bitmask set by validated Heartbeat TXs). Uses the current bitmask
    /// if it belongs to `epoch`, else the finalized previous-epoch count, else 0. Reward + producer
    /// eligibility keys on THIS (not the self-attested HBC count) ⇒ liveness cannot be forged.
    pub(crate) fn account_heartbeat_count(account: &qnet_state::Account, epoch: u64) -> u8 {
        if account.heartbeat_epoch == epoch {
            account.heartbeat_slots.count_ones() as u8
        } else if account.heartbeat_final_epoch == epoch {
            account.heartbeat_final_slots.count_ones() as u8
        } else {
            0
        }
    }

    /// Heartbeat authenticity: RAW detached signature verified against the node's COMMITTED consensus
    /// key (RAM registry → committed vrf_pk row → pinned genesis anchor). The key is not on the wire, so
    /// this is the one place it must be resolved; the resolver reads only committed data, so every node
    /// reaches the same verdict. An unknown identity is a reject, never a pass.
    pub(crate) fn verify_heartbeat_dilithium(tx: &qnet_state::Transaction, storage: &crate::storage::Storage) -> bool {
        use pqcrypto_mldsa::mldsa65 as dilithium3;
        use pqcrypto_traits::sign::{DetachedSignature as SigTrait, PublicKey as PkTrait};
        let node_id = match &tx.tx_type {
            qnet_state::TransactionType::Heartbeat { node_id, .. } => node_id.as_str(),
            _ => return false,
        };
        let sig = match tx.dilithium_signature.as_deref() {
            Some(x) if x.len() == 3309 => x,
            _ => return false,
        };
        // The resolved key must match the commitment in the CANONICAL registry row. producer_verify_pk
        // also reads the standalone vrf_pk_ row and the RAM registry, neither of which is pruned when a
        // branch is reorged out — accepting a key that only those hold would make a block-validity
        // verdict depend on which branches this node happened to apply. Genesis rows carry the same
        // commitment (written by apply_genesis_registrations), so the rule is uniform.
        let committed_tag = match storage.node_signer_key_commitment(node_id) {
            Ok(Some(t)) => t,
            _ => return false,
        };
        let pk = match crate::node::producer_verify_pk(storage, node_id) {
            Some(p) if p.len() == 1952 => p,
            _ => return false,
        };
        if hex::encode(Sha3_256::digest(&pk)) != committed_tag {
            return false;
        }
        let d3_sig = match <dilithium3::DetachedSignature as SigTrait>::from_bytes(sig) {
            Ok(x) => x, Err(_) => return false,
        };
        let d3_pk = match <dilithium3::PublicKey as PkTrait>::from_bytes(&pk) {
            Ok(x) => x, Err(_) => return false,
        };
        dilithium3::verify_detached_signature(
            &d3_sig, Self::build_canonical_verify_message(tx).as_bytes(), &d3_pk).is_ok()
    }

    /// Write a canonical block's side indices. THE single durable writer for them: called only after
    /// the block owns its slot, so a losing sibling can never plant a row that lowest-height-wins and
    /// add-only semantics make impossible to remove.
    pub fn flush_block_side_indices(storage: &crate::storage::Storage, h: u64, s: &BlockSideIndices) {
        // The global vote/certificate caches had a pruner with ZERO callers, so their retention
        // window never executed and they grew for the process lifetime. This is the one hook that
        // runs exactly once per canonical block on every path; the pruner self-throttles to every
        // 10th block.
        cleanup_global_hashmaps(h);
        // A re-applied block at h fully replaces h's logs + token index. No-op on a fresh height.
        storage.reset_block_token_data(h);
        if !s.block_logs.is_empty() {
            if let Err(e) = storage.save_block_logs(h, &s.block_logs) {
                if is_warn() {
                    println!("[WARN][LOGS] block_logs_persist_failed h={} err={} (logs_root will diverge → stall out of n−f until resync)", h, e);
                }
            }
            let _ = storage.save_block_logs_root(h, &Self::block_logs_root_of(&s.block_logs));
        }
        if !s.token_rows.is_empty() {
            if let Err(e) = storage.index_token_transfers(&s.token_rows) {
                if is_warn() { println!("[WARN][STORAGE] token_xfer_index_failed h={} err={}", h, e); }
            }
        }
        if !s.richlist.is_empty() {
            if let Err(e) = storage.richlist_reconcile(&s.richlist) {
                if is_warn() { println!("[WARN][RICHLIST] reconcile_failed h={} err={}", h, e); }
            }
        }
        for (epoch, gidx, inc_h, bm) in &s.light_bitmaps {
            let _ = storage.save_light_bitmap(*epoch, *gidx, *inc_h, bm);
        }
        if let Some((epoch, eligible)) = &s.super_eligible {
            match storage.save_super_eligible_batch(*epoch, eligible) {
                Ok(()) => if is_info() { println!("[INFO][REWARDS] super_elig_snapshot epoch={} eligible={}", epoch, eligible.len()); },
                Err(e) => if is_warn() { println!("[WARN][REWARDS] super_elig_snapshot_failed epoch={} err={}", epoch, e); },
            }
        }
    }

    /// B (liveness-from-chain): at the epoch boundary, snapshot the finalized epoch's committed light
    /// eligibility into the light_elig_ recency index (storage streams + chunks — scale-safe). Read-only
    /// w.r.t. reward_root; run OFF the state write-lock (spawn_blocking) by both apply paths so the
    /// O(roster) scan never stalls block apply, and re-derived at boot for the last few epochs.
    pub(crate) fn populate_light_elig_at_boundary(storage: &crate::storage::Storage, h: u64) {
        const EPOCH_BLOCKS: u64 = 14400;
        if h == 0 || h % EPOCH_BLOCKS != 0 { return; }
        let finalized_epoch = h / EPOCH_BLOCKS - 1;
        match storage.snapshot_light_eligible(finalized_epoch, light_roster_cutoff(finalized_epoch)) {
            Ok(n) => if is_info() { println!("[INFO][REWARDS] light_elig_snapshot epoch={} attested={}", finalized_epoch, n); },
            Err(e) => if is_warn() { println!("[WARN][REWARDS] light_elig_snapshot_failed epoch={} err={}", finalized_epoch, e); },
        }
    }

    /// Re-freeze any epoch that holds a 2f+1-certified reward_root but whose sharded leaf-set is Absent
    /// locally (freeze-race, or a snapshot/catch-up that carried the root but not the shard). Re-derives
    /// from the committed super_elig_/light_bm_ indices, verifies the set recombines to the certified root,
    /// then freezes — so pending/claim serve the node-independent certified amount on EVERY node (incl.
    /// snapshot-joined), not just those that froze at emission. Bounded to the recent claim window; an
    /// unreconstructible epoch is reported, not memoised. Off consensus + off the public endpoint
    /// (boot / post-snapshot); already-frozen epochs cost one point-read.
    pub(crate) fn backfill_reward_shards(storage: &crate::storage::Storage) -> u32 {
        const WINDOW: usize = 128;
        let epochs = match storage.reward_epochs_from(0) { Ok(e) => e, Err(_) => return 0 };
        let start = epochs.len().saturating_sub(WINDOW);
        let mut healed = 0u32;
        for &epoch in &epochs[start..] {
            let (committed_root, ctotal) = match storage.load_epoch_root(epoch) {
                Ok(Some(r)) if r != [0u8; 32] => (hex::encode(r), crate::reward_epoch::canonical_total(epoch)),
                _ => continue, // no root here yet, or the epoch distributed nothing
            };
            // PRESENT is not CORRECT. A shard set that no longer recombines to the certified root serves
            // nothing — reward_proof_from_shard returns Divergent and wallet_claimable_qnc stops there —
            // so skipping on mere presence would leave that epoch truncated for the life of the node.
            // Same O(K) recombine the read path performs, once an hour per epoch.
            let healthy = storage.load_epoch_shard_meta(epoch).ok().flatten()
                .map_or(false, |(roots, bounds)| {
                    !roots.is_empty() && bounds.len() == roots.len()
                        && hex::encode(qnet_core::crypto::merkle::merkle_continue_root(&roots)) == committed_root
                });
            if healthy { continue; }
            let w = Self::compute_epoch_reward_distribution(storage, epoch, ctotal)
                .map(|x| x.0).unwrap_or_default();
            if !w.is_empty() && Self::epoch_reward_merkle_root(&w, epoch) == committed_root {
                Self::save_epoch_reward_sharded(storage, epoch, &w);
                healed += 1;
            } else if !w.is_empty() {
                // Inputs present but they do not reproduce the certified root: corrupt, not missing.
                println!("[ERR][REWARDS] epoch_rebuild_diverged epoch={} action=resync_needed", epoch);
            }
        }
        if healed > 0 && is_info() { println!("[INFO][REWARDS] reward_shard_backfill healed={}", healed); }
        healed
    }

    /// A merkle claim credits `to` whoever relays it, and the claim watermark is monotonic — so an
    /// unauthenticated claim naming only the newest epoch strands every earlier one for that wallet,
    /// permanently, on every node. Authorization therefore binds the wallet's own ML-DSA-65 key to
    /// THIS payload: the pk must derive to `to` (eon = SHA512(pk)), and the signature must cover the
    /// exact `data` bytes, so a signature lifted off a past claim cannot be re-aimed at a shorter one.
    /// Pure function of the TX bytes ⇒ identical verdict on every node.
    pub(crate) fn claim_authorized(tx: &qnet_state::Transaction, to: &str, data: &str) -> bool {
        let pk_hex = match tx.dilithium_public_key.as_ref().and_then(|b| std::str::from_utf8(b).ok()) {
            Some(s) => s,
            None => return false,
        };
        let sig = match tx.dilithium_signature.as_ref().and_then(|b| std::str::from_utf8(b).ok()) {
            Some(s) => s,
            None => return false,
        };
        let pk = match hex::decode(pk_hex) { Ok(p) => p, Err(_) => return false };
        match crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey_bytes(&pk) {
            Some(addr) if addr == to => {}
            _ => return false,
        }
        crate::rpc::verify_mobile_dilithium_signature(
            &Self::claim_sign_message(to, data, tx.timestamp), sig, pk_hex)
    }

    /// The message a wallet signs to authorize a claim payload. Built from the exact `data` string that
    /// goes on the wire, so there is no canonicalization gap between signer and verifier, and bound to
    /// the tx timestamp: without it the payload could be re-emitted forever with a bumped timestamp,
    /// each copy a fresh hash that passes every gate and credits nothing. With it, the only replay that
    /// verifies is hash-identical and the mempool dedups it.
    /// Chain-bound like every other sign-preimage: a claim authorized on one chain must not verify
    /// on another that shares the wallet key.
    pub(crate) fn claim_sign_message(to: &str, data: &str, timestamp: u64) -> String {
        let mut h = Sha3_256::new();
        h.update(data.as_bytes());
        Self::chain_bind(&format!("qnet_claim_v1:{}:{}:{}", to, timestamp, hex::encode(h.finalize())))
    }

    /// Credits proof-verified reward claims. Shared by apply_block_to_state and the producer's
    /// inline apply so both reach the same state.
    ///
    /// Err(certifying_mb) = this node lacks that macroblock and cannot decide; the caller MUST abort
    /// the block and fetch it. Crediting or skipping instead would fork state_root.
    pub(super) fn apply_merkle_claims(
        state_guard: &StateManager,
        storage: &crate::storage::Storage,
        transactions: &[qnet_state::Transaction],
        height: u64,
        mut block_snapshot: Option<&mut qnet_state::BlockSnapshot>,
    ) -> Result<(), u64> {
        for tx in transactions {
            if tx.tx_type != qnet_state::TransactionType::RewardDistribution
               || tx.from != StateManager::REWARDS_POOL {
                continue;
            }
            let to = match &tx.to { Some(w) => w, None => continue };
            let data = match &tx.data { Some(d) => d, None => continue };
            if !Self::claim_authorized(tx, to, data) {
                if is_warn() {
                    println!("[WARN][REWARDS] claim_unauthorized wallet={} action=skip_tx",
                             qnet_state::char_prefix(to, 16));
                }
                continue;
            }
            let parsed = match serde_json::from_str::<serde_json::Value>(data) { Ok(p) => p, Err(_) => continue };
            let entries = match parsed.get("claims").and_then(|v| v.as_array()) { Some(a) => a, None => continue };
            let mut claims: Vec<(u64, u64, Vec<(String, bool)>)> = entries.iter().filter_map(|e| {
                let epoch = e.get("epoch")?.as_u64()?;
                let amount = e.get("amount")?.as_u64()?;
                let proof: Vec<(String, bool)> = e.get("proof")?.as_array()?.iter().filter_map(|p| {
                    let a = p.as_array()?;
                    Some((a.get(0)?.as_str()?.to_string(), a.get(1)?.as_bool()?))
                }).collect();
                Some((epoch, amount, proof))
            }).collect();
            claims.sort_by_key(|(e, _, _)| *e);
            if claims.is_empty() { continue; }
            // The credit debits the pool as well as crediting the wallet, so BOTH leaves need a
            // pre-image — the journal is what rollback replays, and a missing address is restored
            // from nothing.
            if let Some(ref mut snap) = block_snapshot {
                state_guard.journal_pre_images(snap,
                    &[to.clone(), StateManager::REWARDS_POOL.to_string()]);
            }

            for (epoch, amount, proof) in &claims {
                match crate::reward_epoch::root_for_apply(storage, *epoch, height) {
                    crate::reward_epoch::ApplyRoot::Root(root) => {
                        if root == [0u8; 32] { continue; } // epoch distributed nothing
                        let mut hasher = Sha3_256::new();
                        hasher.update(to.as_bytes());
                        hasher.update(&epoch.to_le_bytes());
                        hasher.update(&amount.to_le_bytes());
                        let leaf_hex = hex::encode(hasher.finalize());
                        if !qnet_core::crypto::merkle::verify_merkle_proof(&leaf_hex, &hex::encode(root), proof) {
                            // STOP, never skip: last_claimed_epoch is monotonic, so crediting a LATER
                            // epoch after skipping this one advances the watermark past it and burns
                            // it for this wallet permanently, on every node.
                            if is_warn() {
                                println!("[WARN][REWARDS] claim_proof_invalid wallet={} epoch={} action=stop_batch",
                                         qnet_state::char_prefix(to, 16), epoch);
                            }
                            break;
                        }
                        if state_guard.claim_reward(to, *epoch, *amount) && is_info() {
                            println!("[INFO][REWARDS] claim_credited wallet={} epoch={} amount={}",
                                     qnet_state::char_prefix(to, 16), epoch, amount);
                        }
                    }
                    // Rule says no: identical verdict on every node, so skipping is safe.
                    crate::reward_epoch::ApplyRoot::RuleInvalid => continue,
                    // Cannot decide locally. Crediting or skipping would fork state_root against
                    // nodes that hold the macroblock, so refuse the whole block instead.
                    crate::reward_epoch::ApplyRoot::LocalFault { certifying_mb } => {
                        println!("[ERR][REWARDS] claim_unresolvable epoch={} certifying_mb={} h={} action=abort_block",
                                 epoch, certifying_mb, height);
                        return Err(certifying_mb);
                    }
                }
            }
        }
        Ok(())
    }

    /// Admission/gossip pre-check for merkle reward-claims: reject unless the recipient wallet's key
    /// authorises this exact payload, and reject if ANY claim whose epoch reward_root is locally
    /// reconciled fails proof verification — keeps forged and no-op spam out of the mempool/blocks.
    /// Claims for an un-reconciled epoch (sync lag) are accepted and re-verified at apply (the final
    /// authority). Pure storage read; no state lock.
    pub(super) fn claim_proofs_admissible(
        storage: &crate::storage::Storage,
        tx: &qnet_state::Transaction,
        last_claimed: u64,
    ) -> bool {
        let to = match &tx.to { Some(w) => w, None => return false };
        let data = match &tx.data { Some(d) => d, None => return false };
        let entries = match serde_json::from_str::<serde_json::Value>(data).ok()
            .and_then(|v| v.get("claims").and_then(|c| c.as_array().cloned())) {
            Some(a) if !a.is_empty() => a,
            _ => return false,
        };
        // Cheapest gates first, so junk cannot buy an ML-DSA-65 verify or a merkle walk. Bound the
        // entry count, then require the batch to still be worth applying: without the watermark check a
        // credited payload stays admissible forever and can be re-flooded as a free no-op.
        const MAX_CLAIM_ENTRIES: usize = 512;
        if entries.len() > MAX_CLAIM_ENTRIES { return false; }
        if !entries.iter().any(|e| e.get("epoch").and_then(|v| v.as_u64()).map_or(false, |ep| ep > last_claimed)) {
            return false;
        }
        if !Self::claim_authorized(tx, to, data) { return false; }
        for e in &entries {
            let (epoch, amount) = match (e.get("epoch").and_then(|v| v.as_u64()), e.get("amount").and_then(|v| v.as_u64())) {
                (Some(ep), Some(am)) => (ep, am),
                _ => return false,
            };
            let proof: Vec<(String, bool)> = match e.get("proof").and_then(|v| v.as_array()) {
                Some(arr) => {
                    let mut p = Vec::with_capacity(arr.len());
                    for it in arr {
                        match it.as_array().and_then(|a| Some((a.get(0)?.as_str()?.to_string(), a.get(1)?.as_bool()?))) {
                            Some(t) => p.push(t),
                            None => return false,
                        }
                    }
                    p
                }
                None => return false,
            };
            let root_hex = match crate::reward_epoch::root_for_apply(storage, epoch, u64::MAX) {
                crate::reward_epoch::ApplyRoot::Root(r) => hex::encode(r),
                _ => return false,
            };
            let mut hasher = Sha3_256::new();
            hasher.update(to.as_bytes());
            hasher.update(&epoch.to_le_bytes());
            hasher.update(&amount.to_le_bytes());
            let leaf_hex = hex::encode(hasher.finalize());
            if !qnet_core::crypto::merkle::verify_merkle_proof(&leaf_hex, &root_hex, &proof) {
                return false;
            }
        }
        true
    }

    /// The on-disk spelling of a node type. registry_root hashes it, so it has exactly one
    /// definition — a second copy that drifted would fork the root.
    pub(crate) fn registration_type_str(node_type: &qnet_state::NodeType) -> &'static str {
        match node_type {
            qnet_state::NodeType::Super => "super",
            qnet_state::NodeType::Light => "light",
        }
    }

    /// Canonical stamping order for one block's registry rows.
    ///
    /// `reg_index` is handed out by a monotone counter as rows are written, while the rebuild ranks
    /// survivors by (reg_height, node_id). Those two agree only if a block's rows are stamped in
    /// node_id order — transaction order is not, so writing them as they arrived made any restarted
    /// node renumber and its registry_root diverge from one that never restarted. reg_height is
    /// immutable once stamped and identical for every row in a block, so node_id alone IS the rank.
    pub(crate) fn sort_registrations_canonically(
        rows: &mut Vec<(String, String, String, String, String)>,
    ) {
        rows.sort_by(|a, b| a.0.cmp(&b.0));
    }

}

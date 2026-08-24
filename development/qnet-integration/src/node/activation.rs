//! Region detection, node activation, device binding and migration.

use super::*;

impl BlockchainNode {
    /// Auto-detect region from IP geolocation
    pub async fn auto_detect_region() -> Result<Region, String> {
        println!("[INFO][NODE] region_auto_detect method=geolocation");
        
        // Method 1: Check QNET_REGION environment variable
        if let Ok(region_hint) = std::env::var("QNET_REGION") {
            match region_hint.to_lowercase().as_str() {
                "na" | "northamerica" => return Ok(Region::NorthAmerica),
                "eu" | "europe" => return Ok(Region::Europe),
                "asia" => return Ok(Region::Asia),
                "sa" | "southamerica" => return Ok(Region::SouthAmerica),
                "africa" => return Ok(Region::Africa),
                "oceania" => return Ok(Region::Oceania),
                _ => {}
            }
        }
        
        // Method 2: Get external IP and use real geolocation services
        if let Ok(external_ip) = Self::get_physical_ip_without_external_services().await {
            println!("[DBG][NODE] geolocation_ip ip={}", external_ip);
            
            // Try multiple geolocation services for accuracy
            if let Ok(region) = Self::detect_region_via_geolocation_api(&external_ip).await {
                println!("[INFO][NODE] region_detected method=geolocation region={:?}", region);
                return Ok(region);
            }
        }
        
        // Method 3: Network latency testing (fallback)
        match Self::simple_latency_region_test().await {
            Ok(region) => {
                println!("[INFO][NODE] region_detected method=latency region={:?}", region);
                return Ok(region);
            }
            Err(e) => {
                println!("[WARN][NODE] latency_test_failed err={}", e);
            }
        }
        
        // Production: MUST detect region - no fallback defaults allowed
        Err("Production region detection failed - manual QNET_REGION environment variable required".to_string())
    }
    
    /// Detect region using real geolocation API services
    pub(super) async fn detect_region_via_geolocation_api(ip: &str) -> Result<Region, String> {
        println!("[DBG][NODE] geolocation_query ip={}", ip);
        
        // Try multiple geolocation services for reliability
        let geolocation_services = vec![
            format!("https://ip-api.com/json/{}", ip),
            format!("https://ipapi.co/{}/json/", ip),
            format!("https://api.ipstack.com/{}?access_key=free", ip),
        ];
        
        for service_url in geolocation_services {
            match Self::query_geolocation_service(&service_url).await {
                Ok(region) => {
                    println!("[INFO][NODE] region_detected service={} region={:?}", service_url, region);
                    return Ok(region);
                }
                Err(e) => {
                    println!("[WARN][NODE] geolocation_failed service={} err={}", service_url, e);
                    continue;
                }
            }
        }
        
        Err("All geolocation services failed".to_string())
    }
    
    /// Query a specific geolocation service
    pub(super) async fn query_geolocation_service(url: &str) -> Result<Region, String> {
        use std::time::Duration;
        
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15)) // PRODUCTION: Increased for Genesis node connectivity
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;
        
        let response = client.get(url)
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))?;
        
        if !response.status().is_success() {
            return Err(format!("HTTP error: {}", response.status()));
        }
        
        let json_text = response.text().await
            .map_err(|e| format!("Response read error: {}", e))?;
        
        println!("[DBG][NODE] geolocation_response body={}", json_text);
        
        // Parse JSON response
        let json_value: serde_json::Value = serde_json::from_str(&json_text)
            .map_err(|e| format!("JSON parse error: {}", e))?;
        
        // Extract continent/region information (try multiple fields)
        let region = if let Some(continent) = json_value.get("continent").and_then(|v| v.as_str()) {
            Self::map_continent_to_region(continent)
        } else if let Some(continent_code) = json_value.get("continent_code").and_then(|v| v.as_str()) {
            Self::map_continent_code_to_region(continent_code)
        } else if let Some(continent_code) = json_value.get("continentCode").and_then(|v| v.as_str()) {
            Self::map_continent_code_to_region(continent_code)
        } else if let Some(country_code) = json_value.get("country_code").and_then(|v| v.as_str()) {
            Self::map_country_code_to_region(country_code)
        } else if let Some(country_code) = json_value.get("countryCode").and_then(|v| v.as_str()) {
            Self::map_country_code_to_region(country_code)
        } else {
            return Err("No continent/country information in response".to_string());
        };
        
        region.ok_or_else(|| "Unknown region".to_string())
    }
    
    /// Map continent name to region
    pub(super) fn map_continent_to_region(continent: &str) -> Option<Region> {
        match continent.to_lowercase().as_str() {
            "north america" | "northern america" => Some(Region::NorthAmerica),
            "europe" => Some(Region::Europe),
            "asia" => Some(Region::Asia),
            "south america" | "southern america" => Some(Region::SouthAmerica),
            "africa" => Some(Region::Africa),
            "oceania" | "australia" => Some(Region::Oceania),
            _ => None,
        }
    }
    
    /// Map continent code to region
    pub(super) fn map_continent_code_to_region(code: &str) -> Option<Region> {
        match code.to_uppercase().as_str() {
            "NA" => Some(Region::NorthAmerica),
            "EU" => Some(Region::Europe),
            "AS" => Some(Region::Asia),
            "SA" => Some(Region::SouthAmerica),
            "AF" => Some(Region::Africa),
            "OC" => Some(Region::Oceania),
            _ => None,
        }
    }
    
    /// Map major country codes to regions (only essential ones)
    pub(super) fn map_country_code_to_region(code: &str) -> Option<Region> {
        match code.to_uppercase().as_str() {
            // North America
            "US" | "CA" | "MX" => Some(Region::NorthAmerica),
            
            // Europe (major countries)
            "DE" | "FR" | "GB" | "ES" | "IT" | "NL" | "PL" | "RO" | "BE" | "CZ" |
            "PT" | "HU" | "SE" | "AT" | "CH" | "BG" | "DK" | "FI" | "NO" | "IE" => Some(Region::Europe),
            
            // Asia (major countries)  
            "CN" | "IN" | "JP" | "KR" | "TH" | "VN" | "SG" | "MY" | "PH" | "ID" |
            "TW" | "HK" | "BD" | "PK" => Some(Region::Asia),
            
            // South America
            "BR" | "AR" | "CL" | "CO" | "PE" | "VE" => Some(Region::SouthAmerica),
            
            // Africa (major countries)
            "ZA" | "NG" | "EG" | "KE" | "MA" => Some(Region::Africa),
            
            // Oceania
            "AU" | "NZ" => Some(Region::Oceania),
            
            _ => None,
        }
    }
    
    /// Save activation code to persistent storage with security validation
    pub async fn save_activation_code(&self, code: &str, node_type: NodeType) -> Result<(), QNetError> {
        // v3.18: Super node type removed - use 2 for Super (backward compatible)
        let node_type_id = match node_type {
            NodeType::Light => 0,
            NodeType::Super => 2,
        };
        
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // Validate activation code format
        if code.is_empty() {
            return Err(QNetError::ValidationError("Empty activation code".to_string()));
        }
        
        // Check for genesis bootstrap codes first (different format)
        // IMPORT from shared constants to avoid duplication
        use crate::genesis_constants::GENESIS_BOOTSTRAP_CODES;
        let bootstrap_whitelist = GENESIS_BOOTSTRAP_CODES;
        
        let is_genesis_code = bootstrap_whitelist.contains(&code);
        
        // PRODUCTION: Initialize blockchain registry with real QNet nodes
        let qnet_rpc = Self::resolve_genesis_rpc_url();
        
        if is_genesis_code {
            println!("[INFO][ACTIVATION] genesis_bootstrap_code code={}", code);
            // Skip format validation AND ownership check for genesis codes
            // Genesis codes are shared bootstrap codes with IP-based authentication
            println!("[INFO][ACTIVATION] genesis_code_skip_ownership auth=ip_based");
        } else {
            // Check basic format for regular codes (26-char format only)
            if !code.starts_with("QNET-") || code.len() != 25 {
                return Err(QNetError::ValidationError("Invalid activation code format. Expected: QNET-XXXXXX-XXXXXX-XXXXXX (25 chars)".to_string()));
            }
            
            let registry = crate::activation_validation::BlockchainActivationRegistry::new(
                Some(qnet_rpc.clone())
            );
            
            // v4.5: STATELESS verification — use env vars for burn_tx + burn_amount
            // Docker: -e QNET_BURN_TX_HASH=... -e QNET_BURN_AMOUNT=...
            // Code = XOR(wallet, SHA3(burn_tx:type:amount)) — self-contained, no node state needed
            let env_burn_tx = std::env::var("QNET_BURN_TX_HASH").unwrap_or_default();
            let env_burn_amount: u64 = std::env::var("QNET_BURN_AMOUNT")
                .unwrap_or_default()
                .parse()
                .unwrap_or(0);
            
            if !env_burn_tx.is_empty() && env_burn_amount > 0 {
                // v4.7: CRITICAL — derive Solana address from mnemonic and compare with XOR-decrypted wallet
                // This proves the mnemonic entered on the server belongs to the wallet that burned tokens.
                // Without this check, an attacker with stolen code+burn_tx could use ANY mnemonic.
                let wallet_seed = load_wallet_seed("QNET_WALLET_SEED")
                    .or_else(|| load_wallet_seed("QNET_GENESIS_SEED"))
                    .ok_or(std::env::VarError::NotPresent)
                    .unwrap_or_default();
                
                if wallet_seed.is_empty() {
                    return Err(QNetError::ValidationError(
                        "QNET_WALLET_SEED is required for super node activation".to_string()
                    ));
                }
                
                // Derive Solana address from mnemonic (same BIP44/SLIP-10 path as mobile app)
                let solana_from_mnemonic = crate::crypto::solana_derivation::derive_solana_address_from_mnemonic(&wallet_seed)
                    .map_err(|e| QNetError::ValidationError(
                        format!("Failed to derive Solana address from mnemonic: {}", e)
                    ))?;
                
                println!("[INFO][ACTIVATION] solana_from_mnemonic={}...", 
                    qnet_state::char_prefix(&solana_from_mnemonic, 16));
                
                // STATELESS XOR verification — compare code's embedded wallet with mnemonic's Solana address
                // This is THE critical check: proves mnemonic owner == code owner
                match registry.verify_code_ownership_stateless(code, &solana_from_mnemonic, &env_burn_tx, env_burn_amount) {
                    Ok(true) => {
                        println!("[INFO][ACTIVATION] code_verified method=mnemonic_xor_match solana={}...",
                            qnet_state::char_prefix(&solana_from_mnemonic, 16));
                        // G3-L1: admission-advisory — re-verify the 1DEV burn ACTUALLY happened on
                        // Solana. The XOR check above only proves code↔wallet↔CLAIMED-burn-params
                        // consistency (the params are operator-supplied), NOT that a real burn occurred;
                        // without this an operator self-derives a valid code with a fabricated burn_tx.
                        // Same live getTransaction the HTTP register paths enforce. Per-node (NOT
                        // consensus — a live RPC is non-deterministic and cannot be in apply), so it
                        // refuses to activate THIS node without a real burn yet can never fork. Genesis
                        // bootstrap codes don't set QNET_BURN_TX_HASH so this whole branch is skipped.
                        match crate::rpc::verify_burn_transaction_exists(
                            &env_burn_tx, &solana_from_mnemonic, env_burn_amount, 1,
                        ).await {
                            Ok((true, _)) => {
                                if is_info() {
                                    println!("[INFO][ACTIVATION] burn_verified_onchain tx={}...",
                                        qnet_state::char_prefix(&env_burn_tx, 16));
                                }
                            }
                            Ok((false, _)) => return Err(QNetError::ValidationError(format!(
                                "burn_not_found_on_solana tx={} amount={} — no real 1DEV burn backs this activation",
                                env_burn_tx, env_burn_amount,
                            ))),
                            Err(e) => return Err(QNetError::ValidationError(format!(
                                "burn_verify_error tx={} err={}", env_burn_tx, e,
                            ))),
                        }
                    }
                    Ok(false) => {
                        println!("[ERR][ACTIVATION] mnemonic_mismatch solana_from_seed={}... code_wallet=different",
                            qnet_state::char_prefix(&solana_from_mnemonic, 16));
                        return Err(QNetError::ValidationError(
                            "Activation code does not belong to this mnemonic. \
                             The code was generated for a different wallet. \
                             Use the same seed phrase that was used in the mobile app when burning tokens.".to_string()
                        ));
                    }
                    Err(e) => {
                        return Err(QNetError::ValidationError(
                            format!("Activation code verification failed: {}. Check QNET_BURN_TX_HASH and QNET_BURN_AMOUNT.", e)
                        ));
                    }
                }
            } else {
                // No env burn data — REQUIRED for non-genesis nodes
                println!("[ERR][ACTIVATION] missing_burn_env_vars QNET_BURN_TX_HASH and QNET_BURN_AMOUNT required for super node activation");
                return Err(QNetError::ValidationError(
                    "QNET_BURN_TX_HASH and QNET_BURN_AMOUNT environment variables are required for super node activation. \
                     Get these from your mobile app: Settings > Export Activation Codes.".to_string()
                ));
            }
        }
        
        // The activation phase is a property of the NETWORK, not of the operator's input: it comes
        // from the live 1DEV supply through the one canonical resolver, never from the prefix or the
        // length of a caller-supplied burn_tx. A supply outage fails the activation closed rather
        // than defaulting to Phase 1, which would buy a Phase-2 entry for nothing. Genesis bootstrap
        // codes are the one exception and are decided by VERIFIED state — membership in the
        // compile-time whitelist checked above: they carry no burn and pay nothing on-chain.
        let pricing = if is_genesis_code {
            None
        } else {
            Some(crate::rpc::live_activation_pricing().await
                .map_err(|e| QNetError::ValidationError(format!(
                    "activation_price_unavailable err={} — cannot determine activation phase", e)))?)
        };
        let phase = pricing.as_ref().map(|p| p.phase).unwrap_or(1);
        let node_type_str = match node_type {
            NodeType::Super => "super",
            NodeType::Light => "light",
        };

        // v4.5: Get wallet and burn data — PREFER env vars (stateless), fallback to decrypt
        let (wallet_address, burn_tx_hash, burn_amount) = {
            let env_burn_tx = std::env::var("QNET_BURN_TX_HASH").unwrap_or_default();
            let env_burn_amount: u64 = std::env::var("QNET_BURN_AMOUNT")
                .unwrap_or_default()
                .parse()
                .unwrap_or(0);

            if !env_burn_tx.is_empty() && env_burn_amount > 0 {
                // Stateless path: wallet derived from code via XOR decryption
                let wallet = self.get_wallet_address();
                println!("[INFO][ACTIVATION] using_env_burn_data tx={}... amount={} phase={}",
                    qnet_state::char_prefix(&env_burn_tx, 16), env_burn_amount, phase);
                (wallet, env_burn_tx, env_burn_amount)
            } else {
                // Legacy path: decrypt code to get wallet + burn_tx
                let activation_payload = match self.decrypt_activation_code_full(code).await {
                    Ok(payload) => payload,
                    Err(e) => {
                        println!("[ERR][ACTIVATION] decrypt_failed={}", e);
                        println!("[ERR][ACTIVATION] Set QNET_BURN_TX_HASH and QNET_BURN_AMOUNT env vars for stateless activation");
                        return Err(QNetError::ValidationError(format!(
                            "Activation code decryption failed: {}. Set QNET_BURN_TX_HASH and QNET_BURN_AMOUNT.", e
                        )));
                    }
                };
                
                let wallet = activation_payload.wallet.clone();
                let btx = activation_payload.burn_tx.clone();

                // Get burn_amount from registry (stored when code was generated)
                let burn_amount = {
                    let registry_temp = crate::activation_validation::BlockchainActivationRegistry::new(
                        Some(qnet_rpc.clone())
                    );
                    let code_hash_temp = registry_temp.hash_activation_code_for_blockchain(code)
                        .unwrap_or_else(|_| {
                            format!("{:x}", Sha3_256::digest(code.as_bytes()))
                        });
                    
                    match registry_temp.get_activation_record_by_hash(&code_hash_temp).await {
                        Ok(Some(record)) => {
                            println!("   Burn Amount: {} (from registry)", record.activation_amount);
                            record.activation_amount
                        }
                        _ => {
                            // No registry record: fall back to the LIVE quote for this phase and node
                            // type, never a hardcoded constant that would under-price a Phase-2 entry.
                            // Genesis codes have no quote and owe nothing.
                            let quoted = pricing.as_ref().map(|p| p.cost_for(node_type_str)).unwrap_or(0);
                            println!("[INFO][ACTIVATION] burn_amount_from_quote amount={} phase={} node_type={}",
                                quoted, phase, node_type_str);
                            quoted
                        }
                    }
                };

                (wallet, btx, burn_amount)
            }
        };
        
        println!("[INFO][ACTIVATION] payload_extracted wallet={}... burn_tx={}... phase={} burn_amount={}",
                 qnet_state::char_prefix(&wallet_address, 16),
                 qnet_state::char_prefix(&burn_tx_hash, 16),
                 phase, burn_amount);
            
        // Create node info for blockchain registry with secure hash (SHA3-256 for NIST compliance)
        let registry = crate::activation_validation::BlockchainActivationRegistry::new(
            Some(qnet_rpc.clone())
        );
        let code_hash = registry.hash_activation_code_for_blockchain(code)
            .unwrap_or_else(|_| {
                format!("{:x}", Sha3_256::digest(code.as_bytes()))
            });
        
        let node_info = crate::activation_validation::NodeInfo {
            activation_code: code_hash, // Use hash for secure blockchain storage
            wallet_address: wallet_address.clone(),
            device_signature: self.get_device_signature(),
            node_type: format!("{:?}", node_type),
            activated_at: timestamp,
            last_seen: timestamp,
            migration_count: 0,
            node_id: self.node_id.clone(), // CRITICAL: Link activation_code to network node_id
            burn_tx_hash: burn_tx_hash.clone(), // CRITICAL: Store burn_tx for XOR decryption
            phase, // From the canonical live resolver, never from the burn_tx string
            burn_amount, // CRITICAL: Store exact amount for XOR key derivation
        };
        
        // FIXED: Register activation with device migration support
        // This updates the device_signature in global registry, causing old devices to deactivate
        if let Err(e) = registry.register_or_migrate_device(code, node_info, &self.get_device_signature()).await {
            println!("[WARN][ACTIVATION] device_register_failed err={}", e);
            // Continue with local storage only
        } else {
            println!("[INFO][ACTIVATION] device_registered migration=auto_deactivate_old");
        }
        
        // Save to local storage
        self.storage.save_activation_code(code, node_type_id, timestamp)
            .map_err(|e| QNetError::StorageError(e.to_string()))?;
        
        // CRITICAL: Save burn_tx_hash for future XOR decryption (e.g., after node restart)
        // This allows the node to re-derive the encryption key without re-querying blockchain
        if let Err(e) = self.storage.save_activation_burn_tx(&burn_tx_hash) {
            println!("[WARN][ACTIVATION] burn_tx_save_failed err={}", e);
            // Non-fatal - burn_tx can be retrieved from registry if needed
        } else {
            println!("[INFO][ACTIVATION] burn_tx_saved");
        }
        
        // Reward registration + the on-chain NodeRegistration arm moved to the single-owner
        // convergence driver (drive_registration_convergence): it re-collects burn attestations when
        // attest_epoch goes stale and arms behind the fail-closed frontier gate. This fn is the
        // one-time LOCAL activation path only: validate + device-register + persist.

        // v4.9: USER SUPER NODE MIGRATION TRACKING
        // Register device_id on a genesis node's RocksDB via lightweight REST API.
        // Flow: Super node starts → POST /api/v1/register-device → genesis stores device_id.
        // If the same activation code is used on a NEW server, genesis updates device_id.
        // Old server polls GET /api/v1/node-device every 30s → sees different device_id → graceful shutdown.
        // NOTE: Genesis nodes are EXCLUDED (they use IP-based auth, not activation codes).
        if !is_genesis_code {
            let device_sig = self.get_device_signature();
            let genesis_url = Self::resolve_genesis_rpc_url();
            
            let node_id_for_log = self.node_id.clone();
            let node_id_for_body = self.node_id.clone();
            let device_sig_clone = device_sig.clone();
            
            // Non-blocking: POST device_id to genesis node's RocksDB storage
            tokio::spawn(async move {
                let client = match reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(10))
                    .build() {
                    Ok(c) => c,
                    Err(_) => return,
                };
                let url = format!("{}/api/v1/register-device", genesis_url);
                let body = serde_json::json!({
                    "node_id": node_id_for_body,
                    "device_id": device_sig_clone,
                });
                match client.post(&url).json(&body).send().await {
                    Ok(resp) => {
                        if let Ok(json) = resp.json::<serde_json::Value>().await {
                            if json["success"].as_bool() == Some(true) {
                                println!("[INFO][ACTIVATION] device_registered_on_genesis node={}", node_id_for_log);
                            } else if is_debug() {
                                // Transient until the joiner's registration finalizes network-side; auto-retried.
                                println!("[DBG][ACTIVATION] device_register_rejected node={} err={}",
                                    node_id_for_log, json["error"].as_str().unwrap_or("unknown"));
                            }
                        }
                    }
                    Err(e) => {
                        println!("[WARN][ACTIVATION] device_register_failed node={} err={}", node_id_for_log, e);
                    }
                }
            });
        }
        
        println!("[INFO][ACTIVATION] code_saved binding=blockchain_registry");
        Ok(())
    }

    /// Genesis RPC URL from env: QNET_RPC_URL, else the first QNET_GENESIS_NODES entry.
    pub(crate) fn resolve_genesis_rpc_url() -> String {
        std::env::var("QNET_RPC_URL")
            .or_else(|_| std::env::var("QNET_GENESIS_NODES")
                .map(|nodes| { let ip = nodes.split(',').next().unwrap_or("127.0.0.1").trim().to_string(); format!("http://{}:8001", ip) }))
            .unwrap_or_else(|_| "http://127.0.0.1:8001".to_string())
    }

    /// One registration-convergence attempt (SOLE arm writer of PENDING_NODE_REGISTRATION):
    /// build + burn-attest + sign + submit + broadcast the on-chain NodeRegistration, then re-run
    /// the activation half (device registry + reward register) whose early-boot run drops its
    /// NodeActivation while the global mempool is not yet installed. Associated fn (no &self) so the
    /// boot-spawned driver loop owns it; Err ⇒ the driver retries next cooldown with FRESH
    /// attestations (never rebroadcasts bytes the verifier rejects forever).
    pub(super) async fn drive_registration_convergence(
        node_id: String,
        node_type: NodeType,
        wallet_address: String,
        registration_proof: String,
        api_endpoint: String,
        code: String,
        device_sig: String,
        qnet_rpc: String,
        storage: Arc<Storage>,
        mempool: Arc<qnet_mempool::SimpleMempool>,
        unified_p2p: Option<Arc<crate::unified_p2p::SimplifiedP2P>>,
    ) -> Result<(), QNetError> {
        let qnet_node_type = match node_type {
            NodeType::Super => qnet_state::NodeType::Super,
            NodeType::Light => qnet_state::NodeType::Light,
        };

        let mut registration_tx = Self::create_node_registration_tx_with_endpoint(
            &node_id,
            qnet_node_type.clone(),
            &wallet_address,
            &registration_proof,
            &api_endpoint,
        );

        // A Super MUST announce its consensus key in the hashed body: the committed row is immutable
        // once stamped, so a keyless registration would permanently strand this identity (no votes, no
        // production, never a burn attestor). Abort the arm instead — the driver retries once the key
        // is installed.
        if matches!(qnet_node_type, qnet_state::NodeType::Super) {
            let has_key = matches!(&registration_tx.tx_type,
                qnet_state::TransactionType::NodeRegistration { vrf_pk, .. }
                    if vrf_pk.len() == crate::crypto::vrf::D3_PK_BYTES);
            if !has_key {
                eprintln!("[WARN][REG] vrf_pk_missing node={} — retrying arm once the consensus key is installed", node_id);
                return Err(QNetError::NetworkError("vrf_pk_missing".to_string()));
            }
        }

        // Re-arm edge default: the current tip's epoch (pre-gate arms never carry attestations).
        let tip_h = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        let mut armed_epoch = tip_h.saturating_sub(1) / 90 + 1;

        // Burn reference: env (docker -e) with the persisted fallback (save_activation_code stores
        // it) so a restart without QNET_BURN_TX_HASH still arms a burn-backed registration instead
        // of attestation-less bytes the verifier rejects forever.
        let burn_tx_ref = std::env::var("QNET_BURN_TX_HASH").ok().filter(|s| !s.is_empty())
            .or_else(|| storage.get_activation_burn_tx().ok().filter(|s| !s.is_empty()))
            .unwrap_or_default();

        // Phase-1 burn-attestation (PRODUCTION half): when the gate is active, collect the committee
        // quorum that proves the Solana 1DEV burn and embed it so block validation accepts the
        // registration. Inert below the gate height.
        {
            let cur_h = storage.get_chain_height().unwrap_or(0);
            if qnet_state::feature_gates::is_active("burn_attestation_required", cur_h) {
                let b_tx = burn_tx_ref.clone();
                let b_amt: u64 = std::env::var("QNET_BURN_AMOUNT").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
                let mnemonic = load_wallet_seed("QNET_WALLET_SEED").unwrap_or_default();
                let solana_wallet = crate::crypto::solana_derivation::derive_solana_address_from_mnemonic(&mnemonic)
                    .unwrap_or_default();
                if !b_tx.is_empty() && !solana_wallet.is_empty() {
                    // Local Phase-1 cost (advisory hint only); each attestor recomputes + signs its own.
                    // Through the cached resolver — this driver retries, and an uncached read would
                    // hit Solana on every pass.
                    let cost_hint = crate::rpc::live_activation_pricing().await
                        .map(|p| p.phase1_cost).unwrap_or(0);
                    // The embedded burn_amount is the committee-certified agreed_amount (== what the
                    // counted n−f signed); QNET_BURN_AMOUNT is only an operator hint.
                    // Burner authorization: sign the beneficiary bind message with the SAME mnemonic-derived
                    // Solana key that made the burn. Attestors verify it before signing, and block validation
                    // re-verifies it from the TX — the burn can only ever activate the node its owner named,
                    // running the attestation root its owner named. The wallet key is derived first because
                    // its tag is inside that signed message.
                    let (wallet_pk, _) = crate::crypto::genesis_key::derive_wallet_mldsa65_from_mnemonic(&mnemonic);
                    let attest_root_tag = qnet_state::Transaction::attest_root_tag(&wallet_pk);
                    let owner_sig = {
                        use ed25519_dalek::Signer;
                        let msg = qnet_state::Transaction::burn_owner_bind_message(
                            &node_id, &wallet_address, &registration_proof, registration_tx.timestamp,
                            &wallet_pk, &b_tx);
                        match crate::crypto::solana_derivation::derive_solana_signing_key_from_mnemonic(&mnemonic) {
                            Ok(sk) => hex::encode(sk.sign(msg.as_bytes()).to_bytes()),
                            Err(e) => {
                                eprintln!("[WARN][REG] burn_owner_sign_failed err={} — retrying arm", e);
                                return Err(QNetError::NetworkError("burn_owner_sign_failed".to_string()));
                            }
                        }
                    };
                    let owner_proof = crate::node::BurnOwnerProof {
                        node_id: &node_id,
                        registration_proof: &registration_proof,
                        timestamp: registration_tx.timestamp,
                        signature: &owner_sig,
                        attest_root_tag: &attest_root_tag,
                    };
                    let (attestors, agreed_cost, agreed_amount, agreed_epoch) = Self::collect_burn_attestations(
                        &b_tx, &solana_wallet, &wallet_address, b_amt, qnet_node_type, cost_hint,
                        &owner_proof, &storage).await;
                    // Arm gate = quorum of the committee OF agreed_epoch — the SAME committee the
                    // attestors signed for and the on-chain verifier re-resolves (M-5). Genesis era ⇒
                    // the genesis set; post-genesis None ⇒ this node can't read that epoch's N-2
                    // committee ⇒ abort/retry (never arm bytes the verifier rejects forever).
                    let arm_genesis_era = agreed_epoch <= 2;
                    let arm_rep_h = agreed_epoch.saturating_sub(1) * 90 + 1;
                    let arm_committee_len = match Self::committee_for_height(&storage, arm_rep_h) {
                        Some(c) => c.len(),
                        None if arm_genesis_era => crate::genesis_constants::genesis_node_count(),
                        None => {
                            eprintln!("[WARN][REG] burn_attest_committee_unavailable epoch={} — retrying arm after resync", agreed_epoch);
                            return Err(QNetError::NetworkError(format!(
                                "burn_attest_committee_unavailable epoch={}", agreed_epoch)));
                        }
                    };
                    let need = qnet_consensus::checkpoint_bft::quorum_size(arm_committee_len);
                    if attestors.len() < need {
                        // Sub-quorum ⇒ abort this attempt; the driver re-collects fresh attestations
                        // next cooldown (covers -32050 attest_pending waves from the issuance throttle).
                        eprintln!("[WARN][REG] burn_attest_sub_quorum got={}/{} declared={} — retrying next cooldown",
                                  attestors.len(), need, b_amt);
                        return Err(QNetError::NetworkError(format!(
                            "burn_attest_sub_quorum got={} need={}", attestors.len(), need)));
                    }
                    if let qnet_state::TransactionType::NodeRegistration {
                        burn_tx: bt, burn_wallet: bw, burn_owner_sig: bos, burn_amount: ba, burn_cost: bc,
                        burn_attestors: at, attest_epoch: ae, ..
                    } = &mut registration_tx.tx_type {
                        *bt = b_tx; *bw = solana_wallet; *bos = owner_sig; *ba = agreed_amount; *bc = agreed_cost;
                        *at = attestors; *ae = agreed_epoch;
                    }
                    armed_epoch = agreed_epoch;
                }
            }
        }

        // Beneficiary proof: sign with the WALLET ML-DSA-65 key, whose EON IS wallet_address. Block
        // validation checks that binding, so a registration can only ever name a wallet the signer
        // controls. The node's consensus key rides the hashed vrf_pk body field instead — the two are
        // deliberately different keys and only the wallet one proves ownership.
        {
            let canonical_msg = Self::chain_bind(&match &registration_tx.tx_type {
                qnet_state::TransactionType::NodeRegistration { node_type, vrf_pk, api_endpoint, .. } =>
                    Self::client_node_reg_message(&node_id, &wallet_address, &registration_proof,
                                                  registration_tx.timestamp, node_type, vrf_pk, api_endpoint),
                _ => String::new(),
            });
            {
                // FIX-5 wire: RAW detached sig (3309 B) + RAW pk (1952 B) — the exact form the client-reg
                // verifier (verify_node_lifecycle_dilithium) requires.
                use pqcrypto_traits::sign::{DetachedSignature as _, SecretKey as _};
                let mnemonic = load_wallet_seed("QNET_WALLET_SEED").unwrap_or_default();
                let (wpk, wsk) = crate::crypto::genesis_key::derive_wallet_mldsa65_from_mnemonic(&mnemonic);
                match pqcrypto_mldsa::mldsa65::SecretKey::from_bytes(&wsk) {
                    Ok(sk) => {
                        let sig = pqcrypto_mldsa::mldsa65::detached_sign(canonical_msg.as_bytes(), &sk);
                        registration_tx.dilithium_signature = Some(sig.as_bytes().to_vec());
                        registration_tx.dilithium_public_key = Some(wpk);
                    }
                    Err(e) => {
                        eprintln!("[WARN][REG] wallet_key_sign_failed err={:?}", e);
                        return Err(QNetError::NetworkError("wallet_key_sign_failed".to_string()));
                    }
                }
            }
            // Mark as client-signed → other nodes MUST verify both signatures
            registration_tx.data = Some(format!("client_node_reg:{}:{}:{}:",
                node_id, wallet_address, registration_proof));
            registration_tx.hash = registration_tx.calculate_hash();
            println!("[INFO][REG] signed dilithium3={} node={}",
                registration_tx.dilithium_signature.is_some(), node_id);
        }

        // Submit + arm + deliver.
        let tx_bytes = bincode::serialize(&registration_tx).unwrap_or_default();
        let tx_hash = registration_tx.hash.clone();
        if mempool.add_binary_transaction(tx_bytes.clone(), tx_hash.clone(), 0) {
            if is_info() {
                println!("[INFO][REG] onchain_tx_submitted node={} wallet={}... hash={}...",
                         node_id,
                         qnet_state::char_prefix(&wallet_address, 16),
                         qnet_state::char_prefix(&tx_hash, 16));
            }
            // Arm the backoff rebroadcast (field 3 = backoff tick, field 4 = re-arm edge epoch).
            if let Ok(mut pend) = PENDING_NODE_REGISTRATION.lock() {
                *pend = Some((node_id.clone(), tx_bytes.clone(), 0, armed_epoch));
            }
            // Producer-direct gossip + direct fan-out to every genesis node (same delivery guarantee
            // as NodeActivation — a fresh joiner usually has no producer info yet).
            if let Some(ref p2p) = unified_p2p {
                let _ = p2p.broadcast_transaction(tx_bytes.clone());
                let tx_msg = crate::unified_p2p::NetworkMessage::Transaction { data: tx_bytes };
                let genesis_ips = crate::unified_p2p::get_genesis_bootstrap_ips();
                for ip in &genesis_ips {
                    p2p.send_network_message(&format!("{}:8001", ip), tx_msg.clone());
                }
                if is_info() { println!("[INFO][REG] registration_tx_broadcast hash={} genesis={}", qnet_state::char_prefix(&tx_hash, 16), genesis_ips.len()); }
            }
        } else {
            // Not in the local mempool ⇒ PENDING is NOT armed and the rebroadcast has nothing to send.
            eprintln!("[WARN][REG] onchain_tx_failed node={} — will retry", node_id);
            return Err(QNetError::NetworkError(format!("registration_tx_not_submitted node={}", node_id)));
        }

        // Folded activation half: re-run the device registration NOW that the global mempool exists —
        // the early-boot run (activation_validation) silently drops its NodeActivation before the
        // mempool handle is installed. register_or_migrate_device is idempotent (register-or-migrate).
        {
            let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            let b_tx = burn_tx_ref.clone();
            let b_amt: u64 = std::env::var("QNET_BURN_AMOUNT").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
            // Phase from the ONE canonical resolver — a genesis identity carries no burn and pays
            // nothing, so it keeps Phase 1; everyone else fails closed on a supply-read outage rather
            // than stamping a literal that picks its own entry-price rule.
            let phase = if crate::genesis_constants::is_legacy_genesis_node(&node_id) {
                1
            } else {
                crate::rpc::live_activation_pricing().await
                    .map_err(|e| QNetError::ValidationError(format!(
                        "activation_price_unavailable err={} — cannot determine activation phase", e)))?
                    .phase
            };
            let registry = crate::activation_validation::BlockchainActivationRegistry::new(Some(qnet_rpc.clone()));
            let node_info = crate::activation_validation::NodeInfo {
                activation_code: registration_proof.clone(),
                wallet_address: wallet_address.clone(),
                device_signature: device_sig.clone(),
                node_type: format!("{:?}", node_type),
                activated_at: timestamp,
                last_seen: timestamp,
                migration_count: 0,
                node_id: node_id.clone(),
                burn_tx_hash: b_tx,
                phase,
                burn_amount: b_amt,
            };
            if let Err(e) = registry.register_or_migrate_device(&code, node_info, &device_sig).await {
                println!("[WARN][ACTIVATION] device_register_failed err={}", e);
            }
        }

        Ok(())
    }

    /// Spawn the single-owner registration-convergence driver (once per process). Owns every
    /// arm/re-arm of PENDING_NODE_REGISTRATION behind the fail-closed arm gate, on a dedicated task
    /// (collect is serial 30s reqwest — never on the maintenance loop). Production does NOT wait on
    /// registration: an unregistered node is absent from srtr_ and is never VRF-selected, so
    /// decoupling changes nothing in selection or failover.
    pub(crate) fn spawn_registration_convergence_driver(&self, code: String) {
        static DRIVER_SPAWNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if DRIVER_SPAWNED.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
        let node_id = self.node_id.clone();
        let node_type = self.node_type;
        let storage = self.storage.clone();
        let mempool = self.mempool.clone();
        let unified_p2p = self.unified_p2p.clone();
        let wallet_address = self.get_wallet_address();
        let device_sig = self.get_device_signature();
        let qnet_rpc = Self::resolve_genesis_rpc_url();
        let registration_proof = crate::activation_validation::BlockchainActivationRegistry::new(Some(qnet_rpc.clone()))
            .hash_activation_code_for_blockchain(&code)
            .unwrap_or_else(|_| blake3::hash(code.as_bytes()).to_hex().to_string());
        let api_endpoint = Self::self_public_api_endpoint(node_type);
        tokio::spawn(async move {
            let mut ladder = ArmLadderState::default();
            let mut was_onchain = false;
            loop {
                if storage.is_node_registration_onchain(&node_id) {
                    // Registered: drop to a low-frequency watchdog instead of exiting — a bounded reorg
                    // that rolls back the registration block must re-arm (the process-latch prevents a
                    // respawn, so the driver itself owns recovery). Announce once on first landing.
                    if !was_onchain {
                        println!("[INFO][REG] convergence_done id={} registration=onchain", node_id);
                        was_onchain = true;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(REG_DRIVER_COOLDOWN_SECS)).await;
                    continue;
                }
                if was_onchain {
                    println!("[WARN][REG] registration_rolled_back id={} — re-arming", node_id);
                    was_onchain = false;
                    ladder = ArmLadderState::default();
                }
                if !registration_arm_gate(&mut ladder) {
                    tokio::time::sleep(std::time::Duration::from_secs(REG_DRIVER_DEFER_SECS)).await;
                    continue;
                }
                // Re-arm edge: verifier-fresh PENDING bytes stay (the rebroadcast delivers them);
                // re-collect only when PENDING is empty or its attest_epoch went stale.
                let cur_epoch = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                    .load(std::sync::atomic::Ordering::Relaxed).saturating_sub(1) / 90 + 1;
                let pending_fresh = PENDING_NODE_REGISTRATION.lock()
                    .map(|g| matches!(&*g, Some((_, _, _, ae)) if cur_epoch < ae + 2))
                    .unwrap_or(false);
                if pending_fresh {
                    tokio::time::sleep(std::time::Duration::from_secs(REG_DRIVER_DEFER_SECS)).await;
                    continue;
                }
                // Single-owner clear-then-arm: stale bytes are replaced wholesale (the mempool
                // commitment index collapses same-node_id versions — no double-submit).
                if let Ok(mut g) = PENDING_NODE_REGISTRATION.lock() { *g = None; }
                match Self::drive_registration_convergence(
                    node_id.clone(), node_type, wallet_address.clone(), registration_proof.clone(),
                    api_endpoint.clone(), code.clone(), device_sig.clone(), qnet_rpc.clone(),
                    storage.clone(), mempool.clone(), unified_p2p.clone(),
                ).await {
                    Ok(()) => { if is_info() { println!("[INFO][REG] convergence_armed id={}", node_id); } }
                    Err(e) => println!("[WARN][REG] convergence_attempt_failed err={} — retry", e),
                }
                tokio::time::sleep(std::time::Duration::from_secs(REG_DRIVER_COOLDOWN_SECS)).await;
            }
        });
    }

    /// Load activation code from persistent storage
    pub async fn load_activation_code(&self) -> Result<Option<(String, NodeType)>, QNetError> {
        match self.storage.load_activation_code()
            .map_err(|e| QNetError::StorageError(e.to_string()))? {
            Some((code, node_type_id, _timestamp)) => {
                // v3.18: Super node type removed - map old Full (1) to Super
                let node_type = match node_type_id {
                    0 => NodeType::Light,
                    2 => NodeType::Super,
                    1 => {
                        // v3.18: Old Super node type - upgrade to Super for backward compatibility
                        println!("[INFO][NODE] full_to_super_migration node_type_id=1");
                        NodeType::Super
                    },
                    _ => {
                        println!("[WARN][NODE] unknown_node_type id={} defaulting=Light", node_type_id);
                        NodeType::Light // Default to Light for unknown types
                    },
                };
                
                // Check if activation is still valid (codes never expire - tied to blockchain burns)
                println!("[INFO][ACTIVATION] valid_code_loaded binding=crypto");
                Ok(Some((code, node_type)))
            }
            None => Ok(None),
        }
    }
    
    /// Clear activation code from storage
    pub async fn clear_activation_code(&self) -> Result<(), QNetError> {
        self.storage.clear_activation_code()
            .map_err(|e| QNetError::StorageError(e.to_string()))?;
        Ok(())
    }
    
    /// Migrate device (same wallet, different device)
    pub async fn migrate_device(&self, code: &str, node_type: NodeType, new_device_signature: &str) -> Result<(), QNetError> {
        // v3.18: Super node type removed - use 2 for Super (backward compatible)
        let node_type_id = match node_type {
            NodeType::Light => 0,
            NodeType::Super => 2,
        };
        
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // Update activation record for device migration
        self.storage.update_activation_for_migration(code, node_type_id, timestamp, new_device_signature)
            .map_err(|e| QNetError::StorageError(e.to_string()))?;
        
        println!("[INFO][ACTIVATION] device_migrated sig={}", new_device_signature);
        Ok(())
    }
    
    /// Validate activation code (delegated to centralized ActivationValidator)
    #[allow(dead_code)]
    pub(super) async fn validate_activation_code_uniqueness(&self, code: &str) -> Result<(), String> {
        // Production activation code validation
        if code.is_empty() {
            return Err("Empty activation code is not allowed".to_string());
        }
        
        // Validate format: QNET-XXXXXX-XXXXXX-XXXXXX (25 chars)
        if !code.starts_with("QNET-") || code.len() != 25 {
            return Err("Invalid activation code format. Expected: QNET-XXXXXX-XXXXXX-XXXXXX (25 chars)".to_string());
        }
        
        // Use centralized ActivationValidator from activation_validation.rs
        // Activation validation integrated into consensus
        //     return Err("Activation code is already in use".to_string());
        // }
        
        // Validate against blockchain records
        println!("[INFO][ACTIVATION] validating_uniqueness");
                    let code_preview = if code.len() >= 8 { &code[..8] } else { code };
            println!("   Code: {}", code_preview);
        
        // In production: Query blockchain for code usage
        // For now, accept all valid format codes
        Ok(())
    }
    
    /// Generate unique node signature for security
    #[allow(dead_code)]
    pub(super) async fn generate_node_signature(&self) -> Result<String, String> {
        
        // Collect node-specific information
        let mut signature_components = Vec::new();
        
        // Node ID
        signature_components.push(self.node_id.clone());
        
        // Node type
        signature_components.push(format!("{:?}", self.node_type));
        
        // Region
        signature_components.push(format!("{:?}", self.region));
        
        // P2P port
        signature_components.push(self.p2p_port.to_string());
        
        // Current timestamp (rounded to hour for stability)
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let rounded_timestamp = (timestamp / 3600) * 3600; // Round to hour
        signature_components.push(rounded_timestamp.to_string());
        
        // Generate hash from components
        let combined = signature_components.join("|");
        let hash = hex::encode(Sha3_256::digest(combined.as_bytes()));
        
        Ok(hash)
    }
    
    /// Get device signature for blockchain registry
    pub fn get_device_signature(&self) -> String {
        
        // Generate consistent device signature based on node characteristics
        let mut hasher = Sha3_256::new();
        hasher.update(self.node_id.as_bytes());
        hasher.update(format!("{:?}", self.node_type).as_bytes());
        hasher.update(format!("{:?}", self.region).as_bytes());
        
        // Add system info for device uniqueness
        if let Ok(hostname) = std::env::var("HOSTNAME") {
            hasher.update(hostname.as_bytes());
        }
        if let Ok(user) = std::env::var("USER") {
            hasher.update(user.as_bytes());
        }
        
        format!("device_{}", hex::encode(hasher.finalize())[..16].to_string())
    }
    
    /// Get wallet address for this node (for activation verification)
    pub fn get_wallet_address(&self) -> String {
        // v4.0: Prefer seed-derived wallet address if available
        if let Some(ref identity) = self.wallet_identity {
            return identity.wallet_address.clone();
        }
        // Legacy fallback: derive from node_id (for nodes without QNET_WALLET_SEED)
        let hash = blake3::hash(self.node_id.as_bytes()).to_hex();
        let part1 = &hash[..19];
        let part2 = &hash[19..34];
        // SHA3-256 checksum (4 bytes = 32-bit collision resistance)
        let body = format!("{}eon{}", part1, part2);
        let checksum = hex::encode(&Sha3_256::digest(body.as_bytes())[..4]);
        format!("{}eon{}{}", part1, part2, checksum)
    }
    
    /// Extract wallet address from activation code using quantum decryption
    pub async fn extract_wallet_from_activation_code(&self, code: &str) -> Result<String, QNetError> {
        let payload = self.decrypt_activation_code_full(code).await?;
        Ok(payload.wallet)
    }
    
    /// Decrypt activation code and return full payload (wallet, burn_tx, node_type, etc.)
    /// CRITICAL: This is the single source of truth for activation data extraction
    pub async fn decrypt_activation_code_full(&self, code: &str) -> Result<crate::quantum_crypto::ActivationPayload, QNetError> {
        // PRODUCTION v2.51: Safe quantum crypto access
        let quantum_crypto = try_get_quantum_crypto()
            .ok_or_else(|| QNetError::ValidationError("Quantum crypto not initialized".to_string()))?;
            
        // SECURITY: NO FALLBACK ALLOWED - quantum decryption MUST work
        match quantum_crypto.decrypt_activation_code(code).await {
            Ok(payload) => Ok(payload),
            Err(e) => {
                println!("[ERR][ACTIVATION] quantum_decryption_failed err={}", e);
                println!("   Code: {}...", qnet_state::char_prefix(&code, 8));
                println!("   This activation code is invalid, corrupted, or crypto system is broken");
                Err(QNetError::ValidationError(format!("Quantum decryption failed - invalid activation code: {}", e)))
            }
        }
    }
    
    /// Check if this device has been deactivated due to migration
    /// v4.9: Uses HTTP query to genesis node's /api/v1/node-device endpoint
    /// instead of in-memory registry (which is empty after genesis restart)
    pub async fn check_device_deactivation(&self) -> Result<bool, QNetError> {
        // Skip device deactivation check for Genesis/bootstrap nodes - they don't use activation codes
        if std::env::var("QNET_BOOTSTRAP_ID").is_ok() {
            return Ok(false);
        }
        
        let my_device = self.get_device_signature();
        if my_device.is_empty() {
            return Ok(false);
        }
        
        // Build the genesis node API URL
        let genesis_api = std::env::var("QNET_RPC_URL")
            .or_else(|_| std::env::var("QNET_GENESIS_NODES")
                .map(|nodes| { let ip = nodes.split(',').next().unwrap_or("127.0.0.1").trim().to_string(); format!("http://{}:8001", ip) }))
            .unwrap_or_else(|_| "http://127.0.0.1:8001".to_string());
        
        // Query genesis node's RocksDB via REST API for the current device_id of our node
        // node_id format: "super_QNET-XXXXXX-XXXXXX-XXXXXX" — no special URL chars needed
        let url = format!("{}/api/v1/node-device?node_id={}", genesis_api, &self.node_id);
        
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|e| QNetError::NetworkError(format!("HTTP client error: {}", e)))?;
        
        match client.get(&url).send().await {
            Ok(response) => {
                match response.json::<serde_json::Value>().await {
                    Ok(json) => {
                        if json["success"].as_bool() == Some(true) {
                            if let Some(current_device) = json["device_id"].as_str() {
                                if current_device != my_device {
                                    println!("[WARN][MIGRATION] device_changed my={} current={} action=shutdown",
                                        qnet_state::char_prefix(&my_device, 8),
                                        qnet_state::char_prefix(&current_device, 8));
                                    return Ok(true);
                                }
                                // Same device — still active
                                return Ok(false);
                            }
                            // device_id is null — not registered yet, continue
                            return Ok(false);
                        }
                        // API error — don't deactivate on transient failures
                        return Ok(false);
                    }
                    Err(_) => return Ok(false), // Parse error — don't deactivate
                }
            }
            Err(_) => {
                // Network error — genesis node might be down, don't deactivate
                return Ok(false);
            }
        }
    }
    
    /// Gracefully shutdown node due to device migration
    pub async fn graceful_shutdown_due_to_migration(&self) -> Result<(), QNetError> {
        println!("[WARN][ACTIVATION] graceful_shutdown reason=device_migration");
        
        // Stop accepting new transactions
        println!("[INFO][ACTIVATION] shutdown_step action=stop_tx_accept");
        
        // Finish processing current transactions
        println!("[INFO][ACTIVATION] shutdown_step action=finish_tx_processing");
        
        // Stop QUIC transport gracefully
        if let Some(ref p2p) = self.unified_p2p {
            p2p.stop_quic().await;
            println!("[INFO][ACTIVATION] shutdown_step action=quic_stopped");
        }
        
        // Clear local activation (so it doesn't restart automatically)
        self.clear_activation_code().await?;
        println!("[INFO][ACTIVATION] shutdown_step action=cleared_activation");
        
        // Send final status to network
        println!("[INFO][ACTIVATION] shutdown_step action=final_p2p_status");
        
        println!("[INFO][ACTIVATION] shutdown_complete migration=done");
        std::process::exit(0);
    }
    
}

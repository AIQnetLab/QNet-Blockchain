//! Node registration, activation codes, burn verification and reactivation endpoints.

use super::*;

pub(super) async fn handle_register_node(
    body: serde_json::Value,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // SCALABILITY: Periodic cleanup of stale migration timestamps (>24h old)
    {
        let now = crate::node::get_timestamp_safe();
        const MIGRATION_TTL_SECS: u64 = 86400; // 24 hours
        if SUPER_NODE_MIGRATION_TIMESTAMPS.len() > 100 {
            SUPER_NODE_MIGRATION_TIMESTAMPS.retain(|_, ts| now.saturating_sub(*ts) < MIGRATION_TTL_SECS);
        }
    }

    // SECURITY v6.1: IP rate limit
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "register_node") {
        return Ok(rate_limit_response);
    }

    // PRODUCTION v2.41.1: node_type is REQUIRED - no defaults!
    // v3.18: Full nodes removed - only Light and Super allowed
    // v6.1: Light node registration REMOVED from this endpoint.
    //       Light nodes MUST use /api/v1/light-node/register which issues a proper
    //       post-quantum gossip signature (pure ML-DSA-65 / ML-DSA-65).
    //       This endpoint gossips with empty signatures → other nodes reject the gossip
    //       → light node exists only on the receiving node (broken state, L1 violation).
    //       L1 precedent: typed-TX rollouts hard-block the legacy format rather than dual-accept.
    let node_type = match body["node_type"].as_str() {
        Some("light") => {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Light node registration via /api/v1/register is disabled (v6.1).",
                "hint": "Use POST /api/v1/light-node/register — supports pure Dilithium3 (ML-DSA-65) gossip signatures.",
                "migration_endpoint": "/api/v1/light-node/register"
            })));
        },
        Some(t) if t == "super" => t,
        Some("full") => {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Full node type removed in v3.18. Use Super node instead."
            })));
        },
        Some(t) => {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": format!("Invalid node_type '{}'. Must be: light or super", t)
            })));
        },
        None => {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Missing required field: node_type (must be: light or super)"
            })));
        }
    };
    let wallet_address = body["wallet_address"].as_str().unwrap_or("");
    let activation_code = body["activation_code"].as_str().unwrap_or("");
    let device_id = body["device_id"].as_str().unwrap_or("");
    let quantum_pubkey = body["quantum_pubkey"].as_str().unwrap_or("");
    let quantum_signature = body["quantum_signature"].as_str().unwrap_or("");
    
    if wallet_address.is_empty() || activation_code.is_empty() {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Missing required fields: wallet_address and activation_code"
        })));
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v5.0: MANDATORY ML-DSA-65 (ML-DSA-65) for ALL node types (light + super)
    // NIST FIPS 204 — post-quantum authentication required for registration.
    // Both Android (NDK/JNI) and iOS (ObjC bridge) support Dilithium since v5.0.
    // ═══════════════════════════════════════════════════════════════════════════
    {
        if quantum_pubkey.is_empty() || quantum_signature.is_empty() {
            println!("[WARN][REGISTER] rejected reason=missing_dilithium node_type={} wallet={}...",
                node_type, qnet_state::char_prefix(&wallet_address, 16));
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": format!(
                    "{} node registration requires Dilithium3 quantum_pubkey and quantum_signature (NIST FIPS 204). \
                     Both Android and iOS apps v5.0+ include the Dilithium3 native module.",
                    node_type
                )
            })));
        }

        // Verify ML-DSA-65 signature: proves the registrant controls the activation code + wallet
        let sig_msg = format!("register:{}:{}:{}", wallet_address, activation_code, node_type);
        let sig_valid = verify_mobile_dilithium_signature(&sig_msg, quantum_signature, quantum_pubkey);
        if sig_valid {
            println!("[INFO][REGISTER] dilithium_verified node_type={} wallet={}... pk_prefix={}...",
                node_type,
                qnet_state::char_prefix(&wallet_address, 16),
                qnet_state::char_prefix(&quantum_pubkey, 16));
        } else {
            println!("[WARN][REGISTER] dilithium_invalid node_type={} wallet={}...",
                node_type, qnet_state::char_prefix(&wallet_address, 16));
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Dilithium3 signature verification failed. \
                          Ensure the signature is created from the same activation code and wallet address."
            })));
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // v4.5: PURE STATELESS VERIFICATION — code is self-contained!
    // Code = XOR(wallet_prefix, SHA3(burn_tx_hash:node_type:burn_amount))
    // Decrypt code → compare wallet → verify burn on Solana. NO node state needed.
    //
    // Genesis bootstrap codes (`QNET-BOOT-XXXX-STRAP`) bypass the burn check
    // because the 5 anchored bootstrap identities are funded by network policy,
    // not on-chain burn. The bootstrap codes are PUBLIC (baked into every
    // binary in `GENESIS_BOOTSTRAP_CODES`), so without an IP gate any peer
    // could submit a registration with a bootstrap code and skip the
    // economic gate entirely. We require the request to arrive from one of
    // the canonical Genesis IPs (`GENESIS_NODE_IPS`) — same defence-in-depth
    // pattern used at the P2P layer for genesis-bearing messages.
    //
    // Note on identity: even when the bypass is allowed, the resulting
    // `node_id` is `super_QNET-BOOT-NNNN-STRAP` (not `genesis_node_NNN`),
    // so this gate prevents free-burn squatting, not genesis identity
    // squatting (the latter is closed by the registry binding + IP gate
    // covered elsewhere).
    // ═══════════════════════════════════════════════════════════════════════════════
    {
        let is_genesis_code = activation_code.starts_with("QNET-BOOT-")
            && activation_code.ends_with("-STRAP");

        if is_genesis_code {
            // IP-based authentication for genesis bootstrap codes.
            let sender_ip = remote_addr
                .map(|a| a.ip().to_string())
                .unwrap_or_default();
            let from_genesis_ip = !sender_ip.is_empty()
                && crate::genesis_constants::GENESIS_NODE_IPS
                    .iter()
                    .any(|(ip, _)| *ip == sender_ip);
            if !from_genesis_ip {
                println!(
                    "[WARN][REGISTER] genesis_code_from_non_genesis_ip code={}... sender_ip={} action=reject",
                    qnet_state::char_prefix(&activation_code, 16),
                    sender_ip
                );
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "Genesis bootstrap codes are restricted to anchored Genesis IPs",
                    "hint": "Use a code derived from your burn_tx_hash for non-genesis registration"
                })));
            }
            println!(
                "[INFO][REGISTER] genesis_code_bypass code={}... ip={}",
                qnet_state::char_prefix(&activation_code, 16),
                sender_ip
            );
        } else {
            let registry = &*GLOBAL_ACTIVATION_REGISTRY;
            
            // burn_tx_hash is REQUIRED for non-genesis nodes
            let burn_tx = match body["burn_tx_hash"].as_str().or_else(|| body["activation_tx"].as_str()) {
                Some(tx) if !tx.is_empty() => tx,
                _ => {
                    println!("[WARN][REGISTER] rejected reason=missing_burn_tx_hash wallet={}...",
                        qnet_state::char_prefix(&wallet_address, 16));
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "burn_tx_hash is required for node registration",
                        "hint": "Include burn_tx_hash and burn_amount from your activation metadata"
                    })));
                }
            };
            let burn_amount = match body["burn_amount"].as_u64() {
                Some(amt) if amt > 0 => amt,
                _ => {
                    println!("[WARN][REGISTER] rejected reason=missing_burn_amount wallet={}...",
                        qnet_state::char_prefix(&wallet_address, 16));
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "burn_amount is required for node registration",
                        "hint": "Include burn_amount (e.g. 1500) from your activation metadata"
                    })));
                }
            };
            
            // STEP 1: Stateless XOR decryption — verify code belongs to the burn wallet
            // v4.6: burn_wallet may differ from wallet_address (Solana vs EON for Phase 1)
            let xor_wallet = body["burn_wallet"].as_str()
                .filter(|w| !w.is_empty())
                .unwrap_or(wallet_address);
            match registry.verify_code_ownership_stateless(activation_code, xor_wallet, burn_tx, burn_amount) {
                Ok(true) => {
                    println!("[INFO][REGISTER] code_verified method=stateless_xor wallet={}...",
                        qnet_state::char_prefix(&wallet_address, 16));
                }
                Ok(false) => {
                    println!("[WARN][REGISTER] code_rejected method=stateless_xor wallet={}... code={}...",
                        qnet_state::char_prefix(&wallet_address, 16),
                        qnet_state::char_prefix(&activation_code, 8));
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "Activation code does not belong to this wallet (XOR mismatch)",
                        "hint": "Code is cryptographically bound to wallet via burn transaction"
                    })));
                }
                Err(e) => {
                    println!("[WARN][REGISTER] stateless_verify_failed wallet={}... err={}",
                        qnet_state::char_prefix(&wallet_address, 16), e);
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": format!("Code verification failed: {}", e),
                        "hint": "Ensure burn_tx_hash and burn_amount match the original burn transaction"
                    })));
                }
            }
            
            // STEP 1.5: v4.7 — Verify Ed25519 signature proving ownership of burn_wallet (Solana key)
            // This prevents stolen code reuse: attacker has code+burn_tx but NOT the Solana private key
            {
                let sig_hex = match body["ed25519_signature"].as_str() {
                    Some(s) if !s.is_empty() => s,
                    _ => {
                        println!("[WARN][REGISTER] rejected reason=missing_ed25519_signature wallet={}...",
                            qnet_state::char_prefix(&wallet_address, 16));
                        return Ok(warp::reply::json(&json!({
                            "success": false,
                            "error": "Ed25519 signature is required for node registration",
                            "hint": "Sign message 'qnet_register:{code}:{timestamp}' with your Solana private key"
                        })));
                    }
                };
                let sig_timestamp = body["signature_timestamp"].as_u64().unwrap_or(0);
                
                // Check timestamp freshness (within 5 minutes)
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                if now.abs_diff(sig_timestamp) > 300 {
                    println!("[WARN][REGISTER] rejected reason=stale_signature ts={} now={}", sig_timestamp, now);
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "Signature timestamp is too old or too far in the future (max 5 min)",
                        "hint": "Generate a fresh signature with current timestamp"
                    })));
                }
                
                let message = format!("qnet_register:{}:{}", activation_code, sig_timestamp);
                match crate::crypto::solana_derivation::verify_ed25519_signature(
                    message.as_bytes(), sig_hex, xor_wallet
                ) {
                    Ok(true) => {
                        println!("[INFO][REGISTER] ed25519_sig_verified solana_wallet={}...",
                            qnet_state::char_prefix(&xor_wallet, 16));
                    }
                    Ok(false) => {
                        println!("[WARN][REGISTER] ed25519_sig_invalid solana_wallet={}...",
                            qnet_state::char_prefix(&xor_wallet, 16));
                        return Ok(warp::reply::json(&json!({
                            "success": false,
                            "error": "Ed25519 signature verification failed — you are not the wallet owner",
                            "hint": "Sign with the Solana private key that burned tokens"
                        })));
                    }
                    Err(e) => {
                        println!("[ERROR][REGISTER] ed25519_verify_err err={}", e);
                        return Ok(warp::reply::json(&json!({
                            "success": false,
                            "error": format!("Ed25519 verification error: {}", e)
                        })));
                    }
                }
            }
            
            // STEP 2: Verify burn actually happened on Solana with sufficient amount
            // v4.7: CRITICAL — pass xor_wallet (Solana address) to verify feePayer == sender
            match verify_burn_transaction_exists(burn_tx, xor_wallet, burn_amount, 1).await {
                Ok((true, _actual_burned)) => {
                    println!("[INFO][REGISTER] burn_verified tx={}... sender={} amount={}",
                        qnet_state::char_prefix(&burn_tx, 16),
                        qnet_state::char_prefix(&xor_wallet, 16),
                        burn_amount);
                }
                Ok((false, _)) => {
                    println!("[WARN][REGISTER] burn_not_found tx={}...", qnet_state::char_prefix(&burn_tx, 16));
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "Burn transaction not found or insufficient amount on Solana",
                        "required_amount": burn_amount,
                        "burn_tx_hash": burn_tx
                    })));
                }
                Err(e) => {
                    println!("[ERROR][REGISTER] burn_verify_err tx={}... err={}",
                        qnet_state::char_prefix(&burn_tx, 16), e);
                    // v4.7: Solana verification is MANDATORY — no more bypass
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": format!("Burn verification failed: {}", e),
                        "burn_tx_hash": burn_tx,
                        "hint": "Ensure burn_tx_hash is valid and Solana RPC is reachable"
                    })));
                }
            }
            
            // v4.5: DYNAMIC PRICING — verify burn_amount >= current activation price
            {
                // Phase and price come from the ONE canonical resolver — the same value attestors
                // recompute and sign, so admission cannot disagree with attestation. A supply-read
                // failure is a retryable error, never a silent default.
                let pricing = match live_activation_pricing().await {
                    Ok(p) => p,
                    Err(e) => {
                        println!("[ERROR][REGISTER] activation_price_unavailable err={}", e);
                        return Ok(warp::reply::json(&json!({
                            "success": false,
                            "error": format!("Activation price unavailable: {}", e),
                            "retryable": true
                        })));
                    }
                };
                let current_phase = pricing.phase;
                let minimum_required = pricing.cost_for(&node_type);

                if burn_amount < minimum_required {
                    println!("[WARN][REGISTER] insufficient_burn amount={} required={} phase={} type={}",
                        burn_amount, minimum_required, current_phase, node_type);
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": format!("Insufficient burn: {} provided, {} required", burn_amount, minimum_required),
                        "required_amount": minimum_required,
                        "provided_amount": burn_amount,
                        "phase": current_phase,
                        "node_type": node_type,
                        "currency": if current_phase == 1 { "1DEV" } else { "QNC" }
                    })));
                }
                
                println!("[INFO][REGISTER] price_check_passed amount={} required={} type={}",
                    burn_amount, minimum_required, node_type);
            }
        }
    }
    
    // Generate node ID (deterministic from activation_code — same code = same node_id)
    let node_id = format!("{}_{}", node_type, activation_code);

    // ═══════════════════════════════════════════════════════════════════════════════
    // BLOCKCHAIN STATE CHECK — guards against duplicate registration on unsynced nodes.
    // Storage (RocksDB) may be empty after a data wipe + restart while the blockchain
    // state (in-memory, populated from synced blocks) already has the registration.
    //
    // CHECK 1: Is this exact node_id already on-chain? (same wallet + same code)
    //   → Return `already_registered: true` so the client can restore without creating a new TX.
    //
    // CHECK 2: Does this wallet already own a DIFFERENT node_id in state?
    //   → Reject: 1 wallet = 1 node rule enforced at the state level as well as storage level.
    // ═══════════════════════════════════════════════════════════════════════════════
    {
        let state_mgr = blockchain.get_state_manager();
        let state = state_mgr.read().await;

        // CHECK 1 — same code → same node_id → already registered
        if state.is_node_registered(&node_id) {
            println!("[INFO][REGISTER] already_registered_in_state type={} node={} wallet={}...",
                node_type, node_id, qnet_state::char_prefix(&wallet_address, 16));
            let reg_proof = {
                let burn_prefix = qnet_state::char_prefix(&activation_code, 16);
                let proof_input = format!("activation_{}:{}:{}", burn_prefix, node_id, wallet_address);
                let h = blake3::hash(proof_input.as_bytes()).to_hex().to_string();
                h[..32].to_string()
            };
            return Ok(warp::reply::json(&json!({
                "success": true,
                "already_registered": true,
                "node_id": node_id,
                "node_type": node_type,
                "registration_proof": reg_proof,
                "tx_required": false,
                "is_migration": false,
                "message": format!("{} node already registered. Your existing node has been restored.", node_type)
            })));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // v4.9: MIGRATION / DUPLICATE CHECK — different logic for Light vs Super nodes
    //
    // LIGHT NODES (mobile): Up to 3 devices per node. Handled by handle_light_node_register.
    //   This endpoint (handle_register_node) is a legacy/generic path.
    //   If light node already exists → silently update (same node_id, overwrite is safe).
    //
    // SUPER NODES (server): Exactly 1 server per node.
    //   Same wallet + same code = MIGRATION (new server, old server must shut down).
    //   Same wallet + different type = REJECTED (1 wallet = 1 node, any type).
    //   Rate limit: max 1 migration per 24 hours.
    // ═══════════════════════════════════════════════════════════════════════════════
    let is_migration: bool;
    {
        let storage = blockchain.get_storage();
        match storage.get_nodes_by_wallet(wallet_address) {
            Ok(nodes) if !nodes.is_empty() => {
                let (existing_node_id, existing_type, _rep) = &nodes[0];
                
                if existing_node_id == &node_id {
                    // Same node_id → same code → this is a SERVER MIGRATION (new server, same wallet+code)
                    if node_type == "super" {
                        // Rate limit: max 1 migration per 24 hours
                        let now_ts = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        
                        if let Some(last_migration) = SUPER_NODE_MIGRATION_TIMESTAMPS.get(wallet_address) {
                            let elapsed = now_ts.saturating_sub(*last_migration);
                            if elapsed < 86400 {
                                let remaining = 86400 - elapsed;
                                println!("[WARN][REGISTER] migration_rate_limited wallet={}... elapsed={}s remaining={}s",
                                    qnet_state::char_prefix(&wallet_address, 16), elapsed, remaining);
                                return Ok(warp::reply::json(&json!({
                                    "success": false,
                                    "error": "Server migration rate limited: max 1 per 24 hours",
                                    "remaining_seconds": remaining,
                                    "hint": "Wait before migrating to another server. For emergencies, contact support."
                                })));
                            }
                        }
                        
                        println!("[INFO][REGISTER] super_node_migration detected node={} wallet={}...",
                            node_id, qnet_state::char_prefix(&wallet_address, 16));
                        SUPER_NODE_MIGRATION_TIMESTAMPS.insert(wallet_address.to_string(), now_ts);
                        is_migration = true;
                    } else {
                        // Light node re-registration via generic endpoint — allow (overwrite)
                        println!("[INFO][REGISTER] light_node_reregistration node={}", node_id);
                        is_migration = false;
                    }
                } else {
                    // Different node_id but same wallet → 1 wallet = 1 node violation
                    println!("[WARN][REGISTER] wallet_already_has_different_node wallet={}... existing={} new={}",
                        qnet_state::char_prefix(&wallet_address, 16), existing_node_id, node_id);
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": format!("This wallet already has a {} node ({}). 1 wallet = 1 node rule.", existing_type, existing_node_id),
                        "existing_node_id": existing_node_id,
                        "existing_node_type": existing_type,
                        "hint": "Each wallet can only run ONE node (Light or Super). Deregister the existing node first."
                    })));
                }
            }
            _ => {
                // No existing node — fresh registration
                is_migration = false;
            }
        }
    }
    
    // Register with reward manager
    {
        // CRITICAL: Save node registration to storage (survive restarts)
        // For migrations: overwrites existing record with same node_id (RocksDB put = upsert)
        use qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
        if is_migration {
            // Migration: preserve existing reputation, only update timestamp
            let existing_rep = match blockchain.get_storage().get_nodes_by_wallet(wallet_address) {
                Ok(nodes) if !nodes.is_empty() => nodes[0].2,
                _ => INITIAL_REPUTATION,
            };
            if let Err(e) = blockchain.get_storage().save_node_registration(&node_id, node_type, wallet_address, existing_rep) {
                println!("[WARN][STORAGE] migration_save err={}", e);
            }
        } else {
            if let Err(e) = blockchain.get_storage().save_node_registration(&node_id, node_type, wallet_address, INITIAL_REPUTATION) {
                println!("[WARN][STORAGE] save_registration err={}", e);
            }
        }
        
        // v4.9: Save device_id to RocksDB for migration detection
        // Old server queries genesis node's RocksDB → sees new device_id → graceful shutdown
        if !device_id.is_empty() {
            if let Err(e) = blockchain.get_storage().save_node_device_id(&node_id, device_id) {
                println!("[WARN][STORAGE] save_device_id err={}", e);
            } else if is_migration {
                println!("[INFO][STORAGE] device_id_updated node={} device={}", node_id, device_id);
            }
        }
    }
    
    // Store in appropriate registry based on type
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
        
    if node_type == "light" {
        // Light node: store locally and gossip
        let mut registry = LIGHT_NODE_REGISTRY.lock();
        // v10.0 SCALABILITY: Bound registry to 100K entries
        const MAX_LIGHT_NODE_REGISTRY: usize = 100_000;
        if registry.len() >= MAX_LIGHT_NODE_REGISTRY && !registry.contains_key(&node_id) {
            if let Some(oldest_key) = registry.iter()
                .min_by_key(|(_, v)| v.last_ping)
                .map(|(k, _)| k.clone())
            {
                registry.remove(&oldest_key);
            }
        }
        let light_node = LightNodeInfo {
            node_id: node_id.clone(),
            devices: vec![LightNodeDevice {
                device_id: device_id.to_string(),
                wallet_address: wallet_address.to_string(),
                device_token_hash: format!("hash_{}", device_id),
                last_active: now,
                is_active: true,
            }],
            quantum_pubkey: quantum_pubkey.to_string(),
            registered_at: now,
            // Seed with now, not 0 (else a fresh node is the global min-by-last_ping and a full
            // registry self-evicts the just-registered entry — cache thrash).
            last_ping: now,
            ping_count: 0,
            reward_eligible: true,
        };
        registry.insert(node_id.clone(), light_node);
        
        // Gossip Light node registration to P2P network
        if let Some(p2p) = blockchain.get_unified_p2p() {
            use crate::unified_p2p::{LightNodeRegistrationData, PushType};
            let registration = LightNodeRegistrationData {
                node_id: node_id.clone(),
                wallet_address: wallet_address.to_string(),
                device_token_hash: format!("hash_{}", device_id),
                quantum_pubkey: quantum_pubkey.to_string(),
                registered_at: now,
                signature: String::new(), // No signature for legacy API
                push_type: PushType::FCM, // Default to FCM for legacy API
                unified_push_endpoint: None,
                last_seen: now,
                consecutive_failures: 0,
                is_active: true,
                ping_pubkey: String::new(),
                ping_delegation_cert: String::new(),
            };
            p2p.register_light_node(registration);
        }
    } else {
        // Super node: announce to network for pinger selection
        if let Some(p2p) = blockchain.get_unified_p2p() {
            // Trigger active node announcement (ASYNC - proper Dilithium signature)
            p2p.register_as_active_node_async().await;
            println!("[INFO][REGISTER] p2p_announce type={}", node_type);
        }
        
        // v4.9: If migration — broadcast deactivation signal to old server via P2P gossip
        // Old server runs check_device_deactivation every 30s → graceful_shutdown_due_to_migration
        if is_migration {
            // The phase comes from the ONE resolver, never a literal: this record can reach
            // register_activation_on_blockchain, which mints an on-chain NodeActivation whose phase
            // decides which entry-price rule applies. Fail closed on a supply-read outage.
            let phase = match live_activation_pricing().await {
                Ok(p) => p.phase,
                Err(e) => {
                    println!("[ERROR][REGISTER] activation_price_unavailable err={}", e);
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": format!("Activation price unavailable: {}", e),
                        "retryable": true
                    })));
                }
            };
            let registry = &*GLOBAL_ACTIVATION_REGISTRY;
            if let Err(e) = registry.register_or_migrate_device(
                activation_code,
                crate::activation_validation::NodeInfo {
                    activation_code: activation_code.to_string(),
                    wallet_address: wallet_address.to_string(),
                    device_signature: device_id.to_string(),
                    node_type: node_type.to_string(),
                    activated_at: now,
                    last_seen: now,
                    migration_count: 1,
                    node_id: node_id.clone(),
                    burn_tx_hash: body["burn_tx_hash"].as_str().unwrap_or("").to_string(),
                    phase,
                    burn_amount: body["burn_amount"].as_u64().unwrap_or(0),
                },
                device_id,
            ).await {
                println!("[WARN][REGISTER] migration_broadcast_err err={}", e);
            } else {
                println!("[INFO][REGISTER] migration_broadcast_sent old_server_will_shutdown node={}", node_id);
            }
        }
    }
    
    // =========================================================================
    // ON-CHAIN TX CREATION POLICY (v6.0):
    //   Super nodes → TX created SERVER-SIDE (server has API endpoint info, no mobile client)
    //   Light nodes → TX created CLIENT-SIDE (mobile wallet signs + routes to producer)
    //                 Server returns registration_proof; client calls /node-registration/submit
    //
    // This matches the architectural split:
    //   /api/v1/register          → Super/Genesis (server creates TX)
    //   /api/v1/light-node/register → Light (server verifies burn, client creates TX)
    // =========================================================================
    
    // Compute registration_proof for all node types (returned to caller)
    let registration_proof = {
        let burn_prefix = qnet_state::char_prefix(&activation_code, 16);
        let proof_input = format!("activation_{}:{}:{}", burn_prefix, node_id, wallet_address);
        let h = blake3::hash(proof_input.as_bytes()).to_hex().to_string();
        h[..32].to_string()
    };
    
    // Super node / Genesis: server creates TX (no mobile client, server knows endpoint)
    // v4.9: Skip for migrations — node already on-chain.
    // Under the burn gate this server-side TX carries no burn and no burner authorization, so every
    // validator hard-rejects it — the node's own convergence driver arms the burn-attested registration.
    // Emitting it would only spend gossip on bytes that can never land.
    let burn_gate_active = qnet_state::feature_gates::is_active(
        "burn_attestation_required", blockchain.get_storage().get_chain_height().unwrap_or(0));
    let tx_created_server_side = if (node_type == "super" || node_type == "genesis") && !burn_gate_active {
        if !is_migration {
            // Use api_endpoint from request body if provided; empty string = node hides IP
            let api_endpoint = body["api_endpoint"].as_str().unwrap_or("").to_string();
            let mut registration_tx = crate::node::BlockchainNode::create_node_registration_tx_with_endpoint(
                &node_id,
                qnet_state::NodeType::Super,
                wallet_address,
                &registration_proof,
                &api_endpoint,
            );
            sign_node_registration_tx(&mut registration_tx, &blockchain.get_node_id()).await;

            let mempool = blockchain.get_mempool();
            let tx_bytes = bincode::serialize(&registration_tx).unwrap_or_default();
            let tx_hash = registration_tx.hash.clone();
            if mempool.add_binary_transaction(tx_bytes.clone(), tx_hash.clone(), 0) {
                println!("[INFO][REG] super_onchain_tx node={} wallet={}... hash={}... signed=dilithium3",
                         node_id,
                         qnet_state::char_prefix(&wallet_address, 16),
                         qnet_state::char_prefix(&tx_hash, 16));
                if let Some(p2p) = blockchain.get_unified_p2p() {
                    let _ = p2p.broadcast_transaction(tx_bytes.clone());
                    // Same guaranteed delivery as NodeActivation: direct fan-out to all genesis.
                    let tx_msg = crate::unified_p2p::NetworkMessage::Transaction { data: tx_bytes };
                    for ip in &crate::unified_p2p::get_genesis_bootstrap_ips() {
                        p2p.send_network_message(&format!("{}:8001", ip), tx_msg.clone());
                    }
                }
            } else {
                eprintln!("[WARN][REG] super_onchain_tx_failed node={}", node_id);
            }
            true
        } else {
            println!("[INFO][REG] migration_skip_onchain_tx node={} (already on-chain)", node_id);
            false
        }
    } else {
        // Light node: client creates and submits the TX (producer-aware routing)
        // Server only verifies burn TX and registers locally.
        println!("[INFO][REG] light_node_tx_deferred_to_client node={}", node_id);
        false
    };
    
    // v4.0: Register VRF public key in global registry + persist to storage
    // v14.8: Super/Full nodes participate in consensus — mirror into the
    // consensus-layer registry. Registration via RPC is authenticated
    // upstream (wallet-bound + ML-DSA-65-signed activation code verified).
    if !quantum_pubkey.is_empty() && quantum_pubkey != "default_quantum_key" {
        if let Ok(pk_bytes) = hex::decode(quantum_pubkey) {
            crate::genesis_constants::register_vrf_public_key(&node_id, &pk_bytes);
            if node_type == "super" || node_type == "full" {
                let _ = qnet_consensus::consensus_crypto::register_consensus_pk_from_chain(&node_id, &pk_bytes);
            }
            if let Err(e) = blockchain.get_storage().save_vrf_public_key(&node_id, quantum_pubkey) {
                println!("[WARN][REGISTER] vrf_pk_persist err={}", e);
            }
        }
    }

    if is_migration {
        println!("[INFO][REGISTER] migration_success type={} node={} wallet={}",
             node_type, node_id, wallet_address);
    } else {
        println!("[INFO][REGISTER] success type={} node={} wallet={}",
                 node_type, node_id, wallet_address);
    }
    
    // tx_required = true for Light nodes (client must submit NodeRegistration TX)
    // tx_required = false for Super/Genesis (server already submitted TX)
    let tx_required = !tx_created_server_side && (node_type == "light");
    
    Ok(warp::reply::json(&json!({
        "success": true,
        "node_id": node_id,
        "quantum_pubkey": quantum_pubkey,
        "registration_proof": registration_proof,
        "tx_required": tx_required,
        "is_migration": is_migration,
        "message": if is_migration {
            format!("{} node migrated successfully (old server will be deactivated)", node_type)
        } else {
            format!("{} node registered successfully", node_type)
        }
    })))
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct AuthChallengeRequest {
    pub(super) challenge: String,
    pub(super) timestamp: u64,
    pub(super) protocol_version: String,
}

#[derive(Debug, serde::Serialize)]
pub(super) struct AuthChallengeResponse {
    pub(super) signature: String,
    pub(super) public_key: String,
    pub(super) node_id: String,
    pub(super) timestamp: u64,
}

pub(super) async fn handle_auth_challenge(
    request: AuthChallengeRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // FIX M13: Rate limit auth challenge (write category)
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "write") {
        return Ok(rate_limit_response);
    }
    // Validate protocol version
    if request.protocol_version != "qnet-v1.0" {
        return Ok(warp::reply::json(&json!({
            "error": "Unsupported protocol version",
            "supported": "qnet-v1.0"
        })));
    }
    
    // Validate timestamp (within 5 minutes)
    let current_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_else(|_| {
            println!("[RPC] ⚠️ System time error in auth challenge, using fallback");
            std::time::Duration::from_secs(1640000000)
        })
        .as_secs();
    
    if (current_time as i64 - request.timestamp as i64).abs() > 300 {
        return Ok(warp::reply::json(&json!({
            "error": "Challenge timestamp expired",
            "current_time": current_time
        })));
    }
    
    // Decode challenge
    let challenge_bytes = match hex::decode(&request.challenge) {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok(warp::reply::json(&json!({
                "error": "Invalid challenge format"
            })));
        }
    };
    
    let node_id = blockchain.get_node_id();
    
    // PRODUCTION: Sign challenge with REAL ML-DSA-65 via quantum crypto
    let challenge_msg = format!("auth_challenge:{}:{}", hex::encode(&challenge_bytes), request.timestamp);
    
    let (signature_hex, pubkey_hex) = match crate::node::try_get_quantum_crypto() {
        Some(crypto) => {
            match crypto.create_consensus_signature(&node_id, &challenge_msg).await {
                Ok(sig) => {
                    let pk_bytes = match crate::key_manager::DilithiumKeyManager::new(
                        node_id.to_string(),
                        std::path::Path::new(&std::env::var("QNET_STORAGE_PATH").unwrap_or_else(|_| "/app/data".to_string())).join("keys").as_path()
                    ) {
                        Ok(km) => km.get_public_key().unwrap_or_default(),
                        Err(_) => Vec::new(),
                    };
                    (sig.signature, hex::encode(&pk_bytes))
                }
                Err(e) => {
                    if crate::node::is_warn() {
                        println!("[WARN][AUTH] dilithium_sign_failed err={}", e);
                    }
                    return Ok(warp::reply::json(&json!({ "error": "Signature generation failed" })));
                }
            }
        }
        None => {
            return Ok(warp::reply::json(&json!({ "error": "Quantum crypto not initialized" })));
        }
    };
    
    if crate::node::is_info() {
        println!("[INFO][AUTH] p2p_challenge_signed node={}", node_id);
    }
    
    let response = AuthChallengeResponse {
        signature: signature_hex,
        public_key: pubkey_hex,
        node_id: node_id.to_string(),
        timestamp: current_time,
    };
    
    Ok(warp::reply::json(&response))
}

/// v4.9: Handle node device check — returns current device_id for a given node_id
/// Used by super nodes to detect if their activation has been migrated to another server.
/// The old server queries this endpoint on a genesis node every 30 seconds.
/// If device_id differs → migration detected → graceful shutdown.
pub(super) async fn handle_node_device_check(
    remote_addr: Option<std::net::SocketAddr>,
    query: HashMap<String, String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v10.0: Rate limit device check queries
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    let node_id = match query.get("node_id") {
        Some(id) if !id.is_empty() => id.as_str(),
        _ => {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Missing required query parameter: node_id"
            })));
        }
    };
    
    let storage = blockchain.get_storage();
    match storage.get_node_device_id(node_id) {
        Ok(Some(device_id)) => {
            Ok(warp::reply::json(&json!({
                "success": true,
                "node_id": node_id,
                "device_id": device_id
            })))
        }
        Ok(None) => {
            Ok(warp::reply::json(&json!({
                "success": true,
                "node_id": node_id,
                "device_id": null
            })))
        }
        Err(e) => {
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": format!("Storage error: {}", e)
            })))
        }
    }
}

/// v4.9: Register device_id for a USER SUPER NODE (migration tracking)
/// Called by super nodes on startup to store device_id on genesis node's RocksDB.
/// Genesis nodes NEVER call this — they use QNET_BOOTSTRAP_ID + IP-based auth.
/// Security: only allows node_ids starting with "super_" and validates node exists in RocksDB.
pub(super) async fn handle_register_device(
    body: serde_json::Value,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v10.0: Rate limit device registration
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "activation") {
        return Ok(rate_limit_response);
    }
    let node_id = match body["node_id"].as_str() {
        Some(id) if !id.is_empty() => id,
        _ => {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Missing required field: node_id"
            })));
        }
    };
    let device_id = match body["device_id"].as_str() {
        Some(id) if !id.is_empty() => id,
        _ => {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Missing required field: device_id"
            })));
        }
    };
    
    // SECURITY: Only user super nodes can register device_id. Genesis nodes are excluded.
    // v7.2: Check actual node_type from registration, not node_id prefix.
    // Non-genesis super nodes may have node_id like "node_{hostname}" (Docker).
    if node_id.starts_with("genesis_node_") {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Genesis nodes use QNET_BOOTSTRAP_ID for identity, not device registration"
        })));
    }
    // Verify the node is registered as Super in storage
    // load_node_registration returns (node_type, wallet, reputation)
    let is_super = {
        let storage = blockchain.get_storage();
        match storage.load_node_registration(node_id) {
            Ok(Some((node_type, _, _))) => {
                node_type.eq_ignore_ascii_case("super")
            }
            _ => {
                // Reject device registration for nodes not in storage. Expected transient during a
                // cold-join (joiner's own registration not yet applied locally) ⇒ DBG, auto-retried.
                if crate::node::is_debug() {
                    println!("[DBG][DEVICE] register_rejected node={} reason=not_registered_in_storage", node_id);
                }
                false
            }
        }
    };
    if !is_super {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Only registered super nodes can register device_id"
        })));
    }
    
    let storage = blockchain.get_storage();
    match storage.save_node_device_id(node_id, device_id) {
        Ok(()) => {
            println!("[INFO][DEVICE] super_node_device_registered node={} device={}", node_id, device_id);
            Ok(warp::reply::json(&json!({
                "success": true,
                "node_id": node_id,
                "device_id": device_id
            })))
        }
        Err(e) => {
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": format!("Storage error: {}", e)
            })))
        }
    }
}

/// Handle graceful shutdown request for node replacement
/// SECURITY v6.2: QNET_ADMIN_SECRET is MANDATORY — without it shutdown is DENIED
pub(super) async fn handle_graceful_shutdown(
    shutdown_request: Value,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};

    // FIX L-L7: Restrict shutdown to internal IPs + strict rate limiting
    let ip_str = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
    if !is_internal_ip(&ip_str) {
        println!("[WARN][API] shutdown_rejected_external ip={}", ip_str);
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Shutdown endpoint restricted to internal network"
        })));
    }
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "benchmark") {
        return Ok(rate_limit_response);
    }

    // SECURITY v6.2: QNET_ADMIN_SECRET must be configured, otherwise shutdown is blocked entirely
    let admin_secret = match std::env::var("QNET_ADMIN_SECRET") {
        Ok(s) if !s.is_empty() => s,
        _ => {
            if is_warn() {
                println!("[WARN][API] shutdown_rejected reason=QNET_ADMIN_SECRET_not_configured");
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Shutdown disabled: QNET_ADMIN_SECRET not configured on this node"
            })));
        }
    };
    
    let request_secret = shutdown_request.get("admin_secret")
        .and_then(|v| v.as_str());
    
    match request_secret {
        Some(req_secret) if req_secret == &admin_secret => {
            if is_info() {
                println!("[INFO][API] shutdown_authorized secret_match=true");
            }
        }
        _ => {
            if is_warn() {
                println!("[WARN][API] shutdown_rejected reason=invalid_or_missing_admin_secret");
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Unauthorized: invalid or missing admin_secret"
            })));
        }
    }

    let reason = shutdown_request.get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let message = shutdown_request.get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("Node shutdown requested");
    let timeout_seconds = shutdown_request.get("graceful_timeout_seconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(10);

    println!("🛑 GRACEFUL SHUTDOWN AUTHORIZED");
    println!("   Reason: {}", reason);
    println!("   Message: {}", message);
    println!("   Timeout: {} seconds", timeout_seconds);

    // Get node information for cleanup
    let node_id = blockchain.get_node_id();
    
    // Simple cleanup - just log the shutdown
    println!("🗑️  Node {} shutting down gracefully", node_id);

    // Start graceful shutdown process in background
    let blockchain_clone = blockchain.clone();
    tokio::spawn(async move {
        println!("[INFO][SHUTDOWN] starting graceful shutdown sequence...");
        
        // Wait for timeout period to allow current requests to complete
        tokio::time::sleep(tokio::time::Duration::from_secs(timeout_seconds)).await;
        
        // v5.0: Flush RocksDB before exit to prevent macroblock data loss
        let storage = blockchain_clone.get_storage();
        match storage.flush_all() {
            Ok(()) => println!("[INFO][SHUTDOWN] storage.flush_all() complete"),
            Err(e) => println!("[ERR][SHUTDOWN] storage.flush_all() failed: {}", e),
        }
        
        println!("[INFO][SHUTDOWN] node terminating");
        std::process::exit(0);
    });

    let current_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    println!("✅ Graceful shutdown initiated - node will terminate in {} seconds", timeout_seconds);

    Ok(warp::reply::json(&json!({
        "success": true,
        "message": "Graceful shutdown initiated",
        "node_id": node_id,
        "shutdown_in_seconds": timeout_seconds,
        "reason": reason,
        "timestamp": current_time
    })))
}

/// Handle activation codes query by wallet address for bridge-server
/// EXTENDED: node_type is now OPTIONAL - returns ALL nodes for wallet if omitted
pub(super) async fn handle_activations_by_wallet(
    mut params: HashMap<String, String>,
    wallet_hdr: Option<String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    println!("[ACTIVATIONS] 🔍 Querying activations by wallet");

    // Privacy: wallet may arrive via header (out of the URL); query stays as fallback.
    if let Some(w) = wallet_hdr.filter(|s| !s.is_empty()) { params.insert("wallet_address".to_string(), w); }

    // Extract parameters from query string
    let wallet_address = match params.get("wallet_address") {
        Some(addr) if !addr.is_empty() => addr.clone(),
        _ => {
            let error_response = json!({
                "exists": false,
                "error": "Missing or empty wallet_address parameter"
            });
            return Ok(warp::reply::json(&error_response));
        }
    };
    
    let phase = params.get("phase").and_then(|p| p.parse::<u8>().ok()).unwrap_or(1);
    let node_type = params.get("node_type").map(|v| v.to_string());
    
    // NEW: If node_type is NOT specified, return ALL nodes for this wallet
    if node_type.is_none() || node_type.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
        // v3.1: PRIMARY SOURCE - Read from blockchain storage (survives node offline)
        let storage = blockchain.get_storage();
        let storage_nodes = storage.get_nodes_by_wallet(&wallet_address).unwrap_or_default();
        
        // Storage is the single source: the RAM-side node registry it used to be merged with was a
        // second, unreplicated view of the same rows.
        let mut nodes: Vec<(String, String, u64)> = Vec::new();
        
        // Merkle reward_root claimable (single-source; legacy pending removed). 1 wallet = 1 node.
        let blockchain_pending = wallet_claimable_qnc(&blockchain, &wallet_address).await;
        
        // Add nodes from storage first (primary source)
        for (node_id, node_type_str, _rep) in &storage_nodes {
            // v3.18: Full nodes removed — only Light and Super
            let node_type = match node_type_str.as_str() {
                "light" | "super" => node_type_str.clone(),
                _ => {
                    println!("[WARN][API] unknown_node_type node={} type={}", node_id, node_type_str);
                    continue; // Skip unknown types
                }
            };
            nodes.push((node_id.clone(), node_type, blockchain_pending));
        }
        
        // CRITICAL FIX v2.76: Genesis nodes are NOT in node_ownership!
        // Check if this wallet matches any genesis node wallet
        // NO DUPLICATION: Use genesis_constants::GENESIS_WALLETS
        use crate::genesis_constants::GENESIS_WALLETS;
        
        for (bootstrap_id, genesis_wallet) in GENESIS_WALLETS.iter() {
            let genesis_id = format!("genesis_node_{}", bootstrap_id);
            if wallet_address == *genesis_wallet {
                // v3.34: Get pending from StateManager (1 wallet = 1 genesis node)
                nodes.push((genesis_id, "super".to_string(), blockchain_pending));
            }
        }
        
        if nodes.is_empty() {
            // v4.2: DO NOT return pending_activation records as nodes!
            // pending_activation means code was generated but node NOT yet activated.
            // Returning this caused mobile app to show "Activated" for non-existent nodes.
            // Only return truly registered/active nodes from blockchain storage + reward manager.
                    let response = json!({
                        "success": true,
                        "wallet_address": wallet_address,
                        "nodes": [],
                "message": "No active nodes found for this wallet"
                    });
                    return Ok(warp::reply::json(&response));
        }
        
        // v3.1: Get active nodes to determine REAL online status
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let active_nodes = if let Some(p2p) = blockchain.get_unified_p2p() {
            p2p.get_active_full_super_nodes()
        } else {
            Vec::new()
        };
        
        // Build nodes array with full info INCLUDING real online status
        let nodes_json: Vec<serde_json::Value> = nodes.iter().map(|(node_id, node_type, pending)| {
            // v3.18: Full node type removed - only Light and Super remain
            let type_str = node_type.as_str();
            
            // v3.1: Check REAL online status from active nodes list
            let (is_online, last_seen, status) = active_nodes.iter()
                .find(|(id, _, _)| id == node_id)
                .map(|(_, _, ls)| {
                    let online = now.saturating_sub(*ls) < 15 * 60; // Online if seen in last 15 min
                    let status = if online { "online" } else { "offline" };
                    (online, *ls, status)
                })
                .unwrap_or((false, 0, "offline")); // Not in active list = offline
            
            json!({
                "node_id": node_id,
                "node_type": type_str,
                "pending_rewards": pending,
                "status": status,
                "is_online": is_online,
                "last_seen": last_seen,
                "last_seen_ago_seconds": if last_seen > 0 { now.saturating_sub(last_seen) } else { 0 }
            })
        }).collect();
        
        let response = json!({
            "success": true,
            "wallet_address": wallet_address,
            "nodes": nodes_json,
            "total_nodes": nodes.len()
        });
        return Ok(warp::reply::json(&response));
    }
    
    // LEGACY: If node_type IS specified, use old behavior for backward compatibility
    let node_type_str = match node_type {
        Some(nt) => nt,
        None => {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "node_type parameter required for legacy query"
            })));
        }
    };
    
    // Initialize activation registry for blockchain query
    let registry = &*GLOBAL_ACTIVATION_REGISTRY;
    
    // Query blockchain for existing activation record
    match registry.query_activation_by_wallet_and_type(&wallet_address, phase, &node_type_str).await {
        Ok(Some(activation_code)) => {
            let response = json!({
                "exists": true,
                "activation_code": activation_code,
                "wallet_address": wallet_address,
                "phase": phase,
                "node_type": node_type_str,
                "reusable": true,
                "message": "Existing activation code found for this wallet and node type"
            });
            Ok(warp::reply::json(&response))
        }
        Ok(None) => {
            let response = json!({
                "exists": false,
                "wallet_address": wallet_address,
                "phase": phase,
                "node_type": node_type_str,
                "message": "No existing activation found for this wallet and node type"
            });
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            println!("[ACTIVATIONS] ❌ Query error: {}", e);
            let error_response = json!({
                "exists": false,
                "error": format!("Blockchain query failed: {}", e),
                "wallet_address": wallet_address,
                "phase": phase,
                "node_type": node_type_str
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

/// Handle activation code generation from burn transaction
pub(super) async fn handle_generate_activation_code(
    request: GenerateActivationCodeRequest,
    remote_addr: Option<std::net::SocketAddr>,
    _blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // SECURITY: Strict rate limiting for activation code generation (expensive operation)
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "activation") {
        return Ok(rate_limit_response);
    }

    // ONE phase resolver, ahead of everything that branches on a phase. It derives from the live 1DEV
    // supply — the same number the burn attestors sign — and NEVER from the request: the phase selects
    // which entry-price rule the on-chain NodeActivation is judged by, so an applicant choosing it is
    // choosing its own Sybil cost. Fail-closed on a supply-read outage; a request that declares a
    // different phase is rejected rather than silently corrected, because it would pay under one rule
    // and be recorded under the other.
    let pricing = match live_activation_pricing().await {
        Ok(p) => p,
        Err(e) => {
            println!("[ERROR][GENERATE] activation_price_unavailable err={}", e);
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": format!("Activation price unavailable: {}", e),
                "retryable": true
            })));
        }
    };
    if request.phase != pricing.phase {
        println!("[WARN][GENERATE] phase_mismatch declared={} network={}", request.phase, pricing.phase);
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": format!("Declared phase {} is not the network phase {}", request.phase, pricing.phase),
            "phase": pricing.phase
        })));
    }

    // SECURITY: Validate wallet addresses
    // Phase 1: wallet_address = Solana (burn), qnet_reward_wallet = EON (rewards) - REQUIRED
    // Phase 2: wallet_address = EON (burn + rewards)
    
    // Determine the QNet EON address for rewards (used for "1 wallet = 1 node" check)
    let qnet_wallet_for_rewards: String;
    
    if pricing.phase == 2 {
        // Phase 2: wallet_address is EON, used for everything
        if let Err(e) = validate_eon_address_with_error(&request.wallet_address) {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Invalid EON wallet address format",
                "details": e
            })));
        }
        qnet_wallet_for_rewards = request.wallet_address.clone();
    } else {
        // Phase 1: wallet_address is Solana (for burn), qnet_reward_wallet is EON (for rewards)
        
        // Validate Solana address (for burn verification)
        let is_valid_solana = request.wallet_address.len() >= 32 
            && request.wallet_address.len() <= 44
            && request.wallet_address.chars().all(|c| c.is_alphanumeric() && c != '0' && c != 'O' && c != 'I' && c != 'l');
        if !is_valid_solana {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Invalid Solana wallet address format for burn verification"
            })));
        }
        
        // REQUIRED: QNet EON address for rewards
        match &request.qnet_reward_wallet {
            Some(qnet_addr) => {
                if let Err(e) = validate_eon_address_with_error(qnet_addr) {
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "Invalid QNet EON reward wallet address",
                        "details": e,
                        "hint": "Phase 1 requires both Solana address (for burn) and QNet EON address (for rewards)"
                    })));
                }
                qnet_wallet_for_rewards = qnet_addr.clone();
            }
            None => {
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "Missing qnet_reward_wallet for Phase 1",
                    "hint": "Phase 1 requires 'qnet_reward_wallet' field with QNet EON address for rewards"
                })));
            }
        }
        
        println!("   QNet Reward Wallet: {}...", qnet_state::char_prefix(&qnet_wallet_for_rewards, 8));
    }
    
    // Validate node type
    // v3.18: Full nodes removed - only Light and Super allowed
    let valid_node_types = ["light", "super"];
    if !valid_node_types.contains(&request.node_type.to_lowercase().as_str()) {
        // Reject "full" node type
        if request.node_type.to_lowercase() == "full" {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Full node type removed in v3.18. Use Super node instead."
            })));
        }
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid node type. Must be: light or super"
        })));
    }
    
    println!("[GENERATE] 🔐 Generating activation code from burn transaction");
    println!("   Wallet: {}", qnet_state::char_prefix(&request.wallet_address, 8));
    println!("   Burn TX: {}", qnet_state::char_prefix(&request.burn_tx_hash, 8));
    println!("   Node Type: {}", request.node_type);
    println!("   Amount: {} {}", request.burn_amount, if pricing.phase == 1 { "1DEV" } else { "QNC" });
    println!("   Phase: {}", pricing.phase);

    // CRITICAL: Verify burn transaction actually exists on Solana/QNet blockchain
    match verify_burn_transaction_exists(&request.burn_tx_hash, &request.wallet_address, request.burn_amount, pricing.phase).await {
        Ok((false, _)) => {
            println!("❌ Burn transaction verification failed");
            let error_response = json!({
                "success": false,
                "error": "Burn transaction not found or invalid",
                "burn_tx_hash": request.burn_tx_hash,
                "wallet_address": request.wallet_address
            });
            return Ok(warp::reply::json(&error_response));
        }
        Err(e) => {
            println!("❌ Burn verification error: {}", e);
            let error_response = json!({
                "success": false,
                "error": format!("Burn verification failed: {}", e),
                "burn_tx_hash": request.burn_tx_hash
            });
            return Ok(warp::reply::json(&error_response));
        }
        Ok((true, _actual_burned)) => {
            println!("[INFO][GENERATE] burn_tx_verified_on_solana tx={}...",
                qnet_state::char_prefix(&request.burn_tx_hash, 16));
        }
    }
    
    // DYNAMIC PRICING — burn_amount MUST be >= the current activation price, so a user cannot
    // underpay and still get an XOR code. Phase and price come from the live 1DEV supply through
    // the canonical helper, the same number attestors sign, so a discounted tier is accepted.
    {
        let minimum_required = pricing.cost_for(&request.node_type);

        if request.burn_amount < minimum_required {
            println!("[WARN][GENERATE] insufficient_burn amount={} required={} phase={} burn_pct={:.1}",
                request.burn_amount, minimum_required, pricing.phase, pricing.burn_pct);
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": format!("Insufficient burn amount: {} provided, {} required",
                    request.burn_amount, minimum_required),
                "required_amount": minimum_required,
                "provided_amount": request.burn_amount,
                "phase": pricing.phase,
                "burn_percentage": pricing.burn_pct,
                "currency": pricing.currency(),
                "hint": format!("Current activation price is {} {}. Burn at least this amount.",
                    minimum_required, pricing.currency())
            })));
        }

        println!("[INFO][GENERATE] price_check_passed amount={} required={} phase={}",
            request.burn_amount, minimum_required, pricing.phase);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // v4.5: 1 wallet = 1 node — checked via PERSISTENT RocksDB, NOT in-memory!
    // Code generation is DETERMINISTIC from burn_tx_hash, so same burn → same code.
    // Recovery: just re-generate from same burn_tx_hash → identical code returned.
    // ═══════════════════════════════════════════════════════════════════════════════
    
    // 1 wallet = 1 node: Check PERSISTENT storage (RocksDB) — survives restarts!
    // Check BOTH Solana and EON addresses to prevent 2 nodes from same operator
    if let Some(storage) = crate::node::try_get_storage() {
        // Check 1: By QNet EON reward wallet
        match storage.get_nodes_by_wallet(&qnet_wallet_for_rewards) {
            Ok(nodes) if !nodes.is_empty() => {
                let (existing_node_id, existing_type, _rep) = &nodes[0];
                println!("[WARN][GENERATE] wallet_already_has_node wallet={}... node={} type={}",
                    qnet_state::char_prefix(&qnet_wallet_for_rewards, 16),
                    existing_node_id, existing_type);
                let response = json!({
                    "success": false,
                    "error": "This wallet already has an active node registered on blockchain",
                    "existing_node_type": existing_type,
                    "existing_node_id": existing_node_id,
                    "qnet_wallet": qnet_wallet_for_rewards,
                    "hint": "Each QNet wallet can only activate ONE node (Light or Super). Code is deterministic — use same burn_tx_hash to regenerate.",
                    "message": "1 wallet = 1 node rule enforced via persistent blockchain storage"
                });
                return Ok(warp::reply::json(&response));
            }
            _ => {}
        }
        // Check 2: By Solana wallet (in case light node was registered with Solana address)
        // Phase 1: wallet_address = Solana, qnet_reward_wallet = EON — check both
        if pricing.phase == 1 && request.wallet_address != qnet_wallet_for_rewards {
            match storage.get_nodes_by_wallet(&request.wallet_address) {
                Ok(nodes) if !nodes.is_empty() => {
                    let (existing_node_id, existing_type, _rep) = &nodes[0];
                    println!("[WARN][GENERATE] solana_wallet_already_has_node wallet={}... node={} type={}",
                        qnet_state::char_prefix(&request.wallet_address, 16),
                        existing_node_id, existing_type);
                    let response = json!({
                        "success": false,
                        "error": "This Solana wallet already has an active node registered on blockchain",
                        "existing_node_type": existing_type,
                        "existing_node_id": existing_node_id,
                        "solana_wallet": request.wallet_address,
                        "hint": "Each wallet can only activate ONE node (Light or Super).",
                        "message": "1 wallet = 1 node rule enforced (Solana address check)"
                    });
                    return Ok(warp::reply::json(&response));
                }
                _ => {}
            }
        }
        println!("[INFO][GENERATE] wallet_clean eon={}... solana={}... proceeding",
            qnet_state::char_prefix(&qnet_wallet_for_rewards, 16),
            qnet_state::char_prefix(&request.wallet_address, 16));
    } else {
        println!("[WARN][GENERATE] storage_unavailable skipping_1wallet1node_check");
    }

    // Generate quantum-secure activation code
    match generate_quantum_activation_code(&request).await {
        Ok(activation_code) => {
            println!("✅ Quantum activation code generated successfully");
            
            // Record in blockchain with secure hash
            let registry = &*GLOBAL_ACTIVATION_REGISTRY;
            let code_hash = registry.hash_activation_code_for_blockchain(&activation_code)
                .unwrap_or_else(|_| blake3::hash(activation_code.as_bytes()).to_hex().to_string());
            
            let node_info = crate::activation_validation::NodeInfo {
                activation_code: code_hash.clone(), // Use hash for secure blockchain storage
                wallet_address: qnet_wallet_for_rewards.clone(), // ALWAYS QNet EON address for rewards!
                device_signature: format!("generated_{}", chrono::Utc::now().timestamp()),
                node_type: request.node_type.clone(),
                activated_at: chrono::Utc::now().timestamp() as u64,
                last_seen: chrono::Utc::now().timestamp() as u64,
                migration_count: 0,
                node_id: String::new(), // Will be populated when node starts on server
                burn_tx_hash: request.burn_tx_hash.clone(), // CRITICAL: Store burn_tx for XOR decryption
                phase: pricing.phase,
                burn_amount: request.burn_amount, // CRITICAL: Store exact amount for XOR key derivation
            };

            if let Err(e) = registry.register_activation_on_blockchain(&activation_code, node_info).await {
                println!("⚠️ Blockchain registration warning: {}", e);
                // Continue anyway - user can still use the code
            }

            let response = json!({
                "success": true,
                "activation_code": activation_code,
                "wallet_address": request.wallet_address,
                "node_type": request.node_type,
                "phase": pricing.phase,
                "burn_tx_hash": request.burn_tx_hash,
                "generated_at": chrono::Utc::now().timestamp(),
                "permanent": true,
                "quantum_secure": true,
                "message": "Activation code generated successfully"
            });
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            println!("❌ Code generation failed: {}", e);
            let error_response = json!({
                "success": false,
                "error": format!("Code generation failed: {}", e),
                "wallet_address": request.wallet_address,
                "burn_tx_hash": request.burn_tx_hash
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// ON-CHAIN ACTIVATION VERIFICATION
// Mobile wallets MUST verify activation exists in current blockchain
// before showing node as active (prevents stale cache issues)
// ═══════════════════════════════════════════════════════════════

pub(super) async fn handle_verify_activation_onchain(
    mut params: HashMap<String, String>,
    wallet_hdr: Option<String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Privacy: wallet may arrive via header (out of the URL); query stays as fallback.
    if let Some(w) = wallet_hdr.filter(|s| !s.is_empty()) { params.insert("wallet_address".to_string(), w); }
    let wallet_address = match params.get("wallet_address") {
        Some(addr) if !addr.is_empty() => addr.clone(),
        _ => {
            return Ok(warp::reply::json(&json!({
                "verified": false,
                "error": "Missing wallet_address parameter"
            })));
        }
    };

    // Level 1: O(1) reverse index lookup in RocksDB (wallet → node_id)
    // Populated automatically when NodeRegistration and NodeActivation TXs are processed in blocks.
    // Survives restarts. This is the primary and fastest check.
    let storage = blockchain.get_storage();
    if let Ok(Some((node_id, node_type))) = storage.get_node_by_wallet(&wallet_address) {
        return Ok(warp::reply::json(&json!({
            "verified": true,
            "source": "storage_index",
            "node_id": node_id,
            "node_type": node_type,
            "wallet_address": wallet_address
        })));
    }

    // Level 2: Genesis wallet constants (hardcoded, O(1))
    use crate::genesis_constants::GENESIS_WALLETS;
    for (bootstrap_id, genesis_wallet) in GENESIS_WALLETS.iter() {
        if wallet_address == *genesis_wallet {
            return Ok(warp::reply::json(&json!({
                "verified": true,
                "source": "genesis_constants",
                "node_id": format!("genesis_node_{}", bootstrap_id),
                "node_type": "super",
                "wallet_address": wallet_address
            })));
        }
    }


    // Not found — wallet has no activation or registration on current blockchain
    let current_height = blockchain.get_height().await;
    Ok(warp::reply::json(&json!({
        "verified": false,
        "wallet_address": wallet_address,
        "current_height": current_height,
        "message": "No activation or registration found for this wallet"
    })))
}

/// PRODUCTION: Handle incoming P2P messages from network
pub(super) async fn handle_p2p_message(
    p2p_message: Value,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use crate::unified_p2p::NetworkMessage;

    // v10.0 SECURITY: Restrict to internal/known peers + rate limit
    let ip_str = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
    if !is_internal_ip(&ip_str) {
        println!("[WARN][RPC] p2p_message_rejected ip={} reason=external_ip", ip_str);
        return Ok(warp::reply::json(&json!({"error": "unauthorized", "message": "P2P endpoints are restricted to internal peers"})));
    }
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "consensus") {
        return Ok(rate_limit_response);
    }

    // Parse the P2P message
    let message_result = serde_json::from_value::<NetworkMessage>(p2p_message);
    
    match message_result {
        Ok(message) => {
            // SCALABILITY: Bound cache size, evict expired entries (>5min TTL)
            const MAX_IP_CACHE_SIZE: usize = 10000;
            if IP_TO_PSEUDONYM_CACHE.len() > MAX_IP_CACHE_SIZE {
                IP_TO_PSEUDONYM_CACHE.retain(|_, (_, ts)| ts.elapsed().as_secs() < 300);
            }

            // PRODUCTION: Extract peer IP using EXISTING pattern from peers endpoint
            let peer_addr = if let Some(addr) = remote_addr {
                let raw_ip = addr.ip().to_string();

                // OPTIMIZATION: Check cache first for O(1) lookup
                if let Some(cached) = IP_TO_PSEUDONYM_CACHE.get(&raw_ip) {
                    // Check TTL (5 minutes)
                    if cached.1.elapsed() < std::time::Duration::from_secs(300) {
                        cached.0.clone() // Return from cache
                    } else {
                        // Cache expired, remove and lookup again
                        drop(cached); // Release lock before removal
                        IP_TO_PSEUDONYM_CACHE.remove(&raw_ip);
                        
                        // Perform fresh lookup
                        let pseudonym = lookup_peer_pseudonym(&raw_ip).await;
                        
                        // Update cache
                        IP_TO_PSEUDONYM_CACHE.insert(raw_ip.clone(), (pseudonym.clone(), std::time::Instant::now()));
                        pseudonym
                    }
                } else {
                    // Not in cache - perform lookup
                    let pseudonym = lookup_peer_pseudonym(&raw_ip).await;
                    
                    // Store in cache for future use
                    IP_TO_PSEUDONYM_CACHE.insert(raw_ip.clone(), (pseudonym.clone(), std::time::Instant::now()));
                    pseudonym
                }
            } else {
                // IMPROVED: When no remote address available, use a timestamp-based identifier
                format!("node_unknown_{}", chrono::Utc::now().timestamp())
            };
            
            // Forward to P2P handler
            if let Some(p2p) = blockchain.get_unified_p2p() {
                // PRODUCTION DEBUG: Log message type for troubleshooting
                let msg_type = match &message {
                    NetworkMessage::Block { height, block_type, .. } => 
                        format!("{} block #{}", block_type, height),
                    #[allow(deprecated)]
                    NetworkMessage::EmergencyProducerChange { block_height, .. } =>
                        format!("EmergencyProducerChange at block #{} (deprecated)", block_height),
                    _ => "Other".to_string(),
                };
                println!("[P2P-RPC] 📨 Received {} from {}", msg_type, peer_addr);
                
                p2p.handle_message(&peer_addr, message);
                
                println!("[P2P-RPC] ✅ Processed P2P message from network");
                
                Ok(warp::reply::json(&json!({
                    "success": true,
                    "message": "P2P message processed successfully"
                })))
            } else {
                println!("[P2P-RPC] ❌ P2P system not available");
                Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "P2P system not available"
                })))
            }
        }
        Err(e) => {
            println!("[P2P-RPC] ❌ Failed to parse P2P message: {}", e);
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": format!("Invalid message format: {}", e)
            })))
        }
    }
}

/// OPTIMIZATION: Fast lookup for peer pseudonym with Genesis node fast path
pub(super) async fn lookup_peer_pseudonym(raw_ip: &str) -> String {
    // FAST PATH: Direct check for Genesis nodes - NO DUPLICATION!
    // Use genesis_constants::get_genesis_id_by_ip() for single source of truth
    use crate::genesis_constants::get_genesis_id_by_ip;
    if let Some(bootstrap_id) = get_genesis_id_by_ip(raw_ip) {
        return format!("genesis_node_{}", bootstrap_id);
    }
    
    // ARCHITECTURE FIX: For non-Genesis nodes, use blake3 hash for privacy
    // Peer registry removed (peer_registry_ no longer exists)
    // This ensures same IP always gets same privacy ID
    crate::unified_p2p::get_privacy_id_for_addr(raw_ip)
}

/// PRODUCTION: Extract peer IP address from HTTP request
#[allow(dead_code)]
pub(super) fn extract_peer_ip_from_request() -> Option<String> {
    // In full warp implementation, this would access request headers:
    // 1. X-Forwarded-For header (for proxied connections)
    // 2. X-Real-IP header (nginx/apache proxy)  
    // 3. Remote socket address (direct connections)
    
    // PRODUCTION: IP extraction logic for peer identification
    use std::env;
    
    // Check if we have a test IP set (for testing)
    if let Ok(test_ip) = env::var("QNET_TEST_PEER_IP") {
        return Some(test_ip);
    }
    
    // PRODUCTION: Extract real IP from HTTP headers
    // Note: This requires warp filter integration to access headers
    // For now, return None (real headers would be passed from warp filter)
    // The function extract_peer_ip_from_headers() below implements the real logic
    
    None // Headers not available in this context - would be passed from request filter
}


/// Wallet-derived Light pseudonym. Region-INDEPENDENT (fixed `mobile` segment): it is recomputed on
/// every node to resolve wallet→node, so it must not depend on a per-node env var. MUST match the app's
/// generateLightNodePseudonym: blake3("LIGHT_NODE_PRIVACY_"+wallet), first 16 hex (64-bit; P(collision)
/// ~3e-6 at 10M light — money-safe: reward crediting keys on wallet, not node_id). Wallet not recoverable.
pub fn generate_light_node_pseudonym(wallet_address: &str) -> String {
    let pseudonym_hash = blake3::hash(format!("LIGHT_NODE_PRIVACY_{}", wallet_address).as_bytes());
    format!("light_mobile_{}", &pseudonym_hash.to_hex()[..16])
}

/// Privacy-preserving stable pseudonym for regular Super nodes (mirrors the Light scheme; separate
/// domain so namespaces never collide).
///   format: super_node_<blake3("SUPER_NODE_PRIVACY_<wallet>")[..16]>
///   example: super_node_d1fa101f8b2c4e60
/// Replaces the old `node_<ip>` id which broke the heartbeat-validator
/// prefix whitelist (super_/light_/genesis_node_), tied identity to the
/// network address, and leaked the public IP.
/// Wallet not recoverable from pseudonym; same wallet -> same id across
/// restart/IP-migration/host-swap (reputation persists with the seed);
/// anti-Sybil (one wallet -> one id; each fake costs a fresh 1500 1DEV
/// burn); `super_` already validator-whitelisted. 64-bit space; P(collision)
/// ~7e-11 at 50k supers, ~3e-8 at 1M. O(1) (one Blake3 + hex truncate).
pub fn generate_super_node_pseudonym(wallet_address: &str) -> String {
    // PRODUCTION: domain-separated Blake3 hash — distinct from the Light
    // pseudonym domain above so a single wallet activating both tiers gets
    // independent pseudonyms in the two namespaces.
    let pseudonym_hash = blake3::hash(format!("SUPER_NODE_PRIVACY_{}", wallet_address).as_bytes());

    // Identity MUST be region-independent: it is recomputed on every node (the P2P
    // pre-activation sync gate compares this id), so it cannot depend on a per-node env
    // var — a region mismatch would make the same wallet resolve to two different ids and
    // the gate would never open. Fixed "node" segment preserves the historical format.
    format!("super_node_{}", &pseudonym_hash.to_hex()[..16])
}

/// Extract peer IP from HTTP headers (PRODUCTION ready)
#[allow(dead_code)]
pub(super) fn extract_peer_ip_from_headers(headers: &warp::http::HeaderMap) -> Option<String> {
    // Priority 1: X-Forwarded-For (handles proxy chains)
    if let Some(forwarded) = headers.get("x-forwarded-for") {
        if let Ok(forwarded_str) = forwarded.to_str() {
            // Take first IP (original client)
            let first_ip = forwarded_str.split(',').next()?.trim();
            if !first_ip.is_empty() && first_ip != "unknown" {
                return Some(first_ip.to_string());
            }
        }
    }
    
    // Priority 2: X-Real-IP (single proxy)
    if let Some(real_ip) = headers.get("x-real-ip") {
        if let Ok(ip_str) = real_ip.to_str() {
            if !ip_str.is_empty() && ip_str != "unknown" {
                return Some(ip_str.to_string());
            }
        }
    }
    
    // Priority 3: CF-Connecting-IP (Cloudflare)
    if let Some(cf_ip) = headers.get("cf-connecting-ip") {
        if let Ok(ip_str) = cf_ip.to_str() {
            return Some(ip_str.to_string());
        }
    }
    
    // No IP found in headers
    None
}

/// Extract burn amount from SPL token balance changes
/// Returns amount in smallest token units (with decimals)
pub(super) fn extract_burn_amount_from_token_balances(tx_data: &serde_json::Value) -> Result<u64, String> {
    // Parse postTokenBalances and preTokenBalances from transaction metadata
    let meta = tx_data.get("meta")
        .ok_or_else(|| "Transaction metadata not found".to_string())?;
    
    let pre_token_balances = meta.get("preTokenBalances")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "preTokenBalances not found".to_string())?;
    
    let post_token_balances = meta.get("postTokenBalances")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "postTokenBalances not found".to_string())?;
    
    // SECURITY: only the canonical 1DEV SPL mint counts toward the activation burn — without this
    // filter a burn of any worthless self-issued SPL token would pass the >=1 DEV check (free node).
    let onedev_mint = crate::network_config::get_onedev_mint();

    // Sum (pre - post) for 1DEV accounts ONLY, matching pre<->post by accountIndex+mint (Solana does
    // NOT guarantee pre/postTokenBalances share array order, so the old positional .zip() was unsafe).
    // Tokens that land on the incinerator are destroyed by convention, so that account's increase is
    // not a retained balance. Every other increase IS retained and must be netted out - otherwise a
    // movement between two accounts of one owner reads as a burn.
    const SOLANA_INCINERATOR: &str = "1nc1nerator11111111111111111111111111111111";
    let account_keys = tx_data.pointer("/transaction/message/accountKeys")
        .and_then(|v| v.as_array());
    let is_incinerator = |entry: &serde_json::Value| -> bool {
        if entry.get("owner").and_then(|v| v.as_str()) == Some(SOLANA_INCINERATOR) {
            return true;
        }
        let idx = match entry.get("accountIndex").and_then(|v| v.as_u64()) { Some(i) => i, None => return false };
        account_keys
            .and_then(|ks| ks.get(idx as usize))
            .and_then(|k| k.as_str().or_else(|| k.get("pubkey").and_then(|p| p.as_str())))
            == Some(SOLANA_INCINERATOR)
    };
    let amount_of = |entry: &serde_json::Value| -> u64 {
        entry.get("uiTokenAmount")
            .and_then(|v| v.get("amount"))
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
    };
    let onedev = |entry: &&serde_json::Value| -> bool {
        entry.get("mint").and_then(|m| m.as_str()) == Some(onedev_mint)
    };

    // Union of both sides: an account present only in post is a freshly created token account, i.e.
    // an increase from zero, which a pre-only walk cannot see.
    let mut indices: Vec<u64> = Vec::new();
    for e in pre_token_balances.iter().filter(onedev).chain(post_token_balances.iter().filter(onedev)) {
        if let Some(i) = e.get("accountIndex").and_then(|v| v.as_u64()) {
            if !indices.contains(&i) { indices.push(i); }
        }
    }

    let (mut destroyed, mut retained): (u64, u64) = (0, 0);
    for i in indices {
        let at = |arr: &[serde_json::Value]| -> Option<serde_json::Value> {
            arr.iter().find(|e| e.get("accountIndex").and_then(|v| v.as_u64()) == Some(i)
                && e.get("mint").and_then(|m| m.as_str()) == Some(onedev_mint)).cloned()
        };
        let pre_e = at(pre_token_balances);
        let post_e = at(post_token_balances);
        let pre_amount = pre_e.as_ref().map(amount_of).unwrap_or(0);
        let post_amount = post_e.as_ref().map(amount_of).unwrap_or(0);
        if pre_amount > post_amount {
            destroyed = destroyed.saturating_add(pre_amount - post_amount);
        } else if post_amount > pre_amount {
            let entry = post_e.or(pre_e);
            let to_burn_address = entry.as_ref().map(|e| is_incinerator(e)).unwrap_or(false);
            if !to_burn_address {
                retained = retained.saturating_add(post_amount - pre_amount);
            }
        }
    }

    let total_burned = destroyed.saturating_sub(retained);
    if crate::node::is_info() {
        println!("[INFO][BURN] onedev_net destroyed={} retained={} counted={}",
                 destroyed, retained, total_burned);
    }

    Ok(total_burned)
}

/// Verify burn transaction actually exists on blockchain
/// Returns (valid, actual_burned) where actual_burned is the ACTUAL on-Solana burned amount in whole
/// 1DEV units (0 on any false/early-exit path). Callers needing only validity use `.0`.
pub async fn verify_burn_transaction_exists(
    burn_tx_hash: &str,
    wallet_address: &str,  // v4.7: MUST be the Solana address that signed the burn TX
    burn_amount: u64,
    phase: u8,
) -> Result<(bool, u64), String> {
    verify_burn_transaction_exists_attempts(burn_tx_hash, wallet_address, burn_amount, phase, 3).await
}

/// Same, with an explicit retry budget. The relay/attestor path passes 1 so an unauthenticated caller
/// cannot multiply its request into several upstream Solana round-trips.
pub async fn verify_burn_transaction_exists_attempts(
    burn_tx_hash: &str,
    wallet_address: &str,
    burn_amount: u64,
    phase: u8,
    max_attempts: u8,
) -> Result<(bool, u64), String> {
    println!("[INFO][BURN] verify_burn_tx tx={}... wallet={}... amount={} phase={}",
        qnet_state::char_prefix(&burn_tx_hash, 16),
        qnet_state::char_prefix(&wallet_address, 16),
        burn_amount, phase);
    
    if phase == 1 {
        // Phase 1: Verify 1DEV burn on Solana
        let network_config = crate::network_config::get_network_config();
        let solana_rpc = &network_config.solana.rpc_url;
        
        // Build RPC request to get transaction details
        // jsonParsed encoding: instructions returned with parsed.type field (burn/burnChecked/transfer)
        // Required for burn indicator detection; account keys become objects {pubkey, signer, writable}
        let request_body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [
                burn_tx_hash,
                {
                    "encoding": "jsonParsed",
                    "commitment": "finalized",
                    "maxSupportedTransactionVersion": 0
                }
            ]
        });
        
        let client = reqwest::Client::new();

        // Solana devnet can take 5-15s to index a fresh transaction.
        // Retry up to 3 times with 6s delay before giving up.
        let attempts: u8 = max_attempts.max(1);
        const RETRY_DELAY_SECS: u64 = 6;

        let mut rpc_response: serde_json::Value = serde_json::Value::Null;
        let mut last_err: Option<String> = None;
        let mut confirmed = false;

        for attempt in 1..=attempts {
            match client
                .post(solana_rpc)
                .json(&request_body)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
            {
                Err(e) => {
                    last_err = Some(format!("Solana RPC request failed: {}", e));
                    println!("[WARN][BURN] solana_rpc_attempt={} err={}", attempt, last_err.as_ref().unwrap());
                }
                Ok(resp) if !resp.status().is_success() => {
                    last_err = Some(format!("Solana RPC returned error: {}", resp.status()));
                    println!("[WARN][BURN] solana_rpc_attempt={} http_err={}", attempt, last_err.as_ref().unwrap());
                }
                Ok(resp) => {
                    match resp.json::<serde_json::Value>().await {
                        Err(e) => {
                            last_err = Some(format!("Failed to parse Solana RPC response: {}", e));
                        }
                        Ok(parsed) => {
                            // If result is null → TX not indexed yet → retry
                            if parsed["result"].is_null() {
                                println!("[WARN][BURN] solana_tx_not_indexed_yet attempt={} tx={}...", 
                                    attempt, qnet_state::char_prefix(&burn_tx_hash, 16));
                                last_err = Some("Solana TX not indexed yet".to_string());
                            } else {
                                rpc_response = parsed;
                                confirmed = true;
                                break;
                            }
                        }
                    }
                }
            }

            if attempt < attempts {
                println!("[INFO][BURN] retrying_solana_check in {}s attempt={}/{}", RETRY_DELAY_SECS, attempt, attempts);
                tokio::time::sleep(tokio::time::Duration::from_secs(RETRY_DELAY_SECS)).await;
            }
        }

        if !confirmed {
            return Err(last_err.unwrap_or_else(|| "Solana RPC unavailable after retries".to_string()));
        }
            
        // Check if transaction exists and contains burn to incinerator
        if let Some(result) = rpc_response["result"].as_object() {
            if !result.contains_key("transaction") {
                println!("❌ Transaction not found on Solana");
                return Ok((false, 0));
            }
            
            // PRODUCTION: Verify burn details
            // Note: Solana RPC structure is { result: { transaction: {...}, meta: {...} } }
            let result_value = &rpc_response["result"];
            
            // 1. Verify transaction succeeded
            if let Some(meta) = result_value["meta"].as_object() {
                if let Some(err) = meta.get("err") {
                    if !err.is_null() {
                        println!("❌ Transaction failed on Solana: {:?}", err);
                        return Ok((false, 0));
                    }
                }
            }
            
            // 2. CRITICAL: Verify the fee payer / signer is the expected wallet
            // accountKeys[0] is always the fee payer (signer) in Solana transactions.
            // This prevents an attacker from using someone else's burn transaction.
            // jsonParsed: accountKeys = [{pubkey: "...", signer: bool, writable: bool}, ...]
            // json (legacy): accountKeys = ["...", "...", ...]
            let account_keys = result_value["transaction"]["message"]["accountKeys"]
                .as_array()
                .map(|keys| {
                    keys.iter()
                        .filter_map(|k| {
                            k.as_str()
                                .map(|s| s.to_string())
                                .or_else(|| k["pubkey"].as_str().map(|s| s.to_string()))
                        })
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default();
            
            if let Some(fee_payer) = account_keys.first() {
                if fee_payer != wallet_address {
                    println!("[ERROR][BURN] sender_mismatch fee_payer={} expected={}",
                        fee_payer, wallet_address);
                    return Err(format!(
                        "Burn transaction sender mismatch: TX was signed by {}, but registration wallet is {}. \
                         You must use the same wallet that burned the tokens.",
                        fee_payer, wallet_address
                    ));
                }
                println!("[INFO][BURN] sender_verified fee_payer={}", fee_payer);
            } else {
                println!("[WARN][BURN] no_account_keys — cannot verify sender");
                return Err("Cannot verify burn transaction sender: no account keys in TX".to_string());
            }
            
            // 3. Verify burn involves 1DEV token and/or incinerator address
            // Solana incinerator: 1nc1nerator11111111111111111111111111111111
            // 1DEV token mint: must match the known 1DEV SPL token address
            const SOLANA_INCINERATOR: &str = "1nc1nerator11111111111111111111111111111111";
            
            // Check if incinerator is in transaction accounts (transfer to burn address)
            let has_incinerator = account_keys.iter().any(|key| key == SOLANA_INCINERATOR);
            
            // Also check if this is a SPL Token burn instruction (burnChecked/burn)
            // SPL Token burns reduce supply without needing incinerator address
            let has_token_burn = if let Some(inner_instructions) = result_value["meta"]["innerInstructions"].as_array() {
                inner_instructions.iter().any(|inner| {
                    if let Some(instructions) = inner["instructions"].as_array() {
                        instructions.iter().any(|ix| {
                            // SPL Token program burn instruction
                            ix["parsed"]["type"].as_str() == Some("burn") ||
                            ix["parsed"]["type"].as_str() == Some("burnChecked")
                        })
                    } else {
                        false
                    }
                })
            } else {
                false
            };
            
            // Also check outer instructions for parsed burn. A plain `transfer` is NOT a burn — it only
            // counts when its destination is the incinerator (covered by has_incinerator below). Accepting
            // a bare transfer would let tokens moved to an attacker-controlled wallet pass as a burn.
            let has_outer_burn = if let Some(instructions) = result_value["transaction"]["message"]["instructions"].as_array() {
                instructions.iter().any(|ix| {
                    ix["parsed"]["type"].as_str() == Some("burn") ||
                    ix["parsed"]["type"].as_str() == Some("burnChecked")
                })
            } else {
                false
            };

            // Accept only a real SPL burn (burn/burnChecked) OR a transfer TO the incinerator address.
            if !has_incinerator && !has_token_burn && !has_outer_burn {
                println!("[ERROR][BURN] no_burn_indicator tx={}... accounts={:?}",
                    qnet_state::char_prefix(&burn_tx_hash, 16),
                    &account_keys[..account_keys.len().min(5)]);
                return Err(format!(
                    "Transaction {} does not contain a valid SPL Token burn instruction. \
                     A genuine token burn (createBurnInstruction / burnChecked) or transfer to the \
                     incinerator is required for node activation. Token transfers to other addresses are not accepted.",
                    qnet_state::char_prefix(&burn_tx_hash, 16)
                ));
            } else {
                println!("[INFO][BURN] burn_indicator_found incinerator={} token_burn={} outer_burn={}",
                    has_incinerator, has_token_burn, has_outer_burn);
            }
            
            // 3. CRITICAL: Verify exact burn amount from SPL Token balances
            // PRODUCTION: Parse postTokenBalances and preTokenBalances
            let actual_burned_amount = extract_burn_amount_from_token_balances(result_value)
                .map_err(|e| format!("Failed to extract burn amount: {}", e))?;
            
            if actual_burned_amount == 0 {
                println!("❌ No token burn detected in transaction");
                return Ok((false, 0));
            }
            
            // Convert burn_amount from request (1DEV units) to SPL token units (with decimals)
            // 1DEV token has 6 decimals, so 1 1DEV = 1_000_000 smallest units
            const ONEDEV_DECIMALS: u64 = 1_000_000; // 10^6
            let expected_exact_burn = burn_amount * ONEDEV_DECIMALS; // EXACT amount required
            
            // CRITICAL: NO TOLERANCE! Application burns EXACT amount as specified
            // Dynamic pricing: 1500 → 300 1DEV (decreases as more tokens burned)
            // Browser extension/app burns precise amount - must match exactly
            
            if actual_burned_amount < expected_exact_burn {
                println!("❌ Burned amount {} below expected {} (requested {} 1DEV)", 
                         actual_burned_amount, expected_exact_burn, burn_amount);
                return Err(format!(
                    "Insufficient burn: burned {} units, expected exactly {} units ({} 1DEV)",
                    actual_burned_amount, expected_exact_burn, burn_amount
                ));
            }
            
            if actual_burned_amount > expected_exact_burn {
                println!("ℹ️  Burned amount {} exceeds expected {} (user burned more than required)", 
                         actual_burned_amount, expected_exact_burn);
                // Not an error - user can burn more than required (but loses extra tokens)
            }
            
            println!("✅ Burn amount verified: {} units ({:.2} 1DEV)",
                     actual_burned_amount,
                     actual_burned_amount as f64 / ONEDEV_DECIMALS as f64);

            // Report the ACTUAL on-Solana burned amount in whole 1DEV units (consensus-attested truth).
            let actual_burned_1dev = actual_burned_amount / ONEDEV_DECIMALS;
            return Ok((true, actual_burned_1dev));
        }

        println!("❌ Invalid Solana RPC response format");
        Ok((false, 0))
    } else {
        // Phase 2: Verify QNC transfer to Pool 3 on QNet blockchain
        // Phase 2 activates after 90% of 1DEV supply burned — NOT REACHED YET
        // Will be implemented when Phase 2 is triggered (requires QNet mainnet Pool 3 contract)
        println!("[WARN][BURN] phase2_verification_not_implemented_yet phase=2");
        Err("Phase 2 activation (QNC Pool 3) is not yet available. Phase 1 (1DEV burn) is currently active.".to_string())
    }
}

// ===== MONITORING AND DIAGNOSTIC HANDLERS =====

/// Handle general statistics request
pub(super) async fn handle_stats(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    let height = blockchain.get_height().await;
    
    // Get network statistics
    let (total_peers, active_peers, network_tps) = if let Some(p2p) = blockchain.get_unified_p2p() {
        let peers = p2p.get_validated_active_peers();
        let total = peers.len();
        let active = p2p.get_peer_count() as usize;
        
        // Calculate network TPS from recent blocks
        // CRITICAL FIX: Use existing storage from blockchain node to avoid RocksDB lock
        let tps = {
            let storage = blockchain.get_storage();
            // Get last 10 blocks and calculate average TPS
                    let mut total_txs = 0u64;
                    let blocks_to_check = 10;
                    for i in 0..blocks_to_check {
                        let block_height = height.saturating_sub(i);
                        if block_height == 0 { break; }
                        
                        // v3.20: Use load_microblock_auto_format for EfficientMicroBlock support
                        if let Ok(Some(microblock)) = storage.load_microblock_auto_format(block_height) {
                            total_txs += microblock.transactions.len() as u64;
                        }
                    }
                    // Average TPS over last 10 seconds (10 blocks)
                    total_txs / blocks_to_check.max(1)
        };
        
        (total, active, tps)
    } else {
        (0, 0, 0)
    };
    
    // Get mempool stats
    let mempool_size = blockchain.get_mempool_size().await.unwrap_or(0);
    
    // Get node uptime (use a static start time for now)
    static NODE_START_TIME: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let uptime_seconds = NODE_START_TIME
        .get_or_init(|| std::time::Instant::now())
        .elapsed()
        .as_secs();
    
    let stats = json!({
        "network": {
            "height": height,
            "total_peers": total_peers,
            "active_peers": active_peers,
            "tps": network_tps,
            "phase": "production", // Unified phase - no special genesis handling
        },
        "node": {
            "id": blockchain.get_node_id(),
            "type": format!("{:?}", blockchain.get_node_type()),
            "uptime_seconds": uptime_seconds,
            "is_producer": blockchain.is_leader().await,
        },
        "mempool": {
            "size": mempool_size,
            "max_size": 5_000_000, // 5M TX mempool
        },
        "blockchain": {
            "microblock_interval": 1,
            "macroblock_interval": 90,
            "current_round": height / 30,
        },
        "timestamp": chrono::Utc::now().timestamp(),
    });
    
    Ok(warp::reply::json(&stats))
}

// ============================================================================
// PUBLIC CACHED ENDPOINTS
// ============================================================================

/// Cached public stats - updated every 10 minutes
/// Safe to call frequently from website - same data for everyone
pub(super) static PUBLIC_STATS_CACHE: Lazy<parking_lot::RwLock<(serde_json::Value, std::time::Instant)>> =
    Lazy::new(|| parking_lot::RwLock::new((json!({}), std::time::Instant::now() - std::time::Duration::from_secs(600))));

/// Handle public stats request (cached 10 minutes)
/// GET /api/v1/public/stats
pub(super) async fn handle_public_stats(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection (even cached endpoints)
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    const CACHE_TTL_SECS: u64 = 600; // 10 minutes
    
    // Check cache first
    {
        let cache = PUBLIC_STATS_CACHE.read();
        if cache.1.elapsed().as_secs() < CACHE_TTL_SECS {
            return Ok(warp::reply::json(&cache.0));
        }
    }
    
    // Cache expired - calculate new stats
    let height = blockchain.get_height().await;
    
    // Get node counts
    // v3.18: Full nodes removed - all server nodes are Super
    let (light_nodes, full_nodes, super_nodes) = if let Some(p2p) = blockchain.get_unified_p2p() {
        let peers = p2p.get_validated_active_peers();
        let light = peers.iter().filter(|p| p.node_type == crate::unified_p2p::NodeType::Light).count();
        // v3.18: full_nodes always 0 (Full node type removed)
        let super_n = peers.iter().filter(|p| p.node_type == crate::unified_p2p::NodeType::Super).count();
        (light, 0, super_n + 1) // +1 for self if Super, full_nodes = 0
    } else {
        (0, 0, 5) // Default: 5 Genesis nodes (all Super)
    };
    
    let total_nodes = light_nodes + super_nodes; // v3.18: full_nodes removed
    
    // Burn progress and phase from the last 1DEV supply read; both report null on an outage rather
    // than a fabricated 0% / Phase 1. `supply_age_seconds` tells the client how old that read is —
    // display endpoints never force a refresh, so the money path keeps the upstream budget.
    let pricing = live_activation_pricing_opt().await;
    let burn_percentage = pricing.as_ref().map(|p| p.burn_pct);
    let phase = pricing.as_ref().map(|p| p.phase);
    let supply_age = pricing.as_ref().map(|p| p.age_secs);

    // Native QNC removed from circulation via the canonical burn sink (an unspendable EON address):
    // clients compute circulating = total_supply − qnc_burned. Read-only; the sink can never be spent.
    let qnc_burned = blockchain.get_account(qnet_state::transaction::CANONICAL_BURN_ADDR).await
        .ok().flatten().map(|a| a.balance).unwrap_or(0);

    let stats = json!({
        "active_nodes": total_nodes,
        "light_nodes": light_nodes,
        "full_nodes": full_nodes,
        "super_nodes": super_nodes,
        "height": height,
        "phase": phase,
        "burn_percentage": burn_percentage,
        "supply_age_seconds": supply_age,
        "burn_address": qnet_state::transaction::CANONICAL_BURN_ADDR,
        "qnc_burned": qnc_burned,
        "cached_at": chrono::Utc::now().to_rfc3339(),
        "cache_ttl_seconds": CACHE_TTL_SECS
    });
    
    // Update cache
    {
        let mut cache = PUBLIC_STATS_CACHE.write();
        *cache = (stats.clone(), std::time::Instant::now());
    }
    
    Ok(warp::reply::json(&stats))
}

/// Handle activation price request (server calculates)
/// GET /api/v1/activation/price?type=super
pub(super) async fn handle_activation_price(
    params: HashMap<String, String>,
    _blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let node_type = params.get("type").map(|s| s.as_str()).unwrap_or("light");

    // The quote a wallet burns against. Fail closed on a supply outage: quoting the base tier here
    // makes the user over-burn irreversibly, and quoting a stale discount gets the burn rejected.
    let pricing = match live_activation_pricing().await {
        Ok(p) => p,
        Err(e) => {
            println!("[ERROR][PRICING] activation_price_unavailable err={}", e);
            return Ok(warp::reply::json(&json!({
                "error": format!("Activation price unavailable: {}", e),
                "retryable": true
            })));
        }
    };

    if pricing.phase == 1 {
        let price = pricing.phase1_cost;
        let savings = 1500u64.saturating_sub(price);
        let savings_percent = (savings as f64 / 1500.0 * 100.0).round() as u64;

        return Ok(warp::reply::json(&json!({
            "phase": 1,
            "node_type": node_type,
            "cost": price,
            "currency": "1DEV",
            "base_cost": 1500,
            "min_cost": 300,
            "burn_percentage": pricing.burn_pct,
            "savings": savings,
            "savings_percent": savings_percent,
            "mechanism": "burn",
            "universal_price": true // Same for all node types in Phase 1
        })));
    }

    // Phase 2: QNC pricing with the network-size multiplier, both from the shared price table.
    let nt = if node_type.eq_ignore_ascii_case("super") {
        qnet_state::account::NodeType::Super
    } else {
        qnet_state::account::NodeType::Light
    };
    let base_cost = qnet_state::transaction::phase2_base_qnc(&nt);
    let registered = crate::GLOBAL_REGISTERED_NODES.load(std::sync::atomic::Ordering::Relaxed);
    let final_cost = pricing.phase2_cost(node_type);

    Ok(warp::reply::json(&json!({
        "phase": 2,
        "node_type": node_type,
        "cost": final_cost,
        "currency": "QNC",
        "base_cost": base_cost,
        "registered_nodes": registered,
        "multiplier": qnet_state::transaction::phase2_size_mult_tenths(registered) as f64 / 10.0,
        "mechanism": "transfer_to_pool3",
        "universal_price": false
    })))
}

/// Handle failover history request
pub(super) async fn handle_failover_history(
    remote_addr: Option<std::net::SocketAddr>,
    params: HashMap<String, String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // FIX R25-M1: rate limit + access control on failover history
    if let Err(resp) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(resp);
    }

    let limit = params.get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100);
    
    let from_height = params.get("from_height")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    
    // Get real failover events from storage
    // CRITICAL FIX: Use existing storage from blockchain node to avoid RocksDB lock
    let failover_events = {
        let storage = blockchain.get_storage();
        match storage.get_failover_history(from_height, limit) {
                    Ok(events) => {
                        // Convert to JSON format
                        events.into_iter().map(|event| {
                            json!({
                                "height": event.height,
                                "failed_producer": event.failed_producer,
                                "emergency_producer": event.emergency_producer,
                                "reason": event.reason,
                                "timestamp": event.timestamp,
                                "block_type": event.block_type
                            })
                        }).collect::<Vec<_>>()
                    }
                    Err(e) => {
                        println!("[RPC] Failed to get failover history: {}", e);
                        Vec::new()
                    }
                }
    };
    
    // Get failover statistics if we have events
    // CRITICAL FIX: Use existing storage from blockchain node to avoid RocksDB lock
    let stats = if !failover_events.is_empty() {
        let storage = blockchain.get_storage();
        storage.get_failover_stats().unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };
    
    let failovers = json!({
        "failovers": failover_events,
        "total_count": failover_events.len(),
        "from_height": from_height,
        "limit": limit,
        "status": if failover_events.is_empty() { "no_failovers" } else { "success" },
        "statistics": stats,
        "message": if failover_events.is_empty() {
            "No failover events recorded yet - system running smoothly".to_string()
        } else {
            format!("{} failover events retrieved", failover_events.len())
        }
    });
    
    Ok(warp::reply::json(&failovers))
}

/// Handle producer status request
pub(super) async fn handle_producer_status(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    let current_height = blockchain.get_height().await;
    // CRITICAL FIX: Check if producer for NEXT block, not current state
    let is_leader = blockchain.is_next_block_producer().await;
    let node_id = blockchain.get_node_id();
    
    // CRITICAL FIX: Calculate round for NEXT block (current_height + 1)
    // API shows producer status for the NEXT block to be produced
    let next_height = current_height.saturating_add(1);
    let leadership_round = if next_height <= 30 {
        0u64  // Blocks 0-30 are round 0
    } else {
        next_height.saturating_sub(1) / 30
    };
    let next_rotation = leadership_round.saturating_add(1).saturating_mul(30).saturating_add(1);
    let blocks_until_rotation = next_rotation.saturating_sub(current_height);
    
    // CRITICAL FIX: Get current producer for next block (already calculated above)
    let current_producer = if let Some(p2p) = blockchain.get_unified_p2p() {
        // Use the same logic as in node.rs to determine current producer
        crate::node::BlockchainNode::select_microblock_producer(
            next_height,
            &Some(p2p.clone()),
            &node_id,
            blockchain.get_node_type(),
            Some(&blockchain.get_storage())
        ).await
    } else {
        node_id.to_string()  // Solo mode
    };
    
    // v4.0: Emergency producer removed - BFT Timeout Protocol handles failover
    // Producer selection is deterministic via certified_timeout_round
    
    // Resolve current producer's HTTP endpoint for direct TX routing
    // Clients can submit TXs directly to the producer to minimize confirmation latency
    let producer_endpoint = {
        let public_nodes = blockchain.get_all_public_api_nodes().await;
        public_nodes.into_iter()
            .find(|(nid, ..)| *nid == current_producer)
            .map(|(_, endpoint, ..)| endpoint)
            .unwrap_or_default()
    };
    
    let status = json!({
        "current_height": current_height,
        "is_producer": is_leader,
        "current_producer": current_producer,
        "producer_endpoint": producer_endpoint,  // Direct HTTP endpoint for TX submission
        "node_id": node_id,
        "leadership_round": leadership_round,
        "next_rotation_height": next_rotation,
        "blocks_until_rotation": blocks_until_rotation,
        "producer_selection_method": "deterministic_hash",
        "consensus_threshold": 70,
    });
    
    Ok(warp::reply::json(&status))
}

/// v6.0: Handle client-created NodeRegistration TX submission
/// Flow:
///   1. Client calls POST /api/v1/light-node/register  → gets node_id + registration_proof
///   2. Client creates TX, signs with wallet Ed25519 key
///   3. Client POSTs here (ideally to current producer for minimal latency)
///   4. Server verifies signature, adds to mempool, broadcasts to P2P
pub(super) async fn handle_node_registration_client_submit(
    req: NodeRegistrationClientRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "transaction") {
        return Ok(rate_limit_response);
    }

    // Only light nodes use client-side TX creation.
    // Super node registration is server-initiated (requires server-side authorization + staking).
    if req.node_type != "light" {
        if crate::node::is_warn() {
            println!("[WARN][NODE-REG-CLIENT] reject node={} reason=node_type_not_light", req.node_id);
        }
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Only light node self-registration is supported via this endpoint"
        })));
    }

    // Validate EON address: from and wallet_address must be identical
    if req.from != req.wallet_address {
        if crate::node::is_warn() {
            println!("[WARN][NODE-REG-CLIENT] reject node={} reason=from_ne_wallet", req.node_id);
        }
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "from and wallet_address must match"
        })));
    }
    if let Err(e) = validate_eon_address_with_error(&req.from) {
        if crate::node::is_warn() {
            println!("[WARN][NODE-REG-CLIENT] reject node={} reason=invalid_eon", req.node_id);
        }
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid wallet address",
            "details": e
        })));
    }

    // SECURITY check #1: node_id MUST be the wallet-derived pseudonym. node_id keys the on-chain
    // registry + the light-reward roster + the attestation-key commitment, so an unbound node_id would
    // let anyone register an arbitrary id for a wallet. The region prefix is a cosmetic privacy label
    // (per-node QNET_REGION), so we bind only the wallet-hash suffix — region-agnostic, deterministic.
    {
        let expected_suffix = blake3::hash(
            format!("LIGHT_NODE_PRIVACY_{}", req.wallet_address).as_bytes()
        ).to_hex();
        let suffix_ok = req.node_id.starts_with("light_")
            && req.node_id.rsplit('_').next() == Some(&expected_suffix[..16]);
        if !suffix_ok {
            if crate::node::is_warn() {
                println!("[WARN][NODE-REG-CLIENT] reject node={} reason=node_id_not_pseudonym", req.node_id);
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "node_id is not the wallet-derived pseudonym"
            })));
        }
    }

    // SECURITY check #2: proof-of-ownership of the burning Solana wallet. Every light node backs its
    // registration with a Solana 1DEV burn, so control of `burn_wallet` is the universal proof the
    // submitter is the real owner (works for native AND Solana-imported QNet wallets). Without this an
    // attacker could front-run a victim's first registration using the victim's PUBLIC burn_tx and
    // commit an attacker-owned Dilithium key as the victim's immutable attestation root.
    match (req.burn_wallet.as_deref().filter(|s| !s.is_empty()), req.owner_signature.as_deref()) {
        (Some(solana_wallet), Some(owner_sig)) if !owner_sig.is_empty() => {
            // Shared builder — block validation rebuilds the identical string from the TX, so the two
            // can never drift apart. The attestation root is bound in: for a Solana-derived wallet it is
            // the ONLY thing tying the submitted ML-DSA key to the burner's intent.
            let wire_pk = req.dilithium_public_key.as_deref()
                .and_then(|h| hex::decode(h).ok()).unwrap_or_default();
            let owner_msg = qnet_state::Transaction::burn_owner_bind_message(
                &req.node_id, &req.wallet_address, &req.registration_proof, req.timestamp, &wire_pk,
                req.burn_tx_hash.as_deref().unwrap_or(""));
            match crate::crypto::solana_derivation::verify_ed25519_signature(
                owner_msg.as_bytes(), owner_sig, solana_wallet
            ) {
                Ok(true) => {}
                _ => {
                    if crate::node::is_warn() {
                        println!("[WARN][NODE-REG-CLIENT] reject node={} reason=owner_signature_invalid", req.node_id);
                    }
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "owner_signature invalid — not the burning wallet's owner"
                    })));
                }
            }
        }
        _ => {
            if crate::node::is_warn() {
                println!("[WARN][NODE-REG-CLIENT] reject node={} reason=burn_wallet_or_owner_sig_missing", req.node_id);
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "burn_wallet + owner_signature required (proof of wallet ownership)"
            })));
        }
    }

    // SECURITY check #3: wallet_address (which DETERMINES node_id) must be DERIVED from a credential the
    // submitter provably controls. PURE DILITHIUM (F0.1): a native wallet derives from the ML-DSA-65 key
    // (control proven by the client_node_reg Dilithium signature verified below); a Solana-imported wallet
    // derives from burn_wallet (control proven by owner_signature above). Closes node_id squatting.
    let native_bound = req.dilithium_public_key.as_deref()
        .and_then(crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey)
        .as_deref() == Some(req.wallet_address.as_str());
    let solana_bound = req.burn_wallet.as_deref()
        .map(crate::crypto::solana_derivation::eon_from_solana_address)
        .as_deref() == Some(req.wallet_address.as_str());
    if !native_bound && !solana_bound {
        if crate::node::is_warn() {
            println!("[WARN][NODE-REG-CLIENT] reject node={} reason=wallet_not_derived", req.node_id);
        }
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "wallet_address not derived from dilithium_public_key or burn_wallet (ownership unproven)"
        })));
    }

    // Reject stale requests: timestamp must be within 5 minutes
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if now.abs_diff(req.timestamp) > 300 {
            if crate::node::is_warn() {
                println!("[WARN][NODE-REG-CLIENT] reject node={} reason=timestamp_stale skew={}s", req.node_id, now.abs_diff(req.timestamp));
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Request timestamp too old or too far in future (max 5 min)"
            })));
        }
    }

    // Build the on-chain NodeRegistration TX NOW (Light only; super is blocked above) so the SAME strict
    // verifier the producer/block-validator uses (verify_node_lifecycle_dilithium: raw detached sig
    // len==3309 + pk len==1952 over the canonical client_node_reg message) gates admission. This makes
    // the admission accept-set a SUBSET of the block-validation accept-set by construction — the asymmetry
    // that let a sig pass here and get poison-evicted at the producer is closed. Burn fields are stamped
    // after this gate (they are not part of the signed message).
    let mut reg_tx = crate::node::BlockchainNode::create_node_registration_tx_with_timestamp(
        &req.node_id,
        qnet_state::NodeType::Light,
        &req.wallet_address,
        &req.registration_proof,
        "",
        Some(req.timestamp),
    );
    // Mark client-signed so build_canonical_verify_message selects the client_node_reg preimage.
    reg_tx.data = Some(format!("client_node_reg:{}:{}:{}:",
        req.node_id, req.wallet_address, req.registration_proof));
    // FIX-5 wire: client sends HEX of the raw detached sig (3309 B) + raw pk (1952 B). A malformed hex
    // decodes to None → the gate below rejects (never a silent sig-less admission).
    if let Some(ref dil_sig) = req.dilithium_signature {
        reg_tx.dilithium_signature = hex::decode(dil_sig).ok();
    }
    if let Some(ref dil_pk) = req.dilithium_public_key {
        reg_tx.dilithium_public_key = hex::decode(dil_pk).ok();
    }

    // Signature gate — SAME verifier as the producer/block-validator. Native (Dilithium-derived) wallet:
    // the client_node_reg sig is MANDATORY. Solana-imported wallet: optional (authority = owner_signature
    // + 2f+1 burn quorum), but if present it must verify — mirroring the producer's `Some(sig)=>verify,_=>true`.
    let has_sig = reg_tx.dilithium_signature.as_deref().map_or(false, |s| !s.is_empty());
    if native_bound {
        if !has_sig || !crate::node::BlockchainNode::verify_node_lifecycle_dilithium(&reg_tx) {
            if crate::node::is_warn() {
                println!("[WARN][NODE-REG-CLIENT] reject node={} reason=dilithium_sig_invalid", req.node_id);
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "native registration requires a valid ML-DSA-65 signature (pure-PQ)"
            })));
        }
    } else if has_sig && !crate::node::BlockchainNode::verify_node_lifecycle_dilithium(&reg_tx) {
        if crate::node::is_warn() {
            println!("[WARN][NODE-REG-CLIENT] reject node={} reason=dilithium_sig_invalid", req.node_id);
        }
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "ML-DSA-65 signature verification failed"
        })));
    }

    // Early state-level check: reject already-registered nodes before mempool
    // This gives immediate feedback to the client and prevents mempool pollution
    {
        let state_mgr = blockchain.get_state_manager();
        let state = state_mgr.read().await;
        if state.is_node_registered(&req.node_id) {
            if crate::node::is_warn() {
                println!("[WARN][NODE-REG-CLIENT] reject node={} reason=already_registered", req.node_id);
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Node already registered",
                "node_id": req.node_id
            })));
        }
    }

    // Option A: embed the Solana 1DEV burn so this ON-CHAIN Light registration passes burn-attestation
    // (without it, burn_attestation_required=0 hard-rejects the empty-burn TX and light never lands on
    // chain). The registration_proof the client signed = blake3(burn_tx:node_id:wallet)[..32], so
    // recomputing it from the sent burn binds the burn to the signature — a swapped burn fails below.
    // The round committee (genesis era = the 5 genesis) attests the verified Solana burn; ≥quorum sigs
    // are embedded so verify_burn_attestation_quorum accepts on every node. The on-chain reg then
    // populates lrtr_ + the burn→wallet cbw binding (light Sybil control under consensus).
    if let (Some(burn_tx), Some(burn_amount), Some(solana_wallet)) = (
        req.burn_tx_hash.as_deref().filter(|s| !s.is_empty()),
        req.burn_amount.filter(|a| *a > 0),
        req.burn_wallet.as_deref().filter(|s| !s.is_empty()),
    ) {
        let proof_input = format!("{}:{}:{}", burn_tx, req.node_id, req.wallet_address);
        let proof_hash = blake3::hash(proof_input.as_bytes()).to_hex().to_string();
        if proof_hash.get(..32) != Some(req.registration_proof.as_str()) {
            if crate::node::is_warn() {
                println!("[WARN][NODE-REG-CLIENT] reject node={} reason=burn_proof_mismatch", req.node_id);
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "burn_tx_hash does not match the signed registration_proof"
            })));
        }
        // Local Phase-1 cost hint (advisory only); each attestor recomputes + signs its own value.
        // Through the single-flight cache: an uncached read here is one Solana round-trip per
        // registration attempt, i.e. an attacker-paced fan-out to one external endpoint.
        let cost_hint = match cached_solana_1dev_supply().await {
            Ok((tb, cs)) => qnet_state::Transaction::phase1_activation_cost(tb, cs),
            Err(_) => 0,
        };
        // The client-declared burn_amount is now only a hint; the embedded burn_amount is the
        // committee-certified agreed_amount (== what the counted 2f+1 signed), so an honest over-burn
        // still verifies. Exact-burn (declared == actual) ⇒ agreed_amount == burn_amount (unchanged).
        let storage_ref = crate::node::get_storage();
        // The client's owner_signature (verified above) travels to every attestor: an attestor refuses
        // to attest a burn whose owner did not authorize this beneficiary.
        let owner_sig_str = req.owner_signature.clone().unwrap_or_default();
        let reg_attest_tag = qnet_state::Transaction::attest_root_tag(
            reg_tx.dilithium_public_key.as_deref().unwrap_or(&[]));
        let owner_proof = crate::node::BurnOwnerProof {
            node_id: &req.node_id,
            registration_proof: &req.registration_proof,
            timestamp: req.timestamp,
            signature: &owner_sig_str,
            attest_root_tag: &reg_attest_tag,
        };
        let (attestors, agreed_cost, agreed_amount, agreed_epoch) = crate::node::BlockchainNode::collect_burn_attestations(
            burn_tx, solana_wallet, &req.wallet_address, burn_amount,
            qnet_state::NodeType::Light, cost_hint, &owner_proof, &**storage_ref,
        ).await;
        // Quorum of the committee OF agreed_epoch — the SAME committee the attestors signed for and the
        // on-chain verifier re-resolves (M-5), so `need` EXACTLY matches the verifier's threshold. Genesis
        // era ⇒ the genesis set; post-genesis None ⇒ this node can't read that epoch's N-2 committee ⇒
        // return retry-later rather than arm a registration the verifier rejects forever.
        let arm_genesis_era = agreed_epoch <= 2;
        let arm_rep_h = agreed_epoch.saturating_sub(1) * 90 + 1;
        let arm_committee_len = match crate::node::BlockchainNode::committee_for_height(&**storage_ref, arm_rep_h) {
            Some(c) => c.len(),
            None if arm_genesis_era => crate::genesis_constants::genesis_node_count(),
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][NODE-REG-CLIENT] reject node={} reason=committee_unavailable epoch={} (retryable)", req.node_id, agreed_epoch);
                }
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "burn-attestation committee unavailable (node syncing); retry shortly",
                    "epoch": agreed_epoch
                })));
            }
        };
        let need = qnet_consensus::checkpoint_bft::quorum_size(arm_committee_len);
        if attestors.len() < need {
            if crate::node::is_warn() {
                println!("[WARN][NODE-REG-CLIENT] reject node={} reason=burn_quorum_not_reached got={} need={} (retryable)", req.node_id, attestors.len(), need);
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "burn-attestation quorum not yet reached; retry shortly",
                "got": attestors.len(),
                "need": need,
                "cost": agreed_cost,
                "amount": agreed_amount
            })));
        }
        if let qnet_state::TransactionType::NodeRegistration {
            burn_tx: bt, burn_wallet: bw, burn_owner_sig: bos, burn_amount: ba, burn_cost: bc,
            burn_attestors: at, attest_epoch: ae, ..
        } = &mut reg_tx.tx_type {
            *bt = burn_tx.to_string();
            *bw = solana_wallet.to_string();
            // Carry the burner's authorization ON-CHAIN (verified above at admission, re-verified at
            // block validation) — the admission check alone is advisory, any node can craft the TX.
            *bos = req.owner_signature.clone().unwrap_or_default();
            *ba = agreed_amount;
            *bc = agreed_cost;
            *at = attestors;
            *ae = agreed_epoch;
        }
    }

    // Recalculate hash with updated fields
    reg_tx.hash = reg_tx.calculate_hash();

    let tx_hash = reg_tx.hash.clone();
    let tx_bytes = bincode::serialize(&reg_tx).unwrap_or_default();
    let mempool = blockchain.get_mempool();

    if mempool.add_binary_transaction(tx_bytes.clone(), tx_hash.clone(), 0) {
        println!("[INFO][NODE-REG-CLIENT] tx_added node={} wallet={}... hash={}...",
                 req.node_id,
                 qnet_state::char_prefix(&req.wallet_address, 16),
                 qnet_state::char_prefix(&tx_hash, 16));

        // Broadcast to all peers so the current producer includes it in the next block
        if let Some(p2p) = blockchain.get_unified_p2p() {
            let _ = p2p.broadcast_transaction(tx_bytes);
        }

        Ok(warp::reply::json(&json!({
            "success": true,
            "tx_hash": tx_hash,
            "node_id": req.node_id,
            "message": "NodeRegistration TX submitted successfully"
        })))
    } else {
        eprintln!("[WARN][NODE-REG-CLIENT] tx_add_failed node={}", req.node_id);
        Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Failed to add TX to mempool (duplicate or mempool full)"
        })))
    }
}

/// v9.4: Handle NodeReactivation TX submit (returning nodes re-enter eligible producers)
/// POST /api/v1/node-reactivation/submit
/// Creates NodeReactivation TX and adds to mempool + broadcasts.
pub(super) async fn handle_node_reactivation_submit(
    req: NodeReactivationRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "transaction") {
        return Ok(rate_limit_response);
    }

    // Validate node_id format
    if !req.node_id.starts_with("super_") && !req.node_id.starts_with("genesis_node_") {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Only Super/Genesis nodes can reactivate"
        })));
    }

    // v10.0 SECURITY: Verify requester owns the node via IP or signature
    // Only allow from internal/known IPs or if the node_id matches this node
    let remote_ip_str = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
    let is_local = is_internal_ip(&remote_ip_str);
    let is_self_node = {
        let self_node_id = blockchain.get_public_display_name();
        req.node_id == self_node_id
    };
    if !is_local && !is_self_node {
        // PURE DILITHIUM (F0.2): the old Ed25519 remote-reactivation proof bound no identity (any keypair
        // passed), so it was illusory. Remote reactivation for a DIFFERENT node is now rejected — a node
        // reactivates itself (is_self_node) or from an internal IP (is_local). Reactivation authenticity is
        // re-established at block-validation by the Layer-2 Dilithium check against the on-chain VRF key.
        println!("[WARN][RPC] reactivation_rejected node={} ip={} reason=remote_not_self",
                 req.node_id, remote_ip_str);
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Remote reactivation for another node is not supported (reactivate from the node itself)"
        })));
    }

    if req.last_macroblock_hash.is_empty() || req.last_macroblock_hash.len() < 16 {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid macroblock hash"
        })));
    }

    if req.current_height == 0 || req.last_macroblock_index == 0 {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "current_height and last_macroblock_index must be > 0"
        })));
    }

    // Endpoint to republish: the caller's explicit value, else this node's own configured endpoint.
    // Same validator the block-validity check runs, so a bad address is refused here instead of
    // being signed, gossiped and rejected network-wide.
    let api_endpoint = req.api_endpoint.clone().unwrap_or_else(|| {
        crate::node::BlockchainNode::self_public_api_endpoint(crate::node::NodeType::Super)
    });
    if let Err(e) = qnet_state::transaction::validate_public_api_endpoint(&api_endpoint) {
        println!("[REJECT][RPC] reactivation_bad_endpoint node={} err={}", req.node_id, e);
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": e
        })));
    }

    // Create NodeReactivation TX (sync, same pattern as NodeRegistration)
    let mut react_tx = crate::node::BlockchainNode::create_node_reactivation_tx(
        &req.node_id,
        req.current_height,
        &req.last_macroblock_hash,
        req.last_macroblock_index,
        &api_endpoint,
    );

    // Sign with pure ML-DSA-65 (ML-DSA-65) — the node's registered post-quantum identity key
    let wallet_identity = blockchain.get_wallet_identity();
    crate::node::BlockchainNode::sign_reactivation_tx(
        &mut react_tx,
        &req.node_id,
        wallet_identity.as_deref(),
    );

    let tx_hash = react_tx.hash.clone();
    let tx_bytes = bincode::serialize(&react_tx).unwrap_or_default();
    let mempool = blockchain.get_mempool();

    if mempool.add_binary_transaction(tx_bytes.clone(), tx_hash.clone(), react_tx.gas_price) {
        println!("[INFO][NODE-REACTIVATION] tx_added node={} h={} mb={} hash={}",
                 req.node_id, req.current_height, req.last_macroblock_index,
                 qnet_state::char_prefix(&tx_hash, 16));

        // Broadcast to all peers for fast inclusion
        if let Some(p2p) = blockchain.get_unified_p2p() {
            let _ = p2p.broadcast_transaction(tx_bytes);
        }

        Ok(warp::reply::json(&json!({
            "success": true,
            "tx_hash": tx_hash,
            "node_id": req.node_id,
            "message": "NodeReactivation TX submitted — node will re-enter eligible producers within 2-3 macroblocks"
        })))
    } else {
        Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Failed to add TX to mempool (duplicate or mempool full)"
        })))
    }
}

#[cfg(test)]
mod burn_amount_tests {
    use super::extract_burn_amount_from_token_balances;
    use serde_json::json;

    const INCIN: &str = "1nc1nerator11111111111111111111111111111111";

    fn tx(pre: serde_json::Value, post: serde_json::Value, keys: serde_json::Value) -> serde_json::Value {
        json!({
            "meta": { "preTokenBalances": pre, "postTokenBalances": post },
            "transaction": { "message": { "accountKeys": keys } }
        })
    }

    fn bal(idx: u64, mint: &str, amount: &str, owner: &str) -> serde_json::Value {
        json!({ "accountIndex": idx, "mint": mint, "owner": owner,
                "uiTokenAmount": { "amount": amount } })
    }

    // A real SPL burn lowers supply: the source drops and nothing anywhere gains.
    #[test]
    fn a_real_burn_counts_in_full() {
        let m = crate::network_config::get_onedev_mint();
        let t = tx(json!([bal(1, m, "1000", "ownerA")]),
                   json!([bal(1, m, "0", "ownerA")]),
                   json!(["prog", "acctA"]));
        assert_eq!(extract_burn_amount_from_token_balances(&t).unwrap(), 1000);
    }

    // Tokens parked on the incinerator are destroyed by convention, so its gain is not retained.
    #[test]
    fn a_transfer_to_the_incinerator_counts_in_full() {
        let m = crate::network_config::get_onedev_mint();
        let t = tx(json!([bal(1, m, "1000", "ownerA"), bal(2, m, "0", INCIN)]),
                   json!([bal(1, m, "0", "ownerA"), bal(2, m, "1000", INCIN)]),
                   json!(["prog", "acctA", "acctIncin"]));
        assert_eq!(extract_burn_amount_from_token_balances(&t).unwrap(), 1000);
    }

    // THE DEFECT THIS CLOSES: moving tokens between two accounts of one owner destroys nothing, so
    // it must count as nothing - the old sum-of-decreases read it as a full burn.
    #[test]
    fn a_transfer_between_own_accounts_counts_as_nothing() {
        let m = crate::network_config::get_onedev_mint();
        let t = tx(json!([bal(1, m, "1000", "ownerA"), bal(2, m, "0", "ownerA")]),
                   json!([bal(1, m, "0", "ownerA"), bal(2, m, "1000", "ownerA")]),
                   json!(["prog", "acctA", "acctB"]));
        assert_eq!(extract_burn_amount_from_token_balances(&t).unwrap(), 0);
    }

    // A destination account created inside the transaction appears only in post; a pre-only walk
    // could not see the gain at all.
    #[test]
    fn a_freshly_created_destination_is_still_a_gain() {
        let m = crate::network_config::get_onedev_mint();
        let t = tx(json!([bal(1, m, "1000", "ownerA")]),
                   json!([bal(1, m, "0", "ownerA"), bal(2, m, "1000", "ownerA")]),
                   json!(["prog", "acctA", "acctNew"]));
        assert_eq!(extract_burn_amount_from_token_balances(&t).unwrap(), 0);
    }

    // Another mint moving in the same transaction is irrelevant either way.
    #[test]
    fn another_mint_is_ignored() {
        let m = crate::network_config::get_onedev_mint();
        let t = tx(json!([bal(1, m, "1000", "ownerA"), bal(3, "OtherMint111", "9999", "ownerA")]),
                   json!([bal(1, m, "0", "ownerA"), bal(3, "OtherMint111", "0", "ownerA")]),
                   json!(["prog", "acctA", "x", "acctOther"]));
        assert_eq!(extract_burn_amount_from_token_balances(&t).unwrap(), 1000);
    }
}

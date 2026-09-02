//! Light-node registration, token refresh, ping challenge/response and the ping service.

use super::*;

pub(super) async fn handle_light_node_token_refresh(
    remote_addr: Option<std::net::SocketAddr>,
    req:         TokenRefreshRequest,
    blockchain:  Arc<BlockchainNode>,
) -> Result<impl warp::Reply, warp::Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};

    // Rate limit
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "light_node_token_refresh") {
        return Ok(rate_limit_response);
    }

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    // Timestamp within 5 minutes
    if now.abs_diff(req.timestamp) > 300 {
        return Ok(warp::reply::json(&serde_json::json!({
            "success": false, "error": "Request expired"
        })));
    }

    if req.node_id.is_empty() || req.device_token.is_empty() {
        return Ok(warp::reply::json(&serde_json::json!({
            "success": false, "error": "node_id and device_token required"
        })));
    }

    // PING DELEGATION v7.1: token-refresh auth is rooted in the node's Dilithium ping-delegation
    // chain (same proven pattern as the `ping_dilithium:` arm in verify_light_node_ping), NOT the
    // RAM-poisonable Ed25519 gossip pubkey. The delegation cert is verified against the IMMUTABLE
    // on-chain key (load_vrf_public_key), so an attacker who poisons the RAM registry cannot forge
    // this node's token-refresh. Fail-closed at every missing/mismatch step.
    // Request signature format: "ping_dilithium:<dilithium_sig>".
    if !req.signature.starts_with("ping_dilithium:") {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] token_refresh_bad_sig_prefix node={}", req.node_id);
        }
        return Ok(warp::reply::json(&serde_json::json!({
            "success": false, "error": "Invalid signature"
        })));
    }
    let inner_sig = &req.signature[15..]; // Skip "ping_dilithium:" prefix

    // C: ping keys live in the dedicated CF (point-read), not the trimmed RAM registry.
    let (ping_pk_hex, delegation_cert) = match blockchain.get_storage().get_light_ping_keys(&req.node_id) {
        Some(kv) => kv,
        None => {
            return Ok(warp::reply::json(&serde_json::json!({
                "success": false, "error": "Node not found or missing ping delegation"
            })));
        }
    };

    if ping_pk_hex.is_empty() || delegation_cert.is_empty() {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] token_refresh_ping_delegation_missing node={}", req.node_id);
        }
        return Ok(warp::reply::json(&serde_json::json!({
            "success": false, "error": "Node not found or missing ping delegation"
        })));
    }

    // Load the IMMUTABLE on-chain Dilithium key; fail-closed on None/err.
    let onchain_pk_hex = match blockchain.get_storage().load_vrf_public_key(&req.node_id) {
        Ok(Some(bytes)) => hex::encode(bytes),
        _ => {
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] token_refresh_no_onchain_key node={}", req.node_id);
            }
            return Ok(warp::reply::json(&serde_json::json!({
                "success": false, "error": "Invalid signature"
            })));
        }
    };

    // Step 1: Verify the delegation cert authorizing ping_pubkey, against the on-chain key.
    let delegation_msg = format!("delegate_ping:{}:{}", ping_pk_hex, req.node_id);
    if !verify_mobile_dilithium_signature(&delegation_msg, &delegation_cert, &onchain_pk_hex) {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] token_refresh_delegation_cert_invalid node={}", req.node_id);
        }
        return Ok(warp::reply::json(&serde_json::json!({
            "success": false, "error": "Invalid signature"
        })));
    }

    // Step 2: Verify the token-refresh signature against the authorized ping_pubkey.
    // Message string MUST stay byte-identical to what the mobile signs.
    let message = format!("token_refresh:{}:{}", req.node_id, req.timestamp);
    if !verify_mobile_dilithium_signature(&message, inner_sig, &ping_pk_hex) {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] token_refresh_bad_sig node={}", req.node_id);
        }
        return Ok(warp::reply::json(&serde_json::json!({
            "success": false, "error": "Invalid signature"
        })));
    }

    let pt = match req.push_type.as_str() {
        "unifiedpush" => "unifiedpush",
        "polling"     => "polling",
        _             => "fcm",
    };

    // LWW record: an unchanged triple keeps its original stamp; a changed one is stamped now
    // by this (serving) genesis — the ordering authority for the update. The peer fan-out runs
    // in BOTH cases: the old unchanged-skip also skipped the sync, so a peer that missed the
    // original update (the shard-owner pinger included) stayed stale forever.
    let stored = blockchain.get_storage().get_fcm_record(&req.node_id);
    let unchanged = stored.as_ref().map(|(t, p, e, _)|
        t == &req.device_token && p == pt && e.as_deref() == req.endpoint.as_deref()
    ).unwrap_or(false);
    // Monotonic bump past the stored stamp: a genuinely newer event must supersede even
    // when this genesis's clock lags the one that stamped the old record.
    let record_ts = if unchanged {
        stored.as_ref().map(|r| r.3).unwrap_or(now)
    } else {
        std::cmp::max(now, stored.as_ref().map(|r| r.3.saturating_add(1)).unwrap_or(now))
    };

    if !unchanged {
        if let Err(e) = blockchain.get_storage().save_fcm_token(
            &req.node_id, &req.device_token, pt, req.endpoint.as_deref(), record_ts,
        ) {
            println!("[WARN][LIGHT] token_refresh_save_failed node={} err={}", req.node_id, e);
            return Ok(warp::reply::json(&serde_json::json!({
                "success": false, "error": "Storage error"
            })));
        }
        if let Some(p2p) = blockchain.get_unified_p2p() {
            p2p.update_light_node_push_type(&req.node_id, pt, now);
        }
        if crate::node::is_info() {
            println!("[INFO][LIGHT] token_refreshed node={} push={}", req.node_id, pt);
        }
    } else if crate::node::is_debug() {
        println!("[DBG][LIGHT] token_refresh_unchanged node={} resync_peers=true", req.node_id);
    }

    // Sync to peer genesis nodes (fire-and-forget), carrying the record's authoritative ts.
    // Unchanged-record rebroadcasts (anti-stale heal) are bounded to one per node per hour.
    fn fanout_dedup() -> &'static dashmap::DashMap<String, u64> {
        static M: std::sync::OnceLock<dashmap::DashMap<String, u64>> = std::sync::OnceLock::new();
        M.get_or_init(dashmap::DashMap::new)
    }
    let skip_fanout = unchanged && fanout_dedup().get(&req.node_id)
        .map(|t| now.saturating_sub(*t.value()) < 3600).unwrap_or(false);
    if !skip_fanout {
        if fanout_dedup().len() > 65_536 { fanout_dedup().clear(); }
        fanout_dedup().insert(req.node_id.clone(), now);
        use crate::genesis_constants::GENESIS_NODE_IPS;
        let node_id_clone = req.node_id.clone();
        let token_clone = req.device_token.clone();
        let pt_clone = pt.to_string();
        let ep_clone = req.endpoint.clone();
        let our_ip = {
            let bid = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or_default();
            GENESIS_NODE_IPS.iter().find(|(_, id)| *id == bid)
                .map(|(ip, _)| ip.to_string()).unwrap_or_default()
        };
        tokio::spawn(async move {
            sync_fcm_token_to_genesis_peers(&node_id_clone, &token_clone, &pt_clone, ep_clone.as_deref(), &our_ip, record_ts).await;
        });
    }

    Ok(warp::reply::json(&serde_json::json!({
        "success": true, "updated": !unchanged
    })))
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct LightNodeRegisterRequest {
    pub(super) node_id: String,
    pub(super) wallet_address: String,
    #[serde(default)]
    pub(super) device_token: String,              // FCM token (optional if using UnifiedPush)
    pub(super) device_id: String,
    pub(super) quantum_pubkey: String,
    pub(super) quantum_signature: String,
    #[serde(default)]
    pub(super) push_type: Option<String>,         // "fcm" | "unifiedpush" | "polling"
    #[serde(default)]
    pub(super) unified_push_endpoint: Option<String>,  // UnifiedPush URL (e.g., https://ntfy.sh/xxx)
    #[serde(default)]
    pub(super) burn_tx_hash: Option<String>,      // v4.3: Solana burn TX hash for STATELESS code verification
    #[serde(default)]
    pub(super) burn_amount: Option<u64>,          // v4.3: Burn amount for XOR key reconstruction
    #[serde(default)]
    pub(super) burn_wallet: Option<String>,       // v4.6: Solana address used for code generation (Phase 1)
                                       // XOR verification uses this, NOT wallet_address (which is EON for rewards)
    #[serde(default)]
    pub(super) ed25519_signature: Option<String>,  // v4.7: Ed25519 signature proving ownership of burn_wallet
                                        // Message: "qnet_register:{activation_code}:{timestamp}"
                                        // Signed with Solana private key (same key that burned tokens)
    #[serde(default)]
    pub(super) signature_timestamp: Option<u64>,   // v4.7: Timestamp used in signature message (prevents replay)
    // PING DELEGATION v7.1: Dedicated ML-DSA-65 ping key for background pings.
    // ping_pubkey is a separate ML-DSA-65 pubkey (3904 hex) or legacy Ed25519 (64 hex),
    // stored in device Keychain (AFTER_FIRST_UNLOCK). ping_delegation_cert is ML-DSA-65
    // signature of "delegate_ping:{ping_pubkey}:{node_pseudonym}" by the wallet quantum key.
    #[serde(default)]
    pub(super) ping_pubkey: Option<String>,           // 3904 hex (ML-DSA-65) or 64 hex (legacy Ed25519)
    #[serde(default)]
    pub(super) ping_delegation_cert: Option<String>,  // ML-DSA-65 sig of "delegate_ping:{ping_pubkey}:{node_id}"
}

pub(super) async fn handle_light_node_register(
    register_request: LightNodeRegisterRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    // SECURITY: IP-based rate limiting for Light node registration
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "light_node_register") {
        return Ok(rate_limit_response);
    }

    // SECURITY: Per-wallet failed-attempt rate limit (anti-bruteforce for activation codes).
    // Max 5 failed attempts per wallet per 10 minutes, regardless of IP.
    {
        let wallet = &register_request.wallet_address;
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        const WINDOW: u64 = 600; // 10 minutes
        const MAX_FAILS: usize = 5;

        // READ-ONLY check. Creating an entry here would let unauthenticated requests with distinct
        // wallet strings grow the map without bound; entries exist only for wallets that actually failed.
        let recent_fails = WALLET_REG_FAIL_TIMESTAMPS.get(wallet)
            .map(|e| e.iter().filter(|&&ts| now_secs.saturating_sub(ts) < WINDOW).count())
            .unwrap_or(0);
        if recent_fails >= MAX_FAILS {
            println!("[WARN][LIGHT] wallet_rate_limited wallet={}...", qnet_state::char_prefix(&wallet, 16));
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Too many failed registration attempts. Please wait 10 minutes before retrying.",
                "retry_after_seconds": WINDOW
            })));
        }
    }

    // SECURITY: Validate QNet EON wallet address format
    // Rewards MUST go to valid EON address - prevents loss of funds!
    if let Err(e) = validate_eon_address_with_error(&register_request.wallet_address) {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid QNet EON wallet address",
            "details": e,
            "hint": "Wallet address must be in EON format: {19 hex}eon{15 hex}{8 checksum} = 45 chars"
        })));
    }

    // Already-registered wallet re-registering = a RETURN, not a fresh activation: a plain restore
    // (node still active) or a reactivation after a drop / wallet-restore ping-key rotation. Detect it
    // O(1) up front so we skip the heavy burn re-verification below, yet still fall through to re-verify
    // the identity signature, refresh the ping key, and gossip is_active=true — which reaches the
    // shard-owner genesis (sole holder of the non-gossiped drop) so it reactivates and resumes pinging.
    // No new on-chain TX is created (see the tx_required=false return).
    let mut reactivating_existing = false;
    {
        let pseudonym = generate_light_node_pseudonym(&register_request.wallet_address);
        let registered_on_chain = {
            let state_mgr = blockchain.get_state_manager();
            let state = state_mgr.read().await;
            state.is_node_registered(&pseudonym)
        };
        let registered_in_gossip = LIGHT_NODE_REGISTRY.lock().contains_key(&pseudonym);
        if registered_on_chain || registered_in_gossip {
            // SECURITY: reactivation/ping-key rotation may run ONLY if the caller proves the node's
            // established identity. The quantum keypair is activation-derived (immutable), so the legit
            // owner presents the pubkey already committed as the node's VRF key. The mobile Dilithium sig
            // opens over the PUBLIC wallet_address (forgeable with any key), so we bind here: incoming
            // quantum_pubkey MUST equal the committed VRF key. Match → reactivate (skip burn re-verify).
            // Mismatch or key-not-yet-committed-here → mutate nothing, return already_registered inertly
            // (a synced genesis — the shard owner always is — performs the real reactivation).
            let identity_ok = hex::decode(&register_request.quantum_pubkey).ok()
                .zip(blockchain.get_storage().load_vrf_public_key(&pseudonym).ok().flatten())
                .map(|(incoming, committed)| incoming == committed)
                .unwrap_or(false);
            if identity_ok {
                reactivating_existing = true;
                println!("[INFO][LIGHT] reactivation_on_register pseudonym={}", pseudonym);
            } else {
                let (next_ping_time, window_number) = crate::unified_p2p::SimplifiedP2P::get_next_ping_time(&pseudonym);
                println!("[INFO][LIGHT] registration_rejected reason=already_registered pseudonym={}", pseudonym);
                return Ok(warp::reply::json(&json!({
                    "success": true,
                    "already_registered": true,
                    "node_id": pseudonym,
                    "node_type": "light",
                    "next_ping_time": next_ping_time,
                    "next_ping_window": window_number,
                    "message": "Node already registered. Your existing node has been restored."
                })));
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // v4.5: PURE STATELESS VERIFICATION — code is self-contained!
    // Code = XOR(wallet_prefix, SHA3(burn_tx_hash:node_type:burn_amount))
    // To verify: reconstruct XOR key from burn data → decrypt → compare wallet.
    // NO in-memory registry needed. NO node state needed. Code IS the proof.
    // burn_tx_hash + burn_amount are MANDATORY (sent from mobile AsyncStorage).
    // Skipped for an already-registered RETURN: the burn was verified at the original registration and
    // the node is on-chain; re-registration only refreshes the ping key + reactivates. Identity is
    // still proven by the mandatory Dilithium gossip signature below.
    // ═══════════════════════════════════════════════════════════════════════════════
    if !reactivating_existing {
        let registry = &*GLOBAL_ACTIVATION_REGISTRY;
        let code = &register_request.node_id;
        let wallet = &register_request.wallet_address;
        
        // v4.6: XOR verification uses the wallet that GENERATED the code
        // Phase 1: code was generated with Solana address → burn_wallet = Solana
        // Phase 2: code was generated with EON address → burn_wallet = EON = wallet_address
        // If burn_wallet not provided, fallback to wallet_address (backward compat)
        let xor_wallet = register_request.burn_wallet.as_deref()
            .filter(|w| !w.is_empty())
            .unwrap_or(wallet);
        
        // burn_tx_hash is REQUIRED — no fallback to in-memory
        let burn_tx = match &register_request.burn_tx_hash {
            Some(tx) if !tx.is_empty() => tx.as_str(),
            _ => {
                println!("[WARN][LIGHT] registration_rejected reason=missing_burn_tx_hash wallet={}...",
                    qnet_state::char_prefix(&wallet, 16));
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "burn_tx_hash is required for node registration",
                    "hint": "Include burn_tx_hash and burn_amount from your activation metadata"
                })));
            }
        };
        let burn_amount = register_request.burn_amount.unwrap_or(0);
        if burn_amount == 0 {
            println!("[WARN][LIGHT] registration_rejected reason=missing_burn_amount wallet={}...",
                qnet_state::char_prefix(&wallet, 16));
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "burn_amount is required for node registration",
                "hint": "Include burn_amount (e.g. 1500) from your activation metadata"
            })));
        }
        
        // STEP 1: Stateless XOR decryption — verify code belongs to the burn wallet
        // XOR key = SHA3(burn_tx:type:burn_amount), encrypted wallet = first 5 bytes of burn_wallet
        match registry.verify_code_ownership_stateless(code, xor_wallet, burn_tx, burn_amount) {
            Ok(true) => {
                println!("[INFO][LIGHT] code_verified method=stateless_xor wallet={}...",
                    qnet_state::char_prefix(&wallet, 16));
            }
            Ok(false) => {
                println!("[WARN][LIGHT] code_rejected method=stateless_xor wallet={}... code={}...",
                    qnet_state::char_prefix(&wallet, 16), qnet_state::char_prefix(&code, 12));
                // Record failed attempt for per-wallet rate limiting
                record_wallet_reg_failure(wallet);
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "Activation code does not belong to this wallet (XOR mismatch)",
                    "hint": "Code is cryptographically bound to wallet via burn transaction"
                })));
            }
            Err(e) => {
                println!("[WARN][LIGHT] stateless_verify_failed wallet={}... err={}",
                    qnet_state::char_prefix(&wallet, 16), e);
                record_wallet_reg_failure(wallet);
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
            let sig_hex = match &register_request.ed25519_signature {
                Some(s) if !s.is_empty() => s.as_str(),
                _ => {
                    println!("[WARN][LIGHT] registration_rejected reason=missing_ed25519_signature wallet={}...",
                        qnet_state::char_prefix(&wallet, 16));
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "Ed25519 signature is required for node registration",
                        "hint": "Sign message 'qnet_register:{code}:{timestamp}' with your Solana private key"
                    })));
                }
            };
            let sig_timestamp = register_request.signature_timestamp.unwrap_or(0);
            
            // Check timestamp freshness (within 5 minutes)
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            if now.abs_diff(sig_timestamp) > 300 {
                println!("[WARN][LIGHT] registration_rejected reason=stale_signature ts={} now={}", sig_timestamp, now);
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "Signature timestamp is too old or too far in the future (max 5 min)",
                    "hint": "Generate a fresh signature with current timestamp"
                })));
            }
            
            let message = format!("qnet_register:{}:{}", code, sig_timestamp);
            match crate::crypto::solana_derivation::verify_ed25519_signature(
                message.as_bytes(), sig_hex, xor_wallet
            ) {
                Ok(true) => {
                    println!("[INFO][LIGHT] ed25519_sig_verified solana_wallet={}...",
                        qnet_state::char_prefix(&xor_wallet, 16));
                }
                Ok(false) => {
                    println!("[WARN][LIGHT] ed25519_sig_invalid solana_wallet={}...",
                        qnet_state::char_prefix(&xor_wallet, 16));
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "Ed25519 signature verification failed — you are not the wallet owner",
                        "hint": "Sign with the Solana private key that burned tokens"
                    })));
                }
                Err(e) => {
                    println!("[ERROR][LIGHT] ed25519_verify_err err={}", e);
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
                println!("[INFO][LIGHT] burn_verified tx={}... sender={} amount={}",
                    qnet_state::char_prefix(&burn_tx, 16),
                    qnet_state::char_prefix(&xor_wallet, 16),
                    burn_amount);
            }
            Ok((false, _)) => {
                println!("[WARN][LIGHT] burn_not_found tx={}...", qnet_state::char_prefix(&burn_tx, 16));
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "Burn transaction not found or insufficient amount on Solana",
                    "required_amount": burn_amount,
                    "burn_tx_hash": burn_tx
                })));
            }
            Err(e) => {
                println!("[ERROR][LIGHT] burn_verify_err tx={}... err={}", 
                    qnet_state::char_prefix(&burn_tx, 16), e);
                // v4.7: Solana verification is MANDATORY — no more "allow with XOR proof" bypass
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": format!("Burn verification failed: {}", e),
                    "burn_tx_hash": burn_tx,
                    "hint": "Ensure burn_tx_hash is valid and Solana RPC is reachable"
                })));
            }
        }
        
        // v4.5: DYNAMIC PRICING — verify burn_amount >= current activation price
        // Prevents underpaying (user burns 300 when price is 1500)
        {
            // Phase and price come from the ONE canonical resolver — the same value attestors
            // recompute and sign, so admission cannot disagree with attestation. A supply-read
            // failure is a retryable error, never a silent default.
            let pricing = match live_activation_pricing().await {
                Ok(p) => p,
                Err(e) => {
                    println!("[ERROR][LIGHT] activation_price_unavailable err={}", e);
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": format!("Activation price unavailable: {}", e),
                        "retryable": true
                    })));
                }
            };
            let current_phase = pricing.phase;
            let minimum_required = pricing.cost_for("light");

            if burn_amount < minimum_required {
                println!("[WARN][LIGHT] insufficient_burn amount={} required={} phase={}",
                    burn_amount, minimum_required, current_phase);
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": format!("Insufficient burn: {} provided, {} required", burn_amount, minimum_required),
                    "required_amount": minimum_required,
                    "provided_amount": burn_amount,
                    "phase": current_phase,
                    "currency": if current_phase == 1 { "1DEV" } else { "QNC" }
                })));
            }
            
            println!("[INFO][LIGHT] price_check_passed amount={} required={}", burn_amount, minimum_required);
        }
    }
    
    // PRIVACY: Generate quantum-secure pseudonym for Light node (mobile privacy protection)
    let light_node_pseudonym = generate_light_node_pseudonym(&register_request.wallet_address);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // GOSSIP SIGNATURE VERIFICATION (pure ML-DSA-65, mirrors unified_p2p.rs exactly)
    // Must pass here — if it fails, ALL peer nodes would also reject the gossip
    // message, making the registration invisible network-wide.
    //
    // ML-DSA-65 (ML-DSA-65): quantum-resistant identity proof
    //   Signs: wallet_address  |  Key: quantum_pubkey (activation-derived keypair)
    // ═══════════════════════════════════════════════════════════════════════════
    {
        let wallet = &register_request.wallet_address;

        // ── Part 1: ML-DSA-65 ──────────────────────────────────────────────
        if register_request.quantum_pubkey.is_empty()
            || register_request.quantum_signature.is_empty()
            || register_request.quantum_signature.len() < 32
        {
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] pq_dilithium_missing wallet={}...",
                    qnet_state::char_prefix(&wallet, 16));
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Dilithium3 quantum signature is required (pq v6.1, Part 1)",
                "hint": "Provide quantum_pubkey and quantum_signature (ML-DSA-65). Client signs wallet_address with activation-derived Dilithium3 keypair."
            })));
        }

        let dilithium_ok = verify_mobile_dilithium_signature(
            wallet,
            &register_request.quantum_signature,
            &register_request.quantum_pubkey,
        );
        if !dilithium_ok {
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] pq_dilithium_invalid wallet={}...",
                    qnet_state::char_prefix(&wallet, 16));
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Invalid Dilithium3 signature (pq v6.1, Part 1)",
                "hint": "Client must sign wallet_address with Dilithium3 (ML-DSA-65) using activation-derived keypair"
            })));
        }
        if crate::node::is_debug() {
            println!("[DBG][LIGHT] pq_dilithium_ok pseudonym={}", light_node_pseudonym);
        }

        // Pure ML-DSA-65: the ML-DSA-65 proof above is the SOLE gossip authenticator. The former
        // Ed25519 (light_node_gossip:...) wallet-key proof and its request fields are removed in P8.
        if crate::node::is_info() {
            println!("[INFO][LIGHT] pq_gossip_verified pseudonym={} dilithium=ok",
                light_node_pseudonym);
        }

        // ── Part 3: Ping Delegation Certificate (optional, v7.1) ──────────────
        // ping_pubkey may be Ed25519 (64 hex, legacy v7.0) or ML-DSA-65 (3904 hex, v7.1+).
        // The delegation cert is always ML-DSA-65-signed by quantum_pubkey.
        if let (Some(pp), Some(cert)) = (
            register_request.ping_pubkey.as_deref().filter(|s| !s.is_empty()),
            register_request.ping_delegation_cert.as_deref().filter(|s| !s.is_empty()),
        ) {
            if pp.len() != 64 && pp.len() != 3904 {
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "ping_pubkey must be 64 hex (Ed25519) or 3904 hex (Dilithium3)",
                })));
            }
            let delegation_msg = format!("delegate_ping:{}:{}", pp, light_node_pseudonym);
            let cert_ok = verify_mobile_dilithium_signature(
                &delegation_msg,
                cert,
                &register_request.quantum_pubkey,
            );
            if !cert_ok {
                if crate::node::is_warn() {
                    println!("[WARN][LIGHT] ping_delegation_invalid pseudonym={}", light_node_pseudonym);
                }
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "Invalid ping delegation certificate (v7.0, Part 3)",
                    "hint": "Sign 'delegate_ping:{ping_pubkey}:{node_pseudonym}' with Dilithium3 keypair"
                })));
            }
            if crate::node::is_info() {
                println!("[INFO][LIGHT] ping_delegation_ok pseudonym={} ping_pk={}...",
                    light_node_pseudonym, qnet_state::char_prefix(&pp, 16));
            }
        }
    }

    // Hash device token for privacy (GDPR compliance)
    let device_token_hash = {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        register_request.device_token.hash(&mut hasher);
        format!("fcm_{:016x}", hasher.finish())
    };
    
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    
    let new_device = LightNodeDevice {
        wallet_address: register_request.wallet_address.clone(),
        device_token_hash,
        device_id: register_request.device_id.clone(),
        last_active: now,
        is_active: true,
    };
    
    // Register Light node or add device to existing node using pseudonym
    let registration_result = {
        let mut registry = LIGHT_NODE_REGISTRY.lock();
        
        if let Some(existing_node) = registry.get_mut(&light_node_pseudonym) {
            // Check device limit (max 3 devices per Light node)
            if existing_node.devices.len() >= 3 {
                // Remove oldest inactive device if needed
                existing_node.devices.retain(|d| d.is_active && (now - d.last_active) < 24 * 60 * 60);
                
                if existing_node.devices.len() >= 3 {
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "Maximum 3 devices per Light node. Remove inactive devices first."
                    })));
                }
            }
            
            // Add new device
            existing_node.devices.push(new_device);
            "device_added"
        } else {
            // v10.0 SCALABILITY: Bound registry to 100K entries; evict oldest if full
            const MAX_LIGHT_NODE_REGISTRY: usize = 100_000;
            if registry.len() >= MAX_LIGHT_NODE_REGISTRY {
                // Evict the entry with the oldest last_ping
                if let Some(oldest_key) = registry.iter()
                    .min_by_key(|(_, v)| v.last_ping)
                    .map(|(k, _)| k.clone())
                {
                    registry.remove(&oldest_key);
                    println!("[INFO][RPC] light_node_registry_evicted oldest_node={} registry_size={}",
                             qnet_state::char_prefix(&oldest_key, 16), registry.len());
                }
            }
            // Create new Light node using privacy-preserving pseudonym
            let light_node = LightNodeInfo {
                node_id: light_node_pseudonym.clone(),
                devices: vec![new_device],
                quantum_pubkey: register_request.quantum_pubkey.clone(),
                registered_at: now,
                // Seed with current time, NOT 0: a fresh registration with last_ping=0 is the global
                // min-by-last_ping, so a full registry would evict the just-registered node (cache
                // thrash / self-eviction). now keeps it at the freshest end until its first real ping.
                last_ping: now,
                ping_count: 0,
                reward_eligible: true,
            };
            registry.insert(light_node_pseudonym.clone(), light_node);
            "node_created"
        }
    };
    
    // Determine push type from request
    let push_type = match register_request.push_type.as_deref() {
        Some("unifiedpush") => {
            if let Some(ref endpoint) = register_request.unified_push_endpoint {
                // Validate UnifiedPush endpoint URL
                if let Err(e) = validate_unified_push_endpoint(endpoint) {
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": format!("Invalid UnifiedPush endpoint: {}", e)
                    })));
                }
                crate::unified_p2p::PushType::UnifiedPush
            } else {
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "UnifiedPush requires unified_push_endpoint"
                })));
            }
        }
        Some("polling") => crate::unified_p2p::PushType::Polling,
        _ => crate::unified_p2p::PushType::FCM,  // Default to FCM
    };
    
    let push_type_str = match push_type {
        crate::unified_p2p::PushType::FCM => "FCM",
        crate::unified_p2p::PushType::UnifiedPush => "UnifiedPush",
        crate::unified_p2p::PushType::Polling => "Polling",
    };
    
    // v4.0: Register VRF public key for light node
    // v14.8: Light nodes do not participate in consensus (they cannot produce
    // microblocks or vote on macroblocks), so we deliberately DO NOT install
    // their PK in the consensus-layer registry. VRF registry is sufficient
    // for their reward / claim verification path.
    if !register_request.quantum_pubkey.is_empty() {
        if let Ok(pk_bytes) = hex::decode(&register_request.quantum_pubkey) {
            crate::genesis_constants::register_vrf_public_key(&light_node_pseudonym, &pk_bytes);
        }
    }

    println!("[INFO][LIGHT] node_registered pseudonym={} push={} quantum_secured=true", 
             light_node_pseudonym, push_type_str);

    // Clear per-wallet failed-attempt counter on successful registration
    WALLET_REG_FAIL_TIMESTAMPS.remove(&register_request.wallet_address);

    // CRITICAL: Gossip Light node registration to P2P network for decentralized sync
    // This ensures ALL Super nodes have the same Light node registry
    if let Some(p2p) = blockchain.get_unified_p2p() {
        use crate::unified_p2p::LightNodeRegistrationData;
        
        // Get device token hash from local registry
        let device_token_hash = {
            let registry = LIGHT_NODE_REGISTRY.lock();
            registry.get(&light_node_pseudonym)
                .and_then(|n| n.devices.first())
                .map(|d| d.device_token_hash.clone())
                .unwrap_or_default()
        };
        
        // Register in P2P gossip-synced registry and broadcast to network
        // Pure ML-DSA-65: the mobile ML-DSA-65 signature is the sole gossip authenticator
        let registration = LightNodeRegistrationData {
            node_id: light_node_pseudonym.clone(),
            wallet_address: register_request.wallet_address.clone(),
            device_token_hash,
            quantum_pubkey: register_request.quantum_pubkey.clone(),
            registered_at: now,
            signature: register_request.quantum_signature.clone(),
            push_type: push_type.clone(),
            unified_push_endpoint: register_request.unified_push_endpoint.clone(),
            last_seen: now,
            consecutive_failures: 0,
            is_active: true,
            ping_pubkey: register_request.ping_pubkey.clone().unwrap_or_default(),
            ping_delegation_cert: register_request.ping_delegation_cert.clone().unwrap_or_default(),
        };
        p2p.register_light_node(registration);
        println!("[INFO][GOSSIP] light_node_gossiped pseudonym={} push={}", light_node_pseudonym, push_type_str);

        if !register_request.device_token.is_empty() {
            let pt_str = match push_type {
                crate::unified_p2p::PushType::FCM => "fcm",
                crate::unified_p2p::PushType::UnifiedPush => "unifiedpush",
                crate::unified_p2p::PushType::Polling => "polling",
            };
            // Same monotonic bump as token-refresh so a re-register supersedes regardless of skew.
            let reg_ts = std::cmp::max(now, blockchain.get_storage()
                .get_fcm_record(&light_node_pseudonym)
                .map(|r| r.3.saturating_add(1)).unwrap_or(now));
            match blockchain.get_storage().save_fcm_token(
                &light_node_pseudonym,
                &register_request.device_token,
                pt_str,
                register_request.unified_push_endpoint.as_deref(),
                reg_ts,
            ) {
                Ok(()) => {
                    if crate::node::is_info() {
                        println!("[INFO][LIGHT] fcm_token_saved pseudonym={} push={}",
                                 light_node_pseudonym, pt_str);
                    }
                    // Sync FCM token to all other genesis nodes so any of them can ping.
                    // Done in a fire-and-forget task — registration must not block on peer sync.
                    {
                        use crate::genesis_constants::GENESIS_NODE_IPS;
                        let pseudonym_clone  = light_node_pseudonym.clone();
                        let token_clone      = register_request.device_token.clone();
                        let pt_str_clone     = pt_str.to_string();
                        let endpoint_clone   = register_request.unified_push_endpoint.clone();
                        let our_ip: String = {
                            let bid = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or_default();
                            GENESIS_NODE_IPS.iter()
                                .find(|(_, id)| *id == bid)
                                .map(|(ip, _)| ip.to_string())
                                .unwrap_or_default()
                        };
                        tokio::spawn(async move {
                            sync_fcm_token_to_genesis_peers(
                                &pseudonym_clone,
                                &token_clone,
                                &pt_str_clone,
                                endpoint_clone.as_deref(),
                                &our_ip,
                                reg_ts,
                            ).await;
                        });
                    }
                }
                Err(e) => {
                    if crate::node::is_warn() {
                        println!("[WARN][LIGHT] fcm_token_save_failed pseudonym={} err={}",
                                 light_node_pseudonym, e);
                    }
                }
            }
        }

        // v6.0: Client-side TX creation flow
        // NodeRegistration TX is now created and submitted by the CLIENT (wallet app),
        // not by the server. This ensures:
        // 1. TX is signed by the user's own key (not a server ephemeral key)
        // 2. Client can route TX directly to the current producer (producer-aware routing)
        // 3. NodeRegistration follows the same pipeline as Transfer TX
        //
        // The server returns registration_proof so the client can construct the TX.
        // registration_proof = blake3(burn_tx_hash:node_id:wallet_address)[..32]
        if registration_result == "node_created" {
            let device_sig_hash = blake3::hash(register_request.device_id.as_bytes()).to_hex().to_string();
            let _ = device_sig_hash; // kept for proof computation below
        }
    }
    
    // Compute registration_proof: deterministic, includes burn_tx_hash for on-chain verifiability
    let registration_proof = {
        let burn_hash = register_request.burn_tx_hash.as_deref().unwrap_or("no_burn");
        let proof_input = format!("{}:{}:{}", burn_hash, light_node_pseudonym, register_request.wallet_address);
        let h = blake3::hash(proof_input.as_bytes()).to_hex().to_string();
        h[..32].to_string()
    };
    
    // Calculate next ping time for this node
    let (next_ping_time, window_number) = crate::unified_p2p::SimplifiedP2P::get_next_ping_time(&light_node_pseudonym);

    // Already-registered RETURN: the registry insert + register_light_node above gossiped is_active=true
    // (+ the refreshed ping key), reaching the shard-owner genesis to reactivate it. No new on-chain TX
    // is needed (the node is already registered), so tx_required=false.
    if reactivating_existing {
        return Ok(warp::reply::json(&json!({
            "success": true,
            "already_registered": true,
            "reactivated": true,
            "node_id": light_node_pseudonym,
            "node_type": "light",
            "tx_required": false,
            "push_type": push_type_str,
            "next_ping_time": next_ping_time,
            "next_ping_window": window_number,
            "message": "Node reactivated and restored."
        })));
    }

    Ok(warp::reply::json(&json!({
        "success": true,
        "message": "Light node registered successfully with privacy protection",
        "node_id": light_node_pseudonym,
        "registration_proof": registration_proof,
        "tx_required": true,   // Client must submit NodeRegistration TX via /api/v1/node-registration/submit
        "privacy_enabled": true,
        "push_type": push_type_str,
        "next_ping_time": next_ping_time,
        "next_ping_window": window_number,
        "quantum_secured": true
    })))
}

/// SECURE: Handle node info with activation code for authenticated wallet extensions
/// v10.0: Auth via Authorization header preferred; query param is deprecated (backward compat)
pub(super) async fn handle_node_secure_info(
    auth_header: Option<String>,
    params: HashMap<String, String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // SECURITY: Require admin secret for sensitive node information
    let admin_secret = std::env::var("QNET_ADMIN_SECRET").unwrap_or_default();
    if !admin_secret.is_empty() {
        // v10.0: Prefer Authorization header (Bearer <secret>)
        let header_secret = auth_header.as_deref()
            .and_then(|h| h.strip_prefix("Bearer "))
            .unwrap_or("");

        // Backward compatibility: check query param but log deprecation warning
        let query_secret = params.get("admin_secret").map(|s| s.as_str()).unwrap_or("");

        let provided = if !header_secret.is_empty() {
            header_secret
        } else if !query_secret.is_empty() {
            println!("[WARN][API] secure_info_deprecated_query_param ip=unknown reason=admin_secret_in_url_is_deprecated");
            query_secret
        } else {
            ""
        };

        if provided != admin_secret {
            if is_warn() {
                println!("[WARN][API] secure_info_rejected reason=invalid_or_missing_admin_secret");
            }
            return Ok(warp::reply::json(&json!({"error": "unauthorized", "message": "Admin secret required. Use Authorization: Bearer <secret> header."})));
        }
    }

    // Get basic node info first
    let height = blockchain.get_height().await;
    let peer_count = blockchain.get_peer_count().await.unwrap_or(0);
    let mempool_size = blockchain.get_mempool_size().await.unwrap_or(0);
    
    // v3.18: Full node type removed - only Light and Super remain
    let node_type = match blockchain.get_node_type() {
        crate::node::NodeType::Light => "light",
        crate::node::NodeType::Super => "super",
    };
    
    let region = match blockchain.get_region() {
        crate::node::Region::NorthAmerica => "na",
        crate::node::Region::Europe => "eu",
        crate::node::Region::Asia => "asia",
        crate::node::Region::SouthAmerica => "sa",
        crate::node::Region::Africa => "africa",
        crate::node::Region::Oceania => "oceania",
    };
    
    // SECURE: Activation code is no longer exposed via API
    let _activation_code_exists = match std::env::var("QNET_ACTIVATION_CODE") {
        Ok(code) if !code.is_empty() => {
            if is_info() {
                println!("[INFO][API] secure_info_request activation_code=present");
            }
            true
        }
        _ => {
            if is_info() {
                println!("[INFO][API] secure_info_request activation_code=absent");
            }
            false
        }
    };
    
    // PRODUCTION: Get real uptime and reward data
    let current_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    
    // Claimable = the merkle reward_root total this node's wallet can still prove. Single source
    // with the claim endpoint, so display and payout cannot disagree.
    let pending_rewards = match blockchain.get_node_wallet(&blockchain.get_node_id()).await {
        Some(w) => wallet_claimable_qnc(&blockchain, &w).await,
        None => 0,
    };
    
    let response = json!({
        "node_id": format!("node_{}", blockchain.get_port()),
        "height": height,
        "peers": peer_count,
        "mempool_size": mempool_size,
        "version": "0.1.0",
        "node_type": node_type,
        "region": region,
        "status": "active",
        // SECURITY: Don't expose activation code via API
        "activation_code": null,
        "uptime": current_time,
        "pending_rewards": pending_rewards,
        "last_seen": current_time
    });
    
    Ok(warp::reply::json(&response))
}

// Handler for Shred Protocol metrics
pub(super) async fn handle_shred_protocol_metrics(remote_addr: Option<std::net::SocketAddr>, blockchain: Arc<BlockchainNode>) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(resp) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(resp);
    }
    // PRODUCTION: Get real-time Shred Protocol metrics from P2P network
    let (fanout, producers, latency) = if let Some(unified_p2p) = blockchain.get_unified_p2p() {
        let fanout = unified_p2p.get_shred_protocol_fanout();
        let producers = unified_p2p.get_qualified_producers_count();
        let latency = unified_p2p.get_average_peer_latency();
        (fanout, producers, latency)
    } else {
        (4, 0, 50) // Defaults if P2P not available
    };
    
    let metrics = json!({
        "enabled": true,
        "chunk_size": 524288,   // v4.1: 512KB (was 256KB - 2x for 200K TX/block)
        "fanout": fanout,  // REAL-TIME: Adaptive fanout (4-32)
        "qualified_producers": producers,  // REAL-TIME: Producers with reputation >= 70%
        "average_latency_ms": latency,  // REAL-TIME: Network performance
        "redundancy_factor": 1.5,
        "max_chunks": 170,           // v2.63: 170 data chunks (GF(2^8) limit: 170+85=255)
        "chunk_size_kb": 512,        // v4.1: 512KB chunks (was 256KB - 2x for 200K TX/block)
        "max_block_size": 89128960,  // v4.1: 170 × 512KB = 87 MB (supports 200K TX/block)
        "status": "active"
    });
    
    Ok(warp::reply::json(&metrics))
}


// Handler for Parallel Executor metrics
pub(super) async fn handle_parallel_executor_metrics(remote_addr: Option<std::net::SocketAddr>, blockchain: Arc<BlockchainNode>) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(resp) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(resp);
    }
    let metrics = json!({
        "enabled": blockchain.get_parallel_executor().is_some(),
        "pipeline_stages": 5,
        "stages": ["Validation", "DependencyAnalysis", "Execution", "DilithiumSignature", "Commitment"],
        "max_parallel_tx": 200000,
        "status": if blockchain.get_parallel_executor().is_some() { "active" } else { "disabled" }
    });
    
    Ok(warp::reply::json(&metrics))
}

// Handler for Pre-execution status
pub(super) async fn handle_pre_execution_status(remote_addr: Option<std::net::SocketAddr>, blockchain: Arc<BlockchainNode>) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(resp) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(resp);
    }
    let metrics = blockchain.get_pre_execution().get_metrics().await;
    
    let status = json!({
        "enabled": true,
        "lookahead_blocks": 3,
        "max_tx_per_block": 200000, // 200K TX/block max (v4.1)
        "cache_size": 200000, // Match max TX per block
        "total_pre_executed": metrics.total_pre_executed,
        "cache_hits": metrics.cache_hits,
        "cache_misses": metrics.cache_misses,
        "average_speedup_ms": metrics.average_speedup_ms,
        "status": "active"
    });
    
    Ok(warp::reply::json(&status))
}

// Handler for Adaptive BFT timeouts
pub(super) async fn handle_adaptive_bft_timeouts(remote_addr: Option<std::net::SocketAddr>, blockchain: Arc<BlockchainNode>) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(resp) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(resp);
    }
    let current_height = blockchain.get_height().await;
    
    let timeout_block_1 = blockchain.get_adaptive_bft().get_timeout(1, 0).await;
    let timeout_block_10 = blockchain.get_adaptive_bft().get_timeout(10, 0).await;
    let timeout_current = blockchain.get_adaptive_bft().get_timeout(current_height, 0).await;
    
    let info = json!({
        "enabled": true,
        "current_height": current_height,
        "timeouts": {
            "block_1": timeout_block_1.as_millis(),
            "block_10": timeout_block_10.as_millis(),
            "current_block": timeout_current.as_millis(),
        },
        "config": {
            "base_timeout_ms": 7000,
            "timeout_multiplier": 1.5,
            "max_timeout_ms": 20000,
            "min_timeout_ms": 1000,
        },
        "status": "active"
    });
    
    Ok(warp::reply::json(&info))
}

pub(super) async fn handle_light_node_ping_response(
    params: HashMap<String, String>,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};
    use crate::unified_p2p::{SimplifiedP2P, LightNodeAttestation};

    // Per-IP rate limit BEFORE any storage read / crypto verify (unpriced-work DoS bound at scale).
    if let Err(rate_limited) = check_api_rate_limit(remote_addr, "light_node_ping") {
        return Ok(rate_limited);
    }

    let node_id = params.get("node_id").unwrap_or(&"unknown".to_string()).clone();
    let signature = params.get("signature").unwrap_or(&"".to_string()).clone();
    let challenge = params.get("challenge").unwrap_or(&"".to_string()).clone();

    // Cheap structural reject before the anchor storage read + Dilithium verify.
    if !node_id.starts_with("light_") || signature.is_empty() || challenge.is_empty() {
        return Ok(warp::reply::json(&json!({ "success": false, "error": "malformed ping-response" })));
    }

    // Two accepted challenge forms:
    // 1. Server stamp (push path, G2): must be one THIS server stamped for THIS node, unexpired.
    // 2. PULL self-attestation: "selfattest:{height}:{block_hash}" — a same-epoch canonical block
    //    hash, unknowable before that block exists, so it proves the device is online THIS epoch
    //    with the same strength as a stamped challenge but with no FCM delivery dependency.
    //    (FCM stays as a best-effort wakeup; liveness no longer depends on it at scale.)
    if let Some(rest) = challenge.strip_prefix("selfattest:") {
        let parsed = (|| {
            let (h_str, hash) = rest.split_once(':')?;
            let h: u64 = h_str.parse().ok()?;
            if hash.is_empty() || hash.contains(':') { return None; }
            Some((h, hash))
        })();
        let tip = blockchain.get_height().await;
        let valid = match parsed {
            Some((h, hash)) if h <= tip && h / 14400 == tip / 14400 => {
                blockchain.get_storage().get_microblock_hash_hex(h).ok().flatten()
                    .map(|canon| canon == hash).unwrap_or(false)
            }
            _ => false,
        };
        if !valid {
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] selfattest_anchor_invalid node={}", node_id);
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Invalid or stale self-attest anchor"
            })));
        }
    } else if !verify_challenge_stamp(&node_id, &challenge) {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] challenge_unrecognized node={}", node_id);
        }
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Unrecognized or expired challenge"
        })));
    }

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let current_slot = SimplifiedP2P::get_current_slot();
    let our_node_id = blockchain.get_node_id();

    // Dedup per EPOCH (the reward unit is one attestation per epoch, not per slot) — BEFORE the
    // Dilithium verify so repeat submissions cost no crypto at scale.
    if let Some(p2p) = blockchain.get_unified_p2p() {
        if p2p.has_attestation_in_window(&node_id) {
            if crate::node::is_debug() {
                println!("[DBG][LIGHT] already_attested_epoch node={}", node_id);
            }
            return Ok(warp::reply::json(&json!({
                "success": true,
                "node_id": node_id,
                "already_attested": true,
                "timestamp": now
            })));
        }
    }

    // Anti-poison: if the request presents its ping delegation, refresh the ping-key CF before verifying,
    // so the node's own authenticated ping overwrites any pre-registration gossip poison. The overwrite is
    // bound to (a) a cert that verifies under the node's committed on-chain key AND (b) a valid ping signature
    // under the PRESENTED key — so a replay of an old (pp,cert) with a garbage ping sig cannot downgrade the
    // stored key, while a node whose CF was poisoned heals it with its own correctly-signed ping.
    if let (Some(pp), Some(cert)) = (params.get("ping_pubkey"), params.get("ping_delegation_cert")) {
        if !pp.is_empty() && !cert.is_empty() && signature.starts_with("ping_dilithium:") {
            let inner_ping_sig = &signature[15..];
            if let Ok(Some(vrf)) = blockchain.get_storage().load_vrf_public_key(&node_id) {
                let onchain_pk_hex = hex::encode(vrf);
                let delegation_msg = format!("delegate_ping:{}:{}", pp, node_id);
                if verify_mobile_dilithium_signature(&delegation_msg, cert, &onchain_pk_hex)
                    && verify_mobile_dilithium_signature(&challenge, inner_ping_sig, pp) {
                    let _ = blockchain.get_storage().save_light_ping_keys(&node_id, pp, cert);
                } else if crate::node::is_warn() {
                    println!("[WARN][LIGHT] presented_ping_delegation_rejected node={}", node_id);
                }
            }
        }
    }

    // PRODUCTION v2.78: Verify Light node post-quantum ML-DSA-65 signature
    let signature_valid = verify_light_node_signature(&node_id, &challenge, &signature, &blockchain).await;

    if !signature_valid {
        println!("[LIGHT] ❌ Invalid signature from Light node {}", node_id);
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid quantum signature"
        })));
    }
    
    // Create and gossip attestation
    if let Some(p2p) = blockchain.get_unified_p2p() {
        // Sign attestation with our Dilithium key
        let attestation_data = format!("attestation:{}:{}:{}:{}", 
            node_id, current_slot, now, challenge);
        
        // CRITICAL: Sign with post-quantum ML-DSA-65 cryptography per NIST/Cisco
        let pinger_signature = {
            use crate::pq_crypto::{PqCrypto, GLOBAL_PQ_INSTANCES};
            use std::sync::Arc;

            // Get or create post-quantum crypto instance
            let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
                Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
            }).await;

            let mut instances_guard = instances.lock().await;

            // v2.24: Use node_id directly
            let normalized_node_id = our_node_id.clone();

            // Create instance if not exists
            if !instances_guard.contains_key(&normalized_node_id) {
                let mut pq = PqCrypto::new(normalized_node_id.clone());
                if let Err(e) = pq.initialize().await {
                    println!("[LIGHT] ❌ Failed to init PQ crypto: {}", e);
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "PQ crypto initialization failed"
                    })));
                }
                instances_guard.insert(normalized_node_id.clone(), pq);
            }

            let pq = instances_guard.get_mut(&normalized_node_id).expect("Inserted above");

            // Check rotation
            if pq.needs_rotation() {
                let _ = pq.rotate_certificate().await;
            }

            // CRITICAL: Sign RAW attestation with ML-DSA-65 (hashes before signing)
            // OPTIMIZED v2.24: bincode+zstd instead of JSON
            match pq.sign_raw_message_compact(attestation_data.as_bytes()).await {
                Ok(compact_sig) => {
                    match compact_sig.to_binary_compressed() {
                        Ok(binary_data) => {
                            let base64_data = base64::engine::general_purpose::STANDARD.encode(&binary_data);
                            println!("[LIGHT] ✅ PQ attestation signature (bincode v2.24)");
                            format!("compact_bin:{}", base64_data)  // Standard format for verification
                        }
                        Err(e) => {
                            println!("[LIGHT] ❌ Failed to serialize PQ signature: {}", e);
                            return Ok(warp::reply::json(&json!({
                                "success": false,
                                "error": "Failed to serialize attestation signature"
                            })));
                        }
                    }
                }
                Err(e) => {
                    println!("[LIGHT] ❌ Failed to sign attestation: {:?}", e);
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "Failed to sign attestation with PQ crypto"
                    })));
                }
            }
        };
        
        // Create attestation with Light node's signature
        // v2.59: Include block_height for epoch-based reward filtering
        let current_block_height = blockchain.get_height().await;
        let attestation = LightNodeAttestation {
            light_node_id: node_id.clone(),
            pinger_id: our_node_id.clone(),
            slot: current_slot,
            timestamp: now,
            light_node_signature: signature.clone(), // Light node's actual signature!
            pinger_signature,
            challenge: challenge.clone(),
            block_height: current_block_height, // v2.59: For epoch filtering
        };
        
        // Gossip attestation to all nodes
        p2p.gossip_light_node_attestation(attestation);
        
        // Save attestation to persistent storage
        if let Err(e) = blockchain.get_storage().save_attestation(&node_id, current_slot, &our_node_id, now) {
            println!("[STORAGE] ⚠️ Failed to save attestation: {}", e);
        }
        
        println!("[LIGHT] ✅ Attestation created for {} in slot {} (signed by both parties)", 
                 node_id, current_slot);
    }
    
    // Record ping in reward system
    {
        
        // v4.3: Get wallet address — try P2P registry first (authoritative, gossip-synced),
        // fall back to local LIGHT_NODE_REGISTRY (device cache), then RocksDB (blockchain state)
        let wallet_address = {
            // Level 1: P2P registry (gossip-synced + restored from RocksDB on startup)
            let from_p2p = blockchain.get_unified_p2p()
                .and_then(|p2p| p2p.get_light_node(&node_id).map(|r| r.wallet_address.clone()));
            
            if let Some(addr) = from_p2p {
                Some(addr)
            } else {
                // Level 2: Local device cache (populated on direct API calls only)
                let from_local = {
            let registry = LIGHT_NODE_REGISTRY.lock();
                    registry.get(&node_id)
                        .and_then(|n| n.devices.first().map(|d| d.wallet_address.clone()))
                };
                
                if from_local.is_some() {
                    from_local
            } else {
                    // Level 3: RocksDB reverse index (blockchain state — ultimate source of truth)
                    None // Handled by fallback below (generate EON address)
                }
            }
        };
        
        let wallet_addr = wallet_address.unwrap_or_else(|| {
            // Generate proper EON address: {19}eon{15}{8 checksum} = 45 chars
            let hash = blake3::hash(node_id.as_bytes()).to_hex();
            let part1 = &hash[..19];
            let part2 = &hash[19..34];
            let checksum_input = format!("{}eon{}", part1, part2);
            let mut hasher = Sha3_256::new();
            hasher.update(checksum_input.as_bytes());
            let checksum = hex::encode(&hasher.finalize()[..4]);
            format!("{}eon{}{}", part1, part2, checksum)
        });
        
        // Ping + registration land in storage, which is the replicated source every node shares.
        use qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
        let _ = blockchain.get_storage().save_ping_attempt(&node_id, now, true, 50);
        let _ = blockchain.get_storage().save_node_registration(&node_id, "light", &wallet_addr, INITIAL_REPUTATION);
    }
    
    println!("[LIGHT] 📡 Light node {} responded and attested in slot {}", node_id, current_slot);
    
    // Clear pending challenge if exists (for polling nodes)
    {
        let mut challenges = PENDING_CHALLENGES.lock();
        challenges.remove(&node_id);
    }
    
    Ok(warp::reply::json(&json!({
        "success": true,
        "node_id": node_id,
        "slot": current_slot,
        "attested": true,
        "next_ping_window": now + (4 * 60 * 60),
        "timestamp": now
    })))
}

/// Handle next ping time request (for polling-based Light nodes)
/// Returns the timestamp when the next ping is expected
pub(super) async fn handle_light_node_next_ping(
    params: HashMap<String, String>,
) -> Result<impl Reply, Rejection> {
    use crate::unified_p2p::SimplifiedP2P;
    
    let node_id = match params.get("node_id") {
        Some(id) => id.clone(),
        None => return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "node_id parameter required"
        }))),
    };
    
    let (next_ping_time, window_number) = SimplifiedP2P::get_next_ping_time(&node_id);
    let current_slot = SimplifiedP2P::get_current_slot();
    let current_window = SimplifiedP2P::get_current_window_number();
    
    Ok(warp::reply::json(&json!({
        "success": true,
        "node_id": node_id,
        "next_ping_time": next_ping_time,
        "next_ping_window": window_number,
        "current_slot": current_slot,
        "current_window": current_window,
        "slots_per_window": 240,
        "window_duration_seconds": 4 * 60 * 60
    })))
}

/// Handle pending challenge request (for polling-based Light nodes)
/// Returns the challenge if one is pending, or null if not
/// Security: Only registered polling nodes can request challenges
pub(super) async fn handle_light_node_pending_challenge(
    params: HashMap<String, String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    let node_id = match params.get("node_id") {
        Some(id) => id.clone(),
        None => return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "node_id parameter required"
        }))),
    };
    
    // Security: Verify node exists and is registered for polling (point-read: no full-map clone)
    if let Some(p2p) = blockchain.get_unified_p2p() {
        match p2p.get_light_node(&node_id) {
            Some(node) => {
                // Only polling nodes can use this endpoint. Liveness is on-chain (B): a poll always yields
                // the challenge; answering it records eligibility, which IS the reactivation.
                if !matches!(node.push_type, crate::unified_p2p::PushType::Polling) {
                    return Ok(warp::reply::json(&json!({
                        "success": false,
                        "error": "This endpoint is only for polling-mode nodes"
                    })));
                }
            }
            None => {
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "Node not found. Please register first."
                })));
            }
        }
    }
    
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    
    // Check for pending challenge
    let pending = {
        let mut challenges = PENDING_CHALLENGES.lock();
        
        // Clean up expired challenges
        challenges.retain(|_, c| c.expires_at > now);
        
        // Get challenge for this node
        challenges.get(&node_id).cloned()
    };
    
    match pending {
        Some(challenge) => {
            println!("[POLLING] 📤 Returning pending challenge for {}", node_id);
            Ok(warp::reply::json(&json!({
                "success": true,
                "node_id": node_id,
                "has_challenge": true,
                "challenge": challenge.challenge,
                "created_at": challenge.created_at,
                "expires_at": challenge.expires_at
            })))
        }
        None => {
            // Check if it's this node's ping slot - if so, generate challenge
            if crate::unified_p2p::SimplifiedP2P::is_light_node_ping_slot(&node_id) {
                // Check if attestation already exists
                if let Some(p2p) = blockchain.get_unified_p2p() {
                    let current_slot = crate::unified_p2p::SimplifiedP2P::get_current_slot();
                    if p2p.has_attestation(&node_id, current_slot) {
                        return Ok(warp::reply::json(&json!({
                            "success": true,
                            "node_id": node_id,
                            "has_challenge": false,
                            "already_attested": true,
                            "message": "Already attested in current slot"
                        })));
                    }
                }
                
                // Generate a server-stamped challenge (G2: authenticated, FCM-safe).
                let challenge = make_challenge_stamp(&node_id);
                let expires_at = now + 180; // 3 minute expiry (matches LIGHT_CHALLENGE_TTL_SECS)
                
                // Store pending challenge
                {
                    let mut challenges = PENDING_CHALLENGES.lock();
                    challenges.insert(node_id.clone(), PendingChallenge {
                        challenge: challenge.clone(),
                        created_at: now,
                        expires_at,
                    });
                }
                
                println!("[POLLING] 🎯 Generated challenge for {} (polling mode)", node_id);
                
                Ok(warp::reply::json(&json!({
                    "success": true,
                    "node_id": node_id,
                    "has_challenge": true,
                    "challenge": challenge,
                    "created_at": now,
                    "expires_at": expires_at
                })))
            } else {
                // Not this node's slot
                let (next_ping_time, _) = crate::unified_p2p::SimplifiedP2P::get_next_ping_time(&node_id);
                
                Ok(warp::reply::json(&json!({
                    "success": true,
                    "node_id": node_id,
                    "has_challenge": false,
                    "message": "Not your ping slot yet",
                    "next_ping_time": next_ping_time
                })))
            }
        }
    }
}

/// Validate UnifiedPush endpoint URL
/// Only allows known trusted providers to prevent abuse
pub(super) fn validate_unified_push_endpoint(endpoint: &str) -> Result<(), String> {
    // Parse URL
    let url = match url::Url::parse(endpoint) {
        Ok(u) => u,
        Err(_) => return Err("Invalid URL format".to_string()),
    };
    
    // Must be HTTPS
    if url.scheme() != "https" {
        return Err("UnifiedPush endpoint must use HTTPS".to_string());
    }
    
    // Whitelist of trusted UnifiedPush providers
    let trusted_domains = [
        "ntfy.sh",              // ntfy.sh (popular, free)
        "push.ntfy.sh",         // ntfy.sh alternative
        "gotify.net",           // Gotify
        "push.example.org",     // Self-hosted (common pattern)
        "unifiedpush.org",      // Official
        "up.qnet.network",      // QNet's own (future)
    ];
    
    let host = url.host_str().unwrap_or("");
    
    // Check if domain or subdomain of trusted provider
    let is_trusted = trusted_domains.iter().any(|&domain| {
        host == domain || host.ends_with(&format!(".{}", domain))
    });
    
    // Also allow self-hosted if it looks like a valid domain
    // (has at least one dot and no suspicious patterns)
    let looks_valid = host.contains('.') && 
                      !host.contains("localhost") &&
                      !host.starts_with("192.168.") &&
                      !host.starts_with("10.") &&
                      !host.starts_with("127.") &&
                      host.len() > 4;
    
    if is_trusted || looks_valid {
        Ok(())
    } else {
        Err(format!("Untrusted UnifiedPush provider: {}. Use ntfy.sh or self-hosted.", host))
    }
}

/// Owner-shard verdict proxy: the current-epoch attestation view is shard-owner RAM
/// (bounded at 10M nodes), so a non-owner consults the owner before declaring a node
/// inactive — every genesis then returns ONE verdict and the app stops flip-flopping
/// with the node it happens to poll. 60s per-node cache (64k cap); None on any error
/// (caller keeps its local verdict). `fwd=1` marks a proxied call — never recursed.
async fn shard_owner_says_active(node_id: &str) -> Option<bool> {
    use crate::genesis_constants::GENESIS_NODE_IPS;
    fn cache() -> &'static dashmap::DashMap<String, (bool, u64)> {
        static M: std::sync::OnceLock<dashmap::DashMap<String, (bool, u64)>> = std::sync::OnceLock::new();
        M.get_or_init(dashmap::DashMap::new)
    }
    // Per-owner negative cache: an unreachable owner must not cost every status poll a
    // 2s timeout — skip its shard's proxying for 15s after a failure.
    fn owner_down() -> &'static dashmap::DashMap<usize, u64> {
        static M: std::sync::OnceLock<dashmap::DashMap<usize, u64>> = std::sync::OnceLock::new();
        M.get_or_init(dashmap::DashMap::new)
    }
    // Global in-flight bound: the proxy is reachable from a public endpoint, so outbound
    // fan-in to the owner is capped process-wide; overflow degrades to the local verdict.
    fn inflight() -> &'static tokio::sync::Semaphore {
        static S: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
        S.get_or_init(|| tokio::sync::Semaphore::new(16))
    }
    let owner = crate::node::light_shard_of(node_id);
    let our_idx = std::env::var("QNET_BOOTSTRAP_ID").ok()
        .and_then(|id| id.parse::<usize>().ok())
        .map(|n| n.saturating_sub(1));
    if our_idx == Some(owner) { return None; }
    let (ip, _) = GENESIS_NODE_IPS.get(owner)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    if let Some(e) = cache().get(node_id) { if e.value().1 > now { return Some(e.value().0); } }
    if let Some(d) = owner_down().get(&owner) { if *d.value() > now { return None; } }
    if cache().len() > 65_536 { cache().clear(); }
    let _permit = inflight().try_acquire().ok()?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2)).build().ok()?;
    let url = format!("http://{}:8001/api/v1/light-node/status?node_id={}&fwd=1", ip, node_id);
    let v: Option<serde_json::Value> = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r.json().await.ok(),
        _ => None,
    };
    // Only a transport-level failure marks the owner down; a well-formed reply without
    // a verdict (e.g. the owner does not know the node) is a per-node None, not an outage.
    let v = match v {
        Some(v) => v,
        None => { owner_down().insert(owner, now + 15); return None; }
    };
    let active = v["is_active"].as_bool()?;
    cache().insert(node_id.to_string(), (active, now + 60));
    Some(active)
}

/// Handle Light node status check
/// Returns current activity status and failure count
pub(super) async fn handle_light_node_status(
    params: HashMap<String, String>,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    let node_id = match params.get("node_id") {
        Some(id) => id.clone(),
        None => return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "node_id parameter required"
        }))),
    };
    
    // On-chain readiness = the EXACT condition the ping handler enforces before accepting an
    // attestation (load_vrf_public_key present). Node-independent (committed key is uniform across
    // storage), unlike RAM-registry presence which is gossip-lagged. The client gates self-attest on
    // this so a ping never fires before the registration TX is applied (no_onchain_key rejection).
    let onchain_registered = blockchain.get_storage()
        .load_vrf_public_key(&node_id)
        .ok().flatten().is_some();

    // B: liveness is derived from the committed attestation-eligibility index (node-independent, durable),
    // NOT a per-genesis RAM FSM. needs_reactivation = registered on-chain but not attested in the last two
    // COMMITTED epochs. Any genesis returns the same answer; the app resolves it by self-attesting on wake.
    let cur_height = blockchain.get_storage().get_chain_height().unwrap_or(0);
    let attested_recent = blockchain.get_storage().light_attested_recent_onchain(&node_id, cur_height);
    let needs_reactivation = onchain_registered && !attested_recent;
    let (next_ping_time, window_number) = crate::unified_p2p::SimplifiedP2P::get_next_ping_time(&node_id);

    if let Some(p2p) = blockchain.get_unified_p2p() {
        if let Some(node) = p2p.get_light_node(&node_id) {
            let current_slot = crate::unified_p2p::SimplifiedP2P::get_current_slot();
            let has_attestation = p2p.has_attestation(&node_id, current_slot);
            // Agree with the ping-scheduler's liveness view (get_light_nodes_to_ping). A node that attested
            // in the current — not-yet-committed — epoch (converged across genesis via attestation gossip) or
            // is within the fresh-registration grace is live now, even though light_elig_ only records it at
            // the next boundary. Without this a just-activated / just-reactivated node reads OFFLINE for up to
            // a full epoch and the app loops redundant self-attests. Non-consensus: this only shapes the UI verdict.
            const WAKE_GRACE_SECS: u64 = 3 * 14400;
            let now_secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
            let fresh = now_secs.saturating_sub(node.registered_at) < WAKE_GRACE_SECS;
            let attested_now = p2p.has_attestation_in_window(&node_id);
            let mut needs_reactivation = needs_reactivation && !attested_now && !fresh;
            if needs_reactivation && !params.contains_key("fwd") {
                if shard_owner_says_active(&node_id).await == Some(true) { needs_reactivation = false; }
            }
            return Ok(warp::reply::json(&json!({
                "success": true,
                "node_id": node_id,
                "is_active": !needs_reactivation,
                "registered_at": node.registered_at,
                "push_type": format!("{:?}", node.push_type),
                "has_attestation_current_slot": has_attestation,
                "next_ping_time": next_ping_time,
                "next_ping_window": window_number,
                "needs_reactivation": needs_reactivation,
                "onchain_registered": onchain_registered
            })));
        }
    }

    // RAM-registry miss: the recency index is committed and node-independent, so still answer
    // authoritatively when the node is on-chain. Apply the same current-epoch attestation grace as the
    // RAM-hit branch so the verdict is identical across genesis (honors "any genesis returns the same answer").
    if onchain_registered {
        let attested_now = blockchain.get_unified_p2p().map(|p| p.has_attestation_in_window(&node_id)).unwrap_or(false);
        let mut needs_reactivation = needs_reactivation && !attested_now;
        if needs_reactivation && !params.contains_key("fwd") {
            if shard_owner_says_active(&node_id).await == Some(true) { needs_reactivation = false; }
        }
        return Ok(warp::reply::json(&json!({
            "success": true,
            "node_id": node_id,
            "is_active": !needs_reactivation,
            "has_attestation_current_slot": attested_now,
            "next_ping_time": next_ping_time,
            "next_ping_window": window_number,
            "needs_reactivation": needs_reactivation,
            "onchain_registered": true
        })));
    }

    Ok(warp::reply::json(&json!({
        "success": false,
        "error": "Node not found",
        "onchain_registered": onchain_registered
    })))
}

/// Handle Server node (Super, including Genesis) status check
/// Returns online status, heartbeat count, and activity info
pub(super) async fn handle_server_node_status(
    mut params: HashMap<String, String>,
    wallet_hdr: Option<String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};

    // Privacy: prefer the wallet from the header (never in the URL) over ?wallet=.
    if let Some(w) = wallet_hdr.filter(|s| !s.is_empty()) { params.insert("wallet".to_string(), w); }

    // Query by node_id, wallet (the robust wallet-bridge), or activation_code.
    let activation_code = params.get("activation_code").cloned();
    let node_id = params.get("node_id").cloned();
    let wallet = params.get("wallet").cloned();

    if activation_code.is_none() && node_id.is_none() && wallet.is_none() {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "node_id, wallet, or activation_code parameter required"
        })));
    }
    
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let current_window = now - (now % (4 * 60 * 60)); // Current 4h window
    
    if let Some(p2p) = blockchain.get_unified_p2p() {
        // Get active Super nodes
        let active_nodes = p2p.get_active_full_super_nodes();
        
        // Resolve node_id: prefer explicit node_id, then the wallet-bridge (on-chain reverse index —
        // resolves ANY registered node regardless of online/offline/banned, and needs no RAM activation
        // registry), and only last fall back to activation_code resolution.
        let target_node_id = if let Some(nid) = &node_id {
            Some(nid.clone())
        } else if let Some(w) = &wallet {
            blockchain.get_storage().get_nodes_by_wallet(w).ok()
                .and_then(|v| v.into_iter().next().map(|(id, _, _)| id))
        } else if let Some(code) = &activation_code {
            // CRITICAL FIX v2.76: Genesis node activation code mapping
            // Genesis nodes use QNET-BOOT-000X-STRAP format
            // Map to genesis_node_00X for network identification
            if code.starts_with("QNET-BOOT-") && code.ends_with("-STRAP") {
                // Extract bootstrap ID (e.g., "0001" from "QNET-BOOT-0001-STRAP")
                if let Some(id_part) = code.strip_prefix("QNET-BOOT-").and_then(|s| s.strip_suffix("-STRAP")) {
                    // Remove leading zeros: "0001" → "001"
                    let trimmed = id_part.trim_start_matches('0');
                    if !trimmed.is_empty() {
                        let genesis_node_id = format!("genesis_node_{:0>3}", trimmed);
                        Some(genesis_node_id)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                // CRITICAL: Look up node_id from activation registry
                // This links the activation_code (from mobile app) to the network node_id
                let registry = &*GLOBAL_ACTIVATION_REGISTRY;
                if let Some(found_node_id) = registry.get_node_id_by_activation_code(code).await {
                    Some(found_node_id)
                } else {
                    // Fallback: try to find in active nodes by partial match
                    active_nodes.iter()
                        .find(|(id, _, _)| id.contains(code) || code.contains(id))
                        .map(|(id, _, _)| id.clone())
                }
            }
        } else {
            None
        };
        
        if let Some(ref target_id) = target_node_id {
            // Check if node is in active list
            let node_info = active_nodes.iter()
                .find(|(id, _, _)| id == target_id);
            
            if let Some((found_id, node_type, last_seen)) = node_info {
                // v35: heartbeat count from the on-chain tally (Account.heartbeat_slots popcount).
                let cur_height = blockchain.get_height().await;
                let hb_epoch = cur_height / 14400;
                let heartbeat_count = blockchain.get_account(found_id).await.ok().flatten()
                    .map(|a| crate::node::BlockchainNode::account_heartbeat_count(&a, hb_epoch))
                    .unwrap_or(0);
                
                // Determine required heartbeats based on node type (case-insensitive)
                // v3.18: Only Super nodes (Full removed)
                let required_heartbeats = match node_type.to_lowercase().as_str() {
                    "super" => 9,  // Super nodes need 9/10
                    _ => 9,        // v3.18: Default to Super (Full removed)
                };
                
                // RAM peer freshness OR the deterministic on-chain heartbeat (identical on
                // every node): a healthy super must never read offline just because THIS
                // node's peer view lagged after a reconnect.
                let chain_alive = blockchain.get_storage().heartbeat_recent_onchain(found_id, cur_height);
                let is_online = (now - last_seen < 15 * 60) || chain_alive;

                // Pacing: heartbeat_count is the IN-PROGRESS epoch popcount (one bit per 1440-block
                // subwindow), so a healthy node only reaches the full threshold near epoch end. Compare
                // against elapsed subwindows so mid-epoch display doesn't false-alarm a node on pace.
                let expected = ((cur_height % 14400) / 1440) as u32;
                let on_pace = is_online && (heartbeat_count as u32) + 1 >= expected;

                // STRICT on-chain truth: registered IFF reg_height is stamped (node_<id>.reg_height).
                // NEVER the RAM roster and NEVER get_node_wallet — a discovery-cache row keeps
                // final_wallet with reg_height=None and would fabricate registered:true (the mask
                // that hid a never-landed NodeRegistration). Emission and producer candidacy both
                // derive from srtr_/reg_height, so this is the ONE truth the payout actually uses.
                let onchain = blockchain.get_storage().is_node_registration_onchain(found_id);

                // is_reward_eligible mirrors the EMISSION predicate (srtr_ ∩ heartbeat_count>=9) —
                // NOT the producer-selection predicate (no warmup/rep-floor: those gate selection,
                // not payout). on_pace is a mid-epoch APPROXIMATION of the boundary-finalized popcount.
                let is_reward_eligible = onchain && (heartbeat_count >= required_heartbeats || on_pace);

                // v2.96: CRITICAL FIX - Get reputation from LAST MACROBLOCK SNAPSHOT (not local state)
                // This ensures ALL nodes return SAME value (blockchain consensus)
                let reputation = if onchain {
                    serde_json::json!(get_reputation_from_snapshot(&blockchain, found_id).await)
                } else {
                    serde_json::Value::Null
                };

                // Get block height if available
                let block_height = blockchain.get_height().await;
                
                // v2.96: CRITICAL SECURITY FIX - Read pending rewards from BLOCKCHAIN, NOT RocksDB!
                // v2.97: CRITICAL FIX - Get wallet from BLOCKCHAIN (not memory)
                // This ensures ALL nodes return same value (on-chain consensus)
                // Prevents manipulation of local RocksDB to show fraudulent rewards
                // Memory can be lost on restart, blockchain is source of truth
                // The merkle reward_root claimable for the ON-CHAIN registered wallet — the same
                // figure the claim endpoint will quote, so every node answers alike.
                let pending_rewards = match blockchain.get_node_wallet(found_id).await {
                    Some(wallet) => wallet_claimable_qnc(&blockchain, &wallet).await,
                    None => {
                        if is_warn() {
                            println!("[WARN][API] node_status node_not_registered_onchain node={}", found_id);
                        }
                        0
                    }
                };
                
                return Ok(warp::reply::json(&json!({
                    "success": true,
                    "registered": onchain,
                    "onchain_registered": onchain,
                    "status": if onchain { "active" } else { "onboarding" },
                    "node_id": found_id,
                    "node_type": node_type,
                    "is_online": is_online,
                    "last_seen": last_seen,
                    "last_seen_ago_seconds": now - last_seen,
                    "heartbeat_count": heartbeat_count,
                    "required_heartbeats": required_heartbeats,
                    "is_reward_eligible": is_reward_eligible,
                    "reputation": reputation,
                    "current_block_height": block_height,
                    "current_window_start": current_window,
                    // Attention when offline, behind pace, or still onboarding (registration not landed).
                    "needs_attention": !onchain || !is_online || (heartbeat_count as u32) + 1 < expected,
                    // Rewards info (QNC tokens in smallest units) — wallet-scoped, status-independent.
                    "pending_rewards": pending_rewards
                })));
            }

            // Not in active Super/Genesis list — check light_node_registry (point-read: no full-map clone)
            if target_id.starts_with("light_") {
                if let Some(node) = p2p.get_light_node(target_id) {
                    let block_height = blockchain.get_height().await;
                    let pending_rewards = match blockchain.get_node_wallet(target_id).await {
                        Some(w) => wallet_claimable_qnc(&blockchain, &w).await,
                        None => 0,
                    };
                    // B: online = attested on-chain in the last committed epochs, OR attesting in the current
                    // (uncommitted) epoch, OR within the fresh-registration grace — mirrors handle_light_node_status
                    // so a just-(re)activated live node is not reported OFFLINE for up to a full epoch.
                    const WAKE_GRACE_SECS: u64 = 3 * 14400;
                    let fresh = now.saturating_sub(node.registered_at) < WAKE_GRACE_SECS;
                    let mut is_online = blockchain.get_storage().light_attested_recent_onchain(target_id, block_height)
                        || p2p.has_attestation_in_window(target_id)
                        || fresh;
                    // Same owner-shard verdict as handle_light_node_status (cached) — one answer everywhere.
                    if !is_online && shard_owner_says_active(target_id).await == Some(true) { is_online = true; }
                    // Strict on-chain registration truth; is_online stays a labeled approximation.
                    let onchain = blockchain.get_storage().is_node_registration_onchain(target_id);
                    return Ok(warp::reply::json(&json!({
                        "success": true,
                        "node_id": target_id,
                        "node_type": "Light",
                        "onchain_registered": onchain,
                        "is_online": is_online,
                        "last_seen": node.last_seen,
                        "last_seen_ago_seconds": now.saturating_sub(node.last_seen),
                        "heartbeat_count": 0,
                        "required_heartbeats": 1,
                        "is_reward_eligible": onchain && is_online,
                        "reputation": null,
                        "current_block_height": block_height,
                        // Attention when offline OR still onboarding (registration not landed) — mirrors
                        // the super branches so a non-earning light node is never shown all-clear.
                        "needs_attention": !onchain || !is_online,
                        "pending_rewards": pending_rewards
                    })));
                }
            }
        }

        // Resolved on-chain but not in the live roster ⇒ OFFLINE: report its REAL on-chain reputation
        // (a non-equivocating offline node is Good standing, NOT "Banned") so the wallet shows true
        // standing and earned rewards stay visible/claimable (reward is wallet-scoped, status-independent).
        // Truly-unresolved (no node_id) ⇒ not-found.
        if let Some(ref off_id) = target_node_id {
            // A node is registered IFF it has an on-chain reward wallet (get_node_wallet is
            // registry-backed, NO fallback). Registered+offline ⇒ its REAL reputation (offline ≠
            // banned), rewards stay visible/claimable (wallet-scoped). A node_id that resolves to NO
            // on-chain registration (e.g. a stale cached pseudonym on a fresh genesis) ⇒
            // registered:false + reputation:null — never "Banned", never a phantom "registered".
            match blockchain.get_node_wallet(off_id).await {
                Some(w) => {
                    // get_node_wallet proves a wallet row exists, NOT registration: a discovery-cache
                    // row keeps final_wallet with reg_height=None. Decide `registered` strictly so an
                    // offline cache-only node reads onboarding, not a phantom registered:true.
                    let onchain = blockchain.get_storage().is_node_registration_onchain(off_id);
                    let pending_rewards = wallet_claimable_qnc(&blockchain, &w).await;
                    // Absent from THIS node's RAM roster ≠ offline: the deterministic
                    // on-chain heartbeat index is the authority every node agrees on.
                    let cur_height = blockchain.get_height().await;
                    let chain_alive = blockchain.get_storage().heartbeat_recent_onchain(off_id, cur_height);
                    let hb_epoch = cur_height / 14400;
                    let heartbeat_count = blockchain.get_account(off_id).await.ok().flatten()
                        .map(|a| crate::node::BlockchainNode::account_heartbeat_count(&a, hb_epoch))
                        .unwrap_or(0);
                    let expected = ((cur_height % 14400) / 1440) as u32;
                    let on_pace = chain_alive && (heartbeat_count as u32) + 1 >= expected;
                    let reputation = if onchain {
                        serde_json::json!(get_reputation_from_snapshot(&blockchain, off_id).await)
                    } else {
                        serde_json::Value::Null
                    };
                    return Ok(warp::reply::json(&json!({
                        "success": true,
                        "registered": onchain,
                        "onchain_registered": onchain,
                        "status": if onchain { "active" } else { "onboarding" },
                        "node_id": off_id,
                        "is_online": chain_alive,
                        "last_seen": 0,
                        "heartbeat_count": heartbeat_count,
                        "required_heartbeats": 9,
                        "is_reward_eligible": onchain && (heartbeat_count >= 9 || on_pace),
                        "reputation": reputation,
                        "current_block_height": cur_height,
                        "needs_attention": !onchain || !chain_alive || (heartbeat_count as u32) + 1 < expected,
                        // Wallet-scoped, status-independent: earned rewards stay visible/claimable.
                        "pending_rewards": pending_rewards,
                        "message": if !onchain { "Node registration not on-chain yet (onboarding)." }
                                   else if chain_alive { "Node online (on-chain heartbeat)." }
                                   else { "Node registered but offline this window." }
                    })));
                }
                None => {
                    return Ok(warp::reply::json(&json!({
                        "success": true,
                        "registered": false,
                        "node_id": off_id,
                        "is_online": false,
                        "reputation": null,
                        "current_block_height": blockchain.get_height().await,
                        "needs_attention": true,
                        "pending_rewards": 0,
                        "message": "Node not registered on-chain yet."
                    })));
                }
            }
        }
        // Truly unresolved (no on-chain node for this wallet/activation_code) ⇒ NOT REGISTERED,
        // which is DISTINCT from banned. reputation=null (absent, not 0) + registered=false so the
        // wallet shows "not activated", never "Banned" — reputation 0 means proven equivocation ONLY.
        return Ok(warp::reply::json(&json!({
            "success": true,
            "registered": false,
            "node_id": target_node_id,
            "is_online": false,
            "last_seen": 0,
            "heartbeat_count": 0,
            "required_heartbeats": 9,
            "is_reward_eligible": false,
            "reputation": null,
            "current_block_height": blockchain.get_height().await,
            "needs_attention": true,
            "pending_rewards": 0,
            "message": "Node not registered on-chain yet."
        })));
    }
    
    Ok(warp::reply::json(&json!({
        "success": false,
        "error": "P2P system not available"
    })))
}

// FCM Push Service for Light Node Pings with Rate Limiting
// Google FCM limit: ~500 requests/second per project
// We use a global rate limiter to stay well under this limit

pub(crate) use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
// Note: Lazy is already imported at the top of the file

/// Global FCM rate limiter state
pub(super) static FCM_RATE_LIMITER: Lazy<FcmRateLimiter> = Lazy::new(|| FcmRateLimiter::new());

pub(super) struct FcmRateLimiter {
    /// Requests sent in current second
    pub(super) requests_this_second: AtomicU64,
    /// Current second timestamp
    pub(super) current_second: AtomicU64,
    /// Max requests per second (conservative limit)
    pub(super) max_per_second: u64,
}

impl FcmRateLimiter {
    fn new() -> Self {
        Self {
            requests_this_second: AtomicU64::new(0),
            current_second: AtomicU64::new(0),
            // Conservative limit: 100/sec per node (5 Genesis × 100 = 500 total)
            max_per_second: 100,
        }
    }
    
    /// Check if we can send, and increment counter if yes
    fn try_acquire(&self) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let current = self.current_second.load(AtomicOrdering::Relaxed);
        
        if now != current {
            // New second - reset counter
            self.current_second.store(now, AtomicOrdering::Relaxed);
            self.requests_this_second.store(1, AtomicOrdering::Relaxed);
            true
        } else {
            // Same second - check limit
            let count = self.requests_this_second.fetch_add(1, AtomicOrdering::Relaxed);
            count < self.max_per_second
        }
    }
    
    /// Wait until we can send (with timeout)
    async fn acquire(&self) -> bool {
        for _ in 0..10 {  // Max 10 attempts (1 second)
            if self.try_acquire() {
                return true;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }
        false  // Rate limit exceeded
    }
}

pub(super) struct FCMPushService {
    // FCM V1 API with Service Account authentication
    // Cached access token and expiry time
    pub(super) access_token: std::sync::Arc<tokio::sync::RwLock<Option<(String, std::time::Instant)>>>,
}

impl FCMPushService {
    fn new() -> Self {
        Self {
            access_token: std::sync::Arc::new(tokio::sync::RwLock::new(None)),
        }
    }
    
    /// Get OAuth2 access token from Service Account JSON
    async fn get_access_token(&self) -> Result<String, String> {
        // Check if we have a cached valid token (valid for 50 minutes, tokens last 60 min)
        {
            let token_guard = self.access_token.read().await;
            if let Some((token, expiry)) = token_guard.as_ref() {
                if expiry.elapsed().as_secs() < 3000 { // 50 minutes
                    return Ok(token.clone());
                }
            }
        }
        
        // Need to get new token
        let credentials_path = match std::env::var("GOOGLE_APPLICATION_CREDENTIALS") {
            Ok(path) if !path.is_empty() => path,
            _ => {
                // Fallback: try legacy FCM_SERVER_KEY for backwards compatibility
                if let Ok(key) = std::env::var("FCM_SERVER_KEY") {
                    if !key.is_empty() && key != "demo-key-for-testing" {
                        return Ok(key);
                    }
                }
                return Err("GOOGLE_APPLICATION_CREDENTIALS not set - only Genesis nodes send FCM".to_string());
            }
        };
        
        // Read service account JSON
        let sa_json = std::fs::read_to_string(&credentials_path)
            .map_err(|e| format!("Failed to read service account file: {}", e))?;
        
        let sa: serde_json::Value = serde_json::from_str(&sa_json)
            .map_err(|e| format!("Failed to parse service account JSON: {}", e))?;
        
        let client_email = sa["client_email"].as_str()
            .ok_or("Missing client_email in service account")?;
        let private_key = sa["private_key"].as_str()
            .ok_or("Missing private_key in service account")?;
        
        // Create JWT for OAuth2
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let jwt_header = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            r#"{"alg":"RS256","typ":"JWT"}"#
        );
        
        let jwt_claims = serde_json::json!({
            "iss": client_email,
            "scope": "https://www.googleapis.com/auth/firebase.messaging",
            "aud": "https://oauth2.googleapis.com/token",
            "iat": now,
            "exp": now + 3600
        });
        
        let jwt_claims_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            jwt_claims.to_string()
        );
        
        let signing_input = format!("{}.{}", jwt_header, jwt_claims_b64);
        
        // Sign with RSA private key
        use rsa::pkcs8::DecodePrivateKey;
        let private_key_pem = private_key.replace("\\n", "\n");
        let rsa_key = rsa::RsaPrivateKey::from_pkcs8_pem(&private_key_pem)
            .map_err(|e| format!("Failed to parse private key: {}", e))?;
        
        use rsa::pkcs1v15::SigningKey;
        use rsa::signature::{Signer, SignatureEncoding};
        use sha2::Sha256;
        
        let signing_key = SigningKey::<Sha256>::new(rsa_key);
        let signature = signing_key.sign(signing_input.as_bytes());
        let signature_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            signature.to_vec()
        );
        
        let jwt = format!("{}.{}", signing_input, signature_b64);
        
        // Exchange JWT for access token
        let client = reqwest::Client::new();
        let response = client.post("https://oauth2.googleapis.com/token")
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", &jwt),
            ])
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| format!("OAuth2 request failed: {}", e))?;
        
        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(format!("OAuth2 error: {}", error_text));
        }
        
        let token_response: serde_json::Value = response.json().await
            .map_err(|e| format!("Failed to parse OAuth2 response: {}", e))?;
        
        let access_token = token_response["access_token"].as_str()
            .ok_or("Missing access_token in OAuth2 response")?
            .to_string();
        
        // Cache the token
        {
            let mut token_guard = self.access_token.write().await;
            *token_guard = Some((access_token.clone(), std::time::Instant::now()));
        }
        
        println!("[FCM] 🔑 Obtained new OAuth2 access token");
        Ok(access_token)
    }
    
    async fn send_ping_notification(&self, device_token: &str, node_id: &str, challenge: &str, response_url: &str) -> Result<(), String> {
        // PRODUCTION: Real FCM notification using Google's FCM HTTP v1 API
        
        // Get OAuth2 access token (from Service Account or legacy key)
        let access_token = self.get_access_token().await?;
        
        // RATE LIMITING: Prevent exceeding Google's 500/sec limit
        if !FCM_RATE_LIMITER.acquire().await {
            return Err("FCM rate limit exceeded - try again later".to_string());
        }
        
        println!("[FCM] 📱 Sending FCM push to Light node: {} (token: {}...)", 
                 node_id, qnet_state::char_prefix(&device_token, 8));
        
        // Get project ID from environment or use default
        let project_id = std::env::var("FCM_PROJECT_ID").unwrap_or_else(|_| "qnet-wallet".to_string());
        
        // Create FCM message payload (V1 API format).
        // IMPORTANT: No top-level "notification" key — this is a data-only (silent) push.
        // On iOS, if "notification" is present and the app is killed, iOS intercepts the
        // push and shows a system banner WITHOUT waking the app for background processing.
        // A silent push (data-only + content-available:1) wakes the app in the background
        // so didReceiveRemoteNotification fires and JS setBackgroundMessageHandler can run.
        let message_payload = serde_json::json!({
            "message": {
                "token": device_token,
                "data": {
                    "action": "ping_response",
                    "node_id": node_id,
                    "challenge": challenge,
                    "response_url": response_url,
                    "quantum_secure": "true",
                    "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs().to_string()
                },
                "android": {
                    "priority": "high"
                },
                "apns": {
                    "headers": {
                        "apns-priority": "5",
                        "apns-push-type": "background"
                    },
                    "payload": {
                        "aps": {
                            "content-available": 1
                        }
                    }
                }
            }
        });
        
        // Create HTTP client for FCM V1 API
        let client = reqwest::Client::new();
        let fcm_url = format!("https://fcm.googleapis.com/v1/projects/{}/messages:send", project_id);
        
        // Send FCM notification with OAuth2 Bearer token
        match client.post(&fcm_url)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("Content-Type", "application/json")
            .json(&message_payload)
            .timeout(std::time::Duration::from_secs(10))
            .send().await {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    println!("[FCM] ✅ FCM push notification sent successfully to node {}", node_id);
                    Ok(())
                } else {
                    let error_text = response.text().await.unwrap_or_else(|_| "unknown error".to_string());
                    println!("[FCM] ❌ FCM API error {}: {}", status, error_text);
                    Err(format!("FCM API error: {} - {}", status, error_text))
                }
            }
            Err(e) => {
                println!("[FCM] ❌ FCM network error: {}", e);
                Err(format!("FCM network error: {}", e))
            }
        }
    }
}

// Calculate deterministic ping slot for Light node (0-239)
#[allow(dead_code)]
pub(super) fn calculate_ping_slot(node_id: &str) -> u32 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    
    let mut hasher = DefaultHasher::new();
    node_id.hash(&mut hasher);
    let hash = hasher.finish();
    
    // 240 slots in 4-hour window (1 minute each)
    (hash % 240) as u32
}

// Calculate next ping time for any node type (PRODUCTION: Unified for all node types)
#[allow(dead_code)]
pub(super) fn calculate_next_ping_time(node_id: &str) -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let current_4h_window = now - (now % (4 * 60 * 60)); // Start of current 4h window
    let slot = calculate_ping_slot(node_id);
    let slot_offset = (node_id.len() % 60) as u64; // 0-59 seconds within slot
    
    let ping_time = current_4h_window + (slot as u64 * 60) + slot_offset;
    
    // If ping time already passed, schedule for next 4h window
    if ping_time <= now {
        ping_time + (4 * 60 * 60)
    } else {
        ping_time
    }
}

// Calculate all ping times for Super nodes (10 pings per 4h window)
#[allow(dead_code)]
pub(super) fn calculate_full_super_ping_times(node_id: &str) -> Vec<u64> {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let current_4h_window = now - (now % (4 * 60 * 60)); // Start of current 4h window
    let base_slot = calculate_ping_slot(node_id); // Base randomization from node_id
    let slot_offset = (node_id.len() % 60) as u64; // 0-59 seconds within slot
    
    let mut ping_times = Vec::new();
    
    // CRITICAL: Distribute 10 pings evenly across 4-hour window with randomization
    // 4 hours = 240 minutes, 10 pings = every 24 minutes average
    for i in 0..10 {
        // Spread pings with base randomization + incremental offset
        let spread_slot = (base_slot + (i * 24)) % 240; // Every 24 minutes with randomized start
        let ping_time = current_4h_window + (spread_slot as u64 * 60) + slot_offset;
        
        // If ping time already passed, schedule for next 4h window  
        if ping_time <= now {
            ping_times.push(ping_time + (4 * 60 * 60));
        } else {
            ping_times.push(ping_time);
        }
    }
    
    ping_times.sort(); // Chronological order
    ping_times
}

// ============================================================================
// PRODUCTION: Sharded Light Node Ping System
// ============================================================================
// SCALABLE: Each Super node only pings Light nodes in its shard (1/256)
// NO DUPLICATES: Deterministic pinger selection (primary + 2 backups)
// DECENTRALIZED: Attestations gossiped to all nodes for reward eligibility
// ============================================================================
pub fn start_light_node_ping_service(blockchain: Arc<BlockchainNode>) {
    use tokio::sync::Semaphore;
    use futures::stream::{FuturesUnordered, StreamExt};
    use crate::unified_p2p::{SimplifiedP2P, PingerRole};
    
    // v2.89: GENESIS-ONLY PINGING
    // Genesis nodes need higher concurrency for 2M Light nodes each
    // Regular nodes don't ping at all anymore (return early from get_light_nodes_to_ping)
    let is_genesis_node = std::env::var("QNET_BOOTSTRAP_ID")
        .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
        .unwrap_or(false);
    
    // SCALABILITY (10M+ light nodes): each genesis handles 2M nodes.
    // Ping window = 240 min → 694 pings/sec per genesis.
    // At 50ms avg FCM latency: 694 * 0.05 = 35 concurrent minimum.
    // Use 1000 for comfortable headroom on burst registration waves.
    let max_concurrent_pings: usize = if is_genesis_node { 1000 } else { 100 };
    
    let blockchain_for_pings = blockchain.clone();
    
    tokio::spawn(async move {
        let semaphore = Arc::new(Semaphore::new(max_concurrent_pings));
        let mut check_interval = tokio::time::interval(tokio::time::Duration::from_secs(60));
        
        if is_genesis_node {
            println!("[GENESIS-PING] 🚀 Genesis ping service started (max {} concurrent, ~2M Light nodes)", 
                     max_concurrent_pings);
        } else {
            println!("[PING] 💤 Non-Genesis node - ping service passive (Genesis handles all pinging)");
        }
        
        // ================================================================
        // BOOTSTRAP SYNC: Wait for active nodes list to populate
        // ================================================================
        if let Some(p2p) = blockchain_for_pings.get_unified_p2p() {
            // Register ourselves first (ASYNC - proper Dilithium signature)
            p2p.register_as_active_node_async().await;
            
            // Request active nodes from peers
            p2p.request_active_nodes_sync();
            
            // Wait for sync (max 30 seconds, check every 2 seconds)
            let mut sync_attempts = 0;
            while sync_attempts < 15 {
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                let active_count = p2p.get_active_node_count();
                
                if active_count >= 3 {
                    println!("[PING] ✅ Bootstrap sync complete: {} active nodes", active_count);
                    break;
                }
                
                sync_attempts += 1;
                if sync_attempts % 5 == 0 {
                    // Re-request if not enough nodes
                    p2p.request_active_nodes_sync();
                    println!("[PING] ⏳ Waiting for active nodes sync... ({}/15)", sync_attempts);
                }
            }
            
            if p2p.get_active_node_count() < 2 {
                println!("[PING] ⚠️ Bootstrap sync incomplete, proceeding with {} active nodes", 
                         p2p.get_active_node_count());
            }
        }
        
        let mut last_reannounce = std::time::Instant::now();
        let mut last_flush = std::time::Instant::now(); // v3.41: WAL flush tracker

        // Deterministic per-node slot within the hour, so maintenance is staggered
        // across the roster instead of firing fleet-wide at the same instant.
        let cleanup_slot_offset: u64 = {
            let id = blockchain_for_pings.get_node_id();
            let h = Sha3_256::digest(id.as_bytes());
            u64::from_be_bytes(h[..8].try_into().unwrap_or([0u8; 8])) % 60
        };

        loop {
            check_interval.tick().await;
            
            let _now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            
            let current_slot = SimplifiedP2P::get_current_slot();
            
            // ================================================================
            // PERIODIC MAINTENANCE (every 10 minutes)
            // ================================================================
            if let Some(p2p) = blockchain_for_pings.get_unified_p2p() {
                // Re-announce ourselves every 10 minutes to stay in active list
                if last_reannounce.elapsed().as_secs() >= 600 {
                    p2p.register_as_active_node_async().await;
                    p2p.cleanup_stale_active_nodes();
                    last_reannounce = std::time::Instant::now();
                    println!("[PING] 🔄 Re-announced as active node, cleaned stale nodes");
                }
                
                // Cleanup old attestations every hour, offset per node. The slot is derived
                // from chain height, so an unoffset check fires within the same second on
                // every node and no quorum member is left serving during the sweep.
                if current_slot % 60 == cleanup_slot_offset {
                    // RAM cleanup
                    p2p.cleanup_old_attestations();

                    // PRODUCTION v2.78: RocksDB cleanup (persistent storage)
                    blockchain_for_pings.cleanup_old_storage_data().await;

                    // ─────────────────────────────────────────────────────────
                    // v20: CONSENSUS PK REGISTRY — IDLE LRU SWEEP
                    // ─────────────────────────────────────────────────────────
                    // Reclaims registry slots held by super-nodes that have not
                    // produced a single signature-verified consensus message
                    // within `QNET_PK_REGISTRY_IDLE_DAYS` (default 30). Pinned
                    // genesis-anchor entries are never evicted regardless of
                    // staleness — BFT safety requires their PKs always
                    // available for verification.
                    //
                    // The sweep is the proactive counterpart to the in-line
                    // single-shot eviction performed by register_*() when the
                    // cap is hit. Running once an hour keeps the registry
                    // responsive to operator churn at thousand-node scale
                    // without amplifying the lock-contention surface.
                    //
                    // Cost: O(N) read pass + bounded write pass over the
                    // PK registry. At 100K entries with ~5% idle, expected
                    // wall-clock ~10 ms per sweep — negligible at hourly
                    // cadence.
                    // ─────────────────────────────────────────────────────────
                    let idle_threshold =
                        qnet_consensus::consensus_crypto::consensus_pk_registry_idle_threshold_secs();
                    let evicted =
                        qnet_consensus::consensus_crypto::evict_idle_consensus_pks(idle_threshold);
                    if evicted > 0 && crate::node::is_info() {
                        println!(
                            "[INFO][CLEANUP] consensus_pk_idle_sweep evicted={} threshold_secs={}",
                            evicted, idle_threshold
                        );
                    }
                }
            }
            
            // ================================================================
            // v3.41: PERIODIC WAL FLUSH (every 5 minutes)
            // Forces all CF memtables to SST, allowing old WAL files to be deleted.
            // Without this, rarely-written CFs keep stale memtables indefinitely,
            // preventing WAL cleanup even with set_max_total_wal_size.
            // ================================================================
            if last_flush.elapsed().as_secs() >= 300 {
                // Run the WAL-maintenance flush OFF the consensus runtime via spawn_blocking.
                // flush_all_background (set_wait(false)) skips the wait-for-complete but CAN still
                // briefly stall under an L0 backlog, so it must never run on a runtime worker — the
                // old synchronous flush_all here stalled behind the 2-job pool and starved block
                // application. Fire-and-forget; the helper logs any per-CF failure.
                let storage_for_flush = blockchain_for_pings.get_storage();
                tokio::task::spawn_blocking(move || {
                    let _ = storage_for_flush.flush_all_background();
                });
                last_flush = std::time::Instant::now();
            }
            
            // ================================================================
            // LIGHT NODE PINGING (v2.89: Genesis-only)
            // ================================================================
            
            if let Some(p2p) = blockchain_for_pings.get_unified_p2p() {
                
                // Get Light nodes to ping (ONLY Genesis nodes get results now)
                let nodes_to_ping = p2p.get_light_nodes_to_ping();
                
                if !nodes_to_ping.is_empty() {
                    // v2.89: Batch logging for Genesis (avoid 139 logs/sec)
                    if is_genesis_node {
                        if is_info() {
                            println!("[INFO][GENESIS-PING] Slot {}: {} Light nodes to ping", 
                                     current_slot, nodes_to_ping.len());
                        }
                    } else {
                        println!("[LIGHT] 📡 Slot {}: {} Light nodes to ping", 
                                 current_slot, nodes_to_ping.len());
                    }
                    
                    let mut futures = FuturesUnordered::new();
                    
                    for (light_node, role) in nodes_to_ping {
                        let semaphore = semaphore.clone();
                        let blockchain = blockchain_for_pings.clone();
                        // G2: server-stamped challenge bound to THIS node (FCM-safe, stateless).
                        let challenge = make_challenge_stamp(&light_node.node_id);
                        let delay = p2p.get_ping_delay(role);
                        let _our_node_id = blockchain.get_node_id();
                        
                        futures.push(async move {
                            // BACKUP DELAY: Wait for primary to attempt first
                            if delay.as_secs() > 0 {
                                tokio::time::sleep(delay).await;
                                
                                // Re-check if attestation appeared while waiting
                                if let Some(p2p) = blockchain.get_unified_p2p() {
                                    if p2p.has_attestation(&light_node.node_id, current_slot) {
                                        // Primary succeeded, skip
                                        return;
                                    }
                                }
                            }
                            
                            // Acquire semaphore permit
                            let _permit = match semaphore.acquire().await {
                                Ok(p) => p,
                                Err(_) => { println!("[RPC] ⚠️ Semaphore closed"); return; }
                            };
                            
                            let role_str = match role {
                                PingerRole::Primary => "PRIMARY",
                                PingerRole::Backup1 => "BACKUP1",
                                PingerRole::Backup2 => "BACKUP2",
                                PingerRole::None => "NONE",
                            };
                            
                            // Send ping based on push type
                            match light_node.push_type {
                                crate::unified_p2p::PushType::FCM => {
                                    // FCM push notification (Google Play users).
                                    // Load the REAL FCM token from local RocksDB storage.
                                    // The gossiped registry only carries a privacy hash —
                                    // the actual 152-char token is stored in fcm_tokens CF.
                                    let real_token_opt = blockchain.get_storage()
                                        .get_fcm_data(&light_node.node_id)
                                        .map(|(token, _, _)| token);

                                    if let Some(real_token) = real_token_opt {
                                        let our_response_url = {
                                            use crate::genesis_constants::GENESIS_NODE_IPS;
                                            let bid = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or_default();
                                            GENESIS_NODE_IPS.iter()
                                                .find(|(_, id)| *id == bid)
                                                .map(|(ip, _)| format!("http://{}:8001", ip))
                                                .unwrap_or_default()
                                        };
                                        let fcm = FCMPushService::new();
                                        match fcm.send_ping_notification(&real_token, &light_node.node_id, &challenge, &our_response_url).await {
                                            Ok(()) => {
                                                if crate::node::is_info() {
                                                    println!("[INFO][LIGHT] fcm_sent role={} node={} slot={}",
                                                             role_str, light_node.node_id, current_slot);
                                                }
                                            }
                                            Err(e) => {
                                                if !e.contains("FCM_SERVER_KEY not configured") {
                                                    if crate::node::is_warn() {
                                                        println!("[WARN][LIGHT] fcm_error role={} node={} err={}",
                                                                 role_str, light_node.node_id, e);
                                                    }
                                                }
                                            }
                                        }
                                    } else {
                                        let now = std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .unwrap_or_default()
                                            .as_secs();
                                        {
                                            let mut challenges = PENDING_CHALLENGES.lock();
                                            // v10.0: Bound PENDING_CHALLENGES to 10K; cleanup expired before insert
                                            const MAX_PENDING_CHALLENGES: usize = 10_000;
                                            if challenges.len() >= MAX_PENDING_CHALLENGES {
                                                challenges.retain(|_, c| c.expires_at > now);
                                                // If still full after cleanup, skip insert
                                                if challenges.len() >= MAX_PENDING_CHALLENGES {
                                                    println!("[WARN][RPC] pending_challenges_full size={}", challenges.len());
                                                }
                                            }
                                            if challenges.len() < MAX_PENDING_CHALLENGES {
                                                challenges.insert(light_node.node_id.clone(), PendingChallenge {
                                                    challenge: challenge.clone(),
                                                    created_at: now,
                                                    expires_at: now + 180,
                                                });
                                            }
                                        }
                                        if crate::node::is_debug() {
                                            println!("[DBG][LIGHT] fcm_token_missing role={} node={} action=polling_fallback",
                                                     role_str, light_node.node_id);
                                        }
                                    }
                                }
                                crate::unified_p2p::PushType::UnifiedPush => {
                                    // UnifiedPush notification (F-Droid users)
                                    if let Some(endpoint) = &light_node.unified_push_endpoint {
                                        let up_response_url = {
                                            use crate::genesis_constants::GENESIS_NODE_IPS;
                                            let bid = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or_default();
                                            GENESIS_NODE_IPS.iter()
                                                .find(|(_, id)| *id == bid)
                                                .map(|(ip, _)| format!("http://{}:8001", ip))
                                                .unwrap_or_default()
                                        };
                                        let client = reqwest::Client::new();
                                        let payload = serde_json::json!({
                                            "action": "ping_response",
                                            "node_id": light_node.node_id,
                                            "challenge": challenge,
                                            "response_url": up_response_url,
                                            "timestamp": std::time::SystemTime::now()
                                                .duration_since(std::time::UNIX_EPOCH)
                                                .unwrap_or_default()
                                                .as_secs()
                                        });
                                        
                                        match client.post(endpoint)
                                            .header("Content-Type", "application/json")
                                            .json(&payload)
                                            .timeout(std::time::Duration::from_secs(10))
                                            .send()
                                            .await 
                                        {
                                            Ok(response) if response.status().is_success() => {
                                                println!("[LIGHT] 📤 {} sent UnifiedPush to {} slot {} (awaiting response)", 
                                                         role_str, light_node.node_id, current_slot);
                                            }
                                            Ok(response) => {
                                                println!("[LIGHT] ❌ {} UnifiedPush error for {}: HTTP {}", 
                                                         role_str, light_node.node_id, response.status());
                                            }
                                            Err(e) => {
                                                println!("[LIGHT] ❌ {} UnifiedPush network error for {}: {}", 
                                                         role_str, light_node.node_id, e);
                                            }
                                        }
                                    } else {
                                        println!("[LIGHT] ⚠️ {} has UnifiedPush type but no endpoint", light_node.node_id);
                                    }
                                }
                                crate::unified_p2p::PushType::Polling => {
                                    // Polling mode - store challenge for device to fetch
                                    let now = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_secs();
                                    
                                    {
                                        let mut challenges = PENDING_CHALLENGES.lock();
                                        // v10.0: Bound PENDING_CHALLENGES to 10K
                                        const MAX_PENDING_CHALLENGES: usize = 10_000;
                                        if challenges.len() >= MAX_PENDING_CHALLENGES {
                                            challenges.retain(|_, c| c.expires_at > now);
                                        }
                                        if challenges.len() < MAX_PENDING_CHALLENGES {
                                            challenges.insert(light_node.node_id.clone(), PendingChallenge {
                                                challenge: challenge.clone(),
                                                created_at: now,
                                                expires_at: now + 180, // 3 minute expiry
                                            });
                                        }
                                    }

                                    println!("[INFO][LIGHT] challenge_stored role={} node={} slot={}",
                                             role_str, light_node.node_id, current_slot);
                                }
                            }
                        });
                    }
                    
                    // Wait for all Light node pings
                    while futures.next().await.is_some() {}
                }
                
                // B: no ping-failure accrual — liveness is derived from committed attestation recency and
                // the wake-scheduler stops waking dormant nodes on its own. Reactivation = self-attest.
            }
            
            // ================================================================
            // FULL/SUPER NODE HEARTBEAT (Self-Attestation)
            // ================================================================
            // Note: Super nodes use self-attestation (heartbeats) not network pings
            // The heartbeat service is started separately in unified_p2p.rs
            // Here we just verify heartbeats from other nodes
            
            // ================================================================
            // SYNC: Request registry updates periodically
            // ================================================================
            if current_slot % 10 == 0 {  // Every 10 minutes
                if let Some(p2p) = blockchain_for_pings.get_unified_p2p() {
                    p2p.request_light_node_registry_sync();
                }
            }
        }
    });
    
    // REMOVED: Background reward distribution task
    // Emission now happens as part of block production (every 14,400 blocks = 4 hours)
    // See node.rs block production logic for emission integration
    
    // ═══════════════════════════════════════════════════════════════════════════
    // REMOVED: PassiveRecovery - Not synchronized across network
    // ═══════════════════════════════════════════════════════════════════════════
    // 
    // WHY REMOVED:
    // 1. NOT DETERMINISTIC: Each node runs on its own timer
    //    - Node A: gives +1% to node X at 10:00
    //    - Node B: gives +1% to node X at 10:03
    //    - Result: Different reputation on different nodes!
    //
    // 2. NOT SYNCHRONIZED: No P2P message to announce recovery
    //    - New nodes don't know about past recovery events
    //    - Offline nodes miss recovery and fall behind
    //
    // 3. ABUSE POTENTIAL: Nodes can stay online without participating
    //    - Get +1% every 4 hours for doing nothing
    //    - Recover from 10% to 70% in 10 days without contributing
    //
    // NEW ARCHITECTURE (deterministic_reputation.rs):
    // - Reputation computed ONLY from blockchain data
    // - Recovery happens when node successfully produces blocks again
    // - All nodes compute same reputation from same blocks
    // ═══════════════════════════════════════════════════════════════════════════
    
    // Separate task for device cleanup (every 24 hours)
    tokio::spawn(async {
        let mut cleanup_interval = tokio::time::interval(tokio::time::Duration::from_secs(24 * 60 * 60)); // 24 hours
        
        loop {
            cleanup_interval.tick().await;
            
            println!("[CLEANUP] 🧹 Starting 24-hour device cleanup cycle");
            
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            
            let mut total_cleaned = 0;
            let mut nodes_cleaned = 0;
            
            // Clean up inactive devices from all Light nodes
            {
                let mut registry = LIGHT_NODE_REGISTRY.lock();
                
                for (node_id, light_node) in registry.iter_mut() {
                    let devices_before = light_node.devices.len();
                    
                    // Remove devices inactive for more than 24 hours
                    light_node.devices.retain(|device| {
                        let is_recent = (now - device.last_active) < 24 * 60 * 60;
                        let keep_device = device.is_active && is_recent;
                        
                        if !keep_device {
                            println!("[CLEANUP] 📱 Removing inactive device {} from Light node {} (inactive for {}h)", 
                                     qnet_state::char_prefix(&device.device_id, 8), 
                                     node_id,
                                     (now - device.last_active) / 3600);
                        }
                        
                        keep_device
                    });
                    
                    let devices_after = light_node.devices.len();
                    if devices_after < devices_before {
                        nodes_cleaned += 1;
                        total_cleaned += devices_before - devices_after;
                        
                        println!("[CLEANUP] 🧹 Light node {} cleaned: {} devices removed", 
                                 node_id, devices_before - devices_after);
                    }
                    
                    // If no devices left, mark node as inactive
                    if light_node.devices.is_empty() {
                        light_node.reward_eligible = false;
                        println!("[CLEANUP] ⚠️ Light node {} marked inactive (no devices)", node_id);
                    }
                }
            }
            
            if total_cleaned > 0 {
                println!("[CLEANUP] ✅ Cleanup completed: {} devices removed from {} Light nodes", 
                         total_cleaned, nodes_cleaned);
            } else {
                println!("[CLEANUP] ✅ No inactive devices found - all Light nodes healthy");
            }
        }
    });
}

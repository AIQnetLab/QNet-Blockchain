//! Light-node registration, token refresh, ping challenge/response and the ping service.

use super::*;

pub(super) async fn handle_light_node_token_refresh(
    remote_addr: Option<std::net::SocketAddr>,
    req:         TokenRefreshRequest,
    blockchain:  Arc<BlockchainNode>,
) -> Result<impl warp::Reply, warp::Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};
    use crate::light_binding as lb;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    // The address's budget of failed requests (L-2): every refusal up to and including the signature check spends
    // it (`fail`); a refresh the bound device signed spends none, and is held by the node's own limit.
    if let Some(wait) = TOKEN_REFRESH_FAIL_LIMIT.blocked(remote_addr, now) {
        let mut v = lb::Refusal::RateLimited.to_json();
        v["retry_after_seconds"] = serde_json::json!(wait);
        return Ok(warp::reply::json(&v));
    }
    let fail = |v: serde_json::Value| -> Result<warp::reply::Json, Rejection> {
        TOKEN_REFRESH_FAIL_LIMIT.charge(remote_addr, now);
        Ok(warp::reply::json(&v))
    };

    // Timestamp within 5 minutes
    if now.abs_diff(req.timestamp) > 300 {
        return fail(serde_json::json!({
            "success": false, "error": "Request expired", "reason": "expired"
        }));
    }

    let pt = lb::canonical_push_type(Some(req.push_type.as_str()));
    // v2 signs the push target itself (the token, or the endpoint for UnifiedPush); the legacy form
    // needs a token, as before.
    let target = lb::push_target(pt, &req.device_token, req.endpoint.as_deref()).to_string();
    let well_formed = match req.seq {
        None => !req.device_token.is_empty(),
        Some(_) => pt == "polling" || !target.is_empty(),
    };
    if req.node_id.is_empty() || !well_formed {
        return fail(serde_json::json!({
            "success": false, "error": "node_id and device_token required", "reason": "bad_request"
        }));
    }
    // Every form: the record's endpoint is where the genesis nodes POST, on each push and each wake.
    let endpoint_sent = if req.seq.is_some() { Some(target.as_str()) } else { req.endpoint.as_deref().filter(|e| !e.is_empty()) };
    if let (Some(ep), "unifiedpush") = (endpoint_sent, pt) {
        if let Err(e) = validate_unified_push_endpoint(ep) {
            return fail(serde_json::json!({
                "success": false, "error": format!("Invalid UnifiedPush endpoint: {}", e), "reason": "bad_request"
            }));
        }
    }

    // PING DELEGATION v7.1: token-refresh auth is rooted in the node's Dilithium ping-delegation
    // chain (same proven pattern as the `ping_dilithium:` arm in verify_light_node_ping), NOT the
    // RAM-poisonable Ed25519 gossip pubkey. The delegation cert is verified against the IMMUTABLE
    // on-chain key (load_vrf_public_key), so an attacker who poisons the RAM registry cannot forge
    // this node's token-refresh. Fail-closed at every missing/mismatch step.
    // Request signature format: "ping_dilithium:<dilithium_sig>" (v2 also takes the bare signature).
    let inner_sig = match req.signature.strip_prefix("ping_dilithium:") {
        Some(s) => s,
        None if req.seq.is_some() => req.signature.as_str(),
        None => {
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] token_refresh_bad_sig_prefix node={}", req.node_id);
            }
            return fail(serde_json::json!({
                "success": false, "error": "Invalid signature", "reason": "bad_signature"
            }));
        }
    };

    // C: ping keys live in the dedicated CF (point-read), not the trimmed RAM registry.
    let binding = blockchain.get_storage().get_light_binding(&req.node_id)
        .filter(|b| !b.ping_pubkey.is_empty() && !b.cert.is_empty());
    let Some(binding) = binding else {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] token_refresh_ping_delegation_missing node={}", req.node_id);
        }
        return fail(serde_json::json!({
            "success": false, "error": "Node not found or missing ping delegation", "reason": "not_registered"
        }));
    };
    let ping_pk_hex = binding.ping_pubkey.clone();

    // The identity the delegation must verify under: the committed key when the chain holds one, else
    // the key the device recorded when it last proved itself against the committed hash. Fail-closed.
    let onchain_pk_hex = match blockchain.get_storage().resolve_light_identity_pk(&req.node_id, None) {
        Some(hex) => hex,
        None => {
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] token_refresh_no_onchain_key node={}", req.node_id);
            }
            return fail(serde_json::json!({
                "success": false, "error": "Invalid signature", "reason": "bad_signature"
            }));
        }
    };

    // Step 1: Verify the delegation cert authorizing ping_pubkey, against the on-chain key, in the form
    // the binding was made (v2 once a v2 binding exists).
    let Some(form) = lb::verify_delegation(&binding.cert, &ping_pk_hex, &req.node_id, &onchain_pk_hex) else {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] token_refresh_delegation_cert_invalid node={}", req.node_id);
        }
        return fail(serde_json::json!({
            "success": false, "error": "Invalid signature", "reason": "bad_signature"
        }));
    };

    // Step 2: Verify the token-refresh signature against the authorized ping_pubkey.
    // Message string MUST stay byte-identical to what the mobile signs.
    let message = match req.seq {
        None => format!("token_refresh:{}:{}", req.node_id, req.timestamp),
        // v2 (U7): the preimage binds the push target and the sequence.
        Some(seq) => lb::token_refresh_v2_message(&req.node_id, &target, seq, req.timestamp),
    };
    if !verify_mobile_dilithium_signature(&message, inner_sig, &ping_pk_hex) {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] token_refresh_bad_sig node={}", req.node_id);
        }
        return fail(serde_json::json!({
            "success": false, "error": "Invalid signature", "reason": "bad_signature"
        }));
    }
    // The refresh belongs to the stored binding. Judged only once the bound device's key signed it, so
    // the binding's form and sequence are told to nobody else: a legacy refresh (its token is not
    // signed) is taken only while no v2 binding exists, a v2 one only at the stored sequence.
    match req.seq {
        None if !binding.never_v2() => return Ok(warp::reply::json(&lb::Refusal::BindV2Required.to_json())),
        Some(_) if form.seq() != req.seq => return Ok(warp::reply::json(&lb::Refusal::StaleSeq.to_json())),
        _ => {}
    }
    let seq = req.seq.unwrap_or(0);
    // A v2 record keeps exactly what the refresh signs (as /bind does): the token for FCM, the
    // endpoint for UnifiedPush, nothing for polling. A legacy record keeps the fields as sent.
    let (rec_token, rec_endpoint): (String, Option<String>) = match (req.seq, pt) {
        (None, _) => (req.device_token.clone(), req.endpoint.clone()),
        (Some(_), "fcm") => (req.device_token.clone(), None),
        (Some(_), "unifiedpush") => (String::new(), req.endpoint.clone()),
        (Some(_), _) => (String::new(), None),
    };
    // A legacy record keeps the wallet key its refresh was proven under (the delegation's), so it
    // belongs to the legacy binding here and displaces a record someone else planted.
    let writer = if req.seq.is_none() { lb::record_writer(&onchain_pk_hex) } else { String::new() };

    // LWW record: an unchanged triple keeps its original stamp; a changed one is stamped now
    // by this (serving) genesis — the ordering authority for the update. The peer fan-out runs
    // in BOTH cases: the old unchanged-skip also skipped the sync, so a peer that missed the
    // original update (the shard-owner pinger included) stayed stale forever.
    let stored = blockchain.get_storage().get_fcm_entry(&req.node_id);
    let unchanged = stored.as_ref().map(|e|
        e.token == rec_token && e.push_type == pt && e.endpoint.as_deref() == rec_endpoint.as_deref()
            && e.seq == seq && e.writer == writer
    ).unwrap_or(false);
    // A v2 refresh older than the message that set the channel now (a replay of an earlier refresh, or
    // the device's clock went back) is refused before the budget, as the write below would refuse it.
    if !unchanged && req.seq.is_some()
        && stored.as_ref().map_or(false, |e| (seq, req.timestamp) < (e.seq, e.updated_at)) {
        return Ok(warp::reply::json(&lb::Refusal::Expired.to_json()));
    }
    // The node's budget is spent only by a refresh that changes the channel: a replay of a captured
    // refresh inside its window cannot use it up and lock out the device's real refresh.
    if !unchanged && !TOKEN_REFRESH_NODE_LIMIT.allows(&req.node_id, now) {
        return Ok(warp::reply::json(&lb::Refusal::RateLimited.to_json()));
    }
    // Monotonic bump past the stored stamp: a genuinely newer event must supersede even
    // when this genesis's clock lags the one that stamped the old record. A v2 record is ordered by
    // the refresh's own signed time instead, as every peer orders it, so a replayed refresh or attach
    // never takes the channel back.
    let record_ts = if unchanged {
        stored.as_ref().map(|e| e.updated_at).unwrap_or(now)
    } else if req.seq.is_some() {
        req.timestamp
    } else {
        std::cmp::max(now, stored.as_ref().map(|e| e.updated_at.saturating_add(1)).unwrap_or(now))
    };

    if !unchanged {
        let written = if req.seq.is_some() {
            blockchain.get_storage().save_fcm_token_seq(&req.node_id, &rec_token, pt, rec_endpoint.as_deref(), record_ts, seq)
        } else {
            blockchain.get_storage().save_fcm_token_by(&req.node_id, &rec_token, pt, rec_endpoint.as_deref(), record_ts, &writer)
        };
        match written {
            Ok(true) => {}
            // The binding's channel was set by a message signed later than this refresh.
            Ok(false) => return Ok(warp::reply::json(&lb::Refusal::Expired.to_json())),
            Err(e) => {
                println!("[WARN][LIGHT] token_refresh_save_failed node={} err={}", req.node_id, e);
                return Ok(warp::reply::json(&serde_json::json!({
                    "success": false, "error": "Storage error"
                })));
            }
        }
        if let Some(p2p) = blockchain.get_unified_p2p() {
            p2p.refresh_light_node_push_channel(&blockchain.get_storage(), &req.node_id);
        }
        if crate::node::is_info() {
            println!("[INFO][LIGHT] token_refreshed node={} push={} seq={}", req.node_id, pt, seq);
        }
    } else if crate::node::is_debug() {
        println!("[DBG][LIGHT] token_refresh_unchanged node={} resync_peers=true", req.node_id);
    }
    // A v2 record travels with the device's own signatures, so each peer re-verifies it (H5).
    let proof = req.seq.map(|_| TokenSyncProof {
        identity_pubkey: onchain_pk_hex.clone(),
        ping_pubkey: ping_pk_hex.clone(),
        delegation_cert: binding.cert.clone(),
        kind: "refresh".to_string(),
        sig: inner_sig.to_string(),
        sig_ts: req.timestamp,
    });

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
        let token_clone = rec_token.clone();
        let pt_clone = pt.to_string();
        let ep_clone = rec_endpoint.clone();
        let our_ip = {
            let bid = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or_default();
            GENESIS_NODE_IPS.iter().find(|(_, id)| *id == bid)
                .map(|(ip, _)| ip.to_string()).unwrap_or_default()
        };
        tokio::spawn(async move {
            sync_fcm_token_to_genesis_peers(&node_id_clone, &token_clone, &pt_clone, ep_clone.as_deref(), &our_ip, record_ts, seq, proof, &writer, "", "").await;
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

/// The legacy register's answer for an on-chain node the caller cannot re-attach: the same whatever is
/// bound to the node, so it tells nothing the public status does not.
fn already_registered_reply(pseudonym: &str) -> serde_json::Value {
    let (next_ping_time, window_number) = crate::unified_p2p::SimplifiedP2P::get_next_ping_time(pseudonym);
    json!({
        "success": true,
        "already_registered": true,
        "node_id": pseudonym,
        "node_type": "light",
        "next_ping_time": next_ping_time,
        "next_ping_window": window_number,
        "message": "Node already registered. Your existing node has been restored."
    })
}

/// Whether the legacy register may write the push record. For a node already on chain (`reactivating`) its only
/// proof is a static signature over the public wallet address, which anyone who saw it can replay; a replay brings
/// no ping key the chain's key newly delegated, so only a ping-key write that applied lets the record change. An
/// unchanged or refused key (a replay of the current delegation or an older one) keeps the stored record; the
/// installed app changes its token through the token refresh, which its ping key signs with a time (M-8).
pub(crate) fn legacy_record_write_allowed(reactivating: bool, key_write: Option<crate::storage::PingKeyWrite>) -> bool {
    !reactivating || key_write == Some(crate::storage::PingKeyWrite::Applied)
}

/// The legacy register's ownership rule for a registration not yet on chain, the chain door's own: the
/// wallet derives from the ML-DSA-65 key that signs it, or from the burning Solana address whose key
/// signs the activation.
pub(crate) fn legacy_register_wallet_bound(wallet: &str, quantum_pubkey: &str, burn_wallet: &str) -> bool {
    crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(quantum_pubkey).as_deref() == Some(wallet)
        || crate::crypto::solana_derivation::eon_from_solana_address(burn_wallet) == wallet
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
        // Chain only: this process's RAM registry also holds nodes whose registration tx never landed,
        // and those must take the full path below to get tx_required and their registration_proof.
        if registered_on_chain {
            // SECURITY: reactivation/ping-key rotation may run ONLY if the caller proves the node's
            // established identity. The quantum keypair is activation-derived (immutable), so the legit
            // owner presents the pubkey already committed as the node's VRF key. The mobile Dilithium sig
            // opens over the PUBLIC wallet_address (forgeable with any key), so we bind here: incoming
            // quantum_pubkey MUST equal the committed VRF key. Match → reactivate (skip burn re-verify).
            // Mismatch or key-not-yet-committed-here → mutate nothing, return already_registered inertly
            // (a synced genesis — the shard owner always is — performs the real reactivation).
            // Resolved, not point-read: the chain holds only a HASH of a light node's key, so a full-key
            // lookup answers None for every light node and this branch could never say yes - a legitimate
            // owner re-registering was refused and its ping-key rotation never ran.
            // The key's own signature is checked here too, before anything about the node's binding is
            // told: a caller without the committed key and its signature gets the same answer whatever is
            // bound (legacy, v2, or withdrawn by the owner's Stop).
            let identity_ok = blockchain.get_storage()
                .resolve_light_identity_pk(&pseudonym, Some(&register_request.quantum_pubkey))
                .map(|committed| committed.eq_ignore_ascii_case(&register_request.quantum_pubkey))
                .unwrap_or(false)
                && verify_mobile_dilithium_signature(
                    &register_request.wallet_address, &register_request.quantum_signature, &register_request.quantum_pubkey);
            if !identity_ok {
                println!("[INFO][LIGHT] registration_rejected reason=already_registered pseudonym={}", pseudonym);
                return Ok(warp::reply::json(&already_registered_reply(&pseudonym)));
            }
            // Once a v2 binding exists only /light-node/bind changes the device: this branch authenticates
            // with a static signature over a public address, which any listener can replay.
            if !legacy_attach_allowed(blockchain.get_storage().get_light_binding(&pseudonym).as_ref()) {
                println!("[INFO][LIGHT] registration_rejected reason=bind_v2_required pseudonym={}", pseudonym);
                return Ok(warp::reply::json(&crate::light_binding::Refusal::BindV2Required.to_json()));
            }
            reactivating_existing = true;
            println!("[INFO][LIGHT] reactivation_on_register pseudonym={}", pseudonym);
        }
        // One wallet, one node (wallet_one_node gate at this node's next height): a fresh activation for a wallet
        // that already has another node on chain is refused, as the submit door and block validation refuse it.
        // After the return above, so a node already on chain keeps its answer.
        if !reactivating_existing {
            let next = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire).saturating_add(1);
            if let Some((other, _)) = crate::node::BlockchainNode::wallet_one_node_other(
                &blockchain.get_storage(), &register_request.wallet_address, &pseudonym, next)
            {
                println!("[INFO][LIGHT] registration_rejected reason=wallet_has_node pseudonym={} other={}", pseudonym, other);
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "code": "wallet_has_node",
                    "error": WALLET_HAS_NODE_TEXT,
                    "node_id": other,
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

        // The wallet, which names the node, must derive from a credential this caller proves below (the
        // chain door's rule): otherwise anyone's burn would attach a device to someone else's node before
        // its registration applies. Not a failed attempt: counting it would let strangers lock a wallet.
        if !legacy_register_wallet_bound(wallet, &register_request.quantum_pubkey, xor_wallet) {
            if crate::node::is_info() {
                println!("[INFO][LIGHT] registration_rejected reason=wallet_not_derived wallet={}...",
                    qnet_state::char_prefix(&wallet, 16));
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "wallet_address not derived from quantum_pubkey or burn_wallet (ownership unproven)",
                "reason": "wallet_not_derived"
            })));
        }

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

        // A returning node's signature was checked with its committed key at the top.
        let dilithium_ok = reactivating_existing || verify_mobile_dilithium_signature(
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

    // The registration may have applied during the burn and price checks above (seconds of network I/O),
    // after the top found the node not on chain and after its apply looked here for a binding to check.
    // Judged again now, as the top judges it, and nothing is awaited from here to the writes below: only
    // the committed key (its signature verified above) re-attaches an on-chain node, and never once a v2
    // binding exists. A binding written by a genesis that has not applied the registration yet is judged
    // by every reader under the commitment once it has (`light_push::device_reach`).
    if !reactivating_existing && blockchain.get_storage().is_node_registration_onchain(&light_node_pseudonym) {
        let committed = blockchain.get_storage()
            .resolve_light_identity_pk(&light_node_pseudonym, Some(&register_request.quantum_pubkey))
            .map_or(false, |k| k.eq_ignore_ascii_case(&register_request.quantum_pubkey));
        if !committed {
            println!("[INFO][LIGHT] registration_rejected reason=registered_meanwhile pseudonym={}", light_node_pseudonym);
            return Ok(warp::reply::json(&already_registered_reply(&light_node_pseudonym)));
        }
        if !legacy_attach_allowed(blockchain.get_storage().get_light_binding(&light_node_pseudonym).as_ref()) {
            println!("[INFO][LIGHT] registration_rejected reason=bind_v2_required pseudonym={}", light_node_pseudonym);
            return Ok(warp::reply::json(&crate::light_binding::Refusal::BindV2Required.to_json()));
        }
        reactivating_existing = true;
        println!("[INFO][LIGHT] reactivation_on_register pseudonym={} reason=registered_meanwhile", light_node_pseudonym);
    }

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    // H6: no token hash is kept or gossiped. The former value was an unkeyed hash with fixed keys, so
    // any peer could link a device across registrations by it.
    let new_device = LightNodeDevice {
        wallet_address: register_request.wallet_address.clone(),
        device_token_hash: String::new(),
        device_id: register_request.device_id.clone(),
        last_active: now,
        is_active: true,
    };
    
    // Register the Light node, or replace its device, under its pseudonym.
    {
        let mut registry = LIGHT_NODE_REGISTRY.lock();

        if let Some(existing_node) = registry.get_mut(&light_node_pseudonym) {
            // One node, one device (A15): the registering phone replaces the entry. The binding decides which
            // device answers for the node, and the app's random device id identifies nothing.

            existing_node.devices = vec![new_device];
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
        }
    }
    
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

        // Register in P2P gossip-synced registry and broadcast to network. Receivers check the
        // delegation under the key the chain committed (H8); the static wallet signature is not sent
        // on (S2), because anyone who saw it could replay this very route with it.
        let registration = LightNodeRegistrationData {
            node_id: light_node_pseudonym.clone(),
            wallet_address: register_request.wallet_address.clone(),
            device_token_hash: String::new(),
            quantum_pubkey: register_request.quantum_pubkey.clone(),
            registered_at: now,
            signature: String::new(),
            push_type: push_type.clone(),
            unified_push_endpoint: register_request.unified_push_endpoint.clone(),
            last_seen: now,
            consecutive_failures: 0,
            is_active: true,
            ping_pubkey: register_request.ping_pubkey.clone().unwrap_or_default(),
            ping_delegation_cert: register_request.ping_delegation_cert.clone().unwrap_or_default(),
        };
        let key_write = p2p.register_light_node(registration);
        println!("[INFO][GOSSIP] light_node_gossiped pseudonym={} push={}", light_node_pseudonym, push_type_str);

        // The push channel goes into the push record, the only place a push is read from, with the key
        // this registration was accepted under: a UnifiedPush endpoint too, with or without a token. A node
        // already on chain changes it only with a ping key this request newly proved (M-8).
        let record_allowed = legacy_record_write_allowed(reactivating_existing, key_write);
        if !record_allowed && crate::node::is_info() {
            println!("[INFO][LIGHT] push_record_kept pseudonym={} reason=no_new_ping_key key_write={:?}",
                     light_node_pseudonym, key_write);
        }
        let has_channel = record_allowed && (!register_request.device_token.is_empty()
            || matches!(push_type, crate::unified_p2p::PushType::UnifiedPush));
        if has_channel {
            let pt_str = match push_type {
                crate::unified_p2p::PushType::FCM => "fcm",
                crate::unified_p2p::PushType::UnifiedPush => "unifiedpush",
                crate::unified_p2p::PushType::Polling => "polling",
            };
            let writer = crate::light_binding::record_writer(&register_request.quantum_pubkey);
            // Same monotonic bump as token-refresh so a re-register supersedes regardless of skew.
            let reg_ts = std::cmp::max(now, blockchain.get_storage()
                .get_fcm_entry(&light_node_pseudonym)
                .map(|e| e.updated_at.saturating_add(1)).unwrap_or(now));
            match blockchain.get_storage().save_fcm_token_by(
                &light_node_pseudonym,
                &register_request.device_token,
                pt_str,
                register_request.unified_push_endpoint.as_deref(),
                reg_ts,
                &writer,
            ) {
                Ok(false) => {
                    if crate::node::is_info() {
                        println!("[INFO][LIGHT] fcm_token_not_saved pseudonym={} reason=record_held", light_node_pseudonym);
                    }
                }
                Ok(true) => {
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
                                0,
                                None,
                                &writer,
                                "",
                                "",
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

        // v6.0: the NodeRegistration TX is created and signed by the client (wallet app) with its own key and
        // routed like a transfer; this route returns registration_proof =
        // blake3(burn_tx_hash:node_id:wallet_address)[..32] for it to build the TX with.
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
) -> Result<warp::reply::Response, Rejection> {
    // Per-IP rate limit BEFORE any storage read / crypto verify (unpriced-work DoS bound at scale).
    if let Err(rate_limited) = check_api_rate_limit(remote_addr, "light_node_ping") {
        return Ok(rate_limited.into_response());
    }
    // Then the node-wide budget (M-6): past it a 503 with a wait that ends before the epoch's commit, before any
    // storage read or ML-DSA-65 work. The permit is held while the answer is handled.
    let mut permit = None;
    if let Some(shed) = shed_past(&PING_ANSWER_BUDGET, remote_addr, &mut permit) {
        return Ok(shed);
    }
    let answer = answer_light_node_ping(params, blockchain).await.map(|r| r.into_response());
    drop(permit);
    answer
}

async fn answer_light_node_ping(
    params: HashMap<String, String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};
    use crate::unified_p2p::{SimplifiedP2P, LightNodeAttestation};

    let node_id = params.get("node_id").unwrap_or(&"unknown".to_string()).clone();
    let signature = params.get("signature").unwrap_or(&"".to_string()).clone();
    let challenge = params.get("challenge").unwrap_or(&"".to_string()).clone();

    // Cheap structural reject before the anchor storage read + Dilithium verify (light-node-messages 5.8,
    // step 1). A reply with the device signature is parsed here and checked below.
    let malformed = || Ok(warp::reply::json(&json!({ "success": false, "error": "malformed ping-response" })));
    if !node_id.starts_with("light_") || signature.is_empty() || challenge.is_empty() {
        return malformed();
    }
    let hw = if signature.starts_with("ping_hw2:") {
        match crate::light_device::messages::parse_hwping_wire(&signature) {
            Some(w) => Some(w),
            None => return malformed(),
        }
    } else {
        None
    };
    let tip = blockchain.get_height().await;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    // What the answer tells about the push it answers (light-node-messages 5.10); never a reason to refuse it.
    let timing = AnswerTiming::from_params(&params);

    // Two accepted challenge forms (step 2):
    // 1. Server stamp (push path, G2): must be one THIS server stamped for THIS node, unexpired. Credited
    //    only here, never on relay, and only until the device layer's enforcement epoch; a reply with the
    //    device signature never answers one.
    // 2. PULL self-attestation: "selfattest:{height}:{block_hash}" — a same-epoch canonical block
    //    hash, unknowable before that block exists, so it proves the device is online THIS epoch
    //    with the same strength as a stamped challenge but with no FCM delivery dependency.
    //    (FCM stays as a best-effort wakeup; liveness no longer depends on it at scale.)
    let anchor = crate::light_device::ping::Anchor::parse(&challenge);
    if challenge.starts_with("selfattest:") {
        let valid = anchor.as_ref().map_or(false, |a| crate::light_device::ping::anchor_on_chain(&blockchain.get_storage(), a, tip));
        if !valid {
            // An answer to the epoch that just ended counts in neither: its shard owner records it as late.
            let late = note_stale_answer(&blockchain.get_storage(), &node_id, &challenge, &signature, tip, now,
                                         timing.measure(now));
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] selfattest_anchor_invalid node={} late_recorded={}", node_id, late);
            }
            return Ok(warp::reply::json(&json!({
                "success": false,
                "reason": "anchor_not_current",
                "error": "Invalid or stale self-attest anchor"
            })));
        }
    } else if hw.is_some() || !crate::light_device::ping::legacy_counts(tip / 14400) {
        return malformed();
    } else if !verify_challenge_stamp(&node_id, &challenge) {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] challenge_unrecognized node={}", node_id);
        }
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Unrecognized or expired challenge"
        })));
    }

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

    // Between the shard's commit and the epoch's end an answer counts in no epoch (B-2): nothing is credited,
    // the shard owner records it as that epoch's late answer once it verifies, and the app is told only that
    // the epoch's commit is closed. Nothing is moved to the next epoch.
    if in_commit_gap(tip) {
        let storage = blockchain.get_storage();
        let epoch = tip / 14400;
        let late = owns_light_shard(&node_id) && !late_recorded(&storage, &node_id, epoch)
            && verify_light_node_signature(&node_id, &challenge, &signature, &blockchain).await.is_ok()
            && record_late_answer(&storage, &node_id, epoch, now, timing.measure(now));
        if crate::node::is_info() {
            println!("[INFO][LIGHT] answer_in_commit_gap node={} tip={} late_recorded={}", node_id, tip, late);
        }
        return Ok(warp::reply::json(&gap_reply(&node_id)));
    }

    // Steps 4 and 5 before any ML-DSA-65 work: the device record here and the device's own signature over
    // the anchor (nothing written; the shared verifier below runs them again and takes the counter).
    if let (Some(w), Some(a)) = (&hw, &anchor) {
        let checked = crate::light_device::ping::check_device_reply(&blockchain.get_storage(),
            crate::light_device::evidence::Verifier::production(), &node_id, a, w, now);
        if let Err(r) = checked {
            note_refusal(&blockchain.get_storage(), &node_id, tip, r.as_str(), now, &challenge, &signature);
            if crate::node::is_info() {
                println!("[INFO][LIGHT] device_reply_refused node={} reason={}", node_id, r.as_str());
            }
            return Ok(warp::reply::json(&json!({ "success": false, "error": "The device check of this reply failed" })));
        }
    }

    // Anti-poison: if the request presents its ping delegation, refresh the ping-key CF before verifying,
    // so the node's own authenticated ping overwrites any pre-registration gossip poison. The overwrite is
    // bound to (a) a cert that verifies under the node's committed on-chain key AND (b) a valid ping signature
    // under the PRESENTED key — so a replay of an old (pp,cert) with a garbage ping sig cannot downgrade the
    // stored key, while a node whose CF was poisoned heals it with its own correctly-signed ping.
    // A presented key and delegation this genesis already holds, with the identity they were proven under, change
    // nothing: the shared verifier below checks σ under them, once, instead of the delegation and σ here and σ again
    // there (two of three ML-DSA-65 checks an answer).
    let presented_known = match (params.get("ping_pubkey"), params.get("ping_delegation_cert")) {
        (Some(pp), Some(cert)) if !pp.is_empty() => blockchain.get_storage().get_light_binding(&node_id)
            .map_or(false, |b| b.ping_pubkey == *pp && b.cert == *cert && !b.identity_pubkey.is_empty()),
        _ => false,
    };
    if let (false, Some(pp), Some(cert), Some(inner_ping_sig)) =
        (presented_known, params.get("ping_pubkey"), params.get("ping_delegation_cert"), crate::light_device::ping::sigma_text(&signature)) {
        if !pp.is_empty() && !cert.is_empty() {
            let inner_ping_sig = inner_ping_sig.as_str();
            // A light node's identity key lives on its device; the chain holds its hash. The device may
            // present the key here, and it is admitted only if it hashes to that commitment - so the
            // delegation below is still checked under a key the chain vouches for.
            let presented = params.get("identity_pubkey").map(|s| s.as_str());
            if let Some(onchain_pk_hex) = blockchain.get_storage().resolve_light_identity_pk(&node_id, presented) {
                if crate::light_binding::verify_delegation(cert, pp, &node_id, &onchain_pk_hex).is_some()
                    && verify_mobile_dilithium_signature(&challenge, inner_ping_sig, pp) {
                    // Record the identity the delegation was proven under, so later attestations need
                    // only the ping signature. The binding order holds (U8): a device whose binding
                    // was replaced presents an older delegation, which is refused, and its answer is
                    // not credited - it would fail under the stored key anyway, so say why.
                    let storage = blockchain.get_storage();
                    if let Ok(crate::storage::PingKeyWrite::Refused(
                        verdict @ (crate::light_binding::Admit::Stale | crate::light_binding::Admit::V1AfterV2),
                    )) = storage.save_light_ping_keys_identity(&node_id, pp, cert, &onchain_pk_hex)
                    {
                        let current = storage.get_light_ping_keys(&node_id).map(|(k, _)| k);
                        if current.as_deref() != Some(pp.as_str()) {
                            note_refusal(&storage, &node_id, tip, "superseded", now, &challenge, &signature);
                            if crate::node::is_info() {
                                println!("[INFO][LIGHT] superseded_device_refused node={} verdict={:?}", node_id, verdict);
                            }
                            return Ok(warp::reply::json(&json!({
                                "success": false,
                                "reason": "superseded",
                                "error": "The node runs on another device"
                            })));
                        }
                    }
                } else if crate::node::is_warn() {
                    println!("[WARN][LIGHT] presented_ping_delegation_rejected node={}", node_id);
                }
            } else if crate::node::is_warn() {
                println!("[WARN][LIGHT] identity_unresolved node={} presented={}", node_id, presented.is_some());
            }
        }
    }

    // The shared verifier (steps 2 to 6, and the device counter), the one relay admission runs too.
    if let Err(r) = verify_light_node_signature(&node_id, &challenge, &signature, &blockchain).await {
        note_refusal(&blockchain.get_storage(), &node_id, tip, r.as_str(), now, &challenge, &signature);
        if crate::node::is_info() {
            println!("[INFO][LIGHT] reply_refused node={} reason={}", node_id, r.as_str());
        }
        // `reason` says why; `ping_signature` (no ping key here, or another one) is answered again with the delegation, which the
        // app otherwise sends only after a bind or a key rotation.
        return Ok(warp::reply::json(&json!({
            "success": false,
            "reason": r.as_str(),
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
        
        // Create attestation with Light node's signature. block_height is the anchor's height, which
        // relay admission requires the record to repeat (it is not signed); a stamp's reply carries the
        // tip and is credited here only.
        let current_block_height = match &anchor {
            Some(a) => a.height,
            None => blockchain.get_height().await,
        };
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

    // The node's last answer as its shard owner took it, with how long the push took to reach the device
    // (`device.last_answer`); nothing of this epoch is left to record as a miss. The push receipts the answer
    // carries refine the node's last miss here (light-node-messages 5.10), never its crediting.
    PUSH_LEDGER.answered(&node_id);
    if owns_light_shard(&node_id) {
        let receipts = PushReceipts::from_params(&params);
        record_answer(&blockchain.get_storage(), &node_id, now, timing.measure(now), receipts.as_ref(), timing.answered_at,
                      anchor.as_ref().map(|a| a.epoch()));
    }

    // A lease refresh riding in the reply (light-node-messages 5.6): run at this genesis in the background,
    // never relayed.
    if let Some(param) = params.get("device_refresh").filter(|p| !p.is_empty()) {
        refresh_from_ping(&blockchain, &node_id, param);
    }

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

/// `GET /api/v1/light-node/pending-challenge?node_id=` (polling devices): the challenge left for the device, or one
/// for its slot. Cheap checks first: the per-address limit, the shape, the epoch, then RAM, then storage. A device this
/// genesis pushes, or whose device record does not count, is answered exactly as a polling device whose slot is not
/// due, so the route tells nobody how a device is reached (L-5). Handing a challenge out marks nothing: the device
/// counts as having fetched it only when its poll is signed with its ping key (`ts`, `sig`), and its answer settles
/// the epoch itself.
pub(super) async fn handle_light_node_pending_challenge(
    params: HashMap<String, String>,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};

    if let Err(rate_limited) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limited);
    }
    let node_id = match params.get("node_id") {
        Some(id) if id.starts_with("light_") && id.len() <= 128 => id.clone(),
        _ => return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "node_id parameter required"
        }))),
    };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let tip = blockchain.get_height().await;
    let no_challenge = |message: &str| {
        let (next_ping_time, _) = crate::unified_p2p::SimplifiedP2P::get_next_ping_time(&node_id);
        warp::reply::json(&json!({
            "success": true,
            "node_id": node_id,
            "has_challenge": false,
            "message": message,
            "next_ping_time": next_ping_time
        }))
    };

    // None between the epoch's commit and its end, as no push goes out then: an answer would count in no epoch.
    // The next poll time is the node's own slot, as outside the gap. None either while this genesis is behind the
    // network (F14): its anchor and epoch are stale, and the device polls another genesis.
    let gap = in_commit_gap(tip);
    if gap || this_genesis_behind() {
        return Ok(no_challenge(if gap { "The epoch's commit is closed" } else { "This node is catching up with the network" }));
    }

    // A node this genesis holds (point-read: no full-map clone).
    if let Some(p2p) = blockchain.get_unified_p2p() {
        if p2p.get_light_node(&node_id).is_none() {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Node not found. Please register first."
            })));
        }
    }
    // Only a device this genesis does not push polls (`light_poll_allowed`), judged as the pinger and a wake judge it,
    // and (A12) only one whose device record counts, as only such a device is pushed. Any other is not due.
    let storage = blockchain.get_storage();
    if !light_poll_allowed(&storage, &node_id) || !device_layer_pushable(&storage, &node_id) {
        return Ok(no_challenge("Not your ping slot yet"));
    }

    // Check for pending challenge: this node's entry alone, an expired or unanswerable one dropped here; the ping
    // loop sweeps the rest (`sweep_polling_challenges`).
    let pending = {
        let mut challenges = PENDING_CHALLENGES.lock();
        match challenges.get(&node_id) {
            Some(c) if c.expires_at > now && polling_challenge_answerable(&c.challenge, tip) => Some(c.clone()),
            Some(_) => { challenges.remove(&node_id); None }
            None => None,
        }
    };

    match pending {
        Some(challenge) => {
            if crate::node::is_debug() {
                println!("[DBG][POLLING] pending_challenge_returned node={}", node_id);
            }
            note_poll_fetched(&storage, &node_id, &params, tip, now);
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

                // The block the pushed devices answer with this epoch (`polling_challenge`): whichever
                // genesis the device polled and answers, every shard owner credits the relayed answer.
                let anchor = push_anchor(&storage, tip);
                let (challenge, expires_at) = polling_challenge(&node_id, anchor.as_deref(), now);
                if !polling_challenge_answerable(&challenge, tip) {
                    return Ok(no_challenge("Not your ping slot yet"));
                }

                // The pending map is only the hand-off to a device that polls in its own slot, so it
                // keeps the short horizon: the challenge verifies statelessly, and holding one row per light
                // node until the epoch ends would be a roster-sized map at scale instead of a few slots'
                // worth. An answer that arrives after the row is gone still verifies.
                {
                    let mut challenges = PENDING_CHALLENGES.lock();
                    challenges.insert(node_id.clone(), PendingChallenge {
                        challenge: challenge.clone(),
                        created_at: now,
                        expires_at: now + crate::rpc::LIGHT_CHALLENGE_TTL_SECS,
                    });
                }

                if crate::node::is_debug() {
                    println!("[DBG][POLLING] challenge_generated node={}", node_id);
                }
                note_poll_fetched(&storage, &node_id, &params, tip, now);

                Ok(warp::reply::json(&json!({
                    "success": true,
                    "node_id": node_id,
                    "has_challenge": true,
                    "challenge": challenge,
                    "created_at": now,
                    "expires_at": expires_at
                })))
            } else {
                Ok(no_challenge("Not your ping slot yet"))
            }
        }
    }
}

/// The device fetched the challenge left for it in the tip's epoch, counted (`PushLedger::fetched`) only when the poll
/// carries `ts` within the fresh window and `sig`, the node's ping key over `light_poll_message`, under the delegation
/// the chain vouches for (`ping_key_signed`). A poll in its name by anyone else marks nothing; the signature is checked
/// only while a challenge the pinger left here this epoch waits for its fetch.
fn note_poll_fetched(storage: &crate::storage::Storage, node_id: &str, params: &HashMap<String, String>, tip: u64, now: u64) {
    let epoch = tip / 14_400;
    if !PUSH_LEDGER.awaits_fetch(node_id, epoch) { return; }
    let (Some(ts), Some(sig)) = (params.get("ts").and_then(|t| t.parse::<u64>().ok()), params.get("sig")) else { return; };
    if now.abs_diff(ts) > crate::light_binding::FRESH_TS_WINDOW_SECS || sig.len() != crate::light_binding::MLDSA65_SIG_HEX {
        return;
    }
    if ping_key_signed(storage, node_id, &crate::light_binding::light_poll_message(node_id, ts), sig) {
        PUSH_LEDGER.fetched(node_id, epoch, now);
    }
}

/// Drop the polling challenges no longer worth handing out at `tip` (expired, or of an epoch that ended): once a
/// tick, off the request path.
pub(super) fn sweep_polling_challenges(tip: u64, now: u64) {
    PENDING_CHALLENGES.lock().retain(|_, c| c.expires_at > now && polling_challenge_answerable(&c.challenge, tip));
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
    
    // An address in place of a name must be a public one and no genesis node's: the genesis nodes POST
    // here on each push and wake, and must not be aimed at their own hosts or internal networks.
    if let Some(url::Host::Ipv4(ip)) = url.host() {
        let o = ip.octets();
        let internal = ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
            || ip.is_broadcast() || ip.is_documentation() || ip.is_multicast()
            || o[0] == 0 || o[0] >= 240 || (o[0] == 100 && (o[1] & 0xc0) == 64);
        let genesis = crate::genesis_constants::GENESIS_NODE_IPS.iter().any(|(g, _)| g.parse::<std::net::Ipv4Addr>() == Ok(ip));
        if internal || genesis {
            return Err("UnifiedPush endpoint must not name an internal or genesis address".to_string());
        }
    }

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

/// What the other owners of a node's light shard say of it (`shard_owners_view`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct OwnersView {
    /// Some owner that sees the node on chain took its answer this epoch.
    pub(crate) answered: bool,
    /// Some owner reports it active.
    pub(crate) active: bool,
}

impl OwnersView {
    /// The view of the owners that replied (`replies`, each an owner's public status): answered or active when any
    /// of them says so. None when none replied with a verdict.
    pub(crate) fn of(replies: &[serde_json::Value]) -> Option<Self> {
        let verdicts: Vec<&serde_json::Value> = replies.iter().filter(|v| v["is_active"].as_bool().is_some()).collect();
        if verdicts.is_empty() { return None; }
        Some(OwnersView {
            answered: verdicts.iter().any(|v| v["onchain_registered"].as_bool() == Some(true)
                && v["answered_this_epoch"].as_bool() == Some(true)),
            active: verdicts.iter().any(|v| v["is_active"].as_bool() == Some(true)),
        })
    }
}

/// Owner-shard verdict proxy (F13): the current epoch's answers are shard-owner RAM (bounded at 10M nodes), and the
/// owner that took an answer may be any of the three: the primary was down or restarting when the device answered a
/// backup, or a relay was lost. So a genesis asks every owner of the node's shard but itself, at once, before it calls
/// the node inactive; every genesis then gives one verdict. 60 s per-node cache (64k cap), an owner that failed is
/// skipped for 15 s, at most 16 consultations in flight; None on no verdict (the caller keeps its own). `fwd=1` marks
/// a proxied call, never recursed.
pub(super) async fn shard_owners_view(node_id: &str) -> Option<OwnersView> {
    use crate::genesis_constants::GENESIS_NODE_IPS;
    fn cache() -> &'static dashmap::DashMap<String, (OwnersView, u64)> {
        static M: std::sync::OnceLock<dashmap::DashMap<String, (OwnersView, u64)>> = std::sync::OnceLock::new();
        M.get_or_init(dashmap::DashMap::new)
    }
    // Per-owner negative cache: an unreachable owner must not cost every status poll a 2 s timeout.
    fn owner_down() -> &'static dashmap::DashMap<usize, u64> {
        static M: std::sync::OnceLock<dashmap::DashMap<usize, u64>> = std::sync::OnceLock::new();
        M.get_or_init(dashmap::DashMap::new)
    }
    // Global in-flight bound: the proxy is reachable from a public endpoint, so outbound
    // fan-in to the owners is capped process-wide; overflow degrades to the local verdict.
    fn inflight() -> &'static tokio::sync::Semaphore {
        static S: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
        S.get_or_init(|| tokio::sync::Semaphore::new(16))
    }
    fn client() -> &'static reqwest::Client {
        static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
        C.get_or_init(|| reqwest::Client::builder().timeout(std::time::Duration::from_secs(2)).build().unwrap_or_default())
    }
    let shard = crate::node::light_shard_of(node_id);
    let our_idx = std::env::var("QNET_BOOTSTRAP_ID").ok()
        .and_then(|id| id.parse::<usize>().ok())
        .map(|n| n.saturating_sub(1));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    // An expiry further off than its lifetime was set before this genesis's clock was set back: expired.
    if let Some(e) = cache().get(node_id) { if e.value().1 > now && e.value().1 <= now + 60 { return Some(e.value().0); } }
    let owners: Vec<usize> = crate::node::light_shard_owners(shard).into_iter()
        .filter(|o| Some(*o) != our_idx)
        .filter(|o| owner_down().get(o).map_or(true, |d| *d.value() <= now || *d.value() > now + 15))
        .collect();
    if owners.is_empty() { return None; }
    if cache().len() > 65_536 { cache().clear(); }
    let _permit = inflight().try_acquire().ok()?;
    let asks = owners.iter().map(|o| async move {
        let (ip, _) = GENESIS_NODE_IPS.get(*o)?;
        let url = format!("http://{}:8001/api/v1/light-node/status?node_id={}&fwd=1", ip, node_id);
        match client().get(&url).send().await {
            Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok(),
            _ => None,
        }
    });
    let replies = futures::future::join_all(asks).await;
    // Only a transport-level failure marks an owner down; a well-formed reply without a verdict (the owner does
    // not know the node) is a per-node None, not an outage.
    for (o, r) in owners.iter().zip(replies.iter()) {
        if r.is_none() { owner_down().insert(*o, now + 15); }
    }
    let replies: Vec<serde_json::Value> = replies.into_iter().flatten().collect();
    let view = OwnersView::of(&replies)?;
    cache().insert(node_id.to_string(), (view, now + 60));
    Some(view)
}

/// When `epoch` began: the time of its first block, alike at every genesis that holds it, else read from the tip at a
/// block a second. None for an epoch the tip has not reached.
pub(crate) fn epoch_started_at(storage: &crate::storage::Storage, epoch: u64, tip: u64, now: u64) -> Option<u64> {
    let first = epoch.checked_mul(14_400)?;
    if first > tip { return None; }
    storage.block_timestamp_at(first).ok().flatten().or_else(|| Some(now.saturating_sub(tip - first)))
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
                if p2p.get_light_node(target_id).is_some() {
                    let block_height = blockchain.get_height().await;
                    let pending_rewards = match blockchain.get_node_wallet(target_id).await {
                        Some(w) => wallet_claimable_qnc(&blockchain, &w).await,
                        None => 0,
                    };
                    // Online is the light status's is_active (status v2): counted in the last committed
                    // epochs, answering in this one, counted by the shard owner, or in the registration's
                    // first epochs with a device linked. One view, so both routes give one answer.
                    let status = super::light_status::light_status(&blockchain, target_id, true).await;
                    // On-chain attestation is the light tier's liveness fact; keep it separate from the
                    // display verdict, which also honours the grace and the owner-shard proxy.
                    let attested_onchain = blockchain.get_storage()
                        .light_attested_recent_onchain(target_id, block_height);
                    let is_online = status.is_active;
                    // Strict on-chain registration truth; is_online stays a labeled approximation.
                    let onchain = status.onchain;
                    // When the epoch of the node's last answer began (status v2 `device.last_answer_epoch`), never the
                    // answer's own second: this route answers anyone for a wallet address, and the exact time is the
                    // signed status's (H-1). The registry row's time is the registration's and was never updated.
                    let last_seen = status.device_view.as_ref().and_then(|d| d.last_answer_epoch)
                        .and_then(|e| epoch_started_at(&blockchain.get_storage(), e, block_height, now));
                    return Ok(warp::reply::json(&json!({
                        "success": true,
                        "node_id": target_id,
                        "node_type": "Light",
                        "onchain_registered": onchain,
                        "is_online": is_online,
                        "last_seen": last_seen.unwrap_or(0),
                        "last_seen_ago_seconds": last_seen.map(|t| now.saturating_sub(t)),
                        // A light node proves liveness by one attestation per epoch, not by heartbeats.
                        // The hardcoded 0 reached the wallet as "0 of 1" for a node that had attested.
                        "heartbeat_count": u8::from(attested_onchain),
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

// Push delivery for light nodes, metered per second (light_push::FCM_PUSHES_PER_SEC).

pub(crate) use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
// Note: Lazy is already imported at the top of the file

/// Every push this genesis sends: up to three shards' share and the wakes (`PUSH_QUOTA_PER_SEC`); the pacer keeps
/// the epoch's pushes at the share of the shards covered.
pub(super) static FCM_RATE_LIMITER: Lazy<FcmRateLimiter> = Lazy::new(|| FcmRateLimiter::with_rate(PUSH_QUOTA_PER_SEC));
/// "I'm back" pushes, a share of the above.
pub(super) static WAKE_RATE_LIMITER: Lazy<FcmRateLimiter> = Lazy::new(|| FcmRateLimiter::with_rate(WAKE_PUSHES_PER_SEC));

pub(super) struct FcmRateLimiter {
    /// Requests sent in current second
    pub(super) requests_this_second: AtomicU64,
    /// Current second timestamp
    pub(super) current_second: AtomicU64,
    /// Max requests per second
    pub(super) max_per_second: u64,
}

impl FcmRateLimiter {
    fn with_rate(max_per_second: u64) -> Self {
        Self {
            requests_this_second: AtomicU64::new(0),
            current_second: AtomicU64::new(0),
            max_per_second,
        }
    }

    /// Check if we can send, and increment counter if yes
    pub(super) fn try_acquire(&self) -> bool {
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

/// One service for the process, so its access token is cached for every push rather than fetched anew.
pub(super) static FCM_SERVICE: Lazy<FCMPushService> = Lazy::new(FCMPushService::new);

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
    
    /// Send one prepared v1 message (`light_push::fcm_message`: data only, no notification, so the app
    /// wakes in the background instead of the system showing a banner). The caller logs the outcome; the
    /// token is never logged.
    pub(super) async fn send_message(&self, message: &serde_json::Value) -> Result<(), String> {
        let access_token = self.get_access_token().await?;
        if !FCM_RATE_LIMITER.acquire().await {
            return Err("FCM rate limit exceeded - try again later".to_string());
        }
        let project_id = std::env::var("FCM_PROJECT_ID").unwrap_or_else(|_| "qnet-wallet".to_string());
        let fcm_url = format!("https://fcm.googleapis.com/v1/projects/{}/messages:send", project_id);
        static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
        let client = CLIENT.get_or_init(|| reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10)).build().unwrap_or_default());
        let response = client.post(&fcm_url)
            .header("Authorization", format!("Bearer {}", access_token))
            .json(message)
            .send().await
            .map_err(|e| format!("FCM network error: {}", e.without_url()))?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        // The provider's error names the failure (an unregistered token, a quota), never the token.
        let error_text: String = response.text().await.unwrap_or_default().chars().take(300).collect();
        Err(format!("FCM API error: {} - {}", status, error_text))
    }
}

/// The challenge a polling device answers, and until when: `selfattest:{anchor}` with the block the pushed
/// devices answer with (`push_anchor`), the form every shard owner credits on relay, whichever genesis the
/// device polled and answers. A server stamp is credited by its issuer alone, on its ingress (only the
/// issuer can check it), so a stamp a non-owner issued would count nowhere and one a backup owner issued
/// only in that owner's bitmap: it is the fallback for a node lacking the anchor's block.
pub(super) fn polling_challenge(node_id: &str, anchor: Option<&str>, now: u64) -> (String, u64) {
    match anchor {
        Some(a) => {
            let tip = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
            (format!("selfattest:{}", a), now + challenge_lifetime_at(tip))
        }
        None => make_challenge_stamp(node_id),
    }
}

/// A polling challenge is still worth handing out at `tip`: an anchor of the current epoch, or a server
/// stamp while legacy replies count.
pub(super) fn polling_challenge_answerable(challenge: &str, tip: u64) -> bool {
    match crate::light_device::ping::Anchor::parse(challenge) {
        Some(a) => a.epoch() == tip / crate::light_device::EPOCH_BLOCKS,
        None => crate::light_device::ping::legacy_counts(tip / crate::light_device::EPOCH_BLOCKS),
    }
}

/// Hand a polling device its challenge (`polling_challenge`; `anchor` as `push_anchor` gives it). The map
/// only bridges to the device's poll in its own slot and is bounded; the challenge verifies statelessly, so
/// a full map delays nobody past that poll.
pub(super) fn store_polling_challenge(node_id: &str, anchor: Option<&str>, now: u64) {
    const MAX_PENDING_CHALLENGES: usize = 10_000;
    let (challenge, _) = polling_challenge(node_id, anchor, now);
    let mut challenges = PENDING_CHALLENGES.lock();
    if challenges.len() >= MAX_PENDING_CHALLENGES {
        challenges.retain(|_, c| c.expires_at > now);
    }
    if challenges.len() < MAX_PENDING_CHALLENGES {
        challenges.insert(node_id.to_string(), PendingChallenge {
            challenge,
            created_at: now,
            expires_at: now + crate::rpc::LIGHT_CHALLENGE_TTL_SECS,
        });
    } else if crate::node::is_warn() {
        println!("[WARN][RPC] pending_challenges_full size={}", challenges.len());
    }
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

        let mut last_reward_heal_slot = u64::MAX;
        // The hourly cleanup runs in its own task; this says one is still running.
        let cleanup_running = Arc::new(std::sync::atomic::AtomicBool::new(false));
        // The last epoch whose misses were recorded (`epoch_misses`), and the slot of the last ledger prune.
        let mut misses_done: Option<u64> = None;
        let mut last_prune_slot = u64::MAX;
        // Restarted while its provider failed, a genesis stays quiet until a push is answered (`PushHealth`); and it
        // judges the genesis it heard ticking before by their ticks at once (`OwnerLiveness`).
        if is_genesis_node {
            PUSH_HEALTH.restore(&blockchain_for_pings.get_storage());
            OWNER_LIVENESS.restore(&blockchain_for_pings.get_storage());
            OWNER_SCHEDULES.restore(&blockchain_for_pings.get_storage());
        }
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
                
                // Reward shards, every slot (~1 min). An epoch that settles while this node is
                // restarting leaves no shards, and the claimable figure then stops at that epoch and
                // under-reports every wallet until the gap closes. One index probe per retained epoch,
                // so a healthy node pays nothing; the hourly cycle was too coarse for a money figure.
                if last_reward_heal_slot != current_slot {
                    last_reward_heal_slot = current_slot;
                    let st = blockchain_for_pings.get_storage();
                    tokio::task::spawn_blocking(move || {
                        crate::node::BlockchainNode::backfill_reward_shards(&st);
                    });
                }

                // Cleanup old attestations every hour, offset per node. The slot is derived
                // from chain height, so an unoffset check fires within the same second on
                // every node and no quorum member is left serving during the sweep.
                // In its own task (L-4): run inline, its seconds delayed the tick past the slot it read, and at an
                // epoch's last slot a tick stamped its pushes with a slot of the next epoch. One at a time.
                if current_slot % 60 == cleanup_slot_offset
                    && !cleanup_running.swap(true, std::sync::atomic::Ordering::AcqRel)
                {
                    let (p2p, blockchain, running) = (p2p.clone(), blockchain_for_pings.clone(), cleanup_running.clone());
                    tokio::spawn(async move {
                        // RAM cleanup
                        p2p.cleanup_old_attestations();

                        // PRODUCTION v2.78: RocksDB cleanup (persistent storage)
                        blockchain.cleanup_old_storage_data().await;

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
                        running.store(false, std::sync::atomic::Ordering::Release);
                    });
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
                let tip = blockchain_for_pings.get_height().await;
                let epoch = tip / 14400;
                // P-1: the early first-push draw starts with the window after this genesis's first ping, and the spaced
                // rounds with the window after its first ping on a release with them, both kept across restarts, once
                // the height is known. A window not stored yet is stored only from a tip the network stands behind, so a
                // genesis back from a long stop never stores one it is already past; a stored one is armed at once.
                if tip > 0 {
                    let storage = blockchain_for_pings.get_storage();
                    let head = p2p.corroborated_head_ceiling();
                    let live = (head > 0 && !pinger_behind(tip, head)).then_some(epoch);
                    SimplifiedP2P::arm_push_schedule(first_push_draw_from(&storage, live), spaced_rounds_from(&storage, live));
                }
                // The misses of the epoch whose commit opened (after a stalled loop, of the one before): what each
                // node that gave no answer got from here, merged into its row (`device.last_miss`). Before any push
                // of a new epoch, which would reuse the ledger's entries.
                let decided = if in_commit_gap(tip) { Some(epoch) } else { epoch.checked_sub(1) };
                if let Some(d) = decided.filter(|d| misses_done.map_or(true, |m| m < *d)) {
                    misses_done = Some(d);
                    let entries = PUSH_LEDGER.take_epoch(d);
                    let signer = std::env::var("QNET_BOOTSTRAP_ID").ok()
                        .and_then(|id| ["001", "002", "003", "004", "005"].iter().position(|g| *g == id));
                    match (entries.is_empty(), signer) {
                        (false, Some(signer)) => {
                            let storage = blockchain_for_pings.get_storage();
                            tokio::task::spawn_blocking(move || {
                                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                                let held = entries.len();
                                // Its reach records first (F3): the devices reached and silent here, which the dormant
                                // rule of all three owners reads; the other owners pull them (`pull_reach_records`).
                                let reached = reached_unanswered(&entries, |id| storage.light_counted_answer_at(id, d).is_some());
                                let recorded = save_reach_records(&storage, d, signer, &reached);
                                mark_reach_decided(d);
                                let misses = epoch_misses(entries, |id| storage.light_counted_answer_at(id, d).is_some(), now);
                                let missed = misses.len();
                                let written = save_misses(&storage, misses);
                                if crate::node::is_info() {
                                    println!("[INFO][LIGHT] epoch_misses_recorded epoch={} entries={} missed={} rows={} reached_silent={}",
                                             d, held, missed, written, recorded);
                                }
                            });
                        }
                        _ => mark_reach_decided(d),
                    }
                }
                // F14: behind the network this genesis's epoch and anchor are stale. No push, no ping tick: the owners
                // below take its shards over until it caught up.
                let behind = this_genesis_behind();
                if behind && is_genesis_node && crate::node::is_warn() {
                    println!("[WARN][LIGHT] pinger_behind tip={} action=no_push_no_tick", tip);
                }
                // The other owners' reach records of the last two epochs, once each.
                if let Some(our) = std::env::var("QNET_BOOTSTRAP_ID").ok()
                    .and_then(|id| ["001", "002", "003", "004", "005"].iter().position(|g| *g == id)) {
                    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                    pull_reach_records(blockchain_for_pings.get_storage(), our, tip, now);
                }
                // Entries of nodes that answered at another genesis go every ten slots; those that answered here
                // went at their answer. A pass over the whole ledger, so on a blocking thread, with the epoch's
                // answers read under one lock (M-11).
                if current_slot % 10 == 0 && last_prune_slot != current_slot {
                    last_prune_slot = current_slot;
                    let p2p = p2p.clone();
                    tokio::task::spawn_blocking(move || {
                        p2p.with_counted_in(epoch, |counted| PUSH_LEDGER.prune(epoch, counted));
                    });
                }
                // Polling challenges no longer worth handing out, once a tick, off the poll route (L-5).
                sweep_polling_challenges(tip, SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs());

                // Get Light nodes to ping (ONLY Genesis nodes get results now). Storage point reads for every node it
                // may push, so on a blocking thread, never on a runtime worker (M-11); the slot comes from `tip`.
                let selection = if behind {
                    LightPingSelection::default()
                } else {
                    let p2p = p2p.clone();
                    tokio::task::spawn_blocking(move || p2p.get_light_nodes_to_ping(tip)).await.unwrap_or_default()
                };
                // The slot the selection read stamps every push of the tick, and the commit is judged in its epoch
                // (L-4).
                let abs_slot = selection.now_slot;
                let nodes_to_ping = selection.nodes;
                // No push at or after the epoch's commit (R-c): an answer then counts in no epoch, and the next
                // epoch gets its own push.
                let open = push_lifetime(abs_slot / 240, tip).is_some();
                // What the tick's pushes got from the provider, None when it sent none (`PushHealth`).
                let mut tick_tally: Option<Arc<PushTally>> = None;

                if !nodes_to_ping.is_empty() && open {
                    let offered = nodes_to_ping.len();
                    let mut futures = FuturesUnordered::new();
                    // F6: one shard's share of the budget for each shard covered, so a takeover sheds nothing.
                    EPOCH_PACER.set_rate(epoch_push_rate(covered_shards()));
                    // One anchor per tick: the block every device pushed now answers with.
                    let anchor = push_anchor(&blockchain_for_pings.get_storage(), tip);
                    if anchor.is_none() && crate::node::is_warn() {
                        println!("[WARN][LIGHT] push_anchor_unavailable slot={} action=no_push_this_tick", current_slot);
                    }
                    // What the tick did, for its one summary line (per push only at DEBUG).
                    let tally = Arc::new(PushTally::default());

                    // In the order the selection gives (first pushes, then the round's repeats, then the retry
                    // round), which is the order they take their instants in: a slot over the budget sheds its
                    // later pushes, never its first ones. A backup that covers a shard pushes at once: the ranks
                    // above it are silent by then (`OwnerLiveness`), and a wait only shortened the device's time.
                    for (light_node, role, channel) in nodes_to_ping {
                        let semaphore = semaphore.clone();
                        let blockchain = blockchain_for_pings.clone();
                        let anchor = anchor.clone();
                        let tally = tally.clone();

                        futures.push(async move {
                            let role_str = match role {
                                PingerRole::Primary => "PRIMARY",
                                PingerRole::Backup1 => "BACKUP1",
                                PingerRole::Backup2 => "BACKUP2",
                                PingerRole::None => "NONE",
                            };

                            // The v2 push (U12) over the channel the device's push record names, and only
                            // a record of the binding held here: never the resident entry, which a
                            // registration planted before the chain admitted the node could have set and
                            // which nothing ties to the binding. A polling device, or one whose channel
                            // this genesis lacks or holds only for another binding, fetches the tick's
                            // anchor as its challenge (`polling_challenge`). The selection decided the channel
                            // (`push_reach_at`), so nothing is read again here.
                            let node_id = light_node.as_str();
                            match (channel, anchor) {
                                (Some(channel), Some(anchor)) => {
                                    // One even stream of pushes (`EPOCH_PACER`): a push with no instant left
                                    // in its slot is shed, and the next slot of its due point tries again. Recorded
                                    // as unsent: the system's miss, never the device's (F3).
                                    let now_us = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_micros() as u64;
                                    let Some(at) = EPOCH_PACER.reserve(now_us, now_us + PACE_WINDOW_US) else {
                                        PUSH_LEDGER.record(node_id, abs_slot, SendOutcome::Unsent, now_us / 1_000_000);
                                        tally.shed.fetch_add(1, AtomicOrdering::Relaxed);
                                        return;
                                    };
                                    tokio::time::sleep(std::time::Duration::from_micros(at.saturating_sub(now_us))).await;
                                    if blockchain.get_unified_p2p().map_or(false, |p| p.has_attestation_in_window(node_id)) {
                                        return;
                                    }
                                    let _permit = match semaphore.acquire().await {
                                        Ok(p) => p,
                                        Err(_) => { println!("[RPC] ⚠️ Semaphore closed"); return; }
                                    };
                                    // It lives until the commit of the epoch it is for, from the tip now (R-c).
                                    let Some(ttl) = push_lifetime(abs_slot / 240, crate::node::local_height()) else { return; };
                                    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                                    match deliver_push(&channel, PushAction::Epoch, &anchor, ttl).await {
                                        Ok(()) => {
                                            PUSH_LEDGER.record(node_id, abs_slot, SendOutcome::Accepted, now);
                                            tally.took(&channel);
                                            if crate::node::is_debug() {
                                                println!("[DBG][LIGHT] push_sent role={} node={} slot={} channel={} ttl={}",
                                                         role_str, node_id, current_slot, channel.name(), ttl);
                                            }
                                        }
                                        Err(e) => {
                                            let gone = push_target_gone(&e);
                                            PUSH_LEDGER.record(node_id, abs_slot, if gone { SendOutcome::Gone } else { SendOutcome::Failed }, now);
                                            tally.failed(&channel, gone, &e);
                                            if crate::node::is_debug() {
                                                println!("[DBG][LIGHT] push_failed role={} node={} channel={} err={}",
                                                         role_str, node_id, channel.name(), e);
                                            }
                                            // A device stops by unbinding and then deleting its token: a token
                                            // the provider no longer knows may be an unbind this genesis missed.
                                            if gone {
                                                repair_withdrawn_binding(node_id, abs_slot / 240);
                                            }
                                        }
                                    }
                                }
                                // No anchor this tick: nothing is pushed; the next tick or the device's own
                                // wake covers it. Unsent, as a shed push.
                                (Some(_), None) => {
                                    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                                    PUSH_LEDGER.record(node_id, abs_slot, SendOutcome::Unsent, now);
                                }
                                (None, anchor) => {
                                    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                                    store_polling_challenge(node_id, anchor.as_deref(), now);
                                    PUSH_LEDGER.record(node_id, abs_slot, SendOutcome::Polled, now);
                                    tally.polled.fetch_add(1, AtomicOrdering::Relaxed);
                                    if crate::node::is_debug() {
                                        println!("[DBG][LIGHT] challenge_stored role={} node={} slot={}",
                                                 role_str, node_id, current_slot);
                                    }
                                }
                            }
                        });
                    }

                    // Wait for all Light node pings
                    while futures.next().await.is_some() {}
                    tally.log(current_slot, offered);
                    tick_tally = Some(tally);
                }
                // F5: the tick is done. Its signed tick, straight to the other genesis, is what tells them this
                // genesis pushes; a genesis behind the network, whose push loop stopped, or whose provider answered
                // none of its pushes QUIET_AFTER_FAILED_TICKS ticks in a row (`PushHealth`) sends none.
                let pushing = PUSH_HEALTH.settle_tick(&blockchain_for_pings.get_storage(), tick_tally.as_deref(), current_slot);
                if !behind && pushing {
                    p2p.announce_ping_tick().await;
                }
                if is_genesis_node {
                    OWNER_LIVENESS.keep(&blockchain_for_pings.get_storage());
                    OWNER_SCHEDULES.keep(&blockchain_for_pings.get_storage());
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
            // The periodic bulk registry sync is gone: the resident registry is fed by block apply
            // (admit_light_from_chain), so it is a function of the chain rather than of a peer-to-peer
            // reconciliation that cost a full registry pass per request.
            let _ = current_slot;
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
                    
                    // Remove devices inactive for more than 24 hours. The app's device id is never logged.
                    light_node.devices.retain(|device| {
                        let keep_device = device.is_active && now.saturating_sub(device.last_active) < 24 * 60 * 60;
                        if !keep_device && crate::node::is_debug() {
                            println!("[DBG][CLEANUP] inactive_device_removed node={} idle_hours={}",
                                     node_id, now.saturating_sub(device.last_active) / 3600);
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

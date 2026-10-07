//! Transaction submit and lookup, bundles, batch transfer, node health and network probes.

use super::*;

pub(super) async fn handle_transaction_submit(
    tx_request: TransactionRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // SECURITY: IP-based rate limiting
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "transaction") {
        return Ok(rate_limit_response);
    }
    
    // SECURITY: Validate EON addresses before processing
    if let Err(e) = validate_eon_address_with_error(&tx_request.from) {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid sender address",
            "details": e
        })));
    }
    
    if let Err(e) = validate_eon_address_with_error(&tx_request.to) {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid recipient address",
            "details": e
        })));
    }
    if let Err(r) = check_recipient(&blockchain, &tx_request.to).await {
        return Ok(warp::reply::json(&r.to_json(&tx_request.to)));
    }

    // =========================================================================
    // CRITICAL SECURITY: Ed25519 Signature Verification (NIST FIPS 186-5)
    // Without this, ANYONE could send transactions from ANY address!
    // =========================================================================
    
    // PURE DILITHIUM (F0.1): QNet value TX are authorised by ML-DSA-65 ONLY. Ed25519 is a Solana-only
    // credential and is NOT checked here. Require the Dilithium sig+pubkey, bind `from` to the key via
    // the address (closes API-1 forge-from-any), then verify the signature the SAME way the ingest/
    // gossip path does (over the canonical
    // "q{chain}|transfer:{from}:{to}:{amount}:{nonce}:{gas_price}:{gas_limit}").
    let dil_sig = match tx_request.dilithium_signature.as_ref().filter(|s| !s.is_empty()) {
        Some(s) => s.clone(),
        None => return Ok(warp::reply::json(&json!({
            "success": false, "error": "value TX requires dilithium_signature (pure-PQ)"
        }))),
    };
    // FIX-5 pk-elision: the pubkey is OPTIONAL once it is committed on-chain (the first-use TX carries
    // it and binds it write-once). When present, bind `from` to it here (cheap early reject). When
    // elided, submit_transaction below is the authoritative gate: it rehydrates the pk from committed
    // state and rejects if unresolvable — add_transaction_to_mempool delegates straight to it.
    let dil_pk = tx_request.dilithium_public_key.as_ref().filter(|p| !p.is_empty()).cloned();
    if let Some(ref p) = dil_pk {
        match crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(p) {
            Some(d) if d == tx_request.from => {}
            _ => return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "from not derived from dilithium_public_key (ownership unproven)"
            }))),
        }
    }

    // Create the transaction (pure Dilithium — no Ed25519 signature/public_key).
    let tx = transfer_tx(&tx_request, chrono::Utc::now().timestamp() as u64)
    // FIX-5: hex(raw detached sig) / hex(raw pk) -> bytes; bad hex -> None -> verify rejects.
    // An ELIDED pk stays None here and on into the mempool — it is never re-added to the wire.
    .with_quantum_signature(hex::decode(&dil_sig).ok(), dil_pk.as_deref().and_then(|p| hex::decode(p).ok()));

    // Verify the ML-DSA-65 signature exactly as the ingest/gossip path will, but OFF the RPC runtime
    // workers via the blocking pool AND admission-bounded (D1): a value-TX flood on the HTTP API — even
    // localhost/netns, which the per-IP limiter exempts — must not spawn unbounded CPU-bound verifies
    // that saturate every core and starve consensus. Fail-closed at capacity; fail-closed on join error.
    // Runs ONLY when the pk is on the wire. An ELIDED pk cannot be opened here (no state access in the
    // RPC layer); that TX is resolved+verified by submit_transaction, which add_transaction_to_mempool
    // delegates to — so the authoritative ML-DSA-65 gate is never skipped, only relocated.
    if dil_pk.is_some() {
        let _verify_permit = match crate::node::VALUE_TX_VERIFY_SEM.try_acquire() {
            Ok(p) => p,
            Err(_) => return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Server busy: too many concurrent signature verifications",
                "details": "verify capacity reached; retry shortly"
            }))),
        };
        let tx_for_verify = tx.clone();
        let verify_ok = tokio::task::spawn_blocking(move || {
            crate::node::BlockchainNode::verify_user_tx_dilithium(&tx_for_verify)
        }).await.unwrap_or(false);
        if !verify_ok {
            println!("[WARN][TX] dilithium_verify_failed from={}", qnet_state::char_prefix(&tx_request.from, 16));
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Dilithium signature verification failed",
                "details": "ML-DSA-65 signature does not match the transaction data or the bound key"
            })));
        }
        println!("[INFO][TX] dilithium_verified from={} to={}",
                 qnet_state::char_prefix(&tx_request.from, 8), qnet_state::char_prefix(&tx_request.to, 8));
    }

    // Log quantum TX if present
    if tx.is_quantum_signed() {
        println!("[INFO][TX] quantum_signed from={}", qnet_state::char_prefix(&tx_request.from, 16));
    }

    // PRODUCTION v2.77: Use BLAKE3 via calculate_hash() for consistency
    // This ensures client receives the SAME hash as stored in blockchain
    match bincode::serialize(&tx) {
        Ok(_tx_bytes) => {
            let signed_id = crate::node::BlockchainNode::signed_id(&tx);
            
            // Add to mempool using public method. The answer names the hash that will land: this TX's, or
            // the one a copy of this very signed transfer is already pending under here.
            match blockchain.add_transaction_to_mempool(tx).await {
                Ok(tx_hash) => {
                    println!("[INFO][TX] submitted tx={} from={} to={} amount={}", 
                             qnet_state::char_prefix(&tx_hash, 16),
                             qnet_state::char_prefix(&tx_request.from, 16),
                             qnet_state::char_prefix(&tx_request.to, 16),
                             tx_request.amount);
                    let response = json!({
                        "success": true,
                        "tx_hash": tx_hash,
                        "signed_id": signed_id,
                        "message": "Transaction submitted successfully"
                    });
                    Ok(warp::reply::json(&response))
                }
                Err(e) => {
                    // v2.101: Log mempool rejection for debugging
                    println!("[WARN][TX] mempool_rejected from={} err={}", 
                             qnet_state::char_prefix(&tx_request.from, 16),
                             e);
                    // Surface the real reason: the client's self-heal paths key on it (a pk_unresolved
                    // reject must make an eliding wallet re-attach the pubkey; a nonce reject must make it
                    // refetch). A fixed "request failed" string made those retries dead code.
                    let error_response = json!({
                        "success": false,
                        "error": "Failed to add transaction to mempool",
                        "details": format!("{:?}", e)
                    });
                    Ok(warp::reply::json(&error_response))
                }
            }
        }
        Err(e) => {
            println!("[WARN][RPC] api_error endpoint=submit_tx err={}", e);
            let error_response = json!({
                "success": false,
                "error": "Failed to serialize transaction",
                "details": "request failed"
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

/// Why a door refuses a transfer's recipient (SH7 step 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RecipientRefusal {
    /// The recipient account is a contract.
    Contract,
    /// This node could not read the recipient's row.
    Unreadable,
}

impl RecipientRefusal {
    pub(super) fn code(self) -> &'static str {
        match self {
            RecipientRefusal::Contract => "recipient_is_contract",
            RecipientRefusal::Unreadable => "recipient_unreadable",
        }
    }

    pub(super) fn details(self, to: &str) -> String {
        match self {
            RecipientRefusal::Contract => format!(
                "{to} is a contract account: a contract holds no key and cannot send QNC or a built-in token, so value sent to it can never move again"),
            RecipientRefusal::Unreadable => format!("this node could not read the account {to}; ask again or ask another node"),
        }
    }

    pub(super) fn to_json(self, to: &str) -> Value {
        json!({
            "success": false,
            "error": match self {
                RecipientRefusal::Contract => "Recipient is a contract account",
                RecipientRefusal::Unreadable => "Recipient account could not be read",
            },
            "code": self.code(),
            "details": self.details(to),
            "recipient": to,
        })
    }

    pub(super) fn to_rpc_error(self, to: &str) -> RpcError {
        RpcError { code: -32602, message: format!("{}: {}", self.code(), self.details(to)), data: None }
    }
}

/// SH7 step 1, at the doors only: QNC or a QRC-20 token sent to a contract account can never move again (a
/// contract holds no key, no host function sends QNC, a WebAssembly contract cannot call a built-in token),
/// so every RPC door that builds a transfer refuses one whose recipient account is a contract. A row this
/// node cannot read is refused too (ask again), never guessed. Not a block rule: a block holding such a
/// transfer applies as before.
pub(super) fn recipient_verdict(read: Result<Option<qnet_state::AccountBasic>, ()>) -> Result<(), RecipientRefusal> {
    match read {
        Ok(Some(a)) if a.is_contract => Err(RecipientRefusal::Contract),
        Ok(_) => Ok(()),
        Err(()) => Err(RecipientRefusal::Unreadable),
    }
}

pub(super) async fn check_recipient(blockchain: &BlockchainNode, to: &str) -> Result<(), RecipientRefusal> {
    recipient_verdict(blockchain.try_get_account_basic(to).await)
}

/// The holder a QRC-20 call credits: `transfer` args[0], `transferFrom` args[1]. None for any other method,
/// for an argument that is not a string (apply refuses that call itself) and for the burn address, which
/// apply never credits.
pub(super) fn qrc20_credited<'a>(method: &str, args: &'a Value) -> Option<&'a str> {
    let i = match method {
        "transfer" => 0,
        "transferFrom" | "transfer_from" => 1,
        _ => return None,
    };
    args.get(i).and_then(|v| v.as_str()).filter(|to| *to != qnet_state::transaction::CANONICAL_BURN_ADDR)
}

/// The unsigned transfer the submit handler builds. The recipient and amount fill both the header the
/// signature covers and the payload apply pays, from the same request fields (tx_target_bound).
pub(super) fn transfer_tx(tx_request: &TransactionRequest, timestamp: u64) -> qnet_state::Transaction {
    qnet_state::Transaction::new(
        tx_request.from.clone(),
        Some(tx_request.to.clone()),
        tx_request.amount,
        tx_request.nonce,
        tx_request.gas_price,
        tx_request.gas_limit,
        timestamp,
        None, // no Ed25519 signature on QNet
        qnet_state::TransactionType::Transfer {
            from: tx_request.from.clone(),
            to: tx_request.to.clone(),
            amount: tx_request.amount,
        },
        None,
    )
}

/// `GET /api/v1/transaction/by-nonce/{from}/{nonce}` (O15): the value TX a wallet signed at this nonce, pending
/// or confirmed, by the hash its copy carries here and by `signed_id`, the same for every copy. A value TX's
/// timestamp is in its hash but outside its signature, so the copy that lands may carry another hash than the
/// one a submit returned. Confirmed TXs are looked up in the sender's recent history this node keeps.
pub(super) async fn handle_transaction_by_nonce(
    from: String,
    nonce: u64,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    if from.is_empty() || from.len() > 128 {
        return Ok(warp::reply::json(&json!({ "success": false, "error": "invalid_from" })));
    }
    let mempool = blockchain.get_mempool();
    if let Some(hash) = mempool.pending_value_hash(&from, nonce) {
        let signed_id = mempool.pooled_transaction(&hash).and_then(|tx| crate::node::BlockchainNode::signed_id(&tx));
        return Ok(warp::reply::json(&json!({
            "success": true, "status": "pending", "from": from, "nonce": nonce, "hash": hash, "signed_id": signed_id,
        })));
    }
    if let Some(tx) = confirmed_value_tx_by_nonce(&blockchain.get_storage(), &from, nonce) {
        return Ok(warp::reply::json(&json!({
            "success": true, "status": "confirmed", "from": from, "nonce": nonce, "hash": tx.hash,
            "signed_id": crate::node::BlockchainNode::signed_id(&tx),
        })));
    }
    Ok(warp::reply::json(&json!({ "success": false, "status": "not_found", "from": from, "nonce": nonce })))
}

/// The confirmed value TX `from` signed at `nonce`, from the sender's recent history this node keeps (the last
/// 500 index rows, most recent first). A sender's nonces rise with the height that includes them, but the rows
/// of one height come in hash order: a value TX numbered lower than `nonce` settles "not here" only once the
/// scan has left its height, since the one asked for may sit in the same block under a lower hash.
pub(super) fn confirmed_value_tx_by_nonce(storage: &crate::storage::Storage, from: &str, nonce: u64) -> Option<qnet_state::Transaction> {
    const PAGE: usize = 100;
    const PAGES: usize = 5;
    // The height of the newest lower-numbered value TX seen; rows below it cannot hold `nonce`.
    let mut floor: Option<u64> = None;
    for page in 0..PAGES {
        let rows = storage.address_transactions_with_height(from, page, PAGE).unwrap_or_default();
        for (height, tx) in &rows {
            if let (Some(f), Some(h)) = (floor, height) {
                if h < &f { return None; }
            }
            if tx.from != from || !tx.is_value_class() { continue; }
            if tx.nonce == nonce { return Some(tx.clone()); }
            // A row whose height does not parse settles nothing: the scan goes on, to its bound.
            if tx.nonce < nonce && floor.is_none() { floor = *height; }
        }
        if rows.len() < PAGE { break; }
    }
    None
}


pub(super) async fn handle_transaction_get(
    tx_hash: String,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    // v3.19: Validate tx_hash parameter (max 128 chars for hex hash)
    if tx_hash.len() > 128 {
        return Ok(warp::reply::json(&json!({
            "error": "Invalid tx_hash",
            "message": "Transaction hash parameter too long (max 128 characters)"
        })));
    }
    
    // PRODUCTION: Fetch real transaction from blockchain storage
    match blockchain.get_transaction(&tx_hash).await {
        Ok(Some(tx)) => {
            // QUANTUM v2.25.2: Include quantum signature info in explorer
            let is_quantum = tx.is_quantum_signed();
            let effective_gas = tx.effective_gas_price().saturating_mul(tx.gas_limit);
            
            let mut transaction_data = json!({
                "hash": tx.hash,
                "from": tx.from,
                "to": tx.to,
                "amount": tx.amount,
                "nonce": tx.nonce,
                "gas_price": tx.gas_price,
                "gas_limit": tx.gas_limit,
                "effective_gas_cost": effective_gas,
                "timestamp": tx.timestamp,
                "block_height": tx.block_height,
                "status": tx.status,
                "tx_type": tx.tx_type,  // Include transaction type for explorer
                "is_quantum_signed": is_quantum,
                "signature_type": if is_quantum { "Dilithium3 (ML-DSA-65)" } else { "none" }
            });
            
            // Add quantum signature details if present
            if is_quantum {
                transaction_data["quantum_security"] = json!({
                    "algorithm": "CRYSTALS-Dilithium3 (NIST FIPS 204)",
                    "quantum_resistant": true,
                    "gas_premium": "50%",
                    "dilithium_signature_present": tx.dilithium_signature.is_some(),
                    "dilithium_pubkey_present": tx.dilithium_public_key.is_some()
                });
            }
            
            // Add Fast Finality Indicators if available
            if let Some(ref confirmation_level) = tx.confirmation_level {
                transaction_data["finality_indicators"] = json!({
                    "level": format!("{:?}", confirmation_level),
                    "safety_percentage": tx.safety_percentage.unwrap_or(0.0),
                    "confirmations": tx.confirmations.unwrap_or(0),
                    "time_to_finality": tx.time_to_finality.unwrap_or(90),
                    "risk_assessment": match tx.safety_percentage.unwrap_or(0.0) {
                        s if s >= 99.99 => "safe_for_any_amount",
                        s if s >= 99.9 => "safe_for_amounts_under_10000000_qnc",  // 10M QNC (~0.25% of supply)
                        s if s >= 99.0 => "safe_for_amounts_under_1000000_qnc",   // 1M QNC (~0.025% of supply)
                        s if s >= 95.0 => "safe_for_amounts_under_100000_qnc",    // 100K QNC (~0.0025% of supply)
                        s if s >= 90.0 => "safe_for_amounts_under_10000_qnc",     // 10K QNC (~0.00025% of supply)
                        _ => "wait_for_more_confirmations"
                    }
                });
            }
            
            let response = json!({
                "tx_hash": tx_hash,
                "transaction": transaction_data,
                "status": "found"
            });
            Ok(warp::reply::json(&response))
        }
        Ok(None) => {
            let response = json!({
                "tx_hash": tx_hash,
                "transaction": null,
                "status": "not_found",
                "message": "Transaction not found in blockchain or mempool"
            });
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            println!("[API] ❌ Failed to get transaction {}: {}", tx_hash, e);
            let response = json!({
                "tx_hash": tx_hash,
                "transaction": null,
                "status": "error",
                "message": format!("Failed to fetch transaction: {}", e)
            });
            Ok(warp::reply::json(&response))
        }
    }
}

pub(super) async fn handle_mempool_status(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    let mempool_size = blockchain.get_mempool_size().await.unwrap_or(0);
    let response = json!({
        "size": mempool_size,
        "max_size": 5_000_000, // 5M TX mempool for 50K TX/block support
        "status": "healthy",
        "node_id": blockchain.get_public_display_name(),
        "timestamp": chrono::Utc::now().timestamp()
    });
    Ok(warp::reply::json(&response))
}

pub(super) async fn handle_mempool_transactions(
    remote_addr: Option<std::net::SocketAddr>,
    query_params: HashMap<String, String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }

    // v10.0: Pagination support to prevent unbounded responses
    let limit = query_params.get("limit")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(100)
        .min(1000); // max 1000
    let offset = query_params.get("offset")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);

    let all_txs = blockchain.get_mempool_transactions().await;
    let total_count = all_txs.len();
    let txs: Vec<_> = all_txs.into_iter().skip(offset).take(limit).collect();

    let response = json!({
        "transactions": txs,
        "count": txs.len(),
        "total_count": total_count,
        "offset": offset,
        "limit": limit,
        "node_id": blockchain.get_public_display_name()
    });
    Ok(warp::reply::json(&response))
}

// ═══════════════════════════════════════════════════════════════════════════
// MEV PROTECTION HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

/// POST /api/v1/bundle/submit
/// Submit a transaction bundle for MEV protection
/// ARCHITECTURE: Flashbots-style bundles with 0-20% dynamic allocation
pub(super) async fn handle_bundle_submit(
    bundle_request: serde_json::Value,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v10.0: Rate limit bundle submissions
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "mev_bundle") {
        return Ok(rate_limit_response);
    }
    use qnet_mempool::TxBundle;
    use std::time::{SystemTime, UNIX_EPOCH};
    
    // Check if MEV mempool is enabled
    let mev_mempool = match blockchain.get_mev_mempool() {
        Some(pool) => pool,
        None => {
            let error_response = json!({
                "success": false,
                "error": "MEV protection not enabled on this node"
            });
            return Ok(warp::reply::json(&error_response));
        }
    };
    
    // Parse bundle request
    let transactions = match bundle_request["transactions"].as_array() {
        Some(txs) => txs.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>(),
        None => {
            let error_response = json!({
                "success": false,
                "error": "Missing 'transactions' array field"
            });
            return Ok(warp::reply::json(&error_response));
        }
    };
    
    let min_timestamp = bundle_request["min_timestamp"].as_u64().unwrap_or_else(|| {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
    });
    
    let max_timestamp = bundle_request["max_timestamp"].as_u64().unwrap_or_else(|| {
        min_timestamp + 60 // Default: 60 seconds window
    });
    
    let reverting_tx_hashes = bundle_request["reverting_tx_hashes"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    
    let signature = match bundle_request["signature"].as_str() {
        Some(sig) => hex::decode(sig).unwrap_or_default(),
        None => {
            let error_response = json!({
                "success": false,
                "error": "Missing 'signature' field"
            });
            return Ok(warp::reply::json(&error_response));
        }
    };
    
    let submitter_pubkey = match bundle_request["submitter_pubkey"].as_str() {
        Some(pk) => hex::decode(pk).unwrap_or_default(),
        None => {
            let error_response = json!({
                "success": false,
                "error": "Missing 'submitter_pubkey' field"
            });
            return Ok(warp::reply::json(&error_response));
        }
    };
    
    // Calculate total gas price for bundle
    // v2.26: Direct access - SimpleMempool is already thread-safe
    // v2.26: Use binary transactions with bincode (not JSON!)
    let mempool = blockchain.get_mempool();
    let mut total_gas_price = 0u64;
    for tx_hash in &transactions {
        if let Some(tx_bytes) = mempool.get_binary_transaction(&tx_hash) {
            // Try bincode first (new format), then JSON (legacy)
            if let Ok(tx) = bincode::deserialize::<qnet_state::Transaction>(&tx_bytes) {
                total_gas_price = total_gas_price.saturating_add(tx.gas_price);
            } else if let Ok(json_str) = String::from_utf8(tx_bytes) {
                // Fallback: legacy JSON format
                if let Ok(tx_data) = serde_json::from_str::<serde_json::Value>(&json_str) {
                if let Some(gas_price) = tx_data["gas_price"].as_u64() {
                    total_gas_price = total_gas_price.saturating_add(gas_price);
                }
            }
        }
    }
    }
    
    // Create bundle
    let bundle = TxBundle {
        bundle_id: String::new(), // Will be generated in add_bundle
        transactions,
        tx_bytes: Vec::new(), // Captured authoritatively inside add_bundle
        min_timestamp,
        max_timestamp,
        reverting_tx_hashes,
        signature,
        submitter_pubkey,
        total_gas_price,
    };
    
    // Get REAL reputation for bundle submitter
    // SECURITY: This is used for MEV bundle reputation check (min 80% required)
    // ARCHITECTURE: Reputation from DeterministicReputationState (synced via blocks)
    use qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
    let submitter_node_id = hex::encode(&bundle.submitter_pubkey);
    let submitter_reputation = if let Some(p2p) = blockchain.get_p2p() {
        p2p.get_node_combined_reputation(&submitter_node_id)
    } else {
        INITIAL_REPUTATION // Default if P2P not initialized
    };
    
    // Get current time
    let current_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    
    // Add bundle to MEV mempool
    match mev_mempool.add_bundle(bundle, submitter_reputation, current_time).await {
        Ok(bundle_id) => {
            // v10.0: Track submitter IP for cancel authorization
            let submitter_ip = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
            BUNDLE_SUBMITTER_IPS.insert(bundle_id.clone(), submitter_ip);
            // Periodic cleanup: remove entries for expired/non-existent bundles
            if BUNDLE_SUBMITTER_IPS.len() > 500 {
                let keys: Vec<String> = BUNDLE_SUBMITTER_IPS.iter().map(|e| e.key().clone()).collect();
                for key in keys {
                    if mev_mempool.get_bundle(&key).is_none() {
                        BUNDLE_SUBMITTER_IPS.remove(&key);
                    }
                }
            }
            let response = json!({
                "success": true,
                "bundle_id": bundle_id,
                "message": "Bundle submitted successfully"
            });
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            let error_response = json!({
                "success": false,
                "error": format!("Failed to add bundle: {}", e)
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

/// GET /api/v1/bundle/{bundle_id}/status
/// Get status of a submitted bundle
pub(super) async fn handle_bundle_status(
    bundle_id: String,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};

    // v10.0: Rate limit bundle status queries
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "mev_bundle") {
        return Ok(rate_limit_response);
    }

    // Check if MEV mempool is enabled
    let mev_mempool = match blockchain.get_mev_mempool() {
        Some(pool) => pool,
        None => {
            let error_response = json!({
                "success": false,
                "error": "MEV protection not enabled on this node"
            });
            return Ok(warp::reply::json(&error_response));
        }
    };
    
    // Get bundle
    match mev_mempool.get_bundle(&bundle_id) {
        Some(bundle) => {
            let current_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            let status = if current_time < bundle.min_timestamp {
                "pending"
            } else if current_time > bundle.max_timestamp {
                "expired"
            } else {
                "active"
            };
            
            let response = json!({
                "success": true,
                "bundle_id": bundle_id,
                "status": status,
                "transaction_count": bundle.transactions.len(),
                "total_gas_price": bundle.total_gas_price,
                "min_timestamp": bundle.min_timestamp,
                "max_timestamp": bundle.max_timestamp
            });
            Ok(warp::reply::json(&response))
        }
        None => {
            let error_response = json!({
                "success": false,
                "error": "Bundle not found"
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

/// DELETE /api/v1/bundle/{bundle_id}
/// Cancel a submitted bundle
pub(super) async fn handle_bundle_cancel(
    bundle_id: String,
    remote_addr: Option<std::net::SocketAddr>,
    from_page: bool,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v10.0: Rate limit bundle cancellations
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "mev_bundle") {
        return Ok(rate_limit_response);
    }

    // Check if MEV mempool is enabled
    let mev_mempool = match blockchain.get_mev_mempool() {
        Some(pool) => pool,
        None => {
            let error_response = json!({
                "success": false,
                "error": "MEV protection not enabled on this node"
            });
            return Ok(warp::reply::json(&error_response));
        }
    };

    // v10.0 SECURITY: Verify cancel request comes from the original submitter IP. A page's request is nobody in
    // particular (gate_client): any site would otherwise cancel its visitors' bundles from their own address.
    let caller_ip = gate_client(remote_addr, from_page).map(|a| a.ip().to_string()).unwrap_or_default();
    if let Some(submitter_ip) = BUNDLE_SUBMITTER_IPS.get(&bundle_id) {
        if submitter_ip.value() != &caller_ip && !is_internal_ip(&caller_ip) {
            println!("[WARN][RPC] bundle_cancel_rejected bundle={} caller_ip={} submitter_ip={}",
                     qnet_state::char_prefix(&bundle_id, 16), caller_ip, submitter_ip.value());
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Unauthorized: bundle can only be cancelled by the original submitter"
            })));
        }
    }

    // Remove bundle
    if mev_mempool.remove_bundle(&bundle_id) {
        BUNDLE_SUBMITTER_IPS.remove(&bundle_id);
        let response = json!({
            "success": true,
            "message": "Bundle cancelled successfully"
        });
        Ok(warp::reply::json(&response))
    } else {
        let error_response = json!({
            "success": false,
            "error": "Bundle not found"
        });
        Ok(warp::reply::json(&error_response))
    }
}

/// The unsigned batch the handler builds. The envelope is (BATCH_TRANSFERS_TO, exact sum) and an empty
/// memo travels as none: the signed digest writes nothing for either, so the client's signature still
/// verifies and the two forms cannot give one batch two hashes (tx_target_bound).
pub(super) fn batch_transfer_tx(
    request: &BatchTransferRequest, from: &str, total_amount: u64, timestamp: u64,
) -> qnet_state::Transaction {
    qnet_state::Transaction::new(
        from.to_string(),
        Some(qnet_state::transaction::BATCH_TRANSFERS_TO.to_string()),
        total_amount,
        request.nonce,
        request.gas_price,
        request.gas_limit,
        timestamp,
        None, // no Ed25519 on QNet
        qnet_state::TransactionType::BatchTransfers {
            transfers: request.transfers.iter().map(|t| BatchTransferData {
                to_address: t.to_address.clone(),
                amount: t.amount,
                memo: t.memo.clone().filter(|m| !m.is_empty()),
            }).collect(),
            batch_id: request.batch_id.clone()
        },
        None,
    )
}

pub(super) async fn handle_batch_transfer(
    request: BatchTransferRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // SECURITY v6.1: IP rate limit
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "batch_transfer") {
        return Ok(rate_limit_response);
    }

    // Bounds first — cheap rejects before any crypto.
    if request.transfers.is_empty() || request.transfers.len() > 1000 {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "batch size must be 1..=1000"
        })));
    }
    let from_address = request.transfers[0].from.clone();
    if let Err(e) = validate_eon_address_with_error(&from_address) {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "Invalid sender address", "details": e
        })));
    }
    for (i, transfer) in request.transfers.iter().enumerate() {
        if transfer.from != from_address {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": format!("All transfers must share one sender; transfer #{} differs", i + 1)
            })));
        }
        if let Err(e) = validate_eon_address_with_error(&transfer.to_address) {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": format!("Invalid recipient address in transfer #{}", i + 1),
                "details": e
            })));
        }
        if transfer.amount == 0 || transfer.memo.as_ref().map_or(false, |m| m.len() > 128) {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": format!("transfer #{}: zero amount or memo > 128 bytes", i + 1)
            })));
        }
    }
    let mut checked = std::collections::HashSet::new();
    for (i, transfer) in request.transfers.iter().enumerate() {
        if !checked.insert(transfer.to_address.as_str()) { continue; }
        if let Err(r) = check_recipient(&blockchain, &transfer.to_address).await {
            let mut body = r.to_json(&transfer.to_address);
            body["transfer"] = json!(i + 1);
            return Ok(warp::reply::json(&body));
        }
    }

    // Checked, not saturated: the envelope amount must equal the transfers' exact sum (tx_target_bound).
    let total_amount: u64 = match request.transfers.iter().try_fold(0u64, |acc, t| acc.checked_add(t.amount)) {
        Some(t) => t,
        None => return Ok(warp::reply::json(&json!({
            "success": false, "error": "sum of transfer amounts overflows"
        }))),
    };

    // Pure-PQ: one ML-DSA-65 signature over the batch canonical preimage
    // (from/total/count/batch_id/transfers-digest/nonce/gas). Elided pk is
    // rehydrated from committed state by the shared ingest gate.
    if request.dilithium_signature.is_empty() {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "batch requires dilithium_signature (pure-PQ)"
        })));
    }
    let dil_pk = request.dilithium_public_key.as_ref().filter(|p| !p.is_empty()).cloned();
    if let Some(ref p) = dil_pk {
        match crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(p) {
            Some(d) if d == from_address => {}
            _ => return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "from not derived from dilithium_public_key (ownership unproven)"
            }))),
        }
    }

    let batch_tx = batch_transfer_tx(&request, &from_address, total_amount,
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
    .with_quantum_signature(
        hex::decode(&request.dilithium_signature).ok(),
        dil_pk.as_deref().and_then(|p| hex::decode(p).ok()),
    );
    
    // Submit batch transaction to blockchain
    let signed_id = crate::node::BlockchainNode::signed_id(&batch_tx);
    match blockchain.submit_transaction(batch_tx).await {
        Ok(tx_hash) => {
            if crate::node::is_debug() {
                println!("[DBG][BATCH] submitted transfers={} total={} hash={}",
                       request.transfers.len(), total_amount, tx_hash);
            }
            
            let response = json!({
                "success": true,
                "batch_id": request.batch_id,
                "transaction_hash": tx_hash,
                "signed_id": signed_id,
                "transfer_count": request.transfers.len(),
                "total_amount": total_amount,
                "from_address": from_address,
                "message": format!("Batch transfer submitted with {} transfers", request.transfers.len()),
                "processed_by": blockchain.get_node_id()
            });
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            println!("[WARN][RPC] api_error endpoint=batch_transfer batch_id={} err={}", request.batch_id, e);
            let response = json!({
                "success": false,
                "batch_id": request.batch_id,
                "error": "request failed",
                "transfer_count": request.transfers.len(),
                "total_amount": total_amount,
                "message": "Batch transfer failed to submit"
            });
            Ok(warp::reply::json(&response))
        }
    }
}

pub(super) async fn handle_node_discovery(
    remote_addr: Option<std::net::SocketAddr>,
    from_page: bool,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // FIX M13: Rate limit node discovery
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    let peers = blockchain.get_connected_peers().await.unwrap_or_default();
    
    // FIX R20-M2: Mask peer IPs for external callers to prevent network topology mapping. A page is an
    // external caller whatever address its visitor sends from (gate_client).
    let caller_ip = gate_client(remote_addr, from_page)
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let caller_is_internal = is_internal_ip(&caller_ip);

    let peer_nodes: Vec<Value> = peers.iter().map(|peer| {
        let real_reputation = qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
        if caller_is_internal {
            // Internal nodes: full peer info for P2P synchronization
            json!({
                "node_id": peer.id,
                "address": peer.address,
                "api_port": 8001,
                "node_type": peer.node_type,
                "region": peer.region,
                "last_seen": peer.last_seen,
                "reputation": real_reputation,
                "api_endpoint": format!("http://{}:8001/api/v1/", peer.address)
            })
        } else {
            // External callers: no IP/address exposure, only public metadata
            json!({
                "node_id": peer.id,
                "node_type": peer.node_type,
                "region": peer.region,
                "reputation": real_reputation
            })
        }
    }).collect();
    
    // FIX R20-M2: Mask current node IP for external callers
    let current_node_info = if caller_is_internal {
        json!({
            "node_id": blockchain.get_public_display_name(),
            "node_type": format!("{:?}", blockchain.get_node_type()),
            "region": format!("{:?}", blockchain.get_region()),
            "api_endpoint": format!("http://{}:8001/api/v1/",
                std::env::var("QNET_PUBLIC_IP").unwrap_or_else(|_| "0.0.0.0".to_string()))
        })
    } else {
        json!({
            "node_id": blockchain.get_public_display_name(),
            "node_type": format!("{:?}", blockchain.get_node_type()),
            "region": format!("{:?}", blockchain.get_region())
        })
    };

    let response = json!({
        "current_node": current_node_info,
        "available_nodes": peer_nodes,
        "total_nodes": peer_nodes.len() + 1,
        "network_status": "healthy"
    });
    Ok(warp::reply::json(&response))
}

pub(super) async fn handle_node_health(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // FIX M13: Rate limit node health
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    let height = blockchain.get_height().await;
    let peer_count = blockchain.get_peer_count().await.unwrap_or(0);
    let mempool_size = blockchain.get_mempool_size().await.unwrap_or(0);
    
    
    // API FIX: Get actual network status
    let mut network_height = height;
    let mut sync_status = "synchronized";
    let mut validated_peers = 0;
    
    if let Some(p2p) = blockchain.get_unified_p2p() {
        // API FIX: Get real validated peers count (for consensus safety)
        let validated = p2p.get_validated_active_peers();
        validated_peers = validated.len();
        
        // API DEADLOCK FIX: Use cached height to avoid circular calls
        // CRITICAL FIX v2.105: Use max(local, cached) to prevent stale peer heights
        // from showing network_height lower than local_height (ShredProtocol bug)
        if let Some(cached_height) = p2p.get_cached_network_height() {
            network_height = std::cmp::max(height, cached_height);
            if height < network_height {
                sync_status = "syncing";
            }
        } else if std::env::var("QNET_BOOTSTRAP_ID").is_ok() || 
                  std::env::var("QNET_GENESIS_BOOTSTRAP").unwrap_or_default() == "1" {
            // Genesis node in bootstrap mode - use local height
            network_height = height;
            sync_status = "bootstrap"; // Special status for network bootstrap
            println!("[API] 🚀 Node health: bootstrap mode active");
        } else {
            // Can't determine network height
            if validated_peers == 0 {
                sync_status = "isolated"; // No peers
            } else {
                sync_status = "checking"; // Have peers but no consensus
            }
        }
    }
    
    // API FIX: Determine node health based on real metrics
    let health_status = if sync_status == "bootstrap" {
        "healthy" // Bootstrap nodes are healthy by definition
    } else if peer_count == 0 {
        "isolated"
    } else if sync_status == "syncing" {
        "syncing"
    } else if validated_peers < 4 && !std::env::var("QNET_BOOTSTRAP_ID").is_ok() {
        "degraded" // Not enough peers for Byzantine consensus (except for bootstrap nodes)
    } else if sync_status == "checking" {
        "checking" // Have peers but can't verify consensus
    } else {
        "healthy"
    };
    
    // API FIX: Calculate actual uptime from node start
    let uptime = if let Ok(start_time) = std::env::var("QNET_NODE_START_TIME") {
        if let Ok(start) = start_time.parse::<i64>() {
            chrono::Utc::now().timestamp() - start
        } else {
            0
        }
    } else {
        0
    };
    
    // v14.8.10: Runtime consensus + clock-drift observability
    // ═══════════════════════════════════════════════════════════════════════════
    // v14.8.11: observability fields for fleet operators running thousands of
    // Super-nodes. Scraped by Prometheus/Grafana; never fed back into consensus.
    //   * clock_drift_*          — detect host NTP / VM / hypervisor issues
    //   * current_timeout_round  — 0 in steady state, > 0 during BFT failover
    //   * failover_*             — aggregated counters since process start
    // Self-pause and NTP-resync fields removed in v14.8.11 — drifted nodes now
    // stay productive via the median-aware timestamp rules and the wide
    // future-tolerance window.
    // ═══════════════════════════════════════════════════════════════════════════
    let clock_drift_ema = crate::node::get_clock_drift_ema_secs();
    let clock_drift_peak = crate::node::get_clock_drift_peak_secs();
    let current_timeout_round = crate::node::get_current_timeout_round();
    let (max_slot_delay, max_timeout_round, failover_count, ts_rejections) =
        crate::node::get_failover_metrics();

    let response = json!({
        "status": health_status, // API FIX: Real health status
        "node_id": blockchain.get_public_display_name(),
        "height": height,
        "network_height": network_height, // API FIX: Network height
        "sync_status": sync_status, // API FIX: Sync status
        "peers": peer_count,
        "validated_peers": validated_peers, // API FIX: Validated peers for consensus
        "mempool_size": mempool_size,
        "node_type": format!("{:?}", blockchain.get_node_type()),
        "region": format!("{:?}", blockchain.get_region()),
        "uptime_seconds": uptime, // API FIX: Actual uptime in seconds
        "version": "1.0.0", // API FIX: Correct version
        "api_version": "v1",
        // v14.8.11: clock-drift observability (host NTP health indicator)
        "clock_drift_ema_secs": clock_drift_ema,
        "clock_drift_peak_secs": clock_drift_peak,
        // v14.8.10: BFT rotation state (0 in steady state, > 0 during failover)
        "current_timeout_round": current_timeout_round,
        // v14.8.10: Aggregated failover counters (since process start)
        "max_slot_delay_secs": max_slot_delay,
        "max_timeout_round_seen": max_timeout_round,
        "failover_count": failover_count,
        "timestamp_rejections": ts_rejections
    });
    Ok(warp::reply::json(&response))
}

pub(super) async fn handle_gas_recommendations(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // FIX M13: Rate limit gas recommendations
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    // PRODUCTION: Calculate real gas recommendations based on mempool and network state
    let mempool_size = blockchain.get_mempool_size().await.unwrap_or(0);
    let current_height = blockchain.get_height().await;
    
    // Per-gas-unit prices (nanoQNC/gas), rooted in the single-source floor so a mobile transfer
    // (gas_limits::TRANSFER) at the eco tier costs exactly BASE_FEE_NANO_QNC = 0.0001 QNC. Congestion
    // scales the multiple; the previous 50_000–250_000 values were the old total-fee-as-per-unit bug.
    let floor = qnet_state::transaction::MIN_GAS_PRICE;
    let base_fee = match mempool_size {
        0..=10 => floor,            // Very low traffic
        11..=50 => floor * 3 / 2,   // Low traffic
        51..=100 => floor * 2,      // Normal traffic
        101..=200 => floor * 3,     // High traffic
        _ => floor * 5,             // Very high traffic
    };
    
    let network_load = match mempool_size {
        0..=10 => "very_low",
        11..=50 => "low", 
        51..=100 => "normal",
        101..=200 => "high",
        _ => "very_high",
    };
    
    // QNet-specific gas recommendations (optimized for mobile)
    let eco_price = base_fee;
    let standard_price = (base_fee as f64 * 1.5) as u64;
    let fast_price = base_fee * 2;
    let priority_price = base_fee * 3;
    
    // Estimate confirmation times based on consensus timing
    let (eco_time, standard_time, fast_time, priority_time) = match network_load {
        "very_low" => ("15s", "10s", "5s", "3s"),
        "low" => ("30s", "20s", "10s", "5s"),
        "normal" => ("45s", "30s", "15s", "8s"),
        "high" => ("90s", "60s", "30s", "15s"),
        _ => ("180s", "120s", "60s", "30s"),
    };
    
    println!("[GAS] 📊 Gas recommendations calculated: mempool={}, base_fee={}, network_load={}", 
             mempool_size, base_fee, network_load);
    
    let response = json!({
        "recommendations": {
            "eco": {
                "gas_price": eco_price,
                "estimated_time": eco_time,
                // ML-DSA signed, as every wallet TX is: the chain charges gas_price + gas_price/2.
                "cost_qnc": ((eco_price + eco_price / 2) as f64 * qnet_state::transaction::gas_limits::TRANSFER as f64) / 1_000_000_000.0
            },
            "standard": {
                "gas_price": standard_price,
                "estimated_time": standard_time,
                "cost_qnc": ((standard_price + standard_price / 2) as f64 * qnet_state::transaction::gas_limits::TRANSFER as f64) / 1_000_000_000.0
            },
            "fast": {
                "gas_price": fast_price,
                "estimated_time": fast_time,
                "cost_qnc": ((fast_price + fast_price / 2) as f64 * qnet_state::transaction::gas_limits::TRANSFER as f64) / 1_000_000_000.0
            },
            "priority": {
                "gas_price": priority_price,
                "estimated_time": priority_time,
                "cost_qnc": ((priority_price + priority_price / 2) as f64 * qnet_state::transaction::gas_limits::TRANSFER as f64) / 1_000_000_000.0
            }
        },
        "network_load": network_load,
        "mempool_size": mempool_size,
        "current_height": current_height,
        "base_fee": base_fee,
        "node_id": blockchain.get_node_id()
    });
    Ok(warp::reply::json(&response))
}

pub(super) async fn handle_network_ping(
    ping_request: Value,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // FIX M13: Rate limit ping (write category — triggers signing)
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "write") {
        return Ok(rate_limit_response);
    }
    use std::time::{SystemTime, UNIX_EPOCH};
    
    let start_time = SystemTime::now();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    
    // Extract challenge from ping request
    let challenge = ping_request.get("challenge")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let requester_id = ping_request.get("requester_id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    
    // CORRECT PROTOCOL: We (target) sign the challenge with OUR private key
    // This proves we are online and control our keys
    let my_node_id = blockchain.get_node_id();
    let my_node_type = blockchain.get_node_type();
    
    // Sign the challenge with our Dilithium key
    let signature = sign_with_dilithium(&my_node_id, challenge).await;
    
    // Validate challenge format (must be 64 hex chars = 32 bytes)
    if challenge.len() != 64 || !challenge.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid challenge format",
            "timestamp": now
        })));
    }
    
    // Calculate response time
    let response_time = start_time.elapsed().unwrap_or_default().as_millis() as u32;
    
    // Record successful ping for reward system
    let current_height = blockchain.get_height().await;
    
    println!("[PING] 📡 Ping challenge from {} answered by {} ({:?}): {}ms response", 
             requester_id, my_node_id, my_node_type, response_time);
    
    // NOTE: We don't record ping here - the REQUESTER records it after verifying our signature
    // This is the correct protocol: target proves liveness, requester records proof
    
    // Return signed response - requester will verify this signature
    Ok(warp::reply::json(&json!({
        "success": true,
        "node_id": my_node_id,
        "node_type": my_node_type,
        "signature": signature,
        "challenge": challenge,
        "response_time_ms": response_time,
        "height": current_height,
        "timestamp": now,
        "quantum_secure": true
    })))
}

#[cfg(test)]
mod recipient_tests {
    use super::*;

    fn basic(is_contract: bool, contract_type: Option<&str>) -> qnet_state::AccountBasic {
        qnet_state::AccountBasic {
            address: "r".to_string(), balance: 0, nonce: 0, has_dilithium_pk: false,
            is_contract, contract_type: contract_type.map(str::to_string),
        }
    }

    /// SH7 step 1: a contract recipient is refused at the door, a missing or wallet row passes, and a row
    /// this node cannot read is refused (ask again), never guessed.
    #[test]
    fn a_contract_recipient_is_refused_at_the_door() {
        assert_eq!(recipient_verdict(Ok(Some(basic(true, Some("qrc20"))))), Err(RecipientRefusal::Contract));
        assert_eq!(recipient_verdict(Ok(Some(basic(true, Some("wasm"))))), Err(RecipientRefusal::Contract));
        assert_eq!(recipient_verdict(Ok(Some(basic(false, None)))), Ok(()));
        assert_eq!(recipient_verdict(Ok(None)), Ok(()), "a new account");
        assert_eq!(recipient_verdict(Err(())), Err(RecipientRefusal::Unreadable));
        let body = RecipientRefusal::Contract.to_json("eon_contract");
        assert_eq!((body["success"].clone(), body["code"].clone(), body["recipient"].clone()),
                   (json!(false), json!("recipient_is_contract"), json!("eon_contract")));
        assert!(body["details"].as_str().unwrap().contains("contract account"));
        let rpc = RecipientRefusal::Unreadable.to_rpc_error("eon_x");
        assert_eq!(rpc.code, -32602);
        assert!(rpc.message.starts_with("recipient_unreadable: "));
    }

    /// The holder a QRC-20 call credits: transfer's first argument, transferFrom's second; nothing for
    /// other methods, a non-string argument or the burn address (apply never credits it).
    #[test]
    fn the_qrc20_credited_holder_is_the_one_apply_credits() {
        let burn = qnet_state::transaction::CANONICAL_BURN_ADDR;
        assert_eq!(qrc20_credited("transfer", &json!(["bob", "5"])), Some("bob"));
        assert_eq!(qrc20_credited("transferFrom", &json!(["alice", "bob", 5])), Some("bob"));
        assert_eq!(qrc20_credited("transfer_from", &json!(["alice", "bob", 5])), Some("bob"));
        assert_eq!(qrc20_credited("transfer", &json!([burn, "5"])), None);
        assert_eq!(qrc20_credited("transfer", &json!([7, "5"])), None);
        assert_eq!(qrc20_credited("transfer", &json!("00ff")), None);
        for other in ["approve", "mint", "burn", "balanceOf"] {
            assert_eq!(qrc20_credited(other, &json!(["bob", "5"])), None, "{other}");
        }
    }
}

#[cfg(test)]
mod by_nonce_tests {
    use super::*;

    fn transfer(from: &str, to: &str, nonce: u64, ts: u64) -> qnet_state::Transaction {
        qnet_state::Transaction::new(
            from.to_string(), Some(to.to_string()), 1_000, nonce, 10, 10_000, ts, None,
            qnet_state::TransactionType::Transfer { from: from.to_string(), to: to.to_string(), amount: 1_000 },
            None,
        )
    }

    /// Store the block at `height` on `parent`; its hash, the next block's parent.
    fn save(storage: &crate::storage::Storage, height: u64, parent: [u8; 32], txs: Vec<qnet_state::Transaction>) -> [u8; 32] {
        let mut b = qnet_state::MicroBlock::new(height, 1000 + height, parent, txs, "genesis_node_001".to_string());
        b.merkle_root = crate::node::BlockchainNode::calculate_merkle_root(&b.transactions);
        storage.save_microblock(height, &bincode::serialize(&b).unwrap()).unwrap();
        b.hash()
    }

    /// Two transfers of `from` in one block at `n` and `n + 1`, whose index rows come in the given order (rows of
    /// one height are read in descending hash order).
    fn pair(from: &str, n: u64, lower_first: bool) -> (qnet_state::Transaction, qnet_state::Transaction) {
        for ts in 1_800_000_000u64.. {
            let (a, b) = (transfer(from, "eon_dst", n, ts), transfer(from, "eon_dst", n + 1, ts));
            if (a.hash > b.hash) == lower_first { return (a, b); }
        }
        unreachable!()
    }

    /// M8: a sender's two transfers in one block are found whichever hash order their rows come in, and a
    /// nonce never included is settled once the scan leaves the height of a lower one.
    #[test]
    fn a_confirmed_transfer_is_found_whatever_the_hash_order_in_its_block() {
        let dir = tempfile::TempDir::new().unwrap();
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).unwrap();
        let (one, _) = pair("eon_s", 1, true);
        let (two, three) = pair("eon_s", 2, true);
        let (u2, u3) = pair("eon_u", 2, false);
        let g = save(&storage, 0, [0u8; 32], vec![transfer("eon_g", "eon_h", 0, 1)]);

        let b1 = save(&storage, 1, g, vec![one.clone()]);
        // A transfer to the sender rides in the same block: not its own, skipped.
        save(&storage, 2, b1, vec![two.clone(), three.clone(), u2.clone(), u3.clone(), transfer("eon_other", "eon_s", 9, 7)]);

        let rows = storage.address_transactions_with_height("eon_s", 0, 100).unwrap();
        let order: Vec<(Option<u64>, u64)> = rows.iter().filter(|(_, t)| t.from == "eon_s").map(|(h, t)| (*h, t.nonce)).collect();
        assert_eq!(order, vec![(Some(2), 2), (Some(2), 3), (Some(1), 1)], "the lower nonce's row comes first in its block");
        let found = |from: &str, n: u64| confirmed_value_tx_by_nonce(&storage, from, n).map(|t| t.hash);
        assert_eq!(found("eon_s", 3), Some(three.hash.clone()), "behind a lower nonce of the same block");
        assert_eq!(found("eon_s", 2), Some(two.hash.clone()));
        assert_eq!(found("eon_s", 1), Some(one.hash.clone()));
        assert_eq!(found("eon_u", 2), Some(u2.hash.clone()));
        assert_eq!(found("eon_u", 3), Some(u3.hash.clone()));
        assert_eq!(found("eon_s", 4), None, "never included");
        assert_eq!(found("eon_s", 9), None, "an incoming transfer is not the sender's");
        assert_eq!(found("eon_nobody", 1), None);
    }
}

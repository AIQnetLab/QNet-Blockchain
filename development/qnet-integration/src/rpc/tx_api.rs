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
    let tx = qnet_state::Transaction::new(
        tx_request.from.clone(),
        Some(tx_request.to.clone()),
        tx_request.amount,
        tx_request.nonce,
        tx_request.gas_price,
        tx_request.gas_limit,
        chrono::Utc::now().timestamp() as u64,
        None, // no Ed25519 signature on QNet
        qnet_state::TransactionType::Transfer {
            from: tx_request.from.clone(),
            to: tx_request.to.clone(),
            amount: tx_request.amount,
        },
        None,
    )
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
            let tx_hash = tx.calculate_hash();
            
            // Add to mempool using public method
            match blockchain.add_transaction_to_mempool(tx).await {
                Ok(_) => {
                    println!("[INFO][TX] submitted tx={} from={} to={} amount={}", 
                             qnet_state::char_prefix(&tx_hash, 16),
                             qnet_state::char_prefix(&tx_request.from, 16),
                             qnet_state::char_prefix(&tx_request.to, 16),
                             tx_request.amount);
                    let response = json!({
                        "success": true,
                        "tx_hash": tx_hash,
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

    // v10.0 SECURITY: Verify cancel request comes from the original submitter IP
    let caller_ip = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
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

    let total_amount: u64 = request.transfers.iter().map(|t| t.amount).fold(0u64, |acc, a| acc.saturating_add(a));

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

    let batch_tx = qnet_state::Transaction::new(
        from_address.clone(),
        Some("batch_transfers".to_string()),
        total_amount,
        request.nonce,
        request.gas_price,
        request.gas_limit,
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
        None, // no Ed25519 on QNet
        qnet_state::TransactionType::BatchTransfers {
            transfers: request.transfers.iter().map(|t| BatchTransferData {
                to_address: t.to_address.clone(),
                amount: t.amount,
                memo: t.memo.clone(),
            }).collect(),
            batch_id: request.batch_id.clone()
        },
        None,
    )
    .with_quantum_signature(
        hex::decode(&request.dilithium_signature).ok(),
        dil_pk.as_deref().and_then(|p| hex::decode(p).ok()),
    );
    
    // Submit batch transaction to blockchain
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
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // FIX M13: Rate limit node discovery
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    let peers = blockchain.get_connected_peers().await.unwrap_or_default();
    
    // FIX R20-M2: Mask peer IPs for external callers to prevent network topology mapping
    let caller_ip = remote_addr
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
                "cost_qnc": (eco_price as f64 * qnet_state::transaction::gas_limits::TRANSFER as f64) / 1_000_000_000.0 // nanoQNC → QNC
            },
            "standard": {
                "gas_price": standard_price,
                "estimated_time": standard_time,
                "cost_qnc": (standard_price as f64 * qnet_state::transaction::gas_limits::TRANSFER as f64) / 1_000_000_000.0
            },
            "fast": {
                "gas_price": fast_price,
                "estimated_time": fast_time,
                "cost_qnc": (fast_price as f64 * qnet_state::transaction::gas_limits::TRANSFER as f64) / 1_000_000_000.0
            },
            "priority": {
                "gas_price": priority_price,
                "estimated_time": priority_time,
                "cost_qnc": (priority_price as f64 * qnet_state::transaction::gas_limits::TRANSFER as f64) / 1_000_000_000.0
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

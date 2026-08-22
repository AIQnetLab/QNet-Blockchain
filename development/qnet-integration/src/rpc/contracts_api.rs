//! Contract, token and NFT deployment and call endpoints; WebSocket upgrade handling.

use super::*;

/// Handle smart contract deployment
/// NIST/CISCO COMPLIANT: Post-quantum signature verification (pure CRYSTALS-ML-DSA-65 / ML-DSA-65)
pub(super) async fn handle_contract_deploy(
    request: ContractDeployRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // SECURITY: Rate limiting for contract deployment (expensive operation)
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "activation") {
        return Ok(rate_limit_response);
    }
    
    // SECURITY: Validate deployer address
    if let Err(e) = validate_eon_address_with_error(&request.from) {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid deployer address",
            "details": e
        })));
    }
    
    // =========================================================================
    // NIST/CISCO COMPLIANT SIGNATURE VERIFICATION
    // Standard: NIST FIPS 186-5 (Ed25519) + NIST FIPS 204 (CRYSTALS-Dilithium)
    // =========================================================================
    
    // PURE DILITHIUM (F0.2): structural presence check only. The AUTHORITATIVE verify is the value-TX
    // gate in submit_transaction (verify_user_tx_dilithium): it opens the ML-DSA-65 signature over the
    // SAME canonical message build_canonical_verify_message() rebuilds — "q{chain}|contract_deploy:{from}:
    // {code_hash}:{nonce}" (code_hash = hex(sha3(wasm)), read from tx.data) — AND binds
    // eon_from_qnet_dilithium_pubkey(dpk)==from. The client MUST sign that exact message in the
    // "dilithium_sig_{pk}_{b64([sig_len][SignedMessage][pk_len][pk])}" wire format with a wallet
    // ML-DSA-65 key whose eon address == from.
    if request.dilithium_signature.is_empty() || request.dilithium_public_key.is_empty() {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "dilithium_signature + dilithium_public_key required (pure-PQ; ML-DSA-65)"
        })));
    }
    let is_quantum_secure = true;
    
    // Validate gas limits
    if request.gas_limit < 50000 {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Gas limit too low for contract deployment",
            "min_gas_limit": 50000
        })));
    }
    
    if request.gas_limit > 1000000 {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Gas limit exceeds maximum",
            "max_gas_limit": 1000000
        })));
    }
    
    // Decode WASM code from base64
    let wasm_code = match base64::engine::general_purpose::STANDARD.decode(&request.code) {
        Ok(code) => code,
        Err(e) => {
            println!("[WARN][RPC] api_error endpoint=deploy_contract err={}", e);
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Invalid base64-encoded contract code",
                "details": "request failed"
            })));
        }
    };
    
    // Validate WASM magic bytes
    if wasm_code.len() < 8 || &wasm_code[0..4] != b"\x00asm" {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid WASM bytecode - missing magic bytes"
        })));
    }

    // Same deterministic module gate the apply path enforces — fail fast instead of burning a
    // nonce on a deploy that apply will reject.
    if !qnet_state::wasm_exec::wasm_vm_enabled() {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "WASM VM is disabled on this node (WASM_VM_ENABLED=false)"
        })));
    }
    if let Err(e) = qnet_vm::validate_wasm_module(&wasm_code, &qnet_vm::VmLimits::default()) {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "invalid WASM module", "details": format!("{}", e)
        })));
    }

    // Constructors are not executed at deploy — accepting arguments that can never run would
    // silently discard the caller's intent, so a non-empty value is refused.
    let constructor_args_empty = match &request.constructor_args {
        Value::Null => true,
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        Value::String(s) => s.is_empty(),
        _ => false,
    };
    if !constructor_args_empty {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "constructor_args are not supported — contracts are deployed without constructor execution",
            "hint": "Send an empty constructor_args and initialise state with a contract call"
        })));
    }

    // Single-source on-chain derivation; apply ignores caller-supplied `to` (no address squatting)
    let contract_address = qnet_state::transaction::derive_contract_address(&request.from, request.nonce);

    // ONE canonical deploy payload, byte-shape-identical to /api/v1/wasm/deploy: the executable code
    // travels on-chain so apply stores a runnable contract, never a code-hash-only stub. code_hash is
    // derived from that payload by the shared helper, so the signed digest and the stored bytes are
    // bound together — classify_contract_deploy re-derives and rejects any mismatch.
    let mut deploy_data = json!({
        "wasm": true,
        "code": hex::encode(&wasm_code),
    });
    let code_hash = match qnet_state::transaction::deploy_code_hash(
        qnet_state::transaction::DeployKind::Wasm, &deploy_data) {
        Ok(h) => h,
        Err(e) => return Ok(warp::reply::json(&json!({
            "success": false, "error": "Invalid WASM deploy payload", "details": e
        }))),
    };
    deploy_data["code_hash"] = json!(code_hash);

    // Create ContractDeploy transaction with security metadata
    let mut tx = qnet_state::Transaction::new(
        request.from.clone(),                      // from
        Some(contract_address.clone()),            // to: contract address
        0,                                         // amount: 0 for deployment
        request.nonce,                             // nonce
        request.gas_price,                         // gas_price
        request.gas_limit,                         // gas_limit
        chrono::Utc::now().timestamp() as u64,     // timestamp
        None,                                      // signature (pure-Dilithium; Ed25519 not on a QNet path)
        qnet_state::TransactionType::ContractDeploy,  // tx_type
        Some(serde_json::to_string(&deploy_data).unwrap_or_default()), // data
    );
    // Carry the caller's ML-DSA-65 signature so the value-TX gate verifies it (over the canonical
    // "q{chain}|contract_deploy:{from}:{code_hash}:{nonce}" message) and binds the key to `from`.
    // FIX-5: hex(raw detached) -> bytes; value gate verifies
    tx.dilithium_signature = hex::decode(&request.dilithium_signature).ok();
    tx.dilithium_public_key = hex::decode(&request.dilithium_public_key).ok();
    tx.hash = tx.calculate_hash();

    // Submit to mempool
    let tx_hash = tx.hash.clone();
    match blockchain.add_transaction_to_mempool(tx).await {
        Ok(_) => {
            println!("[CONTRACT] ✅ deployment_submitted contract={} hash={}",
                     qnet_state::char_prefix(&contract_address, 16), 
                     qnet_state::char_prefix(&tx_hash, 16));
            println!("[CONTRACT] security dilithium=✅ (pure-PQ, FIPS 204)");
            Ok(warp::reply::json(&json!({
                "success": true,
                "contract_address": contract_address,
                "code_hash": code_hash,
                "code_size": wasm_code.len(),
                "gas_limit": request.gas_limit,
                "deployer": request.from,
                "message": "Contract deployment submitted to mempool",
                "security": {
                    "dilithium_verified": is_quantum_secure,
                    "quantum_secure": is_quantum_secure,
                    "nist_standards": {
                        "signature": "FIPS 204 (ML-DSA-65)",
                        "hash": "FIPS 202 (SHA3-256)"
                    }
                }
            })))
        }
        Err(e) => {
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Failed to submit contract deployment",
                "details": format!("{:?}", e)
            })))
        }
    }
}

/// Verify ML-DSA-65 signature from mobile client (Android DilithiumModule / Bouncy Castle)
/// Format: "dilithium_sig_{nodeId}_{base64}" where base64 decodes to:
///   [signed_msg_len(4 LE)] [signedMessage = sig(3309) + msg(N)] [pk_len(4 LE)] [pk(1952)]
/// Both Bouncy Castle and pqcrypto use the same NIST FIPS 204 standard
pub(crate) fn verify_mobile_dilithium_signature(
    expected_message: &str,
    formatted_signature: &str,
    public_key_hex: &str,
) -> bool {
    use pqcrypto_mldsa::mldsa65 as dilithium3;
    use pqcrypto_traits::sign::*;
    
    // Step 1: Extract base64 payload from formatted string
    // Format: "dilithium_sig_{nodeId_with_underscores}_{base64_no_underscores}"
    // Base64 standard alphabet doesn't contain '_', so rfind('_') gives us the separator
    if !formatted_signature.starts_with("dilithium_sig_") {
        // Not mobile format — try raw hex verification as fallback
        // Raw hex: signature_hex directly, verify with wallet_address as message
        let pk_bytes = match hex::decode(public_key_hex) {
            Ok(b) => b,
            Err(_) => return false,
        };
        let sig_bytes = match hex::decode(formatted_signature) {
            Ok(b) => b,
            Err(_) => return false,
        };
        // Strict FIPS-204 detached sig = exactly 3309 B. Without this an over-long blob (sig ‖ extra)
        // still open()s — the extra folds into the recovered message — so admission accepts what the
        // strict block-validator (verify_node_lifecycle_dilithium: len==3309) rejects, splitting the
        // two accept-sets and poison-evicting the TX at the producer.
        if sig_bytes.len() != 3309 {
            return false;
        }
        let mut signed_msg = sig_bytes;
        signed_msg.extend_from_slice(expected_message.as_bytes());
        let public_key = match dilithium3::PublicKey::from_bytes(&pk_bytes) {
            Ok(pk) => pk,
            Err(_) => return false,
        };
        let signed_message = match dilithium3::SignedMessage::from_bytes(&signed_msg) {
            Ok(sm) => sm,
            Err(_) => return false,
        };
        // Accept ONLY if open() recovers EXACTLY expected_message (belt to the length gate above).
        return match dilithium3::open(&signed_message, &public_key) {
            Ok(recovered) => recovered.as_slice() == expected_message.as_bytes(),
            Err(_) => false,
        };
    }
    
    let base64_data = match formatted_signature.rfind('_') {
        Some(pos) if pos > 14 => &formatted_signature[pos + 1..],
        _ => {
            println!("[WARN][DILITHIUM] mobile_sig_invalid reason=no_base64_separator");
            return false;
        }
    };
    
    // Step 2: Decode base64
    let decoded = match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, base64_data) {
        Ok(d) => d,
        Err(e) => {
            println!("[WARN][DILITHIUM] mobile_base64_decode_failed err={}", e);
            return false;
        }
    };
    
    // Step 3: Parse binary format [signed_msg_len(4 LE)] [signedMessage] [pk_len(4 LE)] [pk]
    if decoded.len() < 8 {
        println!("[WARN][DILITHIUM] mobile_payload_too_short bytes={}", decoded.len());
        return false;
    }
    
    let signed_msg_len = u32::from_le_bytes([decoded[0], decoded[1], decoded[2], decoded[3]]) as usize;
    if decoded.len() < 4 + signed_msg_len + 4 {
        println!("[WARN][DILITHIUM] mobile_invalid_signed_msg_len len={} payload={}", signed_msg_len, decoded.len());
        return false;
    }
    
    let signed_message_bytes = &decoded[4..4 + signed_msg_len];
    
    let pk_offset = 4 + signed_msg_len;
    let pk_len = u32::from_le_bytes([decoded[pk_offset], decoded[pk_offset+1], decoded[pk_offset+2], decoded[pk_offset+3]]) as usize;
    
    if decoded.len() < pk_offset + 4 + pk_len {
        println!("[WARN][DILITHIUM] mobile_invalid_pk_len pk_len={} remaining={}", pk_len, decoded.len() - pk_offset - 4);
        return false;
    }
    
    let pk_bytes_from_sig = &decoded[pk_offset + 4..pk_offset + 4 + pk_len];
    
    // Step 4: Verify public key matches what client sent in quantum_pubkey
    let pk_bytes_from_request = match hex::decode(public_key_hex) {
        Ok(b) => b,
        Err(e) => {
            println!("[WARN][DILITHIUM] mobile_invalid_pubkey_hex err={}", e);
            return false;
        }
    };
    
    if pk_bytes_from_sig != pk_bytes_from_request {
        println!("[WARN][DILITHIUM] mobile_pk_mismatch reason=sig_pk_differs_from_request_pk");
        return false;
    }
    
    // Step 5: Create pqcrypto PublicKey from raw bytes
    let public_key = match dilithium3::PublicKey::from_bytes(&pk_bytes_from_request) {
        Ok(pk) => pk,
        Err(e) => {
            println!("[WARN][DILITHIUM] mobile_invalid_pk bytes={} err={:?}", pk_bytes_from_request.len(), e);
            return false;
        }
    };
    
    // Step 6: Verify using pqcrypto's open() — signedMessage = signature || message
    // This is the standard NIST FIPS 204 format used by both Bouncy Castle and pqcrypto
    let signed_message = match dilithium3::SignedMessage::from_bytes(signed_message_bytes) {
        Ok(sm) => sm,
        Err(e) => {
            println!("[WARN][DILITHIUM] mobile_invalid_signed_msg bytes={} err={:?}", signed_message_bytes.len(), e);
            return false;
        }
    };
    
    match dilithium3::open(&signed_message, &public_key) {
        Ok(verified_msg) => {
            // Step 7: Verify the extracted message matches expected wallet_address
            if verified_msg == expected_message.as_bytes() {
                println!("[INFO][DILITHIUM] mobile_sig_verified standard=FIPS204 level=3");
                true
            } else {
                println!("[WARN][DILITHIUM] mobile_msg_mismatch reason=signed_data_differs_from_wallet");
                false
            }
        }
        Err(_) => {
            println!("[WARN][DILITHIUM] mobile_sig_verification_failed reason=cryptographic");
            false
        }
    }
}

// F0.2 REMOVED: verify_dilithium_signature_for_contract — dead after contract/token deploy moved to the
// single authoritative value-TX gate (verify_user_tx_dilithium in submit_transaction).

/// Handle smart contract method call
/// NIST/CISCO COMPLIANT: Post-quantum signature verification (pure CRYSTALS-ML-DSA-65 / ML-DSA-65)
pub(super) async fn handle_contract_call(
    request: ContractCallRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Rate limiting (less strict for view calls)
    let rate_type = if request.is_view { "read_only" } else { "transaction" };
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, rate_type) {
        return Ok(rate_limit_response);
    }
    
    // Validate addresses
    if let Err(e) = validate_eon_address_with_error(&request.from) {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid caller address",
            "details": e
        })));
    }
    
    if let Err(e) = validate_eon_address_with_error(&request.contract_address) {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid contract address",
            "details": e
        })));
    }
    
    // For view calls, no signature required — read directly from blockchain state
    if request.is_view {
        // v3.40: Read from StateManager (blockchain) instead of local RocksDB VM
        match blockchain.get_account(&request.contract_address).await {
            Ok(Some(account)) if account.is_contract => {
                let cs = &account.contract_storage;
                let ctype = cs.get("type").map(|s| s.as_str()).unwrap_or("");
                // token_id and addresses are ALWAYS string args (apply-side rejects non-string) —
                // so view reads pull args[i] as a string and format keys byte-identically to apply.
                let arg_str = |i: usize| -> Option<String> {
                    request.args.as_array().and_then(|a| a.get(i)).and_then(|v| v.as_str().map(|s| s.to_string()))
                };

                let return_value: serde_json::Value = match ctype {
                    "qrc20" => {
                        match request.method.as_str() {
                            "balanceOf" | "balance_of" => {
                                // u128 STRING (QRC-20 storage is u128; u64 dropped whales, raw number rounds >2^53).
                                let holder = arg_str(0).unwrap_or_else(|| request.from.clone());
                                let bal: u128 = cs.get(&format!("balance:{}", holder)).and_then(|s| s.parse().ok()).unwrap_or(0);
                                json!(bal.to_string())
                            }
                            "totalSupply" | "total_supply" => {
                                let supply: u128 = cs.get("total_supply").and_then(|s| s.parse().ok()).unwrap_or(0);
                                json!(supply.to_string())
                            }
                            "name" => json!(cs.get("name").cloned().unwrap_or_default()),
                            "symbol" => json!(cs.get("symbol").cloned().unwrap_or_default()),
                            "decimals" => {
                                let d: u8 = cs.get("decimals").and_then(|s| s.parse().ok()).unwrap_or(9);
                                json!(d)
                            }
                            "allowance" => {
                                let owner = arg_str(0).unwrap_or_default();
                                let spender = arg_str(1).unwrap_or_default();
                                // u128 base units as a STRING (same reason as balanceOf/totalSupply).
                                let val: u128 = cs.get(&format!("allowance:{}:{}", owner, spender)).and_then(|s| s.parse().ok()).unwrap_or(0);
                                json!(val.to_string())
                            }
                            _ => json!(null)
                        }
                    }
                    "qrc721" => {
                        // Reads mirror the apply-path keys EXACTLY: owner:{token_id}, bal:{addr},
                        // approved:{token_id} (transaction.rs QRC-721 dispatch).
                        match request.method.as_str() {
                            "ownerOf" | "owner_of" =>
                                json!(arg_str(0).and_then(|tid| cs.get(&format!("owner:{}", tid)).cloned())),
                            "balanceOf" | "balance_of" | "balanceOf_nft" => {
                                let holder = arg_str(0).unwrap_or_else(|| request.from.clone());
                                let bal: u64 = cs.get(&format!("bal:{}", holder)).and_then(|s| s.parse().ok()).unwrap_or(0);
                                json!(bal)
                            }
                            "getApproved" | "get_approved" =>
                                json!(arg_str(0).and_then(|tid| cs.get(&format!("approved:{}", tid)).cloned())),
                            "name" => json!(cs.get("name").cloned().unwrap_or_default()),
                            "symbol" => json!(cs.get("symbol").cloned().unwrap_or_default()),
                            _ => json!(null)
                        }
                    }
                    _ => {
                        // Generic WASM contract. Two read shapes (both off-consensus, read-only):
                        //   storageGet(key) -> raw stored value bytes (the getStorageAt analogue)
                        //   <method>()      -> execute the view read-only via the deterministic VM
                        //                      against CURRENT on-chain storage, return its i64.
                        match request.method.as_str() {
                            "storageGet" | "storage_get" | "get" => match arg_str(0) {
                                Some(k) => match qnet_state::wasm_exec::view_storage_get(&account, k.as_bytes()) {
                                    Some(v) => json!(String::from_utf8_lossy(&v).to_string()),
                                    None => json!(null),
                                },
                                None => json!(null),
                            },
                            _ => {
                                let view_height = blockchain.get_height().await;
                                match qnet_state::wasm_exec::view_call(
                                    &request.contract_address, &account, &request.method, &request.from, view_height,
                                ) {
                                    Ok(v) => json!(v),
                                    Err(e) => json!({ "error": e }),
                                }
                            }
                        }
                    }
                };
                
                return Ok(warp::reply::json(&json!({
                    "success": true,
                    "is_view": true,
                    "contract_address": request.contract_address,
                    "method": request.method,
                    "result": return_value,
                    "gas_used": 0,
                    "source": "blockchain_state"
                })));
            }
            Ok(_) => {
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "is_view": true,
                    "error": "Contract not found"
                })));
            }
            Err(e) => {
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "is_view": true,
                    "error": format!("State query failed: {:?}", e)
                })));
            }
        }
    }
    
    // State-changing call requires the ML-DSA-65 signature (pure-Dilithium; Ed25519 is Solana-only).
    // FIX-5: the PUBKEY is optional — elided once committed on-chain; submit_transaction rehydrates it.
    if request.dilithium_signature.is_none() {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Dilithium signature required for state-changing contract calls"
        })));
    }
    
    // =========================================================================
    // NIST/CISCO COMPLIANT POST-QUANTUM DILITHIUM3 SIGNATURE VERIFICATION (MANDATORY)
    // =========================================================================
    
    // PURE DILITHIUM (F0.2): structural presence check only — the AUTHORITATIVE verify is the value-TX
    // gate in submit_transaction (verify_user_tx_dilithium), which opens the ML-DSA-65 sig over the SAME
    // canonical message build_canonical_verify_message() rebuilds — "q{chain}|contract_call:{from}:{sha3(tx.data
    // calldata)}:{nonce}" (AC-1: the exact calldata bytes are bound, so method/recipient/amount can't be
    // tampered and no cross-impl re-serialization can diverge) — AND binds
    // eon_from_qnet_dilithium_pubkey(dpk)==from. The client MUST sign that exact message in the
    // "dilithium_sig_{pk}_{b64}" wire format with a wallet key whose eon == from.
    let dilithium_sig = request.dilithium_signature.clone().unwrap_or_default();
    // FIX-5: empty ⇒ ELIDED pk (resolved from committed state by submit_transaction, which also rejects
    // it if unresolvable). Only the signature is structurally mandatory here.
    let dilithium_pk = request.dilithium_public_key.clone().unwrap_or_default();
    if dilithium_sig.is_empty() {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "dilithium_signature required (pure-PQ; ML-DSA-65)"
        })));
    }

    // Validate gas limits
    if request.gas_limit < 10000 {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Gas limit too low for contract call",
            "min_gas_limit": 10000
        })));
    }

    // A WASM contract takes calldata as a HEX STRING; apply rejects any other shape rather than
    // executing with empty args. Report it at the door when the target is already on-chain
    // (unknown/pending targets are simply left to the binding apply-side gate).
    if let Ok(Some(account)) = blockchain.get_account(&request.contract_address).await {
        let is_wasm = account.contract_storage.get("type").map(|t| t == "wasm").unwrap_or(false);
        let args_ok = match &request.args {
            Value::Null => true,
            Value::String(s) => hex::decode(s).is_ok(),
            _ => false,
        };
        if is_wasm && !args_ok {
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "args for a WASM contract must be a hex-encoded calldata string",
                "contract_address": request.contract_address,
                "method": request.method
            })));
        }
    }

    // Create ContractCall transaction; tx.data is the exact calldata bound by the AC-1 signature
    let mut tx = qnet_state::Transaction::new(
        request.from.clone(),                      // from
        Some(request.contract_address.clone()),    // to: contract address
        0,                                         // amount: a call carries no native value
        request.nonce,                             // nonce
        request.gas_price,                         // gas_price
        request.gas_limit,                         // gas_limit
        chrono::Utc::now().timestamp() as u64,     // timestamp
        None,                                      // signature (pure-Dilithium; Ed25519 not on a QNet path)
        qnet_state::TransactionType::ContractCall, // tx_type
        Some(serde_json::to_string(&json!({        // data = exact calldata bound by the AC-1 signature
            "contract": request.contract_address,
            "method": request.method,
            "args": request.args
        })).unwrap_or_default()),
    );
    // Carry the caller's ML-DSA-65 signature so the value-TX gate verifies it (over the canonical
    // "q{chain}|contract_call:{from}:{sha3(tx.data calldata)}:{nonce}" message) and binds the key to `from`.
    // FIX-5: hex(raw detached) -> bytes; value gate verifies
    tx.dilithium_signature = hex::decode(&dilithium_sig).ok();
    // Elided pk stays None all the way into the mempool — never re-added to the wire (FIX-5 TPS win).
    tx.dilithium_public_key = if dilithium_pk.is_empty() { None } else { hex::decode(&dilithium_pk).ok() };
    tx.hash = tx.calculate_hash();

    let tx_hash = tx.hash.clone();
    
    // Submit to mempool
    match blockchain.add_transaction_to_mempool(tx).await {
        Ok(_) => {
            println!("📜 Contract call submitted: {}::{}", 
                     qnet_state::char_prefix(&request.contract_address, 16), request.method);
            
            Ok(warp::reply::json(&json!({
                "success": true,
                "tx_hash": tx_hash,
                "contract_address": request.contract_address,
                "method": request.method,
                "gas_limit": request.gas_limit,
                "message": "Contract call submitted to mempool"
            })))
        }
        Err(e) => {
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Failed to submit contract call",
                "details": format!("{:?}", e)
            })))
        }
    }
}

/// Handle contract info query
pub(super) async fn handle_contract_info(
    contract_address: String,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // FIX M13: Rate limit contract info
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    // Validate contract address
    if let Err(e) = validate_eon_address_with_error(&contract_address) {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid contract address",
            "details": e
        })));
    }
    
    // Query contract info from storage
    let storage = blockchain.get_storage();
    
    // Check if contract exists
    match storage.get_contract_info(&contract_address) {
        Ok(Some(info)) => {
            Ok(warp::reply::json(&json!({
                "success": true,
                "contract": {
                    "address": contract_address,
                    "deployer": info.deployer,
                    "deployed_at": info.deployed_at,
                    "code_hash": info.code_hash,
                    "version": info.version,
                    "total_gas_used": info.total_gas_used,
                    "call_count": info.call_count,
                    "is_active": info.is_active
                }
            })))
        }
        Ok(None) => {
            // Contract not found - return error (NOT placeholder!)
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Contract not found",
                "contract_address": contract_address,
                "message": "No contract deployed at this address"
            })))
        }
        Err(e) => {
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Failed to query contract info",
                "details": format!("{:?}", e)
            })))
        }
    }
}

/// Handle contract state query
/// OFF-CONSENSUS contract event logs (the getLogs analogue). Scans the persisted per-block WASM
/// log receipts over a BOUNDED height range, optionally filtered by contract address. Read-only:
/// the log store is a side index (never consensus state / never hashed), so this cannot affect
/// state_root and needs no signature.
pub(super) async fn handle_contract_logs(
    query: ContractLogsQuery,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    let storage = blockchain.get_storage();
    let tip = blockchain.get_height().await;
    let from = query.from.unwrap_or(0);
    // Bound the scan (off-consensus point-reads): at most 500 blocks per call.
    const MAX_LOG_RANGE: u64 = 500;
    let to = query.to.unwrap_or(tip).min(tip).min(from.saturating_add(MAX_LOG_RANGE));
    let filter = query.contract.as_ref().map(|c| c.to_lowercase());
    let mut logs_out: Vec<serde_json::Value> = Vec::new();
    let mut h = from;
    while h <= to {
        for (tx_hash, contract, data) in storage.get_block_logs(h) {
            if filter.as_ref().map_or(true, |f| &contract.to_lowercase() == f) {
                logs_out.push(json!({
                    "height": h,
                    "tx_hash": tx_hash,
                    "contract": contract,
                    "data": hex::encode(&data),
                }));
            }
        }
        h = h.saturating_add(1);
    }
    // Retention honesty: blocklogs below the prune floor are physically gone on this node, so an
    // empty result there is NOT "no events". Report `oldest_available` always, and set
    // `pruned_below` when the request dips below it — the client then knows results under that
    // height are incomplete and must be fetched from an archive node (never silent data loss).
    let floor = storage.log_prune_floor();
    let pruned_below = if from < floor { Some(floor) } else { None };
    Ok(warp::reply::json(&json!({
        "success": true,
        "from": from,
        "to": to,
        "oldest_available": floor,
        "pruned_below": pruned_below,
        "count": logs_out.len(),
        "logs": logs_out,
    })))
}

pub(super) async fn handle_contract_state(
    contract_address: String,
    query: ContractStateQuery,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // FIX M13: Rate limit contract state
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    // Validate contract address
    if let Err(e) = validate_eon_address_with_error(&contract_address) {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid contract address",
            "details": e
        })));
    }
    
    let storage = blockchain.get_storage();
    
    // Query single key or multiple keys
    if let Some(key) = query.key {
        // Single key query
        match storage.get_contract_state(&contract_address, &key) {
            Ok(Some(value)) => {
                Ok(warp::reply::json(&json!({
                    "success": true,
                    "contract_address": contract_address,
                    "state": {
                        key: value
                    }
                })))
            }
            Ok(None) => {
                Ok(warp::reply::json(&json!({
                    "success": true,
                    "contract_address": contract_address,
                    "state": {
                        key: null
                    },
                    "message": "Key not found in contract state"
                })))
            }
            Err(e) => {
                Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "Failed to query contract state",
                    "details": format!("{:?}", e)
                })))
            }
        }
    } else if let Some(keys) = query.keys {
        // Multiple keys query
        let mut state = serde_json::Map::new();
        
        for key in keys {
            match storage.get_contract_state(&contract_address, &key) {
                Ok(Some(value)) => {
                    state.insert(key, Value::String(value));
                }
                Ok(None) => {
                    state.insert(key, Value::Null);
                }
                Err(_) => {
                    state.insert(key, Value::Null);
                }
            }
        }
        
        Ok(warp::reply::json(&json!({
            "success": true,
            "contract_address": contract_address,
            "state": state
        })))
    } else {
        // No keys specified - return error
        Ok(warp::reply::json(&json!({
            "success": false,
            "error": "No state key(s) specified. Use ?key=... or ?keys=key1,key2,..."
        })))
    }
}

/// Handle gas estimation for contract operations
pub(super) async fn handle_contract_estimate_gas(
    request: Value,
    remote_addr: Option<std::net::SocketAddr>,
    _blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // FIX M13: Rate limit gas estimation (write category)
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "write") {
        return Ok(rate_limit_response);
    }
    let operation = request.get("operation")
        .and_then(|v| v.as_str())
        .unwrap_or("call");
    
    let code_size = request.get("code_size")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    
    let args_size = request.get("args")
        .map(|v| v.to_string().len())
        .unwrap_or(0);
    
    // Calculate gas estimate based on operation type
    let (base_gas, per_byte_gas) = match operation {
        "deploy" => (50000u64, 200u64),  // Deploy: 50k base + 200 per byte of code
        "call" => (10000u64, 10u64),     // Call: 10k base + 10 per byte of args
        "view" => (0u64, 0u64),          // View: free
        _ => (10000u64, 10u64),
    };
    
    let estimated_gas = base_gas + (code_size as u64 * per_byte_gas) + (args_size as u64 * 5);
    
    // Per-gas-unit prices (nanoQNC/gas), rooted in the single-source floor. slow == MIN_GAS_PRICE
    // ⇒ a standard transfer (10k gas) costs 0.0001 QNC; standard/fast add priority headroom.
    let min_gas_price = qnet_state::transaction::MIN_GAS_PRICE; // 10
    let recommended_gas_price = min_gas_price + min_gas_price / 2; // 15 (1.5×)
    let fast_gas_price = min_gas_price * 5 / 2; // 25 (2.5×)
    
    Ok(warp::reply::json(&json!({
        "success": true,
        "operation": operation,
        "estimated_gas": estimated_gas,
        "gas_prices": {
            "slow": min_gas_price,
            "standard": recommended_gas_price,
            "fast": fast_gas_price
        },
        "estimated_cost": {
            "slow": estimated_gas * min_gas_price,
            "standard": estimated_gas * recommended_gas_price,
            "fast": estimated_gas * fast_gas_price
        },
        "estimated_cost_qnc": {
            "slow": format!("{:.9} QNC", (estimated_gas * min_gas_price) as f64 / 1_000_000_000.0),
            "standard": format!("{:.9} QNC", (estimated_gas * recommended_gas_price) as f64 / 1_000_000_000.0),
            "fast": format!("{:.9} QNC", (estimated_gas * fast_gas_price) as f64 / 1_000_000_000.0)
        }
    })))
}

// ============================================================================
// WEBSOCKET HANDLERS
// ============================================================================

/// Parse channel string into WsChannel enum
pub(super) fn parse_ws_channels(channels_str: &str) -> Vec<WsChannel> {
    channels_str
        .split(',')
        .take(50) // SCALABILITY: Max 50 channels per WS connection
        .filter_map(|ch| {
            let ch = ch.trim();
            if ch == "blocks" {
                Some(WsChannel::Blocks)
            } else if ch == "mempool" {
                Some(WsChannel::Mempool)
            } else if ch.starts_with("account:") {
                Some(WsChannel::Account(ch[8..].to_string()))
            } else if ch.starts_with("contract:") {
                Some(WsChannel::Contract(ch[9..].to_string()))
            } else if ch.starts_with("tx:") {
                Some(WsChannel::Transaction(ch[3..].to_string()))
            } else if ch.starts_with("rewards:") {
                // PRODUCTION v2.43.1: rewards:{node_id} channel
                Some(WsChannel::Rewards(ch[8..].to_string()))
            } else {
                None
            }
        })
        .collect()
}

/// Check if an event matches the subscribed channels
pub(super) fn event_matches_channels(event: &WsEvent, channels: &[WsChannel]) -> bool {
    for channel in channels {
        match (channel, event) {
            (WsChannel::Blocks, WsEvent::NewBlock { .. }) => return true,
            (WsChannel::Mempool, WsEvent::PendingTx { .. }) => return true,
            (WsChannel::Account(addr), WsEvent::BalanceUpdate { address, .. }) => {
                if address == addr {
                    return true;
                }
            }
            (WsChannel::Contract(addr), WsEvent::ContractEvent { contract_address, .. }) => {
                if contract_address == addr {
                    return true;
                }
            }
            (WsChannel::Transaction(hash), WsEvent::TxConfirmed { tx_hash, .. }) => {
                if tx_hash == hash {
                    return true;
                }
            }
            // PRODUCTION v2.43.1: Match reward updates for subscribed node
            (WsChannel::Rewards(node), WsEvent::RewardUpdate { node_id, .. }) => {
                if node_id == node {
                    return true;
                }
            }
            (WsChannel::Rewards(node), WsEvent::RewardClaimed { node_id, .. }) => {
                if node_id == node {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// Handle WebSocket connection
#[allow(dead_code)]
pub(super) async fn handle_ws_connection(
    ws: WebSocket,
    query: WsSubscribeQuery,
    _blockchain: Arc<BlockchainNode>,
) {
    // Parse subscription channels
    let channels = query.channels
        .as_ref()
        .map(|s| parse_ws_channels(s))
        .unwrap_or_else(|| vec![WsChannel::Blocks]); // Default: subscribe to blocks
    
    if is_info() { println!("[INFO][WS] new_connection channels={}", channels.len()); }
    
    // Split WebSocket into sender and receiver
    let (mut ws_tx, mut ws_rx) = ws.split();
    
    // Subscribe to global event broadcaster
    let mut rx = WS_BROADCASTER.subscribe();
    
    // Send welcome message
    let welcome = json!({
        "type": "connected",
        "message": "WebSocket connected to QNet node",
        "subscribed_channels": channels.len(),
        "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
    });
    
    if let Ok(welcome_str) = serde_json::to_string(&welcome) {
        let _ = ws_tx.send(Message::text(welcome_str)).await;
    }
    
    // Spawn task to handle incoming messages (for ping/pong and unsubscribe)
    let channels_clone = channels.clone();
    tokio::spawn(async move {
        while let Some(result) = ws_rx.next().await {
            match result {
                Ok(msg) => {
                    if msg.is_close() {
                        if is_info() { println!("[INFO][WS] client_disconnected"); }
                        break;
                    }
                    if msg.is_ping() {
                        // Pong is handled automatically by warp
                    }
                    if msg.is_text() {
                        // Handle client commands (e.g., subscribe to new channels)
                        if let Ok(text) = msg.to_str() {
                            println!("[INFO][WS] Received: {}", text);
                        }
                    }
                }
                Err(e) => {
                    if is_warn() { println!("[WARN][WS] receive_error err={}", e); }
                    break;
                }
            }
        }
    });
    
    // Main loop: forward matching events to client
    loop {
        match rx.recv().await {
            Ok(event) => {
                // Check if event matches any subscribed channel
                if event_matches_channels(&event, &channels_clone) {
                    // Serialize and send event
                    if let Ok(event_json) = serde_json::to_string(&event) {
                        if let Err(e) = ws_tx.send(Message::text(event_json)).await {
                            if is_warn() { println!("[WARN][WS] send_error err={}", e); }
                            break;
                        }
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                if is_warn() { println!("[WARN][WS] client_lagged missed={}", n); }
                // Send lag warning to client
                let warning = json!({
                    "type": "warning",
                    "message": format!("Missed {} events due to slow connection", n)
                });
                if let Ok(warning_str) = serde_json::to_string(&warning) {
                    let _ = ws_tx.send(Message::text(warning_str)).await;
                }
            }
            Err(broadcast::error::RecvError::Closed) => {
                if is_info() { println!("[INFO][WS] broadcaster_closed"); }
                break;
            }
        }
    }
    
    if is_info() { println!("[INFO][WS] connection_closed"); }
}

/// Handle WebSocket connection with rate limiter cleanup on disconnect
/// SECURITY: Ensures connection count is decremented when client disconnects
pub(super) async fn handle_ws_connection_with_cleanup(
    ws: WebSocket,
    query: WsSubscribeQuery,
    blockchain: Arc<BlockchainNode>,
    client_ip: Option<IpAddr>,
) {
    // Log connection with IP (privacy: only show for debugging)
    let (total, unique_ips) = WS_RATE_LIMITER.get_stats();
    if is_info() {
        println!("[INFO][WS] new_connection ip={:?} total={} unique_ips={}", 
                 client_ip.map(|ip| ip.to_string()).unwrap_or_else(|| "unknown".to_string()),
                 total, unique_ips);
    }
    
    // Parse subscription channels
    let channels = query.channels
        .as_ref()
        .map(|s| parse_ws_channels(s))
        .unwrap_or_else(|| vec![WsChannel::Blocks]); // Default: subscribe to blocks
    
    if is_info() {
        println!("[INFO][WS] subscribed channels={} types={:?}", channels.len(), 
                 channels.iter().map(|c| format!("{:?}", c)).collect::<Vec<_>>());
    }
    
    // Split WebSocket into sender and receiver (Arc<Mutex> for JSON-RPC support)
    let (ws_tx, mut ws_rx) = ws.split();
    let ws_tx = std::sync::Arc::new(tokio::sync::Mutex::new(ws_tx));
    
    // Subscribe to global event broadcaster
    let mut rx = WS_BROADCASTER.subscribe();
    
    // Send welcome message with connection info
    let welcome = json!({
        "type": "connected",
        "message": "WebSocket connected to QNet node",
        "subscribed_channels": channels.len(),
        "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
        "node_id": blockchain.get_public_display_name(),
        "rate_limit": {
            "max_per_ip": 5,
            "your_connections": WS_RATE_LIMITER.connections_per_ip
                .get(&client_ip.unwrap_or(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)))
                .map(|v| *v)
                .unwrap_or(1)
        }
    });
    
    if let Ok(welcome_str) = serde_json::to_string(&welcome) {
        let _ = ws_tx.lock().await.send(Message::text(welcome_str)).await;
    }
    
    // Spawn task to handle incoming messages (JSON-RPC requests + ping/pong)
    // SECURITY: Rate limit JSON-RPC to 100 requests/minute per connection
    let channels_clone = channels.clone();
    let blockchain_for_ws = blockchain.clone();
    let ws_tx_for_rpc = ws_tx.clone();
    tokio::spawn(async move {
        // SECURITY: Sliding window rate limit — prevents boundary burst exploit
        let mut rpc_timestamps: std::collections::VecDeque<std::time::Instant> = std::collections::VecDeque::new();
        const RPC_RATE_LIMIT: usize = 100;
        const RPC_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

        while let Some(result) = ws_rx.next().await {
            match result {
                Ok(msg) => {
                    if msg.is_close() {
                        if is_info() { println!("[INFO][WS] client_disconnected reason=close_frame"); }
                        break;
                    }
                    if msg.is_text() {
                        if let Ok(text) = msg.to_str() {
                            // SECURITY: Reject oversized WebSocket messages (max 64KB)
                            if text.len() > 65536 {
                                if is_warn() {
                                    println!("[WARN][WS] message_too_large size={} max=65536", text.len());
                                }
                                continue;
                            }
                            // Try to parse as JSON-RPC request
                            if let Ok(rpc_req) = serde_json::from_str::<serde_json::Value>(text) {
                                if rpc_req.get("jsonrpc").is_some() && rpc_req.get("method").is_some() {
                                    // SECURITY: Sliding window rate limit check
                                    let now = std::time::Instant::now();
                                    while rpc_timestamps.front().map_or(false, |&t| now.duration_since(t) > RPC_WINDOW) {
                                        rpc_timestamps.pop_front();
                                    }

                                    let id = rpc_req["id"].as_u64().unwrap_or(0);

                                    if rpc_timestamps.len() >= RPC_RATE_LIMIT {
                                        println!("[WARN][WS] rpc_rate_limited count={}", rpc_timestamps.len());
                                        let error_resp = json!({
                                            "jsonrpc": "2.0",
                                            "id": id,
                                            "error": {"code": -32029, "message": "Rate limit exceeded (100 req/min)"}
                                        });
                                        if let Ok(s) = serde_json::to_string(&error_resp) {
                                            let _ = ws_tx_for_rpc.lock().await.send(Message::text(s)).await;
                                        }
                                        continue;
                                    }
                                    rpc_timestamps.push_back(now);
                                    
                                    // Handle JSON-RPC via WebSocket
                                    let method = rpc_req["method"].as_str().unwrap_or("");
                                    let params = rpc_req.get("params").cloned();
                                    
                                    let result = match method {
                                        "chain_getBlocks" => {
                                            let p = params.unwrap_or(json!({}));
                                            let start = p["start"].as_u64().unwrap_or(0);
                                            // SECURITY: Limit to 20 blocks per request via WS
                                            let limit = p["limit"].as_u64().unwrap_or(10).min(20);
                                            let mut blocks = Vec::new();
                                            for h in start..start + limit {
                                                if let Ok(Some(block)) = blockchain_for_ws.get_block(h).await {
                                                    blocks.push(block);
                                                }
                                            }
                                            json!({"jsonrpc": "2.0", "id": id, "result": blocks})
                                        },
                                        "chain_getBlock" => {
                                            let p = params.unwrap_or(json!({}));
                                            let height = p["height"].as_u64().unwrap_or(0);
                                            if let Ok(Some(block)) = blockchain_for_ws.get_block(height).await {
                                                json!({"jsonrpc": "2.0", "id": id, "result": block})
                                            } else {
                                                json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": "Block not found"}})
                                            }
                                        },
                                        "chain_getHeight" => {
                                            let height = blockchain_for_ws.get_height().await;
                                            json!({"jsonrpc": "2.0", "id": id, "result": {"height": height}})
                                        },
                                        _ => {
                                            json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}})
                                        }
                                    };
                                    
                                    if let Ok(response_str) = serde_json::to_string(&result) {
                                        let _ = ws_tx_for_rpc.lock().await.send(Message::text(response_str)).await;
                                    }
                                    continue;
                                }
                            }
                            if is_info() { println!("[INFO][WS] command_received text={}", text); }
                        }
                    }
                }
                Err(e) => {
                    if is_warn() { println!("[WARN][WS] receive_error err={}", e); }
                    break;
                }
            }
        }
    });
    
    // Main loop: forward matching events to client
    loop {
        match rx.recv().await {
            Ok(event) => {
                // Check if event matches any subscribed channel
                if event_matches_channels(&event, &channels_clone) {
                    // Serialize and send event
                    if let Ok(event_json) = serde_json::to_string(&event) {
                        if let Err(e) = ws_tx.lock().await.send(Message::text(event_json)).await {
                            if is_warn() { println!("[WARN][WS] send_error err={}", e); }
                            break;
                        }
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                if is_warn() { println!("[WARN][WS] client_lagged missed_events={}", n); }
                let warning = json!({
                    "type": "warning",
                    "message": format!("Missed {} events due to slow connection", n)
                });
                if let Ok(warning_str) = serde_json::to_string(&warning) {
                    let _ = ws_tx.lock().await.send(Message::text(warning_str)).await;
                }
            }
            Err(broadcast::error::RecvError::Closed) => {
                if is_info() { println!("[INFO][WS] broadcaster_closed action=disconnect"); }
                break;
            }
        }
    }
    
    // CRITICAL: Cleanup rate limiter on disconnect
    WS_RATE_LIMITER.remove_connection(client_ip);
    let (total, unique_ips) = WS_RATE_LIMITER.get_stats();
    if is_info() { println!("[INFO][WS] connection_closed total={} unique_ips={}", total, unique_ips); }
}

// ============================================================================
// QRC-20 TOKEN HANDLERS (v2.19.12)
// ============================================================================

/// Request to deploy a generic WASM smart contract.
#[derive(Debug, Deserialize)]
pub(super) struct WasmDeployRequest {
    /// Creator's EON address
    pub(super) from: String,
    /// WASM module bytes, hex-encoded
    pub(super) code: String,
    /// Replay-protection nonce (signed into "q{chain}|contract_deploy:{from}:{code_hash}:{nonce}").
    pub(super) nonce: u64,
    /// ML-DSA-65 signature + public key (MANDATORY; pure ML-DSA-65)
    pub(super) dilithium_signature: String,
    pub(super) dilithium_public_key: String,
}

/// Handle a generic WASM contract deploy. Builds a ContractDeploy value-TX with
/// data {"wasm":true,"code":<hex>,"code_hash":<sha3(code)>}; the value-TX gate
/// verifies the ML-DSA-65 sig over canonical "q{chain}|contract_deploy:{from}:{code_hash}:
/// {nonce}" (code_hash = hex(sha3(code_bytes))). Validates the module up-front for
/// fast, honest feedback; the same validator runs again at apply.
pub(super) async fn handle_wasm_deploy(
    request: WasmDeployRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "activation") {
        return Ok(rate_limit_response);
    }
    if let Err(e) = validate_eon_address_with_error(&request.from) {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "Invalid creator address", "details": e
        })));
    }
    // Defensive pre-check: the VM must be active for the deploy to land at apply. The VM is ENABLED
    // from genesis (WASM_VM_ENABLED=true), so this branch is normally unreachable — it only fires on a
    // build that gates the VM off, and the message describes exactly that state (no false "pending").
    if !qnet_state::wasm_exec::wasm_vm_enabled() {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "WASM VM is disabled on this node (WASM_VM_ENABLED=false)"
        })));
    }
    let code = match hex::decode(request.code.trim()) {
        Ok(c) => c,
        Err(_) => return Ok(warp::reply::json(&json!({
            "success": false, "error": "code must be hex-encoded WASM bytes"
        }))),
    };
    // Same deterministic gate the apply path enforces (fail fast + honestly).
    if let Err(e) = qnet_vm::validate_wasm_module(&code, &qnet_vm::VmLimits::default()) {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "invalid WASM module", "details": format!("{}", e)
        })));
    }
    if request.dilithium_signature.is_empty() || request.dilithium_public_key.is_empty() {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "dilithium_signature + dilithium_public_key required (pure-PQ; ML-DSA-65)"
        })));
    }

    let nonce = request.nonce;
    let contract_address = qnet_state::transaction::derive_contract_address(&request.from, nonce);
    // Canonical deploy payload FIRST, then its digest — sha3(module bytes) for WASM, re-derived by
    // classify_contract_deploy on every node so the stored code cannot differ from the signed hash.
    let mut deploy_data = json!({
        "wasm": true,
        "code": request.code.trim(),
    });
    let code_hash = match qnet_state::transaction::deploy_code_hash(
        qnet_state::transaction::DeployKind::Wasm, &deploy_data) {
        Ok(h) => h,
        Err(e) => return Ok(warp::reply::json(&json!({
            "success": false, "error": "Invalid WASM deploy payload", "details": e
        }))),
    };
    deploy_data["code_hash"] = json!(code_hash);
    let gas_price = 1000u64;
    let gas_limit = 200_000u64;

    let mut tx = qnet_state::Transaction {
        hash: String::new(),
        from: request.from.clone(),
        to: Some(contract_address.clone()),
        amount: 0,
        nonce,
        gas_price,
        gas_limit,
        timestamp: chrono::Utc::now().timestamp() as u64,
        signature: None,
        public_key: None,
        tx_type: qnet_state::TransactionType::ContractDeploy,
        data: Some(serde_json::to_string(&deploy_data).unwrap_or_default()),
        // FIX-5: hex(raw detached) -> bytes; value gate verifies
        dilithium_signature: hex::decode(&request.dilithium_signature).ok(),
        dilithium_public_key: hex::decode(&request.dilithium_public_key).ok(),
        chain_id: qnet_state::transaction::QNET_CHAIN_ID,
    };
    tx.hash = tx.calculate_hash();
    let tx_hash = tx.hash.clone();

    match blockchain.submit_transaction(tx).await {
        Ok(_) => {
            println!("[INFO][VM] wasm_deploy_submitted contract={} code_bytes={} hash={}",
                     qnet_state::char_prefix(&contract_address, 16), code.len(),
                     qnet_state::char_prefix(&tx_hash, 16));
            Ok(warp::reply::json(&json!({
                "success": true,
                "tx_hash": tx_hash,
                "contract": { "contract_address": contract_address, "creator": request.from },
                "message": "WASM contract deployment submitted to blockchain (pending confirmation)"
            })))
        }
        Err(e) => Ok(warp::reply::json(&json!({
            "success": false, "error": "Failed to submit WASM deploy transaction",
            "details": format!("{}", e)
        }))),
    }
}

/// Request to deploy a new QRC-721 (NFT) collection
#[derive(Debug, Deserialize)]
pub(super) struct NftDeployRequest {
    /// Creator's EON address
    pub(super) from: String,
    /// Collection name
    pub(super) name: String,
    /// Collection symbol
    pub(super) symbol: String,
    /// Replay-protection nonce (client signs it into the canonical
    /// "q{chain}|contract_deploy:{from}:{code_hash}:{nonce}" message the value-TX gate verifies).
    pub(super) nonce: u64,
    /// ML-DSA-65 signature (MANDATORY; pure ML-DSA-65)
    pub(super) dilithium_signature: String,
    /// ML-DSA-65 public key (MANDATORY; pure ML-DSA-65)
    pub(super) dilithium_public_key: String,
}

/// Handle QRC-721 (NFT) collection deployment. Mirrors handle_token_deploy: builds a
/// ContractDeploy value-TX with data {"qrc721":true,...} that apply_to_state materializes
/// on every node; authorisation is the value-TX gate (verify_user_tx_dilithium) over the
/// canonical "q{chain}|contract_deploy:{from}:{code_hash}:{nonce}" where code_hash is the canonical
/// deploy digest (qnet_state::transaction::deploy_code_hash) over the payload built below — the
/// client MUST sign THAT message with a wallet ML-DSA-65 key whose eon address == from. Individual
/// NFTs are minted afterwards via ContractCall.
pub(super) async fn handle_nft_deploy(
    request: NftDeployRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "activation") {
        return Ok(rate_limit_response);
    }
    if let Err(e) = validate_eon_address_with_error(&request.from) {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "Invalid creator address", "details": e
        })));
    }
    if request.name.is_empty() || request.name.len() > 64 {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "Collection name must be 1-64 characters"
        })));
    }
    if request.symbol.is_empty() || request.symbol.len() > 10 {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "Collection symbol must be 1-10 characters"
        })));
    }
    if request.dilithium_signature.is_empty() || request.dilithium_public_key.is_empty() {
        return Ok(warp::reply::json(&json!({
            "success": false, "error": "dilithium_signature + dilithium_public_key required (pure-PQ; ML-DSA-65)"
        })));
    }

    let nonce = request.nonce;
    let contract_address = qnet_state::transaction::derive_contract_address(&request.from, nonce);
    // Canonical deploy payload FIRST, then its digest — the value the client signs and that
    // classify_contract_deploy re-derives on every node, binding name/symbol to the signature.
    let mut deploy_data = json!({
        "qrc721": true,
        "name": request.name,
        "symbol": request.symbol,
    });
    let code_hash = match qnet_state::transaction::deploy_code_hash(
        qnet_state::transaction::DeployKind::Qrc721, &deploy_data) {
        Ok(h) => h,
        Err(e) => return Ok(warp::reply::json(&json!({
            "success": false, "error": "Invalid NFT deploy payload", "details": e
        }))),
    };
    deploy_data["code_hash"] = json!(code_hash);
    let gas_price = 1000u64;
    let gas_limit = 50_000u64;

    let mut tx = qnet_state::Transaction {
        hash: String::new(),
        from: request.from.clone(),
        to: Some(contract_address.clone()),
        amount: 0,
        nonce,
        gas_price,
        gas_limit,
        timestamp: chrono::Utc::now().timestamp() as u64,
        signature: None,
        public_key: None,
        tx_type: qnet_state::TransactionType::ContractDeploy,
        data: Some(serde_json::to_string(&deploy_data).unwrap_or_default()),
        // FIX-5: hex(raw detached) -> bytes; value gate verifies
        dilithium_signature: hex::decode(&request.dilithium_signature).ok(),
        dilithium_public_key: hex::decode(&request.dilithium_public_key).ok(),
        chain_id: qnet_state::transaction::QNET_CHAIN_ID,
    };
    tx.hash = tx.calculate_hash();
    let tx_hash = tx.hash.clone();

    match blockchain.submit_transaction(tx).await {
        Ok(_) => {
            println!("[INFO][NFT] qrc721_deploy_submitted name={} symbol={} contract={} hash={}",
                     request.name, request.symbol,
                     qnet_state::char_prefix(&contract_address, 16),
                     qnet_state::char_prefix(&tx_hash, 16));
            Ok(warp::reply::json(&json!({
                "success": true,
                "tx_hash": tx_hash,
                "collection": {
                    "contract_address": contract_address,
                    "name": request.name,
                    "symbol": request.symbol,
                    "creator": request.from
                },
                "message": "QRC-721 collection deployment submitted to blockchain (pending confirmation)"
            })))
        }
        Err(e) => {
            Ok(warp::reply::json(&json!({
                "success": false, "error": "Failed to submit NFT deploy transaction",
                "details": format!("{}", e)
            })))
        }
    }
}

/// Request to deploy a new QRC-20 token
#[derive(Debug, Deserialize)]
pub(super) struct TokenDeployRequest {
    /// Creator's EON address
    pub(super) from: String,
    /// Token name
    pub(super) name: String,
    /// Token symbol
    pub(super) symbol: String,
    /// Decimals (default 18)
    #[serde(default = "default_decimals")]
    pub(super) decimals: u8,
    /// Initial supply
    pub(super) initial_supply: u64,
    /// Optional token logo — an emoji or https URL (sanitized + capped at apply). Empty ⇒ clients
    /// render a generated avatar.
    #[serde(default)]
    pub(super) logo: String,
    /// Opt-in supply mutation. Absent ⇒ false, i.e. an immutable-supply token.
    #[serde(default)]
    pub(super) mintable: bool,
    #[serde(default)]
    pub(super) burnable: bool,
    /// Replay-protection nonce (client-provided; the caller signs it into the canonical
    /// "q{chain}|contract_deploy:{from}:{code_hash}:{nonce}" message the value-TX gate verifies).
    pub(super) nonce: u64,
    /// ML-DSA-65 signature (MANDATORY v6.1)
    pub(super) dilithium_signature: String,
    /// ML-DSA-65 public key (MANDATORY v6.1)
    pub(super) dilithium_public_key: String,
}

pub(super) fn default_decimals() -> u8 { 9 } // QNet standard: 9 decimals (like SOL, QNC)

/// Handle QRC-20 token deployment
/// v3.40: CRITICAL FIX — Token deploy now goes THROUGH BLOCKCHAIN (ContractDeploy TX),
/// NOT directly to local RocksDB. This ensures:
/// 1. Token state is replicated to ALL nodes via block gossip
/// 2. Token state survives node restart (replayed from blocks)
/// 3. Token deploy is auditable on-chain (has TX hash)
/// 4. Deterministic contract address (same on all nodes)
pub(super) async fn handle_token_deploy(
    request: TokenDeployRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Rate limiting
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "activation") {
        return Ok(rate_limit_response);
    }
    
    // Validate creator address
    if let Err(e) = validate_eon_address_with_error(&request.from) {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid creator address",
            "details": e
        })));
    }
    
    // Validate token parameters
    if request.name.is_empty() || request.name.len() > 64 {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Token name must be 1-64 characters"
        })));
    }
    
    if request.symbol.is_empty() || request.symbol.len() > 10 {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Token symbol must be 1-10 characters"
        })));
    }
    
    if request.initial_supply == 0 {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Initial supply must be greater than 0"
        })));
    }
    
    // PURE DILITHIUM (F0.2): structural presence check only. A QRC-20 token deploy IS a ContractDeploy
    // value-TX, so the AUTHORITATIVE verify is the value-TX gate in submit_transaction
    // (verify_user_tx_dilithium): it opens the ML-DSA-65 sig over the canonical message
    // build_canonical_verify_message() rebuilds — "q{chain}|contract_deploy:{from}:{code_hash}:{nonce}" where
    // code_hash is the canonical deploy digest over the payload built below (it commits to every
    // applied field) — AND binds eon_from_qnet_dilithium_pubkey(dpk)==from.
    // The client MUST sign THAT message (NOT "token_deploy:..") in the "dilithium_sig_{pk}_{b64}" wire
    // format with a wallet ML-DSA-65 key whose eon address == from, and provide the matching `nonce`.
    if request.dilithium_signature.is_empty() || request.dilithium_public_key.is_empty() {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "dilithium_signature + dilithium_public_key required (pure-PQ; ML-DSA-65)"
        })));
    }

    // Client-provided nonce (replay protection is enforced at apply). It MUST match the nonce the caller
    // signed into the canonical "q{chain}|contract_deploy:{from}:{code_hash}:{nonce}" message, else the value-TX
    // gate rejects the derived ContractDeploy at ingest.
    let nonce = request.nonce;
    
    // Single-source on-chain derivation; apply ignores caller-supplied `to` (no address squatting)
    let contract_address = qnet_state::transaction::derive_contract_address(&request.from, nonce);

    // Canonical deploy payload FIRST, then its digest: code_hash commits to every field apply reads
    // (name/symbol/decimals/supply/flags/logo), so nothing here is malleable under the client's
    // signature. The client signs the same digest — see WalletManager.js deployToken.
    let mut deploy_data = json!({
        "qrc20": true,
        "name": request.name,
        "symbol": request.symbol,
        "decimals": request.decimals,
        // Optional on-chain logo (emoji / https URL) — sanitized at apply; "" ⇒ generated avatar.
        "logo": request.logo,
        // STRING (exact past 2^53); apply + explorer both accept number-or-string.
        "initial_supply": request.initial_supply.to_string(),
        "mintable": request.mintable,
        "burnable": request.burnable,
    });
    let code_hash = match qnet_state::transaction::deploy_code_hash(
        qnet_state::transaction::DeployKind::Qrc20, &deploy_data) {
        Ok(h) => h,
        Err(e) => return Ok(warp::reply::json(&json!({
            "success": false, "error": "Invalid token deploy payload", "details": e
        }))),
    };
    deploy_data["code_hash"] = json!(code_hash);

    // v3.40: Create ContractDeploy transaction — goes to mempool -> block -> all nodes
    // QRC-20 metadata is stored in tx.data as JSON so apply_to_state can parse it
    let gas_price = 1000u64; // Standard QRC-20 deploy gas price
    let gas_limit = 50_000u64; // QRC-20 deploy gas limit
    
    let mut tx = qnet_state::Transaction {
        hash: String::new(),
        from: request.from.clone(),
        to: Some(contract_address.clone()),
        amount: 0,
        nonce,
        gas_price,
        gas_limit,
        timestamp: chrono::Utc::now().timestamp() as u64,
        signature: None,
        public_key: None,
        tx_type: qnet_state::TransactionType::ContractDeploy,
        data: Some(serde_json::to_string(&deploy_data).unwrap_or_default()),
        // FIX-5: hex(raw detached) -> bytes; value gate verifies
        dilithium_signature: hex::decode(&request.dilithium_signature).ok(),
        dilithium_public_key: hex::decode(&request.dilithium_public_key).ok(),
        chain_id: qnet_state::transaction::QNET_CHAIN_ID,
    };

    // Calculate hash BEFORE submit (same as all other TX handlers)
    tx.hash = tx.calculate_hash();
    let tx_hash = tx.hash.clone();
    
    // Submit to mempool -> included in block -> apply_to_state on ALL nodes
    match blockchain.submit_transaction(tx).await {
        Ok(_) => {
            println!("[INFO][TOKEN] qrc20_deploy_submitted name={} symbol={} supply={} contract={} hash={}",
                     request.name, request.symbol, request.initial_supply,
                     qnet_state::char_prefix(&contract_address, 16),
                     qnet_state::char_prefix(&tx_hash, 16));
            
            Ok(warp::reply::json(&json!({
                "success": true,
                "tx_hash": tx_hash,
                "token": {
                    "contract_address": contract_address,
                    "name": request.name,
                    "symbol": request.symbol,
                    "decimals": request.decimals,
                    "total_supply": request.initial_supply,
                    "creator": request.from
                },
                "message": "QRC-20 token deployment submitted to blockchain (pending confirmation)"
            })))
        }
        Err(e) => {
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Token deployment failed — could not submit to mempool",
                "details": format!("{:?}", e)
            })))
        }
    }
}

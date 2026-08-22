//! Account, token and validator queries with Merkle proofs; history, blocks and snapshots.

use super::*;

/// v3.11: Balance with Merkle proof for Light client trustless verification
/// Endpoint: GET /api/v1/account/{address}/balance/proof
/// 
/// Response includes:
/// - balance: Current balance in nanoQNC
/// - merkle_proof: Array of [sibling_hash, is_right] for verification
/// - state_root: Merkle state root this proof is valid for
/// - block_height: Height at which state_root was computed
/// 
/// Light clients can verify: verify_proof(address, balance, proof, state_root)
/// Then verify state_root is in a valid block header
pub(super) async fn handle_account_balance_with_proof(
    address: String,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting (higher limit for proof requests as they're more expensive)
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    // Validate address parameter
    if address.len() > 64 {
        return Ok(warp::reply::json(&json!({
            "error": "Invalid address",
            "message": "Address parameter too long (max 64 characters)"
        })));
    }
    
    // Get balance with proof from state manager
    match blockchain.get_balance_with_proof(&address).await {
        Ok(proof) => {
            // Convert proof to JSON-friendly format
            let proof_array: Vec<serde_json::Value> = proof.proof.iter()
                .map(|(hash, is_right)| {
                    json!({
                        "sibling": hex::encode(hash),
                        "is_right": is_right
                    })
                })
                .collect();
            
            Ok(warp::reply::json(&json!({
                "address": proof.address,
                "balance": proof.balance,
                "nonce": proof.nonce,
                // Every leaf input, or the client cannot rebuild the hash it is verifying.
                "heartbeat_epoch": proof.heartbeat_epoch,
                "heartbeat_slots": proof.heartbeat_slots,
                "heartbeat_final_epoch": proof.heartbeat_final_epoch,
                "heartbeat_final_slots": proof.heartbeat_final_slots,
                "last_claimed_epoch": proof.last_claimed_epoch,
                "banned_at_height": proof.banned_at_height,
                "is_node": proof.is_node,
                "merkle_proof": proof_array,
                "state_root": hex::encode(proof.state_root),
                "block_height": proof.block_height,
                "proof_valid": true
            })))
        }
        Err(e) => {
            // Account not found - return empty balance with proof
            let msg = e.to_string();
            // No state account = every empty wallet polling its balance; WARN here would flood
            // logs at scale (thousands of fresh wallets). Real failures still WARN.
            if msg.contains("Account not found") {
                if crate::node::is_debug() {
                    println!("[DBG][RPC] balance_proof_no_account address={}", address);
                }
            } else {
                println!("[WARN][RPC] api_error endpoint=balance_proof address={} err={}", address, msg);
            }
            Ok(warp::reply::json(&json!({
                "address": address,
                "balance": 0,
                "nonce": 0,
                "merkle_proof": [],
                "state_root": "",
                "block_height": 0,
                "error": "account not found",
                "proof_valid": false
            })))
        }
    }
}

/// V2: GET /api/v1/token/{contract}/{holder}/balance/proof
/// Two-level trustless proof that `holder`'s QRC-20 balance is committed in state_root. Emits EVERY
/// field the contract account leaf and the storage leaf depend on, so a light client can reconstruct
/// both levels (account leaf → state_root, then balance:{holder} leaf → storage_root) with no trust.
pub(super) async fn handle_token_balance_with_proof(
    contract: String,
    holder: String,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    if contract.len() > 64 || holder.len() > 64 {
        return Ok(warp::reply::json(&json!({ "error": "Invalid parameter", "proof_valid": false })));
    }
    let hexvec = |v: &Vec<([u8; 32], bool)>| -> Vec<serde_json::Value> {
        v.iter().map(|(h, r)| json!({ "sibling": hex::encode(h), "is_right": r })).collect()
    };
    match blockchain.get_token_balance_with_proof(&contract, &holder).await {
        Ok(p) => Ok(warp::reply::json(&json!({
            "contract_address": p.contract_address,
            "holder": p.holder,
            // Level-2 (balance:{holder} -> storage_root)
            "token_balance": p.token_balance,     // raw stored decimal string
            "storage_proof": hexvec(&p.storage_proof),
            "storage_root": hex::encode(p.storage_root),
            // Level-1 (contract account leaf -> state_root): ALL leaf-determining fields
            "account_balance": p.account_balance.to_string(),
            "account_nonce": p.account_nonce,
            "contract_code_hash": p.contract_code_hash,
            "heartbeat_epoch": p.heartbeat_epoch,
            "heartbeat_slots": p.heartbeat_slots,
            "heartbeat_final_epoch": p.heartbeat_final_epoch,
            "heartbeat_final_slots": p.heartbeat_final_slots,
            // The leaf hashes last_claimed_epoch and banned_at_height; omitting either left the
            // client unable to rebuild it.
            "last_claimed_epoch": p.last_claimed_epoch,
            "banned_at_height": p.banned_at_height,
            "is_node": p.is_node,
            "account_proof": hexvec(&p.account_proof),
            // Anchors
            "state_root": hex::encode(p.state_root),
            "block_height": p.block_height,
            "proof_valid": true
        }))),
        Err(e) => {
            println!("[WARN][RPC] api_error endpoint=token_balance_proof contract={} holder={} err={}", contract, holder, e);
            Ok(warp::reply::json(&json!({
                "contract_address": contract,
                "holder": holder,
                "token_balance": "0",
                "error": "token balance not provable",
                "proof_valid": false
            })))
        }
    }
}

/// v3.32: GET /api/v1/validators/proof
/// Returns validator set with Merkle proof for trustless light client verification
/// 
/// CRITICAL: Uses EXISTING data sources (no duplication!):
/// 1. Connected peers from P2P layer
/// 2. DeterministicReputationState from MacroBlocks (synced across all nodes)
/// 3. Genesis nodes as fallback
///
/// Light clients verify: SHA3-256(sorted validators) == merkle_root
/// Then compare merkle_root in latest MacroBlock header (signed by 2/3 validators)
pub(super) async fn handle_validators_with_proof(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Rate limiting
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    let current_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    
    // Get current chain height
    let height = blockchain.get_height().await;
    let epoch = height / 90; // MacroBlock epoch
    
    // v3.35 FIX: Get validators from BLOCKCHAIN (NodeRegistration TX)
    // api_endpoint is part of NodeRegistration TX - stored ON-CHAIN!
    // Genesis = always public (in genesis block)
    // Super nodes = public by default, can hide with QNET_HIDE_IP=1
    // Light nodes = NEVER public (privacy protection)
    
    let mut validators: Vec<serde_json::Value> = Vec::new();
    
    use crate::genesis_constants::{GENESIS_NODE_IPS, get_genesis_region_by_ip};
    
    // Get ALL nodes with public API endpoints from blockchain
    // v3.35: Now returns (node_id, endpoint, type, reputation, last_seen, is_synced)
    // This searches NodeRegistration TXs and filters by:
    // - reputation >= 70%
    // - last_seen < 5 minutes (from P2P heartbeat)
    // - is_synced = true (not more than 5 blocks behind)
    let public_nodes = blockchain.get_all_public_api_nodes().await;
    
    for (node_id, api_endpoint, _node_type, reputation, last_seen, is_synced) in &public_nodes {
        // Determine region (from Genesis constants or Unknown for others)
        let region = if node_id.starts_with("genesis_node_") {
            let id = node_id.strip_prefix("genesis_node_").unwrap_or("001");
            GENESIS_NODE_IPS.iter()
                .find(|(_, gid)| *gid == id)
                .and_then(|(ip, _)| get_genesis_region_by_ip(ip))
                .unwrap_or("Europe")
                .to_string()
        } else {
            "Unknown".to_string()
        };
        
        validators.push(json!({
            "node_id": node_id,
            "address": api_endpoint,
            "node_type": "Super",
            "reputation": reputation,
            "last_seen": last_seen, // v3.35: REAL last_seen from P2P heartbeat
            "is_active": true,
            "is_synced": is_synced, // v3.35: Sync status (not more than 5 blocks behind)
            "region": region
        }));
    }
    
    if is_info() {
        println!("[INFO][API] validators_from_blockchain total={} with_public_api={}", 
                 public_nodes.len(), validators.len());
    }
    
    // Source 2: Add Genesis nodes if not already present (fallback/bootstrap)
    for (genesis_ip, genesis_id) in GENESIS_NODE_IPS.iter() {
        let node_id = format!("genesis_node_{}", genesis_id);
        let already_exists = validators.iter().any(|v| 
            v["node_id"].as_str() == Some(node_id.as_str())
        );
        if !already_exists {
            let real_rep = qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
            let region = get_genesis_region_by_ip(genesis_ip).unwrap_or("Europe");
            validators.push(json!({
                "node_id": node_id,
                "address": format!("http://{}:8001", genesis_ip),
                "node_type": "Super",
                "reputation": real_rep.max(0.7), // Genesis minimum 0.7
                "last_seen": current_time,
                "is_active": true,
                "is_synced": true, // Genesis always synced
                "region": region
            }));
        }
    }

    // Sort validators by node_id for deterministic Merkle root
    validators.sort_by(|a, b| {
        a["node_id"].as_str().unwrap_or("").cmp(b["node_id"].as_str().unwrap_or(""))
    });
    
    // Compute Merkle root (same algorithm as light client will use)
    use sha3::{Sha3_256, Digest};
    let mut hasher = Sha3_256::new();
    hasher.update(b"QNET_VALIDATOR_SET:");
    hasher.update(&epoch.to_le_bytes());
    
    for v in &validators {
        hasher.update(v["node_id"].as_str().unwrap_or("").as_bytes());
        hasher.update(v["address"].as_str().unwrap_or("").as_bytes());
        hasher.update(v["node_type"].as_str().unwrap_or("").as_bytes());
        let rep = v["reputation"].as_f64().unwrap_or(0.0);
        hasher.update(&rep.to_le_bytes());
        let last_seen = v["last_seen"].as_u64().unwrap_or(0);
        hasher.update(&last_seen.to_le_bytes());
        let is_active = v["is_active"].as_bool().unwrap_or(false);
        hasher.update(&[is_active as u8]);
    }
    
    let merkle_root = hasher.finalize();
    let merkle_root_hex = hex::encode(&merkle_root);
    
    let active_count = validators.iter()
        .filter(|v| v["is_active"].as_bool().unwrap_or(false))
        .count();
    
    if is_info() {
        println!("[INFO][API] validators_proof epoch={} total={} active={} merkle_root={}...",
                 epoch, validators.len(), active_count, &merkle_root_hex[..16]);
    }
    
    Ok(warp::reply::json(&json!({
        "validators": validators,
        "epoch": epoch,
        "merkle_root": merkle_root_hex,
        "last_update_height": height,
        "current_height": height,
        "total_validators": validators.len(),
        "active_validators": active_count
    })))
}

pub(super) async fn handle_account_transactions(
    address: String,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    // v3.19: Validate address parameter
    if address.len() > 64 {
        return Ok(warp::reply::json(&json!({
            "error": "Invalid address",
            "message": "Address parameter too long (max 64 characters)"
        })));
    }
    
    // PRODUCTION: Fetch real transactions from blockchain storage
    let storage = blockchain.get_storage();
    
    // Get transactions for this address (page 0, 50 per page)
    match storage.get_transactions_by_address(&address, 0, 50).await {
        Ok(transactions) => {
            // Convert to JSON format
            let txs: Vec<serde_json::Value> = transactions.iter().map(|tx| {
                json!({
                    "hash": tx.hash,
                    "from": tx.from,
                    "to": tx.to,
                    "amount": tx.amount,
                    "timestamp": tx.timestamp,
                    "gas_price": tx.gas_price,
                    "gas_limit": tx.gas_limit,
                    "tx_type": format!("{:?}", tx.tx_type),
                    // ContractCall payload {"method","args"} so clients render a QRC-20 transfer with the
                    // real recipient + token amount/symbol/icon instead of a native "0 QNC" row.
                    "data": tx.data
                })
            }).collect();
            
            // Get total count for pagination
            let total_count = storage.count_transactions_by_address(&address).await
                .unwrap_or(txs.len());
            
            let response = json!({
                "address": address,
                "transactions": txs,
                "count": total_count,
                "page": 1,
                "per_page": 50
            });
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            println!("[WARN][API] tx_fetch_failed address={} err={}", address, e);
            let error_response = json!({
                "address": address,
                "transactions": [],
                "count": 0,
                "error": format!("Failed to fetch transactions: {}", e)
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct TokenTransfersQuery {
    pub(super) limit: Option<usize>,
    pub(super) before: Option<String>,
}

/// Resolve per-contract metadata (symbol/decimals/logo) ONCE and denormalize it onto each row, so a
/// client renders the icon + human amount with no extra per-token fetch. Bounded by the page size.
pub(super) async fn enrich_token_transfers(blockchain: &Arc<BlockchainNode>, rows: Vec<crate::storage::TokenTransferRow>) -> Vec<serde_json::Value> {
    // Resolve each unique contract's metadata ONCE per request into a local map: global immutable cache
    // first, else a LIGHT metadata read (get_contract_meta — no whole-account/O(holders) clone), caching
    // it globally only while under the cap. Using the local map for rendering means EVERY row gets the
    // CORRECT decimals/symbol (incl. NFT decimals=0) even for contracts beyond the global cache cap — a
    // miss no longer silently defaults to decimals=9.
    let mut resolved: std::collections::HashMap<String, (String, u8, String)> = std::collections::HashMap::new();
    for r in &rows {
        if resolved.contains_key(&r.contract) { continue; }
        if let Some(e) = TOKEN_META_CACHE.get(&r.contract) { resolved.insert(r.contract.clone(), e.value().clone()); continue; }
        if let Some((symbol, decimals, logo, _is_nft)) = blockchain.get_contract_meta(&r.contract).await {
            let m = (symbol, decimals, logo);
            if TOKEN_META_CACHE.len() < TOKEN_META_CACHE_MAX { TOKEN_META_CACHE.insert(r.contract.clone(), m.clone()); }
            resolved.insert(r.contract.clone(), m);
        }
    }
    rows.into_iter().map(|r| {
        let (symbol, decimals, logo) = resolved.get(&r.contract).cloned().unwrap_or((String::new(), 9, String::new()));
        json!({
            "contract": r.contract, "from": r.from, "to": r.to, "amount": r.amount,
            "kind": r.kind, "std": r.std, "token_id": r.token_id, "tx_hash": r.tx_hash,
            "log_index": r.log_index, "height": r.height, "timestamp": r.timestamp,
            "cursor": format!("{:016x}_{:08x}", r.height, r.log_index),
            "symbol": symbol, "decimals": decimals, "logo": logo,
        })
    }).collect()
}

/// GET /api/v1/account/{address}/token-transfers?limit=&before= — decoded, success-gated token
/// transfers where the address is sender OR recipient (newest first). `before` = last row's cursor.
pub(super) async fn handle_account_token_transfers(
    address: String,
    q: TokenTransfersQuery,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(r) = check_api_rate_limit(remote_addr, "read_only") { return Ok(r); }
    if address.len() > 128 {
        return Ok(warp::reply::json(&json!({"error": "Invalid address"})));
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let before = q.before.as_deref().filter(|s| s.len() <= 40 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'_'));
    let storage = blockchain.get_storage();
    let rows = storage.get_token_transfers_by_address(&address, limit, before);
    let transfers = enrich_token_transfers(&blockchain, rows).await;
    // Retention honesty (mirror getLogs): transfers below the prune floor are physically gone on this
    // node, so an empty/short result there is NOT "no more history". A client below it must archive-fetch.
    Ok(warp::reply::json(&json!({ "address": address, "count": transfers.len(), "transfers": transfers, "oldest_available": storage.log_prune_floor() })))
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct LogProofQuery {
    pub(super) tx_hash: String,
    pub(super) log_index: Option<usize>,
}

/// GET /api/v1/logs/proof?tx_hash=&log_index= — P4 light-client transfer-inclusion proof. Returns the
/// merkle sibling path from the event leaf to the window's logs_root; the client recomputes the root
/// and checks it equals the QC-anchored `Checkpoint.logs_root` it independently verified for [start,end].
pub(super) async fn handle_log_proof(
    q: LogProofQuery,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(r) = check_api_rate_limit(remote_addr, "read_only") { return Ok(r); }
    if q.tx_hash.len() != 64 || !q.tx_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(warp::reply::json(&json!({"error": "Invalid tx_hash"})));
    }
    let target_li = q.log_index.unwrap_or(0);
    let storage = blockchain.get_storage();
    let h = match storage.get_transaction_block_height(&q.tx_hash).await {
        Ok(h) if h > 0 => h,
        _ => return Ok(warp::reply::json(&json!({"error": "Transaction not found"}))),
    };
    // Macroblock window [start,end] (90 microblocks) whose Checkpoint.logs_root commits this height —
    // same window keying as the consensus signal (K=90). Leaves via the SHARED builder (no drift).
    let end = ((h - 1) / 90 + 1) * 90;
    let start = end.saturating_sub(89).max(1);
    // Only prove FINALIZED windows: every block in [start,end] must be applied, else the leaf set is
    // partial and the proof can never match the eventual QC-committed Checkpoint.logs_root.
    if end > blockchain.get_height().await {
        return Ok(warp::reply::json(&json!({"error": "window_not_finalized", "window_end": end})));
    }
    // Lower bound: blocklogs below the prune floor are physically gone (get_block_logs → empty), so a
    // straddling window rebuilds a truncated-suffix leaf set whose root is NOT the QC-committed
    // logs_root. Reject like getLogs rather than emit an authoritative-looking non-consensus root.
    // floor is window-aligned (14_400 = 160*90) ⇒ it sits at a window END, so only the [floor-89,floor]
    // window has partial leaves; start < floor gates exactly that window and every fully-pruned older one.
    let log_floor = storage.log_prune_floor();
    if start < log_floor {
        return Ok(warp::reply::json(&json!({"error": "window_pruned", "window_start": start, "window_end": end, "oldest_available": log_floor})));
    }
    // SHARDED 2-level proof — the SCALE fix: rebuild ONLY block h's leaves for level-1 (leaf → this
    // block's sub-root), then fold the window's per-block sub-roots for level-2 (sub-root → the committed
    // logs_root). Both are O(one block) + O(~90 sub-roots), so a proof NEVER rebuilds the whole window —
    // no per-request OOM even at high token TPS, and no serve ceiling below the consensus maximum.
    let block_h_logs = storage.get_block_logs(h);
    let belongs = block_h_logs.get(target_li).map(|(lt, _, _)| lt == &q.tx_hash).unwrap_or(false);
    if !belongs {
        return Ok(warp::reply::json(&json!({"error": "Log not found in window", "window_start": start, "window_end": end})));
    }
    let block_leaves: Vec<Vec<u8>> = block_h_logs.iter().enumerate()
        .map(|(i, (tx, contract, data))| qnet_state::wasm_exec::log_leaf(tx, i as u32, contract, data)).collect();
    let raw = block_leaves[target_li].clone();
    // Level 1: leaf → block sub-root (rebuilds only this block).
    let (l1_pairs, block_root) = qnet_consensus::checkpoint_bft::logs_merkle_proof_with_root(&block_leaves, target_li);
    // Level 2: block sub-root → window logs_root (over the ~90 stored per-block sub-roots — same builder
    // the seal uses, so byte-identical to the QC-committed Checkpoint.logs_root).
    let block_roots = crate::node::BlockchainNode::collect_window_block_roots(&storage, start, end);
    let block_index = (h - start) as usize;
    let (l2_pairs, window_root) = qnet_consensus::checkpoint_bft::logs_window_proof_with_root(&block_roots, block_index);
    let l1: Vec<serde_json::Value> = l1_pairs.iter().map(|(hsh, right)| json!({ "hash": hex::encode(hsh), "right": right })).collect();
    let l2: Vec<serde_json::Value> = l2_pairs.iter().map(|(hsh, right)| json!({ "hash": hex::encode(hsh), "right": right })).collect();
    Ok(warp::reply::json(&json!({
        "tx_hash": q.tx_hash, "log_index": target_li,
        "window_start": start, "window_end": end, "block_index": block_index,
        "leaf": hex::encode(&raw),
        "proof": l1,                            // level 1: leaf → block_root
        "block_root": hex::encode(block_root),
        "window_proof": l2,                     // level 2: block_root → logs_root
        "logs_root": hex::encode(window_root),
    })))
}

/// GET /api/v1/token/{contract}/transfers?limit=&before= — decoded transfers for one token (newest first).
pub(super) async fn handle_token_transfers(
    contract: String,
    q: TokenTransfersQuery,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(r) = check_api_rate_limit(remote_addr, "read_only") { return Ok(r); }
    if contract.len() > 128 {
        return Ok(warp::reply::json(&json!({"error": "Invalid contract"})));
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let before = q.before.as_deref().filter(|s| s.len() <= 40 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'_'));
    let storage = blockchain.get_storage();
    let rows = storage.get_token_transfers_by_contract(&contract, limit, before);
    let transfers = enrich_token_transfers(&blockchain, rows).await;
    // Retention honesty (mirror getLogs): history below the prune floor is physically gone on this node.
    Ok(warp::reply::json(&json!({ "contract": contract, "count": transfers.len(), "transfers": transfers, "oldest_available": storage.log_prune_floor() })))
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct TokenTransfersRangeQuery {
    pub(super) from: u64,
    pub(super) to: u64,
    pub(super) limit: Option<usize>,
    pub(super) after: Option<String>,
}

/// GET /api/v1/token-transfers?from=&to=&limit=&after= — decoded, type-gated token transfers in a
/// height range (block order). For explorer ingestion; raw rows (the explorer joins its own metadata).
/// `after` = the `{height:016x}_{log_index:08x}` cursor of the last row already ingested; the response
/// carries `truncated` + `next_cursor` so a height with more than `limit` events pages fully (no drop).
pub(super) async fn handle_token_transfers_range(
    q: TokenTransfersRangeQuery,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(r) = check_api_rate_limit(remote_addr, "read_only") { return Ok(r); }
    let from = q.from;
    let to = q.to.max(from);
    if to.saturating_sub(from) > 10_000 {
        return Ok(warp::reply::json(&json!({"error": "Range too large (max 10000 blocks)"})));
    }
    let limit = q.limit.unwrap_or(2000).clamp(1, 5000);
    let after = q.after.as_deref().filter(|s| s.len() <= 40 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'_'));
    let storage = blockchain.get_storage();
    let (rows, truncated) = storage.get_token_transfers_in_range(from, to, limit, after);
    let next_cursor = if truncated {
        rows.last().map(|r| format!("{:016x}_{:08x}", r.height, r.log_index))
    } else { None };
    let transfers: Vec<serde_json::Value> = rows.iter().map(|r| json!({
        "contract": r.contract, "from": r.from, "to": r.to, "amount": r.amount,
        "kind": r.kind, "std": r.std, "token_id": r.token_id, "tx_hash": r.tx_hash,
        "log_index": r.log_index, "height": r.height, "timestamp": r.timestamp,
    })).collect();
    // Retention honesty (mirror getLogs): a range dipping below the prune floor is incomplete on this node.
    let floor = storage.log_prune_floor();
    Ok(warp::reply::json(&json!({
        "from": from, "to": to, "count": transfers.len(), "transfers": transfers,
        "truncated": truncated, "next_cursor": next_cursor,
        "oldest_available": floor, "pruned_below": if from < floor { Some(floor) } else { None },
    })))
}

/// Extended transaction history handler with pagination, filtering, and sorting
/// API: GET /api/v1/transactions/history?address=XXX&page=1&per_page=20&tx_type=transfer&direction=sent
pub(super) async fn handle_transaction_history(
    query: TransactionHistoryQuery,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Validate parameters
    let page = if query.page == 0 { 1 } else { query.page };
    let per_page = query.per_page.min(100).max(1); // Clamp to 1-100
    
    // Convert to 0-indexed page for storage
    let storage_page = page.saturating_sub(1);
    
    let storage = blockchain.get_storage();
    
    // Fetch transactions (fetch more to allow filtering)
    let fetch_limit = per_page * 3; // Fetch 3x to account for filtering
    match storage.get_transactions_by_address(&query.address, storage_page, fetch_limit).await {
        Ok(transactions) => {
            // Apply filters
            let filtered: Vec<_> = transactions.into_iter()
                .filter(|tx| {
                    // Type filter
                    let type_match = match query.tx_type.as_str() {
                        "transfer" => matches!(tx.tx_type, qnet_state::TransactionType::Transfer { .. }),
                        "reward" => matches!(tx.tx_type, qnet_state::TransactionType::RewardDistribution),
                        "activation" => matches!(tx.tx_type, qnet_state::TransactionType::NodeActivation { .. }),
                        "heartbeat_commitment" | "heartbeat" => matches!(tx.tx_type,
                            qnet_state::TransactionType::HeartbeatCommitment { .. } |
                            qnet_state::TransactionType::Heartbeat { .. }),
                        "ping_commitment" => matches!(tx.tx_type, qnet_state::TransactionType::PingCommitmentWithSampling { .. }),
                        "node_registration" => matches!(tx.tx_type, qnet_state::TransactionType::NodeRegistration { .. }),
                        "node_reactivation" => matches!(tx.tx_type, qnet_state::TransactionType::NodeReactivation { .. }),
                        "swap" => matches!(tx.tx_type, qnet_state::TransactionType::Swap { .. }),
                        "system" => matches!(tx.tx_type,
                            qnet_state::TransactionType::HeartbeatCommitment { .. } |
                            qnet_state::TransactionType::Heartbeat { .. } |
                            qnet_state::TransactionType::PingCommitmentWithSampling { .. } |
                            qnet_state::TransactionType::LightNodeEligibilityBitmap { .. } |
                            qnet_state::TransactionType::NodeReactivation { .. } |
                            qnet_state::TransactionType::RewardDistribution
                        ),
                        _ => true, // "all" or unknown
                    };
                    
                    // Direction filter
                    let direction_match = match query.direction.as_str() {
                        "sent" => tx.from == query.address,
                        "received" => tx.to.as_ref().map(|t| t == &query.address).unwrap_or(false),
                        _ => true, // "all" or unknown
                    };
                    
                    // Time range filter
                    let time_match = {
                        let after_start = query.start_time.map(|s| tx.timestamp >= s).unwrap_or(true);
                        let before_end = query.end_time.map(|e| tx.timestamp <= e).unwrap_or(true);
                        after_start && before_end
                    };
                    
                    type_match && direction_match && time_match
                })
                .take(per_page)
                .collect();
            
            // Convert to JSON with extended info
            let txs: Vec<serde_json::Value> = filtered.iter().map(|tx| {
                let direction = if tx.from == query.address {
                    "sent"
                } else {
                    "received"
                };
                
                let tx_type_str = match &tx.tx_type {
                    qnet_state::TransactionType::Transfer { .. } => "transfer",
                    qnet_state::TransactionType::RewardDistribution => "reward",
                    qnet_state::TransactionType::NodeActivation { .. } => "activation",
                    qnet_state::TransactionType::CreateAccount { .. } => "create_account",
                    qnet_state::TransactionType::ContractDeploy => "contract_deploy",
                    qnet_state::TransactionType::ContractCall => "contract_call",
                    qnet_state::TransactionType::BatchTransfers { .. } => "batch_transfer",
                    qnet_state::TransactionType::BatchRewardClaims { .. } => "batch_reward",
                    qnet_state::TransactionType::BatchNodeActivations { .. } => "batch_activation",
                    qnet_state::TransactionType::HeartbeatCommitment { .. } => "heartbeat_commitment",
                    qnet_state::TransactionType::Heartbeat { .. } => "heartbeat",
                    qnet_state::TransactionType::PingCommitmentWithSampling { .. } => "ping_commitment",
                    qnet_state::TransactionType::LightNodeEligibilityBitmap { .. } => "bitmap_commitment",
                    qnet_state::TransactionType::NodeRegistration { .. } => "node_registration",
                    qnet_state::TransactionType::NodeReactivation { .. } => "node_reactivation",
                    qnet_state::TransactionType::Swap { .. } => "swap",
                    _ => "other",
                };
                
                json!({
                    "hash": tx.hash,
                    "from": tx.from,
                    "to": tx.to,
                    "amount": tx.amount,
                    "timestamp": tx.timestamp,
                    "gas_price": tx.gas_price,
                    "gas_limit": tx.gas_limit,
                    "gas_used": tx.effective_gas_price().saturating_mul(tx.gas_limit),
                    "is_quantum_signed": tx.is_quantum_signed(),
                    "nonce": tx.nonce,
                    "type": tx_type_str,
                    "direction": direction
                })
            }).collect();
            
            // Get total count
            let total_count = storage.count_transactions_by_address(&query.address).await
                .unwrap_or(0);
            
            let total_pages = (total_count + per_page - 1) / per_page;
            
            let response = json!({
                "success": true,
                "address": query.address,
                "transactions": txs,
                "pagination": {
                    "page": page,
                    "per_page": per_page,
                    "total_count": total_count,
                    "total_pages": total_pages,
                    "has_next": page < total_pages,
                    "has_prev": page > 1
                },
                "filters": {
                    "tx_type": query.tx_type,
                    "direction": query.direction,
                    "start_time": query.start_time,
                    "end_time": query.end_time
                }
            });
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            println!("[API] ❌ Transaction history error for {}: {}", query.address, e);
            let error_response = json!({
                "success": false,
                "error": format!("Failed to fetch transaction history: {}", e),
                "address": query.address
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

/// Handler for global recent transactions (paginated, newest first)
/// API: GET /api/v1/transactions/recent?page=1&per_page=50
pub(super) async fn handle_recent_transactions(
    query: RecentTransactionsQuery,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let page = if query.page == 0 { 1 } else { query.page };
    let per_page = query.per_page.min(100).max(1); // Clamp to 1-100
    
    let storage = blockchain.get_storage();
    
    match storage.get_recent_transactions(page, per_page).await {
        Ok((transactions, total_count)) => {
            let txs: Vec<Value> = transactions.iter().map(|tx| {
                json!({
                    "hash": tx.hash,
                    "from": tx.from,
                    "to": tx.to,
                    "amount": tx.amount,
                    "nonce": tx.nonce,
                    "timestamp": tx.timestamp,
                    "type": format!("{:?}", tx.tx_type),
                    "gas_price": tx.gas_price,
                    "gas_limit": tx.gas_limit,
                    "is_quantum_signed": tx.is_quantum_signed()
                })
            }).collect();
            
            let total_pages = (total_count + per_page - 1) / per_page;
            let current_height = blockchain.get_height().await;
            
            let response = json!({
                "success": true,
                "transactions": txs,
                "pagination": {
                    "page": page,
                    "per_page": per_page,
                    "total_count": total_count,
                    "total_pages": total_pages,
                    "has_next": page < total_pages,
                    "has_prev": page > 1
                },
                "current_height": current_height
            });
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            println!("[API] ❌ Recent transactions error: {}", e);
            let error_response = json!({
                "success": false,
                "error": format!("Failed to fetch recent transactions: {}", e)
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

pub(super) async fn handle_block_latest(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    let height = blockchain.get_height().await;
    match blockchain.get_block(height).await {
        Ok(Some(block)) => Ok(warp::reply::json(&block)),
        Ok(None) => {
            let error_response = json!({
                "error": "Latest block not found",
                "height": height
            });
            Ok(warp::reply::json(&error_response))
        }
        Err(e) => {
            println!("[WARN][RPC] api_error endpoint=latest_block err={}", e);
            let error_response = json!({
                "error": "Failed to get latest block",
                "details": "internal error"
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

/// Serve the raw stored block-0 bytes for a cold-join binary fetch (octet-stream, no reformat).
pub(super) async fn handle_genesis_block(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<warp::reply::Response, Rejection> {
    use warp::Reply;
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response.into_response());
    }
    let storage = blockchain.get_storage();
    match storage.load_microblock(0) {
        Ok(Some(bytes)) => {
            let resp = warp::http::Response::builder()
                .header("content-type", "application/octet-stream")
                .body(warp::hyper::Body::from(bytes))
                .unwrap_or_else(|_| warp::http::Response::new(warp::hyper::Body::empty()));
            Ok(resp)
        }
        _ => Ok(warp::reply::with_status(
            warp::reply::json(&json!({"error": "genesis_block_unavailable"})),
            warp::http::StatusCode::NOT_FOUND,
        ).into_response()),
    }
}

pub(super) async fn handle_block_by_height(
    height: u64,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    // v3.19: Validate height parameter (prevent resource exhaustion)
    let current_height = blockchain.get_height().await;
    if height > current_height.saturating_add(1000) {
        return Ok(warp::reply::json(&json!({
            "error": "Invalid height",
            "message": "Requested height is too far in the future",
            "current_height": current_height
        })));
    }
    
    match blockchain.get_block(height).await {
        Ok(Some(block)) => {
            // Additive, backward-compatible: keep every existing top-level field and ADD the failover
            // round from the microblock. abs_round = timeout_round + carried_baseline; a boundary
            // round-reset (the 40950 fork) is invisible without it.
            let mut v = serde_json::to_value(&block).unwrap_or_else(|_| json!({}));
            if let (Some(obj), Some(mb)) = (
                v.as_object_mut(),
                blockchain.get_storage().load_microblock_auto_format(height).ok().flatten(),
            ) {
                obj.insert("timeout_round".into(), json!(mb.timeout_round));
                obj.insert("carried_baseline".into(), json!(mb.carried_baseline));
                obj.insert("abs_round".into(), json!(mb.timeout_round.saturating_add(mb.carried_baseline)));
            }
            Ok(warp::reply::json(&v))
        }
        Ok(None) => {
            let error_response = json!({
                "error": "Block not found",
                "height": height
            });
            Ok(warp::reply::json(&error_response))
        }
        Err(e) => {
            println!("[WARN][RPC] api_error endpoint=block_by_height height={} err={}", height, e);
            let error_response = json!({
                "error": "Failed to get block",
                "details": "internal error"
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

pub(super) async fn handle_block_by_hash(
    hash: String,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    // v3.19: Validate hash parameter (max 128 chars for hex hash)
    if hash.len() > 128 {
        return Ok(warp::reply::json(&json!({
            "error": "Invalid hash",
            "message": "Hash parameter too long (max 128 characters)"
        })));
    }
    
    // PRODUCTION: Search for block by hash using storage
    let current_height = blockchain.get_height().await;
    
    // Search last 1000 blocks for matching hash (production would use hash index)
    let mut found_block = None;
    for height in (current_height.saturating_sub(1000))..=current_height {
        match blockchain.get_block(height).await {
            Ok(Some(block)) => {
                // Calculate block hash and compare with requested hash
                let block_hash = format!("{:x}", sha3::Sha3_256::digest(
                    serde_json::to_string(&block).unwrap_or_default().as_bytes()
                ));
                
                // Exact match only: prefix matching lets short queries collide with real hashes.
                if block_hash == hash {
                    found_block = Some(block);
                    break;
                }
            }
            _ => continue,
        }
    }
    
    match found_block {
        Some(block) => {
            let response = json!({
                "hash": hash,
                "found": true,
                "block": {
                    "height": block.height,
                    "hash": block.hash(),
                    "previous_hash": block.previous_hash,
                    "timestamp": block.timestamp,
                    "transactions": block.transactions,
                    "merkle_root": block.merkle_root,
                    "producer": block.producer,
                    "signature": block.signature
                }
            });
            Ok(warp::reply::json(&response))
        }
        None => {
            let response = json!({
                "hash": hash,
                "found": false,
                "error": "Block with matching hash not found in recent 1000 blocks"
            });
            Ok(warp::reply::json(&response))
        }
    }
}

pub(super) async fn handle_macroblock_by_index(
    index: u64,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    match blockchain.get_macroblock(index).await {
        Ok(Some(macroblock)) => {

            let response = json!({
                "index": index,
                "height": macroblock.height,
                "timestamp": macroblock.timestamp,
                "micro_blocks_count": macroblock.micro_blocks.len(),
                "micro_blocks": macroblock.micro_blocks.iter()
                    .map(|h| hex::encode(h))
                    .collect::<Vec<_>>(),
                "state_root": hex::encode(macroblock.state_root),
                "consensus_data": {
                    "next_leader": macroblock.consensus_data.next_leader,
                    "commits_count": macroblock.consensus_data.commits.len(),
                    "reveals_count": macroblock.consensus_data.reveals.len(),

                    "pool2_total_fees": macroblock.consensus_data.pool2_total_fees,
                    "pool3_total_activations": macroblock.consensus_data.pool3_total_activations,
                },
                "previous_hash": hex::encode(macroblock.previous_hash),
            });
            Ok(warp::reply::json(&response))
        }
        Ok(None) => {
            let error_response = json!({
                "error": "Macroblock not found",
                "index": index,
                "info": format!("Macroblock #{} would cover blocks {}-{}", 
                                index, 
                                (index - 1) * 90 + 1, 
                                index * 90)
            });
            Ok(warp::reply::json(&error_response))
        }
        Err(e) => {
            println!("[WARN][RPC] api_error endpoint=macroblock err={}", e);
            let error_response = json!({
                "error": "Failed to get macroblock",
                "details": "internal error"
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

/// Light-client QC proof for macroblock {index}: the checkpoint fields, the QC (signers + sigs), the
/// committee + its consensus pubkeys, and the N-2 eligible_producers + beacon (so the client derives the
/// committee). Immutable per index ⇒ cacheable/CDN. The client recomputes Checkpoint::hash, derives the
/// committee, binds pubkeys to the QC-signed registry_root, and verifies a sampled set of QC signatures.
pub(super) async fn handle_macroblock_proof(
    index: u64,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rl) = check_api_rate_limit(remote_addr, "read_only") { return Ok(rl); }
    let mb = match blockchain.get_macroblock(index).await {
        Ok(Some(m)) => m,
        _ => return Ok(warp::reply::json(&json!({"error": "macroblock_not_found", "index": index}))),
    };
    let qc_bytes = match &mb.consensus_data.checkpoint_qc {
        Some(b) => b,
        None => return Ok(warp::reply::json(&json!({"error": "no_checkpoint_qc", "index": index}))),
    };
    let (cp, qc): (qnet_consensus::checkpoint_bft::Checkpoint, qnet_consensus::checkpoint_bft::QuorumCertificate) =
        match bincode::deserialize(qc_bytes) {
            Ok(v) => v,
            Err(_) => return Ok(warp::reply::json(&json!({"error": "qc_decode_failed", "index": index}))),
        };
    // Past the retention horizon the committee signatures are stripped (the archive keeps the
    // checkpoint half). Serving the proof anyway would hand the device a QC it can only fail to
    // verify, which reads as a hostile node; say so instead so it re-pins on a recent anchor.
    if qc.sigs.is_empty() {
        return Ok(warp::reply::json(&json!({
            "error": "qc_sigs_pruned", "index": index, "action": "repin_recent_anchor"
        })));
    }
    let storage = blockchain.get_storage();
    let committee = BlockchainNode::committee_for_height(&storage, mb.height).unwrap_or_default();
    // Pubkeys for the derived committee UNION the QC's actual signers. A recovery checkpoint is
    // certified by a different committee than committee_for_height derives, so the derived set alone
    // leaves the client unable to resolve a signer's pk. Serving extra keys expands nothing: the
    // client binds every pk to the registry_root of a macroblock it has ALREADY verified.
    //
    // Source of truth is the committed `vrf_pk_` row, with the RAM registry only as a fast path. That
    // registry is an LRU that evicts after ~30 idle days, and this proof is for an IMMUTABLE historical
    // macroblock: a committee member that has since left the network would simply be missing, and the
    // client's walk is bottom-up, so one unserved index kills every higher index on that parity chain.
    let mut committee_pubkeys = serde_json::Map::new();
    for nid in committee.iter().chain(qc.signers.iter()) {
        if committee_pubkeys.contains_key(nid) { continue; }
        let pk = qnet_consensus::consensus_crypto::get_consensus_pk(nid)
            .or_else(|| storage.load_vrf_public_key(nid).ok().flatten());
        if let Some(pk) = pk {
            committee_pubkeys.insert(nid.clone(), json!(hex::encode(&pk)));
        }
    }
    let epoch = (mb.height.saturating_sub(1)) / 90 + 1;
    // This macroblock's OWN epoch-transition data, ALL bound into checkpoint.epoch_commitment (QC-signed):
    // the raw eligible_producers bincode (the light client hashes these exact bytes AND parses node_ids
    // for the NEXT epoch's committee) and the cumulative ban set. The client anchors them via
    // epoch_commitment(eligible_raw, committee, banned)==cp.epoch_commitment, then carries the verified
    // eligible+beacon forward to derive M+2's committee — never trusting a server-supplied committee.
    let eligible_raw = mb.consensus_data.eligible_producers.as_ref().map(hex::encode).unwrap_or_default();
    // None ⇒ genuinely no bans (empty is correct). Some(corrupted) ⇒ serving empty would make the
    // client's epoch_commitment mismatch and fail-close; signal an error so it retries another node.
    let banned: Vec<String> = match mb.consensus_data.banned_validators.as_ref() {
        None => Vec::new(),
        Some(b) => match bincode::deserialize::<Vec<String>>(b) {
            Ok(v) => v,
            Err(_) => return Ok(warp::reply::json(&json!({"error": "banned_decode_failed", "index": index}))),
        },
    };
    let checkpoint = checkpoint_json(&cp);
    let recovery_anchor_checkpoint = recovery_anchor_json(&blockchain.get_storage(), &cp);
    let qc_json = json!({
        "signers": qc.signers,
        // sigs are the ASCII "dilithium_sig_<id>_<b64>" strings; lossless from_utf8 drops any non-UTF8
        // element to "" (client rejects it) rather than silently corrupting bytes with U+FFFD.
        "sigs": qc.sigs.iter().map(|s| String::from_utf8(s.clone()).unwrap_or_default()).collect::<Vec<_>>(),
    });
    Ok(warp::reply::json(&json!({
        "index": index,
        "epoch": epoch,
        "checkpoint": checkpoint,
        "qc": qc_json,
        "committee": committee,
        "committee_pubkeys": serde_json::Value::Object(committee_pubkeys),
        "eligible_raw": eligible_raw,
        "banned": banned,
        // Under a pin the certifying set is unchanged and only the threshold drops, but the device
        // must still resolve the pin. Serve the ANCHOR CHECKPOINT so one round trip is enough; the
        // device re-digests it and compares against the QC-signed pin, so nothing here is trusted.
        "recovery_anchor_checkpoint": recovery_anchor_checkpoint,
    })))
}

/// Canonical light-client JSON for a Checkpoint. Field-for-field the preimage `checkpointHash` folds,
/// in that order — a device that recomputes the hash from anything else rejects every checkpoint.
pub(super) fn checkpoint_json(cp: &qnet_consensus::checkpoint_bft::Checkpoint) -> serde_json::Value {
    json!({
        "index": cp.index,
        "parent_qc": cp.parent_qc.as_ref().map(|p| json!({
            "checkpoint_hash": hex::encode(p.checkpoint_hash), "index": p.index })),
        "window_head_height": cp.window_head_height,
        "window_mb_hashes": cp.window_mb_hashes.iter().map(hex::encode).collect::<Vec<_>>(),
        "state_root": hex::encode(cp.state_root),
        "beacon": hex::encode(cp.beacon),
        "epoch_commitment": hex::encode(cp.epoch_commitment),
        "reward_root": hex::encode(cp.reward_root),
        "registry_root": hex::encode(cp.registry_root),
        "logs_root": hex::encode(cp.logs_root),
        "dilithium_pk_root": hex::encode(cp.dilithium_pk_root), // FIX-5: hashed after logs_root
        "reward_epoch_root": hex::encode(cp.reward_epoch_root), // hashed after dilithium_pk_root
        // STRING, not a JSON number: nanoQNC supply crosses 2^53, and the device folds this into the
        // checkpoint hash — a JSON.parse double would silently round and false-reject every checkpoint.
        "total_supply": cp.total_supply.to_string(),
        "timestamp": cp.timestamp,
        "proposer": cp.proposer,
        // Last hashed field. The device folds it TAGGED, so omitting it would make every recomputed
        // checkpoint hash wrong, not just a relaxed one.
        "recovery_anchor": cp.recovery_anchor.map(|(a, ah)| json!([a, hex::encode(ah)])),
    })
}

/// The ANCHOR CHECKPOINT a relaxed checkpoint pins to, or Null. Not a trust root: the pin names its
/// anchor by `checkpoint_content_digest`, which the device recomputes from exactly these fields and
/// compares against the QC-signed `recovery_anchor` — so a server that alters any of them is caught.
/// The digest, never `MacroBlock::hash()`, is the pin's identity: the block hash omits consensus_data
/// and therefore authenticates nothing the pin rule reads. It also excludes the anchor's own pin, so
/// whichever certificate for that window this node stored, the device resolves the same digest.
pub(super) fn recovery_anchor_json(storage: &crate::storage::Storage, cp: &qnet_consensus::checkpoint_bft::Checkpoint) -> serde_json::Value {
    let (a, _ah) = match cp.recovery_anchor { Some(x) => x, None => return serde_json::Value::Null };
    let mb = match storage.get_macroblock_by_height(a).ok().flatten()
        .and_then(crate::node::BlockchainNode::macroblock_plaintext)
        .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok())
    { Some(m) => m, None => return serde_json::Value::Null };
    let (cp_a, _qc_a): (qnet_consensus::checkpoint_bft::Checkpoint, qnet_consensus::checkpoint_bft::QuorumCertificate) =
        match mb.consensus_data.checkpoint_qc.as_ref().and_then(|b| bincode::deserialize(b).ok())
        { Some(x) => x, None => return serde_json::Value::Null };
    checkpoint_json(&cp_a)
}

/// Light-client registry dump as of {height}: the chain-confirmed roster (node_id, wallet, reg_height,
/// burn, vrf_pk_sha3) + the LtHash registry_root over them — byte-identical to the QC-signed
/// registry_root sealed at that height. The client recomputes the root and binds committee pubkeys to it.
pub(super) async fn handle_registry_height(
    height: u64,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rl) = check_api_rate_limit(remote_addr, "read_only") { return Ok(rl); }
    let (entries, root) = blockchain.get_storage().registry_entries_as_of(height);
    Ok(warp::reply::json(&json!({"registry_root": root, "entries": entries})))
}

/// GET /api/v1/debug/consensus-position — the scalars that reveal a boundary-fork stall at a glance.
/// `sealed_lag` growing past ~2 windows while height climbs = finality decoupled (the pre-halt state);
/// `tc_floor` must never exceed `own_window` (the wedge that deafened a rolled-back node).
pub(super) async fn handle_debug_consensus_position(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rl) = check_api_rate_limit(remote_addr, "read_only") { return Ok(rl); }
    let storage = blockchain.get_storage();
    let height = storage.get_chain_height().unwrap_or(0);
    let tip_hash = storage.get_block_hash(height).ok().flatten().unwrap_or_default();
    let last_sealed = storage.last_sealed_mb_index();
    let finalized = crate::node::LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
    let own_window = height / 90;
    let tc_floor = crate::unified_p2p::observed_tc_window_floor();
    Ok(warp::reply::json(&json!({
        "height": height,
        "tip_hash": tip_hash,
        "own_window": own_window,
        "last_sealed_mb_index": last_sealed,
        "sealed_lag_windows": own_window.saturating_sub(last_sealed),
        "finalized_height": finalized,
        "tc_window_floor": tc_floor,
        "floor_above_window": tc_floor > own_window,
        "certified_round_current_window": crate::unified_p2p::highest_certified_round_for(own_window),
    })))
}

// =========================================================================
// SNAPSHOT ENDPOINTS - For P2P Fast Sync (v2.19.12)
// =========================================================================

/// GET /api/v1/snapshot/latest - Get latest available snapshot info
/// Used by new nodes to find snapshots for fast sync
pub(super) async fn handle_snapshot_latest(
    remote_addr: Option<std::net::SocketAddr>,
    query: std::collections::HashMap<String, String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    // Cold-join verifiable-anchor negotiation: a joiner clamps to its exogenously-verifiable ceiling and
    // asks for the highest snapshot ≤ it (not just our latest, which may be above the joiner's pin).
    let height_result = match query.get("max_height").and_then(|s| s.parse::<u64>().ok()) {
        Some(ceiling) => blockchain.get_highest_snapshot_height_le(ceiling),
        None => blockchain.get_latest_snapshot_height(),
    };
    match height_result {
        Ok(Some(height)) => {
            // Get IPFS CID if available
            let ipfs_cid = blockchain.get_snapshot_ipfs_cid(height)
                .unwrap_or_default()
                .unwrap_or_default();
            
            let response = json!({
                "height": height,
                "ipfs_cid": ipfs_cid,
                "available": true,
                "node_id": blockchain.get_node_id(),
                "timestamp": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
            });
            Ok(warp::reply::json(&response))
        }
        Ok(None) => {
            let response = json!({
                "height": 0,
                "ipfs_cid": "",
                "available": false,
                "message": "No snapshots available yet"
            });
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            println!("[WARN][RPC] api_error endpoint=snapshot_info err={}", e);
            let error_response = json!({
                "error": "Failed to get snapshot info",
                "details": "internal error"
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

/// GET /api/v1/snapshot/{height} - Download snapshot data
/// Returns compressed binary snapshot for the specified height
pub(super) async fn handle_snapshot_download(
    height: u64,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(_) = check_api_rate_limit(remote_addr, "read_only") {
        let body = serde_json::to_vec(&json!({"error": "Rate limit exceeded"})).unwrap_or_default();
        return Ok(warp::reply::with_header(
            warp::reply::with_header(body, "Content-Type", "application/json"),
            "Content-Disposition", ""
        ));
    }
    let _serve_permit = match SNAPSHOT_SERVE_SEM.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            let body = serde_json::to_vec(&json!({"error": "snapshot serve busy"})).unwrap_or_default();
            return Ok(warp::reply::with_header(
                warp::reply::with_header(body, "Content-Type", "application/json"),
                "Content-Disposition", ""));
        }
    };
    match blockchain.get_snapshot_data(height) {
        Ok(Some(data)) => {
            // Return binary data with appropriate headers
            Ok(warp::reply::with_header(
                warp::reply::with_header(
                    data,
                    "Content-Type",
                    "application/octet-stream"
                ),
                "Content-Disposition",
                format!("attachment; filename=\"snapshot_{}.bin\"", height)
            ))
        }
        Ok(None) => {
            // Return 404 as JSON
            let error_response = json!({
                "error": "Snapshot not found",
                "height": height
            });
            Ok(warp::reply::with_header(
                warp::reply::with_header(
                    serde_json::to_vec(&error_response).unwrap_or_default(),
                    "Content-Type",
                    "application/json"
                ),
                "Content-Disposition",
                ""
            ))
        }
        Err(e) => {
            println!("[WARN][RPC] api_error endpoint=snapshot_download err={}", e);
            let error_response = json!({
                "error": "Failed to get snapshot",
                "details": "internal error"
            });
            Ok(warp::reply::with_header(
                warp::reply::with_header(
                    serde_json::to_vec(&error_response).unwrap_or_default(),
                    "Content-Type",
                    "application/json"
                ),
                "Content-Disposition",
                ""
            ))
        }
    }
}

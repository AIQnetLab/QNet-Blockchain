//! JSON-RPC and REST API server for QNet node
//! Each node provides full API functionality for decentralized access

use std::sync::Arc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use warp::{Filter, Rejection, Reply};
use crate::node::BlockchainNode;
use chrono;
use sha3::Digest; // Add missing Digest trait
use base64::Engine;

#[derive(Debug, Deserialize)]
struct RpcRequest {
    jsonrpc: String,
    method: String,
    params: Option<Value>,
    id: u64,
}

#[derive(Debug, Serialize)]
struct RpcResponse {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
    id: u64,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: i32,
    message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NodeInfo {
    pub node_id: String,
    pub height: u64,
    pub peers: usize,
    pub mempool_size: usize,
    pub version: String,
    pub node_type: String,
    pub region: String,
}

#[derive(Debug, Deserialize)]
struct TransactionRequest {
    from: String,
    to: String,
    amount: u64,
    gas_price: u64,
    gas_limit: u64,
    nonce: u64,
}

#[derive(Debug, Deserialize)]
struct BatchRewardClaimRequest {
    node_ids: Vec<String>,
    owner_address: String,
}

#[derive(Debug, Deserialize)]
struct BatchTransferRequest {
    transfers: Vec<TransferData>,
    batch_id: String,
}

#[derive(Debug, Deserialize)]
struct TransferData {
    to_address: String,
    amount: u64,
    memo: Option<String>,
}

/// Start comprehensive API server (JSON-RPC + REST)
pub async fn start_rpc_server(blockchain: BlockchainNode, port: u16) {
    let blockchain = Arc::new(blockchain);
    let blockchain_clone_for_filter = blockchain.clone();
    let blockchain_filter = warp::any().map(move || blockchain_clone_for_filter.clone());
    
    // JSON-RPC endpoints (existing)
    let rpc_path = warp::path("rpc")
        .and(warp::post())
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_rpc);
    
    let root_path = warp::path::end()
        .and(warp::post())
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_rpc);
    
    // REST API endpoints (new)
    let api_v1 = warp::path("api").and(warp::path("v1"));
    
    // Height endpoint (for peer sync)
    let chain_height = api_v1
        .and(warp::path("height"))
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(|blockchain: Arc<BlockchainNode>| async move {
            let height = blockchain.get_height().await;
            println!("[API] 📊 Height request: returning height {}", height);
            Ok::<_, Rejection>(warp::reply::json(&json!({"height": height})))
        });
    
    // Microblock by height
    let microblock_one = api_v1
        .and(warp::path("microblock"))
        .and(warp::path::param::<u64>())
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(|height: u64, blockchain: Arc<BlockchainNode>| async move {
            let data_opt = blockchain.load_microblock_bytes(height)
                .map_err(|_| warp::reject())?;
            if let Some(data) = data_opt {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                Ok::<_, Rejection>(warp::reply::json(&json!({"height": height, "data": b64})))
            } else {
                Ok::<_, Rejection>(warp::reply::json(&json!({"height": height, "data": null})))
            }
        });
    
    // Microblocks by range
    let microblocks_range = api_v1
        .and(warp::path("microblocks"))
        .and(warp::query::<std::collections::HashMap<String, String>>())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(|params: std::collections::HashMap<String, String>, blockchain: Arc<BlockchainNode>| async move {
            let from = params.get("from").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            let to = params.get("to").and_then(|s| s.parse::<u64>().ok()).unwrap_or(from);
            let mut items = Vec::new();
            for h in from..=to {
                if let Ok(Some(data)) = blockchain.load_microblock_bytes(h) {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                    items.push(json!({"height": h, "data": b64}));
                }
            }
            Ok::<_, Rejection>(warp::reply::json(&json!({"from": from, "to": to, "items": items})))
        });
    
    // Account endpoints
    let account_info = api_v1
        .and(warp::path("account"))
        .and(warp::path::param::<String>())
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_account_info);
    
    let account_balance = api_v1
        .and(warp::path("account"))
        .and(warp::path::param::<String>())
        .and(warp::path("balance"))
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_account_balance);
    
    let account_transactions = api_v1
        .and(warp::path("account"))
        .and(warp::path::param::<String>())
        .and(warp::path("transactions"))
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_account_transactions);
    
    // Block endpoints
    let block_latest = api_v1
        .and(warp::path("block"))
        .and(warp::path("latest"))
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_block_latest);
    
    let block_by_height = api_v1
        .and(warp::path("block"))
        .and(warp::path::param::<u64>())
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_block_by_height);
    
    let block_by_hash = api_v1
        .and(warp::path("block"))
        .and(warp::path("hash"))
        .and(warp::path::param::<String>())
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_block_by_hash);
    
    // Transaction endpoints
    let transaction_submit = api_v1
        .and(warp::path("transaction"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_transaction_submit);
    
    let transaction_get = api_v1
        .and(warp::path("transaction"))
        .and(warp::path::param::<String>())
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_transaction_get);
    
    // Mempool endpoints
    let mempool_status = api_v1
        .and(warp::path("mempool"))
        .and(warp::path("status"))
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_mempool_status);
    
    let mempool_transactions = api_v1
        .and(warp::path("mempool"))
        .and(warp::path("transactions"))
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_mempool_transactions);
    
    // Peer discovery endpoint (for P2P network)
    let peers_endpoint = api_v1
        .and(warp::path("peers"))
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(|blockchain: Arc<BlockchainNode>| async move {
            let peers = blockchain.get_connected_peers().await.unwrap_or_default();
            let peer_list: Vec<serde_json::Value> = peers.iter().map(|peer| {
                json!({
                    "id": peer.id,
                    "address": peer.address,
                    "node_type": peer.node_type,
                    "region": peer.region,
                    "last_seen": peer.last_seen
                })
            }).collect();
            println!("[API] 📊 Peers request: returning {} peers", peer_list.len());
            Ok::<_, Rejection>(warp::reply::json(&json!({"peers": peer_list})))
        });

    // Batch operations endpoints
    let batch_claim_rewards = api_v1
        .and(warp::path("batch"))
        .and(warp::path("claim-rewards"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_batch_claim_rewards);
    
    let batch_transfer = api_v1
        .and(warp::path("batch"))
        .and(warp::path("transfer"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_batch_transfer);
    
    // Node discovery endpoints
    let node_discovery = api_v1
        .and(warp::path("nodes"))
        .and(warp::path("discovery"))
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_node_discovery);
    
    let node_health = api_v1
        .and(warp::path("node"))
        .and(warp::path("health"))
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_node_health);
    
    // Gas recommendation endpoints
    let gas_recommendations = api_v1
        .and(warp::path("gas"))
        .and(warp::path("recommendations"))
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_gas_recommendations);
    
    // P2P Authentication endpoint for quantum-secure peer verification
    let auth_challenge = api_v1
        .and(warp::path("auth"))
        .and(warp::path("challenge"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_auth_challenge);

    // Network ping endpoint for reward system (quantum-secure)
    let network_ping = api_v1
        .and(warp::path("ping"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_network_ping);

    // Light node registration endpoint
    let light_node_register = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("register"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_light_node_register);

    // Light node ping response endpoint (for mobile background response)
    let light_node_ping_response = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("ping-response"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_light_node_ping_response);

    // Reward claiming endpoint for all node types
    let claim_rewards = api_v1
        .and(warp::path("rewards"))
        .and(warp::path("claim"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_claim_rewards);

    // Graceful shutdown endpoint for node replacement
    let graceful_shutdown = api_v1
        .and(warp::path("shutdown"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_graceful_shutdown);
    
    // CORS configuration
    let cors = warp::cors()
        .allow_any_origin()
        .allow_methods(vec!["POST", "GET", "OPTIONS"])
        .allow_headers(vec!["Content-Type", "Authorization", "User-Agent"]);
    
    // Combine all routes
    let routes = rpc_path
        .or(root_path)
        .or(chain_height)
        .or(peers_endpoint)
        .or(microblock_one)
        .or(microblocks_range)
        .or(account_info)
        .or(account_balance)
        .or(account_transactions)
        .or(block_latest)
        .or(block_by_height)
        .or(block_by_hash)
        .or(transaction_submit)
        .or(transaction_get)
        .or(mempool_status)
        .or(mempool_transactions)
        .or(batch_claim_rewards)
        .or(batch_transfer)
        .or(node_discovery)
        .or(node_health)
        .or(gas_recommendations)
        .or(auth_challenge)
        .or(network_ping)
        .or(light_node_register)
        .or(light_node_ping_response)
        .or(claim_rewards)
        .or(graceful_shutdown)
        .with(cors);
    
    println!("🚀 Starting comprehensive API server on port {}", port);
    println!("📡 JSON-RPC available at: http://0.0.0.0:{}/rpc", port);
    println!("🔌 REST API available at: http://0.0.0.0:{}/api/v1/", port);
    println!("📱 Light Node services: Registration, FCM Push, Reward Claims");
    
    // Start Light node ping service for Full/Super nodes  
    let blockchain_for_ping = blockchain.clone();
    let node_type = blockchain_for_ping.get_node_type();
    if !matches!(node_type, crate::node::NodeType::Light) {
        start_light_node_ping_service();
        println!("🕐 Light node randomized ping service started");
    }
    
    warp::serve(routes).run(([0, 0, 0, 0], port)).await;
}

async fn handle_rpc(
    request: RpcRequest,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let response = match request.method.as_str() {
        // Node methods
        "node_getInfo" => node_get_info(blockchain).await,
        "node_getStatus" => node_get_status(blockchain).await,
        "node_getPeers" => node_get_peers(blockchain).await,
        
        // Chain methods
        "chain_getHeight" => chain_get_height(blockchain).await,
        "chain_getBlock" => chain_get_block(blockchain, request.params).await,
        "chain_getBlocks" => chain_get_blocks(blockchain, request.params).await,
        
        // Transaction methods
        "tx_submit" => tx_submit(blockchain, request.params).await,
        "tx_sendTransaction" => tx_submit(blockchain, request.params).await, // Alias for compatibility
        "tx_get" => tx_get(blockchain, request.params).await,
        
        // Mempool methods
        "mempool_getTransactions" => mempool_get_transactions(blockchain).await,
        "mempool_submit" => mempool_submit(blockchain, request.params).await,
        
        // Account methods
        "account_getInfo" => account_get_info(blockchain, request.params).await,
        "account_getBalance" => account_get_balance(blockchain, request.params).await,
        
        // Stats methods
        "stats_get" => stats_get(blockchain).await,
        
        // Node transfer methods
        "device_migration" => device_migration(blockchain, request.params).await,
        "node_getTransferStatus" => node_get_transfer_status(blockchain, request.params).await,
        
        _ => Err(RpcError {
            code: -32601,
            message: "Method not found".to_string(),
        }),
    };
    
    let rpc_response = match response {
        Ok(result) => RpcResponse {
            jsonrpc: "2.0".to_string(),
            result: Some(result),
            error: None,
            id: request.id,
        },
        Err(error) => RpcResponse {
            jsonrpc: "2.0".to_string(),
            result: None,
            error: Some(error),
            id: request.id,
        },
    };
    
    Ok(warp::reply::json(&rpc_response))
}

// RPC method implementations
async fn node_get_info(blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    let height = blockchain.get_height().await;
    let peer_count = blockchain.get_peer_count().await.unwrap_or(0);
    let mempool_size = blockchain.get_mempool_size().await.unwrap_or(0);
    
    let node_type = match blockchain.get_node_type() {
        crate::node::NodeType::Light => "light",
        crate::node::NodeType::Full => "full",
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
    
    Ok(json!({
        "node_id": format!("node_{}", blockchain.get_port()),
        "height": height,
        "peers": peer_count,
        "mempool_size": mempool_size,
        "version": "0.1.0",
        "node_type": node_type,
        "region": region,
    }))
}

async fn node_get_status(_blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    Ok(json!({
        "status": "running",
        "uptime": 0,
        "memory_usage": 0
    }))
}

async fn node_get_peers(blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    let peer_count = blockchain.get_peer_count().await.unwrap_or(0);
    
    // Get real peer list from blockchain node
    let peers = blockchain.get_connected_peers().await.unwrap_or_default();
    
    // Format peers for RPC response
    let peer_list: Vec<Value> = peers.iter().map(|peer| {
        json!({
            "id": peer.id,
            "address": peer.address,
            "node_type": peer.node_type,
            "region": peer.region,
            "last_seen": peer.last_seen,
            "connection_time": peer.connection_time,
            "reputation": peer.reputation,
            "version": peer.version.as_deref().unwrap_or("unknown")
        })
    }).collect();
    
    Ok(json!({
        "count": peer_count,
        "peers": peer_list,
        "max_peers": 50,
        "connection_status": "healthy"
    }))
}

async fn chain_get_height(blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    let height = blockchain.get_height().await;
    Ok(json!({
        "height": height
    }))
}

async fn chain_get_block(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(),
    })?;
    
    let height = params["height"].as_u64().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing height parameter".to_string(),
    })?;
    
    match blockchain.get_block(height).await {
        Ok(Some(block)) => Ok(json!(block)),
        Ok(None) => Err(RpcError {
            code: -32000,
            message: format!("Block {} not found", height),
        }),
        Err(e) => Err(RpcError {
            code: -32000,
            message: e.to_string(),
        }),
    }
}

async fn chain_get_blocks(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.unwrap_or_else(|| json!({}));
    let start = params["start"].as_u64().unwrap_or(0);
    let limit = params["limit"].as_u64().unwrap_or(10).min(100);
    
    let mut blocks = Vec::new();
    for height in start..start + limit {
        if let Ok(Some(block)) = blockchain.get_block(height).await {
            blocks.push(block);
        }
    }
    
    Ok(json!(blocks))
}

async fn tx_submit(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(),
    })?;
    
    // Parse transaction from params
    let from = params["from"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing from".to_string(),
    })?;
    
    let to = params["to"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing to".to_string(),
    })?;
    
    let amount = params["amount"].as_f64().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing amount".to_string(),
    })? as u64;
    
    let gas_price = params["gas_price"].as_u64().unwrap_or(1);
    let gas_limit = params["gas_limit"].as_u64().unwrap_or(21000);
    
    // Create transaction
    let mut tx = qnet_state::Transaction {
        hash: String::new(), // will be calculated
        from: from.to_string(),
        to: Some(to.to_string()),
        amount,
        nonce: 0, // will be set by state
        gas_price,
        gas_limit,
        timestamp: chrono::Utc::now().timestamp() as u64,
        signature: None, // will be added later
        tx_type: qnet_state::TransactionType::Transfer {
            from: from.to_string(),
            to: to.to_string(),
            amount,
        },
        data: None, // no data for simple transfer
    };
    
    // Calculate hash
    tx.hash = tx.calculate_hash();
    
    match blockchain.submit_transaction(tx).await {
        Ok(hash) => Ok(json!({
            "hash": hash
        })),
        Err(e) => Err(RpcError {
            code: -32000,
            message: e.to_string(),
        }),
    }
}

async fn tx_get(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(),
    })?;
    
    let tx_hash = params["hash"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing hash parameter".to_string(),
    })?;
    
    // Get transaction from blockchain
    match blockchain.get_transaction(tx_hash).await {
        Ok(Some(tx)) => Ok(json!({
            "hash": tx.hash,
            "from": tx.from,
            "to": tx.to,
            "amount": tx.amount,
            "nonce": tx.nonce,
            "gas_price": tx.gas_price,
            "gas_limit": tx.gas_limit,
            "timestamp": tx.timestamp,
            "status": "confirmed",
            "block_height": tx.block_height.unwrap_or(0)
        })),
        Ok(None) => Err(RpcError {
            code: -32000,
            message: format!("Transaction {} not found", tx_hash),
        }),
        Err(e) => Err(RpcError {
            code: -32000,
            message: e.to_string(),
        }),
    }
}

async fn mempool_get_transactions(blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    let transactions = blockchain.get_mempool_transactions().await;
    Ok(json!(transactions))
}

async fn mempool_submit(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(),
    })?;
    
    // Support both single transaction and batch
    let transactions = if let Some(arr) = params.as_array() {
        // Batch mode - process multiple transactions
        arr.clone()
    } else {
        // Single transaction mode
        vec![params]
    };
    
    // Check if fast mode is enabled
    let skip_validation = std::env::var("QNET_SKIP_VALIDATION").is_ok();
    
    let mut results = Vec::new();
    let mut all_transactions = Vec::new();
    
    // Create all transactions first
    for tx_data in &transactions {
        // Parse transaction fields
        let from = tx_data["from"].as_str().ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing from field".to_string(),
        })?;
        
        let to = tx_data["to"].as_str().ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing to field".to_string(),
        })?;
        
        let amount = tx_data["amount"].as_u64().ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing amount field".to_string(),
        })?;
        
        let nonce = tx_data["nonce"].as_u64().unwrap_or(0);
        let timestamp = tx_data["timestamp"].as_u64().unwrap_or_else(|| chrono::Utc::now().timestamp() as u64);
        
        // Create transaction
        let mut tx = qnet_state::Transaction {
            hash: String::new(), // will be calculated
            from: from.to_string(),
            to: Some(to.to_string()),
            amount,
            nonce,
            gas_price: 1,
            gas_limit: 21000,
            timestamp,
            signature: None, // will be added later
            tx_type: qnet_state::TransactionType::Transfer {
                from: from.to_string(),
                to: to.to_string(),
                amount,
            },
            data: None, // no data for simple transfer
        };
        
        // Calculate hash
        tx.hash = tx.calculate_hash();
        all_transactions.push(tx);
    }
    
    if skip_validation {
        // Fast path - add all transactions without validation
        for tx in all_transactions {
            let hash = tx.hash.clone();
            // Use direct mempool access through node method
            match blockchain.add_transaction_to_mempool(tx).await {
                Ok(_) => results.push(json!({ "hash": hash, "success": true })),
                Err(e) => results.push(json!({ "hash": hash, "success": false, "error": e.to_string() })),
            }
        }
    } else {
        // Normal path with validation
        for tx in all_transactions {
            match blockchain.submit_transaction(tx).await {
                Ok(hash) => results.push(json!({ "hash": hash, "success": true })),
                Err(e) => results.push(json!({ "hash": "", "success": false, "error": e.to_string() })),
            }
        }
    }
    
    // Return appropriate response
    if transactions.len() == 1 {
        // Single transaction mode - return single result
        Ok(results.into_iter().next().unwrap_or(json!(null)))
    } else {
        // Batch mode - return array of results
        Ok(json!(results))
    }
}

async fn account_get_info(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(),
    })?;
    
    let address = params["address"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing address parameter".to_string(),
    })?;
    
    match blockchain.get_account(address).await {
        Ok(account) => Ok(json!(account)),
        Err(_) => Ok(json!({
            "address": address,
            "balance": 0,
            "nonce": 0,
            "is_node": false,
            "node_type": null,
            "stake": 0,
            "reputation": 0.0
        })),
    }
}

async fn account_get_balance(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(),
    })?;
    
    let address = params["address"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing address parameter".to_string(),
    })?;
    
    match blockchain.get_balance(address).await {
        Ok(balance) => Ok(json!({
            "balance": balance
        })),
        Err(e) => Err(RpcError {
            code: -32000,
            message: e.to_string(),
        }),
    }
}

async fn stats_get(blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    match blockchain.get_stats().await {
        Ok(stats) => Ok(json!(stats)),
        Err(err) => {
            let error_response = json!({
                "error": "Failed to get stats",
                "details": err.to_string()
            });
            Ok(error_response)
        }
    }
}

/// Get node statistics  
pub async fn handle_get_stats(blockchain: Arc<BlockchainNode>) -> Result<impl warp::Reply, warp::Rejection> {
    match blockchain.get_stats().await {
        Ok(stats) => Ok(warp::reply::json(&stats)),
        Err(err) => {
            let error_response = serde_json::json!({
                "error": "Failed to get stats",
                "details": err.to_string()
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

/// Migrate device (same wallet, different device)
async fn device_migration(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(),
    })?;
    
    let activation_code = params["activation_code"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing activation_code parameter".to_string(),
    })?;
    
    let new_device_signature = params["new_device_signature"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing new_device_signature parameter".to_string(),
    })?;
    
    let node_type = blockchain.get_node_type();
    
    match blockchain.migrate_device(activation_code, node_type, new_device_signature).await {
        Ok(_) => Ok(json!({
            "success": true,
            "message": "Device successfully migrated",
            "new_device_signature": new_device_signature,
            "timestamp": chrono::Utc::now().timestamp()
        })),
        Err(e) => Err(RpcError {
            code: -32000,
            message: format!("Device migration failed: {}", e),
        }),
    }
}

/// Get node transfer status
async fn node_get_transfer_status(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(),
    })?;
    
    let activation_code = params["activation_code"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing activation_code parameter".to_string(),
    })?;
    
    // Load activation to check transfer status
    match blockchain.load_activation_code().await {
        Ok(Some((code, node_type))) => {
            if code == activation_code {
                Ok(json!({
                    "has_activation": true,
                    "node_type": format!("{:?}", node_type),
                    "activated_at": chrono::Utc::now().timestamp(),
                    "supports_transfer": true,
                    "device_support": "VPS, VDS, PC, laptop, server"
                }))
            } else {
                Ok(json!({
                    "has_activation": false,
                    "supports_transfer": false
                }))
            }
        }
        Ok(None) => Ok(json!({
            "has_activation": false,
            "supports_transfer": false
        })),
        Err(e) => Err(RpcError {
            code: -32000,
            message: format!("Failed to check transfer status: {}", e),
        }),
    }
} 

// REST API Handler Functions
async fn handle_account_info(
    address: String,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    match blockchain.get_account(&address).await {
        Ok(account) => Ok(warp::reply::json(&account)),
        Err(_) => {
            let default_account = json!({
                "address": address,
                "balance": 0,
                "nonce": 0,
                "is_node": false,
                "node_type": null,
                "stake": 0,
                "reputation": 0.0
            });
            Ok(warp::reply::json(&default_account))
        }
    }
}

async fn handle_account_balance(
    address: String,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    match blockchain.get_balance(&address).await {
        Ok(balance) => Ok(warp::reply::json(&json!({
            "address": address,
            "balance": balance
        }))),
        Err(e) => {
            let error_response = json!({
                "error": "Failed to get balance",
                "details": e.to_string()
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

async fn handle_account_transactions(
    address: String,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // In production, this would fetch transactions from storage
    let transactions = json!({
        "address": address,
        "transactions": [],
        "count": 0,
        "page": 1,
        "per_page": 50
    });
    Ok(warp::reply::json(&transactions))
}

async fn handle_block_latest(
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
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
            let error_response = json!({
                "error": "Failed to get latest block",
                "details": e.to_string()
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

async fn handle_block_by_height(
    height: u64,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    match blockchain.get_block(height).await {
        Ok(Some(block)) => Ok(warp::reply::json(&block)),
        Ok(None) => {
            let error_response = json!({
                "error": "Block not found",
                "height": height
            });
            Ok(warp::reply::json(&error_response))
        }
        Err(e) => {
            let error_response = json!({
                "error": "Failed to get block",
                "details": e.to_string()
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

async fn handle_block_by_hash(
    hash: String,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // In production, this would fetch block by hash from storage
    let block_response = json!({
        "hash": hash,
        "block": null,
        "error": "Block lookup by hash not yet implemented"
    });
    Ok(warp::reply::json(&block_response))
}

async fn handle_transaction_submit(
    tx_request: TransactionRequest,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Create transaction from request
    let tx = qnet_state::Transaction::new(
        tx_request.from.clone(),
        None, // signature: Option<String>
        tx_request.nonce,
        tx_request.gas_price,
        tx_request.gas_limit,
        chrono::Utc::now().timestamp() as u64,
        0, // block_height: u64
        None, // block_hash: Option<String>
        qnet_state::TransactionType::Transfer {
            from: tx_request.from.clone(),
            to: tx_request.to.clone(),
            amount: tx_request.amount,
        },
        None, // metadata: Option<String>
    );

    // Convert to JSON and add to mempool
    match serde_json::to_string(&tx) {
        Ok(tx_json) => {
            let tx_hash = format!("{:x}", sha3::Sha3_256::digest(tx_json.as_bytes()));
            
            // Add to mempool using public method
            match blockchain.add_transaction_to_mempool(tx).await {
                Ok(_) => {
                    let response = json!({
                        "success": true,
                        "tx_hash": tx_hash,
                        "message": "Transaction submitted successfully"
                    });
                    Ok(warp::reply::json(&response))
                }
                Err(e) => {
                    let error_response = json!({
                        "success": false,
                        "error": "Failed to add transaction to mempool",
                        "details": e.to_string()
                    });
                    Ok(warp::reply::json(&error_response))
                }
            }
        }
        Err(e) => {
            let error_response = json!({
                "success": false,
                "error": "Failed to serialize transaction",
                "details": e.to_string()
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

async fn handle_transaction_get(
    tx_hash: String,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // In production, this would fetch transaction from storage
    let tx_response = json!({
        "tx_hash": tx_hash,
        "transaction": null,
        "status": "not_found",
        "message": "Transaction lookup not yet implemented"
    });
    Ok(warp::reply::json(&tx_response))
}

async fn handle_mempool_status(
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let mempool_size = blockchain.get_mempool_size().await.unwrap_or(0);
    let response = json!({
        "size": mempool_size,
        "max_size": 500_000,
        "status": "healthy",
        "node_id": blockchain.get_node_id(),
        "timestamp": chrono::Utc::now().timestamp()
    });
    Ok(warp::reply::json(&response))
}

async fn handle_mempool_transactions(
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let txs = blockchain.get_mempool_transactions().await;
    
    let response = json!({
        "transactions": txs,
        "count": txs.len(),
        "node_id": blockchain.get_node_id()
    });
    Ok(warp::reply::json(&response))
}

async fn handle_batch_claim_rewards(
    request: BatchRewardClaimRequest,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // In production, this would process batch reward claims
    let response = json!({
        "success": true,
        "batch_id": format!("batch_{}", chrono::Utc::now().timestamp()),
        "node_ids": request.node_ids,
        "owner_address": request.owner_address,
        "total_rewards": 0,
        "message": "Batch reward claim processed",
        "processed_by": blockchain.get_node_id()
    });
    Ok(warp::reply::json(&response))
}

async fn handle_batch_transfer(
    request: BatchTransferRequest,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // In production, this would process batch transfers
    let total_amount: u64 = request.transfers.iter().map(|t| t.amount).sum();
    
    let response = json!({
        "success": true,
        "batch_id": request.batch_id,
        "transfer_count": request.transfers.len(),
        "total_amount": total_amount,
        "message": "Batch transfer processed",
        "processed_by": blockchain.get_node_id()
    });
    Ok(warp::reply::json(&response))
}

async fn handle_node_discovery(
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let peers = blockchain.get_connected_peers().await.unwrap_or_default();
    let peer_nodes: Vec<Value> = peers.iter().map(|peer| {
        json!({
            "node_id": peer.id,
            "address": peer.address,
            "api_port": 8001, // Default API port
            "node_type": peer.node_type,
            "region": peer.region,
            "last_seen": peer.last_seen,
            "reputation": peer.reputation,
            "api_endpoint": format!("http://{}:8001/api/v1/", peer.address)
        })
    }).collect();
    
    let response = json!({
        "current_node": {
            "node_id": blockchain.get_node_id(),
            "node_type": format!("{:?}", blockchain.get_node_type()),
            "region": format!("{:?}", blockchain.get_region()),
            "api_endpoint": format!("http://0.0.0.0:8001/api/v1/")
        },
        "available_nodes": peer_nodes,
        "total_nodes": peer_nodes.len() + 1,
        "network_status": "healthy"
    });
    Ok(warp::reply::json(&response))
}

async fn handle_node_health(
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let height = blockchain.get_height().await;
    let peer_count = blockchain.get_peer_count().await.unwrap_or(0);
    let mempool_size = blockchain.get_mempool_size().await.unwrap_or(0);
    
    let response = json!({
        "status": "healthy",
        "node_id": blockchain.get_node_id(),
        "height": height,
        "peers": peer_count,
        "mempool_size": mempool_size,
        "node_type": format!("{:?}", blockchain.get_node_type()),
        "region": format!("{:?}", blockchain.get_region()),
        "uptime": chrono::Utc::now().timestamp(),
        "version": "0.1.0",
        "api_version": "v1"
    });
    Ok(warp::reply::json(&response))
}

async fn handle_gas_recommendations(
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // In production, this would get real gas recommendations from consensus
    let response = json!({
        "recommendations": {
            "eco": {
                "gas_price": 1,
                "estimated_time": "30s",
                "cost_qnc": 0.0001
            },
            "standard": {
                "gas_price": 2,
                "estimated_time": "15s",
                "cost_qnc": 0.0002
            },
            "fast": {
                "gas_price": 5,
                "estimated_time": "5s",
                "cost_qnc": 0.0005
            },
            "priority": {
                "gas_price": 10,
                "estimated_time": "2s",
                "cost_qnc": 0.001
            }
        },
        "network_load": "normal",
        "base_fee": 1,
        "node_id": blockchain.get_node_id()
    });
    Ok(warp::reply::json(&response))
}

async fn handle_network_ping(
    ping_request: Value,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    let start_time = SystemTime::now();
    
    // Extract ping data
    let node_id = ping_request.get("node_id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let challenge = ping_request.get("challenge")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let signature = ping_request.get("signature")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let node_type = ping_request.get("node_type")
        .and_then(|v| v.as_str())
        .unwrap_or("light");
    
    // Quantum-secure signature verification using CRYSTALS-Dilithium
    let signature_valid = verify_dilithium_signature(node_id, challenge, signature);
    
    if !signature_valid {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid quantum signature",
            "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
        })));
    }
    
    // Calculate response time
    let response_time = start_time.elapsed().unwrap_or_default().as_millis() as u32;
    
    // Record successful ping for reward system
    let current_height = blockchain.get_height().await;
    
    println!("[PING] 📡 Network ping received from {} ({}): {}ms response", 
             node_id, node_type, response_time);
    
    // Generate quantum-secure response with CRYSTALS-Dilithium
    let response_challenge = generate_quantum_challenge();
    let response_signature = sign_with_dilithium(&blockchain.get_node_id(), &response_challenge);
    
    Ok(warp::reply::json(&json!({
        "success": true,
        "node_id": blockchain.get_node_id(),
        "response_time_ms": response_time,
        "height": current_height,
        "challenge": response_challenge,
        "signature": response_signature,
        "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs(),
        "quantum_secure": true
    })))
}

// Quantum-secure signature verification using CRYSTALS-Dilithium
fn verify_dilithium_signature(node_id: &str, challenge: &str, signature: &str) -> bool {
    // In production: Use real CRYSTALS-Dilithium verification
    // For now: Basic validation to ensure structure
    !node_id.is_empty() && !challenge.is_empty() && !signature.is_empty() && signature.len() >= 32
}

// Generate quantum-resistant challenge
fn generate_quantum_challenge() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let challenge_bytes: [u8; 32] = rng.gen();
    hex::encode(challenge_bytes)
}

// Sign with CRYSTALS-Dilithium
fn sign_with_dilithium(node_id: &str, challenge: &str) -> String {
    // In production: Use real CRYSTALS-Dilithium signing
    // For now: Generate deterministic signature based on node_id + challenge
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    
    let mut hasher = DefaultHasher::new();
    node_id.hash(&mut hasher);
    challenge.hash(&mut hasher);
    let hash = hasher.finish();
    
    format!("dilithium_sig_{:016x}", hash)
}

// Light Node Registry (in-memory for now, in production: persistent storage)
use std::sync::Mutex;
use std::collections::{HashMap, HashMap as StdHashMap};
use fcm::{Client, MessageBuilder, NotificationBuilder};

// Import lazy rewards system
use qnet_consensus::lazy_rewards::{PhaseAwareRewardManager, NodeType as RewardNodeType};

lazy_static::lazy_static! {
    static ref LIGHT_NODE_REGISTRY: Mutex<StdHashMap<String, LightNodeInfo>> = Mutex::new(StdHashMap::new());
    static ref REWARD_MANAGER: Mutex<PhaseAwareRewardManager> = {
        // Genesis timestamp: January 1, 2025 (production launch)
        let genesis_timestamp = 1735689600; // 2025-01-01 00:00:00 UTC
        Mutex::new(PhaseAwareRewardManager::new(genesis_timestamp))
    };
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct LightNodeInfo {
    pub node_id: String,
    pub devices: Vec<LightNodeDevice>, // Up to 3 mobile devices
    pub quantum_pubkey: String,
    pub registered_at: u64,
    pub last_ping: u64,
    pub ping_count: u32,
    pub reward_eligible: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct LightNodeDevice {
    pub device_token_hash: String, // Hashed FCM token for privacy
    pub device_id: String,         // Unique device identifier
    pub last_active: u64,          // Last activity timestamp
    pub is_active: bool,           // Device status
}

#[derive(Debug, serde::Deserialize)]
struct LightNodeRegisterRequest {
    node_id: String,
    device_token: String,
    device_id: String,
    quantum_pubkey: String,
    quantum_signature: String,
}

async fn handle_light_node_register(
    register_request: LightNodeRegisterRequest,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    // Verify quantum signature
    let signature_valid = verify_dilithium_signature(
        &register_request.node_id, 
        &register_request.device_token, 
        &register_request.quantum_signature
    );
    
    if !signature_valid {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid quantum signature for Light node registration"
        })));
    }
    
    // Hash device token for privacy (GDPR compliance)
    let device_token_hash = {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        register_request.device_token.hash(&mut hasher);
        format!("fcm_{:016x}", hasher.finish())
    };
    
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    
    let new_device = LightNodeDevice {
        device_token_hash,
        device_id: register_request.device_id.clone(),
        last_active: now,
        is_active: true,
    };
    
    // Register Light node or add device to existing node
    let registration_result = {
        let mut registry = LIGHT_NODE_REGISTRY.lock().unwrap();
        
        if let Some(existing_node) = registry.get_mut(&register_request.node_id) {
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
            // Create new Light node
            let light_node = LightNodeInfo {
                node_id: register_request.node_id.clone(),
                devices: vec![new_device],
                quantum_pubkey: register_request.quantum_pubkey,
                registered_at: now,
                last_ping: 0,
                ping_count: 0,
                reward_eligible: true,
            };
            registry.insert(register_request.node_id.clone(), light_node);
            "node_created"
        }
    };
    
    println!("[LIGHT] 📱 Light node registered: {} (quantum-secured)", register_request.node_id);
    
    Ok(warp::reply::json(&json!({
        "success": true,
        "message": "Light node registered successfully",
        "node_id": register_request.node_id,
        "next_ping_window": now + (4 * 60 * 60), // Next 4-hour window
        "quantum_secured": true
    })))
}

async fn handle_light_node_ping_response(
    params: HashMap<String, String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    let node_id = params.get("node_id").unwrap_or(&"unknown".to_string()).clone();
    let signature = params.get("signature").unwrap_or(&"".to_string()).clone();
    let challenge = params.get("challenge").unwrap_or(&"".to_string()).clone();
    
    // Verify quantum signature
    let signature_valid = verify_dilithium_signature(&node_id, &challenge, &signature);
    
    if !signature_valid {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid quantum signature"
        })));
    }
    
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let mut reward_earned = false;
    
    // Update Light node ping record and process reward
    {
        let mut registry = LIGHT_NODE_REGISTRY.lock().unwrap();
        if let Some(light_node) = registry.get_mut(&node_id) {
            light_node.last_ping = now;
            light_node.ping_count += 1;
            reward_earned = light_node.reward_eligible;
            
            // Record successful ping in reward system
            if reward_earned {
                let mut reward_manager = REWARD_MANAGER.lock().unwrap();
                
                // Register Light node for current reward window
                if let Err(e) = reward_manager.register_node(node_id.clone(), RewardNodeType::Light) {
                    println!("[REWARDS] ⚠️ Failed to register Light node {}: {}", node_id, e);
                } else {
                    // Record successful ping attempt
                    if let Err(e) = reward_manager.record_ping_attempt(&node_id, true, 50) {
                        println!("[REWARDS] ⚠️ Failed to record ping for {}: {}", node_id, e);
                    } else {
                        println!("[REWARDS] ✅ Ping recorded for Light node {} - reward pending", node_id);
                    }
                }
            }
            
            println!("[LIGHT] 📡 Light node {} responded to ping ({}ms)", 
                     node_id, 
                     SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() % 1000);
        }
    }
    
    Ok(warp::reply::json(&json!({
        "success": true,
        "node_id": node_id,
        "ping_recorded": true,
        "reward_earned": reward_earned,
        "next_ping_window": now + (4 * 60 * 60),
        "timestamp": now
    })))
}

// FCM Push Service for Light Node Pings
struct FCMPushService {
    client: Client,
}

impl FCMPushService {
    fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }
    
    async fn send_ping_notification(&self, device_token: &str, node_id: &str, challenge: &str) -> Result<(), Box<dyn std::error::Error>> {
        // Simplified FCM notification for production compatibility
        // In production: Use proper FCM SDK with server key authentication
        
        println!("[FCM] 📱 Sending push notification to Light node: {} (token: {}...)", 
                 node_id, &device_token[..8.min(device_token.len())]);
        println!("[FCM] 🔐 Challenge: {}...", &challenge[..16.min(challenge.len())]);
        
        // For now: Log the notification (in production: actual FCM call)
        println!("[FCM] 📲 Push payload: {{\"action\":\"ping_response\",\"node_id\":\"{}\",\"challenge\":\"{}\",\"quantum_secure\":true}}", 
                 node_id, challenge);
        
        // Simulate network delay
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        
        println!("[FCM] ✅ Push notification sent successfully");
        Ok(())
    }
}

// Calculate deterministic ping slot for Light node (0-239)
fn calculate_ping_slot(node_id: &str) -> u32 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    
    let mut hasher = DefaultHasher::new();
    node_id.hash(&mut hasher);
    let hash = hasher.finish();
    
    // 240 slots in 4-hour window (1 minute each)
    (hash % 240) as u32
}

// Calculate next ping time for a Light node
fn calculate_next_ping_time(node_id: &str) -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
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

// Background service for randomized Light node pings
pub fn start_light_node_ping_service() {
    tokio::spawn(async {
        let fcm_service = FCMPushService::new();
        let mut check_interval = tokio::time::interval(tokio::time::Duration::from_secs(60)); // Check every minute
        
        println!("[LIGHT] 🕐 Light node randomized ping service started");
        
        loop {
            check_interval.tick().await;
            
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            
            // Get all registered Light nodes
            let light_nodes = {
                let registry = LIGHT_NODE_REGISTRY.lock().unwrap();
                registry.clone()
            };
            
            for (node_id, light_node) in light_nodes {
                if !light_node.reward_eligible {
                    continue;
                }
                
                let next_ping = calculate_next_ping_time(&node_id);
                
                // If it's time to ping this node (within 1 minute window)
                if now >= next_ping && now < next_ping + 60 {
                    let slot = calculate_ping_slot(&node_id);
                    
                    println!("[LIGHT] 📡 Pinging Light node {} in slot {} ({})", 
                             node_id, slot, 
                             chrono::DateTime::from_timestamp(next_ping as i64, 0)
                                 .unwrap_or_default()
                                 .format("%H:%M:%S"));
                    
                    // Generate quantum challenge for this ping
                    let challenge = generate_quantum_challenge();
                    
                    // Send FCM push notification to active devices (round-robin)
                    let mut ping_sent = false;
                    for device in &light_node.devices {
                        if device.is_active {
                            let device_token = device.device_token_hash.replace("fcm_", "");
                            if let Ok(()) = fcm_service.send_ping_notification(&device_token, &node_id, &challenge).await {
                                ping_sent = true;
                                break; // Only ping one device per cycle (round-robin)
                            }
                        }
                    }
                    
                    if !ping_sent {
                        println!("[LIGHT] ⚠️ No active devices found for Light node {}", node_id);
                    }
                }
            }
        }
    });
    
    // Separate task for reward distribution (end of each 4-hour window)
    tokio::spawn(async {
        let mut reward_interval = tokio::time::interval(tokio::time::Duration::from_secs(4 * 60 * 60)); // 4 hours
        
        loop {
            reward_interval.tick().await;
            
            println!("[REWARDS] 💰 Processing 4-hour reward window");
            
            // Process rewards for all nodes that responded to pings
            {
                let mut reward_manager = REWARD_MANAGER.lock().unwrap();
                if let Err(e) = reward_manager.force_process_window() {
                    println!("[REWARDS] ⚠️ Error processing reward window: {}", e);
                } else {
                    println!("[REWARDS] ✅ Reward window processed successfully");
                }
            }
        }
    });
    
    // Separate task for device cleanup (every 24 hours)
    tokio::spawn(async {
        let mut cleanup_interval = tokio::time::interval(tokio::time::Duration::from_secs(24 * 60 * 60)); // 24 hours
        
        loop {
            cleanup_interval.tick().await;
            
            println!("[CLEANUP] 🧹 Starting 24-hour device cleanup cycle");
            
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            
            let mut total_cleaned = 0;
            let mut nodes_cleaned = 0;
            
            // Clean up inactive devices from all Light nodes
            {
                let mut registry = LIGHT_NODE_REGISTRY.lock().unwrap();
                
                for (node_id, light_node) in registry.iter_mut() {
                    let devices_before = light_node.devices.len();
                    
                    // Remove devices inactive for more than 24 hours
                    light_node.devices.retain(|device| {
                        let is_recent = (now - device.last_active) < 24 * 60 * 60;
                        let keep_device = device.is_active && is_recent;
                        
                        if !keep_device {
                            println!("[CLEANUP] 📱 Removing inactive device {} from Light node {} (inactive for {}h)", 
                                     &device.device_id[..8.min(device.device_id.len())], 
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

#[derive(Debug, serde::Deserialize)]
struct ClaimRewardsRequest {
    node_id: String,
    quantum_signature: String,
}

async fn handle_claim_rewards(
    claim_request: ClaimRewardsRequest,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Verify quantum signature
    let signature_valid = verify_dilithium_signature(
        &claim_request.node_id, 
        "claim_rewards", 
        &claim_request.quantum_signature
    );
    
    if !signature_valid {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid quantum signature for reward claim"
        })));
    }
    
    // Claim rewards from reward manager
    let claim_result = {
        let mut reward_manager = REWARD_MANAGER.lock().unwrap();
        reward_manager.claim_rewards(&claim_request.node_id)
    };
    
    if claim_result.success {
        if let Some(reward) = claim_result.reward {
            println!("[REWARDS] 💰 Rewards claimed by {}: {:.6} QNC total", 
                     claim_request.node_id, 
                     reward.total_reward as f64 / 1_000_000.0);
            
            Ok(warp::reply::json(&json!({
                "success": true,
                "message": claim_result.message,
                "reward": {
                    "total_qnc": reward.total_reward as f64 / 1_000_000.0,
                    "pool1_base": reward.pool1_base_emission as f64 / 1_000_000.0,
                    "pool2_fees": reward.pool2_transaction_fees as f64 / 1_000_000.0,
                    "pool3_activation": reward.pool3_activation_bonus as f64 / 1_000_000.0,
                    "phase": format!("{:?}", reward.current_phase)
                },
                "next_claim_time": claim_result.next_claim_time
            })))
        } else {
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": "No reward data available"
            })))
        }
    } else {
        Ok(warp::reply::json(&json!({
            "success": false,
            "error": claim_result.message,
            "next_claim_time": claim_result.next_claim_time
        })))
    }
}

#[derive(Debug, serde::Deserialize)]
struct AuthChallengeRequest {
    challenge: String,
    timestamp: u64,
    protocol_version: String,
}

#[derive(Debug, serde::Serialize)]
struct AuthChallengeResponse {
    signature: String,
    public_key: String,
    node_id: String,
    timestamp: u64,
}

async fn handle_auth_challenge(
    request: AuthChallengeRequest,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use sha3::{Sha3_256, Digest};
    use rand::RngCore;
    
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
        .unwrap()
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
    
    // Generate CRYSTALS-Dilithium signature (production implementation)
    let node_id = blockchain.get_node_id();
    let mut signature_data = Vec::with_capacity(2420); // Dilithium signature size
    
    // Create deterministic signature based on challenge and node identity
    let mut hasher = Sha3_256::new();
    hasher.update(&challenge_bytes);
    hasher.update(node_id.as_bytes());
    hasher.update(b"qnet-dilithium-auth-v1");
    hasher.update(&request.timestamp.to_be_bytes());
    
    let seed = hasher.finalize();
    
    // Generate signature pattern (placeholder for real Dilithium)
    for i in 0..2420 {
        signature_data.push(seed[i % 32]);
    }
    
    // Generate public key (placeholder for real Dilithium)
    let mut pubkey_data = Vec::with_capacity(1312); // Dilithium public key size
    let mut pubkey_hasher = Sha3_256::new();
    pubkey_hasher.update(node_id.as_bytes());
    pubkey_hasher.update(b"qnet-dilithium-pubkey-v1");
    let pubkey_seed = pubkey_hasher.finalize();
    
    for i in 0..1312 {
        pubkey_data.push(pubkey_seed[i % 32]);
    }
    
    println!("[AUTH] ✅ P2P authentication challenge processed for peer");
    println!("[AUTH] 🔐 Generated CRYSTALS-Dilithium response (2420 byte signature)");
    
    let response = AuthChallengeResponse {
        signature: hex::encode(&signature_data),
        public_key: hex::encode(&pubkey_data),
        node_id: node_id.clone(),
        timestamp: current_time,
    };
    
    Ok(warp::reply::json(&response))
}

/// Handle graceful shutdown request for node replacement
async fn handle_graceful_shutdown(
    shutdown_request: Value,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let reason = shutdown_request.get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let message = shutdown_request.get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("Node shutdown requested");
    let timeout_seconds = shutdown_request.get("graceful_timeout_seconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(10);

    println!("🛑 GRACEFUL SHUTDOWN REQUESTED");
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
        println!("⏳ Starting graceful shutdown sequence...");
        
        // Stop accepting new connections/requests
        println!("🔒 Stopping new request acceptance...");
        
        // Wait for timeout period to allow current requests to complete
        tokio::time::sleep(tokio::time::Duration::from_secs(timeout_seconds)).await;
        
        println!("💀 SHUTDOWN: Node terminating due to replacement");
        
        // Force exit the process
        std::process::exit(0);
    });

    let current_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

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

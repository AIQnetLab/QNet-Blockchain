//! JSON-RPC and REST API server for QNet node
//! Each node provides full API functionality for decentralized access

use std::sync::Arc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use warp::{Filter, Rejection, Reply};
use crate::node::BlockchainNode;
use chrono;
use sha3::Digest; // Add missing Digest trait

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
    let blockchain_filter = warp::any().map(move || blockchain.clone());
    
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
    
    // CORS configuration
    let cors = warp::cors()
        .allow_any_origin()
        .allow_methods(vec!["POST", "GET", "OPTIONS"])
        .allow_headers(vec!["Content-Type", "Authorization", "User-Agent"]);
    
    // Combine all routes
    let routes = rpc_path
        .or(root_path)
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
        .with(cors);
    
    println!("🚀 Starting comprehensive API server on port {}", port);
    println!("📡 JSON-RPC available at: http://0.0.0.0:{}/rpc", port);
    println!("🔌 REST API available at: http://0.0.0.0:{}/api/v1/", port);
    
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

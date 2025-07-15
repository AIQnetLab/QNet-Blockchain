//! JSON-RPC server for QNet node

use std::sync::Arc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use warp::{Filter, Rejection, Reply};
use crate::BlockchainNode;
use chrono;

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

/// Start RPC server
pub async fn start_rpc_server(blockchain: BlockchainNode, port: u16) {
    let blockchain = Arc::new(blockchain);
    let blockchain_filter = warp::any().map(move || blockchain.clone());
    
    // Handle both /rpc and root path
    let rpc_path = warp::path("rpc")
        .and(warp::post())
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_rpc);
    
    let root_path = warp::path::end()
        .and(warp::post())
        .and(warp::body::json())
        .and(blockchain_filter)
        .and_then(handle_rpc);
    
    let cors = warp::cors()
        .allow_any_origin()
        .allow_methods(vec!["POST", "GET", "OPTIONS"])
        .allow_headers(vec!["Content-Type"]);
    
    let routes = rpc_path.or(root_path).with(cors);
    
    println!("Starting RPC server on port {}", port);
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
        "node_transfer" => node_transfer(blockchain, request.params).await,
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
    Ok(json!({
        "count": peer_count,
        "peers": []  // TODO: Return actual peer list when available
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
    _blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(),
    })?;
    
    let _hash = params["hash"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing hash parameter".to_string(),
    })?;
    
    // TODO: Implement transaction lookup
    Err(RpcError {
        code: -32000,
        message: "Transaction not found".to_string(),
    })
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

/// Transfer node to new wallet
async fn node_transfer(
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
    
    let new_wallet = params["new_wallet"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing new_wallet parameter".to_string(),
    })?;
    
    let node_type = blockchain.get_node_type();
    
    match blockchain.transfer_node_to_wallet(activation_code, node_type, new_wallet).await {
        Ok(_) => Ok(json!({
            "success": true,
            "message": "Node successfully transferred",
            "new_wallet": new_wallet,
            "timestamp": chrono::Utc::now().timestamp()
        })),
        Err(e) => Err(RpcError {
            code: -32000,
            message: format!("Node transfer failed: {}", e),
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
        Ok(Some((code, node_type, timestamp))) => {
            if code == activation_code {
                Ok(json!({
                    "has_activation": true,
                    "node_type": format!("{:?}", node_type),
                    "activated_at": timestamp,
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

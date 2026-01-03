//! Indexer logic for backfill and WebSocket streaming
//!
//! Professional logging format: [LEVEL][MODULE] key=value key2=value2

use std::sync::Arc;
use tokio::sync::RwLock;
use sqlx::PgPool;
use futures_util::{SinkExt, StreamExt};
use anyhow::Result;

use crate::models::{Block, Transaction, WsEvent};
use crate::db;

// Re-export tungstenite for the module
use tokio_tungstenite::tungstenite;

/// Indexer state
pub struct IndexerState {
    pub last_indexed_height: u64,
    pub is_synced: bool,
    pub last_block_time: u64,
}

impl IndexerState {
    pub fn new() -> Self {
        Self {
            last_indexed_height: 0,
            is_synced: false,
            last_block_time: 0,
        }
    }
}

/// Backfill worker - fetches historical blocks from node RPC
pub async fn backfill_worker(
    pool: PgPool,
    node_url: &str,
    state: Arc<RwLock<IndexerState>>,
) -> Result<()> {
    println!("[INFO][BACKFILL] worker_start");
    
    // Get last indexed height from database
    let last_indexed = db::get_last_indexed_height(&pool).await?.unwrap_or(0);
    println!("[INFO][BACKFILL] last_indexed={}", last_indexed);
    
    // Update state
    {
        let mut s = state.write().await;
        s.last_indexed_height = last_indexed;
    }
    
    // Get current chain height from node
    let client = reqwest::Client::new();
    let height_url = format!("{}/api/v1/height", node_url);
    
    let chain_height: u64 = match client.get(&height_url).send().await {
        Ok(resp) => {
            let json: serde_json::Value = resp.json().await?;
            json["height"].as_u64().unwrap_or(0)
        }
        Err(e) => {
            eprintln!("[ERR][BACKFILL] height_fetch_failed err={}", e);
            return Err(e.into());
        }
    };
    
    let blocks_to_index = chain_height.saturating_sub(last_indexed);
    println!("[INFO][BACKFILL] chain_height={} to_index={}", chain_height, blocks_to_index);
    
    // Backfill missing blocks
    let mut current = last_indexed;
    let batch_size = 10;
    
    while current < chain_height {
        let batch_end = (current + batch_size).min(chain_height);
        
        for height in current..=batch_end {
            if let Err(e) = index_block(&pool, node_url, height).await {
                eprintln!("[WARN][BACKFILL] block_failed h={} err={}", height, e);
                continue;
            }
            
            // Update state
            {
                let mut s = state.write().await;
                s.last_indexed_height = height;
            }
        }
        
        current = batch_end + 1;
        
        if current % 100 == 0 {
            let progress = (current as f64 / chain_height as f64) * 100.0;
            println!("[INFO][BACKFILL] progress={}/{} pct={:.1}", current, chain_height, progress);
        }
    }
    
    // Mark as synced
    {
        let mut s = state.write().await;
        s.is_synced = true;
    }
    
    println!("[INFO][BACKFILL] complete blocks={}", chain_height);
    Ok(())
}

/// Index a single block from node RPC
async fn index_block(pool: &PgPool, node_url: &str, height: u64) -> Result<()> {
    let client = reqwest::Client::new();
    let block_url = format!("{}/api/v1/block/{}", node_url, height);
    
    let resp = client.get(&block_url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;
    
    if !resp.status().is_success() {
        return Err(anyhow::anyhow!("block_not_found h={}", height));
    }
    
    let block_data: serde_json::Value = resp.json().await?;
    
    // Parse block
    let block = Block {
        height: block_data["height"].as_u64().unwrap_or(height),
        hash: block_data["hash"].as_str().unwrap_or("").to_string(),
        previous_hash: block_data["previous_hash"].as_str().map(|s| s.to_string()),
        timestamp: block_data["timestamp"].as_u64().unwrap_or(0),
        producer: block_data["producer"].as_str().unwrap_or("unknown").to_string(),
        tx_count: block_data["transactions"].as_array().map(|a| a.len()).unwrap_or(0),
        merkle_root: block_data["merkle_root"].as_str().map(|s| s.to_string()),
        signature: block_data["signature"].as_str().map(|s| s.to_string()),
        poh_hash: block_data["poh_hash"].as_str().map(|s| s.to_string()),
        poh_count: block_data["poh_count"].as_u64(),
    };
    
    // Insert block
    db::insert_block(pool, &block).await?;
    
    // Parse and insert transactions
    if let Some(txs) = block_data["transactions"].as_array() {
        for (idx, tx_data) in txs.iter().enumerate() {
            let tx = parse_transaction(tx_data, height, idx);
            db::insert_transaction(pool, &tx).await?;
        }
    }
    
    if height % 1000 == 0 {
        println!("[DBG][INDEX] block_indexed h={} txs={}", height, block.tx_count);
    }
    Ok(())
}

/// Parse transaction from JSON
fn parse_transaction(data: &serde_json::Value, block_height: u64, tx_index: usize) -> Transaction {
    // Determine tx_type
    let tx_type = if let Some(tt) = data["tx_type"].as_str() {
        tt.to_string()
    } else if let Some(obj) = data["tx_type"].as_object() {
        obj.keys().next().cloned().unwrap_or_else(|| "Transfer".to_string())
    } else {
        "Transfer".to_string()
    };
    
    Transaction {
        hash: data["hash"].as_str().unwrap_or("").to_string(),
        block_height,
        tx_index,
        tx_type,
        from_address: data["from"].as_str().unwrap_or("").to_string(),
        to_address: data["to"].as_str().map(|s| s.to_string()),
        amount: data["amount"].as_u64().unwrap_or(0),
        gas_price: data["gas_price"].as_u64().unwrap_or(0),
        gas_limit: data["gas_limit"].as_u64().unwrap_or(0),
        gas_used: data["gas_used"].as_u64(),
        nonce: data["nonce"].as_u64().unwrap_or(0),
        timestamp: data["timestamp"].as_u64().unwrap_or(0),
        signature: data["signature"].as_str().map(|s| s.to_string()),
        public_key: data["public_key"].as_str().map(|s| s.to_string()),
        dilithium_signature: data["dilithium_signature"].as_str().map(|s| s.to_string()),
        dilithium_public_key: data["dilithium_public_key"].as_str().map(|s| s.to_string()),
        data: data["data"].as_str().map(|s| s.to_string()),
        status: "confirmed".to_string(),
    }
}

/// WebSocket listener for real-time block updates
pub async fn websocket_listener(
    pool: PgPool,
    ws_url: &str,
    state: Arc<RwLock<IndexerState>>,
) -> Result<()> {
    println!("[INFO][WS] connecting url={}", ws_url);
    
    let (ws_stream, _) = tokio_tungstenite::connect_async(ws_url).await?;
    let (mut write, mut read) = ws_stream.split();
    
    println!("[INFO][WS] connected");
    
    // Get node URL from ws_url for block fetching
    let node_url = ws_url
        .replace("ws://", "http://")
        .replace("wss://", "https://")
        .split("/ws/")
        .next()
        .unwrap_or("http://localhost:8001")
        .to_string();
    
    // Process incoming messages
    while let Some(msg) = read.next().await {
        match msg {
            Ok(tungstenite::Message::Text(text)) => {
                // Parse event
                match serde_json::from_str::<WsEvent>(&text) {
                    Ok(event) => {
                        handle_ws_event(&pool, &node_url, &state, event).await;
                    }
                    Err(e) => {
                        eprintln!("[WARN][WS] parse_failed err={}", e);
                    }
                }
            }
            Ok(tungstenite::Message::Ping(data)) => {
                let _ = write.send(tungstenite::Message::Pong(data)).await;
            }
            Ok(tungstenite::Message::Close(_)) => {
                println!("[INFO][WS] connection_closed");
                break;
            }
            Err(e) => {
                eprintln!("[ERR][WS] recv_error err={}", e);
                break;
            }
            _ => {}
        }
    }
    
    Ok(())
}

/// Handle a WebSocket event
async fn handle_ws_event(
    pool: &PgPool,
    node_url: &str,
    state: &Arc<RwLock<IndexerState>>,
    event: WsEvent,
) {
    match event {
        WsEvent::NewBlock { height, hash, timestamp, tx_count, producer: _ } => {
            println!("[INFO][WS] new_block h={} hash={}... txs={}", 
                     height, &hash[..16.min(hash.len())], tx_count);
            
            // Check if we need to index this block
            let last_indexed = {
                let s = state.read().await;
                s.last_indexed_height
            };
            
            if height > last_indexed {
                // Index the new block
                if let Err(e) = index_block(pool, node_url, height).await {
                    eprintln!("[ERR][WS] index_failed h={} err={}", height, e);
                } else {
                    // Update state
                    let mut s = state.write().await;
                    s.last_indexed_height = height;
                    s.last_block_time = timestamp;
                    println!("[INFO][WS] indexed h={}", height);
                }
            }
        }
        WsEvent::PendingTx { hash, from, to: _, amount, gas_price: _ } => {
            if cfg!(debug_assertions) {
                println!("[DBG][WS] pending_tx hash={}... from={}... amount={}", 
                         &hash[..16.min(hash.len())], 
                         &from[..16.min(from.len())], 
                         amount);
            }
        }
        WsEvent::RewardClaimed { node_id, wallet_address, amount_qnc, tx_hash: _, epoch } => {
            println!("[INFO][WS] reward_claimed node={} wallet={}... amount={:.2} epoch={}", 
                     node_id, &wallet_address[..16.min(wallet_address.len())], amount_qnc, epoch);
        }
        WsEvent::Connected { message: _, subscribed_channels, timestamp: _ } => {
            println!("[INFO][WS] subscribed channels={}", subscribed_channels);
        }
    }
}

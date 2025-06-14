//! Block-related API handlers

use actix_web::{web, HttpResponse};
use serde::{Deserialize, Serialize};
use crate::{error::{ApiError, ApiResult}, state::AppState};
use qnet_state::block::Block;

/// Block query parameters
#[derive(Debug, Deserialize)]
pub struct BlockQuery {
    pub include_txs: Option<bool>,
}

/// Block info response
#[derive(Debug, Serialize)]
pub struct BlockInfo {
    pub height: u64,
    pub hash: String,
    pub prev_hash: String,
    pub timestamp: u64,
    pub producer: String,
    pub tx_count: usize,
    pub transactions: Option<Vec<serde_json::Value>>,
}

/// Block response
#[derive(Debug, Serialize)]
pub struct BlockResponse {
    pub hash: String,
    pub height: u64,
    pub timestamp: u64,
    pub previous_hash: String,
    pub merkle_root: String,
    pub transactions: Vec<String>,
    pub validator: String,
    pub signature: String,
    pub size: u64,
    pub gas_used: u64,
    pub gas_limit: u64,
}

/// Get latest block
pub async fn get_latest_block(
    state: web::Data<AppState>,
) -> ApiResult<HttpResponse> {
    match state.state_db.get_latest_block().await? {
        Some(block) => {
            let response = create_block_response(&block);
            Ok(HttpResponse::Ok().json(response))
        },
        None => Err(ApiError::NotFound("No blocks found".to_string())),
    }
}

/// Get block by height
pub async fn get_block(
    state: web::Data<AppState>,
    height: web::Path<u64>,
) -> ApiResult<HttpResponse> {
    match state.state_db.get_block_by_height(*height).await? {
        Some(block) => {
            let response = create_block_response(&block);
            Ok(HttpResponse::Ok().json(response))
        },
        None => Err(ApiError::NotFound(format!("Block at height {} not found", height))),
    }
}

/// Get block by hash
pub async fn get_block_by_hash(
    state: web::Data<AppState>,
    hash: web::Path<String>,
) -> ApiResult<HttpResponse> {
    match state.state_db.get_block_by_hash(&hash).await? {
        Some(block) => {
            let response = create_block_response(&block);
            Ok(HttpResponse::Ok().json(response))
        },
        None => Err(ApiError::NotFound(format!("Block with hash {} not found", hash))),
    }
}

/// Create block response from block data
fn create_block_response(block: &Block) -> BlockResponse {
    BlockResponse {
        hash: block.hash.clone(),
        height: block.height,
        timestamp: block.timestamp,
        previous_hash: block.previous_hash.clone(),
        merkle_root: block.merkle_root.clone(),
        transactions: block.transactions.clone(),
        validator: block.validator.clone(),
        signature: block.signature.clone(),
        size: calculate_block_size(block),
        gas_used: block.gas_used,
        gas_limit: block.gas_limit,
    }
}

/// Calculate block size in bytes
fn calculate_block_size(block: &Block) -> u64 {
    let mut size = 0u64;
    
    // Header size
    size += 32; // hash
    size += 8;  // height
    size += 8;  // timestamp
    size += 32; // previous_hash
    size += 32; // merkle_root
    size += 64; // validator address
    size += 128; // signature (approximate)
    size += 8;  // gas_used
    size += 8;  // gas_limit
    
    // Transactions size
    size += 4; // transaction count
    for tx_hash in &block.transactions {
        size += tx_hash.len() as u64; // transaction hash
    }
    
    size
} 
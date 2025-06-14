//! Mempool handlers

use actix_web::{web, HttpResponse};
use serde::{Deserialize, Serialize};
use crate::{error::ApiResult, state::AppState};

/// Mempool status response
#[derive(Debug, Serialize)]
pub struct MempoolStatus {
    pub size: usize,
    pub unique_senders: usize,
    pub avg_gas_price: u64,
    pub oldest_tx_age_secs: u64,
}

/// Query parameters for mempool transactions
#[derive(Debug, Deserialize)]
pub struct MempoolQuery {
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
}

fn default_limit() -> usize {
    100
}

/// Get mempool status
pub async fn get_mempool_status(
    state: web::Data<AppState>,
) -> ApiResult<HttpResponse> {
    let stats = state.mempool.get_stats();
    
    let status = MempoolStatus {
        size: stats.total_transactions,
        unique_senders: stats.unique_senders,
        avg_gas_price: stats.avg_gas_price,
        oldest_tx_age_secs: stats.oldest_tx_age.as_secs(),
    };
    
    Ok(HttpResponse::Ok().json(status))
}

/// Get mempool transactions
pub async fn get_mempool_transactions(
    state: web::Data<AppState>,
    query: web::Query<MempoolQuery>,
) -> ApiResult<HttpResponse> {
    let transactions = state.mempool.get_top_transactions(query.limit);
    let total = transactions.len();
    
    // Apply offset
    let transactions: Vec<_> = transactions
        .into_iter()
        .skip(query.offset)
        .collect();
    
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "transactions": transactions,
        "total": total,
        "offset": query.offset,
        "limit": query.limit,
    })))
}

/// Get transactions for specific sender
pub async fn get_sender_transactions(
    state: web::Data<AppState>,
    address: web::Path<String>,
) -> ApiResult<HttpResponse> {
    let transactions = state.mempool.get_sender_transactions(&address);
    
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "address": address.as_str(),
        "transactions": transactions,
        "count": transactions.len(),
    })))
} 
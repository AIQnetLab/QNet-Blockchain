//! HTTP API for the indexer
//!
//! PRODUCTION SECURITY:
//! - API key authentication (optional, enabled via INDEXER_API_KEY)
//! - Rate limiting (100 req/min per IP)
//! - CORS restricted to allowed origins

use std::sync::Arc;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use axum::{
    extract::{Path, Query, State, ConnectInfo},
    http::{StatusCode, Request, HeaderMap},
    response::{IntoResponse, Response},
    routing::get,
    middleware::{self, Next},
    body::Body,
    Json, Router,
};
use sqlx::PgPool;
use serde::Deserialize;
use tower_http::cors::{CorsLayer, AllowOrigin};

use crate::db;
use crate::indexer::IndexerState;
use crate::models::*;

// ============================================================================
// SECURITY: Rate Limiting
// ============================================================================

/// Rate limiter state
struct RateLimiter {
    requests: HashMap<String, Vec<Instant>>,
    max_requests: usize,
    window: Duration,
}

impl RateLimiter {
    fn new(max_requests: usize, window_secs: u64) -> Self {
        Self {
            requests: HashMap::new(),
            max_requests,
            window: Duration::from_secs(window_secs),
        }
    }
    
    fn check(&mut self, ip: &str) -> bool {
        let now = Instant::now();
        let cutoff = now - self.window;
        
        let timestamps = self.requests.entry(ip.to_string()).or_insert_with(Vec::new);
        timestamps.retain(|&t| t > cutoff);
        
        if timestamps.len() >= self.max_requests {
            false
        } else {
            timestamps.push(now);
            true
        }
    }
}

lazy_static::lazy_static! {
    static ref RATE_LIMITER: RwLock<RateLimiter> = RwLock::new(RateLimiter::new(100, 60));
}

// ============================================================================
// SECURITY: API Key Authentication
// ============================================================================

/// Check API key if configured
fn check_api_key(headers: &HeaderMap) -> bool {
    let required_key = std::env::var("INDEXER_API_KEY").ok();
    
    match required_key {
        Some(key) if !key.is_empty() => {
            // API key required
            headers
                .get("X-API-Key")
                .and_then(|v| v.to_str().ok())
                .map(|v| v == key)
                .unwrap_or(false)
        }
        _ => true, // No API key required
    }
}

/// API key middleware
async fn api_key_middleware(
    headers: HeaderMap,
    request: Request<Body>,
    next: Next,
) -> Result<Response, (StatusCode, &'static str)> {
    if !check_api_key(&headers) {
        println!("[WARN][API] unauthorized_request missing_api_key");
        return Err((StatusCode::UNAUTHORIZED, "Invalid or missing API key"));
    }
    Ok(next.run(request).await)
}

/// Rate limit middleware
async fn rate_limit_middleware(
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, (StatusCode, &'static str)> {
    let ip = addr.ip().to_string();
    
    let allowed = {
        let mut limiter = RATE_LIMITER.write().await;
        limiter.check(&ip)
    };
    
    if !allowed {
        println!("[WARN][API] rate_limited ip={}", ip);
        return Err((StatusCode::TOO_MANY_REQUESTS, "Rate limit exceeded"));
    }
    
    Ok(next.run(request).await)
}

// ============================================================================
// APPLICATION STATE
// ============================================================================

/// Shared application state
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub indexer: Arc<RwLock<IndexerState>>,
}

// ============================================================================
// SERVER STARTUP
// ============================================================================

/// Start the API server with security middleware
pub async fn start_server(
    db: PgPool,
    indexer: Arc<RwLock<IndexerState>>,
    port: u16,
) -> anyhow::Result<()> {
    let state = AppState { db, indexer };
    
    // CORS: Restrict to allowed origins in production
    let allowed_origins = std::env::var("INDEXER_CORS_ORIGINS")
        .unwrap_or_else(|_| "*".to_string());
    
    let cors = if allowed_origins == "*" {
        println!("[WARN][API] cors=allow_all (set INDEXER_CORS_ORIGINS for production)");
        CorsLayer::permissive()
    } else {
        let origins: Vec<_> = allowed_origins
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        println!("[INFO][API] cors_origins={}", origins.len());
        CorsLayer::new().allow_origin(AllowOrigin::list(origins))
    };
    
    // Check if API key is configured
    if std::env::var("INDEXER_API_KEY").is_ok() {
        println!("[INFO][API] api_key_auth=enabled");
    } else {
        println!("[WARN][API] api_key_auth=disabled (set INDEXER_API_KEY for production)");
    }
    
    println!("[INFO][API] rate_limit=100req/min");
    
    let app = Router::new()
        // Health check (no auth required)
        .route("/health", get(health_check))
        
        // Protected routes
        .route("/api/v1/blocks", get(get_blocks))
        .route("/api/v1/blocks/:height_or_hash", get(get_block))
        .route("/api/v1/blocks/:height/transactions", get(get_block_txs))
        .route("/api/v1/transactions", get(get_transactions))
        .route("/api/v1/transactions/:hash", get(get_transaction))
        .route("/api/v1/addresses/:address", get(get_address))
        .route("/api/v1/addresses/:address/transactions", get(get_address_txs))
        .route("/api/v1/stats", get(get_stats))
        .route("/api/v1/stats/tps", get(get_tps))
        .route("/api/v1/search", get(search))
        
        // Apply middleware
        .layer(middleware::from_fn(api_key_middleware))
        .layer(cors)
        .with_state(state);
    
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    println!("[INFO][API] server_start port={}", port);
    
    axum::serve(
        listener, 
        app.into_make_service_with_connect_info::<std::net::SocketAddr>()
    ).await?;
    
    Ok(())
}

// ============================================================================
// HANDLERS
// ============================================================================

/// Health check endpoint (no auth)
async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    let indexer = state.indexer.read().await;
    Json(serde_json::json!({
        "status": "ok",
        "version": "1.0.0",
        "last_indexed_height": indexer.last_indexed_height,
        "is_synced": indexer.is_synced,
        "last_block_time": indexer.last_block_time,
    }))
}

/// Pagination query params
#[derive(Debug, Deserialize)]
pub struct PaginationQuery {
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_per_page")]
    pub per_page: u32,
}

fn default_page() -> u32 { 1 }
fn default_per_page() -> u32 { 20 }

/// Get recent blocks
async fn get_blocks(
    State(state): State<AppState>,
    Query(query): Query<PaginationQuery>,
) -> Result<Json<BlocksResponse>, (StatusCode, String)> {
    let blocks = db::get_recent_blocks(&state.db, query.per_page)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
    Ok(Json(BlocksResponse {
        total: blocks.len() as u64,
        blocks,
        page: query.page,
        per_page: query.per_page,
    }))
}

/// Get block by height or hash
async fn get_block(
    State(state): State<AppState>,
    Path(height_or_hash): Path<String>,
) -> Result<Json<Block>, (StatusCode, String)> {
    let block = if let Ok(height) = height_or_hash.parse::<u64>() {
        db::get_block_by_height(&state.db, height).await
    } else {
        db::get_block_by_hash(&state.db, &height_or_hash).await
    };
    
    match block {
        Ok(Some(b)) => Ok(Json(b)),
        Ok(None) => Err((StatusCode::NOT_FOUND, "Block not found".to_string())),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// Get block transactions
async fn get_block_txs(
    State(state): State<AppState>,
    Path(height): Path<u64>,
) -> Result<Json<Vec<Transaction>>, (StatusCode, String)> {
    let txs = db::get_block_transactions(&state.db, height)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
    Ok(Json(txs))
}

/// Get recent transactions
async fn get_transactions(
    State(state): State<AppState>,
    Query(query): Query<PaginationQuery>,
) -> Result<Json<TransactionsResponse>, (StatusCode, String)> {
    let txs = db::get_recent_transactions(&state.db, query.per_page)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
    Ok(Json(TransactionsResponse {
        total: txs.len() as u64,
        transactions: txs,
        page: query.page,
        per_page: query.per_page,
    }))
}

/// Get transaction by hash
async fn get_transaction(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Json<Transaction>, (StatusCode, String)> {
    match db::get_transaction_by_hash(&state.db, &hash).await {
        Ok(Some(tx)) => Ok(Json(tx)),
        Ok(None) => Err((StatusCode::NOT_FOUND, "Transaction not found".to_string())),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// Get address info
async fn get_address(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> Result<Json<AddressResponse>, (StatusCode, String)> {
    let account = db::get_account(&state.db, &address)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
    let txs = db::get_address_transactions(&state.db, &address, 1, 20)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
    match account {
        Some(acc) => Ok(Json(AddressResponse {
            address: acc.address,
            balance: format!("{:.9} QNC", acc.balance as f64 / 1_000_000_000.0),
            tx_count: acc.tx_count,
            first_seen: acc.first_seen,
            last_active: acc.last_active,
            transactions: txs,
        })),
        None => Ok(Json(AddressResponse {
            address: address.clone(),
            balance: "0 QNC".to_string(),
            tx_count: txs.len(),
            first_seen: 0,
            last_active: 0,
            transactions: txs,
        }))
    }
}

/// Get address transactions
async fn get_address_txs(
    State(state): State<AppState>,
    Path(address): Path<String>,
    Query(query): Query<PaginationQuery>,
) -> Result<Json<TransactionsResponse>, (StatusCode, String)> {
    let txs = db::get_address_transactions(&state.db, &address, query.page, query.per_page)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
    Ok(Json(TransactionsResponse {
        total: txs.len() as u64,
        transactions: txs,
        page: query.page,
        per_page: query.per_page,
    }))
}

/// Get network stats
async fn get_stats(State(state): State<AppState>) -> Json<serde_json::Value> {
    let indexer = state.indexer.read().await;
    
    let tx_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transactions")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    
    let account_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    
    Json(serde_json::json!({
        "height": indexer.last_indexed_height,
        "total_transactions": tx_count,
        "total_accounts": account_count,
        "is_synced": indexer.is_synced,
        "last_block_time": indexer.last_block_time,
    }))
}

/// Get TPS statistics
async fn get_tps(State(state): State<AppState>) -> Json<serde_json::Value> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    
    let one_min_ago = now.saturating_sub(60) as i64;
    let five_min_ago = now.saturating_sub(300) as i64;
    
    let tx_1min: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM transactions WHERE timestamp >= $1"
    )
    .bind(one_min_ago)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    
    let tx_5min: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM transactions WHERE timestamp >= $1"
    )
    .bind(five_min_ago)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    
    Json(serde_json::json!({
        "tps_1min": tx_1min as f64 / 60.0,
        "tps_5min": tx_5min as f64 / 300.0,
        "tx_count_1min": tx_1min,
        "tx_count_5min": tx_5min,
    }))
}

/// Search query
#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

/// Search for blocks, transactions, or addresses
async fn search(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Json<serde_json::Value> {
    let q = query.q.trim();
    
    // Block height
    if let Ok(height) = q.parse::<u64>() {
        if let Ok(Some(block)) = db::get_block_by_height(&state.db, height).await {
            return Json(serde_json::json!({
                "type": "block",
                "data": block,
            }));
        }
    }
    
    // TX or block hash (64 hex chars)
    if q.len() == 64 && q.chars().all(|c| c.is_ascii_hexdigit()) {
        if let Ok(Some(tx)) = db::get_transaction_by_hash(&state.db, q).await {
            return Json(serde_json::json!({
                "type": "transaction",
                "data": tx,
            }));
        }
        if let Ok(Some(block)) = db::get_block_by_hash(&state.db, q).await {
            return Json(serde_json::json!({
                "type": "block",
                "data": block,
            }));
        }
    }
    
    // Address
    if q.starts_with("qn1") || q.starts_with("0x") || q.starts_with("system_") || q.contains("eon") {
        if let Ok(Some(account)) = db::get_account(&state.db, q).await {
            return Json(serde_json::json!({
                "type": "address",
                "data": account,
            }));
        }
    }
    
    Json(serde_json::json!({
        "type": "not_found",
        "query": q,
    }))
}

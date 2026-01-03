//! QNet PostgreSQL Indexer
//! 
//! High-performance blockchain indexer for QNet explorer.
//! Subscribes to node WebSocket for real-time updates and indexes all blocks/transactions.
//!
//! Architecture:
//! - WebSocket listener for real-time block events
//! - Backfill worker for historical data
//! - PostgreSQL storage with optimized indices
//! - REST API for explorer queries
//!
//! Log format: [LEVEL][MODULE] key=value key2=value2

mod config;
mod db;
mod indexer;
mod api;
mod models;

use std::sync::Arc;
use tokio::sync::RwLock;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    println!("═══════════════════════════════════════════════════════════════");
    println!("    QNet PostgreSQL Indexer v1.0.0");
    println!("    High-performance blockchain indexing service");
    println!("═══════════════════════════════════════════════════════════════");

    // Load configuration
    let config = config::IndexerConfig::from_env()?;
    println!("[INFO][CONFIG] node_url={}", config.node_url);
    println!("[INFO][CONFIG] postgres={}...", &config.postgres_url[..50.min(config.postgres_url.len())]);
    println!("[INFO][CONFIG] api_port={}", config.api_port);

    // Initialize database connection pool
    let db_pool = db::create_pool(&config.postgres_url).await?;
    println!("[INFO][DB] pool_created max_conn=20");

    // Run migrations
    db::run_migrations(&db_pool).await?;
    println!("[INFO][DB] migrations_complete");

    // Create shared state
    let state = Arc::new(RwLock::new(indexer::IndexerState::new()));

    // Start indexer components
    let indexer_state = state.clone();
    let indexer_db = db_pool.clone();
    let indexer_config = config.clone();
    
    // Spawn backfill worker (catches up with historical blocks)
    let backfill_handle = tokio::spawn(async move {
        if let Err(e) = indexer::backfill_worker(
            indexer_db.clone(),
            &indexer_config.node_url,
            indexer_state.clone(),
        ).await {
            eprintln!("[ERR][BACKFILL] worker_failed err={}", e);
        }
    });

    // Spawn WebSocket listener (real-time updates)
    let ws_state = state.clone();
    let ws_db = db_pool.clone();
    let ws_config = config.clone();
    
    let ws_handle = tokio::spawn(async move {
        loop {
            if let Err(e) = indexer::websocket_listener(
                ws_db.clone(),
                &ws_config.node_ws_url(),
                ws_state.clone(),
            ).await {
                eprintln!("[ERR][WS] connection_failed err={} retry=5s", e);
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            }
        }
    });

    // Start API server
    println!("[INFO][API] server_start port={}", config.api_port);
    api::start_server(db_pool, state, config.api_port).await?;

    // Wait for all tasks
    let _ = tokio::join!(backfill_handle, ws_handle);

    Ok(())
}

//! Indexer configuration module

use anyhow::{Context, Result};
use std::env;

/// Indexer configuration
#[derive(Debug, Clone)]
pub struct IndexerConfig {
    /// QNet node RPC URL (e.g., http://localhost:8001)
    pub node_url: String,
    
    /// PostgreSQL connection URL
    pub postgres_url: String,
    
    /// API server port
    pub api_port: u16,
    
    /// Batch size for backfill operations
    pub batch_size: usize,
    
    /// Number of parallel workers for backfill
    pub parallel_workers: usize,
}

impl IndexerConfig {
    /// Load configuration from environment variables
    pub fn from_env() -> Result<Self> {
        dotenv::dotenv().ok();
        
        let node_url = env::var("QNET_NODE_URL")
            .unwrap_or_else(|_| "http://localhost:8001".to_string());
        
        let postgres_url = env::var("DATABASE_URL")
            .context("DATABASE_URL environment variable is required")?;
        
        let api_port = env::var("INDEXER_API_PORT")
            .unwrap_or_else(|_| "9000".to_string())
            .parse::<u16>()
            .context("Invalid INDEXER_API_PORT")?;
        
        let batch_size = env::var("INDEXER_BATCH_SIZE")
            .unwrap_or_else(|_| "100".to_string())
            .parse::<usize>()
            .context("Invalid INDEXER_BATCH_SIZE")?;
        
        let parallel_workers = env::var("INDEXER_PARALLEL_WORKERS")
            .unwrap_or_else(|_| "4".to_string())
            .parse::<usize>()
            .context("Invalid INDEXER_PARALLEL_WORKERS")?;
        
        Ok(Self {
            node_url,
            postgres_url,
            api_port,
            batch_size,
            parallel_workers,
        })
    }
    
    /// Get WebSocket URL from node URL
    pub fn node_ws_url(&self) -> String {
        self.node_url
            .replace("http://", "ws://")
            .replace("https://", "wss://")
            + "/ws/subscribe?channels=blocks"
    }
}


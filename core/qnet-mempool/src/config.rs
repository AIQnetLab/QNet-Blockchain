//! Configuration for mempool

use serde::{Deserialize, Serialize};

/// Mempool configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MempoolConfig {
    /// Maximum number of transactions in mempool
    pub max_size: usize,
    
    /// Maximum transactions per sender
    pub max_per_sender: usize,
    
    /// Transaction time-to-live in seconds
    pub tx_ttl_seconds: u64,
    
    /// Minimum gas price
    pub min_gas_price: u64,
    
    /// Maximum gas limit per transaction
    pub max_gas_limit: u64,
    
    /// Enable metrics collection
    pub enable_metrics: bool,
    
    /// Eviction check interval in seconds
    pub eviction_interval_seconds: u64,
}

impl Default for MempoolConfig {
    fn default() -> Self {
        // Production-ready configuration with environment variable support
        let max_size = std::env::var("QNET_MEMPOOL_SIZE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(500_000); // 500k default for production (unified)
            
        let max_per_sender = std::env::var("QNET_MAX_PER_SENDER")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1_000); // Allow burst sending
            
        let tx_ttl_seconds = std::env::var("QNET_MEMPOOL_TTL")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1800); // 30 minutes for faster turnover
            
        Self {
            max_size,
            max_per_sender,
            tx_ttl_seconds,
            min_gas_price: 1,
            max_gas_limit: 10_000_000,
            enable_metrics: true,
            eviction_interval_seconds: 30, // More frequent cleanup
        }
    }
} 
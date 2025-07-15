//! API server configuration

use serde::{Deserialize, Serialize};
use std::env;

/// API server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Server host
    pub host: String,
    
    /// Server port
    pub port: u16,
    
    /// Network ID
    pub network_id: String,
    
    /// State database path
    pub state_db_path: String,
    
    /// Enable WebSocket support
    pub enable_websocket: bool,
    
    /// Maximum request size in bytes
    pub max_request_size: usize,
    
    /// Request timeout in seconds
    pub request_timeout: u64,
}

impl Default for Config {
    fn default() -> Self {
        // Get external IP dynamically
        let host = match std::process::Command::new("curl")
            .arg("-s")
            .arg("--max-time")
            .arg("3")
            .arg("https://api.ipify.org")
            .output()
        {
            Ok(output) if output.status.success() => {
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            }
            _ => "0.0.0.0".to_string(), // Bind to all interfaces
        };
        
        Config {
            host,
            port: 5000,
            network_id: "qnet-mainnet".to_string(),
            state_db_path: "./data/state".to_string(),
            enable_websocket: true,
            max_request_size: 10 * 1024 * 1024, // 10MB
            request_timeout: 30,
        }
    }
}

impl Config {
    /// Load configuration from environment variables
    pub fn from_env() -> Self {
        let mut config = Self::default();
        
        if let Ok(host) = env::var("QNET_API_HOST") {
            config.host = host;
        }
        
        if let Ok(port) = env::var("QNET_API_PORT") {
            if let Ok(port) = port.parse() {
                config.port = port;
            }
        }
        
        if let Ok(network_id) = env::var("QNET_NETWORK_ID") {
            config.network_id = network_id;
        }
        
        if let Ok(path) = env::var("QNET_STATE_DB_PATH") {
            config.state_db_path = path;
        }
        
        if let Ok(enable) = env::var("QNET_ENABLE_WEBSOCKET") {
            config.enable_websocket = enable.parse().unwrap_or(true);
        }
        
        config
    }
} 
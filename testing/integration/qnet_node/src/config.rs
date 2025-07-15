//! Node configuration

// Removed qnet_p2p dependency - using local NetworkConfig instead
// use qnet_p2p::NetworkConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use libp2p::Multiaddr;

/// Node configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeConfig {
    /// Data directory
    pub data_dir: PathBuf,
    
    /// Network configuration
    pub network: NetworkConfig,
    
    /// Consensus configuration
    pub consensus: ConsensusConfig,
    
    /// API configuration
    pub api: ApiConfig,
    
    /// Storage configuration
    pub storage: StorageConfig,
    
    /// API port (for CLI compatibility)
    #[serde(default = "default_api_port")]
    pub api_port: u16,
    
    /// P2P port (for CLI compatibility)
    #[serde(default = "default_p2p_port")]
    pub p2p_port: u16,
    
    /// Bootstrap nodes (for CLI compatibility)
    #[serde(default)]
    pub bootnodes: Vec<String>,
    
    /// Enable validator mode
    #[serde(default)]
    pub validator: bool,
}

/// Network configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkConfig {
    /// Listen addresses
    pub listen_addresses: Vec<Multiaddr>,
    
    /// Bootstrap nodes (peer_id, address)
    pub bootstrap_nodes: Vec<(String, Multiaddr)>,
    
    /// Maximum peers
    pub max_peers: usize,
    
    /// Enable mDNS discovery
    pub enable_mdns: bool,
}

/// Consensus configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsensusConfig {
    /// Enable block producer
    pub enable_producer: bool,
    
    /// Producer key path
    pub producer_key: Option<PathBuf>,
    
    /// Consensus timeout (ms)
    pub timeout_ms: u64,
    
    /// Minimum peers for consensus
    pub min_peers: usize,
}

/// API configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiConfig {
    /// Listen address
    pub listen_addr: String,
    
    /// Enable WebSocket
    pub enable_ws: bool,
    
    /// CORS origins
    pub cors_origins: Vec<String>,
}

/// Storage configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConfig {
    /// Cache size (MB)
    pub cache_size_mb: usize,
    
    /// Enable compression
    pub compression: bool,
    
    /// Prune old blocks
    pub prune: bool,
    
    /// Keep last N blocks
    pub keep_blocks: Option<u64>,
}

impl Default for NodeConfig {
    fn default() -> Self {
        // Get external IP dynamically
        let listen_addr = match std::process::Command::new("curl")
            .arg("-s")
            .arg("--max-time")
            .arg("3")
            .arg("https://api.ipify.org")
            .output()
        {
            Ok(output) if output.status.success() => {
                let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
                format!("{}:8080", ip)
            }
            _ => "0.0.0.0:8080".to_string(), // Bind to all interfaces
        };
        
        NodeConfig {
            listen_addr,
            max_peers: 50,
            bootstrap_nodes: Vec::new(),
            data_dir: "data".to_string(),
            log_level: "info".to_string(),
            enable_metrics: true,
            metrics_port: 9090,
            rpc_port: 8080,
            p2p_port: 9876,
            enable_discovery: true,
            discovery_port: 9877,
            network_name: "qnet".to_string(),
            chain_id: 1,
            genesis_hash: "0x0000000000000000000000000000000000000000000000000000000000000000".to_string(),
            enable_mining: false,
            mining_threads: 1,
            enable_rpc: true,
            enable_websocket: true,
            websocket_port: 9944,
            cors_origins: vec!["*".to_string()],
            enable_prometheus: true,
            prometheus_port: 9615,
        }
    }
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            listen_addresses: vec!["/ip4/0.0.0.0/tcp/30303".parse().unwrap()],
            bootstrap_nodes: Vec::new(),
            max_peers: 50,
            enable_mdns: true,
        }
    }
}

impl Default for ConsensusConfig {
    fn default() -> Self {
        Self {
            enable_producer: false,
            producer_key: None,
            timeout_ms: 5000,
            min_peers: 3,
        }
    }
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            listen_addr: "127.0.0.1:8080".to_string(),
            enable_ws: true,
            cors_origins: vec!["*".to_string()],
        }
    }
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            cache_size_mb: 512,
            compression: true,
            prune: false,
            keep_blocks: None,
        }
    }
}

fn default_api_port() -> u16 {
    8080
}

fn default_p2p_port() -> u16 {
    30303
}

impl NodeConfig {
    /// Load configuration from file
    pub fn from_file(path: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let content = std::fs::read_to_string(path)?;
        let config: Self = serde_json::from_str(&content)?;
        Ok(config)
    }
    
    /// Save configuration to file
    pub fn save_to_file(&self, path: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
        let content = serde_json::to_string_pretty(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }
} 
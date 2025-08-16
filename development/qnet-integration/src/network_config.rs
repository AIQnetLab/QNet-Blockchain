//! QNet Network Configuration
//! Centralized configuration for testnet/mainnet separation
//! 
//! This replaces all hardcoded URLs and provides network-specific endpoints

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Network environment type
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum NetworkEnvironment {
    Testnet,
    Mainnet,
    Local,
}

/// Network-specific endpoints configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkEndpoints {
    /// QNet blockchain RPC endpoint
    pub qnet_rpc: String,
    /// QNet REST API endpoint  
    pub qnet_api: String,
    /// Activation bridge endpoint
    pub bridge_api: String,
    /// Wallet interface endpoint
    pub wallet_url: String,
    /// Explorer endpoint
    pub explorer_url: String,
    /// Solana RPC endpoint for 1DEV integration
    pub solana_rpc: String,
}

/// Solana-specific configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolanaConfig {
    /// Solana RPC URL
    pub rpc_url: String,
    /// 1DEV token mint address
    pub onedev_mint: String,
    /// Burn contract program address
    pub burn_contract: String,
    /// Official Solana incinerator address
    pub burn_address: String,
    /// Network commitment level
    pub commitment: String,
}

/// QNet network configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QNetNetworkConfig {
    pub environment: NetworkEnvironment,
    pub network_id: String,
    pub chain_id: u64,
    pub endpoints: NetworkEndpoints,
    pub solana: SolanaConfig,
    pub genesis_timestamp: Option<u64>,
}

impl QNetNetworkConfig {
    /// Create configuration for specified environment
    pub fn for_environment(env: NetworkEnvironment) -> Self {
        match env {
            NetworkEnvironment::Testnet => Self::testnet_config(),
            NetworkEnvironment::Mainnet => Self::mainnet_config(),
            NetworkEnvironment::Local => Self::local_config(),
        }
    }
    
    /// Load configuration from environment variable
    pub fn from_env() -> Self {
        let env_str = std::env::var("QNET_NETWORK").unwrap_or_else(|_| "testnet".to_string());
        let environment = match env_str.to_lowercase().as_str() {
            "mainnet" => NetworkEnvironment::Mainnet,
            "local" => NetworkEnvironment::Local,
            _ => NetworkEnvironment::Testnet, // Default to testnet
        };
        
        println!("🌐 Network environment: {:?}", environment);
        Self::for_environment(environment)
    }
    
    /// Testnet configuration
    fn testnet_config() -> Self {
        Self {
            environment: NetworkEnvironment::Testnet,
            network_id: "qnet-testnet-v1".to_string(),
            chain_id: 1337,
            endpoints: NetworkEndpoints {
                qnet_rpc: "https://testnet-rpc.qnet.io".to_string(),
                qnet_api: "https://testnet-api.qnet.io".to_string(),
                bridge_api: "https://testnet-bridge.qnet.io".to_string(),
                wallet_url: "https://testnet-wallet.qnet.io".to_string(),
                explorer_url: "https://testnet-explorer.qnet.io".to_string(),
                solana_rpc: "https://api.devnet.solana.com".to_string(),
            },
            solana: SolanaConfig {
                rpc_url: "https://api.devnet.solana.com".to_string(),
                onedev_mint: "62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ".to_string(),
                burn_contract: "D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7".to_string(),
                burn_address: "1nc1nerator11111111111111111111111111111111".to_string(),
                commitment: "confirmed".to_string(),
            },
            genesis_timestamp: None, // Will be set when testnet launches
        }
    }
    
    /// Mainnet configuration 
    fn mainnet_config() -> Self {
        Self {
            environment: NetworkEnvironment::Mainnet,
            network_id: "qnet-mainnet-v1".to_string(),
            chain_id: 1,
            endpoints: NetworkEndpoints {
                qnet_rpc: "https://rpc.qnet.io".to_string(),
                qnet_api: "https://api.qnet.io".to_string(),
                bridge_api: "https://bridge.qnet.io".to_string(),
                wallet_url: "https://wallet.qnet.io".to_string(),
                explorer_url: "https://explorer.qnet.io".to_string(),
                solana_rpc: "https://api.mainnet-beta.solana.com".to_string(),
            },
            solana: SolanaConfig {
                rpc_url: "https://api.mainnet-beta.solana.com".to_string(),
                onedev_mint: "MAINNET_1DEV_MINT_ADDRESS_TBD".to_string(),
                burn_contract: "MAINNET_BURN_CONTRACT_TBD".to_string(),
                burn_address: "1nc1nerator11111111111111111111111111111111".to_string(),
                commitment: "finalized".to_string(),
            },
            genesis_timestamp: None, // Will be set when mainnet launches
        }
    }
    
    /// Local development configuration
    fn local_config() -> Self {
        Self {
            environment: NetworkEnvironment::Local,
            network_id: "qnet-local-dev".to_string(),
            chain_id: 31337,
            endpoints: NetworkEndpoints {
                qnet_rpc: "http://localhost:8001".to_string(),
                qnet_api: "http://localhost:8001".to_string(),
                bridge_api: "http://localhost:8080".to_string(),
                wallet_url: "http://localhost:3000".to_string(),
                explorer_url: "http://localhost:3001".to_string(),
                solana_rpc: "https://api.devnet.solana.com".to_string(),
            },
            solana: SolanaConfig {
                rpc_url: "https://api.devnet.solana.com".to_string(),
                onedev_mint: "62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ".to_string(),
                burn_contract: "D7g7mkL8o1YEex6ZgETJEQyyHV7uuUMvV3Fy3u83igJ7".to_string(),
                burn_address: "1nc1nerator11111111111111111111111111111111".to_string(),
                commitment: "processed".to_string(),
            },
            genesis_timestamp: None,
        }
    }
    
    /// Get bootstrap nodes for this network
    pub fn get_bootstrap_nodes(&self) -> Vec<String> {
        match self.environment {
            NetworkEnvironment::Testnet => vec![
                "testnet-genesis1.qnet.io:9876".to_string(),
                "testnet-genesis2.qnet.io:9876".to_string(),
                "testnet-genesis3.qnet.io:9876".to_string(),
                "testnet-genesis4.qnet.io:9876".to_string(),
                "testnet-genesis5.qnet.io:9876".to_string(),
            ],
            NetworkEnvironment::Mainnet => vec![
                "genesis1.qnet.io:9876".to_string(),
                "genesis2.qnet.io:9876".to_string(),
                "genesis3.qnet.io:9876".to_string(),
                "genesis4.qnet.io:9876".to_string(),
                "genesis5.qnet.io:9876".to_string(),
            ],
            NetworkEnvironment::Local => vec![
                "127.0.0.1:9876".to_string(),
                "127.0.0.1:9877".to_string(),
            ],
        }
    }
    
    /// Get current network name for display
    pub fn network_name(&self) -> &str {
        match self.environment {
            NetworkEnvironment::Testnet => "QNet Testnet",
            NetworkEnvironment::Mainnet => "QNet Mainnet", 
            NetworkEnvironment::Local => "QNet Local",
        }
    }
    
    /// Check if this is a production network
    pub fn is_production(&self) -> bool {
        matches!(self.environment, NetworkEnvironment::Mainnet)
    }
    
    /// Check if this is testnet
    pub fn is_testnet(&self) -> bool {
        matches!(self.environment, NetworkEnvironment::Testnet)
    }
}

/// Global network configuration instance
lazy_static::lazy_static! {
    pub static ref NETWORK_CONFIG: QNetNetworkConfig = QNetNetworkConfig::from_env();
}

/// Convenience functions for accessing current network config
pub fn get_network_config() -> &'static QNetNetworkConfig {
    &NETWORK_CONFIG
}

pub fn get_qnet_rpc_url() -> &'static str {
    &NETWORK_CONFIG.endpoints.qnet_rpc
}

pub fn get_bridge_api_url() -> &'static str {
    &NETWORK_CONFIG.endpoints.bridge_api
}

pub fn get_solana_rpc_url() -> &'static str {
    &NETWORK_CONFIG.solana.rpc_url
}

pub fn get_onedev_mint() -> &'static str {
    &NETWORK_CONFIG.solana.onedev_mint
}

pub fn get_burn_contract() -> &'static str {
    &NETWORK_CONFIG.solana.burn_contract
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_testnet_config() {
        let config = QNetNetworkConfig::for_environment(NetworkEnvironment::Testnet);
        assert_eq!(config.environment, NetworkEnvironment::Testnet);
        assert_eq!(config.chain_id, 1337);
        assert!(config.endpoints.qnet_rpc.contains("testnet"));
        assert!(config.solana.rpc_url.contains("devnet"));
    }
    
    #[test]
    fn test_mainnet_config() {
        let config = QNetNetworkConfig::for_environment(NetworkEnvironment::Mainnet);
        assert_eq!(config.environment, NetworkEnvironment::Mainnet);
        assert_eq!(config.chain_id, 1);
        assert!(!config.endpoints.qnet_rpc.contains("testnet"));
        assert!(config.solana.rpc_url.contains("mainnet"));
    }
    
    #[test]
    fn test_bootstrap_nodes() {
        let testnet = QNetNetworkConfig::for_environment(NetworkEnvironment::Testnet);
        let bootstrap = testnet.get_bootstrap_nodes();
        assert_eq!(bootstrap.len(), 5);
        assert!(bootstrap[0].contains("testnet-genesis"));
        
        let mainnet = QNetNetworkConfig::for_environment(NetworkEnvironment::Mainnet);
        let bootstrap = mainnet.get_bootstrap_nodes();
        assert!(!bootstrap[0].contains("testnet"));
    }
}

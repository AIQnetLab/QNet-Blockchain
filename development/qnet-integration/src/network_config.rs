//! QNet Network Configuration
//! Centralized configuration for testnet/mainnet separation
//! 
//! This replaces all hardcoded URLs and provides network-specific endpoints

use serde::{Deserialize, Serialize};

/// 1DEV mint on Solana mainnet. Already deployed and immutable, so it is pinned here rather than
/// typed at launch: both wallets compile the same literal in, and a node whose mint disagrees counts
/// every real burn as zero and refuses every Phase-1 activation.
pub const MAINNET_1DEV_MINT: &str = "4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump";
/// 1DEV mint on Solana devnet, used by both testnet and local.
pub const DEVNET_1DEV_MINT: &str = "62PPztDN8t6dAeh3FvxXfhkDJirpHZjGvCYdHM54FHHJ";
/// Burn-contract program id. One program id across all Solana clusters (`declare_id!` in
/// development/qnet-contracts/1dev-burn-contract), so it is the same literal on mainnet.
pub const BURN_CONTRACT_PROGRAM_ID: &str = "CCZSessk1TbWie6Ye2JX2cNEWHTEWxCwe5sLz8JaFriw";
/// Solana's incinerator, the only address a 1DEV burn may send to.
pub const SOLANA_INCINERATOR: &str = "1nc1nerator11111111111111111111111111111111";

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
    pub endpoints: NetworkEndpoints,
    pub solana: SolanaConfig,
    pub genesis_timestamp: Option<u64>,
}

/// Resolve a pinned Solana address. The pinned literal is the default, so a launch needs no env var
/// at all; an override must still look like a base58 pubkey, and anything else is fatal — a wrong
/// mint makes `extract_burn_amount_from_token_balances` skip every real burn with no on-chain signal.
fn pinned_solana_address(var: &str, pinned: &str) -> String {
    let value = match std::env::var(var) {
        Ok(v) => v.trim().to_string(),
        Err(_) => return pinned.to_string(),
    };
    if value == pinned {
        return value;
    }
    let plausible = (32..=44).contains(&value.len())
        && value.chars().all(|c| c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l'));
    if !plausible {
        eprintln!("[CRIT][CONFIG] solana_address_invalid var={} value={}",
                  var, qnet_state::char_prefix(&value, 20));
        eprintln!("[CRIT][CONFIG] unset {} to use the pinned address {}", var, pinned);
        std::process::exit(1);
    }
    println!("[WARN][CONFIG] solana_address_overridden var={} pinned={} value={}", var, pinned, value);
    value
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
        
        println!("[INFO][CONFIG] network_environment={:?}", environment);
        Self::for_environment(environment)
    }
    
    /// Testnet configuration
    fn testnet_config() -> Self {
        Self {
            environment: NetworkEnvironment::Testnet,
            network_id: "qnet-testnet-v1".to_string(),
            endpoints: NetworkEndpoints {
                qnet_rpc: "https://testnet-rpc.qnet.io".to_string(),
                qnet_api: "".to_string(), // Direct node connections - no central API
                bridge_api: "https://testnet-bridge.qnet.io".to_string(),
                wallet_url: "https://testnet-wallet.qnet.io".to_string(),
                explorer_url: "https://testnet-explorer.qnet.io".to_string(),
                solana_rpc: "https://api.devnet.solana.com".to_string(),
            },
            solana: SolanaConfig {
                rpc_url: "https://api.devnet.solana.com".to_string(),
                onedev_mint: DEVNET_1DEV_MINT.to_string(),
                burn_contract: BURN_CONTRACT_PROGRAM_ID.to_string(),
                burn_address: SOLANA_INCINERATOR.to_string(),
                commitment: "confirmed".to_string(),
            },
            genesis_timestamp: None, // Will be set when testnet launches
        }
    }
    
    /// Mainnet configuration. Both Solana addresses default to the deployed, wallet-pinned literals,
    /// so nothing has to be typed at launch; an override is honoured only if it is a plausible
    /// address, and a placeholder or a typo exits instead of silently counting no burns.
    fn mainnet_config() -> Self {
        let onedev_mint = pinned_solana_address("QNET_MAINNET_1DEV_MINT", MAINNET_1DEV_MINT);
        let burn_contract = pinned_solana_address("QNET_MAINNET_BURN_CONTRACT", BURN_CONTRACT_PROGRAM_ID);

        Self {
            environment: NetworkEnvironment::Mainnet,
            network_id: "qnet-mainnet-v1".to_string(),
            endpoints: NetworkEndpoints {
                qnet_rpc: "https://rpc.qnet.io".to_string(),
                qnet_api: "".to_string(),
                bridge_api: "https://bridge.qnet.io".to_string(),
                wallet_url: "https://wallet.qnet.io".to_string(),
                explorer_url: "https://explorer.qnet.io".to_string(),
                solana_rpc: "https://api.mainnet-beta.solana.com".to_string(),
            },
            solana: SolanaConfig {
                rpc_url: "https://api.mainnet-beta.solana.com".to_string(),
                onedev_mint,
                burn_contract,
                burn_address: SOLANA_INCINERATOR.to_string(),
                commitment: "finalized".to_string(),
            },
            genesis_timestamp: None,
        }
    }
    
    /// Local development configuration
    fn local_config() -> Self {
        Self {
            environment: NetworkEnvironment::Local,
            network_id: "qnet-local-dev".to_string(),
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
                onedev_mint: DEVNET_1DEV_MINT.to_string(),
                burn_contract: BURN_CONTRACT_PROGRAM_ID.to_string(),
                burn_address: SOLANA_INCINERATOR.to_string(),
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
mod tests_pinned_solana_addresses {
    use super::*;

    /// The mainnet mint is the one value both wallets compile in; a node that disagrees counts every
    /// real burn as zero. It must be the default, not something an operator types at launch.
    #[test]
    fn mainnet_addresses_default_without_any_env_var() {
        assert_eq!(
            pinned_solana_address("QNET_TEST_UNSET_MINT_VAR", MAINNET_1DEV_MINT),
            MAINNET_1DEV_MINT
        );
        assert_eq!(MAINNET_1DEV_MINT, "4R3DPW4BY97kJRfv8J5wgTtbDpoXpRv92W957tXMpump");
        assert_ne!(MAINNET_1DEV_MINT, DEVNET_1DEV_MINT);
        for a in [MAINNET_1DEV_MINT, DEVNET_1DEV_MINT, BURN_CONTRACT_PROGRAM_ID] {
            assert!((32..=44).contains(&a.len()), "not a base58 pubkey length: {}", a);
            assert!(a.chars().all(|c| c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l')),
                    "not base58: {}", a);
        }
    }
}

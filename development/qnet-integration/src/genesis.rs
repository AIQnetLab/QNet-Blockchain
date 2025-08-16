//! Genesis block creation

use qnet_state::{Block, Transaction, TransactionType, ConsensusProof};
use crate::errors::IntegrationResult;
use chrono::Utc;

/// Genesis configuration
pub struct GenesisConfig {
    /// Initial accounts with balances
    pub accounts: Vec<(String, u64)>,
    /// Genesis timestamp
    pub timestamp: u64,
    /// Network name
    pub network: String,
}

impl Default for GenesisConfig {
    fn default() -> Self {
        // Use mainnet launch timestamp if set, otherwise current time
        let genesis_timestamp = std::env::var("QNET_MAINNET_LAUNCH_TIMESTAMP")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or_else(|| Utc::now().timestamp() as u64);
            
        Self {
            accounts: vec![
                // FAIR LAUNCH: Empty genesis - all QNC through Pool 1 Base Emission
                // Pool 1: Dynamic halving system (245,100.67 QNC/4h initial)
                // Sharp Drop Halving: ÷2 every 4 years, ÷10 at year 20-24
            ],
            timestamp: genesis_timestamp,
            network: "mainnet".to_string(),
        }
    }
}

/// Create genesis block
pub fn create_genesis_block(config: GenesisConfig) -> IntegrationResult<Block> {
    let mut transactions = Vec::new();
    
    // Create initial distribution transactions
    for (address, amount) in config.accounts {
        let tx = Transaction {
            hash: String::new(), // will be calculated
            from: "genesis".to_string(),
            to: Some(address.clone()),
            amount,
            nonce: 0,
            gas_price: 0, // no gas for genesis
            gas_limit: 0, // no gas limit
            timestamp: config.timestamp,
            signature: Some("genesis".to_string()),
            tx_type: TransactionType::Transfer {
                from: "genesis".to_string(),
                to: address.clone(),
                amount,
            },
            data: Some(format!("Genesis allocation to {}", address)),
        };
        transactions.push(tx);
    }
    
    // Create genesis block
    let previous_hash = [0u8; 32]; // all zeros for genesis
    let genesis_block = Block::new(
        0, // height 0
        config.timestamp,
        previous_hash,
        transactions,
        "genesis".to_string(), // producer
    );
    
    Ok(genesis_block)
} 

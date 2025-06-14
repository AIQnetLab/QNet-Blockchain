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
        Self {
            accounts: vec![
                // QNC emission: 2^32 = 4,294,967,296 (quantum blockchain reference!)
                // All tokens in rewards pool for fair distribution
                ("rewards".to_string(), 4_294_967_296), // 2^32 QNC total supply
            ],
            timestamp: Utc::now().timestamp() as u64,
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

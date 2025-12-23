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
        // CRITICAL: Use real time for Genesis Block creation
        // Only node_001 creates Genesis, others receive it with this timestamp
        let genesis_timestamp = std::env::var("QNET_MAINNET_LAUNCH_TIMESTAMP")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or_else(|| {
                // Use REAL current time + QUIC_INIT_OFFSET when Genesis is created by node_001
                // CRITICAL v2.42.1: Add offset to account for QUIC initialization time (10-15 sec)
                // Without this, first 10-30 blocks are created instantly "catching up" to real time,
                // overwhelming QUIC and causing block propagation failures
                // Other nodes receive Genesis and start production at the SAME future timestamp
                const QUIC_INIT_OFFSET_SECS: u64 = 15; // Time for QUIC connections to establish
                let real_time = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let genesis_time = real_time + QUIC_INIT_OFFSET_SECS;
                println!("[INFO][GEN] genesis_ts={} current={} quic_offset={}s", 
                         genesis_time, real_time, QUIC_INIT_OFFSET_SECS);
                genesis_time
            });
        
        // PRODUCTION v2.26: Auto-add benchmark accounts if QNET_BENCHMARK_MODE=true
        // This enables realistic TPS testing with valid balances on ALL nodes
        let benchmark_mode = std::env::var("QNET_BENCHMARK_MODE")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        
        let accounts = if benchmark_mode {
            // Add 1000 benchmark accounts with 1M QNC each for load testing
            // Total: 1B QNC reserved for benchmarks (doesn't affect Fair Launch economics)
            println!("[INFO][GEN] benchmark_mode accounts=1000 balance=1M_QNC");
            let one_million_qnc = 1_000_000_000_000_000u64; // 1M QNC in nanoQNC
            (0..1000)
                .map(|i| (format!("EON1benchmark{:06}", i), one_million_qnc))
                .collect()
        } else {
            // FAIR LAUNCH: Empty genesis - all QNC through Pool 1 Base Emission
            // Pool 1: Dynamic halving system (245,100.67 QNC/4h initial)
            // Sharp Drop Halving: ÷2 every 4 years, ÷10 at year 20-24
            vec![]
        };
            
        Self {
            accounts,
            timestamp: genesis_timestamp,
            network: "mainnet".to_string(),
        }
    }
}

/// Create genesis block
pub fn create_genesis_block(config: GenesisConfig) -> IntegrationResult<Block> {
    let mut transactions = Vec::new();
    
    // CRITICAL: Create system_rewards_pool account for reward distribution
    // This account is used as "from" address for RewardDistribution transactions
    let rewards_pool_tx = Transaction {
        hash: String::new(), // will be calculated
        from: "genesis".to_string(),
        to: Some("system_rewards_pool".to_string()),
        amount: 0, // Pool starts empty - rewards are emitted dynamically
        nonce: 0,
        gas_price: 0,
        gas_limit: 0,
        timestamp: config.timestamp,
        signature: Some("genesis".to_string()),
        public_key: None, // Not needed for genesis transactions
        tx_type: TransactionType::CreateAccount {
            address: "system_rewards_pool".to_string(),
            initial_balance: 0, // Starts empty - Pool 1 emission happens every 4 hours
        },
        data: Some("System rewards pool for lazy rewards distribution".to_string()),
        dilithium_signature: None,   // Genesis TX - no quantum sig
        dilithium_public_key: None,
    };
    transactions.push(rewards_pool_tx);
    
    // Create initial distribution transactions
    for (address, amount) in config.accounts {
        let tx = Transaction {
            hash: String::new(), // will be calculated
            from: "genesis".to_string(),
            to: Some(address.clone()),
            amount,
            nonce: 0,
            gas_price: 0, // no gas for genesis
            public_key: None, // Not needed for genesis transactions
            gas_limit: 0, // no gas limit
            timestamp: config.timestamp,
            signature: Some("genesis".to_string()),
            tx_type: TransactionType::Transfer {
                from: "genesis".to_string(),
                to: address.clone(),
                amount,
            },
            data: Some(format!("Genesis allocation to {}", address)),
            dilithium_signature: None,   // Genesis TX - no quantum sig
            dilithium_public_key: None,
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

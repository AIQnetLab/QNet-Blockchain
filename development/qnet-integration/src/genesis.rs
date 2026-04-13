//! Genesis block creation
//!
//! [SECURITY] Genesis block (height=0) uses protocol-level authorization.
//! Signature strings "system"/"genesis" are ONLY valid at block height 0.
//! All subsequent blocks require full cryptographic (Dilithium) signatures.

use qnet_state::{Block, Transaction, TransactionType};
use crate::errors::IntegrationResult;

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
        // Genesis timestamp: only node 001 calls this to CREATE genesis.
        // Nodes 002-005 receive the SAME serialized block via QUIC — identical bytes, identical hash.
        // now() is correct here because genesis is created ONCE by ONE node, not independently by each.
        let genesis_timestamp = std::env::var("QNET_MAINNET_LAUNCH_TIMESTAMP")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or_else(|| {
                // Add offset for QUIC initialization time (10-15 sec)
                // Without this, first blocks are created instantly "catching up" to real time,
                // overwhelming QUIC and causing block propagation failures
                const QUIC_INIT_OFFSET_SECS: u64 = 15;
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
            // [WARN] Benchmark mode — reduced to 100 accounts x 10K QNC = 1M total
            println!("[WARN][GENESIS] BENCHMARK_MODE_ACTIVE — NOT FOR PRODUCTION");
            println!("[WARN][GENESIS] benchmark_accounts=100 balance=10K_QNC total=1M_QNC");
            let ten_k_qnc = 10_000_000_000_000u64; // 10K QNC in nanoQNC
            (0..100)
                .map(|i| {
                    // Deterministic but non-obvious addresses via blake3 hash derivation
                    let hash = blake3::hash(format!("bench_{}", i).as_bytes());
                    let wallet = format!("EON1bench_{}", hex::encode(&hash.as_bytes()[..8]));
                    (wallet, ten_k_qnc)
                })
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
    
    // CRITICAL FIX v2.74.1: Create "genesis" account FIRST
    // This account is the source for all initial token distributions
    // Without this, Transfer TX fail with "Account not found: genesis"
    let total_distribution: u64 = config.accounts.iter().map(|(_, amt)| amt).sum();
    // [SECURITY] Genesis transactions use protocol-level authorization (signature="system"/"genesis")
    // These are valid ONLY in block height 0. The genesis block hash serves as the root of trust.
    // Cryptographic signatures are not required because:
    // 1. Genesis block is deterministic — all nodes produce identical genesis from the same config
    // 2. The genesis block hash is hardcoded/verified by all peers on first sync
    // 3. No private key exists for "system"/"genesis" — these are protocol-reserved identifiers
    let mut genesis_account_tx = Transaction {
        hash: String::new(),
        from: "system".to_string(), // System creates genesis account
        to: Some("genesis".to_string()),
        amount: 0,
        nonce: 0,
        gas_price: 0,
        gas_limit: 0,
        timestamp: config.timestamp,
        signature: Some("system".to_string()),
        public_key: None,
        tx_type: TransactionType::CreateAccount {
            address: "genesis".to_string(),
            initial_balance: total_distribution, // Enough for all distributions
        },
        data: Some("Genesis account - source of initial token distribution".to_string()),
        dilithium_signature: None,
        dilithium_public_key: None,
        chain_id: 0,
    };
    // CRITICAL: Calculate SHA3-256 hash for transaction
    genesis_account_tx.hash = genesis_account_tx.calculate_hash();
    transactions.push(genesis_account_tx);
    
    // Track nonce for "genesis" account - starts at 0, increments for each TX
    let mut genesis_nonce: u64 = 0;
    
    // CRITICAL: Create system_rewards_pool account for reward distribution
    // This account is used as "from" address for RewardDistribution transactions
    let mut rewards_pool_tx = Transaction {
        hash: String::new(), // will be calculated
        from: "genesis".to_string(),
        to: Some("system_rewards_pool".to_string()),
        amount: 0, // Pool starts empty - rewards are emitted dynamically
        nonce: genesis_nonce,
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
        chain_id: 0,
    };
    // CRITICAL: Calculate SHA3-256 hash for transaction
    rewards_pool_tx.hash = rewards_pool_tx.calculate_hash();
    transactions.push(rewards_pool_tx);
    genesis_nonce += 1; // nonce=1 for next TX
    
    // Create initial distribution transactions (now "genesis" account exists!)
    // v2.74.2: Sequential nonce to prevent "Invalid nonce" errors on other nodes
    for (address, amount) in config.accounts {
        let mut tx = Transaction {
            hash: String::new(), // will be calculated
            from: "genesis".to_string(),
            to: Some(address.clone()),
            amount,
            nonce: genesis_nonce,
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
            chain_id: 0,
        };
        // CRITICAL: Calculate SHA3-256 hash for transaction
        tx.hash = tx.calculate_hash();
        transactions.push(tx);
        genesis_nonce += 1; // Increment for next TX
    }
    
    println!("[INFO][GEN] genesis_txs={} (1 CreateAccount genesis + 1 CreateAccount rewards_pool + {} distributions)", 
             transactions.len(), genesis_nonce - 1);
    
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

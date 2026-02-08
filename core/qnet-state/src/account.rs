//! Account management and state

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Account address type
pub type Address = String;

/// Token amount type
pub type Amount = u64;

/// Account in the blockchain
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub address: String,
    pub balance: u64,
    pub nonce: u64,
    pub is_node: bool,
    pub node_type: Option<String>,

    pub reputation: f64,
    pub created_at: u64,
    pub updated_at: u64,
    
    // v2.96: CRITICAL SECURITY FIX - Store pending rewards in blockchain!
    // This prevents manipulation of local RocksDB to claim fraudulent rewards
    // All nodes can validate RewardDistribution TXs against this on-chain value
    // CRITICAL: #[serde(default)] is MANDATORY for backward compatibility with old blocks!
    #[serde(default)]
    pub pending_rewards: u64,

    // v3.35: Smart contract support -- store contract code hash and metadata
    // is_contract = true when account is a deployed contract
    // contract_code_hash: SHA3-256 of deployed WASM bytecode (stored in storage separately)
    // contract_storage: key-value storage for contract state
    #[serde(default)]
    pub is_contract: bool,
    #[serde(default)]
    pub contract_code_hash: Option<String>,
    #[serde(default)]
    pub contract_storage: HashMap<String, String>,
}

/// Account state (alias for compatibility)
pub type AccountState = Account;

/// Account metadata
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountMetadata {
    /// Creation timestamp
    pub created_at: u64,
    
    /// Last update timestamp
    pub updated_at: u64,
    
    /// Tags for indexing
    pub tags: Vec<String>,
    
    /// Custom properties
    pub properties: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
/// v3.18: Full node type REMOVED - only Light and Super remain
pub enum NodeType {
    Light,
    Super,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ActivationPhase {
    /// Phase 1 – 1DEV burn (external Solana token)
    Phase1,
    /// Phase 2 – QNC transferred to Pool 3 for redistribution (not burned)
    Phase2,
}

impl Default for AccountState {
    fn default() -> Self {
        Self {
            address: String::new(),
            balance: 0,
            nonce: 0,
            is_node: false,
            node_type: None,

            reputation: 0.0,
            created_at: 0,
            updated_at: 0,
            pending_rewards: 0,
            is_contract: false,
            contract_code_hash: None,
            contract_storage: HashMap::new(),
        }
    }
}

impl AccountState {
    
    /// Check if account is a smart contract (has deployed code)
    pub fn is_smart_contract(&self) -> bool {
        self.is_contract && self.contract_code_hash.is_some()
    }
    
    /// Check if account is a node
    pub fn is_node(&self) -> bool {
        self.is_node
    }
    
    /// Get node type if account is a node
    pub fn node_type(&self) -> Option<&String> {
        self.node_type.as_ref()
    }
    
    /// Transfer amount from this account
    pub fn transfer_out(&mut self, amount: Amount) -> Result<(), String> {
        if self.balance < amount {
            return Err(format!(
                "Insufficient balance: {} < {}",
                self.balance, amount
            ));
        }
        self.balance -= amount;
        self.nonce += 1;
        Ok(())
    }
    
    /// Transfer amount to this account
    pub fn transfer_in(&mut self, amount: Amount) {
        self.balance += amount;
    }
    
    /// Activate as node
    pub fn activate_node(
        &mut self,
        node_type: String,
        timestamp: u64,
    ) {
        self.is_node = true;
        self.node_type = Some(node_type);
        self.updated_at = timestamp;
    }
}

impl Account {
    /// Create new account
    pub fn new(address: Address) -> Self {
        Self {
            address,
            balance: 0,
            nonce: 0,
            is_node: false,
            node_type: None,

            reputation: 0.0,
            created_at: 0,
            updated_at: 0,
            pending_rewards: 0,
            is_contract: false,
            contract_code_hash: None,
            contract_storage: HashMap::new(),
        }
    }
    
    /// Create account with initial balance
    pub fn with_balance(address: Address, balance: Amount) -> Self {
        Self {
            address,
            balance,
            nonce: 0,
            is_node: false,
            node_type: None,

            reputation: 0.0,
            created_at: 0,
            updated_at: 0,
            pending_rewards: 0,
            is_contract: false,
            contract_code_hash: None,
            contract_storage: HashMap::new(),
        }
    }
    
    /// Update metadata timestamp
    pub fn touch(&mut self, timestamp: u64) {
        if self.created_at == 0 {
            self.created_at = timestamp;
        }
        self.updated_at = timestamp;
    }
}


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
pub enum NodeType {
    Light,
    Full,
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
        }
    }
}

impl AccountState {
    
    /// Check if account is a contract
    pub fn is_contract(&self) -> bool {
        self.node_type.is_some()
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

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_account_transfer() {
        let mut account = Account::with_balance("test".to_string(), 1000);
        
        // Successful transfer
        assert!(account.transfer_out(500).is_ok());
        assert_eq!(account.balance, 500);
        assert_eq!(account.nonce, 1);
        
        // Insufficient balance
        assert!(account.transfer_out(600).is_err());
        assert_eq!(account.balance, 500);
        assert_eq!(account.nonce, 1);
        
        // Transfer in
        account.transfer_in(300);
        assert_eq!(account.balance, 800);
    }
    
    #[test]
    fn test_node_activation() {
        let mut account = Account::new("test".to_string());
        assert!(!account.is_node());
        
        account.activate_node("Light".to_string(), 1234567890);
        
        assert!(account.is_node());
        assert_eq!(account.node_type(), Some(&"Light".to_string()));
    }
} 
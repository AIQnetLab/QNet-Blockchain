use std::collections::HashMap;
use crate::{Account, Transaction, StateResult, StateError};
use sha3::{Sha3_256, Digest};

/// StateManager for managing blockchain state
pub struct StateManager {
    accounts: HashMap<String, Account>,
}

impl StateManager {
    /// Create new StateManager
    pub fn new() -> Self {
        Self {
            accounts: HashMap::new(),
        }
    }
    
    /// Get account by address
    pub fn get_account(&self, address: &str) -> Option<&Account> {
        self.accounts.get(address)
    }
    
    /// Get account balance
    pub fn get_balance(&self, address: &str) -> u64 {
        self.accounts.get(address).map(|a| a.balance).unwrap_or(0)
    }
    
    /// Calculate the state root hash
    pub fn calculate_state_root(&self) -> StateResult<[u8; 32]> {
        // Sort accounts by address for deterministic ordering
        let mut sorted_accounts: Vec<(&String, &Account)> = self.accounts.iter().collect();
        sorted_accounts.sort_by_key(|(addr, _)| *addr);
        
        // Hash all account states
        let mut hasher = Sha3_256::new();
        for (address, account) in sorted_accounts {
            hasher.update(address.as_bytes());
            hasher.update(&account.balance.to_le_bytes());
            hasher.update(&account.nonce.to_le_bytes());
            // Hash additional fields
            hasher.update(&account.stake.to_le_bytes());
            hasher.update(&account.reputation.to_le_bytes());
            hasher.update(&(account.is_node as u8).to_le_bytes());
            if let Some(node_type) = &account.node_type {
                hasher.update(node_type.as_bytes());
            }
        }
        
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        Ok(hash)
    }
    
    /// Apply a transaction to the state
    pub fn apply_transaction(&mut self, tx: &Transaction) -> StateResult<()> {
        // Delegate to transaction's apply_to_state method
        tx.apply_to_state(&mut self.accounts)
    }
} 
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
    /// FIX R21-S1: Aligned with StateMerkleTree::hash_account() (state.rs:333-369)
    /// ONLY consensus-critical fields are included. Non-deterministic fields
    /// (reputation: f64, is_node, node_type, created_at, updated_at) are EXCLUDED
    /// to prevent cross-platform state root divergence.
    pub fn calculate_state_root(&self) -> StateResult<[u8; 32]> {
        // Sort accounts by address for deterministic ordering
        let mut sorted_accounts: Vec<(&String, &Account)> = self.accounts.iter().collect();
        sorted_accounts.sort_by_key(|(addr, _)| *addr);

        // Hash all account states — MUST match StateMerkleTree::hash_account()
        let mut hasher = Sha3_256::new();
        for (address, account) in sorted_accounts {
            hasher.update(b"QNET_ACCOUNT_V2:");
            // Consensus-critical fields ONLY
            hasher.update(&account.balance.to_le_bytes());
            hasher.update(&account.nonce.to_le_bytes());
            hasher.update(address.as_bytes());
            // Contract state
            hasher.update(&[account.is_contract as u8]);
            if let Some(ref code_hash) = &account.contract_code_hash {
                hasher.update(b"CODE:");
                hasher.update(code_hash.as_bytes());
            }
            if !account.contract_storage.is_empty() {
                hasher.update(b"STORAGE:");
                let mut sorted_keys: Vec<&String> = account.contract_storage.keys().collect();
                sorted_keys.sort();
                for key in &sorted_keys {
                    hasher.update(key.as_bytes());
                    hasher.update(account.contract_storage[*key].as_bytes());
                }
            }
            // EXCLUDED (non-deterministic or metadata-only):
            //   - reputation: f64 — non-deterministic across CPU architectures
            //   - is_node, node_type, created_at, updated_at: metadata only
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
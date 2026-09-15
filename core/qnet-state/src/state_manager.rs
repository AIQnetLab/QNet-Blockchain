use std::collections::HashMap;
use crate::{Account, Transaction, StateResult, StateError};

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
    
    // NOTE (V2): a second, off-consensus `calculate_state_root`/`hash_account` mirror lived here. It had
    // ZERO callers, already diverged from the canonical `state::StateMerkleTree::hash_account` (it omitted
    // pending_rewards/HB/LCE), and any future re-wire of it as the leaf hasher would silently fork the
    // chain. Deleted outright — the ONE authoritative account-leaf hasher is `StateMerkleTree::hash_account`.

    /// Apply a transaction to the state
    pub fn apply_transaction(&mut self, tx: &Transaction) -> StateResult<()> {
        // Delegate to transaction's apply_to_state method
        tx.apply_to_state(&mut self.accounts)
    }
} 
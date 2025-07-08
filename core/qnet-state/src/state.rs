//! State management for QNet blockchain

use std::collections::HashMap;
use std::sync::Arc;
use dashmap::DashMap;
use crate::{Account, Block, Transaction, StateError, StateResult};
use sha3::{Sha3_256, Digest};

/// Chain state information
#[derive(Debug, Clone)]
pub struct ChainState {
    /// Current blockchain height
    pub height: u64,
    /// Total supply of QNC
    pub total_supply: u64,
    /// Total staked amount
    pub total_staked: u64,
    /// Current epoch
    pub epoch: u64,
    /// Last finalized block
    pub last_finalized: u64,
}

impl Default for ChainState {
    fn default() -> Self {
        Self {
            height: 0,
            total_supply: 1_000_000_000 * 10u64.pow(9), // 1 billion QNC
            total_staked: 0,
            epoch: 0,
            last_finalized: 0,
        }
    }
}

/// State manager for blockchain
pub struct StateManager {
    /// Accounts state
    pub accounts: Arc<DashMap<String, Account>>,
    /// Chain state
    pub chain_state: Arc<parking_lot::RwLock<ChainState>>,
    /// State root
    state_root: Arc<parking_lot::RwLock<[u8; 32]>>,
}

impl StateManager {
    /// Create new state manager
    pub fn new() -> Self {
        Self {
            accounts: Arc::new(DashMap::new()),
            chain_state: Arc::new(parking_lot::RwLock::new(ChainState::default())),
            state_root: Arc::new(parking_lot::RwLock::new([0u8; 32])),
        }
    }
    
    /// Get account
    pub fn get_account(&self, address: &str) -> Option<Account> {
        self.accounts.get(address).map(|acc| acc.clone())
    }
    
    /// Update account
    pub fn update_account(&self, address: String, account: Account) {
        self.accounts.insert(address, account);
    }
    
    /// Get balance
    pub fn get_balance(&self, address: &str) -> u64 {
        self.accounts.get(address).map(|acc| acc.balance).unwrap_or(0)
    }
    
    /// Apply transaction
    pub fn apply_transaction(&self, tx: &Transaction) -> StateResult<()> {
        // Get mutable access to accounts
        let mut accounts_map = HashMap::new();
        
        // Copy relevant accounts
        if let Some(acc) = self.accounts.get(&tx.from) {
            accounts_map.insert(tx.from.clone(), acc.clone());
        }
        
        if let Some(to) = &tx.to {
            if let Some(acc) = self.accounts.get(to) {
                accounts_map.insert(to.clone(), acc.clone());
            }
        }
        
        // Apply transaction
        tx.apply_to_state(&mut accounts_map)?;
        
        // Write back changes
        for (address, account) in accounts_map {
            self.accounts.insert(address, account);
        }
        
        Ok(())
    }
    
    /// Apply block
    pub fn apply_block(&self, block: &Block) -> StateResult<()> {
        for tx in &block.transactions {
            self.apply_transaction(tx)?;
        }
        
        // Update chain state
        let mut chain_state = self.chain_state.write();
        chain_state.height = block.height;
        
        Ok(())
    }
    
    /// Get chain state
    pub fn get_chain_state(&self) -> ChainState {
        self.chain_state.read().clone()
    }
    
    /// Calculate state root hash
    pub fn calculate_state_root(&self) -> Result<[u8; 32], StateError> {
        let mut hasher = Sha3_256::new();
        
        // Get all accounts sorted by address
        let mut accounts: Vec<_> = self.accounts.iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect();
        accounts.sort_by(|a, b| a.0.cmp(&b.0));
        
        // Hash each account
        for (address, account) in accounts {
            hasher.update(address.as_bytes());
            hasher.update(&account.balance.to_le_bytes());
            hasher.update(&account.stake.to_le_bytes());
            hasher.update(&account.nonce.to_le_bytes());
        }
        
        // Include chain state
        let chain_state = self.chain_state.read();
        hasher.update(&chain_state.height.to_le_bytes());
        hasher.update(&chain_state.total_supply.to_le_bytes());
        hasher.update(&chain_state.total_staked.to_le_bytes());
        
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        
        // Update stored state root
        *self.state_root.write() = hash;
        
        Ok(hash)
    }
    
    /// Get current state root
    pub fn get_state_root(&self) -> [u8; 32] {
        *self.state_root.read()
    }
    
    /// Create genesis state
    pub fn create_genesis(&self) -> StateResult<()> {
        // Create genesis accounts
        let genesis_accounts = vec![
            ("genesis".to_string(), 100_000_000 * 10u64.pow(9)), // 100M QNC
            ("faucet".to_string(), 10_000_000 * 10u64.pow(9)),   // 10M QNC
        ];
        
        for (address, balance) in genesis_accounts {
            let mut account = Account::new(address.clone());
            account.balance = balance;
            self.accounts.insert(address, account);
        }
        
        // Calculate initial state root
        self.calculate_state_root()?;
        
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_state_manager() {
        let state = StateManager::new();
        
        // Create account
        let mut account = Account::new("alice".to_string());
        account.balance = 1000;
        state.update_account("alice".to_string(), account);
        
        // Check balance
        assert_eq!(state.get_balance("alice"), 1000);
        assert_eq!(state.get_balance("bob"), 0);
    }
    
    #[test]
    fn test_state_root() {
        let state = StateManager::new();
        
        // Empty state should have consistent root
        let root1 = state.calculate_state_root().unwrap();
        let root2 = state.calculate_state_root().unwrap();
        assert_eq!(root1, root2);
        
        // Adding account should change root
        let mut account = Account::new("alice".to_string());
        account.balance = 1000;
        state.update_account("alice".to_string(), account);
        
        let root3 = state.calculate_state_root().unwrap();
        assert_ne!(root1, root3);
    }
} 
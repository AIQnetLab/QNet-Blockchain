//! High-performance blockchain state management for QNet
//!
//! This crate provides efficient state storage and retrieval
//! with support for multiple backends and concurrent access.

#![warn(missing_docs)]
#![warn(clippy::all)]

pub mod account;
pub mod block;
pub mod transaction;
pub mod state_db;
pub mod errors;

#[cfg(feature = "python")]
mod python_bindings;

pub use account::{Account, AccountState};
pub use block::{Block, BlockHeader, ConsensusProof, BlockType, MicroBlock, MacroBlock, ConsensusData, LightMicroBlock, BlockHash};
pub use transaction::{Transaction, TransactionReceipt, TransactionType};
pub use state_db::StateDB;
pub use errors::{StateError, StateResult};

#[cfg(feature = "python")]
pub use python_bindings::*;

/// Re-export commonly used items
pub mod prelude {
    pub use crate::{
        Account, AccountState,
        Block, BlockHeader,
        Transaction, TransactionReceipt,
        StateDB,
        StateError, StateResult,
    };
}

// Re-export common types
pub type Address = [u8; 20];
pub type Hash = [u8; 32];
pub type Amount = u64;
pub type Nonce = u64;

/// Trait for state backend implementations
pub trait StateBackend {
    /// Get block by hash
    fn get_block(&self, hash: &BlockHash) -> StateResult<Option<Block>>;
    
    /// Store block
    fn store_block(&mut self, block: &Block) -> StateResult<()>;
    
    /// Get account by address
    fn get_account(&self, address: &str) -> StateResult<Option<Account>>;
    
    /// Store account
    fn store_account(&mut self, address: &str, account: &Account) -> StateResult<()>;
}

/// StateManager for managing blockchain state
pub struct StateManager {
    accounts: std::collections::HashMap<String, Account>,
}

impl StateManager {
    /// Create new StateManager
    pub fn new() -> Self {
        Self {
            accounts: std::collections::HashMap::new(),
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
        use sha3::{Sha3_256, Digest};
        
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
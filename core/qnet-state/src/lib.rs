//! High-performance blockchain state management for QNet
//!
//! This crate provides efficient state storage and retrieval
//! with support for multiple backends and concurrent access.

#![allow(unused_imports)]
#![allow(unused_variables)]
#![allow(dead_code)]
#![allow(missing_docs)]

pub mod account;
pub mod block;
pub mod transaction;
pub mod state_db;
pub mod state_manager;
pub mod errors;
pub mod state;

#[cfg(feature = "python")]
mod python_bindings;

pub use account::{Account, AccountState};
pub use block::{Block, BlockHeader, ConsensusProof, BlockType, MicroBlock, MacroBlock, ConsensusData, LightMicroBlock, BlockHash, EfficientMicroBlock, StoredMicroBlock, PoHState, storage_version};
pub use transaction::{Transaction, TransactionReceipt, TransactionType, gas_limits, PingSampleData};
pub use state_db::StateDB;
pub use state_manager::StateManager;
pub use errors::{StateError, StateResult};
pub use state::{StateManager as State, MAX_QNC_SUPPLY, MAX_QNC_SUPPLY_NANO};

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

// StateManager moved to state_manager.rs module 
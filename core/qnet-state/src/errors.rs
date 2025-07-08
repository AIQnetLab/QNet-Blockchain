//! Error types for state management

use thiserror::Error;

/// State management errors
#[derive(Error, Debug)]
pub enum StateError {
    /// Account not found
    #[error("Account not found: {0}")]
    AccountNotFound(String),
    
    /// Insufficient balance
    #[error("Insufficient balance: have {have}, need {need}")]
    InsufficientBalance { have: u64, need: u64 },
    
    /// Invalid transaction
    #[error("Invalid transaction: {0}")]
    InvalidTransaction(String),
    
    /// Invalid block
    #[error("Invalid block: {0}")]
    InvalidBlock(String),
    
    /// Storage error
    #[error("Storage error: {0}")]
    StorageError(String),
    
    /// Serialization error
    #[error("Serialization error: {0}")]
    SerializationError(#[from] bincode::Error),
    
    /// JSON error
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
    
    /// IO error
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    
    /// Other error
    #[error("Other error: {0}")]
    Other(String),
}

impl From<String> for StateError {
    fn from(s: String) -> Self {
        StateError::Other(s)
    }
}

/// Result type for state operations
pub type StateResult<T> = Result<T, StateError>;

 
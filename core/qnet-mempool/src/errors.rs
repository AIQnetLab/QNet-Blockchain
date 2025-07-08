//! Error types for mempool operations

use thiserror::Error;
use qnet_state::transaction::TxHash;

/// Mempool-related errors
#[derive(Error, Debug)]
pub enum MempoolError {
    /// Transaction already exists in mempool
    #[error("Transaction already exists: {0}")]
    DuplicateTransaction(TxHash),
    
    /// Invalid transaction
    #[error("Invalid transaction: {0}")]
    InvalidTransaction(String),
    
    /// Nonce too low
    #[error("Nonce too low: expected >= {expected}, got {got}")]
    NonceTooLow { expected: u64, got: u64 },
    
    /// Nonce gap detected
    #[error("Nonce gap: expected {expected}, got {got}")]
    NonceGap { expected: u64, got: u64 },
    
    /// Insufficient gas price
    #[error("Gas price too low: minimum {min}, got {got}")]
    GasPriceTooLow { min: u64, got: u64 },
    
    /// Mempool is full
    #[error("Mempool is full: capacity {capacity}")]
    MempoolFull { capacity: usize },
    
    /// Account limit exceeded
    #[error("Account transaction limit exceeded: {limit}")]
    AccountLimitExceeded { limit: usize },
    
    /// Transaction expired
    #[error("Transaction expired: age {age_secs}s > max {max_age_secs}s")]
    TransactionExpired { age_secs: u64, max_age_secs: u64 },
    
    /// Validation error
    #[error("Validation failed: {0}")]
    ValidationFailed(String),
    
    /// State error
    #[error("State error: {0}")]
    StateError(#[from] qnet_state::errors::StateError),
    
    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),
}

/// Result type for mempool operations
pub type MempoolResult<T> = Result<T, MempoolError>; 
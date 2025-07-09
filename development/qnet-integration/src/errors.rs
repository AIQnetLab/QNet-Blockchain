//! Error types for integration module

use thiserror::Error;

/// Integration errors
#[derive(Error, Debug)]
pub enum IntegrationError {
    #[error("State error: {0}")]
    StateError(String),
    
    #[error("Mempool error: {0}")]
    MempoolError(String),
    
    #[error("Consensus error: {0}")]
    ConsensusError(String),
    
    #[error("Storage error: {0}")]
    StorageError(String),
    
    #[error("Validation error: {0}")]
    ValidationError(String),
    
    #[error("Serialization error: {0}")]
    SerializationError(String),
    
    #[error("Deserialization error: {0}")]
    DeserializationError(String),
    
    #[error("Invalid signature")]
    InvalidSignature,
    
    #[error("Account not found: {0}")]
    AccountNotFound(String),
    
    #[error("Already running")]
    AlreadyRunning,
    
    #[error("Blockchain not running")]
    NotRunning,
    
    #[error("Network error: {0}")]
    NetworkError(String),
    
    #[error("Other error: {0}")]
    Other(String),
}

/// Result type for integration operations
pub type IntegrationResult<T> = Result<T, IntegrationError>; 

#[derive(Debug, thiserror::Error)]
pub enum QNetError {
    #[error("Storage error: {0}")]
    StorageError(String),
    
    #[error("State error: {0}")]
    StateError(String),
    
    #[error("Consensus error: {0}")]
    ConsensusError(String),
    
    #[error("Network error: {0}")]
    NetworkError(String),
    
    #[error("Validation error: {0}")]
    ValidationError(String),
    
    #[error("Serialization error: {0}")]
    SerializationError(String),
    
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    
    #[error("Mempool error: {0}")]
    MempoolError(String),
    
    #[error("RocksDB error: {0}")]
    RocksDBError(#[from] rocksdb::Error),
    
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

// TODO: Implement proper mempool error conversion
// impl From<qnet_mempool::MempoolError> for QNetError {
//     fn from(err: qnet_mempool::MempoolError) -> Self {
//         QNetError::MempoolError(err.to_string())
//     }
// }

impl From<crate::validator::ValidationError> for IntegrationError {
    fn from(err: crate::validator::ValidationError) -> Self {
        IntegrationError::ValidationError(err.to_string())
    }
} 
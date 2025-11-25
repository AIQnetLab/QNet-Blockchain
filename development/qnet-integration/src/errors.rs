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
    
    #[error("Security error: {0}")]
    SecurityError(String),
    
    #[error("Blockchain error: {0}")]
    BlockchainError(String),
    
    #[error("Cryptographic error: {0}")]
    CryptoError(String),
    
    #[error("Rate limit exceeded: {0}")]
    RateLimitExceeded(String),
    
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
    
    #[error("Sync error: {0}")]
    SyncError(String),
    
    #[error("Validation error: {0}")]
    ValidationError(String),
    
    #[error("Security error: {0}")]
    SecurityError(String),
    
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
    
    #[error("Already running")]
    AlreadyRunning,
    
    #[error("Account not found: {0}")]
    AccountNotFound(String),
}

// PRODUCTION: Mempool error conversion for transaction handling
impl From<qnet_mempool::MempoolError> for QNetError {
    fn from(err: qnet_mempool::MempoolError) -> Self {
        QNetError::MempoolError(err.to_string())
    }
}

impl From<qnet_mempool::MempoolError> for IntegrationError {
    fn from(err: qnet_mempool::MempoolError) -> Self {
        IntegrationError::MempoolError(err.to_string())
    }
}

impl From<crate::validator::ValidationError> for IntegrationError {
    fn from(err: crate::validator::ValidationError) -> Self {
        IntegrationError::ValidationError(err.to_string())
    }
}

impl From<rocksdb::Error> for IntegrationError {
    fn from(err: rocksdb::Error) -> Self {
        IntegrationError::StorageError(err.to_string())
    }
}

impl From<std::io::Error> for IntegrationError {
    fn from(err: std::io::Error) -> Self {
        IntegrationError::Other(err.to_string())
    }
}

impl From<qnet_state::StateError> for IntegrationError {
    fn from(err: qnet_state::StateError) -> Self {
        IntegrationError::StateError(err.to_string())
    }
}

impl From<IntegrationError> for QNetError {
    fn from(err: IntegrationError) -> Self {
        match err {
            IntegrationError::StorageError(msg) => QNetError::StorageError(msg),
            IntegrationError::NetworkError(msg) => QNetError::NetworkError(msg),
            IntegrationError::ValidationError(msg) => QNetError::ValidationError(msg),
            IntegrationError::SerializationError(msg) => QNetError::SerializationError(msg),
            IntegrationError::StateError(msg) => QNetError::StateError(msg),
            IntegrationError::MempoolError(msg) => QNetError::MempoolError(msg),
            IntegrationError::ConsensusError(msg) => QNetError::ConsensusError(msg),
            IntegrationError::AlreadyRunning => QNetError::AlreadyRunning,
            IntegrationError::AccountNotFound(addr) => QNetError::AccountNotFound(addr),
            _ => QNetError::InvalidInput(err.to_string()),
        }
    }
}

impl From<qnet_state::StateError> for QNetError {
    fn from(err: qnet_state::StateError) -> Self {
        QNetError::StateError(err.to_string())
    }
} 
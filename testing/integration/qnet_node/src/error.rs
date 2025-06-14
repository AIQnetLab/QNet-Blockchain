//! Node error types

use thiserror::Error;

/// Node errors
#[derive(Error, Debug)]
pub enum NodeError {
    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    
    /// Network error
    #[error("Network error: {0}")]
    Network(#[from] qnet_p2p::NetworkError),
    
    /// Consensus error
    #[error("Consensus error: {0}")]
    Consensus(String),
    
    /// State error
    #[error("State error: {0}")]
    State(#[from] qnet_state::StateError),
    
    /// Configuration error
    #[error("Configuration error: {0}")]
    Config(String),
    
    /// Sync error
    #[error("Sync error: {0}")]
    Sync(String),
    
    /// API error
    #[error("API error: {0}")]
    Api(String),
    
    /// Already running
    #[error("Node is already running")]
    AlreadyRunning,
    
    /// Not running
    #[error("Node is not running")]
    NotRunning,
}

/// Result type for node operations
pub type NodeResult<T> = Result<T, NodeError>; 
//! Error types for consensus module

/// Consensus error types
#[derive(Debug, Clone, PartialEq)]
pub enum ConsensusError {
    /// Invalid operation
    InvalidOperation(String),
    
    /// Invalid proof
    InvalidProof(String),
    
    /// Invalid commit
    InvalidCommit(String),
    
    /// Invalid reveal
    InvalidReveal(String),
    
    /// Invalid signature
    InvalidSignature(String),
    
    /// Invalid node type
    InvalidNodeType(String),
    
    /// Invalid phase
    InvalidPhase(String),
    
    /// Storage error
    StorageError(String),
    
    /// Network error
    NetworkError(String),
    
    /// Serialization error
    SerializationError(String),
    
    /// Insufficient nodes for consensus
    InsufficientNodes,
    
    /// No active consensus round
    NoActiveRound,
    
    /// Phase timeout
    PhaseTimeout(String),
    
    /// No valid reveals
    NoValidReveals,
    
    /// Leader selection failed
    LeaderSelectionFailed,
    
    /// Double signing detected
    DoubleSigningDetected(String),
}

impl std::fmt::Display for ConsensusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConsensusError::InvalidOperation(msg) => write!(f, "Invalid operation: {}", msg),
            ConsensusError::InvalidProof(msg) => write!(f, "Invalid proof: {}", msg),
            ConsensusError::InvalidCommit(msg) => write!(f, "Invalid commit: {}", msg),
            ConsensusError::InvalidReveal(msg) => write!(f, "Invalid reveal: {}", msg),
            ConsensusError::InvalidSignature(msg) => write!(f, "Invalid signature: {}", msg),
            ConsensusError::InvalidNodeType(msg) => write!(f, "Invalid node type: {}", msg),
            ConsensusError::InvalidPhase(msg) => write!(f, "Invalid phase: {}", msg),
            ConsensusError::StorageError(msg) => write!(f, "Storage error: {}", msg),
            ConsensusError::NetworkError(msg) => write!(f, "Network error: {}", msg),
            ConsensusError::SerializationError(msg) => write!(f, "Serialization error: {}", msg),
            ConsensusError::InsufficientNodes => write!(f, "Insufficient nodes for consensus"),
            ConsensusError::NoActiveRound => write!(f, "No active consensus round"),
            ConsensusError::PhaseTimeout(msg) => write!(f, "Phase timeout: {}", msg),
            ConsensusError::NoValidReveals => write!(f, "No valid reveals received"),
            ConsensusError::LeaderSelectionFailed => write!(f, "Leader selection failed"),
            ConsensusError::DoubleSigningDetected(msg) => write!(f, "Double signing detected: {}", msg),
        }
    }
}

impl std::error::Error for ConsensusError {}

/// Result type for consensus operations
pub type ConsensusResult<T> = Result<T, ConsensusError>; 
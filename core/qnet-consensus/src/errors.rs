//! Error types for consensus module

use thiserror::Error;

/// Consensus error types
#[derive(Error, Debug)]
pub enum ConsensusError {
    /// Invalid commit format
    #[error("Invalid commit: {0}")]
    InvalidCommit(String),
    
    /// Invalid reveal format
    #[error("Invalid reveal: {0}")]
    InvalidReveal(String),
    
    /// Insufficient reveals for consensus
    #[error("Insufficient reveals: {actual} < {required}")]
    InsufficientReveals { actual: usize, required: usize },
    
    /// Round timeout
    #[error("Round timeout")]
    RoundTimeout,
    
    /// No active round
    #[error("No active round")]
    NoActiveRound,
    
    /// Invalid phase
    #[error("Invalid phase: {0}")]
    InvalidPhase(String),
    
    /// Phase timeout
    #[error("Phase timeout: {0}")]
    PhaseTimeout(String),
    
    /// Insufficient nodes
    #[error("Insufficient nodes for consensus")]
    InsufficientNodes,
    
    /// Leader selection failed
    #[error("Leader selection failed")]
    LeaderSelectionFailed,
    
    /// Reputation too low
    #[error("Reputation too low: {reputation} < {threshold}")]
    ReputationTooLow { reputation: f64, threshold: f64 },
    
    /// Duplicate commit
    #[error("Duplicate commit from node: {0}")]
    DuplicateCommit(String),
    
    /// Duplicate reveal
    #[error("Duplicate reveal from node: {0}")]
    DuplicateReveal(String),
    
    /// Double signing detected
    #[error("Double signing detected from node: {0}")]
    DoubleSigningDetected(String),
    
    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),
}

/// Result type for consensus operations
pub type ConsensusResult<T> = Result<T, ConsensusError>; 
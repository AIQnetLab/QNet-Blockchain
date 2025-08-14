//! Core types for the consensus mechanism

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

/// Node address type (public key)
pub type NodeAddress = String;

/// Round number type
pub type RoundNumber = u64;

/// Consensus phase
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConsensusPhase {
    /// Commit phase
    Commit,
    /// Reveal phase
    Reveal,
    /// Finalize phase
    Finalize,
}

impl Default for ConsensusPhase {
    fn default() -> Self {
        ConsensusPhase::Commit
    }
}

/// Round status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RoundStatus {
    /// Round is active
    Active,
    /// Round completed successfully
    Completed,
    /// Round failed
    Failed,
}

/// Configuration for consensus mechanism
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsensusConfig {
    /// Duration of commit phase in milliseconds
    pub commit_duration_ms: u64,
    
    /// Duration of reveal phase in milliseconds
    pub reveal_duration_ms: u64,
    
    /// Minimum reputation score to participate
    pub reputation_threshold: f64,
    
    /// Weight for participation in reputation calculation
    pub participation_weight: f64,
    
    /// Weight for response time in reputation calculation
    pub response_time_weight: f64,
    
    /// Weight for block quality in reputation calculation
    pub block_quality_weight: f64,
}

impl Default for ConsensusConfig {
    fn default() -> Self {
        Self {
            commit_duration_ms: 60000,  // 60 seconds
            reveal_duration_ms: 30000,  // 30 seconds
            reputation_threshold: 0.7,   // FIXED: 0-1 scale (70.0/100.0 from config)
            participation_weight: 0.4,
            response_time_weight: 0.3,
            block_quality_weight: 0.3,
        }
    }
}

/// Commit data structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Commit {
    /// Hash of the committed value
    pub hash: String,
    /// Timestamp of commit (milliseconds since epoch)
    pub timestamp: u64,
    /// Signature of the commit
    pub signature: String,
}

/// Reveal data structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reveal {
    /// The revealed value
    pub value: String,
    /// Nonce used in commit
    pub nonce: String,
    /// Timestamp of reveal (milliseconds since epoch)
    pub timestamp: u64,
}

/// Complete state of a consensus round
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoundState {
    /// Round number
    pub round: u64,
    /// Start time of the round (milliseconds since epoch)
    pub start_time: u64,
    /// Current phase
    pub phase: ConsensusPhase,
    /// Commits received
    pub commits: HashMap<String, Commit>,
    /// Reveals received
    pub reveals: HashMap<String, Reveal>,
    /// End time of commit phase (milliseconds since epoch)
    pub commit_end_time: u64,
    /// End time of reveal phase (milliseconds since epoch)
    pub reveal_end_time: u64,
    /// Selected leader for this round
    pub round_winner: Option<String>,
    /// Winning value (normalized)
    pub winning_value: Option<f64>,
    /// Difficulty for this round
    pub difficulty: f64,
    /// Round status
    pub status: RoundStatus,
    /// Round duration (if complete)
    pub round_time: Option<Duration>,
}

/// Reputation configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReputationConfig {
    /// Size of history to maintain
    pub history_size: usize,
    /// Weight for participation score
    pub weight_participation: f64,
    /// Weight for response time score
    pub weight_response_time: f64,
    /// Weight for block quality score
    pub weight_block_quality: f64,
    /// Default reputation for new nodes (0-100 scale)
    pub default_reputation: f64,
    /// Minimum data points required
    pub min_data_points: usize,
    /// Decay factor for time-weighted averages
    pub decay_factor: f64,
    /// Penalty for invalid reveal (0-100 scale)
    pub penalty_invalid_reveal: f64,
    /// Penalty for mining failure (0-100 scale)
    pub penalty_mining_failure: f64,
    /// Reward for participation (0-100 scale)
    pub reward_participation: f64,
    /// Reward for being selected as leader (0-100 scale)
    pub reward_leader: f64,
    /// Regression factor towards mean
    pub regression_factor: f64,
    /// Smoothing factor for reputation updates
    pub smoothing_factor: f64,
}

impl Default for ReputationConfig {
    fn default() -> Self {
        Self {
            history_size: 100,
            weight_participation: 0.4,
            weight_response_time: 0.3,
            weight_block_quality: 0.3,
            default_reputation: 50.0,          // FIXED: 0-100 scale
            min_data_points: 5,
            decay_factor: 0.95,
            penalty_invalid_reveal: 20.0,      // FIXED: 0-100 scale
            penalty_mining_failure: 10.0,      // FIXED: 0-100 scale
            reward_participation: 5.0,         // FIXED: 0-100 scale
            reward_leader: 10.0,               // FIXED: 0-100 scale
            regression_factor: 0.95,
            smoothing_factor: 0.2,
        }
    }
}

/// Node information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInfo {
    /// Node address/ID
    pub address: String,
    /// Reputation score
    pub reputation: f64,
    /// Last seen timestamp (milliseconds since epoch)
    pub last_seen: u64,
    /// Number of successful rounds
    pub successful_rounds: u64,
    /// Number of failed rounds
    pub failed_rounds: u64,
}

/// Consensus state
#[derive(Debug, Clone, Default)]
pub struct ConsensusState {
    /// Current round
    pub round: u64,
    /// Current phase
    pub phase: ConsensusPhase,
}

/// Commit data
#[derive(Debug, Clone)]
pub struct CommitData {
    /// Commit hash
    pub hash: String,
    /// Timestamp
    pub timestamp: u64,
}

/// Reveal data
#[derive(Debug, Clone)]
pub struct RevealData {
    /// Revealed value
    pub value: String,
    /// Nonce
    pub nonce: String,
}

/// Validator info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorInfo {
    /// Validator address
    pub address: String,

    /// Reputation score (0-100)
    pub reputation: f64,
    /// Score for consensus participation (0-100)
    pub score: u8,
    /// Last participation timestamp
    pub last_participation: u64,
    /// Number of violations detected
    pub violation_count: u32,
}

/// Consensus message
#[derive(Debug, Clone)]
pub enum ConsensusMessage {
    /// Commit message
    Commit(CommitData),
    /// Reveal message
    Reveal(RevealData),
}

/// Consensus round
#[derive(Debug, Clone)]
pub struct ConsensusRound {
    /// Round number
    pub number: u64,
    /// Participants
    pub participants: Vec<ValidatorInfo>,
}

/// Evidence of double signing by a validator
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoubleSignEvidence {
    /// Round where double signing occurred
    pub round: u64,
    /// First block hash signed
    pub hash_a: [u8; 32],
    /// Second block hash signed (conflicting)
    pub hash_b: [u8; 32],
    /// Validator address who committed the violation
    pub offender: String,
    /// Timestamp when evidence was detected
    pub detected_at: u64,
    /// Signatures as proof
    pub signature_a: Vec<u8>,
    pub signature_b: Vec<u8>,
}

/// Evidence of any consensus violation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Evidence {
    /// Double signing evidence
    DoubleSign(DoubleSignEvidence),
    // Future evidence types can be added here
}

/// Slashing result after processing evidence
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashingResult {
    /// Validator that was slashed
    pub validator: String,
    /// Penalty applied to reputation
    pub reputation_penalty: f64,
    /// Score penalty applied
    pub score_penalty: u8,
    /// Whether validator was banned
    pub banned: bool,
    /// Timestamp of slashing
    pub slashed_at: u64,
} 
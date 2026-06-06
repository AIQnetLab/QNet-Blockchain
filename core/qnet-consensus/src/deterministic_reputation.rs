//! Deterministic Reputation — on-chain slashing/jail PRIMITIVES + parameters.
//!
//! HISTORY: this module previously also hosted `DeterministicReputationState`, a
//! per-node RAM telemetry engine (rotation rewards, passive recovery, snapshot
//! sync). That engine was display/telemetry-only and has been REMOVED — it never
//! gated consensus. Consensus eligibility is decided solely by the deterministic
//! chain fold (`compute_consensus_reputation_map` + the macroblock
//! `eligible_producers` snapshot + uniform-VRF sortition) in qnet-integration.
//!
//! WHAT REMAINS (still used on-chain):
//! - All `pub const` reputation parameters (thresholds, rewards, penalties,
//!   jail durations, passive-recovery bounds, scalability limits).
//! - `SlashingType`, `SlashingEvent`, `AutomaticJail` — these are part of the
//!   on-chain `MacroBlockConsensusData` type in `macro_consensus.rs`.

use serde::{Deserialize, Serialize};
use sha3::{Sha3_256, Digest};

// ============================================================================
// CONSTANTS - Blockchain-standard approach
// ============================================================================

/// Starting reputation for all nodes (consensus threshold)
pub const INITIAL_REPUTATION: f64 = 70.0;

/// Maximum reputation cap
pub const MAX_REPUTATION: f64 = 100.0;

/// Minimum reputation (below = excluded from consensus)
pub const MIN_CONSENSUS_REPUTATION: f64 = 70.0;

/// Reputation for automatic jail trigger
pub const JAIL_THRESHOLD: f64 = 10.0;

/// Blocks per rotation (30 blocks = one producer cycle)
pub const BLOCKS_PER_ROTATION: u64 = 30;

/// Blocks per macroblock (consensus checkpoint)
pub const BLOCKS_PER_MACROBLOCK: u64 = 90;

/// Consecutive missed blocks for automatic jail
pub const AUTO_JAIL_MISSED_BLOCKS: u64 = 5;

// ============================================================================
// SCALABILITY CONSTANTS - For 10,000+ node networks
// ============================================================================

/// Chunk size for batch processing (prevents blocking)
pub const PROCESSING_CHUNK_SIZE: usize = 1000;

/// Max slashing events per macroblock (prevents DoS)
pub const MAX_SLASHING_EVENTS_PER_MACROBLOCK: usize = 100;

/// Max automatic jails per macroblock
pub const MAX_AUTO_JAILS_PER_MACROBLOCK: usize = 50;

// ============================================================================
// REWARD/PENALTY CONSTANTS (documented and verifiable)
// ============================================================================

/// Reward for completing full 30-block rotation as producer
pub const REWARD_FULL_ROTATION: f64 = 2.0;

/// Reward for participating in macroblock consensus (commit + reveal)
pub const REWARD_CONSENSUS_PARTICIPATION: f64 = 1.0;

/// Penalty for producing invalid block (Byzantine attack)
pub const PENALTY_INVALID_BLOCK: f64 = 20.0;

/// Penalty for double signing (signing two blocks at same height)
pub const PENALTY_DOUBLE_SIGN: f64 = 50.0;

/// Penalty for missing assigned block production
pub const PENALTY_MISSED_BLOCK: f64 = 2.0;

/// Penalty for missing consensus participation
pub const PENALTY_MISSED_CONSENSUS: f64 = 1.0;

// ============================================================================
// JAIL DURATIONS (progressive, same for ALL nodes including Genesis)
// ============================================================================

/// Jail duration for first offense (1 hour)
pub const JAIL_DURATION_1: u64 = 3600;

/// Jail duration for second offense (24 hours)
pub const JAIL_DURATION_2: u64 = 86400;

/// Jail duration for third offense (7 days)
pub const JAIL_DURATION_3: u64 = 604800;

/// Jail duration for fourth offense (30 days)
pub const JAIL_DURATION_4: u64 = 2592000;

/// Jail duration for fifth offense (90 days)
pub const JAIL_DURATION_5: u64 = 7776000;

/// Jail duration for 6+ offenses (1 year)
pub const JAIL_DURATION_MAX: u64 = 31536000;

/// Permanent ban marker
pub const PERMANENT_BAN: u64 = u64::MAX;

// ============================================================================
// PASSIVE RECOVERY - For nodes with reputation 10-69%
// ============================================================================

/// Passive recovery interval (every 4 hours = 14400 seconds)
pub const PASSIVE_RECOVERY_INTERVAL: u64 = 14400;

/// Passive recovery amount per interval (+1%)
pub const PASSIVE_RECOVERY_AMOUNT: f64 = 1.0;

/// Minimum reputation for passive recovery (below = cannot recover)
pub const PASSIVE_RECOVERY_MIN: f64 = 10.0;

/// Maximum reputation for passive recovery (above = no passive recovery needed)
pub const PASSIVE_RECOVERY_MAX: f64 = 70.0;

// ============================================================================
// SLASHING EVENT - Recorded in MacroBlock with cryptographic proof
// ============================================================================

/// Types of slashable offenses (must have cryptographic proof)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SlashingType {
    /// Signed two different blocks at same height
    /// Proof: Both signed blocks with same height but different hashes
    DoubleSign {
        height: u64,
        hash_a: [u8; 32],
        hash_b: [u8; 32],
        signature_a: Vec<u8>,
        signature_b: Vec<u8>,
    },

    /// Produced cryptographically invalid block
    /// Proof: The invalid block itself (fails verification)
    InvalidBlock {
        height: u64,
        block_hash: [u8; 32],
        reason: String,
    },

    /// Attempted chain fork (critical - permanent ban)
    /// Proof: Conflicting blocks signed by same node
    ChainFork {
        fork_height: u64,
        main_chain_hash: [u8; 32],
        fork_chain_hash: [u8; 32],
    },

    /// Missed N consecutive assigned blocks
    /// Proof: Block heights where node was assigned but didn't produce
    ConsecutiveMissedBlocks {
        missed_heights: Vec<u64>,
    },
}

/// Slashing event recorded in macroblock
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashingEvent {
    /// Node being slashed
    pub offender: String,

    /// Type of offense with proof
    pub offense: SlashingType,

    /// Penalty amount (reputation points)
    pub penalty: f64,

    /// Block height when detected
    pub detected_at_height: u64,

    /// Reporter node (gets small reward for reporting)
    pub reporter: String,

    /// SHA3 hash of evidence for verification
    pub evidence_hash: [u8; 32],
}

impl SlashingEvent {
    /// Calculate penalty based on offense type
    pub fn calculate_penalty(offense: &SlashingType) -> f64 {
        match offense {
            SlashingType::DoubleSign { .. } => PENALTY_DOUBLE_SIGN,
            SlashingType::InvalidBlock { .. } => PENALTY_INVALID_BLOCK,
            SlashingType::ChainFork { .. } => 100.0, // Full reputation loss
            SlashingType::ConsecutiveMissedBlocks { missed_heights } => {
                PENALTY_MISSED_BLOCK * missed_heights.len() as f64
            }
        }
    }

    /// v3.33: ALL slashing offenses = permanent ban, no recovery.
    /// QNet has no staking — the only deterrent is irrevocable network exclusion.
    /// Cryptographic proof is required for all offenses (no false positives).
    pub fn is_permanent_ban(offense: &SlashingType) -> bool {
        match offense {
            SlashingType::DoubleSign { .. } => true,
            SlashingType::InvalidBlock { .. } => true,
            SlashingType::ChainFork { .. } => true,
            SlashingType::ConsecutiveMissedBlocks { .. } => false,
        }
    }

    /// Compute evidence hash for verification
    pub fn compute_evidence_hash(offense: &SlashingType) -> [u8; 32] {
        let mut hasher = Sha3_256::new();

        match offense {
            SlashingType::DoubleSign { height, hash_a, hash_b, signature_a, signature_b } => {
                hasher.update(b"DOUBLE_SIGN:");
                hasher.update(&height.to_le_bytes());
                hasher.update(hash_a);
                hasher.update(hash_b);
                hasher.update(signature_a);
                hasher.update(signature_b);
            }
            SlashingType::InvalidBlock { height, block_hash, reason } => {
                hasher.update(b"INVALID_BLOCK:");
                hasher.update(&height.to_le_bytes());
                hasher.update(block_hash);
                hasher.update(reason.as_bytes());
            }
            SlashingType::ChainFork { fork_height, main_chain_hash, fork_chain_hash } => {
                hasher.update(b"CHAIN_FORK:");
                hasher.update(&fork_height.to_le_bytes());
                hasher.update(main_chain_hash);
                hasher.update(fork_chain_hash);
            }
            SlashingType::ConsecutiveMissedBlocks { missed_heights } => {
                hasher.update(b"MISSED_BLOCKS:");
                for h in missed_heights {
                    hasher.update(&h.to_le_bytes());
                }
            }
        }

        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }

    /// Verify evidence is valid and matches hash
    pub fn verify_evidence(&self) -> bool {
        let computed_hash = Self::compute_evidence_hash(&self.offense);
        computed_hash == self.evidence_hash
    }
}

// ============================================================================
// AUTOMATIC JAIL - Recorded in MacroBlock (deterministic trigger)
// ============================================================================

/// Automatic jail event (computed deterministically from blocks)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomaticJail {
    /// Node being jailed
    pub node_id: String,

    /// Offense count (progressive jail duration)
    pub offense_count: u32,

    /// Block height when jail starts
    pub jail_start_height: u64,

    /// Duration in seconds
    pub jail_duration: u64,

    /// Reason
    pub reason: String,

    /// Hash of evidence (missed block heights, etc.)
    pub evidence_hash: [u8; 32],
}

impl AutomaticJail {
    /// Calculate jail duration based on offense count
    pub fn calculate_duration(offense_count: u32) -> u64 {
        match offense_count {
            1 => JAIL_DURATION_1,
            2 => JAIL_DURATION_2,
            3 => JAIL_DURATION_3,
            4 => JAIL_DURATION_4,
            5 => JAIL_DURATION_5,
            _ => JAIL_DURATION_MAX,
        }
    }

    /// Check if jail has expired at given timestamp
    pub fn is_expired(&self, current_timestamp: u64, block_start_timestamp: u64) -> bool {
        if self.jail_duration == PERMANENT_BAN {
            return false; // Never expires
        }

        let jail_end = block_start_timestamp.saturating_add(self.jail_duration);
        current_timestamp >= jail_end
    }
}

// ============================================================================
// REMOVED: DeterministicReputationState (display/telemetry engine).
//
// The engine struct + impl, its `Default`, and the private feed/snapshot types
// (BlockData, MacroBlockData, MacroBlockConsensus, ReputationStats,
// FullReputationSnapshot, DeltaReputationSnapshot, ReputationSnapshotPayload)
// were RAM-only telemetry and have been deleted — they never gated consensus.
// The constants and slashing/jail primitives above are KEPT (still used on-chain
// and re-exported from lib.rs).
// ============================================================================

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slashing_verification() {
        let offense = SlashingType::DoubleSign {
            height: 100,
            hash_a: [1u8; 32],
            hash_b: [2u8; 32],
            signature_a: vec![1, 2, 3],
            signature_b: vec![4, 5, 6],
        };

        let event = SlashingEvent {
            offender: "bad_node".to_string(),
            offense: offense.clone(),
            penalty: PENALTY_DOUBLE_SIGN,
            detected_at_height: 101,
            reporter: "good_node".to_string(),
            evidence_hash: SlashingEvent::compute_evidence_hash(&offense),
        };

        assert!(event.verify_evidence());
    }

    #[test]
    fn test_slashing_penalty_and_ban_classification() {
        // Penalty + permanent-ban classification are pure functions of the
        // offense type and remain the on-chain source of truth after the
        // telemetry engine removal.
        let fork = SlashingType::ChainFork {
            fork_height: 100,
            main_chain_hash: [1u8; 32],
            fork_chain_hash: [2u8; 32],
        };
        assert_eq!(SlashingEvent::calculate_penalty(&fork), 100.0);
        assert!(SlashingEvent::is_permanent_ban(&fork));

        let missed = SlashingType::ConsecutiveMissedBlocks { missed_heights: vec![1, 2, 3] };
        assert_eq!(SlashingEvent::calculate_penalty(&missed), PENALTY_MISSED_BLOCK * 3.0);
        assert!(!SlashingEvent::is_permanent_ban(&missed));
    }

    #[test]
    fn test_automatic_jail_duration_progression() {
        assert_eq!(AutomaticJail::calculate_duration(1), JAIL_DURATION_1);
        assert_eq!(AutomaticJail::calculate_duration(5), JAIL_DURATION_5);
        assert_eq!(AutomaticJail::calculate_duration(99), JAIL_DURATION_MAX);
    }
}

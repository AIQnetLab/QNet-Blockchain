#![allow(dead_code)]

//! Commit-Reveal consensus mechanism for QNet
//! Provides Byzantine fault tolerance and secure leader election

use std::collections::HashMap;
use std::time::{Duration, Instant};
use crate::errors::ConsensusError;
use crate::reputation::{NodeReputation, ReputationConfig, DoubleSignEvidence};
use serde::{Deserialize, Serialize};



/// Commit in the commit-reveal process
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Commit {
    pub node_id: String,
    pub commit_hash: String,
    pub timestamp: u64,
    pub signature: String,
}

/// Consensus result structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsensusResultData {
    pub round_number: u64,
    pub leader_id: String,
    pub participants: Vec<String>,
}

/// Consensus phases
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ConsensusPhase {
    Commit,
    Reveal,
    Finalize,
    /// Production phase - microblock creation (blocks 1-60 of each epoch)
    Production,
}

/// PRODUCTION v2.40: Deterministic phase calculation based on block height
/// This ensures ALL nodes are in the same phase at the same block height
/// Eliminates race conditions from local phase transitions
/// 
/// Block layout per 90-block epoch:
/// - Blocks 1-60:  Production (microblocks only)
/// - Blocks 61-72: Commit phase (12 blocks = 12 seconds)
/// - Blocks 73-84: Reveal phase (12 blocks = 12 seconds)  
/// - Blocks 85-90: Finalize phase (6 blocks = 6 seconds)
pub fn get_phase_for_block(block_height: u64) -> ConsensusPhase {
    if block_height == 0 {
        return ConsensusPhase::Production;
    }
    
    let position_in_epoch = block_height % 90;
    
    match position_in_epoch {
        // Block 90, 180, 270... (position 0) = last block of finalize
        0 => ConsensusPhase::Finalize,
        // Blocks 1-60 = Production
        1..=60 => ConsensusPhase::Production,
        // Blocks 61-72 = Commit (12 seconds)
        61..=72 => ConsensusPhase::Commit,
        // Blocks 73-84 = Reveal (12 seconds)
        73..=84 => ConsensusPhase::Reveal,
        // Blocks 85-89 = Finalize (5 seconds, block 90 handled above)
        85..=89 => ConsensusPhase::Finalize,
        _ => ConsensusPhase::Production,
    }
}

/// Check if block height is in consensus window (blocks 61-90)
pub fn is_in_consensus_window(block_height: u64) -> bool {
    if block_height == 0 {
        return false;
    }
    let position = block_height % 90;
    position >= 61 || position == 0
}

/// Node type for validator selection
/// v3.18: Full nodes removed - only Super and Light remain
#[derive(Debug, Clone, PartialEq)]
pub enum ValidatorNodeType {
    Super,
    Light,
}

/// Validator candidate
#[derive(Debug, Clone)]
pub struct ValidatorCandidate {
    pub node_id: String,
    pub node_type: ValidatorNodeType,
    pub reputation: f64,
    pub last_participation: u64,
    // No stake in QNet - reputation only!
}

/// Selected validator set for a round
#[derive(Debug, Clone)]
pub struct ValidatorSet {
    pub round_number: u64,
    pub validators: Vec<ValidatorCandidate>,
    pub selection_seed: [u8; 32],
}

/// Round state (legacy - for backwards compatibility)
#[derive(Debug, Clone)]
pub struct RoundState {
    pub phase: ConsensusPhase,
    pub round_number: u64,
    pub phase_start: Instant,
    pub phase_duration: Duration,
    pub commits: HashMap<String, Commit>,
    pub reveals: HashMap<String, Reveal>,
    pub participants: Vec<String>,
    pub prev_randomness_beacon: Option<[u8; 32]>,
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTION v2.62: PER-ROUND STORAGE (Like Ethereum 2.0 / Tendermint / Aptos)
// ═══════════════════════════════════════════════════════════════════════════════
// Each round has its own independent storage for commits/reveals.
// This prevents race conditions and data loss during round transitions.
// Rounds are kept for MAX_ROUNDS_TO_KEEP epochs, then cleaned up.
// ═══════════════════════════════════════════════════════════════════════════════

/// Maximum number of rounds to keep in memory (cleanup older ones)
pub const MAX_ROUNDS_TO_KEEP: usize = 5;

/// Maximum allowed size for reveal data (4 KB)
pub const MAX_REVEAL_DATA_SIZE: usize = 4096;

/// Per-round data storage (independent of other rounds)
#[derive(Debug, Clone)]
pub struct RoundData {
    /// Round number (= macroblock_height, e.g., 90, 180, 270...)
    pub round_number: u64,
    /// Epoch number (round_number / 90)
    pub epoch: u64,
    /// Participants for this round
    pub participants: Vec<String>,
    /// Commits indexed by node_id
    pub commits: HashMap<String, Commit>,
    /// Reveals indexed by node_id
    pub reveals: HashMap<String, Reveal>,
    /// Randomness beacon from MacroBlock N-2
    pub randomness_beacon: Option<[u8; 32]>,
    /// Round creation timestamp
    pub created_at: Instant,
    /// Is round finalized?
    pub is_finalized: bool,
    /// Finalization result (leader_id if finalized)
    pub finalized_leader: Option<String>,
}

/// Reveal structure
/// PRODUCTION v2.40.3: Added hybrid signature for authentication
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reveal {
    pub node_id: String,
    pub reveal_data: Vec<u8>,
    pub nonce: [u8; 32],
    pub timestamp: u64,
    #[serde(default)]
    pub signature: String,
}

/// Consensus configuration
#[derive(Debug, Clone)]
pub struct ConsensusConfig {
    pub commit_phase_duration: Duration,
    pub reveal_phase_duration: Duration,
    pub min_participants: usize,
    pub max_participants: usize,
    pub reputation_threshold: f64,
    
    // Sampling-based consensus for scalability
    pub max_validators_per_round: usize,  // Default: 1000 for 1M+ nodes
    pub enable_validator_sampling: bool,
}

impl Default for ConsensusConfig {
    fn default() -> Self {
        Self {
            commit_phase_duration: Duration::from_secs(30),
            reveal_phase_duration: Duration::from_secs(30),
            min_participants: 3,
            max_participants: 100,
            reputation_threshold: 0.7, // FIXED: 0-1 scale (70.0/100.0 from config)
            
            // Sampling-based consensus for scalability
            max_validators_per_round: 1000,    // Only 1000 validators per round
            enable_validator_sampling: true,   // Enable for production
        }
    }
}

/// Main commit-reveal consensus engine
/// PRODUCTION v2.62: Per-round storage like Ethereum 2.0 / Tendermint / Aptos
pub struct CommitRevealConsensus {
    config: ConsensusConfig,
    reputation: NodeReputation,
    node_id: String,
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v2.62: PER-ROUND STORAGE - Each round is independent!
    // ═══════════════════════════════════════════════════════════════════════════
    /// All rounds data indexed by round_number
    /// Keeps last MAX_ROUNDS_TO_KEEP rounds, cleans up older ones
    rounds: HashMap<u64, RoundData>,
    
    /// Currently active round number (for backwards compatibility)
    active_round: Option<u64>,
    
    // Legacy field for backwards compatibility (will be removed in v3.0)
    current_round: Option<RoundState>,
}

impl CommitRevealConsensus {
    /// Create new consensus instance
    /// PRODUCTION v2.62: Initializes per-round storage
    pub fn new(node_id: String, config: ConsensusConfig) -> Self {
        let reputation = NodeReputation::new(ReputationConfig::default());
        
        println!("[INFO][CONS] init node_id={} per_round_storage=true max_rounds={}", 
                 node_id, MAX_ROUNDS_TO_KEEP);
        
        Self {
            config,
            reputation,
            node_id,
            rounds: HashMap::new(),
            active_round: None,
            current_round: None, // Legacy compatibility
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v2.62: PER-ROUND STORAGE API
    // ═══════════════════════════════════════════════════════════════════════════
    
    /// Get or create round data for specific round number
    /// PRODUCTION: Rounds are independent - no data loss on transition!
    pub fn get_or_create_round(&mut self, round_number: u64, participants: Vec<String>) -> &mut RoundData {
        let epoch = round_number / 90;
        
        if !self.rounds.contains_key(&round_number) {
            println!("[INFO][CONS] round_create round={} epoch={} participants={}", 
                     round_number, epoch, participants.len());
            
            let round_data = RoundData {
                round_number,
                epoch,
                participants: participants.clone(),
                commits: HashMap::new(),
                reveals: HashMap::new(),
                randomness_beacon: None,
                created_at: Instant::now(),
                is_finalized: false,
                finalized_leader: None,
            };
            
            self.rounds.insert(round_number, round_data);
            self.cleanup_old_rounds(round_number);
        }
        
        // FIX R14-L1: defensive — round guaranteed to exist after insert above
        self.rounds.get_mut(&round_number)
            .expect("[BUG][CONSENSUS] round missing immediately after insert")
    }
    
    /// Get round data (immutable) for specific round
    pub fn get_round(&self, round_number: u64) -> Option<&RoundData> {
        self.rounds.get(&round_number)
    }
    
    /// Get round data (mutable) for specific round
    pub fn get_round_mut(&mut self, round_number: u64) -> Option<&mut RoundData> {
        self.rounds.get_mut(&round_number)
    }
    
    /// Check if round exists
    pub fn has_round(&self, round_number: u64) -> bool {
        self.rounds.contains_key(&round_number)
    }
    
    /// Cleanup old rounds (keep only last MAX_ROUNDS_TO_KEEP)
    fn cleanup_old_rounds(&mut self, current_round: u64) {
        let min_round_to_keep = if current_round > (MAX_ROUNDS_TO_KEEP as u64 * 90) {
            current_round - (MAX_ROUNDS_TO_KEEP as u64 * 90)
        } else {
            0
        };
        
        let rounds_before = self.rounds.len();
        self.rounds.retain(|&round, _| round >= min_round_to_keep);
        let rounds_after = self.rounds.len();
        
        if rounds_before != rounds_after {
            println!("[INFO][CONS] rounds_cleanup removed={} kept={} min_round={}", 
                     rounds_before - rounds_after, rounds_after, min_round_to_keep);
        }
    }
    
    /// Set randomness beacon for specific round
    pub fn set_round_beacon(&mut self, round_number: u64, beacon: [u8; 32]) {
        if let Some(round) = self.rounds.get_mut(&round_number) {
            round.randomness_beacon = Some(beacon);
            println!("[INFO][CONS] beacon_set round={} hash={}", 
                     round_number, hex::encode(&beacon[..8]));
        }
    }
    
    /// Get round statistics
    pub fn get_round_stats(&self, round_number: u64) -> Option<(usize, usize, usize)> {
        self.rounds.get(&round_number).map(|r| {
            (r.participants.len(), r.commits.len(), r.reveals.len())
        })
    }
    
    /// Start new consensus round (legacy wrapper)
    pub fn start_round(&mut self, participants: Vec<String>) -> Result<u64, ConsensusError> {
        self.start_round_at_height(participants, 0)
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // PRODUCTION v2.62: PER-ROUND STORAGE - Start round with explicit height
    // ═══════════════════════════════════════════════════════════════════════════════
    // KEY DIFFERENCE FROM PREVIOUS VERSIONS:
    // - Each round has its OWN storage (commits/reveals)
    // - Starting new round does NOT delete data from other rounds
    // - Multiple rounds can be active simultaneously
    // - No more "round_override" data loss!
    // ═══════════════════════════════════════════════════════════════════════════════
    pub fn start_round_at_height(&mut self, participants: Vec<String>, macroblock_height: u64) -> Result<u64, ConsensusError> {
        if participants.len() < self.config.min_participants {
            return Err(ConsensusError::InsufficientNodes);
        }
        
        // Calculate round number
        let round_number = if macroblock_height > 0 {
            macroblock_height
        } else {
            self.active_round.map(|r| r + 90).unwrap_or(90)
        };
        
        let epoch = round_number / 90;
        
        // v2.62: Check if round already exists in per-round storage
        if let Some(existing) = self.rounds.get(&round_number) {
            // Round exists - IDEMPOTENT! Don't reset, just return
            println!("[INFO][CONS] round_exists round={} epoch={} commits={} reveals={} finalized={}", 
                     round_number, epoch, existing.commits.len(), existing.reveals.len(), existing.is_finalized);
            
            // Update active round pointer
            self.active_round = Some(round_number);
            
            // Legacy compatibility: sync to current_round
            self.sync_legacy_round(round_number);
            
            return Ok(round_number);
        }
        
        // Create new round in per-round storage
        let round_data = RoundData {
            round_number,
            epoch,
            participants: participants.clone(),
            commits: HashMap::new(),
            reveals: HashMap::new(),
            randomness_beacon: None,
            created_at: Instant::now(),
            is_finalized: false,
            finalized_leader: None,
        };
        
        self.rounds.insert(round_number, round_data);
        self.active_round = Some(round_number);
        
        // Cleanup old rounds
        self.cleanup_old_rounds(round_number);
        
        // Legacy compatibility: create RoundState for old API
        let round_state = RoundState {
            phase: ConsensusPhase::Commit,
            round_number,
            phase_start: Instant::now(),
            phase_duration: self.config.commit_phase_duration,
            commits: HashMap::new(),
            reveals: HashMap::new(),
            participants,
            prev_randomness_beacon: None,
        };
        self.current_round = Some(round_state);
        
        println!("[INFO][CONS] round_started round={} epoch={} storage=per_round", round_number, epoch);
        Ok(round_number)
    }
    
    /// Sync per-round storage to legacy current_round (for backwards compatibility)
    fn sync_legacy_round(&mut self, round_number: u64) {
        if let Some(round_data) = self.rounds.get(&round_number) {
            self.current_round = Some(RoundState {
                phase: if round_data.is_finalized { ConsensusPhase::Finalize } else { ConsensusPhase::Commit },
                round_number,
                phase_start: round_data.created_at,
                phase_duration: self.config.commit_phase_duration,
                commits: round_data.commits.clone(),
                reveals: round_data.reveals.clone(),
                participants: round_data.participants.clone(),
                prev_randomness_beacon: round_data.randomness_beacon,
            });
        }
    }
    
    /// Set randomness beacon from MacroBlock N-2 for unpredictable leader selection
    /// Call BEFORE finalize_round() to enable beacon-based selection
    /// 
    /// ARCHITECTURE:
    /// - Epoch 1-2: No beacon available, use Genesis seed (deterministic)
    /// - Epoch 3+: Use randomness_beacon from MacroBlock N-2
    /// - Beacon = accumulated reveal_data from previous epochs
    /// - Unpredictable until N-2 is finalized, then deterministic
    pub fn set_randomness_beacon(&mut self, beacon: [u8; 32]) {
        if let Some(state) = &mut self.current_round {
            state.prev_randomness_beacon = Some(beacon);
            println!("[INFO][CONS] beacon_set round={} hash={}...", 
                state.round_number, hex::encode(&beacon[..8]));
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // PRODUCTION v2.62: PER-ROUND COMMIT PROCESSING
    // ═══════════════════════════════════════════════════════════════════════════════
    // Commits are stored in the SPECIFIC round they belong to (block_height).
    // This allows multiple rounds to coexist without data loss.
    // No more "round_override" problems!
    // ═══════════════════════════════════════════════════════════════════════════════
    pub async fn process_commit(&mut self, commit: Commit, block_height: u64) -> Result<(), ConsensusError> {
        // Security: Validate node_id format to prevent delimiter injection
        if commit.node_id.is_empty() || commit.node_id.len() > 128
            || commit.node_id.contains(':') || commit.node_id.contains('\0')
            || !commit.node_id.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.') {
            println!("[REJECT][COMMIT-REVEAL] invalid_node_id node_id_len={}", commit.node_id.len());
            return Err(ConsensusError::InvalidCommit("Invalid node_id format".into()));
        }

        let epoch = block_height / 90;

        // v2.62: Check if round exists in per-round storage
        // If not, we can still accept commits for rounds within ±1 epoch
        if !self.rounds.contains_key(&block_height) {
            // Check if round is within acceptable range
            let active_epoch = self.active_round.map(|r| r / 90).unwrap_or(0);
            let epoch_diff = if epoch > active_epoch { epoch - active_epoch } else { active_epoch - epoch };
            
            if epoch_diff > 1 {
                println!("[INFO][CONS] commit_no_round round={} epoch={} active_epoch={}", 
                         block_height, epoch, active_epoch);
                return Err(ConsensusError::NoActiveRound);
            }
            
            // Auto-create round for valid epoch range
            println!("[INFO][CONS] commit_auto_create_round round={} epoch={}", block_height, epoch);
            let _ = self.get_or_create_round(block_height, vec![commit.node_id.clone()]);
        }
        
        // Validate signature
        let signature_valid = self.verify_signature(&commit.node_id, &commit.commit_hash, &commit.signature).await;
        if !signature_valid {
            return Err(ConsensusError::InvalidSignature(
                format!("Invalid signature for validator {}", commit.node_id)
            ));
        }
        
        // Get round data (guaranteed to exist after get_or_create_round above)
        let round_data = match self.rounds.get_mut(&block_height) {
            Some(rd) => rd,
            None => return Err(ConsensusError::NoActiveRound),
        };

        // Check if already finalized
        if round_data.is_finalized {
            println!("[INFO][CONS] commit_round_finalized round={} node={}", block_height, commit.node_id);
            return Ok(());
        }
        
        // FIX R23-F5: Check for equivocation (same node, different commit_hash).
        // A duplicate commit with the SAME hash is benign (network retransmit).
        // A commit with a DIFFERENT hash is EQUIVOCATION — cryptographic proof of malice.
        if let Some(existing_commit) = round_data.commits.get(&commit.node_id) {
            if existing_commit.commit_hash == commit.commit_hash {
                // Benign duplicate — same commit retransmitted
                return Ok(());
            } else {
                // EQUIVOCATION DETECTED — two different commits from the same node!
                println!("[CRITICAL][CONS] equivocation_detected node={} round={} hash_a={} hash_b={}",
                         commit.node_id, block_height,
                         &existing_commit.commit_hash[..16.min(existing_commit.commit_hash.len())],
                         &commit.commit_hash[..16.min(commit.commit_hash.len())]);
                // Apply slashing penalty via reputation system
                self.reputation.update_reputation(&commit.node_id, -30.0);
                return Err(ConsensusError::InvalidCommit(
                    format!("EQUIVOCATION: node {} sent two different commits in round {}",
                            commit.node_id, block_height)
                ));
            }
        }
        
        // Store commit in per-round storage
        round_data.commits.insert(commit.node_id.clone(), commit.clone());
        
        // Calculate Byzantine threshold
        let total_participants = round_data.participants.len().max(round_data.commits.len());
        let byzantine_threshold = (total_participants * 2 + 2) / 3;
        
        // Log progress
        if round_data.commits.len() == byzantine_threshold {
            println!("[INFO][CONS] commit_threshold round={} commits={} threshold={}", 
                     block_height, round_data.commits.len(), byzantine_threshold);
        }
        
        // Legacy compatibility: sync to current_round if this is active round
        if self.active_round == Some(block_height) {
            if let Some(ref mut legacy) = self.current_round {
                legacy.commits.insert(commit.node_id.clone(), commit);
            }
        }
        
        Ok(())
    }
    
    /// Legacy process_commit without block_height (for backwards compatibility)
    /// DEPRECATED: Use process_commit(commit, block_height) instead
    pub async fn process_commit_legacy(&mut self, commit: Commit) -> Result<(), ConsensusError> {
        // Fallback: use current stored height or assume we're in commit phase
        // This should NOT be used in production
        println!("[WARN][CONS] process_commit_legacy called - should use block_height version");
        self.process_commit(commit, 61).await // Assume block 61 (start of commit)
    }
    
    /// PRODUCTION: Verify CRYSTALS-Dilithium post-quantum signature
    async fn verify_signature(&self, node_id: &str, message: &str, signature: &str) -> bool {
        // CRITICAL: Use consensus_crypto module for REAL Dilithium verification
        // This module handles:
        // - Real CRYSTALS-Dilithium with pqcrypto (if feature enabled)
        // - Hybrid signatures (Dilithium + Ed25519)
        // - Proper signature format parsing
        use crate::consensus_crypto;
        
        let valid = consensus_crypto::verify_consensus_signature(node_id, message, signature).await;
        
        if !valid {
            println!("[WARN][CONS] sig_verify_failed node={}", node_id);
        }
        
        valid
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // PRODUCTION v2.62: PER-ROUND REVEAL PROCESSING
    // ═══════════════════════════════════════════════════════════════════════════════
    // Reveals are stored in the SPECIFIC round they belong to (block_height).
    // This allows multiple rounds to coexist without data loss.
    // No more "round_override" data loss!
    // ═══════════════════════════════════════════════════════════════════════════════
    pub async fn submit_reveal(&mut self, reveal: Reveal, block_height: u64) -> Result<(), ConsensusError> {
        // Security: Validate node_id format to prevent delimiter injection in format strings
        if reveal.node_id.is_empty() || reveal.node_id.len() > 128
            || reveal.node_id.contains(':') || reveal.node_id.contains('\0')
            || !reveal.node_id.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.') {
            println!("[REJECT][COMMIT-REVEAL] invalid_node_id node_id_len={}", reveal.node_id.len());
            return Err(ConsensusError::InvalidReveal("Invalid node_id format".into()));
        }

        let epoch = block_height / 90;

        // Security: Reject unsigned reveals
        if reveal.signature.is_empty() {
            println!("[REJECT][COMMIT-REVEAL] unsigned_reveal node={}", reveal.node_id);
            return Err(ConsensusError::InvalidSignature(
                format!("Unsigned reveal rejected from node {}", reveal.node_id)
            ));
        }

        // Security: Reject oversized reveal data
        if reveal.reveal_data.len() > MAX_REVEAL_DATA_SIZE {
            println!("[REJECT][COMMIT-REVEAL] reveal_data_too_large node={} size={} max={}",
                     reveal.node_id, reveal.reveal_data.len(), MAX_REVEAL_DATA_SIZE);
            return Err(ConsensusError::InvalidReveal(
                format!("Reveal data too large from node {}: {} bytes (max {})",
                        reveal.node_id, reveal.reveal_data.len(), MAX_REVEAL_DATA_SIZE)
            ));
        }

        // v2.62: Check if round exists in per-round storage
        if !self.rounds.contains_key(&block_height) {
            // Check if round is within acceptable range
            let active_epoch = self.active_round.map(|r| r / 90).unwrap_or(0);
            let epoch_diff = if epoch > active_epoch { epoch - active_epoch } else { active_epoch - epoch };
            
            if epoch_diff > 1 {
                println!("[INFO][CONS] reveal_no_round round={} epoch={} active_epoch={}", 
                         block_height, epoch, active_epoch);
                return Err(ConsensusError::NoActiveRound);
            }
            
            // Auto-create round for valid epoch range
            println!("[INFO][CONS] reveal_auto_create_round round={} epoch={}", block_height, epoch);
            let _ = self.get_or_create_round(block_height, vec![reveal.node_id.clone()]);
        }
        
        // Verify hybrid signature cryptographically
        {
            // CRITICAL FIX v2.52: Message format MUST match generation in node.rs
            // Format: node_id:reveal_data_hex:nonce_hex:timestamp (4 fields)
            // Then SHA3-256 hash before verification (same as signing)
            let reveal_message = format!("{}:{}:{}:{}",
                reveal.node_id,
                hex::encode(&reveal.reveal_data),
                hex::encode(&reveal.nonce),
                reveal.timestamp
            );

            // SHA3-256 hash (same as generation in node.rs)
            use sha3::{Sha3_256, Digest};
            let mut hasher = Sha3_256::new();
            hasher.update(reveal_message.as_bytes());
            let reveal_hash = hex::encode(hasher.finalize());

            // Verify the HASH (not plain message) for L1-grade security
            let signature_valid = self.verify_signature(
                &reveal.node_id,
                &reveal_hash,
                &reveal.signature
            ).await;

            if !signature_valid {
                println!("[REJECT][COMMIT-REVEAL] invalid_signature node={}", reveal.node_id);
                return Err(ConsensusError::InvalidSignature(
                    format!("Invalid hybrid reveal signature for node {}", reveal.node_id)
                ));
            }
        }
        
        // Get round data (guaranteed to exist after auto-create above)
        let round_data = match self.rounds.get_mut(&block_height) {
            Some(rd) => rd,
            None => return Err(ConsensusError::NoActiveRound),
        };

        // Check if already finalized
        if round_data.is_finalized {
            println!("[INFO][CONS] reveal_round_finalized round={} node={}", block_height, reveal.node_id);
            return Ok(());
        }
        
        // Check for duplicate
        if round_data.reveals.contains_key(&reveal.node_id) {
            println!("[INFO][CONS] reveal_duplicate node={} round={}", reveal.node_id, block_height);
            return Ok(());
        }
        
        // Verify reveal matches commit if commit exists in THIS round
        if let Some(commit) = round_data.commits.get(&reveal.node_id) {
            // CRITICAL FIX v2.63: Correct hash format matching calculate_commit_hash()
            // Format: SHA3-256(reveal_data || nonce || "qnet-commit-hash-v1")
            // This matches the commit generation in node.rs
            use sha3::{Sha3_256, Digest};
            let mut hasher = Sha3_256::new();
            hasher.update(&reveal.reveal_data);  // reveal_data FIRST
            hasher.update(&reveal.nonce);        // nonce SECOND
            hasher.update(b"qnet-commit-hash-v1"); // QNet domain separation salt
            let calculated_hash = hex::encode(hasher.finalize());
            
            if calculated_hash != commit.commit_hash {
                println!("[WARN][CONS] reveal_mismatch node={} round={} expected={} got={}", 
                         reveal.node_id, block_height, 
                         &commit.commit_hash[..16], &calculated_hash[..16]);
                // Still store - will verify in finalize_round with proper error handling
            }
        } else {
            println!("[INFO][CONS] reveal_before_commit node={} round={}", reveal.node_id, block_height);
        }
        
        // Store reveal in per-round storage
        round_data.reveals.insert(reveal.node_id.clone(), reveal.clone());
        
        // Calculate Byzantine threshold
        let total_participants = round_data.participants.len().max(round_data.commits.len());
        let byzantine_threshold = (total_participants * 2 + 2) / 3;
        
        // Log progress
        if round_data.reveals.len() == byzantine_threshold {
            println!("[INFO][CONS] reveal_threshold round={} reveals={} threshold={}", 
                     block_height, round_data.reveals.len(), byzantine_threshold);
        }
        
        // Legacy compatibility: sync to current_round if this is active round
        if self.active_round == Some(block_height) {
            if let Some(ref mut legacy) = self.current_round {
                legacy.reveals.insert(reveal.node_id.clone(), reveal);
            }
        }
        
        Ok(())
    }
    
    /// Legacy submit_reveal without block_height (for backwards compatibility)
    /// DEPRECATED: Use submit_reveal(reveal, block_height) instead
    pub async fn submit_reveal_legacy(&mut self, reveal: Reveal) -> Result<(), ConsensusError> {
        println!("[WARN][CONS] submit_reveal_legacy called - should use block_height version");
        self.submit_reveal(reveal, 73).await // Assume block 73 (start of reveal)
    }
    
    /// Advance to next phase
    /// PRODUCTION v2.40: This is mainly for cleanup after consensus completes
    /// Phase transitions are now determined by block height, not this method
    pub fn advance_phase(&mut self) -> Result<ConsensusPhase, ConsensusError> {
        let state = self.current_round.as_mut().ok_or(ConsensusError::NoActiveRound)?;
        
        match state.phase {
            ConsensusPhase::Commit => {
                state.phase = ConsensusPhase::Reveal;
                state.phase_start = Instant::now();
                state.phase_duration = self.config.reveal_phase_duration;
                Ok(ConsensusPhase::Reveal)
            }
            ConsensusPhase::Reveal => {
                state.phase = ConsensusPhase::Finalize;
                state.phase_start = Instant::now();
                Ok(ConsensusPhase::Finalize)
            }
            ConsensusPhase::Finalize => {
                self.current_round = None;
                Ok(ConsensusPhase::Commit) // Ready for next round
            }
            ConsensusPhase::Production => {
                // Production phase - consensus not active, no transition
                Ok(ConsensusPhase::Production)
            }
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // PRODUCTION v2.62: PER-ROUND FINALIZATION
    // ═══════════════════════════════════════════════════════════════════════════════
    // Finalize specific round by round_number. Returns leader_id.
    // Round data is preserved in per-round storage even after finalization.
    // ═══════════════════════════════════════════════════════════════════════════════
    
    /// Finalize specific round (v2.62 per-round storage)
    pub fn finalize_round_by_number(&mut self, round_number: u64) -> Result<String, ConsensusError> {
        // Get round data
        let round_data = self.rounds.get(&round_number)
            .ok_or(ConsensusError::NoActiveRound)?;
        
        // Check if already finalized
        if round_data.is_finalized {
            if let Some(ref leader) = round_data.finalized_leader {
                println!("[INFO][CONS] round_already_finalized round={} leader={}", round_number, leader);
                return Ok(leader.clone());
            }
        }
        
        let epoch = round_number / 90;
        
        // Calculate Byzantine threshold
        let total_participants = round_data.participants.len().max(round_data.commits.len());
        let byzantine_threshold = (total_participants * 2 + 2) / 3;
        
        // Check if we have enough reveals
        if round_data.reveals.len() < byzantine_threshold {
            return Err(ConsensusError::InvalidCommit(
                format!("Insufficient reveals for Byzantine safety: {}/{} round={}", 
                       round_data.reveals.len(), byzantine_threshold, round_number)
            ));
        }
        
        // Verify all reveals match their commits
        let mut valid_reveals = 0;
        let mut valid_reveal_data: Vec<(&String, &Reveal)> = Vec::new();
        
        for (node_id, reveal) in &round_data.reveals {
            if let Some(commit) = round_data.commits.get(node_id) {
                // CRITICAL FIX v2.63: Correct hash format matching calculate_commit_hash()
                // Format: SHA3-256(reveal_data || nonce || "qnet-commit-hash-v1")
                // This matches the commit generation in node.rs
                use sha3::{Sha3_256, Digest};
                let mut hasher = Sha3_256::new();
                hasher.update(&reveal.reveal_data);  // reveal_data FIRST
                hasher.update(&reveal.nonce);        // nonce SECOND
                hasher.update(b"qnet-commit-hash-v1"); // QNet domain separation salt
                let calculated_hash = hex::encode(hasher.finalize());
                
                if calculated_hash == commit.commit_hash {
                    valid_reveals += 1;
                    valid_reveal_data.push((node_id, reveal));
                } else {
                    println!("[WARN][CONS] invalid_reveal round={} node={} reason=hash_mismatch", 
                             round_number, node_id);
                }
            } else {
                println!("[WARN][CONS] reveal_no_commit round={} node={}", round_number, node_id);
            }
        }
        
        // Re-check Byzantine threshold with valid reveals only
        if valid_reveals < byzantine_threshold {
            return Err(ConsensusError::InvalidCommit(
                format!("Insufficient VALID reveals for Byzantine safety: {}/{} (had {} total) round={}", 
                       valid_reveals, byzantine_threshold, round_data.reveals.len(), round_number)
            ));
        }
        
        // Leader selection using valid reveals
        let leader = self.select_leader_from_reveals(&valid_reveal_data, round_data.randomness_beacon)
            .ok_or(ConsensusError::LeaderSelectionFailed)?;
        
        println!("[INFO][CONS] finalize_ok round={} epoch={} valid={}/{} leader={}", 
                 round_number, epoch, valid_reveals, byzantine_threshold, leader);
        
        // FIX R23-F4: Detect and log nodes that committed but withheld their reveal.
        // This is the last-revealer bias vector — a node can see all other reveals
        // and choose to withhold its own to influence the beacon. Penalty via reputation
        // makes the attack costly: each withheld reveal costs reputation, limiting
        // how many rounds an attacker can bias before being excluded from consensus.
        {
            let committed_ids: std::collections::HashSet<&String> = round_data.commits.keys().collect();
            let revealed_ids: std::collections::HashSet<&String> = round_data.reveals.keys().collect();
            let withheld: Vec<&&String> = committed_ids.difference(&revealed_ids).collect();
            if !withheld.is_empty() {
                for node_id in &withheld {
                    println!("[WARN][CONS] commit_without_reveal round={} node={} action=reputation_penalty",
                             round_number, node_id);
                    // Apply reputation penalty via existing system — cost of withholding
                    self.reputation.update_reputation(node_id, -5.0);
                }
                println!("[INFO][CONS] withheld_reveals round={} count={}", round_number, withheld.len());
            }
        }

        // Mark round as finalized
        if let Some(round) = self.rounds.get_mut(&round_number) {
            round.is_finalized = true;
            round.finalized_leader = Some(leader.clone());
        }

        // Legacy compatibility: update current_round if needed
        if self.active_round == Some(round_number) {
            if let Some(ref mut legacy) = self.current_round {
                legacy.phase = ConsensusPhase::Finalize;
            }
        }
        
        Ok(leader)
    }
    
    /// Helper: Select leader from valid reveals
    fn select_leader_from_reveals(&self, reveals: &[(&String, &Reveal)], beacon: Option<[u8; 32]>) -> Option<String> {
        if reveals.is_empty() {
            return None;
        }
        
        // Combine all reveal data for entropy
        use sha3::{Sha3_512, Digest};
        let mut hasher = Sha3_512::new();
        
        // Add beacon if available
        if let Some(b) = beacon {
            hasher.update(&b);
        }
        
        // Add all reveals (sorted for determinism)
        let mut sorted_reveals: Vec<_> = reveals.iter().collect();
        sorted_reveals.sort_by(|a, b| a.0.cmp(b.0));
        
        for (node_id, reveal) in &sorted_reveals {
            hasher.update(node_id.as_bytes());
            hasher.update(&reveal.reveal_data);
            hasher.update(&reveal.nonce);
        }
        
        let hash = hasher.finalize();
        let index = u64::from_le_bytes([hash[0], hash[1], hash[2], hash[3], hash[4], hash[5], hash[6], hash[7]]) as usize;
        let leader_idx = index % sorted_reveals.len();
        
        Some(sorted_reveals[leader_idx].0.clone())
    }
    
    /// Legacy finalize_round (uses active round)
    pub fn finalize_round(&mut self) -> Result<String, ConsensusError> {
        // Use active round or fall back to current_round
        if let Some(round_number) = self.active_round {
            return self.finalize_round_by_number(round_number);
        }
        
        // Legacy path: use current_round
        let state = self.current_round.as_ref().ok_or(ConsensusError::NoActiveRound)?;
        let round_number = state.round_number;
        
        // Ensure round exists in per-round storage
        if !self.rounds.contains_key(&round_number) {
            // Migrate from legacy
            let round_data = RoundData {
                round_number,
                epoch: round_number / 90,
                participants: state.participants.clone(),
                commits: state.commits.clone(),
                reveals: state.reveals.clone(),
                randomness_beacon: state.prev_randomness_beacon,
                created_at: state.phase_start,
                is_finalized: false,
                finalized_leader: None,
            };
            self.rounds.insert(round_number, round_data);
        }
        
        self.finalize_round_by_number(round_number)
    }
    
    /// Get current round status
    pub fn get_round_status(&self) -> Option<&RoundState> {
        self.current_round.as_ref()
    }
    
    /// PRODUCTION: Get current commit count for Byzantine threshold checking
    pub fn get_current_commit_count(&self) -> usize {
        if let Some(state) = &self.current_round {
            state.commits.len()
        } else {
            0
        }
    }
    
    /// PRODUCTION: Get current reveal count for Byzantine threshold checking  
    pub fn get_current_reveal_count(&self) -> usize {
        if let Some(state) = &self.current_round {
            state.reveals.len()
        } else {
            0
        }
    }
    
    /// PRODUCTION: Reputation-based validation using external reputation system
    pub fn validate_commit_reputation(&self, commit: &Commit, external_reputation: Option<f64>) -> Result<(), ConsensusError> {
        // PRODUCTION: Use external reputation from P2P system (0-100 scale converted to 0-1)
        let reputation = if let Some(ext_rep) = external_reputation {
            ext_rep / 100.0 // Convert from P2P scale (0-100) to consensus scale (0-1)
        } else {
            // Fallback to internal reputation for compatibility
            self.reputation.get_reputation(&commit.node_id) / 100.0 // Convert to 0-1 scale
        };
        
        // Require minimum 70% reputation for consensus participation
        if reputation < 0.7 {
            return Err(ConsensusError::InvalidCommit(format!("Insufficient reputation for node {} ({}%)", commit.node_id, reputation * 100.0)));
        }
        
        // Simplified signature validation
        if commit.signature.len() < 10 {
            return Err(ConsensusError::InvalidSignature(format!("Invalid signature format for node {}", commit.node_id)));
        }
        
        Ok(())
    }
    
    /// Calculate commit hash from reveal data and nonce using SHA3-256
    pub fn calculate_commit_hash(&self, reveal_data: &[u8], nonce: &[u8]) -> Vec<u8> {
        // PRODUCTION: SHA3-256 cryptographic hash (post-quantum safe)
        use sha3::{Sha3_256, Digest};
        
        let mut hasher = Sha3_256::new();
        hasher.update(reveal_data);
        hasher.update(nonce);
        hasher.update(b"qnet-commit-hash-v1"); // QNet specific salt
        
        hasher.finalize().to_vec()
    }
    
    /// Verify reveal matches commit
    fn verify_reveal(&self, reveal: &Reveal, commits: &HashMap<String, Commit>) -> Result<(), ConsensusError> {
        let commit = commits.get(&reveal.node_id)
            .ok_or(ConsensusError::InvalidReveal("No matching commit".to_string()))?;
        
        // Verify reveal produces the commit hash
        let expected_hash = self.calculate_commit_hash(&reveal.reveal_data, &reveal.nonce);
        if hex::encode(expected_hash) != commit.commit_hash {
            return Err(ConsensusError::InvalidReveal("Reveal doesn't match commit".to_string()));
        }
        
        Ok(())
    }
    
    /// Get consensus result for current round
    pub fn get_consensus_result(&self) -> Result<ConsensusResultData, ConsensusError> {
        let state = self.current_round.as_ref().ok_or(ConsensusError::NoActiveRound)?;
        
        if state.phase != ConsensusPhase::Finalize {
            return Err(ConsensusError::InvalidPhase("Round not finalized".to_string()));
        }
        
        if state.reveals.is_empty() {
            return Err(ConsensusError::NoValidReveals);
        }
        
        // Select leader based on reveals
        let leader_id = self.select_leader(&state.reveals)
            .ok_or(ConsensusError::LeaderSelectionFailed)?;
        
        Ok(ConsensusResultData {
            round_number: state.round_number,
            leader_id,
            participants: state.participants.clone(),
        })
    }
    
    /// PRODUCTION v2.32: DETERMINISTIC + UNPREDICTABLE leader selection
    /// ═══════════════════════════════════════════════════════════════════════════
    /// 
    /// PROBLEM (v2.30): reveal_data varies between nodes → FORK!
    /// PROBLEM (v2.31): No beacon → leader predictable (DoS risk)
    /// 
    /// SOLUTION (v2.32):
    /// - Use randomness_beacon from MacroBlock N-2 as entropy source
    /// - Beacon is accumulated reveal_data from previous epochs
    /// - Unpredictable until N-2 finalized, then deterministic for all nodes
    /// - Fallback to Genesis seed for first 2 epochs (no N-2 yet)
    ///
    /// ENTROPY SOURCES (all deterministic across nodes):
    /// 1. prev_randomness_beacon (from MacroBlock N-2) - unpredictable!
    /// 2. round_number (same on all nodes)
    /// 3. sorted participant list (same on all nodes)
    ///
    /// SCALABILITY: Works with 1000 validators per round
    /// ═══════════════════════════════════════════════════════════════════════════
    /// PRODUCTION v2.40.3: XOR-based leader selection with CURRENT epoch entropy
    /// ═══════════════════════════════════════════════════════════════════════════
    /// 
    /// PROBLEM (v2.32-v2.40.2): Beacon N-2 is PUBLIC after MacroBlock N-2 finalized!
    ///   → Leader for epoch N is PREDICTABLE → DDoS attack possible!
    /// 
    /// SOLUTION (v2.40.3): Use CURRENT reveals as PRIMARY entropy source
    ///   1. current_beacon = XOR(all reveal nonces in THIS round) - UNPREDICTABLE!
    ///   2. prev_beacon (N-2) = historical entropy accumulation
    ///   3. Combined: hash(current_beacon, prev_beacon, round, participants)
    /// 
    /// SECURITY: Leader cannot be predicted until ALL reveals are collected!
    ///   - Even if attacker knows 4/5 reveals, the 5th reveal changes the beacon
    ///   - 1-bit bias attack possible (last revealer) but not practical for leader selection
    /// ═══════════════════════════════════════════════════════════════════════════
    fn select_leader(&self, reveals: &HashMap<String, Reveal>) -> Option<String> {
        if reveals.is_empty() {
            return None;
        }
        
        let state = self.current_round.as_ref()?;
        let round_number = state.round_number;
        
        // UNIFIED v2.36: SHA3-512 everywhere for maximum security
        use sha3::{Sha3_512, Digest};
        let mut hasher = Sha3_512::new();
        
        // Version tag for hash domain separation
        hasher.update(b"QNet_Leader_Selection_v2.40.3_XOR");
        
        // ═══════════════════════════════════════════════════════════════════════════
        // CRITICAL v2.40.3: PRIMARY ENTROPY from CURRENT reveals (XOR-based)
        // This is UNPREDICTABLE until ALL reveals are collected!
        // ═══════════════════════════════════════════════════════════════════════════
        let mut current_beacon = [0u8; 32];
        for reveal in reveals.values() {
            for (i, byte) in reveal.nonce.iter().enumerate() {
                current_beacon[i] ^= byte;
            }
        }
        hasher.update(&current_beacon);
        
        // SECONDARY ENTROPY: Historical beacon from MacroBlock N-2
        // Adds accumulated randomness from previous epochs
        let has_prev_beacon = if let Some(beacon) = &state.prev_randomness_beacon {
            hasher.update(beacon);
            true
        } else {
            // Fallback for epochs 1-2: Use Genesis seed
            hasher.update(b"QNet_Genesis_Seed_Fallback");
            false
        };
        
        // Round number (deterministic)
        hasher.update(&round_number.to_le_bytes());
        
        // Sort participants for deterministic ordering (CRITICAL!)
        let mut participants: Vec<_> = reveals.keys().cloned().collect();
        participants.sort();
        
        // Hash all participant IDs
        for node_id in &participants {
            hasher.update(node_id.as_bytes());
        }
        
        let hash = hasher.finalize();
        
        // Convert hash to selection index
        let hash_number = u64::from_le_bytes([
            hash[0], hash[1], hash[2], hash[3],
            hash[4], hash[5], hash[6], hash[7],
        ]);
        
        let selection_index = (hash_number as usize) % participants.len();
        let selected_leader = participants[selection_index].clone();
        
        // Professional log: [LEVEL][MODULE] key=value
        println!("[INFO][CONS] leader_select node={} idx={}/{} round={} current_beacon={}... prev_beacon={}", 
                 selected_leader, selection_index, participants.len(), round_number, 
                 hex::encode(&current_beacon[..4]), has_prev_beacon);
        
        Some(selected_leader)
    }
    
    /// PRODUCTION: Get finalized consensus result if available
    pub fn get_finalized_consensus(&self) -> Option<ConsensusResultData> {
        if let Some(state) = &self.current_round {
            if state.phase == ConsensusPhase::Finalize {
                // Return finalized consensus data
                Some(ConsensusResultData {
                    round_number: state.round_number,
                    leader_id: self.select_leader(&state.reveals).unwrap_or_else(|| "no_leader".to_string()),
                    participants: state.participants.clone(),
                })
            } else {
                None
            }
        } else {
            None
        }
    }
    
    /// PRODUCTION: Check for double signing using signature database
    async fn check_double_signing(&mut self, node_id: &str, current_signature: &str, round_number: u64, message_hash: &str) -> Result<(), ConsensusError> {
        // PRODUCTION: Real double signing detection

        
        // Check if we have previous signatures from this node for this round
        if let Some(state) = &self.current_round {
            // Check commits for duplicate signatures
            for (existing_node, existing_commit) in &state.commits {
                if existing_node == node_id {
                    // Same node, check if different message hash with valid signature
                    if existing_commit.commit_hash != message_hash && 
                       existing_commit.signature != current_signature &&
                       self.verify_signature(node_id, &existing_commit.commit_hash, &existing_commit.signature).await {
                        
                        // DOUBLE SIGNING DETECTED - cryptographic proof!
                        println!("[CRITICAL][CONS] double_sign_detected node={} round={}", node_id, round_number);
                        
                        // PRODUCTION: Use EXISTING reputation system for slashing
                        // commit_hash is a hex String (64 chars) — decode to [u8;32] with validation
                        let hash_a_vec = hex::decode(&existing_commit.commit_hash).unwrap_or_default();
                        let hash_b_vec = hex::decode(message_hash).unwrap_or_default();

                        // Validate decoded hash lengths before constructing evidence
                        if hash_a_vec.len() != 32 || hash_b_vec.len() != 32 {
                            println!("[CRITICAL][CONS] double_sign_hash_decode_failed node={} len_a={} len_b={}",
                                     node_id, hash_a_vec.len(), hash_b_vec.len());
                            return Err(ConsensusError::DoubleSigningDetected(
                                format!("Node {} double signed round {} - hash decode failed (a={} b={})",
                                        node_id, round_number, hash_a_vec.len(), hash_b_vec.len())
                            ));
                        }

                        let mut hash_a = [0u8; 32];
                        let mut hash_b = [0u8; 32];
                        hash_a.copy_from_slice(&hash_a_vec);
                        hash_b.copy_from_slice(&hash_b_vec);

                        let evidence = DoubleSignEvidence {
                            round: round_number,
                            hash_a,
                            hash_b,
                            offender: node_id.to_string(),
                            detected_at: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_else(|_| std::time::Duration::from_secs(1640000000))
                                .as_secs(),
                            signature_a: existing_commit.signature.as_bytes().to_vec(),
                            signature_b: current_signature.as_bytes().to_vec(),
                        };
                        
                        // Apply slashing via reputation system
                        let slashing_result = self.reputation.process_double_sign_evidence(&evidence);
                        println!("[CRITICAL][CONS] slashing_applied node={} penalty={} new_rep={} banned={}", 
                                node_id, slashing_result.slashed_amount, slashing_result.new_reputation, slashing_result.is_banned);
                        
                        return Err(ConsensusError::DoubleSigningDetected(
                            format!("Node {} double signed round {} - REPUTATION SLASHED! (hashes: {} vs {})", 
                                   node_id, round_number, existing_commit.commit_hash, message_hash)
                        ));
                    }
                }
            }
        }
        
        // No double signing detected
        Ok(())
    }

    /// REMOVED: Old select_validators function (replaced with production version below)
    pub fn select_validators_old(&self, 
        candidates: &[ValidatorCandidate], 
        round_number: u64
    ) -> Result<ValidatorSet, ConsensusError> {
        if !self.config.enable_validator_sampling {
            // Use all eligible candidates (legacy mode)
            let validators = candidates.iter()
                .filter(|c| c.reputation >= self.config.reputation_threshold)
                .cloned()
                .collect();
            
            return Ok(ValidatorSet {
                round_number,
                validators,
                selection_seed: [0; 32],
            });
        }
        
        // Sampling-based selection for scalability
        let mut selected = Vec::new();
        let selection_seed = self.generate_selection_seed(round_number);
        
        // 1. Filter by reputation threshold
        let eligible: Vec<_> = candidates.iter()
            .filter(|c| c.reputation >= self.config.reputation_threshold)
            .collect();
        
        // 2. Separate by node type
        let mut super_nodes: Vec<_> = eligible.iter()
            .filter(|c| c.node_type == ValidatorNodeType::Super)
            .collect();
        let mut full_nodes: Vec<_> = eligible.iter()
            .filter(|c| c.node_type == ValidatorNodeType::Super)
            .collect();
        
        // 3. Sort by reputation (higher first)
        super_nodes.sort_by(|a, b| b.reputation.partial_cmp(&a.reputation).unwrap_or(std::cmp::Ordering::Equal));
        full_nodes.sort_by(|a, b| b.reputation.partial_cmp(&a.reputation).unwrap_or(std::cmp::Ordering::Equal));
        
        // 4. Simple selection: equal chance for all qualified nodes (QNet spec)
        let mut all_candidates = super_nodes;
        all_candidates.extend(full_nodes);
        
        // Limit to max_validators_per_round
        let max_count = self.config.max_validators_per_round.min(all_candidates.len());
        for i in 0..max_count {
            selected.push((*all_candidates[i]).clone());
        }
        
        // 6. Fill remaining slots with any eligible nodes if needed
        let remaining_slots = self.config.max_validators_per_round.saturating_sub(selected.len());
        if remaining_slots > 0 {
            let already_selected: std::collections::HashSet<_> = selected.iter()
                .map(|v| &v.node_id)
                .collect();
            
            let remaining_candidates: Vec<&ValidatorCandidate> = eligible.iter()
                .filter(|c| !already_selected.contains(&c.node_id))
                .map(|c| *c)
                .collect();
            
            let additional = self.weighted_random_selection(
                &remaining_candidates,
                remaining_slots,
                &selection_seed
            );
            selected.extend(additional);
        }
        
        Ok(ValidatorSet {
            round_number,
            validators: selected,
            selection_seed,
        })
    }
    
    /// Generate deterministic selection seed for validator sampling
    fn generate_selection_seed(&self, round_number: u64) -> [u8; 32] {
        let mut input = Vec::new();
        input.extend_from_slice(&round_number.to_le_bytes());
        input.extend_from_slice(b"validator_selection");
        
        let hash = blake3::hash(&input);
        *hash.as_bytes()
    }
    
    /// Weighted random selection of validators
    fn weighted_random_selection(
        &self,
        candidates: &[&ValidatorCandidate],
        count: usize,
        seed: &[u8; 32]
    ) -> Vec<ValidatorCandidate> {
        if candidates.is_empty() || count == 0 {
            return Vec::new();
        }
        
        let mut rng = self.create_deterministic_rng(seed);
        let mut selected = Vec::new();
        let mut remaining: Vec<_> = candidates.iter().map(|c| (*c).clone()).collect();
        
        for _ in 0..count.min(remaining.len()) {
            if remaining.is_empty() {
                break;
            }
            
            // Calculate total weight
            let total_weight: f64 = remaining.iter()
                .map(|c| c.reputation) // Only reputation, NO STAKE!
                .sum();
            
            if total_weight <= 0.0 {
                // Fallback to equal probability
                let index = (rng as usize) % remaining.len();
                selected.push(remaining.remove(index));
                continue;
            }
            
            // Weighted selection
            let mut random_weight = (rng as f64 / u64::MAX as f64) * total_weight;
            let mut selected_index = 0;
            
            for (i, candidate) in remaining.iter().enumerate() {
                let weight = candidate.reputation; // Only reputation, NO STAKE!
                if random_weight <= weight {
                    selected_index = i;
                    break;
                }
                random_weight -= weight;
            }
            
            selected.push(remaining.remove(selected_index));
            
            // FIX H23: Replace weak LCG with blake3-based deterministic PRNG
            // Each iteration re-hashes for cryptographic unpredictability
            let rng_bytes = blake3::hash(&rng.to_le_bytes()).as_bytes()[..8].try_into().unwrap_or([0u8; 8]);
            rng = u64::from_le_bytes(rng_bytes);
        }
        
        selected
    }
    
    /// Create deterministic RNG from seed
    fn create_deterministic_rng(&self, seed: &[u8; 32]) -> u64 {
        let mut rng = 0u64;
        for &byte in seed.iter().take(8) {
            rng = (rng << 8) | (byte as u64);
        }
        rng
    }
    
    /// PRODUCTION: Select validators based on reputation (NO STAKE!)
    pub fn select_validators(&self, candidates: &[ValidatorCandidate], round_number: u64) -> Result<ValidatorSet, ConsensusError> {
        if candidates.is_empty() {
            return Err(ConsensusError::InvalidCommit("No validator candidates".to_string()));
        }
        
        // Filter by reputation threshold (≥70%)
        let qualified: Vec<ValidatorCandidate> = candidates.iter()
            .filter(|c| c.reputation >= self.config.reputation_threshold)
            .cloned()
            .collect();
        
        if qualified.is_empty() {
            return Err(ConsensusError::InvalidCommit("No qualified validators (reputation ≥70%)".to_string()));
        }
        
        // Separate by node type
        let mut super_nodes: Vec<ValidatorCandidate> = qualified.iter()
            .filter(|c| c.node_type == ValidatorNodeType::Super)
            .cloned()
            .collect();
        
        let mut full_nodes: Vec<ValidatorCandidate> = qualified.iter()
            .filter(|c| c.node_type == ValidatorNodeType::Super)
            .cloned()
            .collect();
        
        // Sort by reputation (higher first)
        super_nodes.sort_by(|a, b| b.reputation.partial_cmp(&a.reputation).unwrap_or(std::cmp::Ordering::Equal));
        full_nodes.sort_by(|a, b| b.reputation.partial_cmp(&a.reputation).unwrap_or(std::cmp::Ordering::Equal));
        
        let mut selected = Vec::new();
        
        // Simple selection: equal chance for all qualified nodes (QNet spec)
        let mut all_candidates = super_nodes;
        all_candidates.extend(full_nodes);
        
        // Limit to max_validators_per_round
        let max_count = self.config.max_validators_per_round.min(all_candidates.len());
        selected.extend(all_candidates.into_iter().take(max_count));
        
        // Minimum 4 validators for Byzantine tolerance
        if selected.len() < 4 {
            return Err(ConsensusError::InvalidCommit(format!("Insufficient validators: {} < 4", selected.len())));
        }
        
        Ok(ValidatorSet {
            round_number,
            validators: selected,
            selection_seed: [0u8; 32], // Simplified for production
        })
    }

    /// Get round state (alias for get_round_status for API compatibility)
    pub fn get_round_state(&self) -> Option<&RoundState> {
        self.get_round_status()
    }

    /// Add commit (alias for process_commit for API compatibility)
    /// DEPRECATED: Use process_commit(commit, block_height) instead
    pub async fn add_commit(&mut self, commit: Commit) -> Result<(), ConsensusError> {
        // Fallback to block 61 (start of commit phase)
        self.process_commit(commit, 61).await
    }

    /// Add reveal (alias for submit_reveal for API compatibility)
    /// DEPRECATED: Use submit_reveal(reveal, block_height) instead
    pub async fn add_reveal(&mut self, reveal: Reveal) -> Result<(), ConsensusError> {
        // Fallback to block 73 (start of reveal phase)
        self.submit_reveal(reveal, 73).await
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PRODUCTION v2.35: Methods for MacroBlock consensus
    // ═══════════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════════════
    // PRODUCTION v2.62: Per-round data access
    // ═══════════════════════════════════════════════════════════════════════════════
    
    /// Get commits for specific round
    pub fn get_commits_for_round(&self, round_number: u64) -> HashMap<String, Vec<u8>> {
        if let Some(round_data) = self.rounds.get(&round_number) {
            round_data.commits.iter()
                .map(|(node_id, commit)| {
                    let commit_bytes = bincode::serialize(commit).unwrap_or_default();
                    (node_id.clone(), commit_bytes)
                })
                .collect()
        } else {
            HashMap::new()
        }
    }
    
    /// Get reveals for specific round
    pub fn get_reveals_for_round(&self, round_number: u64) -> HashMap<String, Vec<u8>> {
        if let Some(round_data) = self.rounds.get(&round_number) {
            round_data.reveals.iter()
                .map(|(node_id, reveal)| {
                    let reveal_bytes = bincode::serialize(reveal).unwrap_or_default();
                    (node_id.clone(), reveal_bytes)
                })
                .collect()
        } else {
            HashMap::new()
        }
    }
    
    /// Get commits for MacroBlock storage (uses active round or legacy)
    pub fn get_commits_for_macroblock(&self) -> HashMap<String, Vec<u8>> {
        // First try per-round storage
        if let Some(round_number) = self.active_round {
            return self.get_commits_for_round(round_number);
        }
        
        // Legacy fallback
        if let Some(state) = &self.current_round {
            state.commits.iter()
                .map(|(node_id, commit)| {
                    let commit_bytes = bincode::serialize(commit).unwrap_or_default();
                    (node_id.clone(), commit_bytes)
                })
                .collect()
        } else {
            HashMap::new()
        }
    }

    /// Get reveals for MacroBlock storage (uses active round or legacy)
    pub fn get_reveals_for_macroblock(&self) -> HashMap<String, Vec<u8>> {
        // First try per-round storage
        if let Some(round_number) = self.active_round {
            return self.get_reveals_for_round(round_number);
        }
        
        // Legacy fallback
        if let Some(state) = &self.current_round {
            state.reveals.iter()
                .map(|(node_id, reveal)| {
                    let reveal_bytes = bincode::serialize(reveal).unwrap_or_default();
                    (node_id.clone(), reveal_bytes)
                })
                .collect()
        } else {
            HashMap::new()
        }
    }

    /// Get current participants list
    pub fn get_current_participants(&self) -> Vec<String> {
        if let Some(state) = &self.current_round {
            state.participants.clone()
        } else {
            Vec::new()
        }
    }

    /// Get randomness beacon for MacroBlock storage
    /// Returns XOR of all reveal nonces for unpredictable randomness
    pub fn get_randomness_beacon(&self) -> Option<[u8; 32]> {
        if let Some(state) = &self.current_round {
            if state.reveals.is_empty() {
                return None;
            }
            
            // XOR all reveal nonces for entropy accumulation
            let mut beacon = [0u8; 32];
            for reveal in state.reveals.values() {
                for (i, byte) in reveal.nonce.iter().enumerate() {
                    beacon[i] ^= byte;
                }
            }
            Some(beacon)
        } else {
            None
        }
    }

    /// PRODUCTION v2.40.3: Compute leader for specific failover round
    /// 
    /// NOTE: This function is used for FAILOVER only, not primary leader selection!
    /// For primary selection, use select_leader() which includes XOR-based entropy.
    /// 
    /// Failover uses beacon + round for deterministic rotation when primary leader fails.
    /// This is intentionally simpler because:
    /// 1. Failover happens after reveals are already collected for primary
    /// 2. Round number changes → different leader each failover attempt
    /// 3. Beacon (if available) adds unpredictability from previous epochs
    pub fn compute_leader_for_round(
        &self,
        height: u64,
        round: u64,
        participants: &[String],
        beacon: Option<&[u8; 32]>,
    ) -> Option<String> {
        if participants.is_empty() {
            return None;
        }

        // ═══════════════════════════════════════════════════════════════════════
        // v15.2: ROUND-ROBIN LEADER ROTATION — mirrors the microblock producer
        // rotation and the macroblock initiator picker in `should_initiate_consensus`.
        //
        // Formula:
        //   base_idx = SHA3-512(entropy ‖ height ‖ sorted_participants) % N
        //   leader   = sorted_participants[ (base_idx + round) % N ]
        //
        // Why this replaced the previous hash-with-round approach:
        //   The old compute mixed `round` INTO the hash input, which meant every
        //   view-change gave a fresh random pick from N candidates. A dead or
        //   partitioned validator could be re-selected multiple rounds in a
        //   row with probability 1/N each round — livelock when that node
        //   kept being picked. Round-robin advances by exactly one slot per
        //   view-change, so after N rounds every candidate has had its turn.
        //   Guaranteed progress even against hostile leader hashing.
        //
        // Symmetry: matches
        //   * `select_microblock_producer_with_round` at the microblock layer
        //   * `should_initiate_consensus` at the macroblock initiator layer
        //   Three leader decisions, one rotation model. Identical failover
        //   guarantees across both consensus tiers.
        //
        // Safety:
        //   * `base_idx` derives only from on-chain/entropy inputs shared by
        //     every honest node at the same (height, participants, beacon).
        //   * `round` comes from `HIGHEST_CERTIFIED_ROUND[mb]`, advanced only
        //     by 2f+1 Dilithium3-signed TimeoutVotes, so no ≤ f adversary can
        //     skew it.
        //   * Sorted participants list is the same canonical committee view
        //     used by the initiator picker.
        //
        // Scalability: O(N) hash prep + O(1) modular arithmetic. At the
        // MAX_VALIDATORS=1000 committee cap this is sub-millisecond. No
        // allocation per round beyond the one-time sorted participant vector.
        // ═══════════════════════════════════════════════════════════════════════

        use sha3::{Sha3_512, Digest};
        let mut hasher = Sha3_512::new();

        // Version tag for hash domain separation — keep stable base_idx so view
        // rotation is the only thing that advances the leader.
        hasher.update(b"QNet_Failover_Leader_v15.2");

        // ENTROPY: Randomness beacon (from blockchain).
        // Beacon is ALWAYS provided (Genesis hash for epoch 1-2, MB N-2 for 3+).
        // This ensures compute_leader matches should_initiate_consensus entropy.
        if let Some(b) = beacon {
            hasher.update(b);
        } else {
            // Beacon should ALWAYS be provided; deterministic fallback.
            println!("[WARN][CONS] beacon=None using_fallback");
            hasher.update(b"QNet_Genesis_Beacon_v2.47");
        }

        // Height (deterministic, same on all nodes for the same macroblock).
        hasher.update(&height.to_le_bytes());

        // NOTE: `round` is deliberately NOT fed into the hash. Mixing it in
        // would make every view-change a fresh random pick from N candidates —
        // the bug path this version fixes. The round-robin offset is applied
        // AFTER base_idx is computed.

        // Sort participants for deterministic ordering — the same sorted list
        // is the input to `(base_idx + round) % N` below, so every honest
        // node indexes into the identical sequence.
        let mut sorted_participants = participants.to_vec();
        sorted_participants.sort();

        for node_id in &sorted_participants {
            hasher.update(node_id.as_bytes());
        }

        let hash = hasher.finalize();

        // Stable base index — identical across view rounds for the same
        // macroblock boundary.
        let hash_number = u64::from_le_bytes([
            hash[0], hash[1], hash[2], hash[3],
            hash[4], hash[5], hash[6], hash[7],
        ]);
        let base_idx = (hash_number as usize) % sorted_participants.len();

        // Apply view-round offset — one slot advance per BFT-certified view
        // change. Covers every distinct candidate in N rounds.
        let selection_index = (base_idx + round as usize) % sorted_participants.len();
        let selected_leader = sorted_participants[selection_index].clone();

        println!(
            "[INFO][CONS] leader_compute node={} round={} h={} base_idx={} final_idx={}/{}",
            selected_leader, round, height, base_idx, selection_index, sorted_participants.len(),
        );

        Some(selected_leader)
    }

} 
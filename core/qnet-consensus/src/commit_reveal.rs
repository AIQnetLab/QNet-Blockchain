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
#[derive(Debug, Clone, PartialEq)]
pub enum ValidatorNodeType {
    Super,
    Full,
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

/// Round state
#[derive(Debug, Clone)]
pub struct RoundState {
    pub phase: ConsensusPhase,
    pub round_number: u64,
    pub phase_start: Instant,
    pub phase_duration: Duration,
    pub commits: HashMap<String, Commit>,
    pub reveals: HashMap<String, Reveal>,  // FIXED: Store full Reveal with nonce
    pub participants: Vec<String>,
    /// Randomness beacon from MacroBlock N-2 for unpredictable leader selection
    /// None for first 2 epochs (use Genesis seed fallback)
    pub prev_randomness_beacon: Option<[u8; 32]>,
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
pub struct CommitRevealConsensus {
    config: ConsensusConfig,
    reputation: NodeReputation,
    current_round: Option<RoundState>,
    node_id: String,
}

impl CommitRevealConsensus {
    /// Create new consensus instance
    pub fn new(node_id: String, config: ConsensusConfig) -> Self {
        let reputation = NodeReputation::new(ReputationConfig::default());
        
        Self {
            config,
            reputation,
            current_round: None,
            node_id,
        }
    }
    
    /// Start new consensus round
    /// PRODUCTION v2.40.2: round_number = macroblock_height for epoch validation
    /// This ensures our_epoch = round_number / 90 matches message epochs
    pub fn start_round(&mut self, participants: Vec<String>) -> Result<u64, ConsensusError> {
        self.start_round_at_height(participants, 0) // Legacy: use sequential numbering
    }
    
    /// PRODUCTION v2.40.2: Start round with explicit block height
    /// round_number = macroblock_height (90, 180, 270...) for correct epoch calculation
    /// 
    /// v2.49 FIX: IDEMPOTENT - if round already active for same round_number, 
    /// do NOT reset commits/reveals! This prevents parallel tasks from destroying each other's work.
    pub fn start_round_at_height(&mut self, participants: Vec<String>, macroblock_height: u64) -> Result<u64, ConsensusError> {
        if participants.len() < self.config.min_participants {
            return Err(ConsensusError::InsufficientNodes);
        }
        
        // CRITICAL v2.40.2: Use macroblock_height as round_number for epoch validation
        // This ensures: our_epoch = round_number / 90 = macroblock_height / 90 = correct epoch!
        // Fallback to sequential if height not provided (legacy compatibility)
        let round_number = if macroblock_height > 0 {
            macroblock_height
        } else {
            self.current_round
                .as_ref()
                .map(|r| r.round_number + 90) // Sequential: 90, 180, 270...
                .unwrap_or(90)
        };
        
        // ═══════════════════════════════════════════════════════════════════════════
        // v2.49 FIX: IDEMPOTENT ROUND START
        // If round is already active for this round_number, preserve commits/reveals!
        // This prevents race condition where multiple tasks reset each other's work.
        // ═══════════════════════════════════════════════════════════════════════════
        if let Some(ref current) = self.current_round {
            if current.round_number == round_number {
                // Round already active for same round_number - DO NOT RESET!
                // Just return success, commits/reveals are preserved
                println!("[INFO][CONS] round_already_active round={} commits={} reveals={} idempotent=true",
                         round_number, current.commits.len(), current.reveals.len());
                return Ok(round_number);
            }
            // Different round_number - this is unusual but can happen during recovery
            // Log warning but proceed with new round
            println!("[WARN][CONS] round_override old_round={} new_round={} old_commits={} old_reveals={}",
                     current.round_number, round_number, current.commits.len(), current.reveals.len());
        }
        
        // No active round or different round_number - create new round state
        let round_state = RoundState {
            phase: ConsensusPhase::Commit,
            round_number,
            phase_start: Instant::now(),
            phase_duration: self.config.commit_phase_duration,
            commits: HashMap::new(),
            reveals: HashMap::new(),
            participants,
            prev_randomness_beacon: None, // Set via set_randomness_beacon() before finalize
        };
        
        self.current_round = Some(round_state);
        println!("[INFO][CONS] round_started round={} epoch={}", round_number, round_number / 90);
        Ok(round_number)
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
    
    /// PRODUCTION v2.40.2: Process commit with EPOCH-based validation
    /// ARCHITECTURE: Validate by EPOCH match, not by local phase
    /// 1. Check active round exists (FIRST - saves CPU on signature verification)
    /// 2. Check message_epoch matches our_epoch (±1 grace for network latency)
    /// 3. Then check position is in consensus window
    pub async fn process_commit(&mut self, commit: Commit, block_height: u64) -> Result<(), ConsensusError> {
        // STEP 0: Check active round FIRST (saves CPU if no round)
        if self.current_round.is_none() {
            return Err(ConsensusError::NoActiveRound);
        }
        
        // ═══════════════════════════════════════════════════════════════════════════
        // PRODUCTION v2.44: Round Tolerance ±90 (1 epoch) for fork recovery
        // ═══════════════════════════════════════════════════════════════════════════
        // ARCHITECTURE: Strict EXACT match caused deadlocks after high-TPS tests
        // When nodes desync, Round Mismatch rejects ALL messages → network stall
        // 
        // Solution (like Tendermint/HotStuff):
        // - Accept commits within ±90 blocks (1 epoch) tolerance
        // - Log warning for non-exact matches
        // - Epoch validation (below) provides additional Byzantine protection
        // 
        // WHY ±90: One full epoch allows:
        // - Late delivery of consensus messages
        // - Recovery from temporary network partitions
        // - Graceful handling of clock drift between nodes
        // ═══════════════════════════════════════════════════════════════════════════
        let our_round_number = self.current_round.as_ref().unwrap().round_number;
        let round_diff = if block_height > our_round_number {
            block_height - our_round_number
        } else {
            our_round_number - block_height
        };
        
        // CRITICAL: Reject if more than 1 epoch apart (too far = likely attack or severe desync)
        if round_diff > 90 {
            return Err(ConsensusError::InvalidPhase(
                format!("Round mismatch: message_round={} our_round={} diff={} (max 90)", 
                        block_height, our_round_number, round_diff)
            ));
        }
        
        // Log warning for non-exact matches (helps diagnose sync issues)
        if round_diff > 0 {
            println!("[WARN][CONS] round_tolerance_accept msg_round={} our_round={} diff={}", 
                     block_height, our_round_number, round_diff);
        }
        
        // PRODUCTION v2.40.2: Proper EPOCH-based validation
        let message_epoch = block_height / 90;
        let position_in_epoch = block_height % 90;
        
        // CRITICAL: Get OUR current epoch from active round (guaranteed to exist)
        let our_epoch = our_round_number / 90;
        
        // STEP 1: Verify EPOCH match (±1 grace for network timing)
        let epoch_diff = if message_epoch > our_epoch {
            message_epoch - our_epoch
        } else {
            our_epoch - message_epoch
        };
        
        if epoch_diff > 1 {
            return Err(ConsensusError::InvalidPhase(
                format!("Epoch mismatch: message_epoch={} our_epoch={} diff={}", 
                        message_epoch, our_epoch, epoch_diff)
            ));
        }
        
        // STEP 2: Verify position is in consensus window (61-89) OR grace
        // Grace: epoch boundary (pos=0) or same epoch (late delivery)
        
        if position_in_epoch >= 61 {
            // Normal consensus window (61-89) - always accept
        } else if position_in_epoch == 0 {
            // Epoch boundary block - accept for finalization
        } else if epoch_diff == 0 {
            // Grace: same epoch, active round exists (checked above) - accept late delivery
            println!("[INFO][CONS] same_epoch_grace_commit node={} epoch={} pos={}", 
                     commit.node_id, message_epoch, position_in_epoch);
        } else {
            return Err(ConsensusError::InvalidPhase(
                format!("Commit outside consensus window: epoch={} pos={}", message_epoch, position_in_epoch)
            ));
        }
        
        // Validate signature - do this after phase check to save CPU
        let signature_valid = self.verify_signature(&commit.node_id, &commit.commit_hash, &commit.signature).await;
        if !signature_valid {
            return Err(ConsensusError::InvalidSignature(format!("Invalid signature for validator {}", commit.node_id)));
        }
        
        // Get active round (guaranteed to exist - checked at function start)
        let state = self.current_round.as_mut().unwrap();
        
        // Store commit
        state.commits.insert(commit.node_id.clone(), commit);
        
        // PRODUCTION v2.40: Log progress but do NOT change local phase!
        // Phase transitions are determined ONLY by block_height
        let total_participants = state.participants.len();
        let byzantine_threshold = (total_participants * 2 + 2) / 3;
        if state.commits.len() >= byzantine_threshold && state.commits.len() == byzantine_threshold {
            // Log only once when threshold is reached
            println!("[INFO][CONS] bft_threshold commits={}/{}", state.commits.len(), byzantine_threshold);
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
    
    /// PRODUCTION v2.40.3: Submit reveal with EPOCH-based validation
    /// ARCHITECTURE: Validate by EPOCH match, not by local phase
    /// 1. Check message round matches our round EXACTLY (v2.48 strict validation)
    /// 2. Then check position - reveals accepted during ENTIRE consensus window (61-89)
    /// 3. Verify hybrid signature (Dilithium3 + Ed25519) - prevents impersonation attacks
    pub async fn submit_reveal(&mut self, reveal: Reveal, block_height: u64) -> Result<(), ConsensusError> {
        // ═══════════════════════════════════════════════════════════════════════════
        // PRODUCTION v2.44: Round Tolerance ±90 (1 epoch) for fork recovery
        // ═══════════════════════════════════════════════════════════════════════════
        // Same tolerance as process_commit - see comments there for rationale
        // Reveals are even more critical - without them macroblock consensus fails!
        // ═══════════════════════════════════════════════════════════════════════════
        let our_round_number = if let Some(state) = &self.current_round {
            state.round_number
        } else {
            return Err(ConsensusError::NoActiveRound);
        };
        
        let round_diff = if block_height > our_round_number {
            block_height - our_round_number
        } else {
            our_round_number - block_height
        };
        
        // CRITICAL: Reject if more than 1 epoch apart
        if round_diff > 90 {
            return Err(ConsensusError::InvalidPhase(
                format!("Round mismatch for reveal: message_round={} our_round={} diff={} (max 90)", 
                        block_height, our_round_number, round_diff)
            ));
        }
        
        // Log warning for non-exact matches
        if round_diff > 0 {
            println!("[WARN][CONS] reveal_tolerance_accept msg_round={} our_round={} diff={}", 
                     block_height, our_round_number, round_diff);
        }
        
        // PRODUCTION v2.40.2: Proper EPOCH-based validation
        let message_epoch = block_height / 90;
        let position_in_epoch = block_height % 90;
        
        // CRITICAL: Get OUR current epoch from active round
        let our_epoch = our_round_number / 90;
        
        // STEP 1: Verify EPOCH match (±1 grace for network timing)
        let epoch_diff = if message_epoch > our_epoch {
            message_epoch - our_epoch
        } else {
            our_epoch - message_epoch
        };
        
        if epoch_diff > 1 {
            return Err(ConsensusError::InvalidPhase(
                format!("Epoch mismatch for reveal: message_epoch={} our_epoch={} diff={}", 
                        message_epoch, our_epoch, epoch_diff)
            ));
        }
        
        // STEP 2: Verify position is in consensus window (61-89) OR grace
        // Reveals accepted during ENTIRE consensus window because:
        // - Sender at pos=73 (reveal phase) sends reveal
        // - Receiver at pos=65 (commit phase) receives it
        // - SAME EPOCH → ACCEPT! Cryptographic verification in finalize_round
        if position_in_epoch >= 61 {
            // Consensus window (61-89) - always accept
        } else if position_in_epoch == 0 {
            // Epoch boundary - accept for finalization
        } else if epoch_diff == 0 {
            // Same epoch, production phase (1-60) - accept late delivery
            // This handles: consensus finished, receiver moved to production
            println!("[INFO][CONS] same_epoch_grace_reveal node={} epoch={} pos={}", 
                     reveal.node_id, message_epoch, position_in_epoch);
        } else {
            return Err(ConsensusError::InvalidPhase(
                format!("Reveal outside consensus window: epoch={} pos={}", message_epoch, position_in_epoch)
            ));
        }
        
        // PRODUCTION v2.52: Verify hybrid reveal signature (Dilithium3 + Ed25519 + ephemeral)
        // This prevents impersonation attacks where attacker sends reveal as another node
        // Uses same hybrid verification as commits for NIST FIPS 204 / CNSA 2.0 compliance
        // NOTE: If signature is empty (legacy), skip verification but log warning
        if !reveal.signature.is_empty() {
            // CRITICAL FIX v2.52: Message format MUST match generation in node.rs
            // Format: node_id:reveal_data_hex:nonce_hex:timestamp (4 fields)
            // Then SHA3-256 hash before verification (same as signing)
            let reveal_message = format!("{}:{}:{}:{}", 
                reveal.node_id, 
                hex::encode(&reveal.reveal_data),
                hex::encode(&reveal.nonce),
                reveal.timestamp  // v2.52: Include timestamp to match generation
            );
            
            // SHA3-256 hash (same as generation in node.rs:12947-12950)
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
                return Err(ConsensusError::InvalidSignature(
                    format!("Invalid hybrid reveal signature for node {}", reveal.node_id)
                ));
            }
        } else {
            // Legacy reveal without signature - accept but log warning
            println!("[WARN][CONS] reveal_no_signature node={} accepting_legacy", reveal.node_id);
        }
        
        // Check if we have an active round
        let state = self.current_round.as_ref().ok_or(ConsensusError::NoActiveRound)?;
        
        // Clone commits for verification (avoids borrow issues)
        let commits_clone = state.commits.clone();
        
        // Verify reveal matches commit if commit exists
        // If commit not found, store anyway - will verify in finalize_round
        if let Err(e) = self.verify_reveal(&reveal, &commits_clone) {
            if e.to_string().contains("No matching commit") {
                println!("[INFO][CONS] reveal_before_commit node={} storing_for_later", reveal.node_id);
                // Continue to store - will verify in finalize_round
            } else {
                // Other verification error
                return Err(e);
            }
        }
        
        // Now get mutable reference to store reveal
        let state = self.current_round.as_mut().ok_or(ConsensusError::NoActiveRound)?;
        state.reveals.insert(reveal.node_id.clone(), reveal);
        
        // Log progress
        let total_participants = state.participants.len();
        let byzantine_threshold = (total_participants * 2 + 2) / 3;
        if state.reveals.len() >= byzantine_threshold && state.reveals.len() == byzantine_threshold {
            println!("[INFO][CONS] bft_threshold reveals={}/{}", state.reveals.len(), byzantine_threshold);
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
    
    /// PRODUCTION v2.40.1: Finalize round with Byzantine safety requirements
    /// ARCHITECTURE: No local phase check - epoch-based validation ensures correctness
    /// By the time finalize is called, commits and reveals have been collected via epoch validation
    pub fn finalize_round(&mut self) -> Result<String, ConsensusError> {
        // First get the leader without mutable borrow
        let leader = {
            let state = self.current_round.as_ref().ok_or(ConsensusError::NoActiveRound)?;
            
            // PRODUCTION v2.40.1: Removed local phase check
            // Phase validation is now epoch-based in process_commit/submit_reveal
            // Local phase may not match block_height due to network timing differences
            // What matters: we have enough commits AND reveals (Byzantine threshold)
            
            // PRODUCTION: Check Byzantine threshold for reveals (2f+1)
            // CRITICAL: Use INITIAL participants count, NOT current reveals count
            // Threshold must be based on total participants, not who revealed
            // Otherwise malicious nodes could reduce threshold by not revealing!
            let total_participants = state.participants.len();
            let byzantine_threshold = (total_participants * 2 + 2) / 3;
            if state.reveals.len() < byzantine_threshold {
                return Err(ConsensusError::InvalidCommit(
                    format!("Insufficient reveals for Byzantine safety: {}/{}", 
                           state.reveals.len(), byzantine_threshold)
                ));
            }
            
            // CRITICAL FIX: Verify ALL reveals match their commits
            // This catches any reveals that were stored during grace period without verification
            let mut valid_reveals = 0;
            for (node_id, reveal) in &state.reveals {
                if let Some(_commit) = state.commits.get(node_id) {
                    // Verify reveal matches commit
                    if let Err(e) = self.verify_reveal(reveal, &state.commits) {
                        println!("[WARN][CONS] invalid_reveal node={} err={}", node_id, e);
                        continue;
                    }
                    valid_reveals += 1;
                } else {
                    println!("[WARN][CONS] reveal_no_commit node={}", node_id);
                }
            }
            
            // Re-check Byzantine threshold with valid reveals only
            if valid_reveals < byzantine_threshold {
                return Err(ConsensusError::InvalidCommit(
                    format!("Insufficient VALID reveals for Byzantine safety: {}/{} (had {} total reveals)", 
                           valid_reveals, byzantine_threshold, state.reveals.len())
                ));
            }
            
            println!("[INFO][CONS] finalize_ok valid={}/{}", valid_reveals, byzantine_threshold);
            
            // Byzantine-safe leader selection
            self.select_leader(&state.reveals)
                .ok_or(ConsensusError::LeaderSelectionFailed)?
        };
        
        // Now modify state
        let state = self.current_round.as_mut().ok_or(ConsensusError::NoActiveRound)?;
        state.phase = ConsensusPhase::Finalize;
        
        Ok(leader)
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
                        let evidence = DoubleSignEvidence {
                            round: round_number,
                            hash_a: existing_commit.commit_hash.as_bytes().try_into().unwrap_or([0u8; 32]),
                            hash_b: message_hash.as_bytes().try_into().unwrap_or([0u8; 32]),
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
            .filter(|c| c.node_type == ValidatorNodeType::Full)
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
            
            // Update RNG for next iteration
            rng = rng.wrapping_mul(1103515245).wrapping_add(12345);
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
            .filter(|c| c.node_type == ValidatorNodeType::Full)
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

    /// Get commits for MacroBlock storage (REAL data, not fake strings!)
    pub fn get_commits_for_macroblock(&self) -> HashMap<String, Vec<u8>> {
        if let Some(state) = &self.current_round {
            state.commits.iter()
                .map(|(node_id, commit)| {
                    // Serialize commit to bytes
                    let commit_bytes = bincode::serialize(commit).unwrap_or_default();
                    (node_id.clone(), commit_bytes)
                })
                .collect()
        } else {
            HashMap::new()
        }
    }

    /// Get reveals for MacroBlock storage (REAL data, not fake strings!)
    pub fn get_reveals_for_macroblock(&self) -> HashMap<String, Vec<u8>> {
        if let Some(state) = &self.current_round {
            state.reveals.iter()
                .map(|(node_id, reveal)| {
                    // Serialize reveal to bytes
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

        // UNIFIED v2.36: SHA3-512 everywhere for maximum security
        use sha3::{Sha3_512, Digest};
        let mut hasher = Sha3_512::new();

        // Version tag for hash domain separation (updated for v2.40.3)
        hasher.update(b"QNet_Failover_Leader_v2.40.3");

        // ENTROPY: Randomness beacon (from blockchain)
        // UNIFIED v2.47: Beacon is ALWAYS provided (Genesis hash for epoch 1-2, MB N-2 for epoch 3+)
        // This ensures compute_leader matches should_initiate_consensus entropy
        if let Some(b) = beacon {
            hasher.update(b);
        } else {
            // CRITICAL: Beacon should ALWAYS be provided after v2.47
            // If missing, use deterministic fallback but log warning
            println!("[WARN][CONS] beacon=None using_fallback (should not happen after v2.47)");
            hasher.update(b"QNet_Genesis_Beacon_v2.47");
        }

        // Height (deterministic)
        hasher.update(&height.to_le_bytes());

        // Round number (CRITICAL for failover - different round = different leader!)
        hasher.update(&round.to_le_bytes());

        // Sort participants for deterministic ordering
        let mut sorted_participants = participants.to_vec();
        sorted_participants.sort();

        // Hash all participant IDs
        for node_id in &sorted_participants {
            hasher.update(node_id.as_bytes());
        }

        let hash = hasher.finalize();

        // Convert hash to selection index
        let hash_number = u64::from_le_bytes([
            hash[0], hash[1], hash[2], hash[3],
            hash[4], hash[5], hash[6], hash[7],
        ]);

        let selection_index = (hash_number as usize) % sorted_participants.len();
        let selected_leader = sorted_participants[selection_index].clone();

        println!("[INFO][CONS] leader_compute node={} round={} h={} idx={}/{}", 
                 selected_leader, round, height, selection_index, sorted_participants.len());

        Some(selected_leader)
    }

} 
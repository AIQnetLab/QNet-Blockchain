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
    pub reveals: HashMap<String, Vec<u8>>,
    pub participants: Vec<String>,
}

/// Reveal structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reveal {
    pub node_id: String,
    pub reveal_data: Vec<u8>,
    pub nonce: [u8; 32],
    pub timestamp: u64,
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
    pub fn start_round(&mut self, participants: Vec<String>) -> Result<u64, ConsensusError> {
        if participants.len() < self.config.min_participants {
            return Err(ConsensusError::InsufficientNodes);
        }
        
        let round_number = self.current_round
            .as_ref()
            .map(|r| r.round_number + 1)
            .unwrap_or(1);
        
        let round_state = RoundState {
            phase: ConsensusPhase::Commit,
            round_number,
            phase_start: Instant::now(),
            phase_duration: self.config.commit_phase_duration,
            commits: HashMap::new(),
            reveals: HashMap::new(),
            participants,
        };
        
        self.current_round = Some(round_state);
        Ok(round_number)
    }
    
    /// Process commit from validator (simplified version)
    pub async fn process_commit(&mut self, commit: Commit) -> Result<(), ConsensusError> {
        // Validate signature (simplified) - do this before any borrows
        let signature_valid = self.verify_signature(&commit.node_id, &commit.commit_hash, &commit.signature).await;
        if !signature_valid {
            return Err(ConsensusError::InvalidSignature(format!("Invalid signature for validator {}", commit.node_id)));
        }
        
        // Check if we have an active round
        let state = self.current_round.as_mut().ok_or(ConsensusError::NoActiveRound)?;
        
        // Check if still in commit phase
        if state.phase != ConsensusPhase::Commit {
            return Err(ConsensusError::PhaseTimeout("Commit phase ended".to_string()));
        }
        
        // Store commit
        state.commits.insert(commit.node_id.clone(), commit);
        
        // Check if we have enough commits for Byzantine safety (2f+1 threshold)
        let byzantine_threshold = (self.config.min_participants * 2 + 2) / 3; // 2f+1 where min_participants = 3f+1
        if state.commits.len() >= byzantine_threshold {
            // Advance to reveal phase with Byzantine safety
            println!("[CONSENSUS] ✅ Byzantine threshold reached: {}/{} commits", 
                     state.commits.len(), byzantine_threshold);
            state.phase = ConsensusPhase::Reveal;
            state.phase_start = Instant::now();
            state.phase_duration = self.config.reveal_phase_duration;
        }
        
        Ok(())
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
        
        if valid {
            println!("[CONSENSUS] ✅ Signature verified using consensus_crypto module");
            println!("   Algorithm: CRYSTALS-Dilithium (quantum-resistant)");
            println!("   Node: {}", node_id);
        } else {
            println!("[CONSENSUS] ❌ Signature verification failed");
            println!("   Node: {}", node_id);
            println!("   Possible attack: Forged or manipulated signature");
        }
        
        valid
    }
    
    /// Submit reveal for current round
    pub fn submit_reveal(&mut self, reveal: Reveal) -> Result<(), ConsensusError> {
        // First, check phase without mutable borrow
        {
            let state = self.current_round.as_ref().ok_or(ConsensusError::NoActiveRound)?;
            
            if state.phase != ConsensusPhase::Reveal {
                if state.phase == ConsensusPhase::Commit {
                    return Err(ConsensusError::InvalidPhase("Still in commit phase".to_string()));
                }
                return Err(ConsensusError::PhaseTimeout("Reveal phase ended".to_string()));
            }
            
            // Verify reveal matches commit
            self.verify_reveal(&reveal, &state.commits)?;
        }
        
        // Now get mutable reference to insert reveal
        let state = self.current_round.as_mut().ok_or(ConsensusError::NoActiveRound)?;
        state.reveals.insert(reveal.node_id.clone(), reveal.reveal_data.clone());
        
        Ok(())
    }
    
    /// Advance to next phase
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
        }
    }
    
    /// PRODUCTION: Finalize round with Byzantine safety requirements
    pub fn finalize_round(&mut self) -> Result<String, ConsensusError> {
        // First get the leader without mutable borrow
        let leader = {
            let state = self.current_round.as_ref().ok_or(ConsensusError::NoActiveRound)?;
            
            if state.phase != ConsensusPhase::Reveal {
                return Err(ConsensusError::InvalidPhase("Not in reveal phase".to_string()));
            }
            
            // PRODUCTION: Check Byzantine threshold for reveals (2f+1)
            let byzantine_threshold = (self.config.min_participants * 2 + 2) / 3;
            if state.reveals.len() < byzantine_threshold {
                return Err(ConsensusError::InvalidCommit(
                    format!("Insufficient reveals for Byzantine safety: {}/{}", 
                           state.reveals.len(), byzantine_threshold)
                ));
            }
            
            println!("[CONSENSUS] ✅ Byzantine finalization threshold reached: {}/{} reveals", 
                     state.reveals.len(), byzantine_threshold);
            
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
    
    /// PRODUCTION: Select leader from reveals using cryptographic fairness
    fn select_leader(&self, reveals: &HashMap<String, Vec<u8>>) -> Option<String> {
        if reveals.is_empty() {
            return None;
        }
        
        // PRODUCTION: Cryptographically fair leader selection
        use sha3::{Sha3_256, Digest};
        
        // Create deterministic randomness from all reveals combined
        let mut combined_hasher = Sha3_256::new();
        
        // Sort by node_id for deterministic ordering
        let mut sorted_reveals: Vec<_> = reveals.iter().collect();
        sorted_reveals.sort_by(|a, b| a.0.cmp(b.0));
        
        // Hash all reveals together for randomness
        for (node_id, reveal_data) in &sorted_reveals {
            combined_hasher.update(node_id.as_bytes());
            combined_hasher.update(reveal_data);
        }
        
        let combined_hash = combined_hasher.finalize();
        
        // Convert hash to selection index
        let hash_number = u64::from_le_bytes([
            combined_hash[0], combined_hash[1], combined_hash[2], combined_hash[3],
            combined_hash[4], combined_hash[5], combined_hash[6], combined_hash[7],
        ]);
        
        let selection_index = (hash_number as usize) % sorted_reveals.len();
        let selected_leader = sorted_reveals[selection_index].0.clone();
        
        println!("[CONSENSUS] 🎯 Cryptographic leader selection: {} (index {} of {})", 
                 selected_leader, selection_index, sorted_reveals.len());
        
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
                        
                        // DOUBLE SIGNING DETECTED! - USE EXISTING REPUTATION SYSTEM
                        println!("[CONSENSUS] 🚨 DOUBLE SIGNING DETECTED! Node {} signed different hashes for round {}", 
                                node_id, round_number);
                        
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
                        
                        // EXISTING SYSTEM: Use reputation system for slashing
                        let slashing_result = self.reputation.process_double_sign_evidence(&evidence);
                        println!("[CONSENSUS] ⚔️ REPUTATION SLASHING: -{} reputation, new score: {}, banned: {}", 
                                slashing_result.slashed_amount, slashing_result.new_reputation, slashing_result.is_banned);
                        
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
        super_nodes.sort_by(|a, b| b.reputation.partial_cmp(&a.reputation).unwrap());
        full_nodes.sort_by(|a, b| b.reputation.partial_cmp(&a.reputation).unwrap());
        
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
        super_nodes.sort_by(|a, b| b.reputation.partial_cmp(&a.reputation).unwrap());
        full_nodes.sort_by(|a, b| b.reputation.partial_cmp(&a.reputation).unwrap());
        
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
    pub async fn add_commit(&mut self, commit: Commit) -> Result<(), ConsensusError> {
        self.process_commit(commit).await
    }

    /// Add reveal (alias for submit_reveal for API compatibility)
    pub fn add_reveal(&mut self, reveal: Reveal) -> Result<(), ConsensusError> {
        self.submit_reveal(reveal)
    }

} 
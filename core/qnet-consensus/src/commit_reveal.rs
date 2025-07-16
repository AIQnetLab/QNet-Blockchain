#![allow(dead_code)]

//! Commit-Reveal consensus mechanism for QNet
//! Provides Byzantine fault tolerance and secure leader election

use std::collections::HashMap;
use std::time::{Duration, Instant};
use crate::errors::ConsensusError;
use serde::{Deserialize, Serialize};

/// Simple node reputation for consensus
#[derive(Debug, Clone)]
pub struct NodeReputation {
    pub node_id: String,
    pub reputation_score: f64,
    pub last_updated: u64,
}

impl NodeReputation {
    pub fn new(node_id: String) -> Self {
        Self {
            node_id,
            reputation_score: 0.5, // Start with neutral reputation
            last_updated: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        }
    }
}

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
    pub stake_weight: f64,
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
    pub super_node_guarantee: usize,      // Guaranteed super nodes per round
    pub full_node_slots: usize,          // Full node slots per round
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
            super_node_guarantee: 200,         // 200 super nodes guaranteed
            full_node_slots: 800,             // 800 full node slots
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
        let reputation = NodeReputation::new(node_id.clone());
        
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
    pub fn process_commit(&mut self, commit: Commit) -> Result<(), ConsensusError> {
        // Validate signature (simplified) - do this before any borrows
        let signature_valid = self.verify_signature(&commit.node_id, &commit.commit_hash, &commit.signature);
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
        
        // Check if we have enough commits
        if state.commits.len() >= self.config.min_participants {
            // Advance to reveal phase
            state.phase = ConsensusPhase::Reveal;
            // Use reveal_phase_duration instead of reveal_timeout
            state.phase_start = Instant::now();
            state.phase_duration = self.config.reveal_phase_duration;
        }
        
        Ok(())
    }
    
    /// Verify signature (simplified implementation)
    fn verify_signature(&self, _node_id: &str, _message: &str, signature: &str) -> bool {
        // In production, this would verify actual cryptographic signatures
        // For now, we simulate signature verification
        !signature.is_empty() && signature.len() > 10
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
    
    /// Finalize round (simplified)
    pub fn finalize_round(&mut self) -> Result<String, ConsensusError> {
        // First get the leader without mutable borrow
        let leader = {
            let state = self.current_round.as_ref().ok_or(ConsensusError::NoActiveRound)?;
            
            if state.phase != ConsensusPhase::Reveal {
                return Err(ConsensusError::InvalidPhase("Not in reveal phase".to_string()));
            }
            
            // Simple leader selection
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
    
    /// Simplified reputation-based validation
    pub fn validate_commit_reputation(&self, commit: &Commit) -> Result<(), ConsensusError> {
        // Simplified reputation check - in production would check actual reputation
        let reputation = self.reputation.reputation_score;
        
        if reputation < 0.1 {
            return Err(ConsensusError::InvalidCommit(format!("Low reputation for node {}", commit.node_id)));
        }
        
        // Simplified signature validation
        if commit.signature.len() < 10 {
            return Err(ConsensusError::InvalidSignature(format!("Invalid signature format for node {}", commit.node_id)));
        }
        
        Ok(())
    }
    
    /// Calculate commit hash from reveal data and nonce
    fn calculate_commit_hash(&self, reveal_data: &[u8], nonce: &[u8]) -> Vec<u8> {
        // Simple hash calculation - in production would use proper cryptographic hash
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        
        let mut hasher = DefaultHasher::new();
        reveal_data.hash(&mut hasher);
        nonce.hash(&mut hasher);
        let hash = hasher.finish();
        
        hash.to_be_bytes().to_vec()
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
    
    /// Select leader from reveals
    fn select_leader(&self, reveals: &HashMap<String, Vec<u8>>) -> Option<String> {
        if reveals.is_empty() {
            return None;
        }
        
        // Simple leader selection - in production would use proper algorithm
        reveals.keys().next().cloned()
    }
    
    /// Check for double signing
    fn check_double_signing(&self, node_id: &str, current_signature: &str) -> Result<(), ConsensusError> {
        // In production, this would check for actual double signing
        // For now, we simulate the check
        if current_signature.contains("double") {
            return Err(ConsensusError::DoubleSigningDetected(node_id.to_string()));
        }
        
        Ok(())
    }

    /// Select validators for sampling-based consensus (scalability)
    pub fn select_validators(&self, 
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
        
        // 4. Select guaranteed super nodes
        let super_count = self.config.super_node_guarantee.min(super_nodes.len());
        for i in 0..super_count {
            selected.push((*super_nodes[i]).clone());
        }
        
        // 5. Select full nodes (weighted random)
        let full_count = self.config.full_node_slots.min(full_nodes.len());
        let full_nodes_refs: Vec<&ValidatorCandidate> = full_nodes.iter().map(|c| **c).collect();
        let selected_full = self.weighted_random_selection(
            &full_nodes_refs, 
            full_count, 
            &selection_seed
        );
        selected.extend(selected_full);
        
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
                .map(|c| c.reputation * c.stake_weight)
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
                let weight = candidate.reputation * candidate.stake_weight;
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
} 
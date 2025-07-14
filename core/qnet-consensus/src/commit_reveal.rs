//! Commit-reveal consensus implementation

use crate::{
    errors::{ConsensusError, ConsensusResult},
    types::{Commit, ConsensusConfig, Reveal, RoundState, ConsensusPhase, RoundStatus, DoubleSignEvidence},
};
use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::RwLock;
use tracing::{debug, info, warn};
use std::time::Duration;

/// Configuration for commit-reveal consensus
#[derive(Debug, Clone)]
pub struct CommitRevealConfig {
    /// Duration of commit phase
    pub commit_duration: Duration,
    /// Duration of reveal phase  
    pub reveal_duration: Duration,
    /// Minimum validators required
    pub min_validators: usize,
}

impl Default for CommitRevealConfig {
    fn default() -> Self {
        Self {
            commit_duration: Duration::from_secs(60),
            reveal_duration: Duration::from_secs(30),
            min_validators: 3,
        }
    }
}

/// Commit-reveal consensus mechanism
pub struct CommitRevealConsensus {
    /// Current round state
    round_state: Arc<RwLock<Option<RoundState>>>,
    
    /// Configuration
    config: CommitRevealConfig,
    
    /// Consensus configuration
    consensus_config: ConsensusConfig,
    
    /// Node reputation manager
    reputation: Arc<crate::reputation::NodeReputation>,
    
    /// Node ID
    node_id: String,
}

impl CommitRevealConsensus {
    /// Create new consensus instance
    pub fn new(node_id: String, config: CommitRevealConfig) -> Self {
        let consensus_config = ConsensusConfig::default();
        let reputation_config = crate::reputation::ReputationConfig::default();
        Self {
            round_state: Arc::new(RwLock::new(None)),
            config,
            consensus_config,
            reputation: Arc::new(crate::reputation::NodeReputation::new(reputation_config)),
            node_id,
        }
    }
    
    /// Start a new round
    pub fn start_round(&self, round: u64) -> ConsensusResult<()> {
        let mut state = self.round_state.write();
        
        let current_time = current_timestamp();
        let commit_duration_ms = self.config.commit_duration.as_millis() as u64;
        let reveal_duration_ms = self.config.reveal_duration.as_millis() as u64;
        
        let new_state = RoundState {
            round,
            start_time: current_time,
            phase: ConsensusPhase::Commit,
            commits: HashMap::new(),
            reveals: HashMap::new(),
            commit_end_time: current_time + commit_duration_ms,
            reveal_end_time: current_time + commit_duration_ms + reveal_duration_ms,
            round_winner: None,
            winning_value: None,
            difficulty: 1.0,
            status: RoundStatus::Active,
            round_time: None,
        };
        
        *state = Some(new_state);
        info!("Started consensus round {}", round);
        Ok(())
    }
    
    /// Generate a commit
    pub fn generate_commit(&self) -> ConsensusResult<HashMap<String, String>> {
        // Generate random value and nonce
        let value = rand::random::<u64>();
        let nonce = rand::random::<u64>();
        
        // Create commit hash
        let commit_data = format!("{}:{}", value, nonce);
        let hash = blake3::hash(commit_data.as_bytes()).to_hex().to_string();
        
        debug!("Generated commit with hash: {}", hash);
        
        Ok(HashMap::from([
            ("hash".to_string(), hash),
            ("value".to_string(), value.to_string()),
            ("nonce".to_string(), nonce.to_string()),
        ]))
    }
    
    /// Add a commit from a node
    pub fn add_commit(&self, node_address: &str, commit_hash: &str, signature: &str) -> ConsensusResult<()> {
        let mut state = self.round_state.write();
        let round_state = state.as_mut().ok_or(ConsensusError::NoActiveRound)?;
        
        // Check if we're in commit phase
        let current_time = current_timestamp();
        if current_time > round_state.commit_end_time {
            return Err(ConsensusError::PhaseTimeout("Commit phase ended".to_string()));
        }
        
        // Add commit
        let commit = Commit {
            hash: commit_hash.to_string(),
            timestamp: current_time,
            signature: signature.to_string(),
        };
        
        round_state.commits.insert(node_address.to_string(), commit);
        debug!("Added commit from node {}", node_address);
        
        Ok(())
    }
    
    /// Add a reveal from a node
    pub fn add_reveal(&self, node_address: &str, reveal_value: &str) -> ConsensusResult<()> {
        let mut state = self.round_state.write();
        let round_state = state.as_mut().ok_or(ConsensusError::NoActiveRound)?;
        
        // Check if we're in reveal phase
        let current_time = current_timestamp();
        if current_time < round_state.commit_end_time {
            return Err(ConsensusError::InvalidPhase("Still in commit phase".to_string()));
        }
        if current_time > round_state.reveal_end_time {
            return Err(ConsensusError::PhaseTimeout("Reveal phase ended".to_string()));
        }
        
        // Verify reveal matches commit
        if let Some(commit) = round_state.commits.get(node_address) {
            let reveal_hash = blake3::hash(reveal_value.as_bytes()).to_hex().to_string();
            if reveal_hash != commit.hash {
                warn!("Invalid reveal from node {}: hash mismatch", node_address);
                return Err(ConsensusError::InvalidReveal("Hash mismatch".to_string()));
            }
            
            // Parse reveal value and nonce
            let parts: Vec<&str> = reveal_value.split(':').collect();
            if parts.len() != 2 {
                return Err(ConsensusError::InvalidReveal("Invalid reveal format".to_string()));
            }
            
            let reveal = Reveal {
                value: parts[0].to_string(),
                nonce: parts[1].to_string(),
                timestamp: current_time,
            };
            
            round_state.reveals.insert(node_address.to_string(), reveal);
            
            // Update reputation for successful reveal
            self.reputation.record_success(node_address);
            
            debug!("Added valid reveal from node {}", node_address);
            Ok(())
        } else {
            Err(ConsensusError::InvalidReveal("No commit found".to_string()))
        }
    }
    
    /// Determine the leader for the round
    pub fn determine_leader(&self, eligible_nodes: &[String], random_beacon: &str) -> ConsensusResult<String> {
        if eligible_nodes.is_empty() {
            return Err(ConsensusError::InsufficientNodes);
        }
        
        // Filter nodes by reputation threshold
        let qualified_nodes: Vec<String> = eligible_nodes
            .iter()
            .filter(|node| self.reputation.get_reputation(node) >= self.consensus_config.reputation_threshold)
            .cloned()
            .collect();
        
        if qualified_nodes.is_empty() {
            // Fallback to all nodes if none meet threshold
            warn!("No nodes meet reputation threshold, using all nodes");
            return self.reputation
                .weighted_selection(eligible_nodes, random_beacon)
                .ok_or(ConsensusError::LeaderSelectionFailed);
        }
        
        // Use reputation-weighted selection
        self.reputation
            .weighted_selection(&qualified_nodes, random_beacon)
            .ok_or(ConsensusError::LeaderSelectionFailed)
    }
    
    /// Get current round state
    pub fn get_round_state(&self) -> Option<RoundState> {
        self.round_state.read().clone()
    }
    
    /// Get commit phase duration
    pub fn get_commit_duration(&self) -> u64 {
        self.config.commit_duration.as_millis() as u64
    }
    
    /// Get reveal phase duration
    pub fn get_reveal_duration(&self) -> u64 {
        self.config.reveal_duration.as_millis() as u64
    }
    
    /// Finalize round and update reputations
    pub fn finalize_round(&self) -> ConsensusResult<()> {
        let state = self.round_state.read();
        let round_state = state.as_ref().ok_or(ConsensusError::NoActiveRound)?;
        
        // Update reputation for nodes that didn't reveal
        for (node_address, _commit) in &round_state.commits {
            if !round_state.reveals.contains_key(node_address) {
                self.reputation.record_failure(node_address);
                warn!("Node {} committed but didn't reveal", node_address);
            }
        }
        
        // Apply reputation decay
        self.reputation.apply_decay();
        
        info!("Finalized round {} with {} reveals out of {} commits", 
              round_state.round,
              round_state.reveals.len(),
              round_state.commits.len());
        
        Ok(())
    }
    
    /// Detect double signing violations
    pub fn detect_double_sign(&self, node_id: &str, new_commit: &Commit) -> Option<DoubleSignEvidence> {
        let state = self.round_state.read();
        let round_state = state.as_ref()?;
        
        // Check if node already committed in this round
        if let Some(existing_commit) = round_state.commits.get(node_id) {
            // If hashes are different, it's double signing
            if existing_commit.hash != new_commit.hash {
                let evidence = DoubleSignEvidence {
                    round: round_state.round,
                    hash_a: blake3::hash(existing_commit.hash.as_bytes()).into(),
                    hash_b: blake3::hash(new_commit.hash.as_bytes()).into(),
                    offender: node_id.to_string(),
                    detected_at: current_timestamp(),
                    signature_a: existing_commit.signature.as_bytes().to_vec(),
                    signature_b: new_commit.signature.as_bytes().to_vec(),
                };
                
                warn!("Double signing detected from node {} in round {}", node_id, round_state.round);
                
                // Immediately penalize the offender
                let slashing_result = self.reputation.process_double_sign_evidence(&evidence);
                info!("Applied slashing penalty to {}: {:?}", node_id, slashing_result);
                
                return Some(evidence);
            }
        }
        
        None
    }
    
    /// Process incoming commit with double-sign detection
    pub fn process_commit_with_detection(&self, node_address: &str, commit_hash: &str, signature: &str) -> ConsensusResult<()> {
        let commit = Commit {
            hash: commit_hash.to_string(),
            timestamp: current_timestamp(),
            signature: signature.to_string(),
        };
        
        // Check for double signing before adding commit
        if let Some(evidence) = self.detect_double_sign(node_address, &commit) {
            // Broadcast evidence to network (in production)
            warn!("Broadcasting double-sign evidence for node {}", node_address);
            // TODO: Implement gossip::broadcast_evidence(&evidence);
            
            // Reject the commit
            return Err(ConsensusError::DoubleSigningDetected(node_address.to_string()));
        }
        
        // If no double signing, add commit normally
        self.add_commit(node_address, commit_hash, signature)
    }
}

/// Get current timestamp in milliseconds
fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_commit_reveal_flow() {
        // Create config with very short phases for testing
        let config = CommitRevealConfig {
            commit_duration: Duration::from_millis(50),
            reveal_duration: Duration::from_millis(50),
            min_validators: 1,
        };
        
        let consensus = CommitRevealConsensus::new("node1".to_string(), config);
        
        // Start round
        consensus.start_round(1).unwrap();
        
        // Generate and add commit
        let commit_data = consensus.generate_commit().unwrap();
        let commit_hash = &commit_data["hash"];
        let value = &commit_data["value"];
        let nonce = &commit_data["nonce"];
        
        consensus.add_commit("node1", commit_hash, "signature").unwrap();
        
        // Wait for commit phase to end
        std::thread::sleep(std::time::Duration::from_millis(60));
        
        // Add reveal
        let reveal_value = format!("{}:{}", value, nonce);
        consensus.add_reveal("node1", &reveal_value).unwrap();
        
        // Verify state
        let state = consensus.get_round_state().unwrap();
        assert_eq!(state.commits.len(), 1);
        assert_eq!(state.reveals.len(), 1);
    }
    
    #[test]
    fn test_leader_selection() {
        let config = CommitRevealConfig::default();
        let consensus = CommitRevealConsensus::new("node1".to_string(), config);
        
        let nodes = vec!["node1".to_string(), "node2".to_string(), "node3".to_string()];
        let leader = consensus.determine_leader(&nodes, "test_beacon").unwrap();
        
        assert!(nodes.contains(&leader));
    }
} 
//! QNet Consensus Module
//! 
//! Implements commit-reveal consensus mechanism with reputation-based leader selection

#![warn(missing_docs)]

pub mod commit_reveal;
pub mod reputation;
pub mod dynamic_timing;
pub mod leader_selection;
pub mod errors;
pub mod types;
pub mod metrics;
pub mod fork_choice;
pub mod fork_resolution;
pub mod burn_security;
pub mod fork_manager;
pub mod kademlia;

#[cfg(feature = "python")]
pub mod python_bindings;

// Re-export main types
pub use types::{
    ConsensusState, ConsensusPhase, CommitData, RevealData,
    ValidatorInfo, ConsensusMessage, ConsensusRound,
    ConsensusConfig, DoubleSignEvidence, Evidence, SlashingResult,
};
pub use errors::{ConsensusError, ConsensusResult};
pub use reputation::ReputationSystem;
pub use dynamic_timing::DynamicTiming;
pub use leader_selection::LeaderSelector;
pub use metrics::ConsensusMetrics;
pub use fork_choice::ForkChoice;
pub use fork_resolution::ForkResolution;
pub use burn_security::BurnSecurityValidator;
pub use fork_manager::ForkManager;
pub use kademlia::{PeerScore, TokenBucket};

// Python bindings
#[cfg(feature = "python")]
pub use python_bindings::*;

// Export types needed by integration
pub use self::commit_reveal::{CommitRevealConsensus as CommitRevealEngine, CommitRevealConfig};

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// Node identifier type
pub type NodeId = String;

/// Result type for macro consensus
pub struct MacroConsensusResult {
    /// Commits from validators
    pub commits: HashMap<String, Vec<u8>>,
    /// Reveals from validators
    pub reveals: HashMap<String, Vec<u8>>,
    /// Selected leader for next round
    pub next_leader: String,
}

/// Consensus engine for QNet
pub struct ConsensusEngine {
    node_id: NodeId,
    authorized_producers: Vec<NodeId>,
    microblock_interval: u64, // seconds
}

impl ConsensusEngine {
    /// Create new consensus engine
    pub fn new(node_id: NodeId) -> Self {
        // Read interval from env var, fallback to 1 second (project spec June-2025)
        let interval = std::env::var("QNET_MICROBLOCK_INTERVAL")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|v| *v >= 1)
            .unwrap_or(1);

        Self {
            node_id: node_id.clone(),
            authorized_producers: vec![node_id],
            microblock_interval: interval,
        }
    }
    
    /// Validate a microblock
    pub async fn validate_microblock(
        &self,
        producer: &NodeId,
        height: u64,
        timestamp: u64,
    ) -> Result<bool, ConsensusError> {
        println!("[DEBUG] Validating microblock from producer: {:?}", producer);
        println!("[DEBUG] Height: {}, Timestamp: {}", height, timestamp);
        
        // Check timestamp
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let time_diff = if current_time > timestamp {
            current_time - timestamp
        } else {
            timestamp - current_time
        };
        
        println!("[DEBUG] Current time: {}, Time difference: {} seconds", current_time, time_diff);
        
        if time_diff > 10 {
            println!("[DEBUG] Invalid timestamp: too far from current time");
            return Ok(false);
        }
        
        // Check if producer is authorized
        let is_authorized = self.is_authorized_producer(producer).await;
        println!("[DEBUG] Producer authorization check: {}", is_authorized);
        
        if !is_authorized {
            println!("[DEBUG] Producer not authorized");
            return Ok(false);
        }
        
        // Check height
        let expected_height = self.get_expected_height().await;
        println!("[DEBUG] Expected height: {}, Actual height: {}", expected_height, height);
        
        if height > expected_height + 1 {
            println!("[DEBUG] Invalid height: too far ahead");
            return Ok(false);
        }
        
        println!("[DEBUG] Microblock validation successful");
        Ok(true)
    }
    
    /// Check if a producer is authorized to create microblocks
    async fn is_authorized_producer(&self, producer: &NodeId) -> bool {
        self.authorized_producers.contains(producer)
    }
    
    /// Get expected microblock height based on current time
    async fn get_expected_height(&self) -> u64 {
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        // Calculate expected height based on microblock interval
        // This is a simple calculation - in production you'd want more sophisticated logic
        current_time / self.microblock_interval
    }
    
    /// Run macro consensus for finalizing microblocks
    pub async fn run_macro_consensus(
        &self,
        microblock_hashes: Vec<[u8; 32]>,
        state_root: [u8; 32],
    ) -> ConsensusResult<MacroConsensusResult> {
        // Create consensus data
        let mut consensus_data = Vec::new();
        for hash in &microblock_hashes {
            consensus_data.extend_from_slice(hash);
        }
        consensus_data.extend_from_slice(&state_root);
        
        // For now, return simple result
        // TODO: Implement full commit-reveal consensus
        let mut commits = HashMap::new();
        let mut reveals = HashMap::new();
        
        commits.insert(self.node_id.clone(), vec![1, 2, 3]);
        reveals.insert(self.node_id.clone(), vec![4, 5, 6]);
        
        Ok(MacroConsensusResult {
            commits,
            reveals,
            next_leader: self.node_id.clone(),
        })
    }
} 
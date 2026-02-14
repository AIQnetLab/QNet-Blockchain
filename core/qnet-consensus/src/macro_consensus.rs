//! Macro consensus types with deterministic reputation integration
//!
//! ARCHITECTURE: MacroBlocks are checkpoints every 90 microblocks containing:
//! - Consensus participation data (who committed + revealed)
//! - Slashing events with cryptographic proof
//! - Automatic jails for missing consecutive blocks
//! - Next leader selection based on Dilithium3-VRF Secret Leader Election (v4.0)

use std::collections::{HashMap, HashSet};
use serde::{Deserialize, Serialize};
use sha3::{Sha3_256, Digest};

use crate::deterministic_reputation::{SlashingEvent, AutomaticJail};

// ============================================================================
// FINALITY CHECKPOINT - Protection against long-range attacks
// ============================================================================

/// Number of macroblocks required for finality
/// After FINALITY_DEPTH macroblocks with 2/3+ signatures, block is FINAL
pub const FINALITY_DEPTH: u64 = 2;

/// BFT threshold for finality (67% = 2/3+1)
pub const FINALITY_THRESHOLD: f64 = 0.67;

/// Finality checkpoint - proves a macroblock is irreversible
/// 
/// SECURITY: After 2 macroblocks with 2/3+ validator signatures,
/// the macroblock becomes FINAL and cannot be reverted.
/// This prevents long-range attacks where attacker tries to
/// rewrite history using old keys.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinalityCheckpoint {
    /// Macroblock index being finalized
    pub macroblock_index: u64,
    
    /// Hash of the macroblock data
    pub macroblock_hash: [u8; 32],
    
    /// Signatures from validators (node_id -> signature)
    pub signatures: HashMap<String, Vec<u8>>,
    
    /// Timestamp when checkpoint was created
    pub created_at: u64,
    
    /// Whether this checkpoint has achieved finality
    pub is_final: bool,
}

impl FinalityCheckpoint {
    /// Create new finality checkpoint
    pub fn new(macroblock_index: u64, macroblock_hash: [u8; 32]) -> Self {
        Self {
            macroblock_index,
            macroblock_hash,
            signatures: HashMap::new(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            is_final: false,
        }
    }
    
    /// Add validator signature
    pub fn add_signature(&mut self, node_id: String, signature: Vec<u8>) {
        if !self.signatures.contains_key(&node_id) {
            self.signatures.insert(node_id, signature);
        }
    }
    
    /// Check if checkpoint has achieved finality
    /// Requires 2/3+1 of total validators
    pub fn is_finalized(&self, total_validators: usize) -> bool {
        if total_validators == 0 {
            return false;
        }
        let required = ((total_validators as f64) * FINALITY_THRESHOLD).ceil() as usize;
        self.signatures.len() >= required
    }
    
    /// Mark as final
    pub fn mark_final(&mut self) {
        self.is_final = true;
    }
    
    /// Get signature count
    pub fn signature_count(&self) -> usize {
        self.signatures.len()
    }
    
    /// Compute checkpoint hash for verification
    pub fn compute_hash(&self) -> [u8; 32] {
        let mut hasher = Sha3_256::new();
        hasher.update(&self.macroblock_index.to_le_bytes());
        hasher.update(&self.macroblock_hash);
        hasher.update(&self.created_at.to_le_bytes());
        
        // Sort signatures for determinism
        let mut sigs: Vec<_> = self.signatures.iter().collect();
        sigs.sort_by(|a, b| a.0.cmp(b.0));
        for (node_id, sig) in sigs {
            hasher.update(node_id.as_bytes());
            hasher.update(sig);
        }
        
        hasher.finalize().into()
    }
}

/// Finality manager - tracks and manages finality checkpoints
#[derive(Debug, Clone, Default)]
pub struct FinalityManager {
    /// Pending checkpoints awaiting signatures
    pending: HashMap<u64, FinalityCheckpoint>,
    
    /// Finalized checkpoints (macroblock_index -> checkpoint)
    finalized: HashMap<u64, FinalityCheckpoint>,
    
    /// Last finalized macroblock index
    last_finalized: u64,
}

impl FinalityManager {
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
            finalized: HashMap::new(),
            last_finalized: 0,
        }
    }
    
    /// Create checkpoint for macroblock
    pub fn create_checkpoint(&mut self, macroblock_index: u64, macroblock_hash: [u8; 32]) {
        if !self.pending.contains_key(&macroblock_index) && !self.finalized.contains_key(&macroblock_index) {
            self.pending.insert(macroblock_index, FinalityCheckpoint::new(macroblock_index, macroblock_hash));
        }
    }
    
    /// Add signature to pending checkpoint
    pub fn add_signature(&mut self, macroblock_index: u64, node_id: String, signature: Vec<u8>) -> bool {
        if let Some(checkpoint) = self.pending.get_mut(&macroblock_index) {
            checkpoint.add_signature(node_id, signature);
            true
        } else {
            false
        }
    }
    
    /// Check and finalize checkpoints that have enough signatures
    pub fn check_finality(&mut self, total_validators: usize) -> Vec<u64> {
        let mut newly_finalized = Vec::new();
        
        let to_finalize: Vec<u64> = self.pending
            .iter()
            .filter(|(_, cp)| cp.is_finalized(total_validators))
            .map(|(idx, _)| *idx)
            .collect();
        
        for idx in to_finalize {
            if let Some(mut checkpoint) = self.pending.remove(&idx) {
                checkpoint.mark_final();
                self.finalized.insert(idx, checkpoint);
                if idx > self.last_finalized {
                    self.last_finalized = idx;
                }
                newly_finalized.push(idx);
            }
        }
        
        newly_finalized
    }
    
    /// Check if a block height is finalized
    /// Block is final if its macroblock (height/90) is finalized + FINALITY_DEPTH
    pub fn is_height_finalized(&self, block_height: u64) -> bool {
        let macroblock_index = block_height / 90;
        
        // Need macroblock + FINALITY_DEPTH to be finalized
        if macroblock_index + FINALITY_DEPTH <= self.last_finalized {
            return true;
        }
        
        false
    }
    
    /// Get last finalized macroblock index
    pub fn last_finalized_index(&self) -> u64 {
        self.last_finalized
    }
    
    /// Get last finalized block height
    pub fn last_finalized_height(&self) -> u64 {
        if self.last_finalized >= FINALITY_DEPTH {
            (self.last_finalized - FINALITY_DEPTH) * 90
        } else {
            0
        }
    }
    
    /// Get finalized checkpoint
    pub fn get_finalized(&self, macroblock_index: u64) -> Option<&FinalityCheckpoint> {
        self.finalized.get(&macroblock_index)
    }
    
    /// Get pending checkpoint
    pub fn get_pending(&self, macroblock_index: u64) -> Option<&FinalityCheckpoint> {
        self.pending.get(&macroblock_index)
    }
    
    /// Cleanup old pending checkpoints (older than 10 macroblocks behind last finalized)
    pub fn cleanup_old(&mut self) {
        if self.last_finalized > 10 {
            let cutoff = self.last_finalized - 10;
            self.pending.retain(|idx, _| *idx >= cutoff);
        }
    }
    
    /// Get statistics
    pub fn stats(&self) -> (usize, usize, u64) {
        (self.pending.len(), self.finalized.len(), self.last_finalized)
    }
}

/// Result type for macro consensus (legacy compatibility)
pub struct MacroConsensusResult {
    /// Commits from validators
    pub commits: HashMap<String, Vec<u8>>,
    /// Reveals from validators
    pub reveals: HashMap<String, Vec<u8>>,
    /// Selected leader for next round
    pub next_leader: String,
}

/// MacroBlock consensus data - stored in blockchain for deterministic reputation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacroBlockConsensusData {
    /// Macroblock index (block_height / 90)
    pub index: u64,
    
    /// Block height range covered by this macroblock
    pub from_height: u64,
    pub to_height: u64,
    
    /// Nodes that submitted valid commit in time
    pub commit_participants: HashSet<String>,
    
    /// Nodes that submitted valid reveal in time
    pub reveal_participants: HashSet<String>,
    
    /// Slashing events with cryptographic proof
    /// SECURITY: Each event contains verifiable evidence
    pub slashing_events: Vec<SlashingEvent>,
    
    /// Automatic jails (computed deterministically from missed blocks)
    pub automatic_jails: Vec<AutomaticJail>,
    
    /// Timestamp when macroblock was finalized
    pub finalized_at: u64,
    
    /// SHA3 hash of all data for integrity verification
    pub data_hash: [u8; 32],
    
    /// Aggregate signature from validators (BLS or multi-sig)
    pub aggregate_signature: Vec<u8>,
}

impl MacroBlockConsensusData {
    /// Create new macroblock consensus data
    pub fn new(index: u64, from_height: u64, to_height: u64) -> Self {
        Self {
            index,
            from_height,
            to_height,
            commit_participants: HashSet::new(),
            reveal_participants: HashSet::new(),
            slashing_events: Vec::new(),
            automatic_jails: Vec::new(),
            finalized_at: 0,
            data_hash: [0u8; 32],
            aggregate_signature: Vec::new(),
        }
    }
    
    /// Add commit participant
    pub fn add_commit(&mut self, node_id: String) {
        self.commit_participants.insert(node_id);
    }
    
    /// Add reveal participant
    pub fn add_reveal(&mut self, node_id: String) {
        self.reveal_participants.insert(node_id);
    }
    
    /// Get nodes that fully participated (commit + reveal)
    pub fn get_full_participants(&self) -> HashSet<String> {
        self.commit_participants
            .intersection(&self.reveal_participants)
            .cloned()
            .collect()
    }
    
    /// Get nodes that committed but didn't reveal (penalty worthy)
    pub fn get_commit_only_participants(&self) -> HashSet<String> {
        self.commit_participants
            .difference(&self.reveal_participants)
            .cloned()
            .collect()
    }
    
    /// Add slashing event with verification
    pub fn add_slashing_event(&mut self, event: SlashingEvent) -> bool {
        // Verify evidence before adding
        if !event.verify_evidence() {
            return false;
        }
        
        // Check for duplicate (same offender, same offense type)
        let is_duplicate = self.slashing_events.iter().any(|e| {
            e.offender == event.offender && e.evidence_hash == event.evidence_hash
        });
        
        if is_duplicate {
            return false;
        }
        
        self.slashing_events.push(event);
        true
    }
    
    /// Add automatic jail (computed from missed blocks)
    pub fn add_automatic_jail(&mut self, jail: AutomaticJail) {
        // Check for duplicate
        let is_duplicate = self.automatic_jails.iter().any(|j| {
            j.node_id == jail.node_id && j.jail_start_height == jail.jail_start_height
        });
        
        if !is_duplicate {
            self.automatic_jails.push(jail);
        }
    }
    
    /// Finalize and compute data hash
    pub fn finalize(&mut self, timestamp: u64) {
        use sha3::{Sha3_256, Digest};
        
        self.finalized_at = timestamp;
        
        let mut hasher = Sha3_256::new();
        
        // Hash all deterministic data
        hasher.update(&self.index.to_le_bytes());
        hasher.update(&self.from_height.to_le_bytes());
        hasher.update(&self.to_height.to_le_bytes());
        
        // Sort participants for determinism
        let mut commits: Vec<_> = self.commit_participants.iter().collect();
        commits.sort();
        for c in commits {
            hasher.update(c.as_bytes());
        }
        
        let mut reveals: Vec<_> = self.reveal_participants.iter().collect();
        reveals.sort();
        for r in reveals {
            hasher.update(r.as_bytes());
        }
        
        // Hash slashing events
        for event in &self.slashing_events {
            hasher.update(&event.evidence_hash);
            hasher.update(event.offender.as_bytes());
            hasher.update(&event.penalty.to_le_bytes());
        }
        
        // Hash automatic jails
        for jail in &self.automatic_jails {
            hasher.update(jail.node_id.as_bytes());
            hasher.update(&jail.jail_start_height.to_le_bytes());
            hasher.update(&jail.jail_duration.to_le_bytes());
        }
        
        hasher.update(&self.finalized_at.to_le_bytes());
        
        let result = hasher.finalize();
        self.data_hash.copy_from_slice(&result);
    }
    
    /// Verify data hash matches content
    pub fn verify_hash(&self) -> bool {
        use sha3::{Sha3_256, Digest};
        
        let mut hasher = Sha3_256::new();
        
        hasher.update(&self.index.to_le_bytes());
        hasher.update(&self.from_height.to_le_bytes());
        hasher.update(&self.to_height.to_le_bytes());
        
        let mut commits: Vec<_> = self.commit_participants.iter().collect();
        commits.sort();
        for c in commits {
            hasher.update(c.as_bytes());
        }
        
        let mut reveals: Vec<_> = self.reveal_participants.iter().collect();
        reveals.sort();
        for r in reveals {
            hasher.update(r.as_bytes());
        }
        
        for event in &self.slashing_events {
            hasher.update(&event.evidence_hash);
            hasher.update(event.offender.as_bytes());
            hasher.update(&event.penalty.to_le_bytes());
        }
        
        for jail in &self.automatic_jails {
            hasher.update(jail.node_id.as_bytes());
            hasher.update(&jail.jail_start_height.to_le_bytes());
            hasher.update(&jail.jail_duration.to_le_bytes());
        }
        
        hasher.update(&self.finalized_at.to_le_bytes());
        
        let result = hasher.finalize();
        let mut computed_hash = [0u8; 32];
        computed_hash.copy_from_slice(&result);
        
        computed_hash == self.data_hash
    }
}

/// Missed block tracker for automatic jail detection
#[derive(Debug, Clone, Default)]
pub struct MissedBlockTracker {
    /// Node -> consecutive missed blocks count
    consecutive_missed: HashMap<String, u64>,
    /// Node -> heights of missed blocks
    missed_heights: HashMap<String, Vec<u64>>,
}

impl MissedBlockTracker {
    pub fn new() -> Self {
        Self::default()
    }
    
    /// Record that expected producer missed their block
    pub fn record_missed_block(&mut self, producer_id: &str, height: u64) {
        let count = self.consecutive_missed.entry(producer_id.to_string()).or_insert(0);
        *count += 1;
        
        self.missed_heights
            .entry(producer_id.to_string())
            .or_insert_with(Vec::new)
            .push(height);
    }
    
    /// Record that producer successfully produced block (reset counter)
    pub fn record_produced_block(&mut self, producer_id: &str) {
        self.consecutive_missed.remove(producer_id);
        self.missed_heights.remove(producer_id);
    }
    
    /// Check if node should be auto-jailed (missed 5+ consecutive blocks)
    pub fn should_auto_jail(&self, producer_id: &str, threshold: u64) -> Option<Vec<u64>> {
        if let Some(&count) = self.consecutive_missed.get(producer_id) {
            if count >= threshold {
                return self.missed_heights.get(producer_id).cloned();
            }
        }
        None
    }
    
    /// Get all nodes that should be jailed
    pub fn get_nodes_to_jail(&self, threshold: u64) -> Vec<(String, Vec<u64>)> {
        self.consecutive_missed
            .iter()
            .filter(|(_, &count)| count >= threshold)
            .filter_map(|(node_id, _)| {
                self.missed_heights.get(node_id).map(|heights| {
                    (node_id.clone(), heights.clone())
                })
            })
            .collect()
    }
    
    /// Clear tracker for a node after jail is applied
    pub fn clear_node(&mut self, node_id: &str) {
        self.consecutive_missed.remove(node_id);
        self.missed_heights.remove(node_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_macroblock_participants() {
        let mut mb = MacroBlockConsensusData::new(1, 1, 90);
        
        mb.add_commit("node_001".to_string());
        mb.add_commit("node_002".to_string());
        mb.add_commit("node_003".to_string());
        
        mb.add_reveal("node_001".to_string());
        mb.add_reveal("node_002".to_string());
        // node_003 didn't reveal
        
        let full = mb.get_full_participants();
        assert!(full.contains("node_001"));
        assert!(full.contains("node_002"));
        assert!(!full.contains("node_003"));
        
        let commit_only = mb.get_commit_only_participants();
        assert!(commit_only.contains("node_003"));
        assert!(!commit_only.contains("node_001"));
    }
    
    #[test]
    fn test_hash_verification() {
        let mut mb = MacroBlockConsensusData::new(1, 1, 90);
        mb.add_commit("node_001".to_string());
        mb.add_reveal("node_001".to_string());
        mb.finalize(12345);
        
        assert!(mb.verify_hash());
        
        // Tamper with data
        mb.commit_participants.insert("fake_node".to_string());
        assert!(!mb.verify_hash());
    }
    
    #[test]
    fn test_missed_block_tracker() {
        let mut tracker = MissedBlockTracker::new();
        
        // Miss 4 blocks
        for h in 1..=4 {
            tracker.record_missed_block("lazy_node", h);
        }
        
        // Should NOT jail yet (threshold = 5)
        assert!(tracker.should_auto_jail("lazy_node", 5).is_none());
        
        // Miss 5th block
        tracker.record_missed_block("lazy_node", 5);
        
        // Should jail now
        let missed = tracker.should_auto_jail("lazy_node", 5);
        assert!(missed.is_some());
        assert_eq!(missed.unwrap(), vec![1, 2, 3, 4, 5]);
    }
    
    #[test]
    fn test_finality_checkpoint() {
        let mut fc = FinalityCheckpoint::new(1, [1u8; 32]);
        
        // Add signatures (need 4 of 5 for BFT)
        fc.add_signature("node_001".to_string(), vec![1, 2, 3]);
        fc.add_signature("node_002".to_string(), vec![4, 5, 6]);
        fc.add_signature("node_003".to_string(), vec![7, 8, 9]);
        
        // Not final yet (3 of 5)
        assert!(!fc.is_finalized(5));
        
        // Add 4th signature
        fc.add_signature("node_004".to_string(), vec![10, 11, 12]);
        
        // Now final (4 of 5 = 80% > 67%)
        assert!(fc.is_finalized(5));
    }
}

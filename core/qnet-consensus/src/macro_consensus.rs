//! Macroblock finality checkpoint types.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use sha3::{Sha3_256, Digest};

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

#[cfg(test)]
mod tests {
    use super::*;

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

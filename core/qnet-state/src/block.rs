//! Block structures

use serde::{Deserialize, Serialize};
use crate::transaction::Transaction;
use sha3::{Sha3_256, Digest};
use crate::{Account, StateError};
use std::collections::HashMap;
use hex;

/// Block hash type
pub type BlockHash = [u8; 32];

/// Block type enum for micro/macro architecture
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum BlockType {
    /// Traditional block (for backward compatibility)
    Standard(Block),
    /// Microblock - created every second (legacy format with full transactions)
    Micro(MicroBlock),
    /// Efficient microblock - optimized storage with transaction hashes only
    EfficientMicro(EfficientMicroBlock),
    /// Macroblock - created every 90 seconds with consensus
    Macro(MacroBlock),
}

/// Microblock structure - fast blocks without consensus
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MicroBlock {
    /// Block height
    pub height: u64,
    /// Timestamp
    pub timestamp: u64,
    /// Transactions in this microblock
    pub transactions: Vec<Transaction>,
    /// Producer node ID
    pub producer: String,
    /// Producer's signature
    pub signature: Vec<u8>,
    /// Hash of previous microblock
    pub previous_hash: [u8; 32],
    /// Merkle root of transactions
    pub merkle_root: [u8; 32],
    /// Proof of History hash at block creation
    pub poh_hash: Vec<u8>,  // SHA3-512 produces 64 bytes
    /// Proof of History counter at block creation
    pub poh_count: u64,
}

/// Macroblock structure - consensus blocks that finalize microblocks
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MacroBlock {
    /// Block height (macroblock number)
    pub height: u64,
    /// Timestamp
    pub timestamp: u64,
    /// Hashes of included microblocks
    pub micro_blocks: Vec<[u8; 32]>,
    /// State root after applying all microblocks
    pub state_root: [u8; 32],
    /// Consensus data (commit-reveal)
    pub consensus_data: ConsensusData,
    /// Previous macroblock hash
    pub previous_hash: [u8; 32],
    /// Proof of History hash at macroblock finalization
    pub poh_hash: Vec<u8>,  // SHA3-512 produces 64 bytes
    /// Proof of History counter at macroblock finalization
    pub poh_count: u64,
}

/// Consensus data for macroblocks
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConsensusData {
    /// Commit phase data
    pub commits: HashMap<String, Vec<u8>>,
    /// Reveal phase data
    pub reveals: HashMap<String, Vec<u8>>,
    /// Selected leader for next round
    pub next_leader: String,
}

/// Efficient microblock structure - stores only transaction hashes instead of full transactions
/// Optimized for distributed storage architecture with separate transaction pool
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EfficientMicroBlock {
    /// Block height
    pub height: u64,
    /// Timestamp
    pub timestamp: u64,
    /// Transaction hashes only - references to full transactions in separate pool
    pub transaction_hashes: Vec<[u8; 32]>,
    /// Producer node ID
    pub producer: String,
    /// Producer's signature
    pub signature: Vec<u8>,
    /// Hash of previous microblock
    pub previous_hash: [u8; 32],
    /// Merkle root of transaction hashes
    pub merkle_root: [u8; 32],
    /// Proof of History hash at block creation (SHA3-512 produces 64 bytes)
    pub poh_hash: Vec<u8>,
    /// Proof of History counter at block creation
    pub poh_count: u64,
}

/// Light microblock header for mobile nodes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LightMicroBlock {
    pub height: u64,
    pub timestamp: u64,
    pub tx_count: u32,
    pub merkle_root: [u8; 32],
    pub size_bytes: u32,
    pub producer: String,
}

// ============================================================================
// VERSIONED STORAGE FORMAT (v2.19.13)
// ============================================================================
// This enum provides explicit versioning for stored blocks, eliminating
// deserialization ambiguity between different block formats.
// 
// Architecture principles:
// 1. First byte indicates version/format
// 2. All formats can be converted to full MicroBlock when needed
// 3. PoH state is stored separately for fast validation
// ============================================================================

/// Storage format version markers
/// Used as first byte to identify stored block format
pub mod storage_version {
    /// Legacy MicroBlock with full transactions (pre-v2.19.8)
    pub const V1_FULL_MICROBLOCK: u8 = 0x01;
    /// EfficientMicroBlock with transaction hashes only (v2.19.8+)
    pub const V2_EFFICIENT_MICROBLOCK: u8 = 0x02;
    /// LightMicroBlock headers only for Light nodes (v2.19.8+)
    pub const V3_LIGHT_MICROBLOCK: u8 = 0x03;
    /// Future: Compressed format with dictionary
    pub const V4_COMPRESSED: u8 = 0x04;
}

/// Versioned stored block - wraps different block formats with explicit version tag
/// This is the PRIMARY format for storing blocks in RocksDB (v2.19.13+)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StoredMicroBlock {
    /// Version 1: Full MicroBlock with all transactions (legacy, for backward compat)
    V1Full(MicroBlock),
    /// Version 2: Efficient format - transaction hashes only, TX stored separately
    V2Efficient(EfficientMicroBlock),
    /// Version 3: Light format - headers only, no transactions or signatures
    V3Light(LightMicroBlock),
}

impl StoredMicroBlock {
    /// Get block height regardless of format
    pub fn height(&self) -> u64 {
        match self {
            StoredMicroBlock::V1Full(b) => b.height,
            StoredMicroBlock::V2Efficient(b) => b.height,
            StoredMicroBlock::V3Light(b) => b.height,
        }
    }
    
    /// Get timestamp regardless of format
    pub fn timestamp(&self) -> u64 {
        match self {
            StoredMicroBlock::V1Full(b) => b.timestamp,
            StoredMicroBlock::V2Efficient(b) => b.timestamp,
            StoredMicroBlock::V3Light(b) => b.timestamp,
        }
    }
    
    /// Get producer regardless of format
    pub fn producer(&self) -> &str {
        match self {
            StoredMicroBlock::V1Full(b) => &b.producer,
            StoredMicroBlock::V2Efficient(b) => &b.producer,
            StoredMicroBlock::V3Light(b) => &b.producer,
        }
    }
    
    /// Get PoH state if available (not available for Light format)
    pub fn poh_state(&self) -> Option<PoHState> {
        match self {
            StoredMicroBlock::V1Full(b) => Some(PoHState {
                height: b.height,
                poh_hash: b.poh_hash.clone(),
                poh_count: b.poh_count,
                previous_hash: b.previous_hash,
            }),
            StoredMicroBlock::V2Efficient(b) => Some(PoHState {
                height: b.height,
                poh_hash: b.poh_hash.clone(),
                poh_count: b.poh_count,
                previous_hash: b.previous_hash,
            }),
            StoredMicroBlock::V3Light(_) => None, // Light nodes don't store PoH
        }
    }
    
    /// Check if this format can provide full transaction data
    pub fn has_full_transactions(&self) -> bool {
        matches!(self, StoredMicroBlock::V1Full(_))
    }
    
    /// Check if this format has transaction hashes
    pub fn has_transaction_hashes(&self) -> bool {
        matches!(self, StoredMicroBlock::V1Full(_) | StoredMicroBlock::V2Efficient(_))
    }
    
    /// Get transaction count
    pub fn tx_count(&self) -> usize {
        match self {
            StoredMicroBlock::V1Full(b) => b.transactions.len(),
            StoredMicroBlock::V2Efficient(b) => b.transaction_hashes.len(),
            StoredMicroBlock::V3Light(b) => b.tx_count as usize,
        }
    }
    
    /// Convert to EfficientMicroBlock (for V1Full, extracts hashes)
    pub fn to_efficient(&self) -> Option<EfficientMicroBlock> {
        match self {
            StoredMicroBlock::V1Full(b) => Some(EfficientMicroBlock::from_microblock(b)),
            StoredMicroBlock::V2Efficient(b) => Some(b.clone()),
            StoredMicroBlock::V3Light(_) => None,
        }
    }
    
    /// Get merkle root
    pub fn merkle_root(&self) -> [u8; 32] {
        match self {
            StoredMicroBlock::V1Full(b) => b.merkle_root,
            StoredMicroBlock::V2Efficient(b) => b.merkle_root,
            StoredMicroBlock::V3Light(b) => b.merkle_root,
        }
    }
    
    /// Get previous hash (not available for Light format)
    pub fn previous_hash(&self) -> Option<[u8; 32]> {
        match self {
            StoredMicroBlock::V1Full(b) => Some(b.previous_hash),
            StoredMicroBlock::V2Efficient(b) => Some(b.previous_hash),
            StoredMicroBlock::V3Light(_) => None,
        }
    }
}

/// PoH (Proof of History) state for a block
/// Stored separately for fast validation without loading full block
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PoHState {
    /// Block height this PoH state belongs to
    pub height: u64,
    /// PoH hash at block creation (SHA3-512, 64 bytes)
    pub poh_hash: Vec<u8>,
    /// PoH counter at block creation
    pub poh_count: u64,
    /// Previous block hash (for chain verification)
    pub previous_hash: [u8; 32],
}

impl PoHState {
    /// Create new PoH state
    pub fn new(height: u64, poh_hash: Vec<u8>, poh_count: u64, previous_hash: [u8; 32]) -> Self {
        Self {
            height,
            poh_hash,
            poh_count,
            previous_hash,
        }
    }
    
    /// Create from MicroBlock
    pub fn from_microblock(block: &MicroBlock) -> Self {
        Self {
            height: block.height,
            poh_hash: block.poh_hash.clone(),
            poh_count: block.poh_count,
            previous_hash: block.previous_hash,
        }
    }
    
    /// Create from EfficientMicroBlock
    pub fn from_efficient(block: &EfficientMicroBlock) -> Self {
        Self {
            height: block.height,
            poh_hash: block.poh_hash.clone(),
            poh_count: block.poh_count,
            previous_hash: block.previous_hash,
        }
    }
    
    /// Validate PoH progression from previous state
    /// Returns Ok(()) if valid, Err with reason if invalid
    pub fn validate_progression(&self, prev: &PoHState) -> Result<(), String> {
        // Height must be exactly one more than previous
        if self.height != prev.height + 1 {
            return Err(format!(
                "Invalid height progression: expected {}, got {}",
                prev.height + 1, self.height
            ));
        }
        
        // PoH count must be greater than previous (monotonic increase)
        // Allow some tolerance for network delays (30 seconds max)
        // 15M hashes at 500K/sec = 30 seconds < 90 sec macroblock interval
        const MAX_ACCEPTABLE_REGRESSION: u64 = 15_000_000; // ~30 seconds at 500K/sec
        
        if self.poh_count <= prev.poh_count {
            let regression = prev.poh_count - self.poh_count;
            if regression > MAX_ACCEPTABLE_REGRESSION {
                return Err(format!(
                    "Severe PoH regression: {} <= {} (diff: {})",
                    self.poh_count, prev.poh_count, regression
                ));
            }
            // Minor regression is acceptable due to network delays
        }
        
        Ok(())
    }
    
    /// Check if PoH data is valid (non-empty)
    pub fn is_valid(&self) -> bool {
        !self.poh_hash.is_empty() && self.poh_count > 0
    }
}

/// Block in the blockchain
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Block {
    /// Block height
    pub height: u64,
    /// Timestamp
    pub timestamp: u64,
    /// Previous block hash
    pub previous_hash: [u8; 32],
    /// Merkle root of transactions
    pub merkle_root: [u8; 32],
    /// Transactions in this block
    pub transactions: Vec<Transaction>,
    /// Block producer
    pub producer: String,
    /// Producer's signature
    pub signature: Vec<u8>,
}

/// Block header (simplified)
pub type BlockHeader = Block;

/// Consensus proof
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsensusProof {
    pub round: u64,
    pub commits: Vec<String>,
    pub reveals: Vec<String>,
}

impl Block {
    /// Calculate block hash
    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = Sha3_256::new();
        hasher.update(&self.height.to_le_bytes());
        hasher.update(&self.timestamp.to_le_bytes());
        hasher.update(&self.previous_hash);
        hasher.update(&self.merkle_root);
        hasher.update(self.producer.as_bytes());
        
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
    
    /// Create new block
    pub fn new(
        height: u64,
        timestamp: u64,
        previous_hash: [u8; 32],
        transactions: Vec<Transaction>,
        producer: String,
    ) -> Self {
        let merkle_root = Self::calculate_merkle_root(&transactions);
        
        Self {
            height,
            timestamp,
            previous_hash,
            merkle_root,
            transactions,
            producer,
            signature: vec![],
        }
    }
    
    /// Calculate merkle root of transactions
    fn calculate_merkle_root(transactions: &[Transaction]) -> [u8; 32] {
        if transactions.is_empty() {
            return [0u8; 32];
        }
        
        let mut hashes: Vec<[u8; 32]> = transactions
            .iter()
            .map(|tx| {
                // Use calculate_hash() which returns a hex string, then convert to bytes
                let hash_str = tx.calculate_hash();
                let hash_bytes = hex::decode(&hash_str).unwrap_or_else(|_| vec![0u8; 32]);
                let mut hash_array = [0u8; 32];
                hash_array.copy_from_slice(&hash_bytes[..32.min(hash_bytes.len())]);
                hash_array
            })
            .collect();
        
        while hashes.len() > 1 {
            let mut next_level = Vec::new();
            
            for chunk in hashes.chunks(2) {
                let mut hasher = Sha3_256::new();
                hasher.update(&chunk[0]);
                if chunk.len() > 1 {
                    hasher.update(&chunk[1]);
                } else {
                    hasher.update(&chunk[0]);
                }
                
                let result = hasher.finalize();
                let mut hash = [0u8; 32];
                hash.copy_from_slice(&result);
                next_level.push(hash);
            }
            
            hashes = next_level;
        }
        
        hashes[0]
    }
    
    /// Validate block structure
    pub fn validate(&self) -> Result<(), StateError> {
        // Check timestamp
        if self.timestamp == 0 {
            return Err(StateError::InvalidBlock("Invalid timestamp".to_string()));
        }
        
        // Check height
        if self.height == 0 && self.previous_hash != [0u8; 32] {
            return Err(StateError::InvalidBlock("Genesis block must have zero previous hash".to_string()));
        }
        
        // Verify merkle root
        let calculated_root = Self::calculate_merkle_root(&self.transactions);
        if calculated_root != self.merkle_root {
            return Err(StateError::InvalidBlock("Invalid merkle root".to_string()));
        }
        
        // Validate all transactions
        for tx in &self.transactions {
            tx.validate()?;
        }
        
        Ok(())
    }
    
    /// Apply block to state
    pub fn apply_to_state(&self, accounts: &mut HashMap<String, Account>) -> Result<(), StateError> {
        for tx in &self.transactions {
            tx.apply_to_state(accounts)?;
        }
        Ok(())
    }
}

// Implement methods for MicroBlock
impl MicroBlock {
    /// Create a new microblock
    pub fn new(
        height: u64,
        timestamp: u64,
        previous_hash: [u8; 32],
        transactions: Vec<Transaction>,
        producer: String,
    ) -> Self {
        let merkle_root = Block::calculate_merkle_root(&transactions);
        
        Self {
            height,
            timestamp,
            transactions,
            producer,
            signature: vec![],
            previous_hash,
            merkle_root,
            // Default PoH values for backward compatibility
            poh_hash: vec![0u8; 64], // SHA3-512 produces 64 bytes
            poh_count: 0,
        }
    }
    
    /// Calculate microblock hash
    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = Sha3_256::new();
        hasher.update(&self.height.to_le_bytes());
        hasher.update(&self.timestamp.to_le_bytes());
        hasher.update(&self.previous_hash);
        hasher.update(&self.merkle_root);
        hasher.update(self.producer.as_bytes());
        
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
    
    /// Convert to light header for mobile nodes
    pub fn to_light_header(&self) -> LightMicroBlock {
        LightMicroBlock {
            height: self.height,
            timestamp: self.timestamp,
            tx_count: self.transactions.len() as u32,
            merkle_root: self.merkle_root,
            size_bytes: self.estimate_size(),
            producer: self.producer.clone(),
        }
    }
    
    /// Estimate size in bytes
    fn estimate_size(&self) -> u32 {
        // Rough estimate: 250 bytes per transaction
        (self.transactions.len() * 250) as u32
    }
    
    /// Validate microblock
    pub fn validate(&self) -> Result<(), StateError> {
        // Check timestamp
        if self.timestamp == 0 {
            return Err(StateError::InvalidBlock("Invalid timestamp".to_string()));
        }
        
        // Check transaction count (max 10,000)
        if self.transactions.len() > 10_000 {
            return Err(StateError::InvalidBlock("Too many transactions in microblock".to_string()));
        }
        
        // Verify merkle root
        let calculated_root = Block::calculate_merkle_root(&self.transactions);
        if calculated_root != self.merkle_root {
            return Err(StateError::InvalidBlock("Invalid merkle root".to_string()));
        }
        
        // Validate all transactions
        for tx in &self.transactions {
            tx.validate()?;
        }
        
        Ok(())
    }
}

// Implement methods for EfficientMicroBlock
impl EfficientMicroBlock {
    /// Create a new efficient microblock from transaction hashes
    pub fn new(
        height: u64,
        timestamp: u64,
        previous_hash: [u8; 32],
        transaction_hashes: Vec<[u8; 32]>,
        producer: String,
    ) -> Self {
        let merkle_root = Self::calculate_merkle_root_from_hashes(&transaction_hashes);
        
        Self {
            height,
            timestamp,
            transaction_hashes,
            producer,
            signature: vec![],
            previous_hash,
            merkle_root,
            poh_hash: vec![],
            poh_count: 0,
        }
    }
    
    /// Create efficient microblock from full microblock (conversion for migration)
    pub fn from_microblock(microblock: &MicroBlock) -> Self {
        let transaction_hashes: Vec<[u8; 32]> = microblock.transactions
            .iter()
            .map(|tx| {
                // Convert string hash to [u8; 32] 
                if let Ok(hash_bytes) = hex::decode(&tx.hash) {
                    if hash_bytes.len() == 32 {
                        let mut hash_array = [0u8; 32];
                        hash_array.copy_from_slice(&hash_bytes);
                        hash_array
                    } else {
                        // If hex decode fails or wrong length, use blake3 hash of the transaction
                        let mut hasher = Sha3_256::new();
                        hasher.update(tx.hash.as_bytes());
                        let result = hasher.finalize();
                        let mut hash_array = [0u8; 32];
                        hash_array.copy_from_slice(&result);
                        hash_array
                    }
                } else {
                    // Fallback: hash the transaction hash string
                    let mut hasher = Sha3_256::new();
                    hasher.update(tx.hash.as_bytes());
                    let result = hasher.finalize();
                    let mut hash_array = [0u8; 32];
                    hash_array.copy_from_slice(&result);
                    hash_array
                }
            })
            .collect();
            
        Self {
            height: microblock.height,
            timestamp: microblock.timestamp,
            transaction_hashes,
            producer: microblock.producer.clone(),
            signature: microblock.signature.clone(),
            previous_hash: microblock.previous_hash,
            merkle_root: microblock.merkle_root,
            poh_hash: microblock.poh_hash.clone(),
            poh_count: microblock.poh_count,
        }
    }
    
    /// Calculate merkle root from transaction hashes
    fn calculate_merkle_root_from_hashes(transaction_hashes: &[[u8; 32]]) -> [u8; 32] {
        if transaction_hashes.is_empty() {
            return [0u8; 32];
        }
        
        let mut hasher = Sha3_256::new();
        for hash in transaction_hashes {
            hasher.update(hash);
        }
        
        let result = hasher.finalize();
        let mut root = [0u8; 32];
        root.copy_from_slice(&result);
        root
    }
    
    /// Calculate efficient microblock hash
    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = Sha3_256::new();
        hasher.update(&self.height.to_le_bytes());
        hasher.update(&self.timestamp.to_le_bytes());
        hasher.update(&self.previous_hash);
        hasher.update(&self.merkle_root);
        hasher.update(self.producer.as_bytes());
        
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
    
    /// Convert to light header for mobile nodes
    pub fn to_light_header(&self) -> LightMicroBlock {
        LightMicroBlock {
            height: self.height,
            timestamp: self.timestamp,
            tx_count: self.transaction_hashes.len() as u32,
            merkle_root: self.merkle_root,
            size_bytes: self.estimate_size(),
            producer: self.producer.clone(),
        }
    }
    
    /// Estimate size in bytes for efficient microblock format
    fn estimate_size(&self) -> u32 {
        // Base size (metadata) + 32 bytes per transaction hash
        let base_size = 8 + 8 + 4 + 32 + 32; // height + timestamp + producer_len + previous_hash + merkle_root
        let hashes_size = self.transaction_hashes.len() * 32;
        (base_size + hashes_size) as u32
    }
    
    /// Validate efficient microblock
    pub fn validate(&self) -> Result<(), StateError> {
        // Check timestamp
        if self.timestamp == 0 {
            return Err(StateError::InvalidBlock("Invalid timestamp".to_string()));
        }
        
        // Check transaction count (same limit as regular microblock)
        if self.transaction_hashes.len() > 10_000 {
            return Err(StateError::InvalidBlock("Too many transactions in microblock".to_string()));
        }
        
        // Verify merkle root
        let calculated_root = Self::calculate_merkle_root_from_hashes(&self.transaction_hashes);
        if calculated_root != self.merkle_root {
            return Err(StateError::InvalidBlock("Invalid merkle root".to_string()));
        }
        
        // Check for duplicate transaction hashes
        use std::collections::HashSet;
        let unique_hashes: HashSet<_> = self.transaction_hashes.iter().collect();
        if unique_hashes.len() != self.transaction_hashes.len() {
            return Err(StateError::InvalidBlock("Duplicate transaction hashes".to_string()));
        }
        
        Ok(())
    }
}

// Implement methods for MacroBlock
impl MacroBlock {
    /// Create a new macroblock
    pub fn new(
        height: u64,
        timestamp: u64,
        previous_hash: [u8; 32],
        micro_blocks: Vec<[u8; 32]>,
        state_root: [u8; 32],
        consensus_data: ConsensusData,
    ) -> Self {
        Self {
            height,
            timestamp,
            micro_blocks,
            state_root,
            consensus_data,
            previous_hash,
            // Default PoH values for backward compatibility
            poh_hash: vec![0u8; 64], // SHA3-512 produces 64 bytes
            poh_count: 0,
        }
    }
    
    /// Calculate macroblock hash
    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = Sha3_256::new();
        hasher.update(&self.height.to_le_bytes());
        hasher.update(&self.timestamp.to_le_bytes());
        hasher.update(&self.previous_hash);
        hasher.update(&self.state_root);
        
        // Include all microblock hashes
        for micro_hash in &self.micro_blocks {
            hasher.update(micro_hash);
        }
        
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
    
    /// Validate macroblock
    pub fn validate(&self) -> Result<(), StateError> {
        // Check timestamp
        if self.timestamp == 0 {
            return Err(StateError::InvalidBlock("Invalid timestamp".to_string()));
        }
        
        // Check microblock count (should be ~90 for 90 seconds)
        if self.micro_blocks.is_empty() || self.micro_blocks.len() > 100 {
            return Err(StateError::InvalidBlock("Invalid microblock count".to_string()));
        }
        
        // Verify consensus data has enough participants
        if self.consensus_data.reveals.len() < 3 {
            return Err(StateError::InvalidBlock("Insufficient consensus participants".to_string()));
        }
        
        Ok(())
    }
}


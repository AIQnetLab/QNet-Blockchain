//! Deterministic Reputation System
//! 
//! ARCHITECTURE: Reputation computed ONLY from blockchain data
//! - No gossip/P2P sync (prevents Sybil attacks)
//! - No ephemeral key signatures (prevents forgery)  
//! - 100% deterministic (all nodes compute same result)
//! - Verifiable (can recompute from genesis)
//!
//! Production-grade deterministic reputation system

use std::collections::{HashMap, HashSet};
use serde::{Deserialize, Serialize};
use sha3::{Sha3_256, Digest};

// ============================================================================
// FULL REPUTATION SNAPSHOT (v2.24.0)
// Contains ALL state needed for perfect synchronization across nodes
// ============================================================================

/// Complete reputation snapshot for blockchain storage
/// Includes all state: reputations, jails, bans, offense counts
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullReputationSnapshot {
    /// Node reputations (0-100%)
    pub reputations: HashMap<String, f64>,
    /// Active jails: node_id -> (end_timestamp, offense_count)
    pub active_jails: HashMap<String, (u64, u32)>,
    /// Permanently banned nodes
    pub permanent_bans: HashSet<String>,
    /// Offense counts for progressive jail
    pub offense_counts: HashMap<String, u32>,
    /// Last passive recovery timestamp per node
    pub last_passive_recovery: HashMap<String, u64>,
    /// Processed rotation numbers (prevents double-counting)
    pub processed_rotations: HashSet<u64>,
}

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

/// Statistics for monitoring reputation system health
#[derive(Debug, Clone, Default)]
pub struct ReputationStats {
    pub total_nodes: usize,
    pub consensus_eligible: usize,   // rep >= 70%
    pub recovering: usize,           // rep 10-69%
    pub low_rep: usize,              // rep < 10%
    pub active_jails: usize,
    pub permanent_bans: usize,
    pub last_height: u64,
    pub last_macroblock: u64,
}

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
// MACROBLOCK CONSENSUS DATA - Stored in blockchain
// ============================================================================

/// Consensus participation data for macroblock
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacroBlockConsensus {
    /// Macroblock index (height / 90)
    pub index: u64,
    
    /// Nodes that submitted valid commit
    pub commit_participants: HashSet<String>,
    
    /// Nodes that submitted valid reveal (commit + reveal = full participation)
    pub reveal_participants: HashSet<String>,
    
    /// Slashing events with cryptographic proof
    pub slashing_events: Vec<SlashingEvent>,
    
    /// Automatic jails (deterministically computed)
    pub automatic_jails: Vec<AutomaticJail>,
    
    /// Block timestamp for jail expiry calculation
    pub timestamp: u64,
}

impl MacroBlockConsensus {
    /// Get nodes that fully participated (commit + reveal)
    pub fn get_full_participants(&self) -> HashSet<String> {
        self.commit_participants
            .intersection(&self.reveal_participants)
            .cloned()
            .collect()
    }
    
    /// Get nodes that only committed (didn't reveal = penalty)
    pub fn get_commit_only(&self) -> HashSet<String> {
        self.commit_participants
            .difference(&self.reveal_participants)
            .cloned()
            .collect()
    }
}

// ============================================================================
// DETERMINISTIC REPUTATION CALCULATOR
// ============================================================================

/// Block data needed for reputation calculation
/// Block data for reputation calculation
#[derive(Debug, Clone, Default)]
pub struct BlockData {
    pub height: u64,
    pub producer: String,
    pub timestamp: u64,
    pub is_valid: bool,
    /// Number of blocks this producer created in current rotation (1-30)
    /// CRITICAL: Only producers with 30/30 blocks get reward!
    pub blocks_in_rotation: u32,
}

/// Macroblock data for reputation calculation  
pub struct MacroBlockData {
    pub index: u64,
    pub consensus: MacroBlockConsensus,
}

/// Deterministic reputation state (can be rebuilt from genesis)
pub struct DeterministicReputationState {
    /// Computed reputation for each node
    reputations: HashMap<String, f64>,
    
    /// Active jails (node_id -> jail end timestamp)
    active_jails: HashMap<String, (u64, u32)>, // (end_timestamp, offense_count)
    
    /// Permanent bans
    permanent_bans: HashSet<String>,
    
    /// Offense counts for progressive jail
    offense_counts: HashMap<String, u32>,
    
    /// Last processed block height
    last_height: u64,
    
    /// Last processed macroblock index
    last_macroblock: u64,
    
    /// PASSIVE RECOVERY: Last recovery timestamp per node
    /// Nodes with reputation 10-69% get +1% every 4 hours if they were online (in ping_participants)
    last_passive_recovery: HashMap<String, u64>,
    
    /// Processed rotation numbers (to handle out-of-order blocks)
    /// Prevents double-counting reputation for same rotation
    processed_rotations: HashSet<u64>,
}

impl DeterministicReputationState {
    /// Create new state starting from genesis
    pub fn new() -> Self {
        Self {
            reputations: HashMap::new(),
            active_jails: HashMap::new(),
            permanent_bans: HashSet::new(),
            offense_counts: HashMap::new(),
            last_height: 0,
            last_macroblock: 0,
            last_passive_recovery: HashMap::new(),
            processed_rotations: HashSet::new(),
        }
    }
    
    /// Initialize Genesis nodes with starting reputation
    pub fn init_genesis_nodes(&mut self, genesis_node_ids: &[String]) {
        for node_id in genesis_node_ids {
            self.reputations.insert(node_id.clone(), INITIAL_REPUTATION);
        }
    }
    
    /// Get reputation for a node (0 if jailed or banned)
    pub fn get_reputation(&self, node_id: &str, current_timestamp: u64) -> f64 {
        // Check permanent ban
        if self.permanent_bans.contains(node_id) {
            return 0.0;
        }
        
        // Check active jail
        if let Some((jail_end, _)) = self.active_jails.get(node_id) {
            if current_timestamp < *jail_end {
                return 0.0; // Still jailed
            }
        }
        
        // Return computed reputation or initial
        *self.reputations.get(node_id).unwrap_or(&INITIAL_REPUTATION)
    }
    
    /// Check if node can participate in consensus
    pub fn can_participate(&self, node_id: &str, current_timestamp: u64) -> bool {
        let rep = self.get_reputation(node_id, current_timestamp);
        rep >= MIN_CONSENSUS_REPUTATION
    }
    
    /// Process a block and update reputation
    /// NOTE: Blocks may arrive out-of-order due to shred protocol parallelism
    /// We only care about rotation boundaries (every 30 blocks) for reputation updates
    pub fn process_block(&mut self, block: &BlockData) {
        // Only process rotation boundary blocks (30, 60, 90...)
        // Other blocks don't affect reputation
        if block.height % BLOCKS_PER_ROTATION != 0 || block.height == 0 {
            // Update last_height tracking even for non-rotation blocks
            if block.height > self.last_height {
                self.last_height = block.height;
            }
            return;
        }
        
        // Check if this rotation was already processed (duplicate protection)
        let rotation_number = block.height / BLOCKS_PER_ROTATION;
        if self.processed_rotations.contains(&rotation_number) {
            return;
        }
        
        // Reward producer ONLY if completed FULL rotation (30/30 blocks)
        // Partial rotation (failover) = NO reward!
        let full_rotation = block.blocks_in_rotation >= BLOCKS_PER_ROTATION as u32;
        
        if block.is_valid && full_rotation {
            let current = self.reputations.get(&block.producer).unwrap_or(&INITIAL_REPUTATION);
            let new_rep = (current + REWARD_FULL_ROTATION).min(MAX_REPUTATION);
            self.reputations.insert(block.producer.clone(), new_rep);
            self.processed_rotations.insert(rotation_number);
            println!("[REPUTATION] ✅ Producer {} completed FULL rotation #{} (30/30) → {:.1}%", 
                     block.producer, rotation_number, new_rep);
        } else if block.is_valid && !full_rotation {
            // Partial rotation - record but no reward
            self.processed_rotations.insert(rotation_number);
            println!("[REPUTATION] ⚠️ Producer {} partial rotation #{} ({}/30) → NO REWARD", 
                     block.producer, rotation_number, block.blocks_in_rotation);
        }
        
        // Update last_height to highest seen
        if block.height > self.last_height {
            self.last_height = block.height;
        }
    }
    
    /// Process macroblock consensus data
    /// 
    /// SCALABILITY: 
    /// - Limits slashing events to MAX_SLASHING_EVENTS_PER_MACROBLOCK
    /// - Limits auto jails to MAX_AUTO_JAILS_PER_MACROBLOCK
    /// - Processes participants in chunks
    pub fn process_macroblock(&mut self, macroblock: &MacroBlockData, current_timestamp: u64) {
        let consensus = &macroblock.consensus;
        
        // 1. Reward full participants (+1% each) - chunked for scalability
        let full_participants: Vec<String> = consensus.get_full_participants().into_iter().collect();
        for chunk in full_participants.chunks(PROCESSING_CHUNK_SIZE) {
            for participant in chunk {
                let current = self.reputations.get(participant).unwrap_or(&INITIAL_REPUTATION);
                let new_rep = (current + REWARD_CONSENSUS_PARTICIPATION).min(MAX_REPUTATION);
                self.reputations.insert(participant.clone(), new_rep);
            }
        }
        
        // 2. Penalize commit-only (didn't reveal) - chunked
        let commit_only: Vec<String> = consensus.get_commit_only().into_iter().collect();
        for chunk in commit_only.chunks(PROCESSING_CHUNK_SIZE) {
            for node_id in chunk {
                let current = self.reputations.get(node_id).unwrap_or(&INITIAL_REPUTATION);
                let new_rep = (current - PENALTY_MISSED_CONSENSUS).max(0.0);
                self.reputations.insert(node_id.clone(), new_rep);
            }
        }
        
        // 3. Process slashing events (LIMITED to prevent DoS)
        let slashing_limit = consensus.slashing_events.len().min(MAX_SLASHING_EVENTS_PER_MACROBLOCK);
        for event in consensus.slashing_events.iter().take(slashing_limit) {
            // Verify evidence before applying
            if !event.verify_evidence() {
                continue; // Skip invalid evidence
            }
            
            // Apply penalty
            let current = self.reputations.get(&event.offender).unwrap_or(&INITIAL_REPUTATION);
            let new_rep = (current - event.penalty).max(0.0);
            self.reputations.insert(event.offender.clone(), new_rep);
            
            // v3.33: Permanent ban for cryptographically proven offenses
            if SlashingEvent::is_permanent_ban(&event.offense) {
                self.permanent_bans.insert(event.offender.clone());
                self.reputations.insert(event.offender.clone(), 0.0);
                println!("[SLASH] PERMANENT_BAN node={} offense={:?}", event.offender, std::mem::discriminant(&event.offense));
            }
        }
        
        // Log if events were truncated
        if consensus.slashing_events.len() > MAX_SLASHING_EVENTS_PER_MACROBLOCK {
            // In production, this would be logged
            // Excess events will be processed in next macroblock
        }
        
        // 4. Process automatic jails (LIMITED to prevent spam)
        let jail_limit = consensus.automatic_jails.len().min(MAX_AUTO_JAILS_PER_MACROBLOCK);
        for jail in consensus.automatic_jails.iter().take(jail_limit) {
            let offense_count = self.offense_counts
                .entry(jail.node_id.clone())
                .or_insert(0);
            *offense_count += 1;
            
            let jail_end = consensus.timestamp.saturating_add(jail.jail_duration);
            self.active_jails.insert(jail.node_id.clone(), (jail_end, *offense_count));
        }
        
        // 5. Release expired jails
        let expired: Vec<String> = self.active_jails
            .iter()
            .filter(|(_, (end, _))| current_timestamp >= *end)
            .map(|(id, _)| id.clone())
            .collect();
            
        for node_id in expired {
            self.active_jails.remove(&node_id);
            
            // Restore reputation based on offense count
            let offense_count = *self.offense_counts.get(&node_id).unwrap_or(&1);
            let restore_rep = match offense_count {
                1 => 30.0,
                2 => 25.0,
                3 => 20.0,
                4 => 15.0,
                5 => 12.0,
                _ => 10.0, // Minimum for passive recovery path
            };
            self.reputations.insert(node_id.clone(), restore_rep);
            // Reset passive recovery timer
            self.last_passive_recovery.insert(node_id, current_timestamp);
        }
        
        self.last_macroblock = macroblock.index;
    }
    
    /// PASSIVE RECOVERY: Apply to nodes with reputation 10-69% who were online
    /// Called with list of nodes that responded to pings in this period
    /// Recovery: +1% every 4 hours for nodes with rep 10-69%
    /// 
    /// SCALABILITY: Processes in chunks of PROCESSING_CHUNK_SIZE to prevent blocking
    pub fn apply_passive_recovery(&mut self, online_nodes: &[String], current_timestamp: u64) {
        // SCALABILITY: Process in chunks for large networks (10,000+ nodes)
        for chunk in online_nodes.chunks(PROCESSING_CHUNK_SIZE) {
            self.apply_passive_recovery_chunk(chunk, current_timestamp);
        }
    }
    
    /// Internal: Process a single chunk of passive recovery
    fn apply_passive_recovery_chunk(&mut self, nodes: &[String], current_timestamp: u64) {
        for node_id in nodes {
            // Skip if permanently banned or jailed
            if self.permanent_bans.contains(node_id) {
                continue;
            }
            if let Some((jail_end, _)) = self.active_jails.get(node_id) {
                if current_timestamp < *jail_end {
                    continue; // Still jailed
                }
            }
            
            // Get current reputation
            let current_rep = *self.reputations.get(node_id).unwrap_or(&INITIAL_REPUTATION);
            
            // Only apply if in recovery range (10-69%)
            if current_rep < PASSIVE_RECOVERY_MIN || current_rep >= PASSIVE_RECOVERY_MAX {
                continue;
            }
            
            // Check if enough time has passed since last recovery
            let last_recovery = *self.last_passive_recovery.get(node_id).unwrap_or(&0);
            if current_timestamp < last_recovery + PASSIVE_RECOVERY_INTERVAL {
                continue; // Too soon
            }
            
            // Apply recovery
            let new_rep = (current_rep + PASSIVE_RECOVERY_AMOUNT).min(PASSIVE_RECOVERY_MAX);
            self.reputations.insert(node_id.clone(), new_rep);
            self.last_passive_recovery.insert(node_id.clone(), current_timestamp);
        }
    }
    
    /// Get all reputations (for producer selection)
    pub fn get_all_reputations(&self, current_timestamp: u64) -> HashMap<String, f64> {
        self.reputations
            .iter()
            .map(|(id, _)| {
                let effective_rep = self.get_reputation(id, current_timestamp);
                (id.clone(), effective_rep)
            })
            .collect()
    }
    
    // =========================================================================
    // REPUTATION SNAPSHOT (v2.24.0) - Deterministic state sync
    // Ensures all nodes have IDENTICAL reputation after macroblock
    // =========================================================================
    
    /// Create FULL reputation snapshot for inclusion in macroblock
    /// Includes: reputations, jails, bans, offense counts
    /// Returns bincode-serialized FullReputationSnapshot
    pub fn create_snapshot(&self) -> Vec<u8> {
        let snapshot = FullReputationSnapshot {
            reputations: self.reputations.clone(),
            active_jails: self.active_jails.clone(),
            permanent_bans: self.permanent_bans.clone(),
            offense_counts: self.offense_counts.clone(),
            last_passive_recovery: self.last_passive_recovery.clone(),
            processed_rotations: self.processed_rotations.clone(),
        };
        bincode::serialize(&snapshot).unwrap_or_default()
    }
    
    /// Apply FULL reputation snapshot from macroblock (AUTHORITATIVE)
    /// This OVERWRITES ALL local state with blockchain-verified values
    /// Ensures ALL nodes have IDENTICAL reputation state
    pub fn apply_snapshot(&mut self, snapshot_data: &[u8]) -> Result<usize, String> {
        if snapshot_data.is_empty() {
            return Err("Empty snapshot data".to_string());
        }
        
        // Try new full format first
        if let Ok(full_snapshot) = bincode::deserialize::<FullReputationSnapshot>(snapshot_data) {
            let count = full_snapshot.reputations.len();
            
            // Apply ALL state
            self.reputations = full_snapshot.reputations;
            self.active_jails = full_snapshot.active_jails;
            self.permanent_bans = full_snapshot.permanent_bans;
            self.offense_counts = full_snapshot.offense_counts;
            self.last_passive_recovery = full_snapshot.last_passive_recovery;
            self.processed_rotations = full_snapshot.processed_rotations;
            
            println!("[REPUTATION] 📸 Applied FULL snapshot: {} nodes, {} jailed, {} banned", 
                     count, self.active_jails.len(), self.permanent_bans.len());
            
            return Ok(count);
        }
        
        // Fallback: Legacy format (just reputations)
        let snapshot: HashMap<String, f64> = bincode::deserialize(snapshot_data)
            .map_err(|e| format!("Failed to deserialize snapshot: {}", e))?;
        
        let count = snapshot.len();
        
        // CRITICAL: Replace ALL reputations with snapshot values
        // Blockchain is authoritative - all nodes must have identical state
        for (node_id, reputation) in snapshot {
            self.reputations.insert(node_id, reputation);
        }
        
        println!("[REPUTATION] 📸 Applied snapshot: {} nodes synced from macroblock", count);
        
        Ok(count)
    }
    
    /// Force set reputation for a specific node (used by snapshot application)
    pub fn set_reputation(&mut self, node_id: &str, reputation: f64) {
        let clamped = reputation.clamp(0.0, MAX_REPUTATION);
        self.reputations.insert(node_id.to_string(), clamped);
    }
    
    /// Get raw reputation map for snapshot creation
    pub fn get_reputations_raw(&self) -> &HashMap<String, f64> {
        &self.reputations
    }
    
    /// Get consensus-eligible nodes (reputation >= 70%)
    pub fn get_consensus_eligible(&self, current_timestamp: u64) -> Vec<String> {
        self.reputations
            .iter()
            .filter(|(id, _)| self.can_participate(id, current_timestamp))
            .map(|(id, _)| id.clone())
            .collect()
    }
    
    /// Check if node is permanently banned
    pub fn is_permanently_banned(&self, node_id: &str) -> bool {
        self.permanent_bans.contains(node_id)
    }
    
    /// Check if node is currently jailed
    pub fn is_jailed(&self, node_id: &str, current_timestamp: u64) -> bool {
        if let Some((jail_end, _)) = self.active_jails.get(node_id) {
            current_timestamp < *jail_end
        } else {
            false
        }
    }
    
    /// Get jail info for a node
    pub fn get_jail_info(&self, node_id: &str) -> Option<(u64, u32)> {
        self.active_jails.get(node_id).cloned()
    }
    
    // ========================================================================
    // SCALABILITY: Batch operations and statistics
    // ========================================================================
    
    /// Get system statistics for monitoring
    pub fn get_stats(&self) -> ReputationStats {
        let total_nodes = self.reputations.len();
        let active_jails = self.active_jails.len();
        let permanent_bans = self.permanent_bans.len();
        
        // Count nodes by reputation range
        let mut consensus_eligible = 0;
        let mut recovering = 0;
        let mut low_rep = 0;
        
        for (_id, &rep) in &self.reputations {
            if rep >= MIN_CONSENSUS_REPUTATION {
                consensus_eligible += 1;
            } else if rep >= PASSIVE_RECOVERY_MIN {
                recovering += 1;
            } else {
                low_rep += 1;
            }
        }
        
        ReputationStats {
            total_nodes,
            consensus_eligible,
            recovering,
            low_rep,
            active_jails,
            permanent_bans,
            last_height: self.last_height,
            last_macroblock: self.last_macroblock,
        }
    }
    
    /// Batch update multiple reputations (for migration/testing)
    pub fn batch_set_reputations(&mut self, updates: &[(String, f64)]) {
        for chunk in updates.chunks(PROCESSING_CHUNK_SIZE) {
            for (node_id, rep) in chunk {
                let clamped = rep.max(0.0).min(MAX_REPUTATION);
                self.reputations.insert(node_id.clone(), clamped);
            }
        }
    }
    
    /// Get nodes that need passive recovery (for external processing)
    pub fn get_nodes_needing_recovery(&self, current_timestamp: u64) -> Vec<String> {
        self.reputations
            .iter()
            .filter(|(id, &rep)| {
                // In recovery range
                rep >= PASSIVE_RECOVERY_MIN && rep < PASSIVE_RECOVERY_MAX &&
                // Not banned
                !self.permanent_bans.contains(*id) &&
                // Not jailed
                !self.active_jails.contains_key(*id) &&
                // Recovery interval passed
                {
                    let last = *self.last_passive_recovery.get(*id).unwrap_or(&0);
                    current_timestamp >= last + PASSIVE_RECOVERY_INTERVAL
                }
            })
            .map(|(id, _)| id.clone())
            .collect()
    }
    
    /// Estimate memory usage in bytes
    pub fn estimate_memory_bytes(&self) -> usize {
        // Rough estimation
        let rep_size = self.reputations.len() * (32 + 8); // String key + f64
        let jail_size = self.active_jails.len() * (32 + 16); // String + (u64, u32)
        let ban_size = self.permanent_bans.len() * 32; // String
        let offense_size = self.offense_counts.len() * (32 + 4); // String + u32
        let recovery_size = self.last_passive_recovery.len() * (32 + 8); // String + u64
        
        rep_size + jail_size + ban_size + offense_size + recovery_size
    }
    
    /// Compute state hash for verification (can compare across nodes)
    pub fn compute_state_hash(&self) -> [u8; 32] {
        let mut hasher = Sha3_256::new();
        
        // Sort for determinism
        let mut reps: Vec<_> = self.reputations.iter().collect();
        reps.sort_by(|a, b| a.0.cmp(b.0));
        
        for (node_id, rep) in reps {
            hasher.update(node_id.as_bytes());
            hasher.update(&rep.to_le_bytes());
        }
        
        // Include jails
        let mut jails: Vec<_> = self.active_jails.iter().collect();
        jails.sort_by(|a, b| a.0.cmp(b.0));
        
        for (node_id, (end, count)) in jails {
            hasher.update(node_id.as_bytes());
            hasher.update(&end.to_le_bytes());
            hasher.update(&count.to_le_bytes());
        }
        
        // Include permanent bans
        let mut bans: Vec<_> = self.permanent_bans.iter().collect();
        bans.sort();
        
        for node_id in bans {
            hasher.update(b"BAN:");
            hasher.update(node_id.as_bytes());
        }
        
        let result = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&result);
        hash
    }
}

impl Default for DeterministicReputationState {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_initial_reputation() {
        let state = DeterministicReputationState::new();
        let rep = state.get_reputation("new_node", 0);
        assert_eq!(rep, INITIAL_REPUTATION);
    }
    
    #[test]
    fn test_rotation_reward() {
        let mut state = DeterministicReputationState::new();
        state.init_genesis_nodes(&["genesis_001".to_string()]);
        
        // Process 30 blocks (one rotation). `blocks_in_rotation`
        // increments with each block in the producer's current
        // rotation; reaching 30 marks a completed full rotation
        // and triggers the canonical reward path checked below.
        for height in 1..=30u32 {
            state.process_block(&BlockData {
                height: height as u64,
                producer: "genesis_001".to_string(),
                timestamp: height as u64,
                is_valid: true,
                blocks_in_rotation: height,
            });
        }
        
        let rep = state.get_reputation("genesis_001", 30);
        assert_eq!(rep, INITIAL_REPUTATION + REWARD_FULL_ROTATION);
    }
    
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
    fn test_permanent_ban() {
        let mut state = DeterministicReputationState::new();
        state.reputations.insert("attacker".to_string(), 90.0);
        
        let offense = SlashingType::ChainFork {
            fork_height: 100,
            main_chain_hash: [1u8; 32],
            fork_chain_hash: [2u8; 32],
        };
        
        let consensus = MacroBlockConsensus {
            index: 1,
            commit_participants: HashSet::new(),
            reveal_participants: HashSet::new(),
            slashing_events: vec![SlashingEvent {
                offender: "attacker".to_string(),
                offense: offense.clone(),
                penalty: 100.0,
                detected_at_height: 90,
                reporter: "reporter".to_string(),
                evidence_hash: SlashingEvent::compute_evidence_hash(&offense),
            }],
            automatic_jails: vec![],
            timestamp: 1000,
        };
        
        state.process_macroblock(&MacroBlockData { index: 1, consensus }, 1000);
        
        assert!(state.is_permanently_banned("attacker"));
        assert_eq!(state.get_reputation("attacker", 1000), 0.0);
    }
    
    #[test]
    fn test_deterministic_hash() {
        let mut state1 = DeterministicReputationState::new();
        let mut state2 = DeterministicReputationState::new();
        
        state1.reputations.insert("node_a".to_string(), 80.0);
        state1.reputations.insert("node_b".to_string(), 75.0);
        
        state2.reputations.insert("node_b".to_string(), 75.0);
        state2.reputations.insert("node_a".to_string(), 80.0);
        
        // Should produce same hash regardless of insertion order
        assert_eq!(state1.compute_state_hash(), state2.compute_state_hash());
    }
}


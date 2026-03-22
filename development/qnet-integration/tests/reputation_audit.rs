//! REPUTATION SYSTEM AUDIT TESTS
//! 
//! Standalone tests for DeterministicReputationState
//! Run: cargo test --test reputation_audit

use std::collections::{HashMap, HashSet};

// ============================================================================
// LOCAL MOCK TYPES (to avoid linking issues)
// ============================================================================

/// Slashing type
#[derive(Debug, Clone)]
pub enum SlashingType {
    DoubleSign { height: u64, hash_a: [u8; 32], hash_b: [u8; 32] },
    InvalidBlock { height: u64, block_hash: [u8; 32], reason: String },
    ChainFork { fork_height: u64 },
    ConsecutiveMissedBlocks { missed_heights: Vec<u64> },
}

/// Slashing event
#[derive(Debug, Clone)]
pub struct SlashingEvent {
    pub offender: String,
    pub offense: SlashingType,
    pub penalty: f64,
    pub detected_at_height: u64,
    pub reporter: String,
    pub evidence_hash: [u8; 32],
}

impl SlashingEvent {
    pub fn calculate_penalty(offense: &SlashingType) -> f64 {
        match offense {
            SlashingType::DoubleSign { .. } => 100.0, // Permanent ban
            SlashingType::InvalidBlock { .. } => 20.0,
            SlashingType::ChainFork { .. } => 100.0, // Permanent ban
            SlashingType::ConsecutiveMissedBlocks { missed_heights } => {
                (missed_heights.len() as f64) * 5.0
            }
        }
    }
    
    pub fn is_permanent_ban(offense: &SlashingType) -> bool {
        matches!(offense, SlashingType::DoubleSign { .. } | SlashingType::ChainFork { .. })
    }
    
    pub fn verify_evidence(&self) -> bool {
        // In production: verify cryptographic proof
        self.evidence_hash != [0u8; 32]
    }
}

/// Automatic jail
#[derive(Debug, Clone)]
pub struct AutomaticJail {
    pub node_id: String,
    pub offense_count: u32,
    pub jail_start_height: u64,
    pub jail_duration: u64,
    pub reason: String,
    pub evidence_hash: [u8; 32],
}

/// Macroblock consensus data
#[derive(Debug, Clone)]
pub struct MacroBlockConsensus {
    pub index: u64,
    pub commit_participants: HashSet<String>,
    pub reveal_participants: HashSet<String>,
    pub slashing_events: Vec<SlashingEvent>,
    pub automatic_jails: Vec<AutomaticJail>,
    pub timestamp: u64,
}

impl MacroBlockConsensus {
    pub fn get_full_participants(&self) -> HashSet<String> {
        self.commit_participants
            .intersection(&self.reveal_participants)
            .cloned()
            .collect()
    }
    
    pub fn get_commit_only(&self) -> HashSet<String> {
        self.commit_participants
            .difference(&self.reveal_participants)
            .cloned()
            .collect()
    }
}

/// Block data
#[derive(Debug, Clone)]
pub struct BlockData {
    pub height: u64,
    pub producer: String,
    pub timestamp: u64,
    pub is_valid: bool,
}

/// Macroblock data
#[derive(Debug, Clone)]
pub struct MacroBlockData {
    pub index: u64,
    pub consensus: MacroBlockConsensus,
}

// ============================================================================
// CONSTANTS (same as production)
// ============================================================================

const INITIAL_REPUTATION: f64 = 0.70;        // 70%
const MIN_CONSENSUS_REPUTATION: f64 = 0.70;  // 70%
const MAX_REPUTATION: f64 = 1.0;             // 100%
const REWARD_FULL_ROTATION: f64 = 0.02;      // +2%
const REWARD_CONSENSUS_PARTICIPATION: f64 = 0.01; // +1%
const PENALTY_MISSED_CONSENSUS: f64 = 0.01;  // -1%
const BLOCKS_PER_ROTATION: u64 = 30;

// ============================================================================
// DETERMINISTIC REPUTATION STATE (copy of production logic)
// ============================================================================

pub struct DeterministicReputationState {
    reputations: HashMap<String, f64>,
    active_jails: HashMap<String, (u64, u32)>, // (end_timestamp, offense_count)
    permanent_bans: HashSet<String>,
    offense_counts: HashMap<String, u32>,
    last_height: u64,
    last_macroblock: u64,
}

impl DeterministicReputationState {
    pub fn new() -> Self {
        Self {
            reputations: HashMap::new(),
            active_jails: HashMap::new(),
            permanent_bans: HashSet::new(),
            offense_counts: HashMap::new(),
            last_height: 0,
            last_macroblock: 0,
        }
    }
    
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
    
    pub fn can_participate(&self, node_id: &str, current_timestamp: u64) -> bool {
        let rep = self.get_reputation(node_id, current_timestamp);
        rep >= MIN_CONSENSUS_REPUTATION
    }
    
    pub fn process_block(&mut self, block: &BlockData) {
        // Ensure in order
        if block.height != self.last_height + 1 && self.last_height > 0 {
            return; // Skip out-of-order blocks
        }
        
        // Reward producer on rotation boundary
        if block.is_valid && block.height % BLOCKS_PER_ROTATION == 0 && block.height > 0 {
            let current = self.reputations.get(&block.producer).unwrap_or(&INITIAL_REPUTATION);
            let new_rep = (current + REWARD_FULL_ROTATION).min(MAX_REPUTATION);
            self.reputations.insert(block.producer.clone(), new_rep);
        }
        
        self.last_height = block.height;
    }
    
    pub fn process_macroblock(&mut self, macroblock: &MacroBlockData, current_timestamp: u64) {
        let consensus = &macroblock.consensus;
        
        // 1. Reward full participants (+1% each)
        for participant in consensus.get_full_participants() {
            let current = self.reputations.get(&participant).unwrap_or(&INITIAL_REPUTATION);
            let new_rep = (current + REWARD_CONSENSUS_PARTICIPATION).min(MAX_REPUTATION);
            self.reputations.insert(participant, new_rep);
        }
        
        // 2. Penalize commit-only (didn't reveal) - small penalty
        for node_id in consensus.get_commit_only() {
            let current = self.reputations.get(&node_id).unwrap_or(&INITIAL_REPUTATION);
            let new_rep = (current - PENALTY_MISSED_CONSENSUS).max(0.0);
            self.reputations.insert(node_id, new_rep);
        }
        
        // 3. Process slashing events
        for event in &consensus.slashing_events {
            if !event.verify_evidence() {
                continue;
            }
            
            let current = self.reputations.get(&event.offender).unwrap_or(&INITIAL_REPUTATION);
            let new_rep = (current - event.penalty).max(0.0);
            self.reputations.insert(event.offender.clone(), new_rep);
            
            if SlashingEvent::is_permanent_ban(&event.offense) {
                self.permanent_bans.insert(event.offender.clone());
            }
        }
        
        // 4. Process automatic jails
        for jail in &consensus.automatic_jails {
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
        
        for id in expired {
            self.active_jails.remove(&id);
        }
        
        self.last_macroblock = macroblock.index;
    }
    
    pub fn get_all_reputations(&self) -> &HashMap<String, f64> {
        &self.reputations
    }
    
    pub fn get_active_jails(&self) -> &HashMap<String, (u64, u32)> {
        &self.active_jails
    }
    
    pub fn get_permanent_bans(&self) -> &HashSet<String> {
        &self.permanent_bans
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[test]
fn test_initial_reputation() {
    let state = DeterministicReputationState::new();
    let ts = 1000000;
    
    // New node should have 70% reputation
    assert_eq!(state.get_reputation("new_node", ts), INITIAL_REPUTATION);
    assert!(state.can_participate("new_node", ts));
    
    println!("✅ Initial reputation = 70% (PASS)");
}

#[test]
fn test_block_production_reward() {
    let mut state = DeterministicReputationState::new();
    let ts = 1000000;
    
    // Process 30 blocks (one rotation)
    for i in 1..=30 {
        state.process_block(&BlockData {
            height: i,
            producer: "producer_001".to_string(),
            timestamp: ts + i,
            is_valid: true,
        });
    }
    
    // After rotation: 70% + 2% = 72%
    let rep = state.get_reputation("producer_001", ts);
    assert!((rep - 0.72).abs() < 0.001, "Expected 72%, got {:.2}%", rep * 100.0);
    
    println!("✅ Block production reward = +2% per rotation (PASS)");
    println!("   Reputation after 30 blocks: {:.2}%", rep * 100.0);
}

#[test]
fn test_consensus_participation_reward() {
    let mut state = DeterministicReputationState::new();
    let ts = 1000000;
    
    let mut commit = HashSet::new();
    let mut reveal = HashSet::new();
    
    commit.insert("node_001".to_string());
    commit.insert("node_002".to_string());
    reveal.insert("node_001".to_string());
    reveal.insert("node_002".to_string());
    
    let macroblock = MacroBlockData {
        index: 1,
        consensus: MacroBlockConsensus {
            index: 1,
            commit_participants: commit,
            reveal_participants: reveal,
            slashing_events: Vec::new(),
            automatic_jails: Vec::new(),
            timestamp: ts,
        },
    };
    
    state.process_macroblock(&macroblock, ts);
    
    // Full participation: 70% + 1% = 71%
    let rep = state.get_reputation("node_001", ts);
    assert!((rep - 0.71).abs() < 0.001, "Expected 71%, got {:.2}%", rep * 100.0);
    
    println!("✅ Consensus participation reward = +1% (PASS)");
    println!("   Reputation after participation: {:.2}%", rep * 100.0);
}

#[test]
fn test_commit_without_reveal_penalty() {
    let mut state = DeterministicReputationState::new();
    let ts = 1000000;
    
    let mut commit = HashSet::new();
    let reveal = HashSet::new(); // Empty - no one revealed
    
    commit.insert("lazy_node".to_string());
    
    let macroblock = MacroBlockData {
        index: 1,
        consensus: MacroBlockConsensus {
            index: 1,
            commit_participants: commit,
            reveal_participants: reveal,
            slashing_events: Vec::new(),
            automatic_jails: Vec::new(),
            timestamp: ts,
        },
    };
    
    state.process_macroblock(&macroblock, ts);
    
    // Commit without reveal: 70% - 1% = 69%
    let rep = state.get_reputation("lazy_node", ts);
    assert!((rep - 0.69).abs() < 0.001, "Expected 69%, got {:.2}%", rep * 100.0);
    
    // Below threshold - cannot participate
    assert!(!state.can_participate("lazy_node", ts));
    
    println!("✅ Commit without reveal penalty = -1% (PASS)");
    println!("   Reputation after penalty: {:.2}%", rep * 100.0);
    println!("   Can participate: false (below 70% threshold)");
}

#[test]
fn test_slashing_invalid_block() {
    let mut state = DeterministicReputationState::new();
    let ts = 1000000;
    
    let slashing = SlashingEvent {
        offender: "bad_node".to_string(),
        offense: SlashingType::InvalidBlock {
            height: 100,
            block_hash: [1u8; 32],
            reason: "Invalid signature".to_string(),
        },
        penalty: 20.0, // -20%
        detected_at_height: 100,
        reporter: "reporter_node".to_string(),
        evidence_hash: [1u8; 32], // Valid evidence
    };
    
    let macroblock = MacroBlockData {
        index: 1,
        consensus: MacroBlockConsensus {
            index: 1,
            commit_participants: HashSet::new(),
            reveal_participants: HashSet::new(),
            slashing_events: vec![slashing],
            automatic_jails: Vec::new(),
            timestamp: ts,
        },
    };
    
    state.process_macroblock(&macroblock, ts);
    
    // Slashing: 70% - 20% = 50%
    let rep = state.get_reputation("bad_node", ts);
    assert!((rep - 0.50).abs() < 0.001, "Expected 50%, got {:.2}%", rep * 100.0);
    
    // Below threshold
    assert!(!state.can_participate("bad_node", ts));
    
    println!("✅ Slashing for invalid block = -20% (PASS)");
    println!("   Reputation after slashing: {:.2}%", rep * 100.0);
}

#[test]
fn test_double_sign_permanent_ban() {
    let mut state = DeterministicReputationState::new();
    let ts = 1000000;
    
    let slashing = SlashingEvent {
        offender: "byzantine_node".to_string(),
        offense: SlashingType::DoubleSign {
            height: 100,
            hash_a: [1u8; 32],
            hash_b: [2u8; 32],
        },
        penalty: 100.0, // Full penalty
        detected_at_height: 100,
        reporter: "reporter_node".to_string(),
        evidence_hash: [1u8; 32],
    };
    
    let macroblock = MacroBlockData {
        index: 1,
        consensus: MacroBlockConsensus {
            index: 1,
            commit_participants: HashSet::new(),
            reveal_participants: HashSet::new(),
            slashing_events: vec![slashing],
            automatic_jails: Vec::new(),
            timestamp: ts,
        },
    };
    
    state.process_macroblock(&macroblock, ts);
    
    // Permanent ban
    assert!(state.get_permanent_bans().contains("byzantine_node"));
    assert_eq!(state.get_reputation("byzantine_node", ts), 0.0);
    assert!(!state.can_participate("byzantine_node", ts));
    
    println!("✅ Double sign = PERMANENT BAN (PASS)");
    println!("   Reputation: 0%");
    println!("   Banned: true");
}

#[test]
fn test_automatic_jail() {
    let mut state = DeterministicReputationState::new();
    let ts = 1000000;
    
    let jail = AutomaticJail {
        node_id: "jailed_node".to_string(),
        offense_count: 1,
        jail_start_height: 100,
        jail_duration: 3600, // 1 hour
        reason: "Missed reveal".to_string(),
        evidence_hash: [1u8; 32],
    };
    
    let macroblock = MacroBlockData {
        index: 1,
        consensus: MacroBlockConsensus {
            index: 1,
            commit_participants: HashSet::new(),
            reveal_participants: HashSet::new(),
            slashing_events: Vec::new(),
            automatic_jails: vec![jail],
            timestamp: ts,
        },
    };
    
    state.process_macroblock(&macroblock, ts);
    
    // During jail: reputation = 0
    assert_eq!(state.get_reputation("jailed_node", ts + 100), 0.0);
    assert!(!state.can_participate("jailed_node", ts + 100));
    
    // After jail expires: reputation restored to 70%
    let after_jail = ts + 3700; // Jail + 100 seconds
    assert_eq!(state.get_reputation("jailed_node", after_jail), INITIAL_REPUTATION);
    assert!(state.can_participate("jailed_node", after_jail));
    
    println!("✅ Automatic jail (1 hour) (PASS)");
    println!("   During jail: 0% reputation, cannot participate");
    println!("   After jail: 70% reputation restored");
}

#[test]
fn test_reputation_caps() {
    let mut state = DeterministicReputationState::new();
    let ts = 1000000;
    
    // Process many rotations to try exceeding 100%
    for rotation in 0..20 {
        for block in 1..=30 {
            let height = rotation * 30 + block;
            state.process_block(&BlockData {
                height,
                producer: "super_node".to_string(),
                timestamp: ts + height,
                is_valid: true,
            });
        }
    }
    
    // Should cap at 100%
    let rep = state.get_reputation("super_node", ts);
    assert!(rep <= MAX_REPUTATION, "Reputation exceeded 100%: {:.2}%", rep * 100.0);
    assert!((rep - 1.0).abs() < 0.001, "Expected 100%, got {:.2}%", rep * 100.0);
    
    println!("✅ Reputation cap at 100% (PASS)");
    println!("   After 20 rotations: {:.2}%", rep * 100.0);
}

#[test]
fn test_reputation_floor() {
    let mut state = DeterministicReputationState::new();
    let ts = 1000000;
    
    // Apply many penalties
    for i in 0..100 {
        let slashing = SlashingEvent {
            offender: "penalized_node".to_string(),
            offense: SlashingType::InvalidBlock {
                height: i,
                block_hash: [i as u8; 32],
                reason: "Test".to_string(),
            },
            penalty: 5.0,
            detected_at_height: i,
            reporter: "reporter".to_string(),
            evidence_hash: [1u8; 32],
        };
        
        let macroblock = MacroBlockData {
            index: i,
            consensus: MacroBlockConsensus {
                index: i,
                commit_participants: HashSet::new(),
                reveal_participants: HashSet::new(),
                slashing_events: vec![slashing],
                automatic_jails: Vec::new(),
                timestamp: ts + i,
            },
        };
        
        state.process_macroblock(&macroblock, ts + i);
    }
    
    // Should floor at 0%
    let rep = state.get_reputation("penalized_node", ts);
    assert!(rep >= 0.0, "Reputation went negative: {:.2}%", rep * 100.0);
    assert_eq!(rep, 0.0);
    
    println!("✅ Reputation floor at 0% (PASS)");
}

#[test]
fn test_invalid_evidence_rejected() {
    let mut state = DeterministicReputationState::new();
    let ts = 1000000;
    
    // Slashing with invalid evidence (all zeros)
    let slashing = SlashingEvent {
        offender: "innocent_node".to_string(),
        offense: SlashingType::InvalidBlock {
            height: 100,
            block_hash: [1u8; 32],
            reason: "Fake accusation".to_string(),
        },
        penalty: 50.0,
        detected_at_height: 100,
        reporter: "malicious_reporter".to_string(),
        evidence_hash: [0u8; 32], // INVALID - all zeros
    };
    
    let macroblock = MacroBlockData {
        index: 1,
        consensus: MacroBlockConsensus {
            index: 1,
            commit_participants: HashSet::new(),
            reveal_participants: HashSet::new(),
            slashing_events: vec![slashing],
            automatic_jails: Vec::new(),
            timestamp: ts,
        },
    };
    
    state.process_macroblock(&macroblock, ts);
    
    // Invalid evidence should be rejected - reputation unchanged
    let rep = state.get_reputation("innocent_node", ts);
    assert_eq!(rep, INITIAL_REPUTATION, "Invalid evidence was accepted!");
    
    println!("✅ Invalid evidence rejected (PASS)");
    println!("   Reputation unchanged: {:.2}%", rep * 100.0);
}

#[test]
fn test_deterministic_consistency() {
    // Test that two states processing same data produce identical results
    let mut state1 = DeterministicReputationState::new();
    let mut state2 = DeterministicReputationState::new();
    let ts = 1000000;
    
    // Process same blocks
    for i in 1..=90 {
        let block = BlockData {
            height: i,
            producer: format!("producer_{}", i % 3),
            timestamp: ts + i,
            is_valid: true,
        };
        state1.process_block(&block);
        state2.process_block(&block);
    }
    
    // Process same macroblock
    let mut commit = HashSet::new();
    let mut reveal = HashSet::new();
    commit.insert("producer_0".to_string());
    commit.insert("producer_1".to_string());
    reveal.insert("producer_0".to_string());
    
    let macroblock = MacroBlockData {
        index: 1,
        consensus: MacroBlockConsensus {
            index: 1,
            commit_participants: commit,
            reveal_participants: reveal,
            slashing_events: Vec::new(),
            automatic_jails: Vec::new(),
            timestamp: ts,
        },
    };
    
    state1.process_macroblock(&macroblock, ts);
    state2.process_macroblock(&macroblock, ts);
    
    // Compare all reputations
    for (node_id, rep1) in state1.get_all_reputations() {
        let rep2 = state2.get_reputation(node_id, ts);
        assert!((rep1 - rep2).abs() < 0.0001, 
            "Determinism failed for {}: {:.4} vs {:.4}", node_id, rep1, rep2);
    }
    
    println!("✅ Deterministic consistency (PASS)");
    println!("   Two independent states produce identical results");
}

#[test]
fn test_memory_usage() {
    let mut state = DeterministicReputationState::new();
    let ts = 1000000;
    
    // Simulate large network: 1000 nodes
    for i in 0..1000 {
        let node_id = format!("node_{:04}", i);
        state.process_block(&BlockData {
            height: i + 1,
            producer: node_id,
            timestamp: ts + i,
            is_valid: true,
        });
    }
    
    // Check memory footprint
    let reputations_count = state.get_all_reputations().len();
    let jails_count = state.get_active_jails().len();
    let bans_count = state.get_permanent_bans().len();
    
    // Estimate memory: ~100 bytes per node (String + f64 + overhead)
    let estimated_memory_kb = (reputations_count * 100) / 1024;
    
    println!("✅ Memory usage audit (PASS)");
    println!("   Nodes tracked: {}", reputations_count);
    println!("   Active jails: {}", jails_count);
    println!("   Permanent bans: {}", bans_count);
    println!("   Estimated memory: ~{} KB", estimated_memory_kb);
    
    assert!(estimated_memory_kb < 1000, "Memory usage too high: {} KB", estimated_memory_kb);
}

#[test]
fn test_light_node_exclusion() {
    // Light nodes have fixed 70% reputation and never participate in consensus
    let state = DeterministicReputationState::new();
    let ts = 1000000;
    
    // Light node should have default reputation
    let light_rep = state.get_reputation("light_node_xyz", ts);
    assert_eq!(light_rep, INITIAL_REPUTATION);
    
    // Light nodes CAN meet threshold but are excluded by node type, not reputation
    // This is enforced in node.rs, not in DeterministicReputationState
    
    println!("✅ Light nodes have 70% reputation (PASS)");
    println!("   Light node reputation: {:.2}%", light_rep * 100.0);
    println!("   Note: Light nodes excluded by NodeType check in consensus, not reputation");
}

// ============================================================================
// INTEGRATION SUMMARY
// ============================================================================

#[test]
fn test_full_scenario() {
    println!("\n");
    println!("══════════════════════════════════════════════════════════════");
    println!("        QNET REPUTATION SYSTEM - FULL SCENARIO TEST");
    println!("══════════════════════════════════════════════════════════════");
    
    let mut state = DeterministicReputationState::new();
    let ts = 1_700_000_000; // ~2023 timestamp
    
    // Setup: 5 Genesis nodes
    let genesis_nodes: Vec<String> = (1..=5)
        .map(|i| format!("genesis_node_{:03}", i))
        .collect();
    
    println!("\n📊 Initial State:");
    for node in &genesis_nodes {
        println!("   {} = {:.0}%", node, state.get_reputation(node, ts) * 100.0);
    }
    
    // Simulate 3 rotations (90 blocks)
    println!("\n🔄 Processing 3 rotations (90 blocks)...");
    for rotation in 0..3 {
        for block in 1..=30 {
            let height = rotation * 30 + block;
            let producer = &genesis_nodes[(rotation as usize) % 5];
            state.process_block(&BlockData {
                height,
                producer: producer.clone(),
                timestamp: ts + height,
                is_valid: true,
            });
        }
    }
    
    println!("\n📊 After 3 rotations:");
    for node in &genesis_nodes {
        let rep = state.get_reputation(node, ts);
        let can = if state.can_participate(node, ts) { "✓" } else { "✗" };
        println!("   {} = {:.0}% [{}]", node, rep * 100.0, can);
    }
    
    // Simulate macroblock with slashing
    println!("\n⚠️ Slashing event: genesis_node_001 produced invalid block");
    let slashing = SlashingEvent {
        offender: "genesis_node_001".to_string(),
        offense: SlashingType::InvalidBlock {
            height: 95,
            block_hash: [1u8; 32],
            reason: "Invalid state transition".to_string(),
        },
        penalty: 20.0,
        detected_at_height: 95,
        reporter: "genesis_node_002".to_string(),
        evidence_hash: [1u8; 32],
    };
    
    let commit = genesis_nodes.iter().cloned().collect::<HashSet<_>>();
    let mut reveal = genesis_nodes.iter().cloned().collect::<HashSet<_>>();
    reveal.remove("genesis_node_003"); // Node 3 didn't reveal
    
    let macroblock = MacroBlockData {
        index: 1,
        consensus: MacroBlockConsensus {
            index: 1,
            commit_participants: commit,
            reveal_participants: reveal,
            slashing_events: vec![slashing],
            automatic_jails: Vec::new(),
            timestamp: ts + 100,
        },
    };
    
    state.process_macroblock(&macroblock, ts + 100);
    
    println!("\n📊 After macroblock with slashing:");
    for node in &genesis_nodes {
        let rep = state.get_reputation(node, ts + 100);
        let can = if state.can_participate(node, ts + 100) { "✓" } else { "✗" };
        let status = if rep < 0.70 { " ⚠️ BELOW THRESHOLD" } else { "" };
        println!("   {} = {:.0}% [{}]{}", node, rep * 100.0, can, status);
    }
    
    println!("\n══════════════════════════════════════════════════════════════");
    println!("                    ✅ SCENARIO COMPLETE");
    println!("══════════════════════════════════════════════════════════════\n");
}

fn main() {
    println!("Run with: cargo test --test reputation_audit -- --nocapture");
}


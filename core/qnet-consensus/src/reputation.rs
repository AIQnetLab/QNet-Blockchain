//! Node reputation system for consensus
//! Tracks node behavior and calculates weighted selection

use dashmap::DashMap;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};

/// Evidence of double signing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoubleSignEvidence {
    pub round: u64,
    pub hash_a: [u8; 32],
    pub hash_b: [u8; 32],
    pub offender: String,
    pub detected_at: u64,
    pub signature_a: Vec<u8>,
    pub signature_b: Vec<u8>,
}

/// Node information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInfo {
    pub node_id: String,
    pub public_key: Vec<u8>,
    pub reputation: f64,
    pub last_seen: u64,
    pub node_type: String,
}

/// Validator information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorInfo {
    pub node_id: String,

    pub reputation: f64,
    pub is_active: bool,
}

/// Evidence of misbehavior
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Evidence {
    pub evidence_type: String,
    pub node_id: String,
    pub evidence_data: Vec<u8>,
    pub timestamp: u64,
}

/// Result of slashing operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashingResult {
    pub node_id: String,
    pub slashed_amount: u64,
    pub new_reputation: f64,
    pub is_banned: bool,
}

/// Reputation configuration
#[derive(Debug, Clone)]
pub struct ReputationConfig {
    /// Initial reputation for new nodes
    pub initial_reputation: f64,
    /// Maximum reputation
    pub max_reputation: f64,
    /// Minimum reputation before banning
    pub min_reputation: f64,
    /// Reputation decay rate
    pub decay_rate: f64,
    /// Decay interval
    pub decay_interval: Duration,
}

impl Default for ReputationConfig {
    fn default() -> Self {
        Self {
            initial_reputation: 70.0,   // PRODUCTION: Minimum consensus participation threshold
            max_reputation: 100.0,
            min_reputation: 10.0,       // Ban threshold
            decay_rate: 0.01,
            decay_interval: Duration::from_secs(3600), // 1 hour
        }
    }
}

/// Jail status for temporary suspension
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JailStatus {
    pub jailed_until: u64,  // Unix timestamp when jail expires
    pub jail_count: u32,    // Number of times jailed
    pub jail_reason: String, // Reason for current jail
    pub pre_jail_reputation: f64, // Reputation before jailing
}

/// Malicious behavior types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MaliciousBehavior {
    DoubleSign,           // Signed multiple blocks at same height
    InvalidBlock,         // Produced cryptographically invalid block
    TimeManipulation,     // Block timestamp manipulation
    NetworkFlooding,      // DDoS-like behavior
    InvalidConsensus,     // Malformed consensus messages
    ProtocolViolation,    // Other protocol violations
    
    // CRITICAL ATTACKS - Instant maximum ban
    DatabaseSubstitution, // Attempted to substitute DB with alternate chain
    ChainFork,           // Created or promoted a fork of the chain
    StorageDeletion,     // Deleted database while being active producer
}

/// Node reputation manager - PRODUCTION: Optimized for millions of nodes
pub struct NodeReputation {
    config: ReputationConfig,
    /// QUANTUM OPTIMIZATION: Lock-free concurrent hashmap for reputation scores
    reputations: Arc<DashMap<String, f64>>,
    /// Lock-free tracking of last update times
    last_update: Arc<DashMap<String, Instant>>,
    /// Lock-free banned nodes tracking (DEPRECATED - use jail system)
    banned_nodes: Arc<DashMap<String, Instant>>,
    /// Jail system for temporary suspension
    jailed_nodes: Arc<DashMap<String, JailStatus>>,
    /// Track malicious behavior history
    violation_history: Arc<DashMap<String, Vec<(MaliciousBehavior, u64)>>>,
}

impl NodeReputation {
    /// Create new reputation manager
    pub fn new(config: ReputationConfig) -> Self {
        Self {
            config,
            reputations: Arc::new(DashMap::new()),
            last_update: Arc::new(DashMap::new()),
            banned_nodes: Arc::new(DashMap::new()),
            jailed_nodes: Arc::new(DashMap::new()),
            violation_history: Arc::new(DashMap::new()),
        }
    }
    
    /// Get reputation for a node
    pub fn get_reputation(&self, node_id: &str) -> f64 {
        // Check if node is jailed
        if let Some(jail_status) = self.jailed_nodes.get(node_id) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs();
            
            if now < jail_status.jailed_until {
                // Still jailed - return 0 for complete exclusion
                return 0.0;
            } else {
                // Jail expired - remove from jail and restore reputation
                drop(jail_status); // Release the read lock
                self.release_from_jail(node_id);
            }
        }
        
        // Legacy ban check (will be removed in future)
        if self.banned_nodes.contains_key(node_id) {
            return 0.0;
        }
        
        self.reputations.get(node_id)
            .map(|r| *r)
            .unwrap_or(self.config.initial_reputation)
    }
    
    /// Update reputation for a node (delta-based)
    pub fn update_reputation(&mut self, node_id: &str, delta: f64) {
        let current = self.get_reputation(node_id);
        let new_reputation = (current + delta)
            .max(0.0)
            .min(self.config.max_reputation);
        
        // PRODUCTION: Lock-free concurrent update
        self.reputations.insert(node_id.to_string(), new_reputation);
        self.last_update.insert(node_id.to_string(), Instant::now());
        
        // THREE STRIKES RULE: All nodes (including Genesis) get jailed
        // 3rd offense = PERMANENT BAN for everyone
        if new_reputation < self.config.min_reputation {
            println!("[JAIL] ⚠️ Node {} fell below threshold - applying jail", node_id);
            self.jail_node(node_id, MaliciousBehavior::ProtocolViolation);
        }
    }
    
    /// Set absolute reputation for a node (PRODUCTION: Genesis initialization)
    pub fn set_reputation(&mut self, node_id: &str, reputation: f64) {
        let new_reputation = reputation
            .max(0.0)
            .min(self.config.max_reputation);
        
        self.reputations.insert(node_id.to_string(), new_reputation);
        self.last_update.insert(node_id.to_string(), Instant::now());
        
        // THREE STRIKES RULE: All nodes get jailed equally
        if new_reputation < self.config.min_reputation {
            println!("[JAIL] ⚠️ Node {} set below threshold - applying jail", node_id);
            self.jail_node(node_id, MaliciousBehavior::ProtocolViolation);
        }
    }
    
    /// Ban a node
    pub fn ban_node(&mut self, node_id: &str) {
        self.banned_nodes.insert(node_id.to_string(), Instant::now());
        self.reputations.insert(node_id.to_string(), 0.0);
    }
    
    /// Check if a node is banned
    pub fn is_banned(&self, node_id: &str) -> bool {
        self.banned_nodes.contains_key(node_id)
    }
    
    /// Record successful behavior
    pub fn record_success(&mut self, node_id: &str) {
        self.update_reputation(node_id, 1.0);
    }
    
    /// Record failed behavior
    pub fn record_failure(&mut self, node_id: &str) {
        self.update_reputation(node_id, -2.0);
    }
    
    /// Apply reputation decay with activity check
    pub fn apply_decay(&mut self, last_activity: &HashMap<String, u64>) {
        let now = Instant::now();
        let current_timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // PRODUCTION: Check for ban expiry (7 days for recovery opportunity)
        let expired_bans: Vec<String> = self.banned_nodes
            .iter()
            .filter(|entry| now.duration_since(*entry.value()) > Duration::from_secs(7 * 24 * 3600))
            .map(|entry| entry.key().clone())
            .collect();
        
        for node_id in expired_bans {
            self.banned_nodes.remove(&node_id);
            // Give second chance with minimum consensus threshold
            self.reputations.insert(node_id.clone(), 70.0); 
            println!("[REPUTATION] ♻️ Node {} ban expired - restored to 70% reputation", node_id);
        }
        
        // Collect nodes that need decay first
        let nodes_to_decay: Vec<String> = self.last_update
            .iter()
            .filter(|entry| {
                // Don't decay banned nodes further
                !self.banned_nodes.contains_key(entry.key()) &&
                now.duration_since(*entry.value()) > self.config.decay_interval
            })
            .map(|entry| entry.key().clone())
            .collect();
        
        // Apply decay to collected nodes
        for node_id in nodes_to_decay {
            let current = self.get_reputation(&node_id);
            
            // CRITICAL: Check if node was active recently
            // Full/Super nodes ping 10 times per 4 hours = every 24 minutes
            // We check 1 hour window which should contain ~2.5 pings
            // This aligns with decay_interval (1 hour) from config
            let was_active = last_activity.get(&node_id)
                .map(|&last_ping| current_timestamp - last_ping < 3600) // Active if pinged within 1 hour (matches decay_interval)
                .unwrap_or(false);
            
            // PRODUCTION: Progressive recovery ONLY for active nodes
            if current < 70.0 {
                if was_active {
                    // Active node: allow recovery towards 70%
                    // GENESIS PHASE: Faster recovery for bootstrap stability
                    let is_genesis_phase = self.is_genesis_node(&node_id);
                    let recovery_rate = if is_genesis_phase {
                        0.05  // Genesis nodes: 5% recovery per check (every 5 sec = ~1% per sec)
                    } else {
                        0.01  // Regular nodes: 1% recovery per hour
                    };
                    let recovery_amount = (70.0 - current) * recovery_rate;
                    self.update_reputation(&node_id, recovery_amount);
                    println!("[REPUTATION] ✅ {} active - recovering +{:.2}% to {:.1}%{}", 
                            node_id, recovery_amount, current + recovery_amount,
                            if is_genesis_phase { " (Genesis fast recovery)" } else { "" });
                } else {
                    // Inactive node: no recovery, only decay
                    println!("[REPUTATION] ⏸️ {} inactive (no ping) - no recovery from {:.1}%", 
                            node_id, current);
                }
            } else if current > self.config.initial_reputation {
                // Above initial: decay towards baseline
                let decay_amount = (current - self.config.initial_reputation) * self.config.decay_rate;
                self.update_reputation(&node_id, -decay_amount);
            }
            // Nodes at exactly 70% stay stable
        }
    }
    
    /// Weighted selection based on reputation
    pub fn weighted_selection(&self, candidates: &[String], randomness: &str) -> Option<String> {
        if candidates.is_empty() {
            return None;
        }
        
        // Calculate total weight
        let total_weight: f64 = candidates.iter()
            .map(|id| self.get_reputation(id))
            .sum();
        
        if total_weight == 0.0 {
            return None;
        }
        
        // Use randomness to select
        let hash = blake3::hash(randomness.as_bytes());
        let seed = u64::from_le_bytes([
            hash.as_bytes()[0], hash.as_bytes()[1], hash.as_bytes()[2], hash.as_bytes()[3],
            hash.as_bytes()[4], hash.as_bytes()[5], hash.as_bytes()[6], hash.as_bytes()[7],
        ]);
        
        let target = (seed as f64 / u64::MAX as f64) * total_weight;
        let mut accumulated = 0.0;
        
        for candidate in candidates {
            accumulated += self.get_reputation(candidate);
            if accumulated >= target {
                return Some(candidate.clone());
            }
        }
        
        // Fallback to last candidate
        candidates.last().cloned()
    }
    
    /// Process double signing evidence
    pub fn process_double_sign_evidence(&mut self, evidence: &DoubleSignEvidence) -> SlashingResult {
        let node_id = &evidence.offender;
        let current_rep = self.get_reputation(node_id);
        
        // Major penalty for double signing
        let penalty = 50.0;
        let new_rep = (current_rep - penalty).max(0.0);
        
        self.reputations.insert(node_id.clone(), new_rep);
        
        // Ban if reputation too low
        let is_banned = new_rep < self.config.min_reputation;
        if is_banned {
            self.ban_node(node_id);
        }
        
        SlashingResult {
            node_id: node_id.clone(),
            slashed_amount: penalty as u64,
            new_reputation: new_rep,
            is_banned,
        }
    }
    
    /// Get all reputations - PRODUCTION: Optimized for concurrent access
    pub fn get_all_reputations(&self) -> HashMap<String, f64> {
        // Convert DashMap to HashMap for compatibility
        self.reputations
            .iter()
            .map(|entry| (entry.key().clone(), *entry.value()))
            .collect()
    }
    
    /// Get banned nodes - PRODUCTION: Lock-free iteration
    pub fn get_banned_nodes(&self) -> Vec<String> {
        self.banned_nodes
            .iter()
            .map(|entry| entry.key().clone())
            .collect()
    }
    
    /// Jail a node for malicious behavior
    pub fn jail_node(&mut self, node_id: &str, behavior: MaliciousBehavior) {
        // Track violation history
        self.violation_history
            .entry(node_id.to_string())
            .or_insert_with(Vec::new)
            .push((behavior.clone(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()));
        
        // CRITICAL: Check for instant max ban offenses
        let is_critical_attack = matches!(behavior, 
            MaliciousBehavior::DatabaseSubstitution | 
            MaliciousBehavior::ChainFork | 
            MaliciousBehavior::StorageDeletion
        );
        
        // Get jail count
        let jail_count = if is_critical_attack {
            // Critical attacks get instant max jail count
            999  // This will trigger maximum jail duration
        } else {
            self.jailed_nodes
                .get(node_id)
                .map(|js| js.jail_count + 1)
                .unwrap_or(1)
        };
        
        // Calculate jail duration based on offense count - SAME FOR ALL NODES
        // CRITICAL ATTACKS: Instant PERMANENT BAN (no return)
        // REGULAR OFFENSES: Progressive jail with 6 chances
        let is_permanent_ban = is_critical_attack;  // Only critical attacks = permanent
        
        let jailed_until = if is_permanent_ban {
            // PERMANENT BAN: Use u64::MAX directly (no overflow)
            u64::MAX
        } else {
            let jail_hours = match jail_count {
                1 => 1,           // First offense: 1 hour
                2 => 24,          // Second offense: 24 hours
                3 => 168,         // Third offense: 7 days
                4 => 720,         // Fourth offense: 30 days
                5 => 2160,        // Fifth offense: 3 months
                _ => 8760,        // 6+ offenses: 1 year (max, but can return)
            };
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs()
                .saturating_add(jail_hours * 3600)
        };
        
        let pre_jail_reputation = self.get_reputation(node_id);
        
        // Create jail status
        let jail_status = JailStatus {
            jailed_until,
            jail_count,
            jail_reason: format!("{:?}", behavior),
            pre_jail_reputation,
        };
        
        // Apply jail
        self.jailed_nodes.insert(node_id.to_string(), jail_status);
        
        // Apply reputation penalty based on behavior
        let penalty = match behavior {
            MaliciousBehavior::DoubleSign => 50.0,
            MaliciousBehavior::InvalidBlock => 30.0,
            MaliciousBehavior::TimeManipulation => 20.0,
            MaliciousBehavior::NetworkFlooding => 10.0,
            MaliciousBehavior::InvalidConsensus => 5.0,
            MaliciousBehavior::ProtocolViolation => 15.0,
            
            // CRITICAL ATTACKS - Maximum penalty (instant reputation destruction)
            MaliciousBehavior::DatabaseSubstitution => 100.0,  // Full reputation loss
            MaliciousBehavior::ChainFork => 100.0,             // Full reputation loss
            MaliciousBehavior::StorageDeletion => 100.0,       // Full reputation loss
        };
        
        // Apply penalty equally to ALL nodes - no special protection
        let new_reputation = (pre_jail_reputation - penalty).max(0.0);
        
        self.reputations.insert(node_id.to_string(), new_reputation);
        
        if is_permanent_ban {
            println!("[JAIL] 🚫 Node {} PERMANENTLY BANNED for CRITICAL ATTACK: {:?}", 
                    node_id, behavior);
        } else {
            let jail_hours = match jail_count {
                1 => 1,
                2 => 24,
                3 => 168,
                4 => 720,
                5 => 2160,
                _ => 8760,
            };
            println!("[JAIL] ⛓️ Node {} jailed for {} hours (offense #{}) for {:?}", 
                    node_id, jail_hours, jail_count, behavior);
        }
    }
    
    /// Release node from jail
    /// CRITICAL ATTACKS: Never released (permanent ban checked in jail_node)
    /// REGULAR OFFENSES: Progressive restoration with 6 chances
    fn release_from_jail(&self, node_id: &str) {
        if let Some((_, jail_status)) = self.jailed_nodes.remove(node_id) {
            // Check if this was a permanent ban (critical attack)
            if jail_status.jailed_until == u64::MAX {
                // Re-insert to keep permanently banned
                self.jailed_nodes.insert(node_id.to_string(), jail_status);
                println!("[JAIL] 🚫 Node {} is PERMANENTLY BANNED - cannot be released", node_id);
                return;
            }
            
            // Calculate restoration reputation based on jail count
            // Progressive penalty: more offenses = lower starting point
            let restore_reputation: f64 = match jail_status.jail_count {
                1 => 30.0,  // First offense: restore to 30%
                2 => 25.0,  // Second offense: restore to 25%
                3 => 20.0,  // Third offense: restore to 20%
                4 => 15.0,  // Fourth offense: restore to 15%
                5 => 12.0,  // Fifth offense: restore to 12%
                _ => 10.0,  // 6+ offenses: restore to 10% (minimum for passive recovery)
            };
            
            // All nodes (including Genesis) get same treatment
            // Minimum 10% ensures passive recovery is possible
            let final_reputation = restore_reputation.max(10.0);
            
            self.reputations.insert(node_id.to_string(), final_reputation);
            
            println!("[JAIL] 🔓 Node {} released from jail (offense #{}) - reputation restored to {}%", 
                    node_id, jail_status.jail_count, final_reputation);
        }
    }
    
    /// Check if node is Genesis (helper method)
    fn is_genesis_node(&self, node_id: &str) -> bool {
        // Check various Genesis node patterns
        node_id.starts_with("genesis_node_") ||
        node_id == "genesis_node_001" ||
        node_id == "genesis_node_002" ||
        node_id == "genesis_node_003" ||
        node_id == "genesis_node_004" ||
        node_id == "genesis_node_005" ||
        // Legacy patterns
        node_id == "QNET-BOOT-0001-STRAP" ||
        node_id == "QNET-BOOT-0002-STRAP" ||
        node_id == "QNET-BOOT-0003-STRAP" ||
        node_id == "QNET-BOOT-0004-STRAP" ||
        node_id == "QNET-BOOT-0005-STRAP"
    }
    
    /// Detect and handle malicious behavior
    pub fn detect_malicious_behavior(&mut self, node_id: &str, evidence: &Evidence) -> bool {
        // Parse evidence to determine behavior type
        let behavior = match evidence.evidence_type.as_str() {
            "double_sign" => MaliciousBehavior::DoubleSign,
            "invalid_block" => MaliciousBehavior::InvalidBlock,
            "time_manipulation" => MaliciousBehavior::TimeManipulation,
            "network_flooding" => MaliciousBehavior::NetworkFlooding,
            "invalid_consensus" => MaliciousBehavior::InvalidConsensus,
            _ => MaliciousBehavior::ProtocolViolation,
        };
        
        // Jail the node
        self.jail_node(node_id, behavior);
        
        true // Malicious behavior detected and handled
    }
    
    /// Check if node is currently jailed
    pub fn is_jailed(&self, node_id: &str) -> bool {
        if let Some(jail_status) = self.jailed_nodes.get(node_id) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs();
            
            now < jail_status.jailed_until
        } else {
            false
        }
    }
    
    /// Get jail status for a node
    pub fn get_jail_status(&self, node_id: &str) -> Option<JailStatus> {
        self.jailed_nodes.get(node_id).map(|entry| entry.clone())
    }
    
    /// PRODUCTION: Apply jail status from network sync
    /// Used for synchronizing jail across all nodes
    pub fn apply_jail_sync(&mut self, node_id: &str, jailed_until: u64, jail_count: u32, reason: String) {
        let jail_status = JailStatus {
            jailed_until,
            jail_count,
            jail_reason: reason,
            pre_jail_reputation: self.reputations.get(node_id).map(|r| *r).unwrap_or(70.0),
        };
        
        self.jailed_nodes.insert(node_id.to_string(), jail_status);
        
        // Set reputation to 0 while jailed
        if jailed_until == u64::MAX {
            self.reputations.insert(node_id.to_string(), 0.0);
        }
    }
    
    /// PRODUCTION: Get all jail statuses for sync broadcast
    /// Returns Vec of (node_id, jailed_until, jail_count, reason)
    pub fn get_all_jail_statuses(&self) -> Vec<(String, u64, u32, String)> {
        self.jailed_nodes
            .iter()
            .map(|entry| {
                let status = entry.value();
                (entry.key().clone(), status.jailed_until, status.jail_count, status.jail_reason.clone())
            })
            .collect()
    }
    
} 
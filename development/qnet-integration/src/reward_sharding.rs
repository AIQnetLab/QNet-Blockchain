//! Reward Processing Sharding for Scalability
//!
//! Distributes reward calculation across multiple shards
//! to handle millions of nodes efficiently

use crate::{
    storage::Storage,
    errors::{IntegrationError, IntegrationResult},
};
use qnet_consensus::lazy_rewards::{PhaseAwareReward, PhaseAwareRewardManager};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, RwLock};
use tokio::sync::{Mutex, Semaphore};
use futures::future::join_all;
use serde::{Serialize, Deserialize};

/// Number of shards for reward processing
const NUM_REWARD_SHARDS: usize = 16;

/// Max nodes per shard for optimal processing
const MAX_NODES_PER_SHARD: usize = 100_000;

/// Concurrent processing threads per shard
const THREADS_PER_SHARD: usize = 4;

/// Reward processing shard
#[derive(Clone)]
pub struct RewardShard {
    pub shard_id: usize,
    pub node_ids: Vec<String>,
    pub processing_state: ShardState,
    pub last_processed: u64,
}

/// Node type counts for proper Pool #2 distribution
#[derive(Clone)]
struct NodeTypeCounts {
    total: usize,
    super_nodes: usize,
    full_nodes: usize,
    light_nodes: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ShardState {
    Idle,
    Processing,
    Complete,
    Failed(String),
}

/// Sharded reward manager for distributed processing
pub struct ShardedRewardManager {
    /// Shards for parallel processing
    shards: Arc<RwLock<Vec<RewardShard>>>,
    
    /// Storage backend
    storage: Arc<Storage>,
    
    /// Processing semaphore for concurrency control
    processing_sem: Arc<Semaphore>,
    
    /// Shard assignment map (node_id -> shard_id)
    shard_assignments: Arc<RwLock<HashMap<String, usize>>>,
}

impl ShardedRewardManager {
    pub fn new(storage: Arc<Storage>) -> Self {
        let mut shards = Vec::new();
        for i in 0..NUM_REWARD_SHARDS {
            shards.push(RewardShard {
                shard_id: i,
                node_ids: Vec::new(),
                processing_state: ShardState::Idle,
                last_processed: 0,
            });
        }
        
        Self {
            shards: Arc::new(RwLock::new(shards)),
            storage,
            processing_sem: Arc::new(Semaphore::new(NUM_REWARD_SHARDS * THREADS_PER_SHARD)),
            shard_assignments: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    
    /// Assign nodes to shards based on hash distribution
    pub async fn assign_nodes_to_shards(&self, node_ids: Vec<String>) -> IntegrationResult<()> {
        let mut shards = self.shards.write().unwrap();
        let mut assignments = self.shard_assignments.write().unwrap();
        
        // Clear previous assignments
        for shard in shards.iter_mut() {
            shard.node_ids.clear();
            shard.processing_state = ShardState::Idle;
        }
        assignments.clear();
        
        // Distribute nodes across shards using consistent hashing
        for node_id in node_ids {
            let shard_id = self.calculate_shard_id(&node_id);
            shards[shard_id].node_ids.push(node_id.clone());
            assignments.insert(node_id, shard_id);
        }
        
        // Log distribution
        for shard in shards.iter() {
            println!("[SHARDING] Shard {}: {} nodes assigned", 
                     shard.shard_id, shard.node_ids.len());
        }
        
        Ok(())
    }
    
    /// Calculate shard ID using consistent hashing
    fn calculate_shard_id(&self, node_id: &str) -> usize {
        use sha3::{Sha3_256, Digest};
        
        let mut hasher = Sha3_256::new();
        hasher.update(node_id.as_bytes());
        let hash = hasher.finalize();
        
        // Use first 8 bytes of hash for shard selection
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&hash[..8]);
        let hash_value = u64::from_be_bytes(bytes);
        
        (hash_value % NUM_REWARD_SHARDS as u64) as usize
    }
    
    /// Process rewards for all shards in parallel
    pub async fn process_all_shards(
        &self, 
        reward_manager: Arc<RwLock<PhaseAwareRewardManager>>
    ) -> IntegrationResult<u64> {
        let shards = self.shards.read().unwrap().clone();
        let mut futures = Vec::new();
        
        println!("[SHARDING] Starting parallel processing of {} shards", shards.len());
        
        // FIRST PASS: Count eligible nodes BY TYPE across all shards
        let mut total_eligible_nodes = 0usize;
        let mut eligible_super_nodes = 0usize;
        let mut eligible_full_nodes = 0usize;
        let mut eligible_light_nodes = 0usize;
        
        for shard in &shards {
            for node_id in &shard.node_ids {
                // Check if node is eligible based on type
                if let Some((node_type, _, reputation)) = self.storage.load_node_registration(node_id)? {
                    // Light nodes: ANY reputation (mobile-friendly)
                    // Full/Super/Genesis: reputation >= 70 (maintain network quality)
                    let eligible = match node_type.as_str() {
                        "light" => true, // Light nodes always eligible (just need to answer pings)
                        "full" | "super" => reputation >= 70.0,
                        _ => reputation >= 70.0,
                    };
                    
                    if eligible {
                        total_eligible_nodes += 1;
                        match node_type.as_str() {
                            "super" => eligible_super_nodes += 1,
                            "full" => eligible_full_nodes += 1,
                            "light" => eligible_light_nodes += 1,
                            _ => {}
                        }
                    }
                }
            }
        }
        
        println!("[SHARDING] Eligible nodes - Total: {}, Super: {}, Full: {}, Light: {}", 
                 total_eligible_nodes, eligible_super_nodes, eligible_full_nodes, eligible_light_nodes);
        
        // SECOND PASS: Process shards with correct reward amount
        for shard in shards {
            let storage = self.storage.clone();
            let sem = self.processing_sem.clone();
            let reward_manager = reward_manager.clone();
            let node_counts = NodeTypeCounts {
                total: total_eligible_nodes,
                super_nodes: eligible_super_nodes,
                full_nodes: eligible_full_nodes,
                light_nodes: eligible_light_nodes,
            };
            
            futures.push(tokio::spawn(async move {
                let _permit = sem.acquire().await.unwrap();
                Self::process_shard_with_counts(shard, storage, reward_manager, node_counts).await
            }));
        }
        
        // Wait for all shards to complete
        let results = join_all(futures).await;
        
        let mut total_rewards = 0u64;
        let mut failed_shards = 0;
        
        for result in results {
            match result {
                Ok(Ok(rewards)) => total_rewards += rewards,
                Ok(Err(e)) => {
                    eprintln!("[SHARDING] Shard processing error: {}", e);
                    failed_shards += 1;
                },
                Err(e) => {
                    eprintln!("[SHARDING] Task join error: {}", e);
                    failed_shards += 1;
                }
            }
        }
        
        if failed_shards > 0 {
            eprintln!("[SHARDING] {} shards failed processing", failed_shards);
        }
        
        println!("[SHARDING] Processed total rewards: {} QNC across all shards", 
                 total_rewards as f64 / 1_000_000_000.0);
        
        Ok(total_rewards)
    }
    
    /// Process a single shard with known eligible node counts
    async fn process_shard_with_counts(
        shard: RewardShard,
        storage: Arc<Storage>,
        reward_manager: Arc<RwLock<PhaseAwareRewardManager>>,
        node_counts: NodeTypeCounts
    ) -> IntegrationResult<u64> {
        // Delegate to main processing with counts
        Self::process_shard_internal(shard, storage, reward_manager, Some(node_counts)).await
    }
    
    /// Process a single shard (legacy, without count)
    async fn process_shard(
        shard: RewardShard,
        storage: Arc<Storage>,
        reward_manager: Arc<RwLock<PhaseAwareRewardManager>>
    ) -> IntegrationResult<u64> {
        // Use legacy processing without known count
        Self::process_shard_internal(shard, storage, reward_manager, None).await
    }
    
    /// Internal shard processing with optional eligible node counts
    async fn process_shard_internal(
        mut shard: RewardShard,
        storage: Arc<Storage>,
        reward_manager: Arc<RwLock<PhaseAwareRewardManager>>,
        node_counts: Option<NodeTypeCounts>
    ) -> IntegrationResult<u64> {
        shard.processing_state = ShardState::Processing;
        
        let mut total_rewards = 0u64;
        
        // Process nodes in batches for memory efficiency
        const BATCH_SIZE: usize = 1000;
        let mut node_queue = VecDeque::from(shard.node_ids.clone());
        
        while !node_queue.is_empty() {
            let batch_size = BATCH_SIZE.min(node_queue.len());
            let mut batch = Vec::new();
            
            for _ in 0..batch_size {
                if let Some(node_id) = node_queue.pop_front() {
                    batch.push(node_id);
                }
            }
            
            // Process batch
            for node_id in batch {
                // Load ping history from storage
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                let since = now - (4 * 60 * 60); // Last 4 hours
                
                let ping_history = storage.get_ping_history(&node_id, since)?;
                
                // Calculate success rate
                let total_pings = ping_history.len();
                let successful_pings = ping_history.iter().filter(|(_, success, _)| *success).count();
                let success_rate = if total_pings > 0 {
                    (successful_pings as f64 / total_pings as f64) * 100.0
                } else {
                    0.0
                };
                
                // Load node registration
                if let Some((node_type, wallet, reputation)) = storage.load_node_registration(&node_id)? {
                    // Check eligibility based on ping requirements
                    let meets_ping_requirements = match node_type.as_str() {
                        "light" => {
                            // Light: binary - must respond to the 1 ping (100%)
                            total_pings == 1 && successful_pings == 1
                        },
                        "full" => {
                            // Full: 80% success rate minimum (8+ out of 10)
                            total_pings >= 10 && success_rate >= 80.0
                        },
                        "super" => {
                            // Super: 90% success rate minimum (9+ out of 10)
                            total_pings >= 10 && success_rate >= 90.0
                        },
                        _ => false,
                    };
                    
                    // Reputation requirements by node type:
                    // Light: ANY reputation (mobile devices, don't participate in consensus)
                    // Full/Super: >= 70 reputation (must maintain network quality)
                    let eligible_for_new_rewards = match node_type.as_str() {
                        "light" => true, // Light nodes: no reputation requirement
                        "full" | "super" => reputation >= 70.0, // Full/Super: maintain standards
                        _ => reputation >= 70.0, // Default: require good reputation
                    };
                    
                    if meets_ping_requirements && eligible_for_new_rewards {
                        // Load existing pending reward
                        let existing_reward = storage.load_pending_reward(&node_id)?;
                        let current_amount = existing_reward.as_ref()
                            .map(|r| r.total_reward)
                            .unwrap_or(0);
                        
                        // Calculate new reward with halving
                        // Base emission: 251,432.34 QNC every 4 hours (first 4 years)
                        
                        // Get actual genesis timestamp from reward_manager
                        let genesis_timestamp = {
                            let rm = reward_manager.read().unwrap();
                            rm.get_genesis_timestamp()
                        };
                        
                        // Calculate years since genesis
                        let years_since_genesis = if now > genesis_timestamp {
                            (now - genesis_timestamp) / (365 * 24 * 60 * 60)
                        } else {
                            0
                        };
                        
                        let halving_cycles = years_since_genesis / 4;
                        
                        // Apply halving (with sharp drop at year 20)
                        let base_emission_qnc = if halving_cycles == 5 {
                            // Year 20-24: Sharp drop by 10x
                            251_432.34 / (2.0_f64.powi(4) * 10.0)
                        } else if halving_cycles > 5 {
                            // After year 24: Continue normal halving
                            let normal_halvings = halving_cycles - 5;
                            251_432.34 / (2.0_f64.powi(4) * 10.0 * 2.0_f64.powi(normal_halvings as i32))
                        } else {
                            // First 20 years: Normal halving every 4 years
                            251_432.34 / 2.0_f64.powi(halving_cycles as i32)
                        };
                        
                        // Convert to nanoQNC (9 decimals)
                        let total_emission_nano = (base_emission_qnc * 1_000_000_000.0) as u64;
                        
                        // Divide emission by total eligible nodes
                        let base_reward = if let Some(ref counts) = node_counts {
                            // Proper division: total emission divided by all eligible nodes
                            if counts.total > 0 {
                                total_emission_nano / counts.total as u64
                            } else {
                                0 // No eligible nodes
                            }
                        } else {
                            // Fallback: assume 5 genesis nodes for now
                            total_emission_nano / 5
                        };
                        // Get Pool #2 transaction fees for distribution
                        let pool2_share = {
                            let rm = reward_manager.read().unwrap();
                            let total_fees = rm.get_pool2_fees();
                            
                            // CORRECT: Distribute Pool #2 by node type counts
                            // Super: 70% divided by ONLY super nodes
                            // Full: 30% divided by ONLY full nodes
                            // Light: 0% (don't process transactions)
                            match node_type.as_str() {
                                "super" => {
                                    let super_pool = (total_fees * 70) / 100;
                                    if let Some(ref counts) = node_counts {
                                        if counts.super_nodes > 0 {
                                            super_pool / counts.super_nodes as u64
                                        } else { 0 }
                                    } else { super_pool / 5 } // Fallback: assume 5 genesis
                                },
                                "full" => {
                                    let full_pool = (total_fees * 30) / 100;
                                    if let Some(ref counts) = node_counts {
                                        if counts.full_nodes > 0 {
                                            full_pool / counts.full_nodes as u64
                                        } else { 0 }
                                    } else { 0 } // No full nodes in genesis
                                },
                                "light" => 0, // Light nodes get 0% of transaction fees
                                _ => 0,
                            }
                        };
                        
                        let new_reward = PhaseAwareReward {
                            current_phase: qnet_consensus::QNetPhase::Phase1,
                            pool1_base_emission: base_reward,
                            pool2_transaction_fees: pool2_share,
                            pool3_activation_bonus: 0, // Phase 1 - no Pool #3
                            total_reward: current_amount + base_reward + pool2_share,
                        };
                        
                        // Save to storage
                        storage.save_pending_reward(&node_id, &new_reward)?;
                        total_rewards += base_reward;
                    }
                }
            }
        }
        
        shard.processing_state = ShardState::Complete;
        shard.last_processed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        println!("[SHARDING] Shard {} completed: {} nodes, {} QNC total", 
                 shard.shard_id, 
                 shard.node_ids.len(),
                 total_rewards as f64 / 1_000_000_000.0);
        
        Ok(total_rewards)
    }
    
    /// Get shard statistics
    pub fn get_shard_stats(&self) -> HashMap<String, serde_json::Value> {
        use serde_json::json;
        
        let shards = self.shards.read().unwrap();
        let mut stats = HashMap::new();
        
        for shard in shards.iter() {
            stats.insert(
                format!("shard_{}", shard.shard_id),
                json!({
                    "node_count": shard.node_ids.len(),
                    "state": format!("{:?}", shard.processing_state),
                    "last_processed": shard.last_processed,
                })
            );
        }
        
        stats.insert(
            "summary".to_string(),
            json!({
                "total_shards": NUM_REWARD_SHARDS,
                "max_nodes_per_shard": MAX_NODES_PER_SHARD,
                "threads_per_shard": THREADS_PER_SHARD,
            })
        );
        
        stats
    }
    
    /// Rebalance shards if load is uneven
    pub async fn rebalance_shards(&self) -> IntegrationResult<()> {
        let shards = self.shards.read().unwrap();
        
        // Calculate average load
        let total_nodes: usize = shards.iter().map(|s| s.node_ids.len()).sum();
        let avg_load = total_nodes / NUM_REWARD_SHARDS;
        let threshold = avg_load / 10; // 10% threshold
        
        // Check if rebalancing is needed
        let needs_rebalancing = shards.iter().any(|s| {
            let diff = (s.node_ids.len() as i32 - avg_load as i32).abs();
            diff > threshold as i32
        });
        
        if needs_rebalancing {
            println!("[SHARDING] Rebalancing shards due to uneven load distribution");
            
            // Collect all nodes
            let mut all_nodes = Vec::new();
            for shard in shards.iter() {
                all_nodes.extend(shard.node_ids.clone());
            }
            
            drop(shards); // Release read lock
            
            // Reassign nodes
            self.assign_nodes_to_shards(all_nodes).await?;
        }
        
        Ok(())
    }
}

/// Get optimal shard count based on node count
pub fn calculate_optimal_shards(total_nodes: usize) -> usize {
    // Aim for ~50k-100k nodes per shard
    let optimal = (total_nodes / 75_000).max(1);
    
    // Round to nearest power of 2 for better distribution
    let mut shard_count = 1;
    while shard_count < optimal {
        shard_count *= 2;
    }
    
    shard_count.min(256) // Cap at 256 shards
}

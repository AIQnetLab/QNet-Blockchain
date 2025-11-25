//! MEV Protection: Private Bundles Implementation
//! ARCHITECTURE: Optional MEV protection for critical transactions (DeFi, arbitrage)
//! Dynamic allocation: 0-20% block space for bundles, 80-100% for public transactions

use dashmap::DashMap;
use serde::{Serialize, Deserialize};
use std::sync::Arc;
use parking_lot::RwLock;
use std::collections::{VecDeque, BTreeMap};
use sha3::{Sha3_256, Digest};

use crate::simple_mempool::SimpleMempool;

/// PRODUCTION: MEV-protected transaction bundle (Flashbots-style)
/// ARCHITECTURE: Atomic execution, fair ordering, reputation-gated
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxBundle {
    /// Bundle unique identifier (SHA3-256 hash of all transactions)
    pub bundle_id: String,
    
    /// Transactions in bundle (executed atomically - all or nothing)
    pub transactions: Vec<String>,  // TX hashes
    
    /// Minimum block timestamp (don't include before this time)
    pub min_timestamp: u64,
    
    /// Maximum block timestamp (don't include after this time)
    pub max_timestamp: u64,
    
    /// Reverting TX hashes (if any of these in block, don't include this bundle)
    pub reverting_tx_hashes: Vec<String>,
    
    /// Submitter signature (Dilithium - post-quantum secure)
    pub signature: Vec<u8>,
    
    /// Submitter public key (for reputation check)
    pub submitter_pubkey: Vec<u8>,
    
    /// Total gas price (sum of all transactions in bundle)
    pub total_gas_price: u64,
}

impl TxBundle {
    /// Calculate bundle ID from transactions
    pub fn calculate_bundle_id(transactions: &[String]) -> String {
        let mut hasher = Sha3_256::new();
        for tx_hash in transactions {
            hasher.update(tx_hash.as_bytes());
        }
        format!("{:x}", hasher.finalize())
    }
    
    /// Check if bundle is valid at given timestamp
    pub fn is_valid_at(&self, timestamp: u64) -> bool {
        timestamp >= self.min_timestamp && timestamp <= self.max_timestamp
    }
    
    /// Verify bundle signature (Dilithium post-quantum signature)
    /// PRODUCTION: Uses existing qnet_consensus Dilithium verification
    pub async fn verify_signature(&self) -> bool {
        // SECURITY: Empty check first
        if self.signature.is_empty() || self.submitter_pubkey.is_empty() {
            return false;
        }
        
        // Convert pubkey to node_id (hex format)
        let node_id = hex::encode(&self.submitter_pubkey);
        
        // Convert signature to string (hex format for Dilithium)
        let signature_str = hex::encode(&self.signature);
        
        // Create message from bundle data (deterministic)
        let mut message_parts = Vec::new();
        message_parts.push(format!("bundle_id:{}", self.bundle_id));
        message_parts.push(format!("min_timestamp:{}", self.min_timestamp));
        message_parts.push(format!("max_timestamp:{}", self.max_timestamp));
        for tx_hash in &self.transactions {
            message_parts.push(format!("tx:{}", tx_hash));
        }
        let message = message_parts.join("|");
        
        // PRODUCTION: Use existing Dilithium verification from consensus
        qnet_consensus::consensus_crypto::verify_consensus_signature(
            &node_id,
            &message,
            &signature_str,
        ).await
    }
}

/// PRODUCTION: Bundle allocation constraints
/// ARCHITECTURE: Dynamic 0-20% allocation protects public transaction throughput
pub struct BundleAllocationConfig {
    /// Minimum bundle allocation (0% - no reservation when no demand)
    pub min_allocation: f64,
    
    /// Maximum bundle allocation (20% cap - protects public TXs)
    pub max_allocation: f64,
    
    /// Maximum transactions per bundle (prevents block space monopolization)
    pub max_txs_per_bundle: usize,
    
    /// Minimum reputation for bundle submission (anti-spam protection)
    pub min_reputation: f64,
    
    /// Bundle gas premium (compensates for block space inefficiency)
    pub gas_premium: f64,
    
    /// Maximum bundle lifetime (prevents mempool bloat)
    pub max_lifetime_sec: u64,
    
    /// Multi-producer fanout (load distribution)
    pub submission_fanout: usize,
}

impl Default for BundleAllocationConfig {
    fn default() -> Self {
        Self {
            min_allocation: 0.0,        // 0% minimum (no reservation!)
            max_allocation: 0.20,       // 20% maximum (protect public!)
            max_txs_per_bundle: 10,     // Max 10 TXs per bundle (Ethereum standard)
            min_reputation: 80.0,       // 80% reputation required (proven trustworthy)
            gas_premium: 1.20,          // +20% gas (economic incentive + compensation)
            max_lifetime_sec: 60,       // 60 seconds max (1 minute)
            submission_fanout: 3,       // Submit to 3 producers (redundancy + load distribution)
        }
    }
}

/// PRODUCTION: MEV-protected mempool with private bundles
/// ARCHITECTURE: Dual-pool design (public + private) with dynamic allocation
pub struct MevProtectedMempool {
    /// Public mempool (existing priority queue - 80-100% block space)
    pub public_pool: Arc<tokio::sync::RwLock<SimpleMempool>>,
    
    /// Private bundles (MEV-protected - 0-20% block space)
    bundles: Arc<DashMap<String, TxBundle>>,  // bundle_id -> bundle
    
    /// Bundle priority queue (sorted by total_gas_price descending)
    bundle_priority: Arc<RwLock<BTreeMap<u64, VecDeque<String>>>>,
    
    /// Configuration
    config: BundleAllocationConfig,
    
    /// Rate limiting per user (anti-spam)
    user_bundle_count: Arc<DashMap<String, UserBundleRate>>,
}

/// Rate limiting structure for bundle submissions
#[derive(Debug, Clone)]
struct UserBundleRate {
    count: u32,
    window_start: u64,
}

impl MevProtectedMempool {
    /// Create new MEV-protected mempool
    pub fn new(public_pool: Arc<tokio::sync::RwLock<SimpleMempool>>, config: BundleAllocationConfig) -> Self {
        Self {
            public_pool,
            bundles: Arc::new(DashMap::new()),
            bundle_priority: Arc::new(RwLock::new(BTreeMap::new())),
            config,
            user_bundle_count: Arc::new(DashMap::new()),
        }
    }
    
    /// Add MEV-protected bundle with validation
    /// PRODUCTION: Enforces all constraints (size, reputation, time, gas premium)
    pub async fn add_bundle(&self, bundle: TxBundle, submitter_reputation: f64, current_time: u64) -> Result<String, String> {
        // CONSTRAINT 1: Bundle size validation
        if bundle.transactions.is_empty() {
            return Err("Bundle cannot be empty".to_string());
        }
        
        if bundle.transactions.len() > self.config.max_txs_per_bundle {
            return Err(format!(
                "Bundle too large: {} TXs (max: {})", 
                bundle.transactions.len(), 
                self.config.max_txs_per_bundle
            ));
        }
        
        // CONSTRAINT 2: Reputation check (80%+ required)
        if submitter_reputation < self.config.min_reputation {
            return Err(format!(
                "Insufficient reputation: {:.1}% (required: {:.1}%)",
                submitter_reputation,
                self.config.min_reputation
            ));
        }
        
        // CONSTRAINT 3: Time window validation
        let bundle_lifetime = bundle.max_timestamp.saturating_sub(bundle.min_timestamp);
        if bundle_lifetime > self.config.max_lifetime_sec {
            return Err(format!(
                "Bundle lifetime too long: {}s (max: {}s)",
                bundle_lifetime,
                self.config.max_lifetime_sec
            ));
        }
        
        if bundle.max_timestamp < current_time {
            return Err("Bundle already expired".to_string());
        }
        
        // CONSTRAINT 4: Signature verification (Dilithium post-quantum)
        if !bundle.verify_signature().await {
            return Err("Invalid bundle signature".to_string());
        }
        
        // CONSTRAINT 5: Rate limiting (10 bundles/min per user)
        let submitter_key = hex::encode(&bundle.submitter_pubkey);
        let mut rate_limited = false;
        
        self.user_bundle_count.entry(submitter_key.clone())
            .and_modify(|rate| {
                // Reset window if 1 minute passed
                if current_time - rate.window_start > 60 {
                    rate.count = 0;
                    rate.window_start = current_time;
                }
                
                // Check limit (10 bundles/min)
                if rate.count >= 10 {
                    rate_limited = true;
                } else {
                    rate.count += 1;
                }
            })
            .or_insert(UserBundleRate {
                count: 1,
                window_start: current_time,
            });
        
        if rate_limited {
            return Err("Rate limit exceeded: 10 bundles/min".to_string());
        }
        
        // CONSTRAINT 6: Gas premium validation (+20% required)
        // PRODUCTION: Each TX in bundle must have gas_price ≥ min_gas_price * premium
        let min_gas_price = self.public_pool.read().await.get_min_gas_price();
        let required_gas_price = ((min_gas_price as f64) * self.config.gas_premium) as u64;
        
        for tx_hash in &bundle.transactions {
            if let Some(tx_json) = self.public_pool.read().await.get_raw_transaction(tx_hash) {
                // Parse TX to get gas_price
                if let Ok(tx_data) = serde_json::from_str::<serde_json::Value>(&tx_json) {
                    if let Some(gas_price) = tx_data["gas_price"].as_u64() {
                        if gas_price < required_gas_price {
                            return Err(format!(
                                "TX {} gas price too low: {} (required: {} with {}% premium)",
                                tx_hash,
                                gas_price,
                                required_gas_price,
                                ((self.config.gas_premium - 1.0) * 100.0) as u64
                            ));
                        }
                    } else {
                        return Err(format!("TX {} missing gas_price field", tx_hash));
                    }
                } else {
                    return Err(format!("TX {} invalid JSON format", tx_hash));
                }
            } else {
                return Err(format!("TX {} not found in public mempool", tx_hash));
            }
        }
        
        println!("[MEV] ✅ All bundle TXs meet gas premium requirement (+{}%)", 
                 ((self.config.gas_premium - 1.0) * 100.0) as u64);
        
        // Store bundle
        let bundle_id = bundle.bundle_id.clone();
        let total_gas = bundle.total_gas_price;
        
        self.bundles.insert(bundle_id.clone(), bundle);
        
        // Add to priority queue (sorted by total_gas_price descending)
        let mut priority = self.bundle_priority.write();
        priority.entry(total_gas)
            .or_insert_with(VecDeque::new)
            .push_back(bundle_id.clone());
        
        println!("[MEV] ✅ Bundle accepted: {} ({} TXs, {:.1}% reputation, {} gas)", 
                 bundle_id, 
                 self.bundles.get(&bundle_id).unwrap().transactions.len(),
                 submitter_reputation,
                 total_gas);
        
        Ok(bundle_id)
    }
    
    /// Get valid bundles for block building (dynamic 0-20% allocation)
    /// PRODUCTION: Returns bundles sorted by total_gas_price (highest first)
    pub fn get_valid_bundles(&self, current_time: u64, max_bundles: usize) -> Vec<TxBundle> {
        let priority = self.bundle_priority.read();
        
        priority.iter()
            .rev()  // Highest gas_price first
            .flat_map(|(_gas, bundle_ids)| bundle_ids.iter())
            .filter_map(|bundle_id| self.bundles.get(bundle_id).map(|b| b.clone()))
            .filter(|bundle| bundle.is_valid_at(current_time))
            .take(max_bundles)
            .collect()
    }
    
    /// Calculate dynamic bundle allocation for current block
    /// PRODUCTION: 0-20% allocation based on actual demand
    /// ARCHITECTURE: Protects public TXs (always ≥80% when demand exists)
    pub fn calculate_bundle_allocation(&self, max_txs: usize, current_time: u64) -> usize {
        let valid_bundles = self.get_valid_bundles(current_time, 1000);
        
        // Calculate actual bundle demand (total TXs in all valid bundles)
        let total_bundle_txs: usize = valid_bundles.iter()
            .map(|b| b.transactions.len())
            .sum();
        
        // Calculate demand as % of block
        let demand_ratio = total_bundle_txs as f64 / max_txs as f64;
        
        // Apply dynamic allocation with 0-20% cap
        let allocation_ratio = if demand_ratio <= self.config.min_allocation {
            demand_ratio  // Use actual (0% if no demand)
        } else if demand_ratio <= self.config.max_allocation {
            demand_ratio  // Use actual (within 0-20% range)
        } else {
            self.config.max_allocation  // Cap at 20% (protect public!)
        };
        
        let bundle_allocation = (max_txs as f64 * allocation_ratio) as usize;
        
        println!("[MEV] 📊 Bundle allocation: {:.1}% (demand: {:.1}%, cap: {}%)",
                 allocation_ratio * 100.0,
                 demand_ratio * 100.0,
                 (self.config.max_allocation * 100.0) as u64);
        
        bundle_allocation
    }
    
    /// OPTIMIZATION: Get bundles with allocation in single call (avoids double filtering)
    /// PRODUCTION: Used by block builder to efficiently get bundles + allocation
    pub fn get_bundles_with_allocation(
        &self, 
        max_txs: usize, 
        current_time: u64, 
        max_bundles: usize
    ) -> (Vec<TxBundle>, usize) {
        // Single call to get_valid_bundles (no duplication!)
        let valid_bundles = self.get_valid_bundles(current_time, max_bundles);
        
        // Calculate actual bundle demand (total TXs in all valid bundles)
        let total_bundle_txs: usize = valid_bundles.iter()
            .map(|b| b.transactions.len())
            .sum();
        
        // Calculate demand as % of block
        let demand_ratio = total_bundle_txs as f64 / max_txs as f64;
        
        // Apply dynamic allocation with 0-20% cap
        let allocation_ratio = if demand_ratio <= self.config.min_allocation {
            demand_ratio  // Use actual (0% if no demand)
        } else if demand_ratio <= self.config.max_allocation {
            demand_ratio  // Use actual (within 0-20% range)
        } else {
            self.config.max_allocation  // Cap at 20% (protect public!)
        };
        
        let bundle_allocation = (max_txs as f64 * allocation_ratio) as usize;
        
        println!("[MEV] 📊 Bundle allocation: {:.1}% (demand: {:.1}%, cap: {}%)",
                 allocation_ratio * 100.0,
                 demand_ratio * 100.0,
                 (self.config.max_allocation * 100.0) as u64);
        
        (valid_bundles, bundle_allocation)
    }
    
    /// Cleanup expired bundles (periodic maintenance)
    /// PRODUCTION: Prevents mempool bloat from stale bundles
    pub fn cleanup_expired_bundles(&self, current_time: u64) -> usize {
        let mut removed_count = 0;
        
        // Remove expired bundles
        self.bundles.retain(|bundle_id, bundle| {
            if bundle.max_timestamp < current_time {
                println!("[MEV] 🗑️ Removing expired bundle: {} (expired at {})", 
                         bundle_id, bundle.max_timestamp);
                removed_count += 1;
                false // Remove
            } else {
                true // Keep
            }
        });
        
        // Cleanup priority queue
        let mut priority = self.bundle_priority.write();
        for (_gas, bundle_ids) in priority.iter_mut() {
            bundle_ids.retain(|id| self.bundles.contains_key(id));
        }
        priority.retain(|_, ids| !ids.is_empty());
        
        // MEMORY LEAK FIX: Cleanup stale rate limit entries (>1 hour old)
        // Prevents unbounded growth from inactive users
        let mut rate_limit_cleaned = 0;
        self.user_bundle_count.retain(|_, rate| {
            let is_stale = current_time - rate.window_start > 3600;
            if is_stale {
                rate_limit_cleaned += 1;
            }
            !is_stale
        });
        
        if rate_limit_cleaned > 0 {
            println!("[MEV] 🧹 Cleaned up {} stale rate limit entries", rate_limit_cleaned);
        }
        
        if removed_count > 0 {
            println!("[MEV] ✅ Cleaned up {} expired bundles", removed_count);
        }
        
        removed_count
    }
    
    /// Remove bundle (e.g., after inclusion in block)
    pub fn remove_bundle(&self, bundle_id: &str) -> bool {
        if self.bundles.remove(bundle_id).is_some() {
            // Also remove from priority queue
            let mut priority = self.bundle_priority.write();
            for (_gas, bundle_ids) in priority.iter_mut() {
                bundle_ids.retain(|id| id != bundle_id);
            }
            priority.retain(|_, ids| !ids.is_empty());
            true
        } else {
            false
        }
    }
    
    /// Get bundle by ID
    pub fn get_bundle(&self, bundle_id: &str) -> Option<TxBundle> {
        self.bundles.get(bundle_id).map(|b| b.clone())
    }
    
    /// Get total number of pending bundles
    pub fn bundle_count(&self) -> usize {
        self.bundles.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_bundle_id_calculation() {
        let txs = vec![
            "0xabc123".to_string(),
            "0xdef456".to_string(),
        ];
        let bundle_id = TxBundle::calculate_bundle_id(&txs);
        assert!(!bundle_id.is_empty());
        assert_eq!(bundle_id.len(), 64); // SHA3-256 = 64 hex chars
    }
    
    #[test]
    fn test_bundle_validity() {
        let bundle = TxBundle {
            bundle_id: "test".to_string(),
            transactions: vec!["0xabc".to_string()],
            min_timestamp: 100,
            max_timestamp: 200,
            reverting_tx_hashes: vec![],
            signature: vec![1, 2, 3],
            submitter_pubkey: vec![4, 5, 6],
            total_gas_price: 1000,
        };
        
        assert!(!bundle.is_valid_at(50));   // Before min
        assert!(bundle.is_valid_at(150));   // Within range
        assert!(!bundle.is_valid_at(250));  // After max
    }
}


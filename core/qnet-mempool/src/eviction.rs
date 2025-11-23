//! Transaction eviction policies

use qnet_state::transaction::Transaction;
use std::time::{Duration, Instant};

/// Eviction policy trait
pub trait EvictionPolicy: Send + Sync {
    /// Should transaction be evicted?
    fn should_evict(&self, tx: &Transaction, age: Duration) -> bool;
    
    /// Compare two transactions for eviction priority
    fn compare_for_eviction(&self, tx1: &Transaction, tx2: &Transaction) -> std::cmp::Ordering;
}

/// Eviction strategy
#[derive(Debug, Clone, Copy)]
pub enum EvictionStrategy {
    /// Evict oldest first
    OldestFirst,
    /// Evict lowest gas price first
    LowestGasPrice,
    /// Evict largest transactions first
    LargestFirst,
    /// Combined strategy
    Combined,
}

/// Default eviction policy
pub struct DefaultEvictionPolicy {
    /// Maximum age before eviction
    pub max_age: Duration,
    
    /// Minimum gas price to keep
    pub min_gas_price: u64,
    
    /// Strategy to use
    pub strategy: EvictionStrategy,
}

impl Default for DefaultEvictionPolicy {
    fn default() -> Self {
        Self {
            max_age: Duration::from_secs(3600),
            min_gas_price: 100_000, // PRODUCTION: 0.0001 QNC (BASE_FEE_NANO_QNC)
            strategy: EvictionStrategy::Combined,
        }
    }
}

impl EvictionPolicy for DefaultEvictionPolicy {
    fn should_evict(&self, tx: &Transaction, age: Duration) -> bool {
        age > self.max_age || tx.gas_price < self.min_gas_price
    }
    
    fn compare_for_eviction(&self, tx1: &Transaction, tx2: &Transaction) -> std::cmp::Ordering {
        match self.strategy {
            EvictionStrategy::OldestFirst => {
                tx1.timestamp.cmp(&tx2.timestamp)
            }
            EvictionStrategy::LowestGasPrice => {
                tx1.gas_price.cmp(&tx2.gas_price)
            }
            EvictionStrategy::LargestFirst => {
                let size1 = bincode::serialize(tx1).unwrap().len();
                let size2 = bincode::serialize(tx2).unwrap().len();
                size2.cmp(&size1) // Reverse order
            }
            EvictionStrategy::Combined => {
                // First by gas price, then by age
                match tx1.gas_price.cmp(&tx2.gas_price) {
                    std::cmp::Ordering::Equal => tx1.timestamp.cmp(&tx2.timestamp),
                    other => other,
                }
            }
        }
    }
} 
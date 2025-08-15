//! Transaction priority calculation

use qnet_state::transaction::Transaction;
use std::cmp::Ordering;
use std::time::Instant;

/// Transaction priority information
#[derive(Debug, Clone)]
pub struct TxPriority {
    /// Gas price (primary factor)
    pub gas_price: u64,
    
    /// Time when transaction was added
    pub timestamp: Instant,
    
    /// Transaction size in bytes
    pub size: usize,
    
    /// Computed priority score
    pub score: f64,
    
    /// Whether this is a priority sender
    pub is_priority: bool,
}

impl TxPriority {
    /// Create new priority info
    pub fn new(tx: &Transaction, is_priority: bool) -> Self {
        let size = bincode::serialize(tx).unwrap().len();
        let mut priority = Self {
            gas_price: tx.gas_price,
            timestamp: Instant::now(),
            size,
            score: 0.0,
            is_priority,
        };
        priority.score = priority.calculate_score();
        priority
    }
    
    /// Calculate priority score
    fn calculate_score(&self) -> f64 {
        // Base score from gas price
        let mut score = self.gas_price as f64;
        
        // Boost for priority senders
        if self.is_priority {
            score *= 1.5;
        }
        
        // Penalty for large transactions
        if self.size > 10_000 {
            score *= 0.9;
        }
        
        // Small boost for older transactions (prevent starvation)
        let age = self.timestamp.elapsed().as_secs() as f64;
        score += age.min(300.0) * 0.1; // Max 30 point boost after 5 minutes
        
        score
    }
    
    /// Update score based on current time
    pub fn update_score(&mut self) {
        self.score = self.calculate_score();
    }
}

impl PartialEq for TxPriority {
    fn eq(&self, other: &Self) -> bool {
        self.score == other.score
    }
}

impl Eq for TxPriority {}

impl PartialOrd for TxPriority {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        // Higher score = higher priority
        self.score.partial_cmp(&other.score)
    }
}

impl Ord for TxPriority {
    fn cmp(&self, other: &Self) -> Ordering {
        self.partial_cmp(other).unwrap_or(Ordering::Equal)
    }
}

/// Priority calculator trait
pub trait PriorityCalculator: Send + Sync {
    /// Calculate priority for a transaction
    fn calculate_priority(&self, tx: &Transaction) -> TxPriority;
    
    /// Check if sender is priority
    fn is_priority_sender(&self, sender: &str) -> bool;
}

/// Default priority calculator
pub struct DefaultPriorityCalculator {
    /// Minimum gas price
    pub min_gas_price: u64,
    
    /// Priority senders (validators, etc)
    priority_senders: dashmap::DashSet<String>,
}

impl DefaultPriorityCalculator {
    /// Create new calculator
    pub fn new(min_gas_price: u64) -> Self {
        Self {
            min_gas_price,
            priority_senders: dashmap::DashSet::new(),
        }
    }
    
    /// Add priority sender
    pub fn add_priority_sender(&self, sender: String) {
        self.priority_senders.insert(sender);
    }
    
    /// Remove priority sender
    pub fn remove_priority_sender(&self, sender: &str) {
        self.priority_senders.remove(sender);
    }
}

impl PriorityCalculator for DefaultPriorityCalculator {
    fn calculate_priority(&self, tx: &Transaction) -> TxPriority {
        let is_priority = self.is_priority_sender(&tx.from);
        TxPriority::new(tx, is_priority)
    }
    
    fn is_priority_sender(&self, sender: &str) -> bool {
        self.priority_senders.contains(sender)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use qnet_state::transaction::TransactionType;
    
    #[test]
    fn test_priority_ordering() {
        let tx1 = Transaction::new(
            "sender1".to_string(),
            TransactionType::Transfer {
                to: "recipient".to_string(),
                amount: 100,
            },
            1,
            100, // Higher gas price
            10_000, // QNet TRANSFER gas limit
            1234567890,
        );
        
        let tx2 = Transaction::new(
            "sender2".to_string(),
            TransactionType::Transfer {
                to: "recipient".to_string(),
                amount: 100,
            },
            1,
            50, // Lower gas price
            10_000, // QNet TRANSFER gas limit
            1234567890,
        );
        
        let priority1 = TxPriority::new(&tx1, false);
        let priority2 = TxPriority::new(&tx2, false);
        
        assert!(priority1 > priority2);
    }
    
    #[test]
    fn test_priority_sender_boost() {
        let tx = Transaction::new(
            "validator".to_string(),
            TransactionType::Transfer {
                to: "recipient".to_string(),
                amount: 100,
            },
            1,
            50,
            10_000, // QNet TRANSFER gas limit
            1234567890,
        );
        
        let normal_priority = TxPriority::new(&tx, false);
        let priority_priority = TxPriority::new(&tx, true);
        
        assert!(priority_priority.score > normal_priority.score);
        assert_eq!(priority_priority.score, normal_priority.score * 1.5);
    }
} 
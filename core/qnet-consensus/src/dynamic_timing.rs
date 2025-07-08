//! Dynamic timing adjustment for consensus rounds

use std::collections::VecDeque;
use std::sync::Arc;
use parking_lot::RwLock;

/// Dynamic timing adjustment for consensus
pub struct DynamicTiming {
    /// History of round durations
    round_history: Arc<RwLock<VecDeque<u64>>>,
    
    /// Maximum history size
    max_history: usize,
    
    /// Target round time in milliseconds
    target_round_time: u64,
}

impl DynamicTiming {
    /// Create new dynamic timing instance
    pub fn new(target_round_time: u64) -> Self {
        Self {
            round_history: Arc::new(RwLock::new(VecDeque::new())),
            max_history: 100,
            target_round_time,
        }
    }
    
    /// Record round duration
    pub fn record_round_duration(&self, duration_ms: u64) {
        let mut history = self.round_history.write();
        history.push_back(duration_ms);
        
        // Keep only recent history
        while history.len() > self.max_history {
            history.pop_front();
        }
    }
    
    /// Calculate adjusted timing based on history
    pub fn calculate_adjusted_timing(&self) -> (u64, u64) {
        let history = self.round_history.read();
        
        if history.is_empty() {
            // Default timing
            return (60000, 30000); // 60s commit, 30s reveal
        }
        
        // Calculate average round time
        let avg_round_time: u64 = history.iter().sum::<u64>() / history.len() as u64;
        
        // Adjust timing based on performance
        let adjustment_factor = self.target_round_time as f64 / avg_round_time as f64;
        let adjustment_factor = adjustment_factor.clamp(0.5, 2.0); // Limit adjustment range
        
        let commit_duration = (60000.0 * adjustment_factor) as u64;
        let reveal_duration = (30000.0 * adjustment_factor) as u64;
        
        (commit_duration, reveal_duration)
    }
    
    /// Get average round time
    pub fn get_average_round_time(&self) -> Option<u64> {
        let history = self.round_history.read();
        
        if history.is_empty() {
            None
        } else {
            Some(history.iter().sum::<u64>() / history.len() as u64)
        }
    }
} 
//! Kademlia DHT with rate limiting and peer scoring
//! Production implementation for QNet P2P discovery
//! June 2025

use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};

/// Peer score and statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerScore {
    /// Peer reputation score (0-100)
    pub score: u8,
    /// Last time we heard from this peer
    pub last_seen: u64,
    /// Number of successful requests
    pub successful_requests: u32,
    /// Number of failed requests
    pub failed_requests: u32,
    /// Average response time in milliseconds
    pub avg_response_time: u32,
    /// Number of violations detected
    pub violations: u32,
}

impl Default for PeerScore {
    fn default() -> Self {
        Self {
            score: 50,
            last_seen: current_timestamp(),
            successful_requests: 0,
            failed_requests: 0,
            avg_response_time: 0,
            violations: 0,
        }
    }
}

impl PeerScore {
    /// Update score based on successful interaction
    pub fn record_success(&mut self, response_time_ms: u32) {
        self.successful_requests += 1;
        self.last_seen = current_timestamp();
        
        if self.avg_response_time == 0 {
            self.avg_response_time = response_time_ms;
        } else {
            self.avg_response_time = (self.avg_response_time * 7 + response_time_ms) / 8;
        }
        
        if response_time_ms < 1000 && self.score < 100 {
            self.score = (self.score + 1).min(100);
        }
    }
    
    /// Update score based on failed interaction
    pub fn record_failure(&mut self) {
        self.failed_requests += 1;
        self.last_seen = current_timestamp();
        
        if self.score > 0 {
            self.score = self.score.saturating_sub(2);
        }
    }
    
    /// Record a protocol violation
    pub fn record_violation(&mut self) {
        self.violations += 1;
        self.last_seen = current_timestamp();
        self.score = self.score.saturating_sub(10);
    }
    
    /// Check if peer is still valid for communication
    pub fn is_valid(&self) -> bool {
        // Unified ban threshold: 10.0 (same as reputation and peer scoring systems)
        if self.score < 10 {
            return false;
        }
        
        let current_time = current_timestamp();
        let one_hour = 60 * 60 * 1000;
        
        current_time.saturating_sub(self.last_seen) < one_hour
    }
}

/// Token bucket for rate limiting
#[derive(Debug)]
pub struct TokenBucket {
    capacity: u32,
    tokens: u32,
    refill_rate: u32,
    last_refill: Instant,
}

impl TokenBucket {
    pub fn new(capacity: u32, refill_rate: u32) -> Self {
        Self {
            capacity,
            tokens: capacity,
            refill_rate,
            last_refill: Instant::now(),
        }
    }
    
    pub fn try_consume(&mut self, tokens: u32) -> bool {
        self.refill();
        
        if self.tokens >= tokens {
            self.tokens -= tokens;
            true
        } else {
            false
        }
    }
    
    fn refill(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill);
        
        if elapsed >= Duration::from_secs(1) {
            let tokens_to_add = (elapsed.as_secs() as u32) * self.refill_rate;
            self.tokens = (self.tokens + tokens_to_add).min(self.capacity);
            self.last_refill = now;
        }
    }
}

/// Get current timestamp in milliseconds
fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
} 
// Tower BFT adaptive timeouts for QNet
// Integrates with existing consensus mechanisms

use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use std::collections::HashMap;

/// Tower BFT timeout configuration
#[derive(Debug, Clone)]
pub struct TowerBftConfig {
    /// Base timeout for first block (milliseconds)
    pub base_timeout_ms: u64,
    /// Timeout multiplier for exponential backoff
    pub timeout_multiplier: f64,
    /// Maximum timeout (milliseconds)
    pub max_timeout_ms: u64,
    /// Minimum timeout (milliseconds)  
    pub min_timeout_ms: u64,
    /// Network latency estimation window
    pub latency_window_size: usize,
}

impl Default for TowerBftConfig {
    fn default() -> Self {
        Self {
            base_timeout_ms: 7000,      // 7 seconds base (from existing code)
            timeout_multiplier: 1.5,    // 50% increase per retry
            max_timeout_ms: 20000,      // 20 seconds max (from existing first block timeout)
            min_timeout_ms: 1000,       // 1 second minimum
            latency_window_size: 100,   // Track last 100 measurements
        }
    }
}

/// Tower BFT adaptive timeout manager
pub struct TowerBft {
    /// Configuration
    config: TowerBftConfig,
    /// Vote timeouts by height
    vote_timeouts: Arc<RwLock<HashMap<u64, Duration>>>,
    /// Network latency measurements
    latency_measurements: Arc<RwLock<Vec<Duration>>>,
    /// Current network conditions
    network_state: Arc<RwLock<NetworkState>>,
}

/// Network state for adaptive adjustments
#[derive(Debug, Clone)]
pub struct NetworkState {
    /// Average network latency
    pub avg_latency_ms: u64,
    /// Packet loss rate (0.0 to 1.0)
    pub packet_loss_rate: f64,
    /// Number of active peers
    pub active_peers: usize,
    /// Last measurement time
    pub last_update: Instant,
}

impl Default for NetworkState {
    fn default() -> Self {
        Self {
            avg_latency_ms: 100,
            packet_loss_rate: 0.0,
            active_peers: 0,
            last_update: Instant::now(),
        }
    }
}

impl TowerBft {
    /// Create new Tower BFT manager
    pub fn new(config: TowerBftConfig) -> Self {
        Self {
            config,
            vote_timeouts: Arc::new(RwLock::new(HashMap::new())),
            latency_measurements: Arc::new(RwLock::new(Vec::new())),
            network_state: Arc::new(RwLock::new(NetworkState::default())),
        }
    }
    
    /// Get adaptive timeout for block at height
    pub async fn get_timeout(&self, height: u64, retry_count: u32) -> Duration {
        // Check cached timeout
        if let Some(timeout) = self.vote_timeouts.read().await.get(&height) {
            return *timeout;
        }
        
        // Calculate adaptive timeout based on QNet's existing logic
        let base_timeout = if height == 0 || height == 1 {
            // First blocks need more time for network bootstrap (from existing code)
            20000
        } else if height <= 10 {
            // Early blocks still forming network (from existing code)
            10000
        } else {
            // Normal operation (from existing code)
            7000
        };
        
        // Apply exponential backoff for retries
        let timeout_ms = if retry_count > 0 {
            let multiplier = self.config.timeout_multiplier.powi(retry_count as i32);
            let adjusted = (base_timeout as f64 * multiplier) as u64;
            adjusted.min(self.config.max_timeout_ms).max(self.config.min_timeout_ms)
        } else {
            base_timeout
        };
        
        // Adjust based on network conditions
        let network_state = self.network_state.read().await;
        let network_adjusted = if network_state.packet_loss_rate > 0.1 {
            // High packet loss - increase timeout
            (timeout_ms as f64 * (1.0 + network_state.packet_loss_rate)) as u64
        } else if network_state.avg_latency_ms > 500 {
            // High latency - increase proportionally
            timeout_ms + (network_state.avg_latency_ms / 10)
        } else {
            timeout_ms
        };
        
        let final_timeout = Duration::from_millis(network_adjusted);
        
        // Cache the timeout
        self.vote_timeouts.write().await.insert(height, final_timeout);
        
        final_timeout
    }
    
    /// Update network latency measurement
    pub async fn record_latency(&self, latency: Duration) {
        let mut measurements = self.latency_measurements.write().await;
        measurements.push(latency);
        
        // Keep only recent measurements
        if measurements.len() > self.config.latency_window_size {
            measurements.remove(0);
        }
        
        // Update network state
        if !measurements.is_empty() {
            let avg_latency_ms = measurements.iter()
                .map(|d| d.as_millis() as u64)
                .sum::<u64>() / measurements.len() as u64;
            
            let mut network_state = self.network_state.write().await;
            network_state.avg_latency_ms = avg_latency_ms;
            network_state.last_update = Instant::now();
        }
    }
    
    /// Update packet loss rate
    pub async fn update_packet_loss(&self, sent: usize, received: usize) {
        if sent > 0 {
            let loss_rate = 1.0 - (received as f64 / sent as f64);
            let mut network_state = self.network_state.write().await;
            network_state.packet_loss_rate = loss_rate;
        }
    }
    
    /// Update active peer count
    pub async fn update_peer_count(&self, count: usize) {
        let mut network_state = self.network_state.write().await;
        network_state.active_peers = count;
    }
    
    /// Get timeout for Byzantine consensus phases
    pub fn get_consensus_timeout(&self, phase: ConsensusPhase) -> Duration {
        match phase {
            ConsensusPhase::Commit => Duration::from_secs(15), // From existing code
            ConsensusPhase::Reveal => Duration::from_secs(15), // From existing code
            ConsensusPhase::Finalize => Duration::from_secs(5),
        }
    }
    
    /// Calculate validator stake-weighted timeout
    pub async fn get_stake_weighted_timeout(
        &self,
        height: u64,
        validator_stakes: &HashMap<String, u64>,
    ) -> Duration {
        let base_timeout = self.get_timeout(height, 0).await;
        
        if validator_stakes.is_empty() {
            return base_timeout;
        }
        
        // Calculate total stake
        let total_stake: u64 = validator_stakes.values().sum();
        if total_stake == 0 {
            return base_timeout;
        }
        
        // Weight timeout based on stake distribution
        // More distributed stake = longer timeout
        let stake_variance = self.calculate_stake_variance(validator_stakes, total_stake);
        
        // High variance means uneven distribution - need more time
        let multiplier = 1.0 + (stake_variance * 0.5).min(0.5);
        
        Duration::from_millis((base_timeout.as_millis() as f64 * multiplier) as u64)
    }
    
    /// Calculate stake variance for timeout adjustment
    fn calculate_stake_variance(&self, stakes: &HashMap<String, u64>, total: u64) -> f64 {
        let mean = total as f64 / stakes.len() as f64;
        let variance: f64 = stakes.values()
            .map(|&stake| {
                let diff = stake as f64 - mean;
                diff * diff
            })
            .sum::<f64>() / stakes.len() as f64;
        
        (variance / (mean * mean)).sqrt()
    }
    
    /// Clear old cached timeouts
    pub async fn clear_old_timeouts(&self, current_height: u64) {
        let mut timeouts = self.vote_timeouts.write().await;
        timeouts.retain(|&height, _| height >= current_height.saturating_sub(100));
    }
}

/// Consensus phase for timeout calculation
#[derive(Debug, Clone, Copy)]
pub enum ConsensusPhase {
    Commit,
    Reveal,
    Finalize,
}

/// Vote state for Tower BFT
#[derive(Debug, Clone)]
pub struct VoteState {
    pub height: u64,
    pub slot: u64,
    pub confirmations: u32,
    pub last_vote_time: Instant,
}

impl VoteState {
    pub fn new(height: u64, slot: u64) -> Self {
        Self {
            height,
            slot,
            confirmations: 0,
            last_vote_time: Instant::now(),
        }
    }
    
    /// Check if vote has expired based on timeout
    pub fn is_expired(&self, timeout: Duration) -> bool {
        self.last_vote_time.elapsed() > timeout
    }
    
    /// Increment confirmation count
    pub fn confirm(&mut self) {
        self.confirmations += 1;
        self.last_vote_time = Instant::now();
    }
}


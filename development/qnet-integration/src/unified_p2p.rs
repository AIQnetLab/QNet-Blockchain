//! Simplified Regional P2P Network
//! 
//! Simple and efficient P2P with basic regional clustering.
//! No complex intelligent switching - just regional awareness with failover.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::thread;
use serde::{Serialize, Deserialize};
use rand;
use serde_json;

/// Simple node types for P2P
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum NodeType {
    Light,   // Only receives macroblock headers
    Full,    // Receives all microblocks
    Super,   // Validates and produces blocks
}

/// Geographic regions for basic clustering
#[derive(Debug, Clone, PartialEq, Hash, Eq, Serialize, Deserialize)]
pub enum Region {
    NorthAmerica,
    Europe,
    Asia,
    SouthAmerica,
    Africa,
    Oceania,
}

/// Peer information with load metrics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub id: String,
    pub addr: String,
    pub node_type: NodeType,
    pub region: Region,
    pub last_seen: u64,
    pub is_stable: bool,
    pub cpu_load: f32,          // CPU usage percentage (0.0-1.0)
    pub latency_ms: u32,        // Network latency in milliseconds
    pub connection_count: u32,   // Number of active connections
    pub bandwidth_usage: u64,    // Bytes per second
}

/// Regional load balancing metrics
#[derive(Debug, Clone)]
pub struct RegionalMetrics {
    pub region: Region,
    pub average_cpu: f32,
    pub average_latency: u32,
    pub total_peers: u32,
    pub available_capacity: f32,  // 0.0-1.0 (1.0 = fully available)
    pub last_updated: Instant,
}

/// Load balancing configuration
#[derive(Debug, Clone)]
pub struct LoadBalancingConfig {
    pub max_cpu_threshold: f32,      // 0.8 = 80% CPU max
    pub max_latency_threshold: u32,   // 150ms max latency
    pub rebalance_interval_secs: u64, // 60 seconds between rebalancing
    pub min_peers_per_region: u32,   // 2 minimum peers per region
    pub max_peers_per_region: u32,   // 8 maximum peers per region
}

impl Default for LoadBalancingConfig {
    fn default() -> Self {
        Self {
            max_cpu_threshold: 0.80,      // 80% CPU threshold
            max_latency_threshold: 150,   // 150ms latency threshold
            rebalance_interval_secs: 60,  // Rebalance every minute
            min_peers_per_region: 2,      // Minimum 2 peers per region
            max_peers_per_region: 8,      // Maximum 8 peers per region
        }
    }
}

/// Simple P2P Network with intelligent load balancing
pub struct SimplifiedP2P {
    /// Node identification
    node_id: String,
    node_type: NodeType,
    region: Region,
    port: u16,
    
    /// Regional peer management with load balancing
    regional_peers: Arc<Mutex<HashMap<Region, Vec<PeerInfo>>>>,
    connected_peers: Arc<Mutex<Vec<PeerInfo>>>,
    regional_metrics: Arc<Mutex<HashMap<Region, RegionalMetrics>>>,
    
    /// Load balancing configuration
    lb_config: LoadBalancingConfig,
    
    /// Simple failover
    primary_region: Region,
    backup_regions: Vec<Region>,
    
    /// Enhanced metrics for load balancing
    last_health_check: Arc<Mutex<Instant>>,
    last_rebalance: Arc<Mutex<Instant>>,
    connection_count: Arc<Mutex<usize>>,
    total_bytes_sent: Arc<Mutex<u64>>,
    total_bytes_received: Arc<Mutex<u64>>,
    
    /// Network status
    is_running: Arc<Mutex<bool>>,
}

impl SimplifiedP2P {
    /// Create new simplified P2P network with load balancing
    pub fn new(
        node_id: String,
        node_type: NodeType,
        region: Region,
        port: u16,
    ) -> Self {
        let backup_regions = Self::get_backup_regions(&region);
        
        Self {
            node_id,
            node_type,
            region: region.clone(),
            port,
            regional_peers: Arc::new(Mutex::new(HashMap::new())),
            connected_peers: Arc::new(Mutex::new(Vec::new())),
            regional_metrics: Arc::new(Mutex::new(HashMap::new())),
            lb_config: LoadBalancingConfig::default(),
            primary_region: region,
            backup_regions,
            last_health_check: Arc::new(Mutex::new(Instant::now())),
            last_rebalance: Arc::new(Mutex::new(Instant::now())),
            connection_count: Arc::new(Mutex::new(0)),
            total_bytes_sent: Arc::new(Mutex::new(0)),
            total_bytes_received: Arc::new(Mutex::new(0)),
            is_running: Arc::new(Mutex::new(false)),
        }
    }
    
    /// Start simplified P2P network with load balancing
    pub fn start(&self) {
        println!("[P2P] Starting P2P network with intelligent load balancing");
        println!("[P2P] Node: {} | Type: {:?} | Region: {:?}", 
                 self.node_id, self.node_type, self.region);
        
        *self.is_running.lock().unwrap() = true;
        
        // Start load balancing health monitor
        self.start_load_balancing_monitor();
        
        // Start regional rebalancing
        self.start_regional_rebalancer();
        
        println!("[P2P] ✅ P2P network with load balancing started");
    }
    
    /// Connect to bootstrap peers
    pub fn connect_to_bootstrap_peers(&self, peers: &[String]) {
        if peers.is_empty() {
            println!("[P2P] No bootstrap peers provided - starting in standalone mode");
            return;
        }
        
        println!("[P2P] Connecting to {} bootstrap peers", peers.len());
        
        for peer_addr in peers {
            if let Ok(peer_info) = self.parse_peer_address(peer_addr) {
                self.add_peer_to_region(peer_info);
            }
        }
        
        // Try to establish connections
        self.establish_regional_connections();
    }
    
    /// Broadcast block data
    pub fn broadcast_block(&self, height: u64, block_data: Vec<u8>) -> Result<(), String> {
        let connected = self.connected_peers.lock().unwrap();
        
        if connected.is_empty() {
            // No peers - not an error in standalone mode
            return Ok(());
        }
        
        println!("[P2P] Broadcasting block #{} to {} peers", height, connected.len());
        
        // In production: Actually send block data to peers
        for peer in connected.iter() {
            // Filter by node type for efficiency
            let should_send = match (&self.node_type, &peer.node_type) {
                (NodeType::Light, _) => false,  // Light nodes don't broadcast
                (_, NodeType::Light) => height % 90 == 0,  // Send only macroblocks to light
                _ => true,  // Full/Super nodes get everything
            };
            
            if should_send {
                // Simulate network send
                println!("[P2P] → Sent block #{} to {} ({})", height, peer.id, peer.addr);
            }
        }
        
        Ok(())
    }
    
    /// Broadcast transaction
    pub fn broadcast_transaction(&self, tx_data: Vec<u8>) -> Result<(), String> {
        let connected = self.connected_peers.lock().unwrap();
        
        if connected.is_empty() {
            return Ok(());
        }
        
        // Only broadcast to Full and Super nodes
        let target_peers: Vec<_> = connected.iter()
            .filter(|p| matches!(p.node_type, NodeType::Full | NodeType::Super))
            .collect();
        
        println!("[P2P] Broadcasting transaction to {} peers", target_peers.len());
        
        for peer in target_peers {
            // In production: Send transaction data
            println!("[P2P] → Sent transaction to {} ({})", peer.id, peer.addr);
        }
        
        Ok(())
    }
    
    /// Get connected peer count
    pub fn get_peer_count(&self) -> usize {
        self.connected_peers.lock().unwrap().len()
    }
    
    /// Get regional health (simplified)
    pub fn get_regional_health(&self) -> f64 {
        let connected_count = self.get_peer_count();
        
        // Simple health calculation
        if connected_count >= 3 {
            1.0  // Healthy
        } else if connected_count >= 1 {
            0.5  // Degraded
        } else {
            0.0  // Isolated (not necessarily bad for standalone)
        }
    }
    
    /// Stop P2P network
    pub fn stop(&self) {
        *self.is_running.lock().unwrap() = false;
        println!("[P2P] ✅ Simplified P2P network stopped");
    }
    
    // === PRIVATE METHODS ===
    
    /// Get backup regions for failover
    fn get_backup_regions(primary: &Region) -> Vec<Region> {
        use Region::*;
        
        match primary {
            NorthAmerica => vec![Europe, Asia],
            Europe => vec![NorthAmerica, Asia],
            Asia => vec![Europe, NorthAmerica],
            SouthAmerica => vec![NorthAmerica, Europe],
            Africa => vec![Europe, Asia],
            Oceania => vec![Asia, NorthAmerica],
        }
    }
    
    /// Parse peer address string
    fn parse_peer_address(&self, addr: &str) -> Result<PeerInfo, String> {
        // Simple format: "id@ip:port"
        let parts: Vec<&str> = addr.split('@').collect();
        if parts.len() != 2 {
            return Err(format!("Invalid peer address format: {}", addr));
        }
        
        Ok(PeerInfo {
            id: parts[0].to_string(),
            addr: parts[1].to_string(),
            node_type: NodeType::Full,  // Assume Full by default
            region: self.region.clone(),  // Assume same region initially
            last_seen: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            is_stable: false,
            cpu_load: 0.5,
            latency_ms: 100,
            connection_count: 0,
            bandwidth_usage: 0,
        })
    }
    
    /// Add peer to regional map
    fn add_peer_to_region(&self, peer: PeerInfo) {
        let mut regional_peers = self.regional_peers.lock().unwrap();
        regional_peers
            .entry(peer.region.clone())
            .or_insert_with(Vec::new)
            .push(peer);
    }
    
    /// Establish connections within region and backups
    fn establish_regional_connections(&self) {
        let regional_peers = self.regional_peers.lock().unwrap();
        let mut connected = self.connected_peers.lock().unwrap();
        
        // Connect to primary region first
        if let Some(peers) = regional_peers.get(&self.primary_region) {
            for peer in peers.iter().take(5) {  // Max 5 peers per region
                connected.push(peer.clone());
                println!("[P2P] ✅ Connected to {} in {:?}", peer.id, peer.region);
            }
        }
        
        // If not enough peers, try backup regions
        if connected.len() < 3 {
            for backup_region in &self.backup_regions {
                if let Some(peers) = regional_peers.get(backup_region) {
                    for peer in peers.iter().take(2) {  // Max 2 from backup regions
                        if connected.len() < 5 {
                            connected.push(peer.clone());
                            println!("[P2P] ✅ Connected to {} in {:?} (backup)", 
                                     peer.id, peer.region);
                        }
                    }
                }
            }
        }
        
        *self.connection_count.lock().unwrap() = connected.len();
        
        if connected.is_empty() {
            println!("[P2P] ⚠️  No peers connected - running in standalone mode");
        } else {
            println!("[P2P] ✅ Connected to {} peers", connected.len());
        }
    }
    
    /// Intelligent peer selection with load balancing
    pub fn select_optimal_peers(&self, required_count: usize) -> Vec<PeerInfo> {
        let regional_peers = self.regional_peers.lock().unwrap();
        let metrics = self.regional_metrics.lock().unwrap();
        let mut selected_peers = Vec::new();
        
        // Get regions sorted by capacity (best first)
        let mut region_scores: Vec<(Region, f32)> = metrics
            .iter()
            .map(|(region, metric)| {
                let capacity_score = metric.available_capacity;
                let latency_score = 1.0 - (metric.average_latency as f32 / 1000.0).min(1.0);
                let cpu_score = 1.0 - metric.average_cpu;
                let combined_score = (capacity_score + latency_score + cpu_score) / 3.0;
                (region.clone(), combined_score)
            })
            .collect();
        
        region_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        
        // Select peers from best regions first
        for (region, _score) in region_scores {
            if selected_peers.len() >= required_count {
                break;
            }
            
            if let Some(peers) = regional_peers.get(&region) {
                let mut region_peers: Vec<PeerInfo> = peers
                    .iter()
                    .filter(|p| {
                        p.cpu_load < self.lb_config.max_cpu_threshold &&
                        p.latency_ms < self.lb_config.max_latency_threshold
                    })
                    .cloned()
                    .collect();
                
                // Sort by combined performance score
                region_peers.sort_by(|a, b| {
                    let score_a = self.calculate_peer_score(a);
                    let score_b = self.calculate_peer_score(b);
                    score_b.partial_cmp(&score_a).unwrap()
                });
                
                // Take up to max_peers_per_region from this region
                let take_count = (required_count - selected_peers.len())
                    .min(self.lb_config.max_peers_per_region as usize)
                    .min(region_peers.len());
                
                selected_peers.extend(region_peers.into_iter().take(take_count));
            }
        }
        
        println!("[P2P] 🎯 Selected {} optimal peers using load balancing", selected_peers.len());
        selected_peers
    }
    
    /// Calculate peer performance score (0.0-1.0, higher is better)
    fn calculate_peer_score(&self, peer: &PeerInfo) -> f32 {
        let cpu_score = 1.0 - peer.cpu_load;
        let latency_score = 1.0 - (peer.latency_ms as f32 / 1000.0).min(1.0);
        let stability_score = if peer.is_stable { 1.0 } else { 0.5 };
        
        // Weighted average: CPU (40%), Latency (40%), Stability (20%)
        (cpu_score * 0.4) + (latency_score * 0.4) + (stability_score * 0.2)
    }
    
    /// Update peer load metrics
    pub fn update_peer_metrics(&self, peer_id: &str, cpu_load: f32, latency_ms: u32, bandwidth_usage: u64) {
        let mut connected = self.connected_peers.lock().unwrap();
        
        if let Some(peer) = connected.iter_mut().find(|p| p.id == peer_id) {
            peer.cpu_load = cpu_load;
            peer.latency_ms = latency_ms;
            peer.bandwidth_usage = bandwidth_usage;
            peer.last_seen = self.current_timestamp();
        }
        
        // Update regional metrics
        self.update_regional_metrics();
    }
    
    /// Update regional load balancing metrics
    fn update_regional_metrics(&self) {
        let connected = self.connected_peers.lock().unwrap();
        let mut metrics = self.regional_metrics.lock().unwrap();
        
        for region in &[Region::NorthAmerica, Region::Europe, Region::Asia, Region::SouthAmerica, Region::Africa, Region::Oceania] {
            let region_peers: Vec<&PeerInfo> = connected
                .iter()
                .filter(|p| p.region == *region)
                .collect();
            
            if !region_peers.is_empty() {
                let avg_cpu = region_peers.iter().map(|p| p.cpu_load).sum::<f32>() / region_peers.len() as f32;
                let avg_latency = region_peers.iter().map(|p| p.latency_ms).sum::<u32>() / region_peers.len() as u32;
                
                // Calculate available capacity (inverse of load)
                let capacity = 1.0 - avg_cpu.min(1.0);
                
                metrics.insert(region.clone(), RegionalMetrics {
                    region: region.clone(),
                    average_cpu: avg_cpu,
                    average_latency: avg_latency,
                    total_peers: region_peers.len() as u32,
                    available_capacity: capacity,
                    last_updated: Instant::now(),
                });
            }
        }
    }
    
    /// Rebalance connections based on load
    pub fn rebalance_connections(&self) -> bool {
        let mut last_rebalance = self.last_rebalance.lock().unwrap();
        let now = Instant::now();
        
        // Check if enough time has passed since last rebalance
        if now.duration_since(*last_rebalance).as_secs() < self.lb_config.rebalance_interval_secs {
            return false;
        }
        
        *last_rebalance = now;
        drop(last_rebalance);
        
        println!("[P2P] 🔄 Starting connection rebalancing");
        
        // Get current load metrics
        let metrics = self.regional_metrics.lock().unwrap();
        let overloaded_regions: Vec<Region> = metrics
            .iter()
            .filter(|(_, metric)| {
                metric.average_cpu > self.lb_config.max_cpu_threshold ||
                metric.average_latency > self.lb_config.max_latency_threshold
            })
            .map(|(region, _)| region.clone())
            .collect();
        
        if overloaded_regions.is_empty() {
            println!("[P2P] ✅ All regions operating within thresholds");
            return false;
        }
        
        // Drop connections from overloaded regions
        let mut connected = self.connected_peers.lock().unwrap();
        let initial_count = connected.len();
        
        connected.retain(|peer| {
            if overloaded_regions.contains(&peer.region) && 
               (peer.cpu_load > self.lb_config.max_cpu_threshold || 
                peer.latency_ms > self.lb_config.max_latency_threshold) {
                println!("[P2P] 🔻 Dropping overloaded peer {} from {:?} (CPU: {:.1}%, Latency: {}ms)", 
                         peer.id, peer.region, peer.cpu_load * 100.0, peer.latency_ms);
                false
            } else {
                true
            }
        });
        
        let dropped_count = initial_count - connected.len();
        drop(connected);
        
        if dropped_count > 0 {
            // Reconnect to better peers
            let optimal_peers = self.select_optimal_peers(dropped_count);
            let mut connected = self.connected_peers.lock().unwrap();
            
            for peer in optimal_peers {
                println!("[P2P] 🔺 Connecting to optimal peer {} from {:?} (CPU: {:.1}%, Latency: {}ms)", 
                         peer.id, peer.region, peer.cpu_load * 100.0, peer.latency_ms);
                connected.push(peer);
            }
            
            println!("[P2P] ✅ Rebalancing complete: dropped {}, reconnected to optimal peers", dropped_count);
            true
        } else {
            false
        }
    }
    
    /// Start load balancing monitor
    fn start_load_balancing_monitor(&self) {
        let is_running = self.is_running.clone();
        let last_check = self.last_health_check.clone();
        let connected_peers = self.connected_peers.clone();
        let regional_metrics = self.regional_metrics.clone();
        
        thread::spawn(move || {
            while *is_running.lock().unwrap() {
                thread::sleep(Duration::from_secs(30)); // Check every 30 seconds
                
                *last_check.lock().unwrap() = Instant::now();
                
                // Simulate metrics collection from actual peers
                {
                    let mut connected = connected_peers.lock().unwrap();
                    for peer in connected.iter_mut() {
                        // In production: collect real metrics from peers
                        // For now: simulate realistic load variations
                        peer.cpu_load = (peer.cpu_load + rand::random::<f32>() * 0.1 - 0.05).clamp(0.0, 1.0);
                        peer.latency_ms = (peer.latency_ms as f32 + rand::random::<f32>() * 20.0 - 10.0).max(10.0) as u32;
                        peer.last_seen = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_secs();
                    }
                }
                
                // Update regional metrics for load balancing decisions
                // This would be implemented as a method call in the actual instance
                println!("[P2P] 📊 Load balancing metrics updated");
            }
        });
    }
    
    /// Start regional rebalancer
    fn start_regional_rebalancer(&self) {
        let is_running = self.is_running.clone();
        let node_id = self.node_id.clone();
        
        thread::spawn(move || {
            while *is_running.lock().unwrap() {
                thread::sleep(Duration::from_secs(60)); // Rebalance every minute
                
                // In production: call self.rebalance_connections()
                println!("[P2P] 🔄 Regional rebalancing check for node {}", node_id);
            }
        });
    }
    
    /// Get load balancing statistics
    pub fn get_load_balancing_stats(&self) -> HashMap<String, serde_json::Value> {
        let connected = self.connected_peers.lock().unwrap();
        let metrics = self.regional_metrics.lock().unwrap();
        
        let mut stats = HashMap::new();
        
        // Overall statistics
        stats.insert("total_peers".to_string(), serde_json::Value::Number(connected.len().into()));
        stats.insert("total_bytes_sent".to_string(), serde_json::Value::Number((*self.total_bytes_sent.lock().unwrap()).into()));
        stats.insert("total_bytes_received".to_string(), serde_json::Value::Number((*self.total_bytes_received.lock().unwrap()).into()));
        
        // Regional breakdown
        let mut regional_stats = serde_json::Map::new();
        for (region, metric) in metrics.iter() {
            regional_stats.insert(format!("{:?}", region), serde_json::json!({
                "peer_count": metric.total_peers,
                "avg_cpu": metric.average_cpu,
                "avg_latency_ms": metric.average_latency,
                "available_capacity": metric.available_capacity
            }));
        }
        stats.insert("regional_metrics".to_string(), serde_json::Value::Object(regional_stats));
        
        stats
    }
    
    /// Helper method to get current timestamp
    fn current_timestamp(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }
}

/// Message types for simplified network
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetworkMessage {
    /// Block data (microblock or macroblock)
    Block {
        height: u64,
        data: Vec<u8>,
        block_type: String,  // "micro" or "macro"
    },
    
    /// Transaction data
    Transaction {
        data: Vec<u8>,
    },
    
    /// Peer discovery
    PeerDiscovery {
        requesting_node: PeerInfo,
    },
    
    /// Simple health ping
    HealthPing {
        from: String,
        timestamp: u64,
    },
}

impl SimplifiedP2P {
    /// Handle incoming network message
    pub fn handle_message(&self, from_peer: &str, message: NetworkMessage) {
        match message {
            NetworkMessage::Block { height, data, block_type } => {
                println!("[P2P] ← Received {} block #{} from {} ({} bytes)", 
                         block_type, height, from_peer, data.len());
            }
            
            NetworkMessage::Transaction { data } => {
                println!("[P2P] ← Received transaction from {} ({} bytes)", 
                         from_peer, data.len());
            }
            
            NetworkMessage::PeerDiscovery { requesting_node } => {
                println!("[P2P] ← Peer discovery from {} in {:?}", 
                         requesting_node.id, requesting_node.region);
                self.add_peer_to_region(requesting_node);
            }
            
            NetworkMessage::HealthPing { from, timestamp: _ } => {
                // Simple acknowledgment - no complex processing
                println!("[P2P] ← Health ping from {}", from);
            }
        }
    }
} 
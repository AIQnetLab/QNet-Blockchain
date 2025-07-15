//! Kademlia DHT with rate limiting and peer scoring
//! Production implementation for QNet P2P discovery
//! June 2025

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tokio::time::{interval, sleep};
use tokio::net::UdpSocket;
use blake3;
use rand::Rng;

/// Kademlia constants
const K_BUCKET_SIZE: usize = 20;  // Standard Kademlia bucket size
const ALPHA: usize = 3;           // Concurrency parameter
const KEY_SIZE: usize = 32;       // 256-bit keys (32 bytes)
const REPLICATION_FACTOR: usize = 20; // Number of nodes to replicate to
const EXPIRATION_TIME: u64 = 86400; // 24 hours in seconds

/// Node ID is a 256-bit hash
pub type NodeId = [u8; KEY_SIZE];

/// Generate a random node ID
pub fn generate_node_id() -> NodeId {
    let mut id = [0u8; KEY_SIZE];
    rand::thread_rng().fill(&mut id);
    id
}

/// Calculate XOR distance between two node IDs
pub fn xor_distance(a: &NodeId, b: &NodeId) -> NodeId {
    let mut distance = [0u8; KEY_SIZE];
    for i in 0..KEY_SIZE {
        distance[i] = a[i] ^ b[i];
    }
    distance
}

/// Find the most significant bit position in a distance
pub fn msb_position(distance: &NodeId) -> Option<usize> {
    for (byte_idx, &byte) in distance.iter().enumerate() {
        if byte != 0 {
            for bit_idx in 0..8 {
                if (byte >> (7 - bit_idx)) & 1 == 1 {
                    return Some(byte_idx * 8 + bit_idx);
                }
            }
        }
    }
    None
}

/// Node information for Kademlia DHT
#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq, Hash)]
pub struct KademliaNode {
    pub id: NodeId,
    pub addr: String,
    pub port: u16,
    pub last_seen: u64,
}

impl KademliaNode {
    pub fn new(id: NodeId, addr: String, port: u16) -> Self {
        Self {
            id,
            addr,
            port,
            last_seen: current_timestamp(),
        }
    }
    
    pub fn update_last_seen(&mut self) {
        self.last_seen = current_timestamp();
    }
    
    pub fn is_stale(&self, timeout: u64) -> bool {
        current_timestamp() - self.last_seen > timeout
    }
}

/// K-bucket for storing nodes at a specific distance
#[derive(Debug, Clone)]
pub struct KBucket {
    pub nodes: Vec<KademliaNode>,
    pub last_updated: u64,
    pub max_size: usize,
}

impl KBucket {
    pub fn new(max_size: usize) -> Self {
        Self {
            nodes: Vec::new(),
            last_updated: current_timestamp(),
            max_size,
        }
    }
    
    /// Add a node to the bucket
    pub fn add_node(&mut self, node: KademliaNode) -> bool {
        // Check if node already exists
        if let Some(existing) = self.nodes.iter_mut().find(|n| n.id == node.id) {
            existing.update_last_seen();
            return true;
        }
        
        // If bucket is not full, add the node
        if self.nodes.len() < self.max_size {
            self.nodes.push(node);
            self.last_updated = current_timestamp();
            return true;
        }
        
        // Bucket is full - check if we can replace stale nodes
        if let Some(pos) = self.nodes.iter().position(|n| n.is_stale(3600)) {
            self.nodes[pos] = node;
            self.last_updated = current_timestamp();
            return true;
        }
        
        false
    }
    
    /// Remove a node from the bucket
    pub fn remove_node(&mut self, node_id: &NodeId) {
        self.nodes.retain(|n| n.id != *node_id);
        self.last_updated = current_timestamp();
    }
    
    /// Get the closest nodes to a target
    pub fn get_closest(&self, target: &NodeId, count: usize) -> Vec<KademliaNode> {
        let mut nodes = self.nodes.clone();
        nodes.sort_by(|a, b| {
            let dist_a = xor_distance(&a.id, target);
            let dist_b = xor_distance(&b.id, target);
            dist_a.cmp(&dist_b)
        });
        nodes.into_iter().take(count).collect()
    }
}

/// Kademlia RPC message types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum KademliaRpc {
    Ping { node_id: NodeId },
    Pong { node_id: NodeId },
    FindNode { node_id: NodeId, target: NodeId },
    FindNodeResponse { node_id: NodeId, nodes: Vec<KademliaNode> },
    Store { node_id: NodeId, key: NodeId, value: Vec<u8> },
    StoreResponse { node_id: NodeId, success: bool },
    FindValue { node_id: NodeId, key: NodeId },
    FindValueResponse { node_id: NodeId, value: Option<Vec<u8>>, nodes: Vec<KademliaNode> },
}

/// Stored value in DHT
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DhtValue {
    pub data: Vec<u8>,
    pub timestamp: u64,
    pub ttl: u64,
}

impl DhtValue {
    pub fn new(data: Vec<u8>, ttl: u64) -> Self {
        Self {
            data,
            timestamp: current_timestamp(),
            ttl,
        }
    }
    
    pub fn is_expired(&self) -> bool {
        current_timestamp() > self.timestamp + self.ttl
    }
}

/// Main Kademlia DHT implementation
pub struct KademliaDht {
    pub node_id: NodeId,
    pub addr: String,
    pub port: u16,
    pub buckets: Arc<RwLock<Vec<KBucket>>>,
    pub storage: Arc<RwLock<HashMap<NodeId, DhtValue>>>,
    pub pending_requests: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<KademliaRpc>>>>,
    pub socket: Arc<UdpSocket>,
    pub peer_scores: Arc<RwLock<HashMap<NodeId, PeerScore>>>,
    pub rate_limiters: Arc<RwLock<HashMap<NodeId, TokenBucket>>>,
}

impl KademliaDht {
    /// Create a new Kademlia DHT instance
    pub async fn new(addr: String, port: u16) -> Result<Self, Box<dyn std::error::Error>> {
        let node_id = generate_node_id();
        let socket = UdpSocket::bind(format!("{}:{}", addr, port)).await?;
        let socket = Arc::new(socket);
        
        let mut buckets = Vec::new();
        for _ in 0..KEY_SIZE * 8 {
            buckets.push(KBucket::new(K_BUCKET_SIZE));
        }
        
        let dht = Self {
            node_id,
            addr,
            port,
            buckets: Arc::new(RwLock::new(buckets)),
            storage: Arc::new(RwLock::new(HashMap::new())),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            socket,
            peer_scores: Arc::new(RwLock::new(HashMap::new())),
            rate_limiters: Arc::new(RwLock::new(HashMap::new())),
        };
        
        Ok(dht)
    }
    
    /// Start the DHT server
    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error>> {
        println!("[DHT] Starting Kademlia DHT on {}:{}", self.addr, self.port);
        
        // Start message handling loop
        let socket = self.socket.clone();
        let buckets = self.buckets.clone();
        let storage = self.storage.clone();
        let pending_requests = self.pending_requests.clone();
        let peer_scores = self.peer_scores.clone();
        let rate_limiters = self.rate_limiters.clone();
        let node_id = self.node_id;
        
        tokio::spawn(async move {
            let mut buffer = [0u8; 8192];
            loop {
                match socket.recv_from(&mut buffer).await {
                    Ok((len, src)) => {
                        let data = &buffer[..len];
                        if let Ok(msg) = bincode::deserialize::<KademliaRpc>(data) {
                            // Handle message inline to avoid self reference issues
                            tokio::spawn(async move {
                                // For now, just log the message
                                println!("[DHT] Received message: {:?}", msg);
                            });
                        }
                    }
                    Err(e) => {
                        eprintln!("[DHT] Error receiving message: {}", e);
                    }
                }
            }
        });
        
        // Start maintenance tasks
        self.start_maintenance_tasks().await;
        
        println!("[DHT] ✅ Kademlia DHT started successfully");
        Ok(())
    }
    

    
    /// Handle incoming RPC messages
    async fn handle_message(&self, message: KademliaRpc, src: std::net::SocketAddr) {
        // Check rate limiting
        if !self.check_rate_limit(&extract_node_id(&message)).await {
            return;
        }
        
        match message {
            KademliaRpc::Ping { node_id } => {
                let response = KademliaRpc::Pong { node_id: self.node_id };
                self.send_response(response, src).await;
                self.add_node_to_buckets(KademliaNode::new(node_id, src.ip().to_string(), src.port())).await;
            }
            
            KademliaRpc::FindNode { node_id, target } => {
                let nodes = self.find_closest_nodes(&target, K_BUCKET_SIZE).await;
                let response = KademliaRpc::FindNodeResponse { node_id: self.node_id, nodes };
                self.send_response(response, src).await;
                self.add_node_to_buckets(KademliaNode::new(node_id, src.ip().to_string(), src.port())).await;
            }
            
            KademliaRpc::Store { node_id, key, value } => {
                let mut storage = self.storage.write().await;
                let dht_value = DhtValue::new(value, EXPIRATION_TIME);
                storage.insert(key, dht_value);
                let response = KademliaRpc::StoreResponse { node_id: self.node_id, success: true };
                self.send_response(response, src).await;
                self.add_node_to_buckets(KademliaNode::new(node_id, src.ip().to_string(), src.port())).await;
            }
            
            KademliaRpc::FindValue { node_id, key } => {
                let storage = self.storage.read().await;
                let value = storage.get(&key).map(|v| v.data.clone());
                let response = if value.is_some() {
                    KademliaRpc::FindValueResponse { node_id: self.node_id, value, nodes: vec![] }
                } else {
                    let nodes = self.find_closest_nodes(&key, K_BUCKET_SIZE).await;
                    KademliaRpc::FindValueResponse { node_id: self.node_id, value: None, nodes }
                };
                self.send_response(response, src).await;
                self.add_node_to_buckets(KademliaNode::new(node_id, src.ip().to_string(), src.port())).await;
            }
            
            _ => {
                // Handle responses by finding pending requests
                if let Some(tx) = self.remove_pending_request(&format!("{}", src)).await {
                    let _ = tx.send(message);
                }
            }
        }
    }
    
    /// Send a response message
    async fn send_response(&self, message: KademliaRpc, dest: std::net::SocketAddr) {
        if let Ok(data) = bincode::serialize(&message) {
            let _ = self.socket.send_to(&data, dest).await;
        }
    }
    
    /// Add a node to the appropriate bucket
    async fn add_node_to_buckets(&self, node: KademliaNode) {
        let distance = xor_distance(&self.node_id, &node.id);
        if let Some(bucket_index) = msb_position(&distance) {
            let mut buckets = self.buckets.write().await;
            if bucket_index < buckets.len() {
                buckets[bucket_index].add_node(node);
            }
        }
    }
    
    /// Find the closest nodes to a target
    pub async fn find_closest_nodes(&self, target: &NodeId, count: usize) -> Vec<KademliaNode> {
        let buckets = self.buckets.read().await;
        let mut all_nodes = Vec::new();
        
        for bucket in buckets.iter() {
            all_nodes.extend(bucket.nodes.clone());
        }
        
        all_nodes.sort_by(|a, b| {
            let dist_a = xor_distance(&a.id, target);
            let dist_b = xor_distance(&b.id, target);
            dist_a.cmp(&dist_b)
        });
        
        all_nodes.into_iter().take(count).collect()
    }
    
    /// Perform iterative FIND_NODE operation
    pub async fn iterative_find_node(&self, target: &NodeId) -> Vec<KademliaNode> {
        let mut closest = self.find_closest_nodes(target, ALPHA).await;
        let mut queried = HashSet::new();
        let mut result = Vec::new();
        
        loop {
            let mut new_nodes = Vec::new();
            let mut pending_queries = Vec::new();
            
            for node in closest.iter().take(ALPHA) {
                if !queried.contains(&node.id) {
                    queried.insert(node.id);
                    let query = self.send_find_node_request(node.clone(), target);
                    pending_queries.push(query);
                }
            }
            
            // Wait for responses with timeout
            let timeout = tokio::time::timeout(Duration::from_secs(5), 
                futures::future::join_all(pending_queries)
            ).await;
            
            if let Ok(responses) = timeout {
                for response in responses {
                    if let Ok(nodes) = response {
                        new_nodes.extend(nodes);
                    }
                }
            }
            
            if new_nodes.is_empty() {
                break;
            }
            
            // Update closest nodes
            new_nodes.sort_by(|a, b| {
                let dist_a = xor_distance(&a.id, target);
                let dist_b = xor_distance(&b.id, target);
                dist_a.cmp(&dist_b)
            });
            
            closest = new_nodes.into_iter().take(K_BUCKET_SIZE).collect();
            result = closest.clone();
        }
        
        result
    }
    
    /// Send FIND_NODE request to a specific node
    async fn send_find_node_request(&self, node: KademliaNode, target: &NodeId) -> Result<Vec<KademliaNode>, Box<dyn std::error::Error + Send + Sync>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let request_id = format!("{}:{}", node.addr, node.port);
        
        {
            let mut pending = self.pending_requests.lock().unwrap();
            pending.insert(request_id.clone(), tx);
        }
        
        let message = KademliaRpc::FindNode { node_id: self.node_id, target: *target };
        let data = bincode::serialize(&message)?;
        let dest = format!("{}:{}", node.addr, node.port);
        
        self.socket.send_to(&data, &dest).await?;
        
        // Wait for response with timeout
        let response = tokio::time::timeout(Duration::from_secs(3), rx).await;
        
        match response {
            Ok(Ok(KademliaRpc::FindNodeResponse { nodes, .. })) => Ok(nodes),
            _ => {
                // Remove from pending requests on timeout/error
                let mut pending = self.pending_requests.lock().unwrap();
                pending.remove(&request_id);
                Err("Request timeout or error".into())
            }
        }
    }
    
    /// Store a value in the DHT
    pub async fn store(&self, key: NodeId, value: Vec<u8>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let closest_nodes = self.iterative_find_node(&key).await;
        let replication_nodes = closest_nodes.into_iter().take(REPLICATION_FACTOR).collect::<Vec<_>>();
        
        let mut success_count = 0;
        let mut store_futures = Vec::new();
        
        for node in replication_nodes {
            let store_future = self.send_store_request(node, key, value.clone());
            store_futures.push(store_future);
        }
        
        let results = futures::future::join_all(store_futures).await;
        for result in results {
            if result.is_ok() {
                success_count += 1;
            }
        }
        
        if success_count > 0 {
            println!("[DHT] Stored value with {} replicas", success_count);
            Ok(())
        } else {
            Err("Failed to store value".into())
        }
    }
    
    /// Send STORE request to a specific node
    async fn send_store_request(&self, node: KademliaNode, key: NodeId, value: Vec<u8>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let request_id = format!("{}:{}", node.addr, node.port);
        
        {
            let mut pending = self.pending_requests.lock().unwrap();
            pending.insert(request_id.clone(), tx);
        }
        
        let message = KademliaRpc::Store { node_id: self.node_id, key, value };
        let data = bincode::serialize(&message)?;
        let dest = format!("{}:{}", node.addr, node.port);
        
        self.socket.send_to(&data, &dest).await?;
        
        // Wait for response with timeout
        let response = tokio::time::timeout(Duration::from_secs(3), rx).await;
        
        match response {
            Ok(Ok(KademliaRpc::StoreResponse { success: true, .. })) => Ok(()),
            _ => {
                let mut pending = self.pending_requests.lock().unwrap();
                pending.remove(&request_id);
                Err("Store request failed".into())
            }
        }
    }
    
    /// Retrieve a value from the DHT
    pub async fn find_value(&self, key: &NodeId) -> Option<Vec<u8>> {
        // First check local storage
        {
            let storage = self.storage.read().await;
            if let Some(value) = storage.get(key) {
                if !value.is_expired() {
                    return Some(value.data.clone());
                }
            }
        }
        
        // Perform iterative search
        let mut closest = self.find_closest_nodes(key, ALPHA).await;
        let mut queried = HashSet::new();
        
        loop {
            let mut pending_queries = Vec::new();
            
            for node in closest.iter().take(ALPHA) {
                if !queried.contains(&node.id) {
                    queried.insert(node.id);
                    let query = self.send_find_value_request(node.clone(), key);
                    pending_queries.push(query);
                }
            }
            
            let timeout = tokio::time::timeout(Duration::from_secs(5), 
                futures::future::join_all(pending_queries)
            ).await;
            
            if let Ok(responses) = timeout {
                for response in responses {
                    if let Ok(Some(value)) = response {
                        return Some(value);
                    } else if let Ok(None) = response {
                        // Continue searching
                    }
                }
            }
            
            break;
        }
        
        None
    }
    
    /// Send FIND_VALUE request to a specific node
    async fn send_find_value_request(&self, node: KademliaNode, key: &NodeId) -> Result<Option<Vec<u8>>, Box<dyn std::error::Error + Send + Sync>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let request_id = format!("{}:{}", node.addr, node.port);
        
        {
            let mut pending = self.pending_requests.lock().unwrap();
            pending.insert(request_id.clone(), tx);
        }
        
        let message = KademliaRpc::FindValue { node_id: self.node_id, key: *key };
        let data = bincode::serialize(&message)?;
        let dest = format!("{}:{}", node.addr, node.port);
        
        self.socket.send_to(&data, &dest).await?;
        
        let response = tokio::time::timeout(Duration::from_secs(3), rx).await;
        
        match response {
            Ok(Ok(KademliaRpc::FindValueResponse { value: Some(data), .. })) => Ok(Some(data)),
            Ok(Ok(KademliaRpc::FindValueResponse { value: None, .. })) => Ok(None),
            _ => {
                let mut pending = self.pending_requests.lock().unwrap();
                pending.remove(&request_id);
                Err("Find value request failed".into())
            }
        }
    }
    
    /// Bootstrap the DHT with known nodes
    pub async fn bootstrap(&self, bootstrap_nodes: Vec<KademliaNode>) -> Result<(), Box<dyn std::error::Error>> {
        println!("[DHT] Bootstrapping with {} nodes", bootstrap_nodes.len());
        
        for node in bootstrap_nodes {
            self.add_node_to_buckets(node).await;
        }
        
        // Perform self-lookup to populate buckets
        let _ = self.iterative_find_node(&self.node_id).await;
        
        println!("[DHT] ✅ Bootstrap completed");
        Ok(())
    }
    
    /// Start maintenance tasks
    async fn start_maintenance_tasks(&self) {
        // Bucket refresh task
        let buckets = self.buckets.clone();
        let node_id = self.node_id;
        tokio::spawn(async move {
            let mut interval = interval(Duration::from_secs(3600)); // 1 hour
            loop {
                interval.tick().await;
                
                // Refresh buckets
                let buckets = buckets.read().await;
                for (i, bucket) in buckets.iter().enumerate() {
                    if bucket.nodes.is_empty() || current_timestamp() - bucket.last_updated > 3600 {
                        // Create a random ID in this bucket's range
                        let mut target = node_id;
                        target[i / 8] ^= 1 << (i % 8);
                        
                        // In a real implementation, you'd perform lookup here
                        // For now, we'll just log the refresh
                        println!("[DHT] Refreshing bucket {} with target {:?}", i, target);
                    }
                }
            }
        });
        
        // Storage cleanup task
        let storage = self.storage.clone();
        tokio::spawn(async move {
            let mut interval = interval(Duration::from_secs(1800)); // 30 minutes
            loop {
                interval.tick().await;
                let mut storage = storage.write().await;
                storage.retain(|_, value| !value.is_expired());
            }
        });
    }
    

    
    /// Check rate limit for a node
    async fn check_rate_limit(&self, node_id: &NodeId) -> bool {
        let mut rate_limiters = self.rate_limiters.write().await;
        let rate_limiter = rate_limiters.entry(*node_id).or_insert_with(|| {
            TokenBucket::new(100, 10) // 100 tokens, 10 tokens per second
        });
        rate_limiter.try_consume(1)
    }
    
    /// Remove pending request
    async fn remove_pending_request(&self, request_id: &str) -> Option<tokio::sync::oneshot::Sender<KademliaRpc>> {
        let mut pending = self.pending_requests.lock().unwrap();
        pending.remove(request_id)
    }
    
    /// Get peer discovery results
    pub async fn get_peers_for_region(&self, region: &str) -> Vec<KademliaNode> {
        let region_key = blake3::hash(region.as_bytes()).into();
        
        // Try to find existing peers for this region
        if let Some(data) = self.find_value(&region_key).await {
            if let Ok(nodes) = bincode::deserialize::<Vec<KademliaNode>>(&data) {
                return nodes;
            }
        }
        
        // Fall back to closest nodes
        self.find_closest_nodes(&region_key, K_BUCKET_SIZE).await
    }
    
    /// Announce our presence for a region
    pub async fn announce_for_region(&self, region: &str, our_node: KademliaNode) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let region_key = blake3::hash(region.as_bytes()).into();
        
        // Get existing peers for this region
        let mut peers = self.get_peers_for_region(region).await;
        
        // Add ourselves if not already present
        if !peers.iter().any(|p| p.id == our_node.id) {
            peers.push(our_node);
        }
        
        // Limit the number of peers to avoid bloat
        if peers.len() > K_BUCKET_SIZE {
            peers.truncate(K_BUCKET_SIZE);
        }
        
        // Store the updated peer list
        let data = bincode::serialize(&peers)?;
        self.store(region_key, data).await?;
        
        println!("[DHT] Announced presence for region: {}", region);
        Ok(())
    }
}

/// Extract node ID from RPC message
fn extract_node_id(message: &KademliaRpc) -> NodeId {
    match message {
        KademliaRpc::Ping { node_id } => *node_id,
        KademliaRpc::Pong { node_id } => *node_id,
        KademliaRpc::FindNode { node_id, .. } => *node_id,
        KademliaRpc::FindNodeResponse { node_id, .. } => *node_id,
        KademliaRpc::Store { node_id, .. } => *node_id,
        KademliaRpc::StoreResponse { node_id, .. } => *node_id,
        KademliaRpc::FindValue { node_id, .. } => *node_id,
        KademliaRpc::FindValueResponse { node_id, .. } => *node_id,
    }
}

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
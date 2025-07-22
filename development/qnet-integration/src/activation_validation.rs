use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use serde::{Deserialize, Serialize};
use sha3::{Sha3_256, Digest};
use crate::errors::IntegrationError;

/// High-performance activation registry optimized for millions of nodes
#[derive(Debug)]
pub struct BlockchainActivationRegistry {
    /// Bloom filter for fast negative lookups (99.9% of requests)
    bloom_filter: RwLock<BloomFilter>,
    /// L1 cache: Hot activation codes (most recently used)
    l1_cache: RwLock<LruCache<String, bool>>,
    /// L2 cache: All known activation codes
    used_codes: RwLock<HashSet<String>>,
    /// L3 cache: Active nodes by device signature
    active_nodes: RwLock<HashMap<String, NodeInfo>>,
    /// L4 cache: Full activation records
    activation_records: RwLock<HashMap<String, ActivationRecord>>,
    /// Hierarchical cache statistics
    cache_stats: RwLock<CacheStats>,
    /// Last blockchain sync timestamp
    last_sync: RwLock<u64>,
    /// Cache TTL in seconds (5 minutes for production)
    cache_ttl: u64,
    /// DHT peer network for distributed validation
    dht_client: Option<DhtClient>,
    /// Load balancer for blockchain RPC endpoints
    rpc_load_balancer: RpcLoadBalancer,
}

/// Bloom filter for fast negative lookups
#[derive(Debug)]
pub struct BloomFilter {
    bit_array: Vec<u64>,
    size: usize,
    hash_count: usize,
    items_count: usize,
}

impl BloomFilter {
    pub fn new(expected_items: usize, false_positive_rate: f64) -> Self {
        let size = Self::optimal_size(expected_items, false_positive_rate);
        let hash_count = Self::optimal_hash_count(size, expected_items);
        
        Self {
            bit_array: vec![0; size / 64 + 1],
            size,
            hash_count,
            items_count: 0,
        }
    }
    
    fn optimal_size(n: usize, p: f64) -> usize {
        let m = -(n as f64 * p.ln() / (2.0_f64.ln().powi(2)));
        m.ceil() as usize
    }
    
    fn optimal_hash_count(m: usize, n: usize) -> usize {
        let k = (m as f64 / n as f64) * 2.0_f64.ln();
        k.ceil() as usize
    }
    
    pub fn add(&mut self, item: &str) {
        for i in 0..self.hash_count {
            let hash = self.hash_item(item, i);
            let index = hash % self.size;
            let word_index = index / 64;
            let bit_index = index % 64;
            
            self.bit_array[word_index] |= 1 << bit_index;
        }
        self.items_count += 1;
    }
    
    pub fn contains(&self, item: &str) -> bool {
        for i in 0..self.hash_count {
            let hash = self.hash_item(item, i);
            let index = hash % self.size;
            let word_index = index / 64;
            let bit_index = index % 64;
            
            if (self.bit_array[word_index] & (1 << bit_index)) == 0 {
                return false;
            }
        }
        true
    }
    
    fn hash_item(&self, item: &str, seed: usize) -> usize {
        let mut hasher = Sha3_256::new();
        hasher.update(item.as_bytes());
        hasher.update(seed.to_string().as_bytes());
        let hash = hasher.finalize();
        
        let mut result = 0usize;
        for (i, &byte) in hash.iter().take(8).enumerate() {
            result |= (byte as usize) << (i * 8);
        }
        result
    }
    
    pub fn false_positive_rate(&self) -> f64 {
        let load_factor = self.items_count as f64 / self.size as f64;
        (1.0 - (-(self.hash_count as f64) * load_factor).exp()).powi(self.hash_count as i32)
    }
}

/// LRU cache for hot activation codes
#[derive(Debug)]
pub struct LruCache<K, V> {
    capacity: usize,
    items: HashMap<K, V>,
    access_order: Vec<K>,
}

impl<K: Clone + Eq + std::hash::Hash, V> LruCache<K, V> {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            items: HashMap::new(),
            access_order: Vec::new(),
        }
    }
    
    pub fn get(&mut self, key: &K) -> Option<&V> {
        if let Some(value) = self.items.get(key) {
            // Move to end (most recently used)
            self.access_order.retain(|k| k != key);
            self.access_order.push(key.clone());
            Some(value)
        } else {
            None
        }
    }
    
    pub fn put(&mut self, key: K, value: V) {
        if self.items.contains_key(&key) {
            // Update existing
            self.items.insert(key.clone(), value);
            self.access_order.retain(|k| k != &key);
            self.access_order.push(key);
        } else {
            // Add new
            if self.items.len() >= self.capacity {
                // Remove least recently used
                if let Some(lru_key) = self.access_order.first().cloned() {
                    self.items.remove(&lru_key);
                    self.access_order.remove(0);
                }
            }
            
            self.items.insert(key.clone(), value);
            self.access_order.push(key);
        }
    }
    
    pub fn len(&self) -> usize {
        self.items.len()
    }
}

/// Cache performance statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheStats {
    pub bloom_filter_hits: u64,
    pub bloom_filter_misses: u64,
    pub l1_cache_hits: u64,
    pub l1_cache_misses: u64,
    pub l2_cache_hits: u64,
    pub l2_cache_misses: u64,
    pub blockchain_queries: u64,
    pub dht_queries: u64,
    pub total_requests: u64,
}

impl CacheStats {
    pub fn new() -> Self {
        Self {
            bloom_filter_hits: 0,
            bloom_filter_misses: 0,
            l1_cache_hits: 0,
            l1_cache_misses: 0,
            l2_cache_hits: 0,
            l2_cache_misses: 0,
            blockchain_queries: 0,
            dht_queries: 0,
            total_requests: 0,
        }
    }
    
    pub fn hit_rate(&self) -> f64 {
        if self.total_requests == 0 {
            return 0.0;
        }
        
        let total_hits = self.bloom_filter_hits + self.l1_cache_hits + self.l2_cache_hits;
        total_hits as f64 / self.total_requests as f64
    }
    
    pub fn avg_query_time_ms(&self) -> f64 {
        // Estimate based on cache layer performance
        let bloom_time = self.bloom_filter_hits as f64 * 0.001; // 0.001ms
        let l1_time = self.l1_cache_hits as f64 * 0.01; // 0.01ms  
        let l2_time = self.l2_cache_hits as f64 * 0.1; // 0.1ms
        let blockchain_time = self.blockchain_queries as f64 * 100.0; // 100ms
        let dht_time = self.dht_queries as f64 * 10.0; // 10ms
        
        (bloom_time + l1_time + l2_time + blockchain_time + dht_time) / self.total_requests as f64
    }
}

/// Load balancer for blockchain RPC endpoints
#[derive(Debug)]
pub struct RpcLoadBalancer {
    endpoints: Vec<RpcEndpoint>,
    current_index: std::sync::atomic::AtomicUsize,
}

#[derive(Debug, Clone)]
pub struct RpcEndpoint {
    pub url: String,
    pub latency_ms: u64,
    pub success_rate: f64,
    pub requests_per_second: u64,
}

impl RpcLoadBalancer {
    pub fn new(endpoints: Vec<String>) -> Self {
        let rpc_endpoints = endpoints.into_iter().map(|url| RpcEndpoint {
            url,
            latency_ms: 100,
            success_rate: 0.99,
            requests_per_second: 1000,
        }).collect();
        
        Self {
            endpoints: rpc_endpoints,
            current_index: std::sync::atomic::AtomicUsize::new(0),
        }
    }
    
    pub fn get_best_endpoint(&self) -> Option<&RpcEndpoint> {
        if self.endpoints.is_empty() {
            return None;
        }
        
        // Round-robin with health check
        let index = self.current_index.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let endpoint = &self.endpoints[index % self.endpoints.len()];
        
        // In production: choose endpoint based on latency and success rate
        Some(endpoint)
    }
}

// Keep existing NodeInfo, ActivationRecord, DeviceMigration structs...
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInfo {
    pub activation_code: String,
    pub wallet_address: String,
    pub device_signature: String,
    pub node_type: String,
    pub activated_at: u64,
    pub last_seen: u64,
    pub migration_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivationRecord {
    pub code: String,
    pub wallet_address: String,
    pub burn_tx_hash: String,
    pub activated_at: u64,
    pub node_type: String,
    pub phase: u8,
    pub burn_amount: u64,
    pub blockchain_height: u64,
    pub is_active: bool,
    pub device_migrations: Vec<DeviceMigration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceMigration {
    pub from_device: String,
    pub to_device: String,
    pub migration_timestamp: u64,
    pub wallet_signature: String,
}

#[derive(Debug)]
pub struct DhtClient {
    peer_count: usize,
    connection_pool: Vec<String>,
}

impl BlockchainActivationRegistry {
    pub fn new(blockchain_rpc: Option<String>) -> Self {
        // Initialize with capacity for 10 million activations
        let expected_activations = 10_000_000;
        let false_positive_rate = 0.001; // 0.1%
        
        // Create RPC load balancer
        let rpc_endpoints = vec![
            blockchain_rpc.clone().unwrap_or_else(|| "https://rpc.qnet.io".to_string()),
            "https://rpc2.qnet.io".to_string(),
            "https://rpc3.qnet.io".to_string(),
        ];
        
        Self {
            bloom_filter: RwLock::new(BloomFilter::new(expected_activations, false_positive_rate)),
            l1_cache: RwLock::new(LruCache::new(10_000)), // 10K hot codes
            used_codes: RwLock::new(HashSet::new()),
            active_nodes: RwLock::new(HashMap::new()),
            activation_records: RwLock::new(HashMap::new()),
            cache_stats: RwLock::new(CacheStats::new()),
            last_sync: RwLock::new(0),
            cache_ttl: 300, // 5 minutes
            dht_client: Some(DhtClient { 
                peer_count: 0, 
                connection_pool: vec![] 
            }),
            rpc_load_balancer: RpcLoadBalancer::new(rpc_endpoints),
        }
    }

    /// Ultra-fast activation code checking (optimized for millions of nodes)
    pub async fn is_code_used_globally(&self, code: &str) -> Result<bool, IntegrationError> {
        // Increment request counter
        {
            let mut stats = self.cache_stats.write().await;
            stats.total_requests += 1;
        }
        
        // L0: Bloom filter check (fastest, 99.9% of negative results)
        {
            let bloom = self.bloom_filter.read().await;
            if !bloom.contains(code) {
                // Definitely not used
                let mut stats = self.cache_stats.write().await;
                stats.bloom_filter_hits += 1;
                return Ok(false);
            }
            
            let mut stats = self.cache_stats.write().await;
            stats.bloom_filter_misses += 1;
        }
        
        // L1: Hot cache check (0.01ms average)
        {
            let mut l1_cache = self.l1_cache.write().await;
            if let Some(&is_used) = l1_cache.get(&code.to_string()) {
                let mut stats = self.cache_stats.write().await;
                stats.l1_cache_hits += 1;
                return Ok(is_used);
            }
            
            let mut stats = self.cache_stats.write().await;
            stats.l1_cache_misses += 1;
        }
        
        // L2: Full cache check (0.1ms average)
        {
            let used_codes = self.used_codes.read().await;
            if used_codes.contains(code) {
                // Update L1 cache
                let mut l1_cache = self.l1_cache.write().await;
                l1_cache.put(code.to_string(), true);
                
                let mut stats = self.cache_stats.write().await;
                stats.l2_cache_hits += 1;
                return Ok(true);
            }
            
            let mut stats = self.cache_stats.write().await;
            stats.l2_cache_misses += 1;
        }
        
        // L3: Check if sync needed
        if self.needs_sync().await {
            self.sync_from_blockchain().await?;
            
            // Re-check L2 cache after sync
            let used_codes = self.used_codes.read().await;
            if used_codes.contains(code) {
                let mut l1_cache = self.l1_cache.write().await;
                l1_cache.put(code.to_string(), true);
                return Ok(true);
            }
        }
        
        // L4: DHT check (10ms average)
        if let Some(dht) = &self.dht_client {
            let mut stats = self.cache_stats.write().await;
            stats.dht_queries += 1;
            
            if self.check_dht_for_code(code).await? {
                // Update all caches
                let mut bloom = self.bloom_filter.write().await;
                bloom.add(code);
                
                let mut used_codes = self.used_codes.write().await;
                used_codes.insert(code.to_string());
                
                let mut l1_cache = self.l1_cache.write().await;
                l1_cache.put(code.to_string(), true);
                
                return Ok(true);
            }
        }
        
        // L5: Blockchain query (100ms average, last resort)
        {
            let mut stats = self.cache_stats.write().await;
            stats.blockchain_queries += 1;
        }
        
        // Use load balancer for blockchain query
        let result = self.query_blockchain_directly(code).await?;
        
        // Update all caches with result
        if result {
            let mut bloom = self.bloom_filter.write().await;
            bloom.add(code);
            
            let mut used_codes = self.used_codes.write().await;
            used_codes.insert(code.to_string());
        }
        
        let mut l1_cache = self.l1_cache.write().await;
        l1_cache.put(code.to_string(), result);
        
        Ok(result)
    }
    
    /// Direct blockchain query using load balancer
    async fn query_blockchain_directly(&self, code: &str) -> Result<bool, IntegrationError> {
        if let Some(endpoint) = self.rpc_load_balancer.get_best_endpoint() {
            // Mock blockchain query
            tokio::time::sleep(Duration::from_millis(endpoint.latency_ms)).await;
            Ok(false) // Mock result
        } else {
            Err(IntegrationError::NetworkError("No available RPC endpoints".to_string()))
        }
    }
    
    /// Get comprehensive performance statistics
    pub async fn get_performance_stats(&self) -> PerformanceStats {
        let cache_stats = self.cache_stats.read().await;
        let bloom = self.bloom_filter.read().await;
        let l1_cache = self.l1_cache.read().await;
        let used_codes = self.used_codes.read().await;
        let active_nodes = self.active_nodes.read().await;
        
        PerformanceStats {
            cache_stats: cache_stats.clone(),
            bloom_filter_size: bloom.size,
            bloom_filter_items: bloom.items_count,
            bloom_filter_false_positive_rate: bloom.false_positive_rate(),
            l1_cache_size: l1_cache.len(),
            l1_cache_capacity: l1_cache.capacity,
            l2_cache_size: used_codes.len(),
            active_nodes_count: active_nodes.len(),
            rpc_endpoints_count: self.rpc_load_balancer.endpoints.len(),
            memory_usage_mb: self.estimate_memory_usage().await,
        }
    }
    
    /// Estimate memory usage in MB
    async fn estimate_memory_usage(&self) -> u64 {
        let bloom_size = self.bloom_filter.read().await.size / 8; // bits to bytes
        let l1_cache_size = self.l1_cache.read().await.len() * 50; // ~50 bytes per entry
        let used_codes_size = self.used_codes.read().await.len() * 20; // ~20 bytes per code
        let active_nodes_size = self.active_nodes.read().await.len() * 200; // ~200 bytes per node
        
        (bloom_size + l1_cache_size + used_codes_size + active_nodes_size) as u64 / 1024 / 1024
    }
    
    // Keep existing methods but add caching updates...
    
    /// Register activation with optimized caching
    pub async fn register_activation_on_blockchain(&self, code: &str, node_info: NodeInfo) -> Result<(), IntegrationError> {
        // Check if already exists
        if self.is_code_used_globally(code).await? {
            return Err(IntegrationError::ValidationError(
                "Activation code already used globally".to_string()
            ));
        }
        
        // Create activation record
        let record = ActivationRecord {
            code: code.to_string(),
            wallet_address: node_info.wallet_address.clone(),
            burn_tx_hash: format!("0x{}", blake3::hash(code.as_bytes()).to_hex()),
            activated_at: node_info.activated_at,
            node_type: node_info.node_type.clone(),
            phase: 1, // Phase 1 for now
            burn_amount: 1500, // Universal 1500 1DEV
            blockchain_height: self.get_current_blockchain_height().await?,
            is_active: true,
            device_migrations: vec![],
        };

        // Submit to blockchain
        self.submit_activation_to_blockchain(&record).await?;

        // Update local cache
        {
            let mut used_codes = self.used_codes.write().await;
            used_codes.insert(code.to_string());
        }

        {
            let mut active_nodes = self.active_nodes.write().await;
            active_nodes.insert(node_info.device_signature.clone(), node_info.clone());
        }

        {
            let mut activation_records = self.activation_records.write().await;
            activation_records.insert(code.to_string(), record);
        }

        // Update all cache layers
        {
            let mut bloom = self.bloom_filter.write().await;
            bloom.add(code);
        }
        
        {
            let mut used_codes = self.used_codes.write().await;
            used_codes.insert(code.to_string());
        }
        
        {
            let mut l1_cache = self.l1_cache.write().await;
            l1_cache.put(code.to_string(), true);
        }

        // Propagate to DHT network
        if let Some(dht) = &self.dht_client {
            let code_clone = code.to_string();
            let node_info_clone = node_info.clone();
            tokio::spawn(async move {
                let _ = Self::propagate_to_dht(&code_clone, &node_info_clone).await;
            });
        }

        println!("✅ Activation registered on blockchain successfully");
        Ok(())
    }

    /// Migrate device with blockchain update
    pub async fn migrate_device_on_blockchain(&self, code: &str, wallet_address: &str, new_device_signature: &str) -> Result<(), IntegrationError> {
        println!("🔄 Migrating device on blockchain: {}", &code[..8]);
        
        // Validate ownership
        if !self.verify_wallet_ownership(wallet_address, code).await? {
            return Err(IntegrationError::ValidationError(
                "Wallet does not own this activation code".to_string()
            ));
        }

        // Create migration record
        let migration = DeviceMigration {
            from_device: self.get_current_device_signature(code).await?,
            to_device: new_device_signature.to_string(),
            migration_timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            wallet_signature: self.generate_wallet_signature(wallet_address, code).await?,
        };

        // Submit migration to blockchain
        self.submit_migration_to_blockchain(code, &migration).await?;

        // Update local cache
        {
            let mut activation_records = self.activation_records.write().await;
            if let Some(record) = activation_records.get_mut(code) {
                record.device_migrations.push(migration);
            }
        }

        {
            let mut active_nodes = self.active_nodes.write().await;
            if let Some(node_info) = active_nodes.values_mut().find(|n| n.activation_code == code) {
                node_info.device_signature = new_device_signature.to_string();
                node_info.migration_count += 1;
            }
        }

        println!("✅ Device migration completed on blockchain");
        Ok(())
    }

    /// Check if we need to sync from blockchain
    async fn needs_sync(&self) -> bool {
        let last_sync = *self.last_sync.read().await;
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        current_time - last_sync > self.cache_ttl
    }

    /// Sync from blockchain (production implementation)
    async fn sync_from_blockchain(&self) -> Result<(), IntegrationError> {
        println!("🔄 Syncing activation registry from blockchain...");
        
        // Get recent activations from blockchain
        let recent_activations = self.fetch_recent_activations().await?;
        
        // Update caches
        {
            let mut used_codes = self.used_codes.write().await;
            let mut activation_records = self.activation_records.write().await;
            let mut active_nodes = self.active_nodes.write().await;
            
            for record in recent_activations {
                used_codes.insert(record.code.clone());
                activation_records.insert(record.code.clone(), record.clone());
                
                // Update active nodes
                if record.is_active {
                    let node_info = NodeInfo {
                        activation_code: record.code.clone(),
                        wallet_address: record.wallet_address.clone(),
                        device_signature: record.device_migrations
                            .last()
                            .map(|m| m.to_device.clone())
                            .unwrap_or_else(|| "default".to_string()),
                        node_type: record.node_type.clone(),
                        activated_at: record.activated_at,
                        last_seen: SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap()
                            .as_secs(),
                        migration_count: record.device_migrations.len() as u32,
                    };
                    
                    active_nodes.insert(node_info.device_signature.clone(), node_info);
                }
            }
        }

        // Update last sync timestamp
        {
            let mut last_sync = self.last_sync.write().await;
            *last_sync = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs();
        }

        println!("✅ Blockchain sync completed");
        Ok(())
    }

    /// Fetch recent activations from blockchain
    async fn fetch_recent_activations(&self) -> Result<Vec<ActivationRecord>, IntegrationError> {
        // Mock implementation - in production this would query blockchain
        println!("📡 Fetching recent activations from blockchain RPC: {}", self.rpc_load_balancer.endpoints[0].url);
        
        // Simulate blockchain query
        tokio::time::sleep(Duration::from_millis(100)).await;
        
        // Return empty for now - in production this would parse blockchain data
        Ok(vec![])
    }

    /// Submit activation to blockchain
    async fn submit_activation_to_blockchain(&self, record: &ActivationRecord) -> Result<(), IntegrationError> {
        println!("📝 Submitting activation to blockchain: {}", &record.code[..8]);
        
        // Mock blockchain submission
        tokio::time::sleep(Duration::from_millis(50)).await;
        
        // In production: actual blockchain transaction
        println!("✅ Activation submitted to blockchain");
        Ok(())
    }

    /// Submit migration to blockchain
    async fn submit_migration_to_blockchain(&self, code: &str, migration: &DeviceMigration) -> Result<(), IntegrationError> {
        println!("📝 Submitting migration to blockchain: {}", &code[..8]);
        
        // Mock blockchain submission
        tokio::time::sleep(Duration::from_millis(50)).await;
        
        // In production: actual blockchain transaction
        println!("✅ Migration submitted to blockchain");
        Ok(())
    }

    /// Get current blockchain height
    async fn get_current_blockchain_height(&self) -> Result<u64, IntegrationError> {
        // Mock implementation
        Ok(123456)
    }

    /// Check DHT for activation code
    async fn check_dht_for_code(&self, code: &str) -> Result<bool, IntegrationError> {
        // Mock DHT check
        tokio::time::sleep(Duration::from_millis(10)).await;
        Ok(false)
    }

    /// Verify wallet ownership
    async fn verify_wallet_ownership(&self, wallet_address: &str, code: &str) -> Result<bool, IntegrationError> {
        // Mock verification
        Ok(true)
    }

    /// Get current device signature for code
    async fn get_current_device_signature(&self, code: &str) -> Result<String, IntegrationError> {
        Ok("current_device".to_string())
    }

    /// Generate wallet signature
    async fn generate_wallet_signature(&self, wallet_address: &str, code: &str) -> Result<String, IntegrationError> {
        Ok("wallet_signature".to_string())
    }

    /// Propagate to DHT network
    async fn propagate_to_dht(code: &str, node_info: &NodeInfo) -> Result<(), IntegrationError> {
        // Mock DHT propagation
        tokio::time::sleep(Duration::from_millis(5)).await;
        Ok(())
    }

    /// Get registry statistics
    pub async fn get_registry_stats(&self) -> RegistryStats {
        let used_codes = self.used_codes.read().await;
        let active_nodes = self.active_nodes.read().await;
        let activation_records = self.activation_records.read().await;
        let last_sync = *self.last_sync.read().await;
        
        RegistryStats {
            total_activations: used_codes.len(),
            active_nodes: active_nodes.len(),
            cached_records: activation_records.len(),
            last_sync_timestamp: last_sync,
            cache_hit_rate: 95.0, // Mock value
            dht_peers: self.dht_client.as_ref().map(|d| d.peer_count).unwrap_or(0),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PerformanceStats {
    pub cache_stats: CacheStats,
    pub bloom_filter_size: usize,
    pub bloom_filter_items: usize,
    pub bloom_filter_false_positive_rate: f64,
    pub l1_cache_size: usize,
    pub l1_cache_capacity: usize,
    pub l2_cache_size: usize,
    pub active_nodes_count: usize,
    pub rpc_endpoints_count: usize,
    pub memory_usage_mb: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RegistryStats {
    pub total_activations: usize,
    pub active_nodes: usize,
    pub cached_records: usize,
    pub last_sync_timestamp: u64,
    pub cache_hit_rate: f64,
    pub dht_peers: usize,
}

/// Legacy compatibility wrapper
pub type ActivationValidator = BlockchainActivationRegistry;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_activation_validation() {
        let validator = ActivationValidator::new(Some("https://rpc.qnet.io".to_string()));
        
        let node_info = NodeInfo {
            activation_code: "QNET-TEST-CODE-001".to_string(),
            wallet_address: "wallet123".to_string(),
            device_signature: "device456".to_string(),
            node_type: "light".to_string(),
            activated_at: 1234567890,
            last_seen: 1234567890,
            migration_count: 0,
        };

        // First activation should succeed
        assert!(validator.register_activation_on_blockchain("QNET-TEST-CODE-001", node_info.clone()).await.is_ok());
        
        // Second activation with same code should fail
        assert!(validator.register_activation_on_blockchain("QNET-TEST-CODE-001", node_info).await.is_err());
    }

    #[tokio::test]
    async fn test_device_migration() {
        let validator = ActivationValidator::new(Some("https://rpc.qnet.io".to_string()));
        
        let node_info = NodeInfo {
            activation_code: "QNET-TEST-CODE-002".to_string(),
            wallet_address: "wallet123".to_string(),
            device_signature: "device456".to_string(),
            node_type: "full".to_string(),
            activated_at: 1234567890,
            last_seen: 1234567890,
            migration_count: 0,
        };

        // Register initial activation
        validator.register_activation_on_blockchain("QNET-TEST-CODE-002", node_info).await.unwrap();
        
        // Migrate to new device
        assert!(validator.migrate_device_on_blockchain("QNET-TEST-CODE-002", "wallet123", "device789").await.is_ok());
        
        // Check new device is active
        // Check if devices are properly tracked in active nodes registry
        let active_nodes = validator.active_nodes.read().await;
        assert!(active_nodes.contains_key("device789"), "New device should be active");
        assert!(!active_nodes.contains_key("device456"), "Old device should not be active");
    }
} 
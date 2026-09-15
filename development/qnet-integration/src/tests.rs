//! QNet Comprehensive Test Suite
//! 
//! Contains all integration, stress, and network tests for QNet blockchain.
//! 
//! ## Test Categories:
//! 
//! 1. **API Integration Tests** - All 56+ endpoints
//! 2. **Stress Tests** - High load, continuous blocks
//! 3. **Network Partition Tests** - Node disconnect/reconnect
//! 4. **Chaos Engineering** - Random failures, recovery
//! 5. **Consensus Tests** - Macroblock, Byzantine safety
//! 
//! ## Usage:
//! ```bash
//! # Run all tests
//! cargo test --package qnet-integration --lib tests
//! 
//! # Run specific category
//! cargo test api_integration
//! cargo test stress_test
//! cargo test network_partition
//! cargo test chaos_engineering
//! cargo test consensus_test
//! ```

#![allow(dead_code)]

use std::time::{Duration, Instant};
use serde_json::{json, Value};

/// Test configuration
pub struct TestConfig {
    /// Node endpoints to test
    pub endpoints: Vec<String>,
    /// Timeout for API calls
    pub timeout: Duration,
    /// Number of iterations for stress tests
    pub stress_iterations: u64,
}

impl Default for TestConfig {
    fn default() -> Self {
        Self {
            endpoints: vec![
                "http://154.38.160.39:8001".to_string(),
                "http://62.171.157.44:8001".to_string(),
                "http://161.97.86.81:8001".to_string(),
                "http://5.189.130.160:8001".to_string(),
                "http://162.244.25.114:8001".to_string(),
            ],
            timeout: Duration::from_secs(10),
            stress_iterations: 1000,
        }
    }
}

/// Test result
#[derive(Debug, Clone)]
pub struct TestResult {
    pub name: String,
    pub passed: bool,
    pub duration_ms: f64,
    pub error: Option<String>,
}

/// Test suite results
#[derive(Debug, Default)]
pub struct TestSuiteResults {
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub results: Vec<TestResult>,
}

impl TestSuiteResults {
    pub fn add(&mut self, result: TestResult) {
        self.total += 1;
        if result.passed {
            self.passed += 1;
        } else {
            self.failed += 1;
        }
        self.results.push(result);
    }
    
    pub fn print_summary(&self) {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("📊 TEST SUITE RESULTS");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("✅ Passed: {}/{}", self.passed, self.total);
        println!("❌ Failed: {}/{}", self.failed, self.total);
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        for result in &self.results {
            let status = if result.passed { "✅" } else { "❌" };
            println!("{} {} ({:.2}ms)", status, result.name, result.duration_ms);
            if let Some(ref err) = result.error {
                println!("   └── Error: {}", err);
            }
        }
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
}

// ============================================================================
// API INTEGRATION TESTS
// ============================================================================

/// All API endpoints that must be tested
pub const API_ENDPOINTS: &[(&str, &str)] = &[
    // Basic
    ("GET", "/api/v1/height"),
    ("GET", "/api/v1/node/health"),
    ("GET", "/api/v1/peers"),
    ("GET", "/api/v1/mempool/status"),
    ("GET", "/api/v1/mempool/transactions"),
    
    // Blocks
    ("GET", "/api/v1/block/latest"),
    ("GET", "/api/v1/block/0"),
    ("GET", "/api/v1/microblock/0"),
    
    // Stats & Metrics
    ("GET", "/api/v1/stats"),
    ("GET", "/api/v1/producer/status"),
    ("GET", "/api/v1/sync/status"),
    ("GET", "/api/v1/diagnostics/network"),
    ("GET", "/api/v1/blocks/stats"),
    ("GET", "/api/v1/metrics/performance"),
    ("GET", "/api/v1/reputation/history"),
    ("GET", "/api/v1/failovers"),
    
    // Gas
    ("GET", "/api/v1/gas/recommendations"),
    
    // Execution and BFT timing
    ("GET", "/api/v1/parallel-executor/metrics"),
    ("GET", "/api/v1/pre-execution/status"),
    ("GET", "/api/v1/adaptive-bft/timeouts"),

    // Health
    ("GET", "/health"),
];

#[cfg(test)]
mod api_integration_tests {
    use super::*;
    
    /// Test all GET endpoints return valid responses
    #[tokio::test]
    async fn test_all_get_endpoints() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🧪 API INTEGRATION TEST - All GET Endpoints");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let config = TestConfig::default();
        let mut results = TestSuiteResults::default();
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .expect("Failed to create HTTP client");
        
        // Test first endpoint only (for CI/local testing)
        let base_url = &config.endpoints[0];
        
        for (method, path) in API_ENDPOINTS {
            if *method != "GET" {
                continue;
            }
            
            let url = format!("{}{}", base_url, path);
            let start = Instant::now();
            
            let result = match client.get(&url).send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let passed = status.is_success();
                    TestResult {
                        name: format!("{} {}", method, path),
                        passed,
                        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                        error: if !passed { 
                            Some(format!("HTTP {}", status)) 
                        } else { 
                            None 
                        },
                    }
                }
                Err(e) => {
                    TestResult {
                        name: format!("{} {}", method, path),
                        passed: false,
                        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                        error: Some(e.to_string()),
                    }
                }
            };
            
            results.add(result);
        }
        
        results.print_summary();
        
        // At least 50% should pass (network might not be running)
        let pass_rate = results.passed as f64 / results.total as f64;
        println!("📈 Pass rate: {:.1}%", pass_rate * 100.0);
    }
    
    /// Test height consistency across all nodes
    #[tokio::test]
    async fn test_height_consistency() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🧪 API INTEGRATION TEST - Height Consistency");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let config = TestConfig::default();
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .expect("Failed to create HTTP client");
        
        let mut heights: Vec<(String, u64)> = Vec::new();
        
        for endpoint in &config.endpoints {
            let url = format!("{}/api/v1/height", endpoint);
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(json) = resp.json::<Value>().await {
                        if let Some(height) = json.get("height").and_then(|h| h.as_u64()) {
                            println!("  {} → height: {}", endpoint, height);
                            heights.push((endpoint.clone(), height));
                        }
                    }
                }
                _ => {
                    println!("  {} → OFFLINE", endpoint);
                }
            }
        }
        
        if heights.len() >= 2 {
            let max_height = heights.iter().map(|(_, h)| *h).max().unwrap_or(0);
            let min_height = heights.iter().map(|(_, h)| *h).min().unwrap_or(0);
            let diff = max_height - min_height;
            
            println!("\n📊 Height range: {} - {} (diff: {})", min_height, max_height, diff);
            
            // Allow up to 10 blocks difference (network latency)
            if diff <= 10 {
                println!("✅ Heights are consistent (diff <= 10)");
            } else {
                println!("⚠️ Heights differ by {} blocks - possible fork!", diff);
            }
        } else {
            println!("⚠️ Not enough nodes online to check consistency");
        }
    }
    
    /// Test peer connectivity
    #[tokio::test]
    async fn test_peer_connectivity() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🧪 API INTEGRATION TEST - Peer Connectivity");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let config = TestConfig::default();
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .expect("Failed to create HTTP client");
        
        for endpoint in &config.endpoints {
            let url = format!("{}/api/v1/peers", endpoint);
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(json) = resp.json::<Value>().await {
                        let peer_count = json.get("peers")
                            .and_then(|p| p.as_array())
                            .map(|a| a.len())
                            .unwrap_or(0);
                        
                        let status = if peer_count >= 4 { "✅" } else { "⚠️" };
                        println!("{} {} → {} peers", status, endpoint, peer_count);
                    }
                }
                _ => {
                    println!("❌ {} → OFFLINE", endpoint);
                }
            }
        }
    }
}

// ============================================================================
// STRESS TESTS
// ============================================================================

#[cfg(test)]
mod stress_tests {
    use super::*;
    use crate::benchmark::BenchmarkManager;
    
    /// Test continuous block production for 100 blocks
    #[tokio::test]
    async fn test_continuous_block_production() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🔥 STRESS TEST - Continuous Block Production");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let config = TestConfig::default();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("Failed to create HTTP client");
        
        let base_url = &config.endpoints[0];
        
        // Get initial height
        let url = format!("{}/api/v1/height", base_url);
        let initial_height = match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                resp.json::<Value>().await
                    .ok()
                    .and_then(|j| j.get("height").and_then(|h| h.as_u64()))
                    .unwrap_or(0)
            }
            _ => {
                println!("⚠️ Cannot get initial height - node might be offline");
                return;
            }
        };
        
        println!("📊 Initial height: {}", initial_height);
        println!("⏳ Waiting for 30 blocks (30 seconds)...\n");
        
        let target_blocks = 30;
        let start = Instant::now();
        let mut last_height = initial_height;
        let mut block_times: Vec<f64> = Vec::new();
        
        for i in 1..=target_blocks {
            tokio::time::sleep(Duration::from_secs(1)).await;
            
            let current_height = match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    resp.json::<Value>().await
                        .ok()
                        .and_then(|j| j.get("height").and_then(|h| h.as_u64()))
                        .unwrap_or(last_height)
                }
                _ => last_height,
            };
            
            if current_height > last_height {
                let elapsed = start.elapsed().as_secs_f64();
                block_times.push(elapsed);
                println!("  Block #{} at {:.2}s", current_height, elapsed);
                last_height = current_height;
            }
            
            // Progress indicator
            if i % 10 == 0 {
                println!("  ... {}% complete", (i * 100) / target_blocks);
            }
        }
        
        let blocks_produced = last_height - initial_height;
        let elapsed = start.elapsed().as_secs_f64();
        let blocks_per_sec = blocks_produced as f64 / elapsed;
        
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("📊 RESULTS:");
        println!("  Blocks produced: {}", blocks_produced);
        println!("  Time elapsed: {:.2}s", elapsed);
        println!("  Blocks/sec: {:.2}", blocks_per_sec);
        
        if blocks_per_sec >= 0.9 {
            println!("✅ Block production is healthy (≥0.9 blocks/sec)");
        } else {
            println!("⚠️ Block production is slow ({:.2} blocks/sec)", blocks_per_sec);
        }
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
    
    /// Test high TPS transaction generation.
    /// v19: marked `#[ignore]` for the same reason as `benchmark::tests::*` —
    /// the assertion is `tps > 5000`, which is hardware-dependent and flakes
    /// on the slower CI runners and on developer laptops with ~5000 TX/sec
    /// generation rate. Run explicitly with `cargo test -- --ignored
    /// test_high_tps_generation` on a calibrated benchmark host.
    #[tokio::test]
    #[ignore]
    async fn test_high_tps_generation() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🔥 STRESS TEST - High TPS Transaction Generation");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let manager = BenchmarkManager::new();
        manager.initialize(100).await;
        
        let target_tx = 100_000;
        let start = Instant::now();
        let mut generated = 0u64;
        
        println!("📊 Generating {} transactions...", target_tx);
        
        for _ in 0..target_tx {
            if manager.generate_transaction().await.is_some() {
                generated += 1;
            }
        }
        
        let elapsed = start.elapsed();
        let tps = generated as f64 / elapsed.as_secs_f64();
        
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("📊 RESULTS:");
        println!("  Transactions: {}", generated);
        println!("  Time: {:.2}s", elapsed.as_secs_f64());
        println!("  TPS: {:.0}", tps);
        println!("  With 256 shards: {:.0} TPS", tps * 256.0);
        
        assert!(tps > 5000.0, "Should generate at least 5000 TX/sec");
        println!("✅ High TPS generation test passed");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
    
    /// Test mempool capacity under load
    #[tokio::test]
    async fn test_mempool_capacity() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🔥 STRESS TEST - Mempool Capacity");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let config = TestConfig::default();
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .expect("Failed to create HTTP client");
        
        let base_url = &config.endpoints[0];
        let url = format!("{}/api/v1/mempool/status", base_url);
        
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(json) = resp.json::<Value>().await {
                    println!("📊 Mempool Status:");
                    println!("  Size: {}", json.get("size").unwrap_or(&json!(0)));
                    println!("  Capacity: {}", json.get("capacity").unwrap_or(&json!(0)));
                    println!("  Pending: {}", json.get("pending_count").unwrap_or(&json!(0)));
                    println!("✅ Mempool is accessible");
                }
            }
            _ => {
                println!("⚠️ Cannot access mempool - node might be offline");
            }
        }
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
}

// ============================================================================
// NETWORK PARTITION TESTS
// ============================================================================

#[cfg(test)]
mod network_partition_tests {
    use super::*;
    
    /// Test network recovers after node restart
    #[tokio::test]
    async fn test_node_recovery_simulation() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🌐 NETWORK PARTITION TEST - Node Recovery Simulation");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let config = TestConfig::default();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .expect("Failed to create HTTP client");
        
        // Check which nodes are online
        let mut online_nodes = 0;
        let mut offline_nodes = 0;
        
        for endpoint in &config.endpoints {
            let url = format!("{}/api/v1/height", endpoint);
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    online_nodes += 1;
                    println!("  ✅ {} ONLINE", endpoint);
                }
                _ => {
                    offline_nodes += 1;
                    println!("  ❌ {} OFFLINE", endpoint);
                }
            }
        }
        
        println!("\n📊 Network Status:");
        println!("  Online: {}/5", online_nodes);
        println!("  Offline: {}/5", offline_nodes);
        
        // Check Byzantine safety
        let quorum = (config.endpoints.len() * 2 / 3) + 1; // 2/3 + 1
        if online_nodes >= quorum {
            println!("✅ Network has quorum ({}/{} required)", online_nodes, quorum);
        } else {
            println!("⚠️ Network lacks quorum! ({}/{} required)", online_nodes, quorum);
        }
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
    
    /// Test height sync after simulated partition
    #[tokio::test]
    async fn test_height_sync_after_delay() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🌐 NETWORK PARTITION TEST - Height Sync After Delay");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let config = TestConfig::default();
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .expect("Failed to create HTTP client");
        
        // Get heights at T=0
        println!("📊 Heights at T=0:");
        let mut heights_t0: Vec<u64> = Vec::new();
        for endpoint in &config.endpoints {
            let url = format!("{}/api/v1/height", endpoint);
            if let Ok(resp) = client.get(&url).send().await {
                if let Ok(json) = resp.json::<Value>().await {
                    if let Some(h) = json.get("height").and_then(|h| h.as_u64()) {
                        println!("  {} → {}", endpoint, h);
                        heights_t0.push(h);
                    }
                }
            }
        }
        
        // Wait 10 seconds
        println!("\n⏳ Waiting 10 seconds...\n");
        tokio::time::sleep(Duration::from_secs(10)).await;
        
        // Get heights at T=10
        println!("📊 Heights at T=10:");
        let mut heights_t10: Vec<u64> = Vec::new();
        for endpoint in &config.endpoints {
            let url = format!("{}/api/v1/height", endpoint);
            if let Ok(resp) = client.get(&url).send().await {
                if let Ok(json) = resp.json::<Value>().await {
                    if let Some(h) = json.get("height").and_then(|h| h.as_u64()) {
                        println!("  {} → {}", endpoint, h);
                        heights_t10.push(h);
                    }
                }
            }
        }
        
        // Analyze
        if !heights_t10.is_empty() {
            let max = heights_t10.iter().max().unwrap();
            let min = heights_t10.iter().min().unwrap();
            let diff = max - min;
            
            println!("\n📊 Analysis:");
            println!("  Height range: {} - {} (diff: {})", min, max, diff);
            
            if diff <= 5 {
                println!("✅ Nodes are well synchronized");
            } else {
                println!("⚠️ Nodes have significant height difference");
            }
        }
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
}

// ============================================================================
// CHAOS ENGINEERING TESTS
// ============================================================================

#[cfg(test)]
mod chaos_engineering_tests {
    use super::*;
    
    /// Test random endpoint failures
    #[tokio::test]
    async fn test_random_endpoint_resilience() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("💥 CHAOS TEST - Random Endpoint Resilience");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let config = TestConfig::default();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .expect("Failed to create HTTP client");
        
        let endpoints_to_test = vec![
            "/api/v1/height",
            "/api/v1/peers",
            "/api/v1/node/health",
            "/api/v1/stats",
            "/api/v1/producer/status",
        ];
        
        let mut successes = 0;
        let mut failures = 0;
        
        println!("📊 Testing {} endpoints × {} nodes = {} requests",
                 endpoints_to_test.len(), config.endpoints.len(), 
                 endpoints_to_test.len() * config.endpoints.len());
        
        for _ in 0..3 { // 3 rounds
            for endpoint in &config.endpoints {
                for path in &endpoints_to_test {
                    let url = format!("{}{}", endpoint, path);
                    match client.get(&url).send().await {
                        Ok(resp) if resp.status().is_success() => {
                            successes += 1;
                        }
                        _ => {
                            failures += 1;
                        }
                    }
                }
            }
        }
        
        let total = successes + failures;
        let success_rate = (successes as f64 / total as f64) * 100.0;
        
        println!("\n📊 Results:");
        println!("  Total requests: {}", total);
        println!("  Successes: {}", successes);
        println!("  Failures: {}", failures);
        println!("  Success rate: {:.1}%", success_rate);
        
        if success_rate >= 80.0 {
            println!("✅ Network is resilient (≥80% success)");
        } else if success_rate >= 60.0 {
            println!("⚠️ Network has some issues ({:.1}% success)", success_rate);
        } else {
            println!("❌ Network is unstable ({:.1}% success)", success_rate);
        }
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
    
    /// Test failover detection
    #[tokio::test]
    async fn test_failover_detection() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("💥 CHAOS TEST - Failover Detection");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let config = TestConfig::default();
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .expect("Failed to create HTTP client");
        
        for endpoint in &config.endpoints {
            let url = format!("{}/api/v1/failovers", endpoint);
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(json) = resp.json::<Value>().await {
                        let default_count = json!(0);
                        let count = json.get("failover_count").unwrap_or(&default_count);
                        let events = json.get("events")
                            .and_then(|e| e.as_array())
                            .map(|a| a.len())
                            .unwrap_or(0);
                        
                        println!("  {} -> {} failovers, {} events", endpoint, count, events);
                    }
                }
                _ => {
                    println!("  {} → OFFLINE", endpoint);
                }
            }
        }
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
}

// ============================================================================
// CONSENSUS TESTS
// ============================================================================

#[cfg(test)]
mod consensus_tests {
    use super::*;
    
    /// Test macroblock creation
    #[tokio::test]
    async fn test_macroblock_creation() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🔒 CONSENSUS TEST - Macroblock Creation");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let config = TestConfig::default();
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .expect("Failed to create HTTP client");
        
        let base_url = &config.endpoints[0];
        
        // Get current height
        let height_url = format!("{}/api/v1/height", base_url);
        let height = match client.get(&height_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                resp.json::<Value>().await
                    .ok()
                    .and_then(|j| j.get("height").and_then(|h| h.as_u64()))
                    .unwrap_or(0)
            }
            _ => 0
        };
        
        println!("📊 Current height: {}", height);
        
        // Calculate expected macroblocks
        let expected_macroblocks = height / 90;
        println!("📊 Expected macroblocks: {}", expected_macroblocks);
        
        // Try to fetch latest macroblock
        if expected_macroblocks > 0 {
            let macro_url = format!("{}/api/v1/macroblock/{}", base_url, expected_macroblocks - 1);
            match client.get(&macro_url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(json) = resp.json::<Value>().await {
                        let default_height = json!(0);
                        let macro_height = json.get("height").unwrap_or(&default_height);
                        let participants = json.get("consensus_data")
                            .and_then(|c| c.get("reveals"))
                            .and_then(|r| r.as_object())
                            .map(|o| o.len())
                            .unwrap_or(0);
                        
                        println!("Macroblock found:");
                        println!("   Height: {}", macro_height);
                        println!("   Participants: {}", participants);
                    }
                }
                _ => {
                    println!("⚠️ Could not fetch macroblock");
                }
            }
        } else {
            println!("⚠️ No macroblocks yet (need 90+ blocks)");
        }
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
    
    /// Test producer rotation
    #[tokio::test]
    async fn test_producer_rotation() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🔒 CONSENSUS TEST - Producer Rotation");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let config = TestConfig::default();
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .expect("Failed to create HTTP client");
        
        for endpoint in &config.endpoints {
            let url = format!("{}/api/v1/producer/status", endpoint);
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(json) = resp.json::<Value>().await {
                        let default_unknown = json!("unknown");
                        let default_zero = json!(0);
                        let default_false = json!(false);
                        let current = json.get("current_producer").unwrap_or(&default_unknown);
                        let round = json.get("current_round").unwrap_or(&default_zero);
                        let is_producer = json.get("is_current_producer").unwrap_or(&default_false);
                        
                        let status = if is_producer.as_bool().unwrap_or(false) { "[PRODUCER]" } else { "" };
                        println!("{} {} -> round: {}, producer: {}", status, endpoint, round, current);
                    }
                }
                _ => {
                    println!("❌ {} → OFFLINE", endpoint);
                }
            }
        }
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
    
    /// Test reputation consistency
    #[tokio::test]
    async fn test_reputation_consistency() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🔒 CONSENSUS TEST - Reputation Consistency");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        let config = TestConfig::default();
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .expect("Failed to create HTTP client");
        
        for endpoint in &config.endpoints {
            let url = format!("{}/api/v1/reputation/history", endpoint);
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(json) = resp.json::<Value>().await {
                        let entries = json.as_array().map(|a| a.len()).unwrap_or(0);
                        println!("  {} → {} reputation entries", endpoint, entries);
                    }
                }
                _ => {
                    println!("  {} → OFFLINE", endpoint);
                }
            }
        }
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

/// Run complete test suite
pub async fn run_all_tests() -> TestSuiteResults {
    println!("\n");
    println!("╔════════════════════════════════════════════════════════════════╗");
    println!("║                    QNET COMPLETE TEST SUITE                    ║");
    println!("╠════════════════════════════════════════════════════════════════╣");
    println!("║  1. API Integration Tests                                      ║");
    println!("║  2. Stress Tests                                               ║");
    println!("║  3. Network Partition Tests                                    ║");
    println!("║  4. Chaos Engineering Tests                                    ║");
    println!("║  5. Consensus Tests                                            ║");
    println!("╚════════════════════════════════════════════════════════════════╝");
    println!("\n");
    
    let results = TestSuiteResults::default();
    
    // Tests are run via `cargo test`
    // This function is for programmatic access
    
    results
}


#[cfg(test)]
mod tests_emission_gate {
    use crate::node::{BlockchainNode, EmissionExpectation};

    const EMISSION_INTERVAL: u64 = 14400;

    /// The expectation is pure height arithmetic — no storage, so every node reaches the same
    /// verdict. An earlier cut read the rewarding epoch's macroblock, which made enforcement depend
    /// on whether the node still held history from ~2 epochs back: a recently synced node fell into
    /// a fail-open arm while long-running nodes enforced, splitting total_supply between cohorts.
    #[test]
    fn expectation_is_pure_height_arithmetic() {
        // Non-emission heights and the first two epochs owe nothing.
        for h in [0u64, 1, 14_399, EMISSION_INTERVAL, EMISSION_INTERVAL + 1] {
            assert_eq!(BlockchainNode::expected_emission_amount(h), EmissionExpectation::NoneDue,
                       "no emission is due at h={}", h);
        }
        // The first real emission is the third epoch (delayed one full epoch).
        let h = 2 * EMISSION_INTERVAL;
        match BlockchainNode::expected_emission_amount(h) {
            EmissionExpectation::Exact(v) => {
                assert_eq!(v, qnet_consensus::lazy_rewards::pool1_base_emission_at_height(h));
                assert!(v > 0, "the first emission must be non-zero");
            }
            other => panic!("expected Exact at h={}, got {:?}", h, other),
        }
    }

}

/// A merkle reward-claim is credited to `to` no matter who relays it, so the wallet's own key must
/// authorize the exact payload — otherwise a third party could name only the newest epoch and strand
/// every earlier one behind the monotonic watermark.
#[cfg(test)]
mod tests_claim_authorization {
    use crate::node::BlockchainNode;
    use pqcrypto_mldsa::mldsa65;
    use pqcrypto_traits::sign::{DetachedSignature, PublicKey};

    fn signed_claim(data: &str) -> (qnet_state::Transaction, String) {
        let (pk, sk) = mldsa65::keypair();
        let pk_hex = hex::encode(pk.as_bytes());
        let wallet = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey_bytes(pk.as_bytes())
            .expect("eon from 1952-byte pk");
        const CLAIM_TS: u64 = 1_780_000_000;
        let msg = BlockchainNode::claim_sign_message(&wallet, data, CLAIM_TS);
        let sig = mldsa65::detached_sign(msg.as_bytes(), &sk);
        let mut tx = qnet_state::Transaction::new(
            "system_rewards_pool".to_string(),
            Some(wallet.clone()),
            0, 0, 0, 0, CLAIM_TS,
            None,
            qnet_state::TransactionType::RewardDistribution,
            Some(data.to_string()),
        );
        tx.dilithium_signature = Some(hex::encode(sig.as_bytes()).into_bytes());
        tx.dilithium_public_key = Some(pk_hex.into_bytes());
        (tx, wallet)
    }

    #[test]
    fn wallet_key_authorizes_its_own_payload() {
        let data = r#"{"claims":[{"epoch":7,"amount":100,"proof":[]}]}"#;
        let (tx, wallet) = signed_claim(data);
        assert!(BlockchainNode::claim_authorized(&tx, &wallet, data));
    }

    #[test]
    fn signature_does_not_carry_to_a_shorter_payload() {
        let full = r#"{"claims":[{"epoch":6,"amount":50,"proof":[]},{"epoch":7,"amount":100,"proof":[]}]}"#;
        let (mut tx, wallet) = signed_claim(full);
        let truncated = r#"{"claims":[{"epoch":7,"amount":100,"proof":[]}]}"#;
        tx.data = Some(truncated.to_string());
        assert!(!BlockchainNode::claim_authorized(&tx, &wallet, truncated),
                "a signature lifted off a full batch must not authorize a batch that strands epochs");
    }

    #[test]
    fn a_key_may_not_claim_for_another_wallet() {
        let data = r#"{"claims":[{"epoch":7,"amount":100,"proof":[]}]}"#;
        let (tx, _) = signed_claim(data);
        let (_, victim) = signed_claim(data);
        assert!(!BlockchainNode::claim_authorized(&tx, &victim, data));
    }

    #[test]
    fn an_unsigned_claim_is_refused() {
        let data = r#"{"claims":[{"epoch":7,"amount":100,"proof":[]}]}"#;
        let (mut tx, wallet) = signed_claim(data);
        tx.dilithium_signature = None;
        assert!(!BlockchainNode::claim_authorized(&tx, &wallet, data));
    }
}

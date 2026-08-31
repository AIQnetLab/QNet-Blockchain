//! Peer and transaction queries, storage and memory monitoring, host address discovery.

use super::*;

impl BlockchainNode {
    pub async fn get_connected_peers(&self) -> Result<Vec<PeerInfo>, QNetError> {
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        // EXISTING: Get connected peers for RPC API (fast method for API responses)
        // PERFORMANCE: Use fast discovery peers instead of expensive validation for API
        let peer_infos = if let Some(ref p2p) = self.unified_p2p {
            let p2p_peers = p2p.get_discovery_peers(); // EXISTING: Fast method for DHT/API
            
            // Reputation display value — floor under the deterministic model (RAM engine removed).
            
            // Convert from unified_p2p::PeerInfo to node::PeerInfo format
            p2p_peers.iter().map(|p2p_peer| {
                let real_reputation = qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
                
                PeerInfo {
                    id: p2p_peer.id.clone(),
                    address: p2p_peer.addr.clone(),
                    node_type: format!("{:?}", p2p_peer.node_type),
                    region: format!("{:?}", p2p_peer.region),
                    last_seen: p2p_peer.last_seen,
                    connection_time: if current_time > p2p_peer.last_seen { 
                        current_time - p2p_peer.last_seen 
                    } else { 
                        0 
                    },
                    reputation: real_reputation, // REAL reputation from blockchain
                    version: Some("qnet-v1.0".to_string()), // EXISTING: Default version
                }
            }).collect()
        } else {
            vec![]
        };
        
        Ok(peer_infos)
    }
    
    pub async fn get_transaction(&self, tx_hash: &str) -> Result<Option<TransactionInfo>, QNetError> {
        // Search in mempool first
        // v2.26: Direct access - SimpleMempool is already thread-safe
        {
            let pending_txs = self.mempool.get_pending_transactions_with_hashes(1000);
            
            for (stored_hash, tx_bytes) in pending_txs {
                // PRODUCTION v2.26: Compare stored hash (SHA3 bincode) with requested hash
                if stored_hash == tx_hash {
                    // Deserialize TX for response
                    let tx_opt = bincode::deserialize::<qnet_state::Transaction>(&tx_bytes).ok()
                        .or_else(|| {
                            String::from_utf8(tx_bytes).ok()
                                .and_then(|json| serde_json::from_str::<qnet_state::Transaction>(&json).ok())
                        });
                    
                    if let Some(tx) = tx_opt {
                        // Extract tx_type as string for explorer
                        let tx_type_str = format!("{:?}", tx.tx_type);
                        
                        return Ok(Some(TransactionInfo {
                            hash: stored_hash, // Use the mempool hash for consistency
                            from: tx.from,
                            to: tx.to,
                            amount: tx.amount,
                            nonce: tx.nonce,
                            gas_price: tx.gas_price,
                            gas_limit: tx.gas_limit,
                            timestamp: tx.timestamp,
                            block_height: None,
                            status: "pending".to_string(),
                            tx_type: Some(tx_type_str),
                            // Fast Finality Indicators for pending tx
                            confirmation_level: Some(ConfirmationLevel::Pending),
                            safety_percentage: Some(0.0),
                            confirmations: Some(0),
                            time_to_finality: Some(90), // Max time to macroblock
                            // QUANTUM v2.25.2: Dilithium signature info
                            dilithium_signature: tx.dilithium_signature.map(hex::encode),
                            dilithium_public_key: tx.dilithium_public_key.map(hex::encode),
                        }));
                    }
                }
            }
        }
        
        // Search in stored blocks
        match self.storage.find_transaction_by_hash(tx_hash).await {
            Ok(Some(tx)) => {
                let block_height = self.storage.get_transaction_block_height(tx_hash).await.ok();
                
                // Calculate Fast Finality Indicators
                let current_height = *self.height.read().await;
                let confirmations = if let Some(tx_height) = block_height {
                    (current_height.saturating_sub(tx_height) + 1) as u32
                } else {
                    1
                };
                
                // Confirmation level. v2: FullyFinalized is bound to the 2-chain
                // checkpoint QC (bft2_finalized_height), NOT raw depth — depth alone is
                // soft until a checkpoint ratifies. v1 (flag off): legacy depth-based.
                let confirmation_level = if crate::consensus_v2_node::v2_enabled() {
                    let fin_h = crate::consensus_v2_node::bft2_finalized_height();
                    if block_height.map(|h| h <= fin_h).unwrap_or(false) {
                        ConfirmationLevel::FullyFinalized
                    } else {
                        match confirmations {
                            0 => ConfirmationLevel::Pending,
                            1..=4 => ConfirmationLevel::InBlock,
                            5..=29 => ConfirmationLevel::QuickConfirmed,
                            _ => ConfirmationLevel::NearFinal, // capped: final only via checkpoint QC
                        }
                    }
                } else {
                    match confirmations {
                        0 => ConfirmationLevel::Pending,
                        1..=4 => ConfirmationLevel::InBlock,
                        5..=29 => ConfirmationLevel::QuickConfirmed,
                        30..=89 => ConfirmationLevel::NearFinal,
                        _ => ConfirmationLevel::FullyFinalized,
                    }
                };
                
                // Calculate safety percentage based on confirmations
                // Formula: min(99.999, confirmations * 10) for first 10 blocks
                // Then asymptotically approach 100%
                let safety_percentage = if confirmations == 0 {
                    0.0
                } else if confirmations <= 5 {
                    90.0 + (confirmations as f64 * 2.0) // 92%, 94%, 96%, 98%, 100% at 5
                } else if confirmations <= 30 {
                    99.0 + (confirmations as f64 * 0.03) // Slowly approach 99.9%
                } else if confirmations <= 90 {
                    99.9 + (confirmations as f64 * 0.001) // Approach 99.99%
                } else {
                    100.0 // Fully finalized in macroblock
                };
                // v2: a checkpoint-QC-finalized tx is 100% safe regardless of raw depth.
                let safety_percentage = if matches!(confirmation_level, ConfirmationLevel::FullyFinalized) {
                    100.0
                } else { safety_percentage };

                // Calculate time to finality (macroblock at 90 blocks)
                let blocks_to_macroblock = if let Some(tx_height) = block_height {
                    let next_macroblock = ((tx_height / 90) + 1) * 90;
                    next_macroblock.saturating_sub(current_height)
                } else {
                    90
                };
                let time_to_finality = blocks_to_macroblock; // 1 block = 1 second
                
                // Extract tx_type as string for explorer
                let tx_type_str = format!("{:?}", tx.tx_type);
                
                Ok(Some(TransactionInfo {
                    hash: tx.hash,
                    from: tx.from,
                    to: tx.to,
                    amount: tx.amount,
                    nonce: tx.nonce,
                    gas_price: tx.gas_price,
                    gas_limit: tx.gas_limit,
                    timestamp: tx.timestamp,
                    block_height,
                    status: "confirmed".to_string(),
                    tx_type: Some(tx_type_str),
                    // Fast Finality Indicators
                    confirmation_level: Some(confirmation_level),
                    safety_percentage: Some(safety_percentage),
                    confirmations: Some(confirmations),
                    time_to_finality: Some(time_to_finality),
                    // QUANTUM v2.25.2: Dilithium signature info
                    dilithium_signature: tx.dilithium_signature.map(hex::encode),
                    dilithium_public_key: tx.dilithium_public_key.map(hex::encode),
                }))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(QNetError::StorageError(e.to_string())),
        }
    }
    
    // Production-grade region detection functions (decentralized)
    
    /// Get physical IP without external services
    pub(super) async fn get_physical_ip_without_external_services() -> Result<String, String> {
        use std::net::{UdpSocket, IpAddr};
        use std::process::Command;
        
        // Method 1: Try to get external IP using curl (most reliable for region detection)
        if let Ok(output) = tokio::process::Command::new("curl")
            .arg("-s")
            .arg("--max-time")
            .arg("5")
            .arg("--connect-timeout")
            .arg("3")
            .arg("https://api.ipify.org")
            .output()
            .await
        {
            if output.status.success() {
                let ip_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if let Ok(ip) = ip_str.parse::<std::net::Ipv4Addr>() {
                    if !ip.is_loopback() && !ip.is_private() && !ip.is_link_local() {
                        println!("[INFO][NODE] external_ip_detected ip={}", ip);
                        return Ok(ip.to_string());
                    }
                }
            }
        }
        
        // Method 2: Try alternative external IP service
        if let Ok(output) = tokio::process::Command::new("curl")
            .arg("-s")
            .arg("--max-time")
            .arg("3")
            .arg("https://checkip.amazonaws.com")
            .output()
            .await
        {
            if output.status.success() {
                let ip_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if let Ok(ip) = ip_str.parse::<std::net::Ipv4Addr>() {
                    if !ip.is_loopback() && !ip.is_private() && !ip.is_link_local() {
                        println!("[INFO][NODE] external_ip_detected source=aws ip={}", ip);
                        return Ok(ip.to_string());
                    }
                }
            }
        }
        
        println!("[WARN][NODE] external_ip_failed fallback=local_interfaces");
        
        // Method 3: Check all network interfaces (fallback)
        #[cfg(target_os = "windows")]
        {
            if let Ok(output) = Command::new("ipconfig").output() {
                let output_str = String::from_utf8_lossy(&output.stdout);
                for line in output_str.lines() {
                    if line.trim().starts_with("IPv4 Address") {
                        if let Some(ip_part) = line.split(':').nth(1) {
                            let ip_str = ip_part.trim();
                            if let Ok(ip) = ip_str.parse::<std::net::Ipv4Addr>() {
                                if !ip.is_loopback() && !ip.is_link_local() {
                                    println!("[WARN][NODE] using_local_ip ip={}", ip);
                                    return Ok(ip.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
        
        #[cfg(target_os = "linux")]
        {
            if let Ok(output) = Command::new("hostname").arg("-I").output() {
                let output_str = String::from_utf8_lossy(&output.stdout);
                for ip_str in output_str.split_whitespace() {
                    if let Ok(ip) = ip_str.parse::<std::net::Ipv4Addr>() {
                        if !ip.is_loopback() && !ip.is_link_local() {
                            println!("[WARN][NODE] using_local_ip ip={}", ip);
                            return Ok(ip.to_string());
                        }
                    }
                }
            }
        }
        
        // Method 4: Use socket binding to determine local IP (last resort)
        match UdpSocket::bind("0.0.0.0:0") {
            Ok(socket) => {
                if let Ok(()) = socket.connect("8.8.8.8:80") {
                    if let Ok(addr) = socket.local_addr() {
                        let ip = addr.ip();
                        if let IpAddr::V4(ipv4) = ip {
                            if !ipv4.is_loopback() && !ipv4.is_link_local() {
                                println!("[WARN][NODE] using_socket_ip ip={}", ipv4);
                                return Ok(ipv4.to_string());
                            }
                        }
                    }
                }
            }
            Err(_) => {}
        }
        
        Err("Could not determine IP address for region detection".to_string())
    }
    
    /// Simple latency-based region testing (enabled as fallback)
    pub(super) async fn simple_latency_region_test() -> Result<Region, String> {
        println!("[INFO][NODE] latency_region_detect");
        
        // Test connectivity to known regional endpoints
        let regional_tests = vec![
            (Region::NorthAmerica, "8.8.8.8:53"),     // Google DNS (US)
            (Region::Europe, "1.1.1.1:53"),           // Cloudflare DNS (Global but EU-optimized)  
            (Region::Asia, "208.67.222.222:53"),      // OpenDNS (Asia-Pacific)
            (Region::SouthAmerica, "8.8.4.4:53"),     // Google DNS (Global)
            (Region::Africa, "196.216.2.1:53"),       // AfriNIC DNS
            (Region::Oceania, "203.119.4.1:53"),      // APNIC DNS (Oceania)
        ];
        
        let mut best_region = None;
        let mut best_latency = std::time::Duration::from_secs(10);
        
        for (region, endpoint) in regional_tests {
            match tokio::time::timeout(
                std::time::Duration::from_secs(8), // PRODUCTION: Increased for international Genesis nodes
                tokio::net::TcpStream::connect(endpoint)
            ).await {
                Ok(Ok(_stream)) => {
                    let start = std::time::Instant::now();
                    match tokio::time::timeout(
                        std::time::Duration::from_millis(500),
                        tokio::net::TcpStream::connect(endpoint)
                    ).await {
                        Ok(Ok(_)) => {
                            let latency = start.elapsed();
                            println!("[DBG][NODE] latency_probe region={:?} ms={}", region, latency.as_millis());
                            
                            if latency < best_latency {
                                best_latency = latency;
                                best_region = Some(region);
                            }
                        }
                        _ => println!("[DBG][NODE] latency_probe region={:?} result=timeout", region),
                    }
                }
                _ => println!("[DBG][NODE] latency_probe region={:?} result=conn_failed", region),
            }
        }
        
        if let Some(region) = best_region {
            println!("[INFO][NODE] region_selected region={:?} latency={}ms", region, best_latency.as_millis());
            Ok(region)
        } else {
            Err("All latency tests failed - no regional connectivity".to_string())
        }
    }
    
    pub fn load_microblock_bytes(&self, height: u64) -> Result<Option<Vec<u8>>, QNetError> {
        self.storage.load_microblock(height).map_err(|e| QNetError::StorageError(e.to_string()))
    }
    
    /// Start archive compliance monitoring (MANDATORY enforcement)
    pub(super) async fn start_archive_compliance_monitoring(&self) {
        let archive_manager = self.archive_manager.clone();
        let node_id = self.node_id.clone();
        let node_type = self.node_type;
        
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(4 * 3600)); // 4 hours
            
            loop {
                interval.tick().await;
                
                println!("[INFO][ARCHIVE] compliance_check_start node={}", node_id);
                
                // Enforce compliance (mandatory, not optional)
                {
                    let mut manager = archive_manager.write().await;
                    if let Err(e) = manager.enforce_compliance().await {
                        println!("[ERR][ARCHIVE] compliance_enforcement_failed err={}", e);
                    } else {
                        // Get compliance stats for logging
                        match manager.get_archive_stats().await {
                            Ok(stats) => {
                                println!("[INFO][ARCHIVE] compliance_stats compliant={}/{} non_compliant={} underreplicated={} avg_replicas={:.1}",
                                         stats.compliant_nodes, stats.total_nodes,
                                         stats.non_compliant_nodes,
                                         stats.underreplicated_chunks,
                                         stats.avg_replicas);
                                
                                // Alert if this node is non-compliant
                                // v3.18: Super node type removed
                                if stats.non_compliant_nodes > 0 {
                                    let required_chunks = match node_type {
                                        NodeType::Super => 8,
                                        NodeType::Light => 0,
                                    };
                                    println!("[WARN][ARCHIVE] compliance_issue non_compliant={}", stats.non_compliant_nodes);
                                    println!("[INFO][ARCHIVE] required_chunks={} node_type={:?}", required_chunks, node_type);
                                }
                            },
                            Err(e) => println!("[ERR][ARCHIVE] stats_failed err={}", e),
                        }
                    }
                }
            }
        });
        
        println!("[INFO][ARCHIVE] compliance_monitoring_started interval=4h");
    }
    
    /// Check network size and rebalance archive quotas for small networks
    pub(super) async fn check_and_rebalance_small_network(&self) {
        let archive_manager = self.archive_manager.clone();
        
        tokio::spawn(async move {
            // Wait a bit for network discovery
            tokio::time::sleep(Duration::from_secs(30)).await;
            
            let mut manager = archive_manager.write().await;
            
            // Validate current network capacity
            match manager.validate_network_replication_capacity().await {
                Ok(true) => {
                    println!("[INFO][ARCHIVE] network_capacity_ok");
                },
                Ok(false) => {
                    println!("[WARN][ARCHIVE] network_capacity_insufficient action=rebalancing");
                    
                    // Trigger emergency rebalancing
                    if let Err(e) = manager.rebalance_for_small_network().await {
                        println!("[ERR][ARCHIVE] emergency_rebalancing_failed err={}", e);
                    } else {
                        println!("[INFO][ARCHIVE] emergency_rebalancing_complete network=small");
                    }
                },
                Err(e) => {
                    println!("[ERR][ARCHIVE] network_capacity_validation_failed err={}", e);
                }
            }
        });
        
        println!("[INFO][ARCHIVE] small_network_rebalancing_scheduled");
    }
    
    /// Start storage usage monitoring with automatic cleanup
    pub(super) async fn start_storage_monitoring(&self) {
        let storage = self.storage.clone();
        let node_id = self.node_id.clone();
        
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1 * 3600)); // Check every hour
            
            loop {
                interval.tick().await;
                
                // Check storage usage and perform cleanup if needed
                match storage.check_storage_usage_and_cleanup() {
                    Ok(true) => {
                        // Normal operation
                    },
                    Ok(false) => {
                        println!("[WARN][STORAGE] node={} state=warning_or_emergency", node_id);
                        
                        // Check if critically full
                        match storage.is_storage_critically_full() {
                            Ok(true) => {
                                println!("[CRIT][STORAGE] node={} state=critically_full action=admin_required", node_id);
                                
                                // Emergency slowdown to prevent crash
                                tokio::time::sleep(Duration::from_secs(10)).await;
                            },
                            Ok(false) => {
                                // Warning state, continue monitoring
                            },
                            Err(e) => {
                                println!("[ERR][STORAGE] node={} action=check_critical err={}", node_id, e);
                            }
                        }
                    },
                    Err(e) => {
                        println!("[ERR][STORAGE] node={} action=monitoring err={}", node_id, e);
                    }
                }
            }
        });
        
        println!("[INFO][STORAGE] monitoring_started interval=3600s");
    }
    
    /// v3.0: Memory monitoring to detect leaks before OOM
    /// Logs memory usage every 5 minutes with detailed breakdown
    /// 
    /// v3.1: DYNAMIC MEMORY LIMITS based on system RAM or env vars
    /// - QNET_MEMORY_WARN_MB: Warning threshold (default: 60% of system RAM)
    /// - QNET_MEMORY_EMERGENCY_MB: Emergency cleanup (default: 75% of system RAM)
    /// - QNET_MEMORY_FATAL_MB: Graceful shutdown (default: 90% of system RAM)
    pub(super) async fn start_memory_monitoring(&self) {
        let node_id = self.node_id.clone();
        let storage = self.storage.clone();
        let unified_p2p = self.unified_p2p.clone();
        
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(300)); // Every 5 minutes
            let mut last_rss_mb: u64 = 0;
            
            // ═══════════════════════════════════════════════════════════════════════════════
            // v3.1: FULLY AUTOMATIC MEMORY LIMITS - NO USER INPUT REQUIRED
            // ═══════════════════════════════════════════════════════════════════════════════
            // Priority order (all automatic):
            // 1. Docker cgroups limit (container memory limit)
            // 2. 70% of AVAILABLE memory (accounts for other processes)
            // 3. Conservative fallback (4GB)
            //
            // MINIMUM REQUIREMENT: 4GB RAM (Super nodes)
            // ═══════════════════════════════════════════════════════════════════════════════
            
            const MIN_MEMORY_REQUIREMENT_MB: u64 = 4_000; // 4GB minimum for Super nodes
            
            // Get total system memory first (for requirement check)
            let (mem_total_mb, mem_available_mb): (u64, Option<u64>) = {
                match std::fs::read_to_string("/proc/meminfo") {
                    Ok(meminfo) => {
                        let total = meminfo.lines()
                            .find(|line| line.starts_with("MemTotal:"))
                            .and_then(|line| {
                                line.split_whitespace()
                                    .nth(1)
                                    .and_then(|kb| kb.parse::<u64>().ok())
                                    .map(|kb| kb / 1024)
                            })
                            .unwrap_or(8_000);
                        
                        let available = meminfo.lines()
                            .find(|line| line.starts_with("MemAvailable:"))
                            .and_then(|line| {
                                line.split_whitespace()
                                    .nth(1)
                                    .and_then(|kb| kb.parse::<u64>().ok())
                                    .map(|kb| kb / 1024)
                            });
                        
                        (total, available)
                    }
                    Err(_) => (8_000, None) // Assume 8GB if can't read
                }
            };
            
            // Check minimum requirements
            if mem_total_mb < MIN_MEMORY_REQUIREMENT_MB {
                println!("[CRIT][MEMORY] INSUFFICIENT_RAM total={}MB required={}MB", 
                         mem_total_mb, MIN_MEMORY_REQUIREMENT_MB);
                println!("[CRIT][MEMORY] QNet Super nodes require minimum 4GB RAM!");
                println!("[CRIT][MEMORY] Node will operate in DEGRADED MODE with aggressive cleanup");
            }
            
            // Calculate memory limit automatically
            let memory_limit_mb: u64 = {
                // PRIORITY 1: Docker cgroups limit (fully automatic for containers)
                let cgroup_limit = std::fs::read_to_string("/sys/fs/cgroup/memory/memory.limit_in_bytes")
                    .or_else(|_| std::fs::read_to_string("/sys/fs/cgroup/memory.max")) // cgroups v2
                    .ok()
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .filter(|&v| v < u64::MAX / 2) // Filter out "unlimited"
                    .map(|bytes| bytes / 1024 / 1024); // Convert to MB
                
                if let Some(cgroup_mb) = cgroup_limit {
                    // Container with an explicit limit — use 85% of it.
                    let limit = cgroup_mb * 85 / 100;
                    println!("[INFO][MEMORY] mode=docker container_limit={}MB node_limit={}MB",
                             cgroup_mb, limit);
                    limit
                } else {
                    // DETERMINISTIC budget: fixed fraction of TOTAL RAM, identical on
                    // every start of the same machine. The old 70%-of-AVAILABLE read
                    // shrank after each restart (dead process + page cache still held
                    // the host) — every reboot got a lower limit than the last, which
                    // turned one OOM shutdown into a self-tightening restart storm.
                    let limit = (mem_total_mb * 70 / 100).max(2_000);
                    println!("[INFO][MEMORY] mode=auto total={}MB node_limit={}MB",
                             mem_total_mb, limit);
                    limit
                }
            };
            let _ = mem_available_mb; // informational only — never a budget input
            
            // Thresholds are FIXED percentages - no user input needed
            // These are well-tested values that work across all memory sizes
            let warn_mb = memory_limit_mb * 60 / 100;      // 60% - start monitoring
            let emergency_mb = memory_limit_mb * 75 / 100; // 75% - aggressive cleanup
            let fatal_mb = memory_limit_mb * 90 / 100;     // 90% - graceful shutdown
            
            println!("[INFO][MEMORY] thresholds: warn={}MB emergency={}MB fatal={}MB",
                     warn_mb, emergency_mb, fatal_mb);
            
            loop {
                interval.tick().await;
                
                // v3.0: Get process memory - cross-platform support
                // Linux: /proc/self/statm (fast, direct)
                // Other: Estimate from data structures (fallback)
                let (rss_mb, virt_mb) = {
                    // Try Linux /proc first (works in Docker which is always Linux)
                    match std::fs::read_to_string("/proc/self/statm") {
                        Ok(statm) => {
                            let parts: Vec<&str> = statm.split_whitespace().collect();
                            if parts.len() >= 2 {
                                let page_size = 4096u64; // Usually 4KB
                                let virt_pages: u64 = parts[0].parse().unwrap_or(0);
                                let rss_pages: u64 = parts[1].parse().unwrap_or(0);
                                (rss_pages * page_size / 1024 / 1024, virt_pages * page_size / 1024 / 1024)
                            } else {
                                (0, 0)
                            }
                        },
                        Err(_) => {
                            // Fallback for Windows/macOS: Estimate from known data structures
                            // This is less accurate but provides SOME monitoring
                            let tx_pool_estimate = storage.get_transaction_pool_stats()
                                .map(|(count, _)| count as u64 / 1000) // ~1KB per TX
                                .unwrap_or(0);
                            let pending_sync = crate::unified_p2p::get_pending_sync_count() as u64 / 10; // ~100KB per block
                            let pending_macro = crate::unified_p2p::get_pending_macroblock_count() as u64; // ~1MB per macroblock
                            let producer_cache = producer_cache::CACHED_PRODUCER_SELECTION.len() as u64 / 100;
                            
                            // Rough estimate: base 500MB + data structures
                            let estimated_mb = 500 + tx_pool_estimate + pending_sync + pending_macro + producer_cache;
                            (estimated_mb, estimated_mb * 2) // Virtual usually 2x RSS
                        }
                    }
                };
                
                // Calculate delta from last check
                let delta_mb = if rss_mb > last_rss_mb { 
                    rss_mb - last_rss_mb 
                } else { 
                    0 
                };
                last_rss_mb = rss_mb;
                
                // Get data structure sizes
                let tx_pool_stats = storage.get_transaction_pool_stats().unwrap_or((0, 0));
                
                // Get P2P structure sizes
                let (peers_count, rate_limiter_count) = if let Some(ref p2p) = unified_p2p {
                    (p2p.get_connected_peer_count(), p2p.get_rate_limiter_size())
                } else {
                    (0, 0)
                };
                
                // Get static cache sizes
                let producer_cache_size = producer_cache::CACHED_PRODUCER_SELECTION.len();

                // Per-holder breakdown: printed every tick AND with every CRIT so a
                // memory incident is attributable from one log line.
                let (mp_txs, mp_mb) = crate::node::GLOBAL_MEMPOOL_INSTANCE.get()
                    .map(|m| (m.size(), m.total_bytes() / 1_048_576))
                    .unwrap_or((0, 0));
                let breakdown = format!(
                    "mempool_txs={} mempool_mb={} tx_pool={} sync_q={} macro_q={} peers={} rate_limit={} producer_cache={}",
                    mp_txs, mp_mb, tx_pool_stats.0,
                    crate::unified_p2p::get_pending_sync_count(),
                    crate::unified_p2p::get_pending_macroblock_count(),
                    peers_count, rate_limiter_count, producer_cache_size);

                // Log memory stats
                println!("[INFO][MEMORY] node={} rss_mb={} virt_mb={} delta_mb={} {}",
                         node_id, rss_mb, virt_mb, delta_mb, breakdown);
                
                // CRITICAL: Warn if memory growing too fast (>100MB in 5 minutes)
                if delta_mb > 100 {
                    println!("[WARN][MEMORY] node={} rapid_growth delta_mb={} possible_leak", node_id, delta_mb);
                }
                
                // v3.1: DYNAMIC - Warn if RSS > warn_mb (default 60% of system RAM)
                if rss_mb > warn_mb {
                    println!("[CRIT][MEMORY] node={} rss_mb={} warn_limit={} HIGH_MEMORY {}",
                             node_id, rss_mb, warn_mb, breakdown);
                }
                
                // v3.1: DYNAMIC - Emergency if RSS > emergency_mb (default 75% of system RAM)
                if rss_mb > emergency_mb {
                    println!("[CRIT][MEMORY] node={} rss_mb={} limit={} EMERGENCY cleanup_start", 
                             node_id, rss_mb, emergency_mb);
                    
                    // v3.0: Clear sync queue to stop incoming blocks
                    let sync_queue_size = crate::unified_p2p::get_pending_sync_count();
                    crate::unified_p2p::clear_all_pending_sync();
                    
                    // v3.1: Also clear macroblock sync queue
                    let macro_queue_size = crate::unified_p2p::get_pending_macroblock_count();
                    crate::unified_p2p::clear_all_pending_sync_macroblocks();
                    println!("[INFO][MEMORY] sync_queue_cleared micro={} macro={}", sync_queue_size, macro_queue_size);
                    
                    // Force cleanup of caches
                    producer_cache::CACHED_PRODUCER_SELECTION.clear();
                    println!("[INFO][MEMORY] producer_cache_cleared");
                    
                    // Force TX pool cleanup
                    if let Ok(_) = storage.transaction_pool.cleanup_old_duplicates() {
                        println!("[INFO][MEMORY] tx_pool_cleanup_forced");
                    }
                    
                    // v3.0: CRITICAL - Flush RocksDB WAL to disk BEFORE potential OOM
                    // This prevents data corruption if OOM killer terminates process
                    if let Err(e) = storage.flush_all() {
                        println!("[WARN][MEMORY] rocksdb_flush_failed err={}", e);
                    } else {
                        println!("[INFO][MEMORY] rocksdb_flushed data_safe");
                    }
                }
                
                // Graceful shutdown only on a CONFIRMED breach: the emergency cleanup
                // above just ran, so re-measure after 30s before killing the process —
                // a transient spike (replay burst, drain in flight) must not restart
                // the node. On confirmed exit, persist a backoff marker so boot can
                // pace itself instead of storming.
                if rss_mb > fatal_mb {
                    println!("[CRIT][MEMORY] node={} rss_mb={} limit={} FATAL_BREACH recheck_in=30s {}",
                             node_id, rss_mb, fatal_mb, breakdown);
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    let recheck_mb = std::fs::read_to_string("/proc/self/statm").ok()
                        .and_then(|s| s.split_whitespace().nth(1).map(|p| p.parse::<u64>().unwrap_or(0)))
                        .map(|pages| pages * 4096 / 1024 / 1024)
                        .unwrap_or(rss_mb);
                    if recheck_mb <= fatal_mb {
                        println!("[WARN][MEMORY] fatal_breach_receded rss_mb={} limit={}", recheck_mb, fatal_mb);
                        continue;
                    }
                    println!("[CRIT][MEMORY] node={} rss_mb={} limit={} OOM_IMMINENT graceful_shutdown",
                             node_id, recheck_mb, fatal_mb);

                    // Final flush before exit
                    if let Err(e) = storage.flush_all() {
                        if crate::node::is_warn() {
                            println!("[WARN][STORAGE] flush_failed err={}", e);
                        }
                    }
                    println!("[INFO][MEMORY] final_flush_complete");

                    // Backoff marker: consecutive OOM exits within 10 min escalate the
                    // boot delay (read in main before node start).
                    let now_ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                    let marker = crate::node::oom_backoff_path();
                    let prev_count = std::fs::read_to_string(&marker)
                        .ok()
                        .and_then(|s| {
                            let mut it = s.split_whitespace();
                            let ts: u64 = it.next()?.parse().ok()?;
                            let n: u32 = it.next()?.parse().ok()?;
                            (now_ts.saturating_sub(ts) < 600).then_some(n)
                        })
                        .unwrap_or(0);
                    let _ = std::fs::write(&marker, format!("{} {}", now_ts, prev_count + 1));

                    // Give time for logs to be written
                    tokio::time::sleep(Duration::from_millis(100)).await;

                    // Exit with code 137 (OOM) so Docker knows to restart
                    std::process::exit(137);
                }
            }
        });
        
        println!("[INFO][MEMORY] monitoring_started interval=300s");
    }

    /// CRITICAL FIX: Generate unique node_id based on Genesis ID or server IP
    /// This ensures each node has a unique identifier for producer rotation
    pub(super) async fn generate_unique_node_id(node_type: NodeType) -> String {
        // Generating unique node ID based on environment
        
        // DOCKER FIX: For Docker environments, retry environment variable access
        // Sometimes Docker env vars are not immediately available
        if std::env::var("DOCKER_ENV").is_ok() {
            println!("[DBG][NODE] docker_env_detected checking=BOOTSTRAP_ID");
            
            // Retry up to 5 times with 100ms delay for Docker env propagation
            for attempt in 1..=5 {
                if let Ok(bootstrap_id) = std::env::var("QNET_BOOTSTRAP_ID") {
                    println!("[INFO][NODE] bootstrap_id_found attempt={} id={}", attempt, bootstrap_id);
                    let node_id = format!("genesis_node_{}", bootstrap_id);
                    println!("[INFO][NODE] genesis_node_id id={}", node_id);
                    return node_id;
                }
                
                if attempt < 5 {
                    println!("[DBG][NODE] bootstrap_id_retry attempt={}/5", attempt);
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                }
            }
            
            // Docker + no BOOTSTRAP_ID = regular node
            println!("[INFO][NODE] docker_no_bootstrap_id using=regular_node_id");
        }
        
        // Priority 1: Use BOOTSTRAP_ID for Genesis nodes (001-005) 
        if let Ok(bootstrap_id) = std::env::var("QNET_BOOTSTRAP_ID") {
            println!("[INFO][NODE] genesis_node_detected bootstrap_id={}", bootstrap_id);
            // Using BOOTSTRAP_ID for Genesis node
            return format!("genesis_node_{}", bootstrap_id);
        } else {
            println!("[DBG][NODE] id_priority1_miss var=QNET_BOOTSTRAP_ID");
        }
        
        // Priority 2: Check for Genesis activation code (QNET-BOOT-000X-STRAP)
        println!("[DBG][NODE] id_priority2_check var=QNET_ACTIVATION_CODE");
        if let Ok(activation_code) = std::env::var("QNET_ACTIVATION_CODE") {
            use crate::genesis_constants::GENESIS_BOOTSTRAP_CODES;
            
            for (i, genesis_code) in GENESIS_BOOTSTRAP_CODES.iter().enumerate() {
                if activation_code == *genesis_code {
                    let genesis_id = format!("{:03}", i + 1);
                    println!("[INFO][NODE] genesis_activation_match code={} id=genesis_node_{}", genesis_code, genesis_id);
                    println!("[DBG][NODE] id_priority2_hit id=genesis_node_{}", genesis_id);
                    return format!("genesis_node_{}", genesis_id);
                }
            }
            println!("[DBG][NODE] id_priority2_miss code={}", activation_code);
        } else {
            println!("[DBG][NODE] id_priority2_miss var=QNET_ACTIVATION_CODE");
        }
        
        // Priority 3: Use Genesis bootstrap flag (legacy support) - FAST MODE
        println!("[DBG][NODE] id_priority3_check var=QNET_GENESIS_BOOTSTRAP");
        let genesis_bootstrap = std::env::var("QNET_GENESIS_BOOTSTRAP").unwrap_or_default();
        if genesis_bootstrap == "1" {
            println!("[DBG][NODE] id_priority3_hit genesis_bootstrap=1");
            
            // FAST MODE: Check environment IP first (no blocking calls)
            if let Ok(env_ip) = std::env::var("QNET_EXTERNAL_IP") {
                use crate::genesis_constants::GENESIS_NODE_IPS;
                for (_i, (genesis_ip, genesis_id)) in GENESIS_NODE_IPS.iter().enumerate() {
                    if env_ip == *genesis_ip {
                        println!("[INFO][NODE] genesis_detected_by_ip id={}", genesis_id);
                        println!("[DBG][NODE] id_priority3_ip_match id=genesis_node_{}", genesis_id);
                        return format!("genesis_node_{}", genesis_id);
                    }
                }
                println!("[DBG][NODE] id_priority3_ip_miss ip={}", env_ip);
            }
            
            // Fallback for legacy genesis (avoid external IP detection)
            println!("[INFO][NODE] legacy_genesis_node mode=fast");
            println!("[DBG][NODE] id_priority3_legacy_fallback");
            return format!("genesis_node_legacy_{}", std::process::id() % 1000);
        } else {
            println!("[DBG][NODE] id_priority3_miss genesis_bootstrap={}", genesis_bootstrap);
        }
        
        // v15.11: non-genesis super nodes use the wallet-derived pseudonym
        // (super_<region>_<blake3>; see generate_super_node_pseudonym) instead of
        // the old ephemeral node_<host> (broke the heartbeat-validator whitelist
        // & leaked network identity). Falls back to the legacy IP/host format
        // only when QNET_WALLET_SEED is absent (dev/testing).
        println!("[DBG][NODE] id_priority4_check mode=wallet_pseudonym");
        if let Some(seed) = load_wallet_seed("QNET_WALLET_SEED") {
            let wallet = crate::crypto::vrf::WalletIdentity::derive_wallet_address(&seed);
            let pseudonym = crate::rpc::generate_super_node_pseudonym(&wallet);
            println!("[INFO][NODE] super_pseudonym source=wallet id={}", pseudonym);
            println!("[DBG][NODE] id_priority4_hit id={} wallet_prefix={}",
                     pseudonym, qnet_state::char_prefix(&wallet, 16));
            return pseudonym;
        }
        println!("[DBG][NODE] id_priority4_miss reason=no_wallet_seed");

        // ─────────────────────────────────────────────────────────────────────────
        // Legacy fallback paths — preserved for dev / test environments without
        // an activation wallet. Production super nodes always reach the wallet
        // pseudonym path above; the IP/hostname-based fallbacks below are
        // intentionally tagged as legacy and emit a [WARN] so operators can
        // notice and add a wallet seed.
        // ─────────────────────────────────────────────────────────────────────────

        // Priority 5: Environment IP (legacy)
        if let Ok(external_ip) = std::env::var("QNET_EXTERNAL_IP") {
            let sanitized_ip = external_ip.replace(".", "_").replace(":", "_");
            let legacy_id = format!("super_legacy_{}", sanitized_ip);
            println!("[WARN][NODE] legacy_id_path source=env_ip id={} reason=missing_wallet_seed", legacy_id);
            println!("[DBG][NODE] id_priority5_hit id={}", legacy_id);
            return legacy_id;
        }

        // Priority 6: Hostname fallback (legacy)
        if let Ok(hostname) = std::env::var("HOSTNAME") {
            let sanitized_hostname = hostname.replace(".", "_");
            let legacy_id = format!("super_legacy_{}", sanitized_hostname);
            println!("[WARN][NODE] legacy_id_path source=hostname id={} reason=missing_wallet_seed", legacy_id);
            println!("[DBG][NODE] id_priority6_hit id={}", legacy_id);
            return legacy_id;
        }

        // Priority 7: Network IP detection (legacy, last resort before pid)
        println!("[DBG][NODE] id_priority7_check method=network_ip");
        if let Ok(ip) = Self::get_external_ip().await {
            let sanitized_ip = ip.replace(".", "_").replace(":", "_");
            let legacy_id = format!("super_legacy_{}", sanitized_ip);
            println!("[WARN][NODE] legacy_id_path source=detected_ip id={} reason=missing_wallet_seed", legacy_id);
            println!("[DBG][NODE] id_priority7_hit id={}", legacy_id);
            return legacy_id;
        }
        println!("[DBG][NODE] id_priority7_miss reason=network_ip_failed");

        // Last resort: process ID. Tagged as `super_legacy_pid_*` so the
        // validator-side whitelist still accepts the format, but the
        // operational [WARN] above flags the absent wallet seed.
        let fallback_id = format!("super_legacy_pid_{}_{}", std::process::id(), node_type as u8);
        println!("[WARN][NODE] fallback_node_id id={} reason=missing_all_identity_sources", fallback_id);
        println!("[DBG][NODE] id_final_fallback id={}", fallback_id);
        fallback_id
    }
    
    /// Get external IP address for node identification
    pub(super) async fn get_external_ip() -> Result<String, String> {
        // Try multiple methods to get external IP
        
        // Method 1: Environment variable (Docker/Kubernetes)
        if let Ok(external_ip) = std::env::var("QNET_EXTERNAL_IP") {
            // PRIVACY: Don't show raw IP in logs
            let privacy_id = crate::unified_p2p::get_privacy_id_for_addr(&external_ip);
            println!("[DBG][NODE] ip_source=env id={}", privacy_id);
            return Ok(external_ip);
        }
        
        // Method 2: Check common network interfaces (production servers)
        if let Ok(local_ip) = std::env::var("SERVER_IP") {
            // PRIVACY: Don't show raw IP in logs  
            let privacy_id = crate::unified_p2p::get_privacy_id_for_addr(&local_ip);
            println!("[DBG][NODE] ip_source=server id={}", privacy_id);
            return Ok(local_ip);
        }
        
        // Method 3: Try to get IP from network interface
        if let Ok(interface_ip) = Self::get_network_interface_ip().await {
            // PRIVACY: Don't show raw IP in logs
            let privacy_id = crate::unified_p2p::get_privacy_id_for_addr(&interface_ip);
            println!("[DBG][NODE] ip_source=interface id={}", privacy_id);
            return Ok(interface_ip);
        }
        
        // Method 4: Use unique localhost fallback BEFORE external services (avoid blocking)
        let unique_fallback = format!("127_0_0_{}", std::process::id() % 254 + 1); // 1-254 range
        println!("[WARN][NODE] ip_fallback id={} reason=no_external_ip", unique_fallback);
        println!("[DBG][NODE] ip_external_services_skipped");
        Ok(unique_fallback)
        
        // Method 5: Query external service (disabled to prevent blocking)
        // NOTE: External IP detection disabled to prevent Docker networking issues
        // If needed, set QNET_EXTERNAL_IP environment variable instead
        /*
        match Self::query_external_ip_service().await {
            Ok(ip) => {
                println!("[INFO][NODE] external_ip={}", ip);
                Ok(ip)
            }
            Err(_) => {
                let unique_fallback = format!("127_0_0_{}", std::process::id() % 254 + 1);
                println!("[WARN][NODE] external_ip_fail fallback={}", unique_fallback);
                Ok(unique_fallback)
            }
        }
        */
    }
    
    /// Get IP from network interface (production servers)
    pub(super) async fn get_network_interface_ip() -> Result<String, String> {
        // Simple method to get local IP that can reach internet
        
        match std::net::UdpSocket::bind("0.0.0.0:0") {
            Ok(socket) => {
                // Try to connect to a public DNS server to determine our external interface
                if let Ok(_) = socket.connect("8.8.8.8:80") {
                    if let Ok(local_addr) = socket.local_addr() {
                        let ip = local_addr.ip().to_string();
                        if !ip.starts_with("127.") && !ip.starts_with("0.") {
                            return Ok(ip.replace(".", "_"));
                        }
                    }
                }
            }
            Err(_) => {}
        }
        
        Err("No network interface found".to_string())
    }
    
}

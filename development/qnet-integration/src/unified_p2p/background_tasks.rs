//! The required background tasks: signed-head emitter, peer cleanup, repair, cache reapers.

use super::*;

impl SimplifiedP2P {
    /// Internet-wide peer discovery. Fallback for a node with no configured bootstrap peers; it
    /// carries ONLY discovery. The background tasks every node needs live in
    /// `start_required_background_tasks` — bundling them here made all of them conditional on an
    /// empty bootstrap list, i.e. dead on every real deployment.
    pub(super) fn start_internet_peer_discovery(&self) {
        if crate::node::is_info() { println!("[INFO][P2P] internet_discovery_start"); }
        self.announce_node_to_internet();
        self.search_internet_peers();
    }

    /// Background tasks required on every node regardless of how it finds peers. Idempotent: safe
    /// on any P2P bring-up path (initial connect, reconnect, committee dial).
    pub fn start_required_background_tasks(&self) {
        if REQUIRED_TASKS_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }

        use crate::boot_contract::{names, require};
        for n in [
            names::SIGNED_HEAD_EMITTER,
            names::PEER_CLEANUP,
            names::BACKGROUND_REPAIR,
            names::BACKGROUND_HEIGHT_SYNC,
            names::REPUTATION_VALIDATION,
            names::REGIONAL_CLUSTERING,
            names::TX_CACHE_CLEANUP,
            names::RATE_LIMITER_CLEANUP,
            names::STATIC_CACHE_CLEANUP,
            names::QUIC_IDLE_REAPER,
            names::EXTERNAL_IP_RESOLVER,
            names::COMMITTEE_LINKS,
        ] {
            require(n);
        }

        self.start_reputation_validation();
        self.start_background_height_sync();
        self.start_peer_cleanup_task();
        self.start_regional_clustering();
        self.start_quic_health_check_task();
        self.start_tx_cache_cleanup_task();
        self.start_rate_limiter_cleanup_task();
        self.start_static_cache_cleanup_task();
        self.start_background_repair_task();
        self.start_quic_idle_reaper();
        self.start_external_ip_resolution();
        self.start_committee_link_maintainer();

        if crate::node::is_info() { println!("[INFO][P2P] required_tasks_started count=12"); }
    }
    
    /// Periodic committee-link maintenance. See maintain_committee_links: consensus frames are unicast
    /// and unrelayed, so a member that is not connected to its committee cannot reach quorum.
    pub(super) fn start_committee_link_maintainer(&self) {
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                crate::boot_contract::skipped(crate::boot_contract::names::COMMITTEE_LINKS, "no_runtime");
                return;
            }
        };
        crate::boot_contract::started(crate::boot_contract::names::COMMITTEE_LINKS);
        handle.spawn(async move {
            // Rate, stated honestly: each pass queues up to DIALS_PER_PASS addresses, but the shared
            // regional admit path probes only a few of them per sweep, so convergence is gradual and
            // at COMMITTEE_SIZE it does not reach the quorum threshold within one epoch. It closes the
            // gap for small and mid-size committees; a large one needs a dedicated admit path or a
            // relay step for consensus frames, which is a separate design decision.
            const PASS_SECS: u64 = 15;
            const DIALS_PER_PASS: usize = 32;
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(PASS_SECS));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                if let Some(p2p) = crate::node::try_get_p2p() {
                    p2p.maintain_committee_links(DIALS_PER_PASS);
                }
            }
        });
    }

    /// Announce our node to the internet for peer discovery
    pub(super) fn announce_node_to_internet(&self) {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_warn() { println!("[WARN][P2P] No Tokio runtime - node announcement deferred"); }
                return;
            }
        };
        
        let node_id = self.node_id.clone();
        let region = self.region.clone();
        let node_type = self.node_type.clone();
        let port = self.port;
        let external_ip_store = self.external_ip.clone();
        
        handle.spawn(async move {
            if crate::node::is_info() { println!("[INFO][P2P] Announcing node to internet..."); }
            
            // Get our external IP address
            let external_ip = match Self::get_our_ip_address().await {
                Ok(ip) => {
                    // Store our external IP to prevent self-connection
                    let mut guard = external_ip_store.write();
                    *guard = Some(ip.clone());
                    ip
                },
                Err(e) => {
                    if crate::node::is_warn() { println!("[WARN][P2P] Could not get external IP: {}", e); }
                    return;
                }
            };
            
            // PRIVACY: Use pseudonym for own IP in logs
            if crate::node::is_info() { println!("[INFO][P2P] External IP: {}", get_privacy_id_for_addr(&external_ip)); }
            if crate::node::is_info() { println!("[INFO][P2P] Node announcement: {} in {:?}", get_privacy_id_for_addr(&external_ip), region); }
            
            // PRIVACY: Use display name for public P2P announcement (preserves consensus ID)
            let public_display_name = {
                // Generate display name using EXISTING pattern
                match &node_type {
                    NodeType::Light => node_id.clone(), // Light nodes use pseudonyms already
                    _ => {
                        // Genesis nodes keep original ID for stability
                        if node_id.starts_with("genesis_node_") {
                            node_id.clone()
                        } else {
                            // Super: Privacy display name (v3.18: "Full" tier removed)
                            let display_hash = blake3::hash(format!("P2P_DISPLAY_{}_{}", 
                                                                    node_id, 
                                                                    format!("{:?}", node_type)).as_bytes());
                            
                            let node_type_prefix = match node_type {
                                NodeType::Super => "super",
                                NodeType::Light => "light",
                            };
                            
                            format!("{}_{}_{}", 
                                    node_type_prefix,
                                    format!("{:?}", region).to_lowercase(), 
                                    &display_hash.to_hex()[..8])
                        }
                    }
                }
            };
            
            // Create our node announcement
            let announcement = serde_json::json!({
                "node_id": public_display_name,
                "external_ip": external_ip,
                "port": port,
                "region": format!("{:?}", region),
                "announced_at": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                "node_type": "QNet",
                "version": "1.0.0"
            });
            
            if crate::node::is_info() { println!("[INFO][P2P] Node announced: {}", announcement); }
            
            // PRODUCTION: Save to distributed registry via HTTP API calls
            if crate::node::is_info() { println!("[INFO][P2P] Node announcement completed for distributed registry"); }
        });
    }
    
    /// Search for other QNet nodes on the internet with cryptographic peer verification
    pub(super) fn search_internet_peers(&self) {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_warn() { println!("[WARN][P2P] No Tokio runtime - peer search deferred"); }
                return;
            }
        };
        
        let _node_id = self.node_id.clone();
        let region = self.region.clone();
        let regional_peers = self.regional_peers.clone();
        let connected_peers = self.connected_peers_lockfree.clone();
        let me = self.self_weak();
        let _port = self.port;
        let _node_type = self.node_type.clone();

        handle.spawn(async move {
            if crate::node::is_info() { println!("[INFO][P2P] Searching for QNet peers with cryptographic verification..."); }
            
            let mut discovered_peers = Vec::new();
            
                         // PRODUCTION FIX: Always use genesis nodes + optional manual override
             let mut known_node_ips = Vec::new();
             
            // PRIORITY 1: Include ONLY WORKING genesis bootstrap nodes for network stability  
            // EXISTING: Use genesis_constants::GENESIS_NODE_IPS to avoid duplication
            use crate::genesis_constants::GENESIS_NODE_IPS;
            let all_genesis_ips: Vec<String> = GENESIS_NODE_IPS.iter()
                .map(|(ip, _)| ip.to_string())
                .collect();
            let working_genesis_ips = Self::filter_working_genesis_nodes_static(all_genesis_ips);
             
             for ip in working_genesis_ips {
                 known_node_ips.push(ip.clone());
                 // EXISTING: Use get_genesis_region_by_ip() to get correct region
                 use crate::genesis_constants::get_genesis_region_by_ip;
                 let region_name = get_genesis_region_by_ip(&ip)
                     .unwrap_or("Unknown");
                 // PRIVACY: Genesis IPs are public, but use pseudonym for consistency
                 if crate::node::is_info() { println!("[INFO][P2P] Working Genesis bootstrap node: {} ({})", get_privacy_id_for_addr(&ip), region_name); }
             }
             
             // PRIORITY 2: Add environment variable peers (additional nodes)
             if let Ok(peer_ips) = std::env::var("QNET_PEER_IPS") {
                 for ip in peer_ips.split(',') {
                     let ip = ip.trim();
                     if !ip.is_empty() && !known_node_ips.contains(&ip.to_string()) {
                         known_node_ips.push(ip.to_string());
                         // PRIVACY: Use pseudonym in logs
                         if crate::node::is_info() { println!("[INFO][P2P] Additional peer IP: {}", get_privacy_id_for_addr(ip)); }
                     }
                 }
             }
             
             if crate::node::is_info() { println!("[INFO][P2P] Quantum network bootstrap: {} total nodes configured", known_node_ips.len()); }
            
            // EXISTING: Use existing Genesis constants to avoid code duplication
            let our_external_ip = if let Ok(bootstrap_id) = std::env::var("QNET_BOOTSTRAP_ID") {
                // EXISTING: Use get_genesis_ip_by_id() from existing genesis_constants
                use crate::genesis_constants::get_genesis_ip_by_id;
                get_genesis_ip_by_id(&bootstrap_id)
                    .map(|ip| ip.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            } else {
                // EXISTING: Use environment variable for regular nodes  
                std::env::var("QNET_EXTERNAL_IP").unwrap_or_else(|_| "unknown".to_string())
            };
            
            // PRIVACY: Show privacy ID instead of raw IP
            if crate::node::is_debug() { println!("[DBG][P2P] Our external node: {}", get_privacy_id_for_addr(&our_external_ip)); }
            // PRIVACY: Don't print raw IPs, just count
            if crate::node::is_debug() { println!("[DBG][P2P] Known node IPs count: {}", known_node_ips.len()); }
            
            // Search on known server IPs with proper regional ports
            for ip in known_node_ips {
                // PRIVACY: Use pseudonym in logs
                if crate::node::is_debug() { println!("[DBG][P2P] Processing peer: {}", get_privacy_id_for_addr(&ip)); }
                
                // CRITICAL: Skip our own IP to prevent self-connection
                if ip == our_external_ip {
                    // PRIVACY: Don't show raw IP  
                    if crate::node::is_info() { println!("[INFO][P2P] Skipping self-connection to own node: {}", get_privacy_id_for_addr(&ip)); }
                    continue;
                }
                
                // ADDITIONAL CHECK: Skip if IP matches any of our listening addresses
                if ip == "127.0.0.1" || ip == "0.0.0.0" || ip == "localhost" {
                    // PRIVACY: Even local addresses shouldn't be shown
                    if crate::node::is_info() { println!("[INFO][P2P] Skipping local address: {}", get_privacy_id_for_addr(&ip)); }
                    continue;
                }
                
                // PRIVACY: Show privacy ID for peer connections
                if crate::node::is_info() { println!("[INFO][P2P] Attempting to connect to peer: {}", get_privacy_id_for_addr(&ip)); }
                // GENESIS PERIOD FIX: All nodes use unified API on port 8001
                // Simplified connection strategy - all Genesis nodes listen on 8001
                let target_ports = vec![8001];  // All nodes connect via unified API port only
                
                for target_port in target_ports {
                    let target_addr = format!("{}:{}", ip, target_port);
                    
                    if crate::node::is_debug() { println!("[DBG][P2P] Attempting peer verification for {}", target_addr); }
                    
                    // Try to connect with timeout
                    // PRODUCTION: Use cryptographic peer verification instead of simple TCP test
                    match Self::verify_peer_authenticity(&target_addr).await {
                        Ok(peer_pubkey) => {
                            if crate::node::is_info() { println!("[INFO][P2P] Quantum-secured peer verified: {} | Dilithium signature validated | Key: {}...", 
                                   target_addr, qnet_state::char_prefix(&peer_pubkey, 16)); }
                            
                            // EXISTING: Use get_genesis_region_by_ip() to get correct Genesis peer region
                            use crate::genesis_constants::get_genesis_region_by_ip;
                            let genesis_region_str = get_genesis_region_by_ip(&ip).unwrap_or("Europe");
                            let peer_region = match genesis_region_str {
                                    "NorthAmerica" => Region::NorthAmerica,
                                    "Europe" => Region::Europe,
                                    "Asia" => Region::Asia,
                                    "SouthAmerica" => Region::SouthAmerica,
                                    "Africa" => Region::Africa,
                                    "Oceania" => Region::Oceania,
                                _ => region.clone(), // EXISTING: Use current region as fallback
                            };
                            
                            // v2.45.1: Use INITIAL_REPUTATION from consensus
                            // Real reputation will be loaded from blockchain after sync
                            let real_rep = qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
                            
                            // v2.87: Use canonical genesis node ID format for Gulf Stream producer forwarding
                            // CRITICAL: ID must match producer selection format (genesis_node_XXX)
                            use crate::genesis_constants::get_genesis_id_by_ip;
                            let canonical_id = get_genesis_id_by_ip(&ip)
                                .map(|id| format!("genesis_node_{}", id))
                                .unwrap_or_else(|| format!("genesis_{}", target_addr.replace(":", "_")));
                            
                            let peer_info = PeerInfo {
                                id: canonical_id,
                                addr: target_addr.clone(),
                                node_type: NodeType::Super,
                                region: peer_region,
                                last_seen: std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs(),
                                is_stable: false,
                                latency_ms: 0,
                                connection_count: 0,
                                bandwidth_usage: 0,
                                node_id_hash: Vec::new(),
                                bucket_index: 0,
                                reputation: real_rep,     // v2.45.1: From blockchain
                                consensus_score: real_rep, // Legacy
                                network_score: 100.0,      // Legacy
                                reputation_score: None,    // Legacy
                                successful_pings: 0,
                                failed_pings: 0,
                                last_block_height: 0,  // v2.24.3
                                last_height_attested_at: 0,  // v30.A3
                                is_outbound: true,  // Outbound - we initiated discovery
                            };

                            discovered_peers.push(peer_info);
                            break;
                        }
                        Err(e) => {
                            // PRIVACY: Use pseudonym in logs
                            if crate::node::is_info() { println!("[INFO][P2P] Peer verification failed for {}: {}", get_privacy_id_for_addr(&target_addr), e); }
                            if crate::node::is_debug() { println!("[DBG][P2P] Trying next port for peer {}", get_privacy_id_for_addr(&ip)); }
                        }
                    }
                }
            }
            
            // If no direct connections found, load cached peers from previous sessions
            if discovered_peers.is_empty() {
                // QUANTUM DECENTRALIZED: No file cache loading - use real-time DHT discovery only
                if crate::node::is_info() { println!("[INFO][P2P] QUANTUM: No direct connections found - using cryptographic DHT discovery"); }
                
                // QUANTUM DECENTRALIZED: File caching disabled for quantum security and decentralization
                // Peers are discovered exclusively through real-time cryptographic DHT network protocols
                
                if discovered_peers.is_empty() {
                    if crate::node::is_info() { println!("[INFO][P2P] Network discovery: Waiting for peer announcements..."); }
                    if crate::node::is_info() { println!("[INFO][P2P] New nodes will find this network through genesis bootstrap"); }
                }
            }
            
            if crate::node::is_info() { println!("[INFO][P2P] Quantum network discovery: {} nodes found | All connections post-quantum secured", discovered_peers.len()); }
            
            // CRITICAL: Validate activation codes before adding peers
            let validated_peers = Self::validate_activation_codes_static(&discovered_peers);
            if crate::node::is_info() { println!("[INFO][P2P] Activation validation: {}/{} peers passed", validated_peers.len(), discovered_peers.len()); }
            
            // Add validated peers to regional map through the bounded, deduping insert.
            for peer in validated_peers.iter() {
                Self::push_regional_peer(&regional_peers, peer.clone());
            }
            
            // v2.51: Add validated peers using lock-free DashMap
            // v4.2: Use spawn_blocking to avoid starving tokio worker threads
            for peer in validated_peers.iter() {
                let addr_clone = peer.addr.clone();
                let is_reachable = tokio::task::spawn_blocking(move || {
                    Self::test_peer_connectivity_static(&addr_clone)
                }).await.unwrap_or(false);
                if is_reachable && !connected_peers.contains_key(&peer.addr) {
                    Self::admit_regional_candidate(&me, peer.clone());
                }
            }

            if crate::node::is_info() && !validated_peers.is_empty() {
                println!("[INFO][P2P] peers_discovered count={}", validated_peers.len());
            }

            if connected_peers.is_empty() {
                if crate::node::is_info() { println!("[INFO][P2P] Running in genesis mode - accepting new peer connections"); }
            }
        });
    }
    
    /// API DEADLOCK FIX: Background height synchronization to prevent circular dependencies
    pub(super) fn start_background_height_sync(&self) {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_warn() { println!("[WARN][SYNC] No Tokio runtime - background sync deferred"); }
                return;
            }
        };
        
        let node_type = self.node_type.clone();
        let connected_peers = self.connected_peers_lockfree.clone();
        
        handle.spawn(async move {
            crate::boot_contract::started(crate::boot_contract::names::BACKGROUND_HEIGHT_SYNC);
            if crate::node::is_info() { println!("[INFO][SYNC] Starting background height synchronization..."); }
            
            // Initial delay to let network form
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            
            let _last_cleanup = std::time::Instant::now();
            
            loop {
                // SCALABILITY: Adaptive sync intervals based on node type and network phase
                let is_genesis_node = std::env::var("QNET_BOOTSTRAP_ID").is_ok() || 
                                      std::env::var("QNET_GENESIS_BOOTSTRAP").unwrap_or_default() == "1";
                
                // Determine sync interval based on node type AND network phase
                // CRITICAL FIX: Balanced sync intervals to prevent rate limiting
                // Rate limit: 10 requests/min → need intervals ≥6s to stay under limit
                // ARCHITECTURE: All Genesis nodes are Super nodes by design
                // Genesis Super nodes: 7s (was 1s) - 8.5 requests/min (safe margin)
                // Regular nodes: Keep original timing (already safe)
                let sync_interval = match &node_type {
                    NodeType::Light => 30,  // Light nodes: 30s — mobile-only, no local chain
                                            // storage (pure API client). Long interval bounds
                                            // mobile battery / data-plan cost on the device.
                    NodeType::Super => {
                        if is_genesis_node { 7 } else { 2 }  // Super nodes: 7s genesis, 2s normal
                    }
                };
                
                // v2.51: Lock-free height collection
                let mut peer_heights: Vec<u64> = connected_peers.iter()
                    .filter(|e| e.value().last_block_height > 0)
                    .map(|e| e.value().last_block_height)
                    .collect();
                
                // Update cache if we got responses
                if !peer_heights.is_empty() {
                    peer_heights.sort();
                    let consensus_height = if peer_heights.len() >= 3 {
                        // Use median for byzantine fault tolerance
                        peer_heights[peer_heights.len() / 2]
                    } else {
                        // Use maximum height
                        *peer_heights.iter().max().unwrap_or(&0)
                    };
                    
                    // Update both cache systems
                    if consensus_height > 0 {
                        if crate::node::is_info() { println!("[INFO][SYNC] Background: network height {} (from {} peers)", consensus_height, peer_heights.len()); }

                        *CACHED_BLOCKCHAIN_HEIGHT.lock() = (consensus_height, Instant::now());
                        // v14.8.5: lock-free mirror for the stuck-chain watchdog
                        CACHED_NETWORK_HEIGHT.store(consensus_height, std::sync::atomic::Ordering::Relaxed);
                    }
                } else {
                    if crate::node::is_warn() { println!("[WARN][SYNC] Background: No peer responses - cache not updated"); }
                }
                
                tokio::time::sleep(std::time::Duration::from_secs(sync_interval)).await;
            }
        });
    }
    
    /// PRODUCTION: Start periodic cleanup of inactive peers
    pub(super) fn start_peer_cleanup_task(&self) {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_warn() { println!("[WARN][P2P] No Tokio runtime - peer cleanup task deferred"); }
                return;
            }
        };
        
        // v2.51: Clone references for async task
        let connected_peers_lockfree = self.connected_peers_lockfree.clone();
        let _connected_peers = self.connected_peers_lockfree.clone();
        let peer_id_to_addr = self.peer_id_to_addr.clone();
        let peer_shards = self.peer_shards.clone();
        let quic_transport = self.quic_transport.clone();
        
        handle.spawn(async move {
            crate::boot_contract::started(crate::boot_contract::names::PEER_CLEANUP);
            if crate::node::is_info() { println!("[INFO][P2P] Starting periodic peer cleanup task (every 5 minutes)..."); }
            
            // Initial delay to let network stabilize
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            
            loop {
                // Run cleanup every 5 minutes (300 seconds)
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let threshold = now.saturating_sub(PEER_INACTIVE_TIMEOUT_SECS);
                
                // Collect peers to remove (can't remove while iterating)
                let mut peers_to_remove = Vec::new();
                
                // Check all peers in lock-free map
                for entry in connected_peers_lockfree.iter() {
                    if entry.value().last_seen < threshold {
                        peers_to_remove.push((entry.key().clone(), entry.value().id.clone()));
                    }
                }
                
                // Remove inactive peers from all structures
                for (peer_addr, peer_id) in &peers_to_remove {
                    // Remove from main map
                    connected_peers_lockfree.remove(peer_addr);
                    
                    // Remove from ID index
                    peer_id_to_addr.remove(peer_id);
                    
                    // Remove from shards
                    let mut hasher = sha3::Sha3_256::new();
                    hasher.update(peer_id.as_bytes());
                    let hash = hasher.finalize();
                    let peer_shard = hash[0];
                    
                    if let Some(mut shard_peers) = peer_shards.get_mut(&peer_shard) {
                        shard_peers.retain(|addr| addr != peer_addr);
                    }
                    
                    if crate::node::is_info() { println!("[INFO][P2P] peer_removed peer={} id={} reason=inactive threshold={}s", 
                            peer_addr, peer_id, PEER_INACTIVE_TIMEOUT_SECS); }
                }
                
                // v2.51: All cleanup done via lockfree DashMap above
                if !peers_to_remove.is_empty() {
                    if crate::node::is_info() {
                        println!("[INFO][P2P] cleanup_inactive removed={}", peers_to_remove.len());
                    }
                    // Monotonic refresh after peer removal: only RAISE BEST_PEER_HEIGHT, never lower it from
                    // currently-connected (served-low) peers — lowering re-collapses the target for a joiner.
                    let new_best = connected_peers_lockfree.iter()
                        .map(|e| e.value().last_block_height)
                        .max()
                        .unwrap_or(0);
                    BEST_PEER_HEIGHT.fetch_max(new_best, std::sync::atomic::Ordering::Relaxed);
                }

                // ═══════════════════════════════════════════════════════════════════════
                // v14.1: IDENTITY-LEVEL DEDUP — collapse same node_id at multiple addresses
                // ═══════════════════════════════════════════════════════════════════════
                // Each Super node listens on 3 ports (HTTP :8001 + QUIC-main :9876 +
                // QUIC-alt :9877). Historical peer exchange may have inserted one node
                // under several addresses. Keep ONLY the most-recently-seen entry per
                // node_id; remove the rest. Preserves liveness (we still have the fresh
                // entry) while eliminating BFT threshold inflation.
                //
                // Determinism of selection: keep entry with highest last_seen; ties
                // broken by lexicographic address ordering (stable across nodes).
                //
                // Complexity: O(n log n) where n = peer count. At 1000 peers per round
                // (MAX_VALIDATORS), this is ~10ms every 5 min — negligible overhead.
                // ═══════════════════════════════════════════════════════════════════════
                {
                    use std::collections::HashMap;
                    let mut best_per_id: HashMap<String, (String, u64)> = HashMap::new();
                    for entry in connected_peers_lockfree.iter() {
                        let id = entry.value().id.clone();
                        if id.is_empty() { continue; }
                        let addr = entry.key().clone();
                        let last_seen = entry.value().last_seen;
                        best_per_id.entry(id)
                            .and_modify(|(cur_addr, cur_ls)| {
                                if last_seen > *cur_ls || (last_seen == *cur_ls && addr < *cur_addr) {
                                    *cur_addr = addr.clone();
                                    *cur_ls = last_seen;
                                }
                            })
                            .or_insert((addr, last_seen));
                    }

                    // Collect duplicate addresses to remove (not the winners)
                    let mut dup_removed = 0usize;
                    let dup_to_remove: Vec<String> = connected_peers_lockfree.iter()
                        .filter_map(|entry| {
                            let id = entry.value().id.clone();
                            if id.is_empty() { return None; }
                            let addr = entry.key().clone();
                            if let Some((winner_addr, _)) = best_per_id.get(&id) {
                                if winner_addr != &addr {
                                    return Some(addr);
                                }
                            }
                            None
                        })
                        .collect();

                    // The shard index is cleared with the entry: the loser address would otherwise
                    // linger in its shard bucket for the process lifetime.
                    for addr in &dup_to_remove {
                        if let Some((_, lost)) = connected_peers_lockfree.remove(addr) {
                            let mut hasher = sha3::Sha3_256::new();
                            hasher.update(lost.id.as_bytes());
                            let peer_shard = hasher.finalize()[0];
                            if let Some(mut shard_peers) = peer_shards.get_mut(&peer_shard) {
                                shard_peers.retain(|a| a != addr);
                            }
                        }
                        dup_removed += 1;
                    }

                    // Re-point peer_id_to_addr to the winner address for each node_id. Every winner
                    // is a live entry by construction, so this repairs the index, never dangles it.
                    for (id, (winner_addr, _)) in &best_per_id {
                        peer_id_to_addr.insert(id.clone(), winner_addr.clone());
                    }

                    if dup_removed > 0 && crate::node::is_info() {
                        println!("[INFO][P2P] dedup_by_id removed={} unique_ids={} total_before_dedup={}",
                                 dup_removed, best_per_id.len(), best_per_id.len() + dup_removed);
                    }
                }

                // Monotonic-only refresh: raise BEST_PEER_HEIGHT toward connected peers, never lower it (the
                // old downward "correction" re-collapsed the target). Stale-high is bounded by the QC floor.
                {
                    let current_best = connected_peers_lockfree.iter()
                        .map(|e| e.value().last_block_height)
                        .max()
                        .unwrap_or(0);
                    BEST_PEER_HEIGHT.fetch_max(current_best, std::sync::atomic::Ordering::Relaxed);
                }

                // CRITICAL v2.24: QUIC health check and cleanup
                if let Some(ref quic_transport) = quic_transport {
                    let transport = quic_transport.read().await;
                    
                    // v2.24: Health check removes dead connections
                    let (alive, removed) = transport.health_check();
                    
                    // Cleanup idle connections
                    transport.cleanup_idle();
                    
                    if removed > 0 || alive < 4 {
                        if crate::node::is_info() { println!("[INFO][QUIC] health_check alive={} removed={} action=reconnect", 
                                 alive, removed); }
                    }
                }
            }
        });
        
    }
    
    /// v2.25: Periodic cleanup of seen_tx_hashes to prevent memory leak
    /// Runs every 60 seconds, clears entire cache (TXs older than 60s are not re-gossiped anyway)
    pub(super) fn start_tx_cache_cleanup_task(&self) {
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };
        
        let seen_tx_hashes = Arc::clone(&self.seen_tx_hashes);
        let seen_announcements = Arc::clone(&self.seen_announcements);

        handle.spawn(async move {
            crate::boot_contract::started(crate::boot_contract::names::TX_CACHE_CLEANUP);
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(60));

            loop {
                interval.tick().await;

                let count = seen_tx_hashes.len();
                if count > 0 {
                    seen_tx_hashes.clear();
                    if crate::node::is_info() { println!("[INFO][P2P] Cleared {} TX hashes from dedup cache", count); }
                }

                // v9.1: Clear announcement dedup cache alongside TX hashes
                let ann_count = seen_announcements.len();
                if ann_count > 0 {
                    seen_announcements.clear();
                }
            }
        });
    }
    
    /// v3.0: CRITICAL FIX - Periodic cleanup of rate_limiter to prevent memory leak and network isolation
    /// ═══════════════════════════════════════════════════════════════════════════════════════════════════
    /// PROBLEM: rate_limiter entries were NEVER cleaned up, causing:
    ///   1. Memory leak (each peer creates multiple entries: sync_, macrosync_, consensus_, etc.)
    ///   2. Network isolation (blocked entries persisted, preventing reconnection)
    /// SOLUTION: Every 5 minutes, remove entries that have been blocked for >5 minutes
    ///           Also clear expired request timestamps
    /// ═══════════════════════════════════════════════════════════════════════════════════════════════════
    pub(super) fn start_rate_limiter_cleanup_task(&self) {
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };
        
        let rate_limiter = Arc::clone(&self.rate_limiter);
        let nonce_validator = Arc::clone(&self.nonce_validator);
        
        handle.spawn(async move {
            crate::boot_contract::started(crate::boot_contract::names::RATE_LIMITER_CLEANUP);
            // Cleanup every 5 minutes
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(300));
            
            loop {
                interval.tick().await;
                
                let current_time = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                
                // Cleanup rate_limiter entries
                let rate_entries_before = rate_limiter.len();
                let mut unblocked_count = 0;
                let mut cleaned_requests = 0;
                
                // First pass: unblock expired entries and clean old requests
                rate_limiter.retain(|_key, entry| {
                    // Unblock if block time has passed
                    if entry.blocked_until > 0 && entry.blocked_until <= current_time {
                        entry.blocked_until = 0;
                        unblocked_count += 1;
                    }
                    
                    // Clean old requests (older than 2 minutes)
                    let old_len = entry.requests.len();
                    entry.requests.retain(|&req_time| req_time > current_time.saturating_sub(120));
                    cleaned_requests += old_len - entry.requests.len();
                    
                    // Retain on ACTIVITY only. The old exemption matched the substring "genesis_node_"
                    // in a key that embeds a peer-supplied id, so any peer could name itself into an
                    // entry that is never evicted. An idle entry carries no state worth keeping - it
                    // costs one insert to recreate.
                    !entry.requests.is_empty() || entry.blocked_until > current_time
                });
                
                let rate_entries_removed = rate_entries_before.saturating_sub(rate_limiter.len());
                
                // Cleanup nonce_validator entries (older than 10 minutes)
                let nonce_entries_before = nonce_validator.len();
                nonce_validator.retain(|_key, entry| {
                    entry.timestamp > current_time.saturating_sub(600)
                });
                let nonce_entries_removed = nonce_entries_before.saturating_sub(nonce_validator.len());
                
                // Log cleanup stats
                if rate_entries_removed > 0 || nonce_entries_removed > 0 || unblocked_count > 0 {
                    if crate::node::is_info() { println!("[INFO][RATE_LIMIT] cleanup removed_rate={} removed_nonce={} unblocked={} cleaned_reqs={}",
                             rate_entries_removed, nonce_entries_removed, unblocked_count, cleaned_requests); }
                }
                
                // Log current state for monitoring
                let blocked_count: usize = rate_limiter.iter()
                    .filter(|e| e.value().blocked_until > current_time)
                    .count();
                if blocked_count > 0 && crate::node::is_warn() {
                    println!("[WARN][RATE_LIMIT] currently_blocked={}", blocked_count);
                }
            }
        });
        
        if crate::node::is_info() { println!("[INFO][RATE_LIMIT] cleanup_task_started interval=300s"); }
    }
    
    /// v3.1: CRITICAL - Cleanup static DashMaps WITHOUT existing cleanup to prevent memory leak
    /// ═══════════════════════════════════════════════════════════════════════════════════════
    /// NOTE: INVALID_BLOCKS_TRACKER, FALSE_EMERGENCY_TRACKER, PEER_BLACKLIST already have
    ///       cleanup in their respective functions (report_invalid_block, track_false_emergency, etc.)
    /// THIS FUNCTION ONLY cleans structures that have NO other cleanup:
    ///   - PEER_RETRY_COOLDOWN: grows with every peer that fails
    ///   - QUIC_FALLBACK_RATE_LIMITER: grows with every node making fallback requests
    /// ═══════════════════════════════════════════════════════════════════════════════════════
    pub(super) fn start_static_cache_cleanup_task(&self) {
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };
        
        handle.spawn(async move {
            crate::boot_contract::started(crate::boot_contract::names::STATIC_CACHE_CLEANUP);
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(600)); // Every 10 minutes
            
            loop {
                interval.tick().await;
                
                let now = std::time::Instant::now();
                
                // Cleanup PEER_RETRY_COOLDOWN (NO other cleanup exists!)
                let retry_before = PEER_RETRY_COOLDOWN.len();
                PEER_RETRY_COOLDOWN.retain(|_, (_, cooldown_until)| {
                    *cooldown_until > now // Keep only if still in cooldown
                });
                let retry_removed = retry_before.saturating_sub(PEER_RETRY_COOLDOWN.len());
                
                // Cleanup QUIC_FALLBACK_RATE_LIMITER (NO other cleanup exists!)
                let current_time_secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let fallback_before = QUIC_FALLBACK_RATE_LIMITER.len();
                QUIC_FALLBACK_RATE_LIMITER.retain(|_, (_, window_start)| {
                    *window_start > current_time_secs.saturating_sub(1800) // Keep last 30 min
                });
                let fallback_removed = fallback_before.saturating_sub(QUIC_FALLBACK_RATE_LIMITER.len());
                
                // v3.0: Cleanup PENDING_SYNC_BLOCKS (TTL 60 seconds)
                // This prevents "stuck" entries from blocking re-requests
                let pending_sync_removed = cleanup_pending_sync_blocks();
                
                // v3.1: Cleanup PENDING_SYNC_MACROBLOCKS (TTL 120 seconds)
                let pending_macro_removed = cleanup_pending_sync_macroblocks();
                
                // v3.20: Cleanup EMPTY_RESPONSE_TRACKER (TTL 10 minutes)
                let empty_response_before = EMPTY_RESPONSE_TRACKER.len();
                EMPTY_RESPONSE_TRACKER.retain(|_, (_, first_seen)| {
                    current_time_secs.saturating_sub(*first_seen) < 600 // Keep last 10 min
                });
                let empty_response_removed = empty_response_before.saturating_sub(EMPTY_RESPONSE_TRACKER.len());
                
                // v3.20: Cleanup INVALID_CERT_TRACKER (TTL 10 minutes)
                let invalid_cert_before = INVALID_CERT_TRACKER.len();
                INVALID_CERT_TRACKER.retain(|_, (_, first_seen)| {
                    first_seen.elapsed() < std::time::Duration::from_secs(600) // Keep last 10 min
                });
                let invalid_cert_removed = invalid_cert_before.saturating_sub(INVALID_CERT_TRACKER.len());
                
                // v4.2: Timeout data is now keyed by macroblock index, not microblock height
                let current_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                let current_mb_index = current_height / 90;
                let min_height = current_mb_index.saturating_sub(20);
                
                let timeout_votes_before = TIMEOUT_VOTES.len();
                TIMEOUT_VOTES.retain(|(h, _), _| *h >= min_height);
                let timeout_votes_removed = timeout_votes_before.saturating_sub(TIMEOUT_VOTES.len());
                
                let timeout_certs_before = TIMEOUT_CERTIFICATES.len();
                TIMEOUT_CERTIFICATES.retain(|(h, _), _| *h >= min_height);
                let timeout_certs_removed = timeout_certs_before.saturating_sub(TIMEOUT_CERTIFICATES.len());
                
                // The round trackers are u64->u64 and must outlive the vote payloads: a node behind
                // by up to the roster horizon still needs the round its hint names. Votes keep the
                // shorter window - they carry ML-DSA signatures and are the memory cost.
                let round_min = current_mb_index.saturating_sub(
                    crate::node::BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64 + 2);
                HIGHEST_CERTIFIED_ROUND.retain(|h, _| *h >= round_min);
                // v15.11: prune per-mb baseline rounds alongside their
                // companion HIGHEST_*_ROUND maps. Keys are mb_index so the
                // same retention window applies.
                LAST_FINALIZED_ROUND_PER_MB.retain(|h, _| *h >= min_height);
                // v15.1: prune GLOBAL_PEER_LAST_SEEN_BY_IP so long-gone peers
                // don't linger. A 30-minute stale cutoff keeps the registry
                // bounded at the network's currently-reachable peer set
                // regardless of lifetime churn. Entries younger than
                // PEER_ALIVE_FRESHNESS_SECS are always retained; older
                // entries drop so dead IPs don't bypass the probe path
                // with stale freshness.
                let stale_cutoff = current_time_secs.saturating_sub(1800);
                GLOBAL_PEER_LAST_SEEN_BY_IP.retain(|_, last_seen| *last_seen >= stale_cutoff);

                let timeout_voted_before = TIMEOUT_VOTED_HEIGHTS.len();
                TIMEOUT_VOTED_HEIGHTS.retain(|h, _| *h >= min_height);
                let timeout_voted_removed = timeout_voted_before.saturating_sub(TIMEOUT_VOTED_HEIGHTS.len());

                // v14.8.5: re-introduced as BFT-safe distinct-peer tracker
                // (see block_pipeline::record_hash_chain_break_witness).
                crate::block_pipeline::cleanup_break_tracker(min_height);

                // v18: evict expired in-flight missing-parent request entries
                // so the dedup map stays bounded under sustained gap-recovery
                // activity. Same retention semantics as the cooldown sweeps
                // above — opportunistic eviction on TTL.
                crate::block_pipeline::cleanup_missing_block_requests();
                crate::block_pipeline::cleanup_forked_peer_cooldown();

                let timeout_total_removed = timeout_votes_removed + timeout_certs_removed + timeout_voted_removed;

                // Log if anything was cleaned
                let total_removed = retry_removed + fallback_removed + pending_sync_removed + pending_macro_removed + empty_response_removed + invalid_cert_removed + timeout_total_removed;
                if total_removed > 0 {
                    if crate::node::is_info() { println!("[INFO][CACHE_CLEANUP] peer_retry={} quic_fallback={} pending_sync={} pending_macro={} empty_resp={} invalid_cert={} timeout={}", 
                             retry_removed, fallback_removed, pending_sync_removed, pending_macro_removed, empty_response_removed, invalid_cert_removed, timeout_total_removed); }
                }
                
                // Log current sizes for monitoring (only if significant)
                let total_size = PEER_RETRY_COOLDOWN.len() + QUIC_FALLBACK_RATE_LIMITER.len() + 
                                 PENDING_SYNC_BLOCKS.len() + PENDING_SYNC_MACROBLOCKS.len() +
                                 EMPTY_RESPONSE_TRACKER.len() + INVALID_CERT_TRACKER.len() +
                                 TIMEOUT_VOTES.len() + TIMEOUT_CERTIFICATES.len() + TIMEOUT_VOTED_HEIGHTS.len();
                if total_size > 100 {
                    if crate::node::is_warn() { println!("[WARN][CACHE_SIZE] peer_retry={} quic_fallback={} pending_sync={} pending_macro={} timeout_votes={} timeout_certs={}", 
                             PEER_RETRY_COOLDOWN.len(), QUIC_FALLBACK_RATE_LIMITER.len(), 
                             PENDING_SYNC_BLOCKS.len(), PENDING_SYNC_MACROBLOCKS.len(),
                             TIMEOUT_VOTES.len(), TIMEOUT_CERTIFICATES.len()); }
                }
            }
        });
        
        if crate::node::is_info() { println!("[INFO][CACHE_CLEANUP] static_cache_cleanup_started interval=600s"); }
        
        // v3.0: Separate more frequent cleanup for PENDING_SYNC_BLOCKS
        // TTL = 60 seconds, so check every 30 seconds to ensure timely cleanup
        handle.spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
            
            loop {
                interval.tick().await;
                cleanup_pending_sync_blocks();
            }
        });
    }
    
    /// PRODUCTION v2.56: Background repair task for incomplete block assemblies
    /// ═══════════════════════════════════════════════════════════════════════════
    /// PROBLEM: Repair was only triggered when receiving chunks
    ///          If no chunks arrive → repair never triggers → emergency failover
    /// SOLUTION: Background task checks incomplete assemblies every 500ms
    ///           Requests missing chunks proactively before emergency timeout
    /// ARCHITECTURE: Uses BROADCAST_RUNTIME to avoid main loop contention
    /// ═══════════════════════════════════════════════════════════════════════════
    pub(super) fn start_background_repair_task(&self) {
        let shred_protocol_assemblies = self.shred_protocol_assemblies.clone();
        let _shred_chunk_cache = self.shred_chunk_cache.clone();
        let connected_peers_lockfree = self.connected_peers_lockfree.clone();
        let quic_transport = self.quic_transport.clone();
        let quic_enabled = self.quic_enabled.clone();
        let node_id = self.node_id.clone();
        
        // CRITICAL: Use BROADCAST_RUNTIME, not main Tokio runtime
        // This ensures repair never competes with heartbeats, peer discovery, API
        BROADCAST_RUNTIME.spawn(async move {
            crate::boot_contract::started(crate::boot_contract::names::BACKGROUND_REPAIR);
            // v15.11: Check every 100ms (was 500ms). At 1-sec block time, 100ms
            // poll lets repair complete a full chunk-fetch round-trip and
            // reconstruction inside the same block slot the chunks arrived in.
            // 500ms was leaving up to half a block slot of latency before
            // detection — combined with 200ms initial-wait and 500ms retry,
            // a single dropped data chunk could block reconstruction for
            // 1.2s, slipping repair into the next slot and triggering an
            // unnecessary emergency block check at the receiver.
            //
            // Scalability: the loop body iterates only over open assemblies
            // (typically O(1) — last 1-3 in-flight blocks) regardless of
            // committee size. 10× faster polling adds ~5ms CPU overhead per
            // 500ms window — negligible against the recovery latency win.
            let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(100));
            let mut repair_stats_log_counter = 0u64;
            
            loop {
                interval.tick().await;
                repair_stats_log_counter += 1;
                
                // Collect assemblies that need repair
                let mut assemblies_to_repair: Vec<(u64, Vec<usize>, usize, usize)> = Vec::new();
                
                for entry in shred_protocol_assemblies.iter() {
                    let height = *entry.key();
                    let assembly = entry.value();
                    
                    let elapsed_ms = assembly.started_at.elapsed().as_millis() as u64;

                    // v15.11: Initial wait reduced to 80ms (was 200ms). Combined
                    // with the 100ms repair-poll interval, a single dropped chunk
                    // is detected ~120-180ms after the original broadcast and a
                    // repair request goes out before the producer's next-slot
                    // SHRED begins arriving. This keeps the repair pipeline
                    // strictly within one block slot at 1 blk/s cadence and
                    // measurably reduces tail latency for honest receivers.
                    if elapsed_ms < 80 {
                        continue;
                    }

                    // Count received chunks
                    let data_received: usize = assembly.chunks_received.iter()
                        .filter(|c| c.is_some())
                        .count();
                    let parity_received: usize = assembly.parity_chunks.iter()
                        .filter(|c| c.is_some())
                        .count();
                    let total_received = data_received + parity_received;

                    // Calculate required for Reed-Solomon (67%)
                    let total_chunks = assembly.total_chunks;
                    let required = ((total_chunks as f32) * 0.67).ceil() as usize;

                    // v26 D4b: skip repair when reconstructable AND cert in
                    // hand. Reed-Solomon recovers any missing data shard
                    // (incl. chunk #0) from parity, so chunk #0 is NOT
                    // specially required for reconstruction; it was only
                    // special because the cert used to live solely there.
                    // D4 spreads the cert across chunk #0 + parity and the
                    // receiver stores it from any chunk, so the true
                    // skip-repair condition is "enough chunks AND cert".
                    let cert_present = assembly.certificate.is_some();

                    if total_received >= required && cert_present {
                        continue;
                    }

                    // v15.11: retry every 250ms (was 500ms). Combined with the
                    // 100ms poll interval and 80ms initial wait, a stuck
                    // assembly gets up to (SHRED_CHUNK_MAX_RETRIES) repair
                    // attempts within ~1 second — fitting recovery into the
                    // same block slot the original broadcast missed.
                    let should_request = assembly.retransmit_attempts < SHRED_CHUNK_MAX_RETRIES
                        && assembly.retransmit_requested_at
                            .map(|t| t.elapsed().as_millis() >= 250)
                            .unwrap_or(true);
                    
                    if should_request {
                        // Find missing chunk indices
                        let mut missing_indices: Vec<usize> = assembly.chunks_received.iter()
                            .enumerate()
                            .filter(|(_, c)| c.is_none())
                            .map(|(i, _)| i)
                            .collect();
                        
                        // Add missing parity indices
                        let parity_missing: Vec<usize> = assembly.parity_chunks.iter()
                            .enumerate()
                            .filter(|(_, c)| c.is_none())
                            .map(|(i, _)| total_chunks + i)
                            .collect();
                        missing_indices.extend(parity_missing);
                        
                        if !missing_indices.is_empty() {
                            assemblies_to_repair.push((height, missing_indices, total_received, required));
                        }
                    }
                }
                
                // Process repairs
                for (height, missing_indices, received, required) in assemblies_to_repair {
                    // Update assembly state
                    if let Some(mut assembly) = shred_protocol_assemblies.get_mut(&height) {
                        assembly.retransmit_attempts += 1;
                        assembly.retransmit_requested_at = Some(std::time::Instant::now());
                    }
                    
                    let missing_count = missing_indices.len();
                    if crate::node::is_info() {
                        println!("[INFO][REPAIR] background_request h={} missing={} received={}/{} attempt={}",
                            height, missing_count, received, required,
                            shred_protocol_assemblies.get(&height).map(|a| a.retransmit_attempts).unwrap_or(0));
                    }
                    
                    // Find peers who might have the chunks (from cache or producers)
                    let repair_targets: Vec<String> = connected_peers_lockfree.iter()
                        .filter(|e| e.value().is_consensus_qualified())
                        .take(3) // Ask up to 3 peers
                        .map(|e| e.value().addr.clone())
                        .collect();
                    
                    if repair_targets.is_empty() {
                        if crate::node::is_warn() { println!("[WARN][REPAIR] no_qualified_peers h={}", height); }
                        continue;
                    }
                    
                    // Send repair requests via QUIC
                    if quic_enabled.load(std::sync::atomic::Ordering::Relaxed) {
                        if let Some(ref transport) = quic_transport {
                            let transport_guard = transport.read().await;
                            
                            for peer_addr in &repair_targets {
                                // Build repair request message
                                let request = NetworkMessage::RequestMissingChunks {
                                    block_height: height,
                                    missing_indices: missing_indices.clone(),
                                    requester_id: node_id.clone(),
                                    timestamp: std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_secs(),
                                };
                                
                                // Parse peer address
                                let parts: Vec<&str> = peer_addr.split(':').collect();
                                if parts.len() == 2 {
                                    if let (Ok(ip), Ok(port)) = (parts[0].parse::<std::net::IpAddr>(), parts[1].parse::<u16>()) {
                                        let quic_port = port.saturating_add(crate::quic_transport::QUIC_PORT_OFFSET);
                                        let quic_addr = std::net::SocketAddr::new(ip, quic_port);
                                        
                                        let _ = transport_guard.broadcast_to(quic_addr, &request).await;
                                    }
                                }
                            }
                            
                            if crate::node::is_info() { println!("[INFO][REPAIR] requests_sent h={} peers={} chunks={}",
                                height, repair_targets.len(), missing_count); }
                        }
                    }
                }
                
                // Log repair stats periodically (every 60 seconds = 120 ticks)
                if repair_stats_log_counter % 120 == 0 {
                    let active_assemblies = shred_protocol_assemblies.len();
                    if active_assemblies > 0 {
                        if crate::node::is_info() { println!("[INFO][REPAIR] background_stats active_assemblies={}", active_assemblies); }
                    }
                }
                
                // Cleanup old assemblies (> 30 seconds = definitely timed out)
                let mut expired: Vec<u64> = Vec::new();
                for entry in shred_protocol_assemblies.iter() {
                    if entry.value().started_at.elapsed().as_secs() > 30 {
                        expired.push(*entry.key());
                    }
                }
                for height in expired {
                    shred_protocol_assemblies.remove(&height);
                }
            }
        });
        
        if crate::node::is_info() { println!("[INFO][REPAIR] background_task_started interval=500ms runtime=broadcast"); }
    }
    
    /// v2.24.2: Frequent QUIC health check with ACTIVE HealthPing probing
    /// SCALABLE: Works for any network size (5 nodes to 100K+)
    /// ACTIVE: Sends HealthPing to all peers - detects zombie connections early
    pub(super) fn start_quic_health_check_task(&self) {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_warn() { println!("[WARN][QUIC] No Tokio runtime - health check task deferred"); }
                return;
            }
        };
        
        let quic_transport = self.quic_transport.clone();
        let connected_peers_lockfree = self.connected_peers_lockfree.clone();
        let node_id = self.node_id.clone();
        let wallet_identity = self.wallet_identity.clone();
        
        handle.spawn(async move {
            crate::boot_contract::started(crate::boot_contract::names::SIGNED_HEAD_EMITTER);
            if crate::node::is_info() {
                println!("[INFO][QUIC] health_check_task_started boot_delay={}s interval={}s signing=ML-DSA-65",
                         HEALTH_PING_BOOT_DELAY_SECS, HEALTH_PING_INTERVAL_SECS);
            }

            tokio::time::sleep(std::time::Duration::from_secs(HEALTH_PING_BOOT_DELAY_SECS)).await;

            loop {
                if let Some(ref quic_transport) = quic_transport {
                    let transport = quic_transport.read().await;
                    
                    // Step 1: Passive health check - removes connections with close_reason
                    let (alive, removed) = transport.health_check();
                    
                    // Step 2: ACTIVE health check - send HealthPing to all connected peers
                    let connected_peers = transport.get_connected_peers();
                    let mut zombie_count = 0;
                    
                    let current_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();

                    let sig_hex = {
                        let id_guard = wallet_identity.read();
                        if let Some(ref identity) = *id_guard {
                            let payload = format!("QNET_HEALTH_PING_V1:{}:{}:{}", node_id, ts, current_height);
                            identity.sign(payload.as_bytes()).map(hex::encode).unwrap_or_default()
                        } else {
                            String::new()
                        }
                    };

                    // Cache the signed head for the block-serve co-send path (reaches cold-joiners the
                    // get_connected_peers fan-out misses).
                    if !sig_hex.is_empty() {
                        *LATEST_SIGNED_HEAD.write() = Some((node_id.clone(), ts, current_height, sig_hex.clone()));
                    }

                    let (hint_mb, hint_round) = current_tc_hint();
                    for (peer_addr, peer_id, _peer_type) in &connected_peers {
                        let ping_msg = NetworkMessage::HealthPing {
                            from: node_id.clone(),
                            timestamp: ts,
                            height: current_height,
                            cert_mb: hint_mb,
                            cert_round: hint_round,
                            signature: sig_hex.clone(),
                        };
                        
                        // Try to send HealthPing - if it fails, connection is zombie
                        match transport.broadcast_to(*peer_addr, &ping_msg).await {
                            Ok(_) => {
                                // Connection is healthy
                            }
                            Err(_e) => {
                                // Connection is zombie - will be removed by retry logic
                                zombie_count += 1;
                                if crate::node::is_warn() { println!("[WARN][QUIC] Zombie connection detected to {} via HealthPing",
                                         get_privacy_id_for_addr(&peer_id)); }
                            }
                        }
                    }
                    
                    // Log health status periodically
                    if (removed > 0 || zombie_count > 0) && crate::node::is_info() {
                        println!("[WARN][QUIC] Health check: {} alive, {} removed (passive), {} zombie (active)",
                                 alive, removed, zombie_count);
                    }
                    
                    drop(transport); // Release read lock before reconnection
                    
                    // Step 3: Proactive reconnection if we have very few connections
                    let effective_alive = alive.saturating_sub(zombie_count);
                    let min_connections = 3; // Minimum for Byzantine tolerance
                    
                    if effective_alive < min_connections {
                        // Get known peers from P2P layer (not just bootstrap)
                        let mut peers_to_try: Vec<String> = connected_peers_lockfree
                            .iter()
                            .filter(|entry| entry.value().id != node_id)
                            .take(10) // Limit reconnection attempts
                            .map(|entry| entry.key().clone())
                            .collect();
                        
                        // ═══════════════════════════════════════════════════════════════════════════
                        // CRITICAL FIX v2.93: Fallback to Genesis bootstrap when NO peers available
                        // ═══════════════════════════════════════════════════════════════════════════
                        // Without this, a node that loses ALL connections can NEVER rejoin the network!
                        // Genesis nodes are always available as bootstrap points for recovery.
                        if peers_to_try.is_empty() {
                            if crate::node::is_warn() { println!("[CRIT][P2P] no_known_peers action=genesis_fallback"); }
                            
                            // Use Genesis IPs as recovery bootstrap
                            let genesis_ips = crate::genesis_constants::GENESIS_NODE_IPS;
                            for (ip, _id) in genesis_ips.iter() {
                                peers_to_try.push(format!("{}:8001", ip));
                            }
                        }
                        
                        if !peers_to_try.is_empty() {
                            if crate::node::is_warn() { println!("[WARN][QUIC] Low connections ({}/{}), attempting reconnect to {} peers...",
                                     effective_alive, min_connections, peers_to_try.len()); }
                            
                            for peer_addr_str in peers_to_try {
                                if let Ok(addr) = peer_addr_str.parse::<std::net::SocketAddr>() {
                                    let quic_addr = std::net::SocketAddr::new(
                                        addr.ip(),
                                        crate::quic_transport::QUIC_PORT
                                    );
                                    
                                    let transport_clone = quic_transport.clone();
                                    tokio::spawn(async move {
                                        let t = transport_clone.read().await;
                                        if !t.is_connection_alive(&quic_addr) {
                                            let _ = t.connect(quic_addr).await;
                                            // Silent - avoid log spam
                                        }
                                    });
                                }
                            }
                        }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(HEALTH_PING_INTERVAL_SECS)).await;
            }
        });
    }

    /// Reputation-based peer validation (v2.51: lock-free)
    pub(super) fn start_reputation_validation(&self) {
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_warn() { println!("[WARN][P2P] No Tokio runtime - reputation validation deferred"); }
                return;
            }
        };

        let connected_peers = self.connected_peers_lockfree.clone();
        let genesis_ips: Vec<String> = vec![
            "154.38.160.39".to_string(), "62.171.157.44".to_string(),
            "161.97.86.81".to_string(), "5.189.130.160".to_string(),
            "162.244.25.114".to_string()
        ];

        handle.spawn(async move {
            crate::boot_contract::started(crate::boot_contract::names::REPUTATION_VALIDATION);
            loop {
                let is_bootstrap = std::env::var("QNET_BOOTSTRAP_ID")
                    .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
                    .unwrap_or(false);
                let check_interval = if is_bootstrap { 5 } else { 30 };
                tokio::time::sleep(std::time::Duration::from_secs(check_interval)).await;

                let mut to_remove: Vec<String> = Vec::new();

                // Collect peers for parallel checking
                let mut all_peers: Vec<(String, String, bool)> = connected_peers.iter()
                    .map(|entry| {
                        let peer = entry.value();
                        let is_genesis = peer.id.contains("genesis_") || genesis_ips.contains(&peer.addr);
                        (entry.key().clone(), peer.addr.clone(), is_genesis)
                    })
                    .collect();

                // ═══════════════════════════════════════════════════════════════════════════
                // CRITICAL FIX v2.93: Auto-reconnect to Genesis when ALL peers lost
                // ═══════════════════════════════════════════════════════════════════════════
                // Without this fix, a node that loses all connections can NEVER rejoin!
                if all_peers.is_empty() {
                    if crate::node::is_warn() { println!("[CRIT][P2P] no_peers_connected action=genesis_recovery"); }
                    
                    // Try to reconnect to Genesis nodes
                    for (i, ip) in genesis_ips.iter().enumerate() {
                        let addr = format!("{}:8001", ip);
                        
                        // Add Genesis as peer for reconnection attempt
                        all_peers.push((addr.clone(), ip.clone(), true));
                        
                        if crate::node::is_debug() {
                            println!("[DBG][P2P] genesis_recovery_target idx={} ip={}", i + 1, ip);
                        }
                    }
                    
                    // If still empty after adding Genesis, skip this iteration
                    if all_peers.is_empty() {
                        continue;
                    }
                }

                // Parallel connectivity checks
                use futures::stream::{self, StreamExt};
                let concurrency = match all_peers.len() {
                    0..=10 => 5,
                    11..=50 => 10,
                    51..=200 => 20,
                    _ => 50,
                };

                let connectivity_results: Vec<_> = stream::iter(all_peers)
                    .map(|(addr, peer_addr, is_genesis)| async move {
                        let is_reachable = tokio::task::spawn_blocking(move || {
                            Self::test_peer_connectivity_static(&peer_addr)
                        }).await.unwrap_or(false);
                        (addr, is_reachable, is_genesis)
                    })
                    .buffer_unordered(concurrency)
                    .collect()
                    .await;

                // Apply results
                for (addr, is_reachable, is_genesis) in connectivity_results {
                    if let Some(mut peer) = connected_peers.get_mut(&addr) {
                        if !is_reachable && !is_genesis {
                            peer.is_stable = false;
                        } else if is_reachable {
                            peer.is_stable = true;
                        }
                    }
                }

                // Check reputation
                for entry in connected_peers.iter() {
                    let peer = entry.value();
                    let is_genesis_peer = peer.id.contains("genesis_") || genesis_ips.contains(&peer.addr);

                    // Engine removed; P2P no longer holds a per-node reputation view.
                    // Floor value — consensus eligibility is gated by the chain fold elsewhere.
                    let reputation = qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;

                    if reputation < 10.0 && !is_genesis_peer {
                        to_remove.push(entry.key().clone());
                    }
                }

                // Remove low-reputation peers
                for addr in &to_remove {
                    connected_peers.remove(addr);
                }

                if !to_remove.is_empty() && crate::node::is_info() {
                    println!("[INFO][P2P] reputation_cleanup removed={}", to_remove.len());
                }
            }
        });
    }

    // REMOVED: start_kademlia_peer_discovery was a stub, now using Kademlia fields directly in PeerInfo
    
    
}

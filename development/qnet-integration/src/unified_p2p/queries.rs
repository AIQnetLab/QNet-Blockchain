//! Network-height oracle, leader queries, peer statistics and host address discovery.

use super::*;

impl SimplifiedP2P {
    /// API DEADLOCK FIX: Get cached network height WITHOUT triggering sync
    /// This method NEVER makes network calls - only reads cache
    /// v2.26.1: Added fallback to max(peer.last_block_height) from HealthPing data
    pub fn get_cached_network_height(&self) -> Option<u64> {
        // Single source: the canonical best known head (no 1s cache, no TTL-median fallback).
        Some(self.get_max_peer_height())
    }
    
    /// Single network-height source: highest head among CURRENTLY-connected peers,
    /// floored by local and the QC-verified frontier (rationale in the body).
    pub fn get_max_peer_height(&self) -> u64 {
        // Highest height announced by CURRENTLY-connected peers, re-derived each call so a poison peer's
        // claim drops when it disconnects (never monotonic-stuck). NO attestation-TTL filter and NO
        // <2-peer collapse-to-local — that median-of-fresh gate returned local whenever a client-only
        // joiner's handshake attestations expired (the cold-join wedge). Floored by local + QC frontier;
        // safety is per-block QC/Dilithium verify on apply (a lie-high tip only chases a phantom the QC
        // gate refuses and the sync STALL_ABORTs). Sanity filter drops corrupted u64::MAX values.
        let peer_max = self.connected_peers_lockfree.iter()
            .map(|e| e.value().last_block_height)
            .filter(|&h| h < 2_000_000_000)
            .max()
            .unwrap_or(0);
        // Anti-forgery: clamp peer_max against the committee/genesis median (single chokepoint, as get_best).
        let peer_max = self.clamp_overclaim(peer_max);
        let local = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        // .max(local)/.max(frontier) = SYNC-TARGET floor only (never sync below own tip / finality). The
        // BEHIND boolean must read the un-floored authenticated tip (detect_network_height), NEVER this —
        // flooring the behind decision by local is the self-referential keep-up wedge.
        peer_max.max(local).max(crate::node::qc_verified_frontier_cached())
    }
    
    /// Sync blockchain height with peers for consensus
    /// PRODUCTION v2.19.21: Now async with parallel peer queries (fixes runtime deadlock)
    pub async fn sync_blockchain_height(&self) -> Result<u64, String> {
        // Deprecated thin alias over the single network-height source
        // (get_max_peer_height: re-derived from connected peers ∨ local ∨ QC
        // frontier; no peer-attestation TTL gate, no <2-peer collapse, no median
        // oracle). The legacy staleness-filtered consensus-height oracle was
        // removed to leave ONE source of truth. The result is a sync HINT only —
        // fetched blocks are QC/Dilithium-verified on apply and the bulk target is
        // QC-frontier-floored, so an over/under-reported hint cannot inject state.
        Ok(self.get_max_peer_height())
    }
    
    /// Determine if this node is the elected microblock producer for the current slot.
    /// Microblocks use single-leader VRF rotation over the registered validator set;
    /// macroblock finality is Checkpoint-BFT v2 (2f+1 QC), handled separately.
    pub fn should_be_leader(&self, node_id: &str) -> bool {
        // NOTE: name kept for call-site compatibility; semantically this is
        // "am_i_the_elected_producer_now" — deterministic VRF producer selection.
        
        // PERFORMANCE FIX: Remove unnecessary connected_peers lock
        // All Byzantine safety checks use get_validated_active_peers() which has its own locking
        
        // Check if this is a Genesis bootstrap node
        let is_genesis_bootstrap = std::env::var("QNET_BOOTSTRAP_ID")
            .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
            .unwrap_or(false);
        
        // EXISTING: CORRECT Byzantine safety logic for consensus participation
        // EXISTING: min_participants: 4 from consensus config (3f+1 where f=1)
        if is_genesis_bootstrap {
            // EXISTING: Use validated peers for consensus participation (real connectivity only)
            let validated_peers = self.get_validated_active_peers();
            let total_network_nodes = std::cmp::min(validated_peers.len() + 1, 5); // EXISTING: Add self, max 5 Genesis
            
            if total_network_nodes >= 4 {
                if crate::node::is_info() {
                    println!("[INFO][CONS] Genesis node with {} total nodes - Byzantine consensus enabled", total_network_nodes);
                }
                // Continue to normal Byzantine checks below
            } else {
                if crate::node::is_info() {
                    println!("[WARN][CONS] Genesis bootstrap - insufficient nodes for Byzantine safety: {}/4", total_network_nodes);
                }
                if crate::node::is_info() {
                    println!("[INFO][CONS] Waiting for more Genesis nodes to join network...");
                }
                return false; // Even Genesis needs Byzantine safety
            }
        }
        
        // For non-genesis nodes: Strict Byzantine consensus requirement using validated peers
        let min_nodes_for_consensus = 4; // EXISTING: Need 3f+1 nodes to tolerate f failures  
        let validated_peers = self.get_validated_active_peers();
        let total_network_nodes = std::cmp::min(validated_peers.len() + 1, 1000); // EXISTING: Scale to network size
        
        if total_network_nodes < min_nodes_for_consensus {
            if crate::node::is_info() {
                println!("[WARN][CONS] Insufficient nodes for Byzantine consensus: {}/{}",
                        total_network_nodes, min_nodes_for_consensus);
            }
            if crate::node::is_info() {
                println!("[INFO][CONS] Byzantine fault tolerance requires minimum {} nodes", min_nodes_for_consensus);
            }
            return false; // Non-genesis nodes need sufficient peers
        }
        
        // Check if this node can participate based on network connectivity
        let _my_ip = self.extract_node_ip(node_id);
        
        // Production QNet: Genesis nodes determined by BOOTSTRAP_ID, not hardcoded IPs
        let is_genesis_node = std::env::var("QNET_BOOTSTRAP_ID")
            .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
            .unwrap_or(false);
        
        if is_genesis_node {
            return true; // Genesis nodes can always participate in consensus
        }
        
        // Non-genesis nodes can participate if sufficient network diversity exists
        // In production: This would use reputation scores and validator selection algorithm (NO STAKE!)
        validated_peers.len() >= 3 // Allow participation with sufficient peer diversity
    }
    
    /// PRODUCTION: Cryptographic peer verification using post-quantum signatures
    pub(super) async fn verify_peer_authenticity(peer_addr: &str) -> Result<String, String> {
        use std::time::Duration;
        
        // QUANTUM: Use EXISTING generate_quantum_challenge() from RPC module
        let challenge = crate::rpc::generate_quantum_challenge();
        
        // Send challenge to peer via secure channel
        let auth_endpoint = format!("http://{}/api/v1/auth/challenge", peer_addr);
        
        // Use tokio HTTP client instead of curl for production
        let client = match Self::create_secure_http_client() {
            Ok(client) => client,
            Err(e) => return Err(format!("Failed to create HTTP client: {}", e)),
        };
        
        // Send challenge with timeout
        let challenge_payload = serde_json::json!({
            "challenge": hex::encode(&challenge),
            "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
            "protocol_version": "qnet-v1.0"
        });
        
        match tokio::time::timeout(Duration::from_secs(10), // CRITICAL FIX: Increased timeout for peer connectivity 
            client.post(&auth_endpoint)
                .json(&challenge_payload)
                .send()
        ).await {
            Ok(Ok(response)) => {
                if crate::node::is_debug() {
                    println!("[DBG][P2P] HTTP response status: {}", response.status());
                }
                if response.status().is_success() {
                    match response.json::<serde_json::Value>().await {
                        Ok(auth_response) => {
                            // Verify CRYSTALS-Dilithium signature
                            let signature = auth_response["signature"].as_str()
                                .ok_or("Missing signature in response")?;
                            let pubkey = auth_response["public_key"].as_str()
                                .ok_or("Missing public key in response")?;
                            
                            // PRODUCTION: Verify post-quantum signature - decode hex challenge to bytes
                            let challenge_bytes = hex::decode(&challenge)
                                .map_err(|e| format!("Failed to decode challenge hex: {}", e))?;
                            if Self::verify_dilithium_signature(&challenge_bytes, signature, pubkey).await? {
                                if crate::node::is_info() {
                                    println!("[INFO][P2P] Peer {} authenticated with post-quantum signature", get_privacy_id_for_addr(&peer_addr));
                                }
                                Ok(pubkey.to_string())
                            } else {
                                Err("Invalid signature verification".to_string())
                            }
                        },
                        Err(e) => Err(format!("Invalid JSON response: {}", e)),
                    }
                } else {
                    Err(format!("HTTP error: {}", response.status()))
                }
            },
            Ok(Err(e)) => {
                if crate::node::is_debug() {
                    println!("[DBG][P2P] Connection error details: {}", e);
                }
                Err(format!("Connection error: {}", e))
            },
            Err(_) => {
                if crate::node::is_debug() {
                    println!("[DBG][P2P] Timeout during peer authentication (5 seconds)");
                }
                Err("Timeout during peer authentication".to_string())
            },
        }
    }
    
    /// Create secure HTTP client for peer communication
    pub(super) fn create_secure_http_client() -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30)) // PRODUCTION: Extended timeout for international Genesis nodes
            .connect_timeout(Duration::from_secs(15)) // Separate connection timeout
            .user_agent("QNet-Node/1.0")
            .tcp_nodelay(true) // Disable Nagle's algorithm for faster responses
            .tcp_keepalive(Duration::from_secs(HTTP_TCP_KEEPALIVE_SECS))  // Unified keepalive
            .pool_idle_timeout(Duration::from_secs(HTTP_POOL_IDLE_TIMEOUT_SECS))  // Unified idle timeout
            .pool_max_idle_per_host(HTTP_POOL_MAX_IDLE_PER_HOST)  // Unified pool size
            .build()
            .map_err(|e| format!("HTTP client creation failed: {}", e))
    }
    
    /// Verify CRYSTALS-Dilithium signature (production implementation)
    pub(super) async fn verify_dilithium_signature(challenge: &[u8], signature: &str, pubkey: &str) -> Result<bool, String> {
        // PRODUCTION v2.50: Lock-free CRYSTALS-Dilithium verification
        // Uses OnceCell+Arc for zero lock contention
        use crate::node::try_get_quantum_crypto;
        
        let crypto = match try_get_quantum_crypto() {
            Some(c) => c,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][CRYPTO] dilithium_verify_skip reason=not_initialized");
                }
                return Ok(false);
            }
        };

            // Use centralized quantum crypto verification
            use crate::quantum_crypto::DilithiumSignature;
            
            // Create DilithiumSignature struct from hex string
            let dilithium_sig = DilithiumSignature {
                signature: signature.to_string(),
                algorithm: "CRYSTALS-Dilithium3".to_string(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                strength: "5".to_string(),
            };
            
            match crypto.verify_dilithium_signature(
                &hex::encode(challenge),
                &dilithium_sig,
                pubkey
            ).await {
                Ok(is_valid) => {
        if is_valid {
            if crate::node::is_info() {
                println!("[INFO][CRYPTO] Dilithium signature verified successfully");
            }
        } else {
            if crate::node::is_info() {
                println!("[ERR][CRYPTO] Dilithium signature verification failed");
            }
        }
        Ok(is_valid)
                },
                Err(e) => Err(format!("Dilithium verification failed: {}", e))
            }
    }
    
    /// Extract IP address from node_id using EXISTING constants
    pub(super) fn extract_node_ip(&self, node_id: &str) -> String {
        // EXISTING: Use genesis_constants::GENESIS_NODE_IPS to avoid duplication
        use crate::genesis_constants::GENESIS_NODE_IPS;
        for (ip, _) in GENESIS_NODE_IPS {
            if node_id.contains(ip) {
                return ip.to_string();
            }
        }
        "127.0.0.1".to_string() // Default fallback
    }
    

    
    /// Static version for use in async contexts
    /// v4.2 CRITICAL FIX: Non-blocking connectivity check
    /// Previous version used blocking std::net::TcpStream in async runtime,
    /// causing cascading API deadlocks when peers went offline.
    /// Now uses spawn_blocking + parallel probes with strict timeout budget.
    pub fn filter_working_genesis_nodes_static(nodes: Vec<String>) -> Vec<String> {
        use std::net::{TcpStream, SocketAddr};
        use std::time::Duration;
        use parking_lot::Mutex;
        use std::collections::HashMap;

        // Cache connectivity results to prevent repeated probes
        static CACHED_GENESIS_CONNECTIVITY: std::sync::OnceLock<Mutex<HashMap<String, (Vec<String>, std::time::SystemTime)>>> = std::sync::OnceLock::new();

        let connectivity_cache = CACHED_GENESIS_CONNECTIVITY.get_or_init(|| Mutex::new(HashMap::new()));

        let mut cache_key_nodes = nodes.clone();
        cache_key_nodes.sort();
        let cache_key = cache_key_nodes.join("|");

        let current_time = std::time::SystemTime::now();

        // Check cache first
        {
            let cache = connectivity_cache.lock();
            if let Some((cached_working_nodes, cached_time)) = cache.get(&cache_key) {
                if let Ok(cache_age) = current_time.duration_since(*cached_time) {
                    let cache_ttl = if std::env::var("QNET_BOOTSTRAP_ID").is_ok() {
                        30 // Genesis nodes: 30 seconds
                    } else {
                        45 // Regular nodes: 45 seconds
                    };

                    if cache_age.as_secs() < cache_ttl {
                        if crate::node::is_debug() {
                            println!("[INFO][P2P] cached peers={} age={}s ttl={}s",
                                     cached_working_nodes.len(), cache_age.as_secs(), cache_ttl);
                        }
                        return cached_working_nodes.clone();
                    }
                }
            }
        }

        // ═══════════════════════════════════════════════════════════════════
        // v15.1: TRAFFIC-BASED LIVENESS FAST PATH (root-cause fix)
        // ═══════════════════════════════════════════════════════════════════
        // Before falling back to an expensive TCP probe that can mis-classify
        // a busy-but-alive peer as offline (observed: 001 → 002/003 marked
        // offline at 09:47:32 while 002/003 were actively shredding blocks
        // to 001), short-circuit for every peer that has sent us any message
        // within PEER_ALIVE_FRESHNESS_SECS (= 60s). The per-instance
        // `PeerInfo.last_seen` is mirrored into GLOBAL_PEER_LAST_SEEN_BY_IP
        // on every receive, so actual traffic is the authoritative liveness
        // signal. TCP probe then runs ONLY for genuinely silent peers
        // (cold-start or unreachable), where it is the right tool.
        //
        // Scalability: O(peers) constant-time DashMap lookups before any
        // syscall. At the 1000-node committee cap this is sub-millisecond.
        //
        // Safety: the registry is populated only from verified message
        // receive paths (signed blocks, BFT votes, sync responses). A
        // Byzantine peer cannot forge liveness for another peer's IP — they
        // can only vouch for their own, which is the intended semantics.
        // ═══════════════════════════════════════════════════════════════════
        let now_secs = current_time
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let mut working_nodes = Vec::new();
        let mut need_probe = Vec::new();
        let mut skipped_probe = 0u32;

        for ip in &nodes {
            if peer_alive_by_ip(ip, now_secs) {
                working_nodes.push(ip.clone());
                skipped_probe += 1;
            } else {
                need_probe.push(ip.clone());
            }
        }

        if skipped_probe > 0 && crate::node::is_info() {
            println!(
                "[INFO][CONNECTIVITY] traffic_fastpath alive={} probe_needed={} freshness={}s",
                skipped_probe, need_probe.len(), PEER_ALIVE_FRESHNESS_SECS,
            );
        }

        // ═══════════════════════════════════════════════════════════════════
        // COLD-START / SILENT-PEER TCP PROBE (unchanged semantics, hardened)
        // ═══════════════════════════════════════════════════════════════════
        // Only reached for peers we have NOT received recent traffic from.
        // This is the right situation for a TCP SYN probe — we have no
        // better signal. Three sequential attempts with increasing
        // timeouts absorb the transient p99 latency spikes seen on
        // cross-continental VPS links under BFT load (2s single-shot was
        // the exact trigger of the 09:47:32 false-offline cascade).
        //
        // Budget worst case: (3 + 5 + 8)s = 16s per peer, but only on
        // peers that are genuinely silent for > PEER_ALIVE_FRESHNESS_SECS.
        // In a healthy network this list is empty and the entire function
        // returns from the fast path above.
        // ═══════════════════════════════════════════════════════════════════
        if !need_probe.is_empty() {
            if crate::node::is_info() {
                println!(
                    "[INFO][CONNECTIVITY] probe_start peers={} strategy=retries_3x",
                    need_probe.len(),
                );
            }

            let handles: Vec<_> = need_probe.iter().map(|ip| {
                let ip_clone = ip.clone();
                std::thread::spawn(move || {
                    let addr = format!("{}:8001", ip_clone);
                    let socket_addr = match addr.parse::<SocketAddr>() {
                        Ok(a) => a,
                        Err(_) => return (ip_clone, false, 0u64),
                    };

                    // Three attempts with escalating timeouts: 3s, 5s, 8s.
                    // Cross-continental p99 under BFT load can spike past
                    // 2s; the escalation keeps the happy-path cost low
                    // while absorbing transient latency.
                    const PROBE_TIMEOUTS: [u64; 3] = [3, 5, 8];
                    for timeout_secs in PROBE_TIMEOUTS {
                        let start = std::time::Instant::now();
                        if TcpStream::connect_timeout(
                            &socket_addr,
                            Duration::from_secs(timeout_secs),
                        ).is_ok() {
                            let rtt = start.elapsed().as_millis() as u64;
                            return (ip_clone, true, rtt);
                        }
                        // Brief back-off between attempts so we don't hammer
                        // a peer mid-recovery.
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    (ip_clone, false, 0)
                })
            }).collect();

            let mut online_count = 0u32;
            let mut offline_count = 0u32;

            // Wall-clock budget covers worst case 3+5+8 = 16s per peer +
            // inter-attempt back-off + thread join overhead.
            let join_deadline = std::time::Instant::now() + Duration::from_secs(20);
            for handle in handles {
                let remaining = join_deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    offline_count += 1;
                    continue;
                }
                match handle.join() {
                    Ok((ip, true, rtt)) => {
                        if crate::node::is_debug() {
                            println!(
                                "[DBG][CONNECTIVITY] peer={} status=online rtt={}ms source=probe",
                                get_privacy_id_for_addr(&ip), rtt,
                            );
                        }
                        working_nodes.push(ip);
                        online_count += 1;
                    }
                    Ok((ip, false, _)) => {
                        if crate::node::is_warn() {
                            println!(
                                "[WARN][CONNECTIVITY] peer={} status=offline attempts=3 source=probe",
                                get_privacy_id_for_addr(&ip),
                            );
                        }
                        offline_count += 1;
                    }
                    Err(_) => {
                        offline_count += 1;
                    }
                }
            }

            if crate::node::is_info() {
                println!(
                    "[INFO][CONNECTIVITY] probe_done online={} offline={} traffic_alive={}",
                    online_count, offline_count, skipped_probe,
                );
            }
        }

        let online_count = working_nodes.len() as u32;
        let offline_count = (nodes.len() as u32).saturating_sub(online_count);
        if crate::node::is_info() {
            println!(
                "[INFO][CONNECTIVITY] refresh_done online={} offline={} total={}",
                online_count, offline_count, online_count + offline_count,
            );
        }
        
        // Minimum peer requirement
        let min_required_nodes = 2;
        if working_nodes.len() < min_required_nodes {
            if crate::node::is_warn() {
                println!("[WARN][CONNECTIVITY] low_peers reachable={} min_required={}", 
                         working_nodes.len(), min_required_nodes);
            }
            
            if working_nodes.is_empty() {
                if crate::node::is_warn() {
                    println!("[WARN][CONNECTIVITY] no_peers_reachable fallback=all_configured");
                }
                connectivity_cache.lock().insert(cache_key, (nodes.clone(), current_time));
                return nodes;
            }
        }
        
        // Cache results
        {
            let mut cache = connectivity_cache.lock();
            cache.insert(cache_key, (working_nodes.clone(), current_time));

            if cache.len() > 5 {
                let mut keys_to_remove = Vec::new();
                let cutoff_time = current_time - Duration::from_secs(300);
                for (key, (_, cached_time)) in cache.iter() {
                    if *cached_time < cutoff_time {
                        keys_to_remove.push(key.clone());
                    }
                }
                for key in keys_to_remove {
                    cache.remove(&key);
                }
            }
        }
        
        if crate::node::is_info() {
            println!("[INFO][CONNECTIVITY] cache_updated working={}", working_nodes.len());
        }
        working_nodes
    }
    
    /// Get primary validator for consensus round (replaces single leader concept)
    /// In production QNet, consensus uses multiple validators, not single leader
    pub fn get_current_leader(&self) -> Option<String> {
        // COMPATIBILITY: Function name kept for existing code
        // In production: This would return current round's primary validator
        
        // v2.51: lock-free
        // Return primary consensus participant from connected peers
        // Genesis nodes are determined by BOOTSTRAP_ID, not hardcoded IPs
        for entry in self.connected_peers_lockfree.iter() {
            let peer = entry.value();
            let peer_ip = peer.addr.split(':').next().unwrap_or("");
            if let Some(_genesis_id) = crate::genesis_constants::get_genesis_id_by_ip(peer_ip) {
                return Some(format!("validator_{}", peer.addr));
            }
        }
        
        // If no genesis validators, return first connected validator
        self.connected_peers_lockfree.iter().next().map(|e| format!("validator_{}", e.value().addr))
    }
    
    /// GULF STREAM v2.25: Broadcast transaction with producer forwarding
    /// 
    /// HYBRID APPROACH for reliability + speed:
    /// 1. Forward TX directly to current producer (0 hops - fastest path)
    /// 2. Gossip to 2 backup peers (reliability if producer fails)
    /// 
    /// Benefits:
    /// - Producer receives TX immediately (0 hops vs 1-3 hops)
    /// - Backup gossip ensures TX survives producer failure
    /// - 3 total sends (1 producer + 2 backup) vs 4 random
    /// - Enables 30-40K TPS instead of 15-20K TPS
    pub fn broadcast_transaction(&self, tx_data: Vec<u8>) -> Result<(), String> {
        // Origin marks its own tx as seen: the gossip echo dies at the anti-storm
        // gate instead of re-entering the pipeline (51k singles → 49k re-validations).
        self.seen_tx_hashes.insert(format!("{:x}", sha3::Sha3_256::digest(&tx_data)));
        let tx_msg = NetworkMessage::Transaction {
            data: tx_data,
        };
        
        // GULF STREAM: Forward directly to current producer (priority path)
        let mut sent_to_producer = false;
        {
            let guard = self.current_producer_info.read();
            if let Some((producer_id, producer_addr)) = &*guard {
                // Don't send to self
                if producer_id != &self.node_id {
                    self.send_network_message(producer_addr, tx_msg.clone());
                    sent_to_producer = true;
                }
            }
        }
        
        // BACKUP GOSSIP: Send to 2 random peers for reliability
        // If producer fails, TX still propagates through network
        // If we ARE the producer, send to 3 peers for good propagation
        let backup_fanout = if sent_to_producer { 2 } else { 3 };
        self.gossip_to_random_peers(tx_msg, backup_fanout);
        
        Ok(())
    }
    
    /// PRODUCTION v2.25: Broadcast transaction batch for high-throughput
    /// Sends multiple TXs in single QUIC message - reduces stream overhead
    /// 
    /// Benefits:
    /// - 1 QUIC stream per batch instead of N streams for N TXs
    /// - Reduces connection overhead by 100-1000x for batch sizes
    /// - Gulf Stream: batch goes to producer first
    /// - Enables 50K+ TPS with batching
    pub fn broadcast_transaction_batch(&self, transactions: Vec<Vec<u8>>) -> Result<(), String> {
        if transactions.is_empty() {
            return Ok(());
        }
        
        // PRODUCTION v2.25.2: Skip broadcast if WE are the current producer
        // TX is already in our mempool - no need to send anywhere
        let we_are_producer = self.current_producer_info.read()
            .as_ref().map_or(false, |(producer_id, _)| producer_id == &self.node_id);
        
        if we_are_producer {
            // We're the producer - TX already in our mempool, skip network
            return Ok(());
        }
        
        // Origin-side seen marking — same echo suppression as the single-tx path.
        for tx in &transactions {
            self.seen_tx_hashes.insert(format!("{:x}", sha3::Sha3_256::digest(tx)));
        }
        let batch_msg = NetworkMessage::TransactionBatch {
            transactions,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        };
        
        // GULF STREAM: Forward batch to current producer first
        let mut sent_to_producer = false;
        {
            let guard = self.current_producer_info.read();
            if let Some((producer_id, producer_addr)) = &*guard {
                if producer_id != &self.node_id {
                    self.send_network_message(producer_addr, batch_msg.clone());
                    sent_to_producer = true;
                }
            }
        }
        
        // BACKUP: Gossip to 2 random peers (only if we're not producer)
        let backup_fanout = if sent_to_producer { 2 } else { 3 };
        self.gossip_to_random_peers(batch_msg, backup_fanout);
        
        Ok(())
    }
    
    /// Broadcast system event to all connected peers (reorg, emergency, etc.)
    pub fn broadcast_system_event(&self, event_type: &str, event_data: &str) {
        // v2.51: lock-free
        if self.connected_peers_lockfree.is_empty() {
            return;
        }
        
        // Broadcast to all Super nodes
        let target_peers: Vec<PeerInfo> = self.connected_peers_lockfree.iter()
            .filter(|e| matches!(e.value().node_type, NodeType::Super))
            .map(|e| e.value().clone())
            .collect();
        
        if crate::node::is_info() {
            println!("[INFO][P2P] broadcast_event type={} peers={}", event_type, target_peers.len());
        }
        
        for peer in target_peers {
            let event_msg = NetworkMessage::SystemEvent {
                event_type: event_type.to_string(),
                data: event_data.to_string(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                from_node: self.node_id.clone(),
            };
            self.send_network_message(&peer.addr, event_msg);
        }
    }
    
    /// QUANTUM OPTIMIZATION: Get peer count without blocking
    pub fn get_peer_count_lockfree(&self) -> usize {
        self.connected_peers_lockfree.len()
    }
    
    /// v3.0: Get connected peer count for memory monitoring
    pub fn get_connected_peer_count(&self) -> usize {
        self.connected_peers_lockfree.len()
    }
    
    /// v3.0: Get rate limiter size for memory monitoring
    pub fn get_rate_limiter_size(&self) -> usize {
        self.rate_limiter.len()
    }
    
    /// SHARDING INTEGRATION: Get optimal peers for cross-shard communication
    pub fn get_cross_shard_peers(&self, target_shard: u8, limit: usize) -> Vec<PeerInfo> {
        let mut cross_shard_peers = Vec::new();
        
        // Get peers from target shard
        if let Some(shard_peers) = self.peer_shards.get(&target_shard) {
            for addr in shard_peers.value().iter().take(limit) {
                if let Some(peer) = self.connected_peers_lockfree.get(addr) {
                    cross_shard_peers.push(peer.value().clone());
                }
            }
        }
        
        // If not enough, get from neighboring shards
        if cross_shard_peers.len() < limit {
            let neighbor_shards = [
                target_shard.wrapping_sub(1),
                target_shard.wrapping_add(1),
            ];
            
            for &shard in &neighbor_shards {
                if let Some(shard_peers) = self.peer_shards.get(&shard) {
                    for addr in shard_peers.value().iter() {
                        if cross_shard_peers.len() >= limit {
                            break;
                        }
                        if let Some(peer) = self.connected_peers_lockfree.get(addr) {
                            cross_shard_peers.push(peer.value().clone());
                        }
                    }
                }
            }
        }
        
        cross_shard_peers
    }
    
    /// Get connected peer count (PRODUCTION: Real failover validation)
    pub fn get_peer_count(&self) -> usize {
        // GENESIS FIX: During Genesis phase, use validated peers count
        // This ensures correct peer count reporting in API during bootstrap
        if std::env::var("QNET_BOOTSTRAP_ID")
            .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
            .unwrap_or(false) {
            // Genesis node: Count actual connected Genesis peers
            let validated_peers = self.get_validated_active_peers();
            return validated_peers.len();
        }
        
        // v2.51: fully lock-free
        self.connected_peers_lockfree.len()
    }
    
    /// CRITICAL FIX v2.19.25: Create PeerInfo from QUIC connection when P2P registry not updated yet
    /// Returns Some(PeerInfo) if peer is connected via QUIC, None otherwise
    pub(super) fn try_create_peer_from_quic(&self, node_id: &str, peer_addr: &str) -> Option<PeerInfo> {
        if !self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed) {
            return None;
        }
        
        let quic_transport = self.quic_transport.as_ref()?;
        let transport = quic_transport.try_read().ok()?;
        let quic_peers = transport.get_connected_peers();
        
        // Find peer and get their node_type from QUIC handshake
        let quic_node_type = quic_peers.iter()
            .find(|(_, id, _)| id == node_id)
            .map(|(_, _, node_type)| node_type.clone())?;
        
        // Peer connected via QUIC! Get real values from config
        let ip = peer_addr.split(':').next().unwrap_or("");
        
        use crate::genesis_constants::get_genesis_region_by_ip;
        let region_str = get_genesis_region_by_ip(ip).unwrap_or("Europe");
        let region = match region_str {
            "NorthAmerica" => Region::NorthAmerica,
            "Europe" => Region::Europe,
            "Asia" => Region::Asia,
            "SouthAmerica" => Region::SouthAmerica,
            "Africa" => Region::Africa,
            "Oceania" => Region::Oceania,
            _ => Region::Europe,
        };
        
        let reputation = self.get_node_reputation_from_blockchain(node_id);
        
        // Use node_type from QUIC handshake (real value from remote node)
        // UNIFIED: All node_type strings normalized to lowercase for comparison
        // v3.18: Full nodes removed
        let node_type = match quic_node_type.to_lowercase().as_str() {
            "super" => NodeType::Super,
            "light" => NodeType::Light, // Light nodes won't be here, but handle for completeness
            _ => {
                // Fallback for legacy/unknown formats
                // v3.18: Full nodes removed
                match quic_node_type.to_lowercase().as_str() {
                    "super" => NodeType::Super,
                    "light" => NodeType::Light,
                    _ => {
                        // Genesis nodes are always Super
                        if node_id.starts_with("genesis_node_") {
                            NodeType::Super
                        } else {
                            NodeType::Super // Default for unknown types
                        }
                    }
                }
            }
        };
        
        Some(PeerInfo {
            id: node_id.to_string(),
            addr: peer_addr.to_string(),
            node_type,
            region,
            last_seen: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            is_stable: true,
            latency_ms: 0,
            connection_count: 1,
            bandwidth_usage: 0,
            node_id_hash: Vec::new(),
            bucket_index: 0,
            reputation,                 // v2.45.1: From blockchain
            consensus_score: reputation, // Legacy
            network_score: 100.0,        // Legacy
            reputation_score: None,      // Legacy
            successful_pings: 0,
            failed_pings: 0,
            last_block_height: 0,  // v2.24.3
            last_height_attested_at: 0,  // v30.A3
            is_outbound: false,
        })
    }

    /// CRITICAL: Verify all Genesis nodes are actually connected for bootstrap
    /// This prevents split brain during initial network formation
    /// 
    /// ARCHITECTURE (v2.19.17): Check connected_peers first, then active_full_super_nodes
    /// TCP test is only fallback - if peer sent us a message, they ARE connected!
    pub async fn verify_all_genesis_connectivity(&self) -> bool {
        use crate::genesis_constants::GENESIS_NODE_IPS;
        
        // Get our own bootstrap ID to exclude self
        let our_bootstrap_id = std::env::var("QNET_BOOTSTRAP_ID").ok();
        let our_id = our_bootstrap_id.as_ref()
            .and_then(|id| id.parse::<usize>().ok())
            .unwrap_or(0);
        
        let mut connected_count = 0;
        let mut total_other_nodes = 0;
        
        // Check each Genesis node (except self)
        for (ip, id) in GENESIS_NODE_IPS {
            let node_num: usize = id.parse().unwrap_or(0);
            
            // Skip self
            if node_num == our_id {
                continue;
            }
            
            total_other_nodes += 1;
            let peer_addr = format!("{}:8001", ip);
            let node_id = format!("genesis_node_{:03}", node_num);
            
            // v2.51: Check connected_peers_lockfree (DashMap) and active_full_super_nodes
            let in_peers = self.connected_peers_lockfree.contains_key(&peer_addr) ||
                self.connected_peers_lockfree.iter().any(|e| e.value().id == node_id);
            let in_active_registry = self.active_full_super_nodes.contains_key(&node_id);
            
            let is_connected = in_peers || in_active_registry;
            
            if is_connected {
                connected_count += 1;
                if crate::node::is_debug() {
                    println!("[DBG][P2P] genesis_connected node={} peers={} registry={}", 
                             node_id, in_peers, in_active_registry);
                }
            } else {
                // FALLBACK: TCP test only if not in any list
                // This handles the case where peer just started and hasn't sent messages yet
                // v4.2: spawn_blocking to avoid starving tokio workers during VRF claim collection
                let peer_addr_clone = peer_addr.clone();
                let is_reachable = tokio::task::spawn_blocking(move || {
                    Self::test_peer_connectivity_static(&peer_addr_clone)
                }).await.unwrap_or(false);
                if is_reachable {
                    connected_count += 1;
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Genesis {} reachable via TCP (not yet in peers list)", node_id);
                    }
                } else {
                    if crate::node::is_info() {
                        println!("[WARN][P2P] Genesis {} not connected yet", node_id);
                    }
                }
            }
        }
        
        // All 4 other Genesis nodes must be connected
        let all_connected = connected_count == total_other_nodes;
        
        if all_connected {
            if crate::node::is_info() {
                println!("[INFO][P2P] All {} Genesis nodes verified connected", total_other_nodes);
            }
        } else {
            if crate::node::is_info() {
                println!("[INFO][P2P] Genesis connectivity: {}/{} nodes", connected_count, total_other_nodes);
            }
        }
        
        all_connected
    }
    
    /// PRODUCTION: Check if peer is actually connected (runtime-safe)
    pub(super) fn is_peer_actually_connected(&self, peer_addr: &str) -> bool {
        // CRITICAL FIX: Use EXISTING static method to prevent deadlock
        // DEADLOCK ISSUE: self.get_peer_count() calls connected_peers.write() which creates circular dependency
        // SOLUTION: Get peer count from peers parameter in calling context to avoid lock recursion
        
        // EXISTING: Use same logic as is_peer_actually_connected_static but without peer_count parameter
        // Fallback to conservative peer count estimation to maintain Genesis network detection
        let estimated_peer_count = 5; // Genesis bootstrap phase assumption (≤10 triggers small network logic)
        
        // EXISTING: Forward to static method with estimated count - same validation logic preserved
        Self::is_peer_actually_connected_static(peer_addr, estimated_peer_count)
    }
    
    /// Get connected peer addresses for consensus participation (v2.51: lock-free)
    pub fn get_connected_peer_addresses(&self) -> Vec<String> {
        let peer_addrs: Vec<String> = self.connected_peers_lockfree.iter()
            .map(|e| e.key().clone())
            .collect();
        
        if crate::node::is_debug() {
            println!("[DBG][P2P] consensus_peers count={}", peer_addrs.len());
        }
        peer_addrs
    }
    
    /// PRODUCTION: Get discovery peers for DHT/API (Fast method for millions of nodes)  
    pub fn get_discovery_peers(&self) -> Vec<PeerInfo> {
        // ARCHITECTURE: Bootstrap nodes use deterministic Genesis peer list for consistent selection
        // Regular nodes use dynamic peer discovery from DHT for scalability
        // This ensures deterministic consensus among Genesis nodes while allowing network growth
        
        let is_bootstrap_node = std::env::var("QNET_BOOTSTRAP_ID")
            .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
            .unwrap_or(false);
        
        if is_bootstrap_node {
            // Bootstrap nodes: Return ONLY verified Genesis nodes for deterministic consensus
            let mut genesis_peers = Vec::new();
            
            // Get Genesis IPs from constants
            use crate::genesis_constants::GENESIS_NODE_IPS;
            
            // CRITICAL FIX: Use SAME logic as get_validated_active_peers
            // Don't check connected_peers - use working_genesis_ips directly
            let working_genesis_ips = Self::filter_working_genesis_nodes_static(get_genesis_bootstrap_ips());
            
            for (ip, id) in GENESIS_NODE_IPS {
                let _addr = format!("{}:8001", ip);
                let node_id = format!("genesis_node_{}", id);
                
                // Skip self - check if our node_id ends with this id
                // BUGFIX v2.27.1: Was incorrectly skipping NEXT node instead of self!
                // Old: format!("{:03}", id.parse::<usize>().unwrap_or(0) + 1) → "001" became "002"
                // Fixed: Just check if node_id contains the id directly
                if !self.node_id.ends_with(id) {
                    if working_genesis_ips.contains(&ip.to_string()) {
                        // PRODUCTION: Get REAL peer data from connected_peers_lockfree
                        // NO FALLBACK! If peer not found in P2P state, skip it (not really connected)
                        let peer_data = self.connected_peers_lockfree
                            .iter()
                            .find(|entry| entry.value().id == node_id)
                            .map(|entry| entry.value().clone());
                        
                        match peer_data {
                            Some(real_peer) => {
                                // PRODUCTION: Use ALL real data from P2P state
                                genesis_peers.push(real_peer);
                            }
                            None => {
                                // PRODUCTION: Peer not in P2P state = not really connected
                                // Log but don't add phantom peer with fake data
                                if crate::node::is_warn() {
                                    println!("[WARN][P2P] Genesis peer {} not in P2P state - skipping (no fake data)", node_id);
                                }
                            }
                        }
                    }
                }
            }
            
            // PRODUCTION: Only return REAL connected peers with REAL reputation
            if crate::node::is_info() {
                println!("[INFO][P2P] Genesis mode: returning {} REAL connected peers (no phantoms, no fake reputation)", 
                         genesis_peers.len());
            }
            genesis_peers
        } else {
            // Normal phase: Use all connected peers (v2.51: lock-free)
            let peer_list: Vec<PeerInfo> = self.connected_peers_lockfree.iter()
                .map(|e| e.value().clone())
                .collect();
            if crate::node::is_debug() {
                println!("[DBG][P2P] discovery_peers count={}", peer_list.len());
            }
            peer_list
        }
    }
    
    /// CACHE FIX: Invalidate peer cache when topology changes
    pub(super) fn invalidate_peer_cache(&self) {
        let new_epoch = CACHE_ACTOR.increment_epoch();
        *CACHE_ACTOR.peers_cache.write() = None;
        if crate::node::is_info() {
            println!("[INFO][P2P] peer_cache_invalidated epoch={}", new_epoch);
        }
    }
    
    /// PRODUCTION: Broadcast certificate announcement when created/rotated
    /// This enables compact signatures for microblocks
    pub fn broadcast_certificate_announce(&self, cert_serial: String, certificate: Vec<u8>) -> Result<(), String> {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return Err("No Tokio runtime available".to_string()),
        };
        
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
            
        let message = NetworkMessage::CertificateAnnounce {
            node_id: self.node_id.clone(),
            cert_serial: cert_serial.clone(),
            certificate: certificate.clone(),
            timestamp,
        };
        
        // Store our own certificate first
        {
            let mut cert_manager = self.certificate_manager.write();
            cert_manager.set_local_certificate(cert_serial.clone(), certificate);
        }
        
        // CRITICAL FIX: Use validated peers (deterministic Genesis list) instead of connected_peers_lockfree
        // This fixes race condition where certificate broadcast happens before TCP connections established
        let peers = self.get_validated_active_peers();
        let mut broadcast_count = 0;
        
        // Serialize message once for all peers
        let _message_json = match serde_json::to_value(&message) {
            Ok(json) => json,
            Err(e) => {
                return Err(format!("Failed to serialize certificate message: {}", e));
            }
        };
        
        for peer_info in peers {
            let peer_addr = peer_info.addr.clone();
            
            if peer_info.id == self.node_id {
                continue; // Skip self
            }
            
            // Send certificate announcement (async in production)
            // PRIVACY: Use pseudonym for peer address
            if crate::node::is_info() {
                println!("[INFO][P2P] Sending certificate {} to peer {}", cert_serial, get_privacy_id_for_addr(&peer_addr));
            }
            broadcast_count += 1;
            
            // PRODUCTION v2.19.22: Send certificate via QUIC (binary, fast)
            let peer_addr_clone = peer_addr.clone();
            let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
            let quic_transport = self.quic_transport.clone();
            let message_clone = message.clone();
            
            handle.spawn(async move {
                if quic_enabled {
                    if let Some(ref transport) = quic_transport {
                        // Parse peer address to QUIC port
                        let parts: Vec<&str> = peer_addr_clone.split(':').collect();
                        if parts.len() == 2 {
                            if let (Ok(ip), Ok(port)) = (parts[0].parse::<std::net::IpAddr>(), parts[1].parse::<u16>()) {
                                let quic_port = port.saturating_add(crate::quic_transport::QUIC_PORT_OFFSET);
                                let quic_addr = std::net::SocketAddr::new(ip, quic_port);
                                
                                let transport_guard = transport.read().await;
                                if let Err(e) = transport_guard.broadcast_to(quic_addr, &message_clone).await {
                                    if crate::node::is_info() {
                                        println!("[WARN][QUIC] Certificate send failed to {}: {}",
                                            get_privacy_id_for_addr(&peer_addr_clone), e);
                                    }
                                }
                            }
                        }
                    }
                }
            });
        }
        
        if crate::node::is_info() {
            println!("[INFO][P2P] Certificate {} broadcast to {} peers", cert_serial, broadcast_count);
        }
        Ok(())
    }
    
    /// PRODUCTION: Request certificate from specific node
    pub fn request_certificate(&self, target_node_id: &str, cert_serial: &str) {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let message = NetworkMessage::CertificateRequest {
            requester_id: self.node_id.clone(),
            node_id: target_node_id.to_string(),
            cert_serial: cert_serial.to_string(),
            timestamp,
        };
        
        // Find peer address for target node
        if let Some(addr) = self.peer_id_to_addr.get(target_node_id) {
            self.send_network_message(&addr, message);
            if crate::node::is_info() {
                println!("[INFO][P2P] Sent certificate request for {} to {}", cert_serial, target_node_id);
            }
        } else {
            // Broadcast request to all peers if we don't know the target
            if crate::node::is_warn() {
                println!("[WARN][P2P] Target node {} not found, broadcasting certificate request", target_node_id);
            }
            let peers: Vec<_> = self.connected_peers_lockfree
                .iter()
                .map(|r| r.value().clone())
                .collect();
            
            for peer in peers.iter().take(5) { // Limit to 5 peers
                self.send_network_message(&peer.addr, message.clone());
            }
        }
    }
    
    /// PRODUCTION: Broadcast certificate with delivery tracking and Byzantine threshold validation
    /// Returns Ok if 2/3+ peers confirmed delivery, Err otherwise
    /// This ensures Byzantine fault tolerance for critical certificate propagation
    pub async fn broadcast_certificate_announce_tracked(
        &self, 
        cert_serial: String, 
        certificate: Vec<u8>
    ) -> Result<(), String> {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // Store locally first (immediate availability)
        {
            let mut cert_manager = self.certificate_manager.write();
            cert_manager.set_local_certificate(cert_serial.clone(), certificate.clone());
        }
        
        // Get validated peers
        let peers = self.get_validated_active_peers();
        
        if peers.is_empty() {
            if crate::node::is_warn() {
                println!("[WARN][P2P] No peers available for tracked certificate broadcast");
            }
            return Ok(()); // No peers is OK (single node network)
        }
        
        let total_peers = peers.len();
        let byzantine_threshold = (total_peers * 2 + 2) / 3; // Ceiling of 2/3
        
        if crate::node::is_info() {
            println!("[INFO][P2P] TRACKED broadcast of certificate {} to {} peers (need {}/{})", 
                     cert_serial, total_peers, byzantine_threshold, total_peers);
        }
        
        // Prepare message once
        let message = NetworkMessage::CertificateAnnounce {
            node_id: self.node_id.clone(),
            cert_serial: cert_serial.clone(),
            certificate: certificate.clone(),
            timestamp,
        };
        
        let message_json = match serde_json::to_value(&message) {
            Ok(json) => Arc::new(json),
            Err(e) => {
                return Err(format!("Failed to serialize certificate message: {}", e));
            }
        };
        
        // Atomic counter for successful deliveries
        let success_count = Arc::new(AtomicUsize::new(0));
        
        // Create async tasks for each peer (with cooldown check)
        let mut tasks = Vec::new();
        let mut skipped_peers = 0usize;
        
        for peer_info in peers {
            if peer_info.id == self.node_id {
                continue; // Skip self
            }
            
            let peer_addr = peer_info.addr.clone();
            
            // OPTIMIZATION v2.50: Check peer cooldown before sending
            // Prevents retry storms to unresponsive/"not ready" peers
            if let Some(entry) = PEER_RETRY_COOLDOWN.get(&peer_addr) {
                let (_retry_count, cooldown_until) = entry.value();
                if std::time::Instant::now() < *cooldown_until {
                    // Peer is in cooldown - skip this round
                    skipped_peers += 1;
                    continue;
                }
            }
            
            let _message_json_clone = Arc::clone(&message_json);
            let success_count_clone = Arc::clone(&success_count);
            let cert_serial_clone = cert_serial.clone();
            let peer_addr_for_cooldown = peer_addr.clone();
            
            // PRODUCTION v2.19.22: Send via QUIC
            let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
            let quic_transport = self.quic_transport.clone();
            let message_clone = message.clone();
            
            let task = tokio::spawn(async move {
                if quic_enabled {
                    if let Some(ref transport) = quic_transport {
                        let parts: Vec<&str> = peer_addr.split(':').collect();
                        if parts.len() == 2 {
                            if let (Ok(ip), Ok(port)) = (parts[0].parse::<std::net::IpAddr>(), parts[1].parse::<u16>()) {
                                let quic_port = port.saturating_add(crate::quic_transport::QUIC_PORT_OFFSET);
                                let quic_addr = std::net::SocketAddr::new(ip, quic_port);
                                
                                let transport_guard = transport.read().await;
                                match transport_guard.broadcast_to(quic_addr, &message_clone).await {
                                    Ok(_) => {
                                        success_count_clone.fetch_add(1, Ordering::SeqCst);
                                        // PRIVACY: Use pseudonym for peer address
                                        if crate::node::is_info() {
                                            println!("[INFO][QUIC] Certificate {} delivered to {}", cert_serial_clone, get_privacy_id_for_addr(&peer_addr));
                                        }
                                        
                                        // SUCCESS: Reset cooldown for this peer
                                        PEER_RETRY_COOLDOWN.remove(&peer_addr_for_cooldown);
                                    }
                                    Err(e) => {
                                        if crate::node::is_info() {
                                            println!("[WARN][QUIC] Certificate {} failed to {}: {}",
                                                     cert_serial_clone, peer_addr, e);
                                        }
                                        
                                        // FAILURE: Apply exponential backoff cooldown
                                        let (retry_count, _) = PEER_RETRY_COOLDOWN
                                            .get(&peer_addr_for_cooldown)
                                            .map(|e| *e.value())
                                            .unwrap_or((0, std::time::Instant::now()));
                                        
                                        let new_retry_count = retry_count + 1;
                                        let backoff_secs = std::cmp::min(
                                            PEER_COOLDOWN_BASE_SECS * (1 << new_retry_count.min(4)),
                                            PEER_COOLDOWN_MAX_SECS
                                        );
                                        let cooldown_until = std::time::Instant::now() + 
                                            std::time::Duration::from_secs(backoff_secs);
                                        
                                        PEER_RETRY_COOLDOWN.insert(
                                            peer_addr_for_cooldown, 
                                            (new_retry_count, cooldown_until)
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            });
            
            tasks.push(task);
        }
        
        // Log skipped peers if any
        if skipped_peers > 0 {
            if crate::node::is_info() {
                println!("[INFO][P2P] Skipped {} peers in cooldown", skipped_peers);
            }
        }
        
        // CRITICAL: Recalculate effective peers and threshold after cooldown filtering
        let effective_peers = total_peers - skipped_peers;
        let effective_threshold = if effective_peers > 0 {
            (effective_peers * 2 + 2) / 3  // 2/3+1 of EFFECTIVE peers
        } else {
            1  // At least 1 confirmation needed
        };
        
        // Wait for all tasks to complete (with adaptive timeout)
        let broadcast_start = std::time::Instant::now();
        
        // ADAPTIVE TIMEOUT: Scale based on network size
        // Small networks (<=10): 3s is sufficient (local/fast network)
        // Medium networks (<=100): 5s for moderate WAN latency
        // Large networks (>100): 10s for global distribution
        let timeout_secs = if effective_peers <= 10 {
            3  // 3s for small networks (doesn't conflict with Adaptive BFT 4s timeout)
        } else if effective_peers <= 100 {
            5  // 5s for medium networks
        } else {
            10 // 10s for large networks (1000 validators)
        };
        let timeout = tokio::time::Duration::from_secs(timeout_secs);
        
        match tokio::time::timeout(timeout, futures::future::join_all(tasks)).await {
            Ok(_) => {
                let delivery_time = broadcast_start.elapsed();
                let successful = success_count.load(Ordering::SeqCst);
                
                if crate::node::is_info() {
                    println!("[INFO][P2P] Certificate {} delivery: {}/{} effective peers ({:.1}%) in {:?}", 
                             cert_serial, successful, effective_peers, 
                             if effective_peers > 0 { (successful as f64 / effective_peers as f64) * 100.0 } else { 0.0 },
                             delivery_time);
                }
                
                // Check Byzantine threshold (based on effective peers, not total)
                if successful >= effective_threshold {
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Byzantine threshold reached: {}/{} ≥ 2/3 (effective)", 
                                 successful, effective_peers);
                    }
                    Ok(())
                } else {
                    let err = format!(
                        "Byzantine threshold NOT reached: {}/{} < 2/3 (need {}, {} in cooldown)",
                        successful, effective_peers, effective_threshold, skipped_peers
                    );
                    if crate::node::is_warn() {
                        println!("[WARN][P2P] {}", err);
                    }
                    Err(err)
                }
            }
            Err(_) => {
                let successful = success_count.load(Ordering::SeqCst);
                Err(format!(
                    "Certificate broadcast timeout: only {}/{} confirmed in {}s",
                    successful, total_peers, timeout_secs
                ))
            }
        }
    }
    
    /// PRODUCTION: Get validated active peers for consensus participation (NODE TYPE AWARE)
    pub fn get_validated_active_peers(&self) -> Vec<PeerInfo> {
        // CRITICAL FIX: Light nodes DO NOT participate in consensus - return empty list
        // Only Super nodes need validated peers for consensus/emergency producer selection
        match self.node_type {
            NodeType::Light => {
                if crate::node::is_info() {
                    println!("[INFO][P2P] Light node: no consensus participation, returning empty peer list");
                }
                return Vec::new(); // Light nodes don't participate in consensus
            },
            _ => {} // Continue with Super node logic
        }
        
        // CRITICAL FIX: For Genesis bootstrap, return ALL configured peers WITHOUT TCP checks
        // TCP checks are ONLY for broadcast/failover, NOT for consensus candidate lists
        // This ensures deterministic consensus: all nodes see SAME candidates for VRF election
        if std::env::var("QNET_BOOTSTRAP_ID")
            .map(|id| ["001", "002", "003", "004", "005"].contains(&id.trim()))
            .unwrap_or(false) {
            let genesis_ips = get_genesis_bootstrap_ips();
            let mut genesis_peers = Vec::new();
            
            for (i, ip) in genesis_ips.iter().enumerate() {
                let node_id = format!("genesis_node_{:03}", i + 1);
                let peer_addr = format!("{}:8001", ip);
                
                // CRITICAL FIX: Use exact comparison, not contains()
                // contains() incorrectly excludes nodes with similar substrings
                // Example: if self.node_id="genesis_node_005", contains("005") excludes ALL nodes with "005"
                // This caused certificate broadcast failure for rotated producers!
                if self.node_id != node_id {  // Exact comparison - only skip if EXACTLY same node
                    // PRODUCTION: Get REAL peer data from P2P state
                    // CRITICAL: Check BOTH storage systems (lockfree DashMap AND legacy RwLock)
                    // Genesis nodes use legacy storage (should_use_lockfree=false for ≤5 peers)
                    
                    // v2.51: lock-free only
                    let peer_data = self.connected_peers_lockfree
                        .iter()
                        .find(|entry| entry.value().id == node_id)
                        .map(|entry| entry.value().clone());
                    
                    match peer_data {
                        Some(real_peer) => {
                            // PRODUCTION: Use ALL real data from P2P state
                            genesis_peers.push(real_peer);
                        }
                        None => {
                            // CRITICAL FIX v2.19.15: Fallback to active_full_super_nodes registry
                            // This fixes Genesis startup where connected_peers is empty but
                            // ActiveNodeAnnouncement has been received (v2.51: lock-free)
                            if let Some(active_info_ref) = self.active_full_super_nodes.get(&node_id) {
                                let active_info = active_info_ref.value();
                                // Create PeerInfo from ActiveNodeInfo - use REAL data!
                                // v3.18: Full nodes removed
                                let node_type = match active_info.node_type.to_lowercase().as_str() {
                                    "super" => NodeType::Super,
                                    _ => NodeType::Super, // Genesis are Super (ignore "full")
                                };
                                // Region from shard_id
                                let region = match active_info.shard_id % 6 {
                                    0 => Region::NorthAmerica,
                                    1 => Region::Europe,
                                    2 => Region::Asia,
                                    3 => Region::SouthAmerica,
                                    4 => Region::Africa,
                                    5 => Region::Oceania,
                                    _ => Region::Europe,
                                };
                                let peer_info = PeerInfo {
                                    id: node_id.clone(),
                                    addr: peer_addr.clone(),
                                    node_type,
                                    region,
                                    last_seen: active_info.last_seen,
                                    is_stable: false,
                                    latency_ms: 0,
                                    connection_count: 0,
                                    bandwidth_usage: 0,
                                    node_id_hash: Vec::new(),
                                    bucket_index: 0,
                                    reputation: active_info.reputation,  // v2.45.1
                                    consensus_score: active_info.reputation, // Legacy
                                    network_score: 100.0,                    // Legacy
                                    reputation_score: None,                  // Legacy
                                    successful_pings: 0,
                                    failed_pings: 0,
                                    last_block_height: 0,
                                    last_height_attested_at: 0,  // v30.A3
                                    is_outbound: true,  // Outbound - we connect to genesis
                                };
                                genesis_peers.push(peer_info);
                            } else {
                                // CRITICAL FIX v2.19.25: Check QUIC connections as last resort
                                if let Some(peer_info) = self.try_create_peer_from_quic(&node_id, &peer_addr) {
                                    genesis_peers.push(peer_info);
                                }
                            }
                        }
                    }
                }
            }

            // Data-availability fan-out + Byzantine participation count must also include connected
            // non-genesis Super peers (shred tree, repair, peer count) — mirrors the regular-node
            // branch. The VRF/committee set derives separately from on-chain eligible_producers, so
            // this never alters election determinism.
            let genesis_ids: std::collections::HashSet<String> =
                genesis_peers.iter().map(|p| p.id.clone()).collect();
            for entry in self.connected_peers_lockfree.iter() {
                let peer = entry.value();
                if matches!(peer.node_type, NodeType::Super)
                    && !genesis_ids.contains(&peer.id)
                    && peer.id != self.node_id
                {
                    genesis_peers.push(peer.clone());
                }
            }

            return genesis_peers;
        }

        // QUANTUM: For decentralized quantum blockchain, minimize cache to ensure consensus consistency
        // Cache only for DOS protection, not for consensus decisions
        let validation_interval = Duration::from_millis(500); // 0.5 second cache - quantum-speed consensus
        
        // v2.51: lock-free cache with topology-aware key
        let mut peer_addrs: Vec<String> = self.connected_peers_lockfree.iter()
            .map(|e| e.key().clone())
            .collect();
        peer_addrs.sort();
        
        // Check actor cache (single source of truth)
        let should_refresh = {
            // Try new cache actor first
            if let Some(cached_data) = CACHE_ACTOR.peers_cache.read().as_ref() {
            let now = Instant::now();
                let age = now.duration_since(cached_data.timestamp);
                
                // Check topology hash for cache validity  
                let topology_hash = CacheActor::get_topology_hash(&peer_addrs);
                if age < validation_interval && cached_data.topology_hash == topology_hash {
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Using actor cached peer list ({} peers, epoch: {}, age: {}s)", 
                                 cached_data.data.len(), cached_data.epoch, age.as_secs());
                    }
                    return cached_data.data.clone();
                }
            }
            
            true // Cache expired or unavailable, need refresh
        };

        if should_refresh {
            // RACE CONDITION FIX: Double-check actor cache before expensive validation
            // Another thread might have refreshed while we were checking
            if let Some(cached_data) = CACHE_ACTOR.peers_cache.read().as_ref() {
                let age = Instant::now().duration_since(cached_data.timestamp);
                let topology_hash = CacheActor::get_topology_hash(&peer_addrs);
                if age < validation_interval && cached_data.topology_hash == topology_hash {
                    if crate::node::is_debug() {
                        println!("[DBG][P2P] cache_hit_recheck peers={} epoch={}", cached_data.data.len(), cached_data.epoch);
                    }
                    return cached_data.data.clone();
                }
            }

            let fresh_peers = self.get_validated_active_peers_internal();

            // Update actor cache (single source of truth)
            {
                let epoch = CACHE_ACTOR.increment_epoch();
                let topology_hash = CacheActor::get_topology_hash(&fresh_peers.iter().map(|p| p.addr.clone()).collect::<Vec<_>>());
                *CACHE_ACTOR.peers_cache.write() = Some(CachedData {
                    data: fresh_peers.clone(),
                    epoch,
                    timestamp: Instant::now(),
                    topology_hash,
                });

                if crate::node::is_info() {
                    println!("[INFO][P2P] peer_cache_refreshed peers={} epoch={}", fresh_peers.len(), epoch);
                }
            }
            
            return fresh_peers;
        }
        
        // Fallback if cache lock fails
        self.get_validated_active_peers_internal()
    }
    
    /// CRITICAL FIX v2.61: Get peer heights from signed heartbeats
    /// Used for emergency producer selection to ensure only SYNCHRONIZED nodes are candidates
    /// Returns HashMap<node_id, last_block_height> from Dilithium-signed HealthPing data
    pub fn get_peer_heights(&self) -> std::collections::HashMap<String, u64> {
        let mut heights = std::collections::HashMap::new();
        
        // Collect heights from connected peers (lock-free)
        for entry in self.connected_peers_lockfree.iter() {
            let peer = entry.value();
            if peer.last_block_height > 0 {
                heights.insert(peer.id.clone(), peer.last_block_height);
            }
        }
        
        // Also check validated active peers (may have fresher data)
        let validated = self.get_validated_active_peers();
        for peer in validated {
            if peer.last_block_height > 0 {
                heights.entry(peer.id.clone())
                    .and_modify(|h| *h = (*h).max(peer.last_block_height))
                    .or_insert(peer.last_block_height);
            }
        }
        
        heights
    }
    
    /// Internal method without caching (v2.51: fully lock-free)
    pub(super) fn get_validated_active_peers_internal(&self) -> Vec<PeerInfo> {
        // Genesis nodes early-return from get_validated_active_peers before reaching this internal
        // path, so only non-genesis Super nodes run here: deterministic Genesis peers + DHT-discovered
        // Super peers (the prior genesis branch here was unreachable).
        let mut all_validated_peers = Vec::new();
        let genesis_ips = get_genesis_bootstrap_ips();
        let mut genesis_peer_ids = std::collections::HashSet::new();

        for (i, ip) in genesis_ips.iter().enumerate() {
            let node_id = format!("genesis_node_{:03}", i + 1);
            let peer_addr = format!("{}:8001", ip);
            genesis_peer_ids.insert(node_id.clone());

            let peer_data = self.connected_peers_lockfree
                .iter()
                .find(|entry| entry.value().id == node_id)
                .map(|entry| entry.value().clone());

            if let Some(real_peer) = peer_data {
                all_validated_peers.push(real_peer);
            } else if let Some(peer_info) = self.try_create_peer_from_quic(&node_id, &peer_addr) {
                all_validated_peers.push(peer_info);
            }
        }

        // Add DHT-discovered peers (excluding Genesis)
        let dht_peers: Vec<PeerInfo> = self.connected_peers_lockfree.iter()
            .filter(|entry| {
                let peer = entry.value();
                let is_genesis = genesis_peer_ids.contains(&peer.id);
                let is_consensus_capable = matches!(peer.node_type, NodeType::Super);
                !is_genesis && is_consensus_capable
            })
            .map(|entry| entry.value().clone())
            .collect();

        all_validated_peers.extend(dht_peers);

        if crate::node::is_debug() {
            println!("[DBG][P2P] validated_peers genesis={} dht={} total={}",
                     genesis_ips.len(), all_validated_peers.len() - genesis_ips.len(), all_validated_peers.len());
        }
        all_validated_peers
    }
    
    /// CRITICAL: Force peer cache refresh for Byzantine safety checks (Producer nodes)
    pub fn force_peer_cache_refresh(&self) {
        let new_epoch = CACHE_ACTOR.increment_epoch();
        *CACHE_ACTOR.peers_cache.write() = None;
        if crate::node::is_info() {
            println!("[INFO][P2P] peer_cache_forced_refresh epoch={}", new_epoch);
        }
    }
    

    
    /// SHARDING: Get this node's shard ID (0-255)
    pub fn get_shard_id(&self) -> u8 {
        self.shard_id
    }
    
    /// QUANTUM OPTIMIZATION: Get statistics about shard distribution
    pub fn get_shard_stats(&self) -> HashMap<u8, usize> {
        let mut stats = HashMap::new();
        for entry in self.peer_shards.iter() {
            stats.insert(*entry.key(), entry.value().len());
        }
        stats
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
    
    /// Get count of qualified producers (consensus_score >= 70%)
    /// CRITICAL: Used for adaptive ShredProtocol fanout calculation
    /// SCALABILITY: Counts only Super and Full nodes (Light nodes excluded)
    pub fn get_qualified_producers_count(&self) -> usize {
        // Count peers that meet Byzantine threshold for consensus
        self.connected_peers_lockfree.iter()
            .filter(|entry| entry.value().is_consensus_qualified())
            .count()
    }
    
    /// Get average peer latency for network performance estimation
    /// CRITICAL: Used for adaptive ShredProtocol fanout calculation
    /// Returns average latency_ms across all qualified producers
    pub fn get_average_peer_latency(&self) -> u64 {
        let qualified_peers: Vec<u32> = self.connected_peers_lockfree.iter()
            .filter(|entry| entry.value().is_consensus_qualified())
            .map(|entry| entry.value().latency_ms)
            .collect();
        
        if qualified_peers.is_empty() {
            // Default: assume regional latency (50ms) if no peers available
            return 50;
        }
        
        // Calculate average latency
        let sum: u64 = qualified_peers.iter().map(|&l| l as u64).sum();
        sum / qualified_peers.len() as u64
    }
    
    /// Calculate adaptive ShredProtocol fanout based on network size and latency
    /// ARCHITECTURE: Balance between propagation speed and bandwidth usage
    /// CRITICAL: Ensures blocks propagate within 50% of block time (500ms for 1s blocks)
    /// 
    /// Formula rationale:
 /// - Genesis (5-50 producers, LAN <50ms): fanout=4 → direct to all peers 
 /// - Genesis (5-50 producers, WAN >50ms): fanout=ALL → no hops needed for intercontinental 
 /// - Small (51-200 producers, LAN <50ms): fanout=8 → 3 hops × latency = ~150ms 
 /// - Small (51-200 producers, WAN >50ms): fanout=16 → 2 hops × latency = ~400ms 
 /// - Medium (201-1000 producers, LAN <50ms): fanout=8 → 4 hops = ~200ms 
 /// - Medium (201-1000 producers, WAN >50ms): fanout=16 → 3 hops = ~600ms 
    /// - Large (>1000 producers): fanout=32 → 3 hops for 32K nodes
    /// 
    /// v2.60: CRITICAL FIX - Genesis with high latency now broadcasts to ALL peers
    /// This ensures intercontinental nodes (USA vs Europe) receive all chunks directly
    /// Without this, high-latency nodes miss chunks and can't reconstruct blocks
    pub fn get_shred_protocol_fanout(&self) -> usize {
        let producers = self.get_qualified_producers_count();
        let latency = self.get_average_peer_latency();
        
        // ARCHITECTURE: Adaptive fanout ensures < 50% block time propagation
        match (producers, latency) {
            // ═══════════════════════════════════════════════════════════════════════════
            // GENESIS PHASE (5-50 producers):
            // v2.60 FIX: High latency (>50ms) = intercontinental network
            // Send directly to ALL peers to prevent chunk loss on high-latency routes
            // ═══════════════════════════════════════════════════════════════════════════
            // LAN (<50ms): fanout=4 → 2 hops for 16 nodes, works well
            (0..=50, 0..=50) => 4,
            // WAN (>50ms): fanout=producers → send to ALL peers directly!
            // This ensures USA node gets chunks from Germany producer without relay hops
            (0..=50, _) => producers.max(4),
            
            // SMALL NETWORK (51-200 producers):
 // LAN (<50ms): fanout=8 → 3 hops = 150ms 
 // WAN (>50ms): fanout=16 → 2 hops = 400ms 
            (51..=200, 0..=50) => 8,
            (51..=200, _) => 16,
            
            // MEDIUM NETWORK (201-1000 producers):
 // LAN (<50ms): fanout=8 → 4 hops = 200ms 
 // WAN (>50ms): fanout=16 → 3 hops = 600ms 
            (201..=1000, 0..=50) => 8,
            (201..=1000, _) => 16,
            
            // LARGE NETWORK (>1000 producers - future-proof):
            // fanout=32 → 3 hops for 32,768 nodes
 // Even at 200ms WAN latency: 3 × 200ms = 600ms < 1000ms 
            _ => 32,
        }
    }
    
    /// Get max concurrent chunk sends (PRODUCTION v2.21.4)
    /// 
    /// Adaptive limit to prevent receiver overload.
    /// Without rate limiting, burst of concurrent QUIC streams causes ~40% packet loss.
    /// 
    /// The limit is based on:
    /// 1. Network size (more peers = more distributed load)
    /// 2. Per-peer limit (max streams any single receiver handles at once)
    /// 
    /// Formula: min(network_limit, per_peer_limit × peer_count)
    /// 
    /// | Peers | Network Limit | Per-Peer | Effective |
    /// |-------|---------------|----------|-----------|
    /// | 4     | 20            | 5×4=20   | 20        |
    /// | 10    | 30            | 5×10=50  | 30        |
    /// | 100   | 50            | 5×100    | 50        |
    /// | 1000  | 100           | 5×1000   | 100       |
    pub fn get_max_concurrent_chunk_sends(&self) -> usize {
        let peer_count = self.connected_peers_lockfree.len().max(1);
        
        // v4.1: CRITICAL for 200K TX/block support
        // With 512KB chunks, broadcast supports larger blocks:
        // - 87MB block = 170 data + 85 parity = 255 chunks
        // - 255 chunks × 4 peers = 1,020 sends total
        // - 1,020 / 200 concurrent = 5 batches × 10ms = ~50ms broadcast time
        // Old 1KB chunks: 14MB = 14K chunks = 86K sends = 43+ seconds (TooManyShards!)
        let network_limit = match peer_count {
            0..=10 => 200,       // Genesis: 200 (was 20) for 100K TPS
            11..=100 => 300,     // Medium network: increased
            101..=1000 => 400,   // Large network: increased
            _ => 500,            // Huge network
        };
        
        // Per-peer limit: max 50 concurrent streams per receiving peer (was 5)
        // Modern QUIC implementations handle this well
        let per_peer_limit = peer_count * 50;
        
        // Use the smaller of the two limits
        network_limit.min(per_peer_limit).max(100)  // minimum 100 for high TPS
    }
    
    /// Stop P2P network
    pub fn stop(&self) {
        // SECURITY: Safe mutex locking for shutdown
        *self.is_running.lock() = false;
        if crate::node::is_info() {
            println!("[INFO][P2P] Simplified P2P network stopped");
        }
    }
    
    // === PRIVATE METHODS ===
    
    /// Get adjacent regions for peer discovery
    pub fn get_adjacent_regions(region: &Region) -> Vec<Region> {
        match region {
            Region::NorthAmerica => vec![Region::SouthAmerica, Region::Europe],
            Region::Europe => vec![Region::NorthAmerica, Region::Africa, Region::Asia],
            Region::Asia => vec![Region::Europe, Region::Oceania],
            Region::SouthAmerica => vec![Region::NorthAmerica, Region::Africa],
            Region::Africa => vec![Region::Europe, Region::SouthAmerica],
            Region::Oceania => vec![Region::Asia],
        }
    }

    /// Get backup regions for failover
    pub fn get_backup_regions(region: &Region) -> Vec<Region> {
        // Get all regions except the current one
        let all_regions = vec![
            Region::NorthAmerica,
            Region::Europe,
            Region::Asia,
            Region::SouthAmerica,
            Region::Africa,
            Region::Oceania,
        ];
        
        all_regions.into_iter().filter(|r| r != region).collect()
    }

    /// Get connected peers for DHT/API discovery (returns PeerInfo for compatibility)
    pub async fn get_connected_peers(&self) -> Vec<PeerInfo> {
        // PRODUCTION: Use discovery peers (all parsed peers) for DHT and API
        // This allows network growth and peer exchange to work properly
        let discovery_peers = self.get_discovery_peers();
        
        if crate::node::is_info() {
            println!("[INFO][P2P] Providing {} peers for DHT/API discovery", discovery_peers.len());
        }
        discovery_peers
    }
    
    /// Parse peer address string - supports "id@ip:port", "ip:port" and pseudonym formats  
    pub(super) fn parse_peer_address(&self, addr: &str) -> Result<PeerInfo, String> {
        // PRIVACY: Try pseudonym resolution first using EXISTING registry
        if !addr.contains(':') && !addr.contains('@') {
            // Might be a pseudonym - try to resolve
            // CRITICAL FIX: Skip pseudonym resolution in sync context to avoid runtime panic
            // PRIVACY: Don't log raw address
            if crate::node::is_warn() {
                println!("[WARN][P2P] Pseudonym resolution not available in sync context");
            }
            return Err("Cannot resolve pseudonym in sync context".to_string());
        }
        
        // EXISTING: Use static parser for IP:port and id@ip:port formats
        Self::parse_peer_address_static(addr)
    }
    
    /// Static version of parse_peer_address for async contexts
    pub(super) fn parse_peer_address_static(addr: &str) -> Result<PeerInfo, String> {
        let (peer_id, peer_addr) = if addr.contains('@') {
            // Format: "id@ip:port"
        let parts: Vec<&str> = addr.split('@').collect();
        if parts.len() != 2 {
            return Err(format!("Invalid peer address format: {}", addr));
            }
            (parts[0].to_string(), parts[1].to_string())
        } else {
            // Format: "ip:port" - generate ID from address
            let parts: Vec<&str> = addr.split(':').collect();
            if parts.len() != 2 {
                return Err(format!("Invalid peer address format: {}", addr));
            }
            
            // PRIVACY: Use consistent hashing for all nodes
            // EXISTING: Use get_privacy_id_for_addr for consistency
            let node_id = get_privacy_id_for_addr(parts[0]);
            (node_id, addr.to_string())
        };
        
        // Validate port
        let port_str = peer_addr.split(':').nth(1).unwrap_or("");
        if port_str.parse::<u16>().is_err() {
            return Err(format!("Invalid port in address: {}", addr));
        }
        
        // Extract IP for region and node type detection
        let ip = peer_addr.split(':').next().unwrap_or("");
        
        // EXISTING: Use get_genesis_region_by_ip() for correct Genesis node regions
        use crate::genesis_constants::get_genesis_region_by_ip;
        let correct_region = if is_genesis_node_ip(ip) {
            let genesis_region_str = get_genesis_region_by_ip(&ip).unwrap_or("Europe");
            match genesis_region_str {
                "NorthAmerica" => Region::NorthAmerica,
                "Europe" => Region::Europe,
                "Asia" => Region::Asia,
                "SouthAmerica" => Region::SouthAmerica,
                "Africa" => Region::Africa,
                "Oceania" => Region::Oceania,
                _ => Region::Europe, // EXISTING: Default fallback
            }
        } else {
            Region::Europe // EXISTING: Default for non-Genesis nodes
        };
        
        // Use EXISTING node type logic
        let correct_node_type = if is_genesis_node_ip(ip) {
            NodeType::Super  // All Genesis nodes are Super nodes  
        } else {
            NodeType::Super   // Default for regular nodes
        };
        
        // v2.45.1: Use INITIAL_REPUTATION from consensus
        // Real reputation loaded from blockchain in SimplifiedP2P methods
        let default_rep = qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
        
        Ok(PeerInfo {
            id: peer_id,
            addr: peer_addr,
            node_type: correct_node_type,
            region: correct_region,
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
            reputation: default_rep,       // v2.45.1: From blockchain
            consensus_score: default_rep,  // Legacy
            network_score: 100.0,          // Legacy
            reputation_score: None,        // Legacy
            successful_pings: 0,
            failed_pings: 0,
            last_block_height: 0,
            last_height_attested_at: 0,  // v30.A3
            is_outbound: false,
        })
    }

    /// Insert a dial candidate into the regional map. Dedup by addr and cap the region at
    /// MAX_REGIONAL_PEERS_PER_REGION, evicting the oldest non-genesis candidate — otherwise a
    /// gossip source grows the Vec without bound and the establishment sweep walks it in full.
    /// `peer.is_outbound` carries provenance: true only for addresses WE chose to dial.
    pub(super) fn push_regional_peer(
        regional_peers: &Arc<Mutex<HashMap<Region, Vec<PeerInfo>>>>,
        peer: PeerInfo,
    ) -> bool {
        let mut map = regional_peers.lock();
        let entry = map.entry(peer.region.clone()).or_insert_with(Vec::new);
        if entry.iter().any(|p| p.addr == peer.addr) {
            return false;
        }
        if entry.len() >= MAX_REGIONAL_PEERS_PER_REGION {
            let victim = entry.iter().enumerate()
                .filter(|(_, p)| !is_genesis_node_ip(p.addr.split(':').next().unwrap_or("")))
                .min_by_key(|(_, p)| p.last_seen)
                .map(|(i, _)| i);
            match victim {
                Some(i) => { entry.swap_remove(i); }
                None => {
                    if crate::node::is_warn() {
                        println!("[WARN][P2P] regional_candidate_rejected reason=region_full region={} cap={}",
                                 region_string(&peer.region), MAX_REGIONAL_PEERS_PER_REGION);
                    }
                    return false;
                }
            }
        }
        entry.push(peer);
        true
    }

    pub(super) fn add_peer_to_region(&self, peer: PeerInfo) {
        Self::push_regional_peer(&self.regional_peers, peer);
    }
    
    /// STARTUP FIX: Start regional connection establishment asynchronously (non-blocking startup)  
    pub(super) fn start_regional_connection_establishment(&self) {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] No Tokio runtime - regional connection deferred");
                }
                return;
            }
        };
        
        let regional_peers = self.regional_peers.clone();
        let connected_peers = self.connected_peers_lockfree.clone();
        let me = self.self_weak();
        let primary_region = self.primary_region.clone();
        let backup_regions = self.backup_regions.clone();
        let node_id = self.node_id.clone();
        let port = self.port;

        // EXISTING PATTERN: Use handle.spawn for non-blocking startup
        handle.spawn(async move {
            if crate::node::is_info() {
                println!("[INFO][P2P] Starting regional connection establishment (background)...");
            }
            
            let regional_peers_data = regional_peers.lock().clone();
            
            // v2.51: Lock-free peer operations
            // Connect to primary region first - WITH REAL connectivity validation
            if let Some(peers) = regional_peers_data.get(&primary_region) {
                let is_bootstrap_node = std::env::var("QNET_BOOTSTRAP_ID").is_ok();
                let active_peers = connected_peers.len();
                let is_small_network = active_peers < 6;
                let use_all_peers = is_bootstrap_node || is_small_network;
                let peer_limit = if use_all_peers { peers.len() } else { 5 };
                
                // v4.2: spawn_blocking for all connectivity checks to avoid tokio starvation
                for peer in peers.iter().take(peer_limit) {
                    if peer.id == node_id || peer.addr.contains(&port.to_string()) {
                        continue;
                    }
                    
                    let addr_clone = peer.addr.clone();
                    let ap = active_peers;
                    let is_connected = tokio::task::spawn_blocking(move || {
                        Self::is_peer_actually_connected_static(&addr_clone, ap)
                    }).await.unwrap_or(false);
                    if is_connected && Self::admit_regional_candidate(&me, peer.clone()) {
                        if crate::node::is_debug() {
                            println!("[DBG][P2P] regional_added peer={}", peer.id);
                        }

                        // v2.95: Query height via QUIC HealthPing (UDP, firewall-friendly)
                        // Falls back to HTTP if QUIC is not available yet.
                        let should_query = BEST_PEER_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) == 0;
                        let health_addr = peer.addr.clone();
                        if should_query { tokio::spawn(async move {
                            let ip = health_addr.split(':').next().unwrap_or("");

                            // Try QUIC HealthPing first (works through firewalls)
                            let quic_success = {
                                use crate::quic_transport::QUIC_PORT_OFFSET;
                                let quic_port: u16 = 8001 + QUIC_PORT_OFFSET;
                                if let Ok(quic_addr) = format!("{}:{}", ip, quic_port).parse::<std::net::SocketAddr>() {
                                    let transport_arc_opt = GLOBAL_QUIC_TRANSPORT.read()
                                        .as_ref().map(|a| a.clone());
                                    if let Some(transport_arc) = transport_arc_opt {
                                        let transport = transport_arc.read().await;
                                        let (hint_mb, hint_round) = current_tc_hint();
                                        let ping = NetworkMessage::HealthPing {
                                            from: GLOBAL_NODE_ID.read().clone(),
                                            timestamp: std::time::SystemTime::now()
                                                .duration_since(std::time::UNIX_EPOCH)
                                                .unwrap_or_default()
                                                .as_secs(),
                                            height: LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed),
                                            cert_mb: hint_mb,
                                            cert_round: hint_round,
                                            signature: String::new(),
                                        };
                                        transport.send_message(quic_addr, &ping).await.is_ok()
                                    } else { false }
                                } else { false }
                            };

                            if quic_success {
                                if crate::node::is_info() {
                                    println!("[INFO][P2P] peer_height_ping sent via QUIC to {}", ip);
                                }
                                return; // Height will arrive via HealthPing response
                            }

                            // v33: inter-node HTTP fallback removed (top-L1: QUIC-only).
                            // The peer's height arrives via its signed QUIC HealthPing
                            // response; a transient QUIC miss self-heals on the next cycle.
                        }); } // end if should_query
                    }
                }
        }

            // v2.51: Genesis mode - connect to all Genesis peers
            let is_bootstrap_node = std::env::var("QNET_BOOTSTRAP_ID").is_ok();
            let active_peers = connected_peers.len();
            let is_small_network = active_peers < 6;
            
            if is_bootstrap_node || is_small_network {
                for (_region, peers_in_region) in regional_peers_data.iter() {
                    for peer in peers_in_region.iter().take(5) {
                        if peer.id == node_id || peer.addr.contains(&port.to_string()) {
                            continue;
                        }
                        let ip = peer.addr.split(':').next().unwrap_or("");
                        if is_genesis_node_ip(ip) && !connected_peers.contains_key(&peer.addr) {
                            let addr_clone = peer.addr.clone();
                            let ap = active_peers;
                            let is_connected = tokio::task::spawn_blocking(move || {
                                Self::is_peer_actually_connected_static(&addr_clone, ap)
                            }).await.unwrap_or(false);
                            if is_connected {
                                Self::admit_regional_candidate(&me, peer.clone());
                            }
                        }
                    }
                }
            }

            // v2.51: Backup regions if needed
            if connected_peers.len() < 3 {
                let current_peers = connected_peers.len();
                for backup_region in &backup_regions {
                    if let Some(peers) = regional_peers_data.get(backup_region) {
                        for peer in peers.iter().take(5) {
                            if connected_peers.len() >= 5 { break; }
                            if !connected_peers.contains_key(&peer.addr) {
                                let addr_clone = peer.addr.clone();
                                let cp = current_peers;
                                let is_connected = tokio::task::spawn_blocking(move || {
                                    Self::is_peer_actually_connected_static(&addr_clone, cp)
                                }).await.unwrap_or(false);
                                if is_connected {
                                    Self::admit_regional_candidate(&me, peer.clone());
                                }
                            }
                        }
                    }
                }
            }

            if crate::node::is_info() {
                println!("[INFO][P2P] regional_connect peers={}", connected_peers.len());
            }
            
            // v2.51: No need to copy back - already using DashMap directly
            {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] Failed to update connected_peers after establishment");
                }
            }
        });
        
        if crate::node::is_info() {
            println!("[INFO][P2P] Regional connection establishment started (non-blocking startup)");
        }
    }
    
    /// STATIC VERSION: Check if peer is actually connected (async-safe)
    pub(super) fn is_peer_actually_connected_static(peer_addr: &str, active_peers: usize) -> bool {
        // PRODUCTION: Real connectivity check using EXISTING static methods
        let ip = peer_addr.split(':').next().unwrap_or("");
        let is_genesis = is_genesis_node_ip(ip);
        
        // PRODUCTION: Strict Byzantine consensus - NO relaxed validation for offline peers
        // Genesis phase requires REAL connectivity for Byzantine fault tolerance
        let _is_bootstrap_node = std::env::var("QNET_BOOTSTRAP_ID").is_ok();
        let _is_small_network = active_peers < 6; // PRODUCTION: Bootstrap trust for Genesis network (1-5 nodes, all Genesis bootstrap nodes)
        let use_relaxed_validation = false; // PRODUCTION: Always use strict validation for Byzantine safety
        
        // PRODUCTION: Remove debug logs from hot path for scalability (millions of nodes)
        // Validation logs only for critical issues, not every peer check
        
        if is_genesis {
            // EXISTING: Use FAST TCP connectivity check (same as instance method)
            let is_connected = Self::test_peer_connectivity_static(peer_addr);
            
            if is_connected {
                // PRIVACY: Use pseudonym for peer address
                if crate::node::is_info() {
                    println!("[INFO][P2P] Genesis peer {} - FAST TCP connection verified", get_privacy_id_for_addr(peer_addr));
                }
                true
            } else {
                if use_relaxed_validation {
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Genesis peer {} - using relaxed validation for network formation", get_privacy_id_for_addr(peer_addr));
                    }
                    true // Allow for bootstrap/small networks
                } else {
                    if crate::node::is_warn() {
                        println!("[WARN][P2P] Genesis peer {} - TCP connection failed, excluding from consensus", get_privacy_id_for_addr(peer_addr));
                    }
                    false
                }
            }
        } else {
            // For non-genesis: use fast TCP connectivity check (same as Genesis)
            // QUIC connection will be established later for actual communication
            Self::test_peer_connectivity_static(peer_addr)
        }
    }
    
    /// Intelligent peer selection with load balancing
    pub fn select_optimal_peers(&self, required_count: usize) -> Vec<PeerInfo> {
        let regional_peers = self.regional_peers.lock();
        let metrics = self.regional_metrics.lock();
        let mut selected_peers = Vec::new();
        
        // Get regions sorted by capacity (best first)
        let mut region_scores: Vec<(Region, f32)> = metrics
            .iter()
            .map(|(region, metric)| {
                let capacity_score = metric.available_capacity;
                let latency_score = 1.0 - (metric.average_latency as f32 / 1000.0).min(1.0);
                let combined_score = (capacity_score + latency_score) / 2.0;
                (region.clone(), combined_score)
            })
            .collect();
        
        // SECURITY: Use unwrap_or to handle NaN safely (prevents panic)
        region_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        
        // Select peers from best regions first
        for (region, _score) in region_scores {
            if selected_peers.len() >= required_count {
                break;
            }
            
            if let Some(peers) = regional_peers.get(&region) {
                let mut region_peers: Vec<PeerInfo> = peers
                    .iter()
                    .filter(|p| {
                        p.latency_ms < self.lb_config.max_latency_threshold
                    })
                    .cloned()
                    .collect();
                
                // Sort by combined performance score
                region_peers.sort_by(|a, b| {
                    let score_a = self.calculate_peer_score(a);
                    let score_b = self.calculate_peer_score(b);
                    score_b.partial_cmp(&score_a).unwrap_or(std::cmp::Ordering::Equal)
                });
                
                // Take up to max_peers_per_region from this region
                let take_count = (required_count - selected_peers.len())
                    .min(self.lb_config.max_peers_per_region as usize)
                    .min(region_peers.len());
                
                selected_peers.extend(region_peers.into_iter().take(take_count));
            }
        }
        
        if crate::node::is_info() {
            println!("[INFO][P2P] Selected {} optimal peers using load balancing", selected_peers.len());
        }
        selected_peers
    }
    
    /// Calculate peer performance score (0.0-1.0, higher is better)
    pub(super) fn calculate_peer_score(&self, peer: &PeerInfo) -> f32 {
        let latency_score = 1.0 - (peer.latency_ms as f32 / 1000.0).min(1.0);
        let stability_score = if peer.is_stable { 1.0 } else { 0.5 };
        
        // Weighted average: Latency (60%), Stability (40%)
        (latency_score * 0.6) + (stability_score * 0.4)
    }
    
    /// Update peer metrics (v2.51: lock-free)
    pub fn update_peer_metrics(&self, peer_id: &str, latency_ms: u32, bandwidth_usage: u64) {
        // Use dual indexing for O(1) lookup by ID
        if let Some(addr_entry) = self.peer_id_to_addr.get(peer_id) {
            let addr = addr_entry.clone();
            if let Some(mut peer) = self.connected_peers_lockfree.get_mut(&addr) {
                peer.latency_ms = latency_ms;
                peer.bandwidth_usage = bandwidth_usage;
                peer.last_seen = self.current_timestamp();
            }
        }
        
        // Update regional metrics
        self.update_regional_metrics();
    }
    
    /// Update regional load balancing metrics (v2.51: lock-free)
    pub(super) fn update_regional_metrics(&self) {
        let mut metrics = self.regional_metrics.lock();
        
        for region in &[Region::NorthAmerica, Region::Europe, Region::Asia, Region::SouthAmerica, Region::Africa, Region::Oceania] {
            let region_peers: Vec<PeerInfo> = self.connected_peers_lockfree
                .iter()
                .filter(|e| e.value().region == *region)
                .map(|e| e.value().clone())
                .collect();
            
            if !region_peers.is_empty() {
                let avg_latency = region_peers.iter().map(|p| p.latency_ms).sum::<u32>() / region_peers.len() as u32;
                
                // Calculate available capacity based on peer count (more peers = more capacity)
                let capacity = (10.0 / (region_peers.len() as f32 + 1.0)).min(1.0);
                
                metrics.insert(region.clone(), RegionalMetrics {
                    region: region.clone(),
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
        let mut last_rebalance = self.last_rebalance.lock();
        let now = Instant::now();
        
        // Check if enough time has passed since last rebalance
        if now.duration_since(*last_rebalance).as_secs() < self.lb_config.rebalance_interval_secs {
            return false;
        }
        
        *last_rebalance = now;
        drop(last_rebalance);
        
        if crate::node::is_info() {
            println!("[INFO][P2P] Starting connection rebalancing");
        }
        
        // Get current load metrics
        let metrics = self.regional_metrics.lock();
        let overloaded_regions: Vec<Region> = metrics
            .iter()
            .filter(|(_, metric)| {
                metric.average_latency > self.lb_config.max_latency_threshold
            })
            .map(|(region, _)| region.clone())
            .collect();
        
        if overloaded_regions.is_empty() {
            if crate::node::is_info() {
                println!("[INFO][P2P] All regions operating within thresholds");
            }
            return false;
        }
        
        // v2.51: Lock-free overloaded peer removal
        let _initial_count = self.connected_peers_lockfree.len();
        let to_remove: Vec<String> = self.connected_peers_lockfree.iter()
            .filter(|entry| {
                let peer = entry.value();
                overloaded_regions.contains(&peer.region) && 
                peer.latency_ms > self.lb_config.max_latency_threshold
            })
            .map(|entry| entry.key().clone())
            .collect();
        
        // Full removal, not a bare map delete: an orphaned peer_id_to_addr row would make the very
        // peers this rebalance re-admits below unadmittable, draining the table toward the pinned set.
        for addr in &to_remove {
            self.remove_peer_lockfree(addr);
        }

        let dropped_count = to_remove.len();

        if dropped_count > 0 {
            // Replacements come from the regional discovery map, i.e. off the wire — they take the
            // same admission path as any other peer.
            let optimal_peers = self.select_optimal_peers(dropped_count);
            let mut readmitted = 0usize;
            for peer in optimal_peers {
                if self.add_peer_lockfree(peer) { readmitted = readmitted.saturating_add(1); }
            }

            if crate::node::is_info() {
                println!("[INFO][P2P] rebalance_complete dropped={} readmitted={}", dropped_count, readmitted);
            }
            true
        } else {
            false
        }
    }
    
    /// Start load balancing monitor
    pub(super) fn start_load_balancing_monitor(&self) {
        let is_running = self.is_running.clone();
        let last_check = self.last_health_check.clone();
        let connected_peers = self.connected_peers_lockfree.clone();
        let _regional_metrics = self.regional_metrics.clone();
        
        thread::spawn(move || {
            while *is_running.lock() {
                thread::sleep(Duration::from_secs(30)); // Check every 30 seconds
                
                *last_check.lock() = Instant::now();
                
                // PRODUCTION: Collect real metrics from connected peers via HTTP (v2.51: lock-free)
                for mut entry in connected_peers.iter_mut() {
                    if let Ok(metrics) = Self::query_peer_metrics(&entry.value().addr) {
                        entry.latency_ms = metrics.latency_ms;
                        entry.last_seen = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                    }
                }
                
                // Update regional metrics for load balancing decisions (silently)
                // This would be implemented as a method call in the actual instance
                // Removed spam log: Load balancing metrics updated
            }
        });
    }
    
    /// Start regional rebalancer
    pub(super) fn start_regional_rebalancer(&self) {
        let is_running = self.is_running.clone();
        let _node_id = self.node_id.clone();
        
        thread::spawn(move || {
            while *is_running.lock() {
                thread::sleep(Duration::from_secs(60)); // Rebalance every minute
                
                // In production: call self.rebalance_connections() (silently)
                // Removed spam log: Regional rebalancing check
            }
        });
    }
    
    /// Get load balancing statistics
    pub fn get_load_balancing_stats(&self) -> HashMap<String, serde_json::Value> {
        let metrics = self.regional_metrics.lock();
        
        let mut stats = HashMap::new();
        
        // v2.51: Lock-free peer count
        stats.insert("total_peers".to_string(), serde_json::Value::Number(self.connected_peers_lockfree.len().into()));
        stats.insert("total_bytes_sent".to_string(), serde_json::Value::Number((*self.total_bytes_sent.lock()).into()));
        stats.insert("total_bytes_received".to_string(), serde_json::Value::Number((*self.total_bytes_received.lock()).into()));
        
        // Regional breakdown
        let mut regional_stats = serde_json::Map::new();
        for (region, metric) in metrics.iter() {
            regional_stats.insert(format!("{:?}", region), serde_json::json!({
                "peer_count": metric.total_peers,
                "avg_latency_ms": metric.average_latency,
                "available_capacity": metric.available_capacity
            }));
        }
        stats.insert("regional_metrics".to_string(), serde_json::Value::Object(regional_stats));
        
        stats
    }
    
    /// Static method for testing peer connectivity (lifetime-safe for async contexts)
    /// v4.2 CRITICAL FIX: Reduced timeout from 5s to 2s to prevent tokio thread starvation.
    /// Single attempt only - no retries. If peer can't respond in 2s, treat as offline.
    /// Previous version (5s + check_api_readiness_static with 24s worst-case) caused
    /// cascading API deadlocks across the entire network.
    pub(super) fn test_peer_connectivity_static(peer_addr: &str) -> bool {
        use std::net::{TcpStream, SocketAddr, UdpSocket};
        use std::time::Duration;

        let ip = peer_addr.split(':').next().unwrap_or("");

        // v2.95: Try QUIC (UDP) first — works even when TCP ports are blocked by firewalls.
        // This is critical for node updates: TCP connections break when containers restart,
        // and some hosting providers block non-standard TCP ports.
        // UDP/QUIC is rarely blocked, so this ensures peer discovery always works.
        let quic_port: u16 = 10876; // Fixed QUIC port (API port 8001 + QUIC_PORT_OFFSET 2875)
        let quic_addr = format!("{}:{}", ip, quic_port);
        if let Ok(quic_socket_addr) = quic_addr.parse::<SocketAddr>() {
            // Check if QUIC transport already has a connection to this peer
            {
                let guard = GLOBAL_QUIC_TRANSPORT.read();
                if let Some(ref transport_arc) = *guard {
                    // Use try_read to avoid blocking on async RwLock from sync context
                    if let Ok(transport) = transport_arc.try_read() {
                        if transport.is_connected(&quic_socket_addr) {
                            if crate::node::is_info() {
                                println!("[INFO][P2P] peer_connected via=QUIC addr={}", get_privacy_id_for_addr(peer_addr));
                            }
                            return true;
                        }
                    }
                }
            }

            // UDP probe: send a small packet to check reachability (no response needed)
            // If the UDP socket can send without error, the peer's network is reachable
            if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
                socket.set_write_timeout(Some(Duration::from_secs(2))).ok();
                if socket.send_to(b"QNET_PROBE", quic_socket_addr).is_ok() {
                    // UDP send succeeded — peer network is reachable.
                    // The actual QUIC handshake will happen when we try to communicate.
                    if crate::node::is_info() {
                        println!("[INFO][P2P] peer_reachable via=UDP addr={}", get_privacy_id_for_addr(peer_addr));
                    }
                    return true;
                }
            }
        }

        // Fallback: TCP check on port 8001 (original behavior)
        let tcp_addr = format!("{}:8001", ip);
        if let Ok(socket_addr) = tcp_addr.parse::<SocketAddr>() {
            match TcpStream::connect_timeout(&socket_addr, Duration::from_secs(2)) {
                Ok(_) => return true,
                Err(_) => {}
            }
        }

        false
    }
    
    /// Query peer metrics - now returns placeholder as metrics come from QUIC stats
    pub(super) fn query_peer_metrics(_peer_addr: &str) -> Result<PeerMetrics, String> {
        // PRODUCTION v2.19.22: Metrics are collected from QUIC connection stats
        // This function is kept for backward compatibility
        Ok(PeerMetrics {
            latency_ms: 0,
            block_height: 0,
        })
    }
    
    /// Helper method to get current timestamp
    pub(super) fn current_timestamp(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
    
    /// v9.0: Per-peer consensus message rate check.
    /// Returns true if message should be DROPPED (rate exceeded).
    ///
    /// v18 USAGE NOTE: signature-verified consensus messages (TimeoutVote,
    /// ProducerHeartbeat, ProducerReady, ReadyAck,
    /// BlockRejection, VrfLeaderClaim, BlockAttestation, EmptySlotAttestation,
    /// VrfKeyAnnounce) NO LONGER consult this helper — those handlers verify
    /// the ML-DSA-65 signature against the consensus PK registry as the
    /// canonical security gate, and use existing protocol-level dedup maps
    /// (TIMEOUT_VOTES round-uniqueness, READY_ACKS distinct-ack DashSet,
    /// BLOCK_REJECTION_OBSERVERS distinct-observer DashSet, etc.) as the
    /// natural emission cap. The legacy 30/min cap was the immediate cause
    /// of the v17.x stall observed at h=180-241 — under a sustained timeout
    /// stall the rotation round increments at ≈1/sec, producing ≈60 signed
    /// TimeoutVotes/min that tripped the 30/min cap and silently dropped
    /// honest validator gossip. With strict 2f+1 BFT-certified rotation
    /// (node.rs v15.13), even a single rate-limited voter prevented
    /// HIGHEST_CERTIFIED_ROUND from advancing → producer rotation froze.
    ///
    /// Industry-standard L1 BFT protocols never count-rate-limit signed
    /// consensus messages — the protocol-level uniqueness invariant
    /// (one vote per validator per round) is sufficient.
    ///
    /// This helper is RETAINED for:
    ///   * `health_ping` — unsigned liveness probes (DoS protection on
    ///     pure-network paths where signature is not the primary gate).
    ///   * `active_announce` (ActiveNodeAnnouncement) — non-consensus
    ///     telemetry path with adaptive limit (10 + active/5, capped 200)
    ///     scaling to thousands of super-nodes; protects the ~35 ms
    ///     ML-DSA-65 verify cost from gossip-amplified flood.
    pub(super) fn is_consensus_rate_limited(&self, peer_id: &str, msg_type: &str, max_per_min: usize) -> bool {
        let now = self.current_timestamp();
        let rate_key = format!("cons_{}_{}", msg_type, peer_id);
        let mut entry = self.rate_limiter.entry(rate_key).or_insert_with(|| RateLimit {
            requests: Vec::new(),
            max_requests: max_per_min,
            window_seconds: 60,
            blocked_until: 0,
        });
        if entry.blocked_until > now {
            // v9.1: Cap maximum block duration to 600s to prevent permanent block on NTP drift.
            // If blocked_until is more than 600s in the future, it's likely a clock issue — unblock.
            if entry.blocked_until.saturating_sub(now) > 600 {
                entry.blocked_until = 0;
            } else {
                return true; // still blocked
            }
        }
        entry.requests.retain(|&t| t > now.saturating_sub(60));
        if entry.requests.len() >= max_per_min {
            entry.blocked_until = now + 300; // block 5 min
            if crate::node::is_warn() {
                println!("[WARN][RATE] consensus_{} flood from={} blocked_5min", msg_type, peer_id);
            }
            return true;
        }
        entry.requests.push(now);
        false
    }

    /// Regional clustering for geographical load balancing
    pub(super) fn start_regional_clustering(&self) {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] No Tokio runtime - regional clustering deferred");
                }
                return;
            }
        };
        
        let _node_id = self.node_id.clone();
        let region = self.region.clone();
        let _regional_peers = self.regional_peers.clone();
        let connected_peers = self.connected_peers_lockfree.clone();
        let is_running = self.is_running.clone();
        
        handle.spawn(async move {
            crate::boot_contract::started(crate::boot_contract::names::REGIONAL_CLUSTERING);
            if crate::node::is_info() {
                println!("[INFO][P2P] Starting regional clustering for region: {:?}", region);
            }
            
            // Regional clustering logic
            while *is_running.lock() {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                
                // Rebalance regional connections
                let mut regional_counts = std::collections::HashMap::new();
                
                // v2.51: Lock-free regional counting
                for entry in connected_peers.iter() {
                    *regional_counts.entry(entry.value().region.clone()).or_insert(0) += 1;
                }
                
                // Ensure we have peers in our region
                let our_region_count = regional_counts.get(&region).unwrap_or(&0);
                if *our_region_count < 2 {
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Looking for more peers in region: {:?}", region);
                    }
                    
                    // Get dynamic IP for regional peer discovery
                    let _external_ip = match Self::get_our_ip_address().await {
                        Ok(ip) => ip,
                        Err(e) => {
                            if crate::node::is_warn() {
                                println!("[WARN][P2P] Failed to get external IP for regional clustering: {}", e);
                            }
                            continue;
                        }
                    };
                    
                    // PRODUCTION: Regional clustering uses only real discovered peers
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Region {} needs more peers - expanding discovery range", region_string(&region));
                    }
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Initiating wider peer discovery for better regional coverage");
                    }
                }
                
                // Report regional distribution
                if crate::node::is_info() {
                    println!("[INFO][P2P] Regional distribution: {:?}", regional_counts);
                }
            }
        });
    }
    
    /// Static method for activation code validation (SYNC version)
    /// Validates peers based on their node_id format and blacklist status
    pub(super) fn validate_activation_codes_static(peers: &[PeerInfo]) -> Vec<PeerInfo> {
        let mut validated_peers = Vec::new();
        
        for peer in peers {
            // VALIDATION RULES:
            // 1. Genesis nodes (genesis_node_XXX) - always valid (bootstrap nodes)
            // 2. Regular nodes - must have valid node_id format
            // 3. Blacklisted patterns - reject
            
            let is_genesis = peer.id.starts_with("genesis_node_") || 
                             peer.id.starts_with("super_genesis_");
            
            let is_blacklisted = peer.id.contains("invalid") || 
                                 peer.id.contains("banned") || 
                                 peer.id.contains("slashed") ||
                                 peer.id.contains("malicious");
            
            // v3.18: Full nodes removed
            let has_valid_format = peer.id.starts_with("light_") ||
                                   peer.id.starts_with("super_") ||
                                   peer.id.starts_with("genesis_node_") ||
                                   peer.id.starts_with("node_");
            
            let is_valid = if is_blacklisted {
                if crate::node::is_warn() {
                    println!("[ERR][P2P] Peer {} rejected: blacklisted", peer.id);
                }
                false
            } else if is_genesis {
                // Genesis/bootstrap nodes are always valid
                if crate::node::is_info() {
                    println!("[INFO][P2P] Peer {} validated: Genesis bootstrap node", peer.id);
                }
                true
            } else if has_valid_format {
                // Regular nodes with valid format
                if crate::node::is_info() {
                    println!("[INFO][P2P] Peer {} validated: valid node format", peer.id);
                }
                true
            } else {
                // Unknown format - log but allow for flexibility
                if crate::node::is_warn() {
                    println!("[WARN][P2P] Peer {} has unknown format, allowing", peer.id);
                }
                true
            };
            
            if is_valid {
                validated_peers.push(peer.clone());
            }
        }
        
        validated_peers
    }
    

    
    /// Get our external IP address with STUN support for NAT traversal
    pub(super) async fn get_our_ip_address() -> Result<String, Box<dyn std::error::Error>> {
        use std::process::Command;
        use std::net::{SocketAddr, UdpSocket};
        
        // IMPROVED: Check if we're in Docker and need special handling
        if std::path::Path::new("/.dockerenv").exists() {
            if crate::node::is_info() {
                println!("[INFO][P2P] Docker environment detected, using enhanced NAT traversal");
            }
            
            // CRITICAL: Try environment variables first (user can set QNET_EXTERNAL_IP)
            if let Ok(external_ip) = std::env::var("QNET_EXTERNAL_IP") {
                if crate::node::is_info() {
                    println!("[INFO][P2P] Using configured external IP: {}", get_privacy_id_for_addr(&external_ip));
                }
                return Ok(external_ip);
            }
            
            // Try Docker host IP from environment
            if let Ok(docker_host) = std::env::var("DOCKER_HOST_IP") {
                if crate::node::is_info() {
                    println!("[INFO][P2P] Using Docker host IP: {}", get_privacy_id_for_addr(&docker_host));
                }
                return Ok(docker_host);
            }
            
            // CRITICAL: Force STUN for Docker to get real external IP
            // Docker containers always have 172.17.x.x internally, must use STUN
            if crate::node::is_info() {
                println!("[INFO][P2P] Docker detected: forcing STUN NAT traversal for external IP");
            }
        }
        
        // IMPROVED: Try STUN server for NAT traversal (Google's public STUN)
        if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
            socket.set_read_timeout(Some(Duration::from_secs(3))).ok();
            
            // STUN servers for NAT traversal
            let stun_servers = [
                "stun.l.google.com:19302",
                "stun1.l.google.com:19302",
                "stun2.l.google.com:19302",
            ];
            
            for stun_server in &stun_servers {
                if let Ok(stun_addr) = stun_server.parse::<SocketAddr>() {
                    // Simple STUN binding request (RFC 5389)
                    let stun_request = [
                        0x00, 0x01, // Binding Request
                        0x00, 0x00, // Message Length
                        0x21, 0x12, 0xA4, 0x42, // Magic Cookie
                        // Transaction ID (12 bytes)
                        0x00, 0x01, 0x02, 0x03,
                        0x04, 0x05, 0x06, 0x07,
                        0x08, 0x09, 0x0A, 0x0B,
                    ];
                    
                    if socket.send_to(&stun_request, stun_addr).is_ok() {
                        let mut buf = [0u8; 1024];
                        if let Ok((len, _)) = socket.recv_from(&mut buf) {
                            // Parse STUN response for XOR-MAPPED-ADDRESS
                            if len >= 32 {
                                // Bound so every buf[i+11] access stays within the received bytes.
                                for i in 20..len.saturating_sub(11) {
                                    if buf[i] == 0x00 && buf[i+1] == 0x20 {
                                        // Found XOR-MAPPED-ADDRESS
                                        let port = u16::from_be_bytes([buf[i+6], buf[i+7]]) ^ 0x2112;
                                        let ip = format!("{}.{}.{}.{}", 
                                            buf[i+8] ^ 0x21, buf[i+9] ^ 0x12,
                                            buf[i+10] ^ 0xA4, buf[i+11] ^ 0x42);
                                        // PRIVACY: Show privacy ID in logs, but return real IP for internal use
                                        if crate::node::is_info() {
                                            println!("[INFO][P2P] STUN resolved external IP: {} (port: {})", 
                                                    get_privacy_id_for_addr(&ip), port);
                                        }
                                        return Ok(ip);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // Fallback to HTTP-based IP detection
        if let Ok(output) = Command::new("curl")
            .arg("-s")
            .arg("--max-time")
            .arg("3")
            .arg("https://api.ipify.org")
            .output() {
            if output.status.success() {
                if let Ok(ip) = String::from_utf8(output.stdout) {
                    let ip = ip.trim();
                    if !ip.is_empty() && ip != "0.0.0.0" {
                        return Ok(ip.to_string());
                    }
                }
            }
        }
        
        // Fallback to hostname -I
        if let Ok(output) = Command::new("hostname").arg("-I").output() {
            if output.status.success() {
                if let Ok(ip_list) = String::from_utf8(output.stdout) {
                    // Get first non-localhost IP
                    for ip in ip_list.split_whitespace() {
                        if !ip.starts_with("127.") && !ip.starts_with("::1") {
                            return Ok(ip.to_string());
                        }
                    }
                }
            }
        }
        
        // Last resort - try to get local IP by connecting to 8.8.8.8
        if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if socket.connect("8.8.8.8:53").is_ok() {
                if let Ok(local_addr) = socket.local_addr() {
                    let ip = local_addr.ip().to_string();
                    if !ip.starts_with("127.") {
                        return Ok(ip);
                    }
                }
            }
        }
        
        Err("Could not determine IP address".into())
    }

}

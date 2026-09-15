//! QUIC transport lifecycle: init, send, broadcast, connection reaping and shutdown.

use super::*;
/// Rate limiter for the unroutable-peer report below.
static UNROUTABLE_REPORTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);


impl SimplifiedP2P {
    /// PRODUCTION v2.19.21: Initialize QUIC transport for high-performance P2P
    /// 
    /// Features:
    /// - Binary protocol (bincode) instead of JSON
    /// - TLS 1.3 encryption + node_id handshake
    /// - Persistent connections with multiplexing (100 streams)
    /// - Server accepts incoming connections
    /// - NO HTTP fallback (pure QUIC)
    pub async fn init_quic(&mut self, _external_ip: &str, cert_serial: &str) -> Result<(), String> {
        use crate::quic_transport::{QuicTransport, QUIC_PORT, MessageHandler};
        use std::net::SocketAddr;
        
        // QUIC always uses fixed port 10876 (Docker: -p 10876:10876/udp)
        let quic_port = QUIC_PORT;
        let bind_addr: SocketAddr = format!("0.0.0.0:{}", quic_port)
            .parse()
            .map_err(|e| format!("Invalid QUIC bind address: {}", e))?;
        
        // UNIFIED: Use lowercase format consistent with ActiveNodeAnnouncement
        // v3.18: Full node type removed - only Light and Super remain
        let node_type_str = match self.node_type {
            NodeType::Super => "super",
            NodeType::Light => "light",
        };
        let mut transport = QuicTransport::new(self.node_id.clone(), node_type_str.to_string(), quic_port);
        
        // Initialize endpoint
        transport.init(bind_addr, cert_serial).await
            .map_err(|e| format!("QUIC init failed: {}", e))?;
        
        // PRODUCTION v2.19.22: Route ALL QUIC messages through channel to handle_message()
        // This ensures QUIC uses SAME logic as HTTP - no code duplication!
        let quic_message_tx = self.quic_message_tx.clone();
        let quic_bulk_tx = self.quic_bulk_tx.clone();
        let quic_finality_tx = self.quic_finality_tx.clone();

        let handler: MessageHandler = Arc::new(move |peer_addr, msg| {
            let peer_str = format!("{}:8001", peer_addr.ip());

            // Finality first: non-redundant 2f+1 checkpoint/round-change frames get the
            // reserved lane so a gossip/shred flood can never drop the votes that assemble
            // the finality QC. Disjoint from the bulk set; kept first for future-proofing.
            if Self::is_finality_lane_message(&msg) {
                let fg = quic_finality_tx.lock();
                if let Some(ref tx) = *fg {
                    if tx.try_send((peer_str, msg)).is_err() {
                        FINALITY_LANE_DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    return;
                }
                // Lane unwired (never after boot): fall through to the gossip lane so a
                // finality frame is never silently lost.
            }

            // Control-plane serve requests (anchor pulls, genesis capsules) are deliberately NOT in
            // the bulk set, so they take the high-priority lane below alongside consensus traffic.
            // They do not get a lane of their own: a reservation carved out of the finality lane is
            // exactly what that lane exists to prevent.
            // QoS split: bulk-serving msgs → bounded bulk lane (drop-on-full =
            // hard DoS bound, never blocks); everything consensus-critical →
            // high-priority lane. Two channels + two drain tasks = a cold-sync
            // flood structurally cannot delay consensus.
            if Self::is_bulk_lane_message(&msg) {
                let bg = quic_bulk_tx.lock();
                if let Some(ref tx) = *bg {
                    if tx.try_send((peer_str, msg)).is_err() {
                        BULK_LANE_DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    }
                }
                return;
            }
            let tx_guard = quic_message_tx.lock();
            if let Some(ref tx) = *tx_guard {
                if let Err(e) = tx.try_send((peer_str.clone(), msg)) {
                    if crate::node::is_warn() { println!("[WARN][QUIC] Failed to queue message from {}: {}", peer_str, e); }
                }
            } else {
                if crate::node::is_warn() { println!("[WARN][QUIC] Message from {} dropped - channel not initialized yet!", peer_str); }
            }
        });
        
        transport.set_message_handler(handler);
        
        // Start server (accept incoming connections)
        transport.start_server().await
            .map_err(|e| format!("QUIC server start failed: {}", e))?;
        
        let quic_arc = Arc::new(tokio::sync::RwLock::new(transport));
        self.quic_transport = Some(quic_arc.clone());
        self.quic_enabled.store(true, std::sync::atomic::Ordering::SeqCst);
        
        // v2.24.3: Set global QUIC transport for static sync methods
        // This enables QUIC-based block sync without passing &self
        {
            let mut guard = GLOBAL_QUIC_TRANSPORT.write();
            *guard = Some(quic_arc);
            if crate::node::is_info() { println!("[INFO][QUIC] Global QUIC transport registered for sync"); }
        }

        // v2.24.3: Set global node ID for sync requests
        *GLOBAL_NODE_ID.write() = self.node_id.clone();
        
        if crate::node::is_info() { println!("[INFO][QUIC] Transport + Server initialized on port {}", quic_port); }
        if crate::node::is_info() { println!("[INFO][QUIC] Timeouts: connect=3s, idle=90s, keepalive=30s (aligned with HTTP)"); }
        if crate::node::is_info() { println!("[INFO][QUIC] Binary protocol (bincode), TLS 1.3, 100 streams/conn"); }
        Ok(())
    }
    
    /// PRODUCTION v2.19.21: Send NetworkMessage via QUIC (pure QUIC, no HTTP fallback)
    /// 
    /// Uses binary protocol (bincode) for efficient serialization
    pub async fn send_message_quic(&self, peer_addr: &str, message: &NetworkMessage) -> Result<Option<NetworkMessage>, String> {
                use std::net::SocketAddr;
        
        if !self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("QUIC not enabled".into());
        }
        
        let quic_transport = self.quic_transport.as_ref()
            .ok_or("QUIC transport not initialized")?;
        
        // Convert peer address to QUIC port (port + 1000)
        let parts: Vec<&str> = peer_addr.split(':').collect();
        if parts.len() != 2 {
            return Err(format!("Invalid peer address format: {}", peer_addr));
        }
        
        let ip: std::net::IpAddr = parts[0].parse()
            .map_err(|e| format!("Invalid IP: {}", e))?;
        let port: u16 = parts[1].parse()
            .map_err(|e| format!("Invalid port: {}", e))?;
        
        let quic_port = port.saturating_add(crate::p2p_transport::QUIC_PORT_OFFSET);
        let quic_addr = SocketAddr::new(ip, quic_port);
        
        let transport = quic_transport.read().await;
        transport.send_message(quic_addr, message).await
            .map_err(|e| format!("QUIC send failed: {}", e))?;
        Ok(None) // QUIC doesn't return response for unidirectional messages
    }
    
    /// PRODUCTION v2.19.21: Broadcast NetworkMessage to all peers via QUIC

    pub async fn broadcast_quic(&self, message: &NetworkMessage) -> Vec<crate::p2p_transport::BroadcastResult> {
        use crate::p2p_transport::BroadcastResult;
        use crate::quic_transport::QUIC_PORT_OFFSET;
        
        if !self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed) {
            return Vec::new();
        }
        
        let quic_transport = match self.quic_transport.as_ref() {
            Some(t) => t,
            None => return Vec::new(),
        };
        
        // Get current peers (v2.51: lock-free)
        let peers: Vec<PeerInfo> = self.connected_peers_lockfree.iter()
            .map(|entry| entry.value().clone())
            .collect();
        
        // Concurrent fan-out, bounded. Awaiting peers in turn made one consensus frame cost up to
        // MAX_CONNECTED_PEERS round trips end to end, with the slowest link setting the pace for all
        // of them - paid by every proposal, vote and timeout that has to reach quorum in one view.
        const BROADCAST_FANOUT: usize = 64;
        // Serialize ONCE and share: per-peer serialization under a concurrent fan-out would hold
        // BROADCAST_FANOUT copies of a frame that is megabytes at committee scale.
        let wire = match crate::quic_transport::QuicTransport::serialize_for_broadcast(message) {
            Ok(w) => std::sync::Arc::new(w),
            Err(e) => {
                if crate::node::is_warn() { println!("[WARN][QUIC] broadcast_serialize_failed err={}", e); }
                return Vec::new();
            }
        };
        use futures::stream::StreamExt;
        // An address that does not parse silently excluded that peer from EVERY consensus broadcast
        // for the process lifetime. Count and report it: a peer missing from the fan-out is
        // indistinguishable at the sender from a peer that received the frame.
        let offered = peers.len();
        let mut unroutable = 0usize;
        let targets: Vec<(String, std::net::SocketAddr)> = peers.into_iter().filter_map(|peer| {
            let parts: Vec<&str> = peer.addr.split(':').collect();
            if parts.len() != 2 { unroutable += 1; return None; }
            match (parts[0].parse::<std::net::IpAddr>(), parts[1].parse::<u16>()) {
                (Ok(ip), Ok(port)) => Some((
                    peer.addr.clone(),
                    std::net::SocketAddr::new(ip, port.saturating_add(QUIC_PORT_OFFSET)),
                )),
                _ => { unroutable += 1; None }
            }
        }).collect();
        if unroutable > 0 {
            let c = UNROUTABLE_REPORTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if (c < 3 || c % 256 == 0) && crate::node::is_warn() {
                println!("[WARN][P2P] broadcast_unroutable_peers dropped={} of={} — address is not ip:port",
                         unroutable, offered);
            }
        }
        let transport = quic_transport.read().await;
        let results: Vec<BroadcastResult> = futures::stream::iter(targets)
            .map(|(addr, quic_addr)| {
                let transport = &transport;
                let wire = wire.clone();
                async move {
                    let start = std::time::Instant::now();
                    match transport.broadcast_wire_to(quic_addr, &wire).await {
                        Ok(_) => BroadcastResult {
                            peer_addr: addr, success: true,
                            rtt_ms: Some(start.elapsed().as_millis() as u64), error: None,
                        },
                        Err(e) => BroadcastResult {
                            peer_addr: addr, success: false, rtt_ms: None,
                            error: Some(format!("{}", e)),
                        },
                    }
                }
            })
            .buffer_unordered(BROADCAST_FANOUT)
            .collect()
            .await;

        results
    }
    
    /// PRODUCTION v2.19.21: Get QUIC statistics
    pub async fn get_quic_stats(&self) -> Option<crate::quic_transport::QuicStats> {
        if let Some(ref quic_transport) = self.quic_transport {
            let transport = quic_transport.read().await;
            Some(transport.get_stats().await)
        } else {
            None
        }
    }
    
    /// PRODUCTION v2.19.21: Cleanup idle QUIC connections
    pub fn cleanup_quic_idle(&self) {
        if let Some(ref quic_transport) = self.quic_transport {
            // Use blocking approach since cleanup_idle is sync
            let rt = tokio::runtime::Handle::try_current();
            if let Ok(handle) = rt {
                let transport = quic_transport.clone();
                handle.spawn(async move {
                    let t = transport.read().await;
                    t.cleanup_idle();
                });
            }
        }
    }
    
    /// Resolve our external IP once. Genesis nodes get it from constants; every other node used to
    /// receive it only as a side effect of internet announcement, so operator super nodes ran with
    /// `external_ip = None` — self-connect filtering and the peer-admission self-check both misfire
    /// on that. Best-effort with backoff: a resolver outage must not stop the node.
    pub(super) fn start_external_ip_resolution(&self) {
        if self.external_ip.read().is_some() {
            crate::boot_contract::started(crate::boot_contract::names::EXTERNAL_IP_RESOLVER);
            return;
        }
        let store = self.external_ip.clone();
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };
        handle.spawn(async move {
            crate::boot_contract::started(crate::boot_contract::names::EXTERNAL_IP_RESOLVER);
            let mut backoff = 5u64;
            loop {
                // Collapse to String at the call site: the boxed error is not Send and must not
                // survive into the retry await.
                let resolved = Self::get_our_ip_address().await.map_err(|e| e.to_string());
                match resolved {
                    Ok(ip) => {
                        *store.write() = Some(ip.clone());
                        if crate::node::is_info() {
                            println!("[INFO][P2P] external_ip_resolved ip={}", get_privacy_id_for_addr(&ip));
                        }
                        return;
                    }
                    Err(reason) => {
                        if crate::node::is_warn() {
                            println!("[WARN][P2P] external_ip_unresolved err={} retry_in={}s", reason, backoff);
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                        backoff = (backoff * 2).min(300);
                    }
                }
            }
        });
    }

    /// Periodic idle-QUIC reap. The only other caller of `cleanup_quic_idle` is the emergency
    /// reconnect path, so on a healthy node connection state grew for the process lifetime —
    /// an unbounded fd/memory path once peer churn is measured in thousands.
    pub(super) fn start_quic_idle_reaper(&self) {
        let quic_transport = match self.quic_transport.clone() {
            Some(t) => t,
            None => {
                crate::boot_contract::skipped(crate::boot_contract::names::QUIC_IDLE_REAPER, "no_quic_transport");
                return;
            }
        };
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };
        handle.spawn(async move {
            crate::boot_contract::started(crate::boot_contract::names::QUIC_IDLE_REAPER);
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                let t = quic_transport.read().await;
                t.cleanup_idle();
            }
        });
    }

    /// v4.2: Force reconnect to all bootstrap peers.
    /// Called when EMERGENCY SYNC is stuck — drops dead QUIC connections
    /// and re-establishes them from scratch.
    pub async fn reconnect_all_bootstrap_peers(&self) {
        let bootstrap_ips = get_genesis_bootstrap_ips();
        let bootstrap_addrs: Vec<String> = bootstrap_ips.iter()
            .map(|ip| format!("{}:8001", ip))
            .collect();

        if crate::node::is_info() {
            println!("[INFO][P2P] reconnect_all_bootstrap: dropping dead QUIC + re-adding {} peers",
                     bootstrap_addrs.len());
        }

        self.cleanup_quic_idle();

        for addr in &bootstrap_addrs {
            self.remove_peer_lockfree(addr);
        }

        self.connect_to_bootstrap_peers(&bootstrap_addrs);
    }

    /// PRODUCTION: Get QUIC connection count for monitoring
    pub async fn get_quic_connection_count(&self) -> usize {
        if let Some(ref quic_transport) = self.quic_transport {
            let transport = quic_transport.read().await;
            transport.connection_count()
        } else {
            0
        }
    }
    
    /// PRODUCTION: Check if QUIC is connected to specific peer
    pub async fn is_quic_connected_to(&self, peer_addr: &str) -> bool {
        use crate::quic_transport::QUIC_PORT_OFFSET;
        
        if let Some(ref quic_transport) = self.quic_transport {
            let parts: Vec<&str> = peer_addr.split(':').collect();
            if parts.len() == 2 {
                if let (Ok(ip), Ok(port)) = (parts[0].parse::<std::net::IpAddr>(), parts[1].parse::<u16>()) {
                    let quic_port = port.saturating_add(QUIC_PORT_OFFSET);
                    let quic_addr = std::net::SocketAddr::new(ip, quic_port);
                    
                    let transport = quic_transport.read().await;
                    return transport.is_connected(&quic_addr);
                }
            }
        }
        false
    }
    
    /// PRODUCTION: Graceful QUIC shutdown
    pub async fn stop_quic(&self) {
        if let Some(ref quic_transport) = self.quic_transport {
            let transport = quic_transport.read().await;
            transport.stop();
            if crate::node::is_warn() { println!("[WARN][QUIC] QUIC transport stopped gracefully"); }
        }
    }
    
    /// PRODUCTION: Load jail statuses from persistent storage on startup
    /// This ensures jail survives node restart
    pub fn load_jail_statuses_on_startup(&self) {
        let jail_statuses = self.load_jail_from_storage();
        
        if jail_statuses.is_empty() {
            return;
        }
        
        // v2.21.5: Jails now handled via DeterministicReputationState from blockchain
        // This sync is only for logging - actual jails are in blockchain
        for (node_id, jailed_until, jail_count, _reason) in jail_statuses {
            let display_id = if node_id.starts_with("genesis_node_") || node_id.starts_with("node_") || node_id.starts_with("super_") {
                node_id.clone()
            } else {
                get_privacy_id_for_addr(&node_id)
            };
            
            if jailed_until == u64::MAX {
                if crate::node::is_info() { println!("[INFO][P2P] Restored PERMANENT BAN for {} from blockchain", display_id); }
            } else {
                if crate::node::is_info() { println!("[INFO][P2P] Restored jail for {} (offense #{}) from blockchain", display_id, jail_count); }
            }
        }
    }
    
}

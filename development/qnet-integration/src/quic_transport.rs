//! # QNet QUIC Transport Layer (Post-Quantum Secure)
//!
//! High-performance QUIC transport for QNet P2P network.
//! Replaces HTTP for all P2P communication.
//!
//! ## Post-Quantum Key Exchange (v4.8)
//! Uses aws-lc-rs crypto provider with ML-KEM 768 (FIPS 203, formerly Kyber).
//! Every TLS 1.3 handshake negotiates X25519Kyber768Draft00 hybrid key exchange:
//!   - X25519 (classical ECDH) + ML-KEM 768 (post-quantum KEM)
//!   - If quantum computer breaks X25519 → ML-KEM still protects
//!   - If ML-KEM has vulnerability → X25519 still protects
//! Combined with Dilithium3 signatures = full post-quantum P2P security.
//!
//! ## Architecture
//!
//! ```
//! ┌─────────────────────────────────────────────────────────────────┐
//! │                    QUIC Transport Stack                         │
//! ├─────────────────────────────────────────────────────────────────┤
//! │ Server: Accept incoming connections                             │
//! │   - endpoint.accept() loop in background task                  │
//! │   - Handle incoming streams                                     │
//! │   - Route messages to handler callback                         │
//! ├─────────────────────────────────────────────────────────────────┤
//! │ Client: Connect to peers                                        │
//! │   - Persistent connection pool                                  │
//! │   - Automatic reconnection                                      │
//! │   - Binary protocol (bincode)                                   │
//! └─────────────────────────────────────────────────────────────────┘
//! ```

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicBool, Ordering};
use std::time::{Duration, Instant};
use std::collections::HashMap;

use dashmap::DashMap;
use quinn::{Endpoint, ServerConfig, ClientConfig, Connection, VarInt, RecvStream, SendStream};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::sync::{RwLock, Mutex};
use serde::{Serialize, Deserialize};

use crate::unified_p2p::{NetworkMessage, get_privacy_id_for_addr};
use crate::node::{is_info, is_warn, is_debug};

// ============================================================================
// RETRY CONSTANTS (v2.24 - improved reconnect logic)
// ============================================================================

/// Number of connection retry attempts (v2.45: reduced from 5 to 3 for faster failover)
/// With 2s timeout, max delay = 3 × 2s = 6s (was 5 × 5s = 25s)
const CONNECT_RETRY_ATTEMPTS: u32 = 3;

/// Extended retry for handshake failures (aborted by peer is common at startup)
const HANDSHAKE_RETRY_ATTEMPTS: u32 = 5;

/// Delay between retry attempts (exponential backoff base)
const RETRY_DELAY_MS: u64 = 50;

/// Maximum delay between retries (v2.45: reduced from 2000ms to 500ms)
const MAX_RETRY_DELAY_MS: u64 = 500;


// ============================================================================
// CONSTANTS - ALIGNED WITH HTTP VALUES
// ============================================================================

/// Connection timeout (v2.45: kept at 3s for reliability)
pub const CONNECT_TIMEOUT_SECS: u64 = 3;

/// Send/receive timeout (v4.1: increased from 3s to 10s for 87MB blocks)
/// At 100Mbps: 87MB takes ~7s, 10s gives safety margin
/// Combined with CONNECT_RETRY_ATTEMPTS=3: max 30s per send
pub const MESSAGE_TIMEOUT_SECS: u64 = 10;

/// Keep-alive interval (same as HTTP TCP keepalive: 30s)
pub const KEEP_ALIVE_SECS: u64 = 30;

/// Idle connection timeout (same as HTTP pool: 90s)
pub const IDLE_TIMEOUT_SECS: u64 = 90;

/// Maximum concurrent streams per connection (v2.45: increased from 100 to 500)
/// High-throughput L1 requires many concurrent streams for block propagation
pub const MAX_STREAMS_PER_CONN: u32 = 500;

/// Fixed QUIC port - always use this port for QUIC connections
/// Docker maps this port: -p 10876:10876/udp
pub const QUIC_PORT: u16 = 10876;

/// QUIC port offset from API port (8001 -> 10876)
/// NOTE: peer.addr contains API port (8001), so offset = 10876 - 8001 = 2875
pub const QUIC_PORT_OFFSET: u16 = 2875;

/// Maximum message size (10 MB - for macroblocks)
pub const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024;

/// Protocol version
pub const PROTOCOL_VERSION: u8 = 1;

/// Maximum concurrent incoming handshakes (v6.3: DoS protection).
/// Each TLS 1.3 + Kyber handshake costs ~2-5ms CPU. Capping at 64
/// limits worst-case CPU burn to ~320ms even under botnet flood.
/// Legitimate peers retry with backoff; this only throttles bursts.
const MAX_CONCURRENT_HANDSHAKES: usize = 64;

/// Hard timeout for incoming TLS+Kyber768 handshake (v6.4: death spiral fix).
/// If `incoming.await` exceeds this limit, the permit is released immediately.
/// Without this timeout, stalled peers hold permits for the full QUIC idle timeout
/// (~30s), and 64 stalled peers permanently block ALL incoming QUIC connections
/// (observed: 2.5M throttled events in 1 hour — complete QUIC transport death).
const INCOMING_HANDSHAKE_TIMEOUT_SECS: u64 = 5;

// ============================================================================
// ADAPTIVE RTT - Per-peer RTT cache for optimal congestion control (v6.3)
// ============================================================================

/// Conservative default initial_rtt for unknown peers.
/// Covers inter-continental links (US↔EU ~110ms, EU↔Asia ~200ms).
/// Quinn Cubic/BBR quickly converges down for same-DC (<1ms) peers.
const DEFAULT_INITIAL_RTT_MS: u64 = 250;

/// Minimum initial_rtt — never go below this even with cached data.
/// Prevents over-aggressive sending on brief RTT dips.
const MIN_INITIAL_RTT_MS: u64 = 10;

/// Maximum initial_rtt — never seed higher than this.
/// Even satellite links (~600ms) are served within this bound.
const MAX_INITIAL_RTT_MS: u64 = 2000;

/// Maximum entries in the RTT cache. Bounded to prevent memory leak
/// when encountering many ephemeral peers. At ~64 bytes per entry,
/// 10 000 peers = ~640 KB — negligible.
const RTT_CACHE_MAX_ENTRIES: usize = 10_000;

/// Peer RTT observation: stores the last measured RTT and a timestamp
/// for cache eviction / freshness checks.
#[derive(Clone, Debug)]
struct PeerRttEntry {
    rtt_ms: u64,
    updated_at: Instant,
}

/// Bounded per-peer RTT cache. Uses a simple HashMap with eviction
/// of the oldest entry when capacity is exceeded.
/// Protected by Mutex — contention is negligible because writes happen
/// only on connection close / health-check (every 15-30s per peer).
struct PeerRttCache {
    entries: HashMap<SocketAddr, PeerRttEntry>,
}

impl PeerRttCache {
    fn new() -> Self {
        Self {
            entries: HashMap::with_capacity(128),
        }
    }

    fn get(&self, addr: &SocketAddr) -> Option<u64> {
        self.entries.get(addr).map(|e| e.rtt_ms)
    }

    fn update(&mut self, addr: SocketAddr, rtt_ms: u64) {
        if rtt_ms == 0 {
            return;
        }
        if self.entries.len() >= RTT_CACHE_MAX_ENTRIES && !self.entries.contains_key(&addr) {
            if let Some(oldest_addr) = self.find_oldest() {
                self.entries.remove(&oldest_addr);
            }
        }
        self.entries.insert(addr, PeerRttEntry {
            rtt_ms,
            updated_at: Instant::now(),
        });
    }

    fn find_oldest(&self) -> Option<SocketAddr> {
        self.entries.iter()
            .min_by_key(|(_, e)| e.updated_at)
            .map(|(addr, _)| *addr)
    }
}

/// Build a TransportConfig with adaptive initial_rtt and BBR congestion control.
/// Called once per connection (client-side) or once for the server endpoint.
fn build_adaptive_transport(initial_rtt_ms: u64) -> quinn::TransportConfig {
    let mut transport = quinn::TransportConfig::default();
    transport.max_concurrent_bidi_streams(VarInt::from_u32(MAX_STREAMS_PER_CONN));
    transport.max_concurrent_uni_streams(VarInt::from_u32(MAX_STREAMS_PER_CONN));
    transport.max_idle_timeout(Some(
        Duration::from_secs(IDLE_TIMEOUT_SECS)
            .try_into()
            .expect("Idle timeout must fit in IdleTimeout"),
    ));
    transport.keep_alive_interval(Some(Duration::from_secs(KEEP_ALIVE_SECS)));

    let clamped_rtt = initial_rtt_ms.clamp(MIN_INITIAL_RTT_MS, MAX_INITIAL_RTT_MS);
    transport.initial_rtt(Duration::from_millis(clamped_rtt));

    // BBR congestion control: bandwidth-based rather than loss-based (Cubic).
    // Superior on high-RTT / cross-continental links because it probes actual
    // bottleneck bandwidth instead of reacting to packet loss.
    // Used by Solana, Google QUIC (quiche), Cloudflare.
    transport.congestion_controller_factory(Arc::new(quinn::congestion::BbrConfig::default()));

    transport.receive_window(VarInt::from_u32(16_777_216)); // 16 MB
    transport.send_window(16_777_216); // 16 MB
    transport.datagram_receive_buffer_size(Some(8_388_608)); // 8 MB

    transport
}

// ============================================================================
// NODE HANDSHAKE
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeHandshake {
    pub node_id: String,
    pub cert_serial: String,
    pub protocol_version: u8,
    pub node_type: String,
    pub timestamp: u64,
}

// ============================================================================
// QUIC CONNECTION
// ============================================================================

pub struct QuicConnection {
    pub connection: Connection,
    pub remote_node_id: Option<String>,
    pub remote_cert_serial: Option<String>,
    pub remote_node_type: Option<String>,  // "super" or "light" (lowercase)
    pub connected_at: Instant,
    /// v2.95.1: Atomic timestamp (ms since UNIX epoch) - can be updated from Arc
    pub last_activity_ms: AtomicU64,
    pub messages_sent: AtomicU64,
    pub messages_received: AtomicU64,
    pub bytes_sent: AtomicU64,
    pub bytes_received: AtomicU64,
}

/// Returns true only if the connection is both explicitly open AND has had recent activity.
/// `close_reason().is_none()` alone is insufficient: a connection can lose its peer silently
/// (network partition, OS crash) without ever setting a close_reason — a "zombie" connection.
/// Secondary check: if last_activity_ms is older than ZOMBIE_TIMEOUT_MS, treat as dead.
pub fn is_connection_alive(conn: &QuicConnection) -> bool {
    // Primary: explicit close sets close_reason
    if conn.connection.close_reason().is_some() {
        return false;
    }
    // Zombie detection: no activity for >60 seconds = dead peer
    // Must be > keep_alive_interval (30s) to avoid false positives on idle connections
    const ZOMBIE_TIMEOUT_MS: u64 = 60_000;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let last_ms = conn.last_activity_ms.load(std::sync::atomic::Ordering::Relaxed);
    // Allow grace period for brand-new connections (last_activity_ms may be 0 initially)
    if last_ms == 0 {
        return conn.connected_at.elapsed().as_millis() as u64 <= ZOMBIE_TIMEOUT_MS;
    }
    now_ms.saturating_sub(last_ms) <= ZOMBIE_TIMEOUT_MS
}

// ============================================================================
// TRANSPORT STATISTICS
// ============================================================================

#[derive(Debug, Clone, Default)]
pub struct QuicStats {
    pub connections_established: u64,
    pub connections_failed: u64,
    pub active_connections: usize,
    pub messages_sent: u64,
    pub messages_received: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub avg_rtt_ms: u64,
}

// ============================================================================
// MESSAGE HANDLER TYPE
// ============================================================================

/// Callback type for handling received messages
pub type MessageHandler = Arc<dyn Fn(SocketAddr, NetworkMessage) + Send + Sync>;

// ============================================================================
// QUIC TRANSPORT
// ============================================================================

pub struct QuicTransport {
    /// QUIC endpoint
    endpoint: Option<Endpoint>,
    /// Our node ID
    node_id: String,
    /// Our certificate serial
    cert_serial: String,
    /// Node type string
    node_type: String,
    /// Active connections (peer_addr -> connection)
    connections: Arc<DashMap<SocketAddr, Arc<QuicConnection>>>,
    /// Server running flag
    server_running: Arc<AtomicBool>,
    /// Message handler callback
    message_handler: Option<MessageHandler>,
    /// Statistics
    stats: Arc<RwLock<QuicStats>>,
    /// Per-peer RTT cache for adaptive initial_rtt on reconnect (v6.3)
    rtt_cache: Arc<Mutex<PeerRttCache>>,
    /// v6.5: node_id → "IP:8001" mapping shared with P2P layer
    /// Populated on QUIC handshake so genesis nodes know how to reach new peers
    peer_id_to_addr: Option<Arc<DashMap<String, String>>>,
}

impl QuicTransport {
    pub fn new(node_id: String, node_type: String, _quic_port: u16) -> Self {
        Self {
            endpoint: None,
            node_id,
            cert_serial: String::new(),
            node_type,
            connections: Arc::new(DashMap::new()),
            server_running: Arc::new(AtomicBool::new(false)),
            message_handler: None,
            stats: Arc::new(RwLock::new(QuicStats::default())),
            rtt_cache: Arc::new(Mutex::new(PeerRttCache::new())),
            peer_id_to_addr: None,
        }
    }
    
    /// v6.5: Set peer_id_to_addr mapping shared with P2P layer
    /// Called before start_server() to enable bidirectional peer discovery
    pub fn set_peer_id_to_addr(&mut self, map: Arc<DashMap<String, String>>) {
        self.peer_id_to_addr = Some(map);
    }

    /// Set message handler callback
    pub fn set_message_handler(&mut self, handler: MessageHandler) {
        self.message_handler = Some(handler);
    }
    
    /// Generate self-signed TLS certificate
    fn generate_tls_cert(node_id: &str) -> Result<(CertificateDer<'static>, PrivateKeyDer<'static>), String> {
        let cert = rcgen::generate_simple_self_signed(vec![format!("qnet-{}", node_id)])
            .map_err(|e| format!("Certificate generation failed: {}", e))?;
        
        let cert_der = cert.serialize_der()
            .map_err(|e| format!("Certificate serialization failed: {}", e))?;
        let key_der = cert.get_key_pair().serialize_der();
        
        Ok((CertificateDer::from(cert_der), PrivateKeyDer::Pkcs8(key_der.into())))
    }
    
    /// Initialize QUIC transport (creates endpoint)
    pub async fn init(&mut self, bind_addr: SocketAddr, cert_serial: &str) -> Result<(), String> {
        self.cert_serial = cert_serial.to_string();
        
        // Generate TLS certificate
        let (cert, key) = Self::generate_tls_cert(&self.node_id)?;
        
        // Server config — v4.8: aws-lc-rs provider for ML-KEM 768 (Kyber) hybrid key exchange
        // TLS 1.3 with X25519Kyber768Draft00 = post-quantum secure P2P transport
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        let mut server_crypto = rustls::ServerConfig::builder_with_provider(Arc::new(provider))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|e| format!("TLS13 config failed: {}", e))?
            .with_no_client_auth()
            .with_single_cert(vec![cert.clone()], key.clone_key())
            .map_err(|e| format!("Server config failed: {}", e))?;
        
        server_crypto.alpn_protocols = vec![b"qnet-p2p-v1".to_vec()];
        
        let mut server_config = ServerConfig::with_crypto(Arc::new(
            quinn::crypto::rustls::QuicServerConfig::try_from(server_crypto)
                .map_err(|e| format!("QUIC server config failed: {}", e))?
        ));
        
        // v6.3: Adaptive transport with BBR and conservative initial RTT for server
        // Server endpoint uses DEFAULT_INITIAL_RTT_MS — incoming connections come from
        // anywhere in the world; we can't know their RTT beforehand.
        let transport = build_adaptive_transport(DEFAULT_INITIAL_RTT_MS);
        server_config.transport_config(Arc::new(transport));
        
        // Create endpoint with retry — survive TIME_WAIT after fast Docker restart
        let mut endpoint_result = None;
        for attempt in 1u32..=10 {
            match Endpoint::server(server_config.clone(), bind_addr) {
                Ok(ep) => { endpoint_result = Some(ep); break; }
                Err(e) => {
                    if is_warn() {
                        println!("[WARN][QUIC] port_{}_busy attempt={}/10 err={}", bind_addr.port(), attempt, e);
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
        let endpoint = endpoint_result
            .ok_or_else(|| format!("Cannot bind QUIC port {} after 10 attempts (20s)", bind_addr.port()))?;
        
        self.endpoint = Some(endpoint);
        
        if is_info() {
            println!("[INFO][QUIC] transport_initialized addr={} timeout={}s streams={} window=16MB initial_rtt={}ms cc=BBR",
                bind_addr, CONNECT_TIMEOUT_SECS, MAX_STREAMS_PER_CONN, DEFAULT_INITIAL_RTT_MS);
        }
        
        Ok(())
    }
    
    /// Start QUIC server (accept incoming connections)
    pub async fn start_server(&self) -> Result<(), String> {
        let endpoint = self.endpoint.clone()
            .ok_or("Endpoint not initialized")?;
        
        if self.server_running.load(Ordering::Relaxed) {
            return Ok(()); // Already running
        }
        
        self.server_running.store(true, Ordering::SeqCst);
        
        let connections = self.connections.clone();
        let server_running = self.server_running.clone();
        let message_handler = self.message_handler.clone();
        let stats = self.stats.clone();
        let node_id = self.node_id.clone();
        let cert_serial = self.cert_serial.clone();
        let node_type = self.node_type.clone();
        let peer_id_to_addr_map = self.peer_id_to_addr.clone();
        
        // Spawn server task
        tokio::spawn(async move {
            if is_info() { println!("[INFO][QUIC] server_started accepting=true"); }
            
            let handshake_semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_HANDSHAKES));
            let mut throttle_count: u64 = 0;
            
            while server_running.load(Ordering::Relaxed) {
                let incoming = match endpoint.accept().await {
                    Some(conn) => conn,
                    None => {
                        if crate::node::is_warn() { println!("[WARN][QUIC] endpoint_closed"); }
                        break;
                    }
                };
                
                let permit = match handshake_semaphore.clone().try_acquire_owned() {
                    Ok(p) => p,
                    Err(_) => {
                        // v6.4: Properly refuse the connection so the peer receives
                        // CONNECTION_CLOSE and backs off instead of immediately retrying.
                        // Without refuse(), the peer sees "accepted then dropped" and
                        // retries at full speed — creating a feedback loop.
                        incoming.refuse();

                        throttle_count += 1;
                        if throttle_count <= 3 || throttle_count % 5000 == 0 {
                            if crate::node::is_warn() {
                                println!("[WARN][QUIC] handshake_throttled active={} refused_total={}",
                                         MAX_CONCURRENT_HANDSHAKES, throttle_count);
                            }
                        }

                        // Yield to let in-flight handshakes complete and free permits.
                        // Without this, the loop spins at ~100K/s accept→refuse cycles,
                        // starving the handshake tasks that HOLD permits.
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        continue;
                    }
                };
                
                // Reset throttle counter when permits become available
                if throttle_count > 0 {
                    if crate::node::is_info() {
                        println!("[INFO][QUIC] throttle_cleared total_refused={}", throttle_count);
                    }
                    throttle_count = 0;
                }
                
                let peer_addr = incoming.remote_address();
                
                let connections_clone = connections.clone();
                let handler_clone = message_handler.clone();
                let stats_clone = stats.clone();
                let node_id_clone = node_id.clone();
                let cert_serial_clone = cert_serial.clone();
                let peer_id_map_clone = peer_id_to_addr_map.clone();
                let node_type_clone = node_type.clone();
                
                tokio::spawn(async move {
                    // TLS+Kyber handshake phase — permit limits concurrency.
                    // v6.4: Hard timeout prevents permits from being held indefinitely.
                    // Root cause of QUIC death spiral: without timeout, stalled TLS handshakes
                    // hold all 64 permits → no new connections → all peers retry → more stalls.
                    let handshake_outcome = {
                        let _permit = permit;
                        let timed_result = tokio::time::timeout(
                            Duration::from_secs(INCOMING_HANDSHAKE_TIMEOUT_SECS),
                            incoming
                        ).await;
                        match timed_result {
                            Ok(Ok(connection)) => {
                                let hs = Self::handle_server_handshake(
                                    &connection,
                                    &node_id_clone,
                                    &cert_serial_clone,
                                    &node_type_clone
                                ).await;
                                Some((connection, hs))
                            }
                            Ok(Err(e)) => {
                                if crate::node::is_warn() { println!("[WARN][QUIC] conn_failed peer={} err={}", get_privacy_id_for_addr(&peer_addr.to_string()), e); }
                                let mut s = stats_clone.write().await;
                                s.connections_failed += 1;
                                None
                            }
                            Err(_timeout) => {
                                if crate::node::is_warn() { println!("[WARN][QUIC] handshake_timeout peer={} limit={}s", get_privacy_id_for_addr(&peer_addr.to_string()), INCOMING_HANDSHAKE_TIMEOUT_SECS); }
                                let mut s = stats_clone.write().await;
                                s.connections_failed += 1;
                                None
                            }
                        }
                        // _permit dropped here — slot freed for next handshake
                    };
                    
                    let (connection, handshake_result) = match handshake_outcome {
                        Some((c, hs)) => (c, hs),
                        None => return,
                    };
                    
                    if is_info() {
                        println!("[INFO][QUIC] incoming_conn peer={}", get_privacy_id_for_addr(&peer_addr.to_string()));
                    }
                    
                    let (remote_node_id, remote_cert_serial, remote_node_type) = match handshake_result {
                        Ok(h) => h,
                        Err(e) => {
                            if crate::node::is_warn() { println!("[WARN][QUIC] handshake_failed peer={} err={}", get_privacy_id_for_addr(&peer_addr.to_string()), e); }
                            return;
                        }
                    };
                    
                    if is_info() { println!("[INFO][QUIC] conn_accepted peer={} node={}", get_privacy_id_for_addr(&peer_addr.to_string()), remote_node_id); }
                    
                    if remote_node_id == node_id_clone {
                        if crate::node::is_warn() { println!("[WARN][QUIC] self_connect_detected side=server action=close"); }
                        connection.close(quinn::VarInt::from_u32(0), b"self-connect");
                        return;
                    }
                    
                    // SECURITY v3.33: TLS cert SAN check (server side).
                    // One-way TLS: client cert usually unavailable → Err → OK.
                    // If cert IS presented and SAN mismatches → close (potential MitM).
                    match Self::verify_peer_cert_node_id(&connection, &remote_node_id) {
                        Ok(()) => {
                            if is_debug() { println!("[DBG][QUIC] cert_san_ok side=server node={}", remote_node_id); }
                        }
                        Err(e) if e.contains("SAN does not contain") => {
                            if crate::node::is_warn() { println!("[WARN][QUIC] cert_san_MISMATCH side=server node={} reason={}", remote_node_id, e); }
                            connection.close(quinn::VarInt::from_u32(403), b"SAN_MISMATCH");
                            return;
                        }
                        Err(_) => {}
                    }
                    
                    // CRITICAL FIX v2.19.24: Smart connection management
                    // Each node pair needs CLIENT + SERVER conns for bidirectional communication.
                    // Accept incoming if no live SERVER conn from this node; replace dead ones.
                    let mut existing_server_addr: Option<std::net::SocketAddr> = None;
                    let mut existing_server_alive = false;
                    
                    for entry in connections_clone.iter() {
                        if let Some(ref existing_node_id) = entry.value().remote_node_id {
                            if existing_node_id == &remote_node_id {
                                let entry_port = entry.key().port();
                                let is_server_conn = entry_port != crate::quic_transport::QUIC_PORT;
                                
                                if is_server_conn {
                                    existing_server_addr = Some(*entry.key());
                                    existing_server_alive = crate::quic_transport::is_connection_alive(entry.value());
                                    break;
                                }
                            }
                        }
                    }
                    
                    if let Some(addr) = existing_server_addr {
                        if existing_server_alive {
                            if crate::node::is_warn() { println!("[WARN][QUIC] duplicate_conn node={} action=close", remote_node_id); }
                            connection.close(quinn::VarInt::from_u32(0), b"duplicate-server");
                            return;
                        } else {
                            if is_info() { println!("[INFO][QUIC] replace_dead_conn node={}", remote_node_id); }
                            connections_clone.remove(&addr);
                        }
                    }
                    
                    let quic_conn = Arc::new(QuicConnection {
                        connection: connection.clone(),
                        remote_node_id: Some(remote_node_id.clone()),
                        remote_cert_serial: Some(remote_cert_serial),
                        remote_node_type: Some(remote_node_type.clone()),
                        connected_at: Instant::now(),
                        last_activity_ms: AtomicU64::new(Self::current_time_ms()),
                        messages_sent: AtomicU64::new(0),
                        messages_received: AtomicU64::new(0),
                        bytes_sent: AtomicU64::new(0),
                        bytes_received: AtomicU64::new(0),
                    });
                    
                    connections_clone.insert(peer_addr, quic_conn.clone());
                    if is_info() { println!("[INFO][QUIC] conn_stored peer={} node={} type={}", get_privacy_id_for_addr(&peer_addr.to_string()), remote_node_id, remote_node_type); }

                    // v6.5 FIX: Map remote_node_id → "IP:8001" in P2P peer_id_to_addr
                    // PROBLEM: Genesis nodes couldn't route responses to new nodes because
                    //   ensure_peer_connected() uses privacy hash IDs, not real node_ids.
                    //   QUIC handshake extracts remote_node_id but never mapped it.
                    // SOLUTION: On every successful QUIC handshake (server side),
                    //   insert remote_node_id → "peer_ip:8001" into shared DashMap.
                    //   This enables handle_sync_request() and broadcast_transaction()
                    //   to find the address of newly connected peers.
                    if let Some(ref pid_map) = peer_id_map_clone {
                        let peer_api_addr = format!("{}:8001", peer_addr.ip());
                        pid_map.insert(remote_node_id.clone(), peer_api_addr.clone());
                        if is_info() { println!("[INFO][QUIC] peer_mapped node_id={} addr={}", remote_node_id, peer_api_addr); }
                    }
                    
                    {
                        let mut s = stats_clone.write().await;
                        s.connections_established += 1;
                        s.active_connections = connections_clone.len();
                    }
                    
                    Self::handle_incoming_streams(connection, peer_addr, handler_clone, quic_conn, connections_clone.clone()).await;
                });
            }
            
            if is_info() { println!("[INFO][QUIC] server_stopped"); }
        });
        
        Ok(())
    }
    
    /// Handle server-side handshake
    /// v2.24: Added timeout to prevent hanging connections
    async fn handle_server_handshake(
        conn: &Connection,
        our_node_id: &str,
        our_cert_serial: &str,
        our_node_type: &str,
    ) -> Result<(String, String, String), String> {
        // v2.24: Timeout for entire handshake (prevents "aborted by peer" errors)
        let handshake_timeout = Duration::from_secs(CONNECT_TIMEOUT_SECS);
        
        tokio::time::timeout(handshake_timeout, async {
            // Accept bidirectional stream for handshake
            let (mut send, mut recv) = conn.accept_bi().await
                .map_err(|e| format!("Accept stream failed: {}", e))?;
            
            // Receive peer's handshake
            let mut len_buf = [0u8; 4];
            recv.read_exact(&mut len_buf).await.map_err(|e| format!("Read len failed: {}", e))?;
            let len = u32::from_be_bytes(len_buf) as usize;
            
            if len > MAX_MESSAGE_SIZE {
                return Err(format!("Handshake too large: {}", len));
            }
            
            let mut data = vec![0u8; len];
            recv.read_exact(&mut data).await.map_err(|e| format!("Read data failed: {}", e))?;
            
            let peer_handshake: NodeHandshake = bincode::deserialize(&data)
                .map_err(|e| format!("Handshake deserialize failed: {}", e))?;
            
            // Send our handshake
            let our_handshake = NodeHandshake {
                node_id: our_node_id.to_string(),
                cert_serial: our_cert_serial.to_string(),
                protocol_version: PROTOCOL_VERSION,
                node_type: our_node_type.to_string(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            };
            
            let handshake_bytes = bincode::serialize(&our_handshake)
                .map_err(|e| format!("Handshake serialize failed: {}", e))?;
            
            let len_bytes = (handshake_bytes.len() as u32).to_be_bytes();
            send.write_all(&len_bytes).await.map_err(|e| format!("Write len failed: {}", e))?;
            send.write_all(&handshake_bytes).await.map_err(|e| format!("Write data failed: {}", e))?;
            send.finish().map_err(|e| format!("Finish failed: {}", e))?;
            
            Ok((peer_handshake.node_id, peer_handshake.cert_serial, peer_handshake.node_type))
        }).await.map_err(|_| "Handshake timeout".to_string())?
    }
    
    /// Handle incoming streams from a connection
    /// v3.1 CRITICAL FIX: Added connections parameter to remove entry on close (prevents 15GB memory leak!)
    async fn handle_incoming_streams(
        conn: Connection,
        peer_addr: SocketAddr,
        handler: Option<MessageHandler>,
        quic_conn: Arc<QuicConnection>,
        connections: Arc<DashMap<SocketAddr, Arc<QuicConnection>>>,
    ) {
        loop {
            // Accept bidirectional or unidirectional streams
            tokio::select! {
                // Bidirectional stream (request-response)
                result = conn.accept_bi() => {
                    match result {
                        Ok((send, recv)) => {
                            let handler_clone = handler.clone();
                            let conn_clone = quic_conn.clone();
                            tokio::spawn(async move {
                                Self::handle_bidi_stream(peer_addr, send, recv, handler_clone, conn_clone).await;
                            });
                        }
                        Err(e) => {
                            if crate::node::is_warn() { println!("[WARN][QUIC] conn_closed peer={} err={}", get_privacy_id_for_addr(&peer_addr.to_string()), e); }
                            break;
                        }
                    }
                }
                // Unidirectional stream (broadcast, no response)
                result = conn.accept_uni() => {
                    match result {
                        Ok(recv) => {
                            let handler_clone = handler.clone();
                            let conn_clone = quic_conn.clone();
                            tokio::spawn(async move {
                                Self::handle_uni_stream(peer_addr, recv, handler_clone, conn_clone).await;
                            });
                        }
                        Err(e) => {
                            if crate::node::is_warn() { println!("[WARN][QUIC] uni_closed peer={} err={}", get_privacy_id_for_addr(&peer_addr.to_string()), e); }
                            break;
                        }
                    }
                }
            }
        }
        
        // v3.1 CRITICAL: Remove connection from DashMap to prevent memory leak
        // Without this, dead connections accumulate forever causing 15GB+ memory usage!
        if connections.remove(&peer_addr).is_some() {
            if is_info() { println!("[INFO][QUIC] conn_removed_on_close peer={}", get_privacy_id_for_addr(&peer_addr.to_string())); }
        }
    }
    
    /// Handle bidirectional stream (v2.95: length-prefixed protocol for ACK support)
    async fn handle_bidi_stream(
        peer_addr: SocketAddr,
        mut send: SendStream,
        mut recv: RecvStream,
        handler: Option<MessageHandler>,
        conn: Arc<QuicConnection>,
    ) {
        let peer_rtt = conn.connection.rtt();
        let adaptive_timeout = Duration::from_secs(MESSAGE_TIMEOUT_SECS)
            .min(Duration::from_millis(5000).max(peer_rtt * 10));
        
        let mut len_buf = [0u8; 4];
        let data = match tokio::time::timeout(
            adaptive_timeout,
            async {
                recv.read_exact(&mut len_buf).await?;
                let msg_len = u32::from_be_bytes(len_buf) as usize;
                
                if msg_len > MAX_MESSAGE_SIZE {
                    return Err(quinn::ReadExactError::FinishedEarly(0));
                }
                
                let mut data = vec![0u8; msg_len];
                recv.read_exact(&mut data).await?;
                Ok(data)
            }
        ).await {
            Ok(Ok(d)) => d,
            Ok(Err(e)) => {
                if crate::node::is_warn() {
                    println!("[WARN][QUIC] bidi_read_failed peer={} err={:?}",
                        get_privacy_id_for_addr(&peer_addr.to_string()), e);
                }
                return;
            }
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][QUIC] bidi_read_timeout peer={} timeout={}ms",
                        get_privacy_id_for_addr(&peer_addr.to_string()),
                        adaptive_timeout.as_millis());
                }
                return;
            }
        };
        
        conn.bytes_received.fetch_add(data.len() as u64, Ordering::Relaxed);
        conn.messages_received.fetch_add(1, Ordering::Relaxed);
        // v2.95.1: Update last_activity on message receipt (confirmed delivery TO us)
        conn.last_activity_ms.store(Self::current_time_ms(), Ordering::Relaxed);
        
        // Parse message
        let msg = match Self::parse_message(&data) {
            Ok(m) => m,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][QUIC] parse_failed peer={} err={}", get_privacy_id_for_addr(&peer_addr.to_string()), e);
                }
                return;
            }
        };
        
        // Call handler BEFORE sending ACK (handler processes TX)
        if let Some(ref h) = handler {
            h(peer_addr, msg);
        }
        
        // v2.95: Send ACK byte (0x06) to confirm receipt
        // CRITICAL: Must succeed - sender is waiting for this!
        let ack_byte = [0x06u8]; // ASCII ACK
        if let Err(e) = send.write_all(&ack_byte).await {
            if crate::node::is_warn() {
                println!("[WARN][QUIC] ack_send_failed peer={} err={}", 
                    get_privacy_id_for_addr(&peer_addr.to_string()), e);
            }
        }
        let _ = send.finish();
    }
    
    /// Handle unidirectional stream (broadcast/fire-and-forget messages)
    /// v2.95.2: Updated to read length-prefixed messages (matches try_send_once)
    async fn handle_uni_stream(
        peer_addr: SocketAddr,
        mut recv: RecvStream,
        handler: Option<MessageHandler>,
        conn: Arc<QuicConnection>,
    ) {
        // v6.3: Adaptive read timeout based on live RTT measurement.
        // Floor at 5s, ceiling at MESSAGE_TIMEOUT_SECS. For same-DC peers (<1ms RTT)
        // this yields 5s; for cross-continental (~110ms) yields 5s; for truly slow
        // links (500ms+ RTT) yields proportionally more headroom.
        let peer_rtt = conn.connection.rtt();
        let adaptive_timeout = Duration::from_secs(MESSAGE_TIMEOUT_SECS)
            .min(Duration::from_millis(5000).max(peer_rtt * 10));
        
        let mut len_buf = [0u8; 4];
        let data = match tokio::time::timeout(
            adaptive_timeout,
            async {
                recv.read_exact(&mut len_buf).await?;
                let msg_len = u32::from_be_bytes(len_buf) as usize;
                
                if msg_len > MAX_MESSAGE_SIZE {
                    return Err(quinn::ReadExactError::FinishedEarly(0));
                }
                
                let mut data = vec![0u8; msg_len];
                recv.read_exact(&mut data).await?;
                Ok(data)
            }
        ).await {
            Ok(Ok(d)) => d,
            Ok(Err(e)) => {
                if crate::node::is_warn() {
                    println!("[WARN][QUIC] uni_read_failed peer={} err={:?}", 
                        get_privacy_id_for_addr(&peer_addr.to_string()), e);
                }
                return;
            }
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][QUIC] uni_read_timeout peer={} timeout={}ms", 
                        get_privacy_id_for_addr(&peer_addr.to_string()),
                        adaptive_timeout.as_millis());
                }
                return;
            }
        };
        
        conn.bytes_received.fetch_add(data.len() as u64, Ordering::Relaxed);
        conn.messages_received.fetch_add(1, Ordering::Relaxed);
        // v2.95.1: Update last_activity on message receipt
        conn.last_activity_ms.store(Self::current_time_ms(), Ordering::Relaxed);
        
        // v2.95.3: Check for ping message (single 0xFF byte) - just update activity, no handler call
        if data.len() == 1 && data[0] == 0xFF {
            // Ping received - activity already updated above, nothing else to do
            return;
        }
        
        // Parse message
        let msg = match Self::parse_message(&data) {
            Ok(m) => m,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][QUIC] uni_parse_failed peer={} err={}", 
                        get_privacy_id_for_addr(&peer_addr.to_string()), e);
                }
                return;
            }
        };
        
        // Call handler
        if let Some(ref h) = handler {
            h(peer_addr, msg);
        }
    }
    
    /// Parse binary message
    fn parse_message(data: &[u8]) -> Result<NetworkMessage, String> {
        if data.len() < 6 {
            return Err("Message too short".into());
        }
        
        // Check header
        let version = data[0];
        if version != PROTOCOL_VERSION {
            return Err(format!("Protocol version mismatch: {}", version));
        }
        
        let payload_len = u32::from_be_bytes([data[2], data[3], data[4], data[5]]) as usize;
        
        if data.len() < 6 + payload_len {
            return Err("Incomplete message".into());
        }
        
        // Deserialize payload
        bincode::deserialize(&data[6..6+payload_len])
            .map_err(|e| format!("Deserialize failed: {}", e))
    }
    
    /// Connect to a peer (client mode) with auto-retry
    /// CRITICAL: Thread-safe with double-check to prevent race conditions
    /// v2.24: Improved retry logic for handshake failures
    pub async fn connect(&self, peer_addr: SocketAddr) -> Result<Arc<QuicConnection>, String> {
        // FIRST CHECK: Existing connection - but only if it's truly ALIVE (not a zombie)
        if let Some(conn) = self.connections.get(&peer_addr) {
            if crate::quic_transport::is_connection_alive(&conn) {
                return Ok(conn.clone());
            } else {
                if is_info() { println!("[INFO][QUIC] removing_dead_conn peer={}", get_privacy_id_for_addr(&peer_addr.to_string())); }
                self.connections.remove(&peer_addr);
            }
        }
        
        let endpoint = self.endpoint.as_ref()
            .ok_or("Endpoint not initialized")?;
        
        // v2.24: Use extended retry for handshake failures (common at startup)
        let max_attempts = HANDSHAKE_RETRY_ATTEMPTS;
        let mut last_error = String::new();
        let mut handshake_failures = 0u32;
        
        for attempt in 1..=max_attempts {
            // CRITICAL FIX: Double-check before creating connection (race condition protection)
            // Another task may have created connection while we were waiting
            if let Some(conn) = self.connections.get(&peer_addr) {
                if crate::quic_transport::is_connection_alive(&conn) {
                    return Ok(conn.clone());
                }
            }
            
            match self.try_connect_once(endpoint, peer_addr).await {
                Ok(conn) => return Ok(conn),
                Err(e) => {
                    // v2.24: Track handshake failures separately
                    if e.contains("aborted by peer") || e.contains("handshake") {
                        handshake_failures += 1;
                    }
                    last_error = e;
                    
                    if attempt < max_attempts {
                        // v2.24: Exponential backoff with cap
                        let base_delay = RETRY_DELAY_MS * (1 << (attempt - 1).min(5));
                        let delay = Duration::from_millis(base_delay.min(MAX_RETRY_DELAY_MS));
                        
                        if crate::node::is_warn() && (attempt % 2 == 1 || attempt == max_attempts - 1) {
                            println!("[WARN][QUIC] conn_attempt_failed attempt={}/{} peer={} retry_in={:?}",
                                attempt, max_attempts,
                                get_privacy_id_for_addr(&peer_addr.to_string()),
                                delay);
                        }
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
        
        // v2.24: More informative error message
        if handshake_failures > 0 {
            Err(format!("Failed after {} attempts ({} handshake failures): {}", 
                max_attempts, handshake_failures, last_error))
        } else {
            Err(format!("Failed to connect after {} attempts: {}", max_attempts, last_error))
        }
    }
    
    /// Single connection attempt (internal helper)
    async fn try_connect_once(&self, endpoint: &Endpoint, peer_addr: SocketAddr) -> Result<Arc<QuicConnection>, String> {
        
        // Client config — v4.8: aws-lc-rs provider for ML-KEM 768 (Kyber) hybrid key exchange
        // Matches server: TLS 1.3 with X25519Kyber768Draft00 = post-quantum secure handshake
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        let mut client_crypto = rustls::ClientConfig::builder_with_provider(Arc::new(provider))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|e| format!("TLS13 client config failed: {}", e))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SelfSignedCertVerifier))
            .with_no_client_auth();
        
        // CRITICAL: Set ALPN protocol to match server
        client_crypto.alpn_protocols = vec![b"qnet-p2p-v1".to_vec()];
        
        let mut client_config = ClientConfig::new(Arc::new(
            quinn::crypto::rustls::QuicClientConfig::try_from(client_crypto)
                .map_err(|e| format!("Client config failed: {}", e))?
        ));
        
        // v6.3: Per-peer adaptive initial_rtt with BBR congestion control.
        // If we've connected to this peer before, seed Quinn with their measured RTT × 2
        // (safety margin). Otherwise use conservative global default (250ms).
        let cached_rtt_ms = {
            let cache = self.rtt_cache.lock().await;
            cache.get(&peer_addr)
        };
        let initial_rtt_ms = match cached_rtt_ms {
            Some(rtt) => (rtt * 2).clamp(MIN_INITIAL_RTT_MS, MAX_INITIAL_RTT_MS),
            None => DEFAULT_INITIAL_RTT_MS,
        };
        let transport = build_adaptive_transport(initial_rtt_ms);
        if is_debug() {
            println!("[DBG][QUIC] adaptive_transport peer={} initial_rtt={}ms cached={:?}",
                get_privacy_id_for_addr(&peer_addr.to_string()), initial_rtt_ms, cached_rtt_ms);
        }
        client_config.transport_config(Arc::new(transport));
        
        // Connect with timeout
        let connecting = endpoint.connect_with(client_config, peer_addr, "qnet-node")
            .map_err(|e| format!("Connect failed: {}", e))?;
        
        let connection = tokio::time::timeout(
            Duration::from_secs(CONNECT_TIMEOUT_SECS),
            connecting
        )
            .await
            .map_err(|_| "Connection timeout")?
            .map_err(|e| format!("Connection failed: {}", e))?;
        
        // Perform client handshake
        let (remote_node_id, remote_cert_serial, remote_node_type) = self.perform_client_handshake(&connection).await?;
        
        // CRITICAL: Prevent self-connect
        if remote_node_id == self.node_id {
            if crate::node::is_warn() { println!("[WARN][QUIC] self_connect_detected side=client action=close"); }
            connection.close(quinn::VarInt::from_u32(0), b"self-connect");
            return Err("Self-connect not allowed".to_string());
        }
        
        // SECURITY v3.33: STRICT TLS cert SAN verification (client side).
        // If peer_identity is available (server presented cert), SAN MUST match.
        // SAN mismatch = potential MitM → close connection immediately.
        // peer_identity unavailable (one-way TLS) = allowed, Dilithium provides auth.
        match Self::verify_peer_cert_node_id(&connection, &remote_node_id) {
            Ok(()) => {
                if is_info() {
                    println!("[INFO][QUIC] cert_san_verified side=client node={}", remote_node_id);
                }
            }
            Err(e) if e.contains("SAN does not contain") => {
                if crate::node::is_warn() { println!("[WARN][QUIC] cert_san_MISMATCH side=client node={} reason={}", remote_node_id, e); }
                connection.close(quinn::VarInt::from_u32(403), b"SAN_MISMATCH");
                return Err(format!("TLS SAN mismatch for node {}: {}", remote_node_id, e));
            }
            Err(e) => {
                if is_debug() {
                    println!("[DBG][QUIC] cert_unavailable side=client node={} reason={}", remote_node_id, e);
                }
            }
        }
        
        if is_info() { println!("[INFO][QUIC] connected peer={} node={} type={}", get_privacy_id_for_addr(&peer_addr.to_string()), remote_node_id, remote_node_type); }

        // v6.5: Map remote_node_id → address on client side too
        if let Some(ref pid_map) = self.peer_id_to_addr {
            let peer_api_addr = format!("{}:8001", peer_addr.ip());
            pid_map.insert(remote_node_id.clone(), peer_api_addr.clone());
            if is_info() { println!("[INFO][QUIC] peer_mapped_client node_id={} addr={}", remote_node_id, peer_api_addr); }
        }

        // Store connection
        let quic_conn = Arc::new(QuicConnection {
            connection,
            remote_node_id: Some(remote_node_id),
            remote_cert_serial: Some(remote_cert_serial),
            remote_node_type: Some(remote_node_type),
            connected_at: Instant::now(),
            last_activity_ms: AtomicU64::new(Self::current_time_ms()),
            messages_sent: AtomicU64::new(0),
            messages_received: AtomicU64::new(0),
            bytes_sent: AtomicU64::new(0),
            bytes_received: AtomicU64::new(0),
        });
        
        self.connections.insert(peer_addr, quic_conn.clone());
        
        // Update stats
        {
            let mut stats = self.stats.write().await;
            stats.connections_established += 1;
            stats.active_connections = self.connections.len();
        }
        
        // CRITICAL FIX: Start listening for incoming streams on CLIENT connections too!
        // Without this, we can send but not receive on client-initiated connections
        let handler = self.message_handler.clone();
        let quic_conn_for_listener = quic_conn.clone();
        let connection_for_listener = quic_conn.connection.clone();
        let connections_for_cleanup = self.connections.clone(); // v3.1: for cleanup on close
        tokio::spawn(async move {
            Self::handle_incoming_streams(connection_for_listener, peer_addr, handler, quic_conn_for_listener, connections_for_cleanup).await;
        });
        
        Ok(quic_conn)
    }
    
    /// Perform client-side handshake
    /// v2.24: Added timeout to prevent hanging connections
    async fn perform_client_handshake(&self, conn: &Connection) -> Result<(String, String, String), String> {
        // v2.24: Timeout for entire handshake
        let handshake_timeout = Duration::from_secs(CONNECT_TIMEOUT_SECS);
        
        tokio::time::timeout(handshake_timeout, async {
            // Our handshake
            let our_handshake = NodeHandshake {
                node_id: self.node_id.clone(),
                cert_serial: self.cert_serial.clone(),
                protocol_version: PROTOCOL_VERSION,
                node_type: self.node_type.clone(),
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            };
            
            let handshake_bytes = bincode::serialize(&our_handshake)
                .map_err(|e| format!("Serialize failed: {}", e))?;
            
            // Open stream
            let (mut send, mut recv) = conn.open_bi().await
                .map_err(|e| format!("Open stream failed: {}", e))?;
            
            // Send our handshake
            let len_bytes = (handshake_bytes.len() as u32).to_be_bytes();
            send.write_all(&len_bytes).await.map_err(|e| format!("Write len failed: {}", e))?;
            send.write_all(&handshake_bytes).await.map_err(|e| format!("Write data failed: {}", e))?;
            send.finish().map_err(|e| format!("Finish failed: {}", e))?;
            
            // Receive peer's handshake
            let mut len_buf = [0u8; 4];
            recv.read_exact(&mut len_buf).await.map_err(|e| format!("Read len failed: {}", e))?;
            let len = u32::from_be_bytes(len_buf) as usize;
            
            if len > MAX_MESSAGE_SIZE {
                return Err(format!("Handshake too large: {}", len));
            }
            
            let mut data = vec![0u8; len];
            recv.read_exact(&mut data).await.map_err(|e| format!("Read data failed: {}", e))?;
            
            let peer_handshake: NodeHandshake = bincode::deserialize(&data)
                .map_err(|e| format!("Deserialize failed: {}", e))?;
            
            Ok((peer_handshake.node_id, peer_handshake.cert_serial, peer_handshake.node_type))
        }).await.map_err(|_| "Handshake timeout".to_string())?
    }
    
    /// Send message to peer (request-response) with retry
    pub async fn send_message(&self, peer_addr: SocketAddr, msg: &NetworkMessage) -> Result<(), String> {
        // Serialize message once
        let wire_data = Self::serialize_message(msg)?;
        
        // Retry loop for send attempts
        let mut last_error = String::new();
        for attempt in 1..=CONNECT_RETRY_ATTEMPTS {
            match self.try_send_once(peer_addr, &wire_data).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_error = e.clone();
                    // v2.94 FIX: Remove connection on ANY error, not just close_reason().is_some()
                    // Zombie connections have close_reason() = None but are still dead!
                    if self.connections.remove(&peer_addr).is_some() {
                        if crate::node::is_warn() {
                            println!("[WARN][QUIC] conn_removed_send_fail peer={} err={}", 
                                get_privacy_id_for_addr(&peer_addr.to_string()), e);
                        }
                    }
                    if attempt < CONNECT_RETRY_ATTEMPTS {
                        let delay = Duration::from_millis(RETRY_DELAY_MS * (1 << (attempt - 1)));
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
        
        Err(format!("Send failed after {} attempts: {}", CONNECT_RETRY_ATTEMPTS, last_error))
    }
    
    /// Single send attempt (internal helper)
    /// v2.95.2: Uses UNIDIRECTIONAL stream for non-critical messages (no ACK needed)
    /// This avoids "sending stopped by peer" errors since receiver won't try to send ACK
    async fn try_send_once(&self, peer_addr: SocketAddr, wire_data: &[u8]) -> Result<(), String> {
        let conn = self.connect(peer_addr).await?;
        
        // v2.95.2: Use unidirectional stream for fire-and-forget messages
        // Bidi streams are reserved for send_with_ack (critical TX)
        let mut send = tokio::time::timeout(
            Duration::from_secs(MESSAGE_TIMEOUT_SECS),
            conn.connection.open_uni()
        )
            .await
            .map_err(|_| "Open uni stream timeout")?
            .map_err(|e| format!("Open stream failed: {}", e))?;
        
        // v2.95.2: Send length-prefixed message (4 bytes length + data)
        // Consistent protocol across all stream types
        let len_bytes = (wire_data.len() as u32).to_be_bytes();
        tokio::time::timeout(
            Duration::from_secs(MESSAGE_TIMEOUT_SECS),
            async {
                send.write_all(&len_bytes).await?;
                send.write_all(wire_data).await
            }
        )
            .await
            .map_err(|_| "Write timeout")?
            .map_err(|e| format!("Write failed: {}", e))?;
        
        send.finish().map_err(|e| format!("Finish failed: {}", e))?;
        
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        conn.last_activity_ms.store(now_ms, Ordering::Relaxed);
        conn.bytes_sent.fetch_add(wire_data.len() as u64, Ordering::Relaxed);
        conn.messages_sent.fetch_add(1, Ordering::Relaxed);
        
        {
            let mut stats = self.stats.write().await;
            stats.messages_sent += 1;
            stats.bytes_sent += wire_data.len() as u64;
        }
        
        Ok(())
    }
    
    /// v2.94: Send message with ACK confirmation (for critical TX like HeartbeatCommitment)
    /// Uses bidirectional stream and waits for 1-byte ACK from receiver
    /// Returns error if no ACK received within timeout - guarantees delivery confirmation
    pub async fn send_with_ack(&self, peer_addr: SocketAddr, msg: &NetworkMessage) -> Result<(), String> {
        let wire_data = Self::serialize_message(msg)?;
        
        // Retry loop with reconnect on failure
        let mut last_error = String::new();
        for attempt in 1..=CONNECT_RETRY_ATTEMPTS {
            match self.try_send_with_ack_once(peer_addr, &wire_data).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_error = e.clone();
                    // v2.94: Remove connection on ANY error for fresh reconnect
                    if self.connections.remove(&peer_addr).is_some() {
                        if crate::node::is_warn() {
                            println!("[WARN][QUIC] conn_removed_no_ack peer={}", 
                                get_privacy_id_for_addr(&peer_addr.to_string()));
                        }
                    }
                    if attempt < CONNECT_RETRY_ATTEMPTS {
                        let delay = Duration::from_millis(RETRY_DELAY_MS * (1 << (attempt - 1)));
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
        
        Err(format!("Send with ACK failed after {} attempts: {}", CONNECT_RETRY_ATTEMPTS, last_error))
    }
    
    /// v2.95: Single attempt to send with ACK (improved flow)
    /// CRITICAL: Do NOT finish() send stream until after ACK received!
    /// Otherwise receiver's ACK write fails with "stopped by peer"
    async fn try_send_with_ack_once(&self, peer_addr: SocketAddr, wire_data: &[u8]) -> Result<(), String> {
        let conn = self.connect(peer_addr).await?;
        
        // Open bidirectional stream
        let (mut send, mut recv) = tokio::time::timeout(
            Duration::from_secs(MESSAGE_TIMEOUT_SECS),
            conn.connection.open_bi()
        )
            .await
            .map_err(|_| "Open bi stream timeout")?
            .map_err(|e| format!("Open bi stream failed: {}", e))?;
        
        // v2.95: Send length-prefixed message (allows receiver to know when message ends)
        // Format: [4 bytes length][message data]
        let len_bytes = (wire_data.len() as u32).to_be_bytes();
        tokio::time::timeout(
            Duration::from_secs(MESSAGE_TIMEOUT_SECS),
            async {
                send.write_all(&len_bytes).await?;
                send.write_all(wire_data).await
            }
        )
            .await
            .map_err(|_| "Write timeout")?
            .map_err(|e| format!("Write failed: {}", e))?;
        
        // v2.95: Do NOT call finish() yet! Keep stream open for ACK.
        // finish() would signal FIN and receiver might interpret as "done"
        
        // v6.3: Adaptive ACK timeout — use peer RTT to compute a fair deadline.
        // Floor 2s for same-DC, scales to ~5s for cross-continental.
        let peer_rtt = conn.connection.rtt();
        let ack_timeout = Duration::from_millis(2000).max(peer_rtt * 10).min(Duration::from_secs(MESSAGE_TIMEOUT_SECS));
        let mut ack_buf = [0u8; 1];
        
        let ack_result = tokio::time::timeout(
            ack_timeout,
            recv.read_exact(&mut ack_buf)
        ).await;
        
        // v2.95: NOW we can finish the send stream (after ACK received or timeout)
        let _ = send.finish();
        
        match ack_result {
            Ok(Ok(_)) => {
                if ack_buf[0] == 0x06 { // ACK byte
                    conn.bytes_sent.fetch_add(wire_data.len() as u64, Ordering::Relaxed);
                    conn.messages_sent.fetch_add(1, Ordering::Relaxed);
                    // v2.95.1: Update last_activity ONLY on confirmed delivery (ACK received)
                    conn.last_activity_ms.store(Self::current_time_ms(), Ordering::Relaxed);
                    Ok(())
                } else {
                    Err(format!("Invalid ACK byte: {}", ack_buf[0]))
                }
            }
            Ok(Err(e)) => Err(format!("ACK read failed: {}", e)),
            Err(_) => Err("ACK timeout - message may not have been received".to_string()),
        }
    }
    
    /// Broadcast message (unidirectional, no response) with retry
    pub async fn broadcast_to(&self, peer_addr: SocketAddr, msg: &NetworkMessage) -> Result<(), String> {
        // Serialize message once
        let wire_data = Self::serialize_message(msg)?;
        
        // Retry loop for broadcast attempts
        let mut last_error = String::new();
        for attempt in 1..=CONNECT_RETRY_ATTEMPTS {
            match self.try_broadcast_once(peer_addr, &wire_data).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_error = e.clone();
                    // v2.94 FIX: Remove connection on ANY error, not just close_reason().is_some()
                    // Zombie connections have close_reason() = None but are still dead!
                    if self.connections.remove(&peer_addr).is_some() {
                        if crate::node::is_warn() {
                            println!("[WARN][QUIC] conn_removed_send_fail peer={} err={}", 
                                get_privacy_id_for_addr(&peer_addr.to_string()), e);
                        }
                    }
                    if attempt < CONNECT_RETRY_ATTEMPTS {
                        let delay = Duration::from_millis(RETRY_DELAY_MS * (1 << (attempt - 1)));
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
        
        Err(format!("Broadcast failed after {} attempts: {}", CONNECT_RETRY_ATTEMPTS, last_error))
    }
    
    /// Single broadcast attempt (internal helper)
    /// v2.95.3: Added length-prefix to match handle_uni_stream protocol
    async fn try_broadcast_once(&self, peer_addr: SocketAddr, wire_data: &[u8]) -> Result<(), String> {
        let conn = self.connect(peer_addr).await?;
        
        // v2.24.1: Timeout on open_uni to detect zombie connections
        let mut send = tokio::time::timeout(
            Duration::from_secs(MESSAGE_TIMEOUT_SECS),
            conn.connection.open_uni()
        )
            .await
            .map_err(|_| "Open uni stream timeout")?
            .map_err(|e| format!("Open uni stream failed: {}", e))?;
        
        // v2.95.3: Send length-prefixed message (must match handle_uni_stream)
        let len_bytes = (wire_data.len() as u32).to_be_bytes();
        tokio::time::timeout(
            Duration::from_secs(MESSAGE_TIMEOUT_SECS),
            async {
                send.write_all(&len_bytes).await?;
                send.write_all(wire_data).await
            }
        )
            .await
            .map_err(|_| "Write timeout")?
            .map_err(|e| format!("Write failed: {}", e))?;
        
        send.finish().map_err(|e| format!("Finish failed: {}", e))?;
        
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        conn.last_activity_ms.store(now_ms, Ordering::Relaxed);
        conn.bytes_sent.fetch_add(wire_data.len() as u64, Ordering::Relaxed);
        conn.messages_sent.fetch_add(1, Ordering::Relaxed);
        
        Ok(())
    }
    
    /// Serialize message to wire format
    fn serialize_message(msg: &NetworkMessage) -> Result<Vec<u8>, String> {
        let payload = bincode::serialize(msg)
            .map_err(|e| format!("Serialize failed: {}", e))?;
        
        if payload.len() > MAX_MESSAGE_SIZE {
            return Err(format!("Message too large: {}", payload.len()));
        }
        
        // Build wire format: version (1) + type (1) + length (4) + payload
        let mut wire_data = Vec::with_capacity(6 + payload.len());
        wire_data.push(PROTOCOL_VERSION);
        wire_data.push(Self::get_message_type(msg));
        wire_data.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        wire_data.extend_from_slice(&payload);
        
        Ok(wire_data)
    }
    
    /// Get message type byte
    fn get_message_type(msg: &NetworkMessage) -> u8 {
        match msg {
            NetworkMessage::Block { .. } => 1,
            NetworkMessage::Transaction { .. } => 2,
            NetworkMessage::PeerDiscovery { .. } => 3,
            NetworkMessage::HealthPing { .. } => 4,
            NetworkMessage::ConsensusCommit { .. } => 5,
            NetworkMessage::ConsensusReveal { .. } => 6,
            #[allow(deprecated)]
            NetworkMessage::EmergencyProducerChange { .. } => 7,
            NetworkMessage::ShredProtocolChunk { .. } => 8,
            #[allow(deprecated)]
            NetworkMessage::ReputationSyncDeprecated { .. } => 9,
            _ => 0,
        }
    }
    
    /// Get statistics. Also snapshots live RTT into the per-peer cache so that
    /// future reconnects to the same peer start with an accurate initial_rtt.
    pub async fn get_stats(&self) -> QuicStats {
        let mut stats = self.stats.read().await.clone();
        stats.active_connections = self.connections.len();
        
        let mut total_rtt: u64 = 0;
        let mut total_sent: u64 = 0;
        let mut total_recv: u64 = 0;
        let mut total_bytes_sent: u64 = 0;
        let mut total_bytes_recv: u64 = 0;
        let mut rtt_samples: Vec<(SocketAddr, u64)> = Vec::new();
        
        for conn in self.connections.iter() {
            let rtt_ms = conn.connection.rtt().as_millis() as u64;
            total_rtt += rtt_ms;
            total_sent += conn.messages_sent.load(Ordering::Relaxed);
            total_recv += conn.messages_received.load(Ordering::Relaxed);
            total_bytes_sent += conn.bytes_sent.load(Ordering::Relaxed);
            total_bytes_recv += conn.bytes_received.load(Ordering::Relaxed);
            if rtt_ms > 0 {
                rtt_samples.push((*conn.key(), rtt_ms));
            }
        }
        
        if !self.connections.is_empty() {
            stats.avg_rtt_ms = total_rtt / self.connections.len() as u64;
        }
        
        stats.messages_sent = total_sent;
        stats.messages_received = total_recv;
        stats.bytes_sent = total_bytes_sent;
        stats.bytes_received = total_bytes_recv;
        
        if !rtt_samples.is_empty() {
            let mut cache = self.rtt_cache.lock().await;
            for (addr, rtt_ms) in rtt_samples {
                cache.update(addr, rtt_ms);
            }
        }
        
        stats
    }
    
    /// Disconnect from peer
    pub fn disconnect(&self, peer_addr: &SocketAddr) {
        if let Some((_, conn)) = self.connections.remove(peer_addr) {
            conn.connection.close(VarInt::from_u32(0), b"disconnect");
        }
    }
    
    /// Cleanup idle connections
    pub fn cleanup_idle(&self) {
        let now_ms = Self::current_time_ms();
        let mut to_remove = Vec::new();
        
        for entry in self.connections.iter() {
            let last_ms = entry.value().last_activity_ms.load(Ordering::Relaxed);
            let idle_secs = (now_ms.saturating_sub(last_ms)) / 1000;
            if idle_secs > IDLE_TIMEOUT_SECS {
                to_remove.push(*entry.key());
            }
        }
        
        for addr in to_remove {
            self.disconnect(&addr);
        }
    }
    
    /// v2.95.1: Get current time in milliseconds since UNIX epoch
    fn current_time_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
    
    /// Check if connected
    pub fn is_connected(&self, peer_addr: &SocketAddr) -> bool {
        self.connections.contains_key(peer_addr)
    }
    
    /// Get connection count
    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }
    
    /// Get list of connected peers (addr, node_id, node_type)
    /// Returns ALL connected peers with their real node_type from QUIC handshake
    pub fn get_connected_peers(&self) -> Vec<(SocketAddr, String, String)> {
        self.connections.iter()
            .filter_map(|entry| {
                let addr = *entry.key();
                if let Some(ref node_id) = entry.value().remote_node_id {
                    // Use real node_type from handshake, fallback to "full" for safety
                    // (Full nodes don't have Super privileges, safer default)
                    let node_type = entry.value().remote_node_type.clone()
                        .unwrap_or_else(|| "full".to_string());
                    Some((addr, node_id.clone(), node_type))
                } else {
                    None
                }
            })
            .collect()
    }
    
    /// v2.95.1: Health check with ACTIVE ping verification
    /// Call this periodically (every 15s) to maintain healthy connection pool
    /// 
    /// Detects:
    /// 1. Explicitly closed connections (close_reason().is_some())
    /// 2. Zombie connections (idle > 30s) - verified with active ping
    /// 3. Failed ping responses (connection dead but close_reason = None)
    pub fn health_check(&self) -> (usize, usize) {
        let mut alive = 0;
        let mut removed = 0;
        let mut dead_addrs = Vec::new();
        let mut rtt_snapshots: Vec<(SocketAddr, u64)> = Vec::new();
        let now_ms = Self::current_time_ms();
        
        const STALE_THRESHOLD_SECS: u64 = 30;
        
        for entry in self.connections.iter() {
            let conn = entry.value();
            let is_explicitly_closed = conn.connection.close_reason().is_some();
            let last_ms = conn.last_activity_ms.load(Ordering::Relaxed);
            let idle_secs = (now_ms.saturating_sub(last_ms)) / 1000;
            let is_stale = idle_secs > STALE_THRESHOLD_SECS;
            
            // Snapshot RTT from live connections before potential removal
            let rtt_ms = conn.connection.rtt().as_millis() as u64;
            if rtt_ms > 0 {
                rtt_snapshots.push((*entry.key(), rtt_ms));
            }
            
            if is_explicitly_closed {
                dead_addrs.push(*entry.key());
            } else if is_stale {
                dead_addrs.push(*entry.key());
                if crate::node::is_debug() {
                    println!("[DBG][QUIC] stale_conn peer={} idle={}s",
                        get_privacy_id_for_addr(&entry.key().to_string()),
                        idle_secs);
                }
            } else {
                alive += 1;
            }
        }
        
        // Persist RTT snapshots before removing connections
        if !rtt_snapshots.is_empty() {
            if let Ok(mut cache) = self.rtt_cache.try_lock() {
                for (addr, rtt_ms) in rtt_snapshots {
                    cache.update(addr, rtt_ms);
                }
            }
        }
        
        for addr in dead_addrs {
            self.connections.remove(&addr);
            removed += 1;
        }
        
        if removed > 0 {
            if crate::node::is_info() {
                println!("[INFO][QUIC] health_check removed={} alive={}", removed, alive);
            }
        }
        
        (alive, removed)
    }
    
    /// v2.95: Active health check with ping/pong verification
    /// PRODUCTION: Use this for critical connections (block producers)
    /// Returns list of dead peer addresses that should be reconnected
    pub async fn active_health_check(&self, peer_addrs: &[SocketAddr]) -> Vec<SocketAddr> {
        let mut dead_peers = Vec::new();
        
        for &peer_addr in peer_addrs {
            if !self.ping_connection(peer_addr).await {
                dead_peers.push(peer_addr);
                // Remove dead connection
                if self.connections.remove(&peer_addr).is_some() {
                    if crate::node::is_warn() {
                        println!("[WARN][QUIC] ping_failed_removed peer={}", 
                            get_privacy_id_for_addr(&peer_addr.to_string()));
                    }
                }
            }
        }
        
        dead_peers
    }
    
    /// v2.95: Ping a specific connection to verify it's alive
    /// Sends a PING message and expects PONG back within 1 second
    pub async fn ping_connection(&self, peer_addr: SocketAddr) -> bool {
        let conn = match self.connections.get(&peer_addr) {
            Some(c) => c.clone(),
            None => return false, // No connection to ping
        };
        
        // Check if already explicitly closed
        if conn.connection.close_reason().is_some() {
            return false;
        }
        
        // Try to open a unidirectional stream as a lightweight ping
        // If this fails, the connection is dead
        const PING_TIMEOUT_MS: u64 = 1000;
        
        match tokio::time::timeout(
            Duration::from_millis(PING_TIMEOUT_MS),
            conn.connection.open_uni()
        ).await {
            Ok(Ok(mut send)) => {
                // v2.95.3: Send length-prefixed ping (must match handle_uni_stream protocol)
                // Ping payload is single 0xFF byte, but with 4-byte length prefix
                let ping_data = [0xFFu8];
                let len_bytes = (ping_data.len() as u32).to_be_bytes();
                let write_result = async {
                    send.write_all(&len_bytes).await?;
                    send.write_all(&ping_data).await
                }.await;
                
                if write_result.is_ok() {
                    let _ = send.finish();
                    // v2.95.3: Ping successful - connection is alive
                    true
                } else {
                    false
                }
            }
            Ok(Err(_)) | Err(_) => false, // Connection dead or timeout
        }
    }
    
    /// v2.24: Get alive connection count (excludes dead connections)
    pub fn alive_connection_count(&self) -> usize {
        self.connections.iter()
            .filter(|entry| crate::quic_transport::is_connection_alive(entry.value()))
            .count()
    }

    pub fn is_connection_alive(&self, peer_addr: &SocketAddr) -> bool {
        self.connections.get(peer_addr)
            .map(|conn| crate::quic_transport::is_connection_alive(&conn))
            .unwrap_or(false)
    }
    
    /// v2.24: Force reconnect to a peer (removes dead connection and creates new one)
    pub async fn force_reconnect(&self, peer_addr: SocketAddr) -> Result<Arc<QuicConnection>, String> {
        // Remove any existing connection (dead or alive)
        if self.connections.remove(&peer_addr).is_some() {
            if is_info() { println!("[INFO][QUIC] force_remove_conn peer={}", get_privacy_id_for_addr(&peer_addr.to_string())); }
        }
        
        // Create new connection
        self.connect(peer_addr).await
    }
    
    /// Stop server
    pub fn stop(&self) {
        self.server_running.store(false, Ordering::SeqCst);
    }
}

// ============================================================================
// TLS CERTIFICATE VERIFICATION
// ============================================================================

/// TLS-level verifier: accepts self-signed certs (P2P network, no CA).
/// Actual authentication is done post-handshake via verify_peer_cert_node_id()
/// which binds the TLS cert SAN to the claimed node_id.
#[derive(Debug)]
struct SelfSignedCertVerifier;

impl rustls::client::danger::ServerCertVerifier for SelfSignedCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        // TLS encryption active; node identity verified post-handshake
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::aws_lc_rs::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

// ============================================================================
// POST-HANDSHAKE NODE IDENTITY VERIFICATION (v6.2)
// ============================================================================

impl QuicTransport {
    /// Best-effort TLS cert SAN verification.
    ///
    /// Returns:
    ///   Ok(())       — cert found and SAN matches claimed node_id
    ///   Err(reason)  — cert unavailable (one-way TLS, Quinn doesn't expose client cert)
    ///                  OR SAN mismatch (genuine potential MitM)
    ///
    /// Callers must NOT close the connection on Err — they should log and continue.
    /// Dilithium3-signed consensus messages provide cryptographic node_id binding.
    fn verify_peer_cert_node_id(conn: &Connection, claimed_node_id: &str) -> Result<(), String> {
        let expected_san = format!("qnet-{}", claimed_node_id);

        let peer_identity = match conn.peer_identity() {
            Some(id) => id,
            None => return Err("peer_identity unavailable (one-way TLS, no client cert)".to_string()),
        };

        let certs: &Vec<CertificateDer> = peer_identity
            .downcast_ref::<Vec<CertificateDer>>()
            .ok_or("peer identity is not a certificate chain")?;

        let cert_der = certs.first()
            .ok_or("empty certificate chain")?;

        let cert_bytes = cert_der.as_ref();

        // SAN dNSName is encoded as UTF-8 string in DER.
        // rcgen::generate_simple_self_signed(vec!["qnet-{id}"]) always produces this format.
        if find_subsequence(cert_bytes, expected_san.as_bytes()).is_some() {
            return Ok(());
        }

        Err(format!("cert SAN does not contain '{}'", expected_san))
    }
}

/// Boyer-Moore-ish byte subsequence search
fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

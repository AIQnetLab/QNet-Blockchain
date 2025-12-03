//! # QNet QUIC Transport Layer
//!
//! High-performance QUIC transport for QNet P2P network.
//! Replaces HTTP for all P2P communication.
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

use dashmap::DashMap;
use quinn::{Endpoint, ServerConfig, ClientConfig, Connection, VarInt, RecvStream, SendStream};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::sync::{RwLock, mpsc};
use serde::{Serialize, Deserialize};

use crate::p2p_transport::*;
use crate::unified_p2p::{NetworkMessage, PeerInfo, get_privacy_id_for_addr};

// ============================================================================
// RETRY CONSTANTS
// ============================================================================

/// Number of connection retry attempts
const CONNECT_RETRY_ATTEMPTS: u32 = 3;

/// Delay between retry attempts (exponential backoff base)
const RETRY_DELAY_MS: u64 = 100;

// ============================================================================
// CONSTANTS - ALIGNED WITH HTTP VALUES
// ============================================================================

/// Connection timeout (same as HTTP: 3s)
pub const CONNECT_TIMEOUT_SECS: u64 = 3;

/// Send/receive timeout (same as HTTP: 5s for messages)
pub const MESSAGE_TIMEOUT_SECS: u64 = 5;

/// Keep-alive interval (same as HTTP TCP keepalive: 30s)
pub const KEEP_ALIVE_SECS: u64 = 30;

/// Idle connection timeout (same as HTTP pool: 90s)
pub const IDLE_TIMEOUT_SECS: u64 = 90;

/// Maximum concurrent streams per connection
pub const MAX_STREAMS_PER_CONN: u32 = 100;

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
    pub remote_node_type: Option<String>,  // "super", "full", or "light" (lowercase)
    pub connected_at: Instant,
    pub last_activity: Instant,
    pub messages_sent: AtomicU64,
    pub messages_received: AtomicU64,
    pub bytes_sent: AtomicU64,
    pub bytes_received: AtomicU64,
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
    /// QUIC port
    quic_port: u16,
    /// Active connections (peer_addr -> connection)
    connections: Arc<DashMap<SocketAddr, Arc<QuicConnection>>>,
    /// Server running flag
    server_running: Arc<AtomicBool>,
    /// Message handler callback
    message_handler: Option<MessageHandler>,
    /// Statistics
    stats: Arc<RwLock<QuicStats>>,
}

impl QuicTransport {
    pub fn new(node_id: String, node_type: String, quic_port: u16) -> Self {
        Self {
            endpoint: None,
            node_id,
            cert_serial: String::new(),
            node_type,
            quic_port,
            connections: Arc::new(DashMap::new()),
            server_running: Arc::new(AtomicBool::new(false)),
            message_handler: None,
            stats: Arc::new(RwLock::new(QuicStats::default())),
        }
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
        
        // Server config
        let mut server_crypto = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert.clone()], key.clone_key())
            .map_err(|e| format!("Server config failed: {}", e))?;
        
        server_crypto.alpn_protocols = vec![b"qnet-p2p-v1".to_vec()];
        
        let mut server_config = ServerConfig::with_crypto(Arc::new(
            quinn::crypto::rustls::QuicServerConfig::try_from(server_crypto)
                .map_err(|e| format!("QUIC server config failed: {}", e))?
        ));
        
        // Transport config - ALIGNED WITH HTTP
        let mut transport = quinn::TransportConfig::default();
        transport.max_concurrent_bidi_streams(VarInt::from_u32(MAX_STREAMS_PER_CONN));
        transport.max_concurrent_uni_streams(VarInt::from_u32(MAX_STREAMS_PER_CONN));
        transport.max_idle_timeout(Some(Duration::from_secs(IDLE_TIMEOUT_SECS).try_into().expect("Idle timeout must fit in IdleTimeout")));
        transport.keep_alive_interval(Some(Duration::from_secs(KEEP_ALIVE_SECS)));
        server_config.transport_config(Arc::new(transport));
        
        // Create endpoint
        let endpoint = Endpoint::server(server_config, bind_addr)
            .map_err(|e| format!("Endpoint creation failed: {}", e))?;
        
        self.endpoint = Some(endpoint);
        
        // PRIVACY: bind_addr is local, OK to show
        println!("[QUIC] ✅ Transport initialized on {}", bind_addr);
        println!("[QUIC] 📊 Timeouts: connect={}s, idle={}s, keepalive={}s", 
            CONNECT_TIMEOUT_SECS, IDLE_TIMEOUT_SECS, KEEP_ALIVE_SECS);
        
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
        
        // Spawn server task
        tokio::spawn(async move {
            println!("[QUIC] 🚀 Server started, accepting connections...");
            
            while server_running.load(Ordering::Relaxed) {
                // Accept incoming connection
                let incoming = match endpoint.accept().await {
                    Some(conn) => conn,
                    None => {
                        println!("[QUIC] ⚠️ Endpoint closed");
                        break;
                    }
                };
                
                let peer_addr = incoming.remote_address();
                
                // Handle connection in separate task
                let connections_clone = connections.clone();
                let handler_clone = message_handler.clone();
                let stats_clone = stats.clone();
                let node_id_clone = node_id.clone();
                let cert_serial_clone = cert_serial.clone();
                let node_type_clone = node_type.clone();
                
                tokio::spawn(async move {
                    match incoming.await {
                        Ok(connection) => {
                            // PRIVACY: Hide real IP in logs
                            println!("[QUIC] 📥 Incoming connection from {}", get_privacy_id_for_addr(&peer_addr.to_string()));
                            
                            // Perform handshake
                            let handshake_result = Self::handle_server_handshake(
                                &connection, 
                                &node_id_clone, 
                                &cert_serial_clone,
                                &node_type_clone
                            ).await;
                            
                            let (remote_node_id, remote_cert_serial, remote_node_type) = match handshake_result {
                                Ok(h) => h,
                                Err(e) => {
                                    println!("[QUIC] ❌ Handshake failed from {}: {}", get_privacy_id_for_addr(&peer_addr.to_string()), e);
                                    return;
                                }
                            };
                            
                            println!("[QUIC] ✅ Accepted connection from {} (node: {})", get_privacy_id_for_addr(&peer_addr.to_string()), remote_node_id);
                            
                            // CRITICAL: Prevent self-connect on server side too
                            if remote_node_id == node_id_clone {
                                println!("[QUIC] ⚠️ Self-connect detected on server side, closing");
                                connection.close(quinn::VarInt::from_u32(0), b"self-connect");
                                return;
                            }
                            
                            // CRITICAL FIX v2.19.24: Smart connection management
                            // 
                            // Architecture: Each node pair needs connections for BOTH directions:
                            // - CLIENT conn (we initiated): we send, they receive via accept
                            // - SERVER conn (they initiated): they send, we receive via accept
                            // 
                            // Rules:
                            // 1. Accept incoming if we don't have SERVER conn from this node
                            // 2. Replace SERVER conn if it's DEAD
                            // 3. Keep our CLIENT conn separate (different peer_addr anyway)
                            //
                            // This prevents:
                            // - Duplicate SERVER connections from same node
                            // - Closing connections needed for receiving
                            // - Memory leaks from dead connections
                            
                            let mut existing_server_addr: Option<std::net::SocketAddr> = None;
                            let mut existing_server_alive = false;
                            
                            for entry in connections_clone.iter() {
                                if let Some(ref existing_node_id) = entry.value().remote_node_id {
                                    if existing_node_id == &remote_node_id {
                                        // Check if this is a SERVER connection (incoming)
                                        // SERVER connections have random source port from client
                                        // Our CLIENT connections use the known QUIC port
                                        let entry_port = entry.key().port();
                                        let is_server_conn = entry_port != crate::quic_transport::QUIC_PORT;
                                        
                                        if is_server_conn {
                                            existing_server_addr = Some(*entry.key());
                                            existing_server_alive = entry.value().connection.close_reason().is_none();
                                            break;
                                        }
                                    }
                                }
                            }
                            
                            // Handle existing SERVER connection
                            if let Some(addr) = existing_server_addr {
                                if existing_server_alive {
                                    // Already have LIVE server connection - close this duplicate
                                    println!("[QUIC] ⚠️ Already have LIVE SERVER connection from node {}, closing duplicate", remote_node_id);
                                    connection.close(quinn::VarInt::from_u32(0), b"duplicate-server");
                                    return;
                                } else {
                                    // Remove DEAD server connection
                                    println!("[QUIC] 🔄 Replacing DEAD SERVER connection from node {}", remote_node_id);
                                    connections_clone.remove(&addr);
                                }
                            }
                            
                            // Store connection
                            let quic_conn = Arc::new(QuicConnection {
                                connection: connection.clone(),
                                remote_node_id: Some(remote_node_id.clone()),
                                remote_cert_serial: Some(remote_cert_serial),
                                remote_node_type: Some(remote_node_type.clone()),
                                connected_at: Instant::now(),
                                last_activity: Instant::now(),
                                messages_sent: AtomicU64::new(0),
                                messages_received: AtomicU64::new(0),
                                bytes_sent: AtomicU64::new(0),
                                bytes_received: AtomicU64::new(0),
                            });
                            
                            connections_clone.insert(peer_addr, quic_conn.clone());
                            println!("[QUIC] 📦 Connection stored for {} (node: {}, type: {})", get_privacy_id_for_addr(&peer_addr.to_string()), remote_node_id, remote_node_type);
                            
                            // Update stats
                            {
                                let mut s = stats_clone.write().await;
                                s.connections_established += 1;
                                s.active_connections = connections_clone.len();
                            }
                            
                            // Handle incoming streams
                            Self::handle_incoming_streams(connection, peer_addr, handler_clone, quic_conn).await;
                        }
                        Err(e) => {
                            println!("[QUIC] ❌ Connection failed from {}: {}", get_privacy_id_for_addr(&peer_addr.to_string()), e);
                            let mut s = stats_clone.write().await;
                            s.connections_failed += 1;
                        }
                    }
                });
            }
            
            println!("[QUIC] 🛑 Server stopped");
        });
        
        Ok(())
    }
    
    /// Handle server-side handshake
    async fn handle_server_handshake(
        conn: &Connection,
        our_node_id: &str,
        our_cert_serial: &str,
        our_node_type: &str,
    ) -> Result<(String, String, String), String> {
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
    }
    
    /// Handle incoming streams from a connection
    async fn handle_incoming_streams(
        conn: Connection,
        peer_addr: SocketAddr,
        handler: Option<MessageHandler>,
        quic_conn: Arc<QuicConnection>,
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
                            println!("[QUIC] 🔌 Connection closed from {}: {}", get_privacy_id_for_addr(&peer_addr.to_string()), e);
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
                            println!("[QUIC] 🔌 Uni stream closed from {}: {}", get_privacy_id_for_addr(&peer_addr.to_string()), e);
                            break;
                        }
                    }
                }
            }
        }
    }
    
    /// Handle bidirectional stream
    async fn handle_bidi_stream(
        peer_addr: SocketAddr,
        mut send: SendStream,
        mut recv: RecvStream,
        handler: Option<MessageHandler>,
        conn: Arc<QuicConnection>,
    ) {
        // Read message
        let data = match tokio::time::timeout(
            Duration::from_secs(MESSAGE_TIMEOUT_SECS),
            recv.read_to_end(MAX_MESSAGE_SIZE)
        ).await {
            Ok(Ok(d)) => d,
            Ok(Err(e)) => {
                println!("[QUIC] ⚠️ Read failed from {}: {}", get_privacy_id_for_addr(&peer_addr.to_string()), e);
                return;
            }
            Err(_) => {
                println!("[QUIC] ⚠️ Read timeout from {}", get_privacy_id_for_addr(&peer_addr.to_string()));
                return;
            }
        };
        
        conn.bytes_received.fetch_add(data.len() as u64, Ordering::Relaxed);
        conn.messages_received.fetch_add(1, Ordering::Relaxed);
        
        // Parse message
        let msg = match Self::parse_message(&data) {
            Ok(m) => m,
            Err(e) => {
                println!("[QUIC] ⚠️ Parse failed from {}: {}", get_privacy_id_for_addr(&peer_addr.to_string()), e);
                return;
            }
        };
        
        // Call handler
        if let Some(ref h) = handler {
            h(peer_addr, msg);
        }
        
        // Send empty response (acknowledgment)
        let _ = send.finish();
    }
    
    /// Handle unidirectional stream (broadcast)
    async fn handle_uni_stream(
        peer_addr: SocketAddr,
        mut recv: RecvStream,
        handler: Option<MessageHandler>,
        conn: Arc<QuicConnection>,
    ) {
        // Read message
        let data = match tokio::time::timeout(
            Duration::from_secs(MESSAGE_TIMEOUT_SECS),
            recv.read_to_end(MAX_MESSAGE_SIZE)
        ).await {
            Ok(Ok(d)) => d,
            Ok(Err(e)) => {
                println!("[QUIC] ⚠️ Uni read failed from {}: {}", get_privacy_id_for_addr(&peer_addr.to_string()), e);
                return;
            }
            Err(_) => {
                println!("[QUIC] ⚠️ Uni read timeout from {}", get_privacy_id_for_addr(&peer_addr.to_string()));
                return;
            }
        };
        
        conn.bytes_received.fetch_add(data.len() as u64, Ordering::Relaxed);
        let msg_count = conn.messages_received.fetch_add(1, Ordering::Relaxed) + 1;
        
        // Log every 100th message or first 5 for debugging
        if msg_count <= 5 || msg_count % 100 == 0 {
            println!("[QUIC] 📨 Received uni message #{} from {} ({} bytes)", 
                msg_count, get_privacy_id_for_addr(&peer_addr.to_string()), data.len());
        }
        
        // Parse message
        let msg = match Self::parse_message(&data) {
            Ok(m) => m,
            Err(e) => {
                println!("[QUIC] ⚠️ Uni parse failed from {}: {}", get_privacy_id_for_addr(&peer_addr.to_string()), e);
                return;
            }
        };
        
        // Call handler
        if let Some(ref h) = handler {
            h(peer_addr, msg);
        } else {
            println!("[QUIC] ❌ CRITICAL: handler is None! Message from {} lost!", get_privacy_id_for_addr(&peer_addr.to_string()));
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
    pub async fn connect(&self, peer_addr: SocketAddr) -> Result<Arc<QuicConnection>, String> {
        // FIRST CHECK: Existing connection - but only if it's ALIVE
        if let Some(conn) = self.connections.get(&peer_addr) {
            if conn.connection.close_reason().is_none() {
                // Connection is alive - reuse it
                return Ok(conn.clone());
            } else {
                // Connection is dead - remove it and create new one
                println!("[QUIC] 🔄 Removing dead connection to {}", get_privacy_id_for_addr(&peer_addr.to_string()));
                self.connections.remove(&peer_addr);
            }
        }
        
        let endpoint = self.endpoint.as_ref()
            .ok_or("Endpoint not initialized")?;
        
        // Retry loop for connection attempts
        let mut last_error = String::new();
        for attempt in 1..=CONNECT_RETRY_ATTEMPTS {
            // CRITICAL FIX: Double-check before creating connection (race condition protection)
            // Another task may have created connection while we were waiting
            if let Some(conn) = self.connections.get(&peer_addr) {
                if conn.connection.close_reason().is_none() {
                    return Ok(conn.clone());
                }
            }
            
            match self.try_connect_once(endpoint, peer_addr).await {
                Ok(conn) => return Ok(conn),
                Err(e) => {
                    last_error = e;
                    if attempt < CONNECT_RETRY_ATTEMPTS {
                        let delay = Duration::from_millis(RETRY_DELAY_MS * (1 << (attempt - 1))); // Exponential backoff
                        println!("[QUIC] ⚠️ Connection attempt {}/{} to {} failed, retrying in {:?}...",
                            attempt, CONNECT_RETRY_ATTEMPTS,
                            get_privacy_id_for_addr(&peer_addr.to_string()),
                            delay);
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
        
        Err(format!("Failed to connect after {} attempts: {}", CONNECT_RETRY_ATTEMPTS, last_error))
    }
    
    /// Single connection attempt (internal helper)
    async fn try_connect_once(&self, endpoint: &Endpoint, peer_addr: SocketAddr) -> Result<Arc<QuicConnection>, String> {
        
        // Client config with ALPN (must match server)
        let mut client_crypto = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SkipServerVerification))
            .with_no_client_auth();
        
        // CRITICAL: Set ALPN protocol to match server
        client_crypto.alpn_protocols = vec![b"qnet-p2p-v1".to_vec()];
        
        let mut client_config = ClientConfig::new(Arc::new(
            quinn::crypto::rustls::QuicClientConfig::try_from(client_crypto)
                .map_err(|e| format!("Client config failed: {}", e))?
        ));
        
        // Transport config - ALIGNED WITH HTTP
        // CRITICAL FIX: Must include uni_streams for receiving broadcasts!
        let mut transport = quinn::TransportConfig::default();
        transport.max_concurrent_bidi_streams(VarInt::from_u32(MAX_STREAMS_PER_CONN));
        transport.max_concurrent_uni_streams(VarInt::from_u32(MAX_STREAMS_PER_CONN)); // CRITICAL: Allow incoming uni streams!
        transport.max_idle_timeout(Some(Duration::from_secs(IDLE_TIMEOUT_SECS).try_into().expect("Idle timeout must fit in IdleTimeout")));
        transport.keep_alive_interval(Some(Duration::from_secs(KEEP_ALIVE_SECS)));
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
            println!("[QUIC] ⚠️ Self-connect detected, closing connection");
            connection.close(quinn::VarInt::from_u32(0), b"self-connect");
            return Err("Self-connect not allowed".to_string());
        }
        
        println!("[QUIC] ✅ Connected to {} (node: {}, type: {})", get_privacy_id_for_addr(&peer_addr.to_string()), remote_node_id, remote_node_type);
        
        // Store connection
        let quic_conn = Arc::new(QuicConnection {
            connection,
            remote_node_id: Some(remote_node_id),
            remote_cert_serial: Some(remote_cert_serial),
            remote_node_type: Some(remote_node_type),
            connected_at: Instant::now(),
            last_activity: Instant::now(),
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
        tokio::spawn(async move {
            Self::handle_incoming_streams(connection_for_listener, peer_addr, handler, quic_conn_for_listener).await;
        });
        
        Ok(quic_conn)
    }
    
    /// Perform client-side handshake
    async fn perform_client_handshake(&self, conn: &Connection) -> Result<(String, String, String), String> {
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
                    last_error = e;
                    // Cleanup dead connection on error
                    if let Some(conn) = self.connections.get(&peer_addr) {
                        if conn.connection.close_reason().is_some() {
                            self.connections.remove(&peer_addr);
                            println!("[QUIC] 🧹 Removed dead connection to {} after send error",
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
        
        Err(format!("Send failed after {} attempts: {}", CONNECT_RETRY_ATTEMPTS, last_error))
    }
    
    /// Single send attempt (internal helper)
    async fn try_send_once(&self, peer_addr: SocketAddr, wire_data: &[u8]) -> Result<(), String> {
        let conn = self.connect(peer_addr).await?;
        
        // Open bidirectional stream
        let (mut send, _recv) = conn.connection.open_bi().await
            .map_err(|e| format!("Open stream failed: {}", e))?;
        
        // Send with timeout
        tokio::time::timeout(
            Duration::from_secs(MESSAGE_TIMEOUT_SECS),
            send.write_all(wire_data)
        )
            .await
            .map_err(|_| "Send timeout")?
            .map_err(|e| format!("Write failed: {}", e))?;
        
        send.finish().map_err(|e| format!("Finish failed: {}", e))?;
        
        conn.bytes_sent.fetch_add(wire_data.len() as u64, Ordering::Relaxed);
        conn.messages_sent.fetch_add(1, Ordering::Relaxed);
        
        // Update stats
        {
            let mut stats = self.stats.write().await;
            stats.messages_sent += 1;
            stats.bytes_sent += wire_data.len() as u64;
        }
        
        Ok(())
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
                    last_error = e;
                    // Cleanup dead connection on error
                    if let Some(conn) = self.connections.get(&peer_addr) {
                        if conn.connection.close_reason().is_some() {
                            self.connections.remove(&peer_addr);
                            println!("[QUIC] 🧹 Removed dead connection to {} after broadcast error",
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
        
        Err(format!("Broadcast failed after {} attempts: {}", CONNECT_RETRY_ATTEMPTS, last_error))
    }
    
    /// Single broadcast attempt (internal helper)
    async fn try_broadcast_once(&self, peer_addr: SocketAddr, wire_data: &[u8]) -> Result<(), String> {
        let conn = self.connect(peer_addr).await?;
        
        // Open unidirectional stream
        let mut send = conn.connection.open_uni().await
            .map_err(|e| format!("Open uni stream failed: {}", e))?;
        
        // Send
        send.write_all(wire_data).await
            .map_err(|e| format!("Write failed: {}", e))?;
        send.finish().map_err(|e| format!("Finish failed: {}", e))?;
        
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
            NetworkMessage::EmergencyProducerChange { .. } => 7,
            NetworkMessage::ShredProtocolChunk { .. } => 8,
            NetworkMessage::ReputationSync { .. } => 9,
            _ => 0,
        }
    }
    
    /// Get statistics
    pub async fn get_stats(&self) -> QuicStats {
        let mut stats = self.stats.read().await.clone();
        stats.active_connections = self.connections.len();
        
        // Calculate average RTT and sum per-connection stats
        let mut total_rtt: u64 = 0;
        let mut total_sent: u64 = 0;
        let mut total_recv: u64 = 0;
        let mut total_bytes_sent: u64 = 0;
        let mut total_bytes_recv: u64 = 0;
        
        for conn in self.connections.iter() {
            total_rtt += conn.connection.rtt().as_millis() as u64;
            total_sent += conn.messages_sent.load(Ordering::Relaxed);
            total_recv += conn.messages_received.load(Ordering::Relaxed);
            total_bytes_sent += conn.bytes_sent.load(Ordering::Relaxed);
            total_bytes_recv += conn.bytes_received.load(Ordering::Relaxed);
        }
        
        if !self.connections.is_empty() {
            stats.avg_rtt_ms = total_rtt / self.connections.len() as u64;
        }
        
        // Override with per-connection totals (global stats may be stale)
        stats.messages_sent = total_sent;
        stats.messages_received = total_recv;
        stats.bytes_sent = total_bytes_sent;
        stats.bytes_received = total_bytes_recv;
        
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
        let now = Instant::now();
        let mut to_remove = Vec::new();
        
        for entry in self.connections.iter() {
            if now.duration_since(entry.last_activity) > Duration::from_secs(IDLE_TIMEOUT_SECS) {
                to_remove.push(*entry.key());
            }
        }
        
        for addr in to_remove {
            self.disconnect(&addr);
        }
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
    
    /// Stop server
    pub fn stop(&self) {
        self.server_running.store(false, Ordering::SeqCst);
    }
}

// ============================================================================
// SKIP SERVER VERIFICATION
// ============================================================================

#[derive(Debug)]
struct SkipServerVerification;

impl rustls::client::danger::ServerCertVerifier for SkipServerVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
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
        vec![
            rustls::SignatureScheme::ED25519,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
        ]
    }
}

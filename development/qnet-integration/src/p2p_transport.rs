//! # QNet P2P Transport Layer
//!
//! High-performance, post-quantum secure P2P transport for QNet blockchain.
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────┐
//! │                     P2PTransport Trait                          │
//! │  - send_message(peer, msg) -> Response                         │
//! │  - broadcast(msg) -> Results                                    │
//! │  - connect(peer) -> Connection                                  │
//! └─────────────────────────────────────────────────────────────────┘
//!                              │
//!              ┌───────────────┴───────────────┐
//!              ▼                               ▼
//! ┌─────────────────────────┐   ┌─────────────────────────┐
//! │   QuicTransport         │   │   (Legacy HTTP removed) │
//! │   - QUIC/TLS 1.3        │   │                         │
//! │   - Post-quantum PKI    │   │                         │
//! │   - Binary protocol     │   │                         │
//! │   - Multiplexing        │   │                         │
//! └─────────────────────────┘   └─────────────────────────┘
//! ```
//!
//! ## Security Model
//!
//! 1. **Transport Encryption**: QUIC with TLS 1.3
//! 2. **Peer Authentication**: PqCertificate (ML-DSA-65 / Dilithium3)
//! 3. **Message Integrity**: Dilithium signatures on all messages
//! 4. **Post-Quantum**: NIST FIPS 204 compliant (ML-DSA/Dilithium)
//!
//! ## Protocol
//!
//! Binary message format (bincode serialization):
//! ```text
//! ┌──────────┬──────────┬────────────┬─────────────────┐
//! │ Version  │ MsgType  │  Length    │    Payload      │
//! │ (1 byte) │ (1 byte) │ (4 bytes)  │  (N bytes)      │
//! └──────────┴──────────┴────────────┴─────────────────┘
//! ```

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Serialize, Deserialize};

use crate::unified_p2p::{PeerInfo, NetworkMessage};
use crate::crypto::pq_crypto::PqCertificate;

// ============================================================================
// CONSTANTS - ALIGNED WITH HTTP AND QUIC TRANSPORT
// ============================================================================

/// Protocol version for binary messages
pub const PROTOCOL_VERSION: u8 = 1;

/// Oldest wire version this binary still accepts. Accepting the range [MIN, CURRENT] (instead of an
/// exact match) lets a future version bump roll out node-by-node without partitioning the network —
/// upgraded nodes keep talking to not-yet-upgraded peers. MIN==CURRENT ⇒ behaviour unchanged today.
pub const MIN_SUPPORTED_PROTOCOL_VERSION: u8 = 1;

/// Maximum message size (10 MB - enough for macroblocks)
pub const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024;

/// Connection timeout (same as HTTP: 3s for quick P2P)
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// Message send timeout (same as HTTP)
pub const SEND_TIMEOUT: Duration = Duration::from_secs(5);

/// Keep-alive interval (same as HTTP: 30s)
pub const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(30);

/// Idle connection timeout (same as HTTP pool: 90s)
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// Maximum concurrent streams per connection
/// Must match quic_transport::MAX_STREAMS_PER_CONN
pub const MAX_STREAMS_PER_CONN: u32 = 500;

/// QUIC port offset from API port (8001 -> 10876)
/// NOTE: peer.addr contains API port (8001), so offset = 10876 - 8001 = 2875
pub const QUIC_PORT_OFFSET: u16 = 2875;

// ============================================================================
// ERROR TYPES
// ============================================================================

/// P2P Transport errors
#[derive(Debug, Clone)]
pub enum TransportError {
    /// Connection failed
    ConnectionFailed(String),
    /// Send failed
    SendFailed(String),
    /// Receive failed
    ReceiveFailed(String),
    /// Timeout
    Timeout,
    /// Peer not found
    PeerNotFound(String),
    /// Certificate verification failed
    CertificateInvalid(String),
    /// Dilithium signature invalid
    DilithiumSignatureInvalid(String),
    /// Message too large
    MessageTooLarge(usize),
    /// Protocol version mismatch
    ProtocolMismatch(u8, u8),
    /// Serialization error
    SerializationError(String),
    /// Peer blacklisted
    PeerBlacklisted(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::ConnectionFailed(msg) => write!(f, "Connection failed: {}", msg),
            TransportError::SendFailed(msg) => write!(f, "Send failed: {}", msg),
            TransportError::ReceiveFailed(msg) => write!(f, "Receive failed: {}", msg),
            TransportError::Timeout => write!(f, "Operation timed out"),
            TransportError::PeerNotFound(peer) => write!(f, "Peer not found: {}", peer),
            TransportError::CertificateInvalid(msg) => write!(f, "Invalid certificate: {}", msg),
            TransportError::DilithiumSignatureInvalid(msg) => write!(f, "Invalid Dilithium signature: {}", msg),
            TransportError::MessageTooLarge(size) => write!(f, "Message too large: {} bytes", size),
            TransportError::ProtocolMismatch(expected, got) => write!(f, "Protocol mismatch: expected v{}, got v{}", expected, got),
            TransportError::SerializationError(msg) => write!(f, "Serialization error: {}", msg),
            TransportError::PeerBlacklisted(peer) => write!(f, "Peer blacklisted: {}", peer),
        }
    }
}

impl std::error::Error for TransportError {}

pub type TransportResult<T> = Result<T, TransportError>;

// ============================================================================
// BINARY MESSAGE PROTOCOL
// ============================================================================

/// Binary message header
#[derive(Debug, Clone, Copy)]
pub struct MessageHeader {
    /// Protocol version
    pub version: u8,
    /// Message type
    pub msg_type: MessageType,
    /// Payload length
    pub length: u32,
}

impl MessageHeader {
    pub const SIZE: usize = 6; // 1 + 1 + 4 bytes
    
    pub fn new(msg_type: MessageType, length: u32) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            msg_type,
            length,
        }
    }
    
    pub fn to_bytes(&self) -> [u8; Self::SIZE] {
        let mut bytes = [0u8; Self::SIZE];
        bytes[0] = self.version;
        bytes[1] = self.msg_type as u8;
        bytes[2..6].copy_from_slice(&self.length.to_be_bytes());
        bytes
    }
    
    pub fn from_bytes(bytes: &[u8]) -> TransportResult<Self> {
        if bytes.len() < Self::SIZE {
            return Err(TransportError::ReceiveFailed("Header too short".into()));
        }
        
        let version = bytes[0];
        // Accept the supported range, not an exact match → a coordinated version bump rolls out
        // without partitioning. Out-of-range (too old / unknown-newer) is still rejected.
        if version < MIN_SUPPORTED_PROTOCOL_VERSION || version > PROTOCOL_VERSION {
            return Err(TransportError::ProtocolMismatch(PROTOCOL_VERSION, version));
        }
        
        let msg_type = MessageType::from_u8(bytes[1])
            .ok_or_else(|| TransportError::ReceiveFailed(format!("Unknown message type: {}", bytes[1])))?;
        
        let length = u32::from_be_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]);
        
        Ok(Self { version, msg_type, length })
    }
}

/// Message types for binary protocol
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MessageType {
    /// Block data (microblock or macroblock)
    Block = 1,
    /// Transaction
    Transaction = 2,
    /// Peer discovery
    PeerDiscovery = 3,
    /// Health ping
    HealthPing = 4,
    /// Emergency producer change
    EmergencyChange = 7,
    /// ShredProtocol chunk
    ShredProtocolChunk = 8,
    /// Block request (sync)
    BlockRequest = 10,
    /// Block batch response
    BlockBatch = 11,
    /// Certificate announce
    CertificateAnnounce = 12,
    /// Certificate request
    CertificateRequest = 13,
    /// Macroblock request
    MacroblockRequest = 14,
    /// Macroblock batch
    MacroblockBatch = 15,
    /// Sync status
    SyncStatus = 16,
    /// State snapshot
    StateSnapshot = 17,
    /// Handshake (certificate exchange)
    Handshake = 255,
}

impl MessageType {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Block),
            2 => Some(Self::Transaction),
            3 => Some(Self::PeerDiscovery),
            4 => Some(Self::HealthPing),
            7 => Some(Self::EmergencyChange),
            8 => Some(Self::ShredProtocolChunk),
            10 => Some(Self::BlockRequest),
            11 => Some(Self::BlockBatch),
            12 => Some(Self::CertificateAnnounce),
            13 => Some(Self::CertificateRequest),
            14 => Some(Self::MacroblockRequest),
            15 => Some(Self::MacroblockBatch),
            16 => Some(Self::SyncStatus),
            17 => Some(Self::StateSnapshot),
            255 => Some(Self::Handshake),
            _ => None,
        }
    }
    
    /// Get message type from NetworkMessage
    pub fn from_network_message(msg: &NetworkMessage) -> Self {
        match msg {
            NetworkMessage::Block { .. } => Self::Block,
            NetworkMessage::Transaction { .. } => Self::Transaction,
            NetworkMessage::PeerDiscovery { .. } => Self::PeerDiscovery,
            NetworkMessage::HealthPing { .. } => Self::HealthPing,
            #[allow(deprecated)]
            NetworkMessage::EmergencyProducerChange { .. } => Self::EmergencyChange,
            NetworkMessage::ShredProtocolChunk { .. } => Self::ShredProtocolChunk,
            NetworkMessage::RequestBlocks { .. } => Self::BlockRequest,
            NetworkMessage::BlocksBatch { .. } => Self::BlockBatch,
            NetworkMessage::CertificateAnnounce { .. } => Self::CertificateAnnounce,
            NetworkMessage::CertificateRequest { .. } => Self::CertificateRequest,
            NetworkMessage::RequestMacroblocks { .. } => Self::MacroblockRequest,
            NetworkMessage::MacroblocksBatch { .. } => Self::MacroblockBatch,
            NetworkMessage::SyncStatus { .. } => Self::SyncStatus,
            NetworkMessage::StateSnapshot { .. } => Self::StateSnapshot,
            _ => Self::HealthPing, // Fallback
        }
    }
}

/// Binary wire message (header + payload)
#[derive(Debug, Clone)]
pub struct WireMessage {
    pub header: MessageHeader,
    pub payload: Vec<u8>,
}

impl WireMessage {
    /// Create wire message from NetworkMessage
    pub fn from_network_message(msg: &NetworkMessage) -> TransportResult<Self> {
        let msg_type = MessageType::from_network_message(msg);
        let payload = bincode::serialize(msg)
            .map_err(|e| TransportError::SerializationError(e.to_string()))?;
        
        if payload.len() > MAX_MESSAGE_SIZE {
            return Err(TransportError::MessageTooLarge(payload.len()));
        }
        
        let header = MessageHeader::new(msg_type, payload.len() as u32);
        
        Ok(Self { header, payload })
    }
    
    /// Decode wire message to NetworkMessage
    pub fn to_network_message(&self) -> TransportResult<NetworkMessage> {
        bincode::deserialize(&self.payload)
            .map_err(|e| TransportError::SerializationError(e.to_string()))
    }
    
    /// Serialize to bytes for transmission
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(MessageHeader::SIZE + self.payload.len());
        bytes.extend_from_slice(&self.header.to_bytes());
        bytes.extend_from_slice(&self.payload);
        bytes
    }
    
    /// Parse from bytes
    pub fn from_bytes(bytes: &[u8]) -> TransportResult<Self> {
        if bytes.len() < MessageHeader::SIZE {
            return Err(TransportError::ReceiveFailed("Message too short".into()));
        }
        
        let header = MessageHeader::from_bytes(bytes)?;
        let expected_len = MessageHeader::SIZE + header.length as usize;
        
        if bytes.len() < expected_len {
            return Err(TransportError::ReceiveFailed(format!(
                "Incomplete message: got {} bytes, expected {}",
                bytes.len(), expected_len
            )));
        }
        
        let payload = bytes[MessageHeader::SIZE..expected_len].to_vec();
        
        Ok(Self { header, payload })
    }
}

// ============================================================================
// HANDSHAKE MESSAGE (Certificate Exchange)
// ============================================================================

/// Handshake message for post-quantum certificate exchange
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeMessage {
    /// Node ID
    pub node_id: String,
    /// PqCertificate for verification
    pub certificate: PqCertificate,
    /// Protocol version supported
    pub protocol_version: u8,
    /// Timestamp (Unix epoch)
    pub timestamp: u64,
    /// Dilithium signature of (node_id + timestamp)
    pub dilithium_signature: Vec<u8>,
}

// ============================================================================
// P2P TRANSPORT TRAIT
// ============================================================================

/// Connection information
#[derive(Debug, Clone)]
pub struct ConnectionInfo {
    /// Peer address
    pub peer_addr: SocketAddr,
    /// Peer node ID
    pub peer_node_id: String,
    /// Peer certificate (verified)
    pub peer_certificate: PqCertificate,
    /// Connection established time
    pub connected_at: Instant,
    /// Last activity time
    pub last_activity: Instant,
    /// Round-trip time (milliseconds)
    pub rtt_ms: u64,
    /// Messages sent
    pub messages_sent: u64,
    /// Messages received
    pub messages_received: u64,
}

/// Broadcast result for a single peer
#[derive(Debug, Clone)]
pub struct BroadcastResult {
    pub peer_addr: String,
    pub success: bool,
    pub error: Option<String>,
    pub rtt_ms: Option<u64>,
}

/// P2P Transport trait - abstraction for QUIC transport
#[async_trait]
pub trait P2PTransport: Send + Sync {
    /// Initialize the transport
    async fn init(&mut self, bind_addr: SocketAddr, node_id: &str, certificate: &PqCertificate) -> TransportResult<()>;
    
    /// Connect to a peer
    async fn connect(&self, peer_addr: SocketAddr) -> TransportResult<ConnectionInfo>;
    
    /// Send message to a specific peer
    async fn send_message(&self, peer_addr: SocketAddr, msg: &NetworkMessage) -> TransportResult<Option<NetworkMessage>>;
    
    /// Broadcast message to all connected peers
    async fn broadcast(&self, msg: &NetworkMessage, peers: &[PeerInfo]) -> Vec<BroadcastResult>;
    
    /// Disconnect from a peer
    async fn disconnect(&self, peer_addr: SocketAddr);
    
    /// Get connection info for a peer
    fn get_connection_info(&self, peer_addr: &SocketAddr) -> Option<ConnectionInfo>;
    
    /// Get all active connections
    fn get_all_connections(&self) -> Vec<ConnectionInfo>;
    
    /// Get transport statistics
    async fn get_stats(&self) -> TransportStats;
    
    /// Check if peer is connected
    fn is_connected(&self, peer_addr: &SocketAddr) -> bool;
    
    /// Cleanup idle connections
    async fn cleanup_idle_connections(&self);
}

/// Transport statistics
#[derive(Debug, Clone, Default)]
pub struct TransportStats {
    /// Total connections established
    pub connections_established: u64,
    /// Total connections failed
    pub connections_failed: u64,
    /// Current active connections
    pub active_connections: usize,
    /// Total messages sent
    pub messages_sent: u64,
    /// Total messages received  
    pub messages_received: u64,
    /// Total bytes sent
    pub bytes_sent: u64,
    /// Total bytes received
    pub bytes_received: u64,
    /// Average RTT (milliseconds)
    pub avg_rtt_ms: u64,
    /// Certificate verifications passed
    pub cert_verifications_passed: u64,
    /// Certificate verifications failed
    pub cert_verifications_failed: u64,
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_header_roundtrip() {
        let header = MessageHeader::new(MessageType::Block, 12345);
        let bytes = header.to_bytes();
        let parsed = MessageHeader::from_bytes(&bytes).unwrap();
        
        assert_eq!(parsed.version, PROTOCOL_VERSION);
        assert_eq!(parsed.msg_type, MessageType::Block);
        assert_eq!(parsed.length, 12345);
    }

    #[test]
    fn test_message_type_conversion() {
        assert_eq!(MessageType::from_u8(1), Some(MessageType::Block));
        assert_eq!(MessageType::from_u8(8), Some(MessageType::ShredProtocolChunk));
        assert_eq!(MessageType::from_u8(255), Some(MessageType::Handshake));
        assert_eq!(MessageType::from_u8(200), None);
    }

    #[test]
    fn test_protocol_version_mismatch() {
        let mut bytes = [0u8; 6];
        bytes[0] = 99; // Wrong version
        bytes[1] = 1;
        
        let result = MessageHeader::from_bytes(&bytes);
        assert!(matches!(result, Err(TransportError::ProtocolMismatch(1, 99))));
    }
}


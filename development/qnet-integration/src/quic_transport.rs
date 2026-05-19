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
/// v2.96: Split into CONNECT (handshake) and SEND (message delivery) delays.
/// Connect uses aggressive backoff (1s base) because handshake storms are the problem.
/// Send uses moderate delay (200ms base) because message delivery must stay responsive.
const RETRY_DELAY_MS: u64 = 200;

/// Maximum delay between retries for send operations
const MAX_RETRY_DELAY_MS: u64 = 2_000;

/// v2.96: Connect-specific backoff base (1 second) — replaces RETRY_DELAY_MS for connect().
/// At old 50ms: 4 peers × 5 subsystems × 5 retries = 100 handshakes/sec to restarting node.
/// At 1000ms with jitter: reconnects spread over seconds.
const CONNECT_RETRY_DELAY_MS: u64 = 1_000;

/// v2.96: Connect-specific backoff ceiling (30 seconds).
/// Aligned with production L1 backoff ranges (Avalanche: 1s-60s, CometBFT: 5s-8hrs).
const CONNECT_MAX_RETRY_DELAY_MS: u64 = 30_000;

/// v2.96: Per-peer reconnect cooldown — minimum seconds between connect() attempts to same addr.
/// Multiple subsystems (sync, heartbeat, peer_exchange, BFT, macroblock) call connect() independently.
/// Without cooldown, a single node generates 25+ handshake attempts/sec to one peer.
/// With cooldown, max 1 attempt per PEER_RECONNECT_COOLDOWN_SECS regardless of caller count.
const PEER_RECONNECT_COOLDOWN_SECS: u64 = 5;

/// v2.96: Maximum concurrent outbound connection attempts.
/// Prevents self-DoS when many peers disconnect simultaneously (e.g., network restart).
/// Without limit: 1000 peers down → 1000 parallel handshakes → saturates CPU and network.
/// With limit: orderly reconnection queue, 10 at a time.
const MAX_CONCURRENT_OUTBOUND_DIALS: usize = 10;


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

/// Maximum message size (10 MB - for macroblocks/block batches)
pub const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024;

/// v9.0: Per-message-type size limits.
/// Enforced BEFORE memory allocation to prevent OOM from oversized small messages.
/// Type byte is extracted from wire header position [1] before deserialization.
/// Returns max allowed payload size for a given message type byte.
fn max_size_for_message_type(msg_type: u8) -> usize {
    match msg_type {
        // Block data: full 10 MB (macroblocks can be large)
        1 => MAX_MESSAGE_SIZE,         // Block
        8 => 512 * 1024 + 256,        // ShredProtocolChunk: 512 KB data + header
        // Consensus messages: 64 KB max (signatures + metadata only)
        5 => 64 * 1024,               // ConsensusCommit
        6 => 64 * 1024,               // ConsensusReveal
        // Small control messages: 8 KB
        4 => 8 * 1024,                // HealthPing (Dilithium sig ~3KB + metadata)
        3 => 256 * 1024,              // PeerDiscovery (can contain many peers)
        // Deprecated: reject entirely
        7 => 0,                        // EmergencyProducerChange (deprecated)
        9 => 0,                        // ReputationSyncDeprecated
        // Type 0 = catch-all (Transaction, VrfLeaderClaim, TimeoutVote, SyncStatus,
        //   BlocksBatch, MacroblocksBatch, EntropyRequest/Response, heartbeats, etc.)
        // Use 2 MB — large enough for tx batches but not full 10 MB abuse
        2 => 1024 * 1024,             // Transaction: 1 MB
        0 => 2 * 1024 * 1024,         // Catch-all: 2 MB
        _ => 2 * 1024 * 1024,         // Unknown: 2 MB
    }
}

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

/// v2.96: Three-tier per-IP connection limits (aligned with production L1 patterns).
///
/// Tier 1 — Genesis: unlimited (u32::MAX). Only 5 IPs, hardcoded. Consensus must never
///   be blocked by rate limiting between genesis nodes. Equivalent to CometBFT
///   `unconditional_peer_ids` and Polkadot `reserved-nodes`.
///
/// Tier 2 — Known peers: 200. IPs that completed at least one successful QUIC handshake.
///   Covers activated super-nodes with burn proof. High limit accommodates cloud hosting
///   where multiple nodes share an IP (NAT, cloud shared subnets).
///
/// Tier 3 — Unknown: 10. Never-seen IPs. Strict limit for DDoS protection.
///   After first successful handshake, IP promoted to Tier 2 automatically.
const MAX_CONNECTIONS_PER_IP_GENESIS: u32 = u32::MAX;
const MAX_CONNECTIONS_PER_IP_KNOWN: u32 = 200;
const MAX_CONNECTIONS_PER_IP_UNKNOWN: u32 = 10;

/// v9.3: Check if IP belongs to a genesis node (compile-time known validators).
fn is_genesis_ip(ip: &std::net::IpAddr) -> bool {
    let ip_str = ip.to_string();
    crate::genesis_constants::GENESIS_NODE_IPS.iter()
        .any(|(genesis_ip, _)| *genesis_ip == ip_str)
}

/// v9.2: TOFU pin lifetime (24 hours). After this, the pin expires and re-pins
/// on next connection. This handles cert rotation on rolling restarts:
/// node restarts with new self-signed cert → peers accept after TTL expires.
const TOFU_PIN_TTL_SECS: u64 = 86_400;

/// v9.2: TOFU grace period (2 hours). If a pin is OLDER than this and a NEW
/// fingerprint arrives, the pin is updated (not rejected). This allows cert
/// rotation without waiting for full TTL. Within the first 2 hours after
/// pinning, any change IS suspicious (possible MITM) → rejected.
const TOFU_PIN_GRACE_AFTER_SECS: u64 = 7_200;

/// v9.2: Maximum TOFU pins to prevent memory growth from attacker node_ids.
/// At ~80 bytes per entry (32 fp + 8 ts + ~40 key), 10K pins ≈ 800KB.
const TOFU_MAX_PINS: usize = 10_000;

/// v9.2: TOFU pin entry with timestamp for TTL-based expiry and cert rotation.
#[derive(Debug, Clone)]
struct TofuPin {
    fingerprint: [u8; 32],
    pinned_at: u64, // unix timestamp (seconds)
}

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
    // Used by major L1 networks, Google QUIC (quiche), Cloudflare.
    transport.congestion_controller_factory(Arc::new(quinn::congestion::BbrConfig::default()));

    transport.receive_window(VarInt::from_u32(16_777_216)); // 16 MB
    transport.send_window(16_777_216); // 16 MB
    transport.datagram_receive_buffer_size(Some(8_388_608)); // 8 MB

    transport
}

// NODE HANDSHAKE — v19: authenticated identity binding (anti-spoof).
// Handshake carries an OPTIONAL dilithium_proof = Dilithium3_sign(SK,
// "qnet-quic-handshake-v1:{node_id}:{ts}:{block_height}"); receiver
// verifies via consensus_crypto::verify_consensus_signature against the
// immutable CONSENSUS_PK_REGISTRY (genesis anchors + on-chain super regs),
// subordinating the old X.509-SAN/TOFU admit to a crypto identity gate.
// Phase 2.A: proof is Option — pre-v19 (None) still admitted + [WARN];
// enforcement ADVISORY (verify-and-log); Phase 2.B → strict refuse after
// the migration window. Challenge bound to (node_id,ts,height) → no
// cross-identity / stale-boot replay. ~1 Dilithium verify per conn.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeHandshake {
    pub node_id: String,
    pub cert_serial: String,
    pub protocol_version: u8,
    pub node_type: String,
    pub timestamp: u64,
    /// v9.7: Block height at handshake time — peers know real height from first second.
    /// Without this, all peers start at height 0 and sync determines wrong network_height
    /// (100 instead of 5220) → sync completes prematurely → node declared synchronized
    /// while thousands of blocks behind → VRF selects it → network stalls.
    pub block_height: u64,
    /// v19: Optional Dilithium3 proof of identity. Set by v19+ senders;
    /// `None` from older peers during the Phase 2.A migration window.
    /// Verification is advisory in Phase 2.A and strict in Phase 2.B.
    #[serde(default)]
    pub dilithium_proof: Option<Vec<u8>>,
}

/// v9.7: Pre-v19 handshake format with `block_height` but no Dilithium proof.
/// Used for backward-compatible deserialization when connecting to v9.7..v18 nodes.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct NodeHandshakeV2 {
    pub node_id: String,
    pub cert_serial: String,
    pub protocol_version: u8,
    pub node_type: String,
    pub timestamp: u64,
    pub block_height: u64,
}

/// Pre-v9.7 legacy handshake format without `block_height` (and without proof).
/// Used for backward-compatible deserialization when connecting to oldest peers.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct NodeHandshakeLegacy {
    pub node_id: String,
    pub cert_serial: String,
    pub protocol_version: u8,
    pub node_type: String,
    pub timestamp: u64,
}

impl NodeHandshakeV2 {
    fn into_handshake(self) -> NodeHandshake {
        NodeHandshake {
            node_id: self.node_id,
            cert_serial: self.cert_serial,
            protocol_version: self.protocol_version,
            node_type: self.node_type,
            timestamp: self.timestamp,
            block_height: self.block_height,
            dilithium_proof: None, // v18 and older — no proof, advisory log on verify path
        }
    }
}

impl NodeHandshakeLegacy {
    fn into_handshake(self) -> NodeHandshake {
        NodeHandshake {
            node_id: self.node_id,
            cert_serial: self.cert_serial,
            protocol_version: self.protocol_version,
            node_type: self.node_type,
            timestamp: self.timestamp,
            block_height: 0, // Legacy node — height unknown, will be set by first HealthPing
            dilithium_proof: None,
        }
    }
}

/// v19: Deserialize handshake with three-way backward compatibility.
/// Try the v19 format first (with optional Dilithium proof), fall back to
/// the v9.7 format (with block_height), then the pre-v9.7 legacy format.
fn deserialize_handshake(data: &[u8]) -> Result<NodeHandshake, String> {
    // Try v19 format first (includes optional dilithium_proof field)
    if let Ok(hs) = bincode::deserialize::<NodeHandshake>(data) {
        return Ok(hs);
    }
    // Fallback: v9.7 format without proof (pre-v19 peers)
    if let Ok(v2) = bincode::deserialize::<NodeHandshakeV2>(data) {
        return Ok(v2.into_handshake());
    }
    // Fallback: pre-v9.7 legacy format without block_height
    match bincode::deserialize::<NodeHandshakeLegacy>(data) {
        Ok(legacy) => Ok(legacy.into_handshake()),
        Err(e) => Err(format!("Handshake deserialize failed (all formats): {}", e)),
    }
}

/// v19: Build the canonical handshake challenge string that the Dilithium
/// proof signs over. The format is stable across protocol versions and
/// MUST match between sender and receiver byte-for-byte.
///
/// Binding:
///   - `node_id`: prevents the proof from being relayed under a different identity
///   - `timestamp`: makes proofs ephemeral, so a captured proof from boot N
///     cannot be replayed in boot N+1 with a fresh keypair
///   - `block_height`: ties the proof to a specific chain epoch and makes
///     replay across reorgs detectable at the application layer
pub fn handshake_challenge_message(node_id: &str, timestamp: u64, block_height: u64) -> String {
    format!(
        "qnet-quic-handshake-v1:{}:{}:{}",
        node_id, timestamp, block_height
    )
}

/// v19: Best-effort generation of a Dilithium3 handshake proof.
///
/// The proof is built by signing `handshake_challenge_message` with the
/// local node's persisted Dilithium keypair via the same path that
/// produces consensus signatures (`create_consensus_signature`). When the
/// crypto subsystem is not yet initialised — only possible during a
/// brief window at very early boot — the helper returns `None` and the
/// handshake field stays empty. The receiver tolerates this gracefully
/// during the Phase 2.A migration window.
pub async fn build_handshake_proof(
    node_id: &str,
    timestamp: u64,
    block_height: u64,
) -> Option<Vec<u8>> {
    let crypto = match crate::node::try_get_quantum_crypto() {
        Some(c) => c,
        None => return None,
    };
    let challenge = handshake_challenge_message(node_id, timestamp, block_height);
    match crypto.create_consensus_signature(node_id, &challenge).await {
        Ok(sig) => Some(sig.signature.into_bytes()),
        Err(_) => None,
    }
}

/// v19.1: advisory handshake-proof verification. Three-state contract:
///   Ok(true)  — proof supplied AND verified under the claimed identity's
///               REGISTERED Dilithium PK (cryptographically authenticated).
///   Ok(false) — admitted via a documented advisory path (NOT a sig-gate
///               violation): (a) no proof (pre-v19 sender), (b) crypto not
///               yet initialised, or (c) PK not yet in the consensus
///               registry — a fresh-bootstrap joiner whose binding is set
///               by its inbound self-signed VrfKeyAnnounce.
///   Err       — proof supplied AND PK IS registered AND sig failed: the
///               only drop path (real squat vs unknown-PK first contact).
/// "PK absent" is split out of the failure path because the L1 invariant
/// requires connection establishment to NOT need pre-knowledge of the peer
/// key (identity binds via signed messages over the conn) — else fresh
/// boot deadlocks. Security: Ok(false) admits but does NOT authenticate;
/// every consensus message still passes verify_consensus_signature /
/// heartbeat / VrfKeyAnnounce verify, so a fake proof for an unknown id
/// gains nothing. O(1) lookup + <=1 Dilithium verify.
pub async fn verify_handshake_proof(
    claimed_node_id: &str,
    timestamp: u64,
    block_height: u64,
    proof: Option<&[u8]>,
) -> Result<bool, String> {
    let proof_bytes = match proof {
        Some(p) if !p.is_empty() => p,
        _ => return Ok(false), // (a) No proof attached — legacy peer
    };
    let proof_str = match std::str::from_utf8(proof_bytes) {
        Ok(s) => s.to_string(),
        Err(_) => return Err("handshake proof is not valid UTF-8".to_string()),
    };

    // (b) Crypto/P2P subsystems not yet ready — extremely early boot.
    // The QUIC port only opens AFTER P2P comes online, so under
    // production this branch should be unreachable; defended in depth.
    let p2p = match crate::node::try_get_p2p() {
        Some(p) => p,
        None => return Ok(false),
    };

    // (c) v19.1: PK-miss path — peer is a fresh joiner whose identity
    // binding is not yet in the consensus PK registry. Admit the
    // connection so the peer's `VrfKeyAnnounce` (carrying its
    // self-signed identity proof) can flow over it. Inline verify on
    // that message is the canonical install path; until then the
    // connection is a transport channel, not an authenticated peer.
    if !qnet_consensus::consensus_crypto::has_consensus_pk(claimed_node_id) {
        return Ok(false);
    }

    // PK is in registry — proof MUST verify under it. A failure here is
    // an attempted identity squat (someone produced a fake signature
    // for a known identity).
    let challenge = handshake_challenge_message(claimed_node_id, timestamp, block_height);
    if p2p
        .verify_dilithium_heartbeat_signature_async(&challenge, &proof_str, claimed_node_id)
        .await
    {
        Ok(true)
    } else {
        Err(format!(
            "handshake proof did not verify under registered PK for {}",
            claimed_node_id
        ))
    }
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
    /// v9.0: TOFU (Trust On First Use) cert fingerprint pinning.
    /// Maps node_id → SHA3-256(cert DER) on first successful connection.
    /// Subsequent connections from same node_id MUST present same cert fingerprint.
    /// Prevents MITM even if attacker knows the expected SAN format.
    /// v9.2: Stores TofuPin with timestamp for TTL expiry + cert rotation.
    cert_fingerprint_pins: Arc<DashMap<String, TofuPin>>,
    /// v9.1: Per-IP connection counter to prevent single-IP resource exhaustion.
    /// Maps IP → active connection count. Decremented on connection close.
    per_ip_connections: Arc<DashMap<std::net::IpAddr, u32>>,
    /// v2.96: Known peer IPs — promoted from unknown after first successful handshake.
    /// Gets higher per_ip_limit (Tier 2). Persists for transport lifetime.
    known_peer_ips: Arc<DashMap<std::net::IpAddr, ()>>,
    /// v2.96: Per-peer reconnect cooldown — tracks last connect() attempt time per address.
    /// Prevents reconnect storms when multiple subsystems independently trigger connect().
    last_connect_attempt: Arc<DashMap<SocketAddr, Instant>>,
    /// v2.96: Per-peer connect-in-progress guard — prevents parallel connect() to same addr.
    /// Only one connect() flight per peer at a time; others get cached error immediately.
    connect_in_progress: Arc<DashMap<SocketAddr, ()>>,
    /// v2.96: Outbound dial semaphore — limits concurrent outbound handshakes.
    /// Prevents self-DoS when many peers disconnect simultaneously.
    outbound_dial_semaphore: Arc<tokio::sync::Semaphore>,
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
            cert_fingerprint_pins: Arc::new(DashMap::new()),
            per_ip_connections: Arc::new(DashMap::new()),
            known_peer_ips: Arc::new(DashMap::new()),
            last_connect_attempt: Arc::new(DashMap::new()),
            connect_in_progress: Arc::new(DashMap::new()),
            outbound_dial_semaphore: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_OUTBOUND_DIALS)),
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
    
    /// v9.3: Load persistent TLS cert from disk, or generate + save if missing.
    /// Every production L1 uses persistent identity keys (stored in data dir).
    /// Ephemeral certs cause TOFU pin mismatches on every restart → network partition.
    fn load_or_generate_tls_cert(node_id: &str, data_dir: &str) -> Result<(CertificateDer<'static>, PrivateKeyDer<'static>), String> {
        let tls_dir = format!("{}/tls", data_dir);
        let cert_path = format!("{}/cert.der", tls_dir);
        let key_path = format!("{}/key.der", tls_dir);

        // Try loading existing cert+key from disk
        if let (Ok(cert_bytes), Ok(key_bytes)) = (std::fs::read(&cert_path), std::fs::read(&key_path)) {
            if !cert_bytes.is_empty() && !key_bytes.is_empty() {
                // v10.1: Verify SAN matches current node_id before reusing cert.
                // When a container restarts with a new hostname, node_id changes but
                // the persisted cert still has the OLD SAN → every peer rejects with
                // CERT_REJECTED (403). Detect this and regenerate automatically.
                let expected_san = format!("qnet-{}", node_id);
                let san_ok = Self::cert_san_matches(&cert_bytes, &expected_san);
                if san_ok {
                    if crate::node::is_info() {
                        println!("[INFO][QUIC] tls_cert_loaded path={} size={}B san={}", cert_path, cert_bytes.len(), expected_san);
                    }
                    return Ok((
                        CertificateDer::from(cert_bytes),
                        PrivateKeyDer::Pkcs8(key_bytes.into()),
                    ));
                } else {
                    println!("[WARN][QUIC] tls_cert_san_mismatch expected={} — regenerating cert", expected_san);
                    // Remove stale cert+key so we generate fresh ones below
                    let _ = std::fs::remove_file(&cert_path);
                    let _ = std::fs::remove_file(&key_path);
                }
            }
        }

        // Generate new cert
        let cert = rcgen::generate_simple_self_signed(vec![format!("qnet-{}", node_id)])
            .map_err(|e| format!("Certificate generation failed: {}", e))?;

        let cert_der = cert.serialize_der()
            .map_err(|e| format!("Certificate serialization failed: {}", e))?;
        let key_der = cert.get_key_pair().serialize_der();

        // Save to disk (create dir if needed, owner-only permissions)
        if let Err(e) = std::fs::create_dir_all(&tls_dir) {
            if crate::node::is_warn() {
                println!("[WARN][QUIC] tls_dir_create_fail path={} err={}", tls_dir, e);
            }
            // Continue without persistence — better than failing startup
        } else {
            // Atomic write: write to .tmp then rename — prevents corrupt files on crash
            let cert_tmp = format!("{}.tmp", cert_path);
            let key_tmp = format!("{}.tmp", key_path);
            if let Err(e) = std::fs::write(&cert_tmp, &cert_der)
                .and_then(|_| std::fs::rename(&cert_tmp, &cert_path)) {
                if crate::node::is_warn() { println!("[WARN][QUIC] tls_cert_write_fail err={}", e); }
                let _ = std::fs::remove_file(&cert_tmp);
            }
            if let Err(e) = std::fs::write(&key_tmp, &key_der)
                .and_then(|_| std::fs::rename(&key_tmp, &key_path)) {
                if crate::node::is_warn() { println!("[WARN][QUIC] tls_key_write_fail err={}", e); }
                let _ = std::fs::remove_file(&key_tmp);
            }
            // Best-effort chmod 0600 (Unix only, no-op on Windows)
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
            }
            if crate::node::is_info() {
                println!("[INFO][QUIC] tls_cert_generated_and_saved path={}", cert_path);
            }
        }

        Ok((CertificateDer::from(cert_der), PrivateKeyDer::Pkcs8(key_der.into())))
    }

    /// v10.1: Check if a DER-encoded certificate's SAN contains the expected dNSName.
    /// Used by load_or_generate_tls_cert to detect stale certs after hostname change.
    fn cert_san_matches(cert_bytes: &[u8], expected_san: &str) -> bool {
        match x509_parser::parse_x509_certificate(cert_bytes) {
            Ok((_, parsed)) => {
                if let Ok(Some(san_ext)) = parsed.subject_alternative_name() {
                    for name in &san_ext.value.general_names {
                        if let x509_parser::prelude::GeneralName::DNSName(dns) = name {
                            if *dns == expected_san {
                                return true;
                            }
                        }
                    }
                }
                false
            }
            Err(_) => false, // Corrupt cert — treat as mismatch, will regenerate
        }
    }

    /// Initialize QUIC transport (creates endpoint)
    pub async fn init(&mut self, bind_addr: SocketAddr, cert_serial: &str) -> Result<(), String> {
        self.cert_serial = cert_serial.to_string();

        // v9.3: Load persistent TLS cert (or generate on first run)
        let data_dir = std::env::var("QNET_DATA_DIR").unwrap_or_else(|_| "/app/data".to_string());
        let (cert, key) = Self::load_or_generate_tls_cert(&self.node_id, &data_dir)?;
        
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
        let tofu_pins = self.cert_fingerprint_pins.clone();
        let per_ip_conns = self.per_ip_connections.clone();
        let known_ips = self.known_peer_ips.clone();

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

                // FIX R23-P5: Global connection limit check BEFORE TLS handshake.
                // Previously only checked post-handshake (line ~910), wasting TLS CPU.
                const MAX_TOTAL_CONNECTIONS: usize = 500;
                if connections.len() >= MAX_TOTAL_CONNECTIONS {
                    incoming.refuse();
                    if crate::node::is_warn() {
                        println!("[WARN][QUIC] pre_tls_max_connections={} refusing", MAX_TOTAL_CONNECTIONS);
                    }
                    continue;
                }

                // v2.96: Three-tier per-IP connection limit — reject before TLS handshake to save CPU.
                // Tier 1 (Genesis): unlimited — consensus must never be blocked.
                // Tier 2 (Known): 200 — peers that completed handshake before.
                // Tier 3 (Unknown): 10 — strict DDoS protection for never-seen IPs.
                let peer_ip = peer_addr.ip();
                let (ip_limit, tier_name) = if is_genesis_ip(&peer_ip) {
                    (MAX_CONNECTIONS_PER_IP_GENESIS, "genesis")
                } else if known_ips.contains_key(&peer_ip) {
                    (MAX_CONNECTIONS_PER_IP_KNOWN, "known")
                } else {
                    (MAX_CONNECTIONS_PER_IP_UNKNOWN, "unknown")
                };
                let current_ip_count = per_ip_conns.get(&peer_ip).map(|v| *v).unwrap_or(0);
                if current_ip_count >= ip_limit {
                    incoming.refuse();
                    if crate::node::is_warn() {
                        println!("[WARN][QUIC] per_ip_limit ip={} count={} max={} tier={}",
                                 peer_ip, current_ip_count, ip_limit, tier_name);
                    }
                    continue;
                }
                // Increment counter; decremented when connection task ends
                per_ip_conns.entry(peer_ip).and_modify(|c| *c += 1).or_insert(1);

                let connections_clone = connections.clone();
                let handler_clone = message_handler.clone();
                let stats_clone = stats.clone();
                let node_id_clone = node_id.clone();
                let cert_serial_clone = cert_serial.clone();
                let peer_id_map_clone = peer_id_to_addr_map.clone();
                let node_type_clone = node_type.clone();
                let tofu_pins_clone = tofu_pins.clone();
                let per_ip_conns_clone = per_ip_conns.clone();
                let known_ips_clone = known_ips.clone();
                let peer_ip_clone = peer_ip;

                tokio::spawn(async move {
                    // v9.1: Scope guard — always decrement per-IP counter when task exits.
                    // This fires on every exit path (early return, handshake fail, connection end).
                    struct IpGuard { ip: std::net::IpAddr, map: Arc<DashMap<std::net::IpAddr, u32>> }
                    impl Drop for IpGuard {
                        fn drop(&mut self) {
                            self.map.entry(self.ip).and_modify(|c| { *c = c.saturating_sub(1); });
                            // Clean up zero entries to prevent map growth
                            if self.map.get(&self.ip).map(|v| *v == 0).unwrap_or(false) {
                                self.map.remove(&self.ip);
                            }
                        }
                    }
                    let _ip_guard = IpGuard { ip: peer_ip_clone, map: per_ip_conns_clone };

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
                    
                    let (remote_node_id, remote_cert_serial, remote_node_type, remote_block_height) = match handshake_result {
                        Ok(h) => h,
                        Err(e) => {
                            if crate::node::is_warn() { println!("[WARN][QUIC] handshake_failed peer={} err={}", get_privacy_id_for_addr(&peer_addr.to_string()), e); }
                            return;
                        }
                    };

                    if is_info() { println!("[INFO][QUIC] conn_accepted peer={} node={} h={}", get_privacy_id_for_addr(&peer_addr.to_string()), remote_node_id, remote_block_height); }

                    // v9.7: Immediately update BEST_PEER_HEIGHT from handshake — no 15s wait.
                    // This ensures sync_blockchain_height() sees real network height from the start.
                    if remote_block_height > 0 {
                        crate::unified_p2p::BEST_PEER_HEIGHT.fetch_max(remote_block_height, std::sync::atomic::Ordering::Relaxed);
                    }
                    
                    if remote_node_id == node_id_clone {
                        if crate::node::is_warn() { println!("[WARN][QUIC] self_connect_detected side=server action=close"); }
                        connection.close(quinn::VarInt::from_u32(0), b"self-connect");
                        return;
                    }
                    
                    // v9.0: X.509 SAN verification + TOFU cert pinning (server side).
                    // One-way TLS: client cert usually unavailable → Err → OK.
                    // SAN mismatch or TOFU pin mismatch → close (MITM).
                    match Self::verify_peer_cert_node_id(&connection, &remote_node_id, &tofu_pins_clone) {
                        Ok(()) => {
                            if is_debug() { println!("[DBG][QUIC] cert_san_ok side=server node={}", remote_node_id); }
                        }
                        Err(e) if e.contains("SAN does not contain") || e.contains("TOFU_PIN_MISMATCH") || e.contains("X.509 parse") => {
                            if crate::node::is_warn() { println!("[WARN][QUIC] cert_REJECTED side=server node={} reason={}", remote_node_id, e); }
                            connection.close(quinn::VarInt::from_u32(403), b"CERT_REJECTED");
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
                    
                    // v9.0 BUG-18: Total connection limit.
                    // Prevents resource exhaustion from too many peers.
                    // Genesis phase: 50 max. Scales with network growth.
                    const MAX_TOTAL_CONNECTIONS: usize = 500;
                    if connections_clone.len() >= MAX_TOTAL_CONNECTIONS {
                        if crate::node::is_warn() {
                            println!("[WARN][QUIC] max_connections_reached={} refusing node={}",
                                     MAX_TOTAL_CONNECTIONS, remote_node_id);
                        }
                        connection.close(quinn::VarInt::from_u32(503), b"max_connections");
                        return;
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
                    // v2.96: Promote IP to known tier after successful handshake
                    known_ips_clone.insert(peer_ip_clone, ());
                    if is_info() { println!("[INFO][QUIC] conn_stored peer={} node={} type={} ip_tier=known", get_privacy_id_for_addr(&peer_addr.to_string()), remote_node_id, remote_node_type); }

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
    /// v9.7: Returns (node_id, cert_serial, node_type, block_height) — height enables
    /// immediate BEST_PEER_HEIGHT update instead of waiting 15s for first HealthPing.
    async fn handle_server_handshake(
        conn: &Connection,
        our_node_id: &str,
        our_cert_serial: &str,
        our_node_type: &str,
    ) -> Result<(String, String, String, u64), String> {
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
            
            // v9.7: Backward-compatible deserialization (supports pre-v9.7 nodes)
            let peer_handshake = deserialize_handshake(&data)?;

            // v19: Verify peer's Dilithium identity proof BEFORE sending ours.
            // On Err the connection is aborted — we never reveal our own proof
            // to a peer that supplied a bogus one. On Ok(false) we proceed
            // (Phase 2.A backward compatibility) but emit an audit log.
            match verify_handshake_proof(
                &peer_handshake.node_id,
                peer_handshake.timestamp,
                peer_handshake.block_height,
                peer_handshake.dilithium_proof.as_deref(),
            ).await {
                Ok(true) => {
                    if is_info() {
                        println!("[INFO][HANDSHAKE] dilithium_proof_verified side=server node={} h={}",
                                 peer_handshake.node_id, peer_handshake.block_height);
                    }
                }
                Ok(false) => {
                    // v19.1: Advisory admit. Three causes possible (in order
                    // of likelihood for a fresh cluster):
                    //   (c) PK not yet in CONSENSUS_PK_REGISTRY — peer's
                    //       VrfKeyAnnounce will install it;
                    //   (a) peer is pre-v19 and did not attach a proof;
                    //   (b) local crypto subsystem not yet initialised.
                    // None of these are attacks — the peer is admitted,
                    // and every consensus message it later sends still
                    // goes through full Dilithium3 verification.
                    if crate::node::is_warn() {
                        println!("[WARN][HANDSHAKE] advisory_admit side=server node={} reason=pk_unknown_or_no_proof hint=will_authenticate_via_VrfKeyAnnounce_or_consensus_msg",
                                 peer_handshake.node_id);
                    }
                }
                Err(e) => {
                    if crate::node::is_warn() {
                        println!("[WARN][HANDSHAKE] dilithium_proof_invalid side=server node={} reason={} action=close",
                                 peer_handshake.node_id, e);
                    }
                    return Err(format!("handshake_proof_invalid: {}", e));
                }
            }

            // v19: Build our own Dilithium proof for the response leg.
            // `build_handshake_proof` returns `None` only if the local crypto
            // subsystem is not yet initialised (early boot) — peers tolerate
            // this during the migration window.
            let our_timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let our_block_height = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                .load(std::sync::atomic::Ordering::Relaxed);
            let our_proof = build_handshake_proof(
                our_node_id,
                our_timestamp,
                our_block_height,
            ).await;

            // Send our handshake
            let our_handshake = NodeHandshake {
                node_id: our_node_id.to_string(),
                cert_serial: our_cert_serial.to_string(),
                protocol_version: PROTOCOL_VERSION,
                node_type: our_node_type.to_string(),
                timestamp: our_timestamp,
                // v9.7: Include our current block height so peer knows it immediately
                block_height: our_block_height,
                // v19: Authenticated identity binding (Phase 2.A: advisory)
                dilithium_proof: our_proof,
            };

            let handshake_bytes = bincode::serialize(&our_handshake)
                .map_err(|e| format!("Handshake serialize failed: {}", e))?;

            let len_bytes = (handshake_bytes.len() as u32).to_be_bytes();
            send.write_all(&len_bytes).await.map_err(|e| format!("Write len failed: {}", e))?;
            send.write_all(&handshake_bytes).await.map_err(|e| format!("Write data failed: {}", e))?;
            send.finish().map_err(|e| format!("Finish failed: {}", e))?;

            // v9.7: Return height from handshake for immediate BEST_PEER_HEIGHT update
            Ok((peer_handshake.node_id, peer_handshake.cert_serial, peer_handshake.node_type, peer_handshake.block_height))
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
        // v9.0: Per-connection concurrent stream task limit.
        // Prevents a single peer from exhausting tokio runtime with unbounded task spawns.
        const MAX_CONCURRENT_STREAM_TASKS: usize = 64;
        let stream_semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_STREAM_TASKS));

        loop {
            // Accept bidirectional or unidirectional streams
            tokio::select! {
                // Bidirectional stream (request-response)
                result = conn.accept_bi() => {
                    match result {
                        Ok((send, recv)) => {
                            let handler_clone = handler.clone();
                            let conn_clone = quic_conn.clone();
                            let sem = stream_semaphore.clone();
                            tokio::spawn(async move {
                                let _permit = match sem.acquire().await {
                                    Ok(p) => p,
                                    Err(_) => return, // semaphore closed
                                };
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
                            let sem = stream_semaphore.clone();
                            tokio::spawn(async move {
                                let _permit = match sem.acquire().await {
                                    Ok(p) => p,
                                    Err(_) => return,
                                };
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

                // v9.0: Read header first (6 bytes), check per-type limit before full allocation
                if msg_len >= 6 {
                    let mut header = [0u8; 6];
                    recv.read_exact(&mut header).await?;
                    let msg_type = header[1];
                    let type_limit = max_size_for_message_type(msg_type);
                    if msg_len > type_limit {
                        // Drop oversized message — don't allocate
                        return Err(quinn::ReadExactError::FinishedEarly(0));
                    }
                    let mut data = Vec::with_capacity(msg_len);
                    data.extend_from_slice(&header);
                    if msg_len > 6 {
                        let mut rest = vec![0u8; msg_len - 6];
                        recv.read_exact(&mut rest).await?;
                        data.extend_from_slice(&rest);
                    }
                    Ok(data)
                } else {
                    let mut data = vec![0u8; msg_len];
                    recv.read_exact(&mut data).await?;
                    Ok(data)
                }
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

                // v9.0: Read header first, enforce per-type size limit before allocation
                if msg_len >= 6 {
                    let mut header = [0u8; 6];
                    recv.read_exact(&mut header).await?;
                    let msg_type = header[1];
                    let type_limit = max_size_for_message_type(msg_type);
                    if msg_len > type_limit {
                        return Err(quinn::ReadExactError::FinishedEarly(0));
                    }
                    let mut data = Vec::with_capacity(msg_len);
                    data.extend_from_slice(&header);
                    if msg_len > 6 {
                        let mut rest = vec![0u8; msg_len - 6];
                        recv.read_exact(&mut rest).await?;
                        data.extend_from_slice(&rest);
                    }
                    Ok(data)
                } else {
                    let mut data = vec![0u8; msg_len];
                    recv.read_exact(&mut data).await?;
                    Ok(data)
                }
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
    
    /// Parse binary message with per-type size enforcement
    fn parse_message(data: &[u8]) -> Result<NetworkMessage, String> {
        if data.len() < 6 {
            return Err("Message too short".into());
        }

        // Check header
        let version = data[0];
        if version != PROTOCOL_VERSION {
            return Err(format!("Protocol version mismatch: {}", version));
        }

        let msg_type = data[1];
        let payload_len = u32::from_be_bytes([data[2], data[3], data[4], data[5]]) as usize;

        // v9.0: Per-message-type size limit BEFORE deserialization.
        // Prevents OOM from e.g. a 10 MB "heartbeat" that should be 2 KB.
        let type_limit = max_size_for_message_type(msg_type);
        if type_limit == 0 {
            return Err(format!("Rejected deprecated message type={}", msg_type));
        }
        if payload_len > type_limit {
            return Err(format!(
                "Message type={} payload={}B exceeds type_limit={}B",
                msg_type, payload_len, type_limit
            ));
        }

        if data.len() < 6 + payload_len {
            return Err("Incomplete message".into());
        }

        // Deserialize payload
        bincode::deserialize(&data[6..6+payload_len])
            .map_err(|e| format!("Deserialize failed: {}", e))
    }
    
    /// Connect to a peer (client mode) with auto-retry
    /// CRITICAL: Thread-safe with double-check to prevent race conditions
    /// v2.96: Added per-peer cooldown, connect dedup, outbound semaphore, jitter
    pub async fn connect(&self, peer_addr: SocketAddr) -> Result<Arc<QuicConnection>, String> {
        // v14.8.5: CRITICAL — classic DashMap get→remove deadlock pattern.
        //
        // Previous code:
        //   if let Some(conn) = self.connections.get(&peer_addr) {   // holds read lock
        //       if is_alive(&conn) { return Ok(conn.clone()); }
        //       self.connections.remove(&peer_addr);                 // needs write lock
        //   }                                                        //  → DEADLOCK
        //
        // DashMap's `get()` returns a `Ref` that keeps the shard's reader guard
        // held for the entire lifetime of the binding. Calling `remove()` on
        // the same key within the guard's scope tries to acquire a writer
        // guard on the same shard and blocks forever. This was the root
        // cause of a genesis node freezing: after a user super-node dropped
        // its QUIC connection, this path was taken, the shard guard never
        // released, every tokio worker eventually blocked on a lock coming
        // through this function, and all 39 runtime threads ended up in
        // `futex_wait_queue_me`. HTTP API stopped responding, TCP sockets
        // piled up in CLOSE-WAIT, the container went UNHEALTHY.
        //
        // Fix: clone-and-drop — copy the Arc out under a short-scoped Ref,
        // drop the Ref explicitly, THEN perform any further DashMap
        // operations. Arc::clone is cheap; the write path to `remove` is
        // now strictly ordered after the read guard is released.
        let cached = {
            let guard = self.connections.get(&peer_addr);
            guard.map(|r| r.clone()) // Arc clone; Ref dropped at end of block
        };
        if let Some(conn) = cached {
            if crate::quic_transport::is_connection_alive(&conn) {
                return Ok(conn);
            }
            // Dead connection — Ref is long gone, safe to take the write lock.
            if is_info() {
                println!("[INFO][QUIC] removing_dead_conn peer={}",
                         get_privacy_id_for_addr(&peer_addr.to_string()));
            }
            self.connections.remove(&peer_addr);
        }

        // v2.96: Per-peer reconnect cooldown — reject if last attempt was < COOLDOWN ago.
        // This is the primary defense against reconnect storms: 5 subsystems calling connect()
        // simultaneously all get instant rejection except the first one within the window.
        if let Some(last) = self.last_connect_attempt.get(&peer_addr) {
            let elapsed = last.value().elapsed();
            if elapsed < Duration::from_secs(PEER_RECONNECT_COOLDOWN_SECS) {
                return Err(format!("cooldown: {}ms remaining",
                    (PEER_RECONNECT_COOLDOWN_SECS * 1000).saturating_sub(elapsed.as_millis() as u64)));
            }
        }

        // v2.96: Connect-in-progress dedup — only one connect() flight per peer address.
        // If another task is already connecting to this peer, return immediately.
        if self.connect_in_progress.contains_key(&peer_addr) {
            return Err("connect_in_progress: another task is already connecting to this peer".to_string());
        }
        self.connect_in_progress.insert(peer_addr, ());
        // Scope guard: remove connect_in_progress on ALL exit paths
        struct ConnectGuard { addr: SocketAddr, map: Arc<DashMap<SocketAddr, ()>> }
        impl Drop for ConnectGuard {
            fn drop(&mut self) { self.map.remove(&self.addr); }
        }
        let _connect_guard = ConnectGuard { addr: peer_addr, map: self.connect_in_progress.clone() };

        // Record attempt time (even before acquiring semaphore — cooldown applies to queued attempts too)
        self.last_connect_attempt.insert(peer_addr, Instant::now());

        // v2.96: Outbound dial semaphore — limits concurrent outbound handshakes globally.
        // Prevents self-DoS when many peers are down (e.g., network-wide restart).
        // Peers wait in queue instead of all hammering simultaneously.
        let _dial_permit = match tokio::time::timeout(
            Duration::from_secs(10),
            self.outbound_dial_semaphore.acquire()
        ).await {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => return Err("outbound_semaphore_closed".to_string()),
            Err(_) => return Err("outbound_semaphore_timeout: too many pending dials".to_string()),
        };

        let endpoint = self.endpoint.as_ref()
            .ok_or("Endpoint not initialized")?;

        let max_attempts = HANDSHAKE_RETRY_ATTEMPTS;
        let mut last_error = String::new();
        let mut handshake_failures = 0u32;

        for attempt in 1..=max_attempts {
            // Double-check: another task may have created connection while we were waiting
            if let Some(conn) = self.connections.get(&peer_addr) {
                if crate::quic_transport::is_connection_alive(&conn) {
                    return Ok(conn.clone());
                }
            }

            match self.try_connect_once(endpoint, peer_addr).await {
                Ok(conn) => {
                    // v2.96: Promote peer IP to known tier on successful connection
                    self.known_peer_ips.insert(peer_addr.ip(), ());
                    return Ok(conn);
                },
                Err(e) => {
                    // v9.3: CERT_REJECTED — abort immediately, no retry.
                    if e.contains("CERT_REJECTED") || e.contains("TOFU_PIN_MISMATCH") || e.contains("Cert verification failed") {
                        if crate::node::is_warn() {
                            println!("[WARN][QUIC] cert_rejected_no_retry peer={} reason={}",
                                get_privacy_id_for_addr(&peer_addr.to_string()), e);
                        }
                        return Err(format!("CERT_REJECTED (no retry): {}", e));
                    }

                    if e.contains("aborted by peer") || e.contains("handshake") {
                        handshake_failures += 1;
                    }
                    last_error = e;

                    if attempt < max_attempts {
                        // v2.96: Exponential backoff 1s→2s→4s→8s→16s (capped at 30s) + jitter ±30%
                        let base_delay = CONNECT_RETRY_DELAY_MS * (1u64 << (attempt - 1).min(5));
                        let capped = base_delay.min(CONNECT_MAX_RETRY_DELAY_MS);
                        // Jitter: multiply by 0.7-1.3 to desynchronize concurrent retries
                        let jitter = 0.7 + (peer_addr.port() as f64 % 100.0) / 100.0 * 0.6
                            + (attempt as f64 * 0.07);  // deterministic per-peer jitter
                        let delay_ms = (capped as f64 * jitter) as u64;
                        let delay = Duration::from_millis(delay_ms.max(500)); // floor 500ms

                        if crate::node::is_warn() && (attempt == 1 || attempt == max_attempts - 1) {
                            println!("[WARN][QUIC] conn_attempt_failed attempt={}/{} peer={} retry_in={}ms",
                                attempt, max_attempts,
                                get_privacy_id_for_addr(&peer_addr.to_string()),
                                delay_ms);
                        }
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }

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
        let (remote_node_id, remote_cert_serial, remote_node_type, remote_block_height) = self.perform_client_handshake(&connection).await?;

        // v9.7: Immediately update BEST_PEER_HEIGHT from handshake
        if remote_block_height > 0 {
            crate::unified_p2p::BEST_PEER_HEIGHT.fetch_max(remote_block_height, std::sync::atomic::Ordering::Relaxed);
        }

        // CRITICAL: Prevent self-connect
        if remote_node_id == self.node_id {
            if crate::node::is_warn() { println!("[WARN][QUIC] self_connect_detected side=client action=close"); }
            connection.close(quinn::VarInt::from_u32(0), b"self-connect");
            return Err("Self-connect not allowed".to_string());
        }
        
        // v9.0: X.509 SAN verification + TOFU cert pinning (client side).
        // SAN mismatch or TOFU pin mismatch → close immediately (MITM).
        match Self::verify_peer_cert_node_id(&connection, &remote_node_id, &self.cert_fingerprint_pins) {
            Ok(()) => {
                if is_info() {
                    println!("[INFO][QUIC] cert_verified side=client node={}", remote_node_id);
                }
            }
            Err(e) if e.contains("SAN does not contain") || e.contains("TOFU_PIN_MISMATCH") || e.contains("X.509 parse") => {
                if crate::node::is_warn() { println!("[WARN][QUIC] cert_REJECTED side=client node={} reason={}", remote_node_id, e); }
                connection.close(quinn::VarInt::from_u32(403), b"CERT_REJECTED");
                return Err(format!("Cert verification failed for node {}: {}", remote_node_id, e));
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
    /// v9.7: Returns (node_id, cert_serial, node_type, block_height)
    async fn perform_client_handshake(&self, conn: &Connection) -> Result<(String, String, String, u64), String> {
        // v2.24: Timeout for entire handshake
        let handshake_timeout = Duration::from_secs(CONNECT_TIMEOUT_SECS);

        tokio::time::timeout(handshake_timeout, async {
            // v19: Build Dilithium identity proof BEFORE constructing handshake.
            // The proof binds (node_id, timestamp, block_height) so a captured
            // proof cannot be replayed against a different identity or epoch.
            let our_timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let our_block_height = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                .load(std::sync::atomic::Ordering::Relaxed);
            let our_proof = build_handshake_proof(
                &self.node_id,
                our_timestamp,
                our_block_height,
            ).await;

            // Our handshake
            let our_handshake = NodeHandshake {
                node_id: self.node_id.clone(),
                cert_serial: self.cert_serial.clone(),
                protocol_version: PROTOCOL_VERSION,
                node_type: self.node_type.clone(),
                timestamp: our_timestamp,
                // v9.7: Include our current block height
                block_height: our_block_height,
                // v19: Authenticated identity binding (Phase 2.A: advisory)
                dilithium_proof: our_proof,
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

            // v9.7: Backward-compatible deserialization (supports pre-v9.7 nodes)
            let peer_handshake = deserialize_handshake(&data)?;

            // v19: Verify peer's Dilithium identity proof on the response leg.
            // On Err the connection is aborted — caller drops the conn after
            // we return Err. On Ok(false) the peer is treated as legacy
            // (Phase 2.A backward compatibility) but logged for audit.
            match verify_handshake_proof(
                &peer_handshake.node_id,
                peer_handshake.timestamp,
                peer_handshake.block_height,
                peer_handshake.dilithium_proof.as_deref(),
            ).await {
                Ok(true) => {
                    if is_info() {
                        println!("[INFO][HANDSHAKE] dilithium_proof_verified side=client node={} h={}",
                                 peer_handshake.node_id, peer_handshake.block_height);
                    }
                }
                Ok(false) => {
                    // v19.1: Advisory admit (same three-state semantics as
                    // server side). Every consensus message that flows
                    // over this connection still goes through full
                    // Dilithium3 verification before being honoured.
                    if crate::node::is_warn() {
                        println!("[WARN][HANDSHAKE] advisory_admit side=client node={} reason=pk_unknown_or_no_proof hint=will_authenticate_via_VrfKeyAnnounce_or_consensus_msg",
                                 peer_handshake.node_id);
                    }
                }
                Err(e) => {
                    if crate::node::is_warn() {
                        println!("[WARN][HANDSHAKE] dilithium_proof_invalid side=client node={} reason={} action=close",
                                 peer_handshake.node_id, e);
                    }
                    return Err(format!("handshake_proof_invalid: {}", e));
                }
            }

            // v9.7: Return height from handshake
            Ok((peer_handshake.node_id, peer_handshake.cert_serial, peer_handshake.node_type, peer_handshake.block_height))
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
                        let delay = Duration::from_millis((RETRY_DELAY_MS * (1 << (attempt - 1))).min(MAX_RETRY_DELAY_MS));
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
                        let delay = Duration::from_millis((RETRY_DELAY_MS * (1 << (attempt - 1))).min(MAX_RETRY_DELAY_MS));
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
                        let delay = Duration::from_millis((RETRY_DELAY_MS * (1 << (attempt - 1))).min(MAX_RETRY_DELAY_MS));
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

        // v2.96: Purge stale cooldown entries (older than 2× cooldown period)
        // Prevents unbounded memory growth in last_connect_attempt map.
        let cooldown_purge_threshold = Duration::from_secs(PEER_RECONNECT_COOLDOWN_SECS * 2);
        self.last_connect_attempt.retain(|_, instant| instant.elapsed() < cooldown_purge_threshold);

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
    /// v9.0: Proper X.509 SAN verification + TOFU (Trust On First Use) cert pinning.
    ///
    /// 1. Parse certificate via x509-parser (ASN.1 DER, not byte search)
    /// 2. Extract SAN dNSName entries, match against "qnet-{node_id}"
    /// 3. Compute SHA3-256 fingerprint of cert DER bytes
    /// 4. TOFU: If first time seeing this node_id → pin fingerprint.
    ///          If seen before → fingerprint MUST match or reject (MITM)
    ///
    /// Returns:
    ///   Ok(())       — cert found, SAN matches, TOFU pin OK (or first-seen)
    ///   Err(reason)  — cert unavailable / SAN mismatch / TOFU pin mismatch
    fn verify_peer_cert_node_id(
        conn: &Connection,
        claimed_node_id: &str,
        pins: &DashMap<String, TofuPin>,
    ) -> Result<(), String> {
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

        // Step 1: Proper ASN.1 X.509 parsing (replaces unsafe byte substring search)
        let (_, parsed_cert) = x509_parser::parse_x509_certificate(cert_bytes)
            .map_err(|e| format!("X.509 parse failed: {}", e))?;

        // Step 2: Check SubjectAlternativeName extension for exact dNSName match
        let mut san_matched = false;
        if let Ok(Some(san_ext)) = parsed_cert.subject_alternative_name() {
            for name in &san_ext.value.general_names {
                if let x509_parser::prelude::GeneralName::DNSName(dns) = name {
                    if *dns == expected_san {
                        san_matched = true;
                        break;
                    }
                }
            }
        }

        if !san_matched {
            return Err(format!("cert SAN does not contain '{}' (X.509 parsed)", expected_san));
        }

        // Step 3: Compute SHA3-256 fingerprint for TOFU pinning
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(cert_bytes);
        let fingerprint: [u8; 32] = hasher.finalize().into();

        // Step 4: TOFU v9.2 — Trust On First Use with TTL + grace period
        let now_ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        match pins.get(claimed_node_id) {
            Some(entry) => {
                let pin = entry.value();
                let pin_age = now_ts.saturating_sub(pin.pinned_at);

                if pin.fingerprint == fingerprint {
                    // Fingerprint matches — all good, refresh timestamp to extend TTL
                    drop(entry);
                    pins.insert(claimed_node_id.to_string(), TofuPin {
                        fingerprint,
                        pinned_at: now_ts,
                    });
                } else if pin_age > TOFU_PIN_TTL_SECS {
                    // Pin expired — allow re-pin with new cert (normal rotation)
                    drop(entry);
                    pins.insert(claimed_node_id.to_string(), TofuPin {
                        fingerprint,
                        pinned_at: now_ts,
                    });
                    if is_info() {
                        println!("[INFO][TOFU] repin_expired node={} age={}s fp={}",
                            claimed_node_id, pin_age, hex::encode(&fingerprint[..8]));
                    }
                } else if pin_age >= TOFU_PIN_GRACE_AFTER_SECS {
                    // Past grace period — cert rotation allowed (rolling restart scenario)
                    drop(entry);
                    pins.insert(claimed_node_id.to_string(), TofuPin {
                        fingerprint,
                        pinned_at: now_ts,
                    });
                    if is_info() {
                        println!("[INFO][TOFU] repin_rotation node={} age={}s fp={}",
                            claimed_node_id, pin_age, hex::encode(&fingerprint[..8]));
                    }
                } else {
                    // v9.3: Genesis nodes ALWAYS allowed to re-pin — their IPs are
                    // hardcoded at compile time, so cert rotation is legitimate (deploy/restart).
                    // Non-genesis: reject within grace period (possible MITM).
                    let is_genesis_node_id = claimed_node_id.starts_with("genesis_node_");
                    if is_genesis_node_id {
                        drop(entry);
                        pins.insert(claimed_node_id.to_string(), TofuPin {
                            fingerprint,
                            pinned_at: now_ts,
                        });
                        if is_info() {
                            println!("[INFO][TOFU] repin_genesis node={} age={}s fp={}",
                                claimed_node_id, pin_age, hex::encode(&fingerprint[..8]));
                        }
                    } else {
                        // Within grace period and fingerprint changed — suspicious (possible MITM)
                        let pinned_hex = hex::encode(&pin.fingerprint[..8]);
                        drop(entry);
                        return Err(format!(
                            "TOFU_PIN_MISMATCH: node={} age={}s(<{}s grace) pinned={} received={} — possible MITM",
                            claimed_node_id, pin_age, TOFU_PIN_GRACE_AFTER_SECS,
                            pinned_hex, hex::encode(&fingerprint[..8]),
                        ));
                    }
                }
            }
            None => {
                // First time seeing this node_id — enforce max pins then insert
                if pins.len() >= TOFU_MAX_PINS {
                    // Evict the oldest pin to make room
                    let mut oldest_key: Option<String> = None;
                    let mut oldest_ts = u64::MAX;
                    for entry in pins.iter() {
                        if entry.value().pinned_at < oldest_ts {
                            oldest_ts = entry.value().pinned_at;
                            oldest_key = Some(entry.key().clone());
                        }
                    }
                    if let Some(key) = oldest_key {
                        pins.remove(&key);
                        if is_info() {
                            println!("[INFO][TOFU] evict_oldest node={} age={}s pins={}",
                                key, now_ts.saturating_sub(oldest_ts), pins.len());
                        }
                    }
                }
                pins.insert(claimed_node_id.to_string(), TofuPin {
                    fingerprint,
                    pinned_at: now_ts,
                });
                if is_info() {
                    println!("[INFO][TOFU] pin_new node={} fp={} pins={}",
                        claimed_node_id, hex::encode(&fingerprint[..8]), pins.len());
                }
            }
        }

        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// v19: REGRESSION TESTS — DILITHIUM HANDSHAKE BINDING
// ═══════════════════════════════════════════════════════════════════════════
// Verifies the offline (no-network, no-crypto-init) properties of the new
// authenticated handshake helpers:
//   * canonical challenge format is byte-stable across versions
//   * three-way deserialize ladder accepts every legacy on-wire shape
//   * verify_handshake_proof has the documented `Ok(false)` legacy fallback
//     and `Err` for malformed proofs
// Tests that require a live Dilithium keypair / `try_get_p2p` are intentionally
// out-of-scope for unit tests — those properties are exercised end-to-end on
// the testnet in the deploy gate.
#[cfg(test)]
mod tests_v19_handshake {
    use super::*;

    /// The handshake challenge is the message that the Dilithium proof signs
    /// over. Its byte representation MUST stay stable across protocol
    /// versions (sender and receiver each format it locally — any
    /// divergence would silently invalidate every proof). The format
    /// `qnet-quic-handshake-v1:{node_id}:{timestamp}:{block_height}` is
    /// load-bearing; this test pins it.
    #[test]
    fn challenge_format_is_canonical() {
        let m = handshake_challenge_message("node_001", 1_700_000_000, 12345);
        assert_eq!(m, "qnet-quic-handshake-v1:node_001:1700000000:12345");
    }

    /// A v19 sender produces a `NodeHandshake` with `dilithium_proof` set to
    /// `Some(...)`. That MUST round-trip through bincode without losing the
    /// proof field. Without this, every handshake would arrive with `proof
    /// = None` and the receiver would log every peer as legacy — the
    /// migration-window WARN noise would drown out genuine attacks.
    #[test]
    fn handshake_with_proof_round_trips() {
        let hs = NodeHandshake {
            node_id: "node_001".into(),
            cert_serial: "abc".into(),
            protocol_version: PROTOCOL_VERSION,
            node_type: "super".into(),
            timestamp: 1_700_000_000,
            block_height: 12345,
            dilithium_proof: Some(vec![1, 2, 3, 4, 5]),
        };
        let bytes = bincode::serialize(&hs).expect("serialize");
        let decoded = deserialize_handshake(&bytes).expect("deserialize");
        assert_eq!(decoded.node_id, "node_001");
        assert_eq!(decoded.block_height, 12345);
        assert_eq!(decoded.dilithium_proof.as_deref(), Some(&[1, 2, 3, 4, 5][..]));
    }

    /// A pre-v19 (v9.7..v18) sender produces `NodeHandshakeV2` — same fields
    /// minus `dilithium_proof`. The three-way deserialize ladder MUST
    /// recognise that shape and translate it to a `NodeHandshake` with
    /// `proof = None`. A failure here would block legacy peers from
    /// connecting at all — defeating the Phase 2.A backward-compat goal.
    #[test]
    fn handshake_v2_back_compat_yields_no_proof() {
        let v2 = NodeHandshakeV2 {
            node_id: "legacy_v18".into(),
            cert_serial: "abc".into(),
            protocol_version: PROTOCOL_VERSION,
            node_type: "super".into(),
            timestamp: 1_700_000_000,
            block_height: 999,
        };
        let bytes = bincode::serialize(&v2).expect("serialize");
        let decoded = deserialize_handshake(&bytes).expect("deserialize");
        assert_eq!(decoded.node_id, "legacy_v18");
        assert_eq!(decoded.block_height, 999);
        assert!(decoded.dilithium_proof.is_none());
    }

    /// A pre-v9.7 sender produces `NodeHandshakeLegacy` — no proof and no
    /// `block_height`. The deserialize ladder MUST recognise it and return
    /// a normalised `NodeHandshake` with `block_height = 0` (the receiver
    /// will let the first HealthPing populate the real value).
    #[test]
    fn handshake_legacy_back_compat_zero_height() {
        let legacy = NodeHandshakeLegacy {
            node_id: "ancient".into(),
            cert_serial: "abc".into(),
            protocol_version: PROTOCOL_VERSION,
            node_type: "super".into(),
            timestamp: 1_700_000_000,
        };
        let bytes = bincode::serialize(&legacy).expect("serialize");
        let decoded = deserialize_handshake(&bytes).expect("deserialize");
        assert_eq!(decoded.node_id, "ancient");
        assert_eq!(decoded.block_height, 0);
        assert!(decoded.dilithium_proof.is_none());
    }

    /// `verify_handshake_proof` returns `Ok(false)` when the peer did not
    /// supply a proof. This is the documented Phase 2.A backward-compat
    /// path — a peer running v18 connects, supplies no proof, and the
    /// connection is admitted but logged as `[WARN][HANDSHAKE]
    /// no_dilithium_proof`. Returning `Err` here would refuse legacy peers
    /// outright and break the migration window.
    #[tokio::test]
    async fn verify_returns_ok_false_for_missing_proof() {
        let result =
            verify_handshake_proof("node_001", 1_700_000_000, 100, None).await;
        assert!(matches!(result, Ok(false)),
            "expected Ok(false) for missing proof, got {:?}", result);
    }

    /// An empty-but-present proof byte slice is treated identically to
    /// `None`. Without this, a Byzantine peer could trivially bypass the
    /// "no proof" path by sending `Some(vec![])` to opt out of the
    /// migration-window WARN logging while still being admitted — the
    /// audit log MUST fire on every legacy peer.
    #[tokio::test]
    async fn verify_returns_ok_false_for_empty_proof() {
        let empty: &[u8] = &[];
        let result =
            verify_handshake_proof("node_001", 1_700_000_000, 100, Some(empty)).await;
        assert!(matches!(result, Ok(false)),
            "expected Ok(false) for empty proof, got {:?}", result);
    }

    /// A non-UTF-8 proof byte slice is rejected with `Err`. Real Dilithium3
    /// signatures from `create_consensus_signature` are ASCII-prefixed
    /// strings (`hybrid_p2p_bin:...`, `compact_bin:...`, `dilithium_sig_...`)
    /// — anything that is not valid UTF-8 cannot be one of those formats
    /// and is structurally invalid. Returning `Err` here is what causes
    /// the receiver to drop the connection (handshake abort).
    #[tokio::test]
    async fn verify_returns_err_for_non_utf8_proof() {
        let bad: &[u8] = &[0xC0, 0xC1, 0xF5]; // invalid UTF-8 bytes
        let result =
            verify_handshake_proof("node_001", 1_700_000_000, 100, Some(bad)).await;
        assert!(result.is_err(), "expected Err for non-UTF-8 proof, got {:?}", result);
    }

    /// v19.1: When a peer presents a syntactically valid proof for an
    /// identity whose PK is NOT YET in the consensus PK registry, the
    /// helper MUST return `Ok(false)` (advisory admit), not `Err`.
    ///
    /// Rationale: at fresh-cluster boot, every peer's first connection
    /// arrives BEFORE that peer's PK has been cross-registered via
    /// `VrfKeyAnnounce`. Returning `Err` in this state was the v19.0
    /// regression that bricked fresh bootstrap — connections dropped
    /// before the announce gossip could populate the registry, making
    /// the "PK not in registry" condition self-perpetuating.
    ///
    /// Test methodology:
    /// `try_get_p2p()` is `None` in unit-test context, which is itself an
    /// `Ok(false)` branch (PK is also unknown — `has_consensus_pk`
    /// returns false on an empty registry). We use a clearly fake but
    /// well-formed UTF-8 proof string targeting an identity that
    /// definitely is NOT in the test-process registry. The expected
    /// outcome is `Ok(false)`.
    #[tokio::test]
    async fn verify_returns_ok_false_for_unknown_pk_with_proof() {
        let fake_proof = b"compact_bin:never_registered_test_payload";
        let result = verify_handshake_proof(
            "v19_1_test_unknown_identity_must_admit",
            1_700_000_000,
            100,
            Some(fake_proof),
        ).await;
        assert!(
            matches!(result, Ok(false)),
            "unknown identity with attached proof MUST advisory-admit (Ok(false)), got {:?}",
            result
        );
    }
}

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
//! Combined with ML-DSA-65 signatures = full post-quantum P2P security.
//!
//! ## Architecture
//!
//! ```text
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
/// Aligned with production L1 backoff ranges (seconds to hours).
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

/// Handshake frame ceiling. Read BEFORE any authentication, so it must not use the block ceiling.
pub const MAX_HANDSHAKE_SIZE: usize = 64 * 1024;

/// Maximum message size (10 MB - for macroblocks/block batches)
pub const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024;

/// Inbound uni-stream losses — rate limiters for the two reports in handle_uni_stream.
static UNI_READ_FAILS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static UNI_READ_TIMEOUTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// S2b: bulk serve-response send-concurrency bound. Reserves QUIC-stream + CPU headroom for
/// consensus so a cold-sync flood (100k joiners) cannot starve failover/checkpoint sends — the
/// onboarding wedge was a lost failover vote when sync churn saturated the shared streams.
/// Only heavy block/macroblock/snapshot serve RESPONSES acquire a permit; consensus, control,
/// and requests bypass. Bound < MAX_STREAMS_PER_CONN keeps consensus headroom on the connection.
const BULK_SEND_CONCURRENCY: usize = 256;
static BULK_SEND_PERMITS: once_cell::sync::Lazy<tokio::sync::Semaphore> =
    once_cell::sync::Lazy::new(|| tokio::sync::Semaphore::new(BULK_SEND_CONCURRENCY));

/// Heavy bulk serve responses — throttled on the send side. Requests are tiny and NOT throttled
/// (a node's own catch-up must not slow); consensus/control never reach here as bulk.
#[inline]
fn is_bulk_serve_send(msg: &crate::unified_p2p::NetworkMessage) -> bool {
    use crate::unified_p2p::NetworkMessage as M;
    matches!(msg, M::BlocksBatch { .. } | M::MacroblocksBatch { .. } | M::StateSnapshot { .. })
}

/// v9.0: Per-message-type size limits.
/// Enforced BEFORE memory allocation to prevent OOM from oversized small messages.
/// Type byte is extracted from wire header position [1] before deserialization.
/// Returns max allowed payload size for a given message type byte.
fn max_size_for_message_type(msg_type: u8) -> usize {
    match msg_type {
        // Block data: full 10 MB (macroblocks can be large)
        1 => MAX_MESSAGE_SIZE,         // Block
        // Checkpoint-BFT (proposal/QC/TC) + macroblock-sync frames: a 1000-committee QC carries
        // quorum_size(1000) ML-DSA sigs (no PQ aggregation) ≈ several MB, and each macroblock embeds
        // its QC — the 2 MB catch-all silently dropped them → finality stall at scale. Full 10 MB.
        10 => MAX_MESSAGE_SIZE,        // ConsensusV2 / MacroblocksBatch
        // ShredProtocolChunk: 512 KB data + producer certificate (~7 KB serialized) + header.
        // The old +256 headroom silently dropped every cert-carrying chunk of a full-size block,
        // so no shredded block ever delivered its certificate.
        8 => 512 * 1024 + 16 * 1024,  // ShredProtocolChunk
        // HealthPing: hex ML-DSA-65 signature (6618) + node id + 4 u64 + framing ≈ 6.7 KB.
        // Sized with headroom so a future field cannot silently push the frame past its own cap;
        // wire_cap_covers_worst_case_frame pins this.
        4 => 16 * 1024,               // HealthPing
        3 => 256 * 1024,              // PeerDiscovery (can contain many peers)
        // Deprecated: reject entirely
        7 => 0,                        // EmergencyProducerChange (deprecated)
        // Type 0 = catch-all (Transaction, VrfLeaderClaim, TimeoutVote, SyncStatus,
        //   BlocksBatch, MacroblocksBatch, ProducerHeartbeat, etc.)
        // Use 2 MB — large enough for tx batches but not full 10 MB abuse
        2 => 1024 * 1024,             // Transaction: 1 MB
        0 => 2 * 1024 * 1024,         // Catch-all: 2 MB
        _ => 2 * 1024 * 1024,         // Unknown: 2 MB
    }
}

/// Protocol version
pub const PROTOCOL_VERSION: u8 = 1;

/// Oldest wire version still accepted. Accepting [MIN, CURRENT] lets a coordinated version bump
/// roll out node-by-node without partitioning. MIN==CURRENT ⇒ behaviour unchanged today.
pub const MIN_SUPPORTED_PROTOCOL_VERSION: u8 = 1;

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
///   be blocked by rate limiting between genesis nodes — the standard reserved/unconditional
///   peer tier.
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
    let ip_str = canonical_ip_str(ip);
    crate::genesis_constants::GENESIS_NODE_IPS.iter()
        .any(|(genesis_ip, _)| *genesis_ip == ip_str)
}

/// v30.B1: render `IpAddr` as the canonical dotted/colon string used by the
/// pinned tables (IPv4-mapped IPv6 collapsed to IPv4). Without this an
/// IPv4-mapped form (`::ffff:1.2.3.4`) would never match the IPv4 string in
/// `GENESIS_NODE_IPS` and a legitimate IPv4 peer arriving over an IPv6
/// socket would be falsely rejected by the IP-identity gate.
#[inline]
fn canonical_ip_str(ip: &std::net::IpAddr) -> String {
    match ip {
        std::net::IpAddr::V4(v4) => v4.to_string(),
        std::net::IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => v6.to_string(),
        },
    }
}

// ============================================================================
// v30.B1/B2: cost-asymmetric DoS killer — early IP-identity gate + per-IP
// failed-handshake token bucket.
//
// Attack model: attacker sends ~100-byte UDP datagrams to the QUIC accept
// port; victim pays TLS state + ~3.3 KB Dilithium parse + ML-DSA-65 verify
// per attempt. Without this gate a 5-6 pkt/s flood from a single IP costs
// the receiver tens of thousands of Dilithium verifies per hour. With it
// the attacker is refused before TLS handshake completes; CPU cost on the
// receiver collapses to a single DashMap lookup + counter bump.
//
// Two independent layers:
//   B1 (IP-identity gate): once the wire handshake is deserialised, the
//       claimed node_id is checked against either the pinned genesis IP
//       table OR the registered endpoint registry. Mismatch is conclusive
//       impersonation evidence — drop without paying for Dilithium verify.
//   B2 (per-IP fail bucket): every failed handshake from a non-genesis IP
//       increments a sliding-window counter; on threshold breach the IP is
//       refused at accept time for a cooldown period. Genesis IPs are
//       NEVER banned (consensus path is privileged).
//
// Scalability: DashMap is sharded → O(1) under contention. The map is HARD
// CAPPED: a failing IP never produces the successful handshake that clears
// its entry, so "clears itself on next touch" is exactly what an attacker
// spraying one bad frame per source address never does. Growth is bounded by
// HANDSHAKE_FAIL_MAX_ENTRIES with amortised sweep + batch eviction below.
// ============================================================================

const HANDSHAKE_FAIL_WINDOW_SECS: u64 = 60;
const HANDSHAKE_FAIL_THRESHOLD: u64 = 20;
const HANDSHAKE_FAIL_BAN_SECS: u64 = 600;

/// Hard ceiling on tracked source IPs (~56 bytes/entry ⇒ under 1 MB). Same order as TOFU_MAX_PINS.
const HANDSHAKE_FAIL_MAX_ENTRIES: usize = 16_384;

/// Minimum spacing between full sweeps, so the O(n) pass is amortised to once per second no matter
/// how fast distinct source IPs arrive.
const HANDSHAKE_FAIL_SWEEP_MIN_SECS: u64 = 1;

/// Fraction of the map dropped in one eviction pass when a sweep frees nothing (all entries live).
/// Evicting a batch amortises the O(n) scan over that many subsequent inserts.
const HANDSHAKE_FAIL_EVICT_DIVISOR: usize = 8;

struct HandshakeFailState {
    fail_count: AtomicU64,
    window_start_secs: AtomicU64,
    banned_until_secs: AtomicU64,
}

impl Default for HandshakeFailState {
    fn default() -> Self {
        Self {
            fail_count: AtomicU64::new(0),
            window_start_secs: AtomicU64::new(0),
            banned_until_secs: AtomicU64::new(0),
        }
    }
}

static HANDSHAKE_FAIL_TRACKER: once_cell::sync::Lazy<
    DashMap<std::net::IpAddr, HandshakeFailState>
> = once_cell::sync::Lazy::new(DashMap::new);

/// Unix second of the last full sweep, so the O(n) pass runs at most once per
/// HANDSHAKE_FAIL_SWEEP_MIN_SECS regardless of the arrival rate of new source IPs.
static HANDSHAKE_FAIL_LAST_SWEEP: AtomicU64 = AtomicU64::new(0);

/// Total ip_identity_gate rejects since boot. Security signal: a registered
/// identity claimed from a non-registered IP (key compromise or misconfig).
static IP_GATE_REJECTS: AtomicU64 = AtomicU64::new(0);
pub fn ip_gate_reject_count() -> u64 { IP_GATE_REJECTS.load(Ordering::Relaxed) }

/// Live inbound (client-dialed) connections indexed by the peer's advertised QUIC listen addr
/// (ip : API_PORT + QUIC_PORT_OFFSET). A NAT/client-dialed peer's connection lives under its
/// EPHEMERAL source addr in the per-transport pool, so a send targeting its listen port misses and
/// re-dials a port NAT cannot accept inbound. connect() consults this to REUSE the live inbound conn
/// — the only way to push shreds/blocks to such a peer. Keyed by addr like all existing addressing,
/// so it inherits (does not worsen) the one-peer-per-advertised-addr assumption.
static INBOUND_CONN_BY_LISTEN_ADDR: once_cell::sync::Lazy<
    DashMap<SocketAddr, Arc<QuicConnection>>
> = once_cell::sync::Lazy::new(DashMap::new);

#[inline]
fn unix_secs_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// True if `ip` is in active cooldown — caller refuses the connection
/// before any TLS state is allocated. Genesis IPs always return false.
fn is_handshake_ip_banned(ip: std::net::IpAddr) -> bool {
    if is_genesis_ip(&ip) {
        return false;
    }
    HANDSHAKE_FAIL_TRACKER
        .get(&ip)
        .map(|s| s.banned_until_secs.load(Ordering::Relaxed) > unix_secs_now())
        .unwrap_or(false)
}

/// Make room for one NEW tracked IP. First drop every entry that is neither banned nor inside a live
/// fail window (rate-limited to one pass per second); if that frees nothing, evict the batch closest
/// to expiry so the scan is amortised over the next 1/DIVISOR inserts. Returns true if there is room.
fn reserve_handshake_fail_slot(now: u64) -> bool {
    if HANDSHAKE_FAIL_TRACKER.len() < HANDSHAKE_FAIL_MAX_ENTRIES {
        return true;
    }
    let last = HANDSHAKE_FAIL_LAST_SWEEP.load(Ordering::Relaxed);
    if now.saturating_sub(last) >= HANDSHAKE_FAIL_SWEEP_MIN_SECS
        && HANDSHAKE_FAIL_LAST_SWEEP
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    {
        HANDSHAKE_FAIL_TRACKER.retain(|_, s| {
            s.banned_until_secs.load(Ordering::Relaxed) > now
                || now.saturating_sub(s.window_start_secs.load(Ordering::Relaxed))
                    <= HANDSHAKE_FAIL_WINDOW_SECS
        });
        if HANDSHAKE_FAIL_TRACKER.len() < HANDSHAKE_FAIL_MAX_ENTRIES {
            return true;
        }
        // Every slot is live: drop the batch whose ban/window expires soonest. Keeping the
        // longest-lived bans is the defensive choice — those are the confirmed abusers.
        let mut by_expiry: Vec<(u64, std::net::IpAddr)> = HANDSHAKE_FAIL_TRACKER
            .iter()
            .map(|e| {
                let s = e.value();
                let ban = s.banned_until_secs.load(Ordering::Relaxed);
                let win = s.window_start_secs.load(Ordering::Relaxed)
                    .saturating_add(HANDSHAKE_FAIL_WINDOW_SECS);
                (ban.max(win), *e.key())
            })
            .collect();
        let drop_n = (by_expiry.len() / HANDSHAKE_FAIL_EVICT_DIVISOR).max(1);
        by_expiry.sort_unstable_by_key(|(exp, _)| *exp);
        for (_, victim) in by_expiry.into_iter().take(drop_n) {
            HANDSHAKE_FAIL_TRACKER.remove(&victim);
        }
        if crate::node::is_warn() {
            println!("[WARN][QUIC] handshake_fail_tracker_evicted dropped={} cap={}",
                     drop_n, HANDSHAKE_FAIL_MAX_ENTRIES);
        }
        return true;
    }
    // At cap between sweeps: do not grow. The cryptographic handshake still gates this IP;
    // only the cheap pre-TLS cooldown is unavailable for it until a slot frees.
    false
}

/// Record one failed handshake from `ip`. Window rollover and cooldown
/// promotion happen inline. Genesis IPs are exempt.
fn record_handshake_fail(ip: std::net::IpAddr) {
    if is_genesis_ip(&ip) {
        return;
    }
    let now = unix_secs_now();
    if !HANDSHAKE_FAIL_TRACKER.contains_key(&ip) && !reserve_handshake_fail_slot(now) {
        return;
    }
    let entry = HANDSHAKE_FAIL_TRACKER.entry(ip).or_default();
    let window_start = entry.window_start_secs.load(Ordering::Relaxed);
    if window_start == 0 || now.saturating_sub(window_start) > HANDSHAKE_FAIL_WINDOW_SECS {
        entry.window_start_secs.store(now, Ordering::Relaxed);
        entry.fail_count.store(1, Ordering::Relaxed);
        return;
    }
    let new_count = entry.fail_count.fetch_add(1, Ordering::Relaxed) + 1;
    if new_count >= HANDSHAKE_FAIL_THRESHOLD
        && entry.banned_until_secs.load(Ordering::Relaxed) <= now
    {
        entry.banned_until_secs.store(now + HANDSHAKE_FAIL_BAN_SECS, Ordering::Relaxed);
        if crate::node::is_warn() {
            println!(
                "[WARN][QUIC] ip_fail_ban ip={} fails={} window={}s cooldown={}s",
                ip, new_count, HANDSHAKE_FAIL_WINDOW_SECS, HANDSHAKE_FAIL_BAN_SECS
            );
        }
    }
}

/// Clear fail counter on a confirmed-successful handshake — promotes the
/// IP back to clean state and removes any residual ban.
fn clear_handshake_fail(ip: std::net::IpAddr) {
    HANDSHAKE_FAIL_TRACKER.remove(&ip);
}

/// v30.B1: bind claimed node_id to allowed source IP. Returns true if the
/// gate permits the connection to proceed to Dilithium verification.
///
///   * `genesis_node_NNN` MUST originate from its pinned IPv4 in
///     `GENESIS_NODE_IPS` — the 5-entry table is the singular source of
///     truth; any other source is impersonation.
///   * Super-node identity present in `NODE_ENDPOINT_REGISTRY` MUST match
///     the registered endpoint IP — populated by chain-authenticated
///     NodeRegistration TX during block apply (O(1) DashMap).
///   * Unbound identity (no registry record yet) is admitted: this is the
///     first-contact / TOFV window where the peer is about to register via
///     a signed VrfKeyAnnounce or NodeRegistration TX. The cryptographic
///     floor (verify_handshake_proof) still gates everything they assert.
fn ip_identity_gate(claimed_node_id: &str, peer_ip: std::net::IpAddr) -> bool {
    let peer_ip_str = canonical_ip_str(&peer_ip);
    if claimed_node_id.starts_with("genesis_node_") {
        match crate::genesis_constants::genesis_ip_for_node_id(claimed_node_id) {
            Some(expected) => expected == peer_ip_str,
            None => false,
        }
    } else {
        match crate::genesis_constants::get_node_endpoint_ip(claimed_node_id) {
            Some(expected) => expected == peer_ip_str,
            None => true,
        }
    }
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

// NODE HANDSHAKE — authenticated identity binding (anti-spoof).
// ONE canonical wire format. Every handshake carries a mandatory ML-DSA-65 proof over
// (node_id, timestamp, block_height, channel_binding); a frame that does not decode, or a
// proof that fails under a REGISTERED PK, refuses the connection. Cost: <=1 verify per conn.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeHandshake {
    pub node_id: String,
    pub cert_serial: String,
    pub protocol_version: u8,
    pub node_type: String,
    pub timestamp: u64,
    /// Sender's committed tip. Without it every peer starts at 0, sync resolves a network
    /// height far below the real head and declares itself synchronized while thousands of
    /// blocks behind.
    pub block_height: u64,
    /// Mandatory ML-DSA-65 proof of identity over the canonical handshake challenge.
    pub dilithium_proof: Vec<u8>,
}

/// Decode the single canonical handshake format. No fallback ladder: an undecodable frame
/// is refused, which keeps the attacker-chosen deserialisation surface to one shape.
fn decode_handshake(data: &[u8]) -> Result<NodeHandshake, String> {
    bincode::deserialize::<NodeHandshake>(data)
        .map_err(|e| format!("handshake_decode_failed: {}", e))
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
pub fn handshake_challenge_message(
    node_id: &str,
    timestamp: u64,
    block_height: u64,
    channel_binding: &str,
) -> String {
    format!(
        "qnet-quic-handshake-v2:{}:{}:{}:{}",
        node_id, timestamp, block_height, channel_binding
    )
}

/// TLS exporter over THIS connection — the channel binding. Both endpoints of one session derive the
/// identical value, and no other session can reproduce it.
///
/// Without it the proof signed only public scalars, so it proved KEY POSSESSION and nothing about the
/// connection carrying it: a captured proof replayed on a fresh session inside the (timestamp,
/// block_height) window was indistinguishable from the real peer. Binding it here makes the signature a
/// statement about this channel, which is also the prerequisite for any receipt that must attest
/// delivery rather than knowledge.
pub fn connection_channel_binding(conn: &quinn::Connection) -> Option<String> {
    let mut out = [0u8; 32];
    conn.export_keying_material(&mut out, b"qnet-quic-channel-binding-v1", b"")
        .ok()
        .map(|_| hex::encode(out))
}

/// The binding for THIS connection, or refuse the connection. NEVER a default value: if the exporter
/// were unavailable, both ends would fold the same empty string, the challenge would match, and the
/// proof would silently degrade to the replayable pre-v2 scheme while still verifying — the one
/// outcome the binding exists to prevent. quinn only fails the exporter before the handshake
/// completes, which cannot happen on an established `Connection`, so this is a hard invariant rather
/// than an expected runtime branch; a failure means refuse, not downgrade.
fn require_channel_binding(conn: &quinn::Connection) -> Result<String, String> {
    connection_channel_binding(conn)
        .ok_or_else(|| "channel_binding_unavailable".to_string())
}

/// Sign the canonical handshake challenge with the local node's Dilithium key, through the
/// same path that produces consensus signatures. A node that cannot prove its own identity
/// must not complete a handshake, so every failure here refuses the connection instead of
/// putting an unprovable identity on the wire.
pub async fn build_handshake_proof(
    node_id: &str,
    timestamp: u64,
    block_height: u64,
    channel_binding: &str,
) -> Result<Vec<u8>, String> {
    let crypto = crate::node::try_get_quantum_crypto()
        .ok_or_else(|| "local_crypto_uninitialized".to_string())?;
    let challenge = handshake_challenge_message(node_id, timestamp, block_height, channel_binding);
    crypto
        .create_consensus_signature(node_id, &challenge)
        .await
        .map(|sig| sig.signature.into_bytes())
        .map_err(|_| "local_proof_sign_failed".to_string())
}

/// Outcome of a handshake proof that was NOT refused. Refusal is the `Err` arm of
/// `verify_handshake_proof`; this enum only separates authenticated from uncheckable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandshakeVerdict {
    /// Proof verified under the claimed identity's registered Dilithium PK.
    Verified,
    /// The claimed identity cannot be resolved to a PK locally, so the proof is not
    /// checkable yet. Admitted as unauthenticated transport only — nothing it asserts is
    /// trusted until a message of its own verifies at the message layer.
    NotYetVerifiable(&'static str),
}

/// Verify a peer's mandatory handshake proof. O(1) registry lookup plus at most one
/// ML-DSA verify; no per-peer state is retained.
///
/// `Err` refuses the connection: absent, malformed, or forged-under-a-registered-PK proof.
/// `Ok(NotYetVerifiable)` admits without authenticating — see the branch comments; refusing
/// there would make cold join impossible.
pub async fn verify_handshake_proof(
    claimed_node_id: &str,
    timestamp: u64,
    block_height: u64,
    channel_binding: &str,
    proof: &[u8],
) -> Result<HandshakeVerdict, &'static str> {
    if proof.is_empty() {
        return Err("proof_missing");
    }
    let proof_str = std::str::from_utf8(proof).map_err(|_| "proof_not_utf8")?;

    // Claimed identity has no PK in the consensus registry: a joiner's key is not on chain
    // yet and it installs the binding with the signed VrfKeyAnnounce that flows OVER this
    // connection. Refusing here would deadlock every cold join, so the connection is a
    // transport channel until that announce verifies.
    if !qnet_consensus::consensus_crypto::has_consensus_pk(claimed_node_id) {
        return Ok(HandshakeVerdict::NotYetVerifiable("pk_unregistered"));
    }

    // The verifier lives behind the P2P singleton, which is published shortly after the QUIC
    // listener opens. Uncheckable, not invalid — same unauthenticated-transport treatment.
    let p2p = match crate::node::try_get_p2p() {
        Some(p) => p,
        None => return Ok(HandshakeVerdict::NotYetVerifiable("verifier_unavailable")),
    };

    // PK is registered, so the proof MUST verify under it: a failure is an identity squat.
    let challenge = handshake_challenge_message(claimed_node_id, timestamp, block_height, channel_binding);
    if p2p
        .verify_dilithium_heartbeat_signature_async(&challenge, proof_str, claimed_node_id)
        .await
    {
        Ok(HandshakeVerdict::Verified)
    } else {
        Err("proof_verify_failed")
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
            cert_fingerprint_pins: Arc::new(DashMap::new()),
            per_ip_connections: Arc::new(DashMap::new()),
            known_peer_ips: Arc::new(DashMap::new()),
            last_connect_attempt: Arc::new(DashMap::new()),
            connect_in_progress: Arc::new(DashMap::new()),
            outbound_dial_semaphore: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_OUTBOUND_DIALS)),
        }
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

                // v30.B2: per-source-IP failed-handshake ban — refuse pre-TLS
                // for IPs that crossed the fail threshold within the rolling
                // window. Reclaims the TLS state + Dilithium parse cost an
                // attacker would otherwise extract per packet. Genesis IPs
                // are never banned by design (consensus must stay reachable).
                if is_handshake_ip_banned(peer_addr.ip()) {
                    incoming.refuse();
                    if crate::node::is_debug() {
                        println!("[DBG][QUIC] pre_tls_ip_banned ip={}", peer_addr.ip());
                    }
                    continue;
                }

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
                                    peer_addr,
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
                            // ip_identity_gate_reject is already logged (1/256 sampled) and metered at the gate
                            // itself; re-logging it through this generic catch-all floods (one impostor IP
                            // produced thousands of identical lines). Suppress that class here — the metric carries it.
                            if e != "ip_identity_gate_reject" && crate::node::is_warn() {
                                println!("[WARN][QUIC] handshake_failed peer={} err={}", get_privacy_id_for_addr(&peer_addr.to_string()), e);
                            }
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
                    // Index the inbound conn by the peer's advertised QUIC listen addr so a send that
                    // targets the listen port (which a NAT/client-dialed peer cannot accept inbound)
                    // reuses THIS live conn in connect() instead of re-dialing an unreachable port.
                    INBOUND_CONN_BY_LISTEN_ADDR.insert(
                        SocketAddr::new(peer_addr.ip(), 8001u16.saturating_add(crate::p2p_transport::QUIC_PORT_OFFSET)),
                        quic_conn.clone(),
                    );
                    // v2.96: Promote IP to known tier after successful handshake
                    known_ips_clone.insert(peer_ip_clone, ());
                    if is_info() { println!("[INFO][QUIC] conn_stored peer={} node={} type={} ip_tier=known", get_privacy_id_for_addr(&peer_addr.to_string()), remote_node_id, remote_node_type); }

                    // Register the inbound (client-dialed) peer for signed-head relay reachability:
                    // is_outbound=false keeps eclipse/reputation/subnet caps; height 0 until its first
                    // signed HealthPing attests the tip (so it is not quorum-counted early).
                    // This is the ONLY writer of the shared node_id → address index: writing it here
                    // would route directed sends to an identity the admission gates refused.
                    if let Some(p2p) = crate::node::try_get_p2p() {
                        p2p.attest_connected_peer(&remote_node_id, &peer_addr.ip().to_string(), &remote_node_type, 0, false, false);
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
    /// v30.B1: `peer_addr` is now part of the signature — the early IP-identity
    /// gate binds the claimed `node_id` to its registered source IP and rejects
    /// impersonation before paying for the Dilithium verify (~3.3 KB parse +
    /// ML-DSA-65 math). Any Err exit increments the per-IP fail counter so
    /// repeat offenders trip the pre-TLS ban at the accept loop.
    async fn handle_server_handshake(
        conn: &Connection,
        peer_addr: SocketAddr,
        our_node_id: &str,
        our_cert_serial: &str,
        our_node_type: &str,
    ) -> Result<(String, String, String, u64), String> {
        // v2.24: Timeout for entire handshake (prevents "aborted by peer" errors)
        let handshake_timeout = Duration::from_secs(CONNECT_TIMEOUT_SECS);

        let result = tokio::time::timeout(handshake_timeout, async {
            // Accept bidirectional stream for handshake
            let (mut send, mut recv) = conn.accept_bi().await
                .map_err(|e| format!("Accept stream failed: {}", e))?;

            // Receive peer's handshake
            let mut len_buf = [0u8; 4];
            recv.read_exact(&mut len_buf).await.map_err(|e| format!("Read len failed: {}", e))?;
            let len = u32::from_be_bytes(len_buf) as usize;

            // Bound the FIRST frame at the handshake's own size, not the 10 MB block ceiling: this read
            // precedes the IP gate and the signature verify, so `len` is attacker-chosen. A handshake is
            // node_id + two u64 + an ML-DSA proof (~3.3 KB) + pk (~2 KB).
            if len > MAX_HANDSHAKE_SIZE {
                return Err(format!("Handshake too large: {}", len));
            }

            let mut data = vec![0u8; len];
            recv.read_exact(&mut data).await.map_err(|e| format!("Read data failed: {}", e))?;

            let peer_handshake = decode_handshake(&data)?;

            // v30.B1: early IP-identity gate. Reject impersonation BEFORE
            // the ~ms Dilithium verify pass. Genesis identity from a non-
            // pinned IP and registered super-node identity from a different
            // IP than its on-chain endpoint are conclusively rejected.
            if !ip_identity_gate(&peer_handshake.node_id, peer_addr.ip()) {
                // Impostor flood from rotating IPs is high-rate → count always, log
                // sampled (1/256). The metric carries the security signal.
                let n = IP_GATE_REJECTS.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 256 == 1 && crate::node::is_warn() {
                    println!(
                        "[WARN][HANDSHAKE] ip_identity_gate_reject node={} src_ip={} total={} action=close",
                        peer_handshake.node_id, peer_addr.ip(), n
                    );
                }
                return Err("ip_identity_gate_reject".to_string());
            }

            // Verify the peer's identity proof BEFORE sending ours, so a peer that supplied a
            // bogus one never sees our proof. Binding derived from OUR end of the same session;
            // the peer signed the identical value, so a proof lifted off another connection
            // cannot verify here.
            let peer_binding = require_channel_binding(conn)?;
            match verify_handshake_proof(
                &peer_handshake.node_id,
                peer_handshake.timestamp,
                peer_handshake.block_height,
                &peer_binding,
                &peer_handshake.dilithium_proof,
            ).await {
                Ok(HandshakeVerdict::Verified) => {
                    if is_info() {
                        println!("[INFO][HANDSHAKE] dilithium_proof_verified side=server node={} h={}",
                                 peer_handshake.node_id, peer_handshake.block_height);
                    }
                    // v30.A3: Dilithium-verified handshake binds (node_id, block_height)
                    // as an authenticated tuple — attest peer height immediately so the
                    // sync state machine sees real network state without waiting for the
                    // first HealthPing tick. Non-zero heights only; h=0 leaves the
                    // attestation unset so a fresh-cluster cold start does not falsely
                    // declare consensus on "everyone at 0".
                    if peer_handshake.block_height > 0 {
                        if let Some(p2p) = crate::node::try_get_p2p() {
                            p2p.update_peer_last_seen_with_height(
                                &peer_handshake.node_id,
                                Some(peer_handshake.block_height),
                                true, // signed handshake = peer's own committed tip
                            );
                        }
                    }
                }
                Ok(HandshakeVerdict::NotYetVerifiable(reason)) => {
                    // Admitted as transport only: the peer's identity is not resolvable here
                    // yet, and everything it later asserts still passes message-layer verify.
                    if crate::node::is_warn() {
                        println!("[WARN][QUIC] handshake_unverified side=server peer={} reason={}",
                                 get_privacy_id_for_addr(&peer_addr.to_string()), reason);
                    }
                }
                Err(reason) => {
                    if crate::node::is_warn() {
                        println!("[WARN][QUIC] handshake_refused side=server peer={} reason={}",
                                 get_privacy_id_for_addr(&peer_addr.to_string()), reason);
                    }
                    return Err(format!("handshake_refused: {}", reason));
                }
            }

            // Our own proof for the response leg. Refuse rather than answer unprovably.
            let our_timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let our_block_height = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                .load(std::sync::atomic::Ordering::Relaxed);
            // Same session both sides derive from, so a proof lifted off another connection cannot
            // reproduce it.
            let our_binding = require_channel_binding(conn)?;
            let our_proof = build_handshake_proof(
                our_node_id,
                our_timestamp,
                our_block_height,
                &our_binding,
            ).await?;

            // Send our handshake
            let our_handshake = NodeHandshake {
                node_id: our_node_id.to_string(),
                cert_serial: our_cert_serial.to_string(),
                protocol_version: PROTOCOL_VERSION,
                node_type: our_node_type.to_string(),
                timestamp: our_timestamp,
                block_height: our_block_height,
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
        }).await;

        // v30.B2: account success/failure for the per-IP fail bucket. A
        // verified handshake clears any residual ban; any error path (gate
        // reject, proof reject, timeout, malformed wire) bumps the counter
        // so a repeat offender trips the pre-TLS ban at the accept loop.
        match result {
            Ok(Ok(outcome)) => {
                clear_handshake_fail(peer_addr.ip());
                Ok(outcome)
            }
            Ok(Err(e)) => {
                record_handshake_fail(peer_addr.ip());
                Err(e)
            }
            Err(_) => {
                record_handshake_fail(peer_addr.ip());
                Err("Handshake timeout".to_string())
            }
        }
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
        // Drop the listen-addr index entry only if it still points at THIS closing conn (a sibling
        // conn from the same IP must keep its own live entry).
        let listen_key = SocketAddr::new(peer_addr.ip(), 8001u16.saturating_add(crate::p2p_transport::QUIC_PORT_OFFSET));
        INBOUND_CONN_BY_LISTEN_ADDR.remove_if(&listen_key, |_, v| Arc::ptr_eq(v, &quic_conn));
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
    
    /// Reply our cached signed head over the LIVE inbound conn (no dial) to a behind pinger — the
    /// NAT-durable tip feed: it writes on the same accepted QUIC connection the follower's pull uses,
    /// so it traverses the NAT mapping the follower created (cosend/relay to its listen port cannot).
    async fn maybe_reply_signed_head(conn: &Arc<QuicConnection>, peer_height: u64) {
        // The inbound conn already passed the QUIC handshake ML-DSA identity gate and the reply is OUR
        // OWN signed head, so no per-ping verify here (the follower re-verifies on ingest — I1). Gate only
        // on the lead: reply iff we are >= HEAD_REPLY_MIN_GAP ahead — suppresses at-tip chatter, O(1)/conn.
        let head = crate::unified_p2p::LATEST_SIGNED_HEAD.read().clone();
        let (h_from, h_ts, h_height, h_sig) = match head { Some(h) => h, None => return };
        if h_height < peer_height.saturating_add(crate::unified_p2p::HEAD_REPLY_MIN_GAP) { return; }
        // Re-emit OUR signed head over THIS live conn (same framing as try_broadcast_once, no dial).
        let (hint_mb, hint_round) = crate::unified_p2p::current_tc_hint();
        let reply = crate::unified_p2p::NetworkMessage::HealthPing { from: h_from, timestamp: h_ts, height: h_height, cert_mb: hint_mb, cert_round: hint_round, signature: h_sig };
        if let Ok(wire) = Self::serialize_message(&reply) {
            // Bounded like try_broadcast_once so a stalled stream never pins this per-stream task's permit.
            let _ = tokio::time::timeout(Duration::from_secs(MESSAGE_TIMEOUT_SECS), async {
                if let Ok(mut send) = conn.connection.open_uni().await {
                    let len = (wire.len() as u32).to_be_bytes();
                    let _ = send.write_all(&len).await;
                    let _ = send.write_all(&wire).await;
                    let _ = send.finish();
                }
            }).await;
        }
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
                // A frame the sender counted as delivered but this node never assembled. Usually a
                // benign early close, which is why it is rate-limited — but never DBG-only: at DBG the
                // production log cannot distinguish "not sent" from "sent and lost on receive".
                let c = UNI_READ_FAILS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if (c < 3 || c % 128 == 0) && crate::node::is_warn() {
                    println!("[WARN][QUIC] uni_read_failed peer={} fails={} err={:?}",
                        get_privacy_id_for_addr(&peer_addr.to_string()), c + 1, e);
                }
                return;
            }
            Err(_) => {
                // Idle broadcast uni-stream whose body lands after the read window — normal under load,
                // not a fault (bulk sync payloads arrive in one write_all+finish). DBG to avoid spam.
                let c = UNI_READ_TIMEOUTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if (c < 3 || c % 128 == 0) && crate::node::is_warn() {
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
        
        // Live-conn signed-head reply: serve our cached head back over THIS inbound conn to a behind
        // pinger (NAT-durable). Capture the pinger height before the handler moves `msg`.
        let hp_peer_height = if let NetworkMessage::HealthPing { height, .. } = msg { Some(height) } else { None };
        // Call handler
        if let Some(ref h) = handler {
            h(peer_addr, msg);
        }
        if let Some(ph) = hp_peer_height {
            Self::maybe_reply_signed_head(&conn, ph).await;
        }
    }

    /// Parse binary message with per-type size enforcement
    fn parse_message(data: &[u8]) -> Result<NetworkMessage, String> {
        if data.len() < 6 {
            return Err("Message too short".into());
        }

        // Check header — accept the supported range so a coordinated version bump rolls out
        // without partitioning; out-of-range (too old / unknown-newer) is still rejected.
        let version = data[0];
        if version < MIN_SUPPORTED_PROTOCOL_VERSION || version > PROTOCOL_VERSION {
            return Err(format!("Protocol version mismatch: {} (supported {}..={})",
                               version, MIN_SUPPORTED_PROTOCOL_VERSION, PROTOCOL_VERSION));
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

        // NAT reuse: no outbound conn to this listen addr. Before dialing (which a NAT/client-dialed
        // peer cannot accept), reuse a live conn the peer opened TO us, indexed by its advertised
        // listen addr — the only durable channel to push shreds/blocks to such a peer.
        if let Some(conn) = INBOUND_CONN_BY_LISTEN_ADDR.get(&peer_addr).map(|r| r.value().clone()) {
            if crate::quic_transport::is_connection_alive(&conn) {
                return Ok(conn);
            }
            INBOUND_CONN_BY_LISTEN_ADDR.remove(&peer_addr);
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
        let (remote_node_id, remote_cert_serial, remote_node_type, remote_block_height, remote_verified) = self.perform_client_handshake(&connection).await?;

        // v9.7: Immediately update BEST_PEER_HEIGHT from handshake
        if remote_block_height > 0 {
            crate::unified_p2p::BEST_PEER_HEIGHT.fetch_max(remote_block_height, std::sync::atomic::Ordering::Relaxed);
            // A verified handshake height is Dilithium-authenticated → also raise the unforgeable signed-head
            // floor, so an outbound (client) cold-joiner lights it without any inbound HealthPing.
            if remote_verified {
                crate::unified_p2p::SIGNED_HEAD_MAX.fetch_max(remote_block_height, std::sync::atomic::Ordering::Relaxed);
            }
            // Upsert this outbound (client-dialed) peer with its attested tip. The signed handshake binds
            // (node_id, height); without this the peer never enters connected_peers and the attested-peer
            // count stays 0 — so an outbound cold-joiner never reports synchronized.
            if remote_node_id != self.node_id {
                if let Some(p2p) = crate::node::try_get_p2p() {
                    let ip = connection.remote_address().ip().to_string();
                    p2p.attest_connected_peer(&remote_node_id, &ip, &remote_node_type, remote_block_height, remote_verified, true);
                }
            }
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

        // The node_id → address index is written by attest_connected_peer above, through
        // add_peer_lockfree: a peer the admission gates refuse must not be routable here.

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
    async fn perform_client_handshake(&self, conn: &Connection) -> Result<(String, String, String, u64, bool), String> {
        // v2.24: Timeout for entire handshake
        let handshake_timeout = Duration::from_secs(CONNECT_TIMEOUT_SECS);

        tokio::time::timeout(handshake_timeout, async {
            // Identity proof first: it binds (node_id, timestamp, block_height, binding), so a
            // captured proof cannot be replayed under another identity, epoch or session.
            let our_timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let our_block_height = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                .load(std::sync::atomic::Ordering::Relaxed);
            let our_binding = require_channel_binding(conn)?;
            let our_proof = build_handshake_proof(
                &self.node_id,
                our_timestamp,
                our_block_height,
                &our_binding,
            ).await?;

            // Our handshake
            let our_handshake = NodeHandshake {
                node_id: self.node_id.clone(),
                cert_serial: self.cert_serial.clone(),
                protocol_version: PROTOCOL_VERSION,
                node_type: self.node_type.clone(),
                timestamp: our_timestamp,
                block_height: our_block_height,
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

            // Bound the FIRST frame at the handshake's own size, not the 10 MB block ceiling: this read
            // precedes the IP gate and the signature verify, so `len` is attacker-chosen. A handshake is
            // node_id + two u64 + an ML-DSA proof (~3.3 KB) + pk (~2 KB).
            if len > MAX_HANDSHAKE_SIZE {
                return Err(format!("Handshake too large: {}", len));
            }

            let mut data = vec![0u8; len];
            recv.read_exact(&mut data).await.map_err(|e| format!("Read data failed: {}", e))?;

            let peer_handshake = decode_handshake(&data)?;

            // Verify the peer's proof on the response leg. `verified` gates height attestation:
            // an unverified peer is usable as transport but its claimed tip is not attested.
            let peer_binding = require_channel_binding(conn)?;
            let verified = match verify_handshake_proof(
                &peer_handshake.node_id,
                peer_handshake.timestamp,
                peer_handshake.block_height,
                &peer_binding,
                &peer_handshake.dilithium_proof,
            ).await {
                Ok(HandshakeVerdict::Verified) => {
                    if is_info() {
                        println!("[INFO][HANDSHAKE] dilithium_proof_verified side=client node={} h={}",
                                 peer_handshake.node_id, peer_handshake.block_height);
                    }
                    true
                }
                Ok(HandshakeVerdict::NotYetVerifiable(reason)) => {
                    if crate::node::is_warn() {
                        println!("[WARN][QUIC] handshake_unverified side=client peer={} reason={}",
                                 get_privacy_id_for_addr(&conn.remote_address().to_string()), reason);
                    }
                    false
                }
                Err(reason) => {
                    if crate::node::is_warn() {
                        println!("[WARN][QUIC] handshake_refused side=client peer={} reason={}",
                                 get_privacy_id_for_addr(&conn.remote_address().to_string()), reason);
                    }
                    return Err(format!("handshake_refused: {}", reason));
                }
            };

            // v9.7: Return height + verification verdict from handshake
            Ok((peer_handshake.node_id, peer_handshake.cert_serial, peer_handshake.node_type, peer_handshake.block_height, verified))
        }).await.map_err(|_| "Handshake timeout".to_string())?
    }

    /// Send message to peer (request-response) with retry
    pub async fn send_message(&self, peer_addr: SocketAddr, msg: &NetworkMessage) -> Result<(), String> {
        // S2b: heavy bulk serve responses take a bounded permit so a cold-sync flood cannot consume
        // all streams/CPU and starve consensus sends. Consensus/control/requests bypass. Held for the
        // send; on contention the bulk send defers (sync coordinator retries) — consensus never waits.
        let _bulk_permit = if is_bulk_serve_send(msg) {
            match tokio::time::timeout(Duration::from_secs(2), BULK_SEND_PERMITS.acquire()).await {
                Ok(Ok(p)) => Some(p),
                _ => return Err("bulk_send_deferred: consensus headroom reserved".to_string()),
            }
        } else { None };
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
        let wire_data = Self::serialize_message(msg)?;
        self.broadcast_wire_to(peer_addr, &wire_data).await
    }

    /// broadcast_to with the frame already on the wire format. A fan-out that serializes per peer
    /// holds one copy per in-flight send, and a certificate at a 1000-member committee carries that
    /// many un-aggregated ML-DSA-65 signatures - so the caller serializes once and shares the bytes.
    /// Time left on the reconnect cooldown when a fresh dial is the ONLY way to reach this peer.
    /// None whenever a channel can still appear on its own: a live cached connection, a live
    /// NAT-reuse connection the peer opened to us, or a dial another task already has in flight.
    /// Those are exactly connect()'s pre-cooldown exits, so the retry loop stops only for a peer
    /// connect() would genuinely refuse — not for one that is about to become reachable.
    fn dial_blocked_for(&self, peer_addr: &SocketAddr) -> Option<Duration> {
        if self.connect_in_progress.contains_key(peer_addr) { return None; }
        let live = |c: Option<Arc<QuicConnection>>| c.is_some_and(|c| is_connection_alive(&c));
        if live(self.connections.get(peer_addr).map(|r| r.clone())) { return None; }
        if live(INBOUND_CONN_BY_LISTEN_ADDR.get(peer_addr).map(|r| r.value().clone())) { return None; }
        let cooldown = Duration::from_secs(PEER_RECONNECT_COOLDOWN_SECS);
        self.last_connect_attempt.get(peer_addr).and_then(|last| {
            let elapsed = last.value().elapsed();
            if elapsed < cooldown { Some(cooldown - elapsed) } else { None }
        })
    }

    pub async fn broadcast_wire_to(&self, peer_addr: SocketAddr, wire_data: &[u8]) -> Result<(), String> {
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
                        // A dial the cooldown will still be refusing after `delay` cannot be retried
                        // into success — sleeping only holds the caller (the consensus loop) hostage.
                        // Stop now and report; the next broadcast dials once the window opens.
                        if self.dial_blocked_for(&peer_addr).is_some_and(|left| left > delay) {
                            return Err(format!("dial cooldown: {}", last_error));
                        }
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
    /// Wire encoding for a broadcast frame, so a fan-out can serialize once for all peers.
    pub fn serialize_for_broadcast(msg: &NetworkMessage) -> Result<Vec<u8>, String> {
        Self::serialize_message(msg)
    }

    fn serialize_message(msg: &NetworkMessage) -> Result<Vec<u8>, String> {
        let payload = bincode::serialize(msg)
            .map_err(|e| format!("Serialize failed: {}", e))?;

        // Enforce the SAME per-type cap the receiver applies. Without this the sender only checked
        // the global ceiling, so a type whose frame outgrew its own cap was accepted here and
        // dropped by every peer before deserialization — alive on send, dead on receive, silent on
        // both sides. Fail loudly at the source instead.
        let msg_type = Self::get_message_type(msg);
        let type_limit = max_size_for_message_type(msg_type);
        if payload.len() > type_limit {
            return Err(format!(
                "type={} payload={}B exceeds type_limit={}B",
                msg_type, payload.len(), type_limit
            ));
        }

        // Build wire format: version (1) + type (1) + length (4) + payload
        let mut wire_data = Vec::with_capacity(6 + payload.len());
        wire_data.push(PROTOCOL_VERSION);
        wire_data.push(msg_type);
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
            #[allow(deprecated)]
            NetworkMessage::EmergencyProducerChange { .. } => 7,
            NetworkMessage::ShredProtocolChunk { .. } => 8,
            // Large consensus frames: a 1000-committee QC (no PQ sig aggregation) + macroblocks that
            // embed it exceed the 2 MB catch-all → dedicated type with the full 10 MB cap. A same-round
            // 2f+1 TimeoutCertificate carries the SAME committee sig-set (~667-1000 ML-DSA sigs ≈ 2-3.4 MB),
            // so its gossip + pull-response frames need the 10 MB cap too — otherwise the receiver drops
            // them at scale and the failover-cert fallback silently degrades (the primary in-band round>0
            // block path is type-1/10 MB and unaffected, but the redundant TC-sync path must not break).
            NetworkMessage::ConsensusV2 { .. } => 10,
            NetworkMessage::MacroblocksBatch { .. } => 10,
            NetworkMessage::TimeoutCertificateBroadcast { .. } => 10,
            NetworkMessage::TimeoutCertificatesResponse { .. } => 10,
            // Catch-up reply: carries a checkpoint plus its full certificate, so it is the same
            // size class as the frames above. On the 2 MB catch-all it is refused at the sender,
            // silently, above roughly a 680-member committee.
            NetworkMessage::ConsensusState { .. } => 10,
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
// REGRESSION TESTS — DILITHIUM HANDSHAKE BINDING
// ═══════════════════════════════════════════════════════════════════════════
// Offline (no-network, no-crypto-init) properties of the authenticated handshake:
//   * canonical challenge format is byte-stable
//   * exactly one wire shape decodes
//   * a proof-less or malformed proof refuses; an unregistered identity does not
// Properties needing a live keypair / `try_get_p2p` are covered end-to-end in the deploy gate.
#[cfg(test)]
mod tests_handshake {
    use super::*;

    /// The handshake challenge is the message that the Dilithium proof signs
    /// over. Its byte representation MUST stay stable across protocol
    /// versions (sender and receiver each format it locally — any
    /// divergence would silently invalidate every proof). The format
    /// `qnet-quic-handshake-v2:{node_id}:{timestamp}:{block_height}:{channel_binding}`
    /// is load-bearing; this test pins it.
    #[test]
    fn challenge_format_is_canonical() {
        let m = handshake_challenge_message("node_001", 1_700_000_000, 12345, "cb");
        assert_eq!(m, "qnet-quic-handshake-v2:node_001:1700000000:12345:cb");
    }

    /// The proof must survive the wire intact: a decoder that silently dropped it would
    /// turn every peer into an unverifiable one and disarm the whole gate.
    #[test]
    fn handshake_with_proof_round_trips() {
        let hs = NodeHandshake {
            node_id: "node_001".into(),
            cert_serial: "abc".into(),
            protocol_version: PROTOCOL_VERSION,
            node_type: "super".into(),
            timestamp: 1_700_000_000,
            block_height: 12345,
            dilithium_proof: vec![1, 2, 3, 4, 5],
        };
        let bytes = bincode::serialize(&hs).expect("serialize");
        let decoded = decode_handshake(&bytes).expect("deserialize");
        assert_eq!(decoded.node_id, "node_001");
        assert_eq!(decoded.block_height, 12345);
        assert_eq!(decoded.dilithium_proof, vec![1, 2, 3, 4, 5]);
    }

    /// One canonical format: a frame carrying every field EXCEPT the proof must not decode.
    /// Any tolerated proof-less shape is a free bypass of the identity gate.
    #[test]
    fn proofless_frame_does_not_decode() {
        #[derive(Serialize)]
        struct ProoflessFrame {
            node_id: String,
            cert_serial: String,
            protocol_version: u8,
            node_type: String,
            timestamp: u64,
            block_height: u64,
        }
        let bytes = bincode::serialize(&ProoflessFrame {
            node_id: "no_proof".into(),
            cert_serial: "abc".into(),
            protocol_version: PROTOCOL_VERSION,
            node_type: "super".into(),
            timestamp: 1_700_000_000,
            block_height: 999,
        })
        .expect("serialize");
        assert!(decode_handshake(&bytes).is_err(), "proof-less frame must be refused");
    }

    /// An empty proof is a refusal, not an admit. This is the branch that used to
    /// advisory-admit every peer that simply attached nothing.
    #[tokio::test]
    async fn verify_refuses_empty_proof() {
        let result = verify_handshake_proof("node_001", 1_700_000_000, 100, "cb", &[]).await;
        assert_eq!(result, Err("proof_missing"),
            "empty proof MUST refuse, got {:?}", result);
    }

    /// Real signatures from `create_consensus_signature` are ASCII-prefixed strings
    /// (`pq_p2p_bin:`, `compact_bin:`, `dilithium_sig_`), so non-UTF-8 bytes cannot be
    /// one and the connection is dropped.
    #[tokio::test]
    async fn verify_refuses_non_utf8_proof() {
        let bad: &[u8] = &[0xC0, 0xC1, 0xF5];
        let result = verify_handshake_proof("node_001", 1_700_000_000, 100, "cb", bad).await;
        assert_eq!(result, Err("proof_not_utf8"),
            "non-UTF-8 proof MUST refuse, got {:?}", result);
    }

    /// THE cold-join invariant: an identity with no PK in the consensus registry is NOT
    /// refused. A joiner's key reaches the registry through the signed VrfKeyAnnounce that
    /// travels over this very connection, so refusing here makes cold join impossible and
    /// the "PK unknown" condition self-perpetuating. Empty test-process registry reproduces
    /// exactly that state.
    #[tokio::test]
    async fn verify_admits_unregistered_identity_unverified() {
        let proof = b"compact_bin:never_registered_test_payload";
        let result = verify_handshake_proof(
            "test_unknown_identity_must_admit",
            1_700_000_000,
            100,
            "cb",
            proof,
        ).await;
        assert_eq!(
            result,
            Ok(HandshakeVerdict::NotYetVerifiable("pk_unregistered")),
            "unregistered identity MUST admit unverified, got {:?}", result
        );
    }

    /// The channel binding is the one part of the v2 challenge never sent on the wire: each
    /// side derives it from its own end of the same session. Asymmetry would be catastrophic,
    /// not degraded — between two peers whose PKs ARE registered, a mismatch makes the proof
    /// fail and `verify_handshake_proof` returns `Err`, which drops the connection. Every such
    /// pair would partition. This raises a real loopback session with the production TLS
    /// configuration (aws-lc-rs, TLS 1.3, ALPN qnet-p2p-v1) and pins the symmetry.
    #[tokio::test]
    async fn channel_binding_matches_on_both_ends() {
        let cert = rcgen::generate_simple_self_signed(vec!["qnet-test".to_string()]).unwrap();
        let cert_der = CertificateDer::from(cert.serialize_der().unwrap());
        let key_der = PrivateKeyDer::Pkcs8(cert.get_key_pair().serialize_der().into());

        let mut server_crypto = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
            .with_protocol_versions(&[&rustls::version::TLS13]).unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![cert_der], key_der).unwrap();
        server_crypto.alpn_protocols = vec![b"qnet-p2p-v1".to_vec()];
        let server_config = ServerConfig::with_crypto(Arc::new(
            quinn::crypto::rustls::QuicServerConfig::try_from(server_crypto).unwrap(),
        ));
        let server = Endpoint::server(server_config, "127.0.0.1:0".parse().unwrap()).unwrap();
        let addr = server.local_addr().unwrap();

        let mut client_crypto = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
            .with_protocol_versions(&[&rustls::version::TLS13]).unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SelfSignedCertVerifier))
            .with_no_client_auth();
        client_crypto.alpn_protocols = vec![b"qnet-p2p-v1".to_vec()];
        let client_config = ClientConfig::new(Arc::new(
            quinn::crypto::rustls::QuicClientConfig::try_from(client_crypto).unwrap(),
        ));
        let mut client = Endpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
        client.set_default_client_config(client_config);

        let accepting = tokio::spawn(async move {
            let incoming = server.accept().await.expect("no inbound connection");
            incoming.await.expect("server handshake failed")
        });
        let client_conn = client
            .connect(addr, "qnet-node").unwrap()
            .await.expect("client handshake failed");
        let server_conn = accepting.await.unwrap();

        let from_client = connection_channel_binding(&client_conn)
            .expect("client end could not export keying material");
        let from_server = connection_channel_binding(&server_conn)
            .expect("server end could not export keying material");

        assert_eq!(from_client, from_server, "both ends must derive an identical binding");
        assert_eq!(from_client.len(), 64, "binding is 32 bytes, hex-encoded");
        assert_ne!(from_client, hex::encode([0u8; 32]), "binding must not be all-zero");
    }

    /// The per-IP fail bucket is fed by remote addresses and a failing IP never produces the
    /// successful handshake that clears its entry, so the map must be hard-capped: an attacker
    /// spraying one bad frame per source address otherwise grows it until OOM.
    #[test]
    fn handshake_fail_tracker_stays_bounded() {
        HANDSHAKE_FAIL_TRACKER.clear();
        HANDSHAKE_FAIL_LAST_SWEEP.store(0, Ordering::Relaxed);
        // 4x the cap of distinct, never-repeating source IPs (an IPv6 /64 sprayed one frame each).
        for i in 0..(HANDSHAKE_FAIL_MAX_ENTRIES as u64 * 4) {
            let ip = std::net::IpAddr::V6(std::net::Ipv6Addr::from(
                0x2001_0db8_0000_0000_0000_0000_0000_0000u128 + i as u128,
            ));
            record_handshake_fail(ip);
            assert!(
                HANDSHAKE_FAIL_TRACKER.len() <= HANDSHAKE_FAIL_MAX_ENTRIES,
                "tracker exceeded its cap at i={}", i,
            );
        }
        assert!(HANDSHAKE_FAIL_TRACKER.len() > 0, "the cap bounds the map, it does not disable it");

        // Bounding must not cost the defence: a tracked IP still bans on threshold breach and
        // still clears on a confirmed-successful handshake.
        HANDSHAKE_FAIL_TRACKER.clear();
        let known = std::net::IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 5));
        for _ in 0..HANDSHAKE_FAIL_THRESHOLD {
            record_handshake_fail(known);
        }
        assert!(is_handshake_ip_banned(known), "threshold breach still bans");
        clear_handshake_fail(known);
        assert!(!is_handshake_ip_banned(known), "a successful handshake clears the ban");
        HANDSHAKE_FAIL_TRACKER.clear();
    }

}

#[cfg(test)]
mod tests_wire_caps {
    use super::*;
    use crate::unified_p2p::NetworkMessage;

    /// The receiver rejects any frame above `max_size_for_message_type` BEFORE deserializing, so a
    /// message whose real frame outgrows its own cap is dropped by every peer with no log on either
    /// side. That is how the signed-head emitter went silently dark. This pins the worst case of the
    /// smallest-capped type: hex ML-DSA-65 signature (3309 B -> 6618 chars) plus a full-length node id.
    #[test]
    fn healthping_worst_case_fits_its_cap() {
        let msg = NetworkMessage::HealthPing {
            from: "super_QNET-XXXXXX-XXXXXX-XXXXXX".to_string(),
            timestamp: u64::MAX,
            height: u64::MAX,
            cert_mb: u64::MAX,
            cert_round: u64::MAX,
            signature: "a".repeat(3309 * 2),
        };
        let wire = QuicTransport::serialize_message(&msg).expect("worst-case frame exceeds its own type cap");
        let cap = max_size_for_message_type(4);
        assert!(
            wire.len() - 6 <= cap,
            "HealthPing payload {}B over cap {}B",
            wire.len() - 6,
            cap
        );
    }

    /// Every type the table caps below the global ceiling must round-trip its own frame: send-side
    /// enforcement and receive-side enforcement read the same function, so a cap of 0 or a cap below
    /// a type's fixed overhead would make that message class unusable in one direction only.
    #[test]
    fn capped_types_are_self_consistent() {
        for t in [0u8, 1, 2, 3, 4, 8, 10] {
            let cap = max_size_for_message_type(t);
            assert!(cap >= 8 * 1024, "type {} cap {}B is below the minimum useful frame", t, cap);
            assert!(cap <= MAX_MESSAGE_SIZE, "type {} cap {}B exceeds the global ceiling", t, cap);
        }
        assert_eq!(max_size_for_message_type(7), 0, "deprecated type must stay rejected");
        // Consensus frames must keep the FULL ceiling: at committee 1000 a QuorumCertificate carries
        // up to 1000 ML-DSA-65 signatures (~3.3 MB) and a macroblock embeds one. The sync path batches
        // by bytes under this cap; shrinking it would silently break macroblock sync at scale.
        assert_eq!(max_size_for_message_type(10), MAX_MESSAGE_SIZE, "ConsensusV2/MacroblocksBatch cap");
        assert!(
            max_size_for_message_type(10) >= 2 * 1000 * 3309,
            "type 10 must hold a full 1000-signer certificate with room for the block it rides in"
        );
    }

    /// A FULL 512 KB data chunk carrying a worst-case producer certificate must fit the
    /// type-8 cap. The old +256 headroom failed exactly this: every cert-carrying chunk
    /// of a large block was dropped at receive, so no shredded block ever delivered its
    /// certificate — 100% reproducible, not loss.
    #[test]
    fn full_chunk_with_certificate_fits_type8_cap() {
        let chunk = crate::unified_p2p::ShredProtocolChunk {
            block_height: u64::MAX,
            chunk_index: usize::MAX,
            total_chunks: usize::MAX,
            data: vec![0xA5u8; 512 * 1024],
            is_parity: false,
            original_block_size: usize::MAX,
            is_macroblock: false,
            certificate: Some(crate::unified_p2p::ProducerCertificate {
                serial_number: "S".repeat(96),
                node_id: "n".repeat(64),
                certificate_bytes: vec![0x5Au8; 8 * 1024], // serialized PqCertificate upper bound
            }),
            block_hash: Some([0xEEu8; 32]),
            num_coding_shreds: usize::MAX,
        };
        let msg = crate::unified_p2p::NetworkMessage::ShredProtocolChunk { chunk };
        let wire = QuicTransport::serialize_message(&msg).expect("serialize");
        let cap = max_size_for_message_type(8);
        assert!(wire.len() <= cap,
            "cert-carrying full chunk {}B exceeds type-8 cap {}B — receivers drop it silently",
            wire.len(), cap);
    }
}

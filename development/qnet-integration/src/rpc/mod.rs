//! JSON-RPC and REST API server for QNet node
//! Each node provides full API functionality for decentralized access
mod misc_api;
pub(crate) use misc_api::*;
mod tx_api;
use tx_api::*;
mod queries_api;
use queries_api::*;
mod certified_proofs;
use certified_proofs::*;
#[cfg(test)]
mod certified_e2e_tests;
mod rewards_api;
#[cfg(test)]
pub(crate) use rewards_api::{merkle_claim_tx, claim_quote_signer_ok};
use rewards_api::*;
mod light_nodes;
pub use light_nodes::*;
mod light_bind;
pub(crate) use light_bind::*;
mod light_status;
use light_status::*;
mod light_push;
pub(crate) use light_push::*;
mod light_owners;
pub(crate) use light_owners::*;
mod light_unbind;
pub(crate) use light_unbind::*;
mod light_device;
pub(crate) use light_device::*;
mod registration_api;
pub use registration_api::*;
mod registration_door;
pub(crate) use registration_door::*;
mod contracts_api;
pub(crate) use contracts_api::*;
mod benchmark;
use benchmark::*;

pub(crate) use std::sync::Arc;
pub(crate) use std::collections::HashMap;
pub(crate) use std::net::IpAddr;
pub(crate) use serde::{Deserialize, Serialize};
pub(crate) use serde_json::{json, Value};
pub(crate) use warp::{Filter, Rejection, Reply};
pub(crate) use warp::ws::{Message, WebSocket};
pub(crate) use crate::node::{BlockchainNode, is_info, is_warn};
pub(crate) use qnet_state::transaction::BatchTransferData;
pub(crate) use chrono;
pub(crate) use sha3::{Sha3_256, Digest}; // Add missing Digest trait
pub(crate) use hex;
pub(crate) use base64::Engine;
pub(crate) use std::time::{SystemTime, UNIX_EPOCH};
pub(crate) use dashmap::{DashMap, DashSet};
pub(crate) use once_cell::sync::Lazy;
pub(crate) use futures::{StreamExt, SinkExt};
pub(crate) use tokio::sync::broadcast;

/// The recipient and value history and lookups show for a TX: what apply pays or creates, never an
/// envelope field nothing signs. A batch shows its kind and the sum of its transfers; a deploy the
/// address apply derives and no value (a deploy moves none); a lifecycle TX or proof, which pays no one,
/// neither; every other class its signed fields.
pub(crate) fn tx_display_to_amount(tx: &qnet_state::Transaction) -> (Option<String>, u64) {
    match &tx.tx_type {
        qnet_state::TransactionType::BatchTransfers { transfers, .. } => (
            Some(qnet_state::transaction::BATCH_TRANSFERS_TO.to_string()),
            transfers.iter().fold(0u64, |acc, t| acc.saturating_add(t.amount)),
        ),
        qnet_state::TransactionType::ContractDeploy =>
            (Some(qnet_state::transaction::derive_contract_address(&tx.from, tx.nonce)), 0),
        _ if tx.moves_no_envelope_value() => (None, 0),
        _ => (tx.to.clone(), tx.amount),
    }
}

/// What `address` receives from a batch: the sum of its transfers to it, or None if it is no recipient.
pub(crate) fn batch_received_by(tx: &qnet_state::Transaction, address: &str) -> Option<u64> {
    match &tx.tx_type {
        qnet_state::TransactionType::BatchTransfers { transfers, .. } => transfers.iter()
            .filter(|t| t.to_address == address)
            .fold(None, |acc: Option<u64>, t| Some(acc.unwrap_or(0).saturating_add(t.amount))),
        _ => None,
    }
}

// ============================================================================
// v2.96: HELPER FUNCTIONS FOR BLOCKCHAIN CONSENSUS DATA
// ============================================================================

/// Node consensus reputation = binary {INITIAL_REPUTATION | 0}: the floor for every
/// node, 0 for a cryptographically-proven equivocation offender. Read from the latest
/// macroblock's anchored ban-set — a pure function of the committed chain, identical on
/// every node. Macroblock bytes may be zstd-compressed.
async fn get_reputation_from_snapshot(blockchain: &Arc<BlockchainNode>, node_id: &str) -> f64 {
    use qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
    let mb_index = blockchain.get_height().await / 90;
    if mb_index > 0 {
        if let Ok(Some(raw)) = blockchain.get_storage().get_macroblock_by_height(mb_index) {
            let bytes = zstd::decode_all(&raw[..]).unwrap_or(raw);
            if let Ok(mb) = bincode::deserialize::<qnet_state::MacroBlock>(&bytes) {
                if let Some(ref ser) = mb.consensus_data.banned_validators {
                    if let Ok(banned) = bincode::deserialize::<Vec<String>>(ser) {
                        if banned.iter().any(|b| b == node_id) { return 0.0; }
                    }
                }
            }
        }
    }
    INITIAL_REPUTATION
}

// ============================================================================
// WEBSOCKET: Real-time event broadcasting
// ============================================================================

/// WebSocket event types for subscription
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum WsEvent {
    /// New block created
    NewBlock {
        height: u64,
        hash: String,
        timestamp: u64,
        tx_count: usize,
        producer: String,
    },
    /// Account balance changed
    BalanceUpdate {
        address: String,
        new_balance: u64,
        change: i64,
        tx_hash: String,
    },
    /// Smart contract event emitted
    ContractEvent {
        contract_address: String,
        event_name: String,
        data: Value,
        block_height: u64,
        tx_hash: String,
    },
    /// Transaction confirmed
    TxConfirmed {
        tx_hash: String,
        block_height: u64,
        status: String,
    },
    /// New pending transaction in mempool
    PendingTx {
        tx_hash: String,
        from: String,
        to: String,
        amount: u64,
    },
    /// PRODUCTION v2.43.1: Reward update for node
    RewardUpdate {
        node_id: String,
        epoch: u64,
        pending_qnc: f64,
        pool1_base: f64,
        pool2_fees: f64,
        pool3_activation: f64,
        is_eligible: bool,
        heartbeats: u8,
    },
    /// PRODUCTION v2.43.1: Reward claimed
    RewardClaimed {
        node_id: String,
        wallet_address: String,
        amount_qnc: f64,
        tx_hash: String,
        epoch: u64,
    },
}

/// Global WebSocket event broadcaster
/// All connected clients receive events through this channel
pub static WS_BROADCASTER: Lazy<broadcast::Sender<WsEvent>> = Lazy::new(|| {
    let (tx, _) = broadcast::channel(10_000); // Scaled for 10K+ WS clients
    tx
});

/// Broadcast an event to all connected WebSocket clients
pub fn broadcast_ws_event(event: WsEvent) {
    // Ignore send errors (no subscribers)
    let _ = WS_BROADCASTER.send(event);
}

// ============================================================================
// PRODUCTION v2.43.1: CACHING FOR REWARD STATS
// ============================================================================

/// Cache for Pool2/Pool3 accumulated stats (10 second TTL)
/// Reduces load when multiple clients poll for epoch stats
static REWARD_POOLS_CACHE: Lazy<parking_lot::RwLock<(RewardPoolsCache, std::time::Instant)>> =
    Lazy::new(|| parking_lot::RwLock::new((RewardPoolsCache::default(), std::time::Instant::now())));

/// Cache for network-wide reward statistics (30 second TTL)
static REWARD_NETWORK_STATS_CACHE: Lazy<parking_lot::RwLock<(serde_json::Value, std::time::Instant)>> =
    Lazy::new(|| parking_lot::RwLock::new((serde_json::json!({}), std::time::Instant::now())));

/// Cache for node summary statistics (60 second TTL per node)
/// Key: node_id, Value: (summary_json, last_update)
static REWARD_SUMMARY_CACHE: Lazy<DashMap<String, (serde_json::Value, std::time::Instant)>> = 
    Lazy::new(|| DashMap::new());

const REWARD_SUMMARY_CACHE_TTL_SECS: u64 = 60;

// Per-contract token metadata (symbol/decimals/logo) is IMMUTABLE after deploy (no setter method), so
// cache it: enrich_token_transfers must not re-clone a full contract account (every holder balance) for
// the same token on every request. Bounded (anti-OOM); positive entries only.
static TOKEN_META_CACHE: Lazy<DashMap<String, (String, u8, String)>> = Lazy::new(|| DashMap::new());
const TOKEN_META_CACHE_MAX: usize = 100_000;

#[derive(Default, Clone)]
struct RewardPoolsCache {
    pool2_fees: u64,
    pool3_activations: u64,
    epoch: u64,
    #[allow(dead_code)]
    blocks_in_epoch: u64,
}

const REWARD_POOLS_CACHE_TTL_SECS: u64 = 10;
const REWARD_NETWORK_STATS_CACHE_TTL_SECS: u64 = 30;

// ============================================================================
// SECURITY: IP-based Rate Limiting for REST API DDoS Protection
// ============================================================================

/// Global IP-based rate limiter for REST API endpoints
/// Protects against DDoS attacks by limiting requests per IP address
static API_RATE_LIMITER: Lazy<ApiRateLimiter> = Lazy::new(|| ApiRateLimiter::new());

/// Node-global concurrency bound on snapshot BYTE serving (full + chunk), independent of the per-IP
/// limiter. Caps total in-flight snapshot serves so a flood of cold-joiners (or a spoofed-IP attacker)
/// cannot exhaust a holder's memory/IO. Over the bound → immediate busy reply; the joiner retries
/// another holder. Sized for thousands of nodes.
static SNAPSHOT_SERVE_SEM: Lazy<tokio::sync::Semaphore> = Lazy::new(|| tokio::sync::Semaphore::new(16));

// ============================================================================
// SECURITY: WebSocket Connection Rate Limiting
// ============================================================================

/// WebSocket rate limiter to prevent connection flood attacks
/// Limits: max 5 connections per IP, max 10,000 total connections
struct WsRateLimiter {
    /// Active connections per IP address
    connections_per_ip: DashMap<IpAddr, u32>,
    /// Total active connections count
    total_connections: std::sync::atomic::AtomicU32,
    /// Maximum connections allowed per IP
    max_per_ip: u32,
    /// Maximum total connections
    max_total: u32,
}

impl WsRateLimiter {
    fn new() -> Self {
        Self {
            connections_per_ip: DashMap::new(),
            total_connections: std::sync::atomic::AtomicU32::new(0),
            max_per_ip: 5,      // Max 5 WS connections per IP
            max_total: 10_000,  // Max 10K total WS connections
        }
    }
    
    /// Check if new connection is allowed from this IP
    fn check_connection(&self, ip: Option<IpAddr>) -> bool {
        let total = self.total_connections.load(std::sync::atomic::Ordering::Relaxed);
        
        // Check total limit
        if total >= self.max_total {
            println!("[WS] 🚫 Total connection limit reached ({}/{})", total, self.max_total);
            return false;
        }
        
        // Check per-IP limit
        if let Some(ip_addr) = ip {
            let current = self.connections_per_ip.get(&ip_addr)
                .map(|v| *v)
                .unwrap_or(0);
            
            if current >= self.max_per_ip {
                println!("[WS] 🚫 Per-IP limit reached for {} ({}/{})", ip_addr, current, self.max_per_ip);
                return false;
            }
        }
        
        true
    }
    
    /// Register new connection
    fn add_connection(&self, ip: Option<IpAddr>) {
        self.total_connections.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        
        if let Some(ip_addr) = ip {
            self.connections_per_ip
                .entry(ip_addr)
                .and_modify(|count| *count += 1)
                .or_insert(1);
        }
    }
    
    /// Unregister connection on close
    fn remove_connection(&self, ip: Option<IpAddr>) {
        self.total_connections.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        
        if let Some(ip_addr) = ip {
            if let Some(mut count) = self.connections_per_ip.get_mut(&ip_addr) {
                if *count > 0 {
                    *count -= 1;
                }
                if *count == 0 {
                    drop(count); // Release lock before remove
                    self.connections_per_ip.remove(&ip_addr);
                }
            }
        }
    }
    
    /// Get current stats for monitoring
    fn get_stats(&self) -> (u32, usize) {
        (
            self.total_connections.load(std::sync::atomic::Ordering::Relaxed),
            self.connections_per_ip.len()
        )
    }
}

/// Global WebSocket rate limiter
static WS_RATE_LIMITER: Lazy<WsRateLimiter> = Lazy::new(|| WsRateLimiter::new());

/// Rate limit configuration per endpoint type
#[derive(Clone)]
struct RateLimitConfig {
    /// Maximum requests per window
    max_requests: u32,
    /// Time window in seconds
    window_seconds: u64,
    /// Block duration in seconds after exceeding limit
    block_duration: u64,
}

/// Per-IP rate limit state
struct IpRateLimitState {
    /// Request timestamps within current window
    requests: Vec<u64>,
    /// Blocked until timestamp (0 = not blocked)
    blocked_until: u64,
}

/// API Rate Limiter with configurable limits per endpoint type
struct ApiRateLimiter {
    /// Per-IP state: IP -> (endpoint_type -> state)
    ip_states: DashMap<IpAddr, DashMap<String, IpRateLimitState>>,
    /// Configuration per endpoint type
    configs: HashMap<String, RateLimitConfig>,
}

impl ApiRateLimiter {
    fn new() -> Self {
        let mut configs = HashMap::new();
        
        // v8.1: Configurable via QNET_API_RATE_LIMIT env (format: "requests_per_minute")
        // Default: 100 tx/min. Operators can increase for benchmark/exchange deployments.
        let tx_rate: u32 = std::env::var("QNET_API_RATE_LIMIT")
            .ok()
            .and_then(|v| v.parse().ok())
            .map(|v: u32| v.clamp(1, 10_000)) // SECURITY: Enforce sane bounds
            .unwrap_or(100);
        
        configs.insert("transaction".to_string(), RateLimitConfig {
            max_requests: tx_rate,
            window_seconds: 60,
            block_duration: 300,
        });
        
        configs.insert("activation".to_string(), RateLimitConfig {
            max_requests: 5,
            window_seconds: 3600,
            block_duration: 3600,
        });
        
        configs.insert("light_node_register".to_string(), RateLimitConfig {
            max_requests: 3,
            window_seconds: 3600,
            block_duration: 3600,
        });

        // Attestation is once/epoch and the per-epoch dedup runs BEFORE the Dilithium verify, so an
        // honest device costs one verification per epoch however often it answers. That is the bound
        // that matters; the per-IP cap only stops one source from flooding. It has to be wide, because
        // an IP is not a device: a household answers from several phones and a carrier NAT fronts
        // thousands of them, and every answer over the cap is a device losing its epoch for a reason
        // it cannot see.
        configs.insert("light_node_ping".to_string(), RateLimitConfig {
            max_requests: 120,
            window_seconds: 60,
            block_duration: 60,
        });

        // Token refresh, bind, pending bind and unbind are signed by the device or the wallet and limited per
        // NODE after their signatures verify; per address only their failed requests are counted, an IPv6
        // address by its /64 (light_bind.rs `FailLimiter`, L-2), so they have no bucket here.

        // A device challenge is 32 random bytes and a MAC; the app asks one per device message. Wide for a
        // carrier NAT; each enrolment it opens is limited again per address and per node (light_device.rs).
        configs.insert("light_device_challenge".to_string(), RateLimitConfig {
            max_requests: 120,
            window_seconds: 60,
            block_duration: 60,
        });

        // A lease refresh and a key rotation are signed by the device key and limited per node after the
        // signature verifies (light_device.rs); wide per address for a carrier NAT, like bind.
        configs.insert("light_device_refresh".to_string(), RateLimitConfig {
            max_requests: 30,
            window_seconds: 3600,
            block_duration: 600,
        });
        configs.insert("light_device_rotate".to_string(), RateLimitConfig {
            max_requests: 30,
            window_seconds: 3600,
            block_duration: 600,
        });

        // "I'm back" is unsigned and sends a push: each address gets few, and the sender caps each node
        // and the wake budget on top (light_push.rs).
        configs.insert("light_node_wake".to_string(), RateLimitConfig {
            max_requests: 20,
            window_seconds: 3600,
            block_duration: 600,
        });

        // The signed status costs one or two ML-DSA-65 verifications and reads nothing private before
        // they pass. An app reads it when its Node tab opens and before a bind; the cap is wide for the
        // same carrier-NAT reason as the ping.
        configs.insert("light_node_status_signed".to_string(), RateLimitConfig {
            max_requests: 120,
            window_seconds: 60,
            block_duration: 60,
        });
        
        configs.insert("claim_rewards".to_string(), RateLimitConfig {
            max_requests: 10,
            window_seconds: 3600,
            block_duration: 1800,
        });

        // v10.0: Consensus endpoints — higher limit for peer communication (60/min)
        configs.insert("consensus".to_string(), RateLimitConfig {
            max_requests: 60,
            window_seconds: 60,
            block_duration: 60,
        });

        // v10.0: MEV bundle endpoints (30/min)
        configs.insert("mev_bundle".to_string(), RateLimitConfig {
            max_requests: 30,
            window_seconds: 60,
            block_duration: 120,
        });

        // v10.0: Benchmark endpoints — very restricted (5/min)
        configs.insert("benchmark".to_string(), RateLimitConfig {
            max_requests: 5,
            window_seconds: 60,
            block_duration: 300,
        });
        
        // v8.1: General and read-only also scale with tx_rate
        let general_rate = std::cmp::max(tx_rate, 100);
        let read_rate = std::cmp::max(tx_rate * 3, 300);
        
        configs.insert("general".to_string(), RateLimitConfig {
            max_requests: general_rate,
            window_seconds: 60,
            block_duration: 60,
        });
        
        configs.insert("read_only".to_string(), RateLimitConfig {
            max_requests: read_rate,
            window_seconds: 60,
            block_duration: 30,
        });

        // Block-header pages: up to 1000 row reads each, so the bucket is small (indexers hold a key).
        configs.insert("headers".to_string(), RateLimitConfig {
            max_requests: 30,
            window_seconds: 60,
            block_duration: 60,
        });

        // History archive: index pages and segment downloads (a segment is one epoch of blocks).
        configs.insert("archive".to_string(), RateLimitConfig {
            max_requests: 30,
            window_seconds: 60,
            block_duration: 60,
        });

        // Certified proofs and the certified state, keyed by an IPv4 address or an IPv6 /64
        // (`certified_proofs::limiter_key`): one host holds a whole /64, so a full-address key would
        // give it 2^64 buckets. Each proof also holds a slot of the proof pool (certified_proofs.rs).
        configs.insert(certified_proofs::CERTIFIED_PROOF_BUCKET.to_string(), RateLimitConfig {
            max_requests: 600,
            window_seconds: 60,
            block_duration: 30,
        });
        configs.insert(certified_proofs::CERTIFIED_STATE_BUCKET.to_string(), RateLimitConfig {
            max_requests: 600,
            window_seconds: 60,
            block_duration: 30,
        });

        if tx_rate != 100 {
            println!("[INFO][SECURITY] api_rate_limit_configured tx={}/min general={}/min read={}/min", 
                     tx_rate, general_rate, read_rate);
        }
        
        Self {
            ip_states: DashMap::new(),
            configs,
        }
    }
    
    /// Check if request is allowed, returns (allowed, retry_after_seconds)
    fn check_rate_limit(&self, ip: IpAddr, endpoint_type: &str) -> (bool, u64) {
        // SCALABILITY: Periodic cleanup of stale IP entries (every 1000 calls)
        static CLEANUP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let count = CLEANUP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if count % 1000 == 0 && self.ip_states.len() > 1000 {
            let cutoff = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                .saturating_sub(600); // 10 minutes ago
            self.ip_states.retain(|_, endpoints| {
                // Keep IP if any endpoint has recent activity (last 10 minutes)
                endpoints.iter().any(|entry| {
                    entry.value().requests.last().map(|&ts| ts > cutoff).unwrap_or(false)
                })
            });
            println!("[INFO][RPC] rate_limiter_cleanup ip_count={}", self.ip_states.len());
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let config = self.configs.get(endpoint_type)
            .unwrap_or_else(|| self.configs.get("general").expect("General config must exist"));
        
        // Get or create IP entry
        let ip_endpoints = self.ip_states.entry(ip).or_insert_with(DashMap::new);
        
        // Get or create endpoint state for this IP
        let mut state = ip_endpoints.entry(endpoint_type.to_string())
            .or_insert_with(|| IpRateLimitState {
                requests: Vec::new(),
                blocked_until: 0,
            });
        
        // Check if currently blocked
        if state.blocked_until > now {
            return (false, state.blocked_until - now);
        }
        
        // Clean old requests outside window
        let window_start = now.saturating_sub(config.window_seconds);
        state.requests.retain(|&ts| ts > window_start);
        
        // Check if limit exceeded
        if state.requests.len() >= config.max_requests as usize {
            state.blocked_until = now + config.block_duration;
            println!("[WARN][RPC] rate_limit_blocked ip={} duration={}s endpoint={}",
                     ip, config.block_duration, endpoint_type);
            return (false, config.block_duration);
        }
        
        // Record this request
        state.requests.push(now);
        (true, 0)
    }
    
    /// Get remaining requests for an IP/endpoint
    #[allow(dead_code)]
    fn get_remaining(&self, ip: IpAddr, endpoint_type: &str) -> u32 {
        let config = self.configs.get(endpoint_type)
            .unwrap_or_else(|| self.configs.get("general").expect("General config must exist"));
        
        if let Some(ip_endpoints) = self.ip_states.get(&ip) {
            if let Some(state) = ip_endpoints.get(endpoint_type) {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let window_start = now.saturating_sub(config.window_seconds);
                let recent_requests = state.requests.iter()
                    .filter(|&&ts| ts > window_start)
                    .count() as u32;
                return config.max_requests.saturating_sub(recent_requests);
            }
        }
        config.max_requests
    }
}

// ============================================================================
// SECURITY: API Key System for Unlimited Access (Explorer, Admin)
// ============================================================================

/// API keys for unlimited access (set via environment variables)
/// QNET_API_KEY_EXPLORER - for official explorer servers
/// QNET_API_KEY_ADMIN - for admin/monitoring tools
/// QNET_WHITELIST_IPS - comma-separated list of whitelisted IPs
static API_KEYS: Lazy<std::collections::HashSet<String>> = Lazy::new(|| {
    let mut keys = std::collections::HashSet::new();
    const MIN_KEY_LENGTH: usize = 16; // Minimum 16 chars to prevent brute-force
    
    // Load keys from environment with length validation
    if let Ok(explorer_key) = std::env::var("QNET_API_KEY_EXPLORER") {
        if explorer_key.len() >= MIN_KEY_LENGTH {
            keys.insert(explorer_key);
        } else if !explorer_key.is_empty() {
            println!("[WARN][SECURITY] QNET_API_KEY_EXPLORER too short (min {} chars), ignoring", MIN_KEY_LENGTH);
        }
    }
    if let Ok(admin_key) = std::env::var("QNET_API_KEY_ADMIN") {
        if admin_key.len() >= MIN_KEY_LENGTH {
            keys.insert(admin_key);
        } else if !admin_key.is_empty() {
            println!("[WARN][SECURITY] QNET_API_KEY_ADMIN too short (min {} chars), ignoring", MIN_KEY_LENGTH);
        }
    }
    
    // DEV keys loaded from environment only, never hardcoded
    #[cfg(debug_assertions)]
    {
        if let Ok(dev_key) = std::env::var("QNET_DEV_API_KEY") {
            keys.insert(dev_key);
        }
        println!("[INFO][RPC] debug_mode api_keys_from_env_only=true");
    }
    
    if !keys.is_empty() {
        println!("[INFO][SECURITY] api_keys_loaded count={}", keys.len());
    }
    keys
});

/// Whitelisted IPs that bypass rate limiting
static WHITELIST_IPS: Lazy<std::collections::HashSet<IpAddr>> = Lazy::new(|| {
    let mut ips = std::collections::HashSet::new();
    
    // Always whitelist localhost
    ips.insert(IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1)));
    ips.insert(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST));
    
    // Load from environment: QNET_WHITELIST_IPS=1.2.3.4,5.6.7.8
    if let Ok(whitelist) = std::env::var("QNET_WHITELIST_IPS") {
        for ip_str in whitelist.split(',') {
            if let Ok(ip) = ip_str.trim().parse::<IpAddr>() {
                ips.insert(ip);
            }
        }
    }
    
    if ips.len() > 2 {
        println!("[INFO][SECURITY] whitelist_ips_loaded count={}", ips.len());
    }
    ips
});

/// Check if request has valid API key (from X-API-Key header or query param)
/// SECURITY: Keys must be at least 16 characters to prevent brute-force
fn has_valid_api_key(api_key: Option<&str>) -> bool {
    match api_key {
        Some(key) if key.len() >= 16 => API_KEYS.contains(key),
        _ => false,
    }
}

/// Check if IP is whitelisted
fn is_ip_whitelisted(ip: IpAddr) -> bool {
    WHITELIST_IPS.contains(&ip)
}

/// v10.0 SECURITY: Check if IP is internal (localhost, private network, or whitelisted)
/// Used to restrict consensus/P2P endpoints to trusted peers only.
fn is_internal_ip(ip_str: &str) -> bool {
    if ip_str.is_empty() {
        return false;
    }
    if ip_str == "localhost" {
        return true;
    }
    // Parse once; string-prefix range checks are over-broad (e.g. "fc.127.0.1" or "10.evil").
    let ip = match ip_str.parse::<IpAddr>() {
        Ok(ip) => ip,
        Err(_) => return false,
    };
    if WHITELIST_IPS.contains(&ip) {
        return true;
    }
    is_private_ip(&ip)
}

/// True for loopback, link-local, and RFC1918/unique-local (fc00::/7) ranges.
fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local()
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() {
                return true;
            }
            // Unique-local fc00::/7: first byte 0xfc or 0xfd.
            let first = v6.octets()[0];
            if first == 0xfc || first == 0xfd {
                return true;
            }
            // Link-local fe80::/10.
            let seg0 = v6.segments()[0];
            (seg0 & 0xffc0) == 0xfe80
        }
    }
}

/// The client a request came from, seen through the TLS terminator on this host. A loopback peer
/// carrying X-Forwarded-For is that proxy speaking for someone else, and the client is the address it
/// appended — the last one, so a value the client wrote into the header itself is never taken. Every
/// other peer is what the socket says. Without this every proxied request would look like localhost,
/// which the limiter whitelists, and the per-address limits would not exist for the public at all.
fn client_addr() -> impl Filter<Extract = (Option<std::net::SocketAddr>,), Error = Rejection> + Clone {
    warp::addr::remote()
        .and(warp::header::optional::<String>("x-forwarded-for"))
        .map(|peer: Option<std::net::SocketAddr>, xff: Option<String>| forwarded_client(peer, xff.as_deref()))
}

/// Port 0 marks a forwarded address; every consumer keys on the IP alone. A request the local proxy
/// speaks for is never this host: when the entry it names is not an address, or names this host itself
/// (loopback, unspecified), the terminator did not write it - a client did, through a terminator that
/// passes the header on - and the request is taken as nobody in particular (0.0.0.0: not whitelisted, not
/// loopback, never a genesis, one shared bucket in every per-address limit).
/// The default gateway of this node's network namespace (a container's bridge gateway), read once from the kernel's
/// route table. A terminator on the host reaches a bridge-networked node from this address, so its X-Forwarded-For
/// names the client exactly as a loopback terminator's does; without the header the request is this host's own.
static LOCAL_GATEWAY: Lazy<Option<IpAddr>> = Lazy::new(|| {
    std::fs::read_to_string("/proc/net/route").ok().and_then(|t| default_gateway(&t))
});

/// The IPv4 default gateway in /proc/net/route text: the row with destination 00000000 and the gateway flag.
fn default_gateway(route_table: &str) -> Option<IpAddr> {
    route_table.lines().skip(1).find_map(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 4 || f[1] != "00000000" { return None; }
        let flags = u32::from_str_radix(f[3], 16).ok()?;
        if flags & 0x2 == 0 { return None; }
        let g = u32::from_str_radix(f[2], 16).ok()?;
        if g == 0 { return None; }
        Some(IpAddr::V4(std::net::Ipv4Addr::from(g.to_le_bytes())))
    })
}

fn forwarded_client(peer: Option<std::net::SocketAddr>, xff: Option<&str>) -> Option<std::net::SocketAddr> {
    let p = peer?;
    if !p.ip().is_loopback() && Some(p.ip()) != *LOCAL_GATEWAY { return Some(p); }
    let Some(header) = xff else { return Some(p); };
    let nobody = std::net::SocketAddr::new(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED), 0);
    let last = header.rsplit(',').next().map(str::trim).unwrap_or("");
    let names_this_host = |ip: IpAddr| ip.is_loopback() || ip.is_unspecified() || matches!(ip,
        IpAddr::V6(v6) if v6.to_ipv4_mapped().map_or(false, |v4| v4.is_loopback() || v4.is_unspecified()));
    match last.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        Ok(ip) if !names_this_host(ip) => Some(std::net::SocketAddr::new(ip, 0)),
        _ => Some(nobody),
    }
}

/// Whether a web page sent the request: it carries an Origin header, which a browser writes on every
/// cross-origin request and on every POST and DELETE. Servers, operator tools and genesis-to-genesis calls
/// send none. An Origin that is not text is still an Origin.
fn from_page() -> impl Filter<Extract = (bool,), Error = std::convert::Infallible> + Clone {
    warp::header::optional::<String>("origin")
        .map(|origin: Option<String>| origin.is_some())
        .or(warp::any().map(|| true))
        .unify()
}

/// The request's Origin header: None when absent; an Origin that is not text reads as "" (no allowed origin).
fn request_origin() -> impl Filter<Extract = (Option<String>,), Error = std::convert::Infallible> + Clone {
    warp::header::optional::<String>("origin")
        .or(warp::any().map(|| Some(String::new())))
        .unify()
}

/// The origins the registration doors answer (the submit route and `node_attestBurn`), checked by the server
/// whatever CORS answered: no Origin (the app, the site's server, a node asking another), the site, and the
/// browser extension (any chrome-extension:// or moz-extension:// id, which differs per build and per install).
/// Any other page would spend the doors' first-sight lookups from its visitors' addresses.
pub(crate) fn registration_origin_allowed(origin: Option<&str>) -> bool {
    const SITES: [&str; 2] = ["https://aiqnet.io", "https://www.aiqnet.io"];
    match origin {
        None => true,
        Some(o) => SITES.iter().any(|s| o.eq_ignore_ascii_case(s))
            || ["chrome-extension://", "moz-extension://"].iter().any(|scheme| {
                o.get(..scheme.len()).map_or(false, |p| p.eq_ignore_ascii_case(scheme))
                    && o.get(scheme.len()..).map_or(false, |id| !id.is_empty() && !id.contains('/'))
            }),
    }
}

/// The answer to a registration request from an origin `registration_origin_allowed` refuses: 403, in the
/// submit route's form, or for JSON-RPC (`rpc_id`) in its envelope.
fn origin_refused(rpc_id: Option<u64>) -> warp::reply::WithStatus<warp::reply::Json> {
    let body = match rpc_id {
        Some(id) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32005, "message": "Origin not allowed" } }),
        None => json!({ "success": false, "error": "Origin not allowed" }),
    };
    warp::reply::with_status(warp::reply::json(&body), warp::http::StatusCode::FORBIDDEN)
}

/// The caller as an IP-gated decision sees it: the operator methods and routes, the genesis-only internal
/// routes, the bundle cancel and the peer list. CORS lets any site send a request from its visitor's
/// browser, from the visitor's address - this host, its LAN, a whitelisted or a genesis address included -
/// so a request from a page is nobody in particular (0.0.0.0, as in forwarded_client). The rate limits
/// keep keying on client_addr.
fn gate_client(client: Option<std::net::SocketAddr>, from_page: bool) -> Option<std::net::SocketAddr> {
    if from_page {
        return Some(std::net::SocketAddr::new(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED), 0));
    }
    client
}

/// client_addr for the routes that answer only local, whitelisted or genesis callers (served outside the
/// CORS filter): gate_client of the request.
fn gate_addr() -> impl Filter<Extract = (Option<std::net::SocketAddr>,), Error = Rejection> + Clone {
    client_addr().and(from_page()).map(gate_client)
}

/// The paths of the gate_addr routes, which `start_rpc_server` serves outside the CORS filter. A preflight for
/// one is refused with no CORS headers (`gated_preflight`), so a page never sends a request there that needs
/// one, and the answer to any other carries no `Access-Control-Allow-Origin` a page could read it by.
const GATED_PATHS: &[&str] = &[
    "/api/v1/internal/",
    "/api/v1/p2p/message",
    "/api/v1/node-reactivation/submit",
    "/api/v1/shutdown",
];

fn is_gated_path(path: &str) -> bool {
    GATED_PATHS.iter().any(|p| if p.ends_with('/') { path.starts_with(p) } else { path == *p || path.strip_prefix(p) == Some("/") })
}

/// An `OPTIONS` request (a CORS preflight) for a gated path: 403 with no CORS headers, where the CORS filter
/// would answer it. The gated routes serve no `OPTIONS`; any other request passes on to the routes.
fn gated_preflight() -> impl Filter<Extract = (warp::reply::WithStatus<&'static str>,), Error = Rejection> + Clone {
    warp::options()
        .and(warp::path::full())
        .and_then(|path: warp::path::FullPath| async move {
            if is_gated_path(path.as_str()) {

                Ok(warp::reply::with_status("", warp::http::StatusCode::FORBIDDEN))
            } else {
                Err(warp::reject::not_found())
            }
        })
}

/// Helper function to check rate limit and return error response if exceeded
/// Bypasses rate limit for: whitelisted IPs, valid API keys
fn check_api_rate_limit(ip: Option<std::net::SocketAddr>, endpoint_type: &str) -> Result<(), warp::reply::Json> {
    api_rate_limit_retry(ip, endpoint_type).map_err(|retry_after| warp::reply::json(&rate_limit_body(retry_after)))
}

/// The per-address limit alone: Err carries the seconds to wait, for a route that answers in its own
/// form (the registration submit adds its stable `code`).
fn api_rate_limit_retry(ip: Option<std::net::SocketAddr>, endpoint_type: &str) -> Result<(), u64> {
    let ip_addr = match ip {
        Some(addr) => addr.ip(),
        None => return Ok(()), // Allow if no IP (shouldn't happen)
    };
    // SECURITY: Bypass rate limit for whitelisted IPs (localhost, explorer servers)
    if is_ip_whitelisted(ip_addr) {
        return Ok(());
    }
    let (allowed, retry_after) = API_RATE_LIMITER.check_rate_limit(ip_addr, endpoint_type);
    if allowed { Ok(()) } else { Err(retry_after) }
}

fn rate_limit_body(retry_after: u64) -> Value {
    json!({
        "success": false,
        "error": "Rate limit exceeded",
        "retry_after_seconds": retry_after,
        "message": format!("Too many requests. Please wait {} seconds before retrying.", retry_after)
    })
}

/// Extended rate limit check with API key support (for routes that accept X-API-Key header)
fn check_api_rate_limit_with_key(
    ip: Option<std::net::SocketAddr>, 
    api_key: Option<String>,
    endpoint_type: &str
) -> Result<(), warp::reply::Json> {
    // Check API key first
    if has_valid_api_key(api_key.as_deref()) {
        return Ok(());
    }
    
    // Fall back to IP-based check
    check_api_rate_limit(ip, endpoint_type)
}

// ============================================================================
// DYNAMIC NETWORK DETECTION - No timestamp dependency for robust deployment

/// SECURITY: Validate address with detailed error
fn validate_eon_address_with_error(address: &str) -> Result<(), String> {
    if address.len() != 45 {
        return Err(format!("Invalid address length: expected 45, got {}", address.len()));
    }
    // A byte length says nothing about char boundaries: a 45-BYTE string with a multi-byte char
    // straddling any slice index below panics, and the release profile aborts, so one unauthenticated
    // request would kill the node. Addresses are ASCII by construction — reject anything else here,
    // before any slicing.
    if !address.is_ascii() {
        return Err("Invalid address: non-ASCII characters".to_string());
    }

    if &address[19..22] != "eon" {
        return Err("Invalid address format: missing 'eon' marker at position 19".to_string());
    }
    
    let part1 = &address[0..19];
    let part2 = &address[22..37];
    let checksum = &address[37..45];

    let is_hex = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase());

    if !is_hex(part1) {
        return Err("Invalid address: part1 contains non-hex characters".to_string());
    }
    if !is_hex(part2) {
        return Err("Invalid address: part2 contains non-hex characters".to_string());
    }
    if !is_hex(checksum) {
        return Err("Invalid address: checksum contains non-hex characters".to_string());
    }

    // Verify SHA3-256 checksum (4 bytes = 32-bit collision resistance)
    let address_without_checksum = format!("{}eon{}", part1, part2);
    let computed_checksum = {
        use sha3::{Sha3_256, Digest};
        hex::encode(&Sha3_256::digest(address_without_checksum.as_bytes())[..4])
    };
    
    if checksum != computed_checksum {
        return Err(format!("Invalid checksum: expected {}, got {}", computed_checksum, checksum));
    }
    
    Ok(())
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct RpcRequest {
    jsonrpc: String,
    method: String,
    params: Option<Value>,
    id: u64,
}

#[derive(Debug, Serialize)]
struct RpcResponse {
    jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
    id: u64,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: i32,
    message: String,
    /// Optional structured payload (e.g. retry_after_secs for -32050 attest_pending).
    /// None serializes to nothing — wire byte-identical for every pre-existing error.
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NodeInfo {
    pub node_id: String,
    pub height: u64,
    pub peers: usize,
    pub mempool_size: usize,
    pub version: String,
    pub node_type: String,
    pub region: String,
}

/// Transaction request with MANDATORY signature verification
/// NIST/CISCO COMPLIANT: Ed25519 (FIPS 186-5) required for all transfers
#[derive(Debug, Deserialize)]
struct TransactionRequest {
    /// Sender's EON address
    from: String,
    /// Recipient's EON address
    to: String,
    /// Amount in nano QNC
    amount: u64,
    /// Gas price in nano QNC
    gas_price: u64,
    /// Gas limit
    gas_limit: u64,
    /// Nonce for replay protection
    nonce: u64,
    /// QUANTUM v2.25: Optional ML-DSA-65 signature for post-quantum security
    /// When present: TX is quantum-resistant, gas cost +50%
    /// Format: hex-encoded (~6618 chars for 3309 bytes)
    #[serde(default)]
    dilithium_signature: Option<String>,
    /// QUANTUM v2.25: ML-DSA-65 public key (required if dilithium_signature present)
    /// Format: hex-encoded (~3904 chars for 1952 bytes)
    #[serde(default)]
    dilithium_public_key: Option<String>,
}

/// v9.4: NodeReactivation submit request (for returning nodes)
/// Node sends this after sync to re-enter eligible producers set.
/// Unlike NodeRegistration (one-time), this can be sent on every restart/re-sync.
#[derive(Debug, Deserialize)]
struct NodeReactivationRequest {
    /// Node ID (e.g., "genesis_node_001" or "super_xyz")
    node_id: String,
    /// Current synced chain height
    current_height: u64,
    /// Hash of the latest macroblock the node has
    last_macroblock_hash: String,
    /// Index of the latest macroblock
    last_macroblock_index: u64,
    /// Public API endpoint to republish ("" hides the IP). Omitted ⇒ the node's own configured
    /// endpoint, so a restart on a new IP refreshes the committed address without an operator flag.
    #[serde(default)]
    api_endpoint: Option<String>,
}

/// v6.0: Client-created NodeRegistration TX submit request
/// Client signs: "q{chain}|client_node_reg:{node_id}:{wallet_address}:{registration_proof}:{timestamp}"
/// This endpoint accepts the signed TX and routes it directly to the current producer.
#[derive(Debug, Deserialize)]
pub(crate) struct NodeRegistrationClientRequest {
    /// EON wallet address of the node owner (= tx.from)
    from: String,
    /// Node pseudonym (from /api/v1/light-node/register response)
    node_id: String,
    /// "light" or "super"
    node_type: String,
    /// EON wallet address (same as from)
    wallet_address: String,
    /// Proof returned by /api/v1/light-node/register
    registration_proof: String,
    /// Unix timestamp used when signing (client must include exact value)
    timestamp: u64,
    /// Optional ML-DSA-65 signature for post-quantum security
    #[serde(default)]
    dilithium_signature: Option<String>,
    /// Optional ML-DSA-65 public key
    #[serde(default)]
    dilithium_public_key: Option<String>,
    /// Public API endpoint (Super nodes only; Light nodes always empty for privacy)
    #[serde(default)]
    #[allow(dead_code)]
    api_endpoint: Option<String>,
    /// Phase-1 burn proof: the Solana 1DEV burn backing this on-chain registration. The
    /// registration_proof = blake3(burn_tx_hash:node_id:wallet_address)[..32] ALREADY commits to
    /// burn_tx_hash (it is what the client signed), so the server binds the burn to the signed proof
    /// by recomputing it — no new signed field needed. Required for Light to pass burn-attestation.
    #[serde(default)]
    burn_tx_hash: Option<String>,
    #[serde(default)]
    burn_amount: Option<u64>,
    /// Solana address that performed the burn (committee verifies the on-chain burn against it).
    #[serde(default)]
    burn_wallet: Option<String>,
    /// Proof-of-ownership: Solana-key signature over the owner bind
    /// (`Transaction::burn_owner_bind_message`, or from the wallet_one_node gate `burn_owner_bind_message_v2`,
    /// which names no time), verified against `burn_wallet`. Binds the on-chain registration (which commits
    /// the node's IMMUTABLE Dilithium attestation root) to the wallet that actually burned — so an attacker
    /// cannot front-run a victim's first registration with the victim's public burn_tx and plant an
    /// attacker-owned key.
    #[serde(default)]
    owner_signature: Option<String>,
}

/// Query parameters for transaction history API
/// Supports pagination, filtering by type, and date range
#[derive(Debug, Deserialize)]
struct TransactionHistoryQuery {
    /// Wallet address to fetch transactions for (required)
    address: String,
    /// Page number (1-indexed, default: 1)
    #[serde(default = "default_page")]
    page: usize,
    /// Transactions per page (default: 20, max: 100)
    #[serde(default = "default_per_page")]
    per_page: usize,
    /// Filter by transaction type: "transfer", "reward", "activation", "heartbeat_commitment", "ping_commitment", "node_registration", "node_reactivation", "swap", "system", "all" (default: "all")
    #[serde(default = "default_tx_type")]
    tx_type: String,
    /// Filter by direction: "sent", "received", "all" (default: "all")
    #[serde(default = "default_direction")]
    direction: String,
    /// Start timestamp (Unix seconds, optional)
    start_time: Option<u64>,
    /// End timestamp (Unix seconds, optional)
    end_time: Option<u64>,
}

/// Block JSON as served by every block endpoint: the API block plus its consensus hash (hex), so a
/// consumer can verify linkage (previous_hash) without recomputing the preimage.
pub(super) fn block_json(block: &qnet_state::Block, hash: Option<[u8; 32]>) -> Value {
    let mut v = serde_json::to_value(block).unwrap_or_else(|_| json!({}));
    if let Some(obj) = v.as_object_mut() {
        obj.insert("hash".to_string(), hash.map(|h| json!(hex::encode(h))).unwrap_or(Value::Null));
    }
    v
}

/// /api/v1/blocks/headers?from=&limit= — limit is clamped to [1, 1000].
#[derive(Debug, Deserialize)]
pub(super) struct BlockHeadersQuery {
    #[serde(default)]
    pub(super) from: u64,
    #[serde(default = "default_headers_limit")]
    pub(super) limit: u64,
}

fn default_headers_limit() -> u64 { 100 }

/// /api/v1/archive?from_epoch=&limit= — limit is clamped to [1, 1000].
#[derive(Debug, Deserialize)]
pub(super) struct ArchiveListQuery {
    #[serde(default)]
    pub(super) from_epoch: u64,
    #[serde(default = "default_headers_limit")]
    pub(super) limit: u64,
}

/// Query parameters for global recent transactions
#[derive(Debug, Deserialize)]
struct RecentTransactionsQuery {
    /// Page number (1-indexed, default: 1)
    #[serde(default = "default_page")]
    page: usize,
    /// Transactions per page (default: 50, max: 100)
    #[serde(default = "default_per_page_50")]
    per_page: usize,
}

fn default_per_page_50() -> usize { 50 }

fn default_page() -> usize { 1 }
fn default_per_page() -> usize { 20 }
fn default_tx_type() -> String { "all".to_string() }
fn default_direction() -> String { "all".to_string() }

/// Batch transfer request with MANDATORY signature verification
/// NIST/CISCO COMPLIANT: Ed25519 (FIPS 186-5) required
#[derive(Debug, Deserialize)]
struct BatchTransferRequest {
    /// List of transfers in this batch
    transfers: Vec<TransferData>,
    /// Unique batch identifier
    batch_id: String,
    /// Sender nonce (committed nonce + 1); inside the signed preimage
    nonce: u64,
    gas_price: u64,
    gas_limit: u64,
    /// hex(raw 3309 B detached ML-DSA-65) over the batch canonical preimage
    dilithium_signature: String,
    /// hex(raw 1952 B); omit once the sender's pk is committed on-chain (elision)
    #[serde(default)]
    dilithium_public_key: Option<String>,
}

/// The inputs of the reference activation-code generator (`generate_quantum_activation_code`), held to the
/// contract KATs. The node serves no route that makes a code: the clients derive it, and the node verifies it.
#[cfg(test)]
struct GenerateActivationCodeRequest {
    /// The address the code encrypts: the burner's Solana address, or the wallet's own address.
    wallet_address: String,
    burn_tx_hash: String,
    node_type: String,
    burn_amount: u64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct TransferData {
    from: String, // Add from field for batch transfers
    to_address: String,
    amount: u64,
    memo: Option<String>,
}

// ============================================================================
// SMART CONTRACT API STRUCTURES
// ============================================================================

/// Request to deploy a new smart contract
/// NIST/CISCO COMPLIANT: MANDATORY post-quantum signature (CRYSTALS-ML-DSA-65 / ML-DSA-65)
/// Smart contracts are critical operations - require a valid Dilithium signature like consensus
#[derive(Debug, Deserialize)]
struct ContractDeployRequest {
    /// Deployer's EON address
    from: String,
    /// Base64-encoded WASM bytecode
    code: String,
    /// Constructor arguments as JSON
    constructor_args: Value,
    /// Gas limit for deployment
    gas_limit: u64,
    /// Gas price in nano QNC
    gas_price: u64,
    /// Nonce for replay protection
    nonce: u64,
    /// Dilithium signature (REQUIRED - NIST FIPS 204 post-quantum)
    /// MANDATORY for contract deployment - critical operation
    dilithium_signature: String,
    /// Dilithium public key (REQUIRED)
    dilithium_public_key: String,
}

/// Request to call a smart contract method
/// NIST/CISCO COMPLIANT: MANDATORY post-quantum ML-DSA-65 signature for state-changing calls
#[derive(Debug, Deserialize)]
struct ContractCallRequest {
    /// Caller's EON address
    from: String,
    /// Contract's EON address
    contract_address: String,
    /// Method name to call
    method: String,
    /// Method arguments as JSON
    args: Value,
    /// Gas limit for execution
    gas_limit: u64,
    /// Gas price in nano QNC
    gas_price: u64,
    /// Nonce for replay protection
    nonce: u64,
    /// Dilithium signature (REQUIRED for state-changing calls - NIST FIPS 204)
    #[serde(default)]
    dilithium_signature: Option<String>,
    /// Dilithium public key (REQUIRED for state-changing calls)
    #[serde(default)]
    dilithium_public_key: Option<String>,
    /// Is this a read-only view call? (no signatures required)
    #[serde(default)]
    is_view: bool,
}

/// Request to query contract state
#[derive(Debug, Deserialize)]
struct ContractStateQuery {
    /// State key to query
    key: Option<String>,
    /// Multiple keys to query
    keys: Option<Vec<String>>,
}

/// Query for GET /api/v1/logs — off-consensus contract event logs (the getLogs analogue).
#[derive(serde::Deserialize)]
struct ContractLogsQuery {
    /// Optional contract-address filter; omit for all contracts in the range.
    contract: Option<String>,
    /// Inclusive from-height (default 0).
    from: Option<u64>,
    /// Inclusive to-height (default = chain tip; the scan window is capped to from+500).
    to: Option<u64>,
}

// ContractInfo is now defined in storage.rs as StoredContractInfo
// Re-export for API compatibility
pub use crate::storage::StoredContractInfo as ContractInfo;

// ============================================================================
// WEBSOCKET SUBSCRIPTION STRUCTURES
// ============================================================================

/// WebSocket subscription query parameters
/// Example: ws://node:8001/ws/subscribe?channels=blocks,account:EON_ADDRESS,rewards:NODE_ID
#[derive(Debug, Deserialize)]
struct WsSubscribeQuery {
    /// Comma-separated list of channels to subscribe to
    /// Formats:
    ///   - "blocks" - all new blocks
    ///   - "account:ADDRESS" - balance updates for specific address
    ///   - "contract:ADDRESS" - events from specific contract
    ///   - "rewards:NODE_ID" - reward updates for specific node (v2.43.1)
    ///   - "mempool" - pending transactions
    ///   - "tx:HASH" - specific transaction confirmation
    #[serde(default)]
    channels: Option<String>,
}

/// Parsed subscription channel
#[derive(Debug, Clone)]
enum WsChannel {
    /// Subscribe to all new blocks
    Blocks,
    /// Subscribe to balance updates for specific address
    Account(String),
    /// Subscribe to events from specific contract
    Contract(String),
    /// Subscribe to mempool (pending transactions)
    Mempool,
    /// Subscribe to specific transaction confirmation
    Transaction(String),
    /// PRODUCTION v2.43.1: Subscribe to reward updates for specific node
    Rewards(String),
}

// ============================================================================
// PRODUCTION v2.43.1: BATCH & PAGINATION STRUCTURES
// ============================================================================

/// Request body for batch pending rewards
#[derive(Debug, Deserialize)]
struct BatchPendingRewardsRequest {
    node_ids: Vec<String>,
}

/// Query parameters for reward history with pagination
#[derive(Debug, Deserialize)]
struct RewardHistoryQuery {
    #[serde(default)]
    offset: Option<u32>,
    #[serde(default)]
    limit: Option<u32>,
}

/// Start comprehensive API server (JSON-RPC + REST)
pub async fn start_rpc_server(blockchain: BlockchainNode, port: u16) {
    let blockchain = Arc::new(blockchain);
    // The pending-binding index loads once, here: until it has, every light registration the chain
    // applies spawns a task to look (light_binding::pending_may_contain).
    {
        let storage = blockchain.get_storage();
        tokio::task::spawn_blocking(move || crate::light_binding::pending_index_init(&storage));
    }
    let blockchain_clone_for_filter = blockchain.clone();
    let blockchain_filter = warp::any().map(move || blockchain_clone_for_filter.clone());
    
    // JSON-RPC endpoints with rate limiting + API key support
    // X-API-Key header bypasses rate limit for authorized clients (Explorer, Admin)
    // SECURITY: Limit body size to 1MB to prevent payload attacks
    // Exactly /rpc: a proxy that refuses this path must not be bypassed by /rpc/<anything>.
    let rpc_path = warp::path("rpc")
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(1024 * 1024)) // 1MB max
        .and(warp::body::json())
        .and(client_addr())
        .and(from_page())
        .and(request_origin())
        .and(warp::header::optional::<String>("x-api-key"))
        .and(blockchain_filter.clone())
        .and_then(|request: RpcRequest, remote_addr: Option<std::net::SocketAddr>, from_page: bool, origin: Option<String>, api_key: Option<String>, blockchain: Arc<BlockchainNode>| async move {
            // The burn attestor answers the registration doors' origins only (registration_origin_allowed).
            if request.method == "node_attestBurn" && !registration_origin_allowed(origin.as_deref()) {
                return Ok::<_, Rejection>(origin_refused(Some(request.id)).into_response());
            }
            // SECURITY: Rate limit ALL JSON-RPC methods (bypass with valid API key)
            let method = &request.method;
            let limit_category = match method.as_str() {
                "tx_submit" | "tx_sendTransaction" | "mempool_submit" | "device_migration" => "write",
                _ => "read_only",
            };
            if let Err(rate_limit_response) = check_api_rate_limit_with_key(remote_addr, api_key, limit_category) {
                return Ok::<_, Rejection>(rate_limit_response.into_response());
            }
            handle_rpc(request, remote_addr, from_page, blockchain).await.map(|r| r.into_response())
        });

    let root_path = warp::path::end()
        .and(warp::post())
        .and(warp::body::content_length_limit(1024 * 1024)) // 1MB max
        .and(warp::body::json())
        .and(client_addr())
        .and(from_page())
        .and(request_origin())
        .and(warp::header::optional::<String>("x-api-key"))
        .and(blockchain_filter.clone())
        .and_then(|request: RpcRequest, remote_addr: Option<std::net::SocketAddr>, from_page: bool, origin: Option<String>, api_key: Option<String>, blockchain: Arc<BlockchainNode>| async move {
            // The burn attestor answers the registration doors' origins only (registration_origin_allowed).
            if request.method == "node_attestBurn" && !registration_origin_allowed(origin.as_deref()) {
                return Ok::<_, Rejection>(origin_refused(Some(request.id)).into_response());
            }
            // SECURITY: Rate limit ALL JSON-RPC methods (bypass with valid API key)
            let method = &request.method;
            let limit_category = match method.as_str() {
                "tx_submit" | "tx_sendTransaction" | "mempool_submit" | "device_migration" => "write",
                _ => "read_only",
            };
            if let Err(rate_limit_response) = check_api_rate_limit_with_key(remote_addr, api_key, limit_category) {
                return Ok::<_, Rejection>(rate_limit_response.into_response());
            }
            handle_rpc(request, remote_addr, from_page, blockchain).await.map(|r| r.into_response())
        });
    
    // REST API endpoints (new)
    let api_v1 = warp::path("api").and(warp::path("v1"));
    
    // Height endpoint (for peer sync) - RATE LIMITED v3.19
    let chain_height = api_v1
        .and(warp::path("height"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(|remote_addr: Option<std::net::SocketAddr>, blockchain: Arc<BlockchainNode>| async move {
            // v3.19: Rate limiting for DDoS protection
            if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
                return Ok::<_, Rejection>(rate_limit_response.into_response());
            }
            // The node-wide budget (M-6, light_push::HEIGHT_READ_BUDGET): past it a 503 with a wait.
            let mut permit = None;
            if let Some(shed) = shed_past(&HEIGHT_READ_BUDGET, remote_addr, &mut permit) {
                return Ok::<_, Rejection>(shed);
            }

            let height = blockchain.get_height().await;

            // API DEADLOCK FIX: Use cached network height to avoid circular HTTP calls
            let mut network_height = height;
            
            // CRITICAL FIX: Use real synchronization status from node
            let is_syncing = blockchain.is_syncing();
            
            if let Some(p2p) = blockchain.get_unified_p2p() {
                // API DEADLOCK FIX: Get cached height without network calls
                // PRODUCTION v2.53: Use max(local, cached) to prevent stale cache showing lower height
                if let Some(cached_height) = p2p.get_cached_network_height() {
                    network_height = std::cmp::max(height, cached_height);
                } else {
                    // No cache available - check if we're bootstrap node
                    if std::env::var("QNET_BOOTSTRAP_ID").is_ok() || 
                       std::env::var("QNET_GENESIS_BOOTSTRAP").unwrap_or_default() == "1" {
                        // Genesis node in bootstrap mode - use local height as network height
                        network_height = height;
                    } else {
                        // Regular node without cache - use local height
                        println!("[API] No cached network height available, using local height");
                    }
                }
            }
            
            Ok::<_, Rejection>(warp::reply::json(&json!({
                "height": height,
                "network_height": network_height,
                "is_syncing": is_syncing,
                "blocks_behind": network_height.saturating_sub(height)
            })).into_response())
        });
    
    // Microblock by height
    let microblock_one = api_v1
        .and(warp::path("microblock"))
        .and(warp::path::param::<u64>())
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(|height: u64, blockchain: Arc<BlockchainNode>| async move {
            // API FIX: Check if height is valid
            let current_height = blockchain.get_height().await;
            if height > current_height {
                // API FIX: Return proper error for future blocks
                return Ok::<_, Rejection>(warp::reply::with_status(
                    warp::reply::json(&json!({
                        "error": "Block not yet produced",
                        "requested_height": height,
                        "current_height": current_height
                    })),
                    warp::http::StatusCode::NOT_FOUND
                ));
            }
            
            match blockchain.get_block_with_hash(height).await {
                Ok(Some((block, hash))) => {
                    Ok::<_, Rejection>(warp::reply::with_status(
                        warp::reply::json(&block_json(&block, hash)),
                        warp::http::StatusCode::OK
                    ))
                },
                Ok(None) => {
                    // Block not found
                    Ok::<_, Rejection>(warp::reply::with_status(
                        warp::reply::json(&json!({
                            "error": "Block not found",
                            "height": height,
                            "exists": false
                        })),
                        warp::http::StatusCode::NOT_FOUND
                    ))
                },
                Err(e) => {
                    println!("[WARN][RPC] api_error endpoint=microblock height={} err={}", height, e);
                    Ok::<_, Rejection>(warp::reply::with_status(
                        warp::reply::json(&json!({
                            "error": "Failed to load block",
                            "height": height,
                            "message": "internal error"
                        })),
                        warp::http::StatusCode::INTERNAL_SERVER_ERROR
                    ))
                }
            }
        });
    
    // Microblocks by range
    let microblocks_range = api_v1
        .and(warp::path("microblocks"))
        .and(warp::query::<std::collections::HashMap<String, String>>())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(|params: std::collections::HashMap<String, String>, blockchain: Arc<BlockchainNode>| async move {
            let from = params.get("from").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            let to = params.get("to").and_then(|s| s.parse::<u64>().ok()).unwrap_or(from);
            let to = to.min(from.saturating_add(100)); // Cap range to 100 blocks max
            let mut items = Vec::new();
            for h in from..=to {
                if let Ok(Some(data)) = blockchain.load_microblock_bytes(h) {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                    items.push(json!({"height": h, "data": b64}));
                }
            }
            Ok::<_, Rejection>(warp::reply::json(&json!({"from": from, "to": to, "items": items})))
        });
    
    // Compact headers for indexers. The hash comes from the height→hash index and outlives the body;
    // body fields are present inside the retention window, and past it where this node's archive holds the block.
    let blocks_headers = api_v1
        .and(warp::path("blocks"))
        .and(warp::path("headers"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<BlockHeadersQuery>())
        .and(client_addr())
        .and(warp::header::optional::<String>("x-api-key"))
        .and(blockchain_filter.clone())
        .and_then(handle_block_headers);

    // History archive (nodes started with QNET_ARCHIVE=1): the segment index and one segment file.
    let archive_list = api_v1
        .and(warp::path("archive"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<ArchiveListQuery>())
        .and(client_addr())
        .and(warp::header::optional::<String>("x-api-key"))
        .and(blockchain_filter.clone())
        .and_then(handle_archive_list);
    let archive_segment = api_v1
        .and(warp::path("archive"))
        .and(warp::path("segment"))
        .and(warp::path::param::<u64>())
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(warp::header::optional::<String>("x-api-key"))
        .and(blockchain_filter.clone())
        .and_then(handle_archive_segment);

    // Account endpoints
    let account_info = api_v1
        .and(warp::path("account"))
        .and(warp::path::param::<String>())
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_account_info);
    
    // Account endpoints - RATE LIMITED v3.19
    let account_balance = api_v1
        .and(warp::path("account"))
        .and(warp::path::param::<String>())
        .and(warp::path("balance"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_account_balance);
    
    // GET /api/v1/account/{address}/balance/proof[?mb=latest|<j>]: with `mb`, the certified form over
    // the view of macroblock j (certified_proofs.rs); without it, the legacy body. The query is read as
    // raw pairs, which never rejects, so a duplicate or malformed `mb` gets a typed 400.
    let account_balance_proof = api_v1
        .and(warp::path("account"))
        .and(warp::path::param::<String>())
        .and(warp::path("balance"))
        .and(warp::path("proof"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<Vec<(String, String)>>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_account_balance_proof_route);

    // GET /api/v1/token/{contract}/{holder}/balance/proof[?mb=latest|<j>]: two-level QRC-20 balance
    // proof, certified with `mb`, legacy without it.
    let token_balance_proof = api_v1
        .and(warp::path("token"))
        .and(warp::path::param::<String>())
        .and(warp::path::param::<String>())
        .and(warp::path("balance"))
        .and(warp::path("proof"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<Vec<(String, String)>>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_token_balance_proof_route);

    // GET /api/v1/state/certified: the views this node serves and its three heights, kept apart.
    let state_certified = api_v1
        .and(warp::path("state"))
        .and(warp::path("certified"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_state_certified);

    // v3.32: Validator set with Merkle proof for trustless light clients
    let validators_proof = api_v1
        .and(warp::path("validators"))
        .and(warp::path("proof"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_validators_with_proof);
    
    let account_transactions = api_v1
        .and(warp::path("account"))
        .and(warp::path::param::<String>())
        .and(warp::path("transactions"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_account_transactions);

    // One shard of an epoch's reward leaf-set, so a node with a gap can rebuild it from a peer. Safe to
    // serve to anyone: the caller verifies what it assembles against its own certified reward_root.
    // GET /api/v1/rewards/epoch/{epoch}/leafset?shard=N
    let epoch_leafset = api_v1
        .and(warp::path("rewards"))
        .and(warp::path("epoch"))
        .and(warp::path::param::<u64>())
        .and(warp::path("leafset"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<LeafsetQuery>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_epoch_leafset);

    // Permanent node-lifecycle feed: the registration TX is pruned with the rest of the tx index, but
    // the registry row behind it is not, so a wallet keeps its own activation in view.
    // GET /api/v1/account/{address}/node-events
    let account_node_events = api_v1
        .and(warp::path("account"))
        .and(warp::path::param::<String>())
        .and(warp::path("node-events"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_account_node_events);

    // Decoded token-transfer feeds (effect-sourced, success-gated) — P2.
    // GET /api/v1/account/{address}/token-transfers?limit=&before=
    let account_token_transfers = api_v1
        .and(warp::path("account"))
        .and(warp::path::param::<String>())
        .and(warp::path("token-transfers"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<TokenTransfersQuery>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_account_token_transfers);

    // GET /api/v1/token/{contract}/transfers?limit=&before=
    let token_transfers_feed = api_v1
        .and(warp::path("token"))
        .and(warp::path::param::<String>())
        .and(warp::path("transfers"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<TokenTransfersQuery>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_token_transfers);

    // GET /api/v1/token-transfers?from=&to=&limit= — height-range decoded transfers (explorer ingest).
    let token_transfers_range = api_v1
        .and(warp::path("token-transfers"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<TokenTransfersRangeQuery>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_token_transfers_range);

    // GET /api/v1/logs/proof?tx_hash=&log_index= — P4 light-client transfer inclusion proof.
    let log_proof = api_v1
        .and(warp::path("logs"))
        .and(warp::path("proof"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<LogProofQuery>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_log_proof);

    // Extended transaction history with pagination and filters
    // GET /api/v1/transactions/history?address=XXX&page=1&per_page=20&type=transfer
    let transaction_history = api_v1
        .and(warp::path("transactions"))
        .and(warp::path("history"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<TransactionHistoryQuery>())
        .and(blockchain_filter.clone())
        .and_then(handle_transaction_history);
    
    // Global recent transactions (paginated, newest first), from the newest blocks only
    // GET /api/v1/transactions/recent?page=1&per_page=50
    let transactions_recent = api_v1
        .and(warp::path("transactions"))
        .and(warp::path("recent"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<RecentTransactionsQuery>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_recent_transactions);
    
    // Block endpoints - RATE LIMITED v3.19
    let block_latest = api_v1
        .and(warp::path("block"))
        .and(warp::path("latest"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_block_latest);
    
    let block_by_height = api_v1
        .and(warp::path("block"))
        .and(warp::path::param::<u64>())
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_block_by_height);

    // Cold-join genesis fetch: serves the canonical stored block-0 bytes verbatim (bincode MicroBlock)
    // so a joiner's binary fetch decodes byte-identically — no JSON reformatting that would diverge hash.
    let genesis_block = api_v1
        .and(warp::path("genesis"))
        .and(warp::path("block"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_genesis_block);

    let block_by_hash = api_v1
        .and(warp::path("block"))
        .and(warp::path("hash"))
        .and(warp::path::param::<String>())
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_block_by_hash);
    
    // Macroblock endpoint - RATE LIMITED v3.19
    let macroblock_by_index = api_v1
        .and(warp::path("macroblock"))
        .and(warp::path::param::<u64>())
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_macroblock_by_index);

    // Light-client QC proof: /macroblock/{idx}/proof (cacheable, immutable per index)
    let macroblock_proof = api_v1
        .and(warp::path("macroblock"))
        .and(warp::path::param::<u64>())
        .and(warp::path("proof"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_macroblock_proof);

    // Light-client registry dump as of a height: /registry/height/{h}
    let registry_height = api_v1
        .and(warp::path("registry"))
        .and(warp::path("height"))
        .and(warp::path::param::<u64>())
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_registry_height);

    // One-shot consensus health snapshot. The 41100 diagnosis needed correlating five servers' logs;
    // these scalars make the primary signals (last_sealed growing, floor <= own window) a single GET.
    let debug_consensus_position = api_v1
        .and(warp::path("debug"))
        .and(warp::path("consensus-position"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_debug_consensus_position);
    
    // Snapshot endpoints - For P2P Fast Sync (v2.19.12)
    // GET /api/v1/snapshot/latest - Get latest snapshot info
    let snapshot_latest = api_v1
        .and(warp::path("snapshot"))
        .and(warp::path("latest"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(warp::query::<std::collections::HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_snapshot_latest);

    // GET /api/v1/snapshot/{height} - Download snapshot binary
    let snapshot_download = api_v1
        .and(warp::path("snapshot"))
        .and(warp::path::param::<u64>())
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_snapshot_download);

    // v5.0: GET /api/v1/snapshot/{height}/manifest - Chunk manifest for parallel download
    let snapshot_manifest = api_v1
        .and(warp::path("snapshot"))
        .and(warp::path::param::<u64>())
        .and(warp::path("manifest"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_snapshot_manifest);

    // v5.0: GET /api/v1/snapshot/{height}/chunk/{index} - Download specific chunk
    let snapshot_chunk = api_v1
        .and(warp::path("snapshot"))
        .and(warp::path::param::<u64>())
        .and(warp::path("chunk"))
        .and(warp::path::param::<usize>())
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_snapshot_chunk);

    // v15.10: Cross-shard RPC endpoint removed — sharding deactivated.
    // The dormant scaffolding lives in `qnet_consensus::cross_shard`
    // for future re-activation if the architectural decision changes.

    // Transaction endpoints with IP-based rate limiting
    // SECURITY: Limit transaction body to 64KB (typical TX is <1KB)
    let transaction_submit = api_v1
        .and(warp::path("transaction"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(64 * 1024)) // 64KB max
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_transaction_submit);
    
    // v6.0: Client-created NodeRegistration TX submit (producer-aware routing)
    let node_registration_submit = api_v1
        .and(warp::path("node-registration"))
        .and(warp::path("submit"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(128 * 1024)) // 128KB (Dilithium sig is large)
        .and(request_origin())
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(|origin: Option<String>, req: NodeRegistrationClientRequest, remote_addr: Option<std::net::SocketAddr>,
                   blockchain: Arc<BlockchainNode>| async move {
            // Only the registration doors' origins (registration_origin_allowed), before any work.
            if !registration_origin_allowed(origin.as_deref()) {
                return Ok::<_, Rejection>(origin_refused(None).into_response());
            }
            handle_node_registration_client_submit(req, remote_addr, blockchain).await.map(|r| r.into_response())
        });

    // v9.4: NodeReactivation TX submit (returning nodes re-enter eligible producers)
    let node_reactivation_submit = api_v1
        .and(warp::path("node-reactivation"))
        .and(warp::path("submit"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(16 * 1024)) // 16KB max
        .and(warp::body::json())
        .and(gate_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_node_reactivation_submit);

    // O15: the value TX a wallet signed at a nonce, pending or confirmed, whatever hash its copy carries.
    let transaction_by_nonce = api_v1
        .and(warp::path("transaction"))
        .and(warp::path("by-nonce"))
        .and(warp::path::param::<String>())
        .and(warp::path::param::<u64>())
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_transaction_by_nonce);

    // Transaction get - RATE LIMITED v3.19
    let transaction_get = api_v1
        .and(warp::path("transaction"))
        .and(warp::path::param::<String>())
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_transaction_get);
    
    // Mempool endpoints - RATE LIMITED v3.19
    let mempool_status = api_v1
        .and(warp::path("mempool"))
        .and(warp::path("status"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_mempool_status);
    
    let mempool_transactions = api_v1
        .and(warp::path("mempool"))
        .and(warp::path("transactions"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(warp::query::<HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_mempool_transactions);
    
    // MEV PROTECTION: Bundle endpoints for private transaction submission
    // ARCHITECTURE: Flashbots-style bundles with 0-20% dynamic allocation
    let bundle_submit = api_v1
        .and(warp::path("bundle"))
        .and(warp::path("submit"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(256 * 1024)) // 256 KB max bundle payload
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_bundle_submit);

    let bundle_status = api_v1
        .and(warp::path("bundle"))
        .and(warp::path::param::<String>())
        .and(warp::path("status"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_bundle_status);

    let bundle_cancel = api_v1
        .and(warp::path("bundle"))
        .and(warp::path::param::<String>())
        .and(warp::path::end())
        .and(warp::delete())
        .and(client_addr())
        .and(from_page())
        .and(blockchain_filter.clone())
        .and_then(handle_bundle_cancel)
        .boxed();
    
        // Peer discovery endpoint (for P2P network) - BIDIRECTIONAL REGISTRATION
        // v30.B3: rate-limited per source IP. Until v30 this endpoint was the
        // single most attractive enumeration / DoS target — attacker could
        // hammer GET /api/v1/peers without throttling, saturating the warp
        // TCP accept queue and starving legitimate inter-genesis HTTP queries
        // (visible as `[ERR][P2P] Request failed ... operation timed out`
        // across all genesis nodes during the 198.36.48.234 incident).
    let peers_endpoint = api_v1
        .and(warp::path("peers"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(warp::header::headers_cloned())
        .and(blockchain_filter.clone())
        .and_then(|remote_addr: Option<std::net::SocketAddr>, _headers: warp::http::HeaderMap, blockchain: Arc<BlockchainNode>| async move {
            if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
                return Ok::<_, Rejection>(rate_limit_response.into_response());
            }

            // FIX v2.92: REMOVED auto-registration of API clients as peers
            // PROBLEM: Any browser/explorer making API request was added as P2P peer
            // This caused nodes to endlessly try connecting to non-node IPs
            // leading to network split and emergency failover cascade
            //
            // CORRECT BEHAVIOR: Only nodes that explicitly register via /api/v1/register
            // with valid signatures should become peers

            // Return current peer list
            let peers = blockchain.get_connected_peers().await.unwrap_or_default();
            
            // API FIX: Filter out invalid peers and calculate correct last_seen
            let current_time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            
            // Reputation display value — floor under the deterministic model (RAM engine removed).
            let mut peer_list: Vec<serde_json::Value> = peers.iter()
                .filter(|peer| {
                    // API FIX: Filter out peers with invalid addresses
                    !peer.address.is_empty() && 
                    peer.address.contains(':') &&
                    !peer.address.starts_with("0.0.0.0")
                })
                .map(|peer| {
                    let last_seen_timestamp = peer.last_seen;
                    let real_reputation = qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
                    
                    json!({
                        "id": peer.id,
                        "address": peer.address,
                        "node_type": peer.node_type,
                        "region": peer.region,
                        "last_seen": last_seen_timestamp,
                        "reputation": real_reputation, // v3.19: From blockchain, not P2P cache!
                        "version": peer.version
                    })
                }).collect();
            
            // P2P FIX: Include Genesis bootstrap peers ONLY for initial bootstrap
            // SCALABILITY: Only help nodes with very few peers to avoid Genesis overload
            // In production with millions of nodes, Genesis nodes should NOT be contacted by everyone
            if peers.len() < 3 {  // SCALABILITY: Only for nodes with < 3 peers (initial bootstrap)
                use crate::unified_p2p::get_genesis_bootstrap_ips;
                let genesis_ips = get_genesis_bootstrap_ips();
                
                // SCALABILITY: Only return 2 random Genesis nodes, not all 5
                // This prevents Genesis nodes from being overwhelmed when millions join
                let mut selected_genesis = Vec::new();
                let max_genesis_to_return = std::cmp::min(2, genesis_ips.len());
                
                for (idx, ip) in genesis_ips.iter().enumerate().take(max_genesis_to_return) {
                    let genesis_addr = format!("{}:8001", ip);
                    let genesis_id = format!("genesis_node_{:03}", idx + 1);
                    // Check if not already in list
                    let already_exists = peers.iter().any(|p| p.address == genesis_addr);
                    if !already_exists {
                        let real_reputation = qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
                        selected_genesis.push(json!({
                            "id": genesis_id,
                            "address": genesis_addr,
                            "node_type": "Super",
                            "region": "Global",
                            "last_seen": current_time, // Genesis nodes are always active
                            "reputation": real_reputation, // Real reputation from blockchain
                            "version": "qnet-v1.0" // Include version
                        }));
                    }
                }
                
                peer_list.extend(selected_genesis);
            }
            
            // API FIX: Include summary statistics
            let total_peers = peer_list.len();
            // v3.18: Full nodes removed - "Full" mapped to Super for backward compatibility
            let super_nodes = peer_list.iter().filter(|p| p["node_type"] == "Super" || p["node_type"] == "Full").count();
            let full_nodes = 0; // v3.18: Always 0 (Full node type removed)
            let light_nodes = peer_list.iter().filter(|p| p["node_type"] == "Light").count();
            
            println!("[API] 📊 Peers request: returning {} peers (Super:{}, Full:{}, Light:{})", 
                     total_peers, super_nodes, full_nodes, light_nodes);
            
            Ok::<_, Rejection>(warp::reply::json(&json!({
                "peers": peer_list,
                "total": total_peers, // API FIX: Include total count
                "statistics": { // API FIX: Include node type breakdown
                    "super_nodes": super_nodes,
                    "full_nodes": full_nodes, // v3.18: Always 0 (Full node type removed)
                    "light_nodes": light_nodes
                }
            })).into_response())
        });

    // Batch operations endpoints
    
    let batch_transfer = api_v1
        .and(warp::path("batch"))
        .and(warp::path("transfer"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(256 * 1024)) // 256 KB max batch payload
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_batch_transfer);
    
    // Node discovery endpoints
    // FIX M13: Add rate limiting to discovery/health endpoints
    let node_discovery = api_v1
        .and(warp::path("nodes"))
        .and(warp::path("discovery"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(from_page())
        .and(blockchain_filter.clone())
        .and_then(handle_node_discovery);

    let node_health = api_v1
        .and(warp::path("node"))
        .and(warp::path("health"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_node_health);

    // Gas recommendation endpoints
    // FIX M13: Add rate limiting to gas recommendations
    let gas_recommendations = api_v1
        .and(warp::path("gas"))
        .and(warp::path("recommendations"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_gas_recommendations);
    
    // P2P Authentication endpoint for quantum-secure peer verification
    // FIX M13: Add rate limiting to auth challenge (write category)
    let auth_challenge = api_v1
        .and(warp::path("auth"))
        .and(warp::path("challenge"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(16 * 1024)) // 16KB max
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_auth_challenge);

    // Network ping endpoint for reward system (quantum-secure)
    // FIX M13: Add rate limiting to ping (write category — triggers signing)
    let network_ping = api_v1
        .and(warp::path("ping"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(16 * 1024)) // 16KB max
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_network_ping);

    // Light node registration endpoint (with rate limiting)
    let light_node_register = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("register"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(64 * 1024)) // 64KB max
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_light_node_register);

    // Light node binding v2: a fresh signed binding to one device (U2/U3), or a pending one for a
    // registration not applied yet (U4). Two keys, two signatures and a consent (~28 KB in hex), plus
    // the device block (a platform attestation object or key chain, ~8 KB) and a vendor token (up to 16 KB).
    let light_node_bind = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("bind"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(96 * 1024))
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_light_node_bind);

    // Unbind (U6): one signature and a wallet key, plus room for the device layer's release block.
    let light_node_unbind = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("unbind"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(32 * 1024))
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_light_node_unbind);

    // "I'm back" (U11): a node id.
    let light_node_wake = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("wake"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(4 * 1024))
        .and(warp::body::json())
        .and(client_addr())
        .and(from_page())
        .and(blockchain_filter.clone())
        .and_then(handle_light_node_wake);

    // Light node ping response endpoint (GET for legacy, POST for the large ML-DSA-65 signatures)
    let light_node_ping_response_get = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("ping-response"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_light_node_ping_response);

    let light_node_ping_response_post = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("ping-response"))
        .and(warp::path::end())
        .and(warp::post())
        // This route exists BECAUSE the signatures are large, so the cap has to admit them. The
        // body carries two enveloped ML-DSA-65 signatures plus a public key, and the envelope
        // embeds its own message: challenge signature ~7.2 KB, delegation cert ~12.4 KB (its
        // message is the hex ping pubkey), ping_pubkey 3.9 KB => ~23.6 KB. At 16 KB warp rejected
        // every ping response before the handler ran, taking the push AND self-attest liveness
        // paths with it. 64 KB matches light-node/register, which carries the same cert.
        .and(warp::body::content_length_limit(64 * 1024))
        // A map of strings; the timing fields (light-node-messages 5.10) are taken as numbers too.
        .and(warp::body::json::<HashMap<String, Value>>().map(answer_fields))
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_light_node_ping_response);

    // Light node status endpoint (check if active/inactive) — rate-limited: it can
    // trigger an outbound shard-owner proxy hop, so it must not be free to hammer.
    let light_node_status = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("status"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_light_node_status);

    // The signed status: the public fields plus what only the node's ping key or wallet key may read
    // (binding sequence, registration record, device state). One ML-DSA-65 signature and an optional
    // wallet key in hex, so 16 KB is ample.
    let light_node_status_signed = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("status"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(16 * 1024))
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_light_node_status_signed);

    // Server node status endpoint (Super-node monitoring, including Genesis bootstrap nodes)
    let server_node_status = api_v1
        .and(warp::path("node"))
        .and(warp::path("status"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        // Privacy: the wallet address may arrive in a header (kept out of the URL /
        // access logs / caches) instead of ?wallet=. Query stays as fallback.
        .and(warp::header::optional::<String>("x-qnet-wallet"))
        .and(blockchain_filter.clone())
        .and_then(handle_server_node_status);

    // Light node next ping time endpoint (for polling fallback)
    let light_node_next_ping = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("next-ping"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        .and_then(handle_light_node_next_ping);

    // Light node pending challenge endpoint (for polling fallback), under the read-only per-address limit (L-5).
    let light_node_pending_challenge = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("pending-challenge"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_light_node_pending_challenge);

    // Reward claiming endpoint for all node types (with rate limiting)
    let claim_rewards = api_v1
        .and(warp::path("rewards"))
        .and(warp::path("claim"))
        .and(warp::path::end())
        .and(warp::post())
        // Step 2 echoes the quoted claims_data back, so the body carries the merkle proofs plus two
        // ML-DSA-65 envelopes. Must exceed CLAIM_QUOTE_BYTE_BUDGET + that overhead, or a wallet with
        // many unclaimed epochs would be rejected by the filter before the handler ever sees it.
        .and(warp::body::content_length_limit(256 * 1024))
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_claim_rewards);
    
    // Get pending rewards endpoint (with rate limiting)
    let pending_rewards = api_v1
        .and(warp::path("rewards"))
        .and(warp::path("pending"))
        .and(warp::path::param::<String>()) // node_id
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_get_pending_rewards);
    
    // PRODUCTION v2.43.1: Get reward history by epochs (with rate limiting + pagination)
    let reward_history = api_v1
        .and(warp::path("rewards"))
        .and(warp::path("history"))
        .and(warp::path::param::<String>()) // node_id
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<RewardHistoryQuery>()) // ?offset=0&limit=10
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_get_reward_history);
    
    // PRODUCTION v2.43.1: Get detailed pool breakdown (Pool1/Pool2/Pool3) (with rate limiting)
    let reward_pools = api_v1
        .and(warp::path("rewards"))
        .and(warp::path("pools"))
        .and(warp::path::param::<String>()) // node_id
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_get_reward_pools);
    
    // PRODUCTION v2.43.1: Get all nodes for a wallet address
    let rewards_by_wallet = api_v1
        .and(warp::path("rewards"))
        .and(warp::path("by-wallet"))
        .and(warp::path::param::<String>()) // wallet_address
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_get_rewards_by_wallet);
    
    // PRODUCTION v2.43.1: Batch get pending rewards for multiple nodes
    let rewards_pending_batch = api_v1
        .and(warp::path("rewards"))
        .and(warp::path("pending"))
        .and(warp::path("batch"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(64 * 1024)) // 64KB max
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_get_pending_rewards_batch);
    
    // PRODUCTION v2.43.1: Network-wide reward statistics
    let rewards_network_stats = api_v1
        .and(warp::path("rewards"))
        .and(warp::path("network"))
        .and(warp::path("stats"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_get_reward_network_stats);
    
    // PRODUCTION v2.43.1: Node lifetime reward summary (aggregated stats)
    let rewards_summary = api_v1
        .and(warp::path("rewards"))
        .and(warp::path("summary"))
        .and(warp::path::param::<String>()) // node_id
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_get_reward_summary);
    
    // Node registration endpoint
    let register_node = api_v1
        .and(warp::path("nodes"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(64 * 1024))
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_register_node);

    // Activation codes by wallet endpoint for bridge-server queries
    let activations_by_wallet = api_v1
        .and(warp::path("activations"))
        .and(warp::path("by-wallet"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        .and(warp::header::optional::<String>("x-qnet-wallet"))
        .and(blockchain_filter.clone())
        .and_then(handle_activations_by_wallet);

    // On-chain activation verification endpoint (for mobile wallet)
    let verify_activation = api_v1
        .and(warp::path("verify-activation"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        .and(warp::header::optional::<String>("x-qnet-wallet"))
        .and(blockchain_filter.clone())
        .and_then(handle_verify_activation_onchain);

    // v4.9: Node device check — used by super nodes to detect migration
    // GET /api/v1/node-device?node_id=xxx (v10.0: rate-limited)
    let node_device_check = api_v1
        .and(warp::path("node-device"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(warp::query::<HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_node_device_check);

    // v4.9: Register device_id for node (called by super nodes on startup)
    // POST /api/v1/register-device { node_id, device_id } (v10.0: rate-limited)
    let register_device = api_v1
        .and(warp::path("register-device"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(16 * 1024)) // 16KB max
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_register_device);

    // FIX L-L7: Graceful shutdown endpoint — IP restriction + rate limiting
    let graceful_shutdown = api_v1
        .and(warp::path("shutdown"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(4 * 1024)) // 4KB max
        .and(warp::body::json())
        .and(gate_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_graceful_shutdown);

    // ===== MONITORING AND DIAGNOSTIC ENDPOINTS =====
    
    // Failover history endpoint
    // FIX R25-M1: add remote_addr + rate limiting to failover endpoints
    let failover_history = api_v1
        .and(warp::path("failovers"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(warp::query::<HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_failover_history);

    // Network failovers endpoint (alias for compatibility)
    let network_failovers = api_v1
        .and(warp::path("network"))
        .and(warp::path("failovers"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(warp::query::<HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_failover_history);
    
    // General statistics endpoint - RATE LIMITED v3.19
    let stats_endpoint = api_v1
        .and(warp::path("stats"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_stats);
    
    // Producer status endpoint - RATE LIMITED v3.19
    let producer_status = api_v1
        .and(warp::path("producer"))
        .and(warp::path("status"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_producer_status);
    
    // Sync status detailed endpoint - RATE LIMITED v3.19
    let sync_status = api_v1
        .and(warp::path("sync"))
        .and(warp::path("status"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_sync_status);
    
    // ============================================================================
    // PUBLIC ENDPOINTS: Cached + Rate limited for DDoS protection
    // ============================================================================
    
    // PUBLIC: Network stats for website (cached 10 minutes) - RATE LIMITED v3.19
    let public_stats = api_v1
        .and(warp::path("public"))
        .and(warp::path("stats"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_public_stats);
    
    // PUBLIC: Activation price (server calculates, client just displays)
    // No network size exposure - server knows everything
    let activation_price = api_v1
        .and(warp::path("activation"))
        .and(warp::path("price"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_activation_price);
    
    // Network diagnostics endpoint (rate-limited)
    let network_diagnostics = api_v1
        .and(warp::path("diagnostics"))
        .and(warp::path("network"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_network_diagnostics);

    // Block production statistics (rate-limited)
    let block_stats = api_v1
        .and(warp::path("blocks"))
        .and(warp::path("stats"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_block_statistics);

    // Shred Protocol metrics endpoint (rate-limited)
    let shred_protocol_metrics = api_v1
        .and(warp::path("shred-protocol"))
        .and(warp::path("metrics"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_shred_protocol_metrics);

    // Parallel Executor pipeline metrics endpoint (rate-limited)
    let parallel_executor_metrics = api_v1
        .and(warp::path("parallel-executor"))
        .and(warp::path("metrics"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_parallel_executor_metrics);

    // Pre-execution cache status endpoint (rate-limited)
    let pre_execution_status = api_v1
        .and(warp::path("pre-execution"))
        .and(warp::path("status"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_pre_execution_status);

    // Adaptive BFT timeout info endpoint (rate-limited)
    let adaptive_bft_info = api_v1
        .and(warp::path("adaptive-bft"))
        .and(warp::path("timeouts"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_adaptive_bft_timeouts);

    // Node performance metrics (rate-limited)
    let performance_metrics = api_v1
        .and(warp::path("metrics"))
        .and(warp::path("performance"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_performance_metrics);
    
    // Reputation history endpoint (rate-limited)
    let reputation_history = api_v1
        .and(warp::path("reputation"))
        .and(warp::path("history"))
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(warp::query::<HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_reputation_history);

    // v2: macroblock consensus runs over P2P (Checkpoint-BFT), not RPC. The legacy
    // /consensus/{commit,reveal,round,sync} endpoints (old commit/reveal engine) are removed.

    // PRODUCTION: P2P message handling endpoint
    let p2p_message = api_v1
        .and(warp::path("p2p"))
        .and(warp::path("message"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(2 * 1024 * 1024))
        .and(warp::body::json())
        .and(gate_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_p2p_message);
    
    // ===== SMART CONTRACT ENDPOINTS =====
    
    // Deploy smart contract
    let contract_deploy = api_v1
        .and(warp::path("contract"))
        .and(warp::path("deploy"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(2 * 1024 * 1024)) // 2MB max (WASM bytecode)
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_contract_deploy);
    
    // Call smart contract method
    let contract_call = api_v1
        .and(warp::path("contract"))
        .and(warp::path("call"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(128 * 1024)) // 128KB max
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_contract_call);
    
    // FIX M13: Add rate limiting to contract endpoints
    let contract_info = api_v1
        .and(warp::path("contract"))
        .and(warp::path::param::<String>())
        .and(warp::path::end())
        .and(warp::get())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_contract_info);

    let contract_state = api_v1
        .and(warp::path("contract"))
        .and(warp::path::param::<String>())
        .and(warp::path("state"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<ContractStateQuery>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_contract_state);

    // OFF-CONSENSUS contract event logs (getLogs). Top-level path (not under contract/{param})
    // to avoid the /contract/{addr} route-ordering collision. GET /api/v1/logs?contract=&from=&to=
    let contract_logs = api_v1
        .and(warp::path("logs"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<ContractLogsQuery>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_contract_logs);

    // Estimate gas for contract operation (write category)
    let contract_estimate_gas = api_v1
        .and(warp::path("contract"))
        .and(warp::path("estimate-gas"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(128 * 1024)) // 128KB max
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_contract_estimate_gas);
    
    // Deploy QRC-20 Token (simplified endpoint)
    let token_deploy = api_v1
        .and(warp::path("token"))
        .and(warp::path("deploy"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(128 * 1024)) // 128KB max
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_token_deploy);

    // Deploy QRC-721 (NFT) collection
    let nft_deploy = api_v1
        .and(warp::path("nft"))
        .and(warp::path("deploy"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(128 * 1024)) // 128KB max
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_nft_deploy);

    // Deploy a generic WASM smart contract. This is the live path for executable
    // contract code; the module is validated up front and executed at apply.
    let wasm_deploy = api_v1
        .and(warp::path("wasm"))
        .and(warp::path("deploy"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(1024 * 1024)) // 1MB max (code blobs)
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_wasm_deploy);

    // Get token info
    let token_info = api_v1
        .and(warp::path("token"))
        .and(warp::path::param::<String>())
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_token_info);
    
    // Get token balance for address
    let token_balance = api_v1
        .and(warp::path("token"))
        .and(warp::path::param::<String>())
        .and(warp::path("balance"))
        .and(warp::path::param::<String>())
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_token_balance);
    
    // Get all tokens for address
    let tokens_for_address = api_v1
        .and(warp::path("account"))
        .and(warp::path::param::<String>())
        .and(warp::path("tokens"))
        .and(warp::path::end())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_tokens_for_address);

    // Native QNC rich list: top-K holders + authoritative supply. Rate-limited; served from a
    // short-TTL cache built off the consensus lock (never a per-request full-state scan).
    let qnc_richlist = api_v1
        .and(warp::path("richlist"))
        .and(warp::path::end())
        .and(warp::query::<std::collections::HashMap<String, String>>())
        .and(client_addr())
        .and(warp::get())
        .and(blockchain_filter.clone())
        .and_then(handle_qnc_richlist);
    
    // ============================================================================
    // BENCHMARK ENDPOINTS - Real Transaction Load Testing
    // ============================================================================
    
    // Every benchmark route: disabled unless QNET_BENCHMARK_SECRET is set, then only with the secret
    // (`X-Benchmark-Secret`, or the start body's `secret`); see rpc/benchmark.rs benchmark_admit.
    // POST /api/v1/benchmark/start - Start benchmark with config
    let benchmark_start = api_v1
        .and(warp::path("benchmark"))
        .and(warp::path("start"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(64 * 1024)) // 64KB max
        .and(warp::body::json())
        .and(warp::header::optional::<String>("x-benchmark-secret"))
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_benchmark_start);

    // GET /api/v1/benchmark/status - Get current benchmark status (v10.0: rate-limited)
    let benchmark_status = api_v1
        .and(warp::path("benchmark"))
        .and(warp::path("status"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("x-benchmark-secret"))
        .and(client_addr())
        .and_then(handle_benchmark_status);

    // GET /api/v1/benchmark/results - Get benchmark results (v10.0: rate-limited)
    let benchmark_results = api_v1
        .and(warp::path("benchmark"))
        .and(warp::path("results"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("x-benchmark-secret"))
        .and(client_addr())
        .and_then(handle_benchmark_results);

    // POST /api/v1/benchmark/stop - Stop benchmark (v10.0: auth + rate-limited)
    let benchmark_stop = api_v1
        .and(warp::path("benchmark"))
        .and(warp::path("stop"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("x-benchmark-secret"))
        .and(client_addr())
        .and_then(handle_benchmark_stop);

    // GET /api/v1/benchmark/presets - Get available presets (v10.0: rate-limited)
    let benchmark_presets = api_v1
        .and(warp::path("benchmark"))
        .and(warp::path("presets"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("x-benchmark-secret"))
        .and(client_addr())
        .and_then(handle_benchmark_presets);

    // Combine benchmark routes
    let benchmark_routes = benchmark_start
        .or(benchmark_status)
        .or(benchmark_results)
        .or(benchmark_stop)
        .or(benchmark_presets);
    
    // CORS: the public routes carry no cookies or other credentials, so any origin may call them: a web page, or the
    // browser extension, whose chrome-extension:// / moz-extension:// origin differs per build or per install (a list
    // of origins refused the extension's POSTs with 403, the node registration among them). The routes that answer
    // only local, whitelisted or genesis callers, and the bundle cancel by the submitter's address, are served
    // outside this filter (`gated_routes`); DELETE, which only the bundle cancel uses, is not a public method.
    let cors = if std::env::var("QNET_DEV_MODE").is_ok() {
        println!("⚠️  CORS: Development mode - allowing all origins");
        warp::cors()
            .allow_any_origin()
            .allow_methods(vec!["POST", "GET", "OPTIONS", "PUT", "DELETE"])
            .allow_headers(vec!["Content-Type", "Authorization", "User-Agent", "X-Requested-With", "X-API-Key"])
            .max_age(3600)
    } else {
        println!("[INFO][RPC] cors_mode=public any_origin=true credentials=false");
        warp::cors()
            .allow_any_origin()
            .allow_methods(vec!["POST", "GET", "OPTIONS"])
            .allow_headers(vec!["Content-Type", "Authorization", "User-Agent", "X-API-Key"])
            .max_age(86400) // 24 hours cache
    };
    
    // Combine routes in smaller groups to avoid recursion overflow
    let basic_routes = rpc_path
        .or(root_path)
        .or(chain_height)
        .or(peers_endpoint);
        
    let blockchain_routes = microblock_one
        .or(microblocks_range)
        .or(blocks_headers)
        .or(archive_list)
        .or(archive_segment)
        .or(block_latest)
        .or(block_by_height)
        .or(genesis_block)
        .or(block_by_hash)
        .or(macroblock_by_index)
        .or(macroblock_proof)
        .or(registry_height)
        .or(debug_consensus_position)
        .or(snapshot_latest)
        .or(snapshot_download)
        .or(snapshot_manifest)
        .or(snapshot_chunk);
        
    let account_routes = account_info
        .or(account_balance)
        .or(account_balance_proof)  // v3.11: Balance with Merkle proof
        .or(token_balance_proof)  // V2: trustless QRC-20 token balance proof
        .or(state_certified)
        .or(validators_proof)       // v3.32: Validator set with Merkle proof
        .or(epoch_leafset)
        .or(account_transactions)
        .or(account_node_events)
        .or(account_token_transfers)
        .or(token_transfers_feed)
        .or(token_transfers_range)
        .or(log_proof)
        .or(batch_transfer);
        
    let transaction_routes = transaction_submit
        .or(transaction_by_nonce)
        .or(transaction_get)
        .or(transaction_history)  // Extended history API with pagination
        .or(transactions_recent)  // Global recent transactions API
        .or(mempool_status)
        .or(mempool_transactions);
    
    let bundle_routes = bundle_submit
        .or(bundle_status);
        
    let node_routes = node_discovery
        .or(node_health)
        .or(gas_recommendations)
        .or(auth_challenge)
        .or(network_ping)
        .or(node_device_check)
        .or(register_device);
    
    let monitoring_routes = failover_history
        .or(network_failovers)
        .or(stats_endpoint)
        .or(producer_status)
        .or(sync_status)
        .or(network_diagnostics)
        .or(block_stats)
        .or(shred_protocol_metrics)
        .or(parallel_executor_metrics)
        .or(pre_execution_status)
        .or(adaptive_bft_info)
        .or(performance_metrics)
        .or(reputation_history);
    
    // PUBLIC: Cached endpoints for website (no rate limiting needed)
    let public_routes = public_stats
        .or(activation_price);
        
    // SECURE: Node information endpoint with activation code (for wallet extensions)
    // v10.0: Auth via Authorization header (query param deprecated)
    let node_secure_info = api_v1
        .and(warp::path("node"))
        .and(warp::path("secure-info"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::query::<std::collections::HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_node_secure_info);

    // Internal genesis-to-genesis FCM token sync (IP-restricted)
    let internal_fcm_sync = api_v1
        .and(warp::path("internal"))
        .and(warp::path("fcm-token-sync"))
        .and(warp::path::end())
        .and(warp::post())
        .and(gate_addr())
        .and(warp::body::content_length_limit(64 * 1024)) // 64KB max
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_internal_fcm_token_sync);

    // Internal genesis-to-genesis FCM record read (IP-restricted) — shard-owner pull-heal
    let internal_fcm_get = api_v1
        .and(warp::path("internal"))
        .and(warp::path("fcm-token-get"))
        .and(warp::path::end())
        .and(warp::get())
        .and(gate_addr())
        .and(warp::query::<std::collections::HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_internal_fcm_token_get);

    // Internal genesis-to-genesis light ping-key read (IP-restricted) — shard-owner identity pull
    let internal_light_keys_get = api_v1
        .and(warp::path("internal"))
        .and(warp::path("light-ping-keys-get"))
        .and(warp::path::end())
        .and(warp::get())
        .and(gate_addr())
        .and(warp::query::<std::collections::HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_internal_light_ping_keys_get);

    // Internal genesis-to-genesis reach record read (IP-restricted): the owners' proof that a device was reached.
    let internal_light_reach_get = api_v1
        .and(warp::path("internal"))
        .and(warp::path("light-reach-get"))
        .and(warp::path::end())
        .and(warp::get())
        .and(gate_addr())
        .and(warp::query::<std::collections::HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_internal_light_reach_get);

    // Internal genesis-to-genesis unbind (IP-restricted): re-verified from the signer's own signature.
    let internal_light_unbind_sync = api_v1
        .and(warp::path("internal"))
        .and(warp::path("light-unbind-sync"))
        .and(warp::path::end())
        .and(warp::post())
        .and(gate_addr())
        .and(warp::body::content_length_limit(32 * 1024))
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_internal_light_unbind_sync);

    // Public: lightweight FCM token refresh (Ed25519-signed)
    let light_node_token_refresh = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("token-refresh"))
        .and(warp::path::end())
        .and(warp::post())
        .and(client_addr())
        .and(warp::body::content_length_limit(16 * 1024)) // 16KB max
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(|remote_addr: Option<std::net::SocketAddr>, body: TokenRefreshRequest, bc: Arc<BlockchainNode>| async move {
            handle_light_node_token_refresh(remote_addr, body, bc).await
        });

    // Device layer (A1-A6): the challenge, and the genesis-only attestor round, record sync and pull.
    let light_device_challenge = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("device-challenge"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        .and(client_addr())
        .and_then(handle_device_challenge);
    // The attestor request carries the device's public evidence and the wallet's delegation (~30 KB).
    let internal_device_attest = api_v1
        .and(warp::path("internal"))
        .and(warp::path("light-device-attest"))
        .and(warp::path::end())
        .and(warp::post())
        .and(gate_addr())
        .and(warp::body::content_length_limit(96 * 1024))
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_internal_device_attest);
    // A final statement: five raw signatures, the lease and its signature (~40 KB in hex).
    let internal_device_sync = api_v1
        .and(warp::path("internal"))
        .and(warp::path("light-device-sync"))
        .and(warp::path::end())
        .and(warp::post())
        .and(gate_addr())
        .and(warp::body::content_length_limit(96 * 1024))
        .and(warp::body::json())
        .and(blockchain_filter.clone())
        .and_then(handle_internal_device_sync);
    let internal_device_get = api_v1
        .and(warp::path("internal"))
        .and(warp::path("light-device-get"))
        .and(warp::path::end())
        .and(warp::get())
        .and(gate_addr())
        .and(warp::query::<HashMap<String, String>>())
        .and(blockchain_filter.clone())
        .and_then(handle_internal_device_get);
    // The lease refresh (A9): a device signature and a vendor token (a Play token is up to 16 KB).
    let light_device_refresh = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("device-refresh"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(32 * 1024))
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_light_device_refresh);
    // The key rotation (A10): the new key's evidence as at /bind, the old key's signature and the token.
    let light_device_rotate = api_v1
        .and(warp::path("light-node"))
        .and(warp::path("device-rotate"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::body::content_length_limit(96 * 1024))
        .and(warp::body::json())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .and_then(handle_light_device_rotate);
    let light_device_routes = light_device_challenge
        .or(light_device_refresh)
        .or(light_device_rotate)
        .boxed();

    let light_node_routes = light_node_register
        .or(light_device_routes)
        .or(light_node_bind)
        .or(light_node_unbind)
        .or(light_node_wake)
        .or(light_node_token_refresh)
        .or(light_node_ping_response_get)
        .or(light_node_ping_response_post)
        .or(light_node_status)
        .or(light_node_status_signed)
        .or(server_node_status)
        .or(light_node_next_ping)
        .or(light_node_pending_challenge)
        .or(claim_rewards)
        .or(pending_rewards)
        .or(reward_history)
        .or(reward_pools)
        .or(rewards_by_wallet)
        .or(rewards_pending_batch)
        .or(rewards_network_stats)
        .or(rewards_summary)
        .or(register_node)
        .or(activations_by_wallet)
        .or(verify_activation)
        .or(node_secure_info)
        .or(node_registration_submit);

    // The routes that answer only local, whitelisted or genesis callers (gate_addr, GATED_PATHS), and the bundle
    // cancel, which answers the submitter's address: served outside the CORS filter, so no page reads an answer,
    // and a request that carries an Origin header is nobody in particular there (gate_client).
    let gated_routes = internal_fcm_sync
        .or(internal_fcm_get)
        .or(internal_light_keys_get)
        .or(internal_light_reach_get)
        .or(internal_light_unbind_sync)
        .or(internal_device_attest)
        .or(internal_device_sync)
        .or(internal_device_get)
        .or(p2p_message)
        .or(node_reactivation_submit)
        .or(graceful_shutdown)
        .or(bundle_cancel)
        .boxed();
    
    // Smart contract routes
    let contract_routes = contract_deploy
        .or(contract_call)
        .or(contract_info)
        .or(contract_state)
        .or(contract_logs)
        .or(contract_estimate_gas)
        .or(token_deploy)
        .or(nft_deploy)
        .or(wasm_deploy)
        .or(token_info)
        .or(qnc_richlist)
        .or(token_balance)
        .or(tokens_for_address);
    
    // =========================================================================
    // WEBSOCKET: Real-time event subscriptions
    // =========================================================================
    
    // WebSocket endpoint for real-time updates
    // ws://node:8001/ws/subscribe?channels=blocks,account:ADDRESS,contracts:ADDRESS
    // SECURITY: Rate limited to prevent connection flood attacks
    let ws_subscribe = warp::path("ws")
        .and(warp::path("subscribe"))
        .and(warp::path::end())
        .and(warp::ws())
        .and(warp::query::<WsSubscribeQuery>())
        .and(client_addr())
        .and(blockchain_filter.clone())
        .map(|ws: warp::ws::Ws, query: WsSubscribeQuery, remote_addr: Option<std::net::SocketAddr>, blockchain: Arc<BlockchainNode>| {
            // Extract IP for rate limiting
            let ip = remote_addr.map(|addr| addr.ip());
            
            // SECURITY: Check rate limit before upgrading connection
            if !WS_RATE_LIMITER.check_connection(ip) {
                // Return 429 Too Many Requests
                return warp::reply::with_status(
                    "WebSocket connection limit exceeded",
                    warp::http::StatusCode::TOO_MANY_REQUESTS
                ).into_response();
            }
            
            // Register connection and upgrade
            WS_RATE_LIMITER.add_connection(ip);
            
            ws.on_upgrade(move |socket| handle_ws_connection_with_cleanup(socket, query, blockchain, ip))
                .into_response()
        });
    
    // Simple health check endpoint (no authentication required)
    let health = warp::path("health")
        .and(warp::path::end())
        .and(warp::get())
        .map(|| warp::reply::with_status("OK", warp::http::StatusCode::OK));

    // v14.8.5: LOCK-FREE liveness probe for container health-check.
    //
    // `/healthz` is intentionally minimal: one atomic load, one format,
    // one HTTP 200. It never touches the blockchain, P2P, mempool, or
    // any async state that can be locked by the deadlock path that
    // froze /api/v1/node/health in production. This keeps the container
    // orchestrator's liveness view accurate even when the heavier API
    // surfaces are temporarily blocked.
    //
    // Orchestrators (e.g. docker-compose healthcheck) should be pointed
    // at /healthz, not /api/v1/node/health. The rich node_health endpoint
    // remains available for monitoring dashboards that need peer counts,
    // mempool size and sync state.
    let healthz = warp::path("healthz")
        .and(warp::path::end())
        .and(warp::get())
        .map(|| {
            let h = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                .load(std::sync::atomic::Ordering::Relaxed);
            warp::reply::with_status(
                format!("ok h={} build={}", h, crate::node::build_id()),
                warp::http::StatusCode::OK,
            )
        });
    
    // Combine route groups. The WebSocket subscription stays outside the CORS filter: React Native sends
    // `Origin: https://<node host>` on every WebSocket handshake, which no browser allow-list names, so the filter
    // answered the wallet app 403 (sandbox 28.09; production too). The feed carries only public block and
    // transaction notices, with no cookie or credential, so an origin check guards nothing there.
    let rest_routes = health
        .or(healthz)        // v14.8.5: lock-free liveness probe
        .or(basic_routes)
        .or(blockchain_routes)
        .or(account_routes)
        .or(transaction_routes)
        .or(bundle_routes)
        .or(node_routes)
        .or(light_node_routes)
        .or(contract_routes)
        .or(monitoring_routes)
        .or(public_routes) // PUBLIC: Cached endpoints for website
        .or(benchmark_routes) // BENCHMARK: Real transaction load testing
        .with(cors);
    // WebSocket and the gated routes before the REST routes; a preflight for a gated path is refused before the
    // CORS filter would answer it.
    let routes = ws_subscribe.or(gated_preflight()).or(gated_routes).or(rest_routes);


    // PORT BIND RETRY: survive TIME_WAIT after fast Docker restart (same pattern as Genesis signal_listener)
    // warp::serve().run() binds internally and panics on failure — probe first with retry
    {
        let mut bound = false;
        for attempt in 1u32..=10 {
            match tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await {
                Ok(_probe) => {
                    // _probe drops here, freeing port for warp
                    bound = true;
                    break;
                }
                Err(e) => {
                    if crate::node::is_warn() {
                        println!("[WARN][RPC] port_{}_busy attempt={}/10 err={}", port, attempt, e);
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
        }
        if !bound {
            eprintln!("[FATAL][RPC] Cannot bind port {} after 10 attempts (20s) — restarting node", port);
            std::process::exit(1);
        }
    }
    // Brief pause — allows OS to fully process socket release before warp rebinds
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    println!("🚀 Starting comprehensive API server on port {}", port);
    println!("[INFO][RPC] json_rpc addr=0.0.0.0:{}/rpc", port);
    println!("🔌 REST API available at: http://0.0.0.0:{}/api/v1/", port);
    println!("🔗 WebSocket available at: ws://0.0.0.0:{}/ws/subscribe", port);
    println!("📱 Light Node services: Registration, FCM Push, Reward Claims");
    println!("🏛️ Macroblock Consensus: Checkpoint-BFT v2 (2f+1 Quorum Certificate)");
    println!("📜 Smart Contract API: Deploy, Call, Query");
    
    // Start Light node ping service for Super nodes  
    let blockchain_for_ping = blockchain.clone();
    let node_type = blockchain_for_ping.get_node_type();
    if !matches!(node_type, crate::node::NodeType::Light) {
        start_light_node_ping_service(blockchain.clone());
        println!("🕐 Light node randomized ping service started");
        // The device layer's background work: the five genesis only (a no-op on any other node).
        start_device_maintenance(blockchain.clone());
        
        // v35: legacy local heartbeat service removed. Liveness is now the spread on-chain
        // Heartbeat-TX emitted by start_commitment_tx_loop (tallied in Account.heartbeat_slots).
        // No local heartbeat_history, no per-tick storage scan, no HBC samples to feed.
    }
    
    warp::serve(routes).run(([0, 0, 0, 0], port)).await;

    // RPC server exited — this should never happen in normal operation
    eprintln!("[FATAL][RPC] warp server on port {} exited unexpectedly — restarting node", port);
    std::process::exit(1);
}

async fn handle_rpc(
    request: RpcRequest,
    remote_addr: Option<std::net::SocketAddr>,
    from_page: bool,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let response = match request.method.as_str() {
        // Node methods
        "node_getInfo" => node_get_info(blockchain).await,
        "node_getStatus" => node_get_status(blockchain).await,
        "node_getPeers" => node_get_peers(blockchain).await,
        
        // Chain methods
        "chain_getHeight" => chain_get_height(blockchain).await,
        "chain_getBlock" => chain_get_block(blockchain, request.params).await,
        "chain_getBlocks" => chain_get_blocks(blockchain, request.params).await,
        
        // Transaction methods
        "tx_submit" => tx_submit(blockchain, request.params).await,
        "tx_sendTransaction" => tx_submit(blockchain, request.params).await, // Alias for compatibility
        "tx_get" => tx_get(blockchain, request.params).await,

        // Mempool methods
        "mempool_getTransactions" => mempool_get_transactions(blockchain).await,
        "mempool_submit" => mempool_submit(blockchain, request.params).await,
        
        // Account methods
        "account_getInfo" => account_get_info(blockchain, request.params).await,
        "account_getBalance" => account_get_balance(blockchain, request.params).await,
        
        // Stats methods
        "stats_get" => stats_get(blockchain).await,
        
        // Quantum Randomness Beacon (QRB) methods
        "qrb_getRandomness" => qrb_get_randomness(blockchain.clone(), request.params).await,
        "qrb_getLatestRandomness" => qrb_get_latest_randomness(blockchain.clone()).await,
        "qrb_getRandomnessWithSeed" => qrb_get_randomness_with_seed(blockchain.clone(), request.params).await,
        
        // Node transfer methods
        "device_migration" => device_migration(blockchain, request.params).await,
        "node_getTransferStatus" => node_get_transfer_status(blockchain, request.params).await,

        // Phase-1 burn attestation (genesis-side): verify the external Solana 1DEV burn + sign.
        "node_attestBurn" => node_attest_burn(blockchain, request.params, remote_addr).await,

        // Recovery relaxation. OPERATOR actions, so they are restricted to the loopback/private
        // interface: on 0.0.0.0 they were reachable by anyone on the internet, and while neither can
        // relax a healthy network (rc_try_arm re-checks every condition), disarming during a genuine
        // halt is a free denial of the one recovery path the node has. A web page is never the local
        // interface (gate_client), whatever address its visitor's browser sends from.
        "node_armRecovery" | "node_disarmRecovery" | "node_recoveryStatus"
        | "node_decreeEndorse" | "node_decreeSubmit" => {
            let ip = gate_client(remote_addr, from_page).map(|a| a.ip().to_string()).unwrap_or_default();
            if !is_internal_ip(&ip) {
                Err(RpcError { code: -32004, message: "operator method: local interface only".to_string(), data: None })
            } else {
                match request.method.as_str() {
                    "node_armRecovery" => node_arm_recovery(blockchain).await,
                    "node_disarmRecovery" => node_disarm_recovery().await,
                    "node_decreeEndorse" => node_decree_endorse(blockchain, request.params).await,
                    "node_decreeSubmit" => node_decree_submit(blockchain, request.params).await,
                    _ => node_recovery_status(blockchain).await,
                }
            }
        }

        _ => Err(RpcError {
            code: -32601,
            message: "Method not found".to_string(), data: None,
        }),
    };
    
    let rpc_response = match response {
        Ok(result) => RpcResponse {
            jsonrpc: "2.0".to_string(),
            result: Some(result),
            error: None,
            id: request.id,
        },
        Err(error) => RpcResponse {
            jsonrpc: "2.0".to_string(),
            result: None,
            error: Some(error),
            id: request.id,
        },
    };
    
    Ok(warp::reply::json(&rpc_response))
}

/// Attestor-side issuance throttle (admission controller for the whole registration pipeline).
/// Burns queue in a burn_tx-ASC BTreeMap and are promoted at ATTEST_ISSUE_RATE/sec — a deterministic
/// order every attestor converges on, so the quorum-of-2f+1 arm rate is bounded network-wide at
/// (n/need)·rate (~15/block at genesis) with NO blind window from t=0. Promotion pauses while the
/// TRUE registration backlog (mempool-resident, not-yet-applied — ghosts never enter it) exceeds
/// ATTEST_VALVE_THRESH, bounding the standing backlog under a synchronized 100k relaunch.
/// Non-promoted callers get -32050 attest_pending + a monotone retry_after. RAM-only, admission
/// side, never consensus.
const ATTEST_PENDING_CAP: usize = 4096;
const ATTEST_ISSUE_RATE: u64 = 12;      // promotions/sec ≈ 1.5× the 8/block apply drain
const ATTEST_VALVE_THRESH: usize = 720; // pause issuance above this mempool registration backlog
const ATTEST_PROMOTED_TTL_SECS: u64 = 600;

/// First-sight Solana lookups one burner may have spent in the current window. The lookup is the only
/// remaining pre-burn cost on this endpoint, so it is metered per identity rather than globally: a flood
/// from one burner degrades only that burner.
const ATTEST_LOOKUPS_PER_BURNER: u32 = 8;
const ATTEST_LOOKUP_WINDOW_SECS: u64 = 60;
/// GLOBAL ceiling on first-sight Solana lookups per window, across all callers. The per-burner counter
/// alone is not a bound: keypairs are free, so a distributed flood just brings more identities. This is
/// the attestor's own third-party RPC quota and it must be finite regardless of how many identities ask.
const ATTEST_LOOKUPS_GLOBAL: u32 = 240;
/// How long a burn_tx that failed Solana verification stays remembered. Long enough that re-polling a
/// dead burn is free, short enough that a burn confirmed late still gets a second chance.
const ATTEST_BAD_TTL_SECS: u64 = 600;
const ATTEST_BAD_CAP: usize = 65_536;
/// The share of the global ceiling that callers outside the committee may spend (H10). The committee's
/// submit doors meter their clients per address and per node before they ask; anyone else - a joining
/// super collecting for its own registration - reaches the attestor directly, so a flood of fresh keys
/// from outside can take at most this lane and never the doors' quota.
const ATTEST_LOOKUPS_OUTSIDE: u32 = 60;
/// First-sight lookups one outside address (IPv6: its /64) may start per window.
static ATTEST_OUTSIDE_ADDR_LIMIT: KeyedLimiter = KeyedLimiter::new(10, 600);

/// A committee caller's share of the doors' quota (the global ceiling less the outside lane) per window (M-9),
/// split over the committee callers asking (`doors_asking`) but never over fewer than the genesis count, so one
/// door never takes more than a genesis door's share: garbage pushed through one submit door spends that door's
/// share and never starves submits arriving at the others. Split over the callers that ask, not over the whole
/// committee, so a large committee whose members mostly serve no submits leaves the doors that do a usable share.
/// Never below one burner's count, so every door can serve a burner.
fn attest_door_share(doors_asking: usize) -> u32 {
    let split = doors_asking.max(crate::genesis_constants::genesis_node_count()).max(1);
    ((ATTEST_LOOKUPS_GLOBAL - ATTEST_LOOKUPS_OUTSIDE) / split as u32).max(ATTEST_LOOKUPS_PER_BURNER)
}

/// First-sight lookup budget of one window.
#[derive(Default)]
struct LookupBudget {
    window: u64,
    global: u32,
    outside: u32,
    per_burner: std::collections::HashMap<String, u32>,
    /// Spent per committee caller (this node's own door, or a member's address).
    per_door: std::collections::HashMap<String, u32>,
    /// Committee callers that spent in the previous window: a window's shares start split over them, so the
    /// doors that ask first cannot take the shares of those that keep asking.
    doors_before: usize,
}

impl LookupBudget {
    /// Ok(()) = this burner may spend one first-sight lookup now; Err(retry_after_secs) otherwise. `door`: the
    /// committee caller asking, which spends its own share (`attest_door_share` over the callers that spent in
    /// this window or the last, whichever are more).
    fn admit(&mut self, burner: &str, outside: bool, door: Option<&str>, now: u64) -> Result<(), u64> {
        let window = now / ATTEST_LOOKUP_WINDOW_SECS;
        if self.window != window {
            let doors_before = if window == self.window.saturating_add(1) { self.per_door.len() } else { 0 };
            *self = LookupBudget { window, doors_before, ..Default::default() };
        }
        let retry = ATTEST_LOOKUP_WINDOW_SECS - (now % ATTEST_LOOKUP_WINDOW_SECS);
        if self.global >= ATTEST_LOOKUPS_GLOBAL { return Err(retry); }
        if outside && self.outside >= ATTEST_LOOKUPS_OUTSIDE { return Err(retry); }
        if let Some(key) = door {
            let spent = self.per_door.get(key).copied();
            let asking = self.per_door.len() + usize::from(spent.is_none());
            if spent.unwrap_or(0) >= attest_door_share(asking.max(self.doors_before)) { return Err(retry); }
        }
        let c = self.per_burner.entry(burner.to_string()).or_insert(0);
        if *c >= ATTEST_LOOKUPS_PER_BURNER { return Err(retry); }
        *c += 1;
        self.global += 1;
        if outside { self.outside += 1; }
        if let Some(key) = door { *self.per_door.entry(key.to_string()).or_insert(0) += 1; }
        Ok(())
    }
}

static ATTEST_LOOKUPS: Lazy<parking_lot::Mutex<LookupBudget>> = Lazy::new(|| parking_lot::Mutex::new(LookupBudget::default()));
static ATTEST_BAD_BURNS: Lazy<parking_lot::Mutex<std::collections::HashMap<String, u64>>> =
    Lazy::new(|| parking_lot::Mutex::new(std::collections::HashMap::new()));

/// True iff this (burn_tx, burner) pair failed Solana verification recently. Repeat polls of a dead pair
/// then cost one map probe, so an unlimited supply of junk ids no longer buys unlimited Solana round-trips.
///
/// Keyed by the PAIR, exactly like the positive cache: burn_tx alone is public, so a burn_tx-only key
/// would let any stranger poll a victim's burn under their own address, get the definitive
/// sender-mismatch answer cached, and lock the real owner out for the whole TTL.
fn attest_lookup_known_bad(burn_tx: &str, burner: &str) -> bool {
    let key = format!("{}_{}", burn_tx, burner);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let mut m = ATTEST_BAD_BURNS.lock();
    match m.get(&key) {
        Some(at) if now.saturating_sub(*at) < ATTEST_BAD_TTL_SECS => true,
        Some(_) => { m.remove(&key); false }
        None => false,
    }
}

/// Remember a DEFINITIVE verification failure. Never called for a transport failure: an unreachable or
/// lagging Solana RPC must not blacklist a burn that is merely not indexed yet.
fn attest_lookup_mark_bad(burn_tx: &str, burner: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let mut m = ATTEST_BAD_BURNS.lock();
    if m.len() >= ATTEST_BAD_CAP {
        m.retain(|_, at| now.saturating_sub(*at) < ATTEST_BAD_TTL_SECS);
        if m.len() >= ATTEST_BAD_CAP { m.clear(); }
    }
    m.insert(format!("{}_{}", burn_tx, burner), now);
}

/// Ok(()) = this burner may spend one first-sight Solana lookup. Err(retry_after_secs) = its window quota
/// is used up, or, for a caller outside the committee, the outside lane is, or, for a committee caller,
/// its door's share is.
fn attest_lookup_admit(burner: &str, outside: bool, door: Option<&str>) -> Result<(), u64> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    ATTEST_LOOKUPS.lock().admit(burner, outside, door, now)
}

/// Pending slots one burning wallet may hold at once. The queue is FIFO, so a burner cannot buy
/// priority; this bounds how much of it a single identity can occupy.
const ATTEST_PENDING_PER_BURNER: u32 = 8;

struct AttestThrottle {
    pending: std::collections::VecDeque<(String, String)>, // (burn_tx, burner) — ARRIVAL order
    pending_set: std::collections::HashSet<String>,        // burn_tx membership
    per_burner: std::collections::HashMap<String, u32>,    // burner → pending slots held
    promoted: std::collections::BTreeMap<String, u64>,     // burn_tx → promoted-at unix secs
    last_tick_secs: u64,
}
static ATTEST_THROTTLE: Lazy<parking_lot::Mutex<AttestThrottle>> = Lazy::new(|| parking_lot::Mutex::new(
    AttestThrottle {
        pending: std::collections::VecDeque::new(),
        pending_set: std::collections::HashSet::new(),
        per_burner: std::collections::HashMap::new(),
        promoted: std::collections::BTreeMap::new(),
        last_tick_secs: 0,
    }));

/// Ok(()) = promoted (sign now). Err(retry_after_secs) = queued/full (caller re-polls).
/// FIFO by arrival: issuance order must not be a function of the key, or a caller could mint keys that
/// sort ahead of every real Solana signature and starve honest registrants deterministically. Slots are
/// additionally capped per burning wallet, so one identity cannot hold the whole queue.
/// INSERT-THEN-PROMOTE: the caller's key enters PENDING before the promotion tick runs, so a
/// first-sight burn promotes in the SAME call whenever quota remains and the valve is open —
/// single-shot flows (server-mediated light registration) succeed first try, and the rate bound
/// (ISSUE_RATE/sec) still holds exactly because promotion only ever spends tick quota.
fn attest_throttle_admit(burn_tx: &str, burner: &str) -> Result<(), u64> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let mut t = ATTEST_THROTTLE.lock();
    t.promoted.retain(|_, at| now.saturating_sub(*at) < ATTEST_PROMOTED_TTL_SECS);
    if t.promoted.contains_key(burn_tx) { return Ok(()); }
    if !t.pending_set.contains(burn_tx) {
        if t.pending.len() >= ATTEST_PENDING_CAP {
            return Err((ATTEST_PENDING_CAP as u64 / ATTEST_ISSUE_RATE).max(60));
        }
        if t.per_burner.get(burner).copied().unwrap_or(0) >= ATTEST_PENDING_PER_BURNER {
            return Err((ATTEST_PENDING_PER_BURNER as u64 / ATTEST_ISSUE_RATE).max(30));
        }
        t.pending.push_back((burn_tx.to_string(), burner.to_string()));
        t.pending_set.insert(burn_tx.to_string());
        *t.per_burner.entry(burner.to_string()).or_insert(0) += 1;
    }
    let elapsed = now.saturating_sub(t.last_tick_secs);
    if elapsed > 0 {
        t.last_tick_secs = now;
        let backlog = crate::node::try_get_mempool()
            .map(|m| m.pending_registration_backlog()).unwrap_or(0);
        if backlog <= ATTEST_VALVE_THRESH {
            let quota = (elapsed.min(2) * ATTEST_ISSUE_RATE) as usize; // burst cap = 2 ticks
            for _ in 0..quota {
                match t.pending.pop_front() {
                    Some((k, b)) => {
                        t.pending_set.remove(&k);
                        if let Some(c) = t.per_burner.get_mut(&b) {
                            *c = c.saturating_sub(1);
                            if *c == 0 { t.per_burner.remove(&b); }
                        }
                        t.promoted.insert(k, now);
                    }
                    None => break,
                }
            }
        } else if is_info() {
            println!("[INFO][BURN] attest_valve_paused backlog={} thresh={}", backlog, ATTEST_VALVE_THRESH);
        }
    }
    if t.promoted.contains_key(burn_tx) { return Ok(()); }
    let rank = t.pending.iter().position(|(k, _)| k == burn_tx).unwrap_or(0) as u64;
    Err(rank / ATTEST_ISSUE_RATE + 1)
}

/// 30s-TTL cache over fetch_solana_1dev_supply: bounds getTokenSupply cost under mass-join.
/// Stale-on-outage yields an honest reject upstream, never a stale-cost signature.
static SUPPLY_CACHE: Lazy<parking_lot::Mutex<Option<(std::time::Instant, (u64, u64))>>> =
    Lazy::new(|| parking_lot::Mutex::new(None));

/// SINGLE-FLIGHT gate: at most one upstream getTokenSupply is in flight network-wide-per-process,
/// no matter how many callers miss at once. Without it, every TTL expiry fans 10M polling light
/// clients out to one external endpoint at once, and the 429s that follow starve the ADMISSION
/// path, which reads the same cache.
static SUPPLY_REFRESH: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

const SUPPLY_TTL_SECS: u64 = 30;

/// Cached value with its age in seconds, without touching the network.
fn supply_cache_peek() -> Option<((u64, u64), u64)> {
    let cur = *SUPPLY_CACHE.lock();
    cur.map(|(at, v)| (v, at.elapsed().as_secs()))
}

/// Fresh-or-fetch. MONEY paths only (quotes, admission): a value older than the TTL is refreshed,
/// and a refresh failure is an error, never a stale price.
async fn cached_solana_1dev_supply() -> Result<(u64, u64), String> {
    if let Some((v, age)) = supply_cache_peek() {
        if age < SUPPLY_TTL_SECS { return Ok(v); }
    }
    let _flight = SUPPLY_REFRESH.lock().await;
    // Re-check: the flight we queued behind may have just refilled the cache.
    if let Some((v, age)) = supply_cache_peek() {
        if age < SUPPLY_TTL_SECS { return Ok(v); }
    }
    let v = fetch_solana_1dev_supply().await?;
    *SUPPLY_CACHE.lock() = Some((std::time::Instant::now(), v));
    Ok(v)
}

/// Last known value at ANY age, reported with that age; fetches only when nothing is cached yet
/// (still single-flight). DISPLAY paths only — a read endpoint must never be able to trigger an
/// upstream fetch that the admission path depends on.
async fn cached_solana_1dev_supply_stale_ok() -> Result<((u64, u64), u64), String> {
    if let Some(hit) = supply_cache_peek() { return Ok(hit); }
    let _flight = SUPPLY_REFRESH.lock().await;
    if let Some(hit) = supply_cache_peek() { return Ok(hit); }
    let v = fetch_solana_1dev_supply().await?;
    *SUPPLY_CACHE.lock() = Some((std::time::Instant::now(), v));
    Ok((v, 0))
}

/// Activation pricing derived from ONE live 1DEV supply read, through the same integer helpers the
/// burn attestors sign over. Every path that quotes a price or a phase goes through this, so a quote
/// can never disagree with what admission and attestation accept.
pub struct ActivationPricing {
    /// Share of the original 1DEV supply burned, display only — never an input to a price.
    pub burn_pct: f64,
    pub phase: u8,
    /// Phase-1 cost in whole 1DEV; universal across node types.
    pub phase1_cost: u64,
    /// Age in seconds of the 1DEV supply read this quote came from. 0 on a fresh fetch.
    pub age_secs: u64,
}

impl ActivationPricing {
    /// Phase-2 QNC cost for a node type: the shared consensus-side price table, evaluated at the
    /// CHAIN-CONFIRMED registered-node count. Not the local peer count — that stays in the tens at
    /// any network size, so it would pin the multiplier to the cheapest tier forever and make the
    /// same query answer differently on two honest nodes.
    pub fn phase2_cost(&self, node_type: &str) -> u64 {
        let registered = crate::GLOBAL_REGISTERED_NODES.load(std::sync::atomic::Ordering::Relaxed);
        let nt = if node_type.eq_ignore_ascii_case("super") {
            qnet_state::account::NodeType::Super
        } else {
            qnet_state::account::NodeType::Light
        };
        qnet_state::transaction::phase2_activation_cost_qnc(&nt, registered)
    }

    /// Cost quoted for this node type in the current phase (1DEV in Phase 1, QNC in Phase 2).
    pub fn cost_for(&self, node_type: &str) -> u64 {
        if self.phase == 1 { self.phase1_cost } else { self.phase2_cost(node_type) }
    }

    pub fn currency(&self) -> &'static str {
        if self.phase == 1 { "1DEV" } else { "QNC" }
    }
}

/// Live activation pricing. Fails closed: a Solana supply outage is a retryable error, never a
/// default price, because a defaulted quote makes the user over-burn irreversibly.
pub async fn live_activation_pricing() -> Result<ActivationPricing, String> {
    let (total_burned, current_supply) = cached_solana_1dev_supply().await?;
    let age = supply_cache_peek().map(|(_, a)| a).unwrap_or(0);
    let (genesis_ts, now_secs) = phase_clock();
    Ok(pricing_from_supply(total_burned, current_supply, age, genesis_ts, now_secs))
}

/// Inputs to the age half of the phase rule: the committed genesis-block timestamp this node tracks,
/// and wall-clock now. 0 genesis (block 0 not applied yet) keeps the age trigger shut.
fn phase_clock() -> (u64, u64) {
    let genesis_ts = crate::GLOBAL_GENESIS_TIMESTAMP.load(std::sync::atomic::Ordering::Relaxed);
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (genesis_ts, now_secs)
}

/// THE phase/price resolver. Phase 2 begins at 90% of the 1DEV supply burned OR five years since
/// genesis, whichever comes first — both halves evaluated by the shared consensus-side rule.
fn pricing_from_supply(
    total_burned: u64, current_supply: u64, age_secs: u64, genesis_ts: u64, now_secs: u64,
) -> ActivationPricing {
    let phase2 = qnet_state::Transaction::is_phase2(total_burned, current_supply, genesis_ts, now_secs);
    ActivationPricing {
        burn_pct: qnet_state::Transaction::burn_pct_tenths(total_burned, current_supply) as f64 / 10.0,
        phase: if phase2 { 2 } else { 1 },
        phase1_cost: qnet_state::Transaction::phase1_activation_cost(total_burned, current_supply),
        age_secs,
    }
}

/// Best-effort variant for display-only fields, which report `null` rather than fail a whole query.
/// Serves the last known supply read at whatever age it has (reported in `age_secs`) instead of
/// forcing a refresh, so a public read endpoint can never spend the admission path's upstream quota.
/// Never quote or gate a burn from this — use `live_activation_pricing` so an outage is visible.
pub async fn live_activation_pricing_opt() -> Option<ActivationPricing> {
    match cached_solana_1dev_supply_stale_ok().await {
        Ok(((total_burned, current_supply), age)) => {
            let (genesis_ts, now_secs) = phase_clock();
            Some(pricing_from_supply(total_burned, current_supply, age, genesis_ts, now_secs))
        }
        Err(e) => {
            println!("[WARN][PRICING] supply_read_unavailable err={}", e);
            None
        }
    }
}

/// Genesis-side burn-attestation RPC (PRODUCTION half of the burn-oracle). A joining super queries
/// the 5 genesis; each independently verifies the external Solana 1DEV burn (live RPC — admission
/// side, NEVER consensus) and returns a Dilithium signature over the canonical burn message. The
/// super embeds ≥2f+1 of these in its NodeRegistration, which block validation then re-verifies
/// deterministically (verify_burn_attestation_quorum). Non-genesis nodes return an error.
/// Issuance runs through the deterministic throttle above; the per-burn Solana verify is persisted
/// (attburnv_) so re-polls never re-hit Solana.
/// Arm the recovery relaxation on THIS node. It shortens only the stall wait — every other condition
/// (the halt itself, the committee floor, the no-chained-span rule) is re-checked identically to the
/// automatic path, so an operator cannot relax a healthy or an ineligible network.
///
/// Arming has no consensus effect by itself: it changes what this node proposes and counts, never what
/// is valid. Validity is decided by each certificate's own bytes at the macroblock gate.
/// Operator: sign the recovery-decree payload with this node's consensus key.
async fn node_decree_endorse(blockchain: Arc<BlockchainNode>, params: Option<Value>) -> Result<Value, RpcError> {
    let p = params.ok_or(RpcError { code: -32602, message: "params required".into(), data: None })?;
    let seq = p["seq"].as_u64().ok_or(RpcError { code: -32602, message: "seq required".into(), data: None })?;
    let target = p["target_height"].as_u64().ok_or(RpcError { code: -32602, message: "target_height required".into(), data: None })?;
    let storage = blockchain.get_storage();
    let genesis_hash = storage.genesis_anchor()
        .ok_or(RpcError { code: -32000, message: "genesis hash unavailable".into(), data: None })?;
    let msg = crate::consensus_v2_node::recovery_decree_msg(&genesis_hash, seq, target);
    let crypto = crate::node::try_get_quantum_crypto()
        .ok_or(RpcError { code: -32000, message: "crypto unavailable".into(), data: None })?;
    let node_id = blockchain.get_node_id();
    match crypto.create_consensus_signature(&node_id, &msg).await {
        Ok(sig) => Ok(json!({ "node_id": node_id, "sig": hex::encode(sig.signature.into_bytes()) })),
        Err(e) => Err(RpcError { code: -32000, message: format!("sign failed: {}", e), data: None }),
    }
}

/// Operator: validate the assembled decree and inject it (gossip + local execution).
async fn node_decree_submit(blockchain: Arc<BlockchainNode>, params: Option<Value>) -> Result<Value, RpcError> {
    let p = params.ok_or(RpcError { code: -32602, message: "params required".into(), data: None })?;
    let seq = p["seq"].as_u64().ok_or(RpcError { code: -32602, message: "seq required".into(), data: None })?;
    let target = p["target_height"].as_u64().ok_or(RpcError { code: -32602, message: "target_height required".into(), data: None })?;
    let sigs: Vec<(String, Vec<u8>)> = p["sigs"].as_array()
        .ok_or(RpcError { code: -32602, message: "sigs required".into(), data: None })?
        .iter()
        .filter_map(|e| Some((e["node_id"].as_str()?.to_string(), hex::decode(e["sig"].as_str()?).ok()?)))
        .collect();
    let storage = blockchain.get_storage();
    if seq <= storage.applied_decree_seq() {
        return Err(RpcError { code: -32000, message: "seq at or below applied floor".into(), data: None });
    }
    let genesis_hash = storage.genesis_anchor()
        .ok_or(RpcError { code: -32000, message: "genesis hash unavailable".into(), data: None })?;
    if !crate::consensus_v2_node::verify_recovery_decree(&genesis_hash, seq, target, &sigs) {
        return Err(RpcError { code: -32000, message: "decree signature quorum not met".into(), data: None });
    }
    // The same floor every receiving node applies: never below what this node holds certified.
    let floor = BlockchainNode::certified_rollback_floor(&storage);
    if target < floor {
        return Err(RpcError { code: -32000,
            message: format!("target {} is below the certified floor {}: a certified checkpoint is irrevocable", target, floor),
            data: None });
    }
    if let Some(p2p) = blockchain.get_unified_p2p() {
        p2p.gossip_to_random_peers(crate::unified_p2p::NetworkMessage::RecoveryDecree {
            seq, target_height: target, sigs }, 16);
    }
    // Execute after the HTTP response flushes; execution prunes and restarts the process.
    let storage2 = storage.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        crate::consensus_v2_node::execute_recovery_decree(&storage2, seq, target);
    });
    Ok(json!({ "accepted": true, "seq": seq, "target_height": target }))
}

async fn node_arm_recovery(blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    let storage = blockchain.get_storage();
    let heard = crate::node::rc_recent_consensus_senders();
    // Dry-run FIRST, so the operator gets the real refusal reason, then hand the actual arm to the
    // consensus loop. Arming here directly would leave the DRIVER unarmed — and the loop's evaluator,
    // seeing the global already set, would never call set_recovery_span again.
    let dry = crate::node::rc_try_arm_dry(&storage, &heard, true);
    if dry.is_ok() { crate::node::rc_request_arm(); }
    match dry {
        Ok((a, ah, cpi)) => {
            let cs = crate::node::rc_current_committee();
            let (lo, hi) = qnet_consensus::checkpoint_bft::recovery_failover_windows(a);
            Ok(json!({
                "armed": true,
                "anchor_mb": a,
                "anchor_cp_index": cpi,
                "anchor_digest": hex::encode(ah),
                // The span pins WINDOWS, never checkpoint indices: a view change advances the round
                // without certifying a window, so an index range would describe nothing.
                "span_windows": [lo, hi],
                "committee": cs.len(),
                "quorum_size": qnet_consensus::checkpoint_bft::quorum_size(cs.len()),
                "relaxed_quorum": qnet_consensus::checkpoint_bft::relaxed_quorum(cs.len()),
            }))
        }
        Err(r) => Ok(json!({ "armed": false, "reason": r.reason() })),
    }
}

/// Hand the disarm to the consensus loop, exactly as the arm is handed over. Clearing the global here
/// would leave the DRIVER pinned — it would keep emitting relaxed checkpoints — and the loop's unarmed
/// branch would simply re-arm on the next tick, so the operator would see no effect at all.
async fn node_disarm_recovery() -> Result<Value, RpcError> {
    crate::node::rc_request_disarm();
    Ok(json!({ "disarm_requested": true, "armed": crate::node::rc_armed().is_some() }))
}

async fn node_recovery_status(_blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    let heard = crate::node::rc_recent_consensus_senders();
    match crate::node::rc_armed() {
        Some((a, ah, cpi)) => {
            let cs = crate::node::rc_current_committee();
            let (lo, hi) = qnet_consensus::checkpoint_bft::recovery_failover_windows(a);
            Ok(json!({
                "armed": true,
                "anchor_mb": a,
                "anchor_cp_index": cpi,
                "anchor_digest": hex::encode(ah),
                "span_windows": [lo, hi],
                "heard_from": cs.iter().filter(|id| heard.contains(*id)).count(),
                "committee": cs.len(),
                "quorum_size": qnet_consensus::checkpoint_bft::quorum_size(cs.len()),
                "relaxed_quorum": qnet_consensus::checkpoint_bft::relaxed_quorum(cs.len()),
            }))
        }
        None => Ok(json!({ "armed": false, "enabled": crate::node::RC_ENABLED,
                           "heard_from": heard.len() })),
    }
}

/// Who asks the burn attestor (H10).
#[derive(Debug, Clone, Copy)]
enum AttestCaller {
    /// This node's own submit door, asking in-process: a committee caller by construction.
    Own,
    /// A JSON-RPC caller at this address. Loopback is no credential: behind a TLS terminator that passed
    /// no client on, every public caller would read as loopback.
    Remote(Option<IpAddr>),
}

async fn node_attest_burn(blockchain: Arc<BlockchainNode>, params: Option<Value>, remote_addr: Option<std::net::SocketAddr>) -> Result<Value, RpcError> {
    attest_burn(&blockchain, params, AttestCaller::Remote(remote_addr.map(|a| a.ip()))).await
}

/// This node's own attestor, asked by its own collector (`collect_burn_attestations`) without a network
/// hop, answering in the JSON-RPC envelope the collector reads from every other member.
pub(crate) async fn attest_burn_in_process(blockchain: &BlockchainNode, params: Value) -> Value {
    match attest_burn(blockchain, Some(params), AttestCaller::Own).await {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": 1, "result": result }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": 1, "error": e }),
    }
}

async fn attest_burn(blockchain: &BlockchainNode, params: Option<Value>, caller: AttestCaller) -> Result<Value, RpcError> {
    let params = params.unwrap_or(serde_json::Value::Null);
    let burn_tx = params.get("burn_tx").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let solana_wallet = params.get("solana_wallet").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let qnet_wallet = params.get("qnet_wallet").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let amount = params.get("amount").and_then(|v| v.as_u64()).unwrap_or(0);
    let node_type = match params.get("node_type").and_then(|v| v.as_str()).unwrap_or("super") {
        "light" => qnet_state::NodeType::Light,
        _ => qnet_state::NodeType::Super,
    };
    // M-5: the epoch the registrant will bind — this attestor signs it into the message + self-checks
    // membership in THAT epoch's committee (not its own tip), so the apply-time verifier agrees.
    let attest_epoch = params.get("attest_epoch").and_then(|v| v.as_u64()).unwrap_or(0);
    if burn_tx.is_empty() || solana_wallet.is_empty() || qnet_wallet.is_empty() {
        return Err(RpcError { code: -32602, message: "burn_tx, solana_wallet, qnet_wallet required".to_string(), data: None });
    }
    // burn_tx must be a well-formed Solana signature (base58 of 64 bytes). Anything else can never
    // resolve on Solana, so it exists only to occupy queue slots and burn the attestor RPC quota.
    if burn_tx.len() > 100 || bs58::decode(&burn_tx).into_vec().map(|v| v.len()) != Ok(64) {
        return Err(RpcError { code: -32602, message: "burn_tx is not a base58 Solana signature".to_string(), data: None });
    }
    // Owner proof FIRST — before the epoch/committee resolution, the issuance throttle and any Solana
    // I/O. Only the burning wallet's owner may obtain an attestation for its burn: the per-attestor
    // dedup below binds burn_tx to the FIRST wallet attested, so without this check anyone reading a
    // public burn_tx could lock it to a bogus beneficiary and permanently brick the real owner's burn.
    // Cheap Ed25519 verify ⇒ also the DoS shield for everything that follows. The owner bind is the v1 form
    // (with the consent's time) or, for a light node from the wallet_one_node gate at this node's next
    // height, the v2 form without a time: the same strings block validation rebuilds.
    let own_next = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
        .load(std::sync::atomic::Ordering::Relaxed).saturating_add(1);
    let node_id = params.get("node_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    {
        let reg_proof = params.get("registration_proof").and_then(|v| v.as_str()).unwrap_or("");
        let owner_sig = params.get("owner_signature").and_then(|v| v.as_str()).unwrap_or("");
        let ts = params.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0);
        let attest_root = params.get("attest_root").and_then(|v| v.as_str()).unwrap_or("");
        if attest_root.len() > 64 {
            return Err(RpcError { code: -32602, message: "attest_root malformed".to_string(), data: None });
        }
        let verify = |msg: String| crate::crypto::solana_derivation::verify_ed25519_signature(
            msg.as_bytes(), owner_sig, &solana_wallet).unwrap_or(false);
        let v1 = !owner_sig.is_empty() && verify(qnet_state::Transaction::burn_owner_bind_message_tagged(
            &node_id, &qnet_wallet, reg_proof, ts, attest_root, &burn_tx));
        let v2 = !v1 && !owner_sig.is_empty() && matches!(node_type, qnet_state::NodeType::Light)
            && verify(qnet_state::Transaction::burn_owner_bind_message_v2_tagged(
                &node_id, &qnet_wallet, reg_proof, attest_root, &burn_tx));
        if !v1 && !(v2 && crate::node::BlockchainNode::owner_bind_v2_allowed(&node_type, own_next)) {
            // A light owner bind v2 before the gate is sound, only not accepted yet: the client retries once
            // this node lists `owner_bind_v2`, never treats it as a refusal of the burn.
            if v2 {
                return Err(RpcError { code: -32602,
                    message: "bind_v2_pending: the owner bind without a time is accepted from the wallet_one_node gate; retry later".to_string(),
                    data: Some(json!({ "code": "bind_v2_pending" })) });
            }
            return Err(RpcError { code: -32602,
                message: "owner_signature does not authorize this beneficiary for the burning wallet".to_string(),
                data: None });
        }
    }
    // One wallet, one node (wallet_one_node gate at this node's next height): no attestation for a wallet that
    // already has another node, before any epoch, committee or Solana work. Block validation refuses the
    // registration anyway; this spends nothing on it.
    if crate::node::BlockchainNode::wallet_one_node_other(&blockchain.get_storage(), &qnet_wallet, &node_id, own_next).is_some() {
        return Err(RpcError { code: -32602, message: "wallet already has a node".to_string(), data: None });
    }
    // Arithmetic epoch bound BEFORE any committee resolution (mirrors sign_burn_attestation):
    // only ~4 distinct epochs are ever resolvable, so the membership cache below stays complete
    // and junk attest_epoch values cannot buy macroblock reads + committee sampling per request.
    let own_epoch = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
        .load(std::sync::atomic::Ordering::Relaxed).saturating_sub(1) / 90 + 1;
    if attest_epoch == 0 || attest_epoch > own_epoch + 1 || own_epoch > attest_epoch + 2 {
        return Err(RpcError { code: -32601, message: "not an attestor for attest_epoch".to_string(), data: None });
    }
    // Cheap committee gate (avoids a wasted Solana lookup on non-members); own-membership is a pure
    // fn of the immutable N-2 snapshot per epoch — cache it so resolution cost is once per epoch,
    // not per request. sign_burn_attestation re-checks membership + recency authoritatively.
    static ATTEST_MEMBER_CACHE: Lazy<parking_lot::Mutex<Vec<(u64, bool)>>> =
        Lazy::new(|| parking_lot::Mutex::new(Vec::new()));
    let is_member = {
        let cached = ATTEST_MEMBER_CACHE.lock().iter().find(|(e, _)| *e == attest_epoch).map(|(_, m)| *m);
        match cached {
            Some(m) => m,
            None => {
                let m = blockchain.is_committee_attestor_for_epoch(attest_epoch);
                let mut c = ATTEST_MEMBER_CACHE.lock();
                if c.len() >= 4 { c.remove(0); }
                c.push((attest_epoch, m));
                m
            }
        }
    };
    if !is_member {
        return Err(RpcError { code: -32601, message: "not an attestor for attest_epoch".to_string(), data: None });
    }
    // Recompute the Phase-1 cost from THIS attestor's own Solana supply read (NOT the caller's hint) so
    // a forged hint can't lower the binding cost. Then require the ACTUAL on-Solana burn to cover it.
    let (total_burned, current_supply) = match cached_solana_1dev_supply().await {
        Ok(v) => v,
        Err(e) => return Err(RpcError { code: -32000, message: format!("solana_supply_unavailable: {}", e), data: None }),
    };
    let cost = qnet_state::Transaction::phase1_activation_cost(total_burned, current_supply);
    // Verify the external Solana 1DEV burn BEFORE the issuance queue, so a queue slot can only ever be
    // held by a burn that provably exists — i.e. it costs the attacker a real 1DEV burn, not a free
    // string. First-sight results are persisted per (burn_tx, burner); failures are negative-cached so a
    // repeat costs one map probe instead of a Solana round-trip, and first-sight lookups are bounded per
    // burner so one identity cannot drain the attestor's third-party RPC quota.
    let cached_burn = blockchain.get_storage().attest_burn_verified_get(&burn_tx, &solana_wallet).ok().flatten();
    let actual_burned = match cached_burn {
        Some(a) if a >= cost => a,
        Some(_) => return Err(RpcError { code: -32000, message: format!("verified burn below current cost {} 1DEV", cost), data: None }),
        None => {
            if attest_lookup_known_bad(&burn_tx, &solana_wallet) {
                return Err(RpcError { code: -32000, message: "burn previously failed verification".to_string(), data: None });
            }
            // H10: a committee member asks from its submit door, which already metered the client per
            // address and per node (U14). Anyone else gets the outside lane: per address, and a share
            // of the quota the doors never compete for.
            let (caller_ip, outside) = match caller {
                AttestCaller::Own => (None, false),
                AttestCaller::Remote(ip) => (ip, !ip.map_or(false, |ip| attest_caller_in_committee(blockchain, ip, attest_epoch))),
            };
            let addr_key = if outside { caller_ip.filter(|ip| !is_ip_whitelisted(*ip)).map(lookup_meter_key) } else { None };
            // A committee caller spends its own door's share: this node's door, or the member's address.
            let door_key = match caller {
                AttestCaller::Own => Some("own".to_string()),
                AttestCaller::Remote(ip) if !outside => ip.map(lookup_meter_key),
                AttestCaller::Remote(_) => None,
            };
            let door = door_key.as_deref();
            let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            let pending = |retry: u64| RpcError { code: -32050, message: "attest_pending".to_string(),
                                                  data: Some(json!({ "retry_after_secs": retry })) };
            if let Some(k) = &addr_key {
                ATTEST_OUTSIDE_ADDR_LIMIT.check(k, now).map_err(pending)?;
            }
            attest_lookup_admit(&solana_wallet, outside, door).map_err(pending)?;
            if let Some(k) = &addr_key {
                ATTEST_OUTSIDE_ADDR_LIMIT.allows(k, now);
            }
            if outside && is_info() {
                println!("[INFO][BURN] attest_outside_lookup caller={} burner={}",
                         caller_ip.map(|ip| ip.to_string()).unwrap_or_default(), qnet_state::char_prefix(&solana_wallet, 12));
            }
            // ONE attempt, not three. The retry loop inside exists for the registrant's own submit path
            // (a fresh Solana TX can take 5-15 s to index); here it multiplies every unauthenticated
            // request by 3 upstream getTransaction calls. A burn that is not yet indexed simply gets
            // re-polled by the collector on its next cooldown.
            let a = match verify_burn_transaction_exists_attempts(&burn_tx, &solana_wallet, cost, 1, 1).await {
                Ok((true, actual)) => actual,
                // Definitive answer from Solana (no such burn / not a burn / below the required amount):
                // safe to remember. An Err is a transport or indexing problem — the burn may confirm a
                // moment later, so it is retried, never blacklisted.
                Ok((false, _)) => {
                    attest_lookup_mark_bad(&burn_tx, &solana_wallet);
                    return Err(RpcError { code: -32000, message: format!("burn not verified on Solana or below cost {} 1DEV", cost), data: None });
                }
                Err(e) => {
                    return Err(RpcError { code: -32000, message: format!("burn verification unavailable: {}", e), data: None });
                }
            };
            let _ = blockchain.get_storage().attest_burn_verified_put(&burn_tx, &solana_wallet, a);
            a
        }
    };
    // Signature-issuance throttle, now over VERIFIED burns only.
    if let Err(retry_after_secs) = attest_throttle_admit(&burn_tx, &solana_wallet) {
        return Err(RpcError {
            code: -32050,
            message: "attest_pending".to_string(),
            data: Some(json!({ "retry_after_secs": retry_after_secs })),
        });
    }
    // Surface any divergence between the caller's declared amount and the verified on-chain amount.
    println!("[INFO][BURN] attest_amount declared={} actual_burned={} cost={}", amount, actual_burned, cost);
    // Sign over the ACTUAL on-Solana burned amount (NOT the caller's hint) + the locally-recomputed cost;
    // return BOTH the signed cost AND the signed amount so the collector agrees on the on-chain truth and
    // the registrant embeds the committee-certified amount (closes the over-burn quorum footgun: the
    // embedded burn_amount must equal the amount the counted 2f+1 attestors actually signed).
    // The signed burner address is the one THIS attestor verified as the Solana fee payer above —
    // never a caller-supplied value. Block validation binds wallet_address to it, so the beneficiary
    // wallet can no longer be an arbitrary third party's.
    match blockchain.sign_burn_attestation(&burn_tx, &solana_wallet, &qnet_wallet, actual_burned, node_type, cost, attest_epoch) {
        Some((genesis_id, sig)) => Ok(serde_json::json!({ "genesis_id": genesis_id, "sig": sig, "cost": cost,
                                                          "amount": actual_burned, "burn_wallet": solana_wallet })),
        None => Err(RpcError { code: -32000, message: "attestation refused (dedup / not committee / stale epoch)".to_string(), data: None }),
    }
}

/// Read the live 1DEV (total_burned, current_supply) from Solana via getTokenSupply on the configured
/// 1DEV mint. total_supply is the fixed 1B 1DEV genesis cap; total_burned = cap − current. Used ONLY on
/// the attestor admission path (live RPC, per-node, NEVER consensus) to recompute the Phase-1 cost.
pub async fn fetch_solana_1dev_supply() -> Result<(u64, u64), String> {
    const ONEDEV_TOTAL_SUPPLY: u64 = 1_000_000_000; // 1B 1DEV genesis cap
    let network_config = crate::network_config::get_network_config();
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "getTokenSupply",
        "params": [network_config.solana.onedev_mint]
    });
    // One shared client: a fresh reqwest::Client per call means a fresh TLS handshake and a
    // discarded connection pool on every supply read.
    static SUPPLY_HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });
    let resp = SUPPLY_HTTP.post(&network_config.solana.rpc_url)
        .json(&body)
        .send().await
        .map_err(|e| format!("rpc: {}", e))?;
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {}", e))?;
    // amount is the raw supply in 6-decimal base units; convert to whole 1DEV.
    let amount_str = json["result"]["value"]["amount"].as_str()
        .ok_or_else(|| "missing result.value.amount".to_string())?;
    let raw: u64 = amount_str.parse().map_err(|_| "amount not a u64".to_string())?;
    let current_supply = raw / 1_000_000;
    let total_burned = ONEDEV_TOTAL_SUPPLY.saturating_sub(current_supply);
    Ok((total_burned, current_supply))
}

// RPC method implementations
async fn node_get_info(blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    let height = blockchain.get_height().await;
    let peer_count = blockchain.get_peer_count().await.unwrap_or(0);
    let mempool_size = blockchain.get_mempool_size().await.unwrap_or(0);
    
    // v3.18: Full node type removed - only Light and Super remain
    let node_type = match blockchain.get_node_type() {
        crate::node::NodeType::Light => "light",
        crate::node::NodeType::Super => "super",
    };
    
    let region = match blockchain.get_region() {
        crate::node::Region::NorthAmerica => "na",
        crate::node::Region::Europe => "eu",
        crate::node::Region::Asia => "asia",
        crate::node::Region::SouthAmerica => "sa",
        crate::node::Region::Africa => "africa",
        crate::node::Region::Oceania => "oceania",
    };
    
    // IMPORTANT: This method does NOT include activation code for security
    // Use /api/v1/node/secure-info endpoint for authenticated code retrieval
    Ok(json!({
        "node_id": format!("node_{}", blockchain.get_port()),
        "height": height,
        "peers": peer_count,
        "mempool_size": mempool_size,
        "version": "0.1.0",
        "build": crate::node::build_id(),
        "node_type": node_type,
        "region": region,
        "status": "active"
    }))
}

async fn node_get_status(_blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    Ok(json!({
        "status": "running",
        "uptime": 0,
        "memory_usage": 0
    }))
}

async fn node_get_peers(blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    let peer_count = blockchain.get_peer_count().await.unwrap_or(0);
    
    // Get real peer list from blockchain node
    let peers = blockchain.get_connected_peers().await.unwrap_or_default();
    
    // Format peers for RPC response
    let peer_list: Vec<Value> = peers.iter().map(|peer| {
        let real_reputation = qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
        json!({
            "id": peer.id,
            "address": peer.address,
            "node_type": peer.node_type,
            "region": peer.region,
            "last_seen": peer.last_seen,
            "connection_time": peer.connection_time,
            "reputation": real_reputation, // v3.19: From blockchain!
            "version": peer.version.as_deref().unwrap_or("unknown")
        })
    }).collect();
    
    Ok(json!({
        "count": peer_count,
        "peers": peer_list,
        "max_peers": 50,
        "connection_status": "healthy"
    }))
}

async fn chain_get_height(blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    let height = blockchain.get_height().await;
    Ok(json!({
        "height": height
    }))
}

async fn chain_get_block(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(), data: None,
    })?;
    
    let height = params["height"].as_u64().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing height parameter".to_string(), data: None,
    })?;
    
    match blockchain.get_block_with_hash(height).await {
        Ok(Some((block, hash))) => Ok(block_json(&block, hash)),
        Ok(None) => Err(RpcError {
            code: -32000,
            message: format!("Block {} not found", height), data: None,
        }),
        Err(e) => {
            println!("[WARN][RPC] rpc_error method=chain_get_block height={} err={}", height, e);
            Err(RpcError {
                code: -32000,
                message: "internal error".to_string(), data: None,
            })
        }
    }
}

async fn chain_get_blocks(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.unwrap_or_else(|| json!({}));
    let start = params["start"].as_u64().unwrap_or(0);
    let limit = params["limit"].as_u64().unwrap_or(10).min(100);
    
    let mut blocks = Vec::new();
    for height in start..start.saturating_add(limit) {
        if let Ok(Some((block, hash))) = blockchain.get_block_with_hash(height).await {
            blocks.push(block_json(&block, hash));
        }
    }

    Ok(json!(blocks))
}

async fn tx_submit(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(), data: None,
    })?;
    
    // Parse transaction from params
    let from = params["from"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing from".to_string(), data: None,
    })?;
    
    let to = params["to"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing to".to_string(), data: None,
    })?;

    // SECURITY: Validate EON address format (consistent with REST endpoint)
    if let Err(e) = validate_eon_address_with_error(from) {
        return Err(RpcError { code: -32602, message: format!("Invalid 'from' address: {}", e), data: None });
    }
    if let Err(e) = validate_eon_address_with_error(to) {
        return Err(RpcError { code: -32602, message: format!("Invalid 'to' address: {}", e), data: None });
    }
    if let Err(r) = tx_api::check_recipient(&blockchain, to).await {
        return Err(r.to_rpc_error(to));
    }

    // SECURITY: Use as_u64() directly — as_f64()→as u64 causes precision loss for large values
    let amount = params["amount"].as_u64().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing or invalid amount (must be unsigned integer)".to_string(), data: None,
    })?;
    
    let gas_price = params["gas_price"].as_u64().unwrap_or(qnet_state::transaction::MIN_GAS_PRICE); // floor default (was 1 ⇒ rejected)
    let gas_limit = params["gas_limit"].as_u64().unwrap_or(10_000); // QNet TRANSFER gas limit
    
    // PURE DILITHIUM (F0.2): QNet TX are authorised by ML-DSA-65 only (Ed25519 is Solana-only). Require
    // the Dilithium sig+pk and bind the key to `from` (address = SHA512(dilithium_pk)); the authoritative
    // check is verify_user_tx_dilithium at submit_transaction downstream.
    let dilithium_signature = params["dilithium_signature"].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty());
    let dilithium_public_key = params["dilithium_public_key"].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty());
    // The signature is ALWAYS mandatory (pure-PQ; Ed25519 is Solana-only, not accepted on QNet).
    if dilithium_signature.is_none() {
        return Err(RpcError {
            code: -32602,
            message: "dilithium_signature required (pure-PQ; Ed25519 not accepted on QNet)".to_string(), data: None,
        });
    }
    // FIX-5 pk-elision: the pubkey may be OMITTED once it is committed on-chain (the first-use TX carries
    // it and binds it write-once). When present, verify its from-binding early (cheap reject); when absent,
    // submit_transaction rehydrates it from committed state and rejects if it cannot be resolved.
    if let Some(p) = &dilithium_public_key {
        let binds_from = crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(p)
            .map(|e| e == from).unwrap_or(false);
        if !binds_from {
            return Err(RpcError {
                code: -32602,
                message: "dilithium_public_key does not derive to `from` (ownership unproven)".to_string(), data: None,
            });
        }
    }
    
    // Create transaction
    let mut tx = qnet_state::Transaction {
        hash: String::new(), // will be calculated
        from: from.to_string(),
        to: Some(to.to_string()),
        amount,
        nonce: 0, // will be set by state
        gas_price,
        gas_limit,
        timestamp: chrono::Utc::now().timestamp() as u64,
        signature: None,  // pure-Dilithium; Ed25519 not on a QNet path
        public_key: None,
        tx_type: qnet_state::TransactionType::Transfer {
            from: from.to_string(),
            to: to.to_string(),
            amount,
        },
        data: None, // no data for simple transfer
        // FIX-5: JSON hop carries HEX of the raw detached sig (3309 B) / raw pk (1952 B, elidable → None)
        dilithium_signature: dilithium_signature.as_deref().and_then(|s| hex::decode(s).ok()),
        dilithium_public_key: dilithium_public_key.as_deref().and_then(|s| hex::decode(s).ok()),
        chain_id: qnet_state::transaction::QNET_CHAIN_ID,
    };

    // Calculate hash
    tx.hash = tx.calculate_hash();

    match blockchain.submit_transaction(tx).await {
        Ok(hash) => Ok(json!({
            "hash": hash
        })),
        Err(e) => {
            println!("[WARN][RPC] rpc_error method=tx_submit err={}", e);
            Err(RpcError {
                code: -32000,
                message: "request failed".to_string(), data: None,
            })
        }
    }
}

// PURE DILITHIUM (F0.1): account_set_pq_requirement RPC removed — PQ signing is
// mandatory network-wide, so a per-wallet opt-in upgrade endpoint is obsolete.

async fn tx_get(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(), data: None,
    })?;
    
    let tx_hash = params["hash"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing hash parameter".to_string(), data: None,
    })?;
    
    // Get transaction from blockchain
    match blockchain.get_transaction(tx_hash).await {
        Ok(Some(tx)) => {
            let mut response = json!({
                "hash": tx.hash,
                "from": tx.from,
                "to": tx.to,
                "amount": tx.amount,
                "nonce": tx.nonce,
                "gas_price": tx.gas_price,
                "gas_limit": tx.gas_limit,
                "timestamp": tx.timestamp,
                "status": tx.status,
                "block_height": tx.block_height.unwrap_or(0)
            });
            
            // Add Fast Finality Indicators if available
            if let Some(ref confirmation_level) = tx.confirmation_level {
                response["finality_indicators"] = json!({
                    "level": format!("{:?}", confirmation_level),
                    "safety_percentage": tx.safety_percentage.unwrap_or(0.0),
                    "confirmations": tx.confirmations.unwrap_or(0),
                    "time_to_finality": tx.time_to_finality.unwrap_or(90),
                    "risk_assessment": match tx.safety_percentage.unwrap_or(0.0) {
                        s if s >= 99.99 => "safe_for_any_amount",
                        s if s >= 99.9 => "safe_for_amounts_under_10000000_qnc",  // 10M QNC (~0.25% of supply)
                        s if s >= 99.0 => "safe_for_amounts_under_1000000_qnc",   // 1M QNC (~0.025% of supply)
                        s if s >= 95.0 => "safe_for_amounts_under_100000_qnc",    // 100K QNC (~0.0025% of supply)
                        s if s >= 90.0 => "safe_for_amounts_under_10000_qnc",     // 10K QNC (~0.00025% of supply)
                        _ => "wait_for_more_confirmations"
                    }
                });
            }
            
            Ok(response)
        },
        Ok(None) => Err(RpcError {
            code: -32000,
            message: format!("Transaction {} not found", tx_hash), data: None,
        }),
        Err(e) => {
            println!("[WARN][RPC] rpc_error method=tx_get hash={} err={}", tx_hash, e);
            Err(RpcError {
                code: -32000,
                message: "internal error".to_string(), data: None,
            })
        }
    }
}

async fn mempool_get_transactions(blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    let transactions = blockchain.get_mempool_transactions().await;
    Ok(json!(transactions))
}

async fn mempool_submit(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(), data: None,
    })?;
    
    // Support both single transaction and batch
    let transactions = if let Some(arr) = params.as_array() {
        // Batch mode - process multiple transactions
        arr.clone()
    } else {
        // Single transaction mode
        vec![params]
    };
    
    // PRODUCTION: Always validate transactions (no skip option)
    let mut results = Vec::new();
    let mut all_transactions = Vec::new();
    
    // Create all transactions first
    for tx_data in &transactions {
        // Parse transaction fields
        let from = tx_data["from"].as_str().ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing from field".to_string(), data: None,
        })?;
        
        let to = tx_data["to"].as_str().ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing to field".to_string(), data: None,
        })?;
        if let Err(r) = tx_api::check_recipient(&blockchain, to).await {
            return Err(r.to_rpc_error(to));
        }
        
        let amount = tx_data["amount"].as_u64().ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing amount field".to_string(), data: None,
        })?;
        
        let nonce = tx_data["nonce"].as_u64().unwrap_or(0);
        let timestamp = tx_data["timestamp"].as_u64().unwrap_or_else(|| chrono::Utc::now().timestamp() as u64);
        
        // PURE DILITHIUM (F0.2): require the ML-DSA-65 sig+pk per TX and bind the key to `from`
        // (address = SHA512(dilithium_pk)); Ed25519 is Solana-only and not accepted on a QNet path.
        let dil_sig = tx_data["dilithium_signature"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing dilithium_signature - QNet TX require an ML-DSA-65 signature".to_string(), data: None,
        })?;
        let dil_pk = tx_data["dilithium_public_key"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing dilithium_public_key".to_string(), data: None,
        })?;
        if crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey(dil_pk).as_deref() != Some(from) {
            return Err(RpcError {
                code: -32602,
                message: "dilithium_public_key does not derive to `from` (ownership unproven)".to_string(), data: None,
            });
        }
        
        // Create transaction
        let mut tx = qnet_state::Transaction {
            hash: String::new(), // will be calculated
            from: from.to_string(),
            to: Some(to.to_string()),
            amount,
            nonce,
            gas_price: qnet_state::transaction::MIN_GAS_PRICE, // at/above the fee floor (was 1 ⇒ rejected)
            gas_limit: 10_000, // QNet TRANSFER gas limit
            timestamp,
            signature: None,  // pure-Dilithium; Ed25519 not on a QNet path
            public_key: None,
            tx_type: qnet_state::TransactionType::Transfer {
                from: from.to_string(),
                to: to.to_string(),
                amount,
            },
            data: None, // no data for simple transfer
            // FIX-5: hex(raw detached sig) / hex(raw pk) -> bytes
            dilithium_signature: hex::decode(dil_sig).ok(),
            dilithium_public_key: hex::decode(dil_pk).ok(),
            chain_id: qnet_state::transaction::QNET_CHAIN_ID,
        };

        // Calculate hash
        tx.hash = tx.calculate_hash();
        all_transactions.push(tx);
    }
    
    // PRODUCTION: Always validate all transactions (signature, balance, nonce)
    for tx in all_transactions {
        match blockchain.submit_transaction(tx).await {
            Ok(hash) => results.push(json!({ "hash": hash, "success": true })),
            Err(e) => {
                println!("[WARN][RPC] rpc_error method=tx_submit_batch err={}", e);
                results.push(json!({ "hash": "", "success": false, "error": "request failed" }));
            }
        }
    }
    
    // Return appropriate response
    if transactions.len() == 1 {
        // Single transaction mode - return single result
        Ok(results.into_iter().next().unwrap_or(json!(null)))
    } else {
        // Batch mode - return array of results
        Ok(json!(results))
    }
}

async fn account_get_info(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(), data: None,
    })?;
    
    let address = params["address"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing address parameter".to_string(), data: None,
    })?;
    
    match blockchain.try_get_account(address).await {
        Ok(account) => Ok(json!(account)),
        Err(()) => Err(account_unreadable_rpc_error()),
    }
}

/// SH2 for the JSON-RPC account reads: a row this node could not read is an error, never an empty account.
fn account_unreadable_rpc_error() -> RpcError {
    RpcError {
        code: -32000,
        message: "account_unreadable: this node could not read the account from its storage; ask again or ask another node".to_string(),
        data: None,
    }
}

async fn account_get_balance(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(), data: None,
    })?;
    
    let address = params["address"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing address parameter".to_string(), data: None,
    })?;
    
    match blockchain.try_get_account_basic(address).await {
        Ok(account) => Ok(json!({
            "balance": account.map_or(0, |a| a.balance)
        })),
        Err(()) => Err(account_unreadable_rpc_error()),
    }
}

async fn stats_get(blockchain: Arc<BlockchainNode>) -> Result<Value, RpcError> {
    match blockchain.get_stats().await {
        Ok(stats) => Ok(json!(stats)),
        Err(err) => {
            let error_response = json!({
                "error": "Failed to get stats",
                "details": err.to_string()
            });
            Ok(error_response)
        }
    }
}

/// Get node statistics  
pub async fn handle_get_stats(blockchain: Arc<BlockchainNode>) -> Result<impl warp::Reply, warp::Rejection> {
    match blockchain.get_stats().await {
        Ok(stats) => Ok(warp::reply::json(&stats)),
        Err(err) => {
            let error_response = serde_json::json!({
                "error": "Failed to get stats",
                "details": err.to_string()
            });
            Ok(warp::reply::json(&error_response))
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════
// QUANTUM RANDOMNESS BEACON (QRB) v3.0 - RPC API
// Provides verifiable randomness for smart contracts: gambling, NFT mints, auctions
// Quantum-safe: All VRFs use ML-DSA-65 signatures (NIST FIPS 204)
// ═══════════════════════════════════════════════════════════════════════════════════

/// Get randomness beacon for a specific epoch (macroblock)
/// Method: qrb_getRandomness
/// Params: { "epoch": u64 } - macroblock number (1, 2, 3, ...)
/// Returns: { "randomness": "0x...", "epoch": u64, "vrf_contributions": u64 }
async fn qrb_get_randomness(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing params - expected { epoch: number }".to_string(), data: None,
    })?;
    
    let epoch = params["epoch"].as_u64().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing or invalid 'epoch' parameter".to_string(), data: None,
    })?;
    
    // Get macroblock for epoch
    let storage = blockchain.get_storage();
    match storage.get_macroblock_by_height(epoch) {
        Ok(Some(macro_data)) => {
            match bincode::deserialize::<qnet_state::MacroBlock>(&macro_data) {
                Ok(macroblock) => {
                    let randomness = macroblock.consensus_data.randomness_beacon
                        .map(|r| format!("0x{}", hex::encode(r)))
                        .unwrap_or_else(|| "0x".to_string() + &"0".repeat(64));
                    
                    let vrf_count = macroblock.consensus_data.vrf_contributions_count.unwrap_or(0);
                    
                    Ok(json!({
                        "randomness": randomness,
                        "epoch": epoch,
                        "vrf_contributions": vrf_count,
                        "timestamp": macroblock.timestamp,
                        "verified": vrf_count > 0,
                        "quantum_safe": true,
                        "algorithm": "XOR(VRF_Dilithium3_1...VRF_Dilithium3_N)"
                    }))
                }
                Err(e) => {
                    println!("[WARN][RPC] rpc_error method=qrb_get_macroblock_randomness err={}", e);
                    Err(RpcError {
                        code: -32000,
                        message: "internal error".to_string(), data: None,
                    })
                }
            }
        }
        Ok(None) => Err(RpcError {
            code: -32001,
            message: format!("Epoch {} not yet finalized", epoch), data: None,
        }),
        Err(e) => {
            println!("[WARN][RPC] rpc_error method=qrb_get_macroblock err={:?}", e);
            Err(RpcError {
                code: -32000,
                message: "internal error".to_string(), data: None,
            })
        }
    }
}

/// Get latest finalized randomness beacon
/// Method: qrb_getLatestRandomness
/// Returns: { "randomness": "0x...", "epoch": u64, "vrf_contributions": u64 }
async fn qrb_get_latest_randomness(
    blockchain: Arc<BlockchainNode>,
) -> Result<Value, RpcError> {
    let height = blockchain.get_height().await;
    let latest_epoch = height / 90; // Each macroblock covers 90 microblocks
    
    if latest_epoch == 0 {
        return Err(RpcError {
            code: -32001,
            message: "No epochs finalized yet".to_string(), data: None,
        });
    }
    
    // Get the latest finalized epoch
    qrb_get_randomness(blockchain, Some(json!({ "epoch": latest_epoch }))).await
}

/// Get randomness combined with user-provided seed
/// Method: qrb_getRandomnessWithSeed
/// Params: { "epoch": u64, "seed": "0x..." }
/// Returns: { "randomness": "0x...", "combined": "0x...", "epoch": u64 }
/// Formula: combined = SHA3-256(beacon || seed)
async fn qrb_get_randomness_with_seed(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing params - expected { epoch: number, seed: string }".to_string(), data: None,
    })?;
    
    let epoch = params["epoch"].as_u64().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing or invalid 'epoch' parameter".to_string(), data: None,
    })?;
    
    let seed_hex = params["seed"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing 'seed' parameter".to_string(), data: None,
    })?;
    
    // Remove 0x prefix if present
    let seed_clean = seed_hex.trim_start_matches("0x");
    let seed_bytes = hex::decode(seed_clean).map_err(|e| RpcError {
        code: -32602,
        message: format!("Invalid seed hex: {}", e), data: None,
    })?;
    
    // Get base randomness
    let storage = blockchain.get_storage();
    match storage.get_macroblock_by_height(epoch) {
        Ok(Some(macro_data)) => {
            match bincode::deserialize::<qnet_state::MacroBlock>(&macro_data) {
                Ok(macroblock) => {
                    let beacon = macroblock.consensus_data.randomness_beacon
                        .unwrap_or([0u8; 32]);
                    
                    // Combine: SHA3-256(beacon || seed)
                    use sha3::{Sha3_256, Digest};
                    let mut hasher = Sha3_256::new();
                    hasher.update(b"QNet_QRB_v3_WithSeed");
                    hasher.update(&beacon);
                    hasher.update(&seed_bytes);
                    let combined = hasher.finalize();
                    
                    let vrf_count = macroblock.consensus_data.vrf_contributions_count.unwrap_or(0);
                    
                    Ok(json!({
                        "randomness": format!("0x{}", hex::encode(beacon)),
                        "seed": seed_hex,
                        "combined": format!("0x{}", hex::encode(combined)),
                        "epoch": epoch,
                        "vrf_contributions": vrf_count,
                        "verified": vrf_count > 0,
                        "quantum_safe": true,
                        "algorithm": "SHA3-256(beacon || seed)"
                    }))
                }
                Err(e) => {
                    println!("[WARN][RPC] rpc_error method=qrb_get_latest_randomness err={}", e);
                    Err(RpcError {
                        code: -32000,
                        message: "internal error".to_string(), data: None,
                    })
                }
            }
        }
        Ok(None) => Err(RpcError {
            code: -32001,
            message: format!("Epoch {} not yet finalized", epoch), data: None,
        }),
        Err(e) => {
            println!("[WARN][RPC] rpc_error method=qrb_get_latest_randomness err={:?}", e);
            Err(RpcError {
                code: -32000,
                message: "internal error".to_string(), data: None,
            })
        }
    }
}

/// Migrate device (same wallet, different device)
/// FIX R22-N6: Added ML-DSA-65 signature verification to prevent unauthorized migration.
/// Without this, anyone with an activation code could migrate a node to their device.
/// Now requires: activation_code + dilithium_signature + dilithium_public_key
/// The signature must be over "migrate:{activation_code}:{new_device_signature}"
async fn device_migration(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(), data: None,
    })?;

    let activation_code = params["activation_code"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing activation_code parameter".to_string(), data: None,
    })?;

    let new_device_signature = params["new_device_signature"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing new_device_signature parameter".to_string(), data: None,
    })?;

    // FIX R22-N6: Require ML-DSA-65 signature proving ownership of the node's keypair
    let dilithium_sig = params["dilithium_signature"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing dilithium_signature — cryptographic proof required for device migration".to_string(), data: None,
    })?;
    let dilithium_pk_hex = params["dilithium_public_key"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing dilithium_public_key — required for signature verification".to_string(), data: None,
    })?;

    // Verify ML-DSA-65/ML-DSA-65 signature over migration payload
    // Reuses existing verify_mobile_dilithium_signature() which supports both
    // mobile format ("dilithium_sig_...") and raw hex format.
    {
        let message = format!("migrate:{}:{}", activation_code, new_device_signature);
        if !verify_mobile_dilithium_signature(&message, dilithium_sig, dilithium_pk_hex) {
            println!("[WARN][MIGRATE] dilithium_verify_failed code={}...",
                     qnet_state::char_prefix(&activation_code, 16));
            return Err(RpcError {
                code: -32003,
                message: "Dilithium3 signature verification failed — unauthorized migration attempt".to_string(), data: None,
            });
        }
        println!("[INFO][MIGRATE] dilithium_verified code={}...",
                 qnet_state::char_prefix(&activation_code, 16));
    }

    let node_type = blockchain.get_node_type();

    match blockchain.migrate_device(activation_code, node_type, new_device_signature).await {
        Ok(_) => Ok(json!({
            "success": true,
            "message": "Device successfully migrated",
            "new_device_signature": new_device_signature,
            "timestamp": chrono::Utc::now().timestamp()
        })),
        Err(e) => Err(RpcError {
            code: -32000,
            message: format!("Device migration failed: {}", e), data: None,
        }),
    }
}

/// Get node transfer status
async fn node_get_transfer_status(
    blockchain: Arc<BlockchainNode>,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let params = params.ok_or_else(|| RpcError {
        code: -32602,
        message: "Invalid params".to_string(), data: None,
    })?;
    
    let activation_code = params["activation_code"].as_str().ok_or_else(|| RpcError {
        code: -32602,
        message: "Missing activation_code parameter".to_string(), data: None,
    })?;
    
    // Load activation to check transfer status
    match blockchain.load_activation_code().await {
        Ok(Some((code, node_type))) => {
            if code == activation_code {
                Ok(json!({
                    "has_activation": true,
                    "node_type": format!("{:?}", node_type),
                    "activated_at": chrono::Utc::now().timestamp(),
                    "supports_transfer": true,
                    "device_support": "VPS, VDS, PC, laptop, server"
                }))
            } else {
                Ok(json!({
                    "has_activation": false,
                    "supports_transfer": false
                }))
            }
        }
        Ok(None) => Ok(json!({
            "has_activation": false,
            "supports_transfer": false
        })),
        Err(e) => Err(RpcError {
            code: -32000,
            message: format!("Failed to check transfer status: {}", e), data: None,
        }),
    }
} 

/// The answer for an account row this node could not read (SH2): 503, never the default account, which
/// a client cannot tell from the chain's "no such account".
fn account_unreadable_answer(address: &str) -> (warp::http::StatusCode, Value) {
    (warp::http::StatusCode::SERVICE_UNAVAILABLE, json!({
        "success": false,
        "error": "account_unreadable",
        "message": "This node could not read the account from its storage; ask again or ask another node",
        "address": address,
    }))
}

/// A missing row: the chain has no such account yet.
fn account_default_answer(address: &str) -> Value {
    json!({
        "address": address,
        "balance": 0,
        "nonce": 0,
        "is_node": false,
        "node_type": null,
        "has_dilithium_pk": false,
        "reputation": 0.0
    })
}

/// `?fields=basic` (SH8): the account without its contract storage and code.
fn account_basic_answer(address: &str, read: Result<Option<qnet_state::AccountBasic>, ()>) -> (warp::http::StatusCode, Value) {
    let b = match read {
        Ok(b) => b.unwrap_or_else(|| qnet_state::AccountBasic {
            address: address.to_string(), balance: 0, nonce: 0, has_dilithium_pk: false, is_contract: false, contract_type: None,
        }),
        Err(()) => return account_unreadable_answer(address),
    };
    (warp::http::StatusCode::OK, json!({
        "address": address,
        "balance": b.balance,
        "nonce": b.nonce,
        "has_dilithium_pk": b.has_dilithium_pk,
        "is_contract": b.is_contract,
        "contract_type": b.contract_type,
    }))
}

// REST API Handler Functions
/// `GET /api/v1/account/{address}[?fields=basic]`.
async fn handle_account_info(
    address: String,
    params: HashMap<String, String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let (status, body) = match params.get("fields").map(|f| f.as_str()) {
        Some("basic") => account_basic_answer(&address, blockchain.try_get_account_basic(&address).await),
        Some(_) => (warp::http::StatusCode::BAD_REQUEST, json!({
            "success": false, "error": "fields_unsupported", "message": "fields takes one value: basic"
        })),
        None => match blockchain.try_get_account(&address).await {
            Ok(Some(account)) => {
                // FIX-5: project the account for the wire. Two reasons the raw pk must NOT be serialized here:
                // (a) it is a 1952-byte JSON array on EVERY balance poll — unaffordable at 10M light clients;
                // (b) the only thing a wallet needs is whether its key is already committed, so it can decide
                // pk-elision. `has_dilithium_pk` is that GROUND TRUTH — never infer it from nonce>=1, because a
                // node-constructed NodeActivation raises the wallet's nonce WITHOUT binding the wallet key.
                let has_dilithium_pk = account.dilithium_public_key.as_ref().map_or(false, |p| p.len() == 1952);
                // Present only for a genesis-funded (load-test) account, and only once the set is loaded.
                let genesis_allocation = genesis_allocations_nowait(blockchain.get_storage())
                    .map_or(false, |set| set.contains(&address));
                let mut v = serde_json::to_value(&account).unwrap_or_else(|_| json!({}));
                if let Some(obj) = v.as_object_mut() {
                    obj.remove("dilithium_public_key");
                    obj.insert("has_dilithium_pk".to_string(), json!(has_dilithium_pk));
                    if genesis_allocation {
                        obj.insert("genesis_allocation".to_string(), json!(true));
                    }
                }
                (warp::http::StatusCode::OK, v)
            }
            Ok(None) => (warp::http::StatusCode::OK, account_default_answer(&address)),
            Err(()) => account_unreadable_answer(&address),
        },
    };
    Ok(warp::reply::with_status(warp::reply::json(&body), status))
}

async fn handle_account_balance(
    address: String,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(warp::reply::with_status(rate_limit_response, warp::http::StatusCode::OK));
    }

    // v3.19: Validate address parameter (max 64 chars)
    if address.len() > 64 {
        return Ok(warp::reply::with_status(warp::reply::json(&json!({
            "error": "Invalid address",
            "message": "Address parameter too long (max 64 characters)"
        })), warp::http::StatusCode::OK));
    }

    // A row this node could not read answers the SH2 error, never a zero balance.
    let (status, body) = match blockchain.try_get_account_basic(&address).await {
        Ok(account) => (warp::http::StatusCode::OK, json!({
            "address": address,
            "balance": account.map_or(0, |a| a.balance)
        })),
        Err(()) => account_unreadable_answer(&address),
    };
    Ok(warp::reply::with_status(warp::reply::json(&body), status))
}

/// v5.0: GET /api/v1/snapshot/{height}/manifest — chunk manifest for parallel download
async fn handle_snapshot_manifest(
    height: u64,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    match blockchain.get_storage().get_snapshot_manifest(height) {
        Ok(Some(manifest)) => Ok(warp::reply::json(&manifest)),
        Ok(None) => {
            Ok(warp::reply::json(&json!({ "error": "Snapshot not found", "height": height })))
        }
        Err(e) => {
            println!("[WARN][RPC] api_error endpoint=snapshot_manifest height={} err={}", height, e);
            Ok(warp::reply::json(&json!({ "error": "Manifest error", "details": "internal error" })))
        }
    }
}

/// v5.0: GET /api/v1/snapshot/{height}/chunk/{index} — download a single chunk
async fn handle_snapshot_chunk(
    height: u64,
    chunk_index: usize,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(_) = check_api_rate_limit(remote_addr, "read_only") {
        let body = serde_json::to_vec(&json!({"error": "Rate limit exceeded"})).unwrap_or_default();
        return Ok(warp::reply::with_header(
            warp::reply::with_header(body, "Content-Type", "application/json"),
            "Content-Disposition", ""
        ));
    }
    let _serve_permit = match SNAPSHOT_SERVE_SEM.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            let body = serde_json::to_vec(&json!({"error": "snapshot serve busy"})).unwrap_or_default();
            return Ok(warp::reply::with_header(
                warp::reply::with_header(body, "Content-Type", "application/json"),
                "Content-Disposition", ""));
        }
    };
    match blockchain.get_storage().get_snapshot_chunk(height, chunk_index as u64) {
        Ok(Some(data)) => {
            Ok(warp::reply::with_header(
                warp::reply::with_header(
                    data,
                    "Content-Type",
                    "application/octet-stream"
                ),
                "Content-Disposition",
                format!("attachment; filename=\"snap_{}_{}.bin\"", height, chunk_index)
            ))
        }
        Ok(None) => {
            Ok(warp::reply::with_header(
                warp::reply::with_header(
                    serde_json::to_vec(&json!({"error":"Chunk not found"})).unwrap_or_default(),
                    "Content-Type",
                    "application/json"
                ),
                "Content-Disposition",
                ""
            ))
        }
        Err(e) => {
            println!("[WARN][RPC] api_error endpoint=snapshot_chunk err={}", e);
            Ok(warp::reply::with_header(
                warp::reply::with_header(
                    serde_json::to_vec(&json!({"error": "internal error"})).unwrap_or_default(),
                    "Content-Type",
                    "application/json"
                ),
                "Content-Disposition",
                ""
            ))
        }
    }
}

// F0.2 REMOVED: verify_ed25519_client_signature — dead. Ed25519 is Solana-only; the last QNet caller
// (the reward claim) is now pure-Dilithium, so no QNet path verifies a client Ed25519 signature.

// F0.2 REMOVED: verify_dilithium_client_signature — dead (no callers after the pure-Dilithium cutover).

// REMOVED: verify_dilithium_signature — dead after the /reactivate endpoint retired (B: reactivation is
// self-attest; light identity verifies via the ping-delegation chain against the on-chain key).

/// A light node's reply at this genesis's HTTP ingress (light-node-messages section 5.8).
async fn verify_light_node_signature(node_id: &str, challenge: &str, signature: &str, blockchain: &Arc<BlockchainNode>)
    -> Result<(), crate::light_device::ping::ReplyRefusal> {
    // Delegates to the SINGLE implementation shared with the gossip relay — duplicating the format
    // rules here is how a relay ends up admitting what this ingress rejects.
    match blockchain.get_unified_p2p() {
        Some(p2p) => p2p.verify_light_ping_signature(node_id, challenge, signature, crate::light_device::ping::Route::Ingress),
        None => {
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] p2p_unavailable node={}", node_id);
            }
            Err(crate::light_device::ping::ReplyRefusal::Sigma)
        }
    }
}

// Generate quantum-resistant challenge
pub fn generate_quantum_challenge() -> String {
    use rand::RngCore;
    use rand::rngs::OsRng;
    let mut challenge_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut challenge_bytes);
    hex::encode(challenge_bytes)
}

// SECURITY (G2): light-ping challenge is server-AUTHENTICATED and STATELESS (FCM-safe).
// Old flow let a light node invent its own challenge → self-attest liveness without being pinged.
// Now the genesis stamps a challenge = hex(nonce[16] | expiry_be[8] | mac[16]); the device echoes it
// and the same genesis re-verifies the mac. No per-node store (survives FCM-woken devices that never
// poll). Off-consensus path. Secret = SHA3(domain | node seed) — stable across restarts, never logged.
pub(crate) const LIGHT_CHALLENGE_TTL_SECS: u64 = 180;

/// How long a stamp issued at `height` stays answerable: until the shard's owners start building the
/// epoch bitmap, and never less than LIGHT_CHALLENGE_TTL_SECS (which is also the margin the slot draw
/// leaves for a stamp issued in the last drawn slot).
///
/// The reward unit is the whole epoch, so an answer three minutes late proves exactly the presence an
/// answer three seconds late proves. The fixed 180 s threw the late ones away — a phone leaving doze, a
/// push the system held back, a node restarting under a roll — and each throw cost that device its
/// epoch. The grid runs at one block per second, so blocks left in the window are seconds left.
fn challenge_lifetime_at(height: u64) -> u64 {
    let commit_opens_at = 14_400u64.saturating_sub(crate::node::light_commit_window(height / 14_400));
    commit_opens_at.saturating_sub(height % 14_400).max(LIGHT_CHALLENGE_TTL_SECS)
}

fn light_challenge_mac(node_id: &str, nonce: &[u8; 16], expiry: u64) -> [u8; 16] {
    use sha3::{Digest, Sha3_256};
    // Must go through the accessor: reading the raw env var ignores QNET_WALLET_SEED_FILE, and a
    // file-based deployment would silently key the MAC with an empty string — a constant anyone
    // can compute from this repository, which restores exactly the self-attestation the challenge
    // exists to stop.
    let seed = crate::node::load_wallet_seed("QNET_WALLET_SEED")
        .or_else(|| crate::node::load_wallet_seed("QNET_GENESIS_SEED"))
        .unwrap_or_default();
    let mut h = Sha3_256::new();
    h.update(b"qnet-light-challenge-secret-v1");
    h.update(seed.as_bytes());          // per-node secret (one-way, never exposed)
    h.update(node_id.as_bytes());       // bind to THIS node
    h.update(nonce);
    h.update(&expiry.to_be_bytes());
    let full = h.finalize();
    let mut mac = [0u8; 16];
    mac.copy_from_slice(&full[..16]);
    mac
}

/// Issue a server-authenticated challenge stamp for `node_id`, with the expiry the epoch allows.
/// Returns the stamp and that expiry, so a caller serving it (the polling route) reports the same one.
fn make_challenge_stamp(node_id: &str) -> (String, u64) {
    use rand::{RngCore, rngs::OsRng};
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut nonce = [0u8; 16];
    OsRng.fill_bytes(&mut nonce);
    let height = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
    let expiry = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
        + challenge_lifetime_at(height);
    let mac = light_challenge_mac(node_id, &nonce, expiry);
    let mut buf = Vec::with_capacity(40);
    buf.extend_from_slice(&nonce);
    buf.extend_from_slice(&expiry.to_be_bytes());
    buf.extend_from_slice(&mac);
    (hex::encode(buf), expiry)
}

/// Verify a challenge stamp was issued by THIS server to THIS node and is not expired.
fn verify_challenge_stamp(node_id: &str, challenge: &str) -> bool {
    use std::time::{SystemTime, UNIX_EPOCH};
    let bytes = match hex::decode(challenge) { Ok(b) => b, Err(_) => return false };
    if bytes.len() != 40 { return false; }
    let mut nonce = [0u8; 16];
    nonce.copy_from_slice(&bytes[0..16]);
    let mut exp_b = [0u8; 8];
    exp_b.copy_from_slice(&bytes[16..24]);
    let expiry = u64::from_be_bytes(exp_b);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    if expiry < now { return false; }
    let expected = light_challenge_mac(node_id, &nonce, expiry);
    bytes[24..40] == expected[..]
}

#[cfg(test)]
mod tests_client_addr {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    fn peer(ip: [u8; 4]) -> Option<SocketAddr> { Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::from(ip)), 40000)) }

    /// The bridge gateway a host terminator reaches a container from is read from the kernel's route table.
    #[test]
    fn the_default_gateway_is_read_from_the_route_table() {
        let table = "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n\
                     eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\n\
                     eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n";
        assert_eq!(default_gateway(table), Some("172.17.0.1".parse().unwrap()));
        assert_eq!(default_gateway("Iface\tDestination\tGateway\tFlags\neth0\t000011AC\t00000000\t0001\n"), None);
        assert_eq!(default_gateway(""), None);
    }

    /// Only a loopback peer may be spoken for, and only by the last address in the header — the one the
    /// terminator appended. A public peer keeps its own address whatever it sends.
    #[test]
    fn a_forwarded_address_is_taken_only_from_the_local_proxy() {
        let lo = peer([127, 0, 0, 1]);
        assert_eq!(forwarded_client(lo, Some("203.0.113.9")).unwrap().ip().to_string(), "203.0.113.9");
        assert_eq!(forwarded_client(lo, Some("1.2.3.4, 203.0.113.9")).unwrap().ip().to_string(), "203.0.113.9");
        assert_eq!(forwarded_client(lo, Some("[2001:db8::7]")).unwrap().ip().to_string(), "2001:db8::7");
        assert_eq!(forwarded_client(lo, None), lo, "a local caller with no proxy in between");
        let public = peer([198, 51, 100, 4]);
        assert_eq!(forwarded_client(public, Some("127.0.0.1")), public);
        assert_eq!(forwarded_client(None, Some("203.0.113.9")), None);
    }

    /// A header the terminator did not write - one naming this host, or no address at all - makes the
    /// request nobody in particular: never loopback, so never whitelisted and never a committee caller.
    #[test]
    fn a_forwarded_entry_that_names_this_host_is_nobody() {
        let lo = peer([127, 0, 0, 1]);
        for forged in ["127.0.0.1", "1.2.3.4, 127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1", "0.0.0.0", "garbage", ""] {
            let c = forwarded_client(lo, Some(forged)).unwrap();
            assert!(c.ip().is_unspecified(), "{forged:?} -> {c}");
            assert!(!c.ip().is_loopback() && !is_ip_whitelisted(c.ip()) && !is_private_ip(&c.ip()), "{forged:?}");
        }
    }
}

#[cfg(test)]
mod tests_gated_routes {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    /// The blocks `let {name} = api_v1 ... ;` of `start_rpc_server` that read `gate_addr()`, with the path their
    /// `warp::path(..)` segments name.
    fn server(src: &str) -> &str {
        let body = &src[src.find("pub async fn start_rpc_server").expect("server")..];
        &body[..body.find("
async fn handle_rpc(").expect("the next function")]
    }

    fn gate_routes(src: &str) -> Vec<(String, String)> {
        let body = server(src);
        let mut out = Vec::new();
        for (at, _) in body.match_indices(" = api_v1") {
            let name = body[..at].rsplit("let ").next().unwrap_or("").trim().to_string();
            let block = &body[at..at + body[at..].find(';').unwrap_or(0)];
            if !block.contains(".and(gate_addr())") { continue; }
            let mut path = String::from("/api/v1");
            for seg in block.split("warp::path(\"").skip(1) {
                path.push('/');
                path.push_str(&seg[..seg.find('"').unwrap_or(0)]);
            }
            out.push((name, path));
        }
        out
    }

    /// M1: a request a page sends carries an Origin header, and an IP-gated decision takes it as nobody in
    /// particular, whatever address the visitor's browser sends from (this host, its LAN, a genesis address).
    #[test]
    fn a_page_is_nobody_at_an_ip_gated_decision() {
        let lan = Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)), 50000));
        assert_eq!(gate_client(lan, false), lan, "a caller with no Origin header is what its address says");
        let page = gate_client(lan, true).unwrap();
        assert!(page.ip().is_unspecified());
        assert!(!is_internal_ip(&page.ip().to_string()) && !is_genesis_peer_ip(&page.ip().to_string()));
        for (ip, _) in crate::genesis_constants::GENESIS_NODE_IPS {
            let g = Some(SocketAddr::new(ip.parse().unwrap(), 443));
            assert!(!is_genesis_peer_ip(&gate_client(g, true).unwrap().ip().to_string()), "{ip}");
        }
        assert!(!is_internal_ip(&gate_client(Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 1)), true).unwrap().ip().to_string()));
    }

    /// M1: every route that reads gate_addr is served outside the CORS filter (`gated_routes`, its path in
    /// GATED_PATHS), so no answer of one carries a CORS header; the public CORS methods leave out DELETE, which
    /// only the bundle cancel (gated too) uses.
    #[test]
    fn the_ip_gated_routes_are_served_outside_the_cors_filter() {
        let src = include_str!("mod.rs");
        let gated = gate_routes(src);
        let body = server(src);
        let names: Vec<&str> = gated.iter().map(|(n, _)| n.as_str()).collect();
        for want in ["internal_fcm_sync", "internal_fcm_get", "internal_light_keys_get", "internal_light_reach_get", "internal_light_unbind_sync",
                     "internal_device_attest", "internal_device_sync", "internal_device_get", "p2p_message",
                     "node_reactivation_submit", "graceful_shutdown"] {
            assert!(names.contains(&want), "{want} reads gate_addr");
        }
        let group = &body[body.find("let gated_routes = ").expect("gated group")..];
        let group = &group[..group.find(';').unwrap()];
        for (name, path) in &gated {
            assert!(is_gated_path(path), "{name}: {path} is a gated path");
            assert!(group.contains(&format!("{name}\n")) || group.contains(&format!("({name})")), "{name} is in gated_routes");
        }
        assert!(group.contains(".or(bundle_cancel)"));
        // No group served under the CORS filter names a gated route.
        let rest = &body[body.find("let rest_routes = ").expect("rest")..];
        let rest = &rest[..rest.find(';').unwrap()];
        assert!(rest.contains(".with(cors)") && !rest.contains("gated_routes"));
        for (at, _) in body.match_indices("_routes = ") {
            let block = &body[at..at + body[at..].find(';').unwrap()];
            if block.starts_with("_routes = internal_fcm_sync") { continue; }
            for name in names.iter().copied().chain(["bundle_cancel"]) {
                assert!(!block.contains(&format!("({name})")) && !block.contains(&format!("= {name}\n")), "{name} in {}", &block[..40.min(block.len())]);
            }
        }
        assert!(body.contains("let routes = ws_subscribe.or(gated_preflight()).or(gated_routes).or(rest_routes);"));
        let production = &body[body.find("cors_mode=public").unwrap()..];
        let methods = &production[production.find("allow_methods(").unwrap()..];
        let methods = &methods[..methods.find(')').unwrap()];
        assert!(methods.contains("\"POST\"") && methods.contains("\"GET\"") && !methods.contains("DELETE"), "{methods}");
    }

    #[test]
    fn the_gated_paths_are_exactly_these() {
        for p in ["/api/v1/internal/fcm-token-sync", "/api/v1/internal/light-device-get", "/api/v1/p2p/message",
                  "/api/v1/p2p/message/", "/api/v1/node-reactivation/submit", "/api/v1/shutdown"] {
            assert!(is_gated_path(p), "{p}");
        }
        for p in ["/api/v1/height", "/api/v1/light-node/unbind", "/api/v1/p2p/messages", "/api/v1/shutdownx",
                  "/api/v1/internalx", "/rpc", "/api/v1/bundle/submit"] {
            assert!(!is_gated_path(p), "{p}");
        }
    }

    /// A preflight for a gated path is refused with no CORS headers before the CORS filter would answer it; a
    /// public path's preflight is still answered, and a gated route's own answer carries no CORS header.
    #[tokio::test]
    async fn a_preflight_for_a_gated_path_is_refused_and_a_public_one_answered() {
        let cors = warp::cors().allow_any_origin().allow_methods(vec!["POST", "GET", "OPTIONS"])
            .allow_headers(vec!["Content-Type"]);
        let public = warp::path!("api" / "v1" / "height").and(warp::get()).map(|| "h").with(cors);
        let gated = warp::path!("api" / "v1" / "internal" / "fcm-token-sync").and(warp::post()).and(gate_addr())
            .map(|c: Option<SocketAddr>| if c.map_or(false, |a| a.ip().is_unspecified()) { "nobody" } else { "caller" });
        let routes = gated_preflight().or(gated).or(public);
        let preflight = |path: &'static str| warp::test::request().method("OPTIONS").path(path)
            .header("origin", "https://example.org").header("access-control-request-method", "POST")
            .header("access-control-request-headers", "content-type");
        let r = preflight("/api/v1/internal/fcm-token-sync").reply(&routes).await;
        assert_eq!(r.status(), 403);
        assert!(r.headers().get("access-control-allow-origin").is_none());
        let r = preflight("/api/v1/height").reply(&routes).await;
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers().get("access-control-allow-origin").map(|v| v.to_str().unwrap()), Some("https://example.org"));

        // A simple request still reaches the gated route: it answers no CORS header, and takes the page as nobody.
        let r = warp::test::request().method("POST").path("/api/v1/internal/fcm-token-sync")
            .remote_addr("192.168.1.20:5000".parse().unwrap()).header("origin", "https://example.org")
            .reply(&routes).await;
        assert!(r.headers().get("access-control-allow-origin").is_none());
        assert_eq!(r.body().as_ref(), b"nobody");
        let r = warp::test::request().method("POST").path("/api/v1/internal/fcm-token-sync")
            .remote_addr("192.168.1.20:5000".parse().unwrap()).reply(&routes).await;
        assert_eq!(r.body().as_ref(), b"caller");
    }
}

#[cfg(test)]
mod tests_light_challenge_lifetime {

    use super::*;

    /// A stamp stays answerable until the shard's owners start building the epoch bitmap: a device that
    /// answers minutes late — doze, a held-back push, a node restarting under a roll — still proves the
    /// epoch it was pinged in. Below that it never drops under the floor the slot draw is sized for.
    #[test]
    fn a_stamp_is_answerable_until_the_commit_window_opens() {
        let epoch = 200u64;
        let start = epoch * 14_400;
        let commit = crate::node::light_commit_window(epoch);
        let answerable_for = 14_400 - commit;
        assert_eq!(challenge_lifetime_at(start), answerable_for);
        assert_eq!(challenge_lifetime_at(start + 7_200), answerable_for - 7_200);
        assert_eq!(challenge_lifetime_at(start + answerable_for - LIGHT_CHALLENGE_TTL_SECS),
                   LIGHT_CHALLENGE_TTL_SECS, "the last drawn slot still gets the full floor");
        assert_eq!(challenge_lifetime_at(start + 14_399), LIGHT_CHALLENGE_TTL_SECS,
                   "inside the commit window a stamp gets the floor, not zero");
        assert!(challenge_lifetime_at(start) > LIGHT_CHALLENGE_TTL_SECS,
                "an epoch is worth more than three minutes of answering time");
    }
}

#[cfg(test)]
mod tests_activation_phase_resolver {
    use super::*;

    /// The one resolver must apply BOTH halves of the phase rule — 90% of the 1DEV supply burned OR
    /// five years since genesis. Losing the age half strands the network in Phase 1 if burning stalls.
    #[test]
    fn resolver_applies_burn_and_age_halves() {
        const G: u64 = 1_700_000_000;
        let five_years = G + qnet_state::Transaction::PHASE2_AGE_SECS;

        // Neither trigger: Phase 1, quoted in 1DEV.
        let p = pricing_from_supply(0, 1_000, 0, G, G);
        assert_eq!(p.phase, 1);
        assert_eq!(p.currency(), "1DEV");

        // Burn trigger alone, clock at genesis.
        assert_eq!(pricing_from_supply(900, 100, 0, G, G).phase, 2);

        // Age trigger alone, nothing burned.
        assert_eq!(pricing_from_supply(0, 1_000, 0, G, five_years - 1).phase, 1);
        let aged = pricing_from_supply(0, 1_000, 0, G, five_years);
        assert_eq!(aged.phase, 2, "five years flips the phase with zero burned");
        assert_eq!(aged.currency(), "QNC");
        assert_eq!(aged.burn_pct, 0.0, "the age trigger does not fake a burn percentage");

        // Genesis not applied yet: the age half stays shut.
        assert_eq!(pricing_from_supply(0, 1_000, 0, 0, five_years).phase, 1);
    }
}

#[cfg(test)]
mod light_route_body_cap_tests {
    /// The enveloped ML-DSA-65 signature the mobile client sends is
    /// `dilithium_sig_{id}_{base64([sig_len(4)][sig(3309) || message][pk_len(4)][pk(1952)])}` - the
    /// envelope embeds its own MESSAGE, which is what makes the delegation cert the largest field:
    /// its message is the hex ping public key. Pinning the arithmetic here so the route cap can never
    /// silently fall back under the payload it exists to carry.
    fn enveloped_len(message_len: usize) -> usize {
        let raw = 4 + 3309 + message_len + 4 + 1952;
        ((raw + 2) / 3) * 4 + "dilithium_sig_".len() + 40 + 1
    }

    #[test]
    fn a_ping_response_body_fits_its_route_cap() {
        const PK_HEX: usize = 1952 * 2;
        let challenge_sig = "ping_dilithium:".len() + enveloped_len(64);
        let delegation_cert = enveloped_len(PK_HEX + 60); // delegate_ping:{pk_hex}:{pseudonym}
        let body = challenge_sig + delegation_cert + PK_HEX + 200;

        assert!(body > 16 * 1024,
                "the old 16 KB cap must be provably too small: body={} bytes", body);
        assert!(body < 64 * 1024,
                "the route cap must admit the body it exists to carry: body={} bytes", body);
    }
}

#[cfg(test)]
mod block_json_tests {
    use super::*;

    // Every field of the API block survives and the consensus hash rides alongside as hex (null when
    // the index has no row), so consumers can verify previous_hash linkage without the preimage.
    #[test]
    fn block_json_keeps_the_block_and_adds_the_hash() {
        let block = qnet_state::Block {
            height: 42, timestamp: 1_700_000_042, previous_hash: [3u8; 32], merkle_root: [4u8; 32],
            transactions: vec![], producer: "super_x".to_string(), signature: vec![1, 2, 3], block_type: "MICROBLOCK".to_string(),
        };
        let v = block_json(&block, Some([0xabu8; 32]));
        assert_eq!(v["height"], 42);
        assert_eq!(v["producer"], "super_x");
        assert_eq!(v["hash"], "ab".repeat(32));
        assert_eq!(v["previous_hash"].as_array().map(|a| a.len()), Some(32), "wire shape of the block is unchanged");
        assert!(block_json(&block, None)["hash"].is_null());
    }
}

#[cfg(test)]
mod tests_signed_target_bound {
    use super::*;

    // Every wallet, the extension and the load harness send through these two builders: the fields the
    // signature covers and the fields apply acts on come from the same request values, so an honest
    // transfer or call passes the tx_target_bound rule at the gate.
    #[test]
    fn the_rest_builders_pass_the_signed_target_rule_from_the_gate() {
        let gate = qnet_state::feature_gates::TX_TARGET_BOUND_GATE_HEIGHT;
        let from = qnet_state::transaction::derive_contract_address("rest_builder_wallet", 1);
        let to = qnet_state::transaction::derive_contract_address("rest_builder_wallet", 2);

        let transfer: TransactionRequest = serde_json::from_value(serde_json::json!({
            "from": from, "to": to, "amount": 5, "gas_price": 100_000, "gas_limit": 10_000, "nonce": 1
        })).expect("transfer request");
        let tx = tx_api::transfer_tx(&transfer, 1_700_000_000);
        assert_eq!(tx.validate(), Ok(()));
        assert_eq!(tx.check_signed_target_bound(gate), Ok(()));

        let call: ContractCallRequest = serde_json::from_value(serde_json::json!({
            "from": from, "contract_address": to, "method": "transfer", "args": [from, "1"],
            "gas_limit": 200_000, "gas_price": 100_000, "nonce": 2
        })).expect("call request");
        let tx = contracts_api::contract_call_tx(&call, 1_700_000_000);
        assert_eq!(tx.validate(), Ok(()));
        assert_eq!(tx.check_signed_target_bound(gate), Ok(()));
    }

    /// The claim builder takes the envelope amount from the payload's own total and leaves nonce, gas and
    /// the legacy fields empty, so an honest claim passes from the gate; an unsummable payload builds none.
    #[test]
    fn the_rest_claim_builder_passes_at_the_gate() {
        let gate = qnet_state::feature_gates::TX_TARGET_BOUND_GATE_HEIGHT;
        let wallet = qnet_state::transaction::derive_contract_address("rest_claim_wallet", 1);
        let data = r#"{"claims":[{"epoch":3,"amount":40,"proof":[]},{"epoch":4,"amount":2,"proof":[]}]}"#;
        let tx = rewards_api::merkle_claim_tx(&wallet, data, "sig", Some("ab"), 1_780_000_000).expect("summable");
        assert_eq!(tx.amount, 42);
        assert_eq!(Some(tx.amount), qnet_state::Transaction::claim_entries_total(data));
        assert_eq!(tx.check_signed_target_bound(gate), Ok(()));
        assert!(rewards_api::merkle_claim_tx(&wallet, r#"{"claims":[{"epoch":3}]}"#, "sig", None, 0).is_none());
    }

    /// The batch builder writes the envelope as (BATCH_TRANSFERS_TO, exact sum) and an empty memo as none,
    /// which the signed digest cannot tell apart, so the client's signature still verifies and the batch
    /// passes from the gate.
    #[test]
    fn the_rest_batch_builder_passes_at_the_gate() {
        let gate = qnet_state::feature_gates::TX_TARGET_BOUND_GATE_HEIGHT;
        let from = qnet_state::transaction::derive_contract_address("rest_batch_wallet", 1);
        let to = |i: u64| qnet_state::transaction::derive_contract_address("rest_batch_to", i);
        let request: BatchTransferRequest = serde_json::from_value(serde_json::json!({
            "transfers": [
                { "from": from, "to_address": to(1), "amount": 3, "memo": "" },
                { "from": from, "to_address": to(2), "amount": 4, "memo": "rent" },
            ],
            "batch_id": "b1", "nonce": 1, "gas_price": 100_000, "gas_limit": 20_000,
            "dilithium_signature": "00",
        })).expect("batch request");
        let tx = tx_api::batch_transfer_tx(&request, &from, 7, 1_700_000_000);
        assert_eq!(tx.check_signed_target_bound(gate), Ok(()));
        assert_eq!(tx.validate(), Ok(()));
        let with_empty = {
            let mut t = tx.clone();
            if let qnet_state::TransactionType::BatchTransfers { transfers, .. } = &mut t.tx_type {
                transfers[0].memo = Some(String::new());
            }
            t
        };
        assert_eq!(crate::node::BlockchainNode::build_canonical_verify_message(&tx),
                   crate::node::BlockchainNode::build_canonical_verify_message(&with_empty),
                   "none and an empty memo sign the same bytes");
    }

    /// Every deploy builder emits the canonical payload for its RPC-shaped input, so an honest deploy passes
    /// the gated canonical-form rule, and the digest it returns is the one classify re-derives.
    #[test]
    fn the_deploy_builders_emit_the_canonical_payload() {
        use qnet_state::transaction::DeployKind;
        let gate = qnet_state::feature_gates::TX_TARGET_BOUND_GATE_HEIGHT;
        let from = qnet_state::transaction::derive_contract_address("rest_deploy_wallet", 1);
        let inputs = [
            (DeployKind::Wasm, serde_json::json!({ "wasm": true, "code": "0061736D01000000" })),
            (DeployKind::Qrc721, serde_json::json!({ "qrc721": true, "name": "N", "symbol": "NF" })),
            (DeployKind::Qrc20, serde_json::json!({
                "qrc20": true, "name": "Tok", "symbol": "TK", "decimals": 9u8, "logo": "",
                "initial_supply": 1_000u64.to_string(), "mintable": false, "burnable": false,
            })),
        ];
        for (kind, input) in inputs {
            let (code_hash, payload) = contracts_api::deploy_payload(kind, &input).expect("payload");
            let tx = qnet_state::Transaction::new(from.clone(),
                Some(qnet_state::transaction::derive_contract_address(&from, 3)), 0, 3, 1000, 1_000_000,
                1_700_000_000, None, qnet_state::TransactionType::ContractDeploy, Some(payload));
            assert_eq!(tx.contract_deploy_code_hash().as_deref(), Ok(code_hash.as_str()), "{:?}", kind);
            assert_eq!(tx.check_signed_target_bound(gate), Ok(()), "{:?}", kind);
        }
    }

    /// History, lookups and the address index show what apply paid or created: a batch's recipients and
    /// sum, a deploy's derived address with no value, nothing for a lifecycle TX, never an envelope nothing
    /// signs.
    #[test]
    fn history_and_index_follow_what_apply_paid() {
        let from = "sender_wallet".to_string();
        let forged_batch = qnet_state::Transaction::new(from.clone(), Some("merchant".to_string()), 1_000_000, 1, 1, 30_000, 0, None,
            qnet_state::TransactionType::BatchTransfers {
                transfers: vec![
                    qnet_state::transaction::BatchTransferData { to_address: "alice".to_string(), amount: 1, memo: None },
                    qnet_state::transaction::BatchTransferData { to_address: "bob".to_string(), amount: 2, memo: None },
                    qnet_state::transaction::BatchTransferData { to_address: "alice".to_string(), amount: 3, memo: None },
                ],
                batch_id: "b".to_string(),
            }, None);
        assert_eq!(crate::storage::tx_index_counterparties(&forged_batch), vec!["alice".to_string(), "bob".to_string()]);
        assert_eq!(tx_display_to_amount(&forged_batch), (Some(qnet_state::transaction::BATCH_TRANSFERS_TO.to_string()), 6));
        assert_eq!(batch_received_by(&forged_batch, "alice"), Some(4));
        assert_eq!(batch_received_by(&forged_batch, "merchant"), None, "the envelope pays nobody");

        let deploy = qnet_state::Transaction::new(from.clone(), Some("victim_future_token".to_string()), 500, 4, 1, 1_000_000, 0, None,
            qnet_state::TransactionType::ContractDeploy, Some("{}".to_string()));
        let derived = qnet_state::transaction::derive_contract_address(&from, 4);
        assert_eq!(crate::storage::tx_index_counterparties(&deploy), vec![derived.clone()]);
        assert_eq!(tx_display_to_amount(&deploy), (Some(derived), 0));

        let transfer = qnet_state::Transaction::new(from.clone(), Some("carol".to_string()), 9, 1, 1, 10_000, 0, None,
            qnet_state::TransactionType::Transfer { from, to: "carol".to_string(), amount: 9 }, None);
        assert_eq!(crate::storage::tx_index_counterparties(&transfer), vec!["carol".to_string()]);
        assert_eq!(tx_display_to_amount(&transfer), (Some("carol".to_string()), 9));

        // A lifecycle TX pays no one: a relay's copy naming a victim and a fabricated amount (a pre-gate
        // block may carry one) lists no counterparty and shows no value.
        let heartbeat = qnet_state::Transaction::new("super_x".to_string(), Some("victim".to_string()),
            1_000_000_000_000_000_000, 1, u64::MAX, 0, 0, None,
            qnet_state::TransactionType::Heartbeat { node_id: "super_x".to_string(), anchor_height: 1, anchor_hash: "ab".repeat(32) },
            None);
        assert!(crate::storage::tx_index_counterparties(&heartbeat).is_empty());
        assert_eq!(tx_display_to_amount(&heartbeat), (None, 0));
    }
}

#[cfg(test)]
mod tests_attest_lanes {
    use super::*;

    /// H10: callers outside the committee share one lane of the attestor's first-sight budget. When it
    /// is spent they wait, while the committee's submit doors still reach the rest of the ceiling; the
    /// ceiling and the per-burner count hold for every caller.
    #[test]
    fn the_outside_lane_is_a_share_and_never_the_doors_quota() {
        let now = 1_800_000_020;
        let mut b = LookupBudget::default();
        for i in 0..ATTEST_LOOKUPS_OUTSIDE {
            assert_eq!(b.admit(&format!("outside_{i}"), true, None, now), Ok(()));
        }
        let retry = b.admit("outside_x", true, None, now).unwrap_err();
        assert!(retry > 0 && retry <= ATTEST_LOOKUP_WINDOW_SECS);
        // Six committee doors, each with its share: together they keep the rest of the ceiling.
        let doors: Vec<String> = (0..6).map(|d| format!("198.51.100.{d}")).collect();
        for i in ATTEST_LOOKUPS_OUTSIDE..ATTEST_LOOKUPS_GLOBAL {
            let door = doors[(i as usize) % doors.len()].as_str();
            assert_eq!(b.admit(&format!("door_{i}"), false, Some(door), now), Ok(()), "the doors keep the rest");
        }
        assert!(b.admit("door_x", false, Some("198.51.100.99"), now).is_err(), "the global ceiling");
        assert_eq!(b.admit("door_x", false, Some(doors[0].as_str()), now + ATTEST_LOOKUP_WINDOW_SECS), Ok(()),
                   "a new window");

        let mut b = LookupBudget::default();
        for _ in 0..ATTEST_LOOKUPS_PER_BURNER { assert_eq!(b.admit("one_burner", false, Some("own"), now), Ok(())); }
        assert!(b.admit("one_burner", false, Some("own"), now).is_err(), "per burner, for a committee caller too");
    }

    /// M-9: each committee caller spends its own share of the doors' quota. Garbage pushed through one door
    /// (fresh burners, each first sight) leaves every other door its share. The doors' quota is split over the
    /// callers that ask, never over fewer than the genesis count: a committee of a thousand whose submits come
    /// through five doors leaves each of them a fifth, and the share never falls below one burner's count.
    #[test]
    fn a_flood_through_one_door_spends_only_its_share() {
        let now = 1_800_000_020;
        let doors_quota = ATTEST_LOOKUPS_GLOBAL - ATTEST_LOOKUPS_OUTSIDE;
        let genesis = crate::genesis_constants::genesis_node_count();
        assert_eq!(attest_door_share(0), doors_quota / genesis as u32);
        assert_eq!(attest_door_share(1), doors_quota / genesis as u32, "one door never takes more than a genesis door's share");
        assert_eq!(attest_door_share(genesis), doors_quota / genesis as u32, "five doors asking, whatever the committee size");
        assert_eq!(attest_door_share(6), doors_quota / 6);
        assert_eq!(attest_door_share(1000), ATTEST_LOOKUPS_PER_BURNER, "the floor when a thousand doors ask");

        let mut b = LookupBudget::default();
        let alone = attest_door_share(1);
        for i in 0..alone {
            assert_eq!(b.admit(&format!("junk_{i}"), false, Some("own"), now), Ok(()));
        }
        assert!(b.admit("junk_x", false, Some("own"), now).is_err(), "the flooded door waits");
        for d in 1..6 {
            let door = format!("203.0.113.{d}");
            assert_eq!(b.admit(&format!("honest_{d}"), false, Some(door.as_str()), now), Ok(()),
                       "another door keeps its share");
        }
        for i in 1..attest_door_share(6) {
            assert_eq!(b.admit(&format!("honest_1_{i}"), false, Some("203.0.113.1"), now), Ok(()));
        }
        assert!(b.admit("honest_1_x", false, Some("203.0.113.1"), now).is_err(), "six doors asking: a sixth each");

        // The next window starts split over the six doors that asked in this one: the flooded door cannot
        // take more than a sixth before the others ask again.
        let next = now + ATTEST_LOOKUP_WINDOW_SECS;
        for i in 0..attest_door_share(6) {
            assert_eq!(b.admit(&format!("junk_n_{i}"), false, Some("own"), next), Ok(()), "a new window");
        }
        assert!(b.admit("junk_n_x", false, Some("own"), next).is_err());
        // A window with no lookups between forgets the doors.
        let later = next + 2 * ATTEST_LOOKUP_WINDOW_SECS;
        for i in 0..alone {
            assert_eq!(b.admit(&format!("junk_l_{i}"), false, Some("own"), later), Ok(()));
        }
        assert!(b.admit("junk_l_x", false, Some("own"), later).is_err());
    }

    /// The collector asks its own attestor in-process, where it is a committee caller, and every other
    /// member at the address it resolves; a member with no address is skipped. Without this node in hand
    /// (a joining super's own registration) it asks itself at its announced address, never at loopback.
    #[test]
    fn the_collector_asks_itself_in_process() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let storage = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        let own = format!("genesis_node_{}", crate::genesis_constants::GENESIS_NODE_IPS[0].1);
        let other = format!("genesis_node_{}", crate::genesis_constants::GENESIS_NODE_IPS[1].1);
        let members = [own.clone(), other.clone(), "super_attest_lane_unknown".to_string()];
        let targets = BlockchainNode::attest_targets(&members, &own, true, &storage);
        assert_eq!(targets.len(), 2, "{targets:?}");
        assert_eq!(targets[0], (own.clone(), None));
        assert_eq!(targets[1].0, other);
        let url = targets[1].1.as_deref().unwrap();
        assert!(url.starts_with("http://") && url.ends_with(":8001/") && !url.contains("127.0.0.1"), "{url}");
        let without = BlockchainNode::attest_targets(&members, &own, false, &storage);
        let own_url = without[0].1.as_deref().expect("its announced address");
        assert!(own_url.contains(crate::genesis_constants::GENESIS_NODE_IPS[0].0) && !own_url.contains("127.0.0.1"), "{own_url}");
    }

    /// M-9: the submit route and `node_attestBurn` answer a request with no Origin, from the site and from the
    /// extension; any other page, a sandbox site included, gets 403 before any work. The global CORS answer stays.
    #[tokio::test]
    async fn the_registration_doors_answer_only_their_origins() {
        for ok in [None, Some("https://aiqnet.io"), Some("https://www.aiqnet.io"),
                   Some("HTTPS://AIQNET.IO"), Some("chrome-extension://abcdefghijklmnopabcdefghijklmnop"),
                   Some("moz-extension://0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0")] {
            assert!(registration_origin_allowed(ok), "{ok:?}");
        }
        for bad in ["", "null", "https://other.test", "https://aiqnet.io.other.test", "http://aiqnet.io",
                    "https://aiqnet.io/", "https://node1.aiqnet.io", "https://test.aiqnet.io", "chrome-extension://",
                    "chrome-extension://id/x", "moz-extension://", "file://"] {
            assert!(!registration_origin_allowed(Some(bad)), "{bad:?}");
        }

        // The header as the routes read it: absent is None, a non-text Origin is still one and is refused.
        let gate = warp::path("door").and(request_origin()).map(|origin: Option<String>| {
            if registration_origin_allowed(origin.as_deref()) { warp::reply::json(&json!({ "ok": true })).into_response() }
            else { origin_refused(Some(7)).into_response() }
        });
        let r = warp::test::request().method("POST").path("/door").reply(&gate).await;
        assert_eq!(r.status(), 200);
        let r = warp::test::request().method("POST").path("/door").header("origin", "https://aiqnet.io").reply(&gate).await;
        assert_eq!(r.status(), 200);
        let r = warp::test::request().method("POST").path("/door").header("origin", "https://other.test").reply(&gate).await;
        assert_eq!(r.status(), 403);
        let body: Value = serde_json::from_slice(r.body()).unwrap();
        assert_eq!((body["id"].clone(), body["error"]["code"].clone()), (json!(7), json!(-32005)));
        let r = warp::test::request().method("POST").path("/door")
            .header("origin", warp::http::HeaderValue::from_bytes(b"\xff\xfe").unwrap()).reply(&gate).await;
        assert_eq!(r.status(), 403);
        assert_eq!(origin_refused(None).into_response().status(), 403);

        // Both JSON-RPC routes and the submit route refuse before any work; nothing else at JSON-RPC is filtered.
        let src = include_str!("mod.rs").replace("\r\n", "\n");
        let server = &src[src.find("pub async fn start_rpc_server(").unwrap()..];
        for (route, work) in [("let rpc_path = warp::path(\"rpc\")", "handle_rpc(request"),
                              ("let root_path = warp::path::end()", "handle_rpc(request"),
                              ("let node_registration_submit = api_v1", "handle_node_registration_client_submit(req")] {
            let at = &server[server.find(route).unwrap_or_else(|| panic!("missing {route}"))..];
            let check = at.find("registration_origin_allowed(origin.as_deref())").expect("the origin check");
            assert!(check < at.find(work).unwrap(), "{route}: the origin check comes first");
        }
        assert_eq!(server.matches("request.method == \"node_attestBurn\" && !registration_origin_allowed").count(), 2);
    }
}
#[cfg(test)]
mod tests_account_answers {
    use super::*;

    /// SH2: a row this node could not read answers 503 `account_unreadable`, never the default account;
    /// a missing row still answers the default account.
    #[test]
    fn an_unreadable_account_is_an_error_and_a_missing_one_the_default() {
        let (status, body) = account_unreadable_answer("eon_x");
        assert_eq!(status, warp::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!((body["success"].clone(), body["error"].clone()), (json!(false), json!("account_unreadable")));
        assert!(body.get("balance").is_none() && body.get("nonce").is_none(), "no figure a client could take for the chain's");
        let d = account_default_answer("eon_new");
        assert_eq!((d["balance"].clone(), d["nonce"].clone(), d["has_dilithium_pk"].clone()), (json!(0), json!(0), json!(false)));
        assert_eq!(account_basic_answer("eon_x", Err(())).0, warp::http::StatusCode::SERVICE_UNAVAILABLE);
    }

    /// SH8: `?fields=basic` answers exactly address, balance, nonce, has_dilithium_pk, is_contract and
    /// contract_type, for a stored account and a missing one alike.
    #[test]
    fn the_basic_form_names_only_the_light_fields() {
        let token = qnet_state::AccountBasic {
            address: "eon_token".into(), balance: 12, nonce: 3, has_dilithium_pk: false, is_contract: true,
            contract_type: Some("qrc20".into()),
        };
        let (status, v) = account_basic_answer("eon_token", Ok(Some(token)));
        assert_eq!(status, warp::http::StatusCode::OK);
        let keys: std::collections::BTreeSet<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(keys, ["address", "balance", "has_dilithium_pk", "contract_type", "is_contract", "nonce"].into_iter().collect());
        assert_eq!((v["is_contract"].clone(), v["contract_type"].clone(), v["balance"].clone()), (json!(true), json!("qrc20"), json!(12)));
        let (_, missing) = account_basic_answer("eon_new", Ok(None));
        assert_eq!(missing, json!({"address": "eon_new", "balance": 0, "nonce": 0, "has_dilithium_pk": false,
                                   "is_contract": false, "contract_type": null}));
    }
}

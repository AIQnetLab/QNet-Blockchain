//! Signing helper, FCM sync, diagnostics, activation codes, token info and richlist.

use super::*;

// PRODUCTION: Sign with post-quantum cryptography (pure CRYSTALS-ML-DSA-65 / ML-DSA-65) per NIST/Cisco
// CRITICAL: Uses the node's ML-DSA-65 key for each challenge - NO FALLBACK!
pub(super) async fn sign_with_dilithium(node_id: &str, challenge: &str) -> String {
    use crate::pq_crypto::{PqCrypto, GLOBAL_PQ_INSTANCES};
    use std::sync::Arc;

    // Get or create post-quantum crypto instance (thread-safe global cache)
    let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
    }).await;
    
    let mut instances_guard = instances.lock().await;
    
    // v2.24: Use node_id directly
    let normalized_node_id = node_id.to_string();
    
    // Create instance if not exists
    if !instances_guard.contains_key(&normalized_node_id) {
        let mut pq = PqCrypto::new(normalized_node_id.clone());
        if let Err(e) = pq.initialize().await {
            println!("[CRYPTO] ❌ CRITICAL: PQ crypto init failed for {}: {}", node_id, e);
            // NO FALLBACK - return error signature that will be rejected
            return format!("ERROR_NO_HYBRID_CRYPTO_{}", node_id);
        }
        instances_guard.insert(normalized_node_id.clone(), pq);
    }

    let pq = instances_guard.get_mut(&normalized_node_id).expect("Inserted above");

    // Check certificate rotation
    if pq.needs_rotation() {
        if let Err(e) = pq.rotate_certificate().await {
            println!("[CRYPTO] ⚠️ Certificate rotation failed: {}", e);
        }
    }

    // CRITICAL: Sign RAW challenge with ML-DSA-65 (hashes before signing)
    // OPTIMIZED v2.24: bincode+zstd - use standard compact_bin format for verification compatibility
    match pq.sign_raw_message_compact(challenge.as_bytes()).await {
        Ok(compact_sig) => {
            match compact_sig.to_binary_compressed() {
                Ok(binary_data) => {
                    let base64_data = base64::engine::general_purpose::STANDARD.encode(&binary_data);
                    println!("[CRYPTO] ✅ PQ RPC signature created for node {} (bincode v2.24)", node_id);
                    format!("compact_bin:{}", base64_data)  // Standard format for verification
                }
                Err(e) => {
                    println!("[CRYPTO] ❌ Failed to serialize PQ signature: {}", e);
                    format!("ERROR_SERIALIZE_FAILED_{}", node_id)
                }
            }
        }
        Err(e) => {
            println!("[CRYPTO] ❌ PQ signing failed for node {}: {}", node_id, e);
            // NO FALLBACK - unsigned/weak signatures are security vulnerabilities!
            format!("ERROR_HYBRID_SIGN_FAILED_{}", node_id)
        }
    }
}

// PRODUCTION: Light Node Registry (persistent storage with in-memory cache)
pub(crate) use parking_lot::Mutex as ParkingMutex;


// Import lazy rewards system

/// Pending challenge for polling-based Light nodes
#[derive(Debug, Clone)]
pub(super) struct PendingChallenge {
    pub(super) challenge: String,
    pub(super) created_at: u64,
    pub(super) expires_at: u64,
}

lazy_static::lazy_static! {
    /// LOCAL OPERATIONAL CACHE — NOT source of truth for "node exists" queries!
    /// Source of truth = RocksDB (blockchain state from NodeRegistration TX).
    /// This cache stores device-specific data (device_token, push settings) for API-registered
    /// light nodes. It is populated on direct API calls only, NOT from gossip/blockchain.
    /// The P2P registry (unified_p2p::light_node_registry) is the authoritative in-memory
    /// registry for light node liveness/connectivity, synchronized via gossip + restored from
    /// RocksDB on startup (v4.3). This Mutex cache manages per-device state only.
    pub(super) static ref LIGHT_NODE_REGISTRY: ParkingMutex<HashMap<String, LightNodeInfo>> = ParkingMutex::new(HashMap::new());

    /// Pending challenges for polling-based Light nodes
    /// Key: node_id, Value: PendingChallenge
    /// Cleaned up automatically when challenge expires or is answered
    pub(super) static ref PENDING_CHALLENGES: ParkingMutex<HashMap<String, PendingChallenge>> = ParkingMutex::new(HashMap::new());
    
    /// TEMPORARY IN-MEMORY CACHE for activation codes (wallet → code mapping).
    /// NOT persisted across restarts. NOT replicated between nodes.
    /// Used only during the window between code generation and node registration.
    /// Code ownership verification (verify_code_ownership) works by decrypting the code
    /// itself (XOR-encrypted wallet address) — does NOT depend on this registry.
    /// v4.2: No longer returned by /activations/by-wallet — only blockchain state is returned.
    pub(super) static ref GLOBAL_ACTIVATION_REGISTRY: Arc<crate::activation_validation::BlockchainActivationRegistry> = 
        Arc::new(crate::activation_validation::BlockchainActivationRegistry::new(None));
    
    // OPTIMIZATION: IP to pseudonym cache with 5 minute TTL for O(1) lookups
    // Key: IP address, Value: (pseudonym, timestamp)
    pub(super) static ref IP_TO_PSEUDONYM_CACHE: dashmap::DashMap<String, (String, std::time::Instant)> = 
        dashmap::DashMap::new();
    
    // v4.9: Super node migration rate limiter — 1 migration per 24 hours per wallet
    // Key: wallet_address, Value: last migration timestamp (unix seconds)
    // Prevents abuse: rapid server swapping, DDoS via re-registration, etc.
    pub(super) static ref SUPER_NODE_MIGRATION_TIMESTAMPS: dashmap::DashMap<String, u64> =
        dashmap::DashMap::new();
    
    // Per-wallet registration attempt rate limiter (anti-bruteforce for activation codes).
    // Key: wallet_address, Value: Vec<unix_timestamp_secs> of recent failed attempts.
    // Allows max 5 failed registration attempts per wallet per 10 minutes.
    pub(super) static ref WALLET_REG_FAIL_TIMESTAMPS: dashmap::DashMap<String, Vec<u64>> =
        dashmap::DashMap::new();

    // Epochs whose rebuild reproduced a root that disagrees with the certified one, and when it was
    // last attempted. Without this, every claim request on a diverged node repeats the full O(roster)
    // walk. Re-attempted after REBUILD_RETRY_SECS so a node that resyncs heals on its own.
    pub(super) static ref REWARD_REBUILD_DIVERGED: dashmap::DashMap<u64, u64> = dashmap::DashMap::new();

    // FIX R20-M1: Per-node claim lock to prevent double-claim race condition
    // Key: node_id, Value: claim-in-progress timestamp (unix seconds)
    // Two concurrent claims for same node_id will be serialized
    pub(super) static ref CLAIM_IN_PROGRESS: DashSet<String> =
        DashSet::new();


    // REMOVED: REWARD_MANAGER was causing desync issues
    // Now using blockchain.get_reward_manager() everywhere for proper synchronization

    /// v10.0: Bundle submitter IP tracking for cancel authorization
    /// Key: bundle_id, Value: submitter IP address string
    /// Cleaned up when bundles expire (checked during cancel)
    pub(super) static ref BUNDLE_SUBMITTER_IPS: dashmap::DashMap<String, String> =
        dashmap::DashMap::new();
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(super) struct LightNodeInfo {
    pub node_id: String,
    pub devices: Vec<LightNodeDevice>, // Up to 3 mobile devices
    pub quantum_pubkey: String,
    pub registered_at: u64,
    pub last_ping: u64,
    pub ping_count: u32,
    pub reward_eligible: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(super) struct LightNodeDevice {
    pub wallet_address: String,    // FIXED: Owner wallet for reward claims
    pub device_token_hash: String, // Hashed FCM token for privacy
    pub device_id: String,         // Unique device identifier
    pub last_active: u64,          // Last activity timestamp
    pub is_active: bool,           // Device status
}

/// Internal genesis-to-genesis FCM token sync (POST /api/v1/internal/fcm-token-sync)
/// Only accepted from other genesis node IPs.
#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub(super) struct FcmTokenSyncRequest {
    pub(super) pseudonym:  String,
    pub(super) token:      String,
    pub(super) push_type:  String,
    #[serde(default)]
    pub(super) endpoint:   Option<String>,
    /// Originating genesis node IP — used to avoid echo-back.
    pub(super) origin_ip:  String,
}

/// Fire-and-forget: broadcast a newly-registered FCM token to all peer genesis nodes
/// so every genesis node can send FCM pings regardless of which one took the registration.
pub(super) async fn sync_fcm_token_to_genesis_peers(
    pseudonym: &str,
    token:     &str,
    push_type: &str,
    endpoint:  Option<&str>,
    our_ip:    &str,
) {
    use crate::genesis_constants::GENESIS_NODE_IPS;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();

    let body = FcmTokenSyncRequest {
        pseudonym: pseudonym.to_string(),
        token:     token.to_string(),
        push_type: push_type.to_string(),
        endpoint:  endpoint.map(|s| s.to_string()),
        origin_ip: our_ip.to_string(),
    };

    for (ip, _id) in GENESIS_NODE_IPS {
        // Skip self
        if *ip == our_ip || ip.is_empty() { continue; }

        let url = format!("http://{}:8001/api/v1/internal/fcm-token-sync", ip);
        match client.post(&url).json(&body).send().await {
            Ok(resp) if resp.status().is_success() => {
                if crate::node::is_info() {
                    println!("[INFO][LIGHT] fcm_token_synced_to ip={} pseudonym={}", ip, pseudonym);
                }
            }
            Ok(resp) => {
                if crate::node::is_warn() {
                    println!("[WARN][LIGHT] fcm_token_sync_rejected ip={} status={}", ip, resp.status());
                }
            }
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][LIGHT] fcm_token_sync_failed ip={} err={}", ip, e);
                }
            }
        }
    }
}

/// Handler: POST /api/v1/internal/fcm-token-sync
/// Accepts only requests from other genesis nodes (IP allowlist check).
pub(super) async fn handle_internal_fcm_token_sync(
    remote_addr: Option<std::net::SocketAddr>,
    req:         FcmTokenSyncRequest,
    blockchain:  Arc<BlockchainNode>,
) -> Result<impl warp::Reply, warp::Rejection> {
    use crate::genesis_constants::GENESIS_NODE_IPS;

    // IP allowlist — only genesis peers may call this
    let caller_ip = remote_addr
        .map(|a| a.ip().to_string())
        .unwrap_or_default();
    let allowed = GENESIS_NODE_IPS.iter().any(|(ip, _)| *ip == caller_ip)
        || caller_ip == "127.0.0.1"
        || caller_ip == "::1";

    if !allowed {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] fcm_sync_rejected_unauthorized caller={}", caller_ip);
        }
        return Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"success": false, "error": "Unauthorized"})),
            warp::http::StatusCode::FORBIDDEN,
        ));
    }

    if req.token.is_empty() || req.pseudonym.is_empty() {
        return Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"success": false, "error": "Missing fields"})),
            warp::http::StatusCode::BAD_REQUEST,
        ));
    }

    match blockchain.get_storage().save_fcm_token(
        &req.pseudonym,
        &req.token,
        &req.push_type,
        req.endpoint.as_deref(),
    ) {
        Ok(()) => {
            // Update in-memory push_type so ping service uses FCM immediately
            // (without waiting for node restart / update_device_tokens_from_storage)
            if let Some(p2p) = blockchain.get_unified_p2p() {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                p2p.update_light_node_push_type(&req.pseudonym, &req.push_type, now);
            }
            if crate::node::is_info() {
                println!("[INFO][LIGHT] fcm_token_synced_from ip={} pseudonym={} push={}",
                         caller_ip, req.pseudonym, req.push_type);
            }
            Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"success": true})),
                warp::http::StatusCode::OK,
            ))
        }
        Err(e) => {
            println!("[WARN][LIGHT] fcm_token_sync_save_failed pseudonym={} err={}", req.pseudonym, e);
            Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"success": false, "error": "internal error"})),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
    }
}

/// Public endpoint: POST /api/v1/light-node/token-refresh
/// Lightweight FCM token update — no activation code / burn_tx needed.
/// Dilithium ping-delegation-signed for authentication.
#[derive(Debug, serde::Deserialize)]
pub(super) struct TokenRefreshRequest {
    pub(super) node_id:      String,
    pub(super) device_token: String,
    #[serde(default = "default_fcm_str")]
    pub(super) push_type:    String,
    #[serde(default)]
    pub(super) endpoint:     Option<String>,
    pub(super) signature:    String,   // "ping_dilithium:" + Dilithium sign of "token_refresh:{node_id}:{timestamp}"
    pub(super) timestamp:    u64,
}
pub(super) fn default_fcm_str() -> String { "fcm".to_string() }

#[derive(Debug, serde::Deserialize)]
pub(super) struct ClaimRewardsRequest {
    pub(super) node_id: String,
    pub(super) wallet_address: String,
    // LEGACY Ed25519 fields — pure-Dilithium clients no longer send them (Ed25519 is Solana-only, never
    // verified on a QNet path). Optional for wire back-compat during cutover.
    #[serde(default)]
    #[allow(dead_code)]
    pub(super) quantum_signature: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub(super) public_key: Option<String>,
    // v5.0: ML-DSA-65 signature (REQUIRED for ALL nodes — NIST FIPS 204, no exceptions)
    // Both Android (NDK/JNI) and iOS (ObjC bridge) apps v5.0+ provide these fields.
    #[serde(default)]
    pub(super) dilithium_signature: Option<String>,
    #[serde(default)]
    pub(super) dilithium_public_key: Option<String>,
    // Step 2 of the claim handshake: the exact `claims_data` string this node returned in step 1,
    // echoed back with the wallet's ML-DSA-65 signature over it. Apply re-verifies both, so a claim
    // can never be aimed at a wallet by anyone but its key holder.
    #[serde(default)]
    pub(super) claims_data: Option<String>,
    #[serde(default)]
    pub(super) claims_signature: Option<String>,
    /// The `claim_timestamp` from step 1, echoed verbatim — it is inside the signed message and
    /// becomes the TX timestamp, so a replay cannot re-stamp the payload into a fresh hash.
    #[serde(default)]
    pub(super) claim_timestamp: Option<u64>,
}

// POST /api/v1/nodes - Register a new node
/// Sign a NodeRegistration TX with pure ML-DSA-65 (ML-DSA-65) — no Ed25519 leg.
///
/// The node's ML-DSA-65 signature is the sole authenticator (provenance proof):
///   Proves that this specific node (genesis or super) created the registration TX.
///   Works identically to HeartbeatCommitment / NodeReactivation:
///   create_consensus_signature(node_id, msg). The signer is identified by
///   tx.dilithium_public_key = node_id, which verify_dilithium_tx_signature_async
///   uses for key lookup (NOT tx.from = user wallet). NodeRegistration is exempt from
///   the Ed25519 batch (verify_ed25519_batch) and admitted on the Dilithium leg alone —
///   exactly like NodeReactivation — so no Ed25519 signature is needed for propagation.
///   If quantum crypto is not yet initialised the TX is left unsigned and is rejected
///   by the mandatory-Dilithium gossip gate (fail-closed).
///
/// Canonical message: from|to|amount|nonce|gas_price|gas_limit|timestamp (pipe format).
pub(super) async fn sign_node_registration_tx(tx: &mut qnet_state::Transaction, producer_node_id: &str) {
    // THE one builder, so the signed preimage always includes whatever the verifier binds.
    let canonical_msg = crate::node::BlockchainNode::build_canonical_verify_message(tx);

    // Pure ML-DSA-65: the node's ML-DSA-65 signature is the sole authenticator.
    use crate::node::try_get_quantum_crypto;
    if let Some(crypto) = try_get_quantum_crypto() {
        match crypto.create_consensus_signature(producer_node_id, &canonical_msg).await {
            Ok(dilithium_sig) => {
                tx.dilithium_signature  = Some(dilithium_sig.signature.into_bytes());
                tx.dilithium_public_key = Some(producer_node_id.to_string().into_bytes());
                println!("[INFO][REG] node_registration_tx signed dilithium3={}", producer_node_id);
            }
            Err(e) => {
                println!("[WARN][REG] node_registration_tx dilithium_sign_failed \
                          node={} err={} (tx will be rejected)", producer_node_id, e);
            }
        }
    } else {
        println!("[WARN][REG] node_registration_tx quantum_crypto_not_init \
                  node={} (unsigned — will be rejected)", producer_node_id);
    }

    // Hash MUST be recalculated after the signature field is set.
    tx.hash = tx.calculate_hash();
}

/// Handle sync status request
pub(super) async fn handle_sync_status(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // v3.19: Rate limiting for DDoS protection
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }

    let local_height = blockchain.get_height().await;
    
    // CRITICAL FIX v2.105: Use max(local, cached) to prevent stale peer heights
    // from ShredProtocol causing network_height < local_height
    let network_height = if let Some(p2p) = blockchain.get_unified_p2p() {
        let cached = p2p.get_cached_network_height().unwrap_or(local_height);
        std::cmp::max(local_height, cached)
    } else {
        local_height
    };
    
    let is_syncing = local_height < network_height;
    let is_ahead = false; // Node that is synced cannot be "ahead" of network
    let blocks_behind = network_height.saturating_sub(local_height);
    let blocks_ahead = local_height.saturating_sub(network_height);
    
    // FIX: sync_progress should be capped at 100%, with separate "ahead" indicator
    let sync_progress = if network_height > 0 {
        let progress = (local_height as f64 / network_height as f64) * 100.0;
        progress.min(100.0) // Cap at 100%
    } else {
        100.0
    };
    
    let status = json!({
        "local_height": local_height,
        "network_height": network_height,
        "is_syncing": is_syncing,
        "is_ahead": is_ahead,
        "blocks_behind": blocks_behind,
        "blocks_ahead": blocks_ahead,
        "sync_progress": format!("{:.2}%", sync_progress),
        "estimated_sync_time": if blocks_behind > 0 {
            format!("{}s", blocks_behind)
        } else if blocks_ahead > 0 {
            format!("ahead by {} blocks", blocks_ahead)
        } else {
            "synced".to_string()
        }
    });
    
    Ok(warp::reply::json(&status))
}

/// Handle network diagnostics request (includes QUIC metrics)
pub(super) async fn handle_network_diagnostics(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(resp) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(resp);
    }
    let (peers, quic_stats) = if let Some(p2p) = blockchain.get_unified_p2p() {
        let peers = p2p.get_peer_count();
        let stats = p2p.get_quic_stats().await;
        (peers, stats)
    } else {
        (0, None)
    };
    
    let height = blockchain.get_height().await;
    let node_type = blockchain.get_node_type();
    
    let uptime_seconds = {
        let start_time = blockchain.get_start_time().timestamp();
        chrono::Utc::now().timestamp() - start_time
    };
    
    // PRODUCTION v2.19.21: Include QUIC transport statistics
    let quic_metrics = if let Some(stats) = quic_stats {
        json!({
            "enabled": true,
            "active_connections": stats.active_connections,
            "connections_established": stats.connections_established,
            "connections_failed": stats.connections_failed,
            "active_connections": stats.active_connections,
            "messages_sent": stats.messages_sent,
            "messages_received": stats.messages_received,
            "bytes_sent": stats.bytes_sent,
            "bytes_received": stats.bytes_received,
            "avg_rtt_ms": stats.avg_rtt_ms
        })
    } else {
        json!({
            "enabled": false,
            "reason": "QUIC transport not initialized"
        })
    };
    
    let diagnostics = json!({
        "node_health": "healthy",
        "network_status": "operational",
        "total_peers": peers,
        "active_connections": peers,
        "current_height": height,
        "node_type": format!("{:?}", node_type),
        "consensus_participation": node_type != crate::node::NodeType::Light,
        "uptime_seconds": uptime_seconds,
        "last_block_time": chrono::Utc::now().timestamp() - 1,
        "transport": {
            "protocol": "QUIC v1 + TLS 1.3",
            "serialization": "bincode (binary)",
            "pki": "PqCertificate (Ed25519 + Dilithium)",
            "quic": quic_metrics
        }
    });
    
    Ok(warp::reply::json(&diagnostics))
}

/// Handle block statistics request
pub(super) async fn handle_block_statistics(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(resp) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(resp);
    }
    let current_height = blockchain.get_height().await;
    let blocks_per_minute = 60; // 1 block per second
    let avg_block_time = 1.0; // seconds
    
    // Get actual transaction count from mempool
    let mempool_size = blockchain.get_mempool_size().await.unwrap_or(0);
    
    let stats = json!({
        "current_height": current_height,
        "blocks_per_minute": blocks_per_minute,
        "average_block_time": avg_block_time,
        "microblocks_produced": current_height,
        "macroblock_height": current_height / 90,
        "next_macroblock": (current_height / 90).saturating_add(1).saturating_mul(90),
        "blocks_until_macroblock": 90u64.saturating_sub(current_height % 90),
        "pending_transactions": mempool_size,
        "average_tx_per_block": if current_height > 0 { mempool_size as f64 / current_height as f64 } else { 0.0 },
    });
    
    Ok(warp::reply::json(&stats))
}

/// Handle performance metrics request
pub(super) async fn handle_performance_metrics(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(resp) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(resp);
    }
    // REAL-TIME: Get actual mempool size
    let mempool_size = blockchain.get_mempool_size().await
        .unwrap_or(0);
    
    // REAL-TIME: Get current chain height
    let current_height = blockchain.get_height().await;
    
    // REAL-TIME: Get peer count
    let peer_count = blockchain.get_peer_count().await.unwrap_or(0);
    
    // Calculate TPS from recent blocks (simplified estimation)
    let tps_current = if current_height > 100 {
        // Estimate TPS based on mempool processing rate
        mempool_size as f64 / 100.0 // Rough estimate
    } else {
        0.0
    };
    
    let metrics = json!({
        "mempool_size": mempool_size,  // REAL-TIME
        "mempool_capacity": 200_000, // 200K TX mempool (v4.1)
        "current_height": current_height,  // REAL-TIME
        "peers_connected": peer_count,  // REAL-TIME
        "tps_current": tps_current,
        "tps_peak": 1000.0, // System design capacity
        "block_production_rate": 1.0, // 1 block per second by design
        "consensus_latency_ms": if current_height % 90 < 5 { 15000 } else { 100 }, // 15s during macroblock consensus
        "p2p_message_rate": 0.0, // Not tracked currently
        "storage_usage_bytes": 0, // RocksDB size not exposed yet
        "memory_usage_mb": 0.0, // Process memory not tracked
        "cpu_usage_percent": 0.0, // CPU usage not tracked
    });
    
    Ok(warp::reply::json(&metrics))
}

/// Handle reputation history request
pub(super) async fn handle_reputation_history(
    remote_addr: Option<std::net::SocketAddr>,
    params: HashMap<String, String>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    if let Err(resp) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(resp);
    }
    let node_id = params.get("node_id")
        .cloned()
        .unwrap_or_else(|| blockchain.get_node_id());
    
    let limit = params.get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(100);
    
    // v2.96: Get reputation from latest MacroBlock snapshot (blockchain consensus)
    // This ensures ALL nodes return SAME value
    let current_reputation = get_reputation_from_snapshot(&blockchain, &node_id).await;
    
    // Get reputation history from persistent storage
    let history_records = blockchain.get_storage()
        .get_reputation_history(&node_id, limit)
        .unwrap_or_else(|_| Vec::new());
    
    let history = json!({
        "node_id": node_id,
        "current_reputation": current_reputation,
        "history": history_records,
        "total_changes": history_records.len(),
        "limit": limit,
        "status": "active"
    });
    
    Ok(warp::reply::json(&history))
}

/// Generate quantum-secure activation code with XOR-encrypted wallet
/// CRITICAL: Must match bridge-server.py format for decrypt compatibility!
/// Format: QNET-{type+timestamp}-{encrypted_wallet1}-{encrypted_wallet2+entropy}
pub(super) async fn generate_quantum_activation_code(
    request: &GenerateActivationCodeRequest,
) -> Result<String, String> {
    use sha3::{Sha3_256, Digest};
    
    println!("🔐 Generating quantum-secure activation code with XOR encryption...");
    println!("   Wallet: {}...", qnet_state::char_prefix(&request.wallet_address, 8));
    println!("   Burn TX: {}...", qnet_state::char_prefix(&request.burn_tx_hash, 8));
    println!("   Node Type: {}", request.node_type);
    
    // Step 1: Create encryption key from burn transaction (SHA3-256 for consistency)
    // key_material = f"{burn_tx_hash}:{node_type}:{burn_amount}"
    let key_material = format!("{}:{}:{}", 
        request.burn_tx_hash, 
        request.node_type.to_lowercase(), 
        request.burn_amount
    );
    
    let mut key_hasher = Sha3_256::new();
    key_hasher.update(key_material.as_bytes());
    let encryption_key_full = hex::encode(key_hasher.finalize());
    let encryption_key = &encryption_key_full[..32]; // First 32 chars
    
    // Step 2: XOR encrypt wallet address (MUST match bridge-server.py)
    let wallet_bytes = request.wallet_address.as_bytes();
    let key_bytes = encryption_key.as_bytes();
    let mut encrypted_wallet = Vec::new();
    
    for (i, &wallet_byte) in wallet_bytes.iter().enumerate() {
        let key_byte = key_bytes[i % key_bytes.len()];
        encrypted_wallet.push(wallet_byte ^ key_byte);
    }
    
    // Convert to hex
    let encrypted_wallet_hex = hex::encode(&encrypted_wallet).to_uppercase();
    
    // Step 3: Generate DETERMINISTIC entropy from burn transaction data
    // CRITICAL: Must NOT use current time — same inputs MUST always produce the same code
    // CRITICAL: node_type MUST be lowercase — same as XOR key (Step 1) for consistency
    let mut entropy_hasher = Sha3_256::new();
    entropy_hasher.update(format!("entropy:{}:{}:{}", 
        request.wallet_address, 
        request.burn_tx_hash,
        request.node_type.to_lowercase()
    ).as_bytes());
    let entropy_hash = hex::encode(entropy_hasher.finalize());
    let entropy_short = &entropy_hash[..4].to_uppercase();
    
    // Step 4: Node type marker
    // v3.18: Full nodes removed
    let node_type_marker = match request.node_type.to_lowercase().as_str() {
        "light" => "L",
        "super" => "S",
        "full" => "S", // v3.18: Map to Super for backward compatibility
        _ => "U",
    };
    
    // Step 5: DETERMINISTIC "timestamp" segment — derived from burn_tx_hash, NOT from wall-clock
    // CRITICAL: chrono::Utc::now() was here before → different code every call → recovery mismatch!
    // CRITICAL: node_type MUST be lowercase — same as XOR key (Step 1) for consistency
    let mut ts_hasher = Sha3_256::new();
    ts_hasher.update(format!("ts:{}:{}", request.burn_tx_hash, request.node_type.to_lowercase()).as_bytes());
    let ts_hash = hex::encode(ts_hasher.finalize());
    let timestamp_part = &ts_hash[..5].to_uppercase();
    
    // Step 6: Build segments (MUST match bridge-server.py format)
    // segment1: NodeType + Timestamp (6 chars)
    let segment1 = format!("{}{:0>5}", node_type_marker, timestamp_part).to_uppercase();
    
    // segment2: First 6 chars of encrypted wallet hex
    let segment2 = if encrypted_wallet_hex.len() >= 6 {
        encrypted_wallet_hex[..6].to_string()
    } else {
        format!("{:0<6}", encrypted_wallet_hex)
    };
    
    // segment3: More encrypted wallet (chars 6-10) + entropy (4 chars) = 6 chars total
    let wallet_part2 = if encrypted_wallet_hex.len() >= 10 {
        &encrypted_wallet_hex[6..10]
    } else if encrypted_wallet_hex.len() > 6 {
        &encrypted_wallet_hex[6..]
    } else {
        "0000"
    };
    let segment3 = format!("{}{}", wallet_part2, entropy_short);
    let segment3 = if segment3.len() >= 6 { segment3[..6].to_string() } else { format!("{:0<6}", segment3) };
    
    // Step 7: Format final code
    let activation_code = format!("QNET-{}-{}-{}", segment1, segment2, segment3);
    
    // Validate length (should be 25 chars: QNET-XXXXXX-XXXXXX-XXXXXX)
    if activation_code.len() != 25 {
        println!("⚠️ Code length: {} (expected 25)", activation_code.len());
    }
    
    println!("✅ Quantum activation code generated with XOR-encrypted wallet");
    println!("   Code: {}", activation_code);
    println!("   Encryption key derived from burn_tx:type:amount");
    
    Ok(activation_code)
}

// ============================================================================
// SMART CONTRACT HANDLERS
// ============================================================================

/// Handle token info query
/// v3.40: Reads FROM BLOCKCHAIN STATE (StateManager), not local RocksDB.
/// Token metadata is stored in Account.contract_storage via apply_to_state(ContractDeploy).
pub(super) async fn handle_token_info(
    contract_address: String,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Read contract account from blockchain state (single source of truth)
    match blockchain.get_account(&contract_address).await {
        Ok(Some(account)) if account.is_contract => {
            let storage = &account.contract_storage;
            // Serve both fungible (qrc20) and non-fungible (qrc721) standards; NFTs are indivisible.
            let std_type = storage.get("type").map(|t| t.as_str()).unwrap_or("");
            let is_token = std_type == "qrc20" || std_type == "qrc721";

            if is_token {
                let decimals: u8 = if std_type == "qrc721" { 0 }
                    else { storage.get("decimals").and_then(|d| d.parse::<u8>().ok()).unwrap_or(9) };
                Ok(warp::reply::json(&json!({
                    "success": true,
                    "token": {
                        "contract_address": contract_address,
                        "standard": std_type,
                        "name": storage.get("name").cloned().unwrap_or_default(),
                        "symbol": storage.get("symbol").cloned().unwrap_or_default(),
                        "decimals": decimals,
                        // Optional on-chain token logo (emoji or https URL); "" when the deployer set none
                        // — clients fall back to a generated avatar. Sanitized at deploy (https-only scheme).
                        "logo": storage.get("logo").cloned().unwrap_or_default(),
                        // u128 base units as a STRING: a JSON number is an f64 and loses precision above
                        // 2^53, so a large-supply token would round in any JS client. Parse validates it
                        // as u128 (the QRC-20 storage width; total_supply == total_minted − total_burned,
                        // both u128), .to_string() re-emits it exactly. Clients scale by `decimals`.
                        "total_supply": storage.get("total_supply").and_then(|s| s.parse::<u128>().ok()).unwrap_or(0).to_string(),
                        // Lifetime emission (string, u128-safe): total_supply == total_minted − total_burned.
                        "total_minted": storage.get("total_minted").and_then(|s| s.parse::<u128>().ok()).unwrap_or(0).to_string(),
                        "total_burned": storage.get("total_burned").and_then(|s| s.parse::<u128>().ok()).unwrap_or(0).to_string(),
                        "deployer": storage.get("deployer").cloned().unwrap_or_default(),
                        "deployed_at": storage.get("deployed_at").cloned().unwrap_or_default()
                    },
                    "source": "blockchain_state"
                })))
            } else {
                Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "Contract exists but is not a QRC-20/QRC-721 token",
                    "contract_address": contract_address
                })))
            }
        }
        Ok(_) => {
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Token not found",
                "contract_address": contract_address
            })))
        }
        Err(e) => {
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Failed to query token",
                "details": format!("{:?}", e)
            })))
        }
    }
}

/// Handle token balance query
/// v3.40: Reads FROM BLOCKCHAIN STATE (StateManager), not local RocksDB.
/// Token balances are stored in Account.contract_storage["balance:{address}"] 
/// via apply_to_state(ContractCall/ContractDeploy).
pub(super) async fn handle_token_balance(
    contract_address: String,
    holder_address: String,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Read contract account from blockchain state (single source of truth)
    match blockchain.get_account(&contract_address).await {
        Ok(Some(account)) if account.is_contract => {
            let storage = &account.contract_storage;
            let balance_key = format!("balance:{}", holder_address);
            let balance: u128 = storage.get(&balance_key)
                .and_then(|s| s.parse().ok()).unwrap_or(0);

            Ok(warp::reply::json(&json!({
                "success": true,
                "contract_address": contract_address,
                "holder_address": holder_address,
                // u128 base units as a STRING (exact — a JSON number would round; QRC-20 stores u128).
                // Client scales by decimals.
                "balance": balance.to_string(),
                "token_name": storage.get("name").cloned().unwrap_or_default(),
                "token_symbol": storage.get("symbol").cloned().unwrap_or_default(),
                "decimals": storage.get("decimals").and_then(|d| d.parse::<u8>().ok()).unwrap_or(9),
                "source": "blockchain_state"
            })))
        }
        Ok(_) => {
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Token contract not found",
                "contract_address": contract_address
            })))
        }
        Err(e) => {
            Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Failed to query balance",
                "details": format!("{:?}", e)
            })))
        }
    }
}

/// Handle query for all QRC-20 tokens held by an address.
/// Fast path: the wallet_token reverse index (O(held) prefix seek), each hit balance-rechecked
/// against live state so a stale index entry can never surface a phantom or wrong-balance token.
/// Fallback (until the boot backfill marks the index authoritative): the full O(N) contract scan,
/// so a pre-index or not-yet-backfilled DB never regresses the returned list.
pub(super) async fn handle_tokens_for_address(
    address: String,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    let balance_key = format!("balance:{}", address);
    let mut tokens: Vec<serde_json::Value> = Vec::new();

    // ONE token-row projection for both the index and scan branches, so the response shape can never
    // depend on which path served it. u128 base units as a STRING (exact past 2^53); client scales by
    // decimals. Also the ONE type==qrc20 gate — a generic WASM contract writing a `balance:{wallet}`
    // key must never surface as a phantom token.
    let token_row = |contract: &str, cs: &std::collections::HashMap<String, String>| -> Option<serde_json::Value> {
        if cs.get("type").map(|t| t != "qrc20").unwrap_or(true) { return None; }
        // u128 (QRC-20 storage width) so a whale above u64::MAX is not dropped from the list.
        let balance: u128 = cs.get(&balance_key).and_then(|s| s.parse().ok()).unwrap_or(0);
        if balance == 0 { return None; }
        Some(json!({
            "contract_address": contract,
            "balance": balance.to_string(),
            "name": cs.get("name").cloned().unwrap_or_default(),
            "symbol": cs.get("symbol").cloned().unwrap_or_default(),
            "decimals": cs.get("decimals").and_then(|d| d.parse::<u8>().ok()).unwrap_or(9)
        }))
    };

    // Use the reverse index (O(held) prefix seek) ONLY while it is authoritative. Until the boot
    // backfill sets OWNS_INDEX_READY, a partial index is NOT trusted (a not-yet-indexed holding would
    // under-report) — take the authoritative O(N) scan instead. Each index hit is still balance-rechecked
    // against live state, so a stale entry can never surface a phantom or wrong-balance token.
    if crate::storage::OWNS_INDEX_READY.load(std::sync::atomic::Ordering::Relaxed) {
        // A storage-read error is NOT an authoritative "no tokens" — only a successful seek is. On Err,
        // fall through to the O(N) scan below instead of returning an empty index result.
        match blockchain.get_storage().get_tokens_for_wallet(&address) {
            Ok(indexed) => {
                for contract in &indexed {
                    if let Ok(Some(account)) = blockchain.get_account(contract).await {
                        if !account.is_contract { continue; }
                        if let Some(row) = token_row(contract, &account.contract_storage) { tokens.push(row); }
                    }
                }
                let count = tokens.len();
                return Ok(warp::reply::json(&json!({
                    "success": true,
                    "address": address,
                    "tokens": tokens,
                    "token_count": count,
                    "source": "reverse_index"
                })));
            }
            Err(e) => {
                if is_warn() { println!("[WARN][RPC] tokens_index_read_failed addr={} err={:?} action=scan", address, e); }
            }
        }
    }

    // Fallback: authoritative full scan of contract accounts for this holder's balance.
    let state_manager = blockchain.get_state_manager();
    let state = state_manager.read().await;
    for (addr, account) in state.get_all_accounts() {
        if !account.is_contract { continue; }
        if let Some(row) = token_row(&addr, &account.contract_storage) { tokens.push(row); }
    }

    let count = tokens.len();
    Ok(warp::reply::json(&json!({
        "success": true,
        "address": address,
        "tokens": tokens,
        "token_count": count,
        "source": "blockchain_state"
    })))
}

/// GET /api/v1/richlist?limit=N — native QNC rich list served O(K) from the apply-time index:
/// top-K holders (balance desc, address asc) + holder count read straight from storage, with NO
/// account scan and NO consensus lock. Supply is the AUTHORITATIVE emission watermark
/// (get_total_supply), not a balance re-sum (which would omit unclaimed rewards and contract/pool-held
/// QNC). Rate-limited; percent is balance/circulating. limit clamped 1..=500.
pub(super) async fn handle_qnc_richlist(
    params: std::collections::HashMap<String, String>,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(resp) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(resp);
    }
    let limit = params.get("limit").and_then(|s| s.parse::<usize>().ok()).unwrap_or(100).clamp(1, 500);

    // O(K) reads from the rich-list index — no account pass, no consensus lock.
    let storage = blockchain.get_storage();
    let holders = storage.richlist_top_k(limit).unwrap_or_default();
    let holder_count = storage.richlist_holder_count();

    // Authoritative supply figures (brief state lock): minted total + burn-sink balance → circulating.
    let burn_addr = qnet_state::transaction::CANONICAL_BURN_ADDR;
    let (total_supply_raw, burned_raw) = {
        let sm = blockchain.get_state_manager();
        let state = sm.read().await;
        (state.get_total_supply(), state.get_balance(burn_addr))
    };
    let circulating = total_supply_raw.saturating_sub(burned_raw);

    let rows: Vec<serde_json::Value> = holders.iter().map(|(addr, bal)| {
        let pct = if circulating > 0 { (*bal as f64) / (circulating as f64) * 100.0 } else { 0.0 };
        json!({ "address": addr, "balance_raw": bal.to_string(), "percent": format!("{:.4}", pct) })
    }).collect();

    Ok(warp::reply::json(&json!({
        "success": true,
        "total_supply_raw": total_supply_raw.to_string(),
        "circulating_raw": circulating.to_string(),
        "burned_raw": burned_raw.to_string(),
        "holder_count": holder_count,
        "holders": rows,
        "source": "richlist_index",
    })))
}

// ============================================================================
// BENCHMARK HANDLERS - Real Transaction Load Testing
// ============================================================================

/// Request body for benchmark start
#[derive(Debug, Clone, serde::Deserialize)]
pub(super) struct BenchmarkStartRequest {
    /// Preset configuration (stability_test, stress_test, max_capacity, progressive_max,
    /// single_shard, small_scale, medium_scale, large_scale, extra_large, full_scale)
    #[serde(default)]
    pub(super) preset: Option<crate::benchmark::BenchmarkPreset>,
    /// Number of shards to simulate (1-256)
    #[serde(default)]
    pub(super) shards: Option<usize>,
    /// Total number of transactions to generate
    #[serde(default)]
    pub(super) total: Option<u64>,
    /// Target TPS
    #[serde(default)]
    pub(super) target_tps: Option<u64>,
    /// Number of test accounts
    #[serde(default)]
    pub(super) num_accounts: Option<usize>,
    /// Enable post-quantum signing: pure ML-DSA-65 (ML-DSA-65).
    /// Each TX is ML-DSA-65-signed — real post-quantum throughput measurement.
    /// Note: ML-DSA-65 is ~50x slower than Ed25519; expect ~1-2K TPS per core.
    #[serde(default)]
    pub(super) use_pq: Option<bool>,
    /// v10.0: Authentication secret (must match QNET_BENCHMARK_SECRET env var)
    #[serde(default)]
    pub(super) secret: Option<String>,
}

/// Handle GET /api/v1/benchmark/status (v10.0: rate-limited)
pub(super) async fn handle_benchmark_status(
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<impl Reply, Rejection> {
    use crate::benchmark::BENCHMARK_MANAGER;

    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "benchmark") {
        return Ok(rate_limit_response);
    }

    let status = BENCHMARK_MANAGER.get_status().await;
    
    Ok(warp::reply::json(&json!({
        "success": true,
        "status": {
            "is_running": status.is_running,
            "transactions_sent": status.transactions_sent,
            "transactions_confirmed": status.transactions_confirmed,
            "current_tps": status.current_tps,
            "peak_tps": status.peak_tps,
            "elapsed_seconds": status.elapsed_seconds,
            "errors": status.errors
        }
    })))
}

/// Handle GET /api/v1/benchmark/results (v10.0: rate-limited)
pub(super) async fn handle_benchmark_results(
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<impl Reply, Rejection> {
    use crate::benchmark::BENCHMARK_MANAGER;

    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "benchmark") {
        return Ok(rate_limit_response);
    }

    let results = BENCHMARK_MANAGER.get_results().await;
    
    Ok(warp::reply::json(&json!({
        "success": true,
        "results": {
            "total_transactions": results.total_transactions,
            "confirmed_transactions": results.confirmed_transactions,
            "duration_seconds": results.duration_seconds,
            "average_tps": results.average_tps,
            "peak_tps": results.peak_tps,
            "min_latency_ms": results.min_latency_ms,
            "max_latency_ms": results.max_latency_ms,
            "avg_latency_ms": results.avg_latency_ms,
            "p99_latency_ms": results.p99_latency_ms,
            "errors": results.errors,
            "success_rate": results.success_rate
        }
    })))
}

/// Handle POST /api/v1/benchmark/stop (v10.0: auth + rate-limited)
pub(super) async fn handle_benchmark_stop(
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<impl Reply, Rejection> {
    use crate::benchmark::BENCHMARK_MANAGER;

    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "benchmark") {
        return Ok(rate_limit_response);
    }
    // v10.0: Require QNET_BENCHMARK_SECRET for stop (same as start)
    if let Some(_expected_secret) = std::env::var("QNET_BENCHMARK_SECRET").ok() {
        // Stop requires auth but has no body — only allow from genesis nodes or internal IPs
        let ip_str = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
        let is_genesis = std::env::var("QNET_BOOTSTRAP_ID").is_ok();
        if !is_genesis && !is_internal_ip(&ip_str) {
            println!("[WARN][RPC] benchmark_stop_rejected ip={} reason=unauthorized", ip_str);
            return Ok(warp::reply::json(&json!({"success": false, "error": "unauthorized"})));
        }
    }

    BENCHMARK_MANAGER.stop().await;
    let results = BENCHMARK_MANAGER.get_results().await;
    
    Ok(warp::reply::json(&json!({
        "success": true,
        "message": "Benchmark stopped",
        "results": {
            "total_transactions": results.total_transactions,
            "peak_tps": results.peak_tps,
            "average_tps": results.average_tps,
            "duration_seconds": results.duration_seconds
        }
    })))
}

/// Handle GET /api/v1/benchmark/presets (v10.0: rate-limited)
pub(super) async fn handle_benchmark_presets(
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<impl Reply, Rejection> {
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "benchmark") {
        return Ok(rate_limit_response);
    }
    Ok(warp::reply::json(&json!({
        "success": true,
        "presets": [
            {
                "name": "single_shard",
                "description": "Single shard test",
                "shards": 1,
                "target_tps": 100_000,
                "total_transactions": 100_000
            },
            {
                "name": "small_scale",
                "description": "8 shards test",
                "shards": 8,
                "target_tps": 400_000,
                "total_transactions": 400_000
            },
            {
                "name": "medium_scale",
                "description": "32 shards test",
                "shards": 32,
                "target_tps": 1_600_000,
                "total_transactions": 1_600_000
            },
            {
                "name": "large_scale",
                "description": "64 shards test",
                "shards": 64,
                "target_tps": 3_200_000,
                "total_transactions": 3_200_000
            },
            {
                "name": "extra_large",
                "description": "128 shards test",
                "shards": 128,
                "target_tps": 6_400_000,
                "total_transactions": 6_400_000
            },
            {
                "name": "full_scale",
                "description": "MAXIMUM: 256 shards test",
                "shards": 256,
                "target_tps": 12_800_000,
                "total_transactions": 12_800_000
            }
        ],
        "formula": "TPS = shards × 50,000",
        "max_theoretical": "12.8M TPS (256 shards × 50K)"
    })))
}

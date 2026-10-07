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
    pub devices: Vec<LightNodeDevice>, // The node's one device (A15); empty after an unbind
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
    /// LWW event time stamped by the genesis that served the original refresh.
    /// Absent from a pre-upgrade sender ⇒ receiver stamps arrival time (legacy behavior).
    #[serde(default)]
    pub(super) ts:         Option<u64>,
    /// The binding sequence the record belongs to (U8). Absent from a legacy record.
    #[serde(default)]
    pub(super) seq:        Option<u64>,
    /// The device's own signatures behind a v2 record (H5), so the receiver re-verifies it instead
    /// of trusting whoever reached the route. Required for a node with a v2 binding.
    #[serde(default)]
    pub(super) proof:      Option<TokenSyncProof>,
    /// A legacy record's writer (`light_binding::record_writer` of the wallet key the genesis that took
    /// it accepted it under). Absent from a v2 record and from an older sender.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) writer:     Option<String>,
    /// The bound device's platform hint a v2 record's bind named ("android", "ios"): unsigned and display-only.
    /// Absent from a record that names none (a token refresh keeps the stored one) and from an older sender.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) platform:   Option<String>,
    /// The bound device's model hint a v2 record's bind named (`light_binding::model_hint`), as `platform`:
    /// unsigned, display-only, absent when none and from an older sender, ignored by an older receiver.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) model:      Option<String>,
}

/// The signed facts behind a v2 push record: the binding (identity key, ping key, v2 delegation) and
/// either the wallet key's attach or the ping key's token refresh over this exact push target.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub(crate) struct TokenSyncProof {
    pub(crate) identity_pubkey: String,
    pub(crate) ping_pubkey:     String,
    /// `v2.{seq}.{sig}`
    pub(crate) delegation_cert: String,
    /// "attach" (signed by the wallet key) or "refresh" (signed by the ping key).
    pub(crate) kind:            String,
    pub(crate) sig:             String,
    pub(crate) sig_ts:          u64,
}

/// The client for genesis-to-genesis internal calls. Each genesis's HTTPS name is pinned to its
/// address in the binary's table, so a call reaches that very host over TLS with no DNS lookup, and
/// over IPv4: the receiver's allowlist knows the genesis nodes by those addresses.
fn genesis_internal_client() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        let mut b = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .connect_timeout(std::time::Duration::from_secs(3));
        for (ip, _) in crate::genesis_constants::GENESIS_NODE_IPS {
            let addr = format!("{}:443", ip).parse::<std::net::SocketAddr>();
            if let (Some(name), Ok(addr)) = (crate::genesis_constants::genesis_https_name_for_ip(ip), addr) {
                b = b.resolve(name, addr);
            }
        }
        b.build().unwrap_or_default()
    })
}

/// How a genesis-to-genesis call may leave TLS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlainFallback {
    /// TLS only: a pull whose answer this node applies, and every device-layer route. Anyone on the path
    /// can make TLS fail, so a fallback would hand them the answer or the request in clear (NB-3, ND-3).
    Never,
    /// Plain HTTP when the connection to 443 could not be made or timed out (a host whose terminator is
    /// down), or the host answered 403 over TLS (a terminator that passed no caller address). Never after a
    /// TLS or certificate error. Logged at WARN.
    OnConnectFailure,
}

/// A failed HTTPS attempt that may retry in plain HTTP: a timeout, or a connection the transport refused,
/// reset or dropped. A TLS or certificate failure (surfaced as an I/O error of another kind) never is.
pub(crate) fn plain_fallback_allowed(e: &reqwest::Error) -> bool {
    if e.is_timeout() {
        return true;
    }
    if !e.is_connect() {
        return false;
    }
    let mut src: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(e);
    while let Some(s) = src {
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            use std::io::ErrorKind::*;
            return matches!(io.kind(), ConnectionRefused | ConnectionReset | ConnectionAborted | NotConnected
                | AddrNotAvailable | TimedOut);
        }
        src = s.source();
    }
    false
}

/// Call a genesis peer's internal route (H5) over its HTTPS name, so push tokens and the device's proofs do
/// not cross the internet in clear; a plain retry only as `PlainFallback::OnConnectFailure` allows. `path`
/// starts with `/`.
pub(crate) async fn genesis_internal_call(
    ip: &str,
    path: &str,
    build: impl Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
) -> reqwest::Result<reqwest::Response> {
    genesis_internal_call_with(ip, path, PlainFallback::OnConnectFailure, build).await
}

/// `genesis_internal_call` over TLS only (`PlainFallback::Never`).
pub(crate) async fn genesis_internal_call_tls(
    ip: &str,
    path: &str,
    build: impl Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
) -> reqwest::Result<reqwest::Response> {
    genesis_internal_call_with(ip, path, PlainFallback::Never, build).await
}

async fn genesis_internal_call_with(
    ip: &str,
    path: &str,
    fallback: PlainFallback,
    build: impl Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
) -> reqwest::Result<reqwest::Response> {
    let client = genesis_internal_client();
    let Some(name) = crate::genesis_constants::genesis_https_name_for_ip(ip) else {
        // An address with no HTTPS name in the binary's table is no genesis: nothing to protect over TLS.
        return build(client, &format!("http://{}:8001{}", ip, path)).send().await;
    };
    match build(client, &format!("https://{}{}", name, path)).send().await {
        Ok(r) if r.status() != reqwest::StatusCode::FORBIDDEN || fallback == PlainFallback::Never => return Ok(r),
        Ok(r) => if crate::node::is_warn() {
            println!("[WARN][LIGHT] genesis_internal_downgrade ip={} path={} status={} fallback=plain", ip, path, r.status());
        },
        Err(e) if fallback == PlainFallback::OnConnectFailure && plain_fallback_allowed(&e) => if crate::node::is_warn() {
            println!("[WARN][LIGHT] genesis_internal_downgrade ip={} path={} err={} fallback=plain", ip, path, e);
        },
        Err(e) => {
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] genesis_internal_https_failed ip={} path={} err={} fallback=none", ip, path, e);
            }
            return Err(e);
        }
    }
    build(client, &format!("http://{}:8001{}", ip, path)).send().await
}

/// Fire-and-forget: broadcast a newly-registered FCM token to all peer genesis nodes
/// so every genesis node can send FCM pings regardless of which one took the registration.
/// A v2 record carries its binding sequence and proof; a legacy one carries neither, only the writer
/// it was accepted under (empty when not known).
#[allow(clippy::too_many_arguments)]
pub(super) async fn sync_fcm_token_to_genesis_peers(
    pseudonym: &str,
    token:     &str,
    push_type: &str,
    endpoint:  Option<&str>,
    our_ip:    &str,
    ts:        u64,
    seq:       u64,
    proof:     Option<TokenSyncProof>,
    writer:    &str,
    platform:  &str,
    model:     &str,
) {
    use crate::genesis_constants::GENESIS_NODE_IPS;
    const SYNC_PATH: &str = "/api/v1/internal/fcm-token-sync";

    let body = FcmTokenSyncRequest {
        pseudonym: pseudonym.to_string(),
        token:     token.to_string(),
        push_type: push_type.to_string(),
        endpoint:  endpoint.map(|s| s.to_string()),
        origin_ip: our_ip.to_string(),
        ts:        Some(ts),
        seq:       (seq > 0).then_some(seq),
        writer:    (seq == 0 && proof.is_none() && !writer.is_empty()).then(|| writer.to_string()),
        platform:  (seq > 0 && !platform.is_empty()).then(|| platform.to_string()),
        model:     (seq > 0 && !model.is_empty()).then(|| model.to_string()),
        proof,
    };

    // A record without a proof is taken on the sender's address alone, so it goes over TLS only (L-1); a failed
    // peer heals through its own pull (`fcm-token-get`). A v2 record carries the device's signatures, which the
    // receiver checks: while the roll leaves a genesis whose TLS terminator passes no caller address, it may still
    // retry in plain HTTP (logged at WARN).
    let body_ref = &body;
    let send = move |ip: &'static str| async move {
        if body_ref.proof.is_some() {
            genesis_internal_call(ip, SYNC_PATH, |c, url| c.post(url).json(body_ref)).await
        } else {
            genesis_internal_call_tls(ip, SYNC_PATH, |c, url| c.post(url).json(body_ref)).await
        }
    };

    // A peer that has not applied the node's registration yet cannot check a v2 record and refuses it
    // as not_registered; the block reaches it within seconds (a promoted pending binding is sent the
    // moment this genesis applies it), so those peers get one more try.
    let mut behind: Vec<&'static str> = Vec::new();
    for (ip, _id) in GENESIS_NODE_IPS {
        // Skip self
        if *ip == our_ip || ip.is_empty() { continue; }

        match send(*ip).await {
            Ok(resp) if resp.status().is_success() => {
                if crate::node::is_info() {
                    println!("[INFO][LIGHT] fcm_token_synced_to ip={} pseudonym={}", ip, pseudonym);
                }
            }
            Ok(resp) => {
                let status = resp.status();
                let reason = resp.json::<serde_json::Value>().await.ok()
                    .and_then(|v| v["reason"].as_str().map(|r| r.to_string())).unwrap_or_default();
                if reason == "not_registered" && body.proof.is_some() { behind.push(*ip); }
                if crate::node::is_warn() {
                    println!("[WARN][LIGHT] fcm_token_sync_rejected ip={} status={} reason={}", ip, status, reason);
                }
            }
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][LIGHT] fcm_token_sync_failed ip={} err={}", ip, e);
                }
            }
        }
    }
    if behind.is_empty() { return; }
    tokio::time::sleep(std::time::Duration::from_secs(15)).await;
    for ip in behind {
        let ok = send(ip).await.map_or(false, |r| r.status().is_success());
        if crate::node::is_info() {
            println!("[INFO][LIGHT] fcm_token_sync_retry ip={} pseudonym={} ok={}", ip, pseudonym, ok);
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
    // IP allowlist — only genesis peers may call this
    let caller_ip = remote_addr
        .map(|a| a.ip().to_string())
        .unwrap_or_default();

    if !is_genesis_peer_ip(&caller_ip) {
        if crate::node::is_warn() {
            println!("[WARN][LIGHT] fcm_sync_rejected_unauthorized caller={}", caller_ip);
        }
        return Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"success": false, "error": "Unauthorized"})),
            warp::http::StatusCode::FORBIDDEN,
        ));
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let p2p = blockchain.get_unified_p2p();
    let (status, body) = match apply_token_sync(&blockchain.get_storage(), p2p.as_deref(), &req, now) {
        SyncOutcome::Applied => {
            if crate::node::is_info() {
                println!("[INFO][LIGHT] fcm_token_synced_from ip={} pseudonym={} push={} seq={}",
                         caller_ip, req.pseudonym, req.push_type, req.seq.unwrap_or(0));
            }
            (warp::http::StatusCode::OK, serde_json::json!({"success": true}))
        }
        // An older record than the stored one: never clobbers it. That is exactly how a pinger ended
        // up holding a stale push channel and silently never waking the device.
        SyncOutcome::Stale(reason) => {
            if crate::node::is_debug() {
                println!("[DBG][LIGHT] fcm_sync_stale_ignored pseudonym={} reason={}", req.pseudonym, reason);
            }
            (warp::http::StatusCode::OK, serde_json::json!({"success": true, "applied": false, "reason": reason}))
        }
        SyncOutcome::Refused(reason) => {
            if crate::node::is_warn() {
                println!("[WARN][LIGHT] fcm_sync_refused ip={} pseudonym={} reason={}", caller_ip, req.pseudonym, reason);
            }
            let code = if reason == "storage" { warp::http::StatusCode::INTERNAL_SERVER_ERROR } else { warp::http::StatusCode::BAD_REQUEST };
            (code, serde_json::json!({"success": false, "error": reason, "reason": reason}))
        }
    };
    Ok(warp::reply::with_status(warp::reply::json(&body), status))
}

/// What a token sync did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SyncOutcome {
    Applied,
    Stale(&'static str),
    Refused(&'static str),
}

/// Merge a peer genesis's push record. A legacy record (no proof) is taken only for a node that never
/// had a v2 binding, last writer wins by `ts` as before. A v2 record is re-verified from the device's
/// own signatures - identity under the chain commitment, the v2 delegation, and the attach or token
/// refresh over this exact push target - then applied binding first, so a newer binding reaches this
/// genesis together with its token, and ordered by `(seq, ts)`: a replaced device's record never
/// comes back (U8).
pub(super) fn apply_token_sync(
    storage: &crate::storage::Storage,
    p2p: Option<&crate::unified_p2p::SimplifiedP2P>,
    req: &FcmTokenSyncRequest,
    now: u64,
) -> SyncOutcome {
    use crate::light_binding as lb;
    let node = req.pseudonym.as_str();
    if node.is_empty() { return SyncOutcome::Refused("missing_fields"); }
    let pt = lb::canonical_push_type(Some(req.push_type.as_str()));
    let ts = req.ts.unwrap_or(now);
    // The endpoint is where this genesis POSTs on each push and wake: the check the taking genesis ran,
    // run again here, whatever form the record comes in.
    if pt == "unifiedpush" && req.endpoint.as_deref().map_or(false, |e| !e.is_empty() && validate_unified_push_endpoint(e).is_err()) {
        return SyncOutcome::Refused("bad_endpoint");
    }
    let written = match &req.proof {
        None => {
            // A legacy UnifiedPush registration may carry its endpoint and no token.
            let endpoint_only = pt == "unifiedpush" && req.endpoint.as_deref().map_or(false, |e| !e.is_empty());
            if req.token.is_empty() && !endpoint_only { return SyncOutcome::Refused("missing_fields"); }
            if storage.get_light_binding(node).map_or(false, |b| !b.never_v2()) {
                return SyncOutcome::Refused("proof_required");
            }
            // Under the writer the sending genesis accepted it under: a legacy row here takes only its own.
            storage.save_fcm_token_by(node, &req.token, pt, req.endpoint.as_deref(), ts, req.writer.as_deref().unwrap_or(""))
                .map(|w| (w, 0u64))
        }
        Some(p) => {
            // Checked against the registration's commitment, which this genesis may not hold yet.
            if !storage.is_node_registration_onchain(node) { return SyncOutcome::Refused("not_registered"); }
            let seq = match req.seq { Some(s) if s > 0 => s, _ => return SyncOutcome::Refused("bad_proof") };
            if lb::parse_cert(&p.delegation_cert).and_then(|f| f.seq()) != Some(seq) {
                return SyncOutcome::Refused("bad_proof");
            }
            let identity = match storage.resolve_light_identity_pk(node, Some(&p.identity_pubkey)) {
                Some(k) if k.eq_ignore_ascii_case(&p.identity_pubkey) => k,
                _ => return SyncOutcome::Refused("identity_mismatch"),
            };
            if lb::verify_delegation(&p.delegation_cert, &p.ping_pubkey, node, &identity).is_none() {
                return SyncOutcome::Refused("bad_proof");
            }
            // A v2 record keeps exactly what its message signs: the token for FCM, the endpoint for
            // UnifiedPush, nothing for polling; an unsigned extra field is dropped, not stored.
            let token = if pt == "fcm" { req.token.as_str() } else { "" };
            let endpoint = if pt == "unifiedpush" { req.endpoint.as_deref().filter(|e| !e.is_empty()) } else { None };
            let target = lb::push_target(pt, token, endpoint);
            let signed = match p.kind.as_str() {
                "attach" => lb::attach_v2_message(node, &p.ping_pubkey, target, seq, p.sig_ts)
                    .map_or(false, |m| verify_mobile_dilithium_signature(&m, &p.sig, &identity)),
                "refresh" => verify_mobile_dilithium_signature(
                    &lb::token_refresh_v2_message(node, target, seq, p.sig_ts), &p.sig, &p.ping_pubkey),
                _ => false,
            };
            if !signed { return SyncOutcome::Refused("bad_proof"); }
            match storage.save_light_ping_keys_identity(node, &p.ping_pubkey, &p.delegation_cert, &identity) {
                Ok(w) if w.holds() => {}
                Ok(_) => return SyncOutcome::Stale("stale_seq"),
                Err(_) => return SyncOutcome::Refused("storage"),
            }
            // Ordered by the signed time of the message that set it, as at the genesis that took it:
            // the unsigned `ts` of the request plays no part in a v2 record.
            let platform = lb::platform_hint(req.platform.as_deref());
            let model = lb::model_hint(req.model.as_deref());
            storage.save_fcm_token_seq_platform(node, token, pt, endpoint, p.sig_ts, seq, platform, model)
                .map(|w| (w, seq))

        }
    };
    match written {
        Ok((true, _)) => {
            if let Some(p2p) = p2p {
                p2p.refresh_light_node_push_channel(storage, node);
            }
            SyncOutcome::Applied
        }
        Ok((false, 0)) => SyncOutcome::Stale("stale"),
        Ok((false, _)) => SyncOutcome::Stale("stale_seq"),
        Err(_) => SyncOutcome::Refused("storage"),
    }
}

/// A push record this shard owner pulled from a peer genesis to heal its own (the peer served the
/// device's attestation, so its channel is live). It carries no proof, so it is taken only for the
/// binding this node already holds - a v2 record at exactly the stored sequence - or, for a node with
/// no v2 binding, a legacy record, under the writer the peer kept (a legacy row here takes only its own).
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_pulled_push_record(
    storage: &crate::storage::Storage,
    p2p: Option<&crate::unified_p2p::SimplifiedP2P>,
    node_id: &str, token: &str, push_type: &str, endpoint: Option<&str>, ts: u64, seq: u64, writer: &str,
) -> bool {
    let binding = storage.get_light_binding(node_id);
    let current = binding.as_ref().filter(|b| !b.never_v2()).map(|b| b.seq);
    let admissible = match current {
        Some(s) => s > 0 && seq == s,
        None => seq == 0,
    };
    if !admissible || (token.is_empty() && endpoint.map_or(true, |e| e.is_empty())) { return false; }
    // A stamp from the future would pin the channel: every later refresh of this binding reads as older.
    if ts > crate::light_device::now_secs().saturating_add(crate::light_binding::FRESH_TS_WINDOW_SECS) { return false; }
    let pt = crate::light_binding::canonical_push_type(Some(push_type));
    if pt == "unifiedpush" && endpoint.map_or(false, |e| !e.is_empty() && validate_unified_push_endpoint(e).is_err()) {
        return false;
    }
    let written = if seq == 0 {
        storage.save_fcm_token_by(node_id, token, pt, endpoint, ts, writer)
    } else {
        storage.save_fcm_token_seq(node_id, token, pt, endpoint, ts, seq)
    };
    match written {
        Ok(true) => {
            if let Some(p2p) = p2p {
                p2p.refresh_light_node_push_channel(storage, node_id);
            }
            true
        }
        _ => false,
    }
}

/// Handler: GET /api/v1/internal/fcm-token-get?node_id=X
/// Genesis-only: serves the local push-channel record with its LWW ts, so a shard
/// owner whose copy degraded (missed a sync while down) can pull and re-merge it.
pub(super) async fn handle_internal_fcm_token_get(
    remote_addr: Option<std::net::SocketAddr>,
    params:      std::collections::HashMap<String, String>,
    blockchain:  Arc<BlockchainNode>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let caller_ip = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
    if !is_genesis_peer_ip(&caller_ip) {
        return Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"success": false, "error": "Unauthorized"})),
            warp::http::StatusCode::FORBIDDEN,
        ));
    }
    let node_id = match params.get("node_id") {
        Some(id) if !id.is_empty() => id,
        _ => return Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"success": false, "error": "node_id required"})),
            warp::http::StatusCode::BAD_REQUEST,
        )),
    };
    match blockchain.get_storage().get_fcm_entry(node_id).filter(|e| !e.token.is_empty() || e.endpoint.is_some()) {
        Some(e) => Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({
                "success": true, "token": e.token, "push_type": e.push_type,
                "endpoint": e.endpoint.unwrap_or_default(), "ts": e.updated_at, "seq": e.seq,
                "writer": e.writer,
            })),
            warp::http::StatusCode::OK,
        )),
        None => Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"success": false, "error": "not_found"})),
            warp::http::StatusCode::OK,
        )),
    }
}

/// The internal genesis-to-genesis endpoints answer only the other genesis nodes (U16). Not loopback: a
/// request through this host's TLS terminator is its client (the X-Forwarded-For the terminator
/// appends), and one that arrives as loopback is a terminator that passed no client on, i.e. the public.
pub(super) fn is_genesis_peer_ip(caller_ip: &str) -> bool {
    crate::genesis_constants::GENESIS_NODE_IPS.iter().any(|(ip, _)| *ip == caller_ip)
}

/// Handler: GET /api/v1/internal/light-ping-keys-get?node_id=X
/// Genesis-only: a light node's ping delegation with the identity key it was proven under, so a shard
/// owner that only saw a relay can verify the device. The caller re-checks all of it against the chain.
pub(super) async fn handle_internal_light_ping_keys_get(
    remote_addr: Option<std::net::SocketAddr>,
    params:      std::collections::HashMap<String, String>,
    blockchain:  Arc<BlockchainNode>,
) -> Result<impl warp::Reply, warp::Rejection> {
    let caller_ip = remote_addr.map(|a| a.ip().to_string()).unwrap_or_default();
    if !is_genesis_peer_ip(&caller_ip) {
        return Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"success": false, "error": "Unauthorized"})),
            warp::http::StatusCode::FORBIDDEN,
        ));
    }
    let node_id = params.get("node_id").map(|s| s.as_str()).unwrap_or("");
    let storage = blockchain.get_storage();
    let answer = storage.get_light_binding(node_id).and_then(|b| light_ping_keys_answer(&b));
    Ok(match answer {
        Some(v) => warp::reply::with_status(warp::reply::json(&v), warp::http::StatusCode::OK),
        None => warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"success": false, "error": "not_found"})),
            warp::http::StatusCode::OK,
        ),
    })
}

/// What the identity pull serves of a binding row: a bound device's key, delegation and the identity it
/// was proven under (the sequence rides in the cert, `v2.{seq}.{sig}`; the puller applies it under the
/// binding order), or a withdrawn row's floor with its unbind (the device's, or the wallet key's with
/// `"signer": "wallet"`), which a genesis that missed the unbind re-verifies and takes
/// (`light_unbind::pulled_unbind`). Anything else is not served.
pub(crate) fn light_ping_keys_answer(b: &crate::light_binding::BindingRow) -> Option<serde_json::Value> {
    if b.identity_pubkey.is_empty() { return None; }
    if !b.ping_pubkey.is_empty() && !b.cert.is_empty() {
        return Some(serde_json::json!({
            "success": true, "ping_pubkey": b.ping_pubkey,
            "ping_delegation_cert": b.cert, "identity_pubkey": b.identity_pubkey,
            "seq": b.seq, "floor": b.floor, "v2": b.v2, "bound_at": b.bound_at,
        }));
    }
    let u = b.unbind.as_ref().filter(|_| b.v2 && b.floor > 0)?;
    Some(serde_json::json!({
        "success": true, "ping_pubkey": "", "ping_delegation_cert": "", "identity_pubkey": b.identity_pubkey,
        "seq": 0, "floor": b.floor, "v2": true, "bound_at": 0,
        "unbind": u.to_json(),
    }))
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
    /// v2 (U7): the binding sequence. With it the ping key signs
    /// `{chain_tag}token_refresh:{node_id}:{hex(sha3(push_target))}:{seq}:{timestamp}`, binding the
    /// token itself; without it the legacy preimage, accepted only while the node has no v2 binding.
    #[serde(default)]
    pub(super) seq:          Option<u64>,
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
/// The reference generator the contract KATs check (activation_code_kat_tests); no route calls it.
#[cfg(test)]
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
                // From the tx_target_bound gate a deploy records its block height, and its time is that
                // block's producer-signed timestamp; a contract deployed earlier keeps the tx timestamp.
                // A header point read: rebuilding the body would pull every tx of that block per request.
                let deployed_height = storage.get("deployed_height").and_then(|h| h.parse::<u64>().ok());
                let deployed_at = match deployed_height {
                    Some(h) => blockchain.get_storage().block_timestamp_at(h).ok().flatten()
                        .map(|ts| ts.to_string()).unwrap_or_default(),
                    None => storage.get("deployed_at").cloned().unwrap_or_default(),
                };
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
                        "deployed_at": deployed_at,
                        "deployed_height": deployed_height
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

/// Addresses the genesis block funded. On this network these are the load-test accounts of the
/// 29.08 launch: their keys derive from a public seed and their balances were never minted into
/// total_supply, so a rich list that counted them would show 50,000 holders nobody owns and shares of
/// a supply that excludes them. Read from block 0 itself — every node agrees without an env flag, and
/// a fair-launch genesis funds nobody, which leaves the set empty. Set once, only on a successful read.
static GENESIS_ALLOCATIONS: std::sync::OnceLock<Arc<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
static GENESIS_ALLOCATIONS_LOADING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Blocking read of block 0 (tens of MB with a prefund): call off the async runtime.
fn load_genesis_allocations(storage: &crate::storage::Storage) -> Option<Arc<std::collections::HashSet<String>>> {
    if let Some(set) = GENESIS_ALLOCATIONS.get() { return Some(set.clone()); }
    let block = storage.load_microblock_auto_format(0).ok().flatten()?;
    let set: std::collections::HashSet<String> = block.transactions.iter()
        .filter(|tx| tx.from == "genesis")
        .filter_map(|tx| match &tx.tx_type {
            qnet_state::TransactionType::Transfer { to, .. } => Some(to.clone()),
            _ => None,
        })
        .collect();
    if is_info() { println!("[INFO][RPC] genesis_allocations_loaded accounts={}", set.len()); }
    Some(GENESIS_ALLOCATIONS.get_or_init(|| Arc::new(set)).clone())
}

/// Non-blocking membership for hot paths: the set when already loaded, otherwise None after starting
/// the one background load.
pub(super) fn genesis_allocations_nowait(storage: Arc<crate::storage::Storage>) -> Option<Arc<std::collections::HashSet<String>>> {
    if let Some(set) = GENESIS_ALLOCATIONS.get() { return Some(set.clone()); }
    if !GENESIS_ALLOCATIONS_LOADING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        tokio::task::spawn_blocking(move || {
            if load_genesis_allocations(&storage).is_none() {
                GENESIS_ALLOCATIONS_LOADING.store(false, std::sync::atomic::Ordering::Release); // retry later
            }
        });
    }
    None
}

/// One rich-list pass without the genesis allocations, reused for RICH_VIEW_TTL.
struct RichView {
    at: std::time::Instant,
    holders: Vec<(String, u64)>,
    alloc_accounts: usize,
    alloc_holding: u64,
    alloc_balance: u64,
}
static RICH_VIEW: std::sync::Mutex<Option<RichView>> = std::sync::Mutex::new(None);
const RICH_VIEW_TTL: std::time::Duration = std::time::Duration::from_secs(30);
const RICH_VIEW_MAX: usize = 500;

/// Point reads over the allocation set plus a skip-scan: bounded by the set, not by the holder count.
fn build_rich_view(storage: &crate::storage::Storage, allocs: &std::collections::HashSet<String>) -> RichView {
    let (mut holding, mut balance) = (0u64, 0u64);
    for addr in allocs {
        if let Some(b) = storage.richlist_balance_of(addr) {
            holding += 1;
            balance = balance.saturating_add(b);
        }
    }
    RichView {
        at: std::time::Instant::now(),
        holders: storage.richlist_top_k_skipping(RICH_VIEW_MAX, allocs).unwrap_or_default(),
        alloc_accounts: allocs.len(),
        alloc_holding: holding,
        alloc_balance: balance,
    }
}

/// GET /api/v1/richlist?limit=N — native QNC rich list served from the apply-time index: top-K holders
/// (balance desc, address asc) + holder count, with NO account scan and NO consensus lock. The genesis
/// allocations are left out of both and reported apart under `genesis_allocations` (`holder_count_all`
/// keeps the raw count). Supply is the AUTHORITATIVE emission watermark (get_total_supply), not a
/// balance re-sum (which would omit unclaimed rewards and contract/pool-held QNC). Rate-limited;
/// percent is balance/circulating. limit clamped 1..=500.
pub(super) async fn handle_qnc_richlist(
    params: std::collections::HashMap<String, String>,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(resp) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(resp);
    }
    let limit = params.get("limit").and_then(|s| s.parse::<usize>().ok()).unwrap_or(100).clamp(1, RICH_VIEW_MAX);

    let storage = blockchain.get_storage();
    let holder_count_all = storage.richlist_holder_count();
    let cached = RICH_VIEW.lock().ok().and_then(|g| g.as_ref()
        .filter(|v| v.at.elapsed() < RICH_VIEW_TTL)
        .map(|v| (v.holders.clone(), v.alloc_accounts, v.alloc_holding, v.alloc_balance)));
    let view = match cached {
        Some(v) => Some(v),
        None => {
            let st = storage.clone();
            tokio::task::spawn_blocking(move || {
                let allocs = load_genesis_allocations(&st)?;
                let v = build_rich_view(&st, &allocs);
                let out = (v.holders.clone(), v.alloc_accounts, v.alloc_holding, v.alloc_balance);
                if let Ok(mut g) = RICH_VIEW.lock() { *g = Some(v); }
                Some(out)
            }).await.ok().flatten()
        }
    };
    // Block 0 not stored here (a snapshot-joined node): the unfiltered list, labelled as such.
    let (holders, holder_count, genesis_allocations) = match view {
        Some((mut hs, accounts, holding, bal)) => {
            hs.truncate(limit);
            (hs, holder_count_all.saturating_sub(holding),
             json!({ "accounts": accounts, "holding": holding, "balance_raw": bal.to_string() }))
        }
        None => (storage.richlist_top_k(limit).unwrap_or_default(), holder_count_all, serde_json::Value::Null),
    };

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
        "holder_count_all": holder_count_all,
        "genesis_allocations": genesis_allocations,
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
    /// Must match QNET_BENCHMARK_SECRET (the `X-Benchmark-Secret` header may carry it instead).
    #[serde(default)]
    pub(super) secret: Option<String>,
}

/// Handle GET /api/v1/benchmark/status (the secret in `X-Benchmark-Secret`; see `benchmark_admit`)
pub(super) async fn handle_benchmark_status(
    secret: Option<String>,
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<impl Reply, Rejection> {
    use crate::benchmark::BENCHMARK_MANAGER;

    if let Some(refused) = benchmark_admit(remote_addr, secret.as_deref(), "status") {
        return Ok(refused);
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

/// Handle GET /api/v1/benchmark/results (the secret in `X-Benchmark-Secret`)
pub(super) async fn handle_benchmark_results(
    secret: Option<String>,
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<impl Reply, Rejection> {
    use crate::benchmark::BENCHMARK_MANAGER;

    if let Some(refused) = benchmark_admit(remote_addr, secret.as_deref(), "results") {
        return Ok(refused);
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

/// Handle POST /api/v1/benchmark/stop (the secret in `X-Benchmark-Secret`)
pub(super) async fn handle_benchmark_stop(
    secret: Option<String>,
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<impl Reply, Rejection> {
    use crate::benchmark::BENCHMARK_MANAGER;

    if let Some(refused) = benchmark_admit(remote_addr, secret.as_deref(), "stop") {
        return Ok(refused);
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

/// Handle GET /api/v1/benchmark/presets (the secret in `X-Benchmark-Secret`)
pub(super) async fn handle_benchmark_presets(
    secret: Option<String>,
    remote_addr: Option<std::net::SocketAddr>,
) -> Result<impl Reply, Rejection> {
    if let Some(refused) = benchmark_admit(remote_addr, secret.as_deref(), "presets") {
        return Ok(refused);
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

#[cfg(test)]
mod internal_call_tests {
    use super::*;

    /// NB-3 / ND-3: a genesis-to-genesis call retried in plain HTTP after ANY failure over TLS, so anyone on the
    /// path downgraded it by breaking the handshake. Only a connection that could not be made may retry; a
    /// TLS failure never does (and the TLS-only routes never retry at all).
    #[tokio::test]
    async fn only_a_failed_connection_may_retry_in_plain_http() {
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(5)).build().expect("client");
        let refused_port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            l.local_addr().expect("addr").port()
        };
        let e = client.get(format!("https://127.0.0.1:{}/", refused_port)).send().await.expect_err("nothing listens");
        assert!(plain_fallback_allowed(&e), "a refused connection may retry: {:?}", e);

        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = l.local_addr().expect("addr").port();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            while let Ok((mut s, _)) = l.accept().await {
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
        });
        let e = client.get(format!("https://127.0.0.1:{}/", port)).send().await.expect_err("not TLS");
        assert!(!plain_fallback_allowed(&e), "a TLS failure never retries in clear: {:?}", e);
    }

    /// NB-3: a pulled push record stamped in the future pinned the channel (every later refresh read as
    /// older); it is refused, and one stamped now is taken.
    #[test]
    fn a_pulled_push_record_from_the_future_is_refused() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let s = crate::storage::Storage::new(dir.path().to_str().unwrap()).expect("storage");
        let node = "light_mobile_nb3pull";
        let now = crate::light_device::now_secs();
        assert!(!apply_pulled_push_record(&s, None, node, "tok_forged", "fcm", None, u64::MAX, 0, ""));
        assert!(!apply_pulled_push_record(&s, None, node, "tok_forged", "fcm", None, now + 3_600, 0, ""));
        assert!(apply_pulled_push_record(&s, None, node, "tok_real", "fcm", None, now, 0, ""));
        assert_eq!(s.get_fcm_entry(node).map(|e| e.token), Some("tok_real".to_string()));
    }

    /// L-1: a push record without a proof (trusted by its sender's address alone) and an unbind cross between the
    /// genesis nodes over TLS only; only a record carrying the device's signatures may still retry in plain HTTP.
    #[test]
    fn the_token_and_unbind_syncs_never_send_an_unproven_record_in_clear() {
        let src = include_str!("misc_api.rs");
        let sync = &src[src.find("pub(super) async fn sync_fcm_token_to_genesis_peers(").unwrap()..];
        let sync = &sync[..sync.find("pub(super) async fn handle_internal_fcm_token_sync(").unwrap()];
        let proven = sync.find("if body_ref.proof.is_some() {").expect("the proof decides");
        let plain = sync.find("genesis_internal_call(ip, SYNC_PATH").expect("the v2 path");
        let tls = sync.find("genesis_internal_call_tls(ip, SYNC_PATH").expect("the TLS-only path");
        assert!(proven < plain && plain < tls);
        assert_eq!(sync.matches("genesis_internal_call(").count(), 1, "one call site, behind the proof");
        assert_eq!(sync.matches("send(").count(), 2, "both rounds go through it");
        let unbind = include_str!("light_unbind.rs");
        let unbind = &unbind[unbind.find("pub(super) async fn sync_unbind_to_genesis_peers(").unwrap()..];
        let unbind = &unbind[..unbind.find("\n}\n").unwrap()];
        assert!(unbind.contains("genesis_internal_call_tls(ip, PATH") && !unbind.contains("genesis_internal_call(ip"));
    }
}

#[cfg(test)]
mod activation_code_kat_tests {
    use super::*;

    /// PX-03: qnet-link-v1 names this generator the reference for the activation code, with KATs in its
    /// vectors; nothing held the generator or the stateless decoder to them. Both KATs (the burner's Solana
    /// address, the wallet's own address) reproduce here, decode to their address, and refuse another.
    #[tokio::test]
    async fn the_activation_code_matches_the_contract_kats() {
        let v: Value = serde_json::from_str(include_str!("../../../../docs/protocols/qnet-link-v1.vectors.json"))
            .expect("vectors parse");
        for (kat, addr_key) in [("activationCodeKat", "solanaAddress"), ("walletActivationCodeKat", "qnetAddress")] {
            let k = &v[kat];
            let (addr, burn_tx) = (k[addr_key].as_str().unwrap(), k["burnTx"].as_str().unwrap());
            let amount = k["burnAmount"].as_u64().unwrap();
            let req = GenerateActivationCodeRequest {
                wallet_address: addr.to_string(), burn_tx_hash: burn_tx.to_string(),
                node_type: k["nodeType"].as_str().unwrap().to_string(), burn_amount: amount,
            };
            let code = generate_quantum_activation_code(&req).await.expect("code");
            assert_eq!(code, k["code"].as_str().unwrap(), "{kat}");
            let registry = &*GLOBAL_ACTIVATION_REGISTRY;
            assert!(matches!(registry.verify_code_ownership_stateless(&code, addr, burn_tx, amount), Ok(true)), "{kat}");
            let mut other = addr.as_bytes().to_vec();
            other[0] = if other[0] == b'1' { b'2' } else { b'1' };
            let other = String::from_utf8(other).unwrap();
            assert!(matches!(registry.verify_code_ownership_stateless(&code, &other, burn_tx, amount), Ok(false)), "{kat}");
        }
    }
}

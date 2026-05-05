//! Genesis node constants - centralized to avoid duplication

/// Genesis bootstrap activation codes (PRODUCTION)
/// These are the ONLY 5 codes that can bootstrap the QNet blockchain
/// Security: codes are protected by IP whitelist + wallet binding + Dilithium3 signature,
/// so the sequential pattern is not a vulnerability.
pub const GENESIS_BOOTSTRAP_CODES: &[&str] = &[
    "QNET-BOOT-0001-STRAP",
    "QNET-BOOT-0002-STRAP",
    "QNET-BOOT-0003-STRAP",
    "QNET-BOOT-0004-STRAP",
    "QNET-BOOT-0005-STRAP",
];

/// Genesis node wallet addresses (PRODUCTION)
/// These are the predefined wallet addresses for Genesis nodes
/// Format: 19 hex + "eon" + 15 hex + 8 hex SHA3-256 checksum = 45 chars
/// v4.1: Updated to 45-char format with 8-hex (4-byte) SHA3-256 checksum
pub const GENESIS_WALLETS: &[(&str, &str)] = &[
    ("001", "f36ff465a0944fd06cdeonfca0ad004ff9db42e16dbab"), // Genesis Node #1
    ("002", "0bac6225a082de1f659eond0c96f1706cf19cc7abf70a"), // Genesis Node #2
    ("003", "d216bb23fbe7f853636eon3f16b378b919227e009fb4f"), // Genesis Node #3
    ("004", "e5bffcbe8d8cc90afa1eond9c4c2a4e75101e25dc1113"), // Genesis Node #4
    ("005", "02af45d56bd1f5d9002eon0eb1c522f96a2f42dfb74cb"), // Genesis Node #5
];

/// Genesis node IP addresses (PRODUCTION)
/// These IPs are authorized to run Genesis nodes
pub const GENESIS_NODE_IPS: &[(&str, &str)] = &[
    ("154.38.160.39", "001"),    // Genesis Node #1 - North America
    ("62.171.157.44", "002"),    // Genesis Node #2 - Europe
    ("161.97.86.81", "003"),     // Genesis Node #3 - Europe  
    ("5.189.130.160", "004"),  // Genesis Node #4 - Europe
    ("162.244.25.114", "005"),   // Genesis Node #5 - Europe
];

/// Legacy genesis node IDs (backward compatibility)
pub const LEGACY_GENESIS_NODES: &[&str] = &[
    "genesis_node_1", 
    "genesis_node_2", 
    "genesis_node_3", 
    "genesis_node_4", 
    "genesis_node_5"
];

/// Check if given activation code is a Genesis bootstrap code
pub fn is_genesis_bootstrap_code(code: &str) -> bool {
    GENESIS_BOOTSTRAP_CODES.contains(&code)
}

/// Check if given node ID is a legacy Genesis node
pub fn is_legacy_genesis_node(node_id: &str) -> bool {
    LEGACY_GENESIS_NODES.contains(&node_id)
}

/// v14.7: Count of genesis validators — hard floor for quorum computation
/// when the live validator set cache is empty (cold-start / pre-handshake).
/// Every genesis node appears in `LEGACY_GENESIS_NODES`.
pub fn genesis_node_count() -> usize {
    LEGACY_GENESIS_NODES.len()
}

/// Get Genesis node IP by bootstrap ID (001-005)
pub fn get_genesis_ip_by_id(bootstrap_id: &str) -> Option<&'static str> {
    for (ip, id) in GENESIS_NODE_IPS {
        if id == &bootstrap_id {
            return Some(ip);
        }
    }
    None
}

/// Get Genesis bootstrap ID by IP address  
pub fn get_genesis_id_by_ip(ip: &str) -> Option<&'static str> {
    for (genesis_ip, id) in GENESIS_NODE_IPS {
        if genesis_ip == &ip {
            return Some(id);
        }
    }
    None
}

/// Get Genesis node region by IP address using EXISTING constants and comments
pub fn get_genesis_region_by_ip(ip: &str) -> Option<&'static str> {
    // EXISTING: Use GENESIS_NODE_IPS mapping with regions from production deployment comments
    match ip {
        "154.38.160.39" => Some("NorthAmerica"), // Genesis Node #1 - North America (from comments)
        "62.171.157.44" => Some("Europe"),       // Genesis Node #2 - Europe (from comments)
        "161.97.86.81" => Some("Europe"),        // Genesis Node #3 - Europe (from comments)
        "5.189.130.160" => Some("Europe"),     // Genesis Node #4 - Europe (from comments)
        "162.244.25.114" => Some("Europe"),      // Genesis Node #5 - Europe (CORRECTED)
        _ => None,
    }
}

/// Get all genesis node IPs as a Vec<String>.
/// Used by genesis_config and sync_manager for HTTP fallback.
pub fn get_genesis_ips() -> Vec<String> {
    GENESIS_NODE_IPS.iter().map(|(ip, _)| ip.to_string()).collect()
}

/// Get Genesis wallet address by bootstrap ID (001-005)
pub fn get_genesis_wallet_by_id(bootstrap_id: &str) -> Option<&'static str> {
    for (id, wallet) in GENESIS_WALLETS {
        if id == &bootstrap_id {
            return Some(wallet);
        }
    }
    None
}


// =========================================================================
// v4.0: VRF Public Key Registry for producer verification
// Maps node_id → Dilithium3 public key (hex)
// Populated during node registration, used for VRF proof verification
// =========================================================================

use std::collections::HashMap;

lazy_static::lazy_static! {
    /// Global registry: node_id → dilithium3_pk_hex
    /// Thread-safe, updated on node registration
    pub static ref VRF_PK_REGISTRY: parking_lot::RwLock<HashMap<String, Vec<u8>>> =
        parking_lot::RwLock::new(HashMap::new());
}

/// FIX L-G1: Maximum VRF registry size to prevent unbounded growth
const MAX_VRF_REGISTRY_SIZE: usize = 50_000;

/// Register a node's VRF public key
pub fn register_vrf_public_key(node_id: &str, pk_bytes: &[u8]) {
    if pk_bytes.len() != 1952 {
        println!("[WARN][VRF_REG] invalid pk_size={} node={}", pk_bytes.len(), node_id);
        return;
    }
    // PRODUCTION: Single write lock to eliminate TOCTOU race condition
    let mut registry = VRF_PK_REGISTRY.write();
    if registry.len() >= MAX_VRF_REGISTRY_SIZE && !registry.contains_key(node_id) {
        println!("[WARN][VRF_REG] registry_full size={}", registry.len());
        return;
    }
    registry.insert(node_id.to_string(), pk_bytes.to_vec());
    println!("[INFO][VRF_REG] pk_registered node={} total={}", node_id, registry.len());
}

/// Get a node's VRF public key for proof verification
pub fn get_vrf_public_key(node_id: &str) -> Option<Vec<u8>> {
    VRF_PK_REGISTRY.read().get(node_id).cloned()
}

/// Check if node has registered VRF key
pub fn has_vrf_key(node_id: &str) -> bool {
    VRF_PK_REGISTRY.read().contains_key(node_id)
}

/// Get all registered VRF public keys (for full election verification)
pub fn get_all_vrf_keys() -> HashMap<String, Vec<u8>> {
    VRF_PK_REGISTRY.read().clone()
}

// =========================================================================
// v16.1: GENESIS DILITHIUM ANCHOR LOADER (chain-anchored identity binding)
// =========================================================================
//
// Identity-key binding for the 5 genesis bootstrap nodes is anchored at boot
// time from a JSON file shipped with the deployment. Once installed via
// `consensus_crypto::set_genesis_anchor_pks`, the anchor map is immutable and
// guards every subsequent registration: any PK that does not match the anchor
// is rejected as a squat attempt.
//
// File format (`/app/data/genesis_anchors.json`):
//   { "genesis_node_001": "<hex_1952_bytes>", ... "genesis_node_005": "..." }
//
// Operator workflow:
//   1. On a clean cluster, every bootstrap node generates its own keypair
//      (lazy, on first start) under `/app/data/keys/dilithium_keypair.bin`.
//   2. Operator collects each node's PK (hex from `pk_hash` log or RPC) and
//      writes them all into ONE JSON file deployed to every node BEFORE the
//      first restart that loads anchors.
//   3. Subsequent restarts read the file and install anchors at startup,
//      BEFORE P2P comes online — closes the trust-on-first-verify race that
//      caused the v15.x pk_mismatch deadlock.
//
// Operational property: keypair files MUST be backed up. If a node's
// `dilithium_keypair.bin` is lost while the anchor map still binds the old
// PK, the node refuses to start (via `initialize_wallet_identity`'s strict
// guard) — operator must restore from backup.
//
// Scalability: anchors are bounded to the 5 genesis identities. For
// thousands of super-node operators, identity-key binding is established via
// signed `NodeRegistration` transactions (already implemented at
// `cache_node_registrations_from_transactions_with_dashmap`), which carry
// `dilithium_public_key` in TX payload and feed `register_consensus_pk_from_chain`.
// =========================================================================

/// Default location of the genesis anchors JSON file inside the container.
pub const GENESIS_ANCHORS_PATH: &str = "/app/data/genesis_anchors.json";

/// Load genesis Dilithium3 anchor PKs from `path`. Returns empty map if file
/// missing or malformed (logged as WARN, not fatal — boot proceeds without
/// anchors so a fresh cluster can complete first-time keygen + anchor write).
///
/// Format: JSON object `{ node_id: pk_hex_1952_bytes }`. Each PK MUST decode
/// to exactly 1952 bytes; invalid entries are skipped with WARN.
pub fn load_genesis_anchor_pks_from_file(path: &str) -> HashMap<String, Vec<u8>> {
    use std::fs;
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => {
            // Not present is normal for first cluster boot — operator writes
            // the file after collecting PKs. Don't WARN at this stage.
            return HashMap::new();
        }
    };

    let parsed: HashMap<String, String> = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[WARN][GENESIS] anchors_parse_fail path={} err={}", path, e);
            return HashMap::new();
        }
    };

    let mut out = HashMap::with_capacity(parsed.len());
    for (node_id, pk_hex) in parsed {
        match hex::decode(&pk_hex) {
            Ok(bytes) if bytes.len() == 1952 => {
                out.insert(node_id, bytes);
            }
            Ok(bytes) => {
                eprintln!(
                    "[WARN][GENESIS] anchor_invalid_size node={} got={} expected=1952",
                    node_id, bytes.len()
                );
            }
            Err(e) => {
                eprintln!("[WARN][GENESIS] anchor_hex_decode_fail node={} err={}", node_id, e);
            }
        }
    }
    out
}

/// One-shot startup hook: load anchors from default path and install into
/// the consensus-layer registry. Idempotent — second call is a no-op once
/// the consensus layer has installed a non-empty anchor map.
///
/// Returns the count of anchors installed (0 if file missing — caller may
/// proceed without anchors during first-cluster keygen, then call again
/// after the file is written by operator).
///
/// MUST be called BEFORE any P2P traffic is accepted (specifically, before
/// the first `VrfLeaderClaim` or `VrfKeyAnnounce` could trigger
/// `register_consensus_pk_from_chain` in a TOFV path).
pub fn install_genesis_anchors_at_startup() -> usize {
    let map = load_genesis_anchor_pks_from_file(GENESIS_ANCHORS_PATH);
    if map.is_empty() {
        // First-boot path: no anchor file yet. Caller logs the appropriate
        // INFO; we return 0 so caller can decide whether to fail or proceed.
        return 0;
    }
    let count = map.len();
    let installed = qnet_consensus::consensus_crypto::set_genesis_anchor_pks(map);
    if installed {
        println!("[INFO][GENESIS] anchors_installed count={} src={}", count, GENESIS_ANCHORS_PATH);
        count
    } else {
        // Already installed (immutable). Treat as success, but log so an
        // operator restart with a different file is visible.
        println!("[INFO][GENESIS] anchors_already_installed count={}", count);
        count
    }
}

/// Lookup the anchored PK for a given genesis node_id. Returns None if no
/// anchor map is installed, or if the node_id is not a genesis identity.
pub fn get_genesis_anchor_pk(node_id: &str) -> Option<Vec<u8>> {
    qnet_consensus::consensus_crypto::get_consensus_pk_anchor(node_id)
}


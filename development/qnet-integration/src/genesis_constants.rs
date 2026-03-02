//! Genesis node constants - centralized to avoid duplication

/// Genesis bootstrap activation codes (PRODUCTION)
/// These are the ONLY 5 codes that can bootstrap the QNet blockchain
pub const GENESIS_BOOTSTRAP_CODES: &[&str] = &[
    "QNET-BOOT-0001-STRAP",
    "QNET-BOOT-0002-STRAP", 
    "QNET-BOOT-0003-STRAP",
    "QNET-BOOT-0004-STRAP",
    "QNET-BOOT-0005-STRAP",
];

/// Genesis node wallet addresses (PRODUCTION)
/// These are the predefined wallet addresses for Genesis nodes
/// Format: 19 hex + "eon" + 15 hex + 4 hex checksum = 41 chars
/// v2.66: Updated to use proper Ed25519 public keys (was SHA256, now curve25519)
pub const GENESIS_WALLETS: &[(&str, &str)] = &[
    ("001", "f36ff465a0944fd06cdeonfca0ad004ff9db46743"), // Genesis Node #1
    ("002", "0bac6225a082de1f659eond0c96f1706cf19c35eb"), // Genesis Node #2  
    ("003", "d216bb23fbe7f853636eon3f16b378b91922701a6"), // Genesis Node #3
    ("004", "e5bffcbe8d8cc90afa1eond9c4c2a4e75101ead2e"), // Genesis Node #4
    ("005", "02af45d56bd1f5d9002eon0eb1c522f96a2f440b8"), // Genesis Node #5
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
use std::sync::RwLock;

lazy_static::lazy_static! {
    /// Global registry: node_id → dilithium3_pk_hex
    /// Thread-safe, updated on node registration
    pub static ref VRF_PK_REGISTRY: RwLock<HashMap<String, Vec<u8>>> =
        RwLock::new(HashMap::new());
}

/// Register a node's VRF public key
pub fn register_vrf_public_key(node_id: &str, pk_bytes: &[u8]) {
    if pk_bytes.len() != 1952 {
        println!("[WARN][VRF_REG] invalid pk_size={} node={}", pk_bytes.len(), node_id);
        return;
    }
    if let Ok(mut registry) = VRF_PK_REGISTRY.write() {
        registry.insert(node_id.to_string(), pk_bytes.to_vec());
        println!("[INFO][VRF_REG] pk_registered node={} total={}", node_id, registry.len());
    }
}

/// Get a node's VRF public key for proof verification
pub fn get_vrf_public_key(node_id: &str) -> Option<Vec<u8>> {
    VRF_PK_REGISTRY.read().ok()?.get(node_id).cloned()
}

/// Check if node has registered VRF key
pub fn has_vrf_key(node_id: &str) -> bool {
    VRF_PK_REGISTRY.read().ok()
        .map(|r| r.contains_key(node_id))
        .unwrap_or(false)
}

/// Get all registered VRF public keys (for full election verification)
pub fn get_all_vrf_keys() -> HashMap<String, Vec<u8>> {
    VRF_PK_REGISTRY.read().ok()
        .map(|r| r.clone())
        .unwrap_or_default()
}


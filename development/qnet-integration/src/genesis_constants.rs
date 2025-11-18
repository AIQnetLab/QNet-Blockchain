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
pub const GENESIS_WALLETS: &[(&str, &str)] = &[
    ("001", "b07408bdc5688b92d69eonfd060d05f246f659414"), // Genesis Node #1
    ("002", "5f7e69d299eb6046af7eonb8e632c67d83a8b96a0"), // Genesis Node #2  
    ("003", "a3d62ef91e60d66d2a2eon2caa0d87cb2a1976f31"), // Genesis Node #3
    ("004", "29e11b0a9cc89296490eoncca66139e40d72bd25d"), // Genesis Node #4
    ("005", "f8c4ed54ad92b0a94f1eonad6cc5623af63b79826"), // Genesis Node #5
];

/// Genesis node IP addresses (PRODUCTION)
/// These IPs are authorized to run Genesis nodes
pub const GENESIS_NODE_IPS: &[(&str, &str)] = &[
    ("154.38.160.39", "001"),    // Genesis Node #1 - North America
    ("62.171.157.44", "002"),    // Genesis Node #2 - Europe
    ("161.97.86.81", "003"),     // Genesis Node #3 - Europe  
    ("173.212.219.226", "004"),  // Genesis Node #4 - Europe
    ("164.68.108.218", "005"),   // Genesis Node #5 - Europe
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
        "173.212.219.226" => Some("Europe"),     // Genesis Node #4 - Europe (from comments)
        "164.68.108.218" => Some("Europe"),      // Genesis Node #5 - Europe (CORRECTED)
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

/// SECURITY: System public key for verifying emission and claim transactions
/// This is generated during first Genesis node startup and MUST be updated here
/// CRITICAL: This key authenticates ALL system_emission and reward claims
/// PRODUCTION: Replace placeholder after initial Genesis deployment
pub const SYSTEM_DILITHIUM_PUBLIC_KEY_HEX: &str = 
    "PLACEHOLDER_GENESIS_DEPLOYMENT_WILL_GENERATE_REAL_KEY";

/// Verify if a transaction signature is from the system key
/// Used by all nodes to validate emission and claim transactions
pub fn is_valid_system_signature(message: &[u8], signature_hex: &str) -> bool {
    // PLACEHOLDER: During initial deployment, accept all system signatures
    // PRODUCTION: After Genesis, this will verify against real system public key
    if SYSTEM_DILITHIUM_PUBLIC_KEY_HEX == "PLACEHOLDER_GENESIS_DEPLOYMENT_WILL_GENERATE_REAL_KEY" {
        println!("[SECURITY] ⚠️ Using placeholder system key - Genesis deployment mode");
        return true;
    }
    
    // PRODUCTION: Verify Dilithium signature
    use pqcrypto_dilithium::dilithium3;
    use pqcrypto_traits::sign::{PublicKey as PQPublicKeyTrait, SignedMessage as PQSignedMessageTrait};
    
    // Decode public key and signature
    let pk_bytes = match hex::decode(SYSTEM_DILITHIUM_PUBLIC_KEY_HEX) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    
    let sig_bytes = match hex::decode(signature_hex) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    
    // Parse Dilithium3 public key
    let public_key = match dilithium3::PublicKey::from_bytes(&pk_bytes) {
        Ok(pk) => pk,
        Err(_) => return false,
    };
    
    // Parse signed message (signature + message concatenated)
    let signed_message = match dilithium3::SignedMessage::from_bytes(&sig_bytes) {
        Ok(sm) => sm,
        Err(_) => return false,
    };
    
    // Verify signature
    match dilithium3::open(&signed_message, &public_key) {
        Ok(verified_msg) => verified_msg == message,
        Err(_) => false,
    }
}


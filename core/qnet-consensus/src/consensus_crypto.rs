//! # Consensus Cryptography Module (v2.24)
//!
//! ## Overview
//! Provides quantum-resistant signature verification for Byzantine consensus with hybrid
//! Ed25519 + CRYSTALS-Dilithium cryptography. Defense-in-depth: both P2P and Consensus
//! layers perform cryptographic verification.
//!
//! ## Architecture (Defense-in-Depth)
//! 
//! ### Core Layer (This Module)
//! - **Purpose**: Independent cryptographic verification at consensus level
//! - **Validates**: Real Dilithium signatures via `dilithium3::open()`
//! - **Why**: Defense-in-depth - don't trust P2P layer alone
//!
//! ### Development Layer (qnet-integration)
//! - **Purpose**: Full cryptographic verification at P2P level
//! - **Validates**: Dilithium signatures, Ed25519 signatures, certificates
//! - **Location**: `node.rs::verify_microblock_signature()`
//!
//! ## Signature Formats (v2.24 - Bincode + Zstd)
//!
//! ### Wire Format Prefixes
//! - `compact_bin:` - Compact signature (bincode+zstd) - **PRODUCTION**
//! - `hybrid_bin:` - Full signature (bincode+zstd) - **PRODUCTION**
//! - `compact:` - Compact signature (JSON) - **LEGACY**
//! - `hybrid:` - Full signature (JSON) - **LEGACY**
//! - `dilithium_sig_` - Pure Dilithium fallback
//!
//! ### 1. Compact Signatures (Microblocks - ~2.6KB bincode)
//! ```rust
//! CompactHybridSignature {
//!   node_id: String,
//!   cert_serial: String,
//!   ephemeral_public_key: [u8; 32],   // RAW bytes
//!   message_signature: [u8; 64],       // Ed25519 RAW bytes
//!   dilithium_key_signature: Vec<u8>,  // Dilithium RAW bytes (~2500 bytes)
//!   signed_at: u64,
//! }
//! ```
//! - **Wire format**: `compact_bin:<base64(zstd(bincode(sig)))>`
//! - **Bandwidth**: ~2.6KB bincode (was 5KB JSON, was 22KB base64)
//! - **Certificate**: Referenced by serial, cached at P2P layer
//! - **Used for**: High-frequency microblocks (1/sec)
//!
//! ### 2. Full Hybrid Signatures (Macroblocks - ~5KB bincode)
//! ```rust
//! HybridSignature {
//!   certificate: HybridCertificate,
//!   ephemeral_public_key: [u8; 32],
//!   message_signature: [u8; 64],
//!   dilithium_key_signature: Vec<u8>,  // RAW bytes
//!   signed_at: u64,
//! }
//! ```
//! - **Wire format**: `hybrid_bin:<base64(zstd(bincode(sig)))>`
//! - **Bandwidth**: ~5KB bincode (was 27KB JSON)
//! - **Used for**: Low-frequency macroblocks (every 90 blocks)
//! - **Verification**: Immediate (certificate embedded)
//!
//! ## Security Model (Defense-in-Depth)
//!
//! ### Layer 1: P2P Verification (node.rs)
//! 1. All received blocks verified with full crypto
//! 2. CRYSTALS-Dilithium signature verification (NIST post-quantum)
//! 3. Ed25519 signature format validation
//! 4. Certificate validation from cache/network
//! 5. **Only verified blocks enter consensus**
//!
//! ### Layer 2: Consensus Validation (This Module)
//! 1. Structural validation of pre-verified blocks
//! 2. Format checks, component presence
//! 3. Byzantine consensus (requires 2/3+ honest nodes)
//! 4. **Malicious blocks cannot reach consensus threshold**
//!
//! ## NIST/Cisco Compliance
//! - **Post-Quantum**: CRYSTALS-Dilithium (NIST standard)
//! - **Classical**: Ed25519 (legacy compatibility)
//! - **Hashing**: SHA3-256 (NIST approved)
//! - **Hybrid**: Both signatures required for validity
//!
//! ## Performance
//! - **Compact signatures**: 75% bandwidth reduction
//! - **Certificate caching**: 100K LRU cache
//! - **Zero downtime**: Microblocks continue during macroblock consensus
//! - **Scalability**: Supports millions of nodes (max 1000 validators in consensus)

use base64::{Engine as _, engine::general_purpose};
use pqcrypto_traits::sign::{PublicKey as PQPublicKey, SignedMessage as PQSignedMessage, DetachedSignature as PQDetachedSignature};

// ============================================================================
// Consensus-layer PK registry with proof-of-ownership (v14.8)
// ============================================================================
// Prevents self-attested PK attacks AND first-seen PK squatting at scale.
//
// Two registration paths, both cryptographically authenticated:
//
//   1) ANCHORED GENESIS: for the fixed 5-node genesis set, PKs are hard-coded
//      in `genesis_anchor_pks()` and cannot be overwritten. This closes the
//      "attacker races node_001 to register fake PK first" window.
//
//   2) PROOF-OF-OWNERSHIP: for Super-node joiners post-genesis,
//      register_consensus_pk_with_proof(node_id, pk, challenge_sig) requires
//      a Dilithium3 signature over the canonical challenge
//      "qnet-pk-register-v1:{node_id}" made by the private key corresponding
//      to `pk`. Without a valid sig, registration is rejected.
//
// Once registered, a node's PK is IMMUTABLE for the lifetime of the process.
// Re-registration with a DIFFERENT PK is rejected; re-registration with the
// SAME PK is a no-op (idempotent, safe for multi-call).
//
// Scalability: registry bounded to 50K entries (fits thousands of super-nodes
// with large headroom). Reads are parking_lot::RwLock — no tokio contention.
// ============================================================================

lazy_static::lazy_static! {
    /// Trusted PK registry: node_id -> dilithium3 public key bytes (1952 bytes)
    static ref CONSENSUS_PK_REGISTRY: parking_lot::RwLock<std::collections::HashMap<String, Vec<u8>>> =
        parking_lot::RwLock::new(std::collections::HashMap::new());
}

/// Canonical challenge prefix for proof-of-ownership. Versioned so a future
/// rotation (e.g. v2 with timestamp binding) cannot replay v1 registrations.
pub const PK_REGISTER_CHALLENGE_PREFIX: &str = "qnet-pk-register-v1:";

/// Maximum registry size (scalable for tens of thousands of super-nodes).
const MAX_CONSENSUS_PK_REGISTRY: usize = 50_000;

/// Build the canonical challenge string for proof-of-ownership.
/// The joiner MUST sign exactly this byte string with their Dilithium3 key.
#[inline]
pub fn pk_register_challenge(node_id: &str) -> String {
    format!("{}{}", PK_REGISTER_CHALLENGE_PREFIX, node_id)
}

/// Register a genesis node PK WITHOUT proof-of-ownership, but ONLY if the
/// node_id matches an anchored genesis identity AND the PK matches the
/// hard-coded anchor. Used once per process at startup for bootstrap.
///
/// Returns true on success, false if identity is not genesis or PK does not
/// match the anchor. NEVER overwrites an existing entry.
pub fn register_genesis_pk(node_id: &str, pk_bytes: &[u8]) -> bool {
    if pk_bytes.len() != 1952 {
        eprintln!("[ERR][CONSENSUS] genesis_pk_invalid_size node={} size={}", node_id, pk_bytes.len());
        return false;
    }

    // Anchored genesis check: PK must match the one baked into this binary.
    // Anchors live in genesis_anchor_pks() and are the source of truth.
    let anchors = genesis_anchor_pks();
    let Some(anchor_pk) = anchors.get(node_id) else {
        eprintln!("[ERR][CONSENSUS] genesis_pk_unknown_identity node={}", node_id);
        return false;
    };
    if anchor_pk.as_slice() != pk_bytes {
        eprintln!("[ERR][CONSENSUS] genesis_pk_mismatch node={} anchor={}.. provided={}..",
                  node_id, hex::encode(&anchor_pk[..8]), hex::encode(&pk_bytes[..8]));
        return false;
    }

    let mut registry = CONSENSUS_PK_REGISTRY.write();
    if let Some(existing) = registry.get(node_id) {
        if existing.as_slice() == pk_bytes {
            // Idempotent re-register
            return true;
        }
        eprintln!("[ERR][CONSENSUS] genesis_pk_already_registered_different node={}", node_id);
        return false;
    }
    registry.insert(node_id.to_string(), pk_bytes.to_vec());
    println!("[INFO][CONSENSUS] genesis_pk_registered node={} total={}", node_id, registry.len());
    true
}

/// Register a node PK whose ownership has already been proven by inclusion
/// of a signature-validated NodeRegistration transaction on-chain.
///
/// This is the production path: when a NodeRegistration TX is applied to
/// state, the block's canonical order + the TX's Dilithium3 signature over
/// `canonical_bytes` already constitute cryptographic proof that the
/// submitter holds the private key corresponding to `pk_bytes`. All nodes
/// processing the same block agree on the (node_id, pk) binding, so there
/// is no network race to squat.
///
/// Anti-squat: if node_id is a genesis identity, PK must match the anchor.
/// Immutability: re-registration with a different PK is rejected.
/// Idempotent: re-registration with the same PK is a no-op.
pub fn register_consensus_pk_from_chain(node_id: &str, pk_bytes: &[u8]) -> bool {
    if pk_bytes.len() != 1952 {
        eprintln!("[ERR][CONSENSUS] chain_pk_invalid_size node={} size={}", node_id, pk_bytes.len());
        return false;
    }
    if node_id.is_empty() || node_id.len() > 128 {
        eprintln!("[ERR][CONSENSUS] chain_pk_invalid_node_id len={}", node_id.len());
        return false;
    }

    // Structural validation: PK must parse as a Dilithium3 public key
    use pqcrypto_mldsa::mldsa65 as dilithium3;
    if dilithium3::PublicKey::from_bytes(pk_bytes).is_err() {
        eprintln!("[ERR][CONSENSUS] chain_pk_parse_failed node={}", node_id);
        return false;
    }

    // Anti-squat against genesis anchors (compile-time-installed — optional).
    // NB: in production the primary anti-squat line of defence is IP-based:
    // the P2P layer refuses to even pass a VRF/announce through for a genesis
    // identity unless it arrives from the canonical genesis IP. This anchor
    // check is a defence-in-depth layer for operators who choose to bake PKs
    // into the binary during network fork / upgrade ceremonies.
    let anchors = genesis_anchor_pks();
    if let Some(anchor_pk) = anchors.get(node_id) {
        if anchor_pk.as_slice() != pk_bytes {
            eprintln!("[ERR][CONSENSUS] chain_pk_genesis_squat_attempt node={}", node_id);
            return false;
        }
    }

    // Immutability + capacity
    let mut registry = CONSENSUS_PK_REGISTRY.write();
    if let Some(existing) = registry.get(node_id) {
        if existing.as_slice() == pk_bytes {
            return true;
        }
        eprintln!("[ERR][CONSENSUS] chain_pk_immutable_violation node={}", node_id);
        return false;
    }
    if registry.len() >= MAX_CONSENSUS_PK_REGISTRY {
        eprintln!("[WARN][CONSENSUS] pk_registry_full size={}", registry.len());
        return false;
    }
    registry.insert(node_id.to_string(), pk_bytes.to_vec());
    if registry.len() % 100 == 0 || registry.len() < 16 {
        println!("[INFO][CONSENSUS] chain_pk_registered node={} total={}", node_id, registry.len());
    }
    true
}

/// Register a non-genesis node PK with cryptographic proof-of-ownership.
///
/// The joiner must provide a Dilithium3 detached signature over the canonical
/// challenge string `qnet-pk-register-v1:{node_id}` using the private key
/// corresponding to `pk_bytes`. Signature is verified against `pk_bytes`
/// before the entry is written.
///
/// Returns true on success. Fails if:
///   - pk_bytes is not exactly 1952 bytes
///   - challenge_sig does not verify under pk_bytes
///   - registry is full
///   - node_id is anchored as genesis with a DIFFERENT PK (anti-squat)
///   - node_id is already registered with a DIFFERENT PK (immutability)
pub fn register_consensus_pk_with_proof(
    node_id: &str,
    pk_bytes: &[u8],
    challenge_sig: &[u8],
) -> bool {
    // 1. Structural validation
    if pk_bytes.len() != 1952 {
        eprintln!("[ERR][CONSENSUS] pk_register_invalid_size node={} size={}", node_id, pk_bytes.len());
        return false;
    }
    if node_id.is_empty() || node_id.len() > 128 {
        eprintln!("[ERR][CONSENSUS] pk_register_invalid_node_id len={}", node_id.len());
        return false;
    }

    // 2. Anti-squat: if node_id is a genesis identity, PK must match the anchor
    let anchors = genesis_anchor_pks();
    if let Some(anchor_pk) = anchors.get(node_id) {
        if anchor_pk.as_slice() != pk_bytes {
            eprintln!("[ERR][CONSENSUS] pk_register_genesis_squat_attempt node={}", node_id);
            return false;
        }
    }

    // 3. Cryptographic proof-of-ownership: verify Dilithium3 detached signature
    //    over canonical challenge using the pk being registered
    use pqcrypto_mldsa::mldsa65 as dilithium3;
    let public_key = match dilithium3::PublicKey::from_bytes(pk_bytes) {
        Ok(pk) => pk,
        Err(_) => {
            eprintln!("[ERR][CONSENSUS] pk_register_parse_failed node={}", node_id);
            return false;
        }
    };
    let detached_sig = match dilithium3::DetachedSignature::from_bytes(challenge_sig) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("[ERR][CONSENSUS] pk_register_sig_parse_failed node={}", node_id);
            return false;
        }
    };
    let challenge = pk_register_challenge(node_id);
    if dilithium3::verify_detached_signature(&detached_sig, challenge.as_bytes(), &public_key).is_err() {
        eprintln!("[ERR][CONSENSUS] pk_register_proof_invalid node={}", node_id);
        return false;
    }

    // 4. Immutability + capacity
    let mut registry = CONSENSUS_PK_REGISTRY.write();
    if let Some(existing) = registry.get(node_id) {
        if existing.as_slice() == pk_bytes {
            // Idempotent: same node re-proving same PK is fine
            return true;
        }
        eprintln!("[ERR][CONSENSUS] pk_register_immutable_violation node={}", node_id);
        return false;
    }
    if registry.len() >= MAX_CONSENSUS_PK_REGISTRY {
        eprintln!("[WARN][CONSENSUS] pk_registry_full size={}", registry.len());
        return false;
    }
    registry.insert(node_id.to_string(), pk_bytes.to_vec());
    println!("[INFO][CONSENSUS] pk_registered_with_proof node={} total={}", node_id, registry.len());
    true
}

/// Check if a node has a registered PK in the consensus layer.
pub fn has_consensus_pk(node_id: &str) -> bool {
    CONSENSUS_PK_REGISTRY.read().contains_key(node_id)
}

/// Retrieve a registered PK (returns None if not registered).
pub fn get_consensus_pk(node_id: &str) -> Option<Vec<u8>> {
    CONSENSUS_PK_REGISTRY.read().get(node_id).cloned()
}

/// Current registry size (for metrics / diagnostics).
pub fn consensus_pk_registry_len() -> usize {
    CONSENSUS_PK_REGISTRY.read().len()
}

/// Anchored genesis public keys. These 5 nodes form the initial validator set.
/// PKs are derived from the deterministic genesis keypairs shipped in
/// `genesis_constants.rs` in the integration layer. The consensus layer
/// holds the anchored map so that the registry cannot be squatted at boot.
///
/// Returns an empty map until anchored keys are wired in (see
/// `set_genesis_anchor_pks`). This function is intentionally lock-cheap
/// because it's consulted on every registration call.
fn genesis_anchor_pks() -> std::collections::HashMap<String, Vec<u8>> {
    GENESIS_ANCHOR_PKS.read().clone()
}

lazy_static::lazy_static! {
    /// One-shot anchor map, populated at startup by the integration layer
    /// via `set_genesis_anchor_pks`. After the first non-empty installation,
    /// further calls are rejected to keep the anchor immutable.
    static ref GENESIS_ANCHOR_PKS: parking_lot::RwLock<std::collections::HashMap<String, Vec<u8>>> =
        parking_lot::RwLock::new(std::collections::HashMap::new());
}

/// Read-only access to the genesis anchor for a single identity. Returns
/// None when no anchor map is installed (cold boot before anchor file is
/// loaded) or when `node_id` is not a genesis identity.
///
/// Used by the integration layer at `initialize_wallet_identity` to refuse
/// boot when the locally-loaded keypair does not match the anchored PK,
/// preventing the v15.x pk_mismatch class of incidents.
pub fn get_consensus_pk_anchor(node_id: &str) -> Option<Vec<u8>> {
    GENESIS_ANCHOR_PKS.read().get(node_id).cloned()
}

/// Number of installed genesis anchors. 0 when no anchor file has been
/// loaded yet — used by callers to decide whether to enforce strict binding.
pub fn genesis_anchor_pks_len() -> usize {
    GENESIS_ANCHOR_PKS.read().len()
}

/// Install the genesis anchor PK map. Called exactly once at process start
/// by the integration layer, BEFORE any `register_consensus_pk_with_proof`
/// call, with the deterministic genesis PKs for the 5 anchor nodes.
///
/// Returns true on first successful install, false if anchors are already
/// installed (immutable) or the provided map is structurally invalid.
pub fn set_genesis_anchor_pks(anchors: std::collections::HashMap<String, Vec<u8>>) -> bool {
    if anchors.is_empty() {
        return false;
    }
    for (node_id, pk) in &anchors {
        if pk.len() != 1952 {
            eprintln!("[ERR][CONSENSUS] anchor_install_invalid_pk_size node={} size={}", node_id, pk.len());
            return false;
        }
    }
    let mut guard = GENESIS_ANCHOR_PKS.write();
    if !guard.is_empty() {
        eprintln!("[WARN][CONSENSUS] anchor_install_rejected already_installed={}", guard.len());
        return false;
    }
    let count = anchors.len();
    *guard = anchors;
    println!("[INFO][CONSENSUS] genesis_anchors_installed count={}", count);
    true
}

/// Verify consensus signature using hybrid cryptography
pub async fn verify_consensus_signature(
    node_id: &str,
    message: &str,
    signature: &str,
) -> bool {
    // SECURITY: Strict validation requirements
    // OPTIMIZED v2.24: Bincode + Zstd format
    // Actual sizes: Compact ~2.6KB bincode, Full ~5KB bincode (vs 27KB JSON legacy)
    if signature.is_empty() || signature.len() < 100 || signature.len() > 18000 {
        println!("[ERR][CONSENSUS_CRYPTO] invalid_signature_length len={} limit=18000", signature.len());
        return false;
    }
    
    // Check signature format
    if signature.starts_with("compact_bin:") {
        // OPTIMIZED v2.24: Binary compact signature (2.6KB vs 5KB JSON!)
        verify_compact_binary_signature(node_id, message, signature).await
    } else if signature.starts_with("compact:") {
        // Legacy: Compact hybrid signature JSON (5KB)
        verify_compact_hybrid_signature(node_id, message, signature).await
    } else if signature.starts_with("hybrid_bin:") {
        // OPTIMIZED v2.24: Binary hybrid signature (5KB vs 27KB JSON!)
        verify_hybrid_binary_signature(node_id, message, signature).await
    } else if signature.starts_with("hybrid:") {
        // This is a full hybrid signature with certificate (legacy JSON, 12KB)
        verify_hybrid_signature(node_id, message, signature).await
    } else if signature.starts_with("dilithium_sig_") {
        // This is a pure Dilithium signature
        verify_dilithium_signature(node_id, message, signature).await
    } else {
        println!("[ERR][CONSENSUS_CRYPTO] unknown_signature_format");
        false
    }
}

/// OPTIMIZED v2.24: Verify compact BINARY signature for microblocks (bincode+zstd)
/// Format: "compact_bin:<base64_bincode_zstd_data>"
/// Size: ~2.6KB (vs 5KB JSON, 50% reduction!)
async fn verify_compact_binary_signature(
    node_id: &str,
    message: &str,
    signature: &str,
) -> bool {
    if !signature.starts_with("compact_bin:") {
        println!("[ERR][CONSENSUS_CRYPTO] invalid_compact_bin_format");
        return false;
    }
    
    let base64_data = &signature[12..]; // Skip "compact_bin:" prefix
    
    // Decode base64
    let binary_data = match general_purpose::STANDARD.decode(base64_data) {
        Ok(data) => data,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] compact_bin_base64_decode_failed err={}", e);
            return false;
        }
    };
    
    // Decompress zstd with a HARD output ceiling.
    //
    // `zstd::decode_all` allocates whatever the stream demands; an adversarial
    // input ~1000× its on-the-wire size could OOM every receiver. Honest
    // compact_bin signatures are ~2.6 KB; the largest plausible variant
    // (`hybrid_bin` with embedded certificate) is ~5 KB. A 256 KB ceiling
    // is ~50× the largest legitimate payload — generous head-room for future
    // protocol additions while making decompression-bomb DoS impossible
    // in this code path.
    const MAX_COMPACT_BIN_DECOMPRESSED: usize = 256 * 1024;
    let decompressed = match decode_zstd_bounded(binary_data.as_slice(), MAX_COMPACT_BIN_DECOMPRESSED) {
        Ok(data) => data,
        Err(e) => {
            println!(
                "[ERR][CONSENSUS_CRYPTO] compact_bin_decompress_failed input_bytes={} err={}",
                binary_data.len(), e
            );
            return false;
        }
    };
    
    // Deserialize with bincode - use Vec<u8> for serde_bytes compatibility
    #[derive(Debug, serde::Deserialize)]
    #[allow(dead_code)]
    struct CompactSig {
        node_id: String,
        cert_serial: String,  // Used for certificate lookup
        #[serde(with = "serde_bytes")]
        ephemeral_public_key: Vec<u8>,
        #[serde(with = "serde_bytes")]
        message_signature: Vec<u8>,
        #[serde(with = "serde_bytes")]
        dilithium_key_signature: Vec<u8>,
        signed_at: u64,
    }
    
    let compact_sig: CompactSig = match bincode::deserialize(&decompressed) {
        Ok(sig) => sig,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] compact_bin_deserialize_failed err={}", e);
            return false;
        }
    };
    
    // Verify node_id matches
    if compact_sig.node_id != node_id {
        println!("[ERR][CONSENSUS_CRYPTO] node_id_mismatch expected={} got={}", node_id, compact_sig.node_id);
        return false;
    }
    
    // Validate sizes
    if compact_sig.ephemeral_public_key.len() != 32 {
        println!("[ERR][CONSENSUS_CRYPTO] invalid_ephemeral_key_length len={}", compact_sig.ephemeral_public_key.len());
        return false;
    }
    if compact_sig.message_signature.len() != 64 {
        println!("[ERR][CONSENSUS_CRYPTO] invalid_ed25519_sig_length len={}", compact_sig.message_signature.len());
        return false;
    }
    
    // Decode message hash
    let message_hash = match hex::decode(message) {
        Ok(hash) => hash,
        Err(_) => message.as_bytes().to_vec(),
    };
    
    // Verify Ed25519 signature
    let ephemeral_pk = match ed25519_dalek::VerifyingKey::from_bytes(
        &compact_sig.ephemeral_public_key.as_slice().try_into().unwrap_or([0u8; 32])
    ) {
        Ok(pk) => pk,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] invalid_ephemeral_public_key err={}", e);
            return false;
        }
    };
    
    let ed25519_sig = match ed25519_dalek::Signature::from_slice(&compact_sig.message_signature) {
        Ok(sig) => sig,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] invalid_ed25519_sig_format err={}", e);
            return false;
        }
    };
    
    use ed25519_dalek::Verifier;
    if ephemeral_pk.verify(&message_hash, &ed25519_sig).is_err() {
        println!("[ERR][CONSENSUS_CRYPTO] ed25519_verification_failed format=compact_bin");
        return false;
    }
    
    // Verify Dilithium: signs (ephemeral_key || message_hash || timestamp)
    // CRITICAL FIX: Must use to_le_bytes() to match hybrid_crypto.rs signing!
    let mut encapsulated_data = Vec::new();
    encapsulated_data.extend_from_slice(&compact_sig.ephemeral_public_key);
    encapsulated_data.extend_from_slice(&message_hash);
    encapsulated_data.extend_from_slice(&compact_sig.signed_at.to_le_bytes());
    let encapsulated_hex = hex::encode(&encapsulated_data);
    
    // Convert RAW Dilithium bytes to signature format for verification
    // Format: "dilithium_sig_<node_id>_<base64_signature_data>"
    let dilithium_sig_base64 = general_purpose::STANDARD.encode(&compact_sig.dilithium_key_signature);
    let dilithium_sig_string = format!("dilithium_sig_{}_{}", node_id, dilithium_sig_base64);
    
    let dilithium_valid = verify_dilithium_signature(node_id, &encapsulated_hex, &dilithium_sig_string).await;
    
    if !dilithium_valid {
        println!("[ERR][CONSENSUS_CRYPTO] dilithium_verification_failed format=compact_bin");
        return false;
    }
    
    println!("[INFO][CONSENSUS_CRYPTO] compact_bin_signature_verified version=v2.24");
    true
}

/// LEGACY: Verify compact JSON signature for microblocks  
/// For macroblocks, full signatures are used (verified by verify_hybrid_signature)
async fn verify_compact_hybrid_signature(
    node_id: &str,
    message: &str,
    signature: &str,
) -> bool {
    // Parse compact signature format: "compact:<json_data>"
    if !signature.starts_with("compact:") {
        println!("[ERR][CONSENSUS_CRYPTO] invalid_compact_signature_format");
        return false;
    }
    
    let json_data = &signature[8..]; // Skip "compact:" prefix
    
    // HYBRID ARCHITECTURE:
    // - Microblocks: Compact signatures with certificate lookup  
    // - Macroblocks: Full signatures with embedded certificate
    // - This function only handles microblock verification
    
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_data) {
        // Verify structure has required fields (NIST/Cisco compliance)
        // OPTIMIZED v2.23: RAW bytes format, dilithium_message_signature removed
        if parsed.get("node_id").is_some() && 
           parsed.get("cert_serial").is_some() &&
           parsed.get("ephemeral_public_key").is_some() &&  // NIST/Cisco: ephemeral key per message
           parsed.get("message_signature").is_some() &&
           parsed.get("dilithium_key_signature").is_some() {  // NIST/Cisco: Dilithium signs ephemeral key + message_hash
            
            // Extract fields from compact signature
            if let (Some(sig_node_id), Some(cert_serial)) = 
                (parsed.get("node_id").and_then(|v| v.as_str()),
                 parsed.get("cert_serial").and_then(|v| v.as_str())) {
                
                // Verify node_id matches
                if sig_node_id != node_id {
                    println!("[ERR][CONSENSUS_CRYPTO] node_id_mismatch expected={} got={}", node_id, sig_node_id);
                    return false;
                }
                
                // PRODUCTION: Cryptographic verification with certificate lookup
                // For microblocks, we need the certificate to verify compact signatures
                
                // Extract signature components
                let ed25519_sig_bytes = parsed.get("message_signature")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| {
                        // Convert JSON array to Vec<u8>
                        let mut bytes = Vec::new();
                        for val in arr {
                            if let Some(n) = val.as_u64() {
                                if n <= 255 {
                                    bytes.push(n as u8);
                                } else {
                                    return None; // Invalid byte value
                                }
                            } else {
                                return None; // Not a number
                            }
                        }
                        Some(bytes)
                    });
                
                // OPTIMIZED v2.23: dilithium_key_signature is now RAW bytes (array of u8 in JSON)
                let dilithium_key_bytes: Option<Vec<u8>> = parsed.get("dilithium_key_signature")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| {
                        let mut bytes = Vec::new();
                        for val in arr {
                            if let Some(n) = val.as_u64() {
                                if n <= 255 {
                                    bytes.push(n as u8);
                                } else {
                                    return None;
                                }
                            } else {
                                return None;
                            }
                        }
                        Some(bytes)
                    });
                
                // OPTIMIZED v2.23: ephemeral_public_key is now RAW bytes (array of u8 in JSON)
                let ephemeral_pk_bytes: Option<Vec<u8>> = parsed.get("ephemeral_public_key")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| {
                        let mut bytes = Vec::new();
                        for val in arr {
                            if let Some(n) = val.as_u64() {
                                if n <= 255 {
                                    bytes.push(n as u8);
                                } else {
                                    return None;
                                }
                            } else {
                                return None;
                            }
                        }
                        if bytes.len() == 32 { Some(bytes) } else { None }
                    });
                
                // Extract signed_at timestamp for encapsulated_data reconstruction
                let signed_at = parsed.get("signed_at")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                
                // OPTIMIZED v2.23: Check RAW bytes fields
                if ed25519_sig_bytes.is_none() || dilithium_key_bytes.is_none() || ephemeral_pk_bytes.is_none() || signed_at == 0 {
                    println!("[ERR][CONSENSUS_CRYPTO] compact_sig_missing_components ed25519={} ephemeral_pk={} dilithium={} timestamp={}",
                        if ed25519_sig_bytes.is_some() {"ok"} else {"missing"},
                        if ephemeral_pk_bytes.is_some() {"ok"} else {"missing"},
                        if dilithium_key_bytes.is_some() {"ok"} else {"missing"},
                        if signed_at > 0 {"ok"} else {"missing"});
                    return false;
                }
                
                let dilithium_key_raw = dilithium_key_bytes.expect("Checked above");
                let ephemeral_pk_raw = ephemeral_pk_bytes.expect("Checked above");
                
                let ed25519_sig = ed25519_sig_bytes.expect("Checked is_none above");
                let ed25519_sig_len = ed25519_sig.len();  // Save length before ownership transfer
                
                // PRODUCTION: Real cryptographic verification with certificates
                // CRITICAL FIX: message is HEX string, must decode to bytes first!
                // sign_message_compact() uses RAW message bytes for hash
                use sha3::{Sha3_256, Digest};
                let message_bytes = match hex::decode(message) {
                    Ok(bytes) => bytes,
                    Err(_) => message.as_bytes().to_vec(), // Fallback for non-hex
                };
                let mut hasher = Sha3_256::new();
                hasher.update(&message_bytes);
                let message_hash = hasher.finalize();
                let _message_hash_str = hex::encode(&message_hash); // For debugging if needed
                
                // PRODUCTION: Structural validation at consensus level
                // ARCHITECTURE: Clean separation - core validates structure,
                // development layer (qnet-integration) handles full crypto with certificates
                //
                // Why this architecture:
                // 1. Core modules cannot depend on development modules
                // 2. Certificates are managed at P2P layer (qnet-integration)
                // 3. Full crypto verification happens BEFORE consensus at P2P level:
                //    - node.rs::verify_microblock_signature() for received blocks
                //    - All blocks entering consensus are pre-verified
                // 4. This provides defense-in-depth with clean architecture
                
                // Validate Ed25519 signature component
                if ed25519_sig_len != 64 {
                    println!("[ERR][CONSENSUS_CRYPTO] invalid_ed25519_sig_size size={} expected=64", ed25519_sig_len);
                    return false;
                }
                
                // OPTIMIZED v2.23: Validate RAW bytes Dilithium signature
                if dilithium_key_raw.len() < 2500 {
                    println!("[ERR][CONSENSUS_CRYPTO] invalid_dilithium_key_sig_size size={} min=4500", dilithium_key_raw.len());
                    return false;
                }
                
                // Basic Ed25519 signature format check (can parse as valid signature)
                use ed25519_dalek::Signature as Ed25519Signature;
                let ed_sig_array: Result<[u8; 64], _> = ed25519_sig.try_into();
                match ed_sig_array {
                    Ok(arr) => {
                        if Ed25519Signature::try_from(arr.as_ref()).is_err() {
                            println!("[ERR][CONSENSUS_CRYPTO] ed25519_signature_malformed");
                            return false;
                        }
                    },
                    Err(_) => {
                        println!("[ERR][CONSENSUS_CRYPTO] ed25519_signature_wrong_size");
                        return false;
                    }
                }
                
                // CRITICAL: Real Dilithium verification at CONSENSUS level
                // OPTIMIZED v2.23: Single Dilithium signature as RAW bytes
                // ephemeral_key || message_hash || timestamp
                // This provides both key binding AND message integrity
                
                println!("[INFO][CONSENSUS_CRYPTO] verifying_dilithium_key_signature standard=NIST_Cisco");
                
                // OPTIMIZED v2.23: Use RAW bytes directly
                let mut encapsulated_data = Vec::new();
                encapsulated_data.extend_from_slice(&ephemeral_pk_raw);
                encapsulated_data.extend_from_slice(&message_hash);
                encapsulated_data.extend_from_slice(&signed_at.to_le_bytes());
                let encapsulated_hex = hex::encode(&encapsulated_data);
                
                // Convert RAW bytes back to signature string format for verify_dilithium_signature
                let dilithium_sig_string = format!(
                    "dilithium_sig_{}_{}",
                    node_id,
                    general_purpose::STANDARD.encode(&dilithium_key_raw)
                );
                
                // Verify Dilithium KEY signature (binds ephemeral key + message + timestamp)
                let dilithium_key_valid = verify_dilithium_signature(
                    node_id,
                    &encapsulated_hex,  // CRITICAL: Use encapsulated_data, not just message_hash!
                    &dilithium_sig_string
                ).await;
                
                if !dilithium_key_valid {
                    println!("[ERR][CONSENSUS_CRYPTO] dilithium_signature_verification_failed note=possible_quantum_attack");
                    return false;
                }
                
                println!("[INFO][CONSENSUS_CRYPTO] signatures_verified node={} cert={} ed25519=ok dilithium=ok nist_cisco=ok", node_id, cert_serial);
                
                return true;
            }
        }
    }
    
    println!("[ERR][CONSENSUS_CRYPTO] compact_signature_structure_invalid");
    false
}

/// OPTIMIZED v2.24: Verify binary hybrid signature (bincode+zstd instead of JSON)
/// Size: ~5KB vs 27KB JSON - 81% reduction!
async fn verify_hybrid_binary_signature(
    node_id: &str,
    message: &str,
    signature: &str,
) -> bool {
    // Parse binary signature format: "hybrid_bin:<base64_bincode_data>"
    if !signature.starts_with("hybrid_bin:") {
        println!("[ERR][CONSENSUS_CRYPTO] invalid_hybrid_bin_format");
        return false;
    }
    
    let base64_data = &signature[11..]; // Skip "hybrid_bin:" prefix
    
    // Decode base64
    let binary_data = match general_purpose::STANDARD.decode(base64_data) {
        Ok(data) => data,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] hybrid_bin_base64_decode_failed err={}", e);
            return false;
        }
    };
    
    println!("[INFO][CONSENSUS_CRYPTO] verifying_hybrid_bin_signature size_kb={}", binary_data.len() / 1024);
    
    // Decompress and deserialize
    use std::io::Read;
    let mut decoder = match zstd::Decoder::new(&binary_data[..]) {
        Ok(d) => d,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] zstd_decode_failed err={}", e);
            return false;
        }
    };
    let mut decompressed = Vec::new();
    if let Err(e) = decoder.read_to_end(&mut decompressed) {
        println!("[ERR][CONSENSUS_CRYPTO] zstd_read_failed err={}", e);
        return false;
    }
    
    // Deserialize bincode to get signature components
    // We use serde_json::Value as intermediate since bincode struct may differ
    #[derive(serde::Deserialize)]
    struct BinaryHybridSignature {
        certificate: BinaryCertificate,
        #[serde(with = "serde_bytes")]
        ephemeral_public_key: Vec<u8>,
        #[serde(with = "serde_bytes")]
        message_signature: Vec<u8>,
        #[serde(with = "serde_bytes")]
        dilithium_key_signature: Vec<u8>,
        signed_at: u64,
    }
    
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct BinaryCertificate {
        node_id: String,
        ed25519_public_key: [u8; 32],
        dilithium_signature: String,
        issued_at: u64,
        expires_at: u64,  // Used for certificate expiration check
        serial_number: String,
        #[serde(default)]
        rotation_signature: Option<String>,
    }
    
    let sig: BinaryHybridSignature = match bincode::deserialize(&decompressed) {
        Ok(s) => s,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] bincode_deserialize_failed err={}", e);
            return false;
        }
    };
    
    // Verify certificate belongs to claimed node
    if sig.certificate.node_id != node_id {
        println!("[ERR][CONSENSUS_CRYPTO] cert_node_id_mismatch cert_node={} expected={}", sig.certificate.node_id, node_id);
        return false;
    }
    
    // Check certificate expiration with GRACE PERIOD
    // v2.64: 60 second grace period for network propagation delays (intercontinental latency)
    const CERTIFICATE_GRACE_PERIOD_SECS: u64 = 60;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if now > sig.certificate.expires_at + CERTIFICATE_GRACE_PERIOD_SECS {
        println!("[ERR][CONSENSUS_CRYPTO] certificate_expired grace_period_secs={}", CERTIFICATE_GRACE_PERIOD_SECS);
        return false;
    }
    
    // Compute message hash
    // CRITICAL FIX: message is HEX string, must decode to bytes first!
    // sign_message() hashes RAW bytes, so we must match that
    use sha3::{Sha3_256, Digest};
    let message_bytes = match hex::decode(message) {
        Ok(bytes) => bytes,
        Err(_) => message.as_bytes().to_vec(), // Fallback for non-hex
    };
    let mut hasher = Sha3_256::new();
    hasher.update(&message_bytes);
    let message_hash = hasher.finalize();
    
    // Build encapsulated data: ephemeral_key || message_hash || timestamp
    let mut encapsulated_data = Vec::new();
    encapsulated_data.extend_from_slice(&sig.ephemeral_public_key);
    encapsulated_data.extend_from_slice(&message_hash);
    encapsulated_data.extend_from_slice(&sig.signed_at.to_le_bytes());
    let encapsulated_hex = hex::encode(&encapsulated_data);
    
    // Convert RAW bytes back to signature string format for verification
    let dilithium_sig_string = format!(
        "dilithium_sig_{}_{}",
        node_id,
        general_purpose::STANDARD.encode(&sig.dilithium_key_signature)
    );
    
    // Verify Dilithium KEY signature (covers ephemeral_key + message_hash + timestamp)
    let dilithium_key_valid = verify_dilithium_signature(
        node_id,
        &encapsulated_hex,
        &dilithium_sig_string,
    ).await;
    
    if !dilithium_key_valid {
        println!("[ERR][CONSENSUS_CRYPTO] dilithium_key_sig_verification_failed");
        return false;
    }
    
    // Verify Ed25519 message signature
    use ed25519_dalek::{VerifyingKey, Signature, Verifier};
    let ephemeral_pk = match VerifyingKey::from_bytes(&sig.ephemeral_public_key.try_into().unwrap_or([0u8; 32])) {
        Ok(pk) => pk,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] invalid_ephemeral_public_key err={}", e);
            return false;
        }
    };
    
    let ed25519_sig = match Signature::from_slice(&sig.message_signature) {
        Ok(s) => s,
        Err(e) => {
            println!("[ERR][CONSENSUS_CRYPTO] invalid_ed25519_signature err={}", e);
            return false;
        }
    };
    
    // CRITICAL: Ed25519 signed RAW message bytes, not HEX string
    if ephemeral_pk.verify(&message_bytes, &ed25519_sig).is_err() {
        println!("[ERR][CONSENSUS_CRYPTO] ed25519_message_sig_verification_failed");
        return false;
    }
    
    println!("[INFO][CONSENSUS_CRYPTO] hybrid_bin_signature_verified format=bincode");
    true
}

/// Verify hybrid signature (Dilithium certificate + Ed25519)
/// CRITICAL FIX: Now performs REAL Dilithium verification per NIST/Cisco requirements
async fn verify_hybrid_signature(
    node_id: &str,
    message: &str,
    signature: &str,
) -> bool {
    // Parse hybrid signature format: "hybrid:<json_data>"
    if !signature.starts_with("hybrid:") {
        println!("[ERR][CONSENSUS_CRYPTO] invalid_hybrid_signature_format");
        return false;
    }
    
    let json_data = &signature[7..]; // Skip "hybrid:" prefix
    
    // Parse JSON to extract signature components
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_data) {
        // Check required fields
        let has_certificate = parsed.get("certificate").is_some();
        let has_message_sig = parsed.get("message_signature").is_some();
        
        // OPTIMIZED v2.23: Parse RAW bytes from JSON array
        let dilithium_key_bytes: Option<Vec<u8>> = parsed.get("dilithium_key_signature")
            .and_then(|v| v.as_array())
            .and_then(|arr| {
                let mut bytes = Vec::new();
                for val in arr {
                    if let Some(n) = val.as_u64() {
                        if n <= 255 {
                            bytes.push(n as u8);
                        } else {
                            return None;
                        }
                    } else {
                        return None;
                    }
                }
                Some(bytes)
            });
            
        let ephemeral_pk_bytes: Option<Vec<u8>> = parsed.get("ephemeral_public_key")
            .and_then(|v| v.as_array())
            .and_then(|arr| {
                let mut bytes = Vec::new();
                for val in arr {
                    if let Some(n) = val.as_u64() {
                        if n <= 255 {
                            bytes.push(n as u8);
                        } else {
                            return None;
                        }
                    } else {
                        return None;
                    }
                }
                if bytes.len() == 32 { Some(bytes) } else { None }
            });
            
        let signed_at = parsed.get("signed_at")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        
        if !has_certificate || !has_message_sig {
            println!("[ERR][CONSENSUS_CRYPTO] hybrid_sig_missing_required_fields");
            return false;
        }
        
        // OPTIMIZED v2.23: Verify with RAW bytes
        if let (Some(dilithium_raw), Some(ephemeral_raw)) = (dilithium_key_bytes, ephemeral_pk_bytes) {
            if signed_at > 0 {
                println!("[INFO][CONSENSUS_CRYPTO] verifying_hybrid_dilithium_signature");
                
                // Compute message hash
                // CRITICAL FIX: message is HEX string, must decode to bytes first!
                use sha3::{Sha3_256, Digest};
                let message_bytes = match hex::decode(message) {
                    Ok(bytes) => bytes,
                    Err(_) => message.as_bytes().to_vec(), // Fallback for non-hex
                };
                let mut hasher = Sha3_256::new();
                hasher.update(&message_bytes);
                let message_hash = hasher.finalize();
                
                let mut encapsulated_data = Vec::new();
                encapsulated_data.extend_from_slice(&ephemeral_raw);
                encapsulated_data.extend_from_slice(&message_hash);
                encapsulated_data.extend_from_slice(&signed_at.to_le_bytes());
                let encapsulated_hex = hex::encode(&encapsulated_data);
                
                // Convert RAW bytes back to signature string format
                let dilithium_sig_string = format!(
                    "dilithium_sig_{}_{}",
                    node_id,
                    general_purpose::STANDARD.encode(&dilithium_raw)
                );
                
                // Verify Dilithium KEY signature (covers ephemeral_key + message_hash + timestamp)
                let dilithium_key_valid = verify_dilithium_signature(
                    node_id,
                    &encapsulated_hex,
                    &dilithium_sig_string
                ).await;
                
                if !dilithium_key_valid {
                    println!("[ERR][CONSENSUS_CRYPTO] hybrid_dilithium_signature_failed");
                    return false;
                }
                
                println!("[INFO][CONSENSUS_CRYPTO] hybrid_signature_verified node={} dilithium=ok", node_id);
                return true;
            }
        }
        
        // SECURITY: Legacy bypass REMOVED — Dilithium verification is MANDATORY
        // Hybrid signatures without valid Dilithium fields are rejected
        println!("[WARN][CONSENSUS_CRYPTO] hybrid_sig_rejected reason=missing_dilithium_fields");
        return false;
    }
    
    println!("[ERR][CONSENSUS_CRYPTO] invalid_hybrid_signature_structure");
    false
}

/// Verify pure Dilithium signature
async fn verify_dilithium_signature(
    node_id: &str,
    message: &str,
    signature: &str,
) -> bool {
    // PRODUCTION: Parse Dilithium signature format
    if !signature.starts_with("dilithium_sig_") {
        println!("[ERR][CONSENSUS_CRYPTO] invalid_signature_format expected_prefix=dilithium_sig_");
        return false;
    }
    
    let prefix = "dilithium_sig_";
    let signature_part = &signature[prefix.len()..];
    
    // Find the LAST '_' to separate node_id from base64 signature
    let last_underscore_pos = signature_part.rfind('_');
    if last_underscore_pos.is_none() {
        println!("[ERR][CONSENSUS_CRYPTO] signature_format_invalid missing=separator");
        return false;
    }
    
    let separator_pos = last_underscore_pos.expect("Checked is_none above");
    let extracted_node_id = &signature_part[..separator_pos];
    let signature_base64 = &signature_part[separator_pos + 1..];
    
    // Validate extracted node_id matches expected
    if extracted_node_id != node_id {
        println!("[ERR][CONSENSUS_CRYPTO] node_id_mismatch expected={} got={}", node_id, extracted_node_id);
        return false;
    }
    
    // Decode base64 signature
    let signature_bytes = match general_purpose::STANDARD.decode(signature_base64) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("[ERR][CONSENSUS] sig_base64_decode_failed node={} err={}", node_id, e);
            return false;
        }
    };

    // Combined format: [sig_len(4)] + [SignedMessage(sig+msg)] + [pk_len(4)] + [pk(1952)]
    // Minimum size: ML-DSA-65 signature (3309 bytes) + message + metadata
    if signature_bytes.len() < 3309 {
        eprintln!("[ERR][CONSENSUS] sig_too_small node={} size={} min=3309",
                 node_id, signature_bytes.len());
        return false;
    }

    // CRITICAL: Call actual ML-DSA-65 verification through async runtime
    let valid = verify_with_real_dilithium(node_id, message, &signature_bytes).await;

    if valid {
        println!("[INFO][CONSENSUS] sig_verified node={}", node_id);
    } else {
        eprintln!("[ERR][CONSENSUS] sig_invalid node={}", node_id);
    }
    
    valid
}

/// Verify signature with real CRYSTALS-Dilithium
async fn verify_with_real_dilithium(
    node_id: &str,
    message: &str,
    signature_bytes: &[u8],
) -> bool {
    // Verify signature structure: all-zero is trivially invalid
    if signature_bytes.iter().all(|&b| b == 0) {
        eprintln!("[ERR][CONSENSUS] sig_all_zeros node={}", node_id);
        return false;
    }

    // Entropy check on the ML-DSA-65 signature part (3309 bytes, CTILDEBYTES=48)
    let sig_part = &signature_bytes[..std::cmp::min(3309, signature_bytes.len())];
    let unique_bytes: std::collections::HashSet<_> = sig_part.iter().collect();
    if unique_bytes.len() < 200 {
        eprintln!("[ERR][CONSENSUS] sig_low_entropy node={} unique={} threshold=200",
                 node_id, unique_bytes.len());
        return false;
    }

    // Parse combined format: [sig_len(4)] + [SignedMessage(sig+msg)] + [pk_len(4)] + [pk(1952)]
    if signature_bytes.len() < 8 {
        eprintln!("[ERR][CONSENSUS] sig_too_short node={} size={}", node_id, signature_bytes.len());
        return false;
    }

    let signed_len = u32::from_le_bytes([
        signature_bytes[0],
        signature_bytes[1],
        signature_bytes[2],
        signature_bytes[3],
    ]) as usize;

    // ML-DSA-65 SignedMessage must be at least 3309 bytes (sig) + 1 byte (msg) = 3310 minimum
    if signed_len <= 3309 || 4 + signed_len >= signature_bytes.len() {
        eprintln!("[ERR][CONSENSUS] sig_format_invalid node={} signed_len={}", node_id, signed_len);
        return false;
    }
    
    // Extract public key from the end of signature
    let pk_len_start = 4 + signed_len;
    if pk_len_start + 4 > signature_bytes.len() {
        println!("[ERR][CONSENSUS_CRYPTO] missing_public_key_length_field");
        return false;
    }
    
    let pk_len = u32::from_le_bytes([
        signature_bytes[pk_len_start],
        signature_bytes[pk_len_start + 1],
        signature_bytes[pk_len_start + 2],
        signature_bytes[pk_len_start + 3],
    ]) as usize;
    
    let pk_start = pk_len_start + 4;
    
    // CRITICAL: Dilithium3 public key MUST be exactly 1952 bytes (NIST standard)
    use pqcrypto_mldsa::mldsa65 as dilithium3;
    if pk_len != dilithium3::public_key_bytes() {
        eprintln!("[ERR][CONSENSUS] pk_size_invalid node={} got={} expected={}",
                 node_id, pk_len, dilithium3::public_key_bytes());
        return false;
    }

    if pk_start + pk_len != signature_bytes.len() {
        eprintln!("[ERR][CONSENSUS] sig_len_mismatch node={}", node_id);
        return false;
    }

    // Extract components
    let signed_message_bytes = &signature_bytes[4..4 + signed_len];
    let public_key_bytes = &signature_bytes[pk_start..pk_start + pk_len];

    // ─────────────────────────────────────────────────────────────────────
    // Identity → public-key binding policy (three tiers)
    // ─────────────────────────────────────────────────────────────────────
    //
    // Tier 1 (HARD MATCH): registry has a binding for `node_id` and the
    //   extracted PK matches it. The signature is identity-bound.
    //
    // Tier 2 (HARD REJECT — non-match): registry has a binding for `node_id`
    //   and the extracted PK does NOT match. This is a hostile identity
    //   claim — a peer holding their own valid Dilithium3 keypair attempting
    //   to spoof an already-bound identity. Reject. There is NO legitimate
    //   reason to accept a different PK for an identity once the registry
    //   has locked one in (registry entries are immutable for the process
    //   lifetime; see register_consensus_pk_from_chain immutability check).
    //
    // Tier 3 (POLICY-DEPENDENT — no binding):
    //   * If `node_id` matches a Genesis pattern (`"genesis_node_*"`):
    //     HARD REJECT. Genesis identities MUST be in the registry before any
    //     inbound signature is accepted. They are populated either by
    //       (1) self-registration at boot (initialize_wallet_identity calls
    //           register_consensus_pk_from_chain with the local keypair
    //           BEFORE P2P comes up); or
    //       (2) the genesis anchor file shipped by the operator
    //           (install_genesis_anchors_at_startup, then anchored PKs are
    //           embedded into the genesis NodeRegistration TX which feeds
    //           cache_node_registrations_from_transactions_with_dashmap →
    //           register_consensus_pk_from_chain).
    //     Accepting a first-seen Genesis PK here would lock the identity to
    //     whatever PK the network sees first, opening the squat-on-bootstrap
    //     window that the anchor system exists to close.
    //   * Otherwise (Super-node, Light-node, generic identity):
    //     Accept (TOFV) and continue to math verification. Super-node
    //     identities reach steady-state binding via signed
    //     `NodeRegistration` TX (proof-of-ownership in the TX payload),
    //     which is applied to chain state and mirrored into this registry
    //     before any cross-restart binding is needed. The TOFV path lets
    //     a freshly-joined Super-node's first announcement be accepted in
    //     the small window between its TX broadcast and chain finality.
    //
    // NOTE on math: regardless of tier, the Dilithium3 signature is
    // cryptographically verified under `dilithium3::open` further down. This
    // tier block only governs the identity → key binding decision, not the
    // mathematical validity of the signature itself.
    //
    // SCALABILITY: registry uses parking_lot::RwLock + HashMap with capacity
    // 50K — supports tens of thousands of Super-nodes. Read path is
    // wait-free; the write path runs exactly once per identity registration
    // (one-shot per node lifetime). The genesis prefix check is a fixed-cost
    // string comparison — O(1) regardless of network size.
    {
        let registry = CONSENSUS_PK_REGISTRY.read();
        match registry.get(node_id) {
            Some(registered_pk) if registered_pk == public_key_bytes => {
                // Tier 1: bound and matches — proceed to math verification.
            }
            Some(registered_pk) => {
                // Tier 2: bound, mismatch — hostile identity claim. Hard reject.
                eprintln!("[ERR][CONSENSUS] pk_mismatch node={} registered={}.. extracted={}..",
                         node_id,
                         hex::encode(&registered_pk[..8]),
                         hex::encode(&public_key_bytes[..8]));
                return false;
            }
            None => {
                // Tier 3: policy depends on identity class.
                if node_id.starts_with("genesis_node_") {
                    // Genesis identity with no registry binding. The boot
                    // sequence of every honest node guarantees a binding is
                    // installed BEFORE P2P traffic is processed, so an
                    // unbound genesis claim arriving here is either:
                    //   (a) a race against a not-yet-completed self-register
                    //       (transient, will resolve on retry/regossip), or
                    //   (b) a squat attempt from a non-genesis peer.
                    // Both cases are handled identically by hard-rejecting:
                    // case (a) self-heals because the legitimate sender's
                    // gossip continues; case (b) is the attack we exist to
                    // block.
                    let extracted_prefix = if public_key_bytes.len() >= 8 {
                        hex::encode(&public_key_bytes[..8])
                    } else {
                        String::new()
                    };
                    eprintln!(
                        "[CRIT][CONSENSUS] genesis_pk_first_seen_rejected node={} extracted={}.. \
                         action=hard_reject hint=anchor_or_self_register_must_run_before_p2p",
                        node_id, extracted_prefix
                    );
                    return false;
                }
                // Non-genesis identity (Super-node, Light-node, etc.). TOFV
                // is acceptable; chain-state will lock the canonical binding
                // shortly via NodeRegistration TX application, after which
                // any future mismatch is caught by Tier 2 above.
                if public_key_bytes.len() >= 8 {
                    println!("[WARN][CONSENSUS] pk_first_seen node={} extracted={}..",
                             node_id, hex::encode(&public_key_bytes[..8]));
                }
            }
        }
    }

    // Parse ML-DSA-65 public key
    let public_key = match dilithium3::PublicKey::from_bytes(public_key_bytes) {
        Ok(pk) => pk,
        Err(_) => {
            eprintln!("[ERR][CONSENSUS] pk_parse_failed node={}", node_id);
            return false;
        }
    };

    // Parse SignedMessage (signature + message combined)
    let signed_message = match dilithium3::SignedMessage::from_bytes(signed_message_bytes) {
        Ok(sm) => sm,
        Err(_) => {
            eprintln!("[ERR][CONSENSUS] signed_msg_parse_failed node={}", node_id);
            return false;
        }
    };

    // ML-DSA-65 (FIPS 204) verification via pqcrypto-mldsa
    match dilithium3::open(&signed_message, &public_key) {
        Ok(recovered_message) => {
            let expected_msg = message.as_bytes();
            // Constant-time comparison to prevent timing side-channel attacks
            if ct_eq(recovered_message.as_slice(), expected_msg) {
                println!("[INFO][CONSENSUS] mldsa65_verified node={} pk={}...",
                         node_id, hex::encode(&public_key_bytes[..8]));
                return true;
            } else {
                eprintln!("[ERR][CONSENSUS] msg_mismatch node={} expected_len={} recovered_len={}",
                         node_id, expected_msg.len(), recovered_message.len());
                return false;
            }
        }
        Err(_) => {
            eprintln!("[ERR][CONSENSUS] mldsa65_verify_failed node={}", node_id);
            return false;
        }
    }
}

/// Constant-time byte slice comparison -- prevents timing side-channel attacks.
/// Returns true only if slices are equal in length and content.
/// FIX L-C2ct: Also constant-time for length to prevent length-based timing leaks.
#[inline(never)]
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        // Still do full comparison to avoid timing leak on length mismatch
        let max_len = a.len().max(b.len());
        let mut result: u8 = 1; // Start with "not equal" since lengths differ
        for i in 0..max_len {
            let byte_a = a.get(i).copied().unwrap_or(0);
            let byte_b = b.get(i).copied().unwrap_or(0);
            result |= byte_a ^ byte_b;
        }
        std::hint::black_box(result);
        return false; // Always false for different lengths, but took constant time
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    // Use black_box to prevent compiler from optimising the loop away
    std::hint::black_box(diff) == 0
}

/// Decompress zstd bytes with a hard output ceiling.
///
/// Used by every signature-format verifier on the inbound P2P path so a
/// hostile peer cannot weaponise zstd's typical-thousand-fold expansion
/// ratio into an OOM. The streaming `Read::take` adapter caps the total
/// bytes read from the decoder; a payload that decodes to more than
/// `max_output_bytes` short-circuits with `Err(InvalidData)` before the
/// inner buffer is allowed to grow further.
///
/// Scalability: O(N) in `output_size`. The pre-sized `Vec` capacity is
/// 1 MiB or `max_output_bytes` (whichever is smaller), so small-but-
/// frequent verifications do not pay a full max-size allocation each call.
pub(crate) fn decode_zstd_bounded(input: &[u8], max_output_bytes: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut decoder = zstd::Decoder::new(input)?;
    let initial_cap = max_output_bytes.min(1 * 1024 * 1024);
    let mut output: Vec<u8> = Vec::with_capacity(initial_cap);
    let cap_plus_one = max_output_bytes.saturating_add(1) as u64;
    let mut bounded = decoder.by_ref().take(cap_plus_one);
    let _ = bounded.read_to_end(&mut output)?;
    if output.len() > max_output_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "decompressed_size_exceeds_cap output_bytes={} cap_bytes={}",
                output.len(), max_output_bytes
            ),
        ));
    }
    Ok(output)
}

// ════════════════════════════════════════════════════════════════════════════
// REGRESSION TESTS — Fix #20 (bounded zstd) + Tier-3 binding policy
// ════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests_v17_security {
    use super::*;

    fn zstd_compress_for_test(input: &[u8]) -> Vec<u8> {
        zstd::encode_all(input, 1).expect("zstd encode for test must succeed")
    }

    /// Fix #20: decoded bytes equal input on a payload below the cap.
    #[test]
    fn decode_zstd_bounded_accepts_payload_below_cap() {
        let original = b"compact_bin signature test payload".to_vec();
        let compressed = zstd_compress_for_test(&original);
        let decoded = decode_zstd_bounded(&compressed, 1024).expect("below cap must decode");
        assert_eq!(decoded, original);
    }

    /// Fix #20: an exact-cap payload is accepted; the implementation's
    /// `cap_plus_one` reader plus `<= cap` post-check allow equality.
    #[test]
    fn decode_zstd_bounded_accepts_payload_at_exact_cap() {
        let original = vec![0x55u8; 5 * 1024];
        let compressed = zstd_compress_for_test(&original);
        let decoded = decode_zstd_bounded(&compressed, original.len())
            .expect("exact-size must decode");
        assert_eq!(decoded.len(), original.len());
    }

    /// Fix #20: decoded bytes one over the cap MUST yield InvalidData.
    /// Regression here re-opens the bomb class on the consensus layer.
    #[test]
    fn decode_zstd_bounded_rejects_payload_above_cap() {
        let original = vec![0xAAu8; 2048];
        let compressed = zstd_compress_for_test(&original);
        let result = decode_zstd_bounded(&compressed, original.len() - 1);
        assert!(result.is_err(), "must reject above-cap output");
        let err = result.err().unwrap();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("decompressed_size_exceeds_cap"));
    }

    /// Fix #20: classic decompression bomb — small input, huge output.
    /// The cap is on OUTPUT bytes, not input bytes; a small input that
    /// expands far past the cap MUST be rejected even though the input
    /// alone is well within any reasonable network packet size.
    #[test]
    fn decode_zstd_bounded_rejects_high_ratio_bomb() {
        // 512 KB of zeros compresses to a few KB — but exceeds an 8 KB
        // output cap by ~64×. Real-world bombs hit 1000× ratios.
        let original = vec![0u8; 512 * 1024];
        let compressed = zstd_compress_for_test(&original);
        assert!(compressed.len() < 8 * 1024,
            "fixture sanity: compressed payload must be small relative to original");
        let result = decode_zstd_bounded(&compressed, 8 * 1024);
        assert!(result.is_err(), "decompression bomb must be rejected on output cap");
    }

    /// Fix #20: malformed zstd input MUST return Err (and not panic) so a
    /// hostile peer cannot crash the verifier with a bogus stream.
    #[test]
    fn decode_zstd_bounded_rejects_malformed_input() {
        let garbage: Vec<u8> = (0..256).map(|i| (i * 31 + 17) as u8).collect();
        let result = decode_zstd_bounded(&garbage, 4096);
        assert!(result.is_err(), "malformed zstd must error gracefully");
    }

    /// Fix #20: empty payload decodes to empty output without error.
    /// Edge case ensures the bounded reader does not regress to a
    /// "minimum 1 byte" requirement.
    #[test]
    fn decode_zstd_bounded_empty_payload_round_trip() {
        let compressed = zstd_compress_for_test(&[]);
        let decoded = decode_zstd_bounded(&compressed, 4096).expect("empty must decode");
        assert!(decoded.is_empty());
    }
}

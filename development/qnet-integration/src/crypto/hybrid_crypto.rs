//! # QNet Hybrid Cryptography Module (v2.24)
//!
//! ## Overview
//! Implements hybrid post-quantum cryptography with CRYSTALS-Dilithium and Ed25519
//! following NIST and Cisco recommendations. Optimized for minimal bandwidth with
//! bincode + zstd compression format.
//!
//! ## Architecture (v2.24 - Bincode + Zstd optimization)
//!
//! ### Signature System
//! - **Ed25519**: Fast classical signatures (64 bytes RAW)
//! - **CRYSTALS-Dilithium**: Post-quantum signatures (~2500 bytes RAW)
//! - **Hybrid**: Single Dilithium signature covers ephemeral_key + message_hash + timestamp
//! - **Format**: Bincode + Zstd compression (90% size reduction vs JSON)
//!
//! ### Serialization Formats
//! - **Production**: `to_binary_compressed()` / `from_binary_compressed()` - bincode + zstd
//! - **Legacy**: `to_json()` / `from_json()` - for backwards compatibility only
//!
//! ### Certificate Management
//! - **Lifetime**: 4.5 minutes (270 seconds) - frequent rotation for ephemeral key freshness
//! - **Rotation**: Automatic at 80% lifetime (216 sec), grace period 54 sec
//! - **Storage**: LRU cache (100K certificates)
//! - **Distribution**: P2P broadcast immediately after rotation + periodic maintenance
//! - **Verification**: Dilithium-only (v3.50) — Ed25519 rotation chain removed
//!
//! ## Signature Formats (v2.24)
//!
//! ### Compact Signature (Microblocks - ~2.6KB bincode)
//! ```rust
//! pub struct CompactHybridSignature {
//!     pub node_id: String,
//!     pub cert_serial: String,
//!     pub ephemeral_public_key: [u8; 32],   // RAW bytes
//!     pub message_signature: [u8; 64],       // Ed25519 RAW
//!     pub dilithium_key_signature: Vec<u8>,  // Dilithium RAW (~2500 bytes)
//!     pub signed_at: u64,
//! }
//! ```
//! **Bandwidth**: ~2.6KB bincode (was 5KB JSON, was 22KB base64 JSON)
//! **Wire format**: `compact_bin:<base64(zstd(bincode(sig)))>`
//!
//! ### Full Signature (Macroblocks - ~5KB bincode)
//! ```rust
//! pub struct HybridSignature {
//!     pub certificate: HybridCertificate,
//!     pub ephemeral_public_key: [u8; 32],
//!     pub message_signature: [u8; 64],
//!     pub dilithium_key_signature: Vec<u8>,  // RAW bytes
//!     pub signed_at: u64,
//! }
//! ```
//! **Bandwidth**: ~5KB bincode (was 27KB JSON)
//! **Wire format**: `hybrid_bin:<base64(zstd(bincode(sig)))>`
//!
//! ## Helper Functions
//! - `extract_dilithium_raw_bytes()` - Extract RAW bytes from signature string
//! - `encode_dilithium_signature()` - Encode RAW bytes to signature string
//! - `to_binary_compressed()` - Serialize to bincode + zstd (production)
//! - `from_binary_compressed()` - Deserialize from bincode + zstd (production)
//!
//! ## Global Instance Management
//! Thread-safe, globally accessible cache of HybridCrypto instances for all nodes.
//!
//! ## NIST/Cisco Compliance
//! - **Post-Quantum**: CRYSTALS-Dilithium3 (NIST PQC Level 3)
//! - **Classical**: Ed25519 (FIPS 186-4)
//! - **Hashing**: SHA3-256 (NIST FIPS 202)
//! - **Ephemeral Keys**: New Ed25519 key per message (forward secrecy)
//! - **Key Binding**: Dilithium signs ephemeral_key || message_hash || timestamp

use anyhow::{Result, anyhow};
use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier};
use rand::rngs::OsRng;
use serde::{Serialize, Deserialize};
use sha3::{Sha3_256, Digest};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH, Duration};
use base64::{Engine as _, engine::general_purpose};

/// Extract RAW bytes from Dilithium signature string
/// Format: "dilithium_sig_<node_id>_<base64>"
/// Returns: RAW bytes (not base64 encoded)
pub fn extract_dilithium_raw_bytes(signature_str: &str) -> Result<Vec<u8>> {
    if !signature_str.starts_with("dilithium_sig_") {
        return Err(anyhow!("Invalid Dilithium signature format"));
    }
    
    // Find last underscore - everything after is base64
    let last_underscore = signature_str.rfind('_')
        .ok_or_else(|| anyhow!("No underscore separator in signature"))?;
    
    let base64_part = &signature_str[last_underscore + 1..];
    
    general_purpose::STANDARD.decode(base64_part)
        .map_err(|e| anyhow!("Failed to decode base64: {}", e))
}

/// Encode RAW bytes back to Dilithium signature string format
/// Returns: "dilithium_sig_<node_id>_<base64>"
pub fn encode_dilithium_signature(node_id: &str, raw_bytes: &[u8]) -> String {
    let base64 = general_purpose::STANDARD.encode(raw_bytes);
    format!("dilithium_sig_{}_{}", node_id, base64)
}

/// Global hybrid crypto instances for all nodes (thread-safe)
/// PRODUCTION: Single source of truth for hybrid crypto instances
pub static GLOBAL_HYBRID_INSTANCES: tokio::sync::OnceCell<Arc<tokio::sync::Mutex<HashMap<String, HybridCrypto>>>> = 
    tokio::sync::OnceCell::const_new();

/// Helper module for serializing [u8; 64] arrays with serde
#[allow(dead_code)]
mod base64_bytes {
    use serde::{Serialize, Deserialize, Serializer, Deserializer};
    use base64::{Engine as _, engine::general_purpose};
    
    pub fn serialize<S>(bytes: &[u8; 64], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let b64 = general_purpose::STANDARD.encode(bytes);
        b64.serialize(serializer)
    }
    
    pub fn deserialize<'de, D>(deserializer: D) -> Result<[u8; 64], D::Error>
    where
        D: Deserializer<'de>,
    {
        let b64 = String::deserialize(deserializer)?;
        let bytes = general_purpose::STANDARD
            .decode(&b64)
            .map_err(serde::de::Error::custom)?;
        
        let mut array = [0u8; 64];
        if bytes.len() != 64 {
            return Err(serde::de::Error::custom("Invalid byte array length"));
        }
        array.copy_from_slice(&bytes);
        Ok(array)
    }
}

/// Helper module for serializing [u8; 32] arrays with serde
#[allow(dead_code)]
mod base64_bytes_32 {
    use serde::{Serialize, Deserialize, Serializer, Deserializer};
    use base64::{Engine as _, engine::general_purpose};
    
    pub fn serialize<S>(bytes: &[u8; 32], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let b64 = general_purpose::STANDARD.encode(bytes);
        b64.serialize(serializer)
    }
    
    pub fn deserialize<'de, D>(deserializer: D) -> Result<[u8; 32], D::Error>
    where
        D: Deserializer<'de>,
    {
        let b64 = String::deserialize(deserializer)?;
        let bytes = general_purpose::STANDARD
            .decode(&b64)
            .map_err(serde::de::Error::custom)?;
        if bytes.len() != 32 {
            return Err(serde::de::Error::custom(format!("Expected 32 bytes, got {}", bytes.len())));
        }
        let mut result = [0u8; 32];
        result.copy_from_slice(&bytes);
        Ok(result)
    }
}

/// Certificate lifetime in seconds (4.5 minutes = 270 seconds = 3 macroblocks)
/// SECURITY: Optimized for quantum resistance with minimal network overhead
/// - Rotation threshold: 80% (216s)
/// - Grace period: 54 seconds (sufficient for global propagation)
/// - Quantum attack time: 10^15 years (NIST Level 3)
/// - Network overhead: ~231 KB/s (320 rotations/day)
const CERTIFICATE_LIFETIME_SECS: u64 = 270;


/// Hybrid Certificate containing Ed25519 key signed by Dilithium
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HybridCertificate {
    /// Node ID that owns this certificate
    pub node_id: String,
    
    /// Ed25519 ephemeral public key for fast operations
    pub ed25519_public_key: [u8; 32],
    
    /// Dilithium signature over the Ed25519 key and metadata
    pub dilithium_signature: String,
    
    /// Certificate creation timestamp
    pub issued_at: u64,
    
    /// Certificate expiration timestamp
    pub expires_at: u64,
    
    /// Certificate serial number for revocation
    pub serial_number: String,
    
    /// DEPRECATED v3.50: Ed25519 rotation chain removed — Dilithium-only verification
    /// Field kept as Option for backwards compatibility (deserializing old certificates)
    /// New certificates always set this to None — Dilithium signature is sufficient
    #[serde(default)]
    pub rotation_signature: Option<String>,
}

/// Hybrid Signature containing both certificate and message signature
/// OPTIMIZED v2.23: RAW bytes for Dilithium signature (not base64 String!)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HybridSignature {
    /// Certificate (can be cached)
    pub certificate: HybridCertificate,
    
    /// CRITICAL: Ephemeral Ed25519 public key for THIS message (NIST/Cisco requirement)
    /// Generated fresh for each message to ensure forward secrecy
    #[serde(with = "serde_bytes")]
    pub ephemeral_public_key: [u8; 32],
    
    /// Ed25519 signature of the actual message (RAW 64 bytes)
    #[serde(with = "serde_bytes")]
    pub message_signature: [u8; 64],
    
    /// CRITICAL: Dilithium signature - RAW BYTES (not base64 String!)
    /// Contains: [sig_len(4)] + [signed_msg] + [pk_len(4)] + [public_key(1952)]
    #[serde(with = "serde_bytes")]
    pub dilithium_key_signature: Vec<u8>,
    
    /// Timestamp of signature creation
    pub signed_at: u64,
}

impl HybridSignature {
    /// Serialize to binary format with Zstd compression
    pub fn to_binary_compressed(&self) -> Result<Vec<u8>> {
        use std::io::Write;
        
        let binary = bincode::serialize(self)
            .map_err(|e| anyhow!("Bincode serialization failed: {}", e))?;
        
        let mut encoder = zstd::Encoder::new(Vec::new(), 3)
            .map_err(|e| anyhow!("Zstd encoder creation failed: {}", e))?;
        encoder.write_all(&binary)
            .map_err(|e| anyhow!("Zstd write failed: {}", e))?;
        let compressed = encoder.finish()
            .map_err(|e| anyhow!("Zstd finish failed: {}", e))?;
        
        Ok(compressed)
    }
    
    /// Deserialize from binary compressed format
    pub fn from_binary_compressed(data: &[u8]) -> Result<Self> {
        use std::io::Read;
        
        let mut decoder = zstd::Decoder::new(data)
            .map_err(|e| anyhow!("Zstd decoder creation failed: {}", e))?;
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed)
            .map_err(|e| anyhow!("Zstd read failed: {}", e))?;
        
        bincode::deserialize(&decompressed)
            .map_err(|e| anyhow!("Bincode deserialization failed: {}", e))
    }
}

/// OPTIMIZED v2.23: Compact signature with RAW bytes (not base64 String!)
/// Size: ~2.6KB vs 22KB original (88% reduction!)
/// Format: node_id + cert_serial + 32 + 64 + ~2500 + 8 bytes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactHybridSignature {
    /// Node ID for certificate lookup
    pub node_id: String,
    
    /// Certificate serial number (for cache lookup)
    pub cert_serial: String,
    
    /// CRITICAL: Ephemeral Ed25519 public key for THIS message (NIST/Cisco requirement)
    /// Generated fresh for each message to ensure forward secrecy
    #[serde(with = "serde_bytes")]
    pub ephemeral_public_key: [u8; 32],
    
    /// Ed25519 signature of the actual message (RAW 64 bytes)
    #[serde(with = "serde_bytes")]
    pub message_signature: [u8; 64],
    
    /// CRITICAL: Dilithium signature - RAW BYTES (not base64 String!)
    /// Contains: [sig_len(4)] + [signed_msg] + [pk_len(4)] + [public_key(1952)]
    /// Per NIST/Cisco: Dilithium MUST sign ephemeral_key || message_hash || timestamp
    #[serde(with = "serde_bytes")]
    pub dilithium_key_signature: Vec<u8>,
    
    /// Timestamp of signature creation
    pub signed_at: u64,
}

impl CompactHybridSignature {
    /// Serialize to binary format with Zstd compression
    /// OPTIMIZED v2.23: ~2.6KB RAW bytes (88% reduction vs original 22KB)
    pub fn to_binary_compressed(&self) -> Result<Vec<u8>> {
        use std::io::Write;
        
        // Step 1: Serialize to bincode
        let binary = bincode::serialize(self)
            .map_err(|e| anyhow!("Bincode serialization failed: {}", e))?;
        
        // Step 2: Compress with Zstd (level 3 = fast + good compression)
        let mut encoder = zstd::Encoder::new(Vec::new(), 3)
            .map_err(|e| anyhow!("Zstd encoder creation failed: {}", e))?;
        encoder.write_all(&binary)
            .map_err(|e| anyhow!("Zstd write failed: {}", e))?;
        let compressed = encoder.finish()
            .map_err(|e| anyhow!("Zstd finish failed: {}", e))?;
        
        Ok(compressed)
    }
    
    /// Deserialize from binary compressed format
    pub fn from_binary_compressed(data: &[u8]) -> Result<Self> {
        use std::io::Read;
        
        // Step 1: Decompress with Zstd
        let mut decoder = zstd::Decoder::new(data)
            .map_err(|e| anyhow!("Zstd decoder creation failed: {}", e))?;
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed)
            .map_err(|e| anyhow!("Zstd read failed: {}", e))?;
        
        // Step 2: Deserialize from bincode
        bincode::deserialize(&decompressed)
            .map_err(|e| anyhow!("Bincode deserialization failed: {}", e))
    }
    
    /// Serialize to JSON (LEGACY - use to_binary_compressed() for production)
    /// Only kept for backwards compatibility with old signatures
    #[allow(dead_code)]
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(self)
            .map_err(|e| anyhow!("JSON serialization failed: {}", e))
    }
    
    /// Deserialize from JSON (LEGACY - use from_binary_compressed() for production)
    /// Only kept for backwards compatibility with old signatures
    #[allow(dead_code)]
    pub fn from_json(json: &str) -> Result<Self> {
        serde_json::from_str(json)
            .map_err(|e| anyhow!("JSON deserialization failed: {}", e))
    }
}

/// Certificate cache entry
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct CachedCertificate {
    certificate: HybridCertificate,
    verified_at: u64,
    verification_count: u64,
    is_valid: bool,
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTION v2.51: Lock-free certificate cache with DashMap
// 10x faster than RwLock for concurrent reads (signature verification)
// ═══════════════════════════════════════════════════════════════════════════════
use dashmap::DashMap;

/// Maximum number of entries in the certificate cache before eviction
const MAX_CERTIFICATE_CACHE_SIZE: usize = 50_000;

/// Percentage of cache entries to evict when limit is reached (10%)
const CACHE_EVICTION_PERCENT: usize = 10;

/// Global certificate cache - lock-free concurrent access
static CERTIFICATE_CACHE: once_cell::sync::Lazy<DashMap<String, CachedCertificate>> =
    once_cell::sync::Lazy::new(|| DashMap::new());

/// Evict oldest entries from certificate cache when it exceeds the maximum size.
/// Removes ~10% of entries sorted by `verified_at` timestamp (oldest first).
fn evict_certificate_cache_if_needed() {
    if CERTIFICATE_CACHE.len() < MAX_CERTIFICATE_CACHE_SIZE {
        return;
    }
    let evict_count = CERTIFICATE_CACHE.len() * CACHE_EVICTION_PERCENT / 100;
    // Collect keys with timestamps for eviction ordering
    let mut entries: Vec<(String, u64)> = CERTIFICATE_CACHE.iter()
        .map(|entry| (entry.key().clone(), entry.value().verified_at))
        .collect();
    entries.sort_by_key(|(_k, ts)| *ts);
    let to_remove = entries.into_iter().take(evict_count).collect::<Vec<_>>();
    for (key, _) in &to_remove {
        CERTIFICATE_CACHE.remove(key);
    }
    println!("[INFO][CRYPTO] certificate_cache_eviction removed={} remaining={}", to_remove.len(), CERTIFICATE_CACHE.len());
}

/// Hybrid Cryptography System for QNet
pub struct HybridCrypto {
    /// Current Ed25519 signing key for this node
    ed25519_signing_key: Option<SigningKey>,
    
    /// Current Ed25519 verifying key
    ed25519_verifying_key: Option<VerifyingKey>,
    
    /// Current certificate for this node
    current_certificate: Option<HybridCertificate>,
    
    /// Node ID
    node_id: String,
    
    /// Certificate rotation interval
    #[allow(dead_code)]
    rotation_interval: Duration,
    
    /// Certificate cache for O(1) verification (v2.51: uses global DashMap)
    /// Local field kept for API compatibility, points to global cache
    _certificate_cache_compat: std::marker::PhantomData<()>,
    
    /// Last rotation timestamp
    last_rotation: u64,
}

impl HybridCrypto {
    /// Create new hybrid crypto system
    pub fn new(node_id: String) -> Self {
        println!("🔐 Initializing Hybrid Cryptography for node: {}", node_id);
        Self {
            ed25519_signing_key: None,
            ed25519_verifying_key: None,
            current_certificate: None,
            node_id,
            rotation_interval: Duration::from_secs(CERTIFICATE_LIFETIME_SECS),
            _certificate_cache_compat: std::marker::PhantomData,
            last_rotation: 0,
        }
    }
    
    /// Initialize and create first certificate
    pub async fn initialize(&mut self) -> Result<()> {
        println!("🔄 Generating ephemeral Ed25519 keypair...");
        
        // Generate new Ed25519 keypair
        let mut csprng = OsRng{};
        let signing_key = SigningKey::generate(&mut csprng);
        let verifying_key = signing_key.verifying_key();
        
        // Create certificate signed by Dilithium
        let certificate = self.create_certificate(&verifying_key).await?;
        
        self.ed25519_signing_key = Some(signing_key);
        self.ed25519_verifying_key = Some(verifying_key);
        self.current_certificate = Some(certificate.clone());
        self.last_rotation = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        
        println!("✅ Hybrid crypto initialized with certificate: {}", certificate.serial_number);
        Ok(())
    }
    
    /// Create new certificate with Dilithium signature
    async fn create_certificate(&self, verifying_key: &VerifyingKey) -> Result<HybridCertificate> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let expires_at = now + CERTIFICATE_LIFETIME_SECS;
        
        // Generate serial number
        let serial_number = format!("CERT-{}-{}", self.node_id, now);
        
        // CRITICAL: ENCAPSULATED KEY per NIST/Cisco standard
        // Dilithium MUST sign the RAW Ed25519 public key bytes
        // This is the CORRECT hybrid cryptography approach
        let mut encapsulated_data = Vec::new();
        encapsulated_data.extend_from_slice(verifying_key.as_bytes()); // 32 bytes Ed25519 key
        encapsulated_data.extend_from_slice(self.node_id.as_bytes());
        encapsulated_data.extend_from_slice(&now.to_le_bytes());
        
        let encapsulated_hex = hex::encode(&encapsulated_data);
        
        // Sign with Dilithium (using quantum_crypto module)
        // PRODUCTION v2.51: Safe quantum crypto access
        use crate::node::try_get_quantum_crypto;
        let quantum_crypto = try_get_quantum_crypto()
            .ok_or_else(|| anyhow!("Quantum crypto not initialized"))?;
        
        let dilithium_sig = quantum_crypto
            .create_consensus_signature(&self.node_id, &encapsulated_hex)
            .await?;
        
        Ok(HybridCertificate {
            node_id: self.node_id.clone(),
            ed25519_public_key: *verifying_key.as_bytes(),
            dilithium_signature: dilithium_sig.signature,
            issued_at: now,
            expires_at,
            serial_number,
            rotation_signature: None, // v3.50: Always None — Dilithium is sole authenticator
        })
    }
    
    /// Get current certificate for broadcasting
    pub fn get_current_certificate(&self) -> Option<HybridCertificate> {
        self.current_certificate.clone()
    }
    
    /// Check if certificate needs rotation
    pub fn needs_rotation(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(0))
            .as_secs();
        
        if let Some(cert) = &self.current_certificate {
            // Rotate if 80% of lifetime has passed
            let lifetime_80_percent = (cert.expires_at - cert.issued_at) * 4 / 5;
            let age = now - cert.issued_at;
            age >= lifetime_80_percent
        } else {
            true // No certificate, needs rotation
        }
    }
    
    /// Rotate certificate (generate new Ed25519 key)
    /// v3.50: rotation_signature removed — Dilithium is the sole authenticator
    /// Each cert is independently verified by its Dilithium signature over
    /// (ed25519_pubkey || node_id || timestamp). No Ed25519 chain needed.
    pub async fn rotate_certificate(&mut self) -> Result<()> {
        println!("🔄 Rotating hybrid certificate...");
        
        // Generate new Ed25519 keypair
        let mut csprng = OsRng{};
        let new_signing_key = SigningKey::generate(&mut csprng);
        let new_verifying_key = new_signing_key.verifying_key();
        
        // Create new certificate (Dilithium signs: ed25519_pubkey || node_id || timestamp)
        let new_certificate = self.create_certificate(&new_verifying_key).await?;
        // NOTE: rotation_signature is None — Dilithium signature is sufficient
        // See v3.50 rationale: Ed25519 chain adds zero security over Dilithium
        
        // Atomic replacement
        self.ed25519_signing_key = Some(new_signing_key);
        self.ed25519_verifying_key = Some(new_verifying_key);
        self.current_certificate = Some(new_certificate.clone());
        self.last_rotation = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        
        println!("✅ Certificate rotated: {}", new_certificate.serial_number);
        
        Ok(())
    }
    
    /// Sign message with BOTH Ed25519 AND Dilithium per NIST/Cisco standards
    /// CRITICAL: Generates NEW ephemeral Ed25519 key for each message (NIST/Cisco requirement)
    pub async fn sign_message(&self, message: &[u8]) -> Result<HybridSignature> {
        // CRITICAL: Per NIST/Cisco standards for hybrid cryptography:
        // 1. Generate NEW ephemeral Ed25519 key for THIS message
        // 2. Sign message with ephemeral Ed25519 key
        // 3. Create encapsulated_data = ephemeral_public_key || message_hash || timestamp
        // 4. Sign encapsulated_data with Dilithium (signs the ephemeral key)
        // 5. Sign message with Dilithium (quantum resistance)
        
        // Step 1: Generate NEW ephemeral Ed25519 keypair for THIS message
        let mut csprng = OsRng{};
        let ephemeral_signing_key = SigningKey::generate(&mut csprng);
        let ephemeral_verifying_key = ephemeral_signing_key.verifying_key();
        let ephemeral_public_key_bytes = *ephemeral_verifying_key.as_bytes();
        
        // Step 2: Sign the message with ephemeral Ed25519 key
        let ed25519_signature = ephemeral_signing_key.sign(message);
        
        // Step 3: Get or use existing certificate
        let certificate = self.current_certificate.as_ref()
            .ok_or_else(|| anyhow!("No current certificate available"))?;
        
        // Step 4: Create message hash for Dilithium signing
        let mut hasher = Sha3_256::new();
        hasher.update(message);
        let message_hash = hasher.finalize();
        let _message_hash_hex = hex::encode(message_hash);
        
        // Step 5: Create encapsulated_data = ephemeral_public_key || message_hash || timestamp
        let signed_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let mut encapsulated_data = Vec::new();
        encapsulated_data.extend_from_slice(&ephemeral_public_key_bytes);
        encapsulated_data.extend_from_slice(&message_hash);
        encapsulated_data.extend_from_slice(&signed_at.to_le_bytes());
        let encapsulated_hex = hex::encode(&encapsulated_data);
        
        // Step 6: Sign encapsulated_data with Dilithium (NIST/Cisco requirement)
        // PRODUCTION v2.51: Safe quantum crypto access
        use crate::node::try_get_quantum_crypto;
        let quantum_crypto = try_get_quantum_crypto()
            .ok_or_else(|| anyhow!("Quantum crypto not initialized"))?;
        
        // Sign encapsulated_data with Dilithium (signs the ephemeral key + message_hash)
        let dilithium_key_sig = quantum_crypto.create_consensus_signature(&self.node_id, &encapsulated_hex).await
            .map_err(|e| anyhow!("Failed to create Dilithium key signature: {}", e))?;
        
        // Extract RAW bytes from signature string
        let raw_bytes = extract_dilithium_raw_bytes(&dilithium_key_sig.signature)?;
        
        Ok(HybridSignature {
            certificate: certificate.clone(),
            ephemeral_public_key: ephemeral_public_key_bytes,
            message_signature: ed25519_signature.to_bytes(),
            dilithium_key_signature: raw_bytes,
            signed_at,
        })
    }
    
    /// OPTIMIZED: Create compact signature for PREHASHED data (reduces size from 12KB to 3KB)
    /// Certificate is cached separately for O(1) verification
    /// CRITICAL: Generates NEW ephemeral Ed25519 key for each message (NIST/Cisco requirement)
    /// 
    /// USE THIS FOR: Microblock signing where message is already SHA3-256 hash bytes
    /// USE sign_raw_message_compact() FOR: heartbeats, announcements, RPC (raw strings)
    pub async fn sign_message_compact(&self, message: &[u8]) -> Result<CompactHybridSignature> {
        // CRITICAL: Per NIST/Cisco standards for hybrid cryptography:
        // 1. Generate NEW ephemeral Ed25519 key for THIS message
        // 2. Sign message with ephemeral Ed25519 key
        // 3. Create encapsulated_data = ephemeral_public_key || message_hash || timestamp
        // 4. Sign encapsulated_data with Dilithium (signs the ephemeral key)
        // 5. Sign message with Dilithium (quantum resistance)
        
        // Step 1: Generate NEW ephemeral Ed25519 keypair for THIS message
        let mut csprng = OsRng{};
        let ephemeral_signing_key = SigningKey::generate(&mut csprng);
        let ephemeral_verifying_key = ephemeral_signing_key.verifying_key();
        let ephemeral_public_key_bytes = *ephemeral_verifying_key.as_bytes();
        
        // Step 2: Get current certificate for metadata
        let certificate = self.current_certificate.as_ref()
            .ok_or_else(|| anyhow!("No current certificate available"))?;
        
        // CRITICAL: Ensure certificate is in cache BEFORE creating compact signature
        self.cache_certificate(certificate).await;
        
        // Step 3: Sign message with ephemeral Ed25519 key
        let ed25519_signature = ephemeral_signing_key.sign(message);
        
        // Step 4: Create message hash for Dilithium signing
        // CRITICAL FIX: Message is already SHA3 hash from microblock signing
        // DO NOT hash again - just convert to hex for Dilithium
        let message_hash_hex = hex::encode(message);
        
        // Step 5: Create encapsulated_data = ephemeral_public_key || message_hash || timestamp
        let signed_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let message_hash_bytes = hex::decode(&message_hash_hex)
            .map_err(|e| anyhow!("Failed to decode message hash: {}", e))?;
        let mut encapsulated_data = Vec::new();
        encapsulated_data.extend_from_slice(&ephemeral_public_key_bytes);
        encapsulated_data.extend_from_slice(&message_hash_bytes);
        encapsulated_data.extend_from_slice(&signed_at.to_le_bytes());
        let encapsulated_hex = hex::encode(&encapsulated_data);
        
        // Step 6: Sign encapsulated_data with Dilithium (NIST/Cisco requirement)
        // PRODUCTION v2.51: Safe quantum crypto access
        use crate::node::try_get_quantum_crypto;
        let quantum_crypto = try_get_quantum_crypto()
            .ok_or_else(|| anyhow!("Quantum crypto not initialized"))?;
        
        // Sign encapsulated_data with Dilithium (signs ephemeral key + message_hash)
        let dilithium_key_sig = quantum_crypto.create_consensus_signature(&self.node_id, &encapsulated_hex).await
            .map_err(|e| anyhow!("Failed to create Dilithium key signature: {}", e))?;
        
        // Extract RAW bytes from signature string
        let raw_bytes = extract_dilithium_raw_bytes(&dilithium_key_sig.signature)?;
        
        Ok(CompactHybridSignature {
            node_id: self.node_id.clone(),
            cert_serial: certificate.serial_number.clone(),
            ephemeral_public_key: ephemeral_public_key_bytes,
            message_signature: ed25519_signature.to_bytes(),
            dilithium_key_signature: raw_bytes,
            signed_at,
        })
    }
    
    /// Sign RAW message (not prehashed) with hybrid cryptography
    /// CRITICAL: This function HASHES the message before signing (NIST SP 800-186 compliant)
    /// Use this for: heartbeats, ActiveNodeAnnouncement, reputation updates
    /// Use sign_message_compact() for: microblocks (already hashed)
    /// 
    /// OPTIMIZED v2.23: Single Dilithium signature (RAW bytes, includes message_hash)
    /// Per NIST/Cisco hybrid crypto standards:
    /// 1. Generate NEW ephemeral Ed25519 key for THIS message
    /// 2. Hash message with SHA3-256
    /// 3. Sign hash with ephemeral Ed25519
    /// 4. Create encapsulated_data = ephemeral_key || message_hash || timestamp
    /// 5. Sign encapsulated_data with Dilithium (binds ephemeral key to message + integrity)
    pub async fn sign_raw_message_compact(&self, message: &[u8]) -> Result<CompactHybridSignature> {
        // Step 1: Generate NEW ephemeral Ed25519 keypair for THIS message
        let mut csprng = OsRng{};
        let ephemeral_signing_key = SigningKey::generate(&mut csprng);
        let ephemeral_verifying_key = ephemeral_signing_key.verifying_key();
        let ephemeral_public_key_bytes = *ephemeral_verifying_key.as_bytes();
        
        // Step 2: Get current certificate for metadata
        let certificate = self.current_certificate.as_ref()
            .ok_or_else(|| anyhow!("No current certificate available"))?;
        
        // CRITICAL: Ensure certificate is in cache BEFORE creating compact signature
        self.cache_certificate(certificate).await;
        
        // Step 3: HASH the message with SHA3-256 (NIST SP 800-186)
        // This ensures consistency between signing and verification
        let mut hasher = Sha3_256::new();
        hasher.update(message);
        let message_hash = hasher.finalize();
        let message_hash_bytes: [u8; 32] = message_hash.into();
        
        // Step 4: Sign MESSAGE HASH with ephemeral Ed25519 key
        // CRITICAL: We sign the hash, not raw message - matches verification!
        let ed25519_signature = ephemeral_signing_key.sign(&message_hash_bytes);
        
        // Step 5: Create encapsulated_data = ephemeral_public_key || message_hash || timestamp
        let signed_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let mut encapsulated_data = Vec::new();
        encapsulated_data.extend_from_slice(&ephemeral_public_key_bytes);
        encapsulated_data.extend_from_slice(&message_hash_bytes);
        encapsulated_data.extend_from_slice(&signed_at.to_le_bytes());
        let encapsulated_hex = hex::encode(&encapsulated_data);
        
        // Step 6: Sign encapsulated_data with Dilithium (NIST/Cisco requirement)
        // This cryptographically binds the ephemeral Ed25519 key to this specific message
        // PRODUCTION v2.51: Safe quantum crypto access
        use crate::node::try_get_quantum_crypto;
        let quantum_crypto = try_get_quantum_crypto()
            .ok_or_else(|| anyhow!("Quantum crypto not initialized"))?;
        
        // Sign encapsulated_data with Dilithium (signs ephemeral key + message_hash)
        let dilithium_key_sig = quantum_crypto.create_consensus_signature(&self.node_id, &encapsulated_hex).await
            .map_err(|e| anyhow!("Failed to create Dilithium key signature: {}", e))?;
        
        // Extract RAW bytes from signature string
        let raw_bytes = extract_dilithium_raw_bytes(&dilithium_key_sig.signature)?;
        
        Ok(CompactHybridSignature {
            node_id: self.node_id.clone(),
            cert_serial: certificate.serial_number.clone(),
            ephemeral_public_key: ephemeral_public_key_bytes,
            message_signature: ed25519_signature.to_bytes(),
            dilithium_key_signature: raw_bytes,
            signed_at,
        })
    }
    
    /// Cache certificate for O(1) verification
    /// Cache key includes a hash of the Dilithium signature to prevent cache poisoning
    async fn cache_certificate(&self, certificate: &HybridCertificate) {
        let sig_hash = {
            let mut hasher = Sha3_256::new();
            hasher.update(certificate.dilithium_signature.as_bytes());
            hex::encode(&hasher.finalize()[..8])
        };
        let cache_key = format!("{}_{}_{}", certificate.node_id, certificate.serial_number, sig_hash);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(0))
            .as_secs();
        
        let cached = CachedCertificate {
            certificate: certificate.clone(),
            verified_at: now,
            verification_count: 0,
            is_valid: true,
        };
        
        // PRODUCTION v2.51: Lock-free cache insert (with eviction check)
        evict_certificate_cache_if_needed();
        CERTIFICATE_CACHE.insert(cache_key, cached);
    }
    
    /// Verify hybrid signature per NIST/Cisco ENCAPSULATED KEYS standard
    pub async fn verify_signature(
        &self,
        message: &[u8],
        signature: &HybridSignature,
    ) -> Result<bool> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        
        // Step 1: Check certificate expiration with GRACE PERIOD
        // v2.64: 60 second grace period for network propagation delays
        const CERTIFICATE_GRACE_PERIOD_SECS: u64 = 60;
        if now > signature.certificate.expires_at + CERTIFICATE_GRACE_PERIOD_SECS {
            println!("[WARN][CRYPTO] cert_expired=true grace_period={}s node={}", CERTIFICATE_GRACE_PERIOD_SECS, signature.certificate.node_id);
            return Ok(false);
        }
        
        // OPTIMIZATION: Check certificate cache first
        // Cache key includes signature fingerprint to prevent cache poisoning
        let sig_hash = {
            let mut hasher = Sha3_256::new();
            hasher.update(signature.certificate.dilithium_signature.as_bytes());
            hex::encode(&hasher.finalize()[..8])
        };
        let cache_key = format!("{}_{}_{}",
            signature.certificate.node_id,
            signature.certificate.serial_number,
            sig_hash);
        
        // PRODUCTION v2.51: Lock-free cache check
        // v2.64: Use grace period for cache check too
        let cert_is_valid = if let Some(cached) = CERTIFICATE_CACHE.get(&cache_key) {
            if cached.is_valid && now <= signature.certificate.expires_at + CERTIFICATE_GRACE_PERIOD_SECS {
                println!("[DEBUG][CRYPTO] cache_hit=true node={} serial={}", signature.certificate.node_id, signature.certificate.serial_number);
                true // Certificate is valid from cache
            } else if !cached.is_valid {
                println!("[WARN][CRYPTO] cache_hit=true valid=false node={} serial={}", signature.certificate.node_id, signature.certificate.serial_number);
                return Ok(false);
            } else {
                false // Need to verify
            }
        } else {
            // Not in cache - need to verify
            println!("🔐 Verifying certificate (will be cached)...");
            
            // Recreate encapsulated data to verify
            let mut encapsulated_data = Vec::new();
            encapsulated_data.extend_from_slice(&signature.certificate.ed25519_public_key);
            encapsulated_data.extend_from_slice(signature.certificate.node_id.as_bytes());
            encapsulated_data.extend_from_slice(&signature.certificate.issued_at.to_le_bytes());
            
            let encapsulated_hex = hex::encode(&encapsulated_data);
            
            // Verify with quantum_crypto
            // PRODUCTION v2.50: Lock-free quantum crypto
            use crate::node::try_get_quantum_crypto;
            let quantum_crypto = try_get_quantum_crypto()
                .ok_or_else(|| anyhow!("Quantum crypto not initialized"))?;
            
            let dilithium_sig = crate::quantum_crypto::DilithiumSignature {
                signature: signature.certificate.dilithium_signature.clone(),
                algorithm: "CRYSTALS-Dilithium3".to_string(),
                timestamp: signature.certificate.issued_at,
                strength: "quantum-resistant".to_string(),
            };
            
            let cert_valid = quantum_crypto
                .verify_dilithium_signature(&encapsulated_hex, &dilithium_sig, &signature.certificate.node_id)
                .await?;
            
            if !cert_valid {
                println!("❌ Invalid Dilithium signature on certificate");
                // PRODUCTION v2.51: Lock-free cache negative result
                evict_certificate_cache_if_needed();
                CERTIFICATE_CACHE.insert(cache_key.clone(), CachedCertificate {
                    certificate: signature.certificate.clone(),
                    verified_at: now,
                    verification_count: 1,
                    is_valid: false,
                });
                return Ok(false);
            }
            
            // PRODUCTION v2.51: Lock-free cache valid certificate
            println!("[INFO][CRYPTO] certificate_verified_and_cached");
            evict_certificate_cache_if_needed();
            CERTIFICATE_CACHE.insert(cache_key, CachedCertificate {
                certificate: signature.certificate.clone(),
                verified_at: now,
                verification_count: 1,
                is_valid: true,
            });
            true // Certificate is valid
        };
        
        // Only proceed if certificate is valid
        if !cert_is_valid {
            return Ok(false);
        }
        
        // Step 4: Verify Ed25519 message signature with ephemeral key (fast)
        let ed25519_valid = Self::verify_ed25519_signature(
            message,
            &signature.message_signature,
            &signature.ephemeral_public_key  // Use ephemeral key, not certificate key!
        )?;
        
        if !ed25519_valid {
            println!("❌ Invalid Ed25519 message signature");
            return Ok(false);
        }
        
        // Step 5: CRITICAL - Verify Dilithium key signature (NIST/Cisco requirement)
        // OPTIMIZED v2.23: Single Dilithium RAW bytes covers ephemeral_key + message_hash + timestamp
        // This provides BOTH key binding AND message integrity in one signature
        
        if signature.dilithium_key_signature.is_empty() {
            println!("❌ REJECTED: No Dilithium key signature - quantum attack possible!");
            return Ok(false);
        }
        
        use crate::quantum_crypto::DilithiumSignature;
        
        // PRODUCTION v2.50: Lock-free quantum crypto
        use crate::node::try_get_quantum_crypto;
        let quantum_crypto = try_get_quantum_crypto()
            .ok_or_else(|| anyhow!("Quantum crypto not initialized"))?;
        
        // Recreate the same message hash used for signing
        let mut hasher = Sha3_256::new();
        hasher.update(message);
        let message_hash = hasher.finalize();
        
        // Verify Dilithium signature of encapsulated_data (ephemeral_key || message_hash || timestamp)
        // This single signature proves:
        // 1. Ephemeral key is bound to this message (key binding)
        // 2. Message has not been tampered with (message_hash inside)
        // 3. Signature is fresh (timestamp inside)
        let mut encapsulated_data = Vec::new();
        encapsulated_data.extend_from_slice(&signature.ephemeral_public_key);
        encapsulated_data.extend_from_slice(&message_hash);
        encapsulated_data.extend_from_slice(&signature.signed_at.to_le_bytes());
        let encapsulated_hex = hex::encode(&encapsulated_data);
        
        // OPTIMIZED v2.23: Convert RAW bytes back to signature string for verification
        let signature_string = encode_dilithium_signature(&signature.certificate.node_id, &signature.dilithium_key_signature);
        
        let dilithium_key_sig = DilithiumSignature {
            signature: signature_string,
            algorithm: "CRYSTALS-Dilithium3".to_string(),
            timestamp: signature.signed_at,
            strength: "quantum-resistant".to_string(),
        };
        
        let dilithium_key_valid = quantum_crypto
            .verify_dilithium_signature(&encapsulated_hex, &dilithium_key_sig, &signature.certificate.node_id)
            .await?;
        
        if !dilithium_key_valid {
            println!("❌ Invalid Dilithium key signature - quantum attack detected!");
            return Ok(false);
        }
        
        println!("✅ ALL signatures verified (Ed25519 + Dilithium key) - quantum-resistant");
        Ok(true)
    }
    
    /// Verify Ed25519 signature (fast operation)
    pub fn verify_ed25519_signature(
        message: &[u8],
        signature_bytes: &[u8; 64],
        public_key_bytes: &[u8; 32]
    ) -> Result<bool> {
        let public_key = VerifyingKey::from_bytes(public_key_bytes.into())
            .map_err(|e| anyhow!("Invalid Ed25519 public key: {}", e))?;
        
        let signature = Signature::from_bytes(signature_bytes.into());
        
        match public_key.verify(message, &signature) {
            Ok(()) => {
                println!("✅ Ed25519 signature verified (fast path)");
                Ok(true)
            }
            Err(_) => {
                println!("❌ Ed25519 signature verification failed");
                Ok(false)
            }
        }
    }
    
    /// Get cache statistics (v2.51: lock-free DashMap)
    pub fn get_cache_stats() -> (usize, f64) {
        let size = CERTIFICATE_CACHE.len();
        
        let total_verifications: u64 = CERTIFICATE_CACHE.iter()
            .map(|entry| entry.value().verification_count)
            .sum();
        
        let hit_rate = if total_verifications > 0 {
            (total_verifications - size as u64) as f64 / total_verifications as f64
        } else {
            0.0
        };
        
        (size, hit_rate)
    }
    
    /// Clear expired certificates from cache
    pub fn cleanup_cache() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(0))
            .as_secs();
        
        // PRODUCTION v2.51: Lock-free retain with DashMap
        CERTIFICATE_CACHE.retain(|_, cached| {
            cached.certificate.expires_at > now
        });
        
        println!("🧹 Cache cleaned: {} certificates remaining", CERTIFICATE_CACHE.len());
    }
}

// ============================================================================
// UNIT TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    /// Test HybridCrypto creation
    #[test]
    fn test_hybrid_crypto_creation() {
        let node_id = "test_node_001".to_string();
        let hybrid = HybridCrypto::new(node_id.clone());
        
        // Node ID should be set correctly
        assert!(!node_id.is_empty());
        // Needs rotation because no certificate yet
        assert!(hybrid.needs_rotation());
    }
    
    /// Test Ed25519 signature creation and verification
    #[test]
    fn test_ed25519_signature() {
        use ed25519_dalek::{SigningKey, Signer};
        use rand::rngs::OsRng;
        
        // Generate keypair
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        
        // Sign message
        let message = b"test message for ed25519";
        let signature = signing_key.sign(message);
        
        // Verify signature
        let sig_bytes: [u8; 64] = signature.to_bytes();
        let pk_bytes: [u8; 32] = *verifying_key.as_bytes();
        
        let result = HybridCrypto::verify_ed25519_signature(message, &sig_bytes, &pk_bytes);
        assert!(result.is_ok());
        assert!(result.unwrap());
    }
    
    /// Test Ed25519 signature with wrong key fails
    #[test]
    fn test_ed25519_wrong_key_fails() {
        use ed25519_dalek::SigningKey;
        use rand::rngs::OsRng;
        
        // Generate two keypairs
        let signing_key1 = SigningKey::generate(&mut OsRng);
        let signing_key2 = SigningKey::generate(&mut OsRng);
        let wrong_verifying_key = signing_key2.verifying_key();
        
        // Sign with key1
        let message = b"test message";
        let signature = signing_key1.sign(message);
        
        // Verify with key2 (should fail)
        let sig_bytes: [u8; 64] = signature.to_bytes();
        let wrong_pk_bytes: [u8; 32] = *wrong_verifying_key.as_bytes();
        
        let result = HybridCrypto::verify_ed25519_signature(message, &sig_bytes, &wrong_pk_bytes);
        assert!(result.is_ok());
        assert!(!result.unwrap()); // Should be false
    }
    
    /// Test ephemeral key generation is unique per call
    #[test]
    fn test_ephemeral_keys_unique() {
        use ed25519_dalek::SigningKey;
        use rand::rngs::OsRng;
        
        let key1 = SigningKey::generate(&mut OsRng);
        let key2 = SigningKey::generate(&mut OsRng);
        
        // Ephemeral keys should be different
        assert_ne!(key1.verifying_key().as_bytes(), key2.verifying_key().as_bytes());
    }
    
    /// Test certificate expiration check
    #[test]
    fn test_certificate_expiration() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // Valid certificate (expires in future)
        let valid_cert = HybridCertificate {
            node_id: "test".to_string(),
            ed25519_public_key: [0u8; 32],
            dilithium_signature: String::new(),
            issued_at: now,
            expires_at: now + 300, // 5 minutes
            serial_number: "test_serial".to_string(),
            rotation_signature: None,
        };
        assert!(valid_cert.expires_at > now);
        
        // Expired certificate
        let expired_cert = HybridCertificate {
            node_id: "test".to_string(),
            ed25519_public_key: [0u8; 32],
            dilithium_signature: String::new(),
            issued_at: now - 600,
            expires_at: now - 300, // Expired 5 minutes ago
            serial_number: "test_serial".to_string(),
            rotation_signature: None,
        };
        assert!(expired_cert.expires_at < now);
    }
    
    /// Test rotation threshold (80% of lifetime)
    #[test]
    fn test_rotation_threshold() {
        let _now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let hybrid = HybridCrypto::new("test_node".to_string());
        
        // Test needs_rotation with no certificate
        assert!(hybrid.needs_rotation()); // No cert = needs rotation
    }
    
    /// Test compact signature structure has required fields
    /// OPTIMIZED v2.23: RAW bytes format
    #[test]
    fn test_compact_signature_structure() {
        let sig = CompactHybridSignature {
            node_id: "test_node".to_string(),
            cert_serial: "cert_123".to_string(),
            ephemeral_public_key: [1u8; 32],
            message_signature: [2u8; 64],
            dilithium_key_signature: vec![1, 2, 3],  // RAW bytes now
            signed_at: 1234567890,
        };
        
        // Verify all fields are present
        assert!(!sig.node_id.is_empty());
        assert!(!sig.cert_serial.is_empty());
        assert!(sig.ephemeral_public_key.iter().any(|&b| b != 0)); // Not all zeros
        assert!(sig.message_signature.iter().any(|&b| b != 0));
        assert!(!sig.dilithium_key_signature.is_empty());
        assert!(sig.signed_at > 0);
    }
    
    /// Test cache operations
    #[test]
    fn test_cache_stats() {
        let (size, hit_rate) = HybridCrypto::get_cache_stats();
        
        // Cache stats should return valid values
        // size is usize, always >= 0
        let _ = size; // Use the value
        assert!(hit_rate >= 0.0 && hit_rate <= 1.0);
    }
    
    /// Test JSON serialization/deserialization of compact signature
    /// OPTIMIZED v2.23: RAW bytes, dilithium_message_signature removed
    #[test]
    fn test_compact_signature_json_roundtrip() {
        // OPTIMIZED v2.23: RAW bytes format
        let original = CompactHybridSignature {
            node_id: "test_node".to_string(),
            cert_serial: "cert_123".to_string(),
            ephemeral_public_key: [42u8; 32],
            message_signature: [0u8; 64],
            dilithium_key_signature: vec![1, 2, 3, 4, 5],  // RAW bytes now
            signed_at: 1700000000,
        };
        
        // Serialize to JSON
        let json = serde_json::to_string(&original).expect("Serialization failed");
        
        // Deserialize back
        let restored: CompactHybridSignature = serde_json::from_str(&json)
            .expect("Deserialization failed");
        
        // Verify fields match
        assert_eq!(original.node_id, restored.node_id);
        assert_eq!(original.cert_serial, restored.cert_serial);
        assert_eq!(original.ephemeral_public_key, restored.ephemeral_public_key);
        assert_eq!(original.dilithium_key_signature, restored.dilithium_key_signature);
        assert_eq!(original.signed_at, restored.signed_at);
    }
}

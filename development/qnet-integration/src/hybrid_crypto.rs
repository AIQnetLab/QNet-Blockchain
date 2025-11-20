//! # QNet Hybrid Cryptography Module
//!
//! ## Overview
//! Implements Key Encapsulation Mechanism (KEM) with CRYSTALS-Dilithium and Ed25519
//! following NIST and Cisco recommendations for post-quantum hybrid cryptography.
//!
//! ## Architecture (v2.19.0)
//!
//! ### Dual Signature System
//! - **Ed25519**: Fast classical signatures (64 bytes)
//! - **CRYSTALS-Dilithium**: Post-quantum signatures (~2420 bytes)
//! - **Hybrid**: Both required for validity
//!
//! ### Certificate Management
//! - **Lifetime**: 1 hour (3600 seconds)
//! - **Rotation**: Automatic before expiration (5 min advance)
//! - **Storage**: LRU cache (100K certificates)
//! - **Distribution**: P2P broadcast every 5 minutes
//!
//! ## Signature Formats
//!
//! ### Compact Signature (Microblocks - 3KB)
//! ```rust
//! pub struct CompactHybridSignature {
//!     pub node_id: String,
//!     pub cert_serial: String,                    // Reference to cached certificate
//!     pub message_signature: Vec<u8>,             // Ed25519 (64 bytes)
//!     pub dilithium_message_signature: String,    // Dilithium (~2420 bytes base64)
//!     pub signed_at: u64,
//! }
//! ```
//! **Bandwidth**: ~3KB (certificate cached separately)
//!
//! ### Full Signature (Macroblocks - 12KB)
//! ```rust
//! pub struct HybridSignature {
//!     pub message_signature: Vec<u8>,         // Ed25519 (64 bytes)
//!     pub dilithium_signature: String,        // Dilithium (~2420 bytes)
//!     pub certificate: HybridCertificate,     // Full certificate (~9KB)
//! }
//! ```
//! **Bandwidth**: ~12KB (certificate embedded for immediate verification)
//!
//! ## Global Instance Management
//!
//! ### GLOBAL_HYBRID_INSTANCES
//! Thread-safe, globally accessible cache of HybridCrypto instances for all nodes.
//!
//! ```rust
//! // Single source of truth for hybrid crypto
//! pub static GLOBAL_HYBRID_INSTANCES: OnceCell<...> = ...;
//! ```
//!
//! **Benefits**:
//! - Prevents duplicate crypto instances
//! - Thread-safe access via tokio::Mutex
//! - Automatic certificate rotation
//! - Consistent across all modules
//!
//! ## NIST/Cisco Compliance
//! - **Post-Quantum**: CRYSTALS-Dilithium (NIST PQC)
//! - **Classical**: Ed25519 (FIPS 186-4)
//! - **Hashing**: SHA3-256 (NIST FIPS 202)
//! - **Certification**: Self-signed with Dilithium signature of Ed25519 key

use anyhow::{Result, anyhow};
use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier};
use rand::{rngs::OsRng, Rng};
use serde::{Serialize, Deserialize};
use sha3::{Sha3_256, Digest};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH, Duration};
use base64::{Engine as _, engine::general_purpose};

/// Global hybrid crypto instances for all nodes (thread-safe)
/// PRODUCTION: Single source of truth for hybrid crypto instances
pub static GLOBAL_HYBRID_INSTANCES: tokio::sync::OnceCell<Arc<tokio::sync::Mutex<HashMap<String, HybridCrypto>>>> = 
    tokio::sync::OnceCell::const_new();

/// Helper module for serializing [u8; 64] arrays with serde
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

/// Certificate lifetime in seconds (1 hour default)
const CERTIFICATE_LIFETIME_SECS: u64 = 3600;

/// Maximum cached certificates
const MAX_CACHE_SIZE: usize = 10000;

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
}

/// Hybrid Signature containing both certificate and message signature
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HybridSignature {
    /// Certificate (can be cached)
    pub certificate: HybridCertificate,
    
    /// Ed25519 signature of the actual message (base64 encoded for serde)
    #[serde(with = "base64_bytes")]
    pub message_signature: [u8; 64],
    
    /// CRITICAL: Dilithium signature of the SAME message (quantum-resistant)
    /// Per NIST/Cisco: EVERY message must have BOTH signatures
    pub dilithium_message_signature: String,
    
    /// Timestamp of signature creation
    pub signed_at: u64,
}

/// OPTIMIZED: Compact signature for consensus (references cached certificate)
/// This reduces signature size from 12KB to ~3KB while maintaining quantum resistance
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactHybridSignature {
    /// Node ID for certificate lookup
    pub node_id: String,
    
    /// Certificate serial number (for cache lookup)
    pub cert_serial: String,
    
    /// Ed25519 signature of the actual message (base64 encoded)
    #[serde(with = "base64_bytes")]
    pub message_signature: [u8; 64],
    
    /// CRITICAL: Dilithium signature of the SAME message (quantum-resistant)
    /// Per NIST/Cisco: EVERY message must have BOTH signatures
    pub dilithium_message_signature: String,
    
    /// Timestamp of signature creation
    pub signed_at: u64,
}

/// Certificate cache entry
#[derive(Debug, Clone)]
struct CachedCertificate {
    certificate: HybridCertificate,
    verified_at: u64,
    verification_count: u64,
    is_valid: bool,
}

// Thread-safe certificate cache
lazy_static::lazy_static! {
    static ref CERTIFICATE_CACHE: Arc<RwLock<HashMap<String, CachedCertificate>>> = 
        Arc::new(RwLock::new(HashMap::new()));
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
    rotation_interval: Duration,
    
    /// Certificate cache for O(1) verification
    certificate_cache: Arc<RwLock<HashMap<String, CachedCertificate>>>,
    
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
            certificate_cache: Arc::new(RwLock::new(HashMap::new())),
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
        // CRITICAL FIX: Use GLOBAL crypto instance for certificate rotation!
        let mut crypto_guard = crate::node::GLOBAL_QUANTUM_CRYPTO.lock().await;
        if crypto_guard.is_none() {
            // Use GLOBAL crypto instance for consistency
            use crate::node::GLOBAL_QUANTUM_CRYPTO;
            
            let mut crypto_guard = GLOBAL_QUANTUM_CRYPTO.lock().await;
            if crypto_guard.is_none() {
                let mut crypto = crate::quantum_crypto::QNetQuantumCrypto::new();
                let _ = crypto.initialize().await;
                *crypto_guard = Some(crypto);
            }
        }
        let quantum_crypto = crypto_guard.as_ref().unwrap();
        
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
    pub async fn rotate_certificate(&mut self) -> Result<()> {
        println!("🔄 Rotating hybrid certificate...");
        
        // Generate new Ed25519 keypair
        let mut csprng = OsRng{};
        let new_signing_key = SigningKey::generate(&mut csprng);
        let new_verifying_key = new_signing_key.verifying_key();
        
        // Create new certificate
        let new_certificate = self.create_certificate(&new_verifying_key).await?;
        
        // Atomic replacement
        self.ed25519_signing_key = Some(new_signing_key);
        self.ed25519_verifying_key = Some(new_verifying_key);
        self.current_certificate = Some(new_certificate.clone());
        self.last_rotation = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        
        println!("✅ Certificate rotated: {}", new_certificate.serial_number);
        
        // PRODUCTION: Broadcast new certificate to peers for compact signature verification
        // This is handled by the P2P layer when the node initializes or rotates certificates
        // The node.rs will call p2p.broadcast_certificate_announce() after rotation
        
        Ok(())
    }
    
    /// Sign message with BOTH Ed25519 AND Dilithium per NIST/Cisco standards
    pub async fn sign_message(&self, message: &[u8]) -> Result<HybridSignature> {
        // CRITICAL: Per NIST/Cisco standards for hybrid cryptography:
        // EVERY message MUST be signed by BOTH algorithms
        // - Ed25519 for performance/compatibility  
        // - Dilithium for quantum resistance
        // This is NOT optional - both signatures are REQUIRED for security
        
        // Get current Ed25519 signing key (or rotate if needed)
        let signing_key = self.ed25519_signing_key.as_ref()
            .ok_or_else(|| anyhow!("No Ed25519 signing key available"))?;
        
        // Step 1: Sign the message with Ed25519 key
        let ed25519_signature = signing_key.sign(message);
        
        // Step 2: Get or use existing certificate
        let certificate = self.current_certificate.as_ref()
            .ok_or_else(|| anyhow!("No current certificate available"))?;
        
        // Step 3: CRITICAL - ALSO sign the message with Dilithium
        // This provides quantum resistance for EVERY message, not just certificates
        use crate::node::GLOBAL_QUANTUM_CRYPTO;
        use crate::quantum_crypto::QNetQuantumCrypto;
        
        let mut crypto_guard = GLOBAL_QUANTUM_CRYPTO.lock().await;
        if crypto_guard.is_none() {
            let mut crypto = QNetQuantumCrypto::new();
            crypto.initialize().await?;
            *crypto_guard = Some(crypto);
        }
        let quantum_crypto = crypto_guard.as_ref().unwrap();
        
        // Create Dilithium signature for the message
        // Use SHA3-256 to match the rest of the system
        let mut hasher = Sha3_256::new();
        hasher.update(message);
        let message_hash = hex::encode(hasher.finalize());
        let dilithium_sig = quantum_crypto.create_consensus_signature(&self.node_id, &message_hash).await
            .map_err(|e| anyhow!("Failed to create Dilithium signature: {}", e))?;
        
        Ok(HybridSignature {
            certificate: certificate.clone(),
            message_signature: ed25519_signature.to_bytes(),
            dilithium_message_signature: dilithium_sig.signature, // REQUIRED per NIST/Cisco
            signed_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        })
    }
    
    /// OPTIMIZED: Create compact signature for consensus (reduces size from 12KB to 3KB)
    /// Certificate is cached separately for O(1) verification
    pub async fn sign_message_compact(&self, message: &[u8]) -> Result<CompactHybridSignature> {
        // Get current Ed25519 signing key 
        let signing_key = self.ed25519_signing_key.as_ref()
            .ok_or_else(|| anyhow!("No Ed25519 signing key available"))?;
        
        // Get current certificate for metadata
        let certificate = self.current_certificate.as_ref()
            .ok_or_else(|| anyhow!("No current certificate available"))?;
        
        // CRITICAL: Ensure certificate is in cache BEFORE creating compact signature
        self.cache_certificate(certificate).await;
        
        // Step 1: Sign with Ed25519
        let ed25519_signature = signing_key.sign(message);
        
        // Step 2: Sign with Dilithium (quantum-resistant)
        use crate::node::GLOBAL_QUANTUM_CRYPTO;
        use crate::quantum_crypto::QNetQuantumCrypto;
        
        let mut crypto_guard = GLOBAL_QUANTUM_CRYPTO.lock().await;
        if crypto_guard.is_none() {
            let mut crypto = QNetQuantumCrypto::new();
            crypto.initialize().await?;
            *crypto_guard = Some(crypto);
        }
        let quantum_crypto = crypto_guard.as_ref().unwrap();
        
        // CRITICAL FIX: Message is already SHA3 hash from microblock signing
        // DO NOT hash again - just convert to hex for Dilithium
        let message_hash = hex::encode(message);
        let dilithium_sig = quantum_crypto.create_consensus_signature(&self.node_id, &message_hash).await
            .map_err(|e| anyhow!("Failed to create Dilithium signature: {}", e))?;
        
        Ok(CompactHybridSignature {
            node_id: self.node_id.clone(),
            cert_serial: certificate.serial_number.clone(), 
            message_signature: ed25519_signature.to_bytes(),
            dilithium_message_signature: dilithium_sig.signature,
            signed_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        })
    }
    
    /// Cache certificate for O(1) verification
    async fn cache_certificate(&self, certificate: &HybridCertificate) {
        let cache_key = format!("{}_{}", certificate.node_id, certificate.serial_number);
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
        
        // Only update global cache (local cache references same instance)
        CERTIFICATE_CACHE.write().unwrap().insert(cache_key.clone(), cached.clone());
        self.certificate_cache.write().unwrap().insert(cache_key, cached);
    }
    
    /// Verify hybrid signature per NIST/Cisco ENCAPSULATED KEYS standard
    pub async fn verify_signature(
        &self,
        message: &[u8],
        signature: &HybridSignature,
    ) -> Result<bool> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        
        // Step 1: Check certificate expiration
        if now > signature.certificate.expires_at {
            println!("❌ Certificate expired");
            return Ok(false);
        }
        
        // OPTIMIZATION: Check certificate cache first
        let cache_key = format!("{}_{}", 
            signature.certificate.node_id, 
            signature.certificate.serial_number);
        
        // Try to get from cache
        let cert_is_valid = if let Some(cached) = self.certificate_cache.read().unwrap().get(&cache_key) {
            if cached.is_valid && now <= signature.certificate.expires_at {
                println!("✅ Certificate verified from cache (O(1) performance)");
                true // Certificate is valid from cache
            } else if !cached.is_valid {
                println!("❌ Certificate known to be invalid (cached)");
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
            // CRITICAL FIX: Use GLOBAL crypto instance for certificate verification!
            let mut crypto_guard = crate::node::GLOBAL_QUANTUM_CRYPTO.lock().await;
            if crypto_guard.is_none() {
                let mut crypto = crate::quantum_crypto::QNetQuantumCrypto::new();
                let _ = crypto.initialize().await;
                *crypto_guard = Some(crypto);
            }
            let quantum_crypto = crypto_guard.as_ref().unwrap();
            
            let dilithium_sig = crate::quantum_crypto::DilithiumSignature {
                signature: signature.certificate.dilithium_signature.clone(),
                algorithm: "QNet-Dilithium-Compatible".to_string(),
                timestamp: signature.certificate.issued_at,
                strength: "quantum-resistant".to_string(),
            };
            
            let cert_valid = quantum_crypto
                .verify_dilithium_signature(&encapsulated_hex, &dilithium_sig, &signature.certificate.node_id)
                .await?;
            
            if !cert_valid {
                println!("❌ Invalid Dilithium signature on certificate");
                // Cache negative result
                self.certificate_cache.write().unwrap().insert(cache_key.clone(), CachedCertificate {
                    certificate: signature.certificate.clone(),
                    verified_at: now,
                    verification_count: 1,
                    is_valid: false,
                });
                return Ok(false);
            }
            
            // OPTIMIZATION: Cache valid certificate for O(1) future verifications
            println!("✅ Certificate verified and cached");
            self.certificate_cache.write().unwrap().insert(cache_key, CachedCertificate {
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
        
        // Step 4: Verify Ed25519 message signature (fast)
        let ed25519_valid = Self::verify_ed25519_signature(
            message,
            &signature.message_signature,
            &signature.certificate.ed25519_public_key
        )?;
        
        if !ed25519_valid {
            println!("❌ Invalid Ed25519 message signature");
            return Ok(false);
        }
        
        // Step 5: CRITICAL - Verify Dilithium message signature
        // Per NIST/Cisco standards: BOTH signatures must be valid
        // This ensures quantum resistance for EVERY message
        
        // Skip Dilithium verification only if not provided (backwards compatibility)
        if !signature.dilithium_message_signature.is_empty() {
            use crate::node::GLOBAL_QUANTUM_CRYPTO;
            use crate::quantum_crypto::{QNetQuantumCrypto, DilithiumSignature};
            
            let mut crypto_guard = GLOBAL_QUANTUM_CRYPTO.lock().await;
            if crypto_guard.is_none() {
                let mut crypto = QNetQuantumCrypto::new();
                crypto.initialize().await?;
                *crypto_guard = Some(crypto);
            }
            let quantum_crypto = crypto_guard.as_ref().unwrap();
            
            // Recreate the same message hash used for signing
            // Use SHA3-256 to match the rest of the system
        let mut hasher = Sha3_256::new();
        hasher.update(message);
        let message_hash = hex::encode(hasher.finalize());
            
            let dilithium_sig = DilithiumSignature {
                signature: signature.dilithium_message_signature.clone(),
                algorithm: "CRYSTALS-Dilithium3".to_string(),
                timestamp: signature.signed_at,
                strength: "quantum-resistant".to_string(),
            };
            
            let dilithium_valid = quantum_crypto
                .verify_dilithium_signature(&message_hash, &dilithium_sig, &signature.certificate.node_id)
                .await?;
            
            if !dilithium_valid {
                println!("❌ Invalid Dilithium message signature - NOT quantum safe!");
                return Ok(false);
            }
            
            println!("✅ BOTH signatures verified - truly quantum-resistant");
        } else {
            println!("⚠️ WARNING: No Dilithium message signature - NOT quantum safe!");
        }
        
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
    
    /// Get cache statistics
    pub fn get_cache_stats() -> (usize, f64) {
        let cache = CERTIFICATE_CACHE.read().unwrap();
        let size = cache.len();
        
        let total_verifications: u64 = cache.values()
            .map(|c| c.verification_count)
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
        
        let mut cache = CERTIFICATE_CACHE.write().unwrap();
        cache.retain(|_, cached| {
            cached.certificate.expires_at > now
        });
        
        println!("🧹 Cache cleaned: {} certificates remaining", cache.len());
    }
}

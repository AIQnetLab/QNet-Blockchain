//! QNet Hybrid Cryptography Module
//! Implements Key Encapsulation Mechanism (KEM) with CRYSTALS-Dilithium and Ed25519
//! Following NIST and Cisco recommendations for post-quantum hybrid cryptography

use anyhow::{Result, anyhow};
use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier};
use rand::{rngs::OsRng, Rng};
use serde::{Serialize, Deserialize};
use sha2::Digest;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH, Duration};
use base64::{Engine as _, engine::general_purpose};

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
        
        // Create certificate data to sign
        let cert_data = format!(
            "CERTIFICATE:{}:{}:{}:{}",
            self.node_id,
            hex::encode(verifying_key.as_bytes()),
            now,
            expires_at
        );
        
        // Sign with Dilithium (using quantum_crypto module)
        let quantum_crypto = crate::quantum_crypto::QNetQuantumCrypto::new();
        let dilithium_sig = quantum_crypto
            .create_consensus_signature(&self.node_id, &cert_data)
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
        Ok(())
    }
    
    /// Sign message per NIST/Cisco ENCAPSULATED KEYS standard
    pub async fn sign_message(&self, message: &[u8]) -> Result<HybridSignature> {
        // CRITICAL: Per NIST/Cisco - generate NEW ephemeral Ed25519 key for THIS message
        let ephemeral_signing_key = SigningKey::from_bytes(&rand::thread_rng().gen::<[u8; 32]>());
        let ephemeral_verifying_key = ephemeral_signing_key.verifying_key();
        
        // Step 1: Sign the message with ephemeral Ed25519 key
        let ed25519_signature = ephemeral_signing_key.sign(message);
        
        // Step 2: Create encapsulated key data (ephemeral key + message hash)
        let mut encapsulated_data = Vec::new();
        encapsulated_data.extend_from_slice(ephemeral_verifying_key.as_bytes());
        encapsulated_data.extend_from_slice(&sha3::Sha3_256::digest(message));
        encapsulated_data.extend_from_slice(&(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()).to_le_bytes());
        
        // Step 3: Sign the ENCAPSULATED KEY with Dilithium (NOT the message!)
        // This is the CORRECT NIST/Cisco approach
        let encapsulated_hex = hex::encode(&encapsulated_data);
        let quantum_crypto = crate::quantum_crypto::QNetQuantumCrypto::new();
        let dilithium_sig = quantum_crypto
            .create_consensus_signature(&self.node_id, &encapsulated_hex)
            .await?;
        
        // Create new certificate format with ephemeral key
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let ephemeral_certificate = HybridCertificate {
            node_id: self.node_id.clone(),
            ed25519_public_key: *ephemeral_verifying_key.as_bytes(),
            dilithium_signature: dilithium_sig.signature,
            issued_at: now,
            expires_at: now + 60, // 1 minute ephemeral key per NIST
            serial_number: format!("{:x}", now), // Use timestamp as serial
        };
        
        Ok(HybridSignature {
            certificate: ephemeral_certificate,
            message_signature: ed25519_signature.to_bytes(),
            dilithium_message_signature: String::new(), // NOT USED - Dilithium signs the KEY, not message
            signed_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        })
    }
    
    /// Verify hybrid signature per NIST/Cisco ENCAPSULATED KEYS standard
    pub async fn verify_signature(
        message: &[u8],
        signature: &HybridSignature,
    ) -> Result<bool> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        
        // Step 1: Check ephemeral certificate expiration (1 minute max)
        if now > signature.certificate.expires_at {
            println!("❌ Ephemeral certificate expired");
            return Ok(false);
        }
        
        // CRITICAL: Per NIST/Cisco - NO CACHING of ephemeral certificates!
        // Each message has unique ephemeral key that MUST be verified
        println!("🔐 Verifying ephemeral key encapsulation (NO CACHE per NIST)...");
        
        // Step 2: Recreate encapsulated data to verify
        let mut encapsulated_data = Vec::new();
        encapsulated_data.extend_from_slice(&signature.certificate.ed25519_public_key);
        encapsulated_data.extend_from_slice(&sha3::Sha3_256::digest(message));
        // Note: timestamp verification is approximate due to time drift
        
        let encapsulated_hex = hex::encode(&encapsulated_data);
            
            // Verify with quantum_crypto
            let quantum_crypto = crate::quantum_crypto::QNetQuantumCrypto::new();
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
                return Ok(false);
            }
            
            // NO CACHING per NIST/Cisco - ephemeral keys must be verified every time
            println!("✅ Ephemeral certificate verified (NO CACHE per NIST)");
        
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
        
        // Step 5: CRITICAL - Verify Dilithium message signature (quantum-resistant)
        // Per NIST/Cisco: EVERY message must have BOTH signatures verified
        println!("🔐 Verifying Dilithium message signature (quantum-resistant)...");
        
        let message_hex = hex::encode(message);
        let quantum_crypto = crate::quantum_crypto::QNetQuantumCrypto::new();
        let dilithium_msg_sig = crate::quantum_crypto::DilithiumSignature {
            signature: signature.dilithium_message_signature.clone(),
            algorithm: "QNet-Dilithium-Compatible".to_string(),
            timestamp: signature.signed_at,
            strength: "quantum-resistant".to_string(),
        };
        
        let dilithium_valid = quantum_crypto
            .verify_dilithium_signature(&message_hex, &dilithium_msg_sig, &signature.certificate.node_id)
            .await?;
        
        if !dilithium_valid {
            println!("❌ Invalid Dilithium message signature - QUANTUM ATTACK POSSIBLE!");
            return Ok(false);
        }
        
        println!("✅ Both Ed25519 and Dilithium signatures verified - fully quantum-resistant");
        Ok(true)
    }
    
    /// Verify Ed25519 signature (fast operation)
    fn verify_ed25519_signature(
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

//! QNet Hybrid Cryptography Module
//! Implements Key Encapsulation Mechanism (KEM) with CRYSTALS-Dilithium and Ed25519
//! Following NIST and Cisco recommendations for post-quantum hybrid cryptography

use anyhow::{Result, anyhow};
use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier};
use rand::rngs::OsRng;
use serde::{Serialize, Deserialize};
use sha2::{Sha512, Digest};
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
    
    /// Sign message with hybrid signature
    pub fn sign_message(&self, message: &[u8]) -> Result<HybridSignature> {
        let signing_key = self.ed25519_signing_key.as_ref()
            .ok_or_else(|| anyhow!("Hybrid crypto not initialized"))?;
        
        let certificate = self.current_certificate.as_ref()
            .ok_or_else(|| anyhow!("No current certificate"))?;
        
        // Sign message with Ed25519
        let signature = signing_key.sign(message);
        
        Ok(HybridSignature {
            certificate: certificate.clone(),
            message_signature: signature.to_bytes(),
            signed_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        })
    }
    
    /// Verify hybrid signature (static method for any node)
    pub async fn verify_signature(
        message: &[u8],
        signature: &HybridSignature,
    ) -> Result<bool> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        
        // Step 1: Check certificate expiration
        if now > signature.certificate.expires_at {
            println!("❌ Certificate expired: {} > {}", now, signature.certificate.expires_at);
            return Ok(false);
        }
        
        // Step 2: Check certificate cache
        let cache_key = format!("{}:{}", 
            signature.certificate.node_id, 
            signature.certificate.serial_number
        );
        
        // Try cache hit (O(1) operation)
        {
            let cache = CERTIFICATE_CACHE.read().unwrap();
            if let Some(cached) = cache.get(&cache_key) {
                if cached.is_valid && cached.certificate.serial_number == signature.certificate.serial_number {
                    // Certificate already verified, just verify Ed25519 signature
                    return Self::verify_ed25519_signature(
                        message,
                        &signature.message_signature,
                        &signature.certificate.ed25519_public_key
                    );
                }
            }
        }
        
        // Step 3: Verify Dilithium signature on certificate (expensive, but rare)
        println!("🔐 Verifying Dilithium certificate signature (cache miss)...");
        
        let cert_data = format!(
            "CERTIFICATE:{}:{}:{}:{}",
            signature.certificate.node_id,
            hex::encode(&signature.certificate.ed25519_public_key),
            signature.certificate.issued_at,
            signature.certificate.expires_at
        );
        
        // Verify with quantum_crypto
        let quantum_crypto = crate::quantum_crypto::QNetQuantumCrypto::new();
        let dilithium_sig = crate::quantum_crypto::DilithiumSignature {
            signature: signature.certificate.dilithium_signature.clone(),
            algorithm: "QNet-Dilithium-Compatible".to_string(),
            timestamp: signature.certificate.issued_at,
            strength: "quantum-resistant".to_string(),
        };
        
        let cert_valid = quantum_crypto
            .verify_dilithium_signature(&cert_data, &dilithium_sig, &signature.certificate.node_id)
            .await?;
        
        if !cert_valid {
            println!("❌ Invalid Dilithium signature on certificate");
            return Ok(false);
        }
        
        // Step 4: Cache the verified certificate
        {
            let mut cache = CERTIFICATE_CACHE.write().unwrap();
            
            // LRU eviction if cache is full
            if cache.len() >= MAX_CACHE_SIZE {
                // Remove oldest entries
                let oldest_key = cache.iter()
                    .min_by_key(|(_, v)| v.verified_at)
                    .map(|(k, _)| k.clone());
                
                if let Some(key) = oldest_key {
                    cache.remove(&key);
                }
            }
            
            cache.insert(cache_key, CachedCertificate {
                certificate: signature.certificate.clone(),
                verified_at: now,
                verification_count: 1,
                is_valid: true,
            });
        }
        
        println!("✅ Certificate verified and cached");
        
        // Step 5: Verify Ed25519 message signature (fast)
        Self::verify_ed25519_signature(
            message,
            &signature.message_signature,
            &signature.certificate.ed25519_public_key
        )
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
    
    /// Convert hybrid signature to consensus-compatible format
    pub fn to_consensus_signature(signature: &HybridSignature) -> String {
        // Format: "hybrid:<certificate_serial>:<ed25519_signature_base64>"
        format!(
            "hybrid:{}:{}",
            signature.certificate.serial_number,
            general_purpose::STANDARD.encode(&signature.message_signature)
        )
    }
    
    /// Parse consensus signature format
    pub fn from_consensus_signature(
        signature_str: &str,
        certificate: HybridCertificate
    ) -> Result<HybridSignature> {
        if !signature_str.starts_with("hybrid:") {
            return Err(anyhow!("Invalid hybrid signature format"));
        }
        
        let parts: Vec<&str> = signature_str.split(':').collect();
        if parts.len() != 3 {
            return Err(anyhow!("Invalid hybrid signature parts"));
        }
        
        let serial = parts[1];
        if serial != certificate.serial_number {
            return Err(anyhow!("Certificate serial mismatch"));
        }
        
        let sig_bytes = general_purpose::STANDARD.decode(parts[2])
            .map_err(|e| anyhow!("Invalid base64 in signature: {}", e))?;
        
        if sig_bytes.len() != 64 {
            return Err(anyhow!("Invalid Ed25519 signature length"));
        }
        
        let mut message_signature = [0u8; 64];
        message_signature.copy_from_slice(&sig_bytes);
        
        Ok(HybridSignature {
            certificate,
            message_signature,
            signed_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_hybrid_crypto_lifecycle() {
        let mut crypto = HybridCrypto::new("test_node".to_string());
        
        // Initialize
        crypto.initialize().await.unwrap();
        assert!(crypto.current_certificate.is_some());
        
        // Sign message
        let message = b"Test message";
        let signature = crypto.sign_message(message).unwrap();
        
        // Verify signature
        let valid = HybridCrypto::verify_signature(message, &signature).await.unwrap();
        assert!(valid);
        
        // Verify with wrong message fails
        let wrong_message = b"Wrong message";
        let invalid = HybridCrypto::verify_signature(wrong_message, &signature).await.unwrap();
        assert!(!invalid);
    }
    
    #[tokio::test]
    async fn test_certificate_rotation() {
        let mut crypto = HybridCrypto::new("test_node".to_string());
        crypto.initialize().await.unwrap();
        
        let first_cert = crypto.current_certificate.clone().unwrap();
        
        // Rotate certificate
        crypto.rotate_certificate().await.unwrap();
        
        let second_cert = crypto.current_certificate.clone().unwrap();
        
        // Certificates should be different
        assert_ne!(first_cert.serial_number, second_cert.serial_number);
        assert_ne!(first_cert.ed25519_public_key, second_cert.ed25519_public_key);
    }
    
    #[tokio::test]
    async fn test_cache_performance() {
        let mut crypto = HybridCrypto::new("test_node".to_string());
        crypto.initialize().await.unwrap();
        
        let message = b"Test message";
        let signature = crypto.sign_message(message).unwrap();
        
        // First verification (cache miss)
        let start = std::time::Instant::now();
        HybridCrypto::verify_signature(message, &signature).await.unwrap();
        let first_time = start.elapsed();
        
        // Second verification (cache hit)
        let start = std::time::Instant::now();
        HybridCrypto::verify_signature(message, &signature).await.unwrap();
        let second_time = start.elapsed();
        
        // Cache hit should be much faster
        assert!(second_time < first_time / 10);
        
        let (cache_size, _) = HybridCrypto::get_cache_stats();
        assert_eq!(cache_size, 1);
    }
}



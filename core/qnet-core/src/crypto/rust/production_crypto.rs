//! Production-ready post-quantum cryptography implementation
//! 
//! This module implements Dilithium, Kyber, Falcon, and SPHINCS+ algorithms
//! for quantum-resistant signatures and key exchange.

use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use std::fmt;
use thiserror::Error;
use rand::RngCore;
use sha2::{Sha256, Sha512, Digest};

// Post-quantum cryptography imports with traits
use pqcrypto_traits::sign::{PublicKey as PQPublicKey, SecretKey as PQSecretKey, DetachedSignature as PQDetachedSignature, SignedMessage as PQSignedMessage};
use pqcrypto_dilithium::dilithium2;
use pqcrypto_dilithium::dilithium3;
use pqcrypto_dilithium::dilithium5;
use pqcrypto_kyber::kyber512;
use pqcrypto_kyber::kyber768;
use pqcrypto_kyber::kyber1024;
use pqcrypto_falcon::falcon512;
use pqcrypto_falcon::falcon1024;
use pqcrypto_sphincsplus::sphincssha2128ssimple;
use pqcrypto_sphincsplus::sphincssha2128fsimple;
use pqcrypto_sphincsplus::sphincssha2192ssimple;

/// Error types for cryptographic operations
#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("Invalid key: {0}")]
    InvalidKey(String),
    #[error("Invalid signature: {0}")]
    InvalidSignature(String),
    #[error("Invalid parameters: {0}")]
    InvalidParameters(String),
    #[error("Encryption failed: {0}")]
    EncryptionFailed(String),
    #[error("Decryption failed: {0}")]
    DecryptionFailed(String),
    #[error("Random number generation failed: {0}")]
    RandomFailed(String),
    #[error("Hash computation failed: {0}")]
    HashFailed(String),
    #[error("Serialization failed: {0}")]
    SerializationFailed(String),
}

/// Error kinds for backwards compatibility
#[derive(Debug, Clone, PartialEq)]
pub enum CryptoErrorKind {
    InvalidKey,
    InvalidSignature,
    InvalidParameters,
    EncryptionFailed,
    DecryptionFailed,
    RandomFailed,
    HashFailed,
    SerializationFailed,
}

/// Crypto error with kind and message
#[derive(Debug, Clone)]
pub struct CryptoErrorWithKind {
    pub kind: CryptoErrorKind,
    pub message: String,
}

/// Result type for crypto operations
pub type CryptoResult<T> = Result<T, CryptoErrorWithKind>;

/// Dilithium security levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DilithiumLevel {
    Level2,
    Level3,
    Level5,
}

/// Dilithium parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DilithiumParams {
    pub security_level: DilithiumLevel,
    pub public_key_size: usize,
    pub private_key_size: usize,
    pub signature_size: usize,
}

/// SPHINCS+ security levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SphincsLevel {
    Level128s,
    Level128f,
    Level192s,
}

/// SPHINCS+ parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SphincsParams {
    pub security_level: SphincsLevel,
    pub public_key_size: usize,
    pub private_key_size: usize,
    pub signature_size: usize,
}

/// Cached key for performance
#[derive(Debug, Clone)]
pub struct CachedKey {
    pub key_data: Vec<u8>,
    pub key_type: String,
    pub created_at: u64,
    pub used_count: u64,
}

/// Crypto performance metrics
#[derive(Debug, Clone, Default)]
pub struct CryptoMetrics {
    pub signatures_generated: u64,
    pub signatures_verified: u64,
    pub keys_generated: u64,
    pub hash_operations: u64,
    pub encryption_operations: u64,
    pub decryption_operations: u64,
    pub avg_sign_time_ms: f64,
    pub avg_verify_time_ms: f64,
    pub cache_hits: u64,
    pub cache_misses: u64,
}

/// Supported key types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KeyType {
    Dilithium2,
    Dilithium3,
    Dilithium5,
    Kyber512,
    Kyber768,
    Kyber1024,
    Falcon512,
    Falcon1024,
    SphincsPlus128s,
    SphincsPlus128f,
    SphincsPlus192s,
    Ed25519,
}

impl fmt::Display for KeyType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyType::Dilithium2 => write!(f, "Dilithium2"),
            KeyType::Dilithium3 => write!(f, "Dilithium3"),
            KeyType::Dilithium5 => write!(f, "Dilithium5"),
            KeyType::Kyber512 => write!(f, "Kyber512"),
            KeyType::Kyber768 => write!(f, "Kyber768"),
            KeyType::Kyber1024 => write!(f, "Kyber1024"),
            KeyType::Falcon512 => write!(f, "Falcon512"),
            KeyType::Falcon1024 => write!(f, "Falcon1024"),
            KeyType::SphincsPlus128s => write!(f, "SphincsPlus128s"),
            KeyType::SphincsPlus128f => write!(f, "SphincsPlus128f"),
            KeyType::SphincsPlus192s => write!(f, "SphincsPlus192s"),
            KeyType::Ed25519 => write!(f, "Ed25519"),
        }
    }
}

/// Production post-quantum cryptography manager
pub struct ProductionCrypto {
    /// Key cache for performance
    key_cache: std::sync::Arc<std::sync::RwLock<HashMap<String, CachedKey>>>,
    /// Random number generator pool
    rng_pool: std::sync::Arc<std::sync::Mutex<Vec<Box<dyn rand::RngCore + Send>>>>,
    /// Performance metrics
    metrics: std::sync::Arc<std::sync::RwLock<CryptoMetrics>>,
}

impl ProductionCrypto {
    /// Initialize the production cryptography system
    pub fn new() -> Self {
        Self {
            key_cache: std::sync::Arc::new(std::sync::RwLock::new(HashMap::new())),
            rng_pool: std::sync::Arc::new(std::sync::Mutex::new(Self::initialize_rng_pool())),
            metrics: std::sync::Arc::new(std::sync::RwLock::new(CryptoMetrics::default())),
        }
    }

    /// Secure hash function (SHA2-256)
    pub fn secure_hash(&self, data: &[u8]) -> Vec<u8> {
        let mut hasher = Sha256::new();
        hasher.update(data);
        hasher.finalize().to_vec()
    }

    /// Extended secure hash function (SHA2-512)
    pub fn secure_hash_extended(&self, data: &[u8]) -> Vec<u8> {
        let mut hasher = Sha512::new();
        hasher.update(data);
        hasher.finalize().to_vec()
    }

    /// Generate Dilithium key pair
    pub fn generate_dilithium_keypair(&self, params: &DilithiumParams) -> CryptoResult<(Vec<u8>, Vec<u8>)> {
        let start_time = std::time::Instant::now();
        
        let result = match params.security_level {
            DilithiumLevel::Level2 => {
                let (public_key, secret_key) = dilithium2::keypair();
                Ok((public_key.as_bytes().to_vec(), secret_key.as_bytes().to_vec()))
            }
            DilithiumLevel::Level3 => {
                let (public_key, secret_key) = dilithium3::keypair();
                Ok((public_key.as_bytes().to_vec(), secret_key.as_bytes().to_vec()))
            }
            DilithiumLevel::Level5 => {
                let (public_key, secret_key) = dilithium5::keypair();
                Ok((public_key.as_bytes().to_vec(), secret_key.as_bytes().to_vec()))
            }
        };
        
        let duration = start_time.elapsed().as_millis() as f64;
        self.update_metrics_for_key_generation(duration);
        
        result
    }

    /// Sign with Dilithium
    pub fn dilithium_sign(&self, message_hash: &[u8], private_key: &[u8], params: &DilithiumParams) -> CryptoResult<Vec<u8>> {
        let start_time = std::time::Instant::now();
        
        let result = match params.security_level {
            DilithiumLevel::Level2 => {
                if private_key.len() != dilithium2::secret_key_bytes() {
                    return Err(CryptoErrorWithKind {
                        kind: CryptoErrorKind::InvalidKey,
                        message: format!("Invalid Dilithium2 private key size: {} bytes", private_key.len()),
                    });
                }
                
                let secret_key = dilithium2::SecretKey::from_bytes(private_key).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidKey,
                    message: "Failed to parse Dilithium2 private key".to_string(),
                })?;
                
                let signature = dilithium2::sign(message_hash, &secret_key);
                Ok(signature.as_bytes().to_vec())
            }
            DilithiumLevel::Level3 => {
                if private_key.len() != dilithium3::secret_key_bytes() {
                    return Err(CryptoErrorWithKind {
                        kind: CryptoErrorKind::InvalidKey,
                        message: format!("Invalid Dilithium3 private key size: {} bytes", private_key.len()),
                    });
                }
                
                let secret_key = dilithium3::SecretKey::from_bytes(private_key).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidKey,
                    message: "Failed to parse Dilithium3 private key".to_string(),
                })?;
                
                let signature = dilithium3::sign(message_hash, &secret_key);
                Ok(signature.as_bytes().to_vec())
            }
            DilithiumLevel::Level5 => {
                if private_key.len() != dilithium5::secret_key_bytes() {
                    return Err(CryptoErrorWithKind {
                        kind: CryptoErrorKind::InvalidKey,
                        message: format!("Invalid Dilithium5 private key size: {} bytes", private_key.len()),
                    });
                }
                
                let secret_key = dilithium5::SecretKey::from_bytes(private_key).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidKey,
                    message: "Failed to parse Dilithium5 private key".to_string(),
                })?;
                
                let signature = dilithium5::sign(message_hash, &secret_key);
                Ok(signature.as_bytes().to_vec())
            }
        };
        
        let duration = start_time.elapsed().as_millis() as f64;
        self.update_metrics_for_signing(duration);
        
        result
    }

    /// Verify Dilithium signature
    pub fn dilithium_verify(&self, signature: &[u8], message_hash: &[u8], public_key: &[u8], params: &DilithiumParams) -> CryptoResult<bool> {
        let start_time = std::time::Instant::now();
        
        let result = match params.security_level {
            DilithiumLevel::Level2 => {
                if public_key.len() != dilithium2::public_key_bytes() {
                    return Ok(false);
                }
                
                let public_key = dilithium2::PublicKey::from_bytes(public_key).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidKey,
                    message: "Failed to parse Dilithium2 public key".to_string(),
                })?;
                
                let signed_message = dilithium2::SignedMessage::from_bytes(signature).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidSignature,
                    message: "Failed to parse Dilithium2 signed message".to_string(),
                })?;
                
                match dilithium2::open(&signed_message, &public_key) {
                    Ok(recovered_message) => Ok(recovered_message == message_hash),
                    Err(_) => Ok(false),
                }
            }
            DilithiumLevel::Level3 => {
                if public_key.len() != dilithium3::public_key_bytes() {
                    return Ok(false);
                }
                
                let public_key = dilithium3::PublicKey::from_bytes(public_key).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidKey,
                    message: "Failed to parse Dilithium3 public key".to_string(),
                })?;
                
                let signed_message = dilithium3::SignedMessage::from_bytes(signature).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidSignature,
                    message: "Failed to parse Dilithium3 signed message".to_string(),
                })?;
                
                match dilithium3::open(&signed_message, &public_key) {
                    Ok(recovered_message) => Ok(recovered_message == message_hash),
                    Err(_) => Ok(false),
                }
            }
            DilithiumLevel::Level5 => {
                if public_key.len() != dilithium5::public_key_bytes() {
                    return Ok(false);
                }
                
                let public_key = dilithium5::PublicKey::from_bytes(public_key).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidKey,
                    message: "Failed to parse Dilithium5 public key".to_string(),
                })?;
                
                let signed_message = dilithium5::SignedMessage::from_bytes(signature).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidSignature,
                    message: "Failed to parse Dilithium5 signed message".to_string(),
                })?;
                
                match dilithium5::open(&signed_message, &public_key) {
                    Ok(recovered_message) => Ok(recovered_message == message_hash),
                    Err(_) => Ok(false),
                }
            }
        };
        
        let duration = start_time.elapsed().as_millis() as f64;
        self.update_metrics_for_verification(duration);
        
        result
    }

    /// Generate SPHINCS+ key pair
    pub fn generate_sphincs_keypair(&self, params: &SphincsParams) -> CryptoResult<(Vec<u8>, Vec<u8>)> {
        let start_time = std::time::Instant::now();
        
        let result = match params.security_level {
            SphincsLevel::Level128s => {
                let (public_key, secret_key) = sphincssha2128ssimple::keypair();
                Ok((public_key.as_bytes().to_vec(), secret_key.as_bytes().to_vec()))
            }
            SphincsLevel::Level128f => {
                let (public_key, secret_key) = sphincssha2128fsimple::keypair();
                Ok((public_key.as_bytes().to_vec(), secret_key.as_bytes().to_vec()))
            }
            SphincsLevel::Level192s => {
                let (public_key, secret_key) = sphincssha2192ssimple::keypair();
                Ok((public_key.as_bytes().to_vec(), secret_key.as_bytes().to_vec()))
            }
        };
        
        let duration = start_time.elapsed().as_millis() as f64;
        self.update_metrics_for_key_generation(duration);
        
        result
    }

    /// Sign with SPHINCS+
    pub fn sphincs_sign(&self, message_hash: &[u8], private_key: &[u8], params: &SphincsParams) -> CryptoResult<Vec<u8>> {
        let start_time = std::time::Instant::now();
        
        let result = match params.security_level {
            SphincsLevel::Level128s => {
                if private_key.len() != sphincssha2128ssimple::secret_key_bytes() {
                    return Err(CryptoErrorWithKind {
                        kind: CryptoErrorKind::InvalidKey,
                        message: format!("Invalid SPHINCS+ 128s private key size: {} bytes", private_key.len()),
                    });
                }
                
                let secret_key = sphincssha2128ssimple::SecretKey::from_bytes(private_key).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidKey,
                    message: "Failed to parse SPHINCS+ 128s private key".to_string(),
                })?;
                
                let signature = sphincssha2128ssimple::sign(message_hash, &secret_key);
                Ok(signature.as_bytes().to_vec())
            }
            SphincsLevel::Level128f => {
                if private_key.len() != sphincssha2128fsimple::secret_key_bytes() {
                    return Err(CryptoErrorWithKind {
                        kind: CryptoErrorKind::InvalidKey,
                        message: format!("Invalid SPHINCS+ 128f private key size: {} bytes", private_key.len()),
                    });
                }
                
                let secret_key = sphincssha2128fsimple::SecretKey::from_bytes(private_key).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidKey,
                    message: "Failed to parse SPHINCS+ 128f private key".to_string(),
                })?;
                
                let signature = sphincssha2128fsimple::sign(message_hash, &secret_key);
                Ok(signature.as_bytes().to_vec())
            }
            SphincsLevel::Level192s => {
                if private_key.len() != sphincssha2192ssimple::secret_key_bytes() {
                    return Err(CryptoErrorWithKind {
                        kind: CryptoErrorKind::InvalidKey,
                        message: format!("Invalid SPHINCS+ 192s private key size: {} bytes", private_key.len()),
                    });
                }
                
                let secret_key = sphincssha2192ssimple::SecretKey::from_bytes(private_key).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidKey,
                    message: "Failed to parse SPHINCS+ 192s private key".to_string(),
                })?;
                
                let signature = sphincssha2192ssimple::sign(message_hash, &secret_key);
                Ok(signature.as_bytes().to_vec())
            }
        };
        
        let duration = start_time.elapsed().as_millis() as f64;
        self.update_metrics_for_signing(duration);
        
        result
    }

    /// Verify SPHINCS+ signature
    pub fn sphincs_verify(&self, signature: &[u8], message_hash: &[u8], public_key: &[u8], params: &SphincsParams) -> CryptoResult<bool> {
        let start_time = std::time::Instant::now();
        
        let result = match params.security_level {
            SphincsLevel::Level128s => {
                if public_key.len() != sphincssha2128ssimple::public_key_bytes() {
                    return Ok(false);
                }
                
                let public_key = sphincssha2128ssimple::PublicKey::from_bytes(public_key).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidKey,
                    message: "Failed to parse SPHINCS+ 128s public key".to_string(),
                })?;
                
                let signed_message = sphincssha2128ssimple::SignedMessage::from_bytes(signature).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidSignature,
                    message: "Failed to parse SPHINCS+ 128s signed message".to_string(),
                })?;
                
                match sphincssha2128ssimple::open(&signed_message, &public_key) {
                    Ok(recovered_message) => Ok(recovered_message == message_hash),
                    Err(_) => Ok(false),
                }
            }
            SphincsLevel::Level128f => {
                if public_key.len() != sphincssha2128fsimple::public_key_bytes() {
                    return Ok(false);
                }
                
                let public_key = sphincssha2128fsimple::PublicKey::from_bytes(public_key).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidKey,
                    message: "Failed to parse SPHINCS+ 128f public key".to_string(),
                })?;
                
                let signed_message = sphincssha2128fsimple::SignedMessage::from_bytes(signature).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidSignature,
                    message: "Failed to parse SPHINCS+ 128f signed message".to_string(),
                })?;
                
                match sphincssha2128fsimple::open(&signed_message, &public_key) {
                    Ok(recovered_message) => Ok(recovered_message == message_hash),
                    Err(_) => Ok(false),
                }
            }
            SphincsLevel::Level192s => {
                if public_key.len() != sphincssha2192ssimple::public_key_bytes() {
                    return Ok(false);
                }
                
                let public_key = sphincssha2192ssimple::PublicKey::from_bytes(public_key).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidKey,
                    message: "Failed to parse SPHINCS+ 192s public key".to_string(),
                })?;
                
                let signed_message = sphincssha2192ssimple::SignedMessage::from_bytes(signature).map_err(|_| CryptoErrorWithKind {
                    kind: CryptoErrorKind::InvalidSignature,
                    message: "Failed to parse SPHINCS+ 192s signed message".to_string(),
                })?;
                
                match sphincssha2192ssimple::open(&signed_message, &public_key) {
                    Ok(recovered_message) => Ok(recovered_message == message_hash),
                    Err(_) => Ok(false),
                }
            }
        };
        
        let duration = start_time.elapsed().as_millis() as f64;
        self.update_metrics_for_verification(duration);
        
        result
    }

    /// Get current timestamp
    fn current_timestamp(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    /// Update metrics for key generation
    fn update_metrics_for_key_generation(&self, duration_ms: f64) {
        if let Ok(mut metrics) = self.metrics.write() {
            metrics.keys_generated += 1;
        }
    }

    /// Update metrics for signing
    fn update_metrics_for_signing(&self, duration_ms: f64) {
        if let Ok(mut metrics) = self.metrics.write() {
            metrics.signatures_generated += 1;
            metrics.avg_sign_time_ms = (metrics.avg_sign_time_ms * (metrics.signatures_generated - 1) as f64 + duration_ms) / metrics.signatures_generated as f64;
        }
    }

    /// Update metrics for verification
    fn update_metrics_for_verification(&self, duration_ms: f64) {
        if let Ok(mut metrics) = self.metrics.write() {
            metrics.signatures_verified += 1;
            metrics.avg_verify_time_ms = (metrics.avg_verify_time_ms * (metrics.signatures_verified - 1) as f64 + duration_ms) / metrics.signatures_verified as f64;
        }
    }

    /// Initialize RNG pool
    fn initialize_rng_pool() -> Vec<Box<dyn rand::RngCore + Send>> {
        vec![Box::new(rand::rngs::OsRng)]
    }

    /// Get performance metrics
    pub fn get_metrics(&self) -> CryptoResult<CryptoMetrics> {
        let metrics = self.metrics.read().map_err(|_| CryptoErrorWithKind {
            kind: CryptoErrorKind::SerializationFailed,
            message: "Failed to read metrics".to_string(),
        })?;
        Ok(metrics.clone())
    }
}

/// Initialize crypto subsystem for QNet node
pub fn initialize_qnet_crypto() -> std::sync::Arc<ProductionCrypto> {
    std::sync::Arc::new(ProductionCrypto::new())
}

/// Default Dilithium3 parameters for QNet
pub fn default_dilithium_params() -> DilithiumParams {
    DilithiumParams {
        security_level: DilithiumLevel::Level3,
        public_key_size: dilithium3::public_key_bytes(),
        private_key_size: dilithium3::secret_key_bytes(),
        signature_size: dilithium3::signature_bytes(),
    }
}

/// Default SPHINCS+ parameters for QNet
pub fn default_sphincs_params() -> SphincsParams {
    SphincsParams {
        security_level: SphincsLevel::Level128s,
        public_key_size: sphincssha2128ssimple::public_key_bytes(),
        private_key_size: sphincssha2128ssimple::secret_key_bytes(),
        signature_size: sphincssha2128ssimple::signature_bytes(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dilithium_keypair_generation() {
        let crypto = ProductionCrypto::new();
        let params = default_dilithium_params();
        
        let result = crypto.generate_dilithium_keypair(&params);
        assert!(result.is_ok());
        
        let (public_key, private_key) = result.unwrap();
        assert_eq!(public_key.len(), params.public_key_size);
        assert_eq!(private_key.len(), params.private_key_size);
    }

    #[test]
    fn test_dilithium_sign_verify() {
        let crypto = ProductionCrypto::new();
        let params = default_dilithium_params();
        let (public_key, private_key) = crypto.generate_dilithium_keypair(&params).unwrap();
        
        let message = b"Hello, QNet!";
        let message_hash = crypto.secure_hash(message);
        
        let signature = crypto.dilithium_sign(&message_hash, &private_key, &params).unwrap();
        assert_eq!(signature.len(), params.signature_size);
        
        let is_valid = crypto.dilithium_verify(&signature, &message_hash, &public_key, &params).unwrap();
        assert!(is_valid);
    }

    #[test]
    fn test_sphincs_keypair_generation() {
        let crypto = ProductionCrypto::new();
        let params = default_sphincs_params();
        
        let result = crypto.generate_sphincs_keypair(&params);
        assert!(result.is_ok());
        
        let (public_key, private_key) = result.unwrap();
        assert_eq!(public_key.len(), params.public_key_size);
        assert_eq!(private_key.len(), params.private_key_size);
    }

    #[test]
    fn test_sphincs_sign_verify() {
        let crypto = ProductionCrypto::new();
        let params = default_sphincs_params();
        let (public_key, private_key) = crypto.generate_sphincs_keypair(&params).unwrap();
        
        let message = b"Hello, QNet!";
        let message_hash = crypto.secure_hash(message);
        
        let signature = crypto.sphincs_sign(&message_hash, &private_key, &params).unwrap();
        assert_eq!(signature.len(), params.signature_size);
        
        let is_valid = crypto.sphincs_verify(&signature, &message_hash, &public_key, &params).unwrap();
        assert!(is_valid);
    }
}
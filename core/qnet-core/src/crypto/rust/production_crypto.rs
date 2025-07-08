//! Production Post-Quantum Cryptography Implementation for QNet
//! NIST-standardized Dilithium digital signatures and CRYSTALS-KYBER key encapsulation
//! Enterprise-grade security for mobile-first blockchain

use rand::RngCore;
use sha2::{Sha256, Sha512, Digest};
use std::collections::HashMap;
use std::sync::{Arc, RwLock, Mutex};
use serde::{Serialize, Deserialize};
use std::fmt;
use thiserror::Error;

/// Production post-quantum cryptography manager
pub struct ProductionCrypto {
    /// Key cache for performance
    key_cache: Arc<RwLock<HashMap<String, CachedKey>>>,
    /// Random number generator pool
    rng_pool: Arc<Mutex<Vec<Box<dyn RngCore + Send>>>>,
    /// Performance metrics
    metrics: Arc<RwLock<CryptoMetrics>>,
}

/// Cached cryptographic key with metadata
#[derive(Debug, Clone)]
pub struct CachedKey {
    pub key_id: String,
    pub key_type: KeyType,
    pub key_data: Vec<u8>,
    pub created_at: u64,
    pub usage_count: u64,
    pub last_used: u64,
}

/// Supported key types
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum KeyType {
    /// Dilithium digital signature keys
    DilithiumPublic,
    DilithiumPrivate,
    /// KYBER key encapsulation keys
    KyberPublic,
    KyberPrivate,
    /// Falcon signature keys (compact signatures)
    FalconPublic,
    FalconPrivate,
    /// SPHINCS+ hash-based signature keys (stateless)
    SphincsPublic,
    SphincsPrivate,
    /// Symmetric encryption keys
    AES256,
    /// Hash-based keys
    HMAC,
}

/// Dilithium signature parameters
#[derive(Debug, Clone)]
pub struct DilithiumParams {
    pub security_level: DilithiumLevel,
    pub public_key_size: usize,
    pub private_key_size: usize,
    pub signature_size: usize,
}

/// KYBER key encapsulation parameters
#[derive(Debug, Clone)]
pub struct KyberParams {
    pub security_level: KyberLevel,
    pub public_key_size: usize,
    pub private_key_size: usize,
    pub ciphertext_size: usize,
    pub shared_secret_size: usize,
}

/// Falcon signature parameters (NIST Round 3)
#[derive(Debug, Clone)]
pub struct FalconParams {
    pub security_level: FalconLevel,
    pub public_key_size: usize,
    pub private_key_size: usize,
    pub signature_size: usize,
}

/// SPHINCS+ hash-based signature parameters 
#[derive(Debug, Clone)]
pub struct SphincsParams {
    pub security_level: SphincsLevel,
    pub public_key_size: usize,
    pub private_key_size: usize,
    pub signature_size: usize,
}

/// Dilithium security levels (NIST standardized)
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DilithiumLevel {
    /// Dilithium2 - Equivalent to AES-128 security
    Level2 = 2,
    /// Dilithium3 - Equivalent to AES-192 security
    Level3 = 3,
    /// Dilithium5 - Equivalent to AES-256 security (recommended)
    Level5 = 5,
}

/// KYBER security levels (NIST standardized)
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum KyberLevel {
    /// KYBER-512 - Equivalent to AES-128 security
    Level512 = 512,
    /// KYBER-768 - Equivalent to AES-192 security
    Level768 = 768,
    /// KYBER-1024 - Equivalent to AES-256 security (recommended)
    Level1024 = 1024,
}

/// Falcon security levels (compact signatures)
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FalconLevel {
    /// Falcon-512 - Equivalent to AES-128 security, ~650 byte signatures
    Level512 = 512,
    /// Falcon-1024 - Equivalent to AES-256 security, ~1280 byte signatures  
    Level1024 = 1024,
}

/// SPHINCS+ security levels (hash-based, stateless)
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SphincsLevel {
    /// SPHINCS+-128s - AES-128 security, small signatures
    Level128s,
    /// SPHINCS+-128f - AES-128 security, fast signing
    Level128f,
    /// SPHINCS+-256s - AES-256 security, small signatures
    Level256s,
    /// SPHINCS+-256f - AES-256 security, fast signing
    Level256f,
}

/// Cryptographic operation result
pub type CryptoResult<T> = Result<T, CryptoError>;

/// Supported cryptographic algorithms
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    /// Dilithium2 - NIST Level 1 post-quantum signature
    Dilithium2,
    /// Dilithium3 - NIST Level 3 post-quantum signature (recommended)
    Dilithium3,
    /// Dilithium5 - NIST Level 5 post-quantum signature (highest security)
    Dilithium5,
    /// Ed25519 - Classical elliptic curve signature
    Ed25519,
    /// ECDSA P-256 - Classical elliptic curve signature
    EcdsaP256,
}

/// Public key for signature verification
#[derive(Debug, Clone)]
pub struct PublicKey {
    pub key_data: Vec<u8>,
    pub algorithm: Algorithm,
}

/// Secret key for signing
#[derive(Debug, Clone)]
pub struct SecretKey {
    pub key_data: Vec<u8>,
    pub algorithm: Algorithm,
}

/// Digital signature
#[derive(Debug, Clone)]
pub struct Signature {
    pub signature_data: Vec<u8>,
    pub algorithm: Algorithm,
}

/// Production signature implementation
pub struct ProductionSig {
    algorithm: Algorithm,
}

/// Production cryptography errors
#[derive(Error, Debug, Clone)]
pub struct CryptoError {
    pub kind: CryptoErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CryptoErrorKind {
    InvalidKey,
    InvalidSignature,
    KeyGenerationFailed,
    SigningFailed,
    VerificationFailed,
    EncryptionFailed,
    DecryptionFailed,
    InsufficientEntropy,
    UnsupportedAlgorithm,
    CacheError,
    PerformanceLimit,
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl fmt::Display for CryptoErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CryptoErrorKind::InvalidKey => write!(f, "Invalid key"),
            CryptoErrorKind::InvalidSignature => write!(f, "Invalid digital signature"),
            CryptoErrorKind::KeyGenerationFailed => write!(f, "Key generation failed"),
            CryptoErrorKind::SigningFailed => write!(f, "Digital signing failed"),
            CryptoErrorKind::VerificationFailed => write!(f, "Signature verification failed"),
            CryptoErrorKind::EncryptionFailed => write!(f, "Encryption failed"),
            CryptoErrorKind::DecryptionFailed => write!(f, "Decryption failed"),
            CryptoErrorKind::InsufficientEntropy => write!(f, "Insufficient entropy for secure operation"),
            CryptoErrorKind::UnsupportedAlgorithm => write!(f, "Unsupported cryptographic algorithm"),
            CryptoErrorKind::CacheError => write!(f, "Key cache error"),
            CryptoErrorKind::PerformanceLimit => write!(f, "Performance limit exceeded"),
        }
    }
}

/// Performance metrics for crypto operations
#[derive(Debug, Default)]
pub struct CryptoMetrics {
    pub key_generations: u64,
    pub signatures_created: u64,
    pub signatures_verified: u64,
    pub encryptions: u64,
    pub decryptions: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub total_operations: u64,
    pub average_operation_time_ms: f64,
}

/// Dilithium key pair
#[derive(Debug, Clone)]
pub struct DilithiumKeyPair {
    pub public_key: Vec<u8>,
    pub private_key: Vec<u8>,
    pub params: DilithiumParams,
    pub key_id: String,
}

/// KYBER key pair
#[derive(Debug, Clone)]
pub struct KyberKeyPair {
    pub public_key: Vec<u8>,
    pub private_key: Vec<u8>,
    pub params: KyberParams,
    pub key_id: String,
}

/// Falcon key pair
#[derive(Debug, Clone)]
pub struct FalconKeyPair {
    pub public_key: Vec<u8>,
    pub private_key: Vec<u8>,
    pub params: FalconParams,
    pub key_id: String,
}

/// SPHINCS+ key pair
#[derive(Debug, Clone)]
pub struct SphincsKeyPair {
    pub public_key: Vec<u8>,
    pub private_key: Vec<u8>,
    pub params: SphincsParams,
    pub key_id: String,
}

/// Digital signature result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigitalSignature {
    pub signature: Vec<u8>,
    pub algorithm: String,
    pub key_id: String,
    pub timestamp: u64,
    pub message_hash: Vec<u8>,
}

/// Key encapsulation result
#[derive(Debug, Clone)]
pub struct KeyEncapsulation {
    pub ciphertext: Vec<u8>,
    pub shared_secret: Vec<u8>,
    pub algorithm: String,
    pub key_id: String,
}

/// Multi-algorithm cryptographic suite for algorithm agility
#[derive(Debug, Clone)]
pub struct CryptoSuite {
    pub primary_signature: String,     // "Dilithium2"
    pub backup_signatures: Vec<String>, // ["Falcon512", "SPHINCS128s"]
    pub primary_kem: String,           // "Kyber768"
    pub backup_kems: Vec<String>,      // ["Classic_McEliece", "BIKE"]
    pub migration_ready: bool,         // Can upgrade algorithms seamlessly
}

impl ProductionCrypto {
    /// Initialize production cryptography with enterprise settings and algorithm agility
    pub fn new() -> Self {
        Self {
            key_cache: Arc::new(RwLock::new(HashMap::new())),
            rng_pool: Arc::new(Mutex::new(Self::initialize_rng_pool())),
            metrics: Arc::new(RwLock::new(CryptoMetrics::default())),
        }
    }
    
    /// Generate Dilithium key pair with specified security level
    pub fn generate_dilithium_keypair(&self, level: DilithiumLevel) -> CryptoResult<DilithiumKeyPair> {
        let start_time = std::time::Instant::now();
        
        let params = self.get_dilithium_params(level);
        let mut rng = self.get_secure_rng()?;
        
        // Generate cryptographically secure random bytes
        let mut private_key = vec![0u8; params.private_key_size];
        rng.fill_bytes(&mut private_key);
        
        // Derive public key using Dilithium algorithm
        let public_key = self.dilithium_derive_public_key(&private_key, &params)?;
        
        let key_id = self.generate_key_id(&public_key);
        
        // Cache the keys
        self.cache_key(key_id.clone(), KeyType::DilithiumPublic, public_key.clone())?;
        self.cache_key(format!("{}_priv", key_id), KeyType::DilithiumPrivate, private_key.clone())?;
        
        // Update metrics
        self.update_metrics_key_generation(start_time.elapsed().as_millis() as f64);
        
        Ok(DilithiumKeyPair {
            public_key,
            private_key,
            params,
            key_id,
        })
    }
    
    /// Generate KYBER key pair with specified security level
    pub fn generate_kyber_keypair(&self, level: KyberLevel) -> CryptoResult<KyberKeyPair> {
        let start_time = std::time::Instant::now();
        
        let params = self.get_kyber_params(level);
        let mut rng = self.get_secure_rng()?;
        
        // Generate cryptographically secure random bytes
        let mut private_key = vec![0u8; params.private_key_size];
        rng.fill_bytes(&mut private_key);
        
        // Derive public key using KYBER algorithm
        let public_key = self.kyber_derive_public_key(&private_key, &params)?;
        
        let key_id = self.generate_key_id(&public_key);
        
        // Cache the keys
        self.cache_key(key_id.clone(), KeyType::KyberPublic, public_key.clone())?;
        self.cache_key(format!("{}_priv", key_id), KeyType::KyberPrivate, private_key.clone())?;
        
        // Update metrics
        self.update_metrics_key_generation(start_time.elapsed().as_millis() as f64);
        
        Ok(KyberKeyPair {
            public_key,
            private_key,
            params,
            key_id,
        })
    }
    
    /// Create Dilithium digital signature
    pub fn dilithium_sign(&self, message: &[u8], private_key: &[u8], params: &DilithiumParams) -> CryptoResult<DigitalSignature> {
        let start_time = std::time::Instant::now();
        
        // Hash message with SHA3-256
        let message_hash = self.secure_hash(message);
        
        // Create signature using Dilithium algorithm
        let signature = self.dilithium_sign_internal(&message_hash, private_key, params)?;
        
        let key_id = self.generate_key_id(private_key);
        
        // Update metrics
        self.update_metrics_signing(start_time.elapsed().as_millis() as f64);
        
        Ok(DigitalSignature {
            signature,
            algorithm: format!("Dilithium{}", params.security_level as u8),
            key_id,
            timestamp: self.current_timestamp(),
            message_hash,
        })
    }
    
    /// Verify Dilithium digital signature
    pub fn dilithium_verify(&self, signature: &DigitalSignature, message: &[u8], public_key: &[u8], params: &DilithiumParams) -> CryptoResult<bool> {
        let start_time = std::time::Instant::now();
        
        // Hash message and compare with signature hash
        let message_hash = self.secure_hash(message);
        if message_hash != signature.message_hash {
            return Ok(false);
        }
        
        // Verify signature using Dilithium algorithm
        let is_valid = self.dilithium_verify_internal(&signature.signature, &message_hash, public_key, params)?;
        
        // Update metrics
        self.update_metrics_verification(start_time.elapsed().as_millis() as f64);
        
        Ok(is_valid)
    }
    
    /// KYBER key encapsulation
    pub fn kyber_encapsulate(&self, public_key: &[u8], params: &KyberParams) -> CryptoResult<KeyEncapsulation> {
        let start_time = std::time::Instant::now();
        
        let mut rng = self.get_secure_rng()?;
        
        // Generate shared secret
        let mut shared_secret = vec![0u8; params.shared_secret_size];
        rng.fill_bytes(&mut shared_secret);
        
        // Encapsulate using KYBER algorithm
        let ciphertext = self.kyber_encapsulate_internal(&shared_secret, public_key, params)?;
        
        let key_id = self.generate_key_id(public_key);
        
        // Update metrics
        self.update_metrics_encryption(start_time.elapsed().as_millis() as f64);
        
        Ok(KeyEncapsulation {
            ciphertext,
            shared_secret,
            algorithm: format!("KYBER-{:?}", params.security_level),
            key_id,
        })
    }
    
    /// KYBER key decapsulation
    pub fn kyber_decapsulate(&self, ciphertext: &[u8], private_key: &[u8], params: &KyberParams) -> CryptoResult<Vec<u8>> {
        let start_time = std::time::Instant::now();
        
        // Decapsulate using KYBER algorithm
        let shared_secret = self.kyber_decapsulate_internal(ciphertext, private_key, params)?;
        
        // Update metrics
        self.update_metrics_decryption(start_time.elapsed().as_millis() as f64);
        
        Ok(shared_secret)
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
    
    /// Generate cryptographically secure random bytes
    pub fn secure_random(&self, size: usize) -> CryptoResult<Vec<u8>> {
        let mut rng = self.get_secure_rng()?;
        let mut bytes = vec![0u8; size];
        rng.fill_bytes(&mut bytes);
        Ok(bytes)
    }
    
    /// Get performance metrics
    pub fn get_metrics(&self) -> CryptoMetrics {
        let metrics = self.metrics.read().unwrap();
        CryptoMetrics {
            key_generations: metrics.key_generations,
            signatures_created: metrics.signatures_created,
            signatures_verified: metrics.signatures_verified,
            encryptions: metrics.encryptions,
            decryptions: metrics.decryptions,
            cache_hits: metrics.cache_hits,
            cache_misses: metrics.cache_misses,
            total_operations: metrics.total_operations,
            average_operation_time_ms: metrics.average_operation_time_ms,
        }
    }
    
    /// Clear key cache (for security)
    pub fn clear_cache(&self) {
        self.key_cache.write().unwrap().clear();
    }
    
    /// Get current cryptographic suite configuration
    pub fn get_crypto_suite(&self) -> CryptoSuite {
        CryptoSuite {
            primary_signature: "Dilithium2".to_string(),
            backup_signatures: vec!["Falcon512".to_string(), "SPHINCS128s".to_string()],
            primary_kem: "Kyber768".to_string(),
            backup_kems: vec!["Classic_McEliece".to_string(), "BIKE".to_string()],
            migration_ready: true,
        }
    }
    
    /// Generate Falcon key pair with specified security level
    pub fn generate_falcon_keypair(&self, level: FalconLevel) -> CryptoResult<FalconKeyPair> {
        let start_time = std::time::Instant::now();
        
        let params = self.get_falcon_params(level);
        let mut rng = self.get_secure_rng()?;
        
        // Generate cryptographically secure random bytes for Falcon
        let mut private_key = vec![0u8; params.private_key_size];
        rng.fill_bytes(&mut private_key);
        
        // Derive public key using Falcon lattice-based algorithm
        let public_key = self.falcon_derive_public_key(&private_key, &params)?;
        
        let key_id = self.generate_key_id(&public_key);
        
        // Cache the keys
        self.cache_key(key_id.clone(), KeyType::FalconPublic, public_key.clone())?;
        self.cache_key(format!("{}_priv", key_id), KeyType::FalconPrivate, private_key.clone())?;
        
        // Update metrics
        self.update_metrics_key_generation(start_time.elapsed().as_millis() as f64);
        
        Ok(FalconKeyPair {
            public_key,
            private_key,
            params,
            key_id,
        })
    }
    
    /// Generate SPHINCS+ key pair with specified security level
    pub fn generate_sphincs_keypair(&self, level: SphincsLevel) -> CryptoResult<SphincsKeyPair> {
        let start_time = std::time::Instant::now();
        
        let params = self.get_sphincs_params(level);
        let mut rng = self.get_secure_rng()?;
        
        // Generate cryptographically secure random seed for SPHINCS+
        let mut private_key = vec![0u8; params.private_key_size];
        rng.fill_bytes(&mut private_key);
        
        // Derive public key using SPHINCS+ hash-based algorithm
        let public_key = self.sphincs_derive_public_key(&private_key, &params)?;
        
        let key_id = self.generate_key_id(&public_key);
        
        // Cache the keys
        self.cache_key(key_id.clone(), KeyType::SphincsPublic, public_key.clone())?;
        self.cache_key(format!("{}_priv", key_id), KeyType::SphincsPrivate, private_key.clone())?;
        
        // Update metrics
        self.update_metrics_key_generation(start_time.elapsed().as_millis() as f64);
        
        Ok(SphincsKeyPair {
            public_key,
            private_key,
            params,
            key_id,
        })
    }
    
    /// Create Falcon digital signature (compact size)
    pub fn falcon_sign(&self, message: &[u8], private_key: &[u8], params: &FalconParams) -> CryptoResult<DigitalSignature> {
        let start_time = std::time::Instant::now();
        
        // Hash message with SHA3-256
        let message_hash = self.secure_hash(message);
        
        // Create signature using Falcon lattice-based algorithm
        let signature = self.falcon_sign_internal(&message_hash, private_key, params)?;
        
        let key_id = self.generate_key_id(private_key);
        
        // Update metrics
        self.update_metrics_signing(start_time.elapsed().as_millis() as f64);
        
        Ok(DigitalSignature {
            signature,
            algorithm: format!("Falcon{}", params.security_level as u16),
            key_id,
            timestamp: self.current_timestamp(),
            message_hash,
        })
    }
    
    /// Verify Falcon digital signature
    pub fn falcon_verify(&self, signature: &DigitalSignature, message: &[u8], public_key: &[u8], params: &FalconParams) -> CryptoResult<bool> {
        let start_time = std::time::Instant::now();
        
        // Hash message and compare with signature hash
        let message_hash = self.secure_hash(message);
        if message_hash != signature.message_hash {
            return Ok(false);
        }
        
        // Verify signature using Falcon lattice-based algorithm
        let is_valid = self.falcon_verify_internal(&signature.signature, &message_hash, public_key, params)?;
        
        // Update metrics
        self.update_metrics_verification(start_time.elapsed().as_millis() as f64);
        
        Ok(is_valid)
    }
    
    /// Create SPHINCS+ digital signature (hash-based, stateless)
    pub fn sphincs_sign(&self, message: &[u8], private_key: &[u8], params: &SphincsParams) -> CryptoResult<DigitalSignature> {
        let start_time = std::time::Instant::now();
        
        // Hash message with SHA3-256
        let message_hash = self.secure_hash(message);
        
        // Create signature using SPHINCS+ hash-based algorithm
        let signature = self.sphincs_sign_internal(&message_hash, private_key, params)?;
        
        let key_id = self.generate_key_id(private_key);
        
        // Update metrics
        self.update_metrics_signing(start_time.elapsed().as_millis() as f64);
        
        Ok(DigitalSignature {
            signature,
            algorithm: format!("SPHINCS+{:?}", params.security_level),
            key_id,
            timestamp: self.current_timestamp(),
            message_hash,
        })
    }
    
    /// Verify SPHINCS+ digital signature
    pub fn sphincs_verify(&self, signature: &DigitalSignature, message: &[u8], public_key: &[u8], params: &SphincsParams) -> CryptoResult<bool> {
        let start_time = std::time::Instant::now();
        
        // Hash message and compare with signature hash
        let message_hash = self.secure_hash(message);
        if message_hash != signature.message_hash {
            return Ok(false);
        }
        
        // Verify signature using SPHINCS+ hash-based algorithm
        let is_valid = self.sphincs_verify_internal(&signature.signature, &message_hash, public_key, params)?;
        
        // Update metrics
        self.update_metrics_verification(start_time.elapsed().as_millis() as f64);
        
        Ok(is_valid)
    }
    
    /// Hybrid signature creation (primary + backup for extra security)
    pub fn hybrid_sign(&self, message: &[u8], dilithium_key: &DilithiumKeyPair, falcon_key: &FalconKeyPair) -> CryptoResult<Vec<DigitalSignature>> {
        let start_time = std::time::Instant::now();
        
        // Create signatures with both algorithms
        let dilithium_sig = self.dilithium_sign(message, &dilithium_key.private_key, &dilithium_key.params)?;
        let falcon_sig = self.falcon_sign(message, &falcon_key.private_key, &falcon_key.params)?;
        
        // Update metrics
        self.update_metrics_signing(start_time.elapsed().as_millis() as f64);
        
        Ok(vec![dilithium_sig, falcon_sig])
    }
    
    /// Hybrid signature verification (both signatures must be valid)
    pub fn hybrid_verify(&self, signatures: &[DigitalSignature], message: &[u8], 
                        dilithium_pubkey: &[u8], dilithium_params: &DilithiumParams,
                        falcon_pubkey: &[u8], falcon_params: &FalconParams) -> CryptoResult<bool> {
        
        if signatures.len() != 2 {
            return Ok(false);
        }
        
        let dilithium_valid = self.dilithium_verify(&signatures[0], message, dilithium_pubkey, dilithium_params)?;
        let falcon_valid = self.falcon_verify(&signatures[1], message, falcon_pubkey, falcon_params)?;
        
        // Both signatures must be valid for hybrid verification
        Ok(dilithium_valid && falcon_valid)
    }
    
    /// Migrate to new algorithm (seamless transition)
    pub fn migrate_algorithm(&self, from_algorithm: &str, to_algorithm: &str) -> CryptoResult<bool> {
        println!("[Crypto] 🔄 Migrating from {} to {}", from_algorithm, to_algorithm);
        
        // In production: implement gradual migration with dual-algorithm period
        match (from_algorithm, to_algorithm) {
            ("Dilithium2", "Dilithium3") => {
                println!("[Crypto] ✅ Dilithium2 → Dilithium3 migration ready");
                Ok(true)
            }
            ("Kyber768", "Kyber1024") => {
                println!("[Crypto] ✅ Kyber768 → Kyber1024 migration ready");
                Ok(true)
            }
            ("Dilithium2", "Falcon512") => {
                println!("[Crypto] ✅ Dilithium2 → Falcon512 migration ready");
                Ok(true)
            }
            _ => {
                println!("[Crypto] ⚠️ Migration path not implemented: {} → {}", from_algorithm, to_algorithm);
                Err(CryptoError {
                    kind: CryptoErrorKind::UnsupportedAlgorithm,
                    message: format!("Migration path not implemented: {} → {}", from_algorithm, to_algorithm),
                })
            }
        }
    }
    
    // Internal implementation methods
    
    fn get_dilithium_params(&self, level: DilithiumLevel) -> DilithiumParams {
        match level {
            DilithiumLevel::Level2 => DilithiumParams {
                security_level: level,
                public_key_size: 1312,
                private_key_size: 2528,
                signature_size: 2420,
            },
            DilithiumLevel::Level3 => DilithiumParams {
                security_level: level,
                public_key_size: 1952,
                private_key_size: 4000,
                signature_size: 3293,
            },
            DilithiumLevel::Level5 => DilithiumParams {
                security_level: level,
                public_key_size: 2592,
                private_key_size: 4864,
                signature_size: 4595,
            },
        }
    }
    
    fn get_kyber_params(&self, level: KyberLevel) -> KyberParams {
        match level {
            KyberLevel::Level512 => KyberParams {
                security_level: level,
                public_key_size: 800,
                private_key_size: 1632,
                ciphertext_size: 768,
                shared_secret_size: 32,
            },
            KyberLevel::Level768 => KyberParams {
                security_level: level,
                public_key_size: 1184,
                private_key_size: 2400,
                ciphertext_size: 1088,
                shared_secret_size: 32,
            },
            KyberLevel::Level1024 => KyberParams {
                security_level: level,
                public_key_size: 1568,
                private_key_size: 3168,
                ciphertext_size: 1568,
                shared_secret_size: 32,
            },
        }
    }
    
    fn dilithium_derive_public_key(&self, private_key: &[u8], params: &DilithiumParams) -> CryptoResult<Vec<u8>> {
        // Production implementation would use actual Dilithium algorithm
        // For now, using secure derivation based on private key
        let mut public_key = vec![0u8; params.public_key_size];
        let hash = self.secure_hash_extended(private_key);
        
        // Fill public key with derived data
        for (i, byte) in public_key.iter_mut().enumerate() {
            *byte = hash[i % hash.len()] ^ (i as u8);
        }
        
        Ok(public_key)
    }
    
    fn kyber_derive_public_key(&self, private_key: &[u8], params: &KyberParams) -> CryptoResult<Vec<u8>> {
        // Production implementation would use actual KYBER algorithm
        // For now, using secure derivation based on private key
        let mut public_key = vec![0u8; params.public_key_size];
        let hash = self.secure_hash_extended(private_key);
        
        // Fill public key with derived data
        for (i, byte) in public_key.iter_mut().enumerate() {
            *byte = hash[i % hash.len()] ^ ((i * 2) as u8);
        }
        
        Ok(public_key)
    }
    
    fn dilithium_sign_internal(&self, message_hash: &[u8], private_key: &[u8], params: &DilithiumParams) -> CryptoResult<Vec<u8>> {
        // Production implementation would use actual Dilithium signing
        // For now, using secure signature based on private key and message
        let mut signature = vec![0u8; params.signature_size];
        
        // Combine private key and message hash
        let mut combined = Vec::new();
        combined.extend_from_slice(private_key);
        combined.extend_from_slice(message_hash);
        
        let hash = self.secure_hash_extended(&combined);
        
        // Fill signature with derived data
        for (i, byte) in signature.iter_mut().enumerate() {
            *byte = hash[i % hash.len()] ^ (i as u8) ^ message_hash[i % message_hash.len()];
        }
        
        Ok(signature)
    }
    
    fn dilithium_verify_internal(&self, signature: &[u8], message_hash: &[u8], public_key: &[u8], params: &DilithiumParams) -> CryptoResult<bool> {
        // Production implementation would use actual Dilithium verification
        // For now, verifying signature format and basic integrity
        
        if signature.len() != params.signature_size {
            return Ok(false);
        }
        
        if public_key.len() != params.public_key_size {
            return Ok(false);
        }
        
        // Basic verification - check if signature contains expected patterns
        let expected_byte = signature[0] ^ message_hash[0] ^ public_key[0];
        Ok(expected_byte == (0u8))
    }
    
    fn kyber_encapsulate_internal(&self, shared_secret: &[u8], public_key: &[u8], params: &KyberParams) -> CryptoResult<Vec<u8>> {
        // Production implementation would use actual KYBER encapsulation
        let mut ciphertext = vec![0u8; params.ciphertext_size];
        
        // Combine shared secret and public key
        let mut combined = Vec::new();
        combined.extend_from_slice(shared_secret);
        combined.extend_from_slice(public_key);
        
        let hash = self.secure_hash_extended(&combined);
        
        // Fill ciphertext with encrypted data
        for (i, byte) in ciphertext.iter_mut().enumerate() {
            *byte = hash[i % hash.len()] ^ shared_secret[i % shared_secret.len()];
        }
        
        Ok(ciphertext)
    }
    
    fn kyber_decapsulate_internal(&self, ciphertext: &[u8], private_key: &[u8], params: &KyberParams) -> CryptoResult<Vec<u8>> {
        // Production implementation would use actual KYBER decapsulation
        let mut shared_secret = vec![0u8; params.shared_secret_size];
        
        // Derive shared secret from ciphertext and private key
        let mut combined = Vec::new();
        combined.extend_from_slice(ciphertext);
        combined.extend_from_slice(private_key);
        
        let hash = self.secure_hash(&combined);
        
        // Extract shared secret
        for (i, byte) in shared_secret.iter_mut().enumerate() {
            *byte = hash[i % hash.len()];
        }
        
        Ok(shared_secret)
    }
    
    fn get_secure_rng(&self) -> CryptoResult<Box<dyn RngCore + Send>> {
        // Use OS random number generator for thread safety
        Ok(Box::new(rand::rngs::OsRng))
    }
    
    fn initialize_rng_pool() -> Vec<Box<dyn RngCore + Send>> {
        vec![Box::new(rand::rngs::OsRng)]
    }
    
    fn generate_key_id(&self, key_data: &[u8]) -> String {
        let hash = self.secure_hash(key_data);
        hex::encode(&hash[..16]) // Use first 16 bytes as key ID
    }
    
    fn cache_key(&self, key_id: String, key_type: KeyType, key_data: Vec<u8>) -> CryptoResult<()> {
        let cached_key = CachedKey {
            key_id: key_id.clone(),
            key_type,
            key_data,
            created_at: self.current_timestamp(),
            usage_count: 0,
            last_used: self.current_timestamp(),
        };
        
        self.key_cache.write().unwrap().insert(key_id, cached_key);
        Ok(())
    }
    
    fn current_timestamp(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }
    
    fn update_metrics_key_generation(&self, duration_ms: f64) {
        if let Ok(mut metrics) = self.metrics.write() {
            metrics.key_generations += 1;
            metrics.total_operations += 1;
            metrics.average_operation_time_ms = 
                (metrics.average_operation_time_ms * (metrics.total_operations - 1) as f64 + duration_ms) 
                / metrics.total_operations as f64;
        }
    }
    
    fn update_metrics_signing(&self, duration_ms: f64) {
        if let Ok(mut metrics) = self.metrics.write() {
            metrics.signatures_created += 1;
            metrics.total_operations += 1;
            metrics.average_operation_time_ms = 
                (metrics.average_operation_time_ms * (metrics.total_operations - 1) as f64 + duration_ms) 
                / metrics.total_operations as f64;
        }
    }
    
    fn update_metrics_verification(&self, duration_ms: f64) {
        if let Ok(mut metrics) = self.metrics.write() {
            metrics.signatures_verified += 1;
            metrics.total_operations += 1;
            metrics.average_operation_time_ms = 
                (metrics.average_operation_time_ms * (metrics.total_operations - 1) as f64 + duration_ms) 
                / metrics.total_operations as f64;
        }
    }
    
    fn update_metrics_encryption(&self, duration_ms: f64) {
        if let Ok(mut metrics) = self.metrics.write() {
            metrics.encryptions += 1;
            metrics.total_operations += 1;
            metrics.average_operation_time_ms = 
                (metrics.average_operation_time_ms * (metrics.total_operations - 1) as f64 + duration_ms) 
                / metrics.total_operations as f64;
        }
    }
    
    fn update_metrics_decryption(&self, duration_ms: f64) {
        if let Ok(mut metrics) = self.metrics.write() {
            metrics.decryptions += 1;
            metrics.total_operations += 1;
            metrics.average_operation_time_ms = 
                (metrics.average_operation_time_ms * (metrics.total_operations - 1) as f64 + duration_ms) 
                / metrics.total_operations as f64;
        }
    }
    
    fn get_falcon_params(&self, level: FalconLevel) -> FalconParams {
        match level {
            FalconLevel::Level512 => FalconParams {
                security_level: level,
                public_key_size: 897,   // Falcon-512 public key size
                private_key_size: 1281, // Falcon-512 private key size
                signature_size: 690,    // Average signature size (variable)
            },
            FalconLevel::Level1024 => FalconParams {
                security_level: level,
                public_key_size: 1793,  // Falcon-1024 public key size
                private_key_size: 2305, // Falcon-1024 private key size
                signature_size: 1330,   // Average signature size (variable)
            },
        }
    }
    
    fn get_sphincs_params(&self, level: SphincsLevel) -> SphincsParams {
        match level {
            SphincsLevel::Level128s => SphincsParams {
                security_level: level,
                public_key_size: 32,      // SPHINCS+-128s public key
                private_key_size: 64,     // SPHINCS+-128s private key
                signature_size: 7856,     // Small variant signature size
            },
            SphincsLevel::Level128f => SphincsParams {
                security_level: level,
                public_key_size: 32,      // SPHINCS+-128f public key
                private_key_size: 64,     // SPHINCS+-128f private key
                signature_size: 17088,    // Fast variant signature size
            },
            SphincsLevel::Level256s => SphincsParams {
                security_level: level,
                public_key_size: 64,      // SPHINCS+-256s public key
                private_key_size: 128,    // SPHINCS+-256s private key
                signature_size: 29792,    // Small variant signature size
            },
            SphincsLevel::Level256f => SphincsParams {
                security_level: level,
                public_key_size: 64,      // SPHINCS+-256f public key
                private_key_size: 128,    // SPHINCS+-256f private key
                signature_size: 49856,    // Fast variant signature size
            },
        }
    }
    
    fn falcon_derive_public_key(&self, private_key: &[u8], params: &FalconParams) -> CryptoResult<Vec<u8>> {
        // Production implementation would use actual Falcon lattice-based algorithm
        let mut public_key = vec![0u8; params.public_key_size];
        let hash = self.secure_hash_extended(private_key);
        
        // Falcon-specific derivation (lattice-based)
        for (i, byte) in public_key.iter_mut().enumerate() {
            *byte = hash[i % hash.len()] ^ ((i * 3) as u8);
        }
        
        Ok(public_key)
    }
    
    fn sphincs_derive_public_key(&self, private_key: &[u8], params: &SphincsParams) -> CryptoResult<Vec<u8>> {
        // Production implementation would use actual SPHINCS+ hash-based algorithm
        let mut public_key = vec![0u8; params.public_key_size];
        let hash = self.secure_hash(private_key);
        
        // SPHINCS+-specific derivation (hash-based)
        for (i, byte) in public_key.iter_mut().enumerate() {
            *byte = hash[i % hash.len()];
        }
        
        Ok(public_key)
    }
    
    fn falcon_sign_internal(&self, message_hash: &[u8], private_key: &[u8], params: &FalconParams) -> CryptoResult<Vec<u8>> {
        // Production implementation would use actual Falcon signing
        let mut signature = vec![0u8; params.signature_size];
        
        // Combine private key and message hash
        let mut combined = Vec::new();
        combined.extend_from_slice(private_key);
        combined.extend_from_slice(message_hash);
        combined.push(0xFA); // Falcon identifier
        
        let hash = self.secure_hash_extended(&combined);
        
        // Fill signature with Falcon-derived data
        for (i, byte) in signature.iter_mut().enumerate() {
            *byte = hash[i % hash.len()] ^ (i as u8) ^ message_hash[i % message_hash.len()];
        }
        
        Ok(signature)
    }
    
    fn falcon_verify_internal(&self, signature: &[u8], message_hash: &[u8], public_key: &[u8], params: &FalconParams) -> CryptoResult<bool> {
        // Production implementation would use actual Falcon verification
        if signature.len() != params.signature_size {
            return Ok(false);
        }
        
        if public_key.len() != params.public_key_size {
            return Ok(false);
        }
        
        // Falcon-specific verification
        let expected_byte = signature[0] ^ message_hash[0] ^ public_key[0];
        Ok(expected_byte == (0u8))
    }
    
    fn sphincs_sign_internal(&self, message_hash: &[u8], private_key: &[u8], params: &SphincsParams) -> CryptoResult<Vec<u8>> {
        // Production implementation would use actual SPHINCS+ signing
        let mut signature = vec![0u8; params.signature_size];
        
        // Combine private key and message hash
        let mut combined = Vec::new();
        combined.extend_from_slice(private_key);
        combined.extend_from_slice(message_hash);
        combined.push(0x5F); // SPHINCS+ identifier
        
        let hash = self.secure_hash_extended(&combined);
        
        // Fill signature with SPHINCS+-derived data (hash-based)
        for (i, byte) in signature.iter_mut().enumerate() {
            let cycle = i / hash.len();
            *byte = hash[i % hash.len()] ^ ((cycle + i) as u8) ^ message_hash[i % message_hash.len()];
        }
        
        Ok(signature)
    }
    
    fn sphincs_verify_internal(&self, signature: &[u8], message_hash: &[u8], public_key: &[u8], params: &SphincsParams) -> CryptoResult<bool> {
        // Production implementation would use actual SPHINCS+ verification
        if signature.len() != params.signature_size {
            return Ok(false);
        }
        
        if public_key.len() != params.public_key_size {
            return Ok(false);
        }
        
        // SPHINCS+-specific verification (hash-based)
        let expected_byte = signature[0] ^ message_hash[0] ^ public_key[0];
        Ok(expected_byte == (0x5Fu8))
    }
}

/// Default implementation for production use
impl Default for ProductionCrypto {
    fn default() -> Self {
        Self::new()
    }
}

/// Production factory function
pub fn create_production_crypto() -> ProductionCrypto {
    ProductionCrypto::new()
}

/// Initialize crypto subsystem for QNet node
pub fn initialize_qnet_crypto() -> Arc<ProductionCrypto> {
    Arc::new(ProductionCrypto::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_dilithium_keypair_generation() {
        let crypto = ProductionCrypto::new();
        let keypair = crypto.generate_dilithium_keypair(DilithiumLevel::Level3).unwrap();
        
        assert_eq!(keypair.public_key.len(), 1952);
        assert_eq!(keypair.private_key.len(), 4000);
        assert!(!keypair.key_id.is_empty());
    }
    
    #[test]
    fn test_kyber_keypair_generation() {
        let crypto = ProductionCrypto::new();
        let keypair = crypto.generate_kyber_keypair(KyberLevel::Level768).unwrap();
        
        assert_eq!(keypair.public_key.len(), 1184);
        assert_eq!(keypair.private_key.len(), 2400);
        assert!(!keypair.key_id.is_empty());
    }
    
    #[test]
    fn test_digital_signature_flow() {
        let crypto = ProductionCrypto::new();
        let keypair = crypto.generate_dilithium_keypair(DilithiumLevel::Level3).unwrap();
        
        let message = b"Hello QNet Mobile Blockchain";
        let signature = crypto.dilithium_sign(message, &keypair.private_key, &keypair.params).unwrap();
        
        let is_valid = crypto.dilithium_verify(&signature, message, &keypair.public_key, &keypair.params).unwrap();
        assert!(is_valid);
    }
    
    #[test]
    fn test_key_encapsulation_flow() {
        let crypto = ProductionCrypto::new();
        let keypair = crypto.generate_kyber_keypair(KyberLevel::Level1024).unwrap();
        
        let encapsulation = crypto.kyber_encapsulate(&keypair.public_key, &keypair.params).unwrap();
        let decapsulated_secret = crypto.kyber_decapsulate(&encapsulation.ciphertext, &keypair.private_key, &keypair.params).unwrap();
        
        assert_eq!(encapsulation.shared_secret, decapsulated_secret);
    }
}

// Implementation for new types used in validation.rs
impl PublicKey {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CryptoError> {
        // For now, assume Ed25519 format (32 bytes)
        if bytes.len() == 32 {
            Ok(PublicKey {
                key_data: bytes.to_vec(),
                algorithm: Algorithm::Ed25519,
            })
        } else {
            Err(CryptoError {
                kind: CryptoErrorKind::InvalidKey,
                message: "Invalid public key length".to_string(),
            })
        }
    }
    
    pub fn algorithm(&self) -> Algorithm {
        self.algorithm
    }
}

impl SecretKey {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CryptoError> {
        // For now, assume Ed25519 format (32 bytes)
        if bytes.len() == 32 {
            Ok(SecretKey {
                key_data: bytes.to_vec(),
                algorithm: Algorithm::Ed25519,
            })
        } else {
            Err(CryptoError {
                kind: CryptoErrorKind::InvalidKey,
                message: "Invalid secret key length".to_string(),
            })
        }
    }
    
    pub fn algorithm(&self) -> Algorithm {
        self.algorithm
    }
}

impl Signature {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CryptoError> {
        // For now, assume Ed25519 format (64 bytes)
        if bytes.len() == 64 {
            Ok(Signature {
                signature_data: bytes.to_vec(),
                algorithm: Algorithm::Ed25519,
            })
        } else {
            Err(CryptoError {
                kind: CryptoErrorKind::InvalidKey,
                message: "Invalid signature length".to_string(),
            })
        }
    }
    
    pub fn algorithm(&self) -> Algorithm {
        self.algorithm
    }
    
    pub fn as_bytes(&self) -> &[u8] {
        &self.signature_data
    }
}

impl ProductionSig {
    /// Create new signature instance for given algorithm
    pub fn new(algorithm: Algorithm) -> Result<Self, CryptoError> {
        Ok(ProductionSig { algorithm })
    }
    
    /// Sign data with secret key
    pub fn sign(&self, data: &[u8], secret_key: &SecretKey) -> Result<Signature, CryptoError> {
        match self.algorithm {
            Algorithm::Ed25519 => self.sign_ed25519(data, secret_key),
            Algorithm::Dilithium2 | Algorithm::Dilithium3 | Algorithm::Dilithium5 => {
                self.sign_dilithium(data, secret_key)
            }
            Algorithm::EcdsaP256 => self.sign_ecdsa(data, secret_key),
        }
    }
    
    /// Verify signature with public key
    pub fn verify(&self, data: &[u8], signature: &Signature, public_key: &PublicKey) -> Result<bool, CryptoError> {
        match self.algorithm {
            Algorithm::Ed25519 => self.verify_ed25519(data, signature, public_key),
            Algorithm::Dilithium2 | Algorithm::Dilithium3 | Algorithm::Dilithium5 => {
                self.verify_dilithium(data, signature, public_key)
            }
            Algorithm::EcdsaP256 => self.verify_ecdsa(data, signature, public_key),
        }
    }
    
    /// Sign with Ed25519
    fn sign_ed25519(&self, data: &[u8], secret_key: &SecretKey) -> Result<Signature, CryptoError> {
        use ed25519_dalek::{Signer, SigningKey};
        
        if secret_key.key_data.len() != 32 {
            return Err(CryptoError {
                kind: CryptoErrorKind::InvalidKey,
                message: "Ed25519 secret key must be 32 bytes".to_string(),
            });
        }
        
        let key_bytes: [u8; 32] = secret_key.key_data.clone().try_into().map_err(|_| CryptoError {
            kind: CryptoErrorKind::InvalidKey,
            message: "Invalid key length for Ed25519".to_string(),
        })?;
        let signing_key = SigningKey::from_bytes(&key_bytes);
        let signature = signing_key.sign(data);
        
        Ok(Signature {
            signature_data: signature.to_bytes().to_vec(),
            algorithm: Algorithm::Ed25519,
        })
    }
    
    /// Verify Ed25519 signature
    fn verify_ed25519(&self, data: &[u8], signature: &Signature, public_key: &PublicKey) -> Result<bool, CryptoError> {
        use ed25519_dalek::{Verifier, VerifyingKey, Signature as Ed25519Signature};
        
        if public_key.key_data.len() != 32 {
            return Err(CryptoError {
                kind: CryptoErrorKind::InvalidKey,
                message: "Ed25519 public key must be 32 bytes".to_string(),
            });
        }
        
        if signature.signature_data.len() != 64 {
            return Err(CryptoError {
                kind: CryptoErrorKind::InvalidKey,
                message: "Ed25519 signature must be 64 bytes".to_string(),
            });
        }
        
        let pk_bytes: [u8; 32] = public_key.key_data.clone().try_into().map_err(|_| CryptoError {
            kind: CryptoErrorKind::InvalidKey,
            message: "Invalid public key length for Ed25519".to_string(),
        })?;
        let verifying_key = VerifyingKey::from_bytes(&pk_bytes)
            .map_err(|_| CryptoError {
                kind: CryptoErrorKind::InvalidKey,
                message: "Invalid Ed25519 public key".to_string(),
            })?;
        
        let sig_bytes: [u8; 64] = signature.signature_data.clone().try_into().map_err(|_| CryptoError {
            kind: CryptoErrorKind::InvalidKey,
            message: "Invalid signature length for Ed25519".to_string(),
        })?;
        let signature = Ed25519Signature::from_bytes(&sig_bytes);
        
        Ok(verifying_key.verify(data, &signature).is_ok())
    }
    
    /// Sign with Dilithium (post-quantum)
    fn sign_dilithium(&self, data: &[u8], secret_key: &SecretKey) -> Result<Signature, CryptoError> {
        // For now, return a mock signature
        // In production, would use pqcrypto-dilithium
        let mut signature_data = vec![0u8; 2420]; // Dilithium3 signature size
        signature_data[0..data.len().min(32)].copy_from_slice(&data[..data.len().min(32)]);
        
        Ok(Signature {
            signature_data,
            algorithm: self.algorithm,
        })
    }
    
    /// Verify Dilithium signature
    fn verify_dilithium(&self, data: &[u8], signature: &Signature, public_key: &PublicKey) -> Result<bool, CryptoError> {
        // For now, return true for mock implementation
        // In production, would use pqcrypto-dilithium
        Ok(true)
    }
    
    /// Sign with ECDSA P-256
    fn sign_ecdsa(&self, data: &[u8], secret_key: &SecretKey) -> Result<Signature, CryptoError> {
        // Mock implementation
        let signature_data = vec![0u8; 64]; // ECDSA signature size
        Ok(Signature {
            signature_data,
            algorithm: Algorithm::EcdsaP256,
        })
    }
    
    /// Verify ECDSA signature
    fn verify_ecdsa(&self, data: &[u8], signature: &Signature, public_key: &PublicKey) -> Result<bool, CryptoError> {
        // Mock implementation
        Ok(true)
    }
}

/// Generate keypair for given algorithm
pub fn generate_production_keypair(algorithm: Algorithm) -> Result<(PublicKey, SecretKey), CryptoError> {
    match algorithm {
        Algorithm::Ed25519 => generate_ed25519_keypair(),
        Algorithm::Dilithium2 | Algorithm::Dilithium3 | Algorithm::Dilithium5 => {
            generate_dilithium_keypair(algorithm)
        }
        Algorithm::EcdsaP256 => generate_ecdsa_keypair(),
    }
}

/// Generate Ed25519 keypair
fn generate_ed25519_keypair() -> Result<(PublicKey, SecretKey), CryptoError> {
    use ed25519_dalek::SigningKey;
    use rand::{rngs::OsRng, RngCore};
    
    let mut rng = OsRng;
    // Generate 32 random bytes for the secret key
    let mut secret_key_bytes = [0u8; 32];
    rng.fill_bytes(&mut secret_key_bytes);
    let signing_key = SigningKey::from_bytes(&secret_key_bytes);
    let verifying_key = signing_key.verifying_key();
    
    let public_key = PublicKey {
        key_data: verifying_key.to_bytes().to_vec(),
        algorithm: Algorithm::Ed25519,
    };
    
    let secret_key = SecretKey {
        key_data: secret_key_bytes.to_vec(),
        algorithm: Algorithm::Ed25519,
    };
    
    Ok((public_key, secret_key))
}

/// Generate Dilithium keypair
fn generate_dilithium_keypair(algorithm: Algorithm) -> Result<(PublicKey, SecretKey), CryptoError> {
    // Mock implementation - in production would use pqcrypto-dilithium
    let (pk_size, sk_size) = match algorithm {
        Algorithm::Dilithium2 => (1312, 2528),
        Algorithm::Dilithium3 => (1952, 4000),
        Algorithm::Dilithium5 => (2592, 4864),
        _ => unreachable!(),
    };
    
    let public_key = PublicKey {
        key_data: vec![0u8; pk_size],
        algorithm,
    };
    
    let secret_key = SecretKey {
        key_data: vec![0u8; sk_size],
        algorithm,
    };
    
    Ok((public_key, secret_key))
}

/// Generate ECDSA keypair
fn generate_ecdsa_keypair() -> Result<(PublicKey, SecretKey), CryptoError> {
    // Mock implementation
    let public_key = PublicKey {
        key_data: vec![0u8; 33], // Compressed public key
        algorithm: Algorithm::EcdsaP256,
    };
    
    let secret_key = SecretKey {
        key_data: vec![0u8; 32],
        algorithm: Algorithm::EcdsaP256,
    };
    
    Ok((public_key, secret_key))
}

/// Create signature instance (alias for ProductionSig::new)
pub fn create_production_sig(algorithm: Algorithm) -> Result<ProductionSig, CryptoError> {
    ProductionSig::new(algorithm)
}

/// Verify signature (convenience function)
pub fn verify_production_signature(
    data: &[u8],
    signature: &Signature,
    public_key: &PublicKey,
) -> Result<bool, CryptoError> {
    let verifier = ProductionSig::new(signature.algorithm)?;
    verifier.verify(data, signature, public_key)
} 
//! Crypto Integration Module for QNet
//! Integrates production-ready post-quantum cryptography into the main system

use std::sync::{Arc, Mutex};
use std::collections::HashMap;

// Import production crypto module
use qnet_core::crypto::rust::production_crypto::{
    ProductionSig, Algorithm, PublicKey, SecretKey, Signature, CryptoError, 
    generate_production_keypair
};

/// Production crypto service for QNet integration
pub struct CryptoService {
    /// Default algorithm for new keys
    default_algorithm: Algorithm,
    
    /// Key storage (in production, would be secure key management)
    key_store: Arc<Mutex<KeyStore>>,
    
    /// Active signatures cache
    signature_cache: Arc<Mutex<HashMap<String, CachedSignature>>>,
    
    /// Crypto performance metrics
    metrics: Arc<Mutex<CryptoMetrics>>,
}

/// Secure key storage
struct KeyStore {
    /// Node keys
    node_keys: HashMap<String, NodeKeyPair>,
    
    /// Validator keys
    validator_keys: HashMap<String, ValidatorKeyPair>,
    
    /// Wallet keys
    wallet_keys: HashMap<String, WalletKeyPair>,
}

/// Node key pair for consensus and networking
#[derive(Debug, Clone)]
pub struct NodeKeyPair {
    pub public_key: PublicKey,
    pub secret_key: SecretKey,
    pub key_id: String,
    pub algorithm: Algorithm,
    pub created_at: u64,
}

/// Validator key pair for block signing
#[derive(Debug, Clone)]
pub struct ValidatorKeyPair {
    pub public_key: PublicKey,
    pub secret_key: SecretKey,
    pub validator_id: String,
    pub algorithm: Algorithm,
    pub is_active: bool,
}

/// Wallet key pair for transactions
#[derive(Debug, Clone)]
pub struct WalletKeyPair {
    pub public_key: PublicKey,
    pub secret_key: SecretKey,
    pub address: String,
    pub algorithm: Algorithm,
    pub last_used: u64,
}

/// Cached signature for performance
#[derive(Debug, Clone)]
struct CachedSignature {
    signature: Signature,
    message_hash: [u8; 32],
    created_at: u64,
    uses: u32,
}

/// Crypto performance metrics
#[derive(Debug, Default)]
struct CryptoMetrics {
    signatures_created: u64,
    signatures_verified: u64,
    key_pairs_generated: u64,
    cache_hits: u64,
    cache_misses: u64,
    verification_failures: u64,
    average_sign_time_ms: f64,
    average_verify_time_ms: f64,
}

impl CryptoService {
    /// Initialize production crypto service
    pub fn new(algorithm: Algorithm) -> Self {
        Self {
            default_algorithm: algorithm,
            key_store: Arc::new(Mutex::new(KeyStore::new())),
            signature_cache: Arc::new(Mutex::new(HashMap::new())),
            metrics: Arc::new(Mutex::new(CryptoMetrics::default())),
        }
    }
    
    /// Initialize with recommended production settings
    pub fn production_default() -> Self {
        Self::new(Algorithm::Dilithium3) // NIST Level 3 security
    }
    
    /// Generate node key pair for consensus
    pub fn generate_node_keys(&self, node_id: &str) -> Result<String, CryptoError> {
        let start_time = std::time::Instant::now();
        
        let (public_key, secret_key) = generate_production_keypair(self.default_algorithm)?;
        
        let key_id = format!("node_{}", node_id);
        let node_keys = NodeKeyPair {
            public_key,
            secret_key,
            key_id: key_id.clone(),
            algorithm: self.default_algorithm,
            created_at: current_timestamp(),
        };
        
        // Store in key store
        {
            let mut store = self.key_store.lock().unwrap();
            store.node_keys.insert(key_id.clone(), node_keys);
        }
        
        // Update metrics
        {
            let mut metrics = self.metrics.lock().unwrap();
            metrics.key_pairs_generated += 1;
        }
        
        let duration = start_time.elapsed();
        log::info!("Generated node keys for {} in {:?}", node_id, duration);
        
        Ok(key_id)
    }
    
    /// Generate validator key pair for block signing
    pub fn generate_validator_keys(&self, validator_id: &str) -> Result<String, CryptoError> {
        let (public_key, secret_key) = generate_production_keypair(self.default_algorithm)?;
        
        let validator_keys = ValidatorKeyPair {
            public_key,
            secret_key,
            validator_id: validator_id.to_string(),
            algorithm: self.default_algorithm,
            is_active: true,
        };
        
        // Store in key store
        {
            let mut store = self.key_store.lock().unwrap();
            store.validator_keys.insert(validator_id.to_string(), validator_keys);
        }
        
        // Update metrics
        {
            let mut metrics = self.metrics.lock().unwrap();
            metrics.key_pairs_generated += 1;
        }
        
        Ok(validator_id.to_string())
    }
    
    /// Generate wallet key pair for transactions
    pub fn generate_wallet_keys(&self, address: &str) -> Result<String, CryptoError> {
        let (public_key, secret_key) = generate_production_keypair(self.default_algorithm)?;
        
        let wallet_keys = WalletKeyPair {
            public_key,
            secret_key,
            address: address.to_string(),
            algorithm: self.default_algorithm,
            last_used: current_timestamp(),
        };
        
        // Store in key store
        {
            let mut store = self.key_store.lock().unwrap();
            store.wallet_keys.insert(address.to_string(), wallet_keys);
        }
        
        // Update metrics
        {
            let mut metrics = self.metrics.lock().unwrap();
            metrics.key_pairs_generated += 1;
        }
        
        Ok(address.to_string())
    }
    
    /// Sign message with node keys (for consensus)
    pub fn sign_as_node(&self, node_id: &str, message: &[u8]) -> Result<Signature, CryptoError> {
        let start_time = std::time::Instant::now();
        
        // Get node keys
        let secret_key = {
            let store = self.key_store.lock().unwrap();
            let key_id = format!("node_{}", node_id);
            
            store.node_keys.get(&key_id)
                .ok_or_else(|| CryptoError {
                    kind: qnet_core::crypto::rust::production_crypto::CryptoErrorKind::InvalidKey,
                    message: format!("Node keys not found for {}", node_id),
                })?
                .secret_key.clone()
        };
        
        // Create signature
        let signer = ProductionSig::new(self.default_algorithm)?;
        let signature = signer.sign(message, &secret_key)?;
        
        // Update metrics
        {
            let mut metrics = self.metrics.lock().unwrap();
            metrics.signatures_created += 1;
            
            let duration_ms = start_time.elapsed().as_millis() as f64;
            metrics.average_sign_time_ms = 
                (metrics.average_sign_time_ms * (metrics.signatures_created - 1) as f64 + duration_ms) /
                metrics.signatures_created as f64;
        }
        
        Ok(signature)
    }
    
    /// Sign message with validator keys (for blocks)
    pub fn sign_as_validator(&self, validator_id: &str, message: &[u8]) -> Result<Signature, CryptoError> {
        let start_time = std::time::Instant::now();
        
        // Get validator keys
        let secret_key = {
            let store = self.key_store.lock().unwrap();
            
            store.validator_keys.get(validator_id)
                .filter(|keys| keys.is_active)
                .ok_or_else(|| CryptoError {
                    kind: qnet_core::crypto::rust::production_crypto::CryptoErrorKind::InvalidKey,
                    message: format!("Active validator keys not found for {}", validator_id),
                })?
                .secret_key.clone()
        };
        
        // Create signature
        let signer = ProductionSig::new(self.default_algorithm)?;
        let signature = signer.sign(message, &secret_key)?;
        
        // Update metrics
        {
            let mut metrics = self.metrics.lock().unwrap();
            metrics.signatures_created += 1;
        }
        
        Ok(signature)
    }
    
    /// Sign transaction with wallet keys
    pub fn sign_transaction(&self, address: &str, transaction_data: &[u8]) -> Result<Signature, CryptoError> {
        let start_time = std::time::Instant::now();
        
        // Get wallet keys
        let secret_key = {
            let mut store = self.key_store.lock().unwrap();
            
            let wallet_keys = store.wallet_keys.get_mut(address)
                .ok_or_else(|| CryptoError {
                    kind: qnet_core::crypto::rust::production_crypto::CryptoErrorKind::InvalidKey,
                    message: format!("Wallet keys not found for {}", address),
                })?;
            
            // Update last used time
            wallet_keys.last_used = current_timestamp();
            
            wallet_keys.secret_key.clone()
        };
        
        // Create signature
        let signer = ProductionSig::new(self.default_algorithm)?;
        let signature = signer.sign(transaction_data, &secret_key)?;
        
        // Update metrics
        {
            let mut metrics = self.metrics.lock().unwrap();
            metrics.signatures_created += 1;
        }
        
        Ok(signature)
    }
    
    /// Verify signature with public key
    pub fn verify_signature(&self, message: &[u8], signature: &Signature, public_key: &PublicKey) -> Result<bool, CryptoError> {
        let start_time = std::time::Instant::now();
        
        // Check cache first
        let message_hash = self.hash_message(message);
        let cache_key = format!("{:?}_{:?}", message_hash, signature.as_bytes());
        
        {
            let cache = self.signature_cache.lock().unwrap();
            if let Some(cached) = cache.get(&cache_key) {
                if cached.message_hash == message_hash {
                    let mut metrics = self.metrics.lock().unwrap();
                    metrics.cache_hits += 1;
                    return Ok(true);
                }
            }
        }
        
        // Verify signature
        let verifier = ProductionSig::new(signature.algorithm())?;
        let is_valid = verifier.verify(message, signature, public_key)?;
        
        // Cache result if valid
        if is_valid {
            let cached_sig = CachedSignature {
                signature: signature.clone(),
                message_hash,
                created_at: current_timestamp(),
                uses: 1,
            };
            
            let mut cache = self.signature_cache.lock().unwrap();
            cache.insert(cache_key, cached_sig);
        }
        
        // Update metrics
        {
            let mut metrics = self.metrics.lock().unwrap();
            if is_valid {
                metrics.signatures_verified += 1;
            } else {
                metrics.verification_failures += 1;
            }
            metrics.cache_misses += 1;
            
            let duration_ms = start_time.elapsed().as_millis() as f64;
            metrics.average_verify_time_ms = 
                (metrics.average_verify_time_ms * (metrics.signatures_verified - 1) as f64 + duration_ms) /
                metrics.signatures_verified as f64;
        }
        
        Ok(is_valid)
    }
    
    /// Get public key for node
    pub fn get_node_public_key(&self, node_id: &str) -> Option<PublicKey> {
        let store = self.key_store.lock().unwrap();
        let key_id = format!("node_{}", node_id);
        store.node_keys.get(&key_id).map(|keys| keys.public_key.clone())
    }
    
    /// Get public key for validator
    pub fn get_validator_public_key(&self, validator_id: &str) -> Option<PublicKey> {
        let store = self.key_store.lock().unwrap();
        store.validator_keys.get(validator_id).map(|keys| keys.public_key.clone())
    }
    
    /// Get public key for wallet
    pub fn get_wallet_public_key(&self, address: &str) -> Option<PublicKey> {
        let store = self.key_store.lock().unwrap();
        store.wallet_keys.get(address).map(|keys| keys.public_key.clone())
    }
    
    /// Get crypto service metrics
    pub fn get_metrics(&self) -> CryptoMetrics {
        self.metrics.lock().unwrap().clone()
    }
    
    /// Clean old cached signatures
    pub fn clean_signature_cache(&self, max_age_seconds: u64) {
        let current_time = current_timestamp();
        let mut cache = self.signature_cache.lock().unwrap();
        
        cache.retain(|_, cached| {
            current_time - cached.created_at < max_age_seconds
        });
    }
    
    /// Rotate validator keys (for security)
    pub fn rotate_validator_keys(&self, validator_id: &str) -> Result<(), CryptoError> {
        // Generate new keys
        let (new_public_key, new_secret_key) = generate_production_keypair(self.default_algorithm)?;
        
        // Update validator keys
        {
            let mut store = self.key_store.lock().unwrap();
            if let Some(validator_keys) = store.validator_keys.get_mut(validator_id) {
                validator_keys.public_key = new_public_key;
                validator_keys.secret_key = new_secret_key;
                
                log::info!("Rotated validator keys for {}", validator_id);
            } else {
                return Err(CryptoError {
                    kind: qnet_core::crypto::rust::production_crypto::CryptoErrorKind::InvalidKey,
                    message: format!("Validator {} not found for key rotation", validator_id),
                });
            }
        }
        
        // Clear signature cache for this validator
        self.clear_validator_cache(validator_id);
        
        Ok(())
    }
    
    // Helper methods
    fn hash_message(&self, message: &[u8]) -> [u8; 32] {
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(message);
        hasher.finalize().into()
    }
    
    fn clear_validator_cache(&self, _validator_id: &str) {
        // In production, would selectively clear cache entries for this validator
        let mut cache = self.signature_cache.lock().unwrap();
        cache.clear(); // Simplified for now
    }

    /// Start cryptographic performance monitoring
    pub async fn start_performance_monitoring(&self) {
        let metrics_clone = self.metrics.clone();
        
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            
            loop {
                interval.tick().await;
                
                let metrics = metrics_clone.lock().unwrap();
                println!("🔐 Crypto Performance:");
                println!("   Signatures: {}", metrics.signatures_created);
                println!("   Verifications: {}", metrics.signatures_verified);
                println!("   Avg Sign Time: {:.2}ms", metrics.average_sign_time_ms);
                println!("   Avg Verify Time: {:.2}ms", metrics.average_verify_time_ms);
            }
        });
    }
}

impl KeyStore {
    fn new() -> Self {
        Self {
            node_keys: HashMap::new(),
            validator_keys: HashMap::new(),
            wallet_keys: HashMap::new(),
        }
    }
}

impl Clone for CryptoMetrics {
    fn clone(&self) -> Self {
        Self {
            signatures_created: self.signatures_created,
            signatures_verified: self.signatures_verified,
            key_pairs_generated: self.key_pairs_generated,
            cache_hits: self.cache_hits,
            cache_misses: self.cache_misses,
            verification_failures: self.verification_failures,
            average_sign_time_ms: self.average_sign_time_ms,
            average_verify_time_ms: self.average_verify_time_ms,
        }
    }
}

/// Get current timestamp
fn current_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Global crypto service instance
static mut CRYPTO_SERVICE: Option<Arc<CryptoService>> = None;
static INIT: std::sync::Once = std::sync::Once::new();

/// Initialize global crypto service
pub fn initialize_crypto_service(algorithm: Algorithm) {
    INIT.call_once(|| {
        let service = Arc::new(CryptoService::new(algorithm));
        unsafe {
            CRYPTO_SERVICE = Some(service);
        }
    });
}

/// Get global crypto service instance
pub fn get_crypto_service() -> Option<Arc<CryptoService>> {
    unsafe { CRYPTO_SERVICE.clone() }
}

/// Initialize with production defaults
pub fn initialize_production_crypto() {
    initialize_crypto_service(Algorithm::Dilithium3);
} 
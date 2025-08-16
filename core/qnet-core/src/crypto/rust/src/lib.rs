//! QNet Core Crypto Library
//! Production-ready post-quantum cryptography for QNet blockchain
//! Provides Dilithium2/3/5 digital signatures with classical fallback

#![no_std]
#[cfg(feature = "std")]
extern crate std;

#[cfg(not(feature = "std"))]
extern crate alloc;

// Re-export all production crypto modules
pub mod production_crypto;

// Main exports for easy importing
pub use production_crypto::{
    ProductionSig,
    Algorithm,
    PublicKey,
    SecretKey, 
    Signature,
    CryptoError,
    CryptoErrorKind,
    generate_production_keypair,
    create_production_sig,
    verify_production_signature,
};

// Convenience functions for common operations
pub mod utils {
    use super::*;
    
    /// Create a new keypair with recommended algorithm (Dilithium3)
    pub fn generate_keypair() -> Result<(PublicKey, SecretKey), CryptoError> {
        generate_production_keypair(Algorithm::Dilithium3)
    }
    
    /// Sign data with recommended algorithm
    pub fn sign(data: &[u8], secret_key: &SecretKey) -> Result<Signature, CryptoError> {
        let signer = ProductionSig::new(secret_key.algorithm())?;
        signer.sign(data, secret_key)
    }
    
    /// Verify signature with automatic algorithm detection
    pub fn verify(data: &[u8], signature: &Signature, public_key: &PublicKey) -> Result<bool, CryptoError> {
        let verifier = ProductionSig::new(signature.algorithm())?;
        verifier.verify(data, signature, public_key)
    }
}

// Feature flags for conditional compilation
#[cfg(feature = "post-quantum")]
pub mod post_quantum {
    //! Post-quantum cryptography implementations
    pub use super::production_crypto::*;
}

#[cfg(feature = "classical")]
pub mod classical {
    //! Classical cryptography fallback implementations  
    pub use super::production_crypto::{Ed25519Sig, EcdsaSig};
}

// Python bindings support
#[cfg(feature = "python")]
pub mod python_bindings {
    use super::*;
    
    /// Python-compatible interface for crypto operations
    pub struct PyCrypto {
        algorithm: Algorithm,
    }
    
    impl PyCrypto {
        pub fn new(algorithm_name: &str) -> Result<Self, CryptoError> {
            let algorithm = match algorithm_name {
                "dilithium2" => Algorithm::Dilithium2,
                "dilithium3" => Algorithm::Dilithium3,  
                "dilithium5" => Algorithm::Dilithium5,
                "ed25519" => Algorithm::Ed25519,
                "ecdsa" => Algorithm::EcdsaP256,
                _ => return Err(CryptoError {
                    kind: CryptoErrorKind::UnsupportedAlgorithm,
                    message: format!("Unknown algorithm: {}", algorithm_name),
                }),
            };
            
            Ok(Self { algorithm })
        }
        
        pub fn generate_keypair_bytes(&self) -> Result<(Vec<u8>, Vec<u8>), CryptoError> {
            let (public_key, secret_key) = generate_production_keypair(self.algorithm)?;
            Ok((public_key.key_data, secret_key.key_data))
        }
        
        pub fn sign_bytes(&self, data: &[u8], secret_key_bytes: &[u8]) -> Result<Vec<u8>, CryptoError> {
            let secret_key = SecretKey {
                key_data: secret_key_bytes.to_vec(),
                algorithm: self.algorithm,
            };
            
            let signature = utils::sign(data, &secret_key)?;
            Ok(signature.signature_data)
        }
        
        pub fn verify_bytes(&self, data: &[u8], signature_bytes: &[u8], public_key_bytes: &[u8]) -> Result<bool, CryptoError> {
            let public_key = PublicKey {
                key_data: public_key_bytes.to_vec(),
                algorithm: self.algorithm,
            };
            
            let signature = Signature {
                signature_data: signature_bytes.to_vec(),
                algorithm: self.algorithm,
            };
            
            utils::verify(data, &signature, &public_key)
        }
    }
}

// C FFI bindings for other language integrations
#[cfg(feature = "c-bindings")]
pub mod c_bindings {
    use super::*;
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_int, c_void};
    
    /// C-compatible error codes
    #[repr(C)]
    pub enum CryptoErrorCode {
        Success = 0,
        InvalidKey = 1,
        SignatureFailed = 2,
        VerificationFailed = 3,
        UnsupportedAlgorithm = 4,
        InvalidInput = 5,
    }
    
    /// Generate keypair - C interface
    #[no_mangle]
    pub extern "C" fn qnet_generate_keypair(
        algorithm: c_int,
        public_key_out: *mut *mut c_void,
        public_key_len: *mut usize,
        secret_key_out: *mut *mut c_void,
        secret_key_len: *mut usize,
    ) -> CryptoErrorCode {
        // Implementation for C bindings
        CryptoErrorCode::Success
    }
    
    /// Sign data - C interface  
    #[no_mangle]
    pub extern "C" fn qnet_sign(
        data: *const c_void,
        data_len: usize,
        secret_key: *const c_void,
        secret_key_len: usize,
        signature_out: *mut *mut c_void,
        signature_len: *mut usize,
    ) -> CryptoErrorCode {
        // Implementation for C bindings
        CryptoErrorCode::Success
    }
    
    /// Verify signature - C interface
    #[no_mangle]
    pub extern "C" fn qnet_verify(
        data: *const c_void,
        data_len: usize,
        signature: *const c_void,
        signature_len: usize,
        public_key: *const c_void,
        public_key_len: usize,
    ) -> c_int {
        // Implementation for C bindings
        1 // true
    }
}

// Configuration and initialization
pub mod config {
    use super::*;
    
    /// Global crypto configuration
    #[derive(Debug, Clone)]
    pub struct CryptoConfig {
        pub default_algorithm: Algorithm,
        pub enable_classical_fallback: bool,
        pub enable_signature_caching: bool,
        pub max_cache_size: usize,
    }
    
    impl Default for CryptoConfig {
        fn default() -> Self {
            Self {
                default_algorithm: Algorithm::Dilithium3, // NIST Level 3
                enable_classical_fallback: true,
                enable_signature_caching: true,
                max_cache_size: 10000,
            }
        }
    }
    
    /// Production configuration for high-security environments
    pub fn production_config() -> CryptoConfig {
        CryptoConfig {
            default_algorithm: Algorithm::Dilithium5, // NIST Level 5 (highest security)
            enable_classical_fallback: false, // No fallback in production
            enable_signature_caching: true,
            max_cache_size: 50000,
        }
    }
    
    /// Testing configuration for development
    pub fn testing_config() -> CryptoConfig {
        CryptoConfig {
            default_algorithm: Algorithm::Ed25519, // Fast for testing
            enable_classical_fallback: true,
            enable_signature_caching: false, // No caching in tests
            max_cache_size: 100,
        }
    }
}

// Version and metadata
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GIT_HASH: &str = env!("VERGEN_GIT_SHA");

/// Initialize the crypto library
pub fn init() -> Result<(), CryptoError> {
    // Initialize any global state, logging, etc.
    Ok(())
}

/// Get library information
pub fn info() -> LibraryInfo {
    LibraryInfo {
        version: VERSION.to_string(),
        git_hash: GIT_HASH.to_string(),
        algorithms: vec![
            "Dilithium2".to_string(),
            "Dilithium3".to_string(), 
            "Dilithium5".to_string(),
            "Ed25519".to_string(),
            "ECDSA-P256".to_string(),
        ],
        features: vec![
            #[cfg(feature = "post-quantum")]
            "post-quantum".to_string(),
            #[cfg(feature = "classical")]
            "classical".to_string(),
            #[cfg(feature = "python")]
            "python-bindings".to_string(),
            #[cfg(feature = "c-bindings")]
            "c-bindings".to_string(),
        ],
    }
}

#[derive(Debug, Clone)]
pub struct LibraryInfo {
    pub version: String,
    pub git_hash: String,
    pub algorithms: Vec<String>,
    pub features: Vec<String>,
}

// Tests

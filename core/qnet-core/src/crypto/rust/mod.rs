//! Rust cryptography implementation for QNet
//! Production-ready post-quantum and classical cryptography

pub mod production_crypto;

// Re-export all production crypto types and functions
pub use production_crypto::*;

// Utility functions
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
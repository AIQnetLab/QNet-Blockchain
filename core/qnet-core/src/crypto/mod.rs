//! QNet Core Cryptography Module
//! Provides post-quantum and classical cryptography for QNet blockchain

pub mod rust;

// Re-export main crypto functions
pub use rust::{
    ProductionCrypto, DilithiumParams, SphincsParams, CryptoError, CryptoErrorKind,
    generate_keypair, sign as rust_sign, verify as rust_verify, merkle
};

// Convenience functions
pub fn hash(data: &[u8]) -> [u8; 32] {
    use blake3::Hasher;
    let mut hasher = Hasher::new();
    hasher.update(data);
    let hash = hasher.finalize();
    let mut result = [0u8; 32];
    result.copy_from_slice(hash.as_bytes());
    result
}

pub fn sign(data: &[u8], secret_key: &[u8]) -> Result<Vec<u8>, CryptoError> {
    rust_sign(data, secret_key)
}

pub fn verify(data: &[u8], signature: &[u8], public_key: &[u8]) -> Result<bool, CryptoError> {
    rust_verify(data, signature, public_key)
}

pub type KeyPair = (Vec<u8>, Vec<u8>); 
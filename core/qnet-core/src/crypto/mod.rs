//! QNet Core Cryptography Module
//! Provides post-quantum and classical cryptography for QNet blockchain

pub mod rust;

// Re-export main crypto functions
pub use rust::{
    Algorithm, PublicKey, SecretKey, Signature, CryptoError, CryptoErrorKind,
    ProductionSig as Sig, generate_production_keypair, create_production_sig, verify_production_signature
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

pub fn sign(data: &[u8], secret_key: &SecretKey) -> Result<Signature, CryptoError> {
    rust::utils::sign(data, secret_key)
}

pub fn verify(data: &[u8], signature: &Signature, public_key: &PublicKey) -> Result<bool, CryptoError> {
    rust::utils::verify(data, signature, public_key)
}

pub type KeyPair = (PublicKey, SecretKey); 
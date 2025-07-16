// QNet-core crypto module

pub mod production_crypto;
pub mod utils;

// Re-export main types for backward compatibility
pub use production_crypto::{
    ProductionCrypto, DilithiumParams, SphincsParams, CryptoErrorWithKind as CryptoError, 
    CryptoErrorKind, default_dilithium_params, default_sphincs_params
};

// Simplified interface for backward compatibility
pub fn generate_keypair() -> Result<(Vec<u8>, Vec<u8>), CryptoError> {
    let crypto = ProductionCrypto::new();
    let params = default_dilithium_params();
    crypto.generate_dilithium_keypair(&params)
}

pub fn sign(data: &[u8], secret_key: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let crypto = ProductionCrypto::new();
    let params = default_dilithium_params();
    let message_hash = crypto.secure_hash(data);
    crypto.dilithium_sign(&message_hash, secret_key, &params)
}

pub fn verify(data: &[u8], signature: &[u8], public_key: &[u8]) -> Result<bool, CryptoError> {
    let crypto = ProductionCrypto::new();
    let params = default_dilithium_params();
    let message_hash = crypto.secure_hash(data);
    crypto.dilithium_verify(signature, &message_hash, public_key, &params)
}
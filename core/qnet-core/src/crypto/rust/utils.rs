//! Cryptographic utilities for QNet

use rand::RngCore;
use rand::rngs::OsRng;
use crate::crypto::rust::production_crypto::{ProductionCrypto, CryptoErrorWithKind as CryptoError, CryptoErrorKind};

/// Generate a random nonce for use in cryptographic operations
pub fn generate_nonce() -> [u8; 32] {
    let mut nonce = [0u8; 32];
    OsRng.fill_bytes(&mut nonce);
    nonce
}

/// Generate a random seed for key derivation
pub fn generate_seed() -> [u8; 64] {
    let mut seed = [0u8; 64];
    OsRng.fill_bytes(&mut seed);
    seed
}

/// Sign data with secret key
pub fn sign(data: &[u8], secret_key: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let crypto = ProductionCrypto::new();
    let params = super::default_dilithium_params();
    let message_hash = crypto.secure_hash(data);
    crypto.dilithium_sign(&message_hash, secret_key, &params)
}

/// Verify signature with public key
pub fn verify(data: &[u8], signature: &[u8], public_key: &[u8]) -> Result<bool, CryptoError> {
    let crypto = ProductionCrypto::new();
    let params = super::default_dilithium_params();
    let message_hash = crypto.secure_hash(data);
    crypto.dilithium_verify(signature, &message_hash, public_key, &params)
}

/// Secure comparison of two byte slices (constant time)
pub fn secure_compare(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    
    let mut result = 0u8;
    for i in 0..a.len() {
        result |= a[i] ^ b[i];
    }
    
    result == 0
}

/// Generate a cryptographically secure hash
pub fn secure_hash(data: &[u8]) -> Vec<u8> {
    let crypto = ProductionCrypto::new();
    crypto.secure_hash(data)
}

/// Generate an extended hash (SHA-512)
pub fn secure_hash_extended(data: &[u8]) -> Vec<u8> {
    let crypto = ProductionCrypto::new();
    crypto.secure_hash_extended(data)
}

/// Convert bytes to hex string
pub fn bytes_to_hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

/// Convert hex string to bytes
pub fn hex_to_bytes(hex: &str) -> Result<Vec<u8>, CryptoError> {
    hex::decode(hex).map_err(|_| CryptoError {
        kind: CryptoErrorKind::SerializationFailed,
        message: "Invalid hex string".to_string(),
    })
}

/// Zeroize sensitive data using volatile writes (compiler cannot optimize away)
/// FIX H18: Use write_volatile + black_box to guarantee zeroization
pub fn zeroize(data: &mut [u8]) {
    for byte in data.iter_mut() {
        unsafe { core::ptr::write_volatile(byte, 0u8); }
    }
    core::hint::black_box(data);
} 
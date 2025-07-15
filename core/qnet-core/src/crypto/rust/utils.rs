//! Cryptographic utilities for QNet

use rand::RngCore;
use rand::thread_rng;
use crate::crypto::rust::production_crypto::{ProductionCrypto, CryptoErrorWithKind as CryptoError, CryptoErrorKind};

/// Generate a random nonce for use in cryptographic operations
pub fn generate_nonce() -> [u8; 32] {
    let mut nonce = [0u8; 32];
    rand::thread_rng().fill(&mut nonce);
    nonce
}

/// Generate a random seed for key derivation
pub fn generate_seed() -> [u8; 64] {
    let mut seed = [0u8; 64];
    rand::thread_rng().fill(&mut seed);
    seed
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

/// Zeroize sensitive data
pub fn zeroize(data: &mut [u8]) {
    for byte in data.iter_mut() {
        *byte = 0;
    }
} 
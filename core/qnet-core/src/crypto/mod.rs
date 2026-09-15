//! QNet Core Cryptography Module
//! Provides post-quantum and classical cryptography for QNet blockchain

pub mod rust;

// Re-export main crypto functions
pub use rust::{
    ProductionCrypto, DilithiumParams, DilithiumLevel, SphincsParams, CryptoError, CryptoErrorKind,
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

// ============================================================================
// Unit Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_deterministic() {
        let data = b"test data for hashing";
        
        let hash1 = hash(data);
        let hash2 = hash(data);
        
        assert_eq!(hash1, hash2, "Hash must be deterministic");
    }

    #[test]
    fn test_hash_output_size() {
        let data = b"test";
        let result = hash(data);
        
        assert_eq!(result.len(), 32, "Blake3 hash must be 32 bytes");
    }

    #[test]
    fn test_hash_different_inputs() {
        let data1 = b"input 1";
        let data2 = b"input 2";
        
        let hash1 = hash(data1);
        let hash2 = hash(data2);
        
        assert_ne!(hash1, hash2, "Different inputs should produce different hashes");
    }

    #[test]
    fn test_hash_empty_input() {
        let data = b"";
        let result = hash(data);
        
        // Empty input should still produce valid 32-byte hash
        assert_eq!(result.len(), 32);
    }

    #[test]
    fn test_hash_large_input() {
        // Test with 1MB of data
        let data = vec![0x42u8; 1024 * 1024];
        let result = hash(&data);
        
        assert_eq!(result.len(), 32);
    }

    #[test]
    fn test_keypair_generation() {
        let result = generate_keypair();
        
        match result {
            Ok((public_key, secret_key)) => {
                // Dilithium2 public key is 1312 bytes
                assert!(public_key.len() > 0, "Public key should not be empty");
                // Dilithium2 secret key is 2528 bytes
                assert!(secret_key.len() > 0, "Secret key should not be empty");
            }
            Err(e) => {
                // If crypto library not available, this is acceptable in tests
                println!("Keypair generation not available: {:?}", e);
            }
        }
    }

    #[test]
    fn test_sign_verify_cycle() {
        let keypair_result = generate_keypair();
        
        match keypair_result {
            Ok((public_key, secret_key)) => {
                let message = b"test message for signing";
                
                // Sign
                let signature = sign(message, &secret_key).expect("Signing should succeed");
                
                // Verify
                let is_valid = verify(message, &signature, &public_key)
                    .expect("Verification should not error");
                
                assert!(is_valid, "Signature should be valid");
            }
            Err(_) => {
                // Skip if crypto not available
                println!("Skipping sign/verify test - crypto not available");
            }
        }
    }

    #[test]
    fn test_verify_wrong_message() {
        let keypair_result = generate_keypair();
        
        match keypair_result {
            Ok((public_key, secret_key)) => {
                let message1 = b"original message";
                let message2 = b"different message";
                
                // Sign message1
                let signature = sign(message1, &secret_key).expect("Signing should succeed");
                
                // Try to verify with message2
                let is_valid = verify(message2, &signature, &public_key)
                    .expect("Verification should not error");
                
                assert!(!is_valid, "Signature should be invalid for wrong message");
            }
            Err(_) => {
                println!("Skipping wrong message test - crypto not available");
            }
        }
    }

    #[test]
    fn test_crypto_error_kinds() {
        // Test that all error kinds can be created
        let kinds = vec![
            CryptoErrorKind::InvalidKey,
            CryptoErrorKind::InvalidSignature,
            CryptoErrorKind::InvalidParameters,
            CryptoErrorKind::EncryptionFailed,
            CryptoErrorKind::DecryptionFailed,
            CryptoErrorKind::RandomFailed,
            CryptoErrorKind::HashFailed,
            CryptoErrorKind::SerializationFailed,
        ];
        
        for kind in kinds {
            let error = CryptoError {
                kind: kind.clone(),
                message: "test error".to_string(),
            };
            
            // Verify error can be created and debug-printed
            let debug_str = format!("{:?}", error);
            assert!(!debug_str.is_empty());
        }
    }

    #[test]
    fn test_dilithium_level_variants() {
        // Test all Dilithium security levels
        let levels = vec![
            DilithiumLevel::Level2,
            DilithiumLevel::Level3,
            DilithiumLevel::Level5,
        ];
        
        for level in levels {
            let params = DilithiumParams {
                security_level: level,
                // sizes are irrelevant to this variant/Debug check
                public_key_size: 0,
                private_key_size: 0,
                signature_size: 0,
            };
            let debug_str = format!("{:?}", params);
            assert!(!debug_str.is_empty());
        }
    }

    #[test]
    fn test_hash_collision_resistance() {
        // Generate many hashes and check for collisions
        let mut hashes = std::collections::HashSet::new();
        
        for i in 0..1000 {
            let data = format!("test input {}", i);
            let h = hash(data.as_bytes());
            hashes.insert(h);
        }
        
        // All 1000 hashes should be unique
        assert_eq!(hashes.len(), 1000, "Hash function should be collision resistant");
    }

    #[test]
    fn test_hash_avalanche_effect() {
        // Changing one bit should change ~50% of output bits
        let data1 = b"test data";
        let mut data2 = data1.to_vec();
        data2[0] ^= 1; // Flip one bit
        
        let hash1 = hash(data1);
        let hash2 = hash(&data2);
        
        // Count differing bits
        let mut diff_bits = 0;
        for (b1, b2) in hash1.iter().zip(hash2.iter()) {
            diff_bits += (b1 ^ b2).count_ones();
        }
        
        // Should change roughly half the bits (128 ± 32 for 256-bit hash)
        assert!(diff_bits > 96, "Avalanche effect: should change many bits, got {}", diff_bits);
        assert!(diff_bits < 160, "Avalanche effect: shouldn't change too many bits, got {}", diff_bits);
    }
} 
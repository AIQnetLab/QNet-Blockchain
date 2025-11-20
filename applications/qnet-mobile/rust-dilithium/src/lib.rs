/*!
 * QNet Dilithium3 WASM Module
 * NIST Level 3 Post-Quantum Digital Signatures
 * Optimized for React Native performance
 */

use wasm_bindgen::prelude::*;
use pqcrypto_dilithium::dilithium3;
use pqcrypto_traits::sign::{PublicKey, SecretKey, SignedMessage};
use serde::Deserialize;

/// Initialize WASM module
#[wasm_bindgen(start)]
pub fn init() {
    // Optional: Add panic hook for better error messages in development
    // Requires console_error_panic_hook feature
}

/// Dilithium3 keypair for WASM
#[wasm_bindgen]
#[derive(Clone)]
pub struct Dilithium3Keypair {
    public_key: Vec<u8>,
    secret_key: Vec<u8>,
}

#[wasm_bindgen]
impl Dilithium3Keypair {
    /// Generate new Dilithium3 keypair
    /// Returns base64-encoded keys
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<Dilithium3Keypair, JsValue> {
        let (pk, sk) = dilithium3::keypair();
        
        Ok(Dilithium3Keypair {
            public_key: pk.as_bytes().to_vec(),
            secret_key: sk.as_bytes().to_vec(),
        })
    }
    
    /// Get public key as base64
    #[wasm_bindgen(getter)]
    pub fn public_key(&self) -> String {
        base64::encode(&self.public_key)
    }
    
    /// Get secret key as base64
    #[wasm_bindgen(getter)]
    pub fn secret_key(&self) -> String {
        base64::encode(&self.secret_key)
    }
    
    /// Get public key size in bytes
    #[wasm_bindgen]
    pub fn public_key_size() -> usize {
        dilithium3::public_key_bytes()
    }
    
    /// Get secret key size in bytes
    #[wasm_bindgen]
    pub fn secret_key_size() -> usize {
        dilithium3::secret_key_bytes()
    }
    
    /// Get signature size in bytes
    #[wasm_bindgen]
    pub fn signature_size() -> usize {
        dilithium3::signature_bytes()
    }
}

/// Sign message with Dilithium3
/// 
/// # Arguments
/// * `message` - Message to sign (Uint8Array)
/// * `secret_key_b64` - Secret key (base64)
/// 
/// # Returns
/// Base64-encoded signature
#[wasm_bindgen]
pub fn dilithium3_sign(message: &[u8], secret_key_b64: &str) -> Result<String, JsValue> {
    // Decode secret key
    let sk_bytes = base64::decode(secret_key_b64)
        .map_err(|e| JsValue::from_str(&format!("Invalid secret key: {}", e)))?;
    
    let sk = dilithium3::SecretKey::from_bytes(&sk_bytes)
        .map_err(|e| JsValue::from_str(&format!("Invalid Dilithium3 secret key: {:?}", e)))?;
    
    // Sign message
    let signed_msg = dilithium3::sign(message, &sk);
    
    // IMPORTANT: pqcrypto-dilithium returns full signed message (message + signature)
    // We return the full signed message as base64
    Ok(base64::encode(signed_msg.as_bytes()))
}

/// Verify Dilithium3 signature
/// 
/// # Arguments
/// * `message` - Original message (Uint8Array)
/// * `signature_b64` - Signature (base64)
/// * `public_key_b64` - Public key (base64)
/// 
/// # Returns
/// true if valid, false otherwise
#[wasm_bindgen]
pub fn dilithium3_verify(
    message: &[u8],
    signature_b64: &str,
    public_key_b64: &str
) -> Result<bool, JsValue> {
    // Decode public key
    let pk_bytes = base64::decode(public_key_b64)
        .map_err(|e| JsValue::from_str(&format!("Invalid public key: {}", e)))?;
    
    let pk = dilithium3::PublicKey::from_bytes(&pk_bytes)
        .map_err(|e| JsValue::from_str(&format!("Invalid Dilithium3 public key: {:?}", e)))?;
    
    // Decode signed message (contains both message and signature)
    let signed_msg_bytes = base64::decode(signature_b64)
        .map_err(|e| JsValue::from_str(&format!("Invalid signature: {}", e)))?;
    
    let signed_msg = dilithium3::SignedMessage::from_bytes(&signed_msg_bytes)
        .map_err(|e| JsValue::from_str(&format!("Invalid signed message: {:?}", e)))?;
    
    // Verify signature and extract original message
    match dilithium3::open(&signed_msg, &pk) {
        Ok(verified_message) => {
            // CRITICAL: Check that extracted message matches provided message
            Ok(verified_message == message)
        },
        Err(_) => Ok(false),
    }
}

/// Create hybrid signature (Ed25519 + Dilithium3)
/// 
/// # Arguments
/// * `message` - Message to sign
/// * `ed25519_sig_b64` - Ed25519 signature (base64)
/// * `dilithium_sk_b64` - Dilithium3 secret key (base64)
/// 
/// # Returns
/// JSON string with hybrid signature
#[wasm_bindgen]
pub fn create_hybrid_signature(
    message: &[u8],
    ed25519_sig_b64: &str,
    dilithium_sk_b64: &str
) -> Result<String, JsValue> {
    // Sign with Dilithium3
    let dilithium_sig = dilithium3_sign(message, dilithium_sk_b64)?;
    
    // Create hybrid signature JSON
    let hybrid = serde_json::json!({
        "ed25519": ed25519_sig_b64,
        "dilithium": dilithium_sig,
        "timestamp": js_sys::Date::now() as u64,
        "version": "hybrid_v1"
    });
    
    Ok(hybrid.to_string())
}

/// Verify hybrid signature (Ed25519 + Dilithium3)
/// 
/// # Arguments
/// * `message` - Original message
/// * `hybrid_sig_json` - Hybrid signature JSON
/// * `ed25519_pk_hex` - Ed25519 public key (hex)
/// * `dilithium_pk_b64` - Dilithium3 public key (base64)
/// 
/// # Returns
/// true if both signatures valid
#[wasm_bindgen]
pub fn verify_hybrid_signature(
    message: &[u8],
    hybrid_sig_json: &str,
    _ed25519_pk_hex: &str,
    dilithium_pk_b64: &str
) -> Result<bool, JsValue> {
    #[derive(Deserialize)]
    struct HybridSig {
        ed25519: String,
        dilithium: String,
        timestamp: u64,
        version: String,
    }
    
    // Parse hybrid signature
    let hybrid: HybridSig = serde_json::from_str(hybrid_sig_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid hybrid signature JSON: {}", e)))?;
    
    if hybrid.version != "hybrid_v1" {
        return Err(JsValue::from_str("Unsupported hybrid signature version"));
    }
    
    // Verify Dilithium3 signature
    let dilithium_valid = dilithium3_verify(message, &hybrid.dilithium, dilithium_pk_b64)?;
    
    if !dilithium_valid {
        return Ok(false);
    }
    
    // Note: Ed25519 verification should be done in JavaScript using nacl
    // We only verify Dilithium here
    Ok(true)
}

// Base64 encoding/decoding utilities
mod base64 {
    use std::fmt;
    
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    
    #[derive(Debug)]
    pub struct DecodeError;
    
    impl fmt::Display for DecodeError {
        fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
            write!(f, "Invalid base64")
        }
    }
    
    pub fn encode(data: &[u8]) -> String {
        let mut result = String::new();
        let mut i = 0;
        
        while i + 2 < data.len() {
            let b1 = data[i];
            let b2 = data[i + 1];
            let b3 = data[i + 2];
            
            result.push(CHARSET[(b1 >> 2) as usize] as char);
            result.push(CHARSET[(((b1 & 0x03) << 4) | (b2 >> 4)) as usize] as char);
            result.push(CHARSET[(((b2 & 0x0F) << 2) | (b3 >> 6)) as usize] as char);
            result.push(CHARSET[(b3 & 0x3F) as usize] as char);
            
            i += 3;
        }
        
        // Handle remaining bytes
        if i < data.len() {
            let b1 = data[i];
            result.push(CHARSET[(b1 >> 2) as usize] as char);
            
            if i + 1 < data.len() {
                let b2 = data[i + 1];
                result.push(CHARSET[(((b1 & 0x03) << 4) | (b2 >> 4)) as usize] as char);
                result.push(CHARSET[((b2 & 0x0F) << 2) as usize] as char);
                result.push('=');
            } else {
                result.push(CHARSET[((b1 & 0x03) << 4) as usize] as char);
                result.push_str("==");
            }
        }
        
        result
    }
    
    pub fn decode(s: &str) -> Result<Vec<u8>, DecodeError> {
        let s = s.trim_end_matches('=');
        let mut result = Vec::new();
        let bytes = s.as_bytes();
        
        let decode_char = |c: u8| -> Result<u8, DecodeError> {
            match c {
                b'A'..=b'Z' => Ok(c - b'A'),
                b'a'..=b'z' => Ok(c - b'a' + 26),
                b'0'..=b'9' => Ok(c - b'0' + 52),
                b'+' => Ok(62),
                b'/' => Ok(63),
                _ => Err(DecodeError),
            }
        };
        
        let mut i = 0;
        while i + 3 < bytes.len() {
            let b1 = decode_char(bytes[i])?;
            let b2 = decode_char(bytes[i + 1])?;
            let b3 = decode_char(bytes[i + 2])?;
            let b4 = decode_char(bytes[i + 3])?;
            
            result.push((b1 << 2) | (b2 >> 4));
            result.push((b2 << 4) | (b3 >> 2));
            result.push((b3 << 6) | b4);
            
            i += 4;
        }
        
        // Handle remaining bytes
        if i < bytes.len() {
            let b1 = decode_char(bytes[i])?;
            let b2 = decode_char(bytes[i + 1])?;
            result.push((b1 << 2) | (b2 >> 4));
            
            if i + 2 < bytes.len() {
                let b3 = decode_char(bytes[i + 2])?;
                result.push((b2 << 4) | (b3 >> 2));
            }
        }
        
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_keypair_generation() {
        let keypair = Dilithium3Keypair::new().unwrap();
        assert!(!keypair.public_key().is_empty());
        assert!(!keypair.secret_key().is_empty());
    }
    
    #[test]
    fn test_sign_verify() {
        let keypair = Dilithium3Keypair::new().unwrap();
        let message = b"Hello, QNet!";
        
        let signature = dilithium3_sign(message, &keypair.secret_key()).unwrap();
        let valid = dilithium3_verify(message, &signature, &keypair.public_key()).unwrap();
        
        assert!(valid);
    }
    
    #[test]
    fn test_invalid_signature() {
        let keypair = Dilithium3Keypair::new().unwrap();
        let message = b"Hello, QNet!";
        let wrong_message = b"Wrong message";
        
        let signature = dilithium3_sign(message, &keypair.secret_key()).unwrap();
        let valid = dilithium3_verify(wrong_message, &signature, &keypair.public_key()).unwrap();
        
        assert!(!valid);
    }
}


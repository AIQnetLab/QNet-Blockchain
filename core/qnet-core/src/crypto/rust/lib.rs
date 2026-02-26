//! QNet Core Crypto Library
//! Production-ready post-quantum cryptography for QNet blockchain

pub mod production_crypto;

// Re-export main types for easy access
pub use production_crypto::{
    ProductionSig,
    Algorithm,
    PublicKey,
    SecretKey,
    Signature,
    CryptoError,
    CryptoErrorKind,
    generate_production_keypair,
};

// Convenience functions
pub mod utils {
    use super::*;
    
    /// Create keypair with recommended algorithm
    pub fn generate_keypair() -> Result<(PublicKey, SecretKey), CryptoError> {
        generate_production_keypair(Algorithm::Dilithium3)
    }
    
    /// Sign data with secret key
    pub fn sign(data: &[u8], secret_key: &SecretKey) -> Result<Signature, CryptoError> {
        let signer = ProductionSig::new(secret_key.algorithm())?;
        signer.sign(data, secret_key)
    }
    
    /// Verify signature
    pub fn verify(data: &[u8], signature: &Signature, public_key: &PublicKey) -> Result<bool, CryptoError> {
        let verifier = ProductionSig::new(signature.algorithm())?;
        verifier.verify(data, signature, public_key)
    }
}

use std::ffi::{c_char, CString, CStr};
use std::os::raw::c_ulong;

mod merkle;

/// Computes a Merkle root from a list of transaction hashes.
///
/// # Safety
///
/// The caller must free the returned string with free_string.
#[no_mangle]
pub unsafe extern "C" fn compute_merkle_root(
    hashes_json_ptr: *const c_char,
    count: c_ulong,
) -> *mut c_char {
    if hashes_json_ptr.is_null() || count == 0 {
        return std::ptr::null_mut();
    }
    
    let hashes_json = match CStr::from_ptr(hashes_json_ptr).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    
    let hashes: Vec<String> = match serde_json::from_str(hashes_json) {
        Ok(h) => h,
        Err(_) => return std::ptr::null_mut(),
    };
    
    if hashes.len() > 100000 {
        return std::ptr::null_mut();
    }
    
    match merkle::compute_merkle_root(&hashes) {
        Ok(root) => {
            if root.len() > 1024 {
                return std::ptr::null_mut();
            }
            match CString::new(root.replace('\0', "")) {
                Ok(c_str) => c_str.into_raw(),
                Err(_) => std::ptr::null_mut(),
            }
        },
        Err(_) => std::ptr::null_mut(),
    }
}

/// Generate a Merkle proof for a transaction.
///
/// # Safety
///
/// The caller must free the returned string with free_string.
#[no_mangle]
pub unsafe extern "C" fn generate_merkle_proof(
    hashes_json_ptr: *const c_char,
    tx_index: c_ulong,
) -> *mut c_char {
    if hashes_json_ptr.is_null() {
        return std::ptr::null_mut();
    }
    
    let hashes_json = match CStr::from_ptr(hashes_json_ptr).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    
    let hashes: Vec<String> = match serde_json::from_str(hashes_json) {
        Ok(h) => h,
        Err(_) => return std::ptr::null_mut(),
    };
    
    if hashes.len() > 100000 || tx_index as usize >= hashes.len() {
        return std::ptr::null_mut();
    }
    
    match merkle::generate_merkle_proof(&hashes, tx_index as usize) {
        Ok(proof) => {
            let json = match serde_json::to_string(&proof) {
                Ok(j) => j,
                Err(_) => return std::ptr::null_mut(),
            };
            if json.len() > 65536 {
                return std::ptr::null_mut();
            }
            match CString::new(json.replace('\0', "")) {
                Ok(c_str) => c_str.into_raw(),
                Err(_) => std::ptr::null_mut(),
            }
        },
        Err(_) => std::ptr::null_mut(),
    }
}

/// Frees a C string allocated by this library.
///
/// # Safety
///
/// Pointer must have been allocated by this library (compute_merkle_root, generate_merkle_proof).
#[no_mangle]
pub unsafe extern "C" fn free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = std::panic::catch_unwind(|| {
            let _ = CString::from_raw(ptr);
        });
    }
}

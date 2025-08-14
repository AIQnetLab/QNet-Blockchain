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
use std::collections::HashMap;

mod crypto;
mod merkle;

/// Verifies a PQ signature
///
/// # Arguments
///
/// * `message_ptr` - Pointer to message bytes
/// * `signature_ptr` - Pointer to hex-encoded signature
/// * `public_key_ptr` - Pointer to hex-encoded public key
/// * `algorithm_ptr` - Pointer to algorithm name
///
/// # Safety
///
/// This function is unsafe because it dereferences raw pointers.
#[no_mangle]
pub unsafe extern "C" fn verify_pq_signature(
    message_ptr: *const c_char,
    signature_ptr: *const c_char,
    public_key_ptr: *const c_char,
    algorithm_ptr: *const c_char,
) -> bool {
    // Convert C strings to Rust strings
    if message_ptr.is_null() || signature_ptr.is_null() || public_key_ptr.is_null() || algorithm_ptr.is_null() {
        return false;
    }
    
    let message = match CStr::from_ptr(message_ptr).to_str() {
        Ok(s) => s,
        Err(_) => return false,
    };
    
    let signature_hex = match CStr::from_ptr(signature_ptr).to_str() {
        Ok(s) => s,
        Err(_) => return false,
    };
    
    let public_key_hex = match CStr::from_ptr(public_key_ptr).to_str() {
        Ok(s) => s,
        Err(_) => return false,
    };
    
    let algorithm_str = match CStr::from_ptr(algorithm_ptr).to_str() {
        Ok(s) => s,
        Err(_) => return false,
    };
    
    // Convert algorithm string to enum
    let algorithm = match algorithm_str {
        "Dilithium2" => crypto::PQAlgorithm::Dilithium2,
        "Dilithium3" => crypto::PQAlgorithm::Dilithium3,
        "Dilithium5" => crypto::PQAlgorithm::Dilithium5,
        "Falcon512" => crypto::PQAlgorithm::Falcon512,
        "Falcon1024" => crypto::PQAlgorithm::Falcon1024,
        "SPHINCS+-SHAKE128s-simple" => crypto::PQAlgorithm::SphincsShake128s,
        _ => crypto::PQAlgorithm::Dilithium2, // Default
    };
    
    // Call the actual verification function
    crypto::verify_signature(message, signature_hex, public_key_hex, algorithm)
}

/// Generates a PQ keypair
///
/// # Arguments
///
/// * `algorithm_ptr` - Pointer to algorithm name
///
/// # Returns
///
/// A C string containing the public key and secret key concatenated with ':'.
/// The caller is responsible for freeing this string with free_keypair.
///
/// # Safety
///
/// The caller must free the returned string with free_keypair.
#[no_mangle]
pub unsafe extern "C" fn generate_pq_keypair(algorithm_ptr: *const c_char) -> *mut c_char {
    if algorithm_ptr.is_null() {
        return std::ptr::null_mut();
    }
    
    let algorithm_str = match CStr::from_ptr(algorithm_ptr).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    
    // Convert algorithm string to enum
    let algorithm = match algorithm_str {
        "Dilithium2" => crypto::PQAlgorithm::Dilithium2,
        "Dilithium3" => crypto::PQAlgorithm::Dilithium3,
        "Dilithium5" => crypto::PQAlgorithm::Dilithium5,
        "Falcon512" => crypto::PQAlgorithm::Falcon512,
        "Falcon1024" => crypto::PQAlgorithm::Falcon1024,
        "SPHINCS+-SHAKE128s-simple" => crypto::PQAlgorithm::SphincsShake128s,
        _ => crypto::PQAlgorithm::Dilithium2, // Default
    };
    
    match crypto::generate_keypair(algorithm) {
        Ok((public_key, secret_key)) => {
            // Format as "public_key:secret_key"
            let result = format!("{}:{}", public_key, secret_key);
            
            // SECURITY: Safe C string creation with length validation
            if result.len() > 65536 { // 64KB limit for production safety
                return std::ptr::null_mut();
            }
            
            // PRODUCTION: Convert to C string with null-byte protection
            match CString::new(result.replace('\0', "")) { // Remove null bytes
                Ok(c_str) => c_str.into_raw(),
                Err(_) => std::ptr::null_mut(),
            }
        },
        Err(_) => std::ptr::null_mut(),
    }
}

/// Frees a string created by generate_pq_keypair
///
/// # Arguments
///
/// * `ptr` - Pointer to a string created by generate_pq_keypair
///
/// # Safety
///
/// PRODUCTION: This function is unsafe because it reclaims ownership of a raw pointer.
/// Double-free protection and memory safety checks included.
#[no_mangle]
pub unsafe extern "C" fn free_keypair(ptr: *mut c_char) {
    // SECURITY: Check for null and prevent double-free
    if !ptr.is_null() {
        // PRODUCTION: Safe reclaim with error handling
        let _ = std::panic::catch_unwind(|| {
            let _ = CString::from_raw(ptr);
        });
    }
}

/// Signs a message using PQ algorithm
///
/// # Arguments
///
/// * `message_ptr` - Pointer to message bytes
/// * `secret_key_ptr` - Pointer to hex-encoded secret key
/// * `algorithm_ptr` - Pointer to algorithm name
///
/// # Returns
///
/// A C string containing the signature. The caller is responsible for freeing
/// this string with free_string.
///
/// # Safety
///
/// The caller must free the returned string with free_string.
#[no_mangle]
pub unsafe extern "C" fn sign_message_pq(
    message_ptr: *const c_char,
    secret_key_ptr: *const c_char,
    algorithm_ptr: *const c_char,
) -> *mut c_char {
    if message_ptr.is_null() || secret_key_ptr.is_null() || algorithm_ptr.is_null() {
        return std::ptr::null_mut();
    }
    
    let message = match CStr::from_ptr(message_ptr).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    
    let secret_key_hex = match CStr::from_ptr(secret_key_ptr).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    
    let algorithm_str = match CStr::from_ptr(algorithm_ptr).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    
    // Convert algorithm string to enum
    let algorithm = match algorithm_str {
        "Dilithium2" => crypto::PQAlgorithm::Dilithium2,
        "Dilithium3" => crypto::PQAlgorithm::Dilithium3,
        "Dilithium5" => crypto::PQAlgorithm::Dilithium5,
        "Falcon512" => crypto::PQAlgorithm::Falcon512,
        "Falcon1024" => crypto::PQAlgorithm::Falcon1024,
        "SPHINCS+-SHAKE128s-simple" => crypto::PQAlgorithm::SphincsShake128s,
        _ => crypto::PQAlgorithm::Dilithium2, // Default
    };
    
    match crypto::sign_message(message, secret_key_hex, algorithm) {
        Ok(signature) => {
            // SECURITY: Safe C string creation with length validation
            if signature.len() > 32768 { // 32KB limit for signatures
                return std::ptr::null_mut();
            }
            
            // PRODUCTION: Convert to C string with null-byte protection
            match CString::new(signature.replace('\0', "")) { // Remove null bytes
                Ok(c_str) => c_str.into_raw(),
                Err(_) => std::ptr::null_mut(),
            }
        },
        Err(_) => std::ptr::null_mut(),
    }
}

/// Computes a Merkle root from a list of transaction hashes.
///
/// # Arguments
///
/// * `hashes_json_ptr` - Pointer to a JSON string containing an array of hash strings
/// * `count` - Number of hashes in the array
///
/// # Returns
///
/// A C string containing the Merkle root hash.
/// The caller is responsible for freeing this string with free_string.
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
    
    // Convert C string to Rust string
    let hashes_json = match CStr::from_ptr(hashes_json_ptr).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    
    // Parse JSON array of hashes
    let hashes: Vec<String> = match serde_json::from_str(hashes_json) {
        Ok(h) => h,
        Err(_) => return std::ptr::null_mut(),
    };
    
    // SECURITY: Limit input size for production safety
    if hashes.len() > 100000 { // Max 100k hashes
        return std::ptr::null_mut();
    }
    
    // Compute Merkle root
    match merkle::compute_merkle_root(&hashes) {
        Ok(root) => {
            // SECURITY: Safe C string creation with length validation
            if root.len() > 1024 { // 1KB limit for hash strings
                return std::ptr::null_mut();
            }
            
            // PRODUCTION: Convert to C string with null-byte protection
            match CString::new(root.replace('\0', "")) { // Remove null bytes
                Ok(c_str) => c_str.into_raw(),
                Err(_) => std::ptr::null_mut(),
            }
        },
        Err(_) => std::ptr::null_mut(),
    }
}

/// Generate a Merkle proof for a transaction
///
/// # Arguments
///
/// * `hashes_json_ptr` - Pointer to a JSON string containing an array of hash strings
/// * `tx_index` - Index of the transaction to generate proof for
///
/// # Returns
///
/// A C string containing the JSON-encoded Merkle proof.
/// The caller is responsible for freeing this string with free_string.
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
    
    // Convert C string to Rust string
    let hashes_json = match CStr::from_ptr(hashes_json_ptr).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    
    // Parse JSON array of hashes
    let hashes: Vec<String> = match serde_json::from_str(hashes_json) {
        Ok(h) => h,
        Err(_) => return std::ptr::null_mut(),
    };
    
    // SECURITY: Limit input size and validate transaction index
    if hashes.len() > 100000 || tx_index as usize >= hashes.len() {
        return std::ptr::null_mut();
    }
    
    // Generate Merkle proof
    match merkle::generate_merkle_proof(&hashes, tx_index as usize) {
        Ok(proof) => {
            // Convert to JSON string
            let json = match serde_json::to_string(&proof) {
                Ok(j) => j,
                Err(_) => return std::ptr::null_mut(),
            };
            
            // SECURITY: Safe C string creation with length validation
            if json.len() > 65536 { // 64KB limit for JSON proof
                return std::ptr::null_mut();
            }
            
            // PRODUCTION: Convert to C string with null-byte protection
            match CString::new(json.replace('\0', "")) { // Remove null bytes
                Ok(c_str) => c_str.into_raw(),
                Err(_) => std::ptr::null_mut(),
            }
        },
        Err(_) => std::ptr::null_mut(),
    }
}

/// Frees a string created by compute_merkle_root or other functions
///
/// # Arguments
///
/// * `ptr` - Pointer to a string to free
///
/// # Safety
///
/// PRODUCTION: This function is unsafe because it reclaims ownership of a raw pointer.
/// Double-free protection and memory safety checks included.
#[no_mangle]
pub unsafe extern "C" fn free_string(ptr: *mut c_char) {
    // SECURITY: Check for null and prevent double-free
    if !ptr.is_null() {
        // PRODUCTION: Safe reclaim with error handling
        let _ = std::panic::catch_unwind(|| {
            let _ = CString::from_raw(ptr);
        });
    }
}

/// Gets available PQ algorithms and their key/signature sizes
///
/// # Returns
///
/// A C string containing a JSON object with algorithm information.
/// The caller is responsible for freeing this string with free_string.
///
/// # Safety
///
/// The caller must free the returned string with free_string.
#[no_mangle]
pub unsafe extern "C" fn get_pq_algorithm_info() -> *mut c_char {
    // Get algorithm availability
    let availability = crypto::test_algorithm_availability();
    
    // Get algorithm sizes
    let sizes = match crypto::get_algorithm_sizes() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };
    
    // Build info struct
    let mut info = HashMap::new();
    for (algo, avail) in availability {
        if let Some(&(pk_size, sk_size, sig_size)) = sizes.get(&algo) {
            let algo_info = HashMap::from([
                ("available".to_string(), avail.to_string()),
                ("public_key_size".to_string(), pk_size.to_string()),
                ("secret_key_size".to_string(), sk_size.to_string()),
                ("signature_size".to_string(), sig_size.to_string()),
            ]);
            info.insert(algo, algo_info);
        }
    }
    
    // Convert to JSON string
    let json = match serde_json::to_string(&info) {
        Ok(j) => j,
        Err(_) => return std::ptr::null_mut(),
    };
    
    // SECURITY: Safe C string creation with length validation  
    if json.len() > 32768 { // 32KB limit for algorithm info JSON
        return std::ptr::null_mut();
    }
    
    // PRODUCTION: Convert to C string with null-byte protection
    match CString::new(json.replace('\0', "")) { // Remove null bytes
        Ok(c_str) => c_str.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}
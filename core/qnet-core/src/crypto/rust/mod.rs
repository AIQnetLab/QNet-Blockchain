// QNet-core crypto module
// v3.11: Added Merkle tree exports for proofs

pub mod production_crypto;
pub mod utils;
pub mod merkle;

// v3.11: Export Merkle tree types
pub use merkle::{
    compute_merkle_root,
    compute_merkle_root_bytes,
    generate_merkle_proof,
    verify_merkle_proof,
    verify_merkle_proof_bytes,
    batch_verify_merkle_proofs,
    compute_incremental_merkle_root,
    StateMerkleTree,
    generate_cross_shard_proof,
    verify_cross_shard_proof,
    HistoricalTxProof,
};

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
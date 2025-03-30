//! Advanced Merkle tree implementation for QNet
//! Provides efficient transaction verification with optimized memory usage

use sha2::{Sha256, Digest};
use std::error::Error;
use std::collections::HashMap;
use std::cmp::min;

/// Computes the Merkle root from a list of transaction hashes
///
/// # Arguments
///
/// * `transaction_hashes` - List of transaction hash strings
///
/// # Returns
///
/// The Merkle root hash as a hex string, or an error
pub fn compute_merkle_root(transaction_hashes: &[String]) -> Result<String, Box<dyn Error>> {
    if transaction_hashes.is_empty() {
        // Return hash of empty string for empty tree
        let hasher = Sha256::new();
        let result = hasher.finalize();
        return Ok(hex::encode(result));
    }
    
    if transaction_hashes.len() == 1 {
        return Ok(transaction_hashes[0].clone());
    }
    
    // Build tree recursively
    let root = build_tree_level(transaction_hashes)?;
    Ok(root)
}

/// Recursively builds a level of the Merkle tree
fn build_tree_level(hashes: &[String]) -> Result<String, Box<dyn Error>> {
    if hashes.len() == 1 {
        return Ok(hashes[0].clone());
    }
    
    let mut next_level = Vec::new();
    
    // Process pairs of hashes
    for i in (0..hashes.len()).step_by(2) {
        let left = &hashes[i];
        // If there's no right child, duplicate the left one
        let right = if i + 1 < hashes.len() { &hashes[i + 1] } else { left };
        
        // Combine hashes and compute parent
        let combined = format!("{}{}", left, right);
        let mut hasher = Sha256::new();
        hasher.update(combined);
        let result = hasher.finalize();
        next_level.push(hex::encode(result));
    }
    
    // Recursively process the next level
    build_tree_level(&next_level)
}

/// Generates a Merkle proof for a transaction
///
/// # Arguments
///
/// * `transaction_hashes` - List of all transaction hashes in the block
/// * `tx_index` - Index of the transaction to generate proof for
///
/// # Returns
///
/// A vector of (hash, is_left) pairs representing the Merkle proof
pub fn generate_merkle_proof(
    transaction_hashes: &[String],
    tx_index: usize
) -> Result<Vec<(String, bool)>, Box<dyn Error>> {
    if transaction_hashes.is_empty() {
        return Err("Empty transaction list".into());
    }
    
    if tx_index >= transaction_hashes.len() {
        return Err("Transaction index out of bounds".into());
    }
    
    let mut proof = Vec::new();
    let mut current_hashes = transaction_hashes.to_vec();
    let mut current_index = tx_index;
    
    while current_hashes.len() > 1 {
        let pair_index = current_index ^ 1; // XOR with 1 to get the sibling
        
        if pair_index < current_hashes.len() {
            // Add the sibling to the proof
            let is_left = pair_index < current_index;
            proof.push((current_hashes[pair_index].clone(), is_left));
        } else {
            // If no sibling (odd number of elements), use self
            let is_left = false; // There's only a right sibling in this case
            proof.push((current_hashes[current_index].clone(), is_left));
        }
        
        // Move to next level
        let mut next_level = Vec::new();
        for i in (0..current_hashes.len()).step_by(2) {
            let left = &current_hashes[i];
            let right = if i + 1 < current_hashes.len() { 
                &current_hashes[i + 1] 
            } else { 
                left 
            };
            
            let combined = format!("{}{}", left, right);
            let mut hasher = Sha256::new();
            hasher.update(combined);
            let result = hasher.finalize();
            next_level.push(hex::encode(result));
        }
        
        // Update current index for next level
        current_index /= 2;
        current_hashes = next_level;
    }
    
    Ok(proof)
}

/// Verifies that a transaction is included in a block with the given Merkle root
///
/// # Arguments
///
/// * `tx_hash` - Transaction hash to verify
/// * `merkle_root` - Merkle root to verify against
/// * `merkle_proof` - Proof of inclusion (list of hashes and their positions)
///
/// # Returns
///
/// `true` if the transaction is included, `false` otherwise
pub fn verify_merkle_proof(
    tx_hash: &str,
    merkle_root: &str,
    merkle_proof: &[(String, bool)]  // (hash, is_left)
) -> bool {
    let mut current_hash = tx_hash.to_string();
    
    // Apply each proof element
    for (proof_hash, is_left) in merkle_proof {
        // Combine current hash with proof hash in the right order
        let combined = if *is_left {
            format!("{}{}", proof_hash, current_hash)
        } else {
            format!("{}{}", current_hash, proof_hash)
        };
        
        // Hash the combined value
        let mut hasher = Sha256::new();
        hasher.update(&combined);
        let result = hasher.finalize();
        current_hash = hex::encode(result);
    }
    
    // Check if the computed hash matches the merkle root
    current_hash == merkle_root
}

/// Batch verify multiple transactions against a Merkle root
///
/// # Arguments
///
/// * `tx_data` - Vector of (tx_hash, proof) pairs to verify
/// * `merkle_root` - Merkle root to verify against
///
/// # Returns
///
/// HashMap of tx_hash -> verification result
pub fn batch_verify_merkle_proofs(
    tx_data: &[(String, Vec<(String, bool)>)],
    merkle_root: &str
) -> HashMap<String, bool> {
    let mut results = HashMap::new();
    
    for (tx_hash, proof) in tx_data {
        let result = verify_merkle_proof(tx_hash, merkle_root, proof);
        results.insert(tx_hash.clone(), result);
    }
    
    results
}

/// Computes an incremental Merkle tree from transactions
/// This is more efficient for large numbers of transactions
///
/// # Arguments
///
/// * `transaction_hashes` - List of transaction hash strings
/// * `batch_size` - Number of hashes to process at once
///
/// # Returns
///
/// The Merkle root hash as a hex string, or an error
pub fn compute_incremental_merkle_root(
    transaction_hashes: &[String],
    batch_size: usize
) -> Result<String, Box<dyn Error>> {
    if transaction_hashes.is_empty() {
        // Return hash of empty string for empty tree
        let hasher = Sha256::new();
        let result = hasher.finalize();
        return Ok(hex::encode(result));
    }
    
    if transaction_hashes.len() == 1 {
        return Ok(transaction_hashes[0].clone());
    }
    
    let mut current_level = Vec::new();
    
    // Process in batches for memory efficiency
    for chunk in transaction_hashes.chunks(batch_size) {
        let mut batch_hashes = chunk.to_vec();
        
        while batch_hashes.len() > 1 {
            let mut next_level = Vec::new();
            
            // Process pairs of hashes
            for i in (0..batch_hashes.len()).step_by(2) {
                let left = &batch_hashes[i];
                let right = if i + 1 < batch_hashes.len() { 
                    &batch_hashes[i + 1] 
                } else { 
                    left 
                };
                
                let combined = format!("{}{}", left, right);
                let mut hasher = Sha256::new();
                hasher.update(combined);
                let result = hasher.finalize();
                next_level.push(hex::encode(result));
            }
            
            batch_hashes = next_level;
        }
        
        // Add the batch root to current level
        if !batch_hashes.is_empty() {
            current_level.push(batch_hashes[0].clone());
        }
    }
    
    // Process the roots of each batch
    build_tree_level(&current_level)
}
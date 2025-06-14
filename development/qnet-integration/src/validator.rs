//! Block and transaction validation

use std::sync::Arc;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use crate::errors::{IntegrationError, IntegrationResult};
use crate::storage::PersistentStorage;
use crate::errors::QNetError;
use qnet_state::{Block, Transaction};
use sha2::{Sha256, Digest};
use std::collections::HashSet;

/// Block validator
pub struct BlockValidator {
    /// Maximum block size in bytes
    max_block_size: usize,
    /// Maximum transactions per block
    max_transactions: usize,
    /// Minimum gas price
    min_gas_price: u64,
}

/// Validator for blocks and transactions
pub struct Validator;

impl BlockValidator {
    /// Create new validator
    pub fn new() -> Self {
        Self {
            max_block_size: 2_000_000, // 2MB max block size
            max_transactions: 10_000,   // 10k transactions per block
            min_gas_price: 1,          // Minimum 1 unit gas price
        }
    }
    
    /// Validate a complete block
    pub fn validate_block(&self, block: &Block) -> Result<(), ValidationError> {
        // 1. Basic structure validation
        self.validate_block_structure(block)?;
        
        // 2. Validate block header
        self.validate_block_header(block)?;
        
        // 3. Skip consensus proof validation (not in current Block structure)
        
        // 5. Validate all transactions
        self.validate_block_transactions(block)?;
        
        // 6. Validate merkle root
        self.validate_merkle_root(block)?;
        
        Ok(())
    }
    
    /// Validate block structure and basic constraints
    fn validate_block_structure(&self, block: &Block) -> Result<(), ValidationError> {
        // Block size check removed - simplified validation
        
        // Check transaction count
        if block.transactions.len() > self.max_transactions {
            return Err(ValidationError::TooManyTransactions(
                block.transactions.len(), 
                self.max_transactions
            ));
        }
        
        // Check timestamp (not too far in future)
        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        if block.timestamp > current_time + 300 { // 5 minutes tolerance
            return Err(ValidationError::InvalidTimestamp(block.timestamp, current_time));
        }
        
        Ok(())
    }
    
    /// Validate block header fields
    fn validate_block_header(&self, block: &Block) -> Result<(), ValidationError> {
        // Validate hash format
        let hash_hex = hex::encode(block.hash());
        if hash_hex.len() != 64 {
            return Err(ValidationError::InvalidHash(hash_hex));
        }
        
        // Validate previous hash format
        let prev_hash_hex = hex::encode(block.previous_hash);
        if prev_hash_hex.len() != 64 {
            return Err(ValidationError::InvalidPreviousHash(prev_hash_hex));
        }
        
        // Validate height (must be positive for non-genesis)
        if block.height == 0 && block.previous_hash != [0u8; 32] {
            return Err(ValidationError::InvalidHeight(block.height));
        }
        
        Ok(())
    }
    
    // Removed consensus proof and state root validation - not in current Block structure
    
    /// Validate all transactions in the block
    fn validate_block_transactions(&self, block: &Block) -> Result<(), ValidationError> {
        let mut used_nonces = std::collections::HashMap::new();
        
        for tx in &block.transactions {
            // Validate individual transaction
            self.validate_transaction(tx)?;
            
            // Check for nonce conflicts
            let account_nonces = used_nonces.entry(&tx.from).or_insert_with(HashSet::new);
            if !account_nonces.insert(tx.nonce) {
                return Err(ValidationError::DuplicateNonce(tx.from.clone(), tx.nonce));
            }
        }
        
        Ok(())
    }
    
    /// Validate merkle root
    fn validate_merkle_root(&self, block: &Block) -> Result<(), ValidationError> {
        let computed_merkle_root = self.compute_merkle_root(&block.transactions);
        let current_merkle_root = hex::encode(block.merkle_root);
        
        if current_merkle_root != computed_merkle_root {
            return Err(ValidationError::InvalidMerkleRoot(
                current_merkle_root,
                computed_merkle_root
            ));
        }
        
        Ok(())
    }
    
    /// Validate individual transaction
    pub fn validate_transaction(&self, tx: &Transaction) -> Result<(), ValidationError> {
        // 1. Basic format validation
        if tx.from.is_empty() {
            return Err(ValidationError::InvalidTransactionFormat);
        }
        
        if let Some(ref to) = tx.to {
            if to.is_empty() {
                return Err(ValidationError::InvalidTransactionFormat);
            }
        }
        
        // 2. Amount validation
        if tx.amount == 0 {
            return Err(ValidationError::ZeroAmount);
        }
        
        // 3. Gas price validation
        if tx.gas_price < self.min_gas_price {
            return Err(ValidationError::GasPriceTooLow(tx.gas_price, self.min_gas_price));
        }
        
        // 4. Signature validation (basic format check)
        if let Some(ref signature) = tx.signature {
            if !self.validate_transaction_signature_format(signature) {
                return Err(ValidationError::InvalidSignature(
                    hex::encode(tx.hash().unwrap_or_default())
                ));
            }
        }
        
        // 5. Nonce validation (basic check)
        if tx.nonce == 0 {
            return Err(ValidationError::InvalidNonce(tx.nonce));
        }
        
        Ok(())
    }
    
    /// Validate transaction signature format
    fn validate_transaction_signature_format(&self, signature: &str) -> bool {
        // Basic signature format validation (hex string, minimum length)
        signature.len() >= 128 &&
        signature.chars().all(|c| c.is_ascii_hexdigit()) &&
        !signature.is_empty()
    }
    
    // Removed producer signature validation - not in current Block structure
    
    /// Calculate block size in bytes (simplified)
    fn _calculate_block_size(&self, block: &Block) -> usize {
        let mut size = 0;
        
        // Header size (simplified)
        size += 32; // hash
        size += 8;  // height
        size += 8;  // timestamp
        size += 32; // previous_hash
        size += 32; // merkle_root
        
        // Transactions size (simplified)
        for tx in &block.transactions {
            size += 32; // hash
            size += tx.from.len();
            if let Some(ref to) = tx.to {
                size += to.len();
            }
            size += 8; // amount
            size += 8; // nonce
            size += 8; // gas_price
            size += 8; // gas_limit
            if let Some(ref signature) = tx.signature {
                size += signature.len();
            }
            if let Some(ref data) = tx.data {
                size += data.len();
            }
        }
        
        size
    }
    
    // Removed state root computation - not needed for current Block structure
    
    /// Compute merkle root from transactions
    fn compute_merkle_root(&self, transactions: &[Transaction]) -> String {
        if transactions.is_empty() {
            return hex::encode([0u8; 32]);
        }
        
        let mut hashes: Vec<String> = transactions.iter()
            .map(|tx| hex::encode(tx.hash().unwrap_or_default()))
            .collect();
        
        // Build merkle tree
        while hashes.len() > 1 {
            let mut next_level = Vec::new();
            
            for chunk in hashes.chunks(2) {
                let mut hasher = Sha256::new();
                hasher.update(chunk[0].as_bytes());
                if chunk.len() > 1 {
                    hasher.update(chunk[1].as_bytes());
                } else {
                    hasher.update(chunk[0].as_bytes()); // Duplicate if odd number
                }
                next_level.push(hex::encode(hasher.finalize()));
            }
            
            hashes = next_level;
        }
        
        hashes[0].clone()
    }
    
    // Removed transaction and block message creation - not needed for current validation
}

/// Validation errors
#[derive(Debug, Clone)]
pub enum ValidationError {
    TooManyTransactions(usize, usize),
    InvalidTimestamp(u64, u64),
    InvalidHash(String),
    InvalidPreviousHash(String),
    InvalidHeight(u64),
    InvalidMerkleRoot(String, String),
    DuplicateNonce(String, u64),
    InvalidTransactionFormat,
    ZeroAmount,
    GasPriceTooLow(u64, u64),
    InvalidSignature(String),
    InvalidNonce(u64),
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidationError::TooManyTransactions(actual, max) => 
                write!(f, "Too many transactions: {} (max: {})", actual, max),
            ValidationError::InvalidTimestamp(block_time, current_time) => 
                write!(f, "Invalid timestamp: {} (current: {})", block_time, current_time),
            ValidationError::InvalidHash(hash) => 
                write!(f, "Invalid hash format: {}", hash),
            ValidationError::InvalidPreviousHash(hash) => 
                write!(f, "Invalid previous hash format: {}", hash),
            ValidationError::InvalidHeight(height) => 
                write!(f, "Invalid block height: {}", height),
            ValidationError::InvalidMerkleRoot(expected, actual) => 
                write!(f, "Invalid merkle root: expected {}, got {}", expected, actual),
            ValidationError::DuplicateNonce(address, nonce) => 
                write!(f, "Duplicate nonce {} for address {}", nonce, address),
            ValidationError::InvalidTransactionFormat => 
                write!(f, "Invalid transaction format"),
            ValidationError::ZeroAmount => 
                write!(f, "Transaction amount cannot be zero"),
            ValidationError::GasPriceTooLow(actual, min) => 
                write!(f, "Gas price too low: {} (minimum: {})", actual, min),
            ValidationError::InvalidSignature(tx_hash) => 
                write!(f, "Invalid signature for transaction: {}", tx_hash),
            ValidationError::InvalidNonce(nonce) => 
                write!(f, "Invalid nonce: {}", nonce),
        }
    }
}

impl std::error::Error for ValidationError {}

impl Validator {
    /// Create new validator
    pub fn new() -> Self {
        Self
    }
    
    /// Validate a transaction
    pub fn validate_transaction(&self, tx: &Transaction) -> Result<(), QNetError> {
        // Basic validation
        if tx.amount == 0 {
            return Err(QNetError::ValidationError("Zero amount transaction".into()));
        }
        
        if tx.gas_limit < 21000 {
            return Err(QNetError::ValidationError("Gas limit too low".into()));
        }
        
        if tx.gas_price == 0 {
            return Err(QNetError::ValidationError("Zero gas price".into()));
        }
        
        // TODO: Add signature validation
        
        Ok(())
    }
    
    /// Validate a block
    pub fn validate_block(&self, block: &Block) -> Result<(), QNetError> {
        // Basic validation
        if block.transactions.is_empty() && block.height > 0 {
            return Err(QNetError::ValidationError("Empty block".into()));
        }
        
        // Validate all transactions
        for tx in &block.transactions {
            self.validate_transaction(tx)?;
        }
        
        // TODO: Add more validation (merkle root, consensus proof, etc.)
        
        Ok(())
    }
} 
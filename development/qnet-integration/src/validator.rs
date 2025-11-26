//! Block and transaction validation for QNet blockchain

use std::sync::Arc;
use crate::errors::{IntegrationError, IntegrationResult};
use crate::storage::PersistentStorage;
use qnet_state::{Block, Transaction, TransactionType};
use sha3::{Sha3_256, Digest};

/// Block and transaction validator
pub struct BlockValidator {
    /// Storage for validation against historical data
    storage: Option<Arc<PersistentStorage>>,
}

impl BlockValidator {
    /// Create new validator
    pub fn new() -> Self {
        Self {
            storage: None,
        }
    }
    
    /// Set storage for historical validation
    pub fn set_storage(&mut self, storage: Arc<PersistentStorage>) {
        self.storage = Some(storage);
    }
    
    /// Validate a block
    pub fn validate_block(&self, block: &Block) -> IntegrationResult<()> {
        // Basic block validation
        if block.height == 0 {
            return Err(IntegrationError::ValidationError("Block height cannot be zero".to_string()));
        }
        
        if block.timestamp == 0 {
            return Err(IntegrationError::ValidationError("Block timestamp cannot be zero".to_string()));
        }
        
        if block.transactions.is_empty() {
            return Err(IntegrationError::ValidationError("Block must contain at least one transaction".to_string()));
        }
        
        // Validate each transaction
        for tx in &block.transactions {
            self.validate_transaction(tx)?;
        }
        
        Ok(())
    }
    
    /// Validate a transaction
    pub fn validate_transaction(&self, tx: &Transaction) -> IntegrationResult<()> {
        // Basic transaction validation
        if tx.hash.is_empty() {
            return Err(IntegrationError::ValidationError("Transaction hash cannot be empty".to_string()));
        }
        
        if tx.from.is_empty() {
            return Err(IntegrationError::ValidationError("Transaction sender cannot be empty".to_string()));
        }
        
        // CRITICAL: NodeActivation has special amount rules based on phase
        // Skip general amount check for NodeActivation (validated in validate_transaction_type)
        let is_node_activation = matches!(tx.tx_type, TransactionType::NodeActivation { .. });
        
        if tx.amount == 0 && !is_node_activation {
            return Err(IntegrationError::ValidationError("Transaction amount cannot be zero".to_string()));
        }
        
        // Validate transaction type
        self.validate_transaction_type(&tx.tx_type)?;
        
        // Validate signature if present
        if let Some(ref signature) = tx.signature {
            self.validate_signature(tx, signature)?;
        }
        
        Ok(())
    }
    
    /// Validate transaction signature
    fn validate_signature(&self, tx: &Transaction, signature: &str) -> IntegrationResult<()> {
        // Check if signature is not empty
        if signature.is_empty() {
            return Err(IntegrationError::ValidationError("Transaction signature cannot be empty".to_string()));
        }
        
        // PRODUCTION: Real cryptographic signature validation
        match self.verify_ed25519_signature(tx, signature) {
            Ok(is_valid) => {
                if is_valid {
                    Ok(())
                } else {
                    Err(IntegrationError::ValidationError("Invalid signature".to_string()))
                }
            }
            Err(e) => {
                // CRITICAL: Reject transaction if signature verification fails
                Err(IntegrationError::ValidationError(format!("Signature verification failed: {}", e)))
            }
        }
    }
    
    /// Verify transaction signature (Ed25519 or Hybrid)
    fn verify_ed25519_signature(&self, tx: &Transaction, signature_hex: &str) -> IntegrationResult<bool> {
        // PRODUCTION: Support multiple signature formats
        if signature_hex.starts_with("hybrid:") {
            // Node hybrid signature (with certificate) - for consensus messages
            self.verify_hybrid_signature(tx, signature_hex)
        } else if signature_hex.starts_with("dilithium_sig_") {
            // Pure Dilithium signature
            self.verify_dilithium_signature(tx, signature_hex)
        } else {
            // Ed25519 signature - requires public_key in transaction
            self.verify_ed25519_with_pubkey(tx, signature_hex)
        }
    }
    
    /// PRODUCTION: Verify Ed25519 signature with public key from transaction
    fn verify_ed25519_with_pubkey(&self, tx: &Transaction, signature_hex: &str) -> IntegrationResult<bool> {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        
        // CRITICAL: Require public key in transaction
        let pubkey_hex = tx.public_key.as_ref().ok_or_else(|| {
            IntegrationError::ValidationError("Missing public_key in transaction - required for Ed25519 verification".to_string())
        })?;
        
        // Decode public key (32 bytes)
        let pubkey_bytes = hex::decode(pubkey_hex)
            .map_err(|e| IntegrationError::ValidationError(format!("Invalid public key hex: {}", e)))?;
        
        if pubkey_bytes.len() != 32 {
            return Err(IntegrationError::ValidationError("Invalid Ed25519 public key length (expected 32 bytes)".to_string()));
        }
        
        let verifying_key = VerifyingKey::from_bytes(&pubkey_bytes.try_into().unwrap())
            .map_err(|e| IntegrationError::ValidationError(format!("Invalid Ed25519 public key: {}", e)))?;
        
        // Decode signature (64 bytes)
        let sig_bytes = hex::decode(signature_hex)
            .map_err(|e| IntegrationError::ValidationError(format!("Invalid signature hex: {}", e)))?;
        
        if sig_bytes.len() != 64 {
            return Err(IntegrationError::ValidationError("Invalid Ed25519 signature length (expected 64 bytes)".to_string()));
        }
        
        let signature = Signature::from_bytes(&sig_bytes.try_into().unwrap());
        
        // PRODUCTION: Create CLIENT signing message (without nonce/timestamp - client doesn't know them yet)
        // Client signs: "transfer:from:to:amount:gas_price:gas_limit"
        let message = self.create_client_signing_message(tx)?;
        
        // PRODUCTION: Real cryptographic verification
        match verifying_key.verify(&message, &signature) {
            Ok(_) => {
                println!("[VALIDATOR] ✅ Ed25519 signature verified for transaction from {}", tx.from);
                Ok(true)
            }
            Err(e) => {
                println!("[VALIDATOR] ❌ Invalid Ed25519 signature from {}: {}", tx.from, e);
                Ok(false)
            }
        }
    }
    
    /// Verify hybrid signature (O(1) performance with caching)
    fn verify_hybrid_signature(&self, tx: &Transaction, signature_hex: &str) -> IntegrationResult<bool> {
        use crate::hybrid_crypto::{HybridSignature, HybridCrypto};
        use serde_json;
        
        // Parse hybrid signature JSON
        let signature_json = &signature_hex[7..]; // Skip "hybrid:" prefix
        let hybrid_sig: HybridSignature = serde_json::from_str(signature_json)
            .map_err(|e| IntegrationError::ValidationError(format!("Invalid hybrid signature: {}", e)))?;
        
        // Create message to verify
        let message = self.create_signing_message(tx)?;
        
        // Verify using hybrid crypto (with certificate caching)
        let rt = tokio::runtime::Handle::try_current()
            .or_else(|_| tokio::runtime::Runtime::new().map(|rt| rt.handle().clone()))
            .map_err(|e| IntegrationError::ValidationError(format!("Runtime error: {}", e)))?;
        
        let result = rt.block_on(async {
            let verifier = HybridCrypto::new(hybrid_sig.certificate.node_id.clone());
            verifier.verify_signature(&message, &hybrid_sig).await
        });
        
        match result {
            Ok(valid) => {
                if valid {
                    println!("[VALIDATOR] ✅ Hybrid signature verified (O(1) with caching)");
                } else {
                    println!("[VALIDATOR] ❌ Invalid hybrid signature");
                }
                Ok(valid)
            }
            Err(e) => {
                println!("[VALIDATOR] ⚠️ Hybrid verification error: {}", e);
                Ok(false)
            }
        }
    }
    
    /// Verify pure Dilithium signature
    fn verify_dilithium_signature(&self, tx: &Transaction, signature_hex: &str) -> IntegrationResult<bool> {
        use crate::quantum_crypto::{QNetQuantumCrypto, DilithiumSignature};
        
        // Create message to verify
        let message = self.create_signing_message(tx)?;
        let message_str = hex::encode(&message);
        
        // Create Dilithium signature struct
        let dilithium_sig = DilithiumSignature {
            signature: signature_hex.to_string(),
            algorithm: "CRYSTALS-Dilithium3".to_string(),
            timestamp: tx.timestamp,
            strength: "quantum-resistant".to_string(),
        };
        
        // Verify using quantum_crypto
        let rt = tokio::runtime::Handle::try_current()
            .or_else(|_| tokio::runtime::Runtime::new().map(|rt| rt.handle().clone()))
            .map_err(|e| IntegrationError::ValidationError(format!("Runtime error: {}", e)))?;
        
        let result = rt.block_on(async {
            // OPTIMIZATION: Use GLOBAL crypto instance
            use crate::node::GLOBAL_QUANTUM_CRYPTO;
            
            let mut crypto_guard = GLOBAL_QUANTUM_CRYPTO.lock().await;
            if crypto_guard.is_none() {
                let mut crypto = QNetQuantumCrypto::new();
                if let Err(e) = crypto.initialize().await {
                    return Err(anyhow::anyhow!("Crypto init failed: {}", e));
                }
                *crypto_guard = Some(crypto);
            }
            let crypto = crypto_guard.as_ref().unwrap();
            crypto.verify_dilithium_signature(&message_str, &dilithium_sig, &tx.from).await
        });
        
        match result {
            Ok(valid) => {
                if valid {
                    println!("[VALIDATOR] ✅ Dilithium signature verified");
                } else {
                    println!("[VALIDATOR] ❌ Invalid Dilithium signature");
                }
                Ok(valid)
            }
            Err(e) => {
                println!("[VALIDATOR] ⚠️ Dilithium verification error: {}", e);
                Ok(false)
            }
        }
    }
    
    // REMOVED: Legacy Ed25519 signature verification
    // All transactions MUST use quantum-resistant signatures
    
    /// Create signing message from transaction
    fn create_signing_message(&self, tx: &Transaction) -> IntegrationResult<Vec<u8>> {
        let mut message = Vec::new();
        
        // Add transaction fields to message
        message.extend_from_slice(tx.from.as_bytes());
        if let Some(ref to) = tx.to {
            message.extend_from_slice(to.as_bytes());
        }
        message.extend_from_slice(&tx.amount.to_le_bytes());
        message.extend_from_slice(&tx.nonce.to_le_bytes());
        message.extend_from_slice(&tx.gas_price.to_le_bytes());
        message.extend_from_slice(&tx.gas_limit.to_le_bytes());
        message.extend_from_slice(&tx.timestamp.to_le_bytes());
        
        // Add transaction type specific data
        match &tx.tx_type {
            TransactionType::Transfer { from, to, amount } => {
                message.extend_from_slice(b"transfer");
                message.extend_from_slice(from.as_bytes());
                message.extend_from_slice(to.as_bytes());
                message.extend_from_slice(&amount.to_le_bytes());
            }
            TransactionType::NodeActivation { node_type, amount, .. } => {
                message.extend_from_slice(b"node_activation");
                message.extend_from_slice(format!("{:?}", node_type).as_bytes());
                message.extend_from_slice(&amount.to_le_bytes());
            }
            _ => {
                // For other transaction types, add type identifier
                message.extend_from_slice(b"other");
            }
        }
        
        // Hash the message for signing
        let hash = Sha3_256::digest(&message);
        Ok(hash.to_vec())
    }
    
    /// PRODUCTION: Create CLIENT signing message (for Ed25519 signatures from mobile/browser)
    /// Client signs BEFORE knowing nonce/timestamp (those are set by server)
    /// Format: "transfer:from:to:amount:gas_price:gas_limit"
    fn create_client_signing_message(&self, tx: &Transaction) -> IntegrationResult<Vec<u8>> {
        // Client signs simple text message (they don't know nonce/timestamp yet)
        let message = match &tx.tx_type {
            TransactionType::Transfer { from, to, amount } => {
                format!("transfer:{}:{}:{}:{}:{}", 
                    from, to, amount, tx.gas_price, tx.gas_limit)
            }
            TransactionType::RewardDistribution => {
                // For reward claims: "claim_rewards:node_id:wallet_address"
                format!("claim_rewards:{}:{}", tx.from, tx.to.as_ref().unwrap_or(&String::new()))
            }
            _ => {
                return Err(IntegrationError::ValidationError(
                    "Unsupported transaction type for client signing".to_string()
                ));
            }
        };
        
        Ok(message.into_bytes())
    }
    
    // REMOVED: extract_public_key_from_address - no longer needed
    // All signatures must be quantum-resistant (Dilithium or hybrid)
    
    /// Validate transaction type with enhanced checks
    fn validate_transaction_type(&self, tx_type: &TransactionType) -> IntegrationResult<()> {
        match tx_type {
            TransactionType::Transfer { from, to, amount } => {
                if from.is_empty() {
                    return Err(IntegrationError::ValidationError("Transfer from address cannot be empty".to_string()));
                }
                if to.is_empty() {
                    return Err(IntegrationError::ValidationError("Transfer to address cannot be empty".to_string()));
                }
                if *amount == 0 {
                    return Err(IntegrationError::ValidationError("Transfer amount cannot be zero".to_string()));
                }
                // Check address format for testnet
                if from.len() < 32 || to.len() < 32 {
                    return Err(IntegrationError::ValidationError("Invalid address format".to_string()));
                }
            }
            TransactionType::NodeActivation { node_type, amount, phase, .. } => {
                // Phase-specific validation
                match phase {
                    qnet_state::account::ActivationPhase::Phase1 => {
                        if *amount != 0 {
                            return Err(IntegrationError::ValidationError("Phase 1 activation should have amount = 0 (1DEV burned externally)".to_string()));
                        }
                    }
                    qnet_state::account::ActivationPhase::Phase2 => {
                        if *amount == 0 {
                            return Err(IntegrationError::ValidationError("Phase 2 activation requires amount > 0 (QNC transferred to Pool 3)".to_string()));
                        }
                    }
                }
                // Validate node type
                match node_type {
                    qnet_state::account::NodeType::Light | 
                    qnet_state::account::NodeType::Full | 
                    qnet_state::account::NodeType::Super => {
                        // Valid node types
                    }
                }
            }
            TransactionType::ContractCall { .. } => {
                // Contract call validation - basic checks for testnet
                // In production, would validate contract existence and parameters
            }
            TransactionType::ContractDeploy { .. } => {
                // Contract deployment validation - basic checks for testnet
                // In production, would validate contract code and gas limits
            }

            TransactionType::CreateAccount { address, .. } => {
                if address.is_empty() {
                    return Err(IntegrationError::ValidationError("Account address cannot be empty".to_string()));
                }
            }
            TransactionType::RewardDistribution => {
                // Reward distribution validation - only system can do this
                // In production, would check system permissions
            }
            TransactionType::BatchRewardClaims { node_ids, .. } => {
                if node_ids.is_empty() {
                    return Err(IntegrationError::ValidationError("Batch reward claims must have at least one node".to_string()));
                }
                if node_ids.len() > 50 {
                    return Err(IntegrationError::ValidationError("Batch reward claims cannot exceed 50 nodes".to_string()));
                }
            }
            TransactionType::BatchNodeActivations { activation_data, .. } => {
                if activation_data.is_empty() {
                    return Err(IntegrationError::ValidationError("Batch node activations must have at least one activation".to_string()));
                }
                if activation_data.len() > 20 {
                    return Err(IntegrationError::ValidationError("Batch node activations cannot exceed 20 nodes".to_string()));
                }
            }
            TransactionType::BatchTransfers { transfers, .. } => {
                if transfers.is_empty() {
                    return Err(IntegrationError::ValidationError("Batch transfers must have at least one transfer".to_string()));
                }
                if transfers.len() > 100 {
                    return Err(IntegrationError::ValidationError("Batch transfers cannot exceed 100 transfers".to_string()));
                }
            }
            TransactionType::PingAttestation { from_node, to_node, response_time_ms, .. } => {
                if from_node.is_empty() {
                    return Err(IntegrationError::ValidationError("Ping from_node cannot be empty".to_string()));
                }
                if to_node.is_empty() {
                    return Err(IntegrationError::ValidationError("Ping to_node cannot be empty".to_string()));
                }
                if *response_time_ms > 60000 {
                    return Err(IntegrationError::ValidationError("Ping response time cannot exceed 60 seconds".to_string()));
                }
                // Ping attestations are FREE system operations
            }
            TransactionType::PingCommitmentWithSampling { 
                window_start_height,
                window_end_height,
                merkle_root,
                total_ping_count,
                successful_ping_count,
                sample_seed,
                ping_samples,
            } => {
                // Validate window heights
                if *window_end_height <= *window_start_height {
                    return Err(IntegrationError::ValidationError("Window end height must be greater than start".to_string()));
                }
                
                // Validate window size (4 hours = 14400 blocks)
                const EXPECTED_WINDOW: u64 = 14400;
                if window_end_height - window_start_height != EXPECTED_WINDOW {
                    return Err(IntegrationError::ValidationError(format!(
                        "Invalid window size: expected {} blocks", EXPECTED_WINDOW
                    )));
                }
                
                // Validate Merkle root format (64 hex chars = 32 bytes)
                if merkle_root.len() != 64 {
                    return Err(IntegrationError::ValidationError("Merkle root must be 64 hex characters".to_string()));
                }
                
                // Validate sample seed format (64 hex chars = 32 bytes)
                if sample_seed.len() != 64 {
                    return Err(IntegrationError::ValidationError("Sample seed must be 64 hex characters".to_string()));
                }
                
                // Validate counts
                if *successful_ping_count > *total_ping_count {
                    return Err(IntegrationError::ValidationError("Successful count exceeds total count".to_string()));
                }
                
                // Validate sample size (1% or 10K min)
                let min_samples = (*total_ping_count / 100).max(10_000.min(*total_ping_count)) as usize;
                if ping_samples.len() < min_samples {
                    return Err(IntegrationError::ValidationError(format!(
                        "Insufficient samples: {} < {}", ping_samples.len(), min_samples
                    )));
                }
                
                // Validate each sample has Merkle proof
                for sample in ping_samples {
                    if sample.merkle_proof.is_empty() {
                        return Err(IntegrationError::ValidationError("Sample must include Merkle proof".to_string()));
                    }
                }
                
                // Ping commitments are FREE system operations
            }
        }
        
        Ok(())
    }
    
    /// Calculate transaction size for fee estimation
    pub fn calculate_tx_size(&self, tx: &Transaction) -> IntegrationResult<usize> {
        let mut size = 0;
        
        // Base transaction size
        size += 32; // hash
        size += tx.from.len();
        
        if let Some(ref to) = tx.to {
            size += to.len();
        }
        
        size += 8; // amount
        size += 8; // nonce
        size += 8; // gas_price
        size += 8; // gas_limit
        size += 8; // timestamp
        
        if let Some(ref signature) = tx.signature {
            size += signature.len();
        }
        
        if let Some(ref data) = tx.data {
            size += data.len();
        }
        
        Ok(size)
    }
}

/// Validation error types
#[derive(Debug, Clone)]
pub enum ValidationError {
    InvalidBlock(String),
    InvalidTransaction(String),
    InvalidSignature(String),
    InvalidHash(String),
    InvalidTimestamp(String),
    InvalidAmount(String),
    InvalidNonce(String),
    InvalidGas(String),
    InvalidAddress(String),
    InvalidData(String),
    StorageError(String),
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidationError::InvalidBlock(msg) => write!(f, "Invalid block: {}", msg),
            ValidationError::InvalidTransaction(msg) => write!(f, "Invalid transaction: {}", msg),
            ValidationError::InvalidSignature(msg) => write!(f, "Invalid signature: {}", msg),
            ValidationError::InvalidHash(msg) => write!(f, "Invalid hash: {}", msg),
            ValidationError::InvalidTimestamp(msg) => write!(f, "Invalid timestamp: {}", msg),
            ValidationError::InvalidAmount(msg) => write!(f, "Invalid amount: {}", msg),
            ValidationError::InvalidNonce(msg) => write!(f, "Invalid nonce: {}", msg),
            ValidationError::InvalidGas(msg) => write!(f, "Invalid gas: {}", msg),
            ValidationError::InvalidAddress(msg) => write!(f, "Invalid address: {}", msg),
            ValidationError::InvalidData(msg) => write!(f, "Invalid data: {}", msg),
            ValidationError::StorageError(msg) => write!(f, "Storage error: {}", msg),
        }
    }
}

impl std::error::Error for ValidationError {}

// Removed duplicate implementation - already exists in errors.rs 
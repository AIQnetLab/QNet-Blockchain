//!
//! DEPRECATED v3.35: This module is NOT used in the production validation path!
//!
//! Production validation is handled by:
//! - `node.rs::submit_transaction()` -- for RPC-submitted TXs
//! - `node.rs::validate_and_add_network_transaction()` -- for gossip-received TXs
//! - `transaction.rs::validate()` -- canonical per-TX validation
//! - `transaction.rs::apply_to_state()` -- deterministic state transition
//!
//! This file contains legacy validation helpers that may be used for testing
//! or future offline validation tools. Do NOT call from production hot path.
//!

use std::sync::Arc;
use crate::errors::{IntegrationError, IntegrationResult};
use crate::storage::PersistentStorage;
use qnet_state::{Block, Transaction, TransactionType};
use sha3::{Sha3_256, Digest};

/// DEPRECATED: Block and transaction validator (not used in production)
#[deprecated(since = "3.35.0", note = "Use node.rs validation path instead")]
pub struct BlockValidator {
    /// Storage for validation against historical data
    storage: Option<Arc<PersistentStorage>>,
}

#[allow(deprecated)]
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
        
        // Validate Ed25519 signature if present
        if let Some(ref signature) = tx.signature {
            self.validate_signature(tx, signature)?;
        }
        
        // QUANTUM v2.25: Validate Dilithium signature if present
        // This is OPTIONAL - TX can have Ed25519 only, or Ed25519 + Dilithium
        if tx.dilithium_signature.is_some() {
            if !self.verify_quantum_signature(tx)? {
                return Err(IntegrationError::ValidationError(
                    "Invalid Dilithium signature - quantum verification failed".to_string()
                ));
            }
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
    
    /// PRODUCTION v2.78: Verify transaction signature (Ed25519 or Hybrid ONLY)
    /// ARCHITECTURE: Two signature types for optimal balance:
    /// - Ed25519: Fast, classical (64 bytes, standard gas)
    /// - Hybrid: Quantum-resistant, Ed25519+Dilithium (~2.6KB, +50% gas)
    fn verify_ed25519_signature(&self, tx: &Transaction, signature_hex: &str) -> IntegrationResult<bool> {
        // PRODUCTION: Support TWO signature formats only
        // v2.24: Prioritize binary formats (bincode+zstd)
        if signature_hex.starts_with("hybrid_bin:") {
            // OPTIMIZED v2.24: Binary hybrid signature (bincode+zstd)
            self.verify_hybrid_binary_signature(tx, signature_hex)
        } else if signature_hex.starts_with("hybrid:") {
            // Legacy: Node hybrid signature JSON (with certificate)
            self.verify_hybrid_signature(tx, signature_hex)
        } else {
            // Ed25519 signature - requires public_key in transaction
            // PRODUCTION: Classical signature (64 bytes, fast verification)
            self.verify_ed25519_with_pubkey(tx, signature_hex)
        }
    }
    
    /// QUANTUM v2.25: Verify optional Dilithium signature for quantum-resistant TX
    /// Returns Ok(true) if Dilithium signature is valid
    /// Returns Ok(false) if Dilithium signature is present but invalid
    /// Returns Ok(true) if no Dilithium signature (quantum signature is optional)
    pub fn verify_quantum_signature(&self, tx: &Transaction) -> IntegrationResult<bool> {
        // QUANTUM v2.25: Check if transaction has Dilithium signature
        let dilithium_sig = match &tx.dilithium_signature {
            Some(sig) if !sig.is_empty() => sig,
            _ => return Ok(true), // No quantum signature - that's OK, it's optional
        };
        
        let dilithium_pubkey = match &tx.dilithium_public_key {
            Some(pk) if !pk.is_empty() => pk,
            _ => return Err(IntegrationError::ValidationError(
                "Dilithium signature present but missing dilithium_public_key".to_string()
            )),
        };
        
        if crate::node::is_info() {
            println!("[INFO][VALIDATOR] mldsa65_verify from={}", tx.from);
        }

        // Decode signature (ML-DSA-65 / FIPS 204: 3309 bytes)
        let sig_bytes = hex::decode(dilithium_sig)
            .map_err(|e| IntegrationError::ValidationError(format!("sig_hex_decode_failed err={}", e)))?;

        // Decode public key (ML-DSA-65: 1952 bytes)
        let pubkey_bytes = hex::decode(dilithium_pubkey)
            .map_err(|e| IntegrationError::ValidationError(format!("pk_hex_decode_failed err={}", e)))?;

        // ML-DSA-65 (FIPS 204) sizes: SIG=3309 (CTILDEBYTES=48), PK=1952
        const MLDSA65_SIG_SIZE: usize = 3309;
        const MLDSA65_PK_SIZE: usize = 1952;

        if sig_bytes.len() != MLDSA65_SIG_SIZE {
            return Err(IntegrationError::ValidationError(format!(
                "mldsa65_sig_size_invalid got={} expected={}", sig_bytes.len(), MLDSA65_SIG_SIZE
            )));
        }

        if pubkey_bytes.len() != MLDSA65_PK_SIZE {
            return Err(IntegrationError::ValidationError(format!(
                "mldsa65_pk_size_invalid got={} expected={}", pubkey_bytes.len(), MLDSA65_PK_SIZE
            )));
        }

        // Create message to verify (same as Ed25519)
        let message = self.create_client_signing_message(tx)?;

        // PRODUCTION: ML-DSA-65 (FIPS 204) verification
        use pqcrypto_mldsa::mldsa65::{verify_detached_signature, PublicKey, DetachedSignature};
        use pqcrypto_traits::sign::PublicKey as _;
        use pqcrypto_traits::sign::DetachedSignature as _;

        let pk = PublicKey::from_bytes(&pubkey_bytes)
            .map_err(|_| IntegrationError::ValidationError("mldsa65_pk_parse_failed".to_string()))?;

        let sig = DetachedSignature::from_bytes(&sig_bytes)
            .map_err(|_| IntegrationError::ValidationError("mldsa65_sig_parse_failed".to_string()))?;

        match verify_detached_signature(&sig, &message, &pk) {
            Ok(_) => {
                if crate::node::is_info() {
                    println!("[INFO][VALIDATOR] mldsa65_verified from={}", tx.from);
                }
                Ok(true)
            }
            Err(_) => {
                eprintln!("[ERR][VALIDATOR] mldsa65_verify_failed from={}", tx.from);
                Ok(false)
            }
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
        
        let verifying_key = VerifyingKey::from_bytes(&pubkey_bytes.try_into().expect("Length checked above"))
            .map_err(|e| IntegrationError::ValidationError(format!("Invalid Ed25519 public key: {}", e)))?;
        
        // Decode signature (64 bytes)
        let sig_bytes = hex::decode(signature_hex)
            .map_err(|e| IntegrationError::ValidationError(format!("Invalid signature hex: {}", e)))?;
        
        if sig_bytes.len() != 64 {
            return Err(IntegrationError::ValidationError("Invalid Ed25519 signature length (expected 64 bytes)".to_string()));
        }
        
        let signature = Signature::from_bytes(&sig_bytes.try_into().expect("Length checked above"));
        
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
    
    /// OPTIMIZED v2.24: Verify hybrid BINARY signature (bincode+zstd)
    fn verify_hybrid_binary_signature(&self, tx: &Transaction, signature_hex: &str) -> IntegrationResult<bool> {
        use crate::hybrid_crypto::{HybridSignature, HybridCrypto};
        use base64::{Engine as _, engine::general_purpose};
        
        // Parse binary signature: "hybrid_bin:<base64_bincode_zstd>"
        let base64_data = &signature_hex[11..]; // Skip "hybrid_bin:" prefix
        let binary_data = general_purpose::STANDARD.decode(base64_data)
            .map_err(|e| IntegrationError::ValidationError(format!("Invalid base64 in hybrid_bin: {}", e)))?;
        
        let hybrid_sig: HybridSignature = HybridSignature::from_binary_compressed(&binary_data)
            .map_err(|e| IntegrationError::ValidationError(format!("Invalid binary hybrid signature: {}", e)))?;
        
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
                    println!("[VALIDATOR] ✅ Binary hybrid signature verified (v2.24 bincode)");
                } else {
                    println!("[VALIDATOR] ❌ Invalid binary hybrid signature");
                }
                Ok(valid)
            }
            Err(e) => {
                println!("[VALIDATOR] ⚠️ Binary hybrid verification error: {}", e);
                Ok(false)
            }
        }
    }
    
    /// LEGACY: Verify hybrid JSON signature (O(1) performance with caching)
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
    #[allow(dead_code)]
    fn verify_dilithium_signature(&self, tx: &Transaction, signature_hex: &str) -> IntegrationResult<bool> {
        use crate::quantum_crypto::DilithiumSignature;
        
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
            // PRODUCTION v2.50: Lock-free quantum crypto
            use crate::node::try_get_quantum_crypto;
            
            let crypto = match try_get_quantum_crypto() {
                Some(c) => c,
                None => return Err(anyhow::anyhow!("Quantum crypto not initialized")),
            };
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
                
                // SECURITY v2.78: Validate each sample and verify Merkle proofs
                for sample in ping_samples {
                    // Validate Light node ID format
                    if sample.from_node.is_empty() {
                        return Err(IntegrationError::ValidationError("Sample from_node cannot be empty".to_string()));
                    }
                    if !sample.from_node.starts_with("light_") {
                        return Err(IntegrationError::ValidationError(format!("Invalid Light node ID format: {}", sample.from_node)));
                    }
                    
                    // Validate Merkle proof is present
                    if sample.merkle_proof.is_empty() {
                        return Err(IntegrationError::ValidationError("Sample must include Merkle proof".to_string()));
                    }
                    
                    // CRITICAL: Verify Merkle proof cryptographically
                    // Reconstruct ping hash and verify it's in Merkle tree
                    use blake3::Hasher as Blake3Hasher;
                    let mut hasher = Blake3Hasher::new();
                    hasher.update(sample.from_node.as_bytes());
                    hasher.update(&sample.timestamp.to_le_bytes());
                    hasher.update(sample.to_node.as_bytes());
                    let hash = hasher.finalize();
                    let ping_hash = hash.to_hex().to_string();
                    
                    // Verify Merkle proof
                    let merkle_valid = qnet_core::crypto::merkle::verify_merkle_proof(
                        &ping_hash,
                        merkle_root,
                        &sample.merkle_proof
                    );
                    
                    if !merkle_valid {
                        return Err(IntegrationError::ValidationError(format!(
                            "Invalid Merkle proof for Light node {}", sample.from_node
                        )));
                    }
                }
                
                // Ping commitments are FREE system operations
            }
            TransactionType::HeartbeatCommitment {
                node_id,
                window_start_height,
                window_end_height,
                merkle_root,
                heartbeat_count,
                sample_seed,
                heartbeat_samples,
                ..
            } => {
                // Validate node_id format
                if node_id.is_empty() {
                    return Err(IntegrationError::ValidationError("Node ID cannot be empty".to_string()));
                }
                // v3.18: Full nodes removed
                if !node_id.starts_with("light_") 
                    && !node_id.starts_with("super_") && !node_id.starts_with("genesis_node_") {
                    return Err(IntegrationError::ValidationError(format!("Invalid node_id format: {} (Full node type removed in v3.18)", node_id)));
                }
                
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
                if merkle_root.len() != 64 || !merkle_root.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err(IntegrationError::ValidationError("Merkle root must be 64 hex characters".to_string()));
                }
                
                // Validate sample seed format (64 hex chars = 32 bytes)
                if sample_seed.len() != 64 {
                    return Err(IntegrationError::ValidationError("Sample seed must be 64 hex characters".to_string()));
                }
                
                // Validate heartbeat_count (0-10)
                if *heartbeat_count > 10 {
                    return Err(IntegrationError::ValidationError("Heartbeat count cannot exceed 10".to_string()));
                }
                
                // Validate sample size (20-30% of heartbeat_count, minimum 1)
                if *heartbeat_count > 0 {
                    let min_samples = ((*heartbeat_count as usize * 20) / 100).max(1);
                    let max_samples = ((*heartbeat_count as usize * 30) / 100).max(1);
                    if heartbeat_samples.len() < min_samples || heartbeat_samples.len() > max_samples {
                        return Err(IntegrationError::ValidationError(format!(
                            "Invalid sample size: got {}, expected {}-{}",
                            heartbeat_samples.len(), min_samples, max_samples
                        )));
                    }
                }
                
                // Validate each sample
                for sample in heartbeat_samples {
                    if sample.heartbeat_index >= 10 {
                        return Err(IntegrationError::ValidationError("Heartbeat index must be 0-9".to_string()));
                    }
                    if sample.signature.is_empty() {
                        return Err(IntegrationError::ValidationError("Sample signature cannot be empty".to_string()));
                    }
                    if sample.merkle_proof.is_empty() {
                        return Err(IntegrationError::ValidationError("Sample must include Merkle proof".to_string()));
                    }
                    
                    // SECURITY v2.77: Pre-validation of sample data format
                    // Full cryptographic verification (Dilithium + Merkle proof) happens in node.rs
                    // during MacroBlock creation when collecting commitments from blockchain
                    
                    // Layer 1 (here): Format validation
                    // Layer 2 (node.rs): Dilithium signature verification
                    // Layer 3 (node.rs): Merkle proof verification against merkle_root
                    
                    // Validate signature format (must be hybrid_p2p_bin or similar)
                    if !sample.signature.starts_with("hybrid_p2p_bin:") 
                        && !sample.signature.starts_with("hybrid_p2p:")
                        && !sample.signature.starts_with("compact_bin:") {
                        return Err(IntegrationError::ValidationError(
                            format!("Invalid signature format for sample {}", sample.heartbeat_index)
                        ));
                    }
                }
                
                // Heartbeat commitments are FREE system operations
            }
            TransactionType::Swap { from, token_in, token_out, amount_in, amount_out_min, pool_address, .. } => {
                // v2.50.0: DEX Swap transaction validation
                if from.is_empty() {
                    return Err(IntegrationError::ValidationError("Swap from address cannot be empty".to_string()));
                }
                if token_in.is_empty() || token_out.is_empty() {
                    return Err(IntegrationError::ValidationError("Swap token identifiers cannot be empty".to_string()));
                }
                if token_in == token_out {
                    return Err(IntegrationError::ValidationError("Cannot swap token for itself".to_string()));
                }
                if *amount_in == 0 {
                    return Err(IntegrationError::ValidationError("Swap amount must be greater than 0".to_string()));
                }
                if pool_address.is_empty() {
                    return Err(IntegrationError::ValidationError("DEX pool address cannot be empty".to_string()));
                }
                // amount_out_min can be 0 (no slippage protection - risky but allowed)
                let _ = amount_out_min; // Explicitly mark as intentionally unused here
                // v3.18: Gas fee goes directly to block producer (Pool 2 removed)
            }
            TransactionType::NodeRegistration { node_id, wallet_address, .. } => {
                // v2.73: On-chain node registration validation
                if node_id.is_empty() {
                    return Err(IntegrationError::ValidationError("Node ID cannot be empty".to_string()));
                }
                if wallet_address.is_empty() {
                    return Err(IntegrationError::ValidationError("Wallet address cannot be empty".to_string()));
                }
                // System transaction - no gas fees
            }
            TransactionType::NodeReactivation { node_id, current_height, last_macroblock_hash, last_macroblock_index } => {
                // v9.4: Node reactivation validation
                if node_id.is_empty() {
                    return Err(IntegrationError::ValidationError("NodeReactivation: node_id cannot be empty".to_string()));
                }
                if !node_id.starts_with("super_") && !node_id.starts_with("genesis_node_") {
                    return Err(IntegrationError::ValidationError(
                        format!("NodeReactivation: only Super/Genesis nodes can reactivate, got: {}", node_id)
                    ));
                }
                if last_macroblock_hash.is_empty() || last_macroblock_hash.len() < 16 {
                    return Err(IntegrationError::ValidationError("NodeReactivation: invalid macroblock hash".to_string()));
                }
                if *current_height == 0 {
                    return Err(IntegrationError::ValidationError("NodeReactivation: current_height must be > 0".to_string()));
                }
                // System transaction - no gas fees
                let _ = last_macroblock_index; // used in dedup check at state level
            }
            TransactionType::LightNodeEligibilityBitmap { genesis_id, total_assigned, eligible_count, .. } => {
                // v2.89: Light Node Eligibility Bitmap validation
                if !genesis_id.starts_with("genesis_node_") {
                    return Err(IntegrationError::ValidationError(
                        format!("Invalid genesis_id format: {}", genesis_id)
                    ));
                }
                if *eligible_count > *total_assigned {
                    return Err(IntegrationError::ValidationError(
                        format!("eligible_count ({}) exceeds total_assigned ({})", eligible_count, total_assigned)
                    ));
                }
                // System transaction from Genesis - no gas fees
            }
            TransactionType::KeyRotation { node_id, .. } => {
                // Key rotation validation - system operation similar to NodeRegistration
                if node_id.is_empty() {
                    return Err(IntegrationError::ValidationError("KeyRotation: node_id cannot be empty".to_string()));
                }
                // System transaction - no gas fees
            }
            TransactionType::SetPQRequirement {} => {
                // No payload to validate at type level. Cryptographic enforcement
                // (dual Ed25519 + Dilithium3 signatures present) is performed at
                // apply time inside `transaction.rs::apply_to_state`. The TX-level
                // signature batch verifier in block_pipeline already verifies
                // the Ed25519 sig; the Dilithium3 sig is verified in the same
                // pipeline stage before this validator is consulted.
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
//! QNet Hybrid VRF Implementation
//! Quantum-resistant Verifiable Random Function using hybrid cryptography
//! Combines CRYSTALS-Dilithium certificates with Ed25519 for performance

use crate::hybrid_crypto::{HybridCrypto, HybridSignature};
use sha3::{Sha3_512, Digest};  // Use SHA3 for quantum resistance, not SHA512
use anyhow::{Result, anyhow};

/// VRF output with quantum-resistant proof
#[derive(Debug, Clone)]
pub struct HybridVrfOutput {
    /// The random output value (32 bytes)
    pub output: [u8; 32],
    /// The hybrid VRF proof (certificate + signature)
    pub proof: HybridSignature,
}

/// Hybrid VRF implementation using Dilithium + Ed25519
pub struct QNetHybridVrf {
    /// Hybrid crypto instance for this node
    hybrid_crypto: Option<HybridCrypto>,
    /// Node ID
    node_id: String,
}

impl QNetHybridVrf {
    /// Create new hybrid VRF instance
    pub fn new(node_id: String) -> Self {
        Self { 
            hybrid_crypto: None,
            node_id,
        }
    }
    
    /// Initialize with hybrid cryptography
    pub async fn initialize(&mut self) -> Result<()> {
        println!("[VRF] 🔐 Initializing quantum-resistant hybrid VRF for node: {}", self.node_id);
        
        let mut hybrid = HybridCrypto::new(self.node_id.clone());
        hybrid.initialize().await?;
        
        self.hybrid_crypto = Some(hybrid);
        println!("[VRF] ✅ Hybrid VRF initialized with Dilithium certificate");
        Ok(())
    }
    
    /// Generate VRF output with quantum-resistant proof
    pub async fn evaluate(&mut self, input: &[u8]) -> Result<HybridVrfOutput> {
        let hybrid = self.hybrid_crypto.as_mut()
            .ok_or_else(|| anyhow!("Hybrid VRF not initialized"))?;
        
        // Check if certificate needs rotation
        if hybrid.needs_rotation() {
            // Note: In production, this should be async
            println!("[VRF] 🔄 Certificate needs rotation (synchronous fallback)");
        }
        
        // Step 1: Hash input to create VRF message (quantum-resistant SHA3)
        let mut hasher = Sha3_512::new();
        hasher.update(b"QNet_Hybrid_VRF_v2");
        hasher.update(input);
        let vrf_message = hasher.finalize();
        
        // Step 2: Sign with hybrid signature (Dilithium certificate + Ed25519)
        let hybrid_signature = hybrid.sign_message(&vrf_message).await?;
        
        // Step 3: Hash signature to get VRF output (quantum-resistant SHA3)
        let mut output_hasher = Sha3_512::new();
        output_hasher.update(b"QNet_VRF_Output_v2");
        output_hasher.update(&hybrid_signature.message_signature);
        output_hasher.update(&hybrid_signature.certificate.serial_number.as_bytes());
        let output_hash = output_hasher.finalize();
        
        // Take first 32 bytes as output
        let mut output = [0u8; 32];
        output.copy_from_slice(&output_hash[..32]);
        
        Ok(HybridVrfOutput {
            output,
            proof: hybrid_signature,
        })
    }
    
    /// Verify VRF proof with quantum-resistant verification
    pub async fn verify(
        input: &[u8],
        vrf_output: &HybridVrfOutput,
    ) -> Result<bool> {
        // Step 1: Recreate VRF message (quantum-resistant SHA3)
        let mut hasher = Sha3_512::new();
        hasher.update(b"QNet_Hybrid_VRF_v2");
        hasher.update(input);
        let vrf_message = hasher.finalize();
        
        // Step 2: Verify hybrid signature (this checks Dilithium certificate)
        let signature_valid = HybridCrypto::verify_signature(
            &vrf_message,
            &vrf_output.proof
        ).await?;
        
        if !signature_valid {
            return Ok(false);
        }
        
        // Step 3: Recreate output from signature (quantum-resistant SHA3)
        let mut output_hasher = Sha3_512::new();
        output_hasher.update(b"QNet_VRF_Output_v2");
        output_hasher.update(&vrf_output.proof.message_signature);
        output_hasher.update(&vrf_output.proof.certificate.serial_number.as_bytes());
        let output_hash = output_hasher.finalize();
        
        // Verify output matches
        let mut expected_output = [0u8; 32];
        expected_output.copy_from_slice(&output_hash[..32]);
        
        Ok(expected_output == vrf_output.output)
    }
}

/// Use hybrid VRF for quantum-resistant producer selection
pub async fn select_producer_with_hybrid_vrf(
    round: u64,
    candidates: &[(String, f64)],
    node_id: &str,
    entropy: &[u8],
) -> Result<(String, HybridVrfOutput)> {
    if candidates.is_empty() {
        return Err(anyhow!("No candidates available"));
    }
    
    // Initialize hybrid VRF
    let mut vrf = QNetHybridVrf::new(node_id.to_string());
    vrf.initialize().await?;
    
    // Create VRF input from round, entropy, and candidates
    let mut vrf_input = Vec::new();
    vrf_input.extend_from_slice(b"QNet_Producer_Selection_v2");
    vrf_input.extend_from_slice(&round.to_le_bytes());
    vrf_input.extend_from_slice(entropy);
    
    // Include all candidates to ensure consistency
    for (candidate_id, reputation) in candidates {
        vrf_input.extend_from_slice(candidate_id.as_bytes());
        vrf_input.extend_from_slice(&reputation.to_le_bytes());
    }
    
    // Generate VRF output with quantum-resistant proof
    let vrf_output = vrf.evaluate(&vrf_input).await?;
    
    // Convert VRF output to selection index
    let selection_number = u64::from_le_bytes([
        vrf_output.output[0], vrf_output.output[1], vrf_output.output[2], vrf_output.output[3],
        vrf_output.output[4], vrf_output.output[5], vrf_output.output[6], vrf_output.output[7],
    ]);
    
    let selection_index = (selection_number as usize) % candidates.len();
    let selected_producer = candidates[selection_index].0.clone();
    
    println!("[VRF] 🎲 Quantum-resistant producer selected: {} (index {} of {})", 
             selected_producer, selection_index, candidates.len());
    println!("[VRF] 🔐 Certificate: {}", vrf_output.proof.certificate.serial_number);
    println!("[VRF] ✅ Proof: Dilithium-signed Ed25519 signature");
    
    Ok((selected_producer, vrf_output))
}

/// Fallback to original VRF if hybrid not available
pub async fn select_producer_with_vrf_fallback(
    round: u64,
    candidates: &[(String, f64)],
    node_id: &str,
    entropy: &[u8],
) -> Result<String> {
    // Try hybrid VRF first
    match select_producer_with_hybrid_vrf(round, candidates, node_id, entropy).await {
        Ok((producer, _)) => {
            println!("[VRF] ✅ Using quantum-resistant hybrid VRF");
            Ok(producer)
        }
        Err(e) => {
            println!("[VRF] ⚠️ Hybrid VRF failed: {}, using legacy VRF", e);
            // Fallback to legacy VRF
            match crate::vrf::select_producer_with_vrf(round, candidates, node_id, entropy).await {
                Ok((producer, _)) => Ok(producer),
                Err(e) => Err(anyhow!("Both hybrid and legacy VRF failed: {}", e))
            }
        }
    }
}

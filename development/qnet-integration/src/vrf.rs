// QNet Verifiable Random Function (VRF) Implementation
// Based on Ed25519 without OpenSSL dependencies
// Provides cryptographically secure, verifiable randomness for producer selection

use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier};
use sha3::{Sha3_512, Digest};
use std::convert::TryFrom;

/// VRF output with proof for verification
#[derive(Debug, Clone)]
pub struct VrfOutput {
    /// The random output value (32 bytes)
    pub output: [u8; 32],
    /// The VRF proof (signature)
    pub proof: Vec<u8>,
}

/// VRF implementation using Ed25519
pub struct QNetVrf {
    signing_key: Option<SigningKey>,
    verifying_key: Option<VerifyingKey>,
}

impl QNetVrf {
    /// Create new VRF instance
    pub fn new() -> Self {
        Self { 
            signing_key: None,
            verifying_key: None,
        }
    }
    
    /// Initialize with node's private key
    /// In production, this would load from secure storage or HSM
    pub fn initialize(&mut self, node_id: &str) -> Result<(), String> {
        // Derive key from node ID and environment variable
        // In production, use proper key management
        let secret_seed = Self::derive_secret_seed(node_id)?;
        
        // Create Ed25519 signing key from seed
        let signing_key = SigningKey::from_bytes(&secret_seed);
        let verifying_key = signing_key.verifying_key();
        
        self.signing_key = Some(signing_key);
        self.verifying_key = Some(verifying_key);
        Ok(())
    }
    
    /// Generate VRF output with proof for given input
    /// This is the main VRF evaluation function
    pub fn evaluate(&self, input: &[u8]) -> Result<VrfOutput, String> {
        let signing_key = self.signing_key.as_ref()
            .ok_or_else(|| "VRF not initialized".to_string())?;
        
        // Step 1: Hash input to curve point (hash-to-point)
        // We use SHA3-512 for quantum resistance
        let mut hasher = Sha3_512::new();
        hasher.update(b"QNet_VRF_Hash_To_Point_v1");
        hasher.update(input);
        let hash_to_point = hasher.finalize();
        
        // Step 2: Sign the hash with Ed25519 (this is our VRF proof)
        // The signature serves as cryptographic proof of the VRF computation
        let signature = signing_key.sign(&hash_to_point);
        
        // Step 3: Hash signature to get VRF output
        // This ensures the output is uniformly distributed
        let mut output_hasher = Sha3_512::new();
        output_hasher.update(b"QNet_VRF_Output_v1");
        output_hasher.update(signature.to_bytes());
        let output_hash = output_hasher.finalize();
        
        // Take first 32 bytes as output
        let mut output = [0u8; 32];
        output.copy_from_slice(&output_hash[..32]);
        
        Ok(VrfOutput {
            output,
            proof: signature.to_bytes().to_vec(),
        })
    }
    
    /// Verify VRF proof for given input and output
    /// Anyone can verify with just the public key
    pub fn verify(
        public_key_bytes: &[u8],
        input: &[u8],
        vrf_output: &VrfOutput,
    ) -> Result<bool, String> {
        // Parse verifying key
        if public_key_bytes.len() != 32 {
            return Err("Invalid public key length".to_string());
        }
        let mut key_array = [0u8; 32];
        key_array.copy_from_slice(public_key_bytes);
        let verifying_key = VerifyingKey::from_bytes(&key_array)
            .map_err(|e| format!("Invalid verifying key: {}", e))?;
        
        // Parse signature proof
        if vrf_output.proof.len() != 64 {
            return Err("Invalid signature proof length".to_string());
        }
        let mut sig_bytes = [0u8; 64];
        sig_bytes.copy_from_slice(&vrf_output.proof);
        let signature = Signature::from_bytes(&sig_bytes);
        
        // Step 1: Recreate hash-to-point
        let mut hasher = Sha3_512::new();
        hasher.update(b"QNet_VRF_Hash_To_Point_v1");
        hasher.update(input);
        let hash_to_point = hasher.finalize();
        
        // Step 2: Verify signature
        verifying_key.verify(&hash_to_point, &signature)
            .map_err(|e| format!("Signature verification failed: {}", e))?;
        
        // Step 3: Recreate output from signature
        let mut output_hasher = Sha3_512::new();
        output_hasher.update(b"QNet_VRF_Output_v1");
        output_hasher.update(signature.to_bytes());
        let output_hash = output_hasher.finalize();
        
        // Verify output matches
        let mut expected_output = [0u8; 32];
        expected_output.copy_from_slice(&output_hash[..32]);
        
        Ok(expected_output == vrf_output.output)
    }
    
    /// Get public key for this VRF instance
    pub fn get_public_key(&self) -> Option<Vec<u8>> {
        self.verifying_key.as_ref().map(|vk| vk.to_bytes().to_vec())
    }
    
    /// Derive secret seed from node ID and environment
    /// In production, use secure key management
    fn derive_secret_seed(node_id: &str) -> Result<[u8; 32], String> {
        // Try to get from environment variable first
        let env_key = std::env::var("QNET_NODE_PRIVATE_KEY")
            .unwrap_or_else(|_| format!("NODE_KEY_{}", node_id));
        
        // Derive 32-byte seed using SHA3-512
        let mut hasher = Sha3_512::new();
        hasher.update(b"QNet_VRF_Seed_Derivation_v1");
        hasher.update(env_key.as_bytes());
        hasher.update(node_id.as_bytes());
        
        let hash = hasher.finalize();
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&hash[..32]);
        
        Ok(seed)
    }
}

/// Use VRF for producer selection
pub async fn select_producer_with_vrf(
    round: u64,
    candidates: &[(String, f64)],
    node_id: &str,
    entropy: &[u8],
) -> Result<(String, VrfOutput), String> {
    if candidates.is_empty() {
        return Err("No candidates available".to_string());
    }
    
    // Initialize VRF for this node
    let mut vrf = QNetVrf::new();
    vrf.initialize(node_id)?;
    
    // Create VRF input from round, entropy, and candidates
    let mut vrf_input = Vec::new();
    vrf_input.extend_from_slice(b"QNet_Producer_Selection_v1");
    vrf_input.extend_from_slice(&round.to_le_bytes());
    vrf_input.extend_from_slice(entropy);
    
    // Include all candidates to ensure consistency
    for (candidate_id, reputation) in candidates {
        vrf_input.extend_from_slice(candidate_id.as_bytes());
        vrf_input.extend_from_slice(&reputation.to_le_bytes());
    }
    
    // Generate VRF output
    let vrf_output = vrf.evaluate(&vrf_input)?;
    
    // Convert VRF output to selection index
    let selection_number = u64::from_le_bytes([
        vrf_output.output[0], vrf_output.output[1], vrf_output.output[2], vrf_output.output[3],
        vrf_output.output[4], vrf_output.output[5], vrf_output.output[6], vrf_output.output[7],
    ]);
    
    let selection_index = (selection_number as usize) % candidates.len();
    let selected_producer = candidates[selection_index].0.clone();
    
    println!("[VRF] 🎲 Producer selected: {} (index {} of {})", 
             selected_producer, selection_index, candidates.len());
    println!("[VRF] 📝 Proof: {}", hex::encode(&vrf_output.proof[..32])); // Show first 32 bytes
    
    Ok((selected_producer, vrf_output))
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_vrf_deterministic() {
        let mut vrf = QNetVrf::new();
        vrf.initialize("test_node_001").unwrap();
        
        let input = b"test_input";
        let output1 = vrf.evaluate(input).unwrap();
        let output2 = vrf.evaluate(input).unwrap();
        
        // Same input should produce same output
        assert_eq!(output1.output, output2.output);
        assert_eq!(output1.proof, output2.proof);
    }
    
    #[test]
    fn test_vrf_verification() {
        let mut vrf = QNetVrf::new();
        vrf.initialize("test_node_001").unwrap();
        
        let input = b"test_input";
        let output = vrf.evaluate(input).unwrap();
        let public_key = vrf.get_public_key().unwrap();
        
        // Verification should succeed
        let verified = QNetVrf::verify(&public_key, input, &output).unwrap();
        assert!(verified);
        
        // Wrong input should fail
        let wrong_input = b"wrong_input";
        let verified = QNetVrf::verify(&public_key, wrong_input, &output);
        // Should either return false or error - both are valid
        assert!(verified.is_err() || !verified.unwrap());
    }
    
    #[test]
    fn test_vrf_different_nodes() {
        let mut vrf1 = QNetVrf::new();
        vrf1.initialize("node_001").unwrap();
        
        let mut vrf2 = QNetVrf::new();
        vrf2.initialize("node_002").unwrap();
        
        let input = b"same_input";
        let output1 = vrf1.evaluate(input).unwrap();
        let output2 = vrf2.evaluate(input).unwrap();
        
        // Different nodes should produce different outputs
        assert_ne!(output1.output, output2.output);
        assert_ne!(output1.proof, output2.proof);
    }
}

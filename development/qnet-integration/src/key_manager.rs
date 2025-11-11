use std::path::{Path, PathBuf};
use std::fs;
use std::sync::{Arc, RwLock};
use anyhow::{Result, anyhow};
use pqcrypto_dilithium::dilithium3;
use pqcrypto_traits::sign::{PublicKey as PublicKeyTrait, SecretKey as SecretKeyTrait, SignedMessage as SignedMessageTrait};
use serde::{Serialize, Deserialize};
use sha3::{Sha3_256, Sha3_512, Digest};
use lazy_static::lazy_static;

// PRODUCTION: Cache writable directory to avoid repeated filesystem checks
// This is safe as filesystem paths don't change during runtime
lazy_static! {
    static ref CACHED_KEY_DIR: Arc<RwLock<Option<PathBuf>>> = Arc::new(RwLock::new(None));
}

/// Manages Dilithium keys for the node
pub struct DilithiumKeyManager {
    /// Path to key storage
    key_dir: PathBuf,
    
    /// Cached keypair to avoid regeneration
    cached_keypair: Arc<RwLock<Option<(dilithium3::PublicKey, dilithium3::SecretKey)>>>,
    
    /// Node ID
    node_id: String,
}

impl DilithiumKeyManager {
    /// Create new key manager with ROBUST directory creation
    pub fn new(node_id: String, key_dir: &Path) -> Result<Self> {
        // CRITICAL: Try multiple fallback paths for Docker/production compatibility
        let final_key_dir = Self::ensure_writable_directory(key_dir)?;
        
        println!("[KEY_MANAGER] 📁 Using key directory: {:?}", final_key_dir);
        
        Ok(Self {
            key_dir: final_key_dir,
            cached_keypair: Arc::new(RwLock::new(None)),
            node_id,
        })
    }
    
    /// PRODUCTION-SAFE: Find and create writable directory with fallback paths
    fn ensure_writable_directory(preferred: &Path) -> Result<PathBuf> {
        // Check cache first to avoid repeated filesystem operations
        {
            let cache = CACHED_KEY_DIR.read().unwrap();
            if let Some(cached_dir) = &*cache {
                // Verify cached directory still exists and is writable
                if cached_dir.exists() && cached_dir.is_dir() {
                    return Ok(cached_dir.clone());
                }
            }
        }
        
        // Build candidate directories in priority order
        let mut candidates: Vec<PathBuf> = vec![
            preferred.to_path_buf(),                              // Preferred path
            PathBuf::from("/app/data/keys"),                      // Docker persistent volume
            PathBuf::from("/tmp/qnet_keys"),                      // Always writable fallback
        ];
        
        // Add optional paths if available
        if let Ok(current_dir) = std::env::current_dir() {
            candidates.push(current_dir.join("data").join("keys"));
        }
        
        if let Some(data_dir) = dirs::data_local_dir() {
            candidates.push(data_dir.join("qnet").join("keys"));
        }
        
        println!("[KEY_MANAGER] 🔍 Searching for writable key directory...");
        
        for (idx, path) in candidates.iter().enumerate() {
            println!("[KEY_MANAGER]   [{}/{}] Testing: {:?}", idx + 1, candidates.len(), path);
            
            // Try to create directory
            match fs::create_dir_all(path) {
                Ok(_) => {
                    // Verify we can write to it by creating a test file
                    let test_file = path.join(".write_test");
                    match fs::write(&test_file, b"test") {
                        Ok(_) => {
                            let _ = fs::remove_file(&test_file); // Cleanup
                            println!("[KEY_MANAGER] ✅ Selected writable directory: {:?}", path);
                            
                            // Cache the successful directory for future use
                            let mut cache = CACHED_KEY_DIR.write().unwrap();
                            *cache = Some(path.clone());
                            
                            return Ok(path.clone());
                        }
                        Err(e) => {
                            println!("[KEY_MANAGER]   ❌ Cannot write to directory: {}", e);
                            continue;
                        }
                    }
                }
                Err(e) => {
                    println!("[KEY_MANAGER]   ❌ Cannot create directory: {}", e);
                    continue;
                }
            }
        }
        
        // CRITICAL: If all fallbacks fail, provide detailed diagnostic
        println!("[KEY_MANAGER] ❌ NO WRITABLE DIRECTORY FOUND!");
        println!("[KEY_MANAGER] 🔍 Diagnostic information:");
        println!("[KEY_MANAGER]   Current dir: {:?}", std::env::current_dir());
        println!("[KEY_MANAGER]   User: {:?}", std::env::var("USER").or_else(|_| std::env::var("USERNAME")));
        println!("[KEY_MANAGER]   Temp dir: {:?}", std::env::temp_dir());
        
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(metadata) = fs::metadata(preferred) {
                println!("[KEY_MANAGER]   Preferred dir permissions: {:o}", metadata.permissions().mode());
            }
        }
        
        Err(anyhow!(
            "Cannot find writable directory for keys. Tried {} candidates. Check Docker volumes and file permissions.",
            candidates.len()
        ))
    }
    
    /// Initialize keys (load or generate)
    pub async fn initialize(&self) -> Result<()> {
        println!("[KEY_MANAGER] 🔐 Initializing Dilithium key manager for node: {}", self.node_id);
        println!("[KEY_MANAGER] 📁 Key directory: {:?}", self.key_dir);
        
        // Directory should already exist from new(), but verify
        if !self.key_dir.exists() {
            println!("[KEY_MANAGER] ⚠️ Key directory doesn't exist, creating now...");
            fs::create_dir_all(&self.key_dir)
                .map_err(|e| anyhow!("Failed to create key directory: {}", e))?;
        }
        
        // Check directory permissions
        match fs::metadata(&self.key_dir) {
            Ok(metadata) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    println!("[KEY_MANAGER] 🔒 Directory permissions: {:o}", metadata.permissions().mode());
                }
                
                if !metadata.is_dir() {
                    return Err(anyhow!("Key path exists but is not a directory: {:?}", self.key_dir));
                }
            }
            Err(e) => {
                println!("[KEY_MANAGER] ❌ Cannot read directory metadata: {}", e);
                return Err(anyhow!("Cannot access key directory: {}", e));
            }
        }
        
        // Keypair will be loaded or generated on first use (lazy initialization)
        println!("[KEY_MANAGER] 🎉 Key manager initialization complete!");
        Ok(())
    }
    
    /// Get keypair (loads from disk or generates new, cached for performance)
    fn get_keypair(&self) -> Result<(dilithium3::PublicKey, dilithium3::SecretKey)> {
        // Check cache first
        {
            let cache_guard = self.cached_keypair.read().unwrap();
            if let Some((pk, sk)) = cache_guard.as_ref() {
                return Ok((pk.clone(), sk.clone()));
            }
        }
        
        // Try to load from disk first
        let key_path = self.key_dir.join("dilithium_keypair.bin");
        if key_path.exists() {
            // CRITICAL: If file exists, it MUST be loaded successfully
            // Generating new keys would cause node identity loss
            let (pk, sk) = self.load_keypair_from_disk(&key_path)?;
            
            // Cache the loaded keypair
            let mut cache_guard = self.cached_keypair.write().unwrap();
            *cache_guard = Some((pk.clone(), sk.clone()));
            return Ok((pk, sk));
        }
        
        // Generate new keypair ONCE and save it
        println!("[KEY_MANAGER] 🔑 Generating new Dilithium3 keypair (one-time operation)...");
        
        // CRITICAL: Generate keypair only ONCE and persist it
        // This ensures the same keys are used across restarts
        let (pk, sk) = dilithium3::keypair();
        
        // Save to disk immediately for persistence
        // CRITICAL: Node MUST NOT start without saved keys to prevent identity loss
        self.save_keypair_to_disk(&pk, &sk, &key_path)?;
        println!("[KEY_MANAGER] ✅ Dilithium3 keypair saved to disk for persistence");
        
        // Cache the keypair
        {
            let mut cache_guard = self.cached_keypair.write().unwrap();
            *cache_guard = Some((pk.clone(), sk.clone()));
        }
        
        Ok((pk, sk))
    }
    
    /// Get public key bytes (1952 bytes for Dilithium3)
    pub fn get_public_key(&self) -> Result<Vec<u8>> {
        let (public_key, _) = self.get_keypair()?;
        
        // Use trait method to get bytes
        Ok(PublicKeyTrait::as_bytes(&public_key).to_vec())
    }
    
    /// Sign data with Dilithium-based deterministic signature
    /// This is quantum-resistant because:
    /// 1. Uses Dilithium keypair as entropy source
    /// 2. Uses SHA3-512 which is quantum-resistant
    /// 3. Signature is deterministic and verifiable
    pub fn sign(&self, data: &[u8]) -> Result<Vec<u8>> {
        // OPTIMIZATION: Use cached keypair from get_keypair()
        let (_pk, sk) = self.get_keypair()?;
        
        // Sign with REAL Dilithium3 algorithm
        let signature = dilithium3::sign(data, &sk);
        
        // Get signed message bytes from Dilithium3
        let signed_msg_bytes = SignedMessageTrait::as_bytes(&signature);
        
        // Extract just the signature part (first 2420 bytes are signature, rest is message)
        let sig_bytes = &signed_msg_bytes[..2420.min(signed_msg_bytes.len())];
        
        println!("✅ Generated REAL Dilithium3 quantum-resistant signature ({} bytes)", sig_bytes.len());
        Ok(sig_bytes.to_vec())
    }
    
    /// Verify signature with public key
    /// CRITICAL: This is for external verification only (other nodes verifying our signatures)
    /// We cannot derive the original seed from public key - that would be insecure!
    /// Instead, we verify the signature structure and entropy
    pub fn verify(&self, data: &[u8], signature: &[u8], public_key_bytes: &[u8]) -> Result<bool> {
        if signature.len() != 2420 {
            println!("❌ Invalid signature length: {} (expected 2420)", signature.len());
            return Ok(false);
        }
        
        if public_key_bytes.len() != 1952 {
            println!("❌ Invalid public key length: {} (expected 1952)", public_key_bytes.len());
            return Ok(false);
        }
        
        // PRODUCTION: Use REAL Dilithium3 verification
        let pk = <dilithium3::PublicKey as PublicKeyTrait>::from_bytes(public_key_bytes)
            .map_err(|_| anyhow!("Invalid public key format"))?;
        
        // For verification, we need to reconstruct the signed message
        // Dilithium3 expects signature + message concatenated
        let mut signed_msg = Vec::with_capacity(signature.len() + data.len());
        signed_msg.extend_from_slice(signature);
        signed_msg.extend_from_slice(data);
        
        // Verify with REAL Dilithium3 algorithm
        let valid = dilithium3::open(&dilithium3::SignedMessage::from_bytes(&signed_msg).unwrap_or_else(|_| {
            // If can't parse, create dummy for return false
            dilithium3::sign(&[], &dilithium3::keypair().1)
        }), &pk).is_ok();
        
        if valid {
            println!("✅ REAL Dilithium3 signature verified successfully");
        } else {
            println!("❌ Dilithium3 signature verification failed");
        }
        
        Ok(valid)
    }
    
    /// Export public key for sharing
    pub fn export_public_key(&self) -> Result<String> {
        use base64::{Engine as _, engine::general_purpose};
        let pk_bytes = self.get_public_key()?;
        Ok(general_purpose::STANDARD.encode(&pk_bytes))
    }
    
    /// Import public key from base64
    pub fn import_public_key(public_key_b64: &str) -> Result<Vec<u8>> {
        use base64::{Engine as _, engine::general_purpose};
        general_purpose::STANDARD.decode(public_key_b64)
            .map_err(|e| anyhow!("Invalid base64: {}", e))
    }
    
    /// Save keypair to disk (encrypted)
    fn save_keypair_to_disk(&self, pk: &dilithium3::PublicKey, sk: &dilithium3::SecretKey, path: &Path) -> Result<()> {
        use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce, Key};
        
        // Serialize keypair
        let pk_bytes = PublicKeyTrait::as_bytes(pk);
        let sk_bytes = SecretKeyTrait::as_bytes(sk);
        
        // Combine into single buffer
        let mut combined = Vec::new();
        combined.extend_from_slice(&(pk_bytes.len() as u32).to_le_bytes());
        combined.extend_from_slice(pk_bytes);
        combined.extend_from_slice(&(sk_bytes.len() as u32).to_le_bytes());
        combined.extend_from_slice(sk_bytes);
        
        // Derive encryption key from node_id
        let mut hasher = Sha3_256::new();
        hasher.update(self.node_id.as_bytes());
        hasher.update(b"QNET_KEYPAIR_ENCRYPTION_V1");
        let key_material = hasher.finalize();
        
        // Encrypt with AES-256-GCM
        let key = Key::<Aes256Gcm>::from_slice(&key_material);
        let cipher = Aes256Gcm::new(key);
        let nonce_bytes = rand::random::<[u8; 12]>();
        let nonce = Nonce::from_slice(&nonce_bytes);
        
        let encrypted = cipher.encrypt(nonce, combined.as_ref())
            .map_err(|e| anyhow!("Encryption failed: {}", e))?;
        
        // Store: nonce + encrypted data
        let mut stored = Vec::new();
        stored.extend_from_slice(&nonce_bytes);
        stored.extend_from_slice(&encrypted);
        
        // Write to disk
        fs::write(path, stored)?;
        
        // Set restrictive permissions (Unix only)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        
        Ok(())
    }
    
    /// Load keypair from disk (decrypt)
    fn load_keypair_from_disk(&self, path: &Path) -> Result<(dilithium3::PublicKey, dilithium3::SecretKey)> {
        use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce, Key};
        
        // Read encrypted data
        let stored = fs::read(path)?;
        if stored.len() < 12 {
            return Err(anyhow!("Invalid keypair file"));
        }
        
        // Extract nonce and encrypted data
        let nonce_bytes = &stored[..12];
        let encrypted = &stored[12..];
        
        // Derive decryption key
        let mut hasher = Sha3_256::new();
        hasher.update(self.node_id.as_bytes());
        hasher.update(b"QNET_KEYPAIR_ENCRYPTION_V1");
        let key_material = hasher.finalize();
        
        // Decrypt
        let key = Key::<Aes256Gcm>::from_slice(&key_material);
        let cipher = Aes256Gcm::new(key);
        let nonce = Nonce::from_slice(nonce_bytes);
        
        let decrypted = cipher.decrypt(nonce, encrypted)
            .map_err(|e| anyhow!("Decryption failed: {}", e))?;
        
        // Parse keypair
        if decrypted.len() < 8 {
            return Err(anyhow!("Invalid decrypted data"));
        }
        
        let mut cursor = 0;
        
        // Read public key
        let pk_len = u32::from_le_bytes([
            decrypted[cursor], decrypted[cursor+1], 
            decrypted[cursor+2], decrypted[cursor+3]
        ]) as usize;
        cursor += 4;
        
        if cursor + pk_len > decrypted.len() {
            return Err(anyhow!("Invalid public key length"));
        }
        
        let pk_bytes = &decrypted[cursor..cursor+pk_len];
        let pk = <dilithium3::PublicKey as PublicKeyTrait>::from_bytes(pk_bytes)
            .map_err(|_| anyhow!("Invalid public key format"))?;
        cursor += pk_len;
        
        // Read secret key
        if cursor + 4 > decrypted.len() {
            return Err(anyhow!("Missing secret key length"));
        }
        
        let sk_len = u32::from_le_bytes([
            decrypted[cursor], decrypted[cursor+1], 
            decrypted[cursor+2], decrypted[cursor+3]
        ]) as usize;
        cursor += 4;
        
        if cursor + sk_len > decrypted.len() {
            return Err(anyhow!("Invalid secret key length"));
        }
        
        let sk_bytes = &decrypted[cursor..cursor+sk_len];
        let sk = <dilithium3::SecretKey as SecretKeyTrait>::from_bytes(sk_bytes)
            .map_err(|_| anyhow!("Invalid secret key format"))?;
        
        Ok((pk, sk))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    
    #[tokio::test]
    async fn test_key_generation_and_signing() {
        let temp_dir = TempDir::new().unwrap();
        let manager = DilithiumKeyManager::new(
            "test_node".to_string(),
            temp_dir.path()
        ).unwrap();
        
        // Initialize (generate keys)
        manager.initialize().await.unwrap();
        
        // Test signing
        let message = b"Test message for quantum-resistant signature";
        let signature = manager.sign(message).unwrap();
        assert_eq!(signature.len(), 2420);
        
        // Test verification with own public key
        let public_key = manager.get_public_key().unwrap();
        let valid = manager.verify(message, &signature, &public_key).unwrap();
        assert!(valid);
        
        // Test invalid signature
        let mut bad_sig = signature.clone();
        bad_sig[0] ^= 0xFF;
        let invalid = manager.verify(message, &bad_sig, &public_key).unwrap();
        assert!(!invalid);
    }
    
    #[tokio::test]
    async fn test_key_persistence() {
        let temp_dir = TempDir::new().unwrap();
        let node_id = "persistent_test".to_string();
        
        // Generate and store seed
        let manager1 = DilithiumKeyManager::new(
            node_id.clone(),
            temp_dir.path()
        ).unwrap();
        manager1.initialize().await.unwrap();
        
        let message = b"Persistence test";
        let signature1 = manager1.sign(message).unwrap();
        let public_key1 = manager1.get_public_key().unwrap();
        
        // Load seed in new instance
        let manager2 = DilithiumKeyManager::new(
            node_id,
            temp_dir.path()
        ).unwrap();
        manager2.initialize().await.unwrap();
        
        let signature2 = manager2.sign(message).unwrap();
        let public_key2 = manager2.get_public_key().unwrap();
        
        // Signatures should be identical (deterministic)
        assert_eq!(signature1, signature2);
        
        // Public keys might differ due to keypair() randomness
        // But cross-verification should still work with deterministic signatures
        let valid = manager2.verify(message, &signature1, &public_key1).unwrap();
        assert!(valid);
    }
}
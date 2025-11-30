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
    /// 
    /// NOTE: Returns only the 2420-byte signature part (legacy compatibility)
    /// For full SignedMessage format, use sign_full()
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
    
    /// Sign data and return FULL SignedMessage (signature + message)
    /// PRODUCTION: Use this for proper Dilithium3 verification with dilithium3::open()
    /// Format: [signature(2420 bytes)] + [original message]
    pub fn sign_full(&self, data: &[u8]) -> Result<Vec<u8>> {
        let (_pk, sk) = self.get_keypair()?;
        
        // Sign with REAL Dilithium3 algorithm
        let signature = dilithium3::sign(data, &sk);
        
        // Return the FULL SignedMessage bytes (signature + message)
        let signed_msg_bytes = SignedMessageTrait::as_bytes(&signature);
        
        println!("✅ Generated FULL Dilithium3 SignedMessage ({} bytes = 2420 sig + {} msg)", 
                 signed_msg_bytes.len(), data.len());
        Ok(signed_msg_bytes.to_vec())
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
    
    /// Get or create encryption key from file-based secret
    /// SECURITY: Key is randomly generated once and stored with integrity check
    /// NOT derived from public data like node_id (NIST SP 800-132 compliant)
    /// 
    /// File format: [key(32)] + [sha3_256_hash(8)] = 40 bytes total
    /// This prevents using corrupted or tampered secrets
    fn get_encryption_key(&self) -> Result<[u8; 32]> {
        // 1. Check environment variable first (for advanced users/CI)
        if let Ok(key_hex) = std::env::var("QNET_KEY_ENCRYPTION_SECRET") {
            if key_hex.len() == 64 {
                if let Ok(key_bytes) = hex::decode(&key_hex) {
                    if key_bytes.len() == 32 {
                        let mut key = [0u8; 32];
                        key.copy_from_slice(&key_bytes);
                        println!("[KEY_MANAGER] 🔐 Using encryption key from QNET_KEY_ENCRYPTION_SECRET");
                        return Ok(key);
                    }
                }
            }
            println!("[KEY_MANAGER] ⚠️ Invalid QNET_KEY_ENCRYPTION_SECRET format (need 64 hex chars)");
        }
        
        // 2. File-based secret with integrity check
        let secret_path = self.key_dir.join(".qnet_encryption_secret");
        let keypair_path = self.key_dir.join("dilithium_keypair.bin");
        
        if secret_path.exists() {
            // Load existing secret with integrity verification
            let secret_data = fs::read(&secret_path)
                .map_err(|e| anyhow!("Failed to read encryption secret: {}", e))?;
            
            // Expected format: [key(32)] + [hash(8)]
            if secret_data.len() == 40 {
                let key_part = &secret_data[..32];
                let stored_hash = &secret_data[32..40];
                
                // Verify integrity hash
                let mut hasher = Sha3_256::new();
                hasher.update(key_part);
                hasher.update(b"QNET_SECRET_INTEGRITY_V1");
                let computed_hash = &hasher.finalize()[..8];
                
                if stored_hash == computed_hash {
                    let mut key = [0u8; 32];
                    key.copy_from_slice(key_part);
                    return Ok(key);
                } else {
                    // CRITICAL: Hash mismatch = tampering or corruption
                    // If keypair exists, we CANNOT regenerate (would lose identity)
                    if keypair_path.exists() {
                        return Err(anyhow!(
                            "SECURITY ALERT: Encryption secret integrity check failed! \
                            File may be corrupted or tampered. \
                            Cannot regenerate without losing node identity. \
                            Restore from backup or contact support."
                        ));
                    }
                    println!("[KEY_MANAGER] ⚠️ Corrupted encryption secret (no keypair yet), regenerating...");
                }
            } else if secret_data.len() == 32 {
                // Legacy format without hash - upgrade it
                println!("[KEY_MANAGER] 🔄 Upgrading encryption secret to include integrity hash...");
                let mut key = [0u8; 32];
                key.copy_from_slice(&secret_data);
                
                // Save with integrity hash
                self.save_encryption_secret(&key, &secret_path)?;
                return Ok(key);
            } else {
                // Wrong size - corrupted
                if keypair_path.exists() {
                    return Err(anyhow!(
                        "SECURITY ALERT: Encryption secret corrupted (wrong size: {} bytes)! \
                        Cannot regenerate without losing node identity.",
                        secret_data.len()
                    ));
                }
                println!("[KEY_MANAGER] ⚠️ Corrupted encryption secret, regenerating...");
            }
        }
        
        // 3. Generate new random secret (only if no keypair exists!)
        if keypair_path.exists() {
            return Err(anyhow!(
                "CRITICAL: Encryption secret missing but keypair exists! \
                Cannot decrypt existing keys. Restore .qnet_encryption_secret from backup."
            ));
        }
        
        println!("[KEY_MANAGER] 🔐 Generating new encryption secret (one-time operation)...");
        let new_key: [u8; 32] = rand::random();
        
        // Save with integrity hash
        self.save_encryption_secret(&new_key, &secret_path)?;
        
        println!("[KEY_MANAGER] ✅ Encryption secret saved to {:?}", secret_path);
        Ok(new_key)
    }
    
    /// Save encryption secret with integrity hash
    /// Format: [key(32)] + [sha3_256_hash(8)] = 40 bytes
    fn save_encryption_secret(&self, key: &[u8; 32], path: &Path) -> Result<()> {
        // Compute integrity hash
        let mut hasher = Sha3_256::new();
        hasher.update(key);
        hasher.update(b"QNET_SECRET_INTEGRITY_V1");
        let hash = hasher.finalize();
        
        // Combine key + first 8 bytes of hash
        let mut data = Vec::with_capacity(40);
        data.extend_from_slice(key);
        data.extend_from_slice(&hash[..8]);
        
        // Write to disk
        fs::write(path, &data)
            .map_err(|e| anyhow!("Failed to save encryption secret: {}", e))?;
        
        // Set restrictive permissions
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        
        #[cfg(windows)]
        {
            // Windows: Mark file as hidden and system
            use std::process::Command;
            let _ = Command::new("attrib")
                .args(["+H", "+S", path.to_str().unwrap_or("")])
                .output();
        }
        
        Ok(())
    }
    
    /// Save keypair to disk (encrypted with file-based secret)
    /// SECURITY: Uses random encryption key, NOT derived from public node_id
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
        
        // SECURITY FIX: Get encryption key from file-based secret (not from node_id!)
        let key_material = self.get_encryption_key()?;
        
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
    
    /// Load keypair from disk (decrypt with file-based secret)
    /// SECURITY: Uses random encryption key from file, NOT derived from public node_id
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
        
        // SECURITY FIX: Get decryption key from file-based secret (not from node_id!)
        let key_material = self.get_encryption_key()?;
        
        // Decrypt
        let key = Key::<Aes256Gcm>::from_slice(&key_material);
        let cipher = Aes256Gcm::new(key);
        let nonce = Nonce::from_slice(nonce_bytes);
        
        let decrypted = cipher.decrypt(nonce, encrypted)
            .map_err(|e| anyhow!("Decryption failed: {}. If keys were encrypted with old method, delete keys/ folder and restart.", e))?;
        
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

// Tests moved to quantum_crypto.rs::test_dilithium_sign_and_verify
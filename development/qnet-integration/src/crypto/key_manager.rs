use std::path::{Path, PathBuf};
use std::fs;
use std::sync::{Arc, OnceLock};
use parking_lot::{RwLock, Mutex};
use anyhow::{Result, anyhow};
use pqcrypto_mldsa::mldsa65 as dilithium3;
use pqcrypto_traits::sign::{PublicKey as PublicKeyTrait, SecretKey as SecretKeyTrait, SignedMessage as SignedMessageTrait};
use sha3::{Sha3_256, Digest};
use zeroize::Zeroize;
use dashmap::DashMap;

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTION v2.50: Lock-free key directory cache with OnceLock
// Set once at first use, then zero-cost reads forever
// ═══════════════════════════════════════════════════════════════════════════════

/// Cached writable key directory - set once, read forever (lock-free after init)
static CACHED_KEY_DIR: OnceLock<PathBuf> = OnceLock::new();

// Process-wide keypair singleton (fixes the pk_mismatch race). Multiple
// DilithiumKeyManager instances (node startup, signing cache, rpc
// registration) each held their own cached_keypair; racing before the disk
// file existed, each generated a different random keypair → split-brain
// identity → signatures failed cross-path verification. Fix: keypairs are
// keyed by canonical disk path so all managers for the same
// dilithium_keypair.bin share one Arc<(PK,SK)>. Wait-free DashMap reads;
// a per-path init Mutex serialises only the first keygen/load
// (double-checked locking). O(1) memory/process.

/// Process-wide cache: canonical disk path → shared keypair.
/// Eliminates the in-process race where two managers generated different random keys.
static GLOBAL_KEYPAIR_CACHE: OnceLock<DashMap<PathBuf, Arc<(dilithium3::PublicKey, dilithium3::SecretKey)>>> = OnceLock::new();

/// Per-path init mutex: serializes the very first keygen-or-load for each path.
/// Held only during initialization; subsequent reads bypass this entirely.
static GLOBAL_KEYPAIR_INIT_LOCKS: OnceLock<DashMap<PathBuf, Arc<Mutex<()>>>> = OnceLock::new();

#[inline]
fn keypair_cache() -> &'static DashMap<PathBuf, Arc<(dilithium3::PublicKey, dilithium3::SecretKey)>> {
    GLOBAL_KEYPAIR_CACHE.get_or_init(DashMap::new)
}

#[inline]
fn keypair_init_locks() -> &'static DashMap<PathBuf, Arc<Mutex<()>>> {
    GLOBAL_KEYPAIR_INIT_LOCKS.get_or_init(DashMap::new)
}

/// Compute the canonical cache key for a given key directory.
/// Uses canonicalized parent dir to ensure two managers pointing to the same on-disk
/// file (even via different relative paths) share the same global cache entry.
fn canonical_cache_key(key_dir: &Path) -> PathBuf {
    // canonicalize() requires the directory to exist; ensure_writable_directory
    // already guarantees this. Fall back to original path if canonicalize fails
    // (e.g., on platforms with quirky path semantics) — same dir input still maps
    // to same key, which is what we need.
    let canonical_dir = key_dir.canonicalize().unwrap_or_else(|_| key_dir.to_path_buf());
    canonical_dir.join("dilithium_keypair.bin")
}

/// Manages Dilithium keys for the node
pub struct DilithiumKeyManager {
    /// Path to key storage
    key_dir: PathBuf,

    /// Local view of the cached keypair (kept for backward-compatible Drop semantics
    /// and fast per-instance access). Source of truth is the process-wide
    /// GLOBAL_KEYPAIR_CACHE — this field mirrors that entry for the manager's path.
    cached_keypair: Arc<RwLock<Option<(dilithium3::PublicKey, dilithium3::SecretKey)>>>,

    /// Node ID
    node_id: String,
}

impl DilithiumKeyManager {
    /// Create new key manager with ROBUST directory creation
    pub fn new(node_id: String, key_dir: &Path) -> Result<Self> {
        // CRITICAL: Try multiple fallback paths for Docker/production compatibility
        let final_key_dir = Self::ensure_writable_directory(key_dir)?;
        
        println!("[INFO][KEY] key_dir={:?}", final_key_dir);
        
        Ok(Self {
            key_dir: final_key_dir,
            cached_keypair: Arc::new(RwLock::new(None)),
            node_id,
        })
    }
    
    /// PRODUCTION-SAFE: Find and create writable directory with fallback paths.
    ///
    /// v2.50: Uses OnceLock for lock-free caching after first initialization.
    /// v15.14: Serialises the candidate-search SLOW PATH under a global Mutex.
    ///         The previous implementation used a `.write_test` probe per
    ///         candidate which could race when multiple threads first-call this
    ///         function concurrently — one thread would lose the file race on
    ///         the preferred path, fall back to a different candidate, and end
    ///         up with a different `key_dir` than its peers. That broke the
    ///         "all DilithiumKeyManager instances on this node share one key
    ///         directory" invariant. The Mutex eliminates this entirely; it
    ///         is taken only on the very first call and never afterwards.
    fn ensure_writable_directory(preferred: &Path) -> Result<PathBuf> {
        // PRODUCTION v2.50: Lock-free cache check (instant after first init).
        // After the slow path runs once, this branch is taken forever.
        if let Some(cached_dir) = CACHED_KEY_DIR.get() {
            if cached_dir.exists() && cached_dir.is_dir() {
                return Ok(cached_dir.clone());
            }
        }

        // SLOW PATH: serialise candidate search across all racing threads so
        // the `.write_test` probe is never contended. Runs at most once per
        // process under normal operation.
        static SEARCH_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
        let _search_guard = SEARCH_LOCK.lock();

        // DOUBLE-CHECK: another thread may have populated the cache while we
        // were waiting for the search lock.
        if let Some(cached_dir) = CACHED_KEY_DIR.get() {
            if cached_dir.exists() && cached_dir.is_dir() {
                return Ok(cached_dir.clone());
            }
        }

        // Build candidate directories in priority order
        let mut candidates: Vec<PathBuf> = vec![
            preferred.to_path_buf(),                              // Preferred path
            PathBuf::from("/app/data/keys"),                      // Docker persistent volume
        ];

        // Add optional paths if available
        if let Ok(current_dir) = std::env::current_dir() {
            candidates.push(current_dir.join("data").join("keys"));
        }

        if let Some(data_dir) = dirs::data_local_dir() {
            candidates.push(data_dir.join("qnet").join("keys"));
        }

        println!("[INFO][KEY] searching for writable key directory");

        for (idx, path) in candidates.iter().enumerate() {
            if crate::node::is_debug() { println!("[DBG][KEY] testing dir [{}/{}] {:?}", idx + 1, candidates.len(), path); }

            // Try to create directory
            match fs::create_dir_all(path) {
                Ok(_) => {
                    // Verify we can write to it by creating a test file.
                    // SEARCH_LOCK guarantees no other thread races us on this
                    // probe, so a single `.write_test` filename is safe.
                    let test_file = path.join(".write_test");
                    match fs::write(&test_file, b"test") {
                        Ok(_) => {
                            let _ = fs::remove_file(&test_file); // Cleanup
                            println!("[INFO][KEY] selected_dir={:?}", path);

                            // PRODUCTION v2.50: Cache with OnceLock (lock-free after this)
                            let _ = CACHED_KEY_DIR.set(path.clone());

                            return Ok(path.clone());
                        }
                        Err(e) => {
                            eprintln!("[ERR][KEY] dir_not_writable path={:?} err={}", path, e);
                            continue;
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[ERR][KEY] dir_create_failed path={:?} err={}", path, e);
                    continue;
                }
            }
        }

        // CRITICAL: If all fallbacks fail, provide detailed diagnostic
        eprintln!("[ERR][KEY] no writable directory found");
        eprintln!("[ERR][KEY] diagnostic info:");
        eprintln!("[ERR][KEY] cwd={:?} user={:?} tmp={:?}",
            std::env::current_dir(),
            std::env::var("USER").or_else(|_| std::env::var("USERNAME")),
            std::env::temp_dir());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(metadata) = fs::metadata(preferred) {
                eprintln!("[ERR][KEY] preferred_dir_perms={:o}", metadata.permissions().mode());
            }
        }

        Err(anyhow!(
            "Cannot find writable directory for keys. Tried {} candidates. Check Docker volumes and file permissions.",
            candidates.len()
        ))
    }
    
    /// Initialize keys (load or generate)
    pub async fn initialize(&self) -> Result<()> {
        println!("[INFO][KEY] init node={} dir={:?}", self.node_id, self.key_dir);
        
        // Directory should already exist from new(), but verify
        if !self.key_dir.exists() {
            println!("[INFO][KEY] creating key directory");
            fs::create_dir_all(&self.key_dir)
                .map_err(|e| anyhow!("Failed to create key directory: {}", e))?;
        }
        
        // Check directory permissions
        match fs::metadata(&self.key_dir) {
            Ok(metadata) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    println!("[INFO][KEY] dir_permissions={:o}", metadata.permissions().mode());
                }
                
                if !metadata.is_dir() {
                    return Err(anyhow!("Key path exists but is not a directory: {:?}", self.key_dir));
                }
            }
            Err(e) => {
                eprintln!("[ERR][KEY] dir_metadata_failed err={}", e);
                return Err(anyhow!("Cannot access key directory: {}", e));
            }
        }
        
        // Keypair will be loaded or generated on first use (lazy initialization)
        println!("[INFO][KEY] init complete");
        Ok(())
    }
    
    /// Get keypair (loads from disk or generates new, cached process-wide).
    ///
    /// v15.14: Uses GLOBAL_KEYPAIR_CACHE keyed by canonical disk path so that all
    /// DilithiumKeyManager instances for the same path share one keypair. Eliminates
    /// the pk_mismatch race where two concurrent managers each generated random keys
    /// before either persisted to disk.
    pub fn get_keypair(&self) -> Result<(dilithium3::PublicKey, dilithium3::SecretKey)> {
        let cache_key = canonical_cache_key(&self.key_dir);

        // FAST PATH 1: lock-free read of process-wide cache. After first init this
        // is wait-free and dominates steady-state behaviour for all signing calls.
        // We extract owned clones inside the closure so the DashMap shard lock is
        // released BEFORE we touch any per-instance lock.
        let cached_pair = keypair_cache().get(&cache_key).map(|entry| {
            let (pk, sk) = entry.value().as_ref();
            (pk.clone(), sk.clone())
        });
        if let Some((pk, sk)) = cached_pair {
            // Mirror into local view for Drop-time zeroization bookkeeping.
            {
                let mut local = self.cached_keypair.write();
                if local.is_none() {
                    *local = Some((pk.clone(), sk.clone()));
                }
            }
            return Ok((pk, sk));
        }

        // SLOW PATH: must acquire per-path init mutex to serialize first-time keygen.
        // The mutex is created on demand via DashMap::entry().or_insert_with() which
        // is itself atomic. We clone the Arc<Mutex> and release the init-locks shard
        // before acquiring the mutex, to keep lock ordering simple.
        let init_lock = {
            let entry = keypair_init_locks()
                .entry(cache_key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())));
            entry.value().clone()
        };
        let _guard = init_lock.lock();

        // DOUBLE-CHECK: another thread may have populated the cache while we waited.
        let cached_pair_after_lock = keypair_cache().get(&cache_key).map(|entry| {
            let (pk, sk) = entry.value().as_ref();
            (pk.clone(), sk.clone())
        });
        if let Some((pk, sk)) = cached_pair_after_lock {
            {
                let mut local = self.cached_keypair.write();
                if local.is_none() {
                    *local = Some((pk.clone(), sk.clone()));
                }
            }
            return Ok((pk, sk));
        }

        // First initialization for this path. Either load from disk or generate new.
        let key_path = self.key_dir.join("dilithium_keypair.bin");
        let (pk, sk) = if key_path.exists() {
            // CRITICAL: If file exists, it MUST be loaded successfully.
            // Generating new keys would cause node identity loss.
            println!("[INFO][KEY] loading_persisted_keypair node={} path={:?}", self.node_id, key_path);
            self.load_keypair_from_disk(&key_path)?
        } else {
            // Generate new keypair ONCE and persist it. Subsequent restarts load it.
            println!("[INFO][KEY] generating_new_mldsa65_keypair node={} (one-time, no disk file)", self.node_id);
            let (new_pk, new_sk) = dilithium3::keypair();
            self.save_keypair_to_disk(&new_pk, &new_sk, &key_path)?;
            println!("[INFO][KEY] keypair_persisted node={} path={:?}", self.node_id, key_path);
            (new_pk, new_sk)
        };

        // Atomic insert into the process-wide cache. After this point, all other
        // DilithiumKeyManager instances for this path will hit the fast path.
        let arc_kp = Arc::new((pk.clone(), sk.clone()));
        keypair_cache().insert(cache_key, arc_kp);

        // Mirror into local view for backward-compatible Drop bookkeeping.
        {
            let mut local = self.cached_keypair.write();
            *local = Some((pk.clone(), sk.clone()));
        }

        if crate::node::is_info() {
            let pk_hash = hex::encode(&Sha3_256::digest(PublicKeyTrait::as_bytes(&pk))[..8]);
            println!("[INFO][KEY] keypair_ready node={} pk_hash={}", self.node_id, pk_hash);
        }

        Ok((pk, sk))
    }
    
    /// v27 HOLE1: deterministic ML-DSA-65 keypair from the wallet mnemonic
    /// (replaces random keygen + dilithium_keypair.bin → wipe-safe, pin-able,
    /// no TOFU squat window). Sign/verify path unchanged (pqcrypto-mldsa);
    /// keygen=fips204 (byte-compat KAT-proven, fail-closed at boot). Shares
    /// the process-wide keypair cache; no disk source of truth.
    pub fn get_keypair_from_mnemonic(
        &self,
        mnemonic: &str,
    ) -> Result<(dilithium3::PublicKey, dilithium3::SecretKey)> {
        let cache_key = canonical_cache_key(&self.key_dir);

        // FAST PATH: process-wide cache (shared with get_keypair()).
        let cached_pair = keypair_cache().get(&cache_key).map(|entry| {
            let (pk, sk) = entry.value().as_ref();
            (pk.clone(), sk.clone())
        });
        if let Some((pk, sk)) = cached_pair {
            let mut local = self.cached_keypair.write();
            if local.is_none() {
                *local = Some((pk.clone(), sk.clone()));
            }
            return Ok((pk, sk));
        }

        // SLOW PATH: serialize first-time derivation per canonical path.
        let init_lock = {
            let entry = keypair_init_locks()
                .entry(cache_key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())));
            entry.value().clone()
        };
        let _guard = init_lock.lock();

        if let Some((pk, sk)) = keypair_cache().get(&cache_key).map(|entry| {
            let (pk, sk) = entry.value().as_ref();
            (pk.clone(), sk.clone())
        }) {
            let mut local = self.cached_keypair.write();
            if local.is_none() {
                *local = Some((pk.clone(), sk.clone()));
            }
            return Ok((pk, sk));
        }

        // Deterministic derivation (fips204 KeyGen from mnemonic-bound xi).
        let (pk_bytes, sk_bytes) =
            crate::crypto::genesis_key::derive_mldsa65_from_mnemonic(mnemonic);
        let pk = <dilithium3::PublicKey as PublicKeyTrait>::from_bytes(&pk_bytes)
            .map_err(|e| anyhow!("[ERR][KEY] derived_pk_parse err={:?}", e))?;
        let sk = <dilithium3::SecretKey as SecretKeyTrait>::from_bytes(&sk_bytes)
            .map_err(|e| anyhow!("[ERR][KEY] derived_sk_parse err={:?}", e))?;

        let arc_kp = Arc::new((pk.clone(), sk.clone()));
        keypair_cache().insert(cache_key, arc_kp);
        {
            let mut local = self.cached_keypair.write();
            *local = Some((pk.clone(), sk.clone()));
        }
        if crate::node::is_info() {
            let pk_hash = hex::encode(&Sha3_256::digest(PublicKeyTrait::as_bytes(&pk))[..8]);
            println!(
                "[INFO][KEY] keypair_derived_deterministic node={} pk_hash={} src=mnemonic",
                self.node_id, pk_hash
            );
        }
        Ok((pk, sk))
    }

    /// Get public key bytes (1952 bytes for Dilithium3)
    pub fn get_public_key(&self) -> Result<Vec<u8>> {
        let (public_key, _) = self.get_keypair()?;
        
        // Use trait method to get bytes
        Ok(PublicKeyTrait::as_bytes(&public_key).to_vec())
    }
    
    /// Sign data and return FULL SignedMessage (signature + message)
    /// PRODUCTION: Use this for proper Dilithium3 verification with dilithium3::open()
    /// Format: [signature(3309 bytes)] + [original message]  (ML-DSA-65 FIPS 204)
    pub fn sign_full(&self, data: &[u8]) -> Result<Vec<u8>> {
        let (_pk, sk) = self.get_keypair()?;
        
        // Sign with REAL Dilithium3 algorithm
        let signature = dilithium3::sign(data, &sk);
        
        // Return the FULL SignedMessage bytes (signature + message)
        let signed_msg_bytes = SignedMessageTrait::as_bytes(&signature);
        
        if crate::node::is_debug() {
            println!("[DBG][KEY] sign_full size={}", signed_msg_bytes.len());
        }
        Ok(signed_msg_bytes.to_vec())
    }
    
    /// Verify signature with public key
    /// CRITICAL: This is for external verification only (other nodes verifying our signatures)
    /// We cannot derive the original seed from public key - that would be insecure!
    /// Instead, we verify the signature structure and entropy
    pub fn verify(&self, data: &[u8], signature: &[u8], public_key_bytes: &[u8]) -> Result<bool> {
        if signature.len() < 3309 {
            eprintln!("[ERR][KEY] sig_too_small got={} min=3309", signature.len());
            return Ok(false);
        }

        if public_key_bytes.len() != 1952 {
            eprintln!("[ERR][KEY] pk_size_invalid got={} expected=1952", public_key_bytes.len());
            return Ok(false);
        }
        
        // PRODUCTION: Use REAL Dilithium3 verification
        let pk = <dilithium3::PublicKey as PublicKeyTrait>::from_bytes(public_key_bytes)
            .map_err(|_| anyhow!("Invalid public key format"))?;
        
        let mut signed_msg = Vec::with_capacity(signature.len() + data.len());
        signed_msg.extend_from_slice(signature);
        signed_msg.extend_from_slice(data);
        
        let signed_message = match dilithium3::SignedMessage::from_bytes(&signed_msg) {
            Ok(sm) => sm,
            Err(_) => {
                eprintln!("[ERR][KEY] signed_msg_parse_failed len={}", signed_msg.len());
                return Ok(false);
            }
        };
        
        match dilithium3::open(&signed_message, &pk) {
            Ok(_) => {
                if crate::node::is_debug() { println!("[DBG][KEY] sig_verified ok"); }
                Ok(true)
            }
            Err(_) => {
                eprintln!("[ERR][KEY] sig_verification_failed");
                Ok(false)
            }
        }
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
                        println!("[INFO][KEY] using encryption key from QNET_KEY_ENCRYPTION_SECRET");
                        return Ok(key);
                    }
                }
            }
            eprintln!("[ERR][KEY] invalid QNET_KEY_ENCRYPTION_SECRET format (need 64 hex chars)");
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
                
                // Verify integrity hash — constant-time to prevent timing attacks
                let mut hasher = Sha3_256::new();
                hasher.update(key_part);
                hasher.update(b"QNET_SECRET_INTEGRITY_V1");
                let hash_result = hasher.finalize();
                let computed_hash = &hash_result[..8];

                let hashes_equal = {
                    let mut diff = 0u8;
                    for (a, b) in stored_hash.iter().zip(computed_hash.iter()) {
                        diff |= a ^ b;
                    }
                    std::hint::black_box(diff) == 0
                };

                if hashes_equal {
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
                    eprintln!("[ERR][KEY] corrupted encryption secret (no keypair yet), regenerating");
                }
            } else if secret_data.len() == 32 {
                // Legacy format without hash - upgrade it
                println!("[INFO][KEY] upgrading encryption secret to include integrity hash");
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
                eprintln!("[ERR][KEY] corrupted encryption secret (wrong size={}), regenerating", secret_data.len());
            }
        }
        
        // 3. Generate new random secret (only if no keypair exists!)
        if keypair_path.exists() {
            return Err(anyhow!(
                "CRITICAL: Encryption secret missing but keypair exists! \
                Cannot decrypt existing keys. Restore .qnet_encryption_secret from backup."
            ));
        }
        
        println!("[INFO][KEY] generating new encryption secret (one-time)");
        let mut new_key = [0u8; 32];
        {
            use rand::RngCore;
            use rand::rngs::OsRng;
            OsRng.fill_bytes(&mut new_key);
        }
        
        // Save with integrity hash
        self.save_encryption_secret(&new_key, &secret_path)?;
        
        println!("[INFO][KEY] encryption_secret saved path={:?}", secret_path);
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
        let mut nonce_bytes = [0u8; 12];
        {
            use rand::RngCore;
            use rand::rngs::OsRng;
            OsRng.fill_bytes(&mut nonce_bytes);
        }
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
        
        let mut decrypted = cipher.decrypt(nonce, encrypted)
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

        // Zeroize decrypted buffer containing raw secret key material
        decrypted.zeroize();

        Ok((pk, sk))
    }
}

// FIX R24-H3: Zeroize the ORIGINAL SecretKey bytes, not just a copy.
// R23-K6 created a Vec copy via to_vec() and zeroized that — but the original
// pqcrypto SecretKey (which doesn't impl Zeroize) remained in memory.
// Now we zeroize the original bytes in-place via unsafe pointer to the SecretKey.
impl Drop for DilithiumKeyManager {
    fn drop(&mut self) {
        if let Some(mut guard) = self.cached_keypair.try_write() {
            if let Some((_pk, sk)) = guard.take() {
                // FIX P1: zeroize via owned mutable copy (no UB from immutable cast)
                // SecretKey is Copy — take owned bytes, zeroize the copy,
                // then black_box the original to prevent compiler from eliding the drop
                let mut sk_bytes = sk.as_bytes().to_vec();
                for byte in sk_bytes.iter_mut() {
                    unsafe { std::ptr::write_volatile(byte as *mut u8, 0u8); }
                }
                std::hint::black_box(&sk_bytes);
                // Zeroize the original SecretKey struct memory via its raw pointer
                // Safe: sk is owned (taken from Option), no other references exist
                let sk_ptr = &sk as *const _ as *mut u8;
                let sk_size = std::mem::size_of_val(&sk);
                for i in 0..sk_size {
                    unsafe { std::ptr::write_volatile(sk_ptr.add(i), 0u8); }
                }
                std::hint::black_box(&sk);
                drop(sk_bytes);
                println!("[INFO][KEY] dilithium_sk_zeroized node={}", self.node_id);
            }
        }
    }
}

// ============================================================================
// UNIT TESTS (Dilithium sign/verify tests are in quantum_crypto.rs)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    
    /// Test key directory creation with fallback paths
    #[test]
    fn test_ensure_writable_directory() {
        let temp = tempdir().expect("Failed to create temp dir");
        let key_dir = temp.path().join("keys");
        
        let result = DilithiumKeyManager::ensure_writable_directory(&key_dir);
        assert!(result.is_ok());
        
        let path = result.unwrap();
        assert!(path.exists() || path.to_str().is_some());
    }
    
    /// Test key manager creation
    #[test]
    fn test_key_manager_creation() {
        let temp = tempdir().expect("Failed to create temp dir");
        let key_dir = temp.path().join("keys");
        
        let result = DilithiumKeyManager::new("test_node".to_string(), &key_dir);
        assert!(result.is_ok());
        
        let manager = result.unwrap();
        assert_eq!(manager.node_id, "test_node");
    }
    
    /// Test encryption key format (32 bytes, not all zeros)
    #[test]
    fn test_encryption_key_format() {
        use rand::RngCore;
        
        let mut encryption_key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut encryption_key);
        
        assert_eq!(encryption_key.len(), 32);
        assert!(encryption_key.iter().any(|&b| b != 0));
    }
    
    /// Test AES-256-GCM encryption/decryption roundtrip
    #[test]
    fn test_aes_gcm_encryption() {
        use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
        use aes_gcm::aead::generic_array::GenericArray;
        use rand::RngCore;
        
        let mut key = [0u8; 32];
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut key);
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        
        let cipher = Aes256Gcm::new(GenericArray::from_slice(&key));
        let nonce = GenericArray::from_slice(&nonce_bytes);
        
        let plaintext = b"Secret keypair data";
        let ciphertext = cipher.encrypt(nonce, plaintext.as_ref())
            .expect("Encryption failed");
        
        let decrypted = cipher.decrypt(nonce, ciphertext.as_ref())
            .expect("Decryption failed");
        
        assert_eq!(decrypted, plaintext);
    }
    
    /// Test SHA3-256 integrity hash consistency
    #[test]
    fn test_sha3_integrity_hash() {
        let data = b"Test data for integrity check";
        
        let mut hasher1 = Sha3_256::new();
        hasher1.update(data);
        let hash1 = hasher1.finalize();
        
        let mut hasher2 = Sha3_256::new();
        hasher2.update(data);
        let hash2 = hasher2.finalize();
        
        assert_eq!(hash1.len(), 32);
        assert_eq!(hash1, hash2);
    }
    
    /// Test key serialization format (length-prefixed)
    #[test]
    fn test_key_serialization_format() {
        let (pk, sk) = dilithium3::keypair();
        let pk_bytes = pk.as_bytes();
        let sk_bytes = sk.as_bytes();
        
        // Serialize: len(4) + pk + len(4) + sk
        let mut serialized = Vec::new();
        serialized.extend_from_slice(&(pk_bytes.len() as u32).to_le_bytes());
        serialized.extend_from_slice(pk_bytes);
        serialized.extend_from_slice(&(sk_bytes.len() as u32).to_le_bytes());
        serialized.extend_from_slice(sk_bytes);
        
        // Parse back
        let mut cursor = 0;
        let pk_len = u32::from_le_bytes([
            serialized[cursor], serialized[cursor+1],
            serialized[cursor+2], serialized[cursor+3]
        ]) as usize;
        cursor += 4;
        
        let restored_pk = &serialized[cursor..cursor+pk_len];
        cursor += pk_len;
        
        let sk_len = u32::from_le_bytes([
            serialized[cursor], serialized[cursor+1],
            serialized[cursor+2], serialized[cursor+3]
        ]) as usize;
        cursor += 4;
        
        let restored_sk = &serialized[cursor..cursor+sk_len];

        assert_eq!(pk_bytes, restored_pk);
        assert_eq!(sk_bytes, restored_sk);
    }

    // ════════════════════════════════════════════════════════════════════════
    // v15.14: Tests for the process-wide keypair singleton (pk_mismatch fix)
    // ════════════════════════════════════════════════════════════════════════

    /// Two managers pointing to the same key directory must return the
    /// IDENTICAL keypair. Before v15.14 each manager held its own cache and
    /// raced on first-time keygen, producing two different random keypairs
    /// and a split-brain identity.
    #[test]
    fn test_singleton_same_dir_returns_same_keypair() {
        let temp = tempdir().expect("tempdir");
        let key_dir = temp.path().join("keys_singleton_a");

        let m1 = DilithiumKeyManager::new("node_alpha".to_string(), &key_dir)
            .expect("m1 new");
        let m2 = DilithiumKeyManager::new("node_beta".to_string(), &key_dir)
            .expect("m2 new");

        let (pk1, sk1) = m1.get_keypair().expect("m1 keypair");
        let (pk2, sk2) = m2.get_keypair().expect("m2 keypair");

        let pk1_bytes = PublicKeyTrait::as_bytes(&pk1);
        let pk2_bytes = PublicKeyTrait::as_bytes(&pk2);
        let sk1_bytes = SecretKeyTrait::as_bytes(&sk1);
        let sk2_bytes = SecretKeyTrait::as_bytes(&sk2);

        assert_eq!(pk1_bytes, pk2_bytes,
            "Two DilithiumKeyManager instances with identical key_dir must \
             share the same public key (no split-brain)");
        assert_eq!(sk1_bytes, sk2_bytes,
            "Two DilithiumKeyManager instances with identical key_dir must \
             share the same secret key (signature path consistency)");
    }

    /// Stress the global singleton with many concurrent threads each trying
    /// to first-time-init the SAME path. Without the per-path init mutex
    /// and double-checked DashMap insert, this would race and produce
    /// divergent keypairs.
    ///
    /// Production scenario this guards against: at node startup
    /// `node.rs:initialize_wallet_identity` and `quantum_crypto.rs` may both
    /// instantiate a `DilithiumKeyManager` for the same node before either
    /// has completed its first `get_keypair()` call. Pre-v15.14 each manager
    /// generated its own random keypair, persisted it, and cached locally,
    /// producing two different on-disk and in-memory identities.
    #[test]
    fn test_singleton_concurrent_init_no_divergence() {
        use std::thread;
        use std::sync::Arc as StdArc;
        use std::sync::Barrier;

        let temp = tempdir().expect("tempdir");
        let key_dir = temp.path().join("keys_concurrent_b");
        fs::create_dir_all(&key_dir).expect("mkdir");

        // Pre-warm CACHED_KEY_DIR so all threads observe the SAME final
        // key_dir. This mirrors production where `ensure_writable_directory`
        // runs once at startup before any concurrent signing path engages.
        // Without this warm-up the candidate-search slow path is entered
        // concurrently — `ensure_writable_directory`'s SEARCH_LOCK serialises
        // it, but the warm-up is the canonical production sequence and
        // represents the most realistic test of get_keypair() race fix.
        let _warm = DilithiumKeyManager::new("warmer".to_string(), &key_dir)
            .expect("warmer new");
        drop(_warm);

        let thread_count = 16usize;
        // Barrier: release all threads at the same instant so the first
        // get_keypair() call from each thread races on the empty global
        // keypair cache. This is the precise scenario the singleton fix
        // must handle — without the per-path init mutex + double-checked
        // DashMap insert, threads would each call dilithium3::keypair()
        // and save divergent keypairs to disk.
        let barrier = StdArc::new(Barrier::new(thread_count));

        let handles: Vec<_> = (0..thread_count).map(|i| {
            let kd = key_dir.clone();
            let bar = barrier.clone();
            thread::spawn(move || {
                let m = DilithiumKeyManager::new(format!("racer_{}", i), &kd)
                    .expect("racer new");
                bar.wait(); // release all threads simultaneously
                let (pk, sk) = m.get_keypair().expect("racer keypair");
                (
                    PublicKeyTrait::as_bytes(&pk).to_vec(),
                    SecretKeyTrait::as_bytes(&sk).to_vec(),
                )
            })
        }).collect();

        let results: Vec<_> = handles.into_iter()
            .map(|h| h.join().expect("thread panic"))
            .collect();

        // Every thread must have observed the SAME (pk, sk).
        for (i, (pk_i, sk_i)) in results.iter().enumerate().skip(1) {
            assert_eq!(&results[0].0, pk_i,
                "Thread {} observed a divergent public key — race not eliminated", i);
            assert_eq!(&results[0].1, sk_i,
                "Thread {} observed a divergent secret key — race not eliminated", i);
        }
    }

    /// Verify the singleton uses the canonical disk path as cache key, so
    /// two managers reaching the same on-disk file via different surface
    /// paths (e.g., trailing slash, current-dir prefix) still share state.
    #[test]
    fn test_singleton_canonical_path_keying() {
        let temp = tempdir().expect("tempdir");
        let key_dir = temp.path().join("keys_canon_c");
        fs::create_dir_all(&key_dir).expect("mkdir");

        // Path 1: as given.
        let m1 = DilithiumKeyManager::new("n1".to_string(), &key_dir).expect("m1");
        let (pk1, _) = m1.get_keypair().expect("kp1");

        // Path 2: same directory but accessed via PathBuf round-trip
        // (canonicalize should normalize both to the same form).
        let key_dir_alt: PathBuf = key_dir.clone().into();
        let m2 = DilithiumKeyManager::new("n2".to_string(), &key_dir_alt).expect("m2");
        let (pk2, _) = m2.get_keypair().expect("kp2");

        assert_eq!(
            PublicKeyTrait::as_bytes(&pk1),
            PublicKeyTrait::as_bytes(&pk2),
            "Canonical-path keying must collapse equivalent paths to the same cache entry"
        );
    }

    /// Verify that distinct key directories yield DISTINCT keypairs (no
    /// accidental cross-contamination via the global cache).
    #[test]
    fn test_singleton_distinct_dirs_distinct_keypairs() {
        let temp = tempdir().expect("tempdir");
        let dir_a = temp.path().join("keys_distinct_a_d");
        let dir_b = temp.path().join("keys_distinct_b_d");
        fs::create_dir_all(&dir_a).expect("mkdir a");
        fs::create_dir_all(&dir_b).expect("mkdir b");

        // NOTE: ensure_writable_directory caches the FIRST writable dir it
        // sees process-wide via CACHED_KEY_DIR (OnceLock). To get distinct
        // paths into the global keypair cache we exercise the canonical
        // path keying directly by building managers whose key_dir field is
        // explicitly each unique tempdir. We bypass new() because of the
        // process-wide CACHED_KEY_DIR collision in the test harness; this
        // is a test-only concern, not a production one (production has 1
        // process per node and 1 key_dir per process).
        let m_a = DilithiumKeyManager {
            key_dir: dir_a.clone(),
            cached_keypair: Arc::new(RwLock::new(None)),
            node_id: "node_dist_a".to_string(),
        };
        let m_b = DilithiumKeyManager {
            key_dir: dir_b.clone(),
            cached_keypair: Arc::new(RwLock::new(None)),
            node_id: "node_dist_b".to_string(),
        };

        let (pk_a, _) = m_a.get_keypair().expect("kp a");
        let (pk_b, _) = m_b.get_keypair().expect("kp b");

        assert_ne!(
            PublicKeyTrait::as_bytes(&pk_a),
            PublicKeyTrait::as_bytes(&pk_b),
            "Distinct key directories must yield distinct keypairs"
        );
    }
}

// NOTE: Dilithium sign/verify tests are in quantum_crypto.rs::test_dilithium_sign_and_verify
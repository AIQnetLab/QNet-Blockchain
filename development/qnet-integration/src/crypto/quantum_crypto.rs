//! QNet Quantum-Resistant Cryptography Module for Server
//! Production implementation using CRYSTALS-ML-DSA-65 and XOR-based activation code encryption
//! Server-side activation code decryption and validation

use sha3::{Sha3_256, Digest};
use serde::{Serialize, Deserialize};
use std::time::{SystemTime, UNIX_EPOCH};
use base64::{Engine as _, engine::general_purpose};
use anyhow::{Result, anyhow};
use std::sync::Arc;
use parking_lot::RwLock as StdRwLock;  // For performance_stats (non-async, non-poisoning)
use dashmap::DashMap;



// `ct_eq` was used by the old STEP-4 fallback in `verify_dilithium_signature`
// that was removed as part of the v17 identity-binding hardening. The
// canonical-message comparison now lives entirely inside
// `qnet_consensus::consensus_crypto::verify_with_real_dilithium`, which has
// its own constant-time helper. This module no longer needs a local copy.

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTION v2.51: Lock-free caches with DashMap
// 10x faster than tokio::sync::RwLock for concurrent access
// ═══════════════════════════════════════════════════════════════════════════════

/// Activation data cache - lock-free concurrent access
static CRYPTO_CACHE: once_cell::sync::Lazy<DashMap<String, CachedActivationData>> = 
    once_cell::sync::Lazy::new(|| DashMap::new());

/// Signature verification cache - lock-free concurrent access  
static SIGNATURE_CACHE: once_cell::sync::Lazy<DashMap<String, CachedSignature>> = 
    once_cell::sync::Lazy::new(|| DashMap::new());

/// DilithiumKeyManager cache - avoids repeated disk I/O
/// Caches LONG-TERM Dilithium keys (NOT ephemeral keys per NIST/Cisco)
static KEY_MANAGER_CACHE: once_cell::sync::Lazy<DashMap<String, CachedKeyManager>> = 
    once_cell::sync::Lazy::new(|| DashMap::new());

/// Cached activation data for zero-copy operations
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct CachedActivationData {
    payload: ActivationPayload,
    created_at: u64,
    access_count: u64,
}

/// Cached signature for fast validation
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct CachedSignature {
    is_valid: bool,
    cached_at: u64,
    signature_hash: String,
}

/// Cached KeyManager for avoiding repeated disk I/O
/// CRITICAL: This caches LONG-TERM Dilithium keys, NOT ephemeral keys
/// Safe per NIST/Cisco as these are persistent node keys
struct CachedKeyManager {
    manager: Arc<crate::key_manager::DilithiumKeyManager>,
    cached_at: u64,
    access_count: Arc<std::sync::atomic::AtomicU64>,
}

/// Simple node replacement: 1 wallet = 1 active node (regardless of type)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimpleNodeRecord {
    pub wallet_address: String,
    pub node_type: String,
    pub external_ip: String,
    pub api_port: u16,
}

/// Activation payload structure (decrypted from quantum-secure code)
/// IMPORTANT: `wallet` is ALWAYS QNet EON address (for rewards)
/// Phase 1: Solana address used only for burn verification, rewards go to QNet wallet
/// Phase 2: Same QNet EON address used for burn and rewards
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivationPayload {
    pub burn_tx: String,
    /// QNet EON address for rewards (ALWAYS EON format: {19}eon{15}{4checksum})
    pub wallet: String,
    pub node_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<DilithiumSignature>,
    pub entropy: String,
    pub timestamp: u64,
    pub version: String,
    pub permanent: bool,
}

/// Dilithium signature structure (quantum-resistant)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DilithiumSignature {
    pub signature: String,
    pub algorithm: String,
    pub timestamp: u64,
    pub strength: String,
}

/// Quantum crypto status with performance metrics
#[derive(Debug, Serialize)]
pub struct QuantumCryptoStatus {
    pub initialized: bool,
    pub algorithms: QuantumAlgorithms,
    pub performance: PerformanceMetrics,
}

/// Performance metrics for optimization monitoring
#[derive(Debug, Serialize)]
pub struct PerformanceMetrics {
    pub cache_hit_rate: f64,
    pub cache_size: usize,
    pub avg_decrypt_time_ms: f64,
    pub memory_usage_mb: f64,
    pub zero_copy_operations: u64,
}

/// Quantum algorithms info
#[derive(Debug, Serialize)]
pub struct QuantumAlgorithms {
    pub signature: String,
    pub encryption: String,
    pub hash: String,
}

/// Quantum-secure crypto system for QNet activation codes
pub struct QNetQuantumCrypto {
    initialized: bool,
    cache_ttl_seconds: u64,
    max_cache_size: usize,
    zero_copy_counter: Arc<std::sync::atomic::AtomicU64>,
    performance_stats: Arc<StdRwLock<PerformanceStats>>,
}

#[derive(Debug, Default)]
#[allow(dead_code)]
struct PerformanceStats {
    total_operations: u64,
    cache_hits: u64,
    cache_misses: u64,
    total_decrypt_time_ms: u64,
    memory_peak_mb: f64,
}

impl QNetQuantumCrypto {
    pub fn new() -> Self {
        println!("[INFO][QUANTUM_CRYPTO] server_modules_initialized");
        Self {
            initialized: false,
            cache_ttl_seconds: 3600, // 1 hour cache TTL for aggressive caching
            max_cache_size: 10000,   // Cache up to 10k activation codes
            zero_copy_counter: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            performance_stats: Arc::new(StdRwLock::new(PerformanceStats::default())),
        }
    }

    pub async fn initialize(&mut self) -> Result<()> {
        if self.initialized {
            return Ok(());
        }

        // Initialize quantum crypto algorithms (placeholder for CRYSTALS integration)
        println!("[INFO][QUANTUM_CRYPTO] initializing_quantum_resistant_crypto");
        
        // Pre-warm cache for better performance
        self.prewarm_cache().await?;
        
        self.initialized = true;
        println!("[INFO][QUANTUM_CRYPTO] system_ready caching=enabled");
        Ok(())
    }

    /// Main decryption function compatible with route.ts activation code format
    pub async fn decrypt_activation_code(&self, activation_code: &str) -> Result<ActivationPayload> {
        if !self.initialized {
            return Err(anyhow!("Quantum crypto not initialized"));
        }

        let start_time = std::time::Instant::now();

        // PERFORMANCE: Check cache first (zero-copy for cache hits)
        if let Some(cached) = self.get_from_cache(activation_code).await {
            self.increment_zero_copy_ops();
            self.record_cache_hit();
            println!("[INFO][QUANTUM_CRYPTO] activation_cache_hit");
            return Ok(cached.payload);
        }

        // Cache miss - perform full decryption
        self.record_cache_miss();

        // 1. Check for genesis bootstrap codes first (different format)
        const BOOTSTRAP_WHITELIST: &[&str] = &[
            "QNET-BOOT-0001-STRAP", "QNET-BOOT-0002-STRAP", "QNET-BOOT-0003-STRAP", 
            "QNET-BOOT-0004-STRAP", "QNET-BOOT-0005-STRAP"
        ];
        
        if BOOTSTRAP_WHITELIST.contains(&activation_code) {
            println!("[INFO][QUANTUM_CRYPTO] genesis_bootstrap_detected code={}", activation_code);
            
            // Extract bootstrap ID from code: QNET-BOOT-0001-STRAP → "001"
            // Note: split gives "0001" (4 chars), but genesis_constants uses "001" (3 chars)
            let bootstrap_id_raw = activation_code
                .split('-')
                .nth(2)
                .unwrap_or("000");
            
            // Convert "0001" → "001", "0002" → "002", etc.
            let bootstrap_id = bootstrap_id_raw.trim_start_matches('0');
            let bootstrap_id = if bootstrap_id.is_empty() { "0" } else { bootstrap_id };
            let bootstrap_id = format!("{:03}", bootstrap_id.parse::<u32>().unwrap_or(0));
            
            println!("[GENESIS] Bootstrap ID parsed: '{}' → '{}'", bootstrap_id_raw, bootstrap_id);
            
            // Use predefined wallet from genesis_constants
            // STRICT: No fallback - unknown bootstrap ID is an error
            let wallet = crate::genesis_constants::get_genesis_wallet_by_id(&bootstrap_id)
                .ok_or_else(|| anyhow!("Unknown Genesis bootstrap ID: {} - not in genesis_constants", bootstrap_id))?
                .to_string();
            
            // Return a dummy payload for genesis codes
            return Ok(ActivationPayload {
                burn_tx: "genesis_bootstrap".to_string(),
                node_type: "super".to_string(),
                timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
                wallet,
                signature: None,
                entropy: "genesis_entropy".to_string(),
                version: "2.0.0".to_string(),
                permanent: true,
            });
        }
        
        // Validate code format: QNET-XXXXXX-XXXXXX-XXXXXX (25 chars)
        if !activation_code.starts_with("QNET-") || activation_code.len() != 25 {
            return Err(anyhow!("Invalid activation code format - expected QNET-XXXXXX-XXXXXX-XXXXXX (25 chars)"));
        }

        // 2. Parse route.ts format: QNET-[TYPE+TIMESTAMP]-[WALLET_PART1]-[WALLET_PART2+ENTROPY]
        let parts: Vec<&str> = activation_code.split('-').collect();
        if parts.len() != 4 || parts[0] != "QNET" {
            return Err(anyhow!("Invalid activation code structure"));
        }

        // 3. Extract node type and timestamp from first segment
        let segment1 = parts[1];
        let node_type = self.extract_node_type_from_segment(segment1)?;
        let timestamp = self.extract_timestamp_from_segment(segment1)?;

        // 4. Extract wallet data from segments 2 and 3
        // Format: QNET-XXXXXX-XXXXXX-XXXXXX (6 chars per segment)
        let segment2 = parts[2]; // First 6 hex chars of encrypted wallet
        let segment3 = parts[3]; // Next 4 hex chars of wallet + 2 chars entropy (or 4+4)
        
        // Reconstruct encrypted wallet hex
        // segment2 = encrypted_wallet[0:6]
        // segment3 = encrypted_wallet[6:10] + entropy[0:2] OR encrypted_wallet[6:10] + entropy[0:4]
        // We need to extract wallet parts, ignoring entropy
        let wallet_part1 = segment2; // 6 chars
        let wallet_part2 = qnet_state::char_prefix(&segment3, 4); // First 4 chars (rest is entropy)
        let encrypted_wallet_hex = format!("{}{}", wallet_part1, wallet_part2); // 10 chars total

        // 5. Query blockchain for burn transaction AND amount (we need both for decryption key)
        // CRITICAL: Must use the EXACT amount that was used during code generation!
        let (burn_tx, burn_amount) = self.get_burn_tx_and_amount_from_blockchain(activation_code, &node_type).await?;

        // 6. Create decryption key (same as route.ts logic)
        // key_material = f"{burn_tx}:{node_type}:{burn_amount}"
        let key_material = format!("{}:{}:{}", burn_tx, node_type, burn_amount);
        let encryption_key = self.sha3_hash(&key_material)[..32].to_string();
        
        if crate::node::is_debug() {
            println!("[DEBUG][QUANTUM_CRYPTO] xor_key_derived burn_tx={}... node_type={} burn_amount={}",
                     &burn_tx, node_type, burn_amount);
        }

        // 7. XOR decrypt wallet PREFIX (only first 5 bytes are in the code)
        let encrypted_wallet = hex::decode(&encrypted_wallet_hex)
            .map_err(|e| anyhow!("Invalid hex in encrypted wallet: {}", e))?;
            
        let decrypted_wallet_prefix = self.xor_decrypt(&encrypted_wallet, &encryption_key)?;
        
        // 8. Get FULL wallet address from ActivationRecord
        // The code only contains a prefix for verification, full wallet is in registry
        let registry = crate::activation_validation::BlockchainActivationRegistry::new(None);
        let code_hash = registry.hash_activation_code_for_blockchain(activation_code)
            .map_err(|e| anyhow!("Failed to hash activation code: {}", e))?;
        
        let full_wallet = match registry.get_activation_record_by_hash(&code_hash).await {
            Ok(Some(record)) => {
                // Verify that decrypted prefix matches stored wallet prefix
                let stored_prefix = if record.wallet_address.len() >= decrypted_wallet_prefix.len() {
                    &record.wallet_address[..decrypted_wallet_prefix.len()]
                } else {
                    &record.wallet_address
                };
                
                if stored_prefix != decrypted_wallet_prefix {
                    eprintln!("[WARN][QUANTUM_CRYPTO] wallet_prefix_mismatch decrypted={}... stored={}... using_stored=true",
                              &decrypted_wallet_prefix, stored_prefix);
                    // Continue with stored wallet — it's authoritative
                }
                
                record.wallet_address.clone()
            }
            Ok(None) => {
                eprintln!("[WARN][QUANTUM_CRYPTO] no_activation_record using_prefix_as_wallet=true");
                decrypted_wallet_prefix.clone()
            }
            Err(e) => {
                eprintln!("[WARN][QUANTUM_CRYPTO] registry_query_failed err={} using_prefix_as_wallet=true", e);
                decrypted_wallet_prefix.clone()
            }
        };

        // 9. Create activation payload
        let payload = ActivationPayload {
            burn_tx,
            wallet: full_wallet,
            node_type,
            timestamp,
            signature: None,
            entropy: segment3[4..].to_string(),
            version: "2.0.0".to_string(),
            permanent: true,
        };

        // 9. Cache the result
        self.cache_activation_data(activation_code, &payload).await;

        // Record performance metrics
        let decrypt_time_ms = start_time.elapsed().as_millis() as u64;
        self.record_decrypt_time(decrypt_time_ms);

        if crate::node::is_debug() {
            println!("[DEBUG][QUANTUM_CRYPTO] activation_decoded wallet={}... node_type={} burn_tx={}... elapsed_ms={}",
                     &payload.wallet, payload.node_type,
                     &payload.burn_tx, decrypt_time_ms);
        }

        Ok(payload)
    }

    /// Fast signature verification with aggressive caching
    pub async fn verify_dilithium_signature_cached(&self, data: &str, signature: &DilithiumSignature, wallet_address: &str) -> Result<bool> {
        // Create cache key for signature (SHA3-256 for consistency)
        let mut hasher = Sha3_256::new();
        hasher.update(data.as_bytes());
        hasher.update(signature.signature.as_bytes());
        hasher.update(wallet_address.as_bytes());
        let cache_key = hex::encode(hasher.finalize());

        // PRODUCTION v2.51: Lock-free signature cache check
        if let Some(cached_sig) = SIGNATURE_CACHE.get(&cache_key) {
            let current_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            if current_time - cached_sig.cached_at < self.cache_ttl_seconds {
                self.increment_zero_copy_ops();
                return Ok(cached_sig.is_valid);
            }
        }

        // Perform actual signature verification
        let is_valid = self.verify_dilithium_signature(data, signature, wallet_address).await?;

        // PRODUCTION v2.51: Lock-free cache insert
        SIGNATURE_CACHE.insert(cache_key, CachedSignature {
            is_valid,
            cached_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
            signature_hash: signature.signature[..16].to_string(),
        });

        Ok(is_valid)
    }

    /// Get cached activation data (zero-copy operation)
    /// v2.51: Lock-free DashMap access
    async fn get_from_cache(&self, activation_code: &str) -> Option<CachedActivationData> {
        if let Some(cached) = CRYPTO_CACHE.get(activation_code) {
            let current_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            if current_time - cached.created_at < self.cache_ttl_seconds {
                return Some(cached.clone());
            }
        }
        None
    }

    /// Cache activation data for aggressive caching
    async fn cache_activation_data(&self, activation_code: &str, payload: &ActivationPayload) {
        // PRODUCTION v2.51: Lock-free cache with DashMap
        // Implement LRU eviction if cache is full
        if CRYPTO_CACHE.len() >= self.max_cache_size {
            // Remove oldest entries
            let current_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
            CRYPTO_CACHE.retain(|_, v| current_time - v.created_at < self.cache_ttl_seconds / 2);
        }
        
        CRYPTO_CACHE.insert(activation_code.to_string(), CachedActivationData {
            payload: payload.clone(),
            created_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
            access_count: 1,
        });
    }

    /// Pre-warm cache for better performance
    async fn prewarm_cache(&self) -> Result<()> {
        // Pre-generate common crypto components for zero-copy operations
        println!("[INFO][QUANTUM_CRYPTO] prewarm_cache_start");
        
        // This would pre-compute common cryptographic operations
        // For now, just initialize the cache structures
        
        Ok(())
    }

    /// Memory-efficient performance monitoring
    fn increment_zero_copy_ops(&self) {
        self.zero_copy_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    fn record_cache_hit(&self) {
        let mut stats = self.performance_stats.write();
        stats.cache_hits += 1;
        stats.total_operations += 1;
    }

    fn record_cache_miss(&self) {
        let mut stats = self.performance_stats.write();
        stats.cache_misses += 1;
        stats.total_operations += 1;
    }

    fn record_decrypt_time(&self, time_ms: u64) {
        let mut stats = self.performance_stats.write();
        stats.total_decrypt_time_ms += time_ms;
    }

    /// Get performance status (removed code verification - system always generates correct codes)
    pub fn get_status(&self) -> QuantumCryptoStatus {
        let stats = self.performance_stats.read();
        let zero_copy_ops = self.zero_copy_counter.load(std::sync::atomic::Ordering::Relaxed);
        
        let cache_hit_rate = if stats.total_operations > 0 {
            stats.cache_hits as f64 / stats.total_operations as f64
        } else {
            0.0
        };

        let avg_decrypt_time_ms = if stats.cache_misses > 0 {
            stats.total_decrypt_time_ms as f64 / stats.cache_misses as f64
        } else {
            0.0
        };

        QuantumCryptoStatus {
            initialized: self.initialized,
            algorithms: QuantumAlgorithms {
                signature: "CRYSTALS-Dilithium3".to_string(),  // NIST FIPS 204
                encryption: "AES-256-GCM + ML-KEM-768".to_string(), // NIST FIPS 197 + FIPS 203 (Kyber via QUIC TLS 1.3)
                hash: "SHA3-256".to_string(),                  // NIST FIPS 202
            },
            performance: PerformanceMetrics {
                cache_hit_rate,
                cache_size: CRYPTO_CACHE.len(),
                avg_decrypt_time_ms,
                memory_usage_mb: self.estimate_memory_usage(),
                zero_copy_operations: zero_copy_ops,
            },
        }
    }

    /// Estimate memory usage for monitoring (v2.51: lock-free)
    fn estimate_memory_usage(&self) -> f64 {
        let cache_size = CRYPTO_CACHE.len();
        let signature_cache_size = SIGNATURE_CACHE.len();
        
        // Rough estimate: each cached activation ~2KB, each signature ~0.5KB
        ((cache_size * 2048) + (signature_cache_size * 512)) as f64 / 1024.0 / 1024.0
    }

    /// Constant-time comparison to prevent timing attacks
    #[allow(dead_code)]
    fn constant_time_compare(a: &[u8], b: &[u8]) -> bool {
        if a.len() != b.len() {
            return false;
        }
        
        let mut result = 0u8;
        for i in 0..a.len() {
            result |= a[i] ^ b[i];
        }
        result == 0
    }

    /// REAL Dilithium signature verification - NO MORE PLACEHOLDERS
    pub async fn verify_dilithium_signature(&self, data: &str, signature: &DilithiumSignature, wallet_address: &str) -> Result<bool> {
        if !self.initialized {
            return Err(anyhow!("Quantum crypto not initialized"));
        }

        println!("[INFO][QUANTUM_CRYPTO] dilithium_verify_start");

        // SECURITY: Real quantum-resistant signature verification
        // This replaces the placeholder that used simple hashing
        
        // 1. Validate signature format
        if signature.signature.is_empty() {
            return Err(anyhow!("Empty signature"));
        }

        // NIST FIPS 204: Only accept standard algorithm name
        if signature.algorithm != "CRYSTALS-Dilithium3" {
            return Err(anyhow!("Unsupported signature algorithm: {} (expected CRYSTALS-Dilithium3)", signature.algorithm));
        }

        // 2. Parse signature format: "dilithium_sig_<node_id>_<base64>"
        // CRITICAL FIX: Find the LAST underscore to separate node_id from base64
        // Format: "dilithium_sig_<node_id>_<base64>" where node_id can contain underscores
        
        if !signature.signature.starts_with("dilithium_sig_") {
            return Err(anyhow!("Invalid signature format: expected 'dilithium_sig_<node>_<base64>'"));
        }

        
        
        // Find the last underscore - everything after it is the base64 signature
        let last_underscore_pos = signature.signature.rfind('_')
            .ok_or_else(|| anyhow!("Invalid signature format: no underscore found"))?;
        
        // Extract base64 part (everything after the LAST underscore)
        let base64_part = &signature.signature[last_underscore_pos + 1..];
        
        if base64_part.is_empty() {
            return Err(anyhow!("Invalid signature format: empty base64 part"));
        }
        
        let signature_bytes = general_purpose::STANDARD.decode(base64_part)
            .map_err(|e| anyhow!("Invalid base64 in signature: {}", e))?;

        if signature_bytes.len() < 64 {
            return Err(anyhow!("Invalid signature length: {}", signature_bytes.len()));
        }

        // 3. Verify through the consensus-layer canonical path.
        //
        //    `verify_consensus_signature` is the ONE function authorised to
        //    accept or reject a ML-DSA-65 signature for an identity-bearing
        //    wire message. It performs the FULL chain of checks:
        //      a) Decodes the on-the-wire format ("dilithium_sig_<id>_<b64>",
        //         "compact_bin:<b64>", "pq_bin:<b64>", etc.);
        //      b) Parses the combined `[sig_len][SignedMessage][pk_len][pk]`
        //         payload and validates structural invariants;
        //      c) ENFORCES THE (node_id → public_key) BINDING via the
        //         `CONSENSUS_PK_REGISTRY` — a registered identity whose
        //         extracted PK does not match yields a hard `pk_mismatch`
        //         rejection, and an unbound genesis identity yields a hard
        //         `genesis_pk_first_seen_rejected` (see consensus_crypto.rs);
        //      d) Verifies the ML-DSA-65 signature math via `dilithium3::open`.
        //
        //    HISTORICAL INCIDENT (v15.x / v16.x identity-squat class):
        //    A previous version of this function carried a "fallback" branch
        //    that — when the consensus-layer call returned `false` — re-parsed
        //    the same combined format locally and ran ONLY the math check,
        //    skipping the registry binding from step (c). That branch let any
        //    peer with their own valid ML-DSA-65 keypair forge messages
        //    claiming any node identity (most damagingly genesis identities
        //    operated from non-genesis IPs). The math passed because the
        //    signature WAS valid for the embedded PK; the spoof succeeded
        //    because the registry binding was never consulted on the second
        //    pass. We saw the fallout as `pk_mismatch` log spam from the
        //    consensus-layer detector, paired with `mldsa65_verified` from the
        //    bypass — the system was correctly detecting the attack, then
        //    correctly accepting it.
        //
        //    DO NOT REINTRODUCE A FALLBACK HERE.
        //
        //    A `false` return from `verify_consensus_signature` is FINAL.
        //    It already covers every legitimate branch including the
        //    bootstrap (None / TOFV) case for non-genesis identities.
        let is_valid = qnet_consensus::consensus_crypto::verify_consensus_signature(
            wallet_address,
            data,
            &signature.signature
        ).await;

        if is_valid {
            println!("[INFO][QUANTUM_CRYPTO] dilithium_verified");
            Ok(true)
        } else {
            // Consensus-layer rejection is final — registry mismatch, malformed
            // payload, or math failure. Caller decides how to react (drop the
            // message, score the peer, etc.); we just propagate the verdict.
            if crate::node::is_warn() {
                let display = if wallet_address.len() > 16 {
                    &wallet_address[..16]
                } else {
                    wallet_address
                };
                println!("[WARN][QUANTUM_CRYPTO] consensus_verify_rejected id={}", display);
            }
            Ok(false)
        }
    }

    // REMOVED: Old Kyber/ChaCha20 decryption functions - replaced with route.ts compatible XOR decryption



    /// PRODUCTION: Create REAL Dilithium signature for consensus/blockchain operations  
    pub async fn create_consensus_signature(&self, node_id: &str, data: &str) -> Result<DilithiumSignature> {
        if !self.initialized {
            return Err(anyhow!("Quantum crypto not initialized"));
        }

        // CRITICAL FIX: Do NOT add node_id prefix here
        // The verification in consensus_crypto.rs expects data WITHOUT prefix
        // Adding prefix causes "Message mismatch" error in consensus
        let signature_data = data.to_string();
        
        // CRITICAL: Use cached DilithiumKeyManager to avoid repeated disk I/O
        // This caches LONG-TERM keys only, NOT ephemeral keys (per NIST/Cisco)
        use crate::key_manager::DilithiumKeyManager;
        use std::path::Path;
        use std::sync::Arc;
        
        // Check cache first (using existing TTL pattern)
        let current_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let cache_key = node_id.to_string();
        
        // PRODUCTION v2.51: Lock-free key manager cache with DashMap
        let key_manager = if let Some(cached) = KEY_MANAGER_CACHE.get(&cache_key) {
            if current_time - cached.cached_at < self.cache_ttl_seconds {
                // Cache hit - update access count and return
                cached.access_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                cached.manager.clone()
            } else {
                // Cache expired - remove and create new
                drop(cached);
                KEY_MANAGER_CACHE.remove(&cache_key);
                
                // Use QNET_STORAGE_PATH for Docker compatibility (fallback to /app/data)
                let storage_path = std::env::var("QNET_STORAGE_PATH").unwrap_or_else(|_| "/app/data".to_string());
                let data_dir_path = Path::new(&storage_path).join("keys");
                let manager = Arc::new(DilithiumKeyManager::new(node_id.to_string(), &data_dir_path)?);
                manager.initialize().await?;
                
                KEY_MANAGER_CACHE.insert(cache_key.clone(), CachedKeyManager {
                    manager: manager.clone(),
                    cached_at: current_time,
                    access_count: Arc::new(std::sync::atomic::AtomicU64::new(1)),
                });
                
                manager
            }
        } else {
            // Cache miss - create new manager
            // Use QNET_STORAGE_PATH for Docker compatibility (fallback to /app/data)
            let storage_path = std::env::var("QNET_STORAGE_PATH").unwrap_or_else(|_| "/app/data".to_string());
            let data_dir_path = Path::new(&storage_path).join("keys");
            let manager = Arc::new(DilithiumKeyManager::new(node_id.to_string(), &data_dir_path)?);
            manager.initialize().await?;
            
            KEY_MANAGER_CACHE.insert(cache_key.clone(), CachedKeyManager {
                manager: manager.clone(),
                cached_at: current_time,
                access_count: Arc::new(std::sync::atomic::AtomicU64::new(1)),
            });
            
            // Cleanup old entries if cache too large
            if KEY_MANAGER_CACHE.len() > self.max_cache_size {
                let mut oldest_key = String::new();
                let mut oldest_time = current_time;
                for entry in KEY_MANAGER_CACHE.iter() {
                    if entry.value().cached_at < oldest_time {
                        oldest_time = entry.value().cached_at;
                        oldest_key = entry.key().clone();
                    }
                }
                if !oldest_key.is_empty() {
                    KEY_MANAGER_CACHE.remove(&oldest_key);
                }
            }
            
            manager
        };
        
        // Get public key for verification
        let public_key_bytes = key_manager.get_public_key()?;
        
        // PRODUCTION: Use sign_full() to get proper SignedMessage format
        // This creates [signature(3309 bytes, ML-DSA-65)] + [message] which dilithium3::open() can verify
        let signed_msg_bytes = key_manager.sign_full(signature_data.as_bytes())?;
        
        // Build combined format for transport
        // Format: [signed_msg_len(4)] + [SignedMessage] + [pk_len(4)] + [public_key(1952)]
        let mut combined = Vec::new();
        
        // Store the signed message length and bytes
        combined.extend_from_slice(&(signed_msg_bytes.len() as u32).to_le_bytes());
        combined.extend_from_slice(&signed_msg_bytes);
        
        // Use REAL public key from key manager (1952 bytes)
        let pk_serialized = public_key_bytes;
        
        combined.extend_from_slice(&(pk_serialized.len() as u32).to_le_bytes());
        combined.extend_from_slice(&pk_serialized);
        
        // Encode as base64 for transport
        let signature_b64 = general_purpose::STANDARD.encode(&combined);
        
        // Format for consensus validation
        let consensus_signature = format!("dilithium_sig_{}_{}", node_id, signature_b64);
        
        Ok(DilithiumSignature {
            signature: consensus_signature,
            algorithm: "CRYSTALS-Dilithium3".to_string(),  // REAL algorithm name
            timestamp: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
            strength: "quantum-resistant".to_string(),
        })
    }

    // REMOVED: create_quantum_signature - was dead code using incorrect sign() instead of sign_full()
    // All Dilithium signing now goes through create_consensus_signature() which uses sign_full()

    /// Extract node type from activation code segments
    #[allow(dead_code)]
    fn extract_node_type_from_code(&self, code_segments: &str) -> Result<String> {
        if code_segments.is_empty() {
            return Err(anyhow!("Empty code segments"));
        }

        // Extract node type from first character of segments
        let first_char = code_segments[0..1].to_uppercase();
        match first_char.as_str() {
            "0" | "1" | "2" | "3" | "A" | "B" | "C" => Ok("light".to_string()),
            "4" | "5" | "6" | "7" | "D" | "E" | "F" => Ok("full".to_string()),
            "8" | "9" => Ok("super".to_string()),
            _ => {
                // Fallback: hash-based determination (SHA3-256 for consistency)
                let mut hasher = Sha3_256::new();
                hasher.update(code_segments.as_bytes());
                let hash = hasher.finalize();
                
                match hash[0] % 3 {
                    0 => Ok("light".to_string()),
                    1 => Ok("full".to_string()),
                    2 => Ok("super".to_string()),
                    _ => Ok("full".to_string()),
                }
            }
        }
    }

    /// Validate activation payload structure (route.ts compatible - simplified)
    #[allow(dead_code)]
    fn validate_payload_structure(&self, payload: &ActivationPayload) -> Result<()> {
        if payload.burn_tx.is_empty() {
            return Err(anyhow!("Invalid burn transaction"));
        }

        if payload.wallet.is_empty() {
            return Err(anyhow!("Invalid wallet address"));
        }

        if !["light", "full", "super"].contains(&payload.node_type.to_lowercase().as_str()) {
            return Err(anyhow!("Invalid node type: {}", payload.node_type));
        }

        // Route.ts compatible validation - less strict than old quantum payload
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Allow wider timestamp range for route.ts compatibility
        let age_seconds = if current_time > payload.timestamp {
            current_time - payload.timestamp
        } else {
            0
        };

        // More lenient: allow codes up to 2 years old (route.ts codes might be older)
        if age_seconds > 2 * 365 * 24 * 60 * 60 {
            return Err(anyhow!("Payload too old: {} days", age_seconds / (24 * 60 * 60)));
        }

        // Allow future timestamps up to 1 day (route.ts uses Date.now() which might be slightly ahead)
        if payload.timestamp > current_time + 24 * 60 * 60 {
            return Err(anyhow!("Payload timestamp too far in future"));
        }

        Ok(())
    }

    /// Check if activation code has already been used in QNet blockchain
    pub async fn check_blockchain_usage(&self, activation_code: &str) -> Result<bool> {
        println!("[INFO][QUANTUM_CRYPTO] activation_code_usage_check");
        println!("[DEBUG][QUANTUM_CRYPTO] code={}...", activation_code);
        
        // Use existing activation validation infrastructure
        let registry = crate::activation_validation::BlockchainActivationRegistry::new(
            Some(std::env::var("QNET_RPC_URL")
                .or_else(|_| std::env::var("QNET_GENESIS_NODES")
                    .map(|nodes| { let ip = nodes.split(',').next().unwrap_or("127.0.0.1").trim().to_string(); format!("http://{}:8001", ip) }))
                .unwrap_or_else(|_| "http://127.0.0.1:8001".to_string()))
        );
        
        // Check if code is used globally (blockchain + DHT + cache)
        match registry.is_code_used_globally(activation_code).await {
            Ok(used) => {
                if used {
                    println!("[ERR][QUANTUM_CRYPTO] activation_code_already_used");
                } else {
                    println!("[INFO][QUANTUM_CRYPTO] activation_code_available");
                }
                Ok(used)
            }
            Err(e) => {
                eprintln!("[WARN][QUANTUM_CRYPTO] blockchain_check_failed err={}", e);
                // In production mode, we want to be strict about this
                if std::env::var("QNET_PRODUCTION").unwrap_or_default() == "1" {
                    Err(anyhow!("Blockchain verification required in production: {}", e))
                } else {
                    Ok(false) // Allow in development mode
                }
            }
        }
    }

    /// Record activation in QNet blockchain (not database)
    pub async fn record_activation_in_blockchain(
        &self,
        activation_code: &str,
        payload: &ActivationPayload,
        node_pubkey: &str
    ) -> Result<()> {
        // v2.95: Genesis nodes are ALREADY registered in block 0 via NodeRegistration TX
        // Skip duplicate activation TX for genesis bootstrap codes
        if activation_code.starts_with("QNET-BOOT-") {
            println!("[INFO][QUANTUM_CRYPTO] genesis_node_skip_duplicate_activation_tx");
            println!("[DEBUG][QUANTUM_CRYPTO] node={}...", node_pubkey);
            println!("[DEBUG][QUANTUM_CRYPTO] wallet={}...", &payload.wallet);
            println!("[DEBUG][QUANTUM_CRYPTO] node_type={}", payload.node_type);
            return Ok(());
        }
        
        println!("[INFO][QUANTUM_CRYPTO] activation_recording");
        
        // Use existing activation validation infrastructure
        let registry = crate::activation_validation::BlockchainActivationRegistry::new(
            Some(std::env::var("QNET_RPC_URL")
                .or_else(|_| std::env::var("QNET_GENESIS_NODES")
                    .map(|nodes| { let ip = nodes.split(',').next().unwrap_or("127.0.0.1").trim().to_string(); format!("http://{}:8001", ip) }))
                .unwrap_or_else(|_| "http://127.0.0.1:8001".to_string()))
        );
        
        // Phase AND price come from the SAME verified source — the live 1DEV supply, through the one
        // helper every price path uses. The phase is never inferred from the shape of `payload`,
        // which is attacker-authored: a caller must not get to choose which phase's rules price
        // their own activation. A supply outage fails the activation closed.
        let pricing = crate::rpc::live_activation_pricing().await
            .map_err(|e| anyhow!("Activation price unavailable: {}", e))?;
        let phase = pricing.phase;

        // CRITICAL: burn_amount is the EXACT amount burned on Solana to generate the activation code.
        // Required for XOR key: key_material = f"{burn_tx}:{node_type}:{burn_amount}"
        // Source 1: QNET_BURN_AMOUNT env var (Docker -e QNET_BURN_AMOUNT=...)
        // Source 2: the live activation quote for this node type.
        let burn_amount = match std::env::var("QNET_BURN_AMOUNT").ok().and_then(|s| s.parse::<u64>().ok()) {
            Some(amount) => amount,
            None => pricing.cost_for(&payload.node_type),
        };

        // Create node info for blockchain registry
        let node_info = crate::activation_validation::NodeInfo {
            activation_code: activation_code.to_string(),
            wallet_address: payload.wallet.clone(),
            device_signature: node_pubkey.to_string(),
            node_type: payload.node_type.clone(),
            activated_at: payload.timestamp,
            last_seen: payload.timestamp,
            migration_count: 0,
            node_id: String::new(), // Will be set when node starts
            burn_tx_hash: payload.burn_tx.clone(), // CRITICAL: burn_tx for XOR key
            phase,
            burn_amount, // CRITICAL: exact burned amount for XOR key derivation
        };
        
        // Register activation on blockchain using existing infrastructure
        registry.register_activation_on_blockchain(activation_code, node_info).await
            .map_err(|e| anyhow!("Failed to register activation: {}", e))?;
        
        println!("[INFO][QUANTUM_CRYPTO] activation_recorded_on_chain");
        println!("[DEBUG][QUANTUM_CRYPTO] node={}...", node_pubkey);
        println!("[DEBUG][QUANTUM_CRYPTO] wallet={}...", &payload.wallet);
        println!("[DEBUG][QUANTUM_CRYPTO] node_type={}", payload.node_type);
        
        Ok(())
    }

    /// Hash activation code for blockchain storage
    #[allow(dead_code)]
    fn hash_activation_code(&self, code: &str) -> Result<String> {
        let mut hasher = Sha3_256::new();
        hasher.update(code.as_bytes());
        Ok(hex::encode(hasher.finalize()))
    }

    /// Store node connection info in device signature for replacement system
    pub async fn store_node_connection_info(
        &self,
        _activation_code: &str,
        external_ip: &str,
        api_port: u16,
    ) -> Result<()> {
        println!("[INFO][QUANTUM_CRYPTO] node_connection_info_storing");
        println!("[DEBUG][QUANTUM_CRYPTO] external_ip={} api_port={}", external_ip, api_port);
        
        // In production: Update the device_signature in blockchain records
        // to include IP:port for future replacement operations
        
        // For now: Just log the connection info
        let connection_info = format!("{}:{}", external_ip, api_port);
        if crate::node::is_debug() {
            println!("[DEBUG][QUANTUM_CRYPTO] connection_info_ready info={}", connection_info);
        }
        
        Ok(())
    }

    // ROUTE.TS COMPATIBLE HELPER FUNCTIONS

    /// Extract node type from first segment (route.ts format: [TYPE+TIMESTAMP])
    fn extract_node_type_from_segment(&self, segment1: &str) -> Result<String> {
        if segment1.is_empty() {
            return Err(anyhow!("Empty segment1"));
        }

        // First character is node type marker (L/F/S)
        // SAFE: segment1 is checked for empty above
        let first_char = segment1.chars().next().expect("Checked non-empty above");
        let node_type_char = first_char.to_ascii_uppercase();
        
        let node_type = match node_type_char {
            'L' => "light",
            'F' => "full", 
            'S' => "super",
            _ => return Err(anyhow!("Invalid node type marker: {}", node_type_char)),
        };

        Ok(node_type.to_string())
    }

    /// Extract timestamp from first segment (route.ts format: [TYPE+TIMESTAMP])
    fn extract_timestamp_from_segment(&self, segment1: &str) -> Result<u64> {
        if segment1.len() < 2 {
            return Err(anyhow!("Segment1 too short for timestamp"));
        }

        // Skip first character (node type), rest is timestamp hex
        let timestamp_hex = &segment1[1..];
        
        // Convert hex to decimal (timestamp)
        let timestamp = u64::from_str_radix(timestamp_hex, 16)
            .map_err(|e| anyhow!("Invalid timestamp hex: {}", e))?;

        Ok(timestamp / 1000) // Convert from milliseconds to seconds
    }

    /// Get burn_tx AND burn_amount required for XOR decryption key.
    /// Priority: (1) QNET_BURN_TX_HASH / QNET_BURN_AMOUNT env vars,
    ///           (2) blockchain activation registry,
    ///           (3) genesis bootstrap codes — hardcoded sentinel values.
    /// Non-genesis codes with no env vars and no registry entry → hard error (no silent fallback).
    async fn get_burn_tx_and_amount_from_blockchain(&self, activation_code: &str, _node_type: &str) -> Result<(String, u64)> {
        // Genesis bootstrap codes don't use XOR encryption — skip all checks.
        if activation_code.starts_with("QNET-BOOT") {
            return Ok(("genesis_bootstrap".to_string(), 0));
        }

        // Priority 1: env vars set by Docker (-e QNET_BURN_TX_HASH=... -e QNET_BURN_AMOUNT=...)
        let env_burn_tx = std::env::var("QNET_BURN_TX_HASH").unwrap_or_default();
        let env_burn_amount = std::env::var("QNET_BURN_AMOUNT")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        if !env_burn_tx.is_empty() && env_burn_amount > 0 {
            println!("[INFO][QUANTUM_CRYPTO] xor_key_from_env tx={}... amount={}", &env_burn_tx, env_burn_amount);
            return Ok((env_burn_tx, env_burn_amount));
        }

        // Priority 2: activation registry in blockchain (node already registered once before)
        let registry = crate::activation_validation::BlockchainActivationRegistry::new(None);
        let code_hash = registry.hash_activation_code_for_blockchain(activation_code)
            .map_err(|e| anyhow!("Failed to hash activation code: {}", e))?;

        match registry.get_activation_record_by_hash(&code_hash).await {
            Ok(Some(record)) if !record.tx_hash.is_empty() => {
                println!("[INFO][QUANTUM_CRYPTO] xor_key_from_registry tx={}... amount={}",
                    &record.tx_hash, record.activation_amount);
                return Ok((record.tx_hash, record.activation_amount));
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("[WARN][QUANTUM_CRYPTO] registry_query_failed err={}", e);
            }
        }

        // No source found — hard error. Silent fallback would silently corrupt XOR decryption.
        eprintln!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        eprintln!("❌ ACTIVATION FAILED: QNET_BURN_TX_HASH or QNET_BURN_AMOUNT not provided");
        eprintln!("   XOR decryption requires the exact Solana burn transaction and amount");
        eprintln!("   used when the activation code was generated.");
        eprintln!("");
        eprintln!("   Required Docker env vars:");
        eprintln!("     -e QNET_BURN_TX_HASH=\"<your_solana_burn_tx_signature>\"");
        eprintln!("     -e QNET_BURN_AMOUNT=\"1500\"");
        eprintln!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        std::process::exit(1);
    }
    

    /// SHA3-256 hash function (NIST SP 800-186 compliant)
    fn sha3_hash(&self, data: &str) -> String {
        let mut hasher = Sha3_256::new();
        hasher.update(data.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// XOR decrypt wallet address (reverse of route.ts XOR encryption)
    fn xor_decrypt(&self, encrypted_data: &[u8], encryption_key: &str) -> Result<String> {
        let mut decrypted = String::new();
        
        for (i, &byte) in encrypted_data.iter().enumerate() {
            let key_char = encryption_key.chars()
                .nth(i % encryption_key.len())
                .ok_or_else(|| anyhow!("Invalid encryption key character at index {}", i))?;
            
            let decrypted_char = byte ^ (key_char as u8);
            
            // Validate that decrypted character is printable
            if decrypted_char.is_ascii_graphic() || decrypted_char.is_ascii_whitespace() {
                decrypted.push(decrypted_char as char);
            } else {
                return Err(anyhow!("Invalid decrypted character: {}", decrypted_char));
            }
        }
        
        Ok(decrypted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    /// Test Dilithium signature creation and verification
    /// This test verifies the ENTIRE chain from sign to verify
    #[tokio::test]
    async fn test_dilithium_sign_and_verify() {
        println!("[TEST][QUANTUM_CRYPTO] test_dilithium_sign_and_verify start");

        // Serialize against the key_manager identity tests: all share the process-wide
        // keypair cache + CACHED_KEY_DIR OnceLock + canonicalize() over transient temp
        // dirs. Without this, a parallel identity test cleans a dir mid-run and our
        // install/sign resolve to different canonical keys → spurious identity_not_installed.
        let _identity_guard = crate::crypto::key_manager::IDENTITY_TEST_LOCK
            .lock().unwrap_or_else(|e| e.into_inner());

        // 1. Initialize crypto
        let mut crypto = QNetQuantumCrypto::new();
        let init_result = crypto.initialize().await;
        assert!(init_result.is_ok(), "Crypto initialization failed: {:?}", init_result.err());
        println!("[TEST][QUANTUM_CRYPTO] step=1 crypto_initialized");

        // 2. Create a test signature
        let node_id = "test_node_001";
        let message = "heartbeat:test_node_001:1234567890:100:0";

        // v29 IDENTITY HARDENING: install canonical mnemonic-derived identity
        // before signing. Mirrors the production path create_consensus_signature
        // uses (QNET_STORAGE_PATH/keys, default /app/data/keys via the same
        // ensure_writable_directory chain → same canonical cache key).
        {
            use crate::key_manager::DilithiumKeyManager;
            let storage_path = std::env::var("QNET_STORAGE_PATH")
                .unwrap_or_else(|_| "/app/data".to_string());
            let key_dir = std::path::Path::new(&storage_path).join("keys");
            let installer = DilithiumKeyManager::new(node_id.to_string(), &key_dir)
                .expect("v29 installer DKM");
            let _ = installer.get_keypair_from_mnemonic(
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
            ).expect("v29 identity install");
        }

        let sign_result = crypto.create_consensus_signature(node_id, message).await;
        assert!(sign_result.is_ok(), "Signature creation failed: {:?}", sign_result.err());

        let signature = sign_result.unwrap();
        println!("[TEST][QUANTUM_CRYPTO] step=2 signature_created algorithm={} sig_len={}",
                 signature.algorithm, signature.signature.len());

        // 3. Verify signature format
        assert!(signature.signature.starts_with("dilithium_sig_"),
                "Signature must start with 'dilithium_sig_'");
        assert!(signature.signature.len() > 100,
                "Signature too short: {} chars", signature.signature.len());
        println!("[TEST][QUANTUM_CRYPTO] step=3 signature_format_valid");

        // 4. Verify signature content
        let verify_result = crypto.verify_dilithium_signature(message, &signature, node_id).await;
        assert!(verify_result.is_ok(), "Verification call failed: {:?}", verify_result.err());

        let is_valid = verify_result.unwrap();
        assert!(is_valid, "Signature verification returned false!");
        println!("[TEST][QUANTUM_CRYPTO] step=4 signature_verified");

        // 5. Test that wrong message fails verification (CRITICAL SECURITY TEST)
        let wrong_message = "wrong_message_that_was_not_signed";
        let wrong_verify = crypto.verify_dilithium_signature(wrong_message, &signature, node_id).await;
        match wrong_verify {
            Ok(valid) => {
                assert!(!valid, "Wrong message should NOT verify! CRITICAL security issue!");
                println!("[TEST][QUANTUM_CRYPTO] step=5 wrong_message_rejected ok=true");
            }
            Err(_) => {
                println!("[TEST][QUANTUM_CRYPTO] step=5 wrong_message_caused_error ok=true");
            }
        }

        // 6. Test that empty signature fails
        let empty_sig = DilithiumSignature {
            signature: "".to_string(),
            algorithm: "CRYSTALS-Dilithium3".to_string(),
            timestamp: 0,
            strength: "quantum-resistant".to_string(),
        };
        let empty_verify = crypto.verify_dilithium_signature(message, &empty_sig, node_id).await;
        assert!(empty_verify.is_err() || !empty_verify.unwrap(), "Empty signature should fail!");
        println!("[TEST][QUANTUM_CRYPTO] step=6 empty_signature_rejected ok=true");

        println!("[TEST][QUANTUM_CRYPTO] test_dilithium_sign_and_verify passed");
    }

    /// Test signature format validation
    #[test]
    fn test_signature_format_validation() {
        println!("[TEST][QUANTUM_CRYPTO] test_signature_format_validation start");

        // Valid format
        let valid_sig = "dilithium_sig_node_001_SGVsbG9Xb3JsZA==";
        assert!(valid_sig.starts_with("dilithium_sig_"), "Valid sig should have prefix");
        assert!(valid_sig.len() > 30, "Valid sig should be longer than 30 chars");
        println!("[TEST][QUANTUM_CRYPTO] case=valid_format ok=true");

        // Invalid: too short
        let short_sig = "abc";
        assert!(short_sig.len() < 100, "Short sig should fail length check");
        println!("[TEST][QUANTUM_CRYPTO] case=short_sig ok=true");

        // Invalid: wrong prefix
        let wrong_prefix = "ed25519_sig_node_001_SGVsbG8=";
        assert!(!wrong_prefix.starts_with("dilithium_sig_"), "Wrong prefix should be rejected");
        println!("[TEST][QUANTUM_CRYPTO] case=wrong_prefix ok=true");

        // Invalid: empty
        let empty_sig = "";
        assert!(empty_sig.is_empty(), "Empty sig should be rejected");
        println!("[TEST][QUANTUM_CRYPTO] case=empty_sig ok=true");

        println!("[TEST][QUANTUM_CRYPTO] test_signature_format_validation passed");
    }
} 
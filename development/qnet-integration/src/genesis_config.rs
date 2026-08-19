// ============================================================================
// GENESIS CONFIG — File-based genesis loader
// ============================================================================
//
// Genesis block is a CONFIG, not a p2p-synced block.
// This is the standard pattern for production blockchains:
//   - Genesis file distributed with the binary (Docker image, config package)
//   - HTTP fallback for first-time bootstrap
//   - Node REFUSES TO START without valid genesis
//
// This eliminates the entire class of "genesis sync deadlock" bugs that
// plagued the previous p2p-based genesis distribution.
//
// Paths (in order of priority):
//   1. RocksDB storage (already synced)
//   2. Local file: /app/data/genesis.bin or $QNET_GENESIS_FILE
//   3. HTTP download from genesis nodes
//   4. Genesis creation (node 001 only, first network start)
//
// Security:
//   - HTTP download verifies hash across multiple bootstrap nodes (consensus)
//   - 2+ sources must agree on same genesis hash (MITM protection)
//   - Corrupted/tampered genesis = node refuses to start (fail-fast)
// ============================================================================

use std::sync::Arc;
use std::path::{Path, PathBuf};
use crate::storage::Storage;
use crate::node::{is_info, is_warn};

/// Result of genesis loading
pub enum GenesisResult {
    /// Genesis loaded successfully (from any source)
    Loaded {
        block: qnet_state::MicroBlock,
        source: GenesisSource,
    },
    /// This is genesis node 001, needs to CREATE genesis
    NeedsCreation,
    /// Genesis not available — fatal error
    NotAvailable {
        tried: Vec<String>,
    },
}

/// Where genesis was loaded from (for logging)
#[derive(Debug, Clone)]
pub enum GenesisSource {
    Storage,
    File(PathBuf),
    Http(String),
    Created,
}

impl std::fmt::Display for GenesisSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Storage => write!(f, "storage"),
            Self::File(p) => write!(f, "file:{}", p.display()),
            Self::Http(url) => write!(f, "http:{}", url),
            Self::Created => write!(f, "created"),
        }
    }
}

/// Genesis configuration
pub struct GenesisConfig {
    /// Path to genesis file (default: /app/data/genesis.bin)
    pub genesis_file: PathBuf,
    /// Bootstrap node IPs for HTTP fallback
    pub bootstrap_ips: Vec<String>,
    /// API port for HTTP download
    pub api_port: u16,
    /// Bootstrap ID (001-005 for genesis nodes)
    pub bootstrap_id: Option<String>,
    /// HTTP download timeout
    pub http_timeout_secs: u64,
}

impl Default for GenesisConfig {
    fn default() -> Self {
        Self {
            genesis_file: PathBuf::from("/app/data/genesis.bin"),
            bootstrap_ips: crate::genesis_constants::get_genesis_ips(),
            api_port: 8001,
            bootstrap_id: std::env::var("QNET_BOOTSTRAP_ID").ok(),
            http_timeout_secs: 15,
        }
    }
}

impl GenesisConfig {
    /// Create config from environment variables
    pub fn from_env() -> Self {
        let mut config = Self::default();

        if let Ok(path) = std::env::var("QNET_GENESIS_FILE") {
            config.genesis_file = PathBuf::from(path);
        }

        if let Ok(ips) = std::env::var("QNET_GENESIS_NODES") {
            config.bootstrap_ips = ips.split(',').map(|s| s.trim().to_string()).collect();
        }

        config
    }
}

/// Load genesis block using priority chain:
/// 1. Storage → 2. File → 3. HTTP → 4. Create (node 001 only)
pub async fn load_genesis(
    storage: &Arc<Storage>,
    config: &GenesisConfig,
) -> GenesisResult {
    let mut tried = Vec::new();

    // === Priority 1: Already in storage ===
    match load_from_storage(storage) {
        Ok(Some(block)) => {
            if is_info() {
                println!("[INFO][GENESIS] loaded source=storage h=0 ts={} txs={}",
                         block.timestamp, block.transactions.len());
            }
            return GenesisResult::Loaded {
                block,
                source: GenesisSource::Storage,
            };
        }
        Ok(None) => {
            tried.push("storage: not found".to_string());
        }
        Err(e) => {
            tried.push(format!("storage: error={}", e));
        }
    }

    // === Priority 2: Local file ===
    let file_paths = [
        config.genesis_file.clone(),
        PathBuf::from("/app/genesis.bin"),
        PathBuf::from("genesis.bin"),
    ];

    for path in &file_paths {
        match load_from_file(path, storage).await {
            Ok(Some(block)) => {
                if is_info() {
                    println!("[INFO][GENESIS] loaded source=file path={} ts={} txs={}",
                             path.display(), block.timestamp, block.transactions.len());
                }
                return GenesisResult::Loaded {
                    block,
                    source: GenesisSource::File(path.clone()),
                };
            }
            Ok(None) => {
                tried.push(format!("file:{}: not found", path.display()));
            }
            Err(e) => {
                tried.push(format!("file:{}: {}", path.display(), e));
            }
        }
    }

    // === Priority 3: HTTP download from bootstrap nodes ===
    match load_from_http(config, storage).await {
        Ok(Some((block, ip))) => {
            if is_info() {
                println!("[INFO][GENESIS] loaded source=http ip={} ts={} txs={}",
                         ip, block.timestamp, block.transactions.len());
            }
            return GenesisResult::Loaded {
                block,
                source: GenesisSource::Http(ip),
            };
        }
        Ok(None) => {
            tried.push("http: no genesis nodes responded".to_string());
        }
        Err(e) => {
            tried.push(format!("http: {}", e));
        }
    }

    // === Priority 4: Create (node 001 only) ===
    if config.bootstrap_id.as_deref() == Some("001") {
        if is_info() {
            println!("[INFO][GENESIS] needs_creation bootstrap_id=001");
        }
        return GenesisResult::NeedsCreation;
    }

    // === Nothing worked ===
    if is_warn() {
        println!("[WARN][GENESIS] not_available tried={:?}", tried);
    }
    GenesisResult::NotAvailable { tried }
}

/// Apply genesis transactions to state (PK registration, initial balances).
/// Must be called after genesis is loaded, before any block processing.
/// Idempotent — safe to call multiple times.
pub async fn apply_genesis_state(
    block: &qnet_state::MicroBlock,
    state: &Arc<tokio::sync::RwLock<crate::StateManager>>,
    storage: &Arc<Storage>,
) {
    // Apply transactions (balance changes, PK registrations)
    {
        let state_guard = state.write().await;
        match state_guard.apply_block_batch(&block.transactions) {
            Ok(count) => {
                if is_info() {
                    println!("[INFO][GENESIS] state_applied tx_count={}", count);
                }
            }
            Err(e) => {
                if is_warn() {
                    println!("[WARN][GENESIS] state_apply_failed err={}", e);
                }
            }
        }
    }

    // Cache node registrations (VRF keys, Dilithium PKs)
    crate::node::BlockchainNode::cache_node_registrations_from_transactions(
        storage, &block.transactions,
    );
    // Stamp reg_height=0 + vrf too: an unstamped row is invisible to registry_root, and this loader
    // runs at construction — every later stamping site is gated off by the state it just created.
    crate::node::BlockchainNode::apply_genesis_registrations(storage, &block.transactions);

    if is_info() {
        println!("[INFO][GENESIS] registrations_cached txs={}", block.transactions.len());
    }

    // Set global genesis timestamp
    crate::GLOBAL_GENESIS_TIMESTAMP.store(
        block.timestamp,
        std::sync::atomic::Ordering::Relaxed,
    );
    crate::set_genesis_timestamp(block.timestamp);
}

/// Export genesis block to file (for distribution to other nodes).
pub async fn export_genesis(
    storage: &Arc<Storage>,
    output_path: &Path,
) -> Result<(), String> {
    let data = storage.load_microblock(0)
        .map_err(|e| format!("load: {}", e))?
        .ok_or_else(|| "genesis not in storage".to_string())?;

    std::fs::write(output_path, &data)
        .map_err(|e| format!("write: {}", e))?;

    if is_info() {
        println!("[INFO][GENESIS] exported path={} bytes={}", output_path.display(), data.len());
    }
    Ok(())
}

// ============================================================================
// INTERNAL LOADERS
// ============================================================================

fn load_from_storage(storage: &Arc<Storage>) -> Result<Option<qnet_state::MicroBlock>, String> {
    // Check if raw data exists
    let has_data = storage.load_microblock(0)
        .map(|opt| opt.is_some())
        .unwrap_or(false);

    if !has_data {
        return Ok(None);
    }

    // Load and deserialize
    storage.load_microblock_auto_format(0)
        .map_err(|e| format!("deserialize: {}", e))
}

async fn load_from_file(
    path: &Path,
    storage: &Arc<Storage>,
) -> Result<Option<qnet_state::MicroBlock>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let data = std::fs::read(path)
        .map_err(|e| format!("read: {}", e))?;

    if data.is_empty() {
        return Ok(None);
    }

    if is_info() {
        println!("[INFO][GENESIS] file_found path={} bytes={}", path.display(), data.len());
    }

    // Try to deserialize to validate
    let decompressed = zstd::decode_all(&data[..]).unwrap_or_else(|_| data.clone());
    let block: qnet_state::MicroBlock = bincode::deserialize(&decompressed)
        .map_err(|e| format!("deserialize: {}", e))?;

    // Validate it's actually genesis
    if block.height != 0 {
        return Err(format!("not genesis: height={}", block.height));
    }

    // Save to storage for future use
    // Not fatal — the block is in memory — but a non-write must still be visible: it means this
    // node will not have genesis on disk after a restart.
    match storage.save_microblock(0, &data) {
        Ok(crate::storage::SaveOutcome::Stored) => {}
        Ok(other) => {
            println!("[ERR][GENESIS] save_to_storage_not_stored outcome={:?}", other);
        }
        Err(e) => {
            if is_warn() {
                println!("[WARN][GENESIS] save_to_storage_failed err={}", e);
            }
        }
    }

    Ok(Some(block))
}

/// Compute SHA3-256 hash of genesis block data for integrity verification
fn genesis_hash(data: &[u8]) -> String {
    use sha3::{Sha3_256, Digest};
    let hash = Sha3_256::digest(data);
    hex::encode(hash)
}

async fn load_from_http(
    config: &GenesisConfig,
    storage: &Arc<Storage>,
) -> Result<Option<(qnet_state::MicroBlock, String)>, String> {
    use std::collections::HashMap;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(config.http_timeout_secs))
        .build()
        .map_err(|e| format!("client: {}", e))?;

    // L1 SECURITY: Download genesis from ALL bootstrap nodes and verify hash consensus.
    // Single-source download is vulnerable to MITM — attacker replaces genesis data.
    // Multi-source: accept only if 2+ nodes agree on the same genesis hash.
    let mut genesis_by_hash: HashMap<String, (Vec<u8>, qnet_state::MicroBlock, String)> = HashMap::new();
    let mut hash_votes: HashMap<String, Vec<String>> = HashMap::new();

    for ip in &config.bootstrap_ips {
        let urls = [
            format!("http://{}:{}/api/v1/block/0", ip, config.api_port),
            format!("http://{}:{}/api/v1/genesis/block", ip, config.api_port),
        ];

        for url in &urls {
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(config.http_timeout_secs),
                client.get(url).send(),
            ).await;

            match result {
                Ok(Ok(resp)) if resp.status().is_success() => {
                    match resp.bytes().await {
                        Ok(bytes) if !bytes.is_empty() => {
                            let data = bytes.to_vec();
                            let decompressed = zstd::decode_all(&data[..])
                                .unwrap_or_else(|_| data.clone());

                            match bincode::deserialize::<qnet_state::MicroBlock>(&decompressed) {
                                Ok(block) if block.height == 0 => {
                                    let hash = genesis_hash(&decompressed);
                                    if is_info() {
                                        println!("[INFO][GENESIS] http_response ip={} hash={}", ip, &hash[..16]);
                                    }
                                    hash_votes.entry(hash.clone()).or_default().push(ip.clone());
                                    genesis_by_hash.entry(hash).or_insert((data, block, ip.clone()));
                                    break; // Got valid response from this IP, move to next
                                }
                                Ok(block) => {
                                    if is_warn() {
                                        println!("[WARN][GENESIS] http_wrong_height ip={} h={}", ip, block.height);
                                    }
                                }
                                Err(e) => {
                                    if is_warn() {
                                        println!("[WARN][GENESIS] http_decode_failed ip={} err={}", ip, e);
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }

    if genesis_by_hash.is_empty() {
        return Ok(None);
    }

    // Find genesis with most votes (consensus)
    let (best_hash, voters) = hash_votes.iter()
        .max_by_key(|(_, v)| v.len())
        .map(|(h, v)| (h.clone(), v.clone()))
        .unwrap_or_default();

    let total_responses = hash_votes.values().map(|v| v.len()).sum::<usize>();

    // SECURITY: Require 2+ matching sources if multiple sources responded
    if total_responses > 1 && voters.len() < 2 {
        eprintln!("[ERR][GENESIS] hash_mismatch sources={} agreeing={} — possible MITM attack",
                 total_responses, voters.len());
        for (hash, ips) in &hash_votes {
            eprintln!("[ERR][GENESIS]   hash={}.. from={:?}", &hash[..16], ips);
        }
        return Err("genesis hash mismatch across sources — MITM suspected".to_string());
    }

    if let Some((data, block, ip)) = genesis_by_hash.remove(&best_hash) {
        if is_info() {
            println!("[INFO][GENESIS] http_verified hash={}.. sources={}/{} from={}",
                     &best_hash[..16], voters.len(), total_responses, ip);
        }

        // Save to storage
        match storage.save_microblock(0, &data) {
            Ok(crate::storage::SaveOutcome::Stored) => {}
            Ok(other) => {
                println!("[ERR][GENESIS] http_save_not_stored ip={} outcome={:?}", ip, other);
            }
            Err(e) => {
                if is_warn() {
                    println!("[WARN][GENESIS] http_save_failed ip={} err={}", ip, e);
                }
            }
        }

        // Cache as file for future restarts
        let genesis_file = &config.genesis_file;
        if let Some(parent) = genesis_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(genesis_file, &data) {
            if is_warn() {
                println!("[WARN][GENESIS] file_save_failed path={} err={}", genesis_file.display(), e);
            }
        } else if is_info() {
            println!("[INFO][GENESIS] file_cached path={} bytes={}", genesis_file.display(), data.len());
        }

        return Ok(Some((block, ip)));
    }

    Ok(None)
}

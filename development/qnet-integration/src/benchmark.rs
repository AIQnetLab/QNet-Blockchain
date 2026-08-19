//! QNet Benchmark Module - Real Transaction Load Testing
//!
//! Generates REAL Transfer transactions between test accounts with full
//! cryptographic validation (pure ML-DSA-65 / Dilithium3 signatures).
//!
//! This is NOT synthetic - transactions go through the entire pipeline:
//! - Full post-quantum signature validation
//! - P2P broadcast to all nodes
//! - Mempool processing
//! - Block inclusion
//!
//! ## v2.41.2: STABILITY-FIRST Presets
//!
//! ### SAFE Presets (recommended for single-node testing):
//! - "stability_test"  : 5K TPS,  50K TX   - GUARANTEED STABLE! ✅ (DEFAULT)
//! - "stress_test"     : 20K TPS, 200K TX  - Find real capacity
//! - "max_capacity"    : 50K TPS, 500K TX  - Push to safe limit
//! - "progressive_max" : AUTO-FIND MAX!    - Starts 5K, +5K every 10s until limit
//!
//! ### DANGEROUS Presets:
//! - "single_shard"  : 100K TPS ⚠️
//! - "small_scale"   : 100K TPS ⚠️
//! - "medium_scale"  : 100K TPS ⚠️
//! - "large_scale"   : 100K TPS ⚠️
//! - "extra_large"   : 100K TPS ⚠️
//! - "full_scale"    : 100K TPS ⚠️
//!
//! ## API Examples:
//! POST /api/v1/benchmark/start                              → stability_test (SAFE)
//! POST /api/v1/benchmark/start { "preset": "stability_test" } → 5K TPS, stable
//! POST /api/v1/benchmark/start { "preset": "stress_test" }    → 20K TPS, moderate
//! POST /api/v1/benchmark/start { "preset": "max_capacity" }   → 50K TPS, high load
//! POST /api/v1/benchmark/start { "target_tps": 10000, "total": 100000 } → custom
//! GET /api/v1/benchmark/status
//! GET /api/v1/benchmark/results

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use serde::{Deserialize, Serialize};
use pqcrypto_mldsa::mldsa65 as dilithium3;
use pqcrypto_traits::sign::{SecretKey as PqSecretKey, PublicKey as PqPublicKey, DetachedSignature as PqDetachedSignature};

/// QNC decimals: 1 QNC = 10^9 nanoQNC (from core/qnet-state)
pub const QNC_DECIMALS: u32 = 9;
/// 1 QNC in smallest units
pub const ONE_QNC: u64 = 1_000_000_000;

/// Benchmark preset types
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BenchmarkPreset {
    /// v2.41.2: STABILITY TEST
    /// 5K TPS, 50K TX, 2 workers - USE THIS FOR TESTING!
    StabilityTest,
    /// v2.41.2: STRESS TEST - find real node capacity
    /// 20K TPS, 200K TX, 4 workers - moderate load
    StressTest,
    /// v2.41.2: MAX CAPACITY - push node to limit with protection
    /// 50K TPS, 500K TX, 8 workers - high load with early backpressure
    MaxCapacity,
    /// v2.41.2: PROGRESSIVE TEST - automatically find node's maximum TPS!
    /// Starts at 5K, increases by 5K every 10 seconds until failure
    /// Returns the actual maximum TPS the node can handle
    ProgressiveMax,
    /// Single shard test: 100K TPS
    SingleShard,
    /// 8 shards test: 100K TPS
    SmallScale,
    /// 32 shards test: 100K TPS
    MediumScale,
    /// 64 shards test: 100K TPS
    LargeScale,
    /// 128 shards test: 100K TPS
    ExtraLarge,
    /// Full 256 shards: 100K TPS
    FullScale,
    /// Custom configuration
    Custom,
}

impl Default for BenchmarkPreset {
    fn default() -> Self {
        // v2.41.2: Safe default
        BenchmarkPreset::StabilityTest
    }
}

/// Benchmark configuration
/// v2.27.2: NO artificial TPS limits - smart backpressure handles overload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkConfig {
    /// Preset type for quick configuration
    #[serde(default)]
    pub preset: BenchmarkPreset,
    /// Number of shards to simulate (1-256)
    #[serde(default = "default_shards")]
    pub shards: usize,
    /// Total number of transactions to generate
    pub total_transactions: u64,
    /// Target TPS (transactions per second) - NO LIMIT, backpressure handles it
    pub target_tps: u64,
    /// Number of test accounts to use
    pub num_accounts: usize,
    /// Initial balance for each test account (in nanoQNC)
    pub initial_balance: u64,
    /// Retained for API/serde back-compat. Production is pure ML-DSA-65 (Dilithium3);
    /// every benchmark TX is signed with Dilithium3 regardless of this flag.
    #[serde(default)]
    pub use_pq_sig: bool,
}

fn default_shards() -> usize { 256 }

impl BenchmarkConfig {
    /// Create config from preset
    /// v2.41.2: Safe presets for single-node testing + dangerous high-load presets
    pub fn from_preset(preset: BenchmarkPreset) -> Self {
        // v2.41.2: STABILITY-FIRST presets
        // StabilityTest/StressTest/MaxCapacity are SAFE for single node
        let (shards, total, tps, accounts) = match preset {
            // === SAFE PRESETS (v2.41.2) ===
            BenchmarkPreset::StabilityTest => (1, 50_000, 5_000, 1_000),      // 5K TPS - SAFE!
            BenchmarkPreset::StressTest => (4, 200_000, 20_000, 2_000),       // 20K TPS - moderate
            BenchmarkPreset::MaxCapacity => (8, 500_000, 50_000, 5_000),      // 50K TPS - high
            BenchmarkPreset::ProgressiveMax => (1, 1_000_000, 5_000, 10_000), // Start 5K, auto-increase

            BenchmarkPreset::SingleShard => (1, 500_000, 100_000, 5_000),     // 100K TPS ⚠️
            BenchmarkPreset::SmallScale => (8, 1_000_000, 100_000, 10_000),   // 100K TPS ⚠️
            BenchmarkPreset::MediumScale => (32, 2_000_000, 100_000, 20_000), // 100K TPS ⚠️
            BenchmarkPreset::LargeScale => (64, 3_000_000, 100_000, 30_000),  // 100K TPS ⚠️
            BenchmarkPreset::ExtraLarge => (128, 5_000_000, 100_000, 40_000), // 100K TPS ⚠️
            BenchmarkPreset::FullScale => (256, 10_000_000, 100_000, 50_000), // 100K TPS ⚠️
            BenchmarkPreset::Custom => (256, 5_000_000, 100_000, 50_000),
        };

        Self {
            preset,
            shards,
            total_transactions: total,
            target_tps: tps,
            num_accounts: accounts,
            initial_balance: 1_000_000 * ONE_QNC,
            use_pq_sig: false,
        }
    }

    /// Quick presets
    pub fn stability_test() -> Self { Self::from_preset(BenchmarkPreset::StabilityTest) }
    pub fn stress_test() -> Self { Self::from_preset(BenchmarkPreset::StressTest) }
    pub fn max_capacity() -> Self { Self::from_preset(BenchmarkPreset::MaxCapacity) }
    pub fn progressive_max() -> Self { Self::from_preset(BenchmarkPreset::ProgressiveMax) }

    /// Check if this is a progressive test that auto-scales TPS
    pub fn is_progressive(&self) -> bool {
        self.preset == BenchmarkPreset::ProgressiveMax
    }
    pub fn single_shard() -> Self { Self::from_preset(BenchmarkPreset::SingleShard) }
    pub fn small_scale() -> Self { Self::from_preset(BenchmarkPreset::SmallScale) }
    pub fn medium_scale() -> Self { Self::from_preset(BenchmarkPreset::MediumScale) }
    pub fn large_scale() -> Self { Self::from_preset(BenchmarkPreset::LargeScale) }
    pub fn extra_large() -> Self { Self::from_preset(BenchmarkPreset::ExtraLarge) }
    pub fn full_scale() -> Self { Self::from_preset(BenchmarkPreset::FullScale) }
}

impl Default for BenchmarkConfig {
    fn default() -> Self {
        // v2.41.2: Safe default
        Self::from_preset(BenchmarkPreset::StabilityTest)
    }
}

/// Benchmark status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkStatus {
    pub is_running: bool,
    pub transactions_sent: u64,
    pub transactions_confirmed: u64,
    pub current_tps: f64,
    pub peak_tps: f64,
    pub elapsed_seconds: f64,
    pub errors: u64,
}

/// Benchmark results
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkResults {
    pub total_transactions: u64,
    pub confirmed_transactions: u64,
    pub duration_seconds: f64,
    pub average_tps: f64,
    pub peak_tps: f64,
    pub min_latency_ms: f64,
    pub max_latency_ms: f64,
    pub avg_latency_ms: f64,
    pub p99_latency_ms: f64,
    pub errors: u64,
    pub success_rate: f64,
}

/// Test account for benchmark — pure ML-DSA-65 (Dilithium3) keypair.
pub struct BenchmarkAccount {
    pub address: String,
    pub pq_pk: dilithium3::PublicKey,
    pub pq_sk: dilithium3::SecretKey,
    pub nonce: AtomicU64,
}

impl Clone for BenchmarkAccount {
    fn clone(&self) -> Self {
        Self {
            address: self.address.clone(),
            pq_pk: dilithium3::PublicKey::from_bytes(self.pq_pk.as_bytes()).unwrap(),
            pq_sk: dilithium3::SecretKey::from_bytes(self.pq_sk.as_bytes()).unwrap(),
            nonce: AtomicU64::new(self.nonce.load(Ordering::SeqCst)),
        }
    }
}

impl BenchmarkAccount {
    pub fn new(index: usize) -> Self {
        let (pq_pk, pq_sk) = dilithium3::keypair();

        // Generate deterministic address from index
        let address = format!("EON1benchmark{:06}", index);

        Self {
            address,
            pq_pk,
            pq_sk,
            nonce: AtomicU64::new(0),
        }
    }

    pub fn get_next_nonce(&self) -> u64 {
        self.nonce.fetch_add(1, Ordering::SeqCst) + 1
    }
}

/// Post-quantum test account: pure ML-DSA-65 (Dilithium3) keypair.
///
/// Kept as a distinct type (used by `generate_pq_transaction_from_snapshot`
/// and the rpc.rs generator) for API stability, but it is now identical in
/// crypto to `BenchmarkAccount` — Dilithium3 only, no Ed25519.
pub struct PqBenchmarkAccount {
    pub address: String,
    pub pq_pk: dilithium3::PublicKey,
    pub pq_sk: dilithium3::SecretKey,
    pub nonce: AtomicU64,
}

impl Clone for PqBenchmarkAccount {
    fn clone(&self) -> Self {
        Self {
            address: self.address.clone(),
            pq_pk: dilithium3::PublicKey::from_bytes(self.pq_pk.as_bytes()).unwrap(),
            pq_sk: dilithium3::SecretKey::from_bytes(self.pq_sk.as_bytes()).unwrap(),
            nonce: AtomicU64::new(self.nonce.load(Ordering::SeqCst)),
        }
    }
}

impl PqBenchmarkAccount {
    pub fn new(index: usize) -> Self {
        let (pq_pk, pq_sk) = dilithium3::keypair();
        Self {
            address: format!("EON1benchmark{:06}", index),
            pq_pk,
            pq_sk,
            nonce: AtomicU64::new(0),
        }
    }

    pub fn get_next_nonce(&self) -> u64 {
        self.nonce.fetch_add(1, Ordering::SeqCst) + 1
    }
}

/// Generate a pure Dilithium3-signed transaction from a pre-cloned snapshot (NO LOCK).
/// Only the ML-DSA-65 (Dilithium3) signature is computed and embedded in the TX.
pub fn generate_pq_transaction_from_snapshot(
    accounts: &[PqBenchmarkAccount],
) -> Option<qnet_state::Transaction> {
    if accounts.len() < 2 {
        return None;
    }

    let sender_idx = rand::random::<usize>() % accounts.len();
    let mut receiver_idx = rand::random::<usize>() % accounts.len();
    while receiver_idx == sender_idx {
        receiver_idx = rand::random::<usize>() % accounts.len();
    }

    let sender   = &accounts[sender_idx];
    let receiver = &accounts[receiver_idx];
    let nonce    = sender.get_next_nonce();
    let amount   = ONE_QNC;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    const GAS_LIMIT_TRANSFER: u64 = 10_000;
    const GAS_PRICE_STANDARD: u64 = 1;

    let mut tx = qnet_state::Transaction {
        hash: String::new(),
        from: sender.address.clone(),
        to: Some(receiver.address.clone()),
        amount,
        nonce,
        timestamp,
        gas_price: GAS_PRICE_STANDARD,
        gas_limit: GAS_LIMIT_TRANSFER,
        data: None,
        signature: None,                                          // Ed25519 field unused (pure PQ)
        public_key: Some(hex::encode(sender.pq_pk.as_bytes())),   // Dilithium3 pubkey hex
        tx_type: qnet_state::TransactionType::Transfer {
            from: sender.address.clone(),
            to: receiver.address.clone(),
            amount,
        },
        dilithium_signature: None,
        dilithium_public_key: None,
        chain_id: qnet_state::transaction::QNET_CHAIN_ID,
    };

    tx.hash = tx.calculate_hash();

    // Canonical message — same 7-pipe format verified by node.rs::submit_benchmark_batch_pq
    let message = crate::node::BlockchainNode::chain_bind(&format!(
        "{}|{}|{}|{}|{}|{}|{}",
        tx.from, receiver.address, amount, nonce, tx.gas_price, tx.gas_limit, timestamp
    ));
    let msg_bytes = message.as_bytes();

    // Dilithium3 (ML-DSA-65) signature only — pure post-quantum path
    let pq_signed = dilithium3::detached_sign(msg_bytes, &sender.pq_sk);
    tx.dilithium_signature  = Some(pq_signed.as_bytes().to_vec());
    tx.dilithium_public_key = Some(sender.pq_pk.as_bytes().to_vec());

    Some(tx)
}

/// Benchmark manager
pub struct BenchmarkManager {
    /// Configuration
    config: RwLock<BenchmarkConfig>,
    /// Dilithium3 (ML-DSA-65) test accounts
    accounts: RwLock<Vec<BenchmarkAccount>>,
    /// Alternate Dilithium3 account pool used by the rpc.rs PQ generator path
    pq_accounts: RwLock<Vec<PqBenchmarkAccount>>,
    /// Running state
    is_running: AtomicBool,
    /// Transactions sent (pub for direct update from benchmark generator)
    pub transactions_sent: AtomicU64,
    /// Transactions confirmed (pub for direct update from benchmark generator)
    pub transactions_confirmed: AtomicU64,
    /// Errors count
    errors: AtomicU64,
    /// Peak TPS observed (instantaneous, pub for direct update)
    pub peak_tps: RwLock<f64>,
    /// Start time
    start_time: RwLock<Option<Instant>>,
    /// End time
    end_time: RwLock<Option<Instant>>,
    /// Latencies for percentile calculation
    latencies: RwLock<Vec<f64>>,
    /// Last TPS check time (for instantaneous TPS calculation)
    last_tps_check: RwLock<Option<Instant>>,
    /// TX count at last TPS check
    last_tx_count: AtomicU64,
}

impl BenchmarkManager {
    pub fn new() -> Self {
        Self {
            config: RwLock::new(BenchmarkConfig::default()),
            accounts: RwLock::new(Vec::new()),
            pq_accounts: RwLock::new(Vec::new()),
            is_running: AtomicBool::new(false),
            transactions_sent: AtomicU64::new(0),
            transactions_confirmed: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            peak_tps: RwLock::new(0.0),
            start_time: RwLock::new(None),
            end_time: RwLock::new(None),
            latencies: RwLock::new(Vec::new()),
            last_tps_check: RwLock::new(None),
            last_tx_count: AtomicU64::new(0),
        }
    }

    /// Initialize benchmark accounts (pure Dilithium3 / ML-DSA-65).
    /// Dilithium3 keygen is CPU-heavy, so we log progress every 100 accounts.
    pub async fn initialize(&self, num_accounts: usize) {
        let mut accounts = self.accounts.write().await;
        accounts.clear();

        println!("[BENCHMARK] 🔑 Generating {} test accounts with Dilithium3 (ML-DSA-65) keys...", num_accounts);

        for i in 0..num_accounts {
            accounts.push(BenchmarkAccount::new(i));
            if (i + 1) % 100 == 0 {
                println!("[BENCHMARK] 🔐 Dilithium3 keygen: {}/{}", i + 1, num_accounts);
            }
        }

        println!("[BENCHMARK] ✅ Dilithium3 accounts ready");
    }

    /// Initialize the PQ account pool used by the rpc.rs generator path
    /// (pure Dilithium3 / ML-DSA-65). Kept for API stability.
    /// Dilithium3 keygen is CPU-heavy, so we log progress every 100 accounts.
    pub async fn initialize_pq(&self, num_accounts: usize) {
        let mut pq = self.pq_accounts.write().await;
        pq.clear();

        println!("[BENCHMARK] 🔑 Generating {} pure Dilithium3 (ML-DSA-65) accounts...", num_accounts);

        for i in 0..num_accounts {
            pq.push(PqBenchmarkAccount::new(i));
            if (i + 1) % 100 == 0 {
                println!("[BENCHMARK] 🔐 Dilithium3 keygen: {}/{}", i + 1, num_accounts);
            }
        }

        println!("[BENCHMARK] ✅ Dilithium3 accounts ready ({} accounts)", num_accounts);
    }

    /// Get PQ accounts snapshot for lock-free generation in workers
    pub async fn get_pq_accounts_snapshot(&self) -> Vec<PqBenchmarkAccount> {
        self.pq_accounts.read().await.clone()
    }

    /// Start benchmark
    pub async fn start(&self, config: BenchmarkConfig) -> Result<(), String> {
        if self.is_running.load(Ordering::SeqCst) {
            return Err("Benchmark already running".to_string());
        }

        // Reset state
        self.transactions_sent.store(0, Ordering::SeqCst);
        self.transactions_confirmed.store(0, Ordering::SeqCst);
        self.errors.store(0, Ordering::SeqCst);
        *self.peak_tps.write().await = 0.0;
        *self.start_time.write().await = Some(Instant::now());
        *self.end_time.write().await = None;
        self.latencies.write().await.clear();
        *self.last_tps_check.write().await = None;
        self.last_tx_count.store(0, Ordering::SeqCst);

        // Initialize accounts if needed
        if config.use_pq_sig {
            let pq_count = self.pq_accounts.read().await.len();
            if pq_count < config.num_accounts {
                self.initialize_pq(config.num_accounts).await;
            }
        } else {
            let accounts_count = self.accounts.read().await.len();
            if accounts_count < config.num_accounts {
                self.initialize(config.num_accounts).await;
            }
        }

        // Store config
        *self.config.write().await = config.clone();

        // Mark as running
        self.is_running.store(true, Ordering::SeqCst);

        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🚀 QNET BENCHMARK STARTED - {:?}", config.preset);
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🧩 Shards: {} × 50K TPS each", config.shards);
        println!("📊 Target: {} transactions ({:.1}M)", config.total_transactions, config.total_transactions as f64 / 1_000_000.0);
        println!("⚡ Target TPS: {} ({:.1}M TPS)", config.target_tps, config.target_tps as f64 / 1_000_000.0);
        println!("👥 Test accounts: {}", config.num_accounts);
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        Ok(())
    }

    /// Stop benchmark
    pub async fn stop(&self) {
        self.is_running.store(false, Ordering::SeqCst);
        *self.end_time.write().await = Some(Instant::now());

        let results = self.get_results().await;

        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🏁 QNET BENCHMARK COMPLETED");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("⚡ Peak TPS:        {:.0}", results.peak_tps);
        println!("📊 Average TPS:     {:.0}", results.average_tps);
        println!("📦 Transactions:    {}", results.total_transactions);
        println!("✅ Confirmed:       {}", results.confirmed_transactions);
        println!("⏱️  Duration:        {:.2}s", results.duration_seconds);
        println!("📈 Success Rate:    {:.2}%", results.success_rate);
        println!("⏳ Avg Latency:     {:.2}ms", results.avg_latency_ms);
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    }

    /// Get current status
    pub async fn get_status(&self) -> BenchmarkStatus {
        let sent = self.transactions_sent.load(Ordering::SeqCst);
        let confirmed = self.transactions_confirmed.load(Ordering::SeqCst);
        let errors = self.errors.load(Ordering::SeqCst);
        let now = Instant::now();

        let elapsed = if let Some(start) = *self.start_time.read().await {
            start.elapsed().as_secs_f64()
        } else {
            0.0
        };

        // Calculate cumulative average TPS
        let avg_tps = if elapsed > 0.0 {
            sent as f64 / elapsed
        } else {
            0.0
        };

        // Calculate instantaneous TPS (TX since last check)
        let last_check_opt = *self.last_tps_check.read().await;
        let last_count = self.last_tx_count.load(Ordering::SeqCst);

        let instant_tps = if let Some(last_check) = last_check_opt {
            let elapsed_since_last = now.duration_since(last_check).as_secs_f64();
            let tx_delta = sent.saturating_sub(last_count);

            if elapsed_since_last > 0.01 { // Minimum 10ms between checks
                tx_delta as f64 / elapsed_since_last
            } else {
                avg_tps // Too short interval, use average
            }
        } else {
            avg_tps // First check, use average
        };

        // Update last check timestamp and count
        *self.last_tps_check.write().await = Some(now);
        self.last_tx_count.store(sent, Ordering::SeqCst);

        // Update peak TPS with instantaneous value
        let mut peak = self.peak_tps.write().await;
        if instant_tps > *peak {
            *peak = instant_tps;
        }

        BenchmarkStatus {
            is_running: self.is_running.load(Ordering::SeqCst),
            transactions_sent: sent,
            transactions_confirmed: confirmed,
            current_tps: instant_tps,
            peak_tps: *peak,
            elapsed_seconds: elapsed,
            errors,
        }
    }

    /// Get results
    pub async fn get_results(&self) -> BenchmarkResults {
        let sent = self.transactions_sent.load(Ordering::SeqCst);
        let confirmed = self.transactions_confirmed.load(Ordering::SeqCst);
        let errors = self.errors.load(Ordering::SeqCst);

        let duration = if let (Some(start), Some(end)) = (
            *self.start_time.read().await,
            *self.end_time.read().await
        ) {
            end.duration_since(start).as_secs_f64()
        } else if let Some(start) = *self.start_time.read().await {
            start.elapsed().as_secs_f64()
        } else {
            0.0
        };

        let average_tps = if duration > 0.0 {
            sent as f64 / duration
        } else {
            0.0
        };

        let latencies = self.latencies.read().await;
        let (min_lat, max_lat, avg_lat, p99_lat) = if !latencies.is_empty() {
            let mut sorted = latencies.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());

            let min = sorted.first().copied().unwrap_or(0.0);
            let max = sorted.last().copied().unwrap_or(0.0);
            let avg = sorted.iter().sum::<f64>() / sorted.len() as f64;
            let p99_idx = (sorted.len() as f64 * 0.99) as usize;
            let p99 = sorted.get(p99_idx.min(sorted.len() - 1)).copied().unwrap_or(0.0);

            (min, max, avg, p99)
        } else {
            (0.0, 0.0, 0.0, 0.0)
        };

        let success_rate = if sent > 0 {
            (confirmed as f64 / sent as f64) * 100.0
        } else {
            0.0
        };

        BenchmarkResults {
            total_transactions: sent,
            confirmed_transactions: confirmed,
            duration_seconds: duration,
            average_tps,
            peak_tps: *self.peak_tps.read().await,
            min_latency_ms: min_lat,
            max_latency_ms: max_lat,
            avg_latency_ms: avg_lat,
            p99_latency_ms: p99_lat,
            errors,
            success_rate,
        }
    }

    /// Generate a signed transaction (legacy - has lock contention!)
    pub async fn generate_transaction(&self) -> Option<qnet_state::Transaction> {
        let accounts = self.accounts.read().await;
        Self::generate_transaction_from_snapshot(&accounts)
    }

    /// Get accounts snapshot for lock-free transaction generation
    /// Call ONCE per worker at start, then use generate_transaction_from_snapshot
    pub async fn get_accounts_snapshot(&self) -> Vec<BenchmarkAccount> {
        self.accounts.read().await.clone()
    }

    /// Generate transaction from pre-cloned accounts snapshot (NO LOCK!)
    /// This is the HIGH-PERFORMANCE path for benchmark workers.
    /// Pure Dilithium3 (ML-DSA-65) signing — matches production consensus.
    pub fn generate_transaction_from_snapshot(
        accounts: &[BenchmarkAccount],
    ) -> Option<qnet_state::Transaction> {
        if accounts.len() < 2 {
            return None;
        }

        // Pick random sender and receiver
        let sender_idx = rand::random::<usize>() % accounts.len();
        let mut receiver_idx = rand::random::<usize>() % accounts.len();
        while receiver_idx == sender_idx {
            receiver_idx = rand::random::<usize>() % accounts.len();
        }

        let sender = &accounts[sender_idx];
        let receiver = &accounts[receiver_idx];

        let nonce = sender.get_next_nonce();
        let amount = ONE_QNC; // 1 QNC = 10^9 nanoQNC
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // PRODUCTION VALUES - identical to production transactions
        const GAS_LIMIT_TRANSFER: u64 = 10_000;
        const GAS_PRICE_STANDARD: u64 = 1;

        // Create transaction with correct structure (100% production-identical)
        let mut tx = qnet_state::Transaction {
            hash: String::new(),
            from: sender.address.clone(),
            to: Some(receiver.address.clone()),
            amount,
            nonce,
            timestamp,
            gas_price: GAS_PRICE_STANDARD,
            gas_limit: GAS_LIMIT_TRANSFER,
            data: None,
            signature: None,                                          // Ed25519 field unused (pure PQ)
            public_key: Some(hex::encode(sender.pq_pk.as_bytes())),   // Dilithium3 pubkey hex
            tx_type: qnet_state::TransactionType::Transfer {
                from: sender.address.clone(),
                to: receiver.address.clone(),
                amount,
            },
            dilithium_signature: None,
            dilithium_public_key: None,
            chain_id: qnet_state::transaction::QNET_CHAIN_ID,
        };

        // Calculate hash (real SHA3-256)
        tx.hash = tx.calculate_hash();

        // Sign with Dilithium3 (ML-DSA-65) — MUST match node.rs::submit_benchmark_batch_pq.
        // Canonical message: from|to|amount|nonce|gas_price|gas_limit|timestamp
        let message = crate::node::BlockchainNode::chain_bind(&format!(
            "{}|{}|{}|{}|{}|{}|{}",
            tx.from, receiver.address, amount, nonce, tx.gas_price, tx.gas_limit, timestamp
        ));
        let pq_signed = dilithium3::detached_sign(message.as_bytes(), &sender.pq_sk);
        tx.dilithium_signature  = Some(pq_signed.as_bytes().to_vec());
        tx.dilithium_public_key = Some(sender.pq_pk.as_bytes().to_vec());

        Some(tx)
    }

    /// Record transaction sent
    pub fn record_sent(&self) {
        self.transactions_sent.fetch_add(1, Ordering::SeqCst);
    }

    /// Record transaction confirmed
    pub fn record_confirmed(&self) {
        self.transactions_confirmed.fetch_add(1, Ordering::SeqCst);
    }

    /// Record error
    pub fn record_error(&self) {
        self.errors.fetch_add(1, Ordering::SeqCst);
    }

    /// Record latency
    pub async fn record_latency(&self, latency_ms: f64) {
        self.latencies.write().await.push(latency_ms);
    }

    /// Check if running
    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }

    /// Get config
    pub async fn get_config(&self) -> BenchmarkConfig {
        self.config.read().await.clone()
    }

    /// Check if benchmark account
    pub fn is_benchmark_account(address: &str) -> bool {
        address.starts_with("EON1benchmark")
    }
}

impl Default for BenchmarkManager {
    fn default() -> Self {
        Self::new()
    }
}

// Global benchmark manager instance
lazy_static::lazy_static! {
    pub static ref BENCHMARK_MANAGER: Arc<BenchmarkManager> = Arc::new(BenchmarkManager::new());
}

// ============================================================================
// LOCAL BENCHMARK TESTS - Run without network
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use pqcrypto_mldsa::mldsa65 as dilithium3;
    use pqcrypto_traits::sign::SignedMessage as PqSignedMessage;

    /// Test transaction generation speed (no network required)
    /// Measures: key generation, TX creation, signing
    #[tokio::test]
    async fn benchmark_transaction_generation_speed() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🚀 QNET LOCAL BENCHMARK - Transaction Generation");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        let manager = BenchmarkManager::new();

        // Initialize test accounts (Dilithium3 keygen is slow, so use a modest count)
        let num_accounts = 1_000;
        println!("🔑 Generating {} Dilithium3 (ML-DSA-65) keypairs...", num_accounts);
        let key_start = Instant::now();
        manager.initialize(num_accounts).await;
        let key_time = key_start.elapsed();
        println!("✅ Keypairs generated in {:.2}ms ({:.0} keys/sec)",
                 key_time.as_secs_f64() * 1000.0,
                 num_accounts as f64 / key_time.as_secs_f64());

        // Generate transactions
        let num_transactions = 10_000;
        println!("\n📝 Generating {} Dilithium3-signed transactions...", num_transactions);

        let tx_start = Instant::now();
        let mut generated = 0u64;

        for _ in 0..num_transactions {
            if manager.generate_transaction().await.is_some() {
                generated += 1;
            }
        }

        let tx_time = tx_start.elapsed();
        let tps = generated as f64 / tx_time.as_secs_f64();

        println!("✅ Generated {} transactions in {:.2}ms", generated, tx_time.as_secs_f64() * 1000.0);
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("⚡ LOCAL GENERATION TPS (Dilithium3): {:.0}", tps);
        println!("📊 With 256 shards: {:.0} theoretical TPS", tps * 256.0);
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

        // Throughput is printed, never asserted: a wall-clock threshold measures the machine and the
        // concurrent load on it, not this code, so it fails on a busy CI box for no defect.
        assert_eq!(generated, num_transactions as u64, "every requested transaction must be generated");
    }

    /// Test parallel transaction generation
    #[tokio::test]
    async fn benchmark_parallel_generation() {
        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("🚀 QNET LOCAL BENCHMARK - Parallel Generation (256 shards simulation)");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        let num_shards = 64usize;
        let tx_per_shard = 100usize;
        let total_tx = num_shards * tx_per_shard;

        println!("📊 Simulating {} shards × {} TX = {} total", num_shards, tx_per_shard, total_tx);

        // Create managers for each "shard"
        let mut handles = Vec::new();
        let start = Instant::now();

        for _shard_id in 0..num_shards {
            let handle = tokio::spawn(async move {
                let manager = BenchmarkManager::new();
                manager.initialize(10).await; // 10 accounts per shard

                let mut count = 0u64;
                for _ in 0..tx_per_shard {
                    if manager.generate_transaction().await.is_some() {
                        count += 1;
                    }
                }
                count
            });
            handles.push(handle);
        }

        // Wait for all shards
        let mut total_generated = 0u64;
        for handle in handles {
            if let Ok(count) = handle.await {
                total_generated += count;
            }
        }

        let elapsed = start.elapsed();
        let tps = total_generated as f64 / elapsed.as_secs_f64();

        println!("\n✅ Generated {} transactions in {:.2}s", total_generated, elapsed.as_secs_f64());
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("⚡ PARALLEL TPS ({} shards, Dilithium3): {:.0}", num_shards, tps);
        println!("📈 This demonstrates real parallel processing capability!");
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

        assert!(total_generated > 0, "Should generate transactions across all shards");
    }

    // =========================================================================
    // SIGNATURE BENCHMARK — pure ML-DSA-65 (Dilithium3)
    //
    // Production consensus/identity signs only Dilithium3, so the micro-bench
    // measures the Dilithium3 sign/verify path exclusively.
    //
    // Presets (4 load levels):
    //   small  — light smoke test, fast
    //   medium — moderate load
    //   high   — stress level
    //   custom — 100K TX / 100K TPS target
    //
    // API preset equivalents (BenchmarkConfig::from_preset):
    //   small  ≈ StabilityTest  (5K TPS,  50K TX)
    //   medium ≈ StressTest     (20K TPS, 200K TX)
    //   high   ≈ MaxCapacity    (50K TPS, 500K TX)
    //   custom ≈ FullScale      (100K TPS target)
    // =========================================================================

    // -------------------------------------------------------------------------
    // Shared helper: run one Dilithium3 sign+verify loop, return (sign_tps, verify_tps)
    // -------------------------------------------------------------------------
    fn run_dilithium_bench(n: usize) -> (f64, f64) {
        let (pq_pk, pq_sk) = dilithium3::keypair();
        let msg = b"from|to|1000000000|1|1|10000|1700000000";

        // warm-up
        let _ = dilithium3::sign(msg, &pq_sk);

        let t0 = Instant::now();
        for _ in 0..n { let _ = dilithium3::sign(msg, &pq_sk); }
        let sign_tps = n as f64 / t0.elapsed().as_secs_f64();

        let pq_sig = dilithium3::sign(msg, &pq_sk);
        let t1 = Instant::now();
        for _ in 0..n { dilithium3::open(&pq_sig, &pq_pk).unwrap(); }
        let verify_tps = n as f64 / t1.elapsed().as_secs_f64();

        (sign_tps, verify_tps)
    }

    fn print_sig_result(label: &str, preset: &str, n: usize, sign_tps: f64, verify_tps: f64) {
        println!("\n╔══════════════════════════════════════════════════════════════╗");
        println!("║  {:<60}║", format!("{} — preset: {}", label, preset));
        println!("╠══════════════════════════════════════════════════════════════╣");
        println!("║  TX count   : {:>10}                                    ║", n);
        println!("║  Sign TPS   : {:>10.0}  ops/s per core                  ║", sign_tps);
        println!("║  Verify TPS : {:>10.0}  ops/s per core                  ║", verify_tps);
        println!("║  ms/sign    : {:>10.3}  ms                               ║", 1000.0 / sign_tps);
        println!("║  ms/verify  : {:>10.3}  ms                               ║", 1000.0 / verify_tps);
        println!("╚══════════════════════════════════════════════════════════════╝");
    }

    // =========================================================================
    // ML-DSA-65 (Dilithium3) sign/verify micro-benchmarks
    //
    // These are HARDWARE-DEPENDENT performance benchmarks, not correctness
    // regression tests. They assert minimum throughput thresholds that hold
    // on any modern CPU running a single benchmark in isolation, but become
    // flaky when `cargo test` runs the full suite in parallel — every test
    // worker competes for cores, and per-core TPS measured under contention
    // can fall below the assertions.
    //
    // Marked `#[ignore]` so they are excluded from the default regression run.
    // Invoke explicitly for benchmark sweeps:
    //
    //   cargo test --release -p qnet-integration --lib bench_dilithium -- --ignored --nocapture
    //
    // Dilithium3 is ~50× slower than Ed25519, so TX counts are proportionally
    // smaller to keep test runtime reasonable.
    // =========================================================================

    #[test]
    #[ignore = "hardware-dependent benchmark; run with --ignored"]
    fn bench_dilithium_small() {
        let n = 1_000;
        let (s, v) = run_dilithium_bench(n);
        print_sig_result("ML-DSA-65 (Dilithium3)", "small (1K TX)", n, s, v);
        assert!(s > 50.0,  "Dilithium3 sign must exceed 50 ops/s per core");
        assert!(v > 100.0, "Dilithium3 verify must exceed 100 ops/s per core");
    }

    #[test]
    #[ignore = "hardware-dependent benchmark; run with --ignored"]
    fn bench_dilithium_medium() {
        let n = 10_000;
        let (s, v) = run_dilithium_bench(n);
        print_sig_result("ML-DSA-65 (Dilithium3)", "medium (10K TX)", n, s, v);
        assert!(s > 50.0);
        assert!(v > 100.0);
    }

    #[test]
    #[ignore = "hardware-dependent benchmark; run with --ignored"]
    fn bench_dilithium_high() {
        let n = 50_000;
        let (s, v) = run_dilithium_bench(n);
        print_sig_result("ML-DSA-65 (Dilithium3)", "high (50K TX)", n, s, v);
        assert!(s > 50.0);
        assert!(v > 100.0);
    }

    /// Custom preset: 100K TX, target 100K TPS.
    /// Per-core Dilithium3 verify is the real bottleneck; multiply by CPU core
    /// count for total node capacity.
    #[test]
    #[ignore = "hardware-dependent benchmark; run with --ignored"]
    fn bench_dilithium_custom() {
        let n = 100_000;
        let (s, v) = run_dilithium_bench(n);
        print_sig_result("ML-DSA-65 (Dilithium3)", "custom (100K TX / 100K TPS target)", n, s, v);
        println!("  ℹ️  For 100K TPS you need: ceil(100_000 / verify_tps) cores.");
        println!("     Example: if verify_tps=2000, you need 50 cores to hit 100K TPS.");
        println!("     This number is MEMPOOL-ONLY. E2E finality TPS is lower.");
        println!("     Run bench_e2e_finality_simulation for the honest E2E number.");
        assert!(s > 50.0);
        assert!(v > 100.0);
    }

    // =========================================================================
    // E2E FINALITY SIMULATION (no live network required)
    //
    // Simulates the FULL pipeline — not just mempool:
    //   TX signed → mempool accepted (verify) → microblock produced → MacroBlock finalized
    //
    // Measures the honest E2E numbers with pure ML-DSA-65 (Dilithium3):
    //   - sign_tps       : how fast client can produce signed TX
    //   - mempool_tps    : how fast node accepts TX (verify gate)
    //   - e2e_tps        : TX finalized per wall-second (includes block production time)
    //   - p50/p99 latency: time from TX submission to microblock inclusion
    //   - MacroBlock time: deterministic ~90s finality window
    // =========================================================================

    /// Block production constants (production values)
    const MICROBLOCK_INTERVAL_MS: u64 = 1_000;   // 1 s per microblock
    const MICROBLOCKS_PER_MACRO:  u64 = 90;      // MacroBlock every 90 microblocks
    const MAX_TX_PER_BLOCK:       u64 = 200_000; // max TX included per microblock

    /// E2E finality simulation with pure Dilithium3 signatures.
    /// Use this to get the honest finality TPS rather than the mempool-only number.
    #[test]
    #[ignore = "hardware-dependent benchmark; run with --ignored"]
    fn bench_e2e_finality_simulation() {
        use std::collections::VecDeque;

        // Dilithium3 is ~50× slower than Ed25519 → keep TX count modest
        let num_accounts = 1_000usize;
        let total_tx     = 20_000u64;

        println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("📊 E2E FINALITY SIMULATION — ML-DSA-65 (Dilithium3), {} TX, {} accounts", total_tx, num_accounts);
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        // Generate Dilithium3 keypairs for each account
        let pq_pairs: Vec<_> = (0..num_accounts).map(|_| dilithium3::keypair()).collect();
        let msg_base = "qnet_e2e_transfer";

        // Phase 1: Sign (client side)
        let t_sign = Instant::now();
        struct SignedEntry { submit_us: u64, pq_sig: Vec<u8>, ki: usize, tx_idx: u64 }
        let mut signed_batch: Vec<SignedEntry> = Vec::with_capacity(total_tx as usize);
        for i in 0..total_tx {
            let ki  = (i as usize) % num_accounts;
            let msg = format!("{msg_base}|{i}");
            let pq_sig = dilithium3::sign(msg.as_bytes(), &pq_pairs[ki].1).as_bytes().to_vec();
            signed_batch.push(SignedEntry {
                submit_us: t_sign.elapsed().as_micros() as u64,
                pq_sig, ki, tx_idx: i,
            });
        }
        let sign_tps = total_tx as f64 / t_sign.elapsed().as_secs_f64();
        println!("  ✏️  Phase 1 sign   : {:.0} TX/s", sign_tps);

        // Phase 2: Mempool accept (verify gate)
        let t_verify = Instant::now();
        let mut mempool: VecDeque<(u64,)> = VecDeque::new(); // (submit_us,)
        let mut accepted = 0u64;
        for entry in &signed_batch {
            let msg = format!("{msg_base}|{}", entry.tx_idx);
            let (ref pq_pk, _) = pq_pairs[entry.ki];

            // Reconstruct pqcrypto SignedMessage from raw bytes and open() against canonical msg
            let pq_ok = <dilithium3::SignedMessage as PqSignedMessage>::from_bytes(&entry.pq_sig)
                .map(|sm| dilithium3::open(&sm, pq_pk).map(|opened| opened == msg.as_bytes()).unwrap_or(false))
                .unwrap_or(false);

            if pq_ok {
                mempool.push_back((entry.submit_us,));
                accepted += 1;
            }
        }
        let mempool_tps = accepted as f64 / t_verify.elapsed().as_secs_f64();
        println!("  🔍 Phase 2 mempool : {:.0} TX/s  ({} accepted)", mempool_tps, accepted);

        // Phase 3: Block production (drain mempool into microblocks)
        let mut finalized   = 0u64;
        let mut block_num   = 0u64;
        let mut macro_count = 0u64;
        let mut latencies_ms: Vec<f64> = Vec::new();

        while !mempool.is_empty() {
            block_num += 1;
            let block_time_us = block_num * MICROBLOCK_INTERVAL_MS * 1_000;
            let batch = MAX_TX_PER_BLOCK.min(mempool.len() as u64);
            for _ in 0..batch {
                if let Some((submit_us,)) = mempool.pop_front() {
                    let lat_ms = block_time_us.saturating_sub(submit_us) as f64 / 1_000.0;
                    latencies_ms.push(lat_ms);
                    finalized += 1;
                }
            }
            if block_num % MICROBLOCKS_PER_MACRO == 0 { macro_count += 1; }
        }

        let sim_wall_s = block_num as f64 * MICROBLOCK_INTERVAL_MS as f64 / 1_000.0;
        let e2e_tps    = finalized as f64 / sim_wall_s;

        latencies_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p50 = latencies_ms[latencies_ms.len() * 50 / 100];
        let p99 = latencies_ms[latencies_ms.len() * 99 / 100];
        let avg = latencies_ms.iter().sum::<f64>() / latencies_ms.len() as f64;

        println!("  📦 Phase 3 blocks  : {} microblocks, {} MacroBlocks, {:.1}s simulated",
                 block_num, macro_count, sim_wall_s);

        println!("\n╔══════════════════════════════════════════════════════════════╗");
        println!("║      E2E FINALITY RESULTS — ML-DSA-65 (Dilithium3), {}K TX   ║", total_tx/1000);
        println!("╠══════════════════════════════════════════════════════════════╣");
        println!("║  Sign TPS   (client)          : {:>12.0} TX/s          ║", sign_tps);
        println!("║  Mempool TPS (node verify)    : {:>12.0} TX/s          ║", mempool_tps);
        println!("║  E2E finality TPS             : {:>12.0} TX/s  ←       ║", e2e_tps);
        println!("║  Latency p50 (→ microblock)   : {:>9.1} ms             ║", p50);
        println!("║  Latency p99 (→ microblock)   : {:>9.1} ms             ║", p99);
        println!("║  Latency avg                  : {:>9.1} ms             ║", avg);
        println!("║  MacroBlock finality window   : {:>9.0} s              ║",
                 MICROBLOCKS_PER_MACRO * MICROBLOCK_INTERVAL_MS / 1_000);
        println!("╠══════════════════════════════════════════════════════════════╣");
        println!("║  Mempool TPS is verify-only. E2E TPS is block-limited.      ║");
        println!("║  P2P propagation + consensus rounds add latency on top.     ║");
        println!("║  To reach 100K TPS: cores = ceil(100_000 / mempool_tps).    ║");
        println!("╚══════════════════════════════════════════════════════════════╝");

        assert_eq!(finalized, total_tx, "all TX must be finalized");
        assert!(e2e_tps > 0.0);
        assert!(p50 < 2_000.0, "p50 must be <2s");
    }

    // Live server integration tests. Require a running node with
    // QNET_BENCHMARK_MODE=true (genesis creates EON1benchmark000000..000999,
    // 1M QNC each). Benchmark TXs use EON1benchmark* addresses that do NOT
    // pass validate_eon_address — they go through the dedicated benchmark
    // pipeline, not POST /api/v1/transaction. #[ignore] in CI; run with:
    //   QNET_NODE_URL=http://<host>:<port> QNET_API_KEY=<key> \
    //   cargo test --lib -- bench_server --ignored --nocapture

    fn make_http_client() -> reqwest::blocking::Client {
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .expect("reqwest client build failed")
    }

    fn add_api_key(
        req: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        if let Ok(key) = std::env::var("QNET_API_KEY") {
            req.header("x-api-key", key)
        } else {
            req
        }
    }

    fn get_node_url() -> Option<String> {
        std::env::var("QNET_NODE_URL").ok().map(|u| u.trim_end_matches('/').to_string())
    }

    fn health_check(client: &reqwest::blocking::Client, base: &str) -> bool {
        match add_api_key(client.get(format!("{}/api/v1/node/health", base))).send() {
            Ok(r) if r.status().is_success() => { println!("  Node health OK"); true }
            Ok(r) => { println!("  Node health: {}", r.status()); false }
            Err(e) => { println!("  Cannot reach node: {}", e); false }
        }
    }

    fn poll_benchmark(client: &reqwest::blocking::Client, base: &str, timeout_secs: u64) {
        let poll_start = Instant::now();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let status: serde_json::Value = add_api_key(
                client.get(format!("{}/api/v1/benchmark/status", base))
            ).send().expect("GET /benchmark/status failed")
             .json().expect("status JSON parse failed");

            let running   = status["is_running"].as_bool().unwrap_or(true);
            let sent      = status["transactions_sent"].as_u64().unwrap_or(0);
            let confirmed = status["transactions_confirmed"].as_u64().unwrap_or(0);
            let cur_tps   = status["current_tps"].as_f64().unwrap_or(0.0);

            println!("  t={:.0}s  sent={:<8}  confirmed={:<8}  tps={:.0}",
                     poll_start.elapsed().as_secs(), sent, confirmed, cur_tps);

            if !running { break; }
            if poll_start.elapsed().as_secs() > timeout_secs {
                println!("  Poll timeout at {}s", timeout_secs);
                break;
            }
        }
    }

    fn print_live_results(client: &reqwest::blocking::Client, base: &str, label: &str) {
        let results: serde_json::Value = add_api_key(
            client.get(format!("{}/api/v1/benchmark/results", base))
        ).send().expect("GET /benchmark/results failed")
         .json().expect("results JSON parse failed");

        let total       = results["total_transactions"].as_u64().unwrap_or(0);
        let confirmed   = results["confirmed_transactions"].as_u64().unwrap_or(0);
        let avg_tps     = results["average_tps"].as_f64().unwrap_or(0.0);
        let peak_tps    = results["peak_tps"].as_f64().unwrap_or(0.0);
        let success_pct = results["success_rate"].as_f64().unwrap_or(0.0);
        let avg_lat     = results["avg_latency_ms"].as_f64().unwrap_or(0.0);
        let p99_lat     = results["p99_latency_ms"].as_f64().unwrap_or(0.0);

        println!("\n  {}", label);
        println!("  Total TX       : {}", total);
        println!("  Confirmed      : {} (mempool+block)", confirmed);
        println!("  Success rate   : {:.1}%", success_pct);
        println!("  Average TPS    : {:.0}", avg_tps);
        println!("  Peak TPS       : {:.0}", peak_tps);
        println!("  Avg latency    : {:.1} ms", avg_lat);
        println!("  p99 latency    : {:.1} ms", p99_lat);

        assert!(confirmed > 0,
            "FAIL: 0 TX confirmed! Check QNET_BENCHMARK_MODE=true on server.");
        assert!(success_pct > 50.0,
            "FAIL: success rate {:.1}% too low", success_pct);
        assert!(avg_tps > 100.0,
            "FAIL: average TPS {:.0} too low", avg_tps);
    }

    // =========================================================================
    // ML-DSA-65 (Dilithium3) server benchmarks -- 4 presets
    // Server generates + signs TX internally via submit_benchmark_batch_pq
    // (pure Dilithium3 verify gate). Full sig verification, P2P broadcast,
    // block inclusion.
    // =========================================================================

    #[test]
    #[ignore = "live node: QNET_NODE_URL + QNET_API_KEY"]
    fn bench_server_dilithium_small() {
        let base = match get_node_url() { Some(u) => u, None => return };
        let client = make_http_client();
        if !health_check(&client, &base) { return; }
        let body = serde_json::json!({"preset": "stability_test"});
        let resp = add_api_key(client.post(format!("{}/api/v1/benchmark/start", base)).json(&body)).send().unwrap();
        assert!(resp.status().is_success(), "start failed: {}", resp.status());
        poll_benchmark(&client, &base, 120);
        print_live_results(&client, &base, "Dilithium3 stability_test (5K TPS, 50K TX)");
    }

    #[test]
    #[ignore = "live node: QNET_NODE_URL + QNET_API_KEY"]
    fn bench_server_dilithium_medium() {
        let base = match get_node_url() { Some(u) => u, None => return };
        let client = make_http_client();
        if !health_check(&client, &base) { return; }
        let body = serde_json::json!({"preset": "stress_test"});
        let resp = add_api_key(client.post(format!("{}/api/v1/benchmark/start", base)).json(&body)).send().unwrap();
        assert!(resp.status().is_success(), "start failed: {}", resp.status());
        poll_benchmark(&client, &base, 180);
        print_live_results(&client, &base, "Dilithium3 stress_test (20K TPS, 200K TX)");
    }

    #[test]
    #[ignore = "live node: QNET_NODE_URL + QNET_API_KEY"]
    fn bench_server_dilithium_high() {
        let base = match get_node_url() { Some(u) => u, None => return };
        let client = make_http_client();
        if !health_check(&client, &base) { return; }
        let body = serde_json::json!({"preset": "max_capacity"});
        let resp = add_api_key(client.post(format!("{}/api/v1/benchmark/start", base)).json(&body)).send().unwrap();
        assert!(resp.status().is_success(), "start failed: {}", resp.status());
        poll_benchmark(&client, &base, 300);
        print_live_results(&client, &base, "Dilithium3 max_capacity (50K TPS, 500K TX)");
    }

    #[test]
    #[ignore = "live node: QNET_NODE_URL + QNET_API_KEY"]
    fn bench_server_dilithium_custom() {
        let base = match get_node_url() { Some(u) => u, None => return };
        let client = make_http_client();
        if !health_check(&client, &base) { return; }
        let body = serde_json::json!({"target_tps": 100_000, "total": 1_000_000, "num_accounts": 10_000});
        let resp = add_api_key(client.post(format!("{}/api/v1/benchmark/start", base)).json(&body)).send().unwrap();
        assert!(resp.status().is_success(), "start failed: {}", resp.status());
        poll_benchmark(&client, &base, 600);
        print_live_results(&client, &base, "Dilithium3 custom (100K TPS, 1M TX)");
    }

    // NOTE: The server benchmark generator now signs pure Dilithium3 (ML-DSA-65)
    // and submits via submit_benchmark_batch_pq (Dilithium3 verify gate).
    // Per-core sign/verify numbers come from the bench_dilithium_* tests above;
    // multiply by CPU core count for estimated server throughput.

    // REMOVED: build_benchmark_tx, build_hybrid_benchmark_tx,
    // bench_server_direct_*. Those used POST /api/v1/transaction which rejects
    // EON1benchmark* addresses (validate_eon_address expects 41-char
    // hex+eon format). The correct path is POST /api/v1/benchmark/start (above).
}

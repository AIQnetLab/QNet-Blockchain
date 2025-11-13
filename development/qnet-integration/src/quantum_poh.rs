// Quantum Proof of History implementation for QNet

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{RwLock, mpsc};
use sha3::{Sha3_512, Digest};
use blake3;
use serde::{Serialize, Deserialize};
use prometheus::{register_counter, register_gauge, Counter, Gauge};
use lazy_static::lazy_static;

lazy_static! {
    /// Total PoH hashes computed
    static ref POH_HASH_COUNT: Counter = register_counter!(
        "qnet_poh_hash_count_total",
        "Total number of PoH hashes computed"
    ).unwrap();
    
    /// PoH hashes per second
    static ref POH_HASH_RATE: Gauge = register_gauge!(
        "qnet_poh_hash_rate",
        "Current PoH hash rate per second"
    ).unwrap();
    
    /// Current PoH slot
    static ref POH_CURRENT_SLOT: Gauge = register_gauge!(
        "qnet_poh_current_slot",
        "Current PoH slot number"
    ).unwrap();
    
    /// PoH checkpoint count
    static ref POH_CHECKPOINT_COUNT: Counter = register_counter!(
        "qnet_poh_checkpoint_count_total",
        "Total number of PoH checkpoints saved"
    ).unwrap();
}

/// Number of hashes to perform between entries
/// Optimized for QNet: 1-second microblocks need frequent PoH updates
const HASHES_PER_TICK: u64 = 5_000; // Reduced from 25K to 5K for 500K hashes/sec total

/// Target tick duration in milliseconds
/// 10ms provides good balance: 100 updates/sec for smooth entropy
const TICK_DURATION_US: u64 = 10_000; // 10ms ticks

/// Number of ticks per slot (1 second = 100 ticks)
/// Aligned with QNet's 1-second microblock interval
const TICKS_PER_SLOT: u64 = 100;

/// Maximum drift allowed between PoH time and wall clock (5%)
const MAX_DRIFT_PERCENT: f64 = 0.05;

/// PoH Entry representing a single tick or transaction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoHEntry {
    /// Sequential counter
    pub num_hashes: u64,
    /// Current hash in the chain
    pub hash: Vec<u8>,
    /// Optional transaction/event data
    pub data: Option<Vec<u8>>,
    /// Wall clock timestamp for drift detection
    pub timestamp: u64,
}

/// Quantum PoH State
#[derive(Debug)]
pub struct QuantumPoH {
    /// Current hash in the chain
    current_hash: Arc<RwLock<Vec<u8>>>,
    /// Number of hashes computed
    hash_count: Arc<RwLock<u64>>,
    /// Current slot number
    current_slot: Arc<RwLock<u64>>,
    /// PoH start time for drift calculation
    start_time: Instant,
    /// Channel for PoH entries
    entry_sender: mpsc::UnboundedSender<PoHEntry>,
    /// Running flag
    is_running: Arc<RwLock<bool>>,
    /// Performance metrics
    hashes_per_second: Arc<RwLock<f64>>,
}

impl QuantumPoH {
    /// Create new Quantum PoH instance
    pub fn new(genesis_hash: Vec<u8>) -> (Self, mpsc::UnboundedReceiver<PoHEntry>) {
        let (entry_sender, entry_receiver) = mpsc::unbounded_channel();
        
        let poh = Self {
            current_hash: Arc::new(RwLock::new(genesis_hash)),
            hash_count: Arc::new(RwLock::new(0)),
            current_slot: Arc::new(RwLock::new(0)),
            start_time: Instant::now(),
            entry_sender,
            is_running: Arc::new(RwLock::new(false)),
            hashes_per_second: Arc::new(RwLock::new(0.0)),
        };
        
        (poh, entry_receiver)
    }
    
    /// Create new Quantum PoH instance from a checkpoint
    pub fn new_from_checkpoint(hash: Vec<u8>, count: u64) -> (Self, mpsc::UnboundedReceiver<PoHEntry>) {
        let (entry_sender, entry_receiver) = mpsc::unbounded_channel();
        
        // Calculate slot from count (1 slot = ~1M hashes)
        let slot = count / 1_000_000;
        
        let poh = Self {
            current_hash: Arc::new(RwLock::new(hash)),
            hash_count: Arc::new(RwLock::new(count)),
            current_slot: Arc::new(RwLock::new(slot)),
            start_time: Instant::now(),
            entry_sender,
            is_running: Arc::new(RwLock::new(false)),
            hashes_per_second: Arc::new(RwLock::new(0.0)),
        };
        
        println!("[QuantumPoH] 🔄 Initialized from checkpoint: count={}, slot={}", count, slot);
        
        (poh, entry_receiver)
    }
    
    /// Synchronize existing PoH instance with a checkpoint
    /// This is used when receiving blocks from other nodes to maintain consistent PoH state
    pub async fn sync_from_checkpoint(&self, hash: &[u8], count: u64) {
        // CRITICAL FIX: Prevent PoH regression - only sync forward, never backward!
        // This prevents deadlock when older blocks are received during resync
        let current_count = *self.hash_count.read().await;
        
        if count < current_count {
            // Do NOT sync backward - this would cause PoH regression and block production failure
            println!("[QuantumPoH] ⚠️ Skipping sync to older checkpoint: {} < current {}", 
                    count, current_count);
            return;
        }
        
        *self.current_hash.write().await = hash.to_vec();
        *self.hash_count.write().await = count;
        *self.current_slot.write().await = count / 1_000_000;
        
        println!("[QuantumPoH] 🔄 Synchronized to checkpoint: count={}, slot={} (forward from {})", 
                count, count / 1_000_000, current_count);
    }
    
    /// Start PoH generator
    pub async fn start(&self) {
        let mut is_running = self.is_running.write().await;
        if *is_running {
            println!("[QuantumPoH] ⚠️ Already running");
            return;
        }
        *is_running = true;
        drop(is_running);
        
        println!("[QuantumPoH] 🚀 Starting Quantum PoH generator");
        
        // Clone for async task
        let current_hash = self.current_hash.clone();
        let hash_count = self.hash_count.clone();
        let current_slot = self.current_slot.clone();
        let entry_sender = self.entry_sender.clone();
        let is_running = self.is_running.clone();
        let hashes_per_second = self.hashes_per_second.clone();
        let start_time = self.start_time;
        
        // Spawn PoH generator task
        tokio::spawn(async move {
            let mut tick_timer = tokio::time::interval(Duration::from_micros(TICK_DURATION_US));
            let mut last_hash_count = 0u64;
            let mut last_perf_check = Instant::now();
            let mut last_count = 0u64; // For metrics update
            
            while *is_running.read().await {
                tick_timer.tick().await;
                
                // Generate hashes for this tick
                let mut hash = current_hash.write().await;
                let mut count = hash_count.write().await;
                
                // OPTIMIZED VDF: SHA3-512 with performance improvements
                // Using fixed-size arrays and pre-allocated buffers
                let mut hash_bytes = [0u8; 64];
                hash_bytes[..hash.len().min(64)].copy_from_slice(&hash[..hash.len().min(64)]);
                
                // Hybrid SHA3-512 / Blake3 approach for optimal security/performance
                // Every 4th hash uses SHA3-512 for VDF property, others use Blake3 for speed
                for i in 0..HASHES_PER_TICK {
                    if i % 4 == 0 {
                        // Every 4th iteration: SHA3-512 for VDF property (prevents parallelization)
                        let mut hasher = Sha3_512::new();
                        hasher.update(&hash_bytes);
                        let counter = (*count + i).to_le_bytes();
                        hasher.update(&counter);
                        let result = hasher.finalize();
                        hash_bytes.copy_from_slice(&result);
                    } else {
                        // Other iterations: Blake3 for speed (3x faster than SHA3)
                        let mut hasher = blake3::Hasher::new();
                        hasher.update(&hash_bytes);
                        let counter = (*count + i).to_le_bytes();
                        hasher.update(&counter);
                        let result = hasher.finalize();
                        // Blake3 gives 32 bytes, extend to 64 for consistency
                        hash_bytes[..32].copy_from_slice(result.as_bytes());
                        let mut hasher2 = blake3::Hasher::new();
                        hasher2.update(result.as_bytes());
                        let result2 = hasher2.finalize();
                        hash_bytes[32..].copy_from_slice(result2.as_bytes());
                    }
                }
                
                *hash = hash_bytes.to_vec();
                
                *count += HASHES_PER_TICK;
                
                // Create PoH entry
                let entry = PoHEntry {
                    num_hashes: *count,
                    hash: hash.clone(),
                    data: None,
                    timestamp: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_micros() as u64,
                };
                
                // Send entry
                if entry_sender.send(entry).is_err() {
                    println!("[QuantumPoH] ❌ Entry channel closed");
                    break;
                }
                
                // Update Prometheus metrics
                POH_HASH_COUNT.inc_by((*count - last_count) as f64);
                last_count = *count;
                
                // Update slot every TICKS_PER_SLOT ticks
                if *count % (HASHES_PER_TICK * TICKS_PER_SLOT) == 0 {
                    let mut slot = current_slot.write().await;
                    *slot += 1;
                    POH_CURRENT_SLOT.set(*slot as f64);
                    
                    // Check drift every slot
                    let elapsed = start_time.elapsed();
                    let expected_time = Duration::from_secs(*slot);
                    let drift = if elapsed > expected_time {
                        (elapsed - expected_time).as_secs_f64() / expected_time.as_secs_f64()
                    } else {
                        (expected_time - elapsed).as_secs_f64() / expected_time.as_secs_f64()
                    };
                    
                    if drift > MAX_DRIFT_PERCENT {
                        println!("[QuantumPoH] ⚠️ Clock drift detected: {:.2}% (slot {})", 
                                drift * 100.0, *slot);
                    }
                }
                
                // Calculate performance every second
                if last_perf_check.elapsed() >= Duration::from_secs(1) {
                    let hashes_done = *count - last_hash_count;
                    let elapsed_secs = last_perf_check.elapsed().as_secs_f64();
                    let hps = hashes_done as f64 / elapsed_secs;
                    
                    *hashes_per_second.write().await = hps;
                    POH_HASH_RATE.set(hps);
                    
                    // Log performance every 10 seconds (500K hashes/sec expected)
                    if *count % (HASHES_PER_TICK * TICKS_PER_SLOT * 10) == 0 {
                        println!("[QuantumPoH] ⚡ Performance: {:.2}M hashes/sec, Slot: {}", 
                                hps / 1_000_000.0, *current_slot.read().await);
                    }
                    
                    last_hash_count = *count;
                    last_perf_check = Instant::now();
                }
            }
            
            println!("[QuantumPoH] 🛑 Stopped");
        });
    }
    
    /// Stop PoH generator
    pub async fn stop(&self) {
        println!("[QuantumPoH] 🛑 Stopping PoH generator");
        *self.is_running.write().await = false;
    }
    
    /// Mix transaction into PoH chain
    pub async fn mix_transaction(&self, tx_data: Vec<u8>) -> Result<PoHEntry, String> {
        if !*self.is_running.read().await {
            return Err("PoH not running".to_string());
        }
        
        let mut hash = self.current_hash.write().await;
        let mut count = self.hash_count.write().await;
        
        // CRITICAL: Save baseline count to ensure monotonic increase
        let baseline_count = *count;
        
        // Mix transaction data into hash chain
        let mut hasher = Sha3_512::new();
        hasher.update(&*hash);
        hasher.update(&tx_data);
        hasher.update((*count).to_le_bytes());
        *hash = hasher.finalize().to_vec();
        *count += 1;
        
        // CRITICAL: Verify PoH counter increased (Byzantine safety)
        // This prevents PoH regression attacks and maintains chain integrity
        if *count <= baseline_count {
            return Err(format!("PoH counter did not increase: {} <= {}", *count, baseline_count));
        }
        
        let entry = PoHEntry {
            num_hashes: *count,
            hash: hash.clone(),
            data: Some(tx_data),
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_micros() as u64,
        };
        
        // Send entry
        self.entry_sender.send(entry.clone())
            .map_err(|_| "Failed to send entry".to_string())?;
        
        Ok(entry)
    }
    
    /// Get current PoH state
    pub async fn get_state(&self) -> (Vec<u8>, u64, u64) {
        let hash = self.current_hash.read().await.clone();
        let count = *self.hash_count.read().await;
        let slot = *self.current_slot.read().await;
        (hash, count, slot)
    }
    
    /// Verify PoH sequence
    pub fn verify_sequence(entries: &[PoHEntry], genesis_hash: &[u8]) -> bool {
        if entries.is_empty() {
            return true;
        }
        
        let mut current_hash = genesis_hash.to_vec();
        let mut last_count = 0u64;
        
        for entry in entries {
            // Verify hash count is increasing
            if entry.num_hashes <= last_count {
                println!("[QuantumPoH] ❌ Invalid hash count: {} <= {}", 
                        entry.num_hashes, last_count);
                return false;
            }
            
            // Recompute hashes
            let hashes_to_compute = entry.num_hashes - last_count;
            
            for i in 0..hashes_to_compute {
                let count = last_count + i;
                
                // If this is the last hash and we have data, mix it in
                if i == hashes_to_compute - 1 && entry.data.is_some() {
                    let mut hasher = Sha3_512::new();
                    hasher.update(&current_hash);
                    hasher.update(entry.data.as_ref().unwrap());
                    hasher.update(count.to_le_bytes());
                    current_hash = hasher.finalize().to_vec();
                } else {
                    // Regular hash
                    if count % 2 == 0 {
                        let mut hasher = Sha3_512::new();
                        hasher.update(&current_hash);
                        hasher.update(count.to_le_bytes());
                        current_hash = hasher.finalize().to_vec();
                    } else {
                        let mut hasher = blake3::Hasher::new();
                        hasher.update(&current_hash);
                        hasher.update(&count.to_le_bytes());
                        current_hash = hasher.finalize().as_bytes().to_vec();
                    }
                }
            }
            
            // Verify hash matches
            if current_hash != entry.hash {
                println!("[QuantumPoH] ❌ Hash mismatch at count {}", entry.num_hashes);
                return false;
            }
            
            last_count = entry.num_hashes;
        }
        
        println!("[QuantumPoH] ✅ Sequence verified: {} entries", entries.len());
        true
    }
    
    /// Get current performance metrics
    pub async fn get_performance(&self) -> f64 {
        *self.hashes_per_second.read().await
    }
}

/// Integration with QNet blocks
impl QuantumPoH {
    /// Create PoH proof for a microblock
    pub async fn create_microblock_proof(&self, block_data: &[u8]) -> Result<PoHEntry, String> {
        self.mix_transaction(block_data.to_vec()).await
    }
    
    /// Create PoH checkpoint for macroblock
    pub async fn create_macroblock_checkpoint(&self) -> PoHEntry {
        let (hash, count, slot) = self.get_state().await;
        
        PoHEntry {
            num_hashes: count,
            hash,
            data: Some(format!("MACROBLOCK_CHECKPOINT_SLOT_{}", slot).into_bytes()),
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_micros() as u64,
        }
    }
}


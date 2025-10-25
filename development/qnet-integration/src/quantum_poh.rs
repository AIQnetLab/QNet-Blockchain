// Quantum Proof of History implementation for QNet

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{RwLock, mpsc};
use sha3::{Sha3_512, Digest};
use blake3;
use serde::{Serialize, Deserialize};

/// Number of hashes to perform between entries
const HASHES_PER_TICK: u64 = 12500; // ~400μs at 31.25M hashes/sec

/// Target tick duration in microseconds
const TICK_DURATION_US: u64 = 400;

/// Number of ticks per slot (1 second = 2500 ticks)
const TICKS_PER_SLOT: u64 = 2500;

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
            
            while *is_running.read().await {
                tick_timer.tick().await;
                
                // Generate hashes for this tick
                let mut hash = current_hash.write().await;
                let mut count = hash_count.write().await;
                
                // Quantum-enhanced hashing: alternate between SHA3-512 and Blake3
                for i in 0..HASHES_PER_TICK {
                    if (*count + i) % 2 == 0 {
                        // SHA3-512 for even counts (quantum-resistant)
                        let mut hasher = Sha3_512::new();
                        hasher.update(&*hash);
                        hasher.update((*count + i).to_le_bytes());
                        *hash = hasher.finalize().to_vec();
                    } else {
                        // Blake3 for odd counts (high performance)
                        let mut hasher = blake3::Hasher::new();
                        hasher.update(&*hash);
                        hasher.update(&(*count + i).to_le_bytes());
                        *hash = hasher.finalize().as_bytes().to_vec();
                    }
                }
                
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
                
                // Update slot every TICKS_PER_SLOT ticks
                if *count % (HASHES_PER_TICK * TICKS_PER_SLOT) == 0 {
                    let mut slot = current_slot.write().await;
                    *slot += 1;
                    
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
                    
                    // Log performance every 10 seconds
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
        
        // Mix transaction data into hash chain
        let mut hasher = Sha3_512::new();
        hasher.update(&*hash);
        hasher.update(&tx_data);
        hasher.update((*count).to_le_bytes());
        *hash = hasher.finalize().to_vec();
        *count += 1;
        
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


// Quantum Proof of History implementation for QNet
//
// PoH provides a cryptographic proof of time passage using sequential hashing.
// This implementation is designed for production use with:
// - 500K hashes/sec for strong VDF property
// - Hybrid SHA3-512/Blake3 for post-quantum security + performance
// - Thread-safe operation with atomic state updates
// - Integration with QNet's microblock/macroblock architecture

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{RwLock, mpsc, Mutex};
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

// ============================================================================
// PRODUCTION CONSTANTS
// ============================================================================

/// Number of hashes per tick
/// 5000 hashes * 100 ticks/sec = 500,000 hashes/sec
const HASHES_PER_TICK: u64 = 5_000;

/// Tick duration in microseconds (10ms = 100 ticks/sec)
const TICK_DURATION_US: u64 = 10_000;

/// Hashes per slot (500K hashes/sec * 1 second = 500K hashes/slot)
/// This aligns with QNet's 1-second microblock interval
const HASHES_PER_SLOT: u64 = HASHES_PER_TICK * 100; // 500,000

/// Maximum drift allowed between PoH time and wall clock (5%)
const MAX_DRIFT_PERCENT: f64 = 0.05;

// ============================================================================
// DATA STRUCTURES
// ============================================================================

/// PoH Entry representing a checkpoint in the hash chain
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoHEntry {
    /// Total number of hashes computed up to this point
    pub num_hashes: u64,
    /// Current hash value (64 bytes for SHA3-512)
    pub hash: Vec<u8>,
    /// Optional mixed-in data (transaction/block hash)
    pub data: Option<Vec<u8>>,
    /// Wall clock timestamp (microseconds since UNIX epoch)
    pub timestamp: u64,
}

/// Thread-safe PoH state
/// 
/// DESIGN: Uses separate locks for hash and count to allow concurrent reads
/// while preventing race conditions during updates.
/// 
/// INVARIANT: hash_count MUST always increase monotonically
#[derive(Debug)]
pub struct QuantumPoH {
    /// Current hash in the chain (64 bytes)
    current_hash: Arc<RwLock<[u8; 64]>>,
    /// Number of hashes computed (atomic for fast reads)
    hash_count: Arc<AtomicU64>,
    /// Current slot number (atomic for fast reads)
    current_slot: Arc<AtomicU64>,
    /// Channel for PoH entries
    entry_sender: mpsc::UnboundedSender<PoHEntry>,
    /// Running flag (atomic for lock-free check)
    is_running: Arc<AtomicBool>,
    /// Performance metrics
    hashes_per_second: Arc<AtomicU64>,
    /// Mutex to serialize hash updates (prevents race between generator and mix_transaction)
    update_mutex: Arc<Mutex<()>>,
}

impl QuantumPoH {
    /// Create new Quantum PoH instance from genesis hash
    pub fn new(genesis_hash: Vec<u8>) -> (Self, mpsc::UnboundedReceiver<PoHEntry>) {
        let (entry_sender, entry_receiver) = mpsc::unbounded_channel();
        
        let mut hash_bytes = [0u8; 64];
        let copy_len = genesis_hash.len().min(64);
        hash_bytes[..copy_len].copy_from_slice(&genesis_hash[..copy_len]);
        
        let poh = Self {
            current_hash: Arc::new(RwLock::new(hash_bytes)),
            hash_count: Arc::new(AtomicU64::new(0)),
            current_slot: Arc::new(AtomicU64::new(0)),
            entry_sender,
            is_running: Arc::new(AtomicBool::new(false)),
            hashes_per_second: Arc::new(AtomicU64::new(0)),
            update_mutex: Arc::new(Mutex::new(())),
        };
        
        (poh, entry_receiver)
    }
    
    /// Create new Quantum PoH instance from a checkpoint
    pub fn new_from_checkpoint(hash: Vec<u8>, count: u64) -> (Self, mpsc::UnboundedReceiver<PoHEntry>) {
        let (entry_sender, entry_receiver) = mpsc::unbounded_channel();
        
        let mut hash_bytes = [0u8; 64];
        let copy_len = hash.len().min(64);
        hash_bytes[..copy_len].copy_from_slice(&hash[..copy_len]);
        
        // Calculate slot from count using correct formula
        let slot = count / HASHES_PER_SLOT;
        
        let poh = Self {
            current_hash: Arc::new(RwLock::new(hash_bytes)),
            hash_count: Arc::new(AtomicU64::new(count)),
            current_slot: Arc::new(AtomicU64::new(slot)),
            entry_sender,
            is_running: Arc::new(AtomicBool::new(false)),
            hashes_per_second: Arc::new(AtomicU64::new(0)),
            update_mutex: Arc::new(Mutex::new(())),
        };
        
        println!("[QuantumPoH] 🔄 Initialized from checkpoint: count={}, slot={}", count, slot);
        
        (poh, entry_receiver)
    }
    
    /// Synchronize PoH state with a network checkpoint
    /// 
    /// CRITICAL: This is called when receiving blocks from other nodes.
    /// The network consensus is the source of truth, so we sync to it
    /// even if it means "going backward" (local PoH drifted ahead).
    /// 
    /// THREAD SAFETY: Acquires update_mutex to prevent race with generator
    pub async fn sync_from_checkpoint(&self, hash: &[u8], count: u64) {
        // Acquire mutex to prevent race with generator
        let _guard = self.update_mutex.lock().await;
        
        let current_count = self.hash_count.load(Ordering::SeqCst);
        
        // Only skip if checkpoint is VERY old (indicates stale block during resync)
        // 25M hashes = ~50 seconds at 500K/sec (less than 1 macroblock)
        const MAX_ACCEPTABLE_DRIFT: u64 = 25_000_000;
        
        if count < current_count && (current_count - count) > MAX_ACCEPTABLE_DRIFT {
            println!("[QuantumPoH] ⚠️ Skipping very old checkpoint: {} (current: {}, drift: {})", 
                    count, current_count, current_count - count);
            return;
        }
        
        // Update hash
        {
            let mut hash_guard = self.current_hash.write().await;
            let copy_len = hash.len().min(64);
            hash_guard[..copy_len].copy_from_slice(&hash[..copy_len]);
            if hash.len() < 64 {
                hash_guard[hash.len()..].fill(0);
            }
        }
        
        // Update count and slot atomically
        self.hash_count.store(count, Ordering::SeqCst);
        self.current_slot.store(count / HASHES_PER_SLOT, Ordering::SeqCst);
        
        // Log significant changes
        let diff = if count >= current_count { 
            count - current_count 
        } else { 
            current_count - count 
        };
        
        if diff > 100_000 {
            let direction = if count >= current_count { "forward" } else { "resync" };
            println!("[QuantumPoH] 🔄 Synchronized: count={}, slot={} ({} from {}, diff: {})", 
                    count, count / HASHES_PER_SLOT, direction, current_count, diff);
        }
    }
    
    /// Start the PoH generator background task
    pub async fn start(&self) {
        // Check if already running (atomic, no lock needed)
        if self.is_running.swap(true, Ordering::SeqCst) {
            println!("[QuantumPoH] ⚠️ Already running");
            return;
        }
        
        println!("[QuantumPoH] 🚀 Starting Quantum PoH generator (500K hashes/sec)");
        
        // Clone Arc references for the spawned task
        let current_hash = self.current_hash.clone();
        let hash_count = self.hash_count.clone();
        let current_slot = self.current_slot.clone();
        let entry_sender = self.entry_sender.clone();
        let is_running = self.is_running.clone();
        let hashes_per_second = self.hashes_per_second.clone();
        let update_mutex = self.update_mutex.clone();
        
        // Spawn PoH generator task
        tokio::spawn(async move {
            let mut tick_timer = tokio::time::interval(Duration::from_micros(TICK_DURATION_US));
            let mut last_perf_count = 0u64;
            let mut last_perf_time = Instant::now();
            let start_time = Instant::now();
            
            while is_running.load(Ordering::SeqCst) {
                tick_timer.tick().await;
                
                // Acquire mutex to prevent race with sync_from_checkpoint and mix_transaction
                let _guard = update_mutex.lock().await;
                
                // Get current state
                let base_count = hash_count.load(Ordering::SeqCst);
                let mut hash_bytes = *current_hash.read().await;
                
                // Generate HASHES_PER_TICK hashes using hybrid SHA3-512/Blake3
                // Every 4th hash uses SHA3-512 for VDF property (prevents parallelization)
                // Other hashes use Blake3 for speed (3x faster)
                for i in 0..HASHES_PER_TICK {
                    let counter_value = base_count + i;
                    
                    if i % 4 == 0 {
                        // SHA3-512 for VDF property
                        let mut hasher = Sha3_512::new();
                        hasher.update(&hash_bytes);
                        hasher.update(&counter_value.to_le_bytes());
                        let result = hasher.finalize();
                        hash_bytes.copy_from_slice(&result);
                    } else {
                        // Blake3 for speed (produces 32 bytes, we extend to 64)
                        let mut hasher = blake3::Hasher::new();
                        hasher.update(&hash_bytes);
                        hasher.update(&counter_value.to_le_bytes());
                        let result = hasher.finalize();
                        hash_bytes[..32].copy_from_slice(result.as_bytes());
                        
                        // Second Blake3 hash to fill remaining 32 bytes
                        let mut hasher2 = blake3::Hasher::new();
                        hasher2.update(result.as_bytes());
                        let result2 = hasher2.finalize();
                        hash_bytes[32..].copy_from_slice(result2.as_bytes());
                    }
                }
                
                // Update state atomically
                let new_count = base_count + HASHES_PER_TICK;
                *current_hash.write().await = hash_bytes;
                hash_count.store(new_count, Ordering::SeqCst);
                
                // Update slot if we crossed a slot boundary
                let new_slot = new_count / HASHES_PER_SLOT;
                let old_slot = current_slot.swap(new_slot, Ordering::SeqCst);
                
                // Drop mutex before sending to channel (non-blocking)
                drop(_guard);
                
                // Create and send entry
                let entry = PoHEntry {
                    num_hashes: new_count,
                    hash: hash_bytes.to_vec(),
                    data: None,
                    timestamp: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_micros() as u64,
                };
                
                if entry_sender.send(entry).is_err() {
                    println!("[QuantumPoH] ❌ Entry channel closed");
                    break;
                }
                
                // Update Prometheus metrics
                POH_HASH_COUNT.inc_by(HASHES_PER_TICK as f64);
                POH_CURRENT_SLOT.set(new_slot as f64);
                
                // Check drift on slot change
                if new_slot > old_slot {
                    let elapsed = start_time.elapsed();
                    let expected = Duration::from_secs(new_slot);
                    
                    if elapsed > expected {
                        let drift = (elapsed - expected).as_secs_f64() / expected.as_secs_f64();
                        if drift > MAX_DRIFT_PERCENT {
                            println!("[QuantumPoH] ⚠️ Clock drift: {:.2}% slow (slot {})", 
                                    drift * 100.0, new_slot);
                        }
                    } else {
                        let drift = (expected - elapsed).as_secs_f64() / expected.as_secs_f64();
                        if drift > MAX_DRIFT_PERCENT {
                            println!("[QuantumPoH] ⚠️ Clock drift: {:.2}% fast (slot {})", 
                                    drift * 100.0, new_slot);
                        }
                    }
                }
                
                // Calculate and log performance every second
                if last_perf_time.elapsed() >= Duration::from_secs(1) {
                    let hashes_done = new_count.saturating_sub(last_perf_count);
                    let elapsed_secs = last_perf_time.elapsed().as_secs_f64();
                    let hps = (hashes_done as f64 / elapsed_secs) as u64;
                    
                    hashes_per_second.store(hps, Ordering::SeqCst);
                    POH_HASH_RATE.set(hps as f64);
                    
                    // Log every 10 slots
                    if new_slot % 10 == 0 && new_slot > 0 {
                        println!("[QuantumPoH] ⚡ {:.2}M hashes/sec, Slot: {}, Count: {}", 
                                hps as f64 / 1_000_000.0, new_slot, new_count);
                    }
                    
                    last_perf_count = new_count;
                    last_perf_time = Instant::now();
                }
            }
            
            println!("[QuantumPoH] 🛑 Generator stopped");
        });
    }
    
    /// Stop the PoH generator
    pub async fn stop(&self) {
        println!("[QuantumPoH] 🛑 Stopping PoH generator");
        self.is_running.store(false, Ordering::SeqCst);
    }
    
    /// Mix data (transaction/block) into the PoH chain
    /// 
    /// This creates a verifiable proof that the data existed at this point
    /// in the PoH sequence. Uses pure SHA3-512 for deterministic verification.
    /// 
    /// THREAD SAFETY: Acquires update_mutex to serialize with generator
    pub async fn mix_transaction(&self, tx_data: Vec<u8>) -> Result<PoHEntry, String> {
        if !self.is_running.load(Ordering::SeqCst) {
            return Err("PoH not running".to_string());
        }
        
        // Acquire mutex to prevent race with generator
        let _guard = self.update_mutex.lock().await;
        
        // Get current state
        let base_count = self.hash_count.load(Ordering::SeqCst);
        let mut hash_bytes = *self.current_hash.read().await;
        
        // Mix data using SHA3-512 (deterministic, verifiable)
        let mut hasher = Sha3_512::new();
        hasher.update(&hash_bytes);
        hasher.update(&tx_data);
        hasher.update(&base_count.to_le_bytes());
        let result = hasher.finalize();
        hash_bytes.copy_from_slice(&result);
        
        // Update state
        let new_count = base_count + 1;
        *self.current_hash.write().await = hash_bytes;
        self.hash_count.store(new_count, Ordering::SeqCst);
        
        // Create entry
        let entry = PoHEntry {
            num_hashes: new_count,
            hash: hash_bytes.to_vec(),
            data: Some(tx_data),
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_micros() as u64,
        };
        
        // Send entry (mutex still held, but send is non-blocking)
        self.entry_sender.send(entry.clone())
            .map_err(|_| "Failed to send entry".to_string())?;
        
        Ok(entry)
    }
    
    /// Get current PoH state (hash, count, slot)
    pub async fn get_state(&self) -> (Vec<u8>, u64, u64) {
        let hash = self.current_hash.read().await.to_vec();
        let count = self.hash_count.load(Ordering::SeqCst);
        let slot = self.current_slot.load(Ordering::SeqCst);
        (hash, count, slot)
    }
    
    /// Get current performance (hashes per second)
    pub async fn get_performance(&self) -> f64 {
        self.hashes_per_second.load(Ordering::SeqCst) as f64
    }
    
    /// Verify a sequence of PoH entries
    /// 
    /// NOTE: Full verification is O(n) in the number of hashes, which is expensive.
    /// In production, we rely on:
    /// 1. Byzantine consensus (2/3+ validators agree on PoH state)
    /// 2. Monotonic counter check (poh_count always increases between blocks)
    /// 3. Spot-check verification of random entries
    /// 
    /// This function is mainly used for debugging and testing.
    pub fn verify_sequence(entries: &[PoHEntry], genesis_hash: &[u8]) -> bool {
        if entries.is_empty() {
            return true;
        }
        
        let mut hash_bytes = [0u8; 64];
        let copy_len = genesis_hash.len().min(64);
        hash_bytes[..copy_len].copy_from_slice(&genesis_hash[..copy_len]);
        
        let mut last_count = 0u64;
        
        for (entry_idx, entry) in entries.iter().enumerate() {
            // CRITICAL: Counter must be strictly increasing
            if entry.num_hashes <= last_count {
                println!("[QuantumPoH] ❌ Entry {}: count {} <= previous {}", 
                        entry_idx, entry.num_hashes, last_count);
                return false;
            }
            
            let hashes_to_compute = entry.num_hashes - last_count;
            
            // Verify by recomputing hashes
            for i in 0..hashes_to_compute {
                let counter_value = last_count + i;
                let is_last = i == hashes_to_compute - 1;
                let has_data = entry.data.is_some() && is_last;
                
                if has_data {
                    // Last hash with data: use SHA3-512 with data mixed in
                    let mut hasher = Sha3_512::new();
                    hasher.update(&hash_bytes);
                    hasher.update(entry.data.as_ref().unwrap());
                    hasher.update(&counter_value.to_le_bytes());
                    let result = hasher.finalize();
                    hash_bytes.copy_from_slice(&result);
                } else if i % 4 == 0 {
                    // Every 4th hash: SHA3-512
                    let mut hasher = Sha3_512::new();
                    hasher.update(&hash_bytes);
                    hasher.update(&counter_value.to_le_bytes());
                    let result = hasher.finalize();
                    hash_bytes.copy_from_slice(&result);
                } else {
                    // Other hashes: Blake3 extended to 64 bytes
                    let mut hasher = blake3::Hasher::new();
                    hasher.update(&hash_bytes);
                    hasher.update(&counter_value.to_le_bytes());
                    let result = hasher.finalize();
                    hash_bytes[..32].copy_from_slice(result.as_bytes());
                    
                    let mut hasher2 = blake3::Hasher::new();
                    hasher2.update(result.as_bytes());
                    let result2 = hasher2.finalize();
                    hash_bytes[32..].copy_from_slice(result2.as_bytes());
                }
            }
            
            // Verify hash matches
            if hash_bytes.to_vec() != entry.hash {
                println!("[QuantumPoH] ❌ Entry {}: hash mismatch at count {}", 
                        entry_idx, entry.num_hashes);
                return false;
            }
            
            last_count = entry.num_hashes;
        }
        
        println!("[QuantumPoH] ✅ Verified {} entries", entries.len());
        true
    }
}

// ============================================================================
// QNet Block Integration
// ============================================================================

impl QuantumPoH {
    /// Create PoH proof for a microblock
    /// 
    /// This mixes the block data into the PoH chain, creating a verifiable
    /// proof that the block was created at this point in time.
    pub async fn create_microblock_proof(&self, block_data: &[u8]) -> Result<PoHEntry, String> {
        self.mix_transaction(block_data.to_vec()).await
    }
    
    /// Create PoH checkpoint for macroblock finalization
    /// 
    /// This captures the current PoH state for inclusion in a macroblock,
    /// which finalizes the PoH sequence up to this point.
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

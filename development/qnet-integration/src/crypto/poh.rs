// QNet Verifiable Time Sequence (VTS) - Cryptographic time ordering
//
// VTS provides a cryptographic proof of time passage using sequential hashing,
// implementing a Verifiable Delay Function (VDF) for temporal ordering.
// 
// This implementation is designed for production use with:
// - 500K+ hashes/sec for strong VDF property (non-parallelizable)
// - Blake3 for maximum performance (sequential = VDF property)
// - Thread-safe operation with atomic state updates
// - Integration with QNet's microblock/macroblock architecture
//
// The sequential hash chain creates an unforgeable timeline that proves
// the ordering of events without relying on trusted timestamps.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{RwLock, mpsc, Mutex};
use blake3;
use serde::{Serialize, Deserialize};
use prometheus::{register_counter, register_gauge, Counter, Gauge};
use lazy_static::lazy_static;

lazy_static! {
    /// Total PoH hashes computed
    static ref POH_HASH_COUNT: Counter = register_counter!(
        "qnet_poh_hash_count_total",
        "Total number of PoH hashes computed"
    ).expect("Failed to create POH_HASH_COUNT metric");
    
    /// PoH hashes per second
    static ref POH_HASH_RATE: Gauge = register_gauge!(
        "qnet_poh_hash_rate",
        "Current PoH hash rate per second"
    ).expect("Failed to create POH_HASH_RATE metric");
    
    /// Current PoH slot
    static ref POH_CURRENT_SLOT: Gauge = register_gauge!(
        "qnet_poh_current_slot",
        "Current PoH slot number"
    ).expect("Failed to create POH_CURRENT_SLOT metric");
    
    /// PoH checkpoint count
    static ref POH_CHECKPOINT_COUNT: Counter = register_counter!(
        "qnet_poh_checkpoint_count_total",
        "Total number of PoH checkpoints saved"
    ).expect("Failed to create POH_CHECKPOINT_COUNT metric");
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
/// Drift is cosmetic (PoH count is an embedded proof, never a timing/consensus gate); log it at most
/// once per this many slots (~5 min) instead of every slot, so non-nominal hardware doesn't spam.
const POH_DRIFT_LOG_SLOTS: u64 = 300;

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
pub struct PoH {
    /// Current hash in the chain (64 bytes)
    current_hash: Arc<RwLock<[u8; 64]>>,
    /// Number of hashes computed (atomic for fast reads)
    hash_count: Arc<AtomicU64>,
    /// Current slot number (atomic for fast reads)
    current_slot: Arc<AtomicU64>,
    /// Channel for PoH entries
    entry_sender: mpsc::Sender<PoHEntry>,
    /// Running flag (atomic for lock-free check)
    is_running: Arc<AtomicBool>,
    /// Performance metrics
    hashes_per_second: Arc<AtomicU64>,
    /// Mutex to serialize hash updates (prevents race between generator and mix_transaction)
    update_mutex: Arc<Mutex<()>>,
    /// Timestamp of last backward sync (epoch seconds, for rate limiting)
    last_backward_sync: Arc<AtomicU64>,
    /// Count of backward syncs performed (for diagnostics)
    backward_sync_count: Arc<AtomicU64>,
}

impl PoH {
    /// Create new Quantum VTS instance from genesis hash
    pub fn new(genesis_hash: Vec<u8>) -> (Self, mpsc::Receiver<PoHEntry>) {
        let (entry_sender, entry_receiver) = mpsc::channel(10_000); // Bounded: 10K PoH entries max
        
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
            last_backward_sync: Arc::new(AtomicU64::new(0)),
            backward_sync_count: Arc::new(AtomicU64::new(0)),
        };

        (poh, entry_receiver)
    }
    
    /// Create new Quantum VTS instance from a checkpoint
    pub fn new_from_checkpoint(hash: Vec<u8>, count: u64) -> (Self, mpsc::Receiver<PoHEntry>) {
        let (entry_sender, entry_receiver) = mpsc::channel(10_000); // Bounded: 10K PoH entries max
        
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
            last_backward_sync: Arc::new(AtomicU64::new(0)),
            backward_sync_count: Arc::new(AtomicU64::new(0)),
        };

        println!("[INFO][POH] checkpoint_init count={} slot={}", count, slot);
        
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

        // Reduced drift window: ~10 seconds at 500K/sec (was ~50 seconds)
        const MAX_ACCEPTABLE_DRIFT: u64 = 5_000_000;

        // Rate limit backward syncs: at most one per 60 seconds
        const BACKWARD_SYNC_COOLDOWN_SECS: u64 = 60;

        if count < current_count && (current_count - count) > MAX_ACCEPTABLE_DRIFT {
            println!("[WARN][POH] checkpoint_too_old count={} current={} drift={}",
                    count, current_count, current_count - count);
            return;
        }

        // Rate-limit backward syncs to prevent manipulation
        if count < current_count {
            let now_secs = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let last_sync = self.last_backward_sync.load(Ordering::SeqCst);
            if last_sync > 0 && now_secs.saturating_sub(last_sync) < BACKWARD_SYNC_COOLDOWN_SECS {
                let sync_count = self.backward_sync_count.load(Ordering::SeqCst);
                println!("[WARN][POH] backward_sync_rate_limited count={} drift={} cooldown_remaining={}s",
                        sync_count, current_count - count, BACKWARD_SYNC_COOLDOWN_SECS - (now_secs - last_sync));
                return;
            }
            self.last_backward_sync.store(now_secs, Ordering::SeqCst);
            let sync_count = self.backward_sync_count.fetch_add(1, Ordering::SeqCst) + 1;
            println!("[WARN][POH] backward_sync count={} drift={}", sync_count, current_count - count);
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
            println!("[INFO][POH] sync direction={} count={} slot={} prev={} diff={}",
                    direction, count, count / HASHES_PER_SLOT, current_count, diff);
        }
    }
    
    /// Start the PoH generator background task
    pub async fn start(&self) {
        // Check if already running (atomic, no lock needed)
        if self.is_running.swap(true, Ordering::SeqCst) {
            println!("[PoH] ⚠️ Already running");
            return;
        }
        
        println!("[PoH] 🚀 Starting Quantum VTS generator (500K hashes/sec)");
        
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
                
                // Generate HASHES_PER_TICK hashes using Blake3 (100%)
                // Sequential hashing provides VDF property (non-parallelizable)
                // Blake3 is 3x faster than SHA3, sufficient for VDF
                for i in 0..HASHES_PER_TICK {
                    let counter_value = base_count + i;
                    
                    // Blake3 for all hashes (produces 32 bytes, we extend to 64)
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
                        .unwrap_or_default()
                        .as_micros() as u64,
                };
                
                match entry_sender.try_send(entry) {
                    Ok(()) => {},
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        println!("[WARN][POH] entry_channel_full capacity=10000");
                        // Drop entry rather than block the PoH generator
                    },
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        println!("[ERROR][POH] entry_channel_closed");
                        break;
                    },
                }
                
                // Update Prometheus metrics
                POH_HASH_COUNT.inc_by(HASHES_PER_TICK as f64);
                POH_CURRENT_SLOT.set(new_slot as f64);
                
                // Drift = this node's PoH-count vs wall mapping (hardware-dependent). Sampled every
                // POH_DRIFT_LOG_SLOTS (~5 min): non-nominal hardware drifts every slot, but the rate
                // is purely informational — PoH count is an embedded VDF proof, NEVER a consensus or
                // production-timing gate, so it cannot desync the node.
                if new_slot > old_slot && new_slot % POH_DRIFT_LOG_SLOTS == 0 {
                    let elapsed = start_time.elapsed();
                    let expected = Duration::from_secs(new_slot);
                    let (drift, dir) = if elapsed > expected {
                        ((elapsed - expected).as_secs_f64() / expected.as_secs_f64(), "slow")
                    } else {
                        ((expected - elapsed).as_secs_f64() / expected.as_secs_f64(), "fast")
                    };
                    if drift > MAX_DRIFT_PERCENT {
                        println!("[PoH] ⚠️ Clock drift: {:.2}% {} (slot {})", drift * 100.0, dir, new_slot);
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
                        println!("[PoH] ⚡ {:.2}M hashes/sec, Slot: {}, Count: {}", 
                                hps as f64 / 1_000_000.0, new_slot, new_count);
                    }
                    
                    last_perf_count = new_count;
                    last_perf_time = Instant::now();
                }
            }
            
            println!("[PoH] 🛑 Generator stopped");
        });
    }
    
    /// Stop the PoH generator
    pub async fn stop(&self) {
        println!("[PoH] 🛑 Stopping PoH generator");
        self.is_running.store(false, Ordering::SeqCst);
    }
    
    /// Mix data (transaction/block) into the PoH chain
    ///
    /// This creates a verifiable proof that the data existed at this point
    /// in the PoH sequence. Uses Blake3 for deterministic verification —
    /// chosen over SHA3-512 for per-tick hashing performance (≈5× faster
    /// while retaining 128-bit post-quantum security via Grover's bound).
    /// PoH is an internal time-sequence primitive and is NOT exposed as a
    /// consumer-facing crypto contract; consumer-facing commitments (block
    /// signatures, state Merkle) use NIST-standardised Dilithium3 and
    /// SHA3-256 respectively.
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
        
        // Mix data using Blake3 (deterministic, verifiable, fast)
        let mut hasher = blake3::Hasher::new();
        hasher.update(&hash_bytes);
        hasher.update(&tx_data);
        hasher.update(&base_count.to_le_bytes());
        let result = hasher.finalize();
        hash_bytes[..32].copy_from_slice(result.as_bytes());
        
        // Second Blake3 hash to fill remaining 32 bytes
        let mut hasher2 = blake3::Hasher::new();
        hasher2.update(result.as_bytes());
        let result2 = hasher2.finalize();
        hash_bytes[32..].copy_from_slice(result2.as_bytes());
        
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
                .unwrap_or_default()
                .as_micros() as u64,
        };
        
        // Send entry (mutex still held, try_send is non-blocking)
        self.entry_sender.try_send(entry.clone())
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => "PoH entry channel full (10K limit)".to_string(),
                mpsc::error::TrySendError::Closed(_) => "PoH entry channel closed".to_string(),
            })?;
        
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
                println!("[PoH] ❌ Entry {}: count {} <= previous {}", 
                        entry_idx, entry.num_hashes, last_count);
                return false;
            }
            
            let hashes_to_compute = entry.num_hashes - last_count;
            
            // Verify by recomputing hashes
            for i in 0..hashes_to_compute {
                let counter_value = last_count + i;
                let is_last = i == hashes_to_compute - 1;
                let has_data = entry.data.is_some() && is_last;
                
                // Blake3 for all hashes (100%)
                let mut hasher = blake3::Hasher::new();
                hasher.update(&hash_bytes);
                
                // Mix in data if this is the last hash with data
                if has_data {
                    hasher.update(entry.data.as_ref().expect("Checked is_some above"));
                }
                
                hasher.update(&counter_value.to_le_bytes());
                let result = hasher.finalize();
                hash_bytes[..32].copy_from_slice(result.as_bytes());
                
                // Second Blake3 hash to fill remaining 32 bytes
                let mut hasher2 = blake3::Hasher::new();
                hasher2.update(result.as_bytes());
                let result2 = hasher2.finalize();
                hash_bytes[32..].copy_from_slice(result2.as_bytes());
            }
            
            // Verify hash matches
            if hash_bytes.to_vec() != entry.hash {
                println!("[PoH] ❌ Entry {}: hash mismatch at count {}", 
                        entry_idx, entry.num_hashes);
                return false;
            }
            
            last_count = entry.num_hashes;
        }
        
        println!("[PoH] ✅ Verified {} entries", entries.len());
        true
    }
}

// ============================================================================
// QNet Block Integration
// ============================================================================

impl PoH {
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
                .unwrap_or_default()
                .as_micros() as u64,
        }
    }
}

// Type aliases for public API (VTS = Verifiable Time Sequence)
/// Verifiable Time Sequence - cryptographic time ordering
pub type VerifiableTimeSequence = PoH;
/// VTS Entry - checkpoint in the verifiable time chain  
pub type VTSEntry = PoHEntry;

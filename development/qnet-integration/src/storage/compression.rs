//! Adaptive compression, pattern-based transaction packing, cleanup tiers and usage limits.

use super::*;

/// The critical fill level: a Super node alerts and compacts (`DiskPressure`), a Light node cleans up and refuses
/// further blocks.
pub(crate) const STORAGE_CRITICAL_PCT: f64 = 95.0;
/// Below this a Super node's critical state ends: just under STORAGE_CRITICAL_PCT, so a level at the line neither
/// alerts on every save nor flaps.
pub(crate) const STORAGE_CRITICAL_CLEAR_PCT: f64 = 94.0;
/// While a Super node stays critical: one [CRIT] line this often.
pub(crate) const STORAGE_CRITICAL_REPEAT_SECS: u64 = 600;

/// A Super node's state at the critical fill level (`Storage::note_super_fill`). It never stops storing blocks for it:
/// the disk also fills with data that is not the node's, and a node that stopped storing would stop applying blocks.
#[derive(Debug, Default)]
pub(crate) struct DiskPressure {
    critical: bool,
    last_alert: Option<u64>,
    /// The episode's one emergency compaction has started: a disk filled by other data would make every further run
    /// rewrite the database for nothing.
    episode_compacted: bool,
}

/// What one fill reading asks of a Super node.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct PressureStep {
    pub(crate) alert: bool,
    pub(crate) compact: bool,
    pub(crate) cleared: bool,
}

impl DiskPressure {
    /// The reaction to fill level `pct` at `now`: an episode runs from STORAGE_CRITICAL_PCT until the level falls below
    /// STORAGE_CRITICAL_CLEAR_PCT, alerting at once and then once per STORAGE_CRITICAL_REPEAT_SECS, and compacting once.
    pub(crate) fn step(&mut self, pct: f64, now: u64) -> PressureStep {
        if self.critical && pct < STORAGE_CRITICAL_CLEAR_PCT {
            *self = DiskPressure::default();
            return PressureStep { cleared: true, ..PressureStep::default() };
        }
        if !self.critical && pct < STORAGE_CRITICAL_PCT {
            return PressureStep::default();
        }
        self.critical = true;
        // A stamp ahead of the clock (the clock was set back) counts as due.
        let alert = self.last_alert.map_or(true, |t| t > now || now - t >= STORAGE_CRITICAL_REPEAT_SECS);
        if alert { self.last_alert = Some(now); }
        let compact = !self.episode_compacted;
        self.episode_compacted = true;
        PressureStep { alert, compact, cleared: false }
    }
}

/// Percent of the data disk in use, as `df` reports it: used / (used + available to writers).
/// None where the filesystem cannot be read.
#[cfg(unix)]
pub(crate) fn disk_used_pct(dir: &std::path::Path) -> Option<f64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is NUL-terminated and `s` is a writable statvfs the call fills.
    if unsafe { libc::statvfs(path.as_ptr(), &mut s) } != 0 { return None; }
    let used = (s.f_blocks as f64 - s.f_bfree as f64).max(0.0);
    let usable = used + s.f_bavail as f64;
    if usable <= 0.0 { None } else { Some(used / usable * 100.0) }
}

#[cfg(not(unix))]
pub(crate) fn disk_used_pct(_dir: &std::path::Path) -> Option<f64> { None }

/// How full the node's storage is, in percent: the tighter of the operator cap and the disk itself.
/// A cap larger than the disk (2000 GB configured on a 388 GB disk) can then never hide a full disk.
pub(crate) fn storage_fill_pct(usage_bytes: u64, cap_bytes: u64, disk_pct: Option<f64>) -> f64 {
    let of_cap = if cap_bytes == 0 { 0.0 } else { usage_bytes as f64 / cap_bytes as f64 * 100.0 };
    of_cap.max(disk_pct.unwrap_or(0.0))
}

impl Storage {
    /// High-level compression utilities for archive data
    pub fn compress_archive_data(&self, data: &[u8]) -> IntegrationResult<Vec<u8>> {
        let compressed = zstd::encode_all(data, 9) // Level 9 for maximum compression (archive data)
            .map_err(|e| IntegrationError::Other(format!("Zstd compression error: {}", e)))?;
            
        if compressed.len() < data.len() {
            println!("[INFO][STORAGE] archive_compressed from={} to={}", 
                    data.len(), compressed.len());
            Ok(compressed)
        } else {
            println!("[INFO][STORAGE] archive_compress_skipped reason=no_benefit");
            Ok(data.to_vec())
        }
    }
    
    /// Decompress archive data
    pub fn decompress_archive_data(&self, data: &[u8]) -> IntegrationResult<Vec<u8>> {
        // Try to decompress with Zstd first
        match zstd::decode_all(data) {
            Ok(decompressed) => {
                println!("[INFO][STORAGE] archive_decompressed from={} to={}", 
                        data.len(), decompressed.len());
                Ok(decompressed)
            },
            Err(_) => {
                // Data might not be compressed, return as-is
                println!("[INFO][STORAGE] data_not_compressed returning_as_is=true");
                Ok(data.to_vec())
            }
        }
    }
    
    /// Compress transaction pool for efficient storage
    pub fn compress_transaction_pool(&self) -> IntegrationResult<Vec<u8>> {
        let (tx_count, _) = self.transaction_pool.get_stats()?;
        
        if tx_count == 0 {
            return Ok(Vec::new());
        }
        
        println!("[INFO][STORAGE] tx_pool_compress_start count={}", tx_count);
        
        // Serialize all transactions
        let (transactions, creation_times) = self.transaction_pool.export();
        let pool_data = (&transactions, &creation_times);
        let serialized = bincode::serialize(&pool_data)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        drop(transactions);
        drop(creation_times);
        
        // Compress with high level for long-term storage
        let compressed = zstd::encode_all(&serialized[..], 6) // Level 6 for good compression
            .map_err(|e| IntegrationError::Other(format!("Zstd compression error: {}", e)))?;
            
        println!("[INFO][STORAGE] tx_pool_compressed from={} to={}", 
                serialized.len(), compressed.len());
                
        Ok(compressed)
    }
    
    /// PRODUCTION: Check storage usage and trigger emergency cleanup if needed
    pub fn check_storage_usage_and_cleanup(&self) -> IntegrationResult<bool> {
        // Get actual disk usage of the directory the database lives in
        let actual_usage = self.get_directory_size(&self.data_dir.to_string_lossy())?;

        // Update current usage tracking
        {
            let mut usage = self.current_storage_usage.write();
            *usage = actual_usage;
        }

        let disk_pct = disk_used_pct(&self.data_dir);
        let usage_percentage = storage_fill_pct(actual_usage, self.max_storage_size, disk_pct);

        if crate::node::is_info() {
            println!("[INFO][STORAGE] storage_usage used_gb={:.1} cap_gb={:.1} disk_used_pct={} pct={:.1}%",
                     actual_usage as f64 / (1024.0 * 1024.0 * 1024.0),
                     self.max_storage_size as f64 / (1024.0 * 1024.0 * 1024.0),
                     disk_pct.map_or("unknown".to_string(), |p| format!("{:.1}", p)),
                     usage_percentage);
        }

        // A Super node's critical state follows every reading, so it also ends while no block arrives.
        if self.storage_mode == StorageMode::Super {
            self.note_super_fill(usage_percentage, SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs());
        }
        // Trigger cleanup at different thresholds
        match usage_percentage {
            p if p >= STORAGE_CRITICAL_PCT => {
                if self.storage_mode != StorageMode::Super {
                    println!("[WARN][STORAGE] storage_critical_95pct_full triggering=emergency_cleanup");
                    let after = self.emergency_cleanup()?;
                    if after >= STORAGE_CRITICAL_PCT {
                        self.alert_critically_full(after, "refused");
                    }
                }
                Ok(false) // Emergency state
            },
            p if p >= 85.0 => {
                println!("[WARN][STORAGE] storage_warn_85pct_full triggering=aggressive_cleanup");
                self.aggressive_cleanup()?;
                Ok(false) // Warning state
            },
            p if p >= 70.0 => {
                println!("[INFO][STORAGE] storage_70pct_full triggering=standard_cleanup");
                self.standard_cleanup()?;
                Ok(true) // Normal operation
            },
            _ => {
                println!("[INFO][STORAGE] storage_normal pct={:.1}%", usage_percentage);
                Ok(true) // Normal operation
            }
        }
    }
    
    /// Get directory size in bytes
    pub(super) fn get_directory_size(&self, path: &str) -> IntegrationResult<u64> {
        let mut total_size = 0u64;
        
        fn visit_dir(dir: &std::path::Path, total: &mut u64) -> Result<(), Box<dyn std::error::Error>> {
            if dir.is_dir() {
                for entry in std::fs::read_dir(dir)? {
                    let entry = entry?;
                    let path = entry.path();
                    if path.is_dir() {
                        visit_dir(&path, total)?;
                    } else {
                        if let Ok(metadata) = entry.metadata() {
                            *total += metadata.len();
                        }
                    }
                }
            }
            Ok(())
        }
        
        if let Err(e) = visit_dir(std::path::Path::new(path), &mut total_size) {
            println!("[WARN][STORAGE] dir_size_failed err={}", e);
            // Fallback: return estimated size
            return Ok(self.estimate_storage_usage());
        }
        
        Ok(total_size)
    }
    
    /// Estimate storage usage based on blockchain height
    pub(super) fn estimate_storage_usage(&self) -> u64 {
        // Rough estimate: 32 KB per microblock + transaction pool
        if let Ok(height) = self.get_chain_height() {
            let microblock_size = height * 32 * 1024; // 32 KB per microblock
            let pool_size = 500 * 1024 * 1024; // 500 MB estimated pool size
            microblock_size + pool_size
        } else {
            0
        }
    }
    
    /// Standard cleanup (70-85% full) - remove ONLY cache data, preserve blockchain history
    pub(super) fn standard_cleanup(&self) -> IntegrationResult<()> {
        println!("[INFO][STORAGE] standard_cleanup_start cache_only=true history_preserved=true");
        
        // 1. Clean transaction pool cache (this is OK - only removes duplicates)
        let removed_tx = self.transaction_pool.cleanup_old_duplicates()?;
        println!("[INFO][STORAGE] tx_duplicates_removed count={}", removed_tx);

        // No compaction below the critical level: the prunes compact the families they shed rows from, RocksDB's own
        // compactions reclaim the rest, and a compaction of every family rewrites the whole database (`compact_for_room`).
        println!("[INFO][STORAGE] standard_cleanup_done history_preserved=true");
        Ok(())
    }
    
    /// Aggressive cleanup (85-95% full) - CACHE cleanup only, blockchain history preserved
    pub(super) fn aggressive_cleanup(&self) -> IntegrationResult<()> {
        println!("[INFO][STORAGE] aggressive_cleanup_start cache_only=true history_preserved=true");
        
        // 1. PRODUCTION: More aggressive transaction pool cleanup (6 hours instead of 24)
        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| IntegrationError::Other(format!("Time error: {}", e)))?
            .as_secs();
        let aggressive_cutoff = current_time.saturating_sub(6 * 3600); // 6 hours
        
        // Force aggressive cleanup of transaction pool CACHE only
        {
            let removed = self.transaction_pool.evict_older_than(aggressive_cutoff);
            println!("[INFO][STORAGE] aggressive_tx_cache_cleaned older_than=6h removed={}", removed);
        }

        println!("[INFO][STORAGE] aggressive_cleanup_done history_preserved=true");
        Ok(())
    }
    
    /// A Light node's emergency cleanup at the critical level, before a block save (`guard_fill_before_save`) and in the
    /// hourly check: the emergency measures (`compact_for_room`), then a fresh fill reading, which decides the refusal.
    pub(super) fn emergency_cleanup(&self) -> IntegrationResult<f64> {
        if !self.emergency_cleanup_enabled {
            return Err(IntegrationError::StorageError(
                "Emergency cleanup disabled, cannot continue operation".to_string()
            ));
        }
        self.compact_for_room(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs());
        let usage = self.get_directory_size(&self.data_dir.to_string_lossy())?;
        *self.current_storage_usage.write() = usage;
        let pct = storage_fill_pct(usage, self.max_storage_size, disk_used_pct(&self.data_dir));
        if crate::node::is_warn() {
            println!("[WARN][STORAGE] emergency_cleanup_done pct={:.1} accept_blocks={}",
                     pct, if pct >= STORAGE_CRITICAL_PCT { "refused" } else { "yes" });
        }
        Ok(pct)
    }
    
    /// Current storage usage percentage: the tighter of the configured cap and the data disk itself.
    pub fn get_storage_usage_percentage(&self) -> IntegrationResult<f64> {
        let usage = *self.current_storage_usage.read();
        Ok(storage_fill_pct(usage, self.max_storage_size, disk_used_pct(&self.data_dir)))
    }

    /// Check if storage is critically full
    pub fn is_storage_critically_full(&self) -> IntegrationResult<bool> {
        Ok(self.get_storage_usage_percentage()? >= STORAGE_CRITICAL_PCT)
    }

    /// The fill guard before every block save (`save_microblock`, `save_block`, `save_macroblock`). A Super node keeps
    /// storing at the critical level, alerts once an interval and compacts once an episode (`note_super_fill`); a Light
    /// node, which keeps no blocks of its own, cleans up and refuses as it always did.
    pub(super) fn guard_fill_before_save(&self, what: &str) -> IntegrationResult<()> {
        let pct = self.get_storage_usage_percentage()?;
        if self.storage_mode == StorageMode::Super {
            self.note_super_fill(pct, SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs());
            return Ok(());
        }
        if pct >= STORAGE_CRITICAL_PCT {
            if crate::node::is_warn() {
                println!("[WARN][STORAGE] storage_critically_full action=emergency_cleanup_before_save what={}", what);
            }
            if self.emergency_cleanup()? >= STORAGE_CRITICAL_PCT {
                return Err(IntegrationError::StorageError(format!(
                    "Cannot save {}: storage is critically full even after emergency cleanup. Add disk space.", what)));
            }
        }
        Ok(())
    }

    /// A Super node's fill reading `pct` at `now` (`DiskPressure`): while critical, one [CRIT] line per
    /// STORAGE_CRITICAL_REPEAT_SECS and one emergency compaction in all, and one line when the level falls below
    /// STORAGE_CRITICAL_CLEAR_PCT.
    pub(super) fn note_super_fill(&self, pct: f64, now: u64) {
        let step = self.disk_pressure.lock().step(pct, now);
        if step.alert {
            self.alert_critically_full(pct, "still_stored");
        }
        if step.compact {
            self.compact_for_room(now);
        }
        if step.cleared && crate::node::is_info() {
            println!("[INFO][STORAGE] storage_critical_cleared pct={:.1}", pct);
        }
    }

    /// The one [CRIT] line of the critical level: a Super node prints it once per STORAGE_CRITICAL_REPEAT_SECS
    /// (`blocks=still_stored`), a Light node from the hourly check while it would refuse a save (`blocks=refused`).
    fn alert_critically_full(&self, pct: f64, blocks: &str) {
        println!("[CRIT][STORAGE] state=critically_full action=admin_required pct={:.1} disk_used_pct={} blocks={}",
                 pct, disk_used_pct(&self.data_dir).map_or("unknown".to_string(), |p| format!("{:.1}", p)), blocks);
    }

    /// The emergency measures at the critical level, for a Super node (`note_super_fill`) and a Light node
    /// (`emergency_cleanup`) alike: the transaction pool keeps its last hour, and a compaction of every family of the
    /// three databases runs on its own thread, one at a time, so no block save waits for it.
    fn compact_for_room(&self, now: u64) {
        let removed = self.transaction_pool.evict_older_than(now.saturating_sub(3600));
        if self.compacting.swap(true, Ordering::AcqRel) {
            return;
        }
        if crate::node::is_warn() {
            println!("[WARN][STORAGE] emergency_compaction_start tx_pool_removed={}", removed);
        }
        let (job, running) = (self.persistent.full_compaction_job(), self.compacting.clone());
        let spawned = std::thread::Builder::new().name("qnet-compact".to_string()).spawn(move || {
            let started = std::time::Instant::now();
            job();
            running.store(false, Ordering::Release);
            if crate::node::is_info() {
                println!("[INFO][STORAGE] db_compaction_done mode=emergency families=all elapsed_ms={}",
                         started.elapsed().as_millis());
            }
        });
        if let Err(e) = spawned {
            self.compacting.store(false, Ordering::Release);
            println!("[ERR][STORAGE] emergency_compaction_spawn_failed err={}", e);
        }
    }
    
    /// Get maximum storage size
    pub fn get_max_storage_size(&self) -> u64 {
        self.max_storage_size
    }
    
    /// Update maximum storage size (for runtime configuration)
    pub fn update_max_storage_size(&mut self, new_size_gb: u64) {
        self.max_storage_size = new_size_gb * 1024 * 1024 * 1024;
        println!("[INFO][STORAGE] max_storage_updated size_gb={}", new_size_gb);
    }
    
    /// Get compression level based on block age
    pub fn get_compression_level(&self, block_height: u64) -> CompressionLevel {
        let current_height = self.get_chain_height().unwrap_or(0);
        if current_height <= block_height {
            return CompressionLevel::None;
        }
        
        let age_blocks = current_height - block_height;
        // 86400 blocks per day (1 block per second)
        let age_days = age_blocks / 86400;
        
        match age_days {
            0..=1 => CompressionLevel::None,
            2..=7 => CompressionLevel::Light,
            8..=30 => CompressionLevel::Medium,
            31..=365 => CompressionLevel::Heavy,
            _ => CompressionLevel::Extreme,
        }
    }
    
    /// Get Zstd compression level from enum
    pub(super) fn get_zstd_level(&self, level: CompressionLevel) -> Option<i32> {
        match level {
            CompressionLevel::None => None,
            CompressionLevel::Light => Some(3),
            CompressionLevel::Medium => Some(9),
            CompressionLevel::Heavy => Some(15),
            CompressionLevel::Extreme => Some(22), // Maximum compression
        }
    }
    
    /// Compress block data with adaptive level
    pub fn compress_block_adaptive(&self, block_data: &[u8], height: u64) -> IntegrationResult<Vec<u8>> {
        let compression_level = self.get_compression_level(height);
        
        match self.get_zstd_level(compression_level) {
            None => {
                // No compression for hot data
                Ok(block_data.to_vec())
            },
            Some(zstd_level) => {
                let compressed = zstd::encode_all(block_data, zstd_level)
                    .map_err(|e| IntegrationError::Other(format!("Zstd compression error: {}", e)))?;
                
                // Only use compression if it reduces size by at least 10%
                if compressed.len() < (block_data.len() * 9 / 10) {
                    println!("[INFO][STORAGE] compress_level_applied level={:?} from={} to={} reduction={:.1}%", 
                            compression_level, block_data.len(), compressed.len(),
                            (1.0 - compressed.len() as f64 / block_data.len() as f64) * 100.0);
                    Ok(compressed)
                } else {
                    Ok(block_data.to_vec())
                }
            }
        }
    }
    
    /// Decompress block data if it's compressed
    pub fn decompress_block(&self, data: &[u8]) -> IntegrationResult<Vec<u8>> {
        // Try to decompress with zstd - if it fails, data is not compressed
        match zstd::decode_all(data) {
            Ok(decompressed) => {
                println!("[INFO][STORAGE] decompressed from={} to={}", data.len(), decompressed.len());
                Ok(decompressed)
            },
            Err(_) => {
                // Not compressed, return as-is
                Ok(data.to_vec())
            }
        }
    }
    
    // NOTE: calculate_block_delta() and apply_block_delta() removed in v2.19.10
    // Delta encoding was evaluated but Pattern Recognition + Zstd provides better results
    
    /// Save block with optimal compression (delegates to unified save_microblock)
    /// 
    /// UNIFIED STORAGE: All block saving goes through save_microblock() which handles:
    /// - Tiered storage (v3.18+ — Light and Super only)
    /// - Pattern Recognition compression (89% for simple transfers)
    /// - EfficientMicroBlock format (hashes only + separate TX storage)
    /// - Adaptive Zstd compression (levels 3-22 based on age)
    /// - The fill guard (`guard_fill_before_save`)
    /// 
    /// This method exists for backward compatibility with node.rs
    ///
    /// See `SaveOutcome` — anything but `Stored` means the block is NOT durable at this height.
    pub fn save_block_with_delta(&self, height: u64, data: &[u8]) -> IntegrationResult<SaveOutcome> {
        // UNIFIED: Delegate to save_microblock which has all compression logic
        self.save_microblock(height, data)
    }
    
    /// Pattern recognition for transaction compression
    pub fn recognize_transaction_pattern(&self, tx: &qnet_state::Transaction) -> TransactionPattern {
        // Analyze transaction type based on its fields
        // Note: This is simplified - in production would use actual transaction structure
        
        // Check by hash patterns (simplified heuristics)
        let tx_size = bincode::serialize(tx).unwrap_or_default().len();
        
        // Simple transfers are usually small (< 500 bytes)
        if tx_size < 500 {
            return TransactionPattern::SimpleTransfer;
        }
        
        // Node activations have specific size patterns
        if tx_size >= 500 && tx_size < 1000 {
            return TransactionPattern::NodeActivation;
        }
        
        // Contract deployments are large
        if tx_size > 10000 {
            return TransactionPattern::ContractDeploy;
        }
        
        // Contract calls are medium sized
        if tx_size >= 1000 && tx_size < 10000 {
            return TransactionPattern::ContractCall;
        }
        
        TransactionPattern::Unknown
    }
    
    /// Compress transaction based on pattern
    pub fn compress_transaction_by_pattern(
        &self,
        tx: &qnet_state::Transaction,
        pattern: TransactionPattern
    ) -> IntegrationResult<CompressedTransaction> {
        let original_data = bincode::serialize(tx)
            .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
        
        let compressed_data = match pattern {
            TransactionPattern::SimpleTransfer => {
                // For simple transfers, we can optimize heavily
                // Store only: from_index(4) + to_index(4) + amount(8) = 16 bytes
                // Instead of full addresses and metadata
                let mut compact = Vec::with_capacity(16);
                
                // Extract essential fields (simplified)
                // In production, would parse actual transaction fields
                if original_data.len() >= 100 {
                    // Take first 4 bytes as "from" identifier
                    compact.extend_from_slice(&original_data[8..12]);
                    // Take next 4 bytes as "to" identifier  
                    compact.extend_from_slice(&original_data[40..44]);
                    // Take amount (8 bytes)
                    compact.extend_from_slice(&original_data[72..80].get(..8).unwrap_or(&[0u8; 8]));
                }
                compact
            },
            TransactionPattern::NodeActivation => {
                // For node activations: node_type(1) + amount(8) + phase(1) = 10 bytes
                let mut compact = Vec::with_capacity(10);
                if original_data.len() >= 50 {
                    compact.push(original_data[20]); // node type
                    compact.extend_from_slice(&original_data[24..32]); // amount
                    compact.push(original_data[40]); // phase
                }
                compact
            },
            TransactionPattern::RewardDistribution => {
                // Rewards are predictable: recipient(4) + amount(8) + pool_id(1) = 13 bytes
                let mut compact = Vec::with_capacity(13);
                if original_data.len() >= 40 {
                    compact.extend_from_slice(&original_data[8..12]); // recipient
                    compact.extend_from_slice(&original_data[16..24]); // amount
                    compact.push(original_data[30]); // pool_id
                }
                compact
            },
            _ => {
                // For complex patterns, use standard compression
                zstd::encode_all(&original_data[..], 3)
                    .map_err(|e| IntegrationError::Other(format!("Compression error: {}", e)))?
            }
        };
        
        let compressed_tx = CompressedTransaction {
            pattern,
            data: compressed_data.clone(),
            original_size: original_data.len(),
        };
        
        // Log compression efficiency
        if compressed_data.len() < original_data.len() {
            let reduction = (1.0 - compressed_data.len() as f64 / original_data.len() as f64) * 100.0;
            println!("[INFO][STORAGE] tx_pattern_compressed pattern={:?} from={} to={} reduction={:.1}%",
                    pattern, original_data.len(), compressed_data.len(), reduction);
        }
        
        Ok(compressed_tx)
    }
    
    /// Decompress transaction from pattern
    pub fn decompress_transaction_from_pattern(
        &self,
        compressed: &CompressedTransaction,
        full_tx_template: Option<&qnet_state::Transaction>
    ) -> IntegrationResult<Vec<u8>> {
        match compressed.pattern {
            TransactionPattern::SimpleTransfer | 
            TransactionPattern::NodeActivation | 
            TransactionPattern::RewardDistribution => {
                // For simple patterns, we need template to reconstruct
                if let Some(template) = full_tx_template {
                    let mut full_data = bincode::serialize(template)
                        .map_err(|e| IntegrationError::SerializationError(e.to_string()))?;
                    
                    // Overlay compressed data onto template
                    match compressed.pattern {
                        TransactionPattern::SimpleTransfer => {
                            if compressed.data.len() >= 16 {
                                full_data[8..12].copy_from_slice(&compressed.data[0..4]);
                                full_data[40..44].copy_from_slice(&compressed.data[4..8]);
                                full_data[72..80].copy_from_slice(&compressed.data[8..16]);
                            }
                        },
                        _ => {}
                    }
                    Ok(full_data)
                } else {
                    // Without template, can't reconstruct simple patterns
                    Err(IntegrationError::Other("Template required for pattern decompression".to_string()))
                }
            },
            _ => {
                // Complex patterns use standard decompression
                zstd::decode_all(&compressed.data[..])
                    .map_err(|e| IntegrationError::Other(format!("Decompression error: {}", e)))
            }
        }
    }
    
    // recompress_old_blocks/_transactions_sync removed: the minimum recompression age
    // (2 days) exceeded MICROBLOCK_BODY_RETENTION_BLOCKS (1 day), so every candidate was
    // already pruned. It could never save a byte, yet each call did a full O(height) scan
    // plus an unconditional whole-CF compaction.

    /// Calculate recommended storage size based on blockchain age and activity
    pub fn get_recommended_storage_size_gb(&self) -> IntegrationResult<u64> {
        let stats = self.get_stats()?;
        let current_height = stats.latest_height;
        
        // Estimate blockchain age in years (assuming 1 microblock/second)
        let blockchain_age_years = current_height as f64 / (86400.0 * 365.0); // seconds per year
        
        // Base storage requirements
        let microblocks_gb_per_year = 20; // ~20 GB per year for microblocks
        let transactions_gb_per_year = 10; // ~10 GB per year for average transaction volume
        let buffer_multiplier = 1.5; // 50% buffer for growth and overhead
        
        // Calculate recommended size
        let estimated_total_gb = (blockchain_age_years * (microblocks_gb_per_year + transactions_gb_per_year) as f64 * buffer_multiplier) as u64;
        
        // Minimum recommendations by blockchain age
        let min_recommended = match blockchain_age_years {
            age if age < 1.0 => 300,  // First year: 300 GB
            age if age < 3.0 => 400,  // 1-3 years: 400 GB  
            age if age < 5.0 => 500,  // 3-5 years: 500 GB
            age if age < 10.0 => 750, // 5-10 years: 750 GB
            _ => 1000,                // 10+ years: 1 TB
        };
        
        let recommended = std::cmp::max(estimated_total_gb, min_recommended);
        
        if recommended > (self.max_storage_size / (1024 * 1024 * 1024)) {
            println!("[INFO][STORAGE] storage_recommendation current_gb={} recommended_gb={} age_years={:.1}", 
                    self.max_storage_size / (1024 * 1024 * 1024),
                    recommended,
                    blockchain_age_years);
        }
        
        Ok(recommended)
    }
    
    // --- Sharded reward leaf-set (10M-scale claim serving) ---------------------------------------
    // The per-epoch reward set is partitioned into fixed-size shards of the SORTED (wallet, amount)
    // leaves. A claim loads exactly ONE shard + the shard-meta (K roots + K first-wallet bounds),
    // never the whole set, so proof generation is O(shard) memory/CPU regardless of recipient count.
    // The wire proof it produces is byte-identical to the monolithic single-tree proof, so
    // reward_root, the on-chain verify, and the mobile app are all unchanged. Keys are zero-padded
    // for O(1) range-delete pruning.

}

#[cfg(test)]
mod fill_tests {
    use super::*;

    // The cap alone (2000 GB configured on a 388 GB disk) could never reach the critical level before the
    // disk filled. The disk decides whenever it is the tighter limit; the cap still binds when it is.
    #[test]
    fn a_full_disk_is_critical_whatever_the_cap() {
        let gb = 1024u64 * 1024 * 1024;
        assert!(storage_fill_pct(4 * gb, 2000 * gb, Some(96.0)) >= STORAGE_CRITICAL_PCT);
        assert!(storage_fill_pct(4 * gb, 2000 * gb, Some(5.0)) < STORAGE_CRITICAL_PCT);
        assert!(storage_fill_pct(1960 * gb, 2000 * gb, Some(5.0)) >= STORAGE_CRITICAL_PCT);
        assert!((storage_fill_pct(4 * gb, 2000 * gb, None) - 0.2).abs() < 1e-9, "an unreadable disk leaves the cap alone");
    }

    // A critical episode lasts until the level falls below the clear line. It alerts at once and then once an interval,
    // but compacts once: on a disk filled by other data every further run would rewrite the database for nothing.
    #[test]
    fn a_super_nodes_critical_episode_alerts_each_interval_and_compacts_once() {
        let both = PressureStep { alert: true, compact: true, cleared: false };
        let alert_only = PressureStep { alert: true, ..PressureStep::default() };
        let (mut p, t, r) = (DiskPressure::default(), 1_800_000_000, STORAGE_CRITICAL_REPEAT_SECS);
        assert_eq!(p.step(94.9, t), PressureStep::default(), "below the line: nothing");
        assert_eq!(p.step(STORAGE_CRITICAL_PCT, t), both);
        for dt in [1, 60, r - 1] {
            assert_eq!(p.step(97.0, t + dt), PressureStep::default(), "within the interval, at +{dt}");
        }
        assert_eq!(p.step(94.5, t + 10), PressureStep::default(), "between the two lines it stays critical");
        assert_eq!(p.step(96.0, t + r), alert_only, "the next interval alerts and does not compact again");
        assert_eq!(p.step(96.0, t + 5 * r), alert_only, "nor does any later one");
        assert_eq!(p.step(93.9, t + 5 * r + 1), PressureStep { cleared: true, ..PressureStep::default() });
        assert_eq!(p.step(94.5, t + 5 * r + 2), PressureStep::default(), "cleared, under the line");
        assert_eq!(p.step(95.0, t + 5 * r + 3), both, "a new episode alerts and compacts at once");
        let mut q = DiskPressure::default();
        q.step(99.0, t);
        assert!(q.step(99.0, t - 5).alert, "a clock set back counts as due");
    }

    // A Super node at the critical level keeps storing blocks, alerts and starts one compaction off the save path; a
    // Light node cleans up and refuses.
    #[test]
    fn a_super_node_at_the_critical_level_keeps_storing_blocks() {
        let critical = |dir: &tempfile::TempDir| {
            let mut s = Storage::new(dir.path().to_str().unwrap()).expect("storage");
            s.max_storage_size = 1_000;
            *s.current_storage_usage.write() = 960;
            s
        };
        let dir = tempfile::TempDir::new().expect("tempdir");
        let s = critical(&dir);
        assert_eq!(s.storage_mode, StorageMode::Super);
        assert!(s.is_storage_critically_full().unwrap(), "96 % of the cap, whatever the disk");
        let mut parent = [0u8; 32];
        for h in 1..=3u64 {
            let b = qnet_state::MicroBlock::new(h, 1_000 + h, parent, vec![], "genesis_node_001".to_string());
            assert_eq!(s.save_microblock(h, &bincode::serialize(&b).unwrap()).expect("stored"), SaveOutcome::Stored, "h={h}");
            parent = b.hash();
        }
        assert!(s.load_microblock_auto_format(3).unwrap().is_some() && s.should_store_full_blocks());
        assert!(s.disk_pressure.lock().critical);
        wait_for_compaction(&s);
        let light_dir = tempfile::TempDir::new().expect("tempdir");
        let mut light = critical(&light_dir);
        light.storage_mode = StorageMode::Light;
        let b = qnet_state::MicroBlock::new(1, 1_001, [0u8; 32], vec![], "genesis_node_001".to_string());
        assert!(light.save_microblock(1, &bincode::serialize(&b).unwrap()).is_err(), "a Light node refuses as before");
        wait_for_compaction(&light);
        // Every block save path runs the one guard, and none compacts inline.
        let blocks = include_str!("blocks.rs");
        assert_eq!(blocks.matches("self.guard_fill_before_save(").count(), 3);
        assert!(!blocks.contains("emergency_cleanup()"));
    }

    fn wait_for_compaction(s: &Storage) {
        for _ in 0..400 {
            if !s.compacting.load(Ordering::Acquire) { return; }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("the emergency compaction did not end");
    }

    /// The families of the three databases, default ones included, that hold files at level 0.
    fn families_at_level0(s: &Storage) -> Vec<&'static str> {
        let mut out = Vec::new();
        for (db, names) in s.persistent.all_dbs() {
            for name in crate::storage::persistent::with_default_family(names) {
                let cf = db.cf_handle(name).expect("family");
                if db.property_int_value_cf(&cf, "rocksdb.num-files-at-level0").ok().flatten().unwrap_or(0) > 0 {
                    out.push(name);
                }
            }
        }
        out
    }

    // The hourly check of a Super node at the critical level alerts and starts the one emergency compaction, which
    // reaches every family of the three databases, and never runs the Light node's inline cleanup; a later reading under
    // the clear line ends the critical state with no block saved.
    #[test]
    fn the_hourly_check_of_a_full_super_node_compacts_every_family_and_clears() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let mut s = Storage::new(dir.path().to_str().unwrap()).expect("storage");
        s.emergency_cleanup_enabled = false; // the Light node's cleanup would now fail the check
        let mut families = 0;
        for (db, names) in s.persistent.all_dbs() {
            for name in crate::storage::persistent::with_default_family(names) {
                let cf = db.cf_handle(name).expect("family");
                db.put_cf(&cf, b"compaction_probe", b"1").unwrap();
                db.flush_cf(&cf).unwrap();
                families += 1;
            }
        }
        assert_eq!(families_at_level0(&s).len(), families);
        let size = s.get_directory_size(&s.data_dir.to_string_lossy()).unwrap();
        s.max_storage_size = size * 100 / 99;
        assert!(!s.check_storage_usage_and_cleanup().expect("no inline cleanup on a Super node"));
        let stamp = {
            let p = s.disk_pressure.lock();
            assert!(p.critical && p.last_alert.is_some() && p.episode_compacted, "one alert, one compaction");
            p.last_alert
        };
        wait_for_compaction(&s);
        assert_eq!(families_at_level0(&s), Vec::<&str>::new(), "every family compacted");
        s.check_storage_usage_and_cleanup().expect("second reading");
        assert_eq!(s.disk_pressure.lock().last_alert, stamp, "no second alert within the interval");
        s.max_storage_size = size * 10;
        if disk_used_pct(dir.path()).map_or(true, |d| d < STORAGE_CRITICAL_CLEAR_PCT) {
            assert!(s.check_storage_usage_and_cleanup().expect("third reading"));
            assert!(!s.disk_pressure.lock().critical, "cleared with no block saved");
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_disk_reading_is_a_percentage() {
        let p = disk_used_pct(std::path::Path::new(".")).expect("statvfs on the working directory");
        assert!((0.0..=100.0).contains(&p), "{}", p);
    }
}

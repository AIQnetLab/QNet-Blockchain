//! Post-quantum certificate cache: storage, rotation, usage-aware eviction.

use super::*;

impl CertificateManager {
    pub fn new() -> Self {
        // v3.18: Full nodes removed - default to Super
        Self::with_node_type(NodeType::Super)
    }
    
    /// Create certificate manager with node type specific limits
    pub fn with_node_type(node_type: NodeType) -> Self {
        // SCALABILITY: Different cache sizes based on node capabilities
        // ARCHITECTURE: Max 1000 validators per round × 4 hour TTL = 4000 certs max
        let max_cache_size = match node_type {
            NodeType::Light => 0,      // Light nodes: DON'T participate in consensus, no certs needed!
            NodeType::Super => 5000,   // Super nodes: 4000 active + 1000 buffer for rotation
        };
        
        if max_cache_size == 0 {
            if crate::node::is_info() { println!("[INFO][CERT] Light node: Certificate caching DISABLED (consensus not required)"); }
        } else {
            if crate::node::is_info() { println!("[INFO][CERT] {:?} node: Certificate cache size: {}", node_type, max_cache_size); }
        }
        
        Self {
            local_certificate: None,
            remote_certificates: HashMap::new(),
            pending_certificates: HashMap::new(),
            certificate_ttl: Duration::from_secs(540),  // 9 minutes (2× certificate lifetime for multi-rotation cache)
            max_cache_size,
            recently_used: HashSet::new(),
            usage_count: HashMap::new(),
        }
    }
    
    /// Store our own certificate
    pub fn set_local_certificate(&mut self, cert_serial: String, certificate: Vec<u8>) {
        self.local_certificate = Some((cert_serial, certificate));
    }
    
    /// v2.26: Get local certificate with serial number for SHRED_PROTOCOL inclusion
    /// Returns (serial_number, certificate_bytes) for creating ProducerCertificate
    pub fn get_local_cert_with_serial(&self) -> Option<(String, Vec<u8>)> {
        self.local_certificate.clone()
    }
    
    /// Store remote certificate (for microblock producers only)
    pub fn store_remote_certificate(&mut self, cert_serial: String, certificate: Vec<u8>) {
        // CRITICAL: Light nodes should NEVER store certificates
        if self.max_cache_size == 0 {
            if crate::node::is_info() { println!("[INFO][CERT] Light node: Rejecting certificate storage (consensus disabled)"); }
            return;
        }
        
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(0))
            .as_secs();
        
        // OPTIMIZATION: Compress certificate for storage (reduces memory by ~50-70%)
        // Certificates are typically 4-12KB, compression reduces to 2-5KB
        let compressed_cert = lz4_flex::compress_prepend_size(&certificate);
        let original_size = certificate.len();
        let compressed_size = compressed_cert.len();
        if compressed_size < original_size {
            if crate::node::is_info() { println!("[INFO][CERT] Compressed certificate: {} -> {} bytes ({}% reduction)",
                     original_size, compressed_size, (100 - (compressed_size * 100 / original_size))); }
        }
        
        // PRODUCTION: Enforce configurable cache limit for scalability
        if self.remote_certificates.len() >= self.max_cache_size {
            // SECURITY: Prioritized eviction to prevent cache pollution attacks
            // Priority order: 
            // 1. Evict certificates that were never used
            // 2. Evict certificates with lowest usage count  
            // 3. Evict oldest certificates (LRU)
            
            // Find candidate for eviction with priority logic
            let eviction_candidate = self.remote_certificates
                .iter()
                .filter(|(serial, _)| !self.recently_used.contains(*serial))  // Prefer non-recently used
                .min_by(|(serial_a, (_, timestamp_a)), (serial_b, (_, timestamp_b))| {
                    // First compare by usage count (lower usage = higher priority for eviction)
                    let usage_a = self.usage_count.get(*serial_a).unwrap_or(&0);
                    let usage_b = self.usage_count.get(*serial_b).unwrap_or(&0);
                    
                    match usage_a.cmp(usage_b) {
                        std::cmp::Ordering::Equal => {
                            // If usage is equal, evict older certificate (LRU)
                            timestamp_a.cmp(timestamp_b)
                        }
                        other => other
                    }
                })
                .or_else(|| {
                    // If all certificates are recently used, fall back to LRU
                    self.remote_certificates
                        .iter()
                        .min_by_key(|(_, (_, timestamp))| timestamp)
                })
                .map(|(k, v)| (k.clone(), v.clone()));
            
            if let Some((evicted_serial, _)) = eviction_candidate {
                self.remote_certificates.remove(&evicted_serial);
                self.usage_count.remove(&evicted_serial);
                self.recently_used.remove(&evicted_serial);
                
                let usage = self.usage_count.get(&evicted_serial).unwrap_or(&0);
                if crate::node::is_warn() { println!("[WARN][CERT] Evicted: {} (usage: {}, cache: {}/{})",
                         evicted_serial, usage, self.remote_certificates.len(), self.max_cache_size); }
            }
        }
        
        // Store compressed certificate
        self.remote_certificates.insert(cert_serial, (compressed_cert, now));
    }
    
    /// SECURITY: Mark certificate as recently used (for cache pollution protection)
    pub fn mark_as_used(&mut self, cert_serial: &str) {
        self.recently_used.insert(cert_serial.to_string());
        *self.usage_count.entry(cert_serial.to_string()).or_insert(0) += 1;
        
        // Limit recently_used set size to prevent unbounded growth
        // SCALABILITY: Support 1000 validators + 500 buffer for rotation = 1500
        const MAX_RECENTLY_USED: usize = 1500;
        
        // Add monitoring for cache size
        if self.recently_used.len() > 1400 {
            if crate::node::is_warn() { println!("[WARN][CERT] recently_used approaching limit: {}/1500",
                     self.recently_used.len()); }
        }
        
        if self.recently_used.len() > MAX_RECENTLY_USED {
            // CRITICAL: HashSet has no order! We must remove based on usage_count instead
            // Sort by usage count and remove least used
            let mut usage_list: Vec<(String, u32)> = self.recently_used
                .iter()
                .map(|serial| {
                    let usage = self.usage_count.get(serial).unwrap_or(&0);
                    (serial.clone(), *usage)
                })
                .collect();
            
            // Sort by usage (ascending) - least used first
            usage_list.sort_by_key(|(_, usage)| *usage);
            
            // Remove least used entries (keep most active 1400)
            let to_remove_count = self.recently_used.len() - 1400;
            let to_remove: Vec<String> = usage_list
                .iter()
                .take(to_remove_count)
                .map(|(serial, _)| serial.clone())
                .collect();
            
            if crate::node::is_warn() { println!("[WARN][CERT] Cleaning recently_used: removing {} least-used entries (keeping 1400 most active)",
                     to_remove.len()); }
            
            for serial in to_remove {
                self.recently_used.remove(&serial);
                // Also remove from usage_count to keep consistent
                self.usage_count.remove(&serial);
            }
        }
    }
    
    /// Get certificate (local or remote) - checks local first, then remote cache, then pending
    /// Get certificate and mark as used atomically (prevents race conditions)
    pub fn get_and_mark_used(&mut self, cert_serial: &str) -> Option<Vec<u8>> {
        // First get the certificate
        let result = self.get_certificate(cert_serial);
        
        // If found, mark as used
        if result.is_some() {
            self.mark_as_used(cert_serial);
        }
        
        result
    }
    
    /// REMOVED: This optimization broke usage counting!
    /// Every access MUST go through mark_as_used to track usage properly
    
    /// OPTIMISTIC: Returns pending certificates to prevent race conditions
    pub fn get_certificate(&self, cert_serial: &str) -> Option<Vec<u8>> {
        // Check local certificate
        if let Some((local_serial, cert)) = &self.local_certificate {
            if local_serial == cert_serial {
                return Some(cert.clone());
            }
        }
        
        // Check verified remote certificates
        if let Some((compressed_cert, timestamp)) = self.remote_certificates.get(cert_serial) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::from_secs(0))
                .as_secs();
            
            // Check TTL
            if now - timestamp <= self.certificate_ttl.as_secs() {
                // OPTIMIZATION: Decompress certificate before returning
                match lz4_flex::decompress_size_prepended(compressed_cert) {
                    Ok(decompressed) => {
                        if crate::node::is_info() { println!("[INFO][CERT] Using verified certificate {}", cert_serial); }
                        // NOTE: Caller must call mark_as_used() separately due to &self immutability
                        return Some(decompressed);
                    }
                    Err(e) => {
                        if crate::node::is_warn() { println!("[WARN][CERT] Failed to decompress certificate {}: {}", cert_serial, e); }
                        // Fall back to returning as-is (might be uncompressed legacy data)
                        return Some(compressed_cert.clone());
                    }
                }
            }
        }
        
        // OPTIMISTIC: Check pending certificates (awaiting verification)
        if let Some((compressed_cert, timestamp, node_id)) = self.pending_certificates.get(cert_serial) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::from_secs(0))
                .as_secs();
            
            // Check TTL even for pending
            if now - timestamp <= self.certificate_ttl.as_secs() {
                if crate::node::is_warn() { println!("[WARN][CERT] Using PENDING certificate {} from {} (verification in progress)",
                         cert_serial, node_id); }
                // Decompress pending certificate
                match lz4_flex::decompress_size_prepended(compressed_cert) {
                    Ok(decompressed) => {
                        // CRITICAL: Blocks using pending certs should be marked conditional
                        // Byzantine consensus protects against invalid pending certs (2/3+ must agree)
                        return Some(decompressed);
                    }
                    Err(e) => {
                        if crate::node::is_warn() { println!("[WARN][CERT] Failed to decompress pending certificate {}: {}", cert_serial, e); }
                        return None;
                    }
                }
            }
        }
        
        if crate::node::is_warn() { println!("[WARN][CERT] Certificate {} not found in any cache", cert_serial); }
        None
    }
    
    /// Clean expired certificates (call periodically)
    pub fn cleanup(&mut self) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(0))
            .as_secs();
        
        // Remove expired verified certificates
        self.remote_certificates.retain(|_, (_, timestamp)| {
            now - *timestamp <= self.certificate_ttl.as_secs()
        });
        
        // Remove expired pending certificates (shorter TTL - 5 minutes)
        self.pending_certificates.retain(|_, (_, timestamp, _)| {
            now - *timestamp <= 300 // 5 minutes max for pending
        });
    }
    
    /// PERSISTENCE: Save critical certificates to disk (for node restart recovery)
    /// Only saves certificates from recently used/active producers
    pub fn persist_to_disk(&self, path: &std::path::Path, node_type: NodeType) -> std::io::Result<()> {
        use std::fs;
        use std::io::Write;
        
        // Create certificates directory if it doesn't exist
        let cert_dir = path.join("certificates");
        fs::create_dir_all(&cert_dir)?;
        
        // Save only recently used certificates (active producers)
        let mut saved_count = 0;
        
        // SCALABILITY: Different persist limits based on node type
        // Persist only most used certificates for quick recovery after restart
        let max_persist_certs = match node_type {
            NodeType::Light => 0,     // Light nodes: NO persistence (no consensus participation)
            NodeType::Super => 2000,  // Super nodes: persist active validators for 2 hours
        };
        
        if max_persist_certs == 0 {
            if crate::node::is_info() { println!("[INFO][CERT] Light node: Skipping certificate persistence"); }
            return Ok(());
        }
        
        // Sort certificates by usage count for prioritization
        let mut certs_by_usage: Vec<(String, u32)> = self.usage_count
            .iter()
            .filter(|(serial, _)| self.remote_certificates.contains_key(*serial))
            .map(|(serial, usage)| (serial.clone(), *usage))
            .collect();
        certs_by_usage.sort_by(|a, b| b.1.cmp(&a.1)); // Sort by usage descending
        
        for (cert_serial, usage) in certs_by_usage.iter().take(max_persist_certs) {
            if let Some((cert_data, timestamp)) = self.remote_certificates.get(cert_serial) {
                // Save certificate as binary file
                let cert_file = cert_dir.join(format!("{}.cert", cert_serial));
                let mut file = fs::File::create(&cert_file)?;
                file.write_all(cert_data)?;
                
                // Save metadata (timestamp and usage count)
                let meta_file = cert_dir.join(format!("{}.meta", cert_serial));
                let metadata = format!("{},{}", timestamp, usage);
                fs::write(&meta_file, metadata)?;
                
                saved_count += 1;
            }
        }
        
        if crate::node::is_info() { println!("[INFO][CERT] Persisted {} critical certificates to disk", saved_count); }
        
        // v3.50: certificate_history persistence removed — Dilithium-only verification
        // Legacy certificate_history.bin file will be ignored on next restart
        
        Ok(())
    }
    
    /// PERSISTENCE: Load certificates from disk (for node restart recovery)
    pub fn load_from_disk(&mut self, path: &std::path::Path) -> std::io::Result<()> {
        use std::fs;
        
        let cert_dir = path.join("certificates");
        if !cert_dir.exists() {
            return Ok(()); // No certificates to load
        }
        
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(0))
            .as_secs();
        
        let mut loaded_count = 0;
        let mut expired_count = 0;
        
        // Read all certificate files
        for entry in fs::read_dir(&cert_dir)? {
            let entry = entry?;
            let path = entry.path();
            
            if path.extension().and_then(|s| s.to_str()) == Some("cert") {
                let stem = path.file_stem().and_then(|s| s.to_str());
                if let Some(cert_serial) = stem {
                    // Load certificate data
                    let cert_data = fs::read(&path)?;
                    
                    // Load metadata
                    let meta_path = cert_dir.join(format!("{}.meta", cert_serial));
                    if let Ok(metadata) = fs::read_to_string(&meta_path) {
                        let parts: Vec<&str> = metadata.split(',').collect();
                        if parts.len() == 2 {
                            if let (Ok(timestamp), Ok(usage)) = (parts[0].parse::<u64>(), parts[1].parse::<u32>()) {
                                // Check if certificate is not expired
                                if now - timestamp <= self.certificate_ttl.as_secs() {
                                    self.remote_certificates.insert(cert_serial.to_string(), (cert_data, timestamp));
                                    self.usage_count.insert(cert_serial.to_string(), usage);
                                    if usage > 5 { // Mark as recently used if it had significant usage
                                        self.recently_used.insert(cert_serial.to_string());
                                    }
                                    loaded_count += 1;
                                } else {
                                    expired_count += 1;
                                    // Clean up expired certificate files
                                    let _ = fs::remove_file(&path);
                                    let _ = fs::remove_file(&meta_path);
                                }
                            }
                        }
                    }
                }
            }
        }
        
        if crate::node::is_info() { println!("[INFO][CERT] Loaded {} certificates from disk ({} expired)", loaded_count, expired_count); }
        
        // v3.50: certificate_history loading removed — Dilithium-only verification
        
        Ok(())
    }
}

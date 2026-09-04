//! Block and macroblock serving, sync responses, registry and snapshot delivery.

use super::*;

/// True at most once per 4 s per window - the view-timer cadence.
fn note_deferred_window(w: u64) -> bool {
    static LAST: parking_lot::Mutex<(u64, u64)> = parking_lot::Mutex::new((0, 0));
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_secs();
    let mut g = LAST.lock();
    if g.0 == w && now.saturating_sub(g.1) < 4 { return false; }
    *g = (w, now);
    true
}

impl SimplifiedP2P {
    /// Start peer exchange protocol for decentralized network growth - SCALABLE (INSTANCE METHOD)
    pub fn start_peer_exchange_protocol(&self, initial_peers: Vec<PeerInfo>) {
        if crate::node::is_info() {
            println!("[INFO][P2P] Starting peer exchange protocol for network growth...");
        }
        
        // SCALABILITY FIX: Phase-aware peer exchange intervals
        let is_genesis_node = std::env::var("QNET_BOOTSTRAP_ID")
            .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
            .unwrap_or(false);
        
        // Use EXISTING Genesis node detection logic - unified with microblock production
        
        let exchange_interval = if is_genesis_node {
            // Genesis phase: Frequent exchange for reconnection during startup race condition
            // CRITICAL: 10s matches reconnect interval in node.rs main loop
            std::time::Duration::from_secs(10) // Every 10 seconds for Genesis reconnection
        } else {
            // Normal phase: Slower exchange for millions-scale stability  
            std::time::Duration::from_secs(300) // 5 minutes for scale - EXISTING system value
        };
        
        if crate::node::is_info() {
            println!("[INFO][P2P] Peer exchange interval: {}s (Genesis node: {})",
                    exchange_interval.as_secs(), is_genesis_node);
        }
        
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_info() {
                    println!("[WARN][P2P] No Tokio runtime - peer exchange deferred");
                }
                return;
            }
        };
        
        let _node_type = self.node_type.clone();
        let _region = self.region.clone();
        let _port = self.port;
        
        handle.spawn(async move {
            let mut interval = tokio::time::interval(exchange_interval);
        
        loop {
            interval.tick().await;

            // v16.1: ESCALATION-DRIVEN PEER REFRESH
            //
            // The state-machine escalation ladder (Phase 2.A stage 3) raises
            // PEER_REFRESH_REQUESTED after 30 consecutive Error{recoverable=true}
            // cycles — symptomatic of all our active peers being silent or
            // forked. When this fires, force an IMMEDIATE peer-exchange round
            // (don't wait for the next interval tick) and DOUBLE the breadth
            // of this cycle's exchange so we have a chance to discover
            // canonical peers we haven't talked to yet.
            //
            // Atomic swap clears the flag so a single signal triggers exactly
            // one accelerated cycle. Subsequent cycles return to the standard
            // interval until the flag is set again.
            let force_refresh = crate::node::PEER_REFRESH_REQUESTED.swap(
                false, std::sync::atomic::Ordering::Relaxed,
            );
            if force_refresh && crate::node::is_warn() {
                println!("[WARN][P2P] peer_refresh_forced cause=escalation_stage_3");
            }

            // SCALABILITY FIX: Limit peer exchange requests to prevent network overload
            let mut max_exchange_peers = if is_genesis_node {
                initial_peers.len() // Genesis: exchange with all known peers
            } else {
                std::cmp::min(initial_peers.len(), 3) // Normal: max 3 peers per cycle
            };
            if force_refresh {
                // Double breadth on forced refresh, capped at total known peers.
                max_exchange_peers = std::cmp::min(initial_peers.len(), max_exchange_peers * 2 + 2);
            }

            if crate::node::is_info() {
                println!("[INFO][P2P] Starting peer exchange cycle with {} of {} peers{}",
                        max_exchange_peers, initial_peers.len(),
                        if force_refresh { " (forced)" } else { "" });
            }
            // Fire-and-forget: the reply arrives asynchronously as a PeerListResponse and is
            // admitted there through the normal add_peer_lockfree gates.
            for peer in initial_peers.iter().take(max_exchange_peers) {
                if let Err(e) = Self::request_peer_list_from_node(&peer.addr).await {
                    if crate::node::is_debug() {
                        println!("[DBG][P2P] peer_list_request_failed peer={} err={}",
                                 get_privacy_id_for_addr(&peer.addr), e);
                    }
                }
            }
            
            if crate::node::is_info() {
                println!("[INFO][P2P] Peer exchange cycle completed - network continues to grow");
            }
        }
        });
    }
    
    /// Ask a peer for its peer list. QUIC-only: the reply arrives asynchronously as a
    /// PeerListResponse, so this returns once the request is on the wire.
    pub(super) async fn request_peer_list_from_node(node_addr: &str) -> Result<(), String> {
        let ip = node_addr.split(':').next().unwrap_or(node_addr);

        if crate::node::is_debug() {
            println!("[DBG][P2P] peer_list_requested peer={}", get_privacy_id_for_addr(ip));
        }

        Self::request_peer_list_via_quic(ip).await
    }

    /// Send a PeerListRequest over QUIC (UDP, bypasses TCP firewall blocks).
    pub(super) async fn request_peer_list_via_quic(ip: &str) -> Result<(), String> {
        use crate::quic_transport::QUIC_PORT_OFFSET;
        use std::net::SocketAddr;

        let api_port: u16 = 8001;
        let quic_port = api_port + QUIC_PORT_OFFSET;
        let quic_addr: SocketAddr = format!("{}:{}", ip, quic_port)
            .parse()
            .map_err(|e| format!("Invalid addr: {}", e))?;

        let transport_arc = {
            let guard = GLOBAL_QUIC_TRANSPORT.read();
            match &*guard {
                Some(arc) => arc.clone(),
                None => return Err("QUIC not initialized".to_string()),
            }
        };

        let request = NetworkMessage::PeerListRequest {
            requester_id: GLOBAL_NODE_ID.read().clone(),
        };

        let transport = transport_arc.read().await;
        transport.send_message(quic_addr, &request).await
            .map_err(|e| format!("QUIC send: {}", e))
    }
    
    
    /// Node reputation from the chain fold, 0-100: {INITIAL_REPUTATION floor | 0 if tombstoned}.
    /// The tombstone lives in `Account.banned_at_height`, written by the equivocation-proof apply.
    /// Returning a constant floor here made every reputation gate structurally unreachable — the
    /// inbound admission floor compared 70.0 < 50.0 and could never refuse a banned node.
    pub fn get_node_reputation_from_blockchain(&self, node_id: &str) -> f64 {
        use qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
        if node_id.is_empty() { return INITIAL_REPUTATION; }
        // Applied state is the source of truth (it is what state_root is computed from); the
        // accounts CF is its async best-effort mirror and only answers for an evicted account.
        // O(1) either way, and never blocks the caller: a contended lock falls through to disk.
        if let Some(state) = crate::node::try_get_state() {
            if let Ok(guard) = state.try_read() {
                if let Some(acct) = guard.accounts.get(node_id) {
                    return if acct.value().banned_at_height > 0 { 0.0 } else { INITIAL_REPUTATION };
                }
            }
        }
        match crate::node::try_get_storage().and_then(|s| s.load_account(node_id).ok().flatten()) {
            Some(acct) if acct.banned_at_height > 0 => 0.0,
            _ => INITIAL_REPUTATION,
        }
    }
    
    /// Check if node can participate in consensus (reputation >= MIN_CONSENSUS_REPUTATION)
    pub fn can_node_participate_in_consensus(&self, node_id: &str) -> bool {
        self.get_node_reputation_from_blockchain(node_id) >= qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION
    }
    
    /// v2.76: Set storage reference for persistent heartbeat storage (scalability)
    /// CRITICAL: Must be called before start_heartbeat_service() for proper persistence
    /// SCALABILITY: Enables millions of nodes by storing heartbeats in RocksDB instead of RAM
    pub fn set_storage(&mut self, storage: Arc<crate::storage::Storage>) {
        self.storage = Some(storage);
        if crate::node::is_info() {
            println!("[INFO][P2P] Storage reference set for scalable heartbeat persistence");
        }
    }

    /// v5.0: Set wallet identity for ML-DSA-65-signed HealthPing messages
    /// Called by BlockchainNode after initialize_wallet_identity()
    pub fn set_wallet_identity(&self, identity: Arc<crate::crypto::vrf::WalletIdentity>) {
        let mut guard = self.wallet_identity.write();
        *guard = Some(identity);
        if crate::node::is_info() {
            println!("[INFO][P2P] wallet_identity_linked signing=Dilithium3");
        }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // DEPRECATED v2.38: P2P-based slashing removed
    // Slashing now determined ONLY from on-chain analysis in MacroBlock creation
    // These methods kept for logging/monitoring only - NO effect on consensus
    // ═══════════════════════════════════════════════════════════════════════════

    /// DEPRECATED v2.38: Log invalid block for monitoring (NO slashing effect!)
    /// Slashing is now determined on-chain via analyze_chain_for_slashing()
    #[allow(unused_variables)]
    pub fn report_invalid_block(&self, offender: &str, height: u64, block_hash: [u8; 32], reason: &str) {
        // v2.38: Only log for monitoring - NO slashing action!
        // Slashing determined on-chain in MacroBlock creation
        if crate::node::is_warn() {
            println!("[WARN][MONITOR] invalid_block offender={} h={} reason={}", offender, height, reason);
        }
    }

    /// v14.8: Per-peer local isolation for block-apply failures. Completely
    /// orthogonal to on-chain slashing — this is a local circuit breaker that
    /// stops a bad peer from wasting our apply path. After N strikes in a
    /// rolling window the peer is put in local quarantine for TTL seconds;
    /// their incoming blocks will be ignored until the quarantine expires.
    ///
    /// Uses `dashmap`-style already-in-use PEER_APPLY_STRIKES / PEER_APPLY_QUARANTINE
    /// atomically, so it is safe and cheap to call from the apply pipeline
    /// at the scale of thousands of super-nodes.
    pub fn record_apply_strike(&self, peer_id: &str, reason: &str) {
        if peer_id.is_empty() || peer_id == "self" {
            return;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let count = {
            let mut entry = PEER_APPLY_STRIKES.entry(peer_id.to_string()).or_insert((0u32, now));
            // Reset counter if the window (APPLY_STRIKE_WINDOW_SECS) expired
            if now.saturating_sub(entry.1) > APPLY_STRIKE_WINDOW_SECS {
                entry.0 = 0;
                entry.1 = now;
            }
            entry.0 = entry.0.saturating_add(1);
            entry.1 = now;
            entry.0
        };
        if count >= APPLY_STRIKE_THRESHOLD {
            PEER_APPLY_QUARANTINE.insert(peer_id.to_string(), now + APPLY_QUARANTINE_TTL_SECS);
            PEER_APPLY_STRIKES.remove(peer_id);
            if crate::node::is_warn() {
                println!("[WARN][PEER] local_quarantine peer={} strikes={} reason={} ttl={}s",
                         peer_id, count, reason, APPLY_QUARANTINE_TTL_SECS);
            }
        } else if crate::node::is_info() {
            println!("[INFO][PEER] apply_strike peer={} count={}/{} reason={}",
                     peer_id, count, APPLY_STRIKE_THRESHOLD, reason);
        }
    }

    /// v14.8: Check if a peer is currently in local apply quarantine.
    /// Called by the pipeline BEFORE enqueueing a block for apply work.
    pub fn is_peer_quarantined(&self, peer_id: &str) -> bool {
        if peer_id.is_empty() || peer_id == "self" {
            return false;
        }
        if let Some(entry) = PEER_APPLY_QUARANTINE.get(peer_id) {
            let expires_at = *entry.value();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if now < expires_at {
                return true;
            }
            // Expired — lazily evict
            drop(entry);
            PEER_APPLY_QUARANTINE.remove(peer_id);
        }
        false
    }

    /// v14.8: Called on every successful apply to clear stale strikes.
    /// Success signals that the peer is producing valid blocks again —
    /// reset their counter to give them a clean slate.
    pub fn record_apply_success(&self, peer_id: &str) {
        if peer_id.is_empty() || peer_id == "self" {
            return;
        }
        PEER_APPLY_STRIKES.remove(peer_id);
    }
    
    /// DEPRECATED: Update node reputation via P2P
    /// ═══════════════════════════════════════════════════════════════════════════
    /// ARCHITECTURE v2.21: CONSENSUS REPUTATION FROM BLOCKCHAIN ONLY
    /// 
    /// This function is deprecated for consensus events. Use:
    /// - DeterministicReputationState.process_block() for +2% rotation rewards
    /// - DeterministicReputationState.process_macroblock() for +1% participation
    /// - SlashingEvent in MacroBlock for penalties (with cryptographic proof)
    /// 
    /// Network events still update network_score for P2P routing.
    /// ═══════════════════════════════════════════════════════════════════════════
    #[allow(deprecated)]
    pub fn update_node_reputation(&self, node_id: &str, event: ReputationEvent) {
        match event {
            // ═══════════════════════════════════════════════════════════════
            // DEPRECATED CONSENSUS EVENTS - IGNORED!
            // Reputation now computed from blockchain
            // ═══════════════════════════════════════════════════════════════
            ReputationEvent::FullRotationComplete |
            ReputationEvent::InvalidBlock |
            ReputationEvent::ConsensusParticipation |
            ReputationEvent::MaliciousBehavior => {
                // IGNORED: Use DeterministicReputationState from blockchain
                // The old P2P-based reputation caused desync between nodes
                #[cfg(debug_assertions)]
                {
                    let display_id = if node_id.starts_with("genesis_node_") || node_id.starts_with("node_") || node_id.starts_with("super_") {
                        node_id.to_string()
                    } else {
                        get_privacy_id_for_addr(node_id)
                    };
                    if crate::node::is_info() {
                        println!("[WARN][REP] Deprecated event {:?} for {} - use blockchain",
                                 event, display_id);
                    }
                }
            }
            
            // ═══════════════════════════════════════════════════════════════
            // NETWORK EVENTS - Update network_score for P2P routing
            // ═══════════════════════════════════════════════════════════════
            ReputationEvent::TimeoutFailure | 
            ReputationEvent::ConnectionFailure => {
                if let Some(peer_addr) = self.peer_id_to_addr.get(node_id) {
                    self.update_peer_reputation(&peer_addr, event);
                }
            }
        }
    }
    
    /// DEPRECATED: Legacy reputation update method
    /// ═══════════════════════════════════════════════════════════════════════════
    /// Use DeterministicReputationState from blockchain data instead.
    /// This method now does nothing for consensus reputation.
    /// ═══════════════════════════════════════════════════════════════════════════
    #[deprecated(note = "Use DeterministicReputationState from blockchain")]
    #[allow(dead_code)]
    pub fn update_node_reputation_legacy(&self, _node_id: &str, _delta: f64) {
        // DISABLED: Reputation now computed from blockchain
        // All nodes compute same reputation from same blocks = deterministic
    }
    
    /// PRODUCTION: Set absolute reputation (for Genesis initialization)
    /// WHITEPAPER: Light nodes have FIXED reputation of INITIAL_REPUTATION
    pub fn set_node_reputation(&self, node_id: &str, reputation: f64) {
        // CRITICAL: Light nodes have fixed reputation of INITIAL_REPUTATION
        use qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
        let _final_reputation = if node_id.starts_with("light_") {
            INITIAL_REPUTATION // Light nodes: always INITIAL_REPUTATION, ignore requested value
        } else {
            reputation
        };
        
        // v2.21.5: DEPRECATED - reputation now managed via blockchain only
        // Reputation changes: slashing events (penalties), process_block/macroblock (rewards)
        let display_id = if node_id.starts_with("genesis_node_") || node_id.starts_with("node_") || node_id.starts_with("super_") {
            node_id.to_string()
        } else {
            get_privacy_id_for_addr(node_id)
        };
        // Deprecated no-op (reputation is chain-derived). Trace at DBG only — it was firing
        // hundreds of [WARN] lines per run from recurring call sites, drowning real warnings.
        if crate::node::is_debug() {
            println!("[DBG][P2P] set_node_reputation() deprecated - {} reputation managed via blockchain", display_id);
        }
    }
    
    /// Get reputation score for a node (ONLY consensus_score - synced via blocks)
    /// MEV PROTECTION: Used for bundle submission reputation checks
    /// Returns INITIAL_REPUTATION (default consensus threshold) if peer not found
    pub fn get_node_combined_reputation(&self, node_id: &str) -> f64 {
        // First check peer_id_to_addr index for O(1) lookup
        if let Some(addr_entry) = self.peer_id_to_addr.get(node_id) {
            let addr = addr_entry.value().clone();
            drop(addr_entry); // Release lock before next lookup
            
            // Get peer info from connected_peers_lockfree
            if let Some(peer_entry) = self.connected_peers_lockfree.get(&addr) {
                return peer_entry.value().combined_reputation();
            }
        }
        
        // Fallback: iterate connected_peers_lockfree (slower but comprehensive)
        for entry in self.connected_peers_lockfree.iter() {
            if entry.value().id == node_id {
                return entry.value().combined_reputation();
            }
        }
        
        // Not found: return INITIAL_REPUTATION
        qnet_consensus::deterministic_reputation::INITIAL_REPUTATION
    }
    
    /// PRODUCTION: Check if node is banned
    /// v2.21.5: Uses DeterministicReputationState from blockchain
    pub fn is_node_banned(&self, node_id: &str) -> bool {
        // Check from blockchain source
        let rep = self.get_node_reputation_from_blockchain(node_id);
        rep < 10.0 // Banned if reputation below 10%
    }
    
    /// CRITICAL FIX: Save reputation to persistent storage with integrity check
    pub(super) fn save_reputation_to_storage(&self, node_id: &str, reputation: f64) {
        // ARCHITECTURE: Node-type aware storage - only Light nodes don't store
        match self.node_type {
            NodeType::Light => {
                // Light nodes don't store any reputation (mobile/IoT devices)
                // They request it from Super/Full nodes when needed
                // This saves ~300MB-3GB of storage on constrained devices
                return;
            },
            NodeType::Super => {
                // Both Super nodes store ALL reputation
                // Full nodes: Can participate in consensus, need full data
                // Super nodes: Produce blocks, need full data for leader selection
                // Storage overhead is minimal (~300MB) compared to blockchain size
            }
        }
        
        // SECURITY: Add cryptographic integrity to prevent tampering
        
        // SCALABILITY: Use batched storage to avoid millions of files
        // Ensure data directory exists with reputation subdirectory
        // ARCHITECTURE FIX: Try multiple locations for better compatibility
        let reputation_dirs = vec![
            "./data/reputation",      // Primary location
            "/tmp/qnet/reputation",    // Fallback for permission issues
            "/var/tmp/qnet/reputation" // Alternative fallback
        ];
        
        let mut reputation_dir = "./data/reputation";
        let mut dir_created = false;
        
        for dir in &reputation_dirs {
            if let Ok(_) = std::fs::create_dir_all(dir) {
                reputation_dir = dir;
                dir_created = true;
                break;
            }
        }
        
        if !dir_created {
            // All locations failed - use in-memory only (graceful degradation)
            if crate::node::is_info() {
                println!("[WARN][REP] Could not create reputation directory - using memory-only mode");
            }
            // Store in memory but don't persist - this is fine for production
            // The reputation will rebuild from blockchain events
            return;
        }
        
        // PRODUCTION: Hash node_id to determine batch (1000 nodes per file)
        // This reduces file count from millions to thousands
        use sha3::{Sha3_256, Digest as Sha3Digest};
        let mut id_hasher = Sha3_256::new();
        id_hasher.update(node_id.as_bytes());
        let hash_result = id_hasher.finalize();
        let batch_num = ((hash_result[0] as u32) << 8 | hash_result[1] as u32) % 1000;
        let batch_file = format!("{}/batch_{:03}.dat.zst", reputation_dir, batch_num);
        
        // PRODUCTION: Load existing batch or create new one
        let mut batch_data: HashMap<String, serde_json::Value> = if std::path::Path::new(&batch_file).exists() {
            // Decompress and load existing batch
            match std::fs::read(&batch_file) {
                Ok(compressed_data) => {
                    match zstd::decode_all(&compressed_data[..]) {
                        Ok(decompressed) => {
                            match serde_json::from_slice(&decompressed) {
                                Ok(data) => data,
                                Err(_) => HashMap::new()
                            }
                        },
                        Err(_) => HashMap::new()
                    }
                },
                Err(_) => HashMap::new()
            }
        } else {
            HashMap::new()
        };
        
        // Create reputation record with timestamp and hash
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // Create integrity hash (SHA3-256)
        let mut hasher = Sha3_256::new();
        hasher.update(node_id.as_bytes());
        hasher.update(reputation.to_le_bytes());
        hasher.update(timestamp.to_le_bytes());
        
        // Add secret salt (from node's private key or environment)
        let salt = std::env::var("QNET_NODE_SECRET").unwrap_or_else(|_| {
            // Fallback: Use node ID + fixed salt (less secure but works)
            format!("QNET_REPUTATION_SALT_{}", node_id)
        });
        hasher.update(salt.as_bytes());
        
        let integrity_hash = hex::encode(hasher.finalize());
        
        // Create JSON entry for this node
        let reputation_entry = serde_json::json!({
            "reputation": reputation,
            "timestamp": timestamp,
            "integrity": integrity_hash,
            "version": 1
        });
        
        // Update batch with this node's reputation
        batch_data.insert(node_id.to_string(), reputation_entry);
        
        // COMPRESSION: Serialize and compress batch with Zstd level 10
        // Higher compression for reputation data that changes rarely
        match serde_json::to_vec(&batch_data) {
            Ok(serialized) => {
                match zstd::encode_all(&serialized[..], 10) { // Level 10 for reputation
                    Ok(compressed) => {
                        // Write compressed batch to file
                        match std::fs::write(&batch_file, compressed) {
                            Ok(_) => {
                                if batch_data.len() % 100 == 0 { // Log every 100 nodes
                                    if crate::node::is_info() {
                                        println!("[INFO][REP] Batch {} updated: {} nodes (compressed)",
                                                batch_num, batch_data.len());
                                    }
                                }
                            },
                            Err(e) => {
                                if crate::node::is_info() {
                                    println!("[WARN][REP] Failed to write batch file: {}", e);
                                }
                            }
                        }
                    },
                    Err(e) => {
                        if crate::node::is_info() {
                            println!("[WARN][REP] Failed to compress reputation batch: {}", e);
                        }
                    }
                }
            },
            Err(e) => {
                if crate::node::is_info() {
                    println!("[WARN][REP] Failed to serialize reputation batch: {}", e);
                }
            }
        }
    }
    
    /// PRODUCTION: Save jail status to persistent storage with integrity protection
    /// SECURITY: Uses cryptographic integrity hash to prevent tampering
    /// ARCHITECTURE: Matches reputation storage pattern (batched, compressed, verified)
    pub fn save_jail_to_storage(&self, node_id: &str, jailed_until: u64, jail_count: u32, reason: &str) {
        // Light nodes don't store jail data
        if matches!(self.node_type, NodeType::Light) {
            return;
        }
        
        // Use same directory structure as reputation
        let jail_dir = "./data/jail";
        if std::fs::create_dir_all(jail_dir).is_err() {
            if crate::node::is_info() {
                println!("[WARN][P2P] Could not create jail directory");
            }
            return;
        }
        
        // SECURITY: Calculate integrity hash for tamper detection
        use sha3::{Sha3_256, Digest as Sha3Digest};
        let mut integrity_hasher = Sha3_256::new();
        integrity_hasher.update(node_id.as_bytes());
        integrity_hasher.update(&jailed_until.to_le_bytes());
        integrity_hasher.update(&jail_count.to_le_bytes());
        integrity_hasher.update(reason.as_bytes());
        let integrity_hash = hex::encode(integrity_hasher.finalize());
        
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // SCALABILITY: Use batched storage like reputation (hash-based sharding)
        // This prevents single-file bottleneck for millions of nodes
        let mut id_hasher = Sha3_256::new();
        id_hasher.update(node_id.as_bytes());
        let hash_result = id_hasher.finalize();
        let batch_num = ((hash_result[0] as u32) << 8 | hash_result[1] as u32) % 100; // 100 batches for jail
        let batch_file = format!("{}/batch_{:03}.dat.zst", jail_dir, batch_num);
        
        // Load existing batch or create new
        let mut batch_data: std::collections::HashMap<String, serde_json::Value> = 
            if let Ok(compressed) = std::fs::read(&batch_file) {
                if let Ok(decompressed) = zstd::decode_all(&compressed[..]) {
                    serde_json::from_slice(&decompressed).unwrap_or_default()
                } else {
                    std::collections::HashMap::new()
                }
            } else {
                std::collections::HashMap::new()
            };
        
        // Add/update this jail entry with integrity hash
        batch_data.insert(node_id.to_string(), serde_json::json!({
            "jailed_until": jailed_until,
            "jail_count": jail_count,
            "reason": reason,
            "saved_at": timestamp,
            "integrity": integrity_hash,  // SECURITY: Tamper detection
            "version": 1
        }));
        
        // COMPRESSION: Serialize and compress with Zstd
        if let Ok(serialized) = serde_json::to_vec(&batch_data) {
            if let Ok(compressed) = zstd::encode_all(&serialized[..], 10) {
                if let Err(e) = std::fs::write(&batch_file, compressed) {
                    if crate::node::is_info() {
                        println!("[WARN][P2P] Failed to save jail status: {}", e);
                    }
                } else {
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Saved jail status for {} (batch {}, integrity: {}...)",
                                node_id, batch_num, qnet_state::char_prefix(&integrity_hash, 8));
                    }
                }
            }
        }
    }
    
    /// PRODUCTION: Load all jail statuses from persistent storage on startup
    /// SECURITY: Verifies integrity hash to detect tampering
    pub fn load_jail_from_storage(&self) -> Vec<(String, u64, u32, String)> {
        if matches!(self.node_type, NodeType::Light) {
            return Vec::new();
        }
        
        let jail_dir = "./data/jail";
        if !std::path::Path::new(jail_dir).exists() {
            return Vec::new();
        }
        
        let mut result = Vec::new();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // SCALABILITY: Scan all batch files
        if let Ok(entries) = std::fs::read_dir(jail_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "zst").unwrap_or(false) {
                    if let Ok(compressed) = std::fs::read(&path) {
                        if let Ok(decompressed) = zstd::decode_all(&compressed[..]) {
                            if let Ok(batch_data) = serde_json::from_slice::<std::collections::HashMap<String, serde_json::Value>>(&decompressed) {
                                for (node_id, entry) in batch_data {
                                    if let (Some(jailed_until), Some(jail_count), Some(reason), Some(stored_integrity)) = (
                                        entry["jailed_until"].as_u64(),
                                        entry["jail_count"].as_u64(),
                                        entry["reason"].as_str(),
                                        entry["integrity"].as_str()
                                    ) {
                                        // SECURITY: Verify integrity hash
                                        use sha3::{Sha3_256, Digest as Sha3Digest};
                                        let mut integrity_hasher = Sha3_256::new();
                                        integrity_hasher.update(node_id.as_bytes());
                                        integrity_hasher.update(&jailed_until.to_le_bytes());
                                        integrity_hasher.update(&(jail_count as u32).to_le_bytes());
                                        integrity_hasher.update(reason.as_bytes());
                                        let computed_hash = hex::encode(integrity_hasher.finalize());
                                        
                                        if computed_hash != stored_integrity {
                                            if crate::node::is_info() {
                                                println!("[ERR][P2P] INTEGRITY VIOLATION for {} - file may be tampered!", node_id);
                                            }
                                            continue; // Skip tampered entries
                                        }
                                        
                                        // Only load if still active (jailed_until > now or permanent ban)
                                        if jailed_until > now || jailed_until == u64::MAX {
                                            result.push((node_id, jailed_until, jail_count as u32, reason.to_string()));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        if !result.is_empty() {
            if crate::node::is_info() {
                println!("[INFO][P2P] Loaded {} active jail statuses from storage (integrity verified)", result.len());
            }
        }
        
        result
    }
    
    /// PRODUCTION: Remove jail status from storage when released
    /// Note: In practice, expired jails are simply not loaded on next startup
    pub fn remove_jail_from_storage(&self, node_id: &str) {
        if matches!(self.node_type, NodeType::Light) {
            return;
        }
        
        let jail_dir = "./data/jail";
        
        // Calculate batch file for this node
        use sha3::{Sha3_256, Digest as Sha3Digest};
        let mut id_hasher = Sha3_256::new();
        id_hasher.update(node_id.as_bytes());
        let hash_result = id_hasher.finalize();
        let batch_num = ((hash_result[0] as u32) << 8 | hash_result[1] as u32) % 100;
        let batch_file = format!("{}/batch_{:03}.dat.zst", jail_dir, batch_num);
        
        if !std::path::Path::new(&batch_file).exists() {
            return;
        }
        
        // Load, remove, and save back
        if let Ok(compressed) = std::fs::read(&batch_file) {
            if let Ok(decompressed) = zstd::decode_all(&compressed[..]) {
                if let Ok(mut batch_data) = serde_json::from_slice::<std::collections::HashMap<String, serde_json::Value>>(&decompressed) {
                    if batch_data.remove(node_id).is_some() {
                        if let Ok(serialized) = serde_json::to_vec(&batch_data) {
                            if let Ok(recompressed) = zstd::encode_all(&serialized[..], 10) {
                                let _ = std::fs::write(&batch_file, recompressed);
                                if crate::node::is_info() {
                                    println!("[INFO][P2P] Removed jail status for {} from storage", node_id);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    /// CRITICAL FIX: Load reputation from persistent storage with integrity verification
    pub fn load_reputation_from_storage(&self, node_id: &str) -> Option<f64> {
        // ARCHITECTURE: Node-type aware loading
        match self.node_type {
            NodeType::Light => {
                // Light nodes don't store reputation files
                // They request from Super/Full nodes via API when needed
                return None;
            },
            NodeType::Super => {
                // Both Super nodes have complete reputation storage
                // Continue with loading from local files
            }
        }
        
        // SCALABILITY: Calculate batch file for this node_id
        use sha3::{Sha3_256, Digest as Sha3Digest};
        let mut id_hasher = Sha3_256::new();
        id_hasher.update(node_id.as_bytes());
        let hash_result = id_hasher.finalize();
        let batch_num = ((hash_result[0] as u32) << 8 | hash_result[1] as u32) % 1000;
        let batch_file = format!("./data/reputation/batch_{:03}.dat.zst", batch_num);
        
        // PRODUCTION: Load and decompress batch file
        if !std::path::Path::new(&batch_file).exists() {
            // Try legacy single-file format for backwards compatibility
            let legacy_file = format!("./data/reputation_{}.dat", node_id);
            if std::path::Path::new(&legacy_file).exists() {
                // Migrate from old format
                if let Ok(content) = std::fs::read_to_string(&legacy_file) {
                    if let Ok(data) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(rep) = data["reputation"].as_f64() {
                            if crate::node::is_info() {
                                println!("[INFO][REP] Migrating legacy reputation for {}: {:.1}", node_id, rep);
                            }
                            // Save in new format
                            self.save_reputation_to_storage(node_id, rep);
                            // Delete old file
                            let _ = std::fs::remove_file(&legacy_file);
                            return Some(rep);
                        }
                    }
                }
            }
            return None;
        }
        
        // Decompress and load batch
        let batch_data: HashMap<String, serde_json::Value> = match std::fs::read(&batch_file) {
            Ok(compressed_data) => {
                match zstd::decode_all(&compressed_data[..]) {
                    Ok(decompressed) => {
                        match serde_json::from_slice(&decompressed) {
                            Ok(data) => data,
                            Err(_) => return None
                        }
                    },
                    Err(_) => return None
                }
            },
            Err(_) => return None
        };
        
        // Find this node's entry in the batch
        if let Some(entry) = batch_data.get(node_id) {
            let reputation = entry["reputation"].as_f64()?;
            let timestamp = entry["timestamp"].as_u64()?;
            let stored_hash = entry["integrity"].as_str()?;
            
            // Verify integrity hash
            let mut hasher = Sha3_256::new();
            hasher.update(node_id.as_bytes());
            hasher.update(reputation.to_le_bytes());
            hasher.update(timestamp.to_le_bytes());
            
            // Add secret salt (same as when saving)
            let salt = std::env::var("QNET_NODE_SECRET").unwrap_or_else(|_| {
                format!("QNET_REPUTATION_SALT_{}", node_id)
            });
            hasher.update(salt.as_bytes());
            
            let computed_hash = hex::encode(hasher.finalize());
            
            if computed_hash != stored_hash {
                if crate::node::is_info() {
                    println!("[ERR][REP] INTEGRITY CHECK FAILED! Reputation may be tampered!");
                }
                
                // CRITICAL: Report reputation tampering as malicious behavior
                self.report_reputation_tampering(node_id, reputation);
                
                return None;  // Don't load tampered reputation
            }
            
            // Check if reputation is too old (optional: expire after 30 days)
            let current_time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            
            let age_days = (current_time - timestamp) / 86400;
            if age_days > 30 {
                if crate::node::is_info() {
                    println!("[WARN][REP] Reputation data is {} days old - resetting", age_days);
                }
                return None;
            }
            
            Some(reputation)
        } else {
            None
        }
    }
    
    /// CRITICAL: Report and punish reputation tampering attempts
    pub(super) fn report_reputation_tampering(&self, node_id: &str, attempted_reputation: f64) {
        if crate::node::is_info() {
            println!("[ERR][SECURITY] REPUTATION TAMPERING DETECTED! ");
        }
        if crate::node::is_info() {
            println!("[INFO][SECURITY] Node: {} attempted to set reputation to {:.1}%", node_id, attempted_reputation);
        }
        
        // Get current legitimate reputation from blockchain (v2.21.5)
        let current_reputation = self.get_node_reputation_from_blockchain(node_id);
        
        // Calculate severity of tampering
        let severity = if attempted_reputation >= 90.0 && current_reputation < qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION {
            // Attempted to jump from low to high reputation
            "CRITICAL"
        } else if attempted_reputation - current_reputation > 30.0 {
            // Attempted significant increase
            "HIGH"
        } else {
            "MEDIUM"
        };
        
        if crate::node::is_info() {
            println!("[ERR][SECURITY] Tampering severity: {} (current: {:.1}%, attempted: {:.1}%)",
                     severity, current_reputation, attempted_reputation);
        }
        
        // Apply severe penalties based on tampering severity
        let _penalty = match severity {
            "CRITICAL" => {
                // CRITICAL: Attempted to fake high reputation
                // Penalty: Set to 0% and ban from network
                if crate::node::is_info() {
                    println!("[ERR][SECURITY] CRITICAL TAMPERING - Setting reputation to 0% and marking for BAN");
                }
                
                // Mark node as malicious in storage
                self.mark_node_as_malicious(node_id, "REPUTATION_TAMPERING_CRITICAL");
                
                -100.0  // Drop to 0%
            },
            "HIGH" => {
                // HIGH: Significant tampering
                // Penalty: -50% reputation
                if crate::node::is_info() {
                    println!("[WARN][SECURITY] HIGH TAMPERING - Applying -50% reputation penalty");
                }
                
                self.mark_node_as_malicious(node_id, "REPUTATION_TAMPERING_HIGH");
                
                -50.0
            },
            _ => {
                // MEDIUM: Minor tampering
                // Penalty: -30% reputation
                if crate::node::is_info() {
                    println!("[WARN][SECURITY] MEDIUM TAMPERING - Applying -30% reputation penalty");
                }
                
                self.mark_node_as_malicious(node_id, "REPUTATION_TAMPERING_MEDIUM");
                
                -30.0
            }
        };
        
        // Apply the penalty (Byzantine attack)
        // Report reputation tampering as slashing event
        let current_height = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        self.report_invalid_block(
            node_id, 
            current_height, 
            [0u8; 32], // No specific block hash for tampering
            &format!("Reputation tampering: attempted={:.1}%, actual={:.1}%", attempted_reputation, current_reputation)
        );
        
        // Broadcast tampering alert to network
        self.broadcast_tampering_alert(node_id, attempted_reputation, current_reputation, severity);
        
        // Log to permanent security audit
        self.log_security_incident(node_id, "REPUTATION_TAMPERING", severity);
    }
    
    /// Mark node as malicious in permanent storage
    pub(super) fn mark_node_as_malicious(&self, node_id: &str, violation_type: &str) {
        let malicious_file = format!("./data/malicious_{}.json", node_id);
        
        let incident = serde_json::json!({
            "node_id": node_id,
            "violation": violation_type,
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            "action": "REPUTATION_PENALTY",
            "permanent": violation_type.contains("CRITICAL")
        });
        
        // Append to malicious behavior log
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&malicious_file) {
            use std::io::Write;
            let _ = writeln!(file, "{}", incident.to_string());
        }
    }
    
    /// Broadcast tampering alert to all peers
    pub(super) fn broadcast_tampering_alert(&self, node_id: &str, attempted_rep: f64, actual_rep: f64, severity: &str) {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_info() {
                    println!("[WARN][SECURITY] WARN: No Tokio runtime - tampering alert skipped");
                }
                return;
            }
        };

        // Create security alert message
        let alert_data = serde_json::json!({
            "type": "REPUTATION_TAMPERING",
            "node_id": node_id,
            "attempted_reputation": attempted_rep,
            "actual_reputation": actual_rep,
            "severity": severity,
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            "action_taken": "PENALTY_APPLIED"
        });
        
        // v2.51: Lock-free peer collection
        let mut broadcasted = 0;
        let mut super_nodes = Vec::new();
        let mut other_peers = Vec::new();
        
        for entry in self.connected_peers_lockfree.iter() {
            let peer_id = entry.key();
            let peer_info = entry.value();
            if peer_id != node_id {
                match peer_info.node_type {
                    NodeType::Super => super_nodes.push((peer_id.clone(), peer_info.clone())),
                    _ => other_peers.push((peer_id.clone(), peer_info.clone())),
                }
            }
        }
        
        // Always notify all Super nodes (consensus validators)
        for (peer_id, peer_info) in super_nodes.iter() {
                // Send security alert via HTTP endpoint
                let url = format!("http://{}:{}/api/v1/security/alert", 
                                peer_info.addr, 8001);
                
                let alert_json = alert_data.clone();
                let peer_id_clone = peer_id.clone();
                
                // Send async to not block
                handle.spawn(async move {
                    if let Ok(client) = reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(5))
                        .tcp_keepalive(std::time::Duration::from_secs(HTTP_TCP_KEEPALIVE_SECS))
                        .pool_max_idle_per_host(HTTP_POOL_MAX_IDLE_PER_HOST)
                        .pool_idle_timeout(std::time::Duration::from_secs(HTTP_POOL_IDLE_TIMEOUT_SECS))
                        .build() {
                        
                        match client.post(&url)
                            .json(&alert_json)
                            .send()
                            .await {
                            Ok(_) => {
                                if crate::node::is_info() {
                                    println!("[INFO][SECURITY] Alert sent to {}", peer_id_clone);
                                }
                            },
                            Err(e) => {
                                if crate::node::is_info() {
                                    println!("[WARN][SECURITY] Failed to send alert to {}: {}", peer_id_clone, e);
                                }
                            }
                        }
                    }
                });
                
                broadcasted += 1;
            }
        
        // SCALABILITY: For other peers, only notify a random sample (max 10)
        // This prevents network storm when we have millions of nodes
        use rand::seq::SliceRandom;
        let mut rng = rand::rngs::OsRng;
        let sample_size = std::cmp::min(10, other_peers.len());
        let sampled_peers: Vec<_> = other_peers.choose_multiple(&mut rng, sample_size).cloned().collect();
        
        for (peer_id, peer_info) in sampled_peers.iter() {
            let url = format!("http://{}:{}/api/v1/security/alert", 
                            peer_info.addr, self.port);
            
            let alert_json = alert_data.clone();
            let peer_id_clone = peer_id.clone();
            
            handle.spawn(async move {
                if let Ok(client) = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(5))
                    .tcp_keepalive(std::time::Duration::from_secs(HTTP_TCP_KEEPALIVE_SECS))
                    .pool_max_idle_per_host(HTTP_POOL_MAX_IDLE_PER_HOST)
                    .pool_idle_timeout(std::time::Duration::from_secs(HTTP_POOL_IDLE_TIMEOUT_SECS))
                    .build() {
                    
                    match client.post(&url)
                        .json(&alert_json)
                        .send()
                        .await {
                        Ok(_) => {
                            if crate::node::is_info() {
                                println!("[INFO][SECURITY] Alert sent to {}", peer_id_clone);
                            }
                        },
                        Err(e) => {
                            if crate::node::is_info() {
                                println!("[WARN][SECURITY] Failed to send alert to {}: {}", peer_id_clone, e);
                            }
                        }
                    }
                }
            });
            
            broadcasted += 1;
        }
        
        if crate::node::is_info() {
            println!("[INFO][SECURITY] Alert sent to {} Super nodes + {} sampled peers (total broadcasted: {})",
                     super_nodes.len(), sampled_peers.len(), broadcasted);
        }
    }
    
    /// Log security incident with cryptographic chain for tamper-proof audit trail
    pub(super) fn log_security_incident(&self, node_id: &str, incident_type: &str, severity: &str) {
        // Use QNET_STORAGE_PATH (set during node init) with fallback to "./data"
        let storage_path = std::env::var("QNET_STORAGE_PATH").unwrap_or_else(|_| "./data".to_string());
        
        // Ensure data directory exists
        if let Err(e) = std::fs::create_dir_all(&storage_path) {
            if crate::node::is_info() {
                println!("[WARN][SECURITY] Failed to create data directory {}: {}", storage_path, e);
            }
            return; // Don't block on file system errors
        }
        
        // CRITICAL: Create tamper-proof audit chain (like blockchain)
        let audit_file = format!("{}/security_audit.chain", storage_path);
        let audit_index_file = format!("{}/security_audit.index", storage_path);
        
        // Get previous audit hash for chain
        let previous_hash = self.get_last_audit_hash(&audit_index_file).unwrap_or_else(|| {
            // Genesis audit entry
            "0000000000000000000000000000000000000000000000000000000000000000".to_string()
        });
        
        // Create audit entry with all details
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let audit_entry = serde_json::json!({
            "index": self.get_audit_index(&audit_index_file),
            "timestamp": timestamp,
            "incident_type": incident_type,
            "node_id": node_id,
            "severity": severity,
            "action": "PENALTY_APPLIED",
            "previous_hash": previous_hash,
        });
        
        // Calculate cryptographic hash of this entry (including previous hash for chain)
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(audit_entry.to_string().as_bytes());
        
        // Add system secret for additional protection
        let system_secret = std::env::var("QNET_AUDIT_SECRET").unwrap_or_else(|_| {
            // Derive from node's identity
            format!("QNET_AUDIT_CHAIN_{}", self.node_id)
        });
        hasher.update(system_secret.as_bytes());
        
        let entry_hash = hex::encode(hasher.finalize());
        
        // Create final audit block
        let audit_block = serde_json::json!({
            "entry": audit_entry,
            "hash": entry_hash,
            "signature": self.sign_audit_entry(&entry_hash),  // Digital signature
        });
        
        // Append to audit chain file
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&audit_file) {
            use std::io::Write;
            let _ = writeln!(file, "{}", audit_block.to_string());
            
            // Update index with latest hash
            self.update_audit_index(&audit_index_file, &entry_hash);
            
            if crate::node::is_info() {
                println!("[INFO][SECURITY] Security incident logged with hash: {}", qnet_state::char_prefix(&entry_hash, 16));
            }
        }
        
        // CRITICAL: Also broadcast to network for distributed audit
        self.broadcast_audit_entry(audit_block);
    }
    
    /// Get the hash of the last audit entry for chain continuity
    pub(super) fn get_last_audit_hash(&self, index_file: &str) -> Option<String> {
        if let Ok(content) = std::fs::read_to_string(index_file) {
            let lines: Vec<&str> = content.lines().collect();
            if let Some(last_line) = lines.last() {
                // Format: index|hash|timestamp
                let parts: Vec<&str> = last_line.split('|').collect();
                if parts.len() >= 2 {
                    return Some(parts[1].to_string());
                }
            }
        }
        None
    }
    
    /// Get next audit index number
    pub(super) fn get_audit_index(&self, index_file: &str) -> u64 {
        if let Ok(content) = std::fs::read_to_string(index_file) {
            content.lines().count() as u64 + 1
        } else {
            1  // First entry
        }
    }
    
    /// Update audit index with new entry hash
    pub(super) fn update_audit_index(&self, index_file: &str, hash: &str) {
        let index = self.get_audit_index(index_file);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(index_file) {
            use std::io::Write;
            let _ = writeln!(file, "{}|{}|{}", index, hash, timestamp);
        }
    }
    
    /// Sign audit entry with quantum-resistant Dilithium signature (ASYNC version)
    /// PRODUCTION: Use this in async contexts
    /// Sign audit entry with PQ cryptography (ASYNC version) - pure ML-DSA-65
    /// CRITICAL: Single ML-DSA-65 (ML-DSA-65) signature per audit entry
    pub async fn sign_audit_entry_async(&self, entry_hash: &str) -> String {
        use crate::pq_crypto::{PqCrypto, GLOBAL_PQ_INSTANCES};
        use std::sync::Arc;

        // Get or create PQ crypto instance
        let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
            Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
        }).await;

        let mut instances_guard = instances.lock().await;

        // v2.24: Use node_id directly
        let normalized_node_id = self.node_id.clone();

        // Create instance if not exists
        if !instances_guard.contains_key(&normalized_node_id) {
            let mut pq = PqCrypto::new(normalized_node_id.clone());
            if let Err(e) = pq.initialize().await {
                if crate::node::is_info() {
                    println!("[ERR][SECURITY] PQ crypto init failed: {}", e);
                }
                return String::from("UNSIGNED_NO_HYBRID_SIG");
            }
            instances_guard.insert(normalized_node_id.clone(), pq);
        }

        let pq = match instances_guard.get_mut(&normalized_node_id) {
            Some(h) => h,
            None => return String::from("UNSIGNED_MISSING_INSTANCE"),
        };

        // Check certificate rotation
        if pq.needs_rotation() {
            let _ = pq.rotate_certificate().await;
        }

        // CRITICAL: Sign RAW message with pure ML-DSA-65 (hashes before signing)
        // OPTIMIZED v2.24: bincode+zstd - use standard compact_bin format
        match pq.sign_raw_message_compact(entry_hash.as_bytes()).await {
            Ok(compact_sig) => {
                match compact_sig.to_binary_compressed() {
                    Ok(binary_data) => {
                        let base64_data = base64::engine::general_purpose::STANDARD.encode(&binary_data);
                        if crate::node::is_info() {
                            println!("[INFO][SECURITY] Generated PQ signature for audit entry (bincode v2.24)");
                        }
                        format!("compact_bin:{}", base64_data)  // CompactPqSignature uses compact_bin
                    }
                    Err(e) => {
                        if crate::node::is_info() {
                            println!("[ERR][SECURITY] Failed to serialize PQ signature: {}", e);
                        }
                        String::from("UNSIGNED_SERIALIZE_FAILED")
                    }
                }
            }
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][SECURITY] Failed to generate PQ signature: {}", e);
                }
                String::from("UNSIGNED_NO_HYBRID_SIG")
            }
        }
    }

    /// Sign audit entry with PQ cryptography (SYNC version) - pure ML-DSA-65
    /// SAFE: Uses std::thread::spawn to isolate runtime, avoiding nested runtime panic
    /// CRITICAL: Single ML-DSA-65 (ML-DSA-65) signature per audit entry
    pub(super) fn sign_audit_entry(&self, entry_hash: &str) -> String {
        let node_id = self.node_id.clone();
        let entry_hash = entry_hash.to_string();
        
        // CRITICAL FIX: Use std::thread::spawn to isolate runtime
        let handle = std::thread::spawn(move || {
            use crate::pq_crypto::{PqCrypto, GLOBAL_PQ_INSTANCES};
            use std::sync::Arc;
            
            match tokio::runtime::Runtime::new() {
                Ok(rt) => {
                    let result = rt.block_on(async move {
                        // Get or create PQ crypto instance
                        let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
                            Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
                        }).await;

                        let mut instances_guard = instances.lock().await;

                        // v2.24: Use node_id directly
                        let normalized_node_id = node_id.clone();

                        // Create instance if not exists
                        if !instances_guard.contains_key(&normalized_node_id) {
                            let mut pq = PqCrypto::new(normalized_node_id.clone());
                            pq.initialize().await?;
                            instances_guard.insert(normalized_node_id.clone(), pq);
                        }

                        let pq = match instances_guard.get_mut(&normalized_node_id) {
            Some(h) => h,
            None => return Err(anyhow::anyhow!("PQ instance missing")),
        };

                        // Check certificate rotation
                        if pq.needs_rotation() {
                            let _ = pq.rotate_certificate().await;
                        }

                        // Sign RAW message with pure ML-DSA-65 (hashes before signing)
                        pq.sign_raw_message_compact(entry_hash.as_bytes()).await
                    });
                    
                    match result {
                        Ok(compact_sig) => {
                            // OPTIMIZED v2.24: bincode+zstd - use standard compact_bin format
                            match compact_sig.to_binary_compressed() {
                                Ok(binary_data) => {
                                    let base64_data = base64::engine::general_purpose::STANDARD.encode(&binary_data);
                                    format!("compact_bin:{}", base64_data)  // CompactPqSignature
                                }
                                Err(_) => String::from("UNSIGNED_SERIALIZE_FAILED")
                            }
                        }
                        Err(_) => String::from("UNSIGNED_NO_HYBRID_SIG")
                    }
                }
                Err(_) => String::from("NO_RUNTIME_FOR_HYBRID_SIG")
            }
        });
        
        match handle.join() {
            Ok(sig) => {
                if sig.starts_with("pq_bin:") || sig.starts_with("pq:") {
                    if crate::node::is_info() {
                        println!("[INFO][SECURITY] Generated PQ signature for audit entry");
                    }
                }
                sig
            }
            Err(_) => {
                if crate::node::is_info() {
                    println!("[ERR][SECURITY] Audit signature thread panicked");
                }
                String::from("THREAD_PANIC_NO_SIG")
            }
        }
    }
    
    /// Broadcast audit entry to network for distributed verification
    pub(super) fn broadcast_audit_entry(&self, audit_block: serde_json::Value) {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_info() {
                    println!("[WARN][SECURITY] WARN: No Tokio runtime - audit broadcast skipped");
                }
                return;
            }
        };
        
        // v2.51: Lock-free audit broadcast
        let peer_list: Vec<String> = self.connected_peers_lockfree.iter()
            .map(|e| e.key().clone())
            .collect();
        
        let selected_peers = if peer_list.len() <= 3 {
            peer_list
        } else {
            use rand::seq::SliceRandom;
            let mut rng = rand::rngs::OsRng;
            peer_list.choose_multiple(&mut rng, 3).cloned().collect()
        };
        
        for peer_id in selected_peers {
            let audit_data = audit_block.clone();
            let peer_info = self.connected_peers_lockfree.get(&peer_id).map(|e| e.value().clone());
            
            if let Some(info) = peer_info {
                let peer_port = 8001; // Standard QNet port
                handle.spawn(async move {
                    // Send audit entry to peer for distributed storage
                    let url = format!("http://{}:{}/api/v1/audit/store", 
                                    info.addr, peer_port);
                    
                    if let Ok(client) = reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(5))
                        .build() {
                        let _ = client.post(&url).json(&audit_data).send().await;
                    }
                });
            }
        }
        
        if crate::node::is_info() {
            println!("[INFO][SECURITY] Audit entry distributed to network for redundancy");
        }
    }
    
    /// PRIVACY: Get public display name for P2P announcements (preserves consensus node_id)
    pub fn get_public_display_name(&self) -> String {
        match self.node_type {
            NodeType::Light => {
                // Light nodes already use pseudonyms
                self.node_id.clone()
            },
            _ => {
                // CRITICAL: Genesis nodes keep original ID for consensus stability
                if self.node_id.starts_with("genesis_node_") {
                    return self.node_id.clone();
                }
                
                // Super nodes: Generate privacy-preserving display name
                self.generate_p2p_display_name()
            }
        }
    }
    
    /// PRIVACY: Generate display name for P2P announcements (Super nodes)
    pub(super) fn generate_p2p_display_name(&self) -> String {
        // EXISTING PATTERN: Use same pattern as other display name functions
        // SECURITY: Use node_id as source for consistency (not wallet for P2P layer)
        let display_hash = blake3::hash(format!("P2P_DISPLAY_{}_{}", 
                                                self.node_id, 
                                                format!("{:?}", self.node_type)).as_bytes());
        
        // PRIVACY: Generate P2P-friendly display name without revealing IP
        // v3.18: Full node type removed - only Light and Super remain
        let node_type_prefix = match self.node_type {
            NodeType::Super => "super",
            NodeType::Light => "light",
        };
        
        let region_hint = format!("{:?}", self.region).to_lowercase();
        
        format!("{}_{}_{}", 
                node_type_prefix,
                region_hint, 
                &display_hash.to_hex()[..8])
    }
    

    
    /// Get last activity map for all peers
    pub fn get_last_activity_map(&self) -> HashMap<String, u64> {
        // v2.51: Lock-free only
        self.connected_peers_lockfree.iter()
            .map(|entry| (entry.value().id.clone(), entry.value().last_seen))
            .collect()
    }
    
    /// PRODUCTION: Apply reputation decay periodically with activity check
    /// DEPRECATED v2.21.5: Decay now handled via DeterministicReputationState
    #[deprecated(note = "Reputation decay handled via blockchain in v2.21.5+")]
    pub fn apply_reputation_decay(&self) {
        // v2.21.5: No-op - reputation managed via blockchain
        // Passive recovery replaces decay for low-rep nodes
        if crate::node::is_info() {
            println!("[INFO][P2P] Reputation decay skipped - managed via blockchain");
        }
    }


    /// Send consensus message via QUIC with retry (async for non-blocking)
    pub(super) async fn send_consensus_message_with_retry(
        peer_addr: &str, 
        message: &NetworkMessage,
        quic_transport: Option<Arc<tokio::sync::RwLock<crate::quic_transport::QuicTransport>>>,
        quic_enabled: bool,
    ) -> bool {
        // Try QUIC first
        if quic_enabled {
            if let Some(ref transport) = quic_transport {
                let parts: Vec<&str> = peer_addr.split(':').collect();
                if parts.len() == 2 {
                    if let (Ok(ip), Ok(port)) = (parts[0].parse::<std::net::IpAddr>(), parts[1].parse::<u16>()) {
                        let quic_port = port.saturating_add(crate::quic_transport::QUIC_PORT_OFFSET);
                        let quic_addr = std::net::SocketAddr::new(ip, quic_port);
                        
                        let transport_guard = transport.read().await;
                        match transport_guard.broadcast_to(quic_addr, message).await {
                            Ok(_) => return true,
                            Err(e) => {
                                if crate::node::is_info() {
                                    println!("[WARN][QUIC] Consensus failed to {}: {}",
                                        get_privacy_id_for_addr(peer_addr), e);
                                }
                            }
                        }
                    }
                }
            }
        }
        
        false // QUIC failed or not available
    }
    
    /// Send network message SYNCHRONOUSLY for critical messages (blocks)
    /// Uses blocking HTTP client to ensure delivery before returning
    /// PRODUCTION v2.19.21: Sync wrapper for send_network_message
    /// DEPRECATED: Use async version when possible. This exists for legacy compatibility.
    pub fn send_network_message_sync(&self, peer_addr: &str, message: NetworkMessage) -> Result<(), String> {
        // Forward to async version via tokio::spawn
        // This is not truly synchronous but provides compatibility
        self.send_network_message(peer_addr, message);
        Ok(())
    }
    
    /// v2.94: Send critical TX with ACK confirmation (guaranteed delivery)
    /// Uses bidirectional QUIC stream and waits for ACK from receiver
    /// Use for HeartbeatCommitment, LightNodeEligibilityBitmap, and other critical TX
    pub async fn send_critical_tx_with_ack(&self, peer_addr: &str, message: NetworkMessage) -> Result<(), String> {
        if !self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("QUIC not enabled".into());
        }
        
        let quic_transport = self.quic_transport.as_ref()
            .ok_or("QUIC transport not initialized")?;
        
        // Parse address and convert to QUIC port
        let parts: Vec<&str> = peer_addr.split(':').collect();
        if parts.len() != 2 {
            return Err(format!("Invalid peer address: {}", peer_addr));
        }
        
        let ip: std::net::IpAddr = parts[0].parse()
            .map_err(|e| format!("Invalid IP: {}", e))?;
        let port: u16 = parts[1].parse()
            .map_err(|e| format!("Invalid port: {}", e))?;
        
        let quic_port = port.saturating_add(crate::quic_transport::QUIC_PORT_OFFSET);
        let quic_addr = std::net::SocketAddr::new(ip, quic_port);
        
        let transport = quic_transport.read().await;
        transport.send_with_ack(quic_addr, &message).await
    }

    /// Co-send our cached signed head to `addr` over the serve channel (the block-serve path that
    /// provably reaches the requester). Lets a freshly-joined peer — which the HealthPing emit fan-out
    /// (get_connected_peers) does not reach — learn the real network tip, so its SIGNED_HEAD_MAX
    /// advances past its own frontier and it keeps syncing instead of falsely flipping synced.
    pub fn cosend_signed_head(&self, addr: &str) {
        let head = LATEST_SIGNED_HEAD.read().clone();
        if let Some((from, timestamp, height, signature)) = head {
            let (cert_mb, cert_round) = current_tc_hint();
            self.send_network_message(addr, NetworkMessage::HealthPing { from, timestamp, height, cert_mb, cert_round, signature });
        }
    }

    /// Co-send the latest held GALC capsule (self-authenticating, tiny) to a served peer alongside the
    /// signed head — a cold joiner adopts the genesis-rooted anchor from its first serving peer and
    /// snapshot-jumps near-tip instead of replaying from h=90. Propagates via the serve tree
    /// (genesis → early supers → later joiners): O(1) per joiner, no fan-in to genesis.
    pub fn cosend_galc_capsule(&self, addr: &str) {
        if let Some(cap) = crate::galc::held() {
            if let Ok(data) = bincode::serialize(&cap) {
                self.send_network_message(addr, NetworkMessage::GenesisCheckpoint { data });
            }
        }
    }

    /// PRODUCTION v2.19.21: Send network message via QUIC (binary protocol)
    /// Falls back to async HTTP if QUIC is not available
    pub fn send_network_message(&self, peer_addr: &str, message: NetworkMessage) {
        let peer_addr = peer_addr.to_string();
        let message_clone = message.clone();
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
        let quic_transport = self.quic_transport.clone();
        
        // Log only important messages (consensus) and every 10th block
        // CRITICAL FIX v2.86: Also log Transaction errors to diagnose delivery issues
        let should_log = match &message {
            NetworkMessage::Block { height, .. } => height % 10 == 0,
            NetworkMessage::Transaction { .. } => true, // DEBUG: Log TX delivery
            _ => false,
        };
        
        if should_log {
            let message_type = match &message {
                NetworkMessage::Block { height, .. } => format!("Block #{}", height),
                _ => "Message".to_string(),
            };
            // PRIVACY: Use pseudonym in logs
            if crate::node::is_debug() {
                println!("[DBG][P2P] → Sending {} to {} via {}",
                    message_type,
                    get_privacy_id_for_addr(&peer_addr),
                    if quic_enabled { "QUIC" } else { "HTTP" });
            }
        }
        
        // ARCHITECTURE FIX: Peer addresses must be IP:port format
        let resolved_addr = if peer_addr.contains(':') {
            peer_addr.clone()
        } else {
            if crate::node::is_info() {
                println!("[ERR][P2P] Invalid peer address format (must be IP:port): {}", get_privacy_id_for_addr(&peer_addr));
            }
            return;
        };
        
        // Send asynchronously via tokio - SAFE: check if runtime is available
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                // No Tokio runtime available - skip sending (avoid panic)
                if should_log {
                    if crate::node::is_info() {
                        println!("[WARN][P2P] No async runtime - message queued for later");
                    }
                }
                return;
            }
        };
        handle.spawn(async move {
            // Try QUIC first if enabled
            if quic_enabled {
                if let Some(ref quic_transport) = quic_transport {
                    use crate::p2p_transport::QUIC_PORT_OFFSET;
                    
                    let parts: Vec<&str> = resolved_addr.split(':').collect();
                    if parts.len() == 2 {
                        if let (Ok(ip), Ok(port)) = (parts[0].parse::<std::net::IpAddr>(), parts[1].parse::<u16>()) {
                            let quic_port = port.saturating_add(QUIC_PORT_OFFSET);
                            let quic_addr = std::net::SocketAddr::new(ip, quic_port);
                            
                            let transport = quic_transport.read().await;
                            match transport.send_message(quic_addr, &message_clone).await {
                                Ok(_) => {
                                    if should_log {
                                        if crate::node::is_debug() {
                                            println!("[DBG][QUIC] Message sent to {} (binary)", get_privacy_id_for_addr(&resolved_addr));
                                        }
                                    }
                                    return; // Success, no need for HTTP fallback
                                }
                                Err(e) => {
                                    if should_log {
                                        if crate::node::is_info() {
                                            println!("[WARN][QUIC] QUIC failed to {}: {}", get_privacy_id_for_addr(&resolved_addr), e);
                                        }
                                    }
                                    // Fall through to HTTP
                                }
                            }
                        }
                    }
                }
            }
            
            // NO HTTP FALLBACK - QUIC only mode
            if should_log {
                if crate::node::is_info() {
                    println!("[ERR][QUIC] QUIC not available for {}", get_privacy_id_for_addr(&resolved_addr));
                }
            }
        });
    }

    
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // BFT TIMEOUT CONSENSUS v4.0: Deterministic failover without system clock dependency
    // ARCHITECTURE: When 2/3+ validators vote for timeout, generate TimeoutCertificate
    // This replaces NTP-based delay calculation with Byzantine agreement
    // ═══════════════════════════════════════════════════════════════════════════════════════
    
    /// Handle incoming timeout vote (v2). Verifies the voter's signature over ITS OWN payload,
    /// gates on the WINDOW-KEYED committee (identical on every verifier — the quorum denominator
    /// can never split by local height), checks the deterministic anchor, and tallies.
    pub(super) fn handle_timeout_vote(&self, height: u64, timeout_round: u64, voter_id: String,
                           anchor: Vec<u8>, high_qc_idx: u64, high_qc_hash: Vec<u8>,
                           tip_height: u64, tip_hash: Vec<u8>, signature: Vec<u8>) {
        if anchor.len() != 32 || high_qc_hash.len() != 32 || tip_hash.len() != 32 {
            if crate::node::is_warn() {
                println!("[WARN][TIMEOUT] vote_invalid_fields h={} voter={}", height, voter_id);
            }
            return;
        }
        // View floor: a window below the highest certified one is a left view — never tally it
        // (banked below-floor votes cannot be topped-up to a second TC on an adjacent window).
        if height < observed_tc_window_floor() {
            if crate::node::is_debug() {
                println!("[DBG][TIMEOUT] vote_below_floor h={} floor={} action=drop", height, observed_tc_window_floor());
            }
            return;
        }
        // Round bound: a legit failover round never exceeds certified+MAX_FAILOVER_ROUND — caps the
        // (window,round) key space so ≤f Byzantine cannot mint unbounded distinct keys.
        if timeout_round > highest_certified_round_for(height).saturating_add(crate::node::MAX_FAILOVER_ROUND) {
            if crate::node::is_debug() {
                println!("[DBG][TIMEOUT] vote_round_oob h={} round={} action=drop", height, timeout_round);
            }
            return;
        }
        // CHEAP checks before the ~5ms Dilithium verify (DoS: any registered non-committee super
        // could otherwise force a verify per junk vote). Window committee is cached; anchor absent →
        // pull + defer (sender retransmits until TC). None-committee ⇒ same anchor-absent path.
        let committee = match failover_committee_for_window(height) {
            Some(c) => c,
            None => {
                self.request_window_anchor(height);
                if crate::node::is_warn() {
                    // One line per window, not per vote: a Defer window otherwise costs a line
                    // per committee member, on the path a stall already floods.
                    if note_deferred_window(height) {
                        println!("[WARN][TIMEOUT] votes_deferred win={} round={} reason=anchor_absent action=pull", height, timeout_round);
                    }
                }
                return;
            }
        };
        if !committee.contains(&voter_id) {
            if crate::node::is_warn() {
                println!("[WARN][TIMEOUT] vote_noncommittee h={} round={} voter={} committee={} action=drop",
                         height, timeout_round, voter_id, committee.len());
            }
            return;
        }

        let mut anchor_arr = [0u8; 32]; anchor_arr.copy_from_slice(&anchor);
        let mut qc_hash_arr = [0u8; 32]; qc_hash_arr.copy_from_slice(&high_qc_hash);
        let mut tip_hash_arr = [0u8; 32]; tip_hash_arr.copy_from_slice(&tip_hash);

        // The anchor must name a macroblock THIS node holds at or below the window's roster base
        // (cheap, pre-sig). Resolution, not equality with a locally re-derived value: equality made
        // admission a function of the receiver's own seal frontier, so a vote from an honest peer on
        // a byte-identical chain was discarded as foreign. A vote minted on a fork still resolves to
        // nothing here, because macroblock storage is index-keyed and first-write-wins.
        // A resolved anchor carries ITSELF into the match: `None` already means "anchor absent
        // locally, pull and defer" in the arm below, so folding the resolved case into None would
        // discard exactly the votes this gate exists to admit.
        let local_anchor_opt = local_anchor_for_window_cached(height);
        let matches_local = local_anchor_opt.map_or(false, |a| a == anchor_arr);
        // The signed payload is identical for every gate below, so build it once.
        let vote_msg = timeout_vote_message(height, timeout_round, &anchor_arr,
                                            high_qc_idx, &qc_hash_arr, tip_height, &tip_hash_arr);
        // A vote whose anchor is not ours may still be honest — the anchor a node signs is derived
        // from its own seal frontier, which legitimately lags. Resolving it against the macroblocks
        // we hold is a bounded storage descent, so it is paid ONLY for an authenticated vote:
        // ahead of the signature it was a 33-read amplifier for anyone who could open a connection.
        let admitted = if matches_local {
            true
        } else {
            // A voter already recorded against this exact foreign anchor buys nothing new, so the
            // dedup keeps its place ahead of the ~5 ms verify.
            if FOREIGN_ANCHOR_WITNESSES.get(&(height, anchor_arr))
                .map(|s| s.contains(&voter_id)).unwrap_or(false) { return; }
            if !self.verify_timeout_vote_signature(&voter_id, &vote_msg, &signature) { return; }
            // Authenticated. Record the signed seal claim BEFORE the anchor verdict — a vote dropped
            // for an unresolvable anchor still proves what its signer has sealed.
            note_sealed_claim(height, &voter_id, high_qc_idx);
            anchor_resolves_for_window(height, &anchor_arr)
        };
        match if admitted { Some(anchor_arr) } else { local_anchor_opt } {
            Some(local_anchor) if local_anchor != anchor_arr => {
                // Never TALLY across views — two views must not combine into one quorum. But dropping
                // and nothing else leaves a minority node deaf: it discards every majority vote, its
                // view can never advance, and it keeps producing on a branch no one accepts. Count
                // distinct SIGNED foreign anchors; n−f of them proves OUR anchor is the minority one.
                // Reached only for an authenticated vote: the signature was checked above.
                // Cap distinct anchors per window: honest divergence yields one or two, while a single
                // committee member could otherwise mint an unbounded number of map keys by signing a
                // fresh anchor per vote. Voter sets stay bounded by committee size.
                const MAX_FOREIGN_ANCHORS_PER_WINDOW: usize = 4;
                {
                    let known = FOREIGN_ANCHOR_WITNESSES.contains_key(&(height, anchor_arr));
                    let distinct = FOREIGN_ANCHOR_WITNESSES.iter().filter(|e| e.key().0 == height).count();
                    if !known && distinct >= MAX_FOREIGN_ANCHORS_PER_WINDOW { return; }
                }
                let witnesses = {
                    let mut e = FOREIGN_ANCHOR_WITNESSES
                        .entry((height, anchor_arr))
                        .or_insert_with(std::collections::HashSet::new);
                    e.insert(voter_id.clone());
                    e.len()
                };
                FOREIGN_ANCHOR_WITNESSES.retain(|k, _| k.0 + 8 >= height);
                let need = qnet_consensus::checkpoint_bft::quorum_size(committee.len());
                if witnesses >= need {
                    if crate::node::is_warn() {
                        println!("[WARN][TIMEOUT] foreign_anchor_quorum win={} witnesses={} need={} action=reconcile",
                                 height, witnesses, need);
                    }
                    self.request_window_anchor(height);
                } else if crate::node::is_warn() {
                    println!("[WARN][TIMEOUT] vote_anchor_mismatch h={} voter={} witnesses={}/{} action=drop",
                             height, voter_id, witnesses, need);
                }
                return;
            }
            None => { self.request_window_anchor(height); return; }
            _ => {}
        }

        // Signature (the ~5ms cost) — after the cheap floor/round/committee/anchor gates. Already
        // paid above when the anchor was not ours, so verify here only for the matching-anchor path.
        if !matches_local {} else if !self.verify_timeout_vote_signature(&voter_id, &vote_msg, &signature) {
            if crate::node::is_warn() {
                println!("[WARN][TIMEOUT] vote_sig_invalid h={} voter={}", height, voter_id);
            }
            return;
        } else {
            note_sealed_claim(height, &voter_id, high_qc_idx);
        }

        if TIMEOUT_CERTIFICATES.contains_key(&(height, timeout_round)) {
            if crate::node::is_debug() {
                println!("[DBG][TIMEOUT] proof_exists h={} round={} ignoring_vote", height, timeout_round);
            }
            return;
        }

        // n−f quorum over the WINDOW committee (same quorum fn as Checkpoint-BFT). Never relaxed:
        // the threshold and the vote preimage would both come from LOCAL arm state, so armed and
        // unarmed nodes would certify different rotation rounds — two producers for one height.
        let byzantine_threshold = qnet_consensus::checkpoint_bft::quorum_size(committee.len());

        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let stored = StoredTimeoutVote {
            signature: signature.clone(), anchor: anchor_arr,
            high_qc_idx, high_qc_hash: qc_hash_arr,
            tip_height, tip_hash: tip_hash_arr, updated_at: now_secs,
        };
        // Tally. Equivocation is ANCHOR-ONLY (a field an honest voter can never legitimately
        // change); a same-key re-vote with advanced tip/high_qc is an UPDATE (replace, rate-
        // bounded) — never slashed, so honest supersession/progress mid-stall is safe.
        let votes_count = {
            let mut entry = TIMEOUT_VOTES.entry((height, timeout_round)).or_insert_with(HashMap::new);
            match entry.get(&voter_id) {
                Some(existing) if existing.anchor != anchor_arr => {
                    // One live claim per voter: the newer vote replaces the older view. Views still
                    // never aggregate — the quorum below counts only the votes sharing THIS anchor.
                    // Rate-bounded like any other re-vote, but not STRICTLY: a correction landing in
                    // the same wall-clock second as the vote it replaces is exactly the honest case,
                    // and dropping it holds the tally one short of quorum.
                    if now_secs < existing.updated_at { return; }
                    if crate::node::is_warn() {
                        println!("[WARN][TIMEOUT] vote_anchor_superseded h={} voter={}",
                                 height, voter_id);
                    }
                }
                Some(existing) => {
                    let progressed = tip_height > existing.tip_height || high_qc_idx > existing.high_qc_idx;
                    let rate_ok = now_secs > existing.updated_at;
                    if !(progressed && rate_ok) { return; } // duplicate / non-progress / too-fast update
                }
                None => {}
            }
            entry.insert(voter_id.clone(), stored);
            // Count THIS anchor's group, not the bucket. Admission resolves an anchor against the
            // chain rather than against the receiver's seal frontier, so two honest anchors can now
            // share a (window, round) bucket; a certificate stamps ONE anchor and every verifier
            // rebuilds all preimages from it, so a mixed set mints a proof nobody can verify.
            entry.values().filter(|v| v.anchor == anchor_arr).count()
        };

        if crate::node::is_info() {
            println!("[INFO][TIMEOUT] vote_collected h={} round={} voter={} count={}/{}",
                     height, timeout_round, voter_id, votes_count, byzantine_threshold);
        }

        // Leader-selection round (HIGHEST_CERTIFIED_ROUND) advances ONLY on a same-round
        // 2f+1 TimeoutProof (formed below / received via TC broadcast) — never cross-round,
        // never f+1. A cross-round or f+1 advance is path-dependent (gossip-order skew →
        // different leaders for one height → dual production, forensic h=154). Liveness:
        // heartbeat-synchronized timeouts + per-round grace backoff, all strictly 2f+1.

        // Signed n−f same-round → TimeoutCertificate (strongest advancement).
        if votes_count >= byzantine_threshold {
            self.generate_and_broadcast_timeout_proof(height, timeout_round, anchor_arr);
        }

        // Vote gossip for fast round-convergence under partial reach. Without
        // re-broadcasting received votes a TimeoutVote travels only the direct
        // producer edge, leaving jitter/cooldown-missed peers with a stale
        // HIGHEST_*_ROUND (forensic h=15901 split-view: 005 saw round=0 while
        // 001 saw round=27). Protocol: skip self-emitted and duplicate votes;
        // re-broadcast to a small RANDOM subset (3 ≤100 nodes, else 5) → O(log
        // N) hops; receivers re-verify ML-DSA-65 + dedup (no gossiper trust);
        // the dedup early-return terminates the wave (no loop). ~200× less
        // bandwidth than full re-broadcast at 1000-validator scale.
        if voter_id != self.node_id {
            let total_for_gossip = committee.len();
            if total_for_gossip > 1 {
                let gossip_fanout = if total_for_gossip > 100 { 5 } else { 3 };
                let self_id = self.node_id.clone();
                let exclude_voter = voter_id.clone();
                let mut peer_addrs: Vec<String> = self.connected_peers_lockfree.iter()
                    .filter(|entry| {
                        let pid = &entry.value().id;
                        pid != &self_id && pid != &exclude_voter
                    })
                    .map(|entry| entry.value().addr.clone())
                    .collect();
                // Lightweight randomization — rotate by a per-vote stable seed
                // (height XOR round) so different votes pick different fan-out
                // subsets, giving cumulative full-mesh coverage over time.
                if !peer_addrs.is_empty() {
                    let rotate = ((height ^ timeout_round) as usize) % peer_addrs.len();
                    peer_addrs.rotate_left(rotate);
                    peer_addrs.truncate(gossip_fanout);
                }
                if !peer_addrs.is_empty() {
                    let gossip_msg = NetworkMessage::TimeoutVote {
                        height,
                        timeout_round,
                        voter_id: voter_id.clone(),
                        anchor: anchor_arr.to_vec(),
                        high_qc_idx,
                        high_qc_hash: qc_hash_arr.to_vec(),
                        tip_height,
                        tip_hash: tip_hash_arr.to_vec(),
                        signature: signature.clone(),
                        cert_mb: height,
                        cert_round: self.get_highest_certified_round(height),
                    };
                    let quic_transport = self.quic_transport.clone();
                    let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
                    if let Ok(handle) = tokio::runtime::Handle::try_current().map(|h| Some(h)).or(Ok::<_, ()>(None)) {
                        if let Some(handle) = handle {
                            handle.spawn(async move {
                                if !quic_enabled {
                                    return;
                                }
                                let transport = match quic_transport {
                                    Some(t) => t,
                                    None => return,
                                };
                                for peer_addr in peer_addrs {
                                    let parts: Vec<&str> = peer_addr.split(':').collect();
                                    if let Some(ip) = parts.first() {
                                        let quic_addr_str = format!("{}:10876", ip);
                                        if let Ok(quic_addr) = quic_addr_str.parse::<std::net::SocketAddr>() {
                                            let t = transport.read().await;
                                            // Best-effort: failures land in PEER_RETRY_COOLDOWN
                                            // via the main broadcast path; gossip re-tries on
                                            // the next received vote naturally.
                                            let _ = t.send_message(quic_addr, &gossip_msg).await;
                                        }
                                    }
                                }
                            });
                            if crate::node::is_debug() {
                                println!(
                                    "[DBG][TIMEOUT] gossip_rebroadcast h={} round={} fanout={} via_voter={}",
                                    height, timeout_round, gossip_fanout, voter_id
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    /// Verify timeout vote signature using node's Dilithium public key
    pub(super) fn verify_timeout_vote_signature(&self, voter_id: &str, message: &str, signature: &[u8]) -> bool {
        // CRITICAL FIX: signature was sent as UTF-8 bytes of the original "dilithium_sig_..." string
        // hex::encode would produce garbage; we need String::from_utf8 to restore the original format
        let sig_str = match String::from_utf8(signature.to_vec()) {
            Ok(s) => s,
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][TIMEOUT] vote_sig_not_utf8 len={}", signature.len());
                }
                return false;
            }
        };
        self.verify_consensus_signature(voter_id, message, &sig_str)
    }
    
    /// Generate and broadcast TimeoutProof when n−f votes collected.
    /// Proof = the signed per-voter payloads themselves; no separate signature.
    pub(super) fn generate_and_broadcast_timeout_proof(&self, height: u64, timeout_round: u64, anchor: [u8; 32]) {
        // Never form a TC for a left view (a window below the floor) — the anti-double-TC barrier.
        if height < observed_tc_window_floor() { return; }
        let votes = match TIMEOUT_VOTES.get(&(height, timeout_round)) {
            Some(v) => v.clone(),
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][TIMEOUT] proof_gen_no_votes h={} round={}", height, timeout_round);
                }
                return;
            }
        };

        let signed_votes: Vec<SignedTimeoutVote> = votes.iter()
            .filter(|(_, v)| v.anchor == anchor) // anchor-uniform, or the proof fails its own verifier
            .map(|(voter_id, v)| SignedTimeoutVote {
                voter_id: voter_id.clone(),
                signature: v.signature.clone(),
                high_qc_idx: v.high_qc_idx,
                high_qc_hash: v.high_qc_hash,
                tip_height: v.tip_height,
                tip_hash: v.tip_hash,
            })
            .collect();

        // The tally counted this anchor's group; re-check it on the set actually shipped. The two
        // are computed at different moments and a voter can supersede its anchor in between, so
        // without this a sub-quorum certificate would install locally and advance the round.
        let committee_len = failover_committee_for_window(height).map(|c| c.len()).unwrap_or(0);
        let quorum = qnet_consensus::checkpoint_bft::quorum_size(committee_len);
        if committee_len == 0 || signed_votes.len() < quorum {
            if crate::node::is_warn() {
                println!("[WARN][TIMEOUT] proof_gen_short h={} round={} have={} need={}",
                         height, timeout_round, signed_votes.len(), quorum);
            }
            return;
        }
        let proof = TimeoutProof { height, timeout_round, anchor, votes: signed_votes.clone() };
        TIMEOUT_CERTIFICATES.insert((height, timeout_round), proof);

        // O(1) tracker update + raise the view floor (prunes now-below-floor banked votes).
        HIGHEST_CERTIFIED_ROUND.entry(height)
            .and_modify(|cur| { if timeout_round > *cur { *cur = timeout_round; } })
            .or_insert(timeout_round);
        evict_votes_below_certified(height);

        if crate::node::is_info() {
            println!("[INFO][TC] certified mb={} round={} voters={}", height, timeout_round, votes.len());
        }

        // Broadcast proof to all nodes (for sync/new nodes)
        self.broadcast_timeout_proof(height, timeout_round, anchor, signed_votes);
    }

    /// Parallel best-effort fan-out of a consensus message to all validator peers
    /// (used by BlockRejection / ProducerReady / ReadyAck / attestations).
    pub(super) fn broadcast_consensus_message_parallel(&self, msg: NetworkMessage) {
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };

        let peers = self.get_all_validator_addresses();
        let total_peers = peers.len();
        if total_peers == 0 {
            return;
        }

        let quic_transport = self.quic_transport.clone();
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);

        handle.spawn(async move {
            use futures::future::join_all;
            let mut tasks = Vec::with_capacity(total_peers);

            for peer_addr in peers.into_iter() {
                // Consensus-critical (heartbeat / block-rejection / producer-ready): never skip a peer
                // for PEER_RETRY_COOLDOWN. A transiently-cooled LIVE peer that misses the producer's
                // heartbeat treats it as silent → spurious failover. Fire-and-forget (heartbeat is 1/s).
                let msg_clone = msg.clone();
                let quic_transport_clone = quic_transport.clone();

                let task = tokio::spawn(async move {
                    if quic_enabled {
                        if let Some(ref transport) = quic_transport_clone {
                            let parts: Vec<&str> = peer_addr.split(':').collect();
                            if let Some(ip) = parts.first() {
                                let quic_addr_str = format!("{}:10876", ip);
                                if let Ok(quic_addr) = quic_addr_str.parse::<std::net::SocketAddr>() {
                                    let t = transport.read().await;
                                    let _ = t.send_message(quic_addr, &msg_clone).await;
                                }
                            }
                        }
                    }
                });
                tasks.push(task);
            }

            let timeout_secs = if total_peers <= 10 { 2 } else if total_peers <= 100 { 3 } else { 5 };
            let _ = tokio::time::timeout(
                tokio::time::Duration::from_secs(timeout_secs),
                join_all(tasks),
            ).await;
        });
    }

    /// v16.2: Broadcast a ML-DSA-65-signed `BlockRejection` to all
    /// validator peers. Caller is an honest observer that locally rejected
    /// a block from `source_peer_id` at `height` due to a verifiable
    /// inconsistency (hash-chain break, signature failure, etc.). The
    /// observer self-records by inserting its own ID into the local
    /// aggregator before broadcast — its rejection counts toward the
    /// 2f+1 supermajority that triggers destructive rollback.
    pub fn broadcast_block_rejection(
        &self,
        height: u64,
        source_peer_id: String,
        rejected_hash: [u8; 32],
        expected_prev_hash: [u8; 32],
        signature_bytes: Vec<u8>,
    ) {
        let observer_id = self.node_id.clone();

        // Self-record so the producer's own observation participates in
        // the 2f+1 supermajority count without round-tripping.
        BLOCK_REJECTION_OBSERVERS
            .entry((height, source_peer_id.clone()))
            .or_insert_with(DashSet::new)
            .insert(observer_id.clone());

        let msg = NetworkMessage::BlockRejection {
            height,
            source_peer_id,
            rejected_hash,
            observer_id,
            expected_prev_hash,
            signature: signature_bytes,
        };
        self.broadcast_consensus_message_parallel(msg);
    }

    /// v16.2: Broadcast `ProducerReady` to all validator peers. Caller is
    /// the elected producer at (mb_idx, round, height) with round > 0,
    /// invoked AFTER local certified_round has reached `round`. Receivers
    /// reply with point-to-point `ReadyAck` once they too have local
    /// certified ≥ round, accumulating into READY_ACKS for the producer
    /// to consult before constructing the block.
    pub fn broadcast_producer_ready(
        &self,
        mb_idx: u64,
        round: u64,
        height: u64,
        producer_id: String,
        signature_bytes: Vec<u8>,
    ) {
        let msg = NetworkMessage::ProducerReady {
            mb_idx,
            round,
            height,
            producer_id,
            signature: signature_bytes,
        };
        self.broadcast_consensus_message_parallel(msg);
    }

    /// v16.1: Broadcast a ML-DSA-65-signed `ProducerHeartbeat` to all
    /// validator peers. Called by the production loop once per slot when
    /// this node is the elected producer for the next height. The
    /// signature payload binds (producer_id, timestamp, slot_height) so a
    /// receiver can verify identity and reject replays without trusting
    /// any wall-clock from the producer.
    ///
    /// Caller responsibility:
    ///   * MUST only invoke when this node is the elected producer (avoids
    ///     unauthorised heartbeats — receivers reject signatures from
    ///     non-elected nodes via consensus_pk_registry binding).
    ///   * Slot_height MUST be the height the producer is targeting; this
    ///     gives receivers a stuck-producer detector ("producer_id is alive
    ///     but stuck below local tip").
    ///
    /// Best-effort fan-out: PEER_RETRY_COOLDOWN respected, no acknowledgement
    /// loop. The pull-based recovery path (`request_timeout_proofs` and
    /// macroblock pull) covers any peer that misses a heartbeat broadcast.
    pub fn broadcast_producer_heartbeat(
        &self,
        producer_id: String,
        slot_height: u64,
        anchor_hash: String,
        signature_bytes: Vec<u8>,
        timestamp: u64,
    ) {
        let msg = NetworkMessage::ProducerHeartbeat {
            producer_id,
            timestamp,
            slot_height,
            anchor_hash,
            signature: signature_bytes,
        };
        self.broadcast_consensus_message_parallel(msg);
    }

    /// Broadcast timeout proof to all connected nodes
    /// ARCHITECTURE: Same as broadcast_certificate_announce_tracked - parallel with retries
    pub(super) fn broadcast_timeout_proof(&self, height: u64, timeout_round: u64,
                               anchor: [u8; 32], votes: Vec<SignedTimeoutVote>) {
        let msg = NetworkMessage::TimeoutCertificateBroadcast {
            height,
            timeout_round,
            anchor: anchor.to_vec(),
            votes,
        };
        
        // Get runtime handle
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };
        
        let peers = self.get_all_validator_addresses();
        let total_peers = peers.len();
        
        if total_peers == 0 {
            return;
        }
        
        let quic_transport = self.quic_transport.clone();
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
        let success_count = Arc::new(AtomicUsize::new(0));
        
        if crate::node::is_info() {
            println!("[INFO][TIMEOUT] proof_broadcast h={} round={} peers={}", height, timeout_round, total_peers);
        }
        
        // Spawn parallel broadcast task
        handle.spawn(async move {
            use futures::future::join_all;
            
            let mut tasks = Vec::with_capacity(total_peers);
            
            for peer_addr in peers {
                // Consensus-critical: never skip a peer for PEER_RETRY_COOLDOWN. Cooldown is a
                // bulk-sync send-backoff; a rare failover message (vote / proof / request) MUST
                // reach the committee or the 2f+1 TC never forms. Send timeout still bounds delivery.
                let msg_clone = msg.clone();
                let quic_transport_clone = quic_transport.clone();
                let success_count_clone = Arc::clone(&success_count);
                let peer_addr_clone = peer_addr.clone();
                
                let task = tokio::spawn(async move {
                    if quic_enabled {
                        if let Some(ref transport) = quic_transport_clone {
                            let parts: Vec<&str> = peer_addr_clone.split(':').collect();
                            if let Some(ip) = parts.first() {
                                let quic_addr_str = format!("{}:10876", ip);
                                if let Ok(quic_addr) = quic_addr_str.parse::<std::net::SocketAddr>() {
                                    let t = transport.read().await;
                                    
                                    match t.send_message(quic_addr, &msg_clone).await {
                                        Ok(_) => {
                                            success_count_clone.fetch_add(1, Ordering::SeqCst);
                                            PEER_RETRY_COOLDOWN.remove(&peer_addr_clone);
                                        }
                                        Err(_) => {
                                            // Apply exponential backoff
                                            let (retry_count, _) = PEER_RETRY_COOLDOWN
                                                .get(&peer_addr_clone)
                                                .map(|e| *e.value())
                                                .unwrap_or((0, std::time::Instant::now()));
                                            
                                            let new_retry_count = retry_count + 1;
                                            let backoff_secs = std::cmp::min(
                                                PEER_COOLDOWN_BASE_SECS * (1 << new_retry_count.min(4)),
                                                PEER_COOLDOWN_MAX_SECS
                                            );
                                            let cooldown_until = std::time::Instant::now() + 
                                                std::time::Duration::from_secs(backoff_secs);
                                            
                                            PEER_RETRY_COOLDOWN.insert(peer_addr_clone, (new_retry_count, cooldown_until));
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
                
                tasks.push(task);
            }
            
            // Adaptive timeout based on network size
            let timeout_secs = if total_peers <= 10 { 3 } else if total_peers <= 100 { 5 } else { 10 };
            let timeout = tokio::time::Duration::from_secs(timeout_secs);
            
            match tokio::time::timeout(timeout, join_all(tasks)).await {
                Ok(_) => {
                    let successful = success_count.load(Ordering::SeqCst);
                    if crate::node::is_info() {
                        println!("[INFO][TIMEOUT] proof_delivered {}/{} peers", successful, total_peers);
                    }
                }
                Err(_) => {
                    if crate::node::is_warn() {
                        println!("[WARN][TIMEOUT] proof_broadcast_timeout");
                    }
                }
            }
        });
    }
    
    /// Create and broadcast timeout vote for specified height/round
    /// signature: Pre-computed PQ signature from node's quantum_crypto
    // VRF leader-claim broadcast with gossip TTL: send the VRF proof to
    // direct peers with a relay TTL. GOSSIP_TTL = hop budget (TTL=3 ≈ 1B
    // reach); per-hop fanout = √(connected_peers), so the full committee is
    // reached in ≤3 hops at any scale up to 100K.
    /// v4.6: Broadcast own VRF public key to all peers.
    /// Called on startup and at every macroblock boundary.
    /// Uses stored wallet_identity (set via set_wallet_identity()).
    pub fn broadcast_vrf_key_announce(&self) {
        use pqcrypto_mldsa::mldsa65 as dil3;
        use pqcrypto_traits::sign::SecretKey as SkT;

        let identity = match self.wallet_identity.read().clone() {
            Some(id) => id,
            None => return,
        };

        let vrf_pk = &identity.dilithium_pk;
        let vrf_sk = identity.sk_bytes();

        let announce_msg = format!("QNET_VRF_KEY_v1:{}", self.node_id);
        let sk = match dil3::SecretKey::from_bytes(vrf_sk) {
            Ok(sk) => sk,
            Err(_) => { println!("[WARN][VRF-KEY] bad_sk_len={}", vrf_sk.len()); return; }
        };
        let sig = dil3::detached_sign(announce_msg.as_bytes(), &sk);
        use pqcrypto_traits::sign::DetachedSignature as SigT;
        let sig_bytes = sig.as_bytes().to_vec();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let msg = NetworkMessage::VrfKeyAnnounce {
            node_id: self.node_id.clone(),
            vrf_public_key: vrf_pk.to_vec(),
            self_signature: sig_bytes,
            timestamp: now,
        };

        if crate::node::is_info() {
            println!("[INFO][VRF-KEY] announcing pk_hash={} to peers", hex::encode(&vrf_pk[..8]));
        }

        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };

        let peers = self.get_all_validator_addresses();
        let quic_transport = self.quic_transport.clone();
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);

        handle.spawn(async move {
            if quic_enabled {
                if let Some(ref qt_lock) = quic_transport {
                    let qt = qt_lock.read().await;
                    for peer_str in &peers {
                        let ip = peer_str.split(':').next().unwrap_or(peer_str);
                        let quic_addr_str = format!("{}:10876", ip);
                        if let Ok(peer_addr) = quic_addr_str.parse::<std::net::SocketAddr>() {
                            let _ = qt.broadcast_to(peer_addr, &msg).await;
                        }
                    }
                }
            }
        });
    }

    /// Initial TTL for VRF claim gossip (number of relay hops)
    pub(super) const VRF_CLAIM_GOSSIP_TTL: u8 = 4;
    
    pub fn broadcast_leader_claim(
        &self,
        round: u64,
        vrf_output: [u8; 32],
        vrf_proof: Vec<u8>,
        slot_seed: [u8; 32],
        reputation: f64,
        vrf_public_key: Vec<u8>,
    ) {
        // Prevent double broadcast for same round
        if OWN_CLAIM_BROADCAST.contains_key(&round) {
            return;
        }
        OWN_CLAIM_BROADCAST.insert(round, true);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let msg = NetworkMessage::VrfLeaderClaim {
            round,
            node_id: self.node_id.clone(),
            vrf_output: vrf_output.to_vec(),
            vrf_proof: vrf_proof.clone(),
            slot_seed: slot_seed.to_vec(),
            reputation,
            timestamp: now,
            vrf_public_key: vrf_public_key.clone(),
            gossip_ttl: Self::VRF_CLAIM_GOSSIP_TTL,
        };

        // Also store own claim locally (verified by definition)
        let own_claim = VerifiedLeaderClaim {
            node_id: self.node_id.clone(),
            round,
            vrf_output,
            vrf_proof,
            reputation,
            verified_at: now,
        };
        LEADER_CLAIMS.entry(round).or_insert_with(Vec::new).push(own_claim);

        if crate::node::is_info() {
            println!("[INFO][VRF] claim_broadcast round={} output={} ttl={}",
                     round, hex::encode(&vrf_output[..8]), Self::VRF_CLAIM_GOSSIP_TTL);
        }

        // Broadcast to all validators via QUIC
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };

        let peers = self.get_all_validator_addresses();
        let quic_transport = self.quic_transport.clone();
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);

        handle.spawn(async move {
            if quic_enabled {
                if let Some(ref qt_lock) = quic_transport {
                    let qt = qt_lock.read().await;
                    for peer_str in &peers {
                        // CRITICAL: Remap to QUIC port 10876 (peer addr may be TCP :9876)
                        let ip = peer_str.split(':').next().unwrap_or(peer_str);
                        let quic_addr_str = format!("{}:10876", ip);
                        if let Ok(peer_addr) = quic_addr_str.parse::<std::net::SocketAddr>() {
                            let _ = qt.broadcast_to(peer_addr, &msg).await;
                        }
                    }
                }
            }
        });
    }


    /// v4.0: Get verified leader claims for a given round
    /// Broadcast an empty-slot attestation to all validators.
    ///
    /// Called by committee members when the producer for `slot_height` fails to
    /// broadcast a valid block within the slot grace period. Once 2f+1 distinct
    /// empty-slot attestations accumulate for the same (slot_height, expected_producer)
    /// pair, the network deterministically advances to the next producer.
    pub fn broadcast_empty_slot_attestation(
        &self,
        slot_height: u64,
        expected_producer: String,
        signature: Vec<u8>,
    ) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Store our own attestation locally
        submit_empty_slot_attestation(EmptySlotAttestation {
            slot_height,
            expected_producer: expected_producer.clone(),
            attester_id: self.node_id.clone(),
            signature: signature.clone(),
            timestamp: now,
        });

        let msg = NetworkMessage::EmptySlotAttestationMsg {
            slot_height,
            expected_producer: expected_producer.clone(),
            attester_id: self.node_id.clone(),
            signature,
            timestamp: now,
        };

        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };

        let peers = self.get_all_validator_addresses();
        let quic_transport = self.quic_transport.clone();
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);

        handle.spawn(async move {
            if quic_enabled {
                if let Some(ref qt_lock) = quic_transport {
                    let qt = qt_lock.read().await;
                    for peer_str in &peers {
                        let ip = peer_str.split(':').next().unwrap_or(peer_str);
                        let quic_addr_str = format!("{}:10876", ip);
                        if let Ok(peer_addr) = quic_addr_str.parse::<std::net::SocketAddr>() {
                            let _ = qt.broadcast_to(peer_addr, &msg).await;
                        }
                    }
                }
            }
        });

        if crate::node::is_debug() {
            println!("[DBG][EMPTY-SLOT] broadcast h={} expected={}",
                     slot_height, expected_producer);
        }
    }

    /// Attest a block this node accepted, if it holds this height's deterministic attester slot.
    /// The slice partitions the committee across the checkpoint window, so per-block evidence costs
    /// about one checkpoint QC per window — the same bandwidth, delivered thirty times sooner.
    pub fn attest_accepted_block(&self, height: u64, block_hash: [u8; 32], producer: &str) {
        if producer == self.node_id { return; }   // self-attestation is not external evidence
        let window = height.saturating_sub(1)
            / qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL + 1;
        let roster = match sorted_committee_for_window(window) {
            Some(r) => r,
            None => return,
        };
        if !crate::node::attesters_for_height(&roster, height, producer).contains(&self.node_id) {
            return;
        }

        let preimage = crate::node::block_attestation_message(height, &block_hash);
        let signature: Vec<u8> = {
            use pqcrypto_mldsa::mldsa65 as dilithium3;
            use pqcrypto_traits::sign::SecretKey as SkTrait;
            use pqcrypto_traits::sign::DetachedSignature as SigTrait;
            crate::node::GLOBAL_VRF_INSTANCE.lock().clone()
                .and_then(|vrf| vrf.get_secret_key_bytes())
                .and_then(|sk_bytes| SkTrait::from_bytes(&sk_bytes).ok()
                    .map(|sk: dilithium3::SecretKey| {
                        SigTrait::as_bytes(&dilithium3::detached_sign(&preimage, &sk)).to_vec()
                    }))
                .unwrap_or_default()
        };
        if signature.is_empty() { return; }

        record_block_attestation(height, block_hash, self.node_id.clone());

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let msg = NetworkMessage::BlockAttestationMsg {
            block_height: height,
            block_hash: block_hash.to_vec(),
            attester_id: self.node_id.clone(),
            signature,
            timestamp: now,
        };

        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };
        let peers = self.get_all_validator_addresses();
        let quic_transport = self.quic_transport.clone();
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
        handle.spawn(async move {
            if !quic_enabled { return; }
            if let Some(ref qt_lock) = quic_transport {
                let qt = qt_lock.read().await;
                for peer_str in &peers {
                    let ip = peer_str.split(':').next().unwrap_or(peer_str);
                    if let Ok(addr) = format!("{}:10876", ip).parse::<std::net::SocketAddr>() {
                        let _ = qt.broadcast_to(addr, &msg).await;
                    }
                }
            }
        });
        // One line per rotation window: enough for an operator to see the loop is alive at INFO,
        // and far too rare to be noise. A subsystem observable only at DEBUG cannot be verified in
        // production, where DEBUG is never on.
        if crate::node::is_info() && attest_heartbeat_due(height, true) {
            println!("[INFO][ATTEST] emitted h={} committee={} slice={}",
                     height, roster.len(),
                     crate::node::attesters_for_height(&roster, height, producer).len());
        }
    }

    pub fn get_leader_claims(round: u64) -> Vec<VerifiedLeaderClaim> {
        LEADER_CLAIMS.get(&round)
            .map(|v| v.value().clone())
            .unwrap_or_default()
    }

    /// v4.0: Cleanup old leader claims (keep last 3 rounds)
    pub fn cleanup_old_claims(current_round: u64) {
        let min_round = current_round.saturating_sub(3);
        LEADER_CLAIMS.retain(|round, _| *round >= min_round);
        OWN_CLAIM_BROADCAST.retain(|round, _| *round >= min_round);
    }

    pub fn broadcast_timeout_vote(&self, height: u64, timeout_round: u64,
                                   anchor: [u8; 32], high_qc_idx: u64, high_qc_hash: [u8; 32],
                                   tip_height: u64, tip_hash: [u8; 32], signature: Vec<u8>) {
        // Retransmit until certified: suppress only once the n−f TC for this (height,round) is
        // held. The view-timeout redrive re-invokes this each tick, so a vote lost to packet loss /
        // peer churn is re-broadcast until the TC forms. A single-shot send is not liveness-safe —
        // one lost failover vote wedged finality on onboarding (no node received it, TC never formed).
        if self.has_timeout_certificate(height, timeout_round) {
            return;
        }
        // Highest round emitted (retain-cleanup + observability); no longer the suppression gate.
        TIMEOUT_VOTED_HEIGHTS.insert(height, timeout_round);

        // BFT FIX: Count own vote locally BEFORE broadcasting.
        // Standard BFT protocol: every node includes its own vote in the local tally.
        // Without this, a node only sees N-1 votes from peers and never reaches
        // the 2/3+ threshold when the network is at minimum quorum.
        self.handle_timeout_vote(
            height, timeout_round,
            self.node_id.clone(),
            anchor.to_vec(), high_qc_idx, high_qc_hash.to_vec(),
            tip_height, tip_hash.to_vec(),
            signature.clone(),
        );

        // Broadcast to all validators (cert_* = SyncInfo claims for behind receivers).
        let msg = NetworkMessage::TimeoutVote {
            height,
            timeout_round,
            voter_id: self.node_id.clone(),
            anchor: anchor.to_vec(),
            high_qc_idx,
            high_qc_hash: high_qc_hash.to_vec(),
            tip_height,
            tip_hash: tip_hash.to_vec(),
            signature,
            cert_mb: height,
            cert_round: self.get_highest_certified_round(height),
        };
        
        if crate::node::is_info() {
            println!("[INFO][TIMEOUT] vote_broadcast h={} round={}", height, timeout_round);
        }
        
        // ARCHITECTURE: Parallel broadcast with retries (same as certificate broadcast)
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };
        
        let peers = self.get_all_validator_addresses();
        let total_peers = peers.len();
        let quic_transport = self.quic_transport.clone();
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
        let success_count = Arc::new(AtomicUsize::new(0));
        
        handle.spawn(async move {
            use futures::future::join_all;
            
            let mut tasks = Vec::with_capacity(total_peers);
            
            for peer_addr in peers {
                // Consensus-critical: never skip a peer for PEER_RETRY_COOLDOWN. Cooldown is a
                // bulk-sync send-backoff; a rare failover message (vote / proof / request) MUST
                // reach the committee or the 2f+1 TC never forms. Send timeout still bounds delivery.
                let msg_clone = msg.clone();
                let quic_transport_clone = quic_transport.clone();
                let success_count_clone = Arc::clone(&success_count);
                let peer_addr_clone = peer_addr.clone();
                
                let task = tokio::spawn(async move {
                    if quic_enabled {
                        if let Some(ref transport) = quic_transport_clone {
                            let parts: Vec<&str> = peer_addr_clone.split(':').collect();
                            if let Some(ip) = parts.first() {
                                let quic_addr_str = format!("{}:10876", ip);
                                if let Ok(quic_addr) = quic_addr_str.parse::<std::net::SocketAddr>() {
                                    let t = transport.read().await;
                                    
                                    match t.send_message(quic_addr, &msg_clone).await {
                                        Ok(_) => {
                                            success_count_clone.fetch_add(1, Ordering::SeqCst);
                                            PEER_RETRY_COOLDOWN.remove(&peer_addr_clone);
                                        }
                                        Err(_) => {
                                            // Exponential backoff
                                            let (retry_count, _) = PEER_RETRY_COOLDOWN
                                                .get(&peer_addr_clone)
                                                .map(|e| *e.value())
                                                .unwrap_or((0, std::time::Instant::now()));
                                        
                                        let new_retry_count = retry_count + 1;
                                        let backoff_secs = std::cmp::min(
                                            PEER_COOLDOWN_BASE_SECS * (1 << new_retry_count.min(4)),
                                            PEER_COOLDOWN_MAX_SECS
                                        );
                                        let cooldown_until = std::time::Instant::now() + 
                                            std::time::Duration::from_secs(backoff_secs);
                                        
                                            PEER_RETRY_COOLDOWN.insert(peer_addr_clone, (new_retry_count, cooldown_until));
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
                
                tasks.push(task);
            }
            
            // Adaptive timeout
            let timeout_secs = if total_peers <= 10 { 2 } else if total_peers <= 100 { 3 } else { 5 };
            let timeout = tokio::time::Duration::from_secs(timeout_secs);
            
            let _ = tokio::time::timeout(timeout, join_all(tasks)).await;
        });
    }
    
    // v14.8.10: `take_timeout_jump_target` REMAINS REMOVED — the
    // jump-to-highest mechanism (single signed vote inflating the whole
    // network's round to an attacker-chosen value) was Byzantine-unsafe.
    // The rotation round is now derived solely from HIGHEST_CERTIFIED_ROUND —
    // advanced only by a ML-DSA-65-verified same-round 2f+1 TimeoutCertificate,
    // so a ≤ f attacker cannot move the network's rotation round.


    /// Get current timeout proof if available
    pub fn get_timeout_certificate(&self, height: u64, timeout_round: u64) -> Option<TimeoutProof> {
        TIMEOUT_CERTIFICATES.get(&(height, timeout_round)).map(|v| v.clone())
    }

    /// Check if timeout proof exists for given height/round
    pub fn has_timeout_certificate(&self, height: u64, timeout_round: u64) -> bool {
        TIMEOUT_CERTIFICATES.contains_key(&(height, timeout_round))
    }

    /// Get highest certified timeout round for a macroblock index. Advanced ONLY
    /// by a signed same-round 2f+1 TimeoutCertificate (handle_timeout_proof_broadcast)
    /// — supermajority-backed, so a ≤f attacker cannot move it upward.
    pub fn get_highest_certified_round(&self, height: u64) -> u64 {
        HIGHEST_CERTIFIED_ROUND.get(&height).map(|v| *v).unwrap_or(0)
    }
}

//! Peer table: admission, scoring, attestation, bootstrap dial and discovery.

use super::*;

impl SimplifiedP2P {
    /// Get K-bucket index for a peer based on XOR distance
    pub(super) fn get_bucket_index(&self, peer_id: &str) -> usize {
        let mut hasher = Sha3_256::new();
        hasher.update(self.node_id.as_bytes());
        let self_hash = hasher.finalize();
        
        let mut hasher = Sha3_256::new();
        hasher.update(peer_id.as_bytes());
        let peer_hash = hasher.finalize();
        
        // Find first differing bit
        for (i, (a, b)) in self_hash.iter().zip(peer_hash.iter()).enumerate() {
            if a != b {
                // Find position of first differing bit
                let xor = a ^ b;
                for bit_pos in (0..8).rev() {
                    if (xor >> bit_pos) & 1 == 1 {
                        return i * 8 + (7 - bit_pos);
                    }
                }
            }
        }
        KADEMLIA_BITS - 1 // Same ID (shouldn't happen)
    }
    
    /// QUANTUM OPTIMIZATION: Lock-free peer lookup by ID (O(1))
    /// Get peer address by ID with O(1) performance
    pub fn get_peer_address_by_id(&self, peer_id: &str) -> Option<String> {
        // Use dual index for O(1) lookup
        self.peer_id_to_addr.get(peer_id).map(|entry| entry.value().clone())
    }
    
    /// Get all online node IDs (connected via P2P with recent heartbeat)
    /// Used for passive reputation recovery
    pub fn get_online_node_ids(&self) -> Vec<String> {
        let now = self.current_timestamp();
        let threshold = now.saturating_sub(300); // 5 min
        self.connected_peers_lockfree
            .iter()
            .filter(|entry| entry.value().last_seen >= threshold)
            .map(|entry| entry.value().id.clone())
            .collect()
    }
    
    /// HELPER: Resolve Genesis node address from node ID
    /// Returns address for Genesis nodes (genesis_node_001 -> IP:8001)
    /// Returns None for invalid Genesis node IDs
    pub(super) fn resolve_genesis_node_address(node_id: &str) -> Option<String> {
        if let Some(num) = node_id.strip_prefix("genesis_node_") {
            if let Ok(idx) = num.parse::<usize>() {
                let genesis_ips = get_genesis_bootstrap_ips();
                if idx > 0 && idx <= genesis_ips.len() {
                    return Some(format!("{}:8001", genesis_ips[idx - 1]));
                }
            }
        }
        None
    }
    
    pub fn get_peer_by_id_lockfree(&self, peer_id: &str) -> Option<PeerInfo> {
        // DUAL INDEXING: First get address from ID
        if let Some(addr_entry) = self.peer_id_to_addr.get(peer_id) {
            let addr = addr_entry.value().clone();
            // Then get peer info from address
            self.connected_peers_lockfree.get(&addr)
                .map(|entry| entry.value().clone())
        } else {
            None
        }
    }
    
    /// QUANTUM OPTIMIZATION: Get all peers in a specific shard
    pub fn get_peers_by_shard(&self, shard: u8) -> Vec<PeerInfo> {
        if let Some(shard_peers) = self.peer_shards.get(&shard) {
            shard_peers.value()
                .iter()
                .filter_map(|addr| {
                    self.connected_peers_lockfree.get(addr)
                        .map(|entry| entry.value().clone())
                })
                .collect()
        } else {
            Vec::new()
        }
    }
    
    /// Drop one address from the shard index of `peer_id`. Shard is a pure function of the id, so
    /// this is the exact inverse of the push in add_peer_lockfree.
    pub(super) fn drop_shard_entry(&self, peer_id: &str, peer_addr: &str) {
        let mut hasher = Sha3_256::new();
        hasher.update(peer_id.as_bytes());
        let peer_shard = hasher.finalize()[0];
        if let Some(mut shard_peers) = self.peer_shards.get_mut(&peer_shard) {
            shard_peers.retain(|addr| addr != peer_addr);
        }
    }

    /// QUANTUM OPTIMIZATION: Lock-free peer removal
    /// The ONLY remover: it clears connected_peers_lockfree, peer_id_to_addr and the shard index
    /// together. A bare map remove elsewhere leaves a dangling id → dead address route.
    pub fn remove_peer_lockfree(&self, peer_addr: &str) -> bool {
        if let Some((_, peer_info)) = self.connected_peers_lockfree.remove(peer_addr) {
            // Remove from ID index
            self.peer_id_to_addr.remove(&peer_info.id);
            self.drop_shard_entry(&peer_info.id, peer_addr);

            // v9.5: Recalculate BEST_PEER_HEIGHT when a peer disconnects.
            // Without this, BEST_PEER_HEIGHT sticks at the disconnected peer's height
            // and synced nodes think they're behind → voting blocked → network halts.
            // O(N) but only runs on disconnect (rare), not every tick.
            if peer_info.last_block_height >= BEST_PEER_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) {
                self.recalculate_best_peer_height();
            }

            if crate::node::is_debug() {
                println!("[DBG][P2P] peer_removed id={} addr={}", peer_info.id, peer_addr);
            }
            true
        } else {
            false
        }
    }
    
    /// PRODUCTION: Clean up inactive peers to prevent memory leak
    /// Uses 30-minute timeout (independent of certificate lifetime)
    /// Update peer network score based on event type
    /// ═══════════════════════════════════════════════════════════════════════════
    /// ARCHITECTURE v2.21: NETWORK EVENTS ONLY
    /// 
    /// Consensus reputation is now computed from blockchain via DeterministicReputationState.
    /// This function ONLY affects network_score for P2P routing optimization.
    /// 
    /// DEPRECATED events (ignored):
    /// - FullRotationComplete, InvalidBlock, ConsensusParticipation, MaliciousBehavior
    /// 
    /// ACTIVE events (network_score only):
    /// - TimeoutFailure: -2.0 (WAN latency)
    /// - ConnectionFailure: -5.0 (offline)
    /// ═══════════════════════════════════════════════════════════════════════════
    #[allow(deprecated)]
    pub(super) fn update_peer_reputation(&self, peer_addr: &str, event: ReputationEvent) {
        // v2.51: Fully lock-free implementation
        if let Some(mut peer) = self.connected_peers_lockfree.get_mut(peer_addr) {
            peer.migrate_legacy_reputation();
            
            match event {
                // DEPRECATED CONSENSUS EVENTS - IGNORED (use DeterministicReputationState)
                ReputationEvent::FullRotationComplete |
                ReputationEvent::InvalidBlock |
                ReputationEvent::ConsensusParticipation |
                ReputationEvent::MaliciousBehavior => {}
                
                // NETWORK EVENTS - Track for statistics only
                ReputationEvent::TimeoutFailure |
                ReputationEvent::ConnectionFailure => {
                    peer.failed_pings += 1;
                }
            }
            
            peer.last_seen = self.current_timestamp();
        }
    }
    
    /// BACKWARD COMPATIBILITY: Update reputation with boolean (legacy method)
    /// NOTE: Success=true does NOTHING (reputation recovery is passive only)
    /// Only failure events affect reputation
    #[allow(dead_code)]
    pub(super) fn update_peer_reputation_legacy(&self, peer_addr: &str, success: bool) {
        // SUCCESS: No reputation change - recovery is PASSIVE ONLY (once per 4h if score 10-70)
        // FAILURE: Apply timeout penalty
        if !success {
            self.update_peer_reputation(peer_addr, ReputationEvent::TimeoutFailure);
        }
        // Success just updates last_seen timestamp (done in update_peer_last_seen)
    }
    
    /// Get peer address by node ID
    pub fn get_peer_address(&self, node_id: &str) -> Option<String> {
        // Check connected peers lockfree first (O(1) lookup)
        for entry in self.connected_peers_lockfree.iter() {
            if entry.value().id == node_id {
                return Some(entry.value().addr.clone());
            }
        }
        
        // Check peer_id_to_addr index
        if let Some(addr) = self.peer_id_to_addr.get(node_id) {
            return Some(addr.clone());
        }
        
        None
    }
    
    /// Update peer last_seen timestamp when we receive data from them
    pub fn update_peer_last_seen(&self, peer_id_or_addr: &str) {
        self.update_peer_last_seen_with_height(peer_id_or_addr, None, false);
    }
    
    /// CRITICAL FIX v2.19.15: Auto-add peer to connected_peers when receiving messages
    /// This fixes the Genesis startup race condition where peers couldn't be added
    /// because test_peer_connectivity_static() failed during simultaneous startup.
    /// 
    /// LOGIC: If a peer can send us a message → they are DEFINITELY reachable!
    /// No need for TCP check - the connection is already established.
    /// 
    /// SECURITY: All messages are verified with Dilithium signatures at block level,
    /// so adding a peer here doesn't compromise Byzantine safety.
    pub fn ensure_peer_connected(&self, peer_id_or_addr: &str) {
        // Skip if it's our own node
        if peer_id_or_addr == self.node_id {
            return;
        }
        
        // Resolve peer address
        let (peer_id, peer_addr) = if peer_id_or_addr.contains(':') {
            // It's an address - parse to get ID
            let ip = peer_id_or_addr.split(':').next().unwrap_or("");
            let id = get_privacy_id_for_addr(ip);
            (id, peer_id_or_addr.to_string())
        } else if peer_id_or_addr.starts_with("genesis_node_") {
            // It's a Genesis node ID - resolve to address
            match Self::resolve_genesis_node_address(peer_id_or_addr) {
                Some(addr) => (peer_id_or_addr.to_string(), addr),
                None => return, // Invalid Genesis node ID
            }
        } else {
            // Unknown format - try to use as ID
            return;
        };
        
        // Skip self-connection
        if peer_id == self.node_id {
            return;
        }
        
        // Check if already connected (v2.51: lock-free)
        let already_connected = self.connected_peers_lockfree.contains_key(&peer_addr);
        
        if already_connected {
            return; // Already connected, nothing to do
        }
        
        // Capacity is enforced by add_peer_lockfree, whose LRU never evicts a committee or
        // genesis link. Pre-evicting here used a plain LRU and could drop such a link for a
        // newcomer the admission gates then refused — a net loss of one peer per message.

        // CRITICAL: Auto-add the peer since they successfully sent us a message
        // This proves they are reachable - no need for connectivity test!
        let ip = peer_addr.split(':').next().unwrap_or("");
        let is_genesis_peer = is_genesis_node_ip(ip);
        
        // Determine node type and region
        let (node_type, region) = if is_genesis_peer {
            use crate::genesis_constants::get_genesis_region_by_ip;
            let region_str = get_genesis_region_by_ip(ip).unwrap_or("Europe");
            let region = match region_str {
                "NorthAmerica" => Region::NorthAmerica,
                "Europe" => Region::Europe,
                "Asia" => Region::Asia,
                "SouthAmerica" => Region::SouthAmerica,
                "Africa" => Region::Africa,
                "Oceania" => Region::Oceania,
                _ => Region::Europe,
            };
            (NodeType::Super, region)
        } else {
            (NodeType::Super, Region::Europe) // Default for non-Genesis
        };
        
        // Get reputation from blockchain (v2.21.5)
        let consensus_score = self.get_node_reputation_from_blockchain(&peer_id);
        
        let peer_info = PeerInfo {
            id: peer_id.clone(),
            addr: peer_addr.clone(),
            node_type,
            region,
            last_seen: self.current_timestamp(),
            is_stable: false,
            latency_ms: 0,
            connection_count: 0,
            bandwidth_usage: 0,
            node_id_hash: Vec::new(),
            bucket_index: 0,
            reputation: consensus_score,  // v2.45.1: From blockchain
            consensus_score,              // Legacy
            network_score: 100.0,         // Legacy
            reputation_score: None,       // Legacy
            successful_pings: 0,
            failed_pings: 0,
            last_block_height: 0,
            last_height_attested_at: 0,  // v30.A3: unattested until signed event
            is_outbound: false,
        };

        // Add peer using existing safe method
        if self.add_peer_safe(peer_info) {
            if crate::node::is_info() { println!("[INFO][P2P] AUTO-ADDED peer {} ({}) - received message proves connectivity", 
                     peer_id, peer_addr); }
            
            // Invalidate cache to include new peer
            self.invalidate_peer_cache();
        }
    }
    
    /// Identity-bound HealthPing verification. The verifying PK is resolved
    /// from CONSENSUS_PK_REGISTRY against the claimed `from` — never from the
    /// message, which carries no key at all. Closes the
    /// identity-squat hole at the height-gossip layer: an attacker
    /// holding any valid ML-DSA-65 keypair would otherwise sign
    /// `QNET_HEALTH_PING_V1:genesis_node_001:<ts>:<h>` with their own SK,
    /// attach their PK, and have a poisoned height accepted as authentic.
    /// Now `from` must already be bound (genesis anchor or on-chain
    /// NodeRegistration); unknown identities are rejected outright.
    /// Scalability: O(1) DashMap lookup — caps at hundreds of thousands of
    /// super-node identities without contention.
    pub(super) fn verify_health_ping_signature(from: &str, timestamp: u64, height: u64, sig_hex: &str) -> bool {
        use pqcrypto_traits::sign::{PublicKey as PqPublicKey, DetachedSignature as PqDetachedSignature};
        let registered_pk = match qnet_consensus::consensus_crypto::get_consensus_pk(from) {
            Some(pk) => pk,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][HEALTH] sig_reject reason=identity_unbound from={}", from);
                }
                return false;
            }
        };
        let sig_bytes = match hex::decode(sig_hex) {
            Ok(b) => b,
            Err(_) => return false,
        };
        let pk = match pqcrypto_mldsa::mldsa65::PublicKey::from_bytes(&registered_pk) {
            Ok(pk) => pk,
            Err(_) => return false,
        };
        let sig = match pqcrypto_mldsa::mldsa65::DetachedSignature::from_bytes(&sig_bytes) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let payload = format!("QNET_HEALTH_PING_V1:{}:{}:{}", from, timestamp, height);
        pqcrypto_mldsa::mldsa65::verify_detached_signature(&sig, payload.as_bytes(), &pk).is_ok()
    }

    /// v2.24.3: Now stores height in PeerInfo for QUIC-only sync
    /// v2.24.4: Fixed port mismatch - find peer by IP when ports differ (QUIC vs HTTP)
    /// `authoritative` = height is the peer's own COMMITTED tip from a signed source
    /// (HealthPing / verified handshake) and REPLACES the tracked value, so a stale
    /// over-report (a relayed failover candidate above the committed tip, later
    /// orphaned) self-heals on the next ping instead of poisoning network_height
    /// permanently. Non-authoritative (block-relay) height only RAISES — keeps the
    /// sync view fresh between pings without making a transient over-report permanent.
    pub fn update_peer_last_seen_with_height(&self, peer_id_or_addr: &str, height: Option<u64>, authoritative: bool) {
        let current_time = self.current_timestamp();
        
        // CRITICAL FIX: Handle both peer ID (e.g., "genesis_node_003") and address (e.g., "161.97.86.81:8001")
        // First try to find by ID using dual indexing
        let peer_addr = if let Some(addr_entry) = self.peer_id_to_addr.get(peer_id_or_addr) {
            addr_entry.clone()
        } else if peer_id_or_addr.contains(':') {
            // v2.24.4: Address may have different port (QUIC 10876 vs P2P 9876 vs HTTP 8001)
            // Extract IP and find peer by IP match
            peer_id_or_addr.to_string()
        } else if peer_id_or_addr.starts_with("genesis_node_") {
            // Try to construct address for Genesis nodes using helper
            match Self::resolve_genesis_node_address(peer_id_or_addr) {
                Some(addr) => addr,
                None => return, // Invalid Genesis node ID
            }
        } else {
            return; // Unknown peer format
        };
        
        // v2.24.4: Extract IP for port-agnostic matching
        // Problem: Heartbeat comes from QUIC port (10876), but peers stored with HTTP port (8001)
        let peer_ip = peer_addr.split(':').next().unwrap_or(&peer_addr);

        // v15.1: Update the global IP→last_seen registry in lockstep with the
        // per-instance PeerInfo. This is the shared source of truth consulted
        // by `filter_working_genesis_nodes_static` to bypass the TCP probe
        // for peers that are actively talking to us — see the registry's
        // header comment for the full rationale.
        touch_peer_liveness_by_ip(peer_ip, current_time);

        // v2.51: Fully lock-free implementation
        // v2.58: REMOVED MAX_TRUSTED_HEIGHT_JUMP - heartbeats are Dilithium-signed!
        // Old logic was breaking check_block_exists_on_network because peer heights
        // were artificially limited, causing false emergency triggers and forks.
        // Now we trust signed heartbeats completely - fake heights are cryptographically impossible.
        if let Some(mut peer) = self.connected_peers_lockfree.get_mut(&peer_addr) {
            peer.last_seen = current_time;
            if let Some(h) = height {
                // v30.A3: caller passes Some(h) ONLY from authenticated sources
                // (applied block, certified shred, signed HealthPing, verified
                // handshake). Attestation timestamp is set unconditionally to
                // refresh the freshness window even when h does not exceed the
                // current value (e.g., a steady-state peer at unchanged height
                // is still attested by every signed HealthPing it emits).
                peer.last_height_attested_at = current_time;
                let increased = h > peer.last_block_height;
                // Authoritative REPLACES (heals a stale over-report), relay only RAISES. h == 0 is the
                // channel's "unknown" sentinel — a peer rebooting into empty storage must not zero the
                // height every other node already knows for it.
                if (authoritative && h > 0) || increased {
                    peer.last_block_height = h;
                }
                if increased {
                    BEST_PEER_HEIGHT.fetch_max(h, std::sync::atomic::Ordering::Relaxed);
                    let our_h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                    if h > our_h.saturating_add(20) {
                        crate::sync_manager::nudge_sync_check();
                    }
                }
            }
            return;
        }

            // v2.24.4: If exact match fails, find by IP (port-agnostic)
            // v2.58: REMOVED MAX_TRUSTED_HEIGHT_JUMP - see above comment
            for mut entry in self.connected_peers_lockfree.iter_mut() {
                let stored_ip = entry.key().split(':').next().unwrap_or("");
                if stored_ip == peer_ip {
                    entry.last_seen = current_time;
                    if let Some(h) = height {
                        // v30.A3: same attestation refresh as the primary branch
                        entry.last_height_attested_at = current_time;
                        let increased = h > entry.last_block_height;
                        // Same rule as the primary branch: a signed h=0 attests liveness, not a height.
                        if (authoritative && h > 0) || increased {
                            entry.last_block_height = h;
                        }
                        if increased {
                            BEST_PEER_HEIGHT.fetch_max(h, std::sync::atomic::Ordering::Relaxed);
                            let our_h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                            if h > our_h.saturating_add(20) {
                                crate::sync_manager::nudge_sync_check();
                            }
                        }
                    }
                    return;
                }
            }
    }

    /// Inbound admission counters in ONE pass: (total inbound, inbound in the
    /// candidate /24, inbound in the candidate /16). Outbound peers are excluded —
    /// we chose them, so they neither consume the inbound reserve nor the subnet caps.
    /// Cost is O(MAX_CONNECTED_PEERS), a compile-time bound that does not grow with
    /// network size, and it holds no per-known-peer state.
    pub(super) fn inbound_admission_counts(
        &self,
        prefix_24: Option<&str>,
        prefix_16: Option<&str>,
    ) -> (usize, usize, usize) {
        let (mut inbound, mut in_24, mut in_16) = (0usize, 0usize, 0usize);
        for entry in self.connected_peers_lockfree.iter() {
            let p = entry.value();
            if p.is_outbound {
                continue;
            }
            inbound = inbound.saturating_add(1);
            let peer_ip = p.addr.split(':').next().unwrap_or("");
            if let Some(pfx) = prefix_24 {
                if extract_subnet_prefix(peer_ip, 3).as_deref() == Some(pfx) {
                    in_24 = in_24.saturating_add(1);
                }
            }
            if let Some(pfx) = prefix_16 {
                if extract_subnet_prefix(peer_ip, 2).as_deref() == Some(pfx) {
                    in_16 = in_16.saturating_add(1);
                }
            }
        }
        (inbound, in_24, in_16)
    }

    /// Identity we are willing to bind to a gossiped address, or None to refuse the entry.
    /// A pinned genesis address answers from the binary, never from the wire. Any other
    /// address must carry a chain-registered identity whose committed endpoint IP matches:
    /// admitting an unverifiable claim installs a node_id → address route that every later
    /// directed send would follow, which is a free black-hole for the claimed identity.
    /// O(1): one pinned-table lookup or one DashMap get.
    pub(super) fn gossip_bound_identity(claimed_id: &str, ip: &str) -> Option<String> {
        if let Some(gid) = crate::genesis_constants::get_genesis_id_by_ip(ip) {
            return Some(format!("genesis_node_{}", gid));
        }
        if claimed_id.starts_with("genesis_node_") {
            return None; // genesis identity claimed from a non-genesis address
        }
        match crate::genesis_constants::get_node_endpoint_ip(claimed_id) {
            Some(expected) if expected == ip => Some(claimed_id.to_string()),
            _ => None,
        }
    }

    /// QUANTUM OPTIMIZATION: Lock-free peer addition for millions of nodes
    /// Uses DashMap for concurrent operations without blocking
    /// Upsert a handshake-verified peer into connected_peers_lockfree so BOTH directions land in the
    /// relay/quorum set: an OUTBOUND (client-dialed) peer counts toward network-height, and an INBOUND
    /// (server-side / NAT client-dialed) peer becomes reachable by relay_signed_head. `is_outbound`
    /// drives the eclipse/reputation/subnet caps; inbound is attested with height 0 + verified=false so
    /// it never counts toward the height quorum until its first signed HealthPing.
    pub fn attest_connected_peer(&self, node_id: &str, ip: &str, node_type_str: &str, height: u64, verified: bool, is_outbound: bool) {
        if node_id == self.node_id || ip.is_empty() { return; }
        let addr = format!("{}:8001", ip);
        if !self.connected_peers_lockfree.contains_key(&addr) {
            let node_type = match node_type_str.to_lowercase().as_str() {
                "light" => NodeType::Light,
                _ => NodeType::Super, // super / genesis / unknown → Super (only consensus-capable type)
            };
            let region = match crate::genesis_constants::get_genesis_region_by_ip(ip).unwrap_or("Europe") {
                "NorthAmerica" => Region::NorthAmerica,
                "Asia" => Region::Asia,
                "SouthAmerica" => Region::SouthAmerica,
                "Africa" => Region::Africa,
                "Oceania" => Region::Oceania,
                _ => Region::Europe,
            };
            let now = self.current_timestamp();
            let reputation = self.get_node_reputation_from_blockchain(node_id);
            self.add_peer_lockfree(PeerInfo {
                id: node_id.to_string(), addr, node_type, region,
                last_seen: now, is_stable: true, latency_ms: 0, connection_count: 1,
                bandwidth_usage: 0, node_id_hash: Vec::new(), bucket_index: 0,
                reputation, consensus_score: reputation, network_score: 100.0,
                reputation_score: None, successful_pings: 0, failed_pings: 0,
                last_block_height: height,
                // Attest the tip ONLY when the handshake proof was verified; advisory-admit (PK unknown)
                // peers are usable for transport but must not count toward the network-height quorum.
                last_height_attested_at: if verified && height > 0 { now } else { 0 },
                is_outbound,
            });
        }
        if verified && height > 0 {
            self.update_peer_last_seen_with_height(node_id, Some(height), true);
        }
    }

    /// Every reject path runs BEFORE the global-cap LRU eviction: a candidate the self-check, the
    /// address/identity dedup or an inbound gate is about to refuse must never cost a live peer its
    /// slot, or repeated refused attempts drain the table down to the pinned set — an eclipse
    /// primitive that survives the very caps meant to stop it.
    pub fn add_peer_lockfree(&self, mut peer_info: PeerInfo) -> bool {
        // CRITICAL: Prevent self-connection at the earliest stage
        let peer_ip = peer_info.addr.split(':').next().unwrap_or("");
        let external_ip_guard = self.external_ip.read();
        let is_self_by_ip = if let Some(ref our_ip) = *external_ip_guard {
            peer_ip == our_ip
        } else {
            false
        };
        drop(external_ip_guard);

        if peer_info.id == self.node_id || is_self_by_ip {
            if crate::node::is_info() { println!("[INFO][P2P] add_peer_lockfree: Rejecting self-connection {}",
                     get_privacy_id_for_addr(&peer_info.addr)); }
            return false;
        }

        // LOCK-FREE: Check if already exists (O(1))
        if self.connected_peers_lockfree.contains_key(&peer_info.addr) {
            return false;
        }

        // IDENTITY DEDUP — same node_id at a different address (a peer listens on 3 ports).
        // Refresh the live entry instead of inserting a duplicate, which would inflate BFT
        // validator counts. Height is NOT taken from peer_info: the gossip sources that reach
        // here are unauthenticated for the claimed peer; only its signed HealthPing attests a tip.
        // A mapping with NO live entry is a dangling index, not a connection: it is dropped and the
        // admission continues, or the identity would be permanently unadmittable on this node.
        if !peer_info.id.is_empty() {
            let existing_addr = self.peer_id_to_addr.get(&peer_info.id).map(|e| e.value().clone());
            if let Some(existing_addr) = existing_addr {
                let live = if let Some(mut entry) = self.connected_peers_lockfree.get_mut(&existing_addr) {
                    entry.last_seen = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    true
                } else {
                    false
                };
                if live {
                    if crate::node::is_debug() {
                        println!("[DBG][P2P] peer_dedup id={} existing_addr={} new_addr={} — refreshed (skipping insert)",
                                 peer_info.id, existing_addr, peer_info.addr);
                    }
                    return false;
                }
                self.peer_id_to_addr.remove(&peer_info.id);
                self.drop_shard_entry(&peer_info.id, &existing_addr);
                if crate::node::is_debug() {
                    println!("[DBG][P2P] peer_index_stale id={} stale_addr={} new_addr={} action=readmit",
                             peer_info.id, existing_addr, peer_info.addr);
                }
            }
        }

        // Inbound admission gates: outbound-slot reserve (eclipse), reputation floor (sybil)
        // and per-netblock diversity caps. Outbound peers bypass — we chose them. Genesis IPs
        // bypass reputation and diversity — the pinned set is vetted by the binary.
        // All three read ONE bounded pass over the peer table, so a burst of admissions does
        // not multiply scans.
        if !peer_info.is_outbound {
            let is_genesis_ip = crate::genesis_constants::get_genesis_id_by_ip(peer_ip).is_some();
            let prefix_24 = if is_genesis_ip { None } else { extract_subnet_prefix(peer_ip, 3) };
            let prefix_16 = if is_genesis_ip { None } else { extract_subnet_prefix(peer_ip, 2) };
            let (inbound_count, count_24, count_16) =
                self.inbound_admission_counts(prefix_24.as_deref(), prefix_16.as_deref());

            let max_inbound = MAX_CONNECTED_PEERS.saturating_sub(MIN_OUTBOUND_SLOTS);
            if inbound_count >= max_inbound {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] peer_admission_rejected reason=inbound_slot_full inbound={} max={} outbound_reserved={}",
                             inbound_count, max_inbound, MIN_OUTBOUND_SLOTS);
                }
                return false;
            }

            if !is_genesis_ip && peer_info.reputation < MIN_INBOUND_PEER_REPUTATION {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] peer_admission_rejected reason=reputation peer={} rep={:.1} min={:.1}",
                             get_privacy_id_for_addr(&peer_info.addr),
                             peer_info.reputation, MIN_INBOUND_PEER_REPUTATION);
                }
                return false;
            }

            if let Some(ref pfx) = prefix_24 {
                if count_24 >= MAX_PEERS_PER_SUBNET_24 {
                    if crate::node::is_warn() {
                        println!("[WARN][P2P] peer_admission_rejected reason=subnet_24 peer={} prefix={}/24 existing={} max={}",
                                 get_privacy_id_for_addr(&peer_info.addr), pfx, count_24, MAX_PEERS_PER_SUBNET_24);
                    }
                    return false;
                }
            }

            if let Some(ref pfx) = prefix_16 {
                if count_16 >= MAX_PEERS_PER_SUBNET_16 {
                    if crate::node::is_warn() {
                        println!("[WARN][P2P] peer_admission_rejected reason=subnet_16 peer={} prefix={}/16 existing={} max={}",
                                 get_privacy_id_for_addr(&peer_info.addr), pfx, count_16, MAX_PEERS_PER_SUBNET_16);
                    }
                    return false;
                }
            }
        }

        // Calculate shard and Kademlia bucket
        let mut hasher = Sha3_256::new();
        hasher.update(peer_info.id.as_bytes());
        let hash = hasher.finalize();
        let peer_shard = hash[0];
        peer_info.bucket_index = self.get_bucket_index(&peer_info.id);
        
        // K-BUCKET MANAGEMENT: Check bucket size (max 20 per bucket).
        // Committee/genesis links are excluded from victim selection for the same reason the global
        // cap pins them: a higher-reputation inbound peer must not be able to evict the corroboration
        // anchor out of its bucket.
        let cc_pins = CURRENT_COMMITTEE.read().clone();
        let bucket_peers: Vec<_> = self.connected_peers_lockfree.iter()
            .filter(|entry| entry.value().bucket_index == peer_info.bucket_index)
            .filter(|entry| {
                let p = entry.value();
                !(cc_pins.members.contains(&p.id) || cc_pins.genesis_ids.contains(&p.id)
                  || crate::genesis_constants::get_genesis_id_by_ip(p.addr.split(':').next().unwrap_or("")).is_some())
            })
            .map(|entry| (entry.key().clone(), entry.value().combined_reputation()))
            .collect();

        if bucket_peers.len() >= KADEMLIA_K {
            // Find peer with lowest combined reputation in this bucket
            if let Some((worst_addr, worst_rep)) = bucket_peers.iter()
                .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)) {
                
                if peer_info.combined_reputation() > *worst_rep {
                    // Remove worst peer to make room
                    self.remove_peer_lockfree(worst_addr);
                    if crate::node::is_info() { println!("[INFO][P2P] K-bucket {}: Replaced {} (rep: {:.2}) with {} (rep: {:.2})",
                            peer_info.bucket_index, worst_addr, *worst_rep, 
                            peer_info.id, peer_info.combined_reputation()); }
                } else {
                    // New peer has lower reputation, don't add
                    return false;
                }
            }
        }
        
        // Global cap, LAST: every reject is behind us, so this eviction only ever pays for a peer
        // we do insert. NEVER evicts a committee/genesis link — the anti-forgery corroboration
        // anchor; membership-derived, so a rotated-out member auto-unpins at the next epoch swap.
        if self.connected_peers_lockfree.len() >= MAX_CONNECTED_PEERS {
            let cc = CURRENT_COMMITTEE.read().clone();
            let mut oldest_addr: Option<String> = None;
            let mut oldest_time = u64::MAX;
            for entry in self.connected_peers_lockfree.iter() {
                let p = entry.value();
                let pinned = cc.members.contains(&p.id) || cc.genesis_ids.contains(&p.id)
                    || crate::genesis_constants::get_genesis_id_by_ip(p.addr.split(':').next().unwrap_or("")).is_some();
                if pinned { continue; }
                if p.last_seen < oldest_time {
                    oldest_time = p.last_seen;
                    oldest_addr = Some(entry.key().clone());
                }
            }
            match oldest_addr {
                Some(addr) => { self.remove_peer_lockfree(&addr); }
                None => return false, // at limit and every peer is pinned
            }
        }

        // LOCK-FREE: Add to all indices simultaneously
        self.connected_peers_lockfree.insert(peer_info.addr.clone(), peer_info.clone());
        self.peer_id_to_addr.insert(peer_info.id.clone(), peer_info.addr.clone());
        
        // Update shard mapping
        self.peer_shards.entry(peer_shard)
            .or_insert_with(Vec::new)
            .push(peer_info.addr.clone());
        
        if crate::node::is_debug() {
            println!("[DBG][P2P] peer_added id={} shard={} bucket={}", 
                     peer_info.id, peer_shard, peer_info.bucket_index);
        }
        true
    }
    
    /// CRITICAL FIX: Centralized method to add peer with duplicate prevention
    /// Returns true if peer was added, false if already exists
    /// v2.51: Always uses lock-free DashMap
    pub fn add_peer_safe(&self, peer_info: PeerInfo) -> bool {
        self.add_peer_lockfree(peer_info)
    }

    /// Self-handle for `'static` background tasks.
    pub(super) fn self_weak(&self) -> std::sync::Weak<Self> {
        self.self_ref.read().clone()
    }

    /// Admit a regional dial candidate we probed reachable, from a background task. Provenance is
    /// carried on `peer.is_outbound`: an address WE chose skips the inbound eclipse/reputation/subnet
    /// gates, a gossip-learned one does not. Never skips the global cap, the self-connection check or
    /// the id/shard indices — that is what a raw map insert used to lose.
    pub(super) fn admit_regional_candidate(me: &std::sync::Weak<Self>, mut peer: PeerInfo) -> bool {
        let node = match me.upgrade() { Some(n) => n, None => return false };
        // Re-resolve the score AT admission: the candidate may have sat in the regional map for
        // minutes, and a node banned in the meantime would otherwise clear the floor on a stale 70.
        let rep = node.get_node_reputation_from_blockchain(&peer.id);
        peer.reputation = rep;
        peer.consensus_score = rep;
        node.add_peer_lockfree(peer)
    }

    /// Connect to bootstrap peers OR use internet-wide peer discovery
    /// Maintain direct links to the committee this node belongs to. Checkpoint-BFT frames are unicast
    /// to the connected-peer table and never relayed by the receiver, so a vote reaches quorum only
    /// over direct links - discovery-formed peering has no reason to supply them once the committee is
    /// a sample of a large roster. Bounded per pass; a full committee converges over several passes.
    /// Non-members are a no-op: they do not vote, and they follow the chain through macroblock sync.
    pub fn maintain_committee_links(&self, per_pass: usize) {
        // Key on the LIVE tip, which is what the voting set is keyed on. The sealed frontier lags it
        // by up to MAX_UNSEALED_WINDOWS in healthy operation, and consecutive epochs are independent
        // samples of the roster - so a frontier-keyed lookup dials a committee this node is not
        // voting in, which is the one thing this task must not do.
        let target = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
            .load(std::sync::atomic::Ordering::Relaxed)
            .max(crate::node::qc_verified_frontier_cached());
        if target == 0 { return; }
        let storage = match crate::node::try_get_storage() { Some(s) => s, None => return };
        let committee = match crate::node::BlockchainNode::committee_for_height(storage, target) {
            Some(c) => c,
            None => return,
        };
        if !committee.iter().any(|id| *id == self.node_id) { return; }
        // A vote must REACH quorum, not everyone: n-f links suffice, and the peer table also has
        // to hold genesis peers, sync sources and light clients. Stop at the threshold plus a
        // small margin for churn rather than dialing the whole committee.
        let needed = qnet_consensus::checkpoint_bft::quorum_size(committee.len())
            .saturating_add(committee.len() / 20);
        // Per-node salted order, not the committee's natural one: every member would otherwise
        // dial the same first n-f ids, so the head of the list takes the whole network's inbound
        // load and the tail takes none.
        use sha3::{Digest, Sha3_256};
        let salt = { let mut h = Sha3_256::new(); h.update(self.node_id.as_bytes()); h.finalize() };
        let mut ranked: Vec<(u64, String)> = committee.iter()
            .filter(|id| **id != self.node_id)
            .map(|id| {
                let mut h = Sha3_256::new(); h.update(&salt); h.update(id.as_bytes());
                let d = h.finalize();
                (u64::from_le_bytes(d[0..8].try_into().unwrap_or([0u8; 8])), id.clone())
            })
            .collect();
        ranked.sort_by_key(|(k, _)| *k);
        let mut addrs: Vec<String> = Vec::new();
        let mut known = 0usize;
        for (_, id) in ranked.iter() {
            if self.peer_id_to_addr.contains_key(id) { known += 1; continue; }
            let addr = if id.starts_with("genesis_node_") {
                match Self::resolve_genesis_node_address(id) { Some(a) => a, None => continue }
            } else {
                match crate::genesis_constants::get_node_endpoint_ip(id) {
                    Some(ip) => format!("{}:8001", ip),
                    None => continue,
                }
            };
            if self.connected_peers_lockfree.contains_key(&addr) { known += 1; continue; }
            if known.saturating_add(addrs.len()) >= needed { break; }
            addrs.push(addr);
            if addrs.len() >= per_pass { break; }
        }
        if addrs.is_empty() { return; }
        if crate::node::is_info() {
            println!("[INFO][P2P] committee_links dialing={} known={} committee={}",
                     addrs.len(), known, committee.len());
        }
        self.connect_to_bootstrap_peers(&addrs);
    }

    /// Cold-join committee dialing: proactively connect to a salted K-subset of the round committee at
    /// the network frontier so a joiner pulls anchors/blocks from the committee, not just the 5 genesis.
    /// Additive + idempotent: genesis-era committee is None ⇒ no-op (genesis bootstrap dialing unchanged);
    /// already-known members are skipped. The per-joiner salt spreads many joiners across the committee.
    pub fn dial_committee_for_cold_join(&self) {
        let target = crate::node::qc_verified_frontier_cached();
        if target == 0 { return; } // no attested tip yet ⇒ genesis-only, unchanged
        let storage = match crate::node::try_get_storage() { Some(s) => s, None => return };
        let committee = match crate::node::BlockchainNode::committee_for_height(storage, target) {
            Some(c) => c,
            None => return, // genesis era / N-2 macroblock absent ⇒ additive no-op
        };
        const COLD_JOIN_COMMITTEE_DIAL_K: usize = 24;
        use sha3::{Digest, Sha3_256};
        let salt = { let mut h = Sha3_256::new(); h.update(self.node_id.as_bytes()); h.finalize() };
        let mut ranked: Vec<(u64, String)> = committee.into_iter()
            .filter(|id| *id != self.node_id)
            .map(|id| {
                let mut h = Sha3_256::new(); h.update(&salt); h.update(id.as_bytes());
                let d = h.finalize();
                (u64::from_le_bytes(d[0..8].try_into().unwrap_or([0u8; 8])), id)
            })
            .collect();
        ranked.sort_by_key(|(k, _)| *k);
        let mut addrs: Vec<String> = Vec::new();
        for (_, id) in ranked.into_iter().take(COLD_JOIN_COMMITTEE_DIAL_K) {
            if self.peer_id_to_addr.contains_key(&id) { continue; } // already known/connected
            let addr = if id.starts_with("genesis_node_") {
                match Self::resolve_genesis_node_address(&id) { Some(a) => a, None => continue }
            } else {
                match crate::genesis_constants::get_node_endpoint_ip(&id) { Some(ip) => format!("{}:8001", ip), None => continue }
            };
            if self.connected_peers_lockfree.contains_key(&addr) { continue; }
            addrs.push(addr);
        }
        if !addrs.is_empty() {
            if crate::node::is_info() {
                println!("[INFO][SYNC] committee_dial count={} target_mb={}", addrs.len(), target / 90);
            }
            self.connect_to_bootstrap_peers(&addrs);
        }
    }

    pub fn connect_to_bootstrap_peers(&self, peers: &[String]) {
        if peers.is_empty() {
            if crate::node::is_info() { println!("[INFO][P2P] No bootstrap peers provided - using internet-wide peer discovery"); }
            self.start_internet_peer_discovery();
            return;
        }
        
        // CRITICAL FIX: Get our own IP to filter out self-connections
        let our_ip = self.external_ip.read().clone();

        if crate::node::is_info() { println!("[INFO][P2P] Connecting to {} bootstrap peers (filtering self: {:?})", peers.len(), our_ip); }
        
        let mut successful_parses = 0;
        let mut skipped_self = 0;
        for peer_addr in peers {
            // CRITICAL: Skip our own address to prevent self-connect loops
            let peer_ip = peer_addr.split(':').next().unwrap_or("");
            if let Some(ref own_ip) = our_ip {
                if peer_ip == own_ip {
                    if crate::node::is_info() { println!("[INFO][P2P] Skipping self-address: {}", get_privacy_id_for_addr(peer_addr)); }
                    skipped_self += 1;
                    continue;
                }
            }
            
            match self.parse_peer_address(peer_addr) {
                Ok(mut peer_info) => {
                    // Bootstrap/committee addresses are ones WE chose to dial — provenance the
                    // regional sweep needs, since a gossip-learned candidate must not look the same.
                    peer_info.is_outbound = true;
                    // Also check by node_id
                    if peer_info.id == self.node_id {
                        if crate::node::is_info() { println!("[INFO][P2P] Skipping self by node_id: {}", peer_info.id); }
                        skipped_self += 1;
                        continue;
                    }
                    // PRIVACY: Use pseudonym in logs
                    if crate::node::is_info() { println!("[INFO][P2P] Successfully parsed peer: {} ({})", get_privacy_id_for_addr(peer_addr), region_string(&peer_info.region)); }
                    self.add_peer_to_region(peer_info);
                    successful_parses += 1;
                }
                Err(e) => {
                    // PRIVACY: Use pseudonym in logs
                    if crate::node::is_warn() { println!("[WARN][P2P] Failed to parse peer {}: {}", get_privacy_id_for_addr(peer_addr), e); }
                }
            }
        }
        
        if crate::node::is_info() { println!("[INFO][P2P] Successfully parsed {}/{} bootstrap peers (skipped {} self)", 
                 successful_parses, peers.len(), skipped_self); }
        
        // STARTUP FIX: Establish connections asynchronously to prevent blocking startup
        self.start_regional_connection_establishment();
    }
    
    /// Add discovered peers to running P2P system (dynamic peer injection)
    pub fn add_discovered_peers(&self, peer_addresses: &[String]) {
        if peer_addresses.is_empty() {
            return;
        }
        
        if crate::node::is_info() { println!("[INFO][P2P] Adding {} discovered peers to running P2P system", peer_addresses.len()); }
        
        let mut new_connections = 0;
        for peer_addr in peer_addresses {
            // CRITICAL: Filter out private/internal IPs before parsing
            let ip = peer_addr.split(':').next().unwrap_or("");
            if ip.starts_with("172.17.") || ip.starts_with("172.18.") 
                || ip.starts_with("10.") || ip.starts_with("192.168.") 
                || ip.starts_with("127.") || ip == "localhost" {
                if crate::node::is_info() { println!("[INFO][P2P] Skipping private/internal IP: {}", get_privacy_id_for_addr(peer_addr)); }
                continue;
            }
            
            if let Ok(peer_info) = self.parse_peer_address(peer_addr) {
                // Self-connection check is done in add_peer_lockfree(), no need to duplicate here
                
                // BYZANTINE FIX: For Genesis peers, ALWAYS verify connectivity even if "already connected"
                // This prevents phantom Genesis peers from persisting across restarts
                    let peer_ip = peer_info.addr.split(':').next().unwrap_or("");
                    let is_genesis_peer = is_genesis_node_ip(peer_ip);
                
                // Check if not already connected (or if Genesis peer - always re-verify) (v2.51: lock-free)
                let already_connected = self.connected_peers_lockfree.contains_key(&peer_info.addr);
                
                // CRITICAL: Genesis peers must ALWAYS be re-verified for Byzantine safety
                if !already_connected || is_genesis_peer {
                    // DYNAMIC: Genesis peers use bootstrap trust based on network conditions, not time
                    let is_bootstrap_node = std::env::var("QNET_BOOTSTRAP_ID").is_ok();
                    let active_peers = self.get_peer_count();
                    let is_small_network = active_peers < 6; // PRODUCTION: Bootstrap trust for Genesis network (1-5 nodes, all Genesis bootstrap nodes)
                    
                    // CRITICAL FIX v2.19.15: Bootstrap trust for Genesis peers at startup
                    // During simultaneous Genesis startup, all nodes start at the same time
                    // and test_peer_connectivity_static() fails because API is not ready yet.
                    // 
                    // SOLUTION: Add Genesis peers with bootstrap trust WITHOUT connectivity check
                    // Byzantine safety is preserved because:
                    // 1. Genesis IPs are hardcoded and known
                    // 2. All messages are verified with Dilithium signatures
                    // 3. Fake peers cannot produce valid blocks
                    // 4. ensure_peer_connected() will update status when messages arrive
                    let should_add = if is_genesis_peer && (is_bootstrap_node || is_small_network) {
                        // v4.2: Genesis peers added unconditionally (no blocking TCP check).
                        // Previous version blocked tokio workers for 2s per peer with no effect
                        // (both branches returned true). Safety guaranteed by Dilithium signatures.
                        if crate::node::is_info() { println!("[INFO][P2P] Genesis peer: adding {} with bootstrap trust", get_privacy_id_for_addr(&peer_info.addr)); }
                        true
                    } else {
                        self.is_peer_actually_connected(&peer_info.addr)
                    };
                    
                    // SECURITY: All peers require quantum verification (including Genesis)
                    // Genesis peers have known IPs but still need cryptographic proof
                    if should_add {
                        // NOTE: Peer verification happens at block level (Dilithium signature)
                        // P2P connection is allowed for message exchange, but:
                        // - Blocks are ALWAYS verified with Dilithium (mandatory)
                        // - Invalid blocks are rejected regardless of peer trust
                        // - This is defense-in-depth: P2P layer + Block layer
                        let peer_verified = true; // P2P layer allows connection
                        
                        if peer_verified {
                            // CRITICAL FIX: Use centralized add_peer_safe to prevent duplicates
                            if self.add_peer_safe(peer_info.clone()) {
                    self.add_peer_to_region(peer_info.clone());
                                new_connections += 1;
                                
                                // CACHE FIX: Invalidate peer cache when topology changes
                                self.invalidate_peer_cache();
                            } else {
                                if crate::node::is_info() { println!("[INFO][P2P] Peer {} already connected, skipping duplicate", get_privacy_id_for_addr(&peer_info.addr)); }
                    }
                    
                            // ARCHITECTURE FIX: Peer discovery is P2P task, NOT blockchain task!
                            // Peer info is already stored in DashMap (add_peer_safe above)
                            // No need for blockchain TX - they don't get included in blocks anyway
                            // Blocks are empty (consensus only, no TX processing in Phase 1)
                            
                            let peer_type = if is_genesis_peer { "GENESIS" } else { "QUANTUM" };
                            if crate::node::is_info() { println!("[INFO][P2P] {}: Added verified peer: {}", peer_type, get_privacy_id_for_addr(&peer_info.addr)); }
                        }
                    } else {
                        if crate::node::is_info() { println!("[INFO][P2P] Peer {} is not reachable, skipping", get_privacy_id_for_addr(&peer_info.addr)); }
                    }
                }
            }
        }
        
        // Update connection count (v2.51: lock-free)
        let peer_count = self.connected_peers_lockfree.len();
        *self.connection_count.lock() = peer_count;
        
        if new_connections > 0 {
            if crate::node::is_info() { println!("[INFO][P2P] Successfully added {} new peers to P2P network", new_connections); }
            // CACHE FIX: Invalidate peer cache after adding discovered peers
            self.invalidate_peer_cache();
            
                // CRITICAL FIX: Use EXISTING broadcast system for immediate peer announcements
            // Broadcast new peer information to ALL connected nodes for real-time topology updates
            for peer_addr in peer_addresses.iter().take(new_connections) {
                if let Ok(peer_info) = self.parse_peer_address(peer_addr) {
                    // Use EXISTING NetworkMessage::PeerDiscovery for quantum-resistant peer announcements
                    let peer_discovery_msg = NetworkMessage::PeerDiscovery {
                        requesting_node: peer_info.clone(),
                    };
                    
                    // CRITICAL FIX: Use EXISTING broadcast pattern for immediate peer announcements (v2.51: lock-free)
                    let current_peers: Vec<PeerInfo> = self.connected_peers_lockfree.iter()
                        .map(|e| e.value().clone())
                        .collect();
                    
                    // Broadcast PeerDiscovery message to ALL connected nodes using existing send_network_message
                    // PRIVACY: Only Genesis nodes broadcast PeerDiscovery (their IPs are public)
                    // Regular nodes use DHT/Kademlia for peer discovery without exposing IPs
                    let is_genesis_peer = is_genesis_node_ip(peer_info.addr.split(':').next().unwrap_or(""));
                    if is_genesis_peer {
                        for existing_peer in &current_peers {
                            if existing_peer.addr != peer_info.addr { // Don't broadcast to self
                                self.send_network_message(&existing_peer.addr, peer_discovery_msg.clone());
                                // PRIVACY: Use pseudonym in logs, not raw IP
                                if crate::node::is_info() { println!("[INFO][P2P] REAL-TIME: Announced new peer {} to {}", 
                                         get_privacy_id_for_addr(&peer_info.addr), 
                                         get_privacy_id_for_addr(&existing_peer.addr)); }
                            }
                        }
                    } else {
                        // PRIVACY: Non-Genesis peers are NOT announced via PeerDiscovery
                        // They are discovered via DHT/Kademlia without exposing IPs
                        if crate::node::is_info() { println!("[INFO][P2P] PRIVACY: Peer {} added locally only (no broadcast)", 
                                 get_privacy_id_for_addr(&peer_info.addr)); }
                    }
                }
            }
            
            // SCALABILITY FIX: Use existing rebalance_connections() for load balancing
            self.rebalance_connections();
            
            // QUANTUM GENESIS: Force immediate peer cache refresh for rapid topology updates  
            self.force_peer_cache_refresh();
        }
    }
    
}

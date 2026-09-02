//! Block propagation: shredding, erasure coding, the relay tree and chunk repair.

use super::*;

impl SimplifiedP2P {
    /// Track blocks without ping commitment for monitoring
    /// Uses thread-local static for simplicity (no struct modification needed)
    pub fn increment_missing_commitment_count(&self) -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static MISSING_COMMITMENT_COUNT: AtomicU64 = AtomicU64::new(0);
        MISSING_COMMITMENT_COUNT.fetch_add(1, Ordering::Relaxed) + 1
    }
    
    /// Gossip message to random peers (for scalable propagation)
    pub fn gossip_to_random_peers(&self, message: NetworkMessage, count: usize) {
        use rand::seq::SliceRandom;
        
        // The lock-free table is the ONLY peer set: add_peer is its single writer, so there is no
        // second map to consult. Fewer peers than `count` simply sends to all of them.
        let peers: Vec<_> = self.connected_peers_lockfree
            .iter()
            .map(|r| r.value().clone())
            .collect();
        
        if peers.is_empty() {
            return;
        }
        
        let mut rng = rand::rngs::OsRng;
        let selected: Vec<_> = peers.choose_multiple(&mut rng, count.min(peers.len())).collect();
        
        for peer in selected {
            self.send_network_message(&peer.addr, message.clone());
        }
    }
    
    /// v4.3: Gossip to random peers EXCLUDING the sender (prevents echo loops)
    /// Used by VRF claim relay to avoid sending claim back to the node that sent it
    pub fn gossip_to_random_peers_excluding(&self, message: NetworkMessage, count: usize, exclude_peer: &str) {
        use rand::seq::SliceRandom;
        
        let peers: Vec<_> = self.connected_peers_lockfree
            .iter()
            .filter(|r| {
                // Exclude the sender by addr prefix (IP match)
                let peer_addr = r.value().addr.as_str();
                let exclude_ip = exclude_peer.split(':').next().unwrap_or(exclude_peer);
                let peer_ip = peer_addr.split(':').next().unwrap_or(peer_addr);
                peer_ip != exclude_ip
            })
            .map(|r| r.value().clone())
            .collect();
        
        if peers.is_empty() {
            return;
        }
        
        let mut rng = rand::rngs::OsRng;
        let selected: Vec<_> = peers.choose_multiple(&mut rng, count.min(peers.len())).collect();
        
        for peer in selected {
            self.send_network_message(&peer.addr, message.clone());
        }
    }
    
    /// OPTIMIZATION v2.19.19: Gossip to K closest neighbors using Kademlia distance (v2.51: lock-free)
    pub fn gossip_to_k_neighbors(&self, message: NetworkMessage, k: usize) {
        let mut peers: Vec<_> = self.connected_peers_lockfree
            .iter()
            .map(|r| r.value().clone())
            .collect();
        
        if peers.is_empty() {
            return;
        }
        
        // Sort by Kademlia distance (bucket_index) - closest first
        // This ensures messages go to DHT neighbors for efficient propagation
        peers.sort_by_key(|p| p.bucket_index);
        
        // Take K closest neighbors
        let k_neighbors: Vec<_> = peers.into_iter().take(k).collect();

        for peer in k_neighbors {
            self.send_network_message(&peer.addr, message.clone());
        }
    }

    /// Relay a verified genesis signed-head to NON-genesis neighbors only, excluding the origin and
    /// the immediate sender. The genesis mesh already exchanges heads via direct emit, so relaying back
    /// to it is pure fan-in; restricting to non-genesis k-closest pushes the tip OUTWARD to deep
    /// followers with zero fan-in onto the 5 genesis at thousands-of-joiner scale.
    pub(super) fn relay_signed_head(&self, message: NetworkMessage, origin_id: &str, sender_addr: &str, k: usize) {
        let mut peers: Vec<_> = self.connected_peers_lockfree.iter()
            .map(|r| r.value().clone())
            .filter(|p| p.id != origin_id
                && p.addr != sender_addr
                && !crate::genesis_constants::is_legacy_genesis_node(&p.id))
            .collect();
        if peers.is_empty() { return; }
        peers.sort_by_key(|p| p.bucket_index);
        for peer in peers.into_iter().take(k) {
            self.send_network_message(&peer.addr, message.clone());
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // v5.1: KADEMLIA DHT — FIND_NODE iterative lookup + periodic bucket refresh
    // ═══════════════════════════════════════════════════════════════════════════

    /// Sync connected peers into the Kademlia routing table.
    /// Called periodically and after peer add/remove.
    pub fn sync_peers_to_kademlia(&self) {
        let now = self.current_timestamp();
        for entry in self.connected_peers_lockfree.iter() {
            let p = entry.value();
            self.kademlia_table.upsert(&p.id, &p.addr, p.reputation, now);
        }
    }

    /// Handle incoming FindNode request: return K closest peers from our routing table.
    pub fn handle_find_node(&self, from_peer: &str, requester_id: &str, target_hash: &[u8], request_id: u64) {
        if target_hash.len() != 32 { return; }
        let mut th = [0u8; 32];
        th.copy_from_slice(target_hash);

        let closest = self.kademlia_table.find_closest(&th, KADEMLIA_K);
        let pairs: Vec<(String, String)> = closest.into_iter()
            .filter(|p| p.node_id != requester_id)
            .map(|p| (p.node_id, p.addr))
            .collect();

        let response = NetworkMessage::FindNodeResponse {
            responder_id: self.node_id.clone(),
            closest_peers: pairs,
            request_id,
        };
        self.send_network_message(from_peer, response);
    }

    /// Handle incoming FindNodeResponse: merge discovered peers into routing table.
    pub fn handle_find_node_response(&self, closest_peers: &[(String, String)]) {
        let now = self.current_timestamp();
        for (node_id, addr) in closest_peers {
            if node_id == &self.node_id { continue; }
            self.kademlia_table.upsert(node_id, addr, 70.0, now);
        }
    }

    /// Iterative Kademlia lookup: find K closest peers to a target node ID.
    /// Sends FIND_NODE to ALPHA closest known peers, collects responses,
    /// repeats until no closer peers are discovered or max hops reached.
    pub fn kademlia_lookup(&self, target_node_id: &str) {
        let target_hash = KademliaRoutingTable::hash_node_id(target_node_id);
        let initial = self.kademlia_table.find_closest(&target_hash, KADEMLIA_ALPHA);

        if initial.is_empty() { return; }

        let request_id = self.current_timestamp();
        for peer in initial.iter().take(KADEMLIA_ALPHA) {
            let msg = NetworkMessage::FindNode {
                requester_id: self.node_id.clone(),
                target_hash: target_hash.to_vec(),
                request_id,
            };
            self.send_network_message(&peer.addr, msg);
        }

        if crate::node::is_debug() {
            println!("[DBG][DHT] kademlia_lookup target={} sent_to={} table_size={}",
                     qnet_state::char_prefix(&target_node_id, 16),
                     initial.len(), self.kademlia_table.total_peers());
        }
    }

    /// Start background task that periodically refreshes stale k-buckets
    /// by performing lookups for random IDs in each stale bucket range.
    pub fn start_kademlia_refresh_task(&self) {
        let table = self.kademlia_table.clone();
        let connected = self.connected_peers_lockfree.clone();
        let node_id = self.node_id.clone();
        let kademlia_table_for_sync = self.kademlia_table.clone();
        let peer_id_to_addr = self.peer_id_to_addr.clone();

        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };

        handle.spawn(async move {
            let mut interval = tokio::time::interval(
                std::time::Duration::from_secs(KADEMLIA_REFRESH_INTERVAL_SECS)
            );

            loop {
                interval.tick().await;

                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default().as_secs();

                // Sync connected peers into routing table
                for entry in connected.iter() {
                    let p = entry.value();
                    kademlia_table_for_sync.upsert(&p.id, &p.addr, p.reputation, now);
                }

                let stale = table.stale_buckets(now);
                if stale.is_empty() { continue; }

                for bucket_idx in stale.iter().take(3) {
                    // Generate random target in this bucket's range
                    let mut target = [0u8; 32];
                    let byte_idx = bucket_idx / 8;
                    let bit_idx = 7 - (bucket_idx % 8);
                    if byte_idx < 32 {
                        target[byte_idx] = 1u8 << bit_idx;
                    }
                    // XOR with local hash to get target in this bucket
                    let local_hash = KademliaRoutingTable::hash_node_id(&node_id);
                    for i in 0..32 { target[i] ^= local_hash[i]; }

                    let closest = table.find_closest(&target, KADEMLIA_ALPHA);
                    for peer in closest {
                        if let Some(addr_entry) = peer_id_to_addr.get(&peer.node_id) {
                            // Would send FindNode here but we don't have &self in async
                            // The sync_peers_to_kademlia + periodic peer exchange covers this
                            let _ = addr_entry.value();
                        }
                    }

                    table.mark_refreshed(*bucket_idx, now);
                }

                if crate::node::is_debug() {
                    println!("[DBG][DHT] refresh stale_buckets={} total_peers={}",
                             stale.len(), table.total_peers());
                }
            }
        });

        if crate::node::is_info() {
            println!("[INFO][DHT] Kademlia routing table refresh task started (interval={}s)",
                     KADEMLIA_REFRESH_INTERVAL_SECS);
        }
    }

    /// Get the Kademlia routing table (for external access/monitoring)
    pub fn get_kademlia_table(&self) -> &Arc<KademliaRoutingTable> {
        &self.kademlia_table
    }

    // ═══════════════════════════════════════════════════════════════════════════
    
    // ═══════════════════════════════════════════════════════════════════════════
    // v5.1: KADEMLIA DHT — iterative lookup, FIND_NODE handler, periodic refresh
    // ═══════════════════════════════════════════════════════════════════════════

    /// Sync connected peers into the Kademlia routing table.
    /// Called after add_peer_lockfree / periodically to keep DHT in sync.
    pub fn kademlia_sync_from_peers(&self) {
        let now = self.current_timestamp();
        for entry in self.connected_peers_lockfree.iter() {
            let p = entry.value();
            self.kademlia_table.upsert(&p.id, &p.addr, p.reputation, now);
        }
    }

    /// PQ v2.90: Verify ML-DSA-65 (ML-DSA-65) gossip signature.
    /// Mobile app signs wallet_address with ML-DSA-65 keypair derived from activation code.
    /// format: "dilithium_sig_{nodeId}_{base64([sig_len_LE][sig+msg][pk_len_LE][pk])}"
    /// expected_message: wallet_address (the original message signed by the mobile app)
    pub(super) fn verify_mobile_dilithium_gossip(&self, expected_message: &str, formatted_signature: &str, public_key_hex: &str) -> bool {
        use pqcrypto_mldsa::mldsa65 as dilithium3;
        use pqcrypto_traits::sign::*;

        if !formatted_signature.starts_with("dilithium_sig_") {
            // Fallback: raw hex ML-DSA-65 signed message
            let pk_bytes = match hex::decode(public_key_hex) { Ok(b) => b, Err(_) => return false };
            let sig_bytes = match hex::decode(formatted_signature) { Ok(b) => b, Err(_) => return false };
            let mut signed_msg = sig_bytes;
            signed_msg.extend_from_slice(expected_message.as_bytes());
            let pk = match dilithium3::PublicKey::from_bytes(&pk_bytes) { Ok(k) => k, Err(_) => return false };
            let sm = match dilithium3::SignedMessage::from_bytes(&signed_msg) { Ok(s) => s, Err(_) => return false };
            return dilithium3::open(&sm, &pk).is_ok();
        }

        // Extract base64 payload: "dilithium_sig_{nodeId}_{base64}"
        let base64_data = match formatted_signature.rfind('_') {
            Some(pos) if pos > 14 => &formatted_signature[pos + 1..],
            _ => return false,
        };

        let decoded = match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, base64_data) {
            Ok(d) => d,
            Err(_) => return false,
        };

        if decoded.len() < 8 { return false; }
        let signed_msg_len = u32::from_le_bytes([decoded[0], decoded[1], decoded[2], decoded[3]]) as usize;
        if decoded.len() < 4 + signed_msg_len + 4 { return false; }

        let signed_message_bytes = &decoded[4..4 + signed_msg_len];
        let pk_offset = 4 + signed_msg_len;
        if decoded.len() < pk_offset + 4 { return false; }
        let pk_len = u32::from_le_bytes([decoded[pk_offset], decoded[pk_offset+1], decoded[pk_offset+2], decoded[pk_offset+3]]) as usize;
        if decoded.len() < pk_offset + 4 + pk_len { return false; }

        let pk_bytes_from_sig = &decoded[pk_offset + 4..pk_offset + 4 + pk_len];
        let pk_bytes_from_request = match hex::decode(public_key_hex) { Ok(b) => b, Err(_) => return false };
        if pk_bytes_from_sig != pk_bytes_from_request.as_slice() { return false; }

        let public_key = match dilithium3::PublicKey::from_bytes(&pk_bytes_from_request) { Ok(k) => k, Err(_) => return false };
        let signed_message = match dilithium3::SignedMessage::from_bytes(signed_message_bytes) { Ok(s) => s, Err(_) => return false };

        match dilithium3::open(&signed_message, &public_key) {
            Ok(verified_msg) => verified_msg == expected_message.as_bytes(),
            Err(_) => false,
        }
    }

    /// Verify signature for heartbeat (ASYNC version)
    /// PRODUCTION: Supports pure ML-DSA-65 (ML-DSA-65) formats (binary, JSON, legacy)
    pub async fn verify_dilithium_heartbeat_signature_async(&self, message: &str, signature: &str, node_id: &str) -> bool {
        use crate::quantum_crypto::DilithiumSignature;
                // Check for empty/invalid signatures
        if signature.is_empty() || signature.len() < 100 {
            if crate::node::is_info() {
                println!("[ERR][P2P] Invalid signature format: too short ({} chars, need 100+)", signature.len());
            }
            return false;
        }
        
        // Binary compact P2P signature (bincode+zstd)
        if signature.starts_with("pq_p2p_bin:") {
            return self.verify_pq_p2p_binary_async(message, signature, node_id).await;
        }

        // LEGACY: JSON P2P signature (parse-only; no current producer)
        if signature.starts_with("pq_p2p:") {
            return self.verify_pq_p2p_signature_async(message, signature, node_id).await;
        }

        // LEGACY: full binary signature (parse-only; no current producer)
        if signature.starts_with("pq_bin:") {
            return self.verify_pq_bin_signature_sync(message, signature, node_id);
        }

        // v2.49.2: COMPACT PQ binary signature
        if signature.starts_with("compact_bin:") {
            return self.verify_compact_bin_signature_sync(message, signature, node_id);
        }
        
        // LEGACY FORMAT: Pure Dilithium signature (for backward compatibility)
        if !signature.starts_with("dilithium_sig_") {
            if crate::node::is_info() {
                println!("[ERR][P2P] Invalid signature format: unknown prefix (got: {}...)",
                         qnet_state::char_prefix(&signature, 20));
            }
            return false;
        }
        
        // PRODUCTION v2.50: Lock-free heartbeat verification
        use crate::node::try_get_quantum_crypto;
        let crypto = match try_get_quantum_crypto() {
            Some(c) => c,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][HEARTBEAT] verify_skip reason=crypto_not_initialized");
                }
                return false;
            }
        };
        
        // Create DilithiumSignature struct
        let dilithium_sig = DilithiumSignature {
            signature: signature.to_string(),
            algorithm: "CRYSTALS-Dilithium3".to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            strength: "quantum-resistant".to_string(),
        };
        
        // Verify using real Dilithium
        match crypto.verify_dilithium_signature(message, &dilithium_sig, node_id).await {
            Ok(valid) => {
                if valid {
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Dilithium signature verified for {}", node_id);
                    }
                } else {
                    // v25.3: governed — collapses spoofer flood (shares the
                    // per-claimed-id window with the consensus-layer sites).
                    qnet_consensus::consensus_crypto::log_sig_reject(
                        node_id,
                        &format!("[ERR][P2P] Invalid Dilithium signature for {}", node_id),
                    );
                }
                valid
            }
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Dilithium verification error for {}: {}", node_id, e);
                }
                false  // NO FALLBACK - reject invalid signatures
            }
        }
    }

    /// OPTIMIZED v2.24: Verify PQ P2P BINARY signature (bincode+zstd)
    pub(super) async fn verify_pq_p2p_binary_async(&self, message: &str, signature: &str, node_id: &str) -> bool {
        use crate::pq_crypto::CompactPqSignature;
        use crate::quantum_crypto::DilithiumSignature;
                use sha3::{Sha3_256, Digest};
        use base64::engine::general_purpose;
        use base64::Engine;
        
        // Parse pq_p2p_bin signature (strip_prefix — no length coupling)
        let base64_data = match signature.strip_prefix("pq_p2p_bin:") {
            Some(rest) => rest,
            None => return false,
        };
        let binary_data = match general_purpose::STANDARD.decode(base64_data) {
            Ok(data) => data,
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Failed to decode base64: {}", e);
                }
                return false;
            }
        };
        
        let compact_sig: CompactPqSignature = match CompactPqSignature::from_binary_compressed(&binary_data) {
            Ok(sig) => sig,
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Failed to parse binary signature: {}", e);
                }
                return false;
            }
        };
        
        // v2.24: Direct node_id comparison
        if compact_sig.node_id != node_id {
            if crate::node::is_info() {
                println!("[ERR][P2P] Node ID mismatch: {} vs {}", compact_sig.node_id, node_id);
            }
            return false;
        }
        
        // Pure ML-DSA-65 (P8): hash the message; Dilithium is the sole authenticator
        let mut hasher = Sha3_256::new();
        hasher.update(message.as_bytes());
        let message_hash = hasher.finalize();

        // Verify Dilithium signature
        if compact_sig.dilithium_key_signature.is_empty() {
            if crate::node::is_info() {
                println!("[ERR][P2P] REJECTED: No Dilithium key signature!");
            }
            return false;
        }

        // PRODUCTION v2.50: Lock-free quantum crypto
        use crate::node::try_get_quantum_crypto;
        let crypto = match try_get_quantum_crypto() {
            Some(c) => c,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] pq_p2p_bin_verify_skip reason=crypto_not_initialized");
                }
                return false;
            }
        };

        // Verify Dilithium key signature (re-rooted preimage = message_hash || signed_at)
        let mut encapsulated_data = Vec::new();
        encapsulated_data.extend_from_slice(&message_hash);
        encapsulated_data.extend_from_slice(&compact_sig.signed_at.to_le_bytes());
        let encapsulated_hex = hex::encode(&encapsulated_data);
        
        // Convert RAW bytes to signature string
        use crate::crypto::pq_crypto::encode_dilithium_signature;
        let signature_string = encode_dilithium_signature(&compact_sig.node_id, &compact_sig.dilithium_key_signature);
        
        let dilithium_key_sig = DilithiumSignature {
            signature: signature_string,
            algorithm: "CRYSTALS-Dilithium3".to_string(),
            timestamp: compact_sig.signed_at,
            strength: "quantum-resistant".to_string(),
        };
        
        match crypto.verify_dilithium_signature(&encapsulated_hex, &dilithium_key_sig, &compact_sig.node_id).await {
            Ok(true) => {
                if crate::node::is_info() {
                    println!("[INFO][P2P] Binary signature verified (v2.24)");
                }
                true
            }
            Ok(false) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Dilithium signature INVALID!");
                }
                false
            }
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Dilithium verification error: {}", e);
                }
                false
            }
        }
    }
    
    /// LEGACY: Verify PQ P2P JSON signature (pure ML-DSA-65)
    pub(super) async fn verify_pq_p2p_signature_async(&self, message: &str, signature: &str, node_id: &str) -> bool {
        use crate::pq_crypto::CompactPqSignature;
        use crate::quantum_crypto::DilithiumSignature;
                use sha3::{Sha3_256, Digest};
        
        // Parse pq_p2p signature (strip_prefix — no length coupling)
        let json_str = match signature.strip_prefix("pq_p2p:") {
            Some(rest) => rest,
            None => return false,
        };
        let compact_sig: CompactPqSignature = match serde_json::from_str(json_str) {
            Ok(sig) => sig,
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Failed to parse PQ signature: {}", e);
                }
                return false;
            }
        };

        // v2.24: Direct node_id comparison
        if compact_sig.node_id != node_id {
            if crate::node::is_info() {
                println!("[ERR][P2P] Node ID mismatch: {} vs {}", compact_sig.node_id, node_id);
            }
            return false;
        }
        
        // Pure ML-DSA-65 (P8): hash the message; Dilithium is the sole authenticator
        let mut hasher = Sha3_256::new();
        hasher.update(message.as_bytes());
        let message_hash = hasher.finalize();

        // OPTIMIZED v2.23: RAW bytes, single Dilithium signature (includes message_hash)
        if compact_sig.dilithium_key_signature.is_empty() {
            if crate::node::is_info() {
                println!("[ERR][P2P] REJECTED: No Dilithium key signature!");
            }
            return false;
        }

        // PRODUCTION v2.50: Lock-free quantum crypto
        use crate::node::try_get_quantum_crypto;
        let crypto = match try_get_quantum_crypto() {
            Some(c) => c,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][CRYPTO] verify_skip reason=not_initialized");
                }
                return false;
            }
        };

        // Verify Dilithium key signature (re-rooted preimage = message_hash || signed_at)
        let mut encapsulated_data = Vec::new();
        encapsulated_data.extend_from_slice(&message_hash);
        encapsulated_data.extend_from_slice(&compact_sig.signed_at.to_le_bytes());
        let encapsulated_hex = hex::encode(&encapsulated_data);
        
        // OPTIMIZED v2.23: Convert RAW bytes to signature string
        use crate::crypto::pq_crypto::encode_dilithium_signature;
        let signature_string = encode_dilithium_signature(&compact_sig.node_id, &compact_sig.dilithium_key_signature);
        
        let dilithium_key_sig = DilithiumSignature {
            signature: signature_string,
            algorithm: "CRYSTALS-Dilithium3".to_string(),
            timestamp: compact_sig.signed_at,
            strength: "quantum-resistant".to_string(),
        };
        
        match crypto.verify_dilithium_signature(&encapsulated_hex, &dilithium_key_sig, &compact_sig.node_id).await {
            Ok(true) => {
                if crate::node::is_info() {
                    println!("[INFO][P2P] Signature verified (Dilithium3)");
                }
                true
            }
            Ok(false) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Dilithium signature INVALID!");
                }
                false
            }
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Dilithium verification error: {}", e);
                }
                false
            }
        }
    }
    
    /// Verify signature for heartbeat (SYNC version)
    /// SAFE: Uses std::thread::spawn to isolate runtime, avoiding nested runtime panic
    /// Supports pure ML-DSA-65 (ML-DSA-65) formats (binary, JSON, legacy)
    /// Verify a LIGHT node's own signature over its ping challenge. SINGLE implementation — the HTTP
    /// ingress and the gossip relay must accept exactly the same set, or a relay admits what the
    /// ingress rejects.
    ///
    /// The two formats are NOT equally rooted, and the difference matters:
    /// - `ping_dilithium:` is fail-closed on the chain — the delegation cert is verified against
    ///   `load_vrf_public_key`, so an identity with no on-chain key is refused outright.
    /// - `compact_bin:` goes through the consensus PK binding, which for an identity ALREADY in the
    ///   registry is a real on-chain binding, but for one absent from it falls back to trust-on-first-
    ///   verify against the key the message itself carries. That admit does not REGISTER the key, and
    ///   the eligibility bitmap enumerates the on-chain roster rather than this RAM registry, so a
    ///   gossip-only identity cannot reach a payout — but the acceptance gate here is weaker than the
    ///   sibling above, and freshness comes from the challenge, not from the key.
    pub fn verify_light_ping_signature(&self, node_id: &str, challenge: &str, signature: &str) -> bool {
        if node_id.is_empty() || challenge.is_empty() || signature.is_empty() {
            return false;
        }
        if signature.starts_with("compact_bin:") {
            return self.verify_dilithium_heartbeat_signature(challenge, signature, node_id);
        }
        if let Some(inner_sig) = signature.strip_prefix("ping_dilithium:") {
            let storage = match self.storage.as_ref() {
                Some(s) => s,
                None => return false,
            };
            let (ping_pk_hex, delegation_cert) = match storage.get_light_ping_keys(node_id) {
                Some(kv) => kv,
                None => return false,
            };
            if ping_pk_hex.is_empty() || delegation_cert.is_empty() {
                return false;
            }
            let onchain_pk_hex = match storage.load_vrf_public_key(node_id) {
                Ok(Some(bytes)) => hex::encode(bytes),
                _ => return false,
            };
            let delegation_msg = format!("delegate_ping:{}:{}", ping_pk_hex, node_id);
            if !crate::rpc::verify_mobile_dilithium_signature(&delegation_msg, &delegation_cert, &onchain_pk_hex) {
                return false;
            }
            return crate::rpc::verify_mobile_dilithium_signature(challenge, inner_sig, &ping_pk_hex);
        }
        false
    }

    pub fn verify_dilithium_heartbeat_signature(&self, message: &str, signature: &str, node_id: &str) -> bool {
        use crate::quantum_crypto::DilithiumSignature;

        // Check for empty/invalid signatures
        if signature.is_empty() || signature.len() < 100 {
            if crate::node::is_info() {
                println!("[ERR][P2P] Invalid signature format: too short ({} chars, need 100+)", signature.len());
            }
            return false;
        }
        
        // Binary compact P2P signature (bincode+zstd)
        if signature.starts_with("pq_p2p_bin:") {
            return self.verify_pq_p2p_binary_sync(message, signature, node_id);
        }

        // LEGACY: JSON P2P signature (parse-only; no current producer)
        if signature.starts_with("pq_p2p:") {
            return self.verify_pq_p2p_signature_sync(message, signature, node_id);
        }

        // LEGACY: full binary signature (parse-only; no current producer)
        // Format: "pq_bin:<base64_bincode_zstd>" with embedded certificate
        if signature.starts_with("pq_bin:") {
            return self.verify_pq_bin_signature_sync(message, signature, node_id);
        }

        // v2.49.2: COMPACT PQ binary signature
        // Format: "compact_bin:<base64_bincode_zstd>" requires pre-shared certificate
        if signature.starts_with("compact_bin:") {
            return self.verify_compact_bin_signature_sync(message, signature, node_id);
        }
        
        // LEGACY FORMAT: Pure Dilithium signature
        if !signature.starts_with("dilithium_sig_") {
            if crate::node::is_info() {
                println!("[ERR][P2P] Invalid signature format: unknown prefix (got: {}...)",
                         qnet_state::char_prefix(&signature, 20));
            }
            return false;
        }
        
        // CRITICAL FIX: Use std::thread::spawn to isolate runtime
        // This prevents "Cannot start a runtime from within a runtime" panic
        // when called from async context (e.g., warp RPC handlers)
        let message = message.to_string();
        let signature = signature.to_string();
        let node_id = node_id.to_string();
        
        // Reused process-wide runtime: a QC verifies up to committee-size signatures; the old path
        // built + tore down a tokio runtime PER signature (67–1000× per QC). One shared runtime
        // (init once) drops that to the Dilithium open alone; the thread still isolates block_on
        // from an enclosing async caller (RPC). Init failure ⇒ thread panic ⇒ join Err ⇒ reject.
        use std::sync::OnceLock;
        static SIG_VERIFY_RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
        let handle = std::thread::spawn(move || {
            let rt = SIG_VERIFY_RT.get_or_init(|| {
                tokio::runtime::Runtime::new().expect("sig_verify runtime init")
            });
            {
                    rt.block_on(async move {
                        // PRODUCTION v2.50: Lock-free quantum crypto in isolated thread
                        use crate::node::try_get_quantum_crypto;
                        let crypto = match try_get_quantum_crypto() {
                            Some(c) => c,
                            None => {
                                if crate::node::is_warn() {
                                    println!("[WARN][HEARTBEAT] verify_skip reason=crypto_not_initialized");
                                }
                                return false;
                            }
                        };
                        
                        let crypto = match Some(crypto.as_ref()) {
            Some(c) => c,
            None => return false, // Crypto not initialized
        };
                        
                        let dilithium_sig = DilithiumSignature {
                            signature: signature.clone(),
                            algorithm: "CRYSTALS-Dilithium3".to_string(),
                            timestamp: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs(),
                            strength: "quantum-resistant".to_string(),
                        };
                        
                        match crypto.verify_dilithium_signature(&message, &dilithium_sig, &node_id).await {
                            Ok(valid) => {
                                if valid {
                                    if crate::node::is_info() {
                                        println!("[INFO][P2P] Dilithium signature verified for {}", node_id);
                                    }
                                } else {
                                    // v25.3: governed — collapses spoofer flood
                                    // (shares the per-claimed-id window with the
                                    // consensus-layer reject sites).
                                    qnet_consensus::consensus_crypto::log_sig_reject(
                                        &node_id,
                                        &format!("[ERR][P2P] Invalid Dilithium signature for {}", node_id),
                                    );
                                }
                                valid
                            }
                            Err(e) => {
                                if crate::node::is_info() {
                                    println!("[ERR][P2P] Dilithium verification error for {}: {}", node_id, e);
                                }
                                false  // NO FALLBACK - reject invalid signatures
                            }
                        }
                    })
            }
        });
        
        // Wait for thread to complete (with timeout for safety)
        match handle.join() {
            Ok(result) => result,
            Err(_) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Verification thread panicked");
                }
                false
            }
        }
    }
    
    /// v2.48: Verify consensus signature (commit/reveal) using Dilithium
    /// Wrapper around verify_dilithium_heartbeat_signature for consistent API
    pub fn verify_consensus_signature(&self, node_id: &str, message: &str, signature: &str) -> bool {
        // Use the same verification logic as heartbeat (supports all formats)
        self.verify_dilithium_heartbeat_signature(message, signature, node_id)
    }

    /// IDENTITY-IP ANCHORING — preserved for direct-only message types.
    ///
    /// **v17.1 status: NOT called from any current handler.** The original
    /// design used this gate on every genesis-bearing inbound message, but
    /// every such message in v17 is gossip-relayed: `from_peer` is the
    /// IP of the relay that forwarded the packet, NOT of the originator
    /// who signed it. Anchoring the relay's IP to the originator's
    /// genesis slot rejected legitimate gossip and broke 2f+1 quorum on
    /// testnet (visible as `genesis_ip_mismatch ... REJECTED` warns and a
    /// stuck macroblock #2). Identity binding for genesis nodes is now
    /// enforced exclusively at the cryptographic layer:
    ///
    ///   * `genesis_anchors.json` pre-pins the canonical ML-DSA-65 PK for
    ///     every `genesis_node_N` at startup
    ///     (see `install_genesis_anchors_at_startup`).
    ///   * `register_consensus_pk_from_chain` is strict — any later
    ///     attempt to register a different PK for the same genesis slot
    ///     is hard-rejected (`genesis_pk_first_seen_rejected`).
    ///   * `verify_consensus_signature` (Fix #2 in quantum_crypto.rs)
    ///     no longer falls back to the legacy bootstrap path, so a
    ///     squatter cannot ride past the signature check.
    ///
    /// The helper is retained for any future message type that is
    /// guaranteed point-to-point (no relays) — for those, IP anchoring
    /// is a free additional defence-in-depth layer.
    ///
    /// Returns `true` when the gate ALLOWS (non-genesis identity OR
    /// matching IP), `false` (with WARN log) when it REJECTS.
    #[allow(dead_code)]
    pub(super) fn check_genesis_ip_gate(&self, node_id: &str, from_peer: &str, msg_tag: &str) -> bool {
        if !crate::genesis_constants::is_legacy_genesis_node(node_id) {
            // Not a genesis identity — gate doesn't apply.
            return true;
        }
        let sender_ip = from_peer.split(':').next().unwrap_or("");
        match crate::genesis_constants::genesis_ip_for_node_id(node_id) {
            Some(expected) if expected == sender_ip => true,
            Some(expected) => {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][{}] genesis_ip_mismatch node={} sender_ip={} expected_ip={} REJECTED",
                        msg_tag, node_id, sender_ip, expected
                    );
                }
                false
            }
            None => {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][{}] genesis_unknown_slot node={} REJECTED",
                        msg_tag, node_id
                    );
                }
                false
            }
        }
    }
    
    /// OPTIMIZED v2.24: Verify PQ P2P BINARY signature (SYNC version)
    pub(super) fn verify_pq_p2p_binary_sync(&self, message: &str, signature: &str, node_id: &str) -> bool {
        let message = message.to_string();
        let signature = signature.to_string();
        let node_id = node_id.to_string();
        
        // Use std::thread::spawn to isolate runtime
        let handle = std::thread::spawn(move || {
            use crate::pq_crypto::CompactPqSignature;
            use crate::quantum_crypto::DilithiumSignature;
            use sha3::{Sha3_256, Digest};
            use base64::engine::general_purpose;
            use base64::Engine;
            
            // Parse binary signature (strip_prefix — no length coupling)
            let base64_data = match signature.strip_prefix("pq_p2p_bin:") {
                Some(rest) => rest,
                None => return false,
            };
            let binary_data = match general_purpose::STANDARD.decode(base64_data) {
                Ok(data) => data,
                Err(e) => {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] Failed to decode base64 (sync): {}", e);
                    }
                    return false;
                }
            };
            
            let compact_sig: CompactPqSignature = match CompactPqSignature::from_binary_compressed(&binary_data) {
                Ok(sig) => sig,
                Err(e) => {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] Failed to parse binary signature (sync): {}", e);
                    }
                    return false;
                }
            };
            
            // v2.24: Direct node_id comparison
            if compact_sig.node_id != node_id {
                if crate::node::is_info() {
                    println!("[ERR][P2P] Node ID mismatch: {} vs {}", compact_sig.node_id, node_id);
                }
                return false;
            }
            
            // Pure ML-DSA-65 (P8): hash the message; Dilithium is the sole authenticator
            let mut hasher = Sha3_256::new();
            hasher.update(message.as_bytes());
            let message_hash = hasher.finalize();

            // Verify Dilithium via runtime
            match tokio::runtime::Runtime::new() {
                Ok(rt) => {
                    rt.block_on(async {
                        // PRODUCTION v2.50: Lock-free quantum crypto
                        use crate::node::try_get_quantum_crypto;
                        let crypto = match try_get_quantum_crypto() {
                            Some(c) => c.as_ref(),
                            None => return false,
                        };

                        let mut encapsulated_data = Vec::new();
                        encapsulated_data.extend_from_slice(&message_hash);
                        encapsulated_data.extend_from_slice(&compact_sig.signed_at.to_le_bytes());
                        let encapsulated_hex = hex::encode(&encapsulated_data);
                        
                        use crate::crypto::pq_crypto::encode_dilithium_signature;
                        let signature_string = encode_dilithium_signature(&compact_sig.node_id, &compact_sig.dilithium_key_signature);
                        
                        let dilithium_key_sig = DilithiumSignature {
                            signature: signature_string,
                            algorithm: "CRYSTALS-Dilithium3".to_string(),
                            timestamp: compact_sig.signed_at,
                            strength: "quantum-resistant".to_string(),
                        };
                        
                        match crypto.verify_dilithium_signature(&encapsulated_hex, &dilithium_key_sig, &compact_sig.node_id).await {
                            Ok(true) => {
                                if crate::node::is_info() {
                                    println!("[INFO][P2P] Binary signature verified (sync v2.24)");
                                }
                                true
                            }
                            _ => false
                        }
                    })
                }
                Err(_) => false
            }
        });
        
        handle.join().unwrap_or(false)
    }
    
    /// v2.49.2: Verify FULL PQ binary signature (with embedded certificate)
    /// Format: "pq_bin:<base64_bincode_zstd>" - legacy full-signature parse (no current producer)
    pub(super) fn verify_pq_bin_signature_sync(&self, message: &str, signature: &str, node_id: &str) -> bool {
        use crate::pq_crypto::{PqSignature, PqCrypto};
        use base64::{Engine as _, engine::general_purpose};

        // Parse binary signature: "pq_bin:<base64_bincode_zstd>" (strip_prefix — no length coupling)
        let base64_data = match signature.strip_prefix("pq_bin:") {
            Some(rest) => rest,
            None => return false,
        };
        let binary_data = match general_purpose::STANDARD.decode(base64_data) {
            Ok(data) => data,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] pq_bin base64 decode failed: {}", e);
                }
                return false;
            }
        };

        let pq_sig: PqSignature = match PqSignature::from_binary_compressed(&binary_data) {
            Ok(sig) => sig,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] pq_bin signature parse failed: {}", e);
                }
                return false;
            }
        };

        // Verify node_id matches certificate
        if pq_sig.certificate.node_id != node_id {
            if crate::node::is_warn() {
                println!("[WARN][CONS] pq_bin node_id mismatch: {} vs {}",
                         pq_sig.certificate.node_id, node_id);
            }
            return false;
        }
        
        // CRITICAL v2.49.3: commit_hash is HEX string, must decode to bytes for verification
        // Signature was created on decoded bytes, not on HEX string!
        let message_bytes: Vec<u8> = match hex::decode(message) {
            Ok(bytes) => bytes,
            Err(_) => {
                // Fallback: if not valid hex, use as-is (for non-commit messages)
                message.as_bytes().to_vec()
            }
        };
        
        // v2.49.3: Use thread with TIMEOUT to prevent deadlock
        // Previous version caused deadlock when all tokio workers blocked on join()
        let (tx, rx) = std::sync::mpsc::channel();
        let node_id_clone = pq_sig.certificate.node_id.clone();
        let serial_clone = pq_sig.certificate.serial_number.clone();
        
        std::thread::spawn(move || {
            let result = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build() 
            {
                Ok(rt) => {
                    rt.block_on(async move {
                        let verifier = PqCrypto::new(node_id_clone.clone());
                        match verifier.verify_signature(&message_bytes, &pq_sig).await {
                            Ok(true) => {
                                if crate::node::is_debug() {
                                    println!("[DBG][CONS] pq_bin_verified node={} cert={}",
                                             node_id_clone,
                                             qnet_state::char_prefix(&serial_clone, 8));
                                }
                                true
                            }
                            Ok(false) => {
                                if crate::node::is_warn() {
                                    println!("[WARN][CONS] pq_bin_invalid node={}", node_id_clone);
                                }
                                false
                            }
                            Err(e) => {
                                if crate::node::is_warn() {
                                    println!("[WARN][CONS] pq_bin_error node={} err={}", node_id_clone, e);
                                }
                                false
                            }
                        }
                    })
                }
                Err(_) => false
            };
            let _ = tx.send(result);
        });
        
        // v2.49.3: Wait with 10 second timeout to prevent deadlock
        match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(result) => result,
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] pq_bin verification timeout for node={}", node_id);
                }
                false
            }
        }
    }
    
    /// v2.49.2: Verify COMPACT PQ binary signature (requires pre-shared certificate)
    /// Format: "compact_bin:<base64_bincode_zstd>" - used for microblock signatures
    pub(super) fn verify_compact_bin_signature_sync(&self, message: &str, signature: &str, node_id: &str) -> bool {
        use crate::pq_crypto::CompactPqSignature;
        use crate::quantum_crypto::DilithiumSignature;
        use sha3::{Sha3_256, Digest};
        use base64::{Engine as _, engine::general_purpose};
        
        // Parse binary signature: "compact_bin:<base64_bincode_zstd>"
        let base64_data = &signature[12..]; // Skip "compact_bin:" prefix
        let binary_data = match general_purpose::STANDARD.decode(base64_data) {
            Ok(data) => data,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] compact_bin base64 decode failed: {}", e);
                }
                return false;
            }
        };
        
        let compact_sig: CompactPqSignature = match CompactPqSignature::from_binary_compressed(&binary_data) {
            Ok(sig) => sig,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] compact_bin signature parse failed: {}", e);
                }
                return false;
            }
        };
        
        // Verify node_id matches
        if compact_sig.node_id != node_id {
            if crate::node::is_warn() {
                println!("[WARN][CONS] compact_bin node_id mismatch: {} vs {}", 
                         compact_sig.node_id, node_id);
            }
            return false;
        }
        
        // CRITICAL v2.49.2: message is HEX string, must decode to bytes for verification
        // Signature was created on decoded bytes, not on HEX string!
        let message_bytes: Vec<u8> = match hex::decode(message) {
            Ok(bytes) => bytes,
            Err(_) => {
                // Fallback: if not valid hex, use as-is (for non-commit messages)
                message.as_bytes().to_vec()
            }
        };
        
        // Verify Dilithium signature on message hash (pure ML-DSA-65)
        let mut hasher = Sha3_256::new();
        hasher.update(&message_bytes);
        let message_hash = hasher.finalize();

        // v2.49.3: Verify Dilithium signature with TIMEOUT to prevent deadlock
        let node_id_clone = node_id.to_string();
        let (tx, rx) = std::sync::mpsc::channel();

        std::thread::spawn(move || {
            let result = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => {
                    rt.block_on(async move {
                        // PRODUCTION v2.50: Lock-free quantum crypto
                        use crate::node::try_get_quantum_crypto;
                        let crypto = match try_get_quantum_crypto() {
                            Some(c) => c.as_ref(),
                            None => return false,
                        };

                        let mut encapsulated_data = Vec::new();
                        encapsulated_data.extend_from_slice(&message_hash);
                        encapsulated_data.extend_from_slice(&compact_sig.signed_at.to_le_bytes());
                        let encapsulated_hex = hex::encode(&encapsulated_data);
                        
                        use crate::crypto::pq_crypto::encode_dilithium_signature;
                        let signature_string = encode_dilithium_signature(&compact_sig.node_id, &compact_sig.dilithium_key_signature);
                        
                        let dilithium_key_sig = DilithiumSignature {
                            signature: signature_string,
                            algorithm: "CRYSTALS-Dilithium3".to_string(),
                            timestamp: compact_sig.signed_at,
                            strength: "quantum-resistant".to_string(),
                        };
                        
                        match crypto.verify_dilithium_signature(&encapsulated_hex, &dilithium_key_sig, &node_id_clone).await {
                            Ok(true) => {
                                if crate::node::is_debug() {
                                    println!("[DBG][CONS] compact_bin_verified node={}", node_id_clone);
                                }
                                true
                            }
                            Ok(false) => {
                                if crate::node::is_warn() {
                                    println!("[WARN][CONS] compact_bin_invalid node={}", node_id_clone);
                                }
                                false
                            }
                            Err(e) => {
                                if crate::node::is_warn() {
                                    println!("[WARN][CONS] compact_bin_error node={} err={:?}", node_id_clone, e);
                                }
                                false
                            }
                        }
                    })
                }
                Err(_) => false
            };
            let _ = tx.send(result);
        });
        
        // v2.49.3: Wait with 10 second timeout to prevent deadlock
        match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(result) => result,
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] compact_bin verification timeout for node={}", node_id);
                }
                false
            }
        }
    }
    
    /// LEGACY: Verify PQ P2P JSON signature (SYNC version) - pure ML-DSA-65
    pub(super) fn verify_pq_p2p_signature_sync(&self, message: &str, signature: &str, node_id: &str) -> bool {
        let message = message.to_string();
        let signature = signature.to_string();
        let _node_id = node_id.to_string();
        
        // Use std::thread::spawn to isolate runtime
        let handle = std::thread::spawn(move || {
            use crate::pq_crypto::CompactPqSignature;
            use crate::quantum_crypto::DilithiumSignature;
            use sha3::{Sha3_256, Digest};
            
            match tokio::runtime::Runtime::new() {
                Ok(rt) => {
                    rt.block_on(async move {
                        // Parse pq_p2p signature (strip_prefix — no length coupling)
                        let json_str = match signature.strip_prefix("pq_p2p:") {
                            Some(rest) => rest,
                            None => return false,
                        };
                        let compact_sig: CompactPqSignature = match serde_json::from_str(json_str) {
                            Ok(sig) => sig,
                            Err(e) => {
                                if crate::node::is_info() {
                                    println!("[ERR][P2P] Failed to parse PQ signature: {}", e);
                                }
                                return false;
                            }
                        };

                        // Pure ML-DSA-65 (P8): Dilithium is the sole authenticator
                        if compact_sig.dilithium_key_signature.is_empty() {
                            if crate::node::is_info() {
                                println!("[ERR][P2P] Missing Dilithium key signature!");
                            }
                            return false;
                        }

                        // Create message hash
                        let mut hasher = Sha3_256::new();
                        hasher.update(message.as_bytes());
                        let message_hash = hasher.finalize();

                        // PRODUCTION v2.50: Lock-free quantum crypto for Dilithium verification
                        use crate::node::try_get_quantum_crypto;
                        let crypto = match try_get_quantum_crypto() {
                            Some(c) => c.as_ref(),
                            None => return false,
                        };

                        // Verify Dilithium key signature (re-rooted preimage = message_hash || signed_at)
                        let mut encapsulated_data = Vec::new();
                        encapsulated_data.extend_from_slice(&message_hash);
                        encapsulated_data.extend_from_slice(&compact_sig.signed_at.to_le_bytes());
                        let encapsulated_hex = hex::encode(&encapsulated_data);
                        
                        // OPTIMIZED v2.23: Convert RAW bytes to signature string
                        use crate::crypto::pq_crypto::encode_dilithium_signature;
                        let signature_string = encode_dilithium_signature(&compact_sig.node_id, &compact_sig.dilithium_key_signature);
                        
                        let dilithium_key_sig = DilithiumSignature {
                            signature: signature_string,
                            algorithm: "CRYSTALS-Dilithium3".to_string(),
                            timestamp: compact_sig.signed_at,
                            strength: "quantum-resistant".to_string(),
                        };
                        
                        // OPTIMIZED v2.23: Single Dilithium signature verification
                        match crypto.verify_dilithium_signature(&encapsulated_hex, &dilithium_key_sig, &compact_sig.node_id).await {
                            Ok(true) => {
                                if crate::node::is_info() {
                                    println!("[INFO][P2P] PQ signature verified (Dilithium3)");
                                }
                                true
                            }
                            _ => {
                                if crate::node::is_info() {
                                    println!("[ERR][P2P] Dilithium signature INVALID!");
                                }
                                false
                            }
                        }
                    })
                }
                Err(e) => {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] Cannot create runtime: {}", e);
                    }
                    false
                }
            }
        });
        
        match handle.join() {
            Ok(result) => result,
            Err(_) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] PQ verification thread panicked");
                }
                false
            }
        }
    }
    
    /// Update node reputation by delta (general purpose)
    /// DEPRECATED v2.21.5: Reputation now managed via blockchain (DeterministicReputationState)
    /// Use slashing events for penalties, process_block/macroblock for rewards
    #[deprecated(note = "Use DeterministicReputationState - reputation changes via blockchain only")]
    pub fn update_reputation_by_delta(&self, _node_id: &str, _delta: f64) {
        // v2.21.5: No-op - reputation managed via blockchain
        // Rewards: process_block (+2% rotation), process_macroblock (+1% consensus)
        // Penalties: slashing events in macroblock
    }
    
    /// PASSIVE RECOVERY: +1% for nodes in recovery zone (10-69%)
    /// - Only applies to Super nodes with reputation 10 <= rep < 70
    /// - Caps at 70 (consensus threshold) - nodes must earn higher through consensus participation
    /// - Light nodes: EXCLUDED (fixed at 70)
    /// - Banned nodes (<10): EXCLUDED (no passive recovery)
    /// - JAILED nodes: EXCLUDED (must wait for jail to expire first!)
    /// SCALABILITY: O(1) per node, called once per 4 hours
    /// DEPRECATED: PassiveRecovery removed - not synchronized across network
    /// ═══════════════════════════════════════════════════════════════════════════
    /// WHY REMOVED:
    /// 1. Not deterministic (each node on own timer)
    /// 2. Not synchronized (no P2P message)
    /// 3. Abuse potential (get +1% for doing nothing)
    ///
    /// NEW ARCHITECTURE: Use DeterministicReputationState from blockchain data
    /// Recovery happens when node successfully produces blocks again
    /// ═══════════════════════════════════════════════════════════════════════════
    #[deprecated(note = "Use DeterministicReputationState - PassiveRecovery not synchronized")]
    #[allow(dead_code)]
    pub fn apply_passive_recovery(&self, _node_id: &str) -> bool {
        // DISABLED: Always returns false
        // Reputation recovery now happens through block production
        false
    }
    
    /// Get peer address by node ID for heartbeat
    pub(super) fn get_peer_address_for_heartbeat(&self, node_id: &str) -> Option<String> {
        self.peer_id_to_addr.get(node_id).map(|r| r.value().clone())
    }
    
    /// Sign P2P message with PQ cryptography (ASYNC version) - pure ML-DSA-65
    /// PRODUCTION: Use this in async contexts (warp handlers, tokio tasks)
    /// CRITICAL: Single ML-DSA-65 (ML-DSA-65) signature per message
    /// Returns compact PQ signature JSON string
    /// NO FALLBACK - unsigned messages are rejected by the network
    pub async fn sign_dilithium_async(&self, message: &str, node_id: &str) -> Option<String> {
        use crate::pq_crypto::{PqCrypto, GLOBAL_PQ_INSTANCES};
        use std::sync::Arc;

        // Get or create PQ crypto instance (thread-safe global cache)
        let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
            Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
        }).await;

        let mut instances_guard = instances.lock().await;

        // v2.24: Use node_id directly
        let normalized_node_id = node_id.to_string();

        // Create instance if not exists
        if !instances_guard.contains_key(&normalized_node_id) {
            let mut pq = PqCrypto::new(normalized_node_id.clone());
            if let Err(e) = pq.initialize().await {
                if crate::node::is_info() {
                    println!("[ERR][CRYPTO] CRITICAL: PQ crypto init failed: {} - SKIPPING OPERATION", e);
                }
                return None;
            }
            instances_guard.insert(normalized_node_id.clone(), pq);
        }

        let pq = match instances_guard.get_mut(&normalized_node_id) {
            Some(h) => h,
            None => return None, // Should never happen but prevents panic
        };

        // Check certificate rotation
        if pq.needs_rotation() {
            if let Err(e) = pq.rotate_certificate().await {
                if crate::node::is_info() {
                    println!("[WARN][CRYPTO] Certificate rotation failed: {}", e);
                }
            }
        }

        // CRITICAL: Sign RAW message with pure ML-DSA-65 (ML-DSA-65)
        // Using sign_raw_message_compact which hashes the message before signing
        // This ensures consistency with verification which also hashes
        // OPTIMIZED v2.24: bincode+zstd instead of JSON
        match pq.sign_raw_message_compact(message.as_bytes()).await {
            Ok(compact_sig) => {
                // Serialize to bincode+zstd+base64
                match compact_sig.to_binary_compressed() {
                    Ok(binary_data) => {
                        let base64_data = base64::engine::general_purpose::STANDARD.encode(&binary_data);
                        let sig_with_prefix = format!("pq_p2p_bin:{}", base64_data);
                        if crate::node::is_info() {
                            println!("[INFO][CRYPTO] PQ P2P signature created (bincode v2.24)");
                        }
                        if crate::node::is_info() {
                            println!("[INFO][CRYPTO] Size: {} bytes (optimized)", binary_data.len());
                        }
                        Some(sig_with_prefix)
                    }
                    Err(e) => {
                        if crate::node::is_info() {
                            println!("[ERR][CRYPTO] Failed to serialize PQ signature: {}", e);
                        }
                        None
                    }
                }
            }
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][CRYPTO] CRITICAL: PQ signing failed: {} - SKIPPING OPERATION", e);
                }
                None
            }
        }
    }
    
    /// Sign heartbeat message with PQ cryptography (SYNC version for std::thread::spawn ONLY)
    /// WARNING: Only use in pure sync contexts where NO tokio runtime exists!
    /// CRITICAL: Single ML-DSA-65 (ML-DSA-65) signature per heartbeat
    /// PRODUCTION: Returns None if signing fails - heartbeat will be skipped
    /// NO FALLBACK - unsigned heartbeats are rejected by the network
    pub(super) fn sign_heartbeat_dilithium(&self, message: &str, node_id: &str) -> Option<String> {
        use crate::pq_crypto::{PqCrypto, GLOBAL_PQ_INSTANCES};
        use std::sync::Arc;
        
        // Create NEW runtime - safe because we're in std::thread::spawn (no existing runtime)
        match tokio::runtime::Runtime::new() {
            Ok(rt) => {
                let node_id_owned = node_id.to_string();
                let message_owned = message.to_string();
                
                let result = rt.block_on(async move {
                    // Get or create PQ crypto instance (thread-safe global cache)
                    let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
                        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
                    }).await;

                    let mut instances_guard = instances.lock().await;

                    // v2.24: Use node_id directly
                    let normalized_node_id = node_id_owned.clone();

                    // Create instance if not exists
                    if !instances_guard.contains_key(&normalized_node_id) {
                        let mut pq = PqCrypto::new(normalized_node_id.clone());
                        if let Err(e) = pq.initialize().await {
                            if crate::node::is_info() {
                                println!("[ERR][P2P] PQ crypto init failed: {}", e);
                            }
                            return Err(anyhow::anyhow!("PQ init failed: {}", e));
                        }
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

                    // CRITICAL: Sign RAW message with pure ML-DSA-65 (hashes before signing)
                    pq.sign_raw_message_compact(message_owned.as_bytes()).await
                });
                
                match result {
                    Ok(compact_sig) => {
                        // OPTIMIZED v2.24: bincode+zstd
                        match compact_sig.to_binary_compressed() {
                            Ok(binary_data) => {
                                let base64_data = base64::engine::general_purpose::STANDARD.encode(&binary_data);
                                Some(format!("pq_p2p_bin:{}", base64_data))
                            }
                            Err(_) => None
                        }
                    }
                    Err(e) => {
                        if crate::node::is_info() {
                            println!("[ERR][P2P] CRITICAL: PQ signing failed: {} - SKIPPING HEARTBEAT", e);
                        }
                        None
                    }
                }
            }
            Err(e) => {
                if crate::node::is_info() {
                    println!("[ERR][P2P] CRITICAL: Runtime creation failed: {} - SKIPPING HEARTBEAT", e);
                }
                None
            }
        }
    }
    
    
    
    // ═══════════════════════════════════════════════════════════════════════════════
    // v2.50.0: POOL 2 & POOL 3 METHODS - Deterministic reward calculation
    // These values are accumulated locally and written to MacroBlock at emission time
    // All nodes then use SAME values from blockchain for identical reward calculation
    // ═══════════════════════════════════════════════════════════════════════════════
    
    /// Add transaction fee to Pool 2 accumulator (called when TX is processed)
    /// v3.18: Pool 2 removed - fees go directly to block producer
    /// This method kept for backward compatibility (does nothing)
    pub fn add_to_pool2(&self, fee_amount: u64) {
        self.pool2_accumulated_fees.fetch_add(fee_amount, Ordering::SeqCst);
    }
    
    /// Add activation payment to Pool 3 accumulator (Phase 2 only)
    /// Pool 3: Distributed equally to ALL eligible nodes (Light + Full + Super)
    pub fn add_to_pool3(&self, activation_amount: u64) {
        self.pool3_accumulated_activations.fetch_add(activation_amount, Ordering::SeqCst);
    }
    
    /// Get Pool 2 accumulated fees for MacroBlock inclusion (async for API compatibility)
    /// Called during EMISSION MacroBlock creation to record fees in blockchain
    /// Returns current accumulation and resets to 0
    pub async fn get_pool2_accumulated_fees(&self) -> u64 {
        // Atomic swap: read and reset in one operation (no race conditions)
        self.pool2_accumulated_fees.swap(0, Ordering::SeqCst)
    }
    
    /// Get Pool 3 accumulated activations for MacroBlock inclusion (async for API compatibility)
    /// Called during EMISSION MacroBlock creation to record activations in blockchain
    /// Returns current accumulation and resets to 0 (Phase 2 only, Phase 1 always returns 0)
    pub async fn get_pool3_accumulated_activations(&self) -> u64 {
        // Atomic swap: read and reset in one operation (no race conditions)
        self.pool3_accumulated_activations.swap(0, Ordering::SeqCst)
    }
    
    /// Get current Pool 2 balance without resetting (for monitoring)
    pub fn peek_pool2_fees(&self) -> u64 {
        self.pool2_accumulated_fees.load(Ordering::SeqCst)
    }
    
    /// Get current Pool 3 balance without resetting (for monitoring)
    pub fn peek_pool3_activations(&self) -> u64 {
        self.pool3_accumulated_activations.load(Ordering::SeqCst)
    }
    
    /// Get Light Node registry (for ping service)
    pub fn get_light_node_registry(&self) -> HashMap<String, LightNodeRegistrationData> {
        self.light_node_registry.read().clone()
    }

    /// Point-read one light node without cloning the whole registry (scale: millions of entries).
    pub fn get_light_node(&self, node_id: &str) -> Option<LightNodeRegistrationData> {
        self.light_node_registry.read().get(node_id).cloned()
    }
    
    /// Register Light node locally and gossip to network
    pub fn register_light_node(&self, registration: LightNodeRegistrationData) {
        // C: ping keys → dedicated CF (read per-ping); resident entry keeps pubkey/sig/ping-keys EMPTY so
        // it stays ~300B at tens of millions of nodes. Identity comes from the committed VRF key.
        if let Some(s) = &self.storage {
            let _ = s.save_light_ping_keys(&registration.node_id, &registration.ping_pubkey, &registration.ping_delegation_cert);
        }
        {
            let mut registry = self.light_node_registry.write();
            registry.insert(registration.node_id.clone(), LightNodeRegistrationData {
                quantum_pubkey: String::new(), signature: String::new(),
                ping_pubkey: String::new(), ping_delegation_cert: String::new(),
                device_token_hash: String::new(),
                ..registration.clone()
            });
        }

        // Gossip to network — the FULL `registration` values (below), NOT the trimmed resident entry.
        let msg = NetworkMessage::LightNodeRegistration {
            node_id: registration.node_id,
            wallet_address: registration.wallet_address,
            device_token_hash: registration.device_token_hash,
            quantum_pubkey: registration.quantum_pubkey,
            registered_at: registration.registered_at,
            signature: registration.signature,
            gossip_hop: 0,
            push_type: registration.push_type,
            unified_push_endpoint: registration.unified_push_endpoint,
            last_seen: registration.last_seen,
            consecutive_failures: registration.consecutive_failures,
            is_active: registration.is_active,
            ping_pubkey: registration.ping_pubkey,
            ping_delegation_cert: registration.ping_delegation_cert,
        };
        
        self.gossip_to_random_peers(msg, 5);
        if crate::node::is_info() {
            println!("[INFO][P2P] Light node registration gossiped to network");
        }
    }
    
    /// Rehydrate the node_id -> endpoint IP registry from the committed node_registry CF.
    /// The RAM map is written only by the block-apply registration scan, so after a restart it
    /// is empty and every IP-identity gate that consults it falls through to "unbound, allow" —
    /// the pre-verify cutoff that refuses an impostor before the ML-DSA verify is then off for
    /// the whole post-restart window. Genesis addresses come from the pinned binary table, so a
    /// persisted row must never restate one.
    pub(super) fn restore_node_endpoints(&self) {
        let storage = match self.storage.as_deref()
            .or_else(|| crate::node::try_get_storage().map(|s| s.as_ref()))
        {
            Some(s) => s,
            None => return,
        };

        let endpoints = match storage.load_all_node_endpoints() {
            Ok(e) => e,
            Err(e) => {
                if crate::node::is_warn() {
                    println!("[WARN][REG] node_endpoints_restore_failed err={}", e);
                }
                return;
            }
        };

        let mut restored = 0usize;
        for (node_id, endpoint) in &endpoints {
            if node_id.starts_with("genesis_node_") { continue; }
            if crate::genesis_constants::get_node_endpoint_ip(node_id).is_some() { continue; }
            crate::genesis_constants::register_node_endpoint(node_id, endpoint);
            restored = restored.saturating_add(1);
        }

        if crate::node::is_info() {
            println!("[INFO][REG] node_endpoints_restored count={} scanned={}", restored, endpoints.len());
        }
    }

    /// v4.3: Restore light node registry from blockchain storage (RocksDB) on startup.
    /// Populates the in-memory P2P registry from persisted NodeRegistration data.
    /// Called once during node initialization so registry survives restarts.
    /// Without this, all in-memory registries would be empty after restart,
    /// and light nodes would be invisible until they re-register or gossip arrives.
    /// This is the GUARANTEED path — gossip sync is supplementary.
    pub fn restore_light_nodes_from_storage(&self, nodes: Vec<(String, String, String, u64)>) -> usize {
        let mut added = 0;
        let mut registry = self.light_node_registry.write();

        for (node_id, wallet_address, _node_type, registered_at) in nodes {
            if !registry.contains_key(&node_id) {
                // B: liveness is derived from on-chain attestation recency, not a persisted flag — seed
                // active; the ping-wakeup scheduler re-derives whom to wake from committed eligibility.
                registry.insert(node_id.clone(), LightNodeRegistrationData {
                    node_id,
                    wallet_address,
                    device_token_hash: String::new(),
                    quantum_pubkey: String::new(),
                    registered_at,
                    signature: String::new(),
                    push_type: PushType::Polling,
                    unified_push_endpoint: None,
                    last_seen: registered_at,
                    consecutive_failures: 0,
                    is_active: true,
                    ping_pubkey: String::new(),         // Populated on re-registration
                    ping_delegation_cert: String::new(),// Populated on re-registration
                });
                added += 1;
            }
        }
        
        if added > 0 {
            if crate::node::is_info() {
                println!("[INFO][P2P] restored_from_storage light_nodes={} total_registry={}", added, registry.len());
            }
        }
        
        added
    }
    
    /// Restore FCM push types from local RocksDB `fcm_tokens` CF after a node restart.
    /// Called once during startup, right after `restore_light_nodes_from_storage`.
    ///
    /// Problem: `restore_light_nodes_from_storage` initialises all entries with
    /// `push_type = Polling` because FCM tokens are not gossiped (privacy).
    /// This method patches the in-memory registry with the real push_type/endpoint
    /// so the ping service delivers FCM pushes immediately after reboot.
    pub fn update_device_tokens_from_storage(
        &self,
        storage: &crate::storage::Storage,
    ) {
        let mut registry = self.light_node_registry.write();

        let mut updated = 0usize;
        for node in registry.values_mut() {
            if let Some((_, push_type_str, endpoint)) = storage.get_fcm_data(&node.node_id) {
                let new_push_type: PushType = match push_type_str.as_str() {
                    "fcm"         => PushType::FCM,
                    "unifiedpush" => PushType::UnifiedPush,
                    _             => PushType::Polling,
                };
                node.push_type = new_push_type;
                node.unified_push_endpoint = endpoint;
                updated += 1;
            }
        }

        if updated > 0 {
            if crate::node::is_info() {
                println!("[INFO][P2P] fcm_tokens_restored from_rocksdb count={} total_registry={}",
                         updated, registry.len());
            }
        }
    }

    /// Request Light Node registry sync from peers
    pub fn request_light_node_registry_sync(&self) {
        let _now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // Get oldest registration timestamp we have
        let last_sync = {
            let registry = self.light_node_registry.read();
            registry.values()
                .map(|r| r.registered_at)
                .max()
                .unwrap_or(0)
        };
        
        let request = NetworkMessage::LightNodeRegistryRequest {
            requester_id: self.node_id.clone(),
            last_sync_timestamp: last_sync,
        };
        
        // Request from 3 random peers
        self.gossip_to_random_peers(request, 3);
        if crate::node::is_info() {
            println!("[INFO][SYNC] Requested Light node registry sync (since {})", last_sync);
        }
    }
    
    // ========================================================================
    // PRODUCTION: Sharded Light Node Ping System
    // ========================================================================
    
    
    /// DEPRECATED: Old fixed 256-shard calculation (kept for backward compatibility)
    pub fn calculate_light_node_shard(light_node_id: &str) -> u8 {
        use sha3::{Sha3_256, Digest};
        let mut hasher = Sha3_256::new();
        hasher.update(light_node_id.as_bytes());
        let hash = hasher.finalize();
        hash[0]  // First byte = shard (0-255)
    }
    
    /// Get current slot number (0-239 within 4h window, each slot = 1 minute)
    /// Ping slot (0-239) of the CURRENT reward epoch, driven by BLOCK HEIGHT — NOT wall-clock — so the
    /// ping schedule shares ONE clock with rewards/attestations (both height/14400). Wall-clock windows sit
    /// on a different grid than block-epochs, so a node's slot could fall entirely outside an epoch's
    /// block-span → that epoch got 0 pings (observed live: epoch 1 pinged twice, epoch 3 zero). Anchoring
    /// to height puts exactly one ping inside every epoch. 240 slots × 60 blocks = one 14400-block epoch.
    pub fn get_current_slot() -> u64 {
        let h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        (h % 14400) / 60  // 0-239
    }

    /// Current ping window = the reward EPOCH (block height / 14400), so slot randomization
    /// (calculate_randomized_slot) and the attestation epoch (record_light_epoch_eligible) share one clock.
    pub fn get_current_window_number() -> u64 {
        LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 14400
    }
    
    /// Calculate ping slot for Light node with per-window randomization
    /// SECURITY: Slot changes each 4h window, preventing prediction attacks
    pub fn calculate_randomized_slot(light_node_id: &str, window_number: u64) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        
        let mut hasher = DefaultHasher::new();
        light_node_id.hash(&mut hasher);
        window_number.hash(&mut hasher);  // Randomize per window!
        let hash = hasher.finish();
        hash % 240  // 0-239 slots
    }
    
    /// Get next ping time for a Light node (for polling fallback)
    /// Returns (timestamp, window_number) for the next scheduled ping
    pub fn get_next_ping_time(light_node_id: &str) -> (u64, u64) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        let current_window = height / 14400;
        let node_slot = Self::calculate_randomized_slot(light_node_id, current_window);
        // Target BLOCK of the node's slot this epoch; if already passed, the same slot next epoch.
        let slot_block = current_window * 14400 + node_slot * 60;
        let (target_block, window) = if slot_block > height {
            (slot_block, current_window)
        } else {
            let next_window = current_window + 1;
            let next_slot = Self::calculate_randomized_slot(light_node_id, next_window);
            (next_window * 14400 + next_slot * 60, next_window)
        };
        // Wall-clock estimate for polling clients (~1 block/s from the local tip).
        let ping_time = now + target_block.saturating_sub(height);
        (ping_time, window)
    }
    
    /// Determine if Light node should be pinged in current slot (randomized per window)
    /// Returns true if node's slot matches current slot
    /// GRACE PERIOD: Also returns true for 2 slots after the primary slot (retry window)
    pub fn is_light_node_ping_slot(light_node_id: &str) -> bool {
        let current_slot = Self::get_current_slot();
        let current_window = Self::get_current_window_number();
        let node_slot = Self::calculate_randomized_slot(light_node_id, current_window);
        
        // GRACE PERIOD: Primary slot + 2 retry slots (3 minutes total window)
        // This handles network delays and temporary unavailability
        let slot_diff = if current_slot >= node_slot {
            current_slot - node_slot
        } else {
            // Handle wrap-around at slot 240
            240 - node_slot + current_slot
        };
        
        slot_diff <= 2  // Primary slot (0) + 2 retry slots (1, 2)
    }
    
    /// Check if this is the PRIMARY slot for Light node (not retry)
    pub fn is_light_node_primary_slot(light_node_id: &str) -> bool {
        let current_slot = Self::get_current_slot();
        let current_window = Self::get_current_window_number();
        let node_slot = Self::calculate_randomized_slot(light_node_id, current_window);
        
        current_slot == node_slot
    }
    
    /// Determine pinger role for this node given a Light node
    /// Uses deterministic selection: hash(light_node_id + slot) → sorted active nodes → top 3
    pub fn get_pinger_role(&self, light_node_id: &str) -> PingerRole {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        
        let current_slot = Self::get_current_slot();
        
        // Get sorted active Super node IDs (v2.51: lock-free)
        let active_node_ids: Vec<String> = {
            let mut sorted: Vec<_> = self.active_full_super_nodes.iter()
                .filter(|entry| entry.value().reputation >= qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION)
                .map(|entry| entry.value().node_id.clone())
                .collect();
            sorted.sort();
            sorted
        };
        
        if active_node_ids.is_empty() {
            // Fallback: Genesis nodes are always active
            if self.node_id.starts_with("genesis_node_") {
                return PingerRole::Primary;
            }
            return PingerRole::None;
        }
        
        // Deterministic selection: hash(light_node_id + slot) → index into sorted nodes
        let mut hasher = DefaultHasher::new();
        format!("{}:{}", light_node_id, current_slot).hash(&mut hasher);
        let hash = hasher.finish();
        
        let primary_idx = (hash as usize) % active_node_ids.len();
        let backup1_idx = (primary_idx + 1) % active_node_ids.len();
        let backup2_idx = (primary_idx + 2) % active_node_ids.len();
        
        // Check if we are primary, backup1, or backup2
        if active_node_ids.get(primary_idx) == Some(&self.node_id) {
            PingerRole::Primary
        } else if active_node_ids.get(backup1_idx) == Some(&self.node_id) {
            PingerRole::Backup1
        } else if active_node_ids.get(backup2_idx) == Some(&self.node_id) {
            PingerRole::Backup2
        } else {
            PingerRole::None
        }
    }
    
    /// Check if attestation already exists for Light node in current slot
    pub fn has_attestation(&self, light_node_id: &str, slot: u64) -> bool {
        let key = format!("{}:{}", light_node_id, slot);
        let attestations = self.light_node_attestations.read();
        attestations.contains_key(&key)
    }

    /// True iff this light node already attested in the CURRENT reward epoch — checked against the
    /// block-epoch eligibility set (record_light_epoch_eligible keys by block_height/14400), i.e. the
    /// SAME clock as the reward. Skips re-pinging a node that already proved liveness this epoch. O(1).
    pub fn has_attestation_in_window(&self, light_node_id: &str) -> bool {
        let epoch = Self::get_current_window_number();
        self.epoch_light_eligible.read().get(&epoch)
            .map(|s| s.contains(light_node_id)).unwrap_or(false)
    }
    
    /// Get Light nodes to ping in current slot
    /// ARCHITECTURE v2.89: ONLY Genesis nodes ping Light nodes (reliability guarantee)
    ///   - 5 Genesis nodes → each pings 20% of ALL Light nodes (2M each for 10M total)
    ///   - Genesis nodes are ALWAYS online → 100% coverage guaranteed
    ///   - Non-Genesis nodes return empty list
    /// 
    /// RELIABILITY: Genesis nodes are stable infrastructure under our control
    /// If ANY Super node could ping, node failures = lost pings = lost rewards
    /// With Genesis-only pinging: 100% reliability, 100% coverage
    /// 
    /// SCALABILITY: 2M pings per Genesis per epoch = 139 pings/sec = easily handled
    pub fn get_light_nodes_to_ping(&self) -> Vec<(LightNodeRegistrationData, PingerRole)> {
        let current_slot = Self::get_current_slot();
        let current_window = Self::get_current_window_number();
        let our_node_id = &self.node_id;
        let mut result = Vec::new();

        // v2.89: ONLY Genesis nodes ping Light nodes (5 fixed shard owners, always online).
        let is_genesis_node = std::env::var("QNET_BOOTSTRAP_ID")
            .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
            .unwrap_or(false);
        if !is_genesis_node { return result; }
        let our_genesis_idx = std::env::var("QNET_BOOTSTRAP_ID")
            .ok().and_then(|id| id.parse::<usize>().ok())
            .map(|id| id.saturating_sub(1)).unwrap_or(0);

        if crate::node::is_info() {
            println!("[INFO][GENESIS-PING] Genesis node {} (idx={}) checking Light nodes to ping slot={}",
                     our_node_id, our_genesis_idx, current_slot);
        }

        let registry = self.light_node_registry.read();
        let reg_len = registry.len();

        // Rebuild this genesis's per-slot buckets only when the window rolls or the registry size changes.
        // Stable hash-shard (light_shard_of == our_genesis_idx) — roster-size-independent, so a node's owner
        // NEVER changes as the registry grows (no mid-epoch reshard) and it matches the committed bitmap's
        // shard exactly, so a reply always reaches the genesis that commits it. O(N) once per window.
        let need_rebuild = { let c = self.light_ping_slot_cache.read(); c.0 != current_window || c.1 != reg_len };
        if need_rebuild {
            let mut buckets: Vec<Vec<String>> = vec![Vec::new(); 240];
            for id in registry.keys() {
                if crate::node::light_shard_of(id) != our_genesis_idx { continue; }
                let slot = Self::calculate_randomized_slot(id, current_window) as usize;
                buckets[slot].push(id.clone());
            }
            *self.light_ping_slot_cache.write() = (current_window, reg_len, buckets);
        }

        // Read the 3 grace slots {cur, cur-1, cur-2} (mod 240). B: wake only plausibly-live nodes —
        // attested (own-shard recency, epoch map held once) or registered within the grace window. Dormant
        // nodes stop being woken (they self-attest on return); a fresh node gets its first ping via
        // registered_at. Liveness authority is on-chain; this is only a derived whom-to-wake hint.
        let now_secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        const WAKE_GRACE_EPOCHS: u64 = 3;
        let elig = self.epoch_light_eligible.read();
        let attested_recent = |id: &str| (0..WAKE_GRACE_EPOCHS)
            .any(|d| elig.get(&current_window.saturating_sub(d)).map(|s| s.contains(id)).unwrap_or(false));
        let this_epoch = |id: &str| elig.get(&current_window).map(|s| s.contains(id)).unwrap_or(false);
        let cache = self.light_ping_slot_cache.read();
        for g in 0..=2u64 {
            let s = ((current_slot + 240 - g) % 240) as usize;
            for node_id in cache.2.get(s).into_iter().flatten() {
                let node = match registry.get(node_id) { Some(n) => n, None => continue };
                if this_epoch(node_id) { continue; }  // already attested this epoch — nothing to wake
                let fresh = now_secs.saturating_sub(node.registered_at) < WAKE_GRACE_EPOCHS * 14400;
                if !fresh && !attested_recent(node_id) { continue; }  // dormant — self-attests on return
                result.push((node.clone(), PingerRole::Primary));
            }
        }

        if crate::node::is_debug() && !result.is_empty() {
            println!("[DBG][GENESIS-PING] Genesis {} has {} Light nodes to ping this slot (registry: {})",
                     our_genesis_idx + 1, result.len(), reg_len);
        }
        result
    }
    
    /// Shard-owner push-channel self-heal: when our stored record for a my-shard node is
    /// missing or polling while another genesis just served its attestation, pull that
    /// genesis's record and feed it through our OWN internal sync endpoint (localhost) —
    /// the same LWW receiver every peer sync uses, so storage + RAM registry stay in one
    /// path. Bounded: only degraded my-shard nodes, once per (node, epoch), 64k dedup cap.
    pub(super) fn maybe_pull_push_channel(node_id: &str, attestor_id: &str, epoch: u64) {
        fn pull_dedup() -> &'static dashmap::DashMap<String, u64> {
            static M: std::sync::OnceLock<dashmap::DashMap<String, u64>> = std::sync::OnceLock::new();
            M.get_or_init(dashmap::DashMap::new)
        }
        let degraded = match crate::node::try_get_storage() {
            Some(s) => s.get_fcm_record(node_id)
                .map(|(_, pt, _, _)| pt.eq_ignore_ascii_case("polling"))
                .unwrap_or(true),
            None => return,
        };
        if !degraded { return; }
        // Pad so the legacy unpadded id form ("genesis_node_1") still resolves.
        let digits: String = attestor_id.chars().filter(|c| c.is_ascii_digit()).collect();
        let digits = format!("{:0>3}", digits);
        if std::env::var("QNET_BOOTSTRAP_ID").ok().as_deref() == Some(digits.as_str()) { return; }
        let Some((ip, _)) = crate::genesis_constants::GENESIS_NODE_IPS.iter()
            .find(|(_, id)| *id == digits) else { return; };
        if pull_dedup().len() > 65_536 { pull_dedup().clear(); }
        if pull_dedup().insert(node_id.to_string(), epoch) == Some(epoch) { return; }
        let node = node_id.to_string();
        let src_ip = ip.to_string();
        tokio::spawn(async move {
            let client = match reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5)).build() { Ok(c) => c, Err(_) => return };
            let url = format!("http://{}:8001/api/v1/internal/fcm-token-get?node_id={}", src_ip, node);
            let v: serde_json::Value = match client.get(&url).send().await.ok()
                .and_then(|r| if r.status().is_success() { Some(r) } else { None })
            {
                Some(r) => match r.json().await { Ok(v) => v, Err(_) => return },
                None => return,
            };
            let (token, pt) = (v["token"].as_str().unwrap_or(""), v["push_type"].as_str().unwrap_or(""));
            if v["success"].as_bool() != Some(true) || token.is_empty() || pt.is_empty() { return; }
            let body = serde_json::json!({
                "pseudonym": node, "token": token, "push_type": pt,
                "endpoint": v["endpoint"].as_str().filter(|s| !s.is_empty()),
                "origin_ip": src_ip, "ts": v["ts"].as_u64(),
            });
            match client.post("http://127.0.0.1:8001/api/v1/internal/fcm-token-sync")
                .json(&body).send().await
            {
                Ok(r) if r.status().is_success() => {
                    if crate::node::is_info() {
                        println!("[INFO][LIGHT] push_channel_pulled node={} from={} push={}", node, src_ip, pt);
                    }
                }
                _ => if crate::node::is_debug() {
                    println!("[DBG][LIGHT] push_channel_pull_failed node={} from={}", node, src_ip);
                },
            }
        });
    }

    /// Update push_type + last_seen for a light node (called on token-refresh).
    pub fn update_light_node_push_type(&self, node_id: &str, push_type_str: &str, timestamp: u64) {
        let mut registry = self.light_node_registry.write();
        if let Some(node) = registry.get_mut(node_id) {
            node.push_type = match push_type_str {
                "fcm"         => PushType::FCM,
                "unifiedpush" => PushType::UnifiedPush,
                _             => PushType::Polling,
            };
            node.last_seen = timestamp;
        }
    }

    /// THE single writer for the attestation map. Both callers - the origination path (this genesis
    /// took the device's reply directly) and the gossip relay - go through here, so the key shape and
    /// the capacity bound cannot drift apart again.
    ///
    /// The key carries the EPOCH because that is the unit the credit it guards lives in: `slot` is
    /// hash(node_id) % 240 and so constant for a device, and the map is retained for
    /// RETENTION_PERIOD_SECS, so a slot-only key suppressed that device for every epoch in the window.
    pub(super) fn attestation_key(light_node_id: &str, slot: u64) -> String {
        let epoch = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 14400;
        format!("{}:{}:{}", light_node_id, slot, epoch)
    }

    pub(super) fn store_attestation(&self, a: LightNodeAttestation) {
        let key = Self::attestation_key(&a.light_node_id, a.slot);
        let now = a.timestamp;
        let mut attestations = self.light_node_attestations.write();
        if attestations.len() >= MAX_ATTESTATIONS_SIZE {
            let cutoff = now.saturating_sub(RETENTION_PERIOD_SECS);
            let before = attestations.len();
            attestations.retain(|_, v| v.timestamp > cutoff);
            let removed = before - attestations.len();
            if removed > 0 && crate::node::is_info() {
                println!("[INFO][P2P] attestations_pruned removed={} kept={}", removed, attestations.len());
            }
        }
        attestations.insert(key, a);
    }

    /// Gossip Light Node attestation after successful ping
    pub fn gossip_light_node_attestation(&self, attestation: LightNodeAttestation) {
        let msg = NetworkMessage::LightNodeAttestation {
            light_node_id: attestation.light_node_id.clone(),
            pinger_id: attestation.pinger_id.clone(),
            slot: attestation.slot,
            timestamp: attestation.timestamp,
            light_node_signature: attestation.light_node_signature.clone(),
            pinger_signature: attestation.pinger_signature.clone(),
            challenge: attestation.challenge.clone(),
            gossip_hop: 0,
            block_height: attestation.block_height, // v2.59: For epoch-based filtering
        };
        
        // Store locally first + record into the per-epoch eligibility set (the live origination
        // path: this genesis received the light node's ping reply directly).
        self.record_light_epoch_eligible(attestation.block_height, &attestation.light_node_id);
        self.store_attestation(attestation);

        // Gossip to peers
        self.gossip_to_random_peers(msg, 5);
    }
    
    /// v2.89: Get total registered Light node count
    pub fn get_light_node_count(&self) -> usize {
        let registry = self.light_node_registry.read();
        registry.len()
    }
    
    /// Register this node as active Super node and broadcast announcement (ASYNC)
    /// PRODUCTION: Use this in async contexts (warp handlers, tokio tasks)
    /// Called on startup and periodically (every 10 min)
    pub async fn register_as_active_node_async(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // v3.18: Full node type removed - only Light and Super remain
        let node_type_str = match self.node_type {
            NodeType::Super => "super",
            NodeType::Light => return, // Light nodes don't register
        };
        
        // Get reputation from blockchain (v2.21.5)
        let reputation = self.get_node_reputation_from_blockchain(&self.node_id);
        
        // Only register if rep >= MIN_CONSENSUS_REPUTATION
        if reputation < qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION {
            if crate::node::is_warn() {
                println!("[WARN][ACTIVE] register_skip reason=low_rep rep={:.1} min={:.0}",
                         reputation, qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION);
            }
            return;
        }

        // v9.3: Don't register if more than 1 macroblock behind network.
        // Syncing nodes must not participate in consensus — they can be selected
        // as producer but can't produce, causing network stall.
        let local_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire);
        let network_height = self.get_max_peer_height();
        if network_height > 90 && local_height + 90 < network_height {
            if crate::node::is_warn() {
                println!("[WARN][ACTIVE] register_skip reason=syncing local={} net={} gap={}",
                         local_height, network_height, network_height - local_height);
            }
            return;
        }

        // Register locally (v2.51: lock-free)
        self.active_full_super_nodes.insert(self.node_id.clone(), ActiveNodeInfo {
            node_id: self.node_id.clone(),
            node_type: node_type_str.to_string(),
            shard_id: self.shard_id,
            reputation,
            last_seen: now,
            block_height: local_height,
        });
        if crate::node::is_info() {
            println!("[INFO][ACTIVE] registered_async node={} type={} h={} total={}",
                     self.node_id, node_type_str, local_height, self.active_full_super_nodes.len());
        }
        
        // Sign with ASYNC Dilithium (proper quantum-resistant signature)
        let announcement_data = format!("active:{}:{}:{}:{}:{}", 
            self.node_id, node_type_str, self.shard_id, reputation as u64, now);
        let signature = match self.sign_dilithium_async(&announcement_data, &self.node_id).await {
            Some(sig) => sig,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][ACTIVE] announce_skip reason=dilithium_unavailable");
                }
                return; // Skip announcement if signing fails
            }
        };
        
        let msg = NetworkMessage::ActiveNodeAnnouncement {
            node_id: self.node_id.clone(),
            node_type: node_type_str.to_string(),
            shard_id: self.shard_id,
            reputation,
            timestamp: now,
            signature,
            gossip_hop: 0,
        };

        // v9.2: Adaptive fan-out — sqrt(peers), min 3, max 8.
        // 5 peers → 3, 25 peers → 5, 64 peers → 8 (cap).
        // Combined with 3-hop re-gossip (fan-out 3 each), total propagation:
        //   hop0: sqrt(n) peers, hop1: ×3, hop2: ×3 = sqrt(n) × 9
        //   At 1000 nodes: ~32 × 9 = ~288 messages (vs 5 × 9 = 45 fixed).
        //   At 5 nodes: 3 × 9 = 27 (covers all, same as before).
        // This matches epidemic gossip theory: O(sqrt(n)) fan-out achieves
        // O(log n) propagation rounds with high probability.
        let peer_count = self.connected_peers_lockfree.len().max(1);
        let adaptive_fanout = ((peer_count as f64).sqrt().ceil() as usize).clamp(3, 8);
        self.gossip_to_random_peers(msg, adaptive_fanout);
    }

    /// Register this node as active Super node (SYNC version for std::thread::spawn)
    /// WARNING: Only use in pure sync contexts where NO tokio runtime exists!
    pub fn register_as_active_node(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // v3.18: Full node type removed - only Light and Super remain
        let node_type_str = match self.node_type {
            NodeType::Super => "super",
            NodeType::Light => return, // Light nodes don't register
        };
        
        // Get current reputation
        // Get reputation from blockchain (v2.21.5)
        let reputation = self.get_node_reputation_from_blockchain(&self.node_id);
        
        // Only register if rep >= MIN_CONSENSUS_REPUTATION
        if reputation < qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION {
            if crate::node::is_warn() {
                println!("[WARN][ACTIVE] register_skip reason=low_rep rep={:.1} min={:.0}",
                         reputation, qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION);
            }
            return;
        }

        // v9.3: Don't register if syncing (>1 macroblock behind)
        let local_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire);
        let network_height = self.get_max_peer_height();
        if network_height > 90 && local_height + 90 < network_height {
            if crate::node::is_warn() {
                println!("[WARN][ACTIVE] register_skip reason=syncing local={} net={} gap={}",
                         local_height, network_height, network_height - local_height);
            }
            return;
        }

        // Register locally (v2.51: lock-free)
        self.active_full_super_nodes.insert(self.node_id.clone(), ActiveNodeInfo {
            node_id: self.node_id.clone(),
            node_type: node_type_str.to_string(),
            shard_id: self.shard_id,
            reputation,
            last_seen: now,
            block_height: local_height,
        });
        if crate::node::is_info() {
            println!("[INFO][ACTIVE] registered node={} type={} h={} total={}",
                     self.node_id, node_type_str, local_height, self.active_full_super_nodes.len());
        }
        
        // Sign with SYNC Dilithium (creates new runtime - safe in std::thread::spawn)
        let announcement_data = format!("active:{}:{}:{}:{}:{}", 
            self.node_id, node_type_str, self.shard_id, reputation as u64, now);
        let signature = match self.sign_heartbeat_dilithium(&announcement_data, &self.node_id) {
            Some(sig) => sig,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][ACTIVE] announce_skip reason=dilithium_unavailable");
                }
                return; // Skip announcement if signing fails
            }
        };
        
        let msg = NetworkMessage::ActiveNodeAnnouncement {
            node_id: self.node_id.clone(),
            node_type: node_type_str.to_string(),
            shard_id: self.shard_id,
            reputation,
            timestamp: now,
            signature,
            gossip_hop: 0,
        };

        // v9.2: Adaptive fan-out (same formula as async version)
        let peer_count = self.connected_peers_lockfree.len().max(1);
        let adaptive_fanout = ((peer_count as f64).sqrt().ceil() as usize).clamp(3, 8);
        self.gossip_to_random_peers(msg, adaptive_fanout);
    }

    /// Request active nodes list from peers (on startup)
    pub fn request_active_nodes_sync(&self) {
        let request = NetworkMessage::ActiveNodesRequest {
            requester_id: self.node_id.clone(),
        };
        self.gossip_to_random_peers(request, 3);
        if crate::node::is_info() {
            println!("[INFO][ACTIVE] sync_request sent_to=3_peers");
        }
    }
    
    /// Update active nodes from heartbeat (proves node is online)
    #[allow(dead_code)]
    pub(super) fn update_active_nodes_from_heartbeat(&self, node_id: &str, node_type: &str, timestamp: u64) {
        // Get current reputation
        // Get reputation from blockchain (v2.21.5)
        let reputation = self.get_node_reputation_from_blockchain(node_id);
        
        // Only track nodes with rep >= MIN_CONSENSUS_REPUTATION
        if reputation < qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION {
            return;
        }
        
        // Calculate shard from node_id
        let shard_id = Self::calculate_light_node_shard(node_id);
        
        // v9.3: Get peer height for sync tracking
        let peer_height = self.connected_peers_lockfree.iter()
            .find(|e| e.value().id == node_id)
            .map(|e| e.value().last_block_height)
            .unwrap_or(0);

        // Update active nodes map (v2.51: lock-free)
        self.active_full_super_nodes.insert(node_id.to_string(), ActiveNodeInfo {
            node_id: node_id.to_string(),
            node_type: node_type.to_string(),
            shard_id,
            reputation,
            last_seen: timestamp,
            block_height: peer_height,
        });
    }
    
    /// v9.3: Cleanup stale active nodes (not seen in 15 minutes) + height-based + capacity cap
    pub fn cleanup_stale_active_nodes(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let cutoff = now - (15 * 60);  // 15 minutes ago
        // Liveness reference = the QC-verified finalized frontier (convergent — every healthy node
        // agrees on it), NOT the peer-height median. That median is biased up by the producer's
        // pre-finality tip (relay-raised onto every relaying peer), so an honest peer reporting its
        // applied tip read ~200 below it and was false-evicted. A peer at/above the finalized
        // frontier is caught up by construction; only one genuinely below finality trips the gate.
        let network_height = crate::node::qc_verified_frontier_cached();

        // v33: snapshot the LIVE connected-peer height per node_id (refreshed every
        // HealthPing, ~15s — the authoritative committed tip) BEFORE the retain, so we
        // never nest DashMap locks. The height-based eviction below uses
        // max(gossip_snapshot, live_height): active_full_super_nodes.block_height is a
        // gossip snapshot that lags badly (observed: snap h=2160 while the node was
        // really at the tip 3148) and false-evicted healthy nodes → active-set churn
        // and a quorum risk at scale. A genuinely-behind node still evicts because its
        // live height is also behind.
        // Only a FRESH, authenticated height counts. A gossip-inserted peer carries sentinel
        // last_block_height=0 / attested_at=0 until its own signed signal lands; judging it by that 0
        // false-evicts a healthy peer (a cold-joiner's genesis sources before the first HealthPing). So
        // a peer with no fresh attestation is "height unknown" (live_known=false) → skip its height test.
        let mut live_heights: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for e in self.connected_peers_lockfree.iter() {
            let p = e.value();
            if p.last_block_height == 0 { continue; }
            if now.saturating_sub(p.last_height_attested_at) > PEER_HEIGHT_ATTEST_TTL_SECS { continue; }
            let slot = live_heights.entry(p.id.clone()).or_insert(0);
            if p.last_block_height > *slot {
                *slot = p.last_block_height;
            }
        }

        // A node still catching up has no trustworthy first-hand peer heights and DEPENDS on its peers —
        // never height-evict while we are ourselves below the frontier (the 15-min last_seen TTL still
        // reaps genuinely dead peers). Closes the cold-join "evict all sources → stall" failure.
        // Only a node that is itself synchronized (per the coordinator FSM — the single sync-status
        // source) may height-evict a peer it measures behind; the bootstrap window is always exempt.
        let self_synced = network_height <= 180 || crate::node::coordinator_is_synchronized();

        // v2.51: Lock-free cleanup — stale by time
        let before = self.active_full_super_nodes.len();
        self.active_full_super_nodes.retain(|node_id, v| {
            // Remove if not seen in 15 minutes
            if v.last_seen <= cutoff {
                return false;
            }
            // Height-evict ONLY a node we directly measure (>2 macroblocks below the QC frontier).
            // Don't apply during bootstrap (network_height <= 180) or to self (async local height).
            // v33: judge by the freshest known height, not the lagging gossip snapshot.
            // A node known only via a relayed ActiveNodeAnnouncement is NOT in connected_peers, so it
            // has no first-hand height sample (live_known=false; its gossip block_height is 0 when the
            // announcer wasn't a direct peer). Judging it by that sentinel 0 would false-evict a
            // healthy super-node at scale, where most of the active set is reached only by gossip — so
            // skip the height test for it and let the 15-min last_seen TTL (refreshed by continued
            // announcements) reap it if it actually goes silent. A genuinely-stuck DIRECT peer
            // (live_known, low height) still evicts.
            // Genesis/bootstrap nodes are the anchored sync sources of last resort — never height-evict
            // them (the 15-min TTL above still reaps a genuinely dead one).
            if crate::genesis_constants::is_legacy_genesis_node(node_id) {
                return true;
            }
            let live_known = live_heights.contains_key(node_id);
            let live_h = live_heights.get(node_id).copied().unwrap_or(0);
            let effective_h = v.block_height.max(live_h);
            if self_synced && live_known && network_height > 180 && effective_h + 180 < network_height && *node_id != self.node_id {
                if crate::node::is_info() {
                    println!("[INFO][P2P] evict_desynced node={} snap={} live={} net={}", node_id, v.block_height, live_h, network_height);
                }
                return false;
            }
            true
        });
        let removed = before - self.active_full_super_nodes.len();

        if removed > 0 {
            if crate::node::is_info() {
                println!("[INFO][P2P] removed {} stale/desynced active nodes", removed);
            }
        }

        // v9.0: Capacity cap to prevent unbounded memory growth at scale.
        // If still over limit after TTL eviction, evict oldest entries.
        const MAX_ACTIVE_NODES: usize = 10_000;
        let current_len = self.active_full_super_nodes.len();
        if current_len > MAX_ACTIVE_NODES {
            // Collect (key, last_seen) sorted by last_seen ascending
            let mut entries: Vec<(String, u64)> = self.active_full_super_nodes.iter()
                .map(|e| (e.key().clone(), e.value().last_seen))
                .collect();
            entries.sort_by_key(|e| e.1);

            let to_evict = current_len - MAX_ACTIVE_NODES;
            for (key, _) in entries.iter().take(to_evict) {
                self.active_full_super_nodes.remove(key);
            }
            if crate::node::is_warn() {
                println!("[WARN][CLEANUP] capacity_evict count={} cap={}", to_evict, MAX_ACTIVE_NODES);
            }
        }
    }
    
    /// Get count of active Super nodes (v2.51: lock-free)
    pub fn get_active_node_count(&self) -> usize {
        self.active_full_super_nodes.len()
    }
    
    /// Get list of active Super nodes with their status (v2.51: lock-free)
    /// Returns Vec<(node_id, node_type, last_seen)>
    pub fn get_active_full_super_nodes(&self) -> Vec<(String, String, u64)> {
        self.active_full_super_nodes.iter()
            .map(|entry| (entry.value().node_id.clone(), entry.value().node_type.clone(), entry.value().last_seen))
            .collect()
    }
    
    /// Byzantine-safe head ceiling: the (f+1)-th highest fresh last_block_height over CURRENTLY-connected
    /// in-set peers (round committee ∪ genesis). >=f+1 members attesting a height ⇒ >=1 honest ⇒ a real
    /// lower bound on the true tip, so stragglers cannot demote a tip the honest majority attests (a median
    /// would). 0 if <f+1 fresh corroborators ⇒ the clamp trusts raw (bootstrap/isolated). Self EXCLUDED
    /// (peer-only). SYNC-HINT oracle ONLY — sanctioned consumers: clamp_overclaim and the registration
    /// arm gate (both liveness hints; the on-chain attest_epoch verifier is the safety backstop) —
    /// never a consensus/failover input.
    pub fn corroborated_head_ceiling(&self) -> u64 {
        frontier_order_statistic(self.fresh_in_set_peer_heights())
    }

    // failover_frontier_ceiling REMOVED: the failover vote key is a pure function of the voter's
    // OWN verified chain + f+1 committee-signed window amplification — peer-claimed heights are
    // sync hints only and must never derive a consensus key (eclipse/staleness split honest votes).

    /// Fresh (attested within TTL) last_block_height of currently-connected in-set peers (committee ∪
    /// genesis). Shared builder for the head oracle, the failover frontier, and the production
    /// corroboration gate — a stale or unattested height must never be evidence we are at the tip.
    pub(crate) fn fresh_in_set_peer_heights(&self) -> Vec<u64> {
        let cc = CURRENT_COMMITTEE.read().clone();
        let now = self.current_timestamp();
        self.connected_peers_lockfree.iter()
            .filter(|e| {
                let p = e.value();
                let in_set = cc.members.contains(&p.id) || cc.genesis_ids.contains(&p.id)
                    || crate::genesis_constants::get_genesis_id_by_ip(p.addr.split(':').next().unwrap_or("")).is_some();
                in_set && p.last_block_height > 0
                    && now.saturating_sub(p.last_height_attested_at) < PEER_HEIGHT_ATTEST_TTL_SECS
            })
            .map(|e| e.value().last_block_height)
            .collect()
    }

    /// WIDENED head ceiling for the arm-liveness ladder ONLY. The newtype hard-quarantines the value:
    /// clamp_overclaim / get_best_peer_height / sync targeting / failover take u64 and CANNOT consume
    /// it by accident. Contributors are fresh connected NON-in-set peers (both link directions),
    /// Sybil-capped at ≤2 per /16 chosen by lexicographically-lowest peer id (not by height — the pick
    /// is not attacker-steerable), ≤16 total; each height is clamped to local_tip + DEFICIT_BOUND_WIDE
    /// + HEAD_OVERCLAIM_MARGIN before the order statistic (a HealthPing binds authorship, not truth —
    /// a tracking liar can otherwise defer the joiner forever). 0 if <4 capped contributors.
    pub fn corroborated_head_ceiling_widened(&self, local_tip: u64) -> WidenedCeiling {
        let cc = CURRENT_COMMITTEE.read().clone();
        let now = self.current_timestamp();
        let clamp = local_tip
            .saturating_add(DEFICIT_BOUND_WIDE)
            .saturating_add(HEAD_OVERCLAIM_MARGIN);
        let mut by_prefix: std::collections::BTreeMap<String, Vec<(String, u64)>> = std::collections::BTreeMap::new();
        for e in self.connected_peers_lockfree.iter() {
            let p = e.value();
            let ip = p.addr.split(':').next().unwrap_or("");
            let in_set = cc.members.contains(&p.id) || cc.genesis_ids.contains(&p.id)
                || crate::genesis_constants::get_genesis_id_by_ip(ip).is_some();
            if in_set { continue; } // strict oracle territory
            if p.last_block_height == 0
                || now.saturating_sub(p.last_height_attested_at) >= PEER_HEIGHT_ATTEST_TTL_SECS { continue; }
            let prefix = match extract_subnet_prefix(ip, 2) { Some(pfx) => pfx, None => continue };
            by_prefix.entry(prefix).or_default().push((p.id.clone(), p.last_block_height));
        }
        let mut contributors: Vec<u64> = Vec::new();
        'outer: for (_, mut peers) in by_prefix {
            peers.sort_by(|a, b| a.0.cmp(&b.0));
            for (_, h) in peers.into_iter().take(2) {
                contributors.push(h.min(clamp));
                if contributors.len() >= 16 { break 'outer; }
            }
        }
        WidenedCeiling(frontier_order_statistic(contributors))
    }

    /// Tier-1.5 of the arm-liveness ladder: dial the EXACT strict-predicate set
    /// (CURRENT_COMMITTEE.members ∪ genesis_ids) so a starved joiner earns strict corroborators.
    /// NOT committee_for_height(tip) — a starved joiner's finality lags its tip, and epoch-skewed
    /// members are absent from the predicate ⇒ add zero corroborators. Salt-ranked, capped, skips
    /// already-connected; genesis IPs are the pinned always-present floor.
    pub fn dial_in_set_for_arm(&self) {
        const ARM_DIAL_K: usize = 16;
        let cc = CURRENT_COMMITTEE.read().clone();
        use sha3::{Digest, Sha3_256};
        let salt = { let mut h = Sha3_256::new(); h.update(self.node_id.as_bytes()); h.finalize() };
        let mut ranked: Vec<(u64, String)> = cc.members.iter().chain(cc.genesis_ids.iter())
            .filter(|id| **id != self.node_id)
            .map(|id| {
                let mut h = Sha3_256::new(); h.update(&salt); h.update(id.as_bytes());
                let d = h.finalize();
                (u64::from_le_bytes(d[0..8].try_into().unwrap_or([0u8; 8])), id.clone())
            })
            .collect();
        ranked.sort_by_key(|(k, _)| *k);
        let mut addrs: Vec<String> = Vec::new();
        for (_, id) in ranked {
            if addrs.len() >= ARM_DIAL_K { break; }
            if self.peer_id_to_addr.contains_key(&id) { continue; }
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
                println!("[INFO][REG] arm_dial_in_set count={}", addrs.len());
            }
            self.connect_to_bootstrap_peers(&addrs);
        }
    }

    /// Anti-forgery CEILING for the height oracle (single source for get_best/get_max_peer_height): a
    /// verified head binds AUTHORSHIP not truth, so overrule a raw more than one macroblock above the
    /// (f+1)-corroborated tip — but NEVER below it (a stale-low median must not demote a tip the honest
    /// majority attests). ceiling==0 (bootstrap / no corroborator) => trust raw.
    pub fn clamp_overclaim(&self, raw: u64) -> u64 {
        let ceiling = self.corroborated_head_ceiling();
        if ceiling > 0 && raw > ceiling.saturating_add(HEAD_OVERCLAIM_MARGIN) {
            // Fires only on a demotion — lets a live replay tell "honest majority truly at ceiling"
            // from "a fresh-high tip was dropped".
            if crate::node::is_info() {
                println!("[WARN][ORACLE] overclaim_demote raw={} ceiling={} margin={}", raw, ceiling, HEAD_OVERCLAIM_MARGIN);
            }
            ceiling
        } else { raw }
    }

    /// v9.5: Highest reported height among connected peers — the tip oracle for the behind-decision,
    /// production-unlock and fork-resync, over-claim-clamped against the committee/genesis median.
    pub fn get_best_peer_height(&self) -> u64 {
        let raw = BEST_PEER_HEIGHT.load(std::sync::atomic::Ordering::Relaxed)
            .max(SIGNED_HEAD_MAX.load(std::sync::atomic::Ordering::Relaxed));
        self.clamp_overclaim(raw)
    }

    /// Re-sign LATEST_SIGNED_HEAD on finality advance so a cold-joiner's replied/co-sent head is fresh to
    /// within one rotation, not one 15s tick. Throttled (per-block Dilithium signing is wasted at scale);
    /// the 15s emit tick stays the backstop. height+sig kept consistent (verified over from:ts:height).
    pub fn refresh_signed_head_throttled(&self, height: u64) {
        if height == 0 || (height % HEAD_RESIGN_INTERVAL != 0 && height % 90 != 0) { return; }
        let id_guard = self.wallet_identity.read();
        let identity = match &*id_guard { Some(i) => i, None => return };
        let ts = self.current_timestamp();
        let payload = format!("QNET_HEALTH_PING_V1:{}:{}:{}", self.node_id, ts, height);
        if let Ok(sig) = identity.sign(payload.as_bytes()) {
            *LATEST_SIGNED_HEAD.write() = Some((self.node_id.clone(), ts, height, hex::encode(&sig)));
        }
    }

    /// v9.5: Recalculate BEST_PEER_HEIGHT from scratch by scanning all connected peers.
    /// Called when a peer disconnects (conditional: only if the disconnected peer's height
    /// was >= current BEST_PEER_HEIGHT). Also called periodically (every 30s) as safety net.
    /// O(N) where N = connected peers, but runs infrequently.
    pub fn recalculate_best_peer_height(&self) {
        // Monotonic: only RAISE. Never lower the best-known head from currently-connected (served-low)
        // peers — lowering re-collapses the target. Stale-high is bounded by the QC frontier floor.
        let new_best = self.connected_peers_lockfree.iter()
            .map(|entry| entry.value().last_block_height)
            .max()
            .unwrap_or(0);
        BEST_PEER_HEIGHT.fetch_max(new_best, std::sync::atomic::Ordering::Relaxed);
    }

    /// Get node reputation by ID
    /// DEPRECATED: Use get_node_reputation_from_blockchain() instead
    #[deprecated(note = "Use get_node_reputation_from_blockchain() for v2.21.5+")]
    pub fn get_node_reputation(&self, node_id: &str) -> f64 {
        // v2.21.5: Redirect to blockchain source
        self.get_node_reputation_from_blockchain(node_id)
    }
    
    /// Get delay before pinging based on role (Primary=0, Backup1=30s, Backup2=60s)
    pub fn get_ping_delay(&self, role: PingerRole) -> std::time::Duration {
        match role {
            PingerRole::Primary => std::time::Duration::from_secs(0),
            PingerRole::Backup1 => std::time::Duration::from_secs(30),
            PingerRole::Backup2 => std::time::Duration::from_secs(60),
            PingerRole::None => std::time::Duration::from_secs(u64::MAX),
        }
    }
    
    /// Cleanup old attestations (older than 24 hours)
    pub fn cleanup_old_attestations(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let cutoff = now - (24 * 60 * 60);  // 24 hours ago
        
        let mut attestations = self.light_node_attestations.write();
        let before = attestations.len();
        attestations.retain(|_, v| v.timestamp > cutoff);
        let removed = before - attestations.len();
        
        if removed > 0 {
            if crate::node::is_info() {
                println!("[INFO][P2P] Removed {} old attestations (>24h)", removed);
            }
        }
    }
    
    // ========================================================================
    // PRODUCTION: Methods for reward calculation (used by block producer)
    // ========================================================================
    
    /// Get all Light node attestations for a 4h window (for Merkle commitment)
    /// Returns Vec<(light_node_id, slot, pinger_id, timestamp)>
    /// DEPRECATED: Use get_attestations_for_block_range for deterministic emission
    pub fn get_attestations_for_window(&self, window_start_timestamp: u64) -> Vec<(String, u64, String, u64)> {
        let window_end = window_start_timestamp + (4 * 60 * 60);
        
        let attestations = self.light_node_attestations.read();
        attestations.values()
            .filter(|a| a.timestamp >= window_start_timestamp && a.timestamp < window_end)
            .map(|a| (a.light_node_id.clone(), a.slot, a.pinger_id.clone(), a.timestamp))
            .collect()
    }
    
    /// v2.64: Get Light node attestations filtered by BLOCK HEIGHT (deterministic!)
    /// Returns Vec<(light_node_id, slot, pinger_id, timestamp, block_height)>
    pub fn get_attestations_for_block_range(&self, start_height: u64, end_height: u64) -> Vec<(String, u64, String, u64, u64)> {
        let attestations = self.light_node_attestations.read();
        
        let result: Vec<_> = attestations.values()
            .filter(|a| a.block_height >= start_height && a.block_height < end_height)
            .map(|a| (a.light_node_id.clone(), a.slot, a.pinger_id.clone(), a.timestamp, a.block_height))
            .collect();
        
        // v2.95: Only log when there are attestations (avoid spam when no Light nodes)
        if !result.is_empty() && crate::node::is_info() {
            println!("[INFO][ATTESTATION] block_range_filter start={} end={} found={}", 
                     start_height, end_height, result.len());
        }
        
        result
    }
    
    /// v2.78: Get ALL ACTIVE registered Light node IDs for pinging
    /// FILTERS OUT:
    /// - Offline nodes (is_active=false, consecutive_failures>=5)
    /// - Ensures 100% coverage of ONLINE Light nodes only
    /// Returns Vec of active Light node IDs currently in registry
    pub fn get_all_light_node_ids(&self) -> Vec<String> {
        let registry = self.light_node_registry.read();
        registry.values()
            .filter(|node| {
                // PRODUCTION: Only active nodes
                // Offline nodes (>5 consecutive failures) are excluded
                node.is_active && node.consecutive_failures < 5
            })
            .map(|node| node.node_id.clone())
            .collect()
    }
    

    /// Is `node_id` in THIS genesis's shard? Stable hash-shard (crate::node::light_shard_of) — O(1),
    /// roster-size-INDEPENDENT, no cache: a node's shard never changes as the roster grows, so record-time
    /// and bitmap-build-time always agree. Non-genesis ⇒ false (its eligibility feeds no committed bitmap).
    pub(super) fn node_in_my_shard_for_epoch(&self, _epoch: u64, node_id: &str) -> bool {
        let idx = match std::env::var("QNET_BOOTSTRAP_ID").ok()
            .filter(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
            .and_then(|id| id.parse::<usize>().ok())
        {
            Some(n) => n.saturating_sub(1),
            None => return false,
        };
        crate::node::light_shard_of(node_id) == idx
    }

    /// Record an attested light node into the per-epoch eligibility set (uncapped) + prune old epochs.
    pub(super) fn record_light_epoch_eligible(&self, block_height: u64, light_node_id: &str) {
        const EPOCH_BLOCKS: u64 = 14400;
        let epoch = block_height / EPOCH_BLOCKS;
        let (inserted, new_epoch) = {
            let mut map = self.epoch_light_eligible.write();
            let new_epoch = !map.contains_key(&epoch);
            let inserted = map.entry(epoch).or_default().insert(light_node_id.to_string());
            if map.len() > 3 {
                let keep_from = epoch.saturating_sub(2);
                map.retain(|e, _| *e >= keep_from);
            }
            (inserted, new_epoch)
        };
        // Persist for genesis restart resilience (bitmap is built from RAM); prune old persisted epochs
        // only on the first attestation of a new epoch — O(roster) once/epoch, not per ping.
        if inserted {
            if let Some(storage) = crate::node::try_get_storage() {
                let _ = storage.save_light_epoch_eligible(epoch, light_node_id);
                if new_epoch { let _ = storage.prune_light_epoch_eligible(epoch.saturating_sub(2)); }
            }
        }
    }

    /// Boot rebuild of the per-epoch light-eligibility map from storage (genesis restart resilience):
    /// without it a restart drops a shard's pre-restart attestations before the boundary bitmap TX.
    pub fn rebuild_light_eligible_from_storage(&self, current_height: u64) {
        let from_epoch = (current_height / 14400).saturating_sub(2);
        if let Some(storage) = crate::node::try_get_storage() {
            if let Ok(entries) = storage.load_light_epoch_eligible(from_epoch) {
                if entries.is_empty() { return; }
                let n = entries.len();
                let mut map = self.epoch_light_eligible.write();
                for (epoch, node_id) in entries { map.entry(epoch).or_default().insert(node_id); }
                drop(map);
                if crate::node::is_info() {
                    println!("[INFO][LIGHT-BITMAP] epoch_eligible_rebuilt entries={} from_epoch={}", n, from_epoch);
                }
            }
        }
    }

    /// All light node_ids attested in `epoch` (uncapped union of received + gossiped pings).
    pub fn get_light_eligible_for_epoch(&self, epoch: u64) -> Vec<String> {
        self.epoch_light_eligible.read().get(&epoch)
            .map(|s| s.iter().cloned().collect()).unwrap_or_default()
    }

    /// Get eligible Light nodes for rewards in current window
    /// Returns Vec<(node_id, wallet_address)> for nodes with at least 1 attestation
    /// DEPRECATED: Use get_eligible_light_nodes_by_height for deterministic emission
    pub fn get_eligible_light_nodes(&self, window_start_timestamp: u64) -> Vec<(String, String)> {
        let attestations = self.get_attestations_for_window(window_start_timestamp);
        let registry = self.light_node_registry.read();
        
        // Dedupe by node_id (only need 1 attestation per Light node)
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut eligible = Vec::new();
        
        for (node_id, _, _, _) in attestations {
            if seen.insert(node_id.clone()) {
                if let Some(reg) = registry.get(&node_id) {
                    eligible.push((node_id, reg.wallet_address.clone()));
                }
            }
        }
        
        eligible
    }
    
    /// v2.64: Get eligible Light nodes by BLOCK HEIGHT (deterministic!)
    pub fn get_eligible_light_nodes_by_height(&self, start_height: u64, end_height: u64) -> Vec<(String, String)> {
        let attestations = self.get_attestations_for_block_range(start_height, end_height);
        let registry = self.light_node_registry.read();
        
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut eligible = Vec::new();
        
        for (node_id, _, _, _, _) in attestations {
            if seen.insert(node_id.clone()) {
                if let Some(reg) = registry.get(&node_id) {
                    eligible.push((node_id.clone(), reg.wallet_address.clone()));
                }
            }
        }
        
        if crate::node::is_info() {
            println!("[INFO][LIGHT_ELIGIBILITY] block_range h={}-{} eligible={}", 
                     start_height, end_height, eligible.len());
        }
        
        eligible
    }
    
    /// Get Light node wallet address from registry
    pub fn get_light_node_wallet(&self, node_id: &str) -> Option<String> {
        let registry = self.light_node_registry.read();
        registry.get(node_id).map(|r| r.wallet_address.clone())
    }
}

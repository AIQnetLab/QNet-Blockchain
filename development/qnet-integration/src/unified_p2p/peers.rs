//! Peer table, admission, scoring, discovery and rate limiting.

use super::*;

impl SimplifiedP2P {
    /// Handle incoming network message
    pub fn handle_message(&self, from_peer: &str, message: NetworkMessage) {
        // CRITICAL FIX v2.19.15: Auto-add peer to connected_peers when receiving
        // consensus-related messages (Block, Heartbeat, Certificate, etc.)
        // This fixes Genesis startup race condition where peers couldn't connect
        // because test_peer_connectivity_static() failed during simultaneous startup.
        // If they can send us a message → they are DEFINITELY reachable!
        //
        // IMPORTANT: Do NOT call ensure_peer_connected for Light node messages!
        // Light nodes are stored in light_node_registry, NOT connected_peers.
        // Light nodes only register and get pinged - they don't participate in consensus.
        let should_auto_add = !matches!(&message, 
            NetworkMessage::LightNodeRegistration { .. } |
            NetworkMessage::LightNodeAttestation { .. }
        );
        if should_auto_add {
            self.ensure_peer_connected(from_peer);
        }
        
        match message {
            NetworkMessage::ConsensusV2 { data } => {
                // Consensus v2 (Checkpoint-BFT): route raw bytes to the v2 runtime task.
                crate::consensus_v2_node::route_inbound(data);
            }
            NetworkMessage::Block { height, data, block_type } => {
                // Liveness only: the relayed block height is an availability fact, not the peer tip.
                self.update_peer_last_seen(from_peer);
                
                // Log only every 10th block
                if height % 10 == 0 {
                if crate::node::is_info() {
                    println!("[INFO][P2P] Received {} block #{} from {} ({} bytes)", 
                             block_type, height, from_peer, data.len());
                }
                }
                
                // ARCHITECTURE: Unified block validation for ALL blocks (no special "genesis phase")
                // - Microblocks: Validated via ML-DSA-65 signature (quantum-resistant)
                // - Macroblocks: Require Byzantine consensus (BFT with 4+ nodes)
                // This ensures consistent security from block 0 to infinity
                
                let is_macroblock = block_type == "macro";
                
                // Byzantine consensus check ONLY for macroblocks (finalization checkpoints)
                // Microblocks are secured by quantum signatures, not BFT
                if is_macroblock {
                    let validated_peers = self.get_validated_active_peers();
                    let network_node_count = validated_peers.len() + 1; // +1 for self
                    
                    if network_node_count < 4 {
                        // Allow sync for bootstrap nodes catching up
                        let is_bootstrap_node = std::env::var("QNET_BOOTSTRAP_ID").is_ok();
                        
                        if is_bootstrap_node && height > 0 {
                            if crate::node::is_info() {
                                println!("[WARN][SECURITY] ACCEPTING macroblock #{} for sync - bootstrap mode with {} nodes", height, network_node_count);
                            }
                            // Continue to process block for synchronization
                        } else {
                            if crate::node::is_info() {
                                println!("[WARN][SECURITY] REJECTING macroblock #{} - Byzantine consensus required: {} nodes < 4", height, network_node_count);
                            }
                            if crate::node::is_info() {
                                println!("[INFO][SECURITY] Block from {} discarded - network must have 4+ validated nodes", from_peer);
                            }
                            return; // Reject block without processing
                        }
                    }
                }
                // Microblocks: No Byzantine check needed - quantum signature validation in block processing
                
                // PRODUCTION: Silent diagnostic check for scalability  
                let block_tx_guard = self.block_tx.lock();
                match &*block_tx_guard {
                    Some(_) => {},
                    None => { if crate::node::is_warn() { println!("[WARN][P2P] block_channel_missing"); } },
                }
                
                // PRODUCTION: Send block to main node for processing via storage
                if let Some(ref block_tx) = &*block_tx_guard {
                    // v11.1: Track pending (not a gate) — storage-level dedup in node.rs
                    mark_block_pending_sync(height);

                    let received_block = ReceivedBlock {
                        height,
                        data,
                        block_type: block_type.clone(),
                        from_peer: from_peer.to_string(),
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    };
                    
                    match block_tx.try_send(received_block.clone()) {
                        Ok(_) => {
                            if crate::node::is_info() {
                                println!("[INFO][P2P] {} block #{} queued for processing", block_type, height);
                            }

                            // Per-block crawl escalation: a gossiped block above our tip nudges the
                            // authenticated desync check so a deep follower jumps to bulk instead of
                            // crawling one block per relay. Nudge-only (never a sync target), cooldown-gated.
                            {
                                let local_h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                                if height > local_h.saturating_add(HEAD_REPLY_MIN_GAP) {
                                    static BLOCK_NUDGE_COOLDOWN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                                    if now > BLOCK_NUDGE_COOLDOWN.load(std::sync::atomic::Ordering::Relaxed) + 2 {
                                        BLOCK_NUDGE_COOLDOWN.store(now, std::sync::atomic::Ordering::Relaxed);
                                        crate::sync_manager::nudge_sync_check();
                                    }
                                }
                            }

                            // No re-gossip here, deliberately. This lane has no honest originator:
                            // producers propagate via ShredProtocol and sync/repair via BlocksBatch, so
                            // forwarding would only amplify attacker-injected traffic. Ingest below
                            // still accepts the block.
                        }
                        Err(e) => {
                            // v3.0: Clear pending on error so block can be retried
                            clear_block_pending_sync(height);
                            if crate::node::is_warn() {
                                println!("[ERR][P2P] Failed to queue {} block #{}: {}", block_type, height, e);
                            }
                        }
                    }
                } else {
                    // v3.0: Clear pending - channel not available
                    clear_block_pending_sync(height);
                    if crate::node::is_warn() {
                        println!("[WARN][P2P] Block processing channel not available - block #{} discarded", height);
                    }
                    if crate::node::is_info() {
                        println!("[ERR][P2P] CRITICAL: Block channel was LOST after setup!");
                    }
                }
                drop(block_tx_guard); // Explicitly drop the lock
            }
            
            NetworkMessage::Transaction { data } => {
                // Update last_seen for the peer who sent the transaction
                self.update_peer_last_seen(from_peer);
                
                // ANTI-STORM v2.25: Calculate hash FIRST for deduplication
                let tx_hash = format!("{:x}", sha3::Sha3_256::digest(&data));
                
                // ANTI-STORM: Check if we've already seen this TX
                // If seen - skip processing AND gossip (prevents exponential amplification)
                if self.seen_tx_hashes.contains(&tx_hash) {
                    // Already processed - skip silently to avoid log spam
                    return;
                }
                
                // Mark as seen BEFORE processing (prevents race conditions)
                // v9.1: Capacity cap — clear if exceeding 1M entries to prevent OOM
                // between periodic 60s cleanup cycles (e.g., during TX flood)
                if self.seen_tx_hashes.len() > 1_000_000 {
                    self.seen_tx_hashes.clear();
                    if crate::node::is_warn() {
                        println!("[WARN][ANTI-STORM] seen_tx_hashes emergency_clear cap=1M");
                    }
                }
                self.seen_tx_hashes.insert(tx_hash.clone());
                
                // PRODUCTION v2.19.25: Full transaction processing
                let tx_guard = self.transaction_tx.lock();
                
                if let Some(ref tx_sender) = *tx_guard {
                    // Create received transaction for processing
                    let received_tx = ReceivedTransaction {
                        tx_hash: tx_hash.clone(),
                        tx_data: data.clone(),
                        from_peer: from_peer.to_string(),
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    };
                    
                    // Send to node for validation and mempool addition
                    match tx_sender.try_send(received_tx) {
                        Ok(_) => {
                            if crate::node::is_debug() {
                                println!("[DBG][P2P] Transaction {} from {} queued for processing",
                                         qnet_state::char_prefix(&tx_hash, 16), from_peer);
                            }
                        }
                        Err(e) => {
                            if crate::node::is_warn() {
                                println!("[ERR][P2P] Failed to queue transaction: {}", e);
                            }
                        }
                    }
                } else {
                    if crate::node::is_warn() {
                        println!("[WARN][P2P] Transaction channel not available - tx from {} discarded", from_peer);
                    }
                }
                drop(tx_guard);
                
                // GOSSIP: Forward transaction to other peers (low fanout to avoid spam)
                // OPTIMIZATION: Moved OUTSIDE lock to prevent holding mutex during network ops
                // Never relay back to the peer it came from — echo suppression.
                let gossip_msg = NetworkMessage::Transaction { data };
                self.gossip_to_random_peers_excluding(gossip_msg, 2, from_peer);
            }
            
            // PRODUCTION v2.25: Transaction batch processing for high-throughput
            NetworkMessage::TransactionBatch { transactions, timestamp: _ } => {
                self.update_peer_last_seen(from_peer);
                
                // ANTI-STORM v2.25: Filter out already-seen transactions
                // v9.1: Capacity cap — emergency clear at 1M to prevent OOM
                if self.seen_tx_hashes.len() > 1_000_000 {
                    self.seen_tx_hashes.clear();
                    if crate::node::is_warn() {
                        println!("[WARN][ANTI-STORM] seen_tx_hashes emergency_clear cap=1M");
                    }
                }
                // SECURITY: Cap batch size to prevent OOM from oversized P2P batches
                const MAX_TX_BATCH_SIZE: usize = 10_000;
                if transactions.len() > MAX_TX_BATCH_SIZE {
                    if crate::node::is_warn() {
                        println!("[WARN][P2P] tx_batch_oversized count={} cap={} peer={}",
                                transactions.len(), MAX_TX_BATCH_SIZE, from_peer);
                    }
                    return;
                }
                let mut new_txs: Vec<Vec<u8>> = Vec::with_capacity(transactions.len());
                for tx_data in &transactions {
                    let tx_hash = format!("{:x}", sha3::Sha3_256::digest(tx_data));
                    if !self.seen_tx_hashes.contains(&tx_hash) {
                        self.seen_tx_hashes.insert(tx_hash);
                        new_txs.push(tx_data.clone());
                    }
                }
                
                // Skip if all TXs were already seen
                if new_txs.is_empty() {
                    return;
                }
                
                let tx_guard = self.transaction_tx.lock();
                
                if let Some(ref tx_sender) = *tx_guard {
                    let mut processed = 0usize;
                    
                    for tx_data in &new_txs {
                        let tx_hash = format!("{:x}", sha3::Sha3_256::digest(tx_data));
                        
                        let received_tx = ReceivedTransaction {
                            tx_hash: tx_hash.clone(),
                            tx_data: tx_data.clone(),
                            from_peer: from_peer.to_string(),
                            timestamp: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs(),
                        };
                        
                        if tx_sender.try_send(received_tx).is_ok() {
                            processed += 1;
                        }
                    }
                    
                    if processed > 0 {
                        if crate::node::is_info() {
                            println!("[INFO][P2P] Transaction batch: {}/{} new TXs from {} queued", 
                                     processed, new_txs.len(), from_peer);
                        }
                    }
                }
                drop(tx_guard);
                
                // GOSSIP: Forward ONLY NEW transactions, never back to the sender.
                if !new_txs.is_empty() {
                    let gossip_msg = NetworkMessage::TransactionBatch {
                        transactions: new_txs,
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    };
                    self.gossip_to_random_peers_excluding(gossip_msg, 2, from_peer);
                }
            }
            
            NetworkMessage::PeerDiscovery { requesting_node } => {
                // Same admission funnel as PeerListResponse: the identity bound to an address comes
                // from the pinned genesis table or the chain-committed endpoint, never from the wire,
                // and every wire-supplied id/region/score/height is discarded. The entry is a dial
                // CANDIDATE only — it still faces the full inbound gate when the sweep admits it.
                let ip = requesting_node.addr.split(':').next().unwrap_or("");
                let bound_id = match Self::gossip_bound_identity(&requesting_node.id, ip) {
                    Some(id) => id,
                    None => {
                        if crate::node::is_warn() {
                            println!("[WARN][P2P] peer_admission_rejected reason=unbound_identity via=peer_discovery peer={} relay={}",
                                     get_privacy_id_for_addr(ip), get_privacy_id_for_addr(from_peer));
                        }
                        return;
                    }
                };
                if bound_id == self.node_id { return; }
                let mut peer_info = match Self::parse_peer_address_static(&requesting_node.addr) {
                    Ok(pi) => pi,
                    Err(_) => return,
                };
                peer_info.id = bound_id;
                peer_info.reputation = self.get_node_reputation_from_blockchain(&peer_info.id);
                peer_info.consensus_score = peer_info.reputation;
                peer_info.last_block_height = 0;
                peer_info.last_height_attested_at = 0;
                // Learned from gossip, never chosen by us ⇒ consumes an inbound slot.
                peer_info.is_outbound = false;
                if crate::node::is_info() {
                    println!("[INFO][P2P] peer_discovery id={} region={}",
                             peer_info.id, region_string(&peer_info.region));
                }
                Self::push_regional_peer(&self.regional_peers, peer_info);
            }
            
            NetworkMessage::HealthPing { from, timestamp, height, cert_mb, cert_round, signature } => {
                // SyncInfo FIRST (pull-only, cooldown-gated — cannot poison state or the dedup floor).
                self.process_tc_claim(cert_mb, cert_round);
                // Dedup BEFORE verify+rate-limit. The serve-envelope co-sends the cached head on every
                // block-serve (hundreds/min during catch-up), but the origin re-signs only once per emit
                // tick — between ticks every co-send repeats one (ts,height). Skip repeats here: O(1), no
                // Dilithium verify, no rate-limit spend. So an honest co-send flood costs nothing and the
                // count-limit is reached only by genuinely new heads. Key = claimed `from`; the marker is
                // advanced ONLY after a successful verify below, so a spoofed future-ts (invalid sig)
                // cannot poison a real origin's dedup floor.
                let (last_head_ts, last_head_h) = LAST_HEAD_TS.get(&from).map(|e| *e.value()).unwrap_or((0, 0));
                if timestamp <= last_head_ts && height <= last_head_h {
                    return;
                }

                // v9.1: Rate limit a NEW head BEFORE ML-DSA-65 verify (~35ms CPU each) — bounds verify
                // CPU under a spoofed-origin/distinct-ts flood. Honest new heads are ~1/emit-tick per
                // peer, far under the cap; the count-limit gates verify CPU, never the monotonic oracle.
                if self.is_consensus_rate_limited(from_peer, "health_ping", 60) {
                    return;
                }

                // v8.0: signature, not freshness, authorizes the height. A valid Dilithium sig proves the
                // SENDER sent this height; age_secs is anti-replay diagnostics only (clock drift ≠ forgery).
                let now_ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let age_secs = if now_ts >= timestamp { now_ts - timestamp } else { timestamp - now_ts };

                let sig_verified = !signature.is_empty()
                    && Self::verify_health_ping_signature(&from, timestamp, height, &signature);

                if sig_verified {
                    // Authenticated head = the tip oracle (never a served-block height). Advance the dedup
                    // marker (post-verify: anti-poison + anti-replay), then the monotonic oracle for any
                    // verified peer.
                    LAST_HEAD_TS.insert(from.clone(), (timestamp.max(last_head_ts), height.max(last_head_h)));
                    let prev_max = SIGNED_HEAD_MAX.fetch_max(height, std::sync::atomic::Ordering::Relaxed);
                    self.update_peer_last_seen_with_height(&from, Some(height), true);
                    // Relay outward only a head that jumps the known tip by >= HEAD_REPLY_MIN_GAP. Heads
                    // arrive in ~emit-interval jumps, so this quenches the gossip wave at caught-up nodes
                    // (no relay when already near the head) while a lagging node still learns the real tip
                    // and re-arms within one gap. fetch_max above stays unconditional (oracle never lags).
                    if height > prev_max.saturating_add(HEAD_REPLY_MIN_GAP) {
                        let (hint_mb, hint_round) = current_tc_hint();
                        self.relay_signed_head(NetworkMessage::HealthPing {
                            from: from.clone(), timestamp, height,
                            cert_mb: hint_mb, cert_round: hint_round,
                            signature: signature.clone(),
                        }, &from, from_peer, 6);
                    }
                    if crate::node::is_debug() && height % 100 == 0 {
                        println!("[DBG][P2P] health_ping from={} h={} sig=verified age={}s", from, height, age_secs);
                    }
                } else {
                    self.update_peer_last_seen_with_height(&from, None, false);
                    if crate::node::is_debug() {
                        println!("[DBG][P2P] health_ping from={} h={} sig=rejected age={}s", from, height, age_secs);
                    }
                }
            }

            NetworkMessage::ProducerHeartbeat { producer_id, timestamp, slot_height, anchor_hash, signature } => {
                // v16.1: remote producer liveness signal. Verified ML-DSA-65
                // signature proves the producer is alive and aware of the
                // current slot. Receivers update REMOTE_PRODUCER_HEARTBEAT_MS
                // and the watchdog uses this to trigger empty-slot
                // attestation IMMEDIATELY when the elected producer goes
                // silent (no need to wait for next producer-loop tick).
                //
                // v17.1: IP-anchor gate intentionally NOT applied here.
                // ProducerHeartbeat is gossip-relayed; `from_peer` carries
                // the relay's IP, not the originator's, so anchoring rejected
                // legitimate gossip and broke 2f+1 quorum (macroblock #2
                // stuck on testnet). Identity binding is enforced
                // cryptographically by `verify_consensus_signature` below
                // against the immutable consensus PK registry — paired with
                // the Fix #2 removal of the legacy bootstrap fallback in
                // quantum_crypto.rs, that path is the canonical security
                // gate and is gossip-safe.
                //
                // v18: COUNT-BASED RATE LIMIT REMOVED. Heartbeat is signed
                // by the producer's registered ML-DSA-65 key — verification
                // below is the canonical security gate. The natural emission
                // cap is the monotonic-timestamp anti-replay guard immediately
                // below (one accepted heartbeat per producer per timestamp),
                // and the producer-side throttle in the broadcast loop
                // (NETWORK_HEARTBEAT_INTERVAL_MS = 1 s). Pre-v18 the receiver
                // also enforced 60 / min per-producer count, which collided
                // with the legitimate per-second cadence under transient
                // gossip duplication and dropped honest heartbeats.
                //
                // Anti-replay: monotonic timestamp guard per producer. Older
                // timestamps are silently ignored (no signature verify cost
                // for stale replays).
                if let Some(prev) = REMOTE_PRODUCER_HEARTBEAT_MS.get(&producer_id) {
                    let prev_ts = *prev.value();
                    if timestamp <= prev_ts {
                        return;
                    }
                }

                // Signature is verified over the WIRE anchor (self-authenticating), not a locally
                // reconstructed one — an honest producer at its own tip we do not yet hold no longer
                // fails here. Same registry as TimeoutVote (pk_mismatch still rejects a spoof).
                let msg = format!(
                    "QNET_PRODUCER_HEARTBEAT_V3:{}:{}:{}:{}",
                    producer_id, timestamp, slot_height, anchor_hash
                );
                let sig_str = match String::from_utf8(signature.clone()) {
                    Ok(s) => s,
                    Err(_) => {
                        if crate::node::is_warn() {
                            println!(
                                "[WARN][HEARTBEAT] sig_not_utf8 producer={} len={}",
                                producer_id, signature.len()
                            );
                        }
                        return;
                    }
                };
                if !self.verify_consensus_signature(&producer_id, &msg, &sig_str) {
                    if crate::node::is_warn() {
                        println!("[WARN][HEARTBEAT] sig_invalid producer={}", producer_id);
                    }
                    return;
                }

                // Anchor verdict against our own chain, three-valued:
                //   CONTRADICTS  — we hold slot-1 and it differs ⇒ a lie about the frontier; drop.
                //   MATCH        — we hold slot-1 and it agrees ⇒ full trust: update liveness AND the
                //                  height map that can suppress a view-change.
                //   UNKNOWN      — we do not hold slot-1 ⇒ signature is valid but unprovable: record
                //                  liveness (leader is not dead) but NEVER the height, so a claim about a
                //                  slot we cannot check can never suppress the vote that would rotate it.
                let local = self.storage.as_ref()
                    .and_then(|st| st.get_microblock_hash_hex(slot_height.saturating_sub(1)).ok().flatten());
                let anchor_known = local.is_some();
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                match heartbeat_anchor_verdict(local.as_deref(), &anchor_hash) {
                    HeartbeatAnchor::Contradicts => {
                        if crate::node::is_warn() {
                            println!("[WARN][HEARTBEAT] anchor_contradicts producer={} slot_h={} action=drop", producer_id, slot_height);
                        }
                        return;
                    }
                    HeartbeatAnchor::Match => {
                        REMOTE_PRODUCER_HEARTBEAT_MS.insert(producer_id.clone(), timestamp);
                        REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS.insert(producer_id.clone(), now_ms);
                        REMOTE_PRODUCER_HEARTBEAT_HEIGHT.insert(producer_id.clone(), slot_height);
                    }
                    HeartbeatAnchor::Unknown => {
                        REMOTE_PRODUCER_HEARTBEAT_MS.insert(producer_id.clone(), timestamp);
                        REMOTE_PRODUCER_HEARTBEAT_OBSERVED_MS.insert(producer_id.clone(), now_ms);
                    }
                }

                if crate::node::is_debug() {
                    println!(
                        "[DBG][HEARTBEAT] received producer={} slot_h={} ts={} anchor_known={}",
                        producer_id, slot_height, timestamp, anchor_known
                    );
                }
            }

            NetworkMessage::BlockRejection {
                height,
                source_peer_id,
                rejected_hash,
                observer_id,
                expected_prev_hash,
                signature,
            } => {
                // v16.2: observer-based fork detection. Each honest node
                // that rejected a forked block from `source_peer_id` at
                // `height` broadcasts this. Aggregating 2f+1 distinct
                // observer signatures justifies destructive rollback.
                //
                // v17.1: IP-anchor gate intentionally NOT applied here. This
                // message is gossip-relayed and `from_peer` is the relay,
                // not the originator. The 2f+1 quorum is protected by the
                // observer-signature verification below, which checks
                // ML-DSA-65 against the immutable consensus PK registry
                // (Fix #2/#3 close the legacy fallback). A non-genesis
                // spoofer cannot mint a valid signature under a genesis PK.

                // v18: COUNT-BASED RATE LIMIT REMOVED. BlockRejection is
                // ML-DSA-65 signed by the observer's registered key. Natural
                // cap is distinct-observer dedup in BLOCK_REJECTION_OBSERVERS
                // (one rejection per (height, source) per observer).
                // Pre-v18 the receiver also rate-limited at 30/min per peer,
                // which under fork events with multiple peers reporting
                // could drop legitimate observer signatures and prevent
                // 2f+1 destructive-rollback evidence accumulation.
                let payload = format!(
                    "QNET_BLOCK_REJECTION_V1:{}:{}:{}:{}:{}",
                    observer_id,
                    height,
                    source_peer_id,
                    hex::encode(&rejected_hash),
                    hex::encode(&expected_prev_hash)
                );
                let sig_str = match String::from_utf8(signature.clone()) {
                    Ok(s) => s,
                    Err(_) => {
                        if crate::node::is_warn() {
                            println!(
                                "[WARN][REJECT] sig_not_utf8 observer={} height={}",
                                observer_id, height
                            );
                        }
                        return;
                    }
                };
                if !self.verify_consensus_signature(&observer_id, &payload, &sig_str) {
                    if crate::node::is_warn() {
                        println!(
                            "[WARN][REJECT] sig_invalid observer={} height={} source={}",
                            observer_id, height, source_peer_id
                        );
                    }
                    return;
                }

                // Reject self-attestation: a peer cannot count itself toward
                // its own destructive rollback evidence.
                if observer_id == source_peer_id {
                    return;
                }

                // Distinct-observer accumulation per (height, source) tuple. The sweep this map
                // documents (cleanup_block_rejections) has no callers, and source_peer_id is a wire
                // field - so one registered observer key could open unbounded keys. Sweep here,
                // against the local tip, which is the same floor the sweep helper takes.
                // Floor at FINALITY, not at the tip: below the finalized height a rejection can no
                // longer justify anything (the supersede path refuses to reorg finalized history), while
                // a tip-derived floor would discard live evidence on a node that ran ahead.
                let floor = crate::node::LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::SeqCst);
                BLOCK_REJECTION_OBSERVERS.retain(|(h, _), _| *h >= floor);
                let count_after = {
                    let entry = BLOCK_REJECTION_OBSERVERS
                        .entry((height, source_peer_id.clone()))
                        .or_insert_with(DashSet::new);
                    entry.insert(observer_id.clone());
                    entry.len()
                };

                if crate::node::is_debug() {
                    println!(
                        "[DBG][REJECT] aggregated observer={} source={} h={} count={}",
                        observer_id, source_peer_id, height, count_after
                    );
                }

                // Threshold keyed on the WINDOW COMMITTEE (≤ cap), not the unbounded PK registry: at
                // scale registry_len is ~100k so quorum_size would need ~66k distinct rejections that
                // gossip never accumulates → the heuristic goes silently dead. The failover committee is
                // the same ≤cap set the vote gates use; genesis era → the small genesis fallback.
                let committee_n = failover_committee_for_window(height / 90)
                    .map(|c| c.len())
                    .unwrap_or(crate::genesis_constants::GENESIS_CONSENSUS_PKS.len());
                let two_f_plus_1 = qnet_consensus::checkpoint_bft::quorum_size(committee_n).max(3);

                if count_after >= two_f_plus_1 {
                    // 2f+1 observers reject this source at `height` → deprioritise it in
                    // sync peer selection (non-destructive). The canonical chain itself is
                    // chosen by round-based fork-choice + macroblock-anchored recovery, so
                    // observer rejections never trigger a rollback on their own.
                    // Consensus outranks the heuristic: the producer the certified round
                    // elects for this height is NEVER quarantined — during the h=601 reorg
                    // the flag cut sync off from the only holder of the canonical branch.
                    let certified_leader = crate::node::get_expected_producer(height)
                        .map(|(p, _)| p == source_peer_id)
                        .unwrap_or(false);
                    if certified_leader {
                        if crate::node::is_warn() {
                            println!(
                                "[WARN][REJECT] fork_flag_suppressed h={} source={} reason=certified_leader observers={}/{}",
                                height, source_peer_id, count_after, two_f_plus_1
                            );
                        }
                    } else {
                        if crate::node::is_warn() {
                            println!(
                                "[WARN][REJECT] fork_source_flagged h={} source={} observers={}/{}",
                                height, source_peer_id, count_after, two_f_plus_1
                            );
                        }
                        crate::block_pipeline::mark_peer_as_fork_source(&source_peer_id);
                    }
                }
            }

            NetworkMessage::ProducerReady { mb_idx, round, height, producer_id, signature } => {
                // v16.2: producer signals "I have local certified=R, ready to
                // produce at this round". Receiver responds with ReadyAck IF
                // local certified ≥ R (proves we have converged on the same
                //
                // rotation state). 2f+1 acks accumulated by producer give it
                // cryptographic evidence that the network agrees on R before
                // emitting the block — eliminates the cold-boot race window.
                //
                // v17.1: IP-anchor gate intentionally NOT applied here. The
                // ready-handshake propagates over gossip in some topologies,
                // so `from_peer` is the relay's IP, not the originator's.
                // The signature verification below (verify_consensus_signature
                // against the immutable PK registry) is the canonical
                // security boundary; a spoofer cannot mint a valid genesis
                // signature post Fix #2/#3.

                // v18: COUNT-BASED RATE LIMIT REMOVED. Verified ProducerReady
                // is signed by the producer's registered ML-DSA-65 key. The
                // natural cap is the (mb_idx, round, height, producer_id)
                // handshake quorum dedup in READY_ACKS — at most one ack per
                // committee member per round. Spoofers fail signature
                // verification below and consume only ≈5 ms of verify CPU.

                // Reject malformed (round must be > 0; round 0 needs no handshake).
                if round == 0 {
                    return;
                }

                // Verify producer's signature against the consensus PK registry.
                let msg = format!(
                    "QNET_PRODUCER_READY_V1:{}:{}:{}:{}",
                    producer_id, mb_idx, round, height
                );
                let sig_str = match String::from_utf8(signature.clone()) {
                    Ok(s) => s,
                    Err(_) => {
                        if crate::node::is_warn() {
                            println!("[WARN][READY] sig_not_utf8 producer={}", producer_id);
                        }
                        return;
                    }
                };
                if !self.verify_consensus_signature(&producer_id, &msg, &sig_str) {
                    if crate::node::is_warn() {
                        println!("[WARN][READY] producer_ready_sig_invalid producer={}", producer_id);
                    }
                    return;
                }

                // Convergence check: ack ONLY if local certified_round EXACTLY == the
                // requested round (v16.2: == not >=, so 2f+1 acks => 2f+1 nodes AT this
                // round => single producer per (height,round)).
                // v25 units fix (forensic h=1261 deadlock): producer timeout_round is
                // BASELINE-RELATIVE (HIGHEST_CERTIFIED_ROUND[mb]-baseline_round[mb]); the
                // receiver MUST compare in the same relative units (get_baseline_round),
                // NOT raw absolute — once baseline>0 a units mismatch makes receivers
                // refuse to ack (acks=1/4 forever). v16.2 safety preserved. O(1)/ack.
                let local_certified_abs = HIGHEST_CERTIFIED_ROUND
                    .get(&mb_idx)
                    .map(|e| *e.value())
                    .unwrap_or(0);
                let baseline = get_baseline_round(mb_idx);
                let local_certified_rel = local_certified_abs.saturating_sub(baseline);
                if local_certified_rel != round {
                    if crate::node::is_debug() {
                        println!(
                            "[DBG][READY] no_ack reason=round_mismatch local_abs={} baseline={} local_rel={} ready_round={} producer={}",
                            local_certified_abs, baseline, local_certified_rel, round, producer_id
                        );
                    }
                    return;
                }

                // Build canonical ack id (this node) and signature payload.
                let ack_id = self.node_id.clone();
                let ack_payload = format!(
                    "QNET_READY_ACK_V1:{}:{}:{}:{}:{}",
                    ack_id, producer_id, mb_idx, round, height
                );

                // Sign synchronously via the local VRF ML-DSA-65 keypair —
                // the same sync path used by `broadcast_empty_slot_attestation`.
                // We avoid the async `create_consensus_signature` here because
                // `handle_message` is a synchronous dispatcher; spawning an
                // async task to sign would require moving `&self` and is
                // unnecessary when raw detached_sign is fast (~1 ms).
                let ack_sig_bytes: Vec<u8> = {
                    use pqcrypto_mldsa::mldsa65 as dilithium3;
                    use pqcrypto_traits::sign::SecretKey as SkTrait;
                    use pqcrypto_traits::sign::DetachedSignature as SigTrait;
                    crate::node::GLOBAL_VRF_INSTANCE
                        .lock()
                        .clone()
                        .and_then(|vrf| vrf.get_secret_key_bytes())
                        .and_then(|sk_bytes| {
                            dilithium3::SecretKey::from_bytes(&sk_bytes).ok().map(|sk| {
                                let sig = dilithium3::detached_sign(ack_payload.as_bytes(), &sk);
                                SigTrait::as_bytes(&sig).to_vec()
                            })
                        })
                        .unwrap_or_default()
                };
                if ack_sig_bytes.is_empty() {
                    if crate::node::is_warn() {
                        println!(
                            "[WARN][READY] ack_sign_failed mb_idx={} round={} no_vrf_key",
                            mb_idx, round
                        );
                    }
                    return;
                }

                // Self-record so the producer's own ack contribution is
                // counted toward the 2f+1 quorum without round-tripping.
                READY_ACKS
                    .entry((mb_idx, round, height, producer_id.clone()))
                    .or_insert_with(DashSet::new)
                    .insert(ack_id.clone());

                // Send ack point-to-point to the producer (no broadcast).
                let producer_addr = self
                    .get_peer_addr_by_id(&producer_id)
                    .or_else(|| {
                        self.connected_peers_lockfree
                            .iter()
                            .find(|e| e.value().id == producer_id)
                            .map(|e| e.value().addr.clone())
                    });

                if let Some(addr) = producer_addr {
                    let ack_msg = NetworkMessage::ReadyAck {
                        mb_idx,
                        round,
                        height,
                        producer_id: producer_id.clone(),
                        ack_id: ack_id.clone(),
                        signature: ack_sig_bytes,
                    };
                    self.send_network_message(&addr, ack_msg);
                    if crate::node::is_debug() {
                        println!(
                            "[DBG][READY] ack_sent to_producer={} mb_idx={} round={} h={}",
                            producer_id, mb_idx, round, height
                        );
                    }
                }
            }

            NetworkMessage::ReadyAck { mb_idx, round, height, producer_id, ack_id, signature } => {
                // v16.2: collected by the elected producer to prove 2f+1
                // committee converged on round R before emitting block.
                //
                // v17.1: IP-anchor gate intentionally NOT applied here. ReadyAck
                // is point-to-point in the happy path but can also arrive via
                // a relay during reconnection storms; in both cases the
                // canonical security boundary is the ML-DSA-65 signature
                // check below against the immutable PK registry. Phantom
                // acks cannot be forged post Fix #2/#3.

                // v18: COUNT-BASED RATE LIMIT REMOVED. ReadyAck is ML-DSA-65
                // signed by ack_id's registered key. Natural cap is the
                // distinct-ack DashSet — one ack per ack_id per
                // (mb_idx, round, height, producer). Spoofers consume only
                // verification CPU and are rejected by the signature check.
                if round == 0 {
                    return;
                }

                // Verify ack signature against ack_id's PK in registry.
                let payload = format!(
                    "QNET_READY_ACK_V1:{}:{}:{}:{}:{}",
                    ack_id, producer_id, mb_idx, round, height
                );
                // Verify raw detached ML-DSA-65 signature against ack_id's
                // registered PK. Symmetric with the sender-side sync signing
                // used in the ProducerReady handler (which used
                // dilithium3::detached_sign on the ack payload). PK is
                // sourced from the consensus registry — same trust boundary
                // as TimeoutVote / heartbeat verification paths.
                let ack_sig_valid: bool = {
                    use pqcrypto_mldsa::mldsa65 as dilithium3;
                    use pqcrypto_traits::sign::DetachedSignature as SigTrait;
                    let pk_bytes_opt =
                        qnet_consensus::consensus_crypto::get_consensus_pk(&ack_id)
                            .or_else(|| crate::genesis_constants::get_vrf_public_key(&ack_id));
                    match pk_bytes_opt {
                        Some(pk_bytes) => {
                            match (
                                <dilithium3::PublicKey as pqcrypto_traits::sign::PublicKey>::from_bytes(&pk_bytes),
                                <dilithium3::DetachedSignature as SigTrait>::from_bytes(&signature),
                            ) {
                                (Ok(pk), Ok(sig)) => dilithium3::verify_detached_signature(
                                    &sig, payload.as_bytes(), &pk,
                                )
                                .is_ok(),
                                _ => false,
                            }
                        }
                        None => false,
                    }
                };
                if !ack_sig_valid {
                    if crate::node::is_warn() {
                        println!("[WARN][READY] ack_sig_invalid ack_id={}", ack_id);
                    }
                    return;
                }

                // Distinct-ack accumulation; DashSet dedupes on ack_id.
                let count_after = {
                    let entry = READY_ACKS
                        .entry((mb_idx, round, height, producer_id.clone()))
                        .or_insert_with(DashSet::new);
                    entry.insert(ack_id.clone());
                    entry.len()
                };
                if crate::node::is_debug() {
                    println!(
                        "[DBG][READY] ack_collected from={} producer={} mb_idx={} round={} count={}",
                        ack_id, producer_id, mb_idx, round, count_after
                    );
                }
            }

            // BFT Timeout Vote - v4.0 deterministic failover
            // ═══════════════════════════════════════════════════════════════
            // v4.0: VRF Leader Claim — verify and store
            // ═══════════════════════════════════════════════════════════════
            NetworkMessage::VrfLeaderClaim { round, node_id, vrf_output, vrf_proof, slot_seed, reputation, timestamp, vrf_public_key, gossip_ttl } => {
                self.update_peer_last_seen(&node_id);

                // v18: COUNT-BASED RATE LIMIT REMOVED. VRF claims are
                // self-verifiable via DilithiumVrf::verify_static below —
                // a failed proof rejects the claim with no state mutation.
                // Natural cap is the per-(round, node_id) dedup in
                // LEADER_CLAIMS; gossip TTL bounds re-broadcast amplification.

                // Acquire ordering for consensus-critical height check
                let local_h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire);
                if round > 0 && local_h + 100 < round {
                    return;
                }
                
                if vrf_output.len() != 32 || slot_seed.len() != 32 {
                    if crate::node::is_debug() {
                        println!("[DBG][VRF] claim_invalid node={} out_len={} seed_len={}",
                                 node_id, vrf_output.len(), slot_seed.len());
                    }
                } else {
                    // v4.2: Get pk from registry, or use inline pk from claim (self-verifiable)
                    let pk_for_verify = match crate::genesis_constants::get_vrf_public_key(&node_id) {
                        Some(pk_bytes) => Some(pk_bytes),
                        None => {
                            // First claim from this node — use inline public key
                            if vrf_public_key.len() == crate::crypto::vrf::D3_PK_BYTES {
                                Some(vrf_public_key.clone())
                            } else {
                                if crate::node::is_warn() {
                                    println!("[WARN][VRF] claim_no_pk node={} inline_len={}",
                                             node_id, vrf_public_key.len());
                                }
                                None
                            }
                        }
                    };

                    let verified = if let Some(pk_bytes) = &pk_for_verify {
                        let mut out = [0u8; 32];
                        out.copy_from_slice(&vrf_output);
                        let vrf_result = crate::crypto::vrf::VrfOutput {
                            output: out,
                            proof: vrf_proof.clone(),
                        };
                        crate::crypto::vrf::DilithiumVrf::verify_static(
                            pk_bytes, &slot_seed, &vrf_result,
                        ).unwrap_or(false)
                    } else {
                        false
                    };

                    if verified {
                        // v4.2: Auto-register pk on first verified claim (trust-on-first-verify)
                        // v14.8: VRF claim is self-signed — the cryptographic verification
                        // above (vrf::verify) is itself proof-of-ownership, so we can also
                        // install the key in the consensus-layer registry.
                        //
                        // v17.1: IP-anchor gate REMOVED for VRF claims. Reasons:
                        // (a) VrfLeaderClaim is gossip-relayed (TTL up to 4),
                        //     so `from_peer` is a relay's IP, not the
                        //     originator's — anchoring rejected legitimate
                        //     claims and broke leader rotation.
                        // (b) Anti-squat is now enforced by the consensus PK
                        //     registry: `register_consensus_pk_from_chain`
                        //     refuses to overwrite an already-registered key
                        //     for a genesis identity. The genesis anchors
                        //     file (loaded at startup via
                        //     `install_genesis_anchors_at_startup`) pre-pins
                        //     the canonical PK for every genesis slot, so a
                        //     squatter's `register_consensus_pk_from_chain`
                        //     call is rejected as a mismatch (Fix #2/#3).

                        // NO key install here. "Trust-on-first-verify" was not proof of ownership: the
                        // claim is self-signed, so verifying it with the CLAIMED key proves possession
                        // of a keypair and says nothing about who owns `node_id`. Any peer could bind
                        // any not-yet-registered id to its own key, first-writer-wins — and the
                        // producer-signature verifier reads that binding, so the victim's real blocks
                        // were then rejected for the process lifetime (and past it: the write reached
                        // disk, and boot reloads disk into RAM as "chain-validated"). The chain-apply
                        // path is the only authority for (node_id, pk); genesis identities are
                        // pre-pinned at startup and never needed this.

                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        let mut out = [0u8; 32];
                        out.copy_from_slice(&vrf_output);
                        let claim = VerifiedLeaderClaim {
                            node_id: node_id.clone(),
                            round,
                            vrf_output: out,
                            vrf_proof: vrf_proof.clone(),
                            reputation,
                            verified_at: now,
                        };
                        
                        // Deduplicate: one claim per node per round. This map IS the dedup that
                        // bounds relay amplification, so it stays - but it is write-only (nothing
                        // reads it) and its cleanup helper has no callers, so it must bound itself:
                        // rounds only advance and the keys are peer-creatable.
                        const CLAIMS_ROUND_RETENTION: u64 = 3;
                        const MAX_CLAIMS_PER_ROUND: usize = 2 * qnet_consensus::checkpoint_bft::COMMITTEE_SIZE;
                        // Floor from OUR height, never from the message: round is a wire field, so a
                        // single claim naming a far-future round would wipe the dedup table and re-arm
                        // relay for everything already forwarded.
                        let claims_floor = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed)
                            .saturating_sub(CLAIMS_ROUND_RETENTION);
                        LEADER_CLAIMS.retain(|r, _| *r >= claims_floor);
                        let mut is_new_claim = false;
                        {
                            let mut claims = LEADER_CLAIMS.entry(round).or_insert_with(Vec::new);
                            if claims.len() < MAX_CLAIMS_PER_ROUND && !claims.iter().any(|c| c.node_id == node_id) {
                                claims.push(claim);
                                is_new_claim = true;
                                if crate::node::is_info() {
                                    println!("[INFO][VRF] claim_verified round={} node={} output={} ttl={}",
                                             round, node_id, hex::encode(&vrf_output[..8]), gossip_ttl);
                                }
                            }
                        }
                        
                        // ═══════════════════════════════════════════════════════════════
                        // v4.3: GOSSIP RELAY — forward verified claim to peers
                        // TTL prevents infinite propagation loops.
                        // Only relay NEW claims (dedup above ensures no re-relay).
                        // Fanout: √(connected_peers) — balances speed vs bandwidth.
                        //
                        // SCALABILITY:
                        //   TTL=3: covers 1000^3 = 1B nodes (3 hops × 1000 peers/hop)
                        //   TTL=4: covers 1000^4 = 1T nodes (theoretical max)
                        //   Claim size: ~5.3 KB (pk=1952 + proof=3309 + overhead)
                        //   Bandwidth per relay: 5.3 KB × √1000 ≈ 167 KB (acceptable)
                        //   Total network: 20 claims × 167 KB × 3 hops = ~10 MB/round
                        // ═══════════════════════════════════════════════════════════════
                        if is_new_claim && gossip_ttl > 0 {
                            let relay_msg = NetworkMessage::VrfLeaderClaim {
                                round,
                                node_id: node_id.clone(),
                                vrf_output: vrf_output.clone(),
                                vrf_proof: vrf_proof.clone(),
                                slot_seed: slot_seed.clone(),
                                reputation,
                                timestamp,
                                vrf_public_key: vrf_public_key.clone(),
                                gossip_ttl: gossip_ttl - 1,
                            };
                            
                            // Fanout: √(connected_peers), min 2, max 20
                            let peer_count = self.connected_peers_lockfree.len();
                            let fanout = ((peer_count as f64).sqrt().ceil() as usize).clamp(2, 20);
                            
                            // Relay to random peers (excluding sender)
                            self.gossip_to_random_peers_excluding(relay_msg, fanout, from_peer);
                            
                            if crate::node::is_debug() {
                                println!("[DBG][VRF] claim_relayed round={} node={} ttl={} fanout={}",
                                         round, node_id, gossip_ttl - 1, fanout);
                            }
                        }
                    } else {
                        if crate::node::is_warn() {
                            println!("[WARN][VRF] claim_rejected round={} node={} reason=invalid_proof",
                                     round, node_id);
                        }
                    }
                }
            }

            NetworkMessage::TimeoutVote { height, timeout_round, voter_id, anchor, high_qc_idx,
                                          high_qc_hash, tip_height, tip_hash, signature, cert_mb, cert_round } => {
                self.update_peer_last_seen(&voter_id);

                // v17.1: IP-anchor gate intentionally NOT applied here.
                // TimeoutVote is gossip-relayed and `from_peer` is the
                // relay's IP, not the voter's — anchoring it broke timeout
                // certificate aggregation in production (mb=2 stuck on
                // testnet). The voter's ML-DSA-65 signature is verified
                // against the immutable consensus PK registry inside
                // `handle_timeout_vote`; that path is the canonical,
                // gossip-safe security gate.

                // SyncInfo FIRST — before any filter/tally, so a behind node is never deafened by
                // its own filter to the certificate that would advance it (pull-only, verified).
                self.process_tc_claim(cert_mb, cert_round);

                // Dispatch tiers. Floor: windows deep below local tip are stale → drop. Ceiling:
                // certified_view_bound (same constant as the production throttle — a window above
                // it is not producible anywhere) → relay WITHOUT counting (rate-capped) so deep
                // laggards keep gossip density for the live key, but fabricated far-future keys
                // never consume tally memory.
                let local_h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                let local_mb_index = local_h / 90;
                if local_mb_index > 20 && height.saturating_add(20) < local_mb_index {
                    return; // stale window
                }
                // Ceiling: a window above certified_view_bound is not producible anywhere → no real
                // TC can exist for it. DROP (do NOT relay): the vote is unverified here, so relaying
                // it would rebroadcast an unauthenticated far-future packet with no TTL/dedup (self-
                // sustaining flood). The SyncInfo cert-hint above already advanced a genuine laggard;
                // real recovery is the cooldown-gated pull, not gossip of junk keys.
                let bound_w = certified_view_bound_windows();
                if bound_w != u64::MAX && height > bound_w.saturating_add(1) {
                    if crate::node::is_debug() {
                        println!("[DBG][TIMEOUT] vote_oob mb={} bound={} action=drop", height, bound_w);
                    }
                    return;
                }

                // Count-based rate limit removed for signed TimeoutVotes. The
                // legacy is_consensus_rate_limited(30/min) caused the v17.x
                // stall (h=180-241): under a timeout stall the round
                // increments ≈1/s → ≈60 votes/min → trips the 30/min cap on
                // every receiver, muting a legit voter 5 min; with strict
                // 2f+1, one muted voter freezes HIGHEST_CERTIFIED_ROUND
                // permanently. Signed consensus messages aren't count-limited
                // — their natural cap is (height,round,voter_id) uniqueness
                // via TIMEOUT_VOTES + equivocation slashing, and the sender
                // already emits one vote per (height,round). Spoofed/malformed
                // votes are still rejected by the ML-DSA-65 sig check (~5 ms).

                // INFO (not DBG): failover votes are rare (only during a stall), so this is not hot —
                // and a received-vote line is the one signal that distinguishes "not delivered" from
                // "delivered but not tallied" when diagnosing a failover that fails to certify.
                if crate::node::is_info() {
                    println!("[INFO][TIMEOUT] vote_recv h={} round={} voter={}", height, timeout_round, voter_id);
                }

                // Process timeout vote and check if certificate is ready.
                // Signature verification + committee gate + anchor check + equivocation
                // slashing are all enforced inside handle_timeout_vote.
                self.handle_timeout_vote(height, timeout_round, voter_id, anchor, high_qc_idx,
                                         high_qc_hash, tip_height, tip_hash, signature);
            }

            // BFT Timeout Proof received from network
            NetworkMessage::TimeoutCertificateBroadcast { height, timeout_round, anchor, votes } => {
                // Window sanity BEFORE the handler (which reaches request_window_anchor pre-auth): a real
                // TC only exists for a producible window. Drop stale (deep-below-tip) and fabricated
                // (above the producible bound) heights so an attacker-chosen height can't drive anchor-pull
                // amplification on the finality lane. Mirrors the TimeoutVote dispatch bound.
                let local_mb_index = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 90;
                let bound_w = certified_view_bound_windows();
                if (local_mb_index > 20 && height.saturating_add(20) < local_mb_index)
                    || (bound_w != u64::MAX && height > bound_w.saturating_add(1)) {
                    return;
                }
                if crate::node::is_info() {
                    println!("[INFO][TIMEOUT] proof_recv h={} round={} votes={}", height, timeout_round, votes.len());
                }
                self.handle_timeout_proof_broadcast(height, timeout_round, anchor, votes);
            }

            // Request for timeout proofs (sync)
            NetworkMessage::RequestTimeoutCertificates { from_height, to_height, requester_id } => {
                if crate::node::is_debug() {
                    println!("[DBG][TIMEOUT] proof_request h={}..{} from={}", from_height, to_height, requester_id);
                }
                self.handle_timeout_proof_request(from_height, to_height, &requester_id, from_peer);
            }
            
            // Response with timeout proofs
            NetworkMessage::TimeoutCertificatesResponse { certificates, sender_id } => {
                if crate::node::is_debug() {
                    println!("[DBG][TIMEOUT] proof_response count={} from={}", certificates.len(), sender_id);
                }
                self.handle_timeout_proof_response(certificates);
            }

            // v14.7.2: BlockCommitVote / BlockCommitCertificate handlers REMOVED.
            // See matching removal of the message variants above.

            NetworkMessage::ShredProtocolChunk { chunk } => {
                // Handle incoming ShredProtocol chunk
                self.handle_shred_protocol_chunk(from_peer, chunk);
            }
            
            // PRODUCTION v2.21.3: Handle chunk retransmit requests
            NetworkMessage::RequestMissingChunks { block_height, missing_indices, requester_id, timestamp: _ } => {
                self.handle_missing_chunks_request(from_peer, block_height, missing_indices, requester_id);
            }
            
            // PRODUCTION v2.21.3: Handle chunk retransmit responses
            NetworkMessage::MissingChunksResponse { block_height, chunks, original_block_size, is_macroblock, sender_id, block_hash, num_coding } => {
                self.handle_missing_chunks_response(block_height, chunks, original_block_size, is_macroblock, &sender_id, block_hash, num_coding);
            }
            
            // PRODUCTION v2.37: Handle dedicated MacroBlock broadcast (NOT ShredProtocol!)
            NetworkMessage::MacroBlockBroadcast { index, data, sender_id, epoch } => {
                if crate::node::is_info() {
                    println!("[INFO][MB-RX] ← received idx={} epoch={} sender={} bytes={}",
                             index, epoch, get_privacy_id_for_addr(&sender_id), data.len());
                }

                // BOUNDED DECOMPRESSION (anti-DoS).
                //
                // `zstd::decode_all` accepts the input and produces a single
                // buffer with no built-in output ceiling. A hostile peer could
                // ship a 10 MB compressed payload (the QUIC `MAX_MESSAGE_SIZE`
                // ceiling) that decompresses to multiple GB — every receiver
                // would OOM or thrash. We cap output at MAX_MACROBLOCK_DECOMPRESSED
                // and stream-decode through a take-bounded reader so the
                // process exits early before allocating beyond the cap.
                //
                // Sizing: macroblocks aggregate at most one epoch (90 microblocks)
                // of state, signed commits, and reveals. A 64 MB ceiling is ~10×
                // the largest legitimate macroblock observed in practice and ~6×
                // the QUIC packet ceiling — generous head-room without allowing
                // a packet-sized bomb to cost gigabytes of RAM. The constant
                // is named so it can be tuned in one place if epoch density
                // changes.
                const MAX_MACROBLOCK_DECOMPRESSED: usize = 64 * 1024 * 1024;
                let macroblock_data = match decompress_zstd_bounded(&data[..], MAX_MACROBLOCK_DECOMPRESSED) {
                    Ok(decompressed) => decompressed,
                    Err(e) => {
                        if crate::node::is_warn() {
                            println!(
                                "[ERR][MB-RX] decompress_failed idx={} input_bytes={} err={} action=drop",
                                index, data.len(), e
                            );
                        }
                        return;
                    }
                };
                
                // Queue macroblock for processing via macroblock_tx channel
                if let Some(ref macroblock_tx) = &*self.macroblock_tx.lock() {
                    // v3.1: DEDUPLICATION for macroblock broadcast
                    // Same macroblock can arrive from multiple peers
                    if !mark_macroblock_pending_sync(index) {
                        if crate::node::is_debug() {
                            println!("[DBG][MB-RX] skip_dup idx={} from={}", index, get_privacy_id_for_addr(&sender_id));
                        }
                        return; // Already being processed or queue full
                    }
                    
                    let received_macroblock = ReceivedBlock {
                        height: index,
                        data: macroblock_data,
                        block_type: "macro".to_string(),
                        from_peer: sender_id.clone(),
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    };
                    
                    if let Err(e) = macroblock_tx.try_send(received_macroblock) {
                        clear_macroblock_pending_sync(index); // Clear on error
                        if crate::node::is_warn() {
                            println!("[ERR][MB-RX] queue failed idx={}: {}", index, e);
                        }
                    } else {
                        if crate::node::is_info() {
                            println!("[INFO][MB-RX] queued idx={} for processing", index);
                        }
                    }
                } else {
                    if crate::node::is_warn() {
                        println!("[WARN][MB-RX] no macroblock channel idx={}", index);
                    }
                }
            }

            // v5.1: Kademlia FIND_NODE — return K closest peers from our routing table
            NetworkMessage::FindNode { requester_id, target_hash, request_id } => {
                self.update_peer_last_seen(from_peer);
                self.handle_find_node(from_peer, &requester_id, &target_hash, request_id);
            }

            // v5.1: Kademlia FIND_NODE response — merge discovered peers into DHT
            NetworkMessage::FindNodeResponse { responder_id: _, closest_peers, request_id: _ } => {
                self.update_peer_last_seen(from_peer);
                self.handle_find_node_response(&closest_peers);
            }

            // Block-validity attestation — RETIRED. Fork-choice is round-based (same-round 2f+1
            // TimeoutCertificate) and finality is the 2f+1 macroblock Checkpoint; no honest node emits
            // a BlockAttestation. Accepted on the wire for backward-compat but dropped WITHOUT storing:
            // the former per-height store admitted an entry from any registered (non-committee) VRF
            // identity, so a flood could bloat memory and force an honest producer to yield its slot.
            // (EmptySlotAttestation below is a separate, live mechanism.)
            NetworkMessage::BlockAttestationMsg { block_height, block_hash, attester_id, signature, .. } => {
                self.update_peer_last_seen(from_peer);
                if block_hash.len() != 32 || signature.is_empty() { return; }
                let local_h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                if local_h > 20 && block_height.saturating_add(20) < local_h { return; }
                let mut hash = [0u8; 32];
                hash.copy_from_slice(&block_hash);

                // Deterministic slice FIRST — the cheap gate. Admitting any registered identity is
                // what forced this mechanism off before: a flood cost the sender nothing and bloated
                // memory. Membership is a pure function of (committee, height), so every node agrees.
                let window = block_height.saturating_sub(1)
                    / qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL + 1;
                let roster = match sorted_committee_for_window(window) {
                    Some(r) => r,
                    None => return,
                };
                if !crate::node::attesters_for_height(&roster, block_height, "").contains(&attester_id) {
                    if crate::node::is_warn() {
                        println!("[WARN][ATTEST] not_in_slice h={} attester={} action=drop",
                                 block_height, attester_id);
                    }
                    return;
                }
                // Replay and hash-flood are refused BEFORE the verify, so neither buys CPU.
                if !attestation_admissible(block_height, &hash, &attester_id) { return; }

                // Signature LAST (~5ms), only past the slice and admission gates.
                let storage = match crate::node::try_get_storage() { Some(s) => s, None => return };
                let pk_bytes = match crate::node::producer_verify_pk(&storage, &attester_id) {
                    Some(p) => p,
                    None => return,
                };
                let msg = crate::node::block_attestation_message(block_height, &hash);
                let sig_ok = {
                    use pqcrypto_mldsa::mldsa65 as dilithium3;
                    use pqcrypto_traits::sign::{PublicKey as _, DetachedSignature as _};
                    match (dilithium3::PublicKey::from_bytes(&pk_bytes).ok(),
                           dilithium3::DetachedSignature::from_bytes(&signature).ok()) {
                        (Some(pk), Some(sig)) =>
                            dilithium3::verify_detached_signature(&sig, &msg, &pk).is_ok(),
                        _ => false,
                    }
                };
                if !sig_ok {
                    if crate::node::is_warn() {
                        println!("[WARN][ATTEST] invalid_sig h={} attester={} action=drop",
                                 block_height, attester_id);
                    }
                    return;
                }

                let backing = record_block_attestation(block_height, hash, attester_id);
                // Receive half of the same once-per-window heartbeat as the emitter.
                if crate::node::is_info() && attest_heartbeat_due(block_height, false) {
                    println!("[INFO][ATTEST] backing h={} attesters={} committee={}",
                             block_height, backing, roster.len());
                }

                // Our block unattested while a rival carries f+1 signatures is evidence that WE are
                // the minority side — the one thing a diverged node cannot learn from its own state.
                // Action is a pull, never a rollback: fork choice stays the sole canonical authority.
                if let Ok(Some(ours)) = storage.load_microblock_hash(block_height) {
                    if ours != hash && backing >= roster.len() / 3 + 1
                        && block_attestation_count(block_height, &ours) == 0 {
                        if crate::node::is_warn() {
                            println!("[WARN][ATTEST] branch_unattested h={} rival_backing={} need={} action=reconcile",
                                     block_height, backing, roster.len() / 3 + 1);
                        }
                        self.request_window_anchor(window);
                    }
                }
            }

            // Empty-slot attestation — committee declares producer at slot_height failed
            NetworkMessage::EmptySlotAttestationMsg { slot_height, expected_producer, attester_id, signature, timestamp } => {
                self.update_peer_last_seen(from_peer);

                // Drop stale empty-slot attestations from unsynced peers
                // (same staleness gate as block attestations)
                let local_h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                if local_h > 20 && slot_height.saturating_add(20) < local_h {
                    return;
                }

                // Skip unsigned attestations (empty sig = invalid)
                if signature.is_empty() {
                    return;
                }

                // v17.1: IP-anchor gate intentionally NOT applied here.
                // Same rationale as BlockAttestation above — gossip-relayed
                // `from_peer` is the relay; the ML-DSA-65 verification
                // below against the attester's registered PK is the
                // canonical, gossip-safe security gate.

                // Verify ML-DSA-65 signature: "QNET_EMPTY_SLOT:{slot_height}:{expected_producer}"
                //
                // No "bootstrap grace" branch — see block attestation handler
                // above. Empty-slot attestations are aggregated by producers
                // to skip silent leaders; phantom signatures from unbound
                // identities would let an attacker force-skip an honest leader.
                let sig_ok = if let Some(pk_bytes) = crate::genesis_constants::get_vrf_public_key(&attester_id) {
                    use pqcrypto_mldsa::mldsa65 as dilithium3;
                    use pqcrypto_traits::sign::{PublicKey as PkTrait, DetachedSignature as SigTrait};
                    let attest_msg = format!("QNET_EMPTY_SLOT:{}:{}", slot_height, expected_producer);
                    let pk_ok = dilithium3::PublicKey::from_bytes(&pk_bytes).ok();
                    let sig_ok_decode = dilithium3::DetachedSignature::from_bytes(&signature).ok();
                    match (pk_ok, sig_ok_decode) {
                        (Some(pk), Some(sig)) => {
                            dilithium3::verify_detached_signature(&sig, attest_msg.as_bytes(), &pk).is_ok()
                        }
                        _ => false,
                    }
                } else {
                    if crate::node::is_warn() {
                        println!(
                            "[WARN][EMPTY_SLOT] attester_pk_unknown attester={} slot_h={} action=reject",
                            attester_id, slot_height
                        );
                    }
                    false
                };

                if !sig_ok {
                    if crate::node::is_warn() {
                        println!("[WARN][EMPTY-SLOT] invalid_sig h={} expected={} from={}",
                                 slot_height, expected_producer, attester_id);
                    }
                    return;
                }

                submit_empty_slot_attestation(EmptySlotAttestation {
                    slot_height,
                    expected_producer: expected_producer.clone(),
                    attester_id: attester_id.clone(),
                    signature,
                    timestamp,
                });
                if crate::node::is_debug() {
                    let total = get_empty_slot_attestation_count(slot_height, &expected_producer);
                    println!("[DBG][EMPTY-SLOT] verified h={} expected={} from={} total={}",
                             slot_height, expected_producer, attester_id, total);
                }
            }


            #[allow(deprecated)]
            NetworkMessage::EmergencyProducerChange { failed_producer, new_producer, block_height, change_type, timestamp: _, sender_node_id: _ } => {
                // ═══════════════════════════════════════════════════════════════
                // DEPRECATED v4.0: EmergencyProducerChange disabled
                // 
                // WHY: Non-deterministic, spam vector, no consensus
                // 
                // NEW ARCHITECTURE:
                // - Failover: BFT Timeout Protocol (2/3+ votes)
                // - Attacks: On-chain slashing in MacroBlock
                // - Reputation: deterministic_reputation.rs from blockchain
                // ═══════════════════════════════════════════════════════════════
                if crate::node::is_debug() {
                    println!("[DBG][DEPRECATED] EmergencyProducerChange ignored: {} -> {} h={} type={}", 
                             failed_producer, new_producer, block_height, change_type);
                }
                // IGNORED: No action taken - use BFT Timeout Protocol for failover
            }
            

            // v4.6: VRF Key Announcement — register peer's VRF public key
            NetworkMessage::VrfKeyAnnounce { node_id, vrf_public_key, self_signature, timestamp: _ } => {
                self.update_peer_last_seen(from_peer);

                if vrf_public_key.len() != crate::crypto::vrf::D3_PK_BYTES {
                    if crate::node::is_debug() {
                        println!("[DBG][VRF-KEY] bad_pk_size node={} len={}", node_id, vrf_public_key.len());
                    }
                    return;
                }

                // v17.1: GENESIS IDENTITY ANTI-SQUAT — registry-pinning model.
                //
                // The original v14.8.1 design used an IP-anchor gate here to
                // refuse genesis announces that did not arrive from the
                // canonical genesis IP. That gate broke gossip propagation
                // because VrfKeyAnnounce is broadcast through the network
                // and `from_peer` is the relay, not the originator —
                // legitimate cross-registration was rejected (visible in
                // testnet logs as `genesis_ip_mismatch ... REJECTED` warns).
                //
                // Replacement defence (already in place — see Fix #2/#3 +
                // `install_genesis_anchors_at_startup` in node.rs):
                //
                //   1. At boot every genesis node loads
                //      `genesis_anchors.json` and pre-pins the canonical
                //      ML-DSA-65 PK for each genesis_node_N into both the
                //      consensus PK registry and the VRF key registry.
                //   2. `register_consensus_pk_from_chain` is now strict:
                //      it refuses to overwrite an existing entry, so a
                //      squatter's fresh keypair targeting a genesis slot
                //      is hard-rejected as a mismatch.
                //   3. `verify_consensus_signature` (Fix #2) no longer
                //      falls back to the legacy bootstrap path, so a
                //      squatter cannot ride past signature checks even
                //      if their announce slips through.
                //
                // The early `has_vrf_key` short-circuit below means an
                // already-pinned genesis slot ignores re-announces from
                // any source — the squatter never gets to the registration
                // path. Non-genesis (Super-node) joiners are unaffected.

                if crate::genesis_constants::has_vrf_key(&node_id) {
                    return;
                }

                // Verify self-signature: proves sender owns the secret key
                use pqcrypto_mldsa::mldsa65 as dil3;
                use pqcrypto_traits::sign::{PublicKey as PkT, DetachedSignature as SigT};
                let announce_msg = format!("QNET_VRF_KEY_v1:{}", node_id);
                let sig_ok = match (dil3::PublicKey::from_bytes(&vrf_public_key), dil3::DetachedSignature::from_bytes(&self_signature)) {
                    (Ok(pk), Ok(sig)) => dil3::verify_detached_signature(&sig, announce_msg.as_bytes(), &pk).is_ok(),
                    _ => false,
                };

                // The self-signature is verified with the ANNOUNCED key, so all it proves is that the
                // sender holds SOME keypair — never that it owns `node_id`. Installing on that basis
                // let any peer bind any not-yet-registered id to its own key (first-writer-wins,
                // uncorrectable), and the producer-signature verifier reads that binding: the poisoned
                // node then rejected every real block from the victim. The write also reached disk, and
                // boot reloads disk into RAM as "chain-validated", so it outlived restarts.
                //
                // Nothing installs here any more. (node_id, pk) comes only from the chain-apply path,
                // where the transaction's own signature authenticates the pair; genesis identities are
                // pre-pinned into both registries at startup and never depended on this.
                if !sig_ok {
                    if crate::node::is_warn() {
                        println!("[WARN][VRF-KEY] bad_self_sig node={}", node_id);
                    }
                }
            }

            NetworkMessage::PeerListRequest { requester_id } => {
                // v2.95: Handle QUIC-based peer list request (replaces HTTP /api/v1/peers)
                if crate::node::is_info() {
                    println!("[INFO][P2P] PeerListRequest from {} via QUIC", requester_id);
                }
                let peers: Vec<(String, String, u64)> = self.connected_peers_lockfree.iter()
                    .map(|e| {
                        let p = e.value();
                        (p.addr.clone(), p.id.clone(), p.last_block_height)
                    })
                    .collect();
                let response = NetworkMessage::PeerListResponse {
                    peers,
                    sender_id: self.node_id.clone(),
                };
                self.send_network_message(from_peer, response);
            }

            NetworkMessage::PeerListResponse { peers, sender_id } => {
                // v2.95: Handle QUIC-based peer list response
                if crate::node::is_info() {
                    println!("[INFO][P2P] PeerListResponse from {}: {} peers via QUIC", sender_id, peers.len());
                }
                // Gossiped peers go through the SAME admission path as dialed/handshaked ones:
                // global cap, outbound-slot reserve, reputation floor and subnet-diversity caps.
                // The identity bound to an address comes from the pinned genesis table or from the
                // chain-committed endpoint, never from the relay's claim, and only a bounded number
                // of new peers is taken from any single response.
                let mut admitted = 0usize;
                let mut unbound = 0usize;
                // Scan cap, not just an admit cap: the work this message costs must not scale with
                // what the relay chose to put in it. One aggregate log line, not one per entry.
                for (addr, peer_id, _gossiped_height) in peers.iter().take(MAX_GOSSIP_PEERS_SCANNED) {
                    if peer_id == &self.node_id || addr.is_empty() || peer_id.is_empty() {
                        continue;
                    }
                    let ip = addr.split(':').next().unwrap_or("");
                    // Genesis nodes bootstrap against the pinned set only.
                    if std::env::var("QNET_BOOTSTRAP_ID").is_ok() && !is_genesis_node_ip(ip) {
                        continue;
                    }
                    let bound_id = match Self::gossip_bound_identity(peer_id, ip) {
                        Some(id) => id,
                        None => {
                            unbound += 1;
                            continue;
                        }
                    };
                    // Known identity: refresh liveness only. The gossiped height is NOT
                    // authenticated against that identity's key, so it never drives
                    // last_block_height - only signed HealthPings and applied blocks do.
                    if let Some(existing_addr_entry) = self.peer_id_to_addr.get(&bound_id) {
                        let existing_addr = existing_addr_entry.value().clone();
                        drop(existing_addr_entry);
                        if let Some(mut entry) = self.connected_peers_lockfree.get_mut(&existing_addr) {
                            entry.last_seen = self.current_timestamp();
                        }
                        continue;
                    }
                    if self.connected_peers_lockfree.contains_key(addr) {
                        continue;
                    }
                    if admitted >= MAX_GOSSIP_ADMITS_PER_RESPONSE {
                        if crate::node::is_warn() {
                            println!("[WARN][P2P] peer_admission_rejected reason=gossip_batch_cap relay={} cap={} offered={}",
                                     sender_id, MAX_GOSSIP_ADMITS_PER_RESPONSE, peers.len());
                        }
                        break;
                    }
                    let mut peer_info = match Self::parse_peer_address_static(addr) {
                        Ok(pi) => pi,
                        Err(_) => continue,
                    };
                    peer_info.id = bound_id;
                    // The parser fills a placeholder INITIAL_REPUTATION, which can never fall below
                    // the inbound floor — resolve the committed score so a zeroed node is refused
                    // here exactly as it is when it connects directly.
                    peer_info.reputation = self.get_node_reputation_from_blockchain(&peer_info.id);
                    peer_info.consensus_score = peer_info.reputation;
                    peer_info.last_block_height = 0;
                    peer_info.last_height_attested_at = 0;
                    // We did not dial this peer, so it consumes an inbound slot and is
                    // subject to every inbound gate.
                    peer_info.is_outbound = false;
                    if self.add_peer_lockfree(peer_info) {
                        admitted += 1;
                    }
                }
                if admitted > 0 {
                    self.invalidate_peer_cache();
                    if crate::node::is_info() {
                        println!("[INFO][P2P] gossip_peers_admitted relay={} admitted={} offered={}",
                                 sender_id, admitted, peers.len());
                    }
                }
                if unbound > 0 && crate::node::is_warn() {
                    println!("[WARN][P2P] peer_admission_rejected reason=unbound_identity via=gossip relay={} count={} scanned={}",
                             sender_id, unbound, peers.len().min(MAX_GOSSIP_PEERS_SCANNED));
                }
            }

            NetworkMessage::RequestBlocks { from_height, to_height, requester_id } => {
                // Per-request serving log is DEBUG: at thousands-of-nodes
                // scale an INFO line per inbound sync request is a log-DoS.
                if crate::node::is_debug() {
                    println!("[DBG][SYNC] block_request from={} heights={}-{}",
                             requester_id, from_height, to_height);
                }
                self.handle_block_request(from_peer, from_height, to_height, requester_id);
            }
            
            NetworkMessage::BlocksBatch { blocks, from_height, to_height, sender_id } => {
                // Handle batch of blocks for sync
                if crate::node::is_info() {
                    println!("[INFO][SYNC] Received {} blocks from {} (heights {}-{})",
                             blocks.len(), sender_id, from_height, to_height);
                }
                self.handle_blocks_batch(blocks, from_height, to_height, sender_id);
            }
            
            NetworkMessage::SyncStatus { current_height, target_height, syncing, node_id } => {
                // Handle sync status update
                if syncing {
                    if crate::node::is_info() {
                        println!("[INFO][SYNC] Peer {} syncing: {} / {}", node_id, current_height, target_height);
                    }
                }
                self.handle_sync_status(node_id, current_height, target_height, syncing);
            }
            
            NetworkMessage::RequestMacroblocks { from_index, to_index, requester_id } => {
                // PRODUCTION: Handle macroblock request for sync
                if crate::node::is_info() {
                    println!("[INFO][SYNC] Received macroblock request from {} for indices {}-{}",
                             requester_id, from_index, to_index);
                }
                self.handle_macroblock_request(from_peer, from_index, to_index, requester_id);
            }
            
            NetworkMessage::MacroblocksBatch { macroblocks, from_index, to_index, sender_id } => {
                // PRODUCTION: Handle batch of macroblocks for sync
                if crate::node::is_info() {
                    println!("[INFO][SYNC] Received {} macroblocks from {} (indices {}-{})",
                             macroblocks.len(), sender_id, from_index, to_index);
                }
                self.handle_macroblocks_batch(macroblocks, from_index, to_index, sender_id);
            }

            NetworkMessage::RequestMacroblockAnchor { index, requester_id } => {
                // Control-lane single-anchor fetch (snapshot binding before registration).
                if crate::node::is_info() {
                    println!("[INFO][ANCHOR] anchor_request from={} idx={}", requester_id, index);
                }
                self.handle_macroblock_anchor_request(from_peer, index, requester_id);
            }

            NetworkMessage::MacroblockAnchor { index, data, sender_id } => {
                // Single QC-bound macroblock anchor — route through the same verified ingest path.
                if crate::node::is_info() {
                    println!("[INFO][ANCHOR] anchor_recv idx={} from={} bytes={}", index, sender_id, data.len());
                }
                self.handle_macroblocks_batch(vec![(index, data)], index, index, sender_id);
            }

            NetworkMessage::GenesisCheckpointSig {
                version, network_id, mb_index, mb_hash, committee_digest_anchor, committee_digest_pred,
                minted_at_height, genesis_id, sig,
            } => {
                // GALC: aggregate a genesis partial. Cheap pre-filter (recent index, real genesis signer)
                // BEFORE the async Dilithium verify (DoS). verify/aggregate/adopt are global — no self.
                if version == crate::galc::GALC_VERSION
                    && mb_index > crate::galc::GALC_MB.load(std::sync::atomic::Ordering::SeqCst)
                    && crate::genesis_constants::is_legacy_genesis_node(&genesis_id)
                {
                    tokio::spawn(async move {
                        if crate::galc::verify_partial(
                            version, &network_id, mb_index, &mb_hash, &committee_digest_anchor,
                            &committee_digest_pred, minted_at_height, &genesis_id, &sig,
                        ).await {
                            if let Some(cap) = crate::galc::add_partial(
                                version, network_id, mb_index, mb_hash, committee_digest_anchor,
                                committee_digest_pred, minted_at_height, genesis_id, sig,
                            ) {
                                crate::galc::adopt_verified(&cap);
                            }
                        }
                    });
                }
            }

            NetworkMessage::GenesisCheckpoint { data } => {
                // GALC: a complete capsule. Cheap pre-screen (deserialize + recent-index) BEFORE the
                // spawned post-quantum verify; receive_capsule further bounds concurrent verifies (DoS).
                if let Ok(cap) = bincode::deserialize::<crate::galc::GenesisCheckpoint>(&data) {
                    if cap.mb_index > crate::galc::GALC_MB.load(std::sync::atomic::Ordering::SeqCst) {
                        tokio::spawn(async move {
                            if let Some(storage) = crate::node::try_get_storage() {
                                crate::galc::receive_capsule(&cap, &storage).await;
                            }
                        });
                    }
                }
            }

            NetworkMessage::RequestGenesisCheckpoint { requester_id } => {
                // GALC: serve the latest held capsule to a cold joiner. The capsule is ~30 KB (genesis
                // quorum sigs), so cap this serve per QUIC-anchored IP — a cold joiner needs it only a few
                // times; the bound stops a synced peer from looping it to force uncapped serialize+egress.
                let ip_over = {
                    let ip = from_peer.split(':').next().unwrap_or(from_peer);
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs()).unwrap_or(0);
                    let mut b = self.rate_limiter.entry(format!("galc_capsule_ip_{}", ip)).or_insert_with(|| RateLimit {
                        requests: Vec::new(), max_requests: 60, window_seconds: 60, blocked_until: 0,
                    });
                    if b.blocked_until > now { true }
                    else {
                        let w = b.window_seconds;
                        b.requests.retain(|&t| t > now.saturating_sub(w));
                        if b.requests.len() >= b.max_requests { b.blocked_until = now + 30; true }
                        else { b.requests.push(now); false }
                    }
                };
                if ip_over {
                    if crate::node::is_warn() { println!("[WARN][GALC] serve_capsule_rate_exceeded from={}", requester_id); }
                } else if let Some(cap) = crate::galc::held() {
                    if let Ok(data) = bincode::serialize(&cap) {
                        if crate::node::is_info() {
                            println!("[INFO][GALC] serve_capsule mb={} to={}", cap.mb_index, requester_id);
                        }
                        self.send_network_message(from_peer, NetworkMessage::GenesisCheckpoint { data });
                    }
                }
            }

            NetworkMessage::RequestConsensusState { round, requester_id } => {
                // Handle consensus state request
                if crate::node::is_info() {
                    println!("[INFO][CONS] Consensus state request for round {} from {}", round, requester_id);
                }
                self.handle_consensus_state_request(from_peer, round, requester_id);
            }
            
            NetworkMessage::ConsensusState { round, state_data, sender_id } => {
                // Handle consensus state response
                if crate::node::is_info() {
                    println!("[INFO][CONS] Received consensus state for round {} from {}", round, sender_id);
                }
                self.handle_consensus_state(round, state_data, sender_id);
            }
            
            NetworkMessage::StateSnapshot { height, ipfs_cid, sender_id } => {
                // Handle state snapshot announcement
                if crate::node::is_info() {
 println!("[INFO][SYNC] snapshot_announcement height={} cid={} from={}", height, ipfs_cid, sender_id);
                }
                // In production: Store CID for potential snapshot download
                // For now, just log the announcement
            }
            
            // v3.16: Producer vote for Byzantine 66% consensus on producer selection
            NetworkMessage::ProducerVote { block_height, voted_producer, voter_id, timeout_round: _ } => {
                // v27 HOLE5: same gate as timeout-vote — 66% producer
                // numerator must be from the committee. Scoped (no return).
                let voter_in_committee = match self.deterministic_eligible_ids() {
                    Some(committee) => {
                        let ok = committee.contains(&voter_id);
                        if !ok && crate::node::is_warn() {
                            println!("[WARN][VOTE] producervote_noncommittee h={} voter={} committee={} action=drop",
                                     block_height, voter_id, committee.len());
                        }
                        ok
                    }
                    None => true, // non-deterministic fallback → unchanged doctrine
                };
                if voter_in_committee {
                    // Store vote in PRODUCER_VOTES for consensus verification
                    // Key: (height, voter_id), Value: voted_producer
                    crate::node::PRODUCER_VOTES.insert((block_height, voter_id.clone()), voted_producer.clone());

                    if crate::node::is_debug() {
                        println!("[DBG][VOTE] recv h={} voter={} vote={}",
                                block_height, voter_id, voted_producer);
                    }
                }
            }
            
            // PRODUCTION: Certificate management for compact signatures
            NetworkMessage::CertificateAnnounce { node_id, cert_serial, certificate, timestamp: _timestamp } => {
                // SAFE: Get Tokio handle early to prevent panic in async verification
                let handle = match tokio::runtime::Handle::try_current() {
                    Ok(h) => h,
                    Err(_) => {
                        if crate::node::is_warn() {
                            println!("[WARN][P2P] No Tokio runtime - certificate verification skipped");
                        }
                        return;
                    }
                };
                
                self.update_peer_last_seen(&node_id);
                
                // SCALABILITY: Light nodes don't participate in consensus, skip certificate processing
                if matches!(self.node_type, NodeType::Light) {
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Light node: Ignoring certificate announcement (consensus not required)");
                    }
                    return;
                }
                
                // Dedup FIRST: a re-announced cached cert is a no-op, and it must not feed the
                // rate limiter — an unpromoted joiner re-announces until acked, and counting
                // those as offenses escalated a legitimate join into an attacker verdict.
                {
                    let cm = self.certificate_manager.read();
                    if cm.remote_certificates.contains_key(&cert_serial) ||
                       cm.pending_certificates.contains_key(&cert_serial) {
                        if crate::node::is_debug() {
                            println!("[DBG][P2P] cert_reannounce_dedup serial={} from={}", cert_serial, node_id);
                        }
                        return;
                    }
                }

                if crate::node::is_info() {
                    println!("[INFO][P2P] Certificate announcement from {} (serial: {})", node_id, cert_serial);
                }

                // SECURITY: Rate limiting to prevent certificate flooding attacks
                // Maximum 10 certificate announcements per minute per peer (40 for Genesis nodes)
                let now = self.current_timestamp();
                let rate_limited = {
                    let rate_key = format!("cert_{}", node_id);
                    
                    // CRITICAL: Higher rate limit for Genesis nodes due to periodic broadcast
                    // Genesis nodes: 6 broadcasts/min × 5 nodes + rotation = ~35 certs/min (need 40)
                    // Regular nodes: 1-2 broadcasts/min (10 is sufficient)
                    let is_genesis = node_id.starts_with("genesis_node_");
                    let max_certs = if is_genesis { 40 } else { 10 };
                    
                    let mut rate_limit = self.rate_limiter.entry(rate_key).or_insert_with(|| RateLimit {
                        requests: Vec::new(),
                        max_requests: max_certs,
                        window_seconds: 60,
                        blocked_until: 0,
                    });
                    
                    // Check if currently blocked
                    if rate_limit.blocked_until > now {
                        if crate::node::is_warn() {
                            println!("[ERR][P2P] Rate limit: {} blocked from sending certificates for {} more seconds", 
                                     node_id, rate_limit.blocked_until - now);
                        }
                        true
                    } else {
                        // Clean old requests outside window
                        let window = rate_limit.window_seconds;
                        rate_limit.requests.retain(|&req_time| req_time > now - window);
                        
                        // Check if limit exceeded
                        if rate_limit.requests.len() >= rate_limit.max_requests {
                            rate_limit.blocked_until = now + 300; // Block for 5 minutes (stricter for certificates)
                            if crate::node::is_info() {
                                println!("[WARN][P2P] Certificate rate limit exceeded for {} ({}+ certificates/minute)",
                                         node_id, rate_limit.max_requests);
                            }
                            if crate::node::is_info() {
                                println!("[WARN][P2P] Blocking certificate announcements for 5 minutes");
                            }
                            true
                        } else {
                            // Add this request
                            rate_limit.requests.push(now);
                            false
                        }
                    }
                };
                
                if rate_limited {
                    // Traffic shaping only: drop + the limiter's own mute window. A rate pattern
                    // is not evidence of a fault — only a VERIFIED-invalid cert feeds the tracker.
                    if crate::node::is_warn() {
                        println!("[WARN][P2P] cert_announce_rate_limited from={} action=drop", node_id);
                    }
                    return;
                }
                
                // SECURITY FIX: Verify certificate BEFORE storing to prevent spoofing attacks
                // Deserialize and validate certificate structure first
                let cert: crate::pq_crypto::PqCertificate = match bincode::deserialize(&certificate) {
                    Ok(c) => c,
                    Err(e) => {
                        if crate::node::is_info() {
                            println!("[ERR][P2P] Invalid certificate format from {}: {}", node_id, e);
                        }
                        // v2.21.5: Create SlashingEvent for invalid certificate attack
                        let current_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                        self.report_invalid_block(&node_id, current_height, [0u8; 32], "Invalid certificate format");
                        self.track_invalid_certificate(&node_id, "INVALID_FORMAT");
                        return;
                    }
                };
                
                // CRITICAL SECURITY: Verify node_id matches certificate owner to prevent spoofing
                if cert.node_id != node_id {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] SECURITY: Certificate spoofing attempt detected!");
                    }
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Sender claims to be: {}", node_id);
                    }
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Certificate owner is: {}", cert.node_id);
                    }
                    
                    // CRITICAL: Certificate spoofing is a CRITICAL ATTACK
                    // Penalty will be applied via SlashingEvent in MacroBlock
                    if crate::node::is_info() {
                        println!("[ERR][SECURITY] Certificate spoofing from {} - will be slashed in MacroBlock", node_id);
                    }
                    self.track_invalid_certificate(&node_id, "CERTIFICATE_SPOOFING");
                    
                    if !self.is_genesis_node(&node_id) {
                        // Report as critical attack for instant ban (1 year)
                        let _ = self.report_critical_attack(
                            &node_id,
                            0, // block_height not relevant for cert attacks
                            &format!("CERTIFICATE_SPOOFING: Attempted to spoof certificate for node: {}", cert.node_id)
                        );
                    }
                    return;
                }
                
                // SECURITY: Check certificate age to prevent replay attacks
                let now = self.current_timestamp();
                let cert_age = now.saturating_sub(cert.issued_at);
                
                // Maximum age: 9 minutes (certificate lifetime is 4.5 min + 4.5 min grace period)
                // SECURITY: Prevents replay attacks while allowing propagation time
                const MAX_CERT_AGE: u64 = 540; // 9 minutes (2× certificate lifetime)
                if cert_age > MAX_CERT_AGE {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] Certificate too old (possible replay attack)");
                    }
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Certificate age: {} seconds", cert_age);
                    }
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Maximum allowed: {} seconds", MAX_CERT_AGE);
                    }
                    return;
                }
                
                // SECURITY: Check certificate has not expired (with grace period)
                // v2.64: 60 second grace period for network propagation delays
                const CERTIFICATE_GRACE_PERIOD_SECS: u64 = 60;
                if now > cert.expires_at + CERTIFICATE_GRACE_PERIOD_SECS {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] Certificate expired at {}, current time: {} (beyond {}s grace)",
                                 cert.expires_at, now, CERTIFICATE_GRACE_PERIOD_SECS);
                    }
                    return;
                }
                
                // SECURITY: Check certificate is not from the future (clock skew tolerance: 60 seconds)
                const MAX_CLOCK_SKEW: u64 = 60; // 60 seconds clock skew tolerance
                if cert.issued_at > now + MAX_CLOCK_SKEW {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] Certificate from the future (clock skew issue)");
                    }
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Certificate issued at: {}", cert.issued_at);
                    }
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Current time: {}", now);
                    }
                    return;
                }
                
                // OPTIMISTIC: Save certificate to pending cache IMMEDIATELY
                // This prevents race conditions where blocks arrive before verification completes
                {
                    let mut cert_manager = self.certificate_manager.write();
                    let now = self.current_timestamp();
                    
                    // Check if already in pending or verified
                    if cert_manager.remote_certificates.contains_key(&cert_serial) ||
                       cert_manager.pending_certificates.contains_key(&cert_serial) {
                        // Expected dedup of a re-offered cert — a no-op, not a warning (DBG only).
                        if crate::node::is_debug() {
                            println!("[DBG][P2P] cert_already_cached serial={} (dedup skip)", cert_serial);
                        }
                        return;
                    }
                    
                    // SECURITY: Limit pending cache to prevent memory attacks
                    const MAX_PENDING_CERTS: usize = 100; // Max pending verifications
                    if cert_manager.pending_certificates.len() >= MAX_PENDING_CERTS {
                        // Remove oldest pending to make space
                        if let Some((oldest_serial, _)) = cert_manager.pending_certificates
                            .iter()
                            .min_by_key(|(_, (_, timestamp, _))| timestamp)
                            .map(|(k, v)| (k.clone(), v.clone())) {
                            cert_manager.pending_certificates.remove(&oldest_serial);
                            if crate::node::is_info() {
                                println!("[WARN][P2P] Pending cache full, evicted oldest: {}", oldest_serial);
                            }
                        }
                    }
                    
                    // Store in pending cache immediately (compressed for consistency)
                    let compressed = lz4_flex::compress_prepend_size(&certificate);
                    cert_manager.pending_certificates.insert(
                        cert_serial.clone(),
                        (compressed, now, node_id.clone())
                    );
                    if crate::node::is_info() {
                        println!("[INFO][P2P] Certificate {} stored in PENDING cache for immediate use", cert_serial);
                    }
                }
                
                // Clone values needed for async verification
                let cert_serial_clone = cert_serial.clone();
                let certificate_clone = certificate.clone();
                let cert_manager_clone = self.certificate_manager.clone();
                let node_id_clone = node_id.clone();
                
                handle.spawn(async move {
                    // Recreate cert preimage for verification (P8 re-root: node_id || issued_at)
                    let mut encapsulated_data = Vec::new();
                    encapsulated_data.extend_from_slice(cert.node_id.as_bytes());
                    encapsulated_data.extend_from_slice(&cert.issued_at.to_le_bytes());
                    let encapsulated_hex = hex::encode(&encapsulated_data);
                    
                    // PRODUCTION v2.50: Lock-free Dilithium verification
                    use crate::node::try_get_quantum_crypto;
                    let quantum_crypto = match try_get_quantum_crypto() {
                        Some(c) => c,
                        None => {
                            if crate::node::is_warn() {
                                println!("[WARN][CRYPTO] cert_verify_skip reason=not_initialized");
                            }
                            return;
                        }
                    };
                    
                    let dilithium_sig = crate::quantum_crypto::DilithiumSignature {
                        signature: cert.dilithium_signature.clone(),
                        algorithm: "CRYSTALS-Dilithium3".to_string(),
                        timestamp: cert.issued_at,
                        strength: "quantum-resistant".to_string(),
                    };
                    
                    // Perform cryptographic verification
                    match quantum_crypto.verify_dilithium_signature(&encapsulated_hex, &dilithium_sig, &cert.node_id).await {
                        Ok(true) => {
                            if crate::node::is_info() {
                                println!("[INFO][CERT] verified serial={} node={}", cert_serial_clone, cert.node_id);
                            }
                            
                            // ═══════════════════════════════════════════════════════════════════
                            // v3.50: DILITHIUM-ONLY CERTIFICATE ACCEPTANCE
                            // 
                            // RATIONALE: The Ed25519 rotation chain check was removed because:
                            // 1. Dilithium signature ALREADY proves cert authenticity (NIST Level 3)
                            // 2. rotation_signature (Ed25519) adds ZERO security over Dilithium
                            //    - If attacker has Dilithium key → can forge any cert (chain doesn't help)
                            //    - If attacker lacks Dilithium key → can't forge cert (chain unnecessary)
                            // 3. Ed25519 is WEAKER than Dilithium against quantum attacks
                            // 4. Chain caused operational issues: missed broadcasts → rotation_incompatible
                            //    → rejected valid certs → block verification delays
                            // 5. Top L1 blockchains do NOT use
                            //    P2P key rotation chains — they rely on primary key verification only
                            //
                            // Certificate is valid if and only if:
 // Dilithium signature is valid for node_id's known Dilithium pubkey
 // expires_at > now
                            // ═══════════════════════════════════════════════════════════════════
                            {
                                let mut cert_manager = cert_manager_clone.write();
                                
                                // ATOMIC MOVE: First add to verified, THEN remove from pending
                                // This prevents race condition where cert is in neither cache
                                cert_manager.store_remote_certificate(cert_serial_clone.clone(), certificate_clone);
                                cert_manager.pending_certificates.remove(&cert_serial_clone);
                                if crate::node::is_info() {
                                    println!("[INFO][CERT] stored serial={} node={} status=dilithium_verified", cert_serial_clone, cert.node_id);
                                }
                                
                                // FIX v2.28: Signal retry loop that new certificate is available
                                // This triggers immediate retry of buffered blocks
                                crate::node::NEW_CERTIFICATE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            }
                        }
                        Ok(false) => {
                            if crate::node::is_warn() {
                                println!("[WARN][CERT] invalid_signature serial={} from={}", cert_serial_clone, node_id_clone);
                            }
                            if crate::node::is_warn() {
                                println!("[WARN][SECURITY] potential_attack type=invalid_cert from={}", node_id_clone);
                            }
                            
                            // CRITICAL: Remove invalid certificate from pending cache
                            let mut cert_manager = cert_manager_clone.write();
                            cert_manager.pending_certificates.remove(&cert_serial_clone);
                            if crate::node::is_info() {
                                println!("[INFO][CERT] removed serial={} reason=invalid", cert_serial_clone);
                            }
                        }
                        Err(e) => {
                            if crate::node::is_warn() {
                                println!("[ERR][CERT] verification_error serial={} err={}", cert_serial_clone, e);
                            }
                            
                            // Remove failed certificate from pending cache
                            let mut cert_manager = cert_manager_clone.write();
                            cert_manager.pending_certificates.remove(&cert_serial_clone);
                            if crate::node::is_info() {
                                println!("[INFO][CERT] removed serial={} reason=verification_failed", cert_serial_clone);
                            }
                        }
                    }
                    
                    // CLEANUP: Clean expired pending certificates periodically
                    let mut cert_manager = cert_manager_clone.write();
                    if cert_manager.pending_certificates.len() > 50 {
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or(Duration::from_secs(0))
                            .as_secs();
                        cert_manager.pending_certificates.retain(|_, (_, timestamp, _)| {
                            now - *timestamp < 300 // Remove pending certs older than 5 minutes
                        });
                        if crate::node::is_info() {
                            println!("[INFO][CERT] cleanup_expired pending_ttl=300s");
                        }
                    }
                });
            }
            
            NetworkMessage::CertificateRequest { requester_id, node_id, cert_serial, timestamp } => {
                // SAFE: Get Tokio handle early to prevent panic
                let handle = match tokio::runtime::Handle::try_current() {
                    Ok(h) => h,
                    Err(_) => {
                        if crate::node::is_warn() {
                            println!("[WARN][CERT] no_runtime action=skip_request");
                        }
                        return;
                    }
                };

                self.update_peer_last_seen(&requester_id);
                if crate::node::is_debug() {
                    println!("[DBG][CERT] request_received from={} serial={}", requester_id, cert_serial);
                }
                
                // Check if we have the certificate and send response
                // MUST use write lock to track usage_count for proper LRU
                let mut cert_manager = self.certificate_manager.write();
                if let Some(certificate) = cert_manager.get_and_mark_used(&cert_serial) {
                    drop(cert_manager); // Release lock before network operations
                    
                    if crate::node::is_info() {
                        println!("[INFO][CERT] sending serial={} to={}", cert_serial, requester_id);
                    }
                    
                    // PRODUCTION: Send response back via network
                    let response = NetworkMessage::CertificateResponse {
                        node_id: node_id.clone(),
                        cert_serial: cert_serial.clone(),
                        certificate: certificate.clone(),
                        timestamp,
                    };
                    
                    // Find requester peer address
                    if let Some(peer_addr) = self.get_peer_address(&requester_id) {
                        // PRODUCTION v2.19.22: Send via QUIC
                        let peer_addr_clone = peer_addr.clone();
                        let requester_id_clone = requester_id.clone();
                        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
                        let quic_transport = self.quic_transport.clone();
                        let response_clone = response.clone();
                        
                        handle.spawn(async move {
                            if quic_enabled {
                                if let Some(ref transport) = quic_transport {
                                    let parts: Vec<&str> = peer_addr_clone.split(':').collect();
                                    if parts.len() == 2 {
                                        if let (Ok(ip), Ok(port)) = (parts[0].parse::<std::net::IpAddr>(), parts[1].parse::<u16>()) {
                                            let quic_port = port.saturating_add(crate::quic_transport::QUIC_PORT_OFFSET);
                                            let quic_addr = std::net::SocketAddr::new(ip, quic_port);
                                            
                                            let transport_guard = transport.read().await;
                                            if let Err(e) = transport_guard.broadcast_to(quic_addr, &response_clone).await {
                                                if crate::node::is_info() {
                                                    println!("[ERR][QUIC] Certificate response failed to {}: {}",
                                                        get_privacy_id_for_addr(&peer_addr_clone), e);
                                                }
                                            } else {
                                                if crate::node::is_info() {
                                                    println!("[INFO][QUIC] Certificate response sent to {}", requester_id_clone);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        });
                    } else {
                        if crate::node::is_warn() {
                            println!("[WARN][P2P] Cannot find address for requester {}", requester_id);
                        }
                    }
                } else {
                    if crate::node::is_warn() {
                        println!("[ERR][P2P] Certificate {} not found in cache", cert_serial);
                    }
                }
            }
            
            NetworkMessage::CertificateResponse { node_id, cert_serial, certificate, timestamp: _timestamp } => {
                self.update_peer_last_seen(&node_id);
                if crate::node::is_info() {
                    println!("[INFO][P2P] Certificate response from {} (serial: {})", node_id, cert_serial);
                }
                
                // Store received certificate
                let mut cert_manager = self.certificate_manager.write();
                cert_manager.store_remote_certificate(cert_serial.clone(), certificate);
                if crate::node::is_info() {
                    println!("[INFO][P2P] Received certificate {} cached", cert_serial);
                }
                
                // FIX v2.28: Signal retry loop that new certificate is available
                crate::node::NEW_CERTIFICATE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            
            // PRODUCTION: Light Node registration gossip handling
            NetworkMessage::LightNodeRegistration { 
                node_id, wallet_address, device_token_hash, quantum_pubkey, 
                registered_at, signature, gossip_hop, push_type, unified_push_endpoint,
                last_seen, consecutive_failures, is_active,
                ping_pubkey, ping_delegation_cert,
            } => {
                self.update_peer_last_seen(from_peer);
                
                // GOSSIP TTL: Max 3 hops to prevent infinite propagation
                if gossip_hop >= 3 {
                    if crate::node::is_debug() {
                        println!("[DBG][GOSSIP] hop_limit_exceeded node={} hop={}", node_id, gossip_hop);
                    }
                    return;
                }

                // SECURITY: reject a future-dated registered_at (clock-skew bound only). Gossip is
                // unauthenticated for a not-yet-on-chain node (the Dilithium proof only opens over the public
                // wallet_address), so an unbounded timestamp would let an attacker pin registered_at≈u64::MAX
                // and permanently freeze the newer-only dedupe below against the real node's later registration.
                {
                    let now_secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                    if registered_at > now_secs.saturating_add(300) {
                        if crate::node::is_warn() {
                            println!("[WARN][GOSSIP] future_registered_at_rejected node={} ts={}", node_id, registered_at);
                        }
                        return;
                    }
                }

                // DEDUPE: Check if already in registry
                {
                    let registry = self.light_node_registry.read();
                    if let Some(existing) = registry.get(&node_id) {
                        // Already have this registration
                        // SECURITY: Only accept updates with newer timestamp
                        if registered_at <= existing.registered_at {
                            return;
                        }
                        // SECURITY: Don't accept gossip-based failure increments
                        // Failures are tracked locally by each pinger node
                        // Gossip can only reset failures (successful re-registration)
                        if consecutive_failures > existing.consecutive_failures && consecutive_failures > 0 {
                            if crate::node::is_warn() {
                                println!("[WARN][GOSSIP] suspicious_failure_increment_rejected node={}", node_id);
                            }
                            return;
                        }
                    }
                }
                
                // Pure ML-DSA-65: the mobile-signed ML-DSA-65 proof over wallet_address is the SOLE
                // gossip authenticator (mandatory). Genesis nodes (genesis_*) are trusted by definition
                // and skip it. The former Part-2 Ed25519 (light_node_gossip:...) wallet-key proof and
                // its wire fields are fully removed in P8.
                let is_genesis = node_id.starts_with("genesis_");
                if !is_genesis {
                    // ML-DSA-65 (ML-DSA-65) — quantum-resistant identity proof (MANDATORY)
                    if !signature.is_empty() && !quantum_pubkey.is_empty() {
                        let dilithium_ok = self.verify_mobile_dilithium_gossip(&wallet_address, &signature, &quantum_pubkey);
                        if !dilithium_ok {
                            if crate::node::is_warn() {
                                println!("[WARN][GOSSIP] dilithium_invalid node={} wallet={}...",
                                    node_id, qnet_state::char_prefix(&wallet_address, 16));
                            }
                            return;
                        }
                        if crate::node::is_debug() {
                            println!("[DBG][GOSSIP] dilithium_ok node={}", node_id);
                        }
                    } else {
                        if crate::node::is_warn() {
                            println!("[WARN][GOSSIP] dilithium_missing_rejected node={} wallet={}...",
                                node_id, qnet_state::char_prefix(&wallet_address, 16));
                        }
                        return;
                    }

                    // SECURITY: identity continuity. The mobile Dilithium proof only opens over the PUBLIC
                    // wallet_address, so any freshly-minted key passes it — it does NOT bind the key to the
                    // node's identity. A node's quantum key is activation-derived (immutable), so a gossip
                    // carrying a DIFFERENT key for a known node_id is an identity-swap/hijack attempt. Bind
                    // to the established key (RAM entry, else the committed VRF key) and reject a mismatch.
                    // This gates BOTH the is_active overwrite below and the persisted-drop clear.
                    if !quantum_pubkey.is_empty() {
                        // VRF-ONLY: the committed on-chain key is the sole authoritative, un-poisonable
                        // identity. (C trims the RAM quantum_pubkey to empty, so the former RAM fallback was
                        // dead.) A not-yet-on-chain pseudonym has no established key to bind to; once it
                        // commits on-chain its own gossip matches the VRF key and any pre-registration poison
                        // is rejected here — an attacker can never produce a VRF-matching key.
                        let established = self.storage.as_ref()
                            .and_then(|s| s.load_vrf_public_key(&node_id).ok().flatten())
                            .map(hex::encode);
                        if let Some(est) = established {
                            if est != quantum_pubkey {
                                if crate::node::is_warn() {
                                    println!("[WARN][GOSSIP] identity_mismatch_rejected node={}", node_id);
                                }
                                return;
                            }
                        }
                    }
                }

                // C: ping keys → dedicated CF (read per-ping), written only AFTER the identity guard above
                // passes so a forged key cannot poison it. The resident entry below keeps the crypto EMPTY.
                if let Some(s) = &self.storage {
                    let _ = s.save_light_ping_keys(&node_id, &ping_pubkey, &ping_delegation_cert);
                }

                // Store in local registry with LRU eviction
                {
                    let mut registry = self.light_node_registry.write();

                    // Role-based cap; evict inactive-first (then oldest) so live nodes are never
                    // dropped while dead entries remain.
                    let cap = light_registry_cap();
                    if registry.len() >= cap {
                        let evict_count = cap / 10;
                        let mut entries: Vec<_> = registry.iter()
                            .map(|(k, v)| (k.clone(), v.is_active, v.registered_at))
                            .collect();
                        entries.sort_by_key(|(_, active, ts)| (*active, *ts));

                        for (key, _, _) in entries.into_iter().take(evict_count) {
                            registry.remove(&key);
                        }
                        if crate::node::is_info() {
                            println!("[INFO][P2P] registry_evicted count={} cap={}", evict_count, cap);
                        }
                    }
                    
                    // Trimmed resident entry — heavy crypto lives in the VRF/ping-key CFs (read on demand).
                    registry.insert(node_id.clone(), LightNodeRegistrationData {
                        node_id: node_id.clone(),
                        wallet_address: wallet_address.clone(),
                        device_token_hash: String::new(),
                        quantum_pubkey: String::new(),
                        registered_at,
                        signature: String::new(),
                        push_type: push_type.clone(),
                        unified_push_endpoint: unified_push_endpoint.clone(),
                        last_seen,
                        consecutive_failures,
                        is_active,
                        ping_pubkey: String::new(),
                        ping_delegation_cert: String::new(),
                    });
                }
                
                if crate::node::is_info() {
                    println!("[INFO][GOSSIP] light_node_accepted node={} hop={} dilithium=ok", node_id, gossip_hop);
                }

                // RE-GOSSIP: Forward to other peers with incremented hop
                let forward_msg = NetworkMessage::LightNodeRegistration {
                    node_id,
                    wallet_address,
                    device_token_hash,
                    quantum_pubkey,
                    registered_at,
                    signature,
                    gossip_hop: gossip_hop + 1,
                    push_type,
                    unified_push_endpoint,
                    last_seen,
                    consecutive_failures,
                    is_active,
                    ping_pubkey,
                    ping_delegation_cert,
                };
                self.gossip_to_random_peers(forward_msg, 3); // Forward to 3 random peers
            }
            
            // PRODUCTION: Light Node registry sync request
            NetworkMessage::LightNodeRegistryRequest { requester_id, last_sync_timestamp } => {
                self.update_peer_last_seen(from_peer);
                if crate::node::is_info() {
                    println!("[INFO][SYNC] Light node registry request from {} (since {})", requester_id, last_sync_timestamp);
                }
                
                // Collect registrations newer than or equal to last_sync_timestamp
                // FIX: Use >= to include nodes registered at exactly last_sync_timestamp
                let registrations: Vec<LightNodeRegistrationData> = {
                    let registry = self.light_node_registry.read();
                    registry.values()
                        .filter(|r| r.registered_at >= last_sync_timestamp)
                        .cloned()
                        .collect()
                };
                
                let total_count = {
                    let registry = self.light_node_registry.read();
                    registry.len() as u64
                };
                
                // Send response
                let response = NetworkMessage::LightNodeRegistryResponse {
                    sender_id: self.node_id.clone(),
                    registrations,
                    total_count,
                };
                
                if let Some(peer_addr) = self.get_peer_address_for_heartbeat(&requester_id) {
                    self.send_network_message(&peer_addr, response);
                }
            }
            
            // PRODUCTION: Light Node registry sync response
            NetworkMessage::LightNodeRegistryResponse { sender_id, registrations, total_count } => {
                self.update_peer_last_seen(from_peer);

                // ─────────────────────────────────────────────────────────────
                // SENDER AUTHENTICATION — only consensus-tier peers may sync.
                //
                // The Light-node registry feeds pinger selection and reward
                // window aggregation. Without this gate any peer could push
                // an unbounded list of `LightNodeRegistrationData` into the
                // local registry — there is NO cryptographic check on the
                // payload entries themselves, so the attacker controls the
                // whole record (node_id, wallet, FCM token, quantum_pubkey).
                // Pollution is bounded by `MAX_LIGHT_NODE_REGISTRY` so the
                // attack does not OOM, but it does:
                //   * inflate pinger selection candidates (resource burn);
                //   * occupy capacity that legitimate registrations cannot
                //     reclaim until eviction fires;
                //   * mix attacker-controlled FCM tokens into the local
                //     dedup keyspace (operationally noisy).
                //
                // Honest registry sync exclusively flows between consensus-
                // tier peers (Genesis + active Super). Restricting the
                // accepted senders to those identities closes the pollution
                // path without changing the on-the-wire format. New Super
                // nodes pick up the constraint automatically: as soon as
                // their NodeRegistration TX is applied to chain state and
                // mirrored into `active_full_super_nodes`, peers will accept
                // their sync responses.
                //
                // Scalability: at thousands of Super-nodes the active map is
                // O(1) DashMap lookup; gating cost is negligible.
                let sender_authenticated = sender_id.starts_with("genesis_node_")
                    || self.active_full_super_nodes.contains_key(&sender_id);
                if !sender_authenticated {
                    if crate::node::is_warn() {
                        println!(
                            "[WARN][SYNC] light_registry_response_unauthenticated sender={} count={} action=drop",
                            sender_id, registrations.len()
                        );
                    }
                    return;
                }

                if crate::node::is_info() {
                    println!("[INFO][SYNC] Light node registry response from {} ({} nodes, {} total)",
                             sender_id, registrations.len(), total_count);
                }

                // Merge into local registry. The pre-existing dedup-by-
                // `node_id` plus the upstream `MAX_LIGHT_NODE_REGISTRY` cap
                // jointly bound memory and prevent overwrite of an entry
                // already known to this node.
                let mut added = 0;
                {
                    let mut registry = self.light_node_registry.write();
                    for reg in registrations {
                        if !registry.contains_key(&reg.node_id) {
                            registry.insert(reg.node_id.clone(), reg);
                            added += 1;
                        }
                    }
                }

                if crate::node::is_info() {
                    println!("[INFO][SYNC] Added {} new Light nodes to registry", added);
                }
            }
            
            // PRODUCTION: Light Node attestation - proof of ping response
            NetworkMessage::LightNodeAttestation {
                light_node_id, pinger_id, slot, timestamp, 
                light_node_signature, pinger_signature, challenge, gossip_hop, block_height
            } => {
                self.update_peer_last_seen(from_peer);
                
                // GOSSIP TTL: Max 3 hops
                if gossip_hop >= 3 {
                    return;
                }
                
                // DEDUPE the gossip echo, and ONLY the echo. The key must live in the same unit as
                // the credit it guards: eligibility is per EPOCH, slot is hash(node_id) % 240 and so
                // is CONSTANT for a device, and the map is retained 24 h = 6 epochs. Keyed on
                // {id}:{slot} alone, the first attestation suppressed that device for the next six
                // epochs — the shard owner dropped the relayed reply before recording eligibility,
                // and the device lost those rewards. The LOCAL epoch is used, not the message
                // block_height, which is relay-tamperable. Built by the SAME helper the writer uses,
                // so a dedupe read can never look up a shape the insert does not produce.
                let attestation_key = Self::attestation_key(&light_node_id, slot);
                {
                    let attestations = self.light_node_attestations.read();
                    if attestations.contains_key(&attestation_key) {
                        // Already have attestation for this Light node in this slot
                        return;
                    }
                }
                
                // TIMESTAMP VALIDATION: Must be within ±5 minutes
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                if timestamp > now + 300 || timestamp < now.saturating_sub(300) {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] Invalid timestamp for {} (drift: {}s)",
                                 light_node_id, now as i64 - timestamp as i64);
                    }
                    return;
                }
                
                // The pinger must be a REAL super, established by the chain — not by the gossip-filled
                // `active_full_super_nodes` map, which is populated from a self-signed
                // ActiveNodeAnnouncement whose key is TOFV-accepted for non-genesis identities (no burn,
                // no registration, no chain needed to mint eligibility).
                //
                // Restricting it to genesis instead would have been worse: the mobile client picks a
                // random bootstrap node, so every ping that lands on a Super would be silently dropped
                // and that light node would earn NOTHING for the epoch. Light nodes are users and are
                // paid for confirmed pings unconditionally — a relay rule must never be what breaks that.
                let pinger_ok = pinger_id.starts_with("genesis_node_")
                    || crate::node::try_get_storage()
                        .and_then(|st| st.node_reg_height(&pinger_id).ok().flatten())
                        .is_some();
                if !pinger_ok {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] unregistered_pinger {} for Light node {}", pinger_id, light_node_id);
                    }
                    return;
                }
                
                // VERIFY: Light node must be in registry
                {
                    let registry = self.light_node_registry.read();
                    if !registry.contains_key(&light_node_id) {
                        if crate::node::is_info() {
                            println!("[ERR][P2P] Unknown Light node {}", light_node_id);
                        }
                        return;
                    }
                }
                
                // VERIFY: Pinger signature on attestation
                let attestation_data = format!("attestation:{}:{}:{}:{}",
                    light_node_id, slot, timestamp, challenge);
                if !self.verify_dilithium_heartbeat_signature(&attestation_data, &pinger_signature, &pinger_id) {
                    if crate::node::is_info() {
                        println!("[ERR][P2P] Invalid pinger signature for {}", light_node_id);
                    }
                    return;
                }

                // The DEVICE's own signature over the challenge is the only thing proving the phone
                // actually answered; it was carried here and verified by nobody. Same verifier the HTTP
                // ingress uses, so relay and ingress accept an identical set.
                if !self.verify_light_ping_signature(&light_node_id, &challenge, &light_node_signature) {
                    if crate::node::is_warn() {
                        println!("[WARN][P2P] light_sig_invalid node={} pinger={}", light_node_id, pinger_id);
                    }
                    return;
                }
                
                // Store through THE single writer: shared key shape and shared capacity bound, so
                // this path and the origination path cannot drift apart again.
                self.store_attestation(LightNodeAttestation {
                    light_node_id: light_node_id.clone(),
                    pinger_id: pinger_id.clone(),
                    slot,
                    timestamp,
                    light_node_signature: light_node_signature.clone(),
                    pinger_signature: pinger_signature.clone(),
                    challenge: challenge.clone(),
                    block_height,
                });
                
                // Record into the per-epoch eligibility set IF this node is in OUR shard — so a reply
                // (push or self-attest) that landed on a DIFFERENT genesis still reaches this shard-owner's
                // committed bitmap. Shard-filtered (bitmap-identical committed-roster split) ⇒ memory stays
                // at this genesis's 1/5, and each node is counted by exactly one shard owner. The pinger
                // signature was verified above. block_height is NOT signature-covered (relay-tamperable), so
                // record ONLY for the CURRENT local epoch — a forged future block_height would otherwise drive
                // the prune in record_light_epoch_eligible and wipe the live epoch's eligibility set.
                let local_epoch = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 14400;
                if block_height / 14400 == local_epoch
                    && self.node_in_my_shard_for_epoch(local_epoch, &light_node_id) {
                    self.record_light_epoch_eligible(block_height, &light_node_id);
                }

                // WHITEPAPER: Light nodes have FIXED reputation of 70
                // NO reputation changes for Light nodes - they are always eligible if attested
                
                if crate::node::is_info() {
                    println!("[INFO][P2P] Light node {} attested by {} in slot {} height={}",
                             light_node_id, pinger_id, slot, block_height);
                }
                
                // RE-GOSSIP
                let forward_msg = NetworkMessage::LightNodeAttestation {
                    light_node_id,
                    pinger_id,
                    slot,
                    timestamp,
                    light_node_signature,
                    pinger_signature,
                    challenge,
                    gossip_hop: gossip_hop + 1,
                    block_height, // v2.59: Propagate height for all nodes
                };
                self.gossip_to_random_peers(forward_msg, 3);
            }
            
            // PRODUCTION: Active Super node announcement for pinger selection
            NetworkMessage::ActiveNodeAnnouncement {
                node_id, node_type, shard_id, reputation, timestamp, signature, gossip_hop
            } => {
                self.update_peer_last_seen(from_peer);

                // v17.1: IP-anchor gate intentionally NOT applied here.
                // ActiveNodeAnnouncement is gossip-relayed (gossip_hop up to
                // 3); `from_peer` carries the relay's IP, not the
                // originator's — anchoring it rejected legitimate
                // announcements from peers that learned about a genesis
                // node via gossip. Identity binding for genesis is provided
                // by the consensus PK registry (pre-pinned at boot from
                // `genesis_anchors.json`); non-genesis identities are
                // bound via signed NodeRegistration TX.

                // v9.2: Adaptive rate limit BEFORE ML-DSA-65 verification (~35ms CPU each).
                // Scales with network size: more peers → each peer relays more unique announces.
                // Formula: base 10 + active_nodes/5, capped at 200/min.
                // 5 nodes → 11/min, 100 nodes → 30/min, 1000 nodes → 200/min (cap).
                // This ensures: (a) small networks aren't over-limited, (b) large networks
                // don't allow unbounded CPU burn, (c) no magic constants to tune manually.
                //
                // v9.5: Bootstrap bypass — at height 0 (no blocks produced yet), nodes MUST
                // register with each other to reach quorum and start producing. Rate limiting
                // at this stage causes a deadlock: nodes can't register → can't produce →
                // stay at height 0 forever. Dedup (seen_announcements below) still prevents
                // redundant ML-DSA-65 verification, so CPU is protected without rate limiting.
                //
                // v18: ActiveNodeAnnouncement is NOT consensus-critical (it drives pinger
                // selection / reputation telemetry, not rotation). The adaptive rate-limit
                // is retained because the signature verify cost (~35 ms ML-DSA-65) is the
                // primary DoS vector — at 1000 super-nodes, an attacker emitting 1000+
                // unique announces / sec would saturate CPU on signature verification
                // without this cap. Consensus-critical handlers (TimeoutVote / commit /
                // reveal) had their count limits removed in v18 because those are
                // protocol-driven (not topology-driven) and self-cap via round dedup.
                let local_h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                if local_h > 0 {
                    let active_count = self.active_full_super_nodes.len();
                    let adaptive_limit = (10 + active_count / 5).min(200);
                    if self.is_consensus_rate_limited(from_peer, "active_announce", adaptive_limit) {
                        return;
                    }
                }

                // v9.1: Dedup — skip if already processed this exact announcement.
                // Prevents 27× redundant Dilithium verification from gossip fan-out.
                let announce_key = format!("{}:{}", node_id, timestamp);
                if !self.seen_announcements.insert(announce_key) {
                    return; // Already seen and verified
                }

                // GOSSIP TTL: Max 3 hops
                if gossip_hop >= 3 {
                    return;
                }

                // TIMESTAMP VALIDATION: Must be within ±5 minutes
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                if timestamp > now + 300 || timestamp < now.saturating_sub(300) {
                    return;
                }

                // SECURITY (NIST FIPS 204 compliant): ALWAYS verify Dilithium signature.
                // ActiveNodeAnnouncement affects pinger selection — MUST be verified.
                // Skipping verification would allow replay attacks and fake registrations.
                // CPU cost (~35ms) is acceptable for security-critical operations.
                let announcement_data = format!("active:{}:{}:{}:{}:{}",
                    node_id, node_type, shard_id, reputation as u64, timestamp);
                if !self.verify_dilithium_heartbeat_signature(&announcement_data, &signature, &node_id) {
                    if crate::node::is_warn() {
                        println!("[WARN][ACTIVE] sig_invalid node={}", node_id);
                    }
                    return;
                }
                
                // The announced score is attacker-chosen; only the committed one counts. Consensus
                // reputation is binary {INITIAL_REPUTATION | 0 tombstoned} and an unknown node reads
                // the floor, so 0 means BANNED here — never "new node, give it the default".
                let real_reputation = self.get_node_reputation_from_blockchain(&node_id);
                use qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
                if real_reputation < INITIAL_REPUTATION {
                    if crate::node::is_warn() {
                        println!("[WARN][ACTIVE] reject_low_rep node={} real={:.1} claimed={:.1}",
                                 node_id, real_reputation, reputation);
                    }
                    return;
                }
                
                // Inflation check removed: reputation is synced via blocks
                // (all nodes apply the producer's +2% at the rotation
                // boundary), so an announced value can't gain an advantage —
                // producer selection uses LOCAL reputation. The old check
                // false-positived (5-min sync vs 30-s reputation change → diff
                // accumulated → honest nodes banned). Real attacks are caught
                // via blocks (invalid −20%, malicious −50%, jail via sync).
                
                // MONITORING ONLY: Log significant differences for debugging
                let reputation_diff = (reputation - real_reputation).abs();
                if reputation_diff > 5.0 && real_reputation > 0.0 {
                    if crate::node::is_debug() {
                        println!("[DBG][ACTIVE] rep_diff node={} claimed={:.1} local={:.1} diff={:.1}", 
                                 node_id, reputation, real_reputation, reputation_diff);
                    }
                }
                
                // Committed score only — the filter above already refused anything below the floor.
                let effective_reputation = real_reputation;

                // Update active nodes map (v2.51: lock-free)
                let should_update = self.active_full_super_nodes.get(&node_id)
                    .map(|e| e.last_seen < timestamp)
                    .unwrap_or(true);
                    
                if should_update {
                    // v9.3: Get peer's block height from connected_peers for sync tracking
                    let peer_height = self.connected_peers_lockfree.iter()
                        .find(|e| e.value().id == node_id)
                        .map(|e| e.value().last_block_height)
                        .unwrap_or(0);
                    self.active_full_super_nodes.insert(node_id.clone(), ActiveNodeInfo {
                        node_id: node_id.clone(),
                        node_type: node_type.clone(),
                        shard_id,
                        reputation: effective_reputation, // Use REAL reputation!
                        last_seen: timestamp,
                        block_height: peer_height,
                    });
                    if crate::node::is_info() {
                        println!("[INFO][ACTIVE] updated node={} type={} shard={} rep={:.1} h={}",
                                 node_id, node_type, shard_id, effective_reputation, peer_height);
                    }
                }
                
                // v9.2: RE-GOSSIP with adaptive fan-out, decaying per hop.
                // hop 0→1: sqrt(peers) clamped 2..6
                // hop 1→2: sqrt(peers)/2 clamped 1..3
                // hop 2→3: terminal (gossip_hop >= 3 rejected above)
                // Decay prevents exponential explosion while maintaining O(log n) propagation.
                let peer_count = self.connected_peers_lockfree.len().max(1);
                let base_fanout = (peer_count as f64).sqrt().ceil() as usize;
                let relay_fanout = match gossip_hop {
                    0 => base_fanout.clamp(2, 6),       // first relay: wider spread
                    1 => (base_fanout / 2).clamp(1, 3), // second relay: narrower
                    _ => 1,                              // last hop: minimal
                };
                let forward_msg = NetworkMessage::ActiveNodeAnnouncement {
                    node_id,
                    node_type,
                    shard_id,
                    reputation,
                    timestamp,
                    signature,
                    gossip_hop: gossip_hop + 1,
                };
                self.gossip_to_random_peers(forward_msg, relay_fanout);
            }
            
            // PRODUCTION: Request active nodes list
            NetworkMessage::ActiveNodesRequest { requester_id } => {
                self.update_peer_last_seen(from_peer);
                
                // Collect active nodes with rep >= 70 (v2.51: lock-free)
                let active_nodes: Vec<ActiveNodeInfo> = self.active_full_super_nodes.iter()
                    .filter(|entry| entry.value().reputation >= qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION)
                    .map(|entry| entry.value().clone())
                    .collect();
                
                // Send response
                let response = NetworkMessage::ActiveNodesResponse {
                    sender_id: self.node_id.clone(),
                    active_nodes,
                };
                
                if let Some(peer_addr) = self.get_peer_address_for_heartbeat(&requester_id) {
                    self.send_network_message(&peer_addr, response);
                }
            }
            
            // PRODUCTION: Response with active nodes list
            NetworkMessage::ActiveNodesResponse { sender_id, active_nodes } => {
                self.update_peer_last_seen(from_peer);
                if crate::node::is_info() {
                    println!("[INFO][ACTIVE] sync_received count={} from={}", active_nodes.len(), sender_id);
                }
                
                // SECURITY: Track nodes that return suspiciously empty lists
                // This could indicate an attack or node with corrupted state
                // v3.20: Using global EMPTY_RESPONSE_TRACKER (moved from local static for cleanup)
                
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                
                // SECURITY CHECK: Empty response from a node that should have peers
                if active_nodes.is_empty() {
                    let (count, first_empty) = {
                        let mut entry = EMPTY_RESPONSE_TRACKER.entry(sender_id.clone()).or_insert((0, now));
                        entry.0 += 1;
                        (entry.0, entry.1)
                    };
                    
                    if crate::node::is_info() {
                        println!("[WARN][SECURITY] Empty active nodes response from {} (count: {}, since: {}s ago)",
                                 sender_id, count, now - first_empty);
                    }
                    
                    // After 5 empty responses in 10 minutes, apply reputation penalty
                    if count >= 5 && (now - first_empty) < 600 {
                        if crate::node::is_info() {
                            println!("[ERR][SECURITY] {} returned 5+ empty responses - possible attack or corrupted state", sender_id);
                        }
                        
                        // v2.21.5: Penalties now via slashing events in macroblock
                        // Report as minor offense
                        if crate::node::is_info() {
                            println!("[WARN][SECURITY] {} flagged for repeated empty responses - will be penalized in next macroblock", sender_id);
                        }
                        
                        // Reset counter
                        EMPTY_RESPONSE_TRACKER.remove(&sender_id);
                    }
                    
                    // Don't process empty response further
                    return;
                }
                
                // Clear empty response counter if we got a valid response
                EMPTY_RESPONSE_TRACKER.remove(&sender_id);
                
                // Merge into local map (ADDITIVE - never replace or delete existing!)
                // v2.51: Lock-free insert
                let mut added = 0;
                for node in active_nodes {
                    // Only add if rep >= 70 and not stale (< 15 min old)
                    if node.reputation >= qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION && node.last_seen > now.saturating_sub(15 * 60) {
                        if !self.active_full_super_nodes.contains_key(&node.node_id) {
                            self.active_full_super_nodes.insert(node.node_id.clone(), node);
                            added += 1;
                        }
                    }
                }
                
                if added > 0 && crate::node::is_info() {
                    println!("[INFO][ACTIVE] sync_added count={}", added);
                }
            }
            
            // PRODUCTION: Handle system events (reorg, emergency, etc.)
            NetworkMessage::SystemEvent { event_type, data, timestamp: _timestamp, from_node } => {
                self.update_peer_last_seen(from_peer);
                if crate::node::is_info() {
                    println!("[INFO][P2P] System event '{}' from {}", event_type, from_node);
                }
                
                // Log event details for monitoring
                match event_type.as_str() {
                    "chain_reorg" => {
                        if crate::node::is_info() {
                            println!("[WARN][P2P] Chain reorganization detected from peer {}", from_node);
                        }
                        if crate::node::is_info() {
                            println!("[INFO][P2P] Reorg data: {}", data);
                        }
                    }
                    "emergency_shutdown" => {
                        if crate::node::is_info() {
                            println!("[ERR][P2P] Emergency shutdown notification from {}", from_node);
                        }
                    }
                    _ => {
                        if crate::node::is_info() {
                            println!("[INFO][P2P] unknown system event: {}", event_type);
                        }
                    }
                }
            }
        }
    }
}

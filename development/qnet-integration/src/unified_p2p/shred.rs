//! Shredding, parity generation, the relay tree, chunk repair and block reconstruction.

use super::*;

impl SimplifiedP2P {
    /// PRODUCTION v2.19.21: Broadcast Genesis block via QUIC (async)
    /// Genesis is critical and must be delivered reliably to all peers
    pub async fn broadcast_genesis_block(&self, block_data: Vec<u8>) -> Result<(), String> {
        
        
        let validated_peers = self.get_validated_active_peers();
        
        if validated_peers.is_empty() {
            if crate::node::is_warn() {
                println!("[WARN][P2P] No validated peers available - Genesis block not broadcasted");
            }
            return Ok(());
        }
        
        if crate::node::is_info() {
            println!("[INFO][QUIC] Broadcasting Genesis block to {} validated peers (binary protocol)", validated_peers.len());
        }
        
        // Create Genesis block message
        let genesis_msg = NetworkMessage::Block {
            height: 0,
            data: block_data.clone(),
            block_type: "micro".to_string(),
        };
        
        // Filter peers
        let filtered_peers: Vec<PeerInfo> = validated_peers.iter()
            .filter(|_peer| !matches!(self.node_type, NodeType::Light))
            .cloned()
            .collect();
        
        // Use QUIC if available
        if self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed) {
            if let Some(ref quic_transport) = self.quic_transport {
                let transport = quic_transport.read().await;
                
                // Broadcast with extended timeout for Genesis
                let mut results: Vec<crate::p2p_transport::BroadcastResult> = Vec::new();
                for peer in &filtered_peers {
                    let parts: Vec<&str> = peer.addr.split(':').collect();
                    if parts.len() != 2 { continue; }
                    
                    if let (Ok(ip), Ok(port)) = (parts[0].parse::<std::net::IpAddr>(), parts[1].parse::<u16>()) {
                        let quic_port = port.saturating_add(crate::quic_transport::QUIC_PORT_OFFSET);
                        let quic_addr = std::net::SocketAddr::new(ip, quic_port);
                        
                        let start = std::time::Instant::now();
                        match transport.broadcast_to(quic_addr, &genesis_msg).await {
                            Ok(_) => {
                                results.push(crate::p2p_transport::BroadcastResult {
                                    peer_addr: peer.addr.clone(),
                                    success: true,
                                    rtt_ms: Some(start.elapsed().as_millis() as u64),
                                    error: None,
                                });
                            }
                            Err(e) => {
                                results.push(crate::p2p_transport::BroadcastResult {
                                    peer_addr: peer.addr.clone(),
                                    success: false,
                                    rtt_ms: None,
                                    error: Some(format!("{}", e)),
                                });
                            }
                        }
                    }
                }
                let results = results;
                
                let success_count = results.iter().filter(|r| r.success).count();
                let total = results.len();
                
                for result in &results {
                    if result.success {
                        if crate::node::is_info() {
                            println!("[INFO][QUIC] Genesis sent to {} (RTT: {:?}ms)",
                                get_privacy_id_for_addr(&result.peer_addr), result.rtt_ms);
                        }
                    } else {
                        if crate::node::is_info() {
                            println!("[WARN][QUIC] Failed to send Genesis to {}: {:?}",
                                get_privacy_id_for_addr(&result.peer_addr), result.error);
                        }
                    }
                }
                
                if success_count > 0 {
                    if crate::node::is_info() {
                        println!("[INFO][QUIC] Genesis block sent to {}/{} peers", success_count, total);
                    }
                    return Ok(());
                } else if total > 0 {
                    return Err("Failed to send Genesis block to any peer via QUIC".into());
                }
                return Ok(());
            }
        }
        
        // NO HTTP FALLBACK - QUIC only mode
        if crate::node::is_info() {
            println!("[ERR][QUIC] QUIC not initialized - Genesis block cannot be sent");
        }
        if crate::node::is_info() {
            println!("[INFO][QUIC] ensure init_quic() was called during startup");
        }
        Err("QUIC transport not initialized".into())
    }
    
    /// PRODUCTION v2.19.21: Broadcast block using ShredProtocol protocol via QUIC
    /// Chunking with Reed-Solomon erasure coding for reliability
    /// For microblocks only (default) - use broadcast_block_shred_protocol_typed for macroblocks
    pub async fn broadcast_block_shred_protocol(&self, height: u64, block_data: Vec<u8>) -> Result<(), String> {
        self.broadcast_block_shred_protocol_typed(height, block_data, false).await
    }
    
    /// PRODUCTION: Broadcast block (micro or macro) using ShredProtocol protocol via QUIC
    /// Supports both microblocks and macroblocks with correct type tagging
    /// v2.26: Certificate is now included in chunk #0 to eliminate race condition
    pub async fn broadcast_block_shred_protocol_typed(&self, height: u64, block_data: Vec<u8>, is_macroblock: bool) -> Result<(), String> {
        
        
        let max_shred_size = SHRED_PROTOCOL_MAX_CHUNKS * SHRED_PROTOCOL_CHUNK_SIZE;
        
        // ═══════════════════════════════════════════════════════════════════════════
        // PRODUCTION v2.63: Block size validation
        // ═══════════════════════════════════════════════════════════════════════════
        // With Level 1 (80MB block size limit at creation) and Level 2 (87MB ShredProtocol max),
        // blocks should NEVER exceed the limit. If they do, log error and reject.
        if block_data.len() > max_shred_size {
            if crate::node::is_warn() {
                println!("[ERR][SHRED] block_rejected h={} size_mb={:.2} max_mb={:.2} reason=exceeds_shred_limit",
                         height, 
                         block_data.len() as f64 / 1_000_000.0,
                         max_shred_size as f64 / 1_000_000.0);
            }
            return Err(format!("Block {} exceeds ShredProtocol limit: {:.2}MB > {:.2}MB. This should never happen with Level 1 protection.",
                              height, block_data.len() as f64 / 1_000_000.0, max_shred_size as f64 / 1_000_000.0));
        }
        
        // Get validated peers using existing method
        let validated_peers = self.get_validated_active_peers();
        
        if validated_peers.is_empty() {
            if height % 10 == 0 {
                if crate::node::is_info() {
                    println!("[WARN][SHRED] No validated peers available - block #{} not broadcasted", height);
                }
            }
            return Ok(());
        }
        
        // v2.26: Get producer certificate to include in chunk #0
        // This eliminates race condition where block arrives before certificate
        let producer_certificate: Option<ProducerCertificate> = {
            let cert_manager = self.certificate_manager.read();
            // Get local certificate (we are the producer)
            if let Some((serial, cert_bytes)) = cert_manager.get_local_cert_with_serial() {
                Some(ProducerCertificate {
                    serial_number: serial,
                    node_id: self.node_id.clone(),
                    certificate_bytes: cert_bytes,
                })
            } else {
                // No certificate yet - this can happen during genesis
                if height > 0 {
                    if crate::node::is_info() {
                        println!("[WARN][SHRED] No producer certificate for block #{} - peers may need to request it", height);
                    }
                }
                None
            }
        };
        
        // CRITICAL: Store original block size BEFORE splitting
        let original_block_size = block_data.len();

        // FIX R23-P3: Compute block hash for chunk authentication
        let block_hash: [u8; 32] = {
            use sha3::{Sha3_256, Digest};
            let mut hasher = Sha3_256::new();
            hasher.update(&block_data);
            let result = hasher.finalize();
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&result);
            arr
        };

        // Split block into chunks
        let chunks = self.split_into_chunks(&block_data);
        let total_chunks = chunks.len();
        
        // Committee-aware adaptive redundancy. Small committees (≤50) need
        // higher base redundancy — one dropped chunk on a 5-node mesh is 25%
        // perceived loss vs ~5% on 100 nodes, and recovery needs 67% of
        // chunks. Large committees (1000+) get statistical resilience from
        // fan-out, so extra redundancy isn't worth the bandwidth. Tiers
        // (genesis small-committee / large-committee scale):
        // <100KB 2.0x / 1.5x; <500KB 2.0 / 1.75; ≥500KB 2.0 / 1.5.
        // Proxy for committee size: connected_peers_lockfree ≤50.
        let live_peer_count = self.connected_peers_lockfree.len();
        let small_committee = live_peer_count <= 50;
        let adaptive_redundancy = if original_block_size < 100_000 {
            if small_committee { 2.0 } else { SHRED_PROTOCOL_REDUNDANCY_FACTOR } // genesis: 2x; large: 1.5x
        } else if original_block_size < 500_000 {
            if small_committee { 2.0 } else { 1.75 }
        } else {
            // Large blocks are the MAX-TPS regime, and redundancy multiplies every relay's egress — the
            // exact TPS ceiling. Small committees (genesis) keep 2.0× (100% parity): one dropped shred on a
            // few-node mesh is a large fraction and there are few alternate relay paths. A LARGE committee
            // gets statistical resilience from the deep relay tree + loss-retransmitting QUIC, so 1.5× (lose
            // up to 1/3 of shreds and still reconstruct) is ample — a direct ~33% egress cut = ~33% more TPS
            // headroom at scale. Self-describing FEC (num_coding_shreds) makes this safe: the decoder always
            // matches whatever ratio the producer chose. Live-tunable; genesis (small_committee) is unchanged.
            if small_committee { 2.0 } else { 1.5 }
        };
        
        // GF(2^8) hard limit: data + parity ≤ 255 total shards (reed_solomon_erasure::galois_8). Cap the
        // adaptive parity so a near-max block still gets REAL Reed-Solomon coding instead of the
        // replication fallback in generate_parity_chunks (which cannot reconstruct a missing data shred).
        // The decoder reads this exact capped count via num_coding_shreds, so dimensions always agree.
        let parity_count = (((total_chunks as f32) * (adaptive_redundancy - 1.0)).ceil() as usize)
            .min(255usize.saturating_sub(total_chunks));

        // Generate Reed-Solomon parity chunks
        let parity_chunks = self.generate_parity_chunks(&chunks, parity_count);
        
        // ═══════════════════════════════════════════════════════════════════════════
        // PRODUCTION v2.55: PRODUCER CACHE - Cache chunks IMMEDIATELY for repair
        // ═══════════════════════════════════════════════════════════════════════════
        // Problem: Producer didn't cache chunks → repair requests returned nothing!
        // Solution: Cache chunks at broadcast time so repair can find them
        // ═══════════════════════════════════════════════════════════════════════════
        let chunks_for_cache: Vec<Option<Vec<u8>>> = chunks.iter()
            .map(|c| Some(c.clone()))
            .collect();
        let parity_for_cache: Vec<Option<Vec<u8>>> = parity_chunks.iter()
            .map(|c| Some(c.clone()))
            .collect();
        
        self.cache_chunks_for_retransmit(
            height,
            chunks_for_cache,
            parity_for_cache,
            original_block_size,
            is_macroblock,
        );
        
        if height <= 100 || height % 50 == 0 {
            if crate::node::is_info() {
                println!("[INFO][CACHE] producer_cache h={} data={} parity={} redundancy={:.1}x", 
                         height, total_chunks, parity_count, adaptive_redundancy);
            }
        }
        
        // ADAPTIVE FANOUT: Calculate optimal fanout based on network size and latency
        let shred_protocol_fanout = self.get_shred_protocol_fanout();
        
        // CRITICAL: Log first 500 blocks and every 10th for debugging
        if height <= 500 || height % 10 == 0 {
            let avg_latency = self.get_average_peer_latency();
            let producers = self.get_qualified_producers_count();
            if crate::node::is_info() {
                println!("[INFO][SHRED] Broadcasting block #{} as {} chunks + {} parity to {} peers (fanout={}, producers={}, latency={}ms)",
                         height, total_chunks, parity_count, validated_peers.len(), shred_protocol_fanout, producers, avg_latency);
            }
        }
        
        // v24: Per-block deterministic shuffle (Kademlia order + Fisher-Yates
        // seeded by block height). Eliminates the persistent hash-exclusion
        // bias that left specific peers chronically under-served by the
        // legacy `chunk_index % len` rotation.
        let routing_tree = self.build_shred_protocol_routing_tree_for_block(
            &validated_peers,
            height,
        );
        // FIX-3: relay tree over the canonical committee (None during genesis epochs ⇒ flat fallback).
        let committee_roster = self.shred_committee_roster(height);

        // Collect all chunk messages
        let mut chunk_sends: Vec<(PeerInfo, NetworkMessage)> = Vec::new();
        
        // Collect data chunks
        // v2.26: Include certificate in chunk #0 to eliminate race condition
        for (chunk_index, chunk_data) in chunks.into_iter().enumerate() {
            let shred_protocol_chunk = ShredProtocolChunk {
                block_height: height,
                chunk_index,
                total_chunks,
                data: chunk_data,
                is_parity: false,
                original_block_size,  // CRITICAL: Include original size
                is_macroblock,  // PRODUCTION: Tag block type
                // Cert on EVERY data chunk: any delivered chunk carries it, so no single
                // loss can strip the block of its certificate. ~7 KB per chunk (≤1.6%).
                certificate: producer_certificate.clone(),
                block_hash: Some(block_hash),  // FIX R23-P3
                num_coding_shreds: parity_count,  // self-describing FEC: decoder matches our RS dimensions
            };

            let target_peers = match committee_roster.as_ref().filter(|r| !r.is_empty()) {
                // Committee tree: deterministic fanout (network-agreed) so the heap shape is identical
                // on every member. Flat fallback keeps the adaptive value (redundancy only, no tree).
                Some(roster) => {
                    let t = self.shred_seed_targets(roster, chunk_index, shred_tree_fanout(roster.len()));
                    // Empty ⇒ the rotated root AND all its children are unreachable (churn / partial outage);
                    // without this the chunk is seeded to NOBODY. Honour the documented flat fallback.
                    if t.is_empty() {
                        self.select_shred_protocol_targets(&routing_tree, chunk_index, shred_protocol_fanout)
                    } else { t }
                }
                None => self.select_shred_protocol_targets(&routing_tree, chunk_index, shred_protocol_fanout),
            };
            let msg = NetworkMessage::ShredProtocolChunk { chunk: shred_protocol_chunk };

            for peer in target_peers {
                chunk_sends.push((peer, msg.clone()));
            }
        }

        // v26 D4: cert was ONLY in chunk #0 → its loss = block without
        // cert = macroblock can't certify (freeze trigger). Replicate
        // cert onto first N parity chunks (bounded: O(1) in cert size,
        // not O(parity) → scales 5→1000). RS data path untouched, so it
        // cannot make a block unreconstructable.
        const CERT_REDUNDANT_PARITY: usize = 4;
        for (parity_index, parity_data) in parity_chunks.into_iter().enumerate() {
            let shred_protocol_chunk = ShredProtocolChunk {
                block_height: height,
                chunk_index: total_chunks + parity_index,
                total_chunks,
                data: parity_data,
                is_parity: true,
                original_block_size,  // CRITICAL: Include original size
                is_macroblock,  // PRODUCTION: Tag block type
                // v26 D4: cert on first N parity chunks (bounded redundancy)
                certificate: if parity_index < CERT_REDUNDANT_PARITY {
                    producer_certificate.clone()
                } else {
                    None
                },
                block_hash: Some(block_hash),  // FIX R23-P3
                num_coding_shreds: parity_count,  // self-describing FEC (same value on every chunk)
            };
            
            let target_peers = match committee_roster.as_ref().filter(|r| !r.is_empty()) {
                Some(roster) => {
                    let t = self.shred_seed_targets(roster, total_chunks + parity_index, shred_tree_fanout(roster.len()));
                    if t.is_empty() {
                        self.select_shred_protocol_targets(&routing_tree, total_chunks + parity_index, shred_protocol_fanout)
                    } else { t }
                }
                None => self.select_shred_protocol_targets(&routing_tree, total_chunks + parity_index, shred_protocol_fanout),
            };
            let msg = NetworkMessage::ShredProtocolChunk { chunk: shred_protocol_chunk };

            for peer in target_peers {
                chunk_sends.push((peer, msg.clone()));
            }
        }
        
        let total_sends = chunk_sends.len();
        
        // QUIC mode: Send all chunks in parallel using binary protocol
        if self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed) {
            if let Some(ref quic_transport) = self.quic_transport {
                // Collect peer info for broadcast
                let peers_for_broadcast: Vec<PeerInfo> = chunk_sends.iter()
                    .map(|(peer, _)| peer.clone())
                    .collect();
                
                // Create messages for each peer
                let messages: Vec<NetworkMessage> = chunk_sends.iter()
                    .map(|(_, msg)| msg.clone())
                    .collect();
                

                let transport_arc = quic_transport.clone();
                let node_id_clone = self.node_id.clone();
                let height_for_log = height;
                
                // PRODUCTION v2.21.4: Rate-limited chunk sending with Semaphore
                // Prevents receiver overload from burst of 72+ concurrent streams
                // Adaptive limit based on network size and per-peer capacity
                let max_concurrent = self.get_max_concurrent_chunk_sends();
                let semaphore = Arc::new(Semaphore::new(max_concurrent));
                
                // Log rate limiting for first 100 blocks and every 50th
                // NOTE: peers_for_broadcast contains DUPLICATES (one entry per chunk×peer)
                // total_sends = chunks × fanout, NOT unique peer count
                if height <= 100 || height % 50 == 0 {
                    // Count unique peers for accurate logging
                    let unique_peers: std::collections::HashSet<String> = peers_for_broadcast.iter()
                        .map(|p| p.id.clone())
                        .collect();
                    if crate::node::is_info() {
                        // Semaphore-paced fan-out (anti-UDP-burst); nothing is dropped.
                        println!("[INFO][SHRED] paced_send concurrency={} total={} peers={}",
                            max_concurrent, total_sends, unique_peers.len());
                    }
                }
                
                // Build list of (quic_addr, msg) tuples for PACED sending
                // PRODUCTION v2.45: ADAPTIVE PACING to prevent UDP burst and packet loss
                // Instead of sending all chunks simultaneously, we batch them
                // with dynamic delays based on recent failure rate
                
                // Calculate adaptive pacing parameters based on failure rate
                let failure_rate_x1000 = SHRED_LAST_FAILURE_RATE.load(std::sync::atomic::Ordering::Relaxed);
                let failure_rate = (failure_rate_x1000 as f32) / 1000.0;
                
                let (batch_size, delay_ms) = if failure_rate > PACING_FAILURE_CRITICAL {
                    // Critical: 30%+ failure - very aggressive backpressure
                    (PACING_BATCH_SIZE_MIN, PACING_DELAY_MS_MAX)
                } else if failure_rate > PACING_FAILURE_THRESHOLD {
                    // Warning: 10-30% failure - moderate backpressure
                    let scaled_batch = PACING_BATCH_SIZE_DEFAULT - ((failure_rate - PACING_FAILURE_THRESHOLD) * 100.0) as usize;
                    let scaled_delay = PACING_DELAY_MS_DEFAULT + ((failure_rate * 200.0) as u64);
                    (scaled_batch.max(PACING_BATCH_SIZE_MIN), scaled_delay.min(PACING_DELAY_MS_MAX))
                } else {
                    // Normal: <10% failure - standard pacing
                    (PACING_BATCH_SIZE_DEFAULT, PACING_DELAY_MS_DEFAULT)
                };
                
                let mut send_items: Vec<(std::net::SocketAddr, NetworkMessage)> = Vec::with_capacity(total_sends);
                
                for (peer, msg) in peers_for_broadcast.iter().zip(messages.iter()) {
                    // CRITICAL: Skip self to prevent self-broadcast loops
                    if peer.id == node_id_clone {
                        continue;
                    }
                    
                    let ip: std::net::IpAddr = match peer.addr.split(':').next().and_then(|s| s.parse().ok()) {
                        Some(ip) => ip,
                        None => continue,
                    };
                    let port: u16 = match peer.addr.split(':').nth(1).and_then(|s| s.parse().ok()) {
                        Some(p) => p,
                        None => continue,
                    };
                    
                    let quic_addr = std::net::SocketAddr::new(ip, port.saturating_add(crate::p2p_transport::QUIC_PORT_OFFSET));
                    send_items.push((quic_addr, msg.clone()));
                }
                
                // v26 D5: chunk-#0-first priority machinery REMOVED.
                // It existed ONLY because the producer certificate lived
                // solely in chunk #0 (v2.45.1 race: parity reconstructs the
                // block before chunk #0 → block has no certificate). D4
                // replicates the cert onto chunk #0 + the first parity
                // chunks and the receiver accepts it from ANY chunk, so
                // chunk arrival order is now irrelevant. Removing the
                // partition + 500ms blocking wait + 3ms sleep eliminates up
                // to ~503ms of critical-path latency per block plus a
                // self-amplifying serialization under load (which itself
                // worsened late-chunk delivery). ALL chunks now flow through
                // the single adaptive-paced fire-and-forget path below;
                // UDP-burst protection (adaptive batching) is retained.
                #[allow(unused_assignments)]
                let mut total_success = 0usize;
                
                // v26 D5: send ALL chunks (data + parity) through one
                // adaptive-paced fire-and-forget path. No chunk priority.
                let num_batches = if send_items.is_empty() { 0 } else {
                    (send_items.len() + batch_size - 1) / batch_size
                };
                
                // ═══════════════════════════════════════════════════════════════════════════
                // PRODUCTION v2.55: ASYNC BROADCAST + CHUNK REPAIR
                // ═══════════════════════════════════════════════════════════════════════════
                // Architecture:
                // 1. Async broadcast (non-blocking, ~50ms for any block size)
                // 2. Producer caches chunks (for repair requests)
                // 3. Receiver caches chunks (can serve repair to other nodes)
                // 4. Missing chunks after 500ms → automatic repair request
                // 5. Adaptive redundancy (2x-2.5x for large blocks)
                // 6. QUIC provides implicit ACK (connection-level reliability)
                // ═══════════════════════════════════════════════════════════════════════════
                
                let sends_count = send_items.len();

                    for (batch_idx, batch) in send_items.chunks(batch_size).enumerate() {
                        for (quic_addr, msg) in batch {
                            let transport_clone = transport_arc.clone();
                            let msg_clone = msg.clone();
                            let addr = *quic_addr;
                            let permit = semaphore.clone();
                            
                            // PRODUCTION v2.56: FIRE-AND-FORGET on dedicated broadcast runtime
                            // Ensures broadcast never gets starved by main loop tasks
                            // Like Solana's broadcast_stage - isolated thread pool for chunks
                            BROADCAST_RUNTIME.spawn(async move {
                                let _permit = match permit.acquire().await {
                                    Ok(p) => p,
                                    Err(_) => {
                                        SHRED_SEND_FAILURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                        return;
                                    }
                                };
                                let transport = transport_clone.read().await;
                                match transport.broadcast_to(addr, &msg_clone).await {
                                    Ok(_) => {
                                        SHRED_SEND_SUCCESS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                    }
                                    Err(_) => {
                                    SHRED_SEND_FAILURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                }
                            }
                        });
                    }
                    
                    // PACING: Small delay between batches to prevent UDP burst (except last)
                    // This is async-friendly and doesn't block producer
                    if batch_idx < num_batches - 1 {
                        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    }
                }
                
                // Fire-and-forget: assume success, repair handles failures
                total_success = sends_count;
                
                // Calculate and update failure rate periodically (from atomic counters)
                let total_sent = SHRED_SEND_SUCCESS.load(std::sync::atomic::Ordering::Relaxed) 
                               + SHRED_SEND_FAILURE.load(std::sync::atomic::Ordering::Relaxed);
                if total_sent > 0 {
                    let new_rate = (SHRED_SEND_FAILURE.load(std::sync::atomic::Ordering::Relaxed) as f32 / total_sent as f32 * 1000.0) as u64;
                    SHRED_LAST_FAILURE_RATE.store(new_rate, std::sync::atomic::Ordering::Relaxed);
                    
                    // Reset counters periodically to avoid stale data (every 10000 sends)
                    if total_sent > 10000 {
                        SHRED_SEND_SUCCESS.store(0, std::sync::atomic::Ordering::Relaxed);
                        SHRED_SEND_FAILURE.store(0, std::sync::atomic::Ordering::Relaxed);
                    }
                }
                
                // Log async broadcast dispatch
                if height_for_log <= 100 || height_for_log % 50 == 0 {
                    if crate::node::is_info() {
                        println!("[INFO][SHRED] broadcast h={} sends={} batches={}", 
                            height_for_log, sends_count, num_batches);
                    }
                }
                
                let total_sends = send_items.len();
                if height_for_log <= 500 || height_for_log % 10 == 0 {
                    if crate::node::is_info() {
                        println!("[INFO][SHRED] Block #{} delivered: {}/{} (all_paced, batch={}, delay={}ms, fail_rate={:.1}%)",
                            height_for_log, total_success, total_sends, batch_size, delay_ms, failure_rate * 100.0);
                    }
                }
                
                return Ok(());
            }
        }
        
        // NO HTTP FALLBACK - QUIC only mode
        if crate::node::is_info() {
            println!("[ERR][SHRED] QUIC not initialized - block #{} cannot be sent", height);
        }
        if crate::node::is_info() {
            println!("[INFO][SHRED] ensure init_quic() was called during startup");
        }
        Err("QUIC transport not initialized".into())
    }
    
    /// Split block data into chunks for ShredProtocol
    pub(super) fn split_into_chunks(&self, data: &[u8]) -> Vec<Vec<u8>> {
        data.chunks(SHRED_PROTOCOL_CHUNK_SIZE)
            .map(|chunk| chunk.to_vec())
            .collect()
    }
    
    /// Generate Reed-Solomon parity chunks (PRODUCTION implementation)
    pub(super) fn generate_parity_chunks(&self, data_chunks: &[Vec<u8>], parity_count: usize) -> Vec<Vec<u8>> {
        // PRODUCTION: Real Reed-Solomon erasure coding
        let data_count = data_chunks.len();
        
        // Create Reed-Solomon encoder
        let rs = match ReedSolomon::new(data_count, parity_count) {
            Ok(rs) => rs,
            Err(e) => {
                if crate::node::is_info() {
                    println!("[WARN][SHRED] Reed-Solomon initialization failed: {:?}, falling back to replication", e);
                }
                // Fallback: replicate first chunks as parity
                return data_chunks.iter()
                    .take(parity_count)
                    .cloned()
                    .collect();
            }
        };
        
        // Ensure all chunks are same size (pad if needed)
        let chunk_size = data_chunks.iter().map(|c| c.len()).max().unwrap_or(SHRED_PROTOCOL_CHUNK_SIZE);
        let mut padded_chunks: Vec<Vec<u8>> = data_chunks.iter()
            .map(|chunk| {
                let mut padded = chunk.clone();
                padded.resize(chunk_size, 0);
                padded
            })
            .collect();
        
        // Add space for parity shards
        for _ in 0..parity_count {
            padded_chunks.push(vec![0u8; chunk_size]);
        }
        
        // Convert to format required by reed-solomon-erasure
        let mut shards: Vec<Box<[u8]>> = padded_chunks.into_iter()
            .map(|chunk| chunk.into_boxed_slice())
            .collect();
        
        // Generate parity shards
        if let Err(e) = rs.encode(&mut shards) {
            if crate::node::is_info() {
                println!("[WARN][SHRED] Reed-Solomon encoding failed: {:?}", e);
            }
            // Fallback to simple XOR
            let mut parity = vec![vec![0u8; chunk_size]; parity_count];
            for chunk in data_chunks {
                for i in 0..parity_count {
                    for (j, &byte) in chunk.iter().enumerate() {
                        if j < parity[i].len() {
                            parity[i][j] ^= byte;
                        }
                    }
                }
            }
            return parity;
        }
        
        // Extract parity shards
        shards.into_iter()
            .skip(data_count)
            .take(parity_count)
            .map(|shard| shard.into_vec())
            .collect()
    }
    
    /// Build the per-block ShredProtocol routing list.
    ///
    /// Block-height-seeded deterministic shuffle (anti-exclusion). A flat
    /// Kademlia sort + the `(chunk_index*fanout)%len` selector consistently
    /// routed the same chunk indices to the same peer every block, so a peer
    /// the modular arithmetic excluded suffered permanent block loss
    /// (node-001 missing 267/1260 = 21%). Fix: shuffle the same sorted set
    /// per-block via a deterministic permutation seeded by block_height
    /// (every honest node computes the IDENTICAL permutation, but the target
    /// set rotates between blocks → no permanent exclusion; expected
    /// per-peer chunk count is uniform). Fisher-Yates via SplitMix64, O(N).
    pub(super) fn build_shred_protocol_routing_tree(&self, peers: &[PeerInfo]) -> Vec<PeerInfo> {
        // Legacy callers (forwarders that don't know block_height) use this
        // overload, which keeps the bucket-sorted ordering as before.
        let mut sorted_peers = peers.to_vec();
        sorted_peers.sort_by_key(|p| p.bucket_index);
        sorted_peers
    }

    /// FIX-3: the canonical ordered committee for `height` (byte-identical on every node), used as the
    /// relay-tree roster. None ⇒ genesis epochs / N-2 gap ⇒ caller falls back to the local-peer flat relay.
    pub(super) fn shred_committee_roster(&self, height: u64) -> Option<Vec<String>> {
        if let Some(r) = SHRED_ROSTER_CACHE.get(&height) { return Some(r.clone()); }
        let storage = self.storage.as_ref()?;
        let roster = crate::node::BlockchainNode::committee_for_height(storage, height)?;
        SHRED_ROSTER_CACHE.insert(height, roster.clone());
        if SHRED_ROSTER_CACHE.len() > 512 {
            let lo = height.saturating_sub(256);
            SHRED_ROSTER_CACHE.retain(|k, _| *k >= lo);
        }
        Some(roster)
    }

    /// Resolve a committee node_id to a connected PeerInfo (None ⇒ not currently reachable → that
    /// subtree pulls the block via handle_block_request; index positions stay canonical regardless).
    pub(super) fn resolve_committee_peer(&self, id: &str) -> Option<PeerInfo> {
        let addr = self.get_peer_address_by_id(id)?;
        self.connected_peers_lockfree.get(&addr).map(|e| e.value().clone())
    }

    /// Tier-0 seed targets for `chunk_index` over the committee tree: the rotated root, or — when this
    /// producer IS the root or the root is unreachable — the root's direct children (so no chunk stalls
    /// at an absent/self root). Self is always excluded. Empty ⇒ caller uses the flat-relay fallback.
    pub(super) fn shred_seed_targets(&self, roster: &[String], chunk_index: usize, fanout: usize) -> Vec<PeerInfo> {
        let m = roster.len();
        if m == 0 { return Vec::new(); }
        let root = shred_tree_root(m, chunk_index);
        let root_id = &roster[root];
        if *root_id != self.node_id {
            if let Some(p) = self.resolve_committee_peer(root_id) {
                return vec![p];
            }
        }
        // Producer is the root, or root unreachable → seed the root's (logical-0) children directly.
        shred_tree_children(m, fanout, chunk_index, root).into_iter()
            .filter_map(|ci| {
                let id = &roster[ci];
                if *id == self.node_id { None } else { self.resolve_committee_peer(id) }
            })
            .collect()
    }

    /// Per-block version: sorted Kademlia order, then deterministic shuffle
    /// seeded by `block_height`. Use this on producer-broadcast and on
    /// forwarding paths that have the height in scope.
    pub(super) fn build_shred_protocol_routing_tree_for_block(
        &self,
        peers: &[PeerInfo],
        block_height: u64,
    ) -> Vec<PeerInfo> {
        let mut routing = self.build_shred_protocol_routing_tree(peers);
        if routing.len() <= 1 {
            return routing;
        }
        // SplitMix64-style PRNG seeded by block_height. Deterministic across
        // honest nodes; cheap; well-distributed for Fisher-Yates.
        let mut state: u64 = block_height
            .wrapping_mul(0x9E3779B97F4A7C15)
            .wrapping_add(0xBF58476D1CE4E5B9);
        // Fisher-Yates from the tail down.
        for i in (1..routing.len()).rev() {
            state = state.wrapping_add(0x9E3779B97F4A7C15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
            z = z ^ (z >> 31);
            let j = (z as usize) % (i + 1);
            routing.swap(i, j);
        }
        routing
    }

    /// Select target peers for a chunk using Kademlia distance
    pub(super) fn select_shred_protocol_targets(&self, routing_tree: &[PeerInfo], chunk_index: usize, fanout: usize) -> Vec<PeerInfo> {
        // Deterministic selection based on chunk index
        let start_index = (chunk_index * fanout) % routing_tree.len();
        let mut targets = Vec::new();
        
        for i in 0..fanout {
            let peer_index = (start_index + i) % routing_tree.len();
            targets.push(routing_tree[peer_index].clone());
        }
        
        targets
    }
    
    /// Handle incoming ShredProtocol chunk
    pub(super) fn handle_shred_protocol_chunk(&self, from_peer: &str, chunk: ShredProtocolChunk) {
        let height = chunk.block_height;
        
        // Skip stale below-tip chunks EXCEPT a repair we solicited: a >1MB failover winner is served over
        // the shred transport (handle_sync_request size-splits at SHRED_THRESHOLD), so a blanket drop here
        // strands the fork-choice supersede (the P2 convergence path). Solicited-only (our own
        // request_block_repair marks it, 30s TTL) — a peer cannot force below-tip reassembly. The
        // reconstructed block funnels to maybe_supersede_by_certified_round (round + producer-sig gated).
        let local_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        if height <= local_height && !crate::block_pipeline::is_repair_solicited(height) {
            return;
        }
        
        // ═══════════════════════════════════════════════════════════════════════════
        // PRODUCTION v2.54: GAP DETECTION - Signal missing blocks for sync
        // ═══════════════════════════════════════════════════════════════════════════
        // Problem: Fire-and-forget broadcast may lose blocks → nodes desync
        // Solution: Detect gaps and store in global queue for background sync
        // Main sync loop in node.rs will pick up and process these gaps
        // ═══════════════════════════════════════════════════════════════════════════
        let gap = height.saturating_sub(local_height + 1);
        if gap > 0 && gap <= 50 {
            // GAP DETECTED: Missing blocks between local_height and incoming block
            static GAP_SYNC_COOLDOWN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let last_log = GAP_SYNC_COOLDOWN.load(std::sync::atomic::Ordering::Relaxed);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            
            // Log at most once per 2 seconds to avoid spam
            if now > last_log + 2 {
                GAP_SYNC_COOLDOWN.store(now, std::sync::atomic::Ordering::Relaxed);
                // Unsigned shred height: only nudge the authenticated desync check (it re-reads the
                // signed-head oracle); never seed sync off it.
                crate::sync_manager::nudge_sync_check();
                if crate::node::is_info() {
                    println!("[INFO][GAP] detected local={} incoming={} gap={} nudge_desync",
                            local_height, height, gap);
                }
            }
        } else if gap > 50 {
            // Far-gap shred is unsigned (pre-reconstruction): only NUDGE the authenticated desync check.
            // SIGNED_HEAD_MAX advances solely on a Dilithium-verified head, so a forged height can't drive sync.
            crate::sync_manager::nudge_sync_check();
            if height % 50 == 0 && crate::node::is_warn() {
                println!("[WARN][GAP] large_gap local={} incoming={} gap={} nudge_desync",
                        local_height, height, gap);
            }
        }
        
        // CRITICAL FIX v2.19.24: Skip chunks for already processed blocks
        // This prevents infinite loop where chunks keep being forwarded and reconstructed
        if self.processed_shred_blocks.contains(&height) {
            // We already reconstructed this block, so skip re-assembly — but forwarding is a DUTY: our
            // children still need this chunk, and a node becomes reconstructable at ~2/3 of the stream, so
            // returning outright silenced the relay for every block's TAIL chunks (their whole subtree then
            // fell back to per-chunk repair). The per-chunk forward-once dedup inside the forwarder is the
            // loop guard; below-tip chunks are never relayed (targeted repair, not propagation).
            if height > local_height {
                self.forward_shred_protocol_chunk(from_peer, chunk);
            }
            return;
        }
        
        // DEBUG: Log chunk reception for first 500 blocks or every 10th
        // CRITICAL: Extended logging for initial network debugging
        if height <= 500 || height % 10 == 0 {
            if crate::node::is_info() {
                println!("[INFO][SHRED] Chunk {}/{} for block #{} from {} (parity: {})",
                    chunk.chunk_index + 1, chunk.total_chunks, height, 
                    get_privacy_id_for_addr(from_peer), chunk.is_parity);
            }
        }
        
        // v9.0: Validate chunk fields BEFORE any allocation.
        // Prevents OOM from malicious total_chunks or oversized data.
        if chunk.total_chunks > SHRED_PROTOCOL_MAX_CHUNKS {
            if crate::node::is_warn() {
                println!("[WARN][SHRED] reject_oversized total_chunks={} max={} from={}",
                         chunk.total_chunks, SHRED_PROTOCOL_MAX_CHUNKS, get_privacy_id_for_addr(from_peer));
            }
            return;
        }
        if chunk.data.len() > SHRED_PROTOCOL_CHUNK_SIZE {
            if crate::node::is_warn() {
                println!("[WARN][SHRED] reject_oversized chunk_data={} max={} from={}",
                         chunk.data.len(), SHRED_PROTOCOL_CHUNK_SIZE, get_privacy_id_for_addr(from_peer));
            }
            return;
        }
        // DoS: bound the chunk_index for BOTH kinds. A DATA chunk must be < total_chunks. A PARITY chunk is
        // indexed total_chunks + parity_index and was previously UNBOUNDED — a single crafted parity chunk
        // with chunk_index≈usize::MAX drove `parity_chunks.resize(idx+1, ..)` in the receiver-cache path to a
        // capacity-overflow panic (panic=abort ⇒ node crash) or a multi-GB OOM. GF(2^8) caps any legitimate
        // total shard index at 255 (data + parity ≤ 255), so any index ≥ that from any peer is hostile.
        // Parity cap is the GF(2^8) remainder (255 - data), matching the ENCODER's own bound; the old
        // +170 admitted a total shard index up to 340, contradicting the rationale above.
        let bad_index = if chunk.is_parity {
            chunk.chunk_index < chunk.total_chunks
                || chunk.chunk_index >= chunk.total_chunks
                    + 255usize.saturating_sub(chunk.total_chunks)
        } else {
            chunk.chunk_index >= chunk.total_chunks
        };
        if bad_index {
            if crate::node::is_warn() {
                println!("[WARN][SHRED] reject_bad_index idx={} total={} parity={}",
                         chunk.chunk_index, chunk.total_chunks, chunk.is_parity);
            }
            return;
        }
        // Cap pending assemblies to prevent memory exhaustion from future blocks. A SOLICITED repair is
        // exempt: it is the only path that unwedges a diverged tail (P2 convergence) and is self-throttled
        // (16/s budget + 2s per height), so junk future-height assemblies must not be able to starve it.
        const MAX_PENDING_ASSEMBLIES: usize = 30;
        if !self.shred_protocol_assemblies.contains_key(&height)
           && self.shred_protocol_assemblies.len() >= MAX_PENDING_ASSEMBLIES
           && !crate::block_pipeline::is_repair_solicited(height)
        {
            return; // don't start new assembly if too many pending
        }

        // CRITICAL FIX: Track state OUTSIDE DashMap lock to prevent deadlock
        // DashMap entry() holds a lock that would block remove() in reconstruct functions
        // v2.60: Added is_new_chunk to prevent infinite forwarding loops
        let (should_reconstruct_all, should_reconstruct_parity, total_chunks, chunks_count, parity_count, is_new_chunk);

        // Self-describing FEC: size the parity vector from the PRODUCER's OWN coding count (carried on
        // every chunk), so the decoder's ReedSolomon dimensions match the encoder's EXACTLY. Guessing it
        // (the legacy `total*0.5` estimate) mismatches the adaptive-redundancy encoder ⇒ Ok-but-wrong
        // reconstructed bytes. A pre-field chunk (num_coding_shreds==0) falls back to the legacy estimate;
        // Cap at the ENCODER's own GF(2^8) bound (255 - data): the old 170 let a peer seed parity_count=170
        // with total=170, so ReedSolomon::new(170,170)=340>256 failed on EVERY reconstruct for that height
        // (parity recovery disabled until the sweep evicted the assembly).
        let coding_shreds = if chunk.num_coding_shreds > 0 {
            chunk.num_coding_shreds.min(255usize.saturating_sub(chunk.total_chunks))
        } else {
            ((chunk.total_chunks as f32) * (SHRED_PROTOCOL_REDUNDANCY_FACTOR - 1.0)).ceil() as usize
        };

        {
            // Scoped block to release DashMap lock before calling reconstruct
            let mut assembly = self.shred_protocol_assemblies.entry(height)
                .or_insert_with(|| ShredProtocolBlockAssembly {
                    height,
                    chunks_received: vec![None; chunk.total_chunks],
                    parity_chunks: vec![None; coding_shreds],
                    total_chunks: chunk.total_chunks,
                    parity_count: coding_shreds,
                    original_block_size: chunk.original_block_size,  // CRITICAL: Store for reconstruction
                    is_macroblock: chunk.is_macroblock,  // PRODUCTION: Track block type
                    started_at: Instant::now(),
                    retransmit_attempts: 0,  // v2.21.3
                    retransmit_requested_at: None,  // v2.21.3
                    certificate: None,  // v2.26: Will be populated from chunk #0
                    expected_block_hash: None,  // FIX R23-P3: Will be populated from first chunk
                });

            // FIX R23-P3: Store block_hash from first chunk that carries it
            if assembly.expected_block_hash.is_none() {
                if let Some(bh) = chunk.block_hash {
                    assembly.expected_block_hash = Some(bh);
                }
            }

            // Cross-chunk consistency: a chunk whose framing disagrees with the assembly's first-seen values
            // (a DIFFERENT block reusing this height, a stale replay, or a malicious relay) must NOT be
            // merged — mixing two blocks' shreds is what produced the corrupt oversized-buffer symptom.
            // The binding fields are block IDENTITY + DATA layout: block_hash, total_chunks (data count) and
            // original_block_size are source-independent (the block splits into the same 512KB data chunks
            // regardless of who re-encodes it). num_coding_shreds is DELIBERATELY EXCLUDED — the live-
            // broadcast and bulk-sync paths legitimately choose different redundancy for the SAME block, and
            // a data chunk is interchangeable across both; a parity chunk that overflows the assembly's
            // parity vector is already dropped by the bounds check below, so it needs no framing reject.
            // Reject silently — honest shreds / repair carry the truth, and block_hash at reconstruct is the
            // final safety net.
            let framing_ok = assembly.total_chunks == chunk.total_chunks
                && assembly.original_block_size == chunk.original_block_size
                && match (assembly.expected_block_hash, chunk.block_hash) {
                    (Some(eh), Some(bh)) => eh == bh,
                    _ => true, // a chunk without a hash can't contradict; the hash-bearing majority sets it
                };
            if !framing_ok {
                if crate::node::is_warn() {
                    println!("[WARN][SHRED] framing_mismatch h={} drop_chunk idx={} from={}",
                             height, chunk.chunk_index, get_privacy_id_for_addr(from_peer));
                }
                return;
            }

            // v26 D4: accept cert from ANY chunk carrying it (idempotent
            // via assembly.certificate.is_none()) — not only chunk #0.
            if chunk.certificate.is_some() {
                if let Some(ref cert) = chunk.certificate {
                    if assembly.certificate.is_none() {
                        if crate::node::is_info() {
                            println!("[INFO][SHRED] cert_received block=#{} via_chunk={} parity={} serial={} node={}",
                                     height, chunk.chunk_index, chunk.is_parity, cert.serial_number, cert.node_id);
                        }
                        assembly.certificate = Some(cert.clone());
                        
                        // CRITICAL: Store certificate in certificate_manager immediately!
                        // This ensures it's available when block validation needs it
                        {
                            let mut cert_manager = self.certificate_manager.write();
                            cert_manager.store_remote_certificate(
                                cert.serial_number.clone(),
                                cert.certificate_bytes.clone()
                            );
                            if crate::node::is_info() {
                                println!("[INFO][SHRED] Certificate {} stored in manager (block #{})",
                                         cert.serial_number, height);
                            }
                        }
                    }
                }
            }
            
            // ═══════════════════════════════════════════════════════════════════════════
            // CRITICAL FIX v2.60: CHECK IF CHUNK IS NEW BEFORE STORING
            // ═══════════════════════════════════════════════════════════════════════════
            // Problem: Duplicate chunks were forwarded infinitely (292x for chunk 56!)
            // Root cause: No check if chunk already received → forward every time
            // Solution: Track is_new_chunk and ONLY forward new chunks
            // This eliminates infinite forwarding loops on high-latency networks
            // ═══════════════════════════════════════════════════════════════════════════
            
            // Store chunk (only if slot is empty)
            if chunk.is_parity {
                let parity_index = chunk.chunk_index.saturating_sub(chunk.total_chunks);
                if parity_index < assembly.parity_chunks.len() {
                    is_new_chunk = assembly.parity_chunks[parity_index].is_none();
                    if is_new_chunk {
                        assembly.parity_chunks[parity_index] = Some(chunk.data.clone());
                    }
                } else {
                    is_new_chunk = false;
                }
            } else {
                if chunk.chunk_index < assembly.chunks_received.len() {
                    is_new_chunk = assembly.chunks_received[chunk.chunk_index].is_none();
                    if is_new_chunk {
                        assembly.chunks_received[chunk.chunk_index] = Some(chunk.data.clone());
                    }
                } else {
                    is_new_chunk = false;
                }
            }
            
            // Check if we can reconstruct the block
            chunks_count = assembly.chunks_received.iter().filter(|c| c.is_some()).count();
            parity_count = assembly.parity_chunks.iter().filter(|c| c.is_some()).count();
            total_chunks = assembly.total_chunks;
            
            should_reconstruct_all = chunks_count == total_chunks;
            should_reconstruct_parity = !should_reconstruct_all && (chunks_count + parity_count >= total_chunks);
            
            // DEBUG: Log assembly progress for first 5 blocks
            if height <= 5 {
                if crate::node::is_info() {
                    println!("[INFO][SHRED] Block #{}: {}/{} data + {}/{} parity chunks received",
                        height, chunks_count, total_chunks, parity_count, assembly.parity_count);
                }
            }
        } // DashMap lock released here!
        
        // ═══════════════════════════════════════════════════════════════════════════
        // PRODUCTION v2.55: RECEIVER CACHE - Cache chunks IMMEDIATELY for repair
        // ═══════════════════════════════════════════════════════════════════════════
        // Problem: Receivers only cached after reconstruction → repair returned nothing!
        // Solution: Cache each chunk as it arrives so we can respond to repair requests
        // This enables ANY node that received chunks to serve repair, not just producer
        // ═══════════════════════════════════════════════════════════════════════════
        {
            // Update or create cache entry with this chunk
            let mut cache_entry = self.shred_chunk_cache.entry(height)
                .or_insert_with(|| {
                    // Estimate parity count based on adaptive redundancy
                    let estimated_parity = ((total_chunks as f32) * 1.5).ceil() as usize; // Conservative estimate
                    ShredChunkCacheEntry {
                        chunks: vec![None; total_chunks],
                        parity_chunks: vec![None; estimated_parity],
                        original_block_size: chunk.original_block_size,
                        is_macroblock: chunk.is_macroblock,
                        cached_at: Instant::now(),
                    }
                });
            
            // Store this chunk in cache
            if chunk.is_parity {
                let parity_idx = chunk.chunk_index.saturating_sub(total_chunks);
                // Expand parity vec if needed
                if parity_idx >= cache_entry.parity_chunks.len() {
                    cache_entry.parity_chunks.resize(parity_idx + 1, None);
                }
                if parity_idx < cache_entry.parity_chunks.len() {
                    cache_entry.parity_chunks[parity_idx] = Some(chunk.data.clone());
                }
            } else {
                if chunk.chunk_index < cache_entry.chunks.len() {
                    cache_entry.chunks[chunk.chunk_index] = Some(chunk.data.clone());
                }
            }
        }
        
        // v26 D4b: CERT-PRESENCE gate (decoupled from raw chunk #0).
        // Pre-D4 the cert lived ONLY in chunk #0, so "chunk #0 received"
        // was a valid proxy for "cert received" and the block was gated
        // on chunk #0. D4 replicates the cert onto chunk #0 + the first
        // parity chunks and the receiver stores it into
        // `assembly.certificate` from ANY cert-bearing chunk. The gate's
        // TRUE intent is "do we have the certificate?", so it must check
        // `assembly.certificate.is_some()` directly — NOT raw chunk #0.
        // Without this, D4's parity-cert path never unblocks finalization
        // (the freeze) and D5 (no chunk-#0 send priority) would strand
        // blocks waiting for a chunk #0 that may never arrive.
        // `cert_present`  → cert obtained from ANY cert-bearing chunk
        //                   (gate / forward / cert-repair use this).
        // `chunk0_received` → raw data chunk #0 present; ONLY for the
        //                   all-data fast reconstruction path below, which
        //                   genuinely needs chunk #0's bytes (Reed-Solomon
        //                   recovers it from parity otherwise). This is a
        //                   DATA concern, NOT a cert proxy — kept distinct.
        let (cert_present, chunk0_received) =
            if let Some(assembly) = self.shred_protocol_assemblies.get(&height) {
                (
                    assembly.certificate.is_some(),
                    assembly.chunks_received.get(0).map(|c| c.is_some()).unwrap_or(false),
                )
            } else {
                (false, false)
            };

        // Only mark processed if we can reconstruct AND the cert is in
        // hand (from any of the cert-bearing chunks). Prevents the
        // parity-before-cert race without making chunk #0 special.
        if (should_reconstruct_all || should_reconstruct_parity) && cert_present {
            self.processed_shred_blocks.insert(height);
        } else if should_reconstruct_parity && !cert_present {
            // Reconstructable but cert not yet received from any chunk —
            // do NOT finalize; keep waiting/repairing for a cert-bearing
            // chunk (chunk #0 OR a cert parity chunk).
            if height <= 500 || height % 100 == 0 {
                if crate::node::is_info() {
                    println!("[INFO][SHRED] block=#{} reconstructable ({}/{} + {}/{} parity) WAITING for certificate (any cert-bearing chunk)",
                        height, chunks_count, total_chunks, parity_count,
                        ((total_chunks as f32) * (SHRED_PROTOCOL_REDUNDANCY_FACTOR - 1.0)).ceil() as usize);
                }
            }
        }
        
        // Forward chunk to other peers (ShredProtocol propagation)
        // v2.60: CRITICAL FIX - Only forward NEW chunks to prevent infinite loops!
        // Problem: Without is_new_chunk check, duplicates forwarded 292x causing network storm
        // Solution: Forward ONLY if chunk is new AND block not ready for reconstruction
        // v26 D4b: keep forwarding until cert is in hand (not raw chunk #0).
        // FIX-3: forward every NEW chunk to our committee-tree children — a DUTY, not gated on whether we
        // can already reconstruct. Loop-safe via the per-chunk forward-once dedup inside the forwarder.
        // A solicited below-tip repair chunk (admitted above) is reconstructed locally but NEVER relayed:
        // it is a targeted repair for us, not live propagation, and caught-up children would only drop it.
        let should_forward = is_new_chunk && height > local_height;
        if should_forward {
            self.forward_shred_protocol_chunk(from_peer, chunk.clone());
        }
        
        // v26 D4b: cert-missing priority repair (decoupled from raw chunk #0).
        // Triggers on !cert_present (not !chunk0_received): once the cert
        // has arrived via ANY chunk we stop spamming chunk-#0 requests.
        // chunk #0 is still the requested target — it is a cert carrier
        // AND a data chunk needed for reconstruction (double duty), so
        // fetching it resolves the cert gap and a data gap at once.
        if !cert_present {
            if let Some(mut assembly) = self.shred_protocol_assemblies.get_mut(&height) {
                let elapsed_ms = assembly.started_at.elapsed().as_millis();

                // Priority request for chunk#0 after 200ms; repeat every 500ms.
                let chunk0_missing = assembly.chunks_received.get(0).map(|c| c.is_none()).unwrap_or(true);
                let can_request_chunk0 = chunk0_missing
                    && elapsed_ms >= 200
                    && assembly.retransmit_attempts < SHRED_CHUNK_MAX_RETRIES
                    && assembly.retransmit_requested_at
                        .map(|t| t.elapsed().as_millis() >= 500)
                        .unwrap_or(true);

                if can_request_chunk0 {
                    assembly.retransmit_attempts += 1;
                    assembly.retransmit_requested_at = Some(Instant::now());
                    drop(assembly);

                    if crate::node::is_info() {
                        println!("[INFO][REPAIR] cert_missing_chunk0_request h={} elapsed={}ms can_reconstruct={}",
                                 height, elapsed_ms, should_reconstruct_parity);
                    }
                    self.request_missing_chunks(height, vec![0], from_peer);
                }
            }
        }
        
        // Standard timeout for other missing chunks (only when forwarding)
        if should_forward {
            if let Some(mut assembly) = self.shred_protocol_assemblies.get_mut(&height) {
                let elapsed_secs = assembly.started_at.elapsed().as_secs();
                
                let can_request = assembly.retransmit_attempts < SHRED_CHUNK_MAX_RETRIES
                    && assembly.retransmit_requested_at
                        .map(|t| t.elapsed().as_secs() > SHRED_CHUNK_TIMEOUT_SECS)
                        .unwrap_or(true);
                
                if elapsed_secs >= SHRED_CHUNK_TIMEOUT_SECS && can_request {
                    // Find missing chunk indices
                    let missing_data: Vec<usize> = assembly.chunks_received.iter()
                        .enumerate()
                        .filter(|(_, c)| c.is_none())
                        .map(|(i, _)| i)
                        .collect();
                    
                    let missing_parity: Vec<usize> = assembly.parity_chunks.iter()
                        .enumerate()
                        .filter(|(_, c)| c.is_none())
                        .map(|(i, _)| assembly.total_chunks + i)
                        .collect();
                    
                    let total_missing = missing_data.len() + missing_parity.len();
                    
                    if total_missing > 0 {
                        assembly.retransmit_attempts += 1;
                        assembly.retransmit_requested_at = Some(Instant::now());
                        
                        let mut missing_indices = missing_data;
                        missing_indices.extend(missing_parity);
                        
                        // Drop the lock before requesting
                        drop(assembly);
                        
                        let attempt = self.shred_protocol_assemblies.get(&height)
                            .map(|a| a.retransmit_attempts)
                            .unwrap_or(0);
                        if crate::node::is_info() {
                            println!("[INFO][REPAIR] chunk_request h={} missing={} attempt={}", 
                                     height, total_missing, attempt);
                        }
                    
                        self.request_missing_chunks(height, missing_indices, from_peer);
                    }
                }
            }
        }
        
        // Chunk-#0 cert gate decoupled from parity reconstruction. The
        // cert lives in chunk #0, but requiring #0 to be physically present
        // conflated "can we Reed-Solomon-recover #0?" with "is its cert
        // valid?" → permanent block loss when #0 dropped but parity could
        // recover it (21% loss on the slowest peer). Now reconstruct
        // whenever the math allows; the recovered #0 still carries the
        // producer's signed cert, so a tampered/absent cert fails downstream
        // sig verify and is rejected before apply — same safety, no
        // discarded recoverable blocks.
        if should_reconstruct_all && chunk0_received {
            // Fast path: all data chunks received including chunk #0.
            self.reconstruct_block_from_shred_protocol(height);
        } else if should_reconstruct_parity {
            // Reed-Solomon recovery path. Works whether chunk #0 is present
            // or absent — the decoder reconstructs missing shards from the
            // received parity. Downstream signature verification gates the
            // recovered certificate.
            if height % 10 == 0 {
                if crate::node::is_info() {
                    let cert_state = if chunk0_received { "present" } else { "recoverable" };
                    println!("[INFO][SHRED] reconstruct_with_parity h={} data={} parity={} cert={}",
                             height, chunks_count, parity_count, cert_state);
                }
            }
            self.reconstruct_block_with_parity(height);
        } else if should_reconstruct_all && !chunk0_received {
            // All data chunks present except #0, and no parity to recover it.
            // The repair request was already dispatched above (priority retry).
            if height <= 500 || height % 100 == 0 {
                if crate::node::is_info() {
                    println!("[INFO][SHRED] waiting_chunk0 h={} data={}/{} parity=insufficient action=await_repair",
                             height, chunks_count, total_chunks);
                }
            }
        }
        
        // MEMORY CLEANUP: Remove old entries to prevent memory leak
        // Keep only last 1000 blocks in processed set
        if height > 1000 && height % 100 == 0 {
            let cleanup_threshold = height.saturating_sub(1000);
            self.processed_shred_blocks.retain(|&h| h > cleanup_threshold);
            
            // CRITICAL: Also cleanup stale assemblies (incomplete block reconstructions)
            // Remove assemblies older than 60 seconds to prevent memory leak
            self.shred_protocol_assemblies.retain(|_, assembly| {
                assembly.started_at.elapsed().as_secs() < 60
            });
        }
    }
    
    /// Forward ShredProtocol chunk to other peers via QUIC (async)
    pub(super) fn forward_shred_protocol_chunk(&self, original_sender: &str, chunk: ShredProtocolChunk) {
        // Don't forward if we're the original producer
        if self.node_id == original_sender {
            return;
        }

        // SAFE: Check if Tokio runtime is available to prevent panic
        let _handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] No Tokio runtime - operation skipped");
                }
                return;
            }
        };

        // FIX-3: forwarding is a DUTY — do NOT stop relaying just because THIS node already reconstructed
        // the block; our children still need their chunks. The per-chunk forward-once dedup below is the
        // sole loop guard (stale chunks are already dropped upstream by the height<=local check).

        // Per-chunk forward-once dedup (cascade-depth bound). The legacy
        // relay forwarded on EVERY arrival → O(F^h) duplicate emissions,
        // saturating bandwidth at scale. Bound it with purely local state:
        // forward each unique (block_height, chunk_idx) AT MOST ONCE; drop
        // re-arrivals at the forwarder. Coverage stays O(N) (the first
        // arrival fans out via normal routing; later arrivals only feed
        // local reconstruction). ≤8 KB/block, pruned with
        // processed_shred_blocks.
        let forward_key = (chunk.block_height, chunk.chunk_index as u32);
        if !FORWARDED_SHRED_CHUNKS.insert(forward_key) {
            // Already forwarded this chunk once — drop the duplicate
            // re-arrival without re-broadcasting. Reconstruction state
            // upstream still benefits from the duplicate data (Reed-Solomon
            // fill-in), but the relay tree does not amplify.
            if crate::node::is_debug() {
                println!(
                    "[DBG][SHRED] forward_dedup h={} idx={} dropped=duplicate_arrival",
                    chunk.block_height, chunk.chunk_index,
                );
            }
            return;
        }

        // FIX-3: forward to MY children in the canonical committee tree — provable coverage, O(m) relay,
        // and forwarding is a DUTY (independent of whether we can already reconstruct). A child is never
        // our parent/self in an F-ary heap, so the sender is structurally excluded. Not in the committee
        // ⇒ don't relay (we pull the block). Genesis epochs (roster None) ⇒ legacy flat relay fallback.
        let forward_targets: Vec<PeerInfo> = match self.shred_committee_roster(chunk.block_height)
            .filter(|r| !r.is_empty())
        {
            Some(roster) => {
                let m = roster.len();
                match roster.iter().position(|id| *id == self.node_id) {
                    None => Vec::new(),
                    Some(my_idx) => {
                        // Deterministic fanout (network-agreed) — same F-ary heap on every member.
                        let fanout = shred_tree_fanout(m);
                        shred_tree_children(m, fanout, chunk.chunk_index, my_idx).into_iter()
                            .filter_map(|ci| {
                                let id = &roster[ci];
                                if *id == self.node_id { None } else { self.resolve_committee_peer(id) }
                            })
                            .collect()
                    }
                }
            }
            None => {
                let validated_peers = self.get_validated_active_peers();
                let routing_tree = self.build_shred_protocol_routing_tree_for_block(&validated_peers, chunk.block_height);
                let shred_protocol_fanout = self.get_shred_protocol_fanout();
                let our_ip = self.external_ip.read().clone();
                let our_node_id = self.node_id.clone();
                routing_tree.iter()
                    .filter(|p| {
                        if p.addr == original_sender { return false; }
                        if p.id == our_node_id { return false; }
                        if let Some(ref own_ip) = our_ip {
                            let peer_ip = p.addr.split(':').next().unwrap_or("");
                            if peer_ip == own_ip { return false; }
                        }
                        true
                    })
                    .take(shred_protocol_fanout)
                    .cloned()
                    .collect()
            }
        };
        
        // Forward chunk via QUIC (binary, fast)
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
        let quic_transport = self.quic_transport.clone();
        
        // PRODUCTION v2.56: Log forward operations for debugging
        let height = chunk.block_height;
        let chunk_idx = chunk.chunk_index;
        let is_parity = chunk.is_parity;
        let forward_count = forward_targets.len();
        
        // Log every forward (critical for debugging large block issues)
        if forward_count > 0 && (height <= 100 || height % 100 == 0 || forward_count > 2) {
            if crate::node::is_info() {
                println!("[INFO][FORWARD] h={} chunk={} parity={} targets={}", 
                         height, chunk_idx, is_parity, forward_count);
            }
        }
        
        for peer in forward_targets {
            let peer_addr = peer.addr.clone();
            let chunk_clone = chunk.clone();
            let quic_transport_clone = quic_transport.clone();
            let peer_id = peer.id.clone();

            // PRODUCTION v2.56: Use dedicated BROADCAST_RUNTIME for chunk forwarding
            // Ensures forward operations never compete with main loop
            BROADCAST_RUNTIME.spawn(async move {
                let message = NetworkMessage::ShredProtocolChunk { chunk: chunk_clone };
                
                // Extract IP and calculate QUIC port
                let parts: Vec<&str> = peer_addr.split(':').collect();
                if parts.len() == 2 {
                    if let (Ok(ip), Ok(port)) = (parts[0].parse::<std::net::IpAddr>(), parts[1].parse::<u16>()) {
                        let quic_port = port.saturating_add(crate::quic_transport::QUIC_PORT_OFFSET);
                        let quic_addr = std::net::SocketAddr::new(ip, quic_port);
                        
                        if quic_enabled {
                            if let Some(ref transport) = quic_transport_clone {
                                let transport_guard = transport.read().await;
                                match transport_guard.broadcast_to(quic_addr, &message).await {
                                    Ok(_) => {
                                        // Success - chunk forwarded
                                    }
                                    Err(e) => {
                                        // Log forward failures for production debugging
                                        if height <= 100 {
                                            if crate::node::is_warn() {
                                                println!("[WARN][FORWARD] failed h={} to={} err={}", height, peer_id, e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            });
        }
    }
    
    /// PRODUCTION v2.37: Broadcast MacroBlock via dedicated channel (not ShredProtocol)
    /// ═══════════════════════════════════════════════════════════════════════════
    /// WHY NOT SHREDPROTOCOL:
    /// - ShredProtocol uses height as dedup key → collision with microblocks
    /// - MacroBlock #1 and Microblock #1 both use height=1 → one gets dropped
    /// - Separate broadcast ensures 100% delivery
    /// 
    /// ARCHITECTURE:
    /// - QUIC-only broadcast (same as microblocks, consensus commits/reveals)
    /// - 3 retry attempts with exponential backoff
    /// - Bounded parallelism (max 100 concurrent)
    /// - Dedicated channel for reliable MacroBlock delivery
    /// ═══════════════════════════════════════════════════════════════════════════
    pub async fn broadcast_macroblock(&self, index: u64, compressed_data: Vec<u8>, epoch: u64) -> Result<(), String> {
        use futures::stream::{self, StreamExt};
        
        let validated_peers = self.get_validated_active_peers();
        
        if validated_peers.is_empty() {
            if crate::node::is_warn() {
                println!("[WARN][MB-P2P] no peers for broadcast idx={}", index);
            }
            return Ok(());
        }
        
        let message = NetworkMessage::MacroBlockBroadcast {
            index,
            data: compressed_data.clone(),
            sender_id: self.node_id.clone(),
            epoch,
        };
        
        let peer_count = validated_peers.len();
        if crate::node::is_info() {
            println!("[INFO][MB-P2P] → broadcast idx={} epoch={} peers={} bytes={}", 
                     index, epoch, peer_count, compressed_data.len());
        }
        
        // PRODUCTION: QUIC-only broadcast with retries (same as consensus commits)
        let quic_transport = self.quic_transport.clone();
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
        
        if !quic_enabled {
            if crate::node::is_warn() {
                println!("[ERR][MB-P2P] QUIC not enabled - cannot broadcast idx={}", index);
            }
            return Err("QUIC transport required for MacroBlock broadcast".to_string());
        }
        
        // Collect peer addresses
        let peer_addresses: Vec<String> = validated_peers.iter()
            .map(|p| p.addr.clone())
            .collect();
        
        // PRODUCTION: Bounded parallelism with 3 retries (same as consensus)
        let results = stream::iter(peer_addresses.clone())
            .map(|peer_addr| {
                let msg = message.clone();
                let qt = quic_transport.clone();
                async move {
                    for attempt in 1..=3 {
                        if Self::send_consensus_message_with_retry(&peer_addr, &msg, qt.clone(), true).await {
                            return (peer_addr, true);
                        }
                        if attempt < 3 {
                            // Exponential backoff: 100ms, 200ms, 400ms
                            tokio::time::sleep(std::time::Duration::from_millis(100 * (1 << attempt))).await;
                        }
                    }
                    (peer_addr, false)
                }
            })
            .buffer_unordered(100) // Max 100 concurrent (same as consensus)
            .collect::<Vec<_>>()
            .await;
        
        let successful = results.iter().filter(|(_, ok)| *ok).count();
        let failed = results.iter().filter(|(_, ok)| !*ok).count();
        
        if failed > 0 {
            if crate::node::is_warn() {
                println!("[WARN][MB-P2P] broadcast idx={}: ok={} fail={}", index, successful, failed);
            }
            
            // RETRY: Second wave for failed peers (same as consensus)
            let failed_peers: Vec<_> = results.iter()
                .filter(|(_, ok)| !*ok)
                .map(|(addr, _)| addr.clone())
                .collect();
            
            if !failed_peers.is_empty() {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                
                let retry_results = stream::iter(failed_peers)
                    .map(|peer_addr| {
                        let msg = message.clone();
                        let qt = quic_transport.clone();
                        async move {
                            for attempt in 1..=2 {
                                if Self::send_consensus_message_with_retry(&peer_addr, &msg, qt.clone(), true).await {
                                    return true;
                                }
                                tokio::time::sleep(std::time::Duration::from_millis(500 * attempt as u64)).await;
                            }
                            false
                        }
                    })
                    .buffer_unordered(50)
                    .collect::<Vec<_>>()
                    .await;
                
                let retry_success = retry_results.iter().filter(|ok| **ok).count();
                if crate::node::is_info() {
                    println!("[INFO][MB-P2P] retry idx={}: +{} recovered", index, retry_success);
                }
            }
        } else {
            if crate::node::is_info() {
                println!("[INFO][MB-P2P] broadcast idx={} complete: {} peers", index, successful);
            }
        }
        
        Ok(())
    }
    
    /// PRODUCTION v2.56: Check if we have partial assembly for a block
    /// Used by failover logic to determine repair strategy
    pub fn has_partial_assembly(&self, block_height: u64) -> bool {
        self.shred_protocol_assemblies.contains_key(&block_height)
    }
    
    /// PRODUCTION v2.56: Check if block exists on network (prevents false emergency)
    /// ═══════════════════════════════════════════════════════════════════════════
    /// CRITICAL: Before triggering emergency, check if OTHER nodes have the block.
    /// If 2/3+ peers have the block → it's OUR problem (sync issue), not producer failure.
    /// This prevents FALSE EMERGENCY that causes FORKS.
    /// 
    /// TWO-LEVEL STRATEGY:
    /// 1. FAST PATH (Cache): Check peer heights from NetworkMessage::Block
    ///    - If 2/3+ peers have block → TRUST (majority consensus)
    ///    - ZERO network overhead - instant local check
    ///    - Heights updated every ~10s from Block messages (Dilithium-signed)
    /// 
    /// 2. SLOW PATH (HTTP Verify): If cache uncertain, verify via HTTP
    ///    - Query random peers: GET /api/v1/microblock/{height}
    ///    - Dynamic scaling: 3 peers (small network) to 7 peers (large network)
    ///    - 5s timeout total with parallel queries
    /// 
    /// SECURITY v5.0: Heights from NetworkMessage::Block (Dilithium-signed) + HealthPing (Dilithium-signed)
    /// ═══════════════════════════════════════════════════════════════════════════
    pub async fn check_block_exists_on_network(&self, block_height: u64) -> BlockExistenceResult {
        // ═══════════════════════════════════════════════════════════════════════════
        // LEVEL 1: Cache check (FAST PATH - 0ms)
        // ═══════════════════════════════════════════════════════════════════════════
        let mut total_peers = 0usize;
        let mut peers_with_block = 0usize;
        
        // OPTIMIZATION: Don't clone addresses yet - only if HTTP verify needed
        // This saves memory when fast path succeeds (majority of cases)
        for entry in self.connected_peers_lockfree.iter() {
            let peer = entry.value();
            
            // Skip self
            if peer.id == self.node_id {
                continue;
            }
            
            // Only count consensus-qualified peers (validated nodes)
            if !peer.is_consensus_qualified() {
                continue;
            }
            
            total_peers += 1;
            
            // Check if peer's last known height >= our target
            // v5.0: Heights from Block (Dilithium-signed) + HealthPing (Dilithium-signed)
            if peer.last_block_height >= block_height {
                peers_with_block += 1;
            }
        }
        
        // No peers to check
        if total_peers == 0 {
            if crate::node::is_info() {
                println!("[EMERGENCY][BLOCK_CHECK] h={} check=cache result=no_peers", block_height);
            }
            return BlockExistenceResult::NoPeers;
        }
        
        let cache_ratio = (peers_with_block as f64 / total_peers as f64 * 100.0) as u32;
        
        // FAST PATH SUCCESS: 2/3+ majority has block per cache
        if peers_with_block * 3 >= total_peers * 2 {
            if crate::node::is_info() {
                println!("[EMERGENCY][BLOCK_CHECK] h={} check=cache result=majority peers={}/{} ratio={}%", 
                         block_height, peers_with_block, total_peers, cache_ratio);
            }
            return BlockExistenceResult::MajorityHas { 
                peers_with: peers_with_block, 
                total_peers 
            };
        }
        
        if crate::node::is_info() {
            println!("[EMERGENCY][BLOCK_CHECK] h={} check=cache result=uncertain peers={}/{} ratio={}% http_verify=starting", 
                     block_height, peers_with_block, total_peers, cache_ratio);
        }
        
        // ═══════════════════════════════════════════════════════════════════════════
        // OPTIMIZATION: Collect peer addresses ONLY if HTTP verify needed
        // ═══════════════════════════════════════════════════════════════════════════
        // Efficiently select 3 random peers without cloning all addresses
        let candidate_peers: Vec<String> = self.connected_peers_lockfree.iter()
            .filter(|entry| {
                let peer = entry.value();
                peer.id != self.node_id && peer.is_consensus_qualified()
            })
            .map(|entry| entry.value().addr.clone())
            .collect();
        
        if candidate_peers.is_empty() {
            if crate::node::is_info() {
                println!("[EMERGENCY][BLOCK_CHECK] h={} check=http_verify result=no_candidates status=uncertain", 
                         block_height);
            }
            return BlockExistenceResult::Uncertain { 
                cache_peers_with: peers_with_block, 
                cache_total: total_peers 
            };
        }
        
        // ═══════════════════════════════════════════════════════════════════════════
        // LEVEL 2: HTTP verify (SLOW PATH - PARALLEL queries, max 5s total)
        // ═══════════════════════════════════════════════════════════════════════════
        // CRITICAL FIX v2.60: DYNAMIC SCALING for network size
        // Small network (5 nodes) → query 3 peers (60% of network)
        // Medium network (50 nodes) → query 5 peers
        // Large network (1000+ nodes) → query 7 peers (better Sybil resistance)
        let num_peers_to_query = if total_peers <= 5 {
            std::cmp::min(3, candidate_peers.len()) // Small network: 60% coverage
        } else if total_peers <= 100 {
            std::cmp::min(5, candidate_peers.len()) // Medium network: balanced
        } else {
            std::cmp::min(7, candidate_peers.len()) // Large network: max Sybil resistance
        };
        
        if crate::node::is_info() {
            println!("[EMERGENCY][BLOCK_CHECK] h={} check=http_verify strategy=dynamic_scaling total_peers={} query_count={} timeout=5s_total", 
                     block_height, total_peers, num_peers_to_query);
        }
        
        // Select random peers efficiently (no full shuffle, partial shuffle only if needed)
        use rand::seq::SliceRandom;
        use rand::SeedableRng;
        let mut rng = rand_chacha::ChaCha8Rng::from_entropy(); // Send-safe RNG
        let peers_to_query: Vec<String> = if candidate_peers.len() <= num_peers_to_query {
            candidate_peers
        } else {
            let mut sample = candidate_peers;
            sample.partial_shuffle(&mut rng, num_peers_to_query);
            sample.into_iter().take(num_peers_to_query).collect()
        };
        
        // CRITICAL FIX: Launch parallel HTTP queries with 5s global timeout
        // Cannot move self into async closures, so we collect futures directly
        let futures: Vec<_> = peers_to_query.iter()
            .map(|peer| self.query_peer_has_block(peer, block_height))
            .collect();
        
        let results = match tokio::time::timeout(
            Duration::from_secs(5),
            future::join_all(futures)
        ).await {
            Ok(results) => results,
            Err(_) => {
                if crate::node::is_info() {
                    println!("[EMERGENCY][BLOCK_CHECK] h={} check=http_verify result=global_timeout status=uncertain", 
                             block_height);
                }
                return BlockExistenceResult::Uncertain { 
                    cache_peers_with: peers_with_block, 
                    cache_total: total_peers 
                };
            }
        };
        
        // CRITICAL FIX: Analyze results - peers_to_query and results must align
        let mut exists_count = 0usize;
        let mut not_found_count = 0usize;
        let mut error_count = 0usize;
        let mut verified_peer: Option<String> = None;
        
        for (idx, result) in results.iter().enumerate() {
            let peer_addr = &peers_to_query[idx];
            // PRIVACY: Use pseudonym instead of raw IP for non-genesis nodes
            let peer_ip = peer_addr.split(':').next().unwrap_or(peer_addr);
            let peer_display = get_privacy_id_for_addr(peer_ip);
            match result {
                Ok(true) => {
                    exists_count += 1;
                    if verified_peer.is_none() {
                        verified_peer = Some(peer_addr.clone());
                    }
                    if crate::node::is_info() {
                        println!("[EMERGENCY][BLOCK_CHECK] h={} check=http_verify peer={} result=exists", 
                                 block_height, peer_display);
                    }
                },
                Ok(false) => {
                    not_found_count += 1;
                    if crate::node::is_info() {
                        println!("[EMERGENCY][BLOCK_CHECK] h={} check=http_verify peer={} result=not_found", 
                                 block_height, peer_display);
                    }
                },
                Err(e) => {
                    error_count += 1;
                    if crate::node::is_info() {
                        println!("[EMERGENCY][BLOCK_CHECK] h={} check=http_verify peer={} result=error error={}", 
                                 block_height, peer_display, e);
                    }
                }
            }
        }
        
        let total_responses = results.len();
        if crate::node::is_info() {
            println!("[EMERGENCY][BLOCK_CHECK] h={} check=http_verify summary exists={} not_found={} errors={} total={}", 
                     block_height, exists_count, not_found_count, error_count, total_responses);
        }
        
        // 2/3+ consensus: block exists
        if exists_count * 3 >= total_responses * 2 {
            if crate::node::is_info() {
                println!("[EMERGENCY][BLOCK_CHECK] h={} check=http_verify result=consensus_exists ratio={}/{}", 
                         block_height, exists_count, total_responses);
            }
            return BlockExistenceResult::VerifiedExists { 
                peer_addr: verified_peer.unwrap_or_else(|| "unknown".to_string())
            };
        }
        
        // ═══════════════════════════════════════════════════════════════════════════
        // CRITICAL FIX v2.84: QUIC fallback when HTTP fails (port 8001 blocked scenario)
        // HTTP may be blocked by DDoS protection/rate limiting, but QUIC (UDP 10876) often works
        // Strategy: Request block via QUIC, wait briefly, check if it arrived in storage
        // SECURITY v2.84: Rate limited to max 10 requests per minute per node
        // ═══════════════════════════════════════════════════════════════════════════
        if error_count > 0 && error_count >= total_responses / 2 {
            // Get node ID for rate limiting
            let node_id = GLOBAL_NODE_ID.read().clone();
            
            // PRIORITY 1: Rate limit check (max 10/min per node)
            if !quic_fallback_rate_check(&node_id) {
                if crate::node::is_warn() {
                    println!("[WARN][EMERGENCY] quic_fallback_rate_limited h={} node={}", 
                             block_height, qnet_state::char_prefix(&node_id, 8));
                }
                // Skip QUIC fallback due to rate limit
            } else {
                if crate::node::is_info() {
                    println!("[INFO][EMERGENCY] quic_fallback_start h={} http_errors={}", block_height, error_count);
                }
                
                // Increment total attempts metric (PRIORITY 3)
                QUIC_FALLBACK_TOTAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                
                // Get QUIC transport
                let quic_transport = GLOBAL_QUIC_TRANSPORT.read().clone();
                
                if let Some(ref transport_arc) = quic_transport {
                    use crate::quic_transport::QUIC_PORT_OFFSET;
                    
                    // Create RequestBlocks for single block
                    let request = NetworkMessage::RequestBlocks {
                        from_height: block_height,
                        to_height: block_height,
                        requester_id: node_id.clone(),
                    };
                    
                    // Try to send via QUIC to available peers
                    let mut quic_success = false;
                    for peer_addr in peers_to_query.iter().take(3) {
                        let parts: Vec<&str> = peer_addr.split(':').collect();
                        if parts.len() != 2 { continue; }
                        
                        let ip = match parts[0].parse::<std::net::IpAddr>() {
                            Ok(ip) => ip,
                            Err(_) => continue,
                        };
                        let port = match parts[1].parse::<u16>() {
                            Ok(p) => p,
                            Err(_) => continue,
                        };
                        
                        let quic_port = port.saturating_add(QUIC_PORT_OFFSET);
                        let quic_addr = std::net::SocketAddr::new(ip, quic_port);
                        
                        let transport = transport_arc.read().await;
                        if transport.broadcast_to(quic_addr, &request).await.is_ok() {
                            if crate::node::is_debug() {
                                println!("[DBG][EMERGENCY] quic_fallback_sent h={} peer={}", 
                                         block_height, get_privacy_id_for_addr(peer_addr));
                            }
                            quic_success = true;
                            break;
                        }
                    }
                    
                    if quic_success {
                        // PRIORITY 2: Wait for QUIC response (blocks come async via handle_blocks_batch)
                        // Increased to 3000ms for high-latency networks (Asia, Australia, satellite)
                        const QUIC_WAIT_MS: u64 = 3000;
                        const POLL_INTERVAL_MS: u64 = 100;
                        
                        let start = std::time::Instant::now();
                        while start.elapsed().as_millis() < QUIC_WAIT_MS as u128 {
                            tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
                            
                            // Check if block arrived in storage
                            if let Some(storage) = crate::node::try_get_storage() {
                                if storage.load_microblock(block_height).unwrap_or(None).is_some() {
                                    // PRIORITY 3: Increment success metric
                                    QUIC_FALLBACK_SUCCESS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                    
                                    if crate::node::is_info() {
                                        let (_succ, _total, rate) = get_quic_fallback_metrics();
                                        if crate::node::is_info() {
                                            println!("[INFO][EMERGENCY] quic_fallback_success h={} elapsed={}ms success_rate={}.{}%", 
                                                     block_height, start.elapsed().as_millis(), rate / 10, rate % 10);
                                        }
                                    }
                                    return BlockExistenceResult::VerifiedExists {
                                        peer_addr: "quic_fallback".to_string()
                                    };
                                }
                            }
                        }
                        
                        if crate::node::is_warn() {
                            println!("[WARN][EMERGENCY] quic_fallback_timeout h={} wait={}ms", 
                                     block_height, QUIC_WAIT_MS);
                        }
                    }
                } else {
                    if crate::node::is_warn() {
                        println!("[WARN][EMERGENCY] quic_fallback_no_transport h={}", block_height);
                    }
                }
            } // End of rate limit check
        }
        
        // All failed or majority says "not found"
        if crate::node::is_info() {
            println!("[EMERGENCY][BLOCK_CHECK] h={} check=http_verify result=no_consensus status=uncertain", 
                     block_height);
        }
        
        BlockExistenceResult::Uncertain { 
            cache_peers_with: peers_with_block, 
            cache_total: total_peers 
        }
    }
    
    /// ═══════════════════════════════════════════════════════════════════════════
    /// HTTP API: Query if peer has specific block with validation
    /// ═══════════════════════════════════════════════════════════════════════════
    /// GET /api/v1/microblock/{height} with 3s timeout
    /// CRITICAL: Using microblock endpoint (verified to exist in rpc.rs)
    /// SECURITY: Validates response body to prevent malicious peer attacks
    /// Returns Ok(true) if block exists AND valid, Ok(false) if not found, Err on errors
    pub(super) async fn query_peer_has_block(&self, peer_addr: &str, block_height: u64) -> Result<bool, String> {
        // Extract IP:PORT from peer address (robust parsing)
        let ip_port = peer_addr.rsplit_once('@')
            .map(|(_, addr)| addr)
            .unwrap_or(peer_addr);
        
        let url = format!("http://{}/api/v1/microblock/{}", ip_port, block_height);
        
        // Use global HTTP client (shared connection pool)
        match HTTP_CLIENT.get(&url)
            .timeout(Duration::from_secs(3))
            .send()
            .await 
        {
            Ok(response) if response.status().is_success() => {
                // CRITICAL: Validate response body to prevent malicious peer exploit
                // Malicious peer could return 200 OK with fake/empty data
                match response.json::<serde_json::Value>().await {
                    Ok(json) => {
                        // Verify response contains valid height field matching our query
                        match json.get("height").and_then(|h| h.as_u64()) {
                            Some(h) if h == block_height => {
                                // Block exists AND height matches
                                Ok(true)
                            },
                            Some(h) => {
                                // Height mismatch - peer is malicious or buggy
                                Err(format!("height_mismatch_expected_{}_got_{}", block_height, h))
                            },
                            None => {
                                // Missing or invalid height field
                                Err("invalid_response_no_height".to_string())
                            }
                        }
                    },
                    Err(e) => {
                        // Failed to parse JSON - invalid response
                        Err(format!("invalid_json_{}", e))
                    }
                }
            },
            Ok(response) if response.status() == 404 => {
                // Block not found (legitimate response)
                Ok(false)
            },
            Ok(response) => {
                // Other HTTP errors
                Err(format!("http_{}", response.status().as_u16()))
            },
            Err(e) => {
                // Network errors
                if e.is_timeout() {
                    Err("timeout".to_string())
                } else if e.is_connect() {
                    Err("connect_failed".to_string())
                } else {
                    Err(format!("network_{}", e))
                }
            }
        }
    }
    
    /// PRODUCTION v2.56: Trigger chunk repair for a block
    /// Called by failover logic before emergency to attempt chunk-based reconstruction
    pub fn trigger_chunk_repair(&self, block_height: u64) {
        // Get assembly to find missing chunks
        if let Some(assembly) = self.shred_protocol_assemblies.get(&block_height) {
            let total_chunks = assembly.total_chunks;
            
            // Find missing data chunk indices
            let mut missing_indices: Vec<usize> = assembly.chunks_received.iter()
                .enumerate()
                .filter(|(_, c)| c.is_none())
                .map(|(i, _)| i)
                .collect();
            
            // Add missing parity indices
            let parity_missing: Vec<usize> = assembly.parity_chunks.iter()
                .enumerate()
                .filter(|(_, c)| c.is_none())
                .map(|(i, _)| total_chunks + i)
                .collect();
            missing_indices.extend(parity_missing);
            
            if missing_indices.is_empty() {
                if crate::node::is_info() {
                    println!("[INFO][REPAIR] trigger_repair h={} no_missing_chunks", block_height);
                }
                return;
            }
            
            let received = assembly.chunks_received.iter().filter(|c| c.is_some()).count()
                + assembly.parity_chunks.iter().filter(|c| c.is_some()).count();
            
            if crate::node::is_info() {
                println!("[INFO][REPAIR] trigger_repair h={} missing={} received={}", 
                         block_height, missing_indices.len(), received);
            }
            
            drop(assembly); // Release lock before calling request
            
            // Request missing chunks from multiple peers (parallel)
            self.request_missing_chunks(block_height, missing_indices, "");
        } else {
            if crate::node::is_warn() {
                println!("[WARN][REPAIR] trigger_repair h={} no_assembly_found", block_height);
            }
        }
    }
    
    /// PRODUCTION v2.21.3: Request missing chunks from peers
    /// Called when block assembly times out without enough chunks
    pub(super) fn request_missing_chunks(&self, block_height: u64, missing_indices: Vec<usize>, last_peer: &str) {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] No Tokio runtime - operation skipped");
                }
                return;
            }
        };
        
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let request = NetworkMessage::RequestMissingChunks {
            block_height,
            missing_indices,
            requester_id: self.node_id.clone(),
            timestamp,
        };
        
        // Send to validated peers (not just last peer - they might not have the chunks)
        let peers = self.get_validated_active_peers();
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
        let quic_transport = self.quic_transport.clone();
        
        // SCALABILITY v2.21.3: Adaptive peer selection based on network size
        // Designed for networks from 5 to 100,000+ producers
        // 
        // Formula rationale:
        // - Need enough peers to likely find cached chunks
        // - But not too many to avoid network spam
        // - Probability of finding chunk increases with more peers
        //
        // Network size → Request peers → Success probability (if 50% have chunk)
        // 5-10 nodes   → 3 peers       → 87.5% (1 - 0.5^3)
        // 100 nodes    → 5 peers       → 96.9% (1 - 0.5^5)
        // 1,000 nodes  → 6 peers       → 98.4%
        // 10,000 nodes → 7 peers       → 99.2%
        // 100,000 nodes → 8 peers      → 99.6%
        let peer_count = peers.len();
        let request_peer_count = if peer_count <= 10 {
            3.min(peer_count)
        } else if peer_count <= 100 {
            5.min(peer_count)
        } else if peer_count <= 1_000 {
            6
        } else if peer_count <= 10_000 {
            7
        } else if peer_count <= 100_000 {
            8
        } else {
            // 100K+ nodes: cap at 10 to prevent spam
            10
        };
        
        for peer in peers.iter().take(request_peer_count) {
            if peer.addr == last_peer {
                continue; // Skip peer that just sent us a chunk (they might be missing same ones)
            }
            
            let peer_addr = peer.addr.clone();
            let request_clone = request.clone();
            let quic_transport_clone = quic_transport.clone();
            
            handle.spawn(async move {
                let parts: Vec<&str> = peer_addr.split(':').collect();
                if parts.len() == 2 {
                    if let (Ok(ip), Ok(port)) = (parts[0].parse::<std::net::IpAddr>(), parts[1].parse::<u16>()) {
                        let quic_port = port.saturating_add(crate::quic_transport::QUIC_PORT_OFFSET);
                        let quic_addr = std::net::SocketAddr::new(ip, quic_port);
                        
                        if quic_enabled {
                            if let Some(ref transport) = quic_transport_clone {
                                let transport_guard = transport.read().await;
                                let _ = transport_guard.broadcast_to(quic_addr, &request_clone).await;
                            }
                        }
                    }
                }
            });
        }
    }
    
    /// PRODUCTION v2.21.3: Handle incoming request for missing chunks
    pub(super) fn handle_missing_chunks_request(&self, from_peer: &str, block_height: u64, missing_indices: Vec<usize>, _requester_id: String) {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] No Tokio runtime - operation skipped");
                }
                return;
            }
        };
        
        // Check our chunk cache
        if let Some(cache_entry) = self.shred_chunk_cache.get(&block_height) {
            let mut chunks_to_send: Vec<(usize, Vec<u8>, bool)> = Vec::new();
            
            // The index list is attacker-supplied and one frame can carry tens of thousands of
            // entries, each naming a chunk clone. A repair can never legitimately want more chunks
            // than the block has, nor the same one twice: de-duplicate, cap to the block, and stop
            // at a byte ceiling so one request cannot assemble an arbitrary response.
            const MAX_REPAIR_BYTES: usize = 8 * 1024 * 1024;
            let total_chunks = cache_entry.chunks.len().saturating_add(cache_entry.parity_chunks.len());
            let mut wanted = missing_indices;
            wanted.sort_unstable();
            wanted.dedup();
            wanted.truncate(total_chunks);
            let mut assembled: usize = 0;

            for &idx in &wanted {
                let chunk = if idx < cache_entry.chunks.len() {
                    cache_entry.chunks[idx].as_ref().map(|c| (c, false))
                } else {
                    cache_entry.parity_chunks.get(idx - cache_entry.chunks.len())
                        .and_then(|c| c.as_ref()).map(|c| (c, true))
                };
                if let Some((chunk_data, is_parity)) = chunk {
                    assembled = assembled.saturating_add(chunk_data.len());
                    if assembled > MAX_REPAIR_BYTES {
                        if crate::node::is_warn() {
                            println!("[WARN][SHRED] repair_truncated h={} sent={} asked={} reason=byte_cap",
                                     block_height, chunks_to_send.len(), wanted.len());
                        }
                        break;
                    }
                    chunks_to_send.push((idx, chunk_data.clone(), is_parity));
                }
            }
            
            if !chunks_to_send.is_empty() {
                // ═══════════════════════════════════════════════════════════════════════════
                // CRITICAL FIX v2.60: REPAIR BATCHING for intercontinental reliability
                // ═══════════════════════════════════════════════════════════════════════════
                // Problem: 54 chunks = 7MB in one message → lost on high-latency routes!
                // Solution: Send in batches of 10 chunks with 5ms delay between batches
                // This matches broadcast pacing strategy and prevents UDP burst loss
                // ═══════════════════════════════════════════════════════════════════════════
                const REPAIR_BATCH_SIZE: usize = 10;  // 10 chunks × 512KB = 5.12MB per batch (v4.1)
                const REPAIR_BATCH_DELAY_MS: u64 = 5; // 5ms between batches for pacing
                
                let total_chunks = chunks_to_send.len();
                let num_batches = (total_chunks + REPAIR_BATCH_SIZE - 1) / REPAIR_BATCH_SIZE;
                
                if crate::node::is_info() {
                    println!("[INFO][SHRED] Sending {} cached chunks for block #{} to {} in {} batches",
                             total_chunks, block_height, get_privacy_id_for_addr(from_peer), num_batches);
                }
                
                // Send response via QUIC in batches
                let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
                let quic_transport = self.quic_transport.clone();
                let peer_addr = from_peer.to_string();
                let original_block_size = cache_entry.original_block_size;
                let is_macroblock = cache_entry.is_macroblock;
                let sender_id = self.node_id.clone();
                
                handle.spawn(async move {
                    let parts: Vec<&str> = peer_addr.split(':').collect();
                    if parts.len() == 2 {
                        if let (Ok(ip), Ok(port)) = (parts[0].parse::<std::net::IpAddr>(), parts[1].parse::<u16>()) {
                            let quic_port = port.saturating_add(crate::quic_transport::QUIC_PORT_OFFSET);
                            let quic_addr = std::net::SocketAddr::new(ip, quic_port);
                            
                            if quic_enabled {
                                if let Some(ref transport) = quic_transport {
                                    // Send chunks in batches with pacing
                                    for (batch_idx, batch) in chunks_to_send.chunks(REPAIR_BATCH_SIZE).enumerate() {
                                        let response = NetworkMessage::MissingChunksResponse {
                                            block_height,
                                            chunks: batch.to_vec(),
                                            original_block_size,
                                            is_macroblock,
                                            sender_id: sender_id.clone(),
                                        };
                                        
                                        let transport_guard = transport.read().await;
                                        let _ = transport_guard.broadcast_to(quic_addr, &response).await;
                                        
                                        // Pacing delay between batches (except last)
                                        if batch_idx < num_batches - 1 {
                                            tokio::time::sleep(std::time::Duration::from_millis(REPAIR_BATCH_DELAY_MS)).await;
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
            }
        }
    }
    
    /// PRODUCTION v2.21.3: Handle response with missing chunks
    pub(super) fn handle_missing_chunks_response(
        &self,
        block_height: u64,
        chunks: Vec<(usize, Vec<u8>, bool)>,
        _original_block_size: usize,
        _is_macroblock: bool,
        sender_id: &str,
    ) {
        if self.processed_shred_blocks.contains(&block_height) {
            return;
        }
        if let Some(mut assembly) = self.shred_protocol_assemblies.get_mut(&block_height) {
            let mut added_count = 0;
            for (idx, data, is_parity) in chunks {
                if is_parity {
                    let parity_idx = idx - assembly.total_chunks;
                    if parity_idx < assembly.parity_chunks.len() && assembly.parity_chunks[parity_idx].is_none() {
                        assembly.parity_chunks[parity_idx] = Some(data);
                        added_count += 1;
                    }
                } else if idx < assembly.chunks_received.len() && assembly.chunks_received[idx].is_none() {
                    assembly.chunks_received[idx] = Some(data);
                    added_count += 1;
                }
            }
            if added_count > 0 {
                let display_sender = if sender_id.starts_with("genesis_node_") {
                    sender_id.to_string()
                } else {
                    get_privacy_id_for_addr(sender_id)
                };
                if crate::node::is_debug() {
                    println!("[DBG][SHRED] retransmit_recv height={} chunks={} from={}",
                             block_height, added_count, display_sender);
                }
                let data_count = assembly.chunks_received.iter().filter(|c| c.is_some()).count();
                let parity_count = assembly.parity_chunks.iter().filter(|c| c.is_some()).count();
                let total_chunks = assembly.total_chunks;
                drop(assembly);
                if data_count == total_chunks {
                    self.processed_shred_blocks.insert(block_height);
                    self.reconstruct_block_from_shred_protocol(block_height);
                } else if data_count + parity_count >= total_chunks {
                    self.processed_shred_blocks.insert(block_height);
                    self.reconstruct_block_with_parity(block_height);
                }
            }
        }
    }
    
    /// PRODUCTION v2.21.3: Cache chunks after successful block reconstruction for retransmit
    pub(super) fn cache_chunks_for_retransmit(
        &self,
        height: u64,
        chunks: Vec<Option<Vec<u8>>>,
        parity_chunks: Vec<Option<Vec<u8>>>,
        original_block_size: usize,
        is_macroblock: bool,
    ) {
        // Cleanup old entries if cache is full
        if self.shred_chunk_cache.len() >= SHRED_CHUNK_CACHE_SIZE {
            let mut oldest_height = u64::MAX;
            for entry in self.shred_chunk_cache.iter() {
                if *entry.key() < oldest_height {
                    oldest_height = *entry.key();
                }
            }
            if oldest_height != u64::MAX {
                self.shred_chunk_cache.remove(&oldest_height);
            }
        }
        self.shred_chunk_cache.insert(height, ShredChunkCacheEntry {
            chunks,
            parity_chunks,
            original_block_size,
            is_macroblock,
            cached_at: Instant::now(),
        });
    }
    
    /// Reconstruct block from all data chunks
    pub(super) fn reconstruct_block_from_shred_protocol(&self, height: u64) {
        // Block already marked as processed in handle_shred_protocol_chunk
        let assembly = match self.shred_protocol_assemblies.remove(&height) {
            Some((_, asm)) => asm,
            None => {
                // Assembly already removed (race condition) - remove from processed for retry
                self.processed_shred_blocks.remove(&height);
                return;
            }
        };
        
        // CRITICAL FIX v2.105: Update producer's peer height from ShredProtocol certificate
        // ShredProtocol is the PRIMARY block delivery mechanism, but previously set
        // from_peer="shred_protocol" which never updated real peer heights.
        // This caused network_height to freeze at initial sync values on nodes that
        // did catchup sync (001, 005), while nodes without catchup (002, 003, 004)
        // accidentally showed correct height via unwrap_or(local_height) fallback.
        let producer_id = if let Some(ref cert) = assembly.certificate {
            let pid = cert.node_id.clone();
            // Liveness only: a reconstructed block height is an availability fact, not the peer tip.
            self.update_peer_last_seen(&pid);
            pid
        } else {
            "shred_protocol".to_string()
        };
        
        // PRODUCTION v2.21.3: Cache chunks for retransmit before processing
        self.cache_chunks_for_retransmit(
            height,
            assembly.chunks_received.clone(),
            assembly.parity_chunks.clone(),
            assembly.original_block_size,
            assembly.is_macroblock,
        );
        
        let mut block_data = Vec::new();

        for chunk_opt in assembly.chunks_received {
            if let Some(chunk) = chunk_opt {
                block_data.extend(chunk);
            }
        }

        // Trim padding back to original size
        if block_data.len() > assembly.original_block_size {
            block_data.truncate(assembly.original_block_size);
        }

        // FIX R23-P3: Verify block hash after reconstruction — detect chunk tampering
        if let Some(expected_hash) = assembly.expected_block_hash {
            use sha3::{Sha3_256, Digest};
            let mut hasher = Sha3_256::new();
            hasher.update(&block_data);
            let computed = hasher.finalize();
            if computed.as_slice() != &expected_hash[..] {
                eprintln!("[ERR][SHRED] block_hash_mismatch h={} expected={} computed={} action=discard",
                         height, hex::encode(&expected_hash[..8]), hex::encode(&computed[..8]));
                self.processed_shred_blocks.remove(&height);
                return;
            }
        }

        let elapsed = assembly.started_at.elapsed();
        if height % 10 == 0 {
            if crate::node::is_info() {
                println!("[INFO][SHRED] Block #{} reconstructed from {} chunks in {:?} (producer: {})",
                         height, assembly.total_chunks, elapsed, producer_id);
            }
        }

        // Send reconstructed block through normal block channel
        let block_tx_guard = self.block_tx.lock();
        
        // PRODUCTION: Use correct block_type based on chunk metadata
        let block_type = if assembly.is_macroblock { "macro".to_string() } else { "micro".to_string() };
        
        if let Some(ref block_tx) = &*block_tx_guard {
            // v11.1: Track pending (not a gate) — storage-level dedup in node.rs
            mark_block_pending_sync(height);

            let received_block = ReceivedBlock {
                height,
                data: block_data,
                // PRODUCTION: Use block type from chunk metadata (supports both micro and macro)
                block_type,
                from_peer: producer_id,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            };
            
            if let Err(_) = block_tx.try_send(received_block) {
                clear_block_pending_sync(height); // Clear on error
            }
        } else {
            // block_tx not initialized - remove from processed for retry
            if crate::node::is_info() {
                println!("[WARN][SHRED] Block #{} reconstructed but block_tx not ready, will retry", height);
            }
            self.processed_shred_blocks.remove(&height);
        }
    }
    
    /// Reconstruct block using Reed-Solomon parity (PRODUCTION)
    pub(super) fn reconstruct_block_with_parity(&self, height: u64) {
        // Block already marked as processed in handle_shred_protocol_chunk
        // PRODUCTION: Real Reed-Solomon reconstruction
        if let Some((_, assembly)) = self.shred_protocol_assemblies.remove(&height) {
            // CRITICAL FIX v2.105: Update producer's peer height from certificate
            // Same fix as reconstruct_block_from_shred_protocol - ShredProtocol
            // must update peer heights for correct network_height tracking
            let producer_id = if let Some(ref cert) = assembly.certificate {
                let pid = cert.node_id.clone();
                // Liveness only: a reconstructed block height is an availability fact, not the peer tip.
                self.update_peer_last_seen(&pid);
                pid
            } else {
                "shred_protocol-rs".to_string()
            };
            
            // PRODUCTION v2.21.3: Cache chunks for retransmit before processing
            self.cache_chunks_for_retransmit(
                height,
                assembly.chunks_received.clone(),
                assembly.parity_chunks.clone(),
                assembly.original_block_size,
                assembly.is_macroblock,
            );
            
            let data_count = assembly.total_chunks;
            let parity_count = assembly.parity_count;
            
            // Create Reed-Solomon decoder
            let rs = match ReedSolomon::new(data_count, parity_count) {
                Ok(rs) => rs,
                Err(e) => {
                    if crate::node::is_info() {
                        println!("[ERR][SHRED] Reed-Solomon init failed for reconstruction: {:?}", e);
                    }
                    // CRITICAL: Remove from processed so new chunks can retry
                    self.processed_shred_blocks.remove(&height);
                    return;
                }
            };
            
            // Prepare shards (data + parity)
            let chunk_size = assembly.chunks_received.iter()
                .chain(assembly.parity_chunks.iter())
                .filter_map(|opt| opt.as_ref())
                .map(|chunk| chunk.len())
                .max()
                .unwrap_or(SHRED_PROTOCOL_CHUNK_SIZE);
            
            let mut shards: Vec<Option<Box<[u8]>>> = Vec::new();
            
            // Add data chunks (Some for available, None for missing)
            for chunk_opt in assembly.chunks_received.iter() {
                if let Some(chunk) = chunk_opt {
                    let mut padded = chunk.clone();
                    padded.resize(chunk_size, 0);
                    shards.push(Some(padded.into_boxed_slice()));
                } else {
                    shards.push(None);
                }
            }
            
            // Add parity chunks
            for parity_opt in assembly.parity_chunks.iter() {
                if let Some(parity) = parity_opt {
                    let mut padded = parity.clone();
                    padded.resize(chunk_size, 0);
                    shards.push(Some(padded.into_boxed_slice()));
                } else {
                    shards.push(None);
                }
            }
            
            // Count available shards
            let available_count = shards.iter().filter(|s| s.is_some()).count();
            if available_count < data_count {
                if crate::node::is_info() {
                    println!("[ERR][SHRED] Not enough shards for reconstruction: {}/{} needed",
                             available_count, data_count);
                }
                // CRITICAL: Remove from processed so new chunks can retry
                self.processed_shred_blocks.remove(&height);
                return;
            }
            
            // Convert to proper format for reconstruction
            let mut rs_shards: Vec<Option<Vec<u8>>> = shards.into_iter()
                .map(|opt| opt.map(|boxed| boxed.into_vec()))
                .collect();
            
            // Reconstruct missing shards
            if let Err(e) = rs.reconstruct(&mut rs_shards) {
                if crate::node::is_info() {
                    println!("[ERR][SHRED] Reed-Solomon reconstruction failed: {:?}", e);
                }
                // CRITICAL: Remove from processed so new chunks can retry
                self.processed_shred_blocks.remove(&height);
                return;
            }
            
            // Convert back to shards for processing
            let shards: Vec<Option<Box<[u8]>>> = rs_shards.into_iter()
                .map(|opt| opt.map(|vec| vec.into_boxed_slice()))
                .collect();
            
            // Assemble reconstructed block from data shards
            // CRITICAL FIX: Use original_block_size instead of rposition
            // rposition incorrectly removes trailing zeros which corrupts bincode data!
            // SECURITY: cap allocation to max possible shred payload (防OOM from untrusted peer)
            let max_block_bytes = SHRED_PROTOCOL_MAX_CHUNKS * SHRED_PROTOCOL_CHUNK_SIZE;
            let original_size = assembly.original_block_size.min(max_block_bytes);
            let mut block_data = Vec::with_capacity(original_size);
            
            for shard_opt in shards.iter().take(data_count) {
                if let Some(shard) = shard_opt {
                    block_data.extend_from_slice(shard.as_ref());
                }
            }
            
            // Truncate to original size (remove padding)
            block_data.truncate(original_size);

            // Large blocks arrive ONLY via shreds — without this the size EMA saw just
            // small batched blocks and the byte-aware sync shard went blind under load.
            super::note_sync_block_size(block_data.len());

            let elapsed = assembly.started_at.elapsed();
            if crate::node::is_info() {
                println!("[INFO][SHRED] Block #{} reconstructed with Reed-Solomon in {:?}", height, elapsed);
            }
            
            // v2.26: Check if certificate was received (chunk #0 might have been lost)
            // If no certificate, the block validation in node.rs will use fallback mechanism
            // But we can log this for debugging
            if assembly.certificate.is_none() {
                if crate::node::is_info() {
                    println!("[WARN][SHRED] Block #{} reconstructed WITHOUT certificate (chunk #0 lost) - fallback will be used", height);
                }
                // NOTE: Don't panic - node.rs has retry mechanism for missing certificates
                // The block will be buffered and certificate requested via broadcast_certificate_announce
            } else {
                if crate::node::is_info() {
                    println!("[INFO][SHRED] Block #{} has certificate from chunk #0", height);
                }
            }
            
            // PRODUCTION: Use correct block_type based on chunk metadata
            let block_type = if assembly.is_macroblock { "macro".to_string() } else { "micro".to_string() };
            
            // Send reconstructed block through normal block channel
            let block_tx_guard = self.block_tx.lock();
            if let Some(ref block_tx) = &*block_tx_guard {
                // v11.1: Track pending (not a gate) — storage-level dedup in node.rs
                mark_block_pending_sync(height);

                let received_block = ReceivedBlock {
                    height,
                    data: block_data,
                    // PRODUCTION: Use block type from chunk metadata (supports both micro and macro)
                    block_type,
                    from_peer: producer_id,
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                };
                
                if let Err(_) = block_tx.try_send(received_block) {
                    clear_block_pending_sync(height); // Clear on error
                }
            }
        }
    }

    /// Send a single ShredProtocol chunk to a peer
    // REMOVED v2.19.21: send_shred_protocol_chunk replaced by async QUIC broadcast in broadcast_block_shred_protocol
    
    /// CRITICAL FIX v2.61: Send large block to specific peer via ShredProtocol (unicast)
    /// Used by sync to reliably deliver blocks >1MB that would fail as single QUIC message
    /// 
    /// ARCHITECTURE: Same chunking as broadcast_block_shred_protocol but targeted to one peer
    /// - Splits block into 512KB chunks with Reed-Solomon parity (v4.1)
    /// - Sends chunks sequentially with pacing to prevent congestion
    /// - Receiver uses existing handle_shred_protocol_chunk to reassemble
    pub async fn send_block_via_shred_to_peer(&self, peer_addr: &str, height: u64, block_data: Vec<u8>, is_macroblock: bool) {
        use crate::quic_transport::QUIC_PORT_OFFSET;
        use crate::node::{is_info, is_debug};
        
        let start_time = std::time::Instant::now();
        let block_size = block_data.len();
        let block_type = if is_macroblock { "macro" } else { "micro" };
        
        if is_info() {
            println!("[INFO][SHRED_SYNC] start h={} type={} size_kb={} peer={}", 
                     height, block_type, block_size / 1024, peer_addr);
        }
        
        // Check size limit
        if block_size > SHRED_PROTOCOL_MAX_CHUNKS * SHRED_PROTOCOL_CHUNK_SIZE {
            if crate::node::is_warn() {
                println!("[ERR][SHRED_SYNC] block_too_large h={} size_mb={} max_mb={}", 
                         height, block_size / 1024 / 1024, 
                         SHRED_PROTOCOL_MAX_CHUNKS * SHRED_PROTOCOL_CHUNK_SIZE / 1024 / 1024);
            }
            return;
        }
        
        // Get QUIC transport
        let quic_transport = GLOBAL_QUIC_TRANSPORT.read().clone();
        
        let Some(ref transport_arc) = quic_transport else {
            if is_debug() { println!("[DBG][SHRED_SYNC] no_quic_transport h={}", height); }
            return;
        };
        
        // Parse peer address to QUIC address
        let parts: Vec<&str> = peer_addr.split(':').collect();
        if parts.len() != 2 { return; }
        
        let ip = match parts[0].parse::<std::net::IpAddr>() {
            Ok(ip) => ip,
            Err(_) => return,
        };
        let port = match parts[1].parse::<u16>() {
            Ok(p) => p,
            Err(_) => return,
        };
        let quic_port = port.saturating_add(QUIC_PORT_OFFSET);
        let quic_addr = std::net::SocketAddr::new(ip, quic_port);
        
        // Split block into chunks (same logic as broadcast_block_shred_protocol)
        let original_block_size = block_size;
        let data_chunk_count = (block_size + SHRED_PROTOCOL_CHUNK_SIZE - 1) / SHRED_PROTOCOL_CHUNK_SIZE;
        let parity_chunk_count = (data_chunk_count + 1) / 2; // 50% redundancy
        let total_chunks = data_chunk_count + parity_chunk_count;
        
        // Pad data to exact chunk boundaries
        let mut padded_data = block_data.clone();
        let target_size = data_chunk_count * SHRED_PROTOCOL_CHUNK_SIZE;
        padded_data.resize(target_size, 0);
        
        // FIX R23-P3: Compute block hash for chunk authentication
        let block_hash: [u8; 32] = {
            use sha3::{Sha3_256, Digest};
            let mut hasher = Sha3_256::new();
            hasher.update(&block_data);
            let result = hasher.finalize();
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&result);
            arr
        };

        // Split into data chunks
        let mut data_chunks: Vec<Vec<u8>> = Vec::with_capacity(data_chunk_count);
        for i in 0..data_chunk_count {
            let start = i * SHRED_PROTOCOL_CHUNK_SIZE;
            let end = start + SHRED_PROTOCOL_CHUNK_SIZE;
            data_chunks.push(padded_data[start..end].to_vec());
        }

        // Generate Reed-Solomon parity chunks
        let parity_data = self.generate_parity_chunks(&data_chunks, parity_chunk_count);
        let chunk_time = start_time.elapsed();

        if is_debug() {
            println!("[DBG][SHRED_SYNC] chunked h={} data={} parity={} ms={}",
                     height, data_chunk_count, parity_chunk_count, chunk_time.as_millis());
        }

        // Send chunks with pacing (5ms between chunks)
        const CHUNK_PACING_MS: u64 = 5;
        let mut sent_count = 0;

        let transport = transport_arc.read().await;

        // Send data chunks
        for (i, chunk_data) in data_chunks.into_iter().enumerate() {
            let chunk = ShredProtocolChunk {
                block_height: height,
                chunk_index: i,
                total_chunks: data_chunk_count,
                data: chunk_data,
                is_parity: false,
                original_block_size,
                is_macroblock,
                certificate: None,
                block_hash: Some(block_hash),
                num_coding_shreds: parity_chunk_count,  // self-describing FEC
            };

            let msg = NetworkMessage::ShredProtocolChunk { chunk };

            if transport.broadcast_to(quic_addr, &msg).await.is_ok() {
                sent_count += 1;
            }

            tokio::time::sleep(std::time::Duration::from_millis(CHUNK_PACING_MS)).await;
        }

        // Send parity chunks
        for (i, parity_chunk_data) in parity_data.into_iter().enumerate() {
            let chunk = ShredProtocolChunk {
                block_height: height,
                chunk_index: data_chunk_count + i,
                total_chunks: data_chunk_count,
                data: parity_chunk_data,
                is_parity: true,
                original_block_size,
                is_macroblock,
                certificate: None,
                block_hash: Some(block_hash),
                num_coding_shreds: parity_chunk_count,  // self-describing FEC
            };

            let msg = NetworkMessage::ShredProtocolChunk { chunk };

            if transport.broadcast_to(quic_addr, &msg).await.is_ok() {
                sent_count += 1;
            }
            
            tokio::time::sleep(std::time::Duration::from_millis(CHUNK_PACING_MS)).await;
        }
        
        let total_time = start_time.elapsed();
        let throughput_kbps = if total_time.as_millis() > 0 {
            (block_size as u64 * 8) / total_time.as_millis() as u64  // kbit/s
        } else { 0 };
        
        if is_info() {
            println!("[INFO][SHRED_SYNC] done h={} sent={}/{} size_kb={} ms={} kbps={}", 
                     height, sent_count, total_chunks, block_size / 1024, 
                     total_time.as_millis(), throughput_kbps);
        }
    }
    
}

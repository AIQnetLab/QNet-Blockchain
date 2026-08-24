//! Inbound message dispatch and the per-class handlers.

use super::*;

impl SimplifiedP2P {
    /// Handle block request from peer for sync
    pub fn handle_block_request(&self, from_peer: &str, from_height: u64, to_height: u64, requester_id: String) {
        // Update last_seen for requesting peer
        self.update_peer_last_seen(from_peer);

        // Finalized blocks are public, QC-bound data: served to ANY peer so a fresh node bootstraps
        // BEFORE it is on-chain registered (sync-first, register-second). A peer cannot forge a block
        // (needs a 2f+1 ML-DSA-65 QC), so identity is not a serving prerequisite. DoS is bounded by
        // the per-(IP,id) rate-limit below + leader-shed — not by registration status.

        // Shed sync-serving ONLY while actively producing (protects the producer's RocksDB I/O
        // budget). A node elected for the next slot but STALLED — no block produced in the last
        // few seconds — is not producing; shedding then would block the repair that unfreezes the
        // chain, so it serves instead.
        let local_chain_height_now = LOCAL_BLOCKCHAIN_HEIGHT
            .load(std::sync::atomic::Ordering::Relaxed);
        let next_height = local_chain_height_now.saturating_add(1);
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let last_produced = crate::node::LAST_BLOCK_PRODUCED_TIME.load(std::sync::atomic::Ordering::Relaxed);
        let actively_producing = last_produced > 0 && now_secs.saturating_sub(last_produced) <= 3;
        if let Some((expected_producer, _round)) = crate::node::get_expected_producer(next_height) {
            if actively_producing && expected_producer == self.node_id {
                // I am the elected producer for the next slot — defer sync serving.
                if crate::node::is_debug() {
                    println!(
                        "[DBG][SYNC] leader_shed peer={} requester={} my_slot_h={} reason=current_producer",
                        from_peer, requester_id, next_height
                    );
                }
                let response = NetworkMessage::BlocksBatch {
                    blocks: Vec::new(),
                    from_height,
                    to_height: from_height,
                    sender_id: self.node_id.clone(),
                };
                if let Some(peer_addr) = self.peer_id_to_addr.get(&requester_id) {
                    self.send_network_message(&peer_addr.clone(), response);
                }
                return;
            }
        }

        // RATE LIMITING: Check if peer is making too many sync requests
        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // v7.2: Adaptive rate limiting based on REAL lag, not request size.
        // Compare the requested height against our local chain tip.
        // A node requesting h=300 when we are at h=8000 is 7700 blocks behind —
        // that's a syncing node, not a DDoS. Let it catch up.
        let local_chain_height = LOCAL_BLOCKCHAIN_HEIGHT
            .load(std::sync::atomic::Ordering::Relaxed);
        let blocks_behind = local_chain_height.saturating_sub(to_height);

        // v9.0 BUG-16: Genesis bypass uses ONLY transport-verified IP (from_peer),
        // NOT the self-declared requester_id which is spoofable.
        // QUIC+TLS ensures from_peer IP is authentic (can't be spoofed without valid cert).
        let is_genesis_peer = from_peer.split(':').next()
            .map(|ip| is_genesis_node_ip(ip))
            .unwrap_or(false);

        // Rate-limit key = (transport-verified IP, self-declared
        // requester_id). An IP-only key let NAT-shared honest nodes starve
        // each other's budget, and let a Byzantine peer at one IP spoof many
        // requester_ids. Binding both gives each (IP,id) tuple its own
        // bucket; the IP half is QUIC+TLS-anchored while the id is untrusted,
        // so the worst case (cycling N fake ids → N buckets) is bounded by
        // DashMap eviction. O(1)/request.
        let from_ip = from_peer.split(':').next().unwrap_or(from_peer);
        // Truncate requester_id to a safe prefix to prevent attacker-driven
        // unbounded map-key growth.
        let id_prefix: String = requester_id.chars().take(48).collect();

        // Check rate limit (adaptive based on sync state)
        let rate_limited = {
            // v9.0: GENESIS BYPASS - Only by verified IP, not self-declared ID
            if is_genesis_peer {
                false // Genesis nodes always allowed
            // Priority (60/min) for any request the requester legitimately lacks: to_height ≤ our tip
            // means we HAVE the block and it's a real catch-up/repair (near-tip repair included), not a
            // future-height probe. The tip is unspoofable (server's own), extending priority past the 5
            // genesis IPs to every honest super-node. id_prefix is caller-chosen (only the IP is
            // QUIC-anchored), so a joint (IP,id) bucket alone could be multiplied by cycling ids — a
            // per-IP aggregate ceiling bounds one IP's TOTAL priority serve first, then the joint bucket
            // isolates co-located peers within it.
            } else if to_height <= local_chain_height && local_chain_height > 0 {
                // Per-IP aggregate ceiling — the hard bound against id-cycling amplification. Checked and
                // released before the joint bucket (distinct keys, no overlapping DashMap guard).
                let ip_over = {
                    let ip_key = format!("priority_ip_{}", from_ip);
                    let mut agg = self.rate_limiter.entry(ip_key).or_insert_with(|| RateLimit {
                        requests: Vec::new(),
                        max_requests: 180,  // ≈3 co-located full-rate repairs; caps a cycling-id attacker
                        window_seconds: 60,
                        blocked_until: 0,
                    });
                    if agg.blocked_until > current_time { true }
                    else {
                        let w = agg.window_seconds;
                        agg.requests.retain(|&t| t > current_time - w);
                        if agg.requests.len() >= agg.max_requests { agg.blocked_until = current_time + 30; true }
                        else { agg.requests.push(current_time); false }
                    }
                };
                if ip_over {
                    if crate::node::is_warn() {
                        println!("[WARN][SYNC] priority_ip_rate_exceeded ip={} id={}", from_ip, id_prefix);
                    }
                    true
                } else {
                // v24: joint (IP, node_id) key — see header above.
                let rate_key = format!("priority_sync_{}_{}", from_ip, id_prefix);
                let mut rate_limit = self.rate_limiter.entry(rate_key).or_insert_with(|| RateLimit {
                    requests: Vec::new(),
                    max_requests: 60,  // 60 requests/min for syncing (vs 10 normal)
                    window_seconds: 60,
                    blocked_until: 0,
                });
                if rate_limit.blocked_until > current_time {
                    true // Still rate limited even in priority mode
                } else {
                    let window = rate_limit.window_seconds;
                    rate_limit.requests.retain(|&t| t > current_time - window);
                    if rate_limit.requests.len() >= rate_limit.max_requests {
                        rate_limit.blocked_until = current_time + 30; // 30s block (vs 60s normal)
                        if crate::node::is_warn() {
                            println!("[WARN][SYNC] priority_rate_exceeded peer={} id={} behind={}",
                                     from_peer, id_prefix, blocks_behind);
                        }
                        true
                    } else {
                        rate_limit.requests.push(current_time);
                        false
                    }
                }
                }
            } else {
                // Normal rate limiting for synchronized nodes.
                // v24: joint (IP, node_id) key — see header above.
                let rate_key = format!("sync_{}_{}", from_ip, id_prefix);

                let mut rate_limit = self.rate_limiter.entry(rate_key).or_insert_with(|| RateLimit {
                    requests: Vec::new(),
                    max_requests: 10,  // 10 sync requests per minute for normal operation
                    window_seconds: 60,
                    blocked_until: 0,
                });

                // Check if currently blocked
                if rate_limit.blocked_until > current_time {
                    if crate::node::is_warn() {
                        println!("[WARN][SYNC] rate_limited peer={} id={} blocked_for={}s",
                                 from_peer, id_prefix, rate_limit.blocked_until - current_time);
                    }
                    return;
                }

                // Clean old requests outside window
                let window = rate_limit.window_seconds;
                rate_limit.requests.retain(|&req_time| req_time > current_time - window);

                // Check if limit exceeded
                if rate_limit.requests.len() >= rate_limit.max_requests {
                    rate_limit.blocked_until = current_time + 60; // Block for 1 minute
                    if crate::node::is_warn() {
                        println!("[WARN][SYNC] rate_limit_exceeded peer={} id={} requests={}",
                                 from_peer, id_prefix, rate_limit.max_requests);
                    }
                    true
                } else {
                    // Add this request
                    rate_limit.requests.push(current_time);
                    false
                }
            }
        };
        
        if rate_limited {
            return;
        }
        
        // v11.1: Don't serve blocks we don't have — prevents empty batch spam
        let our_h = servable_height();
        if from_height > our_h && our_h > 0 {
            if crate::node::is_info() {
                println!("[INFO][SYNC] skip_above_our_height from={} our_h={} peer={}", from_height, our_h, requester_id);
            }
            return;
        }

        // Validate request range (max 100 blocks per batch for performance)
        let max_batch = 100;
        let actual_to = if to_height.saturating_sub(from_height) > max_batch {
            from_height.saturating_add(max_batch).saturating_sub(1)
        } else {
            to_height
        };

        if crate::node::is_debug() {
            println!("[DBG][SYNC] serve heights={}-{} peer={}", from_height, actual_to, requester_id);
        }
        
        // CRITICAL FIX: Send sync request to node.rs where storage is available
        // v5.6: Include from_peer address so response can reach unregistered peers
        if let Some(ref sync_tx) = self.sync_request_tx {
            if let Err(e) = sync_tx.try_send((from_height, actual_to, requester_id.clone(), from_peer.to_string())) {
                if crate::node::is_warn() {
                    println!("[WARN][SYNC] request_forward_failed err={}", e);
                }
            }
        } else {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] sync_channel_unavailable peer={}", requester_id);
            }
            
            // Fallback: send empty batch to prevent timeout
            let response = NetworkMessage::BlocksBatch {
                blocks: Vec::new(),
                from_height,
                to_height: actual_to,
                sender_id: self.node_id.clone(),
            };
            
            // SCALABILITY FIX: Use O(1) lookup instead of O(n) find
            if let Some(peer_addr) = self.peer_id_to_addr.get(&requester_id) {
                self.send_network_message(&peer_addr.clone(), response);
                if crate::node::is_info() {
                    println!("[INFO][SYNC] fallback_empty_batch peer={}", requester_id);
                }
            } else {
                // Fallback for Genesis nodes not in index
                let peers = self.get_validated_active_peers();
                if let Some(peer) = peers.iter().find(|p| p.id == requester_id) {
                    self.send_network_message(&peer.addr, response);
                    if crate::node::is_info() {
                        println!("[INFO][SYNC] fallback_empty_batch peer={} lookup=scan", requester_id);
                    }
                }
            }
        }
    }
    
    /// Handle blocks batch received for sync
    /// v3.0: CRITICAL FIX - Deduplicate blocks before queuing to prevent memory leak
    /// When sync_blocks requests from 3 peers, each sends the same blocks
    /// Without dedup: 2000 blocks × 3 peers = 6000 queue entries = OOM
    /// 
    /// DEDUPLICATION LAYERS:
    /// 1. Check PENDING_SYNC_BLOCKS (already queued but not processed yet)
    /// 2. Check storage (already processed and saved)
    /// 3. Backpressure: reject if queue > MAX_PENDING_SYNC_BLOCKS
    /// 
    /// v2.104: FIXED - On backpressure, cleanup stale entries first instead of dropping
    pub fn handle_blocks_batch(&self, blocks: Vec<(u64, Vec<u8>)>, from_height: u64, to_height: u64, sender_id: String) {
        // Liveness only: a delivered block proves the sender HAD that height (an availability fact
        // bounded by our own request window), never its tip. The network tip comes from signed heads.
        self.update_peer_last_seen(&sender_id);
        
        // v2.104: BACKPRESSURE - Check queue size and cleanup if needed
        let queue_size = get_pending_sync_count();
        if queue_size >= SOFT_LIMIT_PENDING_SYNC_BLOCKS {
            // Proactive cleanup before hard limit
            let cleaned = cleanup_pending_sync_blocks();
            if crate::node::is_info() && cleaned > 0 {
                println!("[INFO][SYNC] proactive_cleanup cleaned={} queue_now={}", 
                         cleaned, get_pending_sync_count());
            }
        }
        
        // Check again after cleanup
        let queue_size = get_pending_sync_count();
        if queue_size >= MAX_PENDING_SYNC_BLOCKS {
            // v2.104: Even after cleanup, queue is full - log and continue with what we can
            // Don't return immediately - try to process some blocks
            if crate::node::is_warn() {
                println!("[WARN][SYNC] backpressure queue={} max={} from={} (will process with priority)", 
                         queue_size, MAX_PENDING_SYNC_BLOCKS, sender_id);
            }
            // Don't return - let individual blocks be processed with priority filtering
        }
        
        // v3.0: DEDUPLICATION - Check storage BEFORE queuing to prevent 3x memory usage
        let storage = match crate::node::try_get_storage() {
            Some(s) => s,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][SYNC] storage_unavailable skip_batch from={}", sender_id);
                }
                return;
            }
        };
        
        // CRITICAL: Send blocks to block receiver for processing
        if let Some(ref block_tx) = &*self.block_tx.lock() {
            let mut queued = 0u32;
            let mut skipped_exists = 0u32;
            let skipped_pending = 0u32;
            let skipped_backpressure = 0u32;
            
            for (height, data) in blocks {
                // v11.1: Dedup at STORAGE level only — never skip delivered blocks
                // Previous dup_pending skip caused deadlock: block marked pending on first
                // request, then every re-delivery skipped → block never reached sync_order_buffer.
                // Now: always accept delivered blocks, let sync_order_buffer handle ordering.
                if storage.load_microblock(height).unwrap_or(None).is_some() {
                    clear_block_pending_sync(height);
                    skipped_exists += 1;
                    // A sync/repair-delivered block at a height we ALREADY hold may be a higher-2f+1-
                    // certified-round failover WINNER — route it through the SAME fork-choice supersede
                    // the gossip decode path uses. Without this the batch path drops it here, before the
                    // pipeline, so fix B's request_block_repair reconcile can never converge a restarted/
                    // late voter that missed the seconds-long live-gossip window (boundary re-freeze).
                    crate::block_pipeline::supersede_stored_from_sync(&storage, height, &data, &sender_id, self);
                    continue;
                }
                // Mark as pending (tracking only, not a gate)
                mark_block_pending_sync(height);
                
                // Create ReceivedBlock for processing
                let received_block = ReceivedBlock {
                    height,
                    data,
                    block_type: "micro".to_string(), // Batch sync is for microblocks
                    from_peer: sender_id.clone(),
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                };
                
                // Send to block processor
                if let Err(e) = block_tx.try_send(received_block) {
                    clear_block_pending_sync(height); // Remove from pending on error
                    if crate::node::is_warn() {
                        println!("[WARN][SYNC] queue_fail h={} err={}", height, e);
                    }
                } else {
                    queued += 1;
                }
            }
            
            if crate::node::is_info() {
                println!("[INFO][SYNC] batch from={} range={}-{} queued={} dup_storage={} dup_pending={} backpressure={}", 
                         sender_id, from_height, to_height, queued, skipped_exists, skipped_pending, skipped_backpressure);
            }
        } else {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] block_processor_unavailable from={}", sender_id);
            }
        }
    }
    
    // =========================================================================
    // MACROBLOCK SYNC METHODS (PRODUCTION v2.19.12)
    // =========================================================================
    // Architecture:
    // - Macroblocks are requested by INDEX (not height)
    // - Index 1 = blocks 1-90, Index 2 = blocks 91-180, etc.
    // - Max 10 macroblocks per batch (~1MB)
    // - Rate limiting: 5 requests/minute (macroblocks are large)
    // - Only Super nodes participate in this sync path. Light nodes are
    //   pure mobile API clients (no on-device chain storage) and use the
    //   REST API instead of macroblock peer-to-peer sync.
    // =========================================================================
    
    /// Handle a control-lane single-anchor macroblock request (P6). Same public-data + IP-genesis
    /// bypass model as handle_macroblock_request, but its OWN burst-then-throttle bucket sized to one
    /// cold-start anchor sweep (not the strict 5/min bulk bucket), so a legit joiner can pull the
    /// lineage it needs to bind a snapshot while a Byzantine flood stays bounded per (IP,id). Serves
    /// via the same storage-backed channel; the control-lane priority is on the REQUEST side.
    pub fn handle_macroblock_anchor_request(&self, from_peer: &str, index: u64, requester_id: String) {
        self.update_peer_last_seen(from_peer);

        let is_genesis_peer = from_peer.split(':').next()
            .map(|ip| is_genesis_node_ip(ip))
            .unwrap_or(false);
        if !is_genesis_peer {
            let current_time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let from_ip = from_peer.split(':').next().unwrap_or(from_peer);
            let id_prefix: String = requester_id.chars().take(48).collect();
            // Burst sized to one cold-start anchor sweep per minute, then throttle.
            const MB_ANCHOR_BURST: usize = 120;
            let rate_key = format!("mb_anchor_{}_{}", from_ip, id_prefix);
            let mut rate_limit = self.rate_limiter.entry(rate_key).or_insert_with(|| RateLimit {
                requests: Vec::new(),
                max_requests: MB_ANCHOR_BURST,
                window_seconds: 60,
                blocked_until: 0,
            });
            if rate_limit.blocked_until > current_time {
                return;
            }
            let window = rate_limit.window_seconds;
            rate_limit.requests.retain(|&t| t > current_time - window);
            if rate_limit.requests.len() >= rate_limit.max_requests {
                rate_limit.blocked_until = current_time + 60;
                if crate::node::is_warn() {
                    println!("[WARN][ANCHOR] rate_exceeded peer={} id={} idx={}", from_peer, id_prefix, index);
                }
                return;
            }
            rate_limit.requests.push(current_time);
        }

        // Self-scoped TOTAL serve ceiling (anti distributed-flood). The per-(IP,id) burst above bounds
        // any single source, but a spoofed flood across many keys could still pile up on one node. A
        // committee member serves anchors generously as a first-class duty (the E fan-out routes joiners
        // here), so the ceiling is high — but bounded so one node can never serve unboundedly. Genesis
        // peers bypass (trusted). am_committee is observability only. (Separate from the burst entry
        // above: never hold two DashMap entries of the same map at once → that one is already dropped.)
        if !is_genesis_peer {
            let am_committee = self.deterministic_eligible_ids()
                .map(|c| c.contains(&self.node_id)).unwrap_or(false);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
            const MB_ANCHOR_SERVE_TOTAL: usize = 5_000; // node-global anchor serves / minute
            let mut serve = self.rate_limiter.entry("mb_anchor_serve_self".to_string()).or_insert_with(|| RateLimit {
                requests: Vec::new(),
                max_requests: MB_ANCHOR_SERVE_TOTAL,
                window_seconds: 60,
                blocked_until: 0,
            });
            let window = serve.window_seconds;
            let cap = serve.max_requests;
            serve.requests.retain(|&t| t > now.saturating_sub(window));
            if serve.requests.len() >= cap {
                if crate::node::is_warn() {
                    println!("[WARN][ANCHOR] serve_ceiling_reached am_committee={} idx={}", am_committee as u8, index);
                }
                return;
            }
            serve.requests.push(now);
            if crate::node::is_info() && serve.requests.len() % 500 == 0 {
                println!("[INFO][ANCHOR] committee_serve am_committee={} served_1m={} idx={}",
                         am_committee as u8, serve.requests.len(), index);
            }
        }

        if let Some(ref sync_tx) = self.macroblock_sync_request_tx {
            let _ = sync_tx.try_send((index, index, requester_id, from_peer.to_string()));
        }
    }

    /// Handle macroblock request from peer for sync
    /// PRODUCTION: Full macroblock sync with rate limiting and validation
    pub fn handle_macroblock_request(&self, from_peer: &str, from_index: u64, to_index: u64, requester_id: String) {
        // Update last_seen for requesting peer
        self.update_peer_last_seen(from_peer);

        // Finalized macroblocks (and the snapshot-binding fetch that rides this path) are public,
        // 2f+1-QC-bound data: served to ANY peer so a fresh node can fast-sync via snapshot BEFORE
        // registration. No identity gate; DoS is bounded by the rate-limit below.

        // Genesis bypass uses ONLY the transport-verified source IP (from_peer), NOT the
        // self-declared requester_id which is spoofable. QUIC+TLS anchors from_peer to a valid
        // cert, so the IP cannot be forged; a non-genesis peer claiming requester_id="genesis_node_*"
        // no longer escapes the rate limit. Matches the already-hardened handle_block_request path.
        let is_genesis_peer = from_peer.split(':').next()
            .map(|ip| is_genesis_node_ip(ip))
            .unwrap_or(false);
        
        // RATE LIMITING: Stricter for macroblocks (they're larger than microblocks)
        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // v10.1: Check if requesting peer is syncing (requesting old blocks).
        // If peer requests macroblock index far below our tip, they're catching up — no rate limit.
        let local_h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        let our_macro_index = if local_h >= 90 { local_h / 90 } else { 0 };
        let requester_behind = our_macro_index > to_index && our_macro_index.saturating_sub(to_index) > 1;

        // v24: joint (IP, node_id) rate-limit key. See `handle_block_request` for
        // the full rationale — same hardening applied to the macroblock sync path
        // so a Byzantine peer cycling fake `requester_id` values from a single IP
        // cannot multiply its budget, and two honest validators sharing an IP
        // don't starve each other.
        let from_ip = from_peer.split(':').next().unwrap_or(from_peer);
        let id_prefix: String = requester_id.chars().take(48).collect();

        // Check rate limit
        let rate_limited = {
            // GENESIS BYPASS - by transport-verified IP only, not self-declared id
            if is_genesis_peer {
                false // Genesis nodes always allowed
            // v10.1: Relaxed rate limit for peers catching up (requesting old macroblocks)
            // Not unlimited — prevents DDoS via repeated index-0 requests
            } else if requester_behind {
                let rate_key = format!("priority_mb_{}_{}", from_ip, id_prefix);
                let mut rate_limit = self.rate_limiter.entry(rate_key).or_insert_with(|| RateLimit {
                    requests: Vec::new(),
                    max_requests: 30,  // 30 requests/min for syncing macroblocks
                    window_seconds: 60,
                    blocked_until: 0,
                });
                if rate_limit.blocked_until > current_time {
                    true
                } else {
                    let window = rate_limit.window_seconds;
                    rate_limit.requests.retain(|&t| t > current_time - window);
                    if rate_limit.requests.len() >= rate_limit.max_requests {
                        rate_limit.blocked_until = current_time + 60;
                        if crate::node::is_warn() {
                            println!("[WARN][MB_SYNC] priority_rate_exceeded peer={} id={} idx={}",
                                     from_peer, id_prefix, to_index);
                        }
                        true
                    } else {
                        rate_limit.requests.push(current_time);
                        false
                    }
                }
            } else {
                let rate_key = format!("macrosync_{}_{}", from_ip, id_prefix);

                let mut rate_limit = self.rate_limiter.entry(rate_key).or_insert_with(|| RateLimit {
                    requests: Vec::new(),
                    max_requests: 5,  // 5 macroblock sync requests per minute (stricter than microblocks)
                    window_seconds: 60,
                    blocked_until: 0,
                });

                // Check if currently blocked
                if rate_limit.blocked_until > current_time {
                    if crate::node::is_warn() {
                        println!("[WARN][MB_SYNC] rate_limited peer={} id={} blocked_for={}s",
                                 from_peer, id_prefix, rate_limit.blocked_until - current_time);
                    }
                    return;
                }

                // Clean old requests outside window
                let window = rate_limit.window_seconds;
                rate_limit.requests.retain(|&req_time| req_time > current_time - window);

                // Check if limit exceeded
                if rate_limit.requests.len() >= rate_limit.max_requests {
                    rate_limit.blocked_until = current_time + 120; // Block for 2 minutes (stricter)
                    if crate::node::is_warn() {
                        println!("[WARN][MB_SYNC] rate_limit_exceeded peer={} id={} requests={}",
                                 from_peer, id_prefix, rate_limit.max_requests);
                    }
                    true
                } else {
                    rate_limit.requests.push(current_time);
                    false
                }
            }
        };
        
        if rate_limited {
            return;
        }
        
        // SCALABILITY: Max 10 macroblocks per batch (~1MB max)
        let max_batch = 10;
        let actual_to = if to_index > from_index && to_index.saturating_sub(from_index) > max_batch {
            from_index.saturating_add(max_batch).saturating_sub(1)
        } else {
            to_index
        };
        
        if crate::node::is_info() {
            println!("[INFO][SYNC] Preparing macroblocks {}-{} for {}", from_index, actual_to, requester_id);
        }
        
        // CRITICAL: Send macroblock sync request to node.rs where storage is available
        if let Some(ref sync_tx) = self.macroblock_sync_request_tx {
            if let Err(e) = sync_tx.try_send((from_index, actual_to, requester_id.clone(), from_peer.to_string())) {
                if crate::node::is_info() {
                    println!("[ERR][SYNC] Failed to send sync request to node: {}", e);
                }
            } else {
                if crate::node::is_info() {
                    println!("[INFO][SYNC] Sync request forwarded to node for processing");
                }
            }
        } else {
            if crate::node::is_info() {
                println!("[WARN][SYNC] Macroblock sync channel not available - sending empty response");
            }
            
            // Fallback: send empty batch to prevent timeout
            let response = NetworkMessage::MacroblocksBatch {
                macroblocks: Vec::new(),
                from_index,
                to_index: actual_to,
                sender_id: self.node_id.clone(),
            };
            
            // Send response
            if let Some(peer_addr) = self.peer_id_to_addr.get(&requester_id) {
                self.send_network_message(&peer_addr.clone(), response);
            }
        }
    }
    
    /// Handle macroblocks batch received for sync
    /// PRODUCTION: Process and save received macroblocks
    pub fn handle_macroblocks_batch(&self, macroblocks: Vec<(u64, Vec<u8>)>, from_index: u64, to_index: u64, sender_id: String) {
        if crate::node::is_info() {
            println!("[INFO][SYNC] Processing {} macroblocks from {} (indices {}-{})",
                     macroblocks.len(), sender_id, from_index, to_index);
        }
        
        // Update last_seen for sender
        self.update_peer_last_seen(&sender_id);
        
        // CRITICAL: Send macroblocks to macroblock receiver for processing
        if let Some(ref macroblock_tx) = &*self.macroblock_tx.lock() {
            let mut queued = 0;
            let mut skipped_dup = 0;
            
            for (index, data) in macroblocks {
                // v3.1: DEDUPLICATION for macroblock sync
                if !mark_macroblock_pending_sync(index) {
                    skipped_dup += 1;
                    continue; // Already being processed or queue full
                }
                
                // Create ReceivedBlock for macroblock processing
                let received_macroblock = ReceivedBlock {
                    height: index,  // For macroblocks, height = index
                    data,
                    block_type: "macro".to_string(),
                    from_peer: sender_id.clone(),
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                };
                
                // Send to macroblock processor
                if let Err(e) = macroblock_tx.try_send(received_macroblock) {
                    clear_macroblock_pending_sync(index); // Clear on error
                    if crate::node::is_info() {
                        println!("[ERR][SYNC] Failed to queue macroblock {} for processing: {}", index, e);
                    }
                } else {
                    queued += 1;
                }
            }
            
            if crate::node::is_info() {
                println!("[INFO][MB-SYNC] batch from={} queued={} dup_skipped={}", sender_id, queued, skipped_dup);
            }
        } else {
            if crate::node::is_info() {
                println!("[WARN][SYNC] Macroblock processor not available, cannot save synced macroblocks!");
            }
        }
    }
    
    /// Request macroblocks from network for sync
    /// PRODUCTION: Used during initial sync and catch-up
    /// v2.96: Filter by failover cache + retry to next peer on failure
    /// Single-owner FORWARD macroblock sync coordinator (mirrors sync_blocks). Window in
    /// MACROBLOCK-INDEX space, clamped to [applied+1, applied+WINDOW] so it never requests
    /// faster than the apply pipeline drains. (0,0) = tip-nudge idiom. Overlap-dedup +
    /// bounded concurrency kill the duplicate-range storm that distinct callers (catch-up
    /// loop, recovery) used to flood genesis with → priority_rate_exceeded. Macroblocks are
    /// 90x rarer than microblocks, so the window/concurrency are deliberately small.
    /// Repair of a gap BELOW the frontier goes through sync_macroblocks_repair (not clamped).
    pub async fn sync_macroblocks(&self, from_index: u64, to_index: u64) -> Result<(), String> {
        const SYNC_MB_WINDOW: u64 = 64;
        // Apply-frontier in macroblock-index space (no atomic exists; cheap point lookup).
        let applied_mb = match crate::node::try_get_storage() {
            Some(s) => s.get_latest_macroblock_index().unwrap_or(0),
            None => return Err("storage_unavailable_for_macroblock_sync".to_string()),
        };
        // (0,0) tip-nudge → [applied+1, applied+WINDOW]. Macroblock index 0 never exists.
        let (req_from, req_to) = if from_index == 0 && to_index == 0 {
            (applied_mb.saturating_add(1), applied_mb.saturating_add(SYNC_MB_WINDOW))
        } else {
            (from_index.max(1), to_index)
        };
        // A request whose whole range is at/below the apply-frontier is a GAP REPAIR (recovery /
        // N-2 seed / deep-gap fetch of an already-passed index — note get_latest_macroblock_index()
        // is chain_height/90, so a real hole can exist below it), NOT forward catch-up. Route it to
        // the repair path (skip-present, no forward clamp) so the forward window can't silently drop
        // it to a no-op. Forward sweeps (req_to above the frontier) keep the sliding window below.
        if req_to <= applied_mb {
            return self.sync_macroblocks_repair(req_from, req_to).await;
        }
        // Forward window clamp to the apply-frontier (FILL-LOWEST-FIRST).
        let lo = req_from.max(applied_mb.saturating_add(1));
        let hi = req_to.min(applied_mb.saturating_add(SYNC_MB_WINDOW));
        if lo > hi {
            return Ok(()); // already applied, or beyond the window the pipeline can absorb
        }
        self.drive_macroblock_sync(lo, hi).await
    }

    /// REPAIR/backfill path for macroblock gaps at or below the apply-frontier (reorg
    /// recovery, desync missing-macroblock detection). Unlike sync_macroblocks it honors the
    /// explicit [from,to] range so an advanced frontier does not clamp away a genuine hole;
    /// still width-capped, skip-present (so an already-present prefix isn't re-requested),
    /// overlap-deduped and semaphore-bounded via the shared driver.
    pub async fn sync_macroblocks_repair(&self, from_index: u64, to_index: u64) -> Result<(), String> {
        const SYNC_MB_WINDOW: u64 = 64;
        let from_index = from_index.max(1);
        if from_index > to_index {
            return Ok(());
        }
        let storage = match crate::node::try_get_storage() {
            Some(s) => s,
            None => return Err("storage_unavailable_for_macroblock_repair".to_string()),
        };
        // Width-cap, then skip a contiguously-present prefix → fetch from the first real hole.
        let cap = to_index.min(from_index.saturating_add(SYNC_MB_WINDOW).saturating_sub(1));
        let mut lo = from_index;
        while lo <= cap && storage.get_macroblock_by_height(lo).ok().flatten().is_some() {
            lo = lo.saturating_add(1);
        }
        if lo > cap {
            return Ok(()); // requested range already present
        }
        self.drive_macroblock_sync(lo, cap).await
    }

    /// Shared driver: overlap-dedup + bounded concurrency + hard timeout over the inner loop.
    /// Both the forward coordinator and the repair path funnel here so a single in-flight set
    /// and concurrency budget govern ALL macroblock fetches (no duplicate-range flood).
    pub(super) async fn drive_macroblock_sync(&self, lo: u64, hi: u64) -> Result<(), String> {
        const MAX_CONCURRENT_SYNC_MB: usize = 2;
        const SYNC_MACROBLOCKS_HARD_TIMEOUT_SECS: u64 = 90;

        static SYNC_MB_INFLIGHT: Lazy<std::sync::Mutex<Vec<(u64, u64)>>> =
            Lazy::new(|| std::sync::Mutex::new(Vec::new()));
        static SYNC_MB_CONCURRENCY: Lazy<tokio::sync::Semaphore> =
            Lazy::new(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_SYNC_MB));

        // Overlap-dedup + register (short sync critical section, no await).
        {
            let mut inflight = match SYNC_MB_INFLIGHT.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(), // poisoned: recover, never block sync
            };
            if inflight.iter().any(|&(a, b)| !(hi < a || lo > b)) {
                if crate::node::is_debug() {
                    println!("[DBG][MB-SYNC] coalesced lo={} hi={} reason=overlaps_inflight", lo, hi);
                }
                return Ok(());
            }
            inflight.push((lo, hi));
        }
        struct InflightGuard(u64, u64);
        impl Drop for InflightGuard {
            fn drop(&mut self) {
                if let Ok(mut v) = SYNC_MB_INFLIGHT.lock() {
                    v.retain(|&(a, b)| !(a == self.0 && b == self.1));
                }
            }
        }
        let _ig = InflightGuard(lo, hi);

        let _permit = match SYNC_MB_CONCURRENCY.acquire().await {
            Ok(p) => p,
            Err(_) => return Err("sync_macroblocks_semaphore_closed".to_string()),
        };

        match tokio::time::timeout(
            std::time::Duration::from_secs(SYNC_MACROBLOCKS_HARD_TIMEOUT_SECS),
            self.sync_macroblocks_inner(lo, hi),
        ).await {
            Ok(res) => res,
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][MB-SYNC] hard_timeout lo={} hi={} after={}s",
                             lo, hi, SYNC_MACROBLOCKS_HARD_TIMEOUT_SECS);
                }
                Err(format!("sync_macroblocks_hard_timeout {}s",
                            SYNC_MACROBLOCKS_HARD_TIMEOUT_SECS))
            }
        }
    }

    pub(super) async fn sync_macroblocks_inner(&self, from_index: u64, to_index: u64) -> Result<(), String> {
        // v7.2: MacroBlock numbering starts at 1 (first created at h=90).
        // Index 0 never exists — skip silently to avoid wasting 5 peer timeouts.
        let from_index = from_index.max(1);
        if from_index > to_index {
            return Ok(()); // Nothing to sync (e.g. from=1 but to=0 means no macroblocks yet)
        }
        if crate::node::is_info() {
            println!("[INFO][MB-SYNC] start from={} to={}", from_index, to_index);
        }
        
        let peers = self.get_validated_active_peers();
        if peers.is_empty() {
            return Err("No peers available for macroblock sync".to_string());
        }

        // v2.96: Get LIVE genesis nodes from failover cache (updated every 20s)
        let working_genesis_ips = Self::filter_working_genesis_nodes_static(get_genesis_bootstrap_ips());

        // Peer-pick: trust = QC, not peer-reported height (P3). The server serves finalized
        // macroblocks to all (handle_macroblock_request) and every fetched macroblock is
        // QC/crypto-verified on apply, so a behind peer simply returns nothing and the retry
        // loop tries the next. Filtering candidates by last_block_height here self-poisoned a
        // cold joiner: stale per-peer heights disqualified otherwise-serving genesis peers,
        // yielding `no_live_peers` and a failed snapshot bind. Candidate set = ALL connected
        // Super peers; the genesis-preferred + reputation sort below orders them.
        let mut eligible_peers: Vec<_> = peers.iter()
            .filter(|p| matches!(p.node_type, NodeType::Super))
            .cloned()
            .collect();

        if eligible_peers.is_empty() {
            return Err("No Super/Full nodes available for macroblock sync".to_string());
        }
        
        // Committee fan-out (E): at scale, prefer the deterministic VRF-committee members among our
        // connected Super peers so 100k joiners spread the anchor/macroblock fetch across the committee
        // instead of stampeding the 5 genesis. Membership is on-chain deterministic (Sybil-safe), and
        // WITHIN the committee tier we order by a per-joiner salt so different joiners pick different
        // members (no thundering herd onto the lexicographically-first one). Genesis-liveness then
        // reputation order the non-committee tail. INERT pre-committee (None ⇒ prior genesis+rep order).
        let committee = self.deterministic_eligible_ids();
        let salt = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            self.node_id.hash(&mut h);
            h.finish()
        };
        let salted = |id: &str| -> u64 {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            salt.hash(&mut h);
            id.hash(&mut h);
            h.finish()
        };
        eligible_peers.sort_by(|a, b| {
            let a_cm = committee.as_ref().map(|c| c.contains(&a.id)).unwrap_or(false);
            let b_cm = committee.as_ref().map(|c| c.contains(&b.id)).unwrap_or(false);
            // Committee members first; within the tier, per-joiner salted spread.
            b_cm.cmp(&a_cm).then_with(|| {
                if a_cm && b_cm {
                    salted(&a.id).cmp(&salted(&b.id))
                } else {
                    let a_gen = working_genesis_ips.iter().any(|ip| ip == a.addr.split(':').next().unwrap_or(""));
                    let b_gen = working_genesis_ips.iter().any(|ip| ip == b.addr.split(':').next().unwrap_or(""));
                    b_gen.cmp(&a_gen).then_with(|| b.combined_reputation()
                        .partial_cmp(&a.combined_reputation())
                        .unwrap_or(std::cmp::Ordering::Equal))
                }
            })
        });
        
        // Create request message
        let request = NetworkMessage::RequestMacroblocks {
            from_index,
            to_index,
            requester_id: self.node_id.clone(),
        };
        
        // ═══════════════════════════════════════════════════════════════════════════
        // v2.105: CRITICAL FIX - SEQUENTIAL retry with WAIT for response
        // ═══════════════════════════════════════════════════════════════════════════
        // Same fix as sync_blocks - wait for macroblock to actually arrive!
        // ═══════════════════════════════════════════════════════════════════════════
        
        let storage = match crate::node::try_get_storage() {
            Some(s) => s,
            None => return Err("Storage unavailable for macroblock sync".to_string()),
        };
        
        // Widen the try-count (was 5) so a few slow/absent committee members don't serialize the joiner;
        // still bounded (DoS-safe) and fans the fetch across more servers than the 5 genesis.
        let max_peers_to_try = 8.min(eligible_peers.len());

        for (attempt, peer) in eligible_peers.iter().take(max_peers_to_try).enumerate() {
            if peer.id == self.node_id {
                continue;
            }
            
            // Check if peer is reachable
            // v4.2: spawn_blocking to avoid starving tokio workers
            let peer_addr_clone = peer.addr.clone();
            let is_reachable = tokio::task::spawn_blocking(move || {
                Self::test_peer_connectivity_static(&peer_addr_clone)
            }).await.unwrap_or(false);
            if !is_reachable {
                if crate::node::is_warn() {
                    println!("[WARN][MB-SYNC] peer_unreachable id={} retry=next", peer.id);
                }
                continue;
            }
            
                if crate::node::is_info() {
                println!("[INFO][MB-SYNC] request idx={}-{} peer={} attempt={}/{}", 
                         from_index, to_index, peer.id, attempt + 1, max_peers_to_try);
            }
            
            // Send request
            self.send_network_message(&peer.addr, request.clone());
            
            // The server caps a response at 10 macroblocks per request (handle_macroblock_request),
            // so a wide window can never be complete in one round. Poll the store (a small batch
            // lands in 1-2s, not the worst-case timeout) and treat FORWARD PROGRESS — first-missing
            // advanced past from_index — as success: the caller/probe re-enters from the new hole.
            // All-or-nothing over a >10-wide range would burn every peer round against the cap.
            let requested_count = to_index - from_index + 1;
            let timeout_secs: u64 = match requested_count.min(10) {
                1 => 6,
                2..=5 => 10,
                _ => 15,
            };
            let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
            let mut first_missing = from_index;
            loop {
                while first_missing <= to_index
                    && storage.get_macroblock_by_height(first_missing)
                        .map(|opt| opt.is_some()).unwrap_or(false) {
                    first_missing += 1;
                }
                if first_missing > to_index || std::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(400)).await;
            }

            if first_missing > to_index {
                if crate::node::is_info() {
                    println!("[INFO][MB-SYNC] received idx={}-{} from={}", from_index, to_index, peer.id);
                }
                return Ok(());
            }
            if first_missing > from_index {
                if crate::node::is_info() {
                    println!("[INFO][MB-SYNC] partial idx={}-{} next_missing={} from={}",
                             from_index, to_index, first_missing, peer.id);
                }
                return Ok(());
            }
            if crate::node::is_warn() {
                println!("[WARN][MB-SYNC] no_response idx={}-{} from={} trying_next", from_index, to_index, peer.id);
            }
        }

        Err(format!("Macroblock sync failed: all peers did not respond for idx={}-{}", from_index, to_index))
    }
    
    // =========================================================================
    // END MACROBLOCK SYNC METHODS
    // =========================================================================
    
    /// Handle sync status update from peer. Refreshes liveness only — the peer table is keyed by
    /// address, so the id must be resolved through the admission-owned index first.
    pub fn handle_sync_status(&self, node_id: String, _current_height: u64, _target_height: u64, _syncing: bool) {
        let addr = match self.peer_id_to_addr.get(&node_id) {
            Some(e) => e.value().clone(),
            None => return,
        };
        if let Some(mut peer) = self.connected_peers_lockfree.get_mut(&addr) {
            peer.last_seen = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
        }
    }
    
    /// Handle consensus state request
    /// Ask peers for the certificate of `round`. Sent when a proposal names a parent certificate
    /// this node does not hold: the wire carries only a QcRef, so the proposal cannot deliver it and
    /// refusing without asking leaves the node permanently one certificate behind. Bounded fanout —
    /// one answer is enough and the serve side is rate-limited.
    pub fn request_consensus_state(&self, round: u64) {
        const CATCHUP_ASK_PEERS: usize = 3;
        // Arm the receive side for exactly the peers asked: a served pair costs an O(committee)
        // verify, so unasked ones are refused before they reach the consensus loop.
        crate::consensus_v2_node::expect_catchup(CATCHUP_ASK_PEERS);
        self.gossip_to_random_peers(NetworkMessage::RequestConsensusState {
            round, requester_id: self.node_id.clone(),
        }, CATCHUP_ASK_PEERS);
    }

    pub fn handle_consensus_state_request(&self, from_peer: &str, round: u64, requester_id: String) {
        // Update last_seen for requesting peer
        self.update_peer_last_seen(from_peer);
        
        // RATE LIMITING: Check consensus state request rate (stricter than sync)
        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // Check rate limit (max 5 consensus requests per minute per peer)
        let rate_limited = {
            // PRODUCTION: Lock-free DashMap access
            let rate_key = format!("consensus_{}", from_peer);
            
            let mut rate_limit = self.rate_limiter.entry(rate_key).or_insert_with(|| RateLimit {
                requests: Vec::new(),
                max_requests: 5,  // Only 5 consensus state requests per minute
                window_seconds: 60,
                blocked_until: 0,
            });
            
            // Check if currently blocked
            if rate_limit.blocked_until > current_time {
                if crate::node::is_info() {
                    println!("[WARN][CONS] Rate limit: {} blocked for {} more seconds",
                             from_peer, rate_limit.blocked_until - current_time);
                }
                return;
            }
            
            // Clean old requests
            let window = rate_limit.window_seconds;
            rate_limit.requests.retain(|&req_time| req_time > current_time - window);
            
            // Check if limit exceeded
            if rate_limit.requests.len() >= rate_limit.max_requests {
                rate_limit.blocked_until = current_time + 120; // Block for 2 minutes (stricter)
                if crate::node::is_info() {
                    println!("[WARN][CONS] Rate limit exceeded for {} ({}+ requests/minute)",
                             from_peer, rate_limit.max_requests);
                }
                true
            } else {
                rate_limit.requests.push(current_time);
                false
            }
        };
        
        if rate_limited {
            return;
        }
        
        if crate::node::is_info() {
            println!("[INFO][CONS] Preparing consensus state for round {} for {}", round, requester_id);
        }
        
        // Serve the certificate for that round. A proposal names its parent by a 40-byte QcRef with
        // no signatures, so a peer one certificate behind cannot obtain it from the proposal and has
        // nothing else to ask. The bytes are an already-verified wire message and the requester
        // re-verifies on its own inbound path, so serving costs no trust.
        match crate::consensus_v2_node::catchup_bundle(round) {
            Some(state_data) => {
                if crate::node::is_info() {
                    println!("[INFO][CONS] serve_catchup round={} to={} bytes={}",
                             round, requester_id, state_data.len());
                }
                self.send_network_message(from_peer, NetworkMessage::ConsensusState {
                    round, state_data, sender_id: self.node_id.clone(),
                });
            }
            None => {
                if crate::node::is_debug() {
                    println!("[DBG][CONS] serve_catchup_miss round={} to={}", round, requester_id);
                }
            }
        }
    }
    
    /// Handle consensus state received
    pub fn handle_consensus_state(&self, round: u64, state_data: Vec<u8>, sender_id: String) {
        // Update last_seen for sender
        self.update_peer_last_seen(&sender_id);
        
        if crate::node::is_info() {
            println!("[INFO][CONS] Processing consensus state for round {} from {} ({} bytes)",
                     round, sender_id, state_data.len());
        }

        // Route each carried message through the NORMAL inbound path: it re-verifies signatures
        // and quorum against the committee, so a served certificate is trusted exactly as much as
        // a gossiped one. Anything unparsable is dropped without touching consensus state.
        // Not route_inbound: that path prunes by round and would discard both halves of a pair
        // whose index is below ours — which is every catch-up by definition.
        crate::consensus_v2_node::route_catchup(state_data);
    }
    
    /// Request blocks from peers for sync
    /// v3.0: CRITICAL FIX - Sequential retry instead of parallel
    /// 
    /// OLD BEHAVIOR (caused OOM):
    /// - Request from 3 peers simultaneously
    /// - Each peer sends 2000 blocks → 6000 blocks in queue → OOM
    /// 
    /// NEW BEHAVIOR:
    /// - Request from 1 peer (best reputation)
    /// - If fails/timeout after SYNC_PEER_TIMEOUT, try next peer
    /// - Deduplication layer (handle_blocks_batch) catches any duplicates
    /// 
    /// v2.96: Filter by failover cache to exclude offline peers
    /// v2.104: CRITICAL FIX - Send to MULTIPLE peers, not just one!
    ///         Previous bug: sent to one peer, returned Ok(), peer didn't respond,
    ///         next call picked same peer again → deadlock
    pub async fn sync_blocks(&self, from_height: u64, to_height: u64) -> Result<(), String> {
        // Unified client sync coordinator — single owner for all ~15 callers
        // (runtime loop, pipeline missing-range, fork/gap/genesis recovery).
        // Per-exact-(from,to) cooldown was bypassed by distinct/overlapping
        // tiny ranges → request storm. This is a frontier+interval window:
        //   1. WINDOW backpressure — clamp to [applied+1, applied+SYNC_WINDOW];
        //      never request faster than the apply pipeline drains (the apply
        //      frontier IS LOCAL_BLOCKCHAIN_HEIGHT). Far-behind nodes sync in
        //      bounded sequential windows, not one giant fan-out.
        //   2. Overlap-dedup — a range overlapping any in-flight range is
        //      skipped (kills the duplicate/overlapping-range storm that
        //      distinct tuples slipped past).
        //   3. Bounded concurrency + hard timeout (defence-in-depth).
        // (0,0) = tip-nudge idiom → [applied+1, applied+SYNC_WINDOW].
        // Scales: O(in_flight ≤ MAX) interval check; one small Mutex.
        const SYNC_WINDOW: u64 = 2_000;
        const MAX_CONCURRENT_SYNC_BLOCKS: usize = 4;
        const SYNC_BLOCKS_HARD_TIMEOUT_SECS: u64 = 45;

        static SYNC_INFLIGHT: Lazy<std::sync::Mutex<Vec<(u64, u64)>>> =
            Lazy::new(|| std::sync::Mutex::new(Vec::new()));
        static SYNC_CONCURRENCY: Lazy<tokio::sync::Semaphore> =
            Lazy::new(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_SYNC_BLOCKS));

        let applied = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire);
        let (req_from, req_to) = if from_height == 0 && to_height == 0 {
            (applied.saturating_add(1), applied.saturating_add(SYNC_WINDOW))
        } else {
            (from_height, to_height)
        };
        // Backpressure clamp to the apply-frontier window.
        let lo = req_from.max(applied.saturating_add(1));
        let hi = req_to.min(applied.saturating_add(SYNC_WINDOW));
        if lo > hi {
            // Already applied, or beyond the window the pipeline can absorb.
            return Ok(());
        }

        // Overlap-dedup + register (short sync critical section, no await).
        {
            let mut inflight = match SYNC_INFLIGHT.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(), // poisoned: recover, never block sync
            };
            if inflight.iter().any(|&(a, b)| !(hi < a || lo > b)) {
                if crate::node::is_debug() {
                    println!("[DBG][SYNC] coalesced lo={} hi={} reason=overlaps_inflight", lo, hi);
                }
                return Ok(());
            }
            inflight.push((lo, hi));
        }
        // Guarantees the in-flight entry is removed on EVERY exit path.
        struct InflightGuard(u64, u64);
        impl Drop for InflightGuard {
            fn drop(&mut self) {
                if let Ok(mut v) = SYNC_INFLIGHT.lock() {
                    v.retain(|&(a, b)| !(a == self.0 && b == self.1));
                }
            }
        }
        let _ig = InflightGuard(lo, hi);

        let _permit = match SYNC_CONCURRENCY.acquire().await {
            Ok(p) => p,
            Err(_) => return Err("sync_blocks_semaphore_closed".to_string()),
        };

        match tokio::time::timeout(
            std::time::Duration::from_secs(SYNC_BLOCKS_HARD_TIMEOUT_SECS),
            self.sync_blocks_inner(lo, hi),
        ).await {
            Ok(res) => res,
            Err(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][SYNC] hard_timeout lo={} hi={} after={}s",
                             lo, hi, SYNC_BLOCKS_HARD_TIMEOUT_SECS);
                }
                Err(format!("sync_blocks_hard_timeout {}s", SYNC_BLOCKS_HARD_TIMEOUT_SECS))
            }
        }
    }

    /// Frontier-reserved fetch: the contiguous apply-frontier successor must be requestable on a budget
    /// the bulk window/in_flight can never starve. Bypasses sync_blocks' SYNC_INFLIGHT overlap-dedup (a
    /// bulk range covering the frontier must NOT swallow it) — the SyncManager loop single-flights it per
    /// tick. Own bounded concurrency + timeout; sync_blocks_inner is delivery-verified + committee-fanned,
    /// so on Ok the range has LANDED in storage (== applied: save_microblock writes the key ONLY on the
    /// apply-success path, so the SyncManager frontier scan reads the true apply-frontier). Committee
    /// peers are pre-dialed for cold-join.
    pub async fn sync_blocks_frontier(&self, from_height: u64, to_height: u64) -> Result<(), String> {
        if from_height > to_height { return Ok(()); }
        const MAX_CONCURRENT_FRONTIER: usize = 2;
        const FRONTIER_HARD_TIMEOUT_SECS: u64 = 20;
        static FRONTIER_CONCURRENCY: Lazy<tokio::sync::Semaphore> =
            Lazy::new(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_FRONTIER));
        let _permit = match FRONTIER_CONCURRENCY.acquire().await {
            Ok(p) => p,
            Err(_) => return Err("frontier_semaphore_closed".to_string()),
        };
        match tokio::time::timeout(
            std::time::Duration::from_secs(FRONTIER_HARD_TIMEOUT_SECS),
            self.sync_blocks_inner(from_height, to_height),
        ).await {
            Ok(res) => res,
            Err(_) => Err(format!("frontier_hard_timeout {}s", FRONTIER_HARD_TIMEOUT_SECS)),
        }
    }

    pub(super) async fn sync_blocks_inner(&self, from_height: u64, to_height: u64) -> Result<(), String> {

        // v13.1: Guard against inverted ranges at the source.
        // Callers (sync_manager, fast_sync) may compute from > to when remaining = 0
        // or target height is stale. Without this, the request goes on the wire and
        // every peer logs inverted_request rejection in a tight loop.
        if from_height > to_height {
            if crate::node::is_warn() {
                println!("[WARN][SYNC] inverted_range from={} to={} skipped_at_source",
                         from_height, to_height);
            }
            return Ok(());
        }

        // v4.0: Also request timeout proofs for this range (BFT Timeout Protocol)
        // This ensures syncing nodes get all necessary data for producer validation.
        // v34: timeout certs are keyed by mb_idx (height/90), and the serve filters by
        // that key — so the range MUST be converted to mb_idx space. Passing raw heights
        // made the serve filter (`from <= mb_idx <= to`) never match for any height above
        // ~a few hundred → syncing nodes got ZERO certs → stale HIGHEST_CERTIFIED_ROUND →
        // they rejected legitimate failover blocks until the ingest backfill rescued them.
        self.request_timeout_proofs(from_height / 90, to_height / 90);
        
        // v9.6: Use get_sync_peers_filtered_by_height() for L1-grade peer selection.
        // This replaces the old genesis-IP-only filter that forced ALL sync through 5 genesis nodes.
        // Now ANY qualified Super peer can serve blocks — standard L1 bootnode pattern.
        // Filters: reputation >= 70%, height >= to_height, blacklist, Light nodes excluded.
        let mut live_peers = self.get_sync_peers_filtered_by_height(10, to_height);

        if live_peers.is_empty() {
            // Fallback 1: Try without height filter (bootstrap or peers haven't reported height yet)
            live_peers = self.get_sync_peers_filtered(10);
        }

        if live_peers.is_empty() {
            // Fallback 2: Genesis nodes only (network bootstrap — no peers have reputation yet).
            // This is the ONLY case where we filter by genesis IP, matching L1 bootnode pattern:
            // genesis nodes for discovery/bootstrap, any qualified peer for ongoing sync.
            let all_peers = self.get_validated_active_peers();
            let working_genesis_ips = Self::filter_working_genesis_nodes_static(get_genesis_bootstrap_ips());
            live_peers = all_peers.iter()
                .filter(|p| {
                    let peer_ip = p.addr.split(':').next().unwrap_or("");
                    working_genesis_ips.iter().any(|ip| ip == peer_ip)
                })
                .cloned()
                .collect();

            if live_peers.is_empty() {
                // Fallback 3: Absolute last resort — use any connected peer
                live_peers = all_peers;
            }

            if live_peers.is_empty() {
                return Err("No peers available for sync".to_string());
            }

            if crate::node::is_warn() {
                println!("[WARN][SYNC] no_qualified_peers fallback=genesis count={}", live_peers.len());
            }
        } else if crate::node::is_debug() {
            println!("[DEBUG][SYNC] qualified_peers h={}-{} count={}", from_height, to_height, live_peers.len());
        }
        
        // v9.5: Sort by block height first (peers with more blocks first), then reputation.
        // This ensures we request from peers most likely to have the blocks we need,
        // especially when height filtering passed through stale peers as fallback.
        live_peers.sort_by(|a, b| {
            let height_cmp = b.last_block_height.cmp(&a.last_block_height);
            if height_cmp != std::cmp::Ordering::Equal {
                return height_cmp;
            }
            b.combined_reputation().partial_cmp(&a.combined_reputation())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        
        // v14.2: Exclude peers in active cool-down (they failed a recent sync).
        // Keeps wave retries from hitting the same stalled peer repeatedly.
        let cooling_down_before = live_peers.len();
        live_peers.retain(|p| !is_sync_peer_cooling_down(&p.id));
        if live_peers.is_empty() {
            // All peers cooling down — pick any so we don't stall completely.
            // Better to retry a stalled peer than return immediate error.
            if crate::node::is_warn() {
                println!("[WARN][SYNC] all_peers_cooling_down — falling back to full list");
            }
            live_peers = self.get_validated_active_peers().into_iter().collect();
        } else if cooling_down_before != live_peers.len() && crate::node::is_info() {
            println!("[INFO][SYNC] filter_cooling_peers skipped={} remaining={}",
                     cooling_down_before - live_peers.len(), live_peers.len());
        }

        // Drop self from the candidate set once (never request blocks from ourselves).
        live_peers.retain(|p| p.id != self.node_id);
        if live_peers.is_empty() {
            return Err("No valid peers to sync from".to_string());
        }

        // Committee fan-out (E): at scale, prefer the deterministic VRF-committee members among
        // our connected Super peers so 100k joiners spread the block fetch across the committee
        // instead of stampeding the 5 genesis. Within the committee tier order by a per-joiner
        // salt so different joiners pick different members (no thundering herd). The prior
        // (height desc, reputation desc) order survives as the tie-break for the non-committee
        // tail. INERT pre-committee (None ⇒ prior height/reputation order). Mirrors the macroblock
        // path so both fetch lanes share one peer-spread doctrine.
        let committee = self.deterministic_eligible_ids();
        let salt = {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            self.node_id.hash(&mut h);
            h.finish()
        };
        let salted = |id: &str| -> u64 {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            salt.hash(&mut h);
            id.hash(&mut h);
            h.finish()
        };
        live_peers.sort_by(|a, b| {
            let a_cm = committee.as_ref().map(|c| c.contains(&a.id)).unwrap_or(false);
            let b_cm = committee.as_ref().map(|c| c.contains(&b.id)).unwrap_or(false);
            b_cm.cmp(&a_cm).then_with(|| {
                if a_cm && b_cm {
                    salted(&a.id).cmp(&salted(&b.id))
                } else {
                    let height_cmp = b.last_block_height.cmp(&a.last_block_height);
                    if height_cmp != std::cmp::Ordering::Equal {
                        height_cmp
                    } else {
                        b.combined_reputation().partial_cmp(&a.combined_reputation())
                            .unwrap_or(std::cmp::Ordering::Equal)
                    }
                }
            })
        });

        // Per-batch timeout: how long one dispatch round waits for responses to ingest before
        // the storage re-scan. Tight upper bounds (modern inter-DC QUIC completes a batch in
        // <200ms) so a stalled peer yields to the next peer in rotation quickly; the wrapper's
        // 45s hard timeout caps the whole loop.
        const MAX_BATCH_BLOCKS: u64 = 500;
        const MAX_PARALLEL_SYNC_PEERS: usize = 8;
        let round_timeout = |span: u64| -> Duration {
            let secs = match span.min(MAX_BATCH_BLOCKS) {
                0..=10  => 1,
                11..=50 => 2,
                51..=200 => 3,
                _       => 5,
            };
            Duration::from_secs(secs)
        };

        // ═══════════════════════════════════════════════════════════════════════
        // DELIVERY-VERIFIED PULL (replaces v14.9 fire-and-forget)
        // ═══════════════════════════════════════════════════════════════════════
        // Fire-and-forget returned Ok the moment requests were SENT: a dead QUIC
        // stream silently dropped its shard's sub-range and the gap was never
        // re-targeted → ordered apply stalled at the hole. This loop closes the
        // gap: dispatch the still-missing contiguous sub-ranges (sharded across a
        // rotating peer window for throughput + committee fan-out), wait one
        // batch timeout for the existing handle_blocks_batch→ingest path to land
        // them, then re-scan storage (O(range) cheap load_microblock probes — the
        // Dilithium/QC verify stays in the apply pipeline, never duplicated here).
        // Bounded rounds + the wrapper's 45s timeout guarantee termination; on
        // exhaustion with gaps remaining we return Err so the caller re-invokes.
        // ═══════════════════════════════════════════════════════════════════════
        let storage = match crate::node::try_get_storage() {
            Some(s) => s,
            None => return Err("Storage unavailable for sync".to_string()),
        };
        let max_rounds = (live_peers.len().saturating_mul(2)).clamp(1, 8);
        let mut delivered_any = false;

        for round in 0..max_rounds {
            // Re-scan: collect the contiguous sub-ranges still missing in storage.
            let mut missing: Vec<(u64, u64)> = Vec::new();
            let mut run_start: Option<u64> = None;
            for h in from_height..=to_height {
                let present = storage.load_microblock(h)
                    .map(|opt| opt.is_some())
                    .unwrap_or(false);
                if present {
                    if let Some(s) = run_start.take() {
                        missing.push((s, h - 1));
                    }
                } else if run_start.is_none() {
                    run_start = Some(h);
                }
            }
            if let Some(s) = run_start.take() {
                missing.push((s, to_height));
            }

            if missing.is_empty() {
                if crate::node::is_info() {
                    println!("[INFO][SYNC] delivered h={}-{} rounds={}",
                             from_height, to_height, round);
                }
                if delivered_any {
                    // Each peer got a DISTINCT shard, so credit only on success.
                    for p in live_peers.iter().take(MAX_PARALLEL_SYNC_PEERS) {
                        record_sync_peer_success(&p.id);
                    }
                }
                return Ok(());
            }

            // Rotate the peer window each round so a dead peer's shard is re-targeted
            // to a different server (round-robin over the salted/committee order).
            let window = MAX_PARALLEL_SYNC_PEERS.min(live_peers.len());
            // Step by `window` when peers > window (cover disjoint subsets each round), else by 1
            // (window == all peers: rotate the ORDER so the first shard moves to a different peer
            // and a transiently-dead first peer's range is re-targeted next round).
            let step = if window >= live_peers.len() { 1 } else { window };
            let offset = (round * step) % live_peers.len();
            let round_peers: Vec<&PeerInfo> = (0..window)
                .map(|i| &live_peers[(offset + i) % live_peers.len()])
                .collect();

            // Shard the missing heights across the round's peers (one distinct
            // sub-range per peer for ~N× throughput). Flatten the missing
            // intervals into a height list, then split contiguously.
            let total_missing: u64 = missing.iter().map(|&(a, b)| b - a + 1).sum();
            let peers_n = round_peers.len().max(1) as u64;
            // Cap each shard at the server's per-response batch (handle_block_request serves
            // <=100/req) so one shard == one served batch; the overflow tail is picked up by the
            // next round's re-scan rather than wasted on a truncated response.
            let shard_size = ((total_missing + peers_n - 1) / peers_n).min(100); // ceil, server-cap
            let mut sent_to_peers: Vec<String> = Vec::new();
            let mut peer_idx = 0usize;
            let mut budget = shard_size;
            let mut shard_lo: Option<u64> = None;
            let mut shard_hi: u64 = 0;
            let flush = |unified: &Self, peer: &PeerInfo, lo: u64, hi: u64, tags: &mut Vec<String>| {
                let request = NetworkMessage::RequestBlocks {
                    from_height: lo,
                    to_height: hi,
                    requester_id: unified.node_id.clone(),
                };
                unified.send_network_message(&peer.addr, request);
                tags.push(format!("{}[{}-{}]", peer.id, lo, hi));
            };
            'outer: for &(a, b) in &missing {
                for h in a..=b {
                    if shard_lo.is_none() {
                        shard_lo = Some(h);
                    }
                    shard_hi = h;
                    budget = budget.saturating_sub(1);
                    if budget == 0 {
                        if let (Some(lo), Some(peer)) = (shard_lo, round_peers.get(peer_idx)) {
                            flush(self, peer, lo, shard_hi, &mut sent_to_peers);
                        }
                        shard_lo = None;
                        peer_idx += 1;
                        budget = shard_size;
                        if peer_idx >= round_peers.len() {
                            break 'outer; // peers exhausted this round; leftover retried next round
                        }
                    }
                }
            }
            // Flush the final partial shard.
            if let (Some(lo), Some(peer)) = (shard_lo, round_peers.get(peer_idx)) {
                flush(self, peer, lo, shard_hi, &mut sent_to_peers);
            }

            if sent_to_peers.is_empty() {
                return Err("No valid peers to sync from".to_string());
            }
            delivered_any = true;

            if crate::node::is_info() {
                println!("[INFO][SYNC] request h={}-{} round={}/{} missing={} peers=[{}]",
                         from_height, to_height, round + 1, max_rounds,
                         missing.len(), sent_to_peers.join(","));
            }

            // Wait one batch timeout for responses to ingest, then loop to re-scan.
            tokio::time::sleep(round_timeout(total_missing)).await;

            if crate::node::is_debug() {
                println!("[DBG][SYNC] retry h={}-{} round={} total_missing={}",
                         from_height, to_height, round + 1, total_missing);
            }
        }

        // Rounds exhausted with gaps remaining: honest "not fully delivered" — the
        // caller's loop/TTL re-invokes (and the wrapper's window clamp re-narrows).
        Err(format!("sync_blocks incomplete h={}-{} after {} rounds",
                    from_height, to_height, max_rounds))
    }
    
    /// ═══════════════════════════════════════════════════════════════════════════
    /// PRODUCTION v2.55: REQUEST BLOCK REPAIR
    /// ═══════════════════════════════════════════════════════════════════════════
    /// Request specific block from multiple peers with timeout
    /// Used by anti-fork protection to get missing blocks before producing
    /// ═══════════════════════════════════════════════════════════════════════════
    pub async fn request_block_repair(&self, height: u64) -> Result<(), String> {
        self.request_block_repair_lane(height, false).await
    }

    /// PRIORITY lane for finality-critical repair (tail-reconcile adopt path, deferred-finalize
    /// bodies): draws the shared budget first, then a RESERVED extra allowance bulk callers cannot
    /// touch — a hole-repair/parent-pull burst can therefore never starve the repair that unwedges
    /// 2f+1 finality. 90-height worst case ≈ (16+8)/s ⇒ well inside one escalated view timeout.
    pub async fn request_block_repair_priority(&self, height: u64) -> Result<(), String> {
        self.request_block_repair_lane(height, true).await
    }

    pub(super) async fn request_block_repair_lane(&self, height: u64, priority: bool) -> Result<(), String> {
        // Allow-list this exact height so its stored-height batch reply is routed to fork-choice
        // supersede (supersede_stored_from_sync) instead of ignored — this is the SOLICITED path that
        // converges a diverged tail. Marking a not-yet-stored height is harmless (TTL-expired).
        crate::block_pipeline::mark_repair_solicited(height);
        // A losing block we already reconstructed via shred sits in processed_shred_blocks; forget it so a
        // solicited >1MB competitor's chunks reconstruct once (re-added on that reconstruct → dedup restored).
        self.processed_shred_blocks.remove(&height);
        // DoS: bound the repair fan-out (each call sends to up to 3 peers). check_content's TailDiverged
        // branch can drive one call per diverged height (up to a full window) from a single re-sendable
        // proposal → attacker-drainable ~3x reflection per height. Global token bucket + per-height
        // cooldown (mirrors ANCHOR_PULL_BUDGET / FAILOVER_CERT_PULL): a legit divergence (a few tail
        // heights) is well within budget; a garbage-tail flood is capped regardless of key cycling. The
        // allow-list mark above stays (the SOLICITED supersede path is now producer-signature-gated, so a
        // marked-but-unsent height is harmless), so convergence still works when a retry gets budget.
        {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs()).unwrap_or(0);
            const REPAIR_REQUESTS_PER_SEC: u32 = 16;
            /// Reserved for the priority lane ON TOP of the shared budget (total 24/s ceiling).
            const REPAIR_PRIORITY_RESERVE_PER_SEC: u32 = 8;
            const REPAIR_COOLDOWN_SECS: u64 = 2;
            {
                let mut b = REPAIR_REQUEST_BUDGET.lock();
                if b.0 != now { *b = (now, 0, 0); }
                if b.1 < REPAIR_REQUESTS_PER_SEC {
                    b.1 += 1; // shared budget available — both lanes draw here first
                } else if priority && b.2 < REPAIR_PRIORITY_RESERVE_PER_SEC {
                    b.2 += 1; // shared exhausted — only finality-critical callers get the reserve
                } else {
                    return Ok(());
                }
            }
            let last = REPAIR_REQUEST_TIMES.get(&height).map(|v| *v).unwrap_or(0);
            if now.saturating_sub(last) < REPAIR_COOLDOWN_SECS { return Ok(()); }
            REPAIR_REQUEST_TIMES.insert(height, now);
            if REPAIR_REQUEST_TIMES.len() > 4096 {
                REPAIR_REQUEST_TIMES.retain(|_, t| now.saturating_sub(*t) < 60);
            }
        }
        if crate::node::is_info() {
            println!("[INFO][SYNC] Requesting repair for block #{}", height);
        }

        // Repair only from peers proven (authenticated height) to hold the block — co-stragglers serve
        // empty and stall the deferred-drain cascade. Fall back to any active peer if none known ahead.
        let mut peers = self.get_sync_peers_filtered_by_height(8, height);
        if peers.is_empty() { peers = self.get_validated_active_peers(); }
        if peers.is_empty() {
            return Err("No peers available for repair".to_string());
        }

        // Request from top 3 peers by reputation (redundancy for reliability)
        let mut sorted_peers = peers.clone();
        sorted_peers.sort_by(|a, b| 
            b.combined_reputation().partial_cmp(&a.combined_reputation())
                .unwrap_or(std::cmp::Ordering::Equal));
        
        let request = NetworkMessage::RequestBlocks {
            from_height: height,
            to_height: height,
            requester_id: self.node_id.clone(),
        };
        
        let mut sent = 0;
        for peer in sorted_peers.iter().take(3) {
            if peer.id != self.node_id {
                self.send_network_message(&peer.addr, request.clone());
                sent += 1;
            }
        }
        
        if sent > 0 {
            if crate::node::is_info() {
                println!("[INFO][SYNC] Requested block #{} from {} peers", height, sent);
            }
            Ok(())
        } else {
            Err("No peers to request from".to_string())
        }
    }
    
    /// v3.10 BUG 1 FIX: Request specific block after consensus timeout
    /// Uses same infrastructure as broadcast: validated active peers + QUIC parallel
    /// 
    /// WHY NOT Reed-Solomon: RS is for SENDING (erasure coding for fault tolerance)
    /// For REQUESTING we use parallel requests to multiple peers - first response wins
    pub async fn request_specific_block(&self, height: u64) -> Result<(), String> {
        use futures::future::join_all;
        use crate::p2p_transport::QUIC_PORT_OFFSET;
        use crate::node::is_info;
        use crate::node::is_debug;
        
        if is_info() {
            println!("[INFO][CONS] request_after_consensus h={}", height);
        }
        
        // Use same peer selection as broadcast - validated active peers with QUIC connections
        let validated_peers = self.get_validated_active_peers();
        
        if validated_peers.is_empty() {
            if crate::node::is_warn() {
                println!("[WARN][CONS] no_validated_peers h={}", height);
            }
            return Err("No validated peers available".to_string());
        }
        
        // Sort by latency (same as broadcast) - fastest peers first
        let mut sorted_peers = validated_peers;
        sorted_peers.sort_by_key(|p| p.latency_ms);
        
        // Request from top peers (limit to avoid DoS on network)
        // More than broadcast repair (3) but less than full broadcast
        let peers_to_request = sorted_peers.iter().take(5).collect::<Vec<_>>();
        
        if is_info() {
            println!("[INFO][CONS] requesting h={} from {} peers", height, peers_to_request.len());
        }
        
        // QUIC parallel requests (same as broadcast)
        // v3.14: Clone Arc (not RwLockGuard) for parallel futures
        if let Some(ref quic_arc) = self.quic_transport {
            let transport_arc = quic_arc.clone(); // Clone Arc, not the guard!
            
            // Parallel QUIC requests to all selected peers
            let futures: Vec<_> = peers_to_request.iter().map(|peer| {
                let transport = transport_arc.clone(); // Clone Arc for each future
                let peer_addr = peer.addr.clone();
                let peer_id = peer.id.clone();
                let requester = self.node_id.clone();
                
                async move {
                    // Parse IP and add QUIC port offset
                    if let Ok(addr) = peer_addr.parse::<std::net::SocketAddr>() {
                        let quic_addr = std::net::SocketAddr::new(addr.ip(), addr.port() + QUIC_PORT_OFFSET);
                        let request = NetworkMessage::RequestBlocks {
                            from_height: height,
                            to_height: height,
                            requester_id: requester,
                        };
                        let guard = transport.read().await;
                        match guard.send_message(quic_addr, &request).await {
                            Ok(_) => Ok(peer_id),
                            Err(e) => Err((peer_id, e))
                        }
                    } else {
                        Err((peer_id, "Invalid peer address".to_string()))
                    }
                }
            }).collect();
            
            // Wait for all requests (parallel execution)
            let results = join_all(futures).await;
            let success_count = results.iter().filter(|r| r.is_ok()).count();
            
            if is_debug() {
                for result in &results {
                    match result {
                        Ok(peer_id) => println!("[DBG][CONS] quic_request_sent h={} peer={}", height, peer_id),
                        Err((peer_id, e)) => println!("[DBG][CONS] quic_request_failed h={} peer={} err={}", height, peer_id, e),
                    }
                }
            }
            
            if success_count > 0 {
                if is_info() {
                    println!("[INFO][CONS] block_requested h={} success={}/{}", 
                             height, success_count, peers_to_request.len());
                }
                Ok(())
            } else {
                if crate::node::is_warn() {
                    println!("[WARN][CONS] all_quic_requests_failed h={}", height);
                }
                // Fallback to legacy method
                self.request_block_repair(height).await
            }
        } else {
            // QUIC not available - use legacy method
            if is_debug() {
                println!("[DBG][CONS] quic_unavailable fallback_to_legacy h={}", height);
            }
            self.request_block_repair(height).await
        }
    }
    
    /// Request consensus state from peers for recovery
    pub async fn sync_consensus_state(&self, round: u64) -> Result<(), String> {
        if crate::node::is_info() {
            println!("[INFO][CONS] Requesting consensus state for round {}", round);
        }
        
        let peers = self.get_validated_active_peers();
        if peers.is_empty() {
            return Err("No peers available for consensus sync".to_string());
        }
        
        // Select peer with highest cached reputation (for P2P selection)
        let best_peer = peers.iter()
            .max_by(|a, b| a.reputation().partial_cmp(&b.reputation()).unwrap_or(std::cmp::Ordering::Equal))
            .ok_or("No valid peer for consensus sync")?;
        
        if crate::node::is_info() {
            println!("[INFO][CONS] Requesting from peer {} (network_quality: {:.1}%)",
                     best_peer.id, best_peer.network_score);
        }
        
        // Create request message
        let request = NetworkMessage::RequestConsensusState {
            round,
            requester_id: self.node_id.clone(),
        };
        
        // Send request
        self.send_network_message(&best_peer.addr, request);
        
        Ok(())
    }
    
}

//! Chain synchronisation, macroblock verification and the content-verified frontier.

use super::*;

impl BlockchainNode {
    /// Start sync process after node restart or new node join
    pub async fn start_sync_if_needed(&self) -> Result<(), QNetError> {
        // CRITICAL: Mark node as syncing to prevent consensus participation
        if is_info() { println!("[INFO][SYNC] sync_check_start"); }

        // Single cold-join owner: the SyncManager (present iff this node has p2p — always true on the main
        // BlockchainNode, spawned at boot before this call) fully drives snapshot fast-sync + tail replay +
        // steady catch-up. The legacy boot bulk-sync it superseded is removed: running it here double-drove
        // macroblock/block fetch and churned the apply frontier the cold-join anchor negotiation reads. A
        // node without p2p has nothing to sync at boot.
        if is_info() { println!("[INFO][SYNC] sync_owner=coordinator legacy_boot_sync=deferred"); }
        Ok(())
    }
    
    /// Handle incoming sync request from peer
    /// CRITICAL FIX v2.61: Size-based batched sync to prevent QUIC message loss
    /// v5.6: Added from_peer_addr for routing responses to unregistered new nodes
    pub async fn handle_sync_request(&self, from_height: u64, to_height: u64, requester_id: String, from_peer_addr: String) -> Result<(), QNetError> {
        // v13.0: Guard against inverted sync requests from peers
        if from_height > to_height {
            if is_warn() {
                println!("[WARN][SYNC] inverted_request from={} addr={} heights={}-{} rejected",
                         requester_id, from_peer_addr, from_height, to_height);
            }
            return Ok(());
        }

        if is_debug() {
            println!("[DBG][SYNC] serve_request from={} addr={} heights={}-{}", requester_id, from_peer_addr, from_height, to_height);
        }

        // Load incrementally under a byte budget. A count-capped request spans 2 MB
        // (empty blocks) to 200+ MB (full blocks); serving it whole was the congestion
        // collapse. The requester's round re-scan picks up the truncated tail.
        const RESPONSE_BUDGET_BYTES: usize = 8_000_000;
        let mut blocks_data: Vec<(u64, Vec<u8>)> = Vec::new();
        let mut served_bytes: usize = 0;
        let mut truncated_at: Option<u64> = None;
        for h in from_height..=to_height {
            let mut one = self.storage.get_microblocks_range(h, h).await?;
            if let Some((_, data)) = one.pop() {
                if !blocks_data.is_empty() && served_bytes.saturating_add(data.len()) > RESPONSE_BUDGET_BYTES {
                    truncated_at = Some(h);
                    break;
                }
                served_bytes = served_bytes.saturating_add(data.len());
                blocks_data.push((h, data));
            }
        }
        if let Some(cut) = truncated_at {
            if is_info() {
                println!("[INFO][SYNC] serve_truncated req={}-{} served_to={} bytes={} reason=byte_budget",
                         from_height, to_height, cut - 1, served_bytes);
            }
        }

        if is_trace() {
            println!("[TRC][SYNC] get_range({}, {}) blocks={}", from_height, to_height, blocks_data.len());
        }
        
        if blocks_data.is_empty() {
            if is_debug() { println!("[DBG][SYNC] empty_range heights={}-{} sending_empty_batch", from_height, to_height); }
            // v6.5 FIX: ALWAYS send a response, even for empty ranges
            // PROBLEM: Silent return Ok(()) caused requesting node to timeout after 2s
            //   with "3 peers did not respond for h=0-0" — infinite retry loop
            // SOLUTION: Send empty BlocksBatch so requester knows range is empty
            //   This is standard P2P protocol: every request gets a response.
            //   (standard p2p practice — always respond with data or empty)
            if let Some(ref p2p) = self.unified_p2p {
                let peer_addr = p2p.get_peer_address_by_id(&requester_id)
                    .or_else(|| {
                        let peers = p2p.get_validated_active_peers();
                        peers.iter().find(|p| p.id == requester_id).map(|p| p.addr.clone())
                    })
                    .or_else(|| {
                        if !from_peer_addr.is_empty() { Some(from_peer_addr.clone()) } else { None }
                    });

                if let Some(addr) = peer_addr {
                    let empty_response = crate::unified_p2p::NetworkMessage::BlocksBatch {
                        blocks: Vec::new(),
                        from_height,
                        to_height,
                        sender_id: self.node_id.clone(),
                    };
                    p2p.send_network_message(&addr, empty_response);
                    // Co-send signed head even on an empty serve so a behind follower's SIGNED_HEAD_MAX
                    // still refreshes — breaks the request-vs-behind loop.
                    p2p.cosend_signed_head(&addr);
                    // Co-send the genesis-rooted anchor ONLY to a far-behind (cold-join range) requester, so a
                    // cold joiner jumps near-tip instead of replaying from h=90 — and 100k routine near-tip serves
                    // don't each carry the capsule. A requester within one snapshot interval already has the pin.
                    if crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire)
                        .saturating_sub(from_height) > crate::galc::GALC_MINT_INTERVAL * 90 {
                        p2p.cosend_galc_capsule(&addr);
                    }
                    if is_info() { println!("[INFO][SYNC] empty_batch_sent to={} addr={}", requester_id, addr); }
                } else {
                    if is_warn() { println!("[WARN][SYNC] empty_batch_no_addr id={} from={}", requester_id, from_peer_addr); }
                }
            }
            return Ok(());
        }
        
        if let Some(ref p2p) = self.unified_p2p {
            // ═══════════════════════════════════════════════════════════════════════════
            // CRITICAL FIX v2.61: SIZE-BASED BATCHING for intercontinental reliability
            // ═══════════════════════════════════════════════════════════════════════════
            // Problem: Sending large messages via QUIC = fragmentation = packet loss = failure
            // Root cause: 101 blocks with 50K TX each = ~10MB, any UDP packet loss = "Message too short"
            // Solution: Batch by SIZE (not count) - max 1MB per message (safe for QUIC/UDP)
            // 
            // Why SIZE matters more than COUNT:
            // - Empty block: ~20KB
            // - Block with 50K TX: ~12MB!
            // - 10 empty blocks: 200KB (OK)
            // - 1 block with 50K TX: 12MB (FAIL)
            // ═══════════════════════════════════════════════════════════════════════════
            const MAX_BATCH_SIZE_BYTES: usize = 1_000_000;  // 1MB max per QUIC message
            const SYNC_BATCH_DELAY_MS: u64 = 5;  // 5ms pacing between batches
            
            // Answer where the request CAME FROM. requester_id is a wire field the sender chooses,
            // so resolving the destination through it first let one small frame aim megabytes of
            // response at a third party. from_peer_addr is the verified connection IP with the
            // service port; the id lookup remains only for callers the transport gave us nothing for.
            let peer_addr = if from_peer_addr.is_empty() {
                p2p.get_peer_address_by_id(&requester_id)
                    .or_else(|| {
                        let peers = p2p.get_validated_active_peers();
                        peers.iter().find(|p| p.id == requester_id).map(|p| p.addr.clone())
                    })
            } else {
                Some(from_peer_addr.clone())
            };

            let Some(addr) = peer_addr else {
                if is_info() { println!("[WARN][SYNC] peer_not_found id={} from_addr={}", requester_id, from_peer_addr); }
                return Ok(());
            };
            
            // ═══════════════════════════════════════════════════════════════════════════
            // CRITICAL FIX v2.61: Large blocks (>1MB) use ShredProtocol for reliability
            // Small blocks use batched BlocksBatch messages
            // blocks_data is Vec<(u64, Vec<u8>)> - already (height, data) pairs
            // ═══════════════════════════════════════════════════════════════════════════
            const SHRED_THRESHOLD_BYTES: usize = 1_000_000;  // Blocks >1MB use ShredProtocol
            
            // Separate large blocks (ShredProtocol) from small blocks (BatchSync)
            let mut large_blocks: Vec<(u64, Vec<u8>)> = Vec::new();
            let mut small_blocks: Vec<(u64, Vec<u8>)> = Vec::new();
            let mut total_size: usize = 0;
            
            for (height, block_data) in &blocks_data {
                let block_size = block_data.len();
                total_size += block_size;
                
                if block_size > SHRED_THRESHOLD_BYTES {
                    large_blocks.push((*height, block_data.clone()));
                } else {
                    small_blocks.push((*height, block_data.clone()));
                }
            }
            
            // Send large blocks via ShredProtocol (reliable for 20MB+)
            if !large_blocks.is_empty() {
                if is_info() {
                    println!("[INFO][SYNC] sending {} large blocks via ShredProtocol to={}", 
                             large_blocks.len(), requester_id);
                }
                for (height, block_data) in large_blocks {
                    p2p.send_block_via_shred_to_peer(&addr, height, block_data, false).await;
                }
            }
            
            // Build size-based batches for small blocks
            // BlocksBatch.blocks is Vec<(u64, Vec<u8>)> - (height, data) pairs
            let mut batches: Vec<Vec<(u64, Vec<u8>)>> = Vec::new();
            let mut batch_heights: Vec<(u64, u64)> = Vec::new();  // (from, to) for each batch
            let mut current_batch: Vec<(u64, Vec<u8>)> = Vec::new();
            let mut current_batch_size: usize = 0;
            let mut batch_start_height: Option<u64> = None;
            let mut last_height: u64 = 0;
            
            for (height, block) in &small_blocks {
                let block_size = block.len();
                
                // If adding this block exceeds limit, start new batch
                if current_batch_size + block_size > MAX_BATCH_SIZE_BYTES && !current_batch.is_empty() {
                    batches.push(current_batch);
                    batch_heights.push((batch_start_height.unwrap_or(*height), last_height));
                    current_batch = Vec::new();
                    current_batch_size = 0;
                    batch_start_height = None;
                }
                
                if batch_start_height.is_none() {
                    batch_start_height = Some(*height);
                }
                last_height = *height;
                
                current_batch.push((*height, block.clone()));
                current_batch_size += block_size;
            }
            
            // Don't forget last batch
            if !current_batch.is_empty() {
                batches.push(current_batch);
                batch_heights.push((batch_start_height.unwrap_or(from_height), last_height));
            }
            
            let num_batches = batches.len();
            let total_blocks = blocks_data.len();
            let small_blocks_count = small_blocks.len();
            let large_blocks_count = total_blocks - small_blocks_count;
            
            if is_debug() {
                println!("[DBG][SYNC] sending blocks={} (small={} large={}) size={}KB batches={} to={}",
                         total_blocks, small_blocks_count, large_blocks_count,
                         total_size / 1024, num_batches, requester_id); 
            }
            
            // Send small blocks batches with pacing
            for (batch_idx, batch) in batches.iter().enumerate() {
                let (batch_from, batch_to) = batch_heights.get(batch_idx)
                    .copied()
                    .unwrap_or((from_height, from_height));
                
                let response = NetworkMessage::BlocksBatch {
                    blocks: batch.clone(),
                    from_height: batch_from,
                    to_height: batch_to,
                    sender_id: self.node_id.clone(),
                };
                
                p2p.send_network_message(&addr, response);
                
                if is_debug() { 
                    let batch_size: usize = batch.iter().map(|(_, b)| b.len()).sum();
                    println!("[DBG][SYNC] batch={}/{} heights={}-{} size={}KB", 
                             batch_idx + 1, num_batches, batch_from, batch_to, batch_size / 1024); 
                }
                
                // Pacing delay between batches (except last)
                if batch_idx < num_batches - 1 {
                    tokio::time::sleep(std::time::Duration::from_millis(SYNC_BATCH_DELAY_MS)).await;
                }
            }

            // Co-send our signed head over the serve channel so the requester (incl. a freshly-joined
            // cold node the HealthPing emit fan-out misses) learns the real network tip and advances
            // its SIGNED_HEAD_MAX, instead of stalling at its own frontier.
            p2p.cosend_signed_head(&addr);
            // Co-send the genesis-rooted anchor ONLY to a far-behind (cold-join range) requester — see empty-batch site.
            if crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire)
                .saturating_sub(from_height) > crate::galc::GALC_MINT_INTERVAL * 90 {
                p2p.cosend_galc_capsule(&addr);
            }

            if is_info() {
                println!("[INFO][SYNC] sent blocks={} (shred={} batch={}) to={}",
                         total_blocks, large_blocks_count, small_blocks_count, requester_id);
            }
        }
        
        Ok(())
    }
    
    // =========================================================================
    // MACROBLOCK SYNC METHODS (PRODUCTION v2.19.12)
    // =========================================================================
    
    /// Handle incoming macroblock sync request from peer
    /// PRODUCTION: Full macroblock sync support for new nodes joining network
    /// CRITICAL FIX v2.61: Size-based batched sync to prevent QUIC message loss
    pub async fn handle_macroblock_sync_request(&self, from_index: u64, to_index: u64, requester_id: String, from_peer_addr: String) -> Result<(), QNetError> {
        if is_info() { 
            println!("[INFO][MB-SYNC] request from={} indices={}-{}", requester_id, from_index, to_index); 
        }
        
        // Get macroblocks from storage
        let macroblocks_data = self.storage.get_macroblocks_range(from_index, to_index).await?;
        
        if is_trace() { 
            println!("[TRC][MB-SYNC] get_range({}, {}) macroblocks={}", from_index, to_index, macroblocks_data.len()); 
        }
        
        if macroblocks_data.is_empty() {
            if is_debug() { println!("[DBG][MB-SYNC] empty_response indices={}-{}", from_index, to_index); }
            return Ok(());
        }
        
        if let Some(ref p2p) = self.unified_p2p {
            // Size-based batching for macroblocks. The old 500 KB cap forced
            // ~1 macroblock/response → catch-up throttled to the per-batch
            // RTT. 5 MB packs ~10 macroblocks/response while staying under
            // the 87 MB SHRED ceiling and 16 MB QUIC stream window; the
            // 80 MB MAX_BLOCK_SIZE_BYTES cap + QUIC memory ceilings still hold.
            const MAX_BATCH_SIZE_BYTES: usize = 5_000_000;  // 5 MB max per message (≤10 macroblocks per response)
            const MB_SYNC_BATCH_DELAY_MS: u64 = 10;  // 10ms pacing between batches
            
            // Find peer address
            // Same rule as the microblock serve path: answer where the request came from. That also
            // covers the cold joiner this fallback was added for - it is not in the registry yet, and
            // its anchor pull is exactly what recovery depends on.
            let peer_addr = if from_peer_addr.is_empty() {
                p2p.get_peer_address_by_id(&requester_id)
                    .or_else(|| {
                        let peers = p2p.get_validated_active_peers();
                        peers.iter().find(|p| p.id == requester_id).map(|p| p.addr.clone())
                    })
            } else {
                Some(from_peer_addr.clone())
            };

            let Some(addr) = peer_addr else {
                if is_info() { println!("[WARN][MB-SYNC] peer_not_found id={} from_addr={}", requester_id, from_peer_addr); }
                return Ok(());
            };
            
            // Build size-based batches
            // macroblocks_data is already Vec<(u64, Vec<u8>)> - (index, data) pairs
            let mut batches: Vec<Vec<(u64, Vec<u8>)>> = Vec::new();
            let mut current_batch: Vec<(u64, Vec<u8>)> = Vec::new();
            let mut current_batch_size: usize = 0;
            let mut total_size: usize = 0;
            
            for (mb_index, mb_data) in &macroblocks_data {
                let mb_size = mb_data.len();
                total_size += mb_size;
                
                // If single macroblock exceeds limit, send it alone
                if mb_size > MAX_BATCH_SIZE_BYTES {
                    if !current_batch.is_empty() {
                        batches.push(current_batch);
                        current_batch = Vec::new();
                        current_batch_size = 0;
                    }
                    batches.push(vec![(*mb_index, mb_data.clone())]);
                    continue;
                }
                
                // If adding this macroblock exceeds limit, start new batch
                if current_batch_size + mb_size > MAX_BATCH_SIZE_BYTES && !current_batch.is_empty() {
                    batches.push(current_batch);
                    current_batch = Vec::new();
                    current_batch_size = 0;
                }
                
                current_batch.push((*mb_index, mb_data.clone()));
                current_batch_size += mb_size;
            }
            
            if !current_batch.is_empty() {
                batches.push(current_batch);
            }
            
            let num_batches = batches.len();
            let total_macroblocks = macroblocks_data.len();
            
            if is_info() { 
                println!("[INFO][MB-SYNC] sending macroblocks={} size={}KB batches={} to={}", 
                         total_macroblocks, total_size / 1024, num_batches, requester_id); 
            }
            
            // Send batches with pacing
            for (batch_idx, batch) in batches.iter().enumerate() {
                // Get from/to from actual batch content
                let batch_from = batch.first().map(|(idx, _)| *idx).unwrap_or(from_index);
                let batch_to = batch.last().map(|(idx, _)| *idx).unwrap_or(batch_from);
                
                let response = NetworkMessage::MacroblocksBatch {
                    macroblocks: batch.clone(),
                    from_index: batch_from,
                    to_index: batch_to,
                    sender_id: self.node_id.clone(),
                };
                
                p2p.send_network_message(&addr, response);
                
                if is_debug() { 
                    let batch_size: usize = batch.iter().map(|(_, b)| b.len()).sum();
                    println!("[DBG][MB-SYNC] batch={}/{} indices={}-{} size={}KB", 
                             batch_idx + 1, num_batches, batch_from, batch_to, batch_size / 1024); 
                }
                
                if batch_idx < num_batches - 1 {
                    tokio::time::sleep(std::time::Duration::from_millis(MB_SYNC_BATCH_DELAY_MS)).await;
                }
            }
            
            if is_info() { 
                println!("[INFO][MB-SYNC] sent macroblocks={} batches={} to={}", total_macroblocks, num_batches, requester_id); 
            }
        }
        
        Ok(())
    }
    
    /// Process received macroblock from network sync
    /// PRODUCTION: Validates and saves macroblock to storage
    /// Consensus committee for a v2 checkpoint index, derived EXACTLY as the proposer
    /// did: candidates from the N-2 snapshot (genesis list for epochs ≤2) →
    /// select_consensus_committee VRF-sample ≤CONSENSUS_COMMITTEE_SIZE. Used to verify a
    /// received QC against the real committee, not the self-declared one.
    /// P1-D: the macroblock index (N-2) whose STORED macroblock anchors window `index`'s committee
    /// derivation (calculate_qualified_candidates' eligible set + the VRF subsample seed). Returns
    /// None for the bootstrap windows (index<3) that use the deterministic genesis anchor and need no
    /// on-chain N-2. A node lacking this macroblock must DEFER QC verification rather than let
    /// the committee derivation WALK BACK to a different anchor — a walked-back committee differs from the
    /// sealer's → a spurious `v2_qc_invalid` that SPLITS honest nodes (a node with a storage gap
    /// rejects a validly-finalized macroblock). Pure ⇒ unit-tested for the off-by-one genesis boundary.
    pub(super) fn v2_committee_anchor_index(index: u64) -> Option<u64> {
        if index >= 3 { Some(index - 2) } else { None }
    }

    /// Canonical FULL verification of a v2 macroblock's checkpoint QC — the SINGLE authority used
    /// by EVERY macroblock-accept path so none can be bypassed (H1). It:
    ///  (1) binds the block to the QC: window == index AND cp.hash() == qc.checkpoint_hash;
    ///  (2) binds EVERY consensus-critical BODY field to the QC-certified checkpoint — state_root,
    ///      micro_blocks, randomness_beacon, timestamp — all of which live inside cp.hash() that the
    ///      QC signs (H2: an un-bound `randomness_beacon` let a relayed body carry a different beacon
    ///      than the QC-agreed one → poisoned the next epoch's committee/leader seed → split);
    ///  (3) DEFERS (Err) if the canonical N-2 committee anchor is not local (P1-D anti-walk-back);
    ///  (4) derives the committee DETERMINISTICALLY (N-2 / genesis) — NOT the self-declared
    ///      `consensus_committee` an attacker could set to their own keys;
    ///  (5) checks epoch_commitment (published validator set matches the QC commitment);
    ///  (6) Dilithium-verifies EVERY committee signature. A forged committee or any invalid/zero
    ///      signature cannot pass. Returns Ok(()) for a non-v2 (legacy) macroblock — the caller
    ///      handles that path.
    pub(crate) async fn verify_v2_macroblock(
        macroblock: &qnet_state::MacroBlock,
        index: u64,
        p2p: &Arc<SimplifiedP2P>,
        node_id: &str,
        node_type: NodeType,
        storage: &Storage,
    ) -> Result<(), String> {
        // v2 finality IS the n−f checkpoint QC — a None-QC macroblock has no finality to verify and
        // must never be trusted. Erroring here (rather than Ok) keeps the invariant LOCAL to the verifier:
        // "verify_v2_macroblock Ok ⇒ a checkpoint QC was present and Dilithium-verified", so no current or
        // future caller can accept a None-QC macroblock by trusting the verifier alone.
        let cp_qc = match macroblock.consensus_data.checkpoint_qc.as_ref() {
            Some(b) => b,
            None => return Err(format!("v2_qc_absent mb={}", index)),
        };
        let (cp, qc): (qnet_consensus::checkpoint_bft::Checkpoint, qnet_consensus::checkpoint_bft::QuorumCertificate) =
            bincode::deserialize(cp_qc).map_err(|e| format!("v2_qc_decode mb={} err={}", index, e))?;
        // EXACT boundary, not the quotient: heads N*90+30 and N*90+60 are honestly certified every 30
        // blocks and both satisfy `head / 90 == N`. Accepting one stores a macroblock whose body is a
        // 30-block window; save_macroblock is first-write-wins, so the real boundary macroblock can
        // never replace it and every later one fails the parent link — a permanent wedge for any
        // cold-joiner. Mirrors the sealer's own `head % macro_interval == 0`.
        if cp.window_head_height != index.saturating_mul(90) || cp.hash() != qc.checkpoint_hash {
            return Err(format!("v2_qc_unbound mb={} head={}", index, cp.window_head_height));
        }
        if macroblock.micro_blocks.len() != 90 {
            return Err(format!("v2_qc_window_len mb={} len={}", index, macroblock.micro_blocks.len()));
        }
        // Weak-subjectivity trust root — INERT at the fresh-genesis pin (0,zeros). The cold-join lineage
        // walk re-verifies macroblock QCs UP from an EXOGENOUS root so a byzantine snapshot server cannot
        // root the committee in its own peer-served data (the circular-anchor forge). Two roots:
        //   • genesis (pin=0): the first two macroblocks (head ≤180) use the embedded genesis committee;
        //   • mature (pin>0): the binary-pinned macroblock is trusted by HASH, and its immediate
        //     predecessor by the macroblock previous_hash chain — together the two N-2 committee sources
        //     that bootstrap forward QC verification of both parities. Below the pinned pair is trusted
        //     history we neither hold nor re-verify (Err ⇒ resync above the floor).
        // `pin` = the inductive hash-trust ROOT = max-by-index of the binary WS pin and the adopted GALC
        // capsule (both genesis-key-rooted; never the snapshot's own self-reported hash). It carries the
        // committee_digest (pin.2). `ws` = runtime FLOOR (max of binary pin and the locally-adopted
        // snapshot anchor) — the below-which-we-don't-re-verify gate, kept SEPARATE so a capsule never
        // advances finality (that stays gated on the full snapshot binding).
        let pin = crate::galc::effective_pin_checkpoint();
        let ws = effective_ws_checkpoint();
        if pin.0 > 0 && index == pin.0 {
            // Hash-trust the pinned macroblock K AND bind its committee-derivation inputs (eligible_
            // producers + beacon) to the pinned ANCHOR digest. MacroBlock::hash() omits consensus_data,
            // so without this digest a hash-equal K with forged producers would be stored and poison the
            // forward committee. Checking K's OWN fields here (not K-1's) needs only K ⇒ no K↔K-1
            // deadlock, and it rejects a forged K at STORE time via ANY ingress (walk, standalone
            // MacroblockAnchor, snapshot-anchor==pin.0), not only the contiguous walk.
            if macroblock.hash()[..] != pin.1[..] {
                return Err(format!("v2_ws_pin_mismatch mb={}", index));
            }
            if crate::galc::committee_fields_digest(macroblock) != pin.2 {
                return Err(format!("v2_ws_pin_committee_mismatch mb={}", index));
            }
            return Ok(());
        }
        if pin.0 > 1 && index == pin.0 - 1 {
            // Predecessor K-1: trusted by K's previous_hash chain (K is stored first, by hash above) AND
            // bound to the pinned PRED digest over ITS OWN committee fields. Each branch checks only its
            // own macroblock's digest, so neither needs the other's consensus_data ⇒ no deadlock.
            return match storage.get_macroblock_by_height(pin.0).ok().flatten()
                .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok())
            {
                Some(anchor) if anchor.previous_hash[..] == macroblock.hash()[..] => {
                    if crate::galc::committee_fields_digest(macroblock) != pin.3 {
                        Err(format!("v2_ws_pin_committee_mismatch mb={}", index))
                    } else { Ok(()) }
                }
                Some(_) => Err(format!("v2_ws_pin_pred_mismatch mb={}", index)),
                None => Err(format!("v2_qc_defer_anchor mb={} need_pin={}", index, pin.0)),
            };
        }
        if index < ws.0 {
            return Err(format!("v2_below_ws mb={} ws={}", index, ws.0));
        }
        // Chain link, mirroring what the sealer now does. previous_hash is INSIDE MacroBlock::hash()
        // but is NOT a Checkpoint field, so the n−f QC does not cover it — every other body field
        // below is QC-bound, this one was whatever the sending peer chose. A byzantine proposer could
        // broadcast an otherwise fully-valid macroblock with a forged previous_hash; receivers stored
        // it verbatim (save_macroblock is first-write-wins and nothing re-validates), so their
        // macroblock hash diverged from everyone else's — permanently, and it propagates into the next
        // previous_hash. An ABSENT parent stays permitted: pruned history, cold-join below the walk
        // root and out-of-order backfill all reach here legitimately. Same rule the microblock path
        // already applies — reject a PRESENT mismatching parent, allow an absent one.
        if index > 1 {
            if let Some(parent) = storage.get_macroblock_by_height(index - 1).ok().flatten()
                .and_then(Self::macroblock_plaintext)
                .and_then(|raw| bincode::deserialize::<qnet_state::MacroBlock>(&raw).ok())
            {
                if macroblock.previous_hash != parent.hash() {
                    return Err(format!("v2_parent_link_mismatch mb={}", index));
                }
            }
        }
        if cp.window_mb_hashes != macroblock.micro_blocks
            || cp.state_root != macroblock.state_root
            || macroblock.consensus_data.randomness_beacon != Some(cp.beacon)
            || macroblock.timestamp != cp.timestamp
        {
            return Err(format!("v2_body_mismatch mb={}", index));
        }
        // Decouple (P4): a standalone macroblock whose OWN n−f QC verifies (below) needs its N-2
        // committee anchor only when that anchor is ABOVE the WS checkpoint; at/below WS the committee
        // is binary-trusted, so the lineage walk stops at WS, not genesis. INERT at ws=0 (n2=index-2>=1
        // > 0 for every index with an anchor), i.e. identical to the prior unconditional defer. In the
        // cold-join ASCENDING walk the N-2 anchor is not merely PRESENT but already VERIFIED (it was
        // verify-then-saved earlier in the same walk), so presence here implies a genesis/pin-rooted
        // committee source — never a peer-chosen one.
        // The pin is attacker-chosen wire data folded into Checkpoint::hash, and it lowers the
        // threshold below. While the feature is off it must be inert on the ACCEPTANCE path too, not
        // only on the arm — otherwise one Byzantine leader proposes an otherwise-honest pinned
        // checkpoint, the unarmed committee votes and seals it, and every non-sealer rejects it forever.
        if !RC_ENABLED && cp.recovery_anchor.is_some() {
            return Err(format!("v2_rc_disabled mb={}", index));
        }
        // The signing SET comes from ONE place for BOTH paths — the deterministic N-2 derivation.
        // A pin lowers the THRESHOLD only. Quorum-checking a relaxed certificate against a different
        // committee than a strict certificate for the same head would use leaves the two quorums free
        // not to intersect, which is a two-content finality fork needing zero Byzantine nodes.
        if let Some(n2) = Self::v2_committee_anchor_index(index) {
            if n2 > ws.0 && storage.get_macroblock_by_height(n2).ok().flatten().is_none() {
                return Err(format!("v2_qc_defer_anchor mb={} need_mb_n2={}", index, n2));
            }
        }
        // The committee MUST be resolved exactly as the voters resolved it — same function, same
        // roster mode. A verifier that derives a purer set than the signers used cannot check their
        // signatures against it, which turns a local disagreement into a network-wide reject.
        let qualified = Self::calculate_qualified_candidates(p2p, node_id, node_type, cp.window_head_height).await;
        let mut ids: Vec<String> = qualified.iter().map(|(id, _)| id.clone()).collect();
        ids.sort();
        let committee = Self::select_consensus_committee(&ids, index, storage);
        if qnet_consensus::checkpoint_bft::quorum_size(committee.len()) == 0 {
            return Err(format!("v2_qc_no_committee mb={}", index));
        }
        let quorum = match cp.recovery_anchor {
            None => qnet_consensus::checkpoint_bft::quorum_size(committee.len()),
            Some((a, ah)) => Self::resolve_recovery_pin(storage, index, &cp, a, ah, committee.len())?,
        };
        let elig = macroblock.consensus_data.eligible_producers.as_deref().unwrap_or(&[]);
        let cmt = macroblock.consensus_data.consensus_committee.clone().unwrap_or_default();
        // The stored ban set is QC-bound via epoch_commitment: deserialize the body's bytes and
        // reject if the recomputed commitment doesn't match the checkpoint's ⇒ a relayer-corrupted
        // banned_validators can never pass, so load_macroblock_ban_set(N-1) can trust it as anchor.
        let banned: Vec<String> = macroblock.consensus_data.banned_validators.as_deref()
            .and_then(|b| bincode::deserialize::<Vec<String>>(b).ok()).unwrap_or_default();
        if qnet_consensus::checkpoint_bft::epoch_commitment(elig, &cmt, &banned) != cp.epoch_commitment {
            return Err(format!("v2_epoch_uncertified mb={}", index));
        }
        // Under a pin the body must publish exactly the set the certificate was checked against —
        // otherwise a relaxed macroblock could commit one committee while being certified by another,
        // and the next epoch's derivation would read the wrong one.
        if cp.recovery_anchor.is_some() && cmt != committee {
            return Err(format!("v2_rc_committee_mismatch mb={}", index));
        }
        // Observability backstop: independently re-derive the certified reward_root and ALARM on a
        // mismatch — but never reject. The committee already fail-stops on a divergent reward_root at
        // vote time (consensus_v2_node content_ok), so under the BFT bound (<1/3 Byzantine) the
        // n−f-certified root is honest by construction; a local disagreement therefore means OUR
        // tally is incomplete (fast-sync/snapshot), NOT that the root is forged. Rejecting a
        // QC-certified macroblock on a local recompute would stall exactly those catch-up nodes
        // (the recurring cold-start class) — so we trust the QC and let the adoption backstop
        // reconcile our local root. (Defending a >1/3-Byzantine committee is moot: that breaks
        // state_root too.) Only checked when the window is locally re-derivable (Some).
        if cp.reward_root != [0u8; 32] {
            let ci = qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL;
            let start = cp.window_head_height.saturating_sub(ci).saturating_add(1);
            if let Some(root_hex) = Self::compute_window_reward(storage, start, cp.window_head_height) {
                // Non-empty only: an empty root means this node could not recompute the leaf set at
                // all (it now still returns the schedule-validated total for the adoption path), not
                // that it recomputed a DIFFERENT root. Warning on it would report a divergence that
                // does not exist.
                if !root_hex.is_empty() && root_hex != hex::encode(cp.reward_root) && is_warn() {
                    println!("[WARN][REWARDS] reward_root_local_mismatch mb={} (trusting n−f QC; adoption reconciles)", index);
                }
            }
        }
        // C-2: qc.sigs are pk-stripped (compact). Resolve each signer's pk from on-chain committee state
        // (deterministic + process-uniform: vrf_pk row, else the binary-pinned genesis anchor — NEVER the
        // RAM registry, which is idle-evicted/TOFV ⇒ a fork source in a consensus verifier). Pre-resolved
        // into a Sync map because the per-sig check runs inside QuorumCertificate::verify's rayon par_iter.
        let pk_map: std::collections::HashMap<String, Vec<u8>> = qc.signers.iter().filter_map(|id| {
            match storage.load_vrf_public_key(id) {
                Ok(Some(p)) => Some((id.clone(), p)),
                _ => crate::genesis_constants::get_genesis_anchor_pk(id).map(|p| (id.clone(), p)),
            }
        }).collect();
        let verified = qc.verify(&committee, quorum, |voter, body, sig| {
            let pk = match pk_map.get(voter) { Some(p) => p, None => return false };
            match std::str::from_utf8(sig) {
                Ok(s) => qnet_consensus::consensus_crypto::verify_consensus_signature_compact(
                    voter, &format!("QNET_BFT2_VOTE:{}", hex::encode(body)), s, pk),
                Err(_) => false,
            }
        }).is_ok();
        if !verified {
            return Err(format!("v2_qc_invalid mb={} signers={} committee={}", index, qc.signers.len(), committee.len()));
        }
        Ok(())
    }

    /// Content-verify heights [start..=end] against the QC-certified per-height hash list
    /// (macroblock.micro_blocks == cp.window_mb_hashes, bound by the n−f QC at verify_v2_macroblock).
    /// Returns (missing, mismatched) local heights. Finality must NOT advance while either is non-empty:
    /// a mismatch is a local losing-fork body repair/supersede must replace first (else finality would
    /// pin a fork — the node-001 h=30780 safety violation). Same hash comparator as check_content.
    pub(crate) fn window_content_verdict(storage: &crate::storage::Storage, certified: &[[u8; 32]], start: u64, end: u64) -> (Vec<u64>, Vec<u64>) {
        let mut missing = Vec::new();
        let mut mismatched = Vec::new();
        for h in start..=end {
            let i = (h - start) as usize;
            match storage.load_microblock_auto_format(h) {
                Ok(Some(mb)) => if certified.get(i).map_or(true, |c| mb.hash() != *c) { mismatched.push(h); },
                // Absent is benign - bodies are pruned on a retention schedule.
                Ok(None) => missing.push(h),
                // Unreadable is NOT absent: we could not verify this body, and the benign bucket
                // passes the boot finality ceiling. Fail closed, or a corrupt body in a fork window
                // finalizes the losing fork - the case this function exists to catch.
                Err(e) => {
                    if crate::node::is_warn() {
                        println!("[WARN][SYNC] body_unverifiable h={} err={} treated=mismatched", h, e);
                    }
                    mismatched.push(h);
                }
            }
        }
        (missing, mismatched)
    }

    /// Raise the contiguous content-verified finality ceiling toward `ceiling_round`: from the current
    /// frontier, content-verify each next macroblock window's bodies against its QC-certified hash list;
    /// stop at the first missing/divergent window. anchor-trusted (snapshot) windows pass without reads.
    /// Bounded per call (a cold joiner converges over a few ticks); monotone via fetch_max. Returns the
    /// resulting ceiling. This is the finality floor SYNC-ADOPT must respect so a fork tail cannot finalize.
    pub(super) fn advance_content_verified_frontier(storage: &crate::storage::Storage, ceiling_round: u64) -> u64 {
        // Floor at the finalized height: everything at/below it was content-verified BEFORE it finalized
        // (the P3 invariant), and its bodies may since have been pruned (6-epoch retention). Without this
        // floor a from-genesis node (anchor 0) re-walks from window 1, hits the first pruned-body window,
        // breaks, and pins the frontier at 0 forever — silently disabling the SYNC-ADOPT finality path on
        // any chain older than the retention window.
        let mut fr = CONTENT_VERIFIED_FRONTIER.load(std::sync::atomic::Ordering::Relaxed)
            .max(LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::SeqCst));
        let mut steps = 0u32;
        while fr < ceiling_round && steps < 64 {
            steps += 1;
            let idx = fr / 90 + 1;
            if SNAPSHOT_ANCHOR_MB.load(std::sync::atomic::Ordering::SeqCst) >= idx { fr = idx * 90; continue; }
            let mb = match storage.get_macroblock_by_height(idx).ok().flatten()
                .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok()) {
                Some(m) => m, None => break,
            };
            let (missing, mismatched) = Self::window_content_verdict(storage, &mb.micro_blocks, (idx - 1) * 90 + 1, idx * 90);
            if missing.is_empty() && mismatched.is_empty() { fr = idx * 90; } else { break; }
        }
        CONTENT_VERIFIED_FRONTIER.fetch_max(fr, std::sync::atomic::Ordering::Relaxed);
        fr
    }

    /// Boot finality ceiling: the highest stored (n−f-QC-verified) macroblock whose window's LOCAL
    /// bodies match its QC-certified hashes, walking DOWN from chain_height's window. Closes the
    /// restart-during-fork safety hole — a node that durably APPLIED a losing fork X (so chain_height
    /// reflects X) but has NOT yet had repair replace X with the canonical Y must NOT boot-finalize X.
    /// A content MISMATCH (fork) or an absent macroblock (window not QC-sealed) steps down; a matching
    /// window is the ceiling. Missing bodies within a matching window are pruned-old (finalized before
    /// prune) — window_content_verdict returns them as `missing` not `mismatched`, so they don't stop
    /// the ceiling. O(fork depth) — O(1) for an honest node whose top sealed window matches.
    pub(super) fn boot_content_finality_ceiling(storage: &crate::storage::Storage, chain_height: u64) -> u64 {
        let anchor = SNAPSHOT_ANCHOR_MB.load(std::sync::atomic::Ordering::SeqCst);
        let mut idx = chain_height / 90;
        // Bounded walk. One step per window whose bodies we could not verify; with read errors
        // spread across the height range the only stop was the snapshot anchor, which is 0 on a
        // from-genesis node - that is a whole-history rescan at boot.
        const MAX_CEILING_STEPS: u64 = crate::node::BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64;
        let mut steps = 0u64;
        while idx > anchor && steps < MAX_CEILING_STEPS {
            steps += 1;
            match storage.get_macroblock_by_height(idx).ok().flatten()
                .and_then(|b| bincode::deserialize::<qnet_state::MacroBlock>(&b).ok()) {
                Some(mb) => {
                    let (_, mismatched) = Self::window_content_verdict(storage, &mb.micro_blocks, (idx - 1) * 90 + 1, idx * 90);
                    if mismatched.is_empty() { break; } // canonical window ⇒ ceiling here
                }
                None => {} // no QC-sealed macroblock for this window ⇒ not final ⇒ step down
            }
            idx -= 1;
        }
        (idx * 90).min(chain_height)
    }

    pub async fn process_received_macroblock(&self, received: crate::unified_p2p::ReceivedBlock) -> Result<(), QNetError> {
        let index = received.height;  // For macroblocks, height = index
        
        println!("[INFO][SYNC] macroblock_received index={} peer={}",
                 index, received.from_peer);
        
        // Decompress if needed
        let data = if received.data.len() >= 4 && received.data[0..4] == [0x28, 0xb5, 0x2f, 0xfd] {
            crate::unified_p2p::decompress_zstd_bounded(&received.data[..], MAX_MACROBLOCK_DECOMPRESSED)
                .map_err(|e| QNetError::StorageError(format!("Decompression failed: {}", e)))?
        } else {
            received.data.clone()
        };
        
        // Deserialize and validate macroblock
        let macroblock: qnet_state::MacroBlock = bincode::deserialize(&data)
            .map_err(|e| QNetError::ValidationError(format!("Invalid macroblock format: {}", e)))?;

        // Basic validation
        if macroblock.height != index {
            return Err(QNetError::ValidationError(format!(
                "Macroblock height mismatch: expected {}, got {}", index, macroblock.height
            )));
        }

        // Skip-marker macroblocks are not produced. Reject any (a forged is_skip_marker
        // would otherwise bypass the checkpoint-QC gate below): v2 finality is the n−f
        // checkpoint QC, nothing else.
        if macroblock.consensus_data.is_skip_marker {
            return Err(QNetError::ValidationError(format!("skip_marker_unsupported mb={}", index)));
        }

        // v2 (Checkpoint-BFT): finality is an n−f QC over the checkpoint. checkpoint_qc
        // holds (Checkpoint, QC). Bind the block to the QC (hash + body match), derive the
        // committee deterministically (N-2 / genesis — NOT self-declared), and verify every
        // committee Dilithium signature. A forged committee or QC cannot pass. Bypass
        // commit/reveal (v2 has none).
        if let Some(cp_qc) = macroblock.consensus_data.checkpoint_qc.as_ref() {
            // FULL canonical verify (the SINGLE shared authority — same fn the block-pipeline accept
            // path uses, so neither can be bypassed). Binds every body field to the QC-certified
            // checkpoint, defers on a missing N-2 anchor, derives the committee deterministically,
            // and Dilithium-verifies every committee signature.
            let p2p = self.unified_p2p.as_ref()
                .ok_or_else(|| QNetError::ValidationError(format!("v2_no_p2p mb={}", index)))?;
            Self::verify_v2_macroblock(&macroblock, index, p2p, &self.node_id, self.node_type, &self.storage)
                .await
                .map_err(QNetError::ValidationError)?;
            if is_info() {
                println!("[INFO][MB] v2_qc_ok mb={}", index);
            }
            // The certified reward root is persisted by save_macroblock, atomically with this
            // macroblock. No adoption step: there is nothing to reconcile.
            // Catch-up safety-net (§4.5): hand the now-VERIFIED (checkpoint, QC) to the BFT2 driver so
            // a node whose consensus round fell behind the live quorum fast-forwards from committed
            // state. adopt_qc is monotonic ⇒ a no-op for a node already at/ahead of this checkpoint.
            crate::consensus_v2_node::signal_synced_checkpoint(cp_qc.clone());
        }

        // v2 finality is the n−f checkpoint QC and nothing else. Skip-markers were rejected above, and
        // the honest network NEVER produces a None-QC macroblock (consensus always seals a checkpoint QC).
        // A None-QC macroblock reaching here is a forgery: the removed loose commit/reveal structural path
        // did NO signature verification yet the macroblock was still saved below, letting a byzantine
        // snapshot server inject a fabricated cold-join lineage (the N-2-derived committee would collapse
        // to the attacker's eligible_producers). Reject so "stored ⇒ QC-verified" holds for the cold-join
        // lineage walk — the same anchor_no_qc rule verify_snapshot_anchor_qc applies, now on every macroblock.
        if macroblock.consensus_data.checkpoint_qc.is_none() {
            return Err(QNetError::ValidationError(format!(
                "v2_qc_required mb={} reason=no_checkpoint_qc", index
            )));
        }

        // v3.00: Check if macroblock already saved (e.g., by BFT participant during consensus)
        // CRITICAL: Do NOT return early — emission rewards still need processing!
        // process_macroblock_heartbeats_deterministic has built-in dedup via processed_set
        let already_saved = self.storage.get_macroblock_by_height(index)
            .map(|mb| mb.is_some())
            .unwrap_or(false);
        
        if already_saved {
            // BFT participants save macroblock during consensus, broadcast arrives later
            // Skip save + validation, but continue to emission reward processing below
            if is_info() {
                println!("[INFO][MB-SYNC] already_saved mb={} skip_save process_rewards", index);
            }
            crate::unified_p2p::clear_macroblock_pending_sync(index);

            // v13.2: Update finality even for already-saved macroblocks. A macroblock can
            // be sealed/broadcast before its 90 microblocks land locally, so the earlier
            // try_advance_finality() call may have been a no-op; this second chance advances
            // finality once the body is complete.
            let round = index * 90;
            let prev_round = LAST_FINALIZED_CONSENSUS_ROUND.load(std::sync::atomic::Ordering::SeqCst);
            if round > prev_round {
                // v34: same ALL-microblocks-present guard as the save path below. Previously this
                // dedup branch advanced finality WITHOUT it, so a node that received the macroblock
                // (via BFT seal / broadcast) before its 90 microblocks could push LAST_FINALIZED
                // ahead of chain_height → stall-recovery rollback blocked by FINALITY_VIOLATION →
                // deadlock. Finality must never outrun the locally-applied microblock tip.
                let expected_start = if index == 1 { 1 } else { (index - 1) * 90 + 1 };
                let anchor_trusted = SNAPSHOT_ANCHOR_MB.load(std::sync::atomic::Ordering::SeqCst) >= index;
                // Content-verify against the already-saved macroblock's QC-certified hash list — same guard
                // as the new-save branch, so a divergent local tail body cannot finalize via this path either.
                let (missing, mismatched) = Self::window_content_verdict(&self.storage, &macroblock.micro_blocks, expected_start, index * 90);
                if (missing.is_empty() && mismatched.is_empty()) || anchor_trusted {
                    if try_advance_finality(round, "MB-SYNC-DEDUP") {
                        println!("[INFO][MB-SYNC] finality_catchup mb={} round={} prev_round={}", index, round, prev_round);
                    }
                } else {
                    if !mismatched.is_empty() {
                        println!("[WARN][MB-SYNC] finality_deferred_content mb={} round={} mismatched={} missing={} (dedup)",
                                 index, round, mismatched.len(), missing.len());
                    }
                    if let Some(p2p) = self.unified_p2p.as_ref() {
                        for h in mismatched.iter().chain(missing.iter()).take(32) {
                            let _ = p2p.request_block_repair(*h).await;
                        }
                    }
                }
            }
        } else {
            // New macroblock — validate, save, apply reputation
            
            // Validate microblock hashes exist (if we have the microblocks)
            let expected_start = if index == 1 { 1 } else { (index - 1) * 90 + 1 };
            let expected_end = index * 90;
            
            // Content-verify (not just presence) against the QC-certified hash list.
            let (missing_microblocks, mismatched_microblocks) =
                Self::window_content_verdict(&self.storage, &macroblock.micro_blocks, expected_start, expected_end);

            if (!missing_microblocks.is_empty() || !mismatched_microblocks.is_empty()) && is_debug() {
                // Missing = bulk pipeline still backfilling (benign during sync). Mismatched = a local
                // losing-fork body — repair/supersede must replace it before finality can advance.
                println!("[DBG][MB-SYNC] mb={} missing={} mismatched={}",
                         index, missing_microblocks.len(), mismatched_microblocks.len());
            }
            
            // Save macroblock to storage
            self.storage.save_macroblock(index, &macroblock).await?;

            // Advance the QC-verified frontier immediately on a QC-bearing commit (keeps the cached
            // gate fresh between probes; this is the sole commit-time writer the cache relies on).
            if macroblock.consensus_data.checkpoint_qc.is_some() {
                QC_VERIFIED_FRONTIER.fetch_max(index.saturating_mul(90), std::sync::atomic::Ordering::Relaxed);
            }

            // v3.1: Clear from pending sync tracker after successful save
            crate::unified_p2p::clear_macroblock_pending_sync(index);
            
            // v4.4: Only update finality if ALL microblocks are present.
            // Without this guard, a syncing node receives macroblocks via P2P before
            // the corresponding microblocks arrive. LAST_FINALIZED_HEIGHT jumps ahead
            // of chain_height → stall recovery rollback is blocked by FINALITY_VIOLATION
            // → permanent deadlock (node can't roll back OR advance).
            let round = index * 90;
            let prev_round = LAST_FINALIZED_CONSENSUS_ROUND.load(std::sync::atomic::Ordering::SeqCst);
            if round > prev_round {
                // mb <= snapshot anchor: trusted history — its n−f QC already finalized it and the
                // snapshot carries the state, so finality advances without the sub-anchor microblocks
                // the snapshot legitimately omits. anchor==0 (warm node) ⇒ original present-guard.
                let anchor_trusted = SNAPSHOT_ANCHOR_MB.load(std::sync::atomic::Ordering::SeqCst) >= index;
                if (missing_microblocks.is_empty() && mismatched_microblocks.is_empty()) || anchor_trusted {
                    if try_advance_finality(round, "MB-SYNC") {
                        println!("[INFO][MB-SYNC] finalized_round_updated mb={} round={} finality_h={}", index, round, round);
                    }
                } else {
                    // Do NOT finalize a window that still holds a missing or divergent body. Solicit repair
                    // for both classes; a mismatched height's canonical body supersedes the local fork on
                    // delivery, and the finality-lag re-drive re-attempts once all 90 match. Self-throttled.
                    if !mismatched_microblocks.is_empty() {
                        println!("[WARN][MB-SYNC] finality_deferred_content mb={} round={} mismatched={} missing={}",
                                 index, round, mismatched_microblocks.len(), missing_microblocks.len());
                    }
                    if let Some(p2p) = self.unified_p2p.as_ref() {
                        for h in mismatched_microblocks.iter().chain(missing_microblocks.iter()).take(32) {
                            let _ = p2p.request_block_repair(*h).await;
                        }
                    }
                }
            }
            
        }
        
        if is_info() && !already_saved { 
            println!("[INFO][MB-SYNC] saved mb={} microblocks={}", index, macroblock.micro_blocks.len()); 
        }
        
        Ok(())
    }
    
    /// Start the producer liveness watchdog: a 500 ms-tick tokio task that
    /// reads PRODUCER_HEARTBEAT_MS and warns on silence (3 s → producer_silent,
    /// 10 s → producer_dead), each escalation once per episode, re-armed on
    /// the next heartbeat. Log-only — never mutates producer state, emits BFT
    /// messages, or triggers view-change, so a false positive cannot fork the
    /// chain (failover stays driven solely by the n−f timeout-vote path).
    pub(super) fn start_producer_watchdog() {
        tokio::spawn(async move {
            use std::sync::atomic::Ordering;
            const TICK_MS: u64 = 500;
            const SILENT_THRESHOLD_MS: u64 = 3_000;
            const DEAD_THRESHOLD_MS: u64 = 10_000;

            let mut silent_warned = false;
            let mut dead_warned = false;
            let mut last_seen_heartbeat: u64 = 0;

            let mut interval = tokio::time::interval(std::time::Duration::from_millis(TICK_MS));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

            if is_info() {
                println!("[INFO][WATCHDOG] producer_watchdog_started tick_ms={} silent_ms={} dead_ms={}",
                         TICK_MS, SILENT_THRESHOLD_MS, DEAD_THRESHOLD_MS);
            }

            loop {
                interval.tick().await;

                let heartbeat = PRODUCER_HEARTBEAT_MS.load(Ordering::Relaxed);
                if heartbeat == 0 {
                    // Producer hasn't published its first heartbeat yet — still
                    // initialising. No silence to measure.
                    continue;
                }

                // Re-arm on heartbeat advance — recovered episode, allow fresh warnings.
                if heartbeat != last_seen_heartbeat {
                    if dead_warned {
                        if is_info() {
                            println!("[INFO][WATCHDOG] producer_recovered last_silence_at={}", last_seen_heartbeat);
                        }
                    }
                    last_seen_heartbeat = heartbeat;
                    silent_warned = false;
                    dead_warned = false;
                    continue;
                }

                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let silence_ms = now_ms.saturating_sub(heartbeat);

                if silence_ms >= DEAD_THRESHOLD_MS && !dead_warned {
                    println!(
                        "[WARN][WATCHDOG] producer_dead silence_ms={} last_heartbeat_ms={} action=observability_only",
                        silence_ms, heartbeat
                    );
                    dead_warned = true;
                } else if silence_ms >= SILENT_THRESHOLD_MS && !silent_warned {
                    println!(
                        "[WARN][WATCHDOG] producer_silent silence_ms={} last_heartbeat_ms={}",
                        silence_ms, heartbeat
                    );
                    silent_warned = true;
                }
            }
        });
    }

    /// Start health monitor for sync flags (prevents permanent deadlock)
    pub(super) fn start_sync_health_monitor() {
        // Liveness heartbeat only. Sync liveness is owned by the SyncManager (single coordinator): its
        // `active` flag is scoped by a guard cleared on every execute_sync exit, so there is no stuck flag
        // to poll here.
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if is_info() {
                    println!("[INFO][SYNC] health_monitor_active interval=30s");
                }
            }
        });
    }
    
    /// Recover consensus state after restart
    pub async fn recover_consensus_state(&self) -> Result<(), QNetError> {
        if let Some(ref p2p) = self.unified_p2p {
            // Get latest consensus round from storage
            let latest_round = self.storage.get_latest_consensus_round()?;
            
            if latest_round > 0 {
                println!("[INFO][CONS] request_state round={}", latest_round);
                
                // Request consensus state from peers
                if let Err(e) = p2p.sync_consensus_state(latest_round).await {
                    println!("[WARN][CONS] Failed to sync consensus state: {}", e);
                } else {
                    if is_info() { println!("[INFO][CONS] Consensus state sync initiated"); }
                }
            }
        }
        
        Ok(())
    }
    
}

//! Macroblock consensus listener, microblock signing and verification, merkle roots.

use super::*;

impl BlockchainNode {
    /// CRITICAL: Random selection of consensus initiator with entropy (only ONE node triggers consensus)
    pub(super) async fn should_initiate_consensus(
        p2p: &Arc<SimplifiedP2P>,
        our_node_id: &str, 
        our_node_type: NodeType,
        storage: &Arc<Storage>,
        current_height: u64
    ) -> bool {
        // Determining consensus initiator with entropy
        
        // CRITICAL: Check if we're synchronized before participating in consensus
        // New nodes MUST sync before they can participate in macroblock creation
        let stored_height = storage.get_chain_height().unwrap_or(0);
        
        // No early desync_skip return. The old `if stored_height+50 <
        // network_height { return false }` amplified the mb=10 halt: when the
        // deterministic hash picked a behind node it stepped out, and since
        // non-primary nodes always return false here, NO node took over.
        // Instead the chosen initiator ATTEMPTS creation; on any failure the
        // participants time out, emit signed view-change votes, certified
        // advances, and the next candidate is picked — "is the leader able?"
        // is delegated to the BFT protocol. network_height kept for logging
        // only, no longer pre-disqualifies participation.
        let network_height = p2p.get_cached_network_height().unwrap_or(0);
        if network_height > 0 && stored_height + 50 < network_height && is_warn() {
            println!(
                "[WARN][CONS] behind_network local={} network={} gap={} — proceeding; view-change drives rotation",
                stored_height, network_height, network_height.saturating_sub(stored_height),
            );
        }
        
        // CRITICAL FIX: Allow participation in EARLY consensus (29 blocks ahead for macroblock)
        // Consensus for macroblock 90 starts at height 61 (29 blocks early)
        // So we need to allow nodes that are within 29 blocks of the macroblock height
        let consensus_lookahead = 29; // Consensus starts 29 blocks early (at block 61 for macroblock 90)
        
        // CRITICAL FIX: More lenient lag tolerance for early consensus participation
        // During genesis phase (blocks 1-100), nodes may still be syncing
        // We need to allow consensus to start even if nodes are slightly behind
        let max_allowed_lag = if current_height <= 100 { 
            10  // Increased from 5 to allow nodes to participate during initial sync
        } else { 
            20  // Normal operation tolerance
        };
        
        // Check if node is TOO FAR BEHIND (not synced)
        // CRITICAL: For consensus that starts EARLY (block 61 for macroblock 90),
        // we need to be more lenient because consensus_lookahead adds 29 blocks
        if stored_height + max_allowed_lag < current_height.saturating_sub(consensus_lookahead) {
            println!("[WARN][CONS] local_lag stored={} consensus={} max_lag={}", 
                     stored_height, current_height, max_allowed_lag);
            return false; // Cannot initiate or participate if not synced
        }
        
        // Check if node is TOO FAR AHEAD (should not happen, but safety check).
        // EXCEPT a redriven PAST macroblock boundary: the redrive exists to seal
        // windows the tip has already left behind, so "ahead of the target" is
        // its normal state — this veto silently killed every redriven seal once
        // the tip moved 30+ blocks past the boundary.
        let past_boundary = current_height <= stored_height
            && current_height % qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL == 0;
        if stored_height > current_height + consensus_lookahead && !past_boundary {
            println!("[WARN][CONS] local_ahead h={} round={}",
                     stored_height, current_height);
            return false;
        }
        
        // Node is within acceptable range for early consensus participation
        if is_debug() { println!("[DBG][CONS] synced stored={} curr={}", stored_height, current_height); }
        
        // Get all qualified candidates using existing validator sampling system
        // v3.16: Use LOCAL height for consensus initiation (we're checking if WE should initiate)
        let local_height = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        let mut qualified_candidates = Self::calculate_qualified_candidates(p2p, our_node_id, our_node_type, local_height).await;
        
        // CRITICAL v2.30: NO FALLBACK FOR CONSENSUS CANDIDATES!
        // Empty candidates means node is DESYNCHRONIZED - it cannot participate in consensus!
        //
        // OLD (BROKEN): Genesis fallback → DIFFERENT lists → different initiator → FORK!
        // NEW (CORRECT): return false → node excluded from consensus initiation
        //
        // calculate_qualified_candidates() already handles Genesis epoch (height ≤ 180)
        // by returning static Genesis list. If it returns empty at height > 180,
        // it means macroblock is missing and node MUST sync first.
        if qualified_candidates.is_empty() {
            let current_height = local_height;
            
            if current_height <= 180 {
                // This should NEVER happen - calculate_qualified_candidates returns static list for height ≤ 180
                println!("[WARN][CONS] BUG: Empty candidates at Genesis h={} - using fallback", current_height);
                
                // REFACTORED v2.32: Use unified helper function (eliminates duplication)
                qualified_candidates = Self::get_genesis_candidates_with_real_reputation(p2p);
            } else {
                // height > 180: Node is DESYNCHRONIZED - cannot participate!
                println!("[ERR][CONS] DESYNC h={} - cannot initiate consensus!", current_height);
                
                // STATE MACHINE: Error state
                set_node_state(NodeState::Error {
                    reason: format!("Cannot initiate consensus - no candidates at height {}", current_height),
                    recoverable: true,
                });
                
                return false;
            }
        }
        
        // ENTROPY-BASED: Select consensus initiator using blockchain entropy (like microblocks)
        // This ensures true decentralization and unpredictable initiator selection
        // UNIFIED v2.36: SHA3-512 everywhere for maximum security (256-bit quantum resistance)
        let mut selection_hasher = Sha3_512::new();
        
        // Get current macroblock round (every 90 blocks)
        let macroblock_round = current_height / 90;
        
        // ═══════════════════════════════════════════════════════════════════════════
        // UNIFIED v2.47: ENTROPY SOURCE FOR LEADER SELECTION
        // Same source used by: should_initiate, compute_leader_for_round, PFP
        // 
        // Epoch 1-2 (macroblock #1, #2): Genesis block hash (microblock #0)
        // Epoch 3+  (macroblock #3+):    randomness_beacon from MB N-2 (VRF XOR accumulator)
        //
        // WHY randomness_beacon (not block hash):
        // - Industry standard
        // - Unpredictable: each producer contributes VRF output
        // - Manipulation-resistant: cannot predict future beacon values
        // - Format-independent: doesn't depend on block structure changes
        //
        // WHY N-2 (not N-1):
        // - N-1 may not be fully propagated yet
        // - N-2 is Byzantine-finalized and identical on all synced nodes
        // - Gives ~90 blocks buffer for consensus propagation
        // ═══════════════════════════════════════════════════════════════════════════
        let entropy_source: Vec<u8> = if macroblock_round <= 2 {
            // Epoch 1-2 (macroblock #1, #2): Use Genesis block hash
            // No randomness_beacon available yet - Genesis is the bootstrap entropy
            // UNIFIED v2.47: SHA3-512 for max security, first 32 bytes for beacon compatibility
            match storage.load_microblock(0) {
                Ok(Some(genesis_data)) => {
                    let mut hasher = Sha3_512::new();
                    hasher.update(&genesis_data);
                    let result = hasher.finalize();
                    // Use first 32 bytes to match beacon size
                    result[..32].to_vec()
                }
                _ => {
                    println!("[ERR][CONS] Genesis block not found - node not synchronized!");
                    return false;
                }
            }
        } else {
            // Epoch 3+ (macroblock #3+): Use randomness_beacon from MB N-2
            // This is the VRF XOR accumulator - unpredictable entropy
            let n_minus_2_index = macroblock_round - 2;
            match storage.get_macroblock_by_height(n_minus_2_index) {
                Ok(Some(macroblock_data)) => {
                    match bincode::deserialize::<qnet_state::MacroBlock>(&macroblock_data) {
                        Ok(macroblock) => {
                            if let Some(beacon) = macroblock.consensus_data.randomness_beacon {
                                // Use randomness_beacon directly (32 bytes)
                                beacon.to_vec()
                            } else {
                                // Fallback: use consensus hash if no beacon
                                // v12.0: Use macroblock.hash() (struct fields), not raw bytes
                                println!("[WARN][CONS] MB #{} has no beacon, using consensus_hash", n_minus_2_index);
                                macroblock.hash().to_vec()
                            }
                        }
                        Err(e) => {
                            println!("[ERR][CONS] Failed to deserialize MB #{}: {}", n_minus_2_index, e);
                            return false;
                        }
                    }
                }
                Ok(None) => {
                    println!("[ERR][CONS] Macroblock #{} not found - node not synchronized!", n_minus_2_index);
                    return false;
                }
                Err(e) => {
                    println!("[ERR][CONS] Failed to load macroblock #{}: {}", n_minus_2_index, e);
                    return false;
                }
            }
        };
        
        selection_hasher.update(&entropy_source);
        selection_hasher.update(macroblock_round.to_le_bytes());

        // Canonical macroblock view-change — round-robin leader rotation,
        // same model as the microblock layer:
        //   base_idx = hash(entropy, mb_round, sorted_candidates) % N
        //   leader   = sorted_candidates[(base_idx + view_round) % N]
        // base_idx is a VRF-style pick from on-chain data (identical on every
        // honest node); each view-change advances exactly one slot so all N
        // candidates are covered in N rounds. Replaces hash-with-view-round:
        // mixing the certified round in re-rolled randomly, so a dead node
        // could be re-picked repeatedly and fall into the old desync_skip
        // with no one stepping up (the mb=10 halt). Deterministic, monotonic.

        // Add all candidate IDs to ensure consistent ordering — sorted committee is
        // the shared canonical input for BOTH the base-index hash and the view-round
        // modular offset below. DO NOT add view_round to the hasher — keeping it out
        // of the hash is what turns the formula from "random re-roll" into
        // "deterministic rotation".
        let mut sorted_candidates = qualified_candidates.clone();
        sorted_candidates.sort_by(|a, b| a.0.cmp(&b.0));

        for (candidate_id, _reputation) in &sorted_candidates {
            selection_hasher.update(candidate_id.as_bytes());
        }

        // Calculate stable base index from entropy-bound hash.
        let hash = selection_hasher.finalize();
        let base_idx = u64::from_le_bytes([
            hash[0], hash[1], hash[2], hash[3],
            hash[4], hash[5], hash[6], hash[7],
        ]) as usize % sorted_candidates.len();

        // Apply view-round offset — view_round is the BFT-certified rotation
        // round for this macroblock boundary, advanced only by n−f signed
        // TimeoutVotes. Every honest node sees the same certified round → every
        // honest node computes the same leader → no fork.
        let view_round = p2p.get_highest_certified_round(macroblock_round);
        let initiator_index = (base_idx + view_round as usize) % sorted_candidates.len();

        let consensus_initiator = &sorted_candidates[initiator_index].0;
        if is_info() {
            println!(
                "[INFO][CONSENSUS] initiator={} base_idx={} view_round={} final_idx={}/{}",
                consensus_initiator, base_idx, view_round, initiator_index + 1, sorted_candidates.len(),
            );
        }

        // Check if we are the selected initiator
        // CRITICAL: Use the node_id passed as parameter, not regenerate it
        let our_consensus_id = our_node_id.to_string();

        let we_are_initiator = consensus_initiator == &our_consensus_id;

        if we_are_initiator {
            // v15.2: No local desync_skip early-return. Previously a behind-chain
            // node stepped out silently and NO replacement fired — the round-robin
            // rotation was broken by this very check. Now the node attempts
            // creation; if it genuinely cannot produce (e.g. missing blocks in
            // local storage), the v2 checkpoint sealer returns an Err, a
            // view-change vote is emitted, HIGHEST_CERTIFIED_ROUND advances, and
            // the next `should_initiate_consensus` invocation from the listener
            // picks `(base_idx + view_round + 1) % N` — the next candidate — who
            // will ATTEMPT the creation in turn. Liveness holds deterministically
            // whatever the reason the primary pick cannot proceed.
            if is_info() {
                println!(
                    "[INFO][CONS] initiator=true local_h={} network_h={}",
                    stored_height, network_height,
                );
            }
            return true;
        }
        
        // No early fallback-initiator decision. Deciding fallback from local
        // P2P state raced (node A sees primary down → creates; node B sees it
        // up → waits → fork). Only the deterministically-selected initiator
        // returns true here; fallback happens via TIMEOUT in
        // the v2 TimeoutCertificate view-change (all nodes share the timeout →
        // deterministic).
        
        // I'm participant (not initiator) - wait for macroblock via timeout
        false
    }
    
    /// PRODUCTION v2.34: Event-based MacroBlock consensus listener
    /// 
    /// ARCHITECTURE:
    /// - Listens for block events (height changes)
    /// - At each 90-block window boundary, signals the Checkpoint-BFT v2 runtime
    /// - Uses should_initiate_consensus() to deterministically select ONE proposer
    /// - Proposer builds the Checkpoint; the committee's n−f votes form the QC;
    ///   the macroblock is sealed from the QC'd checkpoint and broadcast
    /// - A silent proposer is replaced via an n−f TimeoutCertificate (view change)
    /// 
    /// CRITICAL: Only ONE node (Leader) creates MacroBlock, others just validate and store!
    pub(super) fn start_macroblock_consensus_listener(
        &self,
        storage: Arc<Storage>,
        p2p: Option<Arc<SimplifiedP2P>>,
        node_id: String,
        node_type: NodeType,
        // total_supply for checkpoint content is now read height-bound via storage seals
        // (get_total_supply_at), not from live state — so this handle is no longer read here.
        state: Arc<RwLock<StateManager>>,
    ) {
        // Subscribe to block events (event-based, not polling!)
        let mut block_event_rx = self.block_event_tx.subscribe();
        
        tokio::spawn(async move {
            println!("[INFO][MB] consensus_listener_start node={}", node_id);
            
            // CRITICAL FIX v2.26.8: Initialize last_consensus_round from storage!
            // Without this, restarted nodes try to create macroblocks that already exist
            // v2.48: Also initialize global LAST_FINALIZED_CONSENSUS_ROUND
            {
                // Find the highest existing macroblock using chain height
                let chain_height = storage.get_chain_height().unwrap_or(0);
                let max_possible_macroblock = chain_height / 90 + 1;  // +1 for safety margin
                
                let mut highest = 0u64;
                for i in 1..=max_possible_macroblock.max(100) {  // At least check 100, or up to current
                    if storage.get_macroblock_by_height(i).ok().flatten().is_some() {
                        highest = i;
                    } else {
                        break;  // Macroblocks are sequential, no need to check further
                    }
                }
                if highest > 0 {
                    // v9.3: Initialize finality from macroblock count, but CAP at actual chain_height.
                    // BUG FIX: If macroblocks 1-50 exist (synced) but microblocks only up to h=202,
                    // setting finality to 50*90=4500 blocks stall recovery from rolling back.
                    // Every L1 finalizes only blocks that ACTUALLY exist.
                    let round = highest * 90;
                    // CONTENT-GATED (P3): cap finality at the highest content-matching sealed window, so a
                    // restarted node that applied a losing fork (but wasn't yet repaired to canonical)
                    // never boot-finalizes the fork. Also caps at chain_height (applied-tip floor).
                    let safe_finality = Self::boot_content_finality_ceiling(&storage, chain_height);
                    LAST_FINALIZED_CONSENSUS_ROUND.store(safe_finality, std::sync::atomic::Ordering::SeqCst);
                    LAST_FINALIZED_HEIGHT.store(safe_finality, std::sync::atomic::Ordering::SeqCst);
                    if safe_finality < round {
                        println!("[WARN][CONSENSUS-LISTENER] finality_capped mb_round={} chain_h={} safe={} — content-unverified or microblocks incomplete",
                                 round, chain_height, safe_finality);
                    }
                    println!("[INFO][MB] consensus_init last_mb={} round={} finality_h={} chain_h={}",
                             highest, round, safe_finality, chain_height);
                }
            }
            // Warm-restart cold-joiner: reload the persisted snapshot anchor (the static resets on
            // restart) so the verify-stage anchor floor + finality survive a restart. No-op otherwise.
            reload_snapshot_anchor();

            // Option B (intra-window finality): the highest CHECKPOINT_INTERVAL boundary already
            // signalled this run. Lazily initialised to the last completed macroblock boundary on
            // the first event so a restart does not re-emit historical windows. Dormant (never
            // advanced) when CHECKPOINT_INTERVAL == 90, since no boundary is intra-window then.
            // Shared with the derivation task so ONLY its success path consumes a boundary.
            let last_intra_signalled = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let intra_inflight = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            // Finality-lag self-heal pacemaker. The checkpoint signal is event-driven (reactive,
            // O(1)/node, idle-free) — but the macro-boundary checkpoint is a one-shot on its block
            // event; if that build defers it is never retried, so finality (and production, via the
            // gate) wedges. This tick re-drives the unfinalized macro boundary even with no new
            // block. Period = the BFT view timeout.
            let mut lag_timer = tokio::time::interval(
                std::time::Duration::from_millis(qnet_consensus::checkpoint_bft::VIEW_TIMEOUT_MS));
            lag_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                let current_height = tokio::select! {
                    ev = block_event_rx.recv() => match ev {
                        Ok(height) => height,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            println!("[WARN][MB] consensus_lagged skipped={}", skipped);
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            println!("[WARN][MB] consensus_channel_closed action=stop");
                            break;
                        }
                    },
                    _ = lag_timer.tick() => {
                        // SYNC-ADOPT: a catching-up node (cold-join / fell behind) advances finality by
                        // ADOPTING the committee's already-n−f-verified checkpoint frontier, bounded by
                        // the locally-applied microblock tip — NOT only via the local BFT2 driver, which
                        // cannot finalize while this node is not a live committee member at these rounds.
                        // QC_VERIFIED_FRONTIER is written ONLY after verify_v2_macroblock (full n−f
                        // Dilithium check) saved the macroblock, so it transitively certifies all ancestors;
                        // it is the same finality basis the MB-SYNC path uses. min(frontier, tip→mb) keeps
                        // finality at/below the applied tip (the v4.4 no-outrun invariant). Without this a
                        // snapshot-less joiner block-syncs microblocks forever while its finality marker
                        // stays frozen at mb1 (the redrive below only re-arms the local driver, which never
                        // finalizes here) → never "synced" → never eligible.
                        {
                            let mi = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
                            let qcf = QC_VERIFIED_FRONTIER.load(std::sync::atomic::Ordering::Relaxed);
                            let tip_mb = (crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                                .load(std::sync::atomic::Ordering::Relaxed) / mi) * mi;
                            // Floor on the content-verified ceiling: adopt-finalize only over windows whose
                            // local bodies match their QC-certified hashes, never over a losing-fork tail.
                            // Re-clamp at tip_mb: CONTENT_VERIFIED_FRONTIER is monotone, so a tip regression
                            // (rollback) below it must not let finality outrun the applied tip.
                            let adoptable = Self::advance_content_verified_frontier(&storage, qcf.min(tip_mb)).min(tip_mb);
                            if adoptable > LAST_FINALIZED_CONSENSUS_ROUND.load(std::sync::atomic::Ordering::SeqCst)
                                && try_advance_finality(adoptable, "SYNC-ADOPT") && is_info() {
                                println!("[INFO][MB] sync_adopt_finality adopted={} qc_frontier={} tip_mb={} content_fr={}",
                                         adoptable, qcf, tip_mb, CONTENT_VERIFIED_FRONTIER.load(std::sync::atomic::Ordering::Relaxed));
                            }
                        }
                        // Re-drive the driver's FRONTIER checkpoint (intra OR macro) when finality
                        // lags the tip beyond the normal 2-chain trail. A checkpoint build is a
                        // one-shot on its block event; if it deferred once it is never retried, and
                        // with production gated no new event ever arrives — so the driver waits
                        // forever for content. Frontier = committed+2 windows (2-chain: highest QC =
                        // committed+1, next-to-propose = QC+1), i.e. (fin/K + 2). At K<MACROBLOCK that
                        // frontier is usually an INTRA boundary, so targeting only the macro boundary
                        // leaves the intra one-shot open. Re-signal is idempotent (driver dedup).
                        let fin = LAST_FINALIZED_CONSENSUS_ROUND.load(std::sync::atomic::Ordering::SeqCst);
                        let tip = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                        let macro_i = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
                        let k = qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL;
                        let published = crate::consensus_v2_node::v2_next_window_head();
                        // The oldest unsealed window wins over the driver's cursor — the cursor can
                        // outrun the tip and silence this guard forever; see redrive_boundary.
                        if let Some(b) = crate::node::redrive_boundary(
                            fin, tip, published, storage.last_sealed_mb_index()) {
                            // Intra frontier: re-arm the cursor so the intra path re-attempts exactly b.
                            if b % macro_i != 0 {
                                last_intra_signalled.store(b.saturating_sub(k), std::sync::atomic::Ordering::Relaxed);
                            }
                            if is_warn() {
                                println!("[WARN][MB] finality_lag_redrive fin={} tip={} boundary={} kind={}",
                                         fin, tip, b, if b % macro_i == 0 { "macro" } else { "intra" });
                            }
                            b
                        } else {
                            continue;
                        }
                    }
                };
                // v35: trigger the macroblock consensus ONLY on the COMPLETE window (the
                // macroblock boundary). Checkpoint-BFT is a single n−f QC over the FULL
                // 90-block window (mb_hashes + head state_root + beacon), so the proposer
                // CANNOT build the checkpoint until block 90 anyway. Starting earlier made
                // it spin DA-repair waiting for the not-yet-produced tail (62-90) — wasted
                // peer requests + alarming "window_repair" logs, zero benefit. Boundary-only:
                // the window is already complete → build + n−f + finalize, no tail-wait. The
                // async consensus is spawned (non-blocking) so the listener still consumes the
                // boundary event reliably; genuine DA loss is still repaired here (now only for
                // truly-missing blocks, never future ones), and a missed boundary is backstopped
                // by the periodic macroblock-gap sync.
                let blocks_in_round = current_height % 90;
                let is_macroblock_boundary = blocks_in_round == 0 && current_height > 0;
                let is_in_consensus_window = is_macroblock_boundary;

                // ── Option B: intra-window finality checkpoint ───────────────────────────────
                // When CHECKPOINT_INTERVAL < MACROBLOCK_INTERVAL, an n−f QC finalizes every K-block
                // sub-window so finality runs faster than the macroblock cadence, while epoch /
                // emission / committee rotation stay per-macroblock. The macroblock-boundary
                // checkpoint is emitted by `is_in_consensus_window` below; this handles ONLY the
                // K-boundaries strictly inside a window. DORMANT at CHECKPOINT_INTERVAL == 90.
                {
                    let k = qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL;
                    let macro_i = qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL;
                    if k < macro_i && current_height > 0 {
                        // Lazy init: on restart skip historical windows (the driver finalizes those
                        // from synced macroblocks) — only drive the live window's intra-checkpoints.
                        if last_intra_signalled.load(std::sync::atomic::Ordering::Relaxed) == 0 {
                            last_intra_signalled.store((current_height / macro_i) * macro_i, std::sync::atomic::Ordering::Relaxed);
                        }
                        // Next intra boundary, stepping the cursor OVER macroblock boundaries (those
                        // are emitted by the boundary path below). Without the step the cursor stalls
                        // on the first macroblock boundary and no later intra checkpoint is ever
                        // signalled ⇒ the next window never reaches the driver ⇒ the chain freezes.
                        // Emit one per event; defer (retry same b) until the sub-window is ready.
                        let (next_intra, stepped) = qnet_consensus::checkpoint_bft::next_intra_checkpoint_boundary(
                            last_intra_signalled.load(std::sync::atomic::Ordering::Relaxed), current_height, k, macro_i);
                        last_intra_signalled.store(stepped, std::sync::atomic::Ordering::Relaxed);
                        if let Some(b) = next_intra {
                            if let Some(ref p2p_ref) = p2p {
                                let start = b - k + 1;
                                let missing: Vec<u64> = (start..=b)
                                    .filter(|&h| !matches!(storage.load_microblock_hash(h), Ok(Some(_))))
                                    .collect();
                                let head_ready = storage.load_microblock_auto_format(b).ok().flatten()
                                    .map(|mb| mb.state_root != [0u8; 32]).unwrap_or(false);
                                // Resolve the epoch-root commitment BEFORE the cursor moves: the spawned
                                // task below cannot un-advance it, so a gap there would drop this
                                // boundary permanently instead of retrying it.
                                let epoch_root_ready = crate::reward_epoch::epoch_root_commitment(&storage, b);
                                if epoch_root_ready.is_none() {
                                    crate::reward_epoch::request_epoch_root_repair(&storage, b);
                                }
                                if missing.is_empty() && head_ready && epoch_root_ready.is_some()
                                    && intra_inflight.compare_exchange(0, b, std::sync::atomic::Ordering::Relaxed, std::sync::atomic::Ordering::Relaxed).is_ok() {
                                    let cursor = last_intra_signalled.clone();
                                    let inflight = IntraInflight(intra_inflight.clone());
                                    let cp_index = b / k;
                                    let macro_window = ((b - 1) / macro_i) + 1; // epoch committee of the host window
                                    let storage_cp = storage.clone();
                                    let p2p_cp = p2p_ref.clone();
                                    let node_id_cp = node_id.clone();
                                    tokio::spawn(async move {
                                        let _inflight = inflight;
                                        // R16: same Sealed gate as the macro-boundary spawn. Without it a freeze
                                        // buffers frozen-committee content here, and on resume the buffer wins
                                        // the race against the sealed-arm redrive — certifying frozen values.
                                        if !matches!(Self::roster_mode(&storage_cp, macro_window), RosterMode::Sealed) {
                                            if is_warn() {
                                                println!("[WARN][CONS] checkpoint_defer cp={} reason=anchor_unsealed_frozen", cp_index);
                                            }
                                            return;
                                        }
                                        // Epoch committee — the SAME N-2 sample the macroblock uses (must match
                                        // peers, else content_ok diverges and the checkpoint never reaches n−f).
                                        let qualified = Self::calculate_qualified_candidates(
                                            &p2p_cp, &node_id_cp, node_type, b).await;
                                        let mut ids: Vec<String> = qualified.iter().map(|(id, _)| id.clone()).collect();
                                        ids.sort();
                                        let committee = Self::select_consensus_committee(&ids, macro_window, &storage_cp);
                                        if !committee.iter().any(|id| id == &node_id_cp) {
                                            cursor.store(b, std::sync::atomic::Ordering::Relaxed); // finished here, not deferred
                                            return;
                                        }
                                        // Checkpoint content = pure function of canonical bodies: hash from
                                        // the body, NOT the O(1) index (which can lag a replacement).
                                        // Complete-or-defer — a short window diverges content_ok.
                                        let mut h_vec: Vec<[u8; 32]> = Vec::new();
                                        for h in start..=b {
                                            let mb = match storage_cp.load_microblock_auto_format(h) {
                                                Ok(Some(mb)) => mb,
                                                _ => {
                                                if is_warn() { println!("[WARN][CONS] checkpoint_defer cp={} reason=body_unreadable h={}", cp_index, h); }
                                                return; // retry this same boundary on the next event
                                            }
                                            };
                                            h_vec.push(mb.hash());
                                        }
                                        let state_root = match storage_cp.load_microblock_auto_format(b) {
                                            Ok(Some(mb)) if mb.state_root != [0u8; 32] => mb.state_root,
                                            _ => {
                                            if is_warn() { println!("[WARN][CONS] checkpoint_defer cp={} reason=state_root_placeholder", cp_index); }
                                            return;
                                            }
                                        };
                                        let beacon = qnet_consensus::checkpoint_bft::accumulate_beacon(&h_vec);
                                        // Empty eligible/banned: an intra-window checkpoint publishes NO epoch
                                        // transition (only the macroblock-boundary checkpoint does).
                                        // registry_root as of this intra head — deterministic, enforced (gated)
                                        // by content_ok like every checkpoint; the field is in the QC hash regardless.
                                        // None ⇒ the roster scan failed ⇒ defer, never publish a short root.
                                        let registry_root = match storage_cp.compute_registry_root(b) {
                                            Some(r) => r,
                                            None => {
                                                if is_warn() { println!("[CRIT][CONS] checkpoint_defer h={} reason=registry_root_unreadable", b); }
                                                return;
                                            }
                                        };
                                        // Seal-strict: None ⇒ not yet sealed ⇒ defer (mirrors total_supply
                                        // below). The lossy fallback is tip-scoped, not height-scoped, so
                                        // publishing it would silently diverge this node's checkpoint.
                                        let dilithium_pk_root = match storage_cp.compute_dilithium_pk_root_sealed(b) {
                                            Some(r) => r,
                                            None => {
                                            if is_warn() { println!("[WARN][CONS] checkpoint_defer cp={} reason=dilithium_pk_root_unsealed", cp_index); }
                                            return;
                                            }
                                        };
                                        // QC-bound total minted supply as of this intra head — read from the
                                        // height-sealed ts_seal_{b} (NOT the live counter). None ⇒ not yet sealed ⇒ defer.
                                        let total_supply = match storage_cp.get_total_supply_at(b) {
                                            Some(t) => t,
                                            None => {
                                            if is_warn() { println!("[WARN][CONS] checkpoint_defer cp={} reason=total_supply_unsealed", cp_index); }
                                            return;
                                            }
                                        };
                                        // A gap means this node cannot compute the value. Emitting a
                                        // placeholder would seal it under n−f and brick every cold
                                        // join anchored here, so defer like the seals above.
                                        let reward_epoch_root = match epoch_root_ready {
                                            Some(r) => r,
                                            None => return, // unreachable: the guard above gates this spawn
                                        };
                                        // Boundary consumed here and nowhere else: every return above leaves it
                                        // for the next event to retry.
                                        cursor.store(b, std::sync::atomic::Ordering::Relaxed);
                                        crate::consensus_v2_node::signal_window_end(
                                            crate::consensus_v2_node::WindowEndArgs {
                                                index: cp_index, head_height: b, mb_hashes: h_vec, state_root, beacon,
                                                committee, eligible_producers: Vec::new(), banned: Vec::new(),
                                                reward_root: [0u8; 32], registry_root, dilithium_pk_root,
                                                reward_epoch_root,
                                                logs_root: [0u8; 32], total_supply,
                                            });
                                        if crate::node::is_info() {
                                            println!("[INFO][BFT2] intra_checkpoint_signalled cp_index={} head={} k={}", cp_index, b, k);
                                        }
                                    });
                                } else if !missing.is_empty() {
                                    // Not ready — repair the holes (bounded) and defer; a later event
                                    // retries this same boundary (last_intra_signalled unchanged).
                                    let p2p_rep = p2p_ref.clone();
                                    tokio::spawn(async move {
                                        for h in missing.into_iter().take(32) { let _ = p2p_rep.request_block_repair(h).await; }
                                    });
                                }
                            }
                        }
                    }
                }
                
                if is_in_consensus_window {
                    // Calculate which macroblock we're creating consensus for
                    // For heights 61-90: create macroblock #1 (blocks 1-90)
                    // For heights 151-180: create macroblock #2 (blocks 91-180)
                    // CRITICAL FIX: Use ((h-1)/90)+1 to handle boundary correctly
                    // Height 61: ((61-1)/90)+1 = 0+1 = 1 ✅
                    // Height 90: ((90-1)/90)+1 = 0+1 = 1 ✅
                    // Height 151: ((151-1)/90)+1 = 1+1 = 2 ✅
                    // Height 180: ((180-1)/90)+1 = 1+1 = 2 ✅
                    let macroblock_index = ((current_height.saturating_sub(1)) / 90) + 1;
                    
                    // v2.48 FIX: Check against GLOBAL finalized round, not local variable!
                    // This ensures all nodes use same source of truth for last finalized MB
                    let last_finalized_round = LAST_FINALIZED_CONSENSUS_ROUND.load(std::sync::atomic::Ordering::SeqCst);
                    let last_finalized_mb = last_finalized_round / 90;
                    
                    // Check if this is a new consensus round
                    if macroblock_index > last_finalized_mb {
                        // Check if node is synchronized before participating
                        let is_synchronized = coordinator_is_synchronized();

                        // A SYNCING node may still join THIS (unfinalized) window's checkpoint iff it
                        // already holds the full window (local_h >= mb_end_height): it can build+sign
                        // correctly, receivers' content_ok rejects any divergent vote, and the extra
                        // committee participant only helps reach quorum — this is what lets a
                        // macro-boundary finality-lag redrive seal on a node whose phase briefly
                        // flipped to Syncing. Subsumes the old genesis mb<=2 carve-out. Without the
                        // window we defer to §4.5 macroblock sync below.
                        let local_h = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                            .load(std::sync::atomic::Ordering::Relaxed);
                        let mb_end_height = macroblock_index * 90;

                        if !checkpoint_participation_allowed(is_synchronized, local_h, mb_end_height) {
                            if is_warn() {
                                println!(
                                    "[WARN][MB] consensus_skip_unsynced mb={} local_h={} reason=not_synchronized_outside_bootstrap_window",
                                    macroblock_index, local_h
                                );
                            }
                            
                            // CRITICAL FIX v2.31: Even unsynchronized nodes MUST receive macroblocks!
                            // Without macroblocks, node cannot do producer selection when it catches up
                            // This prevents the "cascade desync" problem where missing one MB leads to missing all
                            // ═══════════════════════════════════════════════════════════════════
                            // v14.2: MB-SYNC LOOP PREVENTION
                            // ═══════════════════════════════════════════════════════════════════
                            // Previous code spawned a fresh 45s-delayed task on EVERY iteration of
                            // the consensus window (runs every ~1s per block). After 45s, dozens of
                            // tasks fired simultaneously, each hitting peers for the SAME mb_idx.
                            // When the MB was already saved (common case), they all returned
                            // `already_saved skip_save` — wasted CPU + network.
                            //
                            // Fix applies 3 guards:
                            //   1. Storage pre-check: if MB is already saved, don't spawn at all.
                            //   2. Pending-sync deduplication: if a sync is already in-flight, skip.
                            //   3. Inside spawn, re-check storage after the 45s delay (another task
                            //      may have saved it in the meantime).
                            // ═══════════════════════════════════════════════════════════════════
                            if let Some(ref _p2p_sync) = p2p {
                                // Guard 1: storage pre-check (O(1) hash index lookup).
                                let already_saved = storage.get_macroblock_by_height(macroblock_index)
                                    .map(|mb| mb.is_some())
                                    .unwrap_or(false);

                                // Guard 2: pending-sync deduplication.
                                // insert_pending returns false if already present → skip spawn.
                                let insert_pending = crate::unified_p2p::mark_macroblock_pending_sync(macroblock_index);

                                if !already_saved && insert_pending {
                                    let storage_for_sync = storage.clone();
                                    let mb_idx = macroblock_index;

                                    tokio::spawn(async move {
                                        // Wait for consensus to complete on other nodes
                                        tokio::time::sleep(Duration::from_secs(45)).await;

                                        // Guard 3: re-check storage after delay — another task may
                                        // have saved the MB during the wait.
                                        if let Ok(Some(_)) = storage_for_sync.get_macroblock_by_height(mb_idx) {
                                            crate::unified_p2p::clear_macroblock_pending_sync(mb_idx);
                                            if crate::node::is_debug() {
                                                println!("[DBG][SYNC] mb_request_skipped_already_saved mb={}", mb_idx);
                                            }
                                            return;
                                        }

                                        println!("[INFO][SYNC] mb_request_unsynced mb={}", mb_idx);

                                        // Still unsynced after the wait → nudge the single sync coordinator;
                                        // its macroblock pass backfills the object.
                                        crate::sync_manager::nudge_sync_check();
                                        crate::unified_p2p::clear_macroblock_pending_sync(mb_idx);
                                    });
                                } else if crate::node::is_debug() {
                                    println!("[DBG][SYNC] mb_request_dedup mb={} already_saved={} pending_existing={}",
                                             macroblock_index, already_saved, !insert_pending);
                                }
                            }
                            
                            // v2.48 FIX: Do NOT update last_consensus_round here!
                            // Sync is running in background - round will be updated when MB is saved
                            // Just continue to avoid spam (sync task will update LAST_FINALIZED_CONSENSUS_ROUND)
                            continue;
                        }

                        // Operator visibility: a syncing node participated because it holds the full
                        // window (covers genesis cold-start and finality-lag redrive of an old window).
                        if !is_synchronized && local_h >= mb_end_height && is_info() {
                            println!(
                                "[INFO][MB] consensus_participate_while_syncing mb={} local_h={} mb_end={} reason=holds_full_window",
                                macroblock_index, local_h, mb_end_height
                            );
                        }

                        // Check if we're a validator for this round
                        if let Some(ref p2p_ref) = p2p {
                            // v3.16: Pass current_height for deterministic epoch calculation
                            let qualified = Self::calculate_qualified_candidates(
                                p2p_ref,
                                &node_id,
                                node_type,
                                current_height
                            ).await;
                            
                            let is_validator = qualified.iter().any(|(id, _)| id == &node_id);
                            
                            // v3.36: Committee-based BFT — check if this node is in the committee
                            let all_qualified_ids: Vec<String> = qualified.iter().map(|(id, _)| id.clone()).collect();
                            let committee = Self::select_consensus_committee(&all_qualified_ids, macroblock_index, &storage);
                            let is_committee_member = committee.iter().any(|id| id == &node_id);
                            
                            if is_validator && !is_committee_member {
                                if is_info() {
                                    println!("[INFO][COMMITTEE] mb={} node={} NOT_IN_COMMITTEE total={} committee={} → skip_consensus (will receive MB via sync)",
                                        macroblock_index, qnet_state::char_prefix(&node_id, 20), all_qualified_ids.len(), committee.len());
                                }
                            }
                            
                            if is_validator && is_committee_member {
                                // ═══════════════════════════════════════════════════════════════════
                                // v2.49.1 FIX: PREVENT DUPLICATE CONSENSUS TASKS FOR SAME MB
                                // Use compare_exchange with CURRENT MB check, not just 0
                                // Logic: Allow new MB if (active == 0) OR (active < current_mb)
                                // This prevents duplicates for SAME MB but allows NEXT MB to start
                                // ═══════════════════════════════════════════════════════════════════
                                let current_active = ACTIVE_CONSENSUS_MB.load(std::sync::atomic::Ordering::SeqCst);
                                
                                // Case 1: Same MB already active → skip duplicate
                                if current_active == macroblock_index {
                                    if is_debug() { 
                                        println!("[DBG][CONS] skip_duplicate mb={} already_active", macroblock_index); 
                                    }
                                    continue;
                                }
                                
                                // Case 2: Old MB still "active" (stale lock from previous epoch)
                                // If current_active < macroblock_index, the old task is stale - override it
                                // This handles: panic in old task, timeout, stuck consensus
                                if current_active > 0 && current_active < macroblock_index {
                                    // Contiguous advance = normal epoch progress (DBG); a gap means a
                                    // skipped/stuck window (WARN).
                                    if macroblock_index == current_active + 1 {
                                        if is_debug() { println!("[DBG][CONS] lock_advance old_mb={} new_mb={}", current_active, macroblock_index); }
                                    } else if is_warn() {
                                        println!("[WARN][CONS] stale_lock_override old_mb={} new_mb={} gap={}",
                                                 current_active, macroblock_index, macroblock_index - current_active);
                                    }
                                    // Force override - old consensus is stale
                                    ACTIVE_CONSENSUS_MB.store(macroblock_index, std::sync::atomic::Ordering::SeqCst);
                                } else if current_active == 0 {
                                    // Case 3: No active consensus - try to acquire lock
                                    let active_result = ACTIVE_CONSENSUS_MB.compare_exchange(
                                        0,                                          // Expected: no active
                                        macroblock_index,                           // Set to current MB
                                        std::sync::atomic::Ordering::SeqCst,
                                        std::sync::atomic::Ordering::SeqCst
                                    );
                                    
                                    if active_result.is_err() {
                                        // Race condition - another thread got it first, retry next block
                                        if is_debug() { 
                                            println!("[DBG][CONS] lock_race mb={}", macroblock_index); 
                                        }
                                        continue;
                                    }
                                } else {
                                    // Case 4: Future MB active (shouldn't happen) - skip
                                    println!("[WARN][CONS] future_mb_active active={} requested={}", 
                                             current_active, macroblock_index);
                                    continue;
                                }
                                
                                if is_info() { 
                                    println!("[INFO][CONS] validator=true mb={} participating active_lock=acquired", macroblock_index); 
                                }
                                
                                // Calculate block range for this macroblock
                                // Macroblock #1: blocks 1-90
                                // Macroblock #2: blocks 91-180, etc.
                                let start_height = ((macroblock_index.saturating_sub(1)) * 90) + 1;
                                let end_height = macroblock_index * 90;
                                
                                // Determine if we're the initiator or participant
                                let should_initiate = Self::should_initiate_consensus(
                                    p2p_ref,
                                    &node_id,
                                    node_type,
                                    &storage,
                                    end_height
                                ).await;
                                
                                // v2.46: ASYNC CONSENSUS - Production NEVER waits for consensus!
                                // Consensus runs in background, allowing continuous block production
                                // This prevents network stalls under high TPS load
                                
                                let storage_cons = storage.clone();
                                let p2p_cons = p2p_ref.clone();
                                let node_id_cons = node_id.clone();
                                // The eligible snapshot reads the equivocation ban out of APPLIED state,
                                // which is what state_root commits — not the async accounts mirror.
                                let state_cons = state.clone();
                                let mb_idx = macroblock_index;

                                tokio::spawn(async move {
                                    // Frees the active-consensus lock if this task defers without
                                    // signalling, so the window is re-attempted; disarmed on signal.
                                    let mut active_guard = ActiveConsensusGuard { mb_idx, signalled: false };
                                    let role = if should_initiate { "PROPOSER" } else { "REPLICA" };
                                    if is_info() {
                                        println!("[INFO][ASYNC-CONS] mb={} role={} start_h={} end_h={} async=true",
                                                 mb_idx, role, start_height, end_height);
                                    }

                                    // Consensus v2 (Checkpoint-BFT): one n−f checkpoint per window — the only
                                    // macroblock consensus (legacy commit/reveal removed). The v2 runtime runs
                                    // since boot; here we assemble this window's inputs and hand off to it.
                                    if crate::consensus_v2_node::v2_enabled() {
                                        // R16: propose/vote a checkpoint ONLY when its certification anchor
                                        // (macroblock mb_idx-2) is sealed. While finality is stalled the anchor
                                        // is unsealed, verify_v2_macroblock defers, and a proposal built now
                                        // carries frozen-derived content peers Reject on resume. Defer; the
                                        // finality-lag redrive rebuilds via the sealed arm once the anchor seals.
                                        if !matches!(Self::roster_mode(&storage_cons, mb_idx), RosterMode::Sealed) {
                                            if is_warn() {
                                                println!("[WARN][CONS] checkpoint_defer mb={} reason=anchor_unsealed_frozen", mb_idx);
                                            }
                                            return;
                                        }
                                        // Deterministic epoch committee (N-2 VRF sample, ≤100) for signing,
                                        // and the next-epoch eligible-producer snapshot (≤MAX_VALIDATORS)
                                        // the macroblock body publishes for N-2 selection — same selection
                                        // path as v1, scales to 100k.
                                        let qualified = Self::calculate_qualified_candidates(
                                            &p2p_cons, &node_id_cons, node_type, end_height,
                                        ).await;
                                        let mut ids: Vec<String> = qualified.iter().map(|(id, _)| id.clone()).collect();
                                        ids.sort();
                                        let committee = Self::select_consensus_committee(&ids, mb_idx, &storage_cons);
                                        let eligible = {
                                            let st = state_cons.read().await;
                                            Self::create_eligible_producers_snapshot(
                                                &p2p_cons, &ids, &node_id_cons, node_type, mb_idx,
                                                &storage_cons, &st,
                                            ).await
                                        };
                                        // Vec::new() is this snapshot's ABSTAIN sentinel (unusable heartbeat
                                        // index, no VRF seed). Publishing it seals a macroblock whose
                                        // eligible_producers is empty — and that object is the roster source
                                        // for the next epochs, is QC-certified, and is never replaced, so the
                                        // chain wedges permanently. Same guard the derived path already has.
                                        if eligible.is_empty() || committee.is_empty() {
                                            if is_warn() {
                                                println!("[WARN][CONS] window_end_abstain mb={} eligible={} committee={} reason=underivable",
                                                         mb_idx, eligible.len(), committee.len());
                                            }
                                            return;
                                        }
                                        let eligible_bytes = bincode::serialize(&eligible).unwrap_or_default();
                                        // The window's committed block hashes: both the checkpoint's
                                        // mb_hashes and the beacon fold this one vector.
                                        //
                                        // v33: deterministic checkpoint content from the commit-time accumulator.
                                        // Each block's (hash, vrf_output) was captured when it committed (in hand),
                                        // so the window is complete + bit-identical on every node — NO storage
                                        // re-read race (the old re-read returned None for applied-but-unflushed
                                        // blocks → partial content → divergence → finality stall). Falls back to a
                                        // bounded-wait re-read only if the accumulator is incomplete for this window
                                        // (e.g. blocks that arrived via out-of-order bulk sync). state_root (the head
                                        // block's real account root, written only after TX apply) is read below.
                                        let mut state_root = [0u8; 32];
                                        let (mb_hashes, content_src) =
                                            match crate::node::window_content_from_accum(mb_idx) {
                                                Some(h) => (h, "accum"),
                                                None => {
                                                    // Fallback: bounded-wait for the full window to persist, actively
                                                    // REPAIRING any missing microblock heights from peers as we wait.
                                                    // v34 DA-repair: the prior stall root was a node that lost a few
                                                    // microblock shreds (hash_miss) and could NEVER reproduce the window
                                                    // content → checkpoint never reached n−f → the chain froze. The
                                                    // missing blocks DO exist on peers that received them;
                                                    // request_block_repair(H) fetches the EXACT missing heights (verified
                                                    // on receipt by the producer's Dilithium sig + prev_hash linkage), so
                                                    // the node completes the window and can sign. This is the targeted
                                                    // microblock repair the recovery path lacked — it requested the
                                                    // (unsealed, nonexistent) macroblock instead of the missing microblocks.
                                                    for attempt in 0..120u32 {
                                                        let mut missing: Vec<u64> = Vec::new();
                                                        for h in start_height..=end_height {
                                                            if !matches!(storage_cons.load_microblock_hash(h), Ok(Some(_))) {
                                                                missing.push(h);
                                                            }
                                                        }
                                                        if missing.is_empty() { break; }
                                                        // Re-request the specific holes ~every 2s (8×250ms), bounded per
                                                        // round so a wide gap cannot fan out into a peer-DoS. Idempotent:
                                                        // a peer serves the stored block; an already-present block is
                                                        // simply re-applied (dedup), never double-counted.
                                                        if attempt % 8 == 0 {
                                                            if is_warn() {
                                                                println!("[WARN][CONS] window_repair mb={} missing={} first={} last={} — fetching microblocks from peers",
                                                                         mb_idx, missing.len(),
                                                                         missing.first().copied().unwrap_or(0),
                                                                         missing.last().copied().unwrap_or(0));
                                                            }
                                                            for &h in missing.iter().take(32) {
                                                                let _ = p2p_cons.request_block_repair(h).await;
                                                            }
                                                        }
                                                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                                                    }
                                                    // Body-derived, complete-or-defer (same as the intra path):
                                                    // hash from the body, not the O(1) index.
                                                    let mut h_vec: Vec<[u8; 32]> = Vec::new();
                                                    for h in start_height..=end_height {
                                                        let mb = match storage_cons.load_microblock_auto_format(h) {
                                                            Ok(Some(mb)) => mb,
                                                            _ => {
                                                            if is_warn() { println!("[WARN][CONS] window_end_defer mb={} reason=body_unreadable h={}", mb_idx, h); }
                                                            return; // defer to the sync path
                                                        }
                                                        };
                                                        h_vec.push(mb.hash());
                                                    }
                                                    (h_vec, "reread")
                                                }
                                            };
                                        // The head block's REAL account-state root (finalize_merkle) is written
                                        // only AFTER its TXs are applied; at the window boundary the stored block
                                        // can still carry the [0;32] placeholder. The macroblock MUST commit the
                                        // real root — else the checkpoint state-finality check defers every window
                                        // and the body carries no valid state commitment. Read it directly first
                                        // (common case: head already applied), else wait (bounded) for the head to
                                        // apply: deterministic on every node (a node that times out simply abstains;
                                        // n−f applied nodes still seal).
                                        if let Ok(Some(head_mb)) = storage_cons.load_microblock_auto_format(end_height) {
                                            state_root = head_mb.state_root;
                                        }
                                        if state_root == [0u8; 32] {
                                            for _ in 0..120 {
                                                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                                                if let Ok(Some(head_mb)) = storage_cons.load_microblock_auto_format(end_height) {
                                                    if head_mb.state_root != [0u8; 32] {
                                                        state_root = head_mb.state_root;
                                                        break;
                                                    }
                                                }
                                            }
                                            if state_root == [0u8; 32] {
                                                // Defer (do NOT signal) when the head's real account root is still
                                                // unapplied after the bounded wait. Signalling the [0;32] placeholder
                                                // would diverge content_ok against peers that DID apply (this node
                                                // abstains anyway), and if a quorum shared the placeholder it would
                                                // seal a macroblock with NO real state commitment. Stepping aside lets
                                                // a node with the applied root propose; this node applies the
                                                // macroblock via the §4.5 sync wire once a quorum seals it — same
                                                // fail-stop discipline as the partial-window (mb_hashes) guard below.
                                                if is_warn() {
                                                    println!("[WARN][CONS] head_state_unapplied mb={} end_h={} — placeholder root, not signalling (defer to §4.5 sync)", mb_idx, end_height);
                                                }
                                                return;
                                            }
                                        }
                                        let beacon = qnet_consensus::checkpoint_bft::accumulate_beacon(&mb_hashes);
                                        // P2-D: never signal PARTIAL window content. The accumulator path is
                                        // always complete (window_content_from_accum returns None for an
                                        // incomplete buffer); only the re-read fallback can come up short if a
                                        // block is still unflushed after the bounded wait. A shorter mb_hashes
                                        // than peers diverges content_ok → finality stalls for this window. Skip
                                        // instead — this node applies the macroblock via the §4.5 sync wire once
                                        // a quorum seals it. (Full window = 90 microblocks.)
                                        let expected_len = (end_height - start_height + 1) as usize;
                                        if mb_hashes.len() < expected_len {
                                            if is_warn() {
                                                println!("[WARN][CONS] window_content_incomplete mb={} src={} have={} need={} — not signalling (defer to §4.5 sync)",
                                                         mb_idx, content_src, mb_hashes.len(), expected_len);
                                            }
                                            return;
                                        }
                                        // QC-bind the cumulative ban set: identical deterministic set the
                                        // macroblock body stores at Persist (compute_cumulative_ban_set on the
                                        // same committed window mb_idx), folded into epoch_commitment so a
                                        // relayer cannot corrupt the stored banned_validators without breaking
                                        // the checkpoint QC. Sorted for a byte-stable, order-independent commit.
                                        let banned_for_epoch = {
                                            let set = match Self::compute_cumulative_ban_set(&storage_cons, mb_idx).await {
                                                Some(b) => b,
                                                // Underivable ⇒ do NOT signal. Publishing a guessed set would
                                                // put it in epoch_commitment and split the QC; the §4.5 sync
                                                // wire delivers this window once a quorum seals it.
                                                None => {
                                                        if is_warn() { println!("[WARN][CONS] window_end_defer mb={} reason=ban_set_underivable", mb_idx); }
                                                        return;
                                                }
                                            };
                                            let mut v: Vec<String> = set.into_iter().collect();
                                            v.sort();
                                            v
                                        };
                                        // index = checkpoint index = head/CHECKPOINT_INTERVAL (at K=90 this == mb_idx).
                                        // The macroblock-boundary checkpoint carries the FULL window + epoch data;
                                        // intra-window checkpoints (signalled separately) carry K-block sub-windows.
                                        // Self-aligning emission reward root for this window (committee-verified
                                        // via Checkpoint.reward_root; [0;32] off an emission boundary).
                                        let reward_root = match Self::compute_window_reward_root(&storage_cons, start_height, end_height) {
                                            Some(r) => r,
                                            // Cannot reproduce this epoch's leaf set — defer like the four
                                            // sibling guards below rather than certify "paid nobody".
                                            None => {
                                                if is_warn() {
                                                    println!("[WARN][CONS] window_end_defer mb={} reason=reward_root_underivable", mb_idx);
                                                }
                                                return;
                                            }
                                        };
                                        // Deterministic Super/genesis registry digest as of the window head — QC-certified
                                        // via Checkpoint.registry_root so an untrusted-snapshot joiner can verify the
                                        // restored node_registry (source of cbw + attestor VRF keys). reg_height<=end_height.
                                        let registry_root = match storage_cons.compute_registry_root(end_height) {
                                            Some(r) => r,
                                            None => {
                                                if is_warn() { println!("[CRIT][CONS] window_end_defer mb={} reason=registry_root_unreadable", mb_idx); }
                                                return;
                                            }
                                        };
                                        // Seal-strict (mirrors total_supply below): None ⇒ not yet sealed ⇒ defer,
                                        // never publish the tip-scoped fallback into a QC-bound field.
                                        let dilithium_pk_root = match storage_cons.compute_dilithium_pk_root_sealed(end_height) {
                                            Some(r) => r,
                                            None => {
                                                        if is_warn() { println!("[WARN][CONS] window_end_defer mb={} reason=dilithium_pk_root_unsealed", mb_idx); }
                                                        return;
                                            }
                                        };
                                        // QC-bound total minted supply as of the window head — read from the
                                        // height-sealed ts_seal_{end_height} (NOT the live counter, which races the
                                        // in-block mint). None ⇒ this head not yet applied+sealed ⇒ defer.
                                        let total_supply = match storage_cons.get_total_supply_at(end_height) {
                                            Some(t) => t,
                                            None => {
                                                        if is_warn() { println!("[WARN][CONS] window_end_defer mb={} reason=total_supply_unsealed", mb_idx); }
                                                        return;
                                            }
                                        };
                                        // Consensus event logs_root — ACTIVE from genesis (`logs_root_required` gate=0).
                                        // Merkle root over this window's committed event logs (native QRC-20/721 transfers +
                                        // WASM emit_log), folded into Checkpoint.hash + QC-certified n−f. CONSENSUS-CRITICAL:
                                        // block_logs must be byte-identical across the validator + producer drain paths, else
                                        // this root diverges and the macroblock QC never reaches n−f.
                                        let logs_root = if qnet_state::feature_gates::is_active("logs_root_required", end_height) {
                                            Self::compute_window_logs_root(&storage_cons, start_height, end_height)
                                        } else { [0u8; 32] };
                                        // Gap ⇒ cannot compute; defer rather than seal a placeholder.
                                        let reward_epoch_root = match crate::reward_epoch::epoch_root_commitment(&storage_cons, end_height) {
                                            Some(r) => r,
                                            None => {
                                                crate::reward_epoch::request_epoch_root_repair(&storage_cons, end_height);
                                                        if is_warn() { println!("[WARN][CONS] window_end_defer mb={} reason=reward_epoch_root_absent action=repair", mb_idx); }
                                                return;
                                            }
                                        };
                                        active_guard.signalled = true; // content delivered → keep the lock held
                                        crate::consensus_v2_node::signal_window_end(
                                            crate::consensus_v2_node::WindowEndArgs {
                                                index: end_height / qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL,
                                                head_height: end_height, mb_hashes, state_root, beacon, committee,
                                                eligible_producers: eligible_bytes, banned: banned_for_epoch,
                                                reward_root, registry_root, dilithium_pk_root,
                                                reward_epoch_root,
                                                logs_root, total_supply,
                                            });
                                        return;
                                    }
                                });
                                
                                // v2.48 FIX: Do NOT update last_consensus_round here!
                                // Round is updated INSIDE async task ONLY when MB is saved
                                // This prevents round mismatch between nodes
                                
                                // v2.47.1: MULTI-RETRY MISSING MACROBLOCKS
                                // If previous MB failed to create, retry consensus!
                                // This prevents network stalls when consensus fails under load
                                // 
                                // PROTECTION: Track retry count per MB (max 3 retries)
                                use std::sync::atomic::AtomicU64;
                                static RETRY_MB_INDEX: AtomicU64 = AtomicU64::new(0);
                                static RETRY_MB_COUNT: AtomicU64 = AtomicU64::new(0);
                                const MAX_MB_RETRIES: u64 = 5;
                                
                                if macroblock_index > 1 {
                                    let prev_mb_idx = macroblock_index - 1;
                                    
                                    // v2.47.1: Calculate if prev MB consensus should still be running
                                    // MB#N consensus runs during blocks (N-1)*90+61 to N*90
                                    // So we should NOT retry if we're still in that window!
                                    let prev_mb_consensus_end_block = prev_mb_idx * 90;
                                    let blocks_since_consensus_end = current_height.saturating_sub(prev_mb_consensus_end_block);
                                    
                                    // Grace period: 30 blocks (~30 seconds) after consensus window ends
                                    // This gives enough time for MB to be saved and synced
                                    const CONSENSUS_GRACE_BLOCKS: u64 = 30;
                                    
                                    if blocks_since_consensus_end < CONSENSUS_GRACE_BLOCKS {
                                        // Too early to retry - consensus may still be completing
                                        if is_debug() { 
                                            println!("[DBG][RETRY] mb={} grace_period blocks_since={} grace={}", 
                                                     prev_mb_idx, blocks_since_consensus_end, CONSENSUS_GRACE_BLOCKS); 
                                        }
                                    } else {
                                        // Check retry state
                                        let last_retry_idx = RETRY_MB_INDEX.load(std::sync::atomic::Ordering::Relaxed);
                                        let retry_count = RETRY_MB_COUNT.load(std::sync::atomic::Ordering::Relaxed);
                                        
                                        // New MB index = reset counter
                                        if last_retry_idx != prev_mb_idx {
                                            RETRY_MB_INDEX.store(prev_mb_idx, std::sync::atomic::Ordering::Relaxed);
                                            RETRY_MB_COUNT.store(0, std::sync::atomic::Ordering::Relaxed);
                                        }
                                        
                                        // Check if max retries exceeded
                                        if last_retry_idx == prev_mb_idx && retry_count >= MAX_MB_RETRIES {
                                            if is_debug() { 
                                                println!("[DBG][RETRY] mb={} max_retries={} exceeded", prev_mb_idx, MAX_MB_RETRIES); 
                                            }
                                        } else {
                                            // Check if previous MacroBlock exists
                                            let prev_mb_exists = storage.get_macroblock_by_height(prev_mb_idx)
                                                .map(|mb| mb.is_some())
                                                .unwrap_or(false);
                                            
                                            if !prev_mb_exists {
                                                // Increment retry count BEFORE spawn
                                                let current_retry = RETRY_MB_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                                                
                                                if is_warn() { 
                                                    println!("[WARN][RETRY] mb={} missing retry={}/{}", prev_mb_idx, current_retry, MAX_MB_RETRIES); 
                                                }
                                                
                                                // ═══════════════════════════════════════════════════════════════════
                                                // v2.49 FIX: RETRY VIA SYNC FOR OLD MACROBLOCKS
                                                // If MB is more than 1 epoch behind, consensus will fail with Round Mismatch!
                                                // Solution: Use direct sync (download ready MB) instead of consensus
                                                // 
                                                // WHY: Consensus engine has tolerance of ±90 blocks (1 epoch)
                                                // If prev_mb_idx * 90 is more than 90 blocks behind current height,
                                                // all commit/reveal messages will be rejected with Round Mismatch
                                                // ═══════════════════════════════════════════════════════════════════
                                                let mb_round = prev_mb_idx * 90;
                                                let current_round = macroblock_index * 90;
                                                let round_gap = current_round.saturating_sub(mb_round);
                                                
                                                // If gap > 90 blocks (1 epoch), use sync instead of consensus
                                                const MAX_CONSENSUS_GAP: u64 = 90;
                                                let use_sync = round_gap > MAX_CONSENSUS_GAP;
                                                
                                                if use_sync {
                                                    // TOO OLD for consensus - use direct sync!
                                                    if is_info() { 
                                                        println!("[INFO][RETRY] mb={} via_sync gap={} (consensus_max={})", 
                                                                 prev_mb_idx, round_gap, MAX_CONSENSUS_GAP); 
                                                    }
                                                    
                                                    // Macroblock too old for consensus (gap>epoch) → nudge the
                                                    // single sync coordinator to download it directly.
                                                    crate::sync_manager::nudge_sync_check();
                                                }
                                            }
                                        }
                                    }
                                }
                            } else {
                                if is_debug() { 
                                    println!("[DBG][CONS] mb={} validator=false will_receive_broadcast", macroblock_index); 
                                }
                                
                                // CRITICAL FIX v2.31: Even non-validators MUST receive macroblock!
                                let current_tasks = ACTIVE_MACROBLOCK_CHECK_TASKS.load(std::sync::atomic::Ordering::Relaxed);
                                if current_tasks >= MAX_CONCURRENT_MACROBLOCK_CHECKS {
                                    if is_debug() { 
                                        println!("[DBG][CONS] rate_limited tasks={}", current_tasks); 
                                    }
                                    // v2.48 FIX: Do NOT update round when rate limited!
                                    // Let the task complete and update LAST_FINALIZED_CONSENSUS_ROUND
                                    continue;
                                }
                                
                                let storage_check = storage.clone();
                                let mb_index = macroblock_index;
                                
                                ACTIVE_MACROBLOCK_CHECK_TASKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                
                                tokio::spawn(async move {
                                    struct TaskGuard;
                                    impl Drop for TaskGuard {
                                        fn drop(&mut self) {
                                            ACTIVE_MACROBLOCK_CHECK_TASKS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                                        }
                                    }
                                    let _guard = TaskGuard;
                                    
                                    tokio::time::sleep(Duration::from_secs(15)).await;
                                    
                                    let has_macroblock = storage_check.get_macroblock_by_height(mb_index)
                                        .map(|mb| mb.is_some())
                                        .unwrap_or(false);
                                    
                                    if !has_macroblock {
                                        if is_warn() {
                                            println!("[WARN][MB-SYNC] mb={} status=missing source=broadcast action=requesting", mb_index);
                                        }
                                        
                                        // Missing after the broadcast window → nudge the single sync
                                        // coordinator to backfill the macroblock object.
                                        crate::sync_manager::nudge_sync_check();
                                    } else {
                                        if is_debug() {
                                            println!("[DBG][MB-SYNC] mb={} status=received source=broadcast", mb_index);
                                        }
                                    }
                                });
                                
                                // v2.48 FIX: Do NOT update last_consensus_round here!
                                // Round is updated INSIDE async task when MB is actually received
                            }
                        }
                    }
                }
            }
        });
    }
    
    
    // PRODUCTION: Byzantine consensus methods for Checkpoint-BFT v2 (macroblock QC)

    /// v14.8: CANONICAL MACROBLOCK VIEW CHANGE.
    ///
    /// Called whenever the n−f threshold for commit OR reveal fails for a
    /// macroblock round. Signs + broadcasts a ML-DSA-65 TimeoutVote at
    /// (mb_index, cert_round + 1). After n−f such votes the existing
    /// TimeoutCertificate aggregator bumps HIGHEST_CERTIFIED_ROUND[mb_index],
    /// which is mixed into should_initiate_consensus() hash — so every
    /// honest node deterministically picks a DIFFERENT leader for the next
    /// attempt, IN THE SAME EPOCH, and consensus resumes without waiting for
    /// the next 90-block boundary.
    ///
    /// Idempotent: the underlying broadcast path dedupes via
    /// TIMEOUT_VOTED_HEIGHTS, so calling this twice for the same round is safe.
    /// Returns true only when a vote was actually signed and broadcast — callers pace on that.
    pub(super) async fn emit_macroblock_view_change_vote(
        round_id: u64,
        node_id: &str,
        unified_p2p: &Option<Arc<SimplifiedP2P>>,
        storage: Option<&Arc<Storage>>,
    ) -> bool {
        let Some(p2p) = unified_p2p else { return false; };
        // round_id == 0 is VALID: window 0 (heights 1..89) fails over with the fixed genesis-5
        // committee and a zero anchor — no special genesis mechanics.
        if round_id % 90 != 0 {
            return false;
        }
        let mb_index = round_id / 90;

        // Window-monotonic floor (anti-double-TC): once ANY window certified, never vote below it —
        // resuming a lower key would let ≤f cross-window Byzantine votes certify two adjacent windows.
        if mb_index < crate::unified_p2p::observed_tc_window_floor() {
            if is_info() {
                println!("[INFO][TIMEOUT] emit_suppressed mb={} reason=below_tc_floor floor={}",
                         mb_index, crate::unified_p2p::observed_tc_window_floor());
            }
            return false;
        }

        // Window-keyed committee (identical on every node). Refuse-and-fetch: without the sealed
        // anchor macroblock we cannot sign a countable vote — pull it and vote next tick (it
        // provably exists network-wide for any producible window).
        let committee = match crate::unified_p2p::failover_committee_for_window(mb_index) {
            Some(c) => c,
            None => {
                p2p.request_window_anchor(mb_index); // actually pull the anchor; vote next tick
                if is_warn() {
                    println!("[WARN][TIMEOUT] emit_deferred mb={} reason=anchor_absent action=fetch", mb_index);
                }
                return false;
            }
        };
        // Non-committee members don't vote: receivers drop the vote anyway, and at 100k supers
        // with a 1000-committee the wasted flood would be the dominant stall traffic.
        if !committee.contains(node_id) {
            return false;
        }
        let anchor = match crate::unified_p2p::sealed_anchor_for_window(mb_index) {
            Some(a) => a,
            None => { p2p.request_window_anchor(mb_index); return false; } // committee cached but anchor bytes absent — pull
        };

        // Base = certified+1 (consensus-visible, identical on every node). f+1 round amplification:
        // jump to the highest round ≥1 honest validator already reached. Leader election still reads
        // only the n−f-certified round, so amplifying the TARGET cannot cause dual production.
        let current_cert = p2p.get_highest_certified_round(mb_index);
        let f = committee.len().saturating_sub(1) / 3;
        let observed = crate::unified_p2p::highest_failover_round_with_support(mb_index, f + 1);
        // DoS bound + hold-at-cap: never vote past MAX_FAILOVER_ROUND. Past it, >MAX rotations in one
        // window is a sync/partition problem, not leader liveness — clamping stops the runaway
        // certified-round climb while the pacemaker keeps voting the bounded round, so progress resumes
        // the instant connectivity/finality returns (the failover loop drives sync recovery in parallel).
        let next_round = current_cert.saturating_add(1).max(observed).min(MAX_FAILOVER_ROUND);

        // Voter's own sync state: last sealed macroblock (high_qc) + verified tip — hints and
        // accountability inside the signed payload; never quorum-read by verifiers.
        let (high_qc_idx, high_qc_hash, tip_height, tip_hash) = match storage {
            Some(s) => {
                let qc_idx = s.last_sealed_mb_index();
                let qc_hash = if qc_idx > 0 { s.get_latest_macroblock_hash().unwrap_or([0u8; 32]) } else { [0u8; 32] };
                let tip = s.get_chain_height().unwrap_or(0);
                // Canonical hash of our tip, read from the store — the height→hash RAM cache is gone,
                // and a vote must carry the hash we actually hold, not a cached guess.
                let tip_h = if tip > 0 {
                    s.canonical_hash_at(tip).unwrap_or([0u8; 32])
                } else { [0u8; 32] };
                (qc_idx, qc_hash, tip, tip_h)
            }
            None => (0, [0u8; 32], 0, [0u8; 32]),
        };

        let vote_msg = crate::unified_p2p::timeout_vote_message(
            mb_index, next_round, &anchor, high_qc_idx, &high_qc_hash, tip_height, &tip_hash);

        let crypto = match try_get_quantum_crypto() {
            Some(c) => c,
            None => {
                if is_warn() {
                    println!("[WARN][MB-VIEW] no_crypto mb={} round={}", mb_index, next_round);
                }
                return false;
            }
        };
        match crypto.create_consensus_signature(node_id, &vote_msg).await {
            Ok(sig) => {
                if is_info() {
                    println!("[INFO][MB-VIEW] view_change_vote mb={} round={} cert_was={} tip={}",
                             mb_index, next_round, current_cert, tip_height);
                }
                p2p.broadcast_timeout_vote(
                    mb_index,
                    next_round,
                    anchor,
                    high_qc_idx,
                    high_qc_hash,
                    tip_height,
                    tip_hash,
                    sig.signature.as_bytes().to_vec(),
                );
                true
            }
            Err(e) => {
                if is_warn() {
                    println!("[WARN][MB-VIEW] sign_fail mb={} round={} err={}",
                             mb_index, next_round, e);
                }
                false
            }
        }
    }

    // Helper methods for production microblocks
    
    /// v3.11: Calculate real Merkle root using qnet-core implementation
    /// Enables trustless transaction proofs for Light clients and cross-shard verification
    pub(crate) fn calculate_merkle_root(txs: &[qnet_state::Transaction]) -> [u8; 32] {
        if txs.is_empty() {
            // Return hash of empty for empty block (consistent with merkle.rs)
            let hasher = Sha3_256::new();
            let result = hasher.finalize();
            let mut hash = [0u8; 32];
            hash.copy_from_slice(&result);
            return hash;
        }
        
        // v3.11: Use real Merkle tree from qnet-core
        // This enables generate_merkle_proof() and verify_merkle_proof() for Light clients
        use qnet_core::crypto::merkle::compute_merkle_root;
        
        let tx_hashes: Vec<String> = txs.iter()
            .map(|tx| tx.hash.clone())
            .collect();
        
        match compute_merkle_root(&tx_hashes) {
            Ok(root_hex) => {
                // Convert hex string to [u8; 32]
                match hex::decode(&root_hex) {
                    Ok(bytes) if bytes.len() == 32 => {
                        let mut hash = [0u8; 32];
                        hash.copy_from_slice(&bytes);
                        hash
                    }
                    _ => {
                        // FIX L-L3: Log fallback instead of silently degrading
                        println!("[WARN][CRYPTO] merkle_root_fallback reason=hex_decode_failed root_hex_len={}", root_hex.len());
                        let mut hasher = Sha3_256::new();
                        hasher.update(root_hex.as_bytes());
                        let result = hasher.finalize();
                        let mut hash = [0u8; 32];
                        hash.copy_from_slice(&result);
                        hash
                    }
                }
            }
            Err(e) => {
                // v3.11: Log error and fallback to simple hash (should not happen in production)
                eprintln!("[ERR][MERKLE] compute_merkle_root_fail txs={} err={}", txs.len(), e);
                let mut hasher = Sha3_256::new();
                for tx in txs {
                    hasher.update(tx.hash.as_bytes());
                }
                let result = hasher.finalize();
                let mut hash = [0u8; 32];
                hash.copy_from_slice(&result);
                hash
            }
        }
    }
    
    /// PRODUCTION: Normalize node ID for consistent signature validation
    pub(super) fn normalize_node_id(node_id: &str) -> String {
        // CRITICAL: Ensure consistent node_id format for signature validation
        if node_id.contains(":") {
            // Convert IP:port format to underscore format
            node_id.replace(":", "_").replace(".", "_")
        } else {
            // Already in correct format
            node_id.to_string()
        }
    }
    
    /// PRODUCTION: Sign microblock with PQ cryptography (ML-DSA-65, compact signatures)
    // ═══════════════════════════════════════════════════════════════════
    // v4.0: PRODUCTION — Pure ML-DSA-65 Block Signing
    // No PqCrypto, no Ed25519, no certificates
    // Uses WalletIdentity from QNET_WALLET_SEED (detached_sign)
    // Signature: ~3309 bytes (ML-DSA-65 NIST FIPS 204 Level 3)
    // ═══════════════════════════════════════════════════════════════════
    pub(super) async fn sign_microblock_with_dilithium(
        microblock: &qnet_state::MicroBlock,
        _node_id: &str,
        _unified_p2p: Option<&Arc<SimplifiedP2P>>
    ) -> Result<Vec<u8>, String> {

        // ═══════════════════════════════════════════════════════════════════
        // v23.1: SIGNED PAYLOAD INCLUDES `timeout_round` (consensus binding)
        // ═══════════════════════════════════════════════════════════════════
        // Per the canonical BFT-PoS invariant ("every consensus-relevant
        // field MUST be cryptographically bound to the block"), the
        // BFT-certified rotation round embedded in the microblock is now
        // part of the ML-DSA-65 signature input. Without this, a network
        // peer-relay could mutate `timeout_round` in transit and the
        // signature would still verify against the unsigned remainder —
        // allowing an attacker to manipulate downstream baseline tracking
        // (`record_finalized_round`) and leader-selection state on
        // subsequent heights without any producer cooperation.
        //
        // The signing-payload version tag is bumped to "v23.1" to reflect
        // the format change. Existing peers running v23 or earlier will
        // fail signature verification on blocks signed with the new format
        // — this is intentional: a clean network restart is the supported
        // upgrade path for this consensus-rule change.
        // ═══════════════════════════════════════════════════════════════════

        // Create deterministic message hash (same on all nodes for verification)
        let mut hasher = Sha3_256::new();
        hasher.update(b"Block_Sig_v23.1");
        hasher.update(&microblock.height.to_be_bytes());
        hasher.update(&microblock.timestamp.to_be_bytes());
        hasher.update(&microblock.merkle_root);
        hasher.update(&microblock.previous_hash);
        hasher.update(&microblock.state_root);
        hasher.update(microblock.producer.as_bytes());
        if let Some(ref vrf_out) = microblock.vrf_output {
            hasher.update(vrf_out);
        }
        // v23.1: bind timeout_round to the signed digest.
        hasher.update(&microblock.timeout_round.to_be_bytes());
        // v23.2: bind carried_baseline too. abs_round = timeout_round + carried_baseline, so the
        // baseline half is equally consensus-relevant — leaving it unsigned would let a peer-relay
        // mutate it in transit (signature still verifies against the unsigned remainder) and poison
        // record_finalized_round / fork-choice, re-opening the exact malleability v23.1 closed.
        hasher.update(&microblock.carried_baseline.to_be_bytes());
        // Blocker-3: bind the WIRE pk-presence of this block's txs so a relay cannot strip/add a first-use
        // pk (block hash unchanged, pk elided from the tx preimage) without breaking this signature.
        hasher.update(&microblock_pk_digest(&microblock.transactions));
        let message_hash = hasher.finalize();

        // Sign with VRF instance (ML-DSA-65 detached signature)
        // VRF instance holds the persistent keypair loaded from DilithiumKeyManager at startup
        let global_vrf = GLOBAL_VRF_INSTANCE.lock();
        
        let vrf_ref = global_vrf.as_ref()
            .ok_or("[ERR][SIGN] VRF not initialized — QNET_WALLET_SEED required")?;
        
        // Use VRF's evaluate to get a signed proof, then extract just the signature
        // Alternatively: sign directly using the VRF's stored secret key
        let sk_bytes = vrf_ref.get_secret_key_bytes()
            .ok_or("[ERR][SIGN] VRF secret key not available")?;
        
        use pqcrypto_mldsa::mldsa65 as dilithium3;
        use pqcrypto_traits::sign::{
            SecretKey as SkTrait,
            DetachedSignature as SigTrait,
        };
        
        let sk = dilithium3::SecretKey::from_bytes(&sk_bytes)
            .map_err(|e| format!("[ERR][SIGN] sk_parse err={:?}", e))?;
        let sig = dilithium3::detached_sign(message_hash.as_ref(), &sk);
        let sig_bytes = SigTrait::as_bytes(&sig).to_vec();
        
        // Prefix: "dilithium3_v4:" + hex(signature)
        let sig_hex = hex::encode(&sig_bytes);
        let prefixed = format!("dilithium3_v4:{}", sig_hex);
        
        if microblock.height % ROTATION_INTERVAL_BLOCKS == 1 {
            println!("[INFO][SIGN] h={} dilithium3=fips204 size={}", microblock.height, prefixed.len());
        }
        
        Ok(prefixed.as_bytes().to_vec())
    }
    
    /// PRODUCTION: Verify PQ (ML-DSA-65) signature for received microblock (supports compact)
    pub async fn verify_microblock_signature(
        storage: &Storage,
        microblock: &qnet_state::MicroBlock, 
        _producer_pubkey: &str,
        p2p: Option<&Arc<SimplifiedP2P>>
    ) -> Result<bool, String> {
        
        // CRITICAL FIX: Genesis block uses deterministic hash, not the standard ML-DSA-65 format
        if microblock.height == 0 && microblock.producer == "genesis" {
            // Verify Genesis block signature deterministically
            let mut hasher = Sha3_256::new();
            hasher.update(b"GENESIS_BLOCK_QUANTUM_SIGNATURE");
            hasher.update(&microblock.height.to_le_bytes());
            hasher.update(&microblock.timestamp.to_le_bytes());
            hasher.update(&microblock.merkle_root);
            // v3.37: Include state_root in verification (must match creation)
            hasher.update(&microblock.state_root);
            hasher.update(b"qnet_genesis_block_2024");
            let expected_signature = hasher.finalize().to_vec();
            
            let is_valid = microblock.signature == expected_signature;
            if is_valid {
                println!("[INFO][CERT] genesis_sig_verified mode=deterministic");
            } else {
                println!("[ERR][CRYPTO] Genesis block signature mismatch!");
            }
            return Ok(is_valid);
        }
        
        // Convert signature bytes to string to check format
        let sig_str = match String::from_utf8(microblock.signature.clone()) {
            Ok(s) => s,
            Err(_) => {
                println!("[ERR][CRYPTO] Invalid signature format (not UTF-8)");
                return Ok(false);
            }
        };
        
        // ═══════════════════════════════════════════════════════════════════
        // v4.0: DILITHIUM3 DIRECT SIGNATURE (production format)
        // Format: "dilithium3_v4:{hex_signature}"
        // Verified against producer's registered VRF public key
        // ═══════════════════════════════════════════════════════════════════
        if sig_str.starts_with("dilithium3_v4:") {
            let sig_hex = &sig_str[14..]; // Skip "dilithium3_v4:" prefix
            let sig_bytes = match hex::decode(sig_hex) {
                Ok(b) => b,
                Err(e) => {
                    println!("[ERR][SIGN] hex_decode err={}", e);
                    return Ok(false);
                }
            };

            // Lookup producer's ML-DSA-65 public key (committed source, see producer_verify_pk)
            let pk = match crate::node::producer_verify_pk(storage, &microblock.producer) {
                Some(pk) => pk,
                None => {
                    // v4.6: Hard reject — ML-DSA-65 key MUST be registered
                    println!("[WARN][SIGN] no_pk_registered producer={} h={} — block REJECTED",
                             microblock.producer, microblock.height);
                    return Ok(false);
                }
            };

            // Recreate message hash (MUST match sign_microblock_with_dilithium).
            // v23.1: payload version tag is "Block_Sig_v23.1" and includes
            // `timeout_round` to bind consensus rotation state to the signature.
            let mut hasher2 = Sha3_256::new();
            hasher2.update(b"Block_Sig_v23.1");
            hasher2.update(&microblock.height.to_be_bytes());
            hasher2.update(&microblock.timestamp.to_be_bytes());
            hasher2.update(&microblock.merkle_root);
            hasher2.update(&microblock.previous_hash);
            hasher2.update(&microblock.state_root);
            hasher2.update(microblock.producer.as_bytes());
            if let Some(ref vrf_out) = microblock.vrf_output {
                hasher2.update(vrf_out);
            }
            // v23.1: bind timeout_round to the signed digest (matches signer).
            hasher2.update(&microblock.timeout_round.to_be_bytes());
            // v23.2: bind carried_baseline (matches signer) — see sign_microblock_with_dilithium.
            hasher2.update(&microblock.carried_baseline.to_be_bytes());
            // Blocker-3: bind the received block's WIRE pk-presence (matches signer). A tampered copy
            // (first-use pk stripped/added) recomputes a different digest ⇒ sig fails ⇒ rejected + re-fetched.
            hasher2.update(&microblock_pk_digest(&microblock.transactions));
            let msg_hash = hasher2.finalize();

            // Verify ML-DSA-65 detached signature
            use pqcrypto_mldsa::mldsa65 as dilithium3;
            use pqcrypto_traits::sign::{
                PublicKey as PkTrait,
                DetachedSignature as SigTrait2,
            };

            let d3_pk = match dilithium3::PublicKey::from_bytes(&pk) {
                Ok(p) => p,
                Err(e) => {
                    println!("[ERR][SIGN] pk_parse err={:?}", e);
                    return Ok(false);
                }
            };
            let d3_sig = match dilithium3::DetachedSignature::from_bytes(&sig_bytes) {
                Ok(s) => s,
                Err(e) => {
                    println!("[ERR][SIGN] sig_parse err={:?}", e);
                    return Ok(false);
                }
            };

            let valid = dilithium3::verify_detached_signature(&d3_sig, msg_hash.as_ref(), &d3_pk).is_ok();
            if valid {
                if microblock.height % 100 == 0 {
                    println!("[INFO][SIGN] verified h={} dilithium3=fips204", microblock.height);
                }
            } else {
                println!("[ERR][SIGN] dilithium3_invalid h={} producer={}", microblock.height, microblock.producer);
                return Ok(false);
            }

            // No vrf_output check here, and none is needed: the window beacon folds block hashes, so
            // the field feeds nothing in consensus and MicroBlock::hash() leaves it out.
            return Ok(true);
        }

        // Legacy: compact_bin / compact signature formats (for pre-v4 blocks)
        use base64::{Engine as _, engine::general_purpose};
        let compact_sig: crate::pq_crypto::CompactPqSignature = if sig_str.starts_with("compact_bin:") {
            // v2.24: Parse binary compact signature (bincode+zstd+base64)
            let base64_data = &sig_str[12..]; // Skip "compact_bin:" prefix
            let binary_data = match general_purpose::STANDARD.decode(base64_data) {
                Ok(data) => data,
                Err(e) => {
                    println!("[ERR][CRYPTO] Failed to decode compact_bin base64: {}", e);
                    return Ok(false);
                }
            };
            match crate::pq_crypto::CompactPqSignature::from_binary_compressed(&binary_data) {
                Ok(sig) => sig,
                Err(e) => {
                    println!("[ERR][CRYPTO] Failed to parse compact_bin signature: {}", e);
                    return Ok(false);
                }
            }
        } else if sig_str.starts_with("compact:") {
            // Legacy: Parse compact signature JSON
            let sig_json = &sig_str[8..]; // Skip "compact:" prefix
            match serde_json::from_str(sig_json) {
                Ok(sig) => sig,
                Err(e) => {
                    println!("[ERR][CRYPTO] Failed to parse compact JSON signature: {}", e);
                    return Ok(false);
                }
            }
        } else {
            // Not a recognized signature format - reject
            println!("[ERR][CRYPTO] Unknown signature format: {}", qnet_state::char_prefix(&sig_str, 20));
            return Ok(false);
        };
        
        // Verify node_id matches
        if compact_sig.node_id != microblock.producer {
            println!("[ERR][CRYPTO] Node ID mismatch in signature: {} != {}", 
                     compact_sig.node_id, microblock.producer);
            return Ok(false);
        }
        
        // Recreate message hash for verification
        let mut hasher = Sha3_256::new();
        hasher.update(&microblock.height.to_be_bytes());
        hasher.update(&microblock.timestamp.to_be_bytes());
        hasher.update(&microblock.merkle_root);
        hasher.update(&microblock.previous_hash);
        hasher.update(microblock.producer.as_bytes());
        let message_hash_str = hex::encode(hasher.finalize());
        
        // PRODUCTION: REAL cryptographic verification for post-quantum blockchain (pure ML-DSA-65)

        // STEP 1: Get certificate from P2P cache (cache-trusted, Dilithium-verified at admission)
        println!("[INFO][CERT] compact_sig_verify h={}", microblock.height);

        // STEP 2: Validate the certificate binds to this producer and is unexpired
        use crate::pq_crypto::PqCertificate;
        
        // Get certificate from P2P cache
        // v2.96: CRITICAL FIX - minimize lock holding time!
        // Get cert data and IMMEDIATELY release lock before any heavy operations
        let ed25519_verified = if let Some(p2p_ref) = p2p {
            // Step 1: Get certificate with minimal lock time
            let cert_data_option = {
                let mut cert_manager = p2p_ref.certificate_manager.write();
                cert_manager.get_and_mark_used(&compact_sig.cert_serial)
                // Lock released here - BEFORE any heavy processing!
            };
            
            if let Some(cert_data) = cert_data_option {
                
                // Deserialize certificate
                if let Ok(certificate) = bincode::deserialize::<PqCertificate>(&cert_data) {
                    // Verify certificate belongs to the producer
                    if certificate.node_id != compact_sig.node_id {
                        println!("[ERR][CRYPTO] Certificate node_id mismatch: {} != {}", 
                                 certificate.node_id, compact_sig.node_id);
                        false
                    } else if certificate.node_id != microblock.producer {
                        println!("[ERR][CRYPTO] Certificate doesn't belong to block producer: {} != {}", 
                                 certificate.node_id, microblock.producer);
                        false
                    } else {
                        // Check certificate expiration with GRACE PERIOD
                        // CRITICAL: Allow 60 second grace period for network propagation delays
                        // Blocks signed just before certificate expiry should still be valid
                        const CERTIFICATE_VERIFICATION_GRACE_SECS: u64 = 60;
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        let expires_with_grace = certificate.expires_at + CERTIFICATE_VERIFICATION_GRACE_SECS;
                        
                        // v2.44: Skip expiry check for historical blocks ONLY during sync
                        // SECURITY: Both conditions required for L1 production safety
                        // 1. Block must be old (>5 minutes) - prevents fake timestamp attack
                        // 2. Node must be in sync mode - prevents abuse during live production
                        let block_age = now.saturating_sub(microblock.timestamp);
                        let is_historical = block_age > 300; // Blocks older than 5 minutes
                        let is_sync_mode = coordinator_is_syncing();
                        let skip_expiry_for_sync = is_historical && is_sync_mode;
                        
                        if !skip_expiry_for_sync && now > expires_with_grace {
                            println!("[ERR][CRYPTO] Certificate expired at {} (with 60s grace), now is {}", 
                                     expires_with_grace, now);
                            false
                        } else {
                            if skip_expiry_for_sync && now > expires_with_grace {
                                println!("[INFO][CRYPTO] Skipping expiry check for sync block (age={}s, sync=true)", block_age);
                            }
                            // Pure ML-DSA-65 (P8): the certificate is cache-trusted (Dilithium-verified
                            // at admission); message authenticity is proven by the Dilithium key
                            // signature in STEP 3 below.
                            println!("[INFO][CERT] cert_valid serial={} producer={}",
                                     certificate.serial_number, certificate.node_id);
                            true
                        }
                    }
                } else {
                    println!("[WARN][CRYPTO] Failed to deserialize certificate for {}", compact_sig.cert_serial);
                    // Byzantine consensus will catch this if majority of nodes fail
                    false
                }
            } else {
                println!("[WARN][CRYPTO] Certificate {} not found in RAM cache", compact_sig.cert_serial);
                
                // ═══════════════════════════════════════════════════════════════════
                // v4.0: ML-DSA-65-VRF proof verification (replaces PqCrypto cert)
                // vrf_proof contains ML-DSA-65 detached signature (~3309 bytes)
                // Verified against producer's registered VRF public key
                // ═══════════════════════════════════════════════════════════════════
                // vrf_proof is no longer a validity input: the beacon folds block hashes, so the field
                // carries no consensus information and gating on it was a fork surface for nothing.
                {
                    // No vrf_proof - request from online producer (legacy fallback)
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or(Duration::from_secs(0))
                        .as_secs();
                    
                    // DDoS PROTECTION: Check if we already requested this certificate recently
                    // v2.96: Lock-free with DashMap
                    let should_request = {
                        if let Some(last_request) = REQUESTED_CERTIFICATES.get(&compact_sig.cert_serial) {
                            now - *last_request >= 5
                        } else {
                            REQUESTED_CERTIFICATES.insert(compact_sig.cert_serial.clone(), now);
                            true
                        }
                    };
                    
                    if should_request {
                        if let Some(_producer_addr) = p2p_ref.get_peer_address(&compact_sig.node_id) {
                            let p2p_clone = p2p_ref.clone();
                            let cert_serial = compact_sig.cert_serial.clone();
                            let producer_id = compact_sig.node_id.clone();
                            // Random delay (0-500ms) to prevent thundering herd on producer
                            let delay_ms = (now % 500) as u64;
                            tokio::spawn(async move {
                                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                                p2p_clone.request_certificate(&producer_id, &cert_serial);
                                println!("[INFO][CERT] cert_requested serial={} from={}", cert_serial, producer_id);
                            });
                        }
                    }
                    
                    println!("[WARN][CRYPTO] Block buffered - waiting for certificate from producer");
                    false
                }
            }
        } else {
            println!("[WARN][CRYPTO] No P2P instance available for certificate verification");
            false // Conservative: reject if we can't verify against a certificate
        };
        
        if !ed25519_verified {
            return Ok(false);
        }
        
        // STEP 3: Verify Dilithium signatures (quantum-resistant, MANDATORY per NIST/Cisco)
        // NIST/Cisco requirement: Verify BOTH Dilithium signatures
        // 1. Dilithium signature of encapsulated_data (ephemeral key)
        // 2. Dilithium signature of message
        // PRODUCTION v2.51: Safe quantum crypto access
        use crate::quantum_crypto::DilithiumSignature;
        let crypto = match try_get_quantum_crypto() {
            Some(c) => c,
            None => {
                println!("[ERR][CRYPTO] Quantum crypto not initialized");
                return Ok(false);
            }
        };
        
        // SECURITY: Dilithium key signature is MANDATORY - no bypass!
        // OPTIMIZED v2.23: RAW bytes format
        if compact_sig.dilithium_key_signature.is_empty() {
            println!("[ERR][CRYPTO] REJECTED: No Dilithium key signature - quantum attack possible!");
            return Ok(false);
        }
        
        // Verify Dilithium signature of the re-rooted preimage (message_hash || timestamp).
        // Proves message integrity (message_hash inside) and freshness (timestamp inside).
        let message_hash_bytes = hex::decode(&message_hash_str)
            .map_err(|_| "Invalid hex in message hash")?;
        let mut encapsulated_data = Vec::new();
        encapsulated_data.extend_from_slice(&message_hash_bytes);
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
                println!("[INFO][CERT] sig_verified algo=dilithium producer={} serial={} pq=compliant",
                         compact_sig.node_id, compact_sig.cert_serial);
                return Ok(true);
            }
            Ok(false) => {
                println!("[ERR][CRYPTO] Dilithium key signature INVALID!");
                return Ok(false);
            }
            Err(e) => {
                println!("[ERR][CRYPTO] Dilithium verification error: {}", e);
                // SECURITY: NO BYPASS - Dilithium verification is MANDATORY
                Ok(false)
            }
        }
    }
    
    pub(super) async fn get_previous_microblock_hash(
        storage: &Arc<Storage>,
        current_height: u64,
    ) -> [u8; 32] {
        // Genesis block has no previous
        if current_height == 0 {
            return [0u8; 32];
        }

        let prev_h = current_height.saturating_sub(1);

        // v12.0: CRITICAL FIX — Use MicroBlock::hash() for ALL blocks.
        //
        // Previous code used SHA3_256(raw_storage_bytes) which hashes the serialized
        // blob (EfficientMicroBlock + zstd compression). But block_pipeline verify
        // uses MicroBlock::hash() which hashes 5 struct fields. These are completely
        // different values → hash_chain_break on every block.
        //
        // Production L1 rule: block hash = hash of block CONTENT (fields), not
        // hash of storage representation (bytes). Storage format can change
        // (compression, efficient format) without affecting consensus.

        // Fast path: O(1) hash index (pre-computed by save path)
        if let Ok(Some(indexed_hash)) = storage.load_microblock_hash(prev_h) {
            return indexed_hash;
        }

        // Slow path: deserialize block and compute hash from struct fields
        let storage_clone = storage.clone();
        let load_result = tokio::task::spawn_blocking(move || {
            storage_clone.load_microblock_auto_format(prev_h)
        }).await;

        match load_result {
            Ok(Ok(Some(block))) => {
                let hash = block.hash();

                // Backfill hash index for future O(1) lookups
                if let Err(e) = storage.save_microblock_hash(prev_h, &hash) {
                    if crate::node::is_warn() {
                        println!("[WARN][STORAGE] hash_index_backfill_failed h={} err={}", prev_h, e);
                    }
                }

                hash
            }
            _ => {
                if prev_h == 0 {
                    println!("[CRIT][GEN] genesis_not_found_for_block_1 — cannot produce");
                } else {
                    println!("[WARN][PROD] prev_block_unavailable h={} need={}", current_height, prev_h);
                }
                [0u8; 32]
            }
        }
    }
    
    pub(super) fn validate_microblock_production(microblock: &qnet_state::MicroBlock) -> Result<(), String> {
        // Production validation checks
        
        // Allow height 0 for Genesis Block
        if microblock.height == 0 && microblock.producer != "genesis" {
            return Err("Invalid height: only genesis producer can create block 0".to_string());
        }
        
        if microblock.timestamp == 0 {
            return Err("Invalid timestamp".to_string());
        }
        
        if microblock.producer.is_empty() {
            return Err("Producer cannot be empty".to_string());
        }
        
        if microblock.transactions.len() > 200000 {
            return Err(format!("Too many transactions: {} (max: 200000)", microblock.transactions.len()));
        }
        
        // block_ts is slot-deterministic (genesis_ts + height*SLOT), enforced on
        // ingest; no producer-side future check needed.
        Ok(())
    }
    
    pub(super) fn compress_microblock_data(microblock: &qnet_state::MicroBlock) -> Result<Vec<u8>, String> {
        let serialized = bincode::serialize(microblock)
            .map_err(|e| format!("Serialization error: {}", e))?;
        
        // For new blocks, use light compression (they're hot data)
        // They will be recompressed later with stronger levels as they age
        // OPTIMIZATION: Use level 1 for fastest compression (still good ratio)
        let compressed = zstd::encode_all(&serialized[..], 1) // Level 1 for speed
            .map_err(|e| format!("Zstd compression error: {}", e))?;
        
        // Only use compression if it actually reduces size significantly
        if compressed.len() < ((serialized.len() as f64) * 0.9) as usize { // At least 10% reduction
            println!("[DBG][MB] zstd_compressed before={} after={} reduction={:.1}%",
                    serialized.len(), compressed.len(),
                    (1.0 - compressed.len() as f64 / serialized.len() as f64) * 100.0);
            Ok(compressed)
        } else {
            println!("[DBG][MB] zstd_skipped reason=insufficient_reduction");
            Ok(serialized)
        }
    }
    pub(super) async fn log_performance_metrics(
        microblock_height: u64,
        mempool: &Arc<qnet_mempool::SimpleMempool>,
    ) {
        // v2.26: Direct access - SimpleMempool is already thread-safe
        let mempool_size = mempool.size();
        let blocks_per_minute = 60; // Approximate for 1s intervals
        let estimated_tps = blocks_per_minute * 5000; // Assuming 5k tx per block average
        
        println!("[DBG][NODE] perf_metrics block={} mempool={} tps={} mb_since_macro={}", microblock_height, mempool_size, estimated_tps, microblock_height % 90);

        if estimated_tps > 200000 {
            println!("[INFO][NODE] high_perf_mode tps={}", estimated_tps);
        }
    }
}

/// Marks the intra boundary currently being derived, cleared on every exit path. The cursor advances
/// only when a derivation succeeds, so without this a transient defer would re-spawn the derivation
/// on each applied block.
pub(super) struct IntraInflight(pub(super) std::sync::Arc<std::sync::atomic::AtomicU64>);

impl Drop for IntraInflight {
    fn drop(&mut self) { self.0.store(0, std::sync::atomic::Ordering::Relaxed); }
}

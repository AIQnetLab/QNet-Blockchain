//! Leader election, producer rotation, frozen roster and attestation committee.

use super::*;

impl BlockchainNode {
    /// PRODUCTION: Get consistent Genesis node ID from BOOTSTRAP_ID or IP mapping
    /// Unifies all Genesis node ID detection across the codebase
    #[allow(dead_code)]
    pub(super) fn get_genesis_node_id(node_identifier: &str) -> Option<String> {
        // Method 1: Direct BOOTSTRAP_ID environment variable (for local node only)
        if node_identifier.is_empty() {
            if let Ok(bootstrap_id) = std::env::var("QNET_BOOTSTRAP_ID") {
                if ["001", "002", "003", "004", "005"].contains(&bootstrap_id.as_str()) {
                    return Some(format!("genesis_node_{}", bootstrap_id));
                }
            }
        }
        
        // Method 2: IP-to-Genesis mapping for peer identification (CRITICAL FIX)
        let clean_ip = if node_identifier.contains(':') {
            node_identifier.split(':').next().unwrap_or(node_identifier)
        } else {
            node_identifier
        };
        
        if let Some(genesis_id) = crate::genesis_constants::get_genesis_id_by_ip(clean_ip) {
            return Some(format!("genesis_node_{}", genesis_id));
        }
        
        // Method 3: Already formatted genesis_node_XXX
        if node_identifier.starts_with("genesis_node_") {
            return Some(node_identifier.to_string());
        }
        
        None // Not a Genesis node
    }

    /// PRODUCTION: Initialize only ACTIVE Genesis node reputations discovered via P2P
    /// Prevents phantom candidates for unoperated Genesis nodes
    pub(super) async fn initialize_genesis_reputations(p2p: &SimplifiedP2P) {
        println!("[INFO][NODE] genesis_reputation_init");
        
        // CRITICAL FIX: Load saved reputations from storage for all Genesis nodes
        // This ensures reputation persists across restarts
        for i in 1..=5 {
            let genesis_id = format!("genesis_node_{:03}", i);
            
            // Try to load saved reputation first
            if let Some(saved_reputation) = p2p.load_reputation_from_storage(&genesis_id) {
                p2p.set_node_reputation(&genesis_id, saved_reputation);
                println!("[INFO][NODE] reputation_loaded node={} rep={:.1}", genesis_id, saved_reputation);
            } else {
                // If no saved reputation, initialize to INITIAL_REPUTATION
                use qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
                p2p.set_node_reputation(&genesis_id, INITIAL_REPUTATION);
                println!("[INFO][NODE] reputation_default node={} rep={:.1}", genesis_id, INITIAL_REPUTATION);
            }
        }
        
        // PRODUCTION: Only initialize reputation for own Genesis node, not all 5 preemptively
        // Other Genesis nodes get reputation dynamically when they actually connect via P2P
        // This prevents "phantom reputation" for nodes that haven't started yet
        
        if let Ok(bootstrap_id) = std::env::var("QNET_BOOTSTRAP_ID") {
            match bootstrap_id.as_str() {
                "001" | "002" | "003" | "004" | "005" => {
                    let own_genesis_id = format!("genesis_node_{}", bootstrap_id);
                    // Check if we need to update own reputation
                    use qnet_consensus::deterministic_reputation::INITIAL_REPUTATION;
                    if p2p.load_reputation_from_storage(&own_genesis_id).is_none() {
                        p2p.set_node_reputation(&own_genesis_id, INITIAL_REPUTATION);
                        println!("[INFO][NODE] own_reputation_init node={} rep={:.0}", own_genesis_id, INITIAL_REPUTATION);
                    }
                }
                _ => {
                    println!("[WARN][NODE] invalid_bootstrap_id id={}", bootstrap_id);
                }
            }
        } else {
            println!("[INFO][NODE] reputation_source=p2p_discovery non_genesis=true");
        }
        
        println!("[INFO][NODE] genesis_reputation_init_complete");
    }
    
    // wait_for_round_change_ready_quorum (v16.2 pre-production ack handshake)
    // removed: redundant with VRF-unique certified-round producer + n−f
    // macroblock finality, and its n−f/800ms barrier was the liveness stall.
    // Dormant ProducerReady/ReadyAck receive plumbing remains (no sender now).

    pub async fn select_microblock_producer(
        current_height: u64,
        unified_p2p: &Option<Arc<SimplifiedP2P>>,
        own_node_id: &str,
        own_node_type: NodeType,
        storage: Option<&Arc<Storage>>,
    ) -> String {
        // v3.8: Wrapper that calls internal function with timeout_round=0 (normal selection)
        Self::select_microblock_producer_with_round(
            current_height, unified_p2p, own_node_id, own_node_type, storage, 0
        ).await
    }
    
    /// v3.8: Internal producer selection with timeout_round support
    /// timeout_round=0: Normal selection
    /// timeout_round=1+: Exclude producers who failed in previous rounds
    pub async fn select_microblock_producer_with_round(
        current_height: u64,
        unified_p2p: &Option<Arc<SimplifiedP2P>>,
        own_node_id: &str,
        own_node_type: NodeType,
        storage: Option<&Arc<Storage>>,
        timeout_round: u64,
    ) -> String {
        // PRODUCTION: deterministic PUBLIC leader election — leader = hash(N-2 macroblock seed ‖ round) % N.
        // NOT secret: the leader is publicly computable ~2 windows ahead. Liveness under targeting is
        // covered by TimeoutCertificate failover, not by hiding the leader (see consensus design notes).
        // Each 30-block period uses VRF to elect producer from qualified candidates
        
        if let Some(p2p) = unified_p2p {
            // PERFORMANCE FIX: Cache producer selection for entire 30-block period to prevent HTTP spam
            // Producer is SAME for all blocks in rotation period (blocks 1-30, 31-60, etc.)
            let rotation_interval = ROTATION_INTERVAL_BLOCKS;
            // Rotation round: the first interval is round 0, then (height-1)/interval. Every term
            // reads ROTATION_INTERVAL_BLOCKS — a literal beside it would elect a different leader
            // the moment the constant moves.
            let leadership_round = if current_height == 0 {
                0  // Genesis is outside the rotation
            } else if current_height <= rotation_interval {
                0
            } else {
                (current_height - 1) / rotation_interval
            };
            
            // CRITICAL: Use shared module-level cache to prevent duplication
            // v2.96: Lock-free DashMap for hot path performance
            use producer_cache::CACHED_PRODUCER_SELECTION;
            
            // A cached selection is only sound once this node holds every block of the PREVIOUS
            // round: the selection reads that round's chain state, so caching it while still behind
            // would pin a producer the rest of the network never elected.
            let mut can_use_cache = if leadership_round == 0 {
                true  // Round 0 is always deterministic, cache is safe
            } else if let Some(store) = storage {
                // CONSERVATIVE: Wait for FULL round completion before using cache
                // This ensures all nodes have processed the entire previous round
                let required_block = match leadership_round {
                    1 => 30,  // Round 1: wait for block 30
                    2 => 60,  // Round 2: wait for block 60 (full Round 1 completion)
                    _ => leadership_round * ROTATION_INTERVAL_BLOCKS
                };
                let local_height = store.get_chain_height().unwrap_or(0);
                local_height >= required_block  // Only use cache if we have all required blocks
            } else {
                false  // No storage, can't verify - recalculate
            };
            
            // CRITICAL FIX: Clear cache at rotation boundaries to ensure new producer selection
            // This prevents using stale cached producer when entering new round
            // v4.0: Emergency producer removed - BFT Timeout Protocol handles failover
            // Cache clearing happens at rotation boundaries (normal operation)
            if current_height > 0 && (current_height - 1) % rotation_interval == 0 {
                // We're at a rotation boundary (blocks 31, 61, 91...)
                // Normal rotation - clear cache for new producer selection
                // v2.96: Lock-free remove with DashMap
                CACHED_PRODUCER_SELECTION.remove(&leadership_round);
                // Don't use cache for first block of new round
                can_use_cache = false;
            }
            
            // Check if we have cached result for this round
            // v5.3: Disable cache when timeout_round > 0 — timeout rotation changes producer
            // The cache stores round0 producer which is wrong for failover rotation
            if timeout_round > 0 {
                can_use_cache = false;
            }
            // v2.96: Lock-free cache lookup with DashMap
            if can_use_cache {
                if let Some(entry) = CACHED_PRODUCER_SELECTION.get(&leadership_round) {
                    let (cached_producer, _cached_candidates) = entry.value();
                    // EXISTING: Log only at rotation boundaries for performance
                    if current_height > 0 && ((current_height - 1) % rotation_interval == 0 || current_height == 1) {
                        if is_info() { println!("[INFO][PRODUCER] id={} round={} next_rot={}", cached_producer, leadership_round, (leadership_round + 1) * rotation_interval + 1); }
                    }
                    return cached_producer.clone();
                }
            } else {
                // CRITICAL: Clear cache for this round if we can't use it
                // v2.96: Lock-free remove
                CACHED_PRODUCER_SELECTION.remove(&leadership_round);
            }
            
            // Cache miss - need to calculate candidates (only once per 30-block period)
            // Cache miss - calculating new producer
            
            // PRODUCTION: Direct calculation for consensus determinism (THREAD-SAFE)
            // QNet requires consistent candidate lists across all nodes for Byzantine safety
            // CRITICAL: Now includes validator sampling for millions of nodes
            // v3.16: Pass current_height to ensure SAME epoch for entropy AND candidates!
            let candidates = Self::calculate_qualified_candidates(p2p, own_node_id, own_node_type, current_height).await;
            
            // VALIDATION: Filter out invalid fallback IDs from candidates
            let valid_candidates: Vec<(String, f64)> = candidates.into_iter()
                .filter(|(id, _)| {
                    // Reject fallback IDs that look like process IDs
                    if id.contains("_legacy_") || 
                       (id.starts_with("node_") && id.chars().filter(|c| c.is_ascii_digit()).count() > 8) {
                        if is_debug() { println!("[DBG][MB] filter_invalid id={}", id); }
                        false
                    } else {
                        true
                    }
                })
                .collect();
            
            // PRODUCTION v2.30 (RESTORED v2.48): Handle empty candidate list
            // Empty list means:
            // - Genesis epoch (height 1-180): Normal, use Genesis static list
            // - Epoch 3+ (height 181+): ERROR - macroblock missing, CANNOT produce!
            //
            // CRITICAL: v2.46 introduced fallback=genesis_deterministic here — REMOVED!
            //   That fallback caused nodes to independently produce macroblocks using
            //   potentially DIFFERENT genesis candidate lists → CONFIRMED FORK at h=45901.
            //   "OLD (BROKEN)" behavior was re-introduced — this patch restores v2.30 fix.
            let mut candidates = if valid_candidates.is_empty() {
                // Genesis epoch (height 1-180): Use Genesis static list
                // WHY 180? N-2 logic - MacroBlock #1 ready only at ~block 120
                if current_height <= 180 {
                    println!("[INFO][MB] genesis_epoch h={}", current_height);
                    let genesis_candidates = Self::get_genesis_candidates_with_real_reputation(p2p);
                    println!("[INFO][MB] genesis_producers={}", genesis_candidates.len());
                    genesis_candidates
                } else {
                    // CORRECT v2.30: Empty candidates = node is DESYNCHRONIZED.
                    // DO NOT fall back to genesis list — different nodes may have different
                    // genesis lists or reputation values → NON-DETERMINISTIC → FORK!
                    Vec::new()
                }
            } else {
                valid_candidates
            };
            
            // CRITICAL v2.30: NO FALLBACK FOR EMPTY CANDIDATES!
            // Empty candidates means node is DESYNCHRONIZED - it CANNOT participate!
            // 
            // OLD (BROKEN, re-introduced by v2.46): fallback to genesis candidates
            //   → DIFFERENT lists across nodes → FORK! (confirmed incident at mb=509)
            // CORRECT (v2.30, restored v2.48): return empty string → node excluded
            //
            // The SYNCHRONIZED nodes will continue producing blocks.
            // This node will sync via background task and rejoin later.
            if candidates.is_empty() && current_height > 180 {
                let required_epoch = (current_height - 1) / 90;
                eprintln!("[ERR][MB] desync mb={} h={} no_candidates action=excluded_from_production", required_epoch, current_height);
                
                // STATE MACHINE: Error state — recoverable via background sync
                set_node_state(NodeState::Error {
                    reason: format!("Desynchronized at height {} - mb={} missing, excluded from production", current_height, required_epoch),
                    recoverable: true,
                });
                
                // Return empty string = this node is EXCLUDED from producer selection
                // Network continues with synchronized nodes.
                return String::new();
            }
            
            // CRITICAL: Sort candidates to ensure deterministic ordering across ALL nodes
            // Different nodes may receive peers in different P2P discovery order
            // WITHOUT sorting: each node calculates DIFFERENT vrf_entropy → DIFFERENT producer (consensus failure!)
            // WITH sorting: all nodes calculate SAME vrf_entropy → SAME producer (consensus success!)
            // This is IDENTICAL to emergency selection (line 6841) and macroblock consensus (line 7595)
            candidates.sort_by(|a, b| a.0.cmp(&b.0));  // Sort by node_id alphabetically
            
            // PRODUCTION: deterministic PUBLIC leader election — leader = hash(N-2 macroblock seed ‖ round) % N.
        // NOT secret: the leader is publicly computable ~2 windows ahead. Liveness under targeting is
        // covered by TimeoutCertificate failover, not by hiding the leader (see consensus design notes).
            // Uses macroblock N-2 hash + leadership_round as VRF slot seed
            
            // Calculate deterministic entropy that ALL nodes will have (no waiting for blocks!)
            let vrf_entropy = {
                let mut hasher = Sha3_256::new();
                
                // Use ONLY data that ALL nodes have deterministically:
                // 1. Round number (all nodes know this)
                hasher.update(b"QNet_VRF_Round_Entropy_v1");
                hasher.update(&leadership_round.to_le_bytes());
                
                // 2. Candidate list (NOW SORTED for deterministic entropy)
                // CRITICAL: Use ONLY node_id, NOT reputation!
                // Reputation changes dynamically during runtime → non-deterministic entropy → forks!
                // Example: node_004 gets +2% reputation → different VRF entropy → different producer
                for (candidate_id, _reputation) in &candidates {
                    hasher.update(candidate_id.as_bytes());
                    // DO NOT use reputation in entropy - it changes during runtime!
                }
                
                // 3. FINALITY WINDOW: Use block that is FINALITY_WINDOW blocks old as entropy
                // CRITICAL: This ensures ALL synchronized nodes have same entropy source
                // Prevents race conditions and guarantees deterministic producer selection
                // PRODUCTION: 10 blocks (10 seconds) provides safe buffer for global network
                
            let entropy_source = if let Some(store) = storage {
                // FINALITY WINDOW IMPLEMENTATION for Byzantine safety
                // Using global constant for consistent behavior across all selection logic
                
                // CRITICAL FIX: For ENTIRE round 0 (blocks 1-30), use Genesis + leadership_round
                // This ensures ALL nodes have same entropy even if they haven't synced all blocks yet
                // Finality blocks (block height-10) may not exist on all nodes during round 0!
                let prev_hash = if leadership_round == 0 {
                    // ROUND 0 (blocks 1-30): Use Genesis + leadership_round
                    if log_block(current_height) {
                        if is_debug() { println!("[DBG][FINALITY] h={} genesis_entropy r={}", current_height, leadership_round); }
                    }
                    
                    match store.load_microblock(0) {
                        Ok(Some(genesis_data)) => {
                            // Mix Genesis hash with leadership_round for deterministic selection
                            // CRITICAL: All nodes in same round get SAME entropy regardless of local height
                            let mut hasher = Sha3_256::new();
                            hasher.update(&genesis_data);
                            hasher.update(&leadership_round.to_le_bytes()); // Same for entire round!
                            let result = hasher.finalize();
                            let mut hash = [0u8; 32];
                            hash.copy_from_slice(&result);
                            Some(hash)
                        },
                        _ => {
                            // FATAL: Genesis must exist for network to function
                            println!("[CRIT][MB] genesis_missing cannot_select_producer=true");
                            println!("[CRIT][MB] network_halted reason=no_genesis");
                            None
                        }
                    }
                } else {
                    // Use MACROBLOCK N-2 hash for entropy, not a microblock:
                    // under a fork microblock[h-10] differs across nodes →
                    // different producer → fork persists. Macroblock N-2 is
                    // Byzantine-finalized and identical on every node (~90
                    // blocks old) → same entropy → no fork. N-2 not N-1
                    // because N-1 consensus only starts at (N-1)*90 and takes
                    // time, while block N*90+1 needs entropy immediately;
                    // N-2 guarantees a fully-ready macroblock. (Epochs 1-2 use
                    // genesis entropy; epoch N uses macroblock N-2.)
                    
                    let current_epoch = (current_height - 1) / 90 + 1;
                    let required_macroblock = current_epoch.saturating_sub(2);  // N-2 for safety!
                    
                    if required_macroblock == 0 {
                        // Epoch 1: No previous macroblock, use Genesis
                        if log_block(current_height) {
                            if is_debug() { println!("[DBG][FINALITY] h={} epoch=1 genesis_entropy", current_height); }
                        }
                        match store.load_microblock(0) {
                            Ok(Some(genesis_data)) => {
                                let mut hasher = Sha3_256::new();
                                hasher.update(&genesis_data);
                                let result = hasher.finalize();
                                let mut hash = [0u8; 32];
                                hash.copy_from_slice(&result);
                                Some(hash)
                            },
                            _ => {
                                if is_warn() {
                                    println!("[WARN][FINALITY] genesis_seed_unavailable h={} action=abstain",
                                             current_height);
                                }
                                None
                            }
                        }
                    } else {
                        // Epoch N >= 3: seed from the CHAIN, not from finality. The block at height
                        // (N-2)*90 sits 91..180 blocks below every height of epoch N, so a producer
                        // holding its contiguous chain always has it and the seed can never lag
                        // production — a finality stall slows finality, never the chain. The bytes
                        // are previous_hash-committed, so every node on one branch derives the same
                        // seed, and NOTHING node-local (seal prefix, roster arm) enters it — the
                        // h=272 different-arms fork cannot recur. At the healthy 31-59 finality gap
                        // the seed block is already certified; a deeper fork than the seed distance
                        // is bounded by the rollback floor and resolved by certified-round supersede.
                        let seed_h = required_macroblock.saturating_mul(
                            qnet_consensus::checkpoint_bft::MACROBLOCK_INTERVAL);
                        if log_block(current_height) {
                            if is_debug() { println!("[DBG][FINALITY] h={} ep={} seed_h={}", current_height, current_epoch, seed_h); }
                        }
                        let seed_hash = store.load_microblock_hash(seed_h).ok().flatten()
                            .or_else(|| store.load_microblock_auto_format(seed_h).ok().flatten()
                                .map(|b| b.hash()));
                        match seed_hash {
                            Some(bh) => {
                                let mut h = Sha3_256::new();
                                h.update(b"QNet_Chain_Entropy_v1");
                                h.update(&seed_h.to_le_bytes());
                                h.update(&bh);
                                let mut out = [0u8; 32];
                                out.copy_from_slice(&h.finalize());
                                Some(out)
                            }
                            // Absent only when the node lacks its own contiguous chain — abstain.
                            None => {
                                if is_warn() {
                                    println!("[WARN][FINALITY] entropy_unavailable seed_h={} h={} action=abstain",
                                             seed_h, current_height);
                                }
                                None
                            }
                        }
                    }
                };
                prev_hash
            } else {
                if is_warn() { println!("[WARN][VRF] no_storage h={} action=abstain", current_height); }
                None
            };
            
                // Absent seed ⇒ abstain, never elect from a default. A zero seed is a VALID-LOOKING
                // seed: it elects a leader that differs from the one nodes holding the real seed
                // compute, so both produce and the chain forks with no adversary present. Yielding
                // the slot is recoverable (TimeoutCertificate failover); a fork is not.
                let entropy_source = match entropy_source {
                    Some(seed) => seed,
                    None => return String::new(),
                };

                // Add finality window entropy (ONLY source for determinism!)
                hasher.update(&entropy_source);
                
                let result = hasher.finalize();
                let mut vrf_seed = [0u8; 32];
                vrf_seed.copy_from_slice(&result);
                vrf_seed
            };
            
            // Deterministic leader election (zero P2P, no claims/quorum):
            //   leader = candidates[SHA3-256(slot_seed ‖ height ‖ round ‖ timeout) % N]
            //   slot_seed = SHA3-256(macroblock_N-2_hash ‖ leadership_round)
            //   candidates = sorted N-2 eligible_producers snapshot
            //   timeout    = 0 normal, or BFT-certified failover round
            // All inputs on-chain → every synced node computes the same
            // leader (fork-resistant). Unpredictable (slot_seed binds the
            // macroblock hash, which includes VRF proofs); timeout failover
            // changes the hash; index collision → scan forward.
            
            if is_debug() { println!("[DBG][PROD] select round={} candidates={}", leadership_round, candidates.len()); }
            
            let selected_producer = if candidates.len() == 1 {
                // Single candidate — no VRF election needed
                if is_debug() { println!("[DBG][PROD] single={}", candidates[0].0); }
                candidates[0].0.clone()
            } else {
                use crate::crypto::vrf::DilithiumVrf;

                // Compute slot seed (same on all nodes — deterministic from macroblock)
                let mut slot_seed = [0u8; 32];
                slot_seed.copy_from_slice(&vrf_entropy);
                let slot_input = DilithiumVrf::compute_slot_seed(&slot_seed, leadership_round);

                // Deterministic leader election (restated): leader =
                // candidates[hash(slot_seed, height, round, timeout) % N],
                // all inputs on-chain. Timeout failover changes the hash;
                // index collision → scan forward. See the fuller note above.

                // v4.6 FIX: Use ROUND START HEIGHT (deterministic, identical on all nodes)
                // instead of current_height which varies depending on when cache miss occurs.
                // Round 0 → height 1, round 1 → height 31, round N → N*30+1
                let round_start_height =
                    if leadership_round == 0 { 1u64 }
                    else { leadership_round * ROTATION_INTERVAL_BLOCKS + 1 };

                let selected_idx = if timeout_round == 0 {
                    DilithiumVrf::deterministic_leader(
                        &slot_input, round_start_height, leadership_round, 0, candidates.len(),
                    )
                } else {
                    // v5.3: Direct modular rotation through ALL candidates
                    // Each timeout_round shifts the index by 1 from the previous.
                    // With N candidates: timeout 1→N-1 covers all others, then cycles.
                    // No exclusion sets, no collisions, no stalls.
                    // Dead node at any position is skipped within 6s (next timeout round).
                    //
                    // The candidate list is the N-2 eligible snapshot minus restart_excludes, and
                    // nothing else: every honest node starts from the same ordering and computes the
                    // same `(round0_idx + R) % N`. A runtime skip-forward over any locally-observed
                    // exclusion set would make selection node-dependent — that is a fork, not a filter.
                    let round0_idx = DilithiumVrf::deterministic_leader(
                        &slot_input, round_start_height, leadership_round, 0, candidates.len(),
                    );
                    (round0_idx + timeout_round as usize) % candidates.len()
                };

                let winner = &candidates[selected_idx].0;
                if is_info() {
                    let is_boundary = current_height > 0 &&
                        ((current_height - 1) % ROTATION_INTERVAL_BLOCKS == 0 || current_height == 1);
                    if is_boundary || timeout_round > 0 {
                        println!("[INFO][LEADER] deterministic h={} round={} timeout={} producer={} idx={}/{}",
                                 current_height, leadership_round, timeout_round, winner, selected_idx, candidates.len());
                    }
                }
                winner.clone()
            };
            
            
            // v4.5: Deterministic leader selection complete — all on-chain, zero P2P.
            // Empty string only if candidates are empty (node desynchronized).
            if selected_producer.is_empty() {
                if is_warn() {
                    println!("[WARN][VRF] no_producer h={} round={} timeout={} — BFT timeout will handle",
                             current_height, leadership_round, timeout_round);
                }
                // Return empty — main loop will detect and trigger timeout voting
                return selected_producer;
            }
            
            // PERFORMANCE FIX: Only cache for timeout_round=0 (normal selection)
            // Don't cache timeout rounds as they're height-specific
            if timeout_round == 0 {
                CACHED_PRODUCER_SELECTION.insert(leadership_round, (selected_producer.clone(), candidates.clone()));
                CACHED_PRODUCER_SELECTION.retain(|round, _| *round + 3 >= leadership_round);
            }
            
            let is_rotation_boundary = current_height > 0 && (current_height - 1) % rotation_interval == 0;
            
            // Log at rotation boundaries
            if is_rotation_boundary || current_height == 1 {
                let next_rotation_block = (leadership_round + 1) * rotation_interval + 1;
                if is_info() {
                    println!("[INFO][VRF] producer={} round={} timeout={} next_rotation={}", 
                             selected_producer, leadership_round, timeout_round, next_rotation_block);
                }
            }
            
            selected_producer
        } else {
            // Solo mode - no P2P peers
            println!("[INFO][VRF] solo_mode — self production");
            // Warning: P2P not available - running in solo mode
            own_node_id.to_string()
        }
    }


    /// Frozen horizon: how many windows past the last seal production continues on the frozen anchor
    /// before a node parks and syncs. Caps unfinalized depth (an unbounded tail is an unbounded reorg).
    /// 32 windows = 2880 blocks = ~48 minutes.
    pub(crate) const MAX_DERIVED_ROSTER_WINDOWS: usize = 32;

    /// Frozen-roster disposition for window `w`, from ONE atomic (L, B) read (A1 R1).
    /// L = newest contiguously-sealed macroblock; B = newest window known QC-certified (B >= L).
    ///  - Sealed: w-2 <= L          → sealed arm, verbatim.
    ///  - Defer:  w-2 > L, L < B     → a certified anchor exists but is not held → pull, never derive.
    ///  - Frozen: w-2 > L, L == B    → finality genuinely stalled → frozen arm (R4-R7).
    /// Pre-first-seal (L == 0) is never Frozen: there is no sealed anchor to freeze on.
    pub(crate) fn roster_mode(storage: &Storage, w: u64) -> RosterMode {
        let l = storage.last_sealed_mb_index();
        let b = (qc_verified_frontier_cached() / 90).max(l);
        // Sealed keys on L, the CONTIGUOUS prefix, and on nothing else. FAILOVER_COMMITTEE_CACHE is
        // memoized on (window, L) precisely because this answer moves only when L moves; keying Sealed
        // on the presence of w-2 as well would let the answer flip under a fixed key, serving a stale
        // frozen committee while sealed_anchor_for_window (uncached) already names the sealed anchor.
        if w.saturating_sub(2) <= l { RosterMode::Sealed }
        else if l < b { RosterMode::Defer }
        else if l >= 1 { RosterMode::Frozen }
        else { RosterMode::Defer }
    }

    /// M_A — the anchor a frozen window derives from: the newest sealed macroblock, descending the
    /// contiguous prefix from L, that carries a usable eligible set AND a beacon (R2.1). Bounded to the
    /// horizon so a run of unusable seals cannot become an unbounded scan. None ⇒ abstain (park).
    pub(crate) fn frozen_anchor(storage: &Storage, l: u64) -> Option<(u64, qnet_state::MacroBlock)> {
        let mut idx = l;
        for _ in 0..=Self::MAX_DERIVED_ROSTER_WINDOWS {
            if idx < 1 { return None; }
            if let Some(mb) = storage.get_macroblock_by_height(idx).ok().flatten()
                .and_then(Self::macroblock_plaintext)
                .and_then(|raw| bincode::deserialize::<qnet_state::MacroBlock>(&raw).ok())
            {
                let usable = mb.consensus_data.eligible_producers.as_ref()
                    .and_then(|x| bincode::deserialize::<Vec<qnet_state::EligibleProducer>>(x).ok())
                    .map(|v| v.iter().any(|p| !p.node_id.is_empty())).unwrap_or(false);
                if usable && mb.consensus_data.randomness_beacon.is_some() {
                    return Some((idx, mb));
                }
            }
            idx = idx.saturating_sub(1);
        }
        None
    }

    /// FrozenRoster: M_A's eligible set verbatim, empty ids dropped, canonically sorted — CONSTANT
    /// across the whole horizon (R4). The per-window committee is sampled from this fixed set.
    pub(crate) fn frozen_roster(anchor: &qnet_state::MacroBlock) -> Vec<qnet_state::EligibleProducer> {
        anchor.consensus_data.eligible_producers.as_ref()
            .and_then(|x| bincode::deserialize::<Vec<qnet_state::EligibleProducer>>(x).ok())
            .map(|mut v| { v.retain(|p| !p.node_id.is_empty()); v.sort_by(|a, b| a.node_id.cmp(&b.node_id)); v })
            .unwrap_or_default()
    }

    /// FrozenBeacon(w): committee-sampling seed during a freeze (R6). Folds ZERO post-seal bytes, so
    /// legal same-height failover siblings above the seal cannot poison it — immunity by construction.
    pub(crate) fn frozen_beacon(anchor: &qnet_state::MacroBlock, w: u64) -> [u8; 32] {
        let mut h = Sha3_256::new();
        h.update(b"QNET_FROZEN_BEACON_V1");
        h.update(anchor.consensus_data.randomness_beacon.unwrap_or([0u8; 32]));
        h.update(w.to_le_bytes());
        let mut out = [0u8; 32];
        out.copy_from_slice(&h.finalize());
        out
    }

    /// FrozenCommittee(w) = sample_committee(FrozenRoster, w, FrozenBeacon(w)) via the single canonical
    /// sampler (R7). At THRESHOLD=1000 with roster <=1000 this is the identity arm ⇒ == FrozenRoster.
    /// The barred set from an active restart manifest is filtered here so a restart-tail window derives
    /// a committee without the excluded identities even off a frozen anchor (restart GAP B).
    pub(crate) fn frozen_committee(anchor: &qnet_state::MacroBlock, w: u64) -> Vec<String> {
        let mut ids: Vec<String> = Self::frozen_roster(anchor).into_iter()
            .map(|p| p.node_id)
            .filter(|id| !crate::genesis_constants::restart_excludes(id))
            .collect();
        if ids.is_empty() { return Vec::new(); }
        ids.sort();
        qnet_consensus::checkpoint_bft::sample_committee(
            &ids, w, &Self::frozen_beacon(anchor, w),
            Self::COMMITTEE_THRESHOLD, Self::CONSENSUS_COMMITTEE_SIZE)
    }


    /// CRITICAL FIX: Invalidate producer cache during emergency failover
    /// This prevents the network from selecting failed producers repeatedly
    pub fn invalidate_producer_cache() {
        // v2.96: Lock-free cache clear with DashMap
        use producer_cache::CACHED_PRODUCER_SELECTION;
        
        let old_size = CACHED_PRODUCER_SELECTION.len();
        CACHED_PRODUCER_SELECTION.clear();
        println!("[INFO][CACHE] producer_cache_invalidated entries_cleared={}", old_size);
    }
    
    /// Get reputation score for a node
    /// ═══════════════════════════════════════════════════════════════════════════
    /// ARCHITECTURE v2.21: TRANSITIONAL - Uses legacy NodeReputation
    /// 
    /// TARGET ARCHITECTURE (DeterministicReputationState):
    /// - Reputation computed ONLY from blockchain data
    /// - +2% for completing 30-block rotation (in microblock)
    /// - +1% for participating in consensus (in macroblock)
    /// - Penalties via SlashingEvent with cryptographic proof
    /// - All nodes compute same result from same blocks = deterministic
    /// 
    /// PRODUCTION: Reputation from blockchain data only (DeterministicReputationState)
    /// - No P2P gossip vulnerabilities (Sybil-resistant)
    /// - All nodes compute same reputation from on-chain data
    /// - Genesis nodes start at 70% (MIN_CONSENSUS_REPUTATION)
    /// ═══════════════════════════════════════════════════════════════════════════
    pub async fn get_node_reputation_score(node_id: &str, _p2p: &Arc<SimplifiedP2P>) -> f64 {
        // ONE deterministic consensus reputation model — a pure function of the finalized
        // chain: {0.70 floor (eligible) | 0.0 if tombstoned}. A tombstone is a verified
        // equivocation proof anchored in a finalized macroblock's ban-set; it is permanent.
        // The per-node live engine (jail / passive-recovery / 0-100) is DISPLAY-only and is
        // never read on a consensus-adjacent path — branching on it diverges across nodes.
        use qnet_consensus::deterministic_reputation::MIN_CONSENSUS_REPUTATION;
        if let Some(storage) = try_get_storage() {
            let head = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                .load(std::sync::atomic::Ordering::Acquire);
            let mb_index = head / 90; // macroblock index covering the local head
            // Display/advisory only, so the cheap disk read is fine here: this path never feeds a
            // consensus verdict (the doc above says so).
            let window_head = mb_index.saturating_mul(90);
            if storage.load_account(node_id).ok().flatten()
                .map_or(false, |a| a.banned_at_height > 0 && a.banned_at_height <= window_head)
            {
                return 0.0; // tombstoned → excluded
            }
        }
        MIN_CONSENSUS_REPUTATION / 100.0
    }
    
    // REMOVED: is_light_node() function - now using REAL node type information
    // Light node detection now uses peer.node_type and own_node_type directly
    // This eliminates guessing and potential misclassification of Super nodes
    
    /// Helper: Get count of recent producer failures for deterministic exclusion
    /// ARCHITECTURE: Uses actual failover history from blockchain storage
    #[allow(dead_code)]
    pub(super) async fn get_recent_producer_failures(
        node_id: &str,
        current_height: u64,
        storage: &Arc<Storage>,
    ) -> usize {
        // Check last 30 blocks (one rotation period) for failures
        const CHECK_RANGE: u64 = 30;
        const FROM_HEIGHT: u64 = 0; // Start from beginning for deterministic history
        
        // Get failover history from storage (deterministic across all nodes)
        match storage.get_failover_history(FROM_HEIGHT, CHECK_RANGE as usize) {
            Ok(events) => {
                // Count how many times this node failed as producer in recent blocks
                let recent_failures = events.iter()
                    .filter(|event| {
                        // Check if this node was the failed producer
                        event.failed_producer == node_id &&
                        // Only count recent failures (within check range)
                        event.height + CHECK_RANGE >= current_height &&
                        event.height <= current_height
                    })
                    .count();
                
                if recent_failures > 0 {
                    println!("[INFO][MB] failover_history node={} failures={} window={}",
                            node_id, recent_failures, CHECK_RANGE);
                }
                
                recent_failures
            }
            Err(e) => {
                println!("[WARN][MB] failover_history_err err={}", e);
                // If we can't get history, assume node is OK (fail-open for availability)
                0
            }
        }
    }
    
    /// PRODUCTION: Validate producer readiness before block creation (Enterprise-grade checks)
    #[allow(dead_code)]
    pub(super) async fn validate_producer_readiness(
        node_id: &str,
        unified_p2p: &Option<Arc<SimplifiedP2P>>,
        block_height: u64,
    ) -> bool {
        // Check 1: Node reputation must be sufficient
        // SECURITY: Handle None case gracefully - if no P2P, assume not ready
        let p2p = match unified_p2p.as_ref() {
            Some(p2p) => p2p,
            None => {
                println!("[ERR][NODE] producer_readiness_failed reason=no_p2p");
                return false;
            }
        };
        let reputation_score = Self::get_node_reputation_score(node_id, p2p).await;
        if reputation_score < 0.70 {
            println!("[ERR][NODE] producer_readiness_failed rep={:.1} required=70", reputation_score * 100.0);
            return false;
        }
        
        // Check 2: Network connectivity assessment
        let active_peers = if let Some(p2p) = unified_p2p {
            p2p.get_peer_count() // EXISTING: Fast peer count, no expensive validation
        } else {
            0
        };
        
        if active_peers < 3 {
            println!("[WARN][NODE] producer_readiness_limited peers={} optimal=3", active_peers);
            // Still allow production in low-peer scenarios for network bootstrap
        }
        
        // Check 3: Recent block timing validation (prevent rapid-fire production)
        let _time_since_epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        // Network health indicators
        let network_health = match active_peers {
            0..=2 => "BOOTSTRAP",
            3..=4 => "ADEQUATE", 
            5..=9 => "GOOD",
            _ => "EXCELLENT"
        };
        
        println!("[INFO][NODE] producer_readiness_ok");
        println!("  ├── Node ID: {}", node_id);
        println!("  ├── Reputation: {:.1}%", reputation_score * 100.0);
        println!("  ├── Network Health: {} ({} peers)", network_health, active_peers);
        println!("  ├── Block Height: {}", block_height);
        println!("  └── Ready for Production: YES");
        
        true
    }
    
    /// PRODUCTION: Monitor network health for informational purposes (NON-CONSENSUS)
    #[allow(dead_code)]
    pub(super) async fn monitor_network_health(unified_p2p: &Option<Arc<SimplifiedP2P>>) -> String {
        if let Some(p2p) = unified_p2p {
            let active_peers = p2p.get_peer_count(); // EXISTING: Fast peer count, no expensive validation
            match active_peers {
                0..=2 => "BOOTSTRAP",
                3..=4 => "ADEQUATE", 
                5..=9 => "GOOD",
                _ => "EXCELLENT"
            }.to_string()
        } else {
            "SOLO".to_string()
        }
    }
    
    /// PRODUCTION: Calculate qualified candidates with validator sampling for scalability
    /// 
    /// ARCHITECTURE v2.27.0: EPOCH-BASED VALIDATOR SET
    /// ═══════════════════════════════════════════════════════════════════════════
    /// 
    /// OLD PROBLEM: Using gossip registry caused DIFFERENT candidate lists:
    ///   - Node A gossip sees [1,2,3...100] → selects producer X
    ///   - Node B gossip sees [50,51...150] → selects producer Y
    ///   - RESULT: Network fork!
    ///
    /// NEW SOLUTION: Use MACROBLOCK SNAPSHOT (epoch-based)
    ///   - Blocks 1-90: Static genesis_constants list (hardcoded)
    ///   - Blocks 91+: Snapshot from corresponding macroblock
    ///   - All nodes read SAME snapshot from blockchain
    ///   - NO gossip race conditions!
    ///   - Scales to millions of nodes!
    /// ═══════════════════════════════════════════════════════════════════════════
    pub(super) async fn calculate_qualified_candidates(
        p2p: &Arc<SimplifiedP2P>,
        own_node_id: &str,
        _own_node_type: NodeType,
        target_height: u64,  // v3.16: CRITICAL FIX - use explicit height, not LOCAL_BLOCKCHAIN_HEIGHT!
    ) -> Vec<(String, f64)> {
        // v3.16: Use target_height parameter for DETERMINISTIC epoch calculation
        // CRITICAL BUG FIX: Previously used LOCAL_BLOCKCHAIN_HEIGHT which differs between nodes!
        // This caused entropy (from select_microblock_producer_with_round current_height)
        // and candidates (from LOCAL_BLOCKCHAIN_HEIGHT) to use DIFFERENT epochs → FORK!
        let current_height = target_height;
        
        // ═══════════════════════════════════════════════════════════════════
        // GENESIS EPOCH (blocks 1-180): Use static hardcoded list
        // WHY 180? With N-2 logic, MacroBlock #1 is needed at block 181.
        // MacroBlock #1 is created at block 90, consensus finishes ~block 120.
        // ═══════════════════════════════════════════════════════════════════
        if current_height <= 180 {
            // REFACTORED v2.32: Use unified helper function (eliminates duplication)
            let mut all_qualified = Self::get_genesis_candidates_with_real_reputation(p2p);
            
            // Ensure own node is included if Genesis
            if own_node_id.starts_with("genesis_node_") && 
               !all_qualified.iter().any(|(id, _)| id == own_node_id) {
                all_qualified.push((own_node_id.to_string(), 0.70));
            }
            
            // Sort for determinism
            all_qualified.sort_by(|a, b| a.0.cmp(&b.0));
            all_qualified.dedup_by(|a, b| a.0 == b.0);
            
            if log_block(current_height) {
                println!("[INFO][CAND] h={} genesis_epoch prod={}", current_height, all_qualified.len());
            }
            
            return all_qualified;
        }
        
        // ═══════════════════════════════════════════════════════════════════
        // NORMAL EPOCH (blocks 91+): Use macroblock snapshot
        // PRODUCTION v2.30: Use N-2 macroblock (SAFE MARGIN!)
        // ═══════════════════════════════════════════════════════════════════
        //
        // WHY N-2 NOT N-1:
        // - MacroBlock #1 is CREATED at block 90
        // - MacroBlock #1 consensus TAKES TIME (seconds to minutes!)
        // - Block 91 needs producer list IMMEDIATELY
        // - If we use N-1, block 91 needs MacroBlock #1 which ISN'T READY YET!
        //
        // SAFE LOGIC (N-2):
        // - Height 91-180 (epoch 2): Use Genesis static list (MacroBlock #0 = none)
        // - Height 181-270 (epoch 3): Use MacroBlock #1 (created at 90, ready by ~120)
        // - Height 271-360 (epoch 4): Use MacroBlock #2 (created at 180, ready by ~210)
        //
        // This gives ~90 blocks (~90 seconds) buffer for consensus to complete!
        // ═══════════════════════════════════════════════════════════════════
        
        let current_epoch = (current_height - 1) / 90 + 1;  // epoch 1 = height 1-90, epoch 2 = 91-180, epoch 3 = 181-270
        let required_macroblock = current_epoch.saturating_sub(2);  // N-2: epoch 3 uses MacroBlock #1
        
        if log_block(current_height) {
            if log_block(current_height) { println!("[DBG][CANDIDATES] h={} ep={} mb={}", current_height, current_epoch, required_macroblock); }
        }
        
        // A1: the roster no longer REQUIRES macroblock N-2 to exist. Sealed ⇒ used verbatim below.
        // Frozen (finality stalled) ⇒ the FROZEN roster of the sealed anchor M_A, a pure function of
        // sealed bytes so every node derives the same set. Defer ⇒ a certified anchor exists but is
        // unheld, so this node abstains and syncs rather than derive off a stale base.
        if let Some(storage) = try_get_storage() {
            if required_macroblock > 0 {
                match Self::roster_mode(&storage, current_epoch) {
                    RosterMode::Frozen => {
                        let l = storage.last_sealed_mb_index();
                        if let Some((_a_idx, anchor)) = Self::frozen_anchor(&storage, l) {
                            let mut derived: Vec<(String, f64)> = Self::frozen_roster(&anchor).into_iter()
                                .filter(|p| !crate::genesis_constants::restart_excludes(&p.node_id))
                                .map(|p| (p.node_id, p.reputation as f64 / 100.0))
                                .collect();
                            derived.sort_by(|a, b| a.0.cmp(&b.0));
                            if !derived.is_empty() { return derived; }
                        }
                        return Vec::new(); // anchor unusable ⇒ abstain (park), never a stale base
                    }
                    RosterMode::Defer => return Vec::new(),
                    RosterMode::Sealed => {}
                }
            }
            match storage.get_macroblock_by_height(required_macroblock) {
                Ok(Some(macroblock_data)) => {
                    match bincode::deserialize::<qnet_state::MacroBlock>(&macroblock_data) {
                        Ok(macroblock) => {
                            // v34: the candidate set is the macroblock's eligible_producers snapshot
                            // ONLY — the single canonical, QC-bound (via epoch_commitment) source, so
                            // every honest node derives the SAME set → no fork. TWO non-canonical
                            // filters are NEUTRALISED here (both no-ops today ⇒ behaviour-preserving):
                            //  • excluded_producers_for_next_epoch — derived from each node's LOCAL
                            //    failover history, neither on-chain nor QC-bound, so reading it would
                            //    filter DIFFERENT producers per node → honest split two epochs later.
                            //  • is_validator_ejected — a per-node locally-observed set; enabling it
                            //    made selection node-dependent → split.
                            // Liveness exclusion, when introduced, MUST be on-chain and QC-bound. The
                            // checkpoint QC's signer list is the only certified participation record.
                            let excluded_node_ids: std::collections::HashSet<String> =
                                std::collections::HashSet::new();
                            
                            // PRIMARY: eligible_producers snapshot, empty node_ids dropped. The
                            // excluded set stays a no-op (liveness exclusion must be on-chain/QC-bound).
                            if let Some(ref snapshot_data) = macroblock.consensus_data.eligible_producers {
                                if let Ok(producers) = bincode::deserialize::<Vec<qnet_state::EligibleProducer>>(snapshot_data) {
                                    // restart_excludes bars the barred set from the DERIVED producer/
                                    // committee set (restart GAP B) without touching the QC-bound field.
                                    let mut all_qualified: Vec<(String, f64)> = producers.iter()
                                        .filter(|p| !p.node_id.is_empty()
                                            && !excluded_node_ids.contains(&p.node_id)
                                            && !crate::genesis_constants::restart_excludes(&p.node_id))
                                        .map(|p| (p.node_id.clone(), p.reputation as f64 / 100.0))
                                        .collect();
                                    if !all_qualified.is_empty() {
                                        all_qualified.sort_by(|a, b| a.0.cmp(&b.0));
                                        if is_debug() {
                                            println!("[DBG][CANDIDATES] ep={} prod={} mb={}",
                                                     current_epoch, all_qualified.len(), required_macroblock);
                                        }
                                        return all_qualified;
                                    }
                                }
                            }
                            
                            // SECONDARY: Use consensus participants from macroblock
                            if !macroblock.consensus_data.commits.is_empty() {
                                // v3.10: Also filter excluded from SECONDARY path
                                //
                                // v14.8.9: REPUTATION FROM DETERMINISTIC FALLBACK ONLY.
                                //
                                // The PRIMARY candidate path (`eligible_producers` snapshot
                                // on the macroblock) carries an immutable, on-chain reputation
                                // value — identical on every node by definition.
                                //
                                // This SECONDARY fallback fires only when the snapshot is
                                // absent (legacy macroblock or deserialization gap). The
                                // previous implementation read live RAM state via
                                // `get_deterministic_reputation().get_reputation(id, now)`
                                // — a MUTABLE, TIMING-DEPENDENT counter that can differ
                                // between validators if slashing/heartbeat updates arrive
                                // out of order. Divergent reputation → divergent sort
                                // order (ties resolved by reputation) → divergent producer
                                // selection from the same candidate set → FORK.
                                //
                                // Canonical rule: candidate list used for VRF producer
                                // selection MUST be a pure function of on-chain finalized
                                // state. We therefore use the deterministic constant
                                // `INITIAL_REPUTATION` here — all nodes see the same value,
                                // and since the set is then sorted by `id` alphabetically,
                                // order is fully deterministic regardless of reputation.
                                // Scales identically at 5 or 5000 validators (O(commits)).
                                let det_rep = (qnet_consensus::deterministic_reputation::INITIAL_REPUTATION) / 100.0;
                                // v25 H9: SECONDARY path mirrors PRIMARY — also gate by
                                // liveness ejection (no-op unless QNET_LIVENESS_EJECTION=1
                                // is set). Keeps the two candidate paths semantically
                                // identical so behaviour does not depend on which one
                                // happens to fire.
                                let mut all_qualified: Vec<(String, f64)> = macroblock.consensus_data.commits.keys()
                                    .filter(|id| !excluded_node_ids.contains(*id)
                                        && !crate::genesis_constants::restart_excludes(id))
                                    .map(|id| (id.clone(), det_rep))
                                    .collect();
                                all_qualified.sort_by(|a, b| a.0.cmp(&b.0));
                                
                                println!("[WARN][CAND] Epoch {}: {} participants from MacroBlock #{} commits (excluded={}, no snapshot)", 
                                         current_epoch, all_qualified.len(), required_macroblock, excluded_node_ids.len());
                                return all_qualified;
                            }
                            
                            println!("[ERR][CAND] MacroBlock #{} has no producers or commits!", required_macroblock);
                        }
                        Err(e) => {
                            println!("[ERR][CAND] Failed to deserialize MacroBlock #{}: {}", required_macroblock, e);
                        }
                    }
                }
                Ok(None) => {
                    // v14.8: Self-assembly removed. Previous behaviour locally reconstructed
                    // the missing macroblock by stuffing `consensus_data.commits/reveals`
                    // with synthetic placeholder strings (e.g. `local_self_assembly_commit_N`).
                    // That produced macroblocks with different bytes on different nodes
                    // (HashMap iteration ordering, synthetic-string formatting) — so any two
                    // self-assembled macroblocks at the same height could hash differently
                    // and seed different eligible_producers snapshots, forking the chain.
                    //
                    // Canonical behaviour now: if we lack macroblock #N we abstain from this
                    // election round and request it from peers. The next round — driven by
                    // the canonical n−f macroblock consensus — provides the authoritative
                    // snapshot. Temporary abstention is safe: n−f other validators are
                    // enough to keep consensus alive without us.
                    let mb_idx = required_macroblock;
                    println!("[WARN][CAND] mb={} NOT_FOUND h={} — abstaining this round, requesting from peers",
                             mb_idx, current_height);
                    // Nudge the single sync coordinator to backfill the missing macroblock; we abstain
                    // from this election round meanwhile (n−f others keep consensus alive).
                    crate::sync_manager::nudge_sync_check();
                    // ABSTAIN — never substitute an older snapshot. The previous bounded walk-back
                    // returned the most recent AVAILABLE eligible_producers set below N-2, which makes the
                    // roster a function of what this node happens to hold in RocksDB rather than of the
                    // height. Two nodes with different local availability then derive different rosters,
                    // different committees and a different epoch_commitment, so the checkpoint can never
                    // reach n−f — and with production decoupled from finality it would be a fork instead
                    // of a stall. Abstaining is safe: the n−f quorum that DOES hold N-2 keeps sealing, this node
                    // follows their blocks (an empty roster is never cached, so ingest stays on the soft
                    // path), and the sync coordinator nudged above repairs the macroblock deficit.
                    return Vec::new();
                }
                Err(e) => {
                    // v2.47: Storage error = node is broken, cannot participate
                    eprintln!("[ERR][CAND] mb={} storage_err={} - node MUST SYNC!",
                             required_macroblock, e);
                    
                    // Return EMPTY - node with storage errors must not participate!
                    return Vec::new();
                }
            }
        } else {
            // Storage unavailable = node is broken
            eprintln!("[ERR][CAND] storage_unavailable - node cannot participate!");
            return Vec::new();
        }
        
        // This should NEVER be reached
        eprintln!("[ERR][CAND] Unexpected fallthrough!");
        Vec::new()
    }
    
    /// DEPRECATED: Legacy function - use calculate_qualified_candidates() instead
    #[allow(dead_code)]
    pub(super) async fn _get_genesis_qualified_candidates_legacy(
        p2p: &Arc<SimplifiedP2P>,
        own_node_id: &str,
        own_node_type: NodeType,
    ) -> Vec<(String, f64)> {
        let mut all_qualified = Vec::new();
        
        // EXISTING: For Genesis phase, ALL Genesis nodes use IDENTICAL deterministic reputation
        // This ensures consistent candidate lists and hashes across all nodes
        let is_own_genesis = own_node_id.starts_with("genesis_node_");
        
        let can_participate_microblock = match own_node_type {
            NodeType::Super => {
                if is_own_genesis {
                    // PRODUCTION: All nodes use same threshold for fairness
                    const GENESIS_STATIC_REPUTATION: f64 = 0.70;
                    GENESIS_STATIC_REPUTATION >= 0.70
                } else {
                    // Regular Super nodes: Use P2P reputation
                    let own_reputation = Self::get_node_reputation_score(own_node_id, p2p).await;
                    own_reputation >= 0.70
                }
            },
            NodeType::Light => {
                false // Light nodes never participate
            }
        };
        
        // CRITICAL FIX: Build DETERMINISTIC Genesis candidate list for consensus consistency
        // ALL nodes must use IDENTICAL candidate lists to prevent producer selection chaos
        
        // EXISTING: Use static Genesis constants for GUARANTEED deterministic order (001, 002, 003, 004, 005)  
        let genesis_ips = crate::unified_p2p::get_genesis_bootstrap_ips();
        let static_genesis_nodes: Vec<(String, String)> = genesis_ips.iter()
            .enumerate()
            .map(|(i, ip)| (format!("genesis_node_{:03}", i + 1), ip.clone()))
            .collect();
        
        // ARCHITECTURE: For Genesis phase, use DETERMINISTIC candidate list
        // All nodes must see SAME list to ensure Byzantine consensus
        // Failed nodes will timeout and trigger emergency producer change
        
        println!("[INFO][GEN] deterministic_candidates count=5");
        
        // CRITICAL: Include ALL Genesis nodes for deterministic consensus
        // This ensures all nodes calculate same producer selection
        const GENESIS_FIXED_REPUTATION: f64 = 0.70;
        
        // For Genesis phase, include all 5 nodes deterministically
        // Connectivity issues will be handled by timeout/failover mechanism
        for (node_id, _ip) in &static_genesis_nodes {
            // During Genesis phase, assume all nodes are candidates
            // This ensures deterministic producer selection across all nodes
            
            let real_reputation = Self::get_node_reputation_score(node_id, p2p).await;
                
            // PRODUCTION: Always include ALL Genesis nodes with fixed reputation
            // Deterministic list ensures all nodes agree on candidates
            all_qualified.push((node_id.clone(), GENESIS_FIXED_REPUTATION));
            
            if real_reputation < 0.70 {
                println!("[WARN][GEN] {} included with FIXED 70% (real: {:.1}% - below threshold)", 
                             node_id, real_reputation * 100.0);
                } else {
                println!("[INFO][GEN] {} included with FIXED 70% (real: {:.1}%)", 
                             node_id, real_reputation * 100.0);
                }
        }
        
        // PRODUCTION SAFETY: Log connectivity status (for monitoring, not for candidate filtering)
        let validated_peers = p2p.get_validated_active_peers();
        let connected_genesis: Vec<String> = validated_peers
            .iter()
            .filter(|p| p.id.starts_with("genesis_node_"))
            .map(|p| p.id.clone())
            .collect();
        
        println!("[INFO][GEN] connected_genesis_nodes={:?}", connected_genesis);
        println!("[INFO][GEN] total_candidates={} mode=deterministic", all_qualified.len());
        
        // BYZANTINE SAFETY: Verify minimum nodes are actually connected (but DON'T filter candidates!)
        // This check happens AFTER candidate list creation to maintain determinism
        let validated_peers = p2p.get_validated_active_peers();
        let connected_genesis_count = validated_peers.iter()
            .filter(|p| p.id.starts_with("genesis_node_"))
            .count();
        
        // Include self if it's a Genesis node
        let total_active_genesis = if is_own_genesis && can_participate_microblock {
            connected_genesis_count + 1
        } else {
            connected_genesis_count
        };
        
        // Log Byzantine safety status (but keep all candidates for deterministic selection)
        if total_active_genesis < 4 {
            println!("[WARN][CONS] Only {} Genesis nodes active (need 4 for Byzantine safety)", total_active_genesis);
            // NOTE: Still return full list for deterministic selection, safety check happens at block production
        } else {
            if is_info() { println!("[INFO][CONS] genesis_active={} bft_ok", total_active_genesis); }
        }
        
        // PRODUCTION: Remove duplicate candidates (using same logic as DHT peer discovery)
        // Each node might appear twice: once as own_node and once as peer
        all_qualified.dedup_by(|a, b| a.0 == b.0); // Remove duplicates by node_id (maintain original order)
        // NOTE: Sorting is NOT done here - it's done by callers (microblock/emergency/macroblock selection)
        // This allows each caller to sort candidates at the exact point where deterministic ordering is needed
        
        // CRITICAL: Apply validator sampling for scalability (prevent millions of validators)
        let sampled_candidates = if all_qualified.len() <= MAX_VALIDATORS {
            all_qualified
        } else {
            Self::deterministic_validator_sampling(&all_qualified, MAX_VALIDATORS).await
        };
        
        sampled_candidates
    }
    
    /// DEPRECATED: Legacy function - use calculate_qualified_candidates() instead
    #[allow(dead_code)]
    pub(super) async fn _get_registry_qualified_candidates_legacy(
        own_node_id: &str,
        own_node_type: NodeType,
    ) -> Vec<(String, f64)> {
        // PRODUCTION: Create registry instance with real QNet blockchain endpoints
        let qnet_rpc = std::env::var("QNET_RPC_URL")
            .or_else(|_| std::env::var("QNET_GENESIS_NODES")
                .map(|nodes| { let ip = nodes.split(',').next().unwrap_or("127.0.0.1").trim().to_string(); format!("http://{}:8001", ip) }))
            .unwrap_or_else(|_| "http://127.0.0.1:8001".to_string());
            
        // PRODUCTION v2.50: Lock-free storage access
        let storage_ref = if std::env::var("QNET_STORAGE_PATH").is_ok() {
            try_get_storage().cloned()
        } else {
            None
        };
            
        let registry = crate::activation_validation::BlockchainActivationRegistry::new_with_storage(
            Some(qnet_rpc),
            storage_ref
        );
        
        // ARCHITECTURE: Registry already uses FINALITY_WINDOW internally
        // BlockchainActivationRegistry reads from blockchain with built-in lag
        // This ensures deterministic results across all nodes
        println!("  ├── Using BlockchainActivationRegistry (with built-in FINALITY_WINDOW)");
        
        // Get eligible nodes from registry (deterministic via blockchain)
        let registry_candidates = registry.get_eligible_nodes().await;
        println!("  ├── Registry returned {} eligible nodes", registry_candidates.len());
        
        let mut all_qualified: Vec<(String, f64)> = Vec::new();
        
        // Check own node eligibility (same logic as Genesis phase)
        let can_participate = match own_node_type {
            NodeType::Super => {
                // Super nodes always eligible if reputation ≥70%
                println!("  ├── Own Super node: checking reputation threshold");
                true // Will check reputation below
            },
            NodeType::Light => {
                println!("  ├── Own Light node: excluded from consensus");
                false // Light nodes never participate
            }
        };
        
        if can_participate {
            // PRODUCTION: Get real reputation from local calculation
            // Own node's reputation is calculated from blocks produced/validated
            let own_rep = {
                let _current_ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                
                // Try to get from registry candidates first (already loaded)
                registry_candidates.iter()
                    .find(|(id, _, _)| id == own_node_id)
                    .map(|(_, rep, _)| *rep)
                    .unwrap_or(0.70)  // Threshold for new nodes
            };
            
            all_qualified.push((own_node_id.to_string(), own_rep));
            println!("  ├── Own node added to candidates with real reputation: {:.1}%", own_rep * 100.0);
        }
        
        // Add registry candidates
        for (node_id, reputation, node_type) in registry_candidates {
            all_qualified.push((node_id.clone(), reputation));
            println!("  ├── Registry node: {} ({}), reputation: {:.1}%", 
                     node_id, node_type, reputation * 100.0);
        }
        
        println!("  ├── Total qualified from registry: {}", all_qualified.len());
        
        // Remove duplicate candidates (sorting is done by caller for deterministic entropy)
        all_qualified.dedup_by(|a, b| a.0 == b.0);
        
        // Apply validator sampling (same logic as Genesis phase)
        let sampled_candidates = if all_qualified.len() <= MAX_VALIDATORS {
            println!("  ├── Registry network: using all {} qualified validators", all_qualified.len());
            all_qualified
        } else {
            println!("  ├── Large registry network: sampling {} from {} qualified validators",
                     MAX_VALIDATORS, all_qualified.len());
            Self::deterministic_validator_sampling(&all_qualified, MAX_VALIDATORS).await
        };
        
        println!("  └── Final registry candidates: {} (ready for millions scale)", sampled_candidates.len());
        sampled_candidates
    }
    
     /// PRODUCTION: Simple deterministic validator sampling per QNet specification
    /// Implements "Simple reputation-based selection (NO WEIGHTS)" from NETWORK_LOAD_ANALYSIS.md
    /// All qualified nodes (Full + Super, reputation ≥70%) have equal chance
    pub(super) async fn deterministic_validator_sampling(
        all_qualified: &[(String, f64)],
        max_count: usize,
    ) -> Vec<(String, f64)> {
        let mut selected = Vec::new();
        
        if all_qualified.is_empty() || max_count == 0 {
            return selected;
        }
        
        // CRITICAL: Sort candidates to ensure deterministic ordering across ALL nodes
        // Different nodes may receive peers in different P2P discovery order
        // WITHOUT sorting: each node calculates DIFFERENT sampling hash → DIFFERENT validators (consensus failure!)
        // WITH sorting: all nodes calculate SAME sampling hash → SAME validators (consensus success!)
        let mut sorted_qualified = all_qualified.to_vec();
        sorted_qualified.sort_by(|a, b| a.0.cmp(&b.0));  // Sort by node_id alphabetically
        
        // FINALITY WINDOW: Use finalized height for deterministic validator selection
        // This prevents race conditions at rotation boundaries
        // Using global constant (10 blocks = safe for production Byzantine consensus)
        
        let current_height = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
            .load(std::sync::atomic::Ordering::Relaxed);
        
        // Calculate finalized height for Byzantine-safe selection
        let finalized_height = if current_height > FINALITY_WINDOW {
            current_height - FINALITY_WINDOW
        } else {
            0 // Genesis phase: use height 0 for initial rounds
        };
        
        // Calculate validator rotation round from finalized height
        // This ensures ALL synchronized nodes select the SAME validators
        let validator_round = finalized_height / ROTATION_INTERVAL_BLOCKS;
        
        println!("[INFO][MB] finality_window_applied");
        println!("  ├── Current height: {}", current_height);
        println!("  ├── Finalized height: {} (lag: {} blocks)", finalized_height, FINALITY_WINDOW);
        println!("  ├── Validator round: {}", validator_round);
        println!("  └── Selecting {} validators from {} qualified nodes", max_count, sorted_qualified.len());
        
        // QNet specification: "Equal chance for all qualified nodes"
        // Only Super nodes participate in consensus
        // (v3.18: the "Full" tier was removed from the protocol).
        for i in 0..max_count.min(sorted_qualified.len()) {
            let mut hasher = Sha3_256::new();
            
            // CRITICAL: Use finalized round instead of current height
            // This guarantees deterministic selection across all synchronized nodes
            hasher.update(format!("validator_sampling_{}_{}", validator_round, i).as_bytes());
            
            // Include all qualified validators for Byzantine consistency (NOW SORTED!)
            // CRITICAL: Use ONLY node_id, NOT reputation!
            // Reputation changes dynamically → non-deterministic sampling → consensus failure!
            for (node_id, _reputation) in &sorted_qualified {
                hasher.update(node_id.as_bytes());
                // DO NOT use reputation in entropy - it changes during runtime!
            }
            
            let selection_hash = hasher.finalize();
            let selection_number = u64::from_le_bytes([
                selection_hash[0], selection_hash[1], selection_hash[2], selection_hash[3],
                selection_hash[4], selection_hash[5], selection_hash[6], selection_hash[7],
            ]);
            
            let selection_index = (selection_number as usize) % sorted_qualified.len();
            let selected_validator = sorted_qualified[selection_index].clone();
            
            // Avoid duplicates
            if !selected.iter().any(|(id, _)| id == &selected_validator.0) {
                selected.push(selected_validator);
                
                if i < 5 || i >= max_count - 5 {
                    // Log first 5 and last 5 selections for debugging
                    if let Some((id, rep)) = selected.last() {
                        println!("  │     Validator {}: {} (reputation: {:.1}%)", i + 1, id, rep * 100.0);
                    }
                } else if i == 5 {
                    println!("  │     ... (sampling {} more validators) ...", max_count - 10);
                }
            }
        }
        
        // NOTE: Validators are selected deterministically via sorted list and cryptographic hashing
        // The selection order preserves cryptographic randomness while ensuring consensus
        
        println!("  ├── Simple sampling complete: {} validators selected from {} qualified (deterministic selection)", 
                 selected.len(), sorted_qualified.len());
        selected
    }
    
}

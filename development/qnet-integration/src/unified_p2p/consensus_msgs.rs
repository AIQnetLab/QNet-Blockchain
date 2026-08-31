//! Consensus message ingest: votes, certificates, signed heads and the TC repair channel.

use super::*;

impl SimplifiedP2P {
    /// Validator addresses in a per-node deterministic order. Raw table order is near-identical on
    /// every node, so any "take the first N" fetch converges the whole network on the same few
    /// servers; salting by our own id spreads the load without coordination or state.
    pub(crate) fn fetch_order(&self, n: usize) -> Vec<String> {
        use std::hash::{Hash, Hasher};
        let salt = {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            self.node_id.hash(&mut h);
            h.finish()
        };
        let mut peers = self.get_all_validator_addresses();
        peers.sort_by_key(|p| {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            salt.hash(&mut h);
            p.hash(&mut h);
            h.finish()
        });
        peers.truncate(n);
        peers
    }

    /// Handle incoming timeout proof broadcast
    /// SECURITY: Verifies all signatures before accepting
    /// Single authority for accepting a timeout certificate (broadcast + pull adopt paths).
    /// Dedups by voter and drops non-committee members BEFORE counting, then verifies the
    /// remaining Dilithium signatures in parallel. Returns the distinct committee signers iff
    /// they reach quorum — so a replayed single vote or a non-committee key can never inflate
    /// the count and illegitimately advance the leader-selection round.
    /// Rehydrate persisted TimeoutCertificates through the SAME verifier the live wire path uses.
    /// A structural check (key matches the proof, votes non-empty) is only a pre-filter: on-disk
    /// bytes are attacker-reachable, and an unverified TC installs a certified round, which is a
    /// production and view-change input. Votes stored are the verifier's RETURNED set, so a proof
    /// padded with junk signatures cannot smuggle them into RAM.
    pub fn rehydrate_timeout_certificates_verified(&self, bytes: &[u8]) -> RehydrateCounts {
        let entries = tc_blob_structural(bytes);
        let (mut installed, mut rejected) = (0usize, 0usize);
        for (k, v) in entries {
            match self.verify_timeout_certificate(v.height, v.timeout_round, v.anchor, &v.votes) {
                Some(verified_votes) => {
                    TIMEOUT_CERTIFICATES.insert(k, TimeoutProof {
                        height: v.height,
                        timeout_round: v.timeout_round,
                        anchor: v.anchor,
                        votes: verified_votes,
                    });
                    installed += 1;
                }
                None => rejected += 1,
            }
        }
        (installed, rejected)
    }

    pub(super) fn verify_timeout_certificate(
        &self, height: u64, timeout_round: u64, anchor: [u8; 32],
        votes: &[SignedTimeoutVote],
    ) -> Option<Vec<SignedTimeoutVote>> {
        // Window-keyed committee + quorum (identical on every verifier). Anchor absent locally →
        // pull + defer (sender/requester paths retransmit); NEVER signature-only post-genesis.
        let committee = match failover_committee_for_window(height) {
            Some(c) => c,
            None => {
                self.request_window_anchor(height);
                if crate::node::is_warn() {
                    println!("[WARN][TC] anchor_absent mb={} action=defer_fetch", height);
                }
                return None;
            }
        };
        // The anchor is DETERMINISTIC per window — re-derive locally and compare; a TC minted on a
        // fork with a different sealed w-2 fails here on every honest node.
        match sealed_anchor_for_window(height) {
            Some(local_anchor) if local_anchor == anchor => {}
            Some(_) => {
                if crate::node::is_warn() {
                    println!("[WARN][TC] anchor_mismatch mb={} round={} action=reject", height, timeout_round);
                }
                return None;
            }
            None => { self.request_window_anchor(height); return None; }
        }
        let quorum = qnet_consensus::checkpoint_bft::quorum_size(committee.len());
        // Dedup by voter BEFORE verify; drop non-committee voters.
        let mut by_voter: std::collections::HashMap<String, SignedTimeoutVote> = std::collections::HashMap::new();
        for v in votes {
            if committee.contains(&v.voter_id) {
                by_voter.insert(v.voter_id.clone(), v.clone());
            }
        }
        if by_voter.len() < quorum { return None; }
        let candidates: Vec<SignedTimeoutVote> = by_voter.into_values().collect();
        use rayon::prelude::*;
        // Per-voter payload reconstruction: each signature verifies over the voter's OWN fields —
        // mixed-finality votes certify together (the aggregation key is only (window, round, anchor)).
        let verified: Vec<SignedTimeoutVote> = candidates
            .into_par_iter()
            .filter(|v| {
                let msg = timeout_vote_message(height, timeout_round, &anchor,
                                               v.high_qc_idx, &v.high_qc_hash,
                                               v.tip_height, &v.tip_hash);
                self.verify_timeout_vote_signature(&v.voter_id, &msg, &v.signature)
            })
            .collect();
        if verified.len() < quorum { None } else { Some(verified) }
    }

    pub(super) fn handle_timeout_proof_broadcast(&self, height: u64, timeout_round: u64,
                                       anchor: Vec<u8>, votes: Vec<SignedTimeoutVote>) {
        // Skip if we already have this proof
        if TIMEOUT_CERTIFICATES.contains_key(&(height, timeout_round)) {
            return;
        }
        // Never ACCEPT a TC for a left view — a node past window W ignores a certificate for an
        // earlier window (it cannot drive a reorg here); a genuinely-lagging node has a low floor
        // and still accepts it to advance.
        if height < observed_tc_window_floor() {
            if crate::node::is_debug() {
                println!("[DBG][TIMEOUT] tc_below_floor h={} floor={} action=drop", height, observed_tc_window_floor());
            }
            return;
        }
        // Round bound (mirror handle_timeout_vote #295): a legit failover round never exceeds
        // certified+MAX_FAILOVER_ROUND. Caps the (window,round) key space BEFORE the quorum-many
        // Dilithium verify in verify_timeout_certificate, so a peer cannot cycle timeout_round to
        // unbounded novel keys (each bypassing the dedup above) and force an unbounded verify storm —
        // this path is reachable with UNVERIFIED block bytes via maybe_supersede's adopt.
        if timeout_round > highest_certified_round_for(height).saturating_add(crate::node::MAX_FAILOVER_ROUND) {
            if crate::node::is_debug() {
                println!("[DBG][TIMEOUT] tc_round_oob h={} round={} action=drop", height, timeout_round);
            }
            return;
        }

        if anchor.len() != 32 {
            if crate::node::is_warn() {
                println!("[WARN][TIMEOUT] proof_invalid_anchor h={} round={}", height, timeout_round);
            }
            return;
        }

        let mut anchor_arr = [0u8; 32];
        anchor_arr.copy_from_slice(&anchor);

        // Distinct committee signers ≥ quorum (dedup + committee filter + anchor re-derivation
        // inside) — a replayed vote, non-committee key, or forked anchor cannot advance the round.
        let verified_votes = match self.verify_timeout_certificate(height, timeout_round, anchor_arr, &votes) {
            Some(v) => v,
            None => {
                if crate::node::is_warn() {
                    println!("[WARN][TIMEOUT] tc_rejected h={} round={} raw_votes={}",
                             height, timeout_round, votes.len());
                }
                return;
            }
        };
        let signers = verified_votes.len();

        TIMEOUT_CERTIFICATES.insert((height, timeout_round), TimeoutProof {
            height, timeout_round, anchor: anchor_arr, votes: verified_votes,
        });

        // Tracker + view floor (prunes below-floor banked votes) — round advances only on a quorum.
        HIGHEST_CERTIFIED_ROUND.entry(height)
            .and_modify(|cur| { if timeout_round > *cur { *cur = timeout_round; } })
            .or_insert(timeout_round);
        evict_votes_below_certified(height);

        if crate::node::is_info() {
            println!("[INFO][TC] certified mb={} round={} voters={} source=broadcast", height, timeout_round, signers);
        }
    }

    /// Cooldown-gated control-lane pull of the anchor macroblock (w-2) for vote window `w`. It may not
    /// be sealed anywhere yet (production runs ahead of the seal), so this is a best-effort pull: on a
    /// hit the deferred vote/TC processes after one control-lane RTT, on a miss it stays deferred.
    pub(crate) fn request_window_anchor(&self, w: u64) {
        if w < 3 { return; }
        let idx = w - 2;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        // GLOBAL token bucket first: caps anchor-pull fan-out across ALL windows so an attacker cycling
        // distinct heights (bypassing the per-idx cooldown) cannot amplify a tiny inbound TC/vote into
        // O(peers) reflected control-lane traffic. Shared sink for every caller (vote/TC-broadcast/response).
        const ANCHOR_PULLS_PER_SEC: u32 = 4;
        {
            let mut b = ANCHOR_PULL_BUDGET.lock();
            if b.0 != now { *b = (now, 0); }
            if b.1 >= ANCHOR_PULLS_PER_SEC { return; }
            b.1 += 1;
        }
        let last = ANCHOR_PULL_LAST.get(&idx).map(|v| *v).unwrap_or(0);
        if now.saturating_sub(last) < 5 { return; }
        ANCHOR_PULL_LAST.insert(idx, now);
        ANCHOR_PULL_LAST.retain(|_, t| now.saturating_sub(*t) < 300);
        let msg = NetworkMessage::RequestMacroblockAnchor { index: idx, requester_id: self.node_id.clone() };
        let peers: Vec<String> = self.fetch_order(3);
        if peers.is_empty() { return; }
        let quic_transport = self.quic_transport.clone();
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if !quic_enabled { return; }
                let transport = match quic_transport { Some(t) => t, None => return };
                for peer in peers {
                    let quic_addr_str = format!("{}:10876", peer.split(':').next().unwrap_or(&peer));
                    if let Ok(quic_addr) = quic_addr_str.parse::<std::net::SocketAddr>() {
                        let t = transport.read().await;
                        let _ = t.send_message(quic_addr, &msg).await;
                    }
                }
            });
        }
    }

    /// SyncInfo claim intake — processed BEFORE any dispatch filter/tally so a behind node is never
    /// deafened by its own filter to the certificate that would advance it. Claims (UNSIGNED, may
    /// precede auth) trigger only a rate-capped PULL of the real TC; state mutates solely through
    /// the verified TC writers. Attacker-hardened: a claim for a window beyond the producible
    /// frontier is fabricated (no TC can exist there) → ignored; a GLOBAL token bucket (not per-
    /// cert_mb) bounds the pull fan-out so cycling cert_mb cannot amplify.
    pub(crate) fn process_tc_claim(&self, cert_mb: u64, cert_round: u64) {
        if cert_mb == 0 && cert_round == 0 { return; }
        // Sanity bound: a real TC only exists for a producible window (≤ local tip + throttle slack);
        // a far-future cert_mb is fabricated and un-pullable.
        let local_w = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed) / 90;
        // Same horizon as production and the view ceiling above.
        if cert_mb > local_w.saturating_add(
            crate::node::BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64 + 1) { return; }
        if cert_round <= self.get_highest_certified_round(cert_mb) { return; }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        // GLOBAL token bucket: ≤ TC_CLAIM_PULLS_PER_SEC SyncInfo-driven pulls/sec regardless of how
        // many distinct cert_mb an attacker cycles (the per-cert_mb cooldown alone was bypassable).
        const TC_CLAIM_PULLS_PER_SEC: u32 = 4;
        {
            let mut b = TC_CLAIM_PULL_BUDGET.lock();
            if b.0 != now { *b = (now, 0); }
            if b.1 >= TC_CLAIM_PULLS_PER_SEC { return; }
            b.1 += 1;
        }
        let last = TC_PULL_LAST.get(&cert_mb).map(|v| *v).unwrap_or(0);
        if now.saturating_sub(last) < 5 { return; }
        TC_PULL_LAST.insert(cert_mb, now);
        // Occasional prune (not every call) — the O(n) scan must not run per message.
        if now % 30 == 0 { TC_PULL_LAST.retain(|_, t| now.saturating_sub(*t) < 300); }
        if crate::node::is_info() {
            println!("[INFO][TIMEOUT] tc_claim_pull mb={} claimed_round={}", cert_mb, cert_round);
        }
        self.request_timeout_proofs(cert_mb, cert_mb);
    }

    /// #80: adopt a 2f+1 TimeoutProof attached to a round>0 microblock. Verifies + stores it via the
    /// SAME path as a gossiped proof (distinct committee signers ≥ quorum), advancing
    /// HIGHEST_CERTIFIED_ROUND so ingest authorises the block in-band — no dependence on the separate
    /// TC broadcast. Self-authenticating: a forged/insufficient proof is rejected inside and advances
    /// nothing (the block then falls to the pull path). Idempotent (dedup on (mb_idx, round)).
    pub fn adopt_timeout_proof_bytes(&self, bytes: &[u8]) {
        let proof: TimeoutProof = match bincode::deserialize(bytes) {
            Ok(p) => p,
            Err(_) => return,
        };
        // DoS bound: the proof is excluded from the block hash, so a relay can swap it. The round
        // committee is <=1000, so a proof with more votes is malformed — drop it before the O(votes)
        // dedup/verify loop (verify_timeout_certificate would reject it anyway on the quorum check).
        const MAX_TC_VOTES: usize = 2048;
        if proof.votes.len() > MAX_TC_VOTES { return; }
        self.handle_timeout_proof_broadcast(proof.height, proof.timeout_round,
                                            proof.anchor.to_vec(), proof.votes);
    }

    /// Handle request for timeout proofs (for syncing nodes)
    pub(super) fn handle_timeout_proof_request(&self, from_height: u64, to_height: u64,
                                     _requester_id: &str, requester_addr: &str) {
        // Each proof carries n-f un-aggregated ML-DSA-65 signatures, so an unbounded answer to an
        // arbitrary range is a large amplification from one small request. Bound the range and the
        // count, and hold one request per requester per cooldown.
        const MAX_PROOFS: usize = 8;
        const PROOF_REQUEST_COOLDOWN_SECS: u64 = 2;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let last = PROOF_SERVE_LAST.get(requester_addr).map(|v| *v).unwrap_or(0);
        if now.saturating_sub(last) < PROOF_REQUEST_COOLDOWN_SECS { return; }
        PROOF_SERVE_LAST.insert(requester_addr.to_string(), now);
        PROOF_SERVE_LAST.retain(|_, t| now.saturating_sub(*t) < 300);

        let to_height = to_height.min(from_height.saturating_add(MAX_PROOFS as u64));
        let mut certificates = Vec::new();
        for entry in TIMEOUT_CERTIFICATES.iter() {
            if certificates.len() >= MAX_PROOFS { break; }
            let (h, _r) = entry.key();
            if *h >= from_height && *h <= to_height {
                certificates.push(entry.value().clone());
            }
        }

        if certificates.is_empty() {
            return;
        }

        let response_msg = NetworkMessage::TimeoutCertificatesResponse {
            certificates,
            sender_id: self.node_id.clone(),
        };

        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let quic_transport = self.quic_transport.clone();
            let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
            let addr = requester_addr.to_string();

            handle.spawn(async move {
                if !quic_enabled {
                    return;
                }
                let transport = match quic_transport {
                    Some(t) => t,
                    None => return,
                };
                let quic_addr_str = format!("{}:10876", addr.split(':').next().unwrap_or(&addr));
                let quic_addr = match quic_addr_str.parse::<std::net::SocketAddr>() {
                    Ok(a) => a,
                    Err(_) => return,
                };
                let t = transport.read().await;
                let _ = t.send_message(quic_addr, &response_msg).await;
            });
        }
    }
    
    /// Handle response with timeout proofs
    pub(super) fn handle_timeout_proof_response(&self, certificates: Vec<TimeoutProof>) {
        for proof in certificates {
            self.handle_timeout_proof_broadcast(proof.height, proof.timeout_round,
                                                proof.anchor.to_vec(), proof.votes);
        }
    }
    
    /// Request timeout proofs for sync (called by syncing node)
    /// ARCHITECTURE: Parallel requests to multiple peers with redundancy
    pub fn request_timeout_proofs(&self, from_height: u64, to_height: u64) {
        let msg = NetworkMessage::RequestTimeoutCertificates {
            from_height,
            to_height,
            requester_id: self.node_id.clone(),
        };
        
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return,
        };
        
        // Request from a few peers for redundancy; any one answer completes the pull.
        let peers = self.fetch_order(5);
        let total_peers = peers.len();
        
        if total_peers == 0 {
            return;
        }
        
        let max_peers = total_peers;
        let quic_transport = self.quic_transport.clone();
        let quic_enabled = self.quic_enabled.load(std::sync::atomic::Ordering::Relaxed);
        
        if crate::node::is_debug() {
            println!("[DBG][TIMEOUT] proof_request h={}..{} peers={}", from_height, to_height, max_peers);
        }
        
        handle.spawn(async move {
            use futures::future::join_all;
            
            let mut tasks = Vec::with_capacity(max_peers);
            
            for peer_addr in peers.into_iter().take(max_peers) {
                // Consensus-critical: never skip a peer for PEER_RETRY_COOLDOWN. Cooldown is a
                // bulk-sync send-backoff; a rare failover message (vote / proof / request) MUST
                // reach the committee or the 2f+1 TC never forms. Send timeout still bounds delivery.
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
                                    // Send-fail → cooldown backoff (mirrors the vote/proof fan-outs) so a
                                    // dead peer is exponentially backed off for the bulk lane, not re-dialed
                                    // every redrive. Consensus paths above no longer READ cooldown to skip.
                                    match t.send_message(quic_addr, &msg_clone).await {
                                        Ok(_) => { PEER_RETRY_COOLDOWN.remove(&peer_addr); }
                                        Err(_) => {
                                            let (retry_count, _) = PEER_RETRY_COOLDOWN.get(&peer_addr)
                                                .map(|e| *e.value()).unwrap_or((0, std::time::Instant::now()));
                                            let new_retry_count = retry_count + 1;
                                            let backoff_secs = std::cmp::min(
                                                PEER_COOLDOWN_BASE_SECS * (1 << new_retry_count.min(4)),
                                                PEER_COOLDOWN_MAX_SECS);
                                            let cooldown_until = std::time::Instant::now()
                                                + std::time::Duration::from_secs(backoff_secs);
                                            PEER_RETRY_COOLDOWN.insert(peer_addr.clone(), (new_retry_count, cooldown_until));
                                        }
                                    }
                                }
                            }
                        }
                    }
                });

                tasks.push(task);
            }

            // Short timeout - we just need ANY peer to respond
            let timeout = tokio::time::Duration::from_secs(3);
            let _ = tokio::time::timeout(timeout, join_all(tasks)).await;
        });
    }
    
    /// Get count of active validators for Byzantine threshold.
    ///
    /// ARCHITECTURE: Uses the DETERMINISTIC epoch-based validator set from the
    /// macroblock snapshot — the same source used for producer selection.
    /// All nodes read the same macroblock → identical count → identical threshold.
    ///
    /// Using P2P connection count was WRONG: each node sees a different number of
    /// peers, producing different thresholds and breaking BFT safety at scale.
    ///
    /// Byzantine threshold = (n * 2 + 2) / 3 ≈ 2/3+
    /// Examples: 5 nodes → 4 votes, 10 nodes → 7 votes, 1000 nodes → 668 votes
    pub fn get_active_validator_count(&self) -> usize {
        // v9.0: Acquire ordering — BFT threshold depends on correct height
        let local_h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire);

        // BFT validator count — distinct node_id IDENTITIES, liveness-filtered.
        // connected_peers_lockfree is keyed by (addr,port) and one peer has 3
        // endpoints (HTTP/QUIC-main/QUIC-alt), so raw len() over-counts 3× →
        // BFT threshold unreachable → deadlock (the v14.0 bug). Count unique
        // node_ids (multi-transport = one validator), and only peers seen
        // within BFT_LIVENESS_WINDOW_SECS so a long-dead peer can't inflate
        // the quorum. Capped at MAX_VALIDATORS=1000 (VRF-sampled at scale).
        // Determinism: macroblock-snapshot path is deterministic (all nodes
        // read the same MB); the node-local fallback runs only at genesis /
        // N-2-absent and is safe because accepted votes are still sig-verified.
        const BFT_LIVENESS_WINDOW_SECS: u64 = 300; // 5 minutes
        const GENESIS_MIN_VALIDATORS: usize = 5;

        // v19: authenticated validator-set source (anti-spoof). Pre-v19 the
        // genesis-epoch count used unique live peers (QUIC X.509-SAN+TOFU, NOT
        // crypto-bound to a registered key) → a self-signed-cert peer inflates
        // the set → inflates 2f+1 → harder for honest to reach threshold.
        // Authoritative = CONSENSUS_PK_REGISTRY (3 audited paths:
        // install_genesis_anchors_at_startup pinned-at-boot;
        // register_consensus_pk_from_chain on finalized NodeRegistration TX
        // anti-squat-vs-anchors; register_consensus_pk_with_proof challenge-sig).
        // Every entry has proof-of-ownership → a spoofer can't appear via TLS.
        // O(1). Empty registry (very early boot) → legacy live-peer fallback +
        // [WARN][BFT].

        if local_h <= 180 {
            let registry_size = qnet_consensus::consensus_crypto::consensus_pk_registry_len();
            if registry_size >= GENESIS_MIN_VALIDATORS {
                let total = registry_size.min(crate::node::MAX_VALIDATORS);
                LAST_CANONICAL_VALIDATOR_COUNT.store(total as u64, std::sync::atomic::Ordering::Relaxed); // v34
                if crate::node::is_info() {
                    println!("[INFO][BFT] validator_count={} source=consensus_pk_registry h={}",
                             total, local_h);
                }
                return total;
            }
            // Defence-in-depth fallback: registry not yet populated. Emit WARN
            // so the operator can investigate why anchors did not install.
            let unique_live = self.count_unique_live_peers(BFT_LIVENESS_WINDOW_SECS);
            let total = std::cmp::max(GENESIS_MIN_VALIDATORS, unique_live + 1)
                .min(crate::node::MAX_VALIDATORS);
            if crate::node::is_warn() {
                println!(
                    "[WARN][BFT] validator_count={} source=p2p_fallback_unauthenticated registry_size={} unique_peers={} h={} \
                     hint=anchor_install_incomplete_or_pre_consensus_boot",
                    total, registry_size, unique_live, local_h
                );
            }
            return total;
        }

        // Normal epoch: deterministic N-2 committee (v27 HOLE5 single source
        // — same set the quorum-vote gates use; numerator==denominator).
        if let Some(ids) = self.deterministic_eligible_ids() {
            let capped = ids.len().min(crate::node::MAX_VALIDATORS);
            LAST_CANONICAL_VALIDATOR_COUNT.store(capped as u64, std::sync::atomic::Ordering::Relaxed); // v34
            if crate::node::is_info() {
                println!("[INFO][BFT] validator_count={} source=macroblock_n2 epoch={} unique={}",
                         capped, (local_h - 1) / 90 + 1, ids.len());
            }
            return capped;
        }

        // v34: macroblock N-2 snapshot unavailable. Prefer the last KNOWN-CANONICAL count over
        // the drifting live-peer estimate — a recently-synced node that briefly lost N-2 then keeps
        // the network-agreed 2f+1 threshold instead of drifting to a per-node peer count (the split
        // source). Only a never-synced cold-boot node (last_canonical==0) falls to live peers.
        let last_canonical =
            LAST_CANONICAL_VALIDATOR_COUNT.load(std::sync::atomic::Ordering::Relaxed) as usize;
        if last_canonical > 0 {
            if crate::node::is_info() {
                println!("[INFO][BFT] validator_count={} source=last_canonical epoch={} (N-2 absent)",
                         last_canonical, (local_h - 1) / 90 + 1);
            }
            return last_canonical.min(crate::node::MAX_VALIDATORS);
        }
        // Cold-boot fallback: never had a canonical count → live unique peers.
        // v14.1: Dedupe by node_id + liveness filter prevents phantom inflation.
        let unique_live = self.count_unique_live_peers(BFT_LIVENESS_WINDOW_SECS);
        let total = std::cmp::max(GENESIS_MIN_VALIDATORS, unique_live + 1)
            .min(crate::node::MAX_VALIDATORS);
        if crate::node::is_info() {
            println!("[INFO][BFT] validator_count={} source=p2p_fallback epoch={} unique_peers={} raw_len={}",
                     total, (local_h - 1) / 90 + 1, unique_live, self.connected_peers_lockfree.len());
        }
        total
    }

    /// Deterministic N-2 VRF committee (≤1000, THRESHOLD==SIZE) keyed on the LOCAL height's epoch.
    /// NON-FAILOVER consumers only: the failover vote/TC path uses the window-keyed
    /// `failover_committee_for_window` (verifier-local height must never pick the quorum set there).
    /// `None` = genesis pre-180 / snapshot absent.
    /// The consensus committee for THIS node's current epoch, as a set.
    ///
    /// Delegates to `BlockchainNode::committee_for_height` — THE single committee resolver. This used
    /// to be a second, independent implementation with its own staleness policy (an 8-macroblock
    /// walk-back against the other's zero), so the two could answer the same question differently on
    /// an ordinary honest outage or a rolling upgrade. Two answers to "who is the committee" is a fork
    /// surface that needs no adversary at all; there is now exactly one.
    pub(super) fn deterministic_eligible_ids(&self) -> Option<std::collections::HashSet<String>> {
        let local_h = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Acquire);
        if local_h <= 180 {
            return None; // genesis bootstrap -> fallback (signature-only) doctrine
        }
        let current_epoch = (local_h - 1) / 90 + 1;
        if let Some(c) = EPOCH_COMMITTEE_CACHE.get(&current_epoch) {
            return Some(c.value().as_ref().clone());
        }
        let storage = crate::node::try_get_storage()?;
        let set: std::collections::HashSet<String> =
            crate::node::BlockchainNode::committee_for_height(&storage, local_h)?
                .into_iter().collect();
        // Cache per epoch. The resolver is a pure function of committed macroblocks, so a hit is the
        // same value every node computes; the 4-epoch retain bounds it.
        let arc = Arc::new(set);
        EPOCH_COMMITTEE_CACHE.insert(current_epoch, arc.clone());
        EPOCH_COMMITTEE_CACHE.retain(|e, _| *e + 4 >= current_epoch);
        Some(arc.as_ref().clone())
    }

    /// Count unique alive peers by node_id, excluding self and stale entries.
    ///
    /// v14.1: ROOT CAUSE FIX — prevents the "3× port inflation" bug where each peer
    /// was counted 3 times (HTTP :8001 + QUIC-main :9876 + QUIC-alt :9877). Critical
    /// for correct BFT threshold calculation.
    ///
    /// Parameters:
    ///   liveness_window_secs — peers with `last_seen < now - window` are excluded.
    ///                          Prevents a dead peer from inflating the quorum size.
    ///
    /// Returns: number of distinct node_ids seen in `liveness_window_secs`.
    /// Excludes self (caller adds +1 if needed).
    pub(super) fn count_unique_live_peers(&self, liveness_window_secs: u64) -> usize {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let threshold = now.saturating_sub(liveness_window_secs);

        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for entry in self.connected_peers_lockfree.iter() {
            let peer = entry.value();
            if peer.id.is_empty() || peer.id == self.node_id {
                continue;
            }
            if peer.last_seen >= threshold {
                seen.insert(peer.id.clone());
            }
        }
        seen.len()
    }
    
    /// Get addresses of all validators for timeout vote broadcast
    /// SCALABLE: Uses connected_peers_lockfree which includes ALL nodes (Genesis + Super + Full)
    /// No hardcoded fallbacks - connected_peers is the single source of truth
    pub fn get_all_validator_addresses(&self) -> Vec<String> {
        // PRODUCTION: All validators are in connected_peers_lockfree
        // Genesis nodes connect at startup and are maintained via QUIC heartbeat
        self.connected_peers_lockfree
            .iter()
            .map(|entry| entry.value().addr.clone())
            .collect()
    }
    
    /// Get validator IDs for Byzantine threshold calculation
    /// SCALABLE: Uses connected peers - no hardcoded Genesis fallback
    pub fn get_validator_ids_from_peers(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.connected_peers_lockfree
            .iter()
            .map(|entry| entry.value().id.clone())
            .collect();
        
        // Add self (not in connected_peers)
        if !ids.contains(&self.node_id) {
            ids.push(self.node_id.clone());
        }
        
        ids.sort();
        ids
    }
    
    /// Clean up old timeout votes and certificates (memory management)
    /// v4.2: height parameter is now macroblock index (caller should pass height/90)
    pub fn cleanup_old_timeout_data(&self, current_height: u64) {
        let current_mb_index = current_height / 90;
        let min_mb = current_mb_index.saturating_sub(20);

        TIMEOUT_VOTES.retain(|(h, _), _| *h >= min_mb);
        TIMEOUT_CERTIFICATES.retain(|(h, _), _| *h >= min_mb);
        HIGHEST_CERTIFIED_ROUND.retain(|h, _| *h >= min_mb);
        // v15.11: per-mb baseline rounds share retention with HIGHEST_*_ROUND.
        LAST_FINALIZED_ROUND_PER_MB.retain(|h, _| *h >= min_mb);
        TIMEOUT_VOTED_HEIGHTS.retain(|h, _| *h >= min_mb);

        // ═══════════════════════════════════════════════════════════════════
        // v23 / v23.1: prune microblock-rotation-related DashMaps under the
        // same retention contract so memory stays flat for thousands of
        // super-nodes running for unbounded periods.
        //
        //   * LAST_TIMEOUT_EMIT_PER_MB — keyed by mb_idx. Same retention
        //     window as the rest of the per-mb state above.
        //   * STICKY_LEADER_PER_VIEW — keyed by `leadership_round`
        //     (= (height-1) / ROTATION_INTERVAL_BLOCKS). One leadership
        //     round covers 30 blocks; one macroblock covers 90 blocks =
        //     3 leadership rounds. Min retention = `(min_mb * 90) / 30
        //     - 3` (with an extra 3-round safety margin for views that
        //     started during the boundary transition between mbs).
        // ═══════════════════════════════════════════════════════════════════
        crate::node::LAST_TIMEOUT_EMIT_PER_MB.retain(|h, _| *h >= min_mb);
        let min_leadership_round = min_mb
            .saturating_mul(90)
            .saturating_div(crate::node::ROTATION_INTERVAL_BLOCKS)
            .saturating_sub(3);
        crate::node::STICKY_LEADER_PER_VIEW
            .retain(|lr, _| *lr >= min_leadership_round);

        // Retention floor shared by the shred-chunk forward-dedup prune below.
        let min_gap_height = min_mb.saturating_mul(90);

        // v25: prune stale entries from the validator-liveness tracker. A
        // validator whose last observed miss is older than the active
        // window has either recovered (its counter would be removed by
        // `record_validator_success`) or has fallen out of the active
        // committee entirely (counter is meaningless). Either way the
        // entry is safe to evict — re-entry into the committee starts
        // with a fresh counter.
        let min_liveness_height = min_mb.saturating_mul(90);
        VALIDATOR_CONSECUTIVE_MISSES
            .retain(|_, (_, last_h)| *last_h >= min_liveness_height);
        // EJECTED_VALIDATORS is not pruned here — entries are removed by
        // `record_validator_success` on heartbeat recovery. Keeping a
        // permanently-offline validator in the ejected set is the entire
        // point; it stays out until it proves it's alive again.

        // v25 H12: prune per-chunk forward-dedup entries for blocks that
        // have already been applied. The block-level `processed_shred_blocks`
        // gate above short-circuits forward attempts for these heights, but
        // the dedup set keeps growing per (height, chunk_index) until pruned.
        // We drop everything below the current retention window so the set
        // stays bounded by recent activity.
        prune_forwarded_shred_chunks_below(min_gap_height);
    }
    
    /// Handle emergency producer change notifications with sender tracking
    #[allow(dead_code)]
    pub(super) fn handle_emergency_producer_change_with_sender(
        &self, 
        failed_producer: String, 
        new_producer: String, 
        block_height: u64,
        change_type: String,
        timestamp: u64,
        sender_addr: String  // Track who sent the emergency
    ) {
        // Forward to main handler with sender info
        self.handle_emergency_producer_change_internal(
            failed_producer, new_producer, block_height, change_type, timestamp,
            Some(sender_addr)
        );
    }
    
    /// Handle emergency producer change notifications (backward compatibility)
    #[allow(dead_code)]
    pub(super) fn handle_emergency_producer_change(
        &self, 
        failed_producer: String, 
        new_producer: String, 
        block_height: u64,
        change_type: String,
        timestamp: u64
    ) {
        // Forward to main handler without sender info (for backward compatibility)
        self.handle_emergency_producer_change_internal(
            failed_producer, new_producer, block_height, change_type, timestamp,
            None
        );
    }
    
    /// Internal handler for emergency producer change with optional sender tracking
    /// DEPRECATED v4.0: Use BFT Timeout Protocol instead
    #[allow(dead_code)]
    pub(super) fn handle_emergency_producer_change_internal(
        &self,
        _failed_producer: String,
        _new_producer: String,
        block_height: u64,
        _change_type: String,
        _timestamp: u64,
        _sender_addr: Option<String>  // Optional sender for tracking false emergencies
    ) {
        // v4.0: EmergencyProducerChange is deprecated - use BFT Timeout Protocol
        // This message is ignored - failover is now handled by TimeoutVote consensus
        if crate::node::is_debug() {
            println!("[DBG][DEPRECATED] EmergencyProducerChange ignored h={} - use BFT Timeout Protocol", block_height);
        }
        // Early return - rest of function is deprecated
    }
    
    /// DEPRECATED v4.0: Old emergency handler code - kept for reference
    #[allow(dead_code)]
    #[allow(deprecated)]
    pub(super) fn _deprecated_handle_emergency_producer_change_internal(
        &self,
        failed_producer: String,
        new_producer: String,
        block_height: u64,
        change_type: String,
        timestamp: u64,
        sender_addr: Option<String>
    ) {
        // SAFE: Check if Tokio runtime is available to prevent panic
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => {
                if crate::node::is_info() {
                    println!("[WARN][CONS] WARN: No Tokio runtime - emergency handler skipped");
                }
                return;
            }
        };

        // CRITICAL FIX: Check message age to prevent stale message spam
        // ARCHITECTURE: Emergency messages have 60-second TTL to prevent network pollution
        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        if timestamp > 0 && current_time > timestamp {
            let message_age = current_time - timestamp;
            if message_age > 60 {
                // Message is too old - ignore silently to prevent spam
                return;
            }
        }
        
        // CRITICAL FIX: Ignore macroblock failovers - they don't affect microblock production
        // Macroblocks are separate consensus process and should NOT stop microblock production
        // Only microblock failovers should trigger production changes
        if change_type == "macroblock" {
            if crate::node::is_info() {
                println!("[WARN][CONS] macroblock_failover h={} action=ignore reason=microblock_production_continues", block_height);
            }
            if crate::node::is_info() {
                println!("[INFO][CONS] Macroblocks are separate Byzantine consensus, no impact on microblocks");
            }
            return;
        }
        
        // CRITICAL FIX: Filter out early block failovers to prevent spam
        // Block #1 issue is known and will be fixed by height increment fix
        if block_height <= 1 {
            // Don't even log these - they create too much noise
            return;
        }
        
        // CRITICAL: Prevent processing duplicate emergency messages for same block
        // Multiple nodes may send same emergency notification causing issues
        static LAST_EMERGENCY_HEIGHT: Lazy<Arc<AtomicU64>> = Lazy::new(|| Arc::new(AtomicU64::new(0)));
        let last_height = LAST_EMERGENCY_HEIGHT.load(Ordering::Relaxed);
        
        if last_height == block_height && failed_producer == self.node_id {
            if crate::node::is_info() {
                println!("[WARN][CONS] Duplicate emergency message for block #{} - ignoring", block_height);
            }
            return;
        }
        
        // Update last processed height if we're the failed producer
        if failed_producer == self.node_id {
            LAST_EMERGENCY_HEIGHT.store(block_height, Ordering::Relaxed);
        }
        
        // CRITICAL FIX: Validate emergency message against LOCAL blockchain state
        // SECURITY: Don't trust emergency messages blindly - verify we actually need failover
        // v9.0: Acquire ordering — failover decisions depend on accurate height
        let local_height = LOCAL_BLOCKCHAIN_HEIGHT.load(Ordering::Acquire);
        
        // VALIDATION #1: Ignore failover for blocks too far in the future
        if block_height > local_height + 10 {
            if crate::node::is_info() {
                println!("[WARN][CONS] Ignoring emergency for block #{} - too far ahead (local: {})",
                         block_height, local_height);
            }
            return;
        }
        
        // VALIDATION #2: Check if we ALREADY HAVE this block
        // If we have the block, the original producer succeeded - ignore emergency message
        // This prevents genesis_node_005 (stuck at height 0) from triggering false emergencies
        if block_height <= local_height {
            // We already have this block - check if it exists in storage
            // Use external storage check via static method (no self reference needed)
            // ARCHITECTURE: Emergency messages should only be trusted if we're also missing the block
            if crate::node::is_info() {
                println!("[INFO][CONS] Block #{} already processed (local height: {}) - ignoring emergency",
                         block_height, local_height);
            }
            return;
        }
        
        // CRITICAL FIX: Deduplicate failover messages to prevent processing same event multiple times
        let failover_key = (block_height, failed_producer.clone(), new_producer.clone());
            
        // SCALABILITY: DashSet provides lock-free concurrent access for millions of nodes
        if !PROCESSED_FAILOVERS.insert(failover_key.clone()) {
            // Already processed this exact failover event (insert returns false if already exists)
            if crate::node::is_info() {
                println!("[WARN][CONS] Duplicate emergency for block #{} - ignoring", block_height);
            }
            
            // SECURITY: Track duplicate emergency from sender as potential spam
            if let Some(sender) = &sender_addr {
                if crate::node::is_info() {
                    println!("[WARN][SECURITY] Duplicate emergency from {} for block #{}", sender, block_height);
                }
                // Could apply penalty for spam in future
            }
            return;
        }
        
        // CLEANUP: Remove old entries to prevent memory leak (keep last 1000 events)
        // Only cleanup periodically to avoid overhead
        if PROCESSED_FAILOVERS.len() > 1000 {
            let min_height = block_height.saturating_sub(500);
            PROCESSED_FAILOVERS.retain(|(h, _, _)| *h >= min_height);
        }
        
        if crate::node::is_info() {
            println!("[INFO][CONS] Processing emergency {} producer change notification", change_type);
        }
        
        // CHECK FOR CRITICAL ATTACKS
        let is_critical_attack = change_type.contains("CRITICAL") || 
                                  change_type == "CRITICAL_STORAGE_DELETION" ||
                                  change_type == "DATABASE_SUBSTITUTION" ||
                                  change_type == "CHAIN_FORK";
        
        if is_critical_attack {
            if crate::node::is_info() {
                println!("[ERR][SECURITY] CRITICAL ATTACK DETECTED! ");
            }
            if crate::node::is_info() {
                println!("[ERR][SECURITY] Producer: {} committed CRITICAL violation!", failed_producer);
            }
            if crate::node::is_info() {
                println!("[ERR][SECURITY] Attack type: {} at block #{}", change_type, block_height);
            }
            if crate::node::is_info() {
                println!("[ERR][SECURITY] APPLYING INSTANT MAXIMUM BAN (1 YEAR)!");
            }
            
            // Report Byzantine attack as slashing event
            self.report_invalid_block(
                &failed_producer, 
                block_height, 
                [0u8; 32], 
                &format!("Critical Byzantine attack: {}", change_type)
            );
            
            // v2.21.5: Jails now via slashing events in macroblock
            // Report as storage manipulation offense for next macroblock
            if crate::node::is_info() {
                println!("[WARN][CONS] {} flagged for {} - will be jailed in next macroblock via slashing event",
                         failed_producer, change_type);
            }
            
            // PRIVACY: Use pseudonym for logging
            let display_id = if failed_producer.starts_with("genesis_node_") || failed_producer.starts_with("node_") || failed_producer.starts_with("super_") {
                failed_producer.clone()
            } else {
                get_privacy_id_for_addr(&failed_producer)
            };
            if crate::node::is_info() {
                println!("[INFO][SECURITY] Node {} banned for 1 year, reputation destroyed", display_id);
            }
            return;
        }
        
        // PRIVACY: Use privacy-preserving identifiers in logs
        // CRITICAL FIX: Don't double-convert if already a pseudonym
        let failed_display = if failed_producer.starts_with("genesis_node_") || failed_producer.starts_with("node_") || failed_producer.starts_with("super_") {
            failed_producer.clone()
        } else {
            get_privacy_id_for_addr(&failed_producer)
        };
        let new_display = if new_producer.starts_with("genesis_node_") || new_producer.starts_with("node_") {
            new_producer.clone()
        } else {
            get_privacy_id_for_addr(&new_producer)
        };
        
        if crate::node::is_info() {
            println!("[ERR][CONS] Failed producer: {} at block #{}", failed_display, block_height);
        }
        if crate::node::is_info() {
            println!("[INFO][CONS] new_producer={} reason=emergency_activation", new_display);
        }
        
        // CRITICAL: If WE are the failed producer, VERIFY before stopping
        // Protection against false failover claims
        if failed_producer == self.node_id {
            // Check if we're actually a block-producing node
            match self.node_type {
                NodeType::Super => {
                    // CRITICAL FIX: Check if we're actively producing blocks
                    // Protect against false failover from competing nodes
                    use crate::node::{LAST_BLOCK_PRODUCED_TIME, LAST_BLOCK_PRODUCED_HEIGHT};
                    let last_produced_time = LAST_BLOCK_PRODUCED_TIME.load(Ordering::Relaxed);
                    let last_produced_height = LAST_BLOCK_PRODUCED_HEIGHT.load(Ordering::Relaxed);
                    let current_time = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    
                    // Check if we produced a block in the last 5 seconds
                    let time_since_last_production = current_time.saturating_sub(last_produced_time);
                    
                    // CRITICAL FIX: Enhanced protection for Genesis/startup phase
                    // On first blocks (1-10), multiple nodes may claim to be producer due to race conditions
                    // We need stronger protection during network initialization
                    let is_early_blocks = block_height <= 10;
                    let recently_produced = time_since_last_production <= 5 && last_produced_height > 0;
                    let startup_protection = is_early_blocks && last_produced_height == 0 && time_since_last_production <= 10;
                    
                    // PRODUCTION VALUES: 
                    // - Normal: 5 seconds timeout (allows for 1-2 missed blocks)
                    // - Startup: 10 seconds timeout (allows for Genesis sync delays)
                    if recently_produced || startup_protection {
                        if crate::node::is_info() {
                            println!("[WARN][CONS] FALSE FAILOVER DETECTED!");
                        }
                        
                        if recently_produced {
                            if crate::node::is_info() {
                                println!("[INFO][CONS] We produced block #{} just {}s ago",
                                        last_produced_height, time_since_last_production);
                            }
                            if crate::node::is_info() {
                                println!("[INFO][CONS] Ignoring false failover - we ARE actively producing!");
                            }
                        } else if startup_protection {
                            if crate::node::is_info() {
                                println!("[INFO][CONS] Genesis phase protection: Block #{} (startup phase)", block_height);
                            }
                            if crate::node::is_info() {
                                println!("[INFO][CONS] Node initialized {}s ago - too early for legitimate failover",
                                        time_since_last_production);
                            }
                            if crate::node::is_info() {
                                println!("[INFO][CONS] Ignoring false failover - network still initializing!");
                            }
                        }
                        
                        // Track false failovers from this peer
                        if crate::node::is_info() {
                            println!("[WARN][CONS] False failover claiming new producer: {}", new_producer);
                        }
                        if crate::node::is_info() {
                            println!("[INFO][CONS] This may indicate race condition or network delay");
                        }
                        // Could track reputation penalty for false failovers here in future
                        
                        // DO NOT STOP - continue producing blocks
                        return;
                    }
                    
                    // v3.4 CRITICAL: Check if broadcast is in progress
                    // If we're mid-broadcast, DO NOT stop! Interrupting broadcast causes partial blocks
                    // which leaves ALL nodes stuck waiting for data that will never arrive
                    if BLOCK_BROADCAST_IN_PROGRESS.load(Ordering::SeqCst) {
                        if crate::node::is_warn() {
                            println!("[WARN][FAILOVER] broadcast_in_progress=true ignoring_emergency h={}", block_height);
                        }
                        return;
                    }
                    
                    // We haven't produced recently - accept the failover
                    if crate::node::is_info() {
                        println!("[INFO][CONS] Accepting failover - last production was {}s ago",
                                time_since_last_production);
                    }
                    if crate::node::is_info() {
                        println!("[INFO][CONS] STOPPING block production");
                    }
                    
                    EMERGENCY_STOP_PRODUCTION.store(true, Ordering::Relaxed);
                    // CRITICAL: Only set stop height if not already set (prevent reset by multiple messages)
                    let current_stop_height = EMERGENCY_STOP_HEIGHT.load(Ordering::Relaxed);
                    if current_stop_height == 0 {
                        EMERGENCY_STOP_HEIGHT.store(block_height, Ordering::Relaxed);
                        EMERGENCY_STOP_TIME.store(current_time, Ordering::Relaxed);
                        
                        // v3.3: Calculate end of rotation cycle - stop until rotation boundary
                        let rotation_interval = 30u64;
                        let current_cycle = block_height / rotation_interval;
                        let cycle_end = (current_cycle + 1) * rotation_interval;
                        let remaining_in_cycle = cycle_end.saturating_sub(block_height);
                        
                        if crate::node::is_info() {
                            println!("[INFO][RECOVERY] stop_until_rotation h={} cycle_end={} remaining={}", 
                                     block_height, cycle_end, remaining_in_cycle);
                        }
                    } else {
                        if crate::node::is_info() {
                            println!("[INFO][RECOVERY] already_stopped at_h={}", current_stop_height);
                        }
                    }
                    // Main loop will check this flag and stop producing blocks
                    // This prevents fork creation when emergency failover happens
                },
                NodeType::Light => {
                    // Light nodes don't produce blocks, so no need to stop
                    if crate::node::is_info() {
                        println!("[ERR][CONS] Light node marked as failed producer (ignored - we don't produce blocks)");
                    }
                }
            }
        }
        
        // v3.3: Check if we should clear the emergency stop
        // Emergency stop lasts until END OF ROTATION CYCLE (30 blocks), not just 10
        // This ensures emergency producer has exclusive control for entire cycle
        if EMERGENCY_STOP_PRODUCTION.load(Ordering::Relaxed) {
            let stop_height = EMERGENCY_STOP_HEIGHT.load(Ordering::Relaxed);
            let stop_time = EMERGENCY_STOP_TIME.load(Ordering::Relaxed);
            let current_time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            
            // v3.3: Calculate rotation boundary for the cycle when stop was triggered
            let rotation_interval = 30u64;
            let stop_cycle = stop_height / rotation_interval;
            let cycle_end = (stop_cycle + 1) * rotation_interval;
            
            // Clear when we've passed the rotation boundary OR 60 seconds (safety timeout)
            let seconds_passed = if current_time > stop_time { current_time - stop_time } else { 0 };
            
            if stop_height > 0 && (block_height >= cycle_end || seconds_passed >= 60) {
                if crate::node::is_info() {
                    println!("[INFO][RECOVERY] stop_cleared h={} cycle_end={} reason={}", 
                            block_height, cycle_end,
                            if block_height >= cycle_end { "rotation_complete" } else { "timeout_60s" });
                }
                EMERGENCY_STOP_PRODUCTION.store(false, Ordering::Relaxed);
                EMERGENCY_STOP_HEIGHT.store(0, Ordering::Relaxed);
                EMERGENCY_STOP_TIME.store(0, Ordering::Relaxed);
            }
        }
        
        // CRITICAL FIX: Don't penalize placeholder nodes only
        if failed_producer == "unknown_leader" || 
           failed_producer == "no_leader_selected" || 
           failed_producer == "consensus_lock_failed" {
            if crate::node::is_info() {
                println!("[WARN][REP] Skipping penalty for placeholder producer: {}", failed_producer);
            }
            return;
        }
        
        // PRODUCTION FIX: Don't penalize during Genesis bootstrap (first 100 blocks)
        // Technical issues are expected during network initialization
        let is_genesis_bootstrap = std::env::var("QNET_BOOTSTRAP_ID")
            .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
            .unwrap_or(false);
        
        if is_genesis_bootstrap && block_height < 100 {
            if crate::node::is_info() {
                println!("[WARN][REP] Genesis bootstrap phase (block {}): No penalty for {} (technical issues expected)",
                         block_height, failed_display);
            }
            // Still record the event but without reputation penalty
            if crate::node::is_info() {
                println!("[INFO][P2P] Emergency producer change recorded | Type: {} | Height: {} | Time: {}",
                         change_type, block_height, timestamp);
            }
            
            // Emergency producer reward will be processed via block production
            // DeterministicReputationState.process_block() handles rewards
            return;
        }
        
        // ═══════════════════════════════════════════════════════════════════════════
        // v2.104: CRITICAL FIX - Set emergency producer flag on ALL nodes
        // ═══════════════════════════════════════════════════════════════════════════
        // PROBLEM (before v2.104):
        //   - Only the new emergency producer set the flag
        //   - Other nodes didn't know about emergency → continued using VRF result
        //   - VRF returned failed producer → network deadlock!
        //
        // SOLUTION (v4.0: BFT Timeout Protocol replaces emergency broadcast):
        //   - ALL nodes receiving timeout certificate increment timeout_round
        //   - select_microblock_producer_with_round excludes failed producers
        //   - Deterministic failover — no broadcast needed
        // ═══════════════════════════════════════════════════════════════════════════
            use crate::node::set_emergency_producer_flag;
            
            set_emergency_producer_flag(block_height, new_producer.clone());
        
        if new_producer == self.node_id {
            if crate::node::is_info() {
                println!("[INFO][FAILOVER] we_are_emergency h={}", block_height);
            }
        } else if crate::node::is_debug() {
            println!("[DBG][FAILOVER] emergency_set h={} producer={}", block_height, new_producer);
        }
        
        // Log emergency change for network transparency
        if crate::node::is_info() {
            println!("[INFO][P2P] Emergency producer change recorded | Type: {} | Height: {} | Time: {}",
                     change_type, block_height, timestamp);
        }
        
        // CONSENSUS: Track emergency confirmations from multiple nodes
        // This provides lightweight Byzantine-like protection without full consensus overhead
        let confirmation_key = (block_height, failed_producer.clone());
        let confirmation_count = EMERGENCY_CONFIRMATIONS
            .entry(confirmation_key.clone())
            .or_insert((AtomicU64::new(0), Instant::now()))
            .0
            .fetch_add(1, Ordering::Relaxed) + 1;
        
        if crate::node::is_info() {
            println!("[INFO][CONS] Emergency for block #{}: {} confirmations", block_height, confirmation_count);
        }
        
        // CLEANUP: Remove old confirmation entries (keep last 100 blocks)
        if EMERGENCY_CONFIRMATIONS.len() > 100 {
            let min_height = block_height.saturating_sub(50);
            EMERGENCY_CONFIRMATIONS.retain(|(h, _), _| *h >= min_height);
        }
        
        // Log suspicious emergency for monitoring
        if let Some(sender) = &sender_addr {
            if crate::node::is_info() {
                println!("[INFO][SECURITY] Emergency from {} for block #{} - tracking", sender, block_height);
            }
        }
        
        // Request block immediately (synchronous part)
        if crate::node::is_info() {
            println!("[INFO][CONS] Requesting block #{} from network", block_height);
        }
        
        // Clone values for logging (async part will check consensus)
        let failed_producer_log = failed_producer.clone();
        let _new_producer_log = new_producer.clone();
        let block_height_log = block_height;
        let _sender_log = sender_addr.clone();
        
        // Schedule async verification without self reference
        handle.spawn(async move {
            // Step 1: Wait for block propagation (2 seconds)
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            
            // Step 2: Check if block arrived (using global state)
            // v9.0: Acquire ordering for consensus-critical failover check
            let final_height = LOCAL_BLOCKCHAIN_HEIGHT.load(Ordering::Acquire);
            
            if block_height_log <= final_height {
                if crate::node::is_info() {
                    println!("[INFO][CONS] Block #{} received - Producer {} is INNOCENT",
                             block_height_log, failed_producer_log);
                }
            } else {
                // Check consensus
                let conf_key = (block_height_log, failed_producer_log.clone());
                let confirmations = EMERGENCY_CONFIRMATIONS
                    .get(&conf_key)
                    .map(|entry| entry.0.load(Ordering::Relaxed))
                    .unwrap_or(1);
                
                if confirmations >= 3 {
                    // CONSENSUS REACHED: 3+ nodes confirm block missing
                    // Aggressive Catch-up in node.rs will handle resync (15s/5 blocks)
                    if crate::node::is_info() {
                        println!("[INFO][CONS] Block #{} missing - CONSENSUS REACHED ({} confirmations)",
                                 block_height_log, confirmations);
                    }
                    if crate::node::is_info() { 
                        println!("[INFO][TC] stall_confirmed h={} action=aggressive_catchup", block_height_log); 
                    }
                    
                } else if confirmations >= 2 {
                    if crate::node::is_warn() { 
                        println!("[WARN][TC] partial_consensus h={} conf={}", block_height_log, confirmations); 
                    }
                    
                } else {
                    if crate::node::is_debug() { 
                        println!("[DBG][TC] single_report h={}", block_height_log); 
                    }
                }
            }
        });
        
        if crate::node::is_debug() { println!("[DBG][FAILOVER] verify_scheduled timeout=2s"); }
        
        // ═══════════════════════════════════════════════════════════════════════════
        // ARCHITECTURE v2.38: ON-CHAIN SLASHING ONLY
        // ═══════════════════════════════════════════════════════════════════════════
        // Emergency notifications are for FAILOVER only, NOT for slashing!
        // 
        // Slashing is determined in MacroBlock creation by analyzing the blockchain:
        // 1. Emergency notification → triggers failover (continues the chain)
        // 2. Emergency producer creates block with their ID in block.producer
        // 3. At MacroBlock creation → analyze chain: assigned vs actual producer
        // 4. If assigned ≠ actual → slashing recorded in MacroBlock (deterministic)
        //
        // WHY ON-CHAIN: P2P-based slashing causes false positives:
        // - Race conditions (slashing before block propagates)
        // - Network issues (receiver's problem ≠ producer's fault)
        // - Non-determinism (nodes see different confirmation counts)
        //
        // ON-CHAIN slashing is deterministic - all nodes analyze same blockchain!
        // ═══════════════════════════════════════════════════════════════════════════
        
        // Log emergency for monitoring (NO slashing action here!)
        if crate::node::is_info() {
            println!("[INFO][FAILOVER] emergency_recorded producer={} h={} new_producer={}", 
                     failed_producer, block_height, new_producer);
        }
        if crate::node::is_info() {
            println!("[INFO][FAILOVER] slashing=deferred_to_macroblock reason=on_chain_analysis");
        }
    }
    
    
    
    
    
    
    
    
    
    
    
    /// Check if a node is a genesis/bootstrap node that should be protected
    pub(super) fn is_genesis_node(&self, node_id: &str) -> bool {
        // Check if it's a genesis node by ID pattern
        if node_id.starts_with("genesis_node_") {
            return true;
        }
        
        // Check if current node has bootstrap ID (genesis nodes know each other)
        if let Ok(bootstrap_id) = std::env::var("QNET_BOOTSTRAP_ID") {
            if ["001", "002", "003", "004", "005"].contains(&bootstrap_id.as_str()) {
                // This is a genesis node, check if peer is also genesis
                if node_id.ends_with("_001") || node_id.ends_with("_002") || 
                   node_id.ends_with("_003") || node_id.ends_with("_004") || 
                   node_id.ends_with("_005") {
                    return true;
                }
            }
        }
        
        false
    }
    
    /// Track invalid certificate from a node for malicious behavior detection
    /// SECURITY: Escalating punishment - 5 invalid certs in 10 minutes = ban
    pub fn track_invalid_certificate(&self, node_id: &str, reason: &str) {
        // Read-and-drop: the entry guard locks its shard, and the remove() calls below on the
        // SAME map would self-deadlock the calling thread if the guard were still alive.
        let (count, elapsed) = {
            let entry = INVALID_CERT_TRACKER
                .entry(node_id.to_string())
                .or_insert((AtomicU64::new(0), Instant::now()));
            (entry.0.fetch_add(1, Ordering::Relaxed) + 1, entry.1.elapsed())
        };

        if crate::node::is_info() {
            println!("[WARN][SECURITY] Invalid certificate from {}: {} (count: {}, window: {}s)",
                     node_id, reason, count, elapsed.as_secs());
        }
        
        // CRITICAL: Escalating punishment for certificate violations
        // 5 invalid certificates in 10 minutes → critical attack (ban)
        // Certificates are more critical than blocks (lower threshold)
        
        if count >= 5 && elapsed < Duration::from_secs(600) {
            // PROTECTION: Genesis nodes get warnings but no bans
            if self.is_genesis_node(node_id) {
                if crate::node::is_info() {
                    println!("[WARN][SECURITY] Genesis node {} has {} invalid certificates - WARNING ONLY",
                             node_id, count);
                }
                if crate::node::is_info() {
                    println!("[INFO][SECURITY] Genesis nodes are protected from automatic bans");
                }
                // Record slashing event but Genesis nodes protected from ban
                let current_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                self.report_invalid_block(node_id, current_height, [0u8; 32], "Genesis node: 5+ invalid certificates");
                INVALID_CERT_TRACKER.remove(node_id);
                return;
            }
            
            // CRITICAL ATTACK: 5+ invalid certificates in 10 minutes = malicious node
            if crate::node::is_info() {
                println!("[ERR][SECURITY] CERTIFICATE ATTACKER DETECTED! ");
            }
            if crate::node::is_info() {
                println!("[ERR][SECURITY] Node: {} sent {} invalid certificates in {} seconds",
                         node_id, count, elapsed.as_secs());
            }
            if crate::node::is_info() {
                println!("[ERR][SECURITY] APPLYING INSTANT BAN!");
            }
            
            // Report as critical attack
            let _ = self.report_critical_attack(
                node_id,
                0,  // No block height for certificate attacks
                &format!("Repeated invalid certificates: {} in {}s - {}", count, elapsed.as_secs(), reason)
            );
            
            // Clear tracker after ban
            INVALID_CERT_TRACKER.remove(node_id);
        } else if count == 3 {
            // Warning level - record slashing evidence
            if crate::node::is_info() {
                println!("[WARN][SECURITY] WARNING: {} has sent 3 invalid certificates", node_id);
            }
            let current_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
            self.report_invalid_block(node_id, current_height, [0u8; 32], "3 invalid certificates");
        }
    }
    
    /// Track invalid block from a producer for malicious behavior detection
    /// SECURITY: Soft punishment approach - tolerates occasional errors but bans repeated offenders
    pub fn track_invalid_block(&self, producer: &str, block_height: u64, reason: &str) {
        // Read-and-drop, same shard-deadlock rule as track_invalid_certificate.
        let (count, elapsed) = {
            let entry = INVALID_BLOCKS_TRACKER
                .entry(producer.to_string())
                .or_insert((AtomicU64::new(0), Instant::now()));
            (entry.0.fetch_add(1, Ordering::Relaxed) + 1, entry.1.elapsed())
        };

        if crate::node::is_info() {
            println!("[WARN][SECURITY] Invalid block from {}: {} (count: {}, window: {}s)",
                     producer, reason, count, elapsed.as_secs());
        }
        
        // CRITICAL: Soft punishment with escalation
        // 3 invalid blocks → warning + small penalty
        // 10 invalid blocks in 5 minutes → critical attack (1 year ban)
        
        if count >= 10 && elapsed < Duration::from_secs(300) {
            // CRITICAL ATTACK: 10+ invalid blocks in 5 minutes = malicious node
            if crate::node::is_info() {
                println!("[ERR][SECURITY] MALICIOUS NODE DETECTED! ");
            }
            if crate::node::is_info() {
                println!("[ERR][SECURITY] Producer: {} sent {} invalid blocks in {} seconds",
                         producer, count, elapsed.as_secs());
            }
            if crate::node::is_info() {
                println!("[ERR][SECURITY] APPLYING INSTANT BAN (1 YEAR)!");
            }
            
            // Report as critical attack
            let _ = self.report_critical_attack(
                producer,
                block_height,
                &format!("Repeated invalid signatures: {} blocks in {}s", count, elapsed.as_secs())
            );
            
            // Clear tracker after ban
            INVALID_BLOCKS_TRACKER.remove(producer);
            
        } else if count == 3 {
            // WARNING: 3 invalid blocks = possible bug or sync issue
            if crate::node::is_info() {
                println!("[WARN][SECURITY] WARNING: {} sent 3 invalid blocks", producer);
            }
            let current_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
            self.report_invalid_block(producer, current_height, [0u8; 32], "3 consecutive invalid blocks");
            
        } else if count == 5 {
            // ESCALATION: 5 invalid blocks = suspicious behavior
            if crate::node::is_info() {
                println!("[WARN][SECURITY] ESCALATION: {} sent 5 invalid blocks", producer);
            }
            let current_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
            self.report_invalid_block(producer, current_height, [0u8; 32], "5 consecutive invalid blocks (suspicious)");
        }
        
        // CLEANUP: Remove old entries after 5 minutes (prevent memory leak)
        // SCALABILITY: Periodic cleanup for millions of nodes
        if elapsed > Duration::from_secs(300) {
            INVALID_BLOCKS_TRACKER.remove(producer);
        }
        
        // SCALABILITY: Global cleanup every 1000 tracked nodes
        if INVALID_BLOCKS_TRACKER.len() > 1000 {
            let now = Instant::now();
            INVALID_BLOCKS_TRACKER.retain(|_, (_, first_seen)| {
                now.duration_since(*first_seen) < Duration::from_secs(300)
            });
        }
        
        // MEMORY CLEANUP: Also cleanup FALSE_EMERGENCY_TRACKER (peer-based, limited growth)
        if FALSE_EMERGENCY_TRACKER.len() > 500 {
            let now = Instant::now();
            FALSE_EMERGENCY_TRACKER.retain(|_, (_, first_seen)| {
                now.duration_since(*first_seen) < Duration::from_secs(600) // 10 min TTL
            });
        }
    }
    
    /// Check if emergency failover is already in progress for a specific block
    /// CRITICAL: Prevents race condition where multiple nodes trigger failover simultaneously
    pub fn check_emergency_in_progress(&self, failover_key: &str) -> bool {
        EMERGENCY_FAILOVERS_IN_PROGRESS.contains(failover_key)
    }
    
    /// Mark emergency failover as in progress (returns false if already marked)
    /// CRITICAL: Lock-free atomic operation for scalability to millions of nodes
    pub fn mark_emergency_in_progress(&self, failover_key: &str) -> bool {
        // insert() returns true if the key was not present before
        let was_inserted = EMERGENCY_FAILOVERS_IN_PROGRESS.insert(failover_key.to_string());
        
        if was_inserted {
            if crate::node::is_info() {
                println!("[INFO][CONS] Locked emergency failover: {}", failover_key);
            }
            
            // CLEANUP: Auto-remove after 30 seconds to prevent memory leak
            // SAFE: Check if Tokio runtime is available to prevent panic
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let key_clone = failover_key.to_string();
                handle.spawn(async move {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    EMERGENCY_FAILOVERS_IN_PROGRESS.remove(&key_clone);
                    if crate::node::is_info() {
                        println!("[INFO][CONS] Auto-unlocked emergency failover: {}", key_clone);
                    }
                });
            }
        }

        was_inserted
    }
    
    /// Clear emergency failover lock (used when broadcast fails)
    pub fn clear_emergency_in_progress(&self, failover_key: &str) {
        EMERGENCY_FAILOVERS_IN_PROGRESS.remove(failover_key);
        if crate::node::is_info() {
            println!("[INFO][CONS] Cleared emergency failover lock: {}", failover_key);
        }
    }
    
    /// Report critical attack to network for instant ban
    pub fn report_critical_attack(
        &self,
        attacker: &str,
        block_height: u64,
        evidence: &str
    ) -> Result<(), String> {
        // ═══════════════════════════════════════════════════════════════════════════
        // v4.0: Attack detection - NO broadcast, only logging for on-chain slashing
        // 
        // ARCHITECTURE:
        // 1. Detect attack locally
        // 2. Log evidence (for monitoring and future slashing queue)
        // 3. Evidence will be included in MacroBlock by macroblock producer
        // 4. On-chain slashing reduces attacker reputation
        // 5. BFT Timeout Protocol handles failover if attacker was producer
        // ═══════════════════════════════════════════════════════════════════════════
        
        // Log for monitoring and future on-chain inclusion
        if crate::node::is_warn() {
            println!("[CRIT][SECURITY] attack_detected attacker={} h={}", attacker, block_height);
        }
        if crate::node::is_warn() {
            println!("[CRIT][SECURITY] evidence={}", evidence);
        }
        if crate::node::is_info() {
            println!("[INFO][SECURITY] action=on_chain_slashing note=will_be_included_in_macroblock");
        }
        
        // TODO: Add to slashing evidence queue for inclusion in next MacroBlock
        // For now, detection is logged and macroblock producer will include if they also detect
        
        Ok(())
    }
    
    #[allow(dead_code)]
    pub(super) fn select_emergency_producer_excluding(&self, exclude: &str, height: u64) -> String {
        // v2.92: Use N-2 epoch-based snapshot for deterministic selection (SAME as node.rs!)
        // This ensures all nodes agree on emergency producer even for critical attacks
        
        // Get candidates from macroblock snapshot (MUST use N-2 for consistency!)
        // FIX v2.92: Was N-1, now N-2 to match calculate_qualified_candidates in node.rs
        let current_epoch = if height <= 90 { 1 } else { (height.saturating_sub(1)) / 90 + 1 };
        let macroblock_index = current_epoch.saturating_sub(2);  // N-2!
        
        // Try to get from macroblock snapshot first
        // PRODUCTION v2.50: Lock-free storage access
        if macroblock_index > 0 {
            if let Some(storage) = crate::node::try_get_storage() {
                if let Ok(Some(mb_data)) = storage.get_macroblock_by_height(macroblock_index) {
                    if let Ok(macroblock) = bincode::deserialize::<qnet_state::MacroBlock>(&mb_data) {
                        if let Some(ref snapshot_data) = macroblock.consensus_data.eligible_producers {
                            if let Ok(producers) = bincode::deserialize::<Vec<qnet_state::EligibleProducer>>(snapshot_data) {
                                // Find first producer that isn't excluded
                                for p in &producers {
                                    if p.node_id != exclude {
                                        if crate::node::is_info() {
                                            println!("[INFO][SECURITY] Emergency producer from epoch snapshot: {}", p.node_id);
                                        }
                                        return p.node_id.clone();
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // Genesis epoch or fallback: use static Genesis list
        use crate::genesis_constants::GENESIS_NODE_IPS;
        for (_, id) in GENESIS_NODE_IPS.iter() {
            let node_id = format!("genesis_node_{}", id);
            if node_id != exclude {
                if crate::node::is_info() {
                    println!("[INFO][SECURITY] Emergency producer from Genesis: {}", node_id);
                }
                return node_id;
            }
        }
        
        // Ultimate fallback
        if self.node_id != exclude {
            self.node_id.clone()
        } else {
            "emergency_consensus".to_string()
        }
    }
    
    /// DEPRECATED v4.0: Use BFT Timeout Protocol instead
    #[deprecated(since = "4.0.0", note = "Use BFT Timeout Protocol for failover")]
    #[allow(dead_code)]
    #[allow(deprecated)]
    pub fn broadcast_emergency_producer_change(
        &self, 
        failed_producer: &str, 
        new_producer: &str, 
        block_height: u64,
        change_type: &str
    ) -> Result<(), String> {
        if crate::node::is_info() {
            println!("[INFO][CONS] Broadcasting emergency {} producer change to network", change_type);
        }
        
        // v2.51: Lock-free emergency broadcast
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        
        let mut successful_broadcasts = 0;
        let total_peers = self.connected_peers_lockfree.len();
        
        for entry in self.connected_peers_lockfree.iter() {
            let peer = entry.value();
            let emergency_msg = NetworkMessage::EmergencyProducerChange {
                failed_producer: failed_producer.to_string(),
                new_producer: new_producer.to_string(),
                block_height,
                change_type: change_type.to_string(),
                timestamp,
                sender_node_id: Some(self.node_id.clone()),
            };
            
            self.send_network_message(&peer.addr, emergency_msg);
            successful_broadcasts += 1;
        }
        
        if crate::node::is_info() {
            println!("[INFO][FAIL] emergency_broadcast success={}/{}", successful_broadcasts, total_peers);
        }
        
        Ok(())
    }
    
    // ============================================================================
    // SYNC OPTIMIZATION: Peer Blacklist Methods
    // ============================================================================
    
    /// Add peer to blacklist with reason and duration
    /// ARCHITECTURE: Soft blacklist (network) vs Hard blacklist (Byzantine)
    /// SCALABILITY: Lock-free DashMap for millions of nodes
    pub fn add_to_blacklist(&self, peer_addr: &str, reason: BlacklistReason) {
        let (duration_secs, escalation) = match reason {
            // SOFT BLACKLIST: Temporary (network performance)
            BlacklistReason::SlowResponse => (15, 15),   // 15s base, +15s per violation
            BlacklistReason::SyncTimeout => (30, 30),    // 30s base, +30s per violation
            BlacklistReason::ConnectionFailure => (60, 60), // 60s base, +60s per violation

            // HARD BLACKLIST: Permanent until reputation recovered (Byzantine)
            BlacklistReason::InvalidBlocks | BlacklistReason::MaliciousBehavior => (0, 0),

            // IDENTITY-HARD BLACKLIST: Permanent for the lifetime of the
            // attacker keypair. duration_secs=0 → permanent in the
            // existing `BlacklistEntry::is_active` semantics; the
            // sync-peer filter never auto-recovers a PkImpersonation
            // peer because its `consensus_qualified` cannot recover
            // (every consensus message it sends fails Tier-2 verify).
            BlacklistReason::PkImpersonation => (0, 0),
        };
        
        // Check if already blacklisted (escalation logic)
        let (final_duration, attempts) = if let Some(mut entry) = PEER_BLACKLIST.get_mut(peer_addr) {
            // Escalate duration for repeated violations
            let new_attempts = entry.attempts + 1;
            let escalated_duration = if duration_secs > 0 {
                duration_secs + (escalation * new_attempts as u64)
            } else {
                0 // Permanent
            };
            entry.timestamp = Instant::now();
            entry.duration_secs = escalated_duration;
            entry.attempts = new_attempts;
            entry.reason = reason;
            (escalated_duration, new_attempts)
        } else {
            // First violation
            let entry = BlacklistEntry {
                reason,
                timestamp: Instant::now(),
                duration_secs,
                attempts: 1,
            };
            PEER_BLACKLIST.insert(peer_addr.to_string(), entry);
            (duration_secs, 1)
        };
        
        if final_duration > 0 {
            if crate::node::is_info() {
                println!("[INFO][SECURITY] SOFT: {} blacklisted for {}s (reason: {:?}, attempt: {})",
                         peer_addr, final_duration, reason, attempts);
            }
        } else {
            if crate::node::is_info() {
                println!("[WARN][SECURITY] HARD: {} permanently blacklisted (reason: {:?})",
                         peer_addr, reason);
            }
        }
    }
    
    /// Check if peer is currently blacklisted
    /// Returns (is_blacklisted, reason, remaining_secs)
    pub fn is_blacklisted(&self, peer_addr: &str) -> (bool, Option<BlacklistReason>, u64) {
        if let Some(entry) = PEER_BLACKLIST.get(peer_addr) {
            if entry.is_active() {
                return (true, Some(entry.reason), entry.remaining_secs());
            } else {
                // Entry expired - remove it
                drop(entry);
                PEER_BLACKLIST.remove(peer_addr);
            }
        }
        (false, None, 0)
    }
    
    /// Remove peer from blacklist (manual override or reputation recovered)
    pub fn remove_from_blacklist(&self, peer_addr: &str) {
        if let Some((_, entry)) = PEER_BLACKLIST.remove(peer_addr) {
            if crate::node::is_info() {
                println!("[INFO][SECURITY] Removed {} from blacklist (reason: {:?})",
                         peer_addr, entry.reason);
            }
        }
    }

    // ========================================================================
    // PERMANENT PK BLACKLIST (cryptographic identity impersonation)
    // ========================================================================
    // SECURITY: This surface is keyed by the SHA3-256 fingerprint of the
    // attacker's ML-DSA-65 public key — NOT by peer_addr (which the
    // attacker controls) or node_id (which the attacker spoofs).
    // Canonical state lives in `qnet_consensus::consensus_crypto`; these
    // wrappers expose it through the SimplifiedP2P facade so call sites
    // do not need to take a direct dependency on the lower-level crate.
    //
    // The PEER_BLACKLIST entry keyed by peer_addr is a SECONDARY hint
    // populated alongside the canonical PK entry: it lets the existing
    // sync-peer selector strip the attacker's last-known address
    // without an extra crypto check. The authoritative gate still runs
    // at the QUIC handshake / dispatcher layer on the presented PK.

    /// O(1) check against the attacker-PK set.
    ///
    /// NOT a gate any more. The signature verifier used to early-return on a blacklisted key, which made
    /// an acceptance verdict depend on per-process RAM populated by gossip — two nodes could disagree on
    /// the same message. That early-return was removed and nothing calls this today; it is retained only
    /// as an operator/telemetry read. Do NOT reintroduce it into a verification path.
    #[allow(dead_code)]
    pub fn is_pk_blacklisted(&self, extracted_pk: &[u8]) -> bool {
        qnet_consensus::consensus_crypto::is_pk_blacklisted(extracted_pk)
    }

    /// Telemetry counter — number of distinct attacker PKs retained
    /// in-memory. Exposed for the operator dashboard.
    pub fn attacker_pk_blacklist_len(&self) -> usize {
        qnet_consensus::consensus_crypto::attacker_pk_blacklist_len()
    }

    /// Report a cryptographic impersonation event. Called from the
    /// upstream defence layers (consensus_crypto's Tier-2 reject site
    /// is the canonical install point — this wrapper exists for
    /// integration-side detectors such as the QUIC handshake when it
    /// gains structural PK extraction).
    ///
    /// Side effects:
    ///   * Adds the PK fingerprint to the permanent blacklist
    ///     (persisted via the registered callback if any).
    ///   * Adds `peer_addr` (when supplied) to the peer-addr layer with
    ///     `BlacklistReason::PkImpersonation` so the sync-peer
    ///     selector picks up the deny immediately.
    pub fn report_pk_impersonation(
        &self,
        extracted_pk: &[u8],
        claimed_node_id: &str,
        peer_addr: Option<&str>,
    ) {
        let (_record, was_first) =
            qnet_consensus::consensus_crypto::record_attacker_pk(extracted_pk, claimed_node_id);
        if let Some(addr) = peer_addr {
            self.add_to_blacklist(addr, BlacklistReason::PkImpersonation);
        }
        if was_first {
            if crate::node::is_warn() {
                println!(
                    "[CRIT][SECURITY] pk_impersonation_recorded node={} pk_total={} action=permanent_ban",
                    claimed_node_id,
                    self.attacker_pk_blacklist_len(),
                );
            }
        }
    }

    /// Operator override: remove a single attacker PK fingerprint
    /// (e.g. confirmed false positive caused by an off-chain
    /// key-rotation flow that has since reconciled). Returns `true`
    /// when an entry was actually present.
    pub fn clear_attacker_pk(&self, fingerprint: &[u8; 32]) -> bool {
        let removed = qnet_consensus::consensus_crypto::clear_attacker_pk(fingerprint);
        if removed && crate::node::is_info() {
            println!(
                "[INFO][SECURITY] attacker_pk_cleared fp={}.. by=operator",
                hex::encode(&fingerprint[..8]),
            );
        }
        removed
    }

    /// Operator override: clear the entire in-memory PK blacklist.
    /// Returns the number of entries removed. Intended for dev-resets
    /// and post-incident reconciliation; production operators are
    /// expected to clear single entries.
    pub fn clear_attacker_pk_blacklist_all(&self) -> usize {
        let n = qnet_consensus::consensus_crypto::clear_attacker_pk_blacklist_all();
        if n > 0 && crate::node::is_info() {
            println!(
                "[WARN][SECURITY] attacker_pk_blacklist_cleared_all entries={} by=operator",
                n,
            );
        }
        n
    }
    
    /// Get peers for sync with blacklist filtering and prioritization
    /// ARCHITECTURE: Filter by blacklist, node type (Light excluded), and reputation
    /// SCALABILITY: Returns top-N peers sorted by latency and reputation
    /// CRITICAL: Light nodes NEVER included as sync SOURCE — they are pure
    /// mobile API clients with zero on-device chain storage; they have no
    /// blocks to serve. This filter is mandatory for correctness, not just
    /// an optimization.
    /// v9.3: Added `min_height` parameter — only return peers whose `last_block_height >= min_height`.
    /// This prevents requesting blocks from peers that don't have them (empty_range responses).
    pub fn get_sync_peers_filtered(&self, max_peers: usize) -> Vec<PeerInfo> {
        self.get_sync_peers_filtered_by_height(max_peers, 0)
    }

    /// v9.3: Sync peer selection with height filter.
    /// Only returns peers whose last_block_height >= min_height.
    pub fn get_sync_peers_filtered_by_height(&self, max_peers: usize, min_height: u64) -> Vec<PeerInfo> {
        // v16.1: TWO-PASS canonical-aware sync peer selection.
        //
        // Pass 1 collects all peers that pass the legacy filters (height,
        // node type, blacklist, reputation).
        //
        // Pass 2 splits the candidates into "fork-cooldown clean" and
        // "fork-cooldown tagged" buckets. Tagged peers are those that
        // recently supplied blocks of a branch we rolled back from
        // (Phase 4.B `mark_peer_as_fork_source`). The selector returns
        // the clean bucket first; only if the clean bucket is empty
        // does it fall back to tagged peers (preferring suspect peers
        // over no peers — liveness over caution when nothing else is
        // available).
        //
        // This breaks the v15.x rollback cascade: after a rollback at
        // h=N, the f+1 peers that pushed the forked branch are skipped
        // for the resync window so we don't immediately re-download the
        // same forked blocks they originally sent. Recovery converges
        // on the canonical chain via different peers within the
        // 5-minute cooldown window.
        //
        // Scalability: O(N) over candidate count (already bounded by
        // committee size). At 1000-validator committee the two-pass
        // sort runs in microseconds. At 100k network most peers won't
        // be in the cooldown map (which is bounded to recent fork
        // events only), so the clean bucket dominates.
        let mut eligible_peers: Vec<PeerInfo> = self.connected_peers_lockfree.iter()
            .filter_map(|entry| {
                let peer = entry.value().clone();

                // CRITICAL: Light nodes are NOT sync sources — they store
                // zero blockchain data on-device (pure mobile API clients).
                if peer.node_type == NodeType::Light {
                    return None;
                }

                // v9.3: Skip peers that don't have the blocks we need
                if min_height > 0 && peer.last_block_height < min_height {
                    return None;
                }

                // Filter blacklisted peers
                let (is_blacklisted, reason, remaining) = self.is_blacklisted(&peer.addr);
                if is_blacklisted {
                    match reason {
                        // IDENTITY-HARD: never recoverable via reputation. The
                        // attacker's keypair fails Tier-2 verify on every
                        // consensus message, so `is_consensus_qualified` is
                        // structurally false. Drop unconditionally.
                        Some(BlacklistReason::PkImpersonation) => return None,
                        // HARD: recoverable via reputation gate.
                        Some(BlacklistReason::InvalidBlocks)
                        | Some(BlacklistReason::MaliciousBehavior) => {
                            if !peer.is_consensus_qualified() {
                                return None;
                            }
                            self.remove_from_blacklist(&peer.addr);
                        }
                        // SOFT: skip while window is active.
                        _ => {
                            if remaining > 0 {
                                return None;
                            }
                        }
                    }
                }

                // Include only peers with good consensus reputation (Byzantine-safe)
                if peer.is_consensus_qualified() {
                    Some(peer)
                } else {
                    None
                }
            })
            .collect();

        // Sort by priority: 1) network_score (latency), 2) cached reputation (reliability)
        eligible_peers.sort_by(|a, b| {
            // Primary: network_score (higher = better latency)
            let network_cmp = b.network_score.partial_cmp(&a.network_score).unwrap_or(std::cmp::Ordering::Equal);
            if network_cmp != std::cmp::Ordering::Equal {
                return network_cmp;
            }
            // Secondary: cached reputation (higher = more reliable)
            b.reputation().partial_cmp(&a.reputation()).unwrap_or(std::cmp::Ordering::Equal)
        });

        // v16.1: split into clean / fork-cooldown buckets. Clean peers go
        // first. If clean.len() < max_peers, fall back into the cooldown
        // bucket to fill remaining slots — staying live even when most
        // peers are tagged is preferable to stalling.
        let (clean, tagged): (Vec<PeerInfo>, Vec<PeerInfo>) = eligible_peers
            .into_iter()
            .partition(|p| !crate::block_pipeline::is_peer_in_fork_cooldown(&p.id));

        if !tagged.is_empty() && crate::node::is_info() {
            println!(
                "[INFO][SYNC] sync_peer_selection clean={} fork_cooldown_skipped={} max_requested={}",
                clean.len(), tagged.len(), max_peers
            );
        }

        let mut result: Vec<PeerInfo> = clean.into_iter().take(max_peers).collect();
        if result.len() < max_peers {
            let remaining = max_peers - result.len();
            result.extend(tagged.into_iter().take(remaining));
        }
        result
    }
    
    /// Cleanup expired blacklist entries (periodic maintenance)
    /// SCALABILITY: Lock-free DashMap cleanup for millions of nodes
    pub fn cleanup_expired_blacklist(&self) {
        let mut removed = 0;
        PEER_BLACKLIST.retain(|_, entry| {
            if !entry.is_active() && entry.duration_secs > 0 {
                removed += 1;
                false // Remove expired soft blacklist
            } else {
                true // Keep active or permanent
            }
        });
        
        if removed > 0 {
            if crate::node::is_info() {
                println!("[INFO][SECURITY] Cleaned up {} expired blacklist entries", removed);
            }
        }
    }
}

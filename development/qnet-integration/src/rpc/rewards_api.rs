//! Reward claim, pending rewards, pools and per-wallet summaries.

use super::*;

pub(super) async fn handle_claim_rewards(
    claim_request: ClaimRewardsRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // SECURITY: IP-based rate limiting for reward claims
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "claim_rewards") {
        return Ok(rate_limit_response);
    }
    
    // SECURITY: Validate EON wallet address format (45-char with SHA3-256 checksum)
    // All nodes (genesis + super) use the same format: {19}eon{15}{8 checksum}
    if let Err(e) = validate_eon_address_with_error(&claim_request.wallet_address) {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Invalid wallet address format",
            "details": e
        })));
    }
    
    // PURE DILITHIUM (F0.2): the reward claim is authorised by the MANDATORY ML-DSA-65 signature below
    // over "claim_rewards:{node_id}:{wallet_address}", the on-chain registered-wallet match, and the
    // per-proof merkle re-verify against the QC-certified reward_root at apply. Ed25519 is Solana-only
    // and is NOT verified on this QNet path.
    // Chain-bound: the same wallet key signs transfers, so an authorization minted on one chain
    // must not be replayable on another.
    let claim_message = crate::node::BlockchainNode::chain_bind(
        &format!("claim_rewards:{}:{}", claim_request.node_id, claim_request.wallet_address));
    
    // v5.0: MANDATORY ML-DSA-65 (ML-DSA-65) signature for ALL reward claims — no exceptions.
    // Android (NDK/JNI) and iOS (ObjC bridge) both support Dilithium since v5.0.
    {
        let dilithium_sig = match claim_request.dilithium_signature.as_ref().filter(|s| !s.is_empty()) {
            Some(s) => s.clone(),
            None => {
                println!("[WARN][CLAIM] rejected reason=missing_dilithium node={}", claim_request.node_id);
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "Reward claim requires dilithium_signature (NIST FIPS 204). \
                              Update your QNet app to v5.0+ which includes the Dilithium3 native module."
                })));
            }
        };
        let dilithium_pubkey = match claim_request.dilithium_public_key.as_ref().filter(|s| !s.is_empty()) {
            Some(pk) => pk.clone(),
            None => {
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "dilithium_public_key is required alongside dilithium_signature"
                })));
            }
        };

        if !verify_mobile_dilithium_signature(&claim_message, &dilithium_sig, &dilithium_pubkey) {
            println!("[WARN][CLAIM] dilithium_invalid node={}", claim_request.node_id);
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Invalid Dilithium3 signature for reward claim"
            })));
        }
        println!("[INFO][CLAIM] dilithium_verified node={} quantum_safe=true", claim_request.node_id);
    }
    
    // v2.71: ON-CHAIN WALLET VERIFICATION
    // Uses blockchain NodeRegistration TX as SINGLE SOURCE OF TRUTH
    // Fallback to genesis_constants for Genesis nodes (until on-chain registration is in block)
    let registered_wallet = blockchain.get_node_wallet(&claim_request.node_id).await;
    
    let wallet_address = match registered_wallet {
        Some(registered) => {
            // SECURITY: Verify claimant wallet matches ON-CHAIN registered wallet
            if registered != claim_request.wallet_address {
                println!("[SECURITY][CLAIM] wallet_mismatch node={}", claim_request.node_id);
                println!("[SECURITY][CLAIM] onchain={}... claimed={}...", 
                         qnet_state::char_prefix(&registered, 16),
                         qnet_state::char_prefix(&claim_request.wallet_address, 16));
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "error": "Wallet address does not match on-chain registration"
                })));
            }
            println!("[INFO][CLAIM] wallet_verified node={} source=blockchain", claim_request.node_id);
            registered
        }
        None => {
            // Node not registered on-chain
            println!("[SECURITY][CLAIM] no_onchain_registration node={}", claim_request.node_id);
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "Node not registered on-chain. Registration TX required before claiming rewards."
            })));
        }
    };
    
    // FIX R20-M1: Per-node claim lock — prevent double-claim race condition
    // If another request for the same node_id is already in progress, reject immediately
    if !CLAIM_IN_PROGRESS.insert(claim_request.node_id.clone()) {
        println!("[WARN][CLAIM] concurrent_claim_blocked node={}", claim_request.node_id);
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": "Claim already in progress for this node. Please wait and retry."
        })));
    }
    // RAII guard: remove from CLAIM_IN_PROGRESS on ANY exit (success, error, early return)
    struct ClaimGuard(String);
    impl Drop for ClaimGuard {
        fn drop(&mut self) { CLAIM_IN_PROGRESS.remove(&self.0); }
    }
    let _claim_guard = ClaimGuard(claim_request.node_id.clone());

    // ── Step 2: the wallet returns the payload we quoted, signed. Submit it verbatim ──
    // The signature covers these exact bytes, so this node cannot alter the batch, and no relayer
    // can re-aim the signature at a shorter one. Mempool admission re-verifies both signature and
    // proofs; apply is the final authority.
    if let (Some(data), Some(sig)) = (claim_request.claims_data.as_ref(), claim_request.claims_signature.as_ref()) {
        // Same number the route's content_length_limit allows, so transport and handler agree.
        const MAX_CLAIMS_DATA: usize = 256 * 1024;
        if data.len() > MAX_CLAIMS_DATA {
            return Ok(warp::reply::json(&json!({ "success": false, "error": "claims_data too large" })));
        }
        let total_amount: u64 = serde_json::from_str::<serde_json::Value>(data).ok()
            .and_then(|v| v.get("claims").and_then(|c| c.as_array().cloned()))
            .map(|a| a.iter().filter_map(|e| e.get("amount").and_then(|x| x.as_u64()))
                 .fold(0u64, |acc, x| acc.saturating_add(x)))
            .unwrap_or(0);
        let mut tx = qnet_state::Transaction {
            hash: String::new(),
            from: "system_rewards_pool".to_string(),
            to: Some(wallet_address.clone()),
            amount: total_amount,
            nonce: 0,
            gas_price: 0,
            gas_limit: 0,
            timestamp: claim_request.claim_timestamp.unwrap_or(0),
            signature: None,
            public_key: None,
            tx_type: qnet_state::TransactionType::RewardDistribution,
            data: Some(data.clone()),
            dilithium_signature: Some(sig.clone().into_bytes()),
            dilithium_public_key: claim_request.dilithium_public_key.clone().map(String::into_bytes),
            chain_id: qnet_state::transaction::QNET_CHAIN_ID,
        };
        tx.hash = tx.calculate_hash();
        if !crate::node::BlockchainNode::claim_authorized(&tx, &wallet_address, data) {
            println!("[WARN][CLAIM] payload_signature_invalid wallet={}..", qnet_state::char_prefix(&wallet_address, 16));
            return Ok(warp::reply::json(&json!({
                "success": false,
                "error": "claims_signature does not authorize claims_data for this wallet"
            })));
        }
        return match blockchain.submit_transaction(tx).await {
            Ok(tx_hash) => {
                println!("[INFO][CLAIM] merkle_claim_submitted wallet={}.. amount={} QNC hash={}",
                         qnet_state::char_prefix(&wallet_address, 16), total_amount / 1_000_000_000, tx_hash);
                Ok(warp::reply::json(&json!({
                    "success": true,
                    "tx_hash": tx_hash,
                    "amount_qnc": total_amount as f64 / 1_000_000_000.0,
                    "message": "Merkle reward claim submitted; credited on inclusion"
                })))
            }
            Err(e) => Ok(warp::reply::json(&json!({ "success": false, "error": format!("{}", e) }))),
        };
    }

    // ── Step 1: quote the batch of ALL of this wallet's unclaimed epochs ──
    // Enumerate epochs via the reward-epochs index (no scan cap), generate each merkle proof from the
    // locally-stored leaf set, and return the payload for the wallet to sign (oldest-first → no
    // forfeiture). Apply re-verifies every proof and the wallet signature, so this RPC can neither
    // forge a credit nor submit on the wallet's behalf.
    {
        // Scale guard: bound concurrent merkle proof-gen across all claims (thousands of nodes may
        // claim at an epoch boundary). Per-node CLAIM_IN_PROGRESS already serializes a single node.
        static CLAIM_PROOFGEN_SEM: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);
        let _proofgen_permit = CLAIM_PROOFGEN_SEM.acquire().await.ok();
        let storage = blockchain.get_storage();
        let last_claimed = {
            let state = blockchain.get_state_manager();
            let g = state.read().await;
            (*g).get_last_claimed_epoch(&wallet_address)
        };
        let epochs = storage.reward_epochs_from(0).unwrap_or_default();
        let mut claim_entries: Vec<serde_json::Value> = Vec::new();
        let mut total_amount: u64 = 0;
        // Reported so a wallet knows WHY the batch ended and can retry elsewhere.
        let mut stopped_at: Option<(u64, &'static str)> = None;
        // One O(roster) rebuild per request: this endpoint must not amplify into repeated full walks.
        let mut rebuilt = false;
        const MAX_BATCH: usize = 512; // bound the TX size; the wallet re-calls for any remainder
        // The quote goes back out over the wire signed, so it must be bounded in BYTES: proof depth
        // grows with the recipient count, so an epoch count alone cannot keep the body under the route
        // limit. Oldest-first + stop-not-skip means a partial batch forfeits nothing.
        const CLAIM_QUOTE_BYTE_BUDGET: usize = 128 * 1024;
        let mut quote_bytes: usize = 0;
        for epoch in epochs.into_iter().filter(|e| *e > last_claimed) {
            if claim_entries.len() >= MAX_BATCH {
                stopped_at = Some((epoch, "batch_full"));
                break;
            }
            if quote_bytes >= CLAIM_QUOTE_BYTE_BUDGET {
                stopped_at = Some((epoch, "quote_byte_budget"));
                break;
            }
            // The certified root is the sole authority. Claims stop (never skip) at the first
            // epoch this node cannot serve: the watermark is monotonic, so skipping forfeits it.
            let (committed_root, ctotal) = match storage.load_epoch_root(epoch) {
                Ok(Some(r)) if r != [0u8; 32] => (hex::encode(r), crate::reward_epoch::canonical_total(epoch)),
                Ok(Some(_)) => continue, // epoch distributed nothing
                _ => { stopped_at = Some((epoch, "root_not_here")); break; }
            };
            // Resolve from the shard cache (one shard + meta, never the whole leaf set); the shard
            // roots are re-verified against the certified root before proving. Absent = cache miss,
            // rebuildable from durable indices — bounded to one rebuild per request.
            let claim = match crate::node::BlockchainNode::reward_proof_from_shard(&storage, epoch, &committed_root, &wallet_address, true) {
                crate::node::ShardClaim::Absent => {
                    const REBUILD_RETRY_SECS: u64 = 3600;
                    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                    if REWARD_REBUILD_DIVERGED.get(&epoch)
                        .map_or(false, |t| now.saturating_sub(*t) < REBUILD_RETRY_SECS) {
                        stopped_at = Some((epoch, "local_corruption"));
                        break;
                    }
                    if rebuilt { stopped_at = Some((epoch, "rebuild_budget")); break; }
                    rebuilt = true;
                    let w = crate::node::BlockchainNode::compute_epoch_reward_distribution(&storage, epoch, ctotal)
                        .map(|x| x.0).unwrap_or_default();
                    if crate::node::BlockchainNode::epoch_reward_merkle_root(&w, epoch) != committed_root {
                        // Inputs present but they do not reproduce the certified root: local data is
                        // corrupt, not merely missing. Alarm and stop; a resync is the repair.
                        println!("[ERR][REWARDS] epoch_rebuild_diverged epoch={} action=stop_batch_resync", epoch);
                        REWARD_REBUILD_DIVERGED.insert(epoch, now);
                        stopped_at = Some((epoch, "local_corruption"));
                        break;
                    }
                    crate::node::BlockchainNode::save_epoch_reward_sharded(&storage, epoch, &w);
                    crate::node::BlockchainNode::reward_proof_from_shard(&storage, epoch, &committed_root, &wallet_address, true)
                }
                other => other,
            };
            match claim {
                crate::node::ShardClaim::Proof(amount, proof) => {
                    // ~66 B per proof hash on the wire plus the entry scaffolding; charged before the
                    // next iteration so the budget bounds what has already been accepted.
                    quote_bytes = quote_bytes.saturating_add(64 + proof.len() * 70);
                    let proof_json: Vec<serde_json::Value> = proof.iter().map(|(hh, l)| json!([hh, l])).collect();
                    claim_entries.push(json!({ "epoch": epoch, "amount": amount, "proof": proof_json }));
                    total_amount = total_amount.saturating_add(amount);
                }
                // This wallet has no leaf in this epoch — nothing to forfeit, keep batching.
                crate::node::ShardClaim::NotRecipient => continue,
                // Cannot serve it here. STOP: the watermark is monotonic, so batching a LATER epoch
                // would advance it past this one and burn it for this wallet permanently.
                other => {
                    println!("[WARN][REWARDS] claim_epoch_unservable epoch={} outcome={:?} action=stop_batch", epoch, other);
                    stopped_at = Some((epoch, "epoch_unservable"));
                    break;
                }
            }
        }
        if claim_entries.is_empty() {
            if let Some((epoch, reason)) = stopped_at {
                return Ok(warp::reply::json(&json!({
                    "success": false,
                    "epochs_claimed": 0,
                    "stopped_at_epoch": epoch,
                    "stopped_reason": reason,
                    "error": format!("This node cannot serve epoch {} ({}) — retry on another node", epoch, reason)
                })));
            }
        }
        if !claim_entries.is_empty() {
            // Step 1: quote the batch. The wallet signs these exact bytes and re-POSTs them with
            // claims_data + claims_signature; only its own key can authorize a credit to it.
            let n = claim_entries.len();
            let data = json!({ "claims": claim_entries }).to_string();
            // The timestamp is quoted, not chosen at submit: the signature covers it, so step 2 must
            // reproduce it byte-for-byte and a bumped-timestamp replay cannot verify.
            let claim_ts = chrono::Utc::now().timestamp() as u64;
            let sign_message = crate::node::BlockchainNode::claim_sign_message(&wallet_address, &data, claim_ts);
            println!("[INFO][CLAIM] merkle_claim_quoted wallet={}.. epochs={} amount={} QNC",
                     qnet_state::char_prefix(&wallet_address, 16), n, total_amount / 1_000_000_000);
            return Ok(warp::reply::json(&json!({
                "success": false,
                "needs_signature": true,
                "claims_data": data,
                "sign_message": sign_message,
                "claim_timestamp": claim_ts,
                "epochs_claimed": n,
                // Exact base units as a decimal STRING: nanoQNC exceeds 2^53, so a JSON number would
                // round and the wallet's own cross-check would then reject an honest quote.
                "amount_nano": total_amount.to_string(),
                "amount_qnc": total_amount as f64 / 1_000_000_000.0,
                // Lets the wallet verify the batch SHAPE (starts at the watermark, strictly ascending)
                // instead of only its total — a truncated batch is what would strand epochs.
                "last_claimed_epoch": last_claimed,
                "stopped_at_epoch": stopped_at.map(|(e, _)| e),
                "stopped_reason": stopped_at.map(|(_, r)| r),
                "message": "Sign sign_message with the wallet Dilithium key and re-POST with claims_data + claims_signature"
            })));
        }
        // No unclaimed merkle reward for this wallet — merkle reward_root is the SOLE reward source
        // (the legacy Account.pending_rewards accrual path was removed), so there is nothing to claim.
    }

    Ok(warp::reply::json(&json!({ "success": false, "error": "No claimable rewards" })))
}

// GET /api/v1/rewards/pending/{node_id} - Get pending rewards for a node
// v2.64: Uses REAL heartbeat data from P2P, not fallback values
/// A wallet's UNCLAIMED reward total (QNC base units): the authoritative claimable, summed over every
/// reward-root epoch beyond its claim watermark — same enumeration the merkle claim path submits — plus
/// any residual legacy Account.pending_rewards. Status-independent: reward is wallet-scoped, so it is
/// returned in full whether the node is online, offline, or banned.
/// The lowest epoch above this wallet's claim watermark in which it actually holds a reward leaf, i.e.
/// where an honest claim batch MUST start. The wallet cross-checks the quote it is asked to sign against
/// this: a quoting node that skipped the head would otherwise burn those epochs behind the monotonic
/// watermark. `None` when nothing is claimable or this node cannot resolve the head epoch.
pub(super) async fn wallet_first_unclaimed_epoch(blockchain: &BlockchainNode, wallet: &str) -> Option<u64> {
    let storage = blockchain.get_storage();
    let last_claimed = {
        let state = blockchain.get_state_manager();
        let g = state.read().await;
        g.get_last_claimed_epoch(wallet)
    };
    for epoch in storage.reward_epochs_from(0).unwrap_or_default().into_iter().filter(|e| *e > last_claimed) {
        let root = match storage.load_epoch_root(epoch) {
            Ok(Some(r)) if r != [0u8; 32] => hex::encode(r),
            Ok(Some(_)) => continue, // epoch distributed nothing
            _ => return None,        // cannot resolve here; reporting a later epoch would be a lie
        };
        match crate::node::BlockchainNode::reward_proof_from_shard(&storage, epoch, &root, wallet, false) {
            crate::node::ShardClaim::Proof(_, _) => return Some(epoch),
            crate::node::ShardClaim::NotRecipient => continue,
            _ => return None,
        }
    }
    None
}

pub(super) async fn wallet_claimable_qnc(blockchain: &BlockchainNode, wallet: &str) -> u64 {
    let storage = blockchain.get_storage();
    let last_claimed = {
        let state = blockchain.get_state_manager();
        let g = state.read().await;
        g.get_last_claimed_epoch(wallet)
    };
    let mut total = 0u64; // merkle reward_root is the SOLE reward source (legacy accrual removed)
    // Mirror handle_claim_rewards EXACTLY, including where it STOPS: the claim watermark is monotonic,
    // so that path stops at the first unservable epoch instead of skipping it. Skipping here would show
    // more than the next claim can ever pay. This path never rebuilds (unauthenticated), so it can only
    // under-report relative to the claim path, never over-report.
    const MAX_BATCH: usize = 512;
    let mut counted = 0usize;
    for epoch in storage.reward_epochs_from(0).unwrap_or_default().into_iter().filter(|e| *e > last_claimed) {
        if counted >= MAX_BATCH { break; }
        // 2f+1-committed root = authority for this epoch.
        let committed_root = match storage.load_epoch_root(epoch) {
            Ok(Some(r)) if r != [0u8; 32] => hex::encode(r),
            Ok(Some(_)) => continue,  // epoch distributed nothing — the claim path skips it too
            _ => break,               // root not here: the claim path stops, so must the figure
        };
        // Amount-only resolution from the SHARDED structure (loads one shard, skips proof gen), verified
        // against the committed root. This endpoint is UNAUTHENTICATED, so it must NEVER trigger the
        // O(N) leaf-set rebuild (the Absent self-heal is the sig-gated claim path's job) — otherwise a
        // cheap public request could amplify into a full-roster recompute. On Absent/Divergent skip the
        // epoch; the figure self-corrects once the shards are present (via apply/finalization or a claim).
        let amt = match crate::node::BlockchainNode::reward_proof_from_shard(&storage, epoch, &committed_root, wallet, false) {
            crate::node::ShardClaim::Proof(a, _) => a,
            crate::node::ShardClaim::NotRecipient => continue, // no leaf here — the claim path keeps batching
            _ => break,                                       // unservable: the claim path stops here
        };
        total = total.saturating_add(amt);
        counted += 1;
    }
    total
}

/// Record a failed registration attempt for per-wallet rate limiting. The ONLY writer that creates
/// entries, so the map is bounded by wallets that actually failed inside the window; an oversized
/// map is swept of entries whose attempts have all expired.
pub(super) fn record_wallet_reg_failure(wallet: &str) {
    const WINDOW: u64 = 600;
    const SWEEP_AT: usize = 10_000;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    if WALLET_REG_FAIL_TIMESTAMPS.len() >= SWEEP_AT {
        WALLET_REG_FAIL_TIMESTAMPS.retain(|_, v| v.iter().any(|&ts| now.saturating_sub(ts) < WINDOW));
    }
    let mut e = WALLET_REG_FAIL_TIMESTAMPS.entry(wallet.to_string()).or_insert_with(Vec::new);
    e.retain(|&ts| now.saturating_sub(ts) < WINDOW);
    e.push(now);
}

pub(super) async fn handle_get_pending_rewards(
    node_id: String,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // PRODUCTION v2.43.1: Rate limiting (300 req/min for read-only)
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    // Calculate current epoch boundaries
    let current_height = blockchain.get_height().await;
    let current_epoch = (current_height / 14400).saturating_add(1);
    let epoch_start = current_epoch.saturating_sub(1).saturating_mul(14400);
    let epoch_end = current_epoch.saturating_mul(14400);
    let blocks_until_next = epoch_end.saturating_sub(current_height);
    
    // Determine node type from ID
    // v3.18: Full nodes removed
    let node_type = if node_id.starts_with("light_") {
        "Light"
    } else if node_id.starts_with("super_") || node_id.starts_with("genesis_") {
        "Super"
    } else {
        "Unknown"
    };
    
    // v35: heartbeat liveness reads the on-chain tally (Account.heartbeat_slots popcount) — the
    // unforgeable source — not the removed local recorder. The bitmap records which subwindows were
    // live this epoch, not per-heartbeat timestamps.
    let hb_epoch = current_height / 14400;
    let heartbeat_count = blockchain.get_account(&node_id).await.ok().flatten()
        .map(|a| crate::node::BlockchainNode::account_heartbeat_count(&a, hb_epoch) as usize)
        .unwrap_or(0);
    
    // Calculate eligibility based on REAL heartbeat count
    let required_heartbeats = match node_type {
        "Super" => 9,
        "Full" => 8,
        "Light" => 1,
        _ => 10, // Unknown nodes can never be eligible
    };
    let is_eligible = heartbeat_count >= required_heartbeats;
    
    // The claimable total is the merkle reward_root sum for this node's ON-CHAIN wallet — the same
    // number the claim endpoint quotes and apply credits. Emission is pure Pool-1, so pool1 IS the
    // total and there is no split to invent.
    let pending_amount = match blockchain.get_node_wallet(&node_id).await {
        Some(w) => wallet_claimable_qnc(&blockchain, &w).await,
        None => 0,
    };
    let (pool1, pool2, pool3) = (pending_amount, 0u64, 0u64);
    // Phase 2 begins at 90% of the 1DEV supply burned; display-only, so an outage reads "unknown"
    // rather than silently claiming Phase 1.
    let phase = match live_activation_pricing_opt().await {
        Some(p) if p.phase == 2 => "Phase2".to_string(),
        Some(_) => "Phase1".to_string(),
        None => "unknown".to_string(),
    };
    let is_claimable = pending_amount > 0;
    
    // Get last claim time from storage
    let last_claim = {
        let storage = blockchain.get_storage();
        storage.get_contract_state(&format!("rewards:{}", node_id), "last_claim")
            .ok()
            .flatten()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
    };
    
    // v35: active = produced ≥1 on-chain heartbeat this epoch (Account.heartbeat_slots).
    let is_active = heartbeat_count > 0;
    
    // Convert to QNC (from nanoQNC)
    let total_qnc = pending_amount as f64 / 1_000_000_000.0;
    let pool1_qnc = pool1 as f64 / 1_000_000_000.0;
    let pool2_qnc = pool2 as f64 / 1_000_000_000.0;
    let pool3_qnc = pool3 as f64 / 1_000_000_000.0;
    
    let reward_info = json!({
        "node_id": node_id,
        "node_type": node_type,
        "phase": phase,
        "pending_rewards": total_qnc,
        "pending_rewards_nano": pending_amount, // exact base units (client divides by 1e9 for display)
        // Where an honest claim batch must start; the wallet refuses to sign a quote that skips it.
        "first_unclaimed_epoch": match blockchain.get_node_wallet(&node_id).await {
            Some(w) => wallet_first_unclaimed_epoch(&blockchain, &w).await,
            None => None,
        },
        "pools": {
            "pool1_base_emission": pool1_qnc,
            "pool2_tx_fees": pool2_qnc,
            "pool3_activation_bonus": pool3_qnc
        },
        "current_epoch": current_epoch,
        "epoch_block_range": format!("{}-{}", epoch_start, epoch_end),
        "blocks_until_next_epoch": blocks_until_next,
        "seconds_until_next_epoch": blocks_until_next,
        "last_claim": last_claim,
        "last_heartbeat": 0,
        "heartbeats": {
            "current": heartbeat_count,
            "required": required_heartbeats,
            "remaining": if heartbeat_count < required_heartbeats { required_heartbeats - heartbeat_count } else { 0 }
        },
        "is_active": is_active,
        "is_eligible": is_eligible,
        "is_claimable": is_claimable  // v2.75: True if pending >= 1 QNC
    });
    
    Ok(warp::reply::json(&reward_info))
}

// PRODUCTION v2.43.1: GET /api/v1/rewards/history/{node_id}?offset=0&limit=10 - Get reward history by epochs
pub(super) async fn handle_get_reward_history(
    node_id: String,
    query: RewardHistoryQuery,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // PRODUCTION v2.43.1: Rate limiting (300 req/min for read-only)
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    let current_height = blockchain.get_height().await;
    let current_epoch = (current_height / 14400).saturating_add(1);
    
    // Pagination: default offset=0, limit=10, max limit=100
    let offset = query.offset.unwrap_or(0) as u64;
    let limit = query.limit.unwrap_or(10).min(100) as usize;
    
    // Get claimed rewards history from storage
    let storage = blockchain.get_storage();
    let mut epochs_history = Vec::new();
    
    // Calculate which epochs to scan based on offset
    let total_epochs = current_epoch;  // v2.63: 1-based epochs
    let start_epoch = if offset < total_epochs { 
        current_epoch.saturating_sub(offset) 
    } else { 
        1  // v2.63: minimum epoch is 1
    };
    
    // Scan epochs with pagination (v2.63: epochs start from 1)
    let mut scanned = 0usize;
    for epoch in (1..=start_epoch).rev() {
        if scanned >= limit {
            break;
        }
        
        // v2.63: Convert 1-based epoch to block range
        let epoch_start_block = (epoch - 1) * 14400;
        let epoch_end_block = epoch * 14400;
        
        // Get claimed amount for this epoch from storage
        let claimed_key = format!("rewards:{}:epoch:{}", node_id, epoch);
        let claimed = storage.get_contract_state(&claimed_key, "claimed")
            .ok()
            .flatten()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        
        // Get pool breakdown for this epoch
        let pool1 = storage.get_contract_state(&claimed_key, "pool1")
            .ok().flatten().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let pool2 = storage.get_contract_state(&claimed_key, "pool2")
            .ok().flatten().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let pool3 = storage.get_contract_state(&claimed_key, "pool3")
            .ok().flatten().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        
        let claim_time = storage.get_contract_state(&claimed_key, "claim_time")
            .ok().flatten().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        
        epochs_history.push(json!({
            "epoch": epoch,
            "block_range": format!("{}-{}", epoch_start_block, epoch_end_block),
            "claimed_qnc": claimed as f64 / 1_000_000_000.0,
            "pools": {
                "pool1_base": pool1 as f64 / 1_000_000_000.0,
                "pool2_fees": pool2 as f64 / 1_000_000_000.0,
                "pool3_activation": pool3 as f64 / 1_000_000_000.0
            },
            "claim_time": claim_time,
            "status": if claimed > 0 { "claimed" } else if epoch == current_epoch { "pending" } else { "missed" }
        }));
        
        scanned += 1;
    }
    
    Ok(warp::reply::json(&json!({
        "node_id": node_id,
        "current_epoch": current_epoch,
        "current_height": current_height,
        "pagination": {
            "offset": offset,
            "limit": limit,
            "total_epochs": total_epochs,
            "has_more": offset + limit as u64 <= total_epochs
        },
        "history": epochs_history
    })))
}

// PRODUCTION v2.43.1: GET /api/v1/rewards/pools/{node_id} - Get detailed pool breakdown
pub(super) async fn handle_get_reward_pools(
    node_id: String,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // PRODUCTION v2.43.1: Rate limiting (300 req/min for read-only)
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    // Get current phase (display only — an outage reports phase 0 = unknown, not a false Phase 1)
    let current_phase = live_activation_pricing_opt().await.map(|p| p.phase).unwrap_or(0);

    // Emission is pure Pool-1, so the claimable total IS pool 1; the other two are reported as the
    // zeros they are rather than a split this chain does not produce.
    let total = match blockchain.get_node_wallet(&node_id).await {
        Some(w) => wallet_claimable_qnc(&blockchain, &w).await,
        None => 0,
    };
    let (pool1, pool2, pool3, _phase_str) =
        (total, 0u64, 0u64, if current_phase == 2 { "Phase2" } else { "Phase1" }.to_string());
    
    // Calculate current epoch info
    let current_height = blockchain.get_height().await;
    let current_epoch = (current_height / 14400).saturating_add(1);
    let blocks_in_epoch = current_height % 14400;
    
    // PRODUCTION v2.43.1: Use cached accumulated pools (10 sec TTL)
    // v9.1: Single read lock acquire to avoid double-lock deadlock risk
    let (accumulated_pool2, accumulated_pool3) = {
        // Check cache and extract values in one lock scope
        let cached_values = {
            let cache = REWARD_POOLS_CACHE.read();
            if cache.1.elapsed().as_secs() < REWARD_POOLS_CACHE_TTL_SECS && cache.0.epoch == current_epoch {
                Some((cache.0.pool2_fees, cache.0.pool3_activations))
            } else {
                None
            }
        }; // read lock dropped here

        if let Some(values) = cached_values {
            values
        } else {
            // Refresh cache
            let (p2, p3) = if let Some(p2p) = blockchain.get_unified_p2p() {
                (p2p.peek_pool2_fees(), p2p.peek_pool3_activations())
            } else {
                (0, 0)
            };
            
            // Update cache
            let mut cache = REWARD_POOLS_CACHE.write();
            cache.0 = RewardPoolsCache {
                pool2_fees: p2,
                pool3_activations: p3,
                epoch: current_epoch,
                blocks_in_epoch,
            };
            cache.1 = std::time::Instant::now();
            
            (p2, p3)
        }
    };
    
    let blocks_until_emission = 14400 - blocks_in_epoch;
    
    // Determine node type
    // v3.18: Full nodes removed
    let node_type = if node_id.starts_with("light_") {
        "Light"
    } else if node_id.starts_with("super_") || node_id.starts_with("genesis_") {
        "Super"
    } else if node_id.starts_with("full_") {
        "Super" // v3.18: Map to Super for backward compatibility (old nodes)
    } else {
        "Unknown"
    };
    
    Ok(warp::reply::json(&json!({
        "node_id": node_id,
        "node_type": node_type,
        "current_phase": current_phase,
        "phase_description": match current_phase {
            1 => "Phase 1: 1DEV burn (Pool3 disabled)",
            2 => "Phase 2: QNC payment (Pool3 active)",
            _ => "Unknown: 1DEV supply read unavailable",
        },
        
        // Node's pending rewards breakdown
        "pending_rewards": {
            "total_qnc": total as f64 / 1_000_000_000.0,
            "pool1_base_emission": {
                "amount_qnc": pool1 as f64 / 1_000_000_000.0,
                "description": "Base emission (dynamic halving, ~251K QNC/4h at Year 0) - distributed to all eligible nodes"
            },
            "pool2_tx_fees": {
                "amount_qnc": pool2 as f64 / 1_000_000_000.0,
                "description": "v3.18: Pool 2 removed - fees go directly to block producer (always 0)",
                "eligible": false  // v3.18: Pool 2 removed
            },
            "pool3_activation_bonus": {
                "amount_qnc": pool3 as f64 / 1_000_000_000.0,
                "description": "Activation payments Phase 2 - equal share to ALL eligible nodes",
                "phase2_only": true,
                "active": current_phase == 2
            }
        },
        
        // Current epoch accumulated pools (network-wide)
        "epoch_accumulated": {
            "epoch": current_epoch,
            "blocks_processed": blocks_in_epoch,
            "blocks_until_emission": blocks_until_emission,
            "seconds_until_emission": blocks_until_emission,
            "pool2_total_fees_qnc": accumulated_pool2 as f64 / 1_000_000_000.0,
            "pool3_total_activations_qnc": accumulated_pool3 as f64 / 1_000_000_000.0
        }
    })))
}

// PRODUCTION v2.43.1: GET /api/v1/rewards/by-wallet/{wallet_address} - Get all nodes for wallet
// v3.1: Now reads from STORAGE (blockchain) as primary, with reward_manager as supplement
// This ensures nodes are visible even when the node itself is offline!
pub(super) async fn handle_get_rewards_by_wallet(
    wallet_address: String,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Rate limiting (300 req/min for read-only)
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    // v3.1: PRIMARY SOURCE - Read from blockchain storage (survives node offline)
    // This is the authoritative source from NodeRegistration TX in blockchain
    let storage = blockchain.get_storage();
    let storage_nodes = storage.get_nodes_by_wallet(&wallet_address).unwrap_or_default();
    
    
    let nodes: Vec<String> = storage_nodes.iter().map(|(id, _, _)| id.clone()).collect();
    
    let mut nodes_info = Vec::new();
    let current_height = blockchain.get_height().await;
    let current_epoch = (current_height / 14400).saturating_add(1);
    
    // v3.1: Get active nodes list to determine online status
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    
    let active_nodes = if let Some(p2p) = blockchain.get_unified_p2p() {
        p2p.get_active_full_super_nodes()
    } else {
        Vec::new()
    };
    
    for node_id in nodes {
        // Merkle reward_root claimable (single-source; legacy pending removed) for this node's wallet.
        let blockchain_total = {
            let w = blockchain.get_node_wallet(&node_id).await.unwrap_or_else(|| wallet_address.clone());
            wallet_claimable_qnc(&blockchain, &w).await
        };
        
        // Determine node type from storage or from node_id prefix
        let node_type = {
            // Try to get from storage first
            let storage_type = storage_nodes.iter()
                .find(|(id, _, _)| id == &node_id)
                .map(|(_, t, _)| t.clone());
            
            if let Some(t) = storage_type {
                // v3.18: Full nodes removed
                match t.as_str() {
                    "super" => "Super",
                    "light" => "Light",
                    "full" => "Super", // v3.18: Map to Super for backward compatibility
                    _ => "Unknown"
                }
            // v3.18: Full nodes removed
            } else if node_id.starts_with("light_") {
                "Light"
            } else if node_id.starts_with("super_") || node_id.starts_with("genesis_") {
                "Super"
            } else {
                "Unknown"
            }
        };
        
        // v3.1: Determine online status from active nodes list
        let (is_online, last_seen) = active_nodes.iter()
            .find(|(id, _, _)| id == &node_id)
            .map(|(_, _, ls)| (now.saturating_sub(*ls) < 15 * 60, *ls)) // Online if seen in last 15 min
            .unwrap_or((false, 0)); // Not in active list = offline
        
        // Emission is pure Pool-1; there is no per-pool split to report.
        let (total, pool1, pool2, pool3, phase) = if blockchain_total > 0 {
            (blockchain_total as f64 / 1_000_000_000.0, blockchain_total as f64 / 1_000_000_000.0, 0.0, 0.0, "Phase1".to_string())
        } else {
            (0.0, 0.0, 0.0, 0.0, "Phase1".to_string())
        };
        
        // Get last claim time
        let storage = blockchain.get_storage();
        let last_claim = storage.get_contract_state(&format!("rewards:{}", node_id), "last_claim")
            .ok().flatten().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        
        nodes_info.push(json!({
            "node_id": node_id,
            "node_type": node_type,
            "is_online": is_online,
            "last_seen": last_seen,
            "last_seen_ago_seconds": if last_seen > 0 { now.saturating_sub(last_seen) } else { 0 },
            "phase": phase,
            "pending_rewards_qnc": total,
            "pools": {
                "pool1_base": pool1,
                "pool2_fees": pool2,
                "pool3_activation": pool3
            },
            "last_claim": last_claim
        }));
    }
    
    // Calculate totals
    let total_pending: f64 = nodes_info.iter()
        .map(|n| n["pending_rewards_qnc"].as_f64().unwrap_or(0.0))
        .sum();
    
    Ok(warp::reply::json(&json!({
        "wallet_address": wallet_address,
        "total_nodes": nodes_info.len(),
        "total_pending_qnc": total_pending,
        "current_epoch": current_epoch,
        "nodes": nodes_info
    })))
}

// PRODUCTION v2.43.1: POST /api/v1/rewards/pending/batch - Batch get pending rewards
pub(super) async fn handle_get_pending_rewards_batch(
    request: BatchPendingRewardsRequest,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Rate limiting
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    // Limit batch size to prevent abuse
    const MAX_BATCH_SIZE: usize = 100;
    if request.node_ids.len() > MAX_BATCH_SIZE {
        return Ok(warp::reply::json(&json!({
            "success": false,
            "error": format!("Batch size exceeds maximum of {} nodes", MAX_BATCH_SIZE)
        })));
    }
    
    let current_height = blockchain.get_height().await;
    let current_epoch = (current_height / 14400).saturating_add(1);
    
    let mut results = Vec::new();
    let mut total_pending = 0.0f64;

    for node_id in &request.node_ids {
        // Merkle reward_root claimable (single-source; legacy pending removed).
        let blockchain_total = match blockchain.get_node_wallet(node_id).await {
            Some(wallet) => wallet_claimable_qnc(&blockchain, &wallet).await,
            None => 0,
        };
        
        // Emission is pure Pool-1; there is no per-pool split to report.
        let (total, pool1, pool2, pool3) = if blockchain_total > 0 {
            let t = blockchain_total as f64 / 1_000_000_000.0;
            total_pending += t;
            (t, t, 0.0, 0.0)
        } else {
            (0.0, 0.0, 0.0, 0.0)
        };
        
        results.push(json!({
            "node_id": node_id,
            "pending_qnc": total,
            "pools": {
                "pool1_base": pool1,
                "pool2_fees": pool2,
                "pool3_activation": pool3
            }
        }));
    }

    Ok(warp::reply::json(&json!({
        "success": true,
        "current_epoch": current_epoch,
        "total_pending_qnc": total_pending,
        "count": results.len(),
        "nodes": results
    })))
}

// PRODUCTION v2.43.1: GET /api/v1/rewards/network/stats - Network-wide statistics
pub(super) async fn handle_get_reward_network_stats(
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Rate limiting
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    // Check cache first (30 sec TTL)
    {
        let cache = REWARD_NETWORK_STATS_CACHE.read();
        if cache.1.elapsed().as_secs() < REWARD_NETWORK_STATS_CACHE_TTL_SECS {
            return Ok(warp::reply::json(&cache.0));
        }
    }
    
    let current_height = blockchain.get_height().await;
    let current_epoch = (current_height / 14400).saturating_add(1);
    let storage = blockchain.get_storage();
    
    // Get accumulated pools from P2P
    let (pool2_accumulated, pool3_accumulated) = if let Some(p2p) = blockchain.get_unified_p2p() {
        (p2p.peek_pool2_fees(), p2p.peek_pool3_activations())
    } else {
        (0, 0)
    };
    
    // Count total claims from storage (scan last 10 epochs)
    let mut total_claims = 0u64;
    let mut total_distributed = 0u64;
    
    
    // Scan storage for claim history
    for epoch in (0..=current_epoch).rev().take(50) {
        let epoch_claims_key = format!("rewards:network:epoch:{}:claims", epoch);
        if let Ok(Some(claims_str)) = storage.get_contract_state(&epoch_claims_key, "count") {
            if let Ok(claims) = claims_str.parse::<u64>() {
                total_claims += claims;
            }
        }
        let epoch_distributed_key = format!("rewards:network:epoch:{}:distributed", epoch);
        if let Ok(Some(dist_str)) = storage.get_contract_state(&epoch_distributed_key, "amount") {
            if let Ok(dist) = dist_str.parse::<u64>() {
                total_distributed += dist;
            }
        }
    }
    
    let blocks_until_next = 14400 - (current_height % 14400);
    let avg_reward_per_epoch = if current_epoch > 0 {
        total_distributed as f64 / 1_000_000_000.0 / current_epoch as f64
    } else {
        0.0
    };
    
    let stats = json!({
        "success": true,
        "current_epoch": current_epoch,
        "current_height": current_height,
        "blocks_until_next_epoch": blocks_until_next,
        "seconds_until_next_epoch": blocks_until_next,
        
        "epoch_accumulated": {
            "pool2_tx_fees_qnc": pool2_accumulated as f64 / 1_000_000_000.0,
            "pool3_activations_qnc": pool3_accumulated as f64 / 1_000_000_000.0
        },
        
        "network_totals": {
            "total_claims": total_claims,
            "total_distributed_qnc": total_distributed as f64 / 1_000_000_000.0,
            "avg_reward_per_epoch_qnc": avg_reward_per_epoch
        },
        
        "emission_rate": {
            // Dynamic halving: 251,432 QNC/epoch at Year 0, halving every 4 years
            // Current value depends on years since genesis
            "pool1_base_per_epoch_qnc": "dynamic - use /api/v1/rewards/pools for current value",
            "initial_rate_qnc_per_epoch": 251_432.34,
            "halving_period_years": 4,
            "sharp_drop_at_year": 20,
            "sharp_drop_multiplier": 10
        },
        
        "cache_ttl_seconds": REWARD_NETWORK_STATS_CACHE_TTL_SECS
    });
    
    // Update cache
    {
        let mut cache = REWARD_NETWORK_STATS_CACHE.write();
        *cache = (stats.clone(), std::time::Instant::now());
    }
    
    Ok(warp::reply::json(&stats))
}

// PRODUCTION v2.43.1: GET /api/v1/rewards/summary/{node_id} - Lifetime aggregated stats
pub(super) async fn handle_get_reward_summary(
    node_id: String,
    remote_addr: Option<std::net::SocketAddr>,
    blockchain: Arc<BlockchainNode>,
) -> Result<impl Reply, Rejection> {
    // Rate limiting
    if let Err(rate_limit_response) = check_api_rate_limit(remote_addr, "read_only") {
        return Ok(rate_limit_response);
    }
    
    // Check cache first (60 sec TTL) - important for nodes with years of history
    if let Some(cached) = REWARD_SUMMARY_CACHE.get(&node_id) {
        if cached.1.elapsed().as_secs() < REWARD_SUMMARY_CACHE_TTL_SECS {
            return Ok(warp::reply::json(&cached.0));
        }
    }
    
    let storage = blockchain.get_storage();
    let current_height = blockchain.get_height().await;
    let current_epoch = (current_height / 14400).saturating_add(1);
    
    // Aggregated counters
    let mut total_claimed: u64 = 0;
    let mut total_pool1: u64 = 0;
    let mut total_pool2: u64 = 0;
    let mut total_pool3: u64 = 0;
    let mut epochs_claimed: u64 = 0;
    let mut epochs_missed: u64 = 0;
    let mut first_claim_epoch: Option<u64> = None;
    let mut last_claim_epoch: Option<u64> = None;
    let mut first_claim_time: u64 = 0;
    let mut last_claim_time: u64 = 0;
    
    // Scan ALL epochs for this node (from storage)
    // This uses indexed keys so it's O(epochs) not O(all_data)
    for epoch in 0..=current_epoch {
        let epoch_key = format!("rewards:{}:epoch:{}", node_id, epoch);
        
        if let Ok(Some(claimed_str)) = storage.get_contract_state(&epoch_key, "claimed") {
            if let Ok(claimed) = claimed_str.parse::<u64>() {
                if claimed > 0 {
                    total_claimed += claimed;
                    epochs_claimed += 1;
                    
                    // Track first/last claim
                    if first_claim_epoch.is_none() {
                        first_claim_epoch = Some(epoch);
                        if let Ok(Some(time_str)) = storage.get_contract_state(&epoch_key, "claim_time") {
                            first_claim_time = time_str.parse().unwrap_or(0);
                        }
                    }
                    last_claim_epoch = Some(epoch);
                    if let Ok(Some(time_str)) = storage.get_contract_state(&epoch_key, "claim_time") {
                        last_claim_time = time_str.parse().unwrap_or(0);
                    }
                    
                    // Pool breakdown
                    if let Ok(Some(p1)) = storage.get_contract_state(&epoch_key, "pool1") {
                        total_pool1 += p1.parse::<u64>().unwrap_or(0);
                    }
                    if let Ok(Some(p2)) = storage.get_contract_state(&epoch_key, "pool2") {
                        total_pool2 += p2.parse::<u64>().unwrap_or(0);
                    }
                    if let Ok(Some(p3)) = storage.get_contract_state(&epoch_key, "pool3") {
                        total_pool3 += p3.parse::<u64>().unwrap_or(0);
                    }
                } else {
                    epochs_missed += 1;
                }
            }
        }
    }
    
    // Current claimable, from the same merkle source as the claim endpoint.
    let pending_qnc = match blockchain.get_node_wallet(&node_id).await {
        Some(w) => wallet_claimable_qnc(&blockchain, &w).await as f64 / 1_000_000_000.0,
        None => 0.0,
    };
    
    // Calculate averages
    let avg_reward = if epochs_claimed > 0 {
        total_claimed as f64 / 1_000_000_000.0 / epochs_claimed as f64
    } else {
        0.0
    };
    
    // Determine node type
    // v3.18: Full nodes removed
    let node_type = if node_id.starts_with("light_") {
        "Light"
    } else if node_id.starts_with("super_") || node_id.starts_with("genesis_") {
        "Super"
    } else if node_id.starts_with("full_") {
        "Super" // v3.18: Map to Super for backward compatibility (old nodes)
    } else {
        "Unknown"
    };
    
    let summary = json!({
        "node_id": node_id.clone(),
        "node_type": node_type,
        "current_epoch": current_epoch,
        
        "lifetime_totals": {
            "total_claimed_qnc": total_claimed as f64 / 1_000_000_000.0,
            "pool1_base_qnc": total_pool1 as f64 / 1_000_000_000.0,
            "pool2_fees_qnc": total_pool2 as f64 / 1_000_000_000.0,
            "pool3_activation_qnc": total_pool3 as f64 / 1_000_000_000.0
        },
        
        "epochs": {
            "total_epochs": current_epoch + 1,
            "epochs_claimed": epochs_claimed,
            "epochs_missed": epochs_missed,
            "claim_rate_percent": if current_epoch > 0 { 
                (epochs_claimed as f64 / (current_epoch + 1) as f64) * 100.0 
            } else { 0.0 }
        },
        
        "first_claim": {
            "epoch": first_claim_epoch,
            "timestamp": first_claim_time
        },
        "last_claim": {
            "epoch": last_claim_epoch,
            "timestamp": last_claim_time
        },
        
        "averages": {
            "avg_reward_per_epoch_qnc": avg_reward
        },
        
        "current_pending_qnc": pending_qnc,
        "cache_ttl_seconds": REWARD_SUMMARY_CACHE_TTL_SECS
    });
    
    // SCALABILITY: Bound cache size
    const MAX_REWARD_SUMMARY_CACHE: usize = 5000;
    if REWARD_SUMMARY_CACHE.len() > MAX_REWARD_SUMMARY_CACHE {
        // Evict expired entries (TTL = 60s)
        REWARD_SUMMARY_CACHE.retain(|_, (_, ts)| ts.elapsed().as_secs() < 60);
        println!("[INFO][RPC] reward_summary_cache_cleanup remaining={}", REWARD_SUMMARY_CACHE.len());
    }

    // Update cache
    REWARD_SUMMARY_CACHE.insert(node_id, (summary.clone(), std::time::Instant::now()));
    
    Ok(warp::reply::json(&summary))
}

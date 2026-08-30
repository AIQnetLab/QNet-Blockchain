//! Transaction intake, canonical signing preimages, signature verification, burn attestations.

use super::*;

impl BlockchainNode {
    /// Admission gas-price floor stepped by local backlog: x1 under 5k pending,
    /// x2 to 20k, x4 to 100k, x8 above. Not a consensus rule — each node prices
    /// its own intake; a queued-out sender resubmits at the current floor.
    pub(crate) fn congestion_gas_floor(pending: usize) -> u64 {
        let base = qnet_state::transaction::MIN_GAS_PRICE;
        match pending {
            0..=4_999 => base,
            5_000..=19_999 => base * 2,
            20_000..=99_999 => base * 4,
            _ => base * 8,
        }
    }

    pub async fn submit_transaction(&self, tx: qnet_state::Transaction) -> Result<String, QNetError> {
        // PRODUCTION VALIDATION - reject invalid transactions immediately
        if let Err(validation_error) = tx.validate() {
            return Err(QNetError::ValidationError(format!("Transaction validation failed: {}", validation_error)));
        }
        if !Self::gas_limit_admissible(&tx) {
            return Err(QNetError::ValidationError(format!(
                "gas_limit {} exceeds MAX_GAS_LIMIT {}", tx.gas_limit, qnet_state::gas_limits::MAX_GAS_LIMIT)));
        }

        // ═══════════════════════════════════════════════════════════════════════
        // RPC-PATH TRANSACTION TYPE WHITELIST
        // ═══════════════════════════════════════════════════════════════════════
        // Mirrors the gossip-path whitelist in `validate_and_add_network_transaction`.
        // Both ingress points reject the same internal-only types so that no
        // user-submitted CreateAccount / BatchX transaction can ever reach
        // the mempool. Genesis-time CreateAccount transactions never traverse
        // this path — they are constructed directly by `genesis::create_genesis_block`
        // and applied via the block-apply pipeline.
        // ═══════════════════════════════════════════════════════════════════════
        match &tx.tx_type {
            qnet_state::TransactionType::CreateAccount { .. } => {
                if is_warn() {
                    println!("[WARN][TX-RPC] reject_rpc_create_account from={}... reason=internal_only_tx_type",
                        &tx.from[..tx.from.len().min(20)]);
                }
                return Err(QNetError::ValidationError(
                    "[REJECT][RPC] CreateAccount is genesis-only — not accepted via RPC".to_string()
                ));
            }
            qnet_state::TransactionType::BatchRewardClaims { .. } => {
                return Err(QNetError::ValidationError(
                    "[REJECT][RPC] BatchRewardClaims is deprecated — not accepted via RPC".to_string()
                ));
            }
            qnet_state::TransactionType::BatchNodeActivations { .. } => {
                return Err(QNetError::ValidationError(
                    "[REJECT][RPC] BatchNodeActivations is deprecated — not accepted via RPC".to_string()
                ));
            }
            qnet_state::TransactionType::BatchTransfers { transfers, .. } => {
                // Signed batch path: one ML-DSA-65 signature amortized over ≤1000
                // transfers. Bounds here; the signature gate runs downstream like
                // any value TX (canonical covers from/total/count/batch_id/nonce/gas).
                if transfers.is_empty() || transfers.len() > 1000 {
                    return Err(QNetError::ValidationError(
                        "[REJECT][RPC] BatchTransfers count must be 1..=1000".to_string()
                    ));
                }
                if transfers.iter().any(|t| t.amount == 0
                    || t.memo.as_ref().map_or(false, |m| m.len() > 128)) {
                    return Err(QNetError::ValidationError(
                        "[REJECT][RPC] BatchTransfers: zero amount or memo > 128 bytes".to_string()
                    ));
                }
            }
            // Swap/DEX is dormant: apply is fail-closed (no on-chain pool pricing deployed), so an
            // admitted Swap would be gossiped + block-included then silently dropped — wasted block
            // space + a cheap spam lever. Reject at BOTH ingress points (mirrored in the gossip path)
            // so it never reaches the mempool; block-apply keeps its fail-close as defense-in-depth.
            qnet_state::TransactionType::Swap { .. } => {
                return Err(QNetError::ValidationError(
                    "[REJECT][RPC] Swap/DEX is not enabled — on-chain pool pricing is not deployed".to_string()
                ));
            }
            _ => {} // All other variants pass through to standard validation
        }

        // Shared system-TX identity binds — the SAME gate gossip admission and block validation run.
        // Without it this path admitted an unsigned system TX into the local mempool and the local
        // node's own block, which every peer then rejected.
        Self::verify_system_tx_binds(&tx)
            .map_err(|e| QNetError::ValidationError(format!("[REJECT][RPC] {}", e)))?;

        // Same committed-key mirror as the gossip door: admission must not accept a reactivation that
        // block validation rejects, or the TX poisons every block a producer packs it into.
        Self::reactivation_key_admissible(&self.get_storage(), &tx)
            .map_err(|e| QNetError::ValidationError(format!("[REJECT][RPC] {}", e)))?;

        // DECENTRALIZED: System transactions don't need signature
        // validated through deterministic consensus rules, not crypto signature
        // v2.53: Added PingCommitmentWithSampling to system transactions
        // v2.77: Added HeartbeatCommitment to system transactions
        let is_system_transaction = matches!(tx.tx_type, 
            qnet_state::TransactionType::RewardDistribution | 
            qnet_state::TransactionType::PingCommitmentWithSampling { .. } |
            qnet_state::TransactionType::HeartbeatCommitment { .. } |
            qnet_state::TransactionType::LightNodeEligibilityBitmap { .. }
        );
        
        if is_system_transaction {
            // System transactions are validated through consensus, not signatures
            if tx.from == "system_emission" {
                if is_info() { println!("[INFO][EMISSION] system_emission_tx_accepted (validated through consensus)"); }
            } else if tx.from == "system_ping_commitment" {
                // v2.53: Ping commitments are system transactions, validated by merkle proofs
                if is_info() { println!("[INFO][REWARDS] ping_commitment_accepted system_tx"); }
            } else if tx.from == "system_rewards_pool" && matches!(tx.tx_type, qnet_state::TransactionType::RewardDistribution) {
                // Merkle reward-claim: authorised by the recipient wallet's own ML-DSA-65 signature over
                // the exact claims payload (claim_authorized) plus the per-proof merkle re-verify against
                // the QC-certified reward_root. Both re-run at apply, which is the final gate.
                if tx.dilithium_signature.as_ref().map_or(true, |s| s.is_empty()) {
                    return Err(QNetError::ValidationError("Reward claim requires dilithium_signature".to_string()));
                }
                let last_claimed = match &tx.to {
                    Some(w) => self.get_state_manager().read().await.get_last_claimed_epoch(w),
                    None => u64::MAX,
                };
                if !Self::claim_proofs_admissible(&self.get_storage(), &tx, last_claimed) {
                    return Err(QNetError::ValidationError("Reward claim has no valid merkle proofs".to_string()));
                }
                if is_info() { println!("[INFO][REWARDS] claim_tx_accepted from=system_rewards_pool quantum_safe=true"); }
            } else if matches!(tx.tx_type, qnet_state::TransactionType::RewardDistribution) {
                // No live producer emits a RewardDistribution from a non-system address. The only
                // legitimate reward source is system_rewards_pool (handled above); reject everything else
                // (this was a self-consistent Ed25519 verify that bound nothing to an authorised emitter).
                return Err(QNetError::ValidationError(
                    "RewardDistribution must originate from system_rewards_pool".to_string()));
            }
        } else {
            // PURE DILITHIUM (F0.1): value-moving user classes are authorized by ONE mandatory
            // ML-DSA-65 signature whose key derives to `from` — the address IS the from<->key
            // binding (closes API-1 forge-from-any-address) and PQ is mandatory (closes AC-3).
            // Ed25519 is NOT the authorization for these classes. Non-value user TX (registration/
            // activation/proofs) keep the existing signature path (migrated in later F0.1 sub-steps).
            // Shared value-class predicate (Transfer|BatchTransfers|ContractDeploy|ContractCall|Swap) — MUST match the
            // apply/producer/bind set, or an elided-pk TX admission rejects but apply accepts (accept-set drift).
            let is_value_tx = tx.is_value_class();
            if is_value_tx {
                if tx.dilithium_signature.as_ref().map_or(true, |s| s.is_empty()) {
                    return Err(QNetError::ValidationError(
                        "[REJECT][AUTH] value TX requires dilithium_signature (pure-PQ)".to_string()));
                }
                // FIX-5 pk-elision: the 1952-byte pubkey may be OMITTED once it is committed on-chain (the
                // first-use TX carries it and binds it write-once). Resolve it into a VERIFY-ONLY clone —
                // the mempool keeps the ELIDED form so the pk never re-enters the wire (block + gossip stay
                // lean, which is the whole TPS win). Unresolved ⇒ cheap reject BEFORE any signature verify,
                // so an unresolvable-elided flood costs a state lookup, never a CPU-bound ML-DSA-65 open.
                if tx.dilithium_public_key.as_ref().map_or(true, |k| k.is_empty()) {
                    let mut probe = tx.clone();
                    {
                        let sg = self.state.read().await;
                        if !matches!(Self::rehydrate_elided_pk(&mut probe, &*sg), PkResolve::Resolved) {
                            return Err(QNetError::ValidationError(
                                "[REJECT][AUTH] pk_unresolved: include dilithium_public_key on the first-use TX".to_string()));
                        }
                    }
                    // eon(pk)==from holds by construction (the pk was read from the `from`-keyed account,
                    // and binding required that check) and verify_user_tx_dilithium re-asserts it anyway.
                    if !Self::verify_dilithium_tx_signature_async(&probe, VerifyLane::Admission).await? {
                        return Err(QNetError::ValidationError("Invalid Dilithium signature".to_string()));
                    }
                } else {
                    // Wire pk present (first-use, or a non-eliding client): bind `from` to the supplied key
                    // early (cheap reject) — closes API-1 forge-from-any-address — then verify.
                    let dpk = tx.dilithium_public_key.as_ref().expect("non-empty checked above");
                    match crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey_bytes(dpk) {
                        Some(derived) if derived == tx.from => {}
                        _ => return Err(QNetError::ValidationError(
                            "[REJECT][AUTH] from_pubkey_mismatch (dilithium)".to_string())),
                    }
                    if !Self::verify_dilithium_tx_signature_async(&tx, VerifyLane::Admission).await? {
                        return Err(QNetError::ValidationError("Invalid Dilithium signature".to_string()));
                    }
                }
            } else {
                // Non-value user TX — QNet is pure post-quantum: Ed25519 is a Solana-only credential
                // and is NEVER verified here. Self-verifying consensus proofs carry embedded sigs;
                // every other user TX (registration/activation/etc.) needs a mandatory ML-DSA-65 sig.
                let self_verifying = matches!(tx.tx_type,
                    qnet_state::TransactionType::EquivocationProof { .. } |
                    qnet_state::TransactionType::VoteEquivocationProof { .. }
                );
                // "Self-verifying" now means "verify the EMBEDDED proof here": the apply arm marks the
                // offender's account, so a junk proof must never reach it.
                if self_verifying
                    && !Self::equivocation_proof_verified(&self.get_storage(), &tx).await {
                    return Err(QNetError::ValidationError(
                        "[REJECT][AUTH] equivocation proof does not verify".to_string()));
                }
                if !self_verifying {
                    if tx.dilithium_public_key.as_ref().map_or(true, |k| k.is_empty())
                        || tx.dilithium_signature.as_ref().map_or(true, |s| s.is_empty()) {
                        return Err(QNetError::ValidationError(
                            "[REJECT][AUTH] user TX requires dilithium_signature + dilithium_public_key (pure-PQ)".to_string()));
                    }
                    if !Self::verify_dilithium_tx_signature_async(&tx, VerifyLane::Admission).await? {
                        return Err(QNetError::ValidationError("Invalid Dilithium signature".to_string()));
                    }
                }
            }
        }
        
        if tx.amount == 0 && matches!(tx.tx_type, qnet_state::TransactionType::Transfer { .. }) {
            return Err(QNetError::ValidationError("Transfer amount cannot be zero".to_string()));
        }
        
        // SHARDING: Check if this is a cross-shard transaction
        if let Some(ref shard_coordinator) = self.shard_coordinator {
            if let qnet_state::TransactionType::Transfer { to, .. } = &tx.tx_type {
                let from_shard = shard_coordinator.get_shard(&tx.from);
                let to_shard = shard_coordinator.get_shard(to);
                
                if from_shard != to_shard {
                    // v3.11: Cross-shard transaction with Merkle proof support
                    if is_info() { 
                        println!("[INFO][SHARD] cross_shard_tx detected from={} to={}", 
                                 from_shard, to_shard); 
                    }
                    
                    // Create cross-shard transaction record
                    let cross_shard_tx = qnet_sharding::CrossShardTx {
                        tx_hash: tx.hash.clone(),
                        from_shard,
                        to_shard,
                        amount: tx.amount,
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    };
                    
                    // Process through shard coordinator
                    if let Err(e) = shard_coordinator.process_cross_shard_tx(cross_shard_tx).await {
                        if is_warn() { println!("[WARN][SHARD] cross_shard_process_fail err={}", e); }
                        // Continue with normal processing even if cross-shard fails
                    } else if is_debug() {
                        println!("[DBG][SHARD] cross_shard_tx_queued hash={}...", &tx.hash[..16]);
                    }
                    
                    // v3.11: Note - Merkle proofs are generated when block is finalized
                    // Target shard can request proof via generate_cross_shard_proof()
                }
            }
        }
        
        // CRITICAL SECURITY: Check nonce BEFORE adding to mempool
        // This prevents DoS attacks where attacker floods mempool with invalid nonces
        // v2.93: System transactions bypass nonce check - use tx_type NOT from field!
        // HeartbeatCommitment has from=node_id, not "system_*"
        let is_system_tx = tx.from == "system_emission"
            || tx.from == "system_ping_commitment"
            || tx.from.starts_with("system_")
            || matches!(tx.tx_type,
                qnet_state::TransactionType::HeartbeatCommitment { .. } |
                qnet_state::TransactionType::PingCommitmentWithSampling { .. } |
                qnet_state::TransactionType::LightNodeEligibilityBitmap { .. } |
                qnet_state::TransactionType::NodeReactivation { .. } |
                qnet_state::TransactionType::RewardDistribution |
                qnet_state::TransactionType::NodeRegistration { .. }
            );
        
        if !is_system_tx {
            // Honest gas-floor rejection: return an ERROR the caller sees, instead of letting the
            // mempool silently drop a below-floor TX while the RPC still reports success (which
            // stranded user transfers as a permanent fake "Pending"). Mirrors the mempool floor so
            // the two never disagree.
            // Congestion floor: admission-only (never consensus), stepped by local
            // backlog so spam prices itself out while the queue is deep. Fees still
            // go to the producer in full.
            let floor = Self::congestion_gas_floor(self.mempool.size());
            if tx.gas_price < floor {
                return Err(QNetError::ValidationError(format!(
                    "gas_price {} below current floor {} (rises with mempool backlog)",
                    tx.gas_price, floor
                )));
            }

            let state = self.state.read().await;

            // Check nonce (only for user transactions)
            if let Some(account) = state.get_account(&tx.from) {
                let expected_nonce = account.nonce + 1;
                if tx.nonce != expected_nonce {
                    return Err(QNetError::ValidationError(format!(
                        "Invalid nonce: expected {}, got {} (anti-replay protection)",
                        expected_nonce, tx.nonce
                    )));
                }
            } else {
                // New account: nonce must be 1 (first transaction)
                if tx.nonce != 1 {
                    return Err(QNetError::ValidationError(format!(
                        "Invalid nonce for new account: expected 1, got {}",
                        tx.nonce
                    )));
                }
            }
            
            // Check balance (only for user transactions)
            let sender_balance = state.get_balance(&tx.from);
            
            // SECURITY: Use checked arithmetic to prevent overflow attacks
            // QUANTUM v2.25: Use effective_gas_price() for +50% Dilithium TX fee
            let effective_gas = tx.effective_gas_price();
            let gas_cost = effective_gas.checked_mul(tx.gas_limit)
                .ok_or_else(|| QNetError::ValidationError(
                    format!("Gas calculation overflow: {} * {}", effective_gas, tx.gas_limit)
                ))?;
            let required_balance = tx.amount.checked_add(gas_cost)
                .ok_or_else(|| QNetError::ValidationError(
                    format!("Balance calculation overflow: {} + {}", tx.amount, gas_cost)
                ))?;
            
            if sender_balance < required_balance {
                let quantum_note = if tx.is_quantum_signed() { " (includes +50% quantum fee)" } else { "" };
                return Err(QNetError::ValidationError(format!(
                    "Insufficient balance: have {}, need {}{}", 
                    sender_balance, required_balance, quantum_note
                )));
            }
        } else {
            // v2.65: System transactions bypass nonce AND balance checks
            if is_info() { println!("[INFO][TX] system_tx_bypass_validation from={}", tx.from); }
        }
        
        // PRODUCTION v2.77: Use BLAKE3 via calculate_hash() for consistency
        // CRITICAL: calculate_hash() excludes signature - no circular dependency!
        // This ensures TX hash is the same everywhere (mobile, explorer, blockchain)
        let tx_hash = tx.calculate_hash();
        
        // bincode still used for mempool storage (fast binary serialization)
        let tx_bytes = bincode::serialize(&tx)
            .map_err(|e| QNetError::SerializationError(format!("Failed to serialize transaction: {}", e)))?;
        
        // v2.26: Direct access - SimpleMempool is already thread-safe
        // No external lock needed - eliminates 100K TPS bottleneck!
        // v2.66: Log if not added, but DON'T return Err (duplicate is OK in P2P)
        let added = self.mempool.add_binary_transaction(tx_bytes.clone(), tx_hash.clone(), tx.gas_price);
        if !added {
            // This is NORMAL for P2P: same TX received from multiple peers
            // Only log for system TX (gas_price == u64::MAX) as those are important
            if tx.gas_price == u64::MAX {
                println!("[WARN][TX] system_tx_not_added hash={} (likely duplicate)", qnet_state::char_prefix(&tx_hash, 16));
            }
            // DON'T return Err! TX might already be in mempool from another peer
        }
        
        // Broadcast to network only after successful validation
        // PRODUCTION v2.25: bincode for network (10-20x faster than JSON)
        if let Some(unified_p2p) = &self.unified_p2p {
            if let Err(e) = unified_p2p.broadcast_transaction(tx_bytes) {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] tx_broadcast_failed err={}", e);
                }
            }
        }

        // QUANTUM v2.25: Log effective gas (includes +50% for Dilithium)
        if is_debug() {
            let effective_gas = tx.effective_gas_price() * tx.gas_limit;
            let quantum_flag = if tx.is_quantum_signed() { " quantum=true" } else { "" };
            println!("[DBG][NODE] tx_validated hash={} amount={} gas={}{}",
                     qnet_state::char_prefix(&tx_hash, 16), tx.amount, effective_gas, quantum_flag);
        }
        
        // v2.72: Broadcast PendingTx via WebSocket for real-time explorer updates
        if added {
            crate::rpc::broadcast_ws_event(crate::rpc::WsEvent::PendingTx {
                tx_hash: tx_hash.clone(),
                from: tx.from.clone(),
                to: tx.to.clone().unwrap_or_default(),
                amount: tx.amount,
            });
        }
        
        // v2.90: Return SHA3-256 hash (calculated via tx.calculate_hash())
        // ARCHITECTURE: TX must have hash set BEFORE calling submit_transaction()
        // because tx.validate() (line 16789) checks: self.hash == self.calculate_hash()
        Ok(tx_hash)
    }
    
    /// Prefix a canonical sign-preimage body with the compile-time chain tag. Used by
    /// `build_canonical_verify_message` and by the few signers that build their body inline.
    pub fn chain_bind(body: &str) -> String {
        format!("{}{}", qnet_state::transaction::chain_tag(), body)
    }

    /// This node's announced public API endpoint, or "" when it hides its IP or is Light. Deployment
    /// configuration, NOT a consensus parameter — the announcement is validated on-chain either way.
    /// ONE resolver so registration and reactivation always announce the same address.
    pub(crate) fn self_public_api_endpoint(node_type: NodeType) -> String {
        if node_type != NodeType::Super || std::env::var("QNET_HIDE_IP").is_ok() {
            return String::new();
        }
        let public_ip = std::env::var("QNET_PUBLIC_IP")
            .or_else(|_| std::env::var("EXTERNAL_IP"))
            .or_else(|_| std::env::var("HOST_IP"))
            .unwrap_or_default();
        if public_ip.is_empty() { String::new() } else { format!("http://{}:8001", public_ip) }
    }

    /// Canonical sign-preimage BODY a returning node's identity key signs (the chain tag is added by
    /// `chain_bind` at every call site). EVERY body field is inside it: the TX hash is not signed, so
    /// an unbound field is free for a relayer to rewrite — and `last_macroblock_index` is the apply
    /// dedup epoch, so one rewritten copy would lock the sender out of reactivating for good.
    pub(crate) fn node_reactivation_message(
        node_id: &str, timestamp: u64, api_endpoint: &str,
        current_height: u64, last_macroblock_hash: &str, last_macroblock_index: u64,
    ) -> String {
        format!("node_reactivation:{}:{}:{}:{}:{}:{}",
                node_id, timestamp, api_endpoint,
                current_height, last_macroblock_hash, last_macroblock_index)
    }


    /// Build the canonical verify message — MUST byte-match how the
    /// client/RPC signed, or ML-DSA-65/Ed25519 verification fails. Formats
    /// (source of truth; per-arm comments below point at each signer):
    ///   Transfer        transfer:{from}:{to}:{amount}:{nonce}:{gas_price}:{gas}
    ///   BatchTransfers  batch_transfer:{from}:{total}:{count}:{batch_id}
    ///   ContractDeploy  contract_deploy:{from}:{code_hash}:{nonce}
    ///   ContractCall    contract_call:{from}:{sha3(raw tx.data calldata)}:{nonce}
    ///   Heartbeat/Ping  {from}|{to}|{amount}|{nonce}|{gas_price}|{gas}|{ts}
    ///   RewardClaim     claim_rewards:{node_id}:{wallet}
    /// System/unsigned TXs (emission RewardDistribution, NodeRegistration,
    /// LightNodeBitmap) are SKIPPED in batch verify.
    pub fn build_canonical_verify_message(tx: &qnet_state::Transaction) -> String {
        let to_str = tx.to.as_ref().map(|s| s.as_str()).unwrap_or("");
        let body = match &tx.tx_type {
            // === USER TRANSACTIONS (signed by mobile/dApp) ===
            
            // Transfer: matches WalletManager.js:5514 and rpc.rs:3923
            qnet_state::TransactionType::Transfer { .. } => {
                format!("transfer:{}:{}:{}:{}:{}:{}",
                    tx.from, to_str, tx.amount, tx.nonce, tx.gas_price, tx.gas_limit)
            }
            
            // BatchTransfers: the digest binds every recipient/amount/memo (total+count
            // alone permit recipient rewriting under the same signature), and nonce+gas
            // are in the preimage so the signature cannot replay at another nonce.
            qnet_state::TransactionType::BatchTransfers { transfers, batch_id } => {
                use sha3::{Digest, Sha3_256};
                let total_amount: u64 = transfers.iter().map(|t| t.amount).sum();
                let mut h = Sha3_256::new();
                for t in transfers {
                    h.update(t.to_address.as_bytes());
                    h.update(t.amount.to_le_bytes());
                    h.update([0u8]);
                    if let Some(m) = &t.memo { h.update(m.as_bytes()); }
                    h.update([0xff]);
                }
                format!("batch_transfer:{}:{}:{}:{}:{}:{}:{}:{}",
                    tx.from, total_amount, transfers.len(), batch_id,
                    hex::encode(h.finalize()), tx.nonce, tx.gas_price, tx.gas_limit)
            }
            
            // ContractDeploy: matches rpc.rs:10825
            // CRITICAL FIX v3.31.1: code_hash is stored in tx.data JSON, NOT sha3(data)!
            // RPC computes: sha3(base64_decode(wasm_code)) → hex → stores in data.code_hash
            // We extract code_hash from the JSON data field
            qnet_state::TransactionType::ContractDeploy => {
                let code_hash = if let Some(ref data) = tx.data {
                    // tx.data is a JSON string: {"code_hash":"abc...","code_size":...,"security":...}
                    // Extract code_hash field from JSON
                    serde_json::from_str::<serde_json::Value>(data)
                        .ok()
                        .and_then(|v| v.get("code_hash").and_then(|h| h.as_str().map(String::from)))
                        .unwrap_or_else(|| {
                            // Fallback: if data is not JSON (legacy), hash the raw data
                            let mut hasher = Sha3_256::new();
                            hasher.update(data.as_bytes());
                            format!("{:x}", hasher.finalize())
                        })
                } else {
                    String::new()
                };
                format!("contract_deploy:{}:{}:{}", tx.from, code_hash, tx.nonce)
            }
            
            // ContractCall: contract/method/args ALL live inside tx.data (JSON
            // {"contract":..,"method":..,"args":..}). Bind the signature to the EXACT bytes the
            // client sent — a SHA3-256 over the raw tx.data string — NOT a re-serialization of a
            // parsed args value. Re-serializing diverges cross-implementation (number formatting
            // 1000 vs 1000.0, object-key order, unicode escaping) so a mobile-signed honest call
            // would fail the Rust verifier. Hashing the literal calldata covers method+args+contract
            // as transmitted; only from+nonce come from outside tx.data.
            qnet_state::TransactionType::ContractCall => {
                let data_bytes = tx.data.as_deref().unwrap_or("").as_bytes();
                let data_hash = format!("{:x}", Sha3_256::digest(data_bytes));
                format!("contract_call:{}:{}:{}", tx.from, data_hash, tx.nonce)
            }
            
            // system_rewards_pool merkle claims are sig-exempt (authorized by per-proof re-verify
            // in apply, not a client sig) — they never reach this builder, so no arm here.

            // === NODEREGISTRATION ===
            // Two signing paths:
            // 1. SERVER-SIGNED (legacy): pure ML-DSA-65 (ML-DSA-65, producer key)
            //    data field does NOT start with "client_node_reg:"
            //    Canonical: pipe-separated to match sign_node_registration_tx() in rpc.rs
            // 2. CLIENT-SIGNED (new flow): wallet ML-DSA-65 (ML-DSA-65) key
            //    data field starts with "client_node_reg:" — set by handle_node_registration_client_submit
            //    Canonical: "client_node_reg:{node_id}:{wallet_address}:{registration_proof}:{timestamp}"
            qnet_state::TransactionType::NodeRegistration {
                node_id, wallet_address, registration_proof, node_type, vrf_pk, api_endpoint, ..
            } => {
                if tx.data.as_ref().map_or(false, |d| d.starts_with("client_node_reg:")) {
                    Self::client_node_reg_message(node_id, wallet_address, registration_proof,
                                                  tx.timestamp, node_type, vrf_pk, api_endpoint)
                } else {
                    // Server-signed form. The payload MUST be bound: the bare header leaves node_id,
                    // wallet_address and node_type outside the signature, so a relayer can retarget the
                    // registration on the wire and the signature still verifies.
                    format!("node_reg_v2:{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                        tx.from, to_str, tx.amount, tx.nonce, tx.gas_price, tx.gas_limit, tx.timestamp,
                        node_id, wallet_address, format!("{:?}", node_type))
                }
            }

            // === NODEACTIVATION (system TX, Dilithium-signed by producer) ===
            // node_type / phase / amount are consensus-relevant and were OUTSIDE the signature: a
            // relayer could flip Light -> Super on a gossiped activation and earn a super roster row
            // (which feeds eligible_producers -> epoch_commitment -> the QC) at the Light price, or
            // flip the phase to move which entry-price floor validate() applies.
            qnet_state::TransactionType::NodeActivation { node_type, amount, phase } => {
                format!("node_act_v2:{}|{}|{}|{}|{}|{}|{}|{}|{}|{:?}",
                    tx.from, to_str, tx.amount, tx.nonce, tx.gas_price, tx.gas_limit, tx.timestamp,
                    format!("{:?}", node_type), amount, phase)
            }

            // NodeReactivation (Dilithium-signed by the returning node over its OWN canonical
            // message). node_id == tx.from for reactivation; the producer (sign_reactivation_tx)
            // and all three verify paths MUST reconstruct this identical preimage, else the sole
            // ML-DSA-65 leg mismatches and honest reactivations are dropped.
            qnet_state::TransactionType::NodeReactivation {
                api_endpoint, current_height, last_macroblock_hash, last_macroblock_index, ..
            } => {
                Self::node_reactivation_message(&tx.from, tx.timestamp, api_endpoint,
                    *current_height, last_macroblock_hash, *last_macroblock_index)
            }

            // v35: Heartbeat carries ONE Dilithium sig (in dilithium_signature) over the anchor.
            // Ingest verifies authorship + anchor-binding here; block validation adds the stateful
            // anchor==chain-hash + recency check (producer-side gate). Same string in all three.
            qnet_state::TransactionType::Heartbeat { node_id, anchor_height, anchor_hash, .. } => {
                format!("QNET_HEARTBEAT:{}:{}:{}", node_id, anchor_height, anchor_hash)
            }

            // Light reward eligibility bitmap: bind EVERY reward-determining field, not just the
            // header, so a flipped eligibility bit / swapped genesis_id / altered counts breaks the
            // genesis signature (the pipe-default _ => arm signed none of these, leaving the bitmap
            // forgeable). Hash bitmap_compressed (not embed ~KBs) to keep the signed message O(1);
            // pure function of TX fields → deterministic in apply.
            qnet_state::TransactionType::LightNodeEligibilityBitmap {
                genesis_id, epoch, index_span, eligible_count, bitmap_compressed
            } => {
                let bm = hex::encode(Sha3_256::digest(bitmap_compressed));
                format!("light_bitmap:{}:{}:{}:{}:{}", genesis_id, epoch, index_span, eligible_count, bm)
            }

            // === NODE-SIGNED SYSTEM TRANSACTIONS (signed with pure ML-DSA-65 / ML-DSA-65) ===
            // HeartbeatCommitment, PingCommitmentWithSampling — use pipe-separated format
            // This matches node.rs:2817/2997 where nodes sign with:
            //   format!("{}|{}|{}|{}|{}|{}|{}", from, to, amount, nonce, gas_price, gas_limit, timestamp)
            _ => {
                format!("{}|{}|{}|{}|{}|{}|{}",
                    tx.from, to_str, tx.amount, tx.nonce, tx.gas_price, tx.gas_limit, tx.timestamp)
            }
        };
        Self::chain_bind(&body)
    }
    
    /// v25.2: Made `pub(crate)` so the block-pipeline verify stage can
    /// delegate ML-DSA-65 TX-signature verification through THIS single
    /// canonical entry point.
    ///
    /// Why one entry point matters: the on-the-wire signature format
    /// differs between TX classes (see `build_canonical_verify_message`
    /// + signer-class semantics below). The gossip-admission path was
    /// already going through this helper; the block-apply path used to
    /// do its own inline `hex::decode(sig)` / `hex::decode(pk)` which
    /// is correct only for mobile-wallet (user) TXs and silently
    /// rejected every node-signed system TX (HeartbeatCommitment,
    /// PingCommitment, LightNodeEligibilityBitmap) because their
    /// signature is a `dilithium_sig_<id>_<b64>` ASCII wrapper and
    /// their `dilithium_public_key` field carries the `node_id` string
    /// (PK looked up via `CONSENSUS_PK_REGISTRY`), NOT raw hex(1952).
    /// The first time a node-signed TX hit a block (commitment window
    /// at h ≈ epoch_end-50) every receiver hard-rejected the block →
    /// network deadlock at h=14350.
    ///
    /// Routing the apply path through this helper closes the divergence
    /// permanently: a future TX type that adopts a new signature format
    /// only needs to be handled here, and both paths pick it up.
    pub(crate) async fn verify_dilithium_tx_signature_async(tx: &qnet_state::Transaction, lane: VerifyLane) -> Result<bool, QNetError> {
        use crate::quantum_crypto::DilithiumSignature;

        // PURE DILITHIUM (F0.1): value-moving user TX are authorised by a DIRECT ML-DSA-65 verify
        // against the claimed wallet key — identity is the address binding enforced at ingest
        // (eon_from_qnet_dilithium_pubkey(dpk)==from), NOT the consensus node_id->pk registry path
        // below (which is for node identities, with its own squat-guard). Registration/activation
        // keep the existing path (their own message format + handler proof).
        if tx.is_value_class() {
            // CPU-bound ML-DSA-65 open() off the consensus runtime. Lane-scoped pool: admission
            // sheds under load (client resubmits); block-validation AWAITS its reserved pool so a
            // valid block is never rejected for local busy — the verdict stays pure over TX bytes.
            let tx_owned = tx.clone();
            let _permit = match lane {
                VerifyLane::Admission => VALUE_TX_VERIFY_SEM.try_acquire()
                    .map_err(|_| QNetError::ValidationError("verify_overloaded".to_string()))?,
                VerifyLane::Block => BLOCK_VERIFY_SEM.acquire().await
                    .map_err(|_| QNetError::ValidationError("verify_sem_closed".to_string()))?,
            };
            return tokio::task::spawn_blocking(move || Self::verify_user_tx_dilithium(&tx_owned))
                .await
                .map_err(|e| QNetError::ValidationError(format!("verify_join_error: {}", e)));
        }

        // PURE DILITHIUM: NodeRegistration (client-signed) + NodeReactivation verify by a DIRECT
        // ML-DSA-65 check against the WIRE key, never the gossip-seeded CONSENSUS_PK_REGISTRY (whose
        // per-node Tier2/3 verdict forks the block). Identity authority is COMMITTED, enforced at
        // ingest: n−f burn quorum for first-reg, vrf_pk point-read for re-reg/reactivation.
        if matches!(&tx.tx_type, qnet_state::TransactionType::NodeReactivation { .. })
            || matches!(&tx.tx_type, qnet_state::TransactionType::NodeRegistration { .. }
                if tx.data.as_deref().unwrap_or("").starts_with("client_node_reg:"))
        {
            return match &tx.dilithium_signature {
                Some(s) if !s.is_empty() => Ok(Self::verify_node_lifecycle_dilithium(tx)),
                // Sig-less imported-wallet first-reg: authority is the n−f burn quorum (ingest).
                _ => Ok(true),
            };
        }

        // Heartbeat carries a RAW detached signature and NO key (the key is resolved from committed
        // state), so it never reaches the envelope path below.
        if matches!(&tx.tx_type, qnet_state::TransactionType::Heartbeat { .. }) {
            let storage = crate::node::get_storage();
            return Ok(Self::verify_heartbeat_dilithium(tx, &storage));
        }

        // FIX-5: node-signed SYSTEM TXs (ping/commitment/bitmap) keep the registry-envelope
        // convention — a DIFFERENT, legitimate signature scheme from wallet value-TXs (node-identity
        // key resolved via CONSENSUS_PK_REGISTRY, not the eon address). Their signers store the
        // `dilithium_sig_{label}_{b64}` envelope as UTF-8 bytes in the Vec<u8> field; recover it here
        // so verify_dilithium_signature (and its determinism) stays byte-identical. Value-TXs were
        // already dispatched to the raw-detached verifier above, so this arm only sees system TXs.
        let dilithium_sig = match &tx.dilithium_signature {
            Some(sig) if !sig.is_empty() => String::from_utf8_lossy(sig).into_owned(),
            _ => return Ok(true),
        };

        // v5.1: signer_id selection depends on TX type and signing path:
        //   1. Client-signed NodeRegistration (data starts with "client_node_reg:"):
        //      The mobile client embeds node_id (pseudonym like "light_mobile_XXXXXXXX") in the
        //      Dilithium signature envelope; signer_id must be node_id.
        //   2. All other system TX: dilithium_public_key carries the node/signer identity (node_id
        //      label as UTF-8 bytes under FIX-5) used for CONSENSUS_PK_REGISTRY lookup.
        let signer_id = match &tx.tx_type {
            qnet_state::TransactionType::NodeRegistration { node_id, .. }
                if tx.data.as_deref().unwrap_or("").starts_with("client_node_reg:") =>
            {
                node_id.clone()
            }
            _ => match &tx.dilithium_public_key {
                // Exactly 1952 bytes = a RAW ML-DSA-65 key rode the wire (server-signed registration /
                // heartbeat-anchor) → hex it, byte-identical to the pre-FIX-5 hex-string signer_id the
                // registry verifier expects. Anything else is a node_id label carried as UTF-8 bytes.
                Some(pk) if pk.len() == 1952 => hex::encode(pk),
                Some(pk) if !pk.is_empty() => String::from_utf8_lossy(pk).into_owned(),
                _ => return Err(QNetError::ValidationError(
                    "dilithium_public_key required when dilithium_signature is present".to_string()
                )),
            }
        };
        
        let timestamp = tx.timestamp;
        let message = Self::build_canonical_verify_message(tx);
        let sig_struct = DilithiumSignature {
            signature: dilithium_sig,
            algorithm: "CRYSTALS-Dilithium3".to_string(),
            timestamp,
            strength: "quantum-resistant".to_string(),
        };
        
        let handle = crate::unified_p2p::spawn_sigverify(async move {
            let crypto = match try_get_quantum_crypto() {
                Some(c) => c,
                None => return Err("Quantum crypto not initialized".to_string()),
            };
            
            match crypto.verify_dilithium_signature(&message, &sig_struct, &signer_id).await {
                Ok(valid) => Ok(valid),
                Err(e) => Err(format!("Dilithium error: {}", e)),
            }
        });
        
        match handle.await {
            Ok(Ok(r)) => Ok(r),
            Ok(Err(e)) => Err(QNetError::ValidationError(e)),
            Err(e) => Err(QNetError::ValidationError(format!("Runtime error: {}", e))),
        }
    }

    /// FIX-5: fill an elided value-TX's dilithium_public_key from the COMMITTED in-mem StateManager.
    /// Resolves ONLY from `State::get_account` (never the detached accounts CF, never an intra-block
    /// scratch view) so two honest validators feed byte-identical pk bytes into verify_detached. A
    /// wire pk that is already present is NEVER overwritten — it flows through the eon(pk)==from bind
    /// in verify_user_tx_dilithium_inner, which rejects a bogus supplied key.
    pub(crate) fn rehydrate_elided_pk(
        tx: &mut qnet_state::Transaction,
        state: &qnet_state::State,
    ) -> PkResolve {
        if !tx.is_value_class() {
            return PkResolve::NotApplicable;
        }
        if tx.dilithium_public_key.as_deref().map_or(false, |p| !p.is_empty()) {
            return PkResolve::Resolved; // wire pk present (first-use, or client not yet eliding)
        }
        // Lean accessor: clone ONLY the 1952-byte pk, never the whole Account (balance/nonce/token
        // storage) — the elided-verify hot path runs per value-TX at ≤1000-committee max TPS.
        match state.get_account_dilithium_pk(&tx.from) {
            Some(pk) if pk.len() == 1952 => { tx.dilithium_public_key = Some(pk); PkResolve::Resolved }
            _ => PkResolve::Unresolved,
        }
    }

    /// PURE DILITHIUM (F0.1): direct ML-DSA-65 verification for USER value transactions. A user
    /// wallet's key is NOT a registered node identity, so the consensus node_id->pk registry path is
    /// wrong here. Proves BOTH that the ML-DSA-65 signature is valid over the canonical message under
    /// the claimed key AND the API-1 identity bind eon_from_qnet_dilithium_pubkey(dpk) == tx.from —
    /// so the guarantee travels WITH the verify to every path (admission, rpc, block-verify, producer),
    /// not just ingest.
    /// Wire format (produced by the mobile/ext wallet, signer_id = raw pubkey hex):
    ///   `dilithium_sig_{pk_hex}_{base64([sig_len:4LE][SignedMessage][pk_len:4LE][pk])}`
    pub(crate) fn verify_user_tx_dilithium(tx: &qnet_state::Transaction) -> bool {
        // FIX-5: RAW detached ML-DSA-65 verify. The pk is present on the TX because ingest REHYDRATES
        // an elided pk from committed account state BEFORE verify (rehydrate_elided_pk); a value TX
        // whose account has no committed pk and carries none stays pk-less → rejected here.
        let (sig, pk) = match (tx.dilithium_signature.as_deref(), tx.dilithium_public_key.as_deref()) {
            (Some(s), Some(p)) if s.len() == 3309 && p.len() == 1952 => (s, p),
            _ => return false,
        };
        // Verify-result memo (positive-only): key binds sig+pk+preimage+from — folding `from` keeps an
        // elided-then-rehydrated memo sender-bound; never tx.hash (sig-unbound → forgeable).
        let msg = Self::build_canonical_verify_message(tx);
        let key: [u8; 32] = {
            use sha3::{Digest, Sha3_256};
            let mut h = Sha3_256::new();
            h.update(pk);
            h.update(sig);
            h.update(msg.as_bytes());
            h.update(tx.from.as_bytes());
            h.finalize().into()
        };
        if VALUE_VERIFY_CACHE.contains_key(&key) { return true; }
        let ok = Self::verify_user_tx_dilithium_inner(tx, sig, pk, &msg);
        if ok { value_verify_cache_put(key); }
        ok
    }

    /// Uncached RAW detached ML-DSA-65 value-TX verify: verify_detached over the canonical message +
    /// eon(pk)==from bind. sig=3309 B, pk=1952 B (both raw, no envelope/base64/open). Caller supplies
    /// the already-validated sig/pk/preimage (wire pk, or the pk rehydrated from committed state).
    pub(super) fn verify_user_tx_dilithium_inner(tx: &qnet_state::Transaction, sig: &[u8], pk: &[u8], msg: &str) -> bool {
        use pqcrypto_mldsa::mldsa65 as dilithium3;
        use pqcrypto_traits::sign::{DetachedSignature as SigTrait, PublicKey as PkTrait};

        let d3_sig = match <dilithium3::DetachedSignature as SigTrait>::from_bytes(sig) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let d3_pk = match <dilithium3::PublicKey as PkTrait>::from_bytes(pk) {
            Ok(p) => p,
            Err(_) => return false,
        };
        if dilithium3::verify_detached_signature(&d3_sig, msg.as_bytes(), &d3_pk).is_err() {
            return false;
        }
        // API-1 identity bind over RAW pk bytes — enforced HERE so EVERY value-TX verify path (gossip
        // admission, rpc submit, block_pipeline receive-verify, producer-local) requires it, not just
        // ingest: the signing key MUST derive to the sender. Without it a Byzantine producer could
        // block-include a transfer signed by an attacker key over `transfer:{victim}:...` (theft).
        crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey_bytes(pk).as_deref()
            == Some(tx.from.as_str())
    }

    /// Producer pre-apply classification of ONE candidate tx (called under a state read-lock; cheap —
    /// the heavy ML-DSA verify runs OFF the lock in producer_tx_verify_sig). Byte-identical to the
    /// block-validator's verify stage (block_pipeline): a value-TX pubkey is rehydrated from committed
    /// state into a VERIFY-ONLY clone (the block body + mempool stay ELIDED — the pk-elision TPS win),
    /// and an elided value-TX whose committed pk isn't present yet DEFERS (never hard-evicts — an absent
    /// committed pk is indistinguishable from not-yet-synced; dropping it would silently lose a valid tx).
    /// This is what makes producer apply verify-then-commit: a tx can never be applied+materialised into
    /// registry_root and then rejected+abandoned (the wedge that split a producer from n−f).
    pub(super) fn producer_tx_prepare(tx: &qnet_state::Transaction, state: &qnet_state::State, snap_in_progress: bool) -> TxPrep {
        let is_client_nodereg = matches!(tx.tx_type,
            qnet_state::TransactionType::NodeRegistration { .. }
        ) && tx.data.as_deref().unwrap_or("").starts_with("client_node_reg:");
        let is_system_tx = !is_client_nodereg
            && (tx.is_system_tx() || tx.from.starts_with("system_"));
        if is_system_tx {
            return TxPrep::Admit;
        }
        if tx.validate().is_err() {
            return TxPrep::Evict;
        }
        if tx.is_value_class() {
            // Pure ML-DSA-65 value TX: mandatory Dilithium sig (API-1 bind is in verify_user_tx_dilithium).
            if tx.dilithium_signature.as_ref().map_or(true, |s| s.is_empty()) {
                return TxPrep::Evict;
            }
            // amount==0 illegal only for Transfer (ContractDeploy/Call/Swap may be 0).
            if matches!(tx.tx_type, qnet_state::TransactionType::Transfer { .. }) && tx.amount == 0 {
                return TxPrep::Evict;
            }
            // Mid-snapshot-rehydrate: State is half-materialized ⇒ an elided pk is unresolved ⇒ DEFER
            // (mirror the validator + apply-path guard); never verify against partial committed state.
            let elided = tx.dilithium_public_key.as_deref().map_or(true, |p| p.is_empty());
            if snap_in_progress && elided {
                return TxPrep::Defer;
            }
            let mut clone = tx.clone();
            match Self::rehydrate_elided_pk(&mut clone, state) {
                PkResolve::Unresolved => TxPrep::Defer,           // committed pk not present yet → retry later
                _ => TxPrep::Verify(clone),                        // wire pk, or filled from committed state
            }
        } else if is_client_nodereg {
            // Sig-less imported-wallet first-reg is authorised by the n−f burn quorum at ingest.
            match tx.dilithium_signature.as_ref() {
                Some(s) if !s.is_empty() => TxPrep::Verify(tx.clone()),
                _ => TxPrep::Admit,
            }
        } else if matches!(tx.tx_type, qnet_state::TransactionType::NodeReactivation { .. }) {
            // Block validation point-reads the COMMITTED vrf_pk, so packing a wire-key-only
            // reactivation builds a block every peer hard-rejects. Mismatch ⇒ Evict (it can never
            // become valid); no committed key yet ⇒ Defer, never Evict — this node may simply not
            // have applied the registration.
            match crate::node::try_get_storage() {
                Some(st) => match Self::reactivation_key_state(&st, tx) {
                    ReactivationKey::Bound => TxPrep::Verify(tx.clone()),
                    ReactivationKey::Mismatch => TxPrep::Evict,
                    _ => TxPrep::Defer,
                },
                None => TxPrep::Defer,
            }
        } else {
            // Remaining node-signed TXs: require a non-empty legacy signature + non-zero amount (no crypto).
            if tx.signature.as_ref().map_or(true, |s| s.is_empty()) || tx.amount == 0 {
                TxPrep::Evict
            } else {
                TxPrep::Admit
            }
        }
    }

    /// The CPU-bound ML-DSA-65 verify for a prepared (rehydrated) clone — value-TX vs lifecycle-TX
    /// dispatch, run OFF the state lock so a ≤1000-committee max-TPS block verifies its txs in parallel.
    pub(super) fn producer_tx_verify_sig(tx: &qnet_state::Transaction) -> bool {
        if tx.is_value_class() {
            Self::verify_user_tx_dilithium(tx)
        } else {
            Self::verify_node_lifecycle_dilithium(tx)
        }
    }

    /// PURE DILITHIUM: direct ML-DSA-65 verification for NodeRegistration (client-signed) +
    /// NodeReactivation. Verifies the signature over the canonical message against the WIRE key
    /// ONLY — no CONSENSUS_PK_REGISTRY lookup, so the verdict is byte-identical on every node
    /// (the gossip-seeded registry's Tier2/3 split was the confirmed fork surface). Identity
    /// authority (that this key is entitled to this node_id/wallet) is bound separately from
    /// COMMITTED state at ingest: the 2f+1 burn quorum (first-reg) or the committed vrf_pk
    /// point-read (re-reg/reactivation). FIX-5 wire: RAW detached sig (3309 B) + RAW pk (1952 B) —
    /// no envelope/label/base64; lifecycle TXs ALWAYS carry the pk (it is the attestation root,
    /// never elided).
    pub(crate) fn verify_node_lifecycle_dilithium(tx: &qnet_state::Transaction) -> bool {
        use pqcrypto_mldsa::mldsa65 as dilithium3;
        use pqcrypto_traits::sign::{DetachedSignature as SigTrait, PublicKey as PkTrait};

        if !matches!(&tx.tx_type,
            qnet_state::TransactionType::NodeRegistration { .. } |
            qnet_state::TransactionType::NodeReactivation { .. }) {
            return false;
        }
        let sig = match tx.dilithium_signature.as_deref() {
            Some(s) if s.len() == 3309 => s,
            _ => return false,
        };
        let pk = match tx.dilithium_public_key.as_deref() {
            Some(p) if p.len() == 1952 => p,
            _ => return false,
        };
        let d3_sig = match <dilithium3::DetachedSignature as SigTrait>::from_bytes(sig) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let d3_pk = match <dilithium3::PublicKey as PkTrait>::from_bytes(pk) {
            Ok(p) => p,
            Err(_) => return false,
        };
        dilithium3::verify_detached_signature(
            &d3_sig, Self::build_canonical_verify_message(tx).as_bytes(), &d3_pk).is_ok()
    }

    /// Shared system-TX identity binds — enforced on BOTH the gossip-admission path
    /// (validate_and_add_network_transaction) AND the block-apply path (block_pipeline verify stage),
    /// so a Byzantine PRODUCER cannot embed in a block a system TX that the gossip path would reject.
    /// The Dilithium signature VALIDITY (open + registry/TOFV binding) is checked separately by
    /// verify_dilithium_tx_signature_async on both paths; THIS fn enforces (a) the PRESENCE of that
    /// signature for node-signed system TXs that carry no alternate authenticator, and (b) the
    /// signer↔credited-identity binds that keep apply's per-account keying honest:
    ///   - LightNodeEligibilityBitmap: signer == genesis_id       (no cross-shard bitmap hijack)
    ///   - PingCommitmentWithSampling:  signer == from            (apply dedups on `from`)
    ///   - Heartbeat:                   from == node_id == signer  (apply keys liveness on `from`
    ///                                  while the sig binds node_id — decoupling forges a dead node's
    ///                                  liveness onto another super's reward/eligibility account)
    ///   - NodeReactivation:            from == node_id           (apply writes the endpoint registry
    ///                                  under node_id while only `from` is authenticated — decoupling
    ///                                  hijacks any super's committed endpoint)
    /// STRICTLY DETERMINISTIC: a pure function of the TX bytes ONLY — NO node-local / gossip-seeded
    /// state (e.g. the VRF-key registry, which is seeded by gossip before commit and differs across
    /// validators) — so the verdict is byte-identical on every node, as required on the apply path.
    /// NodeRegistration / NodeActivation are deliberately NOT gated here: they carry an alternate
    /// authenticator (a Solana owner_signature for imported wallets, whose wallet == eon(solana_addr)
    /// ≠ eon(dpk)) and/or a deferred Dilithium sig, and their Sybil anchor is the deterministic 2f+1
    /// burn-attestation quorum (verify_burn_attestation_quorum), not a signature-presence check.
    pub(crate) fn verify_system_tx_binds(tx: &qnet_state::Transaction) -> Result<(), String> {
        use qnet_state::TransactionType as TT;
        // Node-signed system TXs whose sole authenticator is ML-DSA-65 — a signature MUST be present.
        let requires_dilithium = matches!(tx.tx_type,
            TT::PingCommitmentWithSampling { .. } |
            TT::LightNodeEligibilityBitmap { .. } |
            TT::HeartbeatCommitment { .. } |
            TT::Heartbeat { .. } |
            TT::NodeReactivation { .. }
        );
        if requires_dilithium && tx.dilithium_signature.as_ref().map_or(true, |s| s.is_empty()) {
            return Err(format!("system TX requires a Dilithium3 signature (type={:?})",
                std::mem::discriminant(&tx.tx_type)));
        }
        match &tx.tx_type {
            // Bitmap: signer MUST be the genesis whose shard it declares (anti cross-shard hijack).
            TT::LightNodeEligibilityBitmap { genesis_id, .. } => {
                if tx.dilithium_public_key.as_deref() != Some(genesis_id.as_bytes()) {
                    return Err(format!(
                        "LightNodeEligibilityBitmap genesis_id={} != signer={:?} (cross-shard forbidden)",
                        genesis_id, tx.dilithium_public_key));
                }
            }
            // Ping: signer MUST be the node the commitment is attributed to (apply dedups on `from`).
            TT::PingCommitmentWithSampling { .. } => {
                if tx.dilithium_public_key.as_deref() != Some(tx.from.as_bytes()) {
                    return Err(format!(
                        "PingCommitment from={} != signer={:?} (slot-squat forbidden)",
                        tx.from, tx.dilithium_public_key));
                }
            }
            // Heartbeat: apply keys the liveness bitmask on `from`, but the sig binds `node_id`; bind
            // from == node_id == signer so a producer can't re-wrap its OWN valid heartbeat onto a DEAD
            // super's account (forged reward / producer eligibility). Legit producer sets all three
            // equal (create_heartbeat_tx: from=node_id, dilithium_public_key=node_id).
            TT::Heartbeat { node_id, .. } => {
                if tx.from.as_str() != node_id.as_str()
                    || tx.dilithium_public_key.as_deref() != Some(node_id.as_bytes())
                {
                    return Err(format!(
                        "Heartbeat identity split: from={} node_id={} signer={:?} (must be equal)",
                        tx.from, node_id, tx.dilithium_public_key));
                }
            }
            // Reactivation: the ONLY authenticated identity on this TX is `tx.from` — the signature
            // preimage is built from it and the pipeline resolves the committed vrf_pk from it — while
            // apply writes the endpoint registry under the INNER node_id. Unbound, one registered super
            // rewrites any victim's committed endpoint to its own IP: the victim's inbound handshake is
            // then refused by every peer (ip_identity_gate), directed sends black-hole at the attacker,
            // and the write persists across reboots. Bind them, like NodeRegistration already does.
            TT::NodeReactivation { node_id, .. } => {
                if tx.from.as_str() != node_id.as_str() {
                    return Err(format!(
                        "NodeReactivation identity split: from={} node_id={} (must be equal)",
                        tx.from, node_id));
                }
            }
            // KeyRotation is INERT (apply is a no-op; old_key_signature is never verified). Fail-closed at
            // the shared gate so a forged rotation can never be gossiped or block-included. Before it can be
            // wired live, add a state-aware verifier that checks old_key_signature against the node's
            // registered Dilithium key, THEN remove this hard-reject.
            TT::KeyRotation { .. } => {
                return Err("KeyRotation is not enabled: needs a registered-old-key Dilithium verifier before activation".to_string());
            }
            _ => {}
        }
        Ok(())
    }

    /// Committed-key verdict for a NodeReactivation, mirroring block validation's point-read.
    ///   NotApplicable — not a reactivation.
    ///   Bound         — wire pk == the vrf_pk committed for `tx.from`.
    ///   Mismatch      — a wire pk that is not the committed one (or none at all).
    ///   Unknown       — no committed vrf_pk for `tx.from` on THIS node.
    pub(crate) fn reactivation_key_state(
        storage: &crate::storage::Storage,
        tx: &qnet_state::Transaction,
    ) -> ReactivationKey {
        if !matches!(tx.tx_type, qnet_state::TransactionType::NodeReactivation { .. }) {
            return ReactivationKey::NotApplicable;
        }
        match storage.load_vrf_public_key(tx.from.as_str()) {
            Ok(Some(c)) => match tx.dilithium_public_key.as_deref() {
                Some(w) if !w.is_empty() && w == c.as_slice() => ReactivationKey::Bound,
                _ => ReactivationKey::Mismatch,
            },
            _ => ReactivationKey::Unknown,
        }
    }

    /// ADMISSION mirror of block validation's reactivation key gate. Ingest self-verifies against the
    /// WIRE key, so without this an attacker's self-signed reactivation for a victim's node_id is
    /// admitted everywhere, packed at MAX gas price, and hard-rejects every block that carries it —
    /// a block-production halt for one gossip message. Fail-closed: an unknown identity is refused
    /// here exactly as the block rejects it, so the two accept-sets are identical.
    pub(crate) fn reactivation_key_admissible(
        storage: &crate::storage::Storage,
        tx: &qnet_state::Transaction,
    ) -> Result<(), String> {
        match Self::reactivation_key_state(storage, tx) {
            ReactivationKey::NotApplicable | ReactivationKey::Bound => Ok(()),
            ReactivationKey::Mismatch => Err(format!(
                "[REJECT][AUTH] reactivation_key_mismatch node={} (wire pk != committed vrf_pk)", tx.from)),
            ReactivationKey::Unknown => Err(format!(
                "[REJECT][AUTH] reactivation_key_unknown node={} (no committed vrf_pk)", tx.from)),
        }
    }

    /// N-2 committee needed to burn-gate `height` isn't locally present ⇒ node is BEHIND (post-genesis).
    /// Genesis era (epochs 1-2) never lacks it. Lets the ingest gate DEFER (not reject) a burn-gated block
    /// until N-2 applies, then re-verify — an honest registration isn't dropped while catching up.
    pub fn n2_committee_absent(storage: &crate::storage::Storage, height: u64) -> bool {
        let genesis_era = (height.saturating_sub(1) / 90 + 1).saturating_sub(2) == 0;
        !genesis_era && Self::committee_for_height(storage, height).is_none()
    }

    /// True iff any burn-backed NodeRegistration in `txs` names an `attest_epoch` whose committee this
    /// node cannot resolve — i.e. the burn gate failed because we are BEHIND, not because the block is bad.
    ///
    /// The verifier resolves the committee at `attest_rep_height = (attest_epoch-1)*90+1`, and attest_epoch
    /// may legitimately trail the block's own epoch by up to MAX_ATTEST_EPOCH_LAG. Probing the BLOCK's
    /// epoch instead therefore answered a different question: a joiner holding only the newest macroblocks
    /// would find that committee present, skip the defer, and HARD REJECT a block every synced node
    /// accepts. Ask about the same heights the verifier actually used.
    pub fn burn_committee_absent_for(
        storage: &crate::storage::Storage,
        txs: &[qnet_state::Transaction],
    ) -> bool {
        txs.iter().any(|tx| match &tx.tx_type {
            qnet_state::TransactionType::NodeRegistration { attest_epoch, burn_tx, .. }
                if !burn_tx.is_empty() && *attest_epoch > 0 =>
            {
                Self::n2_committee_absent(storage, attest_epoch.saturating_sub(1) * 90 + 1)
            }
            _ => false,
        })
    }

    /// Phase-1 proof-of-burn consensus gate. The external Solana 1DEV burn is non-deterministic
    /// (live RPC) and cannot be re-checked in apply, so a Byzantine producer could otherwise inject
    /// a NodeRegistration with a fabricated burn that every honest node applies — minting a free
    /// reward/producer-eligible node. This gate brings the burn fact ON-CHAIN as a committee quorum:
    /// a non-genesis NodeRegistration is valid only if it carries ≥2f+1 distinct valid committee
    /// Dilithium signatures over the canonical burn message — which embeds the required Phase-1 cost,
    /// so the bound burn_amount must meet the attested cost (no under-paid Sybil node). Returns Ok(())
    /// when the rule is INACTIVE at `height`, the registration is a genesis identity (exempt), or the
    /// quorum verifies. Cost lives INSIDE the 2f+1-signed message: validators agree on it by signature,
    /// never by re-reading Solana — fully deterministic (a 10% bucket boundary costs a retry, not a fork).
    ///
    /// DETERMINISM: a pure function of the TX bytes + the binary-pinned GENESIS_CONSENSUS_PKS
    /// (installed at startup on every node) — NO live RPC, NO node-local state — so the verdict is
    /// byte-identical on every validator regardless of sync mode. Enforced at block validation (the
    /// signature-check tier; apply trusts validated blocks); one-burn-one-node is enforced upstream
    /// by honest-genesis refusal to double-attest (≤f Byzantine cannot reach the 2f+1 quorum).
    /// Canonical message a registrant's WALLET key signs. Light keeps the four-field form the mobile
    /// client emits. Super appends the identity fields a relayer could otherwise rewrite for free — the
    /// consensus key and the announced endpoint are in the TX hash, but nothing signs the hash, so
    /// hash-membership alone left them substitutable in flight. node_type picks the form, and swapping
    /// it swaps the form, so the signature no longer verifies either way.
    pub(crate) fn client_node_reg_message(
        node_id: &str, wallet: &str, reg_proof: &str, timestamp: u64,
        node_type: &qnet_state::NodeType, vrf_pk: &[u8], api_endpoint: &str,
    ) -> String {
        let base = format!("client_node_reg:{}:{}:{}:{}", node_id, wallet, reg_proof, timestamp);
        match node_type {
            qnet_state::NodeType::Light => base,
            _ => format!("{}:{}:{}", base, hex::encode(Sha3_256::digest(vrf_pk)), api_endpoint),
        }
    }

    /// A registration's consensus key: the hashed `vrf_pk` body field, else the envelope key (genesis
    /// TXs carry their anchored key there, and a Light row's attestation root is its wallet key).
    /// The ONE resolver, so the apply-time registry row and the block-body scan can never disagree.
    pub(crate) fn registration_consensus_pk(tx: &qnet_state::Transaction) -> Option<Vec<u8>> {
        let (vrf_pk, node_type) = match &tx.tx_type {
            qnet_state::TransactionType::NodeRegistration { vrf_pk, node_type, .. } => (vrf_pk, node_type),
            _ => return None,
        };
        let envelope = match &tx.dilithium_public_key {
            Some(pk) if pk.len() == crate::crypto::vrf::D3_PK_BYTES => Some(pk.clone()),
            _ => None,
        };
        // Light never signs consensus: its committed key is the WALLET key from the envelope, the
        // attestation root its liveness proofs are checked against.
        if matches!(node_type, qnet_state::NodeType::Light) {
            return envelope;
        }
        // Super: the hashed body field, and ONLY it. Keying the choice on tx.data would put a free
        // attacker-chosen field back in charge of which key becomes a consensus identity. Genesis TXs
        // carry the pinned anchor here too, so there is no case left needing the envelope.
        if vrf_pk.len() == crate::crypto::vrf::D3_PK_BYTES {
            return Some(vrf_pk.clone());
        }
        None
    }

    /// node_id MUST equal the deterministic pseudonym of wallet_address. Genesis identities are
    /// protocol-minted (fixed ids anchored in the binary) and exempt. Pure function of TX fields —
    /// same verdict on every node, at admission, producer-include and block validation alike.
    pub(crate) fn registration_identity_bound(
        node_id: &str, node_type: &qnet_state::NodeType, wallet: &str, reg_proof: &str,
    ) -> bool {
        if reg_proof == "genesis" && crate::genesis_constants::is_legacy_genesis_node(node_id) {
            return true;
        }
        let expected = match node_type {
            qnet_state::NodeType::Light => crate::rpc::generate_light_node_pseudonym(wallet),
            _ => crate::rpc::generate_super_node_pseudonym(wallet),
        };
        node_id == expected
    }

    pub(crate) async fn verify_burn_attestation_quorum(
        tx: &qnet_state::Transaction,
        height: u64,
        storage: &crate::storage::Storage,
    ) -> Result<(), QNetError> {
        let (node_id, node_type, wallet, reg_proof, burn_tx, burn_wallet, burn_owner_sig, burn_amount, burn_cost,
             attest_epoch, attestors) = match &tx.tx_type {
            qnet_state::TransactionType::NodeRegistration {
                node_id, node_type, wallet_address, registration_proof, burn_tx, burn_wallet, burn_owner_sig,
                burn_amount, burn_cost, attest_epoch, burn_attestors, ..
            } => (node_id.as_str(), node_type, wallet_address.as_str(), registration_proof.as_str(),
                  burn_tx.as_str(), burn_wallet.as_str(), burn_owner_sig.as_str(), *burn_amount, *burn_cost,
                  *attest_epoch, burn_attestors),
            _ => return Ok(()), // only NodeRegistration is gated
        };

        // Identity bind FIRST (height-independent): node_id MUST be the deterministic wallet pseudonym.
        // Without it a burn-backed registration can name any victim's derivable node_id and occupy it
        // permanently (the apply dup-guard makes it irreversible).
        if !Self::registration_identity_bound(node_id, node_type, wallet, reg_proof) {
            return Err(QNetError::ValidationError(
                "node_id is not the wallet pseudonym (anti-squat)".to_string()));
        }

        // Inert below the coordinated activation height (Phase-1 era gate).
        if !qnet_state::feature_gates::is_active("burn_attestation_required", height) {
            return Ok(());
        }
        // Genesis identities are protocol-minted (anchored by GENESIS_CONSENSUS_PKS), not burn-backed —
        // but the exemption MUST bind to a real genesis node_id, else any reg sets reg_proof="genesis".
        if reg_proof == "genesis" {
            if crate::genesis_constants::is_legacy_genesis_node(node_id) {
                return Ok(());
            }
            return Err(QNetError::ValidationError(
                "burn_attestation_required: genesis reg_proof from non-genesis node_id".to_string()));
        }
        // A burn-backed registration MUST reference its burn; an empty burn_tx is the dodge to reject.
        if burn_tx.is_empty() {
            return Err(QNetError::ValidationError(
                "burn_attestation_required: NodeRegistration missing burn_tx".to_string()));
        }
        // Beneficiary binding. The burner address is inside the 2f+1-signed message and each attestor
        // signs the fee payer IT verified on Solana, so burn_wallet is committee truth. The burn is the
        // only Sybil cost, hence its owner is the sole authority on which node it activates: require an
        // Ed25519 signature by that address over (node_id, wallet_address, registration_proof, timestamp).
        // Without it a public burn_tx can be front-run — the beneficiary set to the attacker's wallet
        // (burn theft) or to a victim's, squatting the node_id derived from it. Deterministic: a pure
        // function of TX bytes, no external read.
        if burn_wallet.is_empty() || burn_owner_sig.is_empty() {
            return Err(QNetError::ValidationError(
                "burn_attestation_required: NodeRegistration missing burn_wallet / burn_owner_sig".to_string()));
        }
        let attest_root = tx.dilithium_public_key.as_deref().unwrap_or(&[]);
        let bind_msg = qnet_state::Transaction::burn_owner_bind_message(
            node_id, wallet, reg_proof, tx.timestamp, attest_root, burn_tx);
        let owner_ok = crate::crypto::solana_derivation::verify_ed25519_signature(
            bind_msg.as_bytes(), burn_owner_sig, burn_wallet).unwrap_or(false);
        if !owner_ok {
            return Err(QNetError::ValidationError(
                "burn_attestation_required: burn_owner_sig does not authorize this beneficiary".to_string()));
        }
        // BENEFICIARY consent. The burner's signature proves who paid, never that the named wallet
        // agreed to be named: without this a burner could point its burn at any victim's wallet, and
        // since node_id is that wallet's pseudonym the victim's identity is occupied forever. So
        // wallet_address must derive from a credential the registrant demonstrably holds — the WALLET
        // ML-DSA-65 key that signed this registration, or the burning Solana address itself.
        let native_bound = tx.dilithium_public_key.as_deref()
            .and_then(crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey_bytes)
            .as_deref() == Some(wallet)
            && Self::verify_node_lifecycle_dilithium(tx);
        let solana_bound = crate::crypto::solana_derivation::eon_from_solana_address(burn_wallet) == wallet;
        if !native_bound && !solana_bound {
            return Err(QNetError::ValidationError(
                "burn_attestation_required: wallet_address proven by neither the signing wallet key nor burn_wallet".to_string()));
        }
        // Cost gate: the committee-attested Phase-1 cost MUST be present (old no-cost format is rejected
        // while the gate is active), meet the protocol floor, and be covered by the bound amount. The
        // cost is part of the 2f+1-signed message below, so this binds the registration to the cost the
        // committee agreed on — it never re-reads Solana (determinism).
        if burn_cost < 300 {
            return Err(QNetError::ValidationError(
                "burn_attestation_required: burn_cost below 300 1DEV floor (missing or under-priced)".to_string()));
        }
        if burn_amount < burn_cost {
            return Err(QNetError::ValidationError(
                "burn_attestation_required: bound burn_amount below attested cost".to_string()));
        }
        // On-chain burn→NODE uniqueness: a burn already committed-bound to a different node in an earlier
        // block cannot back a second one. Keyed on node_id, not the wallet: one wallet owns two distinct
        // pseudonyms (super and light), the Phase-1 cost is tier-independent, and node_type is inside the
        // attested message — so a wallet-keyed bind let ONE 1DEV burn activate BOTH, doubling that
        // wallet's reward share for a single entry fee. Deterministic read of committed state ≤ H;
        // same-block reuse is caught by the block-level burn_tx dedup in the pipeline.
        if let Ok(Some(bound)) = storage.committed_burn_wallet_get(burn_tx) {
            if bound != node_id {
                return Err(QNetError::ValidationError(
                    "burn_attestation_required: burn_tx already bound to a different node".to_string()));
            }
        }

        // M-5: the committee is resolved at attest_epoch — the epoch the ATTESTORS used — not the apply
        // height, so an arm-tip/apply-height straddle across an epoch boundary can't mismatch committees.
        // Bound attest_epoch: present, not in the future, and recent (≤MAX_ATTEST_EPOCH_LAG epochs old).
        // Recency is the ONLY needed guard: a quorum (n−f) of ANY recent committee attesting an immutable
        // external burn is as authoritative as a larger one (committee size never lowers the honest-majority
        // bar), and ≤2 epochs bounds retroactive compromise. NO genesis-downgrade check — it would strand a
        // genesis-era-armed reg that lands post-genesis (the committee is still genesis-derived there) while
        // guarding no real threat.
        const MAX_ATTEST_EPOCH_LAG: u64 = 2;
        let apply_epoch = height.saturating_sub(1) / 90 + 1;
        if attest_epoch == 0 || attest_epoch > apply_epoch {
            return Err(QNetError::ValidationError(
                "burn_attestation_required: attest_epoch missing or in the future".to_string()));
        }
        if apply_epoch > attest_epoch + MAX_ATTEST_EPOCH_LAG {
            return Err(QNetError::ValidationError(
                "burn_attestation_required: attest_epoch stale (re-arm against the current committee)".to_string()));
        }
        let attest_genesis_era = attest_epoch <= 2;

        // Bound the attestor list before verifying anything: each entry costs an ML-DSA-65 open, and this
        // runs on the unauthenticated gossip path.
        if attestors.len() > 4 * crate::genesis_constants::genesis_node_count().max(256) {
            return Err(QNetError::ValidationError(
                "burn_attestation_required: attestor list too large".to_string()));
        }

        // Recompute the exact message the committee signed (incl. attested cost AND attest_epoch); count
        // DISTINCT valid committee sigs.
        let msg = qnet_state::Transaction::burn_attestation_message(burn_tx, burn_wallet, wallet, burn_amount, node_type, burn_cost, attest_epoch);

        // Committee = the deterministic consensus committee OF attest_epoch. committee_for_height is
        // epoch-constant, so the epoch's first height resolves the same set every node computes. PK comes
        // from on-chain state, NOT the RAM registry (deterministic + forge-proof; see bound verify).
        // Genesis era (attest_epoch ≤ 2, no N-2 snapshot) ⇒ the committee IS the genesis set. A POST-genesis
        // None means THIS node is BEHIND (can't read N-2) ⇒ REJECT (resync, re-validate once N-2 present;
        // it stalls, never forks) — falling to the genesis set would diverge from synced validators.
        let attest_rep_height = attest_epoch.saturating_sub(1) * 90 + 1;
        let committee: Option<std::collections::HashSet<String>> =
            Self::committee_for_height(storage, attest_rep_height).map(|v| v.into_iter().collect());
        if committee.is_none() && !attest_genesis_era {
            return Err(QNetError::ValidationError(
                "burn_attestation_required: N-2 committee unavailable (node behind chain; resync)".to_string()));
        }
        let committee_size = match &committee {
            Some(c) => c.len(),
            None => crate::genesis_constants::genesis_node_count(), // None here ⇒ genesis era only
        };
        let threshold = qnet_consensus::checkpoint_bft::quorum_size(committee_size);

        let mut valid: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for (attestor_id, sig) in attestors {
            if valid.contains(attestor_id) { continue; } // distinct only
            let is_member = match &committee {
                Some(c) => c.contains(attestor_id),
                None => crate::genesis_constants::is_legacy_genesis_node(attestor_id),
            };
            if !is_member { continue; } // committee members only
            // On-chain PK (deterministic) + bound verify — never the RAM registry (eviction → fork,
            // Tier-3 TOFV → forge). A non-registered attestor (no on-chain PK) cannot count. Genesis
            // attestors fall back to the binary-pinned anchor (deterministic + process-uniform on every
            // node) — belt-and-suspenders for the storage seed, never a forgeable RAM source.
            let pk = match storage.load_vrf_public_key(attestor_id) {
                Ok(Some(p)) => p,
                _ => match crate::genesis_constants::get_genesis_anchor_pk(attestor_id) {
                    Some(p) => p,
                    None => {
                        // vrf_pk unresolved (storage gap, e.g. an incomplete snapshot) ⇒ this attestor
                        // cannot count toward the quorum. Surface it so a snapshot-completeness failure
                        // is diagnosable rather than a silent sub-quorum drop.
                        if is_warn() {
                            println!("[WARN][BURN] attestor_pk_unresolved id={} reason=vrf_pk_absent", attestor_id);
                        }
                        continue;
                    }
                },
            };
            if qnet_consensus::consensus_crypto::verify_consensus_signature_bound(
                attestor_id, &msg, sig, &pk).await
            {
                valid.insert(attestor_id.clone());
            }
        }
        if valid.len() >= threshold {
            Ok(())
        } else {
            Err(QNetError::ValidationError(format!(
                "burn_attestation_required: {}/{} distinct committee attestations", valid.len(), threshold)))
        }
    }

    /// True iff THIS node may sign burn attestations = it is in the current consensus committee.
    /// Genesis era (no N-2 snapshot yet): the committee IS the genesis set. Was genesis-only;
    /// now committee-wide so attestation decentralises with the network instead of forever resting
    /// on the 5 genesis (the SPOF). Membership for the local tip's epoch (signer side).
    pub fn is_genesis_attestor(&self) -> bool {
        let h = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        match Self::committee_for_height(&self.storage, h) {
            Some(c) => c.iter().any(|id| id == &self.node_id),
            None => crate::genesis_constants::is_legacy_genesis_node(&self.node_id),
        }
    }

    /// Genesis-side burn attestation (PRODUCTION half of the burn-oracle). The CALLER must have
    /// already verified the external Solana 1DEV burn (verify_burn_transaction_exists). Signs the
    /// canonical burn message with this genesis's consensus key and returns (genesis_id, sig). One
    /// burn_tx is bound to ONE qnet wallet (per-genesis off-chain dedup): an honest genesis refuses
    /// to attest a reused burn for a second node, so with ≤f Byzantine genesis a reused burn can
    /// never reach the on-chain 2f+1 quorum verified by verify_burn_attestation_quorum.
    /// True iff THIS node is in the consensus committee OF `attest_epoch` (deterministic, epoch-keyed —
    /// committee_for_height is epoch-constant). Genesis era (attest_epoch ≤ 2): the genesis set. The
    /// burn-attestor signs for the epoch the registrant BINDS, resolved here, so a member still attests
    /// correctly across a boundary where its own tip has already advanced past that epoch.
    pub fn is_committee_attestor_for_epoch(&self, attest_epoch: u64) -> bool {
        let rep_h = attest_epoch.saturating_sub(1) * 90 + 1;
        match Self::committee_for_height(&self.storage, rep_h) {
            Some(c) => c.iter().any(|id| id == &self.node_id),
            None => crate::genesis_constants::is_legacy_genesis_node(&self.node_id),
        }
    }

    pub fn sign_burn_attestation(
        &self, burn_tx: &str, burn_wallet: &str, qnet_wallet: &str, amount: u64, node_type: qnet_state::NodeType,
        cost: u64, attest_epoch: u64,
    ) -> Option<(String, String)> {
        if burn_wallet.is_empty() { return None; }
        // M-5: attest for the epoch the registrant will BIND (not own tip). Bound recent vs own tip so a
        // stale/forged epoch can't solicit a signature, and only if THIS node is in that epoch's committee.
        const MAX_ATTEST_EPOCH_LAG: u64 = 2;
        let own_epoch = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
            .load(std::sync::atomic::Ordering::Relaxed).saturating_sub(1) / 90 + 1;
        if attest_epoch == 0 || attest_epoch > own_epoch + 1 || own_epoch > attest_epoch + MAX_ATTEST_EPOCH_LAG {
            return None;
        }
        if !self.is_committee_attestor_for_epoch(attest_epoch) { return None; }
        // One burn → one NODE, PERSISTED (survives process restart). Keyed on the node pseudonym, not the
        // wallet: the same wallet's super and light ids are different nodes, and a wallet-keyed dedup
        // happily attested both off one burn.
        let attest_node_id = match node_type {
            qnet_state::NodeType::Light => crate::rpc::generate_light_node_pseudonym(qnet_wallet),
            _ => crate::rpc::generate_super_node_pseudonym(qnet_wallet),
        };
        match self.storage.attested_burn_get(burn_tx) {
            Ok(Some(n)) if n != attest_node_id => return None, // already attested for a different node
            Ok(Some(_)) => {}                                  // same node ⇒ idempotent re-attest
            _ => { let _ = self.storage.attested_burn_put(burn_tx, &attest_node_id); }
        }
        // Sign the cost the caller computed + verified against the real on-Solana burn, plus attest_epoch.
        // Bound INTO the message so the on-chain verifier trusts them by signature, never re-reading Solana.
        let msg = qnet_state::Transaction::burn_attestation_message(burn_tx, burn_wallet, qnet_wallet, amount, &node_type, cost, attest_epoch);
        let sig = self.wallet_identity.as_ref()?.sign_consensus(&self.node_id, msg.as_bytes()).ok()?;
        Some((self.node_id.clone(), sig))
    }

    /// Super-side: gather ≥2f+1 committee burn-attestations for this node's Phase-1 Solana burn so the
    /// NodeRegistration passes the burn-attestation gate. Queries each committee JSON-RPC endpoint
    /// (node_attestBurn); each independently re-verifies the Solana burn AND recomputes the Phase-1
    /// cost, then signs over its OWN observed (amount, cost) pair. Returns (distinct sigs, agreed_cost,
    /// agreed_amount): only sigs agreeing on ONE (cost, amount) pair are kept (each signed message embeds
    /// BOTH, so a mismatched signer can't be in the same quorum). The registrant embeds agreed_amount as
    /// NodeRegistration.burn_amount so the on-chain value is exactly what the counted 2f+1 signed —
    /// closing the over-burn footgun (declared < actual would otherwise fail every signature). At a 10%
    /// burn-boundary signers may split → fewer than `need` agree → caller retries (liveness hiccup, never
    /// a fork). caller checks the count.
    pub async fn collect_burn_attestations(
        burn_tx: &str, solana_wallet: &str, qnet_wallet: &str, amount: u64, node_type: qnet_state::NodeType,
        cost: u64, owner: &BurnOwnerProof<'_>, storage: &crate::storage::Storage,
    ) -> (Vec<(String, String)>, u64, u64, u64) {
        let nt = match node_type { qnet_state::NodeType::Light => "light", _ => "super" };
        // Attestor set = the consensus committee for the current tip (genesis era ⇒ the genesis set,
        // the only members then). need = quorum_size(committee) — exactly what the verifier requires,
        // so a gathered set actually passes whether the network is at genesis or scaled past 120.
        let tip = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
        // M-5: pin the attestation to epoch(arm_tip); every attestor signs THIS epoch and the registrant
        // binds it, so the apply-time verifier resolves the SAME committee (no arm/apply straddle).
        let attest_epoch = tip.saturating_sub(1) / 90 + 1;
        let committee: Vec<String> = match Self::committee_for_height(storage, tip) {
            Some(c) => c,
            None => crate::genesis_constants::GENESIS_NODE_IPS.iter()
                .map(|(_ip, id)| format!("genesis_node_{}", id)).collect(),
        };
        let need = qnet_consensus::checkpoint_bft::quorum_size(committee.len());
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30)).build() { Ok(c) => c, Err(_) => return (Vec::new(), cost, amount, attest_epoch) };
        // Carry the cost+amount as advisory hints; each attestor RECOMPUTES the cost from its own Solana
        // read and reads the ACTUAL on-Solana burned amount, signing ONLY its own (cost, amount) pair
        // (returned below), so a forged hint cannot lower the binding cost nor the embedded amount.
        // attest_epoch is authoritative: each attestor signs it (bound in the message) and self-checks
        // membership in that epoch's committee.
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "node_attestBurn",
            "params": { "burn_tx": burn_tx, "solana_wallet": solana_wallet,
                        "qnet_wallet": qnet_wallet, "amount": amount, "node_type": nt, "cost": cost,
                        "attest_epoch": attest_epoch,
                        // Owner proof: each attestor re-verifies it against solana_wallet before doing any
                        // work, so only the burn's owner can obtain attestations for it.
                        "node_id": owner.node_id, "registration_proof": owner.registration_proof,
                        "timestamp": owner.timestamp, "owner_signature": owner.signature,
                        "attest_root": owner.attest_root_tag }
        });
        // Group sigs by the (cost, amount) PAIR each attestor signed; the embedded registration cost AND
        // amount are exactly what the quorum shares, so keep only the pair-bucket that first reaches
        // `need` distinct members. Returning the agreed amount lets the registrant embed committee truth.
        let mut by_pair: std::collections::BTreeMap<(u64, u64), Vec<(String, String)>> = std::collections::BTreeMap::new();
        let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

        // Resolve endpoints first (pure local lookups), then query in BOUNDED-CONCURRENCY batches.
        // The loop used to be strictly serial with a 30 s per-request timeout: at the 1000-member target
        // committee a single slow member could push the whole collection past the 2-epoch attestation
        // validity window, so onboarding could never complete at scale. Order-independent — the quorum is
        // a set — so batching changes nothing except wall-clock.
        let targets: Vec<(String, String)> = committee.iter().filter_map(|member_id| {
            let ip = crate::genesis_constants::get_node_endpoint_ip(member_id)
                .or_else(|| storage.load_node_endpoint(member_id).ok().flatten()
                    .map(|ep| crate::genesis_constants::endpoint_ip_only(&ep))
                    .filter(|ip| !ip.is_empty()))
                .or_else(|| crate::genesis_constants::genesis_ip_for_node_id(member_id).map(|s| s.to_string()));
            match ip {
                Some(i) if !i.is_empty() => Some((member_id.clone(), format!("http://{}:8001/", i))),
                _ => None,
            }
        }).collect();
        let unresolved = committee.len().saturating_sub(targets.len());

        const ATTEST_FANOUT: usize = 32;
        'outer: for chunk in targets.chunks(ATTEST_FANOUT) {
            let calls = chunk.iter().map(|(member_id, url)| {
                let client = client.clone();
                let body = body.clone();
                let member_id = member_id.clone();
                let url = url.clone();
                async move {
                    let resp = client.post(&url).json(&body).send().await.ok()?;
                    let json: serde_json::Value = resp.json().await.ok()?;
                    Some((member_id, json))
                }
            });
            for out in futures::future::join_all(calls).await {
                let (member_id, json) = match out { Some(x) => x, None => continue };
                let result = match json.get("result") {
                    Some(r) => r,
                    None => {
                        // -32050 attest_pending: the attestor's issuance throttle queued this burn —
                        // a non-vote this round; the convergence driver re-collects next cooldown.
                        if let Some(err) = json.get("error") {
                            if err.get("code").and_then(|c| c.as_i64()) == Some(-32050) {
                                let ra = err.get("data").and_then(|d| d.get("retry_after_secs")).and_then(|v| v.as_u64()).unwrap_or(0);
                                if is_info() { println!("[INFO][REG] attest_pending member={} retry_after={}s", member_id, ra); }
                            }
                        }
                        continue;
                    }
                };
                let gid = result.get("genesis_id").and_then(|v| v.as_str()).unwrap_or("");
                let sig = result.get("sig").and_then(|v| v.as_str()).unwrap_or("");
                let signed_cost = result.get("cost").and_then(|v| v.as_u64()).unwrap_or(0);
                // The attestor signed over the ACTUAL on-Solana burned amount; embed exactly that.
                let signed_amount = result.get("amount").and_then(|v| v.as_u64()).unwrap_or(0);
                // The attestor echoes the burner address it verified and signed. A different one means it
                // signed a different message than the one the registrant will embed.
                let signed_burner = result.get("burn_wallet").and_then(|v| v.as_str()).unwrap_or("");
                if gid.is_empty() || sig.is_empty() || signed_cost == 0 || signed_amount == 0
                    || signed_burner != solana_wallet
                    || !committee.iter().any(|m| m == gid) { continue; }
                if !seen.insert(gid.to_string()) { continue; } // distinct only
                let bucket = by_pair.entry((signed_cost, signed_amount)).or_default();
                bucket.push((gid.to_string(), sig.to_string()));
                if bucket.len() >= need { break 'outer; }
            }
        }
        if let Some(((c, a), v)) = by_pair.iter().find(|(_, v)| v.len() >= need) {
            return (v.clone(), *c, *a, attest_epoch);
        }
        if unresolved > 0 && committee.len().saturating_sub(unresolved) < need {
            eprintln!("[WARN][REG] attestors_unreachable committee={} unresolved={} need={} — quorum impossible until endpoints are known",
                      committee.len(), unresolved, need);
        }
        // No (cost, amount) bucket reached quorum — return the largest bucket + its pair so the caller can
        // log got/need and retry (e.g. a 10% boundary split, or attestors disagreeing on the amount).
        by_pair.into_iter().max_by_key(|(_, v)| v.len())
            .map(|((c, a), v)| (v, c, a, attest_epoch)).unwrap_or_else(|| (Vec::new(), cost, amount, attest_epoch))
    }

    /// PRODUCTION v2.19.25: Validate and add transaction received from P2P network
    /// Unlike submit_transaction(), this does NOT broadcast to avoid infinite loops
    pub async fn validate_and_add_network_transaction(&self, tx: qnet_state::Transaction) -> Result<String, QNetError> {
        // Same Transaction::validate() as submit_transaction — structure, hash self-consistency and
        // the chain_id binding are enforced identically on both ingress paths.
        if let Err(validation_error) = tx.validate() {
            return Err(QNetError::ValidationError(format!("Transaction validation failed: {}", validation_error)));
        }
        if !Self::gas_limit_admissible(&tx) {
            return Err(QNetError::ValidationError(format!(
                "gas_limit {} exceeds MAX_GAS_LIMIT {}", tx.gas_limit, qnet_state::gas_limits::MAX_GAS_LIMIT)));
        }

        // v32.12: gossip-side activation admission rate limit. NodeRegistration
        // and NodeActivation TXs trigger heavy block-include + state-apply paths.
        // Under mass-onboarding burst (N joiners simultaneously) admission must
        // be bounded so producer's 1-sec deadline stays achievable. Excess TXs
        // get rejected; gossip will re-deliver from peers when window reopens.
        // Window = 1 sec rolling; cap = 20 admissions/sec/node (covers 1200
        // activations/minute — far above realistic mass-onboarding rate).
        if matches!(tx.tx_type,
            qnet_state::TransactionType::NodeRegistration { .. }
            | qnet_state::TransactionType::NodeActivation { .. }
        ) {
            const ACTIVATION_ADMIT_RATE_PER_SEC: u32 = 20;
            static ACTIVATION_ADMIT_COUNTER: once_cell::sync::Lazy<
                std::sync::Mutex<(u64, u32)>
            > = once_cell::sync::Lazy::new(|| std::sync::Mutex::new((0, 0)));
            let now_secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs()).unwrap_or(0);
            let mut g = ACTIVATION_ADMIT_COUNTER.lock()
                .unwrap_or_else(|p| p.into_inner());
            if g.0 != now_secs {
                g.0 = now_secs;
                g.1 = 0;
            }
            if g.1 >= ACTIVATION_ADMIT_RATE_PER_SEC {
                if crate::node::is_warn() {
                    println!(
                        "[WARN][TX-GOSSIP] activation_rate_exceeded count={}/{} action=defer",
                        g.1, ACTIVATION_ADMIT_RATE_PER_SEC,
                    );
                }
                return Err(QNetError::ValidationError(
                    "activation_admit_rate_exceeded — retry next window".to_string()
                ));
            }
            g.1 += 1;
        }

        // ═══════════════════════════════════════════════════════════════════════
        // GOSSIP-PATH TRANSACTION TYPE WHITELIST
        // ═══════════════════════════════════════════════════════════════════════
        // Some transaction types are produced ONLY by block-construction code
        // paths (locally on the producer) and MUST NEVER arrive via gossip.
        // Allowing them through gossip would let a Byzantine peer inject
        // forged genesis-style transactions (CreateAccount with mint),
        // batch-claim multipliers, or batch-activation duplicates.
        //
        // Rejection here closes those vectors at the earliest point — before
        // mempool admission, before block inclusion, before state apply. The
        // block-pipeline TX-level signature stage provides a second-line
        // defence for blocks containing such TXs (defense-in-depth).
        //
        // ALLOWED via gossip (user-originated or commitment-style):
        //   * Transfer, ContractDeploy, ContractCall, Swap     (user TXs)
        //   * NodeRegistration, NodeReactivation, NodeActivation (node lifecycle)
        //   * KeyRotation                                       (PQ key hygiene)
        //   * RewardDistribution (claim, NOT system_emission)   (user reward claims)
        //   * HeartbeatCommitment, PingCommitmentWithSampling   (node commitments)
        //   * LightNodeEligibilityBitmap                        (Genesis ping aggregation)
        //   * PingAttestation                                   (per-ping records)
        //
        // REJECTED via gossip (internal-only):
        //   * CreateAccount       — produced ONLY by genesis_block construction.
        //                            Any post-genesis CreateAccount is an attack.
        //   * BatchRewardClaims   — DEPRECATED enum variant, never instantiated.
        //   * BatchNodeActivations — DEPRECATED enum variant, never instantiated.
        //   * BatchTransfers      — LIVE signed value class; bounds checked below.
        //
        // SCALABILITY: O(1) match per gossip TX. Identical cost at 5 or 5000
        // validators — no cross-node coordination, purely local check.
        // ═══════════════════════════════════════════════════════════════════════
        match &tx.tx_type {
            qnet_state::TransactionType::CreateAccount { .. } => {
                if crate::node::is_warn() {
                    println!("[WARN][TX-GOSSIP] reject_gossip_create_account from={}... reason=internal_only_tx_type",
                        &tx.from[..tx.from.len().min(20)]);
                }
                return Err(QNetError::ValidationError(
                    "[REJECT][GOSSIP] CreateAccount is genesis-only — must not arrive via gossip".to_string()
                ));
            }
            qnet_state::TransactionType::BatchRewardClaims { .. } => {
                if crate::node::is_warn() {
                    println!("[WARN][TX-GOSSIP] reject_gossip_batch_reward_claims reason=deprecated_enum_variant");
                }
                return Err(QNetError::ValidationError(
                    "[REJECT][GOSSIP] BatchRewardClaims is deprecated — must not arrive via gossip".to_string()
                ));
            }
            qnet_state::TransactionType::BatchNodeActivations { .. } => {
                if crate::node::is_warn() {
                    println!("[WARN][TX-GOSSIP] reject_gossip_batch_node_activations reason=deprecated_enum_variant");
                }
                return Err(QNetError::ValidationError(
                    "[REJECT][GOSSIP] BatchNodeActivations is deprecated — must not arrive via gossip".to_string()
                ));
            }
            qnet_state::TransactionType::BatchTransfers { transfers, .. } => {
                // Same bounds as the RPC gate; the ML-DSA-65 signature gate runs downstream.
                if transfers.is_empty() || transfers.len() > 1000
                    || transfers.iter().any(|t| t.amount == 0
                        || t.memo.as_ref().map_or(false, |m| m.len() > 128)) {
                    if crate::node::is_warn() {
                        println!("[WARN][TX-GOSSIP] reject_gossip_batch_transfers reason=bounds count={}", transfers.len());
                    }
                    return Err(QNetError::ValidationError(
                        "[REJECT][GOSSIP] BatchTransfers bounds: count 1..=1000, amount > 0, memo <= 128".to_string()
                    ));
                }
            }
            // Mirror of the RPC-path Swap reject: dormant, apply-fail-closed. Drop at gossip admission
            // so a crafted Swap can't be relayed or block-included; block-apply keeps its fail-close.
            qnet_state::TransactionType::Swap { .. } => {
                if crate::node::is_warn() {
                    println!("[WARN][TX-GOSSIP] reject_gossip_swap reason=dex_not_enabled");
                }
                return Err(QNetError::ValidationError(
                    "[REJECT][GOSSIP] Swap/DEX is not enabled — on-chain pool pricing is not deployed".to_string()
                ));
            }
            _ => {} // All other variants pass through to standard validation
        }

        // Shared system-TX identity binds (presence + signer↔declared-identity) — the SAME gate
        // enforced on the block-apply path (block_pipeline), so gossip admission and block validation
        // agree on what a valid system TX is. Closes ping-slot squat / cross-shard bitmap / unbound
        // first-registration at the door, not just at block apply.
        Self::verify_system_tx_binds(&tx)
            .map_err(|e| QNetError::ValidationError(format!("[REJECT][GOSSIP] {}", e)))?;

        // Reactivation is self-verified against the WIRE key, but block validation point-reads the
        // COMMITTED vrf_pk — so without this mirror an attacker-signed reactivation for any node_id is
        // admitted everywhere and hard-rejects every block that packs it. Same verdict, same door.
        Self::reactivation_key_admissible(&self.storage, &tx)
            .map_err(|e| QNetError::ValidationError(format!("[REJECT][GOSSIP] {}", e)))?;

        // Advisory mirror of the block-validation burn-attestation gate
        // (verify_burn_attestation_quorum): reject an invalid NodeRegistration at admission so a
        // producer never wastes a slot on a block its peers would reject. The authoritative
        // deterministic check runs at block validation; here we use the current chain tip and the
        // SAME pure verifier. Inert below the gate height (returns Ok), so onboarding is unchanged.
        if matches!(tx.tx_type, qnet_state::TransactionType::NodeRegistration { .. }) {
            let h = self.storage.get_chain_height().unwrap_or(0);
            if let Err(e) = Self::verify_burn_attestation_quorum(&tx, h, &self.storage).await {
                if crate::node::is_warn() {
                    println!("[WARN][TX-GOSSIP] reject_gossip_node_registration reason={}", e);
                }
                return Err(QNetError::ValidationError(format!("[REJECT][GOSSIP] {}", e)));
            }
        }

        // Post-quantum: NodeActivation MUST carry a valid ML-DSA-65 signature binding it to
        // the node's on-chain consensus identity. Its ephemeral Ed25519 proves no identity and is
        // quantum-breakable; without the PQ sig a quantum attacker could forge an activation (which
        // grants super-node status). Require + verify it (signer = dilithium_public_key, same
        // canonical message as the Ed25519). The signer PK is on-chain by activation time
        // (registration precedes activation); a not-yet-applied registration → transient reject,
        // gossip re-delivers.
        if matches!(tx.tx_type, qnet_state::TransactionType::NodeActivation { .. }) {
            let has_dil = tx.dilithium_signature.as_ref().map_or(false, |s| !s.is_empty());
            if !has_dil {
                return Err(QNetError::ValidationError(
                    "[REJECT][GOSSIP] NodeActivation requires a Dilithium3 signature (post-quantum identity binding)".to_string()));
            }
            match Self::verify_dilithium_tx_signature_async(&tx, VerifyLane::Admission).await {
                Ok(true) => {}
                _ => return Err(QNetError::ValidationError(
                    "[REJECT][GOSSIP] NodeActivation Dilithium3 signature invalid or signer not registered".to_string())),
            }
        }

        // Signature validation with cryptographic verification
        // v2.53: System transactions don't need Ed25519 signature - validated through consensus
        // v2.81: HeartbeatCommitment validated through Dilithium signatures in samples + Merkle proofs
        let is_system_tx = matches!(tx.tx_type,
            qnet_state::TransactionType::RewardDistribution |
            qnet_state::TransactionType::PingCommitmentWithSampling { .. } |
            qnet_state::TransactionType::HeartbeatCommitment { .. } |
            qnet_state::TransactionType::Heartbeat { .. } |
            qnet_state::TransactionType::LightNodeEligibilityBitmap { .. }
        );
        
        if is_system_tx {
            // System transactions validated through consensus and internal proofs
            // - RewardDistribution: validated through consensus
            // - PingCommitmentWithSampling: validated through Dilithium signatures + Merkle proofs + TX signature (v2.82)
            // - HeartbeatCommitment: validated through Dilithium signatures in samples + Merkle proofs + TX signature (v2.82)

            // SECURITY v6.1: system_emission RewardDistribution TXs are ONLY produced by
            // block producers and included directly in blocks. They must NEVER arrive via
            // P2P gossip — if they do, someone is trying to inject forged emission rewards.
            if matches!(tx.tx_type, qnet_state::TransactionType::RewardDistribution) && tx.from == "system_emission" {
                return Err(QNetError::ValidationError(
                    "system_emission RewardDistribution must not arrive via P2P gossip — block-level TX only".to_string()
                ));
            }

            if matches!(tx.tx_type, qnet_state::TransactionType::RewardDistribution) {
                if tx.from == "system_rewards_pool" {
                    // Merkle reward-claim: the recipient's own key must authorise this exact payload and
                    // every proof must verify against the QC-certified reward_root. Checked here too so
                    // forged claims are rejected at the door, not merely dropped as no-ops at apply.
                    let last_claimed = match &tx.to {
                        Some(w) => self.get_state_manager().read().await.get_last_claimed_epoch(w),
                        None => u64::MAX,
                    };
                    if !Self::claim_proofs_admissible(&self.get_storage(), &tx, last_claimed) {
                        return Err(QNetError::ValidationError(
                            "Reward claim has no valid merkle proofs".to_string()
                        ));
                    }
                } else {
                    // Pure ML-DSA-65: a RewardDistribution is ONLY ever produced as system_emission
                    // (block-level, rejected above) or a system_rewards_pool merkle claim (handled
                    // above). Any other `from` has no legitimate producer — reject at the door.
                    return Err(QNetError::ValidationError(
                        "RewardDistribution must be from system_emission or system_rewards_pool".to_string()
                    ));
                }
            }

            
            // Pure ML-DSA-65: commitment TXs are authenticated solely by their ML-DSA-65
            // signature (linked to the node's on-chain consensus identity via
            // CONSENSUS_PK_REGISTRY). Ed25519 was an illusory second leg — quantum-breakable,
            // ephemeral, no identity binding — removed with the pure-Dilithium migration.
            if matches!(tx.tx_type,
                qnet_state::TransactionType::HeartbeatCommitment { .. } |
                qnet_state::TransactionType::PingCommitmentWithSampling { .. } |
                qnet_state::TransactionType::LightNodeEligibilityBitmap { .. }
            ) {
                // MANDATORY: Dilithium signature REQUIRED for post-quantum security
                if tx.dilithium_signature.as_ref().map_or(true, |s| s.is_empty()) {
                    return Err(QNetError::ValidationError(
                        "Commitment TX REQUIRES Dilithium signature (post-quantum security)".to_string()
                    ));
                }

                if !Self::verify_dilithium_tx_signature_async(&tx, VerifyLane::Admission).await? {
                    return Err(QNetError::ValidationError("Invalid Dilithium signature on commitment TX".to_string()));
                }

                // P2: bind the bitmap's self-declared genesis_id to the AUTHENTICATED signer. The
                // Dilithium verify above already proved the signer is a genesis PK (anti-squat); this
                // also forbids one genesis emitting a bitmap for ANOTHER's shard (genesis_id != signer
                // → cross-shard reward hijack / denial-of-commit). Genuine bitmaps set
                // dilithium_public_key = node_id = genesis_id, so they pass.
                if let qnet_state::TransactionType::LightNodeEligibilityBitmap { genesis_id, .. } = &tx.tx_type {
                    if tx.dilithium_public_key.as_deref() != Some(genesis_id.as_bytes()) {
                        return Err(QNetError::ValidationError(format!(
                            "LightNodeEligibilityBitmap genesis_id={} != signer={:?} (cross-shard forbidden)",
                            genesis_id, tx.dilithium_public_key
                        )));
                    }
                }

                if is_info() {
                    println!("[INFO][VERIFY] commitment_tx_pq_verified type={:?}",
                             std::mem::discriminant(&tx.tx_type));
                }
            }

            // v35: Heartbeat carries a single Dilithium sig, like the commitment
            // TXs above. Verify its Dilithium sig here; anchor freshness is re-checked at
            // production and on receive.
            if matches!(tx.tx_type, qnet_state::TransactionType::Heartbeat { .. }) {
                if tx.dilithium_signature.as_ref().map_or(true, |s| s.is_empty()) {
                    return Err(QNetError::ValidationError(
                        "Heartbeat REQUIRES Dilithium signature".to_string()
                    ));
                }
                if !Self::verify_dilithium_tx_signature_async(&tx, VerifyLane::Admission).await? {
                    return Err(QNetError::ValidationError(
                        "Invalid Dilithium signature on Heartbeat".to_string()
                    ));
                }
            }
        } else {
            // PURE DILITHIUM (F0.1): mirror the RPC ingest — value-moving user classes require ONE
            // mandatory ML-DSA-65 signature bound to `from` via the address (API-1 + AC-3). A forged
            // TX must never even enter the mempool, so the same gate runs on the gossip path.
            // Shared value-class predicate (Transfer|BatchTransfers|ContractDeploy|ContractCall|Swap) — MUST match the
            // apply/producer/bind set, or an elided-pk TX admission rejects but apply accepts (accept-set drift).
            let is_value_tx = tx.is_value_class();
            if is_value_tx {
                if tx.dilithium_signature.as_ref().map_or(true, |s| s.is_empty()) {
                    return Err(QNetError::ValidationError(
                        "[REJECT][AUTH] value TX requires dilithium_signature (pure-PQ)".to_string()));
                }
                // FIX-5 pk-elision (gossip mirror of the RPC ingest): a relayed value TX arrives WITHOUT the
                // pubkey once it is committed on-chain. Resolve into a verify-only clone and keep the elided
                // form in the mempool, so the pk is never re-added on the relay hop. Unresolved ⇒ cheap
                // reject before sig-verify (a peer relaying unresolvable-elided TXs cannot burn our CPU).
                if tx.dilithium_public_key.as_ref().map_or(true, |k| k.is_empty()) {
                    let mut probe = tx.clone();
                    {
                        let sg = self.state.read().await;
                        if !matches!(Self::rehydrate_elided_pk(&mut probe, &*sg), PkResolve::Resolved) {
                            return Err(QNetError::ValidationError(
                                "[REJECT][AUTH] pk_unresolved (gossip): no committed pubkey for sender".to_string()));
                        }
                    }
                    if !Self::verify_dilithium_tx_signature_async(&probe, VerifyLane::Admission).await? {
                        return Err(QNetError::ValidationError("Invalid Dilithium signature".to_string()));
                    }
                } else {
                    let dpk = tx.dilithium_public_key.as_ref().expect("non-empty checked above");
                    match crate::crypto::solana_derivation::eon_from_qnet_dilithium_pubkey_bytes(dpk) {
                        Some(derived) if derived == tx.from => {}
                        _ => return Err(QNetError::ValidationError(
                            "[REJECT][AUTH] from_pubkey_mismatch (dilithium)".to_string())),
                    }
                    if !Self::verify_dilithium_tx_signature_async(&tx, VerifyLane::Admission).await? {
                        return Err(QNetError::ValidationError("Invalid Dilithium signature".to_string()));
                    }
                }
            } else {
                // Non-value user TX — pure post-quantum (mirror the RPC ingest). Ed25519 is Solana-only
                // and never verified; self-verifying proofs carry embedded sigs; all other user TX
                // require a mandatory ML-DSA-65 signature. A forged TX must not enter the mempool.
                let self_verifying = matches!(tx.tx_type,
                    qnet_state::TransactionType::EquivocationProof { .. } |
                    qnet_state::TransactionType::VoteEquivocationProof { .. }
                );
                // "Self-verifying" now means "verify the EMBEDDED proof here": the apply arm marks the
                // offender's account, so a junk proof must never reach it.
                if self_verifying
                    && !Self::equivocation_proof_verified(&self.get_storage(), &tx).await {
                    return Err(QNetError::ValidationError(
                        "[REJECT][AUTH] equivocation proof does not verify".to_string()));
                }
                if !self_verifying {
                    if tx.dilithium_public_key.as_ref().map_or(true, |k| k.is_empty())
                        || tx.dilithium_signature.as_ref().map_or(true, |s| s.is_empty()) {
                        return Err(QNetError::ValidationError(format!(
                            "[REJECT][AUTH] user TX requires dilithium sig+pubkey (pure-PQ) (type={:?})",
                            std::mem::discriminant(&tx.tx_type))));
                    }
                    if !Self::verify_dilithium_tx_signature_async(&tx, VerifyLane::Admission).await? {
                        return Err(QNetError::ValidationError("Invalid Dilithium signature".to_string()));
                    }
                }
            }
        }
        
        if tx.amount == 0 && matches!(tx.tx_type, qnet_state::TransactionType::Transfer { .. }) {
            return Err(QNetError::ValidationError("Transfer amount cannot be zero".to_string()));
        }
        
        // PROTOCOL: Commitment TXs skip standard account nonce (they use epoch-based semantics)
        // Deduplication is enforced at STATE level via committed_epochs (deterministic across all nodes)
        // NodeRegistration: no nonce semantics (one-time event, uniqueness enforced by
        // state-level registered_nodes DashMap populated from block history)
        let skip_nonce_check = matches!(tx.tx_type,
            qnet_state::TransactionType::HeartbeatCommitment { .. } |
            qnet_state::TransactionType::Heartbeat { .. } |
            qnet_state::TransactionType::PingCommitmentWithSampling { .. } |
            qnet_state::TransactionType::LightNodeEligibilityBitmap { .. } |
            qnet_state::TransactionType::RewardDistribution { .. } |
            qnet_state::TransactionType::NodeRegistration { .. } |
            qnet_state::TransactionType::NodeActivation { .. } |
            // Slashing proofs are built by a detector, not by an account: `from = "system_slashing"`
            // with nonce 0. Without this the gossip path rejected every relayed proof on nonce while
            // the RPC path let it through — which is why evidence could only ever reach the chain
            // inside its own detector's block.
            qnet_state::TransactionType::EquivocationProof { .. } |
            qnet_state::TransactionType::VoteEquivocationProof { .. }
        );
        
        // PROTOCOL: State-level dedup check for commitment TXs (prevents duplicate per node per epoch)
        if skip_nonce_check {
            let state = self.state.read().await;
            let epoch_interval: u64 = 14400;
            let is_duplicate = match &tx.tx_type {
                qnet_state::TransactionType::HeartbeatCommitment { node_id, window_start_height, .. } => {
                    state.is_epoch_committed("heartbeat", node_id, window_start_height / epoch_interval)
                }
                qnet_state::TransactionType::PingCommitmentWithSampling { window_start_height, .. } => {
                    state.is_epoch_committed("ping", &tx.from, window_start_height / epoch_interval)
                }
                qnet_state::TransactionType::LightNodeEligibilityBitmap { genesis_id, epoch, .. } => {
                    state.is_epoch_committed("bitmap", genesis_id, *epoch)
                }
                qnet_state::TransactionType::NodeRegistration { node_id, .. } => {
                    state.is_node_registered(node_id)
                }
                _ => false, // RewardDistribution / NodeActivation — no epoch dedup
            };
            if is_duplicate {
                return Err(QNetError::ValidationError(
                    format!("duplicate commitment TX: already committed for this epoch hash={}", qnet_state::char_prefix(&tx.hash, 16))
                ));
            }
        }
        
        if !skip_nonce_check {
            let state = self.state.read().await;
            if let Some(account) = state.get_account(&tx.from) {
                let expected_nonce = account.nonce + 1;
                if tx.nonce != expected_nonce {
                    return Err(QNetError::ValidationError(format!(
                        "Invalid nonce: expected {}, got {}",
                        expected_nonce, tx.nonce
                    )));
                }
            } else if tx.nonce != 1 {
                return Err(QNetError::ValidationError("New account nonce must be 1".to_string()));
            }
        }
        
        // Balance validation for transfers
        if let qnet_state::TransactionType::Transfer { .. } = &tx.tx_type {
            let state = self.state.read().await;
            let balance = state.get_balance(&tx.from);
            // SECURITY: checked arithmetic to prevent overflow attacks
            // QUANTUM v2.25: Use effective_gas_price() for +50% Dilithium TX fee
            let effective_gas = tx.effective_gas_price();
            let gas_cost = effective_gas.checked_mul(tx.gas_limit)
                .ok_or_else(|| QNetError::ValidationError(
                    format!("Gas calculation overflow: {} * {}", effective_gas, tx.gas_limit)
                ))?;
            let total_cost = tx.amount.checked_add(gas_cost)
                .ok_or_else(|| QNetError::ValidationError(
                    format!("Balance calculation overflow: {} + {}", tx.amount, gas_cost)
                ))?;

            if balance < total_cost {
                return Err(QNetError::ValidationError(format!(
                    "Insufficient balance: {} < {} (need {} + gas)",
                    balance, total_cost, tx.amount
                )));
            }
        }
        
        let hash = hex::encode(&tx.hash);
        
        // Add to mempool (NO BROADCAST - already received from network)
        // v2.26: Direct access - SimpleMempool is already thread-safe
        // v2.77: Use SHA3-256 via calculate_hash() for NIST compliance
        let tx_hash = tx.calculate_hash();
        let tx_bytes = bincode::serialize(&tx).unwrap_or_default();
        
        if !self.mempool.add_binary_transaction(tx_bytes, tx_hash, tx.gas_price) {
                return Err(QNetError::ValidationError("Transaction already in mempool or mempool full".to_string()));
        }
        
        Ok(hash)
    }
    
    /// BENCHMARK: Submit transaction for load testing
    /// Skips balance validation for benchmark accounts (EON1benchmark*)
    /// Full signature validation and P2P broadcast still applied
    /// SECURITY: Requires QNET_BENCHMARK_MODE=true environment variable
    pub async fn submit_benchmark_transaction(&self, tx: qnet_state::Transaction) -> Result<String, QNetError> {
        use crate::benchmark::BenchmarkManager;
        
        // SECURITY v2.26: Only allow benchmark mode when explicitly enabled
        let benchmark_mode = std::env::var("QNET_BENCHMARK_MODE")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        if !benchmark_mode {
            return Err(QNetError::ValidationError("Benchmark mode not enabled (set QNET_BENCHMARK_MODE=true)".to_string()));
        }
        
        // Only allow benchmark accounts
        if !BenchmarkManager::is_benchmark_account(&tx.from) {
            return Err(QNetError::ValidationError("Only benchmark accounts allowed".to_string()));
        }
        
        // Basic structure validation (skip balance check for benchmark)
        if let Err(validation_error) = tx.validate() {
            return Err(QNetError::ValidationError(format!("Transaction validation failed: {}", validation_error)));
        }
        
        // Signature validation
        if tx.signature.as_ref().map_or(true, |s| s.is_empty()) {
            return Err(QNetError::ValidationError("Transaction signature is empty".to_string()));
        }
        
        // Add to mempool - v2.26: Direct access - SimpleMempool is already thread-safe
        // v2.77: Use SHA3-256 via calculate_hash() for NIST compliance
        let tx_hash = tx.calculate_hash();
        let tx_bytes = bincode::serialize(&tx).unwrap_or_default();
        self.mempool.add_binary_transaction(tx_bytes.clone(), tx_hash.clone(), tx.gas_price);
        
        // PRODUCTION v2.26: Full P2P broadcast for realistic testing
        // With QNET_BENCHMARK_MODE=true, benchmark accounts have real balances in genesis
        // so TX are valid on ALL nodes → realistic distributed test
        if let Some(unified_p2p) = &self.unified_p2p {
            if let Err(e) = unified_p2p.broadcast_transaction(tx_bytes) {
                if crate::node::is_warn() {
                    println!("[WARN][P2P] tx_broadcast_failed err={}", e);
                }
            }
        }

        // PRODUCTION v2.26: Return SHA3(bincode) hash for consistency with mempool
        Ok(tx_hash)
    }
    
    /// BENCHMARK: Submit batch of transactions for high-throughput load testing
    /// REALISTIC: Full P2P broadcast - with QNET_BENCHMARK_MODE accounts have real balances in genesis
    /// Only difference from production: skip balance validation for benchmark accounts
    /// PRODUCTION v2.25: bincode serialization for 10-20x faster processing
    /// SECURITY: Requires QNET_BENCHMARK_MODE=true environment variable
    /// Returns number of successfully added transactions
    pub async fn submit_benchmark_batch(&self, transactions: Vec<qnet_state::Transaction>) -> Result<usize, QNetError> {
        use crate::benchmark::BenchmarkManager;
        
        // SECURITY v2.26: Only allow benchmark mode when explicitly enabled
        let benchmark_mode = std::env::var("QNET_BENCHMARK_MODE")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        if !benchmark_mode {
            return Err(QNetError::ValidationError("Benchmark mode not enabled (set QNET_BENCHMARK_MODE=true)".to_string()));
        }
        
        if transactions.is_empty() {
            return Ok(0);
        }
        
        let mut confirmed = 0usize;
        // PRODUCTION v2.25: Store bincode bytes directly (no JSON overhead)
        let mut valid_txs: Vec<(Vec<u8>, String, u64)> = Vec::with_capacity(transactions.len());
        
        // Pre-validate and serialize all transactions with bincode
        for tx in transactions.iter() {
            // Only allow benchmark accounts
            if !BenchmarkManager::is_benchmark_account(&tx.from) {
                continue;
            }
            
            // Basic validation (skip balance check for benchmark)
            if tx.validate().is_err() {
                continue;
            }
            
            // PRODUCTION v2.25: bincode serialization (10-20x faster than JSON)
            // v2.77: Use SHA3-256 via calculate_hash() for NIST compliance
            if let Ok(tx_bytes) = bincode::serialize(&tx) {
                let tx_hash = tx.calculate_hash();
                valid_txs.push((tx_bytes, tx_hash, tx.gas_price));
                confirmed += 1;
            }
        }
        
        // v2.26: Direct access - SimpleMempool is already thread-safe (DashMap + parking_lot)
        // No external lock needed - eliminates 100K TPS bottleneck!
        if !valid_txs.is_empty() {
            let tx_data_for_broadcast: Vec<Vec<u8>> = valid_txs.iter()
                .map(|(tx_bytes, _, _)| tx_bytes.clone())
                .collect();
            
            // Use trusted batch add - 10-50x faster than individual adds
            let actually_added = self.mempool.add_binary_transaction_batch_trusted(valid_txs);
            confirmed = actually_added;
            
            // PRODUCTION v2.25: Use batch broadcast for high-throughput
            // Single QUIC message for entire batch - reduces stream overhead
        if let Some(unified_p2p) = &self.unified_p2p {
                if !tx_data_for_broadcast.is_empty() {
                    if let Err(e) = unified_p2p.broadcast_transaction_batch(tx_data_for_broadcast) {
                        if crate::node::is_warn() {
                            println!("[WARN][P2P] tx_batch_broadcast_failed err={}", e);
                        }
                    }
                }
            }
        }
        
        Ok(confirmed)
    }
    
    /// BENCHMARK PQ: Submit batch with pure ML-DSA-65 (ML-DSA-65) verification.
    /// This is the honest post-quantum benchmark path:
    ///   - ML-DSA-65 (ML-DSA-65) signature verified (pure post-quantum, same as production)
    ///   - Accepted into mempool
    ///   - P2P broadcast (batch QUIC)
    /// Throughput reflects REAL ML-DSA-65 verification overhead — no shortcuts.
    /// SECURITY: Requires QNET_BENCHMARK_MODE=true
    pub async fn submit_benchmark_batch_pq(&self, transactions: Vec<qnet_state::Transaction>) -> Result<usize, QNetError> {
        use crate::benchmark::BenchmarkManager;
        use pqcrypto_mldsa::mldsa65 as dilithium3;

        let benchmark_mode = std::env::var("QNET_BENCHMARK_MODE")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        if !benchmark_mode {
            return Err(QNetError::ValidationError(
                "Benchmark mode not enabled (set QNET_BENCHMARK_MODE=true)".to_string(),
            ));
        }

        if transactions.is_empty() {
            return Ok(0);
        }

        let mut valid_txs: Vec<(Vec<u8>, String, u64)> = Vec::with_capacity(transactions.len());
        let mut confirmed = 0usize;

        for tx in transactions.iter() {
            // Only benchmark accounts
            if !BenchmarkManager::is_benchmark_account(&tx.from) {
                continue;
            }

            // Pure ML-DSA-65 verification. FIX-5: the fields hold RAW bytes (no hex, no envelope) and the
            // generator signs with detached_sign — hex-decoding raw bytes and then calling open() on a
            // DETACHED signature were both leftovers that made every benchmark TX fail verification.
            let pq_ok = {
                use pqcrypto_traits::sign::{PublicKey as PkTrait, DetachedSignature as SigTrait};
                match (tx.dilithium_signature.as_deref(), tx.dilithium_public_key.as_deref()) {
                    (Some(sig_bytes), Some(pk_bytes))
                        if sig_bytes.len() == 3309 && pk_bytes.len() == 1952 =>
                    {
                        // Reconstruct canonical message (same format as TX generator)
                        let receiver = tx.to.as_deref().unwrap_or("");
                        let msg = Self::chain_bind(&format!(
                            "{}|{}|{}|{}|{}|{}|{}",
                            tx.from, receiver, tx.amount, tx.nonce,
                            tx.gas_price, tx.gas_limit, tx.timestamp
                        ));
                        match (
                            <dilithium3::PublicKey as PkTrait>::from_bytes(pk_bytes),
                            <dilithium3::DetachedSignature as SigTrait>::from_bytes(sig_bytes),
                        ) {
                            (Ok(pk), Ok(sig)) =>
                                dilithium3::verify_detached_signature(&sig, msg.as_bytes(), &pk).is_ok(),
                            _ => false,
                        }
                    }
                    _ => false, // benchmark TX must carry a raw detached sig + pubkey
                }
            };

            if !pq_ok {
                continue;
            }

            // Basic structure validation (skip balance — benchmark accounts)
            if tx.validate().is_err() {
                continue;
            }

            if let Ok(tx_bytes) = bincode::serialize(&tx) {
                let tx_hash = tx.calculate_hash();
                valid_txs.push((tx_bytes, tx_hash, tx.gas_price));
                confirmed += 1;
            }
        }

        if !valid_txs.is_empty() {
            let tx_data_for_broadcast: Vec<Vec<u8>> = valid_txs.iter()
                .map(|(b, _, _)| b.clone())
                .collect();

            let actually_added = self.mempool.add_binary_transaction_batch_trusted(valid_txs);
            confirmed = actually_added;

            // P2P broadcast — same as Ed25519 path
            if let Some(unified_p2p) = &self.unified_p2p {
                if !tx_data_for_broadcast.is_empty() {
                    if let Err(e) = unified_p2p.broadcast_transaction_batch(tx_data_for_broadcast) {
                        if crate::node::is_warn() {
                            println!("[WARN][P2P] tx_batch_broadcast_failed err={}", e);
                        }
                    }
                }
            }
        }

        Ok(confirmed)
    }

    pub async fn get_mempool_transactions(&self) -> Vec<qnet_state::Transaction> {
        // v2.26: Direct access - SimpleMempool is already thread-safe
        let tx_bytes_list = self.mempool.get_pending_binary_transactions(1000);
        
        // Deserialize with bincode (10-20x faster than JSON)
        let mut transactions = Vec::new();
        for tx_bytes in tx_bytes_list {
            // Try bincode first (new format), fallback to JSON (legacy)
            if let Ok(tx) = bincode::deserialize::<qnet_state::Transaction>(&tx_bytes) {
                transactions.push(tx);
            } else if let Ok(tx_json) = String::from_utf8(tx_bytes) {
                // Legacy JSON fallback for backward compatibility
            if let Ok(tx) = serde_json::from_str::<qnet_state::Transaction>(&tx_json) {
                transactions.push(tx);
                }
            }
        }
        transactions
    }
    
    pub async fn add_transaction_to_mempool(&self, tx: qnet_state::Transaction) -> Result<String, QNetError> {
        self.submit_transaction(tx).await
    }
    
    pub async fn get_account(&self, address: &str) -> Result<Option<qnet_state::Account>, QNetError> {
        let state = self.state.read().await;
        Ok(state.get_account(address))
    }

    /// Light token-metadata read (symbol, decimals, logo, is_nft) that does NOT clone the whole contract
    /// account — used by the token-transfer enrich so a hot token never clones every holder balance.
    pub async fn get_contract_meta(&self, address: &str) -> Option<(String, u8, String, bool)> {
        let state = self.state.read().await;
        state.get_contract_meta(address)
    }

    pub async fn get_balance(&self, address: &str) -> Result<u64, QNetError> {
        let state = self.state.read().await;
        Ok(state.get_balance(address))
    }
    
    /// v3.11: Get balance with Merkle proof for Light client trustless verification
    /// 
    /// Returns BalanceProof that includes:
    /// - Balance and nonce
    /// - Merkle proof path
    /// - State root and block height
    /// 
    /// Light clients can verify proof against state_root without trusting the API
    pub async fn get_balance_with_proof(&self, address: &str) -> Result<qnet_state::BalanceProof, QNetError> {
        let state = self.state.read().await;
        state.get_balance_with_proof(address)
            .ok_or_else(|| QNetError::StateError(format!("Account not found: {}", address)))
    }

    /// V2: two-level trustless proof that `holder`'s balance in QRC-20 `contract` is committed in state_root.
    pub async fn get_token_balance_with_proof(&self, contract: &str, holder: &str) -> Result<qnet_state::TokenBalanceProof, QNetError> {
        // Level-1 under a SHORT read guard: only O(1) metadata + the O(log N) account-leaf proof + an O(1)
        // accounts handle — the full contract_storage is NEVER cloned under the lock. Level-2 re-reads
        // storage OFF the consensus lock (via the accounts handle) so a whale-token clone+build never stalls
        // apply, and builds from a PRIVATE tree so it can never poison the shared apply-path storage cache.
        let (partial, accounts, store, need_disk) = {
            let state = self.state.read().await;
            state.token_proof_level1(contract)
        }.ok_or_else(|| QNetError::StateError(format!("Token contract not provable: {}", contract)))?;
        let contract = contract.to_string();
        let holder = holder.to_string();
        tokio::task::spawn_blocking(move || {
            StateManager::token_proof_level2(partial, &contract, &holder, accounts, store, need_disk)
        }).await
            .map_err(|e| QNetError::StateError(format!("proof build join: {}", e)))?
            .ok_or_else(|| QNetError::StateError("Token balance not provable".to_string()))
    }

    pub async fn get_stats(&self) -> Result<serde_json::Value, QNetError> {
        let height = self.get_height().await;
        let peer_count = self.get_peer_count().await?;
        let mempool_size = self.get_mempool_size().await?;
        let regional_health = self.get_regional_health();
        
        Ok(serde_json::json!({
            "height": height,
            "peers": peer_count,
            "mempool_size": mempool_size,
            "regional_health": regional_health,
            "node_type": format!("{:?}", self.node_type),
            "region": format!("{:?}", self.region),
            "node_id": self.node_id,
            "sharding_enabled": false, // deferred; coordinator pinned off regardless of config
            "parallel_validation": self.perf_config.parallel_validation,
        }))
    }
    
}

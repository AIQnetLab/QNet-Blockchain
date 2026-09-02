//! Block apply and state reconciliation: the six-phase apply, richlist index, rollback reconcile.

use super::*;

impl BlockchainNode {
    /// Apply a block's transactions to state. This is the SINGLE source of truth
    /// for state mutation ordering. The phases execute in deterministic order:
    ///
    ///   Phase 1: emit_rewards for emission TXs (merkle reward_root deferred to block_pipeline)
    ///   Phase 2: apply_transaction_lazy + gas_refund (only on success) + apply_merkle_claims
    ///   Phase 3: credit_producer_fees_once
    ///   Phase 5: finalize_merkle  (rewards are merkle-only — no eager pending-rewards accrual)
    ///   Phase 6: update chain_state.height
    ///
    /// Parameters:
    ///   - state_guard: write-locked StateManager
    ///   - microblock: the block to apply
    ///   - storage: for loading node registrations (producer wallet lookup)
    ///   - block_snapshot: if Some, pre-images are recorded before each mutation (for rollback)
    ///   - _processed_emission_mbs: retained for API compatibility; emission double-spend
    ///                              is now prevented by the watermark inside state.emit_rewards.
    pub fn apply_block_to_state(
        state_guard: &StateManager,
        microblock: &MicroBlock,
        storage: &crate::storage::Storage,
        mut block_snapshot: Option<&mut qnet_state::BlockSnapshot>,
    ) -> BlockApplyResult {
        let h = microblock.height;

        // Reset the off-consensus WASM log sink for THIS block so a prior block's logs never leak
        // into this block's persisted receipts. Filled during Phase 2's SEQUENTIAL tx apply.
        qnet_state::wasm_exec::clear_wasm_logs();

        let mut result = BlockApplyResult {
            side_indices: BlockSideIndices::default(),
            merkle_root: [0u8; 32],

            deferred_pool3: 0,
            deferred_registrations: Vec::new(),
            deferred_registration_origins: Vec::new(),
            deferred_pk_binds: Vec::new(),
            reward_epoch_missing: None,
            deferred_light_elig: None,
        };

        // ── Phase 1: Emission — mint only. The epoch's reward root is NOT written here; it is
        // the certified field of macroblock E+MB_PER_EPOCH (see reward_epoch).
        if let Some(em) = crate::reward_epoch::select_emission_at(&microblock.transactions, h) {
            // Counters live outside the accounts map, so an accounts-only rollback would keep the mint.
            if let Some(snap) = block_snapshot.as_deref_mut() {
                let (supply, minted_mb) = state_guard.supply_watermark();
                snap.record_supply(supply, minted_mb);
                // The pool is credited below but is in no transaction's affected set, so nothing
                // else journals it — without this a rollback keeps the credit.
                state_guard.journal_pre_images(snap, &[StateManager::REWARDS_POOL.to_string()]);
            }
            match state_guard.emit_rewards(em.amount, em.epoch) {
                Ok(minted) if minted > 0 => {
                    // Credit what was MINTED, not what was requested: the two differ at the cap.
                    state_guard.credit_rewards_pool(minted);
                    if is_info() {
                        println!("[INFO][STATE] emission_minted epoch={} amount={} minted={} total={} h={}",
                                 em.epoch, em.amount, minted, state_guard.get_total_supply(), h);
                    }
                }
                Ok(_) => {} // watermark-idempotent: already minted for this epoch
                Err(e) => eprintln!("[WARN][STATE] emission_failed epoch={} err={}", em.epoch, e),
            }
        }

        // ── Phase 2: Apply all transactions + gas refund on success ──
        // Fees accrued for the Phase 3 producer credit, both accumulated ONLY on apply-Ok: the debit
        // happens inside the tx apply arm, so a failed tx pays nothing and crediting it would mint QNC
        // that no account was charged. Identical on every node (pure fns of the tx + deterministic fuel).
        let mut block_flat_fees: u64 = 0;
        let mut block_wasm_fuel_fees: u64 = 0;

        // Pure-transfer blocks take the deterministic parallel path: per-sender debit
        // streams + commutative credit sums (intra-block credits land after all debits).
        // Everything a transfer can produce — fee accrual, gas refund, pk bind — is
        // reproduced below from the outcomes; WASM logs/owns/side-effects don't exist
        // for these types. Path choice is a pure function of block content.
        let pure_transfers = microblock.transactions.len() >= 32
            && microblock.transactions.iter().all(|t| matches!(t.tx_type,
                qnet_state::TransactionType::Transfer { .. }
                | qnet_state::TransactionType::BatchTransfers { .. }));
        if pure_transfers {
            let outcomes = state_guard.apply_transfers_parallel(
                &microblock.transactions, block_snapshot.as_deref_mut());
            for (tx, outcome) in microblock.transactions.iter().zip(outcomes) {
                let charged = outcome.as_ref().map_or(false, |o| o.charged);
                if let Err(e) = outcome {
                    if is_debug() {
                        println!("[DBG][STATE] tx_skip h={} err={}", h, e);
                    }
                    continue;
                }
                if charged {
                    let _ = state_guard.apply_gas_refund(tx, h, 0);
                }
                if charged && !tx.from.starts_with("system_") && tx.gas_price > 0 && tx.gas_limit > 0 {
                    let charged_gas = if h >= qnet_state::GAS_METERING_ACTIVATION_HEIGHT {
                        tx.compute_gas_used()
                    } else {
                        tx.gas_limit
                    };
                    block_flat_fees = block_flat_fees
                        .saturating_add(tx.effective_gas_price().saturating_mul(charged_gas));
                }
                if tx.binds_dilithium_pk() {
                    if let Some(pk) = tx.dilithium_public_key.as_ref() {
                        result.deferred_pk_binds.push((tx.from.clone(), pk.clone()));
                    }
                }
            }
        } else {
        for tx in &microblock.transactions {
            // Record pre-images BEFORE mutation (for rollback support)
            if let Some(ref mut snap) = block_snapshot {
                let affected = tx.get_all_affected_addresses();
                state_guard.journal_pre_images(snap, &affected);
                // Commitment-dedup entries live outside the accounts map and are the same class as
                // the supply counters and the fee marker: journal them here or a discarded block
                // leaves the chain marked as having seen a commitment it never committed.
                state_guard.record_commitment_pre_image(tx, snap);
            }

            // Light-eligibility bitmap index. Unconditional; the writer keeps the lowest inclusion height, so the stored
            // value does not depend on the apply verdict — which is decided by a non-durable dedup
            // map and therefore differs between a restarted node and a from-genesis one.
            Self::collect_light_eligibility_bitmap(&mut result.side_indices.light_bitmaps, h, tx);

            // Capture QRC-20 owns-index deltas into the block journal when journaling is on (the
            // consensus persist path), so the wallet→token reverse index is written in the same batch.
            let owns_mark = block_snapshot.as_deref().map(|s| s.owns().len());
            // Capture the log-sink length too, so a rejected tx's partial log emissions are dropped
            // (mirrors the producer-inline per-tx clear) — logs_root then commits successful-tx logs only.
            let log_mark = qnet_state::wasm_exec::wasm_log_len();
            let apply_result = match block_snapshot {
                Some(ref mut snap) => state_guard.apply_transaction_lazy_at_indexed(tx, h, snap.owns_mut()),
                None => state_guard.apply_transaction_lazy_at(tx, h),
            };
            // Take this tx's WASM fuel ONCE, on the same thread, right after apply (resets the slot for
            // the next tx — WASM or not) so the metered fee matches the producer-inline path exactly.
            let tx_wasm_fuel = qnet_state::wasm_exec::take_last_tx_wasm_fuel();
            // A tx whose nonce was already consumed applies Ok WITHOUT debiting; refunding its unused
            // gas or crediting its fee would mint QNC nobody paid.
            let charged = apply_result.as_ref().map_or(false, |o| o.charged);
            if let Err(e) = apply_result {
                // Rejected tx: drop any owns-deltas AND any partial WASM logs it emitted (its state
                // mutations were discarded too), keeping the reverse index + logs_root aligned with
                // committed balances.
                if let (Some(ref mut snap), Some(mark)) = (block_snapshot.as_mut(), owns_mark) {
                    snap.owns_mut().truncate(mark);
                }
                qnet_state::wasm_exec::truncate_wasm_logs(log_mark);
                if is_debug() {
                    println!("[DBG][STATE] tx_skip h={} err={}", h, e);
                }
            } else {
                // Record post-mutation pre-image of sender (gas refund will modify it)
                if let Some(ref mut snap) = block_snapshot {
                    state_guard.journal_pre_images(snap, &[tx.from.clone()]);
                }
                if charged {
                    let _ = state_guard.apply_gas_refund(tx, h, tx_wasm_fuel);
                }
                // Accrue this tx's NET fee — flat charged_gas, plus the metered WASM compute above the
                // activation height. Same filter and same charged_gas the producer's fill loop uses.
                if charged && !tx.from.starts_with("system_") && tx.gas_price > 0 && tx.gas_limit > 0 {
                    let charged_gas = if h >= qnet_state::GAS_METERING_ACTIVATION_HEIGHT {
                        tx.compute_gas_used()
                    } else {
                        tx.gas_limit
                    };
                    block_flat_fees = block_flat_fees
                        .saturating_add(tx.effective_gas_price().saturating_mul(charged_gas));
                    if h >= qnet_state::GAS_METERING_ACTIVATION_HEIGHT {
                        block_wasm_fuel_fees = block_wasm_fuel_fees.saturating_add(tx.wasm_fuel_fee(tx_wasm_fuel));
                    }
                }

                // FIX-5: collect the sender ML-DSA-65 pk for dilithium_pk_root (drained + marker-guarded
                // once/account at commit). Only value TXs with a WIRE pk (first-use); elided later txs are None.
                if tx.binds_dilithium_pk() {
                    if let Some(pk) = tx.dilithium_public_key.as_ref() {
                        result.deferred_pk_binds.push((tx.from.clone(), pk.clone()));
                    }
                }
                // Collect deferred side effects from successful TXs
                match &tx.tx_type {
                    qnet_state::TransactionType::NodeActivation {
                        amount,
                        phase: qnet_state::account::ActivationPhase::Phase2,
                        ..
                    } => {
                        if *amount > 0 {
                            result.deferred_pool3 = result.deferred_pool3.saturating_add(*amount);
                        }
                    }
                    qnet_state::TransactionType::BatchNodeActivations { activation_data, .. } => {
                        // FIX M1: Use saturating_add to prevent wrapping overflow
                        let total_pool3: u64 = activation_data.iter()
                            .filter(|d| d.activation_amount > 0)
                            .fold(0u64, |acc, d| acc.saturating_add(d.activation_amount));
                        if total_pool3 > 0 {
                            result.deferred_pool3 = result.deferred_pool3.saturating_add(total_pool3);
                        }
                    }
                    qnet_state::TransactionType::NodeRegistration {
                        node_id, node_type, wallet_address, burn_tx, ..
                    } => {
                        let type_str = Self::registration_type_str(node_type);
                        // Bind the consensus pubkey ONLY for consensus participants (super/genesis): light
                        // nodes are mobile clients, never in the committee, so their key is irrelevant to QC
                        // verification — keep light rows' vrf empty (semantic + matches the registry recompute).
                        let reg_vrf = if matches!(node_type, qnet_state::NodeType::Super) {
                            Self::registration_consensus_pk(tx).map(hex::encode).unwrap_or_default()
                        } else { String::new() };
                        result.deferred_registrations.push((node_id.clone(), type_str.to_string(), wallet_address.clone(), burn_tx.clone(), reg_vrf));
                        result.deferred_registration_origins.push((node_id.clone(), wallet_address.clone()));
                    }
                    qnet_state::TransactionType::NodeActivation { node_type, .. } => {
                        // Super self-registers its canonical wallet-derived pseudonym (heartbeat/block signer)
                        // so reward crediting resolves node_id→wallet even if NodeRegistration is lost; light
                        // gets its row from NodeRegistration. No phantom tx-hash row ⇒ one wallet = one row.
                        if matches!(node_type, qnet_state::account::NodeType::Super) {
                            let pseudonym = crate::rpc::generate_super_node_pseudonym(&tx.from);
                            result.deferred_registrations.push((pseudonym, "super".to_string(), tx.from.clone(), String::new(), String::new()));
                        }
                    }
                    _ => {}
                }

            }
        }
        } // end pure_transfers / sequential branch

        // Persist this block's captured WASM event logs (RPC getLogs), drained in tx-apply order. These
        // leaves ALSO feed the gate-0 `logs_root` consensus commitment, so a persist failure diverges
        // this node's window logs_root → it stalls out of that window's n−f (fail-safe, not a fork).
        // Block apply is never blocked; surface the error instead of dropping it silently.
        {
            let block_logs = qnet_state::wasm_exec::drain_wasm_logs();
            if !block_logs.is_empty() {
                // Token rows are built HERE because they read the post-apply accounts; writing them
                // is the flush's job.
                result.side_indices.token_rows =
                    Self::build_token_transfer_rows(&state_guard.accounts, h, microblock.timestamp, &block_logs);
            }
            result.side_indices.block_logs = block_logs;
        }

        // Epoch-boundary super reward-eligibility snapshot (deterministic; replaces per-TX writer).
        result.side_indices.super_eligible = Self::compute_super_eligible_at_settle(state_guard, storage, h);
        // Defer the O(roster) light-eligibility snapshot to the caller, AFTER the state write-lock
        // (mirror deferred_emission_root) — a read-only recency index must never stall block apply at scale.
        if h != 0 && h % 14400 == 0 { result.deferred_light_elig = Some(h); }

        // Stamping order decides reg_index, which registry_root hashes. Ordered here, once, so the
        // drain in block_pipeline and any later reader cannot re-derive it differently.
        Self::sort_registrations_canonically(&mut result.deferred_registrations);

        // ── Phase 2b: Merkle reward claims (proof-verified credit, batched) ──
        // A claim TX is RewardDistribution from system_rewards_pool carrying
        // {claims:[{epoch,amount,proof},...]} — one TX can cover ALL of a wallet's unclaimed epochs
        // (no forfeiture). Each entry's proof binds wallet+epoch+amount against the locally-stored
        // epoch root; claim_reward enforces the monotonic last_claimed_epoch watermark (replay-safe)
        // and debits the pool. Runs after Phase 2 so the claim TX's pre-images already exist.
        if let Err(certifying_mb) = Self::apply_merkle_claims(
            state_guard, storage, &microblock.transactions, h, block_snapshot.as_deref_mut()) {
            result.reward_epoch_missing = Some(certifying_mb);
        }

        // Producer fee-credit wallet for the rich-list touched-set (the credit below mutates it and it
        // is NOT in any tx's affected-addresses). Captured only when a credit is actually applied.
        let mut richlist_producer_wallet: Option<String> = None;

        // ── Phase 3: Credit producer fees (with recalculation) ──
        if block_flat_fees.saturating_add(block_wasm_fuel_fees) > 0 {
            // The header's fees_collected is the producer's PRE-EXECUTION estimate over the whole tx
            // list; the AUTHORITATIVE credit is what Phase 2 actually debited (accrued on apply-Ok
            // only), so a failed tx pays nothing and earns the producer nothing. Recomputed, never
            // read from the header, so a malicious producer cannot inflate it. The header legitimately
            // exceeds this when a tx failed; only an excess over the whole-list upper bound is a claim
            // the block could not have earned even with every tx succeeding.
            let validated_fees = block_flat_fees.saturating_add(block_wasm_fuel_fees);
            if microblock.fees_collected > validated_fees {
                let list_upper_bound: u64 = microblock.transactions.iter()
                    .filter(|tx| !tx.from.starts_with("system_") && tx.gas_price > 0 && tx.gas_limit > 0)
                    .map(|tx| {
                        let charged_gas = if h >= qnet_state::GAS_METERING_ACTIVATION_HEIGHT {
                            tx.compute_gas_used()
                        } else {
                            tx.gas_limit
                        };
                        tx.effective_gas_price().saturating_mul(charged_gas)
                    })
                    .fold(0u64, |acc, fee| acc.saturating_add(fee));
                if microblock.fees_collected > list_upper_bound {
                    println!("[WARN][VALIDATION] fees_overclaimed h={} claimed={} upper_bound={} credited={} producer={}",
                             h, microblock.fees_collected, list_upper_bound, validated_fees, microblock.producer);
                }
            }

            let producer_wallet = match storage.load_node_registration(&microblock.producer) {
                Ok(Some((_, wallet, _))) => wallet,
                _ => {
                    if is_warn() {
                        println!("[WARN][FEES] producer_wallet_not_found producer={} h={}", microblock.producer, h);
                    }
                    String::new()
                }
            };
            if !producer_wallet.is_empty() {
                richlist_producer_wallet = Some(producer_wallet.clone());
                if let Some(ref mut snap) = block_snapshot {
                    state_guard.journal_pre_images(snap, &[producer_wallet.clone()]);
                }
                match state_guard.credit_producer_fees_once(
                    h, &producer_wallet, validated_fees, block_snapshot.as_deref_mut(),
                ) {
                    Ok(true) => {
                        if is_info() && validated_fees > 10_000_000 {
                            println!("[INFO][FEES] credited producer={} wallet={}... fees={} nanoQNC h={}",
                                     microblock.producer,
                                     qnet_state::char_prefix(&producer_wallet, 16),
                                     validated_fees, h);
                        }
                    }
                    Ok(false) => {
                        if is_debug() {
                            println!("[DBG][FEES] skip_dup h={} (already credited)", h);
                        }
                    }
                    Err(e) => {
                        eprintln!("[ERR][FEES] credit_failed producer={} wallet={} fees={} err={}",
                                 microblock.producer, producer_wallet, validated_fees, e);
                    }
                }
            }
        }

        // Rewards are merkle-only: emission writes a per-epoch reward_root (Phase 1) credited later by
        // proof-verified claim TXs (apply_merkle_claims) — there is NO eager pending-rewards accrual.

        // ── Phase 5: Finalize merkle tree ──
        result.merkle_root = state_guard.finalize_merkle();

        // Rich-list index (display-only, best-effort): reconcile this block's touched holders. Same
        // touched-set as the producer-inline path (tx affected-addrs ∪ credited producer wallet).
        result.side_indices.richlist =
            Self::reconcile_richlist_for_block(state_guard, microblock, richlist_producer_wallet.as_deref());

        // ── Phase 6: Update chain_state.height ──
        {
            let mut chain_state = state_guard.chain_state.write();
            if h > chain_state.height {
                if let Some(ref mut snap) = block_snapshot { snap.record_chain_height(chain_state.height); }
                chain_state.height = h;
            }
        }

        result
    }

    // ── Native-QNC rich-list index (display-only) ────────────────────────────────────────────────
    // Apply-time reconcile of the top-K holder index for exactly the addresses a block touched, plus
    // a full rebuild from live state. The index is in NO root/checkpoint — every hook is best-effort:
    // a storage error is logged and swallowed, NEVER failing block apply. A divergence/drift is
    // cosmetic and self-heals on the next rebuild (boot / snapshot / reorg).

    /// Reconcile the rich-list index for one applied block. `touched` = union of every per-tx native-
    /// balance participant (`get_all_affected_addresses`) ∪ the producer fee-credit wallet (which the
    /// fee credit mutates but is NOT in the affected set). Each touched address is re-classified against
    /// live state: `Some(balance)` if it is a holder (non-contract, non-system, non-burn, balance>0),
    /// else `None` to drop it. Display-only + best-effort — never propagates the storage error.
    pub(super) fn reconcile_richlist_for_block(
        state: &StateManager,
        microblock: &MicroBlock,
        producer_wallet: Option<&str>,
    ) -> Vec<(String, Option<u64>)> {
        use qnet_state::transaction::CANONICAL_BURN_ADDR;
        let mut touched: std::collections::HashSet<String> = std::collections::HashSet::new();
        for tx in &microblock.transactions {
            for addr in tx.get_all_affected_addresses() {
                touched.insert(addr);
            }
        }
        if let Some(pw) = producer_wallet {
            if !pw.is_empty() { touched.insert(pw.to_string()); }
        }
        if touched.is_empty() { return Vec::new(); }
        let mut updates: Vec<(String, Option<u64>)> = Vec::with_capacity(touched.len());
        for addr in touched {
            let upd = match state.get_account(&addr) {
                Some(acct) if !acct.is_contract
                    && acct.balance > 0
                    && addr.as_str() != CANONICAL_BURN_ADDR
                    && !addr.starts_with("system_") => Some(acct.balance),
                _ => None,
            };
            updates.push((addr, upd));
        }
        updates
    }

    /// Full rebuild of the display-only rich-list index. Streams the AUTHORITATIVE `accounts` CF (complete
    /// hot∪cold mirror) off the state lock, so it is correct at any holder count (the old in-memory-cache
    /// scan silently dropped evicted cold holders past the cache cap). Returns the storage result so the
    /// boot caller gates its one-time marker on success (a transient failure then retries next boot).
    pub(super) async fn rebuild_richlist_index() -> crate::errors::IntegrationResult<u64> {
        // Offload the unbounded accounts-CF scan to the blocking pool so it never stalls a reactor worker
        // (mirrors persist_accounts_batch). At scale the scan is many seconds of pure CPU/IO with no yield;
        // the callers (boot / snapshot-restore / reorg) await this on the shared runtime.
        let storage = match try_get_storage() {
            Some(s) => std::sync::Arc::clone(s),
            None => return Err(crate::errors::IntegrationError::Other("richlist_rebuild_no_storage".to_string())),
        };
        match tokio::task::spawn_blocking(move || storage.richlist_rebuild_from_accounts()).await {
            Ok(res) => res,
            Err(e) => Err(crate::errors::IntegrationError::Other(format!("richlist_rebuild_join_err: {}", e))),
        }
    }

    // Slashing only for cryptographically provable offenses:
    //   SLASHABLE: double-sign (2 valid sigs, same producer+height),
    //   invalid block (fails hash/sig), chain fork (conflicting signed blocks).
    //   NOT SLASHABLE: missed blocks — no deterministic "who should have produced"
    //   post-facto (no original_producer field, takeover overwrites it, false positives
    //   from partitions). Liveness handled instead by the heartbeat-eligibility gate
    //   (non-heartbeating node drops out) + slot-timeout failover with no penalty.
    
    // Rebuild in-memory state to match the chain tip at target_height after a
    // rollback. Rollback deletes microblocks from storage but leaves the
    // in-memory accounts DashMap mutated, so post-rollback blocks validate
    // against stale RAM state → silent state-root fork. Strategy: restore the
    // freshest snapshot with height ≤ target, then deterministically replay
    // microblocks up to target via apply_block_to_state (full replay from
    // genesis if no snapshot). Gated by 60–300 s cooldown, fork-evidence only.
    // Err → caller must resync; do NOT keep producing on unvouched state.
    /// Rebuild state at `target_height` and PROVE it against the canonical block's state_root.
    /// Any Err leaves a non-authoritative leaf set resident, so the suspect latch is set HERE,
    /// on the single exit — no future early-return inside can forget it.
    pub(super) async fn reconcile_state_after_rollback(
        state: &Arc<tokio::sync::RwLock<StateManager>>,
        storage: &Arc<Storage>,
        target_height: u64,
    ) -> Result<(), String> {
        let r = Self::reconcile_state_after_rollback_inner(state, storage, target_height).await;
        if r.is_err() { crate::block_pipeline::mark_state_suspect(); }
        r
    }

    async fn reconcile_state_after_rollback_inner(
        state: &Arc<tokio::sync::RwLock<StateManager>>,
        storage: &Arc<Storage>,
        target_height: u64,
    ) -> Result<(), String> {
        // Step 1: locate the freshest snapshot ≤ target.
        // Reads-only — no state lock needed.
        let snap_choice = match storage.find_snapshot_at_or_before(target_height) {
            Ok(opt) => opt,
            Err(e) => {
                println!(
                    "[WARN][STATE] reconcile_snapshot_lookup_failed target={} err={:?} action=full_replay",
                    target_height, e,
                );
                None
            }
        };

        // Step 2: pre-decode the snapshot payload off the state lock.
        // Decoding is purely a CPU transformation of bytes the caller
        // already owns; doing it BEFORE we acquire the write lock keeps
        // the apply pipeline blocked for the minimum possible window.
        // Decode the snapshot bytes already fetched by find_snapshot_at_or_before (canonical
        // full_snap_ or legacy state_snap_). Restoring from the freshest snapshot ≤ target
        // bounds replay to ≤ SNAPSHOT_INCREMENTAL_INTERVAL instead of a full genesis replay.
        let restored_baseline: Option<(u64, u64, Vec<(String, qnet_state::Account)>)> =
            match snap_choice {
                Some((snap_height, snap_data)) => {
                    // total_supply is a counter, not derivable from accounts. Take it from the anchor
                    // macroblock's QC-bound checkpoint (apply-bound, same source as cold-join), NOT from
                    // the snapshot blob. None ⇒ anchor/QC unavailable ⇒ from-0 full replay (watermark from 0).
                    match storage.decode_snapshot_accounts(&snap_data) {
                        Ok(accounts) => match storage.anchor_root_and_supply(snap_height / 90, &accounts) {
                            Some((_, ts)) => Some((snap_height, ts, accounts)),
                            None => {
                                println!("[WARN][STATE] reconcile_anchor_unavailable snap_h={} action=full_replay", snap_height);
                                None
                            }
                        },
                        Err(e) => {
                            println!("[WARN][STATE] reconcile_decode_failed snap_h={} err={:?}", snap_height, e);
                            None
                        }
                    }
                }
                None => None,
            };

        // No usable snapshot above the genesis window ⇒ refuse a from-0 replay (it freezes the
        // node under the state lock and resets the per-mb baseline). Return Err so the caller
        // re-syncs from the canonical n−f chain instead. A snapshot exists at every interval.
        if restored_baseline.is_none() && target_height > SNAPSHOT_INCREMENTAL_INTERVAL {
            return Err(format!(
                "reconcile_no_usable_snapshot target={} action=resync_required", target_height
            ));
        }

        // Step 3: pre-load every microblock that needs to be replayed.
        // Doing this BEFORE we acquire the state write lock means the
        // apply pipeline only blocks during pure in-memory CPU work,
        // never during RocksDB I/O. RocksDB reads are themselves
        // serialised inside the storage layer.
        //
        // SCALABILITY NOTE
        // ────────────────────────────────────────────────────────────
        // For a snapshot interval of 3 600 microblocks we replay at
        // most 3 599 blocks (when target sits just before the next
        // snapshot boundary). With a typical microblock at a few KB
        // this is a few MB of working memory — negligible at
        // production scale. Pre-loading also lets the replay loop run
        // without any `await` points, which is what makes the lock
        // window deterministic.
        // restored_baseline.0 is a microblock height (snapshots keyed by height) ⇒ replay floor = h+1.
        let replay_from: u64 = restored_baseline
            .as_ref()
            .map(|(h, _, _)| h.saturating_add(1))
            .unwrap_or(0);
        let replay_to = target_height;
        let mut blocks_to_replay: Vec<MicroBlock> = Vec::new();
        let mut load_errs = 0u64;
        if replay_from <= replay_to {
            for h in replay_from..=replay_to {
                match storage.load_microblock_auto_format(h) {
                    Ok(Some(mb)) => blocks_to_replay.push(mb),
                    _ => load_errs = load_errs.saturating_add(1),
                }
            }
        }

        // Step 4: ATOMIC STATE REWRITE under a single write lock.
        // ────────────────────────────────────────────────────────────
        // Holding `state.write()` across the snapshot restore AND the
        // entire replay loop is the only way to guarantee that no
        // concurrent apply path interleaves a future block on top of a
        // partially-rebuilt state. Without this the `apply_block_to_state`
        // path inside `block_pipeline` (which also acquires `state.write()`
        // per block) could grab the lock between iterations and apply a
        // post-rollback block on top of, say, the snapshot baseline plus
        // 50 of the 90 microblocks we still need to replay. The resulting
        // state would have the post-rollback block's mutations layered on
        // an inconsistent base — undetectable until a state-root diff
        // surfaces it many blocks later.
        //
        // Lock duration is bounded: at most one snapshot restore (∼50 ms
        // for 1 M accounts under in-memory operations) plus
        // `(replay_to − replay_from + 1) ≤ SNAPSHOT_INCREMENTAL_INTERVAL`
        // applies. Apply paths that need the lock during this window
        // back-pressure naturally — exactly the desired behaviour
        // because they MUST NOT advance against the still-rebuilding
        // state.
        let replayed: u64;
        let mode: &'static str;
        let computed_root: [u8; 32];
        {
            let sg = state.write().await;

            match restored_baseline {
                Some((snap_height, snap_total_supply, accounts)) => {
                    if let Err(e) = (*sg).restore_accounts(accounts) {
                        // Same as the rehydrate path: a mid-iteration failure leaves a partial
                        // account prefix behind, and the caller resyncs from it. Wipe first.
                        // Latch suspect: the resident leaf set is no longer an authority.
                        (*sg).clear();
                        return Err(format!("restore_accounts_failed err={:?}", e));
                    }
                    {
                        let mut cs = sg.chain_state.write();
                        // snap_height is a MICROBLOCK HEIGHT (snapshots keyed by height). Restore chain height,
                        // total_supply baseline + watermark so the state and the replay floor (replay_from =
                        // snap_height+1) are consistent — replay mints ONLY the gap (snap, target].
                        cs.height = snap_height;
                        cs.total_supply = snap_total_supply;
                        cs.last_minted_emission_mb = Self::emission_mb_index(snap_height);
                    }
                    // The commitment-dedup maps are DERIVED from block history and survive the
                    // accounts wipe, so after rolling back they still hold entries written by the
                    // DELETED blocks: a re-applied NodeRegistration is then skipped as a duplicate,
                    // its registry row and registry_root delta are never written, and — because a
                    // registration has no account effect — the state_root still matches, so nothing
                    // alarms. Reseeded from the durable registry, which the caller has already
                    // pruned via rebuild_registry_lthash(target).
                    if let Err(e) = storage.reseed_commitment_dedup(&*sg) {
                        return Err(format!("reseed_commitment_dedup_failed err={:?}", e));
                    }
                    // Fee-credit markers are released by restore_accounts itself — the accounts wipe
                    // is what destroys the credits, so the release belongs to that primitive, not
                    // here. A caller-side range release was too narrow: it covered only the REPLAY
                    // window (snap, target], while the rollback also DELETED (target, local_h],
                    // whose credits the same wipe destroyed — those markers survived with nothing
                    // behind them and wedged the first re-applied height above the target.
                    println!(
                        "[INFO][STATE] reconcile_snapshot_restored snap_h={} total_supply={} target={}",
                        snap_height, snap_total_supply, target_height,
                    );
                    mode = "incremental";
                }
                None => {
                    sg.clear();
                    {
                        let mut cs = sg.chain_state.write();
                        cs.total_supply = 0;
                        cs.last_minted_emission_mb = 0; // reset watermark so re-apply re-mints
                        cs.height = 0;
                    }
                    qnet_state::clear_credited_fees_cache();
                    mode = "full";
                }
            }

            // Replay every loaded block under the same lock — no `await`
            // inside the loop, no opportunity for another task to slip in.
            let mut applied = 0u64;
            for mb in &blocks_to_replay {
                let r = Self::apply_block_to_state(&sg, mb, storage, None);
                // Replaying a stored block: it already owns its slot, so its side indices are written
                // straight away (idempotent — lowest-height-wins and add-only).
                Self::flush_block_side_indices(storage, mb.height, &r.side_indices);
                if let Some(certifying_mb) = r.reward_epoch_missing {
                    return Err(format!("reconcile_reward_epoch_missing h={} certifying_mb={}",
                                       mb.height, certifying_mb));
                }
                // Re-seal total_supply at checkpoint heads (see startup replay): a post-reconcile finality
                // redrive reads get_total_supply_at(head), which does NOT recompute on miss → defer forever.
                if mb.height % qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL == 0 {
                    let _ = storage.seal_total_supply(mb.height, sg.get_total_supply());
                }
                applied = applied.saturating_add(1);
            }
            replayed = applied;
            // Root captured under the SAME lock: after release a concurrent apply may advance the
            // state past target and a post-release read would spuriously mismatch.
            computed_root = sg.finalize_merkle();
        } // <-- single lock release after full reconcile

        println!(
            "[INFO][STATE] reconcile_complete mode={} replay_from={} target={} replayed={} load_errors={}",
            mode, replay_from, replay_to, replayed, load_errs,
        );

        if load_errs > 0 && replayed == 0 {
            return Err(format!(
                "reconcile_no_blocks_replayed replay_from={} target={} errors={}",
                replay_from, replay_to, load_errs,
            ));
        }

        // Fail-closed verify: the reconciled in-memory merkle root must equal the CANONICAL block's
        // state_root at target — the same per-block root every validator checked at apply, stored in
        // the surviving microblock. Any other outcome ⇒ Err ⇒ caller resyncs from canonical QC state.
        // (The former gate read consensus_data.snapshot_root, which no producer ever sets — the binder
        // migrated to macroblock.state_root — so reconcile could never prove and ALWAYS fell to resync.)
        let expected_root = match storage.load_microblock_auto_format(target_height) {
            Ok(Some(mb)) => mb.state_root,
            _ => {
                return Err(format!("reconcile_no_target_block target={} action=resync", target_height));
            }
        };
        if computed_root != expected_root {
            return Err(format!(
                "reconcile_root_mismatch target={} expected={} computed={} action=resync",
                target_height, hex::encode(&expected_root[..8]), hex::encode(&computed_root[..8]),
            ));
        }
        // The root just proved the rebuilt state canonical — lift the latch HERE so the
        // true-up below (and any reader between now and the caller's clear) sees a proven
        // authority. The callers' clears become no-ops.
        crate::block_pipeline::clear_state_suspect();
        println!("[INFO][STATE] reconcile_verified target={} root={}",
                 target_height, hex::encode(&computed_root[..8]));

        // Push the reconciled accounts back to disk. The accounts CF is written by a fire-and-forget
        // task after apply and is NOT rolled back, so an orphaned block's values survive there. RAM is
        // now proven canonical (the root check above), and the consensus reads go RAM-first — but an
        // EVICTED account falls through to this CF, and a stale banned_at_height there would zero a
        // node's reputation on this host and nowhere else, splitting epoch_commitment. Writing the
        // proven state through closes the window instead of waiting for persist-before-evict.
        {
            let sg = state.read().await;
            let restored: Vec<(String, qnet_state::Account)> = sg.accounts.iter()
                .map(|e| (e.key().clone(), e.value().clone())).collect();
            drop(sg);
            let n = restored.len();
            // Only the reconciled RAM set is written. A wholesale delete of non-resident rows was
            // considered and REJECTED: eviction is normal, so that would drop live balances to correct a
            // narrow staleness. The residual — an account banned on an orphaned branch AND evicted before
            // the reorg — stays, self-healing on the next persist-before-evict.
            if let Err(e) = storage.persist_accounts_batch(restored, Vec::new()).await {
                println!("[WARN][STATE] reconcile_account_persist_failed target={} err={}", target_height, e);
            } else if is_info() {
                println!("[INFO][STATE] reconcile_accounts_persisted target={} n={}", target_height, n);
            }
        }
        // Drop CF phantoms against the just-proven leaf set (safe here precisely because the
        // root was verified above — see trueup_accounts_cf).
        Self::trueup_staged_candidates(state, storage).await;
        Ok(())
    }

    /// Targeted CF true-up: check ONLY the addresses the rolled-back blocks touched (staged by
    /// the rollback barrier) instead of sweeping the whole accounts CF. Phantoms are born at
    /// exactly one place — a block whose write-through mirror was never reversed — so the
    /// rollback's own journal is the complete candidate set. O(rolled-back addresses), no hot-path
    /// scan, and correct at any account count. Runs only on a PROVEN state (its single caller is
    /// the reconcile tail, past the root verify). Returns (checked, removed).
    pub async fn trueup_staged_candidates(
        state: &Arc<tokio::sync::RwLock<StateManager>>,
        storage: &Arc<Storage>,
    ) -> (u64, u64) {
        let candidates = storage.load_trueup_candidates();
        if candidates.is_empty() { return (0, 0); }
        // A leaf-store read error anywhere in this process makes "absent" unprovable, so the
        // candidates stay staged for a later run rather than being deleted on a guess.
        if crate::storage::MERKLE_LEAF_READ_ERRS.load(std::sync::atomic::Ordering::Relaxed) != 0 {
            println!("[WARN][STATE] cf_trueup_deferred reason=leaf_store_read_errs candidates={}",
                     candidates.len());
            return (candidates.len() as u64, 0);
        }
        let errs_before = crate::storage::MERKLE_LEAF_READ_ERRS.load(std::sync::atomic::Ordering::Relaxed);
        let phantoms: Vec<String> = {
            let sg = state.read().await;
            if sg.merkle_leaf_count() == 0 { return (candidates.len() as u64, 0); }
            sg.merkle_absent_leaves(&candidates)
        };
        // This is the one true-up path that actually reaches the leaf store (a trimmed cache
        // falls through to get_leaf), so the veto must bracket the probe — a fault DURING it
        // is exactly the case where "absent" is a guess. Journal kept for a later run.
        if crate::storage::MERKLE_LEAF_READ_ERRS.load(std::sync::atomic::Ordering::Relaxed) != errs_before {
            println!("[WARN][STATE] cf_trueup_deferred reason=leaf_store_read_err_during_probe candidates={}",
                     candidates.len());
            return (candidates.len() as u64, 0);
        }
        let mut removed = 0u64;
        if !phantoms.is_empty() {
            match storage.delete_accounts_cf_keys(&phantoms) {
                Ok(()) => {
                    removed = phantoms.len() as u64;
                    println!("[WARN][STATE] cf_phantoms_removed n={} checked={} sample={:?}",
                             removed, candidates.len(), &phantoms[..phantoms.len().min(8)]);
                }
                Err(e) => {
                    println!("[WARN][STATE] cf_trueup_delete_failed n={} err={}", phantoms.len(), e);
                    return (candidates.len() as u64, 0); // keep the journal for the next attempt
                }
            }
        } else if is_info() {
            println!("[INFO][STATE] cf_trueup_clean checked={}", candidates.len());
        }
        storage.clear_trueup_candidates();
        (candidates.len() as u64, removed)
    }

    /// CF↔merkle true-up: delete `accounts` CF rows with no committed merkle leaf.
    /// The CF is the source every snapshot streams from, and its write-through mirror is
    /// append/update-only — a row persisted for a block that later rolled back (reorg,
    /// fork recovery) stays forever, so every snapshot resurrects it and restore can
    /// never reproduce a certified state_root. Leaf membership — not RAM residency — is
    /// the deletion test, and ONLY while the RAM leaf set is complete (store-trimmed or
    /// empty ⇒ no authority ⇒ no-op): an evicted-but-live account must never be touched.
    /// Deletions are capped per run (max(1000, 5% of scanned)) — a legit mass-rollback
    /// converges over successive runs while a corrupt authority cannot wipe the CF.
    /// Chunked, one short read-lock per page; normally removes nothing.
    /// Returns (scanned, removed).
    pub async fn trueup_accounts_cf(
        state: &Arc<tokio::sync::RwLock<StateManager>>,
        storage: &Arc<Storage>,
    ) -> (u64, u64) {
        let t0 = std::time::Instant::now();
        // No deletions off an unproven or empty leaf set: a tripped apply-breaker means the
        // live state is suspect, and an empty tree means no state was built at all.
        if crate::block_pipeline::state_suspect() {
            println!("[WARN][STATE] cf_trueup_skipped reason=state_suspect");
            return (0, 0);
        }
        // Any leaf-store read error makes "absent" unprovable for the whole process — a probe
        // that could not read is not a proof of absence.
        if crate::storage::MERKLE_LEAF_READ_ERRS.load(std::sync::atomic::Ordering::Relaxed) != 0 {
            println!("[WARN][STATE] cf_trueup_skipped reason=leaf_store_read_errs");
            return (0, 0);
        }
        {
            let sg = state.read().await;
            if sg.merkle_leaf_count() == 0 {
                println!("[WARN][STATE] cf_trueup_skipped reason=empty_leafset");
                return (0, 0);
            }
            // Store-trimmed leaf cache ⇒ every miss would cost a random point read (millions at
            // target scale). The rollback-staged candidates cover phantoms at their source, so the
            // full sweep is the small-deployment belt only.
            if !sg.merkle_leaves_complete() {
                println!("[INFO][STATE] cf_trueup_skipped reason=leafset_trimmed (targeted true-up covers it)");
                return (0, 0);
            }
        }
        let mut after: Option<Vec<u8>> = None;
        let (mut scanned, mut removed, mut deferred) = (0u64, 0u64, 0u64);
        let mut sample: Vec<String> = Vec::new();
        loop {
            let (keys, last) = match storage.accounts_cf_keys_page(after.as_deref(), 10_000) {
                Ok(p) => p,
                Err(e) => { println!("[WARN][STATE] cf_trueup_scan_failed err={}", e); break; }
            };
            if keys.is_empty() { break; }
            scanned += keys.len() as u64;
            // Re-check the gates every page: a concurrent recovery can trip the breaker or
            // clear the tree mid-scan, and a store read error must veto the page (an
            // unreadable leaf is not an absent leaf).
            let errs_before = crate::storage::MERKLE_LEAF_READ_ERRS.load(std::sync::atomic::Ordering::Relaxed);
            let phantoms: Vec<String> = {
                let sg = state.read().await;
                if crate::block_pipeline::state_suspect() || sg.merkle_leaf_count() == 0 {
                    println!("[WARN][STATE] cf_trueup_aborted reason=authority_lost scanned={}", scanned);
                    break;
                }
                sg.merkle_absent_leaves(&keys)
            };
            if crate::storage::MERKLE_LEAF_READ_ERRS.load(std::sync::atomic::Ordering::Relaxed) != errs_before {
                println!("[WARN][STATE] cf_trueup_page_vetoed reason=leaf_store_read_err scanned={}", scanned);
                after = last;
                if after.is_none() { break; }
                continue;
            }
            if !phantoms.is_empty() {
                let cap = std::cmp::max(1000, scanned / 20);
                let room = cap.saturating_sub(removed) as usize;
                deferred += phantoms.len().saturating_sub(room) as u64;
                let batch: Vec<String> = phantoms.into_iter().take(room).collect();
                if !batch.is_empty() {
                    match storage.delete_accounts_cf_keys(&batch) {
                        Ok(()) => {
                            removed += batch.len() as u64;
                            for p in batch.into_iter().take(8usize.saturating_sub(sample.len())) {
                                sample.push(p);
                            }
                        }
                        Err(e) => println!("[WARN][STATE] cf_trueup_delete_failed n={} err={}", batch.len(), e),
                    }
                }
            }
            after = last;
            if after.is_none() { break; }
        }
        if deferred > 0 {
            eprintln!("[CRIT][STATE] cf_trueup_capped removed={} deferred={} scanned={} — excess converges on next runs",
                      removed, deferred, scanned);
        }
        if removed > 0 {
            println!("[WARN][STATE] cf_phantoms_removed n={} scanned={} sample={:?} ms={}",
                     removed, scanned, sample, t0.elapsed().as_millis());
        } else if is_info() {
            println!("[INFO][STATE] cf_trueup_clean scanned={} ms={}", scanned, t0.elapsed().as_millis());
        }
        (scanned, removed)
    }

    // analyze_chain_for_slashing (legacy in-memory SlashingEvent path) was removed:
    // it had no caller under v2. Slashing is now fully on-chain — block equivocation
    // via EquivocationProof TXs (drain_equivocation_proof_txs) verified+banned in the
    // deterministic fold, with the cumulative ban-set anchored per macroblock
    // (compute_cumulative_ban_set). Timeout/commit-vote equivocation detection
    // (EQUIVOCATION_EVIDENCE) is retained but awaits its own on-chain proof path.

    // ═══════════════════════════════════════════════════════════════════════════
    // GENESIS CANDIDATES HELPER (v2.32)
    // Single source of truth for Genesis node candidates with real reputation
    // ═══════════════════════════════════════════════════════════════════════════
    
}

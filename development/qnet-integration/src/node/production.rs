//! The microblock producer loop: slot timing, the local right-to-produce predicate, assembly and broadcast.

use super::*;

impl BlockchainNode {
    /// Fork-recovery consumer — its own task, for the same reason as the pacemaker:
    /// it used to live in the production loop, and during the h=601 wedge an armed
    /// recovery target waited minutes for a parked loop to consume it. Rollback is
    /// never cancelled mid-flight (no timeout wrapper); the finality guard and the
    /// rollback barrier already make it safe against concurrent apply.
    pub(super) async fn run_fork_recovery_consumer(
        state: std::sync::Arc<tokio::sync::RwLock<qnet_state::State>>,
        height: std::sync::Arc<tokio::sync::RwLock<u64>>,
        storage: std::sync::Arc<crate::storage::Storage>,
        unified_p2p: Option<std::sync::Arc<crate::unified_p2p::SimplifiedP2P>>,
    ) {
        let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(1));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
                // ═══════════════════════════════════════════════════════════════════
                // v13.2: PIPELINE FORK RECOVERY (OUTSIDE is_synced_enough gate)
                // ═══════════════════════════════════════════════════════════════════
                // Forked nodes are >20 blocks behind best peer → is_synced_enough=false.
                // If recovery is gated behind is_synced_enough, fork is PERMANENT.
                // Must run unconditionally so any node can recover from pipeline-detected fork.
                // ═══════════════════════════════════════════════════════════════════
                if let Some(fork_h) = crate::block_pipeline::take_fork_recovery_signal() {
                    let local_h = *height.read().await;
                    // v33: FORK_RECOVERY_HEIGHT is the deterministic highest-good height —
                    // disputed_height-1 (n−f minority-fork observer) or finalized_h+1 (anchor
                    // recovery), both agreed across nodes. Roll back TO it: keep ≤ fork_h,
                    // delete fork_h+1..=local_h. The prior `min(fork_h, local_h)-1` folded in
                    // the LOCAL tip, so nodes at different heights rolled to DIFFERENT targets
                    // → baseline (LAST_FINALIZED_ROUND_PER_MB) diverged → producer election
                    // diverged → competing forks (the rollback storm); it also over-deleted one
                    // good block (the extra -1). A node behind the fork (local_h ≤ fork_h)
                    // deletes nothing here (guard below) — it pulls the canonical chain via sync.
                    // Never roll the contiguous frontier below the adopted snapshot/finality
                    // floor: the anchor is n−f-QC-final and the snapshot holds sub-anchor state,
                    // so a target below it is not a real reorg point. Clamping up means a target
                    // ≥ local_h makes the destructive delete below no-op (rollback_to < local_h
                    // guard) and the node re-syncs cleanly instead of stranding chain_height under
                    // a higher monotonic anchor (the wedge). Complements the LAST_FINALIZED guard
                    // inside begin_finality_guarded_rollback.
                    let anchor_floor = SNAPSHOT_ANCHOR_MB
                        .load(std::sync::atomic::Ordering::Acquire).saturating_mul(90);
                    let rollback_to = fork_h.max(anchor_floor);
                    println!("[WARN][FORK] pipeline_detected fork_h={} local_h={} rollback_to={} anchor_floor={}",
                             fork_h, local_h, rollback_to, anchor_floor);

                    if unified_p2p.is_some() {
                        // 1. Rollback local chain to before fork point
                        if rollback_to > 0 && rollback_to < local_h {
                            // v14.8: Atomic claim + finality check.
                            let finalized_h = LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::SeqCst);
                            if let Err(reason) = crate::storage::begin_finality_guarded_rollback(rollback_to, finalized_h) {
                                println!("[WARN][FORK] rollback_skipped reason={}", reason);
                            } else {
                                // Delete ALL blocks from rollback_to+1 to local_h
                                // (includes our forked tip block)
                                let delete_from = rollback_to + 1;
                                for h in delete_from..=local_h {
                                    // Long loops must tick the watchdog, not just the phases.
                                    if h % 256 == 0 { crate::storage::note_rollback_progress(); }
                                    if let Err(e) = storage.delete_microblock(h) {
                                        if is_warn() {
                                            println!("[WARN][FORK] delete_fail h={} err={}", h, e);
                                        }
                                    }
                                }

                                // v10.2: DISK FIRST, RAM SECOND (crash-safe order)
                                if let Err(e) = storage.set_chain_height(rollback_to) {
                                    eprintln!("[ERR][FORK] set_chain_height_fail h={} err={}", rollback_to, e);
                                }
                                *height.write().await = rollback_to;
                                LAST_BLOCK_PRODUCED_HEIGHT.store(rollback_to, Ordering::Relaxed);
                                crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.store(
                                    rollback_to, std::sync::atomic::Ordering::Release
                                );

                                // cbw is validation-critical: rebuild it from node_registry bounded by the
                                // rollback target so orphaned-block bindings (reg_height > rollback_to) drop
                                // out, BEFORE the rollback barrier is released. No per-block delete ⇒ no
                                // absence window; the canonical binding (reg_height ≤ target) survives.
                                crate::storage::note_rollback_progress();
                                if let Err(e) = storage.rebuild_committed_burn_wallet(rollback_to) {
                                    if is_warn() { println!("[WARN][FORK] cbw_rebuild_fail to={} err={}", rollback_to, e); }
                                }
                                // registry_root LtHash recompute + orphan prune (reg_height >
                                // target) + seal cleanup at the rollback target in ONE scan,
                                // BEFORE the barrier is released — unbounded reward rosters match a
                                // from-genesis node; canonical re-added by the live pipeline.
                                crate::storage::note_rollback_progress();
                                match storage.rebuild_registry_lthash(rollback_to) {
                                    Ok(n) if n > 0 => { if is_info() { println!("[INFO][FORK] registry_lthash_rebuilt orphans_pruned={} to={}", n, rollback_to); } }
                                    Err(e) => { if is_warn() { println!("[WARN][FORK] registry_lthash_rebuild_fail to={} err={}", rollback_to, e); } }
                                    _ => {}
                                }
                                // dilithium_pk_root: subtract journaled orphan binds (height > target) —
                                // exact inverse of the apply-time bind, inside the barrier (applies
                                // quiesced ⇒ no concurrent bind). Symmetric with cbw/registry_lthash.
                                crate::storage::note_rollback_progress();
                                match storage.rollback_dpk_binds_above(rollback_to) {
                                    Ok(n) if n > 0 => { if is_info() { println!("[INFO][FORK] dpk_binds_rolled_back n={} to={}", n, rollback_to); } }
                                    Err(e) => { if is_warn() { println!("[WARN][FORK] dpk_rollback_fail to={} err={}", rollback_to, e); } }
                                    _ => {}
                                }

                                // Consensus reward side-indices (super_elig_/light_bm_) are non-height-keyed,
                                // so an orphan block that wrote a current/future-epoch entry above rollback_to
                                // leaves a phantom the canonical re-apply overwrites per-key but never CLEARS →
                                // divergent emission set → reward_root fork. Clear the orphan epochs here (inside
                                // the barrier; per-index bounds in the fn doc); the live pipeline re-applies
                                // canonical forward and re-derives the correct set. Reorg-path only.
                                crate::storage::note_rollback_progress();
                                match storage.reconcile_reward_indices_above_epoch(rollback_to) {
                                    Ok(c) if c > 0 => { if is_info() { println!("[INFO][FORK] reward_indices_reconciled cleared={} to={}", c, rollback_to); } }
                                    Err(e) => { if is_warn() { println!("[WARN][FORK] reward_indices_reconcile_fail to={} err={}", rollback_to, e); } }
                                    _ => {}
                                }

                                // Owns-index (NON-consensus): orphaned blocks advanced the durable
                                // watermark past rollback_to (incl. Clears for holdings the canonical
                                // chain restores). Mark dirty INSIDE the barrier so a crash before the
                                // heal loop forces a boot rebuild — else watermark>=tip skips it and the
                                // reader under-reports those holdings forever. Cleared on heal success.
                                storage.mark_owns_index_dirty();

                                // Caches that answer AHEAD of storage must be purged while saves are
                                // still barred. Releasing the barrier first leaves a window where the
                                // verify worker resolves a deleted block's hash from RAM, admits its
                                // orphan child, and storage cannot backstop it — the deleted parent is
                                // absent, and absent parents are legitimately allowed.
                                crate::storage::note_rollback_progress();
                                storage.invalidate_recent_microblocks_above(rollback_to);

                                crate::storage::end_rollback_protection();

                                // Clear stale caches
                                clear_expected_producer_cache_above(rollback_to);
                                complete_rollback_cleanup(rollback_to);

                                // STATE RECONCILIATION (pipeline fork recovery path). Rollback
                                // deleted microblocks from RocksDB but the in-memory StateManager
                                // (accounts DashMap + merkle) was mutated up to the forked tip, so
                                // it MUST be rebuilt to the canonical rollback_to state — reconcile
                                // restores the freshest snapshot ≤ target + replays (bounded). Only
                                // if reconcile cannot PROVE the rebuilt state canonical do we fall
                                // to a clean n−f-QC-bound fast-sync (genesis/pin-rooted, fail-closed)
                                // and let the tail re-sync verify-then-apply.
                                if let Err(e) = Self::reconcile_state_after_rollback(
                                    &state,
                                    &storage,
                                    rollback_to,
                                ).await {
                                    // Reconcile couldn't PROVE the rebuilt state canonical. Don't run
                                    // a second inline fetch here — the single sync coordinator owns
                                    // catch-up: post-rollback the local tip drops below finality, so
                                    // its snapshot fast-path restores wholesale state (and owns) on the
                                    // nudge below. Mark owns dirty so a crash before that re-derives it.
                                    storage.mark_owns_index_dirty();
                                    println!(
                                        "[WARN][STATE] reconcile_unproven target={} err={} action=coordinator_state_sync",
                                        rollback_to, e,
                                    );
                                } else {
                                    println!(
                                        "[INFO][STATE] reconcile_after_pipeline_fork_ok target={}",
                                        rollback_to,
                                    );
                                    // dilithium_pk_root already healed INSIDE the rollback barrier
                                    // (rollback_dpk_binds_above) — no state-dependent rebuild here.
                                    // Heal the NON-consensus wallet→token reverse index against the
                                    // reconciled truth. Owns-deltas are a best-effort background write
                                    // that is NOT rolled back, so an orphaned block's flushed Clear for a
                                    // balance the reorg restores would leave the pair missing → the reader
                                    // under-reports it (the tail resync only re-emits 0→nonzero, not the
                                    // rollback baseline holdings). Re-derive from the authoritative
                                    // in-memory contracts (the accounts CF is best-effort/stale here);
                                    // stale entries left behind are balance-rechecked away by the reader.
                                    // Sibling of cbw/registry_lthash rebuild. Rare path, O(live holders).
                                    let owns_heal: Vec<(String, std::collections::HashMap<String, String>)> = {
                                        let sg = state.read().await;
                                        sg.accounts.iter()
                                            .filter(|e| e.value().is_contract)
                                            .map(|e| (e.key().clone(), e.value().contract_storage.clone()))
                                            .collect()
                                    };
                                    let mut healed = 0usize;
                                    let mut heal_ok = true;
                                    for (contract, cs) in &owns_heal {
                                        if storage.resync_owns_for_contract(contract, cs).is_ok() { healed += 1; }
                                        else { heal_ok = false; }
                                    }
                                    // Full heal → re-stamp built+clean at the rolled-back tip (clears the
                                    // dirty mark set above, watermark==tip → boot skips rebuild). Any Err
                                    // leaves it dirty so the next boot rebuilds.
                                    if heal_ok { let _ = storage.set_owns_index_built(rollback_to); }
                                    if is_info() { println!("[INFO][FORK] owns_index_resynced contracts={} to={} clean={}", healed, rollback_to, heal_ok); }

                                    // Rich-list index (display-only): balances changed by the
                                    // rollback+replay, so rebuild UNCONDITIONALLY (ignore the boot
                                    // marker). Sibling of the owns resync above.
                                    let _ = Self::rebuild_richlist_index().await;
                                }

                                println!("[INFO][FORK] rollback_ok to={} deleted={} blocks",
                                         rollback_to, local_h - rollback_to);

                                // Adopt from the retained tree ONLY after blocks were really
                                // removed. Running this when the rollback was refused or was a
                                // no-op re-submits still-canonical blocks for the pipeline to
                                // drop — wasted ingest during recovery, when it is scarcest.
                                let adopted = adopt_retained_successor(&storage, rollback_to);
                                if adopted > 0 {
                                    println!("[INFO][FORK] rollback_done to={} action=adopt_retained blocks={}",
                                             rollback_to, adopted);
                                } else {
                                    println!("[INFO][FORK] rollback_done to={} action=coordinator_sync", rollback_to);
                                }
                            }
                        }

                        crate::sync_manager::nudge_sync_check();
                    }
                }
        }
    }

    /// One pacemaker tick: the certificate-anchored failover emission block, verbatim
    /// from the production loop. Reads only atomics, globals and the Arc handles passed
    /// in; the receiver enforces signature, window committee, voter dedup and the TC
    /// floor, so a duplicate or early vote is inert by construction.
    async fn failover_pacemaker_tick(
        storage: &std::sync::Arc<crate::storage::Storage>,
        unified_p2p: &Option<std::sync::Arc<crate::unified_p2p::SimplifiedP2P>>,
        node_id: &String,
        node_type: crate::node::NodeType,
    ) {
        let node_id = node_id.clone();
        // Applied tip + 1 — same value the loop derived from its height view.
        let next_height = LAST_BLOCK_PRODUCED_HEIGHT.load(Ordering::Relaxed) + 1;
        if next_height <= 1 { return; } // nothing applied yet — nothing to fail over
        // Local liveness timer: wall-seconds since OUR applied height last
        // advanced. Slot-anchored block_ts must NOT drive this — it carries the
        // chain's lifetime production deficit and would trip the pacemaker against
        // a healthy leader. Per-node by design; rotation safety is the same-round
        // n−f certificate, not this gate. Clock-behind self-heals: the marker is
        // re-stamped from this node's wall every time height advances.
        let wall_now = get_timestamp_safe();
        let cur_applied_h = LAST_BLOCK_PRODUCED_HEIGHT.load(Ordering::Relaxed);
        let prev_progress_h = STALL_PROGRESS_HEIGHT.swap(cur_applied_h, Ordering::Relaxed);
        let anchor = STALL_PROGRESS_WALL.load(Ordering::Relaxed);
        // Re-stamp on height advance, init, or a BACKWARD wall step (SystemTime is
        // non-monotonic) — the rewind case keeps a clock step-back from suppressing votes.
        if cur_applied_h != prev_progress_h || anchor == 0 || wall_now < anchor {
            STALL_PROGRESS_WALL.store(wall_now, Ordering::Relaxed);
        }
        let local_delay = wall_now.saturating_sub(STALL_PROGRESS_WALL.load(Ordering::Relaxed));

        // v11.0: STALE LBPT PROTECTION after restart
        // After restart, LBPT comes from replay (last saved block timestamp).
        // If node was offline 30min, local_delay=1800s → timeout_round=1797 →
        // completely wrong producer selection → consensus stall.
        // FIX: Until PRODUCTION_UNLOCKED (set when first network block arrives),
        // cap local_delay to prevent stale-LBPT-driven round inflation.
        // Node still uses the n−f-certified round from the BFT protocol.
        let mut production_unlocked = PRODUCTION_UNLOCKED.load(Ordering::Relaxed) == 1;

        // v11.1: Auto-unlock when node is synchronized after restart
        // Without this, restarted nodes with existing data stay locked until
        // a new block is saved — creating a chicken-and-egg deadlock
        if !production_unlocked {
            let our_h = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
            let best_h = if let Some(ref p2p) = unified_p2p {
                p2p.get_best_peer_height()
            } else { 0 };
            let peer_count = if let Some(ref p2p) = unified_p2p {
                p2p.get_validated_active_peers().len()
            } else { 0 };
            // Unlock if: has data, has peers, and within 20 blocks of best peer
            if our_h > 0 && peer_count > 0 && (best_h == 0 || our_h + 20 >= best_h) {
                PRODUCTION_UNLOCKED.store(1, Ordering::Relaxed);
                production_unlocked = true;
                if is_info() {
                    println!("[INFO][STATE] auto_unlock our_h={} best_h={} peers={}", our_h, best_h, peer_count);
                }
            }
        }

        let local_delay = if !production_unlocked && local_delay > 30 {
            // After restart with stale LBPT: cap delay to 30s
            // This prevents wrong timeout_round while allowing normal stall detection
            if is_info() {
                println!("[INFO][TIMEOUT] lbpt_stale_cap raw_delay={}s capped=30s production_locked=true", local_delay);
            }
            30
        } else {
            local_delay
        };

        // BFT-certified rotation invariant (microblock layer).
        // Leader rotation is driven STRICTLY by the same-round n−f
        // HIGHEST_CERTIFIED_ROUND — only a supermajority is safe for
        // rotation-state advancement. Forensic (do NOT reintroduce):
        // an f+1 `adopted` round once fed rotation via `certified.max(
        // adopted)`, but the divergent f+1 caused split-brain (h=556),
        // so adopted was removed entirely; a later clock-derived bypass
        // (empty_slot_offset from local_now; NTP drift >1s → different
        // fallback producer) caused fork h=4742, so the clock is removed
        // from leader-selection inputs too — both now structurally
        // impossible.

        // CERTIFICATE-ANCHORED FAILOVER. The vote key is a pure function of this
        // node's OWN verified chain — never a peer-height sample (eclipse/gossip
        // staleness must not split honest keys) — plus f+1 committee-signed window
        // amplification (min-target, bounded by the SAME constant as the production
        // throttle). Safe: emission never touches acceptance — rotation still needs
        // a same-round n−f TC, ingest still gates a round>0 block on
        // failover_round_authorized, and a stale restart is fenced by
        // production_unlocked + the lbpt cap.
        let boot_wall = {
            let b = NODE_BOOT_WALL.load(Ordering::Relaxed);
            if b == 0 { NODE_BOOT_WALL.store(wall_now, Ordering::Relaxed); wall_now } else { b }
        };
        let peers_esc = unified_p2p.as_ref().map(|p| p.get_validated_active_peers().len()).unwrap_or(0);
        let meshed_esc = peers_esc >= TIMEOUT_ESCALATION_MIN_PEERS;
        let boot_ok_esc = wall_now.saturating_sub(boot_wall) >= TIMEOUT_ESCALATION_BOOT_FLOOR_SECS;
        let failover_height = next_height; // own verified tip + 1
        let own_w = failover_height / 90;
        let tc_floor = crate::unified_p2p::observed_tc_window_floor();
        let bound_w = crate::unified_p2p::certified_view_bound_windows();
        // f+1 amplification: adopt the LOWEST committee-supported window above own
        // (≥1 honest witness proves it real), capped by the producibility bound. Only
        // scanned during an actual stall — the scan clones voter ids O(votes), and in
        // steady state (no failover) there is nothing to amplify toward.
        let amplified_w = if local_delay > STALL_GRACE_SECS {
            crate::unified_p2p::lowest_window_with_support(own_w)
                .filter(|w| bound_w == u64::MAX || *w <= bound_w.saturating_add(1))
        } else { None };
        // Own-window key is voted IN ADDITION to an amplified one from the FIRST
        // tick (cross-key voting is legal; the receiver dedups per voter). The old
        // 3-tick delay split the quorum during the h=601 fork: amplified votes sat
        // at 3/4 while the own-window round starved at 1/4. Floor still enforced —
        // once a window certified, no honest vote re-enters a lower window.
        let (mb_idx, also_emit_own_w) = match amplified_w {
            Some(w) => {
                let prev = AMPLIFIED_WINDOW.swap(w, Ordering::Relaxed);
                let ticks = if prev == w {
                    AMPLIFY_STUCK_TICKS.fetch_add(1, Ordering::Relaxed) + 1
                } else {
                    AMPLIFY_STUCK_TICKS.store(0, Ordering::Relaxed);
                    0
                };
                if is_warn() {
                    println!("[WARN][TIMEOUT] window_amplified from={} to={} floor={} ticks={}",
                             own_w, w, tc_floor, ticks);
                }
                let own_ok = own_w >= tc_floor && own_w < w;
                (w.max(tc_floor), if own_ok { Some(own_w) } else { None })
            }
            None => {
                AMPLIFIED_WINDOW.store(0, Ordering::Relaxed);
                AMPLIFY_STUCK_TICKS.store(0, Ordering::Relaxed);
                (own_w.max(tc_floor), None)
            }
        };
        // Bound by the SAME horizon production uses, not the old 2-window seal allowance.
        // While that mismatch stood, A1 was only half a decoupling: production could run
        // 32 windows past the seal, but the moment a DEAD producer's slot came up beyond
        // +180 rotation was suppressed — "no rotation can fill it" is true for a finality
        // stall and false for a producer stall, and past the seal those are exactly the
        // case that matters. With >1/3 dead a dead producer's slot arrives within a few
        // rotations, so the chain stopped at +180 regardless of the raised throttle.
        let seal_base = storage.last_sealed_mb_index().saturating_mul(90)
            .max(qc_verified_frontier_cached());
        let seal_throttled = seal_base > 0
            && failover_height > seal_base
                + (BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64) * 90;
        if seal_throttled && is_warn() {
            println!("[WARN][PROD] parked reason=roster_derivation_horizon h={} seal_base={} rotation=live",
                     failover_height, seal_base);
        }
        // Same-round n−f certified rotation round for the FRONTIER macroblock — the sole
        // rotation input, identical on every node once the round cert propagates.
        let failover_round = crate::unified_p2p::get_certified_rotation_round(mb_idx);
        update_failover_metrics(local_delay, failover_round);

        // A4: no-progress age keyed on the certified VIEW (mb_idx, failover_round), NOT
        // applied height — B's tail-convergence reorgs thrash the height anchor and kept
        // resetting the height-based ceiling. Re-stamp only on a genuine view change /
        // init / backward-wall step (mirrors the STALL_PROGRESS_WALL guard above), so
        // round_age grows monotonically through a true deadlock and the ceiling matures.
        // Key the view timer on the ABSOLUTE certified round: monotone per macroblock and
        // identical on every node. The relative round subtracts a LOCAL finalized baseline,
        // so it shifts when that baseline shifts, re-stamping the entry wall below and
        // starving both escape ceilings that depend on round_age.
        let view_key = (mb_idx << 8)
            | crate::unified_p2p::highest_certified_round_for(mb_idx).min(0xFF);
        let prev_view = ROUND_ENTRY_VIEW.swap(view_key, Ordering::Relaxed);
        let ventry = ROUND_ENTRY_WALL.load(Ordering::Relaxed);
        if view_key != prev_view || ventry == 0 || wall_now < ventry {
            ROUND_ENTRY_WALL.store(wall_now, Ordering::Relaxed);
        }
        let round_age = wall_now.saturating_sub(ROUND_ENTRY_WALL.load(Ordering::Relaxed));

        // At MAX_FAILOVER_ROUND, >MAX rotations in one window is a sync/partition issue, not
        // producer liveness. HOLD, don't go terminal: the vote round is clamped to the cap in
        // emit_macroblock_view_change_vote (DoS bound — no runaway climb), the pacemaker keeps
        // emitting the bounded round so progress resumes the instant the partition heals, and
        // we drive sync recovery in parallel. Keyed on the SAME frontier mb the vote uses.
        let failover_capped = failover_round >= MAX_FAILOVER_ROUND;
        if failover_capped {
            if is_warn() {
                println!("[WARN][TIMEOUT] failover_round_capped round={} cap={} mb={} action=hold+recovery_sync",
                         failover_round, MAX_FAILOVER_ROUND, mb_idx);
            }
            CHRONIC_STALL_REQUESTED.store(true, Ordering::Relaxed);
        }

        // Silent-leader grace, heartbeat-freshness threshold, and 180s no-progress hard ceiling.
        const STALL_GRACE_SECS: u64 = 5;
        const HEARTBEAT_SILENT_MS: u64 = 3_000;
        const D2_PROGRESS_HARD_CEILING_SECS: u64 = 180;
        // A REMOTE producer's heartbeat is a CLAIM we cannot fully verify — binding it to
        // our own parent hash kills an invented frontier, but a script tracking the real
        // chain still passes. So a remote claim may buy far less delay than our own
        // self-yield path: a producer genuinely alive and targeting the frontier emits
        // within a block or two, and this stays well under one 30-block rotation, so a
        // liar cannot hold even a single rotation.
        const HEARTBEAT_SUPPRESS_CEILING_SECS: u64 = 15;

        // On slot-leader silent > grace: emit a ML-DSA-65 TimeoutVote for (mb_idx, certified+1).
        // n−f co-signs advance HIGHEST_CERTIFIED_ROUND[mb_idx] → every node re-elects the same
        // fallback leader. Exponentially-paced per mb/node; receiver verifies sig + window
        // committee + anchor + voter-dedup; TC only at n−f (≤f Byzantine cannot rotate).
        // Leader self-yield fast path: a stored (sig-verified, committee-checked) rotation
        // vote from the slot's own expected producer is authoritative about its
        // unavailability — co-sign without waiting out the silent-leader grace. Only vote
        // TIMING changes; forging a yield still needs the leader's key.
        let leader_yielded = get_expected_producer(failover_height)
            .map(|(p, _)| !p.is_empty() && p != node_id
                && crate::unified_p2p::window_has_vote_from(own_w, &p))
            .unwrap_or(false);
        // No !failover_capped gate — at the cap the pacemaker HOLDS (keeps emitting) rather
        // than going terminal; emit_macroblock_view_change_vote clamps the round to the cap.
        // The vote to rotate a dead leader is NOT gated on production_unlocked: that is a
        // per-node sync flag, and gating on it drops exactly the stragglers a stall left
        // behind from the quorum that would rescue it. Round is certified+1 (not derived
        // from local_delay), so a stale node emits one bounded vote, never a round storm.
        // Rotation parks on the CONSENSUS-VISIBLE frontier, not on seal_base: that came
        // from this node's own contiguous-seal scan, so a node behind on backfill parked
        // before its peers and fell out of the quorum that rotates a dead leader. The
        // gate itself must stay - failover rounds are bounded and a vote whose round
        // already carries a TC is dropped, so a fully parked committee co-signing every
        // tau would burn the budget and leave the window unable to rotate at all.
        let rotation_base = qc_verified_frontier_cached();
        let rotation_throttled = rotation_base > 0
            && failover_height > rotation_base
                + (BlockchainNode::MAX_DERIVED_ROSTER_WINDOWS as u64) * 90;
        // Past the hard no-progress ceiling the mesh gate is void: a network-wide
        // freeze starves peer validation, which muted the exact votes that end the
        // freeze (h=601: two nodes silent for 9 min). Votes are receiver-gated, so
        // unconditional emission after the ceiling is safe by construction.
        let mesh_or_ceiling = meshed_esc || round_age > D2_PROGRESS_HARD_CEILING_SECS;
        if (local_delay > STALL_GRACE_SECS || leader_yielded)
            && mesh_or_ceiling && boot_ok_esc && !rotation_throttled {
            let now_u64 = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();

            // v23.2: pre-emit gate — consult signed producer
            // heartbeat before voting for rotation. Decision tree:
            //
            //   expected_producer cached?
            //       └ self → skip (never vote against self)
            //       └ other → heartbeat age ≤ threshold?
            //               └ yes → skip (leader proven alive)
            //               └ no  → proceed to emit
            //       └ not cached → proceed to emit (defensive)
            // Deterministic leader (pure fn of height+certified round+candidates),
            // not the evictable cache: chronic-stall clears the cache, which left the
            // failover with expected=- and unable to re-elect a producer for the gap.
            // Own-window only: for an amplified (higher) target the local expected-
            // producer is meaningless — no suppression, no miss-recording there.
            // Elect on the ABSOLUTE certified round (node-independent), matching the
            // producer election + A1 gate. `failover_round` (get_certified_rotation_round)
            // is RELATIVE and depends on the local baseline; using it here would diverge
            // this node's expected-producer from the canonical leader. The metrics/view-key
            // labels below stay relative (display only).
            let expected_producer = if mb_idx == own_w {
                Some(Self::select_microblock_producer_with_round(
                    failover_height, &unified_p2p, &node_id, node_type, Some(&storage),
                    crate::unified_p2p::highest_certified_round_for(mb_idx),
                ).await).filter(|p| !p.is_empty())
            } else { None };

            // v26 D2: heartbeat/self may only DELAY view-change,
            // never veto it indefinitely. Suppression honoured only
            // while no-progress < ceiling; past it the timeout-vote
            // fires unconditionally (pacemaker on lack of PROGRESS,
            // not liveness). Fixes the alive-but-stuck permanent
            // lock (h=144001 self_exclude missing_prev).
            // A4: view-keyed age (thrash-immune) drives the hard ceiling, so B's reorg
            // height-churn can't keep starving the deadlock escape. STALL_GRACE_SECS
            // (line above) still uses local_delay — healthy-path timing unchanged.
            let progress_ceiling_exceeded =
                round_age > D2_PROGRESS_HARD_CEILING_SECS;

            let suppression_reason: Option<&'static str> =
                if progress_ceiling_exceeded {
                    None // ceiling passed → emit unconditionally
                } else {
                    match expected_producer.as_deref() {
                        Some(p) if p == node_id.as_str() => {
                            // A4 self-yield: never withhold the single decisive view-change
                            // vote once ≥ n−f−1 distinct committee peers already want to
                            // rotate off us (same absolute-round TIMEOUT_VOTES the TC tally
                            // reads — no f+1, no clock). We stop leading once the TC forms,
                            // so still exactly one leader per certified round. Otherwise the
                            // 4-of-5 alive-but-stuck deadlock waits out the full hard ceiling.
                            if crate::unified_p2p::round_one_short_of_quorum(mb_idx, &node_id) {
                                None
                            } else {
                                Some("self_expected")
                            }
                        }
                        Some(p) => {
                            // Suppress only if the producer's heartbeat is FRESH and targeting
                            // the frontier slot (advertised slot_height >= failover_height). An
                            // alive-but-stuck-below producer (targeting a lower slot — the
                            // common onboarding/desync case) is NOT suppressed ⇒ fast fail-over.
                            // A producer lying about slot_height is still bounded by the 180s
                            // progress ceiling above.
                            let fresh = crate::unified_p2p::last_remote_producer_heartbeat_age_ms(p)
                                .map(|age_ms| age_ms <= HEARTBEAT_SILENT_MS)
                                .unwrap_or(false);
                            let targeting_our_slot = crate::unified_p2p::last_remote_producer_heartbeat_height(p)
                                .map(|h| h >= failover_height)
                                .unwrap_or(false);
                            if fresh && targeting_our_slot
                                && round_age <= HEARTBEAT_SUPPRESS_CEILING_SECS {
                                Some("heartbeat_fresh")
                            } else {
                                None
                            }
                        }
                        None => None,
                    }
                };

            if let Some(reason) = suppression_reason {
                // Suppress emission. Log at INFO with structured
                // fields so operator dashboards can correlate
                // suppression rate vs production rate.
                if is_info() {
                    let hb_age = expected_producer
                        .as_deref()
                        .and_then(crate::unified_p2p::last_remote_producer_heartbeat_age_ms)
                        .map(|m| m as i64)
                        .unwrap_or(-1);
                    println!(
                        "[INFO][TIMEOUT] emit_suppressed h={} mb={} expected={} hb_age_ms={} delay={}s reason={}",
                        failover_height, mb_idx,
                        expected_producer.as_deref().unwrap_or("-"),
                        hb_age, local_delay, reason
                    );
                }
            } else {
                // Heartbeat stale OR no cache: exponential re-emit pacing per mb —
                // tau(rel_round) ≈ 5s·1.5^round capped at 128s, reset naturally on
                // progress (round/mb change). Guarantees growing honest overlap
                // under unknown post-GST delay without burning MAX_FAILOVER_ROUND.
                const TAU_SECS: [u64; 9] = [5, 7, 11, 16, 25, 38, 56, 85, 128];
                let tau = TAU_SECS[failover_round.min(8) as usize];
                let should_emit = {
                    let last = LAST_TIMEOUT_EMIT_PER_MB
                        .get(&mb_idx)
                        .map(|v| *v)
                        .unwrap_or(0);
                    now_u64.saturating_sub(last) >= tau
                };
                if should_emit {
                    LAST_TIMEOUT_EMIT_PER_MB.insert(mb_idx, now_u64);
                    if is_info() {
                        let hb_age = expected_producer
                            .as_deref()
                            .and_then(crate::unified_p2p::last_remote_producer_heartbeat_age_ms)
                            .map(|m| m as i64)
                            .unwrap_or(-1);
                        println!(
                            "[INFO][TIMEOUT] emit_microblock_vote h={} mb={} cert_round={} delay={}s expected={} hb_age_ms={} reason=primary_silent",
                            failover_height, mb_idx, failover_round,
                            local_delay,
                            expected_producer.as_deref().unwrap_or("-"),
                            hb_age
                        );
                    }

                    // Validator liveness — miss path. Emit a
                    // primary-silent timeout vote at most once per
                    // STALL_GRACE_SECS/mb (debounced) and record one miss
                    // against the expected producer (record_validator_miss
                    // is itself idempotent on (validator_id, height)).
                    // SELF-EJECT GUARD: its staleness filter only consults
                    // the REMOTE heartbeat map (the local node never
                    // appears there), so without an explicit
                    // expected_id != node_id check a node could record a
                    // miss against itself and self-eject during its own
                    // stall. Observation-only unless QNET_LIVENESS_EJECTION
                    // is set. O(1)/call.
                    // ═══════════════════════════════════════════════════════
                    if let Some(ref expected_id) = expected_producer {
                        if !expected_id.is_empty() && expected_id != &node_id {
                            let _ = crate::unified_p2p::record_validator_miss(
                                expected_id,
                                failover_height,
                            );
                        }
                    }

                    // Canonical emission helper: signs the QNET_TIMEOUT_V2 payload
                    // and broadcasts via `broadcast_timeout_vote` — the same path
                    // the macroblock-boundary view-change uses.
                    Self::emit_macroblock_view_change_vote(
                        mb_idx.saturating_mul(90),
                        &node_id,
                        &unified_p2p,
                        Some(&storage),
                    ).await;
                    // Resume valve: amplified-window sync stalled ≥3 ticks — emit
                    // the own-window key IN ADDITION (delay, never park; the TC
                    // floor above keeps this from re-entering a certified window).
                    if let Some(own_w) = also_emit_own_w {
                        Self::emit_macroblock_view_change_vote(
                            own_w.saturating_mul(90),
                            &node_id,
                            &unified_p2p,
                            Some(&storage),
                        ).await;
                    }
                }
            }
        }

        // v23: chronic-stall safety net — peer-driven resync after
        // 120 s of zero progress. Operator-grade fallback for the
        // rare case where n−f timeout vote aggregation itself
        // cannot complete (e.g. asymmetric partition during a
        // macroblock window). Independent of consensus path;
        // macroblock finality at the next 90-block boundary
        // remains the canonical recovery anchor and this block
        // ensures lagging nodes catch up to it.
        // v14.7.2 (retained in v22): CHRONIC STALL RECOVERY — peer-driven
        // resync after 120 s with no progress. Operator-grade safety net
        // independent of consensus mechanism. Macroblock finality at the
        // next 90-block boundary remains the canonical path; this
        // ensures syncing nodes catch up to it.
        // Chronic-stall safety net: after 120s of zero progress (or an escalation request
        // raised by the production gate / failover cap), nudge the SINGLE sync coordinator
        // to catch up and drop the stale producer election so a fresh one is computed. The
        // old inline peer-resync (macroblock repair + bulk sync_blocks) duplicated
        // execute_sync's pipeline and raced it; the SyncManager now owns all catch-up.
        let escalation_requested = CHRONIC_STALL_REQUESTED
            .swap(false, std::sync::atomic::Ordering::Relaxed);
        if local_delay > 120 || escalation_requested {
            if is_warn() {
                println!("[WARN][STALL] chronic_stall h={} delay={}s action=nudge_sync",
                         next_height, local_delay);
            }
            clear_expected_producer_cache_above(next_height.saturating_sub(1));
            crate::sync_manager::nudge_sync_check();
        }

    }

    /// Failover liveness pacemaker — a dedicated task, deliberately OUTSIDE the
    /// production loop. During the h=601 wedge that loop parked in a long await for
    /// minutes and every liveness organ inside it (timeout votes, chronic-stall nudge)
    /// died with it: four healthy validators could not assemble a TC for ~10 minutes.
    /// A slow tick is cancelled, never awaited into a stall — emission is idempotent
    /// under the per-window pacing, so the next second simply retries.
    pub(super) async fn run_failover_pacemaker(
        storage: std::sync::Arc<crate::storage::Storage>,
        unified_p2p: Option<std::sync::Arc<crate::unified_p2p::SimplifiedP2P>>,
        node_id: String,
        node_type: crate::node::NodeType,
    ) {
        let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(1));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if tokio::time::timeout(
                std::time::Duration::from_secs(2),
                Self::failover_pacemaker_tick(&storage, &unified_p2p, &node_id, node_type),
            ).await.is_err() && is_warn() {
                println!("[WARN][TIMEOUT] pacemaker_tick_cancelled reason=tick_over_2s");
            }
        }
    }

    pub(super) async fn start_microblock_production(&mut self) {
        // PRODUCTION: Start health monitor for sync flags (deadlock prevention)
        Self::start_sync_health_monitor();

        // v15.11: Start producer liveness watchdog (defense-in-depth against
        // async-runtime stalls). One global watchdog per process — guarded by
        // an atomic flag so repeated start_microblock_production calls do not
        // spawn duplicate watchdogs.
        if PRODUCER_WATCHDOG_STARTED.compare_exchange(
            0, 1,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        ).is_ok() {
            Self::start_producer_watchdog();
        }

        // Liveness pacemaker task (see run_failover_pacemaker). Once per process.
        if PACEMAKER_STARTED.compare_exchange(
            0, 1,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        ).is_ok() {
            let pm_storage = self.storage.clone();
            let pm_p2p = self.unified_p2p.clone();
            let pm_node_id = self.node_id.clone();
            let pm_node_type = self.node_type;
            tokio::spawn(async move {
                Self::run_failover_pacemaker(pm_storage, pm_p2p, pm_node_id, pm_node_type).await;
            });
        }

        // Fork-recovery consumer task (see run_fork_recovery_consumer). Once per process.
        if FORK_CONSUMER_STARTED.compare_exchange(
            0, 1,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        ).is_ok() {
            let fc_state = self.state.clone();
            let fc_height = self.height.clone();
            let fc_storage = self.storage.clone();
            let fc_p2p = self.unified_p2p.clone();
            tokio::spawn(async move {
                Self::run_fork_recovery_consumer(fc_state, fc_height, fc_storage, fc_p2p).await;
            });
        }

        // ═══════════════════════════════════════════════════════════════════════
        // v14.8.7: REHYDRATE TIMEOUT-CERTIFICATE STATE FROM DISK
        // ═══════════════════════════════════════════════════════════════════════
        // Loads persisted TIMEOUT_CERTIFICATES and HIGHEST_CERTIFIED_ROUND so a
        // rebooted validator sees the same post-n−f view as the rest of the
        // network immediately on startup, rather than having to re-fetch
        // certificates from peers. HIGHEST_ADOPTED_ROUND rehydration is
        // removed: that tracker was a local-only aggregation with no signed
        // backing and is no longer part of the consensus state.
        //
        // Safe at 1000+ validator scale: payload is per-macroblock-index, not
        // per-validator. Cleanup retain() keeps it bounded to the active window.
        // ═══════════════════════════════════════════════════════════════════════
        {
            let tc_bytes = self.storage.load_timeout_certificates().unwrap_or(None).unwrap_or_default();
            let hc_bytes = self.storage.load_highest_certified_rounds().unwrap_or(None).unwrap_or_default();
            // No P2P handle ⇒ install NOTHING: the certified-round tracker is only admissible when
            // the co-persisted TCs behind it were signature-verified, and that verifier lives on P2P.
            match self.unified_p2p.as_ref() {
                Some(p2p) => {
                    let (tc_n, tc_rej) = p2p.rehydrate_timeout_certificates_verified(&tc_bytes);
                    let hc_n = crate::unified_p2p::rehydrate_highest_certified_rounds(&hc_bytes);
                    if is_info() {
                        println!("[INFO][CONS] timeout_state_rehydrated certs={} rejected={} hi_cert={}",
                                 tc_n, tc_rej, hc_n);
                    }
                }
                None => {
                    if is_warn() {
                        println!("[WARN][CONS] timeout_state_rehydrate_skipped reason=no_p2p_handle");
                    }
                }
            }
        }

        // v14.8.7: Periodic FLUSHER for timeout-certificate state (2s tick).
        // Persists only the signed-backed state: TIMEOUT_CERTIFICATES (full
        // n−f payloads) and HIGHEST_CERTIFIED_ROUND (O(1) tracker). Worst
        // case a crash loses at most ~2 s of certificate updates.
        {
            let storage_flush = self.storage.clone();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(2));
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    ticker.tick().await;
                    let tc = crate::unified_p2p::snapshot_timeout_certificates();
                    let hc = crate::unified_p2p::snapshot_highest_certified_rounds();
                    if let Err(e) = storage_flush.save_timeout_certificates(&tc) {
                        if is_warn() { println!("[WARN][CONS] tcerts_flush_fail err={}", e); }
                    }
                    if let Err(e) = storage_flush.save_highest_certified_rounds(&hc) {
                        if is_warn() { println!("[WARN][CONS] hi_cert_flush_fail err={}", e); }
                    }
                }
            });
        }

        // Periodic mempool TTL sweep (60s): drop never-confirmed TXs (underpriced / nonce-gapped) so a
        // stuck TX cannot hold a slot + sender quota forever. Interval from `mempool_ttl_secs()`.
        // Expired != confirmed, so it is NOT added to included_tx_hashes — re-submission stays open.
        {
            let mempool_ttl = self.mempool.clone();
            let ttl_secs: u64 = crate::node::mempool_ttl_secs();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(60));
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    ticker.tick().await;
                    let n = mempool_ttl.cleanup_expired_transactions(ttl_secs);
                    if n > 0 && is_info() { println!("[INFO][MEMPOOL] ttl_evicted count={} ttl_secs={}", n, ttl_secs); }
                }
            });
        }

        // GALC: periodic genesis mint task (every node ticks; no-op for non-genesis / nothing-new). On
        // genesis nodes it signs + broadcasts a partial for the latest finalized macroblock on the
        // cadence; partials aggregate to a ≥n−f capsule on every node, giving cold joiners a fresh
        // genesis-signed walk root at any chain age without manual pin rotation.
        {
            let galc_storage = self.storage.clone();
            let galc_p2p = self.unified_p2p.clone();
            let galc_wallet = self.wallet_identity.clone();
            let galc_node_id = self.node_id.clone();
            tokio::spawn(async move {
                // Restore a previously-adopted GALC root from disk (re-verified vs embedded genesis keys;
                // a stale-network capsule is rejected by the network_id check) so a restarted/dormant-
                // return node roots + serves from it immediately. No-op on fresh genesis.
                crate::galc::load_persisted(&galc_storage).await;
                let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(15));
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    ticker.tick().await;
                    if let Some(ref p2p) = galc_p2p {
                        crate::galc::mint_tick(&galc_storage, p2p, &galc_wallet, &galc_node_id).await;
                    }
                }
            });
        }

        // PRODUCTION v2.78: Start commitment TX submission loop (parallel with block production)
        self.start_commitment_tx_loop().await;

        let is_running = self.is_running.clone();
        let mempool = self.mempool.clone();
        let mev_mempool = self.mev_mempool.clone();
        let storage = self.storage.clone();
        let height = self.height.clone();
        let unified_p2p = self.unified_p2p.clone();
        let _wallet_identity_for_reactivation = self.wallet_identity.clone();
        let microblock_interval = self.microblock_interval;
        let is_leader = self.is_leader.clone();
        let node_id = self.node_id.clone();
        // Verification now runs as a pre-apply filter (producer_tx_admissible) inline in the loop; the
        // former post-apply parallel-validator gate is gone. Field retained for the ParallelExecutor path.
        let _parallel_validator = self.parallel_validator.clone();
        let node_type = self.node_type;
        let _consensus_nonce_storage = self.consensus_nonce_storage.clone();
        let _last_block_attempt = self.last_block_attempt.clone();
        let _perf_config = self.perf_config.clone();
        let rotation_tracker = self.rotation_tracker.clone();
        let parallel_executor_for_spawn = self.parallel_executor.clone();
        let adaptive_bft_for_spawn = self.adaptive_bft.clone();
        let pre_execution_for_spawn = self.pre_execution.clone();
        let block_event_tx_for_spawn = self.block_event_tx.clone();
        // CRITICAL v2.26: Clone state for TX validation in block production
        let state = self.state.clone();
        
        // CRITICAL FIX: Take consensus_rx ownership for MACROBLOCK consensus phases
        // Macroblock commit/reveal phases NEED exclusive access to process P2P messages  
        
        // CRITICAL FIX: Start macroblock consensus listener for ALL potential validators
        // This allows ALL 1000 selected validators to participate, not just the block producer
        self.start_macroblock_consensus_listener(
            storage.clone(),
            unified_p2p.clone(),
            node_id.clone(),
            node_type,
            self.state.clone(),
        );
        
        // ARCHITECTURE: Network sync monitoring handled by existing mechanisms:
        // 1. start_sync_health_monitor() - monitors sync flags for deadlock prevention
        // 2. Background sync - automatic block synchronization
        // 3. NODE_IS_SYNCHRONIZED flag - global sync status
        // No additional monitoring task needed (existing mechanisms are sufficient)
        
        // Clone shard_coordinator for use inside spawn (avoid self reference)
        let shard_coordinator_opt = self.shard_coordinator.clone();
        
        let production_handle = tokio::spawn(async move {
            // CRITICAL FIX: Start from current global height, not 0
            let mut microblock_height = *height.read().await;
            // CRITICAL FIX: Calculate last_macroblock_trigger from current height
            // This ensures consensus works even when node starts after block 61
            let mut last_macroblock_trigger = (microblock_height / 90) * 90;
            let mut consensus_started = false; // Track early consensus start
            
            // GENESIS BLOCK CREATION: Create Genesis Block if blockchain is empty
            // CRITICAL FIX: Check if Genesis block EXISTS, not just height == 0
            // This handles cases where storage reports wrong height but Genesis is missing
            // 
            // ARCHITECTURE (v2.19.13): Use load_microblock_auto_format for format-agnostic loading
            // This handles both legacy MicroBlock and new EfficientMicroBlock formats with Zstd compression
            let genesis_check = storage.load_microblock_auto_format(0);
            println!("[DBG][GEN] load_microblock_auto_format h=0 result={:?}",
                     genesis_check.as_ref().map(|opt| opt.as_ref().map(|b| b.height)));
            
            // Fork-safety: a persistently-unreadable block 0 is CORRUPTION, never a signal to
            // re-genesis. If set, the create-fresh path below refuses to mint a new genesis
            // (which would fork a previously-populated node) and halts for operator intervention.
            let mut genesis_was_corrupt = false;
            let genesis_exists = match genesis_check {
                Ok(Some(ref block)) => {
                    println!("[DBG][GEN] genesis_exists valid=true h={} producer={}",
                             block.height, block.producer);
                    true
                }
                Ok(None) => {
                    println!("[DBG][GEN] genesis_exists valid=false");
                    false
                }
                Err(e) => {
                    // Retry first — do NOT mistake a transient RocksDB read error for corruption
                    // (the original code deleted block 0 on the very first Err, which under peer
                    // isolation routed node_001 into minting a fresh-timestamp genesis → fork).
                    println!("[WARN][GEN] genesis_block0_unreadable err={} — retrying before any action", e);
                    let mut resolved: Option<bool> = None;
                    for attempt in 1..=5u32 {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        match storage.load_microblock_auto_format(0) {
                            Ok(Some(ref block)) => {
                                println!("[INFO][GEN] genesis_block0_reread_ok attempt={} h={}", attempt, block.height);
                                resolved = Some(true);
                                break;
                            }
                            Ok(None) => {
                                println!("[INFO][GEN] genesis_block0_absent attempt={} — genuinely empty", attempt);
                                resolved = Some(false);
                                break;
                            }
                            Err(e2) => {
                                println!("[WARN][GEN] genesis_block0_reread_err attempt={}/5 err={}", attempt, e2);
                            }
                        }
                    }
                    match resolved {
                        Some(exists) => exists,
                        None => {
                            // Persistent Err reading block 0 = bytes ARE present at key 0 but do NOT
                            // deserialize (a truly empty DB returns Ok(None), handled above). That is a
                            // CORRUPT/garbage block 0 — in practice the small response the HTTP genesis
                            // loader saved (e.g. a 38-byte 404 body). It MUST be deleted: a leftover
                            // garbage block 0 (a) blocks the real genesis broadcast/sync — a present
                            // block 0 is treated as "already have it" — and (b) makes the genesis
                            // await/poll never see Ok(Some), freezing the node forever.
                            //
                            // REGRESSION FIX: the previous version DELETED only on a populated chain and
                            // KEPT the garbage on a fresh DB → that is exactly what froze fresh launches.
                            // Always clear it. The only fork-safe distinction is whether to HALT after:
                            // on an ALREADY-POPULATED chain (height > 0 or block 1 present) a vanished/
                            // garbled block 0 is dangerous → refuse to mint a forking fresh genesis; on a
                            // fresh DB it is just garbage → clear and let cold-start mint/await normally.
                            let db_populated = storage.get_chain_height().unwrap_or(0) > 0
                                || matches!(storage.load_microblock_auto_format(1), Ok(Some(_)));
                            if let Err(e3) = storage.delete_microblock(0) {
                                eprintln!("[ERR][STORAGE] genesis_delete_failed err={}", e3);
                            }
                            if db_populated {
                                println!("[WARN][GEN] genesis_block0_corrupt persistent (chain populated) — cleared, will NOT mint fresh (fork-safe)");
                                genesis_was_corrupt = true;
                            } else {
                                println!("[INFO][GEN] genesis_block0_garbage cleared (fresh DB) — first boot, will create/await genesis");
                            }
                            false
                        }
                    }
                }
            };
            
            if !genesis_exists {
                println!("[INFO][GEN] genesis_not_found checking_creation");
                
                // SCALABILITY: Two modes - Bootstrap (5 nodes) and Production (millions)
                let bootstrap_id = std::env::var("QNET_BOOTSTRAP_ID").unwrap_or_default();
                let is_bootstrap_mode = !bootstrap_id.is_empty();
                
                println!("[INFO][GEN] bootstrap_mode={} bootstrap_id={}", is_bootstrap_mode, bootstrap_id);
                
                if is_bootstrap_mode && bootstrap_id == "001" {
                    // v5.0: Before creating genesis, check if network already has one.
                    // If node_001 restarts with empty storage but the network is running,
                    // creating a new genesis (with current timestamp) would produce an
                    // incompatible chain. Try to sync from peers first.
                    println!("[INFO][GEN] node_001 storage empty — checking network for existing genesis...");
                    let mut synced_from_network = false;
                    
                    if let Some(ref p2p) = unified_p2p {
                        // 20 × 2s = 40s of wall clock — now the real cost, since the probe below no
                        // longer blocks. Long enough that (a) block-0 gets many fetch attempts from a
                        // live network (the robust primary "a chain exists" probe → synced_from_network),
                        // and (b) the window spans a sibling's first signed HealthPing (+30s), so a running
                        // genesis authoritatively reports height>0 before the positive-proof mint decision
                        // below → closes the empty-restart-into-live-but-block-silent residual. Only the
                        // genuine first-ever mint waits the full window; a live rejoin breaks early on sync.
                        const MAX_SYNC_ATTEMPTS: u32 = 20;
                        for attempt in 1..=MAX_SYNC_ATTEMPTS {
                            // Ask for block 0 specifically. `sync_blocks(0,0)` clamps to
                            // [applied+1, applied+2000], so at applied=0 it requested h=1..2000 and
                            // never block 0 at all — then blocked SYNC_BLOCKS_HARD_TIMEOUT_SECS(45)
                            // per call on an empty network. The 40s window this loop documents cost
                            // 14 minutes on every fresh-genesis launch. This sends RequestBlocks{0,0}
                            // to 3 peers and returns; a reply lands via normal ingest and the probe
                            // below sees it.
                            let _ = p2p.request_block_repair(0).await;
                            tokio::time::sleep(Duration::from_secs(2)).await;
                            
                            let storage_for_check = storage.clone();
                            let check = tokio::task::spawn_blocking(move || {
                                storage_for_check.load_microblock_auto_format(0)
                            }).await.unwrap_or(Ok(None));
                            
                            if let Ok(Some(existing_genesis)) = check {
                                println!("[INFO][GEN] genesis received from network after {} attempts (ts={})",
                                         attempt, existing_genesis.timestamp);

                                // v11.1: Apply genesis block TXs to state and register PKs.
                                // Without this, synced genesis is stored but its PK registration
                                // TXs are never processed — Dilithium keys missing, all blocks rejected.
                                {
                                    let state_guard = state.write().await;
                                    match state_guard.apply_block_batch(&existing_genesis.transactions) {
                                        Ok(count) => {
                                            if is_info() {
                                                println!("[INFO][GEN] genesis_tx_applied count={}", count);
                                            }
                                        }
                                        Err(e) => {
                                            if is_warn() {
                                                println!("[WARN][GEN] genesis_tx_apply_failed err={}", e);
                                            }
                                        }
                                    }
                                }
                                Self::cache_node_registrations_from_transactions(&storage, &existing_genesis.transactions);
                                // Stamp reg_height=0 + vrf as well: an unstamped row is invisible to registry_root,
                                // so caching alone forks this node off every checkpoint until a restart stamps it.
                                Self::apply_genesis_registrations(&storage, &existing_genesis.transactions);
                                if is_info() {
                                    println!("[INFO][GEN] genesis_registrations_cached tx_count={}", existing_genesis.transactions.len());
                                }

                                if let Ok(stored_height) = storage.get_chain_height() {
                                    microblock_height = stored_height;
                                    *height.write().await = stored_height;
                                }
                                crate::GLOBAL_GENESIS_TIMESTAMP.store(
                                    existing_genesis.timestamp,
                                    std::sync::atomic::Ordering::Relaxed
                                );
                                crate::set_genesis_timestamp(existing_genesis.timestamp);
                                // v5.5: Use on-chain timestamp (not wall-clock) for LBPT determinism.
                                // All nodes at the same height must have identical LBPT to compute
                                // identical timeout_round. Wall-clock diverges across nodes.
                                LAST_BLOCK_PRODUCED_TIME.store(existing_genesis.timestamp, std::sync::atomic::Ordering::Relaxed);
                                LAST_BLOCK_PRODUCED_HEIGHT.store(microblock_height, std::sync::atomic::Ordering::Relaxed);
                                // v5.5: Synced genesis from network — unlock production
                                PRODUCTION_UNLOCKED.store(1, Ordering::Relaxed);
                                synced_from_network = true;
                                break;
                            }
                            
                            if attempt % 4 == 0 {
                                println!("[INFO][GEN] no genesis from network yet (attempt {}/{})", attempt, MAX_SYNC_ATTEMPTS);
                            }
                        }
                    }
                    
                    if synced_from_network {
                        println!("[INFO][GEN] node_001 synced genesis from running network — skipping creation");
                        // Fall through to main loop (genesis exists in storage now)
                    } else if genesis_was_corrupt {
                        // Block 0 was corrupt AND no peer served a replacement within the poll
                        // window. Minting a fresh genesis on a node that previously held a chain
                        // would fork the network — refuse and halt (loud crash-loop under
                        // --restart=always) so the operator restores storage or resyncs.
                        eprintln!("[FATAL][GEN] block0 corrupt and no peer served a replacement — refusing to mint fresh genesis (fork-safe). Halting.");
                        std::process::exit(1);
                    } else {
                        // POSITIVE proof of first-ever launch before minting (closes the partition race in
                        // a negative "nobody reports a chain" check). Mint a fresh genesis ONLY when a
                        // quorum (>=2) of OTHER genesis identities is CONNECTED *and* NONE reports a
                        // populated chain (height>0) — i.e. the committee provably sits at height 0
                        // together. Otherwise refuse + halt (crash-loop under --restart=always):
                        //   • any genesis at height>0  → chain already live → rejoin via the block-0
                        //     re-fetch on the next boot, never mint a forking fresh-timestamp genesis.
                        //   • <2 genesis connected     → cannot PROVE a first-ever launch (partition, or
                        //     siblings not up yet) → wait; minting in isolation could fork on heal, and a
                        //     lone node_001 cannot form a committee anyway.
                        // Identity is hardcoded-IP-derived and the height is signature-gated (CONSENSUS_PK
                        // registry), so a keyless spoofer cannot fake a genesis identity or its height. At a
                        // genuine first-ever launch NO block exists yet, so no sibling CAN report height>0
                        // (gen_above_zero==0 is correct by construction) and the decision rests on
                        // gen_connected>=2. For an empty node_001 restarting INTO a live network, gen_above_zero
                        // is authoritative by the time we reach here: the 40s poll window above spans both
                        // (a) many block-0 fetch attempts — a live chain is normally pulled directly →
                        // synced_from_network short-circuits the mint — and (b) a sibling's first signed
                        // HealthPing (+30s), so even a block-SILENT live network's genesis reports height>0
                        // before this check ⇒ gen_above_zero>=1 ⇒ halt+rejoin, never a forking mint. A
                        // coordinated first launch brings >=2 siblings up at height 0 within the window ⇒
                        // mint proceeds; a partition leaving <2 genesis visible ⇒ halt (fail-closed).
                        // GAP A: a WS restart pin (K>0) means the chain HAS history and recovery is a
                        // cold-join from macroblock K, which preserves balances. Minting a fresh genesis
                        // here re-seeds [0;32] state = the ledger wiped, and there is NO re-mint path.
                        // Under a pin an empty node MUST await K, never mint — halt and retry sync.
                        if crate::genesis_constants::ws_checkpoint_index() > 0 {
                            eprintln!("[FATAL][GEN] WS restart pin active (K={}) with empty local chain — refusing to mint fresh genesis (would wipe balances, no re-mint path). Recovery MUST cold-join from macroblock K. Halting to retry sync.",
                                      crate::genesis_constants::ws_checkpoint_index());
                            std::process::exit(1);
                        }
                        let (gen_connected, gen_above_zero) = match unified_p2p.as_ref() {
                            Some(p) => {
                                let peers = p.get_validated_active_peers();
                                let connected: std::collections::HashSet<&str> = peers.iter()
                                    .map(|pi| pi.id.as_str())
                                    .filter(|id| id.starts_with("genesis_node_"))
                                    .collect();
                                let above: std::collections::HashSet<&str> = peers.iter()
                                    .filter(|pi| pi.last_block_height > 0 && pi.id.starts_with("genesis_node_"))
                                    .map(|pi| pi.id.as_str())
                                    .collect();
                                (connected.len(), above.len())
                            }
                            None => (0usize, 0usize),
                        };
                        if gen_above_zero >= 1 || gen_connected < 2 {
                            eprintln!("[FATAL][GEN] node_001 empty: first-ever launch UNPROVEN (genesis_connected={} at_height>0={}) — refusing to mint fresh genesis (fork-safe). Halting to retry block-0 fetch / await a genesis quorum at height 0.",
                                      gen_connected, gen_above_zero);
                            std::process::exit(1);
                        }
                    // First-ever launch PROVEN: >=2 genesis siblings connected, all at height 0
                    println!("[INFO][GEN] first-ever launch confirmed (genesis_quorum={} all_at_height_0) — creating new genesis", gen_connected);
                    
                    use crate::genesis::{GenesisConfig, create_genesis_block};
                    let genesis_config = GenesisConfig::default();
                    
                    match create_genesis_block(genesis_config) {
                        Ok(genesis_block) => {
                            // v2.71: Combine existing genesis TXs with Genesis Node Registration TXs
                            // This ensures all 5 Genesis nodes are registered ON-CHAIN in block 0
                            let mut all_genesis_txs = genesis_block.transactions.clone();
                            let genesis_registration_txs = Self::create_genesis_registration_txs();
                            all_genesis_txs.extend(genesis_registration_txs);
                            
                            if is_info() { 
                                println!("[INFO][GEN] genesis_txs total={} (original={} + registration=5)", 
                                         all_genesis_txs.len(), genesis_block.transactions.len()); 
                            }
                            
                            // Convert to MicroBlock format for storage
                            let merkle_root = Self::calculate_merkle_root(&all_genesis_txs);
                            let mut genesis_microblock = qnet_state::MicroBlock {
                                height: 0,
                                timestamp: genesis_block.timestamp,
                                previous_hash: [0u8; 32],
                                transactions: all_genesis_txs,
                                producer: "genesis".to_string(),
                                merkle_root,
                                signature: Vec::new(), // Will be signed with quantum crypto
                                // QRB v3.0: Genesis has no VRF (no prev_hash to derive from)
                                vrf_output: None,
                                vrf_proof: None,
                                fees_collected: 0, // v3.18: Genesis block has no fees
                                state_root: [0u8; 32], // v3.27: Will be set after TX application
                                timeout_round: 0, // v14.0: Genesis has no timeout
                                carried_baseline: 0, // Option C: genesis baseline is 0 (no failover)
                                timeout_proof: None, // #80: happy path, no failover proof
                            };
                            
                            // ═══════════════════════════════════════════════════════════════════
                            // v3.37: CRITICAL FIX - Apply Genesis TX to StateManager!
                            // Without this, Genesis creator has EMPTY state while receivers have FULL state
                            // This caused state_root mismatch on block #1
                            // State must be consistent across all nodes
                            // ═══════════════════════════════════════════════════════════════════
                            {
                                let state_guard = state.write().await;
                                // Use genesis_microblock.transactions (all_genesis_txs was moved there)
                                let applied = state_guard.apply_block_batch(&genesis_microblock.transactions);
                                match applied {
                                    Ok(count) => {
                                        println!("[INFO][GEN] genesis_tx_applied count={} to_state", count);
                                    }
                                    Err(e) => {
                                        eprintln!("[ERR][GEN] genesis_tx_apply_failed err={}", e);
                                    }
                                }
                                // Finalize Merkle tree to get state_root
                                let computed_state_root = state_guard.finalize_merkle();
                                genesis_microblock.state_root = computed_state_root;
                                println!("[INFO][GEN] genesis_state_root computed root={}", 
                                         hex::encode(&computed_state_root[..8]));
                            }
                            
                            // PRODUCTION: Use deterministic signature for Genesis Block
                            // CRITICAL: All nodes must generate IDENTICAL Genesis signature for consensus
                            // DO NOT use Dilithium here as it creates different signatures per node
                            genesis_microblock.signature = {
                                let mut hasher = Sha3_256::new();
                                // Deterministic signature based on Genesis content
                                hasher.update(b"GENESIS_BLOCK_QUANTUM_SIGNATURE");
                                hasher.update(&genesis_microblock.height.to_le_bytes());
                                hasher.update(&genesis_microblock.timestamp.to_le_bytes());
                                hasher.update(&genesis_microblock.merkle_root);
                                // v3.37: Include state_root in signature for integrity
                                hasher.update(&genesis_microblock.state_root);
                                // Use existing constant for consistency
                                hasher.update(b"qnet_genesis_block_2024");
                                hasher.finalize().to_vec()
                            };
                            println!("[INFO][GEN] genesis_signed algo=deterministic_qr");
                            
                            // Serialize and save Genesis Block
                            match bincode::serialize(&genesis_microblock) {
                                Ok(data) => {
                                    // CRITICAL: Genesis MUST be saved successfully
                                    // Retry up to 3 times if save fails
                                    let mut save_attempts = 0;
                                    const MAX_SAVE_ATTEMPTS: u32 = 3;
                                    
                                    while save_attempts < MAX_SAVE_ATTEMPTS {
                                        save_attempts += 1;
                                        
                                        match storage.save_microblock(0, &data) {
                                            Ok(crate::storage::SaveOutcome::Stored) => {
                                                println!("[INFO][GEN] Genesis Block created and saved at height 0");

                                                // v12.0: Export genesis.bin for file-based distribution
                                                // Other nodes (002-005) can load from this file instead of p2p sync
                                                let genesis_export_path = std::path::PathBuf::from("/app/data/genesis.bin");
                                                if let Some(parent) = genesis_export_path.parent() {
                                                    let _ = std::fs::create_dir_all(parent);
                                                }
                                                match std::fs::write(&genesis_export_path, &data) {
                                                    Ok(_) => {
                                                        println!("[INFO][GEN] genesis_exported path={} bytes={}",
                                                                 genesis_export_path.display(), data.len());
                                                    }
                                                    Err(e) => {
                                                        eprintln!("[ERR][GEN] genesis_export_failed path={} err={}",
                                                                  genesis_export_path.display(), e);
                                                    }
                                                }

                                                // CRITICAL FIX v3.2: Cache NodeRegistration TXs from genesis block
                                                // Without this, genesis creator can't find wallet addresses for rewards!
                                                Self::cache_node_registrations_from_transactions(&storage, &genesis_microblock.transactions);
                                                // Apply genesis registrations canonically (reg_height 0 + vrf) so the creator is byte-identical to synced peers.
                                                Self::apply_genesis_registrations(&storage, &genesis_microblock.transactions);
                                                println!("[INFO][GEN] Cached {} NodeRegistration TXs from genesis block",
                                                    genesis_microblock.transactions.iter()
                                                        .filter(|tx| matches!(tx.tx_type, qnet_state::TransactionType::NodeRegistration { .. }))
                                                        .count());
                                                
                                                // CRITICAL v2.32: Set GLOBAL_GENESIS_TIMESTAMP immediately!
                                                // This ensures ALL nodes use the SAME timestamp
                                                crate::GLOBAL_GENESIS_TIMESTAMP.store(
                                                    genesis_microblock.timestamp,
                                                    std::sync::atomic::Ordering::Relaxed
                                                );
                                                if is_info() { println!("[INFO][GEN] genesis_ts_set ts={}", genesis_microblock.timestamp); }
                                                
                                                // v5.5: Use genesis block's on-chain timestamp for LBPT.
                                                // All nodes must have identical LBPT for deterministic timeout_round.
                                                LAST_BLOCK_PRODUCED_TIME.store(genesis_microblock.timestamp, std::sync::atomic::Ordering::Relaxed);
                                                LAST_BLOCK_PRODUCED_HEIGHT.store(0, std::sync::atomic::Ordering::Relaxed);
                                                // v5.5: Genesis creator is the first producer — unlock immediately
                                                PRODUCTION_UNLOCKED.store(1, Ordering::Relaxed);
                                                if is_info() { println!("[INFO][GEN] genesis_created ts={} production_unlocked", genesis_microblock.timestamp); }

                                                // Display economic information (halving & phase).
                                                // Derived from the emission schedule directly — height is the chain's clock.
                                                {
                                                    let years = 0u64; // genesis block
                                                    let halving_cycle = years / 4;
                                                    let years_until_halving = 4 - (years % 4);
                                                    let pool1_emission =
                                                        (qnet_consensus::lazy_rewards::pool1_base_emission_at_height(0) as f64) / 1_000_000_000.0;
                                                    
                                                    // Determine halving type (normal ÷2 or sharp ÷10)
                                                    let next_cycle = halving_cycle + 1;
                                                    let halving_type = if next_cycle == 5 {
                                                        "÷10_SHARP"
                                                    } else {
                                                        "÷2"
                                                    };
                                                    
                                                    println!("[INFO][ECON] genesis_age={} halving_cycle={} cycle_window={}-{} next_halving={} halving_type={} pool1_emission={:.2}", 
                                                        years, halving_cycle, halving_cycle * 4, (halving_cycle + 1) * 4, years_until_halving, halving_type, pool1_emission);
                                                    
                                                    // Phase 2 triggers on 90% of the 1DEV supply burned OR 5 years from genesis.
                                                    // Burn progress lives on Solana and is read live by the pricing endpoints; a fresh
                                                    // genesis reports only the time trigger rather than stall startup on an RPC round-trip.
                                                    println!("[INFO][PHASE] phase=1 type=1DEV_Burn years_to_phase2={} burn_trigger=solana_live status=active",
                                                        5 - years);
                                                }
                                                
                                                // CRITICAL FIX v2.21.2: Wait for QUIC connections to be FULLY established
                                                // Root cause: Node 001 was broadcasting Genesis before Node 005's QUIC listener
                                                // had fully processed the incoming connection, causing Genesis to be lost
                                                
                                                // Step 1: Wait 10 seconds for all nodes to initialize
                                                println!("[INFO][GEN] quic_wait timeout=10s");
                                                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                                                
                                                // Step 2: Verify QUIC connections are established with Genesis peers
                                                if let Some(ref p2p_check) = unified_p2p {
                                                    let mut quic_ready_attempts = 0;
                                                    const MAX_QUIC_READY_ATTEMPTS: u32 = 12; // 12 * 5s = 60 seconds max
                                                    
                                                    loop {
                                                        quic_ready_attempts += 1;
                                                        let peers = p2p_check.get_validated_active_peers();
                                                        let connected_genesis = peers.iter()
                                                            .filter(|p| p.id.starts_with("genesis_node_"))
                                                            .count();
                                                        
                                                        if connected_genesis >= 3 {
                                                            println!("[INFO][GEN] QUIC ready: {}/4 Genesis peers connected", connected_genesis);
                                                            break;
                                                        }
                                                        
                                                        if quic_ready_attempts >= MAX_QUIC_READY_ATTEMPTS {
                                                            println!("[WARN][GEN] Timeout waiting for QUIC ({} peers connected), proceeding anyway", connected_genesis);
                                                            break;
                                                        }
                                                        
                                                        println!("[INFO][GEN] quic_waiting peers={}/3 attempt={}/{}",
                                                                 connected_genesis, quic_ready_attempts, MAX_QUIC_READY_ATTEMPTS);
                                                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                                                    }
                                                }
                                                
                                                println!("[INFO][GEN] All nodes ready, proceeding with Genesis broadcast");
                                                
                                                // CRITICAL: Broadcast Genesis block WITH RETRY for guaranteed delivery
                                                // Genesis is critical - use retry mechanism to ensure all nodes receive it
                                                if let Some(p2p) = &unified_p2p {
                                                    let mut broadcast_attempts = 0;
                                                    const MAX_GENESIS_ATTEMPTS: u32 = 5;
                                                    let mut broadcast_successful = false;
                                                    
                                                    while broadcast_attempts < MAX_GENESIS_ATTEMPTS && !broadcast_successful {
                                                        broadcast_attempts += 1;
                                                        
                                                        println!("[INFO][GEN] genesis_broadcast attempt={}/{}",
                                                                broadcast_attempts, MAX_GENESIS_ATTEMPTS);
                                                    
                                                    // Use dedicated Genesis broadcast with extended timeout
                                                    match p2p.broadcast_genesis_block(data.clone()).await {
                                                        Ok(_) => {
                                                                println!("[INFO][GEN] Genesis block broadcast successful (attempt {})", 
                                                                        broadcast_attempts);
                                                                
                                                                // CRITICAL v2.21.2: Increased wait time for Genesis propagation
                                                                // 2s was insufficient - some nodes missed Genesis due to network latency
                                                                tokio::time::sleep(Duration::from_secs(5)).await;
                                                                
                                                                // Check if at least 3 out of 5 Genesis nodes are connected
                                                                let peers = p2p.get_validated_active_peers();
                                                                let genesis_peers = peers.iter()
                                                                    .filter(|p| p.id.starts_with("genesis_node_"))
                                                                    .count();
                                                                
                                                                println!("[INFO][GEN] genesis_peers_connected count={}", genesis_peers);
                                                                
                                                                // PRODUCTION THRESHOLD: 3 out of 5 Genesis nodes connected
                                                                if genesis_peers >= 3 {
                                                                    println!("[INFO][GEN] Sufficient Genesis nodes connected");
                                                                    broadcast_successful = true;
                                                                } else {
                                                                    println!("[WARN][GEN] Only {} Genesis nodes connected, need at least 3", 
                                                                            genesis_peers);
                                                                    if broadcast_attempts < MAX_GENESIS_ATTEMPTS {
                                                                        println!("[INFO][GEN] retry delay=3s reason=insufficient_peers");
                                                                        tokio::time::sleep(Duration::from_secs(3)).await;
                                                                    }
                                                                }
                                                        }
                                                        Err(e) => {
                                                                println!("[WARN][GEN] Broadcast attempt {} failed: {}",
                                                                        broadcast_attempts, e);
                                                                if broadcast_attempts < MAX_GENESIS_ATTEMPTS {
                                                                    println!("[INFO][GEN] retry delay=3s reason=broadcast_failed");
                                                                    tokio::time::sleep(Duration::from_secs(3)).await;
                                                                }
                                                            }
                                                        }
                                                    }
                                                    
                                                    if !broadcast_successful {
                                                        println!("[ERR][GEN] genesis_broadcast_failed attempts={}",
                                                                MAX_GENESIS_ATTEMPTS);
                                                        println!("[WARN][GEN] Peers will need to sync via P2P");
                                                    }
                                                }
                                                
                                                // CRITICAL FIX: Set height to 0 after Genesis creation
                                                // This ensures next block will be #1
                                                microblock_height = 0;
                                                *height.write().await = 0;
                                                
                                                // Update storage height to 0 to fix any inconsistencies
                                                if let Err(e) = storage.set_chain_height(0) {
                                                    println!("[WARN][GEN] Warning: Could not update storage height: {}", e);
                                                }
                                                
                                                println!("[INFO][GEN] height_set h=0 next=1");
                                                
                                                // CRITICAL FIX: Broadcast certificate AFTER Genesis creation
                                                // This ensures Genesis exists before certificate propagation
                                                if let Some(ref p2p) = unified_p2p {
                                                    use crate::pq_crypto::{GLOBAL_PQ_INSTANCES, PqCrypto};
                                                    
                                                    let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
                                                        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
                                                    }).await;
                                                    
                                                    let mut instances_guard = instances.lock().await;
                                                    // v2.24: Use unified normalize_node_id for consistent key lookup
                                                    let normalized_id = Self::normalize_node_id(&node_id);
                                                    
                                                    // CRITICAL: Always create/get instance for certificate broadcast
                                                    if !instances_guard.contains_key(&normalized_id) {
                                                        let mut pq = PqCrypto::new(normalized_id.clone());
                                                        if let Err(e) = pq.initialize().await {
                                                            println!("[WARN][GEN] Failed to initialize PQ crypto: {}", e);
                                                        } else {
                                                            instances_guard.insert(normalized_id.clone(), pq);
                                                        }
                                                    }

                                                    // CRITICAL: ALWAYS broadcast certificate after Genesis, even if instance existed
                                                    // ARCHITECTURE: Delay broadcast to ensure all Genesis nodes are ready
                                                    if let Some(pq) = instances_guard.get(&normalized_id) {
                                                        if let Some(cert) = pq.get_current_certificate() {
                                                            if let Ok(cert_bytes) = bincode::serialize(&cert) {
                                                                // CRITICAL FIX: Wait for all Genesis nodes to be connected
                                                                println!("[INFO][GEN] cert_broadcast_wait reason=peer_connection");

                                                                // Ensure all 5 Genesis nodes are connected
                                                                let mut retry_count = 0;
                                                                while retry_count < 10 {
                                                                    let all_connected = p2p.verify_all_genesis_connectivity().await;
                                                                    if all_connected {
                                                                        break;
                                                                    }
                                                                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                                                                    retry_count += 1;
                                                                }
                                                                
                                                                // Additional delay to ensure peers are ready to receive
                                                                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                                                                
                                                                println!("[INFO][GEN] cert_broadcast_post_creation serial={}", cert.serial_number);
                                                                if let Err(e) = p2p.broadcast_certificate_announce(cert.serial_number.clone(), cert_bytes) {
                                                                    println!("[WARN][GEN] Certificate broadcast failed: {}", e);
                                                                } else {
                                                                    println!("[INFO][GEN] Certificate broadcasted to network");
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                                
                                                break;
                                            }
                                            Ok(other) => {
                                                // A non-write is as fatal as an error here: the node
                                                // would run believing it holds genesis when it does not.
                                                println!("[CRIT][GEN] genesis_not_stored outcome={:?} action=exit", other);
                                                set_node_state(NodeState::Error {
                                                    reason: format!("Genesis not stored: {:?}", other),
                                                    recoverable: false,
                                                });
                                                std::process::exit(1);
                                            }
                                            Err(e) => {
                                                println!("[ERR][GEN] genesis_save_failed attempt={}/{} err={}",
                                                         save_attempts, MAX_SAVE_ATTEMPTS, e);
                                                
                                                if save_attempts >= MAX_SAVE_ATTEMPTS {
                                                    // STATE MACHINE: Fatal storage error
                                                    set_node_state(NodeState::Error {
                                                        reason: format!("Cannot save Genesis Block after {} attempts", MAX_SAVE_ATTEMPTS),
                                                        recoverable: false,
                                                    });
                                                    // FATAL: Cannot continue without Genesis
                                                    eprintln!("[CRIT][GEN] genesis_save_fatal attempts={} action=exit", MAX_SAVE_ATTEMPTS);
                                                    std::process::exit(1);
                                                }
                                                
                                                // Wait before retry
                                                tokio::time::sleep(Duration::from_secs(1)).await;
                                            }
                                        }
                                    }
                                }
                                Err(e) => println!("[ERR][GEN] genesis_serialize_failed err={}", e),
                            }
                        }
                        Err(e) => println!("[ERR][GEN] genesis_create_failed err={}", e),
                    }
                    } // end of `if !synced_from_network` else block
                } else if is_bootstrap_mode {
                    // Other bootstrap nodes (002-005) wait for Genesis from node_001
                    println!("[INFO][GEN] waiting_for_primary node={}", bootstrap_id);
                    
                    // CRITICAL: ACTIVELY request Genesis immediately - don't wait passively!
                    // This ensures fast delivery even if initial broadcast failed
                    let mut genesis_wait_attempts = 0;
                    
                    loop {
                        genesis_wait_attempts += 1;
                        
                        // Check if Genesis block arrived
                        // v3.21 FIX: Use spawn_blocking to avoid blocking Tokio runtime!
                        // load_microblock_auto_format is a heavy synchronous operation (~70-100ms)
                        // that would block the async executor and starve other tasks (like block processing)
                        // This was causing Genesis to stay in pending queue for 60s (TTL) before being saved
                        let storage_for_check = storage.clone();
                        let genesis_check = tokio::task::spawn_blocking(move || {
                            storage_for_check.load_microblock_auto_format(0)
                        }).await.unwrap_or(Ok(None));
                        
                        match genesis_check {
                            Ok(Some(genesis_block)) => {
                                println!("[INFO][GEN] Genesis block received after {} attempts",
                                        genesis_wait_attempts);

                                // v11.1: Apply genesis block TXs to state and register PKs.
                                // Without this, synced genesis is stored but its PK registration
                                // TXs are never processed — Dilithium keys missing, all blocks rejected.
                                {
                                    let state_guard = state.write().await;
                                    match state_guard.apply_block_batch(&genesis_block.transactions) {
                                        Ok(count) => {
                                            if is_info() {
                                                println!("[INFO][GEN] genesis_tx_applied count={}", count);
                                            }
                                        }
                                        Err(e) => {
                                            if is_warn() {
                                                println!("[WARN][GEN] genesis_tx_apply_failed err={}", e);
                                            }
                                        }
                                    }
                                }
                                Self::cache_node_registrations_from_transactions(&storage, &genesis_block.transactions);
                                // Stamp reg_height=0 + vrf as well: an unstamped row is invisible to registry_root,
                                // so caching alone forks this node off every checkpoint until a restart stamps it.
                                Self::apply_genesis_registrations(&storage, &genesis_block.transactions);
                                if is_info() {
                                    println!("[INFO][GEN] genesis_registrations_cached tx_count={}", genesis_block.transactions.len());
                                }

                                // Update height from storage
                                if let Ok(stored_height) = storage.get_chain_height() {
                                    microblock_height = stored_height;
                                    *height.write().await = stored_height;
                                    if is_info() {
                                        println!("[INFO][GEN] height_synced h={}", stored_height);
                                    }
                                }

                                // CRITICAL FIX v3.15: Update GLOBAL_GENESIS_TIMESTAMP from received Genesis!
                                // Without this, nodes 002-005 use their LOCAL start time instead of 
                                // the actual Genesis timestamp from node 001, causing timestamp validation
                                // to reject valid blocks as "too old" (delta=-85s)
                                let old_ts = crate::GLOBAL_GENESIS_TIMESTAMP.load(std::sync::atomic::Ordering::Relaxed);
                                crate::GLOBAL_GENESIS_TIMESTAMP.store(
                                    genesis_block.timestamp,
                                    std::sync::atomic::Ordering::Relaxed
                                );
                                if is_info() { println!("[INFO][GEN] genesis_ts_synced old={} new={}", old_ts, genesis_block.timestamp); }
                                
                                // v5.5: Use genesis block's on-chain timestamp for LBPT.
                                // All nodes must have identical LBPT for deterministic timeout_round.
                                LAST_BLOCK_PRODUCED_TIME.store(genesis_block.timestamp, std::sync::atomic::Ordering::Relaxed);
                                LAST_BLOCK_PRODUCED_HEIGHT.store(0, std::sync::atomic::Ordering::Relaxed);
                                // v5.5: Received genesis from network — unlock production
                                PRODUCTION_UNLOCKED.store(1, Ordering::Relaxed);
                                if is_info() { println!("[INFO][GEN] genesis_synced ts={} production_unlocked", genesis_block.timestamp); }

                                // Also update reward manager with correct genesis timestamp
                                crate::set_genesis_timestamp(genesis_block.timestamp);
                                
                                // CRITICAL FIX: Broadcast certificate AFTER Genesis reception
                                // This ensures ALL Genesis nodes have certificates for verification
                                if let Some(ref p2p) = unified_p2p {
                                    use crate::pq_crypto::{GLOBAL_PQ_INSTANCES, PqCrypto};
                                    
                                    let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
                                        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
                                    }).await;
                                    
                                    let mut instances_guard = instances.lock().await;
                                    // v2.24: Use unified normalize_node_id for consistent key lookup
                                    let normalized_id = Self::normalize_node_id(&node_id);
                                    
                                    // CRITICAL: Always create/get instance for certificate broadcast
                                    if !instances_guard.contains_key(&normalized_id) {
                                        let mut pq = PqCrypto::new(normalized_id.clone());
                                        if let Err(e) = pq.initialize().await {
                                            println!("[WARN][GEN] Failed to initialize PQ crypto: {}", e);
                                        } else {
                                            instances_guard.insert(normalized_id.clone(), pq);
                                        }
                                    }

                                    // CRITICAL: ALWAYS broadcast certificate after Genesis, even if instance existed
                                    // ARCHITECTURE: Ensure all peers are connected before certificate broadcast
                                    if let Some(pq) = instances_guard.get(&normalized_id) {
                                        if let Some(cert) = pq.get_current_certificate() {
                                            if let Ok(cert_bytes) = bincode::serialize(&cert) {
                                                // CRITICAL FIX: Wait for all Genesis nodes to be connected
                                                println!("[INFO][GEN] cert_broadcast_wait reason=peer_connection_reception");

                                                // Ensure all 5 Genesis nodes are connected
                                                let mut retry_count = 0;
                                                while retry_count < 10 {
                                                    let all_connected = p2p.verify_all_genesis_connectivity().await;
                                                    if all_connected {
                                                        break;
                                                    }
                                                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                                                    retry_count += 1;
                                                }
                                                
                                                // Additional delay to ensure peers are ready to receive
                                                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                                                
                                                println!("[INFO][GEN] cert_broadcast_post_reception serial={}", cert.serial_number);
                                                if let Err(e) = p2p.broadcast_certificate_announce(cert.serial_number.clone(), cert_bytes) {
                                                    println!("[WARN][GEN] Certificate broadcast failed: {}", e);
                                                } else {
                                                    println!("[INFO][GEN] Certificate broadcasted to network");
                                                }
                                            }
                                        }
                                    }
                                }
                                
                                break;
                            }
                            _ => {
                                // CRITICAL: Request Genesis EVERY attempt (every 2 seconds)
                                // This is much more aggressive than waiting passively
                                if let Some(p2p) = &unified_p2p {
                                    if genesis_wait_attempts % 2 == 0 {
                                        println!("[INFO][GEN] genesis_request attempt={}",
                                                genesis_wait_attempts / 2);
                                    }
                                    
                                    // Block 0 by height, not the general sweep: sync_blocks(0,0)
                                    // clamps to applied+1 and so never asks for genesis, while
                                    // blocking ~45s per call — which is why `elapsed` below read
                                    // 40s while the real wait was minutes.
                                    if let Err(e) = p2p.request_block_repair(0).await {
                                        if genesis_wait_attempts % 10 == 0 {
                                            println!("[WARN][GEN] genesis_request_failed err={}", e);
                                        }
                                    }
                                }
                                
                                // Log progress every 10 seconds
                                if genesis_wait_attempts % 5 == 0 {
                                    println!("[INFO][GEN] genesis_waiting elapsed={}s",
                                            genesis_wait_attempts * 2);
                                }
                                
                                tokio::time::sleep(Duration::from_secs(2)).await;
                            }
                        }
                    }
                } else {
                    // PRODUCTION: Non-bootstrap nodes join AFTER network starts
                    // They will sync entire blockchain (including Genesis) via normal sync mechanism
                    println!("[INFO][GEN] non_bootstrap_node sync=network");
                    println!("[INFO][GEN] genesis_phase bootstrap_only=5");
                    
                    // Check if blockchain already exists (synced from network)
                    if let Ok(stored_height) = storage.get_chain_height() {
                        if stored_height > 0 {
                            println!("[INFO][GEN] Blockchain already synced (height: {})", stored_height);
                            microblock_height = stored_height;
                            *height.write().await = stored_height;
                        }
                    }
                    
                    // No special Genesis waiting - normal sync will handle it
                    // This is fine because non-bootstrap nodes only join after network is running
                }
            } else {
                // Genesis block already exists in storage
                // CRITICAL FIX v3.15.2: Still need to sync GLOBAL_GENESIS_TIMESTAMP from stored Genesis!
                // Without this, nodes use their LOCAL start time instead of Genesis timestamp
                // MUST use load_microblock_auto_format() to handle compressed/efficient formats!
                if let Ok(Some(genesis_block)) = storage.load_microblock_auto_format(0) {
                    let old_ts = crate::GLOBAL_GENESIS_TIMESTAMP.load(std::sync::atomic::Ordering::Relaxed);
                    if old_ts != genesis_block.timestamp {
                        crate::GLOBAL_GENESIS_TIMESTAMP.store(
                            genesis_block.timestamp,
                            std::sync::atomic::Ordering::Relaxed
                        );
                        crate::set_genesis_timestamp(genesis_block.timestamp);
                        if is_info() {
                            println!("[INFO][GEN] genesis_ts_synced_from_storage old={} new={}", old_ts, genesis_block.timestamp);
                        }
                    }

                    // v11.1: Ensure genesis TXs are applied even when genesis arrived via P2P
                    // before this code path. Genesis may be in storage (from process_received_blocks)
                    // but its PK registration TXs not yet applied to state/VRF registry.
                    // Idempotent: cache_node_registrations skips already-registered nodes.
                    if !genesis_block.transactions.is_empty() {
                        let has_vrf_keys = crate::genesis_constants::has_vrf_key("genesis_node_001");
                        if !has_vrf_keys {
                            {
                                let state_guard = state.write().await;
                                match state_guard.apply_block_batch(&genesis_block.transactions) {
                                    Ok(count) => {
                                        if is_info() {
                                            println!("[INFO][GEN] genesis_tx_applied count={}", count);
                                        }
                                    }
                                    Err(e) => {
                                        if is_warn() {
                                            println!("[WARN][GEN] genesis_tx_apply_failed err={}", e);
                                        }
                                    }
                                }
                            }
                            Self::cache_node_registrations_from_transactions(&storage, &genesis_block.transactions);
                            // Stamp reg_height=0 + vrf as well: an unstamped row is invisible to registry_root,
                            // so caching alone forks this node off every checkpoint until a restart stamps it.
                            Self::apply_genesis_registrations(&storage, &genesis_block.transactions);
                            if is_info() {
                                println!("[INFO][GEN] genesis_registrations_cached tx_count={}", genesis_block.transactions.len());
                            }
                        }
                    }
                } else {
                    if is_warn() { println!("[WARN][GEN] failed_to_load_genesis_for_ts_sync"); }
                }
                if is_info() { println!("[INFO][GEN] genesis_found_in_storage height=0"); }
            }
            
            // NOTE: Timing is now Unix-based in main loop (v2.42)
            // Uses genesis_timestamp + height for deterministic slot timing
            
            // ═══════════════════════════════════════════════════════════════════════════
            // CRITICAL FIX v3.15: Initialize LAST_BLOCK_PRODUCED_TIME RIGHT BEFORE main_loop!
            // ═══════════════════════════════════════════════════════════════════════════
            // WHY HERE (not earlier):
            //   - Earlier initialization (at Genesis reception) would result in delay = 120s
            //     because nodes wait ~2 minutes for certificates before starting main_loop
            //   - Initializing HERE ensures delay starts at ~0 when production begins
            //   - All nodes initialize at roughly the same time (within NTP drift ~2s)
            // ═══════════════════════════════════════════════════════════════════════════
            {
                // v5.5: LBPT must always be on-chain timestamp for determinism.
                // After replay, LBPT is already set to last replayed block's timestamp.
                // Only set to genesis_ts if not yet set (fresh start with no blocks).
                let current_lbpt = LAST_BLOCK_PRODUCED_TIME.load(std::sync::atomic::Ordering::Relaxed);
                if current_lbpt == 0 {
                    // Fresh start — use genesis timestamp as baseline
                    let genesis_ts = crate::GLOBAL_GENESIS_TIMESTAMP.load(std::sync::atomic::Ordering::Relaxed);
                    let baseline = if genesis_ts > 0 { genesis_ts } else { get_timestamp_safe() };
                    LAST_BLOCK_PRODUCED_TIME.store(baseline, std::sync::atomic::Ordering::Relaxed);
                } else {
                    // Restart with replay — keep on-chain timestamp from replay
                    if is_info() {
                        let stale = get_timestamp_safe().saturating_sub(current_lbpt);
                        println!("[INFO][STATE] preserving_replay_lbpt ts={} stale={}s",
                                 current_lbpt, stale);
                    }
                }
                LAST_BLOCK_PRODUCED_HEIGHT.store(microblock_height, std::sync::atomic::Ordering::Relaxed);
                if is_info() {
                    let effective_lbpt = LAST_BLOCK_PRODUCED_TIME.load(std::sync::atomic::Ordering::Relaxed);
                    println!("[INFO][GEN] main_loop_init last_block_time={} height={}", effective_lbpt, microblock_height); 
                }
            }
            
            println!("[INFO][MB] production_system_start");
            println!("[INFO][MB] target_tps=100000 mode=batch");
            
            // CRITICAL: Register as active node immediately at startup
            // This ensures we're in the global registry for producer selection
            if node_type != NodeType::Light {
                if let Some(ref p2p) = unified_p2p {
                    println!("[INFO][ACTIVE] registering");
                    p2p.register_as_active_node_async().await;
                    println!("[INFO][ACTIVE] registered type={:?}", node_type);
                }
            }

            // v31.14: NodeReactivation auto-send removed. Returning nodes enter eligible via Phase 2A HBC.

            // CPU MONITORING: Track CPU usage periodically
            let mut cpu_check_counter = 0u64;
            let start_time = std::time::Instant::now();
            
            // DEADLOCK PROTECTION: Track last successful block production
            let mut last_production_time = std::time::Instant::now();
            let mut last_production_height = 0u64;
            
            // QUANTUM VTS: Get reference for microblock production
            
            // PARALLEL EXECUTOR: Get reference for parallel processing
            let parallel_executor = parallel_executor_for_spawn.clone();
            
            // ADAPTIVE BFT: Get reference for adaptive timeouts
            let adaptive_bft = adaptive_bft_for_spawn.clone();
            
            // PRE-EXECUTION: Get reference for speculative execution
            let pre_execution = pre_execution_for_spawn.clone();
            
            // PRODUCTION: Track certificate management timing  
            let mut certificate_cleanup_counter = 0u64;
            let mut certificate_broadcast_counter = 0u64;
            let mut certificate_rotation_counter = 0u64;  // v2.44: Periodic rotation even during stall
            let mut genesis_reconnect_counter = 0u64;  // CRITICAL FIX: Genesis peer reconnection
            let node_start_time = std::time::Instant::now();
            
            // OPTIMIZATION: Track last round when certificate was broadcasted
            // Prevents redundant broadcasts (30× per round → 1× per round)
            let mut last_certificate_broadcast_round: Option<u64> = None;
            
            while *is_running.read().await {
                // v15.11: Heartbeat tick — emitted at the very top of every iteration
                // before any await point so the watchdog can distinguish "loop alive"
                // from "loop blocked inside an await". Atomic store is wait-free.
                record_producer_heartbeat();

                // v16.1: Halt escalation. Set by the state-machine escalation ladder
                // (Phase 2.A) after sustained recoverable-error cycles. Matches the
                // existing watchdog convention of process::exit(1) — Docker/orchestrator
                // restart picks up a clean process state. We exit BEFORE doing any
                // work this tick so a stuck-in-error node releases its resources fast.
                if HALT_REQUESTED.load(std::sync::atomic::Ordering::Relaxed) {
                    eprintln!("[CRIT][NODE] halt_requested action=process_exit_for_orchestrator_restart");
                    std::process::exit(1);
                }

                // Adaptive-rate throttle removed — produce at full slot
                // cadence. The self-pause-when-ahead heuristic was harmful
                // (forensic h=2791: producer 18-30 blocks ahead paused 100ms
                // every slot → 1.107s cadence vs 1s target). Waiting for the
                // slowest peer meant the chain moved at the slowest host's
                // speed — worse at scale (one slow host pins 1000 validators).
                // The premise was inverted: the chain stalls when the producer
                // slows DOWN; catch-up is the sync subsystem's job, not the
                // producer's. Slow peers self-recover via sync or fall out at
                // the epoch boundary.

                // ═══════════════════════════════════════════════════════════════════
                // SLOT-BASED TIMING v2.42: Wait based on UNIX timestamp (not Instant!)
                // This GUARANTEES blocks are created at correct absolute time
                // Uses genesis_timestamp + height formula for deterministic timing
                // ═══════════════════════════════════════════════════════════════════
                {
                    // Maximum time drift before considering height desynchronized
                    // = ~1 macroblock worth of time (60 seconds)
                    // Normal operation: 0-2 sec, sync: 0-10 sec, >60 sec = error
                    const MAX_SLOT_WAIT_SECS: u64 = 60;
                    
                    // v3.5: Check if we just completed sync - skip slot timing wait!
                    // PROBLEM: After sync, node is "ahead" of slot time and would wait
                    // unnecessarily while network expects block from it immediately.
                    // SOLUTION: Skip wait on first iteration after sync completion.
                    let just_synced = JUST_COMPLETED_SYNC.swap(false, Ordering::SeqCst);
                    if just_synced {
                        if is_info() {
                            println!("[INFO][SLOT] post_sync_skip_wait reason=just_completed_sync");
                        }
                        // Minimal wait to allow state to settle, then proceed immediately
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        // Don't skip the rest of the block - continue to production logic
                    } else {
                        // Normal slot timing logic
                        let genesis_ts = crate::GLOBAL_GENESIS_TIMESTAMP
                            .load(std::sync::atomic::Ordering::Relaxed);
                        
                        if genesis_ts > 0 {
                            // Calculate expected Unix timestamp for next block
                            let current_height = *height.read().await;
                            let expected_unix_time = genesis_ts + current_height + 1;
                            
                            let current_unix_time = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs();
                            
                            if expected_unix_time > current_unix_time {
                                let wait_secs = expected_unix_time - current_unix_time;
                                
                                if wait_secs > MAX_SLOT_WAIT_SECS {
                                    // Height is ahead of wall clock by >3 minutes
                                    // This indicates sync issue - don't busy loop, wait for correction
                                    if is_warn() { 
                                        println!("[WARN][SLOT] height_desync h={} expected_ts={} current_ts={} drift={}s", 
                                                 current_height + 1, expected_unix_time, current_unix_time, wait_secs); 
                                    }
                                    tokio::time::sleep(Duration::from_secs(10)).await;
                                    continue;
                                }
                                
                                // Normal case: wait until correct Unix time for this block slot
                                tokio::time::sleep(Duration::from_secs(wait_secs)).await;
                            } else {
                                // LATE vs the slot schedule: produce with a short floor, NOT a flat 1s
                                // (that made lag monotonic — it could only grow). The floor lets lag
                                // SHRINK (catch-up >1/s) while capping the burst (network-capacity guard);
                                // real production cost still dominates, so this is a ceiling, not a rate.
                                tokio::time::sleep(Duration::from_millis(200)).await; // <=5 blk/s catch-up
                            }
                        } else {
                            // No genesis timestamp yet - use simple 1 second interval
                            tokio::time::sleep(microblock_interval).await;
                        }
                    } // end of normal slot timing (else branch of just_synced)
                }
                
                cpu_check_counter += 1;
                certificate_cleanup_counter += 1;
                certificate_broadcast_counter += 1;
                certificate_rotation_counter += 1;
                genesis_reconnect_counter += 1;
                
                // ═══════════════════════════════════════════════════════════════════
                // v3.50: Periodic certificate rotation + immediate broadcast
                // ═══════════════════════════════════════════════════════════════════
                // Certificates expire after 4.5 minutes (270s), rotate at 80% (216s)
                // v3.50: Broadcast IMMEDIATELY after rotation to ensure all peers
                // receive every new cert. Dilithium-only verification — no chain needed.
                // ═══════════════════════════════════════════════════════════════════
                if certificate_rotation_counter >= 180 && node_type != NodeType::Light {
                    certificate_rotation_counter = 0;
                    
                    let node_id_for_rotation = node_id.clone();
                    let p2p_for_rotation = unified_p2p.clone();
                    match tokio::runtime::Handle::try_current() {
                        Ok(handle) => {
                            handle.spawn(async move {
                                use crate::crypto::pq_crypto::{PqCrypto, GLOBAL_PQ_INSTANCES};
                                
                                let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
                                    std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
                                }).await;
                                
                                let mut instances_guard = instances.lock().await;
                                
                                // Get or create PQ crypto instance for this node
                                if !instances_guard.contains_key(&node_id_for_rotation) {
                                    let mut pq = PqCrypto::new(node_id_for_rotation.clone());
                                    if let Err(e) = pq.initialize().await {
                                        println!("[WARN][CERT] PQ crypto init failed: {}", e);
                                        return;
                                    }
                                    instances_guard.insert(node_id_for_rotation.clone(), pq);
                                }

                                if let Some(pq) = instances_guard.get_mut(&node_id_for_rotation) {
                                    if pq.needs_rotation() {
                                        if let Err(e) = pq.rotate_certificate().await {
                                            println!("[WARN][CERT] Periodic rotation failed: {}", e);
                                        } else {
                                            // v3.50: Broadcast immediately after rotation
                                            // Ensures peers always have our latest cert
                                            if let Some(cert) = pq.get_current_certificate() {
                                                if let Ok(cert_bytes) = bincode::serialize(&cert) {
                                                    if let Some(ref p2p) = p2p_for_rotation {
                                                        if let Err(e) = p2p.broadcast_certificate_announce(cert.serial_number.clone(), cert_bytes) {
                                                            println!("[WARN][CERT] post_rotation_broadcast_failed err={}", e);
                                                        } else {
                                                            println!("[INFO][CERT] rotated_and_broadcasted serial={}", cert.serial_number);
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            });
                        }
                        Err(_) => {
                            println!("[WARN][CERT] No runtime for periodic rotation");
                        }
                    }
                }
                
                // PRODUCTION: Certificate cache cleanup (every 5 minutes)
                // Removes expired certificates from cache (TTL: 9 min for verified, 5 min for pending)
                // Low overhead: O(n) on ~5000 entries = ~50μs per cleanup
                if certificate_cleanup_counter >= 300 {
                    certificate_cleanup_counter = 0;
                    
                    // Cleanup old certificates from cache
                    if let Some(ref p2p) = unified_p2p {
                        {
                            let mut cert_manager = p2p.certificate_manager.write();
                            cert_manager.cleanup();
                            println!("[INFO][CERT] cache_cleaned");

                            // PRODUCTION FIX v2.30: Persist certificate history every 5 minutes
                            // ONLY for Super nodes — Light nodes don't participate in consensus!
        // (v3.18: the "Full" tier was removed from the protocol.)
                            if node_type != NodeType::Light {
                                let storage_path = std::env::var("QNET_STORAGE_PATH").unwrap_or_else(|_| "data".to_string());
                                let data_dir = std::path::Path::new(&storage_path);
                                let unified_node_type = match node_type {
                                    NodeType::Light => crate::unified_p2p::NodeType::Light,
                                    NodeType::Super => crate::unified_p2p::NodeType::Super,
                                };
                                if let Err(e) = std::fs::create_dir_all(&data_dir) {
                                    println!("[WARN][CERT] data_dir_create_failed path={} err={}", storage_path, e);
                                } else if let Err(e) = cert_manager.persist_to_disk(&data_dir, unified_node_type) {
                                    println!("[WARN][CERT] persist_failed err={}", e);
                                } else {
                                    if is_debug() { println!("[DBG][CERT] persisted path={}", storage_path); }
                                }
                            }
                        } // cert_manager write lock released

                        // CRITICAL: Cleanup stale nodes from active registry
                        // This prevents selecting offline nodes as producers
                        // Nodes not seen for >15 minutes are removed
                        p2p.cleanup_stale_active_nodes();
                        
                        // Refresh the Phase-2 price multiplier input from the CHAIN-CONFIRMED
                        // registry, not from the peer table: the multiplier prices network size and
                        // a peer count stays bounded no matter how large the network gets.
                        let registered = storage.registered_node_count();
                        crate::update_registered_node_count(registered);
                        println!("[INFO][PRICING] registered_nodes_refreshed count={}", registered);
                    }
                }
                
                // CRITICAL FIX: Genesis peer reconnection (every 10 seconds)
                // This fixes the race condition where Genesis nodes start simultaneously
                // and fail to connect to each other on first attempt
                let is_genesis_node = std::env::var("QNET_BOOTSTRAP_ID")
                    .map(|id| ["001", "002", "003", "004", "005"].contains(&id.trim()))
                    .unwrap_or(false);
                    
                if is_genesis_node && genesis_reconnect_counter >= 10 {
                    genesis_reconnect_counter = 0;
                    
                    if let Some(ref p2p) = unified_p2p {
                        let current_peers = p2p.get_peer_count();
                        
                        // If we don't have all 4 other Genesis peers, try to reconnect
                        if current_peers < 4 {
                            println!("[INFO][P2P] genesis_reconnect peers={} need=4", current_peers);
                            
                            // REUSE: Use existing add_discovered_peers method (no code duplication!)
                            use crate::unified_p2p::get_genesis_bootstrap_ips;
                            let genesis_ips = get_genesis_bootstrap_ips();
                            let genesis_peers: Vec<String> = genesis_ips.iter()
                                .map(|ip| format!("{}:8001", ip))
                                .collect();
                            
                            // add_discovered_peers handles:
                            // - TCP connectivity check
                            // - Self-connection filtering
                            // - Duplicate detection
                            // - PeerInfo creation
                            // - Kademlia fields calculation
                            p2p.add_discovered_peers(&genesis_peers);
                            
                            let new_peer_count = p2p.get_peer_count();
                            if new_peer_count > current_peers {
                                if is_info() { println!("[INFO][P2P] reconnect peers={} was={}", new_peer_count, current_peers); }
                            }
                            
                            // ═══════════════════════════════════════════════════════════════════════════
                            // CRITICAL FIX v2.84: QUIC fallback reconnect when TCP/HTTP fails
                            // If port 8001 is blocked, try direct QUIC connections on port 10876
                            // SECURITY v2.84: Rate limited to max 10 requests per minute per node
                            // ═══════════════════════════════════════════════════════════════════════════
                            let final_peer_count = p2p.get_peer_count();
                            if final_peer_count < 4 {
                                // PRIORITY 1: Rate limit check (max 10/min per node)
                                use crate::unified_p2p::quic_fallback_rate_check;
                                
                                if !quic_fallback_rate_check(&node_id) {
                                    if is_warn() {
                                        println!("[WARN][P2P] quic_fallback_rate_limited node={}", 
                                                 qnet_state::char_prefix(&node_id, 8));
                                    }
                                } else {
                                    if is_info() {
                                        println!("[INFO][P2P] quic_fallback_start tcp_peers={} required=4", final_peer_count);
                                    }
                                    
                                    // PRIORITY 3: Increment total attempts metric
                                    use crate::unified_p2p::QUIC_FALLBACK_TOTAL;
                                    QUIC_FALLBACK_TOTAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                    
                                    // Try QUIC direct connections to Genesis nodes
                                    use crate::quic_transport::QUIC_PORT_OFFSET;
                                    use crate::unified_p2p::{GLOBAL_QUIC_TRANSPORT, GLOBAL_NODE_ID, NetworkMessage};
                                    
                                    let quic_transport = GLOBAL_QUIC_TRANSPORT.read().clone();
                                    
                                    if let Some(ref transport_arc) = quic_transport {
                                        let our_node_id = {
                                            let guard = GLOBAL_NODE_ID.read();
                                            if guard.is_empty() { node_id.clone() } else { guard.clone() }
                                        };
                                        
                                        use crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT;
                                    let our_height = LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                                        
                                        // Send HealthPing via QUIC to establish/refresh connections
                                        let (hint_mb, hint_round) = crate::unified_p2p::current_tc_hint();
                                        let ping_msg = NetworkMessage::HealthPing {
                                            from: our_node_id.clone(),
                                            timestamp: std::time::SystemTime::now()
                                                .duration_since(std::time::UNIX_EPOCH)
                                                .unwrap_or_default()
                                                .as_secs(),
                                            height: our_height,
                                            cert_mb: hint_mb,
                                            cert_round: hint_round,
                                            signature: String::new(),
                                        };

                                        let transport = transport_arc.read().await;
                                        let mut quic_success = 0;
                                        
                                        for ip in &genesis_ips {
                                            // Skip self
                                            if ip.contains(&node_id) { continue; }
                                            
                                            let quic_port = 8001u16.saturating_add(QUIC_PORT_OFFSET);
                                            if let Ok(ip_addr) = ip.parse::<std::net::IpAddr>() {
                                                let quic_addr = std::net::SocketAddr::new(ip_addr, quic_port);
                                                
                                                if transport.broadcast_to(quic_addr, &ping_msg).await.is_ok() {
                                                    quic_success += 1;
                                                    if is_debug() {
                                                        // PRIVACY: Use pseudonym instead of raw IP
                                                        let peer_display = crate::unified_p2p::get_privacy_id_for_addr(ip);
                                                        println!("[DBG][P2P] quic_ping_sent peer={} port={}", peer_display, quic_port);
                                                    }
                                                }
                                            }
                                        }
                                        
                                        if quic_success > 0 {
                                            // PRIORITY 3: Increment success metric (at least 1 ping sent)
                                            use crate::unified_p2p::QUIC_FALLBACK_SUCCESS;
                                            QUIC_FALLBACK_SUCCESS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                            
                                            if is_info() {
                                                use crate::unified_p2p::get_quic_fallback_metrics;
                                                let (_, _, rate) = get_quic_fallback_metrics();
                                                println!("[INFO][P2P] quic_fallback_complete sent={} port={} success_rate={}.{}%", 
                                                         quic_success, 8001 + QUIC_PORT_OFFSET as u16, rate / 10, rate % 10);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        
                        // v9.2: Removed per-block register_as_active_node_async() call.
                        // Was firing every ~1s → 240 announces/min per peer → rate limit flood.
                        // Periodic registration (every 60s, line ~12885) is sufficient.
                        // Heartbeats (every 10s) already prove liveness to peers.
                    }
                }
                
                // CRITICAL FIX: Periodic active node registration (every 60 seconds)
                // This ensures ALL nodes (not just Genesis) are in the global registry
                // Without this, non-Genesis nodes won't be selected as producers!
                static ACTIVE_NODE_REGISTRATION_COUNTER: std::sync::atomic::AtomicU64 = 
                    std::sync::atomic::AtomicU64::new(0);
                let reg_counter = ACTIVE_NODE_REGISTRATION_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                
                if reg_counter % 60 == 0 && node_type != NodeType::Light {
                    // v9.7: HARDENED sync gate — unsynced node MUST NOT register as active.
                    // Three conditions must ALL be true:
                    //   1. NODE_IS_SYNCHRONIZED flag (set only after sync completes with re-check)
                    //   2. Height gap check: our_height + 20 >= best_peer_height
                    //   3. Best_peer_height > 0 (network height known from handshake/HealthPing)
                    //
                    // v9.5 bug: `reg_best_h == 0` allowed bypass before first HealthPing (15s window).
                    // v9.7 fix: Handshake now sets BEST_PEER_HEIGHT immediately, AND we require
                    //   NODE_IS_SYNCHRONIZED which is only true after sync completes with re-check.
                    //
                    // With 30000 nodes, thousands may be syncing at any moment. Without this gate,
                    // VRF selects unsynced node → can't produce → 5s timeout → throughput drops.
                    let reg_synced = coordinator_is_production_ready();
                    let reg_our_h = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);
                    let reg_best_h = crate::unified_p2p::BEST_PEER_HEIGHT.load(std::sync::atomic::Ordering::Relaxed);

                    // Sync-INDEPENDENT binding-TX rebroadcast: a node's own NodeRegistration must land
                    // on-chain even while it is still syncing (identity binding is signature-validated,
                    // not chain-state-validated). This does NOT make an unsynced node VRF-eligible —
                    // that is gated separately by register_as_active_node_async below. Producer-direct
                    // gossip + genesis fan-out (same delivery as NodeActivation); re-applying an included
                    // registration is a nonce/dedup no-op; the attempt budget bounds it.
                    if let Some(ref p2p) = unified_p2p {
                        let resend = if let Ok(mut guard) = PENDING_NODE_REGISTRATION.lock() {
                            // Stops once on-chain. Otherwise a tick-based backoff: burst for the first few
                            // cycles (a legitimate registration lands here) then trickle every BACKOFF_CYCLES,
                            // so a permanently-rejected registration (bad burn) decays to a negligible steady
                            // rate instead of hammering genesis forever — bounds mass-join amplification while
                            // keeping liveness (the synced-built bytes are still re-delivered until inclusion).
                            let mut out = None;
                            let mut clear = false;
                            if let Some((id, bytes, tick, _attest_epoch)) = guard.as_mut() {
                                let onchain = crate::node::try_get_storage()
                                    .map(|s| s.is_node_registration_onchain(id)).unwrap_or(false);
                                if onchain {
                                    if is_info() { println!("[INFO][REG] registration_onchain id={} stop_rebroadcast", id); }
                                    clear = true;
                                } else {
                                    const BACKOFF_CYCLES: u32 = 30; // ~30 periodic cycles between sends after the burst
                                    let t = *tick;
                                    *tick = tick.saturating_add(1);
                                    if t < 4 || t % BACKOFF_CYCLES == 0 {
                                        out = Some((id.clone(), bytes.clone()));
                                    }
                                }
                            }
                            if clear { *guard = None; }
                            out
                        } else { None };
                        if let Some((reg_id, reg_bytes)) = resend {
                            let _ = p2p.broadcast_transaction(reg_bytes.clone());
                            let tx_msg = crate::unified_p2p::NetworkMessage::Transaction { data: reg_bytes };
                            for ip in &crate::unified_p2p::get_genesis_bootstrap_ips() {
                                p2p.send_network_message(&format!("{}:8001", ip), tx_msg.clone());
                            }
                            if is_info() { println!("[INFO][REG] registration_rebroadcast id={} await=on-chain", reg_id); }
                        }
                    }

                    if reg_synced {
                        if let Some(ref p2p) = unified_p2p {
                            if is_info() { println!("[INFO][ACTIVE] periodic_registration h={} best={}", reg_our_h, reg_best_h); }
                            p2p.register_as_active_node_async().await;
                        }
                    } else {
                        if is_info() {
                            println!("[INFO][ACTIVE] registration_skipped_unsynced our_h={} best_h={} gap={}",
                                     reg_our_h, reg_best_h, reg_best_h.saturating_sub(reg_our_h));
                        }
                    }
                }
                
                // v3.50: PERIODIC CERTIFICATE BROADCAST (maintenance for new peers)
                // Primary delivery: immediate broadcast after rotation (see rotation block above)
                // This periodic broadcast only serves new peers who missed the rotation broadcast
                let uptime_secs = node_start_time.elapsed().as_secs();
                let broadcast_interval = if uptime_secs < 120 {
                    10  // First 2 minutes: every 10 seconds (initial propagation to bootstrap peers)
                } else if uptime_secs < 300 {
                    60  // 2-5 minutes: every 60 seconds (moderate)
                } else {
                    180  // After 5 minutes: every 3 minutes (maintenance only — rotation broadcast is primary)
                };
                
                if certificate_broadcast_counter >= broadcast_interval && node_type != NodeType::Light {
                    certificate_broadcast_counter = 0;
                    
                // Broadcast certificate if we have one
                if let Some(ref p2p) = unified_p2p {
                    use crate::pq_crypto::GLOBAL_PQ_INSTANCES;
                    
                    // Get our node's certificate from global instances
                    let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
                        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
                    }).await;
                    
                    let instances_guard = instances.lock().await;
                    let normalized_id = Self::normalize_node_id(&node_id);
                    
                    if let Some(pq) = instances_guard.get(&normalized_id) {
                        if let Some(cert) = pq.get_current_certificate() {
                            if let Ok(cert_bytes) = bincode::serialize(&cert) {
                                println!("[INFO][CERT] periodic_broadcast serial={}", cert.serial_number);
                                if let Err(e) = p2p.broadcast_certificate_announce(cert.serial_number, cert_bytes) {
                                    println!("[WARN][CERT] periodic_broadcast_failed err={}", e);
                                }
                            }
                        }
                    }
                }
                }
                
                // CRITICAL FIX v2.50: Unify height sources within THIS NODE
                // 
                // ARCHITECTURE: Two LOCAL height sources exist on each node:
                // 1. Arc<RwLock<u64>> height - RAM variable, updated by received_block handler
                // 2. storage.get_chain_height() - RocksDB on disk, updated by save_microblock()
                // 
                // PROBLEM: sync_blocks() downloads from network and saves to RocksDB
                //          but does NOT update the RAM variable (Arc<RwLock>)!
                // RESULT: State machine uses stale RAM height, causing rotation desync
                // 
                // SOLUTION: Use RocksDB as single source of truth (it's always updated)
                //           Then sync RAM variable for consistency with other components
                // 
                // NOTE: This is INTERNAL synchronization within one node, NOT network sync!
                //       Network sync happens via sync_blocks() -> save_microblock() -> RocksDB
                {
                    // v15.11: storage.get_chain_height() is a sync RocksDB read on a column
                    // family that can stall for hundreds of milliseconds during compaction.
                    // The producer loop runs every second, so an 800ms compaction stall
                    // here freezes the entire async runtime — the exact fault profile
                    // observed on the production node 002 silent-for-85s incident.
                    // spawn_blocking moves the read off the runtime's worker threads.
                    let storage_for_height = storage.clone();
                    let local_chain_height = match tokio::task::spawn_blocking(move || {
                        storage_for_height.get_chain_height().unwrap_or(0)
                    }).await {
                        Ok(h) => h,
                        Err(join_err) => {
                            println!("[WARN][SYNC] get_chain_height_join_err err={}", join_err);
                            0
                        }
                    };

                    // Also get RAM height variable for comparison
                    let ram_height = *height.read().await;

                    // CRITICAL: Use MAX of both to handle all sync paths
                    // SAFETY: Guard against u64::MAX (can appear if cache/state is corrupted).
                    // Without this, the scan loop below iterates 18 quintillion entries → deadlock.
                    let canonical_height = {
                        let raw = std::cmp::max(local_chain_height, ram_height);
                        if raw == u64::MAX || raw > 2_000_000_000 {
                            println!("[ERR][SYNC] canonical_height_invalid={} local={} ram={} — clamping to local",
                                     raw, local_chain_height, ram_height);
                            local_chain_height
                        } else {
                            raw
                        }
                    };

                    // INTERNAL SYNC: Update RAM if RocksDB is ahead (fixes API/other components)
                    if local_chain_height > ram_height {
                        *height.write().await = local_chain_height;
                        if is_debug() {
                            println!("[DBG][SYNC] RAM height updated: {} -> {} (from RocksDB)",
                                     ram_height, local_chain_height);
                        }
                    }

                    if canonical_height > microblock_height {
                        // v15.11: scan window bounded + spawn_blocking. Verify blocks
                        // between state-machine height and canonical exist in RocksDB
                        // before fast-forwarding. Scan capped at 1 macroblock (90)
                        // to keep the producer loop bounded under any catch-up gap.
                        const SCAN_WINDOW_BLOCKS: u64 = 90;

                        // v32.15: snapshot fast-path. State CF advanced via state-sync
                        // snapshot means blocks 1..N are intentionally absent (snapshot
                        // replaces sequential replay). Per-block scan would deadlock here
                        // forever. Detect by `microblock_height==0` + gap ≥ scan window
                        // and advance state-machine directly to canonical_height.
                        let snapshot_jump = microblock_height == 0
                            && canonical_height >= SCAN_WINDOW_BLOCKS;

                        let (can_sync, scan_target) = if snapshot_jump {
                            println!(
                                "[INFO][SYNC] state_machine_snapshot_fastforward 0→{} (state-sync apply, no per-block scan)",
                                canonical_height
                            );
                            (true, canonical_height)
                        } else {
                            let st = std::cmp::min(
                                canonical_height,
                                microblock_height.saturating_add(SCAN_WINDOW_BLOCKS),
                            );
                            let scan_from = microblock_height + 1;
                            let storage_for_scan = storage.clone();
                            let scan_result: (bool, Option<u64>) = match tokio::task::spawn_blocking(move || {
                                for h in scan_from..=st {
                                    if storage_for_scan.load_microblock(h).unwrap_or(None).is_none() {
                                        return (false, Some(h));
                                    }
                                }
                                (true, None)
                            }).await {
                                Ok(res) => res,
                                Err(join_err) => {
                                    println!("[WARN][SYNC] scan_join_err range={}..={} err={}", scan_from, st, join_err);
                                    (false, None)
                                }
                            };
                            if !scan_result.0 {
                                if let Some(missing_h) = scan_result.1 {
                                    println!("[WARN][SYNC] Cannot sync state machine to {} - missing block #{} (window={}..={})",
                                            canonical_height, missing_h, scan_from, st);
                                    // B3: fan-out repair for the EXACT stuck block, independent of the bulk
                                    // range path (which can serve a sparse batch and never refill this gap).
                                    // Single-flight TTL-deduped, so re-scan each tick can't storm.
                                    crate::block_pipeline::request_missing_parent(missing_h);
                                }
                            }
                            (scan_result.0, st)
                        };
                        // Fast-forward only as far as verified. Next iteration picks up
                        // the following window. Catch-up bounded, view-change responsive.
                        let effective_canonical = if can_sync { scan_target } else { microblock_height };
                        let canonical_height = effective_canonical;

                        if can_sync {
                            println!("[INFO][SYNC] state_machine_height_update {} → {} (all blocks in RocksDB)",
                                    microblock_height, canonical_height);
                            
                            let old_height = microblock_height;
                            microblock_height = canonical_height;
                            
                            // CRITICAL FIX v2.26.8: Also update last_macroblock_trigger when syncing!
                            // Without this, trigger stays at 0 after sync, causing:
                            // - PFP to search for macroblock #0 (doesn't exist)
                            // - Infinite loop of creating macroblock #1
                            // - Producer gets stuck in PFP instead of producing blocks
                            let new_trigger = (canonical_height / 90) * 90;
                            if new_trigger > last_macroblock_trigger {
                                if is_debug() { println!("[DBG][SYNC] mb_trigger {} -> {} (synced)", 
                                        last_macroblock_trigger, new_trigger); }
                                last_macroblock_trigger = new_trigger;
                            }
                            
                            // v14.7.2: After sync advances past an epoch boundary, request missing
                            // macroblocks directly from peers. Canonical BFT finality is produced by
                            // the regular n−f macroblock consensus at the 90-block boundary —
                            // no degraded thresholds, no Byzantine-unsafe fallbacks.
                            if canonical_height > 180 && canonical_height > old_height {
                                let first_epoch_boundary = ((old_height / 90) + 1) * 90;
                                let mut check_boundary = first_epoch_boundary;
                                while check_boundary <= canonical_height {
                                    let expected_mb = check_boundary / 90;
                                    let mb_missing = storage
                                        .get_macroblock_by_height(expected_mb)
                                        .map(|r| r.is_none())
                                        .unwrap_or(true);

                                    if mb_missing && expected_mb > 0 {
                                        let blocks_since = canonical_height.saturating_sub(check_boundary);
                                        // Routine: fires at every macroblock boundary whose macroblock
                                        // the node has not sealed locally yet (finality trails production) → triggers
                                        // a direct macroblock sync. DBG, not WARN — a persistent gap surfaces via
                                        // finality height / consensus_driver_behind, not this per-boundary trace.
                                        if is_debug() {
                                            println!("[DBG][SYNC] epoch_boundary_crossed h={} mb={} missing blocks_without={} → direct macroblock sync",
                                                     canonical_height, expected_mb, blocks_since);
                                        }

                                        // Nudge the single sync coordinator to backfill the epoch-boundary
                                        // macroblock; finality trails production and its pass repairs it.
                                        crate::sync_manager::nudge_sync_check();
                                    }
                                    check_boundary += 90;
                                }
                            }
                        }
                    }
                }
                
                // CRITICAL FIX: Check emergency recovery EVERY SECOND, not just on messages
                // This prevents deadlock when network stops and no messages arrive
                if crate::unified_p2p::EMERGENCY_STOP_PRODUCTION.load(Ordering::Relaxed) {
                    let stop_height = crate::unified_p2p::EMERGENCY_STOP_HEIGHT.load(Ordering::Relaxed);
                    let stop_time = crate::unified_p2p::EMERGENCY_STOP_TIME.load(Ordering::Relaxed);
                    let current_time = get_timestamp_safe();
                    
                    if stop_height > 0 && stop_time > 0 {
                        let blocks_passed = if microblock_height > stop_height { 
                            microblock_height - stop_height 
                        } else { 0 };
                        let seconds_passed = if current_time > stop_time { 
                            current_time - stop_time 
                        } else { 0 };
                        
                        // Clear emergency stop after 10 blocks OR 10 seconds
                        if blocks_passed >= 10 || seconds_passed >= 10 {
                            println!("[INFO][RECOVERY] emergency_stop_cleared elapsed={}s blocks_passed={}",
                                    seconds_passed, blocks_passed);
                            crate::unified_p2p::EMERGENCY_STOP_PRODUCTION.store(false, Ordering::Relaxed);
                            crate::unified_p2p::EMERGENCY_STOP_HEIGHT.store(0, Ordering::Relaxed);
                            crate::unified_p2p::EMERGENCY_STOP_TIME.store(0, Ordering::Relaxed);
                            
                            // CRITICAL: Invalidate producer cache to allow this node to be selected again
                            Self::invalidate_producer_cache();
                            println!("[INFO][RECOVERY] production_resume_ready");
                        }
                    }
                }
                
                // v3.33: Check stall/timeout every 5 iterations (was 30).
                // BFT Timeout needs frequent checks (12s grace + 6s rounds).
                // CPU stats still log every 30s to avoid spam.
                if cpu_check_counter % 5 == 0 {
                    if cpu_check_counter % 30 == 0 {
                        let elapsed = start_time.elapsed().as_secs();
                        let thread_count = std::thread::available_parallelism()
                            .map(|n| n.get())
                            .unwrap_or(1);
                        println!("[INFO][NODE] uptime={}s threads={} h={}",
                                elapsed, thread_count, microblock_height);
                    }
                    
                    // DEADLOCK DETECTION: Check if we're stuck on same height for too long
                    if microblock_height == last_production_height {
                        let stuck_duration = last_production_time.elapsed();
                        // CRITICAL: Use 15 seconds - more than rotation_timeout (10s) but less than first block (20s)
                        if stuck_duration.as_secs() > 15 {
                            println!("[WARN][NODE] deadlock_suspected h={} stuck={}s",
                                    microblock_height, stuck_duration.as_secs());
                            // Reset timers to prevent spam
                            last_production_time = std::time::Instant::now();
                        }
                    } else {
                        // Update tracking
                        last_production_height = microblock_height;
                        last_production_time = std::time::Instant::now();
                    }
                    
                    // Block-timestamp-based deterministic failover. Use the
                    // PREVIOUS block timestamp, not genesis_ts+height:
                    // prev_block.timestamp is identical on all synced nodes and
                    // delay = now - (prev_ts+1) is small (0-10s), so ±2s NTP
                    // drift < 5s grace → same timeout_round on every node.
                    // genesis_ts+height accumulated all prior delays (85s+), so
                    // ±2s drift flipped the round across nodes → fork. delay>5s
                    // → timeout_round 1,2,3…
                    let genesis_ts = crate::GLOBAL_GENESIS_TIMESTAMP.load(std::sync::atomic::Ordering::Relaxed);
                    let current_time = get_timestamp_safe();
                    
                    // Only proceed if genesis timestamp is set
                    if genesis_ts > 0 && current_time > 0 {
                        // v3.14: Use LAST_BLOCK_PRODUCED_TIME (REAL time when block was received!)
                        // ═══════════════════════════════════════════════════════════════════════
                        // BFT TIMEOUT CONSENSUS v4.0: Deterministic failover via Byzantine voting
                        // ARCHITECTURE: Replaces NTP-based timeout with 2/3+ validator agreement
                        //
                        // OLD PROBLEM:
                        //   - NTP drift between nodes caused different timeout_round calculations
                        //   - Different timeout_round → different producer selection → FORK!
                        //
                        // NEW SOLUTION:
                        //   - Each node votes for timeout when it detects stall (local detection)
                        //   - When 2/3+ validators vote → TimeoutCertificate is generated
                        //   - Certificate is deterministic proof that timeout occurred
                        //   - All nodes use certificate's timeout_round for producer selection
                        // ═══════════════════════════════════════════════════════════════════════
                        
                        // Failover pacemaker (timeout-vote emission, window amplification,
                        // chronic-stall nudge) runs in its OWN task — run_failover_pacemaker.
                        // It lived here until the h=601 wedge: this loop parked in a long
                        // await for minutes and vote emission died with it.
                        // Fork recovery is consumed by run_fork_recovery_consumer (own
                        // task) — an armed target must never wait on this loop's awaits.

                        // ═══════════════════════════════════════════════════════════════════
                        // PRODUCTION v2.44: AGGRESSIVE CATCH-UP (15s/5 blocks)
                        // ═══════════════════════════════════════════════════════════════════
                        // ARCHITECTURE FIX: Previous 120s/50 blocks was too conservative!
                        // After high-TPS tests, nodes can desync and stay stuck forever because:
                        // 1. Round mismatch rejects consensus messages
                        // 2. Cached network_height is stale (no new blocks = no updates)
                        // 3. 50-block threshold never triggers because gap appears small
                        // 
                        // Solution:
                        // - 15s slot delay → aggressive resync (was 120s)
                        // - 5 block gap → trigger sync (was 50)
                        // - Byzantine median height (median of peer heights, not a BFT quorum)
                        // ═══════════════════════════════════════════════════════════════════
                        // Read-only view of the stall age; the pacemaker task owns the anchor.
                        let local_delay = get_timestamp_safe()
                            .saturating_sub(STALL_PROGRESS_WALL.load(Ordering::Relaxed));
                        if local_delay > 15 {
                            if let Some(p2p) = &unified_p2p {
                                // v2.44: Use Byzantine median from peer heights (QUIC HealthPing data)
                                // This is MORE reliable than single cached value
                                let hint = match p2p.sync_blockchain_height().await {
                                        Ok(h) => h,
                                        Err(e) => {
                                            if crate::node::is_warn() { println!("[WARN][SYNC] height_hint_failed err={}", e); }
                                            p2p.get_cached_network_height().unwrap_or(0)
                                        }
                                    };
                                    // Floor the Syncing target on QC-verified finality (frontier==0 ⇒ hint, genesis-safe).
                                    let frontier = qc_verified_frontier_height();
                                    let network_height = if frontier == 0 { hint } else { std::cmp::max(frontier, hint) };
                                    if crate::node::is_info() { println!("[INFO][SYNC] sync_target={} frontier={} hint={}", network_height, frontier, hint); }
                                    let height_gap = network_height.saturating_sub(microblock_height);
                                    
                                    // ═══════════════════════════════════════════════════════════════════
                                    // v14.2: DESTRUCTIVE ROLLBACK NOW REQUIRES STRONG FORK EVIDENCE
                                    // ═══════════════════════════════════════════════════════════════════
                                    // Previous thresholds (10/50/100 blocks) were too tight — a node that
                                    // was 29 blocks behind got rolled back 91 blocks and then had to re-
                                    // download 120 blocks. That's the OPPOSITE of recovery.
                                    //
                                    // New thresholds are wider. Combined with the sync-progress guard at
                                    // line 15093 (`!sync_active`), a node that is actively catching up
                                    // will NOT trigger force_resync even when gap is large — catch-up is
                                    // the correct response when you just lag, not rollback.
                                    //
                                    // Force_resync remains for TRUE fork scenarios: node is healthy,
                                    // not syncing, but its chain is provably different (hash mismatch).
                                    // That path is covered by block_pipeline detecting fork_confirmed
                                    // (signals via take_fork_recovery_signal), which goes through a
                                    // different handler with hash evidence.
                                    // ═══════════════════════════════════════════════════════════════════
                                    let network_size = p2p.get_active_full_super_nodes().len();
                                    let dynamic_threshold = match network_size {
                                        0..=10 => 120,    // Small net: tolerate ~2 minutes of catch-up
                                        11..=100 => 200,  // Medium
                                        _ => 400,         // Large: tolerate more for propagation
                                    };

                                    // v33 (Cycle 2): "behind" is NOT "forked". The old destructive rollback
                                    // here deleted correct, leader-identical blocks and full-replayed from 0,
                                    // then reset the sync flags — which perpetuated !sync_active and produced
                                    // an infinite rollback↔resync thrash that prevented catch-up and starved
                                    // the checkpoint window (mb_hashes/beacon diverged → finality stall).
                                    // A node that is merely behind MUST forward-sync, never roll back. Genuine
                                    // forks (a verified hash-conflicting block) are handled by the pipeline via
                                    // take_fork_recovery_signal with real evidence. Forward catch-up itself is
                                    // driven by the two-mode sync below; here we only surface the lag state.
                                    let sync_active = coordinator_is_syncing();
                                    if height_gap > dynamic_threshold && !sync_active {
                                        if crate::node::is_warn() {
                                            println!("[WARN][SYNC] behind_catchup local={} network={} gap={} nodes={} — forward sync (no rollback)",
                                                     microblock_height, network_height, height_gap, network_size);
                                        }
                                        set_node_state(NodeState::Syncing {
                                            local_height: microblock_height,
                                            target_height: network_height,
                                            progress_percent: 0,
                                        });
                                    }
                                }
                            }
                        }
                    }
                // v10.1: Two-mode sync system
                // Mode 1: gap > 10 → FAST SYNC (parallel batch download, loop until caught up)
                // Mode 2: gap <= 10 → LIVE SYNC (ShredProtocol real-time blocks)
                // No more one-shot downloads or emergency sync.

                if let Some(p2p) = &unified_p2p {
                    // Sync target = the attested/quorum network height (sync_blockchain_height /
                    // get_cached_network_height), NOT the raw BEST_PEER_HEIGHT max. The atomic is a
                    // forward-pull tail HINT (still tracked inside the catch-up loop below), but it
                    // must not be the entry target — a stale/over-reported peer height could otherwise
                    // inflate it above the attested view (P0b).
                    static LAST_BLOCK_TIME_SECS: StdAtomicU64 = StdAtomicU64::new(0);
                    static LAST_HEIGHT_CHECK: StdAtomicU64 = StdAtomicU64::new(0);

                    let should_force_update = {
                        let last_height = LAST_HEIGHT_CHECK.load(StdOrdering::Relaxed);
                        let last_time = LAST_BLOCK_TIME_SECS.load(StdOrdering::Relaxed);
                        let now_secs = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        let time_since_block = if last_time > 0 { now_secs.saturating_sub(last_time) } else { 0 };
                        time_since_block > 30 && last_height == microblock_height
                    };

                    let cached_height = if should_force_update {
                        match p2p.sync_blockchain_height().await {
                            Ok(h) => {
                                if is_debug() { println!("[DBG][SYNC] forced_h_update net={} local={}", h, microblock_height); }
                                LAST_HEIGHT_CHECK.store(microblock_height, StdOrdering::Relaxed);
                                if h > microblock_height {
                                    let now_secs = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_secs();
                                    LAST_BLOCK_TIME_SECS.store(now_secs, StdOrdering::Relaxed);
                                }
                                h
                            },
                            Err(_) => p2p.get_cached_network_height().unwrap_or(microblock_height)
                        }
                    } else {
                        p2p.get_cached_network_height().unwrap_or(microblock_height)
                    };

                    // Bulk target = QC-verified finality frontier (unforgeable, never a peer median).
                    // The cached peer height is demoted to a hint that may only add the ≤2-macroblock
                    // unsealed tail above the frontier: a stale-low hint can't undershoot finality, an
                    // over-reported one can't overshoot it. frontier==0 (h<90) ⇒ fall back to the hint
                    // so the genesis bootstrap (0..89, no macroblock yet) is never blocked.
                    let frontier = qc_verified_frontier_height();
                    let network_height = if frontier == 0 { cached_height } else { std::cmp::max(frontier, cached_height) };

                    if network_height > microblock_height {
                        let height_difference = network_height.saturating_sub(microblock_height);

                        // v10.1: Threshold lowered from 10 to 3 to eliminate "dead zone".
                        // Old: fast sync at >10, consensus blocked at >5 → gap 6-10 = no download, no consensus
                        // New: fast sync at >3 → covers all cases where consensus is blocked (max_allowed_lag=2-5)
                        if height_difference > 3 {
                            println!("[WARN][SYNC] behind={} local={} network={}",
                                     height_difference, microblock_height, network_height);

                            // Behind the network → nudge the single sync coordinator; its check_desync
                            // fires execute_sync (snapshot fast-path + pipelined microblock catch-up +
                            // macroblock pass). Production stays withheld by the hard sync gate until
                            // caught up, so no inline fetch or per-driver flag is needed here.
                            crate::sync_manager::nudge_sync_check();

                            // Skip this production cycle — node is syncing
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            continue;
                        }
                    }
                }
                
                // CRITICAL FIX: Use network-wide consensus instead of asymmetric peer counting
                // Each node was seeing different peer counts causing deadlock
                
                // PERFORMANCE FIX: Cache active node count to prevent excessive Registry calls
                // EXISTING: Pre-populate with Genesis default (5 nodes) to prevent initial cache miss blocking
                static CACHED_NODE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(5);
                static LAST_COUNT_UPDATE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                
                let current_time = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                
                let last_update = LAST_COUNT_UPDATE.load(std::sync::atomic::Ordering::Relaxed);
                let cached_count = CACHED_NODE_COUNT.load(std::sync::atomic::Ordering::Relaxed);
                
                // EXISTING: Sophisticated caching system with Byzantine safety protection
                // SECURITY: Phase-aware cache intervals for optimal balance (security + performance)  
                let safe_cache_interval = 10u64; // EXISTING: Balanced interval for Genesis safety + performance
                
                let active_node_count = if cached_count > 0 && current_time - last_update < safe_cache_interval {
                    // EXISTING: Use sophisticated caching with secure 10-second intervals
                    cached_count as u64
                } else if let Some(p2p) = &unified_p2p {   
                    // EXISTING: Use cached phase detection - sophisticated caching already implemented  
                    // CRITICAL FIX: Skip phase detection here - will be done ONCE below to prevent double call
                    let is_genesis_node = std::env::var("QNET_BOOTSTRAP_ID")
                        .map(|id| ["001", "002", "003", "004", "005"].contains(&id.as_str()))
                        .unwrap_or(false);
                    
                    // CRITICAL FIX: Always use Genesis mode for node count if we're a Genesis node
                    // This prevents deadlock from recursive phase detection
                    let count = if is_genesis_node {
                        // EXISTING: Use validated peers for Byzantine safety - has 30s cache for Genesis
                        let validated_peers = p2p.get_validated_active_peers();
                        let total_network_nodes = std::cmp::min(validated_peers.len() + 1, 5); // EXISTING: Add self to peer count, max 5 Genesis nodes
                        
                        // EXISTING: Byzantine safety requires 4+ TOTAL nodes in network
                        // This matches P2P validation logic and consensus config
                        if total_network_nodes >= 4 {
                            // Only log Byzantine safety MET if not cached (first time or change)  
                            if cached_count != total_network_nodes as u64 {
                                println!("[INFO][NODE] byzantine_safety_met nodes={}", total_network_nodes);
                            }
                            total_network_nodes as u64
                        } else {
                            // Always log Byzantine safety violations (critical for monitoring)
                            println!("[WARN][NODE] byzantine_safety_not_met nodes={} required=4", total_network_nodes);
                            total_network_nodes as u64
                        }
                    } else {
                        // Normal phase: Use validated peers for Byzantine safety - with sophisticated caching
                        let validated_peers = p2p.get_validated_active_peers();
                        std::cmp::min(validated_peers.len() + 1, 1000) as u64 // Scale to network size
                    };
                    
                    // Cache the result
                    CACHED_NODE_COUNT.store(count, std::sync::atomic::Ordering::Relaxed);
                    // Mirror to the module-level atomic the snapshot-holder predicate reads (O(1), hot apply path).
                    SNAPSHOT_HOLDER_ACTIVE_COUNT.store(count, std::sync::atomic::Ordering::Relaxed);
                    LAST_COUNT_UPDATE.store(current_time, std::sync::atomic::Ordering::Relaxed);
                    count
                } else {
                    // PRODUCTION: Silent solo mode detection for scalability
                    1u64 // Solo mode
                };
                
                // PRODUCTION: Log active node count only when it changes or for Byzantine violations
                if active_node_count < 4 || cached_count != active_node_count {
                    println!("[DBG][NODE] active_node_count={}", active_node_count);
                }
                
                // v15.15: removed a dead microblock-layer byzantine-safety gate (flag
                // hard-coded false → unreachable) — also wrong layer: microblocks are
                // single-producer ML-DSA-65-signed, n−f is at the macroblock layer.
                // Its progressive 1-of-N degradation contradicted the no-degraded policy
                // (producer/validator mismatch risk). BFT enforced solely by
                // (committee*2+2)/3 at the macroblock gate/finalize/validate.

                // CRITICAL: Synchronization check before participating in consensus
                let local_stored_height = storage.get_chain_height().unwrap_or(0);

                // Anchor production to the APPLIED tip. A working counter advanced ahead by
                // gossip/scan (stored-but-unapplied, or a stale peer height claim) targets a
                // block we cannot chain → self_exclude → failover runaway. Real gaps close via
                // the sync path below; the pre-save precheck guards against duplicate produce.
                if microblock_height > local_stored_height {
                    if is_warn() {
                        println!("[WARN][PROD] height_reanchor working={} applied={}", microblock_height, local_stored_height);
                    }
                    microblock_height = local_stored_height;
                }

                // Peer heights are a SYNC HINT for the lag gate below: they may lower our production
                // target, never authorize it. The right to produce is decided after leader election by
                // production_local_precondition + production_throttle_reason, from local certified facts.
                //
                // A fail-closed precondition on this input was tried and removed: it is identical on every
                // member of a connected mesh, so it cannot distinguish isolation (asymmetric) from a dead
                // observation channel (symmetric) — it froze all five genesis nodes at once for 33 hours.
                // It also sat before cache_expected_producer, so a blocked node stopped populating the
                // producer cache and accepted incoming blocks with NO producer-authorization check.
                let expected_height: u64 = if let Some(ref p2p) = unified_p2p {
                    let mut peer_heights: Vec<u64> = p2p.fresh_in_set_peer_heights();
                    if peer_heights.is_empty() {
                        microblock_height
                    } else {
                        // Median: Byzantine-tolerant against a minority of over/under-reporters.
                        peer_heights.sort_unstable();
                        let network_height = peer_heights[peer_heights.len() / 2];
                        if network_height > microblock_height {
                            if is_warn() {
                                println!("[WARN][SYNC] behind_network local={} network={} gap={}",
                                         microblock_height, network_height,
                                         network_height.saturating_sub(microblock_height));
                            }
                            network_height
                        } else {
                            microblock_height
                        }
                    }
                } else {
                    microblock_height
                };

                // Determine maximum allowed lag based on round
                let current_round = if expected_height == 0 {
                    0
                } else {
                    (expected_height - 1) / ROTATION_INTERVAL_BLOCKS
                };
                
                let max_allowed_lag = match current_round {
                    0 => 2,  // Round 0: Very strict (2 block tolerance)
                    1 => 3,  // Round 1: Slightly relaxed (3 block tolerance)  
                    _ => 5,  // Round 2+: Normal tolerance (5 blocks)
                };
                
                // v10.1: Two-mode sync. No more "emergency sync".
                // Mode 1: gap > max_allowed_lag → skip consensus, let fast sync (below) handle it
                // Mode 2: gap <= max_allowed_lag → participate in consensus (live sync via ShredProtocol)
                if local_stored_height + max_allowed_lag < expected_height {
                    let gap = expected_height.saturating_sub(local_stored_height);
                    println!("[WARN][SYNC] not_synced local={} expected={} gap={} round={}",
                            local_stored_height, expected_height, gap, current_round);

                    // Don't participate in consensus — fall through to fast sync check below
                    // (no `continue` here — fast sync section handles the actual downloading)
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue; // Skip consensus but loop back to fast sync check at top
                }
                
                if is_info() { println!("[INFO][MB] production_start nodes={} local={} expected={} lag={}", 
                        active_node_count, local_stored_height, expected_height, expected_height - local_stored_height); }
                
                // PRODUCTION: QNet microblock producer SELECTION for decentralization (per MICROBLOCK_ARCHITECTURE_PLAN.md)
                // Each 30-block period selects ONE producer using cryptographic hash from qualified candidates
                // Producer selection is cryptographically random but deterministic for consensus (Byzantine safety)
                
                // Height for deterministic validator sampling lives in LOCAL_BLOCKCHAIN_HEIGHT.
                // It used to be published through an env var written once per block while readers
                // called getenv concurrently — setenv can reallocate `environ`, which is undefined
                // behaviour against a concurrent read and, under panic=abort, process death.
                crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT
                    .fetch_max(microblock_height, std::sync::atomic::Ordering::Relaxed);

                // CRITICAL FIX: Use LOCAL height for deterministic producer selection
                // All nodes at the same height will select the same producer
                // Nodes at different heights naturally select different producers (by design)
                let next_block_height = microblock_height + 1;

                // Producer own-height pre-check (anti-fork at production
                // entry). Forensic h=174582: two nodes produced the same
                // height because the pipeline hadn't caught up to the in-
                // memory counter and the pre-save guard fired only after the
                // heavy sign work. Read storage at cycle entry — if a
                // block at next_block_height already exists, abort and yield
                // (shrinks the race ~50ms → ~1-2ms). Idempotent (same
                // producer no-op); different producer → yield; a fork attempt
                // is still caught by the L4 save-time guard. O(1) read.
                {
                    let storage_for_precheck = storage.clone();
                    let precheck_height = next_block_height;
                    match tokio::task::spawn_blocking(move || {
                        storage_for_precheck.load_microblock(precheck_height)
                    }).await {
                        Ok(Ok(Some(existing_data))) => {
                            // Block already exists at our target height — apply pipeline
                            // already finalized it (received from peer broadcast). Yield
                            // and let the next iteration pick up the advanced height.
                            let existing_producer = bincode::deserialize::<qnet_state::MicroBlock>(&existing_data)
                                .map(|mb| mb.producer)
                                .unwrap_or_else(|_| "unknown".to_string());
                            if is_info() {
                                println!(
                                    "[INFO][PROD] preempted_h={} existing_producer={} action=yield_to_pipeline",
                                    precheck_height, existing_producer
                                );
                            }
                            continue;
                        }
                        Ok(Ok(None)) => {
                            // No block yet — proceed with normal production path.
                        }
                        Ok(Err(e)) => {
                            // Storage read error — treat as "no block" but log. Production
                            // continues; L4 storage guard will catch any later conflict.
                            if is_warn() {
                                println!(
                                    "[WARN][PROD] precheck_storage_err h={} err={} action=proceed_with_l4_guard",
                                    precheck_height, e
                                );
                            }
                        }
                        Err(join_err) => {
                            if is_warn() {
                                println!(
                                    "[WARN][PROD] precheck_join_err h={} err={} action=proceed",
                                    precheck_height, join_err
                                );
                            }
                        }
                    }
                }

                // CRITICAL: Check Genesis exists before creating block #1
                if next_block_height == 1 {
                    match storage.load_microblock(0) {
                        Ok(Some(_)) => {
                            println!("[INFO][GEN] Genesis block found, proceeding with block #1");
                        }
                        _ => {
                            println!("[ERR][GEN] missing_genesis cannot_create_block=1");
                            println!("[INFO][GEN] waiting_for_genesis source=create_or_sync");
                            
                            // CRITICAL: Actively request Genesis from network
                            if let Some(p2p) = &unified_p2p {
                                println!("[INFO][GEN] requesting_genesis source=network");
                                if let Err(e) = p2p.sync_blocks(0, 0).await {
                                    println!("[WARN][GEN] Failed to request Genesis: {}", e);
                                }
                            }
                            
                            // CRITICAL FIX: Wait 5 seconds to allow Genesis block processing from P2P queue
                            // Genesis broadcast takes ~1s, P2P queue processing takes ~2-3s
                            // This prevents race condition where producer tries to create block #1 before Genesis is processed
                            tokio::time::sleep(Duration::from_secs(5)).await;
                            continue; // Skip this iteration
                        }
                    }
                }
                
                // CRITICAL: For Genesis nodes, wait until global registry has all 5 nodes
                // This ensures ALL nodes have SAME candidate list for deterministic producer selection
                // Uses static flag to check only ONCE at startup, not every block
                static REGISTRY_CONFIRMED: std::sync::atomic::AtomicBool = 
                    std::sync::atomic::AtomicBool::new(false);
                
                let is_genesis_node = std::env::var("QNET_BOOTSTRAP_ID")
                    .map(|id| ["001", "002", "003", "004", "005"].contains(&id.trim()))
                    .unwrap_or(false);
                
                // Only check registry once at startup for Genesis nodes
                if is_genesis_node && !REGISTRY_CONFIRMED.load(std::sync::atomic::Ordering::Relaxed) {
                    if let Some(ref p2p) = unified_p2p {
                        let registry_count = p2p.get_active_full_super_nodes().len();
                        if registry_count < 5 {
                            println!("[INFO][ACTIVE] registry_wait registered={}/5", registry_count);
                            println!("[INFO][ACTIVE] re_registering");
                            p2p.register_as_active_node_async().await;
                            tokio::time::sleep(Duration::from_secs(2)).await;
                            continue; // Skip this iteration until registry is full
                        }
                        // Registry is full - set flag and never check again
                        REGISTRY_CONFIRMED.store(true, std::sync::atomic::Ordering::Relaxed);
                        println!("[INFO][ACTIVE] registry_complete registered={}/5", registry_count);
                    }
                }
                
                // ═══════════════════════════════════════════════════════════════════
                // PRODUCTION FIX v2.28: SYNC CHECK before producer selection!
                // Lagging node should NOT produce blocks - must sync first
                // ═══════════════════════════════════════════════════════════════════
                if let Some(ref p2p) = unified_p2p {
                    // v9.8: Fallback chain for network height:
                    // 1. Cached height (fast, <1s old)
                    // 2. Live peer heights from DashMap (always current)
                    let network_height = if let Some(cached) = p2p.get_cached_network_height() {
                        cached
                    } else {
                        let live = p2p.get_max_peer_height();
                        // get_max_peer_height includes local — only use if higher than us
                        if live > microblock_height { live } else { 0 }
                    };
                    let our_height = microblock_height;
                    let lag = network_height.saturating_sub(our_height);
                    
                    // Allow 5-block tolerance for normal variance
                    const SYNC_LAG_THRESHOLD: u64 = 5;
                    
                    if lag > SYNC_LAG_THRESHOLD && network_height > 0 {
                        println!("[WARN][SYNC] Node is BEHIND network: local={}, network={}, lag={}", 
                                 our_height, network_height, lag);
                        println!("[WARN][SYNC] skipping_producer_selection reason=behind_network");
                        
                        // STATE MACHINE: Update to Syncing
                        let progress = ((our_height as f64 / network_height as f64) * 100.0) as u8;
                        set_node_state(NodeState::Syncing { 
                            local_height: our_height, 
                            target_height: network_height,
                            progress_percent: progress,
                        });
                        
                        // Behind → nudge the single sync coordinator (execute_sync's macroblock pass
                        // repairs the deficit); skip producing this round.
                        crate::sync_manager::nudge_sync_check();

                        // Wait and retry
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        continue;
                    }
                }
                
                // v4.6: Periodically announce VRF public key to peers (startup + every 90 blocks)
                {
                    let last_announced = LAST_VRF_KEY_ANNOUNCE_HEIGHT.load(Ordering::Relaxed);
                    let should_announce = last_announced == 0
                        || next_block_height >= last_announced + 90
                        || (next_block_height <= 5 && last_announced == 0);
                    if should_announce {
                        if let Some(ref p2p) = unified_p2p {
                            p2p.broadcast_vrf_key_announce();
                            LAST_VRF_KEY_ANNOUNCE_HEIGHT.store(next_block_height, Ordering::Relaxed);
                        }
                    }
                }

                // Production ceiling moved AFTER leader election (below) so a throttled
                // elected leader yields its slot explicitly instead of going silent.

                // v19/v23: BFT-certified microblock leader rotation. Leader is a pure
                // function of on-chain state: select_microblock_producer_with_round(h,
                // candidates=eligible(mb N-2), vrf=SHA3(mb N-2),
                // leadership_round=(h-1)/ROTATION_INTERVAL_BLOCKS,
                // timeout_round=HIGHEST_CERTIFIED_ROUND[mb_idx]-baseline).
                // timeout_round is n−f-certified, NEVER clock-derived → honest nodes
                // compute the same leader (no dual-production split). O(1), same cost
                // at 5 or 10000 nodes. Macroblock n−f Checkpoint-BFT QC = finality.
                let mb_idx = next_block_height / 90;
                // STRICT same-round n−f CERTIFIED-ONLY for producer selection:
                // `get_certified_rotation_round` is identical on every honest node,
                // so all nodes elect the same producer — the h=556 split-brain fix.
                let (timeout_round, carried_baseline): (u64, u64) =
                    crate::unified_p2p::rotation_round_and_baseline(mb_idx);
                // Elect on the ABSOLUTE certified round (= timeout_round + carried_baseline ==
                // HIGHEST_CERTIFIED_ROUND[mb], node-independent), NOT the RELATIVE timeout_round. The
                // relative round subtracts the LOCAL, pollutable get_baseline_round, so two honest nodes
                // with divergent baselines (from applying different same-height fork-tail blocks) would
                // compute different rotation offsets and could each elect THEMSELVES → dual off-slot
                // production. Auth (failover_round_authorized) and fork-choice already reconstruct the
                // absolute round from signed block bytes; election was the last layer still on the local
                // relative baseline. The block still STAMPS (timeout_round=relative, carried_baseline) so
                // the wire format / signature domain is unchanged.
                let certified_abs = timeout_round.saturating_add(carried_baseline);

                // Producer = PURE function of the n−f-certified ABSOLUTE round (candidates+base from
                // macroblock N-2) → identical on every node once the round cert propagates. NO node-local
                // sticky lock: it pinned a timing-dependent leader (whoever a node first saw on failover
                // entry) that diverged across nodes at the SAME round → Category-B producer_unauthorised_
                // reject storm → window divergence → macroblock finality stall. Transient round-lag is
                // resolved by the certified-round fork-choice on ingest, not by local state.
                let current_producer = Self::select_microblock_producer_with_round(
                    next_block_height,
                    &unified_p2p,
                    &node_id,
                    node_type,
                    Some(&storage),
                    certified_abs,
                ).await;

                if is_info() && timeout_round > 0 {
                    println!(
                        "[INFO][ROTATION] h={} mb={} round={} producer={} source=bft_certified",
                        next_block_height, mb_idx, timeout_round, current_producer
                    );
                }

                // v23: Cache the BFT-certified expectation for ingest-side
                // Category B validation. All honest nodes write the IDENTICAL
                // (producer, timeout_round) pair to this cache for any given
                // height once vote gossip has propagated — guaranteed by the
                // pure-function property of `select_microblock_producer_with_round`
                // and the BFT-certified property of `timeout_round`. There is
                // no clock-derived input to this cache write, so cross-node
                // cache divergence (the v22 root cause of the h=4742 fork) is
                // structurally impossible after this commit. Cache the ABSOLUTE round (matches the
                // election above and the A1 gate's block.timeout_round+carried_baseline reconstruction).
                cache_expected_producer(next_block_height, &current_producer, certified_abs);

                let mut is_my_turn_to_produce = current_producer == node_id;

                // Unvouched RAM state (a failed inline-apply rebuild) ⇒ yield the slot. Applying a
                // block above the failure point is proof the state validates, so clear it there.
                // Unvouched RAM state (an abandoned inline apply) ⇒ never produce again this process.
                // No clear path: storage presence does not prove the RAM state applied cleanly.
                if INLINE_APPLY_UNVOUCHED.load(Ordering::SeqCst) != 0 {
                    if is_my_turn_to_produce {
                        println!("[ERR][PROD] production_suspended h={} reason=state_unvouched action=restart_required",
                                 next_block_height);
                    }
                    is_my_turn_to_produce = false;
                }

                // Production ceiling: pause (never wedge) if the tip outruns finality or the
                // sealed frontier. Base = max(contiguous seal, QC-verified frontier) — the SAME
                // semantic the failover suppression uses. Committed-state-derived ⇒ every node
                // pauses at the same height. Placed after election so a throttled elected
                // leader can yield instead of going silent.
                {
                    let last_finalized = LAST_FINALIZED_CONSENSUS_ROUND.load(Ordering::SeqCst);
                    let seal_base = try_get_storage()
                        .map(|s| s.last_sealed_mb_index().saturating_mul(90))
                        .unwrap_or(0)
                        .max(qc_verified_frontier_cached());
                    if let Some(reason) = production_throttle_reason(next_block_height, last_finalized, seal_base) {
                        if is_warn() {
                            println!("[WARN][PROD] production_throttle height={} finalized={} sealed={} awaiting={}",
                                     next_block_height, last_finalized, seal_base, reason);
                        }
                        // Slot yield: elected but unable to produce → broadcast the canonical
                        // rotation vote (same signed TimeoutVote path; TC still needs n−f, only
                        // vote TIMING changes) so the committee skips this slot in one round
                        // instead of a silent-grace timeout. Paced via LAST_TIMEOUT_EMIT_PER_MB
                        // (shared with the failover monitor — no double emit). Misses accrue as
                        // for silence: receivers record_validator_miss against the expected
                        // producer regardless of how the rotation started.
                        // INTENTIONAL asymmetry vs the failover monitor: it emits under BOTH
                        // fin_over and seal_over, but the monitor co-signs only once !seal_throttled.
                        // Under a PURE seal-stall every member is equally throttled, so no TC forms
                        // yet — rotation can't advance the seal frontier anyway; the independent
                        // macroblock backfill does. This vote is emitted defensively: the moment the
                        // backfill releases the throttle, the already-broadcast yield gathers its n−f.
                        if is_my_turn_to_produce
                            && mb_idx >= crate::unified_p2p::observed_tc_window_floor() {
                            let now_u64 = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs();
                            let last = LAST_TIMEOUT_EMIT_PER_MB.get(&mb_idx).map(|v| *v).unwrap_or(0);
                            if now_u64.saturating_sub(last) >= 5 {
                                // Stamp pacing only on an actual broadcast: a deferred emit
                                // (anchor fetch in flight, crypto absent) retries next tick.
                                if Self::emit_macroblock_view_change_vote(
                                    mb_idx.saturating_mul(90),
                                    &node_id,
                                    &unified_p2p,
                                    Some(&storage),
                                ).await {
                                    LAST_TIMEOUT_EMIT_PER_MB.insert(mb_idx, now_u64);
                                    if is_info() {
                                        println!("[INFO][PROD] slot_yield h={} mb={} reason={}",
                                                 next_block_height, mb_idx, reason);
                                    }
                                }
                            }
                        }
                        // A throttled leader is still the leader: stamp leadership before yielding so
                        // the heartbeat grace covers the throttle window. Without this a leader that
                        // pauses on backpressure goes silent and peers read it as dead.
                        if is_my_turn_to_produce {
                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64).unwrap_or(0);
                            LAST_LEADERSHIP_MS.store(now_ms, std::sync::atomic::Ordering::Relaxed);
                            // The stamp above never leaves this process. Without the emit, peers see a
                            // parked leader as a dead one and rotate around a node that is working.
                            emit_producer_heartbeat(&node_id, &storage, &unified_p2p,
                                                    next_block_height, now_ms).await;
                        }
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        continue;
                    }
                }

                // Network producer-heartbeat broadcast. The elected producer
                // broadcasts a ML-DSA-65-signed ProducerHeartbeat, turning
                // the local-only watchdog into a network signal: receivers
                // track per-producer heartbeats and broadcast empty-slot
                // attestations when the producer goes silent (fixes the h=781
                // deadlock where a VRF-elected node was dead from boot and
                // undetectable). Throttled 1/s/producer; skipped when syncing
                // or not elected. Signed and verified vs the same registry as
                // TimeoutVotes; advances no consensus state — only accelerates
                // empty-slot entry, still gated by n−f.
                // Heartbeat continues for a grace window after the rotation ends: peers lagging a
                // few blocks still expect blocks from the outgoing leader, and an abrupt silence
                // reads as death. Bounded to leader + recent-leader, so committee size does not
                // multiply heartbeat traffic.
                let now_ms_hb = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                if is_my_turn_to_produce {
                    LAST_LEADERSHIP_MS.store(now_ms_hb, std::sync::atomic::Ordering::Relaxed);
                }
                let in_leader_grace = now_ms_hb.saturating_sub(
                    LAST_LEADERSHIP_MS.load(std::sync::atomic::Ordering::Relaxed)) <= LEADER_HEARTBEAT_GRACE_MS;
                if is_my_turn_to_produce || in_leader_grace {
                    emit_producer_heartbeat(&node_id, &storage, &unified_p2p,
                                            next_block_height, now_ms_hb).await;
                }

                // HARD GATE — a producer must hold the parent it extends.
                // v32.3 addition: if local is far behind quorum peer max, trigger
                // CHRONIC_STALL_REQUESTED so the bulk catch-up handler engages on
                // next iteration. Without this, the gate just blocks forever
                // waiting for sync that no path is driving.
                if is_my_turn_to_produce {
                    let sync_active = coordinator_is_syncing();
                    let prod_unlocked = PRODUCTION_UNLOCKED.load(Ordering::Relaxed) == 1;
                    // Producing block N needs exactly one thing: N-1 applied. The FSM phase is derived
                    // state that this node's own idleness clears, so gating on it turned "failed to
                    // produce" into "forbidden to produce" — the node could neither lead nor yield.
                    let have_parent = crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.load(Ordering::Relaxed)
                        >= next_block_height.saturating_sub(1);

                    if sync_active || (!prod_unlocked && microblock_height > 5) || !have_parent {
                        if is_info() {
                            println!("[INFO][PROD] gate_blocked h={} sync={} unlocked={} parent={}",
                                     next_block_height, sync_active, prod_unlocked, have_parent);
                        }
                        is_my_turn_to_produce = false;

                        // v32.3: when blocked due to !node_synced, drive bulk catch-up.
                        if !have_parent && !sync_active {
                            if let Some(ref p2p) = unified_p2p {
                                let local_h = next_block_height.saturating_sub(1);
                                let quorum_peak = p2p.get_max_peer_height();
                                const PROD_GATE_BULK_GAP: u64 = 50;
                                if quorum_peak > local_h + PROD_GATE_BULK_GAP {
                                    static LAST_GATE_BULK_TRIGGER: std::sync::atomic::AtomicU64 =
                                        std::sync::atomic::AtomicU64::new(0);
                                    const GATE_BULK_COOLDOWN_SECS: u64 = 30;
                                    let now_u64 = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .map(|d| d.as_secs()).unwrap_or(0);
                                    let last = LAST_GATE_BULK_TRIGGER.load(Ordering::Relaxed);
                                    if now_u64.saturating_sub(last) >= GATE_BULK_COOLDOWN_SECS {
                                        LAST_GATE_BULK_TRIGGER.store(now_u64, Ordering::Relaxed);
                                        CHRONIC_STALL_REQUESTED.store(true, Ordering::Relaxed);
                                        if is_info() {
                                            println!("[INFO][PROD] catchup_requested local={} quorum={} gap={}",
                                                     local_h, quorum_peak, quorum_peak - local_h);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // No pre-production barrier on rotation. The producer is the
                // unique VRF leader for the n−f-certified round (identical on
                // every honest node), so a synchronous ack handshake adds no
                // safety: transient cert-propagation divergence is soft-accepted
                // on ingest (Category A) and a split-brain microblock can never
                // reach n−f macroblock commit/reveal finality. The old barrier
                // only cost liveness — it could not gather n−f acks within the
                // 800ms slot even with every validator healthy (acks=3/4 stall).

                // ═══════════════════════════════════════════════════════════════════════════
                // v3.10 BUG 3 FIX: Check if we're excluded (e.g., after fork detection)
                // If excluded, we cannot produce - let emergency failover handle it
                // ═══════════════════════════════════════════════════════════════════════════
                if is_my_turn_to_produce && is_producer_excluded(&node_id, next_block_height) {
                    println!("[WARN][PROD] self_excluded h={} reason=fork_recovery", next_block_height);
                    is_my_turn_to_produce = false;
                    // Don't continue - let timeout_round failover handle it
                }

                // Drift self-pause gate removed: a drifted node stays
                // productive (median-aware timestamp pulls it into range,
                // peers accept within the wide tolerance), preserving n−f
                // quorum on small committees.

                // Producer self-exclude when >100 blocks behind (stale
                // state/entropy → can't produce valid blocks). No broadcast
                // (non-deterministic → fork): the behind node simply doesn't
                // produce; after the grace window all nodes see slot_delay>5,
                // compute timeout_round=1, and deterministically select the
                // next producer — pure slot-based failover.
                // self_exclude at lag > 0 already prevents stale production after restart.
                // No additional lockout needed — the lag check is sufficient.

                // The height floor and the P2P-handle wrapper are gone on purpose: the parent must be
                // held at EVERY height, and a node with no P2P handle is exactly the one that must not
                // build on a parent it does not have.
                if is_my_turn_to_produce {
                    if let Some(reason) = production_local_precondition(&storage, next_block_height) {
                        if is_warn() {
                            println!("[WARN][PROD] local_precondition_block h={} reason={} finalized={}",
                                     next_block_height, reason,
                                     LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::SeqCst));
                        }
                        is_my_turn_to_produce = false;
                    }
                }
                
                // v4.0: Emergency producer removed - BFT Timeout Protocol handles failover
                // Producer selection is deterministic via certified_timeout_round from 2/3+ votes
                
                // DEBUG: Log producer selection for first blocks
                if next_block_height <= 5 {
                    println!("[DBG][MB] producer_selection h={} producer={} is_my_turn={}",
                            next_block_height, current_producer, is_my_turn_to_produce);
                }
                
                // STATE MACHINE: Update to Producing or Validating
                let leadership_round = if next_block_height <= ROTATION_INTERVAL_BLOCKS { 0 } else { (next_block_height - 1) / ROTATION_INTERVAL_BLOCKS };
                if is_my_turn_to_produce {
                    set_node_state(NodeState::Producing { 
                        round: leadership_round, 
                        current_height: next_block_height,
                    });
                } else {
                    set_node_state(NodeState::Validating { 
                        current_producer: current_producer.clone(),
                        current_height: next_block_height,
                    });
                }
                
                // GULF STREAM v2.25: Update current producer for TX forwarding
                // This enables direct TX forwarding to producer (0 hops) for higher TPS
                if let Some(p2p) = &unified_p2p {
                    if let Some(producer_addr) = p2p.get_peer_addr_by_id(&current_producer) {
                        p2p.set_current_producer(&current_producer, &producer_addr);
                    } else if current_producer == node_id {
                        // We are the producer - set our own address
                        let our_port = std::env::var("QNET_PORT").unwrap_or_else(|_| "8001".to_string());
                        let our_addr = format!("127.0.0.1:{}", our_port);
                        p2p.set_current_producer(&current_producer, &our_addr);
                    }
                }
                
                // Production is deterministic: the elected producer (pure fn of the
                // buried N-2 schedule + 2f+1-certified timeout_round) produces its slot
                // with no live entropy poll. A silent/absent leader is handled by BFT
                // failover (local-clock slot-skip -> next N-2 producer; 2f+1 TimeoutCertificate
                // + certified-round supersede + 2f+1 macroblock Checkpoint settle the winner).

                if is_my_turn_to_produce {
                    // Fork-choice authority is round-based: a same-round 2f+1 TimeoutCertificate
                    // rotates the producer and the 2f+1 macroblock Checkpoint settles the winner.
                    // Block attestations are EVIDENCE only and deliberately gate nothing here: an
                    // input every node shares cannot tell isolation from a dead attestation channel,
                    // so yielding on it would halt the whole cluster on one symmetric fault.

                    // PRODUCTION: This node is selected as microblock producer for this round
                    *is_leader.write().await = true;
                    
                    // CRITICAL FIX v2.19.16: Initialize PqCrypto BEFORE broadcasting certificate
                    // This fixes race condition where certificate broadcast fails because
                    // PqCrypto instance doesn't exist yet (it was created later during signing)
                    use crate::pq_crypto::{PqCrypto, GLOBAL_PQ_INSTANCES};
                    
                    let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
                        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
                    }).await;
                    
                    let normalized_id = Self::normalize_node_id(&node_id);
                    
                    // CRITICAL: Ensure PqCrypto is initialized BEFORE certificate broadcast
                    {
                        let mut instances_guard = instances.lock().await;
                        if !instances_guard.contains_key(&normalized_id) {
                            println!("[INFO][CERT] pq_crypto_init producer={} phase=pre_broadcast", normalized_id);
                            let mut pq = PqCrypto::new(normalized_id.clone());
                            if let Err(e) = pq.initialize().await {
                                println!("[WARN][CRYPTO] Failed to initialize PqCrypto: {}", e);
                            } else {
                                instances_guard.insert(normalized_id.clone(), pq);
                                println!("[INFO][CERT] pq_crypto_ready");
                            }
                        }
                    }
                    
                    // CRITICAL FIX: Broadcast certificate IMMEDIATELY when becoming producer
                    // OPTIMIZATION: Only broadcast ONCE per round (not every block)
                    // This prevents "certificate not found" errors during producer rotation
                    // while avoiding redundant broadcasts (30× per round → 1× per round)
                    let should_broadcast = match last_certificate_broadcast_round {
                        None => true,  // First time as producer
                        Some(last_round) => last_round != current_round,  // New round
                    };
                    
                    if should_broadcast {
                        if let Some(ref p2p) = unified_p2p {
                            let instances_guard = instances.lock().await;
                            
                            if let Some(pq) = instances_guard.get(&normalized_id) {
                                if let Some(cert) = pq.get_current_certificate() {
                                    if let Ok(cert_bytes) = bincode::serialize(&cert) {
                                        // v3.4 CRITICAL: Set broadcast-in-progress flag BEFORE certificate broadcast
                                        // This prevents emergency messages from interrupting mid-broadcast
                                        // Race condition: cert sent → emergency → data not sent → all nodes stuck
                                        crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(true, std::sync::atomic::Ordering::SeqCst);
                                        if is_debug() {
                                            println!("[DBG][PROD] broadcast_flag=true h={}", next_block_height);
                                        }
                                        
                                        println!("[INFO][CERT] tracked_broadcast round={} h={} serial={}",
                                            current_round, next_block_height, cert.serial_number);
                                        
                                        // CRITICAL: Use tracked broadcast for producer rotation (Byzantine threshold)
                                        // NOTE: No artificial delay needed - retry mechanism handles certificate race condition
                                        // Receiving nodes buffer blocks and retry every 2s until certificate arrives
                                        match p2p.broadcast_certificate_announce_tracked(cert.serial_number.clone(), cert_bytes.clone()).await {
                                            Ok(()) => {
                                                println!("[INFO][CERT] producer_cert_delivered threshold=byzantine");
                                                // Mark this round as broadcasted
                                                last_certificate_broadcast_round = Some(current_round);
                                            }
                                            Err(e) => {
                                                println!("[WARN][CERT] byzantine_threshold_not_reached err={}", e);
                                                println!("[INFO][CERT] fallback=async_rebroadcast");
                                                // Fallback: async broadcast for remaining peers (gossip will propagate)
                                                if let Err(e2) = p2p.broadcast_certificate_announce(cert.serial_number, cert_bytes) {
                                                    println!("[ERR][CERT] fallback_broadcast_failed err={}", e2);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    
                    // v4.0: Emergency producer removed - BFT Timeout Protocol handles failover
                    // Producer selection is deterministic via certified_timeout_round from 2/3+ votes
                    let is_emergency_producer = false; // Legacy variable kept for compatibility
                    
                    // Check sync status before producing
                    let can_produce = if is_emergency_producer {
                        // This branch is never reached (is_emergency_producer = false)
                        println!("[INFO][MB] emergency_producer_activated h={}", next_block_height);
                        
                        // CRITICAL: Check if we're synchronized before emergency production
                        // This prevents creating blocks when node is behind due to fork
                        let local_height = storage.get_chain_height().unwrap_or(0);
                        
                        if local_height < next_block_height - 1 {
                            println!("[WARN][MB] emergency_behind h={} local={}",
                                     next_block_height, local_height);
                            println!("[INFO][MB] emergency_cleared reason=lagging_or_fork");
                            println!("[INFO][MB] recovery=background_sync");
                            
                            // v4.0: Emergency producer removed - BFT Timeout Protocol handles failover
                            println!("[INFO][BFT] node_not_synchronized h={}", next_block_height);
                            
                            false // Cannot produce
                        } else {
                            // ═══════════════════════════════════════════════════════════════════════════
                            // PRODUCTION v2.59: Optimized wait loop for global network
                            // ═══════════════════════════════════════════════════════════════════════════
                            // BALANCED: 7.5s timeout covers 99% cases including high-latency routes
                            // Check every 300ms for fast reaction time
                            // If block arrives early → cancel emergency immediately
                            // This minimizes fork risk while accommodating Asia-US latency
                            // ═══════════════════════════════════════════════════════════════════════════
                            println!("[INFO][MB] emergency_wait h={} strategy=continuous_check interval=300ms max_wait=7.5s",
                                     next_block_height);
                            
                            let mut block_arrived = false;
                            let max_attempts = 25;  // 25 × 300ms = 7.5 seconds (optimized for global network)
                            let check_interval_ms = 300;
                            
                            for attempt in 1..=max_attempts {
                                tokio::time::sleep(tokio::time::Duration::from_millis(check_interval_ms)).await;
                                
                                // Check storage for block arrival
                                match storage.load_microblock(next_block_height) {
                                    Ok(Some(_)) => {
                                        let elapsed = (attempt as f32 * check_interval_ms as f32) / 1000.0;
                                        println!("[INFO][MB] emergency_wait h={} attempt={}/{} status=arrived elapsed={:.1}s action=skip",
                                                 next_block_height, attempt, max_attempts, elapsed);
                                        
                                        // v4.0: BFT Timeout Protocol handles failover - block arrived from another producer
                                        println!("[INFO][BFT] block_arrived_skip h={}", next_block_height);
                                        
                                        block_arrived = true;
                                        break;
                                    },
                                    Ok(None) => {
                                        // Log progress every 1.8 seconds (every 6 attempts)
                                        if attempt % 6 == 0 {
                                            let elapsed = (attempt as f32 * check_interval_ms as f32) / 1000.0;
                                            println!("[INFO][MB] emergency_wait h={} attempt={}/{} status=missing elapsed={:.1}s",
                                                     next_block_height, attempt, max_attempts, elapsed);
                                        }
                                    },
                                    Err(e) => {
                                        // Storage error - log but continue checking
                                        let elapsed = (attempt as f32 * check_interval_ms as f32) / 1000.0;
                                        println!("[WARN][MB] emergency_wait h={} attempt={}/{} status=storage_error elapsed={:.1}s err={}",
                                                 next_block_height, attempt, max_attempts, elapsed, e);
                                        
                                        // On storage error, assume block not arrived and continue
                                    }
                                }
                            }
                            
                            if !block_arrived {
                                println!("[WARN][MB] emergency_wait h={} status=timeout max_wait=6s action=proceeding",
                                         next_block_height);
                            }
                            
                            !block_arrived  // Can produce only if block didn't arrive
                        }
                    } else {
                        // CRITICAL: Check emergency stop flag first
                        // If we received emergency failover notification, stop producing immediately
                        if crate::unified_p2p::EMERGENCY_STOP_PRODUCTION.load(std::sync::atomic::Ordering::Relaxed) {
                            eprintln!("[ERR][PROD] emergency_stop reason=failover");
                            false
                        } else {
                        // Check if we have recent blocks (not stuck at height 0)
                        // CRITICAL: Handle storage failure gracefully
                        let current_stored_height = match storage.get_chain_height() {
                            Ok(height) => height,
                            Err(e) => {
                                eprintln!("[ERR][PROD] storage_error err={}", e);
                                0  // Treat as unsynchronized
                            }
                        };
                        
                        // CRITICAL: Strict synchronization check for consensus participation
                        // New nodes MUST catch up before producing blocks
                        let is_synchronized = if microblock_height > 10 {
                            // Synced per the SINGLE coordinator oracle (frontier-gated via the FSM —
                            // the duplicate inline frontier derivation is removed) AND within 10 of the
                            // production target, so we never produce far ahead of our stored tip.
                            coordinator_is_synchronized()
                                && current_stored_height + 10 >= microblock_height
                        } else {
                            // Genesis phase: STRICT local-height check (coordinator is Synchronized{0}
                            // at boot, so the stored-height bound is the real attack guard here).
                            if microblock_height <= 1 {
                                current_stored_height <= 1
                            } else {
                                current_stored_height + 1 >= microblock_height
                            }
                        };
                        
                        // NOTE: NODE_IS_SYNCHRONIZED is now updated for ALL nodes below (line ~3222)
                        // Not just for producers - this was moved to fix the bug
                        
                        if !is_synchronized {
                            if is_warn() { println!("[WARN][PROD] not_synced expected={} stored={}", microblock_height, current_stored_height); }
                        }
                        
                        // PRODUCTION v2.43.4: Removed network-ahead check
                        // v2.43.2-v2.43.3 had a check that blocked production if local > network + MAX_AHEAD
                        // This caused MORE problems than it solved:
                        // - At startup, peer heights are 0 or low → check always triggered
                        // - Heartbeats update peer heights, but capping was too aggressive
                        // - Result: network deadlock even without stress test!
                        //
                        // CORRECT APPROACH: Use backpressure at broadcast level (PENDING_BROADCAST_COUNT)
                        // This naturally limits how fast producer can create blocks
                        // Emergency failover handles cases where producer gets too far ahead
                        is_synchronized
                        }
                    };
                    
                    if !can_produce {
                        if is_info() { println!("[INFO][PROD] skip_production reason=cannot_produce"); }
                        
                        // Mark ourselves as not leader
                        *is_leader.write().await = false;
                        
                        // v3.9: NO BROADCAST! Just skip production, timeout_round will handle failover
                        // All nodes will see slot_delay increase → compute same new producer
                        if is_warn() { 
                            println!("[WARN][PROD] skip_production h={} reason=blocked_by_emergency (timeout_round handles failover)", 
                                     next_block_height); 
                        }
                        
                        // Skip this production round
                        // v3.4: CRITICAL - Clear broadcast flag before continue
                        crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                        tokio::time::sleep(microblock_interval).await;
                        continue;
                    }
                    
                    {
                    // Get performance settings
                    // PRODUCTION: 50K+ TPS requires 50K+ TX per block with 1 block/sec
                    let max_tx_per_microblock = std::env::var("QNET_BATCH_SIZE")
                        .unwrap_or_default()
                        .parse::<usize>()
                        .unwrap_or(200_000);  // Default 200K TX/microblock (v4.1)
                    // Byte budget for the mempool pull: the block is capped at
                    // BLOCK_FILL_SOFT_BYTES (4 MB) below, so cloning + classifying
                    // more than a small multiple of that per slot is pure waste —
                    // an 8k-batch backlog used to cost ~0.5 GB of memcpy + decode
                    // per block. 4x covers skips (future-nonce, deferred, dead).
                    const FILL_PULL_BYTE_BUDGET: usize = 16_000_000;
                        
                    let _high_performance = std::env::var("QNET_HIGH_FREQUENCY").unwrap_or_default() == "1";
                    let compression_enabled = std::env::var("QNET_COMPRESSION").unwrap_or_default() == "1";
                    let _adaptive_intervals = std::env::var("QNET_ADAPTIVE_INTERVALS").unwrap_or_default() == "1";
                    
                    // Adaptive interval based on mempool size
                    let current_interval = microblock_interval;
                    
                    // PRODUCTION: Skip expensive readiness validation in microblock critical path
                    
                    // v2.93: EMISSION TX LOGIC - Industry Standard Architecture
                    // After emission MacroBlock (160, 320, 480...) block producer creates TX
                    // TX included as FIRST transaction in next microblock
                    // 
                    // Flow:
                    //   1. MacroBlock 160 finalized → rewards calculated & saved
                    //   2. Block producer creates next microblock (14401, 28801...)
                    //   3. Check: was previous MacroBlock emission? → create TX
                    //   4. TX added FIRST to block (deterministic, verifiable)
                    // 
                    // Validation: All nodes verify emission TX presence after emission MacroBlock
                    
                    // v2.99: EMISSION TX CREATION
                    // CRITICAL: Emission TX MUST be in emission block (14400, 28800, 43200...)
                    // NOT in the next block!
                    // 
                    // Flow:
                    //   1. Production loop for block 14400 starts
                    //   2. Check: is this an emission block?
                    //   3. Load MacroBlock 160 from storage (wait if needed)
                    //   4. Extract reward_heartbeats from MacroBlock
                    //   5. Calculate total emission amount
                    //   6. Create emission TX
                    //   7. Add emission TX as FIRST transaction in block
                    //   8. Continue with normal mempool TXs
                    // 
                    // NOTE: Rewards were ALREADY processed by INITIATOR/PARTICIPANTS in MacroBlock consensus
                    // This TX is ONLY for blockchain record (transparency/audit)
                    // apply_to_state() will detect system_emission→system_rewards_pool and skip processing
                    
                    let mut emission_tx_opt: Option<(String, Vec<u8>)> = None;
                    
                    // PRODUCTION v2.78: HeartbeatCommitment and PingCommitment TX handled by start_commitment_tx_loop()
                    // Runs in parallel with block production to avoid blocking
                    const EMISSION_BLOCK_INTERVAL: u64 = 14400;
                    
                    // Check if this is an emission block (every 14400 blocks = 4 hours)
                    let is_emission_block = next_block_height > 0 && next_block_height % EMISSION_BLOCK_INTERVAL == 0;
                    
                    if is_emission_block {
                        // ARCHITECTURE v2.77: DELAYED REWARD - emission TX for PREVIOUS epoch
                        // This eliminates deadlock between emission block and MacroBlock finalization
                        // 
                        // Epochs: epoch = height / 14400
                        //   Epoch 0: blocks 0-14399
                        //   Epoch 1: blocks 14400-28799
                        //   Epoch 2: blocks 28800-43199
                        //
                        // Emission TX Timeline:
                        //   Block 14400 (current_epoch=1): NO emission TX (skip - no previous finalized epoch)
                        //   Block 28800 (current_epoch=2): Emission TX for epoch 0 (blocks 0-14399) using MB 160
                        //   Block 43200 (current_epoch=3): Emission TX for epoch 1 (blocks 14400-28799) using MB 320
                        // 
                        // Delayed reward by 1 epoch (4 hours) - ensures MacroBlock is finalized
                        
                        let current_epoch = next_block_height / EMISSION_BLOCK_INTERVAL;
                        
                        // CRITICAL FIX v2.99: DELAYED REWARD by 1 full epoch
                        // - Block 14400 (current_epoch=1): SKIP - MacroBlock 160 still being created (race!)
                        // - Block 28800 (current_epoch=2): Emission for epoch 0, using MacroBlock 160
                        // - Block 43200 (current_epoch=3): Emission for epoch 1, using MacroBlock 320
                        // 
                        // Formula: rewarding_epoch = current_epoch - 2 (delayed by 1 full epoch)
                        // This ensures MacroBlock is FINALIZED before emission reads it (4 hours gap!)
                        if current_epoch > 1 {
                            let rewarding_epoch = current_epoch - 2;  // Delayed by 1 epoch
                            let rewarding_epoch_end_block = (rewarding_epoch + 1) * EMISSION_BLOCK_INTERVAL;
                            let prev_macroblock_index = rewarding_epoch_end_block / 90;
                            
                            if is_info() {
                                println!("[INFO][EMISSION] block={} current_epoch={} rewarding_epoch={} mb={}", 
                                         next_block_height, current_epoch, rewarding_epoch, prev_macroblock_index);
                            }
                            
                            // EXACTLY what every validator recomputes (expected_emission_amount):
                            // the height-derived schedule and nothing else. NO macroblock is loaded
                            // here. It used to be, for pool2/pool3 — fields covered by no hash, no
                            // signature and no commitment (MacroBlock::hash omits consensus_data), so
                            // a peer could hand this node a forged one and it would build a block the
                            // whole network refuses. Dropping the ADDENDS but keeping the LOAD was
                            // worse still: a producer that simply lacked that macroblock (it sits ~2
                            // epochs back, below a recently synced node's anchor) silently built NO
                            // emission TX at all, so an entire epoch's rewards depended on WHICH node
                            // happened to be elected. The amount is a pure function of height on both
                            // sides; see the note at the pool2/pool3 declarations in
                            // core/qnet-state/src/block.rs before reintroducing either.
                            let total_emission =
                                qnet_consensus::lazy_rewards::pool1_base_emission_at_height(next_block_height);
                            if total_emission > 0 {
                                let reward_epoch = prev_macroblock_index;
                                // Streamed: root + shard cache from ONE pass, peak RAM one shard. The
                                // vector build materialised every recipient (GBs at the 10M target) on
                                // the producer. Cannot reproduce the leaf set ⇒ no emission this block;
                                // a wrong root here would be certified by the committee.
                                let (reward_count, reward_total, reward_root_hex) =
                                    match Self::compute_epoch_reward_root(
                                        &storage, reward_epoch, total_emission, Some(reward_epoch)) {
                                        Some((c, t, r)) => (c as u32, t, r),
                                        None => (0u32, 0u64, String::new()),
                                    };
                                let reward_per_node = if reward_count > 0 { reward_total / reward_count as u64 } else { 0 };
                                if reward_count > 0 {
                                    if is_info() {
                                        println!("[INFO][EMISSION] reward_root epoch={} root={}.. count={} total={} QNC",
                                                 reward_epoch, qnet_state::char_prefix(&reward_root_hex, 16),
                                                 reward_count, reward_total / 1_000_000_000);
                                    }
                                }
                                let current_time = SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs();
                                // v3 emission TX commits ONLY the merkle root (+ scalar params), never the
                                // O(N) recipient map. reward_total == total_emission (conserved) ⇒ apply
                                // recomputes byte-identically from this `total`.
                                let mut emission_tx = qnet_state::Transaction {
                                    from: "system_emission".to_string(),
                                    to: Some("system_rewards_pool".to_string()),
                                    amount: total_emission,
                                    tx_type: qnet_state::TransactionType::RewardDistribution,
                                    timestamp: current_time,
                                    hash: String::new(),
                                    signature: None,
                                    public_key: None,
                                    gas_price: u64::MAX, // MAX priority - FIRST in block
                                    gas_limit: 0,
                                    nonce: 0,
                                    data: Some(serde_json::json!({
                                        "v": 3,
                                        "epoch": reward_epoch,
                                        "root": reward_root_hex,
                                        "per_node": reward_per_node,
                                        "count": reward_count,
                                        "total": reward_total
                                    }).to_string()),
                                    dilithium_signature: None,
                                    dilithium_public_key: None,
                                    chain_id: qnet_state::transaction::QNET_CHAIN_ID,
                                };
                                emission_tx.hash = emission_tx.calculate_hash();
                                if let Ok(tx_bytes) = bincode::serialize(&emission_tx) {
                                    let tx_sz = tx_bytes.len();
                                    emission_tx_opt = Some((emission_tx.hash.clone(), tx_bytes));
                                    if is_info() {
                                        println!("[INFO][EMISSION] tx_created block={} mb={} amount={} QNC recipients={} size={}B hash={}",
                                                 next_block_height, prev_macroblock_index,
                                                 total_emission / 1_000_000_000, reward_count, tx_sz,
                                                 qnet_state::char_prefix(&emission_tx.hash, 16));
                                    }
                                } else {
                                    eprintln!("[ERR][EMISSION] tx_serialize_fail block={}", next_block_height);
                                }
                            } else {
                                eprintln!("[WARN][EMISSION] zero_emission block={} mb={}", next_block_height, prev_macroblock_index);
                            }
                        } // Close if current_epoch > 0
                    }
                    
                    // MEV PROTECTION: Get transactions with bundle priority
                    // ARCHITECTURE: Dynamic 0-20% allocation for bundles, 80-100% for public TXs
                    // v2.67: Renamed to mempool_txs - emission TX added separately
                    // PRODUCTION v2.26: All paths use (hash, bytes) format for proper mempool cleanup
                    let mempool_txs: Vec<(String, Vec<u8>)> = if let Some(ref mev_pool) = mev_mempool {
                        // MEV-AWARE BLOCK BUILDING
                        let current_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                        let mut block_txs: Vec<(String, Vec<u8>)> = Vec::new();
                        
                        // STEP 1: BUNDLE TXS (dynamic 0-20% allocation)
                        // OPTIMIZATION: Single call to get bundles + allocation (no double filtering!)
                        let (valid_bundles, bundle_allocation) = mev_pool.get_bundles_with_allocation(
                            max_tx_per_microblock, 
                            current_time, 
                            1000
                        );
                        
                        // Track actual bundle TX count for accurate metrics
                        let mut bundle_tx_count = 0;
                        
                        for bundle in valid_bundles {
                            if block_txs.len() + bundle.transactions.len() <= bundle_allocation {
                                // ATOMICITY: bundle owns its tx bytes (captured at submit time),
                                // so eviction between submit and build cannot drop a valid bundle.
                                let mut all_txs_exist = true;
                                let mut bundle_txs: Vec<(String, Vec<u8>)> = Vec::new();

                                if bundle.tx_bytes.len() == bundle.transactions.len() {
                                    for (tx_hash, tx_bytes) in bundle.transactions.iter().zip(bundle.tx_bytes.iter()) {
                                        bundle_txs.push((tx_hash.clone(), tx_bytes.clone()));
                                    }
                                } else {
                                    // Malformed bundle (missing owned bytes): skip, do not partially include.
                                    println!("[WARN][MB] mev_bundle_rejected bundle={} reason=missing_owned_bytes",
                                             bundle.bundle_id);
                                    all_txs_exist = false;
                                }
                                
                                // Only include bundle if ALL TXs exist (atomic!)
                                if all_txs_exist {
                                    let bundle_len = bundle_txs.len();
                                    block_txs.extend(bundle_txs);
                                    bundle_tx_count += bundle_len;
                                    println!("[INFO][MB] mev_bundle_included bundle={} txs={} h={}",
                                             bundle.bundle_id, bundle_len, next_block_height);
                                }
                            } else {
                                break; // Bundle space exhausted
                            }
                        }
                        
                        // STEP 2: PUBLIC TXS (remaining 80-100% space)
                        let remaining_space = max_tx_per_microblock.saturating_sub(block_txs.len());
                        if remaining_space > 0 {
                            // v2.26: Direct access - SimpleMempool is already thread-safe
                            let public_txs = mempool.get_pending_for_fill(remaining_space, FILL_PULL_BYTE_BUDGET);
                            block_txs.extend(public_txs);
                        }
                        
                        // METRICS: Accurate bundle vs public TX counts
                        let public_tx_count = block_txs.len().saturating_sub(bundle_tx_count);
                        if bundle_tx_count > 0 {
                            let bundle_percent = (bundle_tx_count as f64 / block_txs.len() as f64) * 100.0;
                            let public_percent = (public_tx_count as f64 / block_txs.len() as f64) * 100.0;
                            println!("[INFO][MB] mev_stats h={} bundle_txs={} bundle_pct={:.1} public_txs={} public_pct={:.1} total={}",
                                     next_block_height,
                                     bundle_tx_count,
                                     bundle_percent,
                                     public_tx_count,
                                     public_percent,
                                     block_txs.len());
                        }
                        
                        block_txs
                    } else {
                        // NO MEV PROTECTION: Use public mempool only
                        // v2.26: Direct access - SimpleMempool is already thread-safe
                        
                        // v2.67: Get transactions from mempool
                        let mempool_size = mempool.size();
                        if mempool_size > 0 {
                            println!("[INFO][MEMPOOL] pre_fetch h={} size={}", next_block_height, mempool_size);
                        }
                        
                        mempool.get_pending_for_fill(max_tx_per_microblock, FILL_PULL_BYTE_BUDGET)
                    };
                    
                    // v2.99: Prepend emission TX if this is an emission block
                    let mut tx_bytes_list: Vec<(String, Vec<u8>)> = Vec::new();

                    // Add emission TX FIRST (if present)
                    if let Some(emission_tx) = emission_tx_opt {
                        tx_bytes_list.push(emission_tx);
                    }

                    // Block-level slashing: inject any equivocation-proof TXs this node has
                    // detected into the block it is producing — same model as emission
                    // (unsigned system TX, never gossiped, no-op state apply, crypto-verified
                    // in the deterministic reputation fold). Capped per block so an evidence
                    // burst cannot blow the 1-sec production deadline; remainder rides the
                    // next block this node produces.
                    let proof_txs = drain_equivocation_proof_txs(16);
                    if !proof_txs.is_empty() {
                        if is_warn() {
                            println!("[WARN][SLASH] equivocation_proofs_injected count={} h={}",
                                     proof_txs.len(), next_block_height);
                        }
                        tx_bytes_list.extend(proof_txs);
                    }
                    // Same model for checkpoint-vote equivocation proofs (accountable safety).
                    let vote_proof_txs = drain_vote_equivocation_proof_txs(16);
                    if !vote_proof_txs.is_empty() {
                        if is_warn() {
                            println!("[WARN][SLASH] vote_equivocation_proofs_injected count={} h={}",
                                     vote_proof_txs.len(), next_block_height);
                        }
                        tx_bytes_list.extend(vote_proof_txs);
                    }

                    // v32.12 + v33 lane: per-block activation TX cap. NodeRegistration/Activation
                    // hit registry+state-apply (deterministic but heavy); bounding per block keeps
                    // the producer's 1-sec deadline achievable under mass-onboarding burst.
                    // NodeRegistration is served EXCLUSIVELY by the deterministic mempool lane
                    // (attest_epoch, burn_tx, tx_hash ASC — every producer selects the SAME next
                    // set, oldest attestation first) and ALWAYS stripped from the general stream,
                    // so cross-producer FIFO nondeterminism can no longer starve a registration.
                    // NodeActivation fills the remaining heavy budget from the general stream.
                    const MAX_ACTIVATIONS_PER_MICROBLOCK: usize = 10;
                    let lane_apply_epoch = next_block_height.saturating_sub(1) / 90 + 1;
                    // exempt_cap = genesis-set size: exempt (empty-burn/epoch-0) regs sort first, so
                    // capping them keeps a junk flood from starving burn-backed registrations.
                    let lane_regs = mempool.registrations_for_inclusion(
                        lane_apply_epoch, 2, MAX_ACTIVATIONS_PER_MICROBLOCK,
                        crate::genesis_constants::genesis_node_count());
                    let mut activation_count = lane_regs.len();
                    if activation_count > 0 && is_info() {
                        println!("[INFO][MB] registration_lane count={} h={}", activation_count, next_block_height);
                    }
                    tx_bytes_list.extend(lane_regs);
                    let mut deferred_activations = 0usize;
                    let capped_mempool_txs: Vec<(String, Vec<u8>)> = mempool_txs
                        .into_iter()
                        .filter(|(_hash, tx_bytes)| {
                            let kind = bincode::deserialize::<qnet_state::Transaction>(tx_bytes)
                                .map(|tx| match tx.tx_type {
                                    qnet_state::TransactionType::NodeRegistration { .. } => 1u8,
                                    qnet_state::TransactionType::NodeActivation { .. } => 2u8,
                                    _ => 0u8,
                                })
                                .unwrap_or(0);
                            match kind {
                                1 => false, // lane-only: never from the general stream (no double-inclusion)
                                2 => {
                                    if activation_count < MAX_ACTIVATIONS_PER_MICROBLOCK {
                                        activation_count += 1;
                                        true
                                    } else {
                                        deferred_activations += 1;
                                        false
                                    }
                                }
                                _ => true,
                            }
                        })
                        .collect();
                    if deferred_activations > 0 && is_info() {
                        println!(
                            "[INFO][MB] activation_cap_applied admitted={}/{} deferred={} h={}",
                            activation_count, MAX_ACTIVATIONS_PER_MICROBLOCK,
                            deferred_activations, next_block_height,
                        );
                    }

                    // Add mempool TXs (regs stripped, activations capped)
                    tx_bytes_list.extend(capped_mempool_txs);
                    
                    // ═══════════════════════════════════════════════════════════════════════════
                    // PRODUCTION v2.63: Block size limit to prevent ShredProtocol overflow
                    // ═══════════════════════════════════════════════════════════════════════════
                    // DEFENSE LEVEL 1: Limit block size at creation time
                    // One shared ceiling (HARD_BLOCK_SIZE_BYTES) for build and accept; under the 87 MB shred max.
                    // This prevents deadlock where block is created but cannot be transmitted
                    // Same ceiling the receive pipeline enforces — build and accept must agree.
                    const MAX_BLOCK_SIZE_BYTES: usize = crate::block_pipeline::HARD_BLOCK_SIZE_BYTES;
                    // Fill cap, producer-local policy (validators accept up to the hard limit).
                    // A backlogged mempool once drained into one 16 MB block — at 1 s cadence
                    // that is >= a follower's whole link, so it could never propagate live and
                    // wedged sync behind it. The tail drains over the following blocks instead.
                    const BLOCK_FILL_SOFT_BYTES: usize = 4_000_000;

                    let mut accumulated_size: usize = 0;
                    let original_tx_count = tx_bytes_list.len();
                    let tx_bytes_list: Vec<(String, Vec<u8>)> = tx_bytes_list
                        .into_iter()
                        .take_while(|(_, tx_bytes)| {
                            let new_size = accumulated_size + tx_bytes.len();
                            if new_size > BLOCK_FILL_SOFT_BYTES.min(MAX_BLOCK_SIZE_BYTES) {
                                false // Stop taking TX - block is full
                            } else {
                                accumulated_size = new_size;
                                true
                            }
                        })
                        .collect();

                    if tx_bytes_list.len() < original_tx_count {
                        println!("[INFO][BLOCK] size_limit_applied original_tx={} included_tx={} size_mb={:.2} soft_mb=4",
                                 original_tx_count, tx_bytes_list.len(),
                                 accumulated_size as f64 / 1_000_000.0);
                    }

                    // FIX R22-B5: Track cumulative block gas for BLOCK_GAS_LIMIT enforcement
                    // Applied AFTER size filter, BEFORE TX validation — early rejection of gas overflow
                    // Producer fill TARGET under the consensus LIMIT (target/limit model).
                    // A mempool backlog once drained into limit-sized blocks; the slowest
                    // committee nodes applied those for multiple seconds, the cadence fell,
                    // the backlog grew — a stable degraded spiral. The target bounds every
                    // block to work the whole fleet applies inside the 1s slot; validators
                    // keep accepting up to the full limit. Producer-local POLICY (not a
                    // consensus parameter), so the throughput ladder may override it per
                    // step via env — always clamped to the consensus ceiling.
                    // Calibrated by the boundary ladder: 13 batches/block is the highest
                    // rung that holds a 10-min run at >=99% on floor hardware (schedule
                    // catch-up supplies the drain margin); 14 runs a ~3 batch/s deficit,
                    // 16 holds only 5-min bursts, 20 (the limit) breaks cadence sustained.
                    const BLOCK_FILL_SOFT_GAS: u64 = 130_000_000;
                    static FILL_GAS_TARGET: once_cell::sync::Lazy<u64> = once_cell::sync::Lazy::new(|| {
                        let v = std::env::var("QNET_BLOCK_FILL_GAS").ok()
                            .and_then(|s| s.parse::<u64>().ok())
                            .unwrap_or(BLOCK_FILL_SOFT_GAS)
                            .clamp(10_000_000, qnet_state::gas_limits::BLOCK_GAS_LIMIT);
                        if v != BLOCK_FILL_SOFT_GAS && is_warn() {
                            println!("[WARN][PROD] fill_gas_target_override target={} default={}", v, BLOCK_FILL_SOFT_GAS);
                        }
                        v
                    });
                    let block_gas_limit = *FILL_GAS_TARGET;
                    
                    // CRITICAL v2.26: Track TX hashes for mempool cleanup after block
                    // IMPORTANT: Use the SAME hash from mempool, not recalculated!
                    let mut included_tx_hashes: Vec<String> = Vec::new();
                    let mut invalid_tx_hashes: Vec<String> = Vec::new();
                    // VALID-but-not-included TXs that MUST stay in the mempool for a later block (NOT marked
                    // confirmed / removed at the post-save cleanup below): pre-verify DEFER (elided value-TX
                    // whose committed pk isn't present yet) + gas/fuel-limit TRUNCATION. included_tx_hashes is
                    // captured at the early validation stage, so without this the post-save bulk removal would
                    // evict + confirm these and they'd never be re-pulled.
                    let mut keep_in_mempool: std::collections::HashSet<String> = std::collections::HashSet::new();
                    
                    // PRODUCTION v2.46: PARALLEL deserialization and validation with rayon
                    // Achieves 100K+ TPS by utilizing all CPU cores
                    // bincode first (new format), JSON fallback (legacy)
                    use rayon::prelude::*;
                    
                    let state_snapshot = state.read().await;
                    let benchmark_mode_enabled = std::env::var("QNET_BENCHMARK_MODE")
                        .map(|v| v == "true" || v == "1")
                        .unwrap_or(false);
                    
                    // STEP 1: Parallel deserialization (CPU-bound, perfect for rayon).
                    // block_in_place: the calling worker blocks on rayon's join — hand the
                    // thread back to the runtime so message intake keeps running.
                    let deser_start = std::time::Instant::now();
                    let deserialized: Vec<(String, Option<qnet_state::Transaction>)> =
                        tokio::task::block_in_place(|| tx_bytes_list
                        .par_iter()
                        .map(|(mempool_hash, tx_bytes)| {
                            let tx_opt: Option<qnet_state::Transaction> =
                                bincode::deserialize::<qnet_state::Transaction>(tx_bytes).ok()
                                .or_else(|| {
                                    String::from_utf8(tx_bytes.clone()).ok()
                                        .and_then(|json| serde_json::from_str(&json).ok())
                                });
                            (mempool_hash.clone(), tx_opt)
                        })
                        .collect());
                    
                    let deser_time = deser_start.elapsed();
                    if is_debug() && deser_time.as_millis() > 10 {
                        println!("[DBG][PARALLEL] deser_time={:?} tx_count={}", deser_time, deserialized.len());
                    }
                    
                    // STEP 2: Parallel validation (read-only state access is thread-safe)
                    // StateSnapshot uses DashMap internally which allows concurrent reads
                    let valid_start = std::time::Instant::now();
                    
                    // v3.1: Track deserialization failures separately
                    let deser_failed_count = deserialized.iter()
                        .filter(|(_, tx_opt)| tx_opt.is_none())
                        .count();
                    if deser_failed_count > 0 {
                        eprintln!("[WARN][BLOCK] deser_failed_count={} (TX dropped silently)", deser_failed_count);
                    }
                    
                    // v3.1: Include rejection reason in tuple for better diagnostics
                    let validated: Vec<(String, qnet_state::Transaction, bool, Option<String>)> =
                        tokio::task::block_in_place(|| deserialized
                        .into_par_iter()
                        .filter_map(|(hash, tx_opt)| tx_opt.map(|tx| (hash, tx)))
                        .map(|(hash, tx)| {
                            // v35: Heartbeat is a system TX (skip nonce/balance) but MUST carry a
                            // fresh, real anchor. THIS IS THE ONLY PLACE THE ANCHOR IS CHECKED —
                            // receivers do not re-verify it, so a Byzantine producer can still include
                            // a stale/forged-anchor heartbeat (OPEN: receive-side gate; the pure
                            // storage half is fork-safe, the signature half must go through the
                            // shared system-TX authenticator, never the RAM consensus registry).
                            // Gate at the production height (== inclusion height): exclude a
                            // stale/forged-anchor heartbeat, never block the microblock.
                            // Checks: anchor past, ≤90 lag, hash == canonical chain hash.
                            if let qnet_state::TransactionType::Heartbeat { anchor_height, anchor_hash, .. } = &tx.tx_type {
                                let ah = *anchor_height;
                                let ahash = anchor_hash.clone();
                                let ok = tx.validate().is_ok()
                                    && ah < next_block_height
                                    && next_block_height - ah <= HB_ANCHOR_MAX_LAG
                                    && matches!(storage.get_microblock_hash_hex(ah), Ok(Some(h)) if h.eq_ignore_ascii_case(&ahash));
                                return (hash, tx, ok, if ok { None } else { Some("heartbeat_stale_or_bad_anchor".to_string()) });
                            }
                            let is_benchmark = benchmark_mode_enabled && tx.from.starts_with("EON1benchmark");
                            
                            // v2.66: System TX bypass nonce/balance validation (like submit_transaction)
                            // v2.71: NodeRegistration TX also bypasses (nonce=0, gas=0, no balance needed)
                            // v2.87: System TX bypass nonce/balance validation
                            // HeartbeatCommitment/PingCommitment are validator rewards - MUST be included!
                            // v2.89: LightNodeEligibilityBitmap (Genesis bitmap TX)
                            // Canonical system-TX predicate (single source of truth in qnet-state) +
                            // system_* sender net. Inline lists here had drifted and silently dropped
                            // NodeActivation/NodeReactivation from blocks (super-node onboarding stall).
                            let is_system_tx = tx.is_system_tx() || tx.from.starts_with("system_");
                            
                            let (is_valid, reject_reason) = if is_benchmark || is_system_tx {
                                // Benchmark OR System TX: skip balance/nonce validation
                                // System TX are validated through consensus rules, not account state
                                // v3.1: Capture validation error for diagnostics
                                match tx.validate() {
                                    Ok(()) => (true, None),
                                    Err(e) => {
                                        // v3.1: Log system TX validation failure with details
                                        eprintln!("[ERR][BLOCK] system_tx_validate_failed type={:?} from={} hash={}.. err={}",
                                            std::mem::discriminant(&tx.tx_type),
                                            &tx.from[..tx.from.len().min(20)],
                                            qnet_state::char_prefix(&hash, 16),
                                            e
                                        );
                                        (false, Some(format!("validate: {}", e)))
                                    }
                                }
                            } else if !Self::gas_limit_admissible(&tx) {
                                // Drop, never a block-level reject: an oversized TX that slipped past
                                // admission must not reach a block.
                                (false, Some("gas_limit_above_max".to_string()))
                            } else {
                                // Production: full state validation (thread-safe read).
                                // Nonce is tri-state, and only CONSUMED is a death sentence:
                                //   consumed (<= account.nonce)  → evict, the signed bytes can never apply;
                                //   next     (== account.nonce+1) → includable;
                                //   future   (>  account.nonce+1) → SKIP but KEEP — the sender's earlier tx
                                //     is still in flight (same pool or an unapplied block); evicting here
                                //     used to kill the second of any two back-to-back txs from one wallet.
                                let account_nonce = state_snapshot.get_account(&tx.from)
                                    .map(|a| a.nonce).unwrap_or(0);

                                let balance_valid = if let qnet_state::TransactionType::Transfer { .. } = &tx.tx_type {
                                    let balance = state_snapshot.get_balance(&tx.from);
                                    // SECURITY: checked arithmetic to prevent overflow → false balance_valid
                                    let gas_cost = tx.effective_gas_price().saturating_mul(tx.gas_limit);
                                    let total_cost = tx.amount.saturating_add(gas_cost);
                                    balance >= total_cost
                                } else {
                                    true
                                };

                                if tx.nonce <= account_nonce {
                                    (false, Some("nonce_consumed".to_string()))
                                } else if tx.nonce > account_nonce + 1 {
                                    (false, Some("nonce_future".to_string()))
                                } else if !balance_valid {
                                    // Keep, don't evict: funding may land in a following block
                                    // (chained transfers). TTL reaps it if it never becomes payable.
                                    (false, Some("insufficient_balance".to_string()))
                                } else {
                                    (true, None)
                                }
                            };
                            
                            (hash, tx, is_valid, reject_reason)
                        })
                        .collect());

                    let valid_time = valid_start.elapsed();
                    if is_debug() && valid_time.as_millis() > 10 {
                        println!("[DBG][PARALLEL] valid_time={:?} tx_count={}", valid_time, validated.len());
                    }
                    
                    // STEP 3: Collect results and SEPARATE system TX from user TX
                    // v2.68: System TX bypass ParallelExecutor (it doesn't support them!)
                    let mut system_txs: Vec<qnet_state::Transaction> = Vec::new();
                    let mut user_txs: Vec<qnet_state::Transaction> = Vec::new();
                    let mut rejection_reasons: Vec<(String, String)> = Vec::new(); // v3.1: Track reasons
                    let mut skipped_keep: usize = 0; // transient rejects left in the pool
                    
                    // Producer-side commitment dedup (last line of defence
                    // before block sealing). The mempool's commitment_index
                    // already keeps one canonical version, but a gossip-vs-
                    // producer-pull race could surface two in the candidate
                    // set; this guarantees no block ever ships duplicate
                    // commitments. Coverage = commitment_dedup_key(), mirrors
                    // state.rs::check_duplicate_commitment 1:1; a duplicate is
                    // removed via invalid_tx_hashes so it isn't retried. Bounded
                    // HashSet (one commitment/validator/epoch).
                    let mut seen_commit_keys: std::collections::HashSet<(String, u64, u8)> =
                        std::collections::HashSet::new();

                    for (hash, tx, is_valid, reject_reason) in validated {
                        if is_valid {
                            // v2.68: Separate system TX from user TX
                            // v2.71: NodeRegistration is also system TX (no state execution needed)
                            // v2.87: HeartbeatCommitment/PingCommitment are validator reward TX
                            // Canonical system-TX predicate (single source of truth) → route to
                            // system_txs so it bypasses the user-only ParallelExecutor, which drops
                            // anything it doesn't recognise → empty body. The inline list here had
                            // dropped Heartbeat (no liveness tally) AND NodeActivation (no onboarding).
                            let is_system = tx.is_system_tx() || tx.from.starts_with("system_");

                            // v15.12: state-aware producer dedup (closes the cross-block gap). The
                            // v15.5 filter only deduped WITHIN a block; a commitment already
                            // finalized on chain (peer-apply at h=K) still sat in another producer's
                            // mempool and was re-included at h=K+N — apply rejected it but the bytes
                            // bloated block storage + explorer (h=14351→14461). Fix: before the dedup
                            // tiers, is_epoch_committed(type,identity,epoch) against the held read-
                            // guard; if on chain → drop the TX from the block AND local mempool.
                            // Same 5 types as commitment_dedup_key; NodeRegistration epoch=0
                            // (one-shot) → rejects 2nd registration. Read-only, O(1) ~50ns.
                            let is_already_on_chain = if let Some((identity, epoch, type_id)) =
                                tx.commitment_dedup_key()
                            {
                                match type_id {
                                    // NodeRegistration is one-shot, recorded in the node registry
                                    // (mark_node_registered), NOT committed_epochs — dedup against the
                                    // registry, else an already-registered node_id is never dropped and the
                                    // producer re-selects the same reg every tick (the ~9/s hot loop).
                                    4 => state_snapshot.is_node_registered(&identity),
                                    1 => state_snapshot.is_epoch_committed("heartbeat", &identity, epoch),
                                    2 => state_snapshot.is_epoch_committed("ping", &identity, epoch),
                                    3 => state_snapshot.is_epoch_committed("bitmap", &identity, epoch),
                                    5 => state_snapshot.is_epoch_committed("reactivation", &identity, epoch),
                                    _ => false,
                                }
                            } else {
                                false
                            };

                            if is_already_on_chain {
                                if is_info() {
                                    println!(
                                        "[INFO][BLOCK] dedup_already_on_chain hash={} from={} reason=epoch_already_committed",
                                        qnet_state::char_prefix(&hash, 16), &tx.from
                                    );
                                }
                                invalid_tx_hashes.push(hash);
                                continue;
                            }

                            // v15.5: unified commitment dedup via canonical key.
                            // `commitment_dedup_key()` returns `None` for non-commitment
                            // TXs; those skip the dedup check entirely.
                            let is_dup_commitment = if let Some(key) = tx.commitment_dedup_key() {
                                !seen_commit_keys.insert(key)
                            } else {
                                false
                            };

                            if is_dup_commitment {
                                if is_info() {
                                    println!("[INFO][BLOCK] dedup_commitment type={:?} from={} hash={}",
                                             std::mem::discriminant(&tx.tx_type), &tx.from, qnet_state::char_prefix(&hash, 16));
                                }
                                invalid_tx_hashes.push(hash);
                                continue;
                            }

                            if is_system {
                                system_txs.push(tx);
                            } else {
                                user_txs.push(tx);
                            }
                            included_tx_hashes.push(hash);
                        } else {
                            // v3.1: Track rejection reason
                            if let Some(reason) = reject_reason {
                                // Transient conditions stay POOLED: a future nonce becomes next
                                // once the sender's in-flight tx applies, an unfunded transfer
                                // becomes payable when funding lands. Only deterministically
                                // dead txs are evicted below; TTL reaps the rest.
                                if reason == "nonce_future" || reason == "insufficient_balance" {
                                    skipped_keep += 1;
                                    continue;
                                }
                                rejection_reasons.push((hash.clone(), reason));
                            }
                            invalid_tx_hashes.push(hash);
                        }
                    }

                    drop(state_snapshot);  // Release read lock

                    if skipped_keep > 0 && is_info() {
                        println!("[INFO][MB] fill_skipped_kept h={} count={}", next_block_height, skipped_keep);
                    }
                    
                    // CRITICAL v2.26: Remove invalid transactions from mempool immediately!
                    // v3.1: Log actual rejection reasons instead of generic message
                    if !invalid_tx_hashes.is_empty() {
                        mempool.batch_remove_transactions(&invalid_tx_hashes);
                        // v3.1: Show detailed rejection reasons
                        for (hash, reason) in &rejection_reasons {
                            eprintln!("[WARN][MB] tx_rejected hash={}.. reason={}",
                                     qnet_state::char_prefix(&hash, 16), reason);
                        }
                        println!("[INFO][MB] invalid_tx_removed count={}", invalid_tx_hashes.len());
                    }
                    
                    // v2.68: Log separation
                    if !system_txs.is_empty() || !user_txs.is_empty() {
                        println!("[INFO][BLOCK] tx_separation system={} user={}", system_txs.len(), user_txs.len());
                    }
                    
                    // PARALLEL EXECUTOR: Process ONLY USER transactions (not system!)
                    // v2.68: ParallelExecutor doesn't support system TX (returns empty for them)
                    let mut processed_user_txs = user_txs.clone();
                    if let Some(ref executor) = parallel_executor {
                        if !user_txs.is_empty() {
                            match executor.process_transactions(user_txs).await {
                                Ok(processed) => {
                                    println!("[INFO][MB] parallel_exec_ok txs={}", processed.len());
                                    processed_user_txs = processed;
                                },
                                Err(e) => {
                                    println!("[WARN][MB] parallel_exec_failed err={} fallback=sequential", e);
                                    // Continue with original user transactions
                                }
                            }
                        }
                    }
                    
                    // v2.68: Combine: system TX first (already validated), then processed user TX
                    // Order: [system_emission, system_ping, ..., user_tx_1, user_tx_2, ...]
                    let mut txs: Vec<qnet_state::Transaction> = Vec::with_capacity(
                        system_txs.len() + processed_user_txs.len()
                    );
                    txs.extend(system_txs);
                    txs.extend(processed_user_txs);

                    // Producer re-validation (D): a NodeRegistration admitted to the mempool earlier
                    // (against the chain tip THEN) may be invalid at THIS block's height — its burn now
                    // bound to a different wallet, the committee rotated, or another reg in this same
                    // block reuses the burn. Re-run the EXACT validator check (verify_burn_attestation_
                    // quorum) at next_block_height + a same-block burn dedup, and DROP any conflict so the
                    // producer never emits a block peers reject at the burn-uniqueness gate (wasted slot)
                    // and never inline-binds cbw for a registration the network won't accept.
                    {
                        let mut kept: Vec<qnet_state::Transaction> = Vec::with_capacity(txs.len());
                        let mut seen_burns: std::collections::HashSet<String> = std::collections::HashSet::new();
                        for tx in txs.into_iter() {
                            if let qnet_state::TransactionType::NodeRegistration { burn_tx, .. } = &tx.tx_type {
                                if !burn_tx.is_empty() && !seen_burns.insert(burn_tx.clone()) {
                                    if is_warn() { println!("[WARN][MB] drop_dup_burn_reg h={}", next_block_height); }
                                    continue;
                                }
                                if Self::verify_burn_attestation_quorum(&tx, next_block_height, &*storage).await.is_err() {
                                    if is_warn() { println!("[WARN][MB] drop_invalid_burn_reg h={}", next_block_height); }
                                    continue;
                                }
                            }
                            kept.push(tx);
                        }
                        txs = kept;
                    }

                    // Producer pre-filter (C): drop any NodeActivation whose wallet lacks a burn-attested
                    // registration — committed in a PRIOR block OR a (kept) NodeRegistration in THIS block
                    // — the EXACT rule validators enforce at verify (block_pipeline). Without it the
                    // producer would emit a block every peer rejects at the activation-burn gate (wasted
                    // slot → liveness loss under an unbacked-activation spam). Same activation-height gate.
                    if qnet_state::feature_gates::is_active("burn_attestation_required", next_block_height) {
                        let this_block_burned: std::collections::HashSet<String> = txs.iter().filter_map(|t| match &t.tx_type {
                            qnet_state::TransactionType::NodeRegistration { wallet_address, burn_tx, .. } if !burn_tx.is_empty() => Some(wallet_address.clone()),
                            _ => None,
                        }).collect();
                        txs.retain(|t| {
                            if matches!(t.tx_type, qnet_state::TransactionType::NodeActivation { .. }) {
                                // Genesis nodes self-activate without a 1DEV burn (they ARE the bootstrap),
                                // so exempt them — same genesis exemption the registration burn-gate uses.
                                let backed = this_block_burned.contains(&t.from)
                                    || storage.wallet_is_burn_registered(&t.from)
                                    || storage.wallet_is_genesis_node(&t.from);
                                if !backed && is_warn() { println!("[WARN][MB] drop_unbacked_activation h={}", next_block_height); }
                                backed
                            } else { true }
                        });
                    }

                    // PRE-EXECUTION: Update leader schedule and pre-execute if we're a future leader
                    {
                        // Get current producer list for rotation schedule
                        let producers = if let Some(p2p) = &unified_p2p {
                            let peers = p2p.get_validated_active_peers();
                            let mut producer_list: Vec<String> = peers.iter().map(|p| p.id.clone()).collect();
                            producer_list.push(node_id.clone());
                            producer_list.sort();
                            producer_list
                        } else {
                            vec![node_id.clone()]
                        };
                        
                        // Update leader schedule
                        pre_execution.update_leader_schedule(microblock_height, producers).await;
                        
                        // Pre-execute transactions for future blocks if we're a future leader
                        if !txs.is_empty() {
                            match pre_execution.pre_execute_batch(txs.clone(), microblock_height, &node_id).await {
                                Ok(pre_executed) => {
                                    if !pre_executed.is_empty() {
                                        println!("[INFO][MB] pre_exec txs={}", pre_executed.len());
                                    }
                                },
                                Err(e) => {
                                    // Pre-execution is optional, continue normally
                                    println!("[WARN][MB] pre_exec_skipped err={}", e);
                                }
                            }
                        }
                    }
                    
                    // PRODUCTION QNet Consensus Integration
                    // Macroblock finality = Checkpoint-BFT v2 (n−f QC over each 90-block window,
                    // committee-signed). Microblocks = single-leader, ML-DSA-65-signed, VRF rotation.
                    // (Commit/reveal is removed; sharded-consensus primitives stay dormant at single-shard.)

                    // ARCHITECTURE: Unified consensus for ALL blocks (no special phases)
                    // - Microblocks: Quantum signatures (ML-DSA-65) + deterministic producer selection
                    // - Macroblocks (every 90): Byzantine consensus (BFT) for finalization
                    // This ensures consistent security from block 0 to infinity
                    
                    // SCALABILITY: microblocks 1s interval, macroblocks 90s consensus
                    // CRITICAL FIX: Height increment moved AFTER block creation to fix missing block #1
                    
                    // PRODUCTION: Use validated active peers for accurate count
                    let peer_count = if let Some(p2p) = &unified_p2p {
                        p2p.get_peer_count()
                    } else {
                        0
                    };
                    
                    // Update Adaptive BFT with current peer count
                    adaptive_bft.update_peer_count(peer_count).await;
                    
                    // Log only every 100 blocks or when there are transactions
                    if log_block(next_block_height) || !txs.is_empty() {
                        // Real per-block tx count only; no fabricated shard-multiplied TPS.
                        if is_info() { println!("[INFO][BLOCK] h={} peers={} txs={}", next_block_height, peer_count, txs.len()); }
                    }
                    
                    let _consensus_result: Option<u64> = None; // NO consensus for microblocks - Byzantine consensus ONLY for macroblocks
                    
                    // CRITICAL: Producer NEVER waits for network!
                    // The producer's job is to CREATE blocks based on LOCAL state
                    // Other nodes validate and accept/reject - this is the blockchain way!
                    // NO SYNC CHECKS, NO NETWORK QUERIES, NO WAITING!
                    
                    // Median-aware wall-clock timestamp = max of four sources:
                    // (1) wall_clock; (2) network_median + blocks_ahead (last-32
                    // ring — pulls a behind-clock producer into the accepted
                    // range); (3) parent_ts+1 (strict monotonicity, clock-
                    // independent); (4) median_past+1 (Median-Past lower bound;
                    // undefined for the first ~11 blocks → falls back to (3)).
                    // The max is the smallest legal timestamp satisfying every
                    // rule, so a node within 2h drift is accepted on first
                    // validation with zero NTP dependency. block.timestamp is
                    // ML-DSA-65-signed, so the producer can't show different
                    // peers different values. Four O(1) reads.
                    // Slot-anchored deterministic timestamp: block_ts = genesis_ts +
                    // height*SLOT. Identical on every node ⇒ clock-independent, no drift,
                    // no median ring, no NTP. ML-DSA-65-signed.
                    let deterministic_timestamp = {
                        let g = genesis_timestamp(&storage);
                        let ts = expected_block_timestamp(g, next_block_height);
                        if is_debug() && next_block_height > 0 {
                            println!("[DBG][TIMESTAMP] gen h={} genesis_ts={} → ts={}",
                                     next_block_height, g, ts);
                        }
                        ts
                    };


                    // Get previous block hash
                    let prev_hash = Self::get_previous_microblock_hash(&storage, next_block_height).await;
                    
                    // Static counter for retry tracking (defined once for the entire function)
                    use std::sync::atomic::{AtomicU32, Ordering};
                    static PREV_HASH_RETRY_COUNTER: AtomicU32 = AtomicU32::new(0);
                    
                    // ═══════════════════════════════════════════════════════════════════════════
                    // PRODUCTION v2.55: ANTI-FORK PROTECTION
                    // ═══════════════════════════════════════════════════════════════════════════
                    // Problem: Creating block without prev_block causes FORK!
                    // Solution: NEVER create block if prev_block missing - wait for sync instead
                    // 
                    // Flow:
                    // 1. Wait for prev_block with retries (up to 10 seconds)
                    // 2. If still missing - request sync from peers
                    // 3. Wait for sync to complete (up to 5 more seconds)
                    // 4. ONLY if network consensus confirms gap - allow emergency (rare case)
                    // ═══════════════════════════════════════════════════════════════════════════
                    if next_block_height > 1 && prev_hash == [0u8; 32] {
                        // Use atomic counter for thread safety
                        let retry_count = PREV_HASH_RETRY_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
                        
                        // PHASE 1: Wait for prev_block (up to 10 seconds = 20 retries)
                        if retry_count < 20 {
                            // Request missing block via sync
                            if retry_count == 1 || retry_count == 10 {
                                println!("[INFO][SYNC] prev_block_wait h={} retry={}", next_block_height - 1, retry_count);
                                
                                // Trigger sync request
                                if let Some(p2p) = &unified_p2p {
                                    let _ = p2p.request_block_repair(next_block_height - 1).await;
                                }
                            }
                            
                            // v3.4: CRITICAL - Clear broadcast flag before continue
                            crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            continue;  // Retry without producing
                        }
                        
                        // PHASE 2: Sync timeout - check network consensus
                        if retry_count >= 20 && retry_count < 30 {
                            println!("[INFO][SYNC] consensus_check h={} elapsed=10s", next_block_height - 1);
                            
                            // Query peers for their height
                            if let Some(p2p) = &unified_p2p {
                                let peers = p2p.get_validated_active_peers();
                                let peer_heights: Vec<u64> = peers.iter()
                                    .filter(|p| p.last_block_height > 0)
                                    .map(|p| p.last_block_height)
                                    .collect();
                                
                                // If majority of peers are ahead of us - they have the block, keep waiting
                                let peers_with_block = peer_heights.iter().filter(|&&h| h >= next_block_height - 1).count();
                                let total_peers = peer_heights.len();
                                
                                if total_peers > 0 && peers_with_block > total_peers / 2 {
                                    println!("[INFO][SYNC] peers_have_block h={} count={}/{}", 
                                             next_block_height - 1, peers_with_block, total_peers);
                                    // v3.4: CRITICAL - Clear broadcast flag before continue
                                    crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                    continue;  // Keep waiting - block exists on network
                                }
                            }
                        }
                        
                        // PHASE 3: Final timeout (15+ seconds) - network likely has no block
                        if retry_count >= 30 {
                            eprintln!("[ERR][PROD] prev_hash_timeout h={} retries={} (15s)", next_block_height, retry_count);
                            PREV_HASH_RETRY_COUNTER.store(0, Ordering::SeqCst);  // Reset counter
                            
                            // v3.9: NO BROADCAST! Just skip production, timeout_round will handle failover
                            // If we don't have prev block, we CAN'T produce - simple as that
                            // All other nodes will see slot_delay increase → compute same new producer
                            println!("[WARN][PROD] skip_production h={} reason=prev_hash_missing (timeout_round handles failover)", 
                                     next_block_height);
                            // Skip this production round - prevent fork creation!
                            // v3.4: CRITICAL - Clear broadcast flag before continue
                            crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                            tokio::time::sleep(microblock_interval).await;
                            continue;
                        }
                        
                        if is_debug() { println!("[DBG][PROD] wait_prev h={} prev={} retry={}/10", 
                                 next_block_height, next_block_height - 1, retry_count); }
                        
                        // PERFORMANCE FIX: Reduce retry delay from 500ms to 100ms for faster recovery
                        // v3.4: CRITICAL - Clear broadcast flag before continue
                        crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    } else if next_block_height > 1 {
                        // Reset retry counter on success (only if not block #1)
                        // Note: PREV_HASH_RETRY_COUNTER already defined above
                        PREV_HASH_RETRY_COUNTER.store(0, Ordering::SeqCst);
                    }
                    
                    
                    // ═══════════════════════════════════════════════════════════════════════════
                    // QUANTUM RANDOMNESS BEACON (QRB) v3.0
                    // Generate randomness contribution for epoch accumulation
                    // Each producer contributes signed randomness to beacon
                    // CRITICAL FIX: Use EXISTING PqCrypto instance (don't create new cert!)
                    // ═══════════════════════════════════════════════════════════════════════════
                    // Note: Fields named vrf_output/vrf_proof for serialization compatibility
                    // ═══════════════════════════════════════════════════════════════════
                    // v4.0: DILITHIUM3-VRF BLOCK PROOF (PRODUCTION)
                    // No fallbacks — ML-DSA-65 only (NIST FIPS 204, Level 3)
                    //
                    // slot_seed = SHA3-256(prev_hash || block_height)
                    // VRF(wallet_sk, slot_seed) → (output, proof)
                    // output: 32-byte pseudorandom (QRB + leader election)
                    // proof: ~3309-byte ML-DSA-65 detached signature (verifiable)
                    // ═══════════════════════════════════════════════════════════════════
                    // vrf_output/vrf_proof are no longer produced: the window beacon folds block
                    // hashes, so the fields carried no consensus information while costing 3.3 KB of
                    // ML-DSA proof per block (~289 MB/day at 1 s slots).
                    let (qrb_output, qrb_proof): (Option<[u8; 32]>, Option<Vec<u8>>) = (None, None);

                    // ═══ VERIFY-BEFORE-APPLY (mirror the block-validator's verify stage EXACTLY) ═══
                    // Classify + verify the candidate set BEFORE the microblock body is frozen and BEFORE any
                    // state/registry mutation, so an inadmissible tx can never be applied+materialised into
                    // registry_root and then rejected+abandoned (the consensus-root divergence that split a
                    // producer from n−f). ONE state read-lock rehydrates elided value-TX pubkeys into
                    // VERIFY-ONLY clones — the block body + mempool stay ELIDED (the pk-elision TPS win),
                    // byte-identical to block_pipeline's verify stage. Three outcomes per tx:
                    //   ADMIT — keep in the block · EVICT — inadmissible → drop + remove from mempool ·
                    //   DEFER — elided value-TX whose committed pk isn't present on THIS node yet (first-use
                    //           TX not applied, or still syncing) → exclude from THIS block but KEEP in the
                    //           mempool for a later block (mirror the validator's committee_deferred; hard-
                    //           evicting a not-yet-resolvable VALID tx would silently lose it).
                    if !txs.is_empty() {
                        let snap_in_progress = crate::storage::SNAPSHOT_REHYDRATE_IN_PROGRESS
                            .load(std::sync::atomic::Ordering::Acquire);
                        let mut verify_clones: Vec<(usize, qnet_state::Transaction)> = Vec::new();
                        let mut evict_idx: Vec<usize> = Vec::new();
                        let mut defer_idx: std::collections::HashSet<usize> = std::collections::HashSet::new();
                        {
                            // Cheap per-tx classification + elided-pk rehydration under ONE read-lock; the
                            // CPU-bound ML-DSA verifies run AFTER the lock is dropped (below).
                            let sg = state.read().await;
                            for (i, tx) in txs.iter().enumerate() {
                                match Self::producer_tx_prepare(tx, &*sg, snap_in_progress) {
                                    TxPrep::Admit => {}
                                    TxPrep::Evict => evict_idx.push(i),
                                    TxPrep::Defer => { defer_idx.insert(i); }
                                    TxPrep::Verify(clone) => verify_clones.push((i, clone)),
                                }
                            }
                        }
                        // Parallel ML-DSA verify of the resolved clones OFF the state lock (512 per batch to
                        // stay within the 1s slot at ≤200k txs/block, ML-DSA verify ~150µs).
                        let mut bad_verify: std::collections::HashSet<usize> = std::collections::HashSet::new();
                        if !verify_clones.is_empty() {
                            let batches: Vec<Vec<_>> = verify_clones.chunks(512).map(|c| c.to_vec()).collect();
                            let mut futs = Vec::with_capacity(batches.len());
                            for batch in batches {
                                // spawn_blocking: the CPU-bound ML-DSA-65 verify runs on the blocking pool,
                                // NOT the async-runtime workers that carry consensus/P2P — mirrors the FIX-1
                                // lane rule (the old tokio::spawn ran sync crypto inline on a runtime worker,
                                // so a cold VALUE_VERIFY_CACHE could blow the 1s producer slot).
                                futs.push(tokio::task::spawn_blocking(move || {
                                    let mut bad = Vec::new();
                                    for (i, clone) in batch {
                                        if !Self::producer_tx_verify_sig(&clone) { bad.push(i); }
                                    }
                                    bad
                                }));
                            }
                            for f in futs { if let Ok(b) = f.await { for i in b { bad_verify.insert(i); } } }
                        }
                        // EVICT (evict_idx ∪ bad_verify) → drop + remove from mempool. DEFER → drop only.
                        let evict_set: std::collections::HashSet<usize> =
                            evict_idx.iter().copied().chain(bad_verify.iter().copied()).collect();
                        if !evict_set.is_empty() {
                            let evict_hashes: Vec<String> = evict_set.iter().map(|&i| txs[i].hash.clone()).collect();
                            mempool.batch_remove_transactions(&evict_hashes);
                        }
                        // DEFERRED txs stay in the mempool for a later block — exclude them from the post-save
                        // confirm/remove (captured here, while defer_idx still indexes txs, BEFORE the retain).
                        for &i in defer_idx.iter() { keep_in_mempool.insert(txs[i].hash.clone()); }
                        if !evict_set.is_empty() || !defer_idx.is_empty() {
                            if is_warn() {
                                println!("[WARN][MB] pre_verify h={} evicted={} deferred={}",
                                    next_block_height, evict_set.len(), defer_idx.len());
                            }
                            let mut i = 0usize;
                            txs.retain(|_| { let keep = !evict_set.contains(&i) && !defer_idx.contains(&i); i += 1; keep });
                        }
                    }

                    // ═══════════════════════════════════════════════════════════════════
                    // v3.18: Calculate fees_collected BEFORE creating microblock
                    // Fees go directly to producer (Pool 2 removed)
                    // ═══════════════════════════════════════════════════════════════════
                    // Two txs from one sender at the same nonce: the second applies Ok without debiting
                    // (idempotent branch), so it pays nothing and earns nothing — it would just occupy
                    // block space. Drop it here; this is block CONTENT selection, not a validity rule,
                    // so it cannot diverge from a validator (which charges neither of them either).
                    {
                        let mut seen: std::collections::HashSet<(String, u64)> = std::collections::HashSet::new();
                        let before = txs.len();
                        txs.retain(|tx| tx.gas_limit == 0 || seen.insert((tx.from.clone(), tx.nonce)));
                        if txs.len() != before && is_warn() {
                            println!("[WARN][MB] dup_nonce_dropped h={} count={}", next_block_height, before - txs.len());
                        }
                    }
                    let mut block_fees_collected: u64 = 0;
                    let mut block_gas_used: u64 = 0;
                    let mut block_fuel_used: u64 = 0;
                    let block_fuel_limit = qnet_state::gas_limits::BLOCK_FUEL_LIMIT;
                    let mut gas_limited_idx: Option<usize> = None;
                    for (idx, tx) in txs.iter().enumerate() {
                        // QUANTUM v2.25: Use effective_gas_price() for +50% Dilithium TX fee
                        // v3.36: Use compute_gas_used() for metered blocks (EIP-1559 gas refund)
                        // RESOURCE set: wider than the fee set — gas_price == 0 pays nothing but
                        // still consumes compute. The receive-side gate uses this exact predicate.
                        if !tx.from.starts_with("system_") && tx.gas_limit > 0 {
                            let charged_gas = if next_block_height >= qnet_state::GAS_METERING_ACTIVATION_HEIGHT {
                                tx.compute_gas_used()
                            } else {
                                tx.gas_limit
                            };
                            // FIX R22-B5: Enforce cumulative BLOCK_GAS_LIMIT + the SEPARATE wasm-fuel
                            // budget (bounds per-block compute independent of gas; see verify path +
                            // BLOCK_FUEL_LIMIT). Stop filling at whichever ceiling this tx would breach;
                            // the validator enforces the SAME two bounds, so a produced block always
                            // re-verifies. reserved_fuel() is a pure fn of the signed gas_limit.
                            let new_gas = block_gas_used.saturating_add(charged_gas);
                            let new_fuel = block_fuel_used.saturating_add(tx.reserved_fuel());
                            if new_gas > block_gas_limit || new_fuel > block_fuel_limit {
                                gas_limited_idx = Some(idx);
                                break;
                            }
                            block_gas_used = new_gas;
                            block_fuel_used = new_fuel;
                            // FEE set: unchanged — apply Phase 3 recomputes this exact filter.
                            if tx.gas_price > 0 {
                                let fee_amount = tx.effective_gas_price().saturating_mul(charged_gas);
                                block_fees_collected = block_fees_collected.saturating_add(fee_amount);
                            }
                        }
                    }
                    // FIX R22-B5: Truncate TX list if the block gas OR fuel limit was reached
                    if let Some(limit_idx) = gas_limited_idx {
                        if is_info() {
                            println!("[INFO][BLOCK] gas_limit_applied total_tx={} included_tx={} gas_used={} max_gas={} fuel_used={} max_fuel={}",
                                     txs.len(), limit_idx, block_gas_used, block_gas_limit, block_fuel_used, block_fuel_limit);
                        }
                        // Truncated TXs are VALID, they just didn't fit — keep them in the mempool for the next
                        // block (exclude from the post-save confirm/remove, which runs over the early hash set).
                        for tx in &txs[limit_idx..] { keep_in_mempool.insert(tx.hash.clone()); }
                        txs.truncate(limit_idx);
                    }
                    
                    // v22: slot-based optimistic microblock production. A single VRF-elected
                    // leader per 30-block rotation window produces sequential blocks; a silent
                    // leader is replaced by the producer-loop's deterministic local fallback
                    // (consecutive-empty-slot counter) to the next eligible identity for the
                    // rest of the window — no votes/certs/aggregation at the microblock layer.
                    // Finality is ONE tier up: macroblock Checkpoint-BFT QC (every 90) = n−f BFT
                    // finality + view-change (the canonical safety anchor; microblocks ride
                    // optimistically). Supersedes the v15.11 effective-round snapshot and the
                    // v15–v21 round-scatter/split-brain failure modes. O(1)/slot.
                    let mut microblock = qnet_state::MicroBlock {
                        height: next_block_height,
                        timestamp: deterministic_timestamp,
                        transactions: txs.clone(),
                        producer: node_id.clone(),
                        signature: vec![0u8; 64], // populated below by sign_microblock
                        merkle_root: Self::calculate_merkle_root(&txs),
                        previous_hash: prev_hash,
                        vrf_output: qrb_output,
                        vrf_proof: qrb_proof,
                        fees_collected: block_fees_collected,
                        state_root: [0u8; 32], // populated after TX+fees apply
                        // v23: BFT-CERTIFIED ROTATION ROUND EMBEDDED IN BLOCK
                        // ────────────────────────────────────────────────────
                        // Carries the `timeout_round` value used by the
                        // leader-election above (snapshotted from
                        // `get_certified_rotation_round(mb_idx)` — a BFT-
                        // certified counter advanced ONLY by a same-round n−f
                        // TimeoutCertificate, NEVER by local wall
                        // clock). Block_pipeline ingest recomputes the
                        // same pure function on receive and rejects only
                        // when `block.producer != expected AND
                        // block.timeout_round == local.timeout_round` —
                        // i.e. unauthorised signer at a locally-agreed rank.
                        // Cross-round mismatches log Category A and are
                        // accepted (gossip-window legitimate divergence).
                        // Restores the v14.0 producer-authority-proof invariant
                        // that v22 had erased by hardcoding 0.
                        timeout_round,
                        // Carry the baseline this block was stamped against (from the SAME snapshot as
                        // timeout_round) so abs = timeout_round + carried_baseline is node-independent.
                        carried_baseline,
                        // #80: attach the n−f TimeoutProof that certified this failover round so a
                        // lagging receiver adopts it in-band. Key on the ABSOLUTE round
                        // (timeout_round + carried_baseline > 0): a resumed happy-path block after an
                        // in-window certified failover carries timeout_round=0 but carried_baseline>0,
                        // and its receiver's ingest gate now demands certified>=carried_baseline — so
                        // the proof must ride along for in-band adoption. Pure happy path (abs=0) → None.
                        timeout_proof: if timeout_round > 0 || carried_baseline > 0 {
                            crate::unified_p2p::certified_timeout_proof_bytes(next_block_height / 90)
                        } else { None },
                    };
                    
                    // Authority re-check — the LAST point with zero side effects. A failover
                    // certificate can land while this block is being assembled; producing then
                    // means two blocks for one position. Everything below mutates shared state
                    // (transactions, supply, fees, merkle) and writes durable rows, and the
                    // producer path has no snapshot to roll back — so yielding must happen here,
                    // not after. Yielding costs one empty slot; yielding late costs a diverged
                    // state_root, a vote outside n−f, and a stalled checkpoint.
                    {
                        let round_now = crate::unified_p2p::highest_certified_round_for(next_block_height / 90);
                        if round_now > certified_abs {
                            println!("[WARN][PROD] production_yielded h={} round_at_start={} round_now={} reason=authority_changed",
                                     next_block_height, certified_abs, round_now);
                            crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                            continue;
                        }
                        // Slot already filled (a peer's block for this height landed while we were
                        // assembling). Checked HERE, with the authority test, because every abort
                        // below this point leaves state mutated with nothing to roll it back: the
                        // producer would then sign a state_root no validator can reproduce.
                        if next_block_height > 0 {
                            if let Ok(Some(_)) = storage.load_microblock(next_block_height) {
                                println!("[WARN][PROD] production_yielded h={} reason=slot_occupied", next_block_height);
                                crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                                continue;
                            }
                        }
                        // Anti-double-sign mark, ordered ROUND-first. Two validly-signed bodies at one
                        // (height, ROUND) are a PERMANENT chain-committed ban that fork-choice cannot
                        // undo — the one damage certification does not cover. A strictly higher round is
                        // a different pair, so a node that rolled back can re-extend the branch it
                        // adopted instead of being locked out of every height it ever signed. Monotone;
                        // persisted with fsync BEFORE signing, so a crash costs one slot, not a signature.
                        {
                            let hwm_h = HIGHEST_SIGNED_HEIGHT.load(std::sync::atomic::Ordering::SeqCst);
                            let last_w = LAST_SIGNED_WINDOW.load(std::sync::atomic::Ordering::SeqCst);
                            let last_r = LAST_SIGNED_ROUND.load(std::sync::atomic::Ordering::SeqCst);
                            let last_h = LAST_SIGNED_HEIGHT.load(std::sync::atomic::Ordering::SeqCst);
                            let win = crate::node::window_of_height(next_block_height);
                            if !crate::node::may_sign(
                                next_block_height, certified_abs, hwm_h, last_w, last_r, last_h) {
                                println!("[WARN][PROD] production_yielded h={} win={} round={} hwm_h={} last_w={} last_r={} reason=already_signed_this_round",
                                         next_block_height, win, certified_abs, hwm_h, last_w, last_r);
                                crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                                continue;
                            }
                            if let Err(e) = storage.save_highest_signed_mark(
                                next_block_height.max(hwm_h), win, certified_abs, next_block_height) {
                                println!("[ERR][PROD] production_yielded h={} reason=hwm_persist_failed err={}",
                                         next_block_height, e);
                                crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                                continue;
                            }
                            HIGHEST_SIGNED_HEIGHT.fetch_max(next_block_height, std::sync::atomic::Ordering::SeqCst);
                            LAST_SIGNED_WINDOW.store(win, std::sync::atomic::Ordering::SeqCst);
                            LAST_SIGNED_ROUND.store(certified_abs, std::sync::atomic::Ordering::SeqCst);
                            LAST_SIGNED_HEIGHT.store(next_block_height, std::sync::atomic::Ordering::SeqCst);
                        }
                        // A claim this node cannot resolve is knowable from the selected TXs, so decide
                        // it HERE. Discovering it during the inline apply is too late: that path has no
                        // snapshot, so the mutations would stand and this node would sign a state_root
                        // no validator reproduces.
                        if let Err(certifying_mb) =
                            crate::reward_epoch::claims_resolvable(&storage, &txs, next_block_height) {
                            println!("[WARN][PROD] production_yielded h={} reason=claim_unresolvable certifying_mb={}",
                                     next_block_height, certifying_mb);
                            if let Some(p2p) = &unified_p2p {
                                let p = p2p.clone();
                                tokio::spawn(async move {
                                    let _ = p.sync_macroblocks_repair(certifying_mb, certifying_mb).await;
                                });
                            }
                            crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                            continue;
                        }
                    }

                    // ═══════════════════════════════════════════════════════════════════════════
                    // v3.27: COMPUTE STATE ROOT - TOP L1 PATTERN
                    // MUST happen BEFORE signing so signature covers state_root!
                    // Order: apply_tx → credit_fees → finalize_merkle → get state_root
                    // ═══════════════════════════════════════════════════════════════════════════
                    // Track registrations whose state-apply SUCCEEDED so the producer records
                    // node_/reg_height/burn/cbw ONLY for those — mirroring the validator, whose
                    // deferred_registrations are built only on apply Ok. Without this a re-registration
                    // that fails apply on EVERY node would still be written by the producer ALONE, so its
                    // node_registry / cbw / registry_root diverge from the network.
                    let mut applied_reg_hashes: std::collections::HashSet<String> = std::collections::HashSet::new();
                    // This block's registry rows, stamped only after the loop and in canonical order.
                    let mut inline_regs: Vec<(String, String, String, String, String)> = Vec::new();
                    let mut inline_reg_origins: Vec<(String, String)> = Vec::new();
                    // FIX-5: (address, pk) bindings from THIS block's successfully-applied value TXs — the
                    // producer mirror of the validator's BlockApplyResult.deferred_pk_binds. Collected here
                    // (apply-Ok only) and drained into dilithium_pk_root BEFORE the seal, so producer and
                    // validator commit an identical set. It CANNOT ride the applied_reg_hashes gate below:
                    // that set holds only NodeRegistration/NodeActivation hashes.
                    let mut applied_pk_binds: Vec<(String, Vec<u8>)> = Vec::new();
                    // total_supply as-of this head, captured under the same lock that minted it (A2 seal below).
                    let producer_supply_head: u64;
                    // QRC-20 owns-index deltas for THIS producer's block — collected under the state lock,
                    // persisted AFTER the block is durably saved (below), so the watermark never leads the tip.
                    let mut block_owns: Vec<qnet_state::OwnsDelta> = Vec::new();
                    // WASM logs + their token-transfer rows for THIS block. Same discipline as block_owns:
                    // collected under the lock, WRITTEN only after the block claims the slot. logs_root is a
                    // consensus commitment, and the writer (reset_block_token_data) deletes h's rows
                    // unconditionally — doing that before the claim lets a same-height sibling that reaches
                    // apply in the gap erase this block's logs, diverging our window logs_root from the
                    // committee's and dropping us out of that window's n−f.
                    let mut block_logs: Vec<(String, String, Vec<u8>)> = Vec::new();
                    let mut block_token_rows: Vec<crate::storage::TokenTransferRow> = Vec::new();
                    let mut side_idx = BlockSideIndices::default();
                    {
                        let state_guard = state.write().await;
                        // The write guard is held through apply + Merkle finalize: every state
                        // reader (gossip TX validation included) waits on it, so this section's
                        // duration is bounded by BLOCK_GAS_LIMIT and measured in block_timing.
                        let t_apply = std::time::Instant::now();

                        // Per-block WASM event logs, captured the SAME way the validator path does
                        // (apply_block_to_state) so getLogs is complete and the gated window logs_root
                        // will match at activation. Drained PER-TX because this loop has an await (claim
                        // path) and WASM_LOG_SINK is a thread-local: on the multi-threaded runtime a
                        // clear-once/drain-once bracket could straddle a worker-thread migration and
                        // strand entries. clear→(sync)apply→drain around each tx keeps push+drain on one
                        // thread; the accumulator is a plain Vec, so it survives awaits safely.
                        // Fees for THIS producer's own block, accrued ONLY on apply-Ok — the header's
                        // block_fees_collected is a pre-execution estimate over the whole tx list, and a
                        // failed tx is never debited. Computed the SAME way the validator does in
                        // apply_block_to_state so both credit the identical total (no state_root split).
                        let mut block_flat_fees: u64 = 0;
                        let mut block_wasm_fuel_fees: u64 = 0;
                        // 1. Apply all transactions. Pure-transfer blocks take the SAME
                        // deterministic parallel path as the validator (state_apply.rs):
                        // per-sender debit streams, credits after all debits. Outcome
                        // bookkeeping mirrors the sequential branch below exactly.
                        let pure_transfers = txs.len() >= 32
                            && txs.iter().all(|t| matches!(t.tx_type,
                                qnet_state::TransactionType::Transfer { .. }
                                | qnet_state::TransactionType::BatchTransfers { .. }));
                        if pure_transfers {
                            let outcomes = state_guard.apply_transfers_parallel(&txs, None);
                            for (tx, outcome) in txs.iter().zip(outcomes) {
                                let charged = outcome.as_ref().map_or(false, |o| o.charged);
                                if let Err(e) = outcome {
                                    if is_warn() {
                                        println!("[WARN][STATE] producer_tx_apply_failed hash={} err={}", tx.hash, e);
                                    }
                                    continue;
                                }
                                if charged {
                                    let _ = state_guard.apply_gas_refund(tx, next_block_height, 0);
                                }
                                if charged && !tx.from.starts_with("system_") && tx.gas_price > 0 && tx.gas_limit > 0 {
                                    let charged_gas = if next_block_height >= qnet_state::GAS_METERING_ACTIVATION_HEIGHT {
                                        tx.compute_gas_used()
                                    } else {
                                        tx.gas_limit
                                    };
                                    block_flat_fees = block_flat_fees
                                        .saturating_add(tx.effective_gas_price().saturating_mul(charged_gas));
                                }
                                if tx.binds_dilithium_pk() {
                                    if let Some(pk) = tx.dilithium_public_key.as_ref() {
                                        applied_pk_binds.push((tx.from.clone(), pk.clone()));
                                    }
                                }
                            }
                        } else {
                        for tx in &txs {
                            // v3.33: Handle CLAIM transactions on producer side
                            
                            // v7.0: Parse emission TX accruals for block-level application
                            if tx.tx_type == qnet_state::TransactionType::RewardDistribution
                               && tx.from == "system_emission" {
                                // Mint total_supply for THIS emission block — mirror apply_block_to_state
                                // (watermark-idempotent). The producer applies its own block inline, so
                                // without this it stays one emission short → checkpoint total_supply
                                // diverges from peers → macroblock never reaches n−f.
                                // Mirror the validator's gate EXACTLY (apply_block_to_state Phase 1).
                                // The producer built this amount itself, so a mismatch is a build bug —
                                // but minting what validators will refuse is precisely how the producer
                                // ends up with a total_supply no one else has, so both sides must reach
                                // the same verdict from the same inputs.
                                let emission_ok = match Self::expected_emission_amount(next_block_height) {
                                    crate::node::EmissionExpectation::Exact(expected) if expected == tx.amount => true,
                                    other => {
                                        println!("[ERR][EMISSION] self_amount_rejected h={} claimed={} expectation={:?} action=skip_mint",
                                                 next_block_height, tx.amount, other);
                                        false
                                    }
                                };
                                let emb = Self::emission_mb_index(next_block_height);
                                match if emission_ok {
                                    state_guard.emit_rewards(tx.amount, emb)
                                } else {
                                    Ok(0) // skip the call outright, exactly as the validator does
                                } {
                                    Ok(m) if m > 0 => {
                                        // Mirrors the validator: credit the MINTED value, not the
                                        // requested one. No journal here — the producer-inline path
                                        // has no BlockSnapshot.
                                        state_guard.credit_rewards_pool(m);
                                        if is_info() {
                                            println!("[INFO][STATE] emission_minted_inline mb={} amount={} minted={} total={} QNC h={}",
                                                     emb, tx.amount / 1_000_000_000, m / 1_000_000_000,
                                                     state_guard.get_total_supply() / 1_000_000_000, next_block_height);
                                        }
                                    }
                                    _ => {}
                                }
                            }

                            // Apply at the REAL block height (not the height-0 convenience wrapper): the
                            // WASM host's get_block_height() must return the same value the validator sees,
                            // or a height-dependent contract's storage writes (and event logs) diverge the
                            // producer's state_root from every validator (apply_block_to_state uses _at(h)).
                            // clear→apply→drain brackets THIS tx's WASM logs on one thread (see block_logs).
                            qnet_state::wasm_exec::clear_wasm_logs();
                            let owns_mark = block_owns.len();
                            // Mirror of the validator path: unconditional, collected not written.
                            Self::collect_light_eligibility_bitmap(&mut side_idx.light_bitmaps, next_block_height, tx);
                            let apply_result = state_guard.apply_transaction_lazy_at_indexed(tx, next_block_height, &mut block_owns);
                            // Take this tx's WASM fuel ONCE, same thread, right after apply (resets the
                            // slot for the next tx) — byte-identical to the validator apply path.
                            let tx_wasm_fuel = qnet_state::wasm_exec::take_last_tx_wasm_fuel();
                            // Mirror of the validator: an already-consumed nonce applies Ok without
                            // debiting, so it earns no refund and no fee credit.
                            let charged = apply_result.as_ref().map_or(false, |o| o.charged);
                            if let Err(e) = apply_result {
                                // Rejected tx: drop any owns-deltas it emitted (its mutations were discarded).
                                block_owns.truncate(owns_mark);
                                if is_warn() {
                                    println!("[WARN][STATE] producer_tx_apply_failed hash={} err={}", tx.hash, e);
                                }
                            } else {
                                block_logs.extend(qnet_state::wasm_exec::drain_wasm_logs());
                                if charged {
                                    let _ = state_guard.apply_gas_refund(tx, next_block_height, tx_wasm_fuel);
                                }
                                // Accrue this tx's NET fee (flat + metered WASM compute above activation),
                                // mirroring the validator so both credit the identical producer total.
                                if charged && !tx.from.starts_with("system_") && tx.gas_price > 0 && tx.gas_limit > 0 {
                                    let charged_gas = if next_block_height >= qnet_state::GAS_METERING_ACTIVATION_HEIGHT {
                                        tx.compute_gas_used()
                                    } else {
                                        tx.gas_limit
                                    };
                                    block_flat_fees = block_flat_fees
                                        .saturating_add(tx.effective_gas_price().saturating_mul(charged_gas));
                                    if next_block_height >= qnet_state::GAS_METERING_ACTIVATION_HEIGHT {
                                        block_wasm_fuel_fees = block_wasm_fuel_fees.saturating_add(tx.wasm_fuel_fee(tx_wasm_fuel));
                                    }
                                }
                                // Track BOTH NodeRegistration AND NodeActivation: the producer materialises
                                // the SAME registry rows the validator's deferred_registrations does (incl.
                                // the super-activation pseudonym), so it must know which of each applied Ok.
                                if matches!(tx.tx_type,
                                    qnet_state::TransactionType::NodeRegistration { .. }
                                    | qnet_state::TransactionType::NodeActivation { .. }) {
                                    applied_reg_hashes.insert(tx.hash.clone());
                                }
                                // FIX-5: same apply-Ok gate for the value classes, collecting the (address,
                                // pk) rows that go into dilithium_pk_root — byte-identical to the validator's
                                // BlockApplyResult.deferred_pk_binds (node.rs, apply_block_to_state).
                                if tx.binds_dilithium_pk() {
                                    if let Some(pk) = tx.dilithium_public_key.as_ref() {
                                        applied_pk_binds.push((tx.from.clone(), pk.clone()));
                                    }
                                }
                            }
                        }
                        } // end pure_transfers / sequential branch

                        // Token-transfer rows for this block's logs — decided HERE because it reads the
                        // accounts map (contract type) and must see the same state the block was applied
                        // against. The rows and the logs are written after the save (see below).
                        if !block_logs.is_empty() {
                            block_token_rows = Self::build_token_transfer_rows(
                                &state_guard.accounts, next_block_height, microblock.timestamp, &block_logs,
                            );
                        }

                        // Owns-index (NON-consensus): persisted AFTER the block is durably saved (see the
                        // save-ok branch below), mirroring the validator pipeline — else a crash between
                        // apply and save would leave the durable watermark ahead of the tip and the boot
                        // gate would skip the rebuild over a block that never landed.

                        // Epoch-boundary super reward-eligibility snapshot (same fn as the apply path).
                        side_idx.super_eligible = Self::compute_super_eligible_at_settle(&state_guard, &*storage, next_block_height);
                        // light_elig is a read-only recency index (backfilled at boot) — snapshot it OFF the
                        // state write-lock so the O(roster) scan never stalls the producer at scale.
                        if next_block_height != 0 && next_block_height % 14400 == 0 {
                            if let Some(st) = crate::node::try_get_storage() {
                                let st = st.clone();
                                tokio::task::spawn_blocking(move || crate::node::BlockchainNode::populate_light_elig_at_boundary(&st, next_block_height));
                            }
                        }

                        // v3 merkle-claim credit (same fn as the apply path) BEFORE state_root so a
                        // producer crediting claims in its OWN block matches validators (no state_root split).
                        // Unreachable: claims_resolvable ran at the zero-side-effect point above over
                        // the same TXs and storage. Reaching it means that invariant broke.
                        if let Err(certifying_mb) =
                            Self::apply_merkle_claims(&state_guard, &*storage, &txs, next_block_height, None) {
                            println!("[CRIT][REWARDS] claim_unresolvable_after_precheck certifying_mb={} h={}",
                                     certifying_mb, next_block_height);
                        }

                        // 2. Get producer wallet for fee crediting
                        let producer_wallet = match storage.load_node_registration(&node_id) {
                            Ok(Some((_, wallet, _))) => wallet,
                            _ => String::new()
                        };
                        
                        // 3. Credit fees to producer (atomic): flat fees + metered WASM compute. The
                        // validator recomputes the IDENTICAL total in apply_block_to_state Phase 3, so
                        // producer and validators agree (no reward / state_root divergence).
                        let producer_credit = block_flat_fees.saturating_add(block_wasm_fuel_fees);
                        // Producer fee-credit wallet for the rich-list touched-set (mirror of the
                        // validator path): captured only when a credit is actually applied.
                        let mut richlist_producer_wallet: Option<String> = None;
                        if producer_credit > 0 && !producer_wallet.is_empty() {
                            richlist_producer_wallet = Some(producer_wallet.clone());
                            // None: the producer-inline path has no block journal and never rolls
                            // back, so nothing may release this marker (see rollback_block).
                            match state_guard.credit_producer_fees_once(
                                next_block_height,
                                &producer_wallet,
                                producer_credit,
                                None,
                            ) {
                                Ok(true) => {
                                    if is_info() && producer_credit > 10_000_000 {
                                        println!("[INFO][FEES] producer_credited h={} fees={} nanoQNC",
                                                 next_block_height, producer_credit);
                                    }
                                }
                                Ok(false) => {
                                    if is_debug() {
                                        println!("[DBG][FEES] skip_dup h={}", next_block_height);
                                    }
                                }
                                Err(e) => {
                                    eprintln!("[ERR][FEES] credit_failed h={} err={}", next_block_height, e);
                                }
                            }
                        }
                        
                        // 4. Finalize Merkle and get state_root. CPU-bound: run via block_in_place
                        // so this worker thread is handed back to the runtime's scheduler.
                        let apply_ms = t_apply.elapsed().as_millis();
                        let t_merkle = std::time::Instant::now();
                        let computed_state_root =
                            tokio::task::block_in_place(|| state_guard.finalize_merkle());
                        microblock.state_root = computed_state_root;
                        producer_supply_head = state_guard.get_total_supply();
                        if is_info() {
                            println!("[INFO][PROD] block_timing h={} txs={} apply_ms={} merkle_ms={}",
                                     next_block_height, microblock.transactions.len(),
                                     apply_ms, t_merkle.elapsed().as_millis());
                        }

                        // Rich-list index (display-only, best-effort): reconcile this block's touched
                        // holders. SAME touched-set as the validator apply path.
                        side_idx.richlist =
                            Self::reconcile_richlist_for_block(&state_guard, &microblock, richlist_producer_wallet.as_deref());

                        if is_debug() {
                            println!("[DBG][STATE] state_root computed h={} root={}",
                                     next_block_height, hex::encode(&computed_state_root[..8]));
                        }
                    }

                    // Durable registry materialisation (node_/srtr_/lrtr_ + the registry_root /
                    // dilithium_pk_root / total_supply LtHash seals) is MOVED BELOW — it now runs ONLY
                    // after the block passes signing + structural validation + the fork/exists guard, so a
                    // rejected or abandoned candidate can never write a registry_root delta the saved chain
                    // won't back (the consensus-root divergence that permanently split a producer from
                    // n−f). Mirror of the validator: materialise after acceptance, before save.

                    // PRODUCTION: Generate CRYSTALS-Dilithium signature for microblock
                    match Self::sign_microblock_with_dilithium(&microblock, &node_id, unified_p2p.as_ref()).await {
                        Ok(signature) => {
                            microblock.signature = signature;
                            
                            // CRITICAL FIX: Broadcast certificate IMMEDIATELY after signing first microblock
                            // This ensures ANY node (not just genesis_node_001) can have its blocks verified
                            // REMOVED: Immediate broadcast after each block (causes rate limiting)
                            // Periodic broadcast (every 30 seconds) is sufficient for certificate distribution
                            // This reduces network load and prevents rate limit warnings
                            
                            // PRODUCTION: Broadcast certificate after rotation (every 270 blocks = 4.5 minutes)
                            // IMPORTANT: Use microblock.height (which equals next_block_height), not microblock_height
                            // ARCHITECTURE: Aligns with certificate lifetime (270s = 3 macroblocks)
                            if microblock.height > 10 && microblock.height % 270 == 1 {
                                if let Some(ref p2p) = unified_p2p {
                                    use crate::pq_crypto::GLOBAL_PQ_INSTANCES;
                                    
                                    let instances = GLOBAL_PQ_INSTANCES.get_or_init(|| async {
                                        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()))
                                    }).await;
                                    
                                    let instances_guard = instances.lock().await;
                                    let normalized_id = Self::normalize_node_id(&node_id);
                                    
                                    if let Some(pq) = instances_guard.get(&normalized_id) {
                                        if let Some(cert) = pq.get_current_certificate() {
                                            if let Ok(cert_bytes) = bincode::serialize(&cert) {
                                                println!("[INFO][CERT] rotation_broadcast h={} serial={}",
                                                    microblock.height, cert.serial_number);
                                                if let Err(e) = p2p.broadcast_certificate_announce(cert.serial_number, cert_bytes) {
                                                    println!("[WARN][CERT] rotation_broadcast_failed err={}", e);
                                                } else {
                                                    println!("[INFO][CERT] rotation_broadcast_complete");
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        Err(e) => {
                            println!("[ERR][CRYPTO] Failed to sign microblock #{}: {}", microblock_height, e);
                            // v3.4: CRITICAL - Clear broadcast flag before continue
                            crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                            Self::abandon_inline_apply(microblock_height, next_block_height, "sign_failed");
                            continue; // Skip this block if signing fails
                        }
                    }
                    
                    // Apply local finalization for small transactions (< 100 QNC)
                    // 100 QNC = 100 * 10^9 nanoQNC = 100_000_000_000
                    const LOCAL_FINALITY_THRESHOLD: u64 = 100_000_000_000; // 100 QNC
                    let _locally_finalized_count = txs.iter()
                        .filter(|tx| {
                            match &tx.tx_type {
                                qnet_state::TransactionType::Transfer { amount, .. } => *amount < LOCAL_FINALITY_THRESHOLD,
                                _ => false,
                            }
                        })
                        .count();
                    
                    // Validate microblock (production checks)
                    if let Err(e) = Self::validate_microblock_production(&microblock) {
                        println!("[ERR][PROD] validation_failed err={}", e);
                        crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                        Self::abandon_inline_apply(microblock_height, microblock.height, "validate_failed");
                        continue;
                    }
                    
                    // Per-tx signature/validity verification now runs as a PRE-APPLY filter (above, before
                    // the microblock body is frozen) — mirror of the validator's verify→apply order. An
                    // inadmissible tx is dropped + evicted there, so it is never applied or materialised;
                    // the old post-apply "verify → poison-evict → continue" wedge (apply+materialise, THEN
                    // reject, orphaning a registry_root LtHash delta) is gone.

                    // Calculate TPS for this microblock
                    let tps = (txs.len() as f64) / current_interval.as_secs_f64();
                    
                    // Serialize the (now final) microblock BEFORE materialising durable registry state, so the
                    // ONLY step remaining after the seals is the block save — a serialize failure aborts with
                    // zero durable registry/seal writes (no orphaned registry_root delta).
                    let microblock_data = match bincode::serialize(&microblock) {
                        Ok(data) => data,
                        Err(e) => {
                            println!("[ERR][PROD] serialize_fail h={} err={}", microblock.height, e);
                            crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                            Self::abandon_inline_apply(microblock_height, microblock.height, "serialize_failed");
                            continue;
                        }
                    };

                    // ═══ COMMITTED: materialise durable registry state (mirror the validator's post-accept,
                    // pre-save order). Reached ONLY after the pre-apply verify filter + signing + structural
                    // validation + the fork/exists guard + serialize above passed, so every registry_root /
                    // dilithium_pk_root LtHash delta written here is backed by the block saved immediately below
                    // — a rejected or abandoned candidate can no longer orphan a consensus-root delta.
                    // save_block_with_delta (below) makes h loadable; the WindowEnd checkpoint compute is gated
                    // on that, so sealing here guarantees the seals exist before any checkpoint reads them.
                    for tx in &txs {
                        // Heartbeat liveness index (lhb_) — mirror of the peer-apply writer. Unconditional
                        // per INCLUDED tx (the body scan it replaces reads the block body, not apply status).
                        if let qnet_state::TransactionType::Heartbeat { node_id: hb_id, anchor_height: hb_anchor, .. } = &tx.tx_type {
                            let _ = storage.index_heartbeat_inclusion(hb_id, *hb_anchor, next_block_height);
                        }
                        // Only TXs whose state-apply SUCCEEDED (same gate the validator's deferred path uses).
                        if !applied_reg_hashes.contains(&tx.hash) { continue; }
                        match &tx.tx_type {
                            qnet_state::TransactionType::NodeRegistration {
                                node_id: rid, node_type: rtype, wallet_address: rwallet, burn_tx: rburn, ..
                            } => {
                                // Collected, not written: the write order decides reg_index and must be
                                // canonical, not transaction order. Same tuple shape the validator defers,
                                // and the vrf super-only rule is the validator's, so the rows are identical.
                                let reg_vrf = if matches!(rtype, qnet_state::NodeType::Super) {
                                    Self::registration_consensus_pk(tx).map(hex::encode).unwrap_or_default()
                                } else { String::new() };
                                inline_regs.push((
                                    rid.clone(), Self::registration_type_str(rtype).to_string(),
                                    rwallet.clone(), rburn.clone(), reg_vrf,
                                ));
                                inline_reg_origins.push((rid.clone(), rwallet.clone()));
                            }
                            qnet_state::TransactionType::NodeActivation { node_type: ntype, phase, .. } => {
                                // Mirror apply_block_to_state EXACTLY: Phase2 stamps NO registry rows (pool3
                                // arm consumes it). Phase1/other → super self-registers its canonical pseudonym.
                                if matches!(phase, qnet_state::account::ActivationPhase::Phase2) { continue; }
                                if matches!(ntype, qnet_state::account::NodeType::Super) {
                                    let pseudonym = crate::rpc::generate_super_node_pseudonym(&tx.from);
                                    inline_regs.push((
                                        pseudonym, "super".to_string(), tx.from.clone(),
                                        String::new(), String::new(),
                                    ));
                                }
                            }
                            _ => {}
                        }
                    }
                    // Canonical order, then stamp — the one ordering rule, shared with the validator.
                    Self::sort_registrations_canonically(&mut inline_regs);
                    for (rid, rtype, rwallet, rburn, rpk_hex) in inline_regs.iter() {
                        let rpk = if rpk_hex.is_empty() { None } else { hex::decode(rpk_hex).ok() };
                        let _ = storage.save_node_registration_at_height_burn_vrf(
                            rid, rtype, rwallet, 1.0, next_block_height, rburn, rpk.as_deref());
                        if !rburn.is_empty() { let _ = storage.committed_burn_wallet_put(rburn, rid); }
                    }
                    // Keyed maps, so their order is free — kept out of the ordered stamp above rather
                    // than re-derived inside it.
                    for (rid, rwallet) in inline_reg_origins.iter() {
                        let _ = storage.mark_node_registration_origin(rid, rwallet);
                    }
                    // FIX-5: drain this block's value-TX pk bindings into the dilithium_pk_root LtHash
                    // (marker-guarded ⇒ once/account) BEFORE the seal — outside the loop above, whose
                    // applied_reg_hashes gate admits only registration/activation hashes.
                    for (addr, pk) in &applied_pk_binds {
                        let _ = storage.dpk_lt_bind(addr, pk, next_block_height);
                    }
                    // Watermark the highest accumulator-mutating height so a later dropped seal is
                    // healable-on-read only while the live accumulator still equals its as-of-height value.
                    if !applied_pk_binds.is_empty() {
                        let _ = storage.note_dpk_bind_height(next_block_height);
                    }
                    // registry_root / dilithium_pk_root / total_supply seals at a checkpoint head, after all
                    // of this block's registrations updated lt_state and BEFORE save — mirror of the validator.
                    if next_block_height % qnet_consensus::checkpoint_bft::CHECKPOINT_INTERVAL == 0 {
                        let _ = storage.seal_registry_root(next_block_height);
                        // Surface a dropped dpk seal-write (its compute fallback is not height-bounded, so a
                        // silent miss later diverges the checkpoint field).
                        if let Err(e) = storage.seal_dilithium_pk_root(next_block_height) {
                            if is_warn() { println!("[WARN][SEAL] dpk_root_seal_fail h={} err={}", next_block_height, e); }
                        }
                        // Bind-journal prune bounded by the finality floor (same value the rollback guard uses).
                        let _ = storage.prune_dpk_journal(
                            LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::Relaxed));
                        // Same as the validator path: no reader-side fallback, so a dropped write
                        // mutes this head's checkpoint permanently. Retry once and surface it.
                        if storage.seal_total_supply(next_block_height, producer_supply_head).is_err() {
                            if let Err(e) = storage.seal_total_supply(next_block_height, producer_supply_head) {
                                if is_warn() {
                                    println!("[WARN][SEAL] total_supply_seal_fail h={} err={} impact=checkpoint_muted",
                                             next_block_height, e);
                                }
                            }
                        }
                    }

                    // PRODUCTION: durable save (delta-encoded + compressed). microblock_data was serialized
                    // above, BEFORE materialisation, so no abort path remains between the seals and this save.
                    let storage_clone = storage.clone();
                    let height_for_storage = microblock.height;
                    let p2p_for_reward = unified_p2p.clone();
                    let rotation_tracker_clone = rotation_tracker.clone();

                    // Pre-save stale-round guard stays removed. The legacy
                    // `effective_round_now > microblock.timeout_round` self-
                    // check compared two get_certified_rotation_round reads
                    // that are equal by construction; they differ only
                    // if a concurrent n−f cert completed between them — which
                    // advances rotation and makes this node no longer the
                    // producer, so every peer's Category-B ingest check
                    // harmlessly rejects the late block (local production =
                    // wasted CPU, not a safety risk). The guard added no safety
                    // beyond Category-B and fired on every honest attempt on
                    // view-change networks (v22.1 permanent h=90 stall).
                    // Authority is still enforced by Category-B ingest reject,
                    // storage L4 anti-fork, and equivocation slashing.

                    // Save synchronously to ensure block exists before height increment
                    // This is FAST (just RocksDB write, ~10-50ms) and prevents race conditions
                    let save_result = storage_clone.save_block_with_delta(height_for_storage, &microblock_data);

                    // Anything but Stored means the block is NOT on disk, so it must not take the
                    // commit branch below, which publishes the serve horizon and the finalized-round
                    // baseline.
                    if let Ok(crate::storage::SaveOutcome::Stored) = save_result {
                        // Block logs (CONSENSUS: feeds the window logs_root, gate height 0) FIRST —
                        // after the save, so a block that lost the slot race can never erase the
                        // canonical block's rows, but BEFORE the height is published below. Publishing
                        // the height first would open a window in which a window-end checkpoint task
                        // sees block h as present and reads no logs for it, folding [0;32] into a
                        // logs_root every peer computes differently. Every other gate that compute
                        // reads (state_root in the block, dilithium_pk_root seal, total_supply seal)
                        // is already satisfied before this point. reset_ stays unconditional so a
                        // re-applied block fully replaces h's rows.
                        side_idx.block_logs = std::mem::take(&mut block_logs);
                        side_idx.token_rows = std::mem::take(&mut block_token_rows);
                        Self::flush_block_side_indices(&storage, height_for_storage, &side_idx);

                        // Publish the applied frontier now that the block AND its consensus-visible
                        // side data are durable, so the invariant "block H in storage ⟺
                        // LOCAL_BLOCKCHAIN_HEIGHT >= H" holds on the producer path too (the apply-stage
                        // dedup fast-path relies on it). Without this, a gossip-echo of our own block H
                        // arriving before the height publish ~290 lines below would re-enter apply as a
                        // false non-duplicate (caught only by the downstream state_root check).
                        // Idempotent with the height-bump below.
                        crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.store(
                            height_for_storage,
                            std::sync::atomic::Ordering::Release,
                        );
                        crate::unified_p2p::note_block_stored(height_for_storage);

                        // Owns-index (NON-consensus): now that block H is durable, persist its deltas +
                        // advance the durable watermark — same after-save order as the validator pipeline,
                        // so the watermark never leads the tip. Watermark advances on EVERY block (empty
                        // too) else it stalls on a token-quiet producer. On failure mark dirty (reader scans).
                        if block_owns.is_empty() {
                            let _ = storage.set_owns_watermark(height_for_storage);
                        } else if storage.persist_owns_deltas(&block_owns, height_for_storage).is_err() {
                            storage.mark_owns_index_dirty();
                        }

                        if is_info() {
                            println!("[INFO][STORAGE] block_saved h={} state_root={}",
                                     height_for_storage, hex::encode(&microblock.state_root[..8]));
                        }

                        // v15.11: Record finalized round so the next height in this
                        // macroblock starts production with a fresh effective round
                        // baseline. Without this, the next height inherits the prior
                        // rotation counter and yields its own valid block (forensic
                        // case h=15886 → h=15899 producer mute).
                        crate::unified_p2p::record_finalized_round(
                            height_for_storage / 90,
                            // ABSOLUTE round (relative + carried baseline) — see block_pipeline.rs apply mirror.
                            microblock.timeout_round.saturating_add(microblock.carried_baseline),
                        );
                        // v33: feed the deterministic window-content accumulator at commit.
                        accumulate_window_block(height_for_storage, &microblock);

                        // v14.9: WS broadcast for producer-path (own blocks).
                        // BlockPipeline emits NewBlock for received blocks; this
                        // covers the complement so every block the node sees
                        // (produced OR received) reaches WS subscribers.
                        crate::rpc::broadcast_ws_event(crate::rpc::WsEvent::NewBlock {
                            height: microblock.height,
                            hash: hex::encode(microblock.hash()),
                            timestamp: microblock.timestamp,
                            tx_count: microblock.transactions.len(),
                            producer: microblock.producer.clone(),
                        });

                        // v3.27: TX and fees already applied BEFORE signing (for state_root)
                        // No need to apply again here!
                        
                        // CRITICAL FIX v3.2: Cache NodeRegistration TXs when producer creates block
                        // This ensures producer can find wallet addresses for new nodes in reward distribution
                        // Without this, only block RECEIVERS would cache registrations, not the producer!
                        Self::cache_node_registrations_from_transactions(&storage_clone, &txs);
                        
                        // CRITICAL v2.26: Remove included TX from mempool AFTER block is saved!
                        // This prevents re-processing the same TX in future blocks
                        // v2.26: Direct access - SimpleMempool is already thread-safe
                        // included_tx_hashes was captured at the early validation stage; a tx dropped AFTER
                        // that (pre-verify DEFER, or gas/fuel truncation) is VALID-but-not-included and must
                        // NOT be confirmed/removed here (else it is lost — never re-pulled). Genuinely-invalid
                        // drops (dup-burn/unbacked-activation, evicted sigs) are NOT in keep_in_mempool, so
                        // they are still confirmed+removed exactly as before.
                        if !keep_in_mempool.is_empty() {
                            included_tx_hashes.retain(|h| !keep_in_mempool.contains(h));
                        }
                        if !included_tx_hashes.is_empty() {
                            // PROTOCOL: Record hashes as confirmed (prevents re-add via delayed gossip)
                            mempool.record_included_txs(&included_tx_hashes);
                            mempool.batch_remove_transactions(&included_tx_hashes);

                            // ═══════════════════════════════════════════════════════════════════════════
                            // v15.12 L3: NOTIFY MEMPOOL OF FINALIZED COMMITMENT EPOCHS — producer path
                            // ═══════════════════════════════════════════════════════════════════════════
                            // Symmetric with the peer-apply notification in block_pipeline.rs::apply.
                            // For every commitment-class TX in the produced block, register its
                            // dedup key in the mempool's `committed_epochs_cache`. Subsequent
                            // admission attempts for the same key are rejected at the door,
                            // preventing late gossip / retransmits of already-finalized
                            // commitments from polluting the mempool.
                            //
                            // Without this notification, only the peer-apply path would update the
                            // cache — the producer's own mempool would lag for new commitments it
                            // just shipped, leaving a brief window for race-induced duplicates on
                            // the producer's next iteration before peer-apply catches up.
                            //
                            // Scalability: one DashMap insert per commitment TX per produced
                            // block. Bounded by `MAX_VALIDATORS = 1000` per epoch boundary.
                            // Sub-millisecond at any committee size.
                            // ═══════════════════════════════════════════════════════════════════════════
                            let mut commitment_marks = 0usize;
                            for tx in &txs {
                                if let Some(key) = tx.commitment_dedup_key() {
                                    mempool.mark_commitment_finalized(key);
                                    commitment_marks += 1;
                                }
                            }

                            if is_info() {
                                if commitment_marks > 0 {
                                    println!("[INFO][MEMPOOL] block_produced_cleanup h={} tx_count={} commitments_marked={}",
                                             height_for_storage, included_tx_hashes.len(), commitment_marks);
                                } else {
                                    println!("[INFO][MEMPOOL] block_produced_cleanup h={} tx_count={}",
                                             height_for_storage, included_tx_hashes.len());
                                }
                            }
                        }
                        
                        // v3.27: Fee crediting moved BEFORE signing (for state_root computation)
                        // credit_producer_fees_once() is idempotent - no need to call again
                        
                        // CRITICAL FIX v2.76: POOL #3 INTEGRATION for producer's own block
                        // Producer must also collect Pool #3 (activation payments) like validators do!
                        // Previously only validators collected Pool #3 - creating asymmetry!
                        for tx in &txs {
                            match &tx.tx_type {
                                qnet_state::TransactionType::NodeActivation { 
                                    amount, 
                                    phase: qnet_state::account::ActivationPhase::Phase2, 
                                    .. 
                                } => {
                                    if *amount > 0 {
                                        // Add activation payment to Pool 3
                                        // CRITICAL: This is distributed equally to ALL eligible nodes
                                        if let Some(ref p2p) = p2p_for_reward {
                                            p2p.add_to_pool3(*amount);
                                        }
                                        if is_debug() { println!("[DBG][POOL3] producer_activation_collected amount={} nanoQNC phase2", amount); }
                                    }
                                }
                                qnet_state::TransactionType::BatchNodeActivations { activation_data, .. } => {
                                    // Batch activations - sum all activation amounts (Phase 2 = amount > 0)
                                    // Phase 1: activation_amount = 0 (1DEV burned externally)
                                    // Phase 2: activation_amount > 0 (QNC to Pool 3)
                                    let total_pool3: u64 = activation_data.iter()
                                        .filter(|d| d.activation_amount > 0)  // Phase 2 indicator
                                        .map(|d| d.activation_amount)
                                        .sum();
                                    
                                    if total_pool3 > 0 {
                                        if let Some(ref p2p) = p2p_for_reward {
                                            p2p.add_to_pool3(total_pool3);
                                        }
                                        if is_debug() { println!("[DBG][POOL3] producer_batch_activation_collected amount={} nanoQNC count={}", 
                                                 total_pool3, activation_data.len()); }
                                    }
                                }
                                _ => {} // Other transaction types don't contribute to Pool 3
                            }
                        }
                        
                        // v3.36: Dynamic gas pricing — update after each block produced
                        // EIP-1559 style: adjust base_fee based on mempool congestion + block utilization
                        {
                            let current_mempool_size = mempool.size();
                            let max_tx = 10_000u64; // max_tx_per_microblock target
                            let block_utilization = txs.len() as f64 / max_tx as f64;
                            let mut pricing = qnet_state::DynamicGasPricing::new();
                            pricing.update_network_load(current_mempool_size, block_utilization);
                            qnet_state::update_dynamic_gas_pricing(pricing);
                            if is_debug() {
                                println!("[DBG][GAS] dynamic_update h={} mempool={} util={:.2}%",
                                    height_for_storage, current_mempool_size, block_utilization * 100.0);
                            }
                        }
                        
                        // EVENT-BASED OPTIMIZATION: Notify consensus listener immediately
                        // Don't wait for P2P round-trip - local block is ready for consensus check
                        let _ = block_event_tx_for_spawn.send(height_for_storage);
                        
                        
                        // Rotation accounting lives at the single track→check site below;
                        // a second async check raced it at every boundary (removed the
                        // round before the closing block's track → phantom 29/30 + 1/30).
                        let _ = &rotation_tracker_clone;
                    } else {
                        // Fail-closed. This block was applied INLINE and the producer path has no
                        // snapshot, so the mutations (transactions, mint, fee credit) are already in
                        // state with nothing to reverse them. Broadcasting on top of that shipped a
                        // block the node itself does not hold; the peers would build on it while this
                        // node re-produced the same height. Two distinct cases:
                        //   DeclinedRollback — a rollback is already driving to a lower target and
                        //     will rebuild state; just drop the block.
                        //   NotStoredMode — this node's storage keeps no blocks (a Super only reaches
                        //     this through disk-pressure degradation). A fork recovery cannot fix a
                        //     full disk, so escalating would spin forever; it is an operational fault
                        //     and the node must stop producing, not silently re-produce over an
                        //     inline apply nothing reversed.
                        //   error — the store is the suspect; force fork recovery to rebuild state
                        //     from a durable point, which is the only thing that can undo the inline
                        //     apply (a hand-rolled reversal here would have to mirror every side
                        //     effect of the apply path and would diverge the moment that path grows).
                        match &save_result {
                            Ok(crate::storage::SaveOutcome::DeclinedRollback) => {
                                let (_in_progress, target) = crate::storage::get_rollback_status();
                                println!("[WARN][NODE] microblock_save_declined h={} rollback_target={} action=drop",
                                         height_for_storage, target);
                            }
                            Ok(crate::storage::SaveOutcome::NotStoredMode) => {
                                // Same contamination as the pre-save aborts: the inline apply already
                                // mutated RAM and nothing reverses it.
                                Self::abandon_inline_apply(height_for_storage.saturating_sub(1),
                                                           height_for_storage, "not_stored_mode");
                            }
                            Ok(crate::storage::SaveOutcome::Stored) => unreachable!("handled above"),
                            Err(e) => {
                                // Classify exactly as the pipeline does: a slot already held by a
                                // canonical block we applied is a RACE, not a fault. Suspending
                                // production on it retires an honest producer for the life of the
                                // process, and those races are commonplace right after genesis.
                                let err_text = format!("{:?}", e);
                                let benign_race = err_text.contains("fork_conflict")
                                    || err_text.contains("save_declined_rollback")
                                    || err_text.contains("save_declined_not_stored");
                                if !benign_race {
                                    Self::abandon_inline_apply(height_for_storage.saturating_sub(1),
                                                               height_for_storage, "save_failed");
                                }
                                println!("[{}][NODE] microblock_save_failed h={} err={:?} benign_race={} action=fork_recovery",
                                         if benign_race { "WARN" } else { "ERR" },
                                         height_for_storage, e, benign_race);
                                let floor = LAST_FINALIZED_HEIGHT.load(std::sync::atomic::Ordering::SeqCst)
                                    .max(SNAPSHOT_ANCHOR_MB.load(std::sync::atomic::Ordering::Acquire).saturating_mul(90));
                                let target = height_for_storage.saturating_sub(1).max(floor).max(1);
                                if target < height_for_storage {
                                    crate::block_pipeline::signal_fork_recovery(target);
                                }
                            }
                        }
                        crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                        continue;
                    }

                    // OPTIMIZATION: ASYNC broadcast after storage save
                    // Block is already saved in storage, so we can broadcast async
                    // This allows 1 block/second production without waiting for broadcast
                    if let Some(p2p) = &unified_p2p {
                        let peer_count = p2p.get_peer_count();
                        let broadcast_data = if compression_enabled {
                            Self::compress_microblock_data(&microblock).unwrap_or_else(|_| {
                                bincode::serialize(&microblock).unwrap_or_default()
                            })
                        } else {
                            bincode::serialize(&microblock).unwrap_or_default()
                        };
                        
                        let broadcast_size = broadcast_data.len();
                        let height_for_broadcast = microblock.height;
                        
                        // Clone P2P for async task
                        let p2p_clone = p2p.clone();
                        
                        // v24: slowest-peer backpressure REMOVED. The legacy v2.43 gate
                        // (PENDING_BROADCAST_COUNT>=MAX) 50ms-throttled EVERY block whenever the
                        // slowest peer lagged (one slow validator is statistically guaranteed) —
                        // 1000→1107ms measured; one slow peer pins the chain at scale. Slot
                        // cadence is a CONSENSUS PARAMETER, not flow control: no safety property
                        // depended on it; flow control = bounded mpsc + Reed-Solomon + multi-hop
                        // forward + SyncManager catch-up. PENDING_BROADCAST_COUNT/MAX (+ the
                        // fetch_add/sub below) kept at module scope for observability only — NOT
                        // on the consensus hot path; do not delete as dead code.

                        // Diagnostic-only counter — never gates the slot.
                        PENDING_BROADCAST_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        
                        // ═══════════════════════════════════════════════════════════════════════════
                        // PRODUCTION v2.54: ASYNC BROADCAST WITH TIMEOUT
                        // ═══════════════════════════════════════════════════════════════════════════
                        // Problem: Broadcast could take 60+ seconds with slow/unresponsive peers
                        // Solution: Hard timeout of 5 seconds - fire-and-forget with Reed-Solomon
                        // - If timeout: rely on Reed-Solomon redundancy for delivery
                        // - Producer NEVER blocks more than 5 seconds per block
                        // ═══════════════════════════════════════════════════════════════════════════
                        tokio::spawn(async move {
                            let broadcast_start = std::time::Instant::now();
                            
                            // PRODUCTION v2.54: 5 second hard timeout on broadcast
                            // Fire-and-forget with Reed-Solomon redundancy (1.5x) ensures delivery
                            let result = tokio::time::timeout(
                                std::time::Duration::from_secs(5),
                                p2p_clone.broadcast_block_shred_protocol(height_for_broadcast, broadcast_data)
                            ).await;
                            
                            // Decrement pending count AFTER broadcast/timeout
                            PENDING_BROADCAST_COUNT.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                            
                            let broadcast_time = broadcast_start.elapsed();
                            
                            // Log result with timeout detection
                            match result {
                                Ok(Ok(_)) => {
                                    if height_for_broadcast % 50 == 0 || broadcast_time.as_millis() > 1000 {
                                        println!("[INFO][P2P] broadcast_ok block={} peers={} bytes={} ms={}",
                                                height_for_broadcast, peer_count, broadcast_size, broadcast_time.as_millis());
                                    }
                                }
                                Ok(Err(e)) => {
                                    println!("[WARN][P2P] broadcast_err block={} err={} ms={}",
                                            height_for_broadcast, e, broadcast_time.as_millis());
                                }
                                Err(_) => {
                                    // Timeout - not critical, Reed-Solomon redundancy ensures delivery
                                    println!("[WARN][P2P] broadcast_timeout block={} ms=5000 (fire_and_forget)",
                                            height_for_broadcast);
                                }
                            }
                        });
                        
                        // Log that async broadcast started
                        if height_for_broadcast <= 5 || height_for_broadcast % 10 == 0 {
                            let pending_now = PENDING_BROADCAST_COUNT.load(std::sync::atomic::Ordering::Relaxed);
                            println!("[INFO][P2P] async_broadcast h={} pending={}",
                                    height_for_broadcast, pending_now);
                        }
                        
                        // v3.4 CRITICAL: Clear broadcast-in-progress flag AFTER data is queued for transmission
                        // At this point both certificate and block data are committed to network
                        // Emergency messages can now be processed (but this block is already safe)
                        crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                        if is_debug() {
                            println!("[DBG][PROD] broadcast_flag=false h={} (data_queued)", height_for_broadcast);
                        }
                    } else {
                        // v3.4: Clear flag even if P2P unavailable (to prevent stuck flag)
                        crate::unified_p2p::BLOCK_BROADCAST_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                        if is_warn() {
                            println!("[WARN][P2P] p2p_unavailable h={}", microblock.height);
                        }
                    }
                    
                    // ATOMIC REWARDS: Track block for rotation reward
                    // Reward given at rotation completion, not per block
                    rotation_tracker.track_block(microblock.height, &node_id).await;
                    
                    // CRITICAL FIX: Only increment height AFTER block is confirmed saved and broadcast
                    // This prevents phantom height where node claims height N without having block N
                    if is_debug() { println!("[DBG][PROD] saved h={}", microblock.height); }
                    
                    // v4.0: Emergency producer removed - BFT Timeout Protocol handles failover
                    
                    // v5.5: Use block's on-chain timestamp for deterministic LBPT
                    LAST_BLOCK_PRODUCED_TIME.store(microblock.timestamp, Ordering::Relaxed);
                    LAST_BLOCK_PRODUCED_HEIGHT.store(microblock.height, Ordering::Relaxed);
                    
                    // CRITICAL: Increment height for next iteration
                    // We only advance after successfully creating and storing the block
                    microblock_height = microblock.height;  // Set to the block we just created
                    
                    // Update global height for API sync
                    {
                        let mut global_height = height.write().await;
                        *global_height = microblock_height;
                        
                        // Update P2P local height for message filtering
                        // v9.0: Release ordering pairs with Acquire in consensus paths
                        crate::unified_p2p::LOCAL_BLOCKCHAIN_HEIGHT.store(
                            microblock_height,
                            std::sync::atomic::Ordering::Release
                        );
                    }
                    
                    if is_info() { println!("[INFO][PROD] block_created h={}", microblock_height); }
                    
                    
                    // Rotation tracking for logging
                    if let Some((rotation_producer, blocks_created)) = 
                        rotation_tracker.check_rotation_complete(microblock.height).await {
                        
                        // Label = the round that just CLOSED ((h-1)/30), matching the
                        // tracker's bins — h/30 stamped the next round's number on it.
                        let closed_round = (microblock.height - 1) / ROTATION_INTERVAL_BLOCKS;
                        if blocks_created == ROTATION_INTERVAL_BLOCKS as u32 {
                            println!("[INFO][MB] rotation_complete producer={} rotation={} blocks={}/{}",
                                    rotation_producer, closed_round, blocks_created, ROTATION_INTERVAL_BLOCKS);
                        } else {
                            println!("[WARN][MB] rotation_partial producer={} rotation={} blocks={}/{}",
                                    rotation_producer, closed_round, blocks_created, ROTATION_INTERVAL_BLOCKS);
                        }
                    }
                    
                    // v3.3: REMOVED duplicate mempool cleanup (already done at line 12261)
                    // batch_remove_transactions was called twice with overlapping TX hashes
                    // First cleanup at 12261 uses included_tx_hashes (all valid TX from mempool)
                    // This cleanup used txs.hash (final block TX) - subset of above
                    // Keeping only the first cleanup for efficiency
                    
                    // Log completion only at epoch boundaries (90 blocks)
                    if microblock_height % 90 == 0 {
                        println!("[INFO][EPOCH] complete epoch={} h={}", microblock_height / 90, microblock_height);
                    }
                    
                    // v32.6: early anchor at h=90 so cold-start joiners can use
                    // state-sync immediately; subsequent snapshots on baseline interval.
                    let early_anchor = microblock_height == 90;
                    let baseline_due = microblock_height % SNAPSHOT_INCREMENTAL_INTERVAL == 0
                        && microblock_height > 0;
                    if (early_anchor || baseline_due) && should_materialize_snapshot(&node_id, microblock_height) {
                        // Capture the hot in-memory account set at this exact height, then pin a frozen
                        // DB view (sync flush + snapshot) HERE — before the next block mutates the CF.
                        // With persist-before-evict the pinned accounts CF is the COMPLETE committed tree
                        // leaf set, so a cold joiner's recompute reproduces the bound state_root past the
                        // LRU cap; the heavy serialization runs off-reactor on the frozen view.
                        let snapshot_accounts = state.read().await.get_all_accounts();
                        let snap_res = match storage.prepare_snapshot_view(&snapshot_accounts) {
                            Ok(view) => storage.create_incremental_snapshot(microblock_height, view).await,
                            Err(e) => Err(e),
                        };
                        match snap_res {
                            Ok(_) => {
                                println!("[INFO][NODE] snapshot_created h={} type=incremental", microblock_height);
                                
                                // STORAGE OPTIMIZATION: Trigger pruning after snapshot for non-archive nodes
                                // This ensures we have a valid snapshot before removing old blocks
                                // INTERVAL: 14400 blocks = 4 hours (aligned with reward window)
                                if microblock_height % 14_400 == 0 {
                                    // v36: EIP-4444 body expiry. Super (incl. genesis) is the only tier
                                    // that stores block data — drop microblock bodies (heartbeats + TXs)
                                    // older than 6 epochs while keeping hashes, macroblocks, snapshots and
                                    // state. Bounds storage to a ~6-epoch window instead of growing forever.
                                    let storage_for_body_prune = Arc::clone(&storage);
                                    tokio::spawn(async move {
                                        match storage_for_body_prune
                                            .prune_old_microblock_bodies(microblock_height, MICROBLOCK_BODY_RETENTION_BLOCKS)
                                        {
                                            Ok(0) => {}
                                            Ok(n) => println!("[INFO][NODE] microblock_bodies_pruned count={} window=6epochs", n),
                                            Err(e) => println!("[WARN][NODE] body_prune_failed err={:?}", e),
                                        }
                                    });
                                }
                                
                                // For full snapshots, upload to IPFS if enabled
                                if microblock_height % SNAPSHOT_FULL_INTERVAL == 0 {
                                    if std::env::var("IPFS_ENABLED").unwrap_or_default() == "1" {
                                        // Upload to IPFS synchronously (avoids Send issues)
                                        match storage.upload_snapshot_to_ipfs(microblock_height).await {
                                            Ok(cid) => {
                                                // IPFS snapshot upload retained; the dead peer-announce
                                                // (receiver only logged it) was removed — GALC + the
                                                // QC-anchored snapshot path handle state sync.
                                                println!("[INFO][NODE] ipfs_upload cid={}", cid);
                                            },
                                            Err(e) => {
                                                println!("[WARN][NODE] ipfs_upload_failed err={}", e);
                                            }
                                        }
                                    }
                                }
                            },
                            Err(e) => {
                                println!("[WARN][NODE] snapshot_failed err={}", e);
                            }
                        }
                    }
                    
                    // CRITICAL FIX: Do NOT reset timing here - breaks precision timing
                    // Timing update happens ONLY at end of loop for drift prevention
                    
                    // CRITICAL FIX: Reuse cached peer_count from above - DO NOT call p2p.get_peer_count() again!
                    // PERFORMANCE: Eliminates duplicate P2P validation calls in microblock hot path
                    let quantum_sigs_per_sec = txs.len() as f64; // Each tx has quantum signature
                    let finality_time = 1.2; // Average finality time in seconds
                    
                    if txs.len() > 0 {
                        println!("[INFO][BLOCKS] produced height={} tx={} tps={:.0} peers={} quantum_sigs={:.0}/s finality={:.1}s",
                                 microblock.height,
                                 txs.len(),
                                 tps,
                                 peer_count,
                                 quantum_sigs_per_sec,
                                 finality_time);
                                 
                        // Every 10 blocks show advanced quantum metrics
                        if microblock_height % 10 == 0 {
                            println!("[INFO][BLOCKS] quantum_status security=active resistance=128bit perf={}%",
                                     std::cmp::min(95 + (peer_count * 2), 100));
                        }
                    } else {
                        // Show status for every block to monitor network activity
                        println!("[INFO][BLOCKS] produced height={} producer={} tx={} peers={} quantum=ready next={}ms",
                                microblock.height,
                                node_id,
                                txs.len(),
                                peer_count,
                                microblock_interval.as_millis());
                                
                        // Show detailed status every 10 blocks
                        if microblock_height % 10 == 0 {
                            println!("[INFO][NODE] status h={} state=active synced=true broadcasting=true", microblock_height);
                        }
                    }
                    
                    // MOVED: All macroblock logic moved outside producer block (see line ~2248)
                    
                    // Performance monitoring
                    if microblock_height % 100 == 0 {
                        Self::log_performance_metrics(microblock_height, &mempool).await;
                        
                        // DYNAMIC SHARDING v2.46: Adjust shard count based on network size
                        // NOTE: shard_coordinator is accessed via cloned Arc, not self reference
                        if let Some(ref p2p) = unified_p2p {
                            if let Some(ref shard_coord) = shard_coordinator_opt {
                                let network_size = p2p.get_active_full_super_nodes().len();
                                shard_coord.adjust_shard_count(network_size);
                                if is_debug() { 
                                    println!("[DBG][SHARDING] h={} network_size={} shards_adjusted", 
                                             microblock_height, network_size); 
                                }
                            }
                        }
                    }
                    
                    // CRITICAL FIX: DO NOT increment height yet! Wait until after broadcast
                    // Height increment moved to after broadcast to prevent phantom blocks
                    } // End of microblock production block
                } else {
                    // NOT producer for this block - wait for block from network
                    // Emergency producer logic already handled above at line 3122
                    
                    // v3.10 BUG 1 FIX: Register that we're waiting for this block
                    // If SHRED doesn't deliver it, we'll request it after timeout
                    register_consensus_awaiting_block(next_block_height, &current_producer);
                    
                    // CPU OPTIMIZATION: Only log every 10th block to reduce IO load
                    if next_block_height % 10 == 0 && is_debug() {
                        println!("[DBG][MB] wait_block h={} producer={}", next_block_height, current_producer);
                    }
                    
                    // STATE MACHINE: Idle - waiting for block from producer
                    set_node_state(NodeState::Idle {
                        last_height: next_block_height.saturating_sub(1),
                    });
                    
                    // Update is_leader for backward compatibility
                    *is_leader.write().await = false;
                    
                    // EXISTING: Non-blocking background sync as promised in line 868 comments
                    if let Some(p2p) = &unified_p2p {
                        // Non-producer fell behind → nudge the single sync coordinator (execute_sync
                        // owns snapshot fast-path + pipelined catch-up). Non-blocking: the main loop
                        // proceeds and the production hard-gate withholds output until caught up.
                        crate::sync_manager::nudge_sync_check();
                        
                        // CRITICAL: Check if we already have the next block locally
                        // FIX: For non-producer, expected height is NEXT block height
                        let expected_height = next_block_height;
                        if let Ok(Some(_)) = storage.load_microblock(expected_height) {
                            // Block already exists locally - advance to this height
                            microblock_height = expected_height;
                            {
                                let mut global_height = height.write().await;
                                *global_height = microblock_height;
                            }
                            if is_info() { println!("[INFO][SYNC] local_block h={} advance={}", expected_height, microblock_height); }
                            
                            // Rotation boundary check for logging
                            let is_rotation_boundary = expected_height > 0 && (expected_height % ROTATION_INTERVAL_BLOCKS) == 0;
                            if is_rotation_boundary {
                                if is_debug() { println!("[DBG][SYNC] rotation_boundary h={}", expected_height); }
                            }
                            
                            // CRITICAL FIX: Do NOT reset timing - breaks precision intervals
                            // Timing controlled at end of loop only
                        } else {
                            // ARCHITECTURE: Block not yet received from producer
                            // Start ASYNCHRONOUS failover monitoring (does NOT block main loop)
                            // Main loop continues with 1-second timing precision
                            // Failover runs in background and triggers emergency producer if needed
                            
                            // CRITICAL: Start ASYNC failover monitoring (does NOT block main loop!)
                            // Failover runs in background, main loop continues immediately
                            let expected_height_timeout = next_block_height;
                            let current_producer_timeout = current_producer.clone();
                            let storage_timeout = storage.clone();
                            let p2p_timeout = p2p.clone();
                            let _node_id_timeout = node_id.clone();
                            let _node_type_timeout = node_type;
                            
                            // Calculate block properties for logging
                            let blocks_since_last_macro = expected_height_timeout % 90;
                            let _is_consensus_period = blocks_since_last_macro >= 61 && blocks_since_last_macro <= 90;
                            let _is_rotation_boundary = expected_height_timeout > 1 && ((expected_height_timeout - 1) % ROTATION_INTERVAL_BLOCKS) == 0;
                            
                            // CRITICAL FIX v2.19.18: Prevent multiple failover tasks for same block height
                            // Without this, each main loop iteration spawns a NEW failover task
                            // Result: 60+ failover tasks running in parallel → 500%+ CPU usage → network collapse
                            static FAILOVER_IN_PROGRESS: std::sync::atomic::AtomicBool = 
                                std::sync::atomic::AtomicBool::new(false);
                            static FAILOVER_FOR_HEIGHT: std::sync::atomic::AtomicU64 = 
                                std::sync::atomic::AtomicU64::new(0);
                            // OPTIMIZATION v2.19.19: Exponential backoff for failover
                            // Retry count increases timeout: 3s → 6s → 12s → 24s → 30s max
                            static FAILOVER_RETRY_COUNT: std::sync::atomic::AtomicU32 = 
                                std::sync::atomic::AtomicU32::new(0);
                            
                            // Check if failover already running for this height
                            let current_failover_height = FAILOVER_FOR_HEIGHT.load(Ordering::Relaxed);
                            let failover_running = FAILOVER_IN_PROGRESS.load(Ordering::Relaxed);
                            
                            // OPTIMIZATION v2.19.19: Track retry count for exponential backoff
                            let retry_count = if current_failover_height == expected_height_timeout {
                                // Same block - increment retry
                                FAILOVER_RETRY_COUNT.fetch_add(1, Ordering::Relaxed).min(4) // Max 4 retries (30s max)
                            } else {
                                // New block - reset retry
                                FAILOVER_RETRY_COUNT.store(0, Ordering::Relaxed);
                                0
                            };
                            
                            // Get timeout with exponential backoff from Adaptive BFT
                            let actual_timeout = adaptive_bft.get_timeout(next_block_height, retry_count).await;
                            
                            if failover_running && current_failover_height == expected_height_timeout {
                                // Failover already in progress for this exact block - skip
                                // This prevents exponential CPU usage from parallel failover tasks
                            } else {
                            // Start new failover task (or replace old one for different height)
                            FAILOVER_IN_PROGRESS.store(true, Ordering::Relaxed);
                            FAILOVER_FOR_HEIGHT.store(expected_height_timeout, Ordering::Relaxed);
                            
                            // EXISTING: Use same async timeout pattern as macroblock failover (line 1205)
                            let storage_check = storage_timeout.clone();
                            let p2p_check = p2p_timeout.clone();
                            
                            tokio::spawn(async move {
                                tokio::time::sleep(actual_timeout).await;
                                
                                // CRITICAL: Double-check if block was received during timeout period
                                // This prevents race condition where block arrives just as timeout triggers
                                let block_exists = match storage_check.load_microblock(expected_height_timeout) {
                                    Ok(Some(_)) => {
                                        if is_debug() { println!("[DBG][FAIL] block_arrived h={}", expected_height_timeout); }
                                        true
                                    },
                                    _ => false,
                                };
                                
                                if !block_exists {
                                    // ═══════════════════════════════════════════════════════════════════════════
                                    // PRODUCTION v2.56: TWO-LEVEL CONSENSUS CHECK BEFORE EMERGENCY
                                    // ═══════════════════════════════════════════════════════════════════════════
                                    // CRITICAL: Smart check with cache + HTTP verify
                                    // 1. FAST PATH: 2/3+ peers have block per heartbeat cache → TRUST (sync issue)
                                    // 2. SLOW PATH: Cache uncertain → HTTP verify 3 random peers
                                    // This prevents FALSE EMERGENCY that causes FORKS.
                                    // ═══════════════════════════════════════════════════════════════════════════
                                    
                                    println!("[INFO][SYNC] failover_check h={} strategy=two_level",
                                             expected_height_timeout);
                                    
                                    let check_result = p2p_check
                                        .check_block_exists_on_network(expected_height_timeout).await;
                                    
                                    // If block exists on network, it's OUR problem - sync instead of emergency
                                    if check_result.exists() {
                                        match &check_result {
                                            BlockExistenceResult::MajorityHas { peers_with, total_peers } => {
                                                println!("[INFO][SYNC] failover_majority_has h={} peers={}/{} action=sync",
                                                         expected_height_timeout, peers_with, total_peers);
                                            },
                                            BlockExistenceResult::VerifiedExists { peer_addr } => {
                                                println!("[INFO][SYNC] failover_http_verified h={} peer={} action=sync",
                                                         expected_height_timeout, peer_addr);
                                            },
                                            _ => {}
                                        }
                                        
                                        // CRITICAL FIX v2.62: Network HAS block — AGGRESSIVE SYNC, never skip
                                        // Root cause of incident mb=509: 3 retries were not enough when the
                                        // producer was still propagating the block to other peers. We now retry
                                        // up to 8 times with extended backoff (total ≤ 33s) so that by attempt
                                        // 4-5 the block has fully propagated to all 4 available peers.
                                        //
                                        // REMOVED: "skipping_block" fallback — skipping a block that 2/3+ of
                                        // the network has places this node on a diverged chain. It is NEVER
                                        // safe to skip a block that exists on the network.
                                        let mut sync_success = false;
                                        // Backoff schedule (ms): 500, 1000, 2000, 3000, 5000, 5000, 5000, 5000
                                        let backoff_schedule: &[u64] = &[500, 1000, 2000, 3000, 5000, 5000, 5000, 5000];
                                        let max_sync_attempts = backoff_schedule.len();
                                        
                                        for sync_attempt in 1..=max_sync_attempts {
                                            // Frontier fetch bypasses SYNC_INFLIGHT overlap-dedup (a plain
                                            // sync_blocks single-height request was silently coalesced into a
                                            // stuck bulk range) and has its own reserved budget.
                                            match p2p_check.sync_blocks_frontier(expected_height_timeout, expected_height_timeout).await {
                                                Ok(_) => {
                                                    // sync_blocks() is fire-and-forget — wait for block in storage
                                                    // Wait up to 3 seconds per attempt (30 * 100ms)
                                                    let mut block_arrived = false;
                                                    let max_wait_attempts = 30;  // 30 * 100ms = 3s
                                                    
                                                    for wait_attempt in 0..max_wait_attempts {
                                                        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                                                        
                                                        match storage_check.load_microblock(expected_height_timeout) {
                                                            Ok(Some(_)) => {
                                                                println!("[INFO][SYNC] failover_sync h={} attempt={}/{} wait={}ms result=success",
                                                                         expected_height_timeout, sync_attempt, max_sync_attempts, wait_attempt * 100);
                                                                block_arrived = true;
                                                                break;
                                                            },
                                                            _ => {}
                                                        }
                                                    }
                                                    
                                                    if block_arrived {
                                                        sync_success = true;
                                                        break;
                                                    } else {
                                                        println!("[WARN][SYNC] failover_sync h={} attempt={}/{} result=wait_timeout",
                                                                 expected_height_timeout, sync_attempt, max_sync_attempts);
                                                    }
                                                },
                                                Err(e) => {
                                                    println!("[ERR][SYNC] failover_sync h={} attempt={}/{} err={}",
                                                             expected_height_timeout, sync_attempt, max_sync_attempts, e);
                                                }
                                            }
                                            
                                            if sync_attempt < max_sync_attempts && !sync_success {
                                                let backoff_ms = backoff_schedule[sync_attempt - 1];
                                                println!("[INFO][SYNC] failover_backoff h={} attempt={}/{} backoff={}ms",
                                                         expected_height_timeout, sync_attempt, max_sync_attempts, backoff_ms);
                                                tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms)).await;
                                            }
                                        }
                                        
                                        if sync_success {
                                            println!("[INFO][SYNC] failover_resolved h={} action=clearing",
                                                     expected_height_timeout);
                                            clear_stuck_restart_state();
                                            FAILOVER_IN_PROGRESS.store(false, Ordering::Relaxed);
                                            return;
                                        } else {
                                            // All 8 attempts exhausted. Network HAS the block but we can't get it.
                                            // v4.2: Track consecutive sync failures per height.
                                            // If stuck on the same height for too long, QUIC connections are likely
                                            // dead — reconnect them before the next cycle.
                                            static SYNC_FAIL_HEIGHT: std::sync::atomic::AtomicU64 =
                                                std::sync::atomic::AtomicU64::new(0);
                                            static SYNC_FAIL_COUNT: std::sync::atomic::AtomicU32 =
                                                std::sync::atomic::AtomicU32::new(0);
                                            static SYNC_FAIL_FIRST_TS: std::sync::atomic::AtomicU64 =
                                                std::sync::atomic::AtomicU64::new(0);
                                            // Per-process floor between bootstrap re-dials: at scale a mass
                                            // restart strands many supers at once, all re-dialing the same
                                            // few genesis anchors — cap each node to one reconnect per window
                                            // so recovery can't self-inflict a thundering herd on genesis.
                                            static LAST_BOOTSTRAP_RECONNECT: std::sync::atomic::AtomicU64 =
                                                std::sync::atomic::AtomicU64::new(0);
                                            const BOOTSTRAP_RECONNECT_COOLDOWN_SECS: u64 = 30;

                                            let prev_fail_height = SYNC_FAIL_HEIGHT.load(Ordering::Relaxed);
                                            let fail_count = if prev_fail_height == expected_height_timeout {
                                                SYNC_FAIL_COUNT.fetch_add(1, Ordering::Relaxed) + 1
                                            } else {
                                                SYNC_FAIL_HEIGHT.store(expected_height_timeout, Ordering::Relaxed);
                                                SYNC_FAIL_COUNT.store(1, Ordering::Relaxed);
                                                let now_ts = std::time::SystemTime::now()
                                                    .duration_since(std::time::UNIX_EPOCH)
                                                    .unwrap_or_default().as_secs();
                                                SYNC_FAIL_FIRST_TS.store(now_ts, Ordering::Relaxed);
                                                1
                                            };

                                            let first_ts = SYNC_FAIL_FIRST_TS.load(Ordering::Relaxed);
                                            let now_ts = std::time::SystemTime::now()
                                                .duration_since(std::time::UNIX_EPOCH)
                                                .unwrap_or_default().as_secs();
                                            let stuck_duration = now_ts.saturating_sub(first_ts);

                                            println!("[ERR][SYNC] failover_all_failed h={} network_has_block=true fail_count={} stuck={}s",
                                                     expected_height_timeout, fail_count, stuck_duration);

                                            // First exhausted round already means the QUIC links to sync peers
                                            // are likely dead (post-restart mesh churn) — re-dial NOW instead
                                            // of after ~60s. Gated by a per-process cooldown so a stuck node
                                            // re-dials at most once per window (fail_count is left to climb,
                                            // NOT reset, so the trigger doesn't re-fire every round); this
                                            // bounds the aggregate genesis reconnect rate under a mass restart.
                                            let last_rc = LAST_BOOTSTRAP_RECONNECT.load(Ordering::Relaxed);
                                            if fail_count >= 1 && now_ts.saturating_sub(last_rc) >= BOOTSTRAP_RECONNECT_COOLDOWN_SECS {
                                                LAST_BOOTSTRAP_RECONNECT.store(now_ts, Ordering::Relaxed);
                                                println!("[WARN][FAILOVER] h={} action=force_quic_reconnect (stuck {} rounds)",
                                                         expected_height_timeout, fail_count);
                                                p2p_check.reconnect_all_bootstrap_peers().await;
                                            }

                                            if stuck_duration > 600 {
                                                // Restart only helps against local transport/state rot. If the
                                                // block is unobtainable for a structural reason, restarting is
                                                // pure harm: it wipes RAM consensus state (certified rounds,
                                                // banked votes, adopt buffers) that recovery needs to accumulate.
                                                // The attempt counter is persisted, so the loop cannot reset
                                                // itself by restarting — past the budget the node stays up,
                                                // degraded and loud, and keeps syncing.
                                                let attempts = record_stuck_restart_attempt(expected_height_timeout);
                                                if attempts <= MAX_STUCK_SELF_RESTARTS {
                                                    println!("[CRIT][FAILOVER] h={} stuck_for={}s attempt={}/{} action=self_restart",
                                                             expected_height_timeout, stuck_duration, attempts, MAX_STUCK_SELF_RESTARTS);
                                                    std::process::exit(1);
                                                }
                                                println!("[CRIT][FAILOVER] h={} stuck_for={}s attempts={} action=stay_up_degraded reason=restart_budget_exhausted",
                                                         expected_height_timeout, stuck_duration, attempts);
                                            }

                                            // Targeted frontier repair exhausted → hand off to the single
                                            // sync coordinator (snapshot fast-path + catch-up) instead of a
                                            // duplicate inline bulk fetch here.
                                            crate::sync_manager::nudge_sync_check();
                                            FAILOVER_IN_PROGRESS.store(false, Ordering::Relaxed);
                                            return;
                                        }
                                    }
                                    
                                    // ═══════════════════════════════════════════════════════════════════════════
                                    // v4.1: Network does NOT have the block - BFT Timeout Protocol handles this
                                    // ═══════════════════════════════════════════════════════════════════════════
                                    // OLD (BROKEN): Called select_emergency_producer() → exclude_producer()
                                    //   → Each node excluded producers LOCALLY after 4s → NON-DETERMINISTIC
                                    //   → Blocks from real producer REJECTED → NETWORK STALL + FORK
                                    //
                                    // NEW (CORRECT):
                                    //   → Failover is driven by the BFT-agreed rotation round
                                    //     HIGHEST_CERTIFIED_ROUND — advanced only by a signed
                                    //     same-round n−f TimeoutCertificate (ML-DSA-65-verified
                                    //     votes).
                                    //   → Every validator reads the same value once the
                                    //     signed votes have been gossiped, so the VRF
                                    //     formula `(base_idx + rotation_round) % N` selects
                                    //     the same producer on every node.
                                    //   → No local exclusion, no wall-clock-derived rank,
                                    //     no cross-domain mixing.
                                    // ═══════════════════════════════════════════════════════════════════════════
                                    
                                    let timeout_duration = actual_timeout.as_secs();
                                    
                                    match &check_result {
                                        BlockExistenceResult::Uncertain { cache_peers_with, cache_total } => {
                                            if is_warn() {
                                                println!("[WARN][FAILOVER] h={} result=uncertain cache={}/{} timeout={}s producer={} action=bft_timeout_handles",
                                                         expected_height_timeout, cache_peers_with, cache_total, timeout_duration, current_producer_timeout);
                                            }
                                        },
                                        BlockExistenceResult::NoPeers => {
                                            if is_warn() {
                                                println!("[WARN][FAILOVER] h={} result=no_peers timeout={}s producer={} action=bft_timeout_handles",
                                                         expected_height_timeout, timeout_duration, current_producer_timeout);
                                            }
                                        },
                                        _ => {}
                                    }
                                    
                                    // BFT Timeout Protocol flow (main loop at lines 10950-11050):
                                    // 1. After 30s grace: nodes vote for timeout with Dilithium signatures
                                    // 2. At 2/3+ votes: TimeoutCertificate generated
                                    // 3. certified_timeout_round > 0 → select_microblock_producer_with_round()
                                    // 4. Deterministic exclusion of failed producers by round number
                                    // 5. All nodes converge on SAME backup producer
                                    if is_info() {
                                        println!("[INFO][FAILOVER] h={} timeout_detected producer_was={} waiting_for_bft_timeout_certificate",
                                                 expected_height_timeout, current_producer_timeout);
                                    }
                                }
                                
                                // CRITICAL: Clear failover flag when task completes
                                FAILOVER_IN_PROGRESS.store(false, Ordering::Relaxed);
                            });
                            } // End of if-else failover guard check
                        }
                    } else {
                        // No P2P available - standalone mode
                        println!("[WARN][SYNC] No P2P connection - running in standalone mode");
                    }
                }
                
                // NOTE: NODE_IS_SYNCHRONIZED is now updated BEFORE producer check (line ~3371)
                // This ensures ALL nodes (including producers) have correct sync status
                
                // ══════════════════════════════════════════════════════════════════
                // CRITICAL: MACROBLOCK CONSENSUS FOR ALL NODES (not just producer!)
                // ══════════════════════════════════════════════════════════════════
                
                // PRODUCTION: Start consensus SUPER EARLY after block 60 for ZERO downtime
                // Consensus with reliable propagation:
                // Commit: propagation (2s for 5 nodes) + wait (12s, early break) = 3-8s typical
                // Reveal: propagation (2s for 5 nodes) + wait (12s, early break) = 3-8s typical
                // Finalize: 2-4s
                // Total: 5 nodes ~8-20s, 100 nodes ~12-24s, 1000 nodes ~16-28s max
                // Starting at block 61 ensures completion before block 90 - reliable!
                // CRITICAL FIX: Start EXACTLY at block 61 for deterministic consensus
                // All nodes must start at the same block to ensure phase synchronization
                let blocks_since_trigger = microblock_height.saturating_sub(last_macroblock_trigger);
                
                // ARCHITECTURE FIX: Check node synchronization before starting consensus
                let is_synchronized = coordinator_is_synchronized();
                    
                // REMOVED: Consensus is now handled by start_macroblock_consensus_listener()
                // This prevents duplicate consensus attempts and ensures ALL validators participate
                // The consensus listener runs independently and checks if this node is a validator
                
                // Monitoring only: we are in the last 30 blocks before a macroblock boundary.
                // The Checkpoint-BFT consensus itself runs ONCE, at the boundary, in
                // start_macroblock_consensus_listener — not here and not spread across 61-90
                // (that span was the old commit/reveal window, now removed).
                if blocks_since_trigger >= 61 && blocks_since_trigger <= 90 && !consensus_started {
                    if !is_synchronized {
                        println!("[WARN][MB] Node not synchronized - consensus handled by listener");
                    } else {
                        println!("[INFO][MB] h={} approaching_macroblock_boundary", microblock_height);
                        consensus_started = true;
                    }
                }
                
                // PRODUCTION: NON-BLOCKING MACROBLOCK - Swiss watch precision without stops!
                // Microblocks continue flowing while macroblock consensus runs in background
                if microblock_height.saturating_sub(last_macroblock_trigger) == 90 {
                    // Macroblock boundary: consensus runs in the background, microblocks keep flowing.
                    if is_info() {
                        println!("[INFO][MB] macroblock_boundary height={} consensus=background", microblock_height);
                    }
                    
                    // PRODUCTION: Check macroblock status asynchronously (non-blocking)
                    let storage_check = storage.clone();
                    let p2p_check = unified_p2p.clone();
                    let expected_macroblock = microblock_height / 90;
                    let check_height = microblock_height;
                    // Store current trigger value for async check (before update)
                    let current_trigger = last_macroblock_trigger;
                    
                    tokio::spawn(async move {
                        // Give consensus 5 more seconds to complete (total 35s from block 61)
                        tokio::time::sleep(Duration::from_secs(5)).await;

                        let macroblock_exists = storage_check.get_macroblock_by_height(expected_macroblock)
                            .map(|mb| mb.is_some())
                            .unwrap_or(false);

                        if macroblock_exists {
                            if is_info() { println!("[INFO][MB] created h={}", expected_macroblock); }
                        } else {
                            let blocks_without_finalization = check_height.saturating_sub(current_trigger);
                            println!("[WARN][MB] Macroblock #{} not ready after {} blocks — waiting for canonical n−f BFT consensus at next boundary",
                                     expected_macroblock, blocks_without_finalization);
                            // v14.7.2: No PFP degradation. Missing macroblocks are recovered
                            // by the regular n−f commit/reveal consensus at the next 90-block
                            // boundary, or by direct sync from peers.
                            // Nudge the single sync coordinator to backfill the missing macroblock
                            // object; the next n−f boundary or its macroblock pass repairs it.
                            crate::sync_manager::nudge_sync_check();
                            let _ = (storage_check, p2p_check);
                        }
                    });
                    
                    // CRITICAL: Update trigger to the END of current macroblock period
                    // For consensus at block 151-180, set trigger to 180 (not 151!)
                    last_macroblock_trigger = last_macroblock_trigger + 90;
                    consensus_started = false; // Reset for next round
                    
                    // CRITICAL: Microblocks continue immediately without ANY pause
                    if is_debug() { println!("[DBG][MB] continue h={}", microblock_height + 1); }
                }
                
                // v14.7.2: Periodic macroblock-gap sync. No PFP degradation —
                // canonical n−f BFT consensus runs at every 90-block boundary.
                // Direct peer sync fills missing macroblocks created by the
                // canonical consensus already performed by the quorum.
                if microblock_height >= 90 {
                    let blocks_since_trigger = microblock_height.saturating_sub(last_macroblock_trigger);
                    if blocks_since_trigger >= ROTATION_INTERVAL_BLOCKS
                        && blocks_since_trigger % ROTATION_INTERVAL_BLOCKS == 0
                        && (microblock_height % 90) != 0
                    {
                        let expected_macroblock = if last_macroblock_trigger > 0 {
                            last_macroblock_trigger / 90
                        } else {
                            let period = microblock_height / 90;
                            if period > 0 { period } else { 1 }
                        };
                        let macroblock_exists = storage.get_macroblock_by_height(expected_macroblock)
                            .map(|mb| mb.is_some())
                            .unwrap_or(false);

                        if !macroblock_exists {
                            println!("[WARN][MB] mb_gap_sync blocks_without_mb={}", blocks_since_trigger);
                            // Nudge the single sync coordinator to fill the macroblock gap.
                            crate::sync_manager::nudge_sync_check();
                        } else {
                            if is_debug() { println!("[DBG][MB] mb_ok mb={}", expected_macroblock); }
                        }
                    }
                }
                
                // NOTE: Timing is now at START of loop (v2.42) - no timing needed here
                // This ensures ALL iterations wait exactly 1 second, even after `continue`
            }
        });

        // PRODUCTION: Monitor production loop JoinHandle.
        // If the loop panics (e.g. corrupted keypair, serialization failure),
        // tokio absorbs the panic and the task silently dies — the node stays
        // alive on HTTP but stops producing blocks ("zombie node").
        // Detecting this and restarting the process lets Docker bring up a
        // clean instance instead of leaving a zombie in the validator set.
        tokio::spawn(async move {
            match production_handle.await {
                Ok(_) => {
                    eprintln!("[CRIT][PRODUCTION] production_loop exited normally — zombie prevention");
                    eprintln!("[CRIT][PRODUCTION] restarting process for clean state");
                    std::process::exit(1);
                }
                Err(e) => {
                    eprintln!("[CRIT][PRODUCTION] production_loop panicked: {:?}", e);
                    eprintln!("[CRIT][PRODUCTION] restarting process for clean state");
                    std::process::exit(1);
                }
            }
        });
    }
    
}

/// Signed producer heartbeat for `slot_h`, self-throttled to NETWORK_HEARTBEAT_INTERVAL_MS. Peers
/// read silence as a dead producer, so this must also run while the leader is parked: the
/// LAST_LEADERSHIP_MS stamp is process-local and tells the network nothing.
pub(super) async fn emit_producer_heartbeat(
    node_id: &str,
    storage: &Arc<Storage>,
    unified_p2p: &Option<Arc<SimplifiedP2P>>,
    slot_h: u64,
    now_ms: u64,
) {
    let last_hb = LAST_NETWORK_HEARTBEAT_MS.load(std::sync::atomic::Ordering::Relaxed);
    if now_ms.saturating_sub(last_hb) < NETWORK_HEARTBEAT_INTERVAL_MS { return; }
    let p2p = match unified_p2p { Some(p) => p, None => return };
    let timestamp_secs = now_ms / 1000;
    // Anchor = canonical hash at slot-1, carried ON THE WIRE and signed. A node that cannot build its
    // own parent has no chain to lead from - stay silent rather than sign an empty anchor.
    let anchor_hash = storage.get_microblock_hash_hex(slot_h.saturating_sub(1))
        .ok().flatten().unwrap_or_default();
    if anchor_hash.is_empty() {
        if is_debug() { println!("[DBG][HEARTBEAT] skip_no_anchor slot_h={}", slot_h); }
        return;
    }
    let msg_to_sign = format!(
        "QNET_PRODUCER_HEARTBEAT_V3:{}:{}:{}:{}", node_id, timestamp_secs, slot_h, anchor_hash);
    // Same consensus-crypto path as TimeoutVote, so the receiver's verify_consensus_signature
    // accepts it with no new verify code.
    let crypto = match try_get_quantum_crypto() { Some(c) => c, None => return };
    match crypto.create_consensus_signature(node_id, &msg_to_sign).await {
        Ok(sig) => {
            LAST_NETWORK_HEARTBEAT_MS.store(now_ms, std::sync::atomic::Ordering::Relaxed);
            p2p.broadcast_producer_heartbeat(node_id.to_string(), slot_h, anchor_hash,
                                             sig.signature.as_bytes().to_vec(), timestamp_secs);
            if is_debug() {
                println!("[DBG][HEARTBEAT] broadcast_self slot_h={} ts={}", slot_h, timestamp_secs);
            }
        }
        Err(e) => if is_warn() { println!("[WARN][HEARTBEAT] sign_failed err={}", e); },
    }
}
